# Activity UX — Tier 0/1/2 Implementation Plan

Status: Tier 0/1/2 implemented 2026-09-07. Verified by typecheck, production build,
repository SQL exercised against an in-memory SQLite with the real schema, and unit
tests over the timeline merge. Verified end to end against the running desktop
app on a copy of the real 182-session database, driven with `agent-browser` over CDP.
Context: the web GUI's Activity section is opened often, but reviewing a past
session is harder than it should be. This plan is the agreed scope.

## Premises this plan rests on (challenge these if they stop holding)

1. **The user opens Activity often.** Confirmed by the user 2026-09-07. If that
   ever stops being true, everything below drops in priority behind "push the
   summary at the moment the session ends", because the best review UX is not
   needing to review.
2. **Titles are unreliable.** Sessions are created with `Session @ <time>` and the
   web falls back to `Conversation - <date>`, so **search and card previews must
   work off content, not titles.** A title-only search would look implemented and
   still fail every real query.
3. **Listen and Ask sessions have different review needs** but share one card
   layout today. This plan narrows the gap with content-derived metadata rather
   than by splitting the section in two — splitting is a bigger bet and can wait
   for evidence.

## Tier 0 — repair what is broken

Search is not "missing", it is **broken in a way that lies to the user**:
`SearchPopup` renders, calls the API, silently catches the failure and shows
"no results" — so the user concludes the thing is not there and gives up.

Two independent defects:

- `backend_node/routes/conversations.js` declares `GET /:session_id` **before**
  `GET /search`. Express matches in declaration order, so `/search` resolves as
  a session id and returns **404**, never reaching the handler.
- The handler itself is a `501` stub.

**T0.1** Move the `/search` route above `/:session_id`.
**T0.2** Implement search over **content**: `sessions.title`,
`transcripts.text`, `ai_messages.content`. Return the matching session plus a
snippet and a per-session match count so results are identifiable.
**T0.3** Show the snippet in `SearchPopup`, and surface errors instead of
swallowing them into an empty state.

Deliberate tradeoff: `LIKE '%q%'` over FTS5. Single-user local data; FTS5 would
add a virtual table, a backfill migration and index upkeep for a corpus this
small. Revisit if a session corpus ever gets large enough to feel slow.

## Tier 1 — information architecture

**T1.1 — Merged timeline in the details page.** Today the page renders
`Listen: Transcript` and `Ask: Q&A` as two sequential sections. In reality the
question was asked *during* the meeting, about what had just been said; the
current structure severs that causal link. Both records carry timestamps
(`transcripts.start_at`, `ai_messages.sent_at`), so the merge is available from
existing data with no schema change.

Reconciling with T2.1 (below): a merged timeline in a long meeting is still a
wall of text. Resolution — **collapse runs of transcript between Ask moments**
into an expandable "N lines of conversation" row. Ask moments stay prominent;
the transcript stays reachable as evidence. A session with no Asks collapses to
summary + one collapsed transcript run.

**T1.2 — Cards carry content, not just metadata.** Cards show title, a full
timestamp and a type badge. Scanning the list is a "which one was it?" task and
none of that answers it. Add the summary `tldr` line and scannable counts
(duration, number of asks). Requires enriching `getAllByUserId()` — the
`Session` type has no summary fields today.

**T1.3 — Group by relative date** (Today / Yesterday / This week / Earlier)
instead of one flat list. People recall "a few days ago", not "September 3".

## Tier 2 — reading and follow-through

**T2.1 — Transcript is evidence, not the reading surface.** Covered by the
collapsing behaviour in T1.1.

**T2.2 — Action items need an exit.** `action_json` renders as a read-only list:
the system does the hard work of extracting commitments and then strands them.
Make them checkable, persist the state, and add a cross-session view of
everything still open.

Persistence design: a new `action_done_json` column on `summaries` holding the
**text** of completed items, not their indices. Indices shift because the live
summary is regenerated every 5 turns; text is stable. Schema sync in
`sqliteClient` adds missing columns automatically, so no migration script.

## Files in scope

Backend: `src/features/common/config/schema.js`,
`src/features/common/repositories/session/{sqlite,firebase}.repository.js` +
`index.js`, `src/features/listen/summary/repositories/*`, `src/index.js`
(IPC), `pickleglass_web/backend_node/routes/conversations.js`.

Frontend: `pickleglass_web/utils/api.ts`,
`pickleglass_web/app/activity/page.tsx`,
`pickleglass_web/app/activity/details/page.tsx`,
`pickleglass_web/components/SearchPopup.tsx`, plus a cross-session actions view.

## Out of scope (Tier 3, deferred)

Screenshot lightbox, Markdown export, search-result highlight-and-jump,
splitting Listen and Ask into separate sections.


## What shipped, and what each piece was verified by

| Item | Verification |
|---|---|
| T0.1 route order | Route moved above `/:session_id`; unexercised end-to-end |
| T0.2 content search | SQL run against real schema: uid isolation, LIKE-wildcard escaping (`50%` matches literally), snippet source priority |
| T0.3 snippets, scope note, error state | Typecheck + build |
| T1.1 merged timeline | Unit-tested: interleaving, unsorted input, run folding, ask-only, listen-only, empty, same-timestamp tie, caller input not mutated |
| T1.2 enriched cards | SQL verified: tldr/summary_is_final/counts, session with no summary handled |
| T1.3 date grouping | Typecheck + build |
| T2.1 collapsed transcript runs | Folded into T1.1 |
| T2.2 action items | SQL verified: text-keyed write, `changes: 0` for a session with no summary row (no phantom insert) |

## Discovered while implementing (not in the original analysis)

1. **`/search` was unreachable, not merely unimplemented.** `GET /:session_id` was declared
   first, so the request resolved as a session id and 404'd. The `501` stub below it was
   dead code — implementing it without reordering would have changed nothing.
2. **Search results linked to a route that does not exist.** `SearchPopup` pushed
   `/activity/{id}`; the detail page lives at `/activity/details?sessionId=`. A third
   defect in the same feature, hidden behind the first two.
3. **The original spec for search omitted summaries.** Caught by a test expecting a hit on
   "proposal", which lived only in `final_action_json`. Summaries are the *most* searchable
   text a session owns — the tldr and action items are the phrases people actually recall,
   while transcripts are verbatim speech that rarely matches how a meeting is remembered.
   Search now covers title, summary (live and final), transcripts and Ask messages.
4. **`parseList` was duplicated** across the detail and actions pages, and `buildTimeline`
   was unreachable for testing inside a page component. Both now live in
   `pickleglass_web/utils/sessionContent.ts`.

## Next step

Run the desktop app and exercise this against real sessions. Everything above is verified
at the layer below the IPC bridge; none of it has been through `ipcRequest` yet.


## Corrected after running against real data

The first round of verification used a fixture database loaded through `better-sqlite3`.
That result **could not be reproduced** and is withdrawn: the module's binary in
`node_modules` is arm64 while this machine is Intel, so it cannot load here at all. Every
SQL claim below was re-established with the `sqlite3` CLI against a copy of the real
182-session database (12,404 transcripts, 765 Ask messages, 130 summaries).

What real data proved that fixtures had not:

- **Summary-only hits are real.** Session `da42d4a2` matches "latency" with 0 transcript
  hits and 0 message hits — only in the summary. Searching summaries is not a nicety.
- **LIKE escaping matters.** An unescaped `%` matches all 182 sessions; escaped, it matches
  the 13 that literally contain a percent sign.

### The live `action_json` column is not action items

`summaryService.parseFinalResponseText` documents this, and the data confirms it
absolutely: **all 130 live `action_json` rows contain the assist chips**
("✨ What should I say next?", "💬 Suggest follow-up questions"); **zero
`final_action_json` rows do.** The live column holds live-assist affordances, not
commitments.

This was a **pre-existing bug in the session detail page**, not something this work
introduced: whenever a session had no final summary it rendered those chips under an
"Action Items:" heading. On this database that is 88 of 130 sessions showing
"✨ What should I say next?" as an action item. The new cross-session page would have
inherited and multiplied it.

Fixed by restricting action items to the final artifact everywhere, and by stripping the
"None identified" placeholder the model emits when it finds no commitments:

| Stage | Sessions |
|---|---|
| Rows with any `action_json` | 130 |
| Final summaries only | 42 |
| After dropping "None identified" | **10 with genuinely actionable items** |

## Getting Glass to run here (three obstacles, all resolved)

1. **`ELECTRON_RUN_AS_NODE=1` is inherited from the environment** (the parent process is
   itself Electron). The launched app boots as plain Node and dies on the first
   `app.getPath()`. Any launcher must delete that variable — the repo's existing specs
   spread `...process.env` and would hit this too.
2. **A single-instance lock.** A Glass started on 2026-09-03 holds it, so a second launch
   quits with exit 0. Workaround that does not disturb it: pass
   `--user-data-dir=<dir>` pointed at a copy of the database.
3. **`node_modules/better-sqlite3/build/Release/better_sqlite3.node` was arm64** on an
   Intel Mac, so the database could not open — the app was genuinely unstartable, which
   was confirmed when the long-running instance exited and could not be restarted. Fixed
   with `npm run postinstall` (`electron-builder install-app-deps`), which rebuilt
   better-sqlite3, keytar and uiohook-napi for x64.

The temporary Playwright driver was removed rather than committed: Playwright inherits the
shell's x64 node and launches Electron translated, which reintroduces obstacle 3. Driving
the web GUI with `agent-browser` over CDP avoids that entirely and is the recommended way
to exercise this app here.

## End-to-end results (real app, real data)

- **Search** — `GET /api/conversations/search?q=latency` → HTTP 200, `scope: content`,
  7 results with snippets sourced from questions, summaries and transcripts. In the UI the
  popup renders each snippet with its origin ("in a question" / "in the summary" /
  "in the transcript").
- **Timeline** — the 345-line / 20-ask session renders **74 interleaved entries**:
  `RUN37 → ASK → AI → RUN7 → ASK → … → RUN18 → ASK → RUN19 → ASK`, with 20 collapsed
  transcript runs and short runs (<4 lines) left expanded. Previously this was one wall of
  345 lines followed by a separate block of 20 Q&As.
- **Action items** — the page shows 10 sessions / 28 open items, all genuinely actionable.
  Ticking one persists (`{"changes":1}`), survives a reload, and the header count drops
  28 → 27. A malformed body is rejected with HTTP 400.
- **Schema migration** — launching against a clean copy of the real database logged
  `[DB Sync] Added column action_done_json to summaries`; all 130 summaries and 182
  sessions intact.

## Fixed after seeing it on screen: nonsense durations

The first screenshot showed a card reading **"66h 0m"**. `ended_at - started_at` is not a
duration: `ended_at` is stamped when the app closes the session, sometimes days later.

Deriving the span from the records themselves was still wrong, because
`getOrCreateActive()` reuses one session across a working period — one session held a
27-minute meeting plus a question asked 18 hours earlier, so first-to-last record reported
18 hours. The rule that survived contact with the data: **transcripts define the span when
they exist; Ask-only sessions fall back to their message span.**

| Session | Before | After |
|---|---|---|
| 345 lines, 20 asks | 66h 0m | 49 min |
| 0 lines, 1 ask | 11h 47m | under a minute |
| 325 lines, 1 ask | 18h 4m | 28 min |
| 705 lines | 43 min | 44 min (already right) |
