import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, generateSecretKey, verifyEvent } from 'nostr-tools'
import { createGatewayPolicy } from '../src/lib/nearby/gatewayPolicy.ts'

const now = 1_800_000_000_000
const testkey = generateSecretKey()
const gh = 'djuq'
const sender = '0011223344556677'
const template = { kind: 20000, created_at: now / 1000, content: 'From the mesh', tags: [['g', gh], ['n', 'Carter']] }
const sign = (partial = {}) => finalizeEvent({ ...template, ...partial }, testkey)
const wrap = (event, direction = 'toGateway', geohash = gh) => ({ direction, geohash, eventJSON: new TextEncoder().encode(JSON.stringify(event)) })

test('only an explicit gateway can publish a valid public geohash deposit', () => {
  const p = createGatewayPolicy(() => now)
  const event = sign()
  assert.equal(p.acceptUplink(wrap(event), sender, false), null)
  assert.equal(p.acceptUplink(wrap({ ...event, content: 'tampered' }), sender, true), null)
  assert.equal(p.acceptUplink(wrap(event, 'toGateway', 'djuz'), sender, true), null)
  assert.equal(p.acceptUplink(wrap(sign({ kind: 1059 })), sender, true), null)
  assert.equal(p.acceptUplink(wrap(sign({ created_at: now / 1000 - 1000 })), sender, true), null)
  assert.equal(p.acceptUplink(wrap(event), sender, true).id, event.id)
  assert.equal(p.acceptUplink(wrap(event), sender, true), null)
  assert.equal(p.relayPacket(event, gh, true), null)
})

test('valid relay messages travel one way over BLE without re-publishing', () => {
  const online = createGatewayPolicy(() => now)
  const offline = createGatewayPolicy(() => now)
  const event = sign()
  assert.equal(online.relayPacket(event, gh, false), null)
  const packet = online.relayPacket(event, gh, true)
  assert.ok(packet)
  assert.equal(offline.acceptDownlink(packet, gh).show, true)
  assert.equal(online.relayPacket(event, gh, true), null)
  assert.equal(offline.acceptDownlink(packet, gh), null)
  assert.equal(offline.relayPacket(event, gh, true), null)
  const mismatched = sign({ content: 'for another selected geohash' })
  assert.equal(offline.acceptDownlink(wrap(mismatched, 'fromGateway'), 'abc').show, false)
})

test('offline geohash keys are independent and keep the local display name', () => {
  const p = createGatewayPolicy(() => now)
  const event = p.signOffline({ ...template, tags: [...template.tags, ['lud16', 'wallet@example.com']] }, gh)
  assert.ok(verifyEvent(event))
  assert.deepEqual(event.tags, [['g', gh], ['n', 'Carter']])
  assert.equal(p.signOffline(template, gh).pubkey, event.pubkey)
  assert.notEqual(p.signOffline(template, 'djuz').pubkey, event.pubkey)
  assert.ok(p.localPacket(event, gh))
  assert.equal(p.acceptDownlink(wrap(event, 'fromGateway'), gh), null)
  p.reset()
  assert.notEqual(p.signOffline(template, gh).pubkey, event.pubkey)
})

test('signed floods and oversized events are bounded', () => {
  const p = createGatewayPolicy(() => now)
  assert.equal(p.acceptUplink(wrap(sign({ content: 'q'.repeat(6000) })), sender, true), null)
  for (let i = 0; i < 10; i++) assert.ok(p.acceptUplink(wrap(sign({ content: `packet ${i}` })), sender, true))
  assert.equal(p.acceptUplink(wrap(sign({ content: 'over quota' })), sender, true), null)
})
