import { sha256 } from '@noble/hashes/sha256'
import {
  getEventHash,
  nip44,
  verifyEvent,
  type Event as NostrEvent,
  type EventTemplate,
} from 'nostr-tools'
import type {
  AmailAckTombstone,
  AmailSealedCapsule,
} from '../types/amail.ts'
import { bytesToHex, type IdentityManager, type SigningKeyMaterial } from './identity.ts'

export const KIND_AMAIL_CAPSULE_SIG = 25059
export const KIND_AMAIL_ACK_SIG = 25059

const MAX_INNER_PLAINTEXT_BYTES = 56_000
const utf8Encoder = new TextEncoder()

export interface AmailInnerRecipient {
  pubkey: string
  name?: string
}

export interface AmailInnerMailPayload {
  v: 1
  type: 'mail'
  id: string
  threadId: string
  inReplyTo?: string
  fromName: string
  /** Public To header list (NEVER contains BCC recipients) */
  to?: AmailInnerRecipient[]
  /** Public CC header list (NEVER contains BCC recipients) */
  cc?: AmailInnerRecipient[]
  subject: string
  body: string
  sentAt: number
  requestReadReceipt: boolean
  ttlSec: number
}

const MAX_INNER_RECIPIENTS = 50
const MAX_INNER_RECIPIENT_NAME_LEN = 48

function sanitizeInnerRecipients(raw: unknown): AmailInnerRecipient[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const clean: AmailInnerRecipient[] = []
  for (const item of raw) {
    if (clean.length >= MAX_INNER_RECIPIENTS) break
    if (!item || typeof item !== 'object') continue
    const rec = item as { pubkey?: unknown; name?: unknown }
    if (typeof rec.pubkey !== 'string') continue
    const pk = rec.pubkey.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pk) || seen.has(pk)) continue
    seen.add(pk)
    const trimmedName =
      typeof rec.name === 'string'
        ? rec.name.trim().slice(0, MAX_INNER_RECIPIENT_NAME_LEN)
        : ''
    clean.push(trimmedName ? { pubkey: pk, name: trimmedName } : { pubkey: pk })
  }
  return clean
}

function sanitizePayloadForWire(payload: AmailInnerPayload): AmailInnerPayload {
  if (payload.type === 'mail') {
    const cleanTo = sanitizeInnerRecipients(payload.to)
    const cleanCc = sanitizeInnerRecipients(payload.cc)
    // Strictly allow-list wire fields so BCC recipients can NEVER leak into any sealed capsule
    return {
      v: 1,
      type: 'mail',
      id: payload.id,
      threadId: payload.threadId,
      ...(typeof payload.inReplyTo === 'string' ? { inReplyTo: payload.inReplyTo } : {}),
      fromName: payload.fromName,
      ...(cleanTo !== undefined ? { to: cleanTo } : {}),
      ...(cleanCc && cleanCc.length > 0 ? { cc: cleanCc } : {}),
      subject: payload.subject,
      body: payload.body,
      sentAt: payload.sentAt,
      requestReadReceipt: Boolean(payload.requestReadReceipt),
      ttlSec: payload.ttlSec,
    }
  }
  return {
    v: 1,
    type: 'read_receipt',
    mailId: payload.mailId,
    threadId: payload.threadId,
    readAt: payload.readAt,
    ...(typeof payload.readerName === 'string' ? { readerName: payload.readerName } : {}),
  }
}

export interface AmailInnerReadReceiptPayload {
  v: 1
  type: 'read_receipt'
  mailId: string
  threadId: string
  readAt: number
  readerName?: string
}

export type AmailInnerPayload = AmailInnerMailPayload | AmailInnerReadReceiptPayload

/**
 * Computes the 12-char hex blinded routing hint for a recipient's 64-hex pubkey:
 * `sha256('amail-dest:' + lowercasePubkey).slice(0, 12)`
 *
 * Allows efficient mesh routing & recipient delivery detection without revealing
 * plaintext `npub`s inside third-party relay vaults.
 */
export function computeRecipientHint(pubkeyHex: string): string {
  const clean = pubkeyHex.trim().toLowerCase()
  return bytesToHex(sha256(utf8Encoder.encode(`amail-dest:${clean}`))).slice(0, 12)
}

/**
 * Deterministic content-addressed capsule ID preventing duplicate mesh relays.
 */
export function computeCapsuleId(sealedPayload: string, createdAt: number): string {
  return bytesToHex(sha256(utf8Encoder.encode(`${sealedPayload}:${createdAt}`)))
}

export function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength
}

export function estimateCapsuleSizeBytes(capsule: {
  capsuleId: string
  recipientHint: string
  sealedPayload: string
  senderPubkey: string
  sig: string
}): number {
  return (
    utf8ByteLength(capsule.capsuleId) +
    utf8ByteLength(capsule.recipientHint) +
    utf8ByteLength(capsule.sealedPayload) +
    utf8ByteLength(capsule.senderPubkey) +
    utf8ByteLength(capsule.sig) +
    120
  )
}

function buildCapsuleSigTemplate(params: {
  capsuleId: string
  recipientHint: string
  createdAt: number
  expiresAt: number
  maxHops: number
}): EventTemplate {
  return {
    kind: KIND_AMAIL_CAPSULE_SIG,
    created_at: params.createdAt,
    tags: [
      ['amail', 'capsule-v1'],
      ['c', params.capsuleId],
      ['r', params.recipientHint],
      ['exp', String(params.expiresAt)],
      ['mh', String(params.maxHops)],
    ],
    content: '',
  }
}

function buildAckSigTemplate(params: {
  capsuleId: string
  recipientHint: string
  ackedAt: number
  expiresAt: number
}): EventTemplate {
  return {
    kind: KIND_AMAIL_ACK_SIG,
    created_at: params.ackedAt,
    tags: [
      ['amail', 'ack-v1'],
      ['c', params.capsuleId],
      ['r', params.recipientHint],
      ['exp', String(params.expiresAt)],
    ],
    content: '',
  }
}

async function encryptNip44(
  plaintext: string,
  recipientPubkey: string,
  material: SigningKeyMaterial
): Promise<string> {
  if (utf8ByteLength(plaintext) > MAX_INNER_PLAINTEXT_BYTES) {
    throw new Error('Agmail message exceeds the maximum 56 KB encrypted payload size.')
  }
  const peerPk = recipientPubkey.toLowerCase()
  if (material.mode === 'extension') {
    if (!window.nostr?.nip44?.encrypt) {
      throw new Error('Your NIP-07 extension does not support NIP-44 encryption required for Agmail.')
    }
    return await window.nostr.nip44.encrypt(peerPk, plaintext)
  }
  if (!material.secretKey) {
    throw new Error('No signing key available to encrypt Agmail payload.')
  }
  const convKey = nip44.v2.utils.getConversationKey(material.secretKey, peerPk)
  return nip44.v2.encrypt(plaintext, convKey)
}

async function decryptNip44(
  ciphertext: string,
  senderPubkey: string,
  material: SigningKeyMaterial
): Promise<string> {
  const peerPk = senderPubkey.toLowerCase()
  if (material.mode === 'extension') {
    if (!window.nostr?.nip44?.decrypt) {
      throw new Error('Your NIP-07 extension does not support NIP-44 decryption.')
    }
    return await window.nostr.nip44.decrypt(peerPk, ciphertext)
  }
  if (!material.secretKey) {
    throw new Error('No signing key available to decrypt Agmail payload.')
  }
  const convKey = nip44.v2.utils.getConversationKey(material.secretKey, peerPk)
  return nip44.v2.decrypt(ciphertext, convKey)
}

/**
 * Encrypts an Amail inner payload (mail or read receipt) with NIP-44 v2 and wraps
 * it into a Schnorr-signed, blinded-destination `AmailSealedCapsule`.
 */
export async function sealAmailCapsule(params: {
  payload: AmailInnerPayload
  recipientPubkey: string
  identityManager: IdentityManager
  ttlSec: number
  maxHops: number
}): Promise<AmailSealedCapsule> {
  const recipientPk = params.recipientPubkey.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(recipientPk)) {
    throw new Error('Invalid recipient public key.')
  }

  const material = params.identityManager.getMasterKeyMaterial()
  const createdAt = Math.floor(Date.now() / 1000)
  const clampedTtl = Math.max(300, Math.min(30 * 86_400, Math.floor(params.ttlSec)))
  const clampedMaxHops = Math.max(1, Math.min(12, Math.floor(params.maxHops)))
  const expiresAt = createdAt + clampedTtl

  const wirePayload = sanitizePayloadForWire(params.payload)
  const sealedPayload = await encryptNip44(
    JSON.stringify(wirePayload),
    recipientPk,
    material
  )
  const recipientHint = computeRecipientHint(recipientPk)
  const capsuleId = computeCapsuleId(sealedPayload, createdAt)

  const sigTemplate = buildCapsuleSigTemplate({
    capsuleId,
    recipientHint,
    createdAt,
    expiresAt,
    maxHops: clampedMaxHops,
  })
  const signed = await params.identityManager.signEventWithMaterial(sigTemplate, material)

  const capsule: AmailSealedCapsule = {
    capsuleId,
    recipientHint,
    sealedPayload,
    senderPubkey: signed.pubkey.toLowerCase(),
    sig: signed.sig,
    createdAt,
    expiresAt,
    hopCount: 0,
    maxHops: clampedMaxHops,
    sizeBytes: estimateCapsuleSizeBytes({
      capsuleId,
      recipientHint,
      sealedPayload,
      senderPubkey: signed.pubkey.toLowerCase(),
      sig: signed.sig,
    }),
    receivedVia: 'local',
    storedAt: Date.now(),
    relayedToCount: 0,
  }

  return capsule
}

/**
 * Verifies a sealed capsule's structural bounds, deterministic `capsuleId`, and
 * BIP-340 Schnorr signature so third-party couriers cannot forge or extend TTLs.
 */
export function verifySealedCapsule(capsule: unknown): capsule is AmailSealedCapsule {
  if (!capsule || typeof capsule !== 'object') return false
  const c = capsule as Partial<AmailSealedCapsule>
  if (
    typeof c.capsuleId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(c.capsuleId) ||
    typeof c.recipientHint !== 'string' ||
    !/^[0-9a-f]{12}$/.test(c.recipientHint) ||
    typeof c.sealedPayload !== 'string' ||
    c.sealedPayload.length < 32 ||
    c.sealedPayload.length > 96_000 ||
    typeof c.senderPubkey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(c.senderPubkey) ||
    typeof c.sig !== 'string' ||
    !/^[0-9a-f]{128}$/.test(c.sig) ||
    typeof c.createdAt !== 'number' ||
    !Number.isFinite(c.createdAt) ||
    typeof c.expiresAt !== 'number' ||
    !Number.isFinite(c.expiresAt) ||
    c.expiresAt <= c.createdAt ||
    c.expiresAt - c.createdAt > 31 * 86_400 ||
    typeof c.hopCount !== 'number' ||
    c.hopCount < 0 ||
    typeof c.maxHops !== 'number' ||
    c.maxHops < 1 ||
    c.maxHops > 12
  ) {
    return false
  }

  // Verify content-addressed capsuleId matches sealedPayload + createdAt
  const expectedId = computeCapsuleId(c.sealedPayload, c.createdAt)
  if (expectedId !== c.capsuleId) return false

  // Verify BIP-340 Schnorr signature over canonical immutable capsule header
  const tpl = buildCapsuleSigTemplate({
    capsuleId: c.capsuleId,
    recipientHint: c.recipientHint,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    maxHops: c.maxHops,
  })
  const evBase = {
    ...tpl,
    pubkey: c.senderPubkey,
  }
  const fullEvent: NostrEvent = {
    ...evBase,
    id: getEventHash(evBase),
    sig: c.sig,
  }
  try {
    return verifyEvent(fullEvent)
  } catch {
    return false
  }
}

/**
 * Attempts to decrypt a sealed capsule addressed to our `masterPubkey`.
 * Returns `null` if the capsule is not addressed to us or decryption fails.
 */
export async function unsealAmailCapsule(
  capsule: AmailSealedCapsule,
  identityManager: IdentityManager
): Promise<AmailInnerPayload | null> {
  const material = identityManager.getMasterKeyMaterial()
  const myHint = computeRecipientHint(material.pubkey)
  if (capsule.recipientHint !== myHint) return null

  try {
    const raw = await decryptNip44(capsule.sealedPayload, capsule.senderPubkey, material)
    const parsed = JSON.parse(raw) as Partial<AmailInnerPayload>
    if (!parsed || parsed.v !== 1) return null

    if (parsed.type === 'mail') {
      if (
        typeof parsed.id !== 'string' ||
        typeof parsed.threadId !== 'string' ||
        typeof parsed.subject !== 'string' ||
        typeof parsed.body !== 'string' ||
        typeof parsed.sentAt !== 'number'
      ) {
        return null
      }
      const to = sanitizeInnerRecipients(parsed.to)
      const cc = sanitizeInnerRecipients(parsed.cc)
      return {
        v: 1,
        type: 'mail',
        id: parsed.id,
        threadId: parsed.threadId,
        inReplyTo: typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo : undefined,
        fromName: typeof parsed.fromName === 'string' ? parsed.fromName : '',
        ...(to !== undefined ? { to } : {}),
        ...(cc && cc.length > 0 ? { cc } : {}),
        subject: parsed.subject,
        body: parsed.body,
        sentAt: parsed.sentAt,
        requestReadReceipt: Boolean(parsed.requestReadReceipt),
        ttlSec: typeof parsed.ttlSec === 'number' ? parsed.ttlSec : 7 * 86_400,
      }
    }

    if (parsed.type === 'read_receipt') {
      if (
        typeof parsed.mailId !== 'string' ||
        typeof parsed.threadId !== 'string' ||
        typeof parsed.readAt !== 'number'
      ) {
        return null
      }
      return {
        v: 1,
        type: 'read_receipt',
        mailId: parsed.mailId,
        threadId: parsed.threadId,
        readAt: parsed.readAt,
        readerName: typeof parsed.readerName === 'string' ? parsed.readerName : undefined,
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Creates a recipient-signed ACK cancellation tombstone proving the true destination
 * decrypted the capsule, instructing all couriers to purge the ciphertext immediately.
 */
export async function createSignedAckTombstone(params: {
  capsuleId: string
  expiresAt: number
  identityManager: IdentityManager
}): Promise<AmailAckTombstone> {
  const material = params.identityManager.getMasterKeyMaterial()
  const recipientHint = computeRecipientHint(material.pubkey)
  const ackedAt = Math.floor(Date.now() / 1000)
  const expiresAt = Math.max(ackedAt + 3600, params.expiresAt)

  const tpl = buildAckSigTemplate({
    capsuleId: params.capsuleId,
    recipientHint,
    ackedAt,
    expiresAt,
  })
  const signed = await params.identityManager.signEventWithMaterial(tpl, material)

  return {
    capsuleId: params.capsuleId,
    recipientHint,
    ackedAt,
    expiresAt,
    sig: signed.sig,
    pubkey: signed.pubkey.toLowerCase(),
  }
}

/**
 * Verifies a signed ACK tombstone:
 * 1. `computeRecipientHint(ack.pubkey) === ack.recipientHint` (prevents third-party censorship!)
 * 2. Valid BIP-340 Schnorr signature by `ack.pubkey` over canonical ACK header.
 */
export function verifyAckTombstone(ack: unknown): ack is AmailAckTombstone {
  if (!ack || typeof ack !== 'object') return false
  const a = ack as Partial<AmailAckTombstone>
  if (
    typeof a.capsuleId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(a.capsuleId) ||
    typeof a.recipientHint !== 'string' ||
    !/^[0-9a-f]{12}$/.test(a.recipientHint) ||
    typeof a.pubkey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(a.pubkey) ||
    typeof a.sig !== 'string' ||
    !/^[0-9a-f]{128}$/.test(a.sig) ||
    typeof a.ackedAt !== 'number' ||
    !Number.isFinite(a.ackedAt) ||
    typeof a.expiresAt !== 'number' ||
    !Number.isFinite(a.expiresAt)
  ) {
    return false
  }

  if (computeRecipientHint(a.pubkey) !== a.recipientHint) {
    return false
  }

  const tpl = buildAckSigTemplate({
    capsuleId: a.capsuleId,
    recipientHint: a.recipientHint,
    ackedAt: a.ackedAt,
    expiresAt: a.expiresAt,
  })
  const evBase = {
    ...tpl,
    pubkey: a.pubkey,
  }
  const fullEvent: NostrEvent = {
    ...evBase,
    id: getEventHash(evBase),
    sig: a.sig,
  }
  try {
    return verifyEvent(fullEvent)
  } catch {
    return false
  }
}
