# Plan: Ask Window Height and Scrolling

**Status:** DONE — shipped on `bugfix/ask-response-area-height-cap`
**Created:** 2026-09-01
**Scope:** `src/ui/ask/AskView.js`
**Related:** the deferred root-cause fix in `src/ui/app/content.html`

---

## 1. The problem as reported

Long Ask answers were too short to read. The obvious suspect was
`Math.min(700, idealHeight)` in `adjustWindowHeight()`.

## 2. What was actually wrong — three separate defects, stacked

Worth reading before touching window sizing anywhere in this app. The first two were found by
reading the code; the third was only found after two failed fixes.

### 2.1 The answer area was capped independently of the window

`.response-container` had `max-height: 400px` while `adjustWindowHeight()` sized the window up to
700px. A long answer produced a 700px window showing 400px of text with the rest empty. **Raising
the window cap alone would have changed nothing** — the text area could never exceed 400
regardless of window height. This is the defect the original request was really about.

### 2.2 The window height measurement fed back into itself

`.response-container` was `flex: 1` inside a `height: 100%` column, so it stretched to whatever
the window already was. `adjustWindowHeight()` then read `responseEl.scrollHeight` — that
stretched height — and sized the window from it. One element was being asked to do two
incompatible jobs at once: **fill the window so it can scroll**, and **report its natural height
so the window can be sized from it**. Those cannot both be true.

Consequence: the window could only ever grow. A one-line answer would have held it at maximum and
it would never shrink between questions.

Fixed by splitting the jobs: `.response-container` owns scrolling, and a new inner
`.response-content` — sized purely by content — is what gets measured, plus the container's
vertical padding. Loading and empty states are wrapped in it too, so the measurement target
always exists rather than silently falling back to the old path.

### 2.3 THE ROOT CAUSE — the percentage height chain from the viewport is broken

`content.html` sets `html, body { min-height: 100% }` — **min-height, not height** — and the
`pickle-glass-app` element has no height at all. A percentage height against an auto-height
parent resolves to `auto`, so every `height: 100%` below them resolves to auto too:
PickleGlassApp's `:host`, `ask-view`, and `.ask-container`.

With no definite height on `.ask-container`, `flex: 1` on `.response-container` has nothing to
fill. It grows to the full answer, never overflows, never shows a scrollbar, and the excess is
clipped by `body { overflow: hidden }` with no way to reach it.

**This is why `max-height: 400px` existed.** It was not a design decision about fitting laptop and
external screens — it was **load-bearing**, the only thing giving the answer area a definite
height. Removing it took the support away.

## 3. Why the first two fixes failed

Both were correct diagnoses of real defects, aimed at the wrong layer. 2.1 and 2.2 are genuine
and are fixed, but neither was what stopped the scrollbar appearing. The lesson is that
`max-height: 400px` looked cosmetic and was structural — **before removing a constraint, find out
what it is holding up.**

## 4. What shipped

| Change | Why |
|---|---|
| removed `max-height: 400px` | it capped the answer area far below the window |
| inner `.response-content`, measured instead of the container | breaks the measurement feedback loop |
| `.ask-container` uses `height: 100vh` not `100%` | vh resolves against the window, bypassing the broken chain |
| height cap from `window.screen.availHeight * 0.85`, floor 700 | a laptop panel and an external monitor no longer share one hardcoded number |
| scrollbar thumb restored under liquid glass | the track stays transparent for the glass look, but the thumb is the only signal that the answer continues |

Reading area for a long answer went from 400px to roughly 700px on a 14" laptop and roughly
1100px on a 1440p monitor.

## 5. Deferred — and why

**The height chain in `content.html` is still broken.** `100vh` works around it rather than
fixing it. The proper fix is `html, body { height: 100% }` plus a height on `pickle-glass-app`,
but that file is shared by the **listen, settings and shortcut-editor** windows, so it changes the
height model for all four. That blast radius was not worth taking to fix one scrollbar, mid-debug,
having already broken scrolling once in the same session.

Anything else in this app that relies on `height: 100%` inside these windows is silently resolving
to auto right now. Tracked as its own issue.

**Second known risk, untriggered so far:** `windowLayoutManager.determineLayoutStrategy()` picks
"below" whenever the space under the header is >= 400, **without checking how tall the window will
actually be**. The old 700 cap mostly hid this. With a screen-derived cap reaching ~1200 on a large
monitor, a header dragged low on the screen could push the bottom of the Ask window off-screen.
Not observed yet; fix by feeding the intended height into the strategy decision.

## 6. Process note

The `npm start` script rebuilds the renderer bundle, so a change is only picked up by a **full
restart** — reloading the window is not enough. During this work a fix was briefly believed
ineffective until the bundle write time and the Electron process start time were compared
directly. When a renderer change appears to have no effect, check that first:

    stat -f "%Sm" -t "%H:%M:%S" public/build/content.js
    ps -o lstart= -p <electron pid>

`GLASS_DEBUG_LAYOUT=1 npm start` logs the heights the main process actually receives, and is the
next diagnostic to reach for rather than reasoning about CSS.
