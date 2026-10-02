#!/usr/bin/env node
/**
 * node scripts/size-repo-pack.js <repo-path> [subpath ...]
 *
 * Pre-flight for `repoContextRootPath` and `repoContextSubpaths`, meant to be run before an
 * interview rather than during one, so every section is one or two lines.
 *
 * It exists because the pack's own manifest cannot answer the question that matters. On this repo
 * an unrestricted pack is 11 files and none of src/, and the manifest says so only as 202
 * `over-budget` lines; the cause is one file, `functions/package-lock.json` at 286,977 B, which
 * sorts into the code-and-config band and trips the hard stop. This script names that file, says
 * how much of the budget the stop then left unused, and when the selection overflows it ranks the
 * directories worth pointing `subpaths` at.
 *
 * Exit 0 for any usable result, an over-budget selection included: overflow is a fact about the
 * pack, not a failure. Exit 1 only for a configuration error, which includes ANY subpath matching
 * nothing, where buildRepoPack refuses only a selection matching nothing at all. That asymmetry is
 * deliberate. Here the user is configuring and can fix a typo, so a silently partial selection is
 * the expensive outcome; at Ask time the pack is a safety net and a partial one beats silence.
 *
 * The exact token count is a bonus and never a failure: the policy's `bytes / 2.5` is 15.4%
 * optimistic for code and config (finding-ttft-vs-prompt-size.md), so the real number is worth
 * having, but every step to it can be missing and each one skips with its reason. Two obstacles
 * are already known here. The running app holds a write lock on the settings DB, which fails even
 * a readonly open with error 14, so the row is read from a copy; and better-sqlite3 in this repo
 * is built for a different node ABI than the default `node`, so the copy is queried by shelling
 * out to /usr/bin/sqlite3. Nothing in this script prints the key or any file's contents.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { buildRepoPack, matchesSubpath, DEFAULT_POLICY } = require('../src/features/common/repoContext/repoPack');

const USAGE = 'node scripts/size-repo-pack.js <repo-path> [subpath ...]';
const LIVE_DB = path.join(os.homedir(), 'Library', 'Application Support', 'Glass', 'pickleglass.db');
const SQLITE = '/usr/bin/sqlite3';
const COUNT_TOKENS_URL = 'https://api.anthropic.com/v1/messages/count_tokens';

// The finding's measured ratio for code-and-config content, against the policy's 2.5.
const MEASURED_BYTES_PER_TOKEN = 2.289;

const BUDGET_BYTES = DEFAULT_POLICY.budgetTokens * DEFAULT_POLICY.bytesPerToken;
const MAX_SUGGESTIONS = 8;
const MAX_SUGGEST_DEPTH = 4;
const EXAMPLES_PER_REASON = 2;

let scratch = null;

function num(value) {
    return value.toLocaleString('en-US');
}

function plural(count, noun) {
    return `${num(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function parseArgs(argv) {
    const args = argv.slice(2);
    const flag = args.find(arg => arg.startsWith('-'));
    if (flag) throw new Error(`unrecognized argument ${flag}. Usage: ${USAGE}`);
    if (!args.length) throw new Error(`no repo path given. Usage: ${USAGE}`);

    const root = path.resolve(args[0]);
    if (!fs.existsSync(root)) throw new Error(`${root} does not exist`);
    return { root, subpaths: args.slice(1) };
}

/**
 * Counted per subpath so that one typo among several is visible. `pack.subpaths` is the normalized
 * list in the order it was given, so it zips with the raw spellings the user typed, which are what
 * they have to go and edit.
 */
function reportSubpathMatches(pack, spelled) {
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
        throw new Error(`these subpaths match no tracked file: ${unmatched.join(', ')}`);
    }
}

function reportBudget(pack) {
    const used = (pack.sourceBytes / BUDGET_BYTES) * 100;
    console.log(`\npacked   ${plural(pack.files.length, 'file')}, ${num(pack.sourceBytes)} B of source,`
        + ` ~${num(pack.estTokens)} est tokens`);
    console.log(`budget   ${num(DEFAULT_POLICY.budgetTokens)} tokens = ${num(BUDGET_BYTES)} B at`
        + ` ${DEFAULT_POLICY.bytesPerToken} B/token, ${used.toFixed(1)}% used`);

    // omitted is pushed in enumeration order and the budget pass is one sweep over it, so the
    // first over-budget entry is the file that actually tripped the hard stop. The rest are
    // collateral, which is why listing them all says nothing.
    const crossing = pack.omitted.find(entry => entry.reason === 'over-budget');
    if (!crossing) {
        console.log('fits     no file was dropped for the budget');
        return;
    }

    console.log(`\nstopped  ${crossing.path}, ${num(crossing.bytes)} B, did not fit, and the hard stop`
        + ' drops every file sorted after it as well');
    console.log(`unused   ${num(BUDGET_BYTES - pack.sourceBytes)} B of the ${num(BUDGET_BYTES)} B budget`
        + ` went unspent, which is why only ${plural(pack.files.length, 'file')} came back`);
}

function reportOmissions(pack) {
    if (!pack.omitted.length) return;

    const byReason = new Map();
    for (const entry of pack.omitted) {
        if (!byReason.has(entry.reason)) byReason.set(entry.reason, []);
        byReason.get(entry.reason).push(entry);
    }

    console.log(`\nomitted  ${plural(pack.omitted.length, 'file')}, by reason`);
    for (const [reason, entries] of byReason) {
        const bytes = entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0);
        const examples = entries.slice(0, EXAMPLES_PER_REASON).map(entry => entry.path);
        const rest = entries.length - examples.length;
        console.log(`         ${reason.padEnd(12)}${String(entries.length).padStart(4)}, ${num(bytes)} B`
            + `  ${examples.join(', ')}${rest > 0 ? `, +${rest} more` : ''}`);
    }
}

/** Every directory prefix down to MAX_SUGGEST_DEPTH, mapped to the bytes and files beneath it. */
function directoryTotals(files) {
    const totals = new Map();
    for (const file of files) {
        const segments = file.path.split('/');
        const deepest = Math.min(segments.length - 1, MAX_SUGGEST_DEPTH);
        for (let depth = 1; depth <= deepest; depth++) {
            const key = segments.slice(0, depth).join('/');
            const total = totals.get(key) || { bytes: 0, files: 0 };
            totals.set(key, { bytes: total.bytes + file.bytes, files: total.files + 1 });
        }
    }
    return totals;
}

/**
 * The directories worth pointing `subpaths` at are the ones that FIT, largest first, since the
 * largest fitting directory is the most context the budget will take. A directory over the budget
 * is not a usable answer, so only its depth-1 total is reported, as a one-line note on where the
 * weight sits.
 *
 * Descending past depth 2 is what makes this actionable on glass. Depths 1 and 2 alone offer
 * nothing under src/: src is 1,399,236 packable B and src/features 604,763, both far over, while
 * src/features/listen is at depth 3 and src/features/listen/stt at depth 4.
 */
function rankSuggestions(files) {
    const totals = directoryTotals(files);
    const fits = dir => totals.has(dir) && totals.get(dir).bytes <= BUDGET_BYTES;

    const usable = [];
    const oversized = [];
    for (const [dir, total] of totals) {
        const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : null;
        if (total.bytes > BUDGET_BYTES) {
            if (!parent) oversized.push({ dir, ...total });
        } else if (!parent || !fits(parent)) {
            // A fitting parent is the better subpath, so its children would only repeat it.
            usable.push({ dir, ...total });
        }
    }
    usable.sort((a, b) => b.bytes - a.bytes);
    oversized.sort((a, b) => b.bytes - a.bytes);
    return { usable, oversized };
}

/**
 * "Packable" means it would be packed if the budget were infinite, which is the only figure that
 * predicts anything about a narrower selection. This pack's own numbers stop at the crossing file,
 * and its omitted entries include binary and sensitive files a narrower subpath would not get
 * either, so the ranking needs a second build rather than arithmetic on this one.
 */
async function reportSuggestions(root, subpaths) {
    const unlimited = await buildRepoPack(root, { subpaths, policy: { budgetTokens: 1e9 } });
    const { usable, oversized } = rankSuggestions(unlimited.files);

    console.log(`\nsuggest  ${num(unlimited.sourceBytes)} B is packable here and ${num(BUDGET_BYTES)} B`
        + ' of it fits. The largest directories that fit:');
    if (!usable.length) console.log('         none. Every directory is over the budget on its own.');
    for (const entry of usable.slice(0, MAX_SUGGESTIONS)) {
        console.log(`         ${num(entry.bytes).padStart(7)} B`
            + ` ~${num(Math.round(entry.bytes / DEFAULT_POLICY.bytesPerToken)).padStart(6)} tok`
            + ` ${String(entry.files).padStart(4)} files  ${entry.dir}`);
    }

    if (usable.length > 1) {
        console.log('         subpaths takes a list, so several of these can be combined while their'
            + ' total stays under the budget');
    }
    // "Fits" above is source bytes against the policy's 2.5 B/token, which is what repoPack
    // enforces, not what the tokenizer charges. The target repo's live pack measured 20,425 real
    // tokens while estTokens read 17,695, so a suggestion can fit here and still run over.
    if (usable.length) {
        console.log('         rerun with the subpath you pick to see its real token count');
    }

    // Only without a restriction: under one these totals cover the selected part of a directory,
    // not the directory, and `stopped` above already says the selection itself overflows.
    if (oversized.length && !subpaths.length) {
        const named = oversized.slice(0, 4).map(entry => `${entry.dir} ${num(entry.bytes)} B`);
        console.log(`         too big to name whole: ${named.join(', ')}`);
    }

    const atRoot = unlimited.files.filter(file => !file.path.includes('/'));
    if (atRoot.length) {
        const bytes = atRoot.reduce((sum, file) => sum + file.bytes, 0);
        console.log(`         ${plural(atRoot.length, 'file')} sit at the repo root, ${num(bytes)} B,`
            + ' which no subpath selects on its own');
    }
}

function scratchDir() {
    if (!scratch) scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'size-repo-pack-'));
    return scratch;
}

/** @returns {{ provider: string, model: string, apiKey: string }|{ skip: string }} */
function readActiveProvider() {
    if (!fs.existsSync(LIVE_DB)) return { skip: `no settings DB at ${LIVE_DB}` };
    if (!fs.existsSync(SQLITE)) return { skip: `no sqlite3 binary at ${SQLITE}` };

    let row;
    try {
        const copy = path.join(scratchDir(), 'pickleglass-copy.db');
        fs.copyFileSync(LIVE_DB, copy);
        for (const sidecar of ['-wal', '-shm']) {
            if (fs.existsSync(LIVE_DB + sidecar)) fs.copyFileSync(LIVE_DB + sidecar, copy + sidecar);
        }
        const sql = 'SELECT provider, selected_llm_model, api_key FROM provider_settings WHERE is_active_llm=1 LIMIT 1;';
        row = execFileSync(SQLITE, [copy, sql], { encoding: 'utf8' }).trim();
    } catch (err) {
        return { skip: `the settings DB could not be queried (${err.message.split('\n')[0]})` };
    }

    if (!row) return { skip: 'no provider_settings row has is_active_llm=1' };
    const [provider, model, ...rest] = row.split('|');
    const apiKey = rest.join('|');
    if (provider !== 'anthropic') {
        return { skip: `the active provider is ${provider}, which this script cannot count tokens with` };
    }
    if (!model) return { skip: `the active provider ${provider} has no selected_llm_model` };
    if (!apiKey) return { skip: `the active provider ${provider} has no stored key` };
    return { provider, model, apiKey };
}

async function countTokens(text, model, apiKey) {
    const res = await fetch(COUNT_TOKENS_URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': apiKey,
        },
        // The pack reaches the model as part of the system prompt, so it is counted as the system
        // prompt here. The user turn is a placeholder the endpoint requires.
        body: JSON.stringify({ model, system: text, messages: [{ role: 'user', content: 'x' }] }),
    });
    if (!res.ok) throw new Error(`count_tokens answered HTTP ${res.status}`);
    const body = await res.json();
    if (typeof body.input_tokens !== 'number') throw new Error('count_tokens returned no input_tokens');
    return body.input_tokens;
}

async function reportExactTokens(pack) {
    const active = readActiveProvider();
    if (active.skip) {
        console.log(`\nexact    not counted: ${active.skip}. The estimate above is all there is.`);
        return;
    }

    let exact;
    try {
        exact = await countTokens(pack.text, active.model, active.apiKey);
    } catch (err) {
        console.log(`\nexact    not counted: ${err.message}. The estimate above is all there is.`);
        return;
    }

    const renderedBytes = Buffer.byteLength(pack.text);
    console.log(`\nexact    ${num(exact)} input tokens, counted by ${active.model} over the whole`
        + ' rendered block, manifest included');
    console.log(`         against the ~${num(pack.estTokens)} estimated from source bytes alone, and a`
        + ` ${num(DEFAULT_POLICY.budgetTokens)} token budget`);
    // The estimate charges source bytes only, so a pack that reads as fitting can be over once the
    // manifest and headers are counted. The finding measured exactly that on the target repo:
    // 20,425 real tokens against the 20,000 budget, reported as 17,695.
    if (exact > DEFAULT_POLICY.budgetTokens) {
        console.log(`         OVER by ${num(exact - DEFAULT_POLICY.budgetTokens)} real tokens, though the`
            + ' estimate above reads as fitting');
    }
    console.log(`         ${num(renderedBytes)} rendered B / ${num(exact)} tokens =`
        + ` ${(renderedBytes / exact).toFixed(3)} B/token, where the policy assumes`
        + ` ${DEFAULT_POLICY.bytesPerToken} and the finding measured ${MEASURED_BYTES_PER_TOKEN}`);
}

async function main() {
    const { root, subpaths } = parseArgs(process.argv);

    console.log(`repo     ${root}`);
    console.log(`subpaths ${subpaths.length ? subpaths.join(', ') : '(none, so the whole repository)'}`);

    const pack = await buildRepoPack(root, { subpaths });
    if (subpaths.length) reportSubpathMatches(pack, subpaths);

    reportBudget(pack);
    reportOmissions(pack);
    if (pack.omitted.some(entry => entry.reason === 'over-budget')) {
        // reportSuggestions reads only `files` and `sourceBytes`, but buildRepoPack always renders
        // the full text. Measured on glass: an unlimited build renders 2,682,145 B that nothing
        // reads, and past V8's string limit `join` throws RangeError. Degrade rather than exit 1 on
        // a result the user can act on.
        try {
            await reportSuggestions(root, subpaths);
        } catch (err) {
            console.log(`\nsuggest  unavailable: ${err.message}`);
        }
    }
    await reportExactTokens(pack);
}

function cleanup() {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
}

main()
    .then(cleanup)
    .catch(err => {
        cleanup();
        console.error(`\nerror: ${err.message}`);
        process.exit(1);
    });
