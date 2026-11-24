import type { IncomingPushPayload, WebPushSubscriptionJSON } from './types.ts'

const utf8Encoder = new TextEncoder()

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function base64UrlToBytes(input: string): Uint8Array {
  const clean = input.trim().replace(/-/g, '+').replace(/_/g, '/')
  const pad = '='.repeat((4 - (clean.length % 4)) % 4)
  const binary = atob(clean + pad)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? utf8Encoder.encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes))
  return bytesToHex(new Uint8Array(digest))
}

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, toArrayBuffer(data))
  return new Uint8Array(sig)
}

/**
 * Builds an RFC 8292 VAPID `ES256` JWT signed with the P-256 VAPID private key.
 * Web Crypto's ECDSA sign outputs raw IEEE P1363 `r || s` (64 bytes), matching JWS ES256 directly.
 */
export async function buildVapidAuthHeader(opts: {
  endpoint: string
  vapidPublicKey: string
  vapidPrivateKey: string
  subject: string
  ttlSeconds?: number
}): Promise<{ authorization: string; jwt: string }> {
  const aud = new URL(opts.endpoint).origin
  const nowSec = Math.floor(Date.now() / 1000)
  const exp = nowSec + Math.min(20 * 3600, Math.max(3600, opts.ttlSeconds ?? 12 * 3600))

  const headerB64 = bytesToBase64Url(
    utf8Encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  )
  const payloadB64 = bytesToBase64Url(
    utf8Encoder.encode(JSON.stringify({ aud, exp, sub: opts.subject }))
  )
  const signingInput = `${headerB64}.${payloadB64}`

  const pubBytes = base64UrlToBytes(opts.vapidPublicKey)
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
    throw new Error('Invalid VAPID public key (expected 65-byte uncompressed P-256 point).')
  }
  const x = bytesToBase64Url(pubBytes.subarray(1, 33))
  const y = bytesToBase64Url(pubBytes.subarray(33, 65))
  const d = opts.vapidPrivateKey.trim()

  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x, y, d, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  )

  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    toArrayBuffer(utf8Encoder.encode(signingInput))
  )
  const sigB64 = bytesToBase64Url(new Uint8Array(sigBuf))
  const jwt = `${signingInput}.${sigB64}`

  return {
    authorization: `vapid t=${jwt}, k=${opts.vapidPublicKey.trim()}`,
    jwt,
  }
}

/**
 * Encrypts a UTF-8 Web Push payload according to RFC 8291 (`aes128gcm`) & RFC 8188.
 */
export async function encryptWebPushPayloadAes128Gcm(
  plaintext: Uint8Array,
  subscriberP256dhB64Url: string,
  subscriberAuthB64Url: string
): Promise<Uint8Array> {
  const uaPublic = base64UrlToBytes(subscriberP256dhB64Url)
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('Invalid subscription p256dh public key.')
  }
  const authSecret = base64UrlToBytes(subscriberAuthB64Url)
  if (authSecret.length !== 16) {
    throw new Error('Invalid subscription auth secret (expected 16 bytes).')
  }

  // 1. Ephemeral P-256 ECDH keypair (Application Server)
  const asKeyPair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  )) as CryptoKeyPair
  const asPublicRaw = (await crypto.subtle.exportKey('raw', asKeyPair.publicKey)) as ArrayBuffer
  const asPublic = new Uint8Array(asPublicRaw)

  // 2. ECDH shared secret
  const uaPubKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(uaPublic),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )
  const ecdhBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaPubKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
    asKeyPair.privateKey,
    256
  )
  const ecdhSecret = new Uint8Array(ecdhBits)

  // 3. RFC 8291 §3.3 — IKM derivation
  const prkKey = await hmacSha256(authSecret, ecdhSecret)
  const keyInfo = concatBytes(
    utf8Encoder.encode('WebPush: info\x00'),
    uaPublic,
    asPublic,
    new Uint8Array([0x01])
  )
  const ikm = await hmacSha256(prkKey, keyInfo)

  // 4. RFC 8188 §2.2-2.3 — Salt, PRK, CEK (16B), NONCE (12B)
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const prk = await hmacSha256(salt, ikm)

  const cekFull = await hmacSha256(
    prk,
    concatBytes(utf8Encoder.encode('Content-Encoding: aes128gcm\x00'), new Uint8Array([0x01]))
  )
  const cek = cekFull.subarray(0, 16)

  const nonceFull = await hmacSha256(
    prk,
    concatBytes(utf8Encoder.encode('Content-Encoding: nonce\x00'), new Uint8Array([0x01]))
  )
  const nonce = nonceFull.subarray(0, 12)

  // 5. Single final record: plaintext || 0x02 delimiter
  const paddedRecord = concatBytes(plaintext, new Uint8Array([0x02]))
  const aesKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(cek),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  )
  const encryptedBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), tagLength: 128 },
    aesKey,
    toArrayBuffer(paddedRecord)
  )
  const ciphertext = new Uint8Array(encryptedBuf)

  // 6. RFC 8188 §2.1 Content-Coding Header (86 bytes): salt(16) || rs(4 BE) || idlen(1=65) || asPublic(65)
  const recordSize = Math.max(4096, paddedRecord.byteLength + 16)
  const rsBytes = new Uint8Array(4)
  new DataView(rsBytes.buffer).setUint32(0, recordSize, false)

  return concatBytes(salt, rsBytes, new Uint8Array([asPublic.byteLength]), asPublic, ciphertext)
}

export interface WebPushSendResult {
  endpoint: string
  ok: boolean
  status: number
  expired: boolean
  error?: string
}

export async function sendWebPushNotification(opts: {
  subscription: WebPushSubscriptionJSON
  payload: IncomingPushPayload
  vapidPublicKey: string
  vapidPrivateKey: string
  vapidSubject: string
  ttlSeconds: number
  urgency?: 'very-low' | 'low' | 'normal' | 'high'
  topic?: string
}): Promise<WebPushSendResult> {
  const { subscription } = opts
  try {
    const jsonText = JSON.stringify(opts.payload)
    const plainBytes = utf8Encoder.encode(jsonText)
    const encryptedBody = await encryptWebPushPayloadAes128Gcm(
      plainBytes,
      subscription.keys.p256dh,
      subscription.keys.auth
    )
    const { authorization } = await buildVapidAuthHeader({
      endpoint: subscription.endpoint,
      vapidPublicKey: opts.vapidPublicKey,
      vapidPrivateKey: opts.vapidPrivateKey,
      subject: opts.vapidSubject,
    })

    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: String(Math.max(0, Math.floor(opts.ttlSeconds))),
      Urgency: opts.urgency ?? 'high',
      Authorization: authorization,
    }
    if (opts.topic) {
      const safeTopic = opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
      if (safeTopic) headers.Topic = safeTopic
    }

    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers,
      body: toArrayBuffer(encryptedBody),
    })

    const expired = res.status === 404 || res.status === 410
    const ok = res.status >= 200 && res.status < 300
    let error: string | undefined
    if (!ok) {
      const detail = await res.text().catch(() => '')
      error = detail ? `HTTP ${res.status}: ${detail.slice(0, 140)}` : `HTTP ${res.status}`
    }

    return {
      endpoint: subscription.endpoint,
      ok,
      status: res.status,
      expired,
      error,
    }
  } catch (err) {
    return {
      endpoint: subscription.endpoint,
      ok: false,
      status: 0,
      expired: false,
      error: err instanceof Error ? err.message : 'Web Push delivery error',
    }
  }
}
