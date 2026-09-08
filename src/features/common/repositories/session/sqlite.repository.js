const sqliteClient = require('../../services/sqliteClient');

function getById(id) {
    const db = sqliteClient.getDb();
    // Joins summaries only to feed DERIVED_TITLE, so the detail page heading matches the name the
    // list showed. Landing on a session whose title changed on the way in is disorienting.
    return db.prepare(`
        SELECT s.*, ${DERIVED_TITLE} AS display_title
        FROM sessions s
        LEFT JOIN summaries su ON su.session_id = s.id
        WHERE s.id = ?
    `).get(id);
}

function create(uid, type = 'ask') {
    const db = sqliteClient.getDb();
    const sessionId = require('crypto').randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const query = `INSERT INTO sessions (id, uid, title, session_type, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`;
    
    try {
        db.prepare(query).run(sessionId, uid, `Session @ ${new Date().toLocaleTimeString()}`, type, now, now);
        console.log(`SQLite: Created session ${sessionId} for user ${uid} (type: ${type})`);
        return sessionId;
    } catch (err) {
        console.error('SQLite: Failed to create session:', err);
        throw err;
    }
}

/**
 * Columns every session listing returns, including the content-derived fields the Activity
 * cards need to be identifiable.
 *
 * `tldr` and `summary_is_final` are picked from the whole final artifact or the whole live one,
 * never mixed: the live snapshot only covers the last 30 turns, so a card that showed a live
 * tldr without saying so would claim to summarise a meeting it only saw the end of.
 */
/**
 * A title worth showing, derived when the stored one is the auto-generated placeholder.
 *
 * create() names every session `Session @ <time>` and nothing ever renames it, so on a real
 * database all 182 titles are timestamps - useless for telling sessions apart and useless to
 * search. Derived rather than backfilled into the column, because most sessions predate the
 * automatic final-summary feature and will never get one: a derivation with fallbacks works on
 * all of them today, a backfill from summaries would reach fewer than a quarter.
 *
 * Falls back through the artifacts in descending order of how well they characterise a session,
 * ending at its first words - which is still far more identifying than a clock time. NULL when a
 * session has no content at all; callers then keep the stored title.
 */
const DERIVED_TITLE = `
    CASE
        WHEN s.title IS NOT NULL AND s.title NOT LIKE 'Session @ %' THEN s.title
        ELSE COALESCE(
            NULLIF(TRIM(su.final_tldr), ''),
            NULLIF(TRIM(su.tldr), ''),
            (SELECT t.text FROM transcripts t
              WHERE t.session_id = s.id AND TRIM(t.text) <> '' ORDER BY t.start_at LIMIT 1),
            (SELECT m.content FROM ai_messages m
              WHERE m.session_id = s.id AND m.role = 'user' AND TRIM(m.content) <> ''
              ORDER BY m.sent_at LIMIT 1)
        )
    END
`;

const SESSION_LIST_COLUMNS = `
    s.id, s.uid, s.title, s.session_type, s.started_at, s.ended_at, s.sync_state, s.updated_at,
    ${DERIVED_TITLE} AS display_title,
    CASE WHEN su.final_generated_at IS NOT NULL THEN su.final_tldr ELSE su.tldr END AS tldr,
    CASE WHEN su.final_generated_at IS NOT NULL THEN 1 ELSE 0 END AS summary_is_final,
    (SELECT COUNT(*) FROM transcripts t WHERE t.session_id = s.id) AS transcript_count,
    (SELECT COUNT(*) FROM ai_messages m WHERE m.session_id = s.id AND m.role = 'user') AS ask_count,
    -- How long the conversation actually ran, measured from its own records.
    --
    -- NOT ended_at - started_at: ended_at is stamped when the app closes the session, which can be
    -- days after anyone stopped talking. On one real database that arithmetic labelled a 49-minute
    -- meeting "66h 0m".
    --
    -- Transcripts define the span whenever they exist, and Ask messages are deliberately excluded
    -- from it. getOrCreateActive() reuses one session across a whole working period, so a session
    -- can hold a meeting plus questions asked 18 hours earlier or later; spanning both reports a
    -- 27-minute meeting as 18 hours. Ask-only sessions fall back to their message span.
    COALESCE(
        (SELECT MAX(start_at) - MIN(start_at) FROM transcripts WHERE session_id = s.id),
        (SELECT MAX(sent_at) - MIN(sent_at) FROM ai_messages WHERE session_id = s.id)
    ) AS content_span
`;

function getAllByUserId(uid) {
    const db = sqliteClient.getDb();
    const query = `
        SELECT ${SESSION_LIST_COLUMNS}
        FROM sessions s
        LEFT JOIN summaries su ON su.session_id = s.id
        WHERE s.uid = ?
        ORDER BY s.started_at DESC
    `;
    return db.prepare(query).all(uid);
}

/**
 * Every summary field worth searching, concatenated into one haystack.
 *
 * Summaries are the most searchable text a session owns - the tldr and the action items are the
 * distilled phrases a user actually remembers ("the pricing proposal one"), while the transcript
 * is verbatim speech that rarely matches how the meeting is recalled. Both the live and final
 * artifacts are included: recall matters more than precision here, and a hit in either is a real
 * hit even though only one of them is ever displayed.
 */
const SUMMARY_HAYSTACK = `(
    COALESCE(su.tldr, '')       || ' ' || COALESCE(su.final_tldr, '')       || ' ' ||
    COALESCE(su.text, '')       || ' ' || COALESCE(su.final_text, '')       || ' ' ||
    COALESCE(su.bullet_json, '')|| ' ' || COALESCE(su.final_bullet_json, '')|| ' ' ||
    COALESCE(su.action_json, '')|| ' ' || COALESCE(su.final_action_json, '')
)`;

/** How much text to keep either side of a search hit when building the preview snippet. */
const SNIPPET_RADIUS = 70;

/**
 * Escapes the LIKE wildcards a user can type so that searching for "50%" or "a_b" looks for
 * those literal characters instead of matching everything.
 *
 * @param {string} value - Raw user query
 * @returns {string} Query safe to interpolate into a LIKE pattern using ESCAPE '\'
 */
function escapeLikePattern(value) {
    return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

/**
 * Extracts the text around the first match so a result is recognisable without opening it.
 *
 * @param {string} text - Haystack
 * @param {string} query - What the user searched for
 * @returns {string|null} Snippet with ellipses, or null when the text does not contain the query
 */
function buildSnippet(text, query) {
    if (!text) return null;
    const at = text.toLowerCase().indexOf(query.toLowerCase());
    if (at === -1) return null;

    const from = Math.max(0, at - SNIPPET_RADIUS);
    const to = Math.min(text.length, at + query.length + SNIPPET_RADIUS);
    return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`;
}

/**
 * Full-content search across a user's sessions.
 *
 * Searches transcripts and Ask messages, not just titles: sessions are auto-titled
 * ("Session @ 14:03"), so a title-only search would appear to work and find nothing.
 *
 * Uses LIKE rather than FTS5 deliberately - this is single-user local data, and FTS5 would cost
 * a virtual table, a backfill and index upkeep for a corpus small enough that a scan is instant.
 *
 * @param {string} uid - Owner
 * @param {string} query - Raw user query; wildcards are escaped, not honoured
 * @param {number} [limit=30] - Maximum sessions to return
 * @returns {{scope: 'content', results: Array<object>}} Rows plus `snippet`, `snippet_source`
 *   and hit counts. `scope` tells the UI how much was actually searched - the Firebase
 *   implementation can only manage titles, and silently returning fewer results is the exact
 *   failure this feature exists to fix.
 */
function searchSessions(uid, query, limit = 30) {
    const db = sqliteClient.getDb();
    const trimmed = (query || '').trim();
    if (!trimmed) return { scope: 'content', results: [] };

    const pattern = `%${escapeLikePattern(trimmed)}%`;

    // Hit counts double as the WHERE filter's evidence, so they are computed once and reused
    // rather than duplicated between SELECT and WHERE as correlated subqueries.
    const sessions = db.prepare(`
        SELECT ${SESSION_LIST_COLUMNS},
            (SELECT COUNT(*) FROM transcripts t
              WHERE t.session_id = s.id AND t.text LIKE @pattern ESCAPE '\\') AS transcript_hits,
            (SELECT COUNT(*) FROM ai_messages m
              WHERE m.session_id = s.id AND m.content LIKE @pattern ESCAPE '\\') AS message_hits,
            (CASE WHEN ${SUMMARY_HAYSTACK} LIKE @pattern ESCAPE '\\' THEN 1 ELSE 0 END) AS summary_hit,
            (CASE WHEN s.title LIKE @pattern ESCAPE '\\' THEN 1 ELSE 0 END) AS title_hit
        FROM sessions s
        LEFT JOIN summaries su ON su.session_id = s.id
        WHERE s.uid = @uid
          AND (
            s.title LIKE @pattern ESCAPE '\\'
            OR ${SUMMARY_HAYSTACK} LIKE @pattern ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM transcripts t
                        WHERE t.session_id = s.id AND t.text LIKE @pattern ESCAPE '\\')
            OR EXISTS (SELECT 1 FROM ai_messages m
                        WHERE m.session_id = s.id AND m.content LIKE @pattern ESCAPE '\\')
          )
        ORDER BY s.started_at DESC
        LIMIT @limit
    `).all({ uid, pattern, limit });

    // The snippet comes from whichever record actually matched. Ask content is preferred over
    // transcript text because a question the user typed themselves is the stronger memory cue.
    const firstMessage = db.prepare(`
        SELECT content AS text FROM ai_messages
        WHERE session_id = ? AND content LIKE ? ESCAPE '\\'
        ORDER BY sent_at ASC LIMIT 1
    `);
    const firstTranscript = db.prepare(`
        SELECT text FROM transcripts
        WHERE session_id = ? AND text LIKE ? ESCAPE '\\'
        ORDER BY start_at ASC LIMIT 1
    `);

    const results = sessions.map(session => {
        let snippet = null;
        let snippet_source = null;

        if (session.message_hits > 0) {
            snippet = buildSnippet(firstMessage.get(session.id, pattern)?.text, trimmed);
            snippet_source = 'ask';
        }
        if (!snippet && session.transcript_hits > 0) {
            snippet = buildSnippet(firstTranscript.get(session.id, pattern)?.text, trimmed);
            snippet_source = 'transcript';
        }
        if (!snippet && session.summary_hit) {
            // The match may be anywhere in the haystack (an action item, a bullet), but the tldr
            // is the one line that reads as prose, so it is the better preview even when the hit
            // was elsewhere. Fall back to the haystack when there is no tldr to show.
            snippet = session.tldr || buildSnippet(session.title, trimmed) || null;
            snippet_source = 'summary';
        }
        if (!snippet && session.title_hit) {
            snippet = session.title;
            snippet_source = 'title';
        }

        return { ...session, snippet, snippet_source };
    });

    return { scope: 'content', results };
}

function updateTitle(id, title) {
    const db = sqliteClient.getDb();
    const result = db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
    return { changes: result.changes };
}

function deleteWithRelatedData(id) {
    const db = sqliteClient.getDb();
    const transaction = db.transaction(() => {
        db.prepare("DELETE FROM transcripts WHERE session_id = ?").run(id);
        db.prepare("DELETE FROM ai_messages WHERE session_id = ?").run(id);
        db.prepare("DELETE FROM summaries WHERE session_id = ?").run(id);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    });
    
    try {
        transaction();
        return { success: true };
    } catch (err) {
        throw err;
    }
}

function end(id) {
    const db = sqliteClient.getDb();
    const now = Math.floor(Date.now() / 1000);
    const query = `UPDATE sessions SET ended_at = ?, updated_at = ? WHERE id = ?`;
    const result = db.prepare(query).run(now, now, id);
    return { changes: result.changes };
}

function updateType(id, type) {
    const db = sqliteClient.getDb();
    const now = Math.floor(Date.now() / 1000);
    const query = 'UPDATE sessions SET session_type = ?, updated_at = ? WHERE id = ?';
    const result = db.prepare(query).run(type, now, id);
    return { changes: result.changes };
}

function touch(id) {
    const db = sqliteClient.getDb();
    const now = Math.floor(Date.now() / 1000);
    const query = 'UPDATE sessions SET updated_at = ? WHERE id = ?';
    const result = db.prepare(query).run(now, id);
    return { changes: result.changes };
}

/**
 * How long a session may sit with no new content before it is treated as finished.
 *
 * Chosen from the gap distribution in a real 182-session database: 16 sessions contain a gap
 * over 20 minutes but only 11 contain one over 60, and that count is unchanged at 120 minutes.
 * The gaps between 20 and 60 minutes are breaks inside one sitting; the ones past an hour are a
 * different working period entirely - in the worst case a session held a meeting and a question
 * asked 18 hours apart, which made its "duration" 18 hours and put unrelated material under one
 * heading.
 */
const SESSION_IDLE_TIMEOUT_SECONDS = 60 * 60;

/**
 * When a session last received actual content.
 *
 * Deliberately not `updated_at`: touch() bumps that every time a session is merely looked up, so
 * it measures attention rather than activity and an idle session would never look idle. Falls
 * back to `started_at` for a session that never recorded anything.
 *
 * @param {object} db - Open database
 * @param {string} sessionId
 * @returns {number} Unix seconds
 */
function lastActivityAt(db, sessionId) {
    const row = db.prepare(`
        SELECT MAX(at) AS at FROM (
            SELECT MAX(start_at) AS at FROM transcripts WHERE session_id = @id
            UNION ALL SELECT MAX(sent_at) FROM ai_messages WHERE session_id = @id
            UNION ALL SELECT started_at FROM sessions WHERE id = @id
        )
    `).get({ id: sessionId });
    return row?.at ?? 0;
}

function getOrCreateActive(uid, requestedType = 'ask') {
    const db = sqliteClient.getDb();

    // 1. Look for ANY active session for the user (ended_at IS NULL).
    //    Prefer 'listen' sessions over 'ask' sessions to ensure continuity.
    const findQuery = `
        SELECT id, session_type FROM sessions
        WHERE uid = ? AND ended_at IS NULL
        ORDER BY CASE session_type WHEN 'listen' THEN 1 WHEN 'ask' THEN 2 ELSE 3 END
        LIMIT 1
    `;

    let activeSession = db.prepare(findQuery).get(uid);

    // 1b. A session left open across a long silence is not the same conversation. Close it and
    //     fall through to creating a fresh one, so a session stays one sitting rather than
    //     everything that happened between two app launches.
    if (activeSession) {
        const idleFor = Math.floor(Date.now() / 1000) - lastActivityAt(db, activeSession.id);
        if (idleFor > SESSION_IDLE_TIMEOUT_SECONDS) {
            console.log(`[Repo] Session ${activeSession.id} idle for ${Math.round(idleFor / 60)}min; ending it.`);
            end(activeSession.id);
            activeSession = null;
        }
    }

    if (activeSession) {
        // An active session exists.
        console.log(`[Repo] Found active session ${activeSession.id} of type ${activeSession.session_type}`);
        
        // 2. Promotion Logic: If it's an 'ask' session and we need 'listen', promote it.
        if (activeSession.session_type === 'ask' && requestedType === 'listen') {
            updateType(activeSession.id, 'listen');
            console.log(`[Repo] Promoted session ${activeSession.id} to 'listen' type.`);
        }

        // 3. Touch the session and return its ID.
        touch(activeSession.id);
        return activeSession.id;
    } else {
        // 4. No active session found, create a new one.
        console.log(`[Repo] No active session for user ${uid}. Creating new '${requestedType}' session.`);
        return create(uid, requestedType);
    }
}

function endAllActiveSessions(uid) {
    const db = sqliteClient.getDb();
    const now = Math.floor(Date.now() / 1000);
    // Filter by uid to match the Firebase repository's behavior.
    const query = `UPDATE sessions SET ended_at = ?, updated_at = ? WHERE ended_at IS NULL AND uid = ?`;
    
    try {
        const result = db.prepare(query).run(now, now, uid);
        console.log(`[Repo] Ended ${result.changes} active SQLite session(s) for user ${uid}.`);
        return { changes: result.changes };
    } catch (err) {
        console.error('SQLite: Failed to end all active sessions:', err);
        throw err;
    }
}

module.exports = {
    getById,
    create,
    getAllByUserId,
    searchSessions,
    updateTitle,
    deleteWithRelatedData,
    end,
    updateType,
    touch,
    getOrCreateActive,
    endAllActiveSessions,
}; 