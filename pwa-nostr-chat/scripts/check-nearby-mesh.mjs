import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicKey, verify } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import {
  ANNOUNCE, MESSAGE, createMeshIdentity, createFragmentCollector, decodePacket, encodePacket,
  framesFor, proofId, readAnnouncement, safeText, verifyPacket,
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
