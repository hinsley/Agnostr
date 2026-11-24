import {
  nip19,
  verifyEvent,
  type Event as NostrEvent,
  type EventTemplate,
} from 'nostr-tools'
import type {
  AgoraContentToken,
  AgoraJumpTarget,
  AgoraMediaItem,
  AgoraNip65RelayList,
  AgoraNote,
  AgoraNoteStats,
  AgoraProfile,
  AgoraProfileDraft,
  AgoraUploadedMedia,
  AgoraZapReceipt,
} from '../types/agora.ts'
import { normalizeRelayUrl } from './geoRelays.ts'
import { encodeNpubSafe } from './identity.ts'
import {
  decodeBolt11AmountSats,
  normalizeLightningAddress,
  parseZapReceiptEvent,
} from './zaps.ts'

export const KIND_AGORA_PROFILE = 0
export const KIND_AGORA_NOTE = 1
export const KIND_AGORA_FOLLOW_LIST = 3
export const KIND_AGORA_DELETE = 5
export const KIND_AGORA_REPOST = 6
export const KIND_AGORA_REACTION = 7
export const KIND_AGORA_ZAP_RECEIPT = 9735
export const KIND_AGORA_RELAY_LIST = 10002
export const KIND_AGORA_BOOKMARK_LIST = 10003

export const AGORA_SOCIAL_RELAYS: readonly string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://offchain.pub',
  'wss://nostr.bitcoiner.social',
  'wss://relay.snort.social',
  'wss://nostr.mom',
]

export const AGORA_PROFILE_RELAYS: readonly string[] = [
  'wss://purplepag.es',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://offchain.pub',
]

export const AGORA_SEARCH_RELAYS: readonly string[] = [
  'wss://search.nos.today',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
]

export const EMPTY_NOTE_STATS: AgoraNoteStats = Object.freeze({
  likes: 0,
  likedByMe: false,
  reposts: 0,
  repostedByMe: false,
  replies: 0,
  zapSats: 0,
  zapCount: 0,
  zappedByMe: false,
})

const HEX64_REGEX = /^[0-9a-f]{64}$/i
const IMAGE_EXT_REGEX = /\.(?:jpe?g|png|gif|webp|avif|bmp)(?:$|[?#])/i
const VIDEO_EXT_REGEX = /\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])/i
const HASHTAG_SCAN_REGEX = /(?:^|[^\p{L}\p{N}_/])#([\p{L}\p{N}_-]{1,48})/gu
const NOSTR_URI_SCAN_REGEX =
  /\bnostr:((?:npub|nprofile|note|nevent|naddr)1[02-9ac-hj-np-z]+)\b/gi
const HTTP_URL_SCAN_REGEX = /https?:\/\/[^\s<>"'`]+/gi
const COMBINED_TOKEN_REGEX =
  /(https?:\/\/[^\s<>"'`]+)|(\bnostr:(?:npub|nprofile|note|nevent|naddr)1[02-9ac-hj-np-z]+\b)|((?:^|[\s([{"'])#([\p{L}\p{N}_-]{1,48}))/giu

export function isHex64(value: unknown): boolean {
  return typeof value === 'string' && HEX64_REGEX.test(value)
}

export function sanitizeHttpUrl(raw: unknown, allowBareDomain = false): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 2048) return undefined
  const candidate =
    allowBareDomain && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && /^[a-z0-9.-]+\.[a-z]{2,}/i.test(trimmed)
      ? `https://${trimmed}`
      : trimmed
  try {
    const parsed = new URL(candidate)
    const proto = parsed.protocol.toLowerCase()
    if (proto !== 'https:' && proto !== 'http:') return undefined
    if (!parsed.hostname) return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

export function normalizeHashtag(raw: string): string | null {
  const cleaned = raw.trim().replace(/^#+/, '').toLowerCase()
  if (!cleaned || cleaned.length > 48) return null
  if (!/^[\p{L}\p{N}_-]+$/u.test(cleaned)) return null
  return cleaned
}

function trimUrlTrailingPunctuation(rawUrl: string): { url: string; trailing: string } {
  let url = rawUrl
  let trailing = ''
  while (url.length > 0) {
    const last = url[url.length - 1]
    if (last === ')' || last === ']' || last === '}') {
      const open = last === ')' ? '(' : last === ']' ? '[' : '{'
      let opens = 0
      let closes = 0
      for (let i = 0; i < url.length; i += 1) {
        if (url[i] === open) opens += 1
        else if (url[i] === last) closes += 1
      }
      if (closes > opens) {
        trailing = last + trailing
        url = url.slice(0, -1)
        continue
      }
      break
    }
    if (last === '.' || last === ',' || last === '!' || last === '?' || last === ';' || last === ':' || last === "'" || last === '"') {
      trailing = last + trailing
      url = url.slice(0, -1)
      continue
    }
    break
  }
  return { url, trailing }
}

export function detectMediaKindFromUrl(url: string, mime?: string): 'image' | 'video' | null {
  const cleanMime = (mime ?? '').split(';')[0].trim().toLowerCase()
  if (cleanMime.startsWith('image/')) return 'image'
  if (cleanMime.startsWith('video/')) return 'video'
  if (IMAGE_EXT_REGEX.test(url)) return 'image'
  if (VIDEO_EXT_REGEX.test(url)) return 'video'
  return null
}

function formatLinkDisplay(url: string): string {
  const stripped = url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (stripped.length <= 48) return stripped
  return `${stripped.slice(0, 45)}…`
}

/* --------------------------------------------------------------------------
   NIP-01 Profile Metadata (kind: 0)
   -------------------------------------------------------------------------- */

export function parseAgoraProfile(event: NostrEvent): AgoraProfile | null {
  if (!event || event.kind !== KIND_AGORA_PROFILE || !isHex64(event.pubkey)) return null
  const pk = event.pubkey.toLowerCase()

  let rawJson: Record<string, unknown> = {}
  if (typeof event.content === 'string' && event.content.trim()) {
    try {
      const parsed = JSON.parse(event.content) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rawJson = parsed as Record<string, unknown>
      } else {
        return null
      }
    } catch {
      return null
    }
  }

  const pickStr = (value: unknown, maxLen: number): string | undefined => {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed ? trimmed.slice(0, maxLen) : undefined
  }

  const name = pickStr(rawJson.name, 80)
  const displayName = pickStr(rawJson.display_name ?? rawJson.displayName, 80)
  const about = pickStr(rawJson.about, 1200)
  const picture = sanitizeHttpUrl(rawJson.picture)
  const banner = sanitizeHttpUrl(rawJson.banner)
  const nip05 = pickStr(rawJson.nip05, 160)
  const rawLud16 = pickStr(rawJson.lud16, 160)
  const lud16 = normalizeLightningAddress(rawLud16) ?? rawLud16
  const website = sanitizeHttpUrl(rawJson.website, true)

  return {
    pubkey: pk,
    npub: encodeNpubSafe(pk),
    name,
    displayName,
    about,
    picture,
    banner,
    nip05,
    lud16,
    website,
    updatedAt: Number.isFinite(event.created_at) ? event.created_at : 0,
    rawJson,
  }
}

export function buildProfileMetadataTemplate(
  draft: AgoraProfileDraft,
  existingRawJson?: Record<string, unknown> | null
): EventTemplate {
  const payload: Record<string, unknown> = { ...(existingRawJson ?? {}) }

  const applyField = (key: string, value: string | undefined, maxLen: number) => {
    if (value === undefined) return
    const trimmed = value.trim()
    if (trimmed) {
      payload[key] = trimmed.slice(0, maxLen)
    } else {
      delete payload[key]
    }
  }

  applyField('name', draft.name, 80)
  if (draft.displayName !== undefined) {
    const trimmed = draft.displayName.trim()
    delete payload.displayName
    if (trimmed) {
      payload.display_name = trimmed.slice(0, 80)
    } else {
      delete payload.display_name
    }
  }
  applyField('about', draft.about, 1200)
  applyField('nip05', draft.nip05, 160)

  if (draft.picture !== undefined) {
    const clean = sanitizeHttpUrl(draft.picture)
    if (clean) payload.picture = clean
    else delete payload.picture
  }
  if (draft.banner !== undefined) {
    const clean = sanitizeHttpUrl(draft.banner)
    if (clean) payload.banner = clean
    else delete payload.banner
  }
  if (draft.website !== undefined) {
    const clean = sanitizeHttpUrl(draft.website, true)
    if (clean) payload.website = clean
    else delete payload.website
  }
  if (draft.lud16 !== undefined) {
    const trimmed = draft.lud16.trim()
    if (!trimmed) {
      delete payload.lud16
    } else {
      const normalized = normalizeLightningAddress(trimmed)
      if (normalized && normalized.includes('@')) {
        payload.lud16 = normalized
      } else {
        payload.lud16 = trimmed.slice(0, 160)
      }
    }
  }

  return {
    kind: KIND_AGORA_PROFILE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(payload),
  }
}

export function getProfileDisplayName(
  profile: AgoraProfile | null | undefined,
  pubkey: string
): string {
  const display = profile?.displayName?.trim()
  if (display) return display
  const name = profile?.name?.trim()
  if (name) return name
  const pk = pubkey.toLowerCase()
  return `agnon${pk.slice(-4)}`
}

/* --------------------------------------------------------------------------
   NIP-19 Helpers & Jump Targets
   -------------------------------------------------------------------------- */

export function encodeNoteEventId(
  noteId: string,
  authorPubkey?: string,
  relays?: string[]
): string {
  const cleanId = noteId.trim().toLowerCase()
  if (!isHex64(cleanId)) return noteId
  try {
    const cleanAuthor = authorPubkey && isHex64(authorPubkey) ? authorPubkey.toLowerCase() : undefined
    const cleanRelays = relays
      ?.map((r) => normalizeRelayUrl(r))
      .filter((r): r is string => r !== null)
      .slice(0, 4)
    return nip19.neventEncode({
      id: cleanId,
      author: cleanAuthor,
      relays: cleanRelays && cleanRelays.length > 0 ? cleanRelays : undefined,
    })
  } catch {
    return cleanId
  }
}

export function parseAgoraJumpTarget(raw: string): AgoraJumpTarget | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('#')) {
    const tag = normalizeHashtag(trimmed)
    return tag ? { kind: 'hashtag', tag } : null
  }

  const stripped = trimmed.replace(/^nostr:/i, '').trim()
  if (!stripped) return null

  if (isHex64(stripped)) {
    return { kind: 'profile', pubkey: stripped.toLowerCase() }
  }

  const lower = stripped.toLowerCase()
  if (
    lower.startsWith('npub1') ||
    lower.startsWith('nprofile1') ||
    lower.startsWith('note1') ||
    lower.startsWith('nevent1')
  ) {
    try {
      const decoded = nip19.decode(stripped)
      if (decoded.type === 'npub' && isHex64(decoded.data)) {
        return { kind: 'profile', pubkey: decoded.data.toLowerCase() }
      }
      if (decoded.type === 'nprofile' && isHex64(decoded.data.pubkey)) {
        const relays = (decoded.data.relays ?? [])
          .map((r) => normalizeRelayUrl(r))
          .filter((r): r is string => r !== null)
        return {
          kind: 'profile',
          pubkey: decoded.data.pubkey.toLowerCase(),
          relays: relays.length > 0 ? relays : undefined,
        }
      }
      if (decoded.type === 'note' && isHex64(decoded.data)) {
        return { kind: 'note', eventId: decoded.data.toLowerCase() }
      }
      if (decoded.type === 'nevent' && isHex64(decoded.data.id)) {
        const relays = (decoded.data.relays ?? [])
          .map((r) => normalizeRelayUrl(r))
          .filter((r): r is string => r !== null)
        return {
          kind: 'note',
          eventId: decoded.data.id.toLowerCase(),
          authorPubkey:
            typeof decoded.data.author === 'string' && isHex64(decoded.data.author)
              ? decoded.data.author.toLowerCase()
              : undefined,
          relays: relays.length > 0 ? relays : undefined,
        }
      }
    } catch {
      return null
    }
  }

  return null
}

/* --------------------------------------------------------------------------
   NIP-01 / NIP-10 / NIP-18 / NIP-27 / NIP-36 / NIP-92 Notes (kind: 1)
   -------------------------------------------------------------------------- */

function parseImetaTags(tags: string[][]): AgoraMediaItem[] {
  const out: AgoraMediaItem[] = []
  const seen = new Set<string>()

  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== 'imeta') continue
    let url: string | undefined
    let mime: string | undefined
    let alt: string | undefined
    let dim: string | undefined

    for (let i = 1; i < tag.length; i += 1) {
      const entry = tag[i]
      if (typeof entry !== 'string') continue
      const spaceIdx = entry.indexOf(' ')
      if (spaceIdx <= 0) continue
      const key = entry.slice(0, spaceIdx).trim().toLowerCase()
      const val = entry.slice(spaceIdx + 1).trim()
      if (!val) continue
      if (key === 'url') url = sanitizeHttpUrl(val)
      else if (key === 'm') mime = val.split(';')[0].trim().toLowerCase()
      else if (key === 'alt') alt = val.slice(0, 280)
      else if (key === 'dim' && /^\d{1,5}x\d{1,5}$/i.test(val)) dim = val.toLowerCase()
    }

    if (!url || seen.has(url)) continue
    const kind = detectMediaKindFromUrl(url, mime)
    if (!kind) continue
    seen.add(url)
    out.push({ url, kind, mime, alt, dim })
    if (out.length >= 8) break
  }

  return out
}

function extractInlineMedia(content: string, existing: AgoraMediaItem[]): AgoraMediaItem[] {
  const out = [...existing]
  const seen = new Set(existing.map((m) => m.url))
  if (out.length >= 8) return out

  HTTP_URL_SCAN_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = HTTP_URL_SCAN_REGEX.exec(content)) !== null) {
    const { url: trimmedUrl } = trimUrlTrailingPunctuation(match[0])
    const clean = sanitizeHttpUrl(trimmedUrl)
    if (!clean || seen.has(clean)) continue
    const kind = detectMediaKindFromUrl(clean)
    if (!kind) continue
    seen.add(clean)
    out.push({ url: clean, kind })
    if (out.length >= 8) break
  }
  return out
}

function extractContentNostrRefs(content: string): {
  pubkeys: string[]
  eventIds: string[]
} {
  const pubkeys = new Set<string>()
  const eventIds = new Set<string>()

  NOSTR_URI_SCAN_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = NOSTR_URI_SCAN_REGEX.exec(content)) !== null) {
    const entity = match[1]
    if (!entity) continue
    try {
      const decoded = nip19.decode(entity)
      if (decoded.type === 'npub' && isHex64(decoded.data)) {
        pubkeys.add(decoded.data.toLowerCase())
      } else if (decoded.type === 'nprofile' && isHex64(decoded.data.pubkey)) {
        pubkeys.add(decoded.data.pubkey.toLowerCase())
      } else if (decoded.type === 'note' && isHex64(decoded.data)) {
        eventIds.add(decoded.data.toLowerCase())
      } else if (decoded.type === 'nevent' && isHex64(decoded.data.id)) {
        eventIds.add(decoded.data.id.toLowerCase())
      }
    } catch {
      // Ignore malformed bech32 entities
    }
  }

  return {
    pubkeys: Array.from(pubkeys),
    eventIds: Array.from(eventIds),
  }
}

export function parseAgoraNote(event: NostrEvent): AgoraNote | null {
  if (
    !event ||
    event.kind !== KIND_AGORA_NOTE ||
    !isHex64(event.id) ||
    !isHex64(event.pubkey) ||
    typeof event.content !== 'string' ||
    !Array.isArray(event.tags)
  ) {
    return null
  }

  const tags = event.tags.filter((t): t is string[] => Array.isArray(t) && t.length > 0)
  const content = event.content

  const quoteSet = new Set<string>()
  const mentionSet = new Set<string>()
  const hashtagSet = new Set<string>()
  const pTagPubkeys: string[] = []
  let contentWarning: string | undefined

  const eTags: string[][] = []

  for (const tag of tags) {
    const key = tag[0]
    if (key === 'e' && isHex64(tag[1])) {
      eTags.push(tag)
    } else if (key === 'q' && isHex64(tag[1])) {
      quoteSet.add(tag[1].toLowerCase())
    } else if (key === 'p' && isHex64(tag[1])) {
      const pk = tag[1].toLowerCase()
      mentionSet.add(pk)
      pTagPubkeys.push(pk)
    } else if (key === 't' && typeof tag[1] === 'string') {
      const clean = normalizeHashtag(tag[1])
      if (clean) hashtagSet.add(clean)
    } else if (key === 'content-warning') {
      const reason = typeof tag[1] === 'string' ? tag[1].trim() : ''
      contentWarning = reason || 'Sensitive content'
    }
  }

  // NIP-10 threading resolution (prefer explicit root/reply/mention markers)
  let rootId: string | undefined
  let replyToId: string | undefined
  let replyToPubkey: string | undefined
  let hasExplicitMarker = false

  for (const tag of eTags) {
    const id = tag[1].toLowerCase()
    const marker = typeof tag[3] === 'string' ? tag[3].trim().toLowerCase() : ''
    const authorHint =
      typeof tag[4] === 'string' && isHex64(tag[4]) ? tag[4].toLowerCase() : undefined

    if (marker === 'root' || marker === 'reply' || marker === 'mention') {
      hasExplicitMarker = true
    }
    if (marker === 'root' && !rootId) {
      rootId = id
      if (!replyToPubkey && authorHint) replyToPubkey = authorHint
    } else if (marker === 'reply') {
      replyToId = id
      if (authorHint) replyToPubkey = authorHint
    } else if (marker === 'mention') {
      quoteSet.add(id)
    }
  }

  if (hasExplicitMarker) {
    if (rootId && !replyToId) {
      replyToId = rootId
    } else if (replyToId && !rootId) {
      rootId = replyToId
    }
  } else if (eTags.length > 0) {
    // Deprecated positional NIP-10 fallback, excluding IDs tagged as NIP-18 quotes
    const positional = eTags
      .map((t) => t[1].toLowerCase())
      .filter((id) => !quoteSet.has(id))
    if (positional.length === 1) {
      rootId = positional[0]
      replyToId = positional[0]
    } else if (positional.length >= 2) {
      rootId = positional[0]
      replyToId = positional[positional.length - 1]
    }
  }

  const isReply = Boolean(replyToId || rootId)
  if (isReply && !replyToPubkey && pTagPubkeys.length > 0) {
    replyToPubkey = pTagPubkeys[pTagPubkeys.length - 1]
  }

  // Extract inline nostr: mentions/quotes & #hashtags from content
  const contentRefs = extractContentNostrRefs(content)
  for (const pk of contentRefs.pubkeys) mentionSet.add(pk)
  for (const evId of contentRefs.eventIds) quoteSet.add(evId)

  HASHTAG_SCAN_REGEX.lastIndex = 0
  let tagMatch: RegExpExecArray | null
  while ((tagMatch = HASHTAG_SCAN_REGEX.exec(content)) !== null) {
    const clean = normalizeHashtag(tagMatch[1] ?? '')
    if (clean) hashtagSet.add(clean)
  }

  const imetaMedia = parseImetaTags(tags)
  const media = extractInlineMedia(content, imetaMedia)

  return {
    id: event.id.toLowerCase(),
    pubkey: event.pubkey.toLowerCase(),
    createdAt: Number.isFinite(event.created_at) ? event.created_at : 0,
    content,
    tags,
    rootId,
    replyToId,
    replyToPubkey,
    mentionedPubkeys: Array.from(mentionSet),
    hashtags: Array.from(hashtagSet),
    quoteIds: Array.from(quoteSet),
    media,
    contentWarning,
    isReply,
    rawEvent: event,
  }
}

export interface BuildAgoraNoteParams {
  content: string
  replyTo?: AgoraNote | null
  quoteNote?: AgoraNote | null
  media?: readonly AgoraUploadedMedia[]
  contentWarning?: string
  hashtags?: readonly string[]
  relayHint?: string
}

export function buildAgoraNoteTemplate(params: BuildAgoraNoteParams): EventTemplate {
  let finalContent = params.content.trim()
  const tags: string[][] = []
  const relayHint = params.relayHint ? normalizeRelayUrl(params.relayHint) ?? '' : ''

  const pSet = new Set<string>()
  const qSet = new Set<string>()
  const tSet = new Set<string>()

  // Append uploaded Blossom media URLs + NIP-92 imeta tags
  if (params.media && params.media.length > 0) {
    for (const item of params.media) {
      const cleanUrl = sanitizeHttpUrl(item.url)
      if (!cleanUrl) continue
      if (!finalContent.includes(cleanUrl)) {
        finalContent = finalContent ? `${finalContent}\n${cleanUrl}` : cleanUrl
      }
      const imeta: string[] = ['imeta', `url ${cleanUrl}`]
      if (item.mime) imeta.push(`m ${item.mime}`)
      if (isHex64(item.sha256)) imeta.push(`x ${item.sha256.toLowerCase()}`)
      if (Number.isFinite(item.size) && item.size > 0) imeta.push(`size ${Math.round(item.size)}`)
      if (item.dim) imeta.push(`dim ${item.dim}`)
      if (item.alt?.trim()) imeta.push(`alt ${item.alt.trim().slice(0, 280)}`)
      tags.push(imeta)
    }
  }

  // NIP-10 reply tags
  if (params.replyTo) {
    const parent = params.replyTo
    if (parent.rootId && parent.rootId !== parent.id) {
      tags.push(['e', parent.rootId, relayHint, 'root'])
      tags.push(['e', parent.id, relayHint, 'reply', parent.pubkey])
    } else {
      tags.push(['e', parent.id, relayHint, 'root', parent.pubkey])
    }
    pSet.add(parent.pubkey)
    for (const pk of parent.mentionedPubkeys) {
      if (pSet.size >= 20) break
      pSet.add(pk)
    }
  }

  // NIP-18 quote note (`q` tag + inline `nostr:nevent1…`)
  if (params.quoteNote) {
    const quoted = params.quoteNote
    const nevent = encodeNoteEventId(
      quoted.id,
      quoted.pubkey,
      relayHint ? [relayHint] : undefined
    )
    const existingRefs = extractContentNostrRefs(finalContent)
    if (!existingRefs.eventIds.includes(quoted.id)) {
      finalContent = finalContent ? `${finalContent}\nnostr:${nevent}` : `nostr:${nevent}`
    }
    qSet.add(quoted.id)
    tags.push(['q', quoted.id, relayHint, quoted.pubkey])
    pSet.add(quoted.pubkey)
  }

  // Inline nostr: mentions & quotes from content
  const refs = extractContentNostrRefs(finalContent)
  for (const pk of refs.pubkeys) pSet.add(pk)
  for (const evId of refs.eventIds) {
    if (!qSet.has(evId)) {
      qSet.add(evId)
      tags.push(['q', evId, relayHint])
    }
  }

  for (const pk of pSet) {
    tags.push(['p', pk])
  }

  // Hashtags from content + explicit hashtags
  HASHTAG_SCAN_REGEX.lastIndex = 0
  let tagMatch: RegExpExecArray | null
  while ((tagMatch = HASHTAG_SCAN_REGEX.exec(finalContent)) !== null) {
    const clean = normalizeHashtag(tagMatch[1] ?? '')
    if (clean) tSet.add(clean)
  }
  if (params.hashtags) {
    for (const rawTag of params.hashtags) {
      const clean = normalizeHashtag(rawTag)
      if (clean) tSet.add(clean)
    }
  }
  for (const t of tSet) {
    tags.push(['t', t])
  }

  // NIP-36 content warning
  const cw = params.contentWarning?.trim()
  if (cw) {
    tags.push(['content-warning', cw.slice(0, 120)])
  }

  return {
    kind: KIND_AGORA_NOTE,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: finalContent,
  }
}

/* --------------------------------------------------------------------------
   NIP-18 Reposts (kind: 6)
   -------------------------------------------------------------------------- */

export interface ParsedAgoraRepost {
  id: string
  repostedBy: string
  repostedAt: number
  targetNoteId: string
  targetAuthorPubkey?: string
  embeddedNote: AgoraNote | null
}

export function parseAgoraRepost(event: NostrEvent): ParsedAgoraRepost | null {
  if (
    !event ||
    event.kind !== KIND_AGORA_REPOST ||
    !isHex64(event.id) ||
    !isHex64(event.pubkey) ||
    !Array.isArray(event.tags)
  ) {
    return null
  }

  let targetNoteId: string | undefined
  let targetAuthorPubkey: string | undefined
  for (const tag of event.tags) {
    if (!Array.isArray(tag)) continue
    if (tag[0] === 'e' && isHex64(tag[1]) && !targetNoteId) {
      targetNoteId = tag[1].toLowerCase()
    } else if (tag[0] === 'p' && isHex64(tag[1]) && !targetAuthorPubkey) {
      targetAuthorPubkey = tag[1].toLowerCase()
    }
  }

  let embeddedNote: AgoraNote | null = null
  if (typeof event.content === 'string' && event.content.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(event.content) as NostrEvent
      if (
        parsed &&
        parsed.kind === KIND_AGORA_NOTE &&
        isHex64(parsed.id) &&
        isHex64(parsed.pubkey) &&
        typeof parsed.sig === 'string' &&
        verifyEvent(parsed)
      ) {
        embeddedNote = parseAgoraNote(parsed)
        if (embeddedNote) {
          if (!targetNoteId) targetNoteId = embeddedNote.id
          if (!targetAuthorPubkey) targetAuthorPubkey = embeddedNote.pubkey
          if (targetNoteId !== embeddedNote.id) {
            // Mismatched embedded event vs e-tag — ignore untrusted payload
            embeddedNote = null
          }
        }
      }
    } catch {
      // Malformed or empty embedded JSON is valid per NIP-18; caller can fetch via ensureNotes
    }
  }

  if (!targetNoteId) return null

  return {
    id: event.id.toLowerCase(),
    repostedBy: event.pubkey.toLowerCase(),
    repostedAt: Number.isFinite(event.created_at) ? event.created_at : 0,
    targetNoteId,
    targetAuthorPubkey,
    embeddedNote,
  }
}

export function buildRepostTemplate(note: AgoraNote, relayHint?: string): EventTemplate {
  const hint = relayHint ? normalizeRelayUrl(relayHint) ?? '' : ''
  return {
    kind: KIND_AGORA_REPOST,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', note.id, hint],
      ['p', note.pubkey],
    ],
    content: JSON.stringify(note.rawEvent),
  }
}

/* --------------------------------------------------------------------------
   NIP-25 Reactions (kind: 7) & NIP-09 Deletion (kind: 5)
   -------------------------------------------------------------------------- */

export function buildReactionLikeTemplate(note: AgoraNote): EventTemplate {
  return {
    kind: KIND_AGORA_REACTION,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', note.id],
      ['p', note.pubkey],
      ['k', String(KIND_AGORA_NOTE)],
    ],
    content: '+',
  }
}

export function buildDeletionTemplate(eventId: string, kind: number): EventTemplate {
  return {
    kind: KIND_AGORA_DELETE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', eventId.toLowerCase()],
      ['k', String(kind)],
    ],
    content: '',
  }
}

/* --------------------------------------------------------------------------
   NIP-02 Follow List (kind: 3)
   -------------------------------------------------------------------------- */

export interface ParsedFollowList {
  pubkeys: string[]
  updatedAt: number
  rawTags: string[][]
}

export function parseFollowList(event: NostrEvent): ParsedFollowList | null {
  if (!event || event.kind !== KIND_AGORA_FOLLOW_LIST || !Array.isArray(event.tags)) {
    return null
  }
  const seen = new Set<string>()
  const pubkeys: string[] = []
  const rawTags: string[][] = []
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length === 0) continue
    rawTags.push([...tag])
    if (tag[0] === 'p' && isHex64(tag[1])) {
      const pk = tag[1].toLowerCase()
      if (!seen.has(pk)) {
        seen.add(pk)
        pubkeys.push(pk)
      }
    }
  }
  return {
    pubkeys,
    updatedAt: Number.isFinite(event.created_at) ? event.created_at : 0,
    rawTags,
  }
}

export function buildFollowListTemplate(
  pubkeys: readonly string[],
  existingEvent?: NostrEvent | null
): EventTemplate {
  const existingPTags = new Map<string, string[]>()
  const preservedOtherTags: string[][] = []

  if (existingEvent && Array.isArray(existingEvent.tags)) {
    for (const tag of existingEvent.tags) {
      if (!Array.isArray(tag) || tag.length === 0) continue
      if (tag[0] === 'p' && isHex64(tag[1])) {
        const pk = tag[1].toLowerCase()
        if (!existingPTags.has(pk)) {
          existingPTags.set(pk, [...tag])
        }
      } else {
        preservedOtherTags.push([...tag])
      }
    }
  }

  const tags: string[][] = [...preservedOtherTags]
  const seen = new Set<string>()
  for (const rawPk of pubkeys) {
    if (!isHex64(rawPk)) continue
    const pk = rawPk.toLowerCase()
    if (seen.has(pk)) continue
    seen.add(pk)
    const prev = existingPTags.get(pk)
    if (prev) {
      tags.push(prev)
    } else {
      tags.push(['p', pk])
    }
  }

  return {
    kind: KIND_AGORA_FOLLOW_LIST,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: typeof existingEvent?.content === 'string' ? existingEvent.content : '',
  }
}

/* --------------------------------------------------------------------------
   NIP-51 Bookmark List (kind: 10003)
   -------------------------------------------------------------------------- */

export interface ParsedBookmarkList {
  noteIds: string[]
  updatedAt: number
  rawTags: string[][]
}

export function parseBookmarkList(event: NostrEvent): ParsedBookmarkList | null {
  if (!event || event.kind !== KIND_AGORA_BOOKMARK_LIST || !Array.isArray(event.tags)) {
    return null
  }
  const seen = new Set<string>()
  const noteIds: string[] = []
  const rawTags: string[][] = []

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length === 0) continue
    rawTags.push([...tag])
    if (tag[0] === 'e' && isHex64(tag[1])) {
      const id = tag[1].toLowerCase()
      if (!seen.has(id)) {
        seen.add(id)
        noteIds.push(id)
      }
    }
  }

  return {
    noteIds,
    updatedAt: Number.isFinite(event.created_at) ? event.created_at : 0,
    rawTags,
  }
}

export function buildBookmarkListTemplate(
  noteIds: readonly string[],
  existingEvent?: NostrEvent | null
): EventTemplate {
  const preservedOtherTags: string[][] = []
  if (existingEvent && Array.isArray(existingEvent.tags)) {
    for (const tag of existingEvent.tags) {
      if (!Array.isArray(tag) || tag.length === 0) continue
      if (tag[0] !== 'e') {
        preservedOtherTags.push([...tag])
      }
    }
  }

  const tags: string[][] = [...preservedOtherTags]
  const seen = new Set<string>()
  for (const rawId of noteIds) {
    if (!isHex64(rawId)) continue
    const id = rawId.toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    tags.push(['e', id])
  }

  return {
    kind: KIND_AGORA_BOOKMARK_LIST,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: typeof existingEvent?.content === 'string' ? existingEvent.content : '',
  }
}

/* --------------------------------------------------------------------------
   NIP-65 Relay List Metadata (kind: 10002)
   -------------------------------------------------------------------------- */

export function parseNip65RelayList(event: NostrEvent): AgoraNip65RelayList | null {
  if (!event || event.kind !== KIND_AGORA_RELAY_LIST || !Array.isArray(event.tags)) {
    return null
  }
  const readSet = new Set<string>()
  const writeSet = new Set<string>()
  const allSet = new Set<string>()

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag[0] !== 'r' || typeof tag[1] !== 'string') continue
    const url = normalizeRelayUrl(tag[1])
    if (!url) continue
    const marker = typeof tag[2] === 'string' ? tag[2].trim().toLowerCase() : ''
    allSet.add(url)
    if (marker === 'read') {
      readSet.add(url)
    } else if (marker === 'write') {
      writeSet.add(url)
    } else {
      readSet.add(url)
      writeSet.add(url)
    }
  }

  return {
    read: Array.from(readSet).slice(0, 12),
    write: Array.from(writeSet).slice(0, 12),
    all: Array.from(allSet).slice(0, 16),
    updatedAt: Number.isFinite(event.created_at) ? event.created_at : 0,
  }
}

/* --------------------------------------------------------------------------
   NIP-57 Zap Receipts (kind: 9735)
   -------------------------------------------------------------------------- */

export function parseZapReceipt(event: NostrEvent): AgoraZapReceipt | null {
  if (!event || event.kind !== KIND_AGORA_ZAP_RECEIPT) return null
  const parsed = parseZapReceiptEvent(event)
  if (parsed) {
    return {
      id: parsed.id.toLowerCase(),
      senderPubkey: parsed.senderPubkey?.toLowerCase(),
      recipientPubkey: parsed.recipientPubkey.toLowerCase(),
      targetEventId: parsed.targetEventId?.toLowerCase(),
      amountSats: parsed.amountSats,
      comment: parsed.comment,
      createdAt: parsed.createdAt,
    }
  }

  // Fallback: direct BOLT-11 decode if receipt omitted standard description JSON
  if (!isHex64(event.id) || !Array.isArray(event.tags)) return null
  let bolt11: string | undefined
  let recipientPubkey: string | undefined
  let targetEventId: string | undefined
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || typeof tag[1] !== 'string') continue
    if (tag[0] === 'bolt11' && !bolt11) bolt11 = tag[1]
    else if (tag[0] === 'p' && isHex64(tag[1]) && !recipientPubkey) {
      recipientPubkey = tag[1].toLowerCase()
    } else if (tag[0] === 'e' && isHex64(tag[1]) && !targetEventId) {
      targetEventId = tag[1].toLowerCase()
    }
  }
  const amountSats = bolt11 ? decodeBolt11AmountSats(bolt11) ?? 0 : 0
  if (!recipientPubkey || amountSats <= 0) return null

  return {
    id: event.id.toLowerCase(),
    recipientPubkey,
    targetEventId,
    amountSats,
    createdAt: Number.isFinite(event.created_at) ? event.created_at : 0,
  }
}

/* --------------------------------------------------------------------------
   NIP-27 Safe Content Tokenizer (strips inline media URLs captured in media)
   -------------------------------------------------------------------------- */

export function tokenizeAgoraContent(
  content: string,
  media?: readonly AgoraMediaItem[]
): AgoraContentToken[] {
  if (!content) return []

  const mediaUrlSet = new Set<string>()
  if (media) {
    for (const m of media) {
      if (m.url) mediaUrlSet.add(m.url)
    }
  }

  const rawTokens: AgoraContentToken[] = []
  const pushText = (text: string) => {
    if (!text) return
    const prev = rawTokens[rawTokens.length - 1]
    if (prev && prev.type === 'text') {
      prev.text += text
    } else {
      rawTokens.push({ type: 'text', text })
    }
  }

  COMBINED_TOKEN_REGEX.lastIndex = 0
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = COMBINED_TOKEN_REGEX.exec(content)) !== null) {
    const start = match.index
    if (start > cursor) {
      pushText(content.slice(cursor, start))
    }

    const urlMatch = match[1]
    const nostrMatch = match[2]
    const hashFullMatch = match[3]
    const hashTagGroup = match[4]

    if (urlMatch) {
      const { url: trimmedUrl, trailing } = trimUrlTrailingPunctuation(urlMatch)
      const cleanUrl = sanitizeHttpUrl(trimmedUrl)
      if (cleanUrl) {
        const isCapturedMedia =
          mediaUrlSet.has(cleanUrl) ||
          mediaUrlSet.has(trimmedUrl) ||
          detectMediaKindFromUrl(cleanUrl) !== null
        if (!isCapturedMedia) {
          rawTokens.push({
            type: 'link',
            url: cleanUrl,
            display: formatLinkDisplay(cleanUrl),
          })
        }
        pushText(trailing)
      } else {
        pushText(urlMatch)
      }
    } else if (nostrMatch) {
      const entity = nostrMatch.slice('nostr:'.length)
      let pushed = false
      try {
        const decoded = nip19.decode(entity)
        if (decoded.type === 'npub' && isHex64(decoded.data)) {
          rawTokens.push({
            type: 'mention',
            pubkey: decoded.data.toLowerCase(),
            raw: nostrMatch,
          })
          pushed = true
        } else if (decoded.type === 'nprofile' && isHex64(decoded.data.pubkey)) {
          rawTokens.push({
            type: 'mention',
            pubkey: decoded.data.pubkey.toLowerCase(),
            raw: nostrMatch,
            relays: decoded.data.relays?.filter((r) => typeof r === 'string'),
          })
          pushed = true
        } else if (decoded.type === 'note' && isHex64(decoded.data)) {
          rawTokens.push({
            type: 'quote',
            eventId: decoded.data.toLowerCase(),
            raw: nostrMatch,
          })
          pushed = true
        } else if (decoded.type === 'nevent' && isHex64(decoded.data.id)) {
          rawTokens.push({
            type: 'quote',
            eventId: decoded.data.id.toLowerCase(),
            raw: nostrMatch,
            authorPubkey:
              typeof decoded.data.author === 'string' && isHex64(decoded.data.author)
                ? decoded.data.author.toLowerCase()
                : undefined,
            relays: decoded.data.relays?.filter((r) => typeof r === 'string'),
          })
          pushed = true
        }
      } catch {
        pushed = false
      }
      if (!pushed) {
        pushText(nostrMatch)
      }
    } else if (hashFullMatch && hashTagGroup) {
      const hashIdx = hashFullMatch.indexOf('#')
      if (hashIdx > 0) {
        pushText(hashFullMatch.slice(0, hashIdx))
      }
      const rawTag = hashFullMatch.slice(hashIdx)
      const cleanTag = normalizeHashtag(hashTagGroup)
      if (cleanTag) {
        rawTokens.push({ type: 'hashtag', tag: cleanTag, raw: rawTag })
      } else {
        pushText(rawTag)
      }
    }

    cursor = start + match[0].length
  }

  if (cursor < content.length) {
    pushText(content.slice(cursor))
  }

  // Collapse excess whitespace left behind by stripped inline media URLs
  const cleaned: AgoraContentToken[] = []
  for (let i = 0; i < rawTokens.length; i += 1) {
    const tok = rawTokens[i]
    if (tok.type !== 'text') {
      cleaned.push(tok)
      continue
    }
    let text = tok.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    if (i === 0) text = text.replace(/^\s+/, '')
    if (i === rawTokens.length - 1) text = text.replace(/\s+$/, '')
    if (text) cleaned.push({ type: 'text', text })
  }

  return cleaned
}
