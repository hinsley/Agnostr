import {
  finalizeEvent,
  generateSecretKey,
  nip44,
  verifyEvent,
  type Event as NostrEvent,
  type VerifiedEvent,
} from 'nostr-tools'
import type { ServerSummary } from '../types/servers.ts'
import {
  getTopicSlug,
  isTopicChannel,
  makeCelestialChannelKey,
  normalizeBitchatChannelKey,
  normalizeTopicSlug,
  parseCelestialChannelKey,
} from './bitchatChannel.ts'
import {
  extractGeohashTag,
  extractTopicChannelTag,
  getTagValue,
  hasTagPair,
  verifyEventCached,
} from './bitchatProtocol.ts'
import { normalizeGeohash } from './geohash.ts'
import { hexToBytes, type SigningKeyMaterial } from './identity.ts'

/** Dedicated ephemeral Nostr event kind for typing indicators (isolated from 20001/25050/25055/25058/25059) */
export const KIND_TYPING_INDICATOR = 25056

export const TYPING_BROADCAST_THROTTLE_MS = 3_500
export const TYPING_STOP_IDLE_MS = 4_500
export const TYPING_PEER_TTL_MS = 6_000
export const MAX_TYPING_EVENT_AGE_SEC = 12

export const TYPING_TAG = 'agnostr-typing'
export const DM_TYPING_TAG = 'agnostr-typing-dm'
export const E2EE_TYPING_PAYLOAD_PREFIX = 'agnostr-typing-e2ee-v1:'

export type TypingSignalState = 'typing' | 'stop'

export interface ParsedTypingSignal {
  pubkey: string
  nickname?: string
  state: TypingSignalState
}

export type TypingServerCryptoInfo = Pick<
  ServerSummary,
  'id' | 'encrypted' | 'encryptionKeyB64'
> &
  Partial<Pick<ServerSummary, 'kind' | 'groupId'>> & {
    encryptionKeyHex?: string
  }

/**
 * Resolves the canonical `#h` scope tag for a group typing indicator:
 * - NIP-29 groups use `server.groupId` (matching relay-enforced NIP-29 `#h` routing)
 * - Virtual groups (public & E2EE) use `server.id`
 */
export function getServerTypingScopeTag(server: TypingServerCryptoInfo): string {
  if (server.kind === 'nip29' && typeof server.groupId === 'string' && server.groupId.trim()) {
    return server.groupId.trim()
  }
  return server.id.trim()
}

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/i
const MAX_TYPING_CONTENT_LEN = 4_096

function cleanTypingNickname(raw?: string | null): string | undefined {
  if (typeof raw !== 'string') return undefined
  const clean = raw.trim().slice(0, 32)
  return clean.length > 0 ? clean : undefined
}

function parseTypingState(raw: unknown): TypingSignalState | null {
  if (raw === 'typing' || raw === 'stop') return raw
  return null
}

function isFreshTypingTimestamp(
  createdAt: number,
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  return (
    typeof createdAt === 'number' &&
    Number.isFinite(createdAt) &&
    Math.abs(nowSec - createdAt) <= MAX_TYPING_EVENT_AGE_SEC
  )
}

function buildCelestialGeohashTags(rawChannelKey: string): string[][] {
  const parsed = parseCelestialChannelKey(rawChannelKey)
  if (parsed) {
    const canonical = makeCelestialChannelKey(parsed.bodyId, parsed.geohash)
    if (canonical) {
      return parsed.bodyId === 'earth'
        ? [['g', canonical]]
        : [
            ['g', canonical],
            ['body', parsed.bodyId],
          ]
    }
  }
  return [['g', normalizeGeohash(rawChannelKey)]]
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(str: string): Uint8Array | null {
  try {
    const clean = str.trim()
    if (!clean) return null
    const pad = clean.length % 4 === 0 ? '' : '='.repeat(4 - (clean.length % 4))
    const b64 = clean.replace(/-/g, '+').replace(/_/g, '/') + pad
    const binary = atob(b64)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i)
    }
    return out
  } catch {
    return null
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function resolveServerAesKeyBytes(server: TypingServerCryptoInfo): Uint8Array | null {
  if (server.encryptionKeyB64) {
    const b64Bytes = base64UrlDecode(server.encryptionKeyB64)
    if (b64Bytes && b64Bytes.length === 32) return b64Bytes
  }
  if (server.encryptionKeyHex && HEX_PUBKEY_RE.test(server.encryptionKeyHex.trim())) {
    const hexBytes = hexToBytes(server.encryptionKeyHex.trim())
    if (hexBytes && hexBytes.length === 32) return hexBytes
  }
  return null
}

async function encryptAesGcmTypingPayload(
  keyBytes: Uint8Array,
  plaintext: string
): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null
  try {
    const iv = new Uint8Array(12)
    crypto.getRandomValues(iv)
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(keyBytes),
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    )
    const plainBytes = utf8Encoder.encode(plaintext)
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      cryptoKey,
      toArrayBuffer(plainBytes)
    )
    const cipherBytes = new Uint8Array(cipherBuf)
    const combined = new Uint8Array(iv.length + cipherBytes.length)
    combined.set(iv, 0)
    combined.set(cipherBytes, iv.length)
    return `${E2EE_TYPING_PAYLOAD_PREFIX}${base64UrlEncode(combined)}`
  } catch {
    return null
  }
}

async function decryptAesGcmTypingPayload(
  keyBytes: Uint8Array,
  rawContent: string
): Promise<string | null> {
  if (!rawContent.startsWith(E2EE_TYPING_PAYLOAD_PREFIX)) return null
  if (typeof crypto === 'undefined' || !crypto.subtle) return null
  const combined = base64UrlDecode(rawContent.slice(E2EE_TYPING_PAYLOAD_PREFIX.length))
  if (!combined || combined.length <= 12 + 16) return null
  try {
    const iv = combined.subarray(0, 12)
    const ciphertext = combined.subarray(12)
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(keyBytes),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    )
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      cryptoKey,
      toArrayBuffer(ciphertext)
    )
    return utf8Decoder.decode(new Uint8Array(plainBuf))
  } catch {
    return null
  }
}

/**
 * Builds a signed ephemeral typing indicator event for a Bitchat geohash, celestial, or topic channel.
 * Silently returns `null` for NIP-07 extension signers to avoid interactive popups.
 */
export function buildGeoTypingEvent(opts: {
  channelKey: string
  signer: SigningKeyMaterial
  nickname?: string | null
  state: TypingSignalState
  createdAt?: number
}): VerifiedEvent | null {
  if (opts.signer.mode === 'extension' || !opts.signer.secretKey) return null

  const tags: string[][] = []
  if (isTopicChannel(opts.channelKey)) {
    const slug = getTopicSlug(opts.channelKey) ?? normalizeTopicSlug(opts.channelKey)
    if (!slug) return null
    tags.push(['d', slug])
  } else {
    tags.push(...buildCelestialGeohashTags(opts.channelKey))
  }
  tags.push(['t', TYPING_TAG])
  const cleanNick = cleanTypingNickname(opts.nickname)
  if (cleanNick) {
    tags.push(['n', cleanNick])
  }

  return finalizeEvent(
    {
      kind: KIND_TYPING_INDICATOR,
      created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
      tags,
      content: JSON.stringify({ v: 1, s: opts.state }),
    },
    opts.signer.secretKey
  )
}

/**
 * Validates and parses a Bitchat channel typing indicator event.
 */
export function parseGeoTypingEvent(
  ev: NostrEvent,
  expectedChannelKey: string,
  nowSec = Math.floor(Date.now() / 1000)
): ParsedTypingSignal | null {
  if (!ev || ev.kind !== KIND_TYPING_INDICATOR) return null
  if (typeof ev.content !== 'string' || ev.content.length > MAX_TYPING_CONTENT_LEN) return null
  if (!isFreshTypingTimestamp(ev.created_at, nowSec)) return null
  if (!Array.isArray(ev.tags) || !hasTagPair(ev.tags, 't', TYPING_TAG)) return null

  if (isTopicChannel(expectedChannelKey)) {
    const expectedSlug = getTopicSlug(expectedChannelKey) ?? normalizeTopicSlug(expectedChannelKey)
    const slug = extractTopicChannelTag(ev.tags)
    if (!slug || !expectedSlug || slug !== expectedSlug) return null
  } else {
    const expectedGh =
      normalizeBitchatChannelKey(expectedChannelKey) ?? normalizeGeohash(expectedChannelKey)
    const gh = extractGeohashTag(ev.tags)
    if (!gh || gh !== expectedGh) return null
  }

  if (!verifyEventCached(ev)) return null

  let parsed: { v?: unknown; s?: unknown }
  try {
    parsed = JSON.parse(ev.content) as { v?: unknown; s?: unknown }
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) return null
  const state = parseTypingState(parsed.s)
  if (!state) return null

  const nickname = cleanTypingNickname(getTagValue(ev.tags, 'n'))
  return {
    pubkey: ev.pubkey.toLowerCase(),
    ...(nickname ? { nickname } : {}),
    state,
  }
}

/**
 * Builds a signed ephemeral typing indicator event for a Group (E2EE Virtual or NIP-29).
 * For E2EE groups, encrypts channel ID and nickname inside AES-256-GCM ciphertext.
 * Silently returns `null` for NIP-07 extension signers.
 */
export async function buildServerTypingEvent(opts: {
  server: TypingServerCryptoInfo
  channelId: string
  signer: SigningKeyMaterial
  nickname?: string | null
  state: TypingSignalState
  createdAt?: number
}): Promise<VerifiedEvent | null> {
  if (opts.signer.mode === 'extension' || !opts.signer.secretKey) return null
  const scopeTag = getServerTypingScopeTag(opts.server)
  const channelId = opts.channelId.trim()
  if (!scopeTag || !channelId) return null

  const cleanNick = cleanTypingNickname(opts.nickname)
  const createdAt = opts.createdAt ?? Math.floor(Date.now() / 1000)

  if (opts.server.encrypted) {
    const keyBytes = resolveServerAesKeyBytes(opts.server)
    if (!keyBytes) return null
    const plaintext = JSON.stringify({
      v: 1,
      s: opts.state,
      c: channelId,
      ...(cleanNick ? { n: cleanNick } : {}),
    })
    const ciphertext = await encryptAesGcmTypingPayload(keyBytes, plaintext)
    if (!ciphertext) return null
    return finalizeEvent(
      {
        kind: KIND_TYPING_INDICATOR,
        created_at: createdAt,
        tags: [
          ['h', scopeTag],
          ['t', TYPING_TAG],
        ],
        content: ciphertext,
      },
      opts.signer.secretKey
    )
  }

  const tags: string[][] = [
    ['h', scopeTag],
    ['c', channelId],
    ['t', TYPING_TAG],
  ]
  if (cleanNick) {
    tags.push(['n', cleanNick])
  }
  return finalizeEvent(
    {
      kind: KIND_TYPING_INDICATOR,
      created_at: createdAt,
      tags,
      content: JSON.stringify({ v: 1, s: opts.state, c: channelId }),
    },
    opts.signer.secretKey
  )
}

/**
 * Validates and parses a Group typing indicator event (E2EE Virtual or NIP-29).
 * Rejects plaintext events inside encrypted groups.
 */
export async function parseServerTypingEvent(
  ev: NostrEvent,
  server: TypingServerCryptoInfo,
  expectedChannelId: string,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<ParsedTypingSignal | null> {
  if (!ev || ev.kind !== KIND_TYPING_INDICATOR) return null
  if (typeof ev.content !== 'string' || ev.content.length > MAX_TYPING_CONTENT_LEN) return null
  if (!isFreshTypingTimestamp(ev.created_at, nowSec)) return null
  if (!Array.isArray(ev.tags) || !hasTagPair(ev.tags, 't', TYPING_TAG)) return null

  const scopeTag = getServerTypingScopeTag(server)
  const channelId = expectedChannelId.trim()
  if (!scopeTag || !channelId) return null
  if (getTagValue(ev.tags, 'h') !== scopeTag) return null

  if (!server.encrypted) {
    const tagChannel = getTagValue(ev.tags, 'c')
    if (tagChannel && tagChannel !== channelId) return null
  } else if (!ev.content.startsWith(E2EE_TYPING_PAYLOAD_PREFIX)) {
    // Strictly reject unencrypted plaintext payloads inside E2EE groups
    return null
  }

  if (!verifyEventCached(ev)) return null

  let jsonText: string | null
  if (server.encrypted) {
    const keyBytes = resolveServerAesKeyBytes(server)
    if (!keyBytes) return null
    jsonText = await decryptAesGcmTypingPayload(keyBytes, ev.content)
  } else {
    if (ev.content.startsWith(E2EE_TYPING_PAYLOAD_PREFIX)) return null
    jsonText = ev.content
  }
  if (!jsonText) return null

  let parsed: { v?: unknown; s?: unknown; c?: unknown; n?: unknown }
  try {
    parsed = JSON.parse(jsonText) as { v?: unknown; s?: unknown; c?: unknown; n?: unknown }
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) return null
  if (parsed.c !== channelId) return null
  const state = parseTypingState(parsed.s)
  if (!state) return null

  const nickname = server.encrypted
    ? cleanTypingNickname(typeof parsed.n === 'string' ? parsed.n : undefined)
    : cleanTypingNickname(
        typeof parsed.n === 'string' ? parsed.n : getTagValue(ev.tags, 'n')
      )

  return {
    pubkey: ev.pubkey.toLowerCase(),
    ...(nickname ? { nickname } : {}),
    state,
  }
}

/**
 * Builds an ephemeral-wrapped NIP-44 v2 encrypted 1-on-1 DM typing indicator event.
 * Uses a fresh disposable outer keypair so relays never learn which sender is typing.
 * Silently returns `null` for NIP-07 extension signers (zero prompts).
 */
export function buildDmTypingEvent(opts: {
  peerPubkey: string
  signer: SigningKeyMaterial
  nickname?: string | null
  state: TypingSignalState
  createdAt?: number
}): VerifiedEvent | null {
  if (opts.signer.mode === 'extension' || !opts.signer.secretKey) return null
  const peerPk = opts.peerPubkey.trim().toLowerCase()
  if (!HEX_PUBKEY_RE.test(peerPk)) return null

  const nowSec = opts.createdAt ?? Math.floor(Date.now() / 1000)
  const cleanNick = cleanTypingNickname(opts.nickname)

  const inner = finalizeEvent(
    {
      kind: KIND_TYPING_INDICATOR,
      created_at: nowSec,
      tags: [
        ['p', peerPk],
        ['t', DM_TYPING_TAG],
      ],
      content: JSON.stringify({
        v: 1,
        s: opts.state,
        ...(cleanNick ? { n: cleanNick } : {}),
      }),
    },
    opts.signer.secretKey
  )

  const ephemeralSk = generateSecretKey()
  const convKey = nip44.v2.utils.getConversationKey(ephemeralSk, peerPk)
  const ciphertext = nip44.v2.encrypt(JSON.stringify(inner), convKey)

  return finalizeEvent(
    {
      kind: KIND_TYPING_INDICATOR,
      created_at: nowSec,
      tags: [
        ['p', peerPk],
        ['t', DM_TYPING_TAG],
      ],
      content: ciphertext,
    },
    ephemeralSk
  )
}

/**
 * Decrypts and authenticates an ephemeral-wrapped NIP-44 v2 DM typing indicator event.
 * Rejects extension signers, spoofed inner signatures, cross-peer/replayed events, and stale timestamps.
 */
export function parseDmTypingEvent(
  ev: NostrEvent,
  recipientKey: SigningKeyMaterial,
  expectedPeerPubkey: string,
  nowSec = Math.floor(Date.now() / 1000)
): ParsedTypingSignal | null {
  if (recipientKey.mode === 'extension' || !recipientKey.secretKey) return null
  const recipientPk = recipientKey.pubkey.trim().toLowerCase()
  const expectedPeer = expectedPeerPubkey.trim().toLowerCase()
  if (!HEX_PUBKEY_RE.test(recipientPk) || !HEX_PUBKEY_RE.test(expectedPeer)) return null

  if (!ev || ev.kind !== KIND_TYPING_INDICATOR) return null
  if (typeof ev.content !== 'string' || ev.content.length > MAX_TYPING_CONTENT_LEN) return null
  if (!isFreshTypingTimestamp(ev.created_at, nowSec)) return null
  if (!Array.isArray(ev.tags) || !hasTagPair(ev.tags, 't', DM_TYPING_TAG)) return null

  const outerRecipientMatch = ev.tags.some(
    (t) =>
      Array.isArray(t) &&
      t[0] === 'p' &&
      typeof t[1] === 'string' &&
      t[1].trim().toLowerCase() === recipientPk
  )
  if (!outerRecipientMatch) return null
  if (!verifyEventCached(ev)) return null

  let plaintext: string
  try {
    const convKey = nip44.v2.utils.getConversationKey(recipientKey.secretKey, ev.pubkey)
    plaintext = nip44.v2.decrypt(ev.content, convKey)
  } catch {
    return null
  }

  let inner: NostrEvent
  try {
    inner = JSON.parse(plaintext) as NostrEvent
  } catch {
    return null
  }

  if (
    !inner ||
    typeof inner !== 'object' ||
    inner.kind !== KIND_TYPING_INDICATOR ||
    typeof inner.id !== 'string' ||
    typeof inner.pubkey !== 'string' ||
    typeof inner.sig !== 'string' ||
    typeof inner.content !== 'string' ||
    typeof inner.created_at !== 'number' ||
    !Array.isArray(inner.tags)
  ) {
    return null
  }

  if (!isFreshTypingTimestamp(inner.created_at, nowSec)) return null
  if (inner.pubkey.toLowerCase() !== expectedPeer) return null
  if (!hasTagPair(inner.tags, 't', DM_TYPING_TAG)) return null

  const innerRecipientMatch = inner.tags.some(
    (t) =>
      Array.isArray(t) &&
      t[0] === 'p' &&
      typeof t[1] === 'string' &&
      t[1].trim().toLowerCase() === recipientPk
  )
  if (!innerRecipientMatch) return null

  try {
    if (!verifyEvent(inner)) return null
  } catch {
    return null
  }

  let parsed: { v?: unknown; s?: unknown; n?: unknown }
  try {
    parsed = JSON.parse(inner.content) as { v?: unknown; s?: unknown; n?: unknown }
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) return null
  const state = parseTypingState(parsed.s)
  if (!state) return null

  const nickname = cleanTypingNickname(typeof parsed.n === 'string' ? parsed.n : undefined)
  return {
    pubkey: expectedPeer,
    ...(nickname ? { nickname } : {}),
    state,
  }
}
