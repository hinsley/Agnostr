import type { Event as NostrEvent } from 'nostr-tools'
import type { WalletSyncExportInfo } from './deviceSync.ts'

/* ==========================================================================
   Cashu Ecash Wallet, Boltz v2 On-Chain Swaps & NIP-57 Lightning Zaps Types
   ========================================================================== */

export interface CashuMintCatalogEntry {
  url: string
  name: string
  description: string
  /** Input fee in parts per thousand (100 ppk = 0.1 sat/input, rounded up) */
  feePpk: number
  version: string
  verifiedNuts: number[]
  verifiedAt: string
}

export interface CashuMintInfoSummary {
  url: string
  name: string
  description?: string
  version?: string
  motd?: string
  pubkey?: string
  nuts: number[]
  feePpk: number | null
  activeSatKeysetId: string | null
  online: boolean
  lastCheckedAt: number
  error?: string
}

/**
 * JSON-safe persisted representation of a Cashu Proof (`@cashu/cashu-ts` v4
 * uses bigint `Amount` in memory; satoshi proofs convert cleanly at the boundary).
 */
export interface StoredCashuProof {
  id: string
  amount: number
  secret: string
  C: string
  dleq?: {
    e: string
    s: string
    r?: string
  }
  witness?: string | Record<string, unknown>
}

export interface CashuMintAccount {
  url: string
  label: string
  description?: string
  addedAt: number
  info?: CashuMintInfoSummary
}

export interface CashuTokenPreview {
  raw: string
  mintUrl: string
  unit: string
  amountSats: number
  memo?: string
  proofCount: number
}

export type CashuMintQuoteState = 'UNPAID' | 'PAID' | 'ISSUED' | 'EXPIRED'

export interface CashuMintQuoteRecord {
  quoteId: string
  mintUrl: string
  amountSats: number
  invoice: string
  state: CashuMintQuoteState
  expiry: number | null
  createdAt: number
  description?: string
}

export type CashuMeltQuoteState = 'UNPAID' | 'PENDING' | 'PAID'

export interface CashuMeltQuotePreview {
  quoteId: string
  mintUrl: string
  invoice: string
  amountSats: number
  feeReserveSats: number
  totalRequiredSats: number
  expiry: number
  state: CashuMeltQuoteState
  recipient?: string
  memo?: string
}

export type CashuSentTokenStatus = 'unclaimed' | 'claimed' | 'reclaimed'

export interface CashuSentTokenRecord {
  id: string
  token: string
  mintUrl: string
  amountSats: number
  memo?: string
  createdAt: number
  status: CashuSentTokenStatus
  proofSecrets: string[]
}

export type WalletTxType =
  | 'receive_ecash'
  | 'send_ecash'
  | 'receive_ln'
  | 'send_ln'
  | 'receive_btc'
  | 'send_btc'
  | 'zap_out'
  | 'zap_in'
  | 'nutzap_in'
  | 'nutzap_out'
  | 'reclaim'

export type WalletTxStatus = 'pending' | 'completed' | 'failed' | 'expired'

export interface WalletTransaction {
  id: string
  type: WalletTxType
  status: WalletTxStatus
  amountSats: number
  feeSats?: number
  mintUrl: string
  memo?: string
  counterparty?: string
  invoice?: string
  token?: string
  swapId?: string
  txid?: string
  createdAt: number
}

/* --------------------------------------------------------------------------
   Boltz Exchange v2 Submarine & Reverse Submarine Swaps (BTC <-> Lightning)
   -------------------------------------------------------------------------- */

export type BoltzSwapDirection = 'submarine' | 'reverse'

export interface BoltzSwapTreeLeaf {
  version: number
  output: string
}

export interface BoltzSwapTree {
  claimLeaf: BoltzSwapTreeLeaf
  refundLeaf: BoltzSwapTreeLeaf
  [leafName: string]: BoltzSwapTreeLeaf | undefined
}

export interface BoltzSubmarinePairInfo {
  hash: string
  rate: number
  minSats: number
  maxSats: number
  maxZeroConfSats: number
  feePercent: number
  minerFeeSats: number
  fetchedAt: number
}

export interface BoltzReversePairInfo {
  hash: string
  rate: number
  minSats: number
  maxSats: number
  feePercent: number
  lockupMinerFeeSats: number
  claimMinerFeeSats: number
  fetchedAt: number
}

export interface BoltzSwapRecord {
  id: string
  direction: BoltzSwapDirection
  apiUrl: string
  mintUrl: string
  /** Exact Boltz v2 SwapUpdateEvent string (e.g. 'swap.created', 'transaction.mempool', 'invoice.paid', 'transaction.claimed') */
  status: string
  createdAt: number
  updatedAt: number
  /** Submarine: Cashu mint amount; Reverse: LN hold invoice amount */
  amountSats: number
  /** Submarine: expected BTC on-chain deposit; Reverse: BTC locked in HTLC by Boltz */
  expectedOnchainSats: number
  feeSats: number
  /** Submarine: Cashu NUT-04 mint quote BOLT-11; Reverse: Boltz hold BOLT-11 */
  invoice: string
  mintQuoteId?: string
  mintClaimed?: boolean
  /** Submarine: BTC deposit HTLC address; Reverse: Boltz lockup HTLC address */
  address: string
  bip21?: string
  /** Reverse: user's target on-chain BTC address */
  destinationAddress?: string
  timeoutBlockHeight?: number
  acceptZeroConf?: boolean
  /** Locally generated secp256k1 private key hex (refund key for submarine, claim key for reverse) */
  localKeyPrivateHex: string
  /** Compressed 33-byte secp256k1 public key hex */
  localKeyPublicHex: string
  boltzPublicKeyHex?: string
  /** Reverse swap 32-byte secret preimage hex */
  preimageHex?: string
  /** Reverse swap SHA-256 hex of preimage */
  preimageHashHex?: string
  swapTree?: BoltzSwapTree
  txid?: string
  txConfirmed?: boolean
  zeroConfRejected?: boolean
  error?: string
}

export interface WalletBackupPayload {
  version: 1
  exportedAt: number
  updatedAt?: number
  activeMintUrl: string
  mnemonic?: string
  privateKeyHex?: string
  keysetCounters?: Record<string, number>
  mints: CashuMintAccount[]
  proofsByMint: Record<string, StoredCashuProof[]>
  spentProofSecrets?: string[]
  history: WalletTransaction[]
  sentTokens: CashuSentTokenRecord[]
  boltzSwaps: BoltzSwapRecord[]
  boltzApiUrl?: string
}

export interface WalletSyncPayload {
  version: 1
  initialized: boolean
  fingerprint: string
  updatedAt: number
  activeMintUrl: string
  mnemonic?: string
  privateKeyHex?: string
  keysetCounters?: Record<string, number>
  mints: CashuMintAccount[]
  proofsByMint: Record<string, StoredCashuProof[]>
  spentProofSecrets: string[]
  history: WalletTransaction[]
  sentTokens: CashuSentTokenRecord[]
  boltzSwaps: BoltzSwapRecord[]
  boltzApiUrl?: string
}

/* --------------------------------------------------------------------------
   NIP-57 Lightning Zaps & Lightning Address Discovery (lud16 / lnurl)
   -------------------------------------------------------------------------- */

export interface LnurlPayMetadata {
  callback: string
  minSendableMsat: number
  maxSendableMsat: number
  minSendableSats: number
  maxSendableSats: number
  commentAllowed: number
  allowsNostr: boolean
  nostrPubkey?: string
  description: string
  identifier?: string
  domain: string
}

export interface ZapTarget {
  pubkey: string
  nickname?: string
  lud16?: string | null
  eventId?: string
  channelLabel?: string
}

export interface ZapInvoiceResult {
  invoice: string
  amountSats: number
  recipientLud16: string
  recipientPubkey: string
  zapRequestEventId?: string
  allowsNostr: boolean
  metadata: LnurlPayMetadata
  comment?: string
}

export interface ZapReceiptSummary {
  id: string
  amountSats: number
  senderPubkey?: string
  recipientPubkey: string
  targetEventId?: string
  comment?: string
  createdAt: number
  kind?: 'nip57' | 'nip61'
}

/* --------------------------------------------------------------------------
   NIP-61 Nutzaps (kind: 10019 / kind: 9321) & Built-in npub.cash v2 Auto-Sweep
   -------------------------------------------------------------------------- */

export type ZapAddressMode = 'builtin' | 'custom'

export interface NutzapInfoRecord {
  pubkey: string
  p2pkPubkey: string
  mints: Array<{ url: string; units: string[] }>
  relays: string[]
  createdAt: number
}

export interface NutzapEventParsed {
  id: string
  senderPubkey: string
  recipientPubkey: string
  mintUrl: string
  unit: string
  proofs: StoredCashuProof[]
  amountSats: number
  targetEventId?: string
  comment?: string
  createdAt: number
}

export interface NpubCashQuote {
  createdAt: number
  paidAt: number | null
  expiresAt: number | null
  mintUrl: string
  quoteId: string
  request: string
  amount: number
  state: string
  locked: boolean
  zapRequest?: string
}

export interface NpubCashStatus {
  enabled: boolean
  mode: ZapAddressMode
  builtinAddress: string
  activeAddress: string | null
  mintUrl: string | null
  sweeping: boolean
  lastSweptAt: number | null
  lastSweptSats: number
  lastError: string | null
}

/* --------------------------------------------------------------------------
   Modal Navigation Intents
   -------------------------------------------------------------------------- */

export type WalletModalTab = 'overview' | 'receive' | 'send' | 'mints' | 'history'
export type WalletReceiveMode = 'cashu' | 'lightning' | 'onchain'
export type WalletSendMode = 'cashu' | 'lightning' | 'onchain'

export interface WalletInitialIntent {
  tab?: WalletModalTab
  receiveMode?: WalletReceiveMode
  sendMode?: WalletSendMode
  /** Prefilled cashuA/cashuB token, BOLT-11 invoice, lightning: URI, or user@domain address */
  payload?: string
}

/* --------------------------------------------------------------------------
   Engine Contracts Exposed on AgnostrEngine (`engine.wallet` & `engine.zaps`)
   -------------------------------------------------------------------------- */

export type WalletImportMode = 'mnemonic' | 'privkey' | 'json'

export interface WalletDraftKeys {
  mnemonic: string
  privateKeyHex: string
}

export interface WalletEngine {
  // Onboarding & NUT-13 seed / key state
  initialized: boolean
  mnemonic: string | null
  privateKeyHex: string | null
  /** 32-byte x-only hex P2PK pubkey derived from the wallet's `privateKeyHex` (used for NIP-61 Nutzaps) */
  nutzapP2pkPubkeyHex: string | null

  // Multi-mint balances & state
  mints: CashuMintAccount[]
  activeMintUrl: string
  balancesByMint: Record<string, number>
  proofCountByMint: Record<string, number>
  totalBalanceSats: number
  activeMintBalanceSats: number
  history: WalletTransaction[]
  sentTokens: CashuSentTokenRecord[]
  activeMintQuote: CashuMintQuoteRecord | null
  boltzSwaps: BoltzSwapRecord[]
  boltzApiUrl: string
  busy: boolean
  lastError: string | null

  // Setup, seed & private key management
  generateDraftWalletKeys: () => WalletDraftKeys
  createNewWallet: (opts?: {
    mnemonic?: string
    privateKeyHex?: string
    mintUrl?: string
  }) => void
  importWalletKeyOrSeed: (
    rawInput: string,
    opts?: { mintUrl?: string; scanMints?: boolean }
  ) => Promise<{
    mode: WalletImportMode
    restoredSats: number
    restoredProofs: number
  }>
  restoreProofsFromSeed: (mintUrl?: string) => Promise<{
    restoredSats: number
    restoredProofs: number
  }>
  exportWalletKeyJson: () => string

  // Mint management
  selectMint: (mintUrl: string) => void
  addMint: (mintUrl: string, label?: string) => Promise<CashuMintInfoSummary>
  removeMint: (mintUrl: string) => boolean
  inspectMint: (mintUrl: string) => Promise<CashuMintInfoSummary>
  verifyProofs: (mintUrl?: string) => Promise<{
    checked: number
    spentRemoved: number
    pendingCount: number
    balanceSats: number
  }>

  // Cashu Ecash receive & send
  decodeTokenPreview: (token: string) => CashuTokenPreview | null
  receiveCashuToken: (token: string) => Promise<{
    amountSats: number
    mintUrl: string
    memo?: string
  }>
  createCashuToken: (
    amountSats: number,
    memo?: string,
    mintUrl?: string
  ) => Promise<CashuSentTokenRecord>
  checkSentTokenStatus: (sentId: string) => Promise<CashuSentTokenStatus>
  reclaimSentToken: (sentId: string) => Promise<number>

  // NIP-61 P2PK Nutzaps & External Mint Quote Sweeping (npub.cash v2)
  sendP2pkNutzapProofs: (params: {
    amountSats: number
    recipientP2pkPubkey: string
    mintUrl?: string
    counterparty?: string
    memo?: string
  }) => Promise<{
    mintUrl: string
    proofs: StoredCashuProof[]
    amountSats: number
    feeSats: number
  }>
  claimP2pkNutzapProofs: (params: {
    mintUrl: string
    proofs: StoredCashuProof[]
    candidatePrivkeysHex: string[]
    senderPubkey?: string
    memo?: string
    nutzapEventId?: string
  }) => Promise<{
    claimedSats: number
    mintUrl: string
  }>
  claimExternalMintQuote: (params: {
    mintUrl: string
    quoteId: string
    amountSats: number
    privkeyHex?: string
    counterparty?: string
    memo?: string
    txType?: 'zap_in' | 'receive_ln'
  }) => Promise<{
    state: CashuMintQuoteState
    claimedSats: number
    mintUrl: string
  }>

  // Lightning NUT-04 receive & NUT-05 send
  createLightningReceiveQuote: (
    amountSats: number,
    description?: string,
    mintUrl?: string
  ) => Promise<CashuMintQuoteRecord>
  checkAndClaimMintQuote: (quoteId?: string) => Promise<{
    state: CashuMintQuoteState
    claimedSats: number
  }>
  clearActiveMintQuote: () => void
  prepareLightningPayment: (
    invoiceOrAddress: string,
    amountSats?: number,
    comment?: string,
    mintUrl?: string
  ) => Promise<CashuMeltQuotePreview>
  payLightningQuote: (
    preview: CashuMeltQuotePreview,
    meta?: {
      counterparty?: string
      memo?: string
      txType?: 'send_ln' | 'zap_out'
    }
  ) => Promise<{
    paid: boolean
    feePaidSats: number
    preimage?: string | null
  }>
  payBolt11Invoice: (
    invoice: string,
    meta?: {
      counterparty?: string
      memo?: string
      txType?: 'send_ln' | 'zap_out'
      mintUrl?: string
    }
  ) => Promise<{
    paid: boolean
    amountSats: number
    feePaidSats: number
    preimage?: string | null
  }>

  // Native self-custodial Core Blockchain Bitcoin (BIP-84 P2WPKH)
  btcAddress: string | null
  btcDerivationPath: string | null
  btcBalanceConfirmedSats: number
  btcBalanceUnconfirmedSats: number
  btcBalanceTotalSats: number
  btcUtxoCount: number
  btcRefreshing: boolean
  btcLastUpdatedAt: number | null
  btcError: string | null
  refreshOnchainBtcBalance: () => Promise<void>
  sendNativeOnchainBtc: (
    toAddress: string,
    amountSats: number,
    feeRateSatVb?: number
  ) => Promise<{ txid: string; feeSats: number; sentSats: number }>

  // On-Chain BTC via Boltz v2 submarine & reverse submarine swaps
  setBoltzApiUrl: (url: string) => void
  fetchBoltzSubmarinePair: () => Promise<BoltzSubmarinePairInfo>
  fetchBoltzReversePair: () => Promise<BoltzReversePairInfo>
  createOnchainReceiveSwap: (amountSats: number, mintUrl?: string) => Promise<BoltzSwapRecord>
  createOnchainSendSwap: (
    destinationAddress: string,
    amountSats: number,
    mintUrl?: string
  ) => Promise<BoltzSwapRecord>
  refreshBoltzSwap: (swapId: string) => Promise<BoltzSwapRecord | null>
  exportBoltzSwapRescueJson: (swapId: string) => string | null

  // Encrypted multi-device sync
  exportSyncState: () => WalletSyncExportInfo | null
  mergeSyncState: (remote: unknown) => boolean

  // Backup, restore & Panic Wipe
  exportBackupJson: () => string
  importBackupJson: (rawJson: string) => Promise<{
    importedMints: number
    importedProofs: number
    totalSats: number
  }>
  clearHistory: () => void
  resetAll: () => void
}

export interface ZapEngine {
  lightningAddress: string | null
  zapMode: ZapAddressMode
  builtinLightningAddress: string
  customLightningAddress: string | null
  npubCashAutoSweep: boolean
  npubCashSweeping: boolean
  npubCashLastSweptAt: number | null
  npubCashLastError: string | null
  npubCashMintUrl: string | null
  nutzapInfoPublished: boolean
  publishingProfile: boolean
  peerLightningAddresses: Record<string, string>
  peerNutzapInfo: Record<string, NutzapInfoRecord>
  zapTotalsByEventId: Record<string, number>
  zapReceiptsByEventId: Record<string, ZapReceiptSummary[]>

  setLightningAddress: (address: string | null) => Promise<{
    ok: boolean
    normalized: string | null
    publishedRelays: number
    error?: string
  }>
  setZapAddressMode: (
    mode: ZapAddressMode,
    customAddress?: string | null
  ) => Promise<{
    ok: boolean
    normalized: string | null
    publishedRelays: number
    error?: string
  }>
  setNpubCashAutoSweep: (enabled: boolean) => void
  sweepNpubCashNow: (opts?: { silent?: boolean }) => Promise<{
    claimedCount: number
    claimedSats: number
    error?: string
  }>
  publishNutzapInfo: () => Promise<{
    ok: boolean
    publishedRelays: number
    error?: string
  }>
  getPeerLightningAddress: (pubkey: string) => string | null
  lookupPeerLightningAddress: (pubkey: string, force?: boolean) => Promise<string | null>
  getPeerNutzapInfo: (pubkey: string) => NutzapInfoRecord | null
  lookupPeerNutzapInfo: (pubkey: string, force?: boolean) => Promise<NutzapInfoRecord | null>
  ingestPeerLightningAddress: (pubkey: string, lud16: string | null | undefined) => void
  ingestEventTags: (pubkey: string, tags: string[][]) => void
  ingestZapReceipt: (event: NostrEvent) => ZapReceiptSummary | null
  watchEventIds: (eventIds: string[]) => void
  resolveLnurlPay: (lud16OrLnurl: string) => Promise<LnurlPayMetadata>
  requestZapInvoice: (params: {
    target: ZapTarget
    amountSats: number
    comment?: string
  }) => Promise<ZapInvoiceResult>
  sendNutzap: (params: {
    target: ZapTarget
    amountSats: number
    comment?: string
    mintUrl?: string
  }) => Promise<{
    eventId: string
    amountSats: number
    feeSats: number
    mintUrl: string
    publishedRelays: number
  }>
  canZapPeer: (pubkey: string) => boolean
  resetAll: () => void
}
