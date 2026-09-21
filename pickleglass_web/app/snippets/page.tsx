'use client'

import { useState, useEffect } from 'react'
import { Plus, Trash2, Mic } from 'lucide-react'
import { getSnippets, createSnippet, updateSnippet, deleteSnippet, Snippet } from '@/utils/api'

// Local edit state per row, so a row is only saved when its own fields actually changed.
type Draft = { trigger_phrase: string; expansion: string; dirty: boolean; saving: boolean }

export default function SnippetsPage() {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const seedDrafts = (rows: Snippet[]) => {
    const next: Record<string, Draft> = {}
    for (const s of rows) {
      next[s.id] = { trigger_phrase: s.trigger_phrase, expansion: s.expansion, dirty: false, saving: false }
    }
    setDrafts(next)
  }

  useEffect(() => {
    const load = async () => {
      try {
        const rows = await getSnippets()
        setSnippets(rows)
        seedDrafts(rows)
      } catch (error) {
        console.error('Failed to fetch snippets:', error)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const edit = (id: string, field: 'trigger_phrase' | 'expansion', value: string) => {
    setDrafts(prev => ({ ...prev, [id]: { ...prev[id], [field]: value, dirty: true } }))
  }

  const handleSave = async (id: string) => {
    const draft = drafts[id]
    if (!draft || !draft.dirty || draft.saving) return
    if (!draft.trigger_phrase.trim() || !draft.expansion.trim()) {
      alert('A snippet needs both a trigger phrase and an expansion.')
      return
    }

    setDrafts(prev => ({ ...prev, [id]: { ...prev[id], saving: true } }))
    try {
      await updateSnippet(id, { trigger_phrase: draft.trigger_phrase.trim(), expansion: draft.expansion.trim() })
      setSnippets(prev => prev.map(s => (s.id === id
        ? { ...s, trigger_phrase: draft.trigger_phrase.trim(), expansion: draft.expansion.trim() }
        : s)))
      setDrafts(prev => ({ ...prev, [id]: { ...prev[id], dirty: false, saving: false } }))
    } catch (error) {
      console.error('Failed to save snippet:', error)
      alert('Failed to save snippet. See console for details.')
      setDrafts(prev => ({ ...prev, [id]: { ...prev[id], saving: false } }))
    }
  }

  const handleCreate = async () => {
    if (creating) return
    setCreating(true)
    try {
      const trigger_phrase = 'new trigger'
      const expansion = 'Type the full prompt that this trigger phrase should stand in for.'
      const { id } = await createSnippet({ trigger_phrase, expansion })
      const row: Snippet = { id, uid: 'current_user', trigger_phrase, expansion, created_at: Date.now() }
      setSnippets(prev => [...prev, row])
      setDrafts(prev => ({ ...prev, [id]: { trigger_phrase, expansion, dirty: false, saving: false } }))
    } catch (error) {
      console.error('Failed to create snippet:', error)
      alert('Failed to create snippet. See console for details.')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: string, trigger: string) => {
    if (!window.confirm(`Delete the snippet "${trigger}"?`)) return
    try {
      await deleteSnippet(id)
      setSnippets(prev => prev.filter(s => s.id !== id))
      setDrafts(prev => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } catch (error) {
      console.error('Failed to delete snippet:', error)
      alert('Failed to delete snippet. See console for details.')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500 dark:text-gray-400">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800">
        <div className="px-8 pt-8 pb-6">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">Voice</p>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Snippets</h1>
            </div>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:opacity-90 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              New snippet
            </button>
          </div>

          <div className="mt-4 flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
            <Mic className="h-4 w-4 mt-0.5 shrink-0" />
            <p>
              Hold <span className="font-medium text-gray-900 dark:text-gray-100">Right&nbsp;⌘</span>, say a
              trigger phrase, and Ask receives the expansion instead of what you said. Matching ignores case
              and punctuation, and the phrase only needs to appear somewhere in what you said — so speech from
              other people in the room will not stop it matching. If nothing matches, what you said is sent as
              an ordinary question.
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6 bg-gray-50 dark:bg-gray-950">
        {snippets.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-gray-500 dark:text-gray-400">No snippets yet.</p>
            <p className="text-sm text-gray-400 dark:text-gray-600 mt-1">
              Create one to turn a spoken phrase into a longer prompt.
            </p>
          </div>
        ) : (
          <div className="space-y-4 max-w-3xl">
            {snippets.map(snippet => {
              const draft = drafts[snippet.id]
              if (!draft) return null
              return (
                <div
                  key={snippet.id}
                  className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5"
                >
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <label className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Trigger phrase
                    </label>
                    <button
                      onClick={() => handleDelete(snippet.id, snippet.trigger_phrase)}
                      className="text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                      aria-label={`Delete snippet ${snippet.trigger_phrase}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>

                  <input
                    type="text"
                    value={draft.trigger_phrase}
                    onChange={e => edit(snippet.id, 'trigger_phrase', e.target.value)}
                    className="w-full px-3 py-2 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400"
                  />

                  <label className="block mt-4 mb-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Expansion — sent to Ask in place of what you said
                  </label>
                  <textarea
                    value={draft.expansion}
                    onChange={e => edit(snippet.id, 'expansion', e.target.value)}
                    rows={5}
                    className="w-full px-3 py-2 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 resize-y"
                  />

                  <div className="flex items-center justify-end gap-3 mt-3">
                    {draft.dirty && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">Unsaved changes</span>
                    )}
                    <button
                      onClick={() => handleSave(snippet.id)}
                      disabled={!draft.dirty || draft.saving}
                      className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:opacity-90 disabled:opacity-40"
                    >
                      {draft.saving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
