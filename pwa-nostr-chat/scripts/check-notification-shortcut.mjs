import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldOfferNotificationOptions as visible } from '../src/lib/notificationShortcut.ts'

const optionalOff = Object.freeze({
  dms: false, agmail: true, agmailCcBcc: false, directPings: true,
  dmCallRinging: false, serverCalls: false, agoraRepliesMentions: true,
  agoraReactionsReposts: false, agoraZaps: false, agoraFollows: false, soundEnabled: false,
  ringtoneEnabled: false, vibrationEnabled: false, showPreviews: false,
  publicPinnedRoomFallback: false, extensionPushPokes: false,
  serverMessages: 'off', geoMessages: 'off',
})
const settings = Object.freeze({ ...optionalOff, enabled: true, backgroundPushEnabled: true })
const ready = {
  settings, permission: 'granted', isSupported: true, isIosRequiresInstall: false,
  isPushSupported: true, pushStatus: 'connected',
  usesExternalPushSigner: true, publicPinnedRoomFallbackAvailable: true,
}

test('shortcut disappears as background push connects, without enabling optional preferences', () => {
  const on = { ...settings, backgroundPushEnabled: false }
  const states = [
    { ...ready, settings: { ...on, enabled: false }, permission: 'default', pushStatus: 'disconnected' },
    { ...ready, settings: on, pushStatus: 'disconnected' },
    { ...ready, pushStatus: 'connecting' },
    ready,
  ]
  assert.deepEqual(states.map(visible), [true, true, true, false])
  assert.deepEqual(ready.settings, { ...optionalOff, enabled: true, backgroundPushEnabled: true })
})

test('connected takes precedence over a stale permission value', () => {
  assert.equal(visible({ ...ready, permission: 'default' }), false)
  assert.equal(visible({ ...ready, permission: 'denied' }), false)
})

test('shortcut returns if the app or background toggle turns off or the connection fails', () => {
  for (const key of ['enabled', 'backgroundPushEnabled']) {
    assert.equal(visible({ ...ready, settings: { ...settings, [key]: false } }), true)
  }
  for (const pushStatus of ['disconnected', 'connecting', 'error']) {
    assert.equal(visible({ ...ready, pushStatus }), true)
  }
})

test('unsupported push does not leave a dead-end reminder, but install and browser permission are actionable', () => {
  const unsupported = { ...ready, isPushSupported: false, pushStatus: 'unsupported' }
  assert.equal(visible(unsupported), false)
  for (const permission of ['default', 'denied']) assert.equal(visible({ ...unsupported, permission }), true)
  assert.equal(visible({ ...unsupported, isSupported: false, permission: 'unsupported' }), false)
  assert.equal(visible({ ...unsupported, isSupported: false, permission: 'unsupported', isIosRequiresInstall: true }), true)
})
