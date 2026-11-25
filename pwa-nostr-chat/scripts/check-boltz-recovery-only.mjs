import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createServer } from 'vite'

test('the wallet rejects both new Boltz swaps without network I/O and keeps failed-swap recovery', async () => {
  const vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  })
  const beforeStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const beforeFetch = globalThis.fetch
  const entries = new Map()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, data) => entries.set(key, data),
      removeItem: (key) => entries.delete(key),
    },
  })
  try {
    const boltz = await vite.ssrLoadModule('/src/lib/boltzSwap.ts')
    const { useCashuWallet } = await vite.ssrLoadModule('/src/hooks/useCashuWallet.ts')
    let requests = 0
    globalThis.fetch = async () => {
      requests++
      throw new Error('The offline test must never call an external service')
    }
    const recoveryKey = 'synthetic-legacy-recovery-key'
    entries.set(boltz.BOLTZ_SWAPS_STORAGE_KEY, JSON.stringify([{
      id: 'expired-test-swap',
      direction: 'submarine',
      status: 'swap.expired',
      address: 'synthetic-address',
      apiUrl: boltz.DEFAULT_BOLTZ_API_URL,
      amountSats: 20000,
      expectedOnchainSats: 21000,
      feeSats: 1000,
      localKeyPrivateHex: recoveryKey,
      localKeyPublicHex: 'synthetic-recovery-public-key',
      timeoutBlockHeight: 100,
      invoice: 'synthetic-invoice',
      mintUrl: 'https://example.invalid',
    }]))

    let wallet
    function WalletHarness() {
      wallet = useCashuWallet()
      return null
    }
    renderToString(createElement(WalletHarness))
    await assert.rejects(wallet.createOnchainReceiveSwap(20000), /New Boltz swaps are paused/)
    await assert.rejects(wallet.createOnchainSendSwap('fixture', 20000), /New Boltz swaps are paused/)
    assert.equal(requests, 0)
    const recovery = JSON.parse(wallet.exportBoltzSwapRescueJson('expired-test-swap'))
    assert.equal(recovery.refundPrivateKey, recoveryKey)
    assert.equal(recovery.status, 'swap.expired')
    assert.equal(recovery.timeoutBlockHeight, 100)
  } finally {
    globalThis.fetch = beforeFetch
    if (beforeStorage) Object.defineProperty(globalThis, 'localStorage', beforeStorage)
    else delete globalThis.localStorage
    await vite.close()
  }
})
