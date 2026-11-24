import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  type EventTemplate,
  type VerifiedEvent,
} from 'nostr-tools'
import type { IdentityState, SignMode } from '../types/protocol.ts'
import { normalizeGeohash } from './geohash.ts'

export interface Nip07NostrProvider {
  getPublicKey: () => Promise<string>
  signEvent: (event: EventTemplate) => Promise<VerifiedEvent>
  nip44?: {
    encrypt: (pubkey: string, plaintext: string) => Promise<string>
    decrypt: (pubkey: string, ciphertext: string) => Promise<string>
  }
}

declare global {
  interface Window {
    nostr?: Nip07NostrProvider
  }
}

const utf8Encoder = new TextEncoder()

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

export function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().replace(/^0x/i, '').toLowerCase()
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) {
    return null
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function generateRandomNickname(): string {
  const n = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0')
  return `agnon${n}`
}

export function formatShortPubkey(pubkey: string): string {
  if (pubkey.length <= 12) return pubkey
  return `${pubkey.slice(0, 6)}…${pubkey.slice(-4)}`
}

export function formatDisplayHandle(nickname: string | null | undefined, pubkey: string): string {
  const cleanNick = (nickname ?? '').trim()
  const base = cleanNick || `agnon${pubkey.slice(-4)}`
  const suffix = pubkey.slice(-4).toLowerCase()
  return `@${base}#${suffix}`
}

export function encodeNpubSafe(pubkeyHex: string): string {
  try {
    if (/^[0-9a-f]{64}$/i.test(pubkeyHex)) {
      return nip19.npubEncode(pubkeyHex.toLowerCase())
    }
  } catch {
    // Fallback
  }
  return pubkeyHex
}

export function decodePubkeyInput(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase()
  if (trimmed.toLowerCase().startsWith('npub1')) {
    try {
      const decoded = nip19.decode(trimmed)
      if (decoded.type === 'npub' && typeof decoded.data === 'string') {
        return decoded.data.toLowerCase()
      }
    } catch {
      return null
    }
  }
  return null
}

export function parseSecretKey(input: string): Uint8Array | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    if (trimmed.toLowerCase().startsWith('nsec1')) {
      const decoded = nip19.decode(trimmed)
      if (decoded.type === 'nsec' && decoded.data instanceof Uint8Array && decoded.data.length === 32) {
        return decoded.data
      }
      return null
    }
    const bytes = hexToBytes(trimmed)
    if (bytes && bytes.length === 32) {
      // Validate by deriving public key
      getPublicKey(bytes)
      return bytes
    }
    return null
  } catch {
    return null
  }
}

export function encodeNsecSafe(sk: Uint8Array | null): string | null {
  if (!sk || sk.length !== 32) return null
  try {
    return nip19.nsecEncode(sk)
  } catch {
    return null
  }
}

export function maskNsec(nsec: string | null): string | null {
  if (!nsec || nsec.length < 16) return null
  return `${nsec.slice(0, 9)}••••••••••••••••••••••••${nsec.slice(-6)}`
}

export function detectNip07(): { hasNip07: boolean; hasNip07Nip44: boolean } {
  if (typeof window === 'undefined' || !window.nostr) {
    return { hasNip07: false, hasNip07Nip44: false }
  }
  return {
    hasNip07: typeof window.nostr.signEvent === 'function' && typeof window.nostr.getPublicKey === 'function',
    hasNip07Nip44:
      typeof window.nostr.nip44?.encrypt === 'function' && typeof window.nostr.nip44?.decrypt === 'function',
  }
}

/**
 * Exact Bitchat per-geohash unlinkable key derivation (NostrIdentityBridge.swift):
 * HMAC-SHA256(key = deviceSeed, message = utf8(geohash) || uint32BE(iteration))
 */
export function deriveGeohashSecretKey(deviceSeed: Uint8Array, geohash: string): Uint8Array {
  const gh = normalizeGeohash(geohash)
  const msg = utf8Encoder.encode(gh)

  for (let iter = 0; iter < 10; iter++) {
    const input = new Uint8Array(msg.length + 4)
    input.set(msg, 0)
    const view = new DataView(input.buffer)
    view.setUint32(msg.length, iter, false) // big-endian
    const candidate = hmac(sha256, deviceSeed, input)
    try {
      getPublicKey(candidate)
      return candidate
    } catch {
      // Try next iteration if scalar is invalid
    }
  }

  const combined = new Uint8Array(deviceSeed.length + msg.length)
  combined.set(deviceSeed, 0)
  combined.set(msg, deviceSeed.length)
  return sha256(combined)
}

export interface SigningKeyMaterial {
  mode: SignMode
  pubkey: string
  secretKey: Uint8Array | null
}

export class IdentityManager {
  private deviceSeed: Uint8Array
  private localSecret: Uint8Array | null = null
  private localSecretRaw = ''
  private nip07Pubkey: string | null = null
  private signMode: SignMode = 'auto'
  private nickname: string
  private perGeohashIdentity = false
  private derivedCache = new Map<string, { sk: Uint8Array; pk: string }>()
  private wipeGeneration = 0

  constructor(opts: {
    deviceSeedHex: string | null
    signMode: SignMode
    localSecretRaw: string
    nickname: string
    perGeohashIdentity: boolean
  }) {
    const parsedSeed = opts.deviceSeedHex ? hexToBytes(opts.deviceSeedHex) : null
    this.deviceSeed = parsedSeed && parsedSeed.length === 32 ? parsedSeed : generateSecretKey()
    this.signMode = opts.signMode
    this.nickname = opts.nickname.trim() || generateRandomNickname()
    this.perGeohashIdentity = opts.perGeohashIdentity
    this.setLocalSecret(opts.localSecretRaw)
  }

  getDeviceSeedHex(): string {
    return bytesToHex(this.deviceSeed)
  }

  getWipeGeneration(): number {
    return this.wipeGeneration
  }

  getNickname(): string {
    return this.nickname
  }

  setNickname(nick: string): void {
    const clean = nick.trim().slice(0, 32)
    this.nickname = clean || generateRandomNickname()
  }

  getSignMode(): SignMode {
    return this.signMode
  }

  setSignMode(mode: SignMode): void {
    this.signMode = mode
  }

  setPerGeohashIdentity(enabled: boolean): void {
    this.perGeohashIdentity = enabled
  }

  setNip07Pubkey(pk: string | null): void {
    this.nip07Pubkey = pk ? pk.toLowerCase() : null
  }

  setLocalSecret(raw: string): boolean {
    this.localSecretRaw = raw.trim()
    if (!this.localSecretRaw) {
      this.localSecret = null
      return false
    }
    const parsed = parseSecretKey(this.localSecretRaw)
    this.localSecret = parsed
    return parsed !== null
  }

  getLocalSecretRaw(): string {
    return this.localSecretRaw
  }

  getMasterKeyMaterial(): SigningKeyMaterial {
    if (this.signMode === 'extension' && this.nip07Pubkey) {
      return { mode: 'extension', pubkey: this.nip07Pubkey, secretKey: null }
    }
    if (this.signMode === 'local' && this.localSecret) {
      return { mode: 'local', pubkey: getPublicKey(this.localSecret), secretKey: this.localSecret }
    }
    return { mode: 'auto', pubkey: getPublicKey(this.deviceSeed), secretKey: this.deviceSeed }
  }

  /**
   * Always returns the deterministic HMAC-SHA256 derived identity for a geohash
   * (independent of `perGeohashIdentity` / `signMode`), guaranteeing public Bitchat
   * call signaling NEVER exposes the user's primary DM `npub`.
   */
  getDerivedGeohashKeyMaterial(geohash: string): SigningKeyMaterial {
    const gh = normalizeGeohash(geohash)
    const cached = this.derivedCache.get(gh)
    if (cached) {
      return { mode: 'auto', pubkey: cached.pk, secretKey: cached.sk }
    }
    const sk = deriveGeohashSecretKey(this.deviceSeed, gh)
    const pk = getPublicKey(sk)
    this.derivedCache.set(gh, { sk, pk })
    return { mode: 'auto', pubkey: pk, secretKey: sk }
  }

  getKeyMaterialForGeohash(geohash?: string): SigningKeyMaterial {
    if (this.signMode === 'auto' && this.perGeohashIdentity && geohash) {
      return this.getDerivedGeohashKeyMaterial(geohash)
    }
    return this.getMasterKeyMaterial()
  }

  getState(activeGeohash?: string): IdentityState {
    const { hasNip07, hasNip07Nip44 } = detectNip07()
    const master = this.getMasterKeyMaterial()
    const active = this.getKeyMaterialForGeohash(activeGeohash)
    const exportable = encodeNsecSafe(active.secretKey)

    return {
      signMode: this.signMode,
      nickname: this.nickname,
      masterPubkey: master.pubkey,
      masterNpub: encodeNpubSafe(master.pubkey),
      activePubkey: active.pubkey,
      activeNpub: encodeNpubSafe(active.pubkey),
      activeDisplayHandle: formatDisplayHandle(this.nickname, active.pubkey),
      perGeohashIdentity: this.perGeohashIdentity,
      hasNip07,
      hasNip07Nip44,
      localSecretValid: this.localSecret !== null,
      maskedNsec: maskNsec(exportable),
      exportableNsec: exportable,
    }
  }

  async ensureNip07Pubkey(): Promise<string | null> {
    const { hasNip07 } = detectNip07()
    if (!hasNip07 || !window.nostr) return null
    try {
      const pk = await window.nostr.getPublicKey()
      if (typeof pk === 'string' && /^[0-9a-f]{64}$/i.test(pk)) {
        this.nip07Pubkey = pk.toLowerCase()
        return this.nip07Pubkey
      }
    } catch {
      // User rejected extension prompt
    }
    return null
  }

  async signEventWithMaterial(
    template: EventTemplate,
    material: SigningKeyMaterial
  ): Promise<VerifiedEvent> {
    if (material.mode === 'extension') {
      if (!window.nostr) {
        throw new Error('NIP-07 browser extension not found')
      }
      return await window.nostr.signEvent(template)
    }
    if (!material.secretKey) {
      throw new Error('No signing key available')
    }
    return finalizeEvent(template, material.secretKey)
  }

  async signEvent(template: EventTemplate, geohash?: string): Promise<VerifiedEvent> {
    const material = this.getKeyMaterialForGeohash(geohash)
    return await this.signEventWithMaterial(template, material)
  }

  rotateEphemeral(): string {
    this.deviceSeed = generateSecretKey()
    this.derivedCache.clear()
    return bytesToHex(this.deviceSeed)
  }

  panicReset(): { deviceSeedHex: string; nickname: string } {
    this.wipeGeneration += 1
    this.deviceSeed = generateSecretKey()
    this.localSecret = null
    this.localSecretRaw = ''
    this.signMode = 'auto'
    this.nickname = generateRandomNickname()
    this.derivedCache.clear()
    return {
      deviceSeedHex: bytesToHex(this.deviceSeed),
      nickname: this.nickname,
    }
  }
}
