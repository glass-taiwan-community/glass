/**
 * Horizontal placement for the feature windows that sit beside the header.
 *
 * Pure and dependency-free on purpose - it holds the only part of the layout that had to be
 * generalised to support a third window, so it is the only part that can regress the placement
 * that already works. Keeping it out of windowLayoutManager.js (which requires electron at load
 * time) is what makes it directly testable against the behaviour it replaces.
 *
 * The windows form a single row. One of them is the ANCHOR and is centred on the header; the
 * others are laid out beside it in the given order. Anchoring rather than centring the whole row
 * is deliberate: it is what the previous two-window code did, so the active Ask window does not
 * move sideways when a second or third window appears next to it.
 */

/**
 * @param {Object} opts
 * @param {Array<{name: string, width: number}>} opts.windows Left-to-right order.
 * @param {string} opts.anchor Name of the window centred on the header.
 * @param {number} opts.headerCenterXRel Header centre, relative to the work area.
 * @param {number} opts.screenWidth Work area width.
 * @param {number} opts.pad Gap between windows, and the minimum screen margin.
 * @returns {Object<string, number>} xRel for each window, relative to the work area.
 */
function solveRow({ windows, anchor, headerCenterXRel, screenWidth, pad }) {
    if (!Array.isArray(windows) || windows.length === 0) return {};

    let anchorIndex = windows.findIndex(w => w.name === anchor);
    // An absent anchor should not produce a silently mispositioned row; fall back to the first
    // window so the result is still a well-formed layout.
    if (anchorIndex === -1) anchorIndex = 0;

    const x = new Array(windows.length);
    x[anchorIndex] = headerCenterXRel - windows[anchorIndex].width / 2;

    for (let i = anchorIndex - 1; i >= 0; i--) {
        x[i] = x[i + 1] - windows[i].width - pad;
    }
    for (let i = anchorIndex + 1; i < windows.length; i++) {
        x[i] = x[i - 1] + windows[i - 1].width + pad;
    }

    const rowLeft = x[0];
    const rowRight = x[windows.length - 1] + windows[windows.length - 1].width;
    const rowWidth = rowRight - rowLeft;
    const available = screenWidth - pad * 2;

    let shift = 0;
    if (rowWidth <= available) {
        // Fits: move it the smallest distance that brings it fully on screen. For one and two
        // windows this reproduces the previous clamping exactly.
        if (rowRight + shift > screenWidth - pad) shift = screenWidth - pad - rowRight;
        if (rowLeft + shift < pad) shift = pad - rowLeft;
    } else {
        // Does not fit. The previous code had two different and contradictory rules for this
        // case - the single-window branch kept the left edge, the two-window branch kept the
        // right - and neither guaranteed the window the user is actually using stayed visible.
        // Keep the ANCHOR fully on screen instead, as close to the header as it can be.
        const anchorX = x[anchorIndex];
        const anchorW = windows[anchorIndex].width;
        let anchorTarget = anchorX;
        if (anchorTarget + anchorW > screenWidth - pad) anchorTarget = screenWidth - pad - anchorW;
        if (anchorTarget < pad) anchorTarget = pad;
        shift = anchorTarget - anchorX;
    }

    const out = {};
    windows.forEach((w, i) => { out[w.name] = x[i] + shift; });
    return out;
}

module.exports = { solveRow };
