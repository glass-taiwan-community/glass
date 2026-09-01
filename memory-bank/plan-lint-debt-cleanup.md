# Plan: Lint Debt Cleanup

**Status:** OPEN — tracked in [issue #30](https://github.com/glass-taiwan-community/glass/issues/30)
**Created:** 2026-09-01
**Origin:** follow-up to PR #29 (`chore/fix-eslint-toolchain`)

---

**The detail lives in [issue #30](https://github.com/glass-taiwan-community/glass/issues/30).**
This file is a pointer only, so the two cannot drift apart. It exists because a plan recorded
solely in an issue is invisible to anyone reading `memory-bank/` to reconstruct project state.

## One-line summary

PR #29 made `npm run lint` actually run for the first time in this fork. It deliberately did not
clean up what lint found: 157 pre-existing warnings, baselined to `warn` and pinned as a ceiling
via `--max-warnings`. Issue #30 tracks working that number down.

## The parts most likely to be forgotten

- **The `--max-warnings` ceilings do not tighten by themselves.** After removing warnings, lower
  the numbers in `package.json` (157) and `pickleglass_web/package.json` (12) by hand, or the
  progress is not locked in.
- **Two of the 157 are behaviour bugs, not cleanup**, and should go on their own `bugfix/` branch:
  dead `lastScreenshot` state in `askService.js:36` that nothing reads, and a fully silent
  `catch` at `askService.js:454` in the token-streaming loop.
- **`baselined` does not mean `accepted`.** Every correctness rule is still `error`; the 157 are
  a line between inherited debt and new code, not a verdict that they are fine.
