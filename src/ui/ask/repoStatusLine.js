/**
 * Turns repoContextService.status() into the one line the Ask window shows.
 *
 * Pure and dependency-free so the verifier can require it under plain node, and so esbuild can
 * bundle it into the renderer without pulling electron or node:path into the browser.
 *
 * Never throws, for any input. The value arrives over IPC and may be null, {} or a rejected
 * invoke's fallback, and a status line that can throw is a status line that can take an Ask down.
 */

const UNSET = {
    state: 'unset',
    text: 'repo: none configured',
    detail: 'Set repoContextRootPath in pickle-glass-settings.json to send a repository with every Ask.',
};

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function basename(root) {
    const trimmed = String(root).trim();
    const parts = trimmed.replace(/[/\\]+$/, '').split(/[/\\]/);
    return parts[parts.length - 1] || trimmed;
}

function repoName(status) {
    if (nonEmptyString(status.name)) return status.name.trim();
    if (nonEmptyString(status.root)) return basename(status.root);
    return 'repo';
}

function count(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function compactTokens(value) {
    const tok = count(value);
    return tok >= 1000 ? `${(tok / 1000).toFixed(1)}k` : String(tok);
}

function loadedDetail(status, root) {
    const parts = [root];
    if (Array.isArray(status.subpaths) && status.subpaths.length > 0) {
        parts.push(`restricted to: ${status.subpaths.join(', ')}`);
    }
    parts.push(`${count(status.omitted)} omitted`);
    // Dropped rather than rendered when absent, because new Date(null) prints "Invalid Date".
    if (status.packedAt) parts.push(`packed ${new Date(status.packedAt).toTimeString().slice(0, 8)}`);
    return parts.join(' · ');
}

/**
 * @param {unknown} status a repoContextService.status() object, or anything at all
 * @returns {{ state: 'loaded'|'withheld'|'pending'|'unset', text: string, detail: string }}
 */
function formatRepoStatus(status) {
    try {
        if (!status || typeof status !== 'object') return UNSET;

        const name = repoName(status);
        const root = nonEmptyString(status.root) ? status.root.trim() : name;

        if (status.loaded === true) {
            const files = count(status.files);
            // The tilde is not decoration: estTokens is sourceBytes/2.5, measured 15.4%
            // optimistic on code and config (finding-ttft-vs-prompt-size.md), and
            // repoPack.js:255 already writes the manifest line as "~N tokens".
            return {
                state: 'loaded',
                text: `repo: ${name} · ${files} ${files === 1 ? 'file' : 'files'} · ~${compactTokens(status.estTokens)} tok`,
                detail: loadedDetail(status, root),
            };
        }

        if (status.withheld === true) {
            return {
                state: 'withheld',
                text: 'repo: not in use · the pack is from a different folder',
                detail: `The configured root is ${root}, but the pack in memory was built from a different one,`
                    + ' so nothing is being sent to the model. Restart Glass, or check that the configured'
                    + ' path still exists.',
            };
        }

        if (nonEmptyString(status.root)) {
            return {
                state: 'pending',
                text: `repo: ${name} · no pack loaded yet`,
                detail: `${root} has not been packed yet. If this does not clear within a few seconds the`
                    + ' build failed; check the terminal for [RepoContext].',
            };
        }

        return UNSET;
    } catch {
        return UNSET;
    }
}

module.exports = { formatRepoStatus };
