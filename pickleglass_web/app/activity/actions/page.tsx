'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { useRedirectIfNotAuth } from '@/utils/auth'
import {
  UserProfile,
  SessionActionItems,
  getActionItems,
  setActionItemsDone,
} from '@/utils/api'
import { actionItemsFrom, parseList, sessionTitle } from '@/utils/sessionContent'

/** The real action items for one session. The server only sends finished sessions here. */
const actionsFor = (row: SessionActionItems): string[] => actionItemsFrom(row.final_action_json)

export default function ActionItemsPage() {
  const userInfo = useRedirectIfNotAuth() as UserProfile | null
  const [rows, setRows] = useState<SessionActionItems[]>([])
  const [done, setDone] = useState<Record<string, string[]>>({})
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCompleted, setShowCompleted] = useState(false)

  useEffect(() => {
    if (!userInfo) return
    const load = async () => {
      try {
        const fetched = await getActionItems()
        setRows(fetched)
        setDone(Object.fromEntries(
          fetched.map(row => [row.session_id, parseList(row.action_done_json)])
        ))
        setError(null)
      } catch (err) {
        console.error('Failed to load action items:', err)
        setError('Could not load action items. The desktop app may not be running.')
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [userInfo])

  // Sessions whose items are all ticked off drop out unless the user asks to see them: an
  // open-commitments list that keeps growing forever stops being read.
  const visible = useMemo(() => {
    return rows
      .map(row => {
        const actions = actionsFor(row)
        const completed = done[row.session_id] ?? []
        const open = actions.filter(action => !completed.includes(action))
        return { row, actions, completed, open }
      })
      .filter(entry => entry.actions.length > 0)
      .filter(entry => showCompleted || entry.open.length > 0)
  }, [rows, done, showCompleted])

  const openCount = useMemo(
    () => rows.reduce((total, row) => {
      const completed = done[row.session_id] ?? []
      return total + actionsFor(row).filter(action => !completed.includes(action)).length
    }, 0),
    [rows, done]
  )

  /** Toggles one item optimistically, rolling back if the write fails. */
  const toggle = async (sessionId: string, action: string) => {
    const previous = done[sessionId] ?? []
    const next = previous.includes(action)
      ? previous.filter(item => item !== action)
      : [...previous, action]

    setDone(current => ({ ...current, [sessionId]: next }))
    try {
      await setActionItemsDone(sessionId, next)
    } catch (err) {
      console.error('Failed to save action items:', err)
      setDone(current => ({ ...current, [sessionId]: previous }))
      alert('Could not save that change.')
    }
  }

  if (!userInfo) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-600 mx-auto"></div>
          <p className="mt-4 text-gray-600 dark:text-gray-400">Loading...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="max-w-3xl mx-auto px-8 py-12">
        <Link href="/activity" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 hover:dark:text-gray-300">
          &larr; Back to Activity
        </Link>

        <div className="flex items-baseline justify-between mt-6 mb-8">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            Action Items
            {!isLoading && openCount > 0 && (
              <span className="ml-3 text-base font-normal text-gray-500 dark:text-gray-400">{openCount} open</span>
            )}
          </h1>
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={e => setShowCompleted(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-700 text-blue-600 dark:text-blue-400 focus:ring-blue-500"
            />
            Show completed
          </label>
        </div>

        {isLoading ? (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-600 mx-auto"></div>
            <p className="mt-4 text-gray-600 dark:text-gray-400">Loading action items...</p>
          </div>
        ) : error ? (
          <div className="bg-white dark:bg-gray-900 rounded-lg p-8 text-center text-red-600 dark:text-red-400">{error}</div>
        ) : visible.length === 0 ? (
          <div className="text-center bg-white dark:bg-gray-900 rounded-lg p-12 text-gray-500 dark:text-gray-400">
            {rows.length === 0
              ? 'No action items yet. They are extracted from Listen sessions as meetings are summarised.'
              : 'Everything is ticked off. Turn on “Show completed” to review what you closed.'}
          </div>
        ) : (
          <div className="space-y-6">
            {visible.map(({ row, actions, completed }) => (
              <section key={row.session_id} className="bg-white dark:bg-gray-900 rounded-lg p-5 shadow-sm border border-gray-200 dark:border-gray-800">
                <div className="flex items-baseline justify-between gap-4 mb-3">
                  <Link
                    href={`/activity/details?sessionId=${row.session_id}`}
                    className="font-medium text-gray-900 dark:text-gray-100 hover:underline truncate"
                  >
                    {sessionTitle(row)}
                  </Link>
                  <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                    {new Date(row.started_at * 1000).toLocaleDateString()}
                  </span>
                </div>

                <ul className="space-y-1.5">
                  {actions
                    .filter(action => showCompleted || !completed.includes(action))
                    .map((action, index) => {
                      const isDone = completed.includes(action)
                      return (
                        <li key={index}>
                          <label className="flex items-start gap-2 cursor-pointer group">
                            <input
                              type="checkbox"
                              checked={isDone}
                              onChange={() => toggle(row.session_id, action)}
                              className="mt-1 h-4 w-4 rounded border-gray-300 dark:border-gray-700 text-blue-600 dark:text-blue-400 focus:ring-blue-500"
                            />
                            <span className={isDone ? 'text-gray-400 dark:text-gray-500 line-through' : 'text-gray-700 dark:text-gray-300 group-hover:text-gray-900 group-hover:dark:text-gray-100'}>
                              {action}
                            </span>
                          </label>
                        </li>
                      )
                    })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
