'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { useRedirectIfNotAuth } from '@/utils/auth'
import {
  UserProfile,
  Session,
  getSessions,
  deleteSession,
} from '@/utils/api'

/**
 * Buckets a session by how a person would recall it. People remember "a few days ago", not
 * "September 3", so the list is grouped the way memory is organised rather than by raw date.
 *
 * @param startedAt - Session start, in seconds since the epoch
 * @returns Group key, ordered by GROUP_ORDER
 */
const groupFor = (startedAt: number): string => {
  const started = new Date(startedAt * 1000)
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

  const daysAgo = Math.floor((startOfToday.getTime() - started.getTime()) / 86400000)
  if (daysAgo < 0) return 'Today'
  if (daysAgo === 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  if (daysAgo < 7) return 'This week'
  if (daysAgo < 30) return 'This month'
  return 'Earlier'
}

const GROUP_ORDER = ['Today', 'Yesterday', 'This week', 'This month', 'Earlier']

/**
 * Renders how long the conversation actually ran, or nothing when it cannot be known.
 *
 * Uses `content_span` - first record to last - rather than `ended_at - started_at`, because
 * `ended_at` marks when the app closed the session, which can be days after anyone stopped
 * talking. A session with no records has no honest duration to show, so none is shown.
 */
const formatDuration = (session: Session): string | null => {
  const seconds = session.content_span
  if (!seconds || seconds < 0) return null
  const minutes = Math.round(seconds / 60)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/** The scannable facts under a card's preview line, with empty ones dropped rather than zeroed. */
const metaParts = (session: Session): string[] => {
  const parts: string[] = [
    new Date(session.started_at * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  ]
  const duration = formatDuration(session)
  if (duration) parts.push(duration)
  if (session.ask_count) parts.push(`${session.ask_count} ask${session.ask_count === 1 ? '' : 's'}`)
  if (session.transcript_count) parts.push(`${session.transcript_count} lines`)
  return parts
}

export default function ActivityPage() {
  const userInfo = useRedirectIfNotAuth() as UserProfile | null;
  const [sessions, setSessions] = useState<Session[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const fetchSessions = async () => {
    try {
      const fetchedSessions = await getSessions();
      setSessions(fetchedSessions);
    } catch (error) {
      console.error('Failed to fetch conversations:', error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchSessions()
  }, [])

  // Sessions arrive newest-first, so each bucket keeps that order for free.
  const grouped = useMemo(() => {
    const buckets = new Map<string, Session[]>()
    for (const session of sessions) {
      const key = groupFor(session.started_at)
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key)!.push(session)
    }
    return GROUP_ORDER.filter(key => buckets.has(key)).map(key => ({ key, items: buckets.get(key)! }))
  }, [sessions])

  if (!userInfo) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    )
  }

  const getGreeting = () => {
    const hour = new Date().getHours()
    if (hour < 12) return 'Good morning'
    if (hour < 18) return 'Good afternoon'
    return 'Good evening'
  }

  const handleDelete = async (sessionId: string) => {
    if (!window.confirm('Are you sure you want to delete this activity? This cannot be undone.')) return;
    setDeletingId(sessionId);
    try {
      await deleteSession(sessionId);
      setSessions(sessions => sessions.filter(s => s.id !== sessionId));
    } catch (error) {
      alert('Failed to delete activity.');
      console.error(error);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-8 py-12">
        <div className="text-center mb-10">
          <h1 className="text-2xl text-gray-600">
            {getGreeting()}, {userInfo.display_name}
          </h1>
        </div>
        <div>
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-semibold text-gray-900">Your Past Activity</h2>
            <Link
              href="/activity/actions"
              className="text-sm font-medium text-blue-600 hover:text-blue-800"
            >
              Action items →
            </Link>
          </div>
          {isLoading ? (
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-600 mx-auto"></div>
              <p className="mt-4 text-gray-600">Loading conversations...</p>
            </div>
          ) : sessions.length > 0 ? (
            <div className="space-y-8">
              {grouped.map(({ key, items }) => (
                <section key={key}>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">
                    {key}
                  </h3>
                  <div className="space-y-3">
                    {items.map((session) => (
                      <div
                        key={session.id}
                        className="block bg-white rounded-lg p-5 shadow-sm border border-gray-200 hover:shadow-md transition-shadow"
                      >
                        <div className="flex justify-between items-start gap-4">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`capitalize inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${session.session_type === 'listen' ? 'bg-blue-100 text-blue-800' : 'bg-green-100 text-green-800'}`}>
                                {session.session_type || 'ask'}
                              </span>
                              <Link
                                href={`/activity/details?sessionId=${session.id}`}
                                className="text-lg font-medium text-gray-900 hover:underline truncate"
                              >
                                {session.title || `Conversation - ${new Date(session.started_at * 1000).toLocaleDateString()}`}
                              </Link>
                            </div>

                            {/* The preview line is what makes a card identifiable - the title is
                                usually auto-generated. A live summary is labelled, because it only
                                covers the last stretch of the session. */}
                            {session.tldr && (
                              <p className="text-sm text-gray-600 line-clamp-2 mb-2">
                                {session.summary_is_final === 0 && (
                                  <span className="text-amber-700 font-medium">即時摘要（部分）· </span>
                                )}
                                {session.tldr}
                              </p>
                            )}

                            <div className="text-xs text-gray-500">
                              {metaParts(session).join(' · ')}
                            </div>
                          </div>

                          <button
                            onClick={() => handleDelete(session.id)}
                            disabled={deletingId === session.id}
                            className={`shrink-0 px-3 py-1 rounded text-xs font-medium border border-red-200 text-red-700 bg-red-50 hover:bg-red-100 transition-colors ${deletingId === session.id ? 'opacity-50 cursor-not-allowed' : ''}`}
                          >
                            {deletingId === session.id ? 'Deleting...' : 'Delete'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="text-center bg-white rounded-lg p-12">
              <p className="text-gray-500 mb-4">
                No conversations yet. Start a conversation in the desktop app to see your activity here.
              </p>
              <div className="text-sm text-gray-400">
                💡 Tip: Use the desktop app to have AI-powered conversations that will appear here automatically.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
