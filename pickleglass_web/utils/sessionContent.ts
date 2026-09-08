import { Transcript, AiMessage } from './api'

/**
 * A run of consecutive transcript lines, or a single Ask message, placed on one shared timeline.
 *
 * Transcript lines are folded into runs rather than listed individually because the interesting
 * events are the questions; the speech between them is context that should stay reachable without
 * dominating the page.
 */
export type TimelineEntry =
  | { kind: 'transcript'; at: number; lines: Transcript[] }
  | { kind: 'message'; at: number; message: AiMessage }

/**
 * Parses a JSON array column into strings.
 *
 * Anything unparseable or not an array of strings degrades to an empty list rather than throwing:
 * these columns are written by a model, and one malformed row should cost the user that row's
 * bullets, not the whole page.
 *
 * @param json - Raw column value
 * @returns The strings it contained, or an empty array
 */
export const parseList = (json?: string | null): string[] => {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
  } catch {
    return []
  }
}

/**
 * Placeholders a summary emits when it found no commitments. They are stored as ordinary items,
 * so without this they render as checkable action items the user can never complete - in one real
 * database, 31 of 42 finished sessions carried one.
 *
 * Matched only at the start of an item, and only for this exact phrase, so a genuine action that
 * happens to contain the words is never dropped.
 */
const NO_ACTION_PLACEHOLDER = /^\s*none identified\b/i

/**
 * The real action items in a summary's `final_action_json`.
 *
 * Only ever pass the FINAL column. The live snapshot's `action_json` holds live-assist
 * affordances - suggested questions plus hardcoded chips like "✨ What should I say next?" - which
 * `summaryService.parseFinalResponseText` documents as "meaningless in a durable record where
 * `actions` must mean action items". Every live row in one real database carried those chips and
 * no final row did, so treating the live column as action items produces pure noise.
 *
 * @param finalActionJson - The `final_action_json` column
 * @returns Action items worth showing, placeholders removed
 */
export const actionItemsFrom = (finalActionJson?: string | null): string[] =>
  parseList(finalActionJson).filter(item => !NO_ACTION_PLACEHOLDER.test(item))

/**
 * Interleaves transcript lines and Ask messages by timestamp, folding consecutive transcript
 * lines into runs.
 *
 * The two record types were previously rendered as separate sections, which severed the thing
 * that makes a review useful: a question was asked *during* the meeting, about what had just been
 * said. Both carry timestamps, so the true order is recoverable from data already stored.
 *
 * The sort is stable (ECMAScript guarantees it), so records sharing a timestamp keep the order
 * they were stored in - transcripts before messages, since transcripts are listed first.
 *
 * @param transcripts - Session transcript lines, any order
 * @param messages - Session Ask messages, any order
 * @returns Chronological timeline entries
 */
export function buildTimeline(transcripts: Transcript[], messages: AiMessage[]): TimelineEntry[] {
  const events: Array<{ at: number; transcript?: Transcript; message?: AiMessage }> = [
    ...transcripts.map(t => ({ at: t.start_at, transcript: t })),
    ...messages.map(m => ({ at: m.sent_at, message: m })),
  ].sort((a, b) => a.at - b.at)

  const timeline: TimelineEntry[] = []
  for (const event of events) {
    if (event.message) {
      timeline.push({ kind: 'message', at: event.at, message: event.message })
      continue
    }
    const previous = timeline[timeline.length - 1]
    if (previous?.kind === 'transcript') {
      previous.lines.push(event.transcript!)
    } else {
      timeline.push({ kind: 'transcript', at: event.at, lines: [event.transcript!] })
    }
  }
  return timeline
}
