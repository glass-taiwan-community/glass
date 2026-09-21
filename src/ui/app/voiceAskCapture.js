// Renderer-side mic capture for Voice-to-Ask, bounded by a hold of the global key.
//
// The main process detects the key hold (uiohook) and sends voiceAsk:recordingStateChanged.
// This module records the microphone only while a hold is in progress, in the same PCM16 /
// 24 kHz / base64 format the STT sessions consume, and submits the buffered clip back to main
// on release. Main transcribes it and sends the transcript to Ask.
//
// The mic is kept WARM while the feature is armed (enabled): the stream, AudioContext, and
// processor are created once and left running, and a hold merely gates buffering on. Opening
// the mic per-hold cost ~1s of getUserMedia/AudioContext startup, which truncated the start of
// every utterance and wrecked transcription accuracy ("bubble sort" -> "Pop on Sort"). Listen
// mode is accurate for the same reason: it opens the mic once and streams continuously.
//
// Capture lives in the header renderer because the header window is always present and never
// takes focus, so recording never disturbs whatever app the user is working in.

const VOICE_SAMPLE_RATE = 24000;
const VOICE_BUFFER_SIZE = 4096;

function convertFloat32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16Array;
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

class VoiceAskCapture {
    constructor(onStateChange) {
        this.onStateChange = onStateChange || (() => {});
        this._stream = null;
        this._context = null;
        this._processor = null;
        this._source = null;
        this._armed = false;      // mic stream is open and warm
        this._recording = false;  // a hold is in progress; buffer samples
        this._chunks = [];
        this._startedAt = 0;
        this._peak = 0;           // loudest sample seen during the current hold
        this._arming = null;      // in-flight arm(), so concurrent callers coalesce
    }

    /**
     * Whether the underlying mic track is still usable.
     *
     * A track can end on its own -- sleep/wake, the audio device changing, the OS reclaiming the
     * mic -- while the AudioContext stays `running`. The processor then keeps firing and buffers
     * silence, so a hold produces a correctly-sized clip of zeros and STT returns an empty
     * transcript. Nothing errors, and the feature is dead until the app restarts. This is the
     * check that makes that state recoverable.
     * @returns {boolean}
     */
    _isStreamLive() {
        if (!this._stream) return false;
        const tracks = this._stream.getAudioTracks();
        return tracks.length > 0 && tracks.every(t => t.readyState === 'live');
    }

    /**
     * Open the mic and keep it warm. autoGainControl matches Listen's constraints so levels
     * are normalized. The processor runs continuously but only buffers while _recording.
     */
    async arm() {
        if (this._armed && this._isStreamLive()) return;
        // Coalesce concurrent callers. getUserMedia is async and three paths call arm(): the
        // enable toggle, the start of a hold, and dead-track recovery. Without this guard two
        // calls interleave, each builds its own AudioContext + ScriptProcessor, and only the
        // last set of references is reachable -- the earlier processors stay connected and keep
        // appending to the same _chunks buffer. That produced clips ~17x larger than the hold
        // duration and Deepgram 408 SLOW_UPLOAD.
        if (this._arming) return this._arming;

        this._arming = this._armInternal().finally(() => { this._arming = null; });
        return this._arming;
    }

    /** The actual arming work. Never call directly -- go through arm() for the guard. */
    async _armInternal() {
        // Unconditional: any previous graph must be dismantled before a new one is built,
        // whether or not `_armed` still claims it is healthy.
        this._teardown();
        this._armed = false;
        try {
            this._stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: VOICE_SAMPLE_RATE,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
                video: false,
            });
            this._context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
            this._source = this._context.createMediaStreamSource(this._stream);
            this._processor = this._context.createScriptProcessor(VOICE_BUFFER_SIZE, 1, 1);
            this._processor.onaudioprocess = (e) => {
                if (!this._recording) return;
                const input = e.inputBuffer.getChannelData(0);
                for (let i = 0; i < input.length; i++) {
                    const a = Math.abs(input[i]);
                    if (a > this._peak) this._peak = a;
                }
                const pcm16 = convertFloat32ToInt16(input);
                this._chunks.push(arrayBufferToBase64(pcm16.buffer));
            };
            this._source.connect(this._processor);
            this._processor.connect(this._context.destination);
            // Only flag the dead track; startHold() re-arms lazily under the guard above.
            // Re-arming from inside the handler raced with the other arm() callers, which is
            // what created the orphaned-processor bug. The cost of recovering lazily is roughly
            // one second of leading audio on the first hold after a track dies -- far better
            // than the silent capture it replaces.
            for (const track of this._stream.getAudioTracks()) {
                track.addEventListener('ended', () => {
                    console.warn('[VoiceAskCapture] mic track ended -- will re-arm on next hold');
                    this._armed = false;
                });
            }
            this._armed = true;
        } catch (err) {
            console.error('[VoiceAskCapture] failed to arm mic:', err);
            this._teardown();
        }
    }

    /** Close the mic and release it (turns off the OS mic indicator). */
    disarm() {
        this._recording = false;
        this._teardown();
        this._armed = false;
    }

    /** A hold began: start buffering. Arms the mic first if it somehow was not warm. */
    async startHold() {
        // Backstop for the 'ended' listener: also verify liveness at the moment of use.
        if (!this._armed || !this._isStreamLive()) await this.arm();
        this._chunks = [];
        this._peak = 0;
        this._startedAt = Date.now();
        this._recording = true;
        this.onStateChange(true);
    }

    /** A hold ended: stop buffering and submit the clip. The mic stays warm. */
    async stopHold() {
        if (!this._recording) return;
        this._recording = false;
        this.onStateChange(false);
        const durationMs = Date.now() - this._startedAt;
        const chunks = this._chunks;
        this._chunks = [];
        // Report the ACTUAL context rate; the browser may run at hardware rate.
        const sampleRate = this._context ? this._context.sampleRate : VOICE_SAMPLE_RATE;
        // A silent clip and a failed transcription look identical downstream ("transcript empty"),
        // so say which one happened here, where the audio actually is.
        // Guard against the orphaned-processor class of bug returning: more audio than the hold
        // could physically have produced means something else is writing into the same buffer.
        const expectedBytes = Math.round((durationMs / 1000) * sampleRate * 2);
        const actualBytes = chunks.reduce((n, c) => n + Math.floor(c.length * 3 / 4), 0);
        if (expectedBytes > 0 && actualBytes > expectedBytes * 1.5) {
            console.error(`[VoiceAskCapture] clip is ${(actualBytes / expectedBytes).toFixed(1)}x `
                + `larger than the ${durationMs}ms hold allows (${actualBytes} vs ~${expectedBytes} bytes) `
                + `-- duplicate capture graph; re-arming`);
            this._armed = false;
        }
        if (this._peak < 0.001) {
            console.warn(`[VoiceAskCapture] clip is silent (peak ${this._peak.toFixed(5)}) -- `
                + `mic produced no signal; track state: ${this._isStreamLive() ? 'live' : 'ENDED'}`);
        }
        try {
            if (window.api && window.api.voiceAsk && chunks.length > 0) {
                await window.api.voiceAsk.submitAudioClip({ chunks, sampleRate, durationMs });
            }
        } catch (err) {
            console.error('[VoiceAskCapture] failed to submit clip:', err);
        }
    }

    _teardown() {
        // Detach the callback FIRST: a disconnected ScriptProcessor can still have a queued
        // callback, and an orphan that keeps appending to _chunks is the failure this prevents.
        try { if (this._processor) this._processor.onaudioprocess = null; } catch {}
        try { if (this._processor) this._processor.disconnect(); } catch {}
        try { if (this._source) this._source.disconnect(); } catch {}
        try { if (this._context) this._context.close(); } catch {}
        try { if (this._stream) this._stream.getTracks().forEach(t => t.stop()); } catch {}
        this._processor = this._source = this._context = this._stream = null;
    }
}

export { VoiceAskCapture };
