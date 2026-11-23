import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import type {
  BoltzReversePairInfo,
  BoltzSubmarinePairInfo,
  BoltzSwapDirection,
  BoltzSwapRecord,
  BoltzSwapTree,
} from '../types/wallet.ts'
import { bytesToHex } from './identity.ts'

export const DEFAULT_BOLTZ_API_URL = 'https://api.boltz.exchange/v2'
export const BOLTZ_SWAPS_STORAGE_KEY = 'agnostr:v2:boltz_swaps'
export const BOLTZ_API_URL_STORAGE_KEY = 'agnostr:v2:boltz_api_url'

const MAX_STORED_SWAPS = 40

/**
 * Normalizes a Boltz Exchange v2 API base URL (default: `https://api.boltz.exchange/v2`).
 */
export function normalizeBoltzApiUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const u = new URL(withProto)
    const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal)) {
      return null
    }
    const cleanPath = u.pathname.replace(/\/+$/, '')
    return `${u.origin}${cleanPath || '/v2'}`
  } catch {
    return null
  }
}

/**
 * Validates standard Bitcoin mainnet on-chain addresses:
 * - Native SegWit / Taproot (`bc1q...`, `bc1p...`)
 * - Legacy P2PKH (`1...`) and P2SH (`3...`)
 */
export function isValidBitcoinAddress(raw: string): boolean {
  const addr = raw.trim()
  if (!addr) return false
  if (/^bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{25,87}$/i.test(addr)) {
    return addr === addr.toLowerCase() || addr === addr.toUpperCase()
  }
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(addr)) {
    return true
  }
  return false
}

/**
 * Formats a BIP-21 Bitcoin payment URI (`bitcoin:<addr>?amount=<btc>`).
 */
export function buildBip21Uri(address: string, amountSats: number): string {
  const btc = (amountSats / 100_000_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
  return `bitcoin:${address}?amount=${btc}`
}

export function getMempoolTxUrl(txid: string): string {
  return `https://mempool.space/tx/${encodeURIComponent(txid)}`
}

export function getMempoolAddressUrl(address: string): string {
  return `https://mempool.space/address/${encodeURIComponent(address)}`
}

/**
 * Generates a fresh local secp256k1 keypair with a 33-byte compressed public key
 * for Boltz v2 HTLC refund (Submarine) or claim (Reverse Submarine) safety.
 */
export function generateBoltzKeypair(): {
  privateKeyHex: string
  publicKeyHex: string
} {
  const sk = secp256k1.utils.randomPrivateKey()
  const pkCompressed = secp256k1.getPublicKey(sk, true)
  return {
    privateKeyHex: bytesToHex(sk),
    publicKeyHex: bytesToHex(pkCompressed),
  }
}

/**
 * Generates a 32-byte random secret preimage and its SHA-256 hash hex.
 */
export function generateBoltzPreimage(): {
  preimageHex: string
  preimageHashHex: string
} {
  const preimage = new Uint8Array(32)
  crypto.getRandomValues(preimage)
  const hash = sha256(preimage)
  return {
    preimageHex: bytesToHex(preimage),
    preimageHashHex: bytesToHex(hash),
  }
}

async function boltzFetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 12_000
): Promise<T> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    })

    const text = await res.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        // Non-JSON error body
      }
    }

    if (!res.ok) {
      const apiErr =
        parsed &&
        typeof parsed === 'object' &&
        'error' in parsed &&
        typeof (parsed as { error?: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : `Boltz API returned HTTP ${res.status}.`
      throw new Error(apiErr)
    }

    return parsed as T
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Boltz Exchange API timed out. Check your connection or custom Boltz API URL.')
    }
    if (err instanceof TypeError) {
      throw new Error(
        'Could not reach Boltz Exchange API (it may be geo-restricted in your region or offline). You can configure a custom Boltz v2 API mirror below.'
      )
    }
    throw err instanceof Error ? err : new Error('Boltz Exchange API request failed.')
  } finally {
    window.clearTimeout(timer)
  }
}

interface RawSubmarinePairsResponse {
  BTC?: {
    BTC?: {
      hash: string
      rate: number
      limits: {
        minimal: number
        maximal: number
        maximalZeroConf?: number
      }
      fees: {
        percentage: number
        minerFees: number
      }
    }
  }
}

interface RawReversePairsResponse {
  BTC?: {
    BTC?: {
      hash: string
      rate: number
      limits: {
        minimal: number
        maximal: number
      }
      fees: {
        percentage: number
        minerFees: {
          lockup: number
          claim: number
        }
      }
    }
  }
}

/**
 * Queries live BTC -> BTC Submarine Swap limits and fees from Boltz v2 (`GET /v2/swap/submarine`).
 */
export async function fetchBoltzSubmarinePair(
  apiUrl = DEFAULT_BOLTZ_API_URL
): Promise<BoltzSubmarinePairInfo> {
  const base = normalizeBoltzApiUrl(apiUrl) ?? DEFAULT_BOLTZ_API_URL
  const data = await boltzFetchJson<RawSubmarinePairsResponse>(`${base}/swap/submarine`)
  const pair = data?.BTC?.BTC
  if (!pair || !pair.limits || !pair.fees) {
    throw new Error('Boltz API did not return a BTC/BTC submarine swap pair.')
  }
  return {
    hash: pair.hash,
    rate: Number(pair.rate) || 1,
    minSats: Math.ceil(Number(pair.limits.minimal) || 25_000),
    maxSats: Math.floor(Number(pair.limits.maximal) || 25_000_000),
    maxZeroConfSats: Math.floor(Number(pair.limits.maximalZeroConf) || 0),
    feePercent: Number(pair.fees.percentage) || 0.1,
    minerFeeSats: Math.ceil(Number(pair.fees.minerFees) || 0),
    fetchedAt: Date.now(),
  }
}

/**
 * Queries live BTC -> BTC Reverse Submarine Swap limits and fees from Boltz v2 (`GET /v2/swap/reverse`).
 */
export async function fetchBoltzReversePair(
  apiUrl = DEFAULT_BOLTZ_API_URL
): Promise<BoltzReversePairInfo> {
  const base = normalizeBoltzApiUrl(apiUrl) ?? DEFAULT_BOLTZ_API_URL
  const data = await boltzFetchJson<RawReversePairsResponse>(`${base}/swap/reverse`)
  const pair = data?.BTC?.BTC
  if (!pair || !pair.limits || !pair.fees) {
    throw new Error('Boltz API did not return a BTC/BTC reverse swap pair.')
  }
  return {
    hash: pair.hash,
    rate: Number(pair.rate) || 1,
    minSats: Math.ceil(Number(pair.limits.minimal) || 25_000),
    maxSats: Math.floor(Number(pair.limits.maximal) || 25_000_000),
    feePercent: Number(pair.fees.percentage) || 0.25,
    lockupMinerFeeSats: Math.ceil(Number(pair.fees.minerFees?.lockup) || 0),
    claimMinerFeeSats: Math.ceil(Number(pair.fees.minerFees?.claim) || 0),
    fetchedAt: Date.now(),
  }
}

interface RawSubmarineCreateResponse {
  id: string
  bip21?: string
  address: string
  swapTree?: BoltzSwapTree
  claimPublicKey?: string
  timeoutBlockHeight?: number
  acceptZeroConf?: boolean
  expectedAmount: number
}

/**
 * Creates a Boltz v2 Submarine Swap (`POST /v2/swap/submarine`) converting
 * an on-chain BTC deposit into payment of a Cashu NUT-04 Lightning mint quote.
 */
export async function createBoltzSubmarineSwap(params: {
  apiUrl?: string
  invoice: string
  mintUrl: string
  mintQuoteId: string
  amountSats: number
  pairInfo?: BoltzSubmarinePairInfo
}): Promise<BoltzSwapRecord> {
  const base = normalizeBoltzApiUrl(params.apiUrl) ?? DEFAULT_BOLTZ_API_URL
  const keypair = generateBoltzKeypair()

  const body: Record<string, unknown> = {
    from: 'BTC',
    to: 'BTC',
    invoice: params.invoice,
    refundPublicKey: keypair.publicKeyHex,
  }
  if (params.pairInfo?.hash) {
    body.pairHash = params.pairInfo.hash
  }

  const created = await boltzFetchJson<RawSubmarineCreateResponse>(`${base}/swap/submarine`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

  if (!created?.id || !created?.address) {
    throw new Error('Boltz submarine swap creation returned an incomplete response.')
  }

  const expectedOnchainSats = Math.max(
    params.amountSats,
    Math.ceil(Number(created.expectedAmount) || params.amountSats)
  )
  const feeSats = Math.max(0, expectedOnchainSats - params.amountSats)
  const now = Date.now()

  return {
    id: created.id,
    direction: 'submarine',
    apiUrl: base,
    mintUrl: params.mintUrl,
    status: 'swap.created',
    createdAt: now,
    updatedAt: now,
    amountSats: params.amountSats,
    expectedOnchainSats,
    feeSats,
    invoice: params.invoice,
    mintQuoteId: params.mintQuoteId,
    mintClaimed: false,
    address: created.address,
    bip21: created.bip21 || buildBip21Uri(created.address, expectedOnchainSats),
    timeoutBlockHeight: created.timeoutBlockHeight,
    acceptZeroConf: Boolean(created.acceptZeroConf),
    localKeyPrivateHex: keypair.privateKeyHex,
    localKeyPublicHex: keypair.publicKeyHex,
    boltzPublicKeyHex: created.claimPublicKey,
    swapTree: created.swapTree,
  }
}

interface RawReverseCreateResponse {
  id: string
  invoice: string
  lockupAddress: string
  onchainAmount: number
  refundPublicKey?: string
  timeoutBlockHeight?: number
  swapTree?: BoltzSwapTree
}

/**
 * Creates a Boltz v2 Reverse Submarine Swap (`POST /v2/swap/reverse`) converting
 * a Cashu NUT-05 Lightning melt into an on-chain Bitcoin HTLC lockup.
 */
export async function createBoltzReverseSwap(params: {
  apiUrl?: string
  destinationAddress: string
  amountSats: number
  mintUrl: string
  pairInfo?: BoltzReversePairInfo
}): Promise<BoltzSwapRecord> {
  const dest = params.destinationAddress.trim()
  if (!isValidBitcoinAddress(dest)) {
    throw new Error('Enter a valid Bitcoin mainnet address (bc1..., 1..., or 3...).')
  }

  const base = normalizeBoltzApiUrl(params.apiUrl) ?? DEFAULT_BOLTZ_API_URL
  const keypair = generateBoltzKeypair()
  const { preimageHex, preimageHashHex } = generateBoltzPreimage()

  const body: Record<string, unknown> = {
    from: 'BTC',
    to: 'BTC',
    invoiceAmount: Math.floor(params.amountSats),
    preimageHash: preimageHashHex,
    claimPublicKey: keypair.publicKeyHex,
  }
  if (params.pairInfo?.hash) {
    body.pairHash = params.pairInfo.hash
  }

  const created = await boltzFetchJson<RawReverseCreateResponse>(`${base}/swap/reverse`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

  if (!created?.id || !created?.invoice || !created?.lockupAddress) {
    throw new Error('Boltz reverse swap creation returned an incomplete response.')
  }

  const onchainAmount = Math.max(0, Math.floor(Number(created.onchainAmount) || 0))
  const feeSats = Math.max(0, Math.floor(params.amountSats) - onchainAmount)
  const now = Date.now()

  return {
    id: created.id,
    direction: 'reverse',
    apiUrl: base,
    mintUrl: params.mintUrl,
    status: 'swap.created',
    createdAt: now,
    updatedAt: now,
    amountSats: Math.floor(params.amountSats),
    expectedOnchainSats: onchainAmount,
    feeSats,
    invoice: created.invoice,
    address: created.lockupAddress,
    destinationAddress: dest,
    timeoutBlockHeight: created.timeoutBlockHeight,
    localKeyPrivateHex: keypair.privateKeyHex,
    localKeyPublicHex: keypair.publicKeyHex,
    boltzPublicKeyHex: created.refundPublicKey,
    preimageHex,
    preimageHashHex,
    swapTree: created.swapTree,
  }
}

interface RawSwapStatusResponse {
  status: string
  zeroConfRejected?: boolean
  failureReason?: string
  transaction?: {
    id?: string
    hex?: string
    eta?: number
    confirmed?: boolean
  }
}

export interface BoltzSwapStatusResult {
  status: string
  txid?: string
  txConfirmed?: boolean
  zeroConfRejected?: boolean
  failureReason?: string
}

/**
 * Fetches the current status of a Boltz v2 swap (`GET /v2/swap/:id`).
 */
export async function fetchBoltzSwapStatus(
  swapId: string,
  apiUrl = DEFAULT_BOLTZ_API_URL
): Promise<BoltzSwapStatusResult> {
  const base = normalizeBoltzApiUrl(apiUrl) ?? DEFAULT_BOLTZ_API_URL
  const data = await boltzFetchJson<RawSwapStatusResponse>(
    `${base}/swap/${encodeURIComponent(swapId)}`
  )
  return {
    status: data.status || 'swap.created',
    txid: data.transaction?.id,
    txConfirmed: data.transaction?.confirmed,
    zeroConfRejected: data.zeroConfRejected,
    failureReason: data.failureReason,
  }
}

export function isBoltzSwapCompleted(direction: BoltzSwapDirection, status: string): boolean {
  if (direction === 'submarine') {
    return status === 'transaction.claimed' || status === 'invoice.paid'
  }
  return status === 'invoice.settled' || status === 'transaction.claimed'
}

export function isBoltzSwapFailed(status: string): boolean {
  return (
    status === 'swap.expired' ||
    status === 'invoice.expired' ||
    status === 'invoice.failedToPay' ||
    status === 'transaction.failed' ||
    status === 'transaction.lockupFailed' ||
    status === 'transaction.refunded'
  )
}

export function isBoltzSwapActive(swap: BoltzSwapRecord): boolean {
  if (isBoltzSwapFailed(swap.status)) return false
  if (swap.direction === 'submarine') {
    return !swap.mintClaimed
  }
  return !isBoltzSwapCompleted('reverse', swap.status)
}

export function formatBoltzStatusLabel(status: string): string {
  switch (status) {
    case 'swap.created':
      return 'Awaiting deposit'
    case 'invoice.set':
    case 'invoice.pending':
      return 'Invoice pending'
    case 'transaction.mempool':
    case 'transaction.server.mempool':
      return 'In Bitcoin mempool'
    case 'transaction.confirmed':
    case 'transaction.server.confirmed':
      return 'On-chain confirmed'
    case 'invoice.paid':
      return 'Lightning paid — claiming ecash'
    case 'invoice.settled':
      return 'Swap settled'
    case 'transaction.claim.pending':
      return 'Claim broadcasting'
    case 'transaction.claimed':
      return 'Completed'
    case 'transaction.refunded':
      return 'Refunded'
    case 'swap.expired':
    case 'invoice.expired':
      return 'Expired'
    case 'invoice.failedToPay':
      return 'Lightning payment failed'
    case 'transaction.failed':
    case 'transaction.lockupFailed':
      return 'Lockup failed — refund available'
    case 'transaction.zeroconf.rejected':
      return 'Waiting for 1 confirmation'
    default:
      return status
  }
}

/**
 * Builds an exportable Boltz Rescue / Refund / Claim JSON bundle containing the
 * swap tree, local private key, preimage (for reverse swaps), and timeout block height.
 */
export function buildBoltzSwapRescueJson(swap: BoltzSwapRecord): string {
  const bundle = {
    version: 2,
    provider: 'boltz.exchange',
    apiUrl: swap.apiUrl,
    id: swap.id,
    direction: swap.direction,
    pair: 'BTC/BTC',
    status: swap.status,
    address: swap.address,
    destinationAddress: swap.destinationAddress ?? null,
    amountSats: swap.amountSats,
    expectedOnchainSats: swap.expectedOnchainSats,
    timeoutBlockHeight: swap.timeoutBlockHeight ?? null,
    refundPrivateKey: swap.direction === 'submarine' ? swap.localKeyPrivateHex : undefined,
    refundPublicKey:
      swap.direction === 'submarine' ? swap.localKeyPublicHex : swap.boltzPublicKeyHex,
    claimPrivateKey: swap.direction === 'reverse' ? swap.localKeyPrivateHex : undefined,
    claimPublicKey:
      swap.direction === 'reverse' ? swap.localKeyPublicHex : swap.boltzPublicKeyHex,
    preimage: swap.preimageHex,
    preimageHash: swap.preimageHashHex,
    swapTree: swap.swapTree ?? null,
    invoice: swap.invoice,
    mintUrl: swap.mintUrl,
    mintQuoteId: swap.mintQuoteId ?? null,
    txid: swap.txid ?? null,
    exportedAt: new Date().toISOString(),
  }
  return JSON.stringify(bundle, null, 2)
}

/* --------------------------------------------------------------------------
   Persistence Helpers (Auto-wiped by `agnostr:v2:` Panic Wipe)
   -------------------------------------------------------------------------- */

export function loadStoredBoltzApiUrl(): string {
  try {
    return normalizeBoltzApiUrl(localStorage.getItem(BOLTZ_API_URL_STORAGE_KEY)) ?? DEFAULT_BOLTZ_API_URL
  } catch {
    return DEFAULT_BOLTZ_API_URL
  }
}

export function saveStoredBoltzApiUrl(url: string): string {
  const normalized = normalizeBoltzApiUrl(url) ?? DEFAULT_BOLTZ_API_URL
  try {
    localStorage.setItem(BOLTZ_API_URL_STORAGE_KEY, normalized)
  } catch {
    // Ignore storage errors
  }
  return normalized
}

export function loadStoredBoltzSwaps(): BoltzSwapRecord[] {
  try {
    const raw = localStorage.getItem(BOLTZ_SWAPS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is BoltzSwapRecord => Boolean(item && typeof item === 'object' && 'id' in item))
      .slice(0, MAX_STORED_SWAPS)
  } catch {
    return []
  }
}

export function saveStoredBoltzSwaps(swaps: BoltzSwapRecord[]): void {
  try {
    localStorage.setItem(BOLTZ_SWAPS_STORAGE_KEY, JSON.stringify(swaps.slice(0, MAX_STORED_SWAPS)))
  } catch {
    // Ignore storage errors
  }
}
