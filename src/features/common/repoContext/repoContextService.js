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

const store = new Store({ name: 'pickle-glass-settings' });

const ROOT_KEY = 'repoContextRootPath';
const INCLUDE_KEY = 'repoContextIncludePaths';

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
        const pack = await buildRepoPack(root, { includePaths: store.get(INCLUDE_KEY) || [] });

        // The setting can change while a build is running. Installing a pack for a root the user
        // has already left would both answer about the wrong repo and evict a working pack for the
        // right one, which is worse than the failure this function is otherwise guarding.
        if (configuredRoot() !== root) {
            console.warn(`[RepoContext] discarding the pack for ${root}, the root changed mid-build`);
            return false;
        }

        lastGood = pack;
        console.log(`[RepoContext] packed ${root}: ${pack.files.length} files,`
            + ` ${pack.sourceBytes} B, ~${pack.estTokens} tokens, ${pack.omitted.length} omitted`);
        return true;
    } catch (err) {
        console.error(`[RepoContext] pack of ${root} failed, keeping the previous one:`, err.message);
        return false;
    }
}

module.exports = { promptBlock, refresh, SENTINEL };
