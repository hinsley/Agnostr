import type { AgnostrEngine, PeerInfo } from '../types/protocol.ts'
import type { Nip29Member } from '../types/servers.ts'

export const ROOM_ROSTER_REFRESH_MS = 30_000

interface RoomRosterClock<T> {
  schedule: (callback: () => void, delay: number) => T
  cancel: (timer: T) => void
}

// One clock for the whole roster, not one debounce or timer per incoming event.
// Rearming after publication also avoids back-to-back updates after a suspended tab.
export function startRoomRosterSampling<T>(
  publish: () => void,
  clock: RoomRosterClock<T>,
): () => void {
  publish()
  let timer = clock.schedule(function tick() {
    publish()
    timer = clock.schedule(tick, ROOM_ROSTER_REFRESH_MS)
  }, ROOM_ROSTER_REFRESH_MS)
  return () => clock.cancel(timer)
}

interface GroupRosterMember {
  member: Nip29Member
  known: PeerInfo | null
  lastSeenAt: number
  isOnline: boolean
  isBlocked: boolean
  isTrusted: boolean
  isAgnostrClient: boolean
  clientName?: string
}

export type RoomRoster =
  | { type: 'channel'; peers: PeerInfo[]; sampledAt: number }
  | { type: 'server'; members: GroupRosterMember[]; sampledAt: number }

export function roomRosterKey(engine: AgnostrEngine): string | null {
  const { activeView, activeGeohash, identity } = engine
  if (activeView.type === 'dm') return null
  // A group's member list is shared across its channels.
  const room = activeView.type === 'channel'
    ? ['channel', activeGeohash]
    : ['server', activeView.serverId]
  return JSON.stringify([engine.profiles.activeProfileId, identity.masterPubkey, ...room])
}

export function captureRoomRoster(engine: AgnostrEngine): RoomRoster | null {
  const { activeView, broadcastClientTag, servers } = engine
  if (activeView.type === 'dm') return null
  const sampledAt = Math.floor(Date.now() / 1000)
  if (activeView.type === 'channel') {
    return {
      type: 'channel',
      sampledAt,
      peers: engine.readRoomPeers().map((p) => {
        const isAgnostrClient = p.isSelf
          ? Boolean(p.isAgnostrClient ?? broadcastClientTag)
          : Boolean(p.isAgnostrClient)
        return {
          ...p,
          pubkey: p.pubkey.toLowerCase(),
          channels: [...p.channels],
          isBlocked: !p.isSelf && engine.isPeerBlocked(p.pubkey),
          isTrusted: !p.isSelf && engine.isExplicitlyTrusted(p.pubkey),
          isAgnostrClient,
          clientName: p.clientName ?? (isAgnostrClient ? 'agnostr' : undefined),
        }
      }),
    }
  }

  const lastSeenByPubkey = new Map<string, number>()
  for (const msg of servers.messages) {
    if (msg.isSystem || msg.isBlockedPlaceholder || !msg.pubkey) continue
    const pk = msg.pubkey.toLowerCase()
    if (msg.createdAt > (lastSeenByPubkey.get(pk) ?? 0)) {
      lastSeenByPubkey.set(pk, msg.createdAt)
    }
  }

  return {
    type: 'server',
    sampledAt,
    members: servers.members.map((m) => {
      const pk = m.pubkey.toLowerCase()
      const peer = engine.getPeerByPubkey(pk)
      const isAgnostrClient = m.isSelf
        ? Boolean(peer?.isAgnostrClient ?? broadcastClientTag)
        : Boolean(peer?.isAgnostrClient)
      return {
        member: { ...m, roles: [...m.roles] },
        known: peer ? { ...peer, channels: [...peer.channels] } : null,
        lastSeenAt: m.isSelf
          ? sampledAt
          : Math.max(peer?.lastSeenAt ?? 0, lastSeenByPubkey.get(pk) ?? 0),
        isOnline: m.isSelf || Boolean(peer?.isOnline),
        isBlocked: !m.isSelf && engine.isPeerBlocked(pk),
        isTrusted: !m.isSelf && engine.isExplicitlyTrusted(pk),
        isAgnostrClient,
        clientName: peer?.clientName ?? (isAgnostrClient ? 'agnostr' : undefined),
      }
    }),
  }
}
