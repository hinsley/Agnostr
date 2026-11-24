export interface Env {
  PUSH_KV: KVNamespace
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

export interface StoredPushPreferences {
  dms: boolean
  directPings: boolean
  dmCallRinging: boolean
  serverMessages: boolean
  serverCalls: boolean
  geoMessages: boolean
  showPreviews: boolean
}

export interface StoredDeviceSubscription {
  endpointHash: string
  subscription: WebPushSubscriptionJSON
  relays: string[]
  geohashes: string[]
  serverIds: string[]
  preferences: StoredPushPreferences
  updatedAt: number
}

export interface StoredUserRecord {
  pubkey: string
  devices: StoredDeviceSubscription[]
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
  | 'test'

export type PokeCategory = PushCategory | 'call-cancel'

export interface IncomingPushPayload {
  title?: string
  body?: string
  tag?: string
  badgeCount?: number
  forceShow?: boolean
  action?: string
  type?: string
  callId?: string
  data?: {
    category: PushCategory
    tag?: string
    callId?: string
    mediaType?: 'audio' | 'video'
    peerPubkey?: string
    serverId?: string
    channelId?: string
    geohash?: string
    callerNickname?: string
  }
}

export const DEFAULT_PUSH_PREFERENCES: StoredPushPreferences = {
  dms: true,
  directPings: true,
  dmCallRinging: true,
  serverMessages: true,
  serverCalls: true,
  geoMessages: false,
  showPreviews: true,
}

export const MAX_DEVICES_PER_PUBKEY = 5
export const PUBKEYS_INDEX_KEY = 'pubkeys:index'

export function subKeyForPubkey(pubkey: string): string {
  return `sub:${pubkey.toLowerCase()}`
}

export function seenKeyForEvent(eventId: string): string {
  return `seen:${eventId.toLowerCase()}`
}
