/**
 * Validates one repo-context settings payload and, only if it builds, persists it.
 *
 * This lives in its own module rather than inside src/index.js's switch for two reasons.
 *
 * First, reachability. src/index.js requires electron, better-sqlite3 and the window manager at
 * module load, so nothing defined inside it can be loaded under plain node, and validation written
 * there would be unverifiable except by launching the app. Here a verifier requires the real rules
 * and drives them against real temporary repositories.
 *
 * Second, the store. This module TAKES a store-like object and never constructs one. config.js's
 * header records the measured reason: electron-store resolves to
 * ~/Library/Application Support/Glass/pickle-glass-settings.json inside Electron and to
 * ~/Library/Preferences/electron-store-nodejs/pickle-glass-settings.json under plain node. A module
 * that constructs a Store at load time therefore creates the wrong settings file as a side effect
 * of merely being imported, which is exactly what a verifier requiring this module would do. The
 * Store stays the caller's to own, and a test passes a plain object over a Map.
 *
 * @typedef {{ get(key: string): unknown, set(key: string, value: unknown): void,
 *             delete(key: string): void }} SettingsStore
 */

const fs = require('node:fs');
const path = require('node:path');
const { KEYS, normalizeList } = require('./config');
const { buildRepoPack, matchesSubpath } = require('./repoPack');

/**
 * Both payload field names AND `KEYS` property names, which is what lets one loop quote the real
 * settings key the user has to find in the hand-edited JSON.
 */
const LIST_FIELDS = ['subpaths', 'includePaths'];

/** `undefined` and `null` both read as absent, so a field the GUI cleared is not a type error. */
function present(value) {
    return value !== undefined && value !== null;
}

function refuse(reason) {
    return { ok: false, reason };
}

/**
 * Never throws for a bad payload. A refusal is DATA because the route turns `ok: false` into an
 * HTTP 400, the user's typo, while a genuine defect in here must still surface as a 500. Returning
 * a refusal where a throw would do also keeps the reason strings intact: they are the only thing
 * that tells the user which of three path spellings was wrong.
 *
 * Every refusal happens before the first store write, so a refused payload leaves the store
 * byte-identical. The write is one block at the end rather than interleaved for that reason.
 *
 * @param {SettingsStore} store
 * @param {unknown} payload `{ root, subpaths, includePaths }`, each field optional.
 * @returns {Promise<{ok: true}|{ok: false, reason: string}>}
 */
async function applySettings(store, payload) {
    if (!present(payload) || typeof payload !== 'object') {
        return refuse('expected an object holding root, subpaths and includePaths, but got '
            + `${payload === null ? 'null' : typeof payload}`);
    }
    if (present(payload.root) && typeof payload.root !== 'string') {
        return refuse(`${KEYS.root} must be a string path, but got ${typeof payload.root}`);
    }
    for (const field of LIST_FIELDS) {
        if (present(payload[field]) && !Array.isArray(payload[field])) {
            return refuse(`${KEYS[field]} must be an array of paths, one entry per path,`
                + ` but got ${typeof payload[field]}`);
        }
    }

    const lists = {};
    for (const field of LIST_FIELDS) {
        const { list, rejected } = normalizeList(payload[field]);
        // Disjoint from the Array.isArray check above, not redundant with it: with that check in
        // place this branch is reached only by an array holding a non-string or an empty string.
        if (rejected) return refuse(`${KEYS[field]} must be an array of non-empty strings`);
        lists[field] = list;
    }

    const root = present(payload.root) ? payload.root.trim() : '';
    if (!root) {
        for (const key of Object.values(KEYS)) store.delete(key);
        return { ok: true };
    }

    let rootStat;
    try {
        rootStat = await fs.promises.stat(root);
    } catch {
        return refuse(`${root} does not exist`);
    }
    if (!rootStat.isDirectory()) return refuse(`${root} is not a directory`);

    // Built BEFORE anything is persisted, which costs a second build when the caller then calls
    // refresh(). Deliberate: a persisted root that cannot build leaves promptBlock serving the
    // sentinel with nothing in the GUI to explain why, and that silent-off outcome is the exact
    // failure this page exists to end. Paying for one extra build is the cheaper side of the trade.
    let pack;
    try {
        pack = await buildRepoPack(root, { subpaths: lists.subpaths, includePaths: lists.includePaths });
    } catch (err) {
        // Verbatim, never reworded: buildRepoPack's own refusals already name the path, the missing
        // .git entry, the subpath that resolved outside the root, and the selection that matched
        // nothing at all.
        return refuse(err.message);
    }

    // buildRepoPack refuses only a selection matching nothing AT ALL, because at Ask time a partial
    // pack beats total silence and the manifest makes the partiality visible. This is configuration
    // time, where a typo is still fixable, so one unmatched subpath among three is refused here.
    const enumerated = [...pack.files.map(file => file.path), ...pack.omitted.map(entry => entry.path)];
    // pack.subpaths is the normalized list in the given order, so it zips with the raw spellings
    // the user typed, which are what they have to go and edit.
    const unmatched = pack.subpaths
        .map((subpath, index) => ({ subpath, spelled: lists.subpaths[index] }))
        .filter(entry => !enumerated.some(relPath => matchesSubpath(relPath, [entry.subpath])))
        .map(entry => entry.spelled);
    if (unmatched.length) {
        return refuse(`these subpaths match no tracked file: ${unmatched.join(', ')}`);
    }

    // Containment is already proven by buildRepoPack above. What is left is existence: a missing
    // opt-in path otherwise lands in the manifest as `unreadable`, where nothing surfaces it.
    const missing = [];
    for (const entry of lists.includePaths) {
        try {
            await fs.promises.stat(path.resolve(root, entry));
        } catch {
            missing.push(entry);
        }
    }
    if (missing.length) {
        return refuse(`these opt-in include paths do not exist under ${root}: ${missing.join(', ')}`);
    }

    store.set(KEYS.root, root);
    for (const field of LIST_FIELDS) {
        // An empty array is never written. A stale list left behind from a previous root is a real
        // failure mode, and an absent key reads identically to an empty one through normalizeList,
        // so deleting is both safer and indistinguishable downstream.
        if (lists[field].length) store.set(KEYS[field], lists[field]);
        else store.delete(KEYS[field]);
    }
    return { ok: true };
}

module.exports = { applySettings };
