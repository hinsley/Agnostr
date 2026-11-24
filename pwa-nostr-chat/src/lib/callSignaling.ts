import { sha256 } from '@noble/hashes/sha256'
import { nip44, type Event as NostrEvent, type EventTemplate } from 'nostr-tools'
import type { CallMediaType } from '../types/calls.ts'
import type { ServerSummary } from '../types/servers.ts'
import { normalizeGeohash } from './geohash.ts'
import { bytesToHex, type SigningKeyMaterial } from './identity.ts'
import {
  getTopicSlug,
  isValidBitchatChannelKey,
  normalizeBitchatChannelKey,
} from './bitchatChannel.ts'

/** Ephemeral Nostr event kind for WebRTC call signaling (live-verified on 5 relays) */
export const KIND_CALL_SIGNAL = 25050

/** Shared `#t` tag for NIP-44 encrypted direct call signaling events */
export const DM_CALL_SIGNAL_TAG = 'agnostr-call-v1'

/** Isolated `#t` tag prefix for Bitchat group call presence (keeps legacy kind:20000 #g clients clean) */
export const GEO_CALL_TAG_PREFIX = 'agnostr-call-geo-'

/** Isolated `#t` tag prefix for Named Topic Bitchat (`kind: 23333`) group call presence */
export const TOPIC_CALL_TAG_PREFIX = 'agnostr-call-topic-'

/** Prefix for AES-256-GCM encrypted signaling payloads inside E2EE Private Servers */
export const E2EE_CALL_PAYLOAD_PREFIX = 'agnostr-call-e2ee-v1:'

/** Room presence heartbeat interval (12s) and expiry TTL (30s) */
export const ROOM_HEARTBEAT_INTERVAL_MS = 12_000
export const ROOM_PEER_TTL_MS = 30_000

/** Max age for accepting ephemeral call signals (60s skew tolerance) */
export const MAX_SIGNAL_AGE_SEC = 60

/**
 * Live-verified public Nostr relays supporting ephemeral kind:25050 with `#p` & `#t` echo
 * without web-of-trust burst rejection for auto-generated keys.
 */
export const CALL_SIGNALING_RELAYS: readonly string[] = [
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://relay.fundstr.me',
  'wss://relay.angor.io',
]

export type DirectCallAction =
  | 'call-invite'
  | 'call-accept'
  | 'call-decline'
  | 'call-cancel'
  | 'call-hangup'
  | 'offer'
  | 'answer'
  | 'ice'
  | 'media-state'

export type RoomCallAction =
  | 'room-join'
  | 'room-ping'
  | 'room-leave'
  | 'offer'
  | 'answer'
  | 'ice'
  | 'media-state'

export interface DirectCallSignalPayload {
  v: 1
  action: DirectCallAction
  callId: string
  /** Present when direct NIP-44 signaling carries WebRTC SDP/ICE for a public/NIP-29 server room */
  serverId?: string
  /** Present when direct NIP-44 signaling carries WebRTC SDP/ICE for a Bitchat group call */
  geohash?: string
  roomId?: string
  media?: CallMediaType
  nickname?: string
  sdp?: string
  candidate?: RTCIceCandidateInit
  candidates?: RTCIceCandidateInit[]
  audioMuted?: boolean
  videoEnabled?: boolean
  screenSharing?: boolean
  recording?: boolean
  reason?: string
  ts: number
}

export interface GeoCallSignalPayload {
  v: 1
  action: RoomCallAction
  geohash: string
  roomId: string
  nickname?: string
  media?: CallMediaType
  audioMuted?: boolean
  videoEnabled?: boolean
  screenSharing?: boolean
  recording?: boolean
  ts: number
}

export interface RoomCallSignalPayload {
  v: 1
  action: RoomCallAction
  serverId: string
  roomId: string
  /** Present inside E2EE room envelopes when addressing offer/answer/ice to one peer */
  targetPubkey?: string
  nickname?: string
  media?: CallMediaType
  sdp?: string
  candidate?: RTCIceCandidateInit
  candidates?: RTCIceCandidateInit[]
  audioMuted?: boolean
  videoEnabled?: boolean
  screenSharing?: boolean
  recording?: boolean
  ts: number
}

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(str: string): Uint8Array | null {
  try {
    const clean = str.trim()
    const pad = clean.length % 4 === 0 ? '' : '='.repeat(4 - (clean.length % 4))
    const b64 = clean.replace(/-/g, '+').replace(/_/g, '/') + pad
    const binary = atob(b64)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
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

export function generateCallId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

/**
 * Computes the `#t` signaling tag for a server's Voice & Video call room.
 * - E2EE Private Server: domain-separated blinded SHA-256 tag so relays cannot see serverId/roomId.
 * - Public / NIP-29 Server: `agnostr-call:<serverId>:<roomId>`.
 */
export function getServerCallRoomTag(
  server: Pick<ServerSummary, 'id' | 'encrypted' | 'encryptionKeyB64'>,
  roomId: string
): string {
  const cleanRoom = roomId.trim().toLowerCase() || 'lounge'
  if (server.encrypted && server.encryptionKeyB64) {
    const keyBytes = base64UrlDecode(server.encryptionKeyB64)
    if (keyBytes && keyBytes.length === 32) {
      const keyHex = bytesToHex(keyBytes)
      const digest = sha256(utf8Encoder.encode(`agnostr-call:${keyHex}:${server.id}:${cleanRoom}`))
      return `agnostr-call-e2ee:${bytesToHex(digest).slice(0, 24)}`
    }
  }
  return `agnostr-call:${server.id}:${cleanRoom}`
}

export function getGeoCallRoomId(geohash: string): string {
  const topicSlug = getTopicSlug(geohash)
  if (topicSlug) return `topic:${topicSlug}`
  const gh = normalizeGeohash(geohash)
  return `geo:${gh}`
}

export function getGeoCallRoomTag(geohash: string): string {
  const topicSlug = getTopicSlug(geohash)
  if (topicSlug) return `${TOPIC_CALL_TAG_PREFIX}${topicSlug}`
  const gh = normalizeGeohash(geohash)
  return `${GEO_CALL_TAG_PREFIX}${gh}`
}

/**
 * Resolves the best relay list for signaling a given server's voice/video room.
 */
export function getRelaysForServerCall(server?: Pick<ServerSummary, 'relays' | 'relayUrl'> | null): string[] {
  const set = new Set<string>(CALL_SIGNALING_RELAYS)
  if (server?.relays) {
    for (const r of server.relays) {
      if (r.startsWith('wss://')) set.add(r)
    }
  }
  return Array.from(set).slice(0, 6)
}

/**
 * Encrypts a JSON string with NIP-44 using either local secret key or NIP-07 extension.
 */
export async function encryptNip44Signal(
  material: SigningKeyMaterial,
  recipientPubkey: string,
  plaintext: string
): Promise<string> {
  const target = recipientPubkey.toLowerCase()
  if (material.mode === 'extension') {
    if (!window.nostr?.nip44?.encrypt) {
      throw new Error('NIP-07 extension does not support NIP-44 encryption required for encrypted calls.')
    }
    return await window.nostr.nip44.encrypt(target, plaintext)
  }
  if (!material.secretKey) {
    throw new Error('No signing key available for NIP-44 call encryption.')
  }
  const convKey = nip44.v2.utils.getConversationKey(material.secretKey, target)
  return nip44.v2.encrypt(plaintext, convKey)
}

/**
 * Decrypts a NIP-44 ciphertext string using either local secret key or NIP-07 extension.
 */
export async function decryptNip44Signal(
  material: SigningKeyMaterial,
  senderPubkey: string,
  ciphertext: string
): Promise<string | null> {
  const sender = senderPubkey.toLowerCase()
  try {
    if (material.mode === 'extension') {
      if (!window.nostr?.nip44?.decrypt) return null
      return await window.nostr.nip44.decrypt(sender, ciphertext)
    }
    if (!material.secretKey) return null
    const convKey = nip44.v2.utils.getConversationKey(material.secretKey, sender)
    return nip44.v2.decrypt(ciphertext, convKey)
  } catch {
    return null
  }
}

/**
 * Encrypts an E2EE Private Server room call signal with AES-256-GCM using the server key.
 */
export async function encryptE2eeRoomSignal(
  keyB64: string,
  payload: RoomCallSignalPayload
): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Web Crypto API unavailable for E2EE call signaling.')
  }
  const keyBytes = base64UrlDecode(keyB64)
  if (!keyBytes || keyBytes.length !== 32) {
    throw new Error('Invalid 256-bit E2EE server key.')
  }
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(keyBytes),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  )
  const plainBytes = utf8Encoder.encode(JSON.stringify(payload))
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    cryptoKey,
    toArrayBuffer(plainBytes)
  )
  const cipherBytes = new Uint8Array(cipherBuf)
  const combined = new Uint8Array(iv.length + cipherBytes.length)
  combined.set(iv, 0)
  combined.set(cipherBytes, iv.length)
  return `${E2EE_CALL_PAYLOAD_PREFIX}${base64UrlEncode(combined)}`
}

/**
 * Decrypts an AES-256-GCM encrypted E2EE Private Server room call signal.
 */
export async function decryptE2eeRoomSignal(
  keyB64: string,
  rawContent: string
): Promise<RoomCallSignalPayload | null> {
  if (!rawContent.startsWith(E2EE_CALL_PAYLOAD_PREFIX)) return null
  if (typeof crypto === 'undefined' || !crypto.subtle) return null
  const keyBytes = base64UrlDecode(keyB64)
  if (!keyBytes || keyBytes.length !== 32) return null
  const combined = base64UrlDecode(rawContent.slice(E2EE_CALL_PAYLOAD_PREFIX.length))
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
    const parsed = JSON.parse(utf8Decoder.decode(new Uint8Array(plainBuf))) as Partial<RoomCallSignalPayload>
    return validateRoomSignalPayload(parsed)
  } catch {
    return null
  }
}

const VALID_DIRECT_ACTIONS = new Set<DirectCallAction>([
  'call-invite',
  'call-accept',
  'call-decline',
  'call-cancel',
  'call-hangup',
  'offer',
  'answer',
  'ice',
  'media-state',
])

const VALID_ROOM_ACTIONS = new Set<RoomCallAction>([
  'room-join',
  'room-ping',
  'room-leave',
  'offer',
  'answer',
  'ice',
  'media-state',
])

function sanitizeCandidateList(raw: unknown): RTCIceCandidateInit[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: RTCIceCandidateInit[] = []
  for (const item of raw) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      out.push(item as RTCIceCandidateInit)
      if (out.length >= 32) break
    }
  }
  return out.length > 0 ? out : undefined
}

export function validateDirectSignalPayload(
  raw: Partial<DirectCallSignalPayload> | null | undefined
): DirectCallSignalPayload | null {
  if (!raw || raw.v !== 1) return null
  if (!raw.action || !VALID_DIRECT_ACTIONS.has(raw.action)) return null
  if (typeof raw.callId !== 'string' || !raw.callId.trim()) return null
  const normalizedGeo =
    typeof raw.geohash === 'string' && isValidBitchatChannelKey(raw.geohash)
      ? normalizeBitchatChannelKey(raw.geohash) ?? undefined
      : undefined
  return {
    v: 1,
    action: raw.action,
    callId: raw.callId.trim().slice(0, 64),
    serverId: typeof raw.serverId === 'string' && raw.serverId.trim() ? raw.serverId.trim().slice(0, 96) : undefined,
    geohash: normalizedGeo,
    roomId: typeof raw.roomId === 'string' && raw.roomId.trim() ? raw.roomId.trim().slice(0, 64) : undefined,
    media: raw.media === 'audio' || raw.media === 'video' ? raw.media : undefined,
    nickname: typeof raw.nickname === 'string' ? raw.nickname.trim().slice(0, 32) : undefined,
    sdp: typeof raw.sdp === 'string' && raw.sdp.length <= 65_536 ? raw.sdp : undefined,
    candidate: raw.candidate && typeof raw.candidate === 'object' && !Array.isArray(raw.candidate) ? raw.candidate : undefined,
    candidates: sanitizeCandidateList(raw.candidates),
    audioMuted: typeof raw.audioMuted === 'boolean' ? raw.audioMuted : undefined,
    videoEnabled: typeof raw.videoEnabled === 'boolean' ? raw.videoEnabled : undefined,
    screenSharing: typeof raw.screenSharing === 'boolean' ? raw.screenSharing : undefined,
    recording: typeof raw.recording === 'boolean' ? raw.recording : undefined,
    reason: typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 120) : undefined,
    ts: typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : Date.now(),
  }
}

export function validateRoomSignalPayload(
  raw: Partial<RoomCallSignalPayload> | null | undefined
): RoomCallSignalPayload | null {
  if (!raw || raw.v !== 1) return null
  if (!raw.action || !VALID_ROOM_ACTIONS.has(raw.action)) return null
  if (typeof raw.serverId !== 'string' || !raw.serverId.trim()) return null
  if (typeof raw.roomId !== 'string' || !raw.roomId.trim()) return null
  return {
    v: 1,
    action: raw.action,
    serverId: raw.serverId.trim().slice(0, 96),
    roomId: raw.roomId.trim().slice(0, 48),
    targetPubkey:
      typeof raw.targetPubkey === 'string' && /^[0-9a-f]{64}$/i.test(raw.targetPubkey)
        ? raw.targetPubkey.toLowerCase()
        : undefined,
    nickname: typeof raw.nickname === 'string' ? raw.nickname.trim().slice(0, 32) : undefined,
    media: raw.media === 'audio' || raw.media === 'video' ? raw.media : undefined,
    sdp: typeof raw.sdp === 'string' && raw.sdp.length <= 65_536 ? raw.sdp : undefined,
    candidate: raw.candidate && typeof raw.candidate === 'object' && !Array.isArray(raw.candidate) ? raw.candidate : undefined,
    candidates: sanitizeCandidateList(raw.candidates),
    audioMuted: typeof raw.audioMuted === 'boolean' ? raw.audioMuted : undefined,
    videoEnabled: typeof raw.videoEnabled === 'boolean' ? raw.videoEnabled : undefined,
    screenSharing: typeof raw.screenSharing === 'boolean' ? raw.screenSharing : undefined,
    recording: typeof raw.recording === 'boolean' ? raw.recording : undefined,
    ts: typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : Date.now(),
  }
}

export function validateGeoSignalPayload(
  raw: Partial<GeoCallSignalPayload> | null | undefined
): GeoCallSignalPayload | null {
  if (!raw || raw.v !== 1) return null
  if (!raw.action || !VALID_ROOM_ACTIONS.has(raw.action)) return null
  if (typeof raw.geohash !== 'string' || !isValidBitchatChannelKey(raw.geohash)) return null
  const gh = normalizeBitchatChannelKey(raw.geohash)
  if (!gh) return null
  const roomId =
    typeof raw.roomId === 'string' && raw.roomId.trim()
      ? raw.roomId.trim().slice(0, 64)
      : getGeoCallRoomId(gh)
  return {
    v: 1,
    action: raw.action,
    geohash: gh,
    roomId,
    nickname: typeof raw.nickname === 'string' ? raw.nickname.trim().slice(0, 32) : undefined,
    media: raw.media === 'audio' || raw.media === 'video' ? raw.media : undefined,
    audioMuted: typeof raw.audioMuted === 'boolean' ? raw.audioMuted : undefined,
    videoEnabled: typeof raw.videoEnabled === 'boolean' ? raw.videoEnabled : undefined,
    screenSharing: typeof raw.screenSharing === 'boolean' ? raw.screenSharing : undefined,
    recording: typeof raw.recording === 'boolean' ? raw.recording : undefined,
    ts: typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : Date.now(),
  }
}

/**
 * Builds an unsigned kind:25050 event template for a NIP-44 encrypted direct call signal.
 */
export async function buildDirectCallSignalTemplate(opts: {
  material: SigningKeyMaterial
  recipientPubkey: string
  payload: DirectCallSignalPayload
}): Promise<EventTemplate> {
  const recipient = opts.recipientPubkey.toLowerCase()
  const ciphertext = await encryptNip44Signal(opts.material, recipient, JSON.stringify(opts.payload))
  return {
    kind: KIND_CALL_SIGNAL,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', recipient],
      ['t', DM_CALL_SIGNAL_TAG],
    ],
    content: ciphertext,
  }
}

/**
 * Decrypts and validates an incoming NIP-44 direct kind:25050 call signal event.
 */
export async function parseDirectCallSignalEvent(
  event: NostrEvent,
  material: SigningKeyMaterial
): Promise<DirectCallSignalPayload | null> {
  if (event.kind !== KIND_CALL_SIGNAL) return null
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - event.created_at) > MAX_SIGNAL_AGE_SEC) return null
  const plaintext = await decryptNip44Signal(material, event.pubkey, event.content)
  if (!plaintext) return null
  try {
    const parsed = JSON.parse(plaintext) as Partial<DirectCallSignalPayload>
    return validateDirectSignalPayload(parsed)
  } catch {
    return null
  }
}

/**
 * Builds an unsigned kind:25050 event template for a Server Room call signal
 * (AES-256-GCM + blinded tag for E2EE Private servers; plaintext JSON + room tag for Public/NIP-29 presence).
 */
export async function buildRoomCallSignalTemplate(opts: {
  server: Pick<ServerSummary, 'id' | 'encrypted' | 'encryptionKeyB64'>
  roomId: string
  payload: RoomCallSignalPayload
}): Promise<EventTemplate> {
  const roomTag = getServerCallRoomTag(opts.server, opts.roomId)
  let content: string
  if (opts.server.encrypted && opts.server.encryptionKeyB64) {
    content = await encryptE2eeRoomSignal(opts.server.encryptionKeyB64, opts.payload)
  } else {
    content = JSON.stringify(opts.payload)
  }
  return {
    kind: KIND_CALL_SIGNAL,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['t', roomTag]],
    content,
  }
}

/**
 * Parses (and decrypts when E2EE) an incoming kind:25050 server room signal event.
 */
export async function parseRoomCallSignalEvent(
  event: NostrEvent,
  server: Pick<ServerSummary, 'id' | 'encrypted' | 'encryptionKeyB64'>
): Promise<RoomCallSignalPayload | null> {
  if (event.kind !== KIND_CALL_SIGNAL) return null
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - event.created_at) > MAX_SIGNAL_AGE_SEC) return null

  if (server.encrypted) {
    if (!server.encryptionKeyB64) return null
    const decrypted = await decryptE2eeRoomSignal(server.encryptionKeyB64, event.content)
    if (!decrypted || decrypted.serverId !== server.id) return null
    return decrypted
  }

  try {
    const parsed = JSON.parse(event.content) as Partial<RoomCallSignalPayload>
    const validated = validateRoomSignalPayload(parsed)
    if (!validated || validated.serverId !== server.id) return null
    return validated
  } catch {
    return null
  }
}

/**
 * Builds an unsigned kind:25050 event template for a Bitchat room presence/state signal.
 * Uses an isolated `['t', 'agnostr-call-geo-<geohash>']` tag (never `#g`) so legacy
 * Bitchat kind:20000 clients never see call signaling.
 */
export function buildGeoCallSignalTemplate(opts: {
  geohash: string
  payload: GeoCallSignalPayload
}): EventTemplate {
  const roomTag = getGeoCallRoomTag(opts.geohash)
  return {
    kind: KIND_CALL_SIGNAL,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['t', roomTag]],
    content: JSON.stringify(opts.payload),
  }
}

/**
 * Parses and validates an incoming kind:25050 Bitchat room presence/state signal event.
 */
export function parseGeoCallSignalEvent(
  event: NostrEvent,
  expectedGeohash: string
): GeoCallSignalPayload | null {
  if (event.kind !== KIND_CALL_SIGNAL) return null
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - event.created_at) > MAX_SIGNAL_AGE_SEC) return null
  const expected = normalizeBitchatChannelKey(expectedGeohash) ?? normalizeGeohash(expectedGeohash)
  try {
    const parsed = JSON.parse(event.content) as Partial<GeoCallSignalPayload>
    const validated = validateGeoSignalPayload(parsed)
    if (!validated || validated.geohash !== expected) return null
    return validated
  } catch {
    return null
  }
}

/**
 * Gently optimizes Opus `a=fmtp` lines in an SDP string to enable DTX (discontinuous
 * transmission) and cap average audio bitrate at 32 kbps for ultra-low voice bandwidth.
 */
export function optimizeOpusSdp(sdp: string): string {
  if (!sdp || !sdp.includes('opus/48000')) return sdp
  const lineBreak = sdp.includes('\r\n') ? '\r\n' : '\n'
  const lines = sdp.split(/\r?\n/)

  const opusPayloadTypes = new Set<string>()
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+)\s+opus\/48000/i.exec(line)
    if (m) opusPayloadTypes.add(m[1])
  }
  if (opusPayloadTypes.size === 0) return sdp

  const out: string[] = []
  const seenFmtp = new Set<string>()

  for (const line of lines) {
    const fmtpMatch = /^a=fmtp:(\d+)\s+(.*)$/i.exec(line)
    if (fmtpMatch && opusPayloadTypes.has(fmtpMatch[1])) {
      const pt = fmtpMatch[1]
      seenFmtp.add(pt)
      let params = fmtpMatch[2].trim()
      if (!/(?:^|;)usedtx=/i.test(params)) {
        params = params ? `${params};usedtx=1` : 'usedtx=1'
      }
      if (!/(?:^|;)maxaveragebitrate=/i.test(params)) {
        params = `${params};maxaveragebitrate=32000`
      }
      out.push(`a=fmtp:${pt} ${params}`)
    } else {
      out.push(line)
    }
  }

  // If any Opus payload type had no fmtp line, add one cleanly right after its rtpmap line
  if (seenFmtp.size < opusPayloadTypes.size) {
    const withAdded: string[] = []
    for (const line of out) {
      withAdded.push(line)
      const rtpmapMatch = /^a=rtpmap:(\d+)\s+opus\/48000/i.exec(line)
      if (rtpmapMatch && !seenFmtp.has(rtpmapMatch[1])) {
        withAdded.push(`a=fmtp:${rtpmapMatch[1]} minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=32000`)
      }
    }
    return withAdded.join(lineBreak)
  }

  return out.join(lineBreak)
}
