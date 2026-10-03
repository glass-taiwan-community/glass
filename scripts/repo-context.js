#!/usr/bin/env node
/**
 * Configures the repo the app attaches to every Ask, and validates the selection before saving it,
 * because the settings file cannot validate itself.
 *
 * It edits that file directly and deliberately does NOT require `electron-store`, which resolves to
 * a different file inside and outside Electron. Measured under one throwaway HOME: plain node writes
 * $HOME/Library/Preferences/electron-store-nodejs/pickle-glass-settings.json, while the app reads
 * $HOME/Library/Application Support/Glass/pickle-glass-settings.json. Requiring repoContextService
 * is out for the same reason, since it constructs a Store at import. A CLI that writes the file the
 * app never reads and then prints "ok" is the worst outcome available here.
 */

const fs = require('node:fs');
const path = require('node:path');

const { KEYS, appSettingsPath, normalizeList } = require('../src/features/common/repoContext/config');
const { buildRepoPack, matchesSubpath, DEFAULT_POLICY } = require('../src/features/common/repoContext/repoPack');

const BUDGET_BYTES = DEFAULT_POLICY.budgetTokens * DEFAULT_POLICY.bytesPerToken;

function num(value) {
    return value.toLocaleString('en-US');
}

function plural(count, noun) {
    return `${num(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function readSettings() {
    const file = appSettingsPath();
    if (!fs.existsSync(file)) return {};

    const raw = fs.readFileSync(file, 'utf8');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`${file} is not valid JSON (${err.message}).`
            + ' Refusing to touch it: rewriting it would drop every other setting in it.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${file} does not hold a JSON object.`
            + ' Refusing to touch it: rewriting it would drop whatever it does hold.');
    }
    return parsed;
}

/** A tab and no trailing newline is what `conf` writes, so the app's next write is not a whole-file diff. */
function writeSettings(settings) {
    const file = appSettingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, '\t'));
}

function reportList(label, value) {
    const { list, rejected } = normalizeList(value);
    console.log(`${label.padEnd(9)}${list.length ? list.join(', ') : '(none)'}`);
    if (rejected) {
        console.log('         the stored value is not an array of non-empty strings, so the app'
            + ' reads it as none');
    }
    return list;
}

/** buildRepoPack refuses only a selection matching nothing at all; a single typo is refused here, where it can still be fixed. */
function assertEverySubpathMatches(pack, spelled) {
    const enumerated = [...pack.files.map(file => file.path), ...pack.omitted.map(entry => entry.path)];
    const unmatched = [];

    console.log('\nmatches  per subpath, against what git tracks');
    pack.subpaths.forEach((subpath, index) => {
        const count = enumerated.filter(relPath => matchesSubpath(relPath, [subpath])).length;
        if (!count) unmatched.push(spelled[index]);
        console.log(`         ${count ? plural(count, 'file').padStart(14) : 'NO MATCH'.padStart(14)}`
            + `  ${spelled[index]}`);
    });

    if (unmatched.length) {
        throw new Error(`these subpaths match no tracked file: ${unmatched.join(', ')}.`
            + ' Nothing was saved.');
    }
}

function reportBudget(pack) {
    const used = (pack.sourceBytes / BUDGET_BYTES) * 100;
    console.log(`\npacked   ${plural(pack.files.length, 'file')}, ${num(pack.sourceBytes)} B of source,`
        + ` ~${num(pack.estTokens)} est tokens`);
    console.log(`budget   ${num(DEFAULT_POLICY.budgetTokens)} tokens = ${num(BUDGET_BYTES)} B at`
        + ` ${DEFAULT_POLICY.bytesPerToken} B/token, ${used.toFixed(1)}% used`);

    // omitted is pushed in enumeration order and the budget pass is one sweep over it, so the first
    // over-budget entry is the file that tripped the hard stop. The rest are collateral.
    const crossing = pack.omitted.find(entry => entry.reason === 'over-budget');
    if (!crossing) {
        console.log('fits     no file was dropped for the budget');
        return;
    }

    console.log(`\nstopped  ${crossing.path}, ${num(crossing.bytes)} B, did not fit, and the hard stop`
        + ' drops every file sorted after it as well');
    console.log('         run scripts/size-repo-pack.js on this repo to see which directories fit');
}

async function runStatus(args) {
    if (args.length) throw new Error(`status takes no arguments. Usage: ${COMMANDS.status.usage}`);

    const file = appSettingsPath();
    const exists = fs.existsSync(file);
    const settings = readSettings();

    console.log(`file     ${file}`);
    if (!exists) console.log('         it does not exist yet, so nothing is configured');

    const root = settings[KEYS.root];
    if (typeof root === 'string' && root) console.log(`repo     ${root}`);
    else if (root === undefined) console.log('repo     (not set)');
    else console.log(`repo     (not set) a value is stored but it is not a path: ${JSON.stringify(root)}`);

    reportList('subpaths', settings[KEYS.subpaths]);
    reportList('include', settings[KEYS.includePaths]);

    console.log('\nloaded   no file answers this. The pack lives in the memory of the running app, so'
        + ' the only live');
    console.log('         signal is the `[RepoContext] packed <root>: ...` line in its log at startup.');
}

async function runSet(args) {
    if (!args.length) throw new Error(`no repo path given. Usage: ${COMMANDS.set.usage}`);

    // Not redundant with buildRepoPack: assertGitRoot reports a missing directory as one lacking a
    // .git entry, which sends the user hunting the wrong problem.
    const root = path.resolve(args[0]);
    if (!fs.existsSync(root)) throw new Error(`${root} does not exist`);
    const spelled = args.slice(1);

    const settings = readSettings();

    console.log(`repo     ${root}`);
    console.log(`subpaths ${spelled.length ? spelled.join(', ') : '(none, so the whole repository)'}`);
    const includePaths = reportList('include', settings[KEYS.includePaths]);

    const pack = await buildRepoPack(root, { subpaths: spelled, includePaths });
    if (spelled.length) assertEverySubpathMatches(pack, spelled);
    reportBudget(pack);

    settings[KEYS.root] = root;
    // Store the RAW spellings, never pack.subpaths: normalizeSubpaths turns `.` into '', which
    // normalizeList then rejects, so a normalized `set <repo> .` would reach the app as a warning
    // rather than as the ''-selects-everything rule in matchesSubpath.
    if (spelled.length) settings[KEYS.subpaths] = spelled;
    else delete settings[KEYS.subpaths];
    writeSettings(settings);

    console.log(`\nsaved    ${appSettingsPath()}`);
    console.log('effect   the app reads the new root on its next Ask, but withholds the pack until a'
        + ' rebuild,');
    console.log('         whose only caller is startup (src/index.js:211). Restart Glass.');
}

async function runOff(args) {
    if (args.length) throw new Error(`off takes no arguments. Usage: ${COMMANDS.off.usage}`);

    const settings = readSettings();
    const present = Object.values(KEYS).filter(key => settings[key] !== undefined);

    console.log(`file     ${appSettingsPath()}`);
    if (!present.length) {
        console.log('off      nothing was set, so nothing changed and nothing was written');
        return;
    }

    for (const key of present) {
        console.log(`removed  ${key} = ${JSON.stringify(settings[key])}`);
        delete settings[key];
    }
    writeSettings(settings);

    // No restart, because `conf` re-reads the file on every get, so the running app sees this write.
    console.log('\neffect   the app reads the root as absent on its next Ask and attaches the'
        + ' no-context sentinel');
    console.log('         instead of a pack. No restart needed.');
}

const COMMANDS = {
    status: {
        usage: 'status                    what the settings file says, and what no file can say',
        run: runStatus,
    },
    set: {
        usage: 'set <repo> [subpath ...]  validate the selection, then point the app at it',
        run: runSet,
    },
    off: {
        usage: 'off                       remove all three keys',
        run: runOff,
    },
};

function printUsage() {
    console.error(`usage    node scripts/repo-context.js <${Object.keys(COMMANDS).join('|')}>`);
    for (const command of Object.values(COMMANDS)) console.error(`         ${command.usage}`);
}

async function main() {
    const [name, ...args] = process.argv.slice(2);
    const command = COMMANDS[name];
    if (!command) {
        if (name) console.error(`\nerror: unknown command ${name}`);
        printUsage();
        process.exit(1);
    }

    const flag = args.find(arg => arg.startsWith('-'));
    if (flag) throw new Error(`unrecognized argument ${flag}. Usage: ${command.usage}`);

    await command.run(args);
}

main().catch(err => {
    console.error(`\nerror: ${err.message}`);
    process.exit(1);
});
