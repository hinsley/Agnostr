import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicKey, verify } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import {
  ANNOUNCE, MESSAGE, NOSTR_CARRIER, createMeshIdentity, createFragmentCollector, decodeCarrier, decodePacket, encodeCarrier, encodePacket,
  encodeText, framesFor, hex, proofId, readAnnouncement, safeText, verifyPacket,
} from '../src/lib/nearby/meshWire.ts'
import { createMeshSession } from '../src/lib/nearby/meshSession.ts'

const stamp = 1_800_000_000_000
function aPeer() { return createMeshIdentity('Test radio', new Uint8Array(32).fill(14), new Uint8Array(32).fill(23)) }

test('independent canonical Ed25519 broadcast signature and relay TTL', () => {
  const peer = aPeer()
  const intro = decodePacket(encodePacket(peer.announce(stamp)))
  const key = readAnnouncement(intro).signingKey
  const body = Buffer.from('HELLO ARE YOU THERE')
  const packet = peer.text(body.toString(), stamp + 1)
  const frame = encodePacket(packet)
  const preimage = Buffer.alloc(256, 256 - (30 + body.length))
  preimage.set([1, MESSAGE, 0], 0)
  preimage.writeBigUInt64BE(BigInt(stamp + 1), 3)
  preimage[11] = 1
  preimage.writeUInt16BE(body.length, 12)
  preimage.set(packet.sender, 14)
  preimage.fill(255, 22, 30)
  preimage.set(body, 30)
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key])
  assert.ok(verify(null, preimage, createPublicKey({key:spki, format:'der', type:'spki'}), packet.signature))
  frame[2] = 4
  assert.ok(verifyPacket(decodePacket(frame), key))
  assert.equal(proofId(decodePacket(frame)), proofId(packet))
  const directed = frame.slice()
  directed[22] = 17
  assert.equal(decodePacket(directed), null)
  frame[30] ^= 1
  assert.equal(verifyPacket(decodePacket(frame), key), false)
})

test('bounded compression and relay round-trip preserve the signed bytes', () => {
  const peer = aPeer()
  const body = 'International 🪐 · '.repeat(16)
  const packet = peer.text(body, stamp)
  const wire = encodePacket(packet)
  assert.ok(wire[11] & 4)
  assert.deepEqual(Buffer.from(wire.subarray(32, wire.length - 64)), deflateRawSync(Buffer.from(body)))
  const decoded = decodePacket(wire)
  assert.equal(safeText(decoded.payload), body)
  assert.deepEqual(encodePacket(decoded), wire)
  wire[30] = 0xff
  assert.equal(decodePacket(wire), null)
})

test('fragments fit negotiated sizes and reconstruct out of order', () => {
  const peer = aPeer()
  const packet = peer.text(Array.from({length: 180}, (_, i) => String.fromCharCode(0x421 + i)).join(''), stamp)
  for (const limit of [64, 100, 244, 512]) {
    const pieces = framesFor(packet, limit, new Uint8Array(8).fill(7))
    assert.ok(pieces.length > 0)
    assert.ok(pieces.every(p => p.length <= limit))
    const fragments = createFragmentCollector()
    const parsed = pieces.toReversed().map(x => fragments.receive(decodePacket(x), stamp)).filter(Boolean)
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].type, MESSAGE)
    assert.deepEqual(encodePacket(parsed[0]), encodePacket(packet))
  }
})

test('announcement identity binding, deduplication and expiry', () => {
  const peer = aPeer()
  let now = stamp
  const session = createMeshSession('other', () => now)
  const intro = encodePacket(peer.announce(stamp))
  assert.equal(decodePacket(intro).type, ANNOUNCE)
  const badIntro = intro.slice()
  badIntro[14] ^= 16
  assert.deepEqual(session.receive(badIntro, 'link'), [])
  const text = encodePacket(peer.text('offline', stamp + 1))
  const forged = text.slice()
  forged[forged.length - 1] ^= 1
  assert.deepEqual(session.receive(forged, 'link'), [])
  assert.deepEqual(session.receive(text, 'link'), [])
  const events = session.receive(intro, 'link')
  assert.equal(events.length, 2)
  assert.equal(events[1].message.body, 'offline')
  assert.equal(events[1].message.name, 'Test radio')
  assert.deepEqual(session.receive(text, 'same relay'), [])
  assert.equal(session.peerCount(), 1)
  now += 301_000
  assert.equal(session.peerCount(), 0)
  assert.deepEqual(session.receive(intro, 'link'), [])
})

const testCarrier = (direction = 'toGateway', event = '{"test":true}') => ({
  direction, geohash: '9q5', eventJSON: encodeText(event),
})

test('geohash carrier uses stock Bitchat 0x28 big-endian TLV, drops malformed and ambiguous fields', () => {
  const sample = testCarrier()
  const encoded = encodeCarrier(sample)
  assert.equal(hex(encoded), '0100010102000339713503000d7b2274657374223a747275657d')
  assert.deepEqual(decodeCarrier(encoded), sample)
  assert.equal(decodeCarrier(encoded.subarray(0, -1)), null)
  assert.equal(decodeCarrier(Uint8Array.from([...encoded, 1, 0, 1, 2])), null)
  assert.deepEqual(decodeCarrier(Uint8Array.from([...encoded, 77, 0, 1, 99])), sample)
  const meshIsland = encoded.slice()
  meshIsland[3] = 3
  assert.equal(decodeCarrier(meshIsland), null)
  assert.equal(encodeCarrier({ ...sample, geohash: '9i5' }), null)
  assert.equal(encodeCarrier({ ...sample, eventJSON: new Uint8Array(16_385) }), null)
  assert.deepEqual(decodeCarrier(encodeCarrier({ ...sample, eventJSON: new Uint8Array(16_384) })).eventJSON.length, 16_384)
})

test('announced gateway capabilities, directed authentication, and unsigned downlink separation', () => {
  const peer = aPeer()
  const target = '0102030405060708'
  const session = createMeshSession(target, () => stamp + 20)
  const intro = encodePacket(peer.announce(stamp, true))
  const directed = peer.carrier(testCarrier(), target, stamp + 1)
  assert.ok(directed.signature)
  const originalWire = encodePacket(directed)
  const fake = originalWire.slice()
  fake[fake.length - 1] ^= 1
  assert.deepEqual(session.receive(fake, 'bad-link'), [])
  assert.deepEqual(session.receive(originalWire, 'good-link'), [])
  assert.equal(session.peers().length, 0)
  const observations = session.receive(intro, 'intro-link')
  assert.equal(observations.length, 2)
  assert.equal(observations[1].ingress, 'good-link')
  assert.equal(hex(observations[1].relay.recipient), target)
  assert.deepEqual(observations[1].carrier, testCarrier())
  assert.deepEqual(session.peers(), [{ id: peer.id, name: 'Test radio', gateway: true, heard: stamp + 20 }])
  assert.deepEqual(session.receive(originalWire, 'replay'), [])
  session.receive(encodePacket(peer.announce(stamp + 6, false)), 'intro-link')
  assert.equal(session.peers()[0].gateway, false)

  const downlink = peer.carrier(testCarrier('fromGateway'), undefined, stamp + 7)
  assert.equal(downlink.type, NOSTR_CARRIER)
  assert.equal(downlink.recipient, undefined)
  assert.equal(downlink.signature, undefined)
  assert.equal(peer.carrier(testCarrier('fromGateway'), target), null)
  assert.equal(peer.carrier(testCarrier(), undefined), null)
  assert.equal(peer.carrier(testCarrier(), 'ffffffffffffffff'), null)
  const downlinkWire = encodePacket(downlink)
  const cold = createMeshSession(target, () => stamp + 20)
  assert.equal(cold.receive(downlinkWire, 'unknown')[0].carrier.direction, 'fromGateway')
  assert.equal(cold.peers().length, 0)
  assert.deepEqual(cold.receive(downlinkWire, 'unknown'), [])
  assert.equal(cold.receive(encodePacket({ ...downlink, broadcast: true }), 'wrong-address').length, 0)
  assert.equal(cold.receive(encodePacket({ ...downlink, recipient: Uint8Array.of(1,2,3,4,5,6,7,8) }), 'wrong-direction').length, 0)
  assert.equal(cold.receive(encodePacket({ ...directed, signature: undefined }), 'unsigned-deposit').length, 0)
})

test('fragment collector binds directed carrier to its exact recipient', () => {
  const peer = aPeer()
  const packet = peer.carrier(testCarrier('toGateway', JSON.stringify({
    text: Array.from({length: 700}, (_, i) => i.toString(16)).join(', '),
  })), '0102030405060708', stamp)
  const limit = 180
  const pieces = framesFor(packet, limit, new Uint8Array(8).fill(1))
  assert.ok(pieces.length > 1)
  assert.ok(pieces.every(piece => piece.length <= limit && hex(decodePacket(piece).recipient) === '0102030405060708'))
  const collector = createFragmentCollector()
  const forged = pieces[1].slice()
  forged[22] ^= 1
  assert.equal(collector.receive(decodePacket(pieces[0]), stamp), null)
  assert.equal(collector.receive(decodePacket(forged), stamp), null)
  const assembled = pieces.slice(1).toReversed().map(x => collector.receive(decodePacket(x), stamp)).filter(Boolean)
  assert.equal(assembled.length, 1)
  assert.equal(assembled[0].type, NOSTR_CARRIER)
  assert.deepEqual(encodePacket(assembled[0]), encodePacket(packet))
})

// Captured directly with the stock v1.8.0 Swift BitFoundation binary encoder,
// CryptoKit Ed25519 (32-byte 0x0e fixture seed), and NostrCarrierPacket TLV.
test('captured Apple Bitchat 1.8.0 frames interoperate in both packet versions', () => {
  const fixtures = [
    'ASgGAAABoxhcUAAHAJgWY5RXFKwUwwECAwQFBgcIBaTtjsENwjAMRRsq9ohy/6h2krZhDjZAkXoorZByQ2zAFXFkRUbALlug3L7jl+9nGmN2TZuusd2/bu68LiUvxR2dH+BHBELowSACM3xE7ED9FsCjLDhhA7lDUFpmSopHkMLKayZ9lqUWKixfBp1Za6IWSq3AEvh3Tg8LLWBVqSpVpar8u4o95Xm2ZcoXO0la7ef9eB7c/QueMy6QOIHLCeVEMIqEOCoAfnQjKfpcv0iqmTrZh+Cx6eLOPEsUZwOhP7wH3uzdf1LCFO5hqVXCRO3LQPLQQEII',
    'AigGAAABoxhcUAAfAAAAmhZjlFcUrBTDAQIDBAUGBwgCCgoKCgoKCgoBAgMEBQYHCAAABaTtjsENwjAMRRsq9ohy/6h2krZhDjZAkXoorZByQ2zAFXFkRUbALlug3L7jl+9nGmN2TZuusd2/bu68LiUvxR2dH+BHBELowSACM3xE7ED9FsCjLDhhA7lDUFpmSopHkMLKayZ9lqUWKixfBp1Za6IWSq3AEvh3Tg8LLWBVqSpVpar8u4o95Xm2ZcoXO0la7ef9eB7c/QvZY5CAaHqEGePLwQNKgLroCPgOh+ArodAkZBTHveqBCTekwqvv5NOmjl8NGQkDhGonZYIGDIN8e3p2yq5wrq8L',
    'ASgGAAABoxhcUAAEAJgWY5RXFKwUwwWk7Y7NDcIwDIX7I/aIcn+odpK2YQ42QJF6KK2QckPdgCviyIqMgF22QLk9x1+ev7qqm6Zq4y20h9fdXtYlpyXbk3UD3AhP8D0YRGCGCwgdqN8DeJQFR+wgd/BKy0xR8QBSWHnNpM+y1EKF5cugM2tN0EKpFVgC/87pYaEFLCpFpagUlX9XMec0zyZP6WomSav5vB/Po92+',
  ]
  const peer = aPeer()
  const intro = decodePacket(encodePacket(peer.announce(stamp - 1, true)))
  const key = readAnnouncement(intro).signingKey
  const [one, two, down] = fixtures.map(text => {
    const bytes = Uint8Array.from(Buffer.from(text, 'base64'))
    const packet = decodePacket(bytes)
    assert.ok(packet)
    assert.deepEqual(encodePacket(packet), bytes)
    return packet
  })
  assert.ok(verifyPacket(one, key))
  assert.ok(verifyPacket(two, key))
  assert.ok(verifyPacket({ ...two, ttl: 2, rsr: false }, key))
  assert.deepEqual(two.route.map(hex), ['0a0a0a0a0a0a0a0a', '0102030405060708'])
  assert.equal(two.rsr, true)
  assert.equal(one.version, 1)
  assert.equal(two.version, 2)
  assert.equal(down.signature, undefined)
  assert.equal(decodeCarrier(down.payload).direction, 'fromGateway')
  const body = decodeCarrier(one.payload)
  assert.deepEqual(decodeCarrier(two.payload), body)
  assert.equal(body.geohash, '9q5')
  assert.equal(JSON.parse(safeText(body.eventJSON)).content.endsWith('Tell them hello 🌕.'), true)
  const outbound = decodePacket(encodePacket({ ...peer.carrier(body, '0102030405060708', stamp), ttl: 6 }))
  assert.ok(verifyPacket(outbound, key))
  assert.deepEqual(encodePacket(outbound).subarray(0, -64), encodePacket(one).subarray(0, -64))
})
