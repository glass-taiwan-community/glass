/**
 * Hold-to-move for the window movement shortcuts.
 *
 * globalShortcut only reports key PRESSES - Electron gives no release event - so "keep moving
 * until I let go" cannot be built on it alone. The press still comes from globalShortcut, because
 * that is what consumes the accelerator so Cmd+Arrow does not also reach the focused application.
 * The release comes from the shared uiohook keyboard hook, which sees keyup but does not consume
 * anything. Neither mechanism can do this on its own.
 *
 * Degrades to the previous single-step behaviour when the hook is unavailable, rather than
 * failing: a tap must keep working on a machine with no accessibility permission.
 */
const internalBridge = require('../../bridge/internalBridge');
const keyboardHook = require('../common/services/keyboardHookService');

/** uiohook keycodes. */
const KEY = {
    ArrowUp: 57416,
    ArrowDown: 57424,
    ArrowLeft: 57419,
    ArrowRight: 57421,
    Meta: 3675,
    MetaRight: 3676,
    Ctrl: 29,
    CtrlRight: 3613,
};

const ARROW_FOR_DIRECTION = {
    up: KEY.ArrowUp,
    down: KEY.ArrowDown,
    left: KEY.ArrowLeft,
    right: KEY.ArrowRight,
};

const DELTA_FOR_DIRECTION = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
};

/** Wait before continuous movement begins, so a tap stays a single step. */
const REPEAT_DELAY_MS = 220;
const TICK_MS = 16;
const PX_PER_TICK = 6;

/**
 * Backstop. If a keyup is ever missed - the hook is stopped mid-hold, focus changes, the OS
 * swallows it - a continuous mover would otherwise slide the window to the edge and stay there
 * with no way to stop it. Nothing legitimate needs a five-second hold.
 */
const MAX_HOLD_MS = 5000;

let leaseHeld = false;
let keyupHandler = null;
let active = null;        // { direction, delayTimer, tickTimer, capTimer }

function init() {
    if (leaseHeld || !keyboardHook.isAvailable()) {
        if (!keyboardHook.isAvailable()) {
            console.warn('[HoldMove] keyboard hook unavailable -- movement stays single-step per press');
        }
        return;
    }
    // The lease is taken once and kept. Acquiring on the first keypress instead would start the
    // hook AFTER the key is already down, and a quick tap's release could land before the hook
    // was listening - leaving the window moving until the backstop fired.
    keyupHandler = keyboardHook.on('keyup', onKeyUp, 'HoldMove');
    leaseHeld = keyboardHook.acquire('HoldMove');
    if (!leaseHeld && keyupHandler) {
        keyboardHook.off('keyup', keyupHandler);
        keyupHandler = null;
    }
}

function onKeyUp(e) {
    if (!active) return;
    // Releasing either the arrow or the modifier ends the hold. Watching only the arrow would
    // leave it running if the user lifts Cmd first, which is a natural way to stop.
    const stops = [
        ARROW_FOR_DIRECTION[active.direction],
        KEY.Meta, KEY.MetaRight, KEY.Ctrl, KEY.CtrlRight,
    ];
    if (stops.includes(e.keycode)) stop();
}

function stop() {
    if (!active) return;
    clearTimeout(active.delayTimer);
    clearInterval(active.tickTimer);
    clearTimeout(active.capTimer);
    active = null;
}

/**
 * A movement accelerator fired. Always performs the immediate step, then begins continuous
 * movement if the key is still down after the delay.
 * @param {'up'|'down'|'left'|'right'} direction
 */
function begin(direction) {
    // A repeat of the same direction while already holding is the OS key-repeat, not a new press.
    if (active && active.direction === direction) return;
    stop();

    internalBridge.emit('window:moveStep', { direction });

    if (!leaseHeld) return;   // no release detection available; the single step above is all of it

    const [dx, dy] = DELTA_FOR_DIRECTION[direction] || [0, 0];
    const state = { direction, delayTimer: null, tickTimer: null, capTimer: null };
    active = state;

    state.delayTimer = setTimeout(() => {
        if (active !== state) return;
        state.tickTimer = setInterval(() => {
            const windowManager = require('../../window/windowManager');
            windowManager.nudgeWindow(dx * PX_PER_TICK, dy * PX_PER_TICK);
        }, TICK_MS);
    }, REPEAT_DELAY_MS);

    state.capTimer = setTimeout(() => {
        if (active === state) {
            console.warn(`[HoldMove] hold on '${direction}' exceeded ${MAX_HOLD_MS}ms -- stopping; a keyup was probably missed`);
            stop();
        }
    }, MAX_HOLD_MS);
}

function shutdown() {
    stop();
    if (keyupHandler) keyboardHook.off('keyup', keyupHandler);
    keyupHandler = null;
    if (leaseHeld) keyboardHook.release('HoldMove');
    leaseHeld = false;
}

module.exports = { init, begin, stop, shutdown };
