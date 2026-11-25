import assert from 'node:assert/strict'
import test from 'node:test'
import { selectBitchatDrawerChannels } from '../src/lib/bitchatDrawerChannels.ts'

const pin = (geohash, label) => ({ geohash, label, pinnedAt: 1, unreadCount: 0, mentionCount: 0 })
const pulse = (geohash, peerCount, messageCount, lastActivityAt) => ({ geohash, peerCount, messageCount, lastActivityAt })
const keys = rows => rows.map(row => row.key)

test('saved pin order precedes the activity ranking; live pins and key aliases never duplicate', () => {
  const pinned = [pin('#TOPIC:quiet'), pin('MARS:S000', 'Mars'), pin('mars:s000')]
  const live = [pulse('u4pr', 0, 4, 1), pulse('mars:s000', 2, 1, 2), pulse('9q8y', 1, 0, 3), pulse('#U4PR', 1, 4, 4), pulse('topic:invisible', 0, 0, 5)]
  const result = selectBitchatDrawerChannels(pinned, live, '#Mars:S000')
  assert.deepEqual(keys(result.pinned), ['topic:quiet', 'mars:s000'])
  assert.deepEqual(keys(result.live), ['u4pr', '9q8y'])
  assert.equal(result.live[0].pulse.lastActivityAt, 4)
  assert.equal(result.pinned[0].pulse, undefined)
  assert.equal(result.pinned[1].selected, true)
  assert.equal(result.current, null)
})

test('an unpinned selected channel stays reachable even with no activity', () => {
  const result = selectBitchatDrawerChannels([], [pulse('topic:zero', 0, 0, 1)], 'topic:quiet')
  assert.deepEqual(result, { pinned: [], live: [], current: { key: 'topic:quiet', selected: true } })
})

test('an active selected room is marked once within the live list', () => {
  const result = selectBitchatDrawerChannels([], [pulse('topic:present', 1, 0, 1)], '#TOPIC:PRESENT')
  assert.equal(result.live[0].selected, true)
  assert.equal(result.current, null)
})
