const sqliteClient = require('../../../common/services/sqliteClient');

function saveSummary({ uid, sessionId, tldr, text, bullet_json, action_json, model = 'unknown' }) {
    // uid is ignored in the SQLite implementation
    return new Promise((resolve, reject) => {
        try {
            const db = sqliteClient.getDb();
            const now = Math.floor(Date.now() / 1000);
            const query = `
                INSERT INTO summaries (session_id, generated_at, model, text, tldr, bullet_json, action_json, updated_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    generated_at=excluded.generated_at,
                    model=excluded.model,
                    text=excluded.text,
                    tldr=excluded.tldr,
                    bullet_json=excluded.bullet_json,
                    action_json=excluded.action_json,
                    updated_at=excluded.updated_at
            `;
            
            const result = db.prepare(query).run(sessionId, now, model, text, tldr, bullet_json, action_json, now);
            resolve({ changes: result.changes });
        } catch (err) {
            console.error('Error saving summary:', err);
            reject(err);
        }
    });
}

/**
 * Writes the final whole-session summary. Deliberately touches only the final_* columns so the
 * live snapshot written by saveSummary() survives as a fallback for sessions where this never
 * runs (older recordings, or generation failure).
 */
function saveFinalSummary({ uid, sessionId, tldr, text, bullet_json, action_json, model = 'unknown' }) {
    // uid is ignored in the SQLite implementation
    return new Promise((resolve, reject) => {
        try {
            const db = sqliteClient.getDb();
            const now = Math.floor(Date.now() / 1000);
            // The row may not exist yet: a session shorter than the live analysis threshold never
            // wrote one, and those are exactly the sessions this feature is meant to rescue.
            const query = `
                INSERT INTO summaries (session_id, final_generated_at, final_model, final_text, final_tldr, final_bullet_json, final_action_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    final_generated_at=excluded.final_generated_at,
                    final_model=excluded.final_model,
                    final_text=excluded.final_text,
                    final_tldr=excluded.final_tldr,
                    final_bullet_json=excluded.final_bullet_json,
                    final_action_json=excluded.final_action_json,
                    updated_at=excluded.updated_at
            `;
            const result = db.prepare(query).run(sessionId, now, model, text, tldr, bullet_json, action_json, now);
            resolve({ changes: result.changes });
        } catch (err) {
            console.error('Error saving final summary:', err);
            reject(err);
        }
    });
}

function getSummaryBySessionId(sessionId) {
    const db = sqliteClient.getDb();
    const query = "SELECT * FROM summaries WHERE session_id = ?";
    return db.prepare(query).get(sessionId) || null;
}

/**
 * Records which action items the user has ticked off.
 *
 * Stores the item *texts*, not their positions: the live summary is regenerated every 5 turns and
 * reorders action_json, so a position-keyed record would drift onto a different commitment. An
 * item whose wording is later rewritten simply reappears unchecked, which is the safe direction
 * to fail in - it re-surfaces a commitment rather than silently marking one done.
 *
 * Only ever updates an existing row. A session with no summary has no action items to tick, so
 * an insert here would create a summary row containing nothing but checkbox state.
 *
 * @param {string} sessionId
 * @param {string[]} doneTexts - Full text of every completed item
 * @returns {{changes: number}}
 */
function saveActionDone(sessionId, doneTexts) {
    const db = sqliteClient.getDb();
    const now = Math.floor(Date.now() / 1000);
    const result = db
        .prepare('UPDATE summaries SET action_done_json = ?, updated_at = ? WHERE session_id = ?')
        .run(JSON.stringify(doneTexts || []), now, sessionId);
    return { changes: result.changes };
}

/**
 * Every session that produced real action items, newest first, for the cross-session review.
 *
 * Restricted to sessions with a FINAL summary. The live snapshot's `action_json` is not action
 * items at all - parseFinalResponseText() documents it as live-assist affordances (suggested
 * questions plus hardcoded chips like "What should I say next?"), and in one real database every
 * one of its 130 live rows carried those chips while no final row did. Including live rows would
 * fill this view with items the user can neither act on nor get rid of.
 *
 * Returns the raw JSON column; the caller strips "None identified" placeholders, so that rule
 * lives in one place shared with the session detail view.
 *
 * @param {string} uid - Owner
 * @returns {Array<{session_id: string, title: string, started_at: number, session_type: string,
 *   final_action_json: string|null, final_generated_at: number|null,
 *   action_done_json: string|null}>}
 */
function getAllActionItems(uid) {
    const db = sqliteClient.getDb();
    return db.prepare(`
        SELECT su.session_id, s.title, s.started_at, s.session_type,
               su.final_action_json, su.final_generated_at, su.action_done_json
        FROM summaries su
        JOIN sessions s ON s.id = su.session_id
        WHERE s.uid = ?
          AND su.final_generated_at IS NOT NULL
          AND su.final_action_json IS NOT NULL
        ORDER BY s.started_at DESC
    `).all(uid);
}

module.exports = {
    saveSummary,
    saveFinalSummary,
    getSummaryBySessionId,
    saveActionDone,
    getAllActionItems,
}; 