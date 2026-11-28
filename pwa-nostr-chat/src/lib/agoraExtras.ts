import { nip19, type Event as NostrEvent, type EventTemplate } from 'nostr-tools'
import type {
  AgoraArticle,
  AgoraContentBlock,
  AgoraCustomList,
  AgoraDensity,
  AgoraDraftPayload,
  AgoraFeedItem,
  AgoraGroupedNotification,
  AgoraMuteList,
  AgoraNote,
  AgoraNotification,
  AgoraPoll,
  AgoraPollOption,
  AgoraReplyTreeNode,
  AgoraUploadedMedia,
} from '../types/agora.ts'
import { isHex64, normalizeHashtag, parseAgoraNote, sanitizeHttpUrl } from './agoraProtocol.ts'
import { normalizeRelayUrl } from './geoRelays.ts'

export const KIND_AGORA_MUTE_LIST = 10000
export const KIND_AGORA_PEOPLE_LIST = 30000
export const KIND_AGORA_ARTICLE = 30023
export const KIND_AGORA_POLL = 1068
export const KIND_AGORA_POLL_RESPONSE = 1018

export const AGORA_NIP05_CACHE_KEY = 'agnostr:v1:agora_nip05_cache'
export const AGORA_MUTE_LIST_KEY = 'agnostr:v1:agora_mute_list'
export const AGORA_CUSTOM_LISTS_KEY = 'agnostr:v1:agora_custom_lists'
export const AGORA_DRAFTS_KEY = 'agnostr:v1:agora_drafts'
export const AGORA_FEED_CACHE_KEY = 'agnostr:v1:agora_feed_cache'
export const AGORA_DENSITY_KEY = 'agnostr:v1:agora_density'

const NIP05_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const NIP05_FETCH_TIMEOUT_MS = 3500
const MAX_NIP05_CACHE_ENTRIES = 300
const MAX_FEED_CACHE_ITEMS = 50
const MAX_CACHED_DRAFTS = 12
const MAX_CUSTOM_LISTS = 40
const MAX_REPLY_TREE_DEPTH = 4
const NOTIFICATION_GROUP_WINDOW_SEC = 24 * 3600

const IPV4_LITERAL_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
const DOMAIN_HOST_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const LOCAL_PART_RE = /^[a-z0-9._-]{1,64}$/i

export const EMPTY_MUTE_LIST: AgoraMuteList = Object.freeze({
  words: [],
  hashtags: [],
  threads: [],
  pubkeys: [],
  updatedAt: 0,
})

function safeGetStorage(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetStorage(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  } catch {
    // Ignore quota / restricted storage errors
  }
}

function safeRemoveStorage(key: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(key)
  } catch {
    // Ignore storage errors
  }
}

export function clearAllAgoraExtrasStorage(): void {
  safeRemoveStorage(AGORA_NIP05_CACHE_KEY)
  safeRemoveStorage(AGORA_MUTE_LIST_KEY)
  safeRemoveStorage(AGORA_CUSTOM_LISTS_KEY)
  safeRemoveStorage(AGORA_DRAFTS_KEY)
  safeRemoveStorage(AGORA_FEED_CACHE_KEY)
  safeRemoveStorage(AGORA_DENSITY_KEY)
}

/* --------------------------------------------------------------------------
   NIP-05 Real HTTPS Verification (with 24h Cache & SSRF/IP Rejection)
   -------------------------------------------------------------------------- */

interface Nip05CacheEntry {
  status: 'verified' | 'invalid'
  checkedAt: number
}

function loadNip05Cache(): Record<string, Nip05CacheEntry> {
  const raw = safeGetStorage(AGORA_NIP05_CACHE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const now = Date.now()
    const out: Record<string, Nip05CacheEntry> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const entry = v as Partial<Nip05CacheEntry>
      if (
        (entry.status === 'verified' || entry.status === 'invalid') &&
        typeof entry.checkedAt === 'number' &&
        Number.isFinite(entry.checkedAt) &&
        now - entry.checkedAt < NIP05_CACHE_TTL_MS
      ) {
        out[k] = { status: entry.status, checkedAt: entry.checkedAt }
      }
    }
    return out
  } catch {
    return {}
  }
}

function saveNip05CacheEntry(cacheKey: string, status: 'verified' | 'invalid'): void {
  const cache = loadNip05Cache()
  cache[cacheKey] = { status, checkedAt: Date.now() }
  const entries = Object.entries(cache)
    .sort((a, b) => b[1].checkedAt - a[1].checkedAt)
    .slice(0, MAX_NIP05_CACHE_ENTRIES)
  safeSetStorage(AGORA_NIP05_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)))
}

export function parseNip05Parts(raw: string): { local: string; host: string } | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed || trimmed.length > 180 || /\s/.test(trimmed)) return null

  let local = '_'
  let host = trimmed
  const atIdx = trimmed.indexOf('@')
  if (atIdx !== -1) {
    if (trimmed.indexOf('@', atIdx + 1) !== -1) return null
    local = trimmed.slice(0, atIdx)
    host = trimmed.slice(atIdx + 1)
  }

  if (!LOCAL_PART_RE.test(local)) return null
  if (
    !host ||
    host.length > 160 ||
    host.includes(':') ||
    host.includes('[') ||
    host.includes(']') ||
    IPV4_LITERAL_RE.test(host) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    !DOMAIN_HOST_RE.test(host)
  ) {
    return null
  }

  const tld = host.slice(host.lastIndexOf('.') + 1)
  if (!/^[a-z]{2,24}$/.test(tld)) return null

  return { local, host }
}

export function getCachedNip05Status(
  nip05: string,
  pubkey: string
): 'verified' | 'invalid' | null {
  if (!isHex64(pubkey)) return null
  const parts = parseNip05Parts(nip05)
  if (!parts) return 'invalid'
  const cacheKey = `${parts.local}@${parts.host}:${pubkey.toLowerCase()}`
  const cache = loadNip05Cache()
  const hit = cache[cacheKey]
  if (!hit) return null
  if (Date.now() - hit.checkedAt >= NIP05_CACHE_TTL_MS) return null
  return hit.status
}

export async function verifyNip05Identifier(
  nip05: string,
  pubkey: string
): Promise<'verified' | 'invalid' | 'unverified'> {
  if (!isHex64(pubkey)) return 'invalid'
  const cleanPk = pubkey.trim().toLowerCase()
  const parts = parseNip05Parts(nip05)
  if (!parts) return 'invalid'

  const cacheKey = `${parts.local}@${parts.host}:${cleanPk}`
  const cached = loadNip05Cache()[cacheKey]
  if (cached && Date.now() - cached.checkedAt < NIP05_CACHE_TTL_MS) {
    return cached.status
  }

  if (typeof fetch !== 'function') return 'unverified'

  const url = `https://${parts.host}/.well-known/nostr.json?name=${encodeURIComponent(parts.local)}`
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), NIP05_FETCH_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (res.status === 404 || res.status === 410) {
      saveNip05CacheEntry(cacheKey, 'invalid')
      return 'invalid'
    }
    if (!res.ok) return 'unverified'

    const json = (await res.json()) as unknown
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      saveNip05CacheEntry(cacheKey, 'invalid')
      return 'invalid'
    }
    const namesRaw = (json as { names?: unknown }).names
    if (!namesRaw || typeof namesRaw !== 'object' || Array.isArray(namesRaw)) {
      saveNip05CacheEntry(cacheKey, 'invalid')
      return 'invalid'
    }
    const names = namesRaw as Record<string, unknown>
    let matchedPk: unknown = names[parts.local]
    if (typeof matchedPk !== 'string') {
      for (const [k, v] of Object.entries(names)) {
        if (k.trim().toLowerCase() === parts.local) {
          matchedPk = v
          break
        }
      }
    }

    if (typeof matchedPk === 'string' && matchedPk.trim().toLowerCase() === cleanPk) {
      saveNip05CacheEntry(cacheKey, 'verified')
      return 'verified'
    }

    saveNip05CacheEntry(cacheKey, 'invalid')
    return 'invalid'
  } catch {
    return 'unverified'
  } finally {
    globalThis.clearTimeout(timer)
  }
}

/* --------------------------------------------------------------------------
   NIP-51 Mute List (kind: 10000)
   -------------------------------------------------------------------------- */

function dedupeStrings(items: readonly string[], maxLen: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    const clean = raw.trim().toLowerCase()
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
    if (out.length >= maxLen) break
  }
  return out
}

export function parseMuteList(event: NostrEvent): AgoraMuteList | null {
  if (!event || event.kind !== KIND_AGORA_MUTE_LIST || !Array.isArray(event.tags)) {
    return null
  }
  const words: string[] = []
  const hashtags: string[] = []
  const threads: string[] = []
  const pubkeys: string[] = []

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length < 2 || typeof tag[1] !== 'string') continue
    const kind = tag[0]
    const val = tag[1].trim()
    if (!val) continue
    if (kind === 'word') {
      words.push(val.slice(0, 80))
    } else if (kind === 't') {
      const clean = normalizeHashtag(val)
      if (clean) hashtags.push(clean)
    } else if (kind === 'e' && isHex64(val)) {
      threads.push(val.toLowerCase())
    } else if (kind === 'p' && isHex64(val)) {
      pubkeys.push(val.toLowerCase())
    }
  }

  return {
    words: dedupeStrings(words, 200),
    hashtags: dedupeStrings(hashtags, 200),
    threads: dedupeStrings(threads, 300),
    pubkeys: dedupeStrings(pubkeys, 500),
    updatedAt: Number.isFinite(event.created_at) ? event.created_at : 0,
  }
}

export function buildMuteListTemplate(
  list: AgoraMuteList,
  existingEvent?: NostrEvent | null
): EventTemplate {
  const preservedOtherTags: string[][] = []
  if (existingEvent && Array.isArray(existingEvent.tags)) {
    for (const tag of existingEvent.tags) {
      if (!Array.isArray(tag) || tag.length === 0) continue
      if (tag[0] !== 'word' && tag[0] !== 't' && tag[0] !== 'e' && tag[0] !== 'p') {
        preservedOtherTags.push([...tag])
      }
    }
  }

  const tags: string[][] = [...preservedOtherTags]
  for (const w of dedupeStrings(list.words, 200)) {
    tags.push(['word', w.slice(0, 80)])
  }
  for (const t of dedupeStrings(list.hashtags, 200)) {
    const clean = normalizeHashtag(t)
    if (clean) tags.push(['t', clean])
  }
  for (const id of dedupeStrings(list.threads, 300)) {
    if (isHex64(id)) tags.push(['e', id])
  }
  for (const pk of dedupeStrings(list.pubkeys, 500)) {
    if (isHex64(pk)) tags.push(['p', pk])
  }

  return {
    kind: KIND_AGORA_MUTE_LIST,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: typeof existingEvent?.content === 'string' ? existingEvent.content : '',
  }
}

export function doesNoteMatchMuteList(note: AgoraNote, muteList: AgoraMuteList): boolean {
  if (
    muteList.words.length === 0 &&
    muteList.hashtags.length === 0 &&
    muteList.threads.length === 0 &&
    muteList.pubkeys.length === 0
  ) {
    return false
  }

  const pk = note.pubkey.toLowerCase()
  if (muteList.pubkeys.includes(pk)) return true

  if (muteList.threads.length > 0) {
    if (muteList.threads.includes(note.id.toLowerCase())) return true
    if (note.rootId && muteList.threads.includes(note.rootId.toLowerCase())) return true
    if (note.replyToId && muteList.threads.includes(note.replyToId.toLowerCase())) return true
  }

  if (muteList.hashtags.length > 0 && note.hashtags.length > 0) {
    for (const h of note.hashtags) {
      if (muteList.hashtags.includes(h.toLowerCase())) return true
    }
  }

  if (muteList.words.length > 0) {
    const lowerContent = note.content.toLowerCase()
    const lowerTags = note.hashtags.map((h) => h.toLowerCase())
    for (const rawWord of muteList.words) {
      const w = rawWord.trim().toLowerCase()
      if (!w) continue
      if (w.startsWith('#')) {
        const tagSlug = w.slice(1)
        if (tagSlug && lowerTags.includes(tagSlug)) return true
      }
      if (lowerContent.includes(w)) return true
    }
  }

  return false
}

export function loadCachedMuteList(): AgoraMuteList {
  const raw = safeGetStorage(AGORA_MUTE_LIST_KEY)
  if (!raw) return { ...EMPTY_MUTE_LIST, words: [], hashtags: [], threads: [], pubkeys: [] }
  try {
    const parsed = JSON.parse(raw) as Partial<AgoraMuteList>
    if (!parsed || typeof parsed !== 'object') {
      return { ...EMPTY_MUTE_LIST, words: [], hashtags: [], threads: [], pubkeys: [] }
    }
    return {
      words: Array.isArray(parsed.words)
        ? dedupeStrings(
            parsed.words.filter((x): x is string => typeof x === 'string'),
            200
          )
        : [],
      hashtags: Array.isArray(parsed.hashtags)
        ? dedupeStrings(
            parsed.hashtags.filter((x): x is string => typeof x === 'string'),
            200
          )
        : [],
      threads: Array.isArray(parsed.threads)
        ? dedupeStrings(
            parsed.threads.filter((x): x is string => typeof x === 'string' && isHex64(x)),
            300
          )
        : [],
      pubkeys: Array.isArray(parsed.pubkeys)
        ? dedupeStrings(
            parsed.pubkeys.filter((x): x is string => typeof x === 'string' && isHex64(x)),
            500
          )
        : [],
      updatedAt:
        typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : 0,
    }
  } catch {
    return { ...EMPTY_MUTE_LIST, words: [], hashtags: [], threads: [], pubkeys: [] }
  }
}

export function saveCachedMuteList(list: AgoraMuteList): void {
  safeSetStorage(AGORA_MUTE_LIST_KEY, JSON.stringify(list))
}

/* --------------------------------------------------------------------------
   NIP-51 Follow Sets / Custom People Lists (kind: 30000)
   -------------------------------------------------------------------------- */

export function parsePeopleList(event: NostrEvent): AgoraCustomList | null {
  if (
    !event ||
    event.kind !== KIND_AGORA_PEOPLE_LIST ||
    !isHex64(event.id) ||
    !Array.isArray(event.tags)
  ) {
    return null
  }
  let dTag = ''
  let title = ''
  let description: string | undefined
  const pubkeys: string[] = []
  const seenPk = new Set<string>()

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length < 2 || typeof tag[1] !== 'string') continue
    const key = tag[0]
    const val = tag[1].trim()
    if (!val) continue
    if (key === 'd' && !dTag) {
      dTag = val.slice(0, 80)
    } else if ((key === 'title' || key === 'name') && !title) {
      title = val.slice(0, 80)
    } else if (key === 'description' && !description) {
      description = val.slice(0, 240)
    } else if (key === 'p' && isHex64(val)) {
      const pk = val.toLowerCase()
      if (!seenPk.has(pk)) {
        seenPk.add(pk)
        pubkeys.push(pk)
      }
    }
  }

  if (!dTag) return null
  return {
    id: dTag,
    dTag,
    title: title || dTag,
    ...(description ? { description } : {}),
    pubkeys: pubkeys.slice(0, 500),
    updatedAt: Number.isFinite(event.created_at) ? event.created_at : 0,
  }
}

export function buildPeopleListTemplate(list: {
  dTag: string
  title: string
  description?: string
  pubkeys: readonly string[]
}): EventTemplate {
  const cleanD = list.dTag.trim().slice(0, 80)
  const cleanTitle = list.title.trim().slice(0, 80) || cleanD
  const tags: string[][] = [
    ['d', cleanD],
    ['title', cleanTitle],
  ]
  const cleanDesc = list.description?.trim().slice(0, 240)
  if (cleanDesc) {
    tags.push(['description', cleanDesc])
  }
  const seen = new Set<string>()
  for (const rawPk of list.pubkeys) {
    if (!isHex64(rawPk)) continue
    const pk = rawPk.toLowerCase()
    if (seen.has(pk)) continue
    seen.add(pk)
    tags.push(['p', pk])
    if (seen.size >= 500) break
  }

  return {
    kind: KIND_AGORA_PEOPLE_LIST,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }
}

export function loadCachedCustomLists(): AgoraCustomList[] {
  const raw = safeGetStorage(AGORA_CUSTOM_LISTS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: AgoraCustomList[] = []
    const seen = new Set<string>()
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const entry = item as Partial<AgoraCustomList>
      if (typeof entry.dTag !== 'string' || !entry.dTag.trim()) continue
      const dTag = entry.dTag.trim().slice(0, 80)
      if (seen.has(dTag)) continue
      seen.add(dTag)
      const pubkeys = Array.isArray(entry.pubkeys)
        ? dedupeStrings(
            entry.pubkeys.filter((p): p is string => typeof p === 'string' && isHex64(p)),
            500
          )
        : []
      out.push({
        id: dTag,
        dTag,
        title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim().slice(0, 80) : dTag,
        ...(typeof entry.description === 'string' && entry.description.trim()
          ? { description: entry.description.trim().slice(0, 240) }
          : {}),
        pubkeys,
        updatedAt:
          typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
            ? entry.updatedAt
            : 0,
      })
      if (out.length >= MAX_CUSTOM_LISTS) break
    }
    return out
  } catch {
    return []
  }
}

export function saveCachedCustomLists(lists: readonly AgoraCustomList[]): void {
  safeSetStorage(AGORA_CUSTOM_LISTS_KEY, JSON.stringify(lists.slice(0, MAX_CUSTOM_LISTS)))
}

/* --------------------------------------------------------------------------
   NIP-23 Long-Form Articles (kind: 30023) & Structured Rich Content Blocks
   -------------------------------------------------------------------------- */

export function parseAgoraArticle(event: NostrEvent): AgoraArticle | null {
  if (
    !event ||
    event.kind !== KIND_AGORA_ARTICLE ||
    !isHex64(event.id) ||
    !isHex64(event.pubkey) ||
    typeof event.content !== 'string' ||
    !Array.isArray(event.tags)
  ) {
    return null
  }
  const content = event.content.trim()
  if (!content) return null

  const pk = event.pubkey.toLowerCase()
  let dTag = ''
  let title = ''
  let summary: string | undefined
  let image: string | undefined
  let publishedAt: number | undefined
  const hashtags: string[] = []
  const seenTags = new Set<string>()

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length < 2 || typeof tag[1] !== 'string') continue
    const key = tag[0]
    const val = tag[1].trim()
    if (!val) continue
    if (key === 'd' && !dTag) {
      dTag = val.slice(0, 160)
    } else if (key === 'title' && !title) {
      title = val.slice(0, 200)
    } else if (key === 'summary' && !summary) {
      summary = val.slice(0, 400)
    } else if (key === 'image' && !image) {
      const clean = sanitizeHttpUrl(val)
      if (clean && clean.toLowerCase().startsWith('https://')) {
        image = clean
      }
    } else if (key === 'published_at' && publishedAt === undefined) {
      const n = Number.parseInt(val, 10)
      if (Number.isFinite(n) && n > 0) publishedAt = n
    } else if (key === 't') {
      const clean = normalizeHashtag(val)
      if (clean && !seenTags.has(clean)) {
        seenTags.add(clean)
        hashtags.push(clean)
      }
    }
  }

  if (!dTag) {
    dTag = event.id.toLowerCase().slice(0, 16)
  }

  if (!title) {
    const firstLine = content
      .split(/\r?\n/)
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find((l) => l.length > 0)
    title = (firstLine ?? 'Untitled Article').slice(0, 140)
  }

  let naddr = ''
  try {
    naddr = nip19.naddrEncode({
      kind: KIND_AGORA_ARTICLE,
      pubkey: pk,
      identifier: dTag,
    })
  } catch {
    naddr = `${KIND_AGORA_ARTICLE}:${pk}:${dTag}`
  }

  const createdAt = Number.isFinite(event.created_at) ? event.created_at : 0

  return {
    id: event.id.toLowerCase(),
    dTag,
    pubkey: pk,
    title,
    ...(summary ? { summary } : {}),
    ...(image ? { image } : {}),
    publishedAt: publishedAt ?? createdAt,
    createdAt,
    content,
    hashtags: hashtags.slice(0, 12),
    naddr,
    rawEvent: event,
  }
}

export function estimateReadingTimeMin(content: string): number {
  if (!content) return 1
  const words = content.trim().split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.ceil(words / 220))
}

/**
 * Splits note or long-form markdown text into safe structured blocks (paragraphs, headings,
 * blockquotes, and fenced code blocks) — ZERO raw HTML output.
 */
export function parseRichContentBlocks(content: string): AgoraContentBlock[] {
  if (!content || typeof content !== 'string') return []
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks: AgoraContentBlock[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Skip blank separator lines
    if (!line.trim()) {
      i += 1
      continue
    }

    // Fenced code block: ```lang
    const fenceMatch = line.match(/^\s*```([a-zA-Z0-9_+-]{0,24})\s*$/)
    if (fenceMatch) {
      const lang = fenceMatch[1]?.trim() || undefined
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        codeLines.push(lines[i])
        i += 1
      }
      if (i < lines.length && /^\s*```\s*$/.test(lines[i])) {
        i += 1
      }
      blocks.push({
        type: 'code',
        ...(lang ? { lang } : {}),
        code: codeLines.join('\n'),
      })
      continue
    }

    // Markdown headings: # / ## / ### (strictly followed by whitespace)
    const headingMatch = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/)
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3
      const text = headingMatch[2].trim()
      if (text) {
        blocks.push({ type: 'heading', level, text })
      }
      i += 1
      continue
    }

    // Blockquotes: consecutive lines starting with `>`
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      const text = quoteLines.join('\n').trim()
      if (text) {
        blocks.push({ type: 'blockquote', text })
      }
      continue
    }

    // Regular paragraph: collect lines until blank line or block starter
    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i])
    ) {
      paraLines.push(lines[i])
      i += 1
    }
    const text = paraLines.join('\n').trim()
    if (text) {
      blocks.push({ type: 'paragraph', text })
    }
  }

  return blocks
}

/* --------------------------------------------------------------------------
   NIP-88 Native Polls (kind: 1068) & Poll Responses (kind: 1018)
   -------------------------------------------------------------------------- */

export function parseAgoraPoll(event: NostrEvent): AgoraPoll | null {
  if (
    !event ||
    event.kind !== KIND_AGORA_POLL ||
    !isHex64(event.id) ||
    !isHex64(event.pubkey) ||
    typeof event.content !== 'string' ||
    !Array.isArray(event.tags)
  ) {
    return null
  }
  const question = event.content.trim().slice(0, 400)
  if (!question) return null

  const options: AgoraPollOption[] = []
  const seenOptIds = new Set<string>()
  let endsAt: number | undefined

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length < 2) continue
    if (tag[0] === 'option' && typeof tag[1] === 'string' && typeof tag[2] === 'string') {
      const optId = tag[1].trim().slice(0, 48)
      const label = tag[2].trim().slice(0, 120)
      if (!optId || !label || seenOptIds.has(optId)) continue
      seenOptIds.add(optId)
      options.push({ id: optId, label })
      if (options.length >= 8) break
    } else if (tag[0] === 'endsAt' && typeof tag[1] === 'string' && endsAt === undefined) {
      const n = Number.parseInt(tag[1].trim(), 10)
      if (Number.isFinite(n) && n > 0) endsAt = n
    }
  }

  if (options.length < 2) return null

  return {
    id: event.id.toLowerCase(),
    pubkey: event.pubkey.toLowerCase(),
    question,
    options,
    ...(endsAt ? { endsAt } : {}),
    createdAt: Number.isFinite(event.created_at) ? event.created_at : 0,
    rawEvent: event,
  }
}

export function buildAgoraPollTemplate(
  question: string,
  options: readonly string[],
  durationSec?: number,
  relayHint?: string
): EventTemplate {
  const cleanQuestion = question.trim().slice(0, 400)
  const cleanOptions = options
    .map((o) => o.trim().slice(0, 120))
    .filter((o) => o.length > 0)
    .slice(0, 5)

  const nowSec = Math.floor(Date.now() / 1000)
  const tags: string[][] = cleanOptions.map((label, idx) => ['option', String(idx + 1), label])
  tags.push(['polltype', 'singlechoice'])

  if (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec >= 60) {
    const clampedDuration = Math.min(30 * 86400, Math.floor(durationSec))
    tags.push(['endsAt', String(nowSec + clampedDuration)])
  }

  const cleanRelay = relayHint ? normalizeRelayUrl(relayHint) : null
  if (cleanRelay) {
    tags.push(['relay', cleanRelay])
  }

  return {
    kind: KIND_AGORA_POLL,
    created_at: nowSec,
    tags,
    content: cleanQuestion,
  }
}

export interface ParsedAgoraPollResponse {
  id: string
  voterPubkey: string
  pollId: string
  optionId: string
  createdAt: number
}

export function parseAgoraPollResponse(event: NostrEvent): ParsedAgoraPollResponse | null {
  if (
    !event ||
    event.kind !== KIND_AGORA_POLL_RESPONSE ||
    !isHex64(event.id) ||
    !isHex64(event.pubkey) ||
    !Array.isArray(event.tags)
  ) {
    return null
  }
  let pollId: string | undefined
  let optionId: string | undefined

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length < 2 || typeof tag[1] !== 'string') continue
    if (tag[0] === 'e' && isHex64(tag[1]) && !pollId) {
      pollId = tag[1].toLowerCase()
    } else if (tag[0] === 'response' && tag[1].trim() && !optionId) {
      optionId = tag[1].trim().slice(0, 48)
    }
  }

  if (!pollId || !optionId) return null

  return {
    id: event.id.toLowerCase(),
    voterPubkey: event.pubkey.toLowerCase(),
    pollId,
    optionId,
    createdAt: Number.isFinite(event.created_at) ? event.created_at : 0,
  }
}

export function buildAgoraPollResponseTemplate(
  poll: AgoraPoll,
  optionId: string
): EventTemplate {
  return {
    kind: KIND_AGORA_POLL_RESPONSE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', poll.id.toLowerCase()],
      ['p', poll.pubkey.toLowerCase()],
      ['response', optionId.trim().slice(0, 48)],
    ],
    content: '',
  }
}

/* --------------------------------------------------------------------------
   Feed Deduplication, Nested Reply Trees & Grouped Notifications
   -------------------------------------------------------------------------- */

/**
 * Collapses duplicate reposts (and note + repost collisions) of the same note ID into a
 * single item carrying `repostedByList` ordered by most-recent reposter first.
 */
export function deduplicateFeedItems(items: AgoraFeedItem[]): AgoraFeedItem[] {
  if (items.length <= 1) return [...items]

  const buckets = new Map<
    string,
    {
      note: AgoraNote
      hasDirectNote: boolean
      bestSortAt: number
      reposters: Array<{ pubkey: string; at: number }>
      reposterSet: Set<string>
    }
  >()

  for (const item of items) {
    const noteId = item.note.id.toLowerCase()
    let bucket = buckets.get(noteId)
    if (!bucket) {
      bucket = {
        note: item.note,
        hasDirectNote: item.kind === 'note',
        bestSortAt: item.sortAt,
        reposters: [],
        reposterSet: new Set(),
      }
      buckets.set(noteId, bucket)
    } else {
      if (item.kind === 'note') bucket.hasDirectNote = true
      if (item.sortAt > bucket.bestSortAt) bucket.bestSortAt = item.sortAt
    }

    const reposterList =
      item.repostedByList && item.repostedByList.length > 0
        ? item.repostedByList
        : item.repostedBy
          ? [item.repostedBy]
          : []
    const repAt = item.repostedAt ?? item.sortAt

    for (const rawPk of reposterList) {
      const pk = rawPk.toLowerCase()
      if (!bucket.reposterSet.has(pk)) {
        bucket.reposterSet.add(pk)
        bucket.reposters.push({ pubkey: pk, at: repAt })
      } else {
        const existing = bucket.reposters.find((r) => r.pubkey === pk)
        if (existing && repAt > existing.at) existing.at = repAt
      }
    }
  }

  const out: AgoraFeedItem[] = []
  for (const [noteId, bucket] of buckets.entries()) {
    bucket.reposters.sort((a, b) => b.at - a.at)
    const repostedByList = bucket.reposters.map((r) => r.pubkey)
    const latestRepostAt = bucket.reposters[0]?.at

    if (repostedByList.length === 0) {
      out.push({
        key: `note:${noteId}`,
        kind: 'note',
        note: bucket.note,
        sortAt: bucket.bestSortAt,
      })
    } else {
      const showAsRepost = !bucket.hasDirectNote || (latestRepostAt ?? 0) > bucket.note.createdAt
      out.push({
        key: showAsRepost ? `repost:${repostedByList[0]}:${noteId}` : `note:${noteId}`,
        kind: showAsRepost ? 'repost' : 'note',
        note: bucket.note,
        repostedBy: repostedByList[0],
        repostedByList,
        repostedAt: latestRepostAt,
        sortAt: bucket.bestSortAt,
      })
    }
  }

  return out.sort((a, b) => b.sortAt - a.sortAt || b.note.createdAt - a.note.createdAt)
}

/**
 * Builds a nested threaded reply tree under `focusedNoteId` using NIP-10 `replyToId`,
 * capping visual depth at 4 and sorting chronologically within each level.
 */
export function buildThreadedReplyTree(
  focusedNoteId: string,
  replies: readonly AgoraNote[]
): AgoraReplyTreeNode[] {
  if (replies.length === 0) return []
  const focusedId = focusedNoteId.toLowerCase()

  const byId = new Map<string, AgoraNote>()
  for (const r of replies) {
    const id = r.id.toLowerCase()
    if (id !== focusedId && !byId.has(id)) {
      byId.set(id, r)
    }
  }

  const childrenByParent = new Map<string, AgoraNote[]>()
  const topLevel: AgoraNote[] = []

  const sorted = Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt)
  for (const reply of sorted) {
    const parentId = reply.replyToId?.toLowerCase()
    if (parentId && parentId !== focusedId && byId.has(parentId) && parentId !== reply.id.toLowerCase()) {
      const list = childrenByParent.get(parentId) ?? []
      list.push(reply)
      childrenByParent.set(parentId, list)
    } else {
      topLevel.push(reply)
    }
  }

  const visited = new Set<string>()

  const buildNode = (note: AgoraNote, depth: number): AgoraReplyTreeNode => {
    const id = note.id.toLowerCase()
    visited.add(id)
    const directChildren = childrenByParent.get(id) ?? []
    const childNodes: AgoraReplyTreeNode[] = []
    for (const child of directChildren) {
      if (visited.has(child.id.toLowerCase())) continue
      childNodes.push(buildNode(child, Math.min(MAX_REPLY_TREE_DEPTH, depth + 1)))
    }
    return {
      note,
      depth: Math.min(MAX_REPLY_TREE_DEPTH, depth),
      children: childNodes,
    }
  }

  const roots: AgoraReplyTreeNode[] = []
  for (const note of topLevel) {
    if (visited.has(note.id.toLowerCase())) continue
    roots.push(buildNode(note, 0))
  }
  // Recover any orphaned cyclic nodes so no reply is ever silently dropped
  for (const note of sorted) {
    if (!visited.has(note.id.toLowerCase())) {
      roots.push(buildNode(note, 0))
    }
  }

  return roots
}

/**
 * Collapses burst same-kind likes, reposts, and zaps on the same target note within 24h
 * while preserving replies and mentions as individual entries.
 */
export function groupAgoraNotifications(
  notifications: readonly AgoraNotification[]
): AgoraGroupedNotification[] {
  if (notifications.length === 0) return []

  const sorted = [...notifications].sort((a, b) => b.createdAt - a.createdAt)
  const groups: AgoraGroupedNotification[] = []

  for (const item of sorted) {
    const groupable =
      (item.kind === 'like' || item.kind === 'repost' || item.kind === 'zap') &&
      Boolean(item.targetNoteId)

    if (!groupable) {
      groups.push({
        key: item.id,
        kind: item.kind,
        actors: [item.actorPubkey],
        count: 1,
        createdAt: item.createdAt,
        noteId: item.noteId,
        targetNoteId: item.targetNoteId,
        content: item.content,
        totalZapSats: item.zapSats,
        items: [item],
      })
      continue
    }

    const match = groups.find(
      (g) =>
        g.kind === item.kind &&
        g.targetNoteId === item.targetNoteId &&
        Math.abs(g.createdAt - item.createdAt) <= NOTIFICATION_GROUP_WINDOW_SEC
    )

    if (match) {
      match.items.push(item)
      if (!match.actors.includes(item.actorPubkey)) {
        match.actors.push(item.actorPubkey)
      }
      if (item.createdAt > match.createdAt) {
        match.createdAt = item.createdAt
      }
      if (item.kind === 'zap') {
        match.totalZapSats = (match.totalZapSats ?? 0) + (item.zapSats ?? 0)
        match.count = match.items.length
      } else {
        match.count = match.actors.length
      }
    } else {
      groups.push({
        key: `${item.kind}:${item.targetNoteId}:${item.id}`,
        kind: item.kind,
        actors: [item.actorPubkey],
        count: 1,
        createdAt: item.createdAt,
        noteId: item.noteId,
        targetNoteId: item.targetNoteId,
        content: item.content,
        totalZapSats: item.kind === 'zap' ? item.zapSats ?? 0 : undefined,
        items: [item],
      })
    }
  }

  return groups.sort((a, b) => b.createdAt - a.createdAt)
}

/* --------------------------------------------------------------------------
   Auto-Saved Drafts, Feed Cache & Density Preference Persistence
   -------------------------------------------------------------------------- */

function loadAllDrafts(): Record<string, AgoraDraftPayload> {
  const raw = safeGetStorage(AGORA_DRAFTS_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, AgoraDraftPayload> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      const d = v as Partial<AgoraDraftPayload>
      const text = typeof d.text === 'string' ? d.text : ''
      const uploads = Array.isArray(d.uploads)
        ? (d.uploads.filter(
            (u): u is AgoraUploadedMedia =>
              Boolean(u && typeof u === 'object' && typeof (u as AgoraUploadedMedia).url === 'string')
          ) as AgoraUploadedMedia[])
        : []
      const threadParts = Array.isArray(d.threadParts)
        ? d.threadParts.filter((p): p is string => typeof p === 'string').slice(0, 8)
        : undefined
      out[k] = {
        text,
        uploads: uploads.slice(0, 4),
        cwEnabled: Boolean(d.cwEnabled),
        cwReason: typeof d.cwReason === 'string' ? d.cwReason.slice(0, 120) : '',
        ...(threadParts ? { threadParts } : {}),
        updatedAt: typeof d.updatedAt === 'number' && Number.isFinite(d.updatedAt) ? d.updatedAt : 0,
      }
    }
    return out
  } catch {
    return {}
  }
}

export function loadAgoraDraft(key: string): AgoraDraftPayload | null {
  const cleanKey = key.trim()
  if (!cleanKey) return null
  return loadAllDrafts()[cleanKey] ?? null
}

export function saveAgoraDraft(key: string, draft: AgoraDraftPayload): void {
  const cleanKey = key.trim()
  if (!cleanKey) return
  const all = loadAllDrafts()
  all[cleanKey] = {
    text: typeof draft.text === 'string' ? draft.text : '',
    uploads: Array.isArray(draft.uploads) ? draft.uploads.slice(0, 4) : [],
    cwEnabled: Boolean(draft.cwEnabled),
    cwReason: typeof draft.cwReason === 'string' ? draft.cwReason.slice(0, 120) : '',
    ...(Array.isArray(draft.threadParts) ? { threadParts: draft.threadParts.slice(0, 8) } : {}),
    updatedAt: draft.updatedAt || Date.now(),
  }
  const trimmed = Object.entries(all)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_CACHED_DRAFTS)
  safeSetStorage(AGORA_DRAFTS_KEY, JSON.stringify(Object.fromEntries(trimmed)))
}

export function clearAgoraDraft(key: string): void {
  const cleanKey = key.trim()
  if (!cleanKey) return
  const all = loadAllDrafts()
  if (!(cleanKey in all)) return
  delete all[cleanKey]
  safeSetStorage(AGORA_DRAFTS_KEY, JSON.stringify(all))
}

interface StoredCachedFeedEntry {
  key: string
  kind: 'note' | 'repost'
  rawEvent: NostrEvent
  repostedBy?: string
  repostedByList?: string[]
  repostedAt?: number
  sortAt: number
}

interface StoredFeedCachePayload {
  following?: StoredCachedFeedEntry[]
  global?: StoredCachedFeedEntry[]
}

export function loadCachedFeed(tab: 'following' | 'global'): AgoraFeedItem[] {
  const raw = safeGetStorage(AGORA_FEED_CACHE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as StoredFeedCachePayload
    const list = parsed?.[tab]
    if (!Array.isArray(list)) return []
    const out: AgoraFeedItem[] = []
    for (const entry of list.slice(0, MAX_FEED_CACHE_ITEMS)) {
      if (!entry || typeof entry !== 'object' || !entry.rawEvent) continue
      const note = parseAgoraNote(entry.rawEvent)
      if (!note) continue
      const repostedBy =
        typeof entry.repostedBy === 'string' && isHex64(entry.repostedBy)
          ? entry.repostedBy.toLowerCase()
          : undefined
      const repostedByList = Array.isArray(entry.repostedByList)
        ? entry.repostedByList
            .filter((p): p is string => typeof p === 'string' && isHex64(p))
            .map((p) => p.toLowerCase())
        : undefined
      const sortAt =
        typeof entry.sortAt === 'number' && Number.isFinite(entry.sortAt)
          ? entry.sortAt
          : note.createdAt
      out.push({
        key: typeof entry.key === 'string' && entry.key ? entry.key : `note:${note.id}`,
        kind: entry.kind === 'repost' && repostedBy ? 'repost' : 'note',
        note,
        ...(repostedBy ? { repostedBy } : {}),
        ...(repostedByList && repostedByList.length > 0 ? { repostedByList } : {}),
        ...(typeof entry.repostedAt === 'number' ? { repostedAt: entry.repostedAt } : {}),
        sortAt,
      })
    }
    return deduplicateFeedItems(out)
  } catch {
    return []
  }
}

export function saveCachedFeed(
  tab: 'following' | 'global',
  items: readonly AgoraFeedItem[]
): void {
  let current: StoredFeedCachePayload = {}
  const raw = safeGetStorage(AGORA_FEED_CACHE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as StoredFeedCachePayload
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        current = parsed
      }
    } catch {
      current = {}
    }
  }

  current[tab] = items.slice(0, MAX_FEED_CACHE_ITEMS).map((item) => ({
    key: item.key,
    kind: item.kind,
    rawEvent: item.note.rawEvent,
    ...(item.repostedBy ? { repostedBy: item.repostedBy } : {}),
    ...(item.repostedByList && item.repostedByList.length > 0
      ? { repostedByList: item.repostedByList.slice(0, 12) }
      : {}),
    ...(typeof item.repostedAt === 'number' ? { repostedAt: item.repostedAt } : {}),
    sortAt: item.sortAt,
  }))

  safeSetStorage(AGORA_FEED_CACHE_KEY, JSON.stringify(current))
}

export function loadAgoraDensity(): AgoraDensity {
  const raw = safeGetStorage(AGORA_DENSITY_KEY)
  return raw === 'compact' ? 'compact' : 'comfortable'
}

export function saveAgoraDensity(density: AgoraDensity): void {
  safeSetStorage(AGORA_DENSITY_KEY, density === 'compact' ? 'compact' : 'comfortable')
}
