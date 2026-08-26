import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

export class SummaryView extends LitElement {
    static styles = css`
        :host {
            display: block;
            width: 100%;
        }

        /* Inherit font styles from parent */

        /* highlight.js 스타일 추가 */
        .insights-container pre {
            background: rgba(0, 0, 0, 0.4) !important;
            border-radius: 8px !important;
            padding: 12px !important;
            margin: 8px 0 !important;
            overflow-x: auto !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            white-space: pre !important;
            word-wrap: normal !important;
            word-break: normal !important;
        }

        .insights-container code {
            font-family: 'Monaco', 'Menlo', 'Consolas', monospace !important;
            font-size: 11px !important;
            background: transparent !important;
            white-space: pre !important;
            word-wrap: normal !important;
            word-break: normal !important;
        }

        .insights-container pre code {
            white-space: pre !important;
            word-wrap: normal !important;
            word-break: normal !important;
            display: block !important;
        }

        .insights-container p code {
            background: rgba(255, 255, 255, 0.1) !important;
            padding: 2px 4px !important;
            border-radius: 3px !important;
            color: #ffd700 !important;
        }

        .hljs-keyword {
            color: #ff79c6 !important;
        }
        .hljs-string {
            color: #f1fa8c !important;
        }
        .hljs-comment {
            color: #6272a4 !important;
        }
        .hljs-number {
            color: #bd93f9 !important;
        }
        .hljs-function {
            color: #50fa7b !important;
        }
        .hljs-variable {
            color: #8be9fd !important;
        }
        .hljs-built_in {
            color: #ffb86c !important;
        }
        .hljs-title {
            color: #50fa7b !important;
        }
        .hljs-attr {
            color: #50fa7b !important;
        }
        .hljs-tag {
            color: #ff79c6 !important;
        }

        .insights-container {
            overflow-y: auto;
            padding: 12px 16px 16px 16px;
            position: relative;
            z-index: 1;
            min-height: 150px;
            max-height: 600px;
            flex: 1;
        }

        /* Visibility handled by parent component */

        .insights-container::-webkit-scrollbar {
            width: 8px;
        }
        .insights-container::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.1);
            border-radius: 4px;
        }
        .insights-container::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.3);
            border-radius: 4px;
        }
        .insights-container::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.5);
        }

        .final-status {
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 4px 0 10px 0;
            padding: 8px 10px;
            border-radius: 6px;
            font-size: 13px;
            line-height: 1.4;
        }
        .final-status.generating {
            background: rgba(255, 255, 255, 0.08);
            color: rgba(255, 255, 255, 0.9);
        }
        .final-status.failed {
            background: rgba(255, 120, 120, 0.12);
            color: rgba(255, 190, 190, 0.95);
        }
        /* A static "please wait" is indistinguishable from a frozen UI, which is the exact
           uncertainty this indicator exists to remove. The pulse is the proof of life. */
        .final-status .dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: currentColor;
            flex-shrink: 0;
            animation: final-pulse 1.2s ease-in-out infinite;
        }
        @keyframes final-pulse {
            0%, 100% { opacity: 0.25; }
            50%      { opacity: 1; }
        }

        insights-title {
            color: rgba(255, 255, 255, 0.8);
            font-size: 15px;
            font-weight: 500;
            font-family: 'Helvetica Neue', sans-serif;
            margin: 12px 0 8px 0;
            display: block;
        }

        .insights-container h4 {
            color: #ffffff;
            font-size: 12px;
            font-weight: 600;
            margin: 12px 0 8px 0;
            padding: 4px 8px;
            border-radius: 4px;
            background: transparent;
            cursor: default;
        }

        .insights-container h4:hover {
            background: transparent;
        }

        .insights-container h4:first-child {
            margin-top: 0;
        }

        .outline-item {
            color: #ffffff;
            font-size: 11px;
            line-height: 1.4;
            margin: 4px 0;
            padding: 6px 8px;
            border-radius: 4px;
            background: transparent;
            transition: background-color 0.15s ease;
            cursor: pointer;
            word-wrap: break-word;
        }

        .outline-item:hover {
            background: rgba(255, 255, 255, 0.1);
        }

        .request-item {
            color: #ffffff;
            font-size: 12px;
            line-height: 1.2;
            margin: 4px 0;
            padding: 6px 8px;
            border-radius: 4px;
            background: transparent;
            cursor: default;
            word-wrap: break-word;
            transition: background-color 0.15s ease;
        }

        .request-item.clickable {
            cursor: pointer;
            transition: all 0.15s ease;
        }
        .request-item.clickable:hover {
            background: rgba(255, 255, 255, 0.1);
            transform: translateX(2px);
        }

        /* 마크다운 렌더링된 콘텐츠 스타일 */
        .markdown-content {
            color: #ffffff;
            font-size: 11px;
            line-height: 1.4;
            margin: 4px 0;
            padding: 6px 8px;
            border-radius: 4px;
            background: transparent;
            cursor: pointer;
            word-wrap: break-word;
            transition: all 0.15s ease;
        }

        .markdown-content:hover {
            background: rgba(255, 255, 255, 0.1);
            transform: translateX(2px);
        }

        .markdown-content p {
            margin: 4px 0;
        }

        .markdown-content ul,
        .markdown-content ol {
            margin: 4px 0;
            padding-left: 16px;
        }

        .markdown-content li {
            margin: 2px 0;
        }

        .markdown-content a {
            color: #8be9fd;
            text-decoration: none;
        }

        .markdown-content a:hover {
            text-decoration: underline;
        }

        .markdown-content strong {
            font-weight: 600;
            color: #f8f8f2;
        }

        .markdown-content em {
            font-style: italic;
            color: #f1fa8c;
        }

        .empty-state {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100px;
            color: rgba(255, 255, 255, 0.6);
            font-size: 12px;
            font-style: italic;
        }
    `;

    static properties = {
        structuredData: { type: Object },
        isVisible: { type: Boolean },
        hasCompletedRecording: { type: Boolean },
        isFinalSummary: { type: Boolean },
        finalSummaryStatus: { type: String },
    };

    constructor() {
        super();
        this.structuredData = {
            summary: [],
            topic: { header: '', bullets: [] },
            actions: [],
            followUps: [],
        };
        this.isVisible = true;
        this.hasCompletedRecording = false;
        this.isFinalSummary = false;
        this.finalSummaryStatus = 'idle'; // idle | generating | ready | skipped | failed
        // 마크다운 라이브러리 초기화
        this.marked = null;
        this.hljs = null;
        this.isLibrariesLoaded = false;
        this.DOMPurify = null;
        this.isDOMPurifyLoaded = false;

        this.loadLibraries();
    }

    connectedCallback() {
        super.connectedCallback();
        if (window.api) {
            window.api.summaryView.onSummaryUpdate((event, data) => {
                this.structuredData = data;
                this.requestUpdate();
            });
            window.api.summaryView.onAnalysisResult((event, data) => {
                this.structuredData = data;
                this.requestUpdate();
            });
            // Arrives seconds after Stop, once the whole-session summary has been generated.
            // Replaces the live snapshot wholesale rather than merging: the live one only covers
            // the last 30 turns, so mixing the two would show whole-session points under a
            // recency-scoped headline. Keep followUps from the live data - they are static UI
            // affordances, not generated content, and the final summary does not produce them.
            window.api.summaryView.onFinalSummaryStatus((event, payload) => {
                if (!payload?.status) return;
                this.finalSummaryStatus = payload.status;

                if (payload.status === 'ready' && payload.data) {
                    this.structuredData = {
                        ...payload.data,
                        followUps: this.structuredData?.followUps || [],
                    };
                    this.isFinalSummary = true;
                }
                this.requestUpdate();
            });
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        if (window.api) {
            window.api.summaryView.removeAllSummaryUpdateListeners();
        }
    }

    // Handle session reset from parent
    resetAnalysis() {
        this.isFinalSummary = false;
        this.finalSummaryStatus = 'idle';
        this.structuredData = {
            summary: [],
            topic: { header: '', bullets: [] },
            actions: [],
            followUps: [],
        };
        this.requestUpdate();
    }

    async loadLibraries() {
        try {
            if (!window.marked) {
                await this.loadScript('../../../assets/marked-4.3.0.min.js');
            }

            if (!window.hljs) {
                await this.loadScript('../../../assets/highlight-11.9.0.min.js');
            }

            if (!window.DOMPurify) {
                await this.loadScript('../../../assets/dompurify-3.0.7.min.js');
            }

            this.marked = window.marked;
            this.hljs = window.hljs;
            this.DOMPurify = window.DOMPurify;

            if (this.marked && this.hljs) {
                this.marked.setOptions({
                    highlight: (code, lang) => {
                        if (lang && this.hljs.getLanguage(lang)) {
                            try {
                                return this.hljs.highlight(code, { language: lang }).value;
                            } catch (err) {
                                console.warn('Highlight error:', err);
                            }
                        }
                        try {
                            return this.hljs.highlightAuto(code).value;
                        } catch (err) {
                            console.warn('Auto highlight error:', err);
                        }
                        return code;
                    },
                    breaks: true,
                    gfm: true,
                    pedantic: false,
                    smartypants: false,
                    xhtml: false,
                });

                this.isLibrariesLoaded = true;
                console.log('Markdown libraries loaded successfully');
            }

            if (this.DOMPurify) {
                this.isDOMPurifyLoaded = true;
                console.log('DOMPurify loaded successfully in SummaryView');
            }
        } catch (error) {
            console.error('Failed to load libraries:', error);
        }
    }

    loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    parseMarkdown(text) {
        if (!text) return '';

        if (!this.isLibrariesLoaded || !this.marked) {
            return text;
        }

        try {
            return this.marked(text);
        } catch (error) {
            console.error('Markdown parsing error:', error);
            return text;
        }
    }

    handleMarkdownClick(originalText) {
        this.handleRequestClick(originalText);
    }

    renderMarkdownContent() {
        if (!this.isLibrariesLoaded || !this.marked) {
            return;
        }

        const markdownElements = this.shadowRoot.querySelectorAll('[data-markdown-id]');
        markdownElements.forEach(element => {
            const originalText = element.getAttribute('data-original-text');
            if (originalText) {
                try {
                    let parsedHTML = this.parseMarkdown(originalText);

                    if (this.isDOMPurifyLoaded && this.DOMPurify) {
                        parsedHTML = this.DOMPurify.sanitize(parsedHTML);

                        if (this.DOMPurify.removed && this.DOMPurify.removed.length > 0) {
                            console.warn('Unsafe content detected in insights, showing plain text');
                            element.textContent = '⚠️ ' + originalText;
                            return;
                        }
                    }

                    element.innerHTML = parsedHTML;
                } catch (error) {
                    console.error('Error rendering markdown for element:', error);
                    element.textContent = originalText;
                }
            }
        });
    }

    async handleRequestClick(requestText) {
        console.log('🔥 Analysis request clicked:', requestText);

        if (window.api) {
            try {
                const result = await window.api.summaryView.sendQuestionFromSummary(requestText);

                if (result.success) {
                    console.log('✅ Question sent to AskView successfully');
                } else {
                    console.error('❌ Failed to send question to AskView:', result.error);
                }
            } catch (error) {
                console.error('❌ Error in handleRequestClick:', error);
            }
        }
    }

    _renderClickableItem(text) {
        return html`
            <div
                class="markdown-content"
                data-markdown-id="${text.substring(0, 20)}"
                data-original-text="${text}"
                @click=${() => this.handleRequestClick(text)}
            >
                ${text}
            </div>
        `;
    }

    /**
     * Scroll the insights pane by a pixel delta. Exposed so ListenView can drive scrolling
     * from a global shortcut without reaching into this component's shadow root.
     * @param {number} delta - pixels to scroll; negative scrolls up.
     */
    scrollContent(delta) {
        const container = this.shadowRoot.querySelector('.insights-container');
        if (container) container.scrollTop += delta;
    }

    getSummaryText() {
        const data = this.structuredData || { summary: [], topic: { header: '', bullets: [] }, actions: [] };
        let sections = [];

        if (data.summary && data.summary.length > 0) {
            sections.push(`Current Summary:\n${data.summary.map(s => `• ${s}`).join('\n')}`);
        }

        if (data.topic && data.topic.header && data.topic.bullets.length > 0) {
            sections.push(`\n${data.topic.header}:\n${data.topic.bullets.map(b => `• ${b}`).join('\n')}`);
        }

        if (data.actions && data.actions.length > 0) {
            sections.push(`\nActions:\n${data.actions.map(a => `▸ ${a}`).join('\n')}`);
        }

        if (data.followUps && data.followUps.length > 0) {
            sections.push(`\nFollow-Ups:\n${data.followUps.map(f => `▸ ${f}`).join('\n')}`);
        }

        return sections.join('\n\n').trim();
    }

    updated(changedProperties) {
        super.updated(changedProperties);
        this.renderMarkdownContent();
    }

    render() {
        if (!this.isVisible) {
            return html`<div style="display: none;"></div>`;
        }

        const data = this.structuredData || {
            summary: [],
            topic: { header: '', bullets: [] },
            actions: [],
        };

        const hasAnyContent = data.summary.length > 0 || data.topic.bullets.length > 0 || data.actions.length > 0;

        return html`
            <div class="insights-container">
                ${!hasAnyContent
                    ? html`<div class="empty-state">No insights yet...</div>`
                    : html`
                        ${this.finalSummaryStatus === 'generating'
                            ? html`<div class="final-status generating">
                                       <span class="dot"></span>
                                       正在產生完整會議摘要，請稍候…
                                   </div>`
                            : ''}
                        ${this.finalSummaryStatus === 'failed'
                            ? html`<div class="final-status failed">
                                       無法產生完整會議摘要，以下為即時摘要（部分）
                                   </div>`
                            : ''}
                        <insights-title>
                            ${this.isFinalSummary ? '完整會議摘要' : 'Current Summary'}
                        </insights-title>
                        ${data.summary.length > 0
                            ? data.summary
                                  // The live snapshot is capped at 5 for glanceability mid-meeting.
                                  // The final summary is the durable record and is read after the
                                  // meeting, so show all of it - truncating it here would silently
                                  // hide whole-session points, which is the defect being fixed.
                                  .slice(0, this.isFinalSummary ? data.summary.length : 5)
                                  .map(
                                      (bullet) => this._renderClickableItem(bullet)
                                  )
                            : html` <div class="request-item">No content yet...</div> `}
                        ${data.topic.header
                            ? html`
                                  <insights-title>${data.topic.header}</insights-title>
                                  ${data.topic.bullets
                                      .slice(0, 3)
                                      .map(
                                          (bullet) => this._renderClickableItem(bullet)
                                      )}
                              `
                            : ''}
                        ${data.actions.length > 0
                            ? html`
                                  <insights-title>Actions</insights-title>
                                  ${data.actions
                                      .slice(0, 5)
                                      .map(
                                          (action) => this._renderClickableItem(action)
                                      )}
                              `
                            : ''}
                        ${this.hasCompletedRecording && data.followUps && data.followUps.length > 0
                            ? html`
                                  <insights-title>Follow-Ups</insights-title>
                                  ${data.followUps.map(
                                      (followUp) => this._renderClickableItem(followUp)
                                  )}
                              `
                            : ''}
                    `}
            </div>
        `;
    }
}

customElements.define('summary-view', SummaryView); 