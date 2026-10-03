/**
 * Key names, validation and the app's settings path, with **zero dependencies**.
 *
 * This exists because `electron-store` resolves differently inside and outside Electron. Measured:
 * in the app it writes ~/Library/Application Support/Glass/pickle-glass-settings.json, under plain
 * node it writes ~/Library/Preferences/electron-store-nodejs/pickle-glass-settings.json. So a CLI
 * that required repoContextService would edit a file the app never reads and report success --
 * and merely requiring that module constructs a Store, so the wrong file gets created as a side
 * effect of the import.
 *
 * Keeping the names and the rules here lets the service (which owns the store) and a CLI (which
 * owns the file) share one definition instead of two that drift.
 */

const os = require('node:os');
const path = require('node:path');

const KEYS = {
    root: 'repoContextRootPath',
    subpaths: 'repoContextSubpaths',
    includePaths: 'repoContextIncludePaths',
};

/**
 * The settings file the running app reads, which is not where electron-store points under node.
 * @returns {string}
 */
function appSettingsPath() {
    const name = 'pickle-glass-settings.json';
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'Glass', name);
    }
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Glass', name);
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Glass', name);
}

/**
 * The two path lists are hand-edited JSON, so a bare string where the array belongs is a plausible
 * typo. Anything that is not an array of non-empty strings reads as "not configured": the whole
 * repository with a visible manifest is a better failure than the sentinel saying nothing is
 * loaded, which is indistinguishable from having configured no repo at all.
 *
 * Entries are trimmed, because a trailing space survives path.relative and then matches nothing,
 * which is the same silent-off outcome by a different route.
 *
 * @param {unknown} value
 * @returns {{ list: string[], rejected: boolean }} `rejected` is true when a value was present and
 *   unusable, which is the only case worth warning about -- absent is not an error.
 */
function normalizeList(value) {
    if (value === undefined || value === null) return { list: [], rejected: false };
    const ok = Array.isArray(value)
        && value.every(entry => typeof entry === 'string' && entry.trim() !== '');
    if (!ok) return { list: [], rejected: true };
    return { list: value.map(entry => entry.trim()), rejected: false };
}

module.exports = { KEYS, appSettingsPath, normalizeList };
