'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Search, X, MessageSquare, AlertCircle } from 'lucide-react'
import { searchConversations, SessionSearchResult } from '@/utils/api'
import { sessionTitle } from '@/utils/sessionContent'

interface SearchPopupProps {
  isOpen: boolean
  onClose: () => void
}

/** Keystrokes settle for this long before a query is sent. */
const DEBOUNCE_MS = 180

const SOURCE_LABEL: Record<string, string> = {
  ask: 'in a question',
  transcript: 'in the transcript',
  summary: 'in the summary',
  title: 'in the title',
}

export default function SearchPopup({ isOpen, onClose }: SearchPopupProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SessionSearchResult[]>([])
  const [scope, setScope] = useState<'content' | 'title'>('content')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Guards against a slow early request overwriting the results of a later, faster one.
  const latestRequest = useRef(0)
  const router = useRouter()

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

  useEffect(() => {
    const query = searchQuery.trim()
    if (!query) {
      setSearchResults([])
      setError(null)
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    const requestId = ++latestRequest.current
    const timer = setTimeout(async () => {
      try {
        const response = await searchConversations(query)
        if (latestRequest.current !== requestId) return
        setSearchResults(response.results)
        setScope(response.scope)
        setError(null)
      } catch (err) {
        if (latestRequest.current !== requestId) return
        // Never fold a failure into the empty state: "no results" tells the user their data is
        // not there, which is a different and much more damaging claim than "search broke".
        console.error('Search failed:', err)
        setSearchResults([])
        setError('Search failed. The desktop app may not be running.')
      } finally {
        if (latestRequest.current === requestId) setIsLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [searchQuery])

  const handleBackgroundClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  const openSession = (sessionId: string) => {
    router.push(`/activity/details?sessionId=${sessionId}`)
    onClose()
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-25 flex items-start justify-center pt-16 z-50"
      onClick={handleBackgroundClick}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="flex items-center px-4 py-3">
          <Search className="h-5 w-5 text-gray-400 mr-3 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search summaries, questions and transcripts…"
            className="flex-1 text-gray-900 text-base border-0 focus:outline-none placeholder-gray-400 bg-transparent"
          />
          <button
            onClick={onClose}
            className="ml-3 p-1 hover:bg-gray-100 rounded-full flex-shrink-0"
          >
            <X className="h-4 w-4 text-gray-400" />
          </button>
        </div>

        {/* Says what is actually being searched. Titles are auto-generated ("Session @ 14:03"),
            so a title-only search finding nothing means something quite different from a content
            search finding nothing - the user needs to be able to tell those apart. */}
        {scope === 'title' && searchQuery.trim() && (
          <div className="px-4 py-2 bg-amber-50 border-t border-amber-100 text-xs text-amber-800">
            Searching titles only in cloud mode — transcripts and answers are encrypted.
          </div>
        )}

        {searchQuery.trim() && (
          <div className="max-h-[400px] overflow-y-auto border-t border-gray-100">
            {isLoading ? (
              <div className="p-6 text-center">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto mb-3"></div>
                <p className="text-gray-500 text-sm">Searching…</p>
              </div>
            ) : error ? (
              <div className="p-6 text-center">
                <AlertCircle className="h-8 w-8 text-red-300 mx-auto mb-3" />
                <p className="text-red-600 text-sm">{error}</p>
              </div>
            ) : searchResults.length > 0 ? (
              <div className="divide-y divide-gray-100">
                {searchResults.map(result => (
                  <div
                    key={result.id}
                    className="p-3 hover:bg-gray-50 cursor-pointer transition-colors"
                    onClick={() => openSession(result.id)}
                  >
                    <div className="flex items-start gap-3">
                      <MessageSquare className="h-5 w-5 text-gray-400 mt-0.5 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-medium text-gray-900 truncate">
                          {sessionTitle(result)}
                        </h3>
                        {result.snippet && (
                          <p className="mt-1 text-sm text-gray-600 line-clamp-2">{result.snippet}</p>
                        )}
                        <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-500">
                          <span>{new Date(result.started_at * 1000).toLocaleString()}</span>
                          {result.snippet_source && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{SOURCE_LABEL[result.snippet_source]}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-6 text-center">
                <Search className="h-8 w-8 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500 text-sm">No results found for &ldquo;{searchQuery}&rdquo;</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
