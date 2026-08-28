// Voice-to-Ask: hold a global key, speak, and the transcript (plus the usual screenshot)
// goes to Ask -- without any Glass window taking focus.
//
// STEP 1 (this file, current scope): load the native global-keyboard hook and report
// whether it is available. Merely require()-ing uiohook-napi loads its .node binary, so a
// successful require confirms the native module loaded with the correct Electron ABI --
// which is exactly what has to be verified in a packaged build. The global hook itself is
// NOT started here; that is step 2 (hold detection), gated behind a default-off setting.

let availability = { available: false, error: 'not checked yet', version: null };

/**
 * Attempt to load the native hook and record the result. Fully guarded: a failure here must
 * never crash app startup -- the feature simply reports unavailable and everything else runs.
 * @returns {{available: boolean, error: string|null, version: string|null}}
 */
function checkAvailability() {
    try {
        // Requiring the package loads the native addon; if the binary is missing or built
        // for the wrong ABI, this throws and we capture it rather than letting it propagate.
        require('uiohook-napi');
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

function initialize() {
    checkAvailability();
}

module.exports = { initialize, checkAvailability, getAvailability };
