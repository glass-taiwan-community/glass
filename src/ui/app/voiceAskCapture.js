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
    }

    /**
     * Open the mic and keep it warm. autoGainControl matches Listen's constraints so levels
     * are normalized. The processor runs continuously but only buffers while _recording.
     */
    async arm() {
        if (this._armed) return;
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
                const pcm16 = convertFloat32ToInt16(input);
                this._chunks.push(arrayBufferToBase64(pcm16.buffer));
            };
            this._source.connect(this._processor);
            this._processor.connect(this._context.destination);
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
        if (!this._armed) await this.arm();
        this._chunks = [];
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
        try {
            if (window.api && window.api.voiceAsk && chunks.length > 0) {
                await window.api.voiceAsk.submitAudioClip({ chunks, sampleRate, durationMs });
            }
        } catch (err) {
            console.error('[VoiceAskCapture] failed to submit clip:', err);
        }
    }

    _teardown() {
        try { if (this._processor) this._processor.disconnect(); } catch {}
        try { if (this._source) this._source.disconnect(); } catch {}
        try { if (this._context) this._context.close(); } catch {}
        try { if (this._stream) this._stream.getTracks().forEach(t => t.stop()); } catch {}
        this._processor = this._source = this._context = this._stream = null;
    }
}

export { VoiceAskCapture };
