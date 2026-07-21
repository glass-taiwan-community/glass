/**
 * LiteLLM proxy provider.
 *
 * Routes LLM traffic through a LiteLLM gateway instead of a vendor API, so Glass works in
 * environments where personal vendor keys are disabled and only a gateway service key is issued.
 *
 * LiteLLM exposes two different wire formats on the same host:
 *
 *   1. Native / OpenAI-compatible, at the root:   {root}/v1/chat/completions
 *   2. Anthropic passthrough, under a subpath:    {root}/anthropic/v1/messages
 *
 * Which of these a given deployment exposes is a deployment decision we cannot detect ahead of
 * time, so the format is derived from the configured URL exactly the way LiteLLM itself routes:
 * a trailing `/anthropic` means passthrough, anything else means the native OpenAI-compatible API.
 *
 * Auth: the native route is documented with `Authorization: Bearer`, the passthrough route is
 * documented with `Authorization: bearer` while the Anthropic SDK natively sends `x-api-key`.
 * Both headers are sent on the Anthropic route. A proxy that reads only one ignores the other,
 * and this provider never contacts api.anthropic.com, so no vendor credential is ever exposed
 * to a third party by the redundant header.
 *
 * STT is intentionally not implemented here — Glass keeps using its existing STT provider.
 */

const { Anthropic } = require('@anthropic-ai/sdk');

/** Used only when a passthrough-only deployment cannot serve a model list. */
const FALLBACK_MODELS = [
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (LiteLLM)' },
];

/**
 * Entries from /v1/models that are NOT usable as a chat LLM.
 *
 * A production gateway advertises its whole catalogue - embeddings, image generation, TTS,
 * transcription, moderation, video - alongside chat models, plus `provider/*` wildcard routing
 * entries that are not selectable models at all. Offering those in the model picker would let a
 * user select something that cannot answer a chat request, so they are excluded up front.
 */
const NON_CHAT_MODEL_PATTERNS = [
    /\*/,                          // wildcard routes, e.g. "anthropic/*"
    /\d+-x-\d+/,                   // sized image variants, e.g. "low/1024-x-1024/gpt-image-1"
    /embed/i,                      // text-embedding-3-large, snowflake-arctic-embed-m
    /(^|[/-])(gte|bge|e5)-/i,      // embedding families that never spell out "embed"
    /minilm/i,                     // sentence-embedding family
    /moderation/i,
    /(^|[/-])tts([/-]|$)/i,        // tts-1-hd, gpt-4o-mini-tts
    /whisper|transcribe/i,         // STT models: not chat, and Glass STT is configured separately
    /dall-e|gpt-image|chatgpt-image/i,
    /-image($|[-/])|image-preview/i,
    /sora/i,                       // video generation
    /(^|\/)container$/i,           // LiteLLM infrastructure entry, not a model
];

/**
 * True when the proxy's own metadata proves a model cannot serve a chat completion.
 *
 * More reliable than name matching: an embedding model advertises an input budget but no
 * output budget, because it emits vectors rather than tokens. Models that report neither
 * field are left alone - most chat models on a real gateway omit both.
 *
 * @param {object} model - Raw entry from /v1/models
 * @returns {boolean}
 */
function isNonChatByMetadata(model) {
    return model.max_input_tokens != null && !model.max_output_tokens;
}

/**
 * Filters a proxy's advertised catalogue down to models that can serve a chat completion.
 *
 * Accepts either raw /v1/models entries or bare id strings, so callers that only have ids
 * still get name-based filtering.
 *
 * @param {Array<object|string>} models - Entries from /v1/models
 * @returns {Array<{id: string, name: string}>} Selectable chat models, alphabetically sorted
 */
function toChatModels(models) {
    return models
        .map(m => (typeof m === 'string' ? { id: m } : m))
        .filter(m => m && typeof m.id === 'string' && m.id.length > 0)
        .filter(m => !isNonChatByMetadata(m))
        .filter(m => !NON_CHAT_MODEL_PATTERNS.some(re => re.test(m.id)))
        .map(m => m.id)
        .sort((a, b) => a.localeCompare(b))
        .map(id => ({ id, name: id }));
}

/**
 * Strips a trailing slash so URL joining never produces a double slash.
 * @param {string} baseUrl
 * @returns {string}
 */
function normalizeBaseUrl(baseUrl) {
    return (baseUrl || '').trim().replace(/\/+$/, '');
}

/**
 * True when the configured URL targets LiteLLM's Anthropic passthrough route.
 * @param {string} baseUrl - Already normalized
 * @returns {boolean}
 */
function isAnthropicRoute(baseUrl) {
    return /\/anthropic$/i.test(baseUrl);
}

/**
 * The gateway root, i.e. the URL with a passthrough subpath removed. Management endpoints
 * such as /v1/models live at the root even when chat traffic goes through a passthrough.
 * @param {string} baseUrl - Already normalized
 * @returns {string}
 */
function toRootUrl(baseUrl) {
    return baseUrl.replace(/\/anthropic$/i, '');
}

/**
 * Converts Glass's internal message array into Anthropic's system + messages shape.
 * Mirrors the translation in providers/anthropic.js, which askService and summaryService
 * already produce input for.
 * @param {Array<object>} messages
 * @returns {{systemPrompt: string, anthropicMessages: Array<object>}}
 */
function toAnthropicMessages(messages) {
    let systemPrompt = '';
    const anthropicMessages = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            systemPrompt = msg.content;
            continue;
        }

        let content;
        if (Array.isArray(msg.content)) {
            content = [];
            for (const part of msg.content) {
                if (typeof part === 'string') {
                    content.push({ type: 'text', text: part });
                } else if (part.type === 'text') {
                    content.push({ type: 'text', text: part.text });
                } else if (part.type === 'image_url' && part.image_url) {
                    const [mimeInfo, base64Data] = part.image_url.url.split(',');
                    const mimeType = mimeInfo.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
                    content.push({
                        type: 'image',
                        source: { type: 'base64', media_type: mimeType, data: base64Data },
                    });
                }
            }
        } else {
            content = [{ type: 'text', text: msg.content }];
        }

        anthropicMessages.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content,
        });
    }

    return { systemPrompt, anthropicMessages };
}

/**
 * Builds an Anthropic SDK client pointed at the proxy, sending both supported auth headers.
 * @param {string} apiKey
 * @param {string} baseUrl - Already normalized
 * @returns {Anthropic}
 */
function createAnthropicClient(apiKey, baseUrl) {
    return new Anthropic({
        apiKey,
        baseURL: baseUrl,
        defaultHeaders: { Authorization: `Bearer ${apiKey}` },
    });
}

class LiteLLMProvider {
    /**
     * Validates the gateway credentials and, as a side effect, discovers the model catalogue.
     *
     * A single GET {root}/v1/models proves three things at once: the URL is reachable, the key is
     * accepted, and which model aliases this deployment actually exposes. Model aliases are
     * deployment-specific, so assuming a hardcoded id would fail on most proxies.
     *
     * Deliberately does NOT check for an `sk-` prefix: LiteLLM virtual keys are arbitrary strings,
     * and the prefix check in providers/anthropic.js is precisely why a gateway key cannot be
     * entered against the stock Anthropic provider.
     *
     * @param {string} key - LiteLLM service/virtual key
     * @param {string} baseUrl - Proxy endpoint
     * @returns {Promise<{success: boolean, error?: string, models?: Array<{id: string, name: string}>}>}
     */
    static async validateApiKey(key, baseUrl) {
        if (!key || typeof key !== 'string' || !key.trim()) {
            return { success: false, error: 'LiteLLM API key cannot be empty.' };
        }

        const normalized = normalizeBaseUrl(baseUrl);
        if (!normalized) {
            return { success: false, error: 'LiteLLM base URL is required.' };
        }
        if (!/^https?:\/\//i.test(normalized)) {
            return { success: false, error: 'LiteLLM base URL must start with http:// or https://' };
        }

        const root = toRootUrl(normalized);

        try {
            const response = await fetch(`${root}/v1/models`, {
                headers: { Authorization: `Bearer ${key}` },
            });

            if (response.ok) {
                const body = await response.json().catch(() => ({}));
                const models = toChatModels(body.data || []);
                console.log(`[LiteLLMProvider] Discovered ${models.length} chat models (of ${(body.data || []).length} advertised).`);

                // A reachable proxy that lists nothing usable is still valid; fall back so the
                // user is not left with an empty model dropdown.
                return { success: true, models: models.length > 0 ? models : FALLBACK_MODELS };
            }

            // 401/403 mean the endpoint is right but the key is not. Report that plainly
            // rather than falling through to the probe, which would fail the same way.
            if (response.status === 401 || response.status === 403) {
                return { success: false, error: 'LiteLLM rejected the API key (unauthorized).' };
            }

            // Anything else (typically 404 on a passthrough-only deployment where the
            // management API is not exposed) falls back to probing the chat endpoint.
            return await LiteLLMProvider._probeCompletion(key, normalized);
        } catch (error) {
            console.error('[LiteLLMProvider] Network error during validation:', error);
            return { success: false, error: `Could not reach LiteLLM proxy at ${root}.` };
        }
    }

    /**
     * Fallback validation for deployments that do not expose /v1/models: issue the smallest
     * possible completion and treat a non-auth response as success.
     * @param {string} key
     * @param {string} baseUrl - Already normalized
     * @returns {Promise<{success: boolean, error?: string, models?: Array<object>}>}
     */
    static async _probeCompletion(key, baseUrl) {
        const anthropicRoute = isAnthropicRoute(baseUrl);
        const url = anthropicRoute ? `${baseUrl}/v1/messages` : `${baseUrl}/v1/chat/completions`;

        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
        };
        if (anthropicRoute) {
            headers['x-api-key'] = key;
            headers['anthropic-version'] = '2023-06-01';
        }

        // Both wire formats accept this same minimal shape, so no per-route body is needed.
        const body = {
            model: FALLBACK_MODELS[0].id,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'Hi' }],
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });

            if (response.status === 401 || response.status === 403) {
                return { success: false, error: 'LiteLLM rejected the API key (unauthorized).' };
            }

            // 400 means the request reached a real LLM endpoint and was understood well enough
            // to be rejected on content (e.g. unknown model alias) - the credentials are fine.
            if (response.ok || response.status === 400) {
                return { success: true, models: FALLBACK_MODELS };
            }

            const errorBody = await response.json().catch(() => ({}));
            const message = errorBody.error?.message || `Validation failed with status ${response.status}`;
            return { success: false, error: message };
        } catch (error) {
            console.error('[LiteLLMProvider] Network error during completion probe:', error);
            return { success: false, error: `Could not reach LiteLLM proxy at ${baseUrl}.` };
        }
    }
}

/**
 * Creates a non-streaming LLM instance backed by the LiteLLM proxy.
 * @param {object} opts
 * @param {string} opts.apiKey - LiteLLM service/virtual key
 * @param {string} opts.baseUrl - Proxy endpoint
 * @param {string} opts.model - Model alias as exposed by the proxy
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.maxTokens=4096]
 * @returns {object} LLM instance with generateContent() and chat()
 */
function createLLM({ apiKey, baseUrl, model, temperature = 0.7, maxTokens = 4096, ...config }) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) throw new Error('LiteLLM provider requires a base URL.');

    const anthropicRoute = isAnthropicRoute(normalized);

    /**
     * Single call path shared by generateContent() and chat().
     * @param {Array<object>} messages
     * @returns {Promise<{content: string, raw: object}>}
     */
    const callApi = async messages => {
        if (anthropicRoute) {
            const client = createAnthropicClient(apiKey, normalized);
            const { systemPrompt, anthropicMessages } = toAnthropicMessages(messages);

            const response = await client.messages.create({
                model,
                max_tokens: maxTokens,
                temperature,
                system: systemPrompt || undefined,
                messages: anthropicMessages,
            });

            return { content: response.content[0].text, raw: response };
        }

        const response = await fetch(`${normalized}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
        });

        if (!response.ok) {
            throw new Error(`LiteLLM API error: ${response.status} ${response.statusText}`);
        }

        const result = await response.json();
        return { content: result.choices[0].message.content.trim(), raw: result };
    };

    return {
        generateContent: async parts => {
            let systemPrompt = '';
            const userContent = [];

            for (const part of parts) {
                if (typeof part === 'string') {
                    if (systemPrompt === '' && part.includes('You are')) {
                        systemPrompt = part;
                    } else {
                        userContent.push({ type: 'text', text: part });
                    }
                } else if (part.inlineData) {
                    userContent.push({
                        type: 'image_url',
                        image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` },
                    });
                }
            }

            const messages = [];
            if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
            if (userContent.length > 0) messages.push({ role: 'user', content: userContent });

            const result = await callApi(messages);
            return {
                response: { text: () => result.content },
                raw: result.raw,
            };
        },

        chat: async messages => await callApi(messages),
    };
}

/**
 * Creates a streaming LLM instance backed by the LiteLLM proxy.
 *
 * Callers (askService, summaryService) parse an OpenAI-shaped SSE stream, so the Anthropic
 * route translates its event stream into that shape while the native route is passed through
 * untouched because LiteLLM already emits it.
 *
 * @param {object} opts
 * @param {string} opts.apiKey - LiteLLM service/virtual key
 * @param {string} opts.baseUrl - Proxy endpoint
 * @param {string} opts.model - Model alias as exposed by the proxy
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.maxTokens=4096]
 * @returns {object} Streaming LLM instance with streamChat()
 */
function createStreamingLLM({ apiKey, baseUrl, model, temperature = 0.7, maxTokens = 4096, ...config }) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) throw new Error('LiteLLM provider requires a base URL.');

    const anthropicRoute = isAnthropicRoute(normalized);

    return {
        streamChat: async messages => {
            console.log(`[LiteLLM Provider] Streaming via ${anthropicRoute ? 'Anthropic passthrough' : 'OpenAI-compatible'} route`);

            if (!anthropicRoute) {
                // LiteLLM's native route already speaks the SSE dialect the callers expect.
                const response = await fetch(`${normalized}/v1/chat/completions`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model,
                        messages,
                        temperature,
                        max_tokens: maxTokens,
                        stream: true,
                    }),
                });

                if (!response.ok) {
                    throw new Error(`LiteLLM API error: ${response.status} ${response.statusText}`);
                }
                return response;
            }

            const client = createAnthropicClient(apiKey, normalized);
            const { systemPrompt, anthropicMessages } = toAnthropicMessages(messages);

            const stream = new ReadableStream({
                async start(controller) {
                    try {
                        const source = await client.messages.create({
                            model,
                            max_tokens: maxTokens,
                            temperature,
                            system: systemPrompt || undefined,
                            messages: anthropicMessages,
                            stream: true,
                        });

                        for await (const chunk of source) {
                            if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
                                const data = JSON.stringify({
                                    choices: [{ delta: { content: chunk.delta.text || '' } }],
                                });
                                controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
                            }
                        }

                        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                        controller.close();
                    } catch (error) {
                        console.error('[LiteLLM Provider] Streaming error:', error);
                        controller.error(error);
                    }
                },
            });

            return new Response(stream, {
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive',
                },
            });
        },
    };
}

module.exports = {
    LiteLLMProvider,
    createLLM,
    createStreamingLLM,
    // Exported for reuse by modelStateService and for unit testing the routing rules.
    normalizeBaseUrl,
    isAnthropicRoute,
    toRootUrl,
    toChatModels,
};
