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

export type RoomRoster = {
  sampledAt: number
  pendingJoins?: ReadonlySet<string>
} & (
  | { type: 'channel'; peers: PeerInfo[] }
  | { type: 'server'; members: GroupRosterMember[] }
)

export function roomRosterKey(engine: AgnostrEngine): string | null {
  const { activeView, activeGeohash, identity } = engine
  if (activeView.type === 'dm') return null
  // A group's member list is shared across its channels.
  const room = activeView.type === 'channel'
    ? ['channel', activeGeohash]
    : ['server', activeView.serverId]
  return JSON.stringify([engine.profiles.activeProfileId, identity.masterPubkey, ...room])
}

function captureChannelPeers(engine: AgnostrEngine, peers: PeerInfo[]): PeerInfo[] {
  return peers.map((p) => {
    const isAgnostrClient = p.isSelf
      ? Boolean(p.isAgnostrClient ?? engine.broadcastClientTag)
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
  })
}

function captureGroupMembers(
  engine: AgnostrEngine,
  members: Nip29Member[],
  sampledAt: number,
): GroupRosterMember[] {
  const memberKeys = new Set(members.map((m) => m.pubkey.toLowerCase()))
  const lastSeenByPubkey = new Map<string, number>()
  for (const msg of engine.servers.messages) {
    if (msg.isSystem || msg.isBlockedPlaceholder || !msg.pubkey) continue
    const pk = msg.pubkey.toLowerCase()
    if (memberKeys.has(pk) && msg.createdAt > (lastSeenByPubkey.get(pk) ?? 0)) {
      lastSeenByPubkey.set(pk, msg.createdAt)
    }
  }

  return members.map((m) => {
    const pk = m.pubkey.toLowerCase()
    const peer = engine.getPeerByPubkey(pk)
    const isAgnostrClient = m.isSelf
      ? Boolean(peer?.isAgnostrClient ?? engine.broadcastClientTag)
      : Boolean(peer?.isAgnostrClient)
    return {
      member: { ...m, pubkey: pk, roles: [...m.roles] },
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
  })
}

export function captureRoomRoster(engine: AgnostrEngine): RoomRoster | null {
  if (engine.activeView.type === 'dm') return null
  const sampledAt = Math.floor(Date.now() / 1000)
  if (engine.activeView.type === 'channel') {
    return { type: 'channel', sampledAt, peers: captureChannelPeers(engine, engine.readRoomPeers()) }
  }
  return { type: 'server', sampledAt, members: captureGroupMembers(engine, engine.servers.members, sampledAt) }
}

function extractJoins<T extends { pubkey: string }>(
  shown: readonly T[],
  detected: readonly T[],
): T[] {
  const seen = new Set(shown.map((p) => p.pubkey.toLowerCase()))
  return detected.filter((p) => {
    const pk = p.pubkey.toLowerCase()
    if (seen.has(pk)) return false
    seen.add(pk)
    return true
  })
}

/** Add only newly detected keys. Keep all sampled rows (even if departed) and
 * the original sample time until the regular refresh. */
export function appendRoomRosterJoins(roster: RoomRoster, engine: AgnostrEngine): RoomRoster {
  if (roster.type === 'channel' && engine.activeView.type === 'channel') {
    const joins = extractJoins(roster.peers, engine.peers)
    if (joins.length === 0) return roster
    const peers = captureChannelPeers(engine, joins)
    return {
      ...roster,
      peers: [...roster.peers, ...peers],
      pendingJoins: new Set([...(roster.pendingJoins ?? []), ...peers.map((p) => p.pubkey)]),
    }
  }
  if (roster.type === 'server' && engine.activeView.type === 'server') {
    // Banned-only entries aren't new members. Keep them available to the
    // moderation surface at the next full sample, as before.
    const joins = extractJoins(roster.members.map((m) => m.member), engine.servers.members.filter((m) => !m.isBanned))
    if (joins.length === 0) return roster
    const members = captureGroupMembers(engine, joins, Math.floor(Date.now() / 1000))
    return {
      ...roster,
      members: [...roster.members, ...members],
      pendingJoins: new Set([...(roster.pendingJoins ?? []), ...members.map((m) => m.member.pubkey)]),
    }
  }
  return roster
}

/** Sort newly appended rows after sampled rows. Two joins keep arrival order. */
export function compareRoomRosterPosition(
  roster: RoomRoster | null,
  a: string,
  b: string,
  compareSampled: () => number,
): number {
  const newA = roster?.pendingJoins?.has(a) ?? false
  const newB = roster?.pendingJoins?.has(b) ?? false
  if (newA || newB) return Number(newA) - Number(newB)
  return compareSampled()
}
