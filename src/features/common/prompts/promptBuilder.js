const { profilePrompts } = require('./promptTemplates.js');

// screenAttached defaults to false because three of the four callers (summaryService's initial
// summary, its periodic analysis and its final retrospective) send no image at all, and the
// fourth, askService, attaches one only when the capture succeeded. A caller that forgets the
// flag therefore gets a prompt that claims less than it has, never more.
function buildSystemPrompt(promptParts, { customPrompt = '', googleSearchEnabled = true, preContext = null, screenAttached = false } = {}) {
    const resolved = { customPrompt, googleSearchEnabled, preContext, screenAttached };
    const resolve = part => (typeof part === 'function' ? part(resolved) : part);

    const sections = [resolve(promptParts.intro), '\n\n', resolve(promptParts.formatRequirements)];

    if (googleSearchEnabled) {
        sections.push('\n\n', resolve(promptParts.searchUsage));
    }

    sections.push('\n\n', resolve(promptParts.content), '\n\nUser-provided context\n-----\n', customPrompt, '\n-----\n');

    if (preContext) {
        sections.push('\n\nPre-loaded session context\n-----\n', preContext, '\n-----\n');
    }

    sections.push('\n\n', resolve(promptParts.outputInstructions));

    return sections.join('');
}

function getSystemPrompt(options) {
    const promptParts = profilePrompts[options.profile] || profilePrompts.interview;
    return buildSystemPrompt(promptParts, options);
}

module.exports = {
    getSystemPrompt,
};
