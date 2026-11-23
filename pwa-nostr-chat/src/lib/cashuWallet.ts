import {
  Amount,
  CheckStateEnum,
  MeltQuoteState,
  Mint,
  MintQuoteState,
  Wallet,
  getEncodedToken,
  getTokenMetadata,
  type CounterRange,
  type CounterSource,
  type MeltQuoteBolt11Response,
  type MintQuoteBolt11Response,
  type Proof,
  type ProofLike,
} from '@cashu/cashu-ts'
import { sha256 } from '@noble/hashes/sha256'
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english'
import { getPublicKey } from 'nostr-tools'
import type {
  CashuMeltQuotePreview,
  CashuMintAccount,
  CashuMintInfoSummary,
  CashuMintQuoteRecord,
  CashuMintQuoteState,
  CashuSentTokenRecord,
  CashuTokenPreview,
  StoredCashuProof,
  WalletBackupPayload,
  WalletDraftKeys,
  WalletImportMode,
  WalletTransaction,
} from '../types/wallet.ts'
import {
  DEFAULT_ACTIVE_MINT_URL,
  DEFAULT_CASHU_MINTS,
  findCatalogMint,
  formatMintHost,
  normalizeMintUrl,
  probeCashuMint,
} from './cashuMints.ts'
import {
  bytesToHex,
  encodeNsecSafe,
  hexToBytes,
  parseSecretKey,
} from './identity.ts'

export const CASHU_WALLET_STORAGE_KEY = 'agnostr:v2:cashu_wallet'

const MAX_HISTORY_ITEMS = 250
const MAX_SENT_TOKENS = 100
const CASHU_TOKEN_GLOBAL_REGEX = /\b(cashu[AB][A-Za-z0-9_-]{20,})\b/g
const CASHU_TOKEN_SINGLE_REGEX = /^(?:cashu:)?(cashu[AB][A-Za-z0-9_-]{20,})$/i

const utf8Encoder = new TextEncoder()

export interface PersistedCashuWalletState {
  version: 1
  initialized: boolean
  mnemonic?: string
  privateKeyHex?: string
  keysetCounters: Record<string, number>
  activeMintUrl: string
  mints: CashuMintAccount[]
  proofsByMint: Record<string, StoredCashuProof[]>
  history: WalletTransaction[]
  sentTokens: CashuSentTokenRecord[]
}

/* --------------------------------------------------------------------------
   NUT-13 BIP-39 Seed & Wallet Private Key Helpers
   -------------------------------------------------------------------------- */

export function normalizeMnemonicPhrase(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

export function isValidBip39Mnemonic(raw: string): boolean {
  const norm = normalizeMnemonicPhrase(raw)
  const words = norm.split(' ').filter(Boolean)
  if (words.length !== 12 && words.length !== 24) return false
  return validateMnemonic(norm, englishWordlist)
}

/**
 * Derives a valid 32-byte secp256k1 wallet private key hex deterministically from a 64-byte BIP-39 seed.
 */
export function derivePrivateKeyHexFromSeed(seed: Uint8Array): string {
  const domain = utf8Encoder.encode('agnostr-cashu-p2pk-v1:')
  for (let i = 0; i < 16; i++) {
    const buf = new Uint8Array(domain.length + seed.length + 1)
    buf.set(domain, 0)
    buf.set(seed, domain.length)
    buf[domain.length + seed.length] = i
    const candidate = sha256(buf)
    try {
      getPublicKey(candidate)
      return bytesToHex(candidate)
    } catch {
      // Retry if scalar invalid
    }
  }
  return bytesToHex(sha256(seed))
}

/**
 * Generates a fresh 12-word BIP-39 English recovery phrase and deterministic 64-hex private key.
 */
export function generateCashuWalletKeys(): WalletDraftKeys {
  const mnemonic = generateMnemonic(englishWordlist, 128)
  const seed = mnemonicToSeedSync(mnemonic)
  const privateKeyHex = derivePrivateKeyHexFromSeed(seed)
  return { mnemonic, privateKeyHex }
}

/**
 * Derives a 64-byte NUT-13 `bip39seed` from either a BIP-39 mnemonic (standard) or
 * deterministically stretched from a 64-hex private key if imported without a phrase.
 */
export function deriveNut13SeedBytes(params: {
  mnemonic?: string | null
  privateKeyHex?: string | null
}): Uint8Array | undefined {
  if (params.mnemonic && isValidBip39Mnemonic(params.mnemonic)) {
    return mnemonicToSeedSync(normalizeMnemonicPhrase(params.mnemonic))
  }
  if (params.privateKeyHex) {
    const pkBytes = hexToBytes(params.privateKeyHex)
    if (pkBytes && pkBytes.length === 32) {
      const a = sha256(new Uint8Array([...utf8Encoder.encode('agnostr-cashu-seed-a:'), ...pkBytes]))
      const b = sha256(new Uint8Array([...utf8Encoder.encode('agnostr-cashu-seed-b:'), ...pkBytes]))
      const out = new Uint8Array(64)
      out.set(a, 0)
      out.set(b, 32)
      return out
    }
  }
  return undefined
}

export function encodeWalletPrivateKeyNsec(privateKeyHex: string | null | undefined): string | null {
  if (!privateKeyHex) return null
  const bytes = hexToBytes(privateKeyHex)
  if (!bytes || bytes.length !== 32) return null
  return encodeNsecSafe(bytes)
}

export function parseWalletPrivateKeyHex(raw: string): string | null {
  const parsed = parseSecretKey(raw)
  if (!parsed || parsed.length !== 32) return null
  return bytesToHex(parsed)
}

export interface DetectedWalletImport {
  mode: WalletImportMode
  label: string
}

/**
 * Synchronously detects whether pasted/uploaded text is a 12/24-word BIP-39 phrase,
 * a 64-hex / `nsec1…` private key, or a Cashu wallet backup JSON object.
 */
export function detectWalletImportFormat(raw: string): DetectedWalletImport | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      if (
        parsed &&
        typeof parsed === 'object' &&
        (typeof parsed.proofsByMint === 'object' ||
          typeof parsed.mnemonic === 'string' ||
          typeof parsed.privateKeyHex === 'string')
      ) {
        return { mode: 'json', label: 'Backup JSON' }
      }
    } catch {
      return null
    }
    return null
  }

  if (parseWalletPrivateKeyHex(trimmed)) {
    return {
      mode: 'privkey',
      label: trimmed.toLowerCase().startsWith('nsec1') ? 'Private key (nsec)' : 'Private key',
    }
  }

  if (isValidBip39Mnemonic(trimmed)) {
    const count = normalizeMnemonicPhrase(trimmed).split(' ').length
    return { mode: 'mnemonic', label: `${count}-word seed` }
  }

  return null
}

/* --------------------------------------------------------------------------
   Token Detection & Synchronous Offline Preview Helpers (Used by Chat & QR)
   -------------------------------------------------------------------------- */

export function extractCashuTokenString(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const direct = trimmed.match(CASHU_TOKEN_SINGLE_REGEX)
  if (direct) return direct[1]
  const inline = trimmed.match(/\b(cashu[AB][A-Za-z0-9_-]{20,})\b/)
  return inline ? inline[1] : null
}

export function isCashuTokenString(raw: string): boolean {
  return extractCashuTokenString(raw) !== null
}

export function extractCashuTokensFromText(text: string): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const out: string[] = []
  let match: RegExpExecArray | null
  const re = new RegExp(CASHU_TOKEN_GLOBAL_REGEX.source, 'g')
  while ((match = re.exec(text)) !== null) {
    const token = match[1]
    if (!seen.has(token)) {
      seen.add(token)
      out.push(token)
    }
  }
  return out
}

/**
 * Synchronously decodes a `cashuA...` (V3) or `cashuB...` (V4) token using
 * `@cashu/cashu-ts` v4 `getTokenMetadata` with ZERO network requests.
 */
export function decodeCashuTokenPreview(raw: string): CashuTokenPreview | null {
  const tokenStr = extractCashuTokenString(raw)
  if (!tokenStr) return null
  try {
    const meta = getTokenMetadata(tokenStr)
    const mintUrl = normalizeMintUrl(meta.mint) ?? meta.mint
    const amountSats = amountToNumberSafe(meta.amount)
    if (!mintUrl || amountSats <= 0) return null
    return {
      raw: tokenStr,
      mintUrl,
      unit: meta.unit || 'sat',
      amountSats,
      memo: meta.memo?.trim() || undefined,
      proofCount: Array.isArray(meta.proofAmounts) ? meta.proofAmounts.length : 1,
    }
  } catch {
    return null
  }
}

/* --------------------------------------------------------------------------
   Amount & Proof Serialization Helpers (`@cashu/cashu-ts` v4 Boundary)
   -------------------------------------------------------------------------- */

export function amountToNumberSafe(val: Amount | number | string | bigint | undefined | null): number {
  if (val === null || val === undefined) return 0
  if (typeof val === 'number') return Number.isFinite(val) ? Math.floor(val) : 0
  if (typeof val === 'bigint') return Number(val)
  if (typeof val === 'string') {
    const n = Number.parseInt(val, 10)
    return Number.isFinite(n) ? n : 0
  }
  if (typeof val === 'object' && typeof val.toNumber === 'function') {
    return val.toNumber()
  }
  return 0
}

export function toStoredProof(proof: Proof | ProofLike): StoredCashuProof {
  const stored: StoredCashuProof = {
    id: proof.id,
    amount: amountToNumberSafe(proof.amount),
    secret: proof.secret,
    C: proof.C,
  }
  if (proof.dleq && typeof proof.dleq === 'object') {
    stored.dleq = {
      e: proof.dleq.e,
      s: proof.dleq.s,
      ...(proof.dleq.r ? { r: proof.dleq.r } : {}),
    }
  }
  if (proof.witness !== undefined) {
    stored.witness = proof.witness as string | Record<string, unknown>
  }
  return stored
}

export function toCashuProof(proof: StoredCashuProof): Proof {
  const out: Proof = {
    id: proof.id,
    amount: Amount.from(Math.max(0, Math.floor(proof.amount))),
    secret: proof.secret,
    C: proof.C,
  }
  if (proof.dleq) {
    out.dleq = {
      e: proof.dleq.e,
      s: proof.dleq.s,
      r: proof.dleq.r ?? '',
    }
  }
  if (proof.witness !== undefined) {
    out.witness = proof.witness as Proof['witness']
  }
  return out
}

export function deduplicateProofs(proofs: StoredCashuProof[]): StoredCashuProof[] {
  const seen = new Set<string>()
  const out: StoredCashuProof[] = []
  for (const p of proofs) {
    if (!p || !p.secret || !p.id || !p.C || !Number.isFinite(p.amount) || p.amount <= 0) continue
    if (seen.has(p.secret)) continue
    seen.add(p.secret)
    out.push({
      id: p.id,
      amount: Math.floor(p.amount),
      secret: p.secret,
      C: p.C,
      ...(p.dleq ? { dleq: p.dleq } : {}),
      ...(p.witness !== undefined ? { witness: p.witness } : {}),
    })
  }
  return out
}

export function sumStoredProofs(proofs: readonly StoredCashuProof[] | undefined): number {
  if (!proofs || proofs.length === 0) return 0
  let total = 0
  for (const p of proofs) {
    if (Number.isFinite(p.amount) && p.amount > 0) {
      total += Math.floor(p.amount)
    }
  }
  return total
}

/* --------------------------------------------------------------------------
   Storage Persistence (`agnostr:v2:cashu_wallet`)
   -------------------------------------------------------------------------- */

export function buildDefaultMintsList(): CashuMintAccount[] {
  const now = Date.now()
  return DEFAULT_CASHU_MINTS.map((entry) => ({
    url: entry.url,
    label: entry.name,
    description: entry.description,
    addedAt: now,
    info: {
      url: entry.url,
      name: entry.name,
      description: entry.description,
      version: entry.version,
      nuts: [...entry.verifiedNuts],
      feePpk: entry.feePpk,
      activeSatKeysetId: null,
      online: true,
      lastCheckedAt: 0,
    },
  }))
}

export function createEmptyWalletState(): PersistedCashuWalletState {
  return {
    version: 1,
    initialized: false,
    keysetCounters: {},
    activeMintUrl: DEFAULT_ACTIVE_MINT_URL,
    mints: buildDefaultMintsList(),
    proofsByMint: {},
    history: [],
    sentTokens: [],
  }
}

function sanitizeCounters(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      out[k] = Math.floor(v)
    }
  }
  return out
}

export function loadPersistedCashuWallet(): PersistedCashuWalletState {
  const fallback = createEmptyWalletState()
  try {
    const raw = localStorage.getItem(CASHU_WALLET_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<PersistedCashuWalletState>
    if (!parsed || typeof parsed !== 'object') return fallback

    const mintMap = new Map<string, CashuMintAccount>()
    if (Array.isArray(parsed.mints)) {
      for (const m of parsed.mints) {
        if (!m || typeof m.url !== 'string') continue
        const norm = normalizeMintUrl(m.url)
        if (!norm || mintMap.has(norm)) continue
        const catalog = findCatalogMint(norm)
        mintMap.set(norm, {
          url: norm,
          label: (m.label || catalog?.name || formatMintHost(norm)).trim(),
          description: m.description || catalog?.description,
          addedAt: typeof m.addedAt === 'number' ? m.addedAt : Date.now(),
          info: m.info,
        })
      }
    }

    if (mintMap.size === 0) {
      for (const def of fallback.mints) {
        mintMap.set(def.url, def)
      }
    }

    const proofsByMint: Record<string, StoredCashuProof[]> = {}
    if (parsed.proofsByMint && typeof parsed.proofsByMint === 'object') {
      for (const [url, list] of Object.entries(parsed.proofsByMint)) {
        const norm = normalizeMintUrl(url)
        if (!norm || !Array.isArray(list)) continue
        const cleaned = deduplicateProofs(list)
        if (cleaned.length > 0) {
          proofsByMint[norm] = cleaned
          if (!mintMap.has(norm)) {
            const catalog = findCatalogMint(norm)
            mintMap.set(norm, {
              url: norm,
              label: catalog?.name || formatMintHost(norm),
              description: catalog?.description,
              addedAt: Date.now(),
            })
          }
        }
      }
    }

    const normalizedActive =
      typeof parsed.activeMintUrl === 'string' ? normalizeMintUrl(parsed.activeMintUrl) : null
    const activeMintUrl =
      normalizedActive && mintMap.has(normalizedActive)
        ? normalizedActive
        : Array.from(mintMap.keys())[0] ?? DEFAULT_ACTIVE_MINT_URL

    const history = Array.isArray(parsed.history)
      ? parsed.history
          .filter((tx): tx is WalletTransaction => Boolean(tx && typeof tx === 'object' && tx.id))
          .slice(0, MAX_HISTORY_ITEMS)
      : []

    const sentTokens = Array.isArray(parsed.sentTokens)
      ? parsed.sentTokens
          .filter((st): st is CashuSentTokenRecord => Boolean(st && typeof st === 'object' && st.id))
          .slice(0, MAX_SENT_TOKENS)
      : []

    const mnemonic =
      typeof parsed.mnemonic === 'string' && isValidBip39Mnemonic(parsed.mnemonic)
        ? normalizeMnemonicPhrase(parsed.mnemonic)
        : undefined
    const privateKeyHex =
      typeof parsed.privateKeyHex === 'string'
        ? parseWalletPrivateKeyHex(parsed.privateKeyHex) ?? undefined
        : mnemonic
          ? derivePrivateKeyHexFromSeed(mnemonicToSeedSync(mnemonic))
          : undefined

    const hasExistingActivity =
      Object.values(proofsByMint).some((list) => list.length > 0) ||
      history.length > 0 ||
      sentTokens.length > 0

    // Never lock out existing users who already have saved proofs or history
    const initialized =
      typeof parsed.initialized === 'boolean'
        ? parsed.initialized || hasExistingActivity
        : hasExistingActivity || Boolean(mnemonic || privateKeyHex)

    // Seamlessly attach deterministic keys for upgraded legacy users with existing proofs/history
    let finalMnemonic = mnemonic
    let finalPrivKey = privateKeyHex
    if (initialized && !finalMnemonic && !finalPrivKey) {
      const fresh = generateCashuWalletKeys()
      finalMnemonic = fresh.mnemonic
      finalPrivKey = fresh.privateKeyHex
    }

    const state: PersistedCashuWalletState = {
      version: 1,
      initialized,
      ...(finalMnemonic ? { mnemonic: finalMnemonic } : {}),
      ...(finalPrivKey ? { privateKeyHex: finalPrivKey } : {}),
      keysetCounters: sanitizeCounters(parsed.keysetCounters),
      activeMintUrl,
      mints: Array.from(mintMap.values()),
      proofsByMint,
      history,
      sentTokens,
    }

    return state
  } catch {
    return fallback
  }
}

export function savePersistedCashuWallet(state: PersistedCashuWalletState): void {
  try {
    const trimmed: PersistedCashuWalletState = {
      version: 1,
      initialized: state.initialized,
      ...(state.mnemonic ? { mnemonic: state.mnemonic } : {}),
      ...(state.privateKeyHex ? { privateKeyHex: state.privateKeyHex } : {}),
      keysetCounters: state.keysetCounters,
      activeMintUrl: state.activeMintUrl,
      mints: state.mints,
      proofsByMint: state.proofsByMint,
      history: state.history.slice(0, MAX_HISTORY_ITEMS),
      sentTokens: state.sentTokens.slice(0, MAX_SENT_TOKENS),
    }
    localStorage.setItem(CASHU_WALLET_STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    // Ignore storage quota errors
  }
}

/* --------------------------------------------------------------------------
   Multi-Mint `@cashu/cashu-ts` v4 Session Manager + NUT-13 CounterSource
   -------------------------------------------------------------------------- */

const walletCache = new Map<string, Promise<Wallet>>()
const activeMeltQuoteCache = new Map<string, MeltQuoteBolt11Response>()

let activeSeedBytes: Uint8Array | undefined = undefined
let activeCountersMap: Record<string, number> = {}
let countersChangedListener: ((snapshot: Record<string, number>) => void) | null = null

const persistentCounterSource: CounterSource = {
  async reserve(keysetId: string, n: number): Promise<CounterRange> {
    const start = activeCountersMap[keysetId] ?? 0
    if (n > 0) {
      activeCountersMap = { ...activeCountersMap, [keysetId]: start + n }
      countersChangedListener?.({ ...activeCountersMap })
    }
    return { start, count: n }
  },
  async reserveAt(keysetId: string, start: number, count: number): Promise<CounterRange> {
    const cur = activeCountersMap[keysetId] ?? 0
    if (start < cur) {
      throw new Error(`Counter ${start} already issued for keyset ${keysetId}.`)
    }
    if (count > 0 || start > cur) {
      activeCountersMap = { ...activeCountersMap, [keysetId]: start + count }
      countersChangedListener?.({ ...activeCountersMap })
    }
    return { start, count }
  },
  async advanceToAtLeast(keysetId: string, minNext: number): Promise<void> {
    const cur = activeCountersMap[keysetId] ?? 0
    if (minNext > cur) {
      activeCountersMap = { ...activeCountersMap, [keysetId]: minNext }
      countersChangedListener?.({ ...activeCountersMap })
    }
  },
  async snapshot(): Promise<Record<string, number>> {
    return { ...activeCountersMap }
  },
}

/**
 * Configures the active NUT-13 BIP-39 seed & persistent counter store used by all
 * `@cashu/cashu-ts` Wallet instances. Clears cached Wallet instances whenever the seed changes.
 */
export function configureCashuWalletRuntime(opts: {
  mnemonic?: string | null
  privateKeyHex?: string | null
  counters: Record<string, number>
  onCountersChanged?: (snapshot: Record<string, number>) => void
}): void {
  const nextSeed = deriveNut13SeedBytes({
    mnemonic: opts.mnemonic,
    privateKeyHex: opts.privateKeyHex,
  })
  const prevHex = activeSeedBytes ? bytesToHex(activeSeedBytes) : ''
  const nextHex = nextSeed ? bytesToHex(nextSeed) : ''

  activeCountersMap = { ...opts.counters }
  countersChangedListener = opts.onCountersChanged ?? null

  if (prevHex !== nextHex) {
    activeSeedBytes = nextSeed
    walletCache.clear()
    activeMeltQuoteCache.clear()
  }
}

export function clearCashuWalletInstanceCache(): void {
  walletCache.clear()
  activeMeltQuoteCache.clear()
  activeSeedBytes = undefined
  activeCountersMap = {}
}

export async function getLoadedCashuWallet(
  mintUrl: string,
  forceRefresh = false
): Promise<Wallet> {
  const normalized = normalizeMintUrl(mintUrl)
  if (!normalized) {
    throw new Error('Invalid Cashu mint URL.')
  }

  if (!forceRefresh) {
    const cached = walletCache.get(normalized)
    if (cached) return await cached
  }

  const loader = (async () => {
    const mint = new Mint(normalized)
    const wallet = new Wallet(mint, {
      unit: 'sat',
      ...(activeSeedBytes
        ? {
            bip39seed: activeSeedBytes,
            secretsPolicy: 'auto' as const,
            counterSource: persistentCounterSource,
          }
        : {}),
    })
    await wallet.loadMint(forceRefresh)
    return wallet
  })()

  walletCache.set(normalized, loader)
  try {
    return await loader
  } catch (err) {
    walletCache.delete(normalized)
    throw err
  }
}

function mapMintQuoteState(state: MintQuoteState): CashuMintQuoteState {
  switch (state) {
    case MintQuoteState.PAID:
      return 'PAID'
    case MintQuoteState.ISSUED:
      return 'ISSUED'
    default:
      return 'UNPAID'
  }
}

function mapMeltQuoteState(state: MeltQuoteState): 'UNPAID' | 'PENDING' | 'PAID' {
  switch (state) {
    case MeltQuoteState.PAID:
      return 'PAID'
    case MeltQuoteState.PENDING:
      return 'PENDING'
    default:
      return 'UNPAID'
  }
}

export function normalizeMintError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) {
    const msg = err.message.trim()
    if (/already spent|Token already spent/i.test(msg)) {
      return 'This Cashu ecash token has already been claimed or spent.'
    }
    if (/not enough|insufficient/i.test(msg)) {
      return 'Insufficient balance on the selected mint (including mint/Lightning fees).'
    }
    return msg
  }
  return fallback
}

/* --------------------------------------------------------------------------
   Core Protocol Operations (NUT-04, NUT-05, NUT-07, NUT-13, Swap Send/Receive)
   -------------------------------------------------------------------------- */

export async function inspectCashuMint(mintUrl: string): Promise<CashuMintInfoSummary> {
  const summary = await probeCashuMint(mintUrl)
  if (summary.online) {
    void getLoadedCashuWallet(summary.url, true).catch(() => {})
  }
  return summary
}

/**
 * NUT-13 deterministic wallet recovery scan across all `sat` keysets on `mintUrl`.
 * Verifies recovered proofs against NUT-07 `checkProofsStates` so only `UNSPENT`
 * proofs are credited, and advances persisted counters cleanly past the last signature.
 */
export async function restoreCashuProofsFromMint(mintUrl: string): Promise<{
  unspentProofs: StoredCashuProof[]
  restoredSats: number
  counters: Record<string, number>
}> {
  if (!activeSeedBytes) {
    throw new Error('No recovery seed or wallet private key configured.')
  }
  const normalized = normalizeMintUrl(mintUrl)
  if (!normalized) throw new Error('Invalid mint URL.')

  const wallet = await getLoadedCashuWallet(normalized, true)
  const keysets = wallet.keyChain.getKeysets().filter((k) => k.unit === 'sat')

  const recoveredRaw: Proof[] = []
  for (const ks of keysets) {
    try {
      const res = await wallet.batchRestore(3, 25, 0, ks.id)
      if (typeof res.lastCounterWithSignature === 'number') {
        await persistentCounterSource.advanceToAtLeast(ks.id, res.lastCounterWithSignature + 1)
      }
      if (res.proofs.length > 0) {
        recoveredRaw.push(...res.proofs)
      }
    } catch {
      // Some inactive/legacy keysets may not support restore — continue scanning others
    }
  }

  if (recoveredRaw.length === 0) {
    return {
      unspentProofs: [],
      restoredSats: 0,
      counters: { ...activeCountersMap },
    }
  }

  // Filter strictly to UNSPENT proofs via NUT-07
  const states = await wallet.checkProofsStates(recoveredRaw)
  const unspent: StoredCashuProof[] = []
  for (let i = 0; i < recoveredRaw.length; i++) {
    if (states[i]?.state === CheckStateEnum.UNSPENT) {
      unspent.push(toStoredProof(recoveredRaw[i]))
    }
  }

  const deduped = deduplicateProofs(unspent)
  return {
    unspentProofs: deduped,
    restoredSats: sumStoredProofs(deduped),
    counters: { ...activeCountersMap },
  }
}

/**
 * NUT-04: Creates a Lightning invoice mint quote on `mintUrl`.
 */
export async function createCashuMintQuote(
  mintUrl: string,
  amountSats: number,
  description?: string
): Promise<CashuMintQuoteRecord> {
  const cleanSats = Math.floor(amountSats)
  if (!Number.isFinite(cleanSats) || cleanSats <= 0) {
    throw new Error('Enter a valid positive satoshi amount.')
  }
  const normalized = normalizeMintUrl(mintUrl)
  if (!normalized) throw new Error('Invalid mint URL.')

  const wallet = await getLoadedCashuWallet(normalized)
  const quote: MintQuoteBolt11Response = await wallet.createMintQuoteBolt11(
    cleanSats,
    description?.trim() || undefined
  )

  return {
    quoteId: quote.quote,
    mintUrl: normalized,
    amountSats: amountToNumberSafe(quote.amount) || cleanSats,
    invoice: quote.request,
    state: mapMintQuoteState(quote.state),
    expiry: quote.expiry ?? null,
    createdAt: Date.now(),
    description: description?.trim() || undefined,
  }
}

/**
 * NUT-04: Checks mint quote status and mints fresh proofs once paid.
 */
export async function checkAndMintCashuQuote(
  quoteRecord: CashuMintQuoteRecord
): Promise<{
  state: CashuMintQuoteState
  proofs: StoredCashuProof[]
  claimedSats: number
}> {
  const wallet = await getLoadedCashuWallet(quoteRecord.mintUrl)
  const checked = await wallet.checkMintQuoteBolt11(quoteRecord.quoteId)
  const state = mapMintQuoteState(checked.state)

  if (state === 'ISSUED') {
    return { state: 'ISSUED', proofs: [], claimedSats: 0 }
  }
  if (state !== 'PAID') {
    const nowSec = Math.floor(Date.now() / 1000)
    if (quoteRecord.expiry && nowSec > quoteRecord.expiry) {
      return { state: 'EXPIRED', proofs: [], claimedSats: 0 }
    }
    return { state, proofs: [], claimedSats: 0 }
  }

  const minted = await wallet.mintProofsBolt11(quoteRecord.amountSats, checked)
  const stored = deduplicateProofs(minted.map(toStoredProof))
  return {
    state: 'ISSUED',
    proofs: stored,
    claimedSats: sumStoredProofs(stored),
  }
}

/**
 * Claims a `cashuA...` or `cashuB...` token onto its issuing mint, returning
 * fresh unspent proofs owned exclusively by this wallet.
 */
export async function claimCashuTokenProofs(rawToken: string): Promise<{
  mintUrl: string
  proofs: StoredCashuProof[]
  amountSats: number
  memo?: string
}> {
  const preview = decodeCashuTokenPreview(rawToken)
  if (!preview) {
    throw new Error('Invalid Cashu token. Paste a valid cashuA… or cashuB… token.')
  }
  if (preview.unit && preview.unit !== 'sat') {
    throw new Error(`Unsupported Cashu token unit "${preview.unit}". Only satoshi (sat) tokens are supported.`)
  }

  const wallet = await getLoadedCashuWallet(preview.mintUrl)
  const received = await wallet.receive(preview.raw)
  const stored = deduplicateProofs(received.map(toStoredProof))
  const amountSats = sumStoredProofs(stored)
  if (stored.length === 0 || amountSats <= 0) {
    throw new Error('Mint returned no spendable proofs for this token.')
  }

  return {
    mintUrl: preview.mintUrl,
    proofs: stored,
    amountSats,
    memo: preview.memo,
  }
}

/**
 * Splits proofs on `mintUrl` to produce an encoded `cashuB...` token and
 * atomic `keep` change proofs.
 */
export async function sendCashuTokenProofs(params: {
  mintUrl: string
  existingProofs: StoredCashuProof[]
  amountSats: number
  memo?: string
}): Promise<{
  token: string
  keepProofs: StoredCashuProof[]
  sendProofs: StoredCashuProof[]
  sentSats: number
  feeSats: number
}> {
  const cleanSats = Math.floor(params.amountSats)
  if (!Number.isFinite(cleanSats) || cleanSats <= 0) {
    throw new Error('Enter a valid positive satoshi amount.')
  }
  const available = sumStoredProofs(params.existingProofs)
  if (available < cleanSats) {
    throw new Error(`Insufficient balance (${available} sats available on this mint).`)
  }

  const normalized = normalizeMintUrl(params.mintUrl)
  if (!normalized) throw new Error('Invalid mint URL.')

  const wallet = await getLoadedCashuWallet(normalized)
  const proofInputs = params.existingProofs.map(toCashuProof)
  const { keep, send } = await wallet.send(cleanSats, proofInputs)

  const keepProofs = deduplicateProofs(keep.map(toStoredProof))
  const sendProofs = deduplicateProofs(send.map(toStoredProof))
  const sentSats = sumStoredProofs(sendProofs)
  const keepSats = sumStoredProofs(keepProofs)
  const feeSats = Math.max(0, available - sentSats - keepSats)

  const token = getEncodedToken({
    mint: normalized,
    proofs: send,
    unit: 'sat',
    memo: params.memo?.trim() || undefined,
  })

  return {
    token,
    keepProofs,
    sendProofs,
    sentSats,
    feeSats,
  }
}

/**
 * NUT-05: Creates a Lightning melt quote for a BOLT-11 invoice on `mintUrl`.
 */
export async function createCashuMeltQuote(params: {
  mintUrl: string
  invoice: string
  recipient?: string
  memo?: string
}): Promise<CashuMeltQuotePreview> {
  const normalized = normalizeMintUrl(params.mintUrl)
  if (!normalized) throw new Error('Invalid mint URL.')

  const wallet = await getLoadedCashuWallet(normalized)
  const quote = await wallet.createMeltQuoteBolt11(params.invoice)
  activeMeltQuoteCache.set(`${normalized}:${quote.quote}`, quote)

  const amountSats = amountToNumberSafe(quote.amount)
  const feeReserveSats = amountToNumberSafe(quote.fee_reserve)

  return {
    quoteId: quote.quote,
    mintUrl: normalized,
    invoice: quote.request || params.invoice,
    amountSats,
    feeReserveSats,
    totalRequiredSats: amountSats + feeReserveSats,
    expiry: quote.expiry,
    state: mapMeltQuoteState(quote.state),
    recipient: params.recipient,
    memo: params.memo,
  }
}

/**
 * NUT-05: Executes a melt quote atomically with pre-melt keep-proof commit & NUT-07 recovery.
 */
export async function executeCashuMeltQuote(params: {
  preview: CashuMeltQuotePreview
  existingProofs: StoredCashuProof[]
  onCommitKeep: (keepProofs: StoredCashuProof[]) => void
}): Promise<{
  paid: boolean
  changeProofs: StoredCashuProof[]
  recoveredProofs: StoredCashuProof[]
  feePaidSats: number
  preimage: string | null
}> {
  const { preview, existingProofs, onCommitKeep } = params
  const available = sumStoredProofs(existingProofs)
  if (available < preview.totalRequiredSats) {
    throw new Error(
      `Need at least ${preview.totalRequiredSats.toLocaleString()} sats (${preview.amountSats.toLocaleString()} + ${preview.feeReserveSats.toLocaleString()} fee reserve), but only ${available.toLocaleString()} sats available on this mint.`
    )
  }

  const wallet = await getLoadedCashuWallet(preview.mintUrl)
  const cachedQuote =
    activeMeltQuoteCache.get(`${preview.mintUrl}:${preview.quoteId}`) ??
    (await wallet.checkMeltQuoteBolt11(preview.quoteId))

  const targetTotal =
    amountToNumberSafe(cachedQuote.amount) + amountToNumberSafe(cachedQuote.fee_reserve)
  const proofInputs = existingProofs.map(toCashuProof)
  const { keep, send } = await wallet.send(targetTotal, proofInputs, { includeFees: true })

  const keepStored = deduplicateProofs(keep.map(toStoredProof))
  const sendStored = deduplicateProofs(send.map(toStoredProof))

  onCommitKeep(keepStored)

  try {
    const meltRes = await wallet.meltProofsBolt11(cachedQuote, send)
    activeMeltQuoteCache.delete(`${preview.mintUrl}:${preview.quoteId}`)

    const changeProofs = deduplicateProofs((meltRes.change ?? []).map(toStoredProof))
    const keepSats = sumStoredProofs(keepStored)
    const changeSats = sumStoredProofs(changeProofs)
    const totalSpent = Math.max(0, available - keepSats - changeSats)
    const feePaidSats = Math.max(0, totalSpent - preview.amountSats)

    return {
      paid: meltRes.quote.state === MeltQuoteState.PAID,
      changeProofs,
      recoveredProofs: [],
      feePaidSats,
      preimage: meltRes.quote.payment_preimage ?? null,
    }
  } catch (err) {
    try {
      const states = await wallet.checkProofsStates(send)
      const recovered: StoredCashuProof[] = []
      for (let i = 0; i < sendStored.length; i++) {
        if (states[i]?.state === CheckStateEnum.UNSPENT) {
          recovered.push(sendStored[i])
        }
      }
      if (recovered.length > 0) {
        onCommitKeep(deduplicateProofs([...keepStored, ...recovered]))
      }
    } catch {
      onCommitKeep(deduplicateProofs([...keepStored, ...sendStored]))
    }
    throw err
  }
}

/**
 * NUT-07: Verifies proof states with the mint and prunes any `SPENT` proofs.
 */
export async function verifyCashuProofsOnMint(
  mintUrl: string,
  proofs: StoredCashuProof[]
): Promise<{
  unspentProofs: StoredCashuProof[]
  checked: number
  spentRemoved: number
  pendingCount: number
}> {
  if (proofs.length === 0) {
    return { unspentProofs: [], checked: 0, spentRemoved: 0, pendingCount: 0 }
  }
  const wallet = await getLoadedCashuWallet(mintUrl)
  const states = await wallet.checkProofsStates(proofs.map(toCashuProof))

  const unspentProofs: StoredCashuProof[] = []
  let spentRemoved = 0
  let pendingCount = 0

  for (let i = 0; i < proofs.length; i++) {
    const st = states[i]?.state
    if (st === CheckStateEnum.SPENT) {
      spentRemoved += 1
    } else {
      if (st === CheckStateEnum.PENDING) {
        pendingCount += 1
      }
      unspentProofs.push(proofs[i])
    }
  }

  return {
    unspentProofs,
    checked: proofs.length,
    spentRemoved,
    pendingCount,
  }
}

/**
 * NUT-07: Checks whether a previously sent Cashu token has been claimed by its recipient.
 */
export async function checkCashuSentTokenClaimed(
  mintUrl: string,
  proofSecrets: string[]
): Promise<boolean> {
  if (proofSecrets.length === 0) return false
  const wallet = await getLoadedCashuWallet(mintUrl)
  const states = await wallet.checkProofsStates(proofSecrets.map((secret) => ({ secret })))
  return states.length > 0 && states.every((s) => s.state === CheckStateEnum.SPENT)
}

/**
 * Validates and parses an imported JSON backup file (`WalletBackupPayload`).
 * Accepts both full wallet backups (with `proofsByMint`) and key-only exports (`mnemonic` / `privateKeyHex`).
 */
export function parseWalletBackupJson(rawJson: string): WalletBackupPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    throw new Error('Backup file is not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Backup JSON must be an object.')
  }
  const obj = parsed as Partial<WalletBackupPayload>

  const mnemonic =
    typeof obj.mnemonic === 'string' && isValidBip39Mnemonic(obj.mnemonic)
      ? normalizeMnemonicPhrase(obj.mnemonic)
      : undefined
  const privateKeyHex =
    typeof obj.privateKeyHex === 'string'
      ? parseWalletPrivateKeyHex(obj.privateKeyHex) ?? undefined
      : mnemonic
        ? derivePrivateKeyHexFromSeed(mnemonicToSeedSync(mnemonic))
        : undefined

  const hasProofsObj = Boolean(obj.proofsByMint && typeof obj.proofsByMint === 'object')
  if (!hasProofsObj && !mnemonic && !privateKeyHex) {
    throw new Error('Backup JSON must contain proofs, a recovery phrase, or a private key.')
  }

  const normalizedProofs: Record<string, StoredCashuProof[]> = {}
  if (hasProofsObj && obj.proofsByMint) {
    for (const [url, list] of Object.entries(obj.proofsByMint)) {
      const norm = normalizeMintUrl(url)
      if (!norm || !Array.isArray(list)) continue
      const cleaned = deduplicateProofs(list)
      if (cleaned.length > 0) {
        normalizedProofs[norm] = cleaned
      }
    }
  }

  const mints: CashuMintAccount[] = []
  if (Array.isArray(obj.mints)) {
    for (const m of obj.mints) {
      if (!m || typeof m.url !== 'string') continue
      const norm = normalizeMintUrl(m.url)
      if (!norm) continue
      mints.push({
        url: norm,
        label: (m.label || formatMintHost(norm)).trim(),
        description: m.description,
        addedAt: typeof m.addedAt === 'number' ? m.addedAt : Date.now(),
        info: m.info,
      })
    }
  }

  return {
    version: 1,
    exportedAt: typeof obj.exportedAt === 'number' ? obj.exportedAt : Date.now(),
    activeMintUrl:
      (typeof obj.activeMintUrl === 'string' && normalizeMintUrl(obj.activeMintUrl)) ||
      DEFAULT_ACTIVE_MINT_URL,
    ...(mnemonic ? { mnemonic } : {}),
    ...(privateKeyHex ? { privateKeyHex } : {}),
    keysetCounters: sanitizeCounters(obj.keysetCounters),
    mints,
    proofsByMint: normalizedProofs,
    history: Array.isArray(obj.history) ? obj.history : [],
    sentTokens: Array.isArray(obj.sentTokens) ? obj.sentTokens : [],
    boltzSwaps: Array.isArray(obj.boltzSwaps) ? obj.boltzSwaps : [],
    boltzApiUrl: typeof obj.boltzApiUrl === 'string' ? obj.boltzApiUrl : undefined,
  }
}
