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
  | 'location-note'
  | 'test'

export interface NotificationSettings {
  enabled: boolean
  dms: boolean
  directPings: boolean
  dmCallRinging: boolean
  serverMessages: NotificationFilterMode
  serverCalls: boolean
  geoMessages: NotificationFilterMode
  soundEnabled: boolean
  ringtoneEnabled: boolean
  vibrationEnabled: boolean
  showPreviews: boolean
  pushBridgeUrl: string
  vapidPublicKey: string
}

export interface NotificationPayloadData {
  category: NotificationCategory
  tag?: string
  callId?: string
  mediaType?: 'audio' | 'video'
  peerPubkey?: string
  serverId?: string
  channelId?: string
  geohash?: string
  callerNickname?: string
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
  connectPushBridge: (
    bridgeUrlOverride?: string,
    vapidKeyOverride?: string
  ) => Promise<boolean>
  disconnectPushBridge: () => Promise<void>
}
