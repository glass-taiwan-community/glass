const { BrowserWindow, app } = require('electron');
const { createStreamingLLM } = require('../common/ai/factory');
// Lazy require helper to avoid circular dependency issues
const getWindowManager = () => require('../../window/windowManager');
const internalBridge = require('../../bridge/internalBridge');

const getWindowPool = () => {
    try {
        return getWindowManager().windowPool;
    } catch {
        return null;
    }
};

const sessionRepository = require('../common/repositories/session');
const askRepository = require('./repositories');
const { getSystemPrompt } = require('../common/prompts/promptBuilder');
const path = require('node:path');
const fs = require('node:fs');
const os = require('os');
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);
const { desktopCapturer } = require('electron');
const modelStateService = require('../common/services/modelStateService');

// Try to load sharp, but don't fail if it's not available
let sharp;
try {
    sharp = require('sharp');
    console.log('[AskService] Sharp module loaded successfully');
} catch (error) {
    console.warn('[AskService] Sharp module not available:', error.message);
    console.warn('[AskService] Screenshot functionality will work with reduced image processing capabilities');
    sharp = null;
}
let lastScreenshot = null;

async function captureScreenshot(options = {}) {
    if (process.platform === 'darwin') {
        try {
            const tempPath = path.join(os.tmpdir(), `screenshot-${Date.now()}.jpg`);

            await execFile('screencapture', ['-x', '-t', 'jpg', tempPath]);

            const imageBuffer = await fs.promises.readFile(tempPath);
            await fs.promises.unlink(tempPath);

            if (sharp) {
                try {
                    // Try using sharp for optimal image processing
                    const resizedBuffer = await sharp(imageBuffer)
                        .resize({ height: 384 })
                        .jpeg({ quality: 80 })
                        .toBuffer();

                    const base64 = resizedBuffer.toString('base64');
                    const metadata = await sharp(resizedBuffer).metadata();

                    lastScreenshot = {
                        base64,
                        width: metadata.width,
                        height: metadata.height,
                        timestamp: Date.now(),
                    };

                    // Optionally save a human-readable 1280px-wide copy for history. The model
                    // gets the 384px thumbnail above; this is the copy a person reviews later.
                    let readablePath = null;
                    if (options.saveReadableTo) {
                        try {
                            await sharp(imageBuffer).resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(options.saveReadableTo);
                            readablePath = options.saveReadableTo;
                        } catch (e) {
                            console.warn('[AskService] failed to save readable screenshot:', e.message);
                        }
                    }

                    return { success: true, base64, width: metadata.width, height: metadata.height, readablePath };
                } catch (sharpError) {
                    console.warn('Sharp module failed, falling back to basic image processing:', sharpError.message);
                }
            }
            
            // Fallback: Return the original image without resizing
            console.log('[AskService] Using fallback image processing (no resize/compression)');
            const base64 = imageBuffer.toString('base64');
            
            lastScreenshot = {
                base64,
                width: null, // We don't have metadata without sharp
                height: null,
                timestamp: Date.now(),
            };

            return { success: true, base64, width: null, height: null };
        } catch (error) {
            console.error('Failed to capture screenshot:', error);
            return { success: false, error: error.message };
        }
    }

    try {
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: {
                width: 1920,
                height: 1080,
            },
        });

        if (sources.length === 0) {
            throw new Error('No screen sources available');
        }
        const source = sources[0];
        const buffer = source.thumbnail.toJPEG(70);
        const base64 = buffer.toString('base64');
        const size = source.thumbnail.getSize();

        return {
            success: true,
            base64,
            width: size.width,
            height: size.height,
        };
    } catch (error) {
        console.error('Failed to capture screenshot using desktopCapturer:', error);
        return {
            success: false,
            error: error.message,
        };
    }
}

/**
 * @class
 * @description
 */
class AskService {
    constructor() {
        this.abortController = null;
        this.state = {
            isVisible: false,
            isLoading: false,
            isStreaming: false,
            currentQuestion: '',
            currentResponse: '',
            showTextInput: true,
        };
        console.log('[AskService] Service instance created.');
    }

    _broadcastState() {
        const askWindow = getWindowPool()?.get('ask');
        if (askWindow && !askWindow.isDestroyed()) {
            askWindow.webContents.send('ask:stateUpdate', this.state);
        }
    }

    /**
     * Pin the answer currently on screen into the separate read-only window, or unpin it.
     *
     * A snapshot, not a live view: askService broadcasts ask:stateUpdate only to the 'ask' window,
     * so the pinned copy is frozen by construction rather than by a flag that could be missed.
     */
    togglePinnedAnswer() {
        const pool = getWindowPool();
        const pinnedWindow = pool?.get('ask-pinned');
        if (!pinnedWindow || pinnedWindow.isDestroyed()) {
            console.warn('[AskService] pinned window unavailable');
            return { success: false, error: 'pinned window unavailable' };
        }

        if (pinnedWindow.isVisible()) {
            internalBridge.emit('window:requestVisibility', { name: 'ask-pinned', visible: false });
            console.log('[AskService] answer unpinned');
            return { success: true, pinned: false };
        }

        // Nothing to pin is a no-op rather than an empty window: an empty pin would take screen
        // space and give the user something else to dismiss for no benefit.
        if (!this.state.currentResponse || !this.state.currentResponse.trim()) {
            console.log('[AskService] nothing to pin -- no answer on screen');
            return { success: false, error: 'no answer to pin' };
        }

        // The window is created hidden at startup, so it is normally loaded long before the
        // first pin - but pinning immediately after launch would otherwise send the snapshot to
        // a renderer that has not yet subscribed, leaving a pinned window that is simply empty.
        const snapshot = {
            question: this.state.currentQuestion,
            response: this.state.currentResponse,
        };
        if (pinnedWindow.webContents.isLoading()) {
            pinnedWindow.webContents.once('did-finish-load', () => {
                if (!pinnedWindow.isDestroyed()) pinnedWindow.webContents.send('ask:pinnedContent', snapshot);
            });
        } else {
            pinnedWindow.webContents.send('ask:pinnedContent', snapshot);
        }
        internalBridge.emit('window:requestVisibility', { name: 'ask-pinned', visible: true });
        console.log('[AskService] answer pinned');
        return { success: true, pinned: true };
    }

    async toggleAskButton(inputScreenOnly = false) {
        const askWindow = getWindowPool()?.get('ask');

        let shouldSendScreenOnly = false;
        if (inputScreenOnly && this.state.showTextInput && askWindow && askWindow.isVisible()) {
            shouldSendScreenOnly = true;
            // Screen-only ask (Cmd+Enter twice) has no text prompt, so the screenshot is the
            // only record of what was asked -- flag it to be saved (gated by the setting).
            await this.sendMessage('', [], { saveScreenshot: true });
            return;
        }

        const hasContent = this.state.isLoading || this.state.isStreaming || (this.state.currentResponse && this.state.currentResponse.length > 0);

        if (askWindow && askWindow.isVisible() && hasContent) {
            this.state.showTextInput = !this.state.showTextInput;
            this._broadcastState();
        } else {
            if (askWindow && askWindow.isVisible()) {
                internalBridge.emit('window:requestVisibility', { name: 'ask', visible: false });
                this.state.isVisible = false;
            } else {
                console.log('[AskService] Showing hidden Ask window');
                internalBridge.emit('window:requestVisibility', { name: 'ask', visible: true });
                this.state.isVisible = true;
            }
            if (this.state.isVisible) {
                this.state.showTextInput = true;
                this._broadcastState();
            }
        }
    }

    async closeAskWindow () {
            if (this.abortController) {
                this.abortController.abort('Window closed by user');
                this.abortController = null;
            }
    
            this.state = {
                isVisible      : false,
                isLoading      : false,
                isStreaming    : false,
                currentQuestion: '',
                currentResponse: '',
                showTextInput  : true,
            };
            this._broadcastState();
    
            internalBridge.emit('window:requestVisibility', { name: 'ask', visible: false });
    
            return { success: true };
        }
    

    /**
     * 
     * @param {string[]} conversationTexts
     * @returns {string}
     * @private
     */
    _formatConversationForPrompt(conversationTexts) {
        if (!conversationTexts || conversationTexts.length === 0) {
            return 'No conversation history available.';
        }
        return conversationTexts.slice(-30).join('\n');
    }

    /**
     * 
     * @param {string} userPrompt
     * @returns {Promise<{success: boolean, response?: string, error?: string}>}
     */
    async sendMessage(userPrompt, conversationHistoryRaw=[], opts={}) {
        internalBridge.emit('window:requestVisibility', { name: 'ask', visible: true });
        this.state = {
            ...this.state,
            isLoading: true,
            isStreaming: false,
            currentQuestion: userPrompt,
            currentResponse: '',
            showTextInput: false,
        };
        this._broadcastState();

        if (this.abortController) {
            this.abortController.abort('New request received.');
        }
        this.abortController = new AbortController();
        const { signal } = this.abortController;


        let sessionId;

        try {
            console.log(`[AskService] 🤖 Processing message: ${userPrompt.substring(0, 50)}...`);

            sessionId = await sessionRepository.getOrCreateActive('ask');

            // Decide whether to persist this capture (screen-only ask + setting on). Set up the
            // destination up front so captureScreenshot can write the readable copy in one pass.
            let imagePath = null;
            let saveReadableTo = null;
            if (opts.saveScreenshot) {
                try {
                    const settingsService = require('../settings/settingsService');
                    if (await settingsService.getSaveAskScreenshots()) {
                        const dir = path.join(app.getPath('userData'), 'ask-screenshots');
                        await fs.promises.mkdir(dir, { recursive: true });
                        const filename = `${require('crypto').randomUUID()}.jpg`;
                        saveReadableTo = path.join(dir, filename);
                        imagePath = filename; // store the filename only, keep it portable
                    }
                } catch (e) {
                    console.error('[AskService] screenshot-save setup failed:', e.message);
                }
            }

            const screenshotResult = await captureScreenshot({ quality: 'medium', saveReadableTo });
            const screenshotBase64 = screenshotResult.success ? screenshotResult.base64 : null;
            // Only record the path if the file was actually written.
            if (saveReadableTo && !screenshotResult.readablePath) imagePath = null;

            await askRepository.addAiMessage({ sessionId, role: 'user', content: userPrompt.trim(), imagePath });
            console.log(`[AskService] DB: Saved user prompt to session ${sessionId}${imagePath ? ' (with screenshot)' : ''}`);

            const modelInfo = await modelStateService.getCurrentModelInfo('llm');
            if (!modelInfo || !modelInfo.apiKey) {
                throw new Error('AI model or API key not configured.');
            }
            console.log(`[AskService] Using model: ${modelInfo.model} for provider: ${modelInfo.provider}`);

            const conversationHistory = this._formatConversationForPrompt(conversationHistoryRaw);
            // A prompt missing its conversation context is indistinguishable from one that has it
            // by looking at the answer alone, so record what actually went in. Report the sent
            // count separately from the available count: _formatConversationForPrompt keeps only
            // the last 30 turns, so on a long session most of the history never reaches the model.
            const availableTurns = conversationHistoryRaw?.length ?? 0;
            console.log(`[AskService] Context: ${Math.min(availableTurns, 30)} of ${availableTurns} conversation turn(s) sent, screenshot=${screenshotBase64 ? 'yes' : 'no'}`);

            const systemPrompt = getSystemPrompt('pickle_glass_analysis', conversationHistory, false);

            const messages = [
                { role: 'system', content: systemPrompt },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: `User Request: ${userPrompt.trim()}

**LANGUAGE INSTRUCTION:**
- Respond in Traditional Chinese (繁體中文)
- Keep code snippets, technical terms, API names, libraries, frameworks, and proper nouns in English
- Translate all explanations, answers, and suggestions to Traditional Chinese
- Preserve all emojis and formatting` },
                    ],
                },
            ];

            if (screenshotBase64) {
                messages[1].content.push({
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` },
                });
            }
            
            const streamingLLM = createStreamingLLM(modelInfo.provider, {
                apiKey: modelInfo.apiKey,
                baseUrl: modelInfo.baseUrl,
                model: modelInfo.model,
                temperature: 0.7,
                maxTokens: 2048,
                usePortkey: modelInfo.provider === 'openai-glass',
                portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
            });

            try {
                const response = await streamingLLM.streamChat(messages);
                const askWin = getWindowPool()?.get('ask');

                if (!askWin || askWin.isDestroyed()) {
                    console.error("[AskService] Ask window is not available to send stream to.");
                    response.body.getReader().cancel();
                    return { success: false, error: 'Ask window is not available.' };
                }

                const reader = response.body.getReader();
                signal.addEventListener('abort', () => {
                    console.log(`[AskService] Aborting stream reader. Reason: ${signal.reason}`);
                    reader.cancel(signal.reason).catch(() => { /* 이미 취소된 경우의 오류는 무시 */ });
                });

                await this._processStream(reader, askWin, sessionId, signal);
                return { success: true };

            } catch (multimodalError) {
                // 멀티모달 요청이 실패했고 스크린샷이 포함되어 있다면 텍스트만으로 재시도
                if (screenshotBase64 && this._isMultimodalError(multimodalError)) {
                    console.log(`[AskService] Multimodal request failed, retrying with text-only: ${multimodalError.message}`);
                    
                    // 텍스트만으로 메시지 재구성
                    const textOnlyMessages = [
                        { role: 'system', content: systemPrompt },
                        {
                            role: 'user',
                            content: `User Request: ${userPrompt.trim()}

**LANGUAGE INSTRUCTION:**
- Respond in Traditional Chinese (繁體中文)
- Keep code snippets, technical terms, API names, libraries, frameworks, and proper nouns in English
- Translate all explanations, answers, and suggestions to Traditional Chinese
- Preserve all emojis and formatting`
                        }
                    ];

                    const fallbackResponse = await streamingLLM.streamChat(textOnlyMessages);
                    const askWin = getWindowPool()?.get('ask');

                    if (!askWin || askWin.isDestroyed()) {
                        console.error("[AskService] Ask window is not available for fallback response.");
                        fallbackResponse.body.getReader().cancel();
                        return { success: false, error: 'Ask window is not available.' };
                    }

                    const fallbackReader = fallbackResponse.body.getReader();
                    signal.addEventListener('abort', () => {
                        console.log(`[AskService] Aborting fallback stream reader. Reason: ${signal.reason}`);
                        fallbackReader.cancel(signal.reason).catch(() => {});
                    });

                    await this._processStream(fallbackReader, askWin, sessionId, signal);
                    return { success: true };
                } else {
                    // 다른 종류의 에러이거나 스크린샷이 없었다면 그대로 throw
                    throw multimodalError;
                }
            }

        } catch (error) {
            console.error('[AskService] Error during message processing:', error);
            this.state = {
                ...this.state,
                isLoading: false,
                isStreaming: false,
                showTextInput: true,
            };
            this._broadcastState();

            const askWin = getWindowPool()?.get('ask');
            if (askWin && !askWin.isDestroyed()) {
                const streamError = error.message || 'Unknown error occurred';
                askWin.webContents.send('ask-response-stream-error', { error: streamError });
            }

            return { success: false, error: error.message };
        }
    }

    /**
     * 
     * @param {ReadableStreamDefaultReader} reader
     * @param {BrowserWindow} askWin
     * @param {number} sessionId 
     * @param {AbortSignal} signal
     * @returns {Promise<void>}
     * @private
     */
    async _processStream(reader, askWin, sessionId, signal) {
        const decoder = new TextDecoder();
        let fullResponse = '';

        try {
            this.state.isLoading = false;
            this.state.isStreaming = true;
            this._broadcastState();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n').filter(line => line.trim() !== '');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.substring(6);
                        if (data === '[DONE]') {
                            return; 
                        }
                        try {
                            const json = JSON.parse(data);
                            const token = json.choices[0]?.delta?.content || '';
                            if (token) {
                                fullResponse += token;
                                this.state.currentResponse = fullResponse;
                                this._broadcastState();
                            }
                        } catch (error) {
                        }
                    }
                }
            }
        } catch (streamError) {
            if (signal.aborted) {
                console.log(`[AskService] Stream reading was intentionally cancelled. Reason: ${signal.reason}`);
            } else {
                console.error('[AskService] Error while processing stream:', streamError);
                if (askWin && !askWin.isDestroyed()) {
                    askWin.webContents.send('ask-response-stream-error', { error: streamError.message });
                }
            }
        } finally {
            this.state.isStreaming = false;
            this.state.currentResponse = fullResponse;
            this._broadcastState();
            if (fullResponse) {
                 try {
                    await askRepository.addAiMessage({ sessionId, role: 'assistant', content: fullResponse });
                    console.log(`[AskService] DB: Saved partial or full assistant response to session ${sessionId} after stream ended.`);
                } catch(dbError) {
                    console.error("[AskService] DB: Failed to save assistant response after stream ended:", dbError);
                }
            }
        }
    }

    /**
     * 멀티모달 관련 에러인지 판단
     * @private
     */
    _isMultimodalError(error) {
        const errorMessage = error.message?.toLowerCase() || '';
        return (
            errorMessage.includes('vision') ||
            errorMessage.includes('image') ||
            errorMessage.includes('multimodal') ||
            errorMessage.includes('unsupported') ||
            errorMessage.includes('image_url') ||
            errorMessage.includes('400') ||  // Bad Request often for unsupported features
            errorMessage.includes('invalid') ||
            errorMessage.includes('not supported')
        );
    }

    /** Absolute path to the saved-screenshots directory. */
    _screenshotDir() {
        return path.join(app.getPath('userData'), 'ask-screenshots');
    }

    /**
     * Delete the saved screenshots belonging to a session, before its rows are removed.
     * Best-effort: a missing file or dir is fine.
     */
    async deleteScreenshotsForSession(sessionId) {
        try {
            const messages = await askRepository.getAllAiMessagesBySessionId(sessionId);
            const dir = this._screenshotDir();
            for (const m of messages || []) {
                if (m && m.image_path) {
                    await fs.promises.unlink(path.join(dir, path.basename(m.image_path))).catch(() => {});
                }
            }
        } catch (e) {
            console.error('[AskService] deleteScreenshotsForSession failed:', e.message);
        }
    }

    /**
     * Delete saved screenshots older than the retention window (30 days). Best-effort; runs at
     * startup so the folder cannot grow without bound.
     */
    async cleanupOldScreenshots(maxAgeDays = 30) {
        try {
            const dir = this._screenshotDir();
            const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
            const files = await fs.promises.readdir(dir).catch(() => []);
            let removed = 0;
            for (const file of files) {
                const full = path.join(dir, file);
                try {
                    const stat = await fs.promises.stat(full);
                    if (stat.mtimeMs < cutoff) { await fs.promises.unlink(full); removed++; }
                } catch { /* skip */ }
            }
            if (removed > 0) console.log(`[AskService] cleaned up ${removed} screenshot(s) older than ${maxAgeDays} days`);
        } catch (e) {
            console.error('[AskService] cleanupOldScreenshots failed:', e.message);
        }
    }

}

const askService = new AskService();

module.exports = askService;