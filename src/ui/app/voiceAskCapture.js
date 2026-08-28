// Renderer-side mic capture for Voice-to-Ask, bounded by a hold of the global key.
//
// The main process detects the key hold (uiohook) and sends voiceAsk:recordingStateChanged.
// This module records the microphone only while a hold is in progress, in the same PCM16 /
// 24 kHz / base64 format the STT sessions consume, and submits the buffered clip back to main
// on release. Main transcribes it (step 3b) and sends the transcript to Ask.
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
        this._chunks = [];
        this._startedAt = 0;
        this._active = false;
    }

    async start() {
        if (this._active) return;
        this._active = true;
        this._chunks = [];
        this._startedAt = Date.now();
        this.onStateChange(true);
        try {
            this._stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: VOICE_SAMPLE_RATE,
                    echoCancellation: true,
                    noiseSuppression: true,
                },
                video: false,
            });
            this._context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
            this._source = this._context.createMediaStreamSource(this._stream);
            this._processor = this._context.createScriptProcessor(VOICE_BUFFER_SIZE, 1, 1);
            this._processor.onaudioprocess = (e) => {
                if (!this._active) return;
                const input = e.inputBuffer.getChannelData(0);
                const pcm16 = convertFloat32ToInt16(input);
                this._chunks.push(arrayBufferToBase64(pcm16.buffer));
            };
            this._source.connect(this._processor);
            this._processor.connect(this._context.destination);
        } catch (err) {
            console.error('[VoiceAskCapture] failed to start mic capture:', err);
            this._active = false;
            this.onStateChange(false);
            this._teardown();
        }
    }

    async stop() {
        if (!this._active) return;
        this._active = false;
        this.onStateChange(false);
        const durationMs = Date.now() - this._startedAt;
        const chunks = this._chunks;
        this._chunks = [];
        this._teardown();
        try {
            if (window.api && window.api.voiceAsk && chunks.length > 0) {
                await window.api.voiceAsk.submitAudioClip({
                    chunks,
                    sampleRate: VOICE_SAMPLE_RATE,
                    durationMs,
                });
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
