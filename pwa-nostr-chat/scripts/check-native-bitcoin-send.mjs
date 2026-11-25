import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'

const vite = await createServer({
  configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, ws: false },
})
try {
  const { createNativeBitcoinSend, nativeBitcoinSendJournalKey } =
    await vite.ssrLoadModule('/src/lib/nativeBitcoinSend.ts')
  const { deriveNativeBtcWallet, broadcastBitcoinRawTx } =
    await vite.ssrLoadModule('/src/lib/bitcoinOnchain.ts')
  // Public BIP84 vector and synthetic previous outputs. No real wallet or network.
  const wallet = deriveNativeBtcWallet({ mnemonic: `${'abandon '.repeat(11)}about` })
  const recipient = deriveNativeBtcWallet({ privateKeyHex: '0'.repeat(63) + '2' })
  assert.equal(wallet.address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')
  const originalInput = { txid: '12'.repeat(32), vout: 0, value: 100_000, confirmed: true }

  function setup() {
    const records = new Map()
    const calls = []
    const locks = new Map()
    const env = {
      getStorage: () => ({
        getItem: (key) => records.get(key) ?? null,
        setItem: (key, value) => records.set(key, value),
      }),
      async lock(name, operation) {
        const previous = locks.get(name) ?? Promise.resolve()
        const run = previous.then(operation, operation)
        locks.set(name, run)
        return run
      },
      fetchUtxos: async () => [originalInput],
      includesTx: async () => false,
      broadcast: async (bytes, txid) => {
        const persisted = JSON.parse(records.get(nativeBitcoinSendJournalKey(wallet.address)))
        assert.equal(persisted.rawTxHex, bytes)
        assert.equal(persisted.txid, txid)
        assert.equal(persisted.acknowledged, false)
        calls.push({ bytes, txid })
        return txid
      },
    }
    return { env, records, calls, create: () => createNativeBitcoinSend(() => wallet, env) }
  }

  await test('review is immutable and no payment occurs before explicit approval', async () => {
    const { create, calls } = setup()
    const sender = create()
    const review = await sender.prepare(recipient.address, 25_000, 4)
    assert(Object.isFrozen(review))
    assert.equal(review.amountSats + review.feeSats + review.changeSats, originalInput.value)
    await assert.rejects(sender.confirm({ ...review }), /Review/)
    assert.equal(calls.length, 0)
    const result = await sender.confirm(review)
    assert.equal(result.feeSats, review.feeSats)
    assert.equal(result.toAddress, review.toAddress)
    assert.equal(calls[0].txid, result.txid)
    await assert.rejects(sender.confirm(review), /Review/)
  })

  await test('after interruption, a new instance retries the exact original signed bytes', async () => {
    const { create, env, calls } = setup()
    const success = env.broadcast
    env.broadcast = async (...args) => {
      await success(...args)
      throw new Error('Acknowledgment not received')
    }
    const sender = create()
    const review = await sender.prepare(recipient.address, 25_000, 4)
    await assert.rejects(sender.confirm(review), /broadcast is unconfirmed/)
    const reloaded = create()
    assert.equal(reloaded.pending(wallet.address)?.txid, calls[0].txid)
    await assert.rejects(reloaded.prepare(recipient.address, 25_000, 5), /existing Bitcoin transaction/)
    env.broadcast = success
    await reloaded.retry(calls[0].txid)
    assert.deepEqual(calls[0], calls[1])
    assert.equal(reloaded.pending(wallet.address)?.acknowledged, true)
    await reloaded.dismiss(calls[0].txid)
    assert.equal(reloaded.pending(wallet.address), null)
  })

  await test('a browser restart after acknowledgment shows a receipt before another send', async () => {
    const { create, calls } = setup()
    const sender = create()
    const review = await sender.prepare(recipient.address, 25_000, 4)
    const sent = await sender.confirm(review)
    const reloaded = create()
    assert.equal(reloaded.pending(wallet.address)?.acknowledged, true)
    await assert.rejects(reloaded.prepare(recipient.address, 25_000, 5), /existing Bitcoin transaction/)
    assert.equal(calls.length, 1)
    await reloaded.dismiss(sent.txid)
    assert.equal(reloaded.pending(wallet.address), null)
  })

  await test('a matching prior broadcast reconciles without another POST', async () => {
    const { create, env, calls } = setup()
    const success = env.broadcast
    env.broadcast = async (...args) => {
      await success(...args)
      throw new Error('Acknowledgment not received')
    }
    const sender = create()
    const review = await sender.prepare(recipient.address, 25_000, 4)
    await assert.rejects(sender.confirm(review), /broadcast is unconfirmed/)
    env.includesTx = async (id, raw) => id === calls[0].txid && raw === calls[0].bytes
    await create().retry(calls[0].txid)
    assert.equal(calls.length, 1)
  })

  await test('storage failure blocks the network request', async () => {
    const { create, env, calls } = setup()
    const get = env.getStorage
    env.getStorage = () => ({ ...get(), setItem: () => { throw new Error('disk full') } })
    const sender = create()
    const review = await sender.prepare(recipient.address, 25_000, 4)
    await assert.rejects(sender.confirm(review), /disk full/)
    assert.equal(calls.length, 0)
  })

  await test('a second tab cannot confirm another stale review', async () => {
    const { create, calls } = setup()
    const a = create()
    const b = create()
    const [first, second] = await Promise.all([
      a.prepare(recipient.address, 25_000, 4), b.prepare(recipient.address, 25_000, 4),
    ])
    const [accepted, denied] = await Promise.allSettled([a.confirm(first), b.confirm(second)])
    assert.equal(accepted.status, 'fulfilled')
    assert.equal(denied.status, 'rejected')
    assert.match(denied.reason.message, /another tab/)
    assert.equal(calls.length, 1)
  })

  await test('changed wallet or prevout invalidates an existing review', async () => {
    const { env, calls } = setup()
    let keys = wallet
    const sender = createNativeBitcoinSend(() => keys, env)
    const review = await sender.prepare(recipient.address, 25_000, 4)
    keys = recipient
    await assert.rejects(sender.confirm(review), /wallet changed/)
    keys = wallet
    const fresh = await sender.prepare(recipient.address, 25_000, 4)
    env.fetchUtxos = async () => [{ ...originalInput, value: 99_999 }]
    await assert.rejects(sender.confirm(fresh), /inputs changed/)
    assert.equal(calls.length, 0)
  })

  await test('explorer success must report the locally computed transaction ID', async (t) => {
    const { create, calls } = setup()
    const controller = create()
    await controller.confirm(await controller.prepare(recipient.address, 25_000, 4))
    const signed = calls[0]
    const bodies = []
    t.mock.method(globalThis, 'fetch', async (_, req) => {
      bodies.push(req.body)
      return new Response('ff'.repeat(32), { status: 200 })
    })
    await assert.rejects(broadcastBitcoinRawTx(signed.bytes, signed.txid), /unexpected transaction ID/)
    assert.deepEqual(bodies, [signed.bytes, signed.bytes])
  })
} finally {
  await vite.close()
}
