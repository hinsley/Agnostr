import React, { useEffect, useState } from 'react'
import { getCachedHighlightedCode, highlightCodeToHtml } from '../lib/codeHighlight'
import { getCachedMathSvg, hasMathSyntax, renderMathToSvg } from '../lib/mathjax'
import {
  formatBitchatChannelHash,
  formatBitchatChannelLabel,
  getTopicSlug,
  makeCelestialChannelKey,
  makeTopicChannelKey,
  normalizeTopicSlug,
  parseBitchatChannelHash,
  parseCelestialChannelKey,
} from '../lib/bitchatChannel'

export interface MarkdownCallbacks {
  onTuneGeohash?: (geohash: string) => void
  onClickMention?: (mention: string) => void
  highlightQuery?: string
  knownHandles?: readonly string[]
}

const MAX_KNOWN_HANDLES = 80
const MAX_INLINE_DEPTH = 4

// Trailing boundary that cleanly terminates a mention chip (end of text, whitespace, or punctuation)
const MENTION_RIGHT_BOUNDARY = String.raw`(?=$|[\s.,!?;:)\]}"'])`
// Leading boundary before `@` so email addresses like user@domain.com are not matched as mentions
const MENTION_LEFT_BOUNDARY = String.raw`(?<=^|[\s([,"'])`

// Explicit Bitchat `#xxxx` mention supporting spaces & Unicode (e.g. `@John Doe#a1b2`, `@María José#9f0c`)
// Disallows whitespace immediately before `#` and sentence delimiters `,;!?` to prevent cross-sentence false matches.
const SUFFIXED_MENTION_PATTERN = String.raw`${MENTION_LEFT_BOUNDARY}@[^\s@#,;!?\n](?:[^\n@#,;!?]{0,30}[^\s@#,;!?\n])?#[0-9a-fA-F]{4}${MENTION_RIGHT_BOUNDARY}`

// Fallback single-word mention (supports Unicode letters/digits plus `_.-`, without consuming trailing `.`)
const SINGLE_WORD_MENTION_PATTERN = String.raw`${MENTION_LEFT_BOUNDARY}@[\p{L}\p{N}_-](?:[\p{L}\p{N}_.-]{0,30}[\p{L}\p{N}_-])?(?:#[0-9a-fA-F]{4})?${MENTION_RIGHT_BOUNDARY}`

// Currency-safe inline `$ ... $`: opening `$` not followed by space/$, closing `$` not preceded by space/\ and not followed by digit/$
const INLINE_DOLLAR_MATH_PATTERN = String.raw`(?<!\\|\$)\$(?:[^\s$\\]|\\.)(?:(?:[^$\n\\]|\\.)*?(?:[^\s$\\]|\\.))?\$(?![0-9$])`
const INLINE_PAREN_MATH_PATTERN = String.raw`\\\([^\n]+?\\\)`

// Suppress markdown image syntax `![alt](url)` BEFORE named links so zero inline <img> tags can ever render
const IMAGE_SYNTAX_PATTERN = String.raw`!\[[^\]\n]*\]\((?:<[^>\n]+>|(?:[^()\s\n]+|\([^()\s\n]*\))+)\)`
// Named markdown links `[label](url)` allowing balanced parens one level deep
const NAMED_LINK_PATTERN = String.raw`\[[^\]\n]+\]\((?:<[^>\n]+>|(?:[^()\s\n]+|\([^()\s\n]*\))+)\)`

const BASE_NON_MENTION_PATTERNS = [
  // 1. Inline code spans protect all math/markdown inside
  String.raw`` + '`[^`\\n]+`',
  // 2. Inline math
  INLINE_PAREN_MATH_PATTERN,
  INLINE_DOLLAR_MATH_PATTERN,
  // 3. Inline image suppression (never renders <img>) & named links
  IMAGE_SYNTAX_PATTERN,
  NAMED_LINK_PATTERN,
  // 4. Spoiler pills & rich markdown formatting
  String.raw`\|\|[^|\n]+?\|\|`,
  String.raw`\*\*\*[^*\n]+?\*\*\*`,
  String.raw`\*\*[^*\n]+?\*\*`,
  String.raw`(?<![\p{L}\p{N}_])__[^_\n]+?__(?![\p{L}\p{N}_])`,
  String.raw`~~[^~\n]+?~~`,
  String.raw`==[^=\n]+?==`,
  String.raw`\*[^*\s\n](?:[^*\n]*?[^*\s\n])?\*`,
  String.raw`(?<![\p{L}\p{N}_])_[^_\s\n](?:[^_\n]*?[^_\s\n])?_(?![\p{L}\p{N}_])`,
  // 5. Bare URLs, nostr: URIs, #geohash / #topic channel pills
  String.raw`https?:\/\/[^\s<>"')]+`,
  String.raw`nostr:(?:npub|nprofile|note|nevent|naddr)1[02-9ac-hj-np-z]+`,
  // Consume the full qualified token, even if invalid. Never turn e.g. #mars:invalid
  // into a clickable #mars topic or Earth geohash.
  String.raw`(?<=^|[\s([,"'])#(?:[a-z][a-z0-9_-]*:[a-z0-9_:-]+|[a-z][a-z0-9_-]{1,47}|[0-9bcdefghjkmnpqrstuvwxyz]{1,12})(?![\p{L}\p{N}_-])`,
]

function escapeRegexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildTokenRegex(knownHandles?: readonly string[]): RegExp {
  const normalized: string[] = []
  if (knownHandles && knownHandles.length > 0) {
    const seen = new Set<string>()
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

type SanitizedLink =
  | { kind: 'external'; href: string; title: string }
  | { kind: 'internal'; hash: string; title: string; channelKey?: string }

function sanitizeMarkdownUrl(rawUrl: string): SanitizedLink | null {
  let cleaned = rawUrl.trim()
  if (cleaned.startsWith('<') && cleaned.endsWith('>')) {
    cleaned = cleaned.slice(1, -1).trim()
  }
  if (!cleaned) return null
  // Reject control chars / whitespace injection
  for (let i = 0; i < cleaned.length; i += 1) {
    const code = cleaned.charCodeAt(i)
    if (code <= 31 || code === 127) return null
  }

  const lower = cleaned.toLowerCase()

  const internalLink = (hash: string, title: string): SanitizedLink | null => {
    const channelKey = parseBitchatChannelHash(hash)
    if (channelKey) return { kind: 'internal', hash: formatBitchatChannelHash(channelKey), title, channelKey }
    if (/^#(?:dm|invite)=/i.test(hash)) return { kind: 'internal', hash, title }
    return null
  }

  if (cleaned.startsWith('#')) return internalLink(cleaned, cleaned)

  // External links: strictly https:, http:, or mailto:
  if (lower.startsWith('mailto:')) {
    if (cleaned.length <= 7) return null
    return { kind: 'external', href: cleaned, title: cleaned }
  }

  if (lower.startsWith('https://') || lower.startsWith('http://')) {
    try {
      const parsed = new URL(cleaned)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return null
      }
      // If a full URL targets this exact Agnostr app instance with `#dm=` or `#invite=`, open in-app
      if (
        typeof window !== 'undefined' &&
        window.location &&
        parsed.origin === window.location.origin &&
        parsed.pathname === window.location.pathname
      ) {
        const internal = internalLink(parsed.hash, parsed.href)
        if (internal) return internal
      }
      return { kind: 'external', href: parsed.href, title: parsed.href }
    } catch {
      return null
    }
  }

  return null
}

function navigateInternalHash(hash: string): void {
  if (typeof window === 'undefined') return
  const normalized = hash.startsWith('#') ? hash : `#${hash}`
  if (window.location.hash === normalized) {
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    return
  }
  window.location.hash = normalized
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
 * Lazy-loaded MathJax SVG expression node (sync LRU cache hit, async on first render).
 */
const MathNode: React.FC<{ tex: string; display: boolean }> = React.memo(({ tex, display }) => {
  const [svgHtml, setSvgHtml] = useState<string | null>(() => getCachedMathSvg(tex, display))

  useEffect(() => {
    const cached = getCachedMathSvg(tex, display)
    if (cached) {
      setSvgHtml(cached)
      return
    }
    let cancelled = false
    setSvgHtml(null)
    void renderMathToSvg(tex, display)
      .then((svg) => {
        if (!cancelled && svg) {
          setSvgHtml(svg)
        }
      })
      .catch(() => {
        // Keep clean TeX fallback on parse/load failure
      })
    return () => {
      cancelled = true
    }
  }, [tex, display])

  if (display) {
    return (
      <div className="ag-math-block" data-no-swipe="true">
        {svgHtml ? (
          <span
            className="ag-math-svg"
            aria-label={tex}
            dangerouslySetInnerHTML={{ __html: svgHtml }}
          />
        ) : (
          <code className="ag-math-fallback">{tex}</code>
        )}
      </div>
    )
  }

  return svgHtml ? (
    <span
      className="ag-math-inline"
      aria-label={tex}
      dangerouslySetInnerHTML={{ __html: svgHtml }}
    />
  ) : (
    <code className="ag-math-fallback inline">{tex}</code>
  )
})

MathNode.displayName = 'MathNode'

/**
 * Interactive clickable spoiler pill (`||secret||`).
 */
const SpoilerNode: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [revealed, setRevealed] = useState(false)
  return (
    <button
      type="button"
      className={`ag-md-spoiler ${revealed ? 'revealed' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        setRevealed((v) => !v)
      }}
      aria-pressed={revealed}
      title={revealed ? 'Click to hide spoiler' : 'Click to reveal spoiler'}
    >
      <span className="ag-md-spoiler-inner">{children}</span>
    </button>
  )
}

/**
 * Parses inline markdown, currency-safe inline MathJax, sanitized named links,
 * spoiler pills, highlights, URLs, nostr: URIs, #geohash, and multi-word @mentions.
 */
function renderInline(
  text: string,
  opts: MarkdownCallbacks,
  keyPrefix = '',
  depth = 0,
  insideLink = false
): React.ReactNode[] {
  if (!text) return []
  if (depth > MAX_INLINE_DEPTH) {
    return [
      <React.Fragment key={`${keyPrefix}max`}>
        {renderHighlightedText(text, opts.highlightQuery)}
      </React.Fragment>,
    ]
  }

  const tokenRegex = getTokenRegex(opts.knownHandles)
  const localRegex = new RegExp(tokenRegex.source, tokenRegex.flags)

  const nodes: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let idx = 0

  while ((match = localRegex.exec(text)) !== null) {
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
    } else if (token.startsWith('\\(') && token.endsWith('\\)') && token.length > 4) {
      const tex = token.slice(2, -2).trim()
      if (tex) {
        nodes.push(<MathNode key={k} tex={tex} display={false} />)
      } else {
        nodes.push(<React.Fragment key={k}>{token}</React.Fragment>)
      }
    } else if (token.startsWith('$') && token.endsWith('$') && token.length >= 3) {
      const tex = token.slice(1, -1).trim()
      if (tex) {
        nodes.push(<MathNode key={k} tex={tex} display={false} />)
      } else {
        nodes.push(<React.Fragment key={k}>{token}</React.Fragment>)
      }
    } else if (token.startsWith('![')) {
      // Explicitly never render inline <img> tags (blocks untrusted tracking pixels)
      nodes.push(
        <React.Fragment key={k}>
          {renderHighlightedText(token, opts.highlightQuery)}
        </React.Fragment>
      )
    } else if (token.startsWith('[') && token.endsWith(')') && !insideLink) {
      const linkMatch = /^\[([^\]\n]+)\]\((.+)\)$/.exec(token)
      const label = linkMatch?.[1] ?? ''
      const rawUrl = linkMatch?.[2] ?? ''
      const sanitized = sanitizeMarkdownUrl(rawUrl)
      if (sanitized && label) {
        const renderedLabel = renderInline(label, opts, `${k}l-`, depth + 1, true)
        if (sanitized.kind === 'internal') {
          nodes.push(
            <a
              key={k}
              href={sanitized.hash}
              title={sanitized.title}
              className="ag-md-link ag-md-link-internal"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (sanitized.channelKey && opts.onTuneGeohash) opts.onTuneGeohash(sanitized.channelKey)
                else navigateInternalHash(sanitized.hash)
              }}
            >
              {renderedLabel}
            </a>
          )
        } else {
          nodes.push(
            <a
              key={k}
              href={sanitized.href}
              target="_blank"
              rel="noopener noreferrer"
              title={sanitized.title}
              className="ag-md-link"
              onClick={(e) => e.stopPropagation()}
            >
              {renderedLabel}
            </a>
          )
        }
      } else {
        // Rejected scheme (e.g. javascript:, data:, vbscript:) -> safe plain text
        nodes.push(
          <React.Fragment key={k}>
            {renderHighlightedText(token, opts.highlightQuery)}
          </React.Fragment>
        )
      }
    } else if (token.startsWith('||') && token.endsWith('||') && token.length > 4) {
      nodes.push(
        <SpoilerNode key={k}>
          {renderInline(token.slice(2, -2), opts, `${k}sp-`, depth + 1, insideLink)}
        </SpoilerNode>
      )
    } else if (token.startsWith('***') && token.endsWith('***') && token.length > 6) {
      nodes.push(
        <strong key={k} className="ag-md-bold">
          <em className="ag-md-italic">
            {renderInline(token.slice(3, -3), opts, `${k}bi-`, depth + 1, insideLink)}
          </em>
        </strong>
      )
    } else if (
      ((token.startsWith('**') && token.endsWith('**')) ||
        (token.startsWith('__') && token.endsWith('__'))) &&
      token.length > 4
    ) {
      nodes.push(
        <strong key={k} className="ag-md-bold">
          {renderInline(token.slice(2, -2), opts, `${k}b-`, depth + 1, insideLink)}
        </strong>
      )
    } else if (token.startsWith('~~') && token.endsWith('~~') && token.length > 4) {
      nodes.push(
        <del key={k} className="ag-md-del">
          {renderInline(token.slice(2, -2), opts, `${k}d-`, depth + 1, insideLink)}
        </del>
      )
    } else if (token.startsWith('==') && token.endsWith('==') && token.length > 4) {
      nodes.push(
        <mark key={k} className="ag-md-highlight">
          {renderInline(token.slice(2, -2), opts, `${k}hl-`, depth + 1, insideLink)}
        </mark>
      )
    } else if (
      ((token.startsWith('*') && token.endsWith('*')) ||
        (token.startsWith('_') && token.endsWith('_'))) &&
      token.length > 2
    ) {
      nodes.push(
        <em key={k} className="ag-md-italic">
          {renderInline(token.slice(1, -1), opts, `${k}i-`, depth + 1, insideLink)}
        </em>
      )
    } else if ((lower.startsWith('http://') || lower.startsWith('https://')) && !insideLink) {
      const trimmed = token.replace(/[.,;!?]+$/, '')
      const trailing = token.slice(trimmed.length)
      const sanitized = sanitizeMarkdownUrl(trimmed)
      let displayUrl = trimmed.replace(/^https?:\/\//i, '')
      if (displayUrl.length > 48) {
        displayUrl = displayUrl.slice(0, 45) + '…'
      }
      if (sanitized?.kind === 'internal') {
        nodes.push(
          <a
            key={k}
            href={sanitized.hash}
            title={sanitized.title}
            className="ag-md-link ag-md-link-internal"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (sanitized.channelKey && opts.onTuneGeohash) opts.onTuneGeohash(sanitized.channelKey)
              else navigateInternalHash(sanitized.hash)
            }}
          >
            {renderHighlightedText(displayUrl, opts.highlightQuery)}
          </a>
        )
      } else {
        nodes.push(
          <a
            key={k}
            href={sanitized?.href ?? trimmed}
            target="_blank"
            rel="noopener noreferrer"
            title={sanitized?.title ?? trimmed}
            className="ag-md-link"
            onClick={(e) => e.stopPropagation()}
          >
            {renderHighlightedText(displayUrl, opts.highlightQuery)}
          </a>
        )
      }
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
          onClick={(e) => {
            e.stopPropagation()
            navigator.clipboard?.writeText(token).catch(() => {})
          }}
        >
          {short}
        </span>
      )
    } else if (token.startsWith('#')) {
      const rawTag = token.slice(1).toLowerCase()
      const celestial = parseCelestialChannelKey(rawTag)
      const geoKey = celestial ? makeCelestialChannelKey(celestial.bodyId, celestial.geohash) : null
      // Only an explicit topic may contain a colon; malformed qualified geohashes are plain text.
      const slug = geoKey ? null : rawTag.includes(':') ? getTopicSlug(rawTag) : normalizeTopicSlug(rawTag)
      const channelKey = geoKey ?? (slug ? makeTopicChannelKey(slug) : null)
      if (channelKey && opts.onTuneGeohash && !insideLink) {
        const label = formatBitchatChannelLabel(channelKey)
        nodes.push(
          <button
            key={k}
            type="button"
            className="ag-geo-chip"
            title={geoKey ? `Tune to ${label}` : `Join ${label}`}
            onClick={(e) => {
              e.stopPropagation()
              opts.onTuneGeohash?.(channelKey)
            }}
          >
            {label}
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

    lastIndex = localRegex.lastIndex
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

const CodeBlock: React.FC<{ lang: string; code: string }> = React.memo(({ lang, code }) => {
  const [copied, setCopied] = useState(false)
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(() =>
    getCachedHighlightedCode(lang, code)
  )

  useEffect(() => {
    const cached = getCachedHighlightedCode(lang, code)
    if (cached !== null) {
      setHighlightedHtml(cached)
      return
    }
    let cancelled = false
    setHighlightedHtml(null)
    void highlightCodeToHtml(lang, code)
      .then((html) => {
        if (!cancelled && html) {
          setHighlightedHtml(html)
        }
      })
      .catch(() => {
        // Keep clean plain-text code fallback on load/highlight failure
      })
    return () => {
      cancelled = true
    }
  }, [lang, code])

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard?.writeText(code).catch(() => {})
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="ag-codeblock" data-no-swipe="true">
      <div className="ag-codeblock-head">
        <span className="ag-codeblock-lang">{lang || 'code'}</span>
        <button type="button" className="ag-codeblock-copy" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="ag-codeblock-pre" data-no-swipe="true">
        {highlightedHtml ? (
          <code
            className="ag-codeblock-code hljs"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <code className="ag-codeblock-code">{code}</code>
        )}
      </pre>
    </div>
  )
})

CodeBlock.displayName = 'CodeBlock'

const TABLE_SEP_REGEX = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/
const HR_LINE_REGEX = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const HEADING_LINE_REGEX = /^(#{1,4})\s+(.+)$/
const TASK_LIST_REGEX = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/
const UL_LINE_REGEX = /^\s*[-*]\s+(.*)$/
const OL_LINE_REGEX = /^\s*(\d+)\.\s+(.*)$/
const FENCE_OPEN_REGEX = /^```([a-zA-Z0-9_+#.-]*)\s*(.*)$/

type TableAlign = 'left' | 'center' | 'right'

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function parseTableAlignments(sepLine: string): TableAlign[] {
  return splitTableRow(sepLine).map((seg) => {
    const clean = seg.trim()
    const left = clean.startsWith(':')
    const right = clean.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

function isTableStart(lines: string[], idx: number): boolean {
  if (idx + 1 >= lines.length) return false
  const header = lines[idx]
  const sep = lines[idx + 1]
  if (!header.includes('|') || !sep.includes('-')) return false
  if (!TABLE_SEP_REGEX.test(sep)) return false
  const headerCells = splitTableRow(header)
  const sepCells = splitTableRow(sep)
  return headerCells.length >= 1 && sepCells.length >= 1
}

function isBlockOpener(lines: string[], idx: number): boolean {
  const line = lines[idx]
  const trimmed = line.trim()
  if (!trimmed) return true
  if (trimmed.startsWith('```')) return true
  if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) return true
  if (HR_LINE_REGEX.test(line)) return true
  if (HEADING_LINE_REGEX.test(line)) return true
  if (trimmed.startsWith('>>>') || /^>\s?/.test(line)) return true
  if (isTableStart(lines, idx)) return true
  if (TASK_LIST_REGEX.test(line) || UL_LINE_REGEX.test(line) || OL_LINE_REGEX.test(line)) return true
  return false
}

/**
 * Splits a paragraph string around embedded `$$...$$` or `\[...\]` display math expressions
 * (skipping inline code spans).
 */
function renderParagraphContent(
  text: string,
  opts: MarkdownCallbacks,
  keyPrefix: string
): React.ReactNode {
  if (!hasMathSyntax(text)) {
    return <span className="ag-md-segment">{renderInline(text, opts, keyPrefix)}</span>
  }

  const displayRegex = /(`[^`\n]+`|\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\])/g
  const parts: React.ReactNode[] = []
  let lastIdx = 0
  let m: RegExpExecArray | null
  let seg = 0

  while ((m = displayRegex.exec(text)) !== null) {
    const tok = m[0]
    if (tok.startsWith('`')) {
      // Leave inline code untouched in surrounding text pass
      continue
    }
    if (m.index > lastIdx) {
      const before = text.slice(lastIdx, m.index).replace(/\n+$/, '')
      if (before.trim()) {
        parts.push(
          <span key={`${keyPrefix}pt${seg++}`} className="ag-md-segment">
            {renderInline(before, opts, `${keyPrefix}p${seg}-`)}
          </span>
        )
      }
    }
    const tex = tok.slice(2, -2).trim()
    if (tex) {
      parts.push(<MathNode key={`${keyPrefix}dm${seg++}`} tex={tex} display />)
    }
    lastIdx = displayRegex.lastIndex
  }

  if (parts.length === 0) {
    return <span className="ag-md-segment">{renderInline(text, opts, keyPrefix)}</span>
  }

  if (lastIdx < text.length) {
    const after = text.slice(lastIdx).replace(/^\n+/, '')
    if (after.trim()) {
      parts.push(
        <span key={`${keyPrefix}pe${seg++}`} className="ag-md-segment">
          {renderInline(after, opts, `${keyPrefix}pe${seg}-`)}
        </span>
      )
    }
  }

  return <>{parts}</>
}

function renderBlocks(
  rawText: string,
  opts: MarkdownCallbacks,
  keyPrefix = '',
  quoteDepth = 0
): React.ReactNode[] {
  const normalized = rawText.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0
  let bIdx = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // Skip blank separator lines
    if (!trimmed) {
      i += 1
      continue
    }

    // 1. Fenced Code Block (```lang ... ```)
    const fenceMatch = FENCE_OPEN_REGEX.exec(trimmed)
    if (fenceMatch) {
      const lang = fenceMatch[1] || ''
      const rest = fenceMatch[2] || ''
      // Handle single-line fenced block ```code```
      if (rest && rest.endsWith('```') && rest.length >= 3) {
        blocks.push(
          <CodeBlock
            key={`${keyPrefix}cb-${bIdx++}`}
            lang={lang}
            code={rest.slice(0, -3).trim()}
          />
        )
        i += 1
        continue
      }
      const codeLines: string[] = []
      if (rest) codeLines.push(rest)
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        codeLines.push(lines[i])
        i += 1
      }
      if (i < lines.length && /^```\s*$/.test(lines[i].trim())) {
        i += 1
      }
      blocks.push(
        <CodeBlock key={`${keyPrefix}cb-${bIdx++}`} lang={lang} code={codeLines.join('\n')} />
      )
      continue
    }

    // 2. Display Math Block: `$$ ... $$`
    if (trimmed.startsWith('$$')) {
      const singleLine = /^\$\$(.+?)\$\$\s*$/.exec(trimmed)
      if (singleLine && singleLine[1].trim()) {
        blocks.push(
          <MathNode key={`${keyPrefix}mb-${bIdx++}`} tex={singleLine[1].trim()} display />
        )
        i += 1
        continue
      }
      // Multi-line `$$ ... $$`
      const mathLines: string[] = []
      const firstRest = trimmed.slice(2)
      if (firstRest.trim()) mathLines.push(firstRest)
      let j = i + 1
      let closed = false
      while (j < lines.length) {
        const cur = lines[j]
        const endIdx = cur.indexOf('$$')
        if (endIdx !== -1) {
          const before = cur.slice(0, endIdx)
          if (before.trim()) mathLines.push(before)
          closed = true
          j += 1
          break
        }
        mathLines.push(cur)
        j += 1
      }
      if (closed && mathLines.join('\n').trim()) {
        blocks.push(
          <MathNode key={`${keyPrefix}mb-${bIdx++}`} tex={mathLines.join('\n').trim()} display />
        )
        i = j
        continue
      }
    }

    // 3. Display Math Block: `\[ ... \]`
    if (trimmed.startsWith('\\[')) {
      const singleLine = /^\\\[(.+?)\\\]\s*$/.exec(trimmed)
      if (singleLine && singleLine[1].trim()) {
        blocks.push(
          <MathNode key={`${keyPrefix}ml-${bIdx++}`} tex={singleLine[1].trim()} display />
        )
        i += 1
        continue
      }
      const mathLines: string[] = []
      const firstRest = trimmed.slice(2)
      if (firstRest.trim()) mathLines.push(firstRest)
      let j = i + 1
      let closed = false
      while (j < lines.length) {
        const cur = lines[j]
        const endIdx = cur.indexOf('\\]')
        if (endIdx !== -1) {
          const before = cur.slice(0, endIdx)
          if (before.trim()) mathLines.push(before)
          closed = true
          j += 1
          break
        }
        mathLines.push(cur)
        j += 1
      }
      if (closed && mathLines.join('\n').trim()) {
        blocks.push(
          <MathNode key={`${keyPrefix}ml-${bIdx++}`} tex={mathLines.join('\n').trim()} display />
        )
        i = j
        continue
      }
    }

    // 4. Horizontal Rule (`---`, `***`, `___`)
    if (HR_LINE_REGEX.test(line)) {
      blocks.push(<hr key={`${keyPrefix}hr-${bIdx++}`} className="ag-md-hr" />)
      i += 1
      continue
    }

    // 5. Headings (`# ` through `#### `)
    const headingMatch = HEADING_LINE_REGEX.exec(line)
    if (headingMatch) {
      const level = headingMatch[1].length
      const content = headingMatch[2].trim()
      blocks.push(
        <div
          key={`${keyPrefix}h-${bIdx++}`}
          role="heading"
          aria-level={level}
          className={`ag-md-heading ag-md-h${level}`}
        >
          {renderInline(content, opts, `${keyPrefix}h${bIdx}-`)}
        </div>
      )
      i += 1
      continue
    }

    // 6. Multi-Line Blockquote (`>>> ...` consumes rest of message)
    if (quoteDepth < 3 && /^>>>(?:\s|$)/.test(trimmed)) {
      const firstLine = trimmed.replace(/^>>>\s?/, '')
      const rest = [firstLine, ...lines.slice(i + 1)].join('\n')
      blocks.push(
        <blockquote key={`${keyPrefix}bq-${bIdx++}`} className="ag-md-quote">
          {renderBlocks(rest, opts, `${keyPrefix}q${bIdx}-`, quoteDepth + 1)}
        </blockquote>
      )
      i = lines.length
      continue
    }

    // 7. Standard Blockquote (`> ` consecutive lines)
    if (quoteDepth < 3 && /^>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push(
        <blockquote key={`${keyPrefix}bq-${bIdx++}`} className="ag-md-quote">
          {renderBlocks(quoteLines.join('\n'), opts, `${keyPrefix}q${bIdx}-`, quoteDepth + 1)}
        </blockquote>
      )
      continue
    }

    // 8. Markdown Pipe Table (`| a | b |`)
    if (isTableStart(lines, i)) {
      const headers = splitTableRow(lines[i])
      const alignments = parseTableAlignments(lines[i + 1])
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i]))
        i += 1
      }
      const tblKey = `${keyPrefix}tbl-${bIdx++}`
      blocks.push(
        <div key={tblKey} className="ag-md-table-wrap" data-no-swipe="true">
          <table className="ag-md-table">
            <thead>
              <tr>
                {headers.map((cell, ci) => (
                  <th key={ci} style={{ textAlign: alignments[ci] ?? 'left' }}>
                    {renderInline(cell, opts, `${tblKey}h${ci}-`)}
                  </th>
                ))}
              </tr>
            </thead>
            {rows.length > 0 && (
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri}>
                    {headers.map((_, ci) => (
                      <td key={ci} style={{ textAlign: alignments[ci] ?? 'left' }}>
                        {renderInline(row[ci] ?? '', opts, `${tblKey}r${ri}c${ci}-`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      )
      continue
    }

    // 9. Unordered List & Task Checklist (`- `, `* `, `- [ ] `, `- [x] `)
    if (TASK_LIST_REGEX.test(line) || UL_LINE_REGEX.test(line)) {
      const listKey = `${keyPrefix}ul-${bIdx++}`
      const items: React.ReactNode[] = []
      let itemIdx = 0
      let hasTaskItems = false
      while (i < lines.length) {
        const taskM = TASK_LIST_REGEX.exec(lines[i])
        if (taskM) {
          hasTaskItems = true
          const checked = taskM[1].toLowerCase() === 'x'
          items.push(
            <li key={itemIdx} className={`ag-md-task ${checked ? 'checked' : ''}`}>
              <span className="ag-md-checkbox" aria-hidden="true">
                {checked ? '✓' : ''}
              </span>
              <span className="ag-md-task-text">
                {renderInline(taskM[2], opts, `${listKey}t${itemIdx}-`)}
              </span>
            </li>
          )
          itemIdx += 1
          i += 1
          continue
        }
        const ulM = UL_LINE_REGEX.exec(lines[i])
        if (ulM) {
          items.push(
            <li key={itemIdx}>{renderInline(ulM[1], opts, `${listKey}i${itemIdx}-`)}</li>
          )
          itemIdx += 1
          i += 1
          continue
        }
        break
      }
      blocks.push(
        <ul key={listKey} className={`ag-md-ul ${hasTaskItems ? 'has-tasks' : ''}`}>
          {items}
        </ul>
      )
      continue
    }

    // 10. Ordered List (`1. `)
    const olFirst = OL_LINE_REGEX.exec(line)
    if (olFirst) {
      const listKey = `${keyPrefix}ol-${bIdx++}`
      const startNum = Math.max(1, Number.parseInt(olFirst[1], 10) || 1)
      const items: React.ReactNode[] = []
      let itemIdx = 0
      while (i < lines.length) {
        const olM = OL_LINE_REGEX.exec(lines[i])
        if (!olM) break
        items.push(<li key={itemIdx}>{renderInline(olM[2], opts, `${listKey}i${itemIdx}-`)}</li>)
        itemIdx += 1
        i += 1
      }
      blocks.push(
        <ol key={listKey} className="ag-md-ol" start={startNum !== 1 ? startNum : undefined}>
          {items}
        </ol>
      )
      continue
    }

    // 11. Paragraph (consecutive plain lines until blank line or next block opener)
    const paraLines: string[] = [line]
    i += 1
    while (i < lines.length && !isBlockOpener(lines, i)) {
      paraLines.push(lines[i])
      i += 1
    }
    const pKey = `${keyPrefix}p-${bIdx++}`
    blocks.push(
      <div key={pKey} className="ag-md-p">
        {renderParagraphContent(paraLines.join('\n'), opts, `${pKey}-`)}
      </div>
    )
  }

  return blocks
}

export interface RichMessageContentProps extends MarkdownCallbacks {
  content: string
}

/**
 * Safe, zero-HTML-injection markdown, MathJax SVG, and Bitchat entity renderer.
 * Never renders inline <img> elements or unsafe link schemes.
 */
export const RichMessageContent: React.FC<RichMessageContentProps> = React.memo(
  ({ content, onTuneGeohash, onClickMention, highlightQuery, knownHandles }) => {
    const callbacks: MarkdownCallbacks = {
      onTuneGeohash,
      onClickMention,
      highlightQuery,
      knownHandles,
    }

    return <div className="ag-msg-rich">{renderBlocks(content, callbacks)}</div>
  }
)

RichMessageContent.displayName = 'RichMessageContent'
