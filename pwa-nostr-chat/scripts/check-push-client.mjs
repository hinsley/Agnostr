import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { finalizeEvent, getPublicKey } from 'nostr-tools'
import { createServer } from 'vite'

const privateKey = new Uint8Array(32)
privateKey[31] = 7
const pubkey = getPublicKey(privateKey)
const recipient = 'b'.repeat(64)
const bridgeUrl = 'https://bridge.invalid'
const endpoint = 'https://provider.invalid/current-device'
const health = () => Response.json({ ok: true, service: 'agnostr-push', currentDeviceTest: true })
const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)])
const vapid = key.toString('base64url')
const workers = new EventTarget()
let subscription
const registration = {
  active: {},
  pushManager: {
    async getSubscription() { return subscription },
    async subscribe({ applicationServerKey, userVisibleOnly }) {
      assert.equal(userVisibleOnly, true)
      assert.deepEqual(Buffer.from(applicationServerKey), key)
      subscription = currentSubscription()
      return subscription
    },
  },
}
workers.getRegistration = async () => registration
workers.ready = Promise.resolve(registration)

function currentSubscription(overrides = {}) {
  return {
    endpoint,
    expirationTime: null,
    options: { applicationServerKey: Uint8Array.from(key).buffer },
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'fixture', auth: 'fixture' } } },
    async unsubscribe() { subscription = null; return true },
    ...overrides,
  }
}

let vite
let notifications
let settings
const original = new Map()
function stub(prop, value) {
  original.set(prop, Object.getOwnPropertyDescriptor(globalThis, prop))
  Object.defineProperty(globalThis, prop, { configurable: true, value, writable: true })
}
before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
    plugins: [{
      name: 'offline-pwa-plugin-fixture',
      resolveId: (id) => id === 'virtual:pwa-register' ? '\0mock-pwa-register' : null,
      load: (id) => id === '\0mock-pwa-register' ? 'export const registerSW = () => () => {}' : null,
    }],
  })
  notifications = await vite.ssrLoadModule('/src/lib/notifications.ts')
  settings = (await vite.ssrLoadModule('/src/lib/storage.ts')).DEFAULT_NOTIFICATION_SETTINGS
  stub('navigator', { serviceWorker: workers })
  stub('window', { PushManager: function PushManager() {} })
  stub('Notification', { permission: 'granted' })
  stub('fetch', null)
})
after(async () => {
  for (const [prop, desc] of original) {
    if (desc) Object.defineProperty(globalThis, prop, desc)
    else delete globalThis[prop]
  }
  await vite?.close()
})

function makeSigner() {
  const templates = []
  return { templates, async signEvent(template) {
    templates.push(template)
    return finalizeEvent(template, privateKey)
  } }
}

function testReceipt(testId, displayed) {
  workers.dispatchEvent(new MessageEvent('message', {
    data: { type: 'agnostr:push-test-receipt', testId, displayed },
  }))
}

test('test targets actual local subscription and catches a receipt before HTTP returns', async () => {
  subscription = currentSubscription()
  const signer = makeSigner()
  globalThis.fetch = async (url, init) => {
    if (url === bridgeUrl + '/health') return health()
    assert.equal(url, bridgeUrl + '/test-push')
    assert.match(init.headers.Authorization, /^Nostr /)
    const body = JSON.parse(init.body)
    assert.equal(body.endpoint, endpoint)
    assert.equal(body.pubkey, pubkey)
    assert.match(body.testId, /^[0-9a-f]{32}$/)
    testReceipt('0'.repeat(32), false)
    testReceipt(body.testId, true)
    return Response.json({ ok: true, accepted: true, testId: body.testId })
  }
  const result = await notifications.sendTestWebPush({ bridgeUrl, pubkey, signEvent: signer.signEvent })
  assert.equal(result.ok, true)
  assert.equal(result.delivered, 1)
  assert.equal(signer.templates.length, 1)
})

test('provider acceptance and another device’s result do not establish display', async () => {
  subscription = currentSubscription()
  globalThis.fetch = async (url, init) => {
    if (url === bridgeUrl + '/health') return health()
    const body = JSON.parse(init.body)
    return Response.json({ ok: true, accepted: true, testId: body.testId })
  }
  const result = await notifications.sendTestWebPush({
    bridgeUrl, pubkey, signEvent: makeSigner().signEvent, receiptTimeoutMs: 5,
  })
  assert.equal(result.ok, false)
  assert.match(result.detail, /accepted.*did not confirm display/i)
  globalThis.fetch = async (url) => {
    assert.equal(url, bridgeUrl + '/health', 'must not send a test to a legacy bridge')
    return Response.json({ ok: true, service: 'agnostr-push', version: 1 })
  }
  const legacy = await notifications.sendTestWebPush({
    bridgeUrl, pubkey, signEvent: makeSigner().signEvent, receiptTimeoutMs: 5,
  })
  assert.equal(legacy.ok, false)
})

test('failed display is distinguishable from provider rejection', async () => {
  subscription = currentSubscription()
  globalThis.fetch = async (url, init) => {
    if (url === bridgeUrl + '/health') return health()
    const { testId } = JSON.parse(init.body)
    testReceipt(testId, false)
    return Response.json({ ok: true, accepted: true, testId })
  }
  const result = await notifications.sendTestWebPush({
    bridgeUrl, pubkey, signEvent: makeSigner().signEvent, receiptTimeoutMs: 5,
  })
  assert.equal(result.ok, false)
  assert.match(result.detail, /reached this device.*could not display/i)
})

test('an expired subscription is replaced and registered with the confirmed bridge', async () => {
  let unsubscribed = false
  subscription = currentSubscription({
    endpoint: 'https://provider.invalid/stale-device',
    expirationTime: Date.now() - 1,
    async unsubscribe() { unsubscribed = true; subscription = null; return true },
  })
  assert.equal(await notifications.readCurrentPushEndpoint(), null)
  globalThis.fetch = async (url, init) => {
    assert.equal(url, bridgeUrl + '/subscribe')
    const body = JSON.parse(init.body)
    assert.equal(body.pubkey, pubkey)
    assert.equal(body.subscription.endpoint, endpoint)
    return Response.json({ ok: true })
  }
  const result = await notifications.registerWithPushBridge({
    bridgeUrl, vapidPublicKey: vapid, pubkey, relays: [], geohashes: [], serverIds: [],
    settings, signEvent: makeSigner().signEvent,
  })
  assert.equal(unsubscribed, true)
  assert.equal(result.endpoint, endpoint)
})

test('poke retries transient responses and reuses one signed immutable request', async () => {
  const signer = makeSigner()
  const calls = []
  globalThis.fetch = async (url, init) => {
    assert.equal(url, bridgeUrl + '/poke')
    calls.push(init)
    return calls.length === 1
      ? Response.json({ ok: false }, { status: 503 })
      : Response.json({ ok: true, queued: 1, delivered: 0 })
  }
  const result = await notifications.sendPushPoke({
    bridgeUrl, signEvent: signer.signEvent, retryDelaysMs: [0],
    payload: { recipientPubkeys: [recipient], category: 'dm' },
  })
  assert.equal(result.kind, 'accepted')
  assert.equal(signer.templates.length, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].body, calls[1].body)
  assert.equal(calls[0].headers.Authorization, calls[1].headers.Authorization)
  assert.match(JSON.parse(calls[0].body).eventId, /^[0-9a-f]{32}$/)
})

test('poke does not retry authorization rejection or an opted-out recipient', async () => {
  let attempts = 0
  const call = () => notifications.sendPushPoke({
    bridgeUrl, signEvent: makeSigner().signEvent, retryDelaysMs: [0, 0],
    payload: { recipientPubkeys: [recipient], category: 'dm-call' },
  })
  globalThis.fetch = async () => { attempts++; return Response.json({ ok: false }, { status: 401 }) }
  assert.equal((await call()).kind, 'failed')
  globalThis.fetch = async () => { attempts++; return Response.json({ ok: true, skipped: 1 }) }
  assert.equal((await call()).kind, 'skipped')
  assert.equal(attempts, 2)
})


test('public room fallback is opt-in and does not sync private filters', async () => {
  assert.equal(settings.publicPinnedRoomFallback, false)
  const allowed = {
    canAutoSign: true, geoMessages: 'all', hasBlockedPeers: false,
    strictWhitelistMode: false, pinnedGeohashes: ['topic:gardening', '9q8'],
  }
  const eligible = notifications.canUsePublicPinnedRoomFallback
  assert.equal(eligible(allowed), true)
  assert.equal(eligible({ ...allowed, canAutoSign: false }), false)
  assert.equal(eligible({ ...allowed, geoMessages: 'mentions' }), false)
  assert.equal(eligible({ ...allowed, hasBlockedPeers: true }), false)
  assert.equal(eligible({ ...allowed, strictWhitelistMode: true }), false)
  assert.equal(eligible({ ...allowed, pinnedGeohashes: ['private:never-upload'] }), false)

  subscription = currentSubscription()
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    assert.equal(body.publicPinnedRoomFallback, true)
    assert.deepEqual(body.geohashes, ['topic:gardening', '9q8'])
    assert.equal('blockedPeers' in body, false)
    assert.equal('strictWhitelistMode' in body, false)
    return Response.json({ ok: true })
  }
  await notifications.registerWithPushBridge({
    bridgeUrl, vapidPublicKey: vapid, pubkey, relays: [],
    geohashes: ['topic:gardening', '9q8', 'private:never-upload'],
    serverIds: [], settings: { ...settings, geoMessages: 'all', publicPinnedRoomFallback: true },
    publicPinnedRoomFallback: true,
    signEvent: makeSigner().signEvent,
  })
})
