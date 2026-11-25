import {
  broadcastBitcoinRawTx,
  fetchBitcoinOnchainState,
  hasBitcoinRawTx,
  prepareNativeBitcoinSend,
  signNativeBitcoinSend,
  type BitcoinUtxo,
  type NativeBitcoinSendPlan,
  type NativeBtcWalletKeys,
} from './bitcoinOnchain.ts'

export interface NativeBitcoinSendReview {
  readonly fromAddress: string
  readonly toAddress: string
  readonly amountSats: number
  readonly feeSats: number
  readonly changeSats: number
}

export interface NativeBitcoinPendingSend extends NativeBitcoinSendReview {
  readonly txid: string
  readonly acknowledged: boolean
}

interface SignedSend extends NativeBitcoinPendingSend {
  rawTxHex: string
  outpoints: string[]
  dismissed: boolean
}

interface SendEnvironment {
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'>
  lock: <T>(name: string, operation: () => Promise<T>) => Promise<T>
  fetchUtxos: (address: string) => Promise<readonly BitcoinUtxo[]>
  includesTx: (txid: string, signedHex: string) => Promise<boolean>
  broadcast: (signedHex: string, txid: string) => Promise<string>
}

// Deliberately independent of Nostr profile switching so the same Bitcoin
// address cannot build a new payment while another profile has an unresolved one.
// Contains signed transaction data and public metadata, never a key or seed.
const STORAGE_PREFIX = 'agwallet-native-btc-send:v1:'
const REVIEW_TTL_MS = 120_000
const browser: SendEnvironment = {
  getStorage: () => window.localStorage,
  lock: async (name, operation) => {
    if (!navigator.locks) {
      throw new Error('This browser cannot safely coordinate Bitcoin sends between tabs.')
    }
    return navigator.locks.request(name, operation)
  },
  fetchUtxos: async (address) => (await fetchBitcoinOnchainState(address)).utxos,
  includesTx: hasBitcoinRawTx,
  broadcast: broadcastBitcoinRawTx,
}

export const nativeBitcoinSendJournalKey = (address: string) => STORAGE_PREFIX + address

function outpoint(input: Readonly<BitcoinUtxo>): string {
  return `${input.txid}:${input.vout}`
}

function publicView(record: SignedSend): NativeBitcoinPendingSend {
  const { fromAddress, toAddress, amountSats, feeSats, changeSats, txid, acknowledged } = record
  return { fromAddress, toAddress, amountSats, feeSats, changeSats, txid, acknowledged }
}

export function createNativeBitcoinSend(
  getKeys: () => NativeBtcWalletKeys | null,
  io: SendEnvironment = browser
) {
  let review: {
    publicReview: NativeBitcoinSendReview
    plan: NativeBitcoinSendPlan
    journalTxid: string | null
    expiresAt: number
  } | null = null

  const read = (address: string): SignedSend | null => {
    const raw = io.getStorage().getItem(nativeBitcoinSendJournalKey(address))
    if (raw === null) return null
    const row = JSON.parse(raw) as Partial<SignedSend> | null
    if (!row || row.fromAddress !== address ||
        typeof row.toAddress !== 'string' ||
        typeof row.txid !== 'string' || !/^[0-9a-f]{64}$/.test(row.txid) ||
        typeof row.rawTxHex !== 'string' || row.rawTxHex.length < 120 ||
        row.rawTxHex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(row.rawTxHex) ||
        typeof row.acknowledged !== 'boolean' || typeof row.dismissed !== 'boolean' ||
        (row.dismissed && !row.acknowledged) ||
        !Array.isArray(row.outpoints) || row.outpoints.length === 0 ||
        !row.outpoints.every((v) => typeof v === 'string' && /^[0-9a-f]{64}:\d+$/.test(v)) ||
        ![row.amountSats, row.feeSats, row.changeSats].every((v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) {
      throw new Error('Bitcoin send recovery data could not be read. No new transaction was signed.')
    }
    return row as SignedSend
  }

  const save = (intent: SignedSend) => {
    const key = nativeBitcoinSendJournalKey(intent.fromAddress)
    const data = JSON.stringify(intent)
    const storage = io.getStorage()
    storage.setItem(key, data)
    if (storage.getItem(key) !== data) throw new Error('Bitcoin send recovery data was not saved.')
  }

  const currentWallet = (address?: string) => {
    const keys = getKeys()
    if (!keys || (address !== undefined && keys.address !== address)) {
      throw new Error('Bitcoin wallet changed or is unavailable. Review a new send.')
    }
    return keys
  }

  const submit = async (intent: SignedSend, isRetry: boolean): Promise<NativeBitcoinPendingSend> => {
    // A previous POST may have succeeded even when the browser never got a reply.
    try {
      if (!isRetry || !(await io.includesTx(intent.txid, intent.rawTxHex))) {
        currentWallet(intent.fromAddress)
        const returned = await io.broadcast(intent.rawTxHex, intent.txid)
        if (returned !== intent.txid) throw new Error('Unexpected Bitcoin transaction ID.')
      }
      const accepted = { ...intent, acknowledged: true }
      save(accepted)
      return publicView(accepted)
    } catch {
      throw new Error('Bitcoin broadcast is unconfirmed. Check or retry this same transaction; do not create another payment.')
    }
  }

  return {
    pending(address: string): NativeBitcoinPendingSend | null {
      const saved = read(address)
      return saved && !saved.dismissed ? publicView(saved) : null
    },
    async prepare(toAddress: string, amountSats: number, feeRateSatVb: number): Promise<NativeBitcoinSendReview> {
      review = null
      const address = currentWallet().address
      return io.lock(nativeBitcoinSendJournalKey(address), async () => {
        currentWallet(address)
        const saved = read(address)
        if (saved && !saved.dismissed) throw new Error('Resolve the existing Bitcoin transaction first.')
        const utxos = await io.fetchUtxos(address)
        currentWallet(address)
        const plan = prepareNativeBitcoinSend({
          utxos: utxos.filter((input) => !saved?.outpoints.includes(outpoint(input))),
          fromAddress: address, toAddress: toAddress.trim(), amountSats, feeRateSatVb,
        })
        const publicReview = Object.freeze({
          fromAddress: address, toAddress: plan.toAddress, amountSats: plan.amountSats,
          feeSats: plan.feeSats, changeSats: plan.changeSats,
        })
        review = { publicReview, plan, journalTxid: saved?.txid ?? null, expiresAt: Date.now() + REVIEW_TTL_MS }
        return publicReview
      })
    },
    async confirm(approved: NativeBitcoinSendReview): Promise<NativeBitcoinPendingSend> {
      const candidate = review
      if (!candidate || candidate.publicReview !== approved) throw new Error('Review this Bitcoin send again.')
      review = null
      const { fromAddress } = candidate.plan
      return io.lock(nativeBitcoinSendJournalKey(fromAddress), async () => {
        currentWallet(fromAddress)
        const previous = read(fromAddress)
        if ((previous?.txid ?? null) !== candidate.journalTxid) throw new Error('Bitcoin sends changed in another tab. Review again.')
        if (previous && !previous.dismissed) throw new Error('Resolve the existing Bitcoin transaction first.')
        const fresh = await io.fetchUtxos(fromAddress)
        const live = new Map(fresh.map((input) => [outpoint(input), input.value]))
        if (Date.now() >= candidate.expiresAt ||
            candidate.plan.inputs.some((input) => live.get(outpoint(input)) !== input.value)) {
          throw new Error('Bitcoin inputs changed or the review expired. Review a new send.')
        }
        const signed = signNativeBitcoinSend(currentWallet(fromAddress), candidate.plan)
        const intent: SignedSend = {
          ...candidate.publicReview,
          txid: signed.txid, rawTxHex: signed.rawTxHex, acknowledged: false, dismissed: false,
          outpoints: candidate.plan.inputs.map(outpoint),
        }
        // If persistence fails, no request to an explorer is made.
        save(intent)
        return submit(intent, false)
      })
    },
    async dismiss(txid: string): Promise<void> {
      const address = currentWallet().address
      await io.lock(nativeBitcoinSendJournalKey(address), async () => {
        currentWallet(address)
        const saved = read(address)
        if (!saved || saved.txid !== txid || !saved.acknowledged) {
          throw new Error('This Bitcoin transaction has not been acknowledged.')
        }
        save({ ...saved, dismissed: true })
      })
    },
    async retry(txid: string): Promise<NativeBitcoinPendingSend> {
      const address = currentWallet().address
      return io.lock(nativeBitcoinSendJournalKey(address), async () => {
        currentWallet(address)
        const saved = read(address)
        if (!saved || saved.txid !== txid) throw new Error('This Bitcoin transaction is no longer awaiting a retry.')
        return saved.acknowledged ? publicView(saved) : submit(saved, true)
      })
    },
  }
}
