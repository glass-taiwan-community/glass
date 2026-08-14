const OpenAI = require('openai');
const WebSocket = require('ws');
const { Portkey } = require('portkey-ai');
const { Readable } = require('stream');
const { getProviderForModel } = require('../factory.js');


class OpenAIProvider {
    static async validateApiKey(key) {
        if (!key || typeof key !== 'string' || !key.startsWith('sk-')) {
            return { success: false, error: 'Invalid OpenAI API key format.' };
        }

        try {
            const response = await fetch('https://api.openai.com/v1/models', {
                headers: { 'Authorization': `Bearer ${key}` }
            });

            if (response.ok) {
                return { success: true };
            } else {
                const errorData = await response.json().catch(() => ({}));
                const message = errorData.error?.message || `Validation failed with status: ${response.status}`;
                return { success: false, error: message };
            }
        } catch (error) {
            console.error(`[OpenAIProvider] Network error during key validation:`, error);
            return { success: false, error: 'A network error occurred during validation.' };
        }
    }
}


/**
 * Creates an OpenAI STT session
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - OpenAI API key
 * @param {string} [opts.language='en'] - Language code
 * @param {object} [opts.callbacks] - Event callbacks
 * @param {boolean} [opts.usePortkey=false] - Whether to use Portkey
 * @param {string} [opts.portkeyVirtualKey] - Portkey virtual key
 * @returns {Promise<object>} STT session
 */
async function createSTT({ apiKey, language, callbacks = {}, usePortkey = false, portkeyVirtualKey, ...config }) {
  const keyType = usePortkey ? 'vKey' : 'apiKey';
  const key = usePortkey ? (portkeyVirtualKey || apiKey) : apiKey;

  const wsUrl = keyType === 'apiKey'
    ? 'wss://api.openai.com/v1/realtime?intent=transcription'
    : 'wss://api.portkey.ai/v1/realtime?intent=transcription';

  const headers = keyType === 'apiKey'
    ? {
        'Authorization': `Bearer ${key}`,
      }
    : {
        'x-portkey-api-key': 'gRv2UGRMq6GGLJ8aVEB4e7adIewu',
        'x-portkey-virtual-key': key,
      };

  // Verbose realtime tracing, off by default: it logs every websocket frame, which
  // drowns out everything else in a live session. Kept rather than deleted because it
  // is what made the Realtime GA transcription migration debuggable.
  const sttDebug = !!process.env.GLASS_DEBUG_STT;

  if (sttDebug) {
    console.log('[STT DEBUG] Connecting to:', wsUrl);
    console.log('[STT DEBUG] Headers:', JSON.stringify(Object.keys(headers)));
  }
  const ws = new WebSocket(wsUrl, { headers });

  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      console.log("WebSocket session opened.");

      const model = config.model || 'gpt-4o-mini-transcribe';

      // Realtime GA transcription schema: `session.type` is required and all audio
      // settings live under `session.audio.input`. The pre-GA flat shape
      // (input_audio_format / input_audio_transcription / top-level turn_detection)
      // is rejected outright by this endpoint — it answers
      // "Unknown parameter: 'session.input_audio_format'" — so there is no model
      // for which sending it is correct.
      const sessionConfig = {
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: {
                type: 'audio/pcm',
                rate: 24000,
              },
              transcription: {
                model,
                prompt: config.prompt || '',
                // `language` is an optional hint. Omitting it lets the model auto-detect, which
                // is what we want by default: Glass previously hard-defaulted to 'en' all the way
                // down the call chain, so non-English speech was transcribed while the model was
                // being told the audio was English. Only send the field when a language was
                // actually configured.
                ...(language ? { language } : {}),
              },
              noise_reduction: {
                type: 'near_field',
              },
              // Server VAD is what produces the
              // conversation.item.input_audio_transcription.completed events that
              // sttService turns into finalized utterances. Streaming-only models
              // such as gpt-realtime-whisper reject turn_detection and never commit
              // the audio buffer on their own, so they are deliberately not offered
              // in the STT catalog (see factory.js).
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 200,
                silence_duration_ms: 500,
              },
            },
          },
        },
      };
      
      console.log(`[OpenAI STT] language=${language || 'auto-detect (omitted)'}`);
      if (sttDebug) console.log('[STT DEBUG] Sending session config:', JSON.stringify(sessionConfig));
      ws.send(JSON.stringify(sessionConfig));

      // Helper to periodically keep the websocket alive
      const keepAlive = () => {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            // The ws library supports native ping frames which are ideal for heart-beats
            ws.ping();
          }
        } catch (err) {
          console.error('[OpenAI STT] keepAlive error:', err.message);
        }
      };

      resolve({
        sendRealtimeInput: (audioData) => {
          if (ws.readyState === WebSocket.OPEN) {
            const message = {
              type: 'input_audio_buffer.append',
              audio: audioData
            };
            ws.send(JSON.stringify(message));
          }
        },
        // Expose keepAlive so higher-level services can schedule heart-beats
        keepAlive,
        close: () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'session.close' }));
            ws.onmessage = ws.onerror = () => {};  // 핸들러 제거
            ws.close(1000, 'Client initiated close.');
          }
        }
      });
    };

    ws.onmessage = (event) => {
      if (sttDebug) console.log('[STT DEBUG] raw message:', event.data);
      // ── 종료·하트비트 패킷 필터링 ──────────────────────────────
      if (!event.data || event.data === 'null' || event.data === '[DONE]') return;

      let msg;
      try { msg = JSON.parse(event.data); }
      catch { return; }                       // JSON 파싱 실패 무시

      if (!msg || typeof msg !== 'object') return;

      msg.provider = 'openai';                // ← 항상 명시
      callbacks.onmessage?.(msg);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error.message);
      if (callbacks && callbacks.onerror) {
        callbacks.onerror(error);
      }
      reject(error);
    };

    ws.onclose = (event) => {
      console.log(`WebSocket closed: ${event.code} ${event.reason}`);
      if (callbacks && callbacks.onclose) {
        callbacks.onclose(event);
      }
    };
  });
}

/**
 * Creates an OpenAI LLM instance
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - OpenAI API key
 * @param {string} [opts.model='gpt-4.1'] - Model name
 * @param {number} [opts.temperature=0.7] - Temperature
 * @param {number} [opts.maxTokens=2048] - Max tokens
 * @param {boolean} [opts.usePortkey=false] - Whether to use Portkey
 * @param {string} [opts.portkeyVirtualKey] - Portkey virtual key
 * @returns {object} LLM instance
 */
function createLLM({ apiKey, model = 'gpt-4.1', temperature = 0.7, maxTokens = 2048, usePortkey = false, portkeyVirtualKey, ...config }) {
  const client = new OpenAI({ apiKey });
  
  const callApi = async (messages) => {
    if (!usePortkey) {
      const response = await client.chat.completions.create({
        model: model,
        messages: messages,
        temperature: temperature,
        max_tokens: maxTokens
      });
      return {
        content: response.choices[0].message.content.trim(),
        raw: response
      };
    } else {
      const fetchUrl = 'https://api.portkey.ai/v1/chat/completions';
      const response = await fetch(fetchUrl, {
        method: 'POST',
        headers: {
            'x-portkey-api-key': 'gRv2UGRMq6GGLJ8aVEB4e7adIewu',
            'x-portkey-virtual-key': portkeyVirtualKey || apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: model,
            messages,
            temperature,
            max_tokens: maxTokens,
        }),
      });

      if (!response.ok) {
        throw new Error(`Portkey API error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      return {
        content: result.choices[0].message.content.trim(),
        raw: result
      };
    }
  };

  return {
    generateContent: async (parts) => {
      const messages = [];
      let systemPrompt = '';
      let userContent = [];
      
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
            image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` }
          });
        }
      }
      
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      if (userContent.length > 0) messages.push({ role: 'user', content: userContent });
      
      const result = await callApi(messages);

      return {
        response: {
          text: () => result.content
        },
        raw: result.raw
      };
    },
    
    // For compatibility with chat-style interfaces
    chat: async (messages) => {
      return await callApi(messages);
    }
  };
}

/** 
 * Creates an OpenAI streaming LLM instance
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - OpenAI API key
 * @param {string} [opts.model='gpt-4.1'] - Model name
 * @param {number} [opts.temperature=0.7] - Temperature
 * @param {number} [opts.maxTokens=2048] - Max tokens
 * @param {boolean} [opts.usePortkey=false] - Whether to use Portkey
 * @param {string} [opts.portkeyVirtualKey] - Portkey virtual key
 * @returns {object} Streaming LLM instance
 */
function createStreamingLLM({ apiKey, model = 'gpt-4.1', temperature = 0.7, maxTokens = 2048, usePortkey = false, portkeyVirtualKey, ...config }) {
  return {
    streamChat: async (messages) => {
      const fetchUrl = usePortkey 
        ? 'https://api.portkey.ai/v1/chat/completions'
        : 'https://api.openai.com/v1/chat/completions';
      
      const headers = usePortkey
        ? {
            'x-portkey-api-key': 'gRv2UGRMq6GGLJ8aVEB4e7adIewu',
            'x-portkey-virtual-key': portkeyVirtualKey || apiKey,
            'Content-Type': 'application/json',
          }
        : {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          };

      const response = await fetch(fetchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      return response;
    }
  };
}

module.exports = {
    OpenAIProvider,
    createSTT,
    createLLM,
    createStreamingLLM
}; 