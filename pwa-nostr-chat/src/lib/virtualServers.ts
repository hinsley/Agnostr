import { getShareBaseHref } from './appPlatform.ts'
import { sha256 } from '@noble/hashes/sha256'
import { nip19, type Event as NostrEvent, type EventTemplate } from 'nostr-tools'
import type { ImageAttachment, ReplyReference, VoiceMemoAttachment } from '../types/protocol.ts'
import type { TorrentAttachment } from '../types/torrent.ts'
import type {
  ServerChannel,
  ServerInvite,
  ServerMessage,
  ServerSummary,
  VirtualServerManifest,
} from '../types/servers.ts'
import {
  buildImageImetaTag,
  buildImetaTag,
  clampTimestamp,
  extractMentions,
  getTagValue,
  getValidatedPowBits,
  isEmoteContent,
  KIND_EPHEMERAL_REACTION,
  parseImageFromImeta,
  parseVoiceMemoFromImeta,
} from './bitchatProtocol.ts'
import { CORE_DM_RELAYS, normalizeRelayUrl } from './geoRelays.ts'
import { bytesToHex, formatDisplayHandle } from './identity.ts'
import {
  buildTorrentTag,
  normalizeTorrentAttachment,
  parseTorrentFromTags,
} from './torrentProtocol.ts'
import {
  getGroupSpecifier,
  hasUploadedGroupPicture,
  sanitizeGroupSpecifier,
} from '../utils/groupIcon.ts'

export const KIND_VIRTUAL_MANIFEST = 30078
export const KIND_VIRTUAL_CHAT = 9
export const KIND_EVENT_DELETE = 5

export const E2EE_MSG_PREFIX = 'agnostr-e2ee-v1:'
export const INVITE_CODE_PREFIX = 'ag1.'

export const SERVER_ACCENT_SWATCHES: readonly string[] = [
  '#22E584', // Phosphor Emerald
  '#38BDF8', // Cyan Telemetry
  '#F5A623', // Shortwave Amber
  '#818CF8', // Midnight Indigo
  '#A78BFA', // E2EE Violet
  '#FB7185', // Signal Coral
]

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(str: string): Uint8Array | null {
  try {
    const clean = str.trim()
    const pad = clean.length % 4 === 0 ? '' : '='.repeat(4 - (clean.length % 4))
    const b64 = clean.replace(/-/g, '+').replace(/_/g, '/') + pad
    const binary = atob(b64)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i)
    }
    return out
  } catch {
    return null
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export function generateServerId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

export function generateServerKeyB64(): string {
  const key = new Uint8Array(32)
  crypto.getRandomValues(key)
  return base64UrlEncode(key)
}

export function slugifyChannelName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
  return cleaned || 'general'
}

export function defaultMonogram(name: string): string {
  return getGroupSpecifier(name)
}

export function manifestDTag(serverId: string): string {
  return `agnostr:server:${serverId}`
}

/**
 * Computes the `#t` channel tag for a Virtual Server channel.
 * For E2EE private servers, the tag is domain-separated SHA-256 blinded using the
 * shared 32-byte server key so relays cannot correlate plaintext server/channel IDs.
 */
export function getVirtualChannelTag(server: Pick<ServerSummary, 'id' | 'encrypted' | 'encryptionKeyB64'>, channelId: string): string {
  const chan = slugifyChannelName(channelId)
  if (server.encrypted && server.encryptionKeyB64) {
    const keyBytes = base64UrlDecode(server.encryptionKeyB64)
    if (keyBytes && keyBytes.length === 32) {
      const digest = sha256(utf8Encoder.encode(`agnostr-chan:${bytesToHex(keyBytes)}:${chan}`))
      return `agnostr-e2ee:${bytesToHex(digest).slice(0, 24)}`
    }
  }
  return `agnostr:${server.id}:${chan}`
}

export interface VirtualEncryptedPayload {
  v: 1
  text: string
  nickname: string
  replyToId?: string
  replyToPubkey?: string
  voiceMemo?: VoiceMemoAttachment
  imageAttachment?: ImageAttachment
  torrentAttachment?: TorrentAttachment
}

export async function encryptVirtualPayload(
  keyB64: string,
  payload: VirtualEncryptedPayload
): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Web Crypto API unavailable for E2EE server encryption.')
  }
  const keyBytes = base64UrlDecode(keyB64)
  if (!keyBytes || keyBytes.length !== 32) {
    throw new Error('Invalid 256-bit E2EE server key.')
  }
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(keyBytes),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  )
  const plainBytes = utf8Encoder.encode(JSON.stringify(payload))
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    cryptoKey,
    toArrayBuffer(plainBytes)
  )
  const cipherBytes = new Uint8Array(cipherBuf)
  const combined = new Uint8Array(12 + cipherBytes.length)
  combined.set(iv, 0)
  combined.set(cipherBytes, 12)
  return `${E2EE_MSG_PREFIX}${base64UrlEncode(combined)}`
}

export async function decryptVirtualPayload(
  keyB64: string,
  rawContent: string
): Promise<VirtualEncryptedPayload | null> {
  if (!rawContent.startsWith(E2EE_MSG_PREFIX)) return null
  if (typeof crypto === 'undefined' || !crypto.subtle) return null
  const keyBytes = base64UrlDecode(keyB64)
  if (!keyBytes || keyBytes.length !== 32) return null

  const combined = base64UrlDecode(rawContent.slice(E2EE_MSG_PREFIX.length))
  if (!combined || combined.length <= 28) return null
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)

  try {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(keyBytes),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    )
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      cryptoKey,
      toArrayBuffer(ciphertext)
    )
    const parsed = JSON.parse(utf8Decoder.decode(new Uint8Array(plainBuf))) as Partial<VirtualEncryptedPayload>
    if (typeof parsed.text !== 'string') return null
    return {
      v: 1,
      text: parsed.text,
      nickname: typeof parsed.nickname === 'string' ? parsed.nickname : '',
      replyToId: typeof parsed.replyToId === 'string' ? parsed.replyToId : undefined,
      replyToPubkey: typeof parsed.replyToPubkey === 'string' ? parsed.replyToPubkey : undefined,
      voiceMemo: parsed.voiceMemo,
      imageAttachment: parsed.imageAttachment,
      torrentAttachment: parsed.torrentAttachment,
    }
  } catch {
    return null
  }
}

export function buildVirtualManifestTemplate(manifest: VirtualServerManifest): EventTemplate {
  return {
    kind: KIND_VIRTUAL_MANIFEST,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', manifestDTag(manifest.id)],
      ['t', 'agnostr-server'],
    ],
    content: JSON.stringify(manifest),
  }
}

export function parseVirtualManifestEvent(
  event: NostrEvent,
  expectedServerId?: string,
  expectedFounderPubkey?: string
): VirtualServerManifest | null {
  if (event.kind !== KIND_VIRTUAL_MANIFEST) return null
  const d = getTagValue(event.tags, 'd')
  if (!d || !d.startsWith('agnostr:server:')) return null
  const idFromTag = d.slice('agnostr:server:'.length)
  if (!idFromTag) return null
  if (expectedServerId && idFromTag !== expectedServerId) return null

  const authorPk = event.pubkey.toLowerCase()
  if (expectedFounderPubkey && authorPk !== expectedFounderPubkey.toLowerCase()) {
    return null
  }

  let parsed: Partial<VirtualServerManifest>
  try {
    parsed = JSON.parse(event.content) as Partial<VirtualServerManifest>
  } catch {
    return null
  }
  if (!parsed || typeof parsed.name !== 'string' || !parsed.name.trim()) return null

  const channels: ServerChannel[] = Array.isArray(parsed.channels)
    ? parsed.channels
        .filter((c): c is ServerChannel => Boolean(c && typeof c.name === 'string' && c.name.trim()))
        .map((c) => ({
          id: slugifyChannelName(c.id || c.name),
          name: slugifyChannelName(c.name),
          topic: typeof c.topic === 'string' ? c.topic.trim().slice(0, 140) : undefined,
        }))
        .slice(0, 32)
    : []

  const dedupedChannels: ServerChannel[] = []
  const seenChans = new Set<string>()
  for (const ch of channels) {
    if (!seenChans.has(ch.id)) {
      seenChans.add(ch.id)
      dedupedChannels.push(ch)
    }
  }
  if (dedupedChannels.length === 0) {
    dedupedChannels.push({ id: 'general', name: 'general' })
  }

  const relays = Array.isArray(parsed.relays)
    ? parsed.relays
        .filter((r): r is string => typeof r === 'string')
        .map((r) => normalizeRelayUrl(r))
        .filter((r): r is string => r !== null)
    : []

  const rawPicture =
    typeof parsed.picture === 'string'
      ? parsed.picture.trim()
      : typeof (parsed as Record<string, unknown>).p === 'string'
        ? String((parsed as Record<string, unknown>).p).trim()
        : ''
  const picture = hasUploadedGroupPicture(rawPicture) ? rawPicture : undefined

  return {
    v: 1,
    id: idFromTag,
    name: parsed.name.trim().slice(0, 48),
    description: typeof parsed.description === 'string' ? parsed.description.trim().slice(0, 200) : '',
    icon: getGroupSpecifier(parsed.name, typeof parsed.icon === 'string' ? parsed.icon : undefined),
    ...(picture ? { picture } : {}),
    accentColor:
      typeof parsed.accentColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(parsed.accentColor)
        ? parsed.accentColor
        : SERVER_ACCENT_SWATCHES[0],
    founderPubkey: authorPk,
    encrypted: Boolean(parsed.encrypted),
    channels: dedupedChannels,
    moderators: Array.isArray(parsed.moderators)
      ? Array.from(
          new Set(
            parsed.moderators
              .filter((p): p is string => typeof p === 'string' && /^[0-9a-f]{64}$/i.test(p))
              .map((p) => p.toLowerCase())
          )
        )
      : [],
    bannedPubkeys: Array.isArray(parsed.bannedPubkeys)
      ? Array.from(
          new Set(
            parsed.bannedPubkeys
              .filter((p): p is string => typeof p === 'string' && /^[0-9a-f]{64}$/i.test(p))
              .map((p) => p.toLowerCase())
          )
        )
      : [],
    relays: relays.length > 0 ? Array.from(new Set(relays)) : [...CORE_DM_RELAYS],
    rev: typeof parsed.rev === 'number' && Number.isFinite(parsed.rev) ? parsed.rev : 1,
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : event.created_at,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : event.created_at,
  }
}

export async function buildVirtualChatTemplate(opts: {
  server: ServerSummary
  channelId: string
  content: string
  nickname: string
  replyTo?: ServerMessage | null
  voiceMemo?: VoiceMemoAttachment
  imageAttachment?: ImageAttachment
  torrentAttachment?: TorrentAttachment
  lightningAddress?: string | null
}): Promise<EventTemplate> {
  const chanTag = getVirtualChannelTag(opts.server, opts.channelId)
  const tags: string[][] = [['t', chanTag]]

  if (opts.server.encrypted && opts.server.encryptionKeyB64) {
    const ciphertext = await encryptVirtualPayload(opts.server.encryptionKeyB64, {
      v: 1,
      text: opts.content,
      nickname: opts.nickname.trim(),
      replyToId: opts.replyTo && !opts.replyTo.isSystem ? opts.replyTo.id : undefined,
      replyToPubkey: opts.replyTo && !opts.replyTo.isSystem ? opts.replyTo.pubkey : undefined,
      voiceMemo: opts.voiceMemo,
      imageAttachment: opts.imageAttachment,
      torrentAttachment: opts.torrentAttachment,
    })
    return {
      kind: KIND_VIRTUAL_CHAT,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: ciphertext,
    }
  }

  const cleanNick = opts.nickname.trim()
  if (cleanNick) tags.push(['n', cleanNick])
  const cleanLud16 = opts.lightningAddress?.trim()
  if (cleanLud16) tags.push(['lud16', cleanLud16])
  if (opts.replyTo && !opts.replyTo.isSystem) {
    tags.push(['e', opts.replyTo.id, '', 'reply'])
    if (/^[0-9a-f]{64}$/i.test(opts.replyTo.pubkey)) {
      tags.push(['p', opts.replyTo.pubkey.toLowerCase()])
    }
  }
  if (opts.voiceMemo) {
    tags.push(buildImetaTag(opts.voiceMemo))
  }
  if (opts.imageAttachment) {
    tags.push(buildImageImetaTag(opts.imageAttachment))
  }
  if (opts.torrentAttachment) {
    tags.push(buildTorrentTag(opts.torrentAttachment))
  }

  return {
    kind: KIND_VIRTUAL_CHAT,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: opts.content,
  }
}

export async function parseVirtualChatEvent(
  event: NostrEvent,
  server: ServerSummary,
  channelId: string,
  ownPubkeys: Set<string>,
  findMessageById?: (id: string) => ServerMessage | undefined
): Promise<ServerMessage | null> {
  if (event.kind !== KIND_VIRTUAL_CHAT) return null
  const expectedTag = getVirtualChannelTag(server, channelId)
  const hasMatch = event.tags.some((t) => t[0] === 't' && t[1] === expectedTag)
  if (!hasMatch) return null

  const pubkey = event.pubkey.toLowerCase()
  let text = ''
  let nickname = ''
  let replyTo: ReplyReference | undefined
  let voiceMemo: VoiceMemoAttachment | undefined
  let imageAttachment: ImageAttachment | undefined
  let torrentAttachment: TorrentAttachment | undefined
  let decryptFailed = false

  if (server.encrypted) {
    if (!server.encryptionKeyB64) {
      decryptFailed = true
      text = '[Encrypted message — group key missing]'
    } else {
      const dec = await decryptVirtualPayload(server.encryptionKeyB64, event.content)
      if (!dec) {
        // Ignore non-E2EE spam or undecryptable noise
        return null
      }
      text = dec.text
      nickname = dec.nickname
      voiceMemo = dec.voiceMemo
      imageAttachment = dec.imageAttachment
      torrentAttachment = dec.torrentAttachment
        ? (normalizeTorrentAttachment(dec.torrentAttachment, pubkey) ?? undefined)
        : undefined
      if (dec.replyToId) {
        const parent = findMessageById?.(dec.replyToId)
        replyTo = {
          id: dec.replyToId,
          pubkey: parent?.pubkey ?? dec.replyToPubkey,
          nickname: parent?.nickname,
          preview: parent ? parent.content.slice(0, 120) : undefined,
        }
      }
    }
  } else {
    text = (event.content ?? '').trim()
    if (!text) return null
    nickname = getTagValue(event.tags, 'n')?.trim() ?? ''
    voiceMemo = parseVoiceMemoFromImeta(event.tags)
    imageAttachment = parseImageFromImeta(event.tags)
    torrentAttachment = parseTorrentFromTags(event.tags, pubkey) ?? undefined
    const eTag = event.tags.find((t) => t[0] === 'e' && typeof t[1] === 'string' && t[1].length >= 16)
    if (eTag) {
      const parent = findMessageById?.(eTag[1])
      replyTo = {
        id: eTag[1],
        pubkey: parent?.pubkey ?? getTagValue(event.tags, 'p') ?? undefined,
        nickname: parent?.nickname,
        preview: parent ? parent.content.slice(0, 120) : undefined,
      }
    }
  }

  const finalNick = nickname || `anon${pubkey.slice(-4)}`
  return {
    id: event.id,
    serverId: server.id,
    channelId,
    pubkey,
    nickname: finalNick,
    displayHandle: formatDisplayHandle(finalNick, pubkey),
    content: text,
    createdAt: clampTimestamp(event.created_at),
    tags: event.tags,
    isOwn: ownPubkeys.has(pubkey),
    isEmote: isEmoteContent(text),
    encrypted: server.encrypted,
    decryptFailed,
    powBits: getValidatedPowBits(event.id, event.tags),
    replyTo,
    reactions: [],
    mentions: extractMentions(text),
    voiceMemo,
    imageAttachment,
    torrentAttachment,
    deliveryStatus: 'sent',
  }
}

export function buildVirtualReactionTemplate(opts: {
  server: ServerSummary
  channelId: string
  targetEventId: string
  targetPubkey: string
  emoji: string
}): EventTemplate {
  return {
    kind: KIND_EPHEMERAL_REACTION,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['t', getVirtualChannelTag(opts.server, opts.channelId)],
      ['e', opts.targetEventId],
      ['p', opts.targetPubkey.toLowerCase()],
    ],
    content: opts.emoji,
  }
}

export function buildEventDeleteTemplate(eventId: string, reason = ''): EventTemplate {
  return {
    kind: KIND_EVENT_DELETE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['e', eventId]],
    content: reason,
  }
}

interface CompactInvitePayload {
  v: 1
  k: 'v' | 'n' // virtual | nip29
  id: string
  n: string // name
  d?: string // description
  i?: string // 1-2 char alphanumeric specifier
  p?: string // optional HTTPS uploaded icon URL
  c?: string // accentColor
  f?: string // founderPubkey
  e?: 1 // encrypted
  key?: string // base64url 32-byte key
  r?: string // nip29 relayUrl
  rs?: string[] // virtual relays
  ch?: string[] // channel slugs
  code?: string // nip29 invite code
  by?: string // inviter pubkey
}

export function encodeServerInvite(
  server: ServerSummary,
  inviterPubkey?: string
): { code: string; url: string } {
  const safeSpec = sanitizeGroupSpecifier(server.icon) || undefined
  const safePicture =
    hasUploadedGroupPicture(server.picture) && (server.picture?.trim().length ?? 0) <= 240
      ? server.picture!.trim()
      : undefined
  const payload: CompactInvitePayload =
    server.kind === 'virtual'
      ? {
          v: 1,
          k: 'v',
          id: server.id,
          n: server.name.slice(0, 48),
          d: server.description ? server.description.slice(0, 140) : undefined,
          i: safeSpec,
          p: safePicture,
          c: server.accentColor || undefined,
          f: server.founderPubkey || undefined,
          e: server.encrypted ? 1 : undefined,
          key: server.encrypted ? server.encryptionKeyB64 : undefined,
          rs: server.relays.slice(0, 5),
          ch: server.channels.map((c) => c.id).slice(0, 12),
          by: inviterPubkey,
        }
      : {
          v: 1,
          k: 'n',
          id: server.groupId || server.id,
          n: server.name.slice(0, 48),
          d: server.description ? server.description.slice(0, 140) : undefined,
          i: safeSpec,
          p: safePicture,
          c: server.accentColor || undefined,
          r: server.relayUrl,
          by: inviterPubkey,
        }

  const encoded = base64UrlEncode(utf8Encoder.encode(JSON.stringify(payload)))
  const code = `${INVITE_CODE_PREFIX}${encoded}`
  const baseHref = getShareBaseHref()
  return {
    code,
    url: `${baseHref}#invite=${code}`,
  }
}

export function parseServerInvite(rawInput: string): ServerInvite | null {
  const trimmed = rawInput.trim()
  if (!trimmed) return null

  // 1. Extract ag1.<base64url> from URL hash, query, or plain code
  const agMatch = trimmed.match(/ag1\.[A-Za-z0-9_-]+/)
  if (agMatch) {
    const code = agMatch[0]
    const bytes = base64UrlDecode(code.slice(INVITE_CODE_PREFIX.length))
    if (!bytes) return null
    try {
      const p = JSON.parse(utf8Decoder.decode(bytes)) as Partial<CompactInvitePayload>
      if (p.v !== 1 || typeof p.id !== 'string' || !p.id || typeof p.n !== 'string') return null
      const parsedPicture =
        typeof p.p === 'string' && hasUploadedGroupPicture(p.p) ? p.p.trim() : undefined
      const parsedSpec = sanitizeGroupSpecifier(typeof p.i === 'string' ? p.i : undefined) || undefined
      if (p.k === 'v') {
        const relays = Array.isArray(p.rs)
          ? p.rs.map((u) => normalizeRelayUrl(u)).filter((u): u is string => u !== null)
          : [...CORE_DM_RELAYS]
        return {
          v: 1,
          kind: 'virtual',
          id: p.id,
          name: p.n.trim().slice(0, 48) || 'Agnostr Group',
          description: typeof p.d === 'string' ? p.d : undefined,
          icon: parsedSpec,
          ...(parsedPicture ? { picture: parsedPicture } : {}),
          accentColor: typeof p.c === 'string' ? p.c : undefined,
          founderPubkey: typeof p.f === 'string' && /^[0-9a-f]{64}$/i.test(p.f) ? p.f.toLowerCase() : undefined,
          encrypted: p.e === 1,
          key: typeof p.key === 'string' ? p.key : undefined,
          relays: relays.length > 0 ? relays : [...CORE_DM_RELAYS],
          channels: Array.isArray(p.ch)
            ? p.ch.map((slug) => ({ id: slugifyChannelName(slug), name: slugifyChannelName(slug) }))
            : [{ id: 'general', name: 'general' }],
          inviterPubkey: typeof p.by === 'string' && /^[0-9a-f]{64}$/i.test(p.by) ? p.by.toLowerCase() : undefined,
          rawCode: code,
        }
      }
      if (p.k === 'n' && typeof p.r === 'string') {
        const relayUrl = normalizeRelayUrl(p.r)
        if (!relayUrl) return null
        return {
          v: 1,
          kind: 'nip29',
          id: p.id,
          name: p.n.trim().slice(0, 48) || p.id,
          description: typeof p.d === 'string' ? p.d : undefined,
          icon: parsedSpec,
          ...(parsedPicture ? { picture: parsedPicture } : {}),
          accentColor: typeof p.c === 'string' ? p.c : undefined,
          relayUrl,
          inviteCode: typeof p.code === 'string' ? p.code : undefined,
          inviterPubkey: typeof p.by === 'string' && /^[0-9a-f]{64}$/i.test(p.by) ? p.by.toLowerCase() : undefined,
          rawCode: code,
        }
      }
    } catch {
      return null
    }
  }

  // 2. NIP-29 `naddr1...?invite=<code>`
  const naddrMatch = trimmed.match(/(naddr1[0-9a-z]+)(?:\?invite=([^\s&]+))?/i)
  if (naddrMatch) {
    try {
      const decoded = nip19.decode(naddrMatch[1])
      if (decoded.type === 'naddr' && decoded.data.kind === 39000 && decoded.data.identifier) {
        const relayHint = decoded.data.relays?.find((r) => normalizeRelayUrl(r) !== null)
        const relayUrl = relayHint ? normalizeRelayUrl(relayHint) : null
        if (relayUrl) {
          return {
            v: 1,
            kind: 'nip29',
            id: decoded.data.identifier,
            name: decoded.data.identifier,
            relayUrl,
            inviteCode: naddrMatch[2] || undefined,
            rawCode: trimmed,
          }
        }
      }
    } catch {
      // Fall through
    }
  }

  // 3. NIP-29 shorthand `<relay>'<groupId>` (e.g. `groups.hzrd149.com'79dc07` or `wss://pyramid.fiatjaf.com'bitfest-2026`)
  const quoteIdx = trimmed.indexOf("'")
  if (quoteIdx > 0 && quoteIdx < trimmed.length - 1) {
    const rawRelay = trimmed.slice(0, quoteIdx).trim()
    const rest = trimmed.slice(quoteIdx + 1).trim()
    const [groupId, inviteCode] = rest.split('?invite=')
    const relayUrl = normalizeRelayUrl(rawRelay)
    if (relayUrl && groupId) {
      return {
        v: 1,
        kind: 'nip29',
        id: groupId,
        name: groupId,
        relayUrl,
        inviteCode: inviteCode || undefined,
        rawCode: `${relayUrl}'${groupId}`,
      }
    }
  }

  return null
}

export function extractInviteFromHash(hash: string): ServerInvite | null {
  const clean = hash.replace(/^#/, '').trim()
  if (!clean.toLowerCase().startsWith('invite=')) return null
  const val = decodeURIComponent(clean.slice('invite='.length))
  return parseServerInvite(val)
}
