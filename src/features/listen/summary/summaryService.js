const { BrowserWindow } = require('electron');
const { getSystemPrompt } = require('../../common/prompts/promptBuilder.js');
const { createLLM } = require('../../common/ai/factory');
const sessionRepository = require('../../common/repositories/session');
const summaryRepository = require('./repositories');
const sttRepository = require('../stt/repositories');
const modelStateService = require('../../common/services/modelStateService');

// Sessions below this much real content are not worth an LLM call - typically a mis-click on
// Listen. Measured with contentUnits(), so it behaves the same for Chinese and English:
// roughly 30-45 seconds of actual speech in either.
const MIN_CONTENT_UNITS_FOR_FINAL_SUMMARY = 100;

class SummaryService {
    constructor() {
        this.previousAnalysisResult = null;
        this.analysisHistory = [];
        this.conversationHistory = [];
        this.currentSessionId = null;
        this.preContext = null;

        // Callbacks
        this.onAnalysisComplete = null;
        this.onStatusUpdate = null;
    }

    setCallbacks({ onAnalysisComplete, onStatusUpdate }) {
        this.onAnalysisComplete = onAnalysisComplete;
        this.onStatusUpdate = onStatusUpdate;
    }

    setSessionId(sessionId) {
        this.currentSessionId = sessionId;
    }

    setPreContext(content) {
        this.preContext = content || null;
    }

    sendToRenderer(channel, data) {
        const { windowPool } = require('../../../window/windowManager');
        const listenWindow = windowPool?.get('listen');
        
        if (listenWindow && !listenWindow.isDestroyed()) {
            listenWindow.webContents.send(channel, data);
        }
    }

    addConversationTurn(speaker, text) {
        const conversationText = `${speaker.toLowerCase()}: ${text.trim()}`;
        this.conversationHistory.push(conversationText);
        console.log(`💬 Added conversation text: ${conversationText}`);
        console.log(`📈 Total conversation history: ${this.conversationHistory.length} texts`);

        // Trigger analysis if needed
        this.triggerAnalysisIfNeeded();
    }

    getConversationHistory() {
        return this.conversationHistory;
    }

    resetConversationHistory() {
        this.conversationHistory = [];
        this.previousAnalysisResult = null;
        this.analysisHistory = [];
        console.log('🔄 Conversation history and analysis state reset');
    }

    async generateInitialSummary(preContext) {
        if (!preContext || !preContext.trim()) {
            console.log('[SummaryService] generateInitialSummary: no pre-context, skipping');
            return;
        }

        console.log('[SummaryService] Generating initial summary from pre-context...');

        try {
            const modelInfo = await modelStateService.getCurrentModelInfo('llm');
            if (!modelInfo || !modelInfo.apiKey) {
                console.warn('[SummaryService] generateInitialSummary: no model configured');
                return;
            }

            const systemPrompt = getSystemPrompt('pickle_glass_analysis', '', false, preContext)
                .replace('{{CONVERSATION_HISTORY}}', '');

            const messages = [
                { role: 'system', content: systemPrompt },
                {
                    role: 'user',
                    content: `Based on the preloaded session context, generate an initial structured summary.

**Summary Overview**
- Main discussion point with context

**Key Topic: [Topic Name]**
- First key insight
- Second key insight
- Third key insight

**Extended Explanation**
Provide 2-3 sentences explaining the context and implications.

**Suggested Questions**
1. First follow-up question?
2. Second follow-up question?
3. Third follow-up question?

**LANGUAGE INSTRUCTION:**
- Respond in Traditional Chinese (繁體中文)
- IMPORTANT: Keep section headers in English exactly as shown
- Keep code snippets, technical terms, API names, libraries, frameworks, and proper nouns in English
- Translate all content to Traditional Chinese`,
                },
            ];

            const { createLLM } = require('../../common/ai/factory');
            const llm = createLLM(modelInfo.provider, {
                apiKey: modelInfo.apiKey,
                baseUrl: modelInfo.baseUrl,
                model: modelInfo.model,
                temperature: 0.7,
                maxTokens: 1024,
                usePortkey: modelInfo.provider === 'openai-glass',
                portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
            });

            const completion = await llm.chat(messages);
            const responseText = completion.content;
            console.log('[SummaryService] Initial summary generated from pre-context');

            const structuredData = this.parseResponseText(responseText, null);
            this.previousAnalysisResult = structuredData;

            this.sendToRenderer('analysis-result', structuredData);
        } catch (error) {
            console.error('[SummaryService] Error generating initial summary:', error.message);
        }
    }

    /**
     * Converts conversation history into text to include in the prompt.
     * @param {Array<string>} conversationTexts - Array of conversation texts ["me: ~~~", "them: ~~~", ...]
     * @param {number} maxTurns - Maximum number of recent turns to include
     * @returns {string} - Formatted conversation string for the prompt
     */
    formatConversationForPrompt(conversationTexts, maxTurns = 30) {
        if (conversationTexts.length === 0) return '';
        return conversationTexts.slice(-maxTurns).join('\n');
    }

    async makeOutlineAndRequests(conversationTexts, maxTurns = 30) {
        console.log(`🔍 makeOutlineAndRequests called - conversationTexts: ${conversationTexts.length}`);

        if (conversationTexts.length === 0) {
            console.log('⚠️ No conversation texts available for analysis');
            return null;
        }

        const recentConversation = this.formatConversationForPrompt(conversationTexts, maxTurns);

        // 이전 분석 결과를 프롬프트에 포함
        let contextualPrompt = '';
        if (this.previousAnalysisResult) {
            contextualPrompt = `
Previous Analysis Context:
- Main Topic: ${this.previousAnalysisResult.topic.header}
- Key Points: ${this.previousAnalysisResult.summary.slice(0, 3).join(', ')}
- Last Actions: ${this.previousAnalysisResult.actions.slice(0, 2).join(', ')}

Please build upon this context while analyzing the new conversation segments.
`;
        }

        const basePrompt = getSystemPrompt('pickle_glass_analysis', '', false, this.preContext);
        const systemPrompt = basePrompt.replace('{{CONVERSATION_HISTORY}}', recentConversation);

        // Captured outside the try so the catch can report which provider actually failed.
        let lastModelInfo = null;

        try {
            if (this.currentSessionId) {
                await sessionRepository.touch(this.currentSessionId);
            }

            const modelInfo = await modelStateService.getCurrentModelInfo('llm');
            lastModelInfo = modelInfo;
            if (!modelInfo || !modelInfo.apiKey) {
                throw new Error('AI model or API key is not configured.');
            }
            console.log(`🤖 Sending analysis request to ${modelInfo.provider} using model ${modelInfo.model}`);
            
            const messages = [
                {
                    role: 'system',
                    content: systemPrompt,
                },
                {
                    role: 'user',
                    content: `${contextualPrompt}

Analyze the conversation and provide a structured summary. Format your response as follows:

**Summary Overview**
- Main discussion point with context

**Key Topic: [Topic Name]**
- First key insight
- Second key insight
- Third key insight

**Extended Explanation**
Provide 2-3 sentences explaining the context and implications.

**Suggested Questions**
1. First follow-up question?
2. Second follow-up question?
3. Third follow-up question?

Keep all points concise and build upon previous analysis if provided.

**LANGUAGE INSTRUCTION:**
- Respond in Traditional Chinese (繁體中文)
- IMPORTANT: Keep section headers in English exactly as shown (do not translate "**Summary Overview**", "**Key Topic:**", "**Extended Explanation**", "**Suggested Questions**")
- Keep code snippets, technical terms, API names, libraries, frameworks, and proper nouns in English
- Translate all content (explanations, summaries, questions, insights) to Traditional Chinese
- Preserve all emojis and formatting`,
                },
            ];

            console.log('🤖 Sending analysis request to AI...');

            const llm = createLLM(modelInfo.provider, {
                apiKey: modelInfo.apiKey,
                baseUrl: modelInfo.baseUrl,
                model: modelInfo.model,
                temperature: 0.7,
                maxTokens: 1024,
                usePortkey: modelInfo.provider === 'openai-glass',
                portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
            });

            const completion = await llm.chat(messages);

            const responseText = completion.content;
            console.log(`✅ Analysis response received: ${responseText}`);
            const structuredData = this.parseResponseText(responseText, this.previousAnalysisResult);

            if (this.currentSessionId) {
                try {
                    summaryRepository.saveSummary({
                        sessionId: this.currentSessionId,
                        text: responseText,
                        tldr: structuredData.summary.join('\n'),
                        bullet_json: JSON.stringify(structuredData.topic.bullets),
                        action_json: JSON.stringify(structuredData.actions),
                        model: modelInfo.model
                    });
                } catch (err) {
                    console.error('[DB] Failed to save summary:', err);
                }
            }

            // 분석 결과 저장
            this.previousAnalysisResult = structuredData;
            this.analysisHistory.push({
                timestamp: Date.now(),
                data: structuredData,
                conversationLength: conversationTexts.length,
            });

            if (this.analysisHistory.length > 10) {
                this.analysisHistory.shift();
            }

            return structuredData;
        } catch (error) {
            // This failure is otherwise invisible: the caller turns a null/unchanged result into
            // a silently empty insights panel, so the log is the only signal the user ever gets.
            // Include enough context to tell "key rejected" apart from "model wrong" without a
            // second run.
            const where = lastModelInfo
                ? `${lastModelInfo.provider}/${lastModelInfo.model}${lastModelInfo.baseUrl ? ` via ${lastModelInfo.baseUrl}` : ''}`
                : 'no model configured';
            console.error(`❌ Live insights failed [${where}]: ${error.message}`);

            if (/401|403|unauthorized|forbidden|invalid.*key|authentication/i.test(error.message)) {
                console.error('   → The provider rejected the credentials. If personal vendor keys have been');
                console.error('     disabled, configure the LiteLLM proxy in Settings and select one of its models.');
            }
            if (process.env.GLASS_DEBUG_LLM) {
                console.error(error);
            } else {
                console.error('   → Set GLASS_DEBUG_LLM=1 for the full stack trace.');
            }
            return this.previousAnalysisResult; // 에러 시 이전 결과 반환
        }
    }

    parseResponseText(responseText, previousResult) {
        const structuredData = {
            summary: [],
            topic: { header: '', bullets: [] },
            actions: [],
            followUps: ['✉️ Draft a follow-up email', '✅ Generate action items', '📝 Show summary'],
        };

        // 이전 결과가 있으면 기본값으로 사용
        if (previousResult) {
            structuredData.topic.header = previousResult.topic.header;
            structuredData.summary = [...previousResult.summary];
        }

        try {
            const lines = responseText.split('\n');
            let currentSection = '';
            let isCapturingTopic = false;
            let topicName = '';

            for (const line of lines) {
                const trimmedLine = line.trim();

                // 섹션 헤더 감지
                if (trimmedLine.startsWith('**Summary Overview**')) {
                    currentSection = 'summary-overview';
                    continue;
                } else if (trimmedLine.startsWith('**Key Topic:')) {
                    currentSection = 'topic';
                    isCapturingTopic = true;
                    topicName = trimmedLine.match(/\*\*Key Topic: (.+?)\*\*/)?.[1] || '';
                    if (topicName) {
                        structuredData.topic.header = topicName + ':';
                    }
                    continue;
                } else if (trimmedLine.startsWith('**Extended Explanation**')) {
                    currentSection = 'explanation';
                    continue;
                } else if (trimmedLine.startsWith('**Suggested Questions**')) {
                    currentSection = 'questions';
                    continue;
                }

                // 컨텐츠 파싱
                if (trimmedLine.startsWith('-') && currentSection === 'summary-overview') {
                    const summaryPoint = trimmedLine.substring(1).trim();
                    if (summaryPoint && !structuredData.summary.includes(summaryPoint)) {
                        // 기존 summary 업데이트 (최대 5개 유지)
                        structuredData.summary.unshift(summaryPoint);
                        if (structuredData.summary.length > 5) {
                            structuredData.summary.pop();
                        }
                    }
                } else if (trimmedLine.startsWith('-') && currentSection === 'topic') {
                    const bullet = trimmedLine.substring(1).trim();
                    if (bullet && structuredData.topic.bullets.length < 3) {
                        structuredData.topic.bullets.push(bullet);
                    }
                } else if (currentSection === 'explanation' && trimmedLine) {
                    // explanation을 topic bullets에 추가 (문장 단위로)
                    const sentences = trimmedLine
                        .split(/\.\s+/)
                        .filter(s => s.trim().length > 0)
                        .map(s => s.trim() + (s.endsWith('.') ? '' : '.'));

                    sentences.forEach(sentence => {
                        if (structuredData.topic.bullets.length < 3 && !structuredData.topic.bullets.includes(sentence)) {
                            structuredData.topic.bullets.push(sentence);
                        }
                    });
                } else if (trimmedLine.match(/^\d+\./) && currentSection === 'questions') {
                    const question = trimmedLine.replace(/^\d+\.\s*/, '').trim();
                    if (question && question.includes('?')) {
                        structuredData.actions.push(`❓ ${question}`);
                    }
                }
            }

            // 기본 액션 추가
            const defaultActions = ['✨ What should I say next?', '💬 Suggest follow-up questions'];
            defaultActions.forEach(action => {
                if (!structuredData.actions.includes(action)) {
                    structuredData.actions.push(action);
                }
            });

            // 액션 개수 제한
            structuredData.actions = structuredData.actions.slice(0, 5);

            // 유효성 검증 및 이전 데이터 병합
            if (structuredData.summary.length === 0 && previousResult) {
                structuredData.summary = previousResult.summary;
            }
            if (structuredData.topic.bullets.length === 0 && previousResult) {
                structuredData.topic.bullets = previousResult.topic.bullets;
            }
        } catch (error) {
            console.error('❌ Error parsing response text:', error);
            // 에러 시 이전 결과 반환
            return (
                previousResult || {
                    summary: [],
                    topic: { header: 'Analysis in progress', bullets: [] },
                    actions: ['✨ What should I say next?', '💬 Suggest follow-up questions'],
                    followUps: ['✉️ Draft a follow-up email', '✅ Generate action items', '📝 Show summary'],
                }
            );
        }

        console.log('📊 Final structured data:', JSON.stringify(structuredData, null, 2));
        return structuredData;
    }

    /**
     * Triggers analysis when conversation history reaches 5 texts.
     */
    async triggerAnalysisIfNeeded() {
        if (this.conversationHistory.length >= 5 && this.conversationHistory.length % 5 === 0) {
            console.log(`Triggering analysis - ${this.conversationHistory.length} conversation texts accumulated`);

            const data = await this.makeOutlineAndRequests(this.conversationHistory);
            if (data) {
                console.log('Sending structured data to renderer');
                this.sendToRenderer('summary-update', data);
                
                // Notify callback
                if (this.onAnalysisComplete) {
                    this.onAnalysisComplete(data);
                }
            } else {
                console.log('No analysis data returned');
            }
        }
    }

    /**
     * Length of real content in a transcript, safe for both space-delimited and CJK scripts.
     *
     * A naive text.split(/\s+/) counts 51 Chinese characters as ONE word, so a word-count gate
     * would silently skip every Chinese session no matter how long - failing invisibly, with no
     * error, in the language this is most used in. Each CJK character counts as one unit, each
     * space-delimited token counts as one unit.
     */
    contentUnits(text) {
        if (!text) return 0;
        const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF]/g;
        const cjk = (text.match(CJK) || []).length;
        const rest = text.replace(CJK, ' ').trim().split(/\s+/).filter(Boolean).length;
        return cjk + rest;
    }

    /**
     * Parses the retrospective response into the same SHAPE as parseResponseText, so the stored
     * columns and the web renderer need no changes - but with retrospective semantics.
     *
     * A separate parser rather than a flag on parseResponseText because that one is built for the
     * live snapshot and would corrupt this output: it caps topic bullets at 3 (far too few for a
     * whole session, especially now that conflicts live in those bullets), and it fills `actions`
     * from "Suggested Questions" plus hardcoded live-assist affordances such as
     * "What should I say next?" - meaningless in a durable record where `actions` must mean
     * action items.
     */
    parseFinalResponseText(responseText) {
        const data = { summary: [], topic: { header: '', bullets: [] }, actions: [] };
        try {
            let section = '';
            for (const rawLine of responseText.split('\n')) {
                const line = rawLine.trim();

                if (line.startsWith('**Summary Overview**')) { section = 'summary'; continue; }
                if (line.startsWith('**Key Topic:')) {
                    section = 'topic';
                    const name = line.match(/\*\*Key Topic: (.+?)\*\*/)?.[1] || '';
                    if (name) data.topic.header = name;
                    continue;
                }
                if (line.startsWith('**Action Items**')) { section = 'actions'; continue; }
                if (line.startsWith('**')) { section = ''; continue; }

                if (!line) continue;

                if (section === 'summary' && line.startsWith('-')) {
                    const point = line.substring(1).trim();
                    if (point && data.summary.length < 8) data.summary.push(point);
                } else if (section === 'topic' && line.startsWith('-')) {
                    const bullet = line.substring(1).trim();
                    if (bullet && data.topic.bullets.length < 12) data.topic.bullets.push(bullet);
                } else if (section === 'actions') {
                    const action = line.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '').trim();
                    if (action && data.actions.length < 12) data.actions.push(action);
                }
            }
        } catch (error) {
            console.error('[SummaryService] Error parsing final summary:', error);
        }
        return data;
    }

    /**
     * Generates the durable whole-session summary. Called once when a session ends.
     *
     * Reads transcripts from the DATABASE rather than the in-memory conversationHistory. That is
     * deliberate: it works for sessions abandoned by a crash or quit, it makes the operation
     * re-runnable later (including for sessions recorded before this feature existed), and it
     * removes a hidden dependency on closeSession() not having reset state yet.
     *
     * Writes only the final_* columns, leaving the live snapshot intact as a fallback.
     *
     * @param {string} sessionId
     * @returns {Promise<{success: boolean, skipped?: string, error?: string}>}
     */
    async generateSessionSummary(sessionId) {
        if (!sessionId) return { success: false, error: 'No sessionId provided' };

        try {
            const transcripts = await sttRepository.getAllTranscriptsBySessionId(sessionId);
            if (!transcripts || transcripts.length === 0) {
                console.log(`[SummaryService] No transcripts for session ${sessionId}, skipping final summary`);
                return { success: false, skipped: 'no-transcripts' };
            }

            const conversation = transcripts
                .map(t => `${(t.speaker || '').toLowerCase()}: ${(t.text || '').trim()}`)
                .filter(line => line.length > 2)
                .join('\n');

            const units = this.contentUnits(conversation);
            if (units < MIN_CONTENT_UNITS_FOR_FINAL_SUMMARY) {
                console.log(`[SummaryService] Session too short to summarise: ${units} units (need ${MIN_CONTENT_UNITS_FOR_FINAL_SUMMARY})`);
                return { success: false, skipped: 'too-short' };
            }

            const modelInfo = await modelStateService.getCurrentModelInfo('llm');
            if (!modelInfo || !modelInfo.apiKey) {
                console.warn('[SummaryService] No LLM configured, skipping final summary');
                return { success: false, skipped: 'no-llm' };
            }

            console.log(`[SummaryService] Generating final summary for ${sessionId}: ${transcripts.length} turns, ${units} units, model ${modelInfo.model}`);

            const basePrompt = getSystemPrompt('session_retrospective', '', false, this.preContext);
            const systemPrompt = basePrompt.replace('{{CONVERSATION_HISTORY}}', conversation);

            const llm = createLLM(modelInfo.provider, {
                apiKey: modelInfo.apiKey,
                baseUrl: modelInfo.baseUrl,
                model: modelInfo.model,
                temperature: 0.5,
                maxTokens: 2048,
            });

            // Must be chat(), not generateContent(). The two take different shapes: chat()
            // accepts {role, content} message objects, while generateContent() expects an array
            // of plain strings and silently discards anything else - which produced an empty
            // messages array and a 400 "at least one message is required" from Anthropic.
            const completion = await llm.chat([
                { role: 'system', content: systemPrompt },
                {
                    role: 'user',
                    content: `This session has ended. Produce the durable record of the WHOLE session.

**Summary Overview**
- 3-6 bullets covering the entire session, in chronological order

**Key Topic: [name the main subject]**
- The key points, decisions and outcomes
- Include disagreements, unanswered objections and apparent tension here, hedged appropriately
- 4-10 bullets

**Action Items**
1. Concrete follow-ups, each with the owner if the transcript makes it clear
2. Write "None identified" if the session produced no action items

Do NOT include follow-up questions or suggestions about what to say - the meeting is over.

**LANGUAGE INSTRUCTION:**
- Respond in Traditional Chinese (繁體中文)
- IMPORTANT: Keep section headers in English exactly as shown (do not translate "**Summary Overview**", "**Key Topic:**", "**Action Items**")
- Keep code snippets, technical terms, API names, libraries, frameworks, and proper nouns in English
- Translate all content to Traditional Chinese`,
                },
            ]);

            const responseText = completion.content;
            const data = this.parseFinalResponseText(responseText);

            await summaryRepository.saveFinalSummary({
                sessionId,
                text: responseText,
                tldr: data.summary.join('\n'),
                bullet_json: JSON.stringify(data.topic.bullets),
                action_json: JSON.stringify(data.actions),
                model: modelInfo.model,
            });

            console.log(`[SummaryService] Final summary saved for ${sessionId}: ${data.summary.length} overview, ${data.topic.bullets.length} points, ${data.actions.length} actions`);
            // Returned so listenService can hand it straight to the renderer. Avoids a second IPC
            // round-trip and a re-read of the row we just wrote.
            return { success: true, data };
        } catch (error) {
            console.error('[SummaryService] Failed to generate final summary:', error.message);
            return { success: false, error: error.message };
        }
    }

    getCurrentAnalysisData() {
        return {
            previousResult: this.previousAnalysisResult,
            history: this.analysisHistory,
            conversationLength: this.conversationHistory.length,
        };
    }
}

module.exports = SummaryService; 