import type { Event as NostrEvent, EventTemplate } from 'nostr-tools'
import type {
  NutzapEventParsed,
  NutzapInfoRecord,
  StoredCashuProof,
  ZapReceiptSummary,
} from '../types/wallet.ts'
import { normalizeMintUrl } from './cashuMints.ts'

/* ==========================================================================
   NIP-61 Nutzaps (kind: 10019 Nutzap Info & kind: 9321 Cashu P2PK Nutzaps)
   ========================================================================== */

export const KIND_NUTZAP_INFO = 10019
export const KIND_NUTZAP = 9321

export const CLAIMED_NUTZAPS_STORAGE_KEY = 'agnostr:v2:claimed_nutzaps'
export const PEER_NUTZAP_INFO_STORAGE_KEY = 'agnostr:v2:peer_nutzap_info'

const MAX_CLAIMED_NUTZAPS = 500
const MAX_PEER_NUTZAP_INFO = 200
const HEX_64_REGEX = /^[0-9a-f]{64}$/i
const HEX_66_COMPRESSED_REGEX = /^(02|03)[0-9a-f]{64}$/i

/**
 * Normalizes a P2PK public key into 32-byte x-only lowercase hex (64 chars) for NIP-61 `kind: 10019`
 * `['pubkey', ...]` tags. Accepts both 64-hex x-only and 66-hex (`02`/`03`) compressed keys.
 */
export function normalizeP2pkPubkey32(hex: string | null | undefined): string | null {
  if (!hex) return null
  const clean = hex.trim().replace(/^0x/i, '').toLowerCase()
  if (HEX_64_REGEX.test(clean)) return clean
  if (HEX_66_COMPRESSED_REGEX.test(clean)) return clean.slice(2)
  return null
}

/**
 * Formats a P2PK public key as a 33-byte compressed hex key (`02` + 64 hex) for Cashu NUT-11 locking.
 * If already a 66-hex compressed key starting with `02` or `03`, preserves it in lowercase.
 */
export function toCompressedP2pkPubkey(hex: string | null | undefined): string | null {
  if (!hex) return null
  const clean = hex.trim().replace(/^0x/i, '').toLowerCase()
  if (HEX_66_COMPRESSED_REGEX.test(clean)) return clean
  if (HEX_64_REGEX.test(clean)) return `02${clean}`
  return null
}

function normalizeRelayUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return null
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

export interface NutzapInfoMintInput {
  url: string
  units?: string[]
}

/**
 * Builds a NIP-61 `kind: 10019` Nutzap informational event template announcing the
 * user's receiving relays, trusted Cashu mints, and 32-byte x-only P2PK pubkey.
 */
export function buildNutzapInfoTemplate(params: {
  relays: string[]
  mints: Array<string | NutzapInfoMintInput>
  p2pkPubkeyHex: string
}): EventTemplate {
  const p2pk = normalizeP2pkPubkey32(params.p2pkPubkeyHex)
  if (!p2pk) {
    throw new Error('Invalid P2PK public key for NIP-61 Nutzap info.')
  }

  const tags: string[][] = []
  const seenRelays = new Set<string>()
  for (const rawRelay of params.relays) {
    const norm = normalizeRelayUrl(rawRelay)
    if (!norm || seenRelays.has(norm)) continue
    seenRelays.add(norm)
    tags.push(['relay', norm])
    if (seenRelays.size >= 10) break
  }

  const seenMints = new Set<string>()
  for (const item of params.mints) {
    const rawUrl = typeof item === 'string' ? item : item.url
    const normUrl = normalizeMintUrl(rawUrl)
    if (!normUrl || seenMints.has(normUrl)) continue
    seenMints.add(normUrl)
    const rawUnits = typeof item === 'string' ? ['sat'] : item.units
    const units = Array.from(
      new Set(
        (rawUnits && rawUnits.length > 0 ? rawUnits : ['sat'])
          .map((u) => u.trim().toLowerCase())
          .filter(Boolean)
      )
    )
    tags.push(['mint', normUrl, ...(units.length > 0 ? units : ['sat'])])
    if (seenMints.size >= 12) break
  }

  if (seenMints.size === 0) {
    throw new Error('At least one valid Cashu mint URL is required for NIP-61 Nutzap info.')
  }

  tags.push(['pubkey', p2pk])

  return {
    kind: KIND_NUTZAP_INFO,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }
}

/**
 * Parses a NIP-61 `kind: 10019` event into a normalized `NutzapInfoRecord`.
 */
export function parseNutzapInfoEvent(event: NostrEvent): NutzapInfoRecord | null {
  if (
    !event ||
    event.kind !== KIND_NUTZAP_INFO ||
    typeof event.pubkey !== 'string' ||
    !HEX_64_REGEX.test(event.pubkey) ||
    !Array.isArray(event.tags)
  ) {
    return null
  }

  let p2pkPubkey: string | null = null
  const mintMap = new Map<string, string[]>()
  const relaysSet = new Set<string>()

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length < 2 || typeof tag[1] !== 'string') continue
    const key = tag[0]
    if (key === 'pubkey' && !p2pkPubkey) {
      p2pkPubkey = normalizeP2pkPubkey32(tag[1])
    } else if (key === 'mint') {
      const normUrl = normalizeMintUrl(tag[1])
      if (!normUrl) continue
      const extraUnits = tag
        .slice(2)
        .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
        .map((u) => u.trim().toLowerCase())
      const existing = mintMap.get(normUrl) ?? []
      const merged = Array.from(
        new Set([...existing, ...(extraUnits.length > 0 ? extraUnits : ['sat'])])
      )
      mintMap.set(normUrl, merged)
    } else if (key === 'relay') {
      const normRelay = normalizeRelayUrl(tag[1])
      if (normRelay) relaysSet.add(normRelay)
    }
  }

  if (!p2pkPubkey || mintMap.size === 0) {
    return null
  }

  const mints = Array.from(mintMap.entries()).map(([url, units]) => ({ url, units }))

  return {
    pubkey: event.pubkey.toLowerCase(),
    p2pkPubkey,
    mints,
    relays: Array.from(relaysSet),
    createdAt: typeof event.created_at === 'number' ? event.created_at : 0,
  }
}

function serializeNutzapProof(proof: StoredCashuProof): StoredCashuProof {
  const clean: StoredCashuProof = {
    id: proof.id,
    amount: Math.floor(proof.amount),
    secret: proof.secret,
    C: proof.C,
  }
  if (proof.dleq && typeof proof.dleq === 'object' && proof.dleq.e && proof.dleq.s) {
    clean.dleq = {
      e: proof.dleq.e,
      s: proof.dleq.s,
      ...(proof.dleq.r ? { r: proof.dleq.r } : {}),
    }
  }
  if (proof.witness !== undefined) {
    clean.witness = proof.witness
  }
  return clean
}

function parseStoredProofJson(raw: string): StoredCashuProof | null {
  try {
    const obj = JSON.parse(raw) as Partial<StoredCashuProof>
    if (!obj || typeof obj !== 'object') return null
    if (
      typeof obj.id !== 'string' ||
      !obj.id.trim() ||
      typeof obj.secret !== 'string' ||
      !obj.secret.trim() ||
      typeof obj.C !== 'string' ||
      !obj.C.trim()
    ) {
      return null
    }
    const amt =
      typeof obj.amount === 'number'
        ? Math.floor(obj.amount)
        : typeof obj.amount === 'string'
          ? Number.parseInt(obj.amount, 10)
          : 0
    if (!Number.isFinite(amt) || amt <= 0) return null

    const out: StoredCashuProof = {
      id: obj.id.trim(),
      amount: amt,
      secret: obj.secret,
      C: obj.C.trim(),
    }

    if (
      obj.dleq &&
      typeof obj.dleq === 'object' &&
      typeof obj.dleq.e === 'string' &&
      typeof obj.dleq.s === 'string' &&
      obj.dleq.e.trim() &&
      obj.dleq.s.trim()
    ) {
      out.dleq = {
        e: obj.dleq.e.trim(),
        s: obj.dleq.s.trim(),
        ...(typeof obj.dleq.r === 'string' && obj.dleq.r.trim() ? { r: obj.dleq.r.trim() } : {}),
      }
    }

    if (obj.witness !== undefined) {
      out.witness = obj.witness
    }

    return out
  } catch {
    return null
  }
}

/**
 * Builds a NIP-61 `kind: 9321` Nutzap event template carrying P2PK-locked Cashu proofs
 * (one `['proof', JSON.stringify(p)]` tag per proof with `dleq` preserved).
 */
export function buildNutzapEventTemplate(params: {
  proofs: StoredCashuProof[]
  mintUrl: string
  recipientPubkey: string
  targetEventId?: string
  comment?: string
  unit?: string
}): EventTemplate {
  const normalizedMint = normalizeMintUrl(params.mintUrl)
  if (!normalizedMint) {
    throw new Error('Invalid mint URL for NIP-61 Nutzap.')
  }
  if (!HEX_64_REGEX.test(params.recipientPubkey)) {
    throw new Error('Invalid recipient pubkey for NIP-61 Nutzap.')
  }
  const cleanProofs = params.proofs
    .filter((p) => p && p.id && p.secret && p.C && Number.isFinite(p.amount) && p.amount > 0)
    .map(serializeNutzapProof)
  if (cleanProofs.length === 0) {
    throw new Error('At least one valid Cashu proof is required for a NIP-61 Nutzap.')
  }

  const tags: string[][] = cleanProofs.map((p) => ['proof', JSON.stringify(p)])
  tags.push(['u', normalizedMint])
  tags.push(['unit', (params.unit?.trim().toLowerCase() || 'sat')])
  tags.push(['p', params.recipientPubkey.toLowerCase()])

  if (params.targetEventId && HEX_64_REGEX.test(params.targetEventId)) {
    tags.push(['e', params.targetEventId.toLowerCase()])
  }

  return {
    kind: KIND_NUTZAP,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: (params.comment ?? '').trim().slice(0, 280),
  }
}

/**
 * Parses a NIP-61 `kind: 9321` Nutzap event into a structured `NutzapEventParsed`.
 */
export function parseNutzapEvent(event: NostrEvent): NutzapEventParsed | null {
  if (
    !event ||
    event.kind !== KIND_NUTZAP ||
    !event.id ||
    typeof event.pubkey !== 'string' ||
    !HEX_64_REGEX.test(event.pubkey) ||
    !Array.isArray(event.tags)
  ) {
    return null
  }

  let mintUrl: string | null = null
  let unit = 'sat'
  let recipientPubkey: string | null = null
  let targetEventId: string | undefined
  const seenSecrets = new Set<string>()
  const proofs: StoredCashuProof[] = []

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length < 2 || typeof tag[1] !== 'string') continue
    const key = tag[0]
    if (key === 'proof') {
      const parsed = parseStoredProofJson(tag[1])
      if (parsed && !seenSecrets.has(parsed.secret)) {
        seenSecrets.add(parsed.secret)
        proofs.push(parsed)
      }
    } else if (key === 'u' && !mintUrl) {
      mintUrl = normalizeMintUrl(tag[1])
    } else if (key === 'unit' && tag[1].trim()) {
      unit = tag[1].trim().toLowerCase()
    } else if (key === 'p' && !recipientPubkey && HEX_64_REGEX.test(tag[1])) {
      recipientPubkey = tag[1].toLowerCase()
    } else if (key === 'e' && !targetEventId && HEX_64_REGEX.test(tag[1])) {
      targetEventId = tag[1].toLowerCase()
    }
  }

  if (!mintUrl || !recipientPubkey || proofs.length === 0) {
    return null
  }

  let amountSats = 0
  for (const p of proofs) {
    amountSats += p.amount
  }
  if (amountSats <= 0) return null

  const comment =
    typeof event.content === 'string' && event.content.trim()
      ? event.content.trim().slice(0, 280)
      : undefined

  return {
    id: event.id,
    senderPubkey: event.pubkey.toLowerCase(),
    recipientPubkey,
    mintUrl,
    unit,
    proofs,
    amountSats,
    ...(targetEventId ? { targetEventId } : {}),
    ...(comment ? { comment } : {}),
    createdAt: typeof event.created_at === 'number' ? event.created_at : 0,
  }
}

/**
 * Converts a parsed NIP-61 Nutzap into a unified `ZapReceiptSummary` (`kind: 'nip61'`)
 * for message badge aggregation alongside NIP-57 Lightning Zap Receipts.
 */
export function nutzapToZapReceiptSummary(parsed: NutzapEventParsed): ZapReceiptSummary {
  return {
    id: parsed.id,
    amountSats: parsed.amountSats,
    senderPubkey: parsed.senderPubkey,
    recipientPubkey: parsed.recipientPubkey,
    ...(parsed.targetEventId ? { targetEventId: parsed.targetEventId } : {}),
    ...(parsed.comment ? { comment: parsed.comment } : {}),
    createdAt: parsed.createdAt,
    kind: 'nip61',
  }
}

/* --------------------------------------------------------------------------
   Persistence Helpers (`agnostr:v2:` — auto-wiped by Panic Wipe)
   -------------------------------------------------------------------------- */

export function loadClaimedNutzapIds(): Set<string> {
  try {
    const raw = localStorage.getItem(CLAIMED_NUTZAPS_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    const out = new Set<string>()
    for (const id of parsed) {
      if (typeof id === 'string' && id.trim()) {
        out.add(id.trim().toLowerCase())
      }
    }
    return out
  } catch {
    return new Set()
  }
}

export function saveClaimedNutzapIds(ids: Iterable<string>): void {
  try {
    const unique: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      const clean = id.trim().toLowerCase()
      if (!clean || seen.has(clean)) continue
      seen.add(clean)
      unique.push(clean)
    }
    localStorage.setItem(CLAIMED_NUTZAPS_STORAGE_KEY, JSON.stringify(unique.slice(-MAX_CLAIMED_NUTZAPS)))
  } catch {
    // Ignore storage errors
  }
}

export function markNutzapIdClaimed(eventId: string): Set<string> {
  const clean = eventId.trim().toLowerCase()
  const set = loadClaimedNutzapIds()
  if (clean) {
    set.delete(clean)
    set.add(clean)
    saveClaimedNutzapIds(set)
  }
  return set
}

export function isNutzapIdClaimed(eventId: string): boolean {
  const clean = eventId.trim().toLowerCase()
  if (!clean) return false
  return loadClaimedNutzapIds().has(clean)
}

export const markNutzapClaimed = markNutzapIdClaimed
export const isNutzapClaimed = isNutzapIdClaimed

export function clearClaimedNutzapIds(): void {
  try {
    localStorage.removeItem(CLAIMED_NUTZAPS_STORAGE_KEY)
  } catch {
    // Ignore storage errors
  }
}

interface StoredPeerNutzapInfoCache {
  records: Record<string, NutzapInfoRecord>
}

export function loadStoredPeerNutzapInfoCache(): Record<string, NutzapInfoRecord> {
  try {
    const raw = localStorage.getItem(PEER_NUTZAP_INFO_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<StoredPeerNutzapInfoCache>
    if (!parsed || typeof parsed.records !== 'object' || !parsed.records) return {}

    const out: Record<string, NutzapInfoRecord> = {}
    for (const [pk, rec] of Object.entries(parsed.records)) {
      if (!HEX_64_REGEX.test(pk) || !rec || typeof rec !== 'object') continue
      const p2pk = normalizeP2pkPubkey32(rec.p2pkPubkey)
      if (!p2pk || !Array.isArray(rec.mints)) continue
      const mints = rec.mints
        .map((m) => {
          const url = m && typeof m.url === 'string' ? normalizeMintUrl(m.url) : null
          if (!url) return null
          const units = Array.isArray(m.units)
            ? m.units.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
            : ['sat']
          return { url, units: units.length > 0 ? units : ['sat'] }
        })
        .filter((m): m is { url: string; units: string[] } => m !== null)
      if (mints.length === 0) continue

      const relays = Array.isArray(rec.relays)
        ? rec.relays
            .map((r) => (typeof r === 'string' ? normalizeRelayUrl(r) : null))
            .filter((r): r is string => r !== null)
        : []

      const lowerPk = pk.toLowerCase()
      out[lowerPk] = {
        pubkey: lowerPk,
        p2pkPubkey: p2pk,
        mints,
        relays,
        createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : 0,
      }
    }
    return out
  } catch {
    return {}
  }
}

export function saveStoredPeerNutzapInfoCache(records: Record<string, NutzapInfoRecord>): void {
  try {
    const entries = Object.entries(records).slice(-MAX_PEER_NUTZAP_INFO)
    const payload: StoredPeerNutzapInfoCache = {
      records: Object.fromEntries(entries),
    }
    localStorage.setItem(PEER_NUTZAP_INFO_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Ignore storage errors
  }
}

export function clearStoredPeerNutzapInfoCache(): void {
  try {
    localStorage.removeItem(PEER_NUTZAP_INFO_STORAGE_KEY)
  } catch {
    // Ignore storage errors
  }
}
