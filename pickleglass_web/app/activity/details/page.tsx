'use client'

import { useState, useEffect, useMemo, Suspense } from 'react'
import { useRedirectIfNotAuth } from '@/utils/auth'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ChevronDown, ChevronRight, HelpCircle } from 'lucide-react'
import {
  UserProfile,
  SessionDetails,
  Transcript,
  getSessionDetails,
  deleteSession,
  setActionItemsDone,
  getApiOrigin,
} from '@/utils/api'
import { actionItemsFrom, buildTimeline, parseList, sessionTitle } from '@/utils/sessionContent'
import Markdown from '@/components/Markdown'

/** Runs at least this long start collapsed. Shorter ones are cheaper to show than to hide. */
const COLLAPSE_RUN_AT = 4

const clock = (seconds: number) =>
  new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const Section = ({ title, children }: { title: string, children: React.ReactNode }) => (
    <div className="mb-8">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-3">{title}</h2>
        <div className="text-gray-700 dark:text-gray-300 space-y-2">
            {children}
        </div>
    </div>
);

function TranscriptRun({ lines }: { lines: Transcript[] }) {
  const [expanded, setExpanded] = useState(lines.length < COLLAPSE_RUN_AT)

  if (expanded) {
    return (
      <div className="border-l-2 border-gray-200 dark:border-gray-800 pl-4 space-y-1.5">
        {lines.length >= COLLAPSE_RUN_AT && (
          <button
            onClick={() => setExpanded(false)}
            className="flex items-center text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 hover:dark:text-gray-300 mb-1"
          >
            <ChevronDown className="h-3.5 w-3.5 mr-1" />
            Hide {lines.length} lines
          </button>
        )}
        {lines.map(line => (
          <p key={line.id} className="text-sm text-gray-600 dark:text-gray-400">
            <span className="text-gray-400 dark:text-gray-500 tabular-nums mr-2">{clock(line.start_at)}</span>
            <span className="font-medium capitalize text-gray-700 dark:text-gray-300">{line.speaker}: </span>
            {line.text}
          </p>
        ))}
      </div>
    )
  }

  return (
    <button
      onClick={() => setExpanded(true)}
      className="flex items-start w-full text-left border-l-2 border-gray-200 dark:border-gray-800 pl-4 py-1 group"
    >
      <ChevronRight className="h-3.5 w-3.5 mr-1 mt-0.5 text-gray-400 dark:text-gray-500 group-hover:text-gray-600 group-hover:dark:text-gray-400 shrink-0" />
      <span className="text-sm text-gray-500 dark:text-gray-400 group-hover:text-gray-700 group-hover:dark:text-gray-300">
        {lines.length} lines of conversation
        <span className="text-gray-400 dark:text-gray-500"> — {lines[0].text.slice(0, 80)}…</span>
      </span>
    </button>
  )
}

function SessionDetailsContent() {
  const userInfo = useRedirectIfNotAuth() as UserProfile | null;
  const [sessionDetails, setSessionDetails] = useState<SessionDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('sessionId');
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [doneActions, setDoneActions] = useState<string[]>([]);

  useEffect(() => {
    if (userInfo && sessionId) {
      const fetchDetails = async () => {
        setIsLoading(true);
        try {
          const details = await getSessionDetails(sessionId as string);
          setSessionDetails(details);
          setDoneActions(parseList(details?.summary?.action_done_json));
        } catch (error) {
          console.error('Failed to load session details:', error);
        } finally {
          setIsLoading(false);
        }
      };
      fetchDetails();
    }
  }, [userInfo, sessionId]);

  const timeline = useMemo(
    () => buildTimeline(sessionDetails?.transcripts ?? [], sessionDetails?.ai_messages ?? []),
    [sessionDetails]
  );

  const handleDelete = async () => {
    if (!sessionId) return;
    if (!window.confirm('Are you sure you want to delete this activity? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await deleteSession(sessionId);
      router.push('/activity');
    } catch (error) {
      alert('Failed to delete activity.');
      setDeleting(false);
      console.error(error);
    }
  };

  /**
   * Toggles one action item. Updates optimistically so the checkbox never lags the click, and
   * rolls back on failure - a checkbox that silently forgets is worse than one that refuses.
   */
  const toggleAction = async (action: string) => {
    if (!sessionId) return;
    const previous = doneActions;
    const next = previous.includes(action)
      ? previous.filter(item => item !== action)
      : [...previous, action];

    setDoneActions(next);
    try {
      await setActionItemsDone(sessionId, next);
    } catch (error) {
      console.error('Failed to save action items:', error);
      setDoneActions(previous);
      alert('Could not save that change.');
    }
  };

  if (!userInfo || isLoading) {
    return (
      <div className="min-h-screen bg-[#FDFCF9] dark:bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-600 mx-auto"></div>
          <p className="mt-4 text-gray-600 dark:text-gray-400">Loading session details...</p>
        </div>
      </div>
    );
  }

  if (!sessionDetails) {
    return (
        <div className="min-h-screen bg-[#FDFCF9] dark:bg-gray-950 flex items-center justify-center">
            <div className="max-w-4xl mx-auto px-8 py-12 text-center">
                <h2 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-8">Session Not Found</h2>
                <p className="text-gray-600 dark:text-gray-400">The requested session could not be found.</p>
                                    <Link href="/activity" className="mt-4 inline-block text-blue-600 dark:text-blue-400 hover:text-blue-800 hover:dark:text-blue-200">
                        &larr; Back to Activity
                    </Link>
            </div>
        </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#FDFCF9] dark:bg-gray-950 text-gray-800 dark:text-gray-200">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
            <div className="mb-8">
                <Link href="/activity" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 hover:dark:text-gray-300 flex items-center">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back
                </Link>
            </div>

            <div className="bg-white dark:bg-gray-900 p-8 rounded-xl shadow-md border border-gray-100 dark:border-gray-800">
                <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
                            {sessionTitle(sessionDetails.session)}
                        </h1>
                        <div className="flex items-center text-sm text-gray-500 dark:text-gray-400 space-x-4">
                            <span>{new Date(sessionDetails.session.started_at * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
                            <span>{new Date(sessionDetails.session.started_at * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}</span>
                            <span className={`capitalize px-2 py-0.5 rounded-full text-xs font-medium ${sessionDetails.session.session_type === 'listen' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200' : 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200'}`}>
                                {sessionDetails.session.session_type}
                            </span>
                        </div>
                    </div>
                    <button
                        onClick={handleDelete}
                        disabled={deleting}
                        className={`px-4 py-2 rounded text-sm font-medium border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:bg-red-900/40 transition-colors ${deleting ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                        {deleting ? 'Deleting...' : 'Delete Activity'}
                    </button>
                </div>

                {sessionDetails.summary && (() => {
                    // Switch on the WHOLE artifact, never field by field. The live snapshot only
                    // covers the last 30 turns and is rewritten every 5, so mixing its bullets
                    // under a whole-session headline yields a summary that contradicts itself.
                    const isFinal = Boolean(sessionDetails.summary.final_generated_at)
                    const view = isFinal
                        ? {
                            tldr: sessionDetails.summary.final_tldr,
                            bullet_json: sessionDetails.summary.final_bullet_json,
                            action_json: sessionDetails.summary.final_action_json,
                          }
                        : {
                            tldr: sessionDetails.summary.tldr,
                            bullet_json: sessionDetails.summary.bullet_json,
                            action_json: sessionDetails.summary.action_json,
                          }

                    const bullets = parseList(view.bullet_json)
                    // Action items exist only in the final artifact. The live snapshot's
                    // action_json holds live-assist affordances ("✨ What should I say next?"),
                    // which summaryService documents as meaningless in a durable record - showing
                    // them under an "Action Items" heading invents commitments that were never made.
                    const actions = isFinal ? actionItemsFrom(view.action_json) : []

                    return (
                    <Section title="Summary">
                        {/* The two artifacts are not interchangeable and cannot be told apart by
                            reading them, so label which one is on screen. "（部分）" is doing real
                            work: it warns that early material may be missing and the transcript
                            below is the authority. */}
                        <div className="mb-3">
                            <span className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                                isFinal ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-900'
                                        : 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900'
                            }`}>
                                {isFinal ? '完整會議摘要' : '即時摘要（部分）'}
                            </span>
                        </div>

                        {view.tldr && <p className="text-lg italic text-gray-600 dark:text-gray-400 mb-4">"{view.tldr}"</p>}

                        {bullets.length > 0 &&
                            <div className="mt-4">
                                <h3 className="font-semibold text-gray-700 dark:text-gray-300 mb-2">Key Points:</h3>
                                <ul className="list-disc list-inside space-y-1 text-gray-600 dark:text-gray-400">
                                    {bullets.map((point: string, index: number) => (
                                        <li key={index}>{point}</li>
                                    ))}
                                </ul>
                            </div>
                        }

                        {/* Checkable, because an extracted commitment that cannot be ticked off is
                            an insight with no exit - the user has to copy it somewhere else to act
                            on it, and most never will. */}
                        {actions.length > 0 &&
                            <div className="mt-4">
                                <h3 className="font-semibold text-gray-700 dark:text-gray-300 mb-2">Action Items:</h3>
                                <ul className="space-y-1.5">
                                    {actions.map((action: string, index: number) => {
                                        const done = doneActions.includes(action)
                                        return (
                                            <li key={index}>
                                                <label className="flex items-start gap-2 cursor-pointer group">
                                                    <input
                                                        type="checkbox"
                                                        checked={done}
                                                        onChange={() => toggleAction(action)}
                                                        className="mt-1 h-4 w-4 rounded border-gray-300 dark:border-gray-700 text-blue-600 dark:text-blue-400 focus:ring-blue-500"
                                                    />
                                                    <span className={done ? 'text-gray-400 dark:text-gray-500 line-through' : 'text-gray-700 dark:text-gray-300 group-hover:text-gray-900 group-hover:dark:text-gray-100'}>
                                                        {action}
                                                    </span>
                                                </label>
                                            </li>
                                        )
                                    })}
                                </ul>
                            </div>
                        }
                    </Section>
                    )
                })()}

                {timeline.length > 0 && (
                    <Section title="Timeline">
                        <div className="space-y-4">
                            {timeline.map((entry, index) => {
                                if (entry.kind === 'transcript') {
                                    return <TranscriptRun key={`run-${entry.at}-${index}`} lines={entry.lines} />
                                }

                                const message = entry.message
                                const isUser = message.role === 'user'
                                return (
                                    <div
                                        key={message.id}
                                        className={`rounded-lg p-3 ${isUser ? 'bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-800' : 'bg-blue-50 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900'}`}
                                    >
                                        <div className="flex items-center gap-2 mb-1 text-sm font-semibold text-gray-600 dark:text-gray-400">
                                            {isUser && <HelpCircle className="h-4 w-4 text-gray-500 dark:text-gray-400" />}
                                            <span>{isUser ? 'You asked' : 'AI'}</span>
                                            <span className="font-normal text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                                                {clock(message.sent_at)}
                                            </span>
                                        </div>
                                        {message.content
                                            ? <Markdown content={message.content} className="text-gray-800 dark:text-gray-200" />
                                            : message.image_path
                                                ? <p className="text-gray-400 dark:text-gray-500 italic text-sm">Screen capture</p>
                                                : null}
                                        {message.image_path && (
                                            <a href={`${getApiOrigin()}/api/ask-screenshots/${message.image_path}`} target="_blank" rel="noopener noreferrer">
                                                <img
                                                    src={`${getApiOrigin()}/api/ask-screenshots/${message.image_path}`}
                                                    alt="Screen capture at time of question"
                                                    className="mt-2 max-h-48 rounded border border-gray-200 dark:border-gray-800 hover:opacity-90 transition-opacity"
                                                />
                                            </a>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    </Section>
                )}
            </div>
        </div>
    </div>
  );
}

export default function SessionDetailsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#FDFCF9] dark:bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-600 mx-auto"></div>
          <p className="mt-4 text-gray-600 dark:text-gray-400">Loading...</p>
        </div>
      </div>
    }>
      <SessionDetailsContent />
    </Suspense>
  );
}
