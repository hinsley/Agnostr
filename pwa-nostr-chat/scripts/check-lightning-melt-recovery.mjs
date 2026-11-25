import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { Amount, CheckStateEnum, MeltQuoteState, OutputData } from '@cashu/cashu-ts'
import { createServer } from 'vite'

let server
let cashu
let lightning
before(async () => {
  server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    logLevel: 'silent',
    server: { middlewareMode: true, ws: false },
    appType: 'custom',
  })
  cashu = await server.ssrLoadModule('/src/lib/cashuWallet.ts')
  lightning = await server.ssrLoadModule('/src/lib/zaps.ts')
})
after(async () => server?.close())

const mintUrl = 'https://mint.example'
const invoice = 'lnbc-test-fixture-not-a-real-invoice'
const keyset = '0011223344556677'
const proof = { id: keyset, secret: 'test input', C: 'fixture', amount: 64 }
const changeProof = { id: keyset, secret: 'test change', C: 'fixture', amount: Amount.from(11) }
const expiry = Math.floor(Date.now() / 1000) + 3600
const tx = { id: 'local-payment-1', type: 'send_ln', status: 'pending', mintUrl, amountSats: 50, invoice, createdAt: Date.now() }
const preview = { quoteId: 'test-quote', mintUrl, amountSats: 50, feeReserveSats: 4, invoice, expiry, state: 'UNPAID' }
const availableQuote = {
  quote: preview.quoteId, amount: Amount.from(50), fee_reserve: Amount.from(4),
  unit: 'sat', expiry, state: MeltQuoteState.UNPAID, request: invoice,
}

test('persist before submit, then recover the same reserved change data after a lost response', async () => {
  const output = OutputData.createSingleRandomData(0, keyset)
  const serialized = OutputData.serialize(output)
  const state = { quote: availableQuote, submitted: 0, checkedKeysets: [], disk: null }
  const mock = {
    checkMeltQuoteBolt11: async () => state.quote,
    selectProofsToSend: (inputs) => ({ send: inputs, keep: [] }),
    getFeesForProofs: () => Amount.from(1),
    getMintInfo: () => ({ isSupported: () => ({ supported: true }) }),
    prepareMelt: async (method, quote, inputs) => ({ method, quote, inputs, outputData: [output] }),
    completeMelt: async () => {
      assert.ok(state.disk, 'the original request has a durable journal')
      state.submitted++
      throw new Error('simulated lost response')
    },
    ensureOperableKeysets: async (ids) => { state.checkedKeysets = ids },
    createMeltChangeProofs: (outputs) => {
      assert.deepEqual(OutputData.serialize(outputs[0]), serialized)
      return [changeProof]
    },
  }
  const load = async () => mock
  const { pending, submit } = await cashu.prepareRecoverableLightningMelt(preview, [proof], tx, load)
  assert.equal(state.submitted, 0)
  assert.deepEqual(pending.inputs, [proof])
  state.disk = JSON.stringify(pending)
  await assert.rejects(submit, /simulated lost response/)

  const loaded = JSON.parse(state.disk)
  state.quote = { ...availableQuote, state: MeltQuoteState.PENDING }
  assert.deepEqual(await cashu.reconcileLightningMelt(loaded, load), { state: 'pending' })

  state.quote = { ...availableQuote, state: MeltQuoteState.PAID }
  assert.deepEqual(await cashu.reconcileLightningMelt(loaded, load), { state: 'pending' })

  state.quote.change = [{ amount: Amount.from(11), id: keyset, C_: 'fixture' }]
  assert.deepEqual(await cashu.reconcileLightningMelt(loaded, load), {
    state: 'paid', change: [{ ...changeProof, amount: 11 }], feePaidSats: 3, preimage: null,
  })
  assert.deepEqual(state.checkedKeysets, [keyset])
  assert.equal(state.submitted, 1, 'polling must not submit a replacement')
})

test('an unpaid quote releases inputs only after expiry and confirmed unspent status', async () => {
  const now = Math.floor(Date.now() / 1000)
  const pending = { transaction: tx, quoteId: preview.quoteId, expiry: now - 30, inputs: [proof], outputs: [] }
  let quote = { ...availableQuote, expiry: now + 30 }
  let proofState = CheckStateEnum.PENDING
  const load = async () => ({
    checkMeltQuoteBolt11: async () => quote,
    checkProofsStates: async () => [{ state: proofState }],
  })
  assert.deepEqual(await cashu.reconcileLightningMelt(pending, load), { state: 'pending' })
  quote = { ...availableQuote, expiry: now - 30 }
  assert.deepEqual(await cashu.reconcileLightningMelt(pending, load), { state: 'pending' })
  proofState = CheckStateEnum.UNSPENT
  assert.deepEqual(await cashu.reconcileLightningMelt(pending, load), { state: 'expired', recoveredInputs: [proof] })
})

test('rejects an inconsistent quote before reserving anything', async () => {
  await assert.rejects(
    () => cashu.prepareRecoverableLightningMelt(preview, [proof], tx, async () => ({
      checkMeltQuoteBolt11: async () => ({ ...availableQuote, fee_reserve: Amount.from(5) }),
    })), /changed or expired/
  )
})

test('will not risk overpaid fees on a mint without NUT-08 change', async () => {
  await assert.rejects(
    () => cashu.prepareRecoverableLightningMelt(preview, [proof], tx, async () => ({
      checkMeltQuoteBolt11: async () => availableQuote,
      selectProofsToSend: (inputs) => ({ send: inputs, keep: [] }),
      getFeesForProofs: () => Amount.from(1),
      getMintInfo: () => ({ isSupported: () => ({ supported: false }) }),
    })), /No payment was submitted/
  )
})

test('settles paid when a spent fee reserve leaves no change', async () => {
  const pending = {
    transaction: tx, quoteId: preview.quoteId, expiry, inputs: [{ ...proof, amount: 55 }],
    outputs: [], feeReserveSats: 4, inputFeeSats: 1,
  }
  const load = async () => ({
    checkMeltQuoteBolt11: async () => ({ ...availableQuote, state: MeltQuoteState.PAID }),
    createMeltChangeProofs: () => [],
  })
  assert.deepEqual(await cashu.reconcileLightningMelt(pending, load), {
    state: 'paid', change: [], feePaidSats: 5, preimage: null,
  })
})

test('compares Lightning invoice amounts in exact millisatoshis', () => {
  assert.equal(lightning.decodeBolt11AmountMsats('lnbc1500n1qqq'), 150000n)
  assert.equal(lightning.decodeBolt11AmountMsats('lnbc1501n1qqq'), 150100n)
  assert.equal(lightning.decodeBolt11AmountMsats('lnbc1000010p1qqq'), 100001n)
  assert.equal(lightning.decodeBolt11AmountMsats('lnbc1000011p1qqq'), null)
  assert.equal(lightning.decodeBolt11AmountMsats('lnbc1qqq'), null)
})

test('a stale tab cannot drop or resurrect an in-flight melt', () => {
  const oldStorage = globalThis.localStorage
  const data = new Map()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, value: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
    },
  })
  try {
    const wallet = cashu.createEmptyWalletState()
    const pending = { transaction: tx, quoteId: preview.quoteId, expiry, inputs: [proof], outputs: [] }
    assert.ok(cashu.savePersistedCashuWallet(wallet))
    const reserved = { ...wallet, updatedAt: 10, pendingLightningMelt: pending, lastLightningMeltId: tx.id }
    assert.ok(cashu.savePersistedCashuWallet(reserved, {
      expectedPendingId: null, expectedUpdatedAt: undefined,
    }))
    assert.equal(cashu.savePersistedCashuWallet(wallet), false)
    assert.deepEqual(cashu.loadPersistedCashuWallet().pendingLightningMelt, pending)
    assert.ok(cashu.savePersistedCashuWallet({ ...wallet, updatedAt: 20, lastLightningMeltId: tx.id }, {
      expectedPendingId: tx.id, expectedUpdatedAt: 10,
    }))
    assert.equal(cashu.savePersistedCashuWallet(reserved), false)
    assert.equal(cashu.savePersistedCashuWallet({ ...wallet, updatedAt: 30 }), false)
    assert.equal(cashu.loadPersistedCashuWallet().pendingLightningMelt, undefined)
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: oldStorage })
  }
})
