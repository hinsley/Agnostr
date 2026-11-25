import { nip44, type Event as NostrEvent, type EventTemplate } from 'nostr-tools'
import type {
  GameSignalPayload,
  GoGameConfig,
  PokerCardRank,
  PokerCardSuit,
  PokerGamePhase,
  PokerWireCard,
} from '../types/games.ts'
import type { ServerSummary } from '../types/servers.ts'
import { isValidBitchatChannelKey, normalizeBitchatChannelKey } from './bitchatChannel.ts'
import { verifyEventCached } from './bitchatProtocol.ts'
import { CALL_SIGNALING_RELAYS } from './callSignaling.ts'
import { normalizeGeohash } from './geohash.ts'
import { bytesToHex, hexToBytes, type SigningKeyMaterial } from './identity.ts'

/** Ephemeral Nostr event kind for peer-to-peer game signaling (isolated from KIND_CALL_SIGNAL=25050) */
export const KIND_GAME_SIGNAL = 25055

/** Shared `#t` tag for NIP-44 encrypted 1-on-1 DM Chess & Go game signaling */
export const DM_GAME_SIGNAL_TAG = 'agnostr-game-dm-v1'

/** Isolated `#t` tag for NIP-44 encrypted private Poker hole cards sent strictly to one seat */
export const POKER_HOLE_SIGNAL_TAG = 'agnostr-game-hole-v1'

/** Prefix for AES-256-GCM encrypted game signals inside E2EE Private Groups */
export const E2EE_GAME_PAYLOAD_PREFIX = 'agnostr-game-e2ee-v1:'

/** Max age window for accepting ephemeral game signals (180s skew & reconnect tolerance) */
export const MAX_GAME_SIGNAL_AGE_SEC = 180

/** Public Nostr relays verified for ephemeral signaling with `#p` & `#t` echo */
export const GAME_SIGNALING_RELAYS: readonly string[] = CALL_SIGNALING_RELAYS

/** Supports standard `ServerSummary` (`encryptionKeyB64`) as well as optional `encryptionKeyHex` */
export type GameServerCryptoInfo = Pick<ServerSummary, 'id' | 'encrypted' | 'encryptionKeyB64'> & {
  encryptionKeyHex?: string
}

export type GameSigningKey = SigningKeyMaterial | Uint8Array

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

const VALID_POKER_PHASES = new Set<PokerGamePhase>([
  'lobby',
  'preflop',
  'flop',
  'turn',
  'river',
  'showdown',
  'finished',
])

const VALID_POKER_SUITS = new Set<PokerCardSuit>(['s', 'h', 'd', 'c'])
const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/i
const MAX_JSON_BLOB_LEN = 128_000

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

function resolveServerAesKeyBytes(server: GameServerCryptoInfo): Uint8Array | null {
  if (server.encryptionKeyB64) {
    const b64Bytes = base64UrlDecode(server.encryptionKeyB64)
    if (b64Bytes && b64Bytes.length === 32) return b64Bytes
  }
  if (server.encryptionKeyHex && /^[0-9a-f]{64}$/i.test(server.encryptionKeyHex.trim())) {
    const hexBytes = hexToBytes(server.encryptionKeyHex.trim())
    if (hexBytes && hexBytes.length === 32) return hexBytes
  }
  return null
}

function isSigningKeyMaterial(key: GameSigningKey): key is SigningKeyMaterial {
  return !(key instanceof Uint8Array)
}

async function encryptNip44GameSignal(
  senderKey: GameSigningKey,
  recipientPubkey: string,
  plaintext: string,
): Promise<string> {
  const target = recipientPubkey.trim().toLowerCase()
  if (!HEX_PUBKEY_RE.test(target)) {
    throw new Error('Invalid recipient pubkey for encrypted game signal.')
  }
  if (isSigningKeyMaterial(senderKey)) {
    if (senderKey.mode === 'extension') {
      if (typeof window === 'undefined' || !window.nostr?.nip44?.encrypt) {
        throw new Error('NIP-07 extension does not support NIP-44 encryption for games.')
      }
      return await window.nostr.nip44.encrypt(target, plaintext)
    }
    if (!senderKey.secretKey) {
      throw new Error('No signing key available for NIP-44 game encryption.')
    }
    const convKey = nip44.v2.utils.getConversationKey(senderKey.secretKey, target)
    return nip44.v2.encrypt(plaintext, convKey)
  }
  const convKey = nip44.v2.utils.getConversationKey(senderKey, target)
  return nip44.v2.encrypt(plaintext, convKey)
}

async function decryptNip44GameSignal(
  recipientKey: GameSigningKey,
  senderPubkey: string,
  ciphertext: string,
): Promise<string | null> {
  const sender = senderPubkey.trim().toLowerCase()
  if (!HEX_PUBKEY_RE.test(sender)) return null
  try {
    if (isSigningKeyMaterial(recipientKey)) {
      if (recipientKey.mode === 'extension') {
        if (typeof window === 'undefined' || !window.nostr?.nip44?.decrypt) return null
        return await window.nostr.nip44.decrypt(sender, ciphertext)
      }
      if (!recipientKey.secretKey) return null
      const convKey = nip44.v2.utils.getConversationKey(recipientKey.secretKey, sender)
      return nip44.v2.decrypt(ciphertext, convKey)
    }
    const convKey = nip44.v2.utils.getConversationKey(recipientKey, sender)
    return nip44.v2.decrypt(ciphertext, convKey)
  } catch {
    return null
  }
}

async function encryptAesGcmGamePayload(keyBytes: Uint8Array, plaintext: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Web Crypto API unavailable for E2EE group game signaling.')
  }
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(keyBytes),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  )
  const plainBytes = utf8Encoder.encode(plaintext)
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    cryptoKey,
    toArrayBuffer(plainBytes),
  )
  const cipherBytes = new Uint8Array(cipherBuf)
  const combined = new Uint8Array(iv.length + cipherBytes.length)
  combined.set(iv, 0)
  combined.set(cipherBytes, iv.length)
  return `${E2EE_GAME_PAYLOAD_PREFIX}${base64UrlEncode(combined)}`
}

async function decryptAesGcmGamePayload(
  keyBytes: Uint8Array,
  rawContent: string,
): Promise<string | null> {
  if (!rawContent.startsWith(E2EE_GAME_PAYLOAD_PREFIX)) return null
  if (typeof crypto === 'undefined' || !crypto.subtle) return null
  const combined = base64UrlDecode(rawContent.slice(E2EE_GAME_PAYLOAD_PREFIX.length))
  if (!combined || combined.length <= 12 + 16) return null
  try {
    const iv = combined.subarray(0, 12)
    const ciphertext = combined.subarray(12)
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(keyBytes),
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    )
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      cryptoKey,
      toArrayBuffer(ciphertext),
    )
    return utf8Decoder.decode(new Uint8Array(plainBuf))
  } catch {
    return null
  }
}

/** Generates a cryptographically random 24-char lowercase hex game/table ID */
export function generateGameId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

/** Isolated `#t` tag for a Group's multiplayer Poker table signaling */
export function getServerGameRoomTag(serverId: string): string {
  return `agnostr-game-srv-${serverId.trim()}`
}

/** Isolated `#t` tag for a Bitchat channel's multiplayer Poker table signaling */
export function getGeoGameRoomTag(channelKey: string): string {
  const normalized = isValidBitchatChannelKey(channelKey)
    ? (normalizeBitchatChannelKey(channelKey) ?? normalizeGeohash(channelKey))
    : normalizeGeohash(channelKey)
  return `agnostr-game-geo-${normalized}`
}

/** Resolves the best signaling relay set for a Group's game room */
export function getRelaysForServerGame(
  server?: Pick<ServerSummary, 'relays' | 'relayUrl'> | null,
): string[] {
  const set = new Set<string>(GAME_SIGNALING_RELAYS)
  if (server?.relays) {
    for (const r of server.relays) {
      if (r.startsWith('wss://')) set.add(r)
    }
  }
  return Array.from(set).slice(0, 6)
}

function asNonEmptyId(val: unknown, maxLen = 64): string | null {
  if (typeof val !== 'string') return null
  const clean = val.trim()
  if (!clean || clean.length > maxLen) return null
  return clean
}

function asOptionalText(val: unknown, maxLen = 48): string | undefined {
  if (typeof val !== 'string') return undefined
  const clean = val.trim()
  return clean ? clean.slice(0, maxLen) : undefined
}

function asFiniteInt(val: unknown, min: number, max: number): number | null {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null
  const n = Math.floor(val)
  if (n < min || n > max) return null
  return n
}

function asTimestamp(val: unknown): number {
  return typeof val === 'number' && Number.isFinite(val) && val > 0 ? val : Date.now()
}

function sanitizeGoConfig(raw: unknown): GoGameConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const boardSize = obj.boardSize
  if (boardSize !== 9 && boardSize !== 13 && boardSize !== 19) return undefined
  const komi = obj.komi
  if (typeof komi !== 'number' || !Number.isFinite(komi) || komi < -100 || komi > 100) {
    return undefined
  }
  const handicap = asFiniteInt(obj.handicap, 0, boardSize === 9 ? 4 : 9)
  if (handicap === null) return undefined
  const scoring = obj.scoring
  if (scoring !== 'chinese' && scoring !== 'japanese') return undefined
  return { boardSize, komi, handicap, scoring }
}

function sanitizePokerCard(raw: unknown): PokerWireCard | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const rank = asFiniteInt(obj.rank, 2, 14)
  if (rank === null) return null
  if (typeof obj.suit !== 'string' || !VALID_POKER_SUITS.has(obj.suit as PokerCardSuit)) {
    return null
  }
  return {
    rank: rank as PokerCardRank,
    suit: obj.suit as PokerCardSuit,
  }
}

/**
 * Strictly validates an untrusted parsed JSON object against the `GameSignalPayload` union.
 */
export function validateGameSignalPayload(raw: unknown): GameSignalPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (obj.v !== 1 || typeof obj.type !== 'string') return null
  const ts = asTimestamp(obj.ts)

  switch (obj.type) {
    case 'game-invite': {
      const gameId = asNonEmptyId(obj.gameId)
      const kind = obj.kind === 'chess' || obj.kind === 'go' ? obj.kind : null
      const challengerColor =
        obj.challengerColor === 'w' || obj.challengerColor === 'b' ? obj.challengerColor : null
      if (!gameId || !kind || !challengerColor) return null
      const goConfig = kind === 'go' ? sanitizeGoConfig(obj.goConfig) : undefined
      if (kind === 'go' && !goConfig) return null
      return {
        v: 1,
        type: 'game-invite',
        gameId,
        kind,
        challengerColor,
        displayName: asOptionalText(obj.displayName, 40),
        goConfig,
        ts,
      }
    }

    case 'game-accept': {
      const gameId = asNonEmptyId(obj.gameId)
      const kind = obj.kind === 'chess' || obj.kind === 'go' ? obj.kind : null
      if (!gameId || !kind) return null
      return {
        v: 1,
        type: 'game-accept',
        gameId,
        kind,
        displayName: asOptionalText(obj.displayName, 40),
        ts,
      }
    }

    case 'game-decline': {
      const gameId = asNonEmptyId(obj.gameId)
      if (!gameId) return null
      return {
        v: 1,
        type: 'game-decline',
        gameId,
        reason: asOptionalText(obj.reason, 120),
        ts,
      }
    }

    case 'game-move': {
      const gameId = asNonEmptyId(obj.gameId)
      const kind = obj.kind === 'chess' || obj.kind === 'go' ? obj.kind : null
      const seq = asFiniteInt(obj.seq, 0, 100_000)
      if (!gameId || !kind || seq === null) return null
      if (typeof obj.move !== 'string' || !obj.move || obj.move.length > 2_048) return null
      return { v: 1, type: 'game-move', gameId, kind, seq, move: obj.move, ts }
    }

    case 'game-scoring-toggle': {
      const gameId = asNonEmptyId(obj.gameId)
      const seq = asFiniteInt(obj.seq, 0, 100_000)
      const row = asFiniteInt(obj.row, 0, 18)
      const col = asFiniteInt(obj.col, 0, 18)
      if (!gameId || seq === null || row === null || col === null) return null
      return { v: 1, type: 'game-scoring-toggle', gameId, seq, row, col, ts }
    }

    case 'game-scoring-accept': {
      const gameId = asNonEmptyId(obj.gameId)
      const seq = asFiniteInt(obj.seq, 0, 100_000)
      if (!gameId || seq === null) return null
      return { v: 1, type: 'game-scoring-accept', gameId, seq, ts }
    }

    case 'game-scoring-resume': {
      const gameId = asNonEmptyId(obj.gameId)
      const seq = asFiniteInt(obj.seq, 0, 100_000)
      if (!gameId || seq === null) return null
      return { v: 1, type: 'game-scoring-resume', gameId, seq, ts }
    }

    case 'game-draw-offer': {
      const gameId = asNonEmptyId(obj.gameId)
      if (!gameId) return null
      return { v: 1, type: 'game-draw-offer', gameId, ts }
    }

    case 'game-draw-response': {
      const gameId = asNonEmptyId(obj.gameId)
      if (!gameId || typeof obj.accept !== 'boolean') return null
      return { v: 1, type: 'game-draw-response', gameId, accept: obj.accept, ts }
    }

    case 'game-resign': {
      const gameId = asNonEmptyId(obj.gameId)
      if (!gameId) return null
      return { v: 1, type: 'game-resign', gameId, ts }
    }

    case 'game-end': {
      const gameId = asNonEmptyId(obj.gameId)
      if (!gameId) return null
      return { v: 1, type: 'game-end', gameId, reason: asOptionalText(obj.reason, 120), ts }
    }

    case 'game-sync-req': {
      const gameId = asNonEmptyId(obj.gameId)
      const lastSeq = asFiniteInt(obj.lastSeq, 0, 100_000)
      if (!gameId || lastSeq === null) return null
      return { v: 1, type: 'game-sync-req', gameId, lastSeq, ts }
    }

    case 'game-sync-state': {
      const gameId = asNonEmptyId(obj.gameId)
      const kind = obj.kind === 'chess' || obj.kind === 'go' ? obj.kind : null
      const seq = asFiniteInt(obj.seq, 0, 100_000)
      if (!gameId || !kind || seq === null) return null
      if (typeof obj.stateJson !== 'string' || !obj.stateJson || obj.stateJson.length > MAX_JSON_BLOB_LEN) {
        return null
      }
      return { v: 1, type: 'game-sync-state', gameId, kind, seq, stateJson: obj.stateJson, ts }
    }

    case 'poker-announce': {
      const tableId = asNonEmptyId(obj.tableId)
      const scope = obj.scope === 'geo' || obj.scope === 'server' ? obj.scope : null
      const targetId = asNonEmptyId(obj.targetId, 96)
      const hostPubkey =
        typeof obj.hostPubkey === 'string' && HEX_PUBKEY_RE.test(obj.hostPubkey)
          ? obj.hostPubkey.toLowerCase()
          : null
      const hostDisplayName = asOptionalText(obj.hostDisplayName, 40) ?? 'Host'
      const fixedBuyIn = asFiniteInt(obj.fixedBuyIn, 10, 10_000_000)
      const smallBlind = asFiniteInt(obj.smallBlind, 1, 1_000_000)
      const bigBlind = asFiniteInt(obj.bigBlind, 2, 2_000_000)
      const seatedCount = asFiniteInt(obj.seatedCount, 0, 8)
      const maxSeats = asFiniteInt(obj.maxSeats, 2, 8)
      const phase =
        typeof obj.phase === 'string' && VALID_POKER_PHASES.has(obj.phase as PokerGamePhase)
          ? (obj.phase as PokerGamePhase)
          : null
      if (
        !tableId ||
        !scope ||
        !targetId ||
        !hostPubkey ||
        fixedBuyIn === null ||
        smallBlind === null ||
        bigBlind === null ||
        seatedCount === null ||
        maxSeats === null ||
        !phase
      ) {
        return null
      }
      return {
        v: 1,
        type: 'poker-announce',
        tableId,
        scope,
        targetId,
        hostPubkey,
        hostDisplayName,
        fixedBuyIn,
        smallBlind,
        bigBlind,
        seatedCount,
        maxSeats,
        phase,
        ts,
      }
    }

    case 'poker-state': {
      const tableId = asNonEmptyId(obj.tableId)
      const seq = asFiniteInt(obj.seq, 0, 1_000_000)
      if (!tableId || seq === null) return null
      if (
        typeof obj.publicState !== 'string' ||
        !obj.publicState ||
        obj.publicState.length > MAX_JSON_BLOB_LEN
      ) {
        return null
      }
      return { v: 1, type: 'poker-state', tableId, seq, publicState: obj.publicState, ts }
    }

    case 'poker-join': {
      const tableId = asNonEmptyId(obj.tableId)
      if (!tableId) return null
      return {
        v: 1,
        type: 'poker-join',
        tableId,
        displayName: asOptionalText(obj.displayName, 40) ?? 'Player',
        ts,
      }
    }

    case 'poker-leave': {
      const tableId = asNonEmptyId(obj.tableId)
      if (!tableId) return null
      return { v: 1, type: 'poker-leave', tableId, ts }
    }

    case 'poker-start': {
      const tableId = asNonEmptyId(obj.tableId)
      if (!tableId) return null
      return { v: 1, type: 'poker-start', tableId, ts }
    }

    case 'poker-action': {
      const tableId = asNonEmptyId(obj.tableId)
      const handNumber = asFiniteInt(obj.handNumber, 1, 1_000_000)
      if (!tableId || handNumber === null) return null
      if (typeof obj.action !== 'string' || !obj.action || obj.action.length > 1_024) return null
      return { v: 1, type: 'poker-action', tableId, handNumber, action: obj.action, ts }
    }

    case 'poker-end': {
      const tableId = asNonEmptyId(obj.tableId)
      if (!tableId) return null
      return { v: 1, type: 'poker-end', tableId, reason: asOptionalText(obj.reason, 120), ts }
    }

    case 'poker-hole-cards': {
      const tableId = asNonEmptyId(obj.tableId)
      const handNumber = asFiniteInt(obj.handNumber, 1, 1_000_000)
      if (!tableId || handNumber === null || !Array.isArray(obj.cards) || obj.cards.length !== 2) {
        return null
      }
      const c1 = sanitizePokerCard(obj.cards[0])
      const c2 = sanitizePokerCard(obj.cards[1])
      if (!c1 || !c2) return null
      return { v: 1, type: 'poker-hole-cards', tableId, handNumber, cards: [c1, c2], ts }
    }

    default:
      return null
  }
}

function isFreshSignalEvent(event: NostrEvent): boolean {
  if (event.kind !== KIND_GAME_SIGNAL) return false
  const nowSec = Math.floor(Date.now() / 1000)
  return Math.abs(nowSec - event.created_at) <= MAX_GAME_SIGNAL_AGE_SEC
}

/**
 * Builds an unsigned `kind: 25055` event template for a NIP-44 encrypted direct game signal
 * (used for 1-on-1 DM Chess/Go and private Poker hole cards).
 */
export async function buildDirectGameSignalTemplate(
  payload: GameSignalPayload,
  senderSecKey: GameSigningKey,
  recipientPubkey: string,
  tag: string = DM_GAME_SIGNAL_TAG,
): Promise<EventTemplate> {
  const recipient = recipientPubkey.trim().toLowerCase()
  const ciphertext = await encryptNip44GameSignal(senderSecKey, recipient, JSON.stringify(payload))
  return {
    kind: KIND_GAME_SIGNAL,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', recipient],
      ['t', tag],
    ],
    content: ciphertext,
  }
}

/**
 * Cryptographically verifies (`verifyEventCached`), NIP-44 decrypts, and validates
 * an incoming direct `kind: 25055` game signal event.
 */
export async function parseDirectGameSignalEvent(
  event: NostrEvent,
  recipientSecKey: GameSigningKey,
): Promise<GameSignalPayload | null> {
  if (!isFreshSignalEvent(event)) return null
  if (!verifyEventCached(event)) return null
  const plaintext = await decryptNip44GameSignal(recipientSecKey, event.pubkey, event.content)
  if (!plaintext) return null
  try {
    const parsed: unknown = JSON.parse(plaintext)
    return validateGameSignalPayload(parsed)
  } catch {
    return null
  }
}

/**
 * Builds an unsigned `kind: 25055` event template for a Group room Poker signal:
 * - E2EE Private Group: AES-256-GCM encrypted with the group key
 * - Public / NIP-29 Group: plaintext JSON
 */
export async function buildServerGameSignalTemplate(
  payload: GameSignalPayload,
  server: GameServerCryptoInfo,
): Promise<EventTemplate> {
  const roomTag = getServerGameRoomTag(server.id)
  const serialized = JSON.stringify(payload)
  let content = serialized
  if (server.encrypted) {
    const keyBytes = resolveServerAesKeyBytes(server)
    if (!keyBytes) {
      throw new Error('Missing valid 256-bit E2EE group key for encrypted game signaling.')
    }
    content = await encryptAesGcmGamePayload(keyBytes, serialized)
  }
  return {
    kind: KIND_GAME_SIGNAL,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['t', roomTag]],
    content,
  }
}

/**
 * Cryptographically verifies (`verifyEventCached`), decrypts (if E2EE), and validates
 * an incoming Group room `kind: 25055` game signal event.
 */
export async function parseServerGameSignalEvent(
  event: NostrEvent,
  server: GameServerCryptoInfo,
): Promise<GameSignalPayload | null> {
  if (!isFreshSignalEvent(event)) return null
  if (!verifyEventCached(event)) return null

  if (server.encrypted) {
    const keyBytes = resolveServerAesKeyBytes(server)
    if (!keyBytes) return null
    const plaintext = await decryptAesGcmGamePayload(keyBytes, event.content)
    if (!plaintext) return null
    try {
      const parsed: unknown = JSON.parse(plaintext)
      return validateGameSignalPayload(parsed)
    } catch {
      return null
    }
  }

  try {
    const parsed: unknown = JSON.parse(event.content)
    return validateGameSignalPayload(parsed)
  } catch {
    return null
  }
}

/**
 * Builds an unsigned `kind: 25055` event template for a Bitchat channel Poker signal
 * using an isolated `#t` tag (`agnostr-game-geo-<normalizedKey>`).
 */
export function buildGeoGameSignalTemplate(
  payload: GameSignalPayload,
  channelKey: string,
): EventTemplate {
  const roomTag = getGeoGameRoomTag(channelKey)
  return {
    kind: KIND_GAME_SIGNAL,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['t', roomTag]],
    content: JSON.stringify(payload),
  }
}

/**
 * Cryptographically verifies (`verifyEventCached`) and validates an incoming
 * Bitchat channel `kind: 25055` game signal event.
 */
export function parseGeoGameSignalEvent(event: NostrEvent): GameSignalPayload | null {
  if (!isFreshSignalEvent(event)) return null
  if (!verifyEventCached(event)) return null
  try {
    const parsed: unknown = JSON.parse(event.content)
    return validateGameSignalPayload(parsed)
  } catch {
    return null
  }
}
