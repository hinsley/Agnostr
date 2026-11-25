import { sha256 } from '@noble/hashes/sha256'
import type { Event as NostrEvent, EventTemplate } from 'nostr-tools'
import type { VoiceMemoAttachment, VoiceMemoEncryption } from '../types/protocol.ts'
import { bytesToHex } from './identity.ts'
import { inferInlineRasterMime } from './inlineChatImage.ts'
import {
  decryptAesGcmOffMainThread,
  encryptAesGcmOffMainThread,
  isOffMainThreadWorkerSupported,
  OffMainThreadUnavailableError,
  sha256HexOffMainThread,
} from './offMainThread.ts'

export const KIND_BLOSSOM_AUTH = 24242
export const MAX_MEDIA_BLOB_BYTES = 15 * 1024 * 1024 // 15 MiB safety bound
export const MAX_VOICE_BLOB_BYTES = MAX_MEDIA_BLOB_BYTES

/**
 * Live-verified CORS-friendly BUD-02 Blossom servers.
 * First two accept audio/*, image/*, AND application/octet-stream (E2EE blobs);
 * the third provides redundant public audio/* & image/* fallback.
 */
export const DEFAULT_BLOSSOM_SERVERS: readonly string[] = [
  'https://blossom.yakihonne.com',
  'https://nostr.download',
  'https://blossom.band',
]

export interface MediaBlobDescriptor {
  url: string
  mime: string
  sha256: string
  encryption?: VoiceMemoEncryption
  inlineMarker?: true
}

export function normalizeBlossomServerUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(candidate)
    const scheme = parsed.protocol.toLowerCase()
    const host = parsed.hostname.toLowerCase()
    const isLocalDev = scheme === 'http:' && (host === 'localhost' || host === '127.0.0.1')
    if (scheme !== 'https:' && !isLocalDev) return null
    if (!host || host.length > 253 || host.endsWith('.local') || host.endsWith('.internal')) return null
    if (scheme === 'https:' && (host === 'localhost' || host.endsWith('.localhost'))) return null
    const portPart = parsed.port && parsed.port !== '443' && parsed.port !== '80' ? `:${parsed.port}` : ''
    const pathPart = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : ''
    return `${scheme}//${host}${portPart}${pathPart}`
  } catch {
    return null
  }
}

export function cleanMimeType(rawMime: string, fallback = 'application/octet-stream'): string {
  const base = rawMime.split(';')[0].trim().toLowerCase()
  return base || fallback
}

export function computeSha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes))
}

/**
 * Off-main-thread hardware-accelerated SHA-256 hex digest.
 * Runs in `mediaCrypto.worker.ts` (SubtleCrypto with @noble/hashes fallback),
 * falling back to main-thread SubtleCrypto or sync `computeSha256Hex` only if unavailable.
 */
export async function computeSha256HexAsync(bytes: Uint8Array): Promise<string> {
  if (isOffMainThreadWorkerSupported()) {
    try {
      return await sha256HexOffMainThread(bytes)
    } catch {
      // Fall back cleanly to main-thread SubtleCrypto / pure JS
    }
  }
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes))
      return bytesToHex(new Uint8Array(digest))
    } catch {
      // Fall back to pure JS
    }
  }
  return computeSha256Hex(bytes)
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    for (let j = 0; j < sub.length; j++) {
      binary += String.fromCharCode(sub[j])
    }
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.trim())
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

/**
 * Encrypts DM/server media bytes client-side with AES-256-GCM before uploading opaque
 * ciphertext to Blossom. Blossom servers never see plaintext media.
 * Runs off the main thread in `mediaCrypto.worker.ts` when supported.
 */
export async function encryptVoiceBytesAesGcm(plaintext: Uint8Array): Promise<{
  ciphertext: Uint8Array
  ciphertextSha256: string
  encryption: VoiceMemoEncryption
}> {
  if (isOffMainThreadWorkerSupported()) {
    try {
      return await encryptAesGcmOffMainThread(plaintext)
    } catch (err) {
      if (!(err instanceof OffMainThreadUnavailableError)) {
        throw err
      }
      // Fall back cleanly to main-thread Web Crypto
    }
  }

  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Web Crypto API (SubtleCrypto) is unavailable in this browser context.')
  }
  const keyBytes = new Uint8Array(32)
  const ivBytes = new Uint8Array(12)
  crypto.getRandomValues(keyBytes)
  crypto.getRandomValues(ivBytes)

  const plaintextBuf = toArrayBuffer(plaintext)
  const plaintextSha256 = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', plaintextBuf)))
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(keyBytes),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  )
  const encryptedBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(ivBytes) },
    cryptoKey,
    plaintextBuf
  )
  const ciphertext = new Uint8Array(encryptedBuf)
  const ciphertextSha256 = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encryptedBuf)))

  return {
    ciphertext,
    ciphertextSha256,
    encryption: {
      alg: 'aes-gcm-256',
      keyB64: bytesToBase64(keyBytes),
      ivB64: bytesToBase64(ivBytes),
      plaintextSha256,
    },
  }
}

export async function decryptVoiceBytesAesGcm(
  ciphertext: Uint8Array,
  encryption: VoiceMemoEncryption
): Promise<Uint8Array> {
  if (encryption.alg !== 'aes-gcm-256') {
    throw new Error(`Unsupported voice encryption algorithm: ${String(encryption.alg)}`)
  }

  if (isOffMainThreadWorkerSupported()) {
    try {
      return await decryptAesGcmOffMainThread(ciphertext, encryption)
    } catch (err) {
      if (!(err instanceof OffMainThreadUnavailableError)) {
        throw err
      }
      // Fall back cleanly to main-thread Web Crypto
    }
  }

  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Web Crypto API (SubtleCrypto) is unavailable in this browser context.')
  }
  const keyBytes = base64ToBytes(encryption.keyB64)
  const ivBytes = base64ToBytes(encryption.ivB64)
  if (keyBytes.length !== 32 || ivBytes.length !== 12) {
    throw new Error('Malformed AES-256-GCM key or IV in voice memo metadata.')
  }

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(keyBytes),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  )
  const decryptedBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(ivBytes) },
    cryptoKey,
    toArrayBuffer(ciphertext)
  )
  const plaintext = new Uint8Array(decryptedBuf)
  if (encryption.plaintextSha256) {
    const actualPlainHash = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', decryptedBuf)))
    if (actualPlainHash !== encryption.plaintextSha256.toLowerCase()) {
      throw new Error('Decrypted voice memo SHA-256 integrity check failed.')
    }
  }
  return plaintext
}

export const encryptMediaBytesAesGcm = encryptVoiceBytesAesGcm
export const decryptMediaBytesAesGcm = decryptVoiceBytesAesGcm

export interface BlossomUploadResult {
  url: string
  sha256: string
  size: number
  mime: string
  server: string
}

interface BlossomDescriptor {
  url?: string
  sha256?: string
  size?: number
  type?: string
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * BUD-02 Blossom upload (`PUT /upload` with signed `kind: 24242` auth event).
 * Tries configured servers in order with automatic fallback.
 */
export async function uploadBlobToBlossom(opts: {
  bytes: Uint8Array
  mime: string
  servers: readonly string[]
  signAuthEvent: (template: EventTemplate) => Promise<NostrEvent>
  timeoutMs?: number
}): Promise<BlossomUploadResult> {
  const { bytes, signAuthEvent, timeoutMs = 15_000 } = opts
  if (bytes.byteLength === 0) {
    throw new Error('Cannot upload an empty media file.')
  }
  if (bytes.byteLength > MAX_MEDIA_BLOB_BYTES) {
    throw new Error('Media attachment exceeds maximum 15 MiB size limit.')
  }

  const cleanMime = cleanMimeType(opts.mime)
  const hashHex = await computeSha256HexAsync(bytes)
  const nowSec = Math.floor(Date.now() / 1000)

  const authTemplate: EventTemplate = {
    kind: KIND_BLOSSOM_AUTH,
    created_at: nowSec,
    tags: [
      ['t', 'upload'],
      ['x', hashHex],
      ['expiration', String(nowSec + 300)],
    ],
    content: 'Upload media',
  }

  const signedAuth = await signAuthEvent(authTemplate)
  const authJsonBytes = new TextEncoder().encode(JSON.stringify(signedAuth))
  const authHeader = `Nostr ${bytesToBase64(authJsonBytes)}`

  const candidates = (opts.servers.length > 0 ? opts.servers : DEFAULT_BLOSSOM_SERVERS)
    .map((s) => normalizeBlossomServerUrl(s))
    .filter((s): s is string => s !== null)

  if (candidates.length === 0) {
    throw new Error('No valid Blossom servers configured.')
  }

  const errors: string[] = []
  const bodyBuf = toArrayBuffer(bytes)

  for (const server of candidates) {
    try {
      const res = await fetchWithTimeout(
        `${server}/upload`,
        {
          method: 'PUT',
          mode: 'cors',
          headers: {
            Authorization: authHeader,
            'Content-Type': cleanMime,
          },
          body: bodyBuf,
        },
        timeoutMs
      )

      const text = await res.text()
      if (!res.ok) {
        const reason = res.headers.get('x-reason') || text.slice(0, 100) || `HTTP ${res.status}`
        errors.push(`${new URL(server).host}: ${reason}`)
        continue
      }

      let desc: BlossomDescriptor = {}
      try {
        desc = JSON.parse(text) as BlossomDescriptor
      } catch {
        // Some relays return empty body; derive BUD-01 URL
      }

      const finalUrl =
        typeof desc.url === 'string' && /^https?:\/\//i.test(desc.url)
          ? desc.url
          : `${server}/${hashHex}`

      return {
        url: finalUrl,
        sha256: hashHex,
        size: bytes.byteLength,
        mime: cleanMime,
        server,
      }
    } catch (err) {
      const host = (() => {
        try {
          return new URL(server).host
        } catch {
          return server
        }
      })()
      errors.push(`${host}: ${err instanceof Error ? err.message : 'network error'}`)
    }
  }

  throw new Error(`Blossom upload failed across all servers (${errors.slice(0, 3).join('; ')})`)
}

/**
 * Fetches, SHA-256 verifies, and (if encrypted) AES-256-GCM decrypts a Blossom media blob
 * (voice memo or image attachment).
 * Caller MUST enforce Trusted Peers authorization BEFORE invoking this function.
 */
export async function downloadAndVerifyMediaBlob(
  media: MediaBlobDescriptor,
  assertAuthorized: () => void,
  timeoutMs = 20_000
): Promise<Blob> {
  // Defense-in-depth authorization guard BEFORE any network I/O
  assertAuthorized()

  if (!/^https?:\/\//i.test(media.url)) {
    throw new Error('Blocked invalid non-HTTP(S) media URL.')
  }

  const res = await fetchWithTimeout(media.url, {
    method: 'GET', mode: 'cors',
    ...(media.inlineMarker ? { credentials: 'omit', referrerPolicy: 'no-referrer' } : {}),
  }, timeoutMs)
  if (!res.ok) {
    throw new Error(`Blossom download failed (HTTP ${res.status})`)
  }

  const contentLength = Number.parseInt(res.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_BLOB_BYTES) {
    throw new Error('Media attachment exceeds maximum allowed download size.')
  }

  const rawBuf = await res.arrayBuffer()
  if (rawBuf.byteLength > MAX_MEDIA_BLOB_BYTES) {
    throw new Error('Media attachment exceeds maximum allowed download size.')
  }

  const rawBytes = new Uint8Array(rawBuf)

  if (media.sha256 && /^[0-9a-f]{64}$/i.test(media.sha256)) {
    const actualHash = await computeSha256HexAsync(rawBytes)
    if (actualHash !== media.sha256.toLowerCase()) {
      throw new Error('Media SHA-256 hash mismatch — refusing corrupted or tampered content.')
    }
  }

  const plainBytes = media.encryption
    ? await decryptMediaBytesAesGcm(rawBytes, media.encryption)
    : rawBytes

  const mime = media.inlineMarker ? inferInlineRasterMime(plainBytes) : cleanMimeType(media.mime)
  if (!mime) throw new Error('The link did not return a supported image.')
  return new Blob([toArrayBuffer(plainBytes)], { type: mime })
}

export async function downloadAndVerifyVoiceMemo(
  memo: VoiceMemoAttachment,
  assertAuthorized: () => void,
  timeoutMs = 20_000
): Promise<Blob> {
  return await downloadAndVerifyMediaBlob(memo, assertAuthorized, timeoutMs)
}

/**
 * Caches decrypted/verified object URLs per media attachment (voice & image) and
 * cleanly revokes URLs per sender on untrust/block or all URLs on Panic Wipe/unmount.
 */
export class VoiceBlobCache {
  private urls = new Map<string, string>()
  private sendersByKey = new Map<string, Set<string>>()
  private inflight = new Map<string, Promise<string>>()

  private keyFor(media: MediaBlobDescriptor): string {
    return `${media.url}|${media.sha256}|${media.encryption?.ivB64 ?? 'plain'}|${media.inlineMarker ? 'marker' : ''}`
  }

  async getOrFetch(
    media: MediaBlobDescriptor,
    assertAuthorized: () => void,
    senderPubkey?: string
  ): Promise<string> {
    // Always re-verify authorization even on cache hit so untrusting a peer immediately blocks access!
    assertAuthorized()

    const key = this.keyFor(media)
    const pk = senderPubkey?.toLowerCase()
    if (pk) {
      let set = this.sendersByKey.get(key)
      if (!set) {
        set = new Set<string>()
        this.sendersByKey.set(key, set)
      }
      set.add(pk)
    }

    const cached = this.urls.get(key)
    if (cached) return cached

    const pending = this.inflight.get(key)
    if (pending) return pending

    const task = downloadAndVerifyMediaBlob(media, assertAuthorized)
      .then((blob) => {
        // Re-verify authorization after network I/O in case peer was untrusted mid-download
        assertAuthorized()
        const objectUrl = URL.createObjectURL(blob)
        this.urls.set(key, objectUrl)
        return objectUrl
      })
      .finally(() => {
        this.inflight.delete(key)
      })

    this.inflight.set(key, task)
    return task
  }

  revokeForSender(senderPubkey: string): void {
    const pk = senderPubkey.toLowerCase()
    for (const [key, senders] of Array.from(this.sendersByKey.entries())) {
      if (!senders.has(pk)) continue
      senders.delete(pk)
      if (senders.size === 0) {
        this.sendersByKey.delete(key)
        const objectUrl = this.urls.get(key)
        if (objectUrl) {
          try {
            URL.revokeObjectURL(objectUrl)
          } catch {
            // Ignore
          }
          this.urls.delete(key)
        }
      }
    }
  }

  revokeAll(): void {
    for (const objectUrl of this.urls.values()) {
      try {
        URL.revokeObjectURL(objectUrl)
      } catch {
        // Ignore
      }
    }
    this.urls.clear()
    this.sendersByKey.clear()
    this.inflight.clear()
  }
}
