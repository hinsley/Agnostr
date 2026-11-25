// Deterministic test-only identity. Events are kept entirely inside a mocked relay.
import { finalizeEvent, getPublicKey } from 'nostr-tools'
import { buildGeoGameSignalTemplate } from '../../src/lib/gameSignaling'
import { createPokerTable } from '../../src/lib/games/pokerEngine'

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
