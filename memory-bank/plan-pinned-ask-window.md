# Plan: Pinned Ask Window (two fixed slots)

**Status:** PLANNED, not started
**Created:** 2026-09-01
**Decision:** option C — **two fixed slots, not arbitrary N**
**Scope:** `src/window/windowLayoutManager.js`, `src/window/windowManager.js`,
`src/ui/ask/AskView.js`, `src/features/ask/askService.js`, `src/features/shortcuts/shortcutsService.js`

---

## 1. The need, and what is already solved

Keep an important Ask answer visible while asking further questions, so it can be referenced
mid-conversation. Confirmed by yen: the pin is a **reference**, not something looked at
continuously, and the occlusion cost is accepted.

**Persistence is already solved and is not what this is for.** Every Ask response is written to
SQLite (`askService.js:474`, `role: 'assistant'`, with `sessionId`). Nothing is lost today. What
is missing is *simultaneous visibility*, which is a much more expensive thing to build than
retrieval — so if the requirement ever softens to "let me go back and look at it", build history
paging in the existing window instead and skip everything below.

## 2. The constraint that shapes the design

Measured widths: listen 400, ask 600, pinned 600, PAD 8.

    400 + 600 + 600 + 16 = 1616px

A 14" MacBook Pro workArea is **1512px** wide. **Three windows do not fit — over by 104px.**
Two do: pinned + ask is 1208px with 304px to spare.

**An overflow policy is therefore mandatory, not optional.** This is the real work in this
feature; adding a window is not. Options, in rough order of preference:

- **Listen yields.** When a pin exists and all three want space, hide or collapse Listen. Listen
  already has its own visibility toggle, and during an Ask-heavy exchange it is the least likely
  of the three to be read.
- **Narrow the pinned window.** It is a reference, not a working surface — 400px may be enough.
  400 + 600 + 400 + 16 = 1416px, which fits a 14" screen.
- **Stack vertically** when horizontal space runs out. Interacts badly with the tall windows the
  height work just enabled; likely worst of the three.

Decide this before writing the solver, because it determines the solver's signature.

## 3. Layout work — refactor, not rewrite

`calculateFeatureWindowLayout` is ~90 lines with two hardcoded branches (`askVis && listenVis`,
else single window). It looks up windows by the literal names `ask` and `listen`.

The good news: the above/below strategy, the display/workArea resolution, and the screen-edge
clamping are **already written and already shared** by both branches. Only the horizontal
placement is duplicated.

Replace the two branches with one routine that takes an **ordered array** of visible windows and
returns positions for a row centred on the header, applying the chosen overflow policy. The
existing two branches become the n=1 and n=2 cases of it. Roughly 60 lines replacing 50.

**Note the pre-existing hazard this touches:** `determineLayoutStrategy` picks "below" whenever
the space under the header is >= 400, **without checking how tall the window will actually be**.
With the screen-derived height cap added in #31, a window can now be ~1200px on a large monitor.
Adding a third window makes this easier to hit. Fixing it belongs in this work, not after it.

## 4. Windows and views

- New pooled window `ask-pinned`, mirroring the `ask` case in `createFeatureWindows` (~15 lines).
- Reuse `AskView` in a **read-only mode**: hide the text input, no streaming, no submit. It
  already renders markdown and scrolls correctly after #31, so nothing there needs rebuilding.
- Content transfer: the pinned window shows a snapshot. Passing the message id and re-reading from
  SQLite is cleaner than shipping rendered text over IPC, and it survives a reload.

## 5. Hotkeys — and why the proposed LIFO gesture was changed

The original proposal was to reuse `Cmd+Alt+\`: first press closes the most recent window, second
press closes the one before it, as a time-ordered stack.

Two problems, and the second is the one that matters:

- With exactly two slots there is **no series** to order. There are two roles: *live* and
  *pinned*. Ordering is premature abstraction.
- **The asymmetry is dangerous.** The pinned window is the one deliberately kept; the live one is
  disposable. Closing both with the same gesture, differing only by repetition, means one extra
  keypress destroys the deliberate thing — and mid-conversation, without looking at the screen,
  there is no way to confirm which window the first press closed. Gesture cost should match
  consequence. This is the same principle applied to the `git clean` deny: a destructive path
  should require intent, not just repetition.

Chosen instead:

| Key | Action |
|---|---|
| `Cmd+Alt+\` (unchanged) | close the **live** answer only — existing muscle memory preserved |
| `Cmd+Alt+P` (new) | pin the current answer; if one is already pinned, unpin it (toggle) |

`Cmd+Alt+P` is free. The `Cmd+Alt` range currently uses Up, Down, T, Enter, L and `\`.

Using one key for both pin and unpin is symmetric and memorable, and closing something deliberately
kept always requires its own deliberate action.

## 6. Suggested order

1. Decide the §2 overflow policy. Nothing else can be designed around it.
2. Generalise the layout solver to an ordered row, with n=1 and n=2 reproducing today's behaviour
   exactly. **Verify no visual change before adding any third window** — this is the step most
   likely to regress something that currently works.
3. Fix `determineLayoutStrategy` to account for intended window height (§3).
4. Add the `ask-pinned` window and AskView read-only mode.
5. Wire pin/unpin state and the two hotkeys.
6. Test on both a laptop panel and an external monitor — the widths behave differently, and the
   overflow policy only triggers on the smaller one.

## 7. Cheaper alternatives, recorded because they were considered and rejected

- **Collapse-to-card:** pin shrinks to a 2-3 line titled card docked under the header. Keeps the
  reference without occlusion and needs no layout change at all. Rejected because yen wants the
  full answer visible for reference.
- **History paging** in the existing window: near-free, since responses are already persisted.
  Rejected because the requirement is simultaneity, not retrieval.

If the pinned window proves annoying in practice, collapse-to-card is the fallback, and it can
reuse everything from steps 4 and 5.
