/**
 * Voice-triggered snippets: a spoken trigger phrase is replaced by a longer saved prompt before
 * the message reaches Ask.
 *
 * Matching is deliberately LOOSE (substring, not whole-utterance equality). Two reasons, both
 * measured: Deepgram runs with smart_format=true so it returns punctuation and capitals
 * ("My email, sig."), and the mic is warm during a live conversation, so the other person's
 * speech lands in the same transcript ("yeah so anyway let me think about this right"). Exact
 * match fails in both cases. A false positive costs only a slightly-off answer on a private
 * overlay, so loose matching is the correct trade here.
 */

const snippetRepository = require('../common/repositories/snippet');

/**
 * Reduce a phrase to a comparable form: case, punctuation and spacing all vary between what the
 * user typed into the config and what the STT provider returns for the same words.
 * @param {string} text
 * @returns {string} lowercased, punctuation-stripped, single-spaced
 */
function normalize(text) {
    return (text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')  // keep letters/digits across scripts, drop the rest
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Find the snippet whose trigger appears in the transcript.
 * Longest trigger wins, so a trigger that contains another still resolves predictably.
 *
 * A failure to load snippets must never block voice-ask: on error this returns null and the
 * caller sends the transcript through as an ordinary question.
 *
 * @param {string} transcript Raw STT output.
 * @returns {Promise<{trigger_phrase: string, expansion: string}|null>} the match, or null
 */
async function match(transcript) {
    const haystack = normalize(transcript);
    if (!haystack) return null;

    let snippets;
    try {
        snippets = await snippetRepository.getSnippets();
    } catch (err) {
        console.error('[Snippets] could not load snippets, sending transcript as-is:', err.message);
        return null;
    }

    let best = null;
    let bestLength = 0;
    for (const snippet of snippets || []) {
        const needle = normalize(snippet.trigger_phrase);
        if (!needle || !haystack.includes(needle)) continue;
        if (needle.length > bestLength) {
            best = snippet;
            bestLength = needle.length;
        }
    }
    return best;
}

module.exports = { match, normalize };
