#!/usr/bin/env node
/**
 * node scripts/verify-ask-tuning.js
 *
 * Exits 0 only when every assertion holds. Covers the two Ask-tuning settings and the model
 * resolution they feed.
 *
 * Under plain node, electron-store resolves its directory from the nodejs app name, so the file
 * exercised here is ~/Library/Preferences/electron-store-nodejs/pickle-glass-settings.json, NOT
 * the packaged app's userData copy. The same electron-store code path runs against a sibling
 * file, so this script cannot read or corrupt live app config. It still restores the exact prior
 * state of its two keys, because that sibling file is shared with every other plain-node run.
 *
 * Nothing here asserts a timing. Timings are measured in the running app; a timing assertion in a
 * script is flaky by construction.
 */

const assert = require('node:assert');
const Store = require('electron-store');

const SETTINGS_MODULE = '../src/features/settings/settingsService';
const MODEL_STATE_MODULE = '../src/features/common/services/modelStateService';
const PROVIDER_REPO_MODULE = '../src/features/common/repositories/providerSettings';

const settingsService = require(SETTINGS_MODULE);
const modelStateService = require(MODEL_STATE_MODULE);
const providerSettingsRepository = require(PROVIDER_REPO_MODULE);

const OVERRIDE_KEY = 'askModelOverride';
const ATTACH_KEY = 'askAttachScreen';

// Deleting a key is not reachable through settingsService, so this second Store exists only for
// save, delete and restore bookkeeping; the production code deliberately shares its one instance.
const store = new Store({ name: 'pickle-glass-settings' });

// Obviously fake, so a failure dump can never leak a real secret.
const ACTIVE_ROW = {
    provider: 'anthropic',
    api_key: 'fake-anthropic-key-0001',
    base_url: null,
    selected_llm_model: 'claude-opus-4-8',
    selected_stt_model: null,
};
const GATEWAY_ROW = {
    provider: 'litellm',
    api_key: 'fake-litellm-key-0002',
    base_url: 'https://litellm.invalid/v1',
};
const KEYLESS_ROW = {
    provider: 'openai',
    api_key: null,
    base_url: null,
};
const PROVIDER_ROWS = {
    [ACTIVE_ROW.provider]: ACTIVE_ROW,
    [GATEWAY_ROW.provider]: GATEWAY_ROW,
    [KEYLESS_ROW.provider]: KEYLESS_ROW,
};

let saved = null;

function check(ok, message) {
    assert.ok(ok, message);
    console.log(`ok   ${message}`);
}

function saveSettings() {
    saved = {
        override: { present: store.has(OVERRIDE_KEY), value: store.get(OVERRIDE_KEY) },
        attach: { present: store.has(ATTACH_KEY), value: store.get(ATTACH_KEY) },
    };
}

function restoreKey(key, state) {
    if (!state) return;
    if (state.present) store.set(key, state.value);
    else store.delete(key);
}

async function checkDefaults() {
    store.delete(OVERRIDE_KEY);
    store.delete(ATTACH_KEY);

    check(await settingsService.getAskModelOverride() === null,
        'an absent askModelOverride reads as null, which means today\'s behavior exactly');
    check(await settingsService.getAskAttachScreen() === true,
        'an absent askAttachScreen reads as true, so the screenshot keeps being attached until someone opts out');
}

async function checkRoundTrip() {
    check((await settingsService.setAskAttachScreen(false)).success === true,
        'setAskAttachScreen(false) reports success');
    check(await settingsService.getAskAttachScreen() === false,
        'askAttachScreen round-trips false');
    check((await settingsService.setAskAttachScreen(true)).success === true
        && await settingsService.getAskAttachScreen() === true,
        'askAttachScreen round-trips true');

    const written = { provider: 'litellm', model: 'claude-haiku-4-5-20251001' };
    check((await settingsService.setAskModelOverride(written)).success === true,
        'setAskModelOverride reports success for { provider, model }');
    const read = await settingsService.getAskModelOverride();
    check(read !== null && read.provider === written.provider && read.model === written.model,
        `askModelOverride round-trips ${written.provider}/${written.model}`);

    check((await settingsService.setAskModelOverride(null)).success === true
        && await settingsService.getAskModelOverride() === null,
        'setAskModelOverride(null) makes the key read back as the documented default');
}

async function checkMalformedOverride() {
    store.set(OVERRIDE_KEY, { provider: 'anthropic' });
    check(await settingsService.getAskModelOverride() === null,
        'a stored override missing `model` reads as null instead of propagating a half-written shape');

    store.set(OVERRIDE_KEY, { model: 'claude-haiku-4-5-20251001' });
    check(await settingsService.getAskModelOverride() === null,
        'a stored override missing `provider` reads as null');

    store.set(OVERRIDE_KEY, 'claude-haiku-4-5-20251001');
    check(await settingsService.getAskModelOverride() === null,
        'a stored override that is not an object reads as null');

    store.set(OVERRIDE_KEY, { provider: 'anthropic', model: '   ' });
    check(await settingsService.getAskModelOverride() === null,
        'a stored override whose model is blank reads as null');

    store.set(OVERRIDE_KEY, { provider: ' anthropic ', model: ' claude-haiku-4-5-20251001 ' });
    const padded = await settingsService.getAskModelOverride();
    check(padded !== null && padded.provider === 'anthropic' && padded.model === 'claude-haiku-4-5-20251001',
        'a hand-edited override padded with spaces reads back trimmed, so it reaches getByProvider rather than missing it');

    check((await settingsService.setAskModelOverride({ provider: 'anthropic' })).success === false,
        'setAskModelOverride rejects an incomplete override rather than storing it');
    check((await settingsService.setAskModelOverride('anthropic')).success === false,
        'setAskModelOverride rejects a non-object override');

    store.delete(OVERRIDE_KEY);
}

async function checkResolveModelInfo() {
    const realGetActiveProvider = providerSettingsRepository.getActiveProvider;
    const realGetByProvider = providerSettingsRepository.getByProvider;

    // sqliteClient.getDb() is unavailable headless, so the two repository reads resolveModelInfo
    // makes are served from the fixture table above.
    providerSettingsRepository.getActiveProvider = async () => ACTIVE_ROW;
    providerSettingsRepository.getByProvider = async provider => PROVIDER_ROWS[provider] || null;

    try {
        const active = await modelStateService.getCurrentModelInfo('llm');
        check(active !== null && active.provider === ACTIVE_ROW.provider
            && active.model === ACTIVE_ROW.selected_llm_model
            && active.apiKey === ACTIVE_ROW.api_key,
            `the fixture's active llm is ${ACTIVE_ROW.provider}/${ACTIVE_ROW.selected_llm_model}`);

        const noOverride = await modelStateService.resolveModelInfo('llm', null);
        check(JSON.stringify(noOverride) === JSON.stringify(active),
            'resolveModelInfo(type, null) returns exactly what getCurrentModelInfo returns');

        const sameProvider = await modelStateService.resolveModelInfo('llm',
            { provider: ACTIVE_ROW.provider, model: 'claude-haiku-4-5-20251001' });
        check(sameProvider.provider === ACTIVE_ROW.provider
            && sameProvider.model === 'claude-haiku-4-5-20251001'
            && sameProvider.apiKey === ACTIVE_ROW.api_key
            && sameProvider.baseUrl === null,
            'a model-only override on the active provider returns that model with the active provider\'s key');

        const crossProvider = await modelStateService.resolveModelInfo('llm',
            { provider: GATEWAY_ROW.provider, model: 'anthropic/claude-haiku-4-5-20251001' });
        check(crossProvider.provider === GATEWAY_ROW.provider
            && crossProvider.apiKey === GATEWAY_ROW.api_key
            && crossProvider.apiKey !== ACTIVE_ROW.api_key
            && crossProvider.baseUrl === GATEWAY_ROW.base_url,
            `the trap: an override naming ${GATEWAY_ROW.provider} carries ${GATEWAY_ROW.provider}'s own key`
            + ` and base URL, never ${ACTIVE_ROW.provider}'s key pointed at ${GATEWAY_ROW.provider}'s endpoint`);

        // The reverse direction, because ACTIVE_ROW's base_url is null: without it, a resolver
        // written as `active.baseUrl || row.base_url` would still satisfy the assertion above.
        providerSettingsRepository.getActiveProvider = async () => ({ ...GATEWAY_ROW, selected_llm_model: 'anthropic/claude-opus-4-8' });
        const reversed = await modelStateService.resolveModelInfo('llm',
            { provider: ACTIVE_ROW.provider, model: 'claude-haiku-4-5-20251001' });
        check(reversed.apiKey === ACTIVE_ROW.api_key && reversed.baseUrl === null,
            `the same trap reversed: with ${GATEWAY_ROW.provider} active, an override naming`
            + ` ${ACTIVE_ROW.provider} drops ${GATEWAY_ROW.provider}'s base URL rather than keeping it`);
        providerSettingsRepository.getActiveProvider = async () => ACTIVE_ROW;

        const keyless = await modelStateService.resolveModelInfo('llm',
            { provider: KEYLESS_ROW.provider, model: 'gpt-4o' });
        check(keyless.provider === ACTIVE_ROW.provider
            && keyless.model === ACTIVE_ROW.selected_llm_model
            && keyless.apiKey === ACTIVE_ROW.api_key,
            `an override naming ${KEYLESS_ROW.provider}, which has no stored key, falls back to the active model`
            + ' with the active key rather than to a keyless object');

        const unknown = await modelStateService.resolveModelInfo('llm',
            { provider: 'no-such-provider', model: 'whatever' });
        check(unknown.apiKey === ACTIVE_ROW.api_key,
            'an override naming a provider with no stored row at all falls back to the active model');

        providerSettingsRepository.getByProvider = async () => { throw new Error('fixture: db is gone'); };
        const thrown = await modelStateService.resolveModelInfo('llm',
            { provider: GATEWAY_ROW.provider, model: 'anthropic/claude-haiku-4-5-20251001' });
        check(thrown.apiKey === ACTIVE_ROW.api_key,
            'a throwing provider read falls back to the active model instead of propagating');
    } finally {
        providerSettingsRepository.getActiveProvider = realGetActiveProvider;
        providerSettingsRepository.getByProvider = realGetByProvider;
    }
}

async function main() {
    console.log(`info electron-store under plain node: ${store.path}\n`);
    saveSettings();
    await checkDefaults();
    await checkRoundTrip();
    await checkMalformedOverride();
    await checkResolveModelInfo();
}

function cleanup() {
    if (!saved) return;
    restoreKey(OVERRIDE_KEY, saved.override);
    restoreKey(ATTACH_KEY, saved.attach);
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
