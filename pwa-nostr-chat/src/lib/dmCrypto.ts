import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { secp256k1 } from '@noble/curves/secp256k1'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  getEventHash,
  nip44,
  nip59,
  verifyEvent,
  type Event as NostrEvent,
  type EventTemplate,
} from 'nostr-tools'
import type {
  DmProtocol,
  ImageAttachment,
  VoiceMemoAttachment,
  VoiceMemoEncryption,
} from '../types/protocol.ts'
import { isDmTargetId } from './dmMessageActions.ts'
import { KIND_DM_RUMOR, KIND_GIFT_WRAP, KIND_SEAL } from './bitchatProtocol.ts'
import { bytesToHex, type SigningKeyMaterial } from './identity.ts'

export const DM_VOICE_PAYLOAD_PREFIX = 'agnostr-voice-v1:'

interface SerializedDmVoicePayload {
  url: string
  mime: string
  size: number
  durationSec: number
  waveform: number[]
  sha256: string
  encryption?: VoiceMemoEncryption
  server?: string
  caption?: string
}

export function encodeDmVoicePayload(memo: VoiceMemoAttachment, caption?: string): string {
  const payload: SerializedDmVoicePayload = {
    url: memo.url,
    mime: memo.mime,
    size: memo.size,
    durationSec: memo.durationSec,
    waveform: memo.waveform,
    sha256: memo.sha256,
    encryption: memo.encryption,
    server: memo.server,
    caption: caption?.trim() || undefined,
  }
  return `${DM_VOICE_PAYLOAD_PREFIX}${JSON.stringify(payload)}`
}

export function decodeDmVoicePayload(
  rawContent: string
): { voiceMemo: VoiceMemoAttachment; caption: string } | null {
  if (!rawContent.startsWith(DM_VOICE_PAYLOAD_PREFIX)) return null
  let parsed: Partial<SerializedDmVoicePayload>
  try {
    parsed = JSON.parse(rawContent.slice(DM_VOICE_PAYLOAD_PREFIX.length)) as Partial<SerializedDmVoicePayload>
  } catch {
    return null
  }
  if (typeof parsed.url !== 'string' || !/^https?:\/\//i.test(parsed.url)) return null
  if (typeof parsed.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(parsed.sha256)) return null

  let encryption: VoiceMemoEncryption | undefined
  if (parsed.encryption) {
    const enc = parsed.encryption
    if (
      enc.alg !== 'aes-gcm-256' ||
      typeof enc.keyB64 !== 'string' ||
      typeof enc.ivB64 !== 'string' ||
      typeof enc.plaintextSha256 !== 'string'
    ) {
      return null
    }
    encryption = {
      alg: 'aes-gcm-256',
      keyB64: enc.keyB64,
      ivB64: enc.ivB64,
      plaintextSha256: enc.plaintextSha256.toLowerCase(),
    }
  }

  const waveform = Array.isArray(parsed.waveform)
    ? parsed.waveform
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
        .slice(0, 64)
        .map((n) => Math.max(4, Math.min(100, Math.round(n))))
    : Array.from({ length: 32 }, () => 24)

  return {
    voiceMemo: {
      url: parsed.url,
      mime: typeof parsed.mime === 'string' && parsed.mime ? parsed.mime : 'audio/webm',
      size: typeof parsed.size === 'number' && parsed.size > 0 ? parsed.size : 0,
      durationSec: typeof parsed.durationSec === 'number' && parsed.durationSec > 0 ? parsed.durationSec : 0,
      waveform: waveform.length > 0 ? waveform : Array.from({ length: 32 }, () => 24),
      sha256: parsed.sha256.toLowerCase(),
      encryption,
      server: typeof parsed.server === 'string' ? parsed.server : undefined,
    },
    caption: typeof parsed.caption === 'string' ? parsed.caption.trim() : '',
  }
}

export const DM_IMAGE_PAYLOAD_PREFIX = 'agnostr-image-v1:'

interface SerializedDmImagePayload {
  url: string
  mime: string
  sha256: string
  size: number
  width: number
  height: number
  alt?: string
  encryption?: VoiceMemoEncryption
  server?: string
  caption?: string
}

export function encodeDmImagePayload(image: ImageAttachment, caption?: string): string {
  const payload: SerializedDmImagePayload = {
    url: image.url,
    mime: image.mime,
    sha256: image.sha256,
    size: image.size,
    width: image.width,
    height: image.height,
    alt: image.alt,
    encryption: image.encryption,
    server: image.server,
    caption: caption?.trim() || undefined,
  }
  return `${DM_IMAGE_PAYLOAD_PREFIX}${JSON.stringify(payload)}`
}

export function decodeDmImagePayload(
  rawContent: string
): { imageAttachment: ImageAttachment; caption: string } | null {
  if (!rawContent.startsWith(DM_IMAGE_PAYLOAD_PREFIX)) return null
  let parsed: Partial<SerializedDmImagePayload>
  try {
    parsed = JSON.parse(rawContent.slice(DM_IMAGE_PAYLOAD_PREFIX.length)) as Partial<SerializedDmImagePayload>
  } catch {
    return null
  }
  if (typeof parsed.url !== 'string' || !/^https?:\/\//i.test(parsed.url)) return null
  if (typeof parsed.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(parsed.sha256)) return null

  let encryption: VoiceMemoEncryption | undefined
  if (parsed.encryption) {
    const enc = parsed.encryption
    if (
      enc.alg !== 'aes-gcm-256' ||
      typeof enc.keyB64 !== 'string' ||
      typeof enc.ivB64 !== 'string' ||
      typeof enc.plaintextSha256 !== 'string'
    ) {
      return null
    }
    encryption = {
      alg: 'aes-gcm-256',
      keyB64: enc.keyB64,
      ivB64: enc.ivB64,
      plaintextSha256: enc.plaintextSha256.toLowerCase(),
    }
  }

  const mime =
    typeof parsed.mime === 'string' && parsed.mime.startsWith('image/') && parsed.mime !== 'image/svg+xml'
      ? parsed.mime.toLowerCase()
      : 'image/webp'

  return {
    imageAttachment: {
      url: parsed.url,
      mime,
      sha256: parsed.sha256.toLowerCase(),
      size: typeof parsed.size === 'number' && parsed.size > 0 ? Math.round(parsed.size) : 0,
      width: typeof parsed.width === 'number' && parsed.width > 0 ? Math.round(parsed.width) : 0,
      height: typeof parsed.height === 'number' && parsed.height > 0 ? Math.round(parsed.height) : 0,
      alt: typeof parsed.alt === 'string' && parsed.alt.trim() ? parsed.alt.trim().slice(0, 120) : undefined,
      encryption,
      server: typeof parsed.server === 'string' ? parsed.server : undefined,
    },
    caption: typeof parsed.caption === 'string' ? parsed.caption.trim() : '',
  }
}

const MAX_CIPHERTEXT_BYTES = 64 * 1024
const BITCHAT_HKDF_INFO = new TextEncoder().encode('nip44-v2')
const EMPTY_SALT = new Uint8Array(0)
const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export interface DecryptedDm {
  id: string
  senderPubkey: string
  content: string
  createdAt: number
  /** Millisecond timestamp extracted from Bitchat binary packet when available */
  timestampMs?: number
  protocol: DmProtocol
  embeddedMessageId?: string
  replyToId?: string
  reactionToId?: string
  ackType?: 'delivered' | 'read'
}

const MIN_VALID_EPOCH_MS = 1_577_836_800_000 // 2020-01-01T00:00:00Z

function clampDmCreatedAtSec(rawSec: number): number {
  const nowSec = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(rawSec) || rawSec <= 0) return nowSec
  return Math.min(Math.floor(rawSec), nowSec)
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(str: string): Uint8Array | null {
  try {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4))
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad
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

function deriveBitchatEnvelopeKey(
  privateKey: Uint8Array,
  peerPubkeyHex: string,
  parityPrefix: '02' | '03'
): Uint8Array {
  const shared33 = secp256k1.getSharedSecret(privateKey, parityPrefix + peerPubkeyHex.toLowerCase(), true)
  return hkdf(sha256, shared33, EMPTY_SALT, BITCHAT_HKDF_INFO, 32)
}

function encryptBitchatV2(plaintext: string, recipientPubkeyHex: string, senderSk: Uint8Array): string {
  const key = deriveBitchatEnvelopeKey(senderSk, recipientPubkeyHex, '02')
  const nonce24 = new Uint8Array(24)
  crypto.getRandomValues(nonce24)
  const ctAndTag = xchacha20poly1305(key, nonce24).encrypt(utf8Encoder.encode(plaintext))
  const combined = new Uint8Array(24 + ctAndTag.length)
  combined.set(nonce24, 0)
  combined.set(ctAndTag, 24)
  return `v2:${base64UrlEncode(combined)}`
}

function decryptBitchatV2(ciphertext: string, senderPubkeyHex: string, recipientSk: Uint8Array): string | null {
  if (!ciphertext.startsWith('v2:') || ciphertext.length > MAX_CIPHERTEXT_BYTES) return null
  const raw = base64UrlDecode(ciphertext.slice(3))
  if (!raw || raw.length <= 40) return null

  const nonce24 = raw.slice(0, 24)
  const ctAndTag = raw.slice(24)

  for (const prefix of ['02', '03'] as const) {
    try {
      const key = deriveBitchatEnvelopeKey(recipientSk, senderPubkeyHex, prefix)
      const plainBytes = xchacha20poly1305(key, nonce24).decrypt(ctAndTag)
      return utf8Decoder.decode(plainBytes)
    } catch {
      // Try alternate Y parity
    }
  }
  return null
}

function randomizedBitchatTimestamp(): number {
  const offset = Math.floor(Math.random() * 1800) - 900 // ±15 minutes
  return Math.floor(Date.now() / 1000) + offset
}

/**
 * Encodes a Bitchat `bitchat1:` binary packet carrying a GeoDM PrivateMessagePacket TLV.
 * Returns null if content/messageID exceeds 255 UTF-8 bytes (1-byte TLV length limit).
 */
export function encodeBitchatEmbeddedPM(content: string, messageId: string): string | null {
  const idBytes = utf8Encoder.encode(messageId)
  const contentBytes = utf8Encoder.encode(content)
  if (idBytes.length > 255 || contentBytes.length > 255) return null

  // NoisePayloadType.privateMessage (0x01) + TLV(0x00, id) + TLV(0x01, content)
  const payload = new Uint8Array(1 + 2 + idBytes.length + 2 + contentBytes.length)
  let p = 0
  payload[p++] = 0x01 // NoisePayloadType.privateMessage
  payload[p++] = 0x00 // TLV messageID
  payload[p++] = idBytes.length
  payload.set(idBytes, p)
  p += idBytes.length
  payload[p++] = 0x01 // TLV content
  payload[p++] = contentBytes.length
  payload.set(contentBytes, p)

  // BinaryProtocol v1 header (14 bytes) + 8-byte random unlinkable senderID + payload
  const packet = new Uint8Array(14 + 8 + payload.length)
  const view = new DataView(packet.buffer)
  packet[0] = 0x01 // version 1
  packet[1] = 0x11 // MessageType.noiseEncrypted
  packet[2] = 0x07 // TTL
  const tsMs = BigInt(Date.now())
  view.setBigUint64(3, tsMs, false)
  packet[11] = 0x00 // flags: no recipient, no sig, uncompressed
  view.setUint16(12, payload.length, false)

  const randomSender = new Uint8Array(8)
  crypto.getRandomValues(randomSender)
  packet.set(randomSender, 14)
  packet.set(payload, 22)

  return `bitchat1:${base64UrlEncode(packet)}`
}

interface DecodedBitchatPayload {
  kind: 'pm' | 'delivered' | 'read'
  messageId: string
  content?: string
  timestampMs?: number
}

export function decodeBitchatEmbeddedPayload(rawContent: string): DecodedBitchatPayload | null {
  if (!rawContent.startsWith('bitchat1:')) return null
  const data = base64UrlDecode(rawContent.slice('bitchat1:'.length))
  if (!data || data.length < 22) return null

  const version = data[0]
  if (version !== 1 && version !== 2) return null
  const msgType = data[1]
  if (msgType !== 0x11) return null // MessageType.noiseEncrypted

  const flags = data[11]
  const hasRecipient = (flags & 0x01) !== 0
  const isCompressed = (flags & 0x04) !== 0
  if (isCompressed) return null

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const headerSize = version === 2 ? 16 : 14
  if (data.length < headerSize + 8) return null

  // Extract 8-byte big-endian millisecond timestamp from packet header bytes 3..10
  let timestampMs: number | undefined
  try {
    const rawMs = Number(view.getBigUint64(3, false))
    if (Number.isFinite(rawMs) && rawMs >= MIN_VALID_EPOCH_MS && rawMs <= Date.now() + 86_400_000) {
      timestampMs = rawMs
    }
  } catch {
    timestampMs = undefined
  }

  const payloadLen = version === 2 ? view.getUint32(12, false) : view.getUint16(12, false)
  const payloadOffset = headerSize + 8 + (hasRecipient ? 8 : 0)
  if (payloadOffset + payloadLen > data.length || payloadLen < 2) return null

  const payload = data.slice(payloadOffset, payloadOffset + payloadLen)
  const noiseType = payload[0]

  if (noiseType === 0x01) {
    // PrivateMessagePacket TLV
    let offset = 1
    let messageId: string | null = null
    let content: string | null = null
    while (offset + 2 <= payload.length) {
      const tlvType = payload[offset++]
      const tlvLen = payload[offset++]
      if (offset + tlvLen > payload.length) break
      const slice = payload.slice(offset, offset + tlvLen)
      offset += tlvLen
      try {
        if (tlvType === 0x00) messageId = utf8Decoder.decode(slice)
        else if (tlvType === 0x01) content = utf8Decoder.decode(slice)
      } catch {
        return null
      }
    }
    if (messageId !== null && content !== null) {
      return { kind: 'pm', messageId, content, timestampMs }
    }
    return null
  }

  if (noiseType === 0x02 || noiseType === 0x03) {
    try {
      const messageId = utf8Decoder.decode(payload.slice(1))
      return { kind: noiseType === 0x02 ? 'read' : 'delivered', messageId, timestampMs }
    } catch {
      return null
    }
  }

  return null
}

/**
 * Encrypt and wrap a DM in either Bitchat-native `v2:` format or standard NIP-17/NIP-59 format.
 * Automatically falls back to NIP-17 when using a NIP-07 extension signer (no raw private key).
 */
export async function createEncryptedDmEvent(opts: {
  content: string
  recipientPubkey: string
  signer: SigningKeyMaterial
  protocol: DmProtocol
  messageId?: string
  action?: { type: 'reply' | 'reaction'; targetId: string }
}): Promise<{ event: NostrEvent; protocol: DmProtocol; wireId: string }> {
  const recipientPk = opts.recipientPubkey.toLowerCase()

  const action = opts.action
  if (action && !isDmTargetId(action.targetId)) throw new Error('Invalid private message reference')
  const kind = action?.type === 'reaction' ? 7 : KIND_DM_RUMOR
  const tags = [['p', recipientPk], ...(action ? [['e', action.targetId]] : [])]
  if (kind === 7) tags.push(['k', String(KIND_DM_RUMOR)])
  // A nonce distinguishes identical messages from the same sender within one second.
  if (opts.messageId) tags.push(['nonce-id', opts.messageId])

  // NIP-07 extension signer cannot derive raw Bitchat ECDH; use NIP-17 via window.nostr.nip44
  if (opts.signer.mode === 'extension' || !opts.signer.secretKey) {
    if (!window.nostr?.nip44?.encrypt || !window.nostr?.signEvent) {
      throw new Error('NIP-07 extension does not support NIP-44 encryption. Switch to Auto or Local key for DMs.')
    }
    const rumor = {
      pubkey: opts.signer.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind,
      tags,
      content: opts.content,
    }
    const wireId = getEventHash(rumor)
    const sealedContent = await window.nostr.nip44.encrypt(recipientPk, JSON.stringify({ ...rumor, id: wireId }))
    const sealTemplate: EventTemplate = {
      kind: KIND_SEAL,
      created_at: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172800),
      tags: [],
      content: sealedContent,
    }
    const signedSeal = await window.nostr.signEvent(sealTemplate)

    const wrapSk = generateSecretKey()
    const convKey = nip44.v2.utils.getConversationKey(wrapSk, recipientPk)
    const wrappedContent = nip44.v2.encrypt(JSON.stringify(signedSeal), convKey)
    const wrapEvent = finalizeEvent(
      {
        kind: KIND_GIFT_WRAP,
        created_at: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172800),
        tags: [['p', recipientPk]],
        content: wrappedContent,
      },
      wrapSk
    )
    return { event: wrapEvent, protocol: 'nip17', wireId }
  }

  const sk = opts.signer.secretKey
  const senderPk = getPublicKey(sk)

  if (opts.protocol === 'bitchat') {
    const msgId = opts.messageId ?? bytesToHex(crypto.getRandomValues(new Uint8Array(8)))
    const embedded = kind === KIND_DM_RUMOR ? encodeBitchatEmbeddedPM(opts.content, msgId) : null
    // If content > 255 bytes (exceeds 1-byte Bitchat TLV), send plain text inside v2 rumor or fall back to nip17
    const innerContent = embedded ?? opts.content

    const rumor = {
      id: '',
      pubkey: senderPk,
      created_at: Math.floor(Date.now() / 1000),
      kind,
      tags,
      content: innerContent,
    }
    const encryptedRumor = encryptBitchatV2(JSON.stringify(rumor), recipientPk, sk)
    const seal = finalizeEvent(
      {
        kind: KIND_SEAL,
        created_at: randomizedBitchatTimestamp(),
        tags: [],
        content: encryptedRumor,
      },
      sk
    )

    const wrapSk = generateSecretKey()
    const encryptedSeal = encryptBitchatV2(JSON.stringify(seal), recipientPk, wrapSk)
    const giftWrap = finalizeEvent(
      {
        kind: KIND_GIFT_WRAP,
        created_at: randomizedBitchatTimestamp(),
        tags: [['p', recipientPk]],
        content: encryptedSeal,
      },
      wrapSk
    )
    return { event: giftWrap, protocol: 'bitchat', wireId: embedded ? msgId : giftWrap.id }
  }

  // Standard NIP-17 / NIP-59 gift wrap
  const rumor = nip59.createRumor({ kind, created_at: Math.floor(Date.now() / 1000), tags, content: opts.content }, sk)
  const wrapEvent = nip59.createWrap(nip59.createSeal(rumor, sk, recipientPk), recipientPk)
  return { event: wrapEvent, protocol: 'nip17', wireId: rumor.id }
}

/**
 * Auto-detecting inbound DM decryptor supporting BOTH Bitchat `v2:` envelopes and standard NIP-17/NIP-59.
 */
export async function decryptGiftWrapEvent(
  giftWrap: NostrEvent,
  recipient: SigningKeyMaterial
): Promise<DecryptedDm | null> {
  if (giftWrap.kind !== KIND_GIFT_WRAP) return null
  if (!giftWrap.content || giftWrap.content.length > MAX_CIPHERTEXT_BYTES) return null

  // 1. Bitchat proprietary `v2:` XChaCha20-Poly1305 envelope
  if (giftWrap.content.startsWith('v2:')) {
    if (!recipient.secretKey) return null
    const sealJson = decryptBitchatV2(giftWrap.content, giftWrap.pubkey, recipient.secretKey)
    if (!sealJson) return null

    let seal: NostrEvent
    try {
      seal = JSON.parse(sealJson) as NostrEvent
    } catch {
      return null
    }
    if (!seal || seal.kind !== KIND_SEAL || !verifyEvent(seal)) return null

    const rumorJson = decryptBitchatV2(seal.content, seal.pubkey, recipient.secretKey)
    if (!rumorJson) return null

    let rumor: { kind?: number; pubkey?: string; created_at?: number; content?: string; tags?: unknown }
    try {
      rumor = JSON.parse(rumorJson)
    } catch {
      return null
    }
    if (
      (rumor.kind !== KIND_DM_RUMOR && rumor.kind !== 7) ||
      typeof rumor.pubkey !== 'string' ||
      rumor.pubkey.toLowerCase() !== seal.pubkey.toLowerCase() ||
      typeof rumor.content !== 'string'
    ) {
      return null
    }

    const refId = privateTarget(rumor.tags, recipient.pubkey, seal.pubkey)
    if (refId === null) return null
    if (rumor.kind === 7) {
      if (!refId || !validReaction(rumor.content)) return null
      return { id: giftWrap.id, senderPubkey: seal.pubkey, protocol: 'bitchat', content: rumor.content,
        reactionToId: refId, createdAt: clampDmCreatedAtSec(rumor.created_at ?? giftWrap.created_at) }
    }
    const decodedEmbedded = decodeBitchatEmbeddedPayload(rumor.content)
    const rawRumorSec = typeof rumor.created_at === 'number' ? rumor.created_at : giftWrap.created_at
    if (decodedEmbedded) {
      const embeddedSec =
        typeof decodedEmbedded.timestampMs === 'number'
          ? Math.floor(decodedEmbedded.timestampMs / 1000)
          : rawRumorSec
      const clampedTsMs =
        typeof decodedEmbedded.timestampMs === 'number'
          ? Math.min(decodedEmbedded.timestampMs, Date.now())
          : undefined
      if (decodedEmbedded.kind === 'delivered' || decodedEmbedded.kind === 'read') {
        return {
          id: giftWrap.id,
          senderPubkey: seal.pubkey.toLowerCase(),
          content: '',
          createdAt: clampDmCreatedAtSec(embeddedSec),
          timestampMs: clampedTsMs,
          protocol: 'bitchat',
          embeddedMessageId: decodedEmbedded.messageId,
          ackType: decodedEmbedded.kind,
        }
      }
      return {
        id: decodedEmbedded.messageId || giftWrap.id,
        replyToId: refId,
        senderPubkey: seal.pubkey.toLowerCase(),
        content: decodedEmbedded.content ?? '',
        createdAt: clampDmCreatedAtSec(embeddedSec),
        timestampMs: clampedTsMs,
        protocol: 'bitchat',
        embeddedMessageId: decodedEmbedded.messageId,
      }
    }

    return {
      id: giftWrap.id,
      senderPubkey: seal.pubkey.toLowerCase(),
      content: rumor.content,
      replyToId: refId,
      createdAt: clampDmCreatedAtSec(rawRumorSec),
      protocol: 'bitchat',
    }
  }

  // Verify the seal signature and bind the rumor author to it for *both* signers.
  // The library's convenience unwrapEvent decrypts, but does not do either check.
  try {
    const decrypt = recipient.secretKey
      ? (pk: string, content: string) => nip44.v2.decrypt(content, nip44.v2.utils.getConversationKey(recipient.secretKey!, pk))
      : recipient.mode === 'extension' && window.nostr?.nip44?.decrypt
        ? (pk: string, content: string) => window.nostr!.nip44!.decrypt(pk, content)
        : null
    if (!decrypt) return null
    const seal = JSON.parse(await decrypt(giftWrap.pubkey, giftWrap.content)) as NostrEvent
    if (!seal || seal.kind !== KIND_SEAL || !verifyEvent(seal)) return null
    const rumor = JSON.parse(await decrypt(seal.pubkey, seal.content)) as NostrEvent
    if (!rumor || (rumor.kind !== KIND_DM_RUMOR && rumor.kind !== 7) ||
        rumor.pubkey !== seal.pubkey || typeof rumor.content !== 'string') return null
    if (rumor.id && rumor.id !== getEventHash(rumor)) return null
    const refId = privateTarget(rumor.tags, recipient.pubkey, seal.pubkey)
    if (refId === null || (rumor.kind === 7 && (!refId || !validReaction(rumor.content)))) return null
    return { id: rumor.id || giftWrap.id, senderPubkey: seal.pubkey, protocol: 'nip17',
      content: rumor.content, createdAt: clampDmCreatedAtSec(rumor.created_at ?? giftWrap.created_at),
      ...(rumor.kind === 7 ? { reactionToId: refId } : { replyToId: refId }) }
  } catch {
    return null
  }
}

function validReaction(content: string): boolean {
  return !!content.trim() && content.length <= 32 && !/\s/u.test(content)
}

// Never resolve a group-chat reference against a 1:1 conversation.
function privateTarget(tags: unknown, recipient: string, sender: string): string | undefined | null {
  if (!Array.isArray(tags)) return undefined
  let id: string | undefined
  for (const tag of tags) {
    if (!Array.isArray(tag)) continue
    if (tag[0] === 'p' && tag[1] !== recipient && tag[1] !== sender) return null
    if (tag[0] === 'e' && isDmTargetId(tag[1])) id = tag[1]
  }
  return id
}
