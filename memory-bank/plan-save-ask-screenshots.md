# Plan: Save Screen-Only Ask Screenshots to Session History

**Status:** APPROVED — building. Decisions: readable copy **1280px wide**; retention **30 days**;
setting **default off**; history is **web-only / retrospective** (no past-screenshot viewer in
the desktop overlay).
**Created:** 2026-08-29
**Scope (est.):** `src/features/ask/askService.js`, `ai_messages` schema + repos,
`src/features/settings/*` (new setting), `pickleglass_web` (API route + activity details page)

---

## 1. Goal & decision

When the user triggers a **screen-only** Ask — press `Cmd+Enter` a second time on an empty
input — Glass captures the screen and sends it to the model but then throws it away. There is
no record of *what was on screen*, and the saved user turn is an empty string, so the activity
history shows an empty question + an answer with no context.

**Save that screenshot** and show it in the web activity history for future reference.

**Decided:** save **only** on the screen-only (`Cmd+Enter`-twice) path, not on every Ask.
That is exactly the case with no text to remind the user what they asked, so it is the one
worth a picture. Typed/voice/summary-click asks already carry their own prompt text.

## 2. Confirmed current behavior (code)

- Trigger: `nextStep` → `askService.toggleAskButton(true)` → the `inputScreenOnly` branch
  (`askService.js:151`) → `sendMessage('', [])`.
- Capture: `captureScreenshot()` (`askService.js:38`). macOS shells out to
  `screencapture -x -t jpg` to a temp file, downscales to **384px tall @ 80% JPEG** via sharp,
  base64-encodes, and **deletes the temp file**. (Other platforms: `desktopCapturer` 1920x1080.)
- Use: base64 attached to the LLM request as `image_url` (`askService.js:281-284`), and kept
  in an in-memory `lastScreenshot` var (overwritten each capture, lost on restart).
- Persistence: `addAiMessage({ sessionId, role, content })` (`askService.js:243`) saves only
  `content` (text). The `ai_messages` schema has **no image column**. Screenshot is discarded.

## 3. Design

### 3.1 Signal the screen-only path
`sendMessage` cannot currently tell why it was called. Thread an explicit flag rather than
guessing from an empty prompt (voice-ask also produces short prompts):
- `toggleAskButton`'s screen-only branch calls `sendMessage('', [], { saveScreenshot: true })`.
- `sendMessage(userPrompt, conversationHistoryRaw=[], opts={})` reads `opts.saveScreenshot`.

### 3.2 Capture a readable copy, not just the model's thumbnail
The 384px-tall image is fine for the model but too small to read later. `captureScreenshot`
already has the full-res temp JPG buffer in hand before the 384px downscale — from that same
buffer, also produce a **readable** copy (e.g. sharp resize to ~1280px wide @ 80% JPEG) when
saving is requested. One capture, two outputs (small for model, readable for history). No extra
`screencapture` call.

### 3.3 Store as a file, not base64 in the DB
Base64 in SQLite bloats the DB and slows every query. Instead:
- Write the readable JPG to `userData/ask-screenshots/<messageId>.jpg`.
- Add an `image_path` column to `ai_messages` (auto-migrates via `synchronizeSchema`); store
  the filename (not an absolute path — keep it portable). Add to both sqlite + firebase repos
  and the `addAiMessage` signature.
- The user turn for a screen-only ask has empty `content`; `image_path` becomes its real
  payload.

### 3.4 Opt-in setting + retention
- New setting `save_ask_screenshots` (default **off**) — stored screen captures are a real
  privacy surface (whatever was visible: passwords, private messages). Same pattern as
  `voice_ask_enabled`: users column + Settings toggle + IPC. When off, behavior is unchanged
  (temp file deleted, nothing stored).
- **Cleanup:** a retention policy so images do not accumulate forever — delete files older than
  N days on startup, and/or cap total count. Decide N (suggest 30 days). Deleting a session
  should delete its screenshots too.

### 3.5 Surface in the web activity history
- **Serve the files:** add a backend_node route (e.g. `GET /api/screenshots/:file`) that serves
  from `userData/ask-screenshots/`, path-sanitized to that dir only. The session-details API
  (`conversations.js`) already returns `ai_messages`; include `image_path` in the row.
- **Render:** in `pickleglass_web/app/activity/details/page.tsx` (the `askMessages.map` at
  ~L211), when a message has `image_path`, show a thumbnail under the turn; click to open full
  size. For an empty-content user turn, the thumbnail *is* the content.

## 4. Sequencing

1. Schema column + repo/signature plumbing for `image_path` (no behavior change yet).
2. `save_ask_screenshots` setting (default off) + Settings toggle.
3. `captureScreenshot` produces the readable copy + saves it; `sendMessage` writes `image_path`
   on the user turn, gated by `opts.saveScreenshot && settingEnabled`.
4. Backend route + details-page thumbnail.
5. Retention cleanup + delete-on-session-delete.

Steps 1–3 are the core (capture + persist); 4 is the UI payoff; 5 is hygiene. Each is
independently testable.

## 5. Out of scope / deferred

- Saving screenshots for *every* Ask (decided against — only screen-only).
- Editing/annotating saved screenshots.
- Syncing screenshots to Firebase storage (local-file only for now; firebase repo stores the
  path field for schema parity but cloud image upload is a separate feature).

## 6. Open items for reviewer

- Readable-copy resolution: ~1280px wide enough, or full native res (bigger files)?
- Retention window N (default 30 days?) and whether to also cap count.
- Confirm the setting defaults **off**.
- Should the desktop overlay (not just the web UI) also show past screenshots, or web-only?
