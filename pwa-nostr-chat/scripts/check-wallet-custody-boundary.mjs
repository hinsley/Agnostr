import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { finalizeEvent, getPublicKey } from 'nostr-tools'
import { createServer } from 'vite'

let vite
let sync
let restore
let cashu

before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  })
  sync = await vite.ssrLoadModule('/src/lib/deviceSync.ts')
  restore = await vite.ssrLoadModule('/src/lib/walletRestoreIdentity.ts')
  cashu = await vite.ssrLoadModule('/src/lib/cashuWallet.ts')
})

after(async () => vite?.close())

const testKey = (n) => n.toString(16).padStart(64, '0')
const socialKey = Uint8Array.from(Buffer.from(testKey(11), 'hex'))
const material = { mode: 'local', secretKey: socialKey, pubkey: getPublicKey(socialKey) }
const legacyWallet = {
  updatedAt: 1,
  fingerprint: 'test-fingerprint',
  hash: 'test-hash',
  payload: { privateKeyHex: 'synthetic-fixture-not-a-key', bearerProofs: ['test-proof'] },
}

test('checkpoint signing, sibling-state signing and inbound sanitization strip wallet data', async () => {
  const state = {
    ...sync.createEmptyCrdtState(),
    nickname: { value: 'Fixture', updatedAt: 1 },
    wallet: legacyWallet,
  }
  const checkpoint = await sync.buildSignedDeviceSyncCheckpointEvent(state, material)
  assert.ok(checkpoint)
  assert.equal('wallet' in JSON.parse(await sync.decryptSelfPayload(checkpoint.content, material)), false)

  const input = {
    v: 1, type: 'sync-state', deviceId: 'test-device', deviceLabel: 'Test',
    nickname: 'Test', ts: Date.now(), state,
  }
  const ephemeral = await sync.buildSignedDeviceSyncEphemeralEvent(input, material)
  assert.ok(ephemeral)
  assert.equal('wallet' in JSON.parse(await sync.decryptSelfPayload(ephemeral.content, material)).state, false)

  const signedLegacy = async (template, payload) =>
    finalizeEvent(
      {
        created_at: template.created_at,
        kind: template.kind,
        tags: template.tags,
        content: await sync.encryptSelfPayload(JSON.stringify(payload), material),
      },
      socialKey
    )
  const receivedCheckpoint = await sync.parseDeviceSyncCheckpointEvent(
    await signedLegacy(checkpoint, state), material
  )
  assert.ok(receivedCheckpoint)
  assert.equal('wallet' in receivedCheckpoint, false)
  assert.deepEqual(receivedCheckpoint.nickname, state.nickname)
  const receivedSibling = await sync.parseDeviceSyncEphemeralEvent(
    await signedLegacy(ephemeral, input), material
  )
  assert.equal(receivedSibling?.type, 'sync-state')
  assert.equal('wallet' in receivedSibling.state, false)

  const chunk = {
    v: 1, type: 'sync-wallet-chunk', deviceId: 'test-device', targetDeviceId: 'other-device',
    ts: Date.now(), transferId: 'test', chunkIndex: 0, totalChunks: 1,
    fingerprint: legacyWallet.fingerprint, hash: legacyWallet.hash,
    data: JSON.stringify(legacyWallet.payload),
  }
  assert.equal(await sync.buildSignedDeviceSyncEphemeralEvent(chunk, material), null)
  assert.equal(await sync.parseDeviceSyncEphemeralEvent(await signedLegacy(ephemeral, chunk), material), null)
})

test('different wallet is refused; same account and a new local restore retain their keys', () => {
  const existing = { privateKeyHex: testKey(1) }
  assert.throws(
    () => restore.selectWalletRestoreCredentials(existing, { privateKeyHex: testKey(2) }),
    /another Agwallet/
  )
  assert.strictEqual(restore.selectWalletRestoreCredentials(existing, existing), existing)
  assert.strictEqual(restore.selectWalletRestoreCredentials(existing, {}), existing)
  assert.equal(restore.selectWalletRestoreCredentials({}, existing).privateKeyHex, existing.privateKeyHex)
  assert.equal(existing.privateKeyHex, testKey(1))
})

test('backup cannot fall back to unrelated proofs-only restore when credential validation fails', () => {
  assert.throws(
    () => cashu.parseWalletBackupJson(JSON.stringify({ proofsByMint: {}, privateKeyHex: testKey(0) })),
    /invalid wallet private key/
  )
  const phrase = 'abandon '.repeat(11) + 'about'
  const seedBackup = cashu.parseWalletBackupJson(JSON.stringify({ mnemonic: phrase }))
  assert.throws(
    () => restore.selectWalletRestoreCredentials(seedBackup, { privateKeyHex: seedBackup.privateKeyHex }),
    /another Agwallet/
  )
  assert.throws(
    () => restore.selectWalletRestoreCredentials(seedBackup, { mnemonic: phrase, privateKeyHex: testKey(2) }),
    /another Agwallet/
  )
  assert.strictEqual(restore.selectWalletRestoreCredentials(seedBackup, { mnemonic: phrase }), seedBackup)
})

test('wallet import entry point never overwrites the saved account', async () => {
  const { createElement } = await import('react')
  const { renderToString } = await import('react-dom/server')
  const { useCashuWallet } = await vite.ssrLoadModule('/src/hooks/useCashuWallet.ts')
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const stored = new Map()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (id) => stored.get(id) ?? null,
      setItem: (id, value) => stored.set(id, value),
      removeItem: (id) => stored.delete(id),
    },
  })
  try {
    const oldWallet = {
      ...cashu.createEmptyWalletState(),
      initialized: true,
      privateKeyHex: testKey(1),
      history: [{ id: 'original-test-record', createdAt: 1 }],
    }
    const walletKey = cashu.CASHU_WALLET_STORAGE_KEY
    stored.set(walletKey, JSON.stringify(oldWallet))
    let wallet
    function WalletHarness() {
      wallet = useCashuWallet()
      return null
    }
    renderToString(createElement(WalletHarness))

    const beforeImport = stored.get(walletKey)
    await assert.rejects(
      wallet.importBackupJson(JSON.stringify({ privateKeyHex: testKey(2), proofsByMint: {} })),
      /another Agwallet/
    )
    await assert.rejects(
      wallet.importWalletKeyOrSeed(testKey(2), { scanMints: false }),
      /another Agwallet/
    )
    assert.equal(stored.get(walletKey), beforeImport)
    await wallet.importWalletKeyOrSeed(testKey(1), { scanMints: false })
    assert.equal(stored.get(walletKey), beforeImport)
    await wallet.importBackupJson(JSON.stringify({ privateKeyHex: testKey(1), proofsByMint: {} }))
    const persisted = JSON.parse(stored.get(walletKey))
    assert.equal(persisted.privateKeyHex, oldWallet.privateKeyHex)
    assert.deepEqual(persisted.history, oldWallet.history)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  }
})

test('credential migration verifies recovery, preserves balances, and blocks restored keys from stale or unlocked saves', async () => {
  const { createElement } = await import('react')
  const { renderToString } = await import('react-dom/server')
  const { useCashuWallet } = await vite.ssrLoadModule('/src/hooks/useCashuWallet.ts')
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const stored = new Map()
  let writeDenied = false
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() { return stored.size },
      key: (index) => Array.from(stored.keys())[index] ?? null,
      getItem: (id) => stored.get(id) ?? null,
      setItem: (id, value) => {
        if (writeDenied) throw new Error('fixture storage quota')
        stored.set(id, value)
      },
      removeItem: (id) => stored.delete(id),
    },
  })
  try {
    const walletKey = cashu.CASHU_WALLET_STORAGE_KEY
    const credentials = { privateKeyHex: testKey(1) }
    const original = {
      ...cashu.createEmptyWalletState(),
      initialized: true,
      ...credentials,
      history: [{ id: 'fixture-history', createdAt: 50 }],
      keysetCounters: { demo: 6 },
    }
    stored.set(walletKey, JSON.stringify(original))
    stored.set('agnostr:v3:active_profile_id', '2'.repeat(64))
    let wallet
    function WalletHarness() {
      wallet = useCashuWallet()
      return null
    }
    renderToString(createElement(WalletHarness))

    const passphrase = 'synthetic wallet password used by tests only'
    await assert.rejects(wallet.protectWalletCredentials(passphrase, false), /offline wallet backup/)
    assert.deepEqual(JSON.parse(stored.get(walletKey)), original)
    writeDenied = true
    await assert.rejects(wallet.protectWalletCredentials(passphrase, true), /Could not replace/)
    assert.deepEqual(JSON.parse(stored.get(walletKey)), original)
    writeDenied = false
    assert.equal((await wallet.protectWalletCredentials(passphrase, true)).snapshotVerified, true)
    const protectedDisk = JSON.parse(stored.get(walletKey))
    assert.deepEqual(protectedDisk.history, original.history)
    assert.deepEqual(protectedDisk.proofsByMint, original.proofsByMint)
    assert.deepEqual(protectedDisk.keysetCounters, original.keysetCounters)
    assert.equal('privateKeyHex' in protectedDisk, false)
    assert.equal(cashu.savePersistedCashuWallet(original), false)
    assert.equal(cashu.savePersistedCashuWallet({ ...protectedDisk, ...credentials }), true)
    assert.equal('privateKeyHex' in JSON.parse(stored.get(walletKey)), false)
    assert.throws(() => wallet.exportBackupJson(), /Unlock Agwallet/)
    assert.throws(() => wallet.createNewWallet(), /Unlock Agwallet/)
    assert.throws(() => wallet.resetAll(), /Unlock Agwallet/)

    // A newly loaded tab starts locked and cannot decrypt with the wrong passphrase.
    renderToString(createElement(WalletHarness))
    assert.equal(wallet.initialized, true)
    assert.equal(wallet.credentialsLocked, true)
    assert.equal(wallet.privateKeyHex, null)
    await assert.rejects(wallet.unlockWalletCredentials('wrong fixture passphrase'), /passphrase was incorrect/)
    await wallet.unlockWalletCredentials(passphrase)
    assert.equal(JSON.parse(wallet.exportBackupJson()).privateKeyHex, credentials.privateKeyHex)
    const unlockedDisk = JSON.parse(stored.get(walletKey))
    assert.ok(unlockedDisk.encryptedCredentials)
    assert.equal('privateKeyHex' in unlockedDisk, false)
    wallet.lockWalletCredentials()
    assert.throws(() => wallet.exportBackupJson(), /Unlock Agwallet/)

    // A malformed envelope is still locked, never a signal to generate replacement keys.
    stored.set(walletKey, JSON.stringify({ ...protectedDisk, encryptedCredentials: null }))
    renderToString(createElement(WalletHarness))
    assert.equal(wallet.initialized, true)
    assert.equal(wallet.credentialsLocked, true)
    assert.throws(() => wallet.createNewWallet(), /Unlock Agwallet/)
    await assert.rejects(wallet.unlockWalletCredentials(passphrase), /Encrypted wallet data is invalid/)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  }
})
