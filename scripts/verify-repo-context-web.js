#!/usr/bin/env node
/**
 * node scripts/verify-repo-context-web.js
 *
 * Exits 0 only when every assertion holds. Covers the repo-context settings page in the web GUI:
 * the validation in src/features/common/repoContext/applySettings.js, and the two string seams
 * between the Express route and the Electron main process that no compiler or linter checks.
 *
 * Why the seams get their own group. The route names a channel ('get-repo-context') that reaches
 * src/index.js's switch as a literal `case` label, and utils/api.ts names a mount path that
 * reaches backend_node/index.js as a literal `app.use` argument. A typo in either is an HTTP 500
 * at runtime and nothing else in the repo notices. So both sides are EXTRACTED FROM THE SOURCE
 * TEXT here rather than pasted in as strings, which would only prove this file agrees with itself.
 *
 * Why the validation gets driven for real. src/index.js requires electron, better-sqlite3 and the
 * window manager at module load, so the switch cannot be loaded under plain node at all. The rules
 * live in applySettings.js precisely so this file can require them, hand them a fake store and
 * real temporary git repositories, and read the refusal strings a user would see. Every refusal
 * case runs through one helper that also proves the store was left untouched, so a case added later
 * cannot forget that check.
 *
 * `git ls-files` reads the index, so the temporary repositories are `git init` plus `git add` with
 * no commit: no commit means no user.email requirement and no second-long setup per case.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const express = require('express');

const { applySettings } = require('../src/features/common/repoContext/applySettings');
const { KEYS } = require('../src/features/common/repoContext/config');
const { DEFAULT_POLICY } = require('../src/features/common/repoContext/repoPack');
const repoContextRoute = require('../pickleglass_web/backend_node/routes/repoContext');

const REPO_ROOT = path.join(__dirname, '..');

const APPLY_SETTINGS = 'src/features/common/repoContext/applySettings.js';
const SERVICE = 'src/features/common/repoContext/repoContextService.js';
const ROUTE = 'pickleglass_web/backend_node/routes/repoContext.js';
const BACKEND_INDEX = 'pickleglass_web/backend_node/index.js';
const MAIN = 'src/index.js';
const API = 'pickleglass_web/utils/api.ts';
const PAGE = 'pickleglass_web/app/repo-context/page.tsx';

const EXPECTED_CHANNELS = 2;
const API_HELPERS = ['getRepoContext', 'saveRepoContext'];

const UNRELATED_KEY = 'contentProtection';
const UNRELATED_VALUE = true;

const scratch = [];

function check(ok, message) {
    assert.ok(ok, message);
    console.log(`ok   ${message}`);
}

function read(relPath) {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function run(file, args) {
    execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function fakeStore(seed = {}) {
    const map = new Map(Object.entries(seed));
    const store = {
        get: key => map.get(key),
        set: (key, value) => { map.set(key, value); },
        delete: key => { map.delete(key); },
    };
    return { store, map };
}

function snapshot(map) {
    const entries = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return JSON.stringify(entries);
}

function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-repo-context-web-'));
    scratch.push(dir);
    return dir;
}

function writeTree(dir, files) {
    for (const [relPath, body] of Object.entries(files)) {
        const absolute = path.join(dir, relPath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, body);
    }
}

/**
 * @param {Record<string, string>} files every path written into the tree
 * @param {string[]} [tracked] the subset handed to `git add`, defaulting to all of them. Paths are
 *   listed explicitly rather than staged with `.` or `-A` so the command can only ever touch the
 *   files this function just wrote.
 */
function gitRepo(files, tracked) {
    const dir = tempDir();
    writeTree(dir, files);
    run('git', ['-C', dir, 'init', '-q']);
    run('git', ['-C', dir, 'add', '--', ...(tracked || Object.keys(files))]);
    return dir;
}

async function checkRefusal(label, payload, expectations) {
    const { store, map } = fakeStore({ [UNRELATED_KEY]: UNRELATED_VALUE });
    const before = snapshot(map);
    const result = await applySettings(store, payload);

    check(result.ok === false && typeof result.reason === 'string' && result.reason !== '',
        `${label} refuses with a reason string rather than throwing`);
    for (const needle of expectations) {
        check(result.reason.includes(needle),
            `${label} names "${needle}" in its reason, which is what the user has to act on`);
    }
    check(snapshot(map) === before, `${label} left the store completely unmodified`);
    return result;
}

async function checkPayloadShapeRefusals() {
    await checkRefusal('a string payload where an object belongs', 'root=/tmp', ['string']);
    await checkRefusal('a null payload', null, ['null']);
    await checkRefusal('an array payload', ['/tmp'], ['an array']);
    await checkRefusal('a non-string root', { root: 42 }, [KEYS.root, 'number']);
    await checkRefusal('a payload with no root at all', { subpaths: ['src'] },
        [KEYS.root, 'required']);
    await checkRefusal('subpaths given as a bare string', { root: '/tmp', subpaths: 'src' },
        [KEYS.subpaths]);
    await checkRefusal('includePaths given as a bare string', { root: '/tmp', includePaths: '.env' },
        [KEYS.includePaths]);
    await checkRefusal('subpaths holding an empty string', { root: '/tmp', subpaths: ['src', ''] },
        [KEYS.subpaths, 'non-empty']);
    await checkRefusal('includePaths holding a blank string', { root: '/tmp', includePaths: ['  '] },
        [KEYS.includePaths, 'non-empty']);
}

/**
 * The regression the two cases above exist for, asserted against a store that already holds a
 * working configuration rather than only the unrelated key. An omitted root used to read as "turn it
 * off", so a body setting just `subpaths` answered ok and deleted all three keys. checkRefusal's own
 * store starts unconfigured, where deleting three absent keys is invisible.
 */
async function checkRootIsRequiredToClearAnything() {
    const configured = {
        [UNRELATED_KEY]: UNRELATED_VALUE,
        [KEYS.root]: '/some/configured/repo',
        [KEYS.subpaths]: ['lib'],
    };
    for (const [label, payload] of [
        ['a payload with no root', { subpaths: ['src'] }],
        ['an array payload', ['/tmp']],
    ]) {
        const { store, map } = fakeStore(configured);
        const before = snapshot(map);
        const result = await applySettings(store, payload);
        check(result.ok === false && snapshot(map) === before,
            `${label} refuses against an already-configured store and leaves the configured root and`
            + ' subpaths exactly as they were, rather than silently turning the pack off');
    }
}

async function checkRootRefusals() {
    await checkRefusal('a relative root', { root: 'some/repo' },
        ['is not an absolute path', 'some/repo']);

    const absent = path.join(tempDir(), 'no-such-directory');
    await checkRefusal('a root that does not exist', { root: absent }, [absent, 'does not exist']);

    const file = path.join(tempDir(), 'a-file.txt');
    fs.writeFileSync(file, 'not a directory\n');
    await checkRefusal('a root that is a file', { root: file }, [file, 'is not a directory']);

    const bare = tempDir();
    writeTree(bare, { 'a.js': 'module.exports = 1;\n' });
    await checkRefusal('a directory with no .git entry', { root: bare }, ['has no .git entry']);
}

async function checkSelectionRefusals() {
    const repo = gitRepo({ 'lib/a.js': 'a\n', 'src/b.js': 'b\n' });

    await checkRefusal('a subpath resolving outside the root',
        { root: repo, subpaths: ['../elsewhere'] }, ['resolves outside', repo]);

    // 'lib' is the matching spelling and 'src/nope-typo' the mistyped one. They share no prefix on
    // purpose, so asserting 'lib' is ABSENT from the reason proves the count is per subpath rather
    // than a blanket re-listing of everything that was given.
    const partial = await checkRefusal('one matching subpath alongside one that matches nothing',
        { root: repo, subpaths: ['lib', 'src/nope-typo'] }, ['src/nope-typo']);
    check(!partial.reason.includes('lib'),
        'the partial-match refusal names only the unmatched spelling, not the one that matched');

    await checkRefusal('every subpath matching nothing, which buildRepoPack itself refuses',
        { root: repo, subpaths: ['nope-one', 'nope-two'] },
        ['no tracked file is under any of the subpaths']);

    await checkRefusal('an opt-in include path that does not exist on disk',
        { root: repo, includePaths: ['secrets/missing.env'] }, ['secrets/missing.env']);
}

function persistenceRepo() {
    const files = { 'lib/a.js': 'a\n', 'src/b.js': 'b\n', 'extra/opt.txt': 'opt\n' };
    return gitRepo(files, ['lib/a.js', 'src/b.js']);
}

async function checkPersistence() {
    const repo = persistenceRepo();
    const payload = { root: repo, subpaths: ['lib'], includePaths: ['extra/opt.txt'] };

    const { store, map } = fakeStore({ [UNRELATED_KEY]: UNRELATED_VALUE });
    const first = await applySettings(store, payload);
    check(first.ok === true, 'a payload whose pack builds is accepted');

    const expected = [UNRELATED_KEY, ...Object.values(KEYS)].sort();
    check(JSON.stringify([...map.keys()].sort()) === JSON.stringify(expected),
        'a valid payload persists exactly the three repo-context keys and adds nothing else,'
        + ' against a key set derived from config.KEYS');
    check(map.get(KEYS.root) === repo, 'the persisted root is the trimmed path that was given');
    check(JSON.stringify(map.get(KEYS.subpaths)) === JSON.stringify(['lib'])
        && JSON.stringify(map.get(KEYS.includePaths)) === JSON.stringify(['extra/opt.txt']),
        'both persisted lists hold exactly the normalized entries that were given');
    check(map.get(UNRELATED_KEY) === UNRELATED_VALUE,
        'an unrelated key already in the store keeps its value through a successful save');

    const after = snapshot(map);
    const second = await applySettings(store, payload);
    check(second.ok === true && snapshot(map) === after,
        'applying the same valid payload twice leaves byte-identical store contents');

    check(first.pack && first.pack.root === repo && first.pack.files.length > 0
        && typeof first.pack.text === 'string',
        'an accepted payload returns the pack it built to validate the root, for the caller to'
        + ' install rather than build a second time');
    check(first.pack.files.some(file => file.path === 'extra/opt.txt')
        && first.pack.files.every(file => file.path === 'extra/opt.txt' || file.path.startsWith('lib/')),
        'the returned pack is the one built from this exact payload, both lists included, so'
        + ' installing it is not installing some earlier selection');
}

async function checkEmptyListsWriteNoKey() {
    const repo = persistenceRepo();
    const { store, map } = fakeStore({ [UNRELATED_KEY]: UNRELATED_VALUE });
    const result = await applySettings(store, { root: repo, subpaths: [], includePaths: [] });

    check(result.ok === true, 'a root with both lists empty is accepted');
    check(!map.has(KEYS.subpaths) && !map.has(KEYS.includePaths),
        'empty lists write no key at all, so nothing stale can be left behind for a later root');
    check(map.get(KEYS.root) === repo, 'the root is still persisted when both lists are empty');
}

async function checkTurnOff() {
    const seeded = {
        [UNRELATED_KEY]: UNRELATED_VALUE,
        [KEYS.root]: '/some/previous/repo',
        [KEYS.subpaths]: ['lib'],
        [KEYS.includePaths]: ['extra/opt.txt'],
    };
    for (const [label, root] of [['an empty root', ''], ['a whitespace-only root', '   ']]) {
        const { store, map } = fakeStore(seeded);
        const result = await applySettings(store, { root });
        check(result.ok === true && result.pack === undefined,
            `${label} is accepted as "turn it off" and returns no pack, so the caller installs`
            + ' nothing and reports refreshed:false');
        check(Object.values(KEYS).every(key => !map.has(key)),
            `${label} deletes all three repo-context keys`);
        check(map.get(UNRELATED_KEY) === UNRELATED_VALUE,
            `${label} leaves an unrelated key in the store untouched`);
    }
}

/**
 * The route over a real HTTP server, with a bridge that answers whatever the case is told to.
 * src/index.js cannot be loaded under plain node, so this stops at the bridge rather than reaching
 * the switch; what it buys is the part the page depends on and nothing else tests, namely that a
 * refusal arrives as a 400 still carrying its reason while a failed request stays a 500. Collapse
 * those two and saveRepoContext throws where it should have returned the reason, and the user is
 * told "the save failed" instead of which subpath was wrong.
 */
function routeServer(answer) {
    const bridge = new EventEmitter();
    bridge.on('web-data-request', (channel, responseChannel, payload) => {
        const reply = answer(channel, payload);
        bridge.emit(responseChannel, reply);
    });

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.bridge = bridge; next(); });
    app.use('/api/repo-context', repoContextRoute);
    return app;
}

function listen(app) {
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function post(server, body) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/repo-context`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

async function checkRouteStatusCodes() {
    const cases = [
        {
            label: 'a refusal from the case',
            answer: () => ({ success: true, data: { ok: false, reason: 'these subpaths match no tracked file: src/nope' } }),
            status: 400,
            assertBody: body => body.ok === false && body.reason.includes('src/nope'),
            detail: 'answers HTTP 400 and the reason survives the hop verbatim',
        },
        {
            label: 'an accepted save',
            answer: () => ({ success: true, data: { ok: true, refreshed: true, status: { files: 11 } } }),
            status: 200,
            assertBody: body => body.ok === true && body.refreshed === true && body.status.files === 11,
            detail: 'answers HTTP 200 and the status comes back whole',
        },
        {
            label: 'a request the main process failed',
            answer: () => ({ success: false, error: 'the handler threw' }),
            status: 500,
            assertBody: body => typeof body.error === 'string' && body.ok === undefined,
            detail: 'answers HTTP 500 with no ok field, so our defect cannot be read as the user\'s typo',
        },
    ];

    for (const testCase of cases) {
        const server = await listen(routeServer(testCase.answer));
        try {
            const response = await post(server, { root: '/tmp/anything' });
            check(response.status === testCase.status && testCase.assertBody(response.body),
                `${testCase.label} ${testCase.detail}`);
        } finally {
            server.close();
        }
    }

    const server = await listen(routeServer(() => ({ success: true,
        data: { root: null, loaded: false, budgetTokens: DEFAULT_POLICY.budgetTokens } })));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/repo-context`);
        const body = await res.json();
        check(res.status === 200 && body.loaded === false && body.budgetTokens === DEFAULT_POLICY.budgetTokens,
            'a GET answers HTTP 200 with the status object the page reads');
    } finally {
        server.close();
    }
}

/**
 * Source checks, and deliberately the only ones of their kind here. The `save-repo-context` case
 * body cannot be executed by anything -- src/index.js requires electron at module load -- so the
 * properties below are asserted against the text rather than left unchecked.
 */
function checkSaveCaseDelegates() {
    const source = read(MAIN);
    const start = source.indexOf("case 'save-repo-context': {");
    check(start !== -1, `${MAIN} has a braced save-repo-context case`);
    const body = source.slice(start, source.indexOf('\n                case ', start + 1) === -1
        ? source.indexOf('default:', start)
        : source.indexOf('\n                case ', start + 1));

    check(/await\s+repoContextService\.save\(/.test(body),
        'the save-repo-context case awaits repoContextService.save, so a refusal cannot be a pending'
        + ' promise read as a truthy ok');
    check(/refreshed:\s*saved\.refreshed/.test(body),
        'the save-repo-context case passes the service\'s own refreshed flag to the page rather than'
        + ' reporting a success the install never reached');
    check(body.includes('DEFAULT_POLICY.budgetTokens'),
        'the save-repo-context case reports the budget from DEFAULT_POLICY rather than a second copy'
        + ' of the number');
}

/**
 * repoContextService.js already owns a Store over pickle-glass-settings.json and settingsService.js
 * owns a second, and three objects owning one file is one more than the file can be reasoned about
 * with.
 */
function checkMainConstructsNoStore() {
    const main = read(MAIN);
    const service = read(SERVICE);
    const requiresStore = /require\(\s*'electron-store'\s*\)/;
    const constructsStore = /new\s+Store\s*\(/;

    check(requiresStore.test(service) && constructsStore.test(service),
        `${SERVICE} is the module that requires electron-store and constructs the Store, which is`
        + ' what makes the two assertions below non-vacuous');
    check(!requiresStore.test(main) && !constructsStore.test(main),
        `${MAIN} neither requires electron-store nor constructs a Store, so that settings file keeps`
        + ' the two owners it already has');
    check(!main.includes('repoContext/applySettings'),
        `${MAIN} does not reach applySettings directly, so repoContextService.save is the only path`
        + ' by which these settings are written');
}

function matchAll(source, pattern) {
    return [...new Set([...source.matchAll(pattern)].map(match => match[1]))];
}

function checkChannelNames() {
    const channels = matchAll(read(ROUTE), /ipcRequest\(\s*req\s*,\s*'([^']+)'/g);
    const labels = matchAll(read(MAIN), /case\s+'([^']+)'\s*:/g);

    check(channels.length === EXPECTED_CHANNELS,
        `${ROUTE} passes ipcRequest ${EXPECTED_CHANNELS} distinct channel names`
        + ` (${channels.join(', ')}), so the subset check below cannot pass vacuously`);
    check(labels.length > EXPECTED_CHANNELS,
        `${MAIN} contributes ${labels.length} case labels to compare against`);
    for (const channel of channels) {
        check(labels.includes(channel),
            `the channel ${channel} that ${ROUTE} sends has a matching case label in ${MAIN}`);
    }
}

/**
 * @returns {string} the path the route is mounted at, read from the mount line rather than assumed,
 *   so the api.ts check compares against what the server actually serves.
 */
function mountPath() {
    const [mounted] = matchAll(read(BACKEND_INDEX),
        /app\.use\(\s*'([^']+)'\s*,\s*require\('\.\/routes\/repoContext'\)\s*\)/g);
    check(typeof mounted === 'string' && mounted.startsWith('/api/'),
        `${BACKEND_INDEX} mounts ./routes/repoContext under an /api path (${mounted})`);
    return mounted;
}

/**
 * One helper's own text, sliced out by name. Scanning the whole of api.ts instead would let an
 * apiCall in any of its forty other helpers stand in for one of these two.
 */
function helperBody(source, name) {
    const start = source.indexOf(`export const ${name} =`);
    assert.ok(start !== -1, `${API} exports a helper named ${name}`);
    const end = source.indexOf('\nexport ', start + 1);
    return source.slice(start, end === -1 ? source.length : end);
}

function checkApiHelperPaths(mounted) {
    const source = read(API);
    for (const name of API_HELPERS) {
        const paths = matchAll(helperBody(source, name), /apiCall\(\s*[`']([^`']+)[`']/g);
        check(paths.length > 0, `${name} in ${API} calls apiCall with at least one path literal`);
        for (const called of paths) {
            check(called.startsWith(mounted),
                `${name} calls ${called}, which is under the ${mounted} the server mounts the route at`);
        }
    }
}

function checkNoHardcodedBudget(relPaths) {
    for (const relPath of relPaths) {
        check(!read(relPath).includes('20000'),
            `${relPath} contains no hardcoded 20000, so the budget can only come from`
            + ' DEFAULT_POLICY.budgetTokens');
    }
}

function checkFilesExist(relPaths) {
    for (const relPath of relPaths) {
        check(fs.existsSync(path.join(REPO_ROOT, relPath)), `${relPath} exists`);
    }
}

async function main() {
    await checkPayloadShapeRefusals();
    await checkRootIsRequiredToClearAnything();
    await checkRootRefusals();
    await checkSelectionRefusals();
    await checkPersistence();
    await checkEmptyListsWriteNoKey();
    await checkTurnOff();

    await checkRouteStatusCodes();

    checkFilesExist([APPLY_SETTINGS, SERVICE, ROUTE, PAGE]);
    checkNoHardcodedBudget([APPLY_SETTINGS, ROUTE, PAGE]);
    checkSaveCaseDelegates();
    checkMainConstructsNoStore();
    checkChannelNames();
    checkApiHelperPaths(mountPath());
}

function cleanup() {
    for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
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
