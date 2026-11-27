export type NotificationFilterMode = 'all' | 'mentions' | 'off'

export type NotificationPermissionState =
  | 'default'
  | 'granted'
  | 'denied'
  | 'unsupported'

export type PushSubscriptionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'unsupported'
  | 'error'

export type NotificationCategory =
  | 'dm'
  | 'dm-call'
  | 'server-message'
  | 'server-call'
  | 'geo-message'
  | 'geo-call'
  | 'agmail'
  | 'location-note'
  | 'agora-reply'
  | 'agora-mention'
  | 'agora-like'
  | 'agora-repost'
  | 'agora-zap'
  | 'agora-follow'
  | 'test'

export interface PushPokePayload {
  recipientPubkeys: string[]
  category:
    | 'dm'
    | 'dm-call'
    | 'server-message'
    | 'server-call'
    | 'geo-message'
    | 'geo-call'
    | 'agmail'
    | 'agmail-cc'
    | 'call-cancel'
    | 'agora-reply'
    | 'agora-mention'
    | 'agora-like'
    | 'agora-repost'
    | 'agora-zap'
    | 'agora-follow'
  eventId?: string
  noteId?: string
  callId?: string
  mediaType?: 'audio' | 'video'
  serverId?: string
  channelId?: string
  geohash?: string
  senderName?: string
  preview?: string
  isMention?: boolean
}

export interface NotificationSettings {
  enabled: boolean
  dms: boolean
  agmail: boolean
  agmailCcBcc: boolean
  directPings: boolean
  dmCallRinging: boolean
  serverMessages: NotificationFilterMode
  serverCalls: boolean
  geoMessages: NotificationFilterMode
  agoraRepliesMentions: boolean
  agoraReactionsReposts: boolean
  agoraZaps: boolean
  agoraFollows: boolean
  soundEnabled: boolean
  ringtoneEnabled: boolean
  vibrationEnabled: boolean
  showPreviews: boolean
  showDmPreviews: boolean
  pushBridgeUrl: string
  backgroundPushEnabled: boolean
  publicPinnedRoomFallback: boolean
  extensionPushPokes: boolean
  vapidPublicKey: string
  prefsVersion?: number
}

export interface NotificationPayloadData {
  category: NotificationCategory
  /** Exact delivery event, distinct from a referenced note ID. */
  deliveryEventId?: string
  /** Ephemeral current-device Test Push correlation ID. */
  testId?: string
  tag?: string
  callId?: string
  mediaType?: 'audio' | 'video'
  peerPubkey?: string
  recipientPubkey?: string
  serverId?: string
  channelId?: string
  geohash?: string
  noteId?: string
  callerNickname?: string
  /** A locally decrypted preview already displayed by the receiving client. */
  localDmPreview?: boolean
}

export interface PendingNotificationAction {
  action: 'open' | 'answer' | 'answer-audio' | 'decline'
  payload: NotificationPayloadData
  receivedAt: number
}

export interface NotificationEngine {
  // Browser capability & permission state
  permission: NotificationPermissionState
  isSupported: boolean
  isPushSupported: boolean
  usesExternalPushSigner: boolean
  publicPinnedRoomFallbackAvailable: boolean
  isIosRequiresInstall: boolean

  // Persisted notification preferences
  settings: NotificationSettings
  updateSettings: (patch: Partial<NotificationSettings>) => void

  // User-gesture actions
  requestPermission: () => Promise<NotificationPermissionState>
  sendTestNotification: () => Promise<boolean>
  testRingtone: () => void

  // Live incoming DM call ringing controls
  isRinging: boolean
  isRingMuted: boolean
  muteCurrentRing: () => void

  // Deep-link / Service Worker notification click action handoff
  pendingAction: PendingNotificationAction | null
  consumePendingAction: () => void

  // Optional NIP-98 / VAPID Background Web Push Bridge
  pushStatus: PushSubscriptionStatus
  pushError: string | null
  pushEndpoint: string | null
  isUsingDefaultBridge: boolean
  connectPushBridge: (
    bridgeUrlOverride?: string,
    vapidKeyOverride?: string
  ) => Promise<boolean>
  disconnectPushBridge: (opts?: { keepAutomaticRegistration?: boolean }) => Promise<void>
  sendTestPush: () => Promise<{ ok: boolean; detail: string }>
  pokeRecipients: (payload: PushPokePayload) => void
}
