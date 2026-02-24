const sqliteClient = require('../../services/sqliteClient');

function getByUid(uid) {
    const db = sqliteClient.getDb();
    const query = `SELECT uid, title, content, updated_at FROM pre_context_settings WHERE uid = ?`;
    try {
        return db.prepare(query).get(uid) || null;
    } catch (err) {
        console.error('SQLite: Failed to get pre-context:', err);
        throw err;
    }
}

function upsert(uid, { title, content }) {
    const db = sqliteClient.getDb();
    const now = Math.floor(Date.now() / 1000);
    const query = `INSERT OR REPLACE INTO pre_context_settings (uid, title, content, updated_at) VALUES (?, ?, ?, ?)`;
    try {
        db.prepare(query).run(uid, title || '', content || '', now);
        return { success: true };
    } catch (err) {
        console.error('SQLite: Failed to upsert pre-context:', err);
        throw err;
    }
}

module.exports = { getByUid, upsert };
