const { collection, doc, setDoc, getDoc, Timestamp } = require('firebase/firestore');
const { getFirestoreInstance } = require('../../../common/services/firebaseClient');
const { createEncryptedConverter } = require('../../../common/repositories/firestoreConverter');
const encryptionService = require('../../../common/services/encryptionService');

// The final_* fields carry the same class of content as their live counterparts - the whole
// session transcript, distilled - so they must be encrypted identically. Omitting them here would
// store the more complete summary in plaintext while the partial one stays protected.
// action_done_json holds the verbatim text of completed action items, so it is the same class of
// content as action_json itself - storing the user's commitments in plaintext just because they
// ticked them off would defeat the encryption on the list they came from.
const fieldsToEncrypt = [
    'tldr', 'text', 'bullet_json', 'action_json',
    'final_tldr', 'final_text', 'final_bullet_json', 'final_action_json',
    'action_done_json',
];
const summaryConverter = createEncryptedConverter(fieldsToEncrypt);

function summaryDocRef(sessionId) {
    if (!sessionId) throw new Error("Session ID is required to access summary.");
    const db = getFirestoreInstance();
    // Reverting to the original structure with 'data' as the document ID.
    const docPath = `sessions/${sessionId}/summary/data`;
    return doc(db, docPath).withConverter(summaryConverter);
}

async function saveSummary({ uid, sessionId, tldr, text, bullet_json, action_json, model = 'unknown' }) {
    const now = Timestamp.now();
    const summaryData = {
        uid, // To know who generated the summary
        session_id: sessionId,
        generated_at: now,
        model,
        text,
        tldr,
        bullet_json,
        action_json,
        updated_at: now,
    };
    
    // The converter attached to summaryDocRef will handle encryption via its `toFirestore` method.
    // Manual encryption was removed to fix the double-encryption bug.
    const docRef = summaryDocRef(sessionId);
    await setDoc(docRef, summaryData, { merge: true });

    return { changes: 1 };
}

/**
 * Writes the final whole-session summary. Uses merge:true and final_* keys only, so the live
 * snapshot fields on the same document survive as a fallback.
 */
async function saveFinalSummary({ uid, sessionId, tldr, text, bullet_json, action_json, model = 'unknown' }) {
    const now = Timestamp.now();
    const summaryData = {
        uid,
        session_id: sessionId,
        final_generated_at: now,
        final_model: model,
        final_text: text,
        final_tldr: tldr,
        final_bullet_json: bullet_json,
        final_action_json: action_json,
        updated_at: now,
    };

    // Encryption is handled by the converter on summaryDocRef.
    const docRef = summaryDocRef(sessionId);
    await setDoc(docRef, summaryData, { merge: true });

    return { changes: 1 };
}

async function getSummaryBySessionId(sessionId) {
    const docRef = summaryDocRef(sessionId);
    const docSnap = await getDoc(docRef);
    return docSnap.exists() ? docSnap.data() : null;
}

/**
 * Records which action items the user has ticked off. See the SQLite implementation for why the
 * item texts are stored rather than their positions.
 *
 * merge:true so this never disturbs the summary fields sharing the document.
 *
 * @param {string} sessionId
 * @param {string[]} doneTexts
 * @returns {Promise<{changes: number}>}
 */
async function saveActionDone(sessionId, doneTexts) {
    const docRef = summaryDocRef(sessionId);
    await setDoc(
        docRef,
        { action_done_json: JSON.stringify(doneTexts || []), updated_at: Timestamp.now() },
        { merge: true }
    );
    return { changes: 1 };
}

/**
 * Every session that produced action items, newest first.
 *
 * One summary read per session, which Firestore cannot avoid - summaries are sub-collection
 * documents and there is no cross-session query for them. Acceptable because this backs a review
 * page the user opens deliberately, not anything on a hot path.
 *
 * @param {string} uid - Owner
 * @returns {Promise<Array<object>>} Same row shape as the SQLite implementation
 */
async function getAllActionItems(uid) {
    const sessionRepository = require('../../../common/repositories/session/firebase.repository');
    const sessions = await sessionRepository.getAllByUserId(uid);

    const rows = await Promise.all(sessions.map(async session => {
        const summary = await getSummaryBySessionId(session.id);
        if (!summary) return null;
        // Final summaries only - see the SQLite implementation for why the live column is not
        // action items.
        if (!summary.final_generated_at || !summary.final_action_json) return null;

        return {
            session_id: session.id,
            title: session.title,
            started_at: session.started_at,
            session_type: session.session_type,
            final_action_json: summary.final_action_json,
            final_generated_at: summary.final_generated_at,
            action_done_json: summary.action_done_json ?? null,
        };
    }));

    return rows.filter(Boolean);
}

module.exports = {
    saveSummary,
    saveFinalSummary,
    getSummaryBySessionId,
    saveActionDone,
    getAllActionItems,
}; 