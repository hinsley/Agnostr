import type { ChannelPresenceSummary, PeerInfo } from '../types/protocol.ts'
import { getPrecisionInfo, normalizeGeohash } from './geohash.ts'
import { encodeNpubSafe, formatDisplayHandle } from './identity.ts'
import { isTopicChannel } from './bitchatChannel.ts'

export const ONLINE_WINDOW_SEC = 5 * 60 // 5 minutes per docs/GeohashPresenceSpec.md
export const PRESENCE_MIN_INTERVAL_MS = 40_000
export const PRESENCE_MAX_INTERVAL_MS = 80_000

interface PeerRecord {
  pubkey: string
  nickname: string
  lastSeenAt: number
  isTeleported: boolean
  isMeshBridge: boolean
  clientName?: string
  isAgnostrClient: boolean
  messageCount: number
  channels: Set<string>
}

export class PresenceTracker {
  private byChannel = new Map<string, Map<string, PeerRecord>>()
  private globalNicknames = new Map<string, string>()
  private globalChannels = new Map<string, Set<string>>()
  private globalClients = new Map<string, string>()
  private agnostrPeers = new Set<string>()

  recordActivity(opts: {
    geohash: string
    pubkey: string
    seenAtSec: number
    nickname?: string | null
    isTeleported?: boolean
    isMeshBridge?: boolean
    clientName?: string | null
    isAgnostrClient?: boolean
    isMessage?: boolean
  }): void {
    const gh = normalizeGeohash(opts.geohash)
    const pk = opts.pubkey.toLowerCase()
    let channelMap = this.byChannel.get(gh)
    if (!channelMap) {
      channelMap = new Map()
      this.byChannel.set(gh, channelMap)
    }

    const cleanNick = opts.nickname?.trim()
    if (cleanNick) {
      this.globalNicknames.set(pk, cleanNick)
    }
    const cleanClient = opts.clientName?.trim() || (opts.isAgnostrClient ? 'agnostr' : undefined)
    if (cleanClient) {
      this.globalClients.set(pk, cleanClient)
    }
    if (opts.isAgnostrClient || cleanClient?.toLowerCase() === 'agnostr') {
      this.agnostrPeers.add(pk)
    }

    let peerChannels = this.globalChannels.get(pk)
    if (!peerChannels) {
      peerChannels = new Set()
      this.globalChannels.set(pk, peerChannels)
    }
    peerChannels.add(gh)

    const knownAgnostr = Boolean(
      opts.isAgnostrClient ||
        cleanClient?.toLowerCase() === 'agnostr' ||
        this.agnostrPeers.has(pk)
    )
    const knownClient =
      cleanClient || this.globalClients.get(pk) || (knownAgnostr ? 'agnostr' : undefined)
    const existing = channelMap.get(pk)
    if (existing) {
      existing.lastSeenAt = Math.max(existing.lastSeenAt, opts.seenAtSec)
      if (cleanNick) existing.nickname = cleanNick
      if (opts.isTeleported) existing.isTeleported = true
      if (opts.isMeshBridge) existing.isMeshBridge = true
      if (knownClient) existing.clientName = knownClient
      if (knownAgnostr) existing.isAgnostrClient = true
      if (opts.isMessage) existing.messageCount += 1
      existing.channels.add(gh)
    } else {
      channelMap.set(pk, {
        pubkey: pk,
        nickname: cleanNick || this.globalNicknames.get(pk) || `anon${pk.slice(-4)}`,
        lastSeenAt: opts.seenAtSec,
        isTeleported: Boolean(opts.isTeleported),
        isMeshBridge: Boolean(opts.isMeshBridge),
        clientName: knownClient,
        isAgnostrClient: knownAgnostr,
        messageCount: opts.isMessage ? 1 : 0,
        channels: new Set([gh]),
      })
    }
  }

  /**
   * Records a client tag hint (e.g. `['client', 'agnostr']`) observed from any verified event
   * (presence, reaction, location note, or Global Pulse) and backfills existing `PeerRecord`s
   * across channels WITHOUT fabricating presence in channels the peer is not active in.
   * Returns `true` if newly learned or updated.
   */
  recordClientHint(
    pubkey: string,
    clientName?: string | null,
    isAgnostrClient?: boolean
  ): boolean {
    const pk = pubkey.toLowerCase()
    const cleanClient = clientName?.trim() || (isAgnostrClient ? 'agnostr' : undefined)
    const isAgnostr = Boolean(isAgnostrClient || cleanClient?.toLowerCase() === 'agnostr')
    if (!cleanClient && !isAgnostr) return false

    let changed = false
    if (cleanClient && this.globalClients.get(pk) !== cleanClient) {
      this.globalClients.set(pk, cleanClient)
      changed = true
    }
    if (isAgnostr && !this.agnostrPeers.has(pk)) {
      this.agnostrPeers.add(pk)
      changed = true
    }

    const resolvedClient =
      cleanClient || this.globalClients.get(pk) || (isAgnostr ? 'agnostr' : undefined)
    for (const channelMap of this.byChannel.values()) {
      const rec = channelMap.get(pk)
      if (!rec) continue
      if (isAgnostr && !rec.isAgnostrClient) {
        rec.isAgnostrClient = true
        changed = true
      }
      if (resolvedClient && rec.clientName !== resolvedClient) {
        rec.clientName = resolvedClient
        changed = true
      }
    }

    return changed
  }

  isKnownAgnostrPeer(pubkey: string): boolean {
    return this.agnostrPeers.has(pubkey.toLowerCase())
  }

  getKnownClient(pubkey: string): string | undefined {
    const pk = pubkey.toLowerCase()
    return this.globalClients.get(pk) ?? (this.agnostrPeers.has(pk) ? 'agnostr' : undefined)
  }

  setSelfAgnostrFlag(pubkey: string, enabled: boolean): void {
    const pk = pubkey.toLowerCase()
    if (enabled) {
      this.agnostrPeers.add(pk)
      this.globalClients.set(pk, 'agnostr')
    } else {
      this.agnostrPeers.delete(pk)
      this.globalClients.delete(pk)
    }
    for (const channelMap of this.byChannel.values()) {
      const rec = channelMap.get(pk)
      if (rec) {
        rec.isAgnostrClient = enabled
        rec.clientName = enabled ? 'agnostr' : undefined
      }
    }
  }

  getNickname(pubkey: string): string | null {
    return this.globalNicknames.get(pubkey.toLowerCase()) ?? null
  }

  getPeers(
    geohash: string,
    ownPubkeys: Set<string>,
    blockedPubkeys: Set<string>,
    nowSec = Math.floor(Date.now() / 1000)
  ): PeerInfo[] {
    const gh = normalizeGeohash(geohash)
    const channelMap = this.byChannel.get(gh)
    if (!channelMap) return []

    const list: PeerInfo[] = []
    for (const rec of channelMap.values()) {
      const isOnline = nowSec - rec.lastSeenAt <= ONLINE_WINDOW_SEC
      const nick = this.globalNicknames.get(rec.pubkey) || rec.nickname
      const isAgnostr = rec.isAgnostrClient || this.agnostrPeers.has(rec.pubkey)
      const clientName =
        rec.clientName || this.globalClients.get(rec.pubkey) || (isAgnostr ? 'agnostr' : undefined)
      list.push({
        pubkey: rec.pubkey,
        npub: encodeNpubSafe(rec.pubkey),
        nickname: nick,
        displayHandle: formatDisplayHandle(nick, rec.pubkey),
        lastSeenAt: rec.lastSeenAt,
        isOnline,
        isSelf: ownPubkeys.has(rec.pubkey),
        isTeleported: rec.isTeleported,
        isMeshBridge: rec.isMeshBridge,
        clientName,
        isAgnostrClient: isAgnostr,
        isBlocked: blockedPubkeys.has(rec.pubkey),
        messageCount: rec.messageCount,
        channels: Array.from(this.globalChannels.get(rec.pubkey) ?? rec.channels),
      })
    }

    list.sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1
      return b.lastSeenAt - a.lastSeenAt
    })

    return list
  }

  getPeerByPubkey(
    pubkey: string,
    ownPubkeys: Set<string>,
    blockedPubkeys: Set<string>,
    nowSec = Math.floor(Date.now() / 1000)
  ): PeerInfo | null {
    const pk = pubkey.toLowerCase()
    let latest: PeerRecord | null = null
    let totalMessages = 0
    for (const map of this.byChannel.values()) {
      const rec = map.get(pk)
      if (rec) {
        totalMessages += rec.messageCount
        if (!latest || rec.lastSeenAt > latest.lastSeenAt) {
          latest = rec
        }
      }
    }
    const nick = this.globalNicknames.get(pk) || latest?.nickname || `anon${pk.slice(-4)}`
    const isAgnostr = Boolean(latest?.isAgnostrClient || this.agnostrPeers.has(pk))
    const clientName =
      latest?.clientName || this.globalClients.get(pk) || (isAgnostr ? 'agnostr' : undefined)
    return {
      pubkey: pk,
      npub: encodeNpubSafe(pk),
      nickname: nick,
      displayHandle: formatDisplayHandle(nick, pk),
      lastSeenAt: latest?.lastSeenAt ?? 0,
      isOnline: latest ? nowSec - latest.lastSeenAt <= ONLINE_WINDOW_SEC : false,
      isSelf: ownPubkeys.has(pk),
      isTeleported: latest?.isTeleported ?? false,
      isMeshBridge: latest?.isMeshBridge ?? false,
      clientName,
      isAgnostrClient: isAgnostr,
      isBlocked: blockedPubkeys.has(pk),
      messageCount: totalMessages,
      channels: Array.from(this.globalChannels.get(pk) ?? []),
    }
  }

  getSummary(
    geohash: string,
    peers: readonly PeerInfo[],
    presenceBroadcastEnabled: boolean
  ): ChannelPresenceSummary {
    const visiblePeers = peers.filter((p) => !p.isBlocked)
    const onlinePeers = visiblePeers.filter((p) => p.isOnline)
    if (isTopicChannel(geohash)) {
      return {
        onlineCount: onlinePeers.length,
        totalSeenCount: visiblePeers.length,
        isUncertainCount: false,
        isBroadcastingPresence: false,
      }
    }
    const gh = normalizeGeohash(geohash)
    const info = getPrecisionInfo(gh.length)
    const nonSelfOnline = onlinePeers.filter((p) => !p.isSelf)
    const isBroadcastingPresence = presenceBroadcastEnabled && info.allowsPresence
    // Per GeohashPresenceSpec.md: high precision (>=6) with 0 detected other peers shows uncertain "?"
    const isUncertainCount = !info.allowsPresence && nonSelfOnline.length === 0

    return {
      onlineCount: onlinePeers.length,
      totalSeenCount: visiblePeers.length,
      isUncertainCount,
      isBroadcastingPresence,
    }
  }

  clear(): void {
    this.byChannel.clear()
    this.globalNicknames.clear()
    this.globalChannels.clear()
    this.globalClients.clear()
    this.agnostrPeers.clear()
  }
}

export function canBroadcastPresenceForGeohash(geohash: string, enabled: boolean): boolean {
  if (!enabled || isTopicChannel(geohash)) return false
  const gh = normalizeGeohash(geohash)
  return gh.length >= 1 && getPrecisionInfo(gh.length).allowsPresence
}

export function nextPresenceDelayMs(): number {
  return Math.round(
    PRESENCE_MIN_INTERVAL_MS + Math.random() * (PRESENCE_MAX_INTERVAL_MS - PRESENCE_MIN_INTERVAL_MS)
  )
}
