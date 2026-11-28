import { sha256 } from '@noble/hashes/sha256'
import type { Event as NostrEvent, EventTemplate } from 'nostr-tools'
import type {
  TorrentAttachment,
  TorrentEncryption,
  TorrentShareStatus,
} from '../types/torrent.ts'
import { getTagValue, hasTagPair, verifyEventCached } from './bitchatProtocol.ts'
import {
  CALL_SIGNALING_RELAYS,
  decryptNip44Signal,
  encryptNip44Signal,
} from './callSignaling.ts'
import { bytesToHex, hexToBytes, type SigningKeyMaterial } from './identity.ts'

/** Dedicated ephemeral Nostr event kind for P2P torrent swarm & WebRTC signaling */
export const KIND_TORRENT_SIGNAL = 25057

/** Parameterized replaceable event kind for persistent sender-signed open/closed share status */
export const KIND_TORRENT_STATUS = 30078

/** Chat event tag carrying compact E2EE torrent metadata */
export const TORRENT_TAG_NAME = 'agnostr-torrent'

/** Tag identifying replaceable torrent open/closed status records */
export const TORRENT_STATUS_TAG = 'agnostr-torrent-status'

/** Prefix for blinded swarm discovery/revocation `#t` tags (`agnostr-torrent-<swarmId>`) */
export const TORRENT_SWARM_TAG_PREFIX = 'agnostr-torrent-'

/** Shared `#t` tag for NIP-44 encrypted direct peer-to-peer WebRTC signaling */
export const TORRENT_DIRECT_SIGNAL_TAG = 'agnostr-torrent-sig-v1'

/** Maximum supported torrent file size (512 MiB) */
export const MAX_TORRENT_FILE_BYTES = 512 * 1024 * 1024

/** Max age window for accepting ephemeral torrent signaling events (aligned with BLE gateway 120s window) */
export const MAX_TORRENT_SIGNAL_AGE_SEC = 120

/** E2EE chunk size for BLE mesh bridged transfers (~3.2 KB signed NIP-44 kind:25057 JSON, safely < 4096 B gateway limit) */
export const MESH_CHUNK_BYTES = 1280

/** Number of 64-hex piece hashes per paginated mesh-meta-res frame (~2.6 KB signed JSON, safely < 4096 B gateway limit) */
export const MESH_HASHES_PER_PAGE = 20

/** Public Nostr relays verified for ephemeral `#p` and `#t` WebRTC signaling */
export const TORRENT_SIGNALING_RELAYS: readonly string[] = CALL_SIGNALING_RELAYS

const utf8Encoder = new TextEncoder()
const HEX_64_RE = /^[0-9a-f]{64}$/i
const HEX_32_RE = /^[0-9a-f]{32}$/i
const MIN_PIECE_LENGTH = 16 * 1024
const MAX_PIECE_LENGTH = 2 * 1024 * 1024

const RISKY_EXECUTABLE_EXTENSIONS = new Set<string>([
  'exe',
  'msi',
  'msp',
  'com',
  'bat',
  'cmd',
  'ps1',
  'psm1',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'wsh',
  'scr',
  'pif',
  'cpl',
  'msc',
  'hta',
  'inf',
  'reg',
  'dll',
  'sys',
  'drv',
  'app',
  'dmg',
  'pkg',
  'command',
  'sh',
  'bash',
  'zsh',
  'csh',
  'ksh',
  'run',
  'bin',
  'elf',
  'deb',
  'rpm',
  'apk',
  'ipa',
  'jar',
  'jnlp',
  'py',
  'rb',
  'pl',
  'php',
  'lnk',
  'url',
  'desktop',
  'iso',
  'img',
  'vhd',
  'vhdx',
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'cab',
  'docm',
  'xlsm',
  'pptm',
  'dotm',
  'xltm',
])

export type TorrentSwarmBroadcastAction = 'seek' | 'here' | 'closed'

export interface TorrentSwarmBroadcastPayload {
  v: 1
  action: TorrentSwarmBroadcastAction
  swarmId: string
  nonce?: string
  authProof?: string
  piecesHave?: number
  pieceCount?: number
  closedAt?: number
  meshOnly?: boolean
  ts: number
}

export type TorrentDirectSignalAction =
  | 'offer'
  | 'answer'
  | 'ice'
  | 'seek'
  | 'mesh-meta-req'
  | 'mesh-meta-res'
  | 'mesh-chunk-req'
  | 'mesh-chunk-res'

export interface TorrentWebRtcDirectSignalPayload {
  v: 1
  action: 'offer' | 'answer' | 'ice' | 'seek'
  infoHash: string
  swarmId: string
  sessionId: string
  nonce: string
  authProof: string
  sdp?: string
  candidate?: RTCIceCandidateInit
  candidates?: RTCIceCandidateInit[]
  meshOnly?: boolean
  ts: number
}

export interface TorrentMeshMetaReqPayload {
  v: 1
  action: 'mesh-meta-req'
  infoHash: string
  swarmId: string
  nonce?: string
  authProof: string
  offset?: number
  ts: number
}

export interface TorrentMeshMetaResPayload {
  v: 1
  action: 'mesh-meta-res'
  infoHash: string
  swarmId: string
  offset: number
  totalHashes: number
  hashes: string[]
  ts: number
}

export interface TorrentMeshChunkReqPayload {
  v: 1
  action: 'mesh-chunk-req'
  infoHash: string
  swarmId: string
  nonce?: string
  authProof: string
  pieceIndex: number
  chunkIndex: number
  chunkSize: number
  ts: number
}

export interface TorrentMeshChunkResPayload {
  v: 1
  action: 'mesh-chunk-res'
  infoHash: string
  swarmId: string
  pieceIndex: number
  chunkIndex: number
  totalChunks: number
  totalPieceBytes: number
  dataB64: string
  ts: number
}

export type TorrentDirectSignalPayload =
  | TorrentWebRtcDirectSignalPayload
  | TorrentMeshMetaReqPayload
  | TorrentMeshMetaResPayload
  | TorrentMeshChunkReqPayload
  | TorrentMeshChunkResPayload

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(str: string): Uint8Array | null {
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

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export function selectTorrentPieceLength(size: number): number {
  if (!Number.isFinite(size) || size <= 4 * 1024 * 1024) {
    return 64 * 1024 // 64 KiB
  }
  if (size <= 64 * 1024 * 1024) {
    return 256 * 1024 // 256 KiB
  }
  return 512 * 1024 // 512 KiB
}

export function sanitizeTorrentFileName(raw: string): string {
  if (typeof raw !== 'string') return 'shared-file.bin'
  const baseSegment = raw.split(/[/\\]+/).filter(Boolean).pop() ?? ''
  const cleaned = baseSegment
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim()
  if (!cleaned) return 'shared-file.bin'
  if (cleaned.length <= 160) return cleaned
  const dotIdx = cleaned.lastIndexOf('.')
  if (dotIdx > 0 && cleaned.length - dotIdx <= 14) {
    const ext = cleaned.slice(dotIdx)
    return `${cleaned.slice(0, 160 - ext.length)}${ext}`
  }
  return cleaned.slice(0, 160)
}

export function formatTorrentBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let val = bytes / 1024
  let unitIdx = 0
  while (val >= 1024 && unitIdx < units.length - 1) {
    val /= 1024
    unitIdx += 1
  }
  const decimals = val >= 100 ? 0 : val >= 10 ? 1 : 2
  return `${val.toFixed(decimals)} ${units[unitIdx]}`
}

export function formatTorrentSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s'
  return `${formatTorrentBytes(bytesPerSec)}/s`
}

export function getTorrentFileExtension(fileName: string): string {
  const safe = sanitizeTorrentFileName(fileName)
  const dotIdx = safe.lastIndexOf('.')
  if (dotIdx <= 0 || dotIdx === safe.length - 1) return ''
  const ext = safe.slice(dotIdx + 1).toLowerCase()
  return /^[a-z0-9]{1,12}$/.test(ext) ? ext : ''
}

export function isRiskyExecutableExtension(fileName: string): boolean {
  const ext = getTorrentFileExtension(fileName)
  return ext.length > 0 && RISKY_EXECUTABLE_EXTENSIONS.has(ext)
}

export function formatTorrentFallbackText(
  torrent: Pick<TorrentAttachment, 'fileName' | 'size'>
): string {
  return `📦 ${sanitizeTorrentFileName(torrent.fileName)} (${formatTorrentBytes(torrent.size)})`
}

export function generateTorrentEncryption(): TorrentEncryption {
  const key = new Uint8Array(32)
  const noncePrefix = new Uint8Array(8)
  crypto.getRandomValues(key)
  crypto.getRandomValues(noncePrefix)
  return {
    alg: 'aes-gcm-256',
    keyB64: base64UrlEncode(key),
    noncePrefixB64: base64UrlEncode(noncePrefix),
  }
}

export function derivePieceIv(noncePrefixBytes: Uint8Array, pieceIndex: number): Uint8Array {
  if (noncePrefixBytes.length !== 8) {
    throw new Error('Torrent nonce prefix must be exactly 8 bytes.')
  }
  if (!Number.isInteger(pieceIndex) || pieceIndex < 0 || pieceIndex > 0xffffffff) {
    throw new Error('Invalid torrent piece index for IV derivation.')
  }
  const iv = new Uint8Array(12)
  iv.set(noncePrefixBytes, 0)
  const view = new DataView(iv.buffer)
  view.setUint32(8, pieceIndex, false)
  return iv
}

function buildPieceAad(infoHash: string, pieceIndex: number): Uint8Array {
  return utf8Encoder.encode(`agnostr-torrent-v1:${infoHash.toLowerCase()}:${pieceIndex}`)
}

export async function encryptTorrentPiece(params: {
  keyBytes: Uint8Array
  noncePrefixBytes: Uint8Array
  infoHash: string
  pieceIndex: number
  plaintext: Uint8Array
}): Promise<Uint8Array> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Web Crypto API is required for E2EE torrent encryption.')
  }
  if (params.keyBytes.length !== 32) {
    throw new Error('Torrent AES-256-GCM key must be 32 bytes.')
  }
  const iv = derivePieceIv(params.noncePrefixBytes, params.pieceIndex)
  const aad = buildPieceAad(params.infoHash, params.pieceIndex)
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(params.keyBytes),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  )
  const cipherBuf = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad),
    },
    cryptoKey,
    toArrayBuffer(params.plaintext)
  )
  return new Uint8Array(cipherBuf)
}

export async function decryptTorrentPiece(params: {
  keyBytes: Uint8Array
  noncePrefixBytes: Uint8Array
  infoHash: string
  pieceIndex: number
  ciphertext: Uint8Array
}): Promise<Uint8Array | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null
  if (params.keyBytes.length !== 32 || params.noncePrefixBytes.length !== 8) return null
  if (params.ciphertext.length <= 16) return null
  try {
    const iv = derivePieceIv(params.noncePrefixBytes, params.pieceIndex)
    const aad = buildPieceAad(params.infoHash, params.pieceIndex)
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(params.keyBytes),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    )
    const plainBuf = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(aad),
      },
      cryptoKey,
      toArrayBuffer(params.ciphertext)
    )
    return new Uint8Array(plainBuf)
  } catch {
    return null
  }
}

export function computeTorrentMerkleRoot(pieceDigestsHex: readonly string[]): string {
  if (pieceDigestsHex.length === 0) {
    return bytesToHex(sha256(new Uint8Array(0)))
  }
  const leafPrefix = new Uint8Array([0x00])
  const nodePrefix = new Uint8Array([0x01])
  let level: Uint8Array[] = pieceDigestsHex.map((hex) => {
    const clean = hex.trim().toLowerCase()
    if (!HEX_64_RE.test(clean)) {
      throw new Error('Invalid 64-hex piece digest for Merkle root computation.')
    }
    const raw = hexToBytes(clean)
    if (!raw || raw.length !== 32) {
      throw new Error('Invalid 32-byte piece digest for Merkle root computation.')
    }
    return sha256(concatBytes(leafPrefix, raw))
  })

  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]
      const right = level[i + 1] ?? left
      const combined = new Uint8Array(1 + left.length + right.length)
      combined[0] = nodePrefix[0]
      combined.set(left, 1)
      combined.set(right, 1 + left.length)
      next.push(sha256(combined))
    }
    level = next
  }

  return bytesToHex(level[0])
}

export function computeTorrentInfoHash(meta: {
  fileName: string
  mime: string
  size: number
  pieceLength: number
  pieceCount: number
  plaintextSha256: string
  piecesRoot: string
}): string {
  const canonical = JSON.stringify([
    'agnostr-torrent-info-v1',
    sanitizeTorrentFileName(meta.fileName),
    meta.mime.trim() || 'application/octet-stream',
    Math.floor(meta.size),
    Math.floor(meta.pieceLength),
    Math.floor(meta.pieceCount),
    meta.plaintextSha256.trim().toLowerCase(),
    meta.piecesRoot.trim().toLowerCase(),
  ])
  return bytesToHex(sha256(utf8Encoder.encode(canonical)))
}

export function computeTorrentSwarmId(infoHash: string, keyBytes: Uint8Array): string {
  const prefix = utf8Encoder.encode(`agnostr-torrent-swarm-v1:${infoHash.trim().toLowerCase()}:`)
  return bytesToHex(sha256(concatBytes(prefix, keyBytes))).slice(0, 32)
}

export function computeTorrentAuthProof(params: {
  infoHash: string
  swarmId: string
  keyBytes: Uint8Array
  peerPubkey: string
  nonce: string
}): string {
  const prefix = utf8Encoder.encode(
    `agnostr-torrent-auth-v1:${params.infoHash.trim().toLowerCase()}:${params.swarmId.trim().toLowerCase()}:${params.peerPubkey.trim().toLowerCase()}:${params.nonce}:`
  )
  return bytesToHex(sha256(concatBytes(prefix, params.keyBytes)))
}

export function getTorrentSwarmTag(swarmId: string): string {
  return `${TORRENT_SWARM_TAG_PREFIX}${swarmId.trim().toLowerCase()}`
}

export function getTorrentStatusDTag(swarmId: string): string {
  return `${TORRENT_STATUS_TAG}:${swarmId.trim().toLowerCase()}`
}

function sanitizeRelayUrls(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const clean = item.trim()
    if (!/^wss?:\/\/[^\s]+$/i.test(clean) || clean.length > 256) continue
    const lower = clean.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    out.push(clean)
    if (out.length >= 8) break
  }
  return out.length > 0 ? out : undefined
}

export function normalizeTorrentAttachment(
  raw: unknown,
  verifiedSenderPubkey?: string
): TorrentAttachment | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (obj.v !== 1) return null

  const infoHash = typeof obj.infoHash === 'string' ? obj.infoHash.trim().toLowerCase() : ''
  const swarmId = typeof obj.swarmId === 'string' ? obj.swarmId.trim().toLowerCase() : ''
  const plaintextSha256 =
    typeof obj.plaintextSha256 === 'string' ? obj.plaintextSha256.trim().toLowerCase() : ''
  const piecesRoot = typeof obj.piecesRoot === 'string' ? obj.piecesRoot.trim().toLowerCase() : ''
  if (
    !HEX_64_RE.test(infoHash) ||
    !HEX_32_RE.test(swarmId) ||
    !HEX_64_RE.test(plaintextSha256) ||
    !HEX_64_RE.test(piecesRoot)
  ) {
    return null
  }

  const size = typeof obj.size === 'number' && Number.isFinite(obj.size) ? Math.floor(obj.size) : -1
  if (size < 1 || size > MAX_TORRENT_FILE_BYTES) return null

  const pieceLength =
    typeof obj.pieceLength === 'number' && Number.isFinite(obj.pieceLength)
      ? Math.floor(obj.pieceLength)
      : 0
  if (pieceLength < MIN_PIECE_LENGTH || pieceLength > MAX_PIECE_LENGTH) return null

  const expectedPieceCount = Math.ceil(size / pieceLength)
  const pieceCount =
    typeof obj.pieceCount === 'number' && Number.isFinite(obj.pieceCount)
      ? Math.floor(obj.pieceCount)
      : 0
  if (pieceCount !== expectedPieceCount || pieceCount < 1) return null

  const fileName =
    typeof obj.fileName === 'string' ? sanitizeTorrentFileName(obj.fileName) : ''
  if (!fileName) return null

  const rawMime =
    typeof obj.mime === 'string' && obj.mime.trim().length > 0
      ? obj.mime.trim().slice(0, 128)
      : 'application/octet-stream'
  const mime = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;.*)?$/i.test(rawMime)
    ? rawMime
    : 'application/octet-stream'

  const encRaw = obj.encryption
  if (!encRaw || typeof encRaw !== 'object' || Array.isArray(encRaw)) return null
  const encObj = encRaw as Record<string, unknown>
  if (encObj.alg !== 'aes-gcm-256') return null
  const keyB64 = typeof encObj.keyB64 === 'string' ? encObj.keyB64.trim() : ''
  const noncePrefixB64 =
    typeof encObj.noncePrefixB64 === 'string' ? encObj.noncePrefixB64.trim() : ''
  const keyBytes = base64UrlDecode(keyB64)
  const noncePrefixBytes = base64UrlDecode(noncePrefixB64)
  if (!keyBytes || keyBytes.length !== 32 || !noncePrefixBytes || noncePrefixBytes.length !== 8) {
    return null
  }

  // Cryptographically verify infoHash and blinded swarmId match the declared fields & key
  const expectedInfoHash = computeTorrentInfoHash({
    fileName,
    mime,
    size,
    pieceLength,
    pieceCount,
    plaintextSha256,
    piecesRoot,
  })
  if (expectedInfoHash !== infoHash) return null

  const expectedSwarmId = computeTorrentSwarmId(infoHash, keyBytes)
  if (expectedSwarmId !== swarmId) return null

  const relays = sanitizeRelayUrls(obj.relays)
  const createdAt =
    typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt) && obj.createdAt > 0
      ? Math.floor(obj.createdAt)
      : undefined

  // Always bind senderPubkey to verifiedSenderPubkey when provided (never allow JSON spoofing)
  let boundSenderPubkey: string | undefined
  if (typeof verifiedSenderPubkey === 'string' && HEX_64_RE.test(verifiedSenderPubkey.trim())) {
    boundSenderPubkey = verifiedSenderPubkey.trim().toLowerCase()
  } else if (
    typeof obj.senderPubkey === 'string' &&
    HEX_64_RE.test(obj.senderPubkey.trim())
  ) {
    boundSenderPubkey = obj.senderPubkey.trim().toLowerCase()
  }

  return {
    v: 1,
    infoHash,
    swarmId,
    fileName,
    mime,
    size,
    pieceLength,
    pieceCount,
    plaintextSha256,
    piecesRoot,
    encryption: {
      alg: 'aes-gcm-256',
      keyB64,
      noncePrefixB64,
    },
    ...(relays ? { relays } : {}),
    ...(boundSenderPubkey ? { senderPubkey: boundSenderPubkey } : {}),
    ...(createdAt ? { createdAt } : {}),
  }
}

export function buildTorrentTag(torrent: TorrentAttachment): string[] {
  const wirePayload: TorrentAttachment = {
    v: 1,
    infoHash: torrent.infoHash.toLowerCase(),
    swarmId: torrent.swarmId.toLowerCase(),
    fileName: sanitizeTorrentFileName(torrent.fileName),
    mime: torrent.mime || 'application/octet-stream',
    size: torrent.size,
    pieceLength: torrent.pieceLength,
    pieceCount: torrent.pieceCount,
    plaintextSha256: torrent.plaintextSha256.toLowerCase(),
    piecesRoot: torrent.piecesRoot.toLowerCase(),
    encryption: torrent.encryption,
    ...(torrent.relays && torrent.relays.length > 0 ? { relays: torrent.relays.slice(0, 6) } : {}),
    ...(torrent.createdAt ? { createdAt: torrent.createdAt } : {}),
  }
  return [TORRENT_TAG_NAME, JSON.stringify(wirePayload)]
}

export function parseTorrentFromTags(
  tags: readonly string[][],
  verifiedSenderPubkey?: string
): TorrentAttachment | undefined {
  if (!Array.isArray(tags)) return undefined
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== TORRENT_TAG_NAME || typeof tag[1] !== 'string') {
      continue
    }
    if (tag[1].length > 8_192) continue
    try {
      const parsed = JSON.parse(tag[1]) as unknown
      const normalized = normalizeTorrentAttachment(parsed, verifiedSenderPubkey)
      if (normalized) return normalized
    } catch {
      // Ignore malformed tag
    }
  }
  return undefined
}

export function buildTorrentStatusEventTemplate(opts: {
  swarmId: string
  status: TorrentShareStatus
  updatedAt?: number
}): EventTemplate {
  const swarmId = opts.swarmId.trim().toLowerCase()
  const updatedAt =
    typeof opts.updatedAt === 'number' && Number.isFinite(opts.updatedAt) && opts.updatedAt > 0
      ? Math.floor(opts.updatedAt)
      : Date.now()
  return {
    kind: KIND_TORRENT_STATUS,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', getTorrentStatusDTag(swarmId)],
      ['t', TORRENT_STATUS_TAG],
    ],
    content: JSON.stringify({
      v: 1,
      swarmId,
      status: opts.status,
      updatedAt,
    }),
  }
}

export function parseTorrentStatusEvent(
  ev: NostrEvent,
  expectedSwarmId: string,
  expectedSenderPubkey: string
): { swarmId: string; status: TorrentShareStatus; updatedAt: number } | null {
  if (!ev || ev.kind !== KIND_TORRENT_STATUS) return null
  const swarmId = expectedSwarmId.trim().toLowerCase()
  const expectedSender = expectedSenderPubkey.trim().toLowerCase()
  if (!HEX_32_RE.test(swarmId) || !HEX_64_RE.test(expectedSender)) return null
  if (ev.pubkey.trim().toLowerCase() !== expectedSender) return null
  if (!Array.isArray(ev.tags)) return null
  if (getTagValue(ev.tags, 'd') !== getTorrentStatusDTag(swarmId)) return null
  if (!hasTagPair(ev.tags, 't', TORRENT_STATUS_TAG)) return null
  if (!verifyEventCached(ev)) return null

  let parsed: { v?: unknown; swarmId?: unknown; status?: unknown; updatedAt?: unknown }
  try {
    parsed = JSON.parse(ev.content) as {
      v?: unknown
      swarmId?: unknown
      status?: unknown
      updatedAt?: unknown
    }
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) return null
  if (typeof parsed.swarmId !== 'string' || parsed.swarmId.trim().toLowerCase() !== swarmId) {
    return null
  }
  if (parsed.status !== 'active' && parsed.status !== 'closed') return null
  const updatedAt =
    typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) && parsed.updatedAt > 0
      ? Math.floor(parsed.updatedAt)
      : ev.created_at * 1000
  return {
    swarmId,
    status: parsed.status,
    updatedAt,
  }
}

export function buildTorrentSwarmBroadcastTemplate(
  payload: TorrentSwarmBroadcastPayload
): EventTemplate {
  const swarmId = payload.swarmId.trim().toLowerCase()
  return {
    kind: KIND_TORRENT_SIGNAL,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['t', getTorrentSwarmTag(swarmId)]],
    content: JSON.stringify({
      ...payload,
      v: 1,
      swarmId,
    }),
  }
}

export function parseTorrentSwarmBroadcastEvent(
  ev: NostrEvent,
  expectedSwarmId: string,
  nowSec = Math.floor(Date.now() / 1000)
): { senderPubkey: string; payload: TorrentSwarmBroadcastPayload } | null {
  if (!ev || ev.kind !== KIND_TORRENT_SIGNAL) return null
  const swarmId = expectedSwarmId.trim().toLowerCase()
  if (!HEX_32_RE.test(swarmId)) return null
  if (Math.abs(nowSec - ev.created_at) > MAX_TORRENT_SIGNAL_AGE_SEC) return null
  if (!Array.isArray(ev.tags) || !hasTagPair(ev.tags, 't', getTorrentSwarmTag(swarmId))) {
    return null
  }
  if (typeof ev.content !== 'string' || ev.content.length > 4_096) return null
  if (!verifyEventCached(ev)) return null

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(ev.content) as Record<string, unknown>
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.v !== 1) {
    return null
  }
  const action = parsed.action
  if (action !== 'seek' && action !== 'here' && action !== 'closed') return null
  if (typeof parsed.swarmId !== 'string' || parsed.swarmId.trim().toLowerCase() !== swarmId) {
    return null
  }
  const ts =
    typeof parsed.ts === 'number' && Number.isFinite(parsed.ts) && parsed.ts > 0
      ? Math.floor(parsed.ts)
      : ev.created_at * 1000

  return {
    senderPubkey: ev.pubkey.trim().toLowerCase(),
    payload: {
      v: 1,
      action,
      swarmId,
      ...(typeof parsed.nonce === 'string' && parsed.nonce.length <= 64
        ? { nonce: parsed.nonce }
        : {}),
      ...(typeof parsed.authProof === 'string' && HEX_64_RE.test(parsed.authProof)
        ? { authProof: parsed.authProof.toLowerCase() }
        : {}),
      ...(typeof parsed.piecesHave === 'number' && Number.isFinite(parsed.piecesHave)
        ? { piecesHave: Math.max(0, Math.floor(parsed.piecesHave)) }
        : {}),
      ...(typeof parsed.pieceCount === 'number' && Number.isFinite(parsed.pieceCount)
        ? { pieceCount: Math.max(0, Math.floor(parsed.pieceCount)) }
        : {}),
      ...(typeof parsed.closedAt === 'number' && Number.isFinite(parsed.closedAt)
        ? { closedAt: Math.floor(parsed.closedAt) }
        : {}),
      ...(parsed.meshOnly === true ? { meshOnly: true } : {}),
      ts,
    },
  }
}

export async function buildTorrentDirectSignalTemplate(opts: {
  material: SigningKeyMaterial
  recipientPubkey: string
  payload: TorrentDirectSignalPayload
}): Promise<EventTemplate> {
  const recipientPk = opts.recipientPubkey.trim().toLowerCase()
  if (!HEX_64_RE.test(recipientPk)) {
    throw new Error('Invalid recipient pubkey for torrent direct signaling.')
  }
  const ciphertext = await encryptNip44Signal(
    opts.material,
    recipientPk,
    JSON.stringify({
      ...opts.payload,
      v: 1,
      infoHash: opts.payload.infoHash.trim().toLowerCase(),
      swarmId: opts.payload.swarmId.trim().toLowerCase(),
    })
  )
  return {
    kind: KIND_TORRENT_SIGNAL,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', recipientPk],
      ['t', TORRENT_DIRECT_SIGNAL_TAG],
    ],
    content: ciphertext,
  }
}

export async function parseTorrentDirectSignalEvent(
  ev: NostrEvent,
  material: SigningKeyMaterial,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<{ senderPubkey: string; payload: TorrentDirectSignalPayload } | null> {
  if (!ev || ev.kind !== KIND_TORRENT_SIGNAL) return null
  if (Math.abs(nowSec - ev.created_at) > MAX_TORRENT_SIGNAL_AGE_SEC) return null
  if (!Array.isArray(ev.tags) || !hasTagPair(ev.tags, 't', TORRENT_DIRECT_SIGNAL_TAG)) {
    return null
  }
  const recipientPk = material.pubkey.trim().toLowerCase()
  const targetMatch = ev.tags.some(
    (t) =>
      Array.isArray(t) &&
      t[0] === 'p' &&
      typeof t[1] === 'string' &&
      t[1].trim().toLowerCase() === recipientPk
  )
  if (!targetMatch) return null
  if (!verifyEventCached(ev)) return null

  const senderPubkey = ev.pubkey.trim().toLowerCase()
  if (!HEX_64_RE.test(senderPubkey)) return null

  const plaintext = await decryptNip44Signal(material, senderPubkey, ev.content)
  if (!plaintext) return null

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(plaintext) as Record<string, unknown>
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.v !== 1) {
    return null
  }
  const action = parsed.action
  const infoHash = typeof parsed.infoHash === 'string' ? parsed.infoHash.trim().toLowerCase() : ''
  const swarmId = typeof parsed.swarmId === 'string' ? parsed.swarmId.trim().toLowerCase() : ''
  if (!HEX_64_RE.test(infoHash) || !HEX_32_RE.test(swarmId)) {
    return null
  }

  const ts =
    typeof parsed.ts === 'number' && Number.isFinite(parsed.ts) && parsed.ts > 0
      ? Math.floor(parsed.ts)
      : ev.created_at * 1000

  if (action === 'offer' || action === 'answer' || action === 'ice' || action === 'seek') {
    const sessionId =
      typeof parsed.sessionId === 'string' ? parsed.sessionId.trim().slice(0, 64) : ''
    const nonce = typeof parsed.nonce === 'string' ? parsed.nonce.trim().slice(0, 64) : ''
    const authProof =
      typeof parsed.authProof === 'string' ? parsed.authProof.trim().toLowerCase() : ''
    if (!sessionId || !nonce || !HEX_64_RE.test(authProof)) {
      return null
    }
    return {
      senderPubkey,
      payload: {
        v: 1,
        action,
        infoHash,
        swarmId,
        sessionId,
        nonce,
        authProof,
        ...(typeof parsed.sdp === 'string' ? { sdp: parsed.sdp } : {}),
        ...(parsed.candidate && typeof parsed.candidate === 'object'
          ? { candidate: parsed.candidate as RTCIceCandidateInit }
          : {}),
        ...(Array.isArray(parsed.candidates)
          ? { candidates: parsed.candidates.slice(0, 32) as RTCIceCandidateInit[] }
          : {}),
        ...(parsed.meshOnly === true ? { meshOnly: true } : {}),
        ts,
      },
    }
  }

  if (action === 'mesh-meta-req') {
    const authProof =
      typeof parsed.authProof === 'string' ? parsed.authProof.trim().toLowerCase() : ''
    if (!HEX_64_RE.test(authProof)) return null
    const nonce =
      typeof parsed.nonce === 'string' && parsed.nonce.trim().length > 0
        ? parsed.nonce.trim().slice(0, 64)
        : undefined
    const offset =
      typeof parsed.offset === 'number' && Number.isInteger(parsed.offset) && parsed.offset >= 0
        ? parsed.offset
        : 0
    return {
      senderPubkey,
      payload: {
        v: 1,
        action: 'mesh-meta-req',
        infoHash,
        swarmId,
        ...(nonce ? { nonce } : {}),
        authProof,
        offset,
        ts,
      },
    }
  }

  if (action === 'mesh-meta-res') {
    const offset = parsed.offset
    const totalHashes = parsed.totalHashes
    const rawHashes = parsed.hashes
    if (
      typeof offset !== 'number' ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      typeof totalHashes !== 'number' ||
      !Number.isInteger(totalHashes) ||
      totalHashes < 1 ||
      totalHashes > 100_000 ||
      !Array.isArray(rawHashes) ||
      rawHashes.length === 0 ||
      rawHashes.length > MESH_HASHES_PER_PAGE
    ) {
      return null
    }
    const hashes: string[] = []
    for (const h of rawHashes) {
      if (typeof h !== 'string' || !HEX_64_RE.test(h.trim())) return null
      hashes.push(h.trim().toLowerCase())
    }
    return {
      senderPubkey,
      payload: {
        v: 1,
        action: 'mesh-meta-res',
        infoHash,
        swarmId,
        offset,
        totalHashes,
        hashes,
        ts,
      },
    }
  }

  if (action === 'mesh-chunk-req') {
    const authProof =
      typeof parsed.authProof === 'string' ? parsed.authProof.trim().toLowerCase() : ''
    const pieceIndex = parsed.pieceIndex
    const chunkIndex = parsed.chunkIndex
    const chunkSize = parsed.chunkSize
    if (
      !HEX_64_RE.test(authProof) ||
      typeof pieceIndex !== 'number' ||
      !Number.isInteger(pieceIndex) ||
      pieceIndex < 0 ||
      typeof chunkIndex !== 'number' ||
      !Number.isInteger(chunkIndex) ||
      chunkIndex < 0 ||
      typeof chunkSize !== 'number' ||
      !Number.isInteger(chunkSize) ||
      chunkSize < 1 ||
      chunkSize > MESH_CHUNK_BYTES
    ) {
      return null
    }
    const nonce =
      typeof parsed.nonce === 'string' && parsed.nonce.trim().length > 0
        ? parsed.nonce.trim().slice(0, 64)
        : undefined
    return {
      senderPubkey,
      payload: {
        v: 1,
        action: 'mesh-chunk-req',
        infoHash,
        swarmId,
        ...(nonce ? { nonce } : {}),
        authProof,
        pieceIndex,
        chunkIndex,
        chunkSize,
        ts,
      },
    }
  }

  if (action === 'mesh-chunk-res') {
    const pieceIndex = parsed.pieceIndex
    const chunkIndex = parsed.chunkIndex
    const totalChunks = parsed.totalChunks
    const totalPieceBytes = parsed.totalPieceBytes
    const dataB64 = typeof parsed.dataB64 === 'string' ? parsed.dataB64.trim() : ''
    if (
      typeof pieceIndex !== 'number' ||
      !Number.isInteger(pieceIndex) ||
      pieceIndex < 0 ||
      typeof chunkIndex !== 'number' ||
      !Number.isInteger(chunkIndex) ||
      chunkIndex < 0 ||
      typeof totalChunks !== 'number' ||
      !Number.isInteger(totalChunks) ||
      totalChunks < 1 ||
      chunkIndex >= totalChunks ||
      typeof totalPieceBytes !== 'number' ||
      !Number.isInteger(totalPieceBytes) ||
      totalPieceBytes < 17 ||
      totalPieceBytes > MAX_PIECE_LENGTH + 16 ||
      !dataB64 ||
      dataB64.length > 2_400
    ) {
      return null
    }
    return {
      senderPubkey,
      payload: {
        v: 1,
        action: 'mesh-chunk-res',
        infoHash,
        swarmId,
        pieceIndex,
        chunkIndex,
        totalChunks,
        totalPieceBytes,
        dataB64,
        ts,
      },
    }
  }

  return null
}
