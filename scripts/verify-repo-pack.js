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
const APPLY_MODULE = '../src/features/common/repoContext/applySettings';
const SETTINGS_MODULE = '../src/features/settings/settingsService';
const CONFIG_MODULE = '../src/features/common/repoContext/config';
const { buildRepoPack, DEFAULT_POLICY } = require(PACK_MODULE);
const { KEYS, appSettingsPath } = require(CONFIG_MODULE);

const CLI = path.join(__dirname, 'repo-context.js');

// Not hardcoded, for two reasons. This fork is public, so a path naming a specific take-home
// would publish which company's exercise it was. And a hardcoded absolute path makes these
// assertions unrunnable by anyone else and by CI. Point it at any git repo:
//   REPO_PACK_TARGET=/path/to/repo node scripts/verify-repo-pack.js
// Unset, the target-repo assertions are skipped and everything else still runs.
const TARGET_REPO = process.env.REPO_PACK_TARGET || null;
const WORKTREE_ROOT = path.join(__dirname, '..');

// Measured in the finding for code-and-config content, against the policy's 2.5.
const MEASURED_BYTES_PER_TOKEN = 2.307;

// Any file the target repo reports `over-budget`. Derived from the pack rather than listed by
// name: the old list was six filenames from one specific repo, which both pinned these assertions
// to that repo and named it.
const overBudget = pack => pack.omitted.filter(o => o.reason === 'over-budget').map(o => o.path);

let fixture = null;
const cliHomes = [];

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
    if (!TARGET_REPO) {
        console.log('skip target-repo assertions: set REPO_PACK_TARGET to a git repo to run them');
        return;
    }
    check(fs.existsSync(TARGET_REPO), `target repo ${TARGET_REPO} is present`);

    const expected = await gitPaths(TARGET_REPO);
    const pack = await buildRepoPack(TARGET_REPO);
    const accounted = new Set([...pack.files.map(f => f.path), ...pack.omitted.map(o => o.path)]);

    const missing = expected.filter(p => !accounted.has(p));
    check(missing.length === 0, `every one of git's ${expected.length} paths is in files or omitted`
        + `${missing.length ? ` (missing ${missing.join(', ')})` : ''}`);
    check(pack.files.length + pack.omitted.length === expected.length,
        `partition is exact: ${pack.files.length} packed + ${pack.omitted.length} omitted === ${expected.length}`);

    // Properties, not filenames. The old version named four files from one specific repo, which
    // pinned these assertions to it. The magic-byte case now lives in the fixture, where a
    // NUL-free PDF can be constructed rather than depended on.
    const binaries = pack.omitted.filter(o => o.reason === 'binary');
    check(binaries.every(o => !isIncluded(pack, o.path)),
        `all ${binaries.length} binary omissions stayed out of the packed set`);
    check(pack.files.length > 0 && pack.files.every(f => typeof f.text === 'string' && f.text.length > 0),
        `all ${pack.files.length} packed files carry their whole text`);
    // Not "none exist": glass trips five, four of them known false positives on provider source.
    // The property is that a suspected secret is withheld and *named*, never silently packed.
    const sensitive = pack.omitted.filter(entry => entry.reason === 'sensitive');
    check(sensitive.every(entry => !isIncluded(pack, entry.path)),
        `all ${sensitive.length} suspected-secret files are withheld from the packed set`);
    // Naming is bounded by the manifest cap, which exists so 224 omissions do not bury the files.
    // The invariant is that the count is always stated even when the paths are not.
    check(!pack.omitted.length || /OMITTED  \.\.\. and \d+ more/.test(pack.text)
        || pack.omitted.every(entry => pack.text.includes(entry.path)),
        `${pack.omitted.length} omissions are either all named or summarised with a count`);

    check(pack.estTokens <= DEFAULT_POLICY.budgetTokens,
        `estTokens ${pack.estTokens} is within the ${DEFAULT_POLICY.budgetTokens} budget`
        + ` (${pack.sourceBytes} B over ${pack.files.length} files)`);

    const renderedBytes = Buffer.byteLength(pack.text);
    // The budget is spent on source bytes, so the manifest and headers are unbudgeted and the
    // rendered block can exceed it. Measured on one real target: 20,424 real tokens against a
    // 20,000 budget. That is a known accounting gap, not a failure, so state it rather than assert
    // it away. What must hold is that the budget governed the files it claims to govern.
    const renderedTokens = Math.round(renderedBytes / DEFAULT_POLICY.bytesPerToken);
    console.log(`info rendered block ${renderedTokens} est tokens against a`
        + ` ${DEFAULT_POLICY.budgetTokens} budget; manifest and headers add`
        + ` ${renderedBytes - pack.sourceBytes} unbudgeted B`);
    check(pack.estTokens <= DEFAULT_POLICY.budgetTokens,
        `the budgeted source is ${pack.estTokens} est tokens, inside the ${DEFAULT_POLICY.budgetTokens} budget`);

    // The property, not a list of filenames: whatever the budget pushed out is *named* in the
    // manifest rather than vanishing. A repo small enough to fit entirely has nothing to check.
    // Bounded by the same manifest cap as the sensitive case: a repo with 203 over-budget files
    // gets a count, not 203 lines, because burying the manifest is what the cap prevents. The
    // invariant is that the overflow is never silent -- named while it fits, counted after that.
    const pushedOut = overBudget(pack);
    if (pushedOut.length) {
        const named = pushedOut.filter(doc => pack.text.includes(doc)).length;
        check(named === pushedOut.length || /OMITTED  \.\.\. and \d+ more/.test(pack.text),
            `${pushedOut.length} over-budget files are not silently absent: ${named} named`
            + `${named < pushedOut.length ? ' and the rest counted' : ''}`);
    } else {
        console.log('skip over-budget naming: this target fits entirely in the budget');
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

    // Derived, not named: 'slice' exists in one specific repo. Take the top-level directory git
    // reports most paths under, so these cases run against whatever target is configured.
    const counts = new Map();
    for (const relPath of expected) {
        if (!relPath.includes('/')) continue;
        const top = relPath.slice(0, relPath.indexOf('/'));
        counts.set(top, (counts.get(top) || 0) + 1);
    }
    if (!counts.size) {
        console.log('skip subpath cases: the target has no subdirectories to restrict to');
        return;
    }
    const dir = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];

    const slice = await buildRepoPack(TARGET_REPO, { subpaths: [dir] });
    const expectedSlice = expected.filter(relPath => under(relPath, dir));
    const sliceAccounted = [...slice.files.map(f => f.path), ...slice.omitted.map(o => o.path)];
    check(expectedSlice.length > 1 && sliceAccounted.length === expectedSlice.length
        && expectedSlice.every(relPath => sliceAccounted.includes(relPath)),
        `subpaths ['${dir}'] partitions exactly git's ${expectedSlice.length} paths under ${dir}/`);
    check(sliceAccounted.every(p => p.startsWith(`${dir}/`)),
        `all ${sliceAccounted.length} accounted paths are under the selection, with outside files absent entirely rather than omitted`);

    const dotSlice = await buildRepoPack(TARGET_REPO, { subpaths: [`./${dir}`] });
    check(withoutTimestamps(dotSlice.text) === withoutTimestamps(slice.text),
        `a subpath spelled './${dir}' selects what '${dir}' selects`);

    // `includes` is position-blind. A mutant that moved these two lines below the file bodies put
    // the notice at byte 34,868 of 34,974 and passed every other assertion in this suite, which is
    // the position a model weights least. Pin the position, not the presence.
    const noticeAt = slice.text.indexOf(`=== restricted to: ${dir} ===`);
    check(noticeAt !== -1
        && slice.text.includes('The rest of this repository is not in context')
        && noticeAt < slice.text.indexOf('=== manifest ==='),
        `the restricted pack names the restriction on ${dir} ahead of the manifest, where the model reads it`);
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
    // No NUL anywhere, which is the real counterexample: ReportLab writes small PDFs without
    // compressed streams, so a NUL-only sniff passes them and packs the binary as text.
    fs.writeFileSync(path.join(root, 'doc.pdf'), '%PDF-1.4\n% ReportLab Generated PDF\n1 0 obj\nendobj\n');
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
        // Holds no NUL anywhere, so a NUL-only sniff would pack it as text. This is the
        // counterexample the magic-byte table exists for; reverting that table fails here.
        'doc.pdf': 'binary',
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

    if (!TARGET_REPO) {
        console.log('skip the sizer over-budget case: set REPO_PACK_TARGET to a repo that overflows');
        return;
    }
    const over = await execFile('node', [sizer, TARGET_REPO], big);
    if (/\nstopped  /.test(over.stdout)) {
        // `stopped  docs/` was the old pattern, which only matched one repo's layout. The property
        // is that an overflowing selection still exits 0 and names whatever tripped the stop.
        check(/\nunused   [\d,]+ B/.test(over.stdout) && over.stdout.includes('directories that fit'),
            'an over-budget selection exits 0, names the file that tripped the hard stop, and suggests subpaths');
    } else {
        check(over.stdout.includes('no file was dropped'),
            'a target that fits entirely exits 0 and says nothing was dropped');
    }

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
 * Loads a repoContextService with `storeClass` standing in for electron-store, because what the
 * settings file says is what drives the service's invariants and the real file is the user's.
 *
 * The service is loaded fresh each time, because `lastGood` and the in-flight bookkeeping are
 * module state and a group inheriting another group's installed pack would assert against it by
 * accident.
 */
async function withService(storeClass, body) {
    const storeId = require.resolve('electron-store');
    const realStore = require.cache[storeId];
    // applySettings too, because the service reaches buildRepoPack through it as well, and a module
    // holding a reference destructured before withBuildCounter patched it would go uncounted.
    const reloaded = [SERVICE_MODULE, APPLY_MODULE].map(id => require.resolve(id));

    require.cache[storeId] = { id: storeId, filename: storeId, loaded: true, exports: storeClass };
    for (const id of reloaded) delete require.cache[id];
    try {
        return await body(require(SERVICE_MODULE));
    } finally {
        if (realStore) require.cache[storeId] = realStore;
        else delete require.cache[storeId];
        for (const id of reloaded) delete require.cache[id];
    }
}

/**
 * Counted rather than timed, because the build a save used to pay twice for sits well inside the
 * variance of a loaded machine, so a timing assertion for it would be flaky by construction.
 *
 * `pauseNextBuild`, set to a promise, is what orders a race deterministically, instead of leaving an
 * assertion to depend on which of two sub-50 ms builds happens to finish first.
 */
async function withBuildCounter(body) {
    const packId = require.resolve(PACK_MODULE);
    const real = require.cache[packId].exports;
    const counter = { builds: 0, pauseNextBuild: null };

    require.cache[packId].exports = {
        ...real,
        buildRepoPack: async (...args) => {
            counter.builds += 1;
            const paused = counter.pauseNextBuild;
            counter.pauseNextBuild = null;
            if (paused) await paused;
            return real.buildRepoPack(...args);
        },
    };
    try {
        return await body(counter);
    } finally {
        require.cache[packId].exports = real;
    }
}

/**
 * The service's hardest invariants are root tagging and single-flight, and neither is reachable
 * through the real settings file.
 */
async function checkServiceRootHandling() {
    let configured = null;
    let configuredSubpaths = [];

    await withService(class {
        get(key) {
            if (key === 'repoContextRootPath') return configured;
            if (key === 'repoContextSubpaths') return configuredSubpaths;
            return undefined;
        }
    }, async service => {
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

        configuredSubpaths = ['  sub  '];
        check(await service.refresh() === true && service.promptBlock().includes('=== restricted to: sub ==='),
            'a subpath padded with whitespace is trimmed on the live path, not left to match nothing');

        // Each of these is a plausible hand-edit of the settings JSON. buildRepoPack would throw on
        // them and build() would catch, leaving the sentinel, so the coercion is what keeps a typo
        // from reading as "no repository configured" at the moment the user needs an answer.
        // These cases used to test a settingsService getter that had no production caller; they run
        // against the live path now, which is the one a typo actually reaches.
        for (const bad of ['sub', 42, { '0': 'sub' }, ['sub', 7], ['sub', ''], [''], null]) {
            configuredSubpaths = bad;
            const label = JSON.stringify(bad) || String(bad);
            check(await service.refresh() === true,
                `a malformed repoContextSubpaths ${label} still produces a pack rather than the sentinel`);
            const coerced = service.promptBlock();
            check(!coerced.includes('=== restricted to:') && coerced.includes('a.yaml'),
                `a malformed repoContextSubpaths ${label} reads as not configured, so the whole repository packs`);
        }
    });
}

/** A store save() can actually write, which the get-only mock above cannot be. */
function mapStore(seed = {}) {
    const map = new Map(Object.entries(seed));
    const hooks = { afterSet: null };
    return {
        map,
        hooks,
        MapStore: class {
            get(key) { return map.get(key); }
            set(key, value) {
                map.set(key, value);
                if (hooks.afterSet) hooks.afterSet(key, map);
            }
            delete(key) { map.delete(key); }
        },
    };
}

/** save() is the whole write path for these settings, so its properties are asserted by running it. */
async function checkServiceSave() {
    const { MapStore, map } = mapStore({ contentProtection: true });
    await withService(MapStore, async service => {
        const saved = await service.save({ root: fixture, subpaths: ['sub'] });
        check(saved.ok === true && saved.refreshed === true,
            'save() answers { ok: true, refreshed: true }, the shape the page renders');
        check(map.get(KEYS.root) === fixture && util.isDeepStrictEqual(map.get(KEYS.subpaths), ['sub']),
            "save() persists through the service's own store, so src/index.js needs no Store of its own");
        check(map.get('contentProtection') === true,
            'save() left the unrelated keys in that settings file alone');
        check(service.promptBlock().includes('=== restricted to: sub ==='),
            'the saved selection is being served before this save answers, not at the next launch');
        check(service.status().loaded === true && service.status().root === fixture,
            'status() reports the save as loaded rather than withheld, which is the badge the page reads');

        const refused = await service.save({ root: path.join(fixture, 'no-such-dir') });
        check(refused.ok === false && /does not exist/.test(refused.reason),
            "save() returns applySettings' refusal verbatim rather than throwing");

        // `sub` exists and has no .git, so buildRepoPack throws and the refusal comes from a failed
        // build rather than a failed stat. Stale beats failed on this path too.
        const unpackable = await service.save({ root: path.join(fixture, 'sub') });
        check(unpackable.ok === false && /no \.git entry/.test(unpackable.reason),
            'save() refuses a root that cannot be packed, with buildRepoPack\'s own reason');
        check(map.get(KEYS.root) === fixture
            && service.promptBlock().includes('=== restricted to: sub ==='),
            'neither refused save moved the stored root or the pack being served');

        const off = await service.save({ root: '' });
        check(off.ok === true && off.refreshed === false,
            'save() with an empty root turns the pack off and reports refreshed:false, so the page'
            + ' never claims a pack was installed');
        check(map.get(KEYS.root) === undefined && service.promptBlock() === service.SENTINEL,
            'turning it off clears the stored root and returns promptBlock to the sentinel');
    });
}

async function checkSaveInstallsTheBuiltPack() {
    const { MapStore, map, hooks } = mapStore();
    await withBuildCounter(counter => withService(MapStore, async service => {
        const whole = await service.save({ root: fixture });
        check(whole.refreshed === true && counter.builds === 1,
            'a whole-repository save makes exactly one buildRepoPack call, not one to validate and'
            + ` another to install; it made ${counter.builds}`);

        counter.builds = 0;
        const restricted = await service.save({ root: fixture, subpaths: ['sub'] });
        check(restricted.refreshed === true && counter.builds === 1,
            `a save with a subpath selection also builds once; it made ${counter.builds}`);
        check(service.promptBlock().includes('=== restricted to: sub ==='),
            'the pack that one build produced is the pack being served, so dropping the second build'
            + ' dropped no work the answer depends on');

        // applySettings writes the root last thing before returning, so overwriting it from the set
        // hook puts the pack out of date in exactly the window between the build and the install.
        // Another writer landing there is real, whether the CLI, a hand edit, or a second save.
        counter.builds = 0;
        hooks.afterSet = key => { if (key === KEYS.root) map.set(KEYS.root, WORKTREE_ROOT); };
        const hijacked = await service.save({ root: fixture, subpaths: ['sub'] });
        hooks.afterSet = null;
        check(hijacked.ok === true && hijacked.refreshed === false,
            'a pack handed to the install path for a root that is no longer configured is discarded'
            + ' rather than installed, and the save reports refreshed:false instead of a success');
        check(counter.builds === 1,
            `that discard cost one build (${counter.builds}), not a rebuild to compensate`);
        map.set(KEYS.root, fixture);
        check(service.promptBlock().includes('=== restricted to: sub ==='),
            'the discard left the previously installed pack intact, so stale still beats failed on'
            + ' the install path');

        // The install path must not disturb the single flight either. A build running when a save
        // lands still owns the dedup entry, so the refresh after it joins rather than starting a
        // second build of the same root.
        counter.builds = 0;
        let release;
        counter.pauseNextBuild = new Promise(resolve => { release = resolve; });
        const racing = service.refresh();
        await service.save({ root: fixture, subpaths: ['sub'] });
        check(service.refresh() === racing,
            'a save installing its pack mid-flight leaves the in-flight build joinable, so'
            + ' single-flight per root survives the install path');
        release();
        await racing;
        check(counter.builds === 2,
            `that whole sequence built twice, once per distinct request (${counter.builds}): the`
            + ' install neither rebuilt nor orphaned the flight into a duplicate build');
    }));
}

/**
 * applySettings takes a store and never constructs one, because electron-store under plain node
 * resolves to a settings file the app never reads, as a side effect of merely being imported.
 *
 * Asserted against the DIRECTORY rather than a file. conf's store getter calls `_ensureDirectory` on
 * ENOENT, so importing a module that constructs a Store creates the directory and leaves no file for
 * an existence check to find.
 */
async function checkApplySettingsLoadsClean() {
    // Resolved rather than spelled out, so moving either module breaks this loudly instead of
    // leaving a child that requires nothing and an assertion that passes.
    const inRepo = id => path.relative(WORKTREE_ROOT, require.resolve(id));
    const probe = cliHome(null);
    const nodeSideDir = path.relative(probe, path.dirname((await measureStorePaths(probe)).nodeSide));

    const loadIn = async (home, id) => {
        await execFile('node', ['-e', `require('./${inRepo(id)}')`],
            { env: cliEnv(home), cwd: WORKTREE_ROOT });
        return fs.existsSync(path.join(home, nodeSideDir));
    };

    check(await loadIn(cliHome(null), SERVICE_MODULE),
        `requiring ${inRepo(SERVICE_MODULE)} under plain node creates ${nodeSideDir}, which is what`
        + ' makes the assertion below worth making');
    check(!await loadIn(cliHome(null), APPLY_MODULE),
        `requiring ${inRepo(APPLY_MODULE)} creates no ${nodeSideDir}, so a verifier can load the real`
        + ' validation rules without writing a settings file at the wrong path');
}

/** Synthetic, never a copy of the real document, for the same reason the fixture is not in the tree. */
const CLI_SEED = {
    users: { 'default-user': { displayName: 'Local', onboarded: true } },
    keybinds: { toggleVisibility: 'Cmd+\\', nextStep: 'Cmd+Enter' },
    contentProtection: true,
};

/** APPDATA and XDG_CONFIG_HOME move too, or these assertions would only ever relocate on darwin. */
function cliEnv(home) {
    return {
        ...process.env,
        HOME: home,
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        XDG_CONFIG_HOME: path.join(home, '.config'),
    };
}

/** Works because os.homedir() re-reads process.env.HOME on every call, measured on node v18.20.2. */
function settingsPathUnder(home) {
    const saved = ['HOME', 'APPDATA', 'XDG_CONFIG_HOME'].map(key => [key, process.env[key]]);
    Object.assign(process.env, cliEnv(home));
    try {
        return appSettingsPath();
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function cliHome(seed) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-repo-context-'));
    cliHomes.push(home);
    if (seed !== null) {
        const file = settingsPathUnder(home);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof seed === 'string' ? seed : JSON.stringify(seed, null, '\t'));
    }
    return home;
}

async function runCli(home, args) {
    try {
        const { stdout, stderr } = await execFile('node', [CLI, ...args],
            { env: cliEnv(home), cwd: WORKTREE_ROOT, maxBuffer: 8 * 1024 * 1024 });
        return { code: 0, stdout, stderr };
    } catch (err) {
        return { code: err.code, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
}

async function measureStorePaths(home) {
    const code = "const S = require('electron-store');"
        + "console.log(new S({ name: 'pickle-glass-settings' }).path);"
        + "console.log(require('./src/features/common/repoContext/config').appSettingsPath());";
    const { stdout } = await execFile('node', ['-e', code], { env: cliEnv(home), cwd: WORKTREE_ROOT });
    const [nodeSide, appSide] = stdout.trim().split('\n');
    return { nodeSide, appSide };
}

function packedCount(stdout) {
    const matched = /\npacked {3}([\d,]+) files?,/.exec(stdout);
    return matched ? Number(matched[1].replace(/,/g, '')) : null;
}

function statOf(file) {
    if (!fs.existsSync(file)) return 'absent';
    const stat = fs.statSync(file);
    return `${stat.size} B at ${stat.mtimeMs}`;
}

/**
 * Every run happens in a child process under a fresh temp HOME, because proving the CLI writes the
 * app's settings file needs appSettingsPath to resolve somewhere other than the user's own. The real
 * file is then never touched, which the last assertion checks.
 */
async function checkCli() {
    const realFile = appSettingsPath();
    const realBefore = statOf(realFile);

    const probeHome = cliHome(null);
    const measured = await measureStorePaths(probeHome);
    check(measured.nodeSide !== measured.appSide
        && measured.nodeSide.startsWith(probeHome) && measured.appSide.startsWith(probeHome),
        'under one HOME, electron-store resolves to a different settings file than the app reads,'
        + ' which is the whole reason this CLI edits the file instead of requiring the library');
    check(measured.nodeSide.includes(`${path.sep}Library${path.sep}Preferences${path.sep}`)
        || measured.nodeSide.includes(`${path.sep}.config${path.sep}`)
        || measured.nodeSide.includes(`${path.sep}AppData${path.sep}`),
        `the path electron-store writes under plain node is the one the app never reads`
        + ` (${path.relative(probeHome, measured.nodeSide)})`);
    check(settingsPathUnder(probeHome) === measured.appSide,
        'the harness and the child agree on the app-side path, so relocating HOME relocates both');

    // Joined onto each fresh HOME below, so the home under assertion is never probed itself.
    const nodeSideRel = path.relative(probeHome, measured.nodeSide);

    const home = cliHome(CLI_SEED);
    const file = settingsPathUnder(home);
    const seeded = fs.readFileSync(file);

    const set = await runCli(home, ['set', fixture, 'sub']);
    check(set.code === 0, `set on a real repo with a matching subpath exits 0${set.code ? `: ${set.stderr}` : ''}`);
    const written = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(written);
    check(parsed[KEYS.root] === fixture,
        'set stored the configured root in the file the running app reads');
    check(util.isDeepStrictEqual(parsed[KEYS.subpaths], ['sub']),
        `set stored the subpath list it was given (${JSON.stringify(parsed[KEYS.subpaths])})`);
    check(!fs.existsSync(path.join(home, nodeSideRel)),
        'the settings file electron-store resolves to under plain node was never created');
    // Measured: requiring repoContextService creates this directory and no file, because conf's
    // store getter calls _ensureDirectory on ENOENT. So the file check above cannot see the import
    // trap this CLI exists for, and the directory check is what catches it.
    check(!fs.existsSync(path.join(home, path.dirname(nodeSideRel))),
        'electron-store was never even constructed, let alone written: the directory a Store makes'
        + ' at import is absent, which is what catches a future edit requiring repoContextService');

    const relative = cliHome(CLI_SEED);
    const spelled = path.relative(WORKTREE_ROOT, fixture);
    const viaRelative = await runCli(relative, ['set', spelled]);
    const storedRoot = JSON.parse(fs.readFileSync(settingsPathUnder(relative), 'utf8'))[KEYS.root];
    check(viaRelative.code === 0 && storedRoot === fixture && path.isAbsolute(storedRoot),
        `a relative repo path is resolved before it is stored (${spelled} stored as an absolute`
        + ' path), because promptBlock matches the stored root by string equality');

    check(util.isDeepStrictEqual(parsed.users, CLI_SEED.users)
        && util.isDeepStrictEqual(parsed.keybinds, CLI_SEED.keybinds),
        'a nested object and a nested keybind map survive a set with their values intact');
    check(parsed.contentProtection === CLI_SEED.contentProtection,
        'an unrelated scalar key survives a set with its value intact');

    check(written.includes('\n\t') && !written.endsWith('\n'),
        'the written file keeps the tab indentation and the absent trailing newline the app writes');
    check(JSON.stringify(parsed, null, '\t') === written,
        "the written bytes are exactly what the app's own serializer would produce for that document");

    const off = await runCli(home, ['off']);
    check(off.code === 0, 'off exits 0 when keys were set');
    const afterOff = JSON.parse(fs.readFileSync(file, 'utf8'));
    check(util.isDeepStrictEqual(afterOff.users, CLI_SEED.users)
        && util.isDeepStrictEqual(afterOff.keybinds, CLI_SEED.keybinds)
        && afterOff.contentProtection === CLI_SEED.contentProtection,
        'the same nested objects and unrelated scalar survive an off with their values intact');
    check(Object.values(KEYS).every(key => afterOff[key] === undefined),
        `off removed all ${Object.values(KEYS).length} repo-context keys and nothing else`);

    const offAgain = await runCli(home, ['off']);
    const afterSecond = fs.readFileSync(file);
    check(offAgain.code === 0 && afterSecond.equals(Buffer.from(JSON.stringify(afterOff, null, '\t'))),
        'a second off exits 0 and leaves the file byte-identical, so running it twice is'
        + ' indistinguishable from running it once');
    check(offAgain.stdout.includes('nothing was set'),
        'the second off says nothing was set rather than reporting a removal it did not make');

    const noFile = cliHome(null);
    const offNoFile = await runCli(noFile, ['off']);
    check(offNoFile.code === 0 && !fs.existsSync(settingsPathUnder(noFile)),
        'off with no settings file at all exits 0, does not crash, and writes no file');

    const refusals = [
        {
            args: ['set', '/no/such/path'],
            says: /does not exist/,
            label: 'a repo path that does not exist is named as missing rather than as lacking a .git entry',
        },
        {
            args: ['set', path.join(fixture, 'no-git-here')],
            says: /has no \.git entry/,
            label: 'a directory with no .git is refused',
        },
        {
            args: ['set', fixture, 'sub', 'no-such-dir'],
            says: /match no tracked file[\s\S]*no-such-dir|no-such-dir[\s\S]*match no tracked file/,
            label: 'one unmatched subpath alongside one that matches is refused, and the unmatched spelling is named',
        },
    ];
    for (const refusal of refusals) {
        const where = cliHome(CLI_SEED);
        const target = settingsPathUnder(where);
        const bytes = fs.readFileSync(target);
        const result = await runCli(where, refusal.args);
        check(result.code !== 0 && refusal.says.test(result.stderr + result.stdout)
            && fs.readFileSync(target).equals(bytes),
            `${refusal.label}, and the settings file is left byte-identical`);
    }

    const malformed = '{\n\t"users": {\n\t\t"a": 1\n\t},\n\toops not json';
    for (const args of [['set', fixture], ['off'], ['status']]) {
        const where = cliHome(malformed);
        const target = settingsPathUnder(where);
        const result = await runCli(where, args);
        check(result.code !== 0 && fs.readFileSync(target, 'utf8') === malformed,
            `${args[0]} refuses a settings file that exists but holds malformed JSON, rather than`
            + ' clobbering the keybinds and the users object it cannot parse');
    }

    const stale = cliHome({ ...CLI_SEED, [KEYS.root]: '/old/repo', [KEYS.subpaths]: ['stale/dir'] });
    const staleFile = settingsPathUnder(stale);
    const wholeRepo = await runCli(stale, ['set', fixture]);
    const afterWhole = JSON.parse(fs.readFileSync(staleFile, 'utf8'));
    check(wholeRepo.code === 0 && afterWhole[KEYS.root] === fixture
        && afterWhole[KEYS.subpaths] === undefined,
        'set with no subpaths means the whole repository, so it removes a stale subpath list'
        + ' instead of leaving it to restrict the new root');

    // hidden.yaml is in the fixture's .gitignore, so it can only reach a pack via the opt-in list.
    const plain = await runCli(cliHome(CLI_SEED), ['set', fixture, 'sub']);
    const withOptIn = await runCli(cliHome({ ...CLI_SEED, [KEYS.includePaths]: ['hidden.yaml'] }),
        ['set', fixture, 'sub']);
    check(packedCount(plain.stdout) !== null && withOptIn.code === 0
        && packedCount(withOptIn.stdout) === packedCount(plain.stdout) + 1,
        `the stored opt-in list reaches the build, so set reports the ${packedCount(withOptIn.stdout)}`
        + ` files the app will pack rather than the ${packedCount(plain.stdout)} the subpath alone selects`);

    const rejected = await runCli(cliHome({ ...CLI_SEED, [KEYS.includePaths]: 'hidden.yaml' }),
        ['set', fixture, 'sub']);
    check(rejected.code === 0 && /not an array of non-empty strings/.test(rejected.stdout),
        'an opt-in list stored as a bare string is reported as unusable and the set still succeeds,'
        + ' which is what the app does with it');

    const over = cliHome(CLI_SEED);
    const overflow = await runCli(over, ['set', WORKTREE_ROOT]);
    check(overflow.code === 0
        && JSON.parse(fs.readFileSync(settingsPathUnder(over), 'utf8'))[KEYS.root] === WORKTREE_ROOT,
        'an overflowing selection is saved and exits 0, because overflow is a fact about the pack');
    if (/\nstopped {2}/.test(overflow.stdout)) {
        check(/\nstopped {2}\S+, [\d,]+ B, did not fit/.test(overflow.stdout)
            && overflow.stdout.includes('size-repo-pack.js'),
            'an overflowing set names the file that tripped the hard stop and points at the sizer'
            + ' rather than reimplementing its suggestions');
    } else {
        check(overflow.stdout.includes('no file was dropped'),
            'this worktree packs entirely within the budget, so the set says nothing was dropped');
    }

    const configured = cliHome({ ...CLI_SEED, [KEYS.root]: fixture, [KEYS.subpaths]: ['sub', 'sublime'] });
    const status = await runCli(configured, ['status']);
    check(status.code === 0 && status.stdout.includes(settingsPathUnder(configured))
        && status.stdout.includes(fixture)
        && status.stdout.includes('sub') && status.stdout.includes('sublime'),
        'status names the settings file it read, the configured root, and every configured subpath');
    check(status.stdout.includes('[RepoContext] packed') && /no file answers this/.test(status.stdout),
        'status states that no file can say whether a pack is loaded, and names the'
        + ' [RepoContext] packed log line as the only live signal');

    const empty = await runCli(cliHome(null), ['status']);
    check(empty.code === 0 && /\(not set\)/.test(empty.stdout) && /\(none\)/.test(empty.stdout),
        'status with no settings file exits 0 and prints (not set) and (none) rather than blanks');

    const usage = await runCli(cliHome(CLI_SEED), []);
    const unknown = await runCli(cliHome(CLI_SEED), ['nope']);
    check(usage.code === 1 && unknown.code === 1
        && ['status', 'set', 'off'].every(name => usage.stderr.includes(name)),
        'no arguments and an unknown command both exit 1 and print the usage for every command');

    check(statOf(realFile) === realBefore,
        `the user's own settings file was never touched: ${realBefore} before and after`);
}

async function main() {
    await checkTargetRepo();
    fixture = await buildFixture();
    await checkFixture();
    await checkGlassSubpath();
    await checkSizer();
    await checkCli();
    checkServiceSentinel();
    await checkServiceRootHandling();
    await checkServiceSave();
    await checkSaveInstallsTheBuiltPack();
    await checkApplySettingsLoadsClean();
}

function cleanup() {
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
    for (const home of cliHomes) fs.rmSync(home, { recursive: true, force: true });
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
