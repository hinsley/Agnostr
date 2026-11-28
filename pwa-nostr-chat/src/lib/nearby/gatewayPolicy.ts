import { finalizeEvent, generateSecretKey, verifyEvent, type Event as NostrEvent, type EventTemplate } from 'nostr-tools'

const GEO = /^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/
const EVENT_ID = /^[0-9a-f]{64}$/
const SIGNATURE = /^[0-9a-f]{128}$/
const EPHEMERAL = 20000
const KIND_TORRENT_SIGNAL = 25057
const KIND_TORRENT_STATUS = 30078
const TORRENT_TAG_NAME = 'agnostr-torrent'
const TORRENT_STATUS_TAG = 'agnostr-torrent-status'
const TORRENT_DIRECT_SIGNAL_TAGS = new Set(['agnostr-torrent-sig-v1', 'agnostr-torrent-sig'])
const TORRENT_SWARM_TAG_RE = /^agnostr-torrent-[0-9a-f]{24,64}$/
const TORRENT_STATUS_DTAG_RE = /^agnostr-torrent-status:[0-9a-f]{24,64}$/
export const TORRENT_BRIDGE_CARRIER_CHANNEL = 'trrnt0'
export const GATEWAY_MAX_EVENT_BYTES = 4096
const TORRENT_STATUS_MAX_BYTES = 1024
const MAX_AGE_SEC = 900
const TORRENT_SIGNAL_MAX_AGE_SEC = 120
const TORRENT_SEEN_LIMIT = 2048
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function isGatewayGeohash(geohash: string) { return GEO.test(geohash) }

export type GatewayCarrier = {
  direction: 'toGateway' | 'fromGateway'
  geohash: string
  eventJSON: Uint8Array
}

function parseTorrentBridgeEvent(
  event: unknown,
  timeSec: number,
  verifySig: boolean,
  rawByteLength?: number
): NostrEvent | null {
  if (!event || typeof event !== 'object') return null
  const e = event as Record<string, unknown>
  if (
    (e.kind !== KIND_TORRENT_SIGNAL && e.kind !== KIND_TORRENT_STATUS) ||
    typeof e.created_at !== 'number' ||
    !Number.isSafeInteger(e.created_at) ||
    typeof e.content !== 'string' ||
    !e.content.trim() ||
    typeof e.id !== 'string' ||
    !EVENT_ID.test(e.id) ||
    typeof e.pubkey !== 'string' ||
    !EVENT_ID.test(e.pubkey) ||
    typeof e.sig !== 'string' ||
    !SIGNATURE.test(e.sig) ||
    !Array.isArray(e.tags) ||
    e.tags.length > 16 ||
    !e.tags.every(
      (tag) => Array.isArray(tag) && tag.length <= 4 && tag.every((value) => typeof value === 'string')
    )
  ) {
    return null
  }

  const tags = e.tags as string[][]
  const copy: NostrEvent = {
    id: e.id,
    pubkey: e.pubkey,
    sig: e.sig,
    kind: e.kind,
    created_at: e.created_at,
    tags,
    content: e.content,
  }

  const byteLen = rawByteLength ?? encoder.encode(JSON.stringify(copy)).length
  if (copy.kind === KIND_TORRENT_SIGNAL) {
    if (byteLen > GATEWAY_MAX_EVENT_BYTES) return null
    if (Math.abs(copy.created_at - timeSec) > TORRENT_SIGNAL_MAX_AGE_SEC) return null
    const hasDirectTag = tags.some((tag) => tag[0] === 't' && TORRENT_DIRECT_SIGNAL_TAGS.has(tag[1] ?? ''))
    const hasRecipientP = tags.some((tag) => tag[0] === 'p' && EVENT_ID.test(tag[1] ?? ''))
    const hasSwarmTag = tags.some((tag) => tag[0] === 't' && TORRENT_SWARM_TAG_RE.test(tag[1] ?? ''))
    if (!((hasDirectTag && hasRecipientP) || hasSwarmTag)) return null
  } else {
    if (byteLen > TORRENT_STATUS_MAX_BYTES) return null
    if (copy.created_at < 1_500_000_000 || copy.created_at > timeSec + 300) return null
    const hasStatusDTag = tags.some((tag) => tag[0] === 'd' && TORRENT_STATUS_DTAG_RE.test(tag[1] ?? ''))
    const hasStatusTTag = tags.some((tag) => tag[0] === 't' && tag[1] === TORRENT_STATUS_TAG)
    if (!hasStatusDTag || !hasStatusTTag) return null
  }

  if (verifySig && !verifyEvent(copy)) return null
  return copy
}

export function isTorrentBridgeEvent(
  event: unknown,
  timeSec = Math.floor(Date.now() / 1000)
): boolean {
  return parseTorrentBridgeEvent(event, timeSec, true) !== null
}

function parseEvent(event: unknown, geohash: string, timeSec: number): NostrEvent | null {
  if (!isGatewayGeohash(geohash) || !event || typeof event !== 'object') return null
  const e = event as Record<string, unknown>
  if (e.kind !== EPHEMERAL || typeof e.created_at !== 'number' || !Number.isSafeInteger(e.created_at)
    || Math.abs(e.created_at - timeSec) > MAX_AGE_SEC || typeof e.content !== 'string' || !e.content.trim()
    || typeof e.id !== 'string' || !EVENT_ID.test(e.id)
    || typeof e.pubkey !== 'string' || !EVENT_ID.test(e.pubkey)
    || typeof e.sig !== 'string' || !SIGNATURE.test(e.sig)
    || !Array.isArray(e.tags) || e.tags.length > 32 || !e.tags.every(tag =>
      Array.isArray(tag) && tag.length <= 8 && tag.every(value => typeof value === 'string'))) return null
  const geoTags = e.tags.filter(tag => tag[0] === 'g')
  if (geoTags.length !== 1 || geoTags[0][1] !== geohash) return null
  // Copy only signed Nostr fields. No native identifiers or relay URLs ride along.
  return { id: e.id, pubkey: e.pubkey, sig: e.sig, kind: e.kind, created_at: e.created_at, tags: e.tags, content: e.content }
}

function unpack(carrier: GatewayCarrier, timeSec: number) {
  if (!carrier.eventJSON.length || carrier.eventJSON.length > GATEWAY_MAX_EVENT_BYTES) return null
  try { return parseEvent(JSON.parse(decoder.decode(carrier.eventJSON)), carrier.geohash, timeSec) }
  catch { return null }
}

function unpackTorrent(carrier: GatewayCarrier, timeSec: number): NostrEvent | null {
  if (
    carrier.geohash !== TORRENT_BRIDGE_CARRIER_CHANNEL ||
    !carrier.eventJSON.length ||
    carrier.eventJSON.length > GATEWAY_MAX_EVENT_BYTES
  ) {
    return null
  }
  try {
    return parseTorrentBridgeEvent(
      JSON.parse(decoder.decode(carrier.eventJSON)),
      timeSec,
      true,
      carrier.eventJSON.length
    )
  } catch {
    return null
  }
}

export function createGatewayPolicy(clock = () => Date.now()) {
  type Role = 'uplink' | 'downlink' | 'received' | 'local'
  const seen = new Map<string, Set<Role>>()
  const torrentSeen = new Map<string, Set<Role>>()
  const depositors = new Map<string, { began: number; count: number }>()
  const torrentDepositors = new Map<string, { began: number; count: number }>()
  const identities = new Map<string, Uint8Array>()
  let outboundWindow = { began: 0, count: 0 }
  let inboundWindow = { began: 0, count: 0 }
  let torrentOutboundWindow = { began: 0, count: 0 }
  let torrentInboundWindow = { began: 0, count: 0 }

  function allow(window: { began: number; count: number }, max: number) {
    const now = clock()
    if (now - window.began >= 60_000 || now < window.began) { window.began = now; window.count = 0 }
    return ++window.count <= max
  }

  function mark(id: string, role: Role) {
    const roles = seen.get(id) ?? new Set<Role>()
    roles.add(role)
    seen.set(id, roles)
    if (seen.size > 512) seen.delete(seen.keys().next().value!)
  }

  function markTorrent(id: string, role: Role) {
    const roles = torrentSeen.get(id) ?? new Set<Role>()
    roles.add(role)
    torrentSeen.set(id, roles)
    if (torrentSeen.size > TORRENT_SEEN_LIMIT) {
      torrentSeen.delete(torrentSeen.keys().next().value!)
    }
  }

  function limitedDeposit(sender: string) {
    if (!/^[0-9a-f]{16}$/.test(sender) || !allow(inboundWindow, 40)) return false
    let bucket = depositors.get(sender)
    if (!bucket && depositors.size >= 64) {
      for (const [key, value] of depositors) if (clock() - value.began >= 60_000) depositors.delete(key)
    }
    if (!bucket && depositors.size < 64) {
      bucket = { began: clock(), count: 0 }
      depositors.set(sender, bucket)
    }
    return !!bucket && allow(bucket, 10)
  }

  function limitedTorrentDeposit(sender: string) {
    if (!/^[0-9a-f]{16}$/.test(sender) || !allow(torrentInboundWindow, 480)) return false
    let bucket = torrentDepositors.get(sender)
    if (!bucket && torrentDepositors.size >= 64) {
      for (const [key, value] of torrentDepositors) {
        if (clock() - value.began >= 60_000) torrentDepositors.delete(key)
      }
    }
    if (!bucket && torrentDepositors.size < 64) {
      bucket = { began: clock(), count: 0 }
      torrentDepositors.set(sender, bucket)
    }
    return !!bucket && allow(bucket, 240)
  }

  const pack = (event: NostrEvent, geohash: string, direction: GatewayCarrier['direction']): GatewayCarrier | null => {
    const eventJSON = encoder.encode(JSON.stringify(event))
    return eventJSON.length <= GATEWAY_MAX_EVENT_BYTES ? { direction, geohash, eventJSON } : null
  }

  return {
    signOffline(template: EventTemplate, geohash: string) {
      if (!isGatewayGeohash(geohash) || template.kind !== EPHEMERAL || encoder.encode(template.content).length > 480) return null
      // A phone without internet must not need an extension or share its master identity with the gateway.
      // Keep each geohash distinct within this foreground session and deliberately omit a payment address.
      let secret = identities.get(geohash)
      if (!secret) {
        if (identities.size >= 32) {
          const first = identities.keys().next().value!
          identities.get(first)?.fill(0)
          identities.delete(first)
        }
        secret = generateSecretKey()
        identities.set(geohash, secret)
      }
      const tags = [
        ['g', geohash],
        ...template.tags.filter(
          (tag) =>
            ['n', 'e', 'p'].includes(tag[0]) ||
            (tag[0] === TORRENT_TAG_NAME && tag.length === 2 && tag[1].length <= 2048)
        ),
      ]
      return finalizeEvent({ ...template, tags }, secret)
    },
    localPacket(event: NostrEvent, geohash: string) {
      if (!parseEvent(event, geohash, clock() / 1000)) return null
      const packet = pack(event, geohash, 'toGateway')
      if (packet) mark(event.id, 'local')
      return packet
    },
    localMeshPacket(event: NostrEvent, geohash: string) {
      if (!parseEvent(event, geohash, clock() / 1000)) return null
      const packet = pack(event, geohash, 'fromGateway')
      if (packet) mark(event.id, 'local')
      return packet
    },
    acceptUplink(carrier: GatewayCarrier, sender: string, sharing: boolean) {
      if (!sharing || carrier.direction !== 'toGateway') return null
      const event = unpack(carrier, clock() / 1000)
      if (!event || seen.has(event.id) || !limitedDeposit(sender) || !verifyEvent(event)) return null
      mark(event.id, 'uplink')
      return event
    },
    acceptTransit(carrier: GatewayCarrier, sender: string) {
      const event = carrier.direction === 'toGateway' ? unpack(carrier, clock() / 1000) : null
      return !!event && limitedDeposit(sender) && verifyEvent(event)
    },
    acceptDownlink(carrier: GatewayCarrier, currentChannel: string) {
      if (carrier.direction !== 'fromGateway') return null
      const event = unpack(carrier, clock() / 1000)
      if (!event || !allow(inboundWindow, 40) || !verifyEvent(event)) return null
      const prior = seen.get(event.id)
      if (prior?.has('uplink') || prior?.has('local') || prior?.has('received') || prior?.has('downlink')) return null
      // The type is also used for passing a verified packet along the local BLE mesh.
      // Show only the selected channel, but absorb a replay and never publish it back to Nostr.
      mark(event.id, 'received')
      return { event, show: carrier.geohash === currentChannel }
    },
    relayPacket(event: NostrEvent, geohash: string, sharing: boolean) {
      if (!sharing || seen.has(event.id) || !parseEvent(event, geohash, clock() / 1000) || !allow(outboundWindow, 30)) return null
      // Recheck signatures on the detached copy independently of any ambient Nostr library cache.
      const detached = parseEvent(event, geohash, clock() / 1000)!
      if (!verifyEvent(detached)) return null
      const packet = pack(detached, geohash, 'fromGateway')
      if (packet) mark(event.id, 'downlink')
      return packet
    },
    localTorrentPacket(event: NostrEvent) {
      const detached = parseTorrentBridgeEvent(event, clock() / 1000, false)
      if (!detached) return null
      const packet = pack(detached, TORRENT_BRIDGE_CARRIER_CHANNEL, 'toGateway')
      if (packet) markTorrent(detached.id, 'local')
      return packet
    },
    localMeshTorrentPacket(event: NostrEvent) {
      const detached = parseTorrentBridgeEvent(event, clock() / 1000, false)
      if (!detached) return null
      const packet = pack(detached, TORRENT_BRIDGE_CARRIER_CHANNEL, 'fromGateway')
      if (packet) markTorrent(detached.id, 'local')
      return packet
    },
    acceptTorrentUplink(carrier: GatewayCarrier, sender: string, sharing: boolean) {
      if (!sharing || carrier.direction !== 'toGateway') return null
      const event = unpackTorrent(carrier, clock() / 1000)
      if (!event || torrentSeen.has(event.id) || !limitedTorrentDeposit(sender)) return null
      markTorrent(event.id, 'uplink')
      return event
    },
    acceptTorrentTransit(carrier: GatewayCarrier, sender: string) {
      const event = carrier.direction === 'toGateway' ? unpackTorrent(carrier, clock() / 1000) : null
      return !!event && limitedTorrentDeposit(sender)
    },
    acceptTorrentDownlink(carrier: GatewayCarrier) {
      if (carrier.direction !== 'fromGateway') return null
      const event = unpackTorrent(carrier, clock() / 1000)
      if (!event || !allow(torrentInboundWindow, 480)) return null
      const prior = torrentSeen.get(event.id)
      if (prior?.has('uplink') || prior?.has('local') || prior?.has('received') || prior?.has('downlink')) return null
      markTorrent(event.id, 'received')
      return event
    },
    relayTorrentPacket(event: NostrEvent, sharing: boolean) {
      if (!sharing || torrentSeen.has(event.id)) return null
      const detached = parseTorrentBridgeEvent(event, clock() / 1000, true)
      if (!detached || !allow(torrentOutboundWindow, 480)) return null
      const packet = pack(detached, TORRENT_BRIDGE_CARRIER_CHANNEL, 'fromGateway')
      if (packet) markTorrent(detached.id, 'downlink')
      return packet
    },
    reset() {
      for (const secret of identities.values()) secret.fill(0)
      identities.clear()
      depositors.clear()
      torrentDepositors.clear()
      seen.clear()
      torrentSeen.clear()
      outboundWindow = { began: 0, count: 0 }
      inboundWindow = { began: 0, count: 0 }
      torrentOutboundWindow = { began: 0, count: 0 }
      torrentInboundWindow = { began: 0, count: 0 }
    },
  }
}
