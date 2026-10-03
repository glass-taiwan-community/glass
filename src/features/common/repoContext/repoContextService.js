/**
 * Owns the one in-memory repo pack that Ask attaches to its system prompt.
 *
 * The root lives in electron-store rather than sqlite because a repo path is machine-scoped by
 * nature; the sqlite-backed settings are keyed by uid and flip when the user signs in or out,
 * which would silently swap the pack's source mid-interview. settingsService.js:12 already owns
 * that file's defaults, so no `defaults` are passed here.
 */

const Store = require('electron-store');
const { buildRepoPack } = require('./repoPack');
const { applySettings } = require('./applySettings');
const { KEYS, normalizeList } = require('./config');

const store = new Store({ name: 'pickle-glass-settings' });

const ROOT_KEY = KEYS.root;
const INCLUDE_KEY = KEYS.includePaths;
const SUBPATHS_KEY = KEYS.subpaths;

/**
 * An empty block is indistinguishable from a loaded pack in the answer, the only channel the user
 * reads mid-interview, so say it out loud instead of emitting ''.
 */
const SENTINEL = '=== no repository context is loaded ===\n'
    + 'If asked anything specific about a repository, say you cannot see it.';

/** @type {import('./repoPack').RepoPack|null} */
let lastGood = null;
/** @type {{ root: string|null, promise: Promise<boolean> }|null} */
let inFlight = null;

/** Never throws: an unreadable settings file reads as "not configured". */
function configuredRoot() {
    try {
        return store.get(ROOT_KEY) || null;
    } catch (err) {
        console.error('[RepoContext] could not read the configured root:', err.message);
        return null;
    }
}

/**
 * The validation lives in ./config so a CLI outside Electron applies the identical rules without
 * requiring this module, which would construct a Store against the wrong path.
 */
function configuredList(key) {
    try {
        const { list, rejected } = normalizeList(store.get(key));
        if (rejected) console.warn(`[RepoContext] ignoring ${key}: expected an array of non-empty strings`);
        return list;
    } catch (err) {
        console.error(`[RepoContext] could not read ${key}:`, err.message);
        return [];
    }
}

/**
 * Synchronous and never throws, because it runs inside sendMessage on the TTFT critical path where
 * a repo-context failure must not be able to break an Ask.
 *
 * The pack is served only when it was built from the currently configured root. Without that
 * check, switching repos while the new pack fails leaves the old one answering confidently about
 * the wrong source, with a manifest authoritatively listing its files. Reading the root here does
 * cost a readFileSync inside electron-store, measured at 0.057 ms, which is the price of comparing
 * against the *current* setting rather than a cached copy that a repo switch would invalidate.
 *
 * @returns {string} the pack text, or the sentinel block
 */
function promptBlock() {
    try {
        const root = configuredRoot();
        if (!root || !lastGood || lastGood.root !== root) return SENTINEL;
        return lastGood.text;
    } catch {
        return SENTINEL;
    }
}

/**
 * Single-flight per root, and a failure leaves the previous pack in place. Stale beats failed, and
 * promptBlock's root check is what stops stale-from-the-wrong-repo being served at all.
 *
 * Keying the single flight on the root matters: an unkeyed one lets a caller that arrives after a
 * repo switch join the build for the repo the user has already left, and then report success.
 *
 * @returns {Promise<boolean>} true when a new pack was installed
 */
function refresh() {
    const root = configuredRoot();
    if (inFlight && inFlight.root === root) return inFlight.promise;
    const promise = build(root).finally(() => {
        if (inFlight && inFlight.promise === promise) inFlight = null;
    });
    inFlight = { root, promise };
    return promise;
}

async function build(root) {
    if (!root) return false;
    try {
        // configuredList, not settingsService: importing it here would close the cycle
        // settingsService -> windowManager -> shortcutsService -> askService -> this module, and
        // settingsService also pulls in electron and modelStateService, which this module is
        // deliberately loadable without. So validation of the hand-edited JSON lives here, at the
        // boundary the value actually crosses.
        const pack = await buildRepoPack(root, {
            includePaths: configuredList(INCLUDE_KEY),
            subpaths: configuredList(SUBPATHS_KEY),
        });
        return install(pack);
    } catch (err) {
        console.error(`[RepoContext] pack of ${root} failed, keeping the previous one:`, err.message);
        return false;
    }
}

/**
 * The one place `lastGood` is written, whether the pack came from build() just above or ready-built
 * from save().
 *
 * @param {import('./repoPack').RepoPack} pack
 */
function install(pack) {
    // Installing a pack for a root the user has already left would both answer about the wrong repo
    // and evict a working pack for the right one, which is worse than the failure this is otherwise
    // guarding. The root can change while a pack is being built AND while a ready-built one is
    // carried here, so the check belongs with the install rather than at either caller.
    if (configuredRoot() !== pack.root) {
        console.warn(`[RepoContext] discarding the pack for ${pack.root}, the root changed`);
        return false;
    }

    lastGood = pack;
    console.log(`[RepoContext] packed ${pack.root}: ${pack.files.length} files,`
        + ` ${pack.sourceBytes} B, ~${pack.estTokens} tokens, ${pack.omitted.length} omitted`);
    return true;
}

/**
 * The one way to write these settings. The store stays private to this module rather than being
 * exported, because a caller holding it could write any key in the whole settings file to reach the
 * three this feature owns, and could persist a root without the build that proves it packs.
 *
 * `refreshed: false` on an `ok: true` means nothing was installed and Ask is still serving the
 * sentinel, which is what the page renders.
 *
 * @param {unknown} payload `{ root, subpaths, includePaths }`
 * @returns {Promise<{ok: true, refreshed: boolean}|{ok: false, reason: string}>}
 */
async function save(payload) {
    const applied = await applySettings(store, payload);
    if (!applied.ok) return applied;
    // Installing the pack applySettings already built, rather than calling refresh() to build it
    // again from the same root, is worth 31 ms for a subpath selection and 111 ms at p50 for a whole
    // repository.
    return { ok: true, refreshed: applied.pack ? install(applied.pack) : false };
}

/**
 * What is configured and what is actually being served, for the Ask window's status line, the CLI
 * and the settings page. Synchronous and never throws, same contract as promptBlock, because the
 * status line renders on the same path an Ask does.
 *
 * `withheld` is the case promptBlock already refuses to serve: a pack exists but it was built from
 * a different root than the one now configured. It reads identically to "nothing loaded" in the
 * answer, and the two want different wording in the UI -- one is a failed refresh, the other is an
 * empty setting.
 *
 * @returns {{ root: string|null, subpaths: string[], includePaths: string[], loaded: boolean,
 *             withheld: boolean, files: number, estTokens: number, omitted: number,
 *             packedAt: number|null, name: string|null }}
 */
function status() {
    const empty = {
        root: null, subpaths: [], includePaths: [], loaded: false, withheld: false,
        files: 0, estTokens: 0, omitted: 0, packedAt: null, name: null,
    };
    try {
        const root = configuredRoot();
        const base = { ...empty, root, subpaths: configuredList(SUBPATHS_KEY), includePaths: configuredList(INCLUDE_KEY) };
        if (!root || !lastGood) return base;
        if (lastGood.root !== root) return { ...base, withheld: true };
        return {
            ...base,
            loaded: true,
            files: lastGood.files.length,
            estTokens: lastGood.estTokens,
            omitted: lastGood.omitted.length,
            packedAt: lastGood.builtAt ?? null,
            name: require('node:path').basename(root),
        };
    } catch {
        return empty;
    }
}

module.exports = { promptBlock, refresh, save, status, SENTINEL };
