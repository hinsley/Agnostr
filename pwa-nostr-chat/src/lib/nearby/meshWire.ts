import { ed25519, x25519 } from '@agnostr/mesh-curves/ed25519.js'
import { Inflate, deflateRaw } from 'pako'
import { sha256 } from '@noble/hashes/sha256'

export const ANNOUNCE = 1
export const MESSAGE = 2
export const LEAVE = 3
export const FRAGMENT = 32
export const NOSTR_CARRIER = 0x28
const GATEWAY_CAPABILITY = 1 << 2
const MAX_CARRIER_EVENT = 16 * 1024
const MAX_CARRIER_PAYLOAD = MAX_CARRIER_EVENT + 128
const geohashPattern = /^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/u
export const MAX_TEXT_BYTES = 480
const MAX_PACKET = 20 * 1024
const RECIPIENT = 1
const SIGNED = 2
const COMPRESSED = 4
const ROUTED = 8
const RSR = 16
const MAX_ROUTE = 32
const MAX_DEFLATE_RATIO = 1032 // stock Bitchat / maximum achievable raw DEFLATE ratio
const HEADER = 14
const ID = 8
const SIGNATURE = 64
const FRAGMENT_HEADER = 13
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })
const random = (size: number) => crypto.getRandomValues(new Uint8Array(size))

export const encodeText = (text: string) => textEncoder.encode(text)
export const hex = (v: Uint8Array) => Array.from(v, x => x.toString(16).padStart(2, '0')).join('')
export const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((n, i) => n === b[i])
const identityId = (noiseKey: Uint8Array) => sha256(noiseKey).slice(0, ID)
export const safeText = (bytes: Uint8Array): string | null => {
  try { return textDecoder.decode(bytes) } catch { return null }
}

export interface MeshPacket {
  version: number
  type: number
  ttl: number
  when: number
  sender: Uint8Array
  payload: Uint8Array
  signature?: Uint8Array
  broadcast?: boolean
  recipient?: Uint8Array
  route?: Uint8Array[]
  rsr?: boolean
  compressed?: Uint8Array | null
}

function compressedPayload(bytes: Uint8Array, width: number, apple: boolean): Uint8Array | undefined {
  if (bytes.length < 100 || new Set(bytes).size * 10 >= Math.min(bytes.length, 256) * 9) return
  // Apple's Compression.framework COMPRESSION_ZLIB uses DEFLATE level 5.
  // Bitchat 1.8.0 reconstructs the compressed canonical bytes when verifying.
  const data = apple ? deflateRaw(bytes, { level: 5 }) : deflateRaw(bytes)
  if (!data.length || data.length >= bytes.length || bytes.length > data.length * MAX_DEFLATE_RATIO) return
  const wrapped = new Uint8Array(width + data.length)
  const size = new DataView(wrapped.buffer)
  if (width === 4) size.setUint32(0, bytes.length)
  else size.setUint16(0, bytes.length)
  wrapped.set(data, width)
  return wrapped
}

function decompressPayload(bytes: Uint8Array, width: number, limit: number): Uint8Array | null {
  if (bytes.length <= width) return null
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = width === 4 ? header.getUint32(0) : header.getUint16(0)
  if (!count || count > limit || count > (bytes.length - width) * MAX_DEFLATE_RATIO) return null
  try {
    const data = new Uint8Array(count)
    const inflate = new Inflate({ raw: true, chunkSize: 1024 })
    let read = 0
    inflate.onData = chunk => {
      if (typeof chunk === 'string') throw new Error('Unexpected expanded type')
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      if (read + bytes.length > count) throw new Error('Unexpected expanded size')
      data.set(bytes, read)
      read += bytes.length
    }
    return inflate.push(bytes.subarray(width), true) && !inflate.err && read === count ? data : null
  } catch { return null }
}

export function encodePacket(packet: MeshPacket): Uint8Array {
  const header = packet.version === 2 ? 16 : HEADER
  const width = packet.version === 2 ? 4 : 2
  const compressed = packet.compressed === undefined && packet.type !== FRAGMENT
    ? compressedPayload(packet.payload, width, packet.type === NOSTR_CARRIER)
    : packet.compressed
  const payload = compressed ?? packet.payload
  const hasRecipient = packet.broadcast || !!packet.recipient
  const hops = packet.version === 2 ? packet.route : undefined
  const routeSize = hops?.length ? 1 + ID * hops.length : 0
  const routeOffset = header + ID + (hasRecipient ? ID : 0)
  const offset = routeOffset + routeSize
  const wire = new Uint8Array(offset + payload.length + (packet.signature ? SIGNATURE : 0))
  const view = new DataView(wire.buffer)
  wire.set([packet.version, packet.type, packet.ttl], 0)
  view.setBigUint64(3, BigInt(packet.when))
  wire[11] = (hasRecipient ? RECIPIENT : 0) | (packet.signature ? SIGNED : 0)
    | (compressed ? COMPRESSED : 0) | (routeSize ? ROUTED : 0) | (packet.rsr ? RSR : 0)
  if (packet.version === 2) view.setUint32(12, payload.length)
  else view.setUint16(12, payload.length)
  wire.set(packet.sender, header)
  if (packet.broadcast) wire.fill(255, header + ID, routeOffset)
  else if (packet.recipient) wire.set(packet.recipient, header + ID)
  if (hops?.length) {
    wire[routeOffset] = hops.length
    hops.forEach((hop, index) => wire.set(hop, routeOffset + 1 + index * ID))
  }
  wire.set(payload, offset)
  if (packet.signature) wire.set(packet.signature, wire.length - SIGNATURE)
  return wire
}

export function decodePacket(wire: Uint8Array): MeshPacket | null {
  if (wire.length < HEADER + ID || wire.length > MAX_PACKET) return null
  const [version, type, ttl] = wire
  const flags = wire[11]
  if ((version !== 1 && version !== 2) || ttl > 7 || (flags & ~(RECIPIENT | SIGNED | COMPRESSED | ROUTED | RSR)) !== 0) return null
  const header = version === 2 ? 16 : HEADER
  if (wire.length < header + ID || ![ANNOUNCE, MESSAGE, LEAVE, FRAGMENT, NOSTR_CARRIER].includes(type)) return null
  const signed = (flags & SIGNED) !== 0
  const hasRecipient = (flags & RECIPIENT) !== 0
  const routeOffset = header + ID + (hasRecipient ? ID : 0)
  if (routeOffset > wire.length) return null
  const address = hasRecipient ? wire.slice(header + ID, routeOffset) : undefined
  const broadcast = !!address?.every(byte => byte === 255)
  const recipient = broadcast ? undefined : address
  if (recipient && type !== NOSTR_CARRIER && type !== FRAGMENT) return null
  if (type === NOSTR_CARRIER ? signed !== !!recipient : signed === (type === FRAGMENT)) return null
  let route: Uint8Array[] | undefined
  let offset = routeOffset
  if (flags & ROUTED) {
    if (version !== 2 || !recipient || (type !== FRAGMENT && type !== NOSTR_CARRIER)) return null
    const count = wire[routeOffset]
    if (!count || count > MAX_ROUTE || routeOffset + 1 + count * ID > wire.length) return null
    route = Array.from({ length: count }, (_, i) => wire.slice(routeOffset + 1 + i * ID, routeOffset + 1 + (i + 1) * ID))
    offset += 1 + count * ID
  }
  const rsr = (flags & RSR) !== 0
  if (rsr && (!recipient || (type !== FRAGMENT && type !== NOSTR_CARRIER))) return null
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
  const when = Number(view.getBigUint64(3))
  const bytes = version === 2 ? view.getUint32(12) : view.getUint16(12)
  const end = offset + bytes + (signed ? SIGNATURE : 0)
  if (!Number.isSafeInteger(when) || end > wire.length) return null
  const padding = wire.length - end
  if (padding && (padding > 255 || !wire.subarray(end).every(byte => byte === padding))) return null
  const raw = wire.slice(offset, offset + bytes)
  const compressed = flags & COMPRESSED ? raw : null
  const limit = type === NOSTR_CARRIER ? MAX_CARRIER_PAYLOAD : type === FRAGMENT ? 512 : 8192
  const payload = compressed ? decompressPayload(compressed, version === 2 ? 4 : 2, limit) : raw
  if (!payload || payload.length > limit) return null
  return {
    version, type, ttl, when,
    sender: wire.slice(header, header + ID),
    payload, compressed, broadcast, recipient, route, rsr,
    signature: signed ? wire.slice(end - SIGNATURE, end) : undefined,
  }
}

function signingBytes(packet: MeshPacket) {
  const raw = encodePacket({ ...packet, ttl: 0, signature: undefined, rsr: false })
  // Bitchat signs a padded canonical copy even when public GATT frames are unpadded.
  const block = [256, 512, 1024, 2048].find(size => size >= raw.length + 16)
  if (!block || block - raw.length > 255) return raw
  const bytes = new Uint8Array(block).fill(block - raw.length)
  bytes.set(raw)
  return bytes
}
export const proofId = (packet: MeshPacket) => hex(sha256(signingBytes(packet)))

export function verifyPacket(packet: MeshPacket, key: Uint8Array): boolean {
  try { return !!packet.signature && ed25519.verify(packet.signature, signingBytes(packet), key, { zip215: false }) }
  catch { return false }
}

function makeTlv(tag: number, data: Uint8Array) {
  const field = new Uint8Array(2 + data.length)
  field.set([tag, data.length])
  field.set(data, 2)
  return field
}

function concatenate(parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}

export interface MeshAnnouncement { name: string; signingKey: Uint8Array; gateway: boolean }

export function cleanNickname(value: string) {
  const input = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '').trim()
  let name = ''
  for (const character of input) {
    if (encodeText(name + character).length > 32) break
    name += character
  }
  return name || 'Agnostr'
}

export function readAnnouncement(packet: MeshPacket): MeshAnnouncement | null {
  if (packet.type !== ANNOUNCE || packet.payload.length > 512) return null
  const fields = new Map<number, Uint8Array>()
  const payload = packet.payload
  for (let i = 0; i < payload.length;) {
    if (i + 2 > payload.length) return null
    const type = payload[i++], size = payload[i++]
    if (i + size > payload.length || (type <= 6 && fields.has(type))) return null
    fields.set(type, payload.slice(i, i + size))
    i += size
  }
  const name = fields.get(1), noiseKey = fields.get(2), signingKey = fields.get(3)
  if (!name || noiseKey?.length !== 32 || signingKey?.length !== 32 || noiseKey.every(byte => byte === 0)) return null
  if (!equal(identityId(noiseKey), packet.sender) || !verifyPacket(packet, signingKey)) return null
  const decoded = safeText(name)
  const gateway = Boolean((fields.get(5)?.[0] ?? 0) & GATEWAY_CAPABILITY)
  return decoded ? { name: cleanNickname(decoded), signingKey, gateway } : null
}

export interface MeshCarrier {
  direction: 'toGateway' | 'fromGateway'
  geohash: string
  eventJSON: Uint8Array
}

export function encodeCarrier(carrier: MeshCarrier): Uint8Array | null {
  const direction = carrier.direction === 'toGateway' ? 1 : carrier.direction === 'fromGateway' ? 2 : 0
  if (!direction || !geohashPattern.test(carrier.geohash)
    || !carrier.eventJSON.length || carrier.eventJSON.length > MAX_CARRIER_EVENT) return null
  const geohash = encodeText(carrier.geohash)
  const size = carrier.eventJSON.length
  return concatenate([
    Uint8Array.of(1, 0, 1, direction),
    Uint8Array.of(2, 0, geohash.length), geohash,
    Uint8Array.of(3, size >> 8, size & 255), carrier.eventJSON,
  ])
}

export function decodeCarrier(payload: Uint8Array): MeshCarrier | null {
  if (payload.length > MAX_CARRIER_PAYLOAD) return null
  let direction: MeshCarrier['direction'] | undefined
  let geohash: string | null = null
  let eventJSON: Uint8Array | undefined
  for (let i = 0; i < payload.length;) {
    if (i + 3 > payload.length) return null
    const type = payload[i++], size = (payload[i++] << 8) | payload[i++]
    if (i + size > payload.length) return null
    const value = payload.subarray(i, i + size)
    i += size
    if (type === 1) {
      if (direction || size !== 1 || (value[0] !== 1 && value[0] !== 2)) return null
      direction = value[0] === 1 ? 'toGateway' : 'fromGateway'
    } else if (type === 2) {
      if (geohash !== null || !size || size > 12) return null
      geohash = safeText(value)
      if (!geohash || !geohashPattern.test(geohash)) return null
    } else if (type === 3) {
      if (eventJSON || !size || size > MAX_CARRIER_EVENT) return null
      eventJSON = value
    }
  }
  return direction && geohash && eventJSON ? { direction, geohash, eventJSON } : null
}

export function createMeshIdentity(name: string, signingSeed = random(32), noiseSeed = random(32)) {
  const publicSigning = ed25519.getPublicKey(signingSeed)
  const publicNoise = x25519.getPublicKey(noiseSeed)
  const sender = identityId(publicNoise)
  const announcement = [makeTlv(1, encodeText(cleanNickname(name))), makeTlv(2, publicNoise), makeTlv(3, publicSigning)]
  let previous = 0
  function make(type: number, payload: Uint8Array, now = Date.now(), recipient?: Uint8Array) {
    const when = previous = Math.max(previous + 1, now)
    const packet: MeshPacket = { version: 1, type, ttl: 7, when, sender, payload, broadcast: type === MESSAGE, recipient }
    // Stock gateway downlinks omit the packet signature. The carried event
    // has its own required Schnorr signature, validated in the caller.
    return type === NOSTR_CARRIER && !recipient
      ? packet
      : { ...packet, signature: ed25519.sign(signingBytes(packet), signingSeed) }
  }
  return {
    id: hex(sender),
    announce: (now?: number, gateway = false) => make(ANNOUNCE, concatenate(
      gateway ? [...announcement, makeTlv(5, Uint8Array.of(GATEWAY_CAPABILITY))] : announcement), now),
    text: (body: string, now?: number) => make(MESSAGE, encodeText(body), now),
    carrier(carrier: MeshCarrier, recipientPeerId?: string, now?: number): MeshPacket | null {
      if (carrier.direction === 'toGateway' ? !recipientPeerId : !!recipientPeerId) return null
      if (recipientPeerId && (!/^[a-f0-9]{16}$/u.test(recipientPeerId)
        || recipientPeerId === 'ffffffffffffffff' || recipientPeerId === hex(sender))) return null
      const payload = encodeCarrier(carrier)
      if (!payload) return null
      const recipient = recipientPeerId ? Uint8Array.from(recipientPeerId.match(/../gu)!, byte => parseInt(byte, 16)) : undefined
      return make(NOSTR_CARRIER, payload, now, recipient)
    },
    erase: () => { signingSeed.fill(0); noiseSeed.fill(0) },
  }
}

export function framesFor(packet: MeshPacket, maxBytes: number, fragmentId = random(ID)): Uint8Array[] {
  const wire = encodePacket(packet)
  if (maxBytes < 64 || maxBytes > 512 || wire.length > MAX_PACKET) return []
  if (wire.length <= maxBytes) return [wire]
  const version = packet.route?.length ? 2 : 1
  const routeSize = packet.route?.length ? 1 + ID * packet.route.length : 0
  const chunk = maxBytes - (version === 2 ? 16 : HEADER) - ID - FRAGMENT_HEADER
    - (packet.broadcast || packet.recipient ? ID : 0) - routeSize
  if (chunk < 1) return []
  const total = Math.ceil(wire.length / chunk)
  if (total > 128) return []
  return Array.from({ length: total }, (_, index) => {
    const data = wire.subarray(index * chunk, (index + 1) * chunk)
    const payload = new Uint8Array(FRAGMENT_HEADER + data.length)
    payload.set(fragmentId.subarray(0, ID))
    const view = new DataView(payload.buffer)
    view.setUint16(8, index)
    view.setUint16(10, total)
    payload[12] = packet.type
    payload.set(data, FRAGMENT_HEADER)
    return encodePacket({ ...packet, version, type: FRAGMENT, payload, signature: undefined, compressed: null })
  })
}

interface Assembly {
  when: number; created: number; type: number; ttl: number; bytes: number
  pieces: Map<number, Uint8Array>; total: number; recipient?: Uint8Array
}
const sameRecipient = (a?: Uint8Array, b?: Uint8Array) => !a || !b ? a === b : equal(a, b)

export function createFragmentCollector() {
  const assemblies = new Map<string, Assembly>()
  return {
    receive(packet: MeshPacket, now: number): MeshPacket | null {
      if (packet.type !== FRAGMENT) return packet
      if (packet.payload.length <= FRAGMENT_HEADER) return null
      for (const [key, value] of assemblies) if (now - value.created > 30_000) assemblies.delete(key)
      const view = new DataView(packet.payload.buffer, packet.payload.byteOffset, packet.payload.byteLength)
      const index = view.getUint16(8), total = view.getUint16(10), type = packet.payload[12]
      if (index >= total || total > 128 || ![ANNOUNCE, MESSAGE, LEAVE, NOSTR_CARRIER].includes(type)
        || (packet.recipient && type !== NOSTR_CARRIER)) return null
      const key = hex(packet.sender) + ':' + hex(packet.payload.subarray(0, ID))
      let assembly = assemblies.get(key)
      if (!assembly) {
        if (assemblies.size >= 32) return null
        assembly = { when: packet.when, created: now, type, ttl: packet.ttl, bytes: 0, pieces: new Map(), total, recipient: packet.recipient }
        assemblies.set(key, assembly)
      }
      if (assembly.total !== total || assembly.type !== type || assembly.when !== packet.when
        || !sameRecipient(assembly.recipient, packet.recipient) || assembly.pieces.has(index)) return null
      const data = packet.payload.slice(FRAGMENT_HEADER)
      assembly.bytes += data.length
      if (assembly.bytes > MAX_PACKET) { assemblies.delete(key); return null }
      assembly.ttl = Math.min(assembly.ttl, packet.ttl)
      assembly.pieces.set(index, data)
      if (assembly.pieces.size !== total) return null
      assemblies.delete(key)
      const inner = decodePacket(concatenate(Array.from({ length: total }, (_, idx) => assembly!.pieces.get(idx)!)))
      if (!inner || inner.type !== type || inner.when !== assembly.when || !equal(inner.sender, packet.sender)
        || !sameRecipient(assembly.recipient, inner.recipient)) return null
      return { ...inner, ttl: Math.min(inner.ttl, assembly.ttl) }
    },
    clear() { assemblies.clear() },
  }
}
