#!/usr/bin/env node
/**
 * node scripts/verify-screen-aware-prompt.js
 *
 * Exits 0 only when every assertion holds. Covers the screenAttached flag on
 * pickle_glass_analysis. That screenAttached:true reproduces the pre-flag prompt byte for byte
 * for every caller's real argument shape, that screenAttached:false removes exactly four spans
 * and nothing else out of the 152-line template, and that session_retrospective is indifferent
 * to the flag.
 *
 * The baseline is read out of commit b6e598e with git show rather than pasted in as a literal,
 * so the comparison tracks what actually shipped. An unreachable b6e598e hard-fails rather than
 * skipping, because a skip would quietly retire the one property that protects Ask.
 *
 * better-sqlite3 in this repo is built for node 20 and this script runs under node 18, where
 * requiring it throws ERR_DLOPEN_FAILED, so the live settings DB is read by shelling out to
 * /usr/bin/sqlite3. The running app holds a write lock on that file, which makes even a readonly
 * open fail with error 14, so the probe queries a copy and deletes it in cleanup.
 *
 * Nothing here asserts what the model answers. The passive-mode probe sends one ambiguous
 * transcript through both variants over several interleaved rounds and reports how often each
 * went passive, because an assertion on a model's answer is flaky by construction. The probe
 * also does not reproduce any caller's exact user
 * turn. Listen's real user message demands a structured summary and Ask's is the typed question,
 * and either one decides the passive-mode question before the system prompt gets a say.
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BUILDER_MODULE = '../src/features/common/prompts/promptBuilder';
const { getSystemPrompt } = require(BUILDER_MODULE);

const REPO_ROOT = path.join(__dirname, '..');
const PROMPT_DIR = 'src/features/common/prompts';
const BASELINE_COMMIT = 'b6e598e';

const LIVE_DB = path.join(os.homedir(), 'Library', 'Application Support', 'Glass', 'pickleglass.db');
const SQLITE = '/usr/bin/sqlite3';
const PASSIVE_LINE = 'Not sure what you need help with right now';
const PROBE_ROUNDS = 5;

// The pre-flag baseline. b6e598e's getSystemPrompt('pickle_glass_analysis', '', false, null)
// hashed to this, which is the exact prompt three summaryService callers and Ask were all
// sending before the flag existed. A changed hash means the screen-aware prompt drifted away
// from what shipped, whatever the rest of this file says.
const SCREEN_AWARE_SHA256 = '69d96f88e851b1f2451f9dacf4f4b243506b0c6fe5575bddd2d0ba6447a4eb6c';

const CONVERSATION_HISTORY_ARG = 'me: can you walk me through the retry path\nthem: it backs off twice then gives up';
const PRE_CONTEXT = '=== repo: example @ abc1234 ===\nsrc/index.js\nmodule.exports = 1;';

const SCREEN_PRIORITY_TAG = 'screen_problem_solving_priority';

const PASSIVE_SCREEN_CONDITION = "- There is no clear or visible problem or action item present on the user's screen that you could solve or assist with.";

const SPAN_OBJECTIVE_CLAUSE = "the user's screen (the screenshot attached) and ";

// The template indents every continuation line with 4 spaces and spells its blank separator
// lines as 4 spaces rather than as empty lines, so the whitespace-only lines appear here as
// INDENT. Written as literal trailing spaces they would not survive the first editor that trims
// them, and the span would silently stop matching.
const INDENT = '    ';
const SPAN_SCREEN_PRIORITY_BLOCK = [
    '<screen_problem_solving_priority>',
    '    <screen_directive>',
    '    Solve problems visible on the screen if there is a very clear problem + use the screen only if relevant for helping with the audio conversation.',
    '    </screen_directive>',
    INDENT,
    '    <screen_usage_guidelines>',
    '    <screen_example>',
    "    If there is a leetcode problem on the screen, and the conversation is small talk / general talk, you DEFINITELY should solve the leetcode problem. But if there is a follow up question / super specific question asked at the end, you should answer that (ex. What's the runtime complexity), using the screen as additional context.",
    '    </screen_example>',
    '    </screen_usage_guidelines>',
    '    </screen_problem_solving_priority>',
    INDENT,
    INDENT,
].join('\n');

// The bullet carries its own line break and the 4 spaces that indent the bullet after it, since
// the template puts the conditional at the start of that line rather than the end of this one.
const SPAN_PASSIVE_CONDITION = `${PASSIVE_SCREEN_CONDITION}\n    `;

const SPAN_VISIBLE_ELEMENTS = 'visible screen elements or ';

const REMOVED_SPANS = [
    { name: 'the screenshot clause in the objective', text: SPAN_OBJECTIVE_CLAUSE },
    { name: `the ${SCREEN_PRIORITY_TAG} block`, text: SPAN_SCREEN_PRIORITY_BLOCK },
    { name: 'the passive-mode screen condition', text: SPAN_PASSIVE_CONDITION },
    { name: 'the visible-screen-elements clause', text: SPAN_VISIBLE_ELEMENTS },
];

const BASELINE_CASES = [
    {
        label: "askService's shape, a conversation history in customPrompt and a repo-pack preContext",
        profile: 'pickle_glass_analysis',
        customPrompt: CONVERSATION_HISTORY_ARG,
        googleSearchEnabled: false,
        preContext: PRE_CONTEXT,
    },
    {
        label: "summaryService's shape, an empty customPrompt and a carried-over preContext",
        profile: 'pickle_glass_analysis',
        customPrompt: '',
        googleSearchEnabled: false,
        preContext: PRE_CONTEXT,
    },
    {
        label: "summaryService's shape on the first run, before any preContext exists",
        profile: 'pickle_glass_analysis',
        customPrompt: '',
        googleSearchEnabled: false,
        preContext: null,
    },
    {
        label: "summaryService's retrospective shape",
        profile: 'session_retrospective',
        customPrompt: '',
        googleSearchEnabled: false,
        preContext: PRE_CONTEXT,
    },
    {
        label: 'googleSearchEnabled true, which no caller passes but the signature still accepts',
        profile: 'pickle_glass_analysis',
        customPrompt: '',
        googleSearchEnabled: true,
        preContext: PRE_CONTEXT,
    },
];

// Ambiguous on purpose. Passive mode needs every one of its conditions to hold, and a transcript
// only controls two of them, so this one ends on a flat statement rather than a question and puts
// no proper noun in its last 15 words. Both of those hold here whichever variant runs, which
// leaves the screen condition as the one the two variants disagree about. A transcript ending on
// a question would falsify the first condition and make both variants answer, which would say
// nothing about the flag.
const PROBE_TRANSCRIPT = [
    'me: so the deadline moved. we have until the end of next week now.',
    'them: ok. that helps a little.',
    'me: yeah, it takes some of the pressure off.',
    'them: i still want to go back through the numbers from last quarter before i say anything.',
    'me: makes sense.',
    'them: i think i will just sit with it for a while and see what shakes out.',
].join('\n');

// The Messages API requires a user turn. This one is deliberately non-directive, because the
// instruction under test lives entirely in the system block.
const PROBE_USER_TURN = 'Respond now, following the system prompt.';

let scratch = null;

function check(ok, message) {
    assert.ok(ok, message);
    console.log(`ok   ${message}`);
}

function occurrences(text, needle) {
    let count = 0;
    let at = text.indexOf(needle);
    while (at !== -1) {
        count += 1;
        at = text.indexOf(needle, at + needle.length);
    }
    return count;
}

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function screenAware(overrides = {}) {
    return getSystemPrompt({
        profile: 'pickle_glass_analysis',
        customPrompt: '',
        googleSearchEnabled: false,
        preContext: null,
        screenAttached: true,
        ...overrides,
    });
}

function screenFree(overrides = {}) {
    return screenAware({ ...overrides, screenAttached: false });
}

function loadBaselineBuilder() {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-screen-aware-prompt-'));
    try {
        for (const name of ['promptTemplates.js', 'promptBuilder.js']) {
            const source = execFileSync('git', ['-C', REPO_ROOT, 'show', `${BASELINE_COMMIT}:${PROMPT_DIR}/${name}`],
                // git's own fatal line would otherwise land on the terminal ahead of the FAILED
                // message that explains what it means.
                { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
            fs.writeFileSync(path.join(scratch, name), source);
        }
    } catch (err) {
        throw new Error(`commit ${BASELINE_COMMIT} is unreachable from ${REPO_ROOT}, so the pre-flag`
            + ' baseline cannot be rebuilt and the byte-identity property cannot be checked at all'
            + ` (${String(err.message).trim().split('\n')[0]})`);
    }
    return require(path.join(scratch, 'promptBuilder.js'));
}

function checkBaselineIdentity(baseline) {
    // Both signatures report a Function.length of 1, so the form has to be established by where
    // each one picks preContext up from.
    check(baseline.getSystemPrompt('pickle_glass_analysis', '', false, PRE_CONTEXT).includes(PRE_CONTEXT)
        && !baseline.getSystemPrompt({ profile: 'pickle_glass_analysis', preContext: PRE_CONTEXT }).includes(PRE_CONTEXT),
        `the builder recovered from ${BASELINE_COMMIT} takes preContext as its fourth positional`
        + ' argument and ignores an options object, so it is the pre-flag form and not a second'
        + ' copy of the one in the worktree');
    check(getSystemPrompt({ profile: 'pickle_glass_analysis', preContext: PRE_CONTEXT }).includes(PRE_CONTEXT)
        && !getSystemPrompt('pickle_glass_analysis', '', false, PRE_CONTEXT).includes(PRE_CONTEXT),
        'the builder in the worktree takes preContext from its options object and ignores positional'
        + ' arguments, so the old call shape is gone with no shim');

    for (const c of BASELINE_CASES) {
        const before = baseline.getSystemPrompt(c.profile, c.customPrompt, c.googleSearchEnabled, c.preContext);
        const after = getSystemPrompt({ ...c, screenAttached: true });
        check(before === after,
            `screenAttached:true on ${c.profile} reproduces ${BASELINE_COMMIT} byte for byte for ${c.label}`);
    }

    check(sha256(screenAware()) === SCREEN_AWARE_SHA256,
        'the screen-aware pickle_glass_analysis prompt still hashes to the recorded pre-flag baseline');
}

function checkScreenFreeAbsences() {
    const free = screenFree();
    const absences = [
        ['screenshot attached', 'the claim that a screenshot is attached'],
        [`<${SCREEN_PRIORITY_TAG}>`, `the ${SCREEN_PRIORITY_TAG} block`],
        [PASSIVE_SCREEN_CONDITION, 'the passive-mode condition about a problem visible on the screen'],
        ['visible screen elements', 'the instruction to reference visible screen elements'],
    ];
    for (const [needle, description] of absences) {
        check(!free.includes(needle), `the screen-free prompt does not contain ${description}`);
    }
}

function checkScreenFreeRetention() {
    const aware = screenAware();
    const free = screenFree();

    const tags = [...new Set([...aware.matchAll(/<([a-z_]+_priority)>/g)].map(match => match[1]))];
    check(tags.includes(SCREEN_PRIORITY_TAG) && tags.length >= 5,
        `scanning the screen-aware prompt finds ${tags.length} priority blocks including`
        + ` ${SCREEN_PRIORITY_TAG}, so the list below is derived from the template rather than assumed`);

    for (const tag of tags.filter(name => name !== SCREEN_PRIORITY_TAG)) {
        check(free.includes(`<${tag}>`) && free.includes(`</${tag}>`),
            `the screen-free prompt keeps the ${tag} block, opening and closing tag both`);
    }

    check(occurrences(aware, '{{CONVERSATION_HISTORY}}') === 1
        && occurrences(free, '{{CONVERSATION_HISTORY}}') === 1,
        'both variants carry the {{CONVERSATION_HISTORY}} token exactly once, which is what the'
        + ' callers\' single-occurrence replace needs to substitute the transcript');

    const withCustom = screenFree({ customPrompt: CONVERSATION_HISTORY_ARG, preContext: PRE_CONTEXT });
    check(withCustom.includes(`\n\nUser-provided context\n-----\n${CONVERSATION_HISTORY_ARG}\n-----\n`),
        'the screen-free prompt wraps customPrompt in the User-provided context region unchanged');
    check(withCustom.includes(`\n\nPre-loaded session context\n-----\n${PRE_CONTEXT}\n-----\n`),
        'the screen-free prompt wraps preContext in the Pre-loaded session context region unchanged');
    check(!free.includes('Pre-loaded session context'),
        'the screen-free prompt omits the Pre-loaded session context region when preContext is null');
}

function checkRetrospectiveIndifference() {
    for (const preContext of [PRE_CONTEXT, null]) {
        const aware = getSystemPrompt({ profile: 'session_retrospective', customPrompt: '', googleSearchEnabled: false, preContext, screenAttached: true });
        const free = getSystemPrompt({ profile: 'session_retrospective', customPrompt: '', googleSearchEnabled: false, preContext, screenAttached: false });
        check(aware === free,
            `session_retrospective ${preContext ? 'with' : 'without'} a preContext is byte-identical`
            + ' under both flag values, because it never mentions the screen');
    }
}

function checkSpanConstruction() {
    const aware = screenAware();
    const free = screenFree();
    let reduced = aware;

    for (const span of REMOVED_SPANS) {
        check(occurrences(aware, span.text) === 1,
            `${span.name} occurs exactly once in the screen-aware prompt, so removing it is unambiguous`);
        reduced = reduced.replace(span.text, '');
    }

    check(reduced === free,
        'deleting those four spans from the screen-aware prompt yields the screen-free prompt byte'
        + ' for byte, so the flag changed those four spans and nothing else in the template');

    const sizes = REMOVED_SPANS.map(span => `${span.name} ${Buffer.byteLength(span.text)} B`);
    const total = REMOVED_SPANS.reduce((sum, span) => sum + Buffer.byteLength(span.text), 0);
    console.log(`\ninfo removed spans: ${sizes.join(', ')}; ${total} B in all, against a`
        + ` ${Buffer.byteLength(aware) - Buffer.byteLength(free)} B difference between the variants\n`);
}

function redact(text, secret) {
    if (!secret) return text;
    return String(text).split(secret).join('<redacted>');
}

/**
 * Returns the active LLM row, or a { skip } reason. The row is read from a copy because the
 * running app's write lock makes sqlite3 fail with error 14 on the live file.
 */
function readActiveProvider() {
    if (!fs.existsSync(LIVE_DB)) return { skip: `no settings DB at ${LIVE_DB}` };
    if (!fs.existsSync(SQLITE)) return { skip: `no sqlite3 binary at ${SQLITE}` };

    const copy = path.join(scratch, 'pickleglass-copy.db');
    fs.copyFileSync(LIVE_DB, copy);
    for (const sidecar of ['-wal', '-shm']) {
        if (fs.existsSync(LIVE_DB + sidecar)) fs.copyFileSync(LIVE_DB + sidecar, copy + sidecar);
    }

    const sql = 'SELECT provider, selected_llm_model, api_key FROM provider_settings WHERE is_active_llm=1 LIMIT 1;';
    const row = execFileSync(SQLITE, [copy, sql], { encoding: 'utf8' }).trim();
    if (!row) return { skip: 'no provider_settings row has is_active_llm=1' };

    const [provider, model, ...rest] = row.split('|');
    const apiKey = rest.join('|');
    if (!apiKey) return { skip: `the active provider ${provider} has no stored key` };
    if (provider !== 'anthropic') return { skip: `the active provider is ${provider}, which this probe cannot speak to` };
    if (!model) return { skip: `the active provider ${provider} has no selected_llm_model` };
    return { provider, model, apiKey };
}

async function askOnce(systemPrompt, model, apiKey) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': apiKey,
        },
        body: JSON.stringify({
            model,
            max_tokens: 300,
            system: systemPrompt,
            messages: [{ role: 'user', content: PROBE_USER_TURN }],
        }),
    });
    if (!res.ok) throw new Error(`the API answered HTTP ${res.status}`);
    const body = await res.json();
    return (body.content || []).filter(block => block.type === 'text').map(block => block.text).join('').trim();
}

/**
 * Reports, never asserts. The question is whether dropping the screen condition makes Listen's
 * periodic analysis fall into passive mode, and the answer is a model behaviour that can differ
 * between two runs of the same prompt.
 *
 * Hence the arms are run round-robin rather than one arm then the other, and each is sampled
 * PROBE_ROUNDS times. finding-ttft-vs-prompt-size.md records that every wrong turn in this
 * project's measurement came from reading too few samples of a high-variance quantity, and that
 * non-interleaved arms picked up drift between them. A single call per arm here would report an
 * anecdote as though it were a rate.
 */
async function probePassiveMode() {
    let apiKey = null;
    try {
        const active = readActiveProvider();
        if (active.skip) {
            console.log(`skip passive-mode probe: ${active.skip}`);
            return;
        }
        apiKey = active.apiKey;
        console.log(`info passive-mode probe against ${active.provider} ${active.model},`
            + ` ${PROBE_ROUNDS} interleaved rounds per variant\n`);

        const arms = [['screen-aware', true], ['screen-free', false]];
        const prompts = new Map(arms.map(([variant, flag]) => [variant, getSystemPrompt({
            profile: 'pickle_glass_analysis',
            customPrompt: '',
            googleSearchEnabled: false,
            preContext: null,
            screenAttached: flag,
        }).replace('{{CONVERSATION_HISTORY}}', PROBE_TRANSCRIPT)]));

        const passive = new Map(arms.map(([variant]) => [variant, 0]));
        const firstReply = new Map();
        for (let round = 0; round < PROBE_ROUNDS; round += 1) {
            for (const [variant] of arms) {
                const reply = await askOnce(prompts.get(variant), active.model, apiKey);
                if (reply.includes(PASSIVE_LINE)) passive.set(variant, passive.get(variant) + 1);
                if (!firstReply.has(variant)) firstReply.set(variant, reply);
            }
        }

        for (const [variant] of arms) {
            console.log(`observation the ${variant} variant entered passive mode in`
                + ` ${passive.get(variant)} of ${PROBE_ROUNDS} rounds, counted by whether the reply`
                + ` contains "${PASSIVE_LINE}"`);
        }
        for (const [variant] of arms) {
            console.log(`\n--- ${variant}, round 1 reply in full ---\n${firstReply.get(variant)}`);
        }
        console.log(`\nobservation nothing above is asserted. A model answer is not a property of this`
            + ` diff, and ${PROBE_ROUNDS} rounds on one transcript bounds a rate loosely at best.`);
    } catch (err) {
        console.log(`skip passive-mode probe: ${redact(err.message, apiKey)}`);
    }
}

async function main() {
    const baseline = loadBaselineBuilder();
    checkBaselineIdentity(baseline);
    checkScreenFreeAbsences();
    checkScreenFreeRetention();
    checkRetrospectiveIndifference();
    checkSpanConstruction();
    await probePassiveMode();
}

function cleanup() {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
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
