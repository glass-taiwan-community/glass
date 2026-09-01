/**
 * Equivalence tests for the generalised row solver.
 *
 * The point of these is narrow and specific: prove that generalising the layout to N windows did
 * not move the one- and two-window layouts that already work. The old algorithm is reproduced
 * verbatim below as the reference, and the new solver must agree with it everywhere the row fits
 * on screen.
 *
 * Run: node tests/rowLayout.test.js
 */
const { solveRow } = require('../src/window/rowLayout.js');

const PAD = 8;
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log('  ok  ' + name)) : (fail++, console.log('FAIL  ' + name)); };

/** The previous two-window placement, copied from windowLayoutManager before the refactor. */
function oldTwoWindow(headerCenterXRel, screenWidth, askW, listenW) {
    let askXRel = headerCenterXRel - (askW / 2);
    let listenXRel = askXRel - listenW - PAD;
    if (listenXRel < PAD) {
        listenXRel = PAD;
        askXRel = listenXRel + listenW + PAD;
    }
    if (askXRel + askW > screenWidth - PAD) {
        askXRel = screenWidth - PAD - askW;
        listenXRel = askXRel - listenW - PAD;
    }
    return { ask: askXRel, listen: listenXRel };
}

/** The previous single-window placement, copied verbatim. */
function oldSingle(headerCenterXRel, screenWidth, w) {
    let xRel = headerCenterXRel - w / 2;
    return Math.max(PAD, Math.min(screenWidth - w - PAD, xRel));
}

// Real display widths: 14" MBP, 16" MBP, 1440p and 1080p externals.
const SCREENS = [1512, 1728, 2560, 1920, 1280];

// --- 1. Single window matches the old behaviour everywhere it fits -------------------------
{
    let mismatch = 0, checked = 0;
    for (const screenWidth of SCREENS) {
        for (const w of [400, 600]) {
            if (w > screenWidth - PAD * 2) continue;
            for (let hx = 0; hx <= screenWidth; hx += 7) {
                const expected = oldSingle(hx, screenWidth, w);
                const actual = solveRow({
                    windows: [{ name: 'ask', width: w }],
                    anchor: 'ask', headerCenterXRel: hx, screenWidth, pad: PAD,
                }).ask;
                checked++;
                if (Math.abs(actual - expected) > 1e-9) mismatch++;
            }
        }
    }
    ok(`single window identical to old across ${checked} positions`, mismatch === 0);
}

// --- 2. Two windows match the old behaviour everywhere the row fits ------------------------
{
    let mismatch = 0, checked = 0;
    for (const screenWidth of SCREENS) {
        const askW = 600, listenW = 400;
        if (askW + listenW + PAD > screenWidth - PAD * 2) continue;
        for (let hx = 0; hx <= screenWidth; hx += 7) {
            const expected = oldTwoWindow(hx, screenWidth, askW, listenW);
            const actual = solveRow({
                windows: [{ name: 'listen', width: listenW }, { name: 'ask', width: askW }],
                anchor: 'ask', headerCenterXRel: hx, screenWidth, pad: PAD,
            });
            checked++;
            if (Math.abs(actual.ask - expected.ask) > 1e-9 || Math.abs(actual.listen - expected.listen) > 1e-9) mismatch++;
        }
    }
    ok(`two windows identical to old across ${checked} positions`, mismatch === 0);
}

// --- 3. Ask stays anchored on the header when there is room -------------------------------
{
    const r = solveRow({
        windows: [{ name: 'listen', width: 400 }, { name: 'ask', width: 600 }, { name: 'pinned', width: 400 }],
        anchor: 'ask', headerCenterXRel: 756, screenWidth: 1512, pad: PAD,
    });
    ok('ask centred on header with three windows', Math.abs(r.ask + 300 - 756) < 1e-9);
    ok('listen sits left of ask', Math.abs(r.listen + 400 + PAD - r.ask) < 1e-9);
    ok('pinned sits right of ask', Math.abs(r.ask + 600 + PAD - r.pinned) < 1e-9);
}

// --- 4. The chosen widths fit a 14" laptop, which is why no overflow policy is needed -------
{
    const widths = { listen: 400, ask: 600, pinned: 400 };
    for (const screenWidth of [1512, 1728, 2560]) {
        for (let hx = 0; hx <= screenWidth; hx += 13) {
            const r = solveRow({
                windows: [{ name: 'listen', width: widths.listen }, { name: 'ask', width: widths.ask }, { name: 'pinned', width: widths.pinned }],
                anchor: 'ask', headerCenterXRel: hx, screenWidth, pad: PAD,
            });
            const left = r.listen;
            const right = r.pinned + widths.pinned;
            if (left < PAD - 1e-9 || right > screenWidth - PAD + 1e-9) {
                ok(`three windows stay on screen (${screenWidth}px, header ${hx})`, false);
                break;
            }
            const gap1 = r.ask - (r.listen + widths.listen);
            const gap2 = r.pinned - (r.ask + widths.ask);
            if (Math.abs(gap1 - PAD) > 1e-9 || Math.abs(gap2 - PAD) > 1e-9) {
                ok(`gaps stay exactly PAD (${screenWidth}px, header ${hx})`, false);
                break;
            }
        }
    }
    ok('three windows always on screen with exact gaps at 1512/1728/2560', true);
}

// --- 5. Degenerate case: row wider than the screen keeps the ANCHOR visible ----------------
{
    // 400+600+400+16 = 1416 against a 1280 panel: cannot fit.
    const r = solveRow({
        windows: [{ name: 'listen', width: 400 }, { name: 'ask', width: 600 }, { name: 'pinned', width: 400 }],
        anchor: 'ask', headerCenterXRel: 640, screenWidth: 1280, pad: PAD,
    });
    ok('anchor fully visible when the row cannot fit', r.ask >= PAD - 1e-9 && r.ask + 600 <= 1280 - PAD + 1e-9);
    ok('outer windows are allowed off-screen instead', r.listen < PAD);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
