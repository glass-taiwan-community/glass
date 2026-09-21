/**
 * One-shot latency timeline for the voice-ask path.
 *
 * A single "how many seconds does it take" number is not actionable: the hold-to-Ask path is a
 * serial chain of STT round trip -> screenshot capture -> LLM time-to-first-token, and each has a
 * completely different fix. This records a mark per stage so the slow one is identifiable.
 *
 * Inert unless a run is open: mark() is a boolean check when nothing started the run, so the
 * calls can sit permanently on the hot path without costing anything.
 */

let running = false;
let t0 = 0;
let marks = [];
let runLabel = '';

/** Open a run. Any run already open is dropped -- only the newest hold is being measured. */
function start(label = 'run') {
    running = true;
    runLabel = label;
    t0 = Date.now();
    marks = [];
}

/**
 * Record a stage boundary. No-op when no run is open.
 * @param {string} name Stage name, printed in the timeline.
 * @param {string} [detail] Optional extra shown beside the timing (size, transcript, model).
 */
function mark(name, detail) {
    if (!running) return;
    marks.push({ name, at: Date.now() - t0, detail: detail || '' });
}

/**
 * Close the run and print the timeline: absolute offset from T0 plus the delta each stage cost,
 * since the delta is what identifies the bottleneck.
 */
function end(name = 'end', detail) {
    if (!running) return;
    mark(name, detail);
    running = false;

    const lines = [`[Latency] ${runLabel} -- T0 is the moment the key was released`];
    let prev = 0;
    for (const m of marks) {
        const delta = m.at - prev;
        prev = m.at;
        lines.push(
            `  T+${String(m.at).padStart(5)}ms  ${m.name.padEnd(14)} (+${String(delta).padStart(5)}ms)`
            + (m.detail ? `  ${m.detail}` : '')
        );
    }
    lines.push(`  TOTAL ${prev}ms to '${marks[marks.length - 1].name}'`);
    console.log(lines.join('\n'));
}

/** @returns {boolean} whether a run is currently open */
function isRunning() {
    return running;
}

module.exports = { start, mark, end, isRunning };
