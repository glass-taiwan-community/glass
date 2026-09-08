'use client'

import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

/**
 * Renders model output as markdown.
 *
 * Ask answers are generated as markdown and were shown with `whitespace-pre-wrap`, so readers saw
 * literal `**Subject:**` and `- bullet`. The merged timeline puts answers at the centre of the
 * page, which made that hard to ignore.
 *
 * Uses `marked` + `DOMPurify` rather than a React markdown renderer so the web GUI produces the
 * same output as the desktop Ask view, which already loads these two libraries (see
 * `src/ui/ask/AskView.js`). Both ship with zero transitive dependencies.
 */
interface MarkdownProps {
  content: string
  className?: string
}

export default function Markdown({ content, className = '' }: MarkdownProps) {
  const html = useMemo(() => {
    if (!content) return ''

    // Static export prerenders this file on the server, where DOMPurify has no DOM to work with.
    // Rendering unsanitised HTML there is not an option, so the server pass emits nothing and the
    // browser fills it in - these pages fetch their data client-side anyway, so nothing is lost.
    if (typeof window === 'undefined') return ''

    // `breaks` because this text came from chat, where a newline is meant as a line break;
    // `gfm` for the tables and fenced code the model reliably produces.
    const raw = marked.parse(content, { breaks: true, gfm: true }) as string
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
  }, [content])

  // Falls back to the previous plain-text rendering rather than an empty block, so the server
  // pass and any sanitiser failure still show the answer.
  if (!html) {
    return <p className={`whitespace-pre-wrap ${className}`}>{content}</p>
  }

  return (
    <div
      className={`markdown-body ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
