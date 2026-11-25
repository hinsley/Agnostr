import {
  type Event as NostrEvent,
  type EventTemplate,
  type VerifiedEvent,
} from 'nostr-tools'
import type { LnurlPayMetadata, ZapAddressMode, ZapReceiptSummary } from '../types/wallet.ts'

export const LIGHTNING_ADDRESS_STORAGE_KEY = 'agnostr:v2:lightning_address'
export const PEER_LUD16_CACHE_STORAGE_KEY = 'agnostr:v2:peer_lud16_cache'
export const ZAP_MODE_STORAGE_KEY = 'agnostr:v2:zap_address_mode'
export const NPUBCASH_AUTOSWEEP_STORAGE_KEY = 'agnostr:v2:npubcash_autosweep'

export const KIND_PROFILE_METADATA = 0
export const KIND_ZAP_REQUEST = 9734
export const KIND_ZAP_RECEIPT = 9735

const LUD16_REGEX = /^[a-z0-9._+-]{1,128}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i
const LNURL_BECH32_REGEX = /^lnurl1[02-9ac-hj-np-z]+$/i
const BOLT11_REGEX = /^(?:lightning:)?(ln(?:bc|tb|bcrt)[0-9a-z]+)$/i

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const b = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) {
      if ((b >>> i) & 1) {
        chk ^= GEN[i]
      }
    }
  }
  return chk
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hrp.length; i++) {
    out.push(hrp.charCodeAt(i) >>> 5)
  }
  out.push(0)
  for (let i = 0; i < hrp.length; i++) {
    out.push(hrp.charCodeAt(i) & 31)
  }
  return out
}

function convertBits(
  data: ArrayLike<number>,
  fromBits: number,
  toBits: number,
  pad = false
): Uint8Array | null {
  let acc = 0
  let bits = 0
  const maxv = (1 << toBits) - 1
  const maxAcc = (1 << (fromBits + toBits - 1)) - 1
  const out: number[] = []
  for (let i = 0; i < data.length; i++) {
    const value = data[i]
    if (value < 0 || value >> fromBits !== 0) return null
    acc = ((acc << fromBits) | value) & maxAcc
    bits += fromBits
    while (bits >= toBits) {
      bits -= toBits
      out.push((acc >>> bits) & maxv)
    }
  }
  if (pad) {
    if (bits > 0) {
      out.push((acc << (toBits - bits)) & maxv)
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    return null
  }
  return new Uint8Array(out)
}

/**
 * Pure TypeScript Bech32 encoder for HTTPS LNURL endpoint URL -> lowercase `lnurl1...`.
 */
export function encodeLnurlBech32(httpsUrl: string): string {
  const trimmed = httpsUrl.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('Invalid URL for LNURL encoding.')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('LNURL endpoint must use https:// or http://.')
  }

  const bytes = new TextEncoder().encode(parsed.toString())
  const words = convertBits(bytes, 8, 5, true)
  if (!words || words.length === 0) {
    throw new Error('Failed to encode LNURL Bech32 payload.')
  }

  const hrp = 'lnurl'
  const data = Array.from(words)
  const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1
  const checksum: number[] = []
  for (let p = 0; p < 6; p++) {
    checksum.push((polymod >>> (5 * (5 - p))) & 31)
  }

  let encoded = `${hrp}1`
  for (const w of data) encoded += BECH32_CHARSET[w]
  for (const c of checksum) encoded += BECH32_CHARSET[c]
  return encoded
}

/**
 * Pure TypeScript Bech32 decoder for `lnurl1...` strings -> HTTPS endpoint URL.
 */
export function decodeLnurlBech32(raw: string): string | null {
  const cleaned = raw.trim().replace(/^lightning:/i, '').toLowerCase()
  if (!LNURL_BECH32_REGEX.test(cleaned)) return null
  const sepIdx = cleaned.lastIndexOf('1')
  if (sepIdx < 1 || sepIdx + 7 > cleaned.length) return null

  const hrp = cleaned.slice(0, sepIdx)
  if (hrp !== 'lnurl') return null

  const words: number[] = []
  for (let i = sepIdx + 1; i < cleaned.length; i++) {
    const idx = BECH32_CHARSET.indexOf(cleaned[i])
    if (idx === -1) return null
    words.push(idx)
  }

  if (bech32Polymod([...bech32HrpExpand(hrp), ...words]) !== 1) {
    return null
  }

  const payloadWords = words.slice(0, -6)
  const bytes = convertBits(payloadWords, 5, 8)
  if (!bytes || bytes.length === 0) return null

  try {
    const urlStr = new TextDecoder().decode(bytes)
    const parsed = new URL(urlStr)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

/**
 * Normalizes and validates a Lightning Address (`user@domain.tld`) or `lnurl1...` string.
 */
export function normalizeLightningAddress(raw: string | null | undefined): string | null {
  if (!raw) return null
  const stripped = raw.trim().replace(/^lightning:/i, '').trim()
  if (!stripped) return null
  const lower = stripped.toLowerCase()
  if (LUD16_REGEX.test(lower)) {
    return lower
  }
  if (LNURL_BECH32_REGEX.test(lower) && decodeLnurlBech32(lower)) {
    return lower
  }
  return null
}

export function isValidLightningAddress(raw: string): boolean {
  return normalizeLightningAddress(raw) !== null
}

/**
 * Returns true if the supplied Lightning Address belongs to the built-in `npub.cash` domain.
 */
export function isNpubCashAddress(addr: string | null | undefined): boolean {
  const normalized = normalizeLightningAddress(addr)
  return Boolean(normalized && normalized.endsWith('@npub.cash'))
}

/**
 * Extracts a clean lowercase BOLT-11 invoice if present.
 */
export function extractBolt11Invoice(raw: string): string | null {
  const match = raw.trim().match(BOLT11_REGEX)
  if (!match) return null
  return match[1].toLowerCase()
}

/** Read a fixed BOLT-11 amount without rounding sub-satoshi amounts. */
export function decodeBolt11AmountMsats(bolt11: string): bigint | null {
  const clean = extractBolt11Invoice(bolt11)
  if (!clean) return null
  const match = clean.slice(0, clean.lastIndexOf('1')).match(/^ln(?:bcrt|bc|tb)(\d+)([munp]?)$/)
  if (!match || match[1].length > 18) return null
  const amount = BigInt(match[1])
  if (amount <= 0n) return null
  switch (match[2]) {
    case '': return amount * 100_000_000_000n
    case 'm': return amount * 100_000_000n
    case 'u': return amount * 100_000n
    case 'n': return amount * 100n
    case 'p': return amount % 10n === 0n ? amount / 10n : null
    default: return null
  }
}

export function isBolt11Invoice(raw: string): boolean {
  return extractBolt11Invoice(raw) !== null
}

/**
 * Decodes satoshis from a BOLT-11 invoice human-readable prefix (`lnbc<num><mult>1...`).
 * Returns `null` for amountless invoices or malformed strings.
 */
export function decodeBolt11AmountSats(bolt11: string): number | null {
  const clean = extractBolt11Invoice(bolt11)
  if (!clean) return null
  // Bech32 separator is strictly the LAST '1' ('1' is excluded from the Bech32 data alphabet)
  const sepIdx = clean.lastIndexOf('1')
  if (sepIdx <= 4) return null

  const hrp = clean.slice(0, sepIdx)
  // Prefix is lnbc, lntb, or lnbcrt
  const match = hrp.match(/^ln(?:bcrt|bc|tb)(\d+)([munp]?)$/)
  if (!match) return null

  const digits = Number.parseInt(match[1], 10)
  if (!Number.isFinite(digits) || digits <= 0) return null

  const mult = match[2]
  switch (mult) {
    case '':
      return Math.round(digits * 100_000_000)
    case 'm':
      return Math.round(digits * 100_000)
    case 'u':
      return Math.round(digits * 100)
    case 'n':
      return Math.round(digits * 0.1)
    case 'p':
      return Math.round(digits * 0.0001)
    default:
      return null
  }
}

export type ParsedLightningPayload =
  | { kind: 'bolt11'; invoice: string; amountSats: number | null }
  | { kind: 'lud16'; address: string }
  | { kind: 'lnurl'; lnurl: string }

/**
 * Detects whether a pasted/scanned string is a BOLT-11 invoice, `user@domain` lud16,
 * or `lnurl1...` string (with or without `lightning:` URI scheme).
 */
export function parseLightningPayload(raw: string): ParsedLightningPayload | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const invoice = extractBolt11Invoice(trimmed)
  if (invoice) {
    return {
      kind: 'bolt11',
      invoice,
      amountSats: decodeBolt11AmountSats(invoice),
    }
  }

  const normalized = normalizeLightningAddress(trimmed)
  if (!normalized) return null
  if (normalized.includes('@')) {
    return { kind: 'lud16', address: normalized }
  }
  return { kind: 'lnurl', lnurl: normalized }
}

/**
 * Builds the standard `['lud16', addr]` tag for outbound Nostr messages.
 * Returns `null` if no valid Lightning Address is configured.
 */
export function buildLightningAddressTag(addr: string | null | undefined): string[] | null {
  const normalized = normalizeLightningAddress(addr)
  if (!normalized) return null
  return [normalized.includes('@') ? 'lud16' : 'lud06', normalized]
}

/**
 * Extracts a valid `lud16` (or `lnurl`) Lightning Address from Nostr event tags.
 */
export function extractLightningAddressTag(tags: string[][] | undefined | null): string | null {
  if (!Array.isArray(tags)) return null
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.length < 2) continue
    if (tag[0] === 'lud16' || tag[0] === 'lud06') {
      const normalized = normalizeLightningAddress(tag[1])
      if (normalized) return normalized
    }
  }
  return null
}

/**
 * Parses a Nostr `kind: 0` profile metadata event for `lud16` or `lud06`.
 */
export function parseProfileLightningAddress(event: NostrEvent): string | null {
  if (event.kind !== KIND_PROFILE_METADATA || !event.content) return null
  try {
    const parsed = JSON.parse(event.content) as Record<string, unknown>
    if (typeof parsed.lud16 === 'string') {
      const norm = normalizeLightningAddress(parsed.lud16)
      if (norm) return norm
    }
    if (typeof parsed.lud06 === 'string') {
      const norm = normalizeLightningAddress(parsed.lud06)
      if (norm) return norm
    }
  } catch {
    // Ignore invalid JSON content
  }
  return null
}

/**
 * Builds a Nostr `kind: 0` metadata event template preserving existing profile keys
 * while updating `name` and `lud16`.
 */
export function buildProfileMetadataTemplate(params: {
  name: string
  lud16: string | null
  existingProfile?: Record<string, unknown> | null
}): EventTemplate {
  const payload: Record<string, unknown> = {
    ...(params.existingProfile ?? {}),
    name: params.name.trim() || 'anon',
  }
  const normalized = normalizeLightningAddress(params.lud16)
  if (normalized) {
    if (normalized.includes('@')) {
      payload.lud16 = normalized
    } else {
      payload.lud06 = normalized
      delete payload.lud16
    }
  } else {
    delete payload.lud16
    delete payload.lud06
  }

  return {
    kind: KIND_PROFILE_METADATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(payload),
  }
}

/**
 * Converts a `user@domain` Lightning Address or `lnurl1...` into its LNURL-pay URL.
 */
export function lightningAddressToLnurlEndpoint(lud16OrLnurl: string): {
  url: string
  domain: string
  identifier?: string
} {
  const normalized = normalizeLightningAddress(lud16OrLnurl)
  if (!normalized) {
    throw new Error('Invalid Lightning Address (expected user@domain.com or lnurl1...).')
  }

  if (normalized.includes('@')) {
    const [user, domain] = normalized.split('@')
    const url = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`
    return { url, domain, identifier: normalized }
  }

  const decoded = decodeLnurlBech32(normalized)
  if (!decoded) {
    throw new Error('Could not decode LNURL bech32 string.')
  }
  const parsed = new URL(decoded)
  return { url: decoded, domain: parsed.hostname }
}

/**
 * Converts a Lightning Address (`user@domain`) or `lnurl1...` into a universally scannable
 * `lightning:LNURL1...` QR URI payload.
 */
export function lightningAddressToQrPayload(lud16OrLnurl: string): string {
  const normalized = normalizeLightningAddress(lud16OrLnurl)
  if (!normalized) {
    throw new Error('Invalid Lightning Address (expected user@domain.com or lnurl1...).')
  }
  if (!normalized.includes('@')) {
    return `lightning:${normalized.toUpperCase()}`
  }
  const { url } = lightningAddressToLnurlEndpoint(normalized)
  return `lightning:${encodeLnurlBech32(url).toUpperCase()}`
}

interface RawLnurlPayResponse {
  status?: string
  reason?: string
  tag?: string
  callback?: string
  minSendable?: number
  maxSendable?: number
  commentAllowed?: number
  allowsNostr?: boolean
  nostrPubkey?: string
  metadata?: string
}

/**
 * Resolves a Lightning Address (`user@domain`) or `lnurl1...` via `/.well-known/lnurlp/<user>`.
 */
export async function resolveLnurlPay(
  lud16OrLnurl: string,
  timeoutMs = 12_000
): Promise<LnurlPayMetadata> {
  const { url, domain, identifier } = lightningAddressToLnurlEndpoint(lud16OrLnurl)
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })

    if (!res.ok) {
      throw new Error(`Lightning Address lookup failed (HTTP ${res.status}) at ${domain}.`)
    }

    const data = (await res.json()) as RawLnurlPayResponse
    if (data.status === 'ERROR') {
      throw new Error(data.reason || `LNURL server at ${domain} returned an error.`)
    }
    if (data.tag !== 'payRequest' || !data.callback) {
      throw new Error(`${domain} did not return a valid LNURL-pay endpoint.`)
    }

    const minSendableMsat = Math.max(1000, Number(data.minSendable) || 1000)
    const maxSendableMsat = Math.max(minSendableMsat, Number(data.maxSendable) || 100_000_000_000)
    const commentAllowed = Math.max(0, Math.floor(Number(data.commentAllowed) || 0))

    let description = identifier || domain
    if (typeof data.metadata === 'string') {
      try {
        const tuples = JSON.parse(data.metadata) as unknown
        if (Array.isArray(tuples)) {
          for (const tuple of tuples) {
            if (Array.isArray(tuple) && tuple[0] === 'text/plain' && typeof tuple[1] === 'string') {
              description = tuple[1]
              break
            }
          }
        }
      } catch {
        // Keep fallback description
      }
    }

    const nostrPubkey =
      typeof data.nostrPubkey === 'string' && /^[0-9a-f]{64}$/i.test(data.nostrPubkey)
        ? data.nostrPubkey.toLowerCase()
        : undefined

    return {
      callback: data.callback,
      minSendableMsat,
      maxSendableMsat,
      minSendableSats: Math.ceil(minSendableMsat / 1000),
      maxSendableSats: Math.floor(maxSendableMsat / 1000),
      commentAllowed,
      allowsNostr: Boolean(data.allowsNostr && nostrPubkey),
      nostrPubkey,
      description,
      identifier,
      domain,
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Timed out resolving Lightning Address on ${domain}.`)
    }
    throw err instanceof Error ? err : new Error('Failed to resolve Lightning Address.')
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * Builds a NIP-57 `kind: 9734` Zap Request event template.
 */
export function buildZapRequestTemplate(params: {
  recipientPubkey: string
  amountSats: number
  relays: string[]
  eventId?: string
  comment?: string
  lnurl?: string
}): EventTemplate {
  const msat = Math.round(params.amountSats * 1000)
  const cleanRelays = Array.from(new Set(params.relays.filter((r) => r.startsWith('wss://')))).slice(
    0,
    8
  )
  const tags: string[][] = [
    ['relays', ...(cleanRelays.length > 0 ? cleanRelays : ['wss://relay.damus.io', 'wss://nos.lol'])],
    ['amount', String(msat)],
    ['p', params.recipientPubkey.toLowerCase()],
  ]
  if (params.eventId && /^[0-9a-f]{64}$/i.test(params.eventId)) {
    tags.push(['e', params.eventId.toLowerCase()])
  }
  if (params.lnurl) {
    tags.push(['lnurl', params.lnurl])
  }

  return {
    kind: KIND_ZAP_REQUEST,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: (params.comment ?? '').trim().slice(0, 280),
  }
}

interface RawLnurlCallbackResponse {
  status?: string
  reason?: string
  pr?: string
}

/**
 * Calls the LNURL-pay callback to obtain a BOLT-11 invoice (attaching a signed
 * NIP-57 `kind: 9734` Zap Request when supported by the recipient's server).
 */
export async function fetchLnurlPayInvoice(params: {
  metadata: LnurlPayMetadata
  amountSats: number
  comment?: string
  zapRequestEvent?: VerifiedEvent | null
  timeoutMs?: number
}): Promise<string> {
  const amountSats = Math.floor(params.amountSats)
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new Error('Enter a valid positive satoshi amount.')
  }

  const msat = amountSats * 1000
  if (msat < params.metadata.minSendableMsat) {
    throw new Error(`Minimum amount for this address is ${params.metadata.minSendableSats} sats.`)
  }
  if (msat > params.metadata.maxSendableMsat) {
    throw new Error(`Maximum amount for this address is ${params.metadata.maxSendableSats} sats.`)
  }

  const callbackUrl = new URL(params.metadata.callback)
  callbackUrl.searchParams.set('amount', String(msat))

  const cleanComment = (params.comment ?? '').trim()
  if (cleanComment && params.metadata.commentAllowed > 0) {
    callbackUrl.searchParams.set('comment', cleanComment.slice(0, params.metadata.commentAllowed))
  }

  if (params.metadata.allowsNostr && params.zapRequestEvent) {
    callbackUrl.searchParams.set('nostr', JSON.stringify(params.zapRequestEvent))
  }

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), params.timeoutMs ?? 12_000)

  try {
    const res = await fetch(callbackUrl.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })

    if (!res.ok) {
      throw new Error(`LNURL invoice request failed (HTTP ${res.status}).`)
    }

    const data = (await res.json()) as RawLnurlCallbackResponse
    if (data.status === 'ERROR') {
      throw new Error(data.reason || 'LNURL server declined invoice generation.')
    }
    const invoice = data.pr ? extractBolt11Invoice(data.pr) : null
    if (!invoice) {
      throw new Error('LNURL server did not return a valid BOLT-11 invoice.')
    }
    if (decodeBolt11AmountMsats(invoice) !== BigInt(msat)) {
      throw new Error('The Lightning invoice does not match the requested amount.')
    }
    return invoice
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Timed out requesting Lightning invoice from LNURL server.')
    }
    throw err instanceof Error ? err : new Error('Failed to fetch Lightning invoice.')
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * Parses a NIP-57 `kind: 9735` Zap Receipt event into a verified summary.
 */
export function parseZapReceiptEvent(event: NostrEvent): ZapReceiptSummary | null {
  if (event.kind !== KIND_ZAP_RECEIPT || !event.id || !Array.isArray(event.tags)) {
    return null
  }

  const getTag = (name: string): string | undefined => {
    const found = event.tags.find((t) => Array.isArray(t) && t[0] === name && typeof t[1] === 'string')
    return found?.[1]
  }

  const bolt11 = getTag('bolt11')
  const descriptionRaw = getTag('description')
  let recipientPubkey = getTag('p')?.toLowerCase()
  let targetEventId = getTag('e')?.toLowerCase()
  let senderPubkey: string | undefined
  let comment: string | undefined
  let amountSats = bolt11 ? decodeBolt11AmountSats(bolt11) ?? 0 : 0

  if (descriptionRaw) {
    try {
      const zapReq = JSON.parse(descriptionRaw) as Partial<NostrEvent>
      if (zapReq && zapReq.kind === KIND_ZAP_REQUEST) {
        if (typeof zapReq.pubkey === 'string' && /^[0-9a-f]{64}$/i.test(zapReq.pubkey)) {
          senderPubkey = zapReq.pubkey.toLowerCase()
        }
        if (typeof zapReq.content === 'string' && zapReq.content.trim()) {
          comment = zapReq.content.trim().slice(0, 280)
        }
        if (Array.isArray(zapReq.tags)) {
          if (!recipientPubkey) {
            const pTag = zapReq.tags.find((t) => t[0] === 'p' && t[1])
            if (pTag?.[1]) recipientPubkey = pTag[1].toLowerCase()
          }
          if (!targetEventId) {
            const eTag = zapReq.tags.find((t) => t[0] === 'e' && t[1])
            if (eTag?.[1]) targetEventId = eTag[1].toLowerCase()
          }
          if (amountSats <= 0) {
            const amtTag = zapReq.tags.find((t) => t[0] === 'amount' && t[1])
            if (amtTag?.[1]) {
              const msat = Number.parseInt(amtTag[1], 10)
              if (Number.isFinite(msat) && msat > 0) {
                amountSats = Math.floor(msat / 1000)
              }
            }
          }
        }
      }
    } catch {
      // Ignore malformed description JSON
    }
  }

  if (!recipientPubkey || amountSats <= 0) {
    return null
  }

  return {
    id: event.id,
    amountSats,
    senderPubkey,
    recipientPubkey,
    targetEventId,
    comment,
    createdAt: event.created_at,
    kind: 'nip57',
  }
}

/* --------------------------------------------------------------------------
   Persistence Helpers (Auto-wiped by `agnostr:v2:` Panic Wipe)
   -------------------------------------------------------------------------- */

export function loadStoredLightningAddress(): string | null {
  try {
    return normalizeLightningAddress(localStorage.getItem(LIGHTNING_ADDRESS_STORAGE_KEY))
  } catch {
    return null
  }
}

export function saveStoredLightningAddress(address: string | null): void {
  try {
    const normalized = normalizeLightningAddress(address)
    if (normalized) {
      localStorage.setItem(LIGHTNING_ADDRESS_STORAGE_KEY, normalized)
    } else {
      localStorage.removeItem(LIGHTNING_ADDRESS_STORAGE_KEY)
    }
  } catch {
    // Ignore storage errors
  }
}

interface StoredPeerLud16Cache {
  addresses: Record<string, string>
}

export function loadStoredPeerLud16Cache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PEER_LUD16_CACHE_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<StoredPeerLud16Cache>
    if (!parsed || typeof parsed.addresses !== 'object' || !parsed.addresses) return {}
    const out: Record<string, string> = {}
    for (const [pk, val] of Object.entries(parsed.addresses)) {
      const norm = normalizeLightningAddress(val)
      if (/^[0-9a-f]{64}$/i.test(pk) && norm) {
        out[pk.toLowerCase()] = norm
      }
    }
    return out
  } catch {
    return {}
  }
}

export function saveStoredPeerLud16Cache(addresses: Record<string, string>): void {
  try {
    const entries = Object.entries(addresses).slice(-400)
    const payload: StoredPeerLud16Cache = {
      addresses: Object.fromEntries(entries),
    }
    localStorage.setItem(PEER_LUD16_CACHE_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Ignore storage errors
  }
}

export function loadStoredZapAddressMode(storedCustomAddr?: string | null): ZapAddressMode {
  try {
    const raw = localStorage.getItem(ZAP_MODE_STORAGE_KEY)
    if (raw === 'builtin' || raw === 'custom') return raw
    // Preserve existing custom non-npub.cash addresses for upgraded users
    const existing =
      storedCustomAddr !== undefined
        ? normalizeLightningAddress(storedCustomAddr)
        : loadStoredLightningAddress()
    if (existing && !isNpubCashAddress(existing)) {
      return 'custom'
    }
    return 'builtin'
  } catch {
    return 'builtin'
  }
}

export function saveStoredZapAddressMode(mode: ZapAddressMode): void {
  try {
    localStorage.setItem(ZAP_MODE_STORAGE_KEY, mode)
  } catch {
    // Ignore storage errors
  }
}

export function loadStoredNpubCashAutoSweep(): boolean {
  try {
    const raw = localStorage.getItem(NPUBCASH_AUTOSWEEP_STORAGE_KEY)
    if (raw === 'false' || raw === '0') return false
    return true
  } catch {
    return true
  }
}

export function saveStoredNpubCashAutoSweep(enabled: boolean): void {
  try {
    localStorage.setItem(NPUBCASH_AUTOSWEEP_STORAGE_KEY, enabled ? 'true' : 'false')
  } catch {
    // Ignore storage errors
  }
}
