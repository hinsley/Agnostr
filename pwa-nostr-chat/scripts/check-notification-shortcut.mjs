import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldOfferNotificationOptions as visible } from '../src/lib/notificationShortcut.ts'

const settings = {
  enabled: true, dms: true, agmail: true, agmailCcBcc: true, directPings: true,
  dmCallRinging: true, serverCalls: true, agoraRepliesMentions: true,
  agoraReactionsReposts: true, agoraZaps: true, agoraFollows: true, soundEnabled: true,
  ringtoneEnabled: true, vibrationEnabled: true, showPreviews: true,
  backgroundPushEnabled: true, publicPinnedRoomFallback: false, extensionPushPokes: false,
  serverMessages: 'mentions', geoMessages: 'all',
}
const ready = {
  settings, permission: 'granted', isSupported: true, isIosRequiresInstall: false,
  isPushSupported: true, pushStatus: 'connected', usesExternalPushSigner: false,
  publicPinnedRoomFallbackAvailable: false,
}

test('no shortcut when all applicable alerts are configured, including mentions-only', () => {
  assert.equal(visible(ready), false)
})

test('browser permission states and iOS install are actionable', () => {
  for (const permission of ['default', 'denied']) assert.equal(visible({ ...ready, permission }), true)
  assert.equal(visible({ ...ready, isSupported: false, permission: 'unsupported', isIosRequiresInstall: true }), true)
  assert.equal(visible({ ...ready, isSupported: false, permission: 'unsupported', isPushSupported: false }), false)
})

test('any paused alert category, presentation switch or device setting offers the shortcut', () => {
  for (const [key, value] of Object.entries(settings)) {
    if (value === true) assert.equal(visible({ ...ready, settings: { ...settings, [key]: false } }), true, key)
  }
  for (const key of ['serverMessages', 'geoMessages']) {
    assert.equal(visible({ ...ready, settings: { ...settings, [key]: 'off' } }), true, key)
  }
  assert.equal(visible({ ...ready, pushStatus: 'error' }), true)
})

test('advanced consent controls matter only when applicable, without implying consent', () => {
  assert.equal(visible({ ...ready, usesExternalPushSigner: true }), true)
  assert.equal(visible({ ...ready, usesExternalPushSigner: true, settings: { ...settings, extensionPushPokes: true } }), false)
  assert.equal(visible({ ...ready, publicPinnedRoomFallbackAvailable: true }), true)
  assert.equal(visible({ ...ready, publicPinnedRoomFallbackAvailable: true, settings: { ...settings, publicPinnedRoomFallback: true } }), false)
  assert.equal(visible({ ...ready, isPushSupported: false, pushStatus: 'unsupported' }), false)
})
