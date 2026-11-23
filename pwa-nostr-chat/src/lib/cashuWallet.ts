import {
  Amount,
  CheckStateEnum,
  MeltQuoteState,
  Mint,
  MintQuoteState,
  Wallet,
  getEncodedToken,
  getTokenMetadata,
  type MeltQuoteBolt11Response,
  type MintQuoteBolt11Response,
  type Proof,
  type ProofLike,
} from '@cashu/cashu-ts'
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

export const CASHU_WALLET_STORAGE_KEY = 'agnostr:v2:cashu_wallet'

const MAX_HISTORY_ITEMS = 250
const MAX_SENT_TOKENS = 100
const CASHU_TOKEN_GLOBAL_REGEX = /\b(cashu[AB][A-Za-z0-9_-]{20,})\b/g
const CASHU_TOKEN_SINGLE_REGEX = /^(?:cashu:)?(cashu[AB][A-Za-z0-9_-]{20,})$/i

export interface PersistedCashuWalletState {
  version: 1
  activeMintUrl: string
  mints: CashuMintAccount[]
  proofsByMint: Record<string, StoredCashuProof[]>
  history: WalletTransaction[]
  sentTokens: CashuSentTokenRecord[]
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
    activeMintUrl: DEFAULT_ACTIVE_MINT_URL,
    mints: buildDefaultMintsList(),
    proofsByMint: {},
    history: [],
    sentTokens: [],
  }
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

    return {
      version: 1,
      activeMintUrl,
      mints: Array.from(mintMap.values()),
      proofsByMint,
      history,
      sentTokens,
    }
  } catch {
    return fallback
  }
}

export function savePersistedCashuWallet(state: PersistedCashuWalletState): void {
  try {
    const trimmed: PersistedCashuWalletState = {
      version: 1,
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
   Multi-Mint `@cashu/cashu-ts` v4 Session Manager
   -------------------------------------------------------------------------- */

const walletCache = new Map<string, Promise<Wallet>>()
const activeMeltQuoteCache = new Map<string, MeltQuoteBolt11Response>()

export function clearCashuWalletInstanceCache(): void {
  walletCache.clear()
  activeMeltQuoteCache.clear()
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
    const wallet = new Wallet(mint, { unit: 'sat' })
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
   Core Protocol Operations (NUT-04, NUT-05, NUT-07, Swap Send/Receive)
   -------------------------------------------------------------------------- */

export async function inspectCashuMint(mintUrl: string): Promise<CashuMintInfoSummary> {
  const summary = await probeCashuMint(mintUrl)
  if (summary.online) {
    // Warm up cashu-ts wallet cache in the background for fast subsequent quotes
    void getLoadedCashuWallet(summary.url, true).catch(() => {})
  }
  return summary
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
    throw new Error('Invalid Cashu token. Paste a valid cashuA... or cashuB... token.')
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
 * NUT-05: Executes a melt quote atomically:
 * 1. Prepares exact `send` proofs (`amount + fee_reserve` + input fees) via `wallet.send`.
 * 2. Calls `onCommitKeep(keepProofs)` IMMEDIATELY before melting so change proofs are
 *    safely persisted even if the network drops mid-payment.
 * 3. Melts `send` proofs and returns any overpaid fee-reserve `change` proofs.
 * 4. On failure, verifies `send` proof states via NUT-07 so any `UNSPENT` proofs are
 *    automatically recovered instead of lost!
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

  // Persist keep change proofs BEFORE melting send proofs
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
    // Recovery safety: check NUT-07 proof states on `send` so UNSPENT proofs are never lost
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
      // If state check also fails due to offline network, restore send proofs optimistically
      // so user can run Verify Proofs once reconnected
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
  if (!obj.proofsByMint || typeof obj.proofsByMint !== 'object') {
    throw new Error('Backup JSON is missing Cashu proofs (`proofsByMint`).')
  }

  const normalizedProofs: Record<string, StoredCashuProof[]> = {}
  for (const [url, list] of Object.entries(obj.proofsByMint)) {
    const norm = normalizeMintUrl(url)
    if (!norm || !Array.isArray(list)) continue
    const cleaned = deduplicateProofs(list)
    if (cleaned.length > 0) {
      normalizedProofs[norm] = cleaned
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
    mints,
    proofsByMint: normalizedProofs,
    history: Array.isArray(obj.history) ? obj.history : [],
    sentTokens: Array.isArray(obj.sentTokens) ? obj.sentTokens : [],
    boltzSwaps: Array.isArray(obj.boltzSwaps) ? obj.boltzSwaps : [],
    boltzApiUrl: typeof obj.boltzApiUrl === 'string' ? obj.boltzApiUrl : undefined,
  }
}
