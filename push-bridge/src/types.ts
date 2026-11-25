export interface Env {
  PUSH_KV: KVNamespace
  PUSH_DELIVERY: DurableObjectNamespace
  VAPID_PUBLIC_KEY: string
  VAPID_PRIVATE_KEY: string
  VAPID_SUBJECT: string
}

export interface WebPushSubscriptionJSON {
  endpoint: string
  expirationTime?: number | null
  keys: {
    p256dh: string
    auth: string
  }
}

export type PushFilterMode = 'all' | 'mentions' | 'off'

export interface StoredPushPreferences {
  dms: boolean
  agmail: boolean
  agmailCcBcc: boolean
  directPings: boolean
  dmCallRinging: boolean
  serverMessages: PushFilterMode
  serverCalls: boolean
  geoMessages: PushFilterMode
  agoraRepliesMentions: boolean
  agoraReactionsReposts: boolean
  agoraZaps: boolean
  agoraFollows: boolean
  showPreviews: boolean
}

export interface StoredDeviceSubscription {
  endpointHash: string
  subscription: WebPushSubscriptionJSON
  relays: string[]
  geohashes: string[]
  publicPinnedRoomFallback?: boolean
  publicPinnedRoomSince?: number
  serverIds: string[]
  preferences: StoredPushPreferences
  updatedAt: number
}

export interface StoredUserRecord {
  pubkey: string
  devices: StoredDeviceSubscription[]
  aliasPubkeys?: string[]
  updatedAt: number
}

export type PushCategory =
  | 'dm'
  | 'dm-call'
  | 'server-message'
  | 'server-call'
  | 'geo-message'
  | 'geo-call'
  | 'agmail'
  | 'agora-reply'
  | 'agora-mention'
  | 'agora-like'
  | 'agora-repost'
  | 'agora-zap'
  | 'agora-follow'
  | 'test'

export type PokeCategory = PushCategory | 'agmail-cc' | 'call-cancel'

export interface IncomingPushPayload {
  title?: string
  body?: string
  tag?: string
  badgeCount?: number
  forceShow?: boolean
  renotify?: boolean
  requireInteraction?: boolean
  vibrate?: number[]
  action?: string
  type?: string
  callId?: string
  data?: {
    category: PushCategory
    deliveryEventId?: string
    tag?: string
    testId?: string
    callId?: string
    mediaType?: 'audio' | 'video'
    peerPubkey?: string
    recipientPubkey?: string
    serverId?: string
    channelId?: string
    geohash?: string
    noteId?: string
    callerNickname?: string
  }
}

export const DEFAULT_PUSH_PREFERENCES: StoredPushPreferences = {
  dms: true,
  agmail: true,
  agmailCcBcc: true,
  directPings: true,
  dmCallRinging: true,
  serverMessages: 'mentions',
  serverCalls: true,
  geoMessages: 'mentions',
  agoraRepliesMentions: true,
  agoraReactionsReposts: true,
  agoraZaps: true,
  agoraFollows: true,
  showPreviews: true,
}

// This routing opt-in deliberately expires after the app is no longer
// refreshing its settings and cannot guarantee current local filtering.
export const PUBLIC_PINNED_ROOM_LEASE_MS = 12 * 60 * 60_000
export function publicRoomEnabled(device: StoredDeviceSubscription, now = Date.now()): boolean {
  return device.publicPinnedRoomFallback === true && device.preferences.geoMessages === 'all'
    && now-device.updatedAt < PUBLIC_PINNED_ROOM_LEASE_MS && typeof device.publicPinnedRoomSince === 'number'
}

export const MAX_DEVICES_PER_PUBKEY = 5
export const MAX_ALIAS_PUBKEYS = 16
export const PUBKEYS_INDEX_KEY = 'pubkeys:index'

export function subKeyForPubkey(pubkey: string): string {
  return `sub:${pubkey.toLowerCase()}`
}

export function aliasKeyForPubkey(aliasPubkey: string): string {
  return `alias:${aliasPubkey.toLowerCase()}`
}

export function seenKeyForEvent(eventId: string): string {
  return `seen:${eventId.toLowerCase()}`
}
