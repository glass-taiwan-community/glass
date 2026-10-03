'use client'

import { useState, useEffect } from 'react'
import { AlertTriangle, CheckCircle2, FileText, FolderGit2, Power } from 'lucide-react'
import {
  getRepoContext,
  saveRepoContext,
  RepoContextStatus,
  RepoContextSettings,
  RepoContextSaveResult,
} from '@/utils/api'

// The textareas hold one path per line, so the draft keeps them as raw text and converts only at
// the edges. Converting on every keystroke would eat the blank line the user is typing into.
type Draft = { root: string; subpaths: string; includePaths: string }

// The four states of the loaded panel. They are derived in one place so their precedence is visible
// and no two can be shown at once: `withheld` in particular is a failed refresh, not an empty
// setting, and they want different wording.
type PanelKind = 'unset' | 'loaded' | 'withheld' | 'idle'

const toLines = (list: string[]) => list.join('\n')
const fromLines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)

const draftOf = (status: RepoContextStatus): Draft => ({
  root: status.root ?? '',
  subpaths: toLines(status.subpaths),
  includePaths: toLines(status.includePaths),
})

const settingsOf = (draft: Draft): RepoContextSettings => ({
  root: draft.root.trim(),
  subpaths: fromLines(draft.subpaths),
  includePaths: fromLines(draft.includePaths),
})

const panelKind = (status: RepoContextStatus): PanelKind => {
  if (!status.root) return 'unset'
  if (status.loaded) return 'loaded'
  if (status.withheld) return 'withheld'
  return 'idle'
}

const CARD = 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5'
const LABEL = 'text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400'
const FIELD = 'w-full px-3 py-2 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400'
const PRIMARY = 'px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:opacity-90 disabled:opacity-40'

export default function RepoContextPage() {
  const [status, setStatus] = useState<RepoContextStatus | null>(null)
  const [draft, setDraft] = useState<Draft>({ root: '', subpaths: '', includePaths: '' })
  const [baseline, setBaseline] = useState<Draft>({ root: '', subpaths: '', includePaths: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<RepoContextSaveResult | null>(null)
  // Kept apart from `result` on purpose. A refusal is the user's typo and carries a reason worth
  // rendering; a transport failure is ours and must not be dressed up as one.
  const [transportError, setTransportError] = useState<string | null>(null)

  const adopt = (next: RepoContextStatus) => {
    setStatus(next)
    setDraft(draftOf(next))
    setBaseline(draftOf(next))
  }

  useEffect(() => {
    const load = async () => {
      try {
        adopt(await getRepoContext())
      } catch (error) {
        console.error('Failed to fetch repo context:', error)
        setTransportError('Could not read the current repository context from the app.')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)

  const save = async (settings: RepoContextSettings) => {
    setSaving(true)
    setResult(null)
    setTransportError(null)
    try {
      const saved = await saveRepoContext(settings)
      setResult(saved)
      if (saved.ok) adopt(saved.status)
    } catch (error) {
      console.error('Failed to save repo context:', error)
      setTransportError('The save request failed before the app could answer. See the browser console.')
    } finally {
      setSaving(false)
    }
  }

  const handleTurnOff = () => {
    if (!window.confirm('Stop attaching repository context to every Ask? This clears the root and both path lists.')) return
    save({ root: '', subpaths: [], includePaths: [] })
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
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">Ask</p>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Repository context</h1>
          <div className="mt-4 flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
            <FolderGit2 className="h-4 w-4 mt-0.5 shrink-0" />
            <p>
              Glass packs the files git tracks in one repository into a single text block and attaches it
              to every Ask, so answers can quote your actual code. The pack is capped by a token budget,
              and anything that does not fit is listed by name rather than dropped silently.
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6 bg-gray-50 dark:bg-gray-950">
        <div className="space-y-4 max-w-3xl">
          {status && <LoadedPanel status={status} />}

          <div className={CARD}>
            <label htmlFor="repo-root" className={LABEL}>Repository root</label>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 mb-2">
              An absolute path to a git clone or worktree. Type it; there is no folder picker here,
              because this page runs in your browser and a native dialog would open behind it.
            </p>
            <input
              id="repo-root"
              type="text"
              value={draft.root}
              placeholder="/Users/you/code/your-repo"
              onChange={e => setDraft(prev => ({ ...prev, root: e.target.value }))}
              className={FIELD}
            />

            <label htmlFor="repo-subpaths" className={`block mt-5 ${LABEL}`}>Restrict to subpaths</label>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 mb-2">
              One path per line, relative to the root. Only files under these are packed, which is how
              you keep a large repository inside the budget. Leave it empty to pack everything.
            </p>
            <textarea
              id="repo-subpaths"
              value={draft.subpaths}
              rows={4}
              placeholder={'src/features\ndocs/architecture.md'}
              onChange={e => setDraft(prev => ({ ...prev, subpaths: e.target.value }))}
              className={`${FIELD} resize-y font-mono text-sm`}
            />

            <label htmlFor="repo-includes" className={`block mt-5 ${LABEL}`}>Opt-in include paths</label>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 mb-2">
              One path per line, relative to the root. These are added even when git ignores them or a
              subpath above excludes them. Use it for the odd untracked file you want Ask to see.
            </p>
            <textarea
              id="repo-includes"
              value={draft.includePaths}
              rows={3}
              placeholder={'config/local.yaml'}
              onChange={e => setDraft(prev => ({ ...prev, includePaths: e.target.value }))}
              className={`${FIELD} resize-y font-mono text-sm`}
            />

            <div className="flex items-center justify-between gap-3 mt-5">
              <button
                onClick={handleTurnOff}
                disabled={saving}
                className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40"
              >
                <Power className="h-4 w-4" />
                Turn off
              </button>
              <div className="flex items-center gap-3">
                {dirty && <span className="text-xs text-gray-500 dark:text-gray-400">Unsaved changes</span>}
                <button
                  onClick={() => save(settingsOf(draft))}
                  disabled={saving || !dirty}
                  className={PRIMARY}
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </div>

          {transportError && (
            <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 p-4">
              <p className="text-sm text-red-800 dark:text-red-300">{transportError}</p>
            </div>
          )}

          {result && !result.ok && (
            <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-red-600 dark:text-red-400" />
                <div>
                  <p className="text-sm font-medium text-red-900 dark:text-red-200">
                    Nothing was saved. The settings are unchanged.
                  </p>
                  {/* Verbatim and untruncated: this string is the only thing naming which path was
                      wrong, and the server is the only thing that knows. */}
                  <p className="mt-1 text-sm text-red-800 dark:text-red-300 whitespace-pre-wrap break-words font-mono">
                    {result.reason}
                  </p>
                </div>
              </div>
            </div>
          )}

          {result && result.ok && (
            <div className="rounded-lg border border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-950 p-4">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-green-600 dark:text-green-400" />
                <div className="text-sm text-green-900 dark:text-green-200">
                  <p className="font-medium">Saved.</p>
                  <p className="mt-1">
                    {result.refreshed
                      ? `The pack was rebuilt: ${result.status.files} files, about ${result.status.estTokens} tokens of the ${result.status.budgetTokens} token budget.`
                      : 'No pack was installed, so Ask is still answering without repository context. If a root is set, the rebuild did not finish.'}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function LoadedPanel({ status }: { status: RepoContextStatus }) {
  const kind = panelKind(status)

  if (kind === 'unset') {
    return (
      <div className={CARD}>
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">No repository is configured.</p>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Ask runs without repository context and says so when asked about one. Set a root below to change that.
        </p>
      </div>
    )
  }

  if (kind === 'withheld') {
    return (
      <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950 p-5">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              A pack is in memory, but it was built from a different root.
            </p>
            <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
              Glass refuses to answer about the wrong repository, so Ask is getting no context at all.
              The configured root is <span className="font-mono">{status.root}</span>. The last rebuild
              for it did not succeed. Press Save to try again and read the reason if it refuses.
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (kind === 'idle') {
    return (
      <div className={CARD}>
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
          A root is configured, but no pack is loaded.
        </p>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Ask is running without repository context. This is normal before the first build of a session.
          Press Save to build the pack now.
        </p>
        <p className="mt-2 text-sm font-mono text-gray-700 dark:text-gray-300">{status.root}</p>
      </div>
    )
  }

  const used = status.budgetTokens ? Math.min(100, Math.round((status.estTokens / status.budgetTokens) * 100)) : 0
  const over = status.estTokens > status.budgetTokens

  return (
    <div className={CARD}>
      <div className="flex items-start gap-2">
        <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-green-600 dark:text-green-400" />
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Attached to every Ask: <span className="font-mono">{status.name}</span>
          </p>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400 font-mono break-all">{status.root}</p>

          <div className="mt-4 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <FileText className="h-4 w-4 shrink-0" />
            <span>{status.files} files packed, {status.omitted} left out and named in the manifest</span>
          </div>

          <div className="mt-3">
            <div className="flex items-center justify-between text-sm text-gray-700 dark:text-gray-300">
              <span>Estimated tokens</span>
              <span className={over ? 'text-red-700 dark:text-red-400 font-medium' : ''}>
                {status.estTokens} of {status.budgetTokens}
              </span>
            </div>
            <div className="mt-1 h-2 w-full rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden">
              <div
                className={`h-full rounded-full ${over ? 'bg-red-500' : 'bg-gray-900 dark:bg-gray-100'}`}
                style={{ width: `${used}%` }}
              />
            </div>
          </div>

          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            Packed at {status.packedAt ? new Date(status.packedAt).toLocaleString() : 'an unknown time'}
          </p>
        </div>
      </div>
    </div>
  )
}
