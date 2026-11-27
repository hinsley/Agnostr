import { finalizeEvent, generateSecretKey, verifyEvent, type Event as NostrEvent, type EventTemplate } from 'nostr-tools'

const GEO = /^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/
const EVENT_ID = /^[0-9a-f]{64}$/
const SIGNATURE = /^[0-9a-f]{128}$/
const EPHEMERAL = 20000
export const GATEWAY_MAX_EVENT_BYTES = 4096
const MAX_AGE_SEC = 900
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function isGatewayGeohash(geohash: string) { return GEO.test(geohash) }

export type GatewayCarrier = {
  direction: 'toGateway' | 'fromGateway'
  geohash: string
  eventJSON: Uint8Array
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

export function createGatewayPolicy(clock = () => Date.now()) {
  type Role = 'uplink' | 'downlink' | 'received' | 'local'
  const seen = new Map<string, Set<Role>>()
  const depositors = new Map<string, { began: number; count: number }>()
  const identities = new Map<string, Uint8Array>()
  let outboundWindow = { began: 0, count: 0 }
  let inboundWindow = { began: 0, count: 0 }

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
      const tags = [['g', geohash], ...template.tags.filter(tag => ['n', 'e', 'p'].includes(tag[0]))]
      return finalizeEvent({ ...template, tags }, secret)
    },
    localPacket(event: NostrEvent, geohash: string) {
      if (!parseEvent(event, geohash, clock() / 1000)) return null
      const packet = pack(event, geohash, 'toGateway')
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
    reset() {
      for (const secret of identities.values()) secret.fill(0)
      identities.clear()
      depositors.clear()
      seen.clear()
      outboundWindow = { began: 0, count: 0 }
      inboundWindow = { began: 0, count: 0 }
    },
  }
}
