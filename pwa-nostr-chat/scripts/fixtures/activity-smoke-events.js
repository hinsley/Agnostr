// Deterministic test-only identity. Events are kept entirely inside a mocked relay.
import { finalizeEvent, getPublicKey } from 'nostr-tools'
import { buildGeoGameSignalTemplate } from '../../src/lib/gameSignaling'
import { buildNamedBitchatChatTemplate } from '../../src/lib/bitchatProtocol'
import { applyPokerAction, createPokerTable, seatPokerPlayer, startPokerHand } from '../../src/lib/games/pokerEngine'

export function roomEvents(targetId) {
  const key = Uint8Array.from({ length: 32 }, (_, i) => i === 31 ? 7 : 0)
  const hostPubkey = getPublicKey(key)
  const tableId = 'fixture-room-table'
  const now = Date.now()
  const state = createPokerTable({ tableId, hostPubkey, hostDisplayName: 'Synthetic host', fixedBuyIn: 100 })
  const payloads = [
    { v: 1, type: 'poker-announce', tableId, hostPubkey, hostDisplayName: 'Synthetic host', scope: 'geo',
      targetId, fixedBuyIn: 100, smallBlind: state.smallBlind, bigBlind: state.bigBlind,
      maxSeats: state.maxSeats, seatedCount: 1, phase: 'lobby', ts: now },
    { v: 1, type: 'poker-state', tableId, seq: 1, publicState: JSON.stringify(state), ts: now },
  ]
  return payloads.map(p => finalizeEvent(buildGeoGameSignalTemplate(p, targetId), key))
}

// Long, genuine message rows reproduce the compact dock competing with a busy room's history.
export function busyRoomHistory(targetId) {
  const now = Math.floor(Date.now() / 1000)
  return Array.from({ length: 80 }, (_, i) => {
    const secret = Uint8Array.from({ length: 32 }, (_, j) => j === 31 ? 8 + i % 3 : 0)
    const template = buildNamedBitchatChatTemplate({
      content: `Fixture message ${i + 1}: This is a multiline chat history row from the isolated test relay. A minimized board needs its own space even when this conversation contains dozens of messages.\n\nA second paragraph makes the message stream tall enough to exercise the actual layout rather than an empty placeholder.`,
      topic: targetId,
      nickname: `Fixture chatter ${i % 3 + 1}`,
    })
    return finalizeEvent({ ...template, created_at: now - (80 - i) * 3 }, secret)
  })
}

function seatedVisitor(visitorPubkey) {
  const key = Uint8Array.from({ length: 32 }, (_, i) => i === 31 ? 7 : 0)
  const hostPubkey = getPublicKey(key)
  const tableId = 'fixture-room-table'
  const table = createPokerTable({ tableId, hostPubkey, hostDisplayName: 'Synthetic host', fixedBuyIn: 100 })
  const seated = seatPokerPlayer(table, visitorPubkey, 'Fixture guest')
  if (!seated) throw Error('Fixture visitor could not sit')
  return { key, hostPubkey, tableId, seated }
}

export function seatedLobbyForVisitor(targetId, visitorPubkey) {
  const { key, tableId, seated } = seatedVisitor(visitorPubkey)
  return finalizeEvent(buildGeoGameSignalTemplate({
    v: 1, type: 'poker-state', tableId, seq: 2, publicState: JSON.stringify(seated), ts: Date.now(),
  }, targetId), key)
}

// The host starts the hand and calls the small blind, so the visitor can Check.
export function liveHandForVisitor(targetId, visitorPubkey) {
  const { key, hostPubkey, tableId, seated } = seatedVisitor(visitorPubkey)
  const hand = startPokerHand(seated)
  if (!hand) throw Error('Fixture hand did not start')
  const afterHost = applyPokerAction(hand.publicState, hand.privateState, hostPubkey, { type: 'call' })
  if (afterHost?.publicState.actingPubkey !== visitorPubkey) throw Error('Fixture visitor did not get the turn')
  return finalizeEvent(buildGeoGameSignalTemplate({
    v: 1, type: 'poker-state', tableId, seq: 3,
    publicState: JSON.stringify(afterHost.publicState), ts: Date.now(),
  }, targetId), key)
}
