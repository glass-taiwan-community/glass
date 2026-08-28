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
 * Receive a recorded clip from the renderer. STEP 3a: log its size/duration to prove capture
 * works end to end. STEP 3b will feed it to an ephemeral STT session and send the transcript
 * (plus screenshot) to Ask.
 * @param {{chunks: string[], sampleRate: number, durationMs: number}} payload
 */
async function handleAudioClip(payload) {
    try {
        const chunks = (payload && payload.chunks) || [];
        const bytes = chunks.reduce((n, b64) => n + Math.floor((b64.length * 3) / 4), 0);
        const durationMs = payload && payload.durationMs;
        console.log(`[VoiceAsk] received audio clip: ${chunks.length} chunk(s), ~${bytes} bytes, ${durationMs}ms @ ${payload && payload.sampleRate}Hz`);
        // STEP 3b: transcribe + askService.sendMessage(transcript).
        return { success: true, bytes, chunks: chunks.length };
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
