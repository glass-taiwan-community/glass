#!/usr/bin/env node
/**
 * LiteLLM proxy connectivity check.
 *
 * Verifies, in one run, everything Glass needs from an LLM gateway:
 *   1. Credentials are present
 *   2. The HTTP route answers and the key is accepted
 *   3. Which models are usable as chat LLMs (after filtering out embeddings/image/TTS/etc.)
 *   4. Whether the Realtime WebSocket route is proxied - which decides whether speech-to-text
 *      can also go through the gateway, or must keep its own vendor key
 *
 * Reads credentials from .env (same file the app uses), so no secret ever appears in argv or
 * shell history. This matters when running over SSH.
 *
 *   node scripts/check-litellm.js
 */

require('dotenv').config();

const path = require('node:path');
const WebSocket = require('ws');
const { toChatModels, normalizeBaseUrl, toRootUrl } = require(
    path.join(__dirname, '..', 'src', 'features', 'common', 'ai', 'providers', 'litellm.js')
);

const KEY = process.env.LITELLM_API_KEY?.trim();
const RAW_BASE = process.env.LITELLM_BASE_URL?.trim();

const pass = m => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const fail = m => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const info = m => console.log(`        ${m}`);

/**
 * Probes the Realtime WebSocket endpoint the way Glass's STT connects.
 * @param {string} wsUrl
 * @param {{label: string, headers: object}} variant
 * @returns {Promise<{ok: boolean, status: number|null, detail: string}>}
 */
function probeWebSocket(wsUrl, variant) {
    return new Promise(resolve => {
        const ws = new WebSocket(wsUrl, { headers: variant.headers });
        const done = r => { try { ws.close(); } catch {} resolve(r); };
        const timer = setTimeout(() => done({ ok: false, status: null, detail: 'timed out after 10s' }), 10000);

        ws.on('open', () => { clearTimeout(timer); done({ ok: true, status: 101, detail: 'handshake accepted' }); });
        // Fires when the server refuses the upgrade; carries the HTTP status, which is the
        // whole point - 404 (not routed) and 401 (routed, auth differs) mean different things.
        ws.on('unexpected-response', (_req, res) => {
            clearTimeout(timer);
            done({ ok: false, status: res.statusCode, detail: `HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim() });
        });
        ws.on('error', err => { clearTimeout(timer); done({ ok: false, status: null, detail: err.message }); });
    });
}

(async () => {
    console.log('\nLiteLLM proxy check\n' + '='.repeat(60));

    // --- 1. Credentials present ---
    console.log('\n[1] Credentials (.env)');
    if (!KEY) { fail('LITELLM_API_KEY is not set'); process.exit(2); }
    if (!RAW_BASE) { fail('LITELLM_BASE_URL is not set'); process.exit(2); }
    pass(`LITELLM_API_KEY is set (${KEY.length} chars, not shown)`);
    pass(`LITELLM_BASE_URL = ${RAW_BASE}`);

    if (/<.*>/.test(RAW_BASE)) {
        fail('URL still contains a <placeholder> - replace it with your real environment');
        process.exit(2);
    }

    const base = normalizeBaseUrl(RAW_BASE);
    const root = toRootUrl(base);
    if (root !== base) {
        info(`note: URL targets the Anthropic passthrough; management API lives at ${root}`);
    }

    // --- 2 & 3. HTTP route, auth, and catalogue ---
    console.log('\n[2] HTTP route + model catalogue');
    let chatModels = [];
    try {
        const res = await fetch(`${root}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
        if (!res.ok) {
            fail(`GET ${root}/v1/models -> HTTP ${res.status}`);
            if (res.status === 401 || res.status === 403) info('key rejected - check LITELLM_API_KEY');
            if (res.status === 404) info('root route not exposed; this deployment may be passthrough-only');
            process.exit(1);
        }
        const body = await res.json();
        const advertised = body.data || [];
        chatModels = toChatModels(advertised);

        pass(`GET /v1/models -> HTTP 200`);
        pass(`${advertised.length} models advertised, ${chatModels.length} usable as chat LLMs`);
        info(`filtered out ${advertised.length - chatModels.length} (embeddings, image, TTS, STT, moderation, wildcards)`);
        info('sample chat models:');
        for (const m of chatModels.slice(0, 8)) info(`  ${m.id}`);
        if (chatModels.length > 8) info(`  ... and ${chatModels.length - 8} more`);
    } catch (err) {
        fail(`could not reach ${root}: ${err.message}`);
        process.exit(1);
    }

    // --- 4. Realtime WebSocket (decides whether STT can use the gateway) ---
    console.log('\n[3] Realtime WebSocket route (for speech-to-text)');
    const wsUrl = root.replace(/^http/, 'ws') + '/v1/realtime?intent=transcription';
    info(`${wsUrl}`);

    // LiteLLM documents Bearer for most routes but `api-key` in its realtime example, so
    // testing only one style would turn a header mismatch into a false "not supported".
    const variants = [
        { label: 'Authorization: Bearer', headers: { Authorization: `Bearer ${KEY}`, 'OpenAI-Beta': 'realtime=v1' } },
        { label: 'api-key', headers: { 'api-key': KEY, 'OpenAI-Beta': 'realtime=v1' } },
        { label: 'x-api-key', headers: { 'x-api-key': KEY, 'OpenAI-Beta': 'realtime=v1' } },
    ];

    const results = [];
    for (const v of variants) {
        const r = await probeWebSocket(wsUrl, v);
        results.push(r);
        (r.ok ? pass : fail)(`${v.label.padEnd(22)} ${r.detail}`);
    }

    // --- Verdict ---
    console.log('\n' + '='.repeat(60));
    const connected = results.find(r => r.ok);
    const anyAuthError = results.some(r => r.status === 401 || r.status === 403);
    const allNotFound = results.every(r => r.status === 404);

    console.log(`LLM via LiteLLM:  READY (${chatModels.length} chat models available)`);
    if (connected) {
        console.log('STT via LiteLLM:  ROUTE EXISTS - realtime transcription could move to the gateway too');
    } else if (allNotFound) {
        console.log('STT via LiteLLM:  NOT ROUTED (404) - speech-to-text must keep its own vendor key');
    } else if (anyAuthError) {
        console.log('STT via LiteLLM:  ROUTED BUT AUTH DIFFERS (401/403) - fixable, needs the right header');
    } else {
        console.log('STT via LiteLLM:  INCONCLUSIVE - see the errors above');
    }
    console.log();
})();
