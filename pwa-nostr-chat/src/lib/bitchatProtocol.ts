import { sha256 } from '@noble/hashes/sha256'
import { verifyEvent, type Event as NostrEvent, type EventTemplate } from 'nostr-tools'
import type {
  GeoMessage,
  ImageAttachment,
  LocationNote,
  ReplyReference,
  VoiceMemoAttachment,
} from '../types/protocol.ts'
import { isValidGeohash, normalizeGeohash } from './geohash.ts'
import { bytesToHex, formatDisplayHandle } from './identity.ts'
import { isOffMainThreadWorkerSupported, mineNip13OffMainThread } from './offMainThread.ts'
import {
  getTopicSlug,
  isTopicChannel,
  normalizeRadioChannelKey,
  normalizeTopicSlug,
  TOPIC_CHANNEL_PREFIX,
} from './radioChannel.ts'

export const KIND_LOCATION_NOTE = 1
export const KIND_SEAL = 13
export const KIND_DM_RUMOR = 14
export const KIND_GIFT_WRAP = 1059
export const KIND_GEOHASH_CHAT = 20000
export const KIND_GEOHASH_PRESENCE = 20001
export const KIND_EPHEMERAL_REACTION = 20007
export const KIND_NAMED_RADIO_CHAT = 23333

export const DEFAULT_POW_TARGET_BITS = 8
const MAX_INBOUND_TAGS = 64
const MAX_TAG_VALUES = 12
const MAX_TAG_VALUE_LEN = 1024
const MAX_VERIFIED_CACHE = 1500
const MAX_INVALID_CACHE = 500

const verifiedEventIds = new Set<string>()
const invalidEventIds = new Set<string>()
const utf8Encoder = new TextEncoder()

export function clearProtocolCaches(): void {
  verifiedEventIds.clear()
  invalidEventIds.clear()
}

/**
 * Returns cached verification verdict (`true` / `false`) or `null` if unknown.
 */
export function getEventVerificationCacheResult(id: string): boolean | null {
  if (!id) return null
  if (verifiedEventIds.has(id)) return true
  if (invalidEventIds.has(id)) return false
  return null
}

/**
 * Populates the O(1) verification cache from off-main-thread batch verification
 * so subsequent `verifyEventCached(ev)` calls hit the cache in ~0.001ms.
 */
export function markEventVerifiedCached(id: string, ok: boolean): void {
  if (!id || typeof id !== 'string') return
  if (ok) {
    invalidEventIds.delete(id)
    if (verifiedEventIds.has(id)) {
      verifiedEventIds.delete(id)
    } else if (verifiedEventIds.size >= MAX_VERIFIED_CACHE) {
      const first = verifiedEventIds.values().next().value
      if (first) verifiedEventIds.delete(first)
    }
    verifiedEventIds.add(id)
  } else {
    verifiedEventIds.delete(id)
    rememberInvalid(id)
  }
}

export function isWithinTagLimits(tags: unknown): tags is string[][] {
  if (!Array.isArray(tags) || tags.length > MAX_INBOUND_TAGS) return false
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.length > MAX_TAG_VALUES) return false
    for (const val of tag) {
      if (typeof val !== 'string' || val.length > MAX_TAG_VALUE_LEN) return false
    }
  }
  return true
}

export function verifyEventCached(event: NostrEvent): boolean {
  if (!event || typeof event.id !== 'string' || typeof event.pubkey !== 'string') return false
  const eventId = event.id
  if (verifiedEventIds.has(eventId)) {
    // Refresh LRU recency
    verifiedEventIds.delete(eventId)
    verifiedEventIds.add(eventId)
    return true
  }
  if (invalidEventIds.has(eventId)) return false
  if (!isWithinTagLimits(event.tags)) {
    rememberInvalid(eventId)
    return false
  }
  try {
    const ok = verifyEvent(event)
    if (ok) {
      markEventVerifiedCached(eventId, true)
    } else {
      rememberInvalid(eventId)
    }
    return ok
  } catch {
    rememberInvalid(eventId)
    return false
  }
}

function rememberInvalid(id: string): void {
  if (invalidEventIds.has(id)) {
    invalidEventIds.delete(id)
  } else if (invalidEventIds.size >= MAX_INVALID_CACHE) {
    const first = invalidEventIds.values().next().value
    if (first) invalidEventIds.delete(first)
  }
  invalidEventIds.add(id)
}

export function getTagValue(tags: string[][], name: string): string | null {
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === 'string') {
      return tag[1]
    }
  }
  return null
}

export function hasTagPair(tags: string[][], name: string, value: string): boolean {
  for (const tag of tags) {
    if (tag[0] === name && tag[1] === value) return true
  }
  return false
}

export function extractGeohashTag(tags: string[][]): string | null {
  const raw = getTagValue(tags, 'g')
  if (!raw) return null
  const normalized = normalizeGeohash(raw)
  return isValidGeohash(normalized) ? normalized : null
}

/**
 * Extracts a validated ephemeral `kind: 23333` topic channel slug from the `d` tag.
 */
export function extractTopicChannelTag(tags: string[][]): string | null {
  const raw = getTagValue(tags, 'd')
  if (!raw) return null
  return normalizeTopicSlug(raw)
}

/**
 * Leading zero bits of a 64-char hex event ID (NIP-13).
 */
export function leadingZeroBitsHex(idHex: string): number {
  let count = 0
  for (let i = 0; i < idHex.length; i++) {
    const nibble = Number.parseInt(idHex[i], 16)
    if (Number.isNaN(nibble)) return 0
    if (nibble === 0) {
      count += 4
    } else {
      if (nibble < 2) count += 3
      else if (nibble < 4) count += 2
      else if (nibble < 8) count += 1
      break
    }
  }
  return count
}

/**
 * Validated NIP-13 difficulty (matching Bitchat NostrPoW.validatedDifficulty).
 * Returns committed target bits if actual leading zero bits >= committed, else 0.
 */
export function getValidatedPowBits(idHex: string, tags: string[][]): number {
  let nonceTag: string[] | null = null
  for (let i = tags.length - 1; i >= 0; i--) {
    if (tags[i][0] === 'nonce') {
      nonceTag = tags[i]
      break
    }
  }
  if (!nonceTag || nonceTag.length < 3) return 0
  const committed = Number.parseInt(nonceTag[2], 10)
  if (!Number.isFinite(committed) || committed <= 0 || committed > 256) return 0
  return leadingZeroBitsHex(idHex) >= committed ? committed : 0
}

function leadingZeroBitsBytes(bytes: Uint8Array): number {
  let total = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b === 0) {
      total += 8
    } else {
      let mask = 0x80
      while ((b & mask) === 0 && mask > 0) {
        total += 1
        mask >>= 1
      }
      break
    }
  }
  return total
}

/**
 * Non-blocking NIP-13 proof-of-work miner matching Bitchat's `["nonce", 16-hex, target]` tag.
 * Runs completely off the main thread in `mediaCrypto.worker.ts` when Web Workers are available,
 * falling back to a yielding main-thread loop only when Workers are unavailable.
 */
export async function mineNip13NonceTag(
  template: EventTemplate,
  pubkeyHex: string,
  targetBits = DEFAULT_POW_TARGET_BITS,
  timeCapMs = 450
): Promise<string[] | null> {
  const target = Math.max(0, Math.min(20, Math.floor(targetBits)))
  if (target === 0) return null

  if (isOffMainThreadWorkerSupported()) {
    try {
      return await mineNip13OffMainThread(template, pubkeyHex, target, timeCapMs)
    } catch {
      // Fall back cleanly to yielding main-thread PoW loop
    }
  }

  const targetStr = String(target)
  const deadline = performance.now() + timeCapMs
  let nonce = Math.floor(Math.random() * 0xffffffff)
  let attempts = 0

  while (performance.now() < deadline) {
    const nonceHex = nonce.toString(16).padStart(16, '0')
    const tagsWithNonce = [...template.tags, ['nonce', nonceHex, targetStr]]
    const serialized = JSON.stringify([
      0,
      pubkeyHex.toLowerCase(),
      template.created_at,
      template.kind,
      tagsWithNonce,
      template.content,
    ])
    const hash = sha256(utf8Encoder.encode(serialized))
    if (leadingZeroBitsBytes(hash) >= target) {
      return ['nonce', nonceHex, targetStr]
    }
    nonce += 1
    attempts += 1
    if (attempts % 512 === 0) {
      await new Promise<void>((r) => globalThis.setTimeout(r, 0))
    }
  }

  return null
}

const BITCHAT_TAGGED_MENTION_RE =
  /(?:^|[\s([,"'“‘])@([^\s@#\n](?:[^@#\n]{0,30}[^\s@#\n])?#[0-9a-fA-F]{4})(?=$|[\s.,!?;:)\]}"'’])/g

const SIMPLE_MENTION_RE =
  /(?:^|[\s([,"'“‘])@([\p{L}\p{N}_.-]{1,32})(?=$|[\s.,!?;:)\]}"'’])/gu

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function extractMentions(content: string): string[] {
  if (!content || !content.includes('@')) return []
  const found = new Set<string>()
  const taggedRanges: Array<[number, number]> = []

  // 1. Capture full Bitchat #xxxx-suffixed mentions first (supporting spaces & Unicode)
  BITCHAT_TAGGED_MENTION_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BITCHAT_TAGGED_MENTION_RE.exec(content)) !== null) {
    const handle = match[1]
    const atOffset = match[0].indexOf('@')
    const start = match.index + atOffset
    const end = start + 1 + handle.length
    taggedRanges.push([start, end])
    found.add(handle)
  }

  // 2. Capture single-word @handle mentions without fragmenting any #xxxx-suffixed mention
  SIMPLE_MENTION_RE.lastIndex = 0
  while ((match = SIMPLE_MENTION_RE.exec(content)) !== null) {
    const atOffset = match[0].indexOf('@')
    const start = match.index + atOffset
    if (taggedRanges.some(([rStart, rEnd]) => start >= rStart && start < rEnd)) {
      continue
    }
    found.add(match[1])
  }

  return Array.from(found)
}

export function doesContentMentionUser(
  content: string,
  mentions: readonly string[],
  nickname: string,
  pubkey: string
): boolean {
  const cleanNick = nickname.trim()
  const nickLower = cleanNick.toLowerCase()
  const pkLower = pubkey.trim().toLowerCase()
  const suffix = pkLower.length >= 4 ? pkLower.slice(-4) : ''
  const fullHandleLower = nickLower && suffix ? `${nickLower}#${suffix}` : ''

  // 1. Check pre-extracted mentions / tagged pubkeys
  for (const raw of mentions) {
    const m = raw.trim().toLowerCase()
    if (!m) continue
    if (pkLower && m === pkLower) return true
    const stripped = m.startsWith('@') ? m.slice(1) : m
    if (fullHandleLower && stripped === fullHandleLower) return true
    if (nickLower && stripped === nickLower) return true
  }

  if (!content || !cleanNick || !content.includes('@')) return false

  // 2. Check explicit #xxxx-suffixed mentions in content (exact nick#last4 match)
  //    and mask them out before checking bare @nickname mentions so `@John Doe#a1b2`
  //    never false-matches `John` or `John Doe#ffff`.
  let masked = ''
  let cursor = 0
  BITCHAT_TAGGED_MENTION_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BITCHAT_TAGGED_MENTION_RE.exec(content)) !== null) {
    const handle = match[1]
    if (fullHandleLower && handle.toLowerCase() === fullHandleLower) {
      return true
    }
    const atOffset = match[0].indexOf('@')
    const start = match.index + atOffset
    const end = start + 1 + handle.length
    masked += content.slice(cursor, start) + ' '
    cursor = end
  }
  masked += content.slice(cursor)

  // 3. Boundary-aware bare @nickname match (supports spaces & Unicode)
  const bareRe = new RegExp(
    `(?:^|[\\s([,"'“‘])@${escapeRegExp(cleanNick)}(?=$|[\\s.,!?;:)\\]}"'’])`,
    'i'
  )
  return bareRe.test(masked)
}

export function isEmoteContent(content: string): boolean {
  const t = content.trim()
  return t.length >= 4 && t.startsWith('* ') && t.endsWith(' *')
}

export function buildImetaTag(memo: VoiceMemoAttachment): string[] {
  const fields: string[] = [
    'imeta',
    `url ${memo.url}`,
    `m ${memo.mime}`,
  ]
  if (memo.sha256) fields.push(`x ${memo.sha256}`)
  if (memo.size > 0) fields.push(`size ${Math.round(memo.size)}`)
  if (memo.durationSec > 0) fields.push(`duration ${memo.durationSec.toFixed(1)}`)
  if (memo.waveform.length > 0) {
    fields.push(`waveform ${memo.waveform.map((n) => Math.max(0, Math.min(100, Math.round(n)))).join(',')}`)
  }
  return fields
}

const AUDIO_URL_EXT_RE = /\.(?:webm|weba|m4a|mp4|ogg|opus|mp3|wav)(?:[?#].*)?$/i

export function parseVoiceMemoFromImeta(tags: string[][]): VoiceMemoAttachment | undefined {
  for (const tag of tags) {
    if (tag[0] !== 'imeta' || tag.length < 2) continue
    const map = new Map<string, string>()
    for (let i = 1; i < tag.length; i++) {
      const entry = tag[i]
      if (typeof entry !== 'string') continue
      const spaceIdx = entry.indexOf(' ')
      if (spaceIdx <= 0) continue
      const key = entry.slice(0, spaceIdx).trim().toLowerCase()
      const val = entry.slice(spaceIdx + 1).trim()
      if (key && val) map.set(key, val)
    }

    const url = map.get('url')
    if (!url || !/^https?:\/\//i.test(url)) continue
    const rawMime = (map.get('m') ?? '').toLowerCase()
    const hasAudioHints =
      rawMime.startsWith('audio/') ||
      (rawMime === 'video/webm' && (map.has('duration') || map.has('waveform'))) ||
      AUDIO_URL_EXT_RE.test(url)
    if (!hasAudioHints) continue

    const sha256Hex = (map.get('x') ?? '').toLowerCase()
    const size = Number.parseInt(map.get('size') ?? '0', 10)
    const durationSec = Number.parseFloat(map.get('duration') ?? '0')
    const rawWave = map.get('waveform')
    let waveform: number[] = []
    if (rawWave) {
      waveform = rawWave
        .split(/[,\s]+/)
        .map((n) => Number.parseInt(n, 10))
        .filter((n) => Number.isFinite(n))
        .slice(0, 64)
        .map((n) => Math.max(4, Math.min(100, n)))
    }
    if (waveform.length === 0) {
      waveform = Array.from({ length: 32 }, (_, idx) => 22 + ((idx * 19) % 45))
    }

    let server: string | undefined
    try {
      server = new URL(url).origin
    } catch {
      server = undefined
    }

    return {
      url,
      mime: rawMime.startsWith('audio/') ? rawMime : 'audio/webm',
      size: Number.isFinite(size) && size > 0 ? size : 0,
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
      waveform,
      sha256: /^[0-9a-f]{64}$/.test(sha256Hex) ? sha256Hex : '',
      server,
    }
  }
  return undefined
}

export function buildImageImetaTag(image: ImageAttachment): string[] {
  const fields: string[] = [
    'imeta',
    `url ${image.url}`,
    `m ${image.mime}`,
  ]
  if (image.sha256) fields.push(`x ${image.sha256}`)
  if (image.size > 0) fields.push(`size ${Math.round(image.size)}`)
  if (image.width > 0 && image.height > 0) {
    fields.push(`dim ${Math.round(image.width)}x${Math.round(image.height)}`)
  }
  if (image.alt && image.alt.trim()) {
    fields.push(`alt ${image.alt.trim().slice(0, 120)}`)
  }
  return fields
}

const IMAGE_URL_EXT_RE = /\.(?:webp|jpe?g|png|gif|avif|bmp)(?:[?#].*)?$/i

export function parseImageFromImeta(tags: string[][]): ImageAttachment | undefined {
  for (const tag of tags) {
    if (tag[0] !== 'imeta' || tag.length < 2) continue
    const map = new Map<string, string>()
    for (let i = 1; i < tag.length; i++) {
      const entry = tag[i]
      if (typeof entry !== 'string') continue
      const spaceIdx = entry.indexOf(' ')
      if (spaceIdx <= 0) continue
      const key = entry.slice(0, spaceIdx).trim().toLowerCase()
      const val = entry.slice(spaceIdx + 1).trim()
      if (key && val) map.set(key, val)
    }

    const url = map.get('url')
    if (!url || !/^https?:\/\//i.test(url)) continue
    const rawMime = (map.get('m') ?? '').toLowerCase()
    if (rawMime === 'image/svg+xml') continue // Disallow SVG scripts
    const hasImageHints = rawMime.startsWith('image/') || IMAGE_URL_EXT_RE.test(url)
    if (!hasImageHints) continue

    const sha256Hex = (map.get('x') ?? '').toLowerCase()
    const size = Number.parseInt(map.get('size') ?? '0', 10)
    let width = 0
    let height = 0
    const rawDim = map.get('dim')
    if (rawDim) {
      const dimMatch = /^(\d{1,5})x(\d{1,5})$/i.exec(rawDim.trim())
      if (dimMatch) {
        width = Number.parseInt(dimMatch[1], 10)
        height = Number.parseInt(dimMatch[2], 10)
      }
    }
    const alt = map.get('alt')?.trim().slice(0, 120) || undefined

    let server: string | undefined
    try {
      server = new URL(url).origin
    } catch {
      server = undefined
    }

    return {
      url,
      mime: rawMime.startsWith('image/') ? rawMime : 'image/webp',
      sha256: /^[0-9a-f]{64}$/.test(sha256Hex) ? sha256Hex : '',
      size: Number.isFinite(size) && size > 0 ? size : 0,
      width: Number.isFinite(width) && width > 0 ? width : 0,
      height: Number.isFinite(height) && height > 0 ? height : 0,
      alt,
      server,
    }
  }
  return undefined
}

export const AGNOSTR_CLIENT_TAG = 'agnostr'

export function parseClientTag(tags: string[][]): string | undefined {
  const raw = getTagValue(tags, 'client')?.trim()
  return raw || undefined
}

export function isAgnostrClientTag(tags: string[][]): boolean {
  return parseClientTag(tags)?.toLowerCase() === AGNOSTR_CLIENT_TAG
}

export function formatClientDisplayName(
  raw?: string | null,
  isAgnostr?: boolean
): string | null {
  const clean = raw?.trim()
  if (!clean) return isAgnostr ? 'Agnostr' : null
  if (clean.toLowerCase() === AGNOSTR_CLIENT_TAG) return 'Agnostr'
  if (clean === clean.toLowerCase()) {
    return `${clean.charAt(0).toUpperCase()}${clean.slice(1)}`
  }
  return clean
}

export function buildGeohashChatTemplate(opts: {
  content: string
  geohash: string
  nickname: string
  isTeleported: boolean
  replyTo?: GeoMessage | null
  voiceMemo?: VoiceMemoAttachment
  imageAttachment?: ImageAttachment
  broadcastClientTag?: boolean
  lightningAddress?: string | null
}): EventTemplate {
  const gh = normalizeGeohash(opts.geohash)
  const tags: string[][] = [['g', gh]]
  const cleanNick = opts.nickname.trim()
  if (cleanNick) {
    tags.push(['n', cleanNick])
  }
  if (opts.isTeleported) {
    tags.push(['t', 'teleport'])
  }
  if (opts.broadcastClientTag) {
    tags.push(['client', AGNOSTR_CLIENT_TAG])
  }
  const cleanLud16 = opts.lightningAddress?.trim()
  if (cleanLud16) {
    tags.push(['lud16', cleanLud16])
  }
  if (opts.replyTo && !opts.replyTo.isSystem) {
    tags.push(['e', opts.replyTo.id, '', 'reply'])
    if (/^[0-9a-f]{64}$/i.test(opts.replyTo.pubkey)) {
      tags.push(['p', opts.replyTo.pubkey.toLowerCase()])
    }
  }
  if (opts.voiceMemo) {
    tags.push(buildImetaTag(opts.voiceMemo))
  }
  if (opts.imageAttachment) {
    tags.push(buildImageImetaTag(opts.imageAttachment))
  }
  return {
    kind: KIND_GEOHASH_CHAT,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: opts.content,
  }
}

export function buildNamedRadioChatTemplate(opts: {
  content: string
  topic: string
  nickname: string
  replyTo?: GeoMessage | null
  voiceMemo?: VoiceMemoAttachment
  imageAttachment?: ImageAttachment
  broadcastClientTag?: boolean
  lightningAddress?: string | null
}): EventTemplate {
  const slug = getTopicSlug(opts.topic) ?? normalizeTopicSlug(opts.topic) ?? ''
  const tags: string[][] = [['d', slug]]
  const cleanNick = opts.nickname.trim()
  if (cleanNick) {
    tags.push(['n', cleanNick])
  }
  if (opts.broadcastClientTag) {
    tags.push(['client', AGNOSTR_CLIENT_TAG])
  }
  const cleanLud16 = opts.lightningAddress?.trim()
  if (cleanLud16) {
    tags.push(['lud16', cleanLud16])
  }
  if (opts.replyTo && !opts.replyTo.isSystem) {
    tags.push(['e', opts.replyTo.id, '', 'reply'])
    if (/^[0-9a-f]{64}$/i.test(opts.replyTo.pubkey)) {
      tags.push(['p', opts.replyTo.pubkey.toLowerCase()])
    }
    tags.push(['k', String(KIND_NAMED_RADIO_CHAT)])
  }
  if (opts.voiceMemo) {
    tags.push(buildImetaTag(opts.voiceMemo))
  }
  if (opts.imageAttachment) {
    tags.push(buildImageImetaTag(opts.imageAttachment))
  }
  return {
    kind: KIND_NAMED_RADIO_CHAT,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: opts.content,
  }
}

export function buildPresenceTemplate(
  geohash: string,
  broadcastClientTag = false
): EventTemplate {
  // Per docs/GeohashPresenceSpec.md: empty content, ["g", geohash], optional NIP-89 client tag, NO nickname tag
  const tags: string[][] = [['g', normalizeGeohash(geohash)]]
  if (broadcastClientTag) {
    tags.push(['client', AGNOSTR_CLIENT_TAG])
  }
  return {
    kind: KIND_GEOHASH_PRESENCE,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }
}

export function buildReactionTemplate(opts: {
  geohash: string
  targetEventId: string
  targetPubkey: string
  emoji: string
}): EventTemplate {
  const topicSlug = getTopicSlug(opts.geohash)
  const tags: string[][] = topicSlug
    ? [
        ['d', topicSlug],
        ['e', opts.targetEventId],
        ['p', opts.targetPubkey.toLowerCase()],
        ['k', String(KIND_NAMED_RADIO_CHAT)],
      ]
    : [
        ['g', normalizeGeohash(opts.geohash)],
        ['e', opts.targetEventId],
        ['p', opts.targetPubkey.toLowerCase()],
      ]
  return {
    kind: KIND_EPHEMERAL_REACTION,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: opts.emoji,
  }
}

export function buildLocationNoteTemplate(opts: {
  geohash: string
  nickname: string
  content: string
  ttlSeconds?: number
}): EventTemplate {
  const now = Math.floor(Date.now() / 1000)
  const ttl = opts.ttlSeconds ?? 24 * 60 * 60
  const tags: string[][] = [['g', normalizeGeohash(opts.geohash)]]
  const cleanNick = opts.nickname.trim()
  if (cleanNick) tags.push(['n', cleanNick])
  tags.push(['expiration', String(now + ttl)])
  return {
    kind: KIND_LOCATION_NOTE,
    created_at: now,
    tags,
    content: opts.content.trim(),
  }
}

export function clampTimestamp(createdAt: number): number {
  const nowSec = Math.floor(Date.now() / 1000)
  return Math.min(createdAt, nowSec)
}

export function parseGeohashChatEvent(
  event: NostrEvent,
  expectedGeohash: string,
  ownPubkeys: Set<string>,
  findMessageById?: (id: string) => GeoMessage | undefined
): GeoMessage | null {
  if (event.kind !== KIND_GEOHASH_CHAT) return null
  const gh = extractGeohashTag(event.tags)
  if (!gh || gh !== normalizeGeohash(expectedGeohash)) return null

  const content = (event.content ?? '').trim()
  // Ignore empty teleport probe pings (matches Bitchat NostrInboundPipeline.swift L287-292)
  if (!content) return null

  const pubkey = event.pubkey.toLowerCase()
  const rawNick = getTagValue(event.tags, 'n')?.trim() ?? ''
  const nickname = rawNick || `anon${pubkey.slice(-4)}`
  const displayHandle = formatDisplayHandle(nickname, pubkey)

  const isTeleported = hasTagPair(event.tags, 't', 'teleport')
  const clientTag = parseClientTag(event.tags)
  const isAgnostrClient = isAgnostrClientTag(event.tags)
  const proxyTag = event.tags.find((t) => t[0] === 'proxy')
  const isMeshBridge =
    Boolean(proxyTag && proxyTag.some((v) => v.toLowerCase().includes('mesh'))) ||
    Boolean(clientTag && clientTag.toLowerCase().includes('mesh')) ||
    nickname.toLowerCase().endsWith('.mesh') ||
    nickname.toLowerCase() === 'radio-bridge'

  let replyTo: ReplyReference | undefined
  const eTag = event.tags.find((t) => t[0] === 'e' && typeof t[1] === 'string' && t[1].length >= 16)
  if (eTag) {
    const parent = findMessageById?.(eTag[1])
    replyTo = {
      id: eTag[1],
      pubkey: parent?.pubkey ?? getTagValue(event.tags, 'p') ?? undefined,
      nickname: parent?.nickname,
      preview: parent ? parent.content.slice(0, 120) : undefined,
    }
  }

  const voiceMemo = parseVoiceMemoFromImeta(event.tags)
  const imageAttachment = parseImageFromImeta(event.tags)

  return {
    id: event.id,
    geohash: gh,
    pubkey,
    nickname,
    displayHandle,
    content,
    createdAt: clampTimestamp(event.created_at),
    tags: event.tags,
    isOwn: ownPubkeys.has(pubkey),
    isEmote: isEmoteContent(content),
    isTeleported,
    isMeshBridge,
    bridgeClient: clientTag,
    clientName: clientTag,
    isAgnostrClient,
    powBits: getValidatedPowBits(event.id, event.tags),
    replyTo,
    reactions: [],
    mentions: extractMentions(content),
    voiceMemo,
    imageAttachment,
    deliveryStatus: 'sent',
  }
}

export function parseNamedRadioChatEvent(
  event: NostrEvent,
  expectedChannelKey: string,
  ownPubkeys: Set<string>,
  findMessageById?: (id: string) => GeoMessage | undefined
): GeoMessage | null {
  if (event.kind !== KIND_NAMED_RADIO_CHAT) return null
  const slug = extractTopicChannelTag(event.tags)
  const expectedSlug = getTopicSlug(expectedChannelKey) ?? normalizeTopicSlug(expectedChannelKey)
  if (!slug || !expectedSlug || slug !== expectedSlug) return null

  const content = (event.content ?? '').trim()
  if (!content) return null

  const channelKey = `${TOPIC_CHANNEL_PREFIX}${slug}`
  const pubkey = event.pubkey.toLowerCase()
  const rawNick = getTagValue(event.tags, 'n')?.trim() ?? ''
  const nickname = rawNick || `anon${pubkey.slice(-4)}`
  const displayHandle = formatDisplayHandle(nickname, pubkey)

  const clientTag = parseClientTag(event.tags)
  const isAgnostrClient = isAgnostrClientTag(event.tags)
  const proxyTag = event.tags.find((t) => t[0] === 'proxy')
  const isMeshBridge =
    Boolean(proxyTag && proxyTag.some((v) => v.toLowerCase().includes('mesh'))) ||
    Boolean(clientTag && clientTag.toLowerCase().includes('mesh')) ||
    nickname.toLowerCase().endsWith('.mesh') ||
    nickname.toLowerCase() === 'radio-bridge'

  let replyTo: ReplyReference | undefined
  const eTag = event.tags.find((t) => t[0] === 'e' && typeof t[1] === 'string' && t[1].length >= 16)
  if (eTag) {
    const parent = findMessageById?.(eTag[1])
    replyTo = {
      id: eTag[1],
      pubkey: parent?.pubkey ?? getTagValue(event.tags, 'p') ?? undefined,
      nickname: parent?.nickname,
      preview: parent ? parent.content.slice(0, 120) : undefined,
    }
  }

  const voiceMemo = parseVoiceMemoFromImeta(event.tags)
  const imageAttachment = parseImageFromImeta(event.tags)

  return {
    id: event.id,
    geohash: channelKey,
    pubkey,
    nickname,
    displayHandle,
    content,
    createdAt: clampTimestamp(event.created_at),
    tags: event.tags,
    isOwn: ownPubkeys.has(pubkey),
    isEmote: isEmoteContent(content),
    isTeleported: false,
    isMeshBridge,
    bridgeClient: clientTag,
    clientName: clientTag,
    isAgnostrClient,
    powBits: getValidatedPowBits(event.id, event.tags),
    replyTo,
    reactions: [],
    mentions: extractMentions(content),
    voiceMemo,
    imageAttachment,
    deliveryStatus: 'sent',
  }
}

export interface ParsedReaction {
  id: string
  geohash: string
  targetEventId: string
  pubkey: string
  emoji: string
  createdAt: number
}

export function parseReactionEvent(
  event: NostrEvent,
  expectedGeohash: string
): ParsedReaction | null {
  if (event.kind !== KIND_EPHEMERAL_REACTION) return null
  let channelKey: string | null = null
  if (isTopicChannel(expectedGeohash)) {
    const expectedSlug = getTopicSlug(expectedGeohash)
    const slug = extractTopicChannelTag(event.tags)
    if (!slug || !expectedSlug || slug !== expectedSlug) return null
    channelKey = `${TOPIC_CHANNEL_PREFIX}${slug}`
  } else {
    const gh = extractGeohashTag(event.tags)
    if (!gh || gh !== normalizeGeohash(expectedGeohash)) return null
    channelKey = gh
  }
  const targetEventId = getTagValue(event.tags, 'e')
  const emoji = (event.content ?? '').trim()
  if (!targetEventId || !emoji || emoji.length > 16) return null
  return {
    id: event.id,
    geohash: channelKey,
    targetEventId,
    pubkey: event.pubkey.toLowerCase(),
    emoji,
    createdAt: clampTimestamp(event.created_at),
  }
}

export function parseLocationNoteEvent(
  event: NostrEvent,
  expectedGeohash: string,
  ownPubkeys: Set<string>
): LocationNote | null {
  if (event.kind !== KIND_LOCATION_NOTE) return null
  const gh = extractGeohashTag(event.tags)
  if (!gh || gh !== normalizeGeohash(expectedGeohash)) return null
  const content = (event.content ?? '').trim()
  if (!content) return null

  const nowSec = Math.floor(Date.now() / 1000)
  const expRaw = getTagValue(event.tags, 'expiration')
  const createdAt = clampTimestamp(event.created_at)
  const expiresAt = expRaw ? Number.parseInt(expRaw, 10) : createdAt + 24 * 60 * 60
  if (!Number.isFinite(expiresAt) || expiresAt <= nowSec) return null

  const pubkey = event.pubkey.toLowerCase()
  const nickname = getTagValue(event.tags, 'n')?.trim() || `anon${pubkey.slice(-4)}`

  return {
    id: event.id,
    geohash: gh,
    pubkey,
    nickname,
    displayHandle: formatDisplayHandle(nickname, pubkey),
    content,
    createdAt,
    expiresAt,
    isOwn: ownPubkeys.has(pubkey),
  }
}

export function createSystemMessage(geohash: string, content: string): GeoMessage {
  const randomBytes = new Uint8Array(8)
  crypto.getRandomValues(randomBytes)
  return {
    id: `sys-${Date.now()}-${bytesToHex(randomBytes)}`,
    geohash: normalizeRadioChannelKey(geohash) ?? normalizeGeohash(geohash),
    pubkey: 'system',
    nickname: 'system',
    displayHandle: 'system',
    content,
    createdAt: Math.floor(Date.now() / 1000),
    tags: [],
    isOwn: false,
    isSystem: true,
    isTeleported: false,
    isMeshBridge: false,
    powBits: 0,
    reactions: [],
    mentions: [],
  }
}
