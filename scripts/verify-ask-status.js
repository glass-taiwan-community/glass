#!/usr/bin/env node
/**
 * node scripts/verify-ask-status.js
 *
 * Exits 0 only when every assertion holds. Proves two things the Ask window's status line rests
 * on: the shape repoContextService.status() returns in each of its four states, driven through the
 * real service against a stub electron-store, and the exact string the formatter renders for each
 * of those live objects.
 *
 * The fixture is a real git repo, built in os.tmpdir() rather than in the tree: a `git init` inside
 * this repo would nest a second repo under it.
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const util = require('node:util');
const execFile = util.promisify(require('node:child_process').execFile);

const SERVICE_MODULE = '../src/features/common/repoContext/repoContextService';
const { formatRepoStatus } = require('../src/ui/ask/repoStatusLine');

let fixture = null;

function check(ok, message) {
    assert.ok(ok, message);
    console.log(`ok   ${message}`);
}

async function buildFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ask-status-'));
    await execFile('git', ['-C', root, 'init', '--quiet']);
    fs.writeFileSync(path.join(root, 'a.yaml'), '# a\nvalue: 1\n');
    fs.writeFileSync(path.join(root, 'b.yaml'), '# b\nvalue: 2\n');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'nested prose\n');
    await execFile('git', ['-C', root, 'add', '-A']);
    return root;
}

function checkDetail(line, state) {
    check(typeof line.detail === 'string' && line.detail.length > 0,
        `the ${state} line carries a non-empty title attribute`);
}

/**
 * The four states are only reachable by moving the configured root underneath a live pack, which
 * the real settings file cannot do. Same stub-the-store technique as verify-repo-pack.js.
 */
async function checkStatesThroughService() {
    const storeId = require.resolve('electron-store');
    const serviceId = require.resolve(SERVICE_MODULE);
    const realStore = require.cache[storeId];
    let configured = null;
    let configuredSubpaths = [];
    let configuredIncludePaths = [];

    require.cache[storeId] = {
        id: storeId,
        filename: storeId,
        loaded: true,
        exports: class {
            get(key) {
                if (key === 'repoContextRootPath') return configured;
                if (key === 'repoContextSubpaths') return configuredSubpaths;
                if (key === 'repoContextIncludePaths') return configuredIncludePaths;
                return undefined;
            }
        },
    };
    delete require.cache[serviceId];

    try {
        const service = require(SERVICE_MODULE);

        const unset = service.status();
        check(unset.loaded === false && unset.withheld === false && unset.root === null
            && unset.files === 0 && unset.estTokens === 0 && unset.packedAt === null
            && unset.name === null,
            'status() with no root configured reports nothing configured and nothing served');
        const unsetLine = formatRepoStatus(unset);
        check(unsetLine.state === 'unset' && unsetLine.text === 'repo: none configured',
            'the unconfigured status renders "repo: none configured"');
        checkDetail(unsetLine, 'unset');

        configured = fixture;
        const pending = service.status();
        check(pending.root === fixture && pending.loaded === false && pending.withheld === false
            && pending.name === null,
            'status() with a root configured but nothing packed reports the root and no pack, which'
            + ' is the state at launch before the first pack lands');
        const pendingLine = formatRepoStatus(pending);
        check(pendingLine.state === 'pending'
            && pendingLine.text === `repo: ${path.basename(fixture)} · no pack loaded yet`,
            'the not-yet-packed status names the repo and says no pack is loaded');
        checkDetail(pendingLine, 'pending');

        check(await service.refresh() === true, 'refresh() installs a pack for the configured root');
        const loaded = service.status();
        check(loaded.loaded === true && loaded.withheld === false && loaded.files > 0
            && loaded.estTokens > 0 && typeof loaded.packedAt === 'number'
            && loaded.name === path.basename(fixture),
            'status() after a successful refresh reports the pack it is serving');

        const loadedLine = formatRepoStatus(loaded);
        const tok = loaded.estTokens >= 1000
            ? `${(loaded.estTokens / 1000).toFixed(1)}k`
            : String(loaded.estTokens);
        const composed = `repo: ${path.basename(fixture)} · ${loaded.files}`
            + ` ${loaded.files === 1 ? 'file' : 'files'} · ~${tok} tok`;
        check(loadedLine.state === 'loaded' && loadedLine.text === composed,
            `the loaded status renders the pack's own counts: ${composed}`);
        check(new RegExp(`^repo: ${path.basename(fixture)} · \\d+ files? · ~[\\d.]+k? tok$`).test(loadedLine.text),
            'the loaded line holds to the name / count / tilde-estimate format');
        checkDetail(loadedLine, 'loaded');
        check(loadedLine.detail.startsWith(fixture) && loadedLine.detail.includes('omitted')
            && /packed \d{2}:\d{2}:\d{2}/.test(loadedLine.detail),
            'the loaded title names the root, the omitted count and the pack time');

        // A path that does not exist is a deliberate and sufficient choice: status() decides
        // withheld by comparing lastGood.root against the configured one and never stats either.
        configured = path.join(fixture, 'never-packed');
        const withheld = service.status();
        check(withheld.withheld === true && withheld.loaded === false
            && withheld.root === path.join(fixture, 'never-packed'),
            'status() reports the configured root, not the packed one, when the two disagree');
        check(service.promptBlock() === service.SENTINEL,
            'promptBlock() refuses to serve that pack, which is what withheld means');
        const withheldLine = formatRepoStatus(withheld);
        check(withheldLine.state === 'withheld'
            && withheldLine.text === 'repo: not in use · the pack is from a different folder',
            'the withheld status is worded as a problem, not as an empty setting');
        checkDetail(withheldLine, 'withheld');
    } finally {
        if (realStore) require.cache[storeId] = realStore;
        else delete require.cache[storeId];
        delete require.cache[serviceId];
    }
}

function checkFormatterDegrades() {
    for (const bad of [null, undefined, {}]) {
        const line = formatRepoStatus(bad);
        check(line.state === 'unset' && line.text === 'repo: none configured',
            `formatRepoStatus(${JSON.stringify(bad) || String(bad)}) degrades to the unconfigured line`);
    }

    const hostile = { root: '/tmp/x' };
    Object.defineProperty(hostile, 'loaded', { get() { throw new Error('boom'); } });
    const line = formatRepoStatus(hostile);
    check(line.state === 'unset' && line.text === 'repo: none configured',
        'a status object that throws on property access cannot take an Ask down');
}

function checkFormatterNumbers() {
    const cases = [
        [{ loaded: true, name: 'r', files: 3, estTokens: 999 }, 'repo: r · 3 files · ~999 tok'],
        [{ loaded: true, name: 'r', files: 3, estTokens: 1000 }, 'repo: r · 3 files · ~1.0k tok'],
        [{ loaded: true, name: 'r', files: 7, estTokens: 6800 }, 'repo: r · 7 files · ~6.8k tok'],
        [{ loaded: true, name: 'r', files: 7, estTokens: 20425 }, 'repo: r · 7 files · ~20.4k tok'],
        [{ loaded: true, name: 'r', files: 1, estTokens: 500 }, 'repo: r · 1 file · ~500 tok'],
    ];
    for (const [status, expected] of cases) {
        const line = formatRepoStatus(status);
        check(line.state === 'loaded' && line.text === expected, `renders "${expected}"`);
    }

    const fromRoot = formatRepoStatus({ loaded: true, root: '/a/b/agent-browser/', files: 7, estTokens: 6800 });
    check(fromRoot.text === 'repo: agent-browser · 7 files · ~6.8k tok',
        'a status with no name falls back to the root basename, trailing separator and all');
}

/**
 * A source-text check, standing in for the Electron round trip these assertions cannot make.
 * The channel name is a string repeated in two files and the preload method a third; a rename on
 * one side alone leaves the line permanently reading "none configured", which is the one failure
 * this whole feature exists to make visible, and nothing else here would notice.
 */
function checkChannelContract() {
    const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const bridge = read('src/bridge/featureBridge.js');
    const preload = read('src/preload.js');
    const view = read('src/ui/ask/AskView.js');

    check(bridge.includes(`ipcMain.handle('repoContext:getStatus'`),
        'featureBridge handles repoContext:getStatus, so the Electron-window path is wired');
    check(preload.includes(`ipcRenderer.invoke('repoContext:getStatus')`),
        'preload invokes the same channel name the bridge handles');
    // `\n {2}\}` is the askView namespace's own closing brace at preload.js's 2-space indent.
    // Reformatting that file breaks this assertion, and a regex cannot match braces any other way.
    check(/askView:\s*\{[\s\S]*?getRepoStatus[\s\S]*?\n {2}\}/.test(preload),
        'getRepoStatus is exposed inside the askView namespace, which is what the view reaches for');
    check(view.includes('window.api.askView.getRepoStatus()'),
        'the Ask view calls the method preload exposes');
}

async function main() {
    fixture = await buildFixture();
    await checkStatesThroughService();
    checkFormatterDegrades();
    checkFormatterNumbers();
    checkChannelContract();
}

function cleanup() {
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
}

main()
    .then(() => {
        cleanup();
        console.log('\nall assertions passed');
    })
    .catch(err => {
        cleanup();
        console.error(`\nFAILED: ${err.message}`);
        process.exit(1);
    });
