# Plan: Lint Debt Cleanup

**Status:** OPEN — not started
**Created:** 2026-09-01
**Origin:** follow-up to PR #29 (`chore/fix-eslint-toolchain`)
**Note:** this was meant to be a GitHub issue, but Issues are disabled on
`glass-taiwan-community/glass`. Move it to a real issue if Issues are ever enabled.

---

Follow-up to PR #29, which repaired the ESLint toolchain. That PR made lint *run*; it deliberately did not clean up what lint found. This issue tracks that cleanup.

## What the 157 actually is

157 warnings across 50 of 89 files, in ~27,000 lines. All of it pre-dates #29 — it was inherited from upstream and was invisible because the lint command had never once executed.

| Count | Rule | Meaning |
|---|---|---|
| 136 | `no-unused-vars` | declared or assigned, never used |
| 11 | `no-case-declarations` | declaration inside a `switch` case, leaking into sibling cases |
| 5 | `no-empty` | empty block |
| 5 | `no-useless-catch` | `catch` that rethrows unchanged — same as not catching |

The 136 unused split into 81 "declared but never used" (mostly IPC handler parameters like `event` — genuinely harmless) and 55 "assigned but never read".

For scale: ~1 warning per 170 lines. That is low for a project that has never run lint; neglected codebases usually sit at 1 per 20–30.

## What "baselined to 157" does and does not mean

It does **not** mean the 157 are fine. It means they existed before the tooling was repaired, and leaving them as errors would keep lint permanently red — and a permanently red lint is one nobody reads, which is exactly the state #29 set out to fix.

So 157 is a **line**, not a verdict:

- **Below the line** (the existing 157) — visible, does not block.
- **Above the line** (new code) — every correctness rule is still `error`. `no-undef` was never demoted, which is why it caught the `dmgPath` bug fixed in #29.

#29 also pins the counts as ceilings (`--max-warnings 157` / `--max-warnings 12`), so the debt can only shrink. **The ceilings do not tighten automatically** — as warnings are removed, lower the numbers in `package.json` and `pickleglass_web/package.json` by hand to lock the progress in.

## Two of these are not cosmetic

Found while categorising the 157. Both are behaviour problems that happen to trip lint rules, and both deserve fixing regardless of any cleanup effort.

### 1. `lastScreenshot` is dead state — `src/features/ask/askService.js:36`

```
36:  let lastScreenshot = null;
59:  lastScreenshot = { ... }   // written
88:  lastScreenshot = { ... }   // written
```

Nothing in `src/` ever reads it. Every capture stores a base64 image into a variable no one consumes, and it stays resident. Almost certainly a leftover from a refactor. Either wire it up or delete it — but decide deliberately, because "assigned but never read" can also mean a feature was left half-connected.

### 2. A silently swallowed error — `src/features/ask/askService.js:454`

```js
} catch (error) {
}
```

Inside the token-streaming loop. Any failure there is discarded with no log at all. If Ask streaming breaks, you get a truncated response and a completely clean console.

This is the same failure shape as the broken lint itself: **the absence of a signal is indistinguishable from success.** Worth fixing on that basis alone.

## Suggested order

1. The two behaviour problems above — separate `bugfix/` branch, not bundled with cleanup.
2. The 81 unused function parameters — mechanical, near zero risk. Either delete them or configure `argsIgnorePattern` for the deliberate ones.
3. The 55 assigned-but-never-read — needs judgement per case; some may be more dead state like #1.
4. `no-case-declarations`, `no-empty`, `no-useless-catch` — small counts, quick wins.
5. Lower the `--max-warnings` ceilings after each pass, and flip each rule back to `error` in `eslint.config.mjs` once it reaches zero.

Do **not** bundle this into #29. That PR is "make the tooling honest"; folding 136 variable changes into it would make it unreviewable.
