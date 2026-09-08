# Activity UX — remaining action items

Everything in Tier 0/1/2 of [activity-ux-plan.md](activity-ux-plan.md) is implemented and
verified end to end. This file is what is left: the deferred Tier 3 work, plus the judgment
calls made along the way that a future session may want to revisit with better evidence.

Nothing here is blocking. Ordered so the highest-value item is first within each group.

---

## A. Deferred Tier 3 features

- [ ] **Screenshot lightbox.** Ask screenshots render as a `max-h-48` thumbnail whose only
      affordance is opening the raw image in a new tab
      (`pickleglass_web/app/activity/details/page.tsx`, the `<img>` inside the timeline). A
      modal that keeps the reader on the page is the obvious upgrade.
- [x] **Markdown rendering for Ask answers.** Done 2026-09-07. `components/Markdown.tsx` uses
      `marked` + `DOMPurify` — the same two libraries the desktop Ask view already loads, so both
      surfaces render identically; both ship with zero transitive dependencies. Sanitising is
      verified, not assumed: a probe containing `<script>`, `<iframe>`, `onerror=` and a
      `javascript:` href rendered with all four stripped and no handler firing, while bold and
      headings survived.
- [ ] **Search-result highlight and jump.** Clicking a result opens the session at the top. It
      should scroll to the matching line and highlight it — the snippet already proves the
      match exists, so the position is known.
- [ ] **Markdown export of a session.** Summary + timeline as one file.
- [ ] **Separate Listen and Ask review surfaces.** Deliberately not done: the two session types
      have different review needs but share one card layout. The content-derived metadata
      (tldr, counts, duration) narrowed the gap cheaply. Splitting is a bigger bet — wait for
      evidence that the shared layout is actually failing.

## B. Decisions worth revisiting with more evidence

- [ ] **`LIKE` instead of FTS5 for search.** Correct today: 182 sessions / 12,404 transcript
      lines scan instantly. Revisit when search feels slow, not before — FTS5 costs a virtual
      table, a backfill migration and index upkeep.
      *Trigger: a query that takes more than ~200 ms.*
- [ ] **Search is capped at 30 results with no pagination.** No "more results" affordance
      either, so a user cannot tell a truncated list from a complete one.
      *Trigger: a real query that legitimately matches more than 30 sessions.*
- [ ] **Action items hidden entirely for live-only summaries.** Live `action_json` holds
      live-assist affordances ("✨ What should I say next?"), never commitments, so it no longer
      renders under an "Action Items" heading. The open question is whether those suggested
      questions are worth showing in review under an honest label of their own, rather than
      being dropped.
- [ ] **The `/^\s*none identified\b/i` placeholder filter.** Matched 31 of 42 finished sessions.
      Deliberately narrow — start-anchored, one exact phrase — but it is still a heuristic over
      model output. If the summary prompt changes wording, the filter silently stops working
      and the page fills with placeholders again.
      *Better fix: have the summariser emit an empty array instead of a prose placeholder.*
- [x] **Session titles could still be better.** The derivation takes a summary's opening
      sentence, so several interview sessions read "這是一場技術面試…". Distinguishable by the names
      inside them, but a purpose-written one-line title from the summariser would be sharper.
      *Not blocking; revisit if the list starts feeling samey.*
- [ ] **Duration excludes Ask messages.** `content_span` is the transcript span, falling back to
      the message span only for Ask-only sessions. Consequence: Ask-only sessions almost always
      read "under a minute", which is true but carries no information.
- [ ] **Firebase search covers titles only.** Titles are encrypted and transcripts live in
      per-session sub-collections, so content search would mean downloading and decrypting
      everything per keystroke. The UI says so out loud (`scope: 'title'`). The alternative is
      disabling search in cloud mode rather than offering a weaker one.

## C. Root causes upstream of this work

- [x] **Sessions are not meetings.** Done 2026-09-07. `getOrCreateActive()` now ends a session
      that has gone an hour without new content instead of reusing it. The hour came from the
      data, not taste: 16 sessions contain a gap over 20 minutes but only 11 contain one over 60,
      and that count is unchanged at 120 — gaps under an hour are breaks inside one sitting.
      Idleness is measured from the last transcript or message, never from `updated_at`, which
      `touch()` bumps on every lookup and which would therefore never look idle.
- [x] **Sessions have no real titles.** Done 2026-09-07. Derived in SQL (`DERIVED_TITLE`) rather
      than backfilled, with a fallback chain final tldr → live tldr → first transcript line →
      first question. **Deriving was the right call precisely because a backfill from summaries
      would have reached fewer than a quarter of sessions** (see the next item). 172 of 182 get a
      real title; the 10 with no content at all keep the timestamp.
- [x] **Only 42 of 182 sessions ever produced a final summary — explained, not a bug.** The
      automatic final-summary feature did not exist when those sessions were recorded. Nothing to
      fix. It does mean the 140 older sessions will permanently show a partial summary and no
      action items, and it is why titles are derived rather than generated from summaries.
      *Open, optional: backfill final summaries for old sessions from their transcripts. Costs
      one LLM call each and would retroactively give them action items.*

## D. Testing

- [ ] **No automated coverage was left behind.** A Playwright driver was written and removed:
      Playwright's `_electron.launch` inherits the shell's x64 Node and starts Electron
      translated, which breaks native module loading on this machine. The working approach is
      `agent-browser` over CDP — recipe recorded in the `drive-glass-with-agent-browser`
      memory. A committed test would need to be written against that, not Playwright.
- [ ] **The root lint budget is exactly full.** `npm run lint` is `eslint . --max-warnings 157`
      and the repo currently sits at 157 warnings, 0 errors. The next warming anyone adds turns
      the build red. Either burn down the backlog or raise the cap deliberately.
