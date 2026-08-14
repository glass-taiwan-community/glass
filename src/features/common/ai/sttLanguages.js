// sttLanguages.js
//
// Providers disagree on how to name the same language, so the user-facing choice is stored as a
// neutral value ('en' | 'zh') and translated to a provider-specific code at the call site.
// Storing a raw provider code instead would break the moment the user switches STT provider.
//
// Verified against live audio:
//   OpenAI   expects ISO-639-1        -> 'zh'     ('zh-TW' is not its convention)
//   Deepgram expects BCP-47           -> 'zh-TW'  (it also supports zh-Hant / zh-HK / zh-CN)
//
// Gemini and Whisper are documented here but NOT verified, and are deliberately not wired up in
// v1 - see .serena/memories/stt_language_selection_plan.md. Gemini keeps falling back to its own
// 'en-US' default and Whisper stays on '--language auto', exactly as before this feature.

/** Neutral values that may be persisted in users.stt_language. */
const SUPPORTED_STT_LANGUAGES = ['en', 'zh'];

/** Labels for the settings dropdown. */
const STT_LANGUAGE_LABELS = {
    en: 'English',
    zh: '繁體中文',
};

const PROVIDER_LANGUAGE_CODES = {
    en: {
        openai: 'en',
        'openai-glass': 'en',
        deepgram: 'en',
        gemini: 'en-US',   // UNVERIFIED - not applied, see VERIFIED_PROVIDERS
        whisper: 'en',     // UNVERIFIED - not applied, see VERIFIED_PROVIDERS
    },
    zh: {
        openai: 'zh',      // verified: ISO-639-1; 'zh-TW' is not accepted here
        'openai-glass': 'zh',
        deepgram: 'zh-TW', // verified: Traditional Mandarin
        gemini: 'zh-TW',   // UNVERIFIED - not applied, see VERIFIED_PROVIDERS
        whisper: 'zh',     // UNVERIFIED - not applied, see VERIFIED_PROVIDERS
    },
};

// v1 applies the setting only to providers whose codes were confirmed against live audio.
// Gemini and Whisper keep their existing behaviour rather than being sent a guessed code: a
// wrong language hint degrades transcription quietly, which is exactly the class of bug this
// feature exists to fix. Their codes above are recorded so the gap is visible; move a provider
// into this set once its code has actually been tested.
const VERIFIED_PROVIDERS = new Set(['openai', 'openai-glass', 'deepgram']);

/**
 * Translate a stored neutral language value into the code a given provider expects.
 *
 * Returns undefined when there is no mapping, which is meaningful rather than an error: the
 * call chain treats undefined as "no language configured", so OpenAI omits the field and
 * auto-detects while Deepgram and Gemini fall back to their own defaults. That keeps unverified
 * providers on exactly their pre-existing behaviour instead of sending them a guessed code.
 *
 * @param {string|undefined} language - neutral value, e.g. 'en' or 'zh'
 * @param {string|undefined} provider - provider id, e.g. 'openai' or 'deepgram'
 * @returns {string|undefined} provider-specific code, or undefined if unmapped
 */
function resolveSttLanguage(language, provider) {
    if (!language || !provider) return undefined;
    if (!VERIFIED_PROVIDERS.has(provider)) return undefined;
    return PROVIDER_LANGUAGE_CODES[language]?.[provider];
}

module.exports = {
    SUPPORTED_STT_LANGUAGES,
    VERIFIED_PROVIDERS,
    STT_LANGUAGE_LABELS,
    PROVIDER_LANGUAGE_CODES,
    resolveSttLanguage,
};
