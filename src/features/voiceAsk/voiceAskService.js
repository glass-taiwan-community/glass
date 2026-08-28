// Voice-to-Ask: hold a global key, speak, and the transcript (plus the usual screenshot)
// goes to Ask -- without any Glass window taking focus.
//
// STEP 1 (done): load the native global-keyboard hook and report availability.
// STEP 2 (this file): start/stop the global hook behind a default-off setting, and detect a
//   hold of the trigger key (down -> up) with a minimum-hold guard and a hard-cap backstop.
//   The hold currently just logs and notifies the renderer of recording state; actual mic
//   capture + transcription + send-to-Ask are step 3.
//
// The whole feature is opt-in (voice_ask_enabled, default off) because it installs a global
// OS keyboard hook. Every uiohook callback body is wrapped in try/catch: an uncaught throw in
// a hook callback surfaces as a fatal "JavaScript error in the main process" dialog.

// Right Command. A bare right-side modifier: needs no Fn (that is Wispr's), and held alone it
// triggers no Glass shortcut, since those are all modifier+letter combos.
const HOLD_KEYCODE = 3676; // UiohookKey.MetaRight
const HOLD_KEY_LABEL = 'Right-⌘';

const MIN_HOLD_MS = 250;      // shorter than this is treated as an accidental tap, ignored
const HARD_CAP_MS = 20000;    // backstop: a stuck-down key can never record forever

let availability = { available: false, error: 'not checked yet', version: null };

let uIOhook = null;           // the hook object, once loaded
let hookRunning = false;      // whether the global hook is currently started
let isRecording = false;      // whether a hold is currently in progress
let holdStart = 0;
let capTimer = null;
let keydownHandler = null;
let keyupHandler = null;

/**
 * Attempt to load the native hook and record the result. Fully guarded: a failure here must
 * never crash startup -- the feature simply reports unavailable and everything else runs.
 * @returns {{available: boolean, error: string|null, version: string|null}}
 */
function checkAvailability() {
    try {
        const mod = require('uiohook-napi');
        uIOhook = mod.uIOhook;
        let version = null;
        try { version = require('uiohook-napi/package.json').version; } catch { /* non-fatal */ }
        availability = { available: true, error: null, version };
        console.log(`[VoiceAsk] uiohook-napi loaded OK (v${version || '?'}) -- voice input AVAILABLE`);
    } catch (err) {
        availability = { available: false, error: err.message, version: null };
        console.error(`[VoiceAsk] uiohook-napi failed to load -- voice input UNAVAILABLE:`, err.message);
    }
    return availability;
}

/** @returns {{available: boolean, error: string|null, version: string|null}} last known status */
function getAvailability() {
    return availability;
}

/** Notify the header renderer of a recording-state change so it can show an indicator. */
function notifyRenderer(recording) {
    try {
        const { windowPool } = require('../../window/windowManager');
        const header = windowPool && windowPool.get('header');
        if (header && !header.isDestroyed()) {
            header.webContents.send('voiceAsk:recordingStateChanged', { recording });
        }
    } catch (err) {
        console.error('[VoiceAsk] notifyRenderer failed:', err.message);
    }
}

function beginHold() {
    if (isRecording) return;
    isRecording = true;
    holdStart = Date.now();
    console.log(`[VoiceAsk] ${HOLD_KEY_LABEL} down -> recording START`);
    notifyRenderer(true);
    // Backstop: force-end a hold that never releases (stuck key, dropped key-up event).
    capTimer = setTimeout(() => {
        console.warn(`[VoiceAsk] hard cap ${HARD_CAP_MS}ms reached -- force-ending hold`);
        endHold();
    }, HARD_CAP_MS);
}

function endHold() {
    if (!isRecording) return;
    isRecording = false;
    if (capTimer) { clearTimeout(capTimer); capTimer = null; }
    const heldMs = Date.now() - holdStart;
    notifyRenderer(false);
    if (heldMs < MIN_HOLD_MS) {
        console.log(`[VoiceAsk] ${HOLD_KEY_LABEL} released after ${heldMs}ms -- too short, ignored`);
        return;
    }
    console.log(`[VoiceAsk] ${HOLD_KEY_LABEL} up -> recording STOP (held ${heldMs}ms)`);
    // STEP 3 will capture the mic clip for this window, transcribe it, and send the
    // transcript + screenshot to Ask. For now the hold is only detected and logged.
}

/**
 * Start the global hook. No-op if unavailable or already running. Safe to call repeatedly.
 * @returns {boolean} whether the hook is running after the call
 */
function start() {
    if (!availability.available || !uIOhook) {
        console.warn('[VoiceAsk] start() ignored -- hook unavailable');
        return false;
    }
    if (hookRunning) return true;
    try {
        // Guard every callback body: an uncaught throw here becomes a fatal main-process dialog.
        keydownHandler = (e) => { try { if (e.keycode === HOLD_KEYCODE) beginHold(); } catch (err) { console.error('[VoiceAsk] keydown handler error:', err.message); } };
        keyupHandler   = (e) => { try { if (e.keycode === HOLD_KEYCODE) endHold();   } catch (err) { console.error('[VoiceAsk] keyup handler error:', err.message); } };
        uIOhook.on('keydown', keydownHandler);
        uIOhook.on('keyup', keyupHandler);
        uIOhook.start();
        hookRunning = true;
        console.log(`[VoiceAsk] global hook STARTED -- hold ${HOLD_KEY_LABEL} to record`);
        return true;
    } catch (err) {
        console.error('[VoiceAsk] failed to start hook:', err.message);
        hookRunning = false;
        return false;
    }
}

/** Stop the global hook and detach handlers. No-op if not running. */
function stop() {
    if (!hookRunning || !uIOhook) return;
    try {
        if (keydownHandler) uIOhook.off('keydown', keydownHandler);
        if (keyupHandler) uIOhook.off('keyup', keyupHandler);
        uIOhook.stop();
    } catch (err) {
        console.error('[VoiceAsk] error stopping hook:', err.message);
    } finally {
        keydownHandler = keyupHandler = null;
        if (capTimer) { clearTimeout(capTimer); capTimer = null; }
        isRecording = false;
        hookRunning = false;
        console.log('[VoiceAsk] global hook STOPPED');
    }
}

/**
 * Transcribe raw linear16 PCM via Deepgram's prerecorded endpoint. A true one-shot: POST the
 * audio, get the final transcript back -- no streaming session to manage. The real sample rate
 * (reported by the renderer) is passed through, so audio the browser captured at hardware rate
 * is interpreted correctly instead of being mislabeled 24 kHz.
 * @returns {Promise<string>} the transcript, or '' if empty
 */
async function transcribeDeepgram(rawBuffer, sampleRate, apiKey, model, language) {
    const params = new URLSearchParams({
        model: model || 'nova-3',
        encoding: 'linear16',
        sample_rate: String(Math.round(sampleRate || 24000)),
        channels: '1',
        smart_format: 'true',
    });
    if (language) params.set('language', language);
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
        method: 'POST',
        headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/octet-stream' },
        body: rawBuffer,
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Deepgram ${res.status}: ${detail.slice(0, 200)}`);
    }
    const json = await res.json();
    return json?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
}

/**
 * Receive a recorded clip from the renderer, transcribe it (one-shot), and send the transcript
 * plus the usual screenshot to Ask -- without any Glass window taking focus.
 * @param {{chunks: string[], sampleRate: number, durationMs: number}} payload
 */
async function handleAudioClip(payload) {
    try {
        const chunks = (payload && payload.chunks) || [];
        const sampleRate = (payload && payload.sampleRate) || 24000;
        if (chunks.length === 0) return { success: false, error: 'empty clip' };

        const rawBuffer = Buffer.concat(chunks.map(b64 => Buffer.from(b64, 'base64')));
        console.log(`[VoiceAsk] transcribing ${rawBuffer.length} bytes @ ${Math.round(sampleRate)}Hz...`);

        const modelStateService = require('../common/services/modelStateService');
        const modelInfo = await modelStateService.getCurrentModelInfo('stt');
        if (!modelInfo || !modelInfo.apiKey) {
            console.warn('[VoiceAsk] no STT provider configured -- cannot transcribe');
            return { success: false, error: 'no STT provider configured' };
        }

        // Resolve the neutral language ('en'|'zh') to the provider's expected code.
        let language;
        try {
            const settingsService = require('../settings/settingsService');
            const { resolveSttLanguage } = require('../common/ai/sttLanguages');
            language = resolveSttLanguage(await settingsService.getSttLanguageSetting(), modelInfo.provider) || undefined;
        } catch { language = undefined; }

        let transcript = '';
        if (modelInfo.provider === 'deepgram') {
            transcript = await transcribeDeepgram(rawBuffer, sampleRate, modelInfo.apiKey, modelInfo.model, language);
        } else {
            // Other providers are wired as streaming sessions; a one-shot batch path for each
            // is a follow-up. Fail loudly rather than silently doing nothing.
            console.warn(`[VoiceAsk] provider '${modelInfo.provider}' not yet supported for voice-ask (use Deepgram STT)`);
            return { success: false, error: `provider ${modelInfo.provider} not supported for voice input yet` };
        }

        if (!transcript) {
            console.log('[VoiceAsk] transcript empty -- nothing said, not sending to Ask');
            return { success: true, transcript: '' };
        }

        console.log(`[VoiceAsk] transcript: "${transcript}" -- sending to Ask`);
        const askService = require('../ask/askService');
        // Pass the live Listen transcript as context, same as the typed and summary-click Ask
        // paths do. Without it, a question like "summarize what we're talking about" reaches
        // the model with no idea what "we" refers to. Empty when no Listen session is active.
        let conversationHistory = [];
        try {
            conversationHistory = require('../listen/listenService').getConversationHistory() || [];
        } catch (e) {
            console.error('[VoiceAsk] could not load Listen context:', e.message);
        }
        console.log(`[VoiceAsk] attaching ${conversationHistory.length} conversation turn(s) as context`);
        await askService.sendMessage(transcript, conversationHistory);
        return { success: true, transcript };
    } catch (err) {
        console.error('[VoiceAsk] handleAudioClip error:', err.message);
        return { success: false, error: err.message };
    }
}

/** @returns {boolean} whether the global hook is currently running */
function isRunning() {
    return hookRunning;
}

/** Probe availability. Does not start the hook -- the caller starts it if the setting is on. */
function initialize() {
    checkAvailability();
}

module.exports = { initialize, checkAvailability, getAvailability, start, stop, isRunning, handleAudioClip };
