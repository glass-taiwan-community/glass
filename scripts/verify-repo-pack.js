#!/usr/bin/env node
/**
 * node scripts/verify-repo-pack.js
 *
 * Exits 0 only when every assertion holds. Bounds and file sets are asserted, never exact byte
 * counts: claude-mem rewrites files in these repos between runs and one measured drift was 90
 * bytes mid-session, so an exact-byte assertion is flaky by construction.
 *
 * The fixture lives in os.tmpdir() rather than the repo. It contains a `.env`, and this repo is
 * public, so a fixture inside the tree is one SIGINT away from being stageable.
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);

const PACK_MODULE = '../src/features/common/repoContext/repoPack';
const SERVICE_MODULE = '../src/features/common/repoContext/repoContextService';
const SETTINGS_MODULE = '../src/features/settings/settingsService';
const { buildRepoPack, DEFAULT_POLICY } = require(PACK_MODULE);

const TARGET_REPO = '/Users/yen/repo/deepgram-takehome';
const WORKTREE_ROOT = path.join(__dirname, '..');

// Measured in the finding for code-and-config content, against the policy's 2.5.
const MEASURED_BYTES_PER_TOKEN = 2.307;

const LONG_PROSE = [
    'docs/ARCHITECTURE.md',
    'docs/CONTRACT.md',
    'docs/NOTES.md',
    'docs/PREDICTIONS.md',
    'docs/production-design.md',
    'docs/diagrams/architecture.svg',
];

let fixture = null;

function check(ok, message) {
    assert.ok(ok, message);
    console.log(`ok   ${message}`);
}

async function checkThrows(fn, pattern, message) {
    let thrown = null;
    try {
        await fn();
    } catch (err) {
        thrown = err;
    }
    check(thrown !== null && pattern.test(thrown.message), message);
}

function reasonOf(pack, relPath) {
    return (pack.omitted.find(entry => entry.path === relPath) || {}).reason;
}

function isIncluded(pack, relPath) {
    return pack.files.some(file => file.path === relPath);
}

/**
 * Deliberately NOT repoPack's exported matchesSubpath. An expected set computed with the same
 * matcher the pack enumerated with moves whenever the matcher is wrong, so the comparison would
 * confirm itself; a raw-prefix regression was caught here only by a hard-coded count. This
 * predicate is the independent oracle, and every expected set below is built from it.
 */
function under(relPath, dir) {
    return relPath.startsWith(`${dir}/`);
}

function withoutTimestamps(text) {
    return text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<TS>');
}

async function gitPaths(root) {
    const { stdout } = await execFile('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 32 * 1024 * 1024 });
    return stdout.split('\0').filter(Boolean);
}

async function checkTargetRepo() {
    check(fs.existsSync(TARGET_REPO), `target repo ${TARGET_REPO} is present`);

    const expected = await gitPaths(TARGET_REPO);
    const pack = await buildRepoPack(TARGET_REPO);
    const accounted = new Set([...pack.files.map(f => f.path), ...pack.omitted.map(o => o.path)]);

    const missing = expected.filter(p => !accounted.has(p));
    check(missing.length === 0, `every one of git's ${expected.length} paths is in files or omitted`
        + `${missing.length ? ` (missing ${missing.join(', ')})` : ''}`);
    check(pack.files.length + pack.omitted.length === expected.length,
        `partition is exact: ${pack.files.length} packed + ${pack.omitted.length} omitted === ${expected.length}`);

    check(reasonOf(pack, 'executive-summary.pdf') === 'binary',
        'executive-summary.pdf is omitted as binary, which a NUL-only sniff would miss');
    check(reasonOf(pack, 'docs/diagrams/architecture.png') === 'binary',
        'docs/diagrams/architecture.png is omitted as binary');

    check(isIncluded(pack, 'slice/platform/admission-policy.yaml'),
        'slice/platform/admission-policy.yaml is included');
    check(isIncluded(pack, 'slice/verify.sh'), 'slice/verify.sh is included');
    check(!pack.omitted.some(entry => entry.reason === 'sensitive'),
        'no file in the target repo trips the secret denylist or the markers');

    check(pack.estTokens <= DEFAULT_POLICY.budgetTokens,
        `estTokens ${pack.estTokens} is within the ${DEFAULT_POLICY.budgetTokens} budget`
        + ` (${pack.sourceBytes} B over ${pack.files.length} files)`);

    const renderedBytes = Buffer.byteLength(pack.text);
    const renderedTokens = Math.round(renderedBytes / DEFAULT_POLICY.bytesPerToken);
    check(renderedTokens <= DEFAULT_POLICY.budgetTokens,
        `the rendered block is ${renderedTokens} tokens, within budget, though estTokens counts`
        + ` source bytes only and the manifest and headers add ${renderedBytes - pack.sourceBytes}`
        + ' unbudgeted B');

    for (const doc of LONG_PROSE) {
        check(reasonOf(pack, doc) === 'over-budget', `${doc} is reported over-budget, not silently absent`);
    }

    check(pack.text.includes('=== manifest ===') && pack.text.includes('do not claim knowledge'),
        'the manifest and the not-included list are inside the pack text');

    const again = await buildRepoPack(TARGET_REPO);
    check(withoutTimestamps(pack.text) === withoutTimestamps(again.text),
        'two consecutive builds produce identical text apart from builtAt');

    const unset = await buildRepoPack(TARGET_REPO, { subpaths: [] });
    check(withoutTimestamps(unset.text) === withoutTimestamps(pack.text)
        && unset.files.length === pack.files.length,
        'an empty subpaths list reproduces the unrestricted pack, rendered text and file set');
    const atRoot = await buildRepoPack(TARGET_REPO, { subpaths: ['.'] });
    check(withoutTimestamps(atRoot.text) === withoutTimestamps(pack.text),
        "a subpath spelled '.' normalizes to the root and selects the whole repository");

    const slice = await buildRepoPack(TARGET_REPO, { subpaths: ['slice'] });
    const expectedSlice = expected.filter(relPath => under(relPath, 'slice'));
    const sliceAccounted = [...slice.files.map(f => f.path), ...slice.omitted.map(o => o.path)];
    check(expectedSlice.length > 1 && sliceAccounted.length === expectedSlice.length
        && expectedSlice.every(relPath => sliceAccounted.includes(relPath)),
        `subpaths ['slice'] partitions exactly git's ${expectedSlice.length} paths under slice/`);
    check(!sliceAccounted.includes('README.md'),
        'README.md is outside the selection and absent from the pack entirely, not even omitted');

    const dotSlice = await buildRepoPack(TARGET_REPO, { subpaths: ['./slice'] });
    check(withoutTimestamps(dotSlice.text) === withoutTimestamps(slice.text),
        "a subpath spelled './slice' selects what 'slice' selects");

    check(slice.text.includes('=== restricted to: slice ===')
        && slice.text.includes('The rest of this repository is not in context'),
        'the restricted pack names the restriction inside the prompt, where the model reads it');
    check(!pack.text.includes('restricted to:') && !atRoot.text.includes('restricted to:'),
        'an unrestricted pack claims no restriction, and nor does one whose subpath is the root');

    console.log(`\ninfo at the finding's measured ${MEASURED_BYTES_PER_TOKEN} B/token for`
        + ` code-and-config content, the ${pack.sourceBytes} source B are`
        + ` ${Math.round(pack.sourceBytes / MEASURED_BYTES_PER_TOKEN)} tokens and the`
        + ` ${renderedBytes} rendered B are ${Math.round(renderedBytes / MEASURED_BYTES_PER_TOKEN)},`
        + ` against estTokens ${pack.estTokens} at bytes/${DEFAULT_POLICY.bytesPerToken}\n`);
}

async function buildFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-repo-pack-'));
    await execFile('git', ['-C', root, 'init', '--quiet']);

    fs.writeFileSync(path.join(root, '.gitignore'), 'hidden.yaml\n');
    fs.writeFileSync(path.join(root, 'a.yaml'), `# a\n${'a'.repeat(46)}`);
    fs.writeFileSync(path.join(root, 'b.yaml'), `# b\n${'b'.repeat(56)}`);
    fs.writeFileSync(path.join(root, 'c.yaml'), '# c\n123456');
    fs.writeFileSync(path.join(root, 'binary.png'), Buffer.concat([Buffer.from('\x89PNG', 'latin1'), Buffer.alloc(16)]));
    fs.writeFileSync(path.join(root, '.env'), 'EXAMPLE_KEY=not-a-real-value\n');
    fs.writeFileSync(path.join(root, 'key.txt'), '-----BEGIN RSA PRIVATE KEY-----\nnope\n');
    fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(200));
    fs.symlinkSync('./nothing-here', path.join(root, 'unreadable.txt'));
    fs.writeFileSync(path.join(root, 'hidden.yaml'), '# hidden\nvalue: 1\n');

    // `sublime/` exists only so a `sub` subpath has a prefix-sharing sibling it must not select.
    // All three sort after c.yaml, so the tight budget below still crosses at b.yaml and every
    // assertion written before subpaths existed holds unchanged.
    fs.mkdirSync(path.join(root, 'sub'));
    fs.mkdirSync(path.join(root, 'sublime'));
    fs.writeFileSync(path.join(root, 'sub', 'd.yaml'), `# d\n${'d'.repeat(20)}`);
    fs.writeFileSync(path.join(root, 'sub', 'notes.txt'), 'nested prose\n');
    fs.writeFileSync(path.join(root, 'sublime', 'e.yaml'), `# e\n${'e'.repeat(20)}`);

    await execFile('git', ['-C', root, 'add', '-A']);
    fs.mkdirSync(path.join(root, 'no-git-here'));
    return root;
}

async function checkFixture() {
    const expected = await gitPaths(fixture);
    const tight = { budgetTokens: 40, maxFileBytes: 64 };
    const pack = await buildRepoPack(fixture, { policy: tight });

    check(pack.files.length + pack.omitted.length === expected.length,
        `fixture partition is exact over ${expected.length} paths`);
    check(isIncluded(pack, 'a.yaml'), 'fixture a.yaml is included, so the budget pass admits before it stops');

    const cases = {
        'b.yaml': 'over-budget',
        'c.yaml': 'over-budget',
        'binary.png': 'binary',
        '.env': 'sensitive',
        'key.txt': 'sensitive',
        'large.txt': 'too-large',
        'unreadable.txt': 'unreadable',
    };
    for (const [relPath, reason] of Object.entries(cases)) {
        check(reasonOf(pack, relPath) === reason, `fixture ${relPath} is omitted as ${reason}`);
    }
    const budgetBytes = tight.budgetTokens * DEFAULT_POLICY.bytesPerToken;
    const cBytes = pack.omitted.find(entry => entry.path === 'c.yaml').bytes;
    check(reasonOf(pack, 'c.yaml') === 'over-budget' && pack.sourceBytes + cBytes <= budgetBytes,
        'c.yaml is over-budget although it would still fit, proving the hard stop is not a cherry-pick');

    const produced = new Set(pack.omitted.map(o => o.reason));
    for (const reason of ['binary', 'too-large', 'over-budget', 'unreadable', 'sensitive']) {
        check(produced.has(reason), `OmitReason '${reason}' is produced by the real code path`);
    }

    const capped = await buildRepoPack(fixture, { policy: { ...tight, maxOmittedListed: 2 } });
    const tail = `... and ${capped.omitted.length - 2} more`;
    const manifest = capped.text.split('\n').filter(line => line.startsWith('OMITTED'));
    check(manifest.length === 3 && manifest[2] === `OMITTED  ${tail}`,
        `the manifest lists 2 omissions then "${tail}"`);
    check(capped.text.split('\n').filter(line => line === tail).length === 1,
        'the not-included section is capped the same way');

    const optIn = await buildRepoPack(fixture, { includePaths: ['./hidden.yaml'], policy: { maxFileBytes: 64 } });
    check(isIncluded(optIn, 'hidden.yaml'),
        'an opt-in path .gitignore hides is included, normalized from its ./ spelling');
    check(optIn.files.length + optIn.omitted.length === expected.length + 1,
        'the opt-in path adds exactly one entry to the partition');

    const duplicate = await buildRepoPack(fixture, { includePaths: ['./a.yaml'], policy: tight });
    check(duplicate.files.filter(file => file.path === 'a.yaml').length === 1
        && duplicate.files.length + duplicate.omitted.length === expected.length,
        'an opt-in path that git already reports is deduped, not packed and budgeted twice');

    await checkThrows(() => buildRepoPack(fixture, { includePaths: ['../escape.txt'] }),
        /resolves outside/, 'an opt-in path resolving outside the root is refused');
    await checkThrows(() => buildRepoPack(path.join(fixture, 'no-git-here')),
        /no \.git entry/, 'an existing directory with no .git entry is refused');

    const subOnly = await buildRepoPack(fixture, { subpaths: ['sub'] });
    const expectedSub = expected.filter(relPath => under(relPath, 'sub'));
    const subAccounted = [...subOnly.files.map(f => f.path), ...subOnly.omitted.map(o => o.path)];
    check(expectedSub.length === 2 && subAccounted.length === 2
        && expectedSub.every(relPath => subAccounted.includes(relPath)),
        `fixture subpaths ['sub'] partitions exactly ${expectedSub.join(' and ')}`);
    check(!subAccounted.some(relPath => relPath.startsWith('sublime/')),
        "'sub' leaves sublime/e.yaml out, so the match is segment-aware and not a raw prefix");

    const subFile = await buildRepoPack(fixture, { subpaths: ['sub/d.yaml'] });
    check(subFile.files.length + subFile.omitted.length === 1 && isIncluded(subFile, 'sub/d.yaml'),
        'a subpath naming one file selects that file and nothing else');

    const subPlusOptIn = await buildRepoPack(fixture, { subpaths: ['sub'], includePaths: ['./hidden.yaml'] });
    check(isIncluded(subPlusOptIn, 'hidden.yaml') && isIncluded(subPlusOptIn, 'sub/d.yaml')
        && !subPlusOptIn.files.some(file => file.path === 'a.yaml'),
        'an opt-in path outside the subpaths is still added, and the restriction still holds otherwise');

    const partial = await buildRepoPack(fixture, { subpaths: ['sub', 'no-such-dir'] });
    check(isIncluded(partial, 'sub/d.yaml'),
        'one mistyped subpath among two still yields a pack: silence mid-interview is the worse failure');

    await checkThrows(() => buildRepoPack(fixture, { subpaths: ['../escape'] }),
        /subpath \.\.\/escape resolves outside/, 'a subpath resolving outside the root is refused');
    await checkThrows(() => buildRepoPack(fixture, { subpaths: ['no-such-dir'] }),
        /no tracked file is under any of the subpaths no-such-dir/,
        'a selection resolving to zero files is refused, and the message names the subpath');

    const dotGit = fs.statSync(path.join(WORKTREE_ROOT, '.git'));
    const own = await buildRepoPack(WORKTREE_ROOT);
    check(own.files.length > 0,
        `this repo's own root is accepted with .git as a ${dotGit.isFile() ? 'file, so worktrees work' : 'directory'}`);
}

/**
 * The real-world restriction case, and the reason subpaths exist. Unrestricted, this repo packs 11
 * files and none of src/, because functions/package-lock.json at 286,977 B sorts into the
 * code-and-config band and trips the hard budget stop (finding-ttft-vs-prompt-size.md, "Known
 * limits of unit 1"). WORKTREE_ROOT is a worktree, so this reads whatever its index holds rather
 * than assuming the main checkout's file set; the first assertion states what it found.
 */
async function checkGlassSubpath() {
    const tracked = await gitPaths(WORKTREE_ROOT);
    const listenPaths = tracked.filter(relPath => under(relPath, 'src/features/listen'));
    check(listenPaths.length > 0 && tracked.includes('functions/package-lock.json'),
        `this worktree's index holds ${listenPaths.length} paths under src/features/listen/ out of`
        + ` ${tracked.length}, and the lockfile the restriction exists to get away from`);

    const pack = await buildRepoPack(WORKTREE_ROOT, { subpaths: ['src/features/listen'] });
    const outside = pack.files.filter(file => !file.path.startsWith('src/features/listen/'));
    check(pack.files.length > 0 && outside.length === 0,
        `restricting glass to src/features/listen packs ${pack.files.length} files,`
        + ` ${pack.sourceBytes} B, ~${pack.estTokens} tokens, and nothing outside it`
        + `${outside.length ? ` (${outside.map(file => file.path).join(', ')})` : ''}`);
    check(!pack.files.concat(pack.omitted).some(entry => entry.path === 'functions/package-lock.json'),
        'functions/package-lock.json is not in the restricted pack at all, not even as an omission');

    const whole = await buildRepoPack(WORKTREE_ROOT);
    check(!whole.files.some(file => file.path.startsWith('src/')),
        `unrestricted, the same repo packs ${whole.files.length} files and none of src/, with`
        + ` ${whole.omitted.filter(entry => entry.reason === 'over-budget').length} over-budget`);
}

/**
 * The sizer's only machine-readable contract is its exit code, and the asymmetry in it is the part
 * worth protecting: an over-budget selection is a usable answer and exits 0, while a subpath
 * matching nothing is a configuration error and exits 1 even when another subpath matched, which
 * buildRepoPack itself deliberately does not do.
 */
async function checkSizer() {
    const sizer = path.join(__dirname, 'size-repo-pack.js');
    const big = { maxBuffer: 8 * 1024 * 1024 };

    const fits = await execFile('node', [sizer, fixture], big);
    check(/\npacked   \d+ files/.test(fits.stdout) && fits.stdout.includes('no file was dropped'),
        'the sizer reports what would be packed, and exits 0 when everything fits');

    const over = await execFile('node', [sizer, TARGET_REPO], big);
    check(/\nstopped  docs\//.test(over.stdout) && /\nunused   [\d,]+ B/.test(over.stdout)
        && over.stdout.includes('directories that fit'),
        'an over-budget selection exits 0, names the file that tripped the hard stop, and suggests subpaths');

    let refused = null;
    try {
        await execFile('node', [sizer, fixture, 'sub', 'no-such-dir'], big);
    } catch (err) {
        refused = err;
    }
    check(refused !== null && refused.code === 1 && /match no tracked file/.test(refused.stderr),
        'one unmatched subpath among two exits 1, stricter than the library, because this runs at configuration time');
}

function checkServiceSentinel() {
    const service = require(SERVICE_MODULE);
    const block = service.promptBlock();
    check(block === service.SENTINEL && block.length > 0,
        'promptBlock() returns the non-empty sentinel headless with no pack loaded');
}

/**
 * The service's hardest invariants are root tagging and single-flight, and neither is reachable
 * through the real settings file.
 */
async function checkServiceRootHandling() {
    const storeId = require.resolve('electron-store');
    const serviceId = require.resolve(SERVICE_MODULE);
    const realStore = require.cache[storeId];
    let configured = null;
    let configuredSubpaths = [];

    require.cache[storeId] = {
        id: storeId,
        filename: storeId,
        loaded: true,
        exports: class {
            get(key) {
                if (key === 'repoContextRootPath') return configured;
                if (key === 'repoContextSubpaths') return configuredSubpaths;
                return undefined;
            }
        },
    };
    delete require.cache[serviceId];

    try {
        const service = require(SERVICE_MODULE);

        configured = fixture;
        check(await service.refresh() === true, 'refresh() installs a pack for the configured root');
        check(service.promptBlock().includes(`=== repo: ${path.basename(fixture)} @`),
            'promptBlock() serves the pack built from that root');

        configured = '/no/such/repo';
        check(service.promptBlock() === service.SENTINEL,
            'promptBlock() refuses a pack whose root is not the configured one');

        configured = fixture;
        check(service.promptBlock().includes('=== repo: '),
            'the refused pack was not destroyed, only withheld');

        const first = service.refresh();
        check(service.refresh() === first, 'concurrent refresh() callers share one in-flight promise');
        await first;

        configured = WORKTREE_ROOT;
        const forWorktree = service.refresh();
        configured = fixture;
        // Awaited below rather than discarded: the subpaths case after it must not join an
        // in-flight build started while the setting still read as unrestricted.
        const afterChange = service.refresh();
        check(afterChange !== forWorktree,
            'a refresh() after a root change does not join the build for the root the user left');
        check(await forWorktree === false,
            'a build whose root changed underneath it is discarded rather than installed');
        check(service.promptBlock().includes(`=== repo: ${path.basename(fixture)} @`),
            'the working pack for the configured root survives that discard');
        await afterChange;

        configuredSubpaths = ['sub'];
        check(await service.refresh() === true, 'refresh() installs a pack with subpaths configured');
        const restricted = service.promptBlock();
        check(restricted.includes('=== restricted to: sub ===') && restricted.includes('sub/d.yaml')
            && !restricted.split('\n').some(line => line.endsWith(' a.yaml')),
            'the repoContextSubpaths setting reaches buildRepoPack and restricts the served pack');

        // A bare string is the plausible hand-edit. buildRepoPack would throw on it and build()
        // would catch, leaving the sentinel, so the coercion is what keeps a typo from reading as
        // "no repository configured" at the moment the user needs an answer.
        configuredSubpaths = 'sub';
        check(await service.refresh() === true,
            'a malformed repoContextSubpaths still produces a pack rather than the sentinel');
        const coerced = service.promptBlock();
        check(!coerced.includes('=== restricted to:') && coerced.includes('a.yaml'),
            'a malformed repoContextSubpaths reads as not configured, so the whole repository packs');
    } finally {
        if (realStore) require.cache[storeId] = realStore;
        else delete require.cache[storeId];
        delete require.cache[serviceId];
    }
}

/**
 * settingsService.js requires electron, authService, windowManager and modelStateService at load.
 * All of them survive a headless require under node 18 (electron's npm package exports a path
 * string, not the runtime), so the getter is reachable here; only electron-store has to be faked,
 * because the real one would read the developer's own live settings file and this assertion is
 * about what a malformed value does.
 */
async function checkSettingsGetter() {
    const storeId = require.resolve('electron-store');
    const realStore = require.cache[storeId];
    let stored;

    require.cache[storeId] = {
        id: storeId,
        filename: storeId,
        loaded: true,
        exports: class { get(key) { return key === 'repoContextSubpaths' ? stored : undefined; } },
    };

    try {
        const settingsService = require(SETTINGS_MODULE);

        stored = ['src/features/listen', '  src/ui  '];
        const well = await settingsService.getRepoContextSubpaths();
        check(well.length === 2 && well[0] === 'src/features/listen' && well[1] === 'src/ui',
            'getRepoContextSubpaths returns the stored array, trimmed');

        for (const bad of [undefined, null, 'src', 42, { '0': 'src' }, ['src', 7], ['src', '']]) {
            stored = bad;
            const read = await settingsService.getRepoContextSubpaths();
            check(Array.isArray(read) && read.length === 0,
                `getRepoContextSubpaths reads ${JSON.stringify(bad) || String(bad)} as not configured`);
        }
    } finally {
        if (realStore) require.cache[storeId] = realStore;
        else delete require.cache[storeId];
    }
}

async function main() {
    await checkTargetRepo();
    fixture = await buildFixture();
    await checkFixture();
    await checkGlassSubpath();
    await checkSizer();
    checkServiceSentinel();
    await checkServiceRootHandling();
    await checkSettingsGetter();
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
