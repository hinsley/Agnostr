import type { Event as NostrEvent, EventTemplate, VerifiedEvent } from 'nostr-tools'
import type { NpubCashQuote } from '../types/wallet.ts'
import { normalizeMintUrl } from './cashuMints.ts'
import { encodeNpubSafe } from './identity.ts'

/* ==========================================================================
   Built-in npub.cash v2 API Client (NIP-98 Auth + Auto-Sweep Quote Tracking)
   ========================================================================== */

export const NPUB_CASH_BASE_URL = 'https://npub.cash'
export const KIND_NIP98_AUTH = 27235
export const NPUBCASH_CLAIMED_QUOTES_STORAGE_KEY = 'agnostr:v2:npubcash_claimed_quotes'

const MAX_CLAIMED_QUOTES = 500
const DEFAULT_TIMEOUT_MS = 12_000
const MAX_QUOTE_PAGES = 5
const DEFAULT_QUOTES_PAGE_SIZE = 50
const USERNAME_LOCALPART_REGEX = /^[a-z0-9._+-]{1,64}$/i
const KIND_ZAP_REQUEST = 9734

export type Nip98SignEventFn = (template: EventTemplate) => Promise<VerifiedEvent>

export interface NpubCashUserInfo {
  pubkey: string
  name?: string
  mintUrl: string
  lockQuote: boolean
}

export interface ParsedNpubCashZapRequest {
  senderPubkey?: string
  recipientPubkey?: string
  targetEventId?: string
  comment?: string
  amountSats?: number
}

function utf8ToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return globalThis.btoa(binary)
}

/**
 * Strips query parameters and hash fragments from a URL for NIP-98 `u` tag signing.
 * Live-verified against `npub.cash` v2: including `?since=...` in the `u` tag returns HTTP 401.
 */
export function stripQueryForNip98Url(rawUrl: string): string {
  const parsed = new URL(rawUrl)
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
}

/**
 * Builds and signs a NIP-98 HTTP Auth event (`kind: 27235`) for `npub.cash` v2.
 */
export async function signNip98Event(
  signEvent: Nip98SignEventFn,
  url: string,
  method: string
): Promise<VerifiedEvent> {
  const urlForAuth = stripQueryForNip98Url(url)
  const template: EventTemplate = {
    kind: KIND_NIP98_AUTH,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', urlForAuth],
      ['method', method.toUpperCase()],
    ],
    content: '',
  }
  return await signEvent(template)
}

export async function buildNip98AuthHeader(
  signEvent: Nip98SignEventFn,
  url: string,
  method: string
): Promise<string> {
  const signed = await signNip98Event(signEvent, url, method)
  return `Nostr ${utf8ToBase64(JSON.stringify(signed))}`
}

/**
 * Builds the default built-in `npub.cash` Lightning Address for a Nostr master pubkey
 * (`npub1...@npub.cash`, or `<customUsername>@npub.cash` when configured on npub.cash).
 */
export function buildNpubCashAddress(
  masterPubkeyHex: string,
  customUsername?: string | null
): string {
  const cleanName = (customUsername ?? '').trim().toLowerCase()
  if (cleanName && USERNAME_LOCALPART_REGEX.test(cleanName)) {
    return `${cleanName}@npub.cash`
  }
  const npub = encodeNpubSafe(masterPubkeyHex.trim().toLowerCase()).toLowerCase()
  return `${npub}@npub.cash`
}

interface NpubCashEnvelope<TData> {
  error?: boolean
  message?: string
  data?: TData
  metadata?: {
    total?: number
    limit?: number
    offset?: number
  }
}

async function npubCashFetch<TData>(
  signEvent: Nip98SignEventFn,
  path: string,
  opts: {
    method?: 'GET' | 'PATCH' | 'POST'
    body?: Record<string, unknown>
    timeoutMs?: number
  } = {}
): Promise<NpubCashEnvelope<TData>> {
  const method = (opts.method ?? 'GET').toUpperCase() as 'GET' | 'PATCH' | 'POST'
  const fullUrl = new URL(path, NPUB_CASH_BASE_URL).toString()
  const authHeader = await buildNip98AuthHeader(signEvent, fullUrl, method)

  const controller = new AbortController()
  const timer = globalThis.setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  )

  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: authHeader,
    }
    let bodyStr: string | undefined
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      bodyStr = JSON.stringify(opts.body)
    }

    const res = await fetch(fullUrl, {
      method,
      headers,
      body: bodyStr,
      signal: controller.signal,
    })

    let parsed: NpubCashEnvelope<TData> | null = null
    try {
      parsed = (await res.json()) as NpubCashEnvelope<TData>
    } catch {
      parsed = null
    }

    if (!res.ok || parsed?.error === true) {
      const detail = parsed?.message?.trim() || `HTTP ${res.status}`
      throw new Error(`npub.cash request failed (${detail}).`)
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('npub.cash returned an empty or invalid JSON response.')
    }

    return parsed
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Timed out communicating with npub.cash.')
    }
    throw err instanceof Error ? err : new Error('Failed to contact npub.cash.')
  } finally {
    globalThis.clearTimeout(timer)
  }
}

interface RawNpubCashUserData {
  user?: {
    pubkey?: string
    name?: string | null
    mintUrl?: string | null
    lockQuote?: boolean
  }
}

/**
 * `GET /api/v2/user/info` — retrieves the user's npub.cash profile, preferred mint, and NUT-20 lock setting.
 */
export async function fetchNpubCashUser(
  signEvent: Nip98SignEventFn,
  timeoutMs?: number
): Promise<NpubCashUserInfo> {
  const res = await npubCashFetch<RawNpubCashUserData>(signEvent, '/api/v2/user/info', {
    method: 'GET',
    timeoutMs,
  })
  const user = res.data?.user
  if (!user || typeof user.pubkey !== 'string') {
    throw new Error('npub.cash user info response was missing user data.')
  }

  const rawMint = typeof user.mintUrl === 'string' ? user.mintUrl.trim() : ''
  const mintUrl = (rawMint ? normalizeMintUrl(rawMint) : null) ?? rawMint
  const name =
    typeof user.name === 'string' && user.name.trim() ? user.name.trim().toLowerCase() : undefined

  return {
    pubkey: user.pubkey.toLowerCase(),
    ...(name ? { name } : {}),
    mintUrl,
    lockQuote: Boolean(user.lockQuote),
  }
}

/**
 * `PATCH /api/v2/user/mint` — updates the user's receiving Cashu mint on npub.cash.
 */
export async function syncNpubCashMint(
  signEvent: Nip98SignEventFn,
  mintUrl: string,
  timeoutMs?: number
): Promise<{ mintUrl: string }> {
  const normalized = normalizeMintUrl(mintUrl)
  if (!normalized) {
    throw new Error('Invalid Cashu mint URL for npub.cash.')
  }

  await npubCashFetch<unknown>(signEvent, '/api/v2/user/mint', {
    method: 'PATCH',
    body: { mint_url: normalized },
    timeoutMs,
  })

  return { mintUrl: normalized }
}

/**
 * `PATCH /api/v2/user/lock` — enables or disables NUT-20 quote locking on npub.cash.
 */
export async function setNpubCashLockQuotes(
  signEvent: Nip98SignEventFn,
  lockQuotes: boolean,
  timeoutMs?: number
): Promise<{ lockQuote: boolean }> {
  await npubCashFetch<unknown>(signEvent, '/api/v2/user/lock', {
    method: 'PATCH',
    body: { lockQuotes: Boolean(lockQuotes) },
    timeoutMs,
  })

  return { lockQuote: Boolean(lockQuotes) }
}

interface RawNpubCashQuote {
  createdAt?: number
  paidAt?: number | null
  expiresAt?: number | null
  mintUrl?: string
  quoteId?: string
  request?: string
  amount?: number | string
  state?: string
  locked?: boolean
  zapRequest?: string | null
}

interface RawNpubCashQuotesData {
  quotes?: RawNpubCashQuote[]
}

function normalizeQuoteRecord(raw: RawNpubCashQuote): NpubCashQuote | null {
  if (!raw || typeof raw.quoteId !== 'string' || !raw.quoteId.trim()) return null
  if (typeof raw.mintUrl !== 'string' || !raw.mintUrl.trim()) return null

  const mintUrl = normalizeMintUrl(raw.mintUrl) ?? raw.mintUrl.trim()
  const amountNum =
    typeof raw.amount === 'number'
      ? Math.floor(raw.amount)
      : typeof raw.amount === 'string'
        ? Number.parseInt(raw.amount, 10)
        : 0
  if (!Number.isFinite(amountNum) || amountNum < 0) return null

  return {
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    paidAt: typeof raw.paidAt === 'number' && Number.isFinite(raw.paidAt) ? raw.paidAt : null,
    expiresAt:
      typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt) ? raw.expiresAt : null,
    mintUrl,
    quoteId: raw.quoteId.trim(),
    request: typeof raw.request === 'string' ? raw.request.trim() : '',
    amount: amountNum,
    state: typeof raw.state === 'string' ? raw.state.trim().toUpperCase() : 'UNPAID',
    locked: Boolean(raw.locked),
    ...(typeof raw.zapRequest === 'string' && raw.zapRequest.trim()
      ? { zapRequest: raw.zapRequest.trim() }
      : {}),
  }
}

/**
 * `GET /api/v2/wallet/quotes` — fetches the user's paid/pending npub.cash mint quotes,
 * safely paginating up to 5 pages (`limit=50`).
 */
export async function fetchNpubCashQuotes(
  signEvent: Nip98SignEventFn,
  sinceSec?: number,
  opts?: {
    maxPages?: number
    pageSize?: number
    timeoutMs?: number
  }
): Promise<NpubCashQuote[]> {
  const maxPages = Math.max(1, Math.min(MAX_QUOTE_PAGES, opts?.maxPages ?? MAX_QUOTE_PAGES))
  const limit = Math.max(1, Math.min(50, opts?.pageSize ?? DEFAULT_QUOTES_PAGE_SIZE))
  const seen = new Set<string>()
  const collected: NpubCashQuote[] = []

  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit
    const params = new URLSearchParams()
    params.set('offset', String(offset))
    params.set('limit', String(limit))
    if (typeof sinceSec === 'number' && Number.isFinite(sinceSec) && sinceSec > 0) {
      params.set('since', String(Math.floor(sinceSec)))
    }

    const res = await npubCashFetch<RawNpubCashQuotesData>(
      signEvent,
      `/api/v2/wallet/quotes?${params.toString()}`,
      { method: 'GET', timeoutMs: opts?.timeoutMs }
    )

    const rawQuotes = Array.isArray(res.data?.quotes) ? res.data.quotes : []
    for (const item of rawQuotes) {
      const normalized = normalizeQuoteRecord(item)
      if (!normalized || seen.has(normalized.quoteId)) continue
      seen.add(normalized.quoteId)
      collected.push(normalized)
    }

    const total = typeof res.metadata?.total === 'number' ? res.metadata.total : null
    if (rawQuotes.length < limit) break
    if (total !== null && offset + rawQuotes.length >= total) break
  }

  return collected
}

/**
 * Extracts sender pubkey, comment, target event, and satoshi amount from an embedded
 * NIP-57 `kind: 9734` Zap Request JSON string returned on an `npub.cash` quote.
 */
export function parseNpubCashZapRequest(
  rawJson?: string | null
): ParsedNpubCashZapRequest | null {
  if (!rawJson || !rawJson.trim()) return null
  try {
    const parsed = JSON.parse(rawJson) as Partial<NostrEvent>
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.kind !== undefined && parsed.kind !== KIND_ZAP_REQUEST) return null

    const senderPubkey =
      typeof parsed.pubkey === 'string' && /^[0-9a-f]{64}$/i.test(parsed.pubkey)
        ? parsed.pubkey.toLowerCase()
        : undefined
    const comment =
      typeof parsed.content === 'string' && parsed.content.trim()
        ? parsed.content.trim().slice(0, 280)
        : undefined

    let recipientPubkey: string | undefined
    let targetEventId: string | undefined
    let amountSats: number | undefined

    if (Array.isArray(parsed.tags)) {
      for (const tag of parsed.tags) {
        if (!Array.isArray(tag) || tag.length < 2 || typeof tag[1] !== 'string') continue
        if (!recipientPubkey && tag[0] === 'p' && /^[0-9a-f]{64}$/i.test(tag[1])) {
          recipientPubkey = tag[1].toLowerCase()
        } else if (!targetEventId && tag[0] === 'e' && /^[0-9a-f]{64}$/i.test(tag[1])) {
          targetEventId = tag[1].toLowerCase()
        } else if (amountSats === undefined && tag[0] === 'amount') {
          const msat = Number.parseInt(tag[1], 10)
          if (Number.isFinite(msat) && msat > 0) {
            amountSats = Math.floor(msat / 1000)
          }
        }
      }
    }

    if (!senderPubkey && !comment && !recipientPubkey && !targetEventId && amountSats === undefined) {
      return null
    }

    return {
      ...(senderPubkey ? { senderPubkey } : {}),
      ...(recipientPubkey ? { recipientPubkey } : {}),
      ...(targetEventId ? { targetEventId } : {}),
      ...(comment ? { comment } : {}),
      ...(amountSats !== undefined ? { amountSats } : {}),
    }
  } catch {
    return null
  }
}

/* --------------------------------------------------------------------------
   Claimed Quote ID LRU Cache (`agnostr:v2:npubcash_claimed_quotes`, cap 500)
   -------------------------------------------------------------------------- */

export function loadClaimedNpubCashQuotes(): Set<string> {
  try {
    const raw = localStorage.getItem(NPUBCASH_CLAIMED_QUOTES_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    const out = new Set<string>()
    for (const item of parsed) {
      if (typeof item === 'string' && item.trim()) {
        out.add(item.trim())
      }
    }
    return out
  } catch {
    return new Set()
  }
}

export function saveClaimedNpubCashQuotes(ids: Iterable<string>): void {
  try {
    const unique: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      const clean = id.trim()
      if (!clean || seen.has(clean)) continue
      seen.add(clean)
      unique.push(clean)
    }
    const capped = unique.slice(-MAX_CLAIMED_QUOTES)
    localStorage.setItem(NPUBCASH_CLAIMED_QUOTES_STORAGE_KEY, JSON.stringify(capped))
  } catch {
    // Ignore storage quota errors
  }
}

export function markNpubCashQuoteClaimed(quoteId: string): Set<string> {
  const clean = quoteId.trim()
  const set = loadClaimedNpubCashQuotes()
  if (clean) {
    // Refresh insertion order for LRU eviction
    set.delete(clean)
    set.add(clean)
    saveClaimedNpubCashQuotes(set)
  }
  return set
}

export function isNpubCashQuoteClaimed(quoteId: string): boolean {
  const clean = quoteId.trim()
  if (!clean) return false
  return loadClaimedNpubCashQuotes().has(clean)
}

export function clearClaimedNpubCashQuotes(): void {
  try {
    localStorage.removeItem(NPUBCASH_CLAIMED_QUOTES_STORAGE_KEY)
  } catch {
    // Ignore storage errors
  }
}
