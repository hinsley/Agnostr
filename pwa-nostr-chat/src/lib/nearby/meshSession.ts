import {
  ANNOUNCE, LEAVE, MESSAGE, NOSTR_CARRIER, createFragmentCollector, decodeCarrier, decodePacket, equal, hex, proofId,
  readAnnouncement, safeText, verifyPacket, type MeshPacket, type MeshCarrier,
} from './meshWire.ts'

const PEER_LIFETIME = 120_000
const MAX_AGE = 300_000
const MAX_PEERS = 64

interface Peer { name: string; key: Uint8Array; heard: number; stamp: number; gateway: boolean }
export interface MeshPeer { id: string; name: string; heard: number; gateway: boolean }
interface Pending { packet: MeshPacket; link: string; seenAt: number }

export interface NearbyMessage {
  id: string
  name: string
  sender: string
  body: string
  when: number
  local?: boolean
  status?: 'queued' | 'failed'
}

export interface MeshObservation {
  relay: MeshPacket
  ingress: string
  message?: NearbyMessage
  // An authenticated outer signature is required for a directed deposit.
  // All enclosed events, including unsigned broadcasts, still require
  // separate Nostr signature/tag/freshness checks before use or forwarding.
  carrier?: MeshCarrier
}

export function createMeshSession(localId: string, now = () => Date.now()) {
  const peers = new Map<string, Peer>()
  const seen = new Map<string, number>()
  const pending = new Map<string, Pending>()
  const fragments = createFragmentCollector()

  function prune(time: number) {
    for (const [key, peer] of peers) if (time - peer.heard > PEER_LIFETIME) peers.delete(key)
    for (const [key, item] of pending) if (time - item.seenAt > 8_000) pending.delete(key)
    for (const [key, expiry] of seen) if (time > expiry) seen.delete(key)
  }

  function mark(id: string, time: number) {
    seen.set(id, time + MAX_AGE)
    if (seen.size > 512) seen.delete(seen.keys().next().value!)
  }

  function accept(packet: MeshPacket, link: string, time: number): MeshObservation[] {
    const sender = hex(packet.sender)
    if (sender === localId || Math.abs(time - packet.when) > MAX_AGE) return []
    const id = proofId(packet)
    if (seen.has(id)) return []
    const known = peers.get(sender)
    if (packet.type === ANNOUNCE) {
      const announce = readAnnouncement(packet)
      if (!announce || (known && (!equal(known.key, announce.signingKey) || known.stamp >= packet.when))) return []
      if (!known && peers.size >= MAX_PEERS) return []
      mark(id, time)
      peers.set(sender, { name: announce.name, key: announce.signingKey, heard: time, stamp: packet.when, gateway: announce.gateway })
      const events: MeshObservation[] = [{ relay: packet, ingress: link }]
      for (const [key, item] of pending) if (equal(item.packet.sender, packet.sender)) {
        pending.delete(key)
        events.push(...accept(item.packet, item.link, time))
      }
      return events
    }
    const carrier = packet.type === NOSTR_CARRIER ? decodeCarrier(packet.payload) : null
    if (packet.type === NOSTR_CARRIER && (!carrier
      || (carrier.direction === 'toGateway' ? !packet.recipient : !!packet.recipient || packet.broadcast))) return []
    const unsignedDownlink = carrier?.direction === 'fromGateway'
    if (!unsignedDownlink) {
      if (!known) {
        if ((packet.type === MESSAGE || carrier) && packet.signature && pending.size < 24) {
          const candidate = id + hex(packet.signature)
          if (!pending.has(candidate)) pending.set(candidate, { packet, link, seenAt: time })
        }
        return []
      }
      if (!verifyPacket(packet, known.key)) return []
    }
    if (carrier) {
      mark(id, time)
      // Directed destination is the 8-byte relay.recipient, not the link id.
      // The caller decides if it is the destination and validates the
      // enclosed Nostr event before publishing, injecting or relaying.
      return [{ relay: packet, ingress: link, carrier }]
    }
    if (!known) return []
    if (packet.type === LEAVE) {
      if (packet.when < known.stamp) return []
      mark(id, time)
      peers.delete(sender)
      return [{ relay: packet, ingress: link }]
    }
    if (packet.type !== MESSAGE) return []
    const body = safeText(packet.payload)
    if (!body?.trim() || body.length > 2500) return []
    mark(id, time)
    known.heard = time
    return [{ relay: packet, ingress: link, message: { id, sender, name: known.name, body, when: packet.when } }]
  }

  return {
    receive(wire: Uint8Array, link: string) {
      const time = now()
      prune(time)
      const outer = decodePacket(wire)
      if (!outer || hex(outer.sender) === localId || Math.abs(time - outer.when) > MAX_AGE) return []
      const packet = fragments.receive(outer, time)
      return packet ? accept(packet, link, time) : []
    },
    peers(): MeshPeer[] {
      prune(now())
      return Array.from(peers, ([id, { name, heard, gateway }]) => ({ id, name, heard, gateway }))
    },
    peerCount() { prune(now()); return peers.size },
    clear() { peers.clear(); pending.clear(); seen.clear(); fragments.clear() },
  }
}
