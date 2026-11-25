import assert from 'node:assert/strict'
import test from 'node:test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import {
  buildGeoGameSignalTemplate, buildServerGameSignalTemplate, getGeoGameRoomTag,
  getServerGameRoomTag, parseGeoGameSignalEvent, parsePokerRosterEvidence,
  validateGameSignalPayload,
} from '../src/lib/gameSignaling.ts'
import { createPokerTable, seatPokerPlayer, startPokerHand } from '../src/lib/games/pokerEngine.ts'
import {
  addPokerBallot, applyPokerDeparture, pokerRosterRound, pokerVoteThreshold,
} from '../src/lib/games/pokerGovernance.ts'

const keys = Array.from({ length: 7 }, generateSecretKey)
const pub = keys.map(getPublicKey)
const room = 'geo:9q8'
const roomTag = getGeoGameRoomTag('9q8')
const now = Date.now()
function table(n) {
  let state = createPokerTable({ tableId: 'table', hostPubkey: pub[0], hostDisplayName: 'One', fixedBuyIn: 100, maxSeats: 8 })
  for (let i = 1; i < n; i++) state = seatPokerPlayer(state, pub[i], String(i))
  return state
}
function ballot(state, target = pub[0]) {
  return { v: 1, type: 'poker-vote-out', tableId: state.tableId, room, round: pokerRosterRound(state), target, ts: now }
}
function signed(payload, i, geo = '9q8') {
  return finalizeEvent(buildGeoGameSignalTemplate(payload, geo), keys[i])
}
async function tally(state, events) {
  const votes = new Map()
  let quorum
  for (const event of events) {
    const decoded = await parsePokerRosterEvidence(event, roomTag)
    if (decoded?.payload.type !== 'poker-vote-out') continue
    quorum ??= addPokerBallot(state, room, decoded.payload, decoded.signer, event, votes)
  }
  return quorum
}

test('cannot count forged signatures, duplicate/target/spectator votes, or wrong room/table/round', async () => {
  const state = table(4)
  const valid = ballot(state)
  const first = signed(valid, 1)
  // Seed the general event cache; embedded proof still checks exact signed fields.
  assert.ok(parseGeoGameSignalEvent(first))
  const altered = { ...first, content: JSON.stringify({ ...valid, target: pub[2] }) }
  assert.equal(await parsePokerRosterEvidence(altered, roomTag), null)
  const missingOne = await tally(state, [
    first, signed({ ...valid, ts: now + 1 }, 1),
    signed(valid, 0), signed(valid, 6), signed(valid, 3, '9q9'),
    signed({ ...valid, room: 'geo:9q9' }, 3), signed({ ...valid, tableId: 'elsewhere' }, 3),
    signed({ ...valid, round: 'other revision' }, 3), altered, signed(valid, 2),
  ])
  assert.ok(!missingOne)
  assert.equal(pokerVoteThreshold(2), Infinity)
  assert.equal(pokerVoteThreshold(4), 3)
  assert.equal((await tally(state, [first, signed(valid, 2), signed(valid, 3)])).length, 3)
})

test('a retransmitted proof converges for a peer missing a live vote without dealer approval', async () => {
  const state = startPokerHand(table(3)).publicState
  const payload = ballot(state)
  const ev1 = signed(payload, 1)
  const ev2 = signed(payload, 2)
  assert.ok(!await tally(state, [ev1]))
  const proof = validateGameSignalPayload(JSON.parse(JSON.stringify({
    v: 1, type: 'poker-roster-proof', tableId: state.tableId, events: [ev2, ev1], ts: now,
  })))
  const quorum = await tally(state, proof.events)
  assert.equal(quorum.length, 2)
  const updated = applyPokerDeparture(state, pub[0], true, now)
  assert.equal(updated.hostPubkey, pub[1])
  assert.equal(updated.phase, 'lobby')
  assert.equal(updated.handNumber, state.handNumber + 1)
  assert.equal(updated.pot, 0)
  assert.deepEqual(updated.seats.map((s) => s.chips), [100, 100])
  assert.deepEqual(updated.expelledPubkeys, [pub[0]])
  assert.ok(!await tally(updated, quorum))
  assert.equal(seatPokerPlayer(updated, pub[0], 'Rejoin'), null)
  const third = seatPokerPlayer(updated, pub[3], 'New seat')
  assert.notEqual(pokerRosterRound(third), pokerRosterRound(state))
})

test('encrypted group proof verifies original ballots without exposing plaintext', async () => {
  const state = table(3)
  const server = { id: 'private-room', encrypted: true, encryptionKeyHex: 'a'.repeat(64) }
  const payload = { ...ballot(state), room: 'server:private-room' }
  const event = finalizeEvent(await buildServerGameSignalTemplate(payload, server), keys[1])
  assert.ok(!event.content.includes(pub[0]))
  assert.equal(await parsePokerRosterEvidence(event, getServerGameRoomTag(server.id)), null)
  const decoded = await parsePokerRosterEvidence(event, getServerGameRoomTag(server.id), server)
  assert.equal(decoded.signer, pub[1])
  assert.deepEqual(decoded.payload, payload)
})

test('voluntary dealer departure keeps the table, only the last seat closes it', async () => {
  const state = table(2)
  const wrong = signed({ v: 1, type: 'poker-leave', tableId: state.tableId, round: 'old', ts: now }, 0)
  assert.equal((await parsePokerRosterEvidence(wrong, roomTag)).payload.round, 'old')
  const a = applyPokerDeparture(state, pub[0], false, now)
  assert.equal(a.phase, 'lobby')
  assert.equal(a.hostPubkey, pub[1])
  assert.equal(a.expelledPubkeys?.length ?? 0, 0)
  const b = applyPokerDeparture(a, pub[1], false, now)
  assert.equal(b.phase, 'finished')
  assert.equal(b.seats.length, 0)
  assert.equal(applyPokerDeparture(b, pub[1], false, now), null)
})
