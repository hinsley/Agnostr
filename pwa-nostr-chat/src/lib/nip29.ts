import type { Event as NostrEvent, EventTemplate } from 'nostr-tools'
import type { ImageAttachment, ReplyReference, VoiceMemoAttachment } from '../types/protocol.ts'
import type { TorrentAttachment } from '../types/torrent.ts'
import type {
  Nip29GroupMeta,
  Nip29RelayPreset,
  ServerMessage,
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
import { formatDisplayHandle } from './identity.ts'
import { buildTorrentTag, parseTorrentFromTags } from './torrentProtocol.ts'

export const KIND_NIP29_CHAT = 9
export const KIND_NIP29_PUT_USER = 9000
export const KIND_NIP29_REMOVE_USER = 9001
export const KIND_NIP29_EDIT_META = 9002
export const KIND_NIP29_DELETE_EVENT = 9005
export const KIND_NIP29_CREATE_GROUP = 9007
export const KIND_NIP29_DELETE_GROUP = 9008
export const KIND_NIP29_JOIN = 9021
export const KIND_NIP29_LEAVE = 9022
export const KIND_NIP29_GROUP_META = 39000
export const KIND_NIP29_GROUP_ADMINS = 39001
export const KIND_NIP29_GROUP_MEMBERS = 39002
export const KIND_NIP42_AUTH = 22242

/**
 * Live-audited public NIP-29 relays (verified active, readable, and low-spam).
 */
export const DEFAULT_NIP29_RELAYS: readonly Nip29RelayPreset[] = [
  {
    url: 'wss://pyramid.fiatjaf.com',
    name: 'Fiatjaf Pyramid',
    description: 'Popular Nostr & Bitcoin NIP-29 communities (Bitfest, Table Mesh, nak, grimoire, pyramid runners).',
    supportsCreate: false,
    requiresAuth: true,
  },
  {
    url: 'wss://relay.nostr-proto.org',
    name: 'Nostr Proto',
    description: 'Clean Nostr community rooms for Protocol, Relays, Apps, Help, and Agora discussion.',
    supportsCreate: false,
    requiresAuth: true,
  },
  {
    url: 'wss://groups.hzrd149.com',
    name: "hzrd149's Groups",
    description: 'Nostr developer communities (nsite, applesauce, blossom, TollGate, RxJS).',
    supportsCreate: false,
    requiresAuth: true,
  },
  {
    url: 'wss://spatia-arcana.com',
    name: 'Spatia-Arcana',
    description: 'Active community spaces (Nostr Study Group, Hearts in Nature, Center for the Arts, general).',
    supportsCreate: false,
    requiresAuth: true,
  },
  {
    url: 'wss://support.flotilla.social',
    name: 'Flotilla Community',
    description: 'Active Nostr spaces & client community (General, Calls, Guides; NIP-42 AUTH).',
    supportsCreate: false,
    requiresAuth: true,
  },
  {
    url: 'wss://basspistol.org',
    name: 'Basspistol Syndicate',
    description: 'Independent music & city communities (Berlin, Barcelona, Stockholm, DubHeads, Mix Tape).',
    supportsCreate: false,
    requiresAuth: true,
  },
  {
    url: 'wss://inner.sebastix.social',
    name: 'Sebastix Community',
    description: 'Active developer & self-hosting rooms (Omarchy, Nuxtstack, Nostr-PHP, SebastixChat).',
    supportsCreate: false,
    requiresAuth: true,
  },
]

export function nip29ServerId(relayUrl: string, groupId: string): string {
  try {
    const host = new URL(relayUrl).host.toLowerCase()
    return `nip29:${host}:${groupId}`
  } catch {
    return `nip29:${relayUrl}:${groupId}`
  }
}

export function generateNip29GroupId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 7)
  return slug ? `${slug}-${rand}` : `grp-${rand}`
}

export interface Nip11Info {
  name?: string
  description?: string
  supportedNips: number[]
  supportsNip29: boolean
  selfPubkey?: string
}

export async function fetchNip11Info(relayUrl: string, timeoutMs = 4500): Promise<Nip11Info | null> {
  const httpUrl = relayUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:')
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(httpUrl, {
      headers: { Accept: 'application/nostr+json' },
      signal: controller.signal,
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      name?: string
      description?: string
      supported_nips?: number[]
      self?: string
      pubkey?: string
    }
    const nips = Array.isArray(json.supported_nips)
      ? json.supported_nips.filter((n): n is number => typeof n === 'number')
      : []
    return {
      name: typeof json.name === 'string' ? json.name : undefined,
      description: typeof json.description === 'string' ? json.description : undefined,
      supportedNips: nips,
      supportsNip29: nips.includes(29),
      selfPubkey: typeof json.self === 'string' ? json.self : typeof json.pubkey === 'string' ? json.pubkey : undefined,
    }
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

export function buildNip42AuthTemplate(relayUrl: string, challenge: string): EventTemplate {
  return {
    kind: KIND_NIP42_AUTH,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['relay', relayUrl],
      ['challenge', challenge],
    ],
    content: '',
  }
}

export function parseNip29GroupMeta(event: NostrEvent, relayUrl: string): Nip29GroupMeta | null {
  if (event.kind !== KIND_NIP29_GROUP_META) return null
  const groupId = getTagValue(event.tags, 'd')?.trim()
  if (!groupId || groupId === '_') return null

  const name = getTagValue(event.tags, 'name')?.trim() || groupId
  if (name === '[deleted]') return null

  const about = getTagValue(event.tags, 'about')?.trim() ?? ''
  const picture = getTagValue(event.tags, 'picture')?.trim() || undefined
  const banner = getTagValue(event.tags, 'banner')?.trim() || undefined
  const isPrivate = event.tags.some((t) => t[0] === 'private')
  const isClosed = event.tags.some((t) => t[0] === 'closed')
  const isRestricted = event.tags.some((t) => t[0] === 'restricted')
  const isHidden = event.tags.some((t) => t[0] === 'hidden')
  const skTag = event.tags.find((t) => t[0] === 'supported_kinds')
  const supportedKinds = skTag
    ? skTag
        .slice(1)
        .map((n) => Number.parseInt(n, 10))
        .filter((n) => Number.isFinite(n))
    : undefined

  return {
    relayUrl,
    groupId,
    name,
    about,
    picture,
    banner,
    isPrivate,
    isClosed,
    isRestricted,
    isHidden,
    supportedKinds,
    updatedAt: event.created_at,
  }
}

export function parseNip29AdminsEvent(event: NostrEvent): Array<{ pubkey: string; roles: string[] }> {
  if (event.kind !== KIND_NIP29_GROUP_ADMINS) return []
  const out: Array<{ pubkey: string; roles: string[] }> = []
  const seen = new Set<string>()
  for (const tag of event.tags) {
    if (tag[0] !== 'p' || typeof tag[1] !== 'string' || !/^[0-9a-f]{64}$/i.test(tag[1])) continue
    const pk = tag[1].toLowerCase()
    if (seen.has(pk)) continue
    seen.add(pk)
    const roles = tag.slice(2).filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    out.push({ pubkey: pk, roles: roles.length > 0 ? roles : ['admin'] })
  }
  return out
}

export function parseNip29MembersEvent(event: NostrEvent): string[] {
  if (event.kind !== KIND_NIP29_GROUP_MEMBERS) return []
  const set = new Set<string>()
  for (const tag of event.tags) {
    if (tag[0] === 'p' && typeof tag[1] === 'string' && /^[0-9a-f]{64}$/i.test(tag[1])) {
      set.add(tag[1].toLowerCase())
    }
  }
  return Array.from(set)
}

export function buildNip29ChatTemplate(opts: {
  groupId: string
  content: string
  nickname?: string
  previousIds?: readonly string[]
  replyTo?: ServerMessage | null
  voiceMemo?: VoiceMemoAttachment
  imageAttachment?: ImageAttachment
  torrentAttachment?: TorrentAttachment
  lightningAddress?: string | null
}): EventTemplate {
  const tags: string[][] = [['h', opts.groupId]]

  if (opts.previousIds && opts.previousIds.length > 0) {
    const refs = opts.previousIds
      .slice(-4)
      .map((id) => id.slice(0, 8))
      .filter((s) => s.length === 8)
    if (refs.length > 0) {
      tags.push(['previous', ...refs])
    }
  }

  const cleanNick = opts.nickname?.trim()
  if (cleanNick) {
    tags.push(['n', cleanNick])
  }
  const cleanLud16 = opts.lightningAddress?.trim()
  if (cleanLud16) {
    tags.push(['lud16', cleanLud16])
  }

  if (opts.replyTo && !opts.replyTo.isSystem) {
    tags.push(['q', opts.replyTo.id])
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
    kind: KIND_NIP29_CHAT,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: opts.content,
  }
}

export function parseNip29ChatEvent(
  event: NostrEvent,
  serverId: string,
  groupId: string,
  ownPubkeys: Set<string>,
  findMessageById?: (id: string) => ServerMessage | undefined,
  getKnownNickname?: (pubkey: string) => string | null
): ServerMessage | null {
  if (event.kind !== KIND_NIP29_CHAT) return null
  const h = getTagValue(event.tags, 'h')
  if (h !== groupId) return null

  const content = (event.content ?? '').trim()
  if (!content) return null

  const pubkey = event.pubkey.toLowerCase()
  const rawNick = getTagValue(event.tags, 'n')?.trim() || getKnownNickname?.(pubkey) || ''
  const nickname = rawNick || `anon${pubkey.slice(-4)}`
  const voiceMemo = parseVoiceMemoFromImeta(event.tags)
  const imageAttachment = parseImageFromImeta(event.tags)
  const torrentAttachment = parseTorrentFromTags(event.tags, pubkey) ?? undefined

  let replyTo: ReplyReference | undefined
  const refTag =
    event.tags.find((t) => t[0] === 'q' && typeof t[1] === 'string' && t[1].length >= 16) ??
    event.tags.find((t) => t[0] === 'e' && typeof t[1] === 'string' && t[1].length >= 16)
  if (refTag) {
    const parent = findMessageById?.(refTag[1])
    replyTo = {
      id: refTag[1],
      pubkey: parent?.pubkey ?? getTagValue(event.tags, 'p') ?? undefined,
      nickname: parent?.nickname,
      preview: parent ? parent.content.slice(0, 120) : undefined,
    }
  }

  return {
    id: event.id,
    serverId,
    channelId: groupId,
    pubkey,
    nickname,
    displayHandle: formatDisplayHandle(nickname, pubkey),
    content,
    createdAt: clampTimestamp(event.created_at),
    tags: event.tags,
    isOwn: ownPubkeys.has(pubkey),
    isEmote: isEmoteContent(content),
    encrypted: false,
    powBits: getValidatedPowBits(event.id, event.tags),
    replyTo,
    reactions: [],
    mentions: extractMentions(content),
    voiceMemo,
    imageAttachment,
    torrentAttachment,
    deliveryStatus: 'sent',
  }
}

export function buildNip29ReactionTemplate(opts: {
  groupId: string
  targetEventId: string
  targetPubkey: string
  emoji: string
}): EventTemplate {
  return {
    kind: KIND_EPHEMERAL_REACTION,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['h', opts.groupId],
      ['e', opts.targetEventId],
      ['p', opts.targetPubkey.toLowerCase()],
    ],
    content: opts.emoji,
  }
}

export function buildNip29JoinTemplate(groupId: string, inviteCode?: string, reason = ''): EventTemplate {
  const tags: string[][] = [['h', groupId]]
  if (inviteCode?.trim()) {
    tags.push(['code', inviteCode.trim()])
  }
  return {
    kind: KIND_NIP29_JOIN,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: reason,
  }
}

export function buildNip29LeaveTemplate(groupId: string): EventTemplate {
  return {
    kind: KIND_NIP29_LEAVE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['h', groupId]],
    content: '',
  }
}

export function buildNip29CreateGroupTemplate(groupId: string): EventTemplate {
  return {
    kind: KIND_NIP29_CREATE_GROUP,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['h', groupId]],
    content: '',
  }
}

export function buildNip29EditMetadataTemplate(opts: {
  groupId: string
  name?: string
  about?: string
  picture?: string
  isPrivate?: boolean
  isClosed?: boolean
}): EventTemplate {
  const tags: string[][] = [['h', opts.groupId]]
  if (opts.name !== undefined) tags.push(['name', opts.name.trim()])
  if (opts.about !== undefined) tags.push(['about', opts.about.trim()])
  if (opts.picture !== undefined) tags.push(['picture', opts.picture.trim()])
  if (opts.isPrivate !== undefined) tags.push([opts.isPrivate ? 'private' : 'public'])
  if (opts.isClosed !== undefined) tags.push([opts.isClosed ? 'closed' : 'open'])
  return {
    kind: KIND_NIP29_EDIT_META,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }
}

export function buildNip29PutUserTemplate(groupId: string, pubkey: string, roles: string[] = []): EventTemplate {
  const pTag = ['p', pubkey.toLowerCase(), ...roles.filter(Boolean)]
  return {
    kind: KIND_NIP29_PUT_USER,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['h', groupId], pTag],
    content: '',
  }
}

export function buildNip29RemoveUserTemplate(groupId: string, pubkey: string, reason = ''): EventTemplate {
  return {
    kind: KIND_NIP29_REMOVE_USER,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['h', groupId],
      ['p', pubkey.toLowerCase()],
    ],
    content: reason,
  }
}

export function buildNip29DeleteEventTemplate(groupId: string, eventId: string, reason = ''): EventTemplate {
  return {
    kind: KIND_NIP29_DELETE_EVENT,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['h', groupId],
      ['e', eventId],
    ],
    content: reason,
  }
}

export function buildNip29DeleteGroupTemplate(groupId: string): EventTemplate {
  return {
    kind: KIND_NIP29_DELETE_GROUP,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['h', groupId]],
    content: '',
  }
}
