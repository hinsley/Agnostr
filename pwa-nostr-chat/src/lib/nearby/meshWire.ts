import { ed25519, x25519 } from '@agnostr/mesh-curves/ed25519.js'
import { Inflate, deflateRaw } from 'pako'
import { sha256 } from '@noble/hashes/sha256'

export const ANNOUNCE = 1
export const MESSAGE = 2
export const LEAVE = 3
export const FRAGMENT = 32
export const MAX_TEXT_BYTES = 480
const MAX_PACKET = 8192
const RECIPIENT = 1
const SIGNED = 2
const COMPRESSED = 4
const MAX_DEFLATE_RATIO = 256
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
  compressed?: Uint8Array | null
}

function compressedPayload(bytes: Uint8Array, width: number): Uint8Array | undefined {
  if (bytes.length < 100 || new Set(bytes).size * 10 >= Math.min(bytes.length, 256) * 9) return
  const data = deflateRaw(bytes)
  if (!data.length || data.length >= bytes.length || bytes.length > data.length * MAX_DEFLATE_RATIO) return
  const wrapped = new Uint8Array(width + data.length)
  const size = new DataView(wrapped.buffer)
  if (width === 4) size.setUint32(0, bytes.length)
  else size.setUint16(0, bytes.length)
  wrapped.set(data, width)
  return wrapped
}

function decompressPayload(bytes: Uint8Array, width: number): Uint8Array | null {
  if (bytes.length <= width) return null
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = width === 4 ? header.getUint32(0) : header.getUint16(0)
  if (!count || count > MAX_PACKET || count > (bytes.length - width) * MAX_DEFLATE_RATIO) return null
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
  const compressed = packet.compressed === undefined && packet.type !== FRAGMENT ? compressedPayload(packet.payload, width) : packet.compressed
  const payload = compressed ?? packet.payload
  const offset = header + ID + (packet.broadcast ? ID : 0)
  const wire = new Uint8Array(offset + payload.length + (packet.signature ? SIGNATURE : 0))
  const view = new DataView(wire.buffer)
  wire.set([packet.version, packet.type, packet.ttl], 0)
  view.setBigUint64(3, BigInt(packet.when))
  wire[11] = (packet.broadcast ? RECIPIENT : 0) | (packet.signature ? SIGNED : 0) | (compressed ? COMPRESSED : 0)
  if (packet.version === 2) view.setUint32(12, payload.length)
  else view.setUint16(12, payload.length)
  wire.set(packet.sender, header)
  if (packet.broadcast) wire.fill(255, header + ID, offset)
  wire.set(payload, offset)
  if (packet.signature) wire.set(packet.signature, wire.length - SIGNATURE)
  return wire
}

export function decodePacket(wire: Uint8Array): MeshPacket | null {
  if (wire.length < HEADER + ID || wire.length > MAX_PACKET) return null
  const [version, type, ttl] = wire
  const flags = wire[11]
  if ((version !== 1 && version !== 2) || ttl > 7 || (flags & ~(RECIPIENT | SIGNED | COMPRESSED)) !== 0) return null
  const header = version === 2 ? 16 : HEADER
  if (wire.length < header + ID || ![ANNOUNCE, MESSAGE, LEAVE, FRAGMENT].includes(type)) return null
  const signed = (flags & SIGNED) !== 0
  const broadcast = (flags & RECIPIENT) !== 0
  const offset = header + ID + (broadcast ? ID : 0)
  if (signed === (type === FRAGMENT)) return null
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
  const when = Number(view.getBigUint64(3))
  const bytes = version === 2 ? view.getUint32(12) : view.getUint16(12)
  const end = offset + bytes + (signed ? SIGNATURE : 0)
  if (!Number.isSafeInteger(when) || end > wire.length) return null
  const padding = wire.length - end
  if (padding && (padding > 255 || !wire.subarray(end).every(byte => byte === padding))) return null
  if (broadcast && !wire.subarray(header + ID, offset).every(byte => byte === 255)) return null
  const raw = wire.slice(offset, offset + bytes)
  const compressed = flags & COMPRESSED ? raw : null
  const payload = compressed ? decompressPayload(compressed, version === 2 ? 4 : 2) : raw
  if (!payload) return null
  return {
    version, type, ttl, when,
    sender: wire.slice(header, header + ID),
    payload, compressed, broadcast,
    signature: signed ? wire.slice(end - SIGNATURE, end) : undefined,
  }
}

function signingBytes(packet: MeshPacket) {
  const raw = encodePacket({ ...packet, ttl: 0, signature: undefined })
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

export interface MeshAnnouncement { name: string; signingKey: Uint8Array }

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
    if (i + size > payload.length || (type <= 3 && fields.has(type))) return null
    fields.set(type, payload.slice(i, i + size))
    i += size
  }
  const name = fields.get(1), noiseKey = fields.get(2), signingKey = fields.get(3)
  if (!name || noiseKey?.length !== 32 || signingKey?.length !== 32 || noiseKey.every(byte => byte === 0)) return null
  if (!equal(identityId(noiseKey), packet.sender) || !verifyPacket(packet, signingKey)) return null
  const decoded = safeText(name)
  return decoded ? { name: cleanNickname(decoded), signingKey } : null
}

export function createMeshIdentity(name: string, signingSeed = random(32), noiseSeed = random(32)) {
  const publicSigning = ed25519.getPublicKey(signingSeed)
  const publicNoise = x25519.getPublicKey(noiseSeed)
  const sender = identityId(publicNoise)
  const announcement = concatenate([makeTlv(1, encodeText(cleanNickname(name))), makeTlv(2, publicNoise), makeTlv(3, publicSigning)])
  let previous = 0
  function make(type: number, payload: Uint8Array, now = Date.now()) {
    const when = previous = Math.max(previous + 1, now)
    const packet: MeshPacket = { version: 1, type, ttl: 7, when, sender, payload, broadcast: type === MESSAGE }
    return { ...packet, signature: ed25519.sign(signingBytes(packet), signingSeed) }
  }
  return {
    id: hex(sender),
    announce: (now?: number) => make(ANNOUNCE, announcement, now),
    text: (body: string, now?: number) => make(MESSAGE, encodeText(body), now),
    erase: () => { signingSeed.fill(0); noiseSeed.fill(0) },
  }
}

export function framesFor(packet: MeshPacket, maxBytes: number, fragmentId = random(ID)): Uint8Array[] {
  const wire = encodePacket(packet)
  if (maxBytes < 64 || maxBytes > 512 || wire.length > MAX_PACKET) return []
  if (wire.length <= maxBytes) return [wire]
  const chunk = maxBytes - HEADER - ID - FRAGMENT_HEADER - (packet.broadcast ? ID : 0)
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
    return encodePacket({ ...packet, version: 1, type: FRAGMENT, payload, signature: undefined, compressed: null })
  })
}

interface Assembly { when: number; created: number; type: number; ttl: number; bytes: number; pieces: Map<number, Uint8Array>; total: number }

export function createFragmentCollector() {
  const assemblies = new Map<string, Assembly>()
  return {
    receive(packet: MeshPacket, now: number): MeshPacket | null {
      if (packet.type !== FRAGMENT) return packet
      if (packet.payload.length <= FRAGMENT_HEADER) return null
      for (const [key, value] of assemblies) if (now - value.created > 30_000) assemblies.delete(key)
      const view = new DataView(packet.payload.buffer, packet.payload.byteOffset, packet.payload.byteLength)
      const index = view.getUint16(8), total = view.getUint16(10), type = packet.payload[12]
      if (index >= total || total > 128 || ![ANNOUNCE, MESSAGE, LEAVE].includes(type)) return null
      const key = hex(packet.sender) + ':' + hex(packet.payload.subarray(0, ID))
      let assembly = assemblies.get(key)
      if (!assembly) {
        if (assemblies.size >= 32) return null
        assembly = { when: packet.when, created: now, type, ttl: packet.ttl, bytes: 0, pieces: new Map(), total }
        assemblies.set(key, assembly)
      }
      if (assembly.total !== total || assembly.type !== type || assembly.when !== packet.when || assembly.pieces.has(index)) return null
      const data = packet.payload.slice(FRAGMENT_HEADER)
      assembly.bytes += data.length
      if (assembly.bytes > MAX_PACKET) { assemblies.delete(key); return null }
      assembly.ttl = Math.min(assembly.ttl, packet.ttl)
      assembly.pieces.set(index, data)
      if (assembly.pieces.size !== total) return null
      assemblies.delete(key)
      const inner = decodePacket(concatenate(Array.from({ length: total }, (_, idx) => assembly!.pieces.get(idx)!)))
      if (!inner || inner.type !== type || inner.when !== assembly.when || !equal(inner.sender, packet.sender)) return null
      return { ...inner, ttl: Math.min(inner.ttl, assembly.ttl) }
    },
    clear() { assemblies.clear() },
  }
}
