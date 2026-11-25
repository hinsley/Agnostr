import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  appendRoomRosterJoins,
  captureRoomRoster,
  compareRoomRosterPosition,
  roomRosterKey,
  ROOM_ROSTER_REFRESH_MS,
  startRoomRosterSampling,
} from '../src/lib/roomRoster.ts'

function fakeClock() {
  let time = 0
  let next = 0
  const timers = new Map()
  return {
    schedule(callback, delay) {
      const id = ++next
      timers.set(id, { callback, at: time + delay })
      return id
    },
    cancel(id) { timers.delete(id) },
    advance(to) {
      time = to
      for (const [id, timer] of timers) {
        if (timer.at > time) continue
        timers.delete(id)
        timer.callback()
      }
    },
    pending: () => timers.size,
  }
}

const peer = (pubkey, nickname = pubkey, lastSeenAt = 1) => ({
  pubkey, nickname, displayHandle: nickname, lastSeenAt,
  npub: pubkey, isOnline: true, isSelf: false, isBlocked: false,
  isMeshBridge: false, isTeleported: false, messageCount: 1, channels: ['abc'],
})
const channel = (readRoomPeers) => ({
  activeView: { type: 'channel' }, activeGeohash: 'abc',
  identity: { masterPubkey: 'account' }, profiles: { activeProfileId: 'one' },
  broadcastClientTag: true, readRoomPeers,
  isPeerBlocked: () => false, isExplicitlyTrusted: () => false,
})

test('bursts, removals, and presence changes are batched into the latest roster every 30 seconds', () => {
  const clock = fakeClock()
  const frames = []
  let peers = [peer('A')]
  const engine = channel(() => peers)
  const stop = startRoomRosterSampling(() => frames.push(captureRoomRoster(engine)), clock)
  assert.equal(clock.pending(), 1)
  assert.deepEqual(frames[0].peers.map((p) => p.pubkey), ['a'])

  for (let i = 1; i < 30; i++) {
    peers = [peer('A', String(i), i), peer('B'), peer(String(i))]
    clock.advance(i * 1000)
  }
  assert.equal(frames.length, 1)
  assert.equal(frames[0].peers[0].lastSeenAt, 1)
  peers = [{ ...peer('B', 'Latest', 30), isOnline: false }]
  clock.advance(ROOM_ROSTER_REFRESH_MS)
  assert.equal(frames.length, 2)
  assert.deepEqual(frames[1].peers.map((p) => [p.pubkey, p.nickname, p.isOnline]), [['b', 'Latest', false]])

  // The next frame is live even when the only change is an expiry in the presence tracker.
  peers = []
  clock.advance(59_999)
  assert.equal(frames.length, 2)
  clock.advance(60_000)
  assert.deepEqual(frames[2].peers, [])
  stop()
  clock.advance(120_000)
  assert.equal(clock.pending(), 0)
  assert.equal(frames.length, 3)
})

test('joins publish immediately without pushing existing rows around or restarting refresh', () => {
  const clock = fakeClock()
  const frames = []
  let peers = [peer('A', 'Alpha'), peer('C', 'Charlie')]
  const engine = channel(() => peers)
  engine.peers = peers
  let roster
  const publish = (next) => {
    if (next === roster) return
    frames.push(next)
    roster = next
  }
  const stop = startRoomRosterSampling(() => publish(captureRoomRoster(engine)), clock)
  const detect = (items) => {
    peers = items
    engine.peers = items
    publish(appendRoomRosterJoins(roster, engine))
  }
  const initial = roster
  clock.advance(5_000)
  // C departed, and A's name and presence changed. Neither should change the
  // shown snapshot. B is appended once (case-insensitive) as soon as detected.
  detect([{ ...peer('a', 'Zulu', 5), isOnline: false }, peer('B', 'Aardvark'), peer('b')])
  assert.equal(frames.length, 2)
  assert.deepEqual(roster.peers.slice(0, 2), initial.peers)
  assert.equal(roster.sampledAt, initial.sampledAt)
  assert.deepEqual([...roster.pendingJoins], ['b'])
  assert.deepEqual(roster.peers.map((p) => p.pubkey), ['a', 'c', 'b'])

  clock.advance(10_000)
  detect([peer('B', 'Changed nickname'), peer('c')])
  assert.equal(frames.length, 2)
  clock.advance(20_000)
  detect([peer('D', 'First in alphabet'), peer('B', 'Latest B', 20)])
  assert.equal(frames.length, 3)
  assert.deepEqual([...roster.peers].sort((a, b) =>
    compareRoomRosterPosition(roster, a.pubkey, b.pubkey, () => a.nickname.localeCompare(b.nickname))
  ).map((p) => p.pubkey), ['a', 'c', 'b', 'd'])

  clock.advance(29_999)
  assert.equal(frames.length, 3)
  clock.advance(30_000)
  assert.equal(clock.pending(), 1)
  assert.equal(frames.length, 4)
  assert.deepEqual(roster.peers.map((p) => [p.pubkey, p.nickname]), [['d', 'First in alphabet'], ['b', 'Latest B']])
  assert.equal(roster.pendingJoins, undefined)
  detect([...peers, peer('a', 'Returned after expiry')])
  assert.deepEqual(roster.peers.map((p) => p.pubkey), ['d', 'b', 'a'])
  stop()
})

test('group joins use normalized keys, while roles and banned-only entries wait for sampling', () => {
  const member = (pk, roles = ['member'], isBanned = false) => ({
    ...peer(pk), roles, isAdmin: false, isFounder: false, isBanned,
  })
  const engine = channel(() => [])
  engine.activeView = { type: 'server', serverId: 'grp', channelId: 'text' }
  engine.getPeerByPubkey = () => null
  engine.servers = { members: [member('A')], messages: [] }
  const initial = captureRoomRoster(engine)
  engine.servers.members = [member('a', ['moderator']), member('B'), member('b'), member('C', [], true)]
  engine.servers.messages = [{ pubkey: 'B', createdAt: 20 }]
  const withJoin = appendRoomRosterJoins(initial, engine)
  assert.deepEqual([...withJoin.pendingJoins], ['b'])
  assert.deepEqual(withJoin.members.map((m) => m.member.pubkey), ['a', 'b'])
  assert.equal(withJoin.members[0], initial.members[0])
  assert.equal(withJoin.members[0].member.roles[0], 'member')
  assert.equal(withJoin.members[1].lastSeenAt, 20)
  assert.equal(appendRoomRosterJoins(withJoin, engine), withJoin)
  engine.servers.members.pop()
  engine.servers.members.splice(1)
  const refreshed = captureRoomRoster(engine)
  assert.deepEqual(refreshed.members.map((m) => m.member.pubkey), ['a'])
  assert.equal(refreshed.members[0].member.roles[0], 'moderator')
  assert.equal(refreshed.pendingJoins, undefined)
  engine.activeView = { type: 'dm', peerPubkey: 'b' }
  assert.equal(appendRoomRosterJoins(withJoin, engine), withJoin)
})

test('one delayed timer does not publish catch-up frames or leave an old room timer active', () => {
  const clock = fakeClock()
  const frames = []
  const stopA = startRoomRosterSampling(() => frames.push('A'), clock)
  clock.advance(88_000)
  assert.deepEqual(frames, ['A', 'A'])
  clock.advance(90_000)
  assert.deepEqual(frames, ['A', 'A'])
  stopA()
  const stopB = startRoomRosterSampling(() => frames.push('B'), clock)
  clock.advance(119_999)
  assert.deepEqual(frames, ['A', 'A', 'B'])
  clock.advance(120_000)
  assert.deepEqual(frames, ['A', 'A', 'B', 'B'])
  stopB()
})

test('group snapshot covers membership and ordering inputs, while scope ignores group-channel changes', () => {
  const engine = channel(() => [])
  engine.activeView = { type: 'server', serverId: 'grp', channelId: 'text' }
  const m = { ...peer('A'), roles: ['member'], isAdmin: false, isFounder: false }
  engine.servers = { members: [m], messages: [{ pubkey: 'A', createdAt: 8 }] }
  let known = peer('A', 'Live', 5)
  engine.getPeerByPubkey = () => known
  const key = roomRosterKey(engine)
  const first = captureRoomRoster(engine)
  engine.activeView = { ...engine.activeView, channelId: 'other-text' }
  assert.equal(roomRosterKey(engine), key)
  known.isOnline = false
  known.channels.push('elsewhere')
  m.roles[0] = 'moderator'
  engine.servers.messages = [
    { pubkey: 'a', createdAt: 20 },
    { pubkey: 'a', createdAt: 100, isBlockedPlaceholder: true },
    { pubkey: 'a', createdAt: 101, isSystem: true },
  ]
  const second = captureRoomRoster(engine)
  assert.equal(first.members[0].isOnline, true)
  assert.deepEqual(first.members[0].known.channels, ['abc'])
  assert.equal(first.members[0].member.roles[0], 'member')
  assert.equal(first.members[0].lastSeenAt, 8)
  assert.equal(second.members[0].isOnline, false)
  assert.equal(second.members[0].member.roles[0], 'moderator')
  assert.equal(second.members[0].lastSeenAt, 20)
  engine.profiles.activeProfileId = 'two'
  assert.notEqual(roomRosterKey(engine), key)
  engine.activeView = { type: 'dm', peerPubkey: 'a' }
  assert.equal(roomRosterKey(engine), null)
  assert.equal(captureRoomRoster(engine), null)
})
