import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/sw.ts', import.meta.url))],
  bundle: true,
  format: 'iife',
  write: false,
  plugins: [{
    name: 'workbox-route-stub',
    setup(builder) {
      builder.onResolve({ filter: /^workbox-/ }, ({ path }) => ({ path, namespace: 'test-workbox' }))
      builder.onLoad({ filter: /.*/, namespace: 'test-workbox' }, () => ({
        contents: `
          export class CacheableResponsePlugin {}
          export class ExpirationPlugin {}
          export class NavigationRoute {}
          export class CacheFirst {}
          export function cleanupOutdatedCaches() {}
          export function createHandlerBoundToURL() {}
          export function precacheAndRoute() {}
          export function registerRoute() {}
        `,
      }))
    },
  }],
})

const scope = 'https://app.test/agnostr/'
const recipientPubkey = 'a'.repeat(64)
const deliveryEventId = 'b'.repeat(64)
const testId = 'cd'.repeat(16)
const dm = {
  title: 'New DM',
  body: 'encrypted preview',
  tag: 'test-room-tag',
  data: { category: 'dm', recipientPubkey, deliveryEventId },
}
const testPush = {
  title: 'Agnostr Test Push',
  body: 'test',
  forceShow: true,
  data: { category: 'test', recipientPubkey, testId },
}

function worker({ hasWindow = true, existing = [], show, findWindows, findNotifications } = {}) {
  const listeners = new Map()
  const notifications = []
  const messages = []
  const outsideMessages = []
  const warnings = []
  const inScope = {
    url: scope,
    visibilityState: 'visible',
    focused: true,
    postMessage: (msg) => messages.push({ ...msg }),
  }
  const sibling = {
    ...inScope,
    url: 'https://app.test/other-page/',
    postMessage: (msg) => outsideMessages.push({ ...msg }),
  }
  const self = {
    __WB_MANIFEST: [],
    addEventListener: (kind, onEvent) => listeners.set(kind, onEvent),
    navigator: {},
    clients: {
      matchAll: findWindows ?? (async () => hasWindow ? [inScope, sibling] : []),
    },
    registration: {
      scope,
      getNotifications: findNotifications ?? (async () => existing),
      showNotification: async (title, options) => {
        notifications.push({ title, options })
        await show?.(title, options)
      },
    },
  }
  runInNewContext(bundle.outputFiles[0].text, {
    self, URL, setTimeout, clearTimeout, Error, console: { warn: (...args) => warnings.push(args) },
  })
  function emit(type, data) {
    let pending
    listeners.get(type)({ data, waitUntil: (promise) => { pending = promise } })
    assert.ok(pending, `the ${type} handler must keep itself alive`)
    return pending
  }
  return {
    push: (payload) => emit('push', { json: () => payload }),
    malformed: () => emit('push', { json: () => { throw Error('unreadable') } }),
    rotate: () => emit('pushsubscriptionchange'),
    notifications, messages, outsideMessages, warnings,
  }
}

test('focused window is not proof of notification display', async () => {
  const sw = worker()
  await sw.push(dm)
  assert.equal(sw.notifications.length, 1)
  assert.equal(sw.notifications[0].options.renotify, true)
  assert.equal(sw.messages.length, 1)
  assert.equal(sw.messages[0].type, 'agnostr-profile-push')
  assert.equal('body' in sw.messages[0], false)
  assert.equal(sw.outsideMessages.length, 0)
})

test('an exact displayed event can be replaced without a second alert', async () => {
  const sw = worker({ existing: [{
    title: 'Already displayed',
    body: 'existing body',
    tag: 'local-event-tag',
    data: { ...dm.data, peerPubkey: 'f'.repeat(64) },
  }] })
  await sw.push(dm)
  const [{ title, options }] = sw.notifications
  assert.equal(title, 'Already displayed')
  assert.equal(options.tag, 'local-event-tag')
  assert.equal(options.body, 'existing body')
  assert.equal(options.renotify, false)
  assert.equal(options.silent, true)
  assert.equal(options.vibrate, undefined)
  assert.equal(options.data.tag, options.tag)
  assert.equal(options.data.peerPubkey, 'f'.repeat(64))
})

test('neither a room tag nor another profile proves an exact match', async () => {
  for (const data of [
    { ...dm.data, deliveryEventId: 'd'.repeat(64) },
    { ...dm.data, recipientPubkey: 'e'.repeat(64) },
    { ...dm.data, deliveryEventId: undefined },
    { ...dm.data, category: 'agmail' },
  ]) {
    const sw = worker({ existing: [{ title: 'Previous', tag: dm.tag, data }] })
    await sw.push(dm)
    assert.equal(sw.notifications[0].title, dm.title)
    assert.equal(sw.notifications[0].options.renotify, true)
  }
})

test('closed app and unavailable app-window discovery still show native notifications', async () => {
  for (const setup of [
    { hasWindow: false },
    { findWindows: async () => { throw Error('unavailable') } },
    { findWindows: () => new Promise(() => {}) },
  ]) {
    const sw = worker(setup)
    await sw.push(dm)
    assert.equal(sw.notifications.length, 1)
    assert.equal(sw.messages.length, 0)
  }
})

test('notification lookup failure or timeout never suppresses native display', async () => {
  for (const findNotifications of [
    async () => { throw Error('unavailable') },
    () => new Promise(() => {}),
  ]) {
    const sw = worker({ findNotifications })
    await sw.push(dm)
    assert.equal(sw.notifications.length, 1)
    assert.equal(sw.notifications[0].options.renotify, true)
  }
})

test('native API rejecting optional presentation hints falls back without losing routing', async () => {
  const sw = worker({ show: (_title, options) => {
    if (options.actions || options.icon) throw Error('unsupported options')
  } })
  await sw.push({
    title: 'Incoming call',
    data: { category: 'dm-call', recipientPubkey, callId: 'call-id' },
  })
  assert.equal(sw.notifications.length, 2)
  assert.equal(sw.notifications[1].options.data.callId, 'call-id')
  assert.equal(sw.notifications[1].options.tag, 'agnostr-call-call-id')
  assert.ok(sw.messages.some((msg) => msg.type === 'agnostr-incoming-call-ring'))
})

test('forced test receipt arrives only after display, not for other pages in the origin', async () => {
  let allowDisplay
  const nativeDisplay = new Promise((resolve) => { allowDisplay = resolve })
  const sw = worker({ show: () => nativeDisplay })
  const pending = sw.push(testPush)
  await setImmediate()
  assert.equal(sw.notifications.length, 1)
  assert.equal(sw.notifications[0].options.tag, `agnostr-test-${testId}`)
  assert.equal(sw.messages.length, 0)
  allowDisplay()
  await pending
  assert.deepEqual(sw.messages, [{ type: 'agnostr:push-test-receipt', testId, displayed: true }])
  assert.equal(sw.outsideMessages.length, 0)
})

test('a failed native test and retry yield a negative receipt without content', async () => {
  const sw = worker({ show: () => {
    const err = new Error('private provider response not for telemetry')
    err.name = 'NotAllowedError'
    throw err
  } })
  await sw.push(testPush)
  assert.equal(sw.notifications.length, 2)
  assert.deepEqual(sw.messages, [{
    type: 'agnostr:push-test-receipt', testId, displayed: false,
    error: 'notification-permission-denied',
  }])
  assert.equal(sw.warnings.length, 1)
  assert.doesNotMatch(JSON.stringify(sw.warnings), /private|encrypted|endpoint/)
})

test('untrusted or malformed test correlation IDs never yield receipts', async () => {
  const sw = worker()
  await sw.push({ ...testPush, data: { ...testPush.data, testId: 'short' } })
  await sw.push({ ...testPush, data: { ...dm.data, testId } })
  assert.equal(sw.notifications.length, 2)
  assert.ok(sw.messages.every((msg) => msg.type !== 'agnostr:push-test-receipt'))
})

test('subscription rotation emits only reconciliation signal to app windows', async () => {
  const sw = worker()
  await sw.rotate()
  assert.deepEqual(sw.messages, [{ type: 'agnostr:push-subscription-changed' }])
  assert.equal(sw.outsideMessages.length, 0)
  assert.equal(sw.notifications.length, 0)
})

test('unreadable payloads and optional non-string fields get safe fallback display', async () => {
  const sw = worker()
  await sw.push(null)
  await sw.malformed()
  await sw.push({ data: { category: {}, peerPubkey: 42, serverId: { id: 'ignored' } } })
  assert.equal(sw.notifications.length, 3)
  assert.ok(sw.notifications.every(({ title }) => title === 'Agnostr'))
})

test('the foreground notification path does not re-alert after an exact push was displayed', async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/lib/notifications.ts', import.meta.url))],
    bundle: true,
    format: 'cjs',
    write: false,
    plugins: [{
      name: 'foreground-browser-stubs',
      setup(builder) {
        builder.onResolve({ filter: /^(\.\.\/hooks\/usePwa|\.\/identity)\.ts$/ }, ({ path }) => ({
          path,
          namespace: 'window-stubs',
        }))
        builder.onLoad({ filter: /.*/, namespace: 'window-stubs' }, () => ({
          contents: `
            export function getPwaSwRegistration() { return Promise.resolve(globalThis.appRegistration) }
            export function bytesToHex() { throw new Error('not used by this test') }
          `,
        }))
      },
    }],
  })
  const module = { exports: {} }
  const appRegistration = {
    getNotifications: async () => [{ title: 'Previously displayed', tag: 'old-room-tag', data: dm.data }],
    showNotificationCalls: 0,
    async showNotification() { this.showNotificationCalls += 1 },
  }
  runInNewContext(result.outputFiles[0].text, {
    module,
    exports: module.exports,
    window: {},
    Notification: { permission: 'granted' },
    TextEncoder,
    TextDecoder,
    URL,
    setTimeout,
    clearTimeout,
    appRegistration,
  })
  const { showOsNotification } = module.exports
  assert.equal(await showOsNotification(dm), true)
  assert.equal(appRegistration.showNotificationCalls, 0)
  assert.equal(await showOsNotification({
    ...dm,
    data: { ...dm.data, recipientPubkey: '2'.repeat(64) },
  }), true)
  assert.equal(appRegistration.showNotificationCalls, 1)
})

test('call cancellation replaces the ring without leaving a silent-only push', async () => {
  const sw = worker()
  await sw.push({
    action: 'call-cancel',
    callId: 'test-call',
    data: { category: 'dm-call', recipientPubkey },
  })
  assert.deepEqual(sw.messages.map((message) => message.type), ['agnostr-incoming-call-cancel'])
  assert.equal(sw.outsideMessages.length, 0)
  assert.equal(sw.notifications.length, 1)
  const [{ title, options }] = sw.notifications
  assert.equal(title, 'Call ended')
  assert.equal(options.tag, 'agnostr-call-test-call')
  assert.equal(options.silent, true)
  assert.equal(options.renotify, false)
  assert.equal(options.data.category, 'dm')
  assert.equal(options.data.callId, undefined)
})
