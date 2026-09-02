/**
 * Shared owner of the uiohook-napi global keyboard hook.
 *
 * There is one native hook per process, and starting or stopping it is a global action. Two
 * features each calling uIOhook.start()/stop() for themselves means whichever stops last kills
 * the other's input silently - voice-ask disarming would take hold-to-move with it, with no error
 * anywhere. This module owns the lifecycle and hands out reference-counted leases instead.
 *
 * Loading is lazy and fully guarded: the native module failing to load must never break startup.
 * Callers check isAvailable() and fall back rather than assuming the hook is there.
 */

let uIOhook = null;
let availability = { available: false, error: 'not checked yet', version: null };
let checked = false;
let refCount = 0;
let running = false;

function checkAvailability() {
    if (checked) return availability;
    checked = true;
    try {
        const mod = require('uiohook-napi');
        uIOhook = mod.uIOhook;
        let version = null;
        try { version = require('uiohook-napi/package.json').version; } catch { /* non-fatal */ }
        availability = { available: true, error: null, version };
        console.log(`[KeyboardHook] uiohook-napi loaded OK (v${version || '?'})`);
    } catch (err) {
        availability = { available: false, error: err.message, version: null };
        console.error('[KeyboardHook] uiohook-napi failed to load:', err.message);
    }
    return availability;
}

function getAvailability() {
    return checkAvailability();
}

function isAvailable() {
    return checkAvailability().available;
}

/**
 * Take a lease on the hook, starting it if this is the first holder.
 * @param {string} owner Name used only in logs, so a leaked lease is attributable.
 * @returns {boolean} whether the hook is running after the call
 */
function acquire(owner) {
    if (!isAvailable()) {
        console.warn(`[KeyboardHook] acquire('${owner}') ignored -- hook unavailable`);
        return false;
    }
    refCount++;
    if (running) {
        console.log(`[KeyboardHook] acquired by '${owner}' (already running, ${refCount} holders)`);
        return true;
    }
    try {
        uIOhook.start();
        running = true;
        console.log(`[KeyboardHook] STARTED for '${owner}'`);
        return true;
    } catch (err) {
        refCount--;
        console.error(`[KeyboardHook] failed to start for '${owner}':`, err.message);
        return false;
    }
}

/** Release a lease, stopping the hook once nobody holds one. */
function release(owner) {
    if (refCount === 0) return;
    refCount--;
    if (refCount > 0) {
        console.log(`[KeyboardHook] released by '${owner}' (${refCount} holders remain)`);
        return;
    }
    try {
        uIOhook.stop();
    } catch (err) {
        console.error(`[KeyboardHook] error stopping after '${owner}':`, err.message);
    } finally {
        running = false;
        console.log(`[KeyboardHook] STOPPED (last holder '${owner}' released)`);
    }
}

/**
 * Subscribe to a hook event. Handlers are wrapped: an uncaught throw inside a native callback
 * surfaces as a fatal main-process dialog, so every one is contained here rather than relying on
 * each caller to remember.
 */
function on(event, handler, owner = 'unknown') {
    if (!isAvailable()) return null;
    const wrapped = (e) => {
        try { handler(e); } catch (err) {
            console.error(`[KeyboardHook] '${owner}' ${event} handler error:`, err.message);
        }
    };
    uIOhook.on(event, wrapped);
    return wrapped;
}

function off(event, wrapped) {
    if (!uIOhook || !wrapped) return;
    try { uIOhook.off(event, wrapped); } catch { /* already detached */ }
}

module.exports = { isAvailable, getAvailability, acquire, release, on, off };
