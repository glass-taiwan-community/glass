# Decision: Keep the repository public

**Status:** DECIDED — 2026-09-01. Staying public.
**Decision owner:** yen
**Revisit if:** personal or private material needs to live in this repo, or CI moves off macOS runners

---

## The decision

Keep `glass-taiwan-community/glass` public. **The deciding factor was GitHub Actions minutes, not
anything about the code.**

Going private was considered because upstream is effectively dead — `pickle-com/glass` last pushed
**2025-10-26**, roughly ten months ago, with 110 open issues unattended. It is not formally
archived, but nothing is happening there.

## Why GitHub blocks it in the first place

A fork shares a **repository network** with its parent. GitHub does not allow mixed visibility
inside a network, so a fork's visibility is locked regardless of whether upstream is alive:

> For security reasons, you cannot change the visibility of a fork.

## The cost that settled it

This organisation is on the **free** plan, which is the part that matters:

| | public repo | private repo |
|---|---|---|
| Actions minutes | **unlimited** | **2,000 / month** |

The CI job runs on `macos-latest`, and **macOS runners bill at a 10x multiplier**. The job takes
about 7 minutes:

    7 min x 10 = 70 billed minutes per run
    2,000 / 70 = roughly 28 runs per month

On 2026-09-01 alone the repo used more than five runs. Going private would turn CI into a scarce
resource — immediately after the work in PR #29 made every PR actually lint. Not worth it.

**Mitigation if this is ever revisited:** moving the build job to `ubuntu-latest` drops the
multiplier to 1x, roughly 285 runs per month. But it changes *what is being tested* —
`npm run build` would package a Linux app rather than a macOS one. That trade needs its own
decision, it is not a free swap.

## The two routes, if this is ever reversed

**Route A — ask GitHub Support to detach the fork.** Support can remove a repo from its fork
network; visibility becomes changeable afterwards. Preserves the URL, all issues and PRs, commit
history, stars and branches. Must be filed by the account owner at support.github.com. **This repo
has 0 forks of its own**, which is the condition that usually blocks a detach, so it should go
through cleanly. This is the recommended route.

**Route B — mirror into a fresh private repo.**

    git clone --bare git@github.com:glass-taiwan-community/glass.git
    cd glass.git && git push --mirror git@github.com:<owner>/<repo>.git

Keeps every commit, branch and tag. **Loses all issues, all PRs, stars, and the URL.**

### Do this first if Route B is ever taken

`memory-bank/plan-lint-debt-cleanup.md` was deliberately reduced to a **pointer to issue #30** so
the two could not drift apart, and `plan-ask-window-height.md` §5 defers its root cause to issue
#32. A mirror push destroys both issues and leaves those files pointing at nothing, taking the
content with them. **Restore the full content into the memory-bank files before mirroring.**

## GPL-3.0 is not an obstacle

The repo is GPL-3.0. Its obligations trigger on **distribution**, not on possession. Holding a
private fork is fine. Only if packaged builds are later given to other people must source be
offered — to those recipients, not to the public.

## Standing consequence — the repo is public, so treat it as public

Verified on 2026-09-01: **no personal or career material exists on any pushed branch.** Every
remote ref was searched for career-ops, interview-prep, story-bank and employer names, and came
back clean.

That holds only because **`feature/interview-pace-monitor` has never been pushed and must not be.**
It carries `memory-bank/plan-interview-pace-monitor.md`, which contains yen's employment history,
interview strategy, story titles, and a ChatGPT prompt built from the resume. That branch is
local-only by design, not by accident.

Re-run the check before any bulk push:

    for ref in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin | grep -v HEAD); do
      git grep -lIiE "career-ops|interview-prep|story-bank|<employer names>" "$ref" -- 2>/dev/null
    done
