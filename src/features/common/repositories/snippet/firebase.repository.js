const { collection, doc, addDoc, getDoc, getDocs, updateDoc, deleteDoc, orderBy, query, Timestamp } = require('firebase/firestore');
const { getFirestoreInstance } = require('../../services/firebaseClient');

/**
 * Firestore-backed snippets for signed-in users.
 *
 * Path is `users/{uid}/snippets`, matching what the web GUI writes in
 * `pickleglass_web/utils/firestore.ts`, and values are stored in plain text for the same reason.
 *
 * This deliberately does NOT follow the preset repository next door. That one writes an encrypted
 * top-level `prompt_presets` collection while the web GUI reads an unencrypted
 * `users/{uid}/promptPresets` subcollection -- the two never see each other's data, so a preset
 * created in the web GUI is invisible to the desktop app. Copying that shape here would have made
 * snippets silently do nothing for signed-in users.
 */

function snippetsCol(uid) {
    return collection(getFirestoreInstance(), 'users', uid, 'snippets');
}

async function getSnippets(uid) {
    const snapshot = await getDocs(query(snippetsCol(uid), orderBy('trigger_phrase', 'asc')));
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function create({ uid, trigger_phrase, expansion }) {
    const docRef = await addDoc(snippetsCol(uid), {
        uid,
        trigger_phrase,
        expansion,
        created_at: Timestamp.now(),
    });
    return { id: docRef.id };
}

async function update(id, { trigger_phrase, expansion }, uid) {
    const docRef = doc(snippetsCol(uid), id);
    if (!(await getDoc(docRef)).exists()) {
        throw new Error('Snippet not found or permission denied to update.');
    }

    const updates = { updated_at: Timestamp.now() };
    if (trigger_phrase !== undefined) updates.trigger_phrase = trigger_phrase;
    if (expansion !== undefined) updates.expansion = expansion;

    await updateDoc(docRef, updates);
    return { changes: 1 };
}

async function del(id, uid) {
    const docRef = doc(snippetsCol(uid), id);
    if (!(await getDoc(docRef)).exists()) {
        throw new Error('Snippet not found or permission denied to delete.');
    }
    await deleteDoc(docRef);
    return { changes: 1 };
}

module.exports = { getSnippets, create, update, delete: del };
