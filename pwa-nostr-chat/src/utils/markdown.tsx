import React, { useState } from 'react'

export interface MarkdownCallbacks {
  onTuneGeohash?: (geohash: string) => void
  onClickMention?: (mention: string) => void
  highlightQuery?: string
  knownHandles?: readonly string[]
}

const GEOHASH_BASE32 = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/
const MAX_KNOWN_HANDLES = 80

// Trailing boundary that cleanly terminates a mention chip (end of text, whitespace, or punctuation)
const MENTION_RIGHT_BOUNDARY = String.raw`(?=$|[\s.,!?;:)\]}"'])`
// Leading boundary before `@` so email addresses like user@domain.com are not matched as mentions
const MENTION_LEFT_BOUNDARY = String.raw`(?<=^|[\s([,"'])`

// Explicit Bitchat `#xxxx` mention supporting spaces & Unicode (e.g. `@John Doe#a1b2`, `@María José#9f0c`)
// Disallows whitespace immediately before `#` and sentence delimiters `,;!?` to prevent cross-sentence false matches.
const SUFFIXED_MENTION_PATTERN = String.raw`${MENTION_LEFT_BOUNDARY}@[^\s@#,;!?\n](?:[^\n@#,;!?]{0,30}[^\s@#,;!?\n])?#[0-9a-fA-F]{4}${MENTION_RIGHT_BOUNDARY}`

// Fallback single-word mention (supports Unicode letters/digits plus `_.-`, without consuming trailing `.`)
const SINGLE_WORD_MENTION_PATTERN = String.raw`${MENTION_LEFT_BOUNDARY}@[\p{L}\p{N}_-](?:[\p{L}\p{N}_.-]{0,30}[\p{L}\p{N}_-])?(?:#[0-9a-fA-F]{4})?${MENTION_RIGHT_BOUNDARY}`

const BASE_NON_MENTION_PATTERNS = [
  String.raw`` + '`[^`\\n]+`',
  String.raw`\*\*[^*\n]+\*\*`,
  String.raw`\*[^*\n]+\*`,
  String.raw`https?:\/\/[^\s<>"')]+`,
  String.raw`nostr:(?:npub|nprofile|note|nevent|naddr)1[02-9ac-hj-np-z]+`,
  String.raw`(?<=^|[\s([,])#[0-9bcdefghjkmnpqrstuvwxyz]{1,12}\b`,
]

function escapeRegexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildTokenRegex(knownHandles?: readonly string[]): RegExp {
  const normalized: string[] = []
  if (knownHandles && knownHandles.length > 0) {
    const seen = new Set<string>()
    // Prefer multi-word and `#xxxx`-suffixed handles first so single-word handles
    // cannot crowd out spaced Bitchat handles in busy rooms.
    const candidates = [...knownHandles]
      .map((raw) => raw.trim().replace(/^@+/, '').trim())
      .filter((h) => h.length > 0 && h.length <= 40 && !h.includes('\n'))
      .sort((a, b) => {
        const aMulti = a.includes(' ') || /#[0-9a-fA-F]{4}$/.test(a) ? 1 : 0
        const bMulti = b.includes(' ') || /#[0-9a-fA-F]{4}$/.test(b) ? 1 : 0
        if (bMulti !== aMulti) return bMulti - aMulti
        return b.length - a.length
      })

    for (const h of candidates) {
      const key = h.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      normalized.push(h)
      if (normalized.length >= MAX_KNOWN_HANDLES) break
    }
    // Sort final set strictly longest-first so `@John Doe#a1b2` beats `@John Doe` beats `@John`
    normalized.sort((a, b) => b.length - a.length)
  }

  const patterns = [...BASE_NON_MENTION_PATTERNS]

  // 1. Explicit `#xxxx`-suffixed Bitchat mentions (including multi-word & Unicode names)
  patterns.push(SUFFIXED_MENTION_PATTERN)

  // 2. Known room/member handles (so bare `@John Doe` highlights as one chip)
  if (normalized.length > 0) {
    const knownAlt = normalized.map(escapeRegexLiteral).join('|')
    patterns.push(`${MENTION_LEFT_BOUNDARY}@(?:${knownAlt})${MENTION_RIGHT_BOUNDARY}`)
  }

  // 3. Fallback single-word `@handle`
  patterns.push(SINGLE_WORD_MENTION_PATTERN)

  return new RegExp(`(${patterns.join('|')})`, 'giu')
}

const DEFAULT_TOKEN_REGEX = buildTokenRegex()
const cachedRegexByHandles = new WeakMap<readonly string[], RegExp>()

function getTokenRegex(knownHandles?: readonly string[]): RegExp {
  if (!knownHandles || knownHandles.length === 0) {
    return DEFAULT_TOKEN_REGEX
  }
  const existing = cachedRegexByHandles.get(knownHandles)
  if (existing) return existing
  const compiled = buildTokenRegex(knownHandles)
  cachedRegexByHandles.set(knownHandles, compiled)
  return compiled
}

/**
 * Highlights search query matches inside plain text segments.
 */
function renderHighlightedText(text: string, query?: string): React.ReactNode {
  if (!query || !query.trim()) return text
  const q = query.trim()
  const escaped = escapeRegexLiteral(q)
  const regex = new RegExp(`(${escaped})`, 'gi')
  const parts = text.split(regex)
  if (parts.length === 1) return text
  return parts.map((part, idx) =>
    idx % 2 === 1 ? (
      <mark key={idx} className="ag-search-hit">
        {part}
      </mark>
    ) : (
      part
    )
  )
}

/**
 * Parses inline formatting: `code`, **bold**, *italic*, URLs, nostr: URIs, #geohash, @mention
 * (including multi-word Bitchat nicknames with spaces like `@John Doe#a1b2` and bare `@John Doe`).
 */
function renderInline(text: string, opts: MarkdownCallbacks, keyPrefix = ''): React.ReactNode[] {
  const tokenRegex = getTokenRegex(opts.knownHandles)
  tokenRegex.lastIndex = 0

  const nodes: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let idx = 0

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index)
      nodes.push(
        <React.Fragment key={`${keyPrefix}t${idx++}`}>
          {renderHighlightedText(plain, opts.highlightQuery)}
        </React.Fragment>
      )
    }

    const token = match[0]
    const lower = token.toLowerCase()
    const k = `${keyPrefix}m${idx++}`

    if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) {
      nodes.push(
        <code key={k} className="ag-inline-code">
          {renderHighlightedText(token.slice(1, -1), opts.highlightQuery)}
        </code>
      )
    } else if (token.startsWith('**') && token.endsWith('**') && token.length >= 4) {
      nodes.push(
        <strong key={k} className="ag-md-bold">
          {renderHighlightedText(token.slice(2, -2), opts.highlightQuery)}
        </strong>
      )
    } else if (token.startsWith('*') && token.endsWith('*') && token.length >= 2) {
      nodes.push(
        <em key={k} className="ag-md-italic">
          {renderHighlightedText(token.slice(1, -1), opts.highlightQuery)}
        </em>
      )
    } else if (lower.startsWith('http://') || lower.startsWith('https://')) {
      // Strip trailing punctuation like .,;!?
      const trimmed = token.replace(/[.,;!?]+$/, '')
      const trailing = token.slice(trimmed.length)
      let displayUrl = trimmed.replace(/^https?:\/\//i, '')
      if (displayUrl.length > 48) {
        displayUrl = displayUrl.slice(0, 45) + '…'
      }
      nodes.push(
        <a
          key={k}
          href={trimmed}
          target="_blank"
          rel="noopener noreferrer"
          className="ag-md-link"
        >
          {renderHighlightedText(displayUrl, opts.highlightQuery)}
        </a>
      )
      if (trailing) {
        nodes.push(
          <React.Fragment key={`${k}tr`}>
            {renderHighlightedText(trailing, opts.highlightQuery)}
          </React.Fragment>
        )
      }
    } else if (lower.startsWith('nostr:')) {
      const short = token.length > 26 ? `${token.slice(0, 16)}…${token.slice(-6)}` : token
      nodes.push(
        <span
          key={k}
          className="ag-nostr-chip"
          title={token}
          onClick={() => {
            navigator.clipboard?.writeText(token).catch(() => {})
          }}
        >
          {short}
        </span>
      )
    } else if (token.startsWith('#')) {
      const gh = token.slice(1).toLowerCase()
      if (GEOHASH_BASE32.test(gh) && opts.onTuneGeohash) {
        nodes.push(
          <button
            key={k}
            type="button"
            className="ag-geo-chip"
            title={`Tune to #${gh}`}
            onClick={(e) => {
              e.stopPropagation()
              opts.onTuneGeohash?.(gh)
            }}
          >
            #{gh}
          </button>
        )
      } else {
        nodes.push(
          <React.Fragment key={k}>
            {renderHighlightedText(token, opts.highlightQuery)}
          </React.Fragment>
        )
      }
    } else if (token.startsWith('@')) {
      nodes.push(
        <button
          key={k}
          type="button"
          className="ag-mention-chip"
          onClick={(e) => {
            e.stopPropagation()
            opts.onClickMention?.(token.slice(1))
          }}
        >
          {renderHighlightedText(token, opts.highlightQuery)}
        </button>
      )
    } else {
      nodes.push(
        <React.Fragment key={k}>
          {renderHighlightedText(token, opts.highlightQuery)}
        </React.Fragment>
      )
    }

    lastIndex = tokenRegex.lastIndex
  }

  if (lastIndex < text.length) {
    nodes.push(
      <React.Fragment key={`${keyPrefix}end`}>
        {renderHighlightedText(text.slice(lastIndex), opts.highlightQuery)}
      </React.Fragment>
    )
  }

  return nodes
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard?.writeText(code).catch(() => {})
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="ag-codeblock">
      <div className="ag-codeblock-head">
        <span className="ag-codeblock-lang">{lang || 'code'}</span>
        <button type="button" className="ag-codeblock-copy" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="ag-codeblock-pre">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export interface RichMessageContentProps extends MarkdownCallbacks {
  content: string
}

/**
 * Safe, zero-HTML-injection markdown & entity renderer for Bitchat/Nostr messages.
 */
export const RichMessageContent: React.FC<RichMessageContentProps> = React.memo(
  ({ content, onTuneGeohash, onClickMention, highlightQuery, knownHandles }) => {
    const callbacks: MarkdownCallbacks = {
      onTuneGeohash,
      onClickMention,
      highlightQuery,
      knownHandles,
    }

    // Split on fenced code blocks ```lang\n...\n```
    const fenceRegex = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g
    const blocks: React.ReactNode[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null
    let bIdx = 0

    while ((match = fenceRegex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        const segment = content.slice(lastIndex, match.index)
        blocks.push(
          <span key={`seg-${bIdx++}`} className="ag-md-segment">
            {renderInline(segment, callbacks, `s${bIdx}-`)}
          </span>
        )
      }
      blocks.push(
        <CodeBlock
          key={`cb-${bIdx++}`}
          lang={match[1] || ''}
          code={(match[2] || '').replace(/\n$/, '')}
        />
      )
      lastIndex = fenceRegex.lastIndex
    }

    if (lastIndex < content.length) {
      const tail = content.slice(lastIndex)
      blocks.push(
        <span key={`seg-${bIdx++}`} className="ag-md-segment">
          {renderInline(tail, callbacks, `s${bIdx}-`)}
        </span>
      )
    }

    return <div className="ag-msg-rich">{blocks}</div>
  }
)

RichMessageContent.displayName = 'RichMessageContent'
