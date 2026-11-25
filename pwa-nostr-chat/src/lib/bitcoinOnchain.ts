import { secp256k1 } from '@noble/curves/secp256k1'
import { ripemd160 } from '@noble/hashes/ripemd160'
import { sha256 } from '@noble/hashes/sha256'
import { base58, bech32, bech32m } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english'
import { bytesToHex, hexToBytes, parseSecretKey } from './identity.ts'

export const BITCOIN_BIP84_DERIVATION_PATH = "m/84'/0'/0'/0/0"
export const BITCOIN_DUST_LIMIT_SATS = 546

const BITCOIN_API_ENDPOINTS = [
  'https://mempool.space/api',
  'https://blockstream.info/api',
] as const

const DEFAULT_TIMEOUT_MS = 8_000
const SEQUENCE_RBF = 0xfffffffd
const SIGHASH_ALL = 0x01

export interface NativeBtcWalletKeys {
  address: string
  derivationPath: string
  privateKey: Uint8Array
  publicKey: Uint8Array
  pubkeyHash: Uint8Array
}

export interface BitcoinUtxo {
  txid: string
  vout: number
  value: number
  confirmed: boolean
  blockHeight?: number
  blockTime?: number
}

export interface BitcoinOnchainState {
  address: string
  confirmedSats: number
  unconfirmedSats: number
  totalSats: number
  utxos: BitcoinUtxo[]
  fetchedAt: number
}

export interface BitcoinFeeRates {
  fastestFee: number
  halfHourFee: number
  hourFee: number
  economyFee: number
  minimumFee: number
}

export const DEFAULT_BITCOIN_FEE_RATES: BitcoinFeeRates = {
  fastestFee: 8,
  halfHourFee: 5,
  hourFee: 3,
  economyFee: 2,
  minimumFee: 1,
}

export interface BuildP2wpkhTxParams {
  wallet: NativeBtcWalletKeys
  utxos: readonly BitcoinUtxo[]
  toAddress: string
  amountSats: number
  feeRateSatVb: number
  sendAll?: boolean
}

export interface SignedP2wpkhTxResult {
  rawTxHex: string
  txid: string
  vbytes: number
  feeSats: number
  feeRateSatVb: number
  sentSats: number
  changeSats: number
  inputCount: number
  outputCount: number
}

/* --------------------------------------------------------------------------
   Low-Level Binary, Hash & Script Helpers
   -------------------------------------------------------------------------- */

function hash160(bytes: Uint8Array): Uint8Array {
  return ripemd160(sha256(bytes))
}

function doubleSha256(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes))
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function writeUint32LE(value: number): Uint8Array {
  const out = new Uint8Array(4)
  const view = new DataView(out.buffer)
  view.setUint32(0, value >>> 0, true)
  return out
}

function writeUint64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  const view = new DataView(out.buffer)
  view.setBigUint64(0, value, true)
  return out
}

function writeVarInt(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('Invalid Bitcoin compact-size integer.')
  }
  if (n < 0xfd) {
    return new Uint8Array([n])
  }
  if (n <= 0xffff) {
    const out = new Uint8Array(3)
    out[0] = 0xfd
    new DataView(out.buffer).setUint16(1, n, true)
    return out
  }
  if (n <= 0xffffffff) {
    const out = new Uint8Array(5)
    out[0] = 0xfe
    new DataView(out.buffer).setUint32(1, n, true)
    return out
  }
  const out = new Uint8Array(9)
  out[0] = 0xff
  new DataView(out.buffer).setBigUint64(1, BigInt(n), true)
  return out
}

function p2wpkhScriptPubKey(pubkeyHash20: Uint8Array): Uint8Array {
  if (pubkeyHash20.length !== 20) {
    throw new Error('P2WPKH pubkey hash must be 20 bytes.')
  }
  return concatBytes([new Uint8Array([0x00, 0x14]), pubkeyHash20])
}

function normalizePhrase(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

function isValidPhrase(raw: string): boolean {
  const norm = normalizePhrase(raw)
  const words = norm.split(' ').filter(Boolean)
  if (words.length !== 12 && words.length !== 24) return false
  return validateMnemonic(norm, englishWordlist)
}

/* --------------------------------------------------------------------------
   BIP-84 Native SegWit (P2WPKH `bc1q...`) Key & Address Derivation
   -------------------------------------------------------------------------- */

/**
 * Derives a self-custodial Core Bitcoin Native SegWit (`bc1q...`, P2WPKH) wallet directly
 * from Agwallet's BIP-39 12/24-word recovery phrase (`m/84'/0'/0'/0/0`) or 32-byte private key.
 * Pure offline derivation — zero network dependencies.
 */
export function deriveNativeBtcWallet(params: {
  mnemonic?: string | null
  privateKeyHex?: string | null
}): NativeBtcWalletKeys | null {
  if (params.mnemonic && isValidPhrase(params.mnemonic)) {
    const norm = normalizePhrase(params.mnemonic)
    const seed = mnemonicToSeedSync(norm)
    const child = HDKey.fromMasterSeed(seed).derive(BITCOIN_BIP84_DERIVATION_PATH)
    if (
      !child.privateKey ||
      child.privateKey.length !== 32 ||
      !child.publicKey ||
      child.publicKey.length !== 33
    ) {
      return null
    }
    const privateKey = new Uint8Array(child.privateKey)
    const publicKey = new Uint8Array(child.publicKey)
    const pubkeyHash = hash160(publicKey)
    const address = bech32.encode('bc', [0, ...bech32.toWords(pubkeyHash)])
    return {
      address,
      derivationPath: BITCOIN_BIP84_DERIVATION_PATH,
      privateKey,
      publicKey,
      pubkeyHash,
    }
  }

  if (params.privateKeyHex) {
    const parsed = parseSecretKey(params.privateKeyHex)
    if (!parsed || parsed.length !== 32) return null
    const privateKey = new Uint8Array(parsed)
    const publicKey = secp256k1.getPublicKey(privateKey, true)
    const pubkeyHash = hash160(publicKey)
    const address = bech32.encode('bc', [0, ...bech32.toWords(pubkeyHash)])
    return {
      address,
      derivationPath: 'direct-p2wpkh',
      privateKey,
      publicKey,
      pubkeyHash,
    }
  }

  return null
}

/* --------------------------------------------------------------------------
   Mainnet Address -> `scriptPubKey` Encoder (P2WPKH, P2WSH, P2TR, P2PKH, P2SH)
   -------------------------------------------------------------------------- */

/**
 * Encodes any standard Bitcoin mainnet destination address (`bc1q...`, `bc1p...`, `1...`, `3...`)
 * into its consensus `scriptPubKey` bytes. Throws a descriptive error for invalid/testnet addresses.
 */
export function encodeDestinationScriptPubKey(address: string): Uint8Array {
  const trimmed = address.trim()
  if (!trimmed) {
    throw new Error('Enter a destination Bitcoin address.')
  }

  const lower = trimmed.toLowerCase()
  if (lower.startsWith('bc1')) {
    // BIP-173 / BIP-350 strictly forbid mixed case
    if (trimmed !== lower && trimmed !== trimmed.toUpperCase()) {
      throw new Error('Invalid Bitcoin Bech32 address (mixed case).')
    }

    // Try SegWit v0 (Bech32): bc1q... (20B P2WPKH or 32B P2WSH)
    let v0Decoded: { prefix: string; words: number[] } | null = null
    try {
      v0Decoded = bech32.decode(lower as `${string}1${string}`)
    } catch {
      v0Decoded = null
    }

    if (v0Decoded && v0Decoded.prefix === 'bc' && v0Decoded.words.length >= 2) {
      const version = v0Decoded.words[0]
      if (version !== 0) {
        throw new Error('SegWit v1+ addresses must use Bech32m encoding.')
      }
      const program = bech32.fromWords(v0Decoded.words.slice(1))
      if (program.length === 20) {
        return concatBytes([new Uint8Array([0x00, 0x14]), program])
      }
      if (program.length === 32) {
        return concatBytes([new Uint8Array([0x00, 0x20]), program])
      }
      throw new Error('Invalid SegWit v0 witness program length.')
    }

    // Try SegWit v1 Taproot (Bech32m): bc1p... (32B P2TR)
    let v1Decoded: { prefix: string; words: number[] } | null = null
    try {
      v1Decoded = bech32m.decode(lower as `${string}1${string}`)
    } catch {
      v1Decoded = null
    }

    if (v1Decoded && v1Decoded.prefix === 'bc' && v1Decoded.words.length >= 2) {
      const version = v1Decoded.words[0]
      if (version !== 1) {
        throw new Error(`Unsupported SegWit witness version (${version}).`)
      }
      const program = bech32m.fromWords(v1Decoded.words.slice(1))
      if (program.length !== 32) {
        throw new Error('Taproot (bc1p) witness program must be 32 bytes.')
      }
      return concatBytes([new Uint8Array([0x51, 0x20]), program])
    }

    throw new Error('Invalid Bitcoin Bech32/Bech32m address checksum.')
  }

  // Legacy Base58Check: P2PKH (1..., version 0x00) or P2SH (3..., version 0x05)
  if (trimmed.startsWith('1') || trimmed.startsWith('3')) {
    let decoded: Uint8Array
    try {
      decoded = base58.decode(trimmed)
    } catch {
      throw new Error('Invalid Base58 Bitcoin address.')
    }
    if (decoded.length !== 25) {
      throw new Error('Invalid legacy Bitcoin address length.')
    }
    const payload = decoded.slice(0, 21)
    const checksum = decoded.slice(21, 25)
    const expected = doubleSha256(payload).slice(0, 4)
    for (let i = 0; i < 4; i++) {
      if (checksum[i] !== expected[i]) {
        throw new Error('Invalid legacy Bitcoin address checksum.')
      }
    }
    const version = payload[0]
    const hash20 = payload.slice(1, 21)
    if (version === 0x00) {
      // OP_DUP OP_HASH160 <20B> OP_EQUALVERIFY OP_CHECKSIG
      return concatBytes([new Uint8Array([0x76, 0xa9, 0x14]), hash20, new Uint8Array([0x88, 0xac])])
    }
    if (version === 0x05) {
      // OP_HASH160 <20B> OP_EQUAL
      return concatBytes([new Uint8Array([0xa9, 0x14]), hash20, new Uint8Array([0x87])])
    }
    throw new Error('Unsupported Bitcoin address network prefix.')
  }

  throw new Error('Enter a valid Bitcoin mainnet address (bc1q…, bc1p…, 1…, or 3…).')
}

/* --------------------------------------------------------------------------
   BIP-143 SegWit v0 P2WPKH Transaction Builder & Signer
   -------------------------------------------------------------------------- */

function estimateP2wpkhVbytes(
  inputCount: number,
  destScriptLength: number,
  hasChangeOutput: boolean
): number {
  const destOutBytes = 9 + destScriptLength
  const changeOutBytes = hasChangeOutput ? 31 : 0
  return Math.ceil(10.5 + 68 * inputCount + destOutBytes + changeOutBytes)
}

const MAX_BITCOIN_SATS = 21_000_000 * 100_000_000

export interface NativeBitcoinSendPlan {
  readonly fromAddress: string
  readonly toAddress: string
  readonly inputs: readonly Readonly<BitcoinUtxo>[]
  readonly amountSats: number
  readonly feeSats: number
  readonly changeSats: number
  readonly feeRateSatVb: number
}

/** Select inputs and calculate exact outputs without accessing a signing key. */
export function prepareNativeBitcoinSend(
  params: Omit<BuildP2wpkhTxParams, 'wallet'> & { fromAddress: string }
): NativeBitcoinSendPlan {
  const { toAddress, sendAll = false } = params
  const destScript = encodeDestinationScriptPubKey(toAddress)

  const cleanFeeRate = Math.max(
    1,
    Math.min(1000, Math.ceil(Number.isFinite(params.feeRateSatVb) ? params.feeRateSatVb : 5))
  )
  const requestedAmount = params.amountSats
  if (!sendAll && !Number.isSafeInteger(requestedAmount)) {
    throw new Error('Bitcoin amount must be a whole number of sats.')
  }
  if (!sendAll && requestedAmount > MAX_BITCOIN_SATS) {
    throw new Error('Bitcoin amount is above the supply limit.')
  }
  if (!sendAll && requestedAmount < BITCOIN_DUST_LIMIT_SATS) {
    throw new Error(`Minimum on-chain Bitcoin send is ${BITCOIN_DUST_LIMIT_SATS} sats (dust threshold).`)
  }

  // Prefer confirmed UTXOs first, then largest value first
  const seen = new Set<string>()
  const validUtxos = params.utxos
    .filter(
      (u) =>
        u &&
        typeof u.txid === 'string' &&
        /^[0-9a-f]{64}$/i.test(u.txid) &&
        Number.isInteger(u.vout) &&
        u.vout >= 0 &&
        u.vout <= 0xffffffff &&
        Number.isSafeInteger(u.value) &&
        u.value > 0 &&
        u.value <= MAX_BITCOIN_SATS
    )
    .map((u) => ({
      ...u,
      txid: u.txid.toLowerCase(),
    }))
    .filter((u) => {
      const outpoint = `${u.txid}:${u.vout}`
      if (seen.has(outpoint)) throw new Error('Duplicate Bitcoin outpoint in explorer response.')
      seen.add(outpoint)
      return true
    })
    .sort((a, b) => {
      if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1
      return b.value - a.value
    })

  if (validUtxos.length === 0) {
    throw new Error('No spendable on-chain Bitcoin UTXOs found for this address.')
  }

  const selected: BitcoinUtxo[] = []
  let totalIn = 0
  let sentSats = requestedAmount
  let feeSats = 0
  let changeSats = 0

  if (sendAll) {
    for (const u of validUtxos) {
      selected.push(u)
      totalIn += u.value
      if (totalIn > MAX_BITCOIN_SATS) throw new Error('Bitcoin input total is above the supply limit.')
    }
    const estVbytes = estimateP2wpkhVbytes(selected.length, destScript.length, false)
    feeSats = estVbytes * cleanFeeRate
    sentSats = totalIn - feeSats
    if (sentSats < BITCOIN_DUST_LIMIT_SATS) {
      throw new Error(
        `Balance (${totalIn.toLocaleString()} sats) is too small to cover the ${feeSats.toLocaleString()} sat miner fee.`
      )
    }
    changeSats = 0
  } else {
    let funded = false
    for (const u of validUtxos) {
      selected.push(u)
      totalIn += u.value
      if (totalIn > MAX_BITCOIN_SATS) throw new Error('Bitcoin input total is above the supply limit.')

      const feeWithChange =
        estimateP2wpkhVbytes(selected.length, destScript.length, true) * cleanFeeRate
      const remWithChange = totalIn - requestedAmount - feeWithChange
      if (remWithChange >= BITCOIN_DUST_LIMIT_SATS) {
        feeSats = feeWithChange
        changeSats = remWithChange
        funded = true
        break
      }

      const feeNoChange =
        estimateP2wpkhVbytes(selected.length, destScript.length, false) * cleanFeeRate
      if (totalIn >= requestedAmount + feeNoChange) {
        // Sub-dust remainder folded safely into miner fee (1 output)
        feeSats = totalIn - requestedAmount
        changeSats = 0
        funded = true
        break
      }
    }

    if (!funded) {
      const estFee =
        estimateP2wpkhVbytes(Math.max(1, selected.length), destScript.length, false) * cleanFeeRate
      throw new Error(
        `Insufficient on-chain BTC balance (${totalIn.toLocaleString()} sats available; need ~${(requestedAmount + estFee).toLocaleString()} sats incl. fee).`
      )
    }
  }

  return Object.freeze({
    fromAddress: params.fromAddress,
    toAddress,
    inputs: Object.freeze(selected.map((input) => Object.freeze(input))),
    amountSats: sentSats,
    feeSats,
    changeSats,
    feeRateSatVb: cleanFeeRate,
  })
}

/** Sign exactly the inputs and outputs selected before user confirmation. */
export function signNativeBitcoinSend(
  wallet: NativeBtcWalletKeys,
  plan: NativeBitcoinSendPlan
): SignedP2wpkhTxResult {
  if (wallet.address !== plan.fromAddress) throw new Error('Bitcoin wallet changed. Review a new send.')
  const { inputs: selected, amountSats: sentSats, feeSats, changeSats, feeRateSatVb: cleanFeeRate } = plan
  if (selected.reduce((total, input) => total + input.value, 0) !== sentSats + feeSats + changeSats) {
    throw new Error('Bitcoin send plan amounts do not balance.')
  }
  const destScript = encodeDestinationScriptPubKey(plan.toAddress)

  // Construct outputs
  const outputs: Array<{ value: number; scriptPubKey: Uint8Array }> = [
    { value: sentSats, scriptPubKey: destScript },
  ]
  if (changeSats >= BITCOIN_DUST_LIMIT_SATS) {
    outputs.push({
      value: changeSats,
      scriptPubKey: p2wpkhScriptPubKey(wallet.pubkeyHash),
    })
  }

  // Precompute BIP-143 shared digests
  const outpoints: Uint8Array[] = []
  const sequences: Uint8Array[] = []
  for (const u of selected) {
    const txidBytes = hexToBytes(u.txid)
    if (!txidBytes || txidBytes.length !== 32) {
      throw new Error(`Invalid UTXO txid: ${u.txid}`)
    }
    const txidLE = new Uint8Array(txidBytes).reverse()
    outpoints.push(concatBytes([txidLE, writeUint32LE(u.vout)]))
    sequences.push(writeUint32LE(SEQUENCE_RBF))
  }

  const serializedOutputs = outputs.map((out) =>
    concatBytes([
      writeUint64LE(BigInt(out.value)),
      writeVarInt(out.scriptPubKey.length),
      out.scriptPubKey,
    ])
  )

  const versionLE = writeUint32LE(2)
  const locktimeLE = writeUint32LE(0)
  const sighashAllLE = writeUint32LE(SIGHASH_ALL)
  const hashPrevouts = doubleSha256(concatBytes(outpoints))
  const hashSequence = doubleSha256(concatBytes(sequences))
  const hashOutputs = doubleSha256(concatBytes(serializedOutputs))

  // BIP-143 P2WPKH scriptCode: 0x19 OP_DUP OP_HASH160 0x14 <20B pubkeyHash> OP_EQUALVERIFY OP_CHECKSIG
  const scriptCode = concatBytes([
    new Uint8Array([0x19, 0x76, 0xa9, 0x14]),
    wallet.pubkeyHash,
    new Uint8Array([0x88, 0xac]),
  ])

  const witnessParts: Uint8Array[] = []
  for (let i = 0; i < selected.length; i++) {
    const preimage = concatBytes([
      versionLE,
      hashPrevouts,
      hashSequence,
      outpoints[i],
      scriptCode,
      writeUint64LE(BigInt(selected[i].value)),
      sequences[i],
      hashOutputs,
      locktimeLE,
      sighashAllLE,
    ])
    const sighash = doubleSha256(preimage)
    const sig = secp256k1.sign(sighash, wallet.privateKey, { lowS: true })
    const verified = secp256k1.verify(sig, sighash, wallet.publicKey, { lowS: true })
    if (!verified) {
      throw new Error(`Failed local signature verification for input #${i}.`)
    }
    const sigWithType = concatBytes([sig.toDERRawBytes(), new Uint8Array([SIGHASH_ALL])])
    witnessParts.push(
      concatBytes([
        new Uint8Array([0x02]),
        writeVarInt(sigWithType.length),
        sigWithType,
        writeVarInt(wallet.publicKey.length),
        wallet.publicKey,
      ])
    )
  }

  const inputsSerialized = concatBytes([
    writeVarInt(selected.length),
    ...selected.map((_, i) => concatBytes([outpoints[i], new Uint8Array([0x00]), sequences[i]])),
  ])
  const outputsSerialized = concatBytes([writeVarInt(outputs.length), ...serializedOutputs])

  // Non-witness legacy serialization determines the consensus TXID (double-SHA256 reversed)
  const nonWitnessTx = concatBytes([versionLE, inputsSerialized, outputsSerialized, locktimeLE])
  const txid = bytesToHex(doubleSha256(nonWitnessTx).reverse())

  // BIP-141 full SegWit serialization (marker=0x00, flag=0x01, witness stack)
  const fullSegwitTx = concatBytes([
    versionLE,
    new Uint8Array([0x00, 0x01]),
    inputsSerialized,
    outputsSerialized,
    ...witnessParts,
    locktimeLE,
  ])

  const actualVbytes = Math.ceil((nonWitnessTx.length * 3 + fullSegwitTx.length) / 4)

  return {
    rawTxHex: bytesToHex(fullSegwitTx),
    txid,
    vbytes: actualVbytes,
    feeSats,
    feeRateSatVb: cleanFeeRate,
    sentSats,
    changeSats,
    inputCount: selected.length,
    outputCount: outputs.length,
  }
}

/** Convenience for non-interactive callers; the wallet UI uses the two steps above. */
export function buildAndSignP2wpkhTx(params: BuildP2wpkhTxParams): SignedP2wpkhTxResult {
  return signNativeBitcoinSend(params.wallet, prepareNativeBitcoinSend({
    ...params, fromAddress: params.wallet.address,
  }))
}

/* --------------------------------------------------------------------------
   Live Mainnet Esplora Client (mempool.space primary, blockstream.info fallback)
   -------------------------------------------------------------------------- */

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    globalThis.clearTimeout(timer)
  }
}

interface EsploraUtxoRaw {
  txid?: string
  vout?: number
  value?: number
  status?: {
    confirmed?: boolean
    block_height?: number
    block_time?: number
  }
}

/**
 * Fetches live UTXOs and confirmed/unconfirmed satoshi balances for a Bitcoin mainnet address
 * via `mempool.space/api` with automatic fallback to `blockstream.info/api`.
 */
export async function fetchBitcoinOnchainState(address: string): Promise<BitcoinOnchainState> {
  const cleanAddr = address.trim()
  if (!cleanAddr) {
    throw new Error('Bitcoin address is required.')
  }

  let lastErr: Error | null = null
  for (const base of BITCOIN_API_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(
        `${base}/address/${encodeURIComponent(cleanAddr)}/utxo`,
        { method: 'GET', cache: 'no-store', headers: { Accept: 'application/json' } }
      )
      if (!res.ok) {
        lastErr = new Error(`Bitcoin explorer returned HTTP ${res.status}.`)
        continue
      }
      const raw = (await res.json()) as unknown
      if (!Array.isArray(raw)) {
        lastErr = new Error('Unexpected UTXO response format.')
        continue
      }

      let confirmedSats = 0
      let unconfirmedSats = 0
      const utxos: BitcoinUtxo[] = []

      for (const item of raw as EsploraUtxoRaw[]) {
        if (
          !item ||
          typeof item.txid !== 'string' ||
          !/^[0-9a-f]{64}$/i.test(item.txid) ||
          typeof item.vout !== 'number' ||
          !Number.isInteger(item.vout) ||
          item.vout < 0 ||
          item.vout > 0xffffffff ||
          typeof item.value !== 'number' ||
          !Number.isSafeInteger(item.value) ||
          item.value <= 0 ||
          item.value > MAX_BITCOIN_SATS
        ) {
          continue
        }
        const value = item.value
        const confirmed = item.status?.confirmed === true
        if (confirmed) {
          confirmedSats += value
        } else {
          unconfirmedSats += value
        }
        utxos.push({
          txid: item.txid.toLowerCase(),
          vout: item.vout,
          value,
          confirmed,
          ...(typeof item.status?.block_height === 'number'
            ? { blockHeight: item.status.block_height }
            : {}),
          ...(typeof item.status?.block_time === 'number'
            ? { blockTime: item.status.block_time }
            : {}),
        })
      }

      return {
        address: cleanAddr,
        confirmedSats,
        unconfirmedSats,
        totalSats: confirmedSats + unconfirmedSats,
        utxos,
        fetchedAt: Date.now(),
      }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error('Failed to fetch Bitcoin UTXOs.')
    }
  }

  throw lastErr ?? new Error('Unable to reach Bitcoin blockchain explorers.')
}

function clampFee(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) {
    return Math.max(1, Math.round(raw))
  }
  return fallback
}

/**
 * Fetches live mainnet recommended fee rates (sat/vB) from `mempool.space/api/v1/fees/recommended`
 * with fallback to `blockstream.info/api/fee-estimates` and safe defaults.
 */
export async function fetchBitcoinFeeRates(): Promise<BitcoinFeeRates> {
  try {
    const res = await fetchWithTimeout(
      `${BITCOIN_API_ENDPOINTS[0]}/v1/fees/recommended`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    )
    if (res.ok) {
      const data = (await res.json()) as Partial<BitcoinFeeRates>
      return {
        fastestFee: clampFee(data.fastestFee, DEFAULT_BITCOIN_FEE_RATES.fastestFee),
        halfHourFee: clampFee(data.halfHourFee, DEFAULT_BITCOIN_FEE_RATES.halfHourFee),
        hourFee: clampFee(data.hourFee, DEFAULT_BITCOIN_FEE_RATES.hourFee),
        economyFee: clampFee(data.economyFee, DEFAULT_BITCOIN_FEE_RATES.economyFee),
        minimumFee: clampFee(data.minimumFee, DEFAULT_BITCOIN_FEE_RATES.minimumFee),
      }
    }
  } catch {
    // Fall through to Blockstream estimate
  }

  try {
    const res = await fetchWithTimeout(
      `${BITCOIN_API_ENDPOINTS[1]}/fee-estimates`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    )
    if (res.ok) {
      const est = (await res.json()) as Record<string, number>
      return {
        fastestFee: clampFee(est['1'] ?? est['2'], DEFAULT_BITCOIN_FEE_RATES.fastestFee),
        halfHourFee: clampFee(est['3'] ?? est['4'], DEFAULT_BITCOIN_FEE_RATES.halfHourFee),
        hourFee: clampFee(est['6'], DEFAULT_BITCOIN_FEE_RATES.hourFee),
        economyFee: clampFee(est['12'] ?? est['24'], DEFAULT_BITCOIN_FEE_RATES.economyFee),
        minimumFee: clampFee(est['144'] ?? est['504'], DEFAULT_BITCOIN_FEE_RATES.minimumFee),
      }
    }
  } catch {
    // Fall back to defaults
  }

  return { ...DEFAULT_BITCOIN_FEE_RATES }
}

/**
 * Broadcasts a signed raw Bitcoin mainnet transaction hex via `mempool.space/api/tx`
 * with automatic fallback to `blockstream.info/api/tx`. Returns the 64-char hex `txid`.
 */
export async function broadcastBitcoinRawTx(rawTxHex: string, expectedTxid: string): Promise<string> {
  const cleanHex = rawTxHex.trim().toLowerCase()
  if (!/^[0-9a-f]+$/.test(cleanHex) || cleanHex.length < 120 || cleanHex.length % 2 ||
    !/^[0-9a-f]{64}$/.test(expectedTxid)) {
    throw new Error('Invalid raw Bitcoin transaction hex.')
  }

  let lastErr: Error | null = null
  for (const base of BITCOIN_API_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(
        `${base}/tx`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: cleanHex,
        },
        12_000
      )
      const text = (await res.text()).trim()
      if (res.ok && text.toLowerCase() === expectedTxid) return expectedTxid
      if (res.ok) throw new Error('Bitcoin explorer returned an unexpected transaction ID.')
      const errMsg = `Bitcoin broadcast was not acknowledged (HTTP ${res.status}).`
      lastErr = new Error(errMsg)
      // On explicit consensus rejection (4xx), still try secondary endpoint once unless invalid
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error('Failed to broadcast Bitcoin transaction.')
    }
  }

  throw lastErr ?? new Error('Unable to broadcast Bitcoin transaction.')
}


/** Check an earlier ambiguous broadcast against the exact signed bytes. */
export async function hasBitcoinRawTx(txid: string, rawTxHex: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(txid)) return false
  for (const base of BITCOIN_API_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(`${base}/tx/${txid}/hex`, { cache: 'no-store' }, DEFAULT_TIMEOUT_MS)
      if (res.ok && (await res.text()).trim().toLowerCase() === rawTxHex) return true
    } catch {
      // An unavailable explorer cannot prove a failed or successful broadcast.
    }
  }
  return false
}
