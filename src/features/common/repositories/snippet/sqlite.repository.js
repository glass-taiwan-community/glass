const sqliteClient = require('../../services/sqliteClient');

function getSnippets(uid) {
    const db = sqliteClient.getDb();
    const query = `SELECT * FROM snippets WHERE uid = ? ORDER BY trigger_phrase ASC`;

    try {
        return db.prepare(query).all(uid);
    } catch (err) {
        console.error('SQLite: Failed to get snippets:', err);
        throw err;
    }
}

function create({ uid, trigger_phrase, expansion }) {
    const db = sqliteClient.getDb();
    const id = require('crypto').randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const query = `INSERT INTO snippets (id, uid, trigger_phrase, expansion, created_at, sync_state) VALUES (?, ?, ?, ?, ?, 'dirty')`;

    db.prepare(query).run(id, uid, trigger_phrase, expansion, now);
    return { id };
}

function update(id, { trigger_phrase, expansion }, uid) {
    const db = sqliteClient.getDb();
    const query = `UPDATE snippets SET trigger_phrase = ?, expansion = ?, sync_state = 'dirty' WHERE id = ? AND uid = ?`;

    const result = db.prepare(query).run(trigger_phrase, expansion, id, uid);
    if (result.changes === 0) {
        throw new Error('Snippet not found or permission denied.');
    }
    return { changes: result.changes };
}

function del(id, uid) {
    const db = sqliteClient.getDb();
    const result = db.prepare(`DELETE FROM snippets WHERE id = ? AND uid = ?`).run(id, uid);
    if (result.changes === 0) {
        throw new Error('Snippet not found or permission denied.');
    }
    return { changes: result.changes };
}

module.exports = { getSnippets, create, update, delete: del };
