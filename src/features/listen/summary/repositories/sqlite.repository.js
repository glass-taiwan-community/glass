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

module.exports = {
    saveSummary,
    saveFinalSummary,
    getSummaryBySessionId,
}; 