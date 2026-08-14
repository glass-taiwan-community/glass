// providers/deepgram.js

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const WebSocket = require('ws');

// Deepgram drops an idle connection after 10s (NET-0001); the docs recommend a
// 3-5s heart-beat. 5s leaves headroom without adding meaningful traffic.
const KEEP_ALIVE_MS = 5_000;

/**
 * Deepgram Provider 클래스. API 키 유효성 검사를 담당합니다.
 */
class DeepgramProvider {
    /**
     * Deepgram API 키의 유효성을 검사합니다.
     * @param {string} key - 검사할 Deepgram API 키
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    static async validateApiKey(key) {
        if (!key || typeof key !== 'string') {
            return { success: false, error: 'Invalid Deepgram API key format.' };
        }
        try {
            // ✨ 변경점: SDK 대신 직접 fetch로 API를 호출하여 안정성 확보 (openai.js 방식)
            const response = await fetch('https://api.deepgram.com/v1/projects', {
                headers: { 'Authorization': `Token ${key}` }
            });

            if (response.ok) {
                return { success: true };
            } else {
                const errorData = await response.json().catch(() => ({}));
                const message = errorData.err_msg || `Validation failed with status: ${response.status}`;
                return { success: false, error: message };
            }
        } catch (error) {
            console.error(`[DeepgramProvider] Network error during key validation:`, error);
            return { success: false, error: error.message || 'A network error occurred during validation.' };
        }
    }
}

function createSTT({
    apiKey,
    // Deepgram requires an explicit language; it has no auto-detect for streaming, and its
    // multilingual 'multi' code excludes Chinese. 'en' rather than 'en-US' because that is what
    // sttService has always passed - the previous 'en-US' default here was never reached.
    language = 'en',
    sampleRate = 24000,
    callbacks = {},
  }) {
    const qs = new URLSearchParams({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: sampleRate.toString(),
      language,
      smart_format: 'true',
      interim_results: 'true',   // required for utterance_end_ms, and drives live partials
      channels: '1',
      // Turn-boundary signals. Without these Deepgram never emits speech_final or
      // UtteranceEnd, and sttService has nothing to finalize an utterance on.
      //
      // endpointing=200 is deliberately below Deepgram's documented 300-500ms
      // note-taking recommendation. Measured against real podcast audio, 500ms
      // yielded 1 speech_final per 68s (too few to reach the summary threshold in
      // reasonable time) while 200ms yielded 6 per 62s with comparable turn lengths.
      endpointing: '200',
      // 1000 is the documented minimum. UtteranceEnd fires roughly once a minute on
      // continuous speech, so it is a safety net rather than the primary boundary.
      utterance_end_ms: '1000',
      vad_events: 'true',
    });
  
    const url = `wss://api.deepgram.com/v1/listen?${qs}`;
  
    const ws = new WebSocket(url, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    ws.binaryType = 'arraybuffer';
  
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        ws.terminate();
        reject(new Error('DG open timeout (10 s)'));
      }, 10_000);
  
      // Deepgram closes an idle socket with NET-0001 after 10s without audio or a
      // KeepAlive. sttService's shared heart-beat runs on a 60s interval and is gated
      // to OpenAI, so it cannot cover this. The session owns its own timer instead,
      // which leaves every other provider's behaviour untouched.
      let keepAliveTimer = null;
      const stopKeepAlive = () => {
        if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
      };

      ws.on('open', () => {
        clearTimeout(to);

        // Must be a text frame - Deepgram mishandles KeepAlive sent as binary.
        keepAliveTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, KEEP_ALIVE_MS);

        resolve({
          sendRealtimeInput: (buf) => ws.send(buf),
          close: () => {
            stopKeepAlive();
            try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch { /* already closing */ }
            ws.close(1000, 'client');
          },
        });
      });
  
      ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        // UtteranceEnd carries no channel.alternatives, so the transcript check alone
        // would drop it here and sttService's fallback boundary would be dead code.
        if (msg.type === 'UtteranceEnd' || msg.channel?.alternatives?.[0]?.transcript !== undefined) {
          callbacks.onmessage?.({ provider: 'deepgram', ...msg });
        }
      });
  
      ws.on('close', (code, reason) => {
        stopKeepAlive();
        callbacks.onclose?.({ code, reason: reason.toString() });
      });
  
      ws.on('error', err => {
        clearTimeout(to);
        stopKeepAlive();
        callbacks.onerror?.(err);
        reject(err);
      });
    });
  }

// ... (LLM 관련 Placeholder 함수들은 그대로 유지) ...
function createLLM(opts) {
  console.warn("[Deepgram] LLM not supported.");
  return { generateContent: async () => { throw new Error("Deepgram does not support LLM functionality."); } };
}
function createStreamingLLM(opts) {
  console.warn("[Deepgram] Streaming LLM not supported.");
  return { streamChat: async () => { throw new Error("Deepgram does not support Streaming LLM functionality."); } };
}

module.exports = {
    DeepgramProvider,
    createSTT,
    createLLM,
    createStreamingLLM
};