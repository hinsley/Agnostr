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
import type { WalletSyncExportInfo } from '../types/deviceSync.ts'
import type {
  BoltzSwapRecord,
  CashuMeltQuotePreview,
  CashuMintAccount,
  CashuMintInfoSummary,
  CashuMintQuoteRecord,
  CashuMintQuoteState,
  CashuSentTokenRecord,
  CashuSentTokenStatus,
  CashuTokenPreview,
  StoredCashuProof,
  WalletBackupPayload,
  WalletDraftKeys,
  WalletImportMode,
  WalletSyncPayload,
  WalletTransaction,
} from '../types/wallet.ts'
import { normalizeBoltzApiUrl } from './boltzSwap.ts'
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
import { toCompressedP2pkPubkey } from './nutzaps.ts'

export const CASHU_WALLET_STORAGE_KEY = 'agnostr:v2:cashu_wallet'
export const MAX_SPENT_PROOF_SECRETS = 2000

const MAX_HISTORY_ITEMS = 250
const MAX_SENT_TOKENS = 120
const CASHU_TOKEN_GLOBAL_REGEX = /\b(cashu[AB][A-Za-z0-9_-]{20,})\b/g
const CASHU_TOKEN_SINGLE_REGEX = /^(?:cashu:)?(cashu[AB][A-Za-z0-9_-]{20,})$/i

const utf8Encoder = new TextEncoder()

export interface PersistedCashuWalletState {
  version: 1
  initialized: boolean
  updatedAt?: number
  mnemonic?: string
  privateKeyHex?: string
  keysetCounters: Record<string, number>
  activeMintUrl: string
  mints: CashuMintAccount[]
  proofsByMint: Record<string, StoredCashuProof[]>
  spentProofSecrets?: string[]
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

/**
 * Deterministic 16-char SHA-256 hex fingerprint identifying an Agwallet's root key material
 * across linked devices (never exposes raw secrets). Returns `null` if neither key nor phrase exists.
 */
export function computeWalletFingerprint(
  mnemonic?: string | null,
  privateKeyHex?: string | null
): string | null {
  const normPriv =
    typeof privateKeyHex === 'string' && privateKeyHex.trim()
      ? parseWalletPrivateKeyHex(privateKeyHex)
      : null
  if (normPriv) {
    return bytesToHex(sha256(utf8Encoder.encode(`agnostr-wallet-fp:v1:${normPriv}`))).slice(0, 16)
  }
  if (typeof mnemonic === 'string' && mnemonic.trim()) {
    const normMnemonic = normalizeMnemonicPhrase(mnemonic)
    if (isValidBip39Mnemonic(normMnemonic)) {
      const derived = derivePrivateKeyHexFromSeed(mnemonicToSeedSync(normMnemonic))
      return bytesToHex(sha256(utf8Encoder.encode(`agnostr-wallet-fp:v1:${derived}`))).slice(0, 16)
    }
    return bytesToHex(sha256(utf8Encoder.encode(`agnostr-wallet-fp:v1:mn:${normMnemonic}`))).slice(
      0,
      16
    )
  }
  return null
}

/**
 * Deduplicates and bounds spent-proof tombstones to the most recent `MAX_SPENT_PROOF_SECRETS` entries.
 */
export function sanitizeSpentProofSecrets(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const deduped: string[] = []
  for (let i = raw.length - 1; i >= 0; i--) {
    const item = raw[i]
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    deduped.push(trimmed)
    if (deduped.length >= MAX_SPENT_PROOF_SECRETS) break
  }
  deduped.reverse()
  return deduped
}

/**
 * Derives the 32-byte x-only hex P2PK public key (64 chars) from a wallet's secp256k1 private key.
 * Used as the `pubkey` tag in NIP-61 `kind: 10019` Nutzap info events.
 */
export function deriveWalletP2pkPubkeyHex(privateKeyHex: string | null | undefined): string | null {
  if (!privateKeyHex) return null
  const cleanHex = parseWalletPrivateKeyHex(privateKeyHex)
  if (!cleanHex) return null
  const bytes = hexToBytes(cleanHex)
  if (!bytes || bytes.length !== 32) return null
  try {
    return getPublicKey(bytes).toLowerCase()
  } catch {
    return null
  }
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
    spentProofSecrets: [],
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

    const spentProofSecrets = sanitizeSpentProofSecrets(parsed.spentProofSecrets)
    let updatedAt: number | undefined
    if (typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) && parsed.updatedAt > 0) {
      updatedAt = Math.floor(parsed.updatedAt)
    } else if (initialized) {
      let maxTs = 0
      for (const tx of history) {
        if (typeof tx.createdAt === 'number' && tx.createdAt > maxTs) maxTs = tx.createdAt
      }
      for (const st of sentTokens) {
        if (typeof st.createdAt === 'number' && st.createdAt > maxTs) maxTs = st.createdAt
      }
      updatedAt = maxTs > 0 ? Math.floor(maxTs) : 1
    }

    const state: PersistedCashuWalletState = {
      version: 1,
      initialized,
      ...(updatedAt ? { updatedAt } : {}),
      ...(finalMnemonic ? { mnemonic: finalMnemonic } : {}),
      ...(finalPrivKey ? { privateKeyHex: finalPrivKey } : {}),
      keysetCounters: sanitizeCounters(parsed.keysetCounters),
      activeMintUrl,
      mints: Array.from(mintMap.values()),
      proofsByMint,
      spentProofSecrets,
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
    const cleanUpdatedAt =
      typeof state.updatedAt === 'number' && Number.isFinite(state.updatedAt) && state.updatedAt > 0
        ? Math.floor(state.updatedAt)
        : undefined
    const trimmed: PersistedCashuWalletState = {
      version: 1,
      initialized: state.initialized,
      ...(cleanUpdatedAt ? { updatedAt: cleanUpdatedAt } : {}),
      ...(state.mnemonic ? { mnemonic: state.mnemonic } : {}),
      ...(state.privateKeyHex ? { privateKeyHex: state.privateKeyHex } : {}),
      keysetCounters: sanitizeCounters(state.keysetCounters),
      activeMintUrl: state.activeMintUrl,
      mints: state.mints,
      proofsByMint: state.proofsByMint,
      spentProofSecrets: sanitizeSpentProofSecrets(state.spentProofSecrets),
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
 * NUT-11 / NIP-61: Splits proofs on `mintUrl` into P2PK-locked proofs addressed to
 * `recipientP2pkPubkeyHex` (compressed `02` + 32-byte x-only pubkey), with receiver swap
 * fees included and NUT-12 `dleq` proofs preserved for Nutzap verification.
 */
export async function sendP2pkCashuProofs(
  mintUrl: string,
  amountSats: number,
  storedProofs: StoredCashuProof[],
  recipientP2pkPubkeyHex: string
): Promise<{
  mintUrl: string
  keepProofs: StoredCashuProof[]
  sendProofs: StoredCashuProof[]
  sentSats: number
  feeSats: number
}> {
  const cleanSats = Math.floor(amountSats)
  if (!Number.isFinite(cleanSats) || cleanSats <= 0) {
    throw new Error('Enter a valid positive satoshi amount.')
  }
  const available = sumStoredProofs(storedProofs)
  if (available < cleanSats) {
    throw new Error(`Insufficient balance (${available} sats available on this mint).`)
  }
  const normalized = normalizeMintUrl(mintUrl)
  if (!normalized) throw new Error('Invalid mint URL.')

  const compressedPubkey = toCompressedP2pkPubkey(recipientP2pkPubkeyHex)
  if (!compressedPubkey) {
    throw new Error('Invalid recipient P2PK public key for Nutzap.')
  }

  const wallet = await getLoadedCashuWallet(normalized)
  const proofInputs = storedProofs.map(toCashuProof)
  const { keep, send } = await wallet.ops
    .send(cleanSats, proofInputs)
    .asLocked({ pubkey: compressedPubkey })
    .includeFees(true)
    .run()

  const keepProofs = deduplicateProofs(keep.map(toStoredProof))
  const sendProofs = deduplicateProofs(send.map(toStoredProof))
  const sentSats = sumStoredProofs(sendProofs)
  const keepSats = sumStoredProofs(keepProofs)
  const feeSats = Math.max(0, available - sentSats - keepSats)

  if (sendProofs.length === 0 || sentSats <= 0) {
    throw new Error('Mint returned no P2PK-locked proofs for this Nutzap.')
  }

  return {
    mintUrl: normalized,
    keepProofs,
    sendProofs,
    sentSats,
    feeSats,
  }
}

/**
 * NUT-11 / NIP-61: Redeems P2PK-locked Cashu proofs on `mintUrl` using one or more candidate
 * private keys, swapping them into fresh unlocked proofs owned by this wallet (using NUT-13
 * deterministic outputs when a recovery seed is configured).
 */
export async function claimP2pkCashuProofs(
  mintUrl: string,
  lockedProofs: StoredCashuProof[],
  candidatePrivkeysHex: string[]
): Promise<StoredCashuProof[]> {
  const normalized = normalizeMintUrl(mintUrl)
  if (!normalized) throw new Error('Invalid mint URL.')
  if (!Array.isArray(lockedProofs) || lockedProofs.length === 0) {
    throw new Error('No Cashu proofs provided to claim.')
  }

  const validKeys = Array.from(
    new Set(
      candidatePrivkeysHex
        .map((k) => parseWalletPrivateKeyHex(k))
        .filter((k): k is string => k !== null)
    )
  )

  const wallet = await getLoadedCashuWallet(normalized)
  let builder = wallet.ops.receive({
    mint: normalized,
    proofs: lockedProofs.map(toCashuProof),
    unit: 'sat',
  })

  if (activeSeedBytes) {
    builder = builder.asDeterministic()
  }
  if (validKeys.length > 0) {
    builder = builder.privkey(validKeys)
  }

  const received = await builder.run()
  const stored = deduplicateProofs(received.map(toStoredProof))
  if (stored.length === 0 || sumStoredProofs(stored) <= 0) {
    throw new Error('Mint returned no spendable proofs when claiming Nutzap.')
  }
  return stored
}

/**
 * NUT-04 / NUT-20: Checks an external BOLT-11 mint quote (e.g. from `npub.cash` v2) and mints
 * proofs when `PAID`. Handles `ISSUED` cleanly without throwing, and signs NUT-20 locked quotes
 * automatically when `privkeyHex` is provided.
 */
export async function claimExternalMintQuoteProofs(
  mintUrl: string,
  quoteId: string,
  amountSats: number,
  privkeyHex?: string
): Promise<{
  state: CashuMintQuoteState
  proofs: StoredCashuProof[]
  claimedSats: number
  mintUrl: string
}> {
  const normalized = normalizeMintUrl(mintUrl)
  if (!normalized) throw new Error('Invalid mint URL.')
  const cleanQuoteId = quoteId.trim()
  if (!cleanQuoteId) throw new Error('Missing mint quote ID.')

  const wallet = await getLoadedCashuWallet(normalized)
  const checked = await wallet.checkMintQuoteBolt11(cleanQuoteId)
  const state = mapMintQuoteState(checked.state)

  if (state === 'ISSUED') {
    return { state: 'ISSUED', proofs: [], claimedSats: 0, mintUrl: normalized }
  }
  if (state !== 'PAID') {
    const nowSec = Math.floor(Date.now() / 1000)
    if (checked.expiry && nowSec > checked.expiry) {
      return { state: 'EXPIRED', proofs: [], claimedSats: 0, mintUrl: normalized }
    }
    return { state, proofs: [], claimedSats: 0, mintUrl: normalized }
  }

  const mintAmount = amountToNumberSafe(checked.amount) || Math.floor(amountSats)
  if (!Number.isFinite(mintAmount) || mintAmount <= 0) {
    throw new Error('Mint quote amount is invalid.')
  }

  const quotePubkey =
    'pubkey' in checked && typeof checked.pubkey === 'string' && checked.pubkey.trim()
      ? checked.pubkey.trim()
      : null
  const cleanPrivkey = privkeyHex ? parseWalletPrivateKeyHex(privkeyHex) : null

  if (quotePubkey && !cleanPrivkey) {
    throw new Error('This mint quote is locked (NUT-20) and requires your signing key to claim.')
  }

  let builder = wallet.ops.mintBolt11(mintAmount, checked)
  if (activeSeedBytes) {
    builder = builder.asDeterministic()
  }
  if (quotePubkey && cleanPrivkey) {
    builder = builder.privkey(cleanPrivkey)
  }

  const minted = await builder.run()
  const stored = deduplicateProofs(minted.map(toStoredProof))
  return {
    state: 'ISSUED',
    proofs: stored,
    claimedSats: sumStoredProofs(stored),
    mintUrl: normalized,
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

  const spentProofSecrets = sanitizeSpentProofSecrets(obj.spentProofSecrets)

  return {
    version: 1,
    exportedAt: typeof obj.exportedAt === 'number' ? obj.exportedAt : Date.now(),
    ...(typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) && obj.updatedAt > 0
      ? { updatedAt: Math.floor(obj.updatedAt) }
      : {}),
    activeMintUrl:
      (typeof obj.activeMintUrl === 'string' && normalizeMintUrl(obj.activeMintUrl)) ||
      DEFAULT_ACTIVE_MINT_URL,
    ...(mnemonic ? { mnemonic } : {}),
    ...(privateKeyHex ? { privateKeyHex } : {}),
    keysetCounters: sanitizeCounters(obj.keysetCounters),
    mints,
    proofsByMint: normalizedProofs,
    ...(spentProofSecrets.length > 0 ? { spentProofSecrets } : {}),
    history: Array.isArray(obj.history) ? obj.history : [],
    sentTokens: Array.isArray(obj.sentTokens) ? obj.sentTokens : [],
    boltzSwaps: Array.isArray(obj.boltzSwaps) ? obj.boltzSwaps : [],
    boltzApiUrl: typeof obj.boltzApiUrl === 'string' ? obj.boltzApiUrl : undefined,
  }
}

/* --------------------------------------------------------------------------
   Proof-Safe Multi-Device Sync Export, Strict Validation & CRDT Merge
   -------------------------------------------------------------------------- */

const MAX_SYNC_BOLTZ_SWAPS = 80

const SENT_TOKEN_STATUS_RANK: Record<CashuSentTokenStatus, number> = {
  unclaimed: 1,
  claimed: 2,
  reclaimed: 3,
}

const TX_STATUS_RANK: Record<WalletTransaction['status'], number> = {
  pending: 1,
  expired: 2,
  failed: 3,
  completed: 4,
}

/**
 * Builds a deterministic, compact `WalletSyncExportInfo` snapshot for NIP-44 self-encrypted
 * multi-device sync (`kind: 30078` checkpoints & `sync-wallet-chunk` transfers).
 * Strips verbose `mint.info` probe blobs so the wallet fits comfortably inside checkpoint budgets.
 */
export function buildWalletSyncExport(
  state: PersistedCashuWalletState,
  boltzSwaps: BoltzSwapRecord[],
  boltzApiUrl?: string
): WalletSyncExportInfo | null {
  if (!state.initialized) return null
  const fingerprint = computeWalletFingerprint(state.mnemonic, state.privateKeyHex)
  if (!fingerprint) return null

  const updatedAt =
    typeof state.updatedAt === 'number' && Number.isFinite(state.updatedAt) && state.updatedAt > 0
      ? Math.floor(state.updatedAt)
      : 1

  const compactMints: CashuMintAccount[] = state.mints.map((m) => ({
    url: m.url,
    label: m.label,
    ...(m.description ? { description: m.description } : {}),
    addedAt: m.addedAt,
  }))

  const cleanApiUrl = boltzApiUrl ? normalizeBoltzApiUrl(boltzApiUrl) ?? undefined : undefined

  const payload: WalletSyncPayload = {
    version: 1,
    initialized: true,
    fingerprint,
    updatedAt,
    activeMintUrl: state.activeMintUrl,
    ...(state.mnemonic ? { mnemonic: state.mnemonic } : {}),
    ...(state.privateKeyHex ? { privateKeyHex: state.privateKeyHex } : {}),
    keysetCounters: sanitizeCounters(state.keysetCounters),
    mints: compactMints,
    proofsByMint: state.proofsByMint,
    spentProofSecrets: sanitizeSpentProofSecrets(state.spentProofSecrets),
    history: state.history.slice(0, MAX_HISTORY_ITEMS),
    sentTokens: state.sentTokens.slice(0, MAX_SENT_TOKENS),
    boltzSwaps: boltzSwaps.slice(0, MAX_SYNC_BOLTZ_SWAPS),
    ...(cleanApiUrl ? { boltzApiUrl: cleanApiUrl } : {}),
  }

  return {
    initialized: true,
    fingerprint,
    updatedAt,
    payload,
  }
}

/**
 * Strictly validates an untrusted remote `WalletSyncPayload` and verifies its recomputed
 * cryptographic key fingerprint matches `payload.fingerprint`.
 */
export function parseWalletSyncPayload(rawRemote: unknown): WalletSyncPayload | null {
  if (!rawRemote || typeof rawRemote !== 'object' || Array.isArray(rawRemote)) {
    return null
  }
  const obj = rawRemote as Partial<WalletSyncPayload>
  if (obj.version !== 1 || obj.initialized !== true) return null
  if (typeof obj.fingerprint !== 'string') return null
  const claimedFp = obj.fingerprint.trim().toLowerCase()
  if (!/^[0-9a-f]{16}$/.test(claimedFp)) return null

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

  if (!mnemonic && !privateKeyHex) return null
  const recomputedFp = computeWalletFingerprint(mnemonic, privateKeyHex)
  if (!recomputedFp || recomputedFp !== claimedFp) return null

  if (!Array.isArray(obj.mints)) return null
  if (!obj.proofsByMint || typeof obj.proofsByMint !== 'object' || Array.isArray(obj.proofsByMint)) {
    return null
  }

  const mintMap = new Map<string, CashuMintAccount>()
  for (const m of obj.mints) {
    if (!m || typeof m !== 'object' || typeof m.url !== 'string') continue
    const norm = normalizeMintUrl(m.url)
    if (!norm || mintMap.has(norm)) continue
    const catalog = findCatalogMint(norm)
    mintMap.set(norm, {
      url: norm,
      label: (typeof m.label === 'string' && m.label.trim()) || catalog?.name || formatMintHost(norm),
      description:
        (typeof m.description === 'string' && m.description.trim()) || catalog?.description,
      addedAt: typeof m.addedAt === 'number' && Number.isFinite(m.addedAt) ? m.addedAt : Date.now(),
      ...(m.info && typeof m.info === 'object' ? { info: m.info } : {}),
    })
  }

  const proofsByMint: Record<string, StoredCashuProof[]> = {}
  for (const [rawUrl, list] of Object.entries(obj.proofsByMint)) {
    const norm = normalizeMintUrl(rawUrl)
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

  const normActive =
    typeof obj.activeMintUrl === 'string' ? normalizeMintUrl(obj.activeMintUrl) : null
  const activeMintUrl =
    (normActive && mintMap.has(normActive) ? normActive : Array.from(mintMap.keys())[0]) ??
    DEFAULT_ACTIVE_MINT_URL

  const history = Array.isArray(obj.history)
    ? obj.history
        .filter(
          (tx): tx is WalletTransaction =>
            Boolean(tx && typeof tx === 'object' && typeof tx.id === 'string' && tx.id)
        )
        .slice(0, MAX_HISTORY_ITEMS)
    : []

  const sentTokens = Array.isArray(obj.sentTokens)
    ? obj.sentTokens
        .filter(
          (st): st is CashuSentTokenRecord =>
            Boolean(
              st &&
                typeof st === 'object' &&
                typeof st.id === 'string' &&
                st.id &&
                typeof st.token === 'string'
            )
        )
        .slice(0, MAX_SENT_TOKENS)
    : []

  const boltzSwaps = Array.isArray(obj.boltzSwaps)
    ? obj.boltzSwaps
        .filter(
          (sw): sw is BoltzSwapRecord =>
            Boolean(
              sw &&
                typeof sw === 'object' &&
                typeof sw.id === 'string' &&
                sw.id &&
                typeof sw.address === 'string'
            )
        )
        .slice(0, MAX_SYNC_BOLTZ_SWAPS)
    : []

  const updatedAt =
    typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) && obj.updatedAt > 0
      ? Math.floor(obj.updatedAt)
      : 0

  const boltzApiUrl =
    typeof obj.boltzApiUrl === 'string' ? normalizeBoltzApiUrl(obj.boltzApiUrl) ?? undefined : undefined

  return {
    version: 1,
    initialized: true,
    fingerprint: claimedFp,
    updatedAt,
    activeMintUrl,
    ...(mnemonic ? { mnemonic } : {}),
    ...(privateKeyHex ? { privateKeyHex } : {}),
    keysetCounters: sanitizeCounters(obj.keysetCounters),
    mints: Array.from(mintMap.values()),
    proofsByMint,
    spentProofSecrets: sanitizeSpentProofSecrets(obj.spentProofSecrets),
    history,
    sentTokens,
    boltzSwaps,
    ...(boltzApiUrl ? { boltzApiUrl } : {}),
  }
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function sameCounters(a: Record<string, number>, b: Record<string, number>): boolean {
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const k of keysA) {
    if (a[k] !== b[k]) return false
  }
  return true
}

function sameProofsByMint(
  a: Record<string, StoredCashuProof[]>,
  b: Record<string, StoredCashuProof[]>
): boolean {
  const keysA = Object.keys(a).filter((k) => (a[k]?.length ?? 0) > 0)
  const keysB = Object.keys(b).filter((k) => (b[k]?.length ?? 0) > 0)
  if (keysA.length !== keysB.length) return false
  for (const k of keysA) {
    const listA = a[k] ?? []
    const listB = b[k] ?? []
    if (listA.length !== listB.length) return false
    const setB = new Set(listB.map((p) => p.secret))
    for (const p of listA) {
      if (!setB.has(p.secret)) return false
    }
  }
  return true
}

function sameHistory(a: readonly WalletTransaction[], b: readonly WalletTransaction[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].status !== b[i].status || a[i].txid !== b[i].txid) {
      return false
    }
  }
  return true
}

function sameSentTokens(
  a: readonly CashuSentTokenRecord[],
  b: readonly CashuSentTokenRecord[]
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].status !== b[i].status) {
      return false
    }
  }
  return true
}

function sameSwaps(a: readonly BoltzSwapRecord[], b: readonly BoltzSwapRecord[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id ||
      a[i].status !== b[i].status ||
      Boolean(a[i].mintClaimed) !== Boolean(b[i].mintClaimed) ||
      a[i].txid !== b[i].txid ||
      a[i].updatedAt !== b[i].updatedAt
    ) {
      return false
    }
  }
  return true
}

export interface MergedWalletSyncResult {
  changed: boolean
  adoptedNewWallet: boolean
  stateChanged: boolean
  swapsChanged: boolean
  apiUrlChanged: boolean
  nextState: PersistedCashuWalletState
  nextSwaps: BoltzSwapRecord[]
  nextBoltzApiUrl: string
}

/**
 * Pure proof-safe CRDT merger for multi-device Agwallet sync:
 * - Case A: Local uninitialized + Remote initialized -> adopt remote wallet completely.
 * - Case B: Local & Remote have DIFFERENT key fingerprints -> safe no-op (never overwrite!).
 * - Case C: Same key fingerprint -> union spent-proof tombstones, filter proofs, max counters,
 *   dedupe mints/history/sentTokens/Boltz swaps with deterministic precedence.
 */
export function mergeSyncedWalletState(params: {
  localState: PersistedCashuWalletState
  localSwaps: BoltzSwapRecord[]
  localBoltzApiUrl: string
  rawRemote: unknown
}): MergedWalletSyncResult {
  const { localState, localSwaps, localBoltzApiUrl, rawRemote } = params
  const noop: MergedWalletSyncResult = {
    changed: false,
    adoptedNewWallet: false,
    stateChanged: false,
    swapsChanged: false,
    apiUrlChanged: false,
    nextState: localState,
    nextSwaps: localSwaps,
    nextBoltzApiUrl: localBoltzApiUrl,
  }

  const remote = parseWalletSyncPayload(rawRemote)
  if (!remote) return noop

  const localFp = localState.initialized
    ? computeWalletFingerprint(localState.mnemonic, localState.privateKeyHex)
    : null

  // Case A: Local has NO wallet set up -> adopt remote wallet completely
  if (!localState.initialized || !localFp) {
    const spentSet = new Set(remote.spentProofSecrets)
    const filteredProofs: Record<string, StoredCashuProof[]> = {}
    for (const [url, list] of Object.entries(remote.proofsByMint)) {
      const kept = deduplicateProofs(list).filter((p) => !spentSet.has(p.secret))
      if (kept.length > 0) {
        filteredProofs[url] = kept
      }
    }

    const mintMap = new Map<string, CashuMintAccount>()
    for (const m of remote.mints) {
      const cat = findCatalogMint(m.url)
      mintMap.set(m.url, {
        ...m,
        description: m.description || cat?.description,
        info:
          m.info ??
          (cat
            ? {
                url: cat.url,
                name: cat.name,
                description: cat.description,
                version: cat.version,
                nuts: [...cat.verifiedNuts],
                feePpk: cat.feePpk,
                activeSatKeysetId: null,
                online: true,
                lastCheckedAt: 0,
              }
            : undefined),
      })
    }
    if (mintMap.size === 0) {
      for (const def of buildDefaultMintsList()) {
        mintMap.set(def.url, def)
      }
    }
    const activeMintUrl = mintMap.has(remote.activeMintUrl)
      ? remote.activeMintUrl
      : Array.from(mintMap.keys())[0] ?? DEFAULT_ACTIVE_MINT_URL

    const adoptedHistory = [...remote.history]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_HISTORY_ITEMS)
    const adoptedSent = [...remote.sentTokens]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_SENT_TOKENS)
    const adoptedSwaps = [...remote.boltzSwaps]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_SYNC_BOLTZ_SWAPS)

    const nextState: PersistedCashuWalletState = {
      version: 1,
      initialized: true,
      updatedAt: remote.updatedAt || Date.now(),
      ...(remote.mnemonic ? { mnemonic: remote.mnemonic } : {}),
      ...(remote.privateKeyHex ? { privateKeyHex: remote.privateKeyHex } : {}),
      keysetCounters: sanitizeCounters(remote.keysetCounters),
      activeMintUrl,
      mints: Array.from(mintMap.values()),
      proofsByMint: filteredProofs,
      spentProofSecrets: remote.spentProofSecrets,
      history: adoptedHistory,
      sentTokens: adoptedSent,
    }

    const nextBoltzApiUrl = remote.boltzApiUrl ?? localBoltzApiUrl
    return {
      changed: true,
      adoptedNewWallet: true,
      stateChanged: true,
      swapsChanged: !sameSwaps(localSwaps, adoptedSwaps),
      apiUrlChanged: nextBoltzApiUrl !== localBoltzApiUrl,
      nextState,
      nextSwaps: adoptedSwaps,
      nextBoltzApiUrl,
    }
  }

  // Case B: Both devices have DIFFERENT wallets -> safe no-op (never overwrite!)
  if (localFp !== remote.fingerprint) {
    return noop
  }

  // Case C: Same linked Agwallet -> proof-safe CRDT merge
  const localSpent = sanitizeSpentProofSecrets(localState.spentProofSecrets)
  const localSpentSet = new Set(localSpent)
  const newlySpentFromRemote = remote.spentProofSecrets.filter((s) => !localSpentSet.has(s))
  const mergedSpent =
    newlySpentFromRemote.length > 0
      ? sanitizeSpentProofSecrets([...localSpent, ...newlySpentFromRemote])
      : localSpent
  const spentSet = new Set(mergedSpent)

  // Union mints by normalized URL (preserve local live-probed `info` if present)
  const mintMap = new Map<string, CashuMintAccount>()
  for (const m of localState.mints) {
    const norm = normalizeMintUrl(m.url)
    if (norm && !mintMap.has(norm)) {
      mintMap.set(norm, { ...m, url: norm })
    }
  }
  for (const m of remote.mints) {
    if (!mintMap.has(m.url)) {
      const cat = findCatalogMint(m.url)
      mintMap.set(m.url, {
        ...m,
        description: m.description || cat?.description,
        info:
          m.info ??
          (cat
            ? {
                url: cat.url,
                name: cat.name,
                description: cat.description,
                version: cat.version,
                nuts: [...cat.verifiedNuts],
                feePpk: cat.feePpk,
                activeSatKeysetId: null,
                online: true,
                lastCheckedAt: 0,
              }
            : undefined),
      })
    }
  }

  // Union proofs per mint & filter out all known spent-proof tombstones
  const allMintUrls = new Set<string>([
    ...Object.keys(localState.proofsByMint),
    ...Object.keys(remote.proofsByMint),
  ])
  const mergedProofsByMint: Record<string, StoredCashuProof[]> = {}
  for (const rawUrl of allMintUrls) {
    const norm = normalizeMintUrl(rawUrl)
    if (!norm) continue
    const localList = localState.proofsByMint[rawUrl] ?? localState.proofsByMint[norm] ?? []
    const remoteList = remote.proofsByMint[norm] ?? []
    const cleaned = deduplicateProofs([...localList, ...remoteList]).filter(
      (p) => !spentSet.has(p.secret)
    )
    if (cleaned.length > 0) {
      mergedProofsByMint[norm] = cleaned
      if (!mintMap.has(norm)) {
        const cat = findCatalogMint(norm)
        mintMap.set(norm, {
          url: norm,
          label: cat?.name || formatMintHost(norm),
          description: cat?.description,
          addedAt: Date.now(),
        })
      }
    }
  }

  const mergedMints = Array.from(mintMap.values())
  const localUpdatedAt = localState.updatedAt ?? 0
  const remoteIsNewer = remote.updatedAt > localUpdatedAt
  const mergedActiveMintUrl =
    remoteIsNewer && mintMap.has(remote.activeMintUrl)
      ? remote.activeMintUrl
      : localState.activeMintUrl

  // Keyset counters: monotonic per-keyset max
  const mergedCounters: Record<string, number> = { ...localState.keysetCounters }
  if (remote.keysetCounters) {
    for (const [ksId, count] of Object.entries(remote.keysetCounters)) {
      mergedCounters[ksId] = Math.max(mergedCounters[ksId] ?? 0, count)
    }
  }

  // History: dedupe by id (prefer higher-rank status or entry with txid), newest-first, cap 250
  const historyMap = new Map<string, WalletTransaction>()
  for (const tx of localState.history) {
    if (tx?.id) historyMap.set(tx.id, tx)
  }
  for (const rtx of remote.history) {
    if (!rtx?.id) continue
    const existing = historyMap.get(rtx.id)
    if (!existing) {
      historyMap.set(rtx.id, rtx)
    } else {
      const existingRank = TX_STATUS_RANK[existing.status] ?? 0
      const remoteRank = TX_STATUS_RANK[rtx.status] ?? 0
      if (remoteRank > existingRank || (remoteRank === existingRank && !existing.txid && rtx.txid)) {
        historyMap.set(rtx.id, { ...existing, ...rtx })
      }
    }
  }
  const mergedHistory = Array.from(historyMap.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_HISTORY_ITEMS)

  // Sent tokens: dedupe by id (claimed/reclaimed > unclaimed), newest-first, cap 120
  const sentMap = new Map<string, CashuSentTokenRecord>()
  for (const st of localState.sentTokens) {
    if (st?.id) sentMap.set(st.id, st)
  }
  for (const rst of remote.sentTokens) {
    if (!rst?.id) continue
    const existing = sentMap.get(rst.id)
    if (!existing) {
      sentMap.set(rst.id, rst)
    } else {
      const existingRank = SENT_TOKEN_STATUS_RANK[existing.status] ?? 0
      const remoteRank = SENT_TOKEN_STATUS_RANK[rst.status] ?? 0
      if (remoteRank > existingRank) {
        sentMap.set(rst.id, { ...existing, status: rst.status })
      }
    }
  }
  const mergedSentTokens = Array.from(sentMap.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_SENT_TOKENS)

  // Boltz swaps: dedupe by id (prefer mintClaimed: true or higher updatedAt), newest-first, cap 80
  const swapMap = new Map<string, BoltzSwapRecord>()
  for (const sw of localSwaps) {
    if (sw?.id) swapMap.set(sw.id, sw)
  }
  for (const rsw of remote.boltzSwaps) {
    if (!rsw?.id) continue
    const existing = swapMap.get(rsw.id)
    if (!existing) {
      swapMap.set(rsw.id, rsw)
    } else {
      const preferRemote =
        (Boolean(rsw.mintClaimed) && !existing.mintClaimed) ||
        (Boolean(rsw.mintClaimed) === Boolean(existing.mintClaimed) &&
          (rsw.updatedAt ?? 0) > (existing.updatedAt ?? 0))
      if (preferRemote) {
        swapMap.set(rsw.id, rsw)
      }
    }
  }
  const mergedSwaps = Array.from(swapMap.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_SYNC_BOLTZ_SWAPS)

  const mergedMnemonic = localState.mnemonic || remote.mnemonic
  const mergedPrivKey = localState.privateKeyHex || remote.privateKeyHex
  const nextBoltzApiUrl =
    remoteIsNewer && remote.boltzApiUrl ? remote.boltzApiUrl : localBoltzApiUrl

  const localMintUrls = localState.mints.map((m) => m.url)
  const mergedMintUrls = mergedMints.map((m) => m.url)

  const stateChanged =
    mergedMnemonic !== localState.mnemonic ||
    mergedPrivKey !== localState.privateKeyHex ||
    mergedActiveMintUrl !== localState.activeMintUrl ||
    !sameStringList(localSpent, mergedSpent) ||
    !sameStringList(localMintUrls, mergedMintUrls) ||
    !sameCounters(localState.keysetCounters, mergedCounters) ||
    !sameProofsByMint(localState.proofsByMint, mergedProofsByMint) ||
    !sameHistory(localState.history, mergedHistory) ||
    !sameSentTokens(localState.sentTokens, mergedSentTokens)

  const swapsChanged = !sameSwaps(localSwaps, mergedSwaps)
  const apiUrlChanged = nextBoltzApiUrl !== localBoltzApiUrl
  const changed = stateChanged || swapsChanged || apiUrlChanged

  if (!changed) {
    return noop
  }

  const nextState: PersistedCashuWalletState = {
    version: 1,
    initialized: true,
    updatedAt: Math.max(localUpdatedAt, remote.updatedAt) || Date.now(),
    ...(mergedMnemonic ? { mnemonic: mergedMnemonic } : {}),
    ...(mergedPrivKey ? { privateKeyHex: mergedPrivKey } : {}),
    keysetCounters: mergedCounters,
    activeMintUrl: mergedActiveMintUrl,
    mints: mergedMints,
    proofsByMint: mergedProofsByMint,
    spentProofSecrets: mergedSpent,
    history: mergedHistory,
    sentTokens: mergedSentTokens,
  }

  return {
    changed: true,
    adoptedNewWallet: false,
    stateChanged,
    swapsChanged,
    apiUrlChanged,
    nextState,
    nextSwaps: mergedSwaps,
    nextBoltzApiUrl,
  }
}
