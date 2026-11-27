import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
import { makeNearbyRuntime } from '../src/lib/nearby/nearbyRuntime.ts'

function radioPair(mtu) {
  let connected = false
  function device(id) {
    const listeners = { state: new Set(), frame: new Set() }
    const local = { id, active: false, other: null,
      emit(kind, body) { for (const listener of listeners[kind]) listener(body) },
      announceState() { this.emit('state', { active: this.active, links: this.active && this.other.active && connected ? [{ id: this.other.id, maxBytes: mtu }] : [] }) },
      async capabilities() { return { supported: true } },
      async start() { this.active = true; this.announceState(); this.other.announceState() },
      async stop() { this.active = false; this.announceState(); this.other.announceState() },
      async addListener(kind, listener) { listeners[kind].add(listener); return { async remove() { listeners[kind].delete(listener) } } },
      async send({ link, frames }) {
        if (!connected || !this.active || !this.other.active || link !== this.other.id) return { accepted: false }
        assert.ok(frames.every(frame => Buffer.from(frame, 'base64').length <= mtu))
        setImmediate(() => { for (const wire of frames) this.other.emit('frame', { link: this.id, wire }) })
        return { accepted: true }
      },
    }
    return local
  }
  const a = device('left'), b = device('right')
  a.other = b; b.other = a
  return { a, b, connect() { connected = true; a.announceState(); b.announceState() } }
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate) }

test('two radio nodes: opt-in geohash uplink, no relay echo, verified downlink, and local-only room', async () => {
  const gh = 'djuq'
  const radios = radioPair(120)
  const published = [], receivedOffline = [], receivedOnline = []
  let aState, bState
  const offline = makeNearbyRuntime({
    selectedGeohash: () => gh,
    snapshot: s => { aState = s },
    publish: async () => { assert.fail('offline peer does not publish to relays') },
    receive: event => receivedOffline.push(event),
  }, radios.a)
  const online = makeNearbyRuntime({
    selectedGeohash: () => gh,
    snapshot: s => { bState = s },
    publish: async (event, geohash) => { assert.equal(geohash, gh); published.push(event); return true },
    receive: event => receivedOnline.push(event),
  }, radios.b)
  try {
    await flush()
    await offline.start('Carter')
    await online.start('Online')
    radios.connect()
    await flush()
    assert.ok(aState.peers.some(p => p.name === 'Online'))
    assert.ok(bState.peers.some(p => p.name === 'Carter'))
    assert.equal(offline.hasGateway(), false)
    online.share(true)
    await flush()
    assert.equal(offline.hasGateway(), true)
    const tmpl = { kind: 20000, created_at: Math.floor(Date.now() / 1000), content: 'offline to relay', tags: [['g', gh], ['n', 'Carter']] }
    const out = offline.offlineEvent(tmpl, gh)
    assert.equal(await offline.sendThroughGateway(out, gh), true)
    await flush()
    assert.deepEqual(published.map(e => e.id), [out.id])
    assert.deepEqual(receivedOnline.map(e => e.id), [out.id])
    online.relayEvent(out, gh)
    const response = finalizeEvent({ ...tmpl, content: 'relay back to offline' }, generateSecretKey())
    online.relayEvent(response, gh)
    await flush()
    assert.deepEqual(receivedOffline.map(e => e.id), [response.id])
    assert.equal(await offline.sendMesh('this stays local'), true)
    await flush()
    assert.equal(bState.messages.at(-1).body, 'this stays local')
    assert.equal(published.length, 1)
    online.share(false)
    await flush()
    assert.equal(offline.hasGateway(), false)
  } finally { offline.close(); online.close() }
})

test('Android device switch starts Mesh plus gateway, does not advertise while offline, and resumes without prompting', async () => {
  const radios = radioPair(120)
  const requests = []
  const startRadio = radios.a.start
  radios.a.start = async options => { requests.push(options.requestPermission); return startRadio.call(radios.a) }
  let ready = false, hasInternet = false, enabled = true
  radios.a.capabilities = async () => ({ supported: true, ready, error: ready ? undefined : 'Radio off' })
  let snapshot
  const android = makeNearbyRuntime({
    selectedGeohash: () => 'djuq', canBridge: () => hasInternet,
    snapshot: value => { snapshot = value }, publish: async () => true, receive() {},
  }, radios.a)
  const peer = makeNearbyRuntime({
    selectedGeohash: () => 'djuq', snapshot() {}, publish: async () => false, receive() {},
  }, radios.b)
  try {
    await flush()
    await android.resume('Android', () => enabled)
    assert.deepEqual(requests, [])
    assert.equal(snapshot.error, 'Radio off')
    ready = true
    await android.start('Android', { managed: true, requestPermission: true })
    await peer.start('Peer')
    radios.connect()
    await flush()
    assert.equal(snapshot.active, true)
    assert.equal(snapshot.sharing, true)
    assert.equal(peer.hasGateway(), false, 'An offline phone must not advertise as a gateway')
    hasInternet = true
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(await android.sendMesh('still local'), true)
    await flush()
    assert.equal(peer.hasGateway(), true)
    await android.stop()
    assert.equal(snapshot.active, false)
    assert.equal(snapshot.sharing, false)
    enabled = false
    await android.resume('Android', () => enabled)
    assert.deepEqual(requests, [true])
    enabled = true
    await android.resume('Android', () => enabled)
    assert.deepEqual(requests, [true, false])
    assert.equal(snapshot.active, true)
    assert.equal(snapshot.sharing, true)
  } finally { android.close(); peer.close() }
})
