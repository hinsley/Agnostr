import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EventTemplate, VerifiedEvent } from 'nostr-tools'
import type { GeoCallPresence, IncomingCallOffer, RoomCallPresence } from '../types/calls.ts'
import type {
  NotificationCategory,
  NotificationPayloadData,
  NotificationPermissionState,
  NotificationSettings,
  NotificationEngine,
  PendingNotificationAction,
  PushPokePayload,
  PushSubscriptionStatus,
} from '../types/notifications.ts'
import type { ActiveView, DmThread, ToastLevel } from '../types/protocol.ts'
import type { ServerMessage, ServerSummary } from '../types/servers.ts'
import { doesContentMentionUser } from '../lib/bitchatProtocol.ts'
import {
  formatBitchatChannelHash,
  formatBitchatChannelLabel,
  isTopicChannel,
} from '../lib/bitchatChannel.ts'
import {
  canUsePublicPinnedRoomFallback,
  closeCallNotificationsViaSw,
  closeDmPreviews,
  getBrowserNotificationPermission,
  isWebPushSupported,
  normalizePushBridgeUrl,
  parseNotifyHash,
  readCurrentPushEndpoint,
  registerWithPushBridge,
  requestBrowserNotificationPermission,
  sendPushPoke,
  sendTestWebPush,
  showOsNotification,
  unregisterFromPushBridge,
} from '../lib/notifications.ts'
import { soundEngine } from '../lib/soundEngine.ts'
import { getLiveDmPush, normalizePushIdentifier } from '../lib/pushDisplay.ts'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_PUSH_BRIDGE_URL,
  loadNotificationSettings,
  saveNotificationSettings,
} from '../lib/storage.ts'
import {
  getPwaSwRegistration,
  isIosSafariNonStandalone,
  isPwaStandaloneMode,
} from './usePwa.ts'

const MAX_NOTIFIED_IDS = 500
const LIVE_RECENCY_WINDOW_SEC = 180
const NOTIFICATIONS_STORAGE_KEY = 'agnostr:v2:notifications'
const PUSH_RECHECK_MS = 15 * 60_000
const PUSH_REFRESH_MS = 12 * 60 * 60_000
const PUBLIC_ROOM_PUSH_REFRESH_MS = 105 * 60_000
const AUTO_PUSH_RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const

function hasExplicitlyDisabledNotificationsInStorage(): boolean {
  try {
    const raw = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as { enabled?: unknown }
    return parsed?.enabled === false
  } catch {
    return false
  }
}

export interface NotifyGeoMessageInput {
  id: string
  geohash: string
  senderPubkey?: string
  senderHandle: string
  content: string
  mentionedMe: boolean
  repliedToMe?: boolean
  hasVoice?: boolean
  hasImage?: boolean
}

export interface NotifyLocationNoteInput {
  id: string
  geohash: string
  senderPubkey?: string
  senderHandle: string
  content: string
}

export interface NotifyAmailInput {
  id: string
  senderPubkey: string
  senderName: string
  subject: string
  recipientRole: 'to' | 'cc' | 'bcc'
}

export interface NotifyAgoraInput {
  id: string
  kind: 'reply' | 'mention' | 'quote' | 'like' | 'repost' | 'zap' | 'follow'
  actorPubkey: string
  actorName: string
  noteId?: string
  preview?: string
  sats?: number
}

export interface UseNotificationsParams {
  activeView: ActiveView
  activeGeohash: string
  ownPubkeys: Set<string>
  blockedSet: Set<string>
  trustedSet: Set<string>
  strictWhitelistMode: boolean
  masterPubkey: string
  nickname: string
  dmThreads: DmThread[]
  joinedServers: ServerSummary[]
  activeServer: ServerSummary | null
  activeChannelId: string | null
  activeServerMessages: ServerMessage[]
  incomingCall: IncomingCallOffer | null
  isOutgoingDmRinging: boolean
  serverCallRosters: Record<string, RoomCallPresence[]>
  activeCallServerId: string | null
  geoCallRosters: Record<string, GeoCallPresence[]>
  activeCallGeohash: string | null
  ownGeoCallPubkeys: Set<string>
  relayUrls: string[]
  pinnedGeohashes: string[]
  aliasPubkeys?: string[]
  canAutoSign?: boolean
  signEvent: (tmpl: EventTemplate) => Promise<VerifiedEvent>
  pushToast: (level: ToastLevel, title: string, detail?: string) => void
}

export interface UseNotificationsResult {
  notifications: NotificationEngine
  notifyGeoMessage: (input: NotifyGeoMessageInput) => void
  notifyLocationNote: (input: NotifyLocationNoteInput) => void
  notifyAmail: (input: NotifyAmailInput) => boolean
  notifyAgora: (input: NotifyAgoraInput) => void
  resetAllNotifications: () => void
}

function isDocumentFocusedAndVisible(): boolean {
  if (typeof document === 'undefined') return true
  try {
    return document.visibilityState === 'visible' && document.hasFocus()
  } catch {
    return document.visibilityState === 'visible'
  }
}

function truncatePreview(raw: string, maxLen = 110): string {
  const clean = raw.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxLen) return clean
  return `${clean.slice(0, maxLen - 1)}…`
}

export function useNotifications(
  params: UseNotificationsParams
): UseNotificationsResult {
  const {
    activeView,
    activeGeohash,
    ownPubkeys,
    blockedSet,
    trustedSet,
    strictWhitelistMode,
    masterPubkey,
    nickname,
    dmThreads,
    joinedServers,
    activeServer,
    activeChannelId,
    activeServerMessages,
    incomingCall,
    isOutgoingDmRinging,
    serverCallRosters,
    activeCallServerId,
    geoCallRosters,
    activeCallGeohash,
    ownGeoCallPubkeys,
    relayUrls,
    pinnedGeohashes,
    aliasPubkeys = [],
    canAutoSign = false,
    signEvent,
    pushToast,
  } = params

  const [permission, setPermission] = useState<NotificationPermissionState>(() =>
    getBrowserNotificationPermission()
  )
  const explicitlyDisabledRef = useRef<boolean>(
    hasExplicitlyDisabledNotificationsInStorage()
  )
  const [settings, setSettings] = useState<NotificationSettings>(() => {
    const loaded = loadNotificationSettings()
    const perm = getBrowserNotificationPermission()
    if (perm === 'denied' && loaded.enabled) {
      return { ...loaded, enabled: false }
    }
    if (
      perm === 'granted' &&
      !loaded.enabled &&
      !hasExplicitlyDisabledNotificationsInStorage()
    ) {
      const autoEnabled: NotificationSettings = { ...loaded, enabled: true }
      saveNotificationSettings(autoEnabled)
      return autoEnabled
    }
    return loaded
  })

  const [isRinging, setIsRinging] = useState(false)
  const [isRingMuted, setIsRingMuted] = useState(false)
  const [pendingAction, setPendingAction] =
    useState<PendingNotificationAction | null>(() => {
      if (typeof window === 'undefined') return null
      const parsed = parseNotifyHash(window.location.hash || '')
      if (parsed) {
        try {
          window.history.replaceState(window.history.state, '', formatBitchatChannelHash(activeGeohash))
        } catch {
          // Ignore
        }
      }
      return parsed
    })

  const [pushStatus, setPushStatus] = useState<PushSubscriptionStatus>(() =>
    isWebPushSupported() ? 'disconnected' : 'unsupported'
  )
  const [pushError, setPushError] = useState<string | null>(null)
  const [pushEndpoint, setPushEndpoint] = useState<string | null>(null)
  const pushStatusRef = useRef<PushSubscriptionStatus>(pushStatus)
  pushStatusRef.current = pushStatus
  const pushEndpointRef = useRef<string | null>(pushEndpoint)
  pushEndpointRef.current = pushEndpoint
  const pushErrorRef = useRef<string | null>(pushError)
  pushErrorRef.current = pushError
  const pushRegisterInFlightRef = useRef<{
    key: string
    operation: Promise<boolean>
  } | null>(null)
  const lastPushRegistrationAtRef = useRef(0)
  const pushRegistrationEpochRef = useRef(0)
  const lastPokeErrorAtRef = useRef(0)
  const lastSyncedPushFingerprintRef = useRef<string | null>(null)
  const prefsFingerprintRef = useRef<string>('')
  const autoRetryAttemptRef = useRef<number>(0)
  const autoRetryTimerRef = useRef<number | null>(null)
  const [autoSyncTick, setAutoSyncTick] = useState<number>(0)
  const canAutoSignRef = useRef<boolean>(canAutoSign)
  canAutoSignRef.current = canAutoSign

  const sessionBootSecRef = useRef<number>(Math.floor(Date.now() / 1000))
  const notifiedIdsRef = useRef<Set<string>>(new Set())
  const seenDmIdsRef = useRef<Set<string> | null>(null)
  const seenServerMsgIdsRef = useRef<Set<string>>(new Set())
  const lastServerChanKeyRef = useRef<string>('')
  const seenRosterKeysRef = useRef<Set<string>>(new Set())
  const seenGeoRosterKeysRef = useRef<Set<string>>(new Set())
  const rosterBootedRef = useRef<boolean>(false)
  const activeRingingCallIdRef = useRef<string | null>(null)
  const swRingSafetyTimerRef = useRef<number | null>(null)

  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const permissionRef = useRef(permission)
  permissionRef.current = permission
  const activeViewRef = useRef(activeView)
  activeViewRef.current = activeView
  const ownPubkeysRef = useRef(ownPubkeys)
  ownPubkeysRef.current = ownPubkeys
  const blockedSetRef = useRef(blockedSet)
  blockedSetRef.current = blockedSet
  const trustedSetRef = useRef(trustedSet)
  trustedSetRef.current = trustedSet
  const strictWhitelistRef = useRef(strictWhitelistMode)
  strictWhitelistRef.current = strictWhitelistMode
  const ownGeoCallPubkeysRef = useRef(ownGeoCallPubkeys)
  ownGeoCallPubkeysRef.current = ownGeoCallPubkeys
  const masterPubkeyRef = useRef(masterPubkey)
  masterPubkeyRef.current = masterPubkey
  const nicknameRef = useRef(nickname)
  nicknameRef.current = nickname
  const relayUrlsRef = useRef(relayUrls)
  relayUrlsRef.current = relayUrls
  const pinnedGeohashesRef = useRef(pinnedGeohashes)
  pinnedGeohashesRef.current = pinnedGeohashes
  const normalizedAliasPubkeys = useMemo(() => {
    const master = masterPubkey.toLowerCase()
    return Array.from(
      new Set(
        aliasPubkeys
          .map((pk) => pk.trim().toLowerCase())
          .filter((pk) => /^[0-9a-f]{64}$/.test(pk) && pk !== master)
      )
    )
      .sort()
      .slice(0, 16)
  }, [aliasPubkeys, masterPubkey])
  const aliasPubkeysRef = useRef<string[]>(normalizedAliasPubkeys)
  aliasPubkeysRef.current = normalizedAliasPubkeys
  const joinedServersRef = useRef(joinedServers)
  joinedServersRef.current = joinedServers
  const signEventRef = useRef(signEvent)
  signEventRef.current = signEvent
  const pushToastRef = useRef(pushToast)
  pushToastRef.current = pushToast

  const isSupported = permission !== 'unsupported'
  const isPushSupported = useMemo(() => isWebPushSupported(), [])
  const isIosRequiresInstall = useMemo(() => isIosSafariNonStandalone(), [])

  const rememberNotified = useCallback((id: string): boolean => {
    if (!id) return true
    if (notifiedIdsRef.current.has(id)) return false
    notifiedIdsRef.current.add(id)
    if (notifiedIdsRef.current.size > MAX_NOTIFIED_IDS) {
      const first = notifiedIdsRef.current.values().next().value
      if (first) notifiedIdsRef.current.delete(first)
    }
    return true
  }, [])

  const handleDirectNotificationClick = useCallback(
    (payload: NotificationPayloadData) => {
      setPendingAction({
        action: 'open',
        payload,
        receivedAt: Date.now(),
      })
    },
    []
  )

  const canSendOsNotification = useCallback((): boolean => {
    return (
      permissionRef.current === 'granted' && settingsRef.current.enabled
    )
  }, [])

  const isDmPreviewEnabledInSession = useCallback(() => {
    const cfg = settingsRef.current
    return cfg.enabled && cfg.dms && cfg.showPreviews && cfg.showDmPreviews
  }, [])

  const updateSettings = useCallback((patch: Partial<NotificationSettings>) => {
    if (patch.enabled === false || patch.backgroundPushEnabled === false) {
      pushRegistrationEpochRef.current += 1
    }
    if (patch.enabled === false) {
      explicitlyDisabledRef.current = true
    } else if (patch.enabled === true) {
      explicitlyDisabledRef.current = false
    }
    // Persist privacy changes before a queued notification can resume after an await.
    const next = { ...settingsRef.current, ...patch }
    settingsRef.current = next
    saveNotificationSettings(next)
    setSettings(next)
    if (patch.showDmPreviews === false || patch.showPreviews === false || patch.dms === false || patch.enabled === false) {
      void closeDmPreviews(isDmPreviewEnabledInSession)
    }
  }, [isDmPreviewEnabledInSession])

  useEffect(() => {
    const syncDmPreview = (event: StorageEvent) => {
      if (event.key !== null && event.key !== NOTIFICATIONS_STORAGE_KEY) return
      const stored = loadNotificationSettings()
      setSettings((prev) => ({ ...prev, showDmPreviews: stored.showDmPreviews, showPreviews: stored.showPreviews }))
      if (!stored.showDmPreviews || !stored.showPreviews || !stored.dms || !stored.enabled) void closeDmPreviews()
    }
    if (!isDmPreviewEnabledInSession()) void closeDmPreviews()
    window.addEventListener('storage', syncDmPreview)
    return () => window.removeEventListener('storage', syncDmPreview)
  }, [isDmPreviewEnabledInSession])

  // Sync browser permission on visibility return + detect existing PushManager endpoint
  // (NEVER lie pushStatus='connected' before bridge registration actually confirms HTTP 200)
  useEffect(() => {
    const syncPermission = () => {
      const next = getBrowserNotificationPermission()
      permissionRef.current = next
      setPermission(next)
      if (next === 'denied' && settingsRef.current.enabled) {
        pushRegistrationEpochRef.current += 1
        lastSyncedPushFingerprintRef.current = null
        setPushStatus('disconnected')
        pushStatusRef.current = 'disconnected'
        setSettings((prev) => {
          const updated: NotificationSettings = { ...prev, enabled: false }
          settingsRef.current = updated
          saveNotificationSettings(updated)
          return updated
        })
      } else if (
        next === 'granted' &&
        !settingsRef.current.enabled &&
        !explicitlyDisabledRef.current &&
        !hasExplicitlyDisabledNotificationsInStorage()
      ) {
        updateSettings({ enabled: true })
      }
    }

    document.addEventListener('visibilitychange', syncPermission)

    if (isWebPushSupported()) {
      void getPwaSwRegistration().then(async (reg) => {
        if (!reg?.pushManager) return
        try {
          const existing = await reg.pushManager.getSubscription()
          if (existing) {
            setPushEndpoint(existing.endpoint)
            pushEndpointRef.current = existing.endpoint
          }
        } catch {
          // Ignore
        }
      })
    }

    return () => {
      document.removeEventListener('visibilitychange', syncPermission)
    }
  }, [updateSettings])

  // Listen for Service Worker notification click actions, incoming call ring wakeups, & hash deep links
  useEffect(() => {
    const clearSwRingTimer = () => {
      if (swRingSafetyTimerRef.current !== null) {
        window.clearTimeout(swRingSafetyTimerRef.current)
        swRingSafetyTimerRef.current = null
      }
    }

    const onSwMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string
        action?: unknown
        payload?: NotificationPayloadData
        callId?: string
        peerPubkey?: string
        recipientPubkey?: string
      } | null
      if (!data || typeof data !== 'object') return

      if (data.type === 'agnostr-incoming-call-cancel') {
        const cancelId = typeof data.callId === 'string' ? data.callId : null
        if (!cancelId || activeRingingCallIdRef.current === cancelId) {
          clearSwRingTimer()
          activeRingingCallIdRef.current = null
          soundEngine.stopIncomingRing()
          setIsRinging(false)
          setIsRingMuted(false)
        }
        return
      }

      if (data.type === 'agnostr-incoming-call-ring') {
        const cfg = settingsRef.current
        if (!cfg.dmCallRinging) return
        const targetRecipient =
          typeof data.recipientPubkey === 'string'
            ? data.recipientPubkey.trim().toLowerCase()
            : ''
        if (
          targetRecipient &&
          masterPubkeyRef.current &&
          targetRecipient !== masterPubkeyRef.current.toLowerCase()
        ) {
          return
        }
        const callerPk =
          typeof data.peerPubkey === 'string' ? data.peerPubkey.trim().toLowerCase() : ''
        if (callerPk) {
          if (blockedSetRef.current.has(callerPk) || ownPubkeysRef.current.has(callerPk)) return
          if (!trustedSetRef.current.has(callerPk)) return
        }
        const incomingId =
          typeof data.callId === 'string' && data.callId.trim()
            ? data.callId.trim()
            : `sw-ring-${Date.now()}`
        if (activeRingingCallIdRef.current !== incomingId) {
          activeRingingCallIdRef.current = incomingId
          setIsRingMuted(false)
        }
        soundEngine.startIncomingRing({
          playAudio: cfg.ringtoneEnabled,
          vibrate: cfg.vibrationEnabled,
        })
        setIsRinging(true)
        clearSwRingTimer()
        swRingSafetyTimerRef.current = window.setTimeout(() => {
          swRingSafetyTimerRef.current = null
          if (activeRingingCallIdRef.current === incomingId) {
            activeRingingCallIdRef.current = null
            soundEngine.stopIncomingRing()
            setIsRinging(false)
            setIsRingMuted(false)
          }
        }, 45_000)
        return
      }

      if (data.type !== 'AGNOSTR_NOTIFICATION_ACTION' || !data.payload) {
        return
      }
      const rawAction = data.action
      const action: PendingNotificationAction['action'] =
        rawAction === 'answer' ||
        rawAction === 'answer-audio' ||
        rawAction === 'decline'
          ? rawAction
          : 'open'
      setPendingAction({
        action,
        payload: data.payload,
        receivedAt: Date.now(),
      })
    }

    const onHashChange = () => {
      const parsed = parseNotifyHash(window.location.hash || '')
      if (parsed) {
        setPendingAction(parsed)
        try {
          window.history.replaceState(window.history.state, '', formatBitchatChannelHash(activeGeohash))
        } catch {
          // Ignore
        }
      }
    }

    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', onSwMessage)
    }
    window.addEventListener('hashchange', onHashChange)

    return () => {
      clearSwRingTimer()
      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', onSwMessage)
      }
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [activeGeohash])

  // 1. Incoming 1-on-1 DM Call Ringing (Trusted peers only — strict Trust gate already enforced in useCallEngine)
  useEffect(() => {
    const prevCallId = activeRingingCallIdRef.current
    const callerBlocked = Boolean(
      incomingCall && blockedSetRef.current.has(incomingCall.callerPubkey.toLowerCase())
    )

    if (!incomingCall || callerBlocked) {
      if (prevCallId) {
        if (swRingSafetyTimerRef.current !== null) {
          window.clearTimeout(swRingSafetyTimerRef.current)
          swRingSafetyTimerRef.current = null
        }
        activeRingingCallIdRef.current = null
        soundEngine.stopIncomingRing()
        setIsRinging(false)
        setIsRingMuted(false)
        void closeCallNotificationsViaSw(prevCallId)
      }
      return
    }

    if (prevCallId === incomingCall.callId) return
    activeRingingCallIdRef.current = incomingCall.callId

    const cfg = settingsRef.current
    if (cfg.dmCallRinging) {
      soundEngine.startIncomingRing({
        playAudio: cfg.ringtoneEnabled,
        vibrate: cfg.vibrationEnabled,
      })
      setIsRinging(true)
      setIsRingMuted(false)

      const shouldShowOsCall =
        canSendOsNotification() &&
        (!isDocumentFocusedAndVisible() || isPwaStandaloneMode())

      if (shouldShowOsCall) {
        const isVideo = incomingCall.mediaType === 'video'
        const title = cfg.showPreviews
          ? `${incomingCall.callerNickname} is calling`
          : 'Incoming DM Call'
        const body = cfg.showPreviews
          ? isVideo
            ? `Incoming encrypted video call (${incomingCall.callerDisplayHandle})`
            : `Incoming encrypted voice call (${incomingCall.callerDisplayHandle})`
          : 'Tap to answer in Agnostr'

        void showOsNotification({
          title,
          body,
          tag: `agnostr-call-${incomingCall.callId}`,
          requireInteraction: true,
          vibrate: cfg.vibrationEnabled
            ? [380, 180, 380, 1000, 380, 180, 380]
            : undefined,
          actions: [
            { action: 'answer', title: 'Accept' },
            { action: 'decline', title: 'Decline' },
          ],
          data: {
            category: 'dm-call',
            callId: incomingCall.callId,
            mediaType: incomingCall.mediaType,
            peerPubkey: incomingCall.callerPubkey,
            callerNickname: incomingCall.callerNickname,
          },
          onDirectClick: handleDirectNotificationClick,
        })
      }
    }
  }, [incomingCall, canSendOsNotification, handleDirectNotificationClick])

  // 2. Outgoing DM Call Ringback tone while awaiting recipient pickup
  useEffect(() => {
    if (isOutgoingDmRinging && settings.ringtoneEnabled) {
      soundEngine.startOutgoingRingback()
    } else {
      soundEngine.stopOutgoingRingback()
    }
    return () => {
      soundEngine.stopOutgoingRingback()
    }
  }, [isOutgoingDmRinging, settings.ringtoneEnabled])

  // 3. Live Encrypted DM Notifications (never spams historical backfill or own sent messages)
  useEffect(() => {
    if (!seenDmIdsRef.current) {
      const initial = new Set<string>()
      for (const thread of dmThreads) {
        for (const msg of thread.messages) initial.add(msg.id)
      }
      seenDmIdsRef.current = initial
      return
    }

    const seen = seenDmIdsRef.current
    const cfg = settingsRef.current
    const view = activeViewRef.current

    for (const thread of dmThreads) {
      const peerPk = thread.peerPubkey.toLowerCase()
      const peerBlocked = blockedSetRef.current.has(peerPk)
      for (const msg of thread.messages) {
        if (seen.has(msg.id)) continue
        seen.add(msg.id)

        const senderPk = msg.senderPubkey.toLowerCase()
        if (
          peerBlocked ||
          blockedSetRef.current.has(senderPk) ||
          msg.isOwn ||
          ownPubkeysRef.current.has(senderPk)
        ) {
          continue
        }
        if (msg.createdAt < sessionBootSecRef.current - LIVE_RECENCY_WINDOW_SEC) {
          continue
        }
        if (!cfg.dms) continue
        if (!rememberNotified(`dm:${msg.id}`)) continue

        const isViewingThread =
          view.type === 'dm' &&
          view.peerPubkey.toLowerCase() === thread.peerPubkey.toLowerCase()
        const docActive = isDocumentFocusedAndVisible()
        if (docActive && isViewingThread) continue

        if (cfg.soundEnabled) {
          soundEngine.playNotificationChime('dm', {
            vibrate: cfg.vibrationEnabled,
          })
        }

        if (canSendOsNotification()) {
          const previewText = msg.imageAttachment
            ? msg.content.trim()
              ? `Photo · ${truncatePreview(msg.content)}`
              : 'Sent an encrypted photo'
            : msg.voiceMemo
              ? `Voice memo (${Math.max(1, Math.round(msg.voiceMemo.durationSec))}s)`
              : truncatePreview(msg.content || 'Encrypted message')

          void showOsNotification({
            title: 'New Encrypted DM',
            body: 'New encrypted direct message on Agnostr',
            dmPreview: {
              title: `DM from ${thread.peerDisplayHandle}`,
              body: previewText,
              isStillAllowed: isDmPreviewEnabledInSession,
            },
            tag: `agnostr-dm-${thread.peerPubkey.slice(0, 12)}`,
            vibrate: cfg.vibrationEnabled ? [140, 80, 140] : undefined,
            data: {
              category: 'dm',
              ...getLiveDmPush(msg),
              peerPubkey: thread.peerPubkey,
              callerNickname: thread.peerNickname,
            },
            onDirectClick: handleDirectNotificationClick,
          })
        }
      }
    }
  }, [dmThreads, canSendOsNotification, handleDirectNotificationClick, isDmPreviewEnabledInSession, rememberNotified])

  // 4. Live Server Messages (Virtual & NIP-29) — never spams EOSE history or own messages
  useEffect(() => {
    const chanKey =
      activeServer && activeChannelId
        ? `${activeServer.id}:${activeChannelId}`
        : ''
    if (chanKey !== lastServerChanKeyRef.current) {
      lastServerChanKeyRef.current = chanKey
      seenServerMsgIdsRef.current = new Set(activeServerMessages.map((m) => m.id))
      return
    }
    if (!activeServer || !activeChannelId) return

    const seen = seenServerMsgIdsRef.current
    const cfg = settingsRef.current
    const view = activeViewRef.current
    const ownServerMsgIds = new Set<string>()
    for (const existing of activeServerMessages) {
      if (existing.isOwn || ownPubkeysRef.current.has(existing.pubkey.toLowerCase())) {
        ownServerMsgIds.add(existing.id)
      }
    }

    for (const msg of activeServerMessages) {
      if (seen.has(msg.id)) continue
      seen.add(msg.id)

      const msgPk = msg.pubkey.toLowerCase()
      if (
        msg.isSystem ||
        msg.isOwn ||
        ownPubkeysRef.current.has(msgPk) ||
        blockedSetRef.current.has(msgPk)
      ) {
        continue
      }
      if (strictWhitelistRef.current && !trustedSetRef.current.has(msgPk)) {
        continue
      }
      if (msg.createdAt < sessionBootSecRef.current - LIVE_RECENCY_WINDOW_SEC) {
        continue
      }

      const mentionedMe = doesContentMentionUser(
        msg.content,
        msg.mentions,
        nicknameRef.current,
        masterPubkeyRef.current
      )
      const repliedToMe = Boolean(
        msg.replyTo &&
          ((msg.replyTo.pubkey &&
            ownPubkeysRef.current.has(msg.replyTo.pubkey.toLowerCase())) ||
            ownServerMsgIds.has(msg.replyTo.id))
      )
      const isDirectPing = mentionedMe || repliedToMe
      const allowByDirectPing = isDirectPing && cfg.directPings
      const allowByChannelFilter =
        cfg.serverMessages === 'all' ||
        (cfg.serverMessages === 'mentions' && isDirectPing)

      if (!allowByDirectPing && !allowByChannelFilter) continue
      if (!rememberNotified(`srv:${msg.id}`)) continue

      const isViewingChannel =
        view.type === 'server' &&
        view.serverId === activeServer.id &&
        view.channelId === activeChannelId
      const docActive = isDocumentFocusedAndVisible()
      if (docActive && isViewingChannel) continue

      if (cfg.soundEnabled) {
        soundEngine.playNotificationChime(isDirectPing ? 'mention' : 'message', {
          vibrate: cfg.vibrationEnabled,
        })
      }

      if (canSendOsNotification()) {
        const channelObj = activeServer.channels.find(
          (c) => c.id === activeChannelId
        )
        const chanLabel = channelObj ? `#${channelObj.name}` : `#${activeChannelId}`
        const preview = msg.imageAttachment
          ? msg.content.trim()
            ? `Photo · ${truncatePreview(msg.content)}`
            : 'Shared a photo'
          : msg.voiceMemo
            ? `Voice memo (${Math.max(1, Math.round(msg.voiceMemo.durationSec))}s)`
            : truncatePreview(msg.content)

        const title = cfg.showPreviews
          ? repliedToMe
            ? `${msg.displayHandle} replied to you in ${activeServer.name} · ${chanLabel}`
            : mentionedMe
              ? `${msg.displayHandle} mentioned you in ${activeServer.name} · ${chanLabel}`
              : `${activeServer.name} · ${chanLabel}`
          : isDirectPing
            ? 'New Direct Ping'
            : 'New Group Message'

        const body = cfg.showPreviews
          ? isDirectPing
            ? preview
            : `${msg.displayHandle}: ${preview}`
          : 'New activity in one of your groups'

        void showOsNotification({
          title,
          body,
          tag: `agnostr-srv-${activeServer.id.slice(0, 12)}-${activeChannelId}`,
          vibrate: cfg.vibrationEnabled ? [120, 70, 120] : undefined,
          data: {
            category: 'server-message',
            deliveryEventId: normalizePushIdentifier(msg.id),
            recipientPubkey: normalizePushIdentifier(masterPubkeyRef.current),
            serverId: activeServer.id,
            channelId: activeChannelId,
          },
          onDirectClick: handleDirectNotificationClick,
        })
      }
    }
  }, [
    activeServer,
    activeChannelId,
    activeServerMessages,
    canSendOsNotification,
    handleDirectNotificationClick,
    rememberNotified,
  ])

  // 5. Live Server Group Call Joins across all joined servers
  useEffect(() => {
    const timer = window.setTimeout(() => {
      rosterBootedRef.current = true
    }, 3500)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    const nextKeys = new Set<string>()
    const cfg = settingsRef.current

    for (const [serverId, list] of Object.entries(serverCallRosters)) {
      const server = joinedServersRef.current.find((s) => s.id === serverId)
      for (const member of list) {
        const key = `${serverId}:${member.roomId}:${member.pubkey}`
        nextKeys.add(key)

        const memberPk = member.pubkey.toLowerCase()
        if (!rosterBootedRef.current) continue
        if (seenRosterKeysRef.current.has(key)) continue
        if (ownPubkeysRef.current.has(memberPk) || blockedSetRef.current.has(memberPk)) continue
        if (strictWhitelistRef.current && !trustedSetRef.current.has(memberPk)) continue
        if (activeCallServerId === serverId) continue
        if (!cfg.serverCalls) continue
        if (!rememberNotified(`srvcall:${key}:${Math.floor(Date.now() / 60_000)}`)) {
          continue
        }

        if (cfg.soundEnabled) {
          soundEngine.playNotificationChime('call', {
            vibrate: cfg.vibrationEnabled,
          })
        }

        if (canSendOsNotification()) {
          const srvName = server?.name || 'Group'
          void showOsNotification({
            title: cfg.showPreviews
              ? `${srvName} · Voice Lounge`
              : 'Group Call Active',
            body: cfg.showPreviews
              ? `${member.displayHandle} started a ${member.hasVideo ? 'video' : 'voice'} call`
              : 'A group call started in one of your groups',
            tag: `agnostr-srvcall-${serverId.slice(0, 12)}`,
            requireInteraction: true,
            vibrate: cfg.vibrationEnabled ? [180, 90, 180] : undefined,
            actions: [
              { action: 'open', title: 'Accept' },
              { action: 'decline', title: 'Decline' },
            ],
            data: {
              category: 'server-call',
              serverId,
              channelId: server?.lastActiveChannelId || server?.channels[0]?.id,
            },
            onDirectClick: handleDirectNotificationClick,
          })
        }
      }
    }

    seenRosterKeysRef.current = nextKeys
  }, [
    serverCallRosters,
    activeCallServerId,
    canSendOsNotification,
    handleDirectNotificationClick,
    rememberNotified,
  ])

  // 5b. Live Bitchat Group Call Joins across active & pinned Bitchat rooms
  useEffect(() => {
    const nextKeys = new Set<string>()
    const cfg = settingsRef.current

    for (const [gh, list] of Object.entries(geoCallRosters)) {
      for (const member of list) {
        const memberPk = member.pubkey.toLowerCase()
        const key = `${gh}:${member.roomId}:${memberPk}`
        nextKeys.add(key)

        if (!rosterBootedRef.current) continue
        if (seenGeoRosterKeysRef.current.has(key)) continue
        if (
          ownPubkeysRef.current.has(memberPk) ||
          ownGeoCallPubkeysRef.current.has(memberPk) ||
          blockedSetRef.current.has(memberPk)
        ) {
          continue
        }
        if (strictWhitelistRef.current && !trustedSetRef.current.has(memberPk)) continue
        if (activeCallGeohash === gh) continue
        if (!cfg.serverCalls) continue
        if (!rememberNotified(`geocall:${key}:${Math.floor(Date.now() / 60_000)}`)) {
          continue
        }

        const view = activeViewRef.current
        const isViewingGeoRoom = view.type === 'channel' && view.geohash === gh
        const docActive = isDocumentFocusedAndVisible()
        if (docActive && isViewingGeoRoom) continue

        if (cfg.soundEnabled) {
          soundEngine.playNotificationChime('call', {
            vibrate: cfg.vibrationEnabled,
          })
        }

        if (canSendOsNotification()) {
          const channelLabel = formatBitchatChannelLabel(gh)
          const isTopic = isTopicChannel(gh)
          void showOsNotification({
            title: cfg.showPreviews
              ? `${channelLabel} · ${isTopic ? 'Topic Bitchat Call' : 'Bitchat Call'}`
              : isTopic
                ? 'Topic Bitchat Call Active'
                : 'Bitchat Call Active',
            body: cfg.showPreviews
              ? `${member.displayHandle} started a ${member.hasVideo ? 'video' : 'voice'} call`
              : 'A group call started in one of your Bitchat channels',
            tag: `agnostr-geocall-${gh}`,
            requireInteraction: true,
            vibrate: cfg.vibrationEnabled ? [180, 90, 180] : undefined,
            actions: [
              { action: 'open', title: 'Accept' },
              { action: 'decline', title: 'Decline' },
            ],
            data: {
              category: 'geo-call',
              geohash: gh,
              mediaType: member.hasVideo ? 'video' : 'audio',
            },
            onDirectClick: handleDirectNotificationClick,
          })
        }
      }
    }

    seenGeoRosterKeysRef.current = nextKeys
  }, [
    geoCallRosters,
    activeCallGeohash,
    canSendOsNotification,
    handleDirectNotificationClick,
    rememberNotified,
  ])

  // 6. Live Bitchat Messages & /drop Location Notes (invoked directly from live relay callbacks in useAgnostrEngine)
  const notifyGeoMessage = useCallback(
    (input: NotifyGeoMessageInput) => {
      if (input.senderPubkey) {
        const pk = input.senderPubkey.toLowerCase()
        if (blockedSetRef.current.has(pk)) return
        if (
          strictWhitelistRef.current &&
          !ownPubkeysRef.current.has(pk) &&
          !trustedSetRef.current.has(pk)
        ) {
          return
        }
      }
      const cfg = settingsRef.current
      const isDirectPing = Boolean(input.mentionedMe || input.repliedToMe)
      const allowByDirectPing = isDirectPing && cfg.directPings
      const allowByChannelFilter =
        cfg.geoMessages === 'all' ||
        (cfg.geoMessages === 'mentions' && isDirectPing)

      if (!allowByDirectPing && !allowByChannelFilter) return
      if (!rememberNotified(`geo:${input.id}`)) return

      const view = activeViewRef.current
      const isViewingRoom =
        view.type === 'channel' && view.geohash === input.geohash
      const docActive = isDocumentFocusedAndVisible()
      if (docActive && isViewingRoom) return

      if (cfg.soundEnabled) {
        soundEngine.playNotificationChime(
          isDirectPing ? 'mention' : 'message',
          { vibrate: cfg.vibrationEnabled }
        )
      }

      if (canSendOsNotification()) {
        const preview = input.hasImage
          ? input.content.trim()
            ? `Photo · ${truncatePreview(input.content)}`
            : 'Shared a photo'
          : input.hasVoice
            ? 'Sent a voice memo'
            : truncatePreview(input.content)

        const channelLabel = formatBitchatChannelLabel(input.geohash)
        const isTopic = isTopicChannel(input.geohash)
        const title = cfg.showPreviews
          ? input.repliedToMe
            ? `${input.senderHandle} replied to you in ${channelLabel}`
            : input.mentionedMe
              ? `${input.senderHandle} mentioned you in ${channelLabel}`
              : channelLabel
          : isDirectPing
            ? 'New Direct Ping'
            : isTopic
              ? 'Topic Bitchat Activity'
              : 'Bitchat Activity'

        const body = cfg.showPreviews
          ? isDirectPing
            ? preview
            : `${input.senderHandle}: ${preview}`
          : isTopic
            ? 'New message in Topic Bitchat'
            : 'New message in Bitchat'

        void showOsNotification({
          title,
          body,
          tag: `agnostr-geo-${input.geohash}`,
          vibrate: cfg.vibrationEnabled ? [120] : undefined,
          data: {
            category: 'geo-message',
            deliveryEventId: normalizePushIdentifier(input.id),
            recipientPubkey: normalizePushIdentifier(masterPubkeyRef.current),
            geohash: input.geohash,
          },
          onDirectClick: handleDirectNotificationClick,
        })
      }
    },
    [canSendOsNotification, handleDirectNotificationClick, rememberNotified]
  )

  const notifyLocationNote = useCallback(
    (input: NotifyLocationNoteInput) => {
      if (input.senderPubkey) {
        const pk = input.senderPubkey.toLowerCase()
        if (blockedSetRef.current.has(pk)) return
        if (
          strictWhitelistRef.current &&
          !ownPubkeysRef.current.has(pk) &&
          !trustedSetRef.current.has(pk)
        ) {
          return
        }
      }
      const cfg = settingsRef.current
      if (cfg.geoMessages !== 'all') return
      if (!rememberNotified(`note:${input.id}`)) return

      const view = activeViewRef.current
      const isViewingRoom =
        view.type === 'channel' && view.geohash === input.geohash
      const docActive = isDocumentFocusedAndVisible()
      if (docActive && isViewingRoom) return

      if (cfg.soundEnabled) {
        soundEngine.playNotificationChime('message', {
          vibrate: cfg.vibrationEnabled,
        })
      }

      if (canSendOsNotification()) {
        void showOsNotification({
          title: cfg.showPreviews
            ? `Dead-drop note in #${input.geohash}`
            : 'New Location Note',
          body: cfg.showPreviews
            ? `${input.senderHandle}: ${truncatePreview(input.content)}`
            : 'A 24h location note was pinned nearby',
          tag: `agnostr-note-${input.geohash}`,
          vibrate: cfg.vibrationEnabled ? [110] : undefined,
          data: {
            category: 'location-note',
            deliveryEventId: normalizePushIdentifier(input.id),
            recipientPubkey: normalizePushIdentifier(masterPubkeyRef.current),
            geohash: input.geohash,
          },
          onDirectClick: handleDirectNotificationClick,
        })
      }
    },
    [canSendOsNotification, handleDirectNotificationClick, rememberNotified]
  )

  const notifyAmail = useCallback(
    (input: NotifyAmailInput): boolean => {
      const pk = input.senderPubkey.toLowerCase()
      if (blockedSetRef.current.has(pk)) return false
      if (
        strictWhitelistRef.current &&
        !ownPubkeysRef.current.has(pk) &&
        !trustedSetRef.current.has(pk)
      ) {
        return false
      }

      const cfg = settingsRef.current
      const allowed = input.recipientRole === 'to' ? cfg.agmail : cfg.agmailCcBcc
      if (!allowed) return false
      if (!rememberNotified(`amail:${input.id}`)) return false

      if (cfg.soundEnabled) {
        soundEngine.playNotificationChime('dm', {
          vibrate: cfg.vibrationEnabled,
        })
      }

      if (canSendOsNotification()) {
        const title = cfg.showPreviews
          ? input.recipientRole === 'cc'
            ? `New Agmail (CC) from ${input.senderName}`
            : input.recipientRole === 'bcc'
              ? `New Agmail (BCC) from ${input.senderName}`
              : `New Agmail from ${input.senderName}`
          : input.recipientRole === 'to'
            ? 'New Agmail'
            : 'New Agmail (CC/BCC)'

        const body = cfg.showPreviews
          ? truncatePreview(input.subject || 'New encrypted Agmail')
          : 'Open Agnostr to read your encrypted message.'

        void showOsNotification({
          title,
          body,
          tag: `agnostr-mail-${input.id.slice(0, 12)}`,
          vibrate: cfg.vibrationEnabled ? [140, 80, 140] : undefined,
          data: {
            category: 'agmail',
            deliveryEventId: normalizePushIdentifier(input.id),
            recipientPubkey: normalizePushIdentifier(masterPubkeyRef.current),
            peerPubkey: input.senderPubkey,
          },
          onDirectClick: handleDirectNotificationClick,
        })
      }

      return true
    },
    [canSendOsNotification, handleDirectNotificationClick, rememberNotified]
  )

  const notifyAgora = useCallback(
    (input: NotifyAgoraInput): void => {
      const cfg = settingsRef.current
      if (!cfg.enabled) return
      const actor = input.actorPubkey.trim().toLowerCase()
      if (!actor) return
      if (blockedSetRef.current.has(actor) || ownPubkeysRef.current.has(actor)) return

      let category: NotificationCategory
      let allowed = false
      switch (input.kind) {
        case 'reply':
          category = 'agora-reply'
          allowed = cfg.agoraRepliesMentions
          break
        case 'mention':
        case 'quote':
          category = 'agora-mention'
          allowed = cfg.agoraRepliesMentions
          break
        case 'like':
          category = 'agora-like'
          allowed = cfg.agoraReactionsReposts
          break
        case 'repost':
          category = 'agora-repost'
          allowed = cfg.agoraReactionsReposts
          break
        case 'zap':
          category = 'agora-zap'
          allowed = cfg.agoraZaps
          break
        case 'follow':
          category = 'agora-follow'
          allowed = cfg.agoraFollows
          break
      }
      if (!allowed) return
      if (!rememberNotified(`agora:${input.id}`)) return

      const inAgoraFocused =
        isDocumentFocusedAndVisible() &&
        typeof document !== 'undefined' &&
        document.title.includes('Agora — Agnostr')
      if (inAgoraFocused) return

      if (cfg.soundEnabled) {
        const chimeKind =
          input.kind === 'reply' ||
          input.kind === 'mention' ||
          input.kind === 'quote' ||
          input.kind === 'zap'
            ? 'mention'
            : 'message'
        soundEngine.playNotificationChime(chimeKind, {
          vibrate: cfg.vibrationEnabled,
        })
      }

      if (!canSendOsNotification()) return

      const actorLabel = input.actorName.trim() || `anon${actor.slice(-4)}`
      const preview = input.preview ? truncatePreview(input.preview) : ''
      const satsLabel =
        typeof input.sats === 'number' && Number.isFinite(input.sats) && input.sats > 0
          ? `${Math.round(input.sats).toLocaleString()} sats`
          : ''

      let title = 'Agora'
      let body = 'New activity on Agora'
      if (cfg.showPreviews) {
        switch (input.kind) {
          case 'reply':
            title = `${actorLabel} replied on Agora`
            body = preview || 'Replied to your post on Agora'
            break
          case 'mention':
            title = `${actorLabel} mentioned you on Agora`
            body = preview || 'Mentioned you in a post on Agora'
            break
          case 'quote':
            title = `${actorLabel} quoted your post on Agora`
            body = preview || 'Quoted your post on Agora'
            break
          case 'like':
            title = `${actorLabel} liked your post`
            body = preview || 'Tap to view post on Agora'
            break
          case 'repost':
            title = `${actorLabel} reposted your note`
            body = preview || 'Tap to view post on Agora'
            break
          case 'zap':
            title = satsLabel
              ? `${actorLabel} zapped you ${satsLabel}`
              : `${actorLabel} zapped you on Agora`
            body = preview || 'Tap to view on Agora'
            break
          case 'follow':
            title = `${actorLabel} followed you on Agora`
            body = 'Tap to view profile on Agora'
            break
        }
      } else {
        switch (input.kind) {
          case 'reply':
            title = 'New reply on Agora'
            break
          case 'mention':
          case 'quote':
            title = 'New mention on Agora'
            break
          case 'like':
            title = 'New like on Agora'
            break
          case 'repost':
            title = 'New repost on Agora'
            break
          case 'zap':
            title = 'New Zap on Agora'
            break
          case 'follow':
            title = 'New follower on Agora'
            break
        }
      }

      const cleanNoteId =
        input.noteId && /^[0-9a-f]{64}$/i.test(input.noteId.trim())
          ? input.noteId.trim().toLowerCase()
          : undefined
      const tagSeed = cleanNoteId ? cleanNoteId.slice(0, 12) : actor.slice(0, 12)

      void showOsNotification({
        title,
        body,
        tag: `agnostr-${category}-${tagSeed}`,
        vibrate: cfg.vibrationEnabled ? [120, 70, 120] : undefined,
        data: {
          category,
          deliveryEventId: normalizePushIdentifier(input.id),
          noteId: cleanNoteId,
          peerPubkey: actor,
          recipientPubkey: masterPubkeyRef.current
            ? masterPubkeyRef.current.toLowerCase()
            : undefined,
        },
        onDirectClick: handleDirectNotificationClick,
      })
    },
    [canSendOsNotification, handleDirectNotificationClick, rememberNotified]
  )

  const publicPinnedRoomFallbackAvailable = canUsePublicPinnedRoomFallback({
    canAutoSign,
    geoMessages: settings.geoMessages,
    hasBlockedPeers: blockedSet.size > 0,
    strictWhitelistMode,
    pinnedGeohashes,
  })
  const publicPinnedRoomFallback = settings.publicPinnedRoomFallback && publicPinnedRoomFallbackAvailable
  const publicPinnedRoomFallbackRef = useRef(publicPinnedRoomFallback)
  publicPinnedRoomFallbackRef.current = publicPinnedRoomFallback

  const registerBridgeInternal = useCallback(
    async (opts: {
      bridgeUrlOverride?: string
      vapidKeyOverride?: string
      silent?: boolean
      promptPermission?: boolean
      syncFingerprint?: string
      isFinalAutoRetry?: boolean
      replaceSubscription?: boolean
    }): Promise<boolean> => {
      if (!isWebPushSupported()) {
        setPushStatus('unsupported')
        pushStatusRef.current = 'unsupported'
        if (!opts.silent) {
          const msg = 'Web Push (PushManager) is unavailable in this browser.'
          setPushError(msg)
          pushErrorRef.current = msg
        }
        return false
      }

      const rawUrl =
        opts.bridgeUrlOverride !== undefined
          ? opts.bridgeUrlOverride
          : settingsRef.current.pushBridgeUrl
      const normalizedUrl = normalizePushBridgeUrl(rawUrl)
      if (!normalizedUrl) {
        if (!opts.silent) {
          const msg =
            'Enter a valid https:// push bridge URL (or http://localhost for local dev).'
          setPushStatus('error')
          pushStatusRef.current = 'error'
          setPushError(msg)
          pushErrorRef.current = msg
          pushToastRef.current('warning', 'Invalid push bridge URL', msg)
        }
        return false
      }

      let perm = permissionRef.current
      if (perm !== 'granted' && opts.promptPermission) {
        perm = await requestBrowserNotificationPermission()
        permissionRef.current = perm
        setPermission(perm)
        if (perm === 'granted') {
          updateSettings({ enabled: true })
        } else if (perm === 'denied') {
          updateSettings({ enabled: false })
        }
      }
      if (perm !== 'granted') {
        if (!opts.silent) {
          const msg = 'Notification permission must be granted first.'
          setPushStatus('error')
          pushStatusRef.current = 'error'
          setPushError(msg)
          pushErrorRef.current = msg
        }
        return false
      }

      const startEpoch = pushRegistrationEpochRef.current
      const pubkey = masterPubkeyRef.current
      const signEvent = signEventRef.current
      const requestedFingerprint = opts.syncFingerprint || prefsFingerprintRef.current
      const key = JSON.stringify([pubkey, normalizedUrl, opts.vapidKeyOverride || '', !!opts.replaceSubscription])
      while (pushRegisterInFlightRef.current) {
        const running = pushRegisterInFlightRef.current
        if (running.key === key || (opts.silent && !opts.bridgeUrlOverride)) {
          return running.operation
        }
        // An explicit Connect to a different bridge or key must not be
        // mistaken for the success of an automatic registration elsewhere.
        await running.operation
        if (startEpoch !== pushRegistrationEpochRef.current ||
            pubkey !== masterPubkeyRef.current) return false
      }
      const remainsCurrent = () =>
        startEpoch === pushRegistrationEpochRef.current && pubkey === masterPubkeyRef.current
      const operation = (async (): Promise<boolean> => {
        if (!opts.silent) {
          setPushStatus('connecting')
          pushStatusRef.current = 'connecting'
          setPushError(null)
          pushErrorRef.current = null
        }

        try {
          const manualKey =
            opts.vapidKeyOverride !== undefined
              ? opts.vapidKeyOverride.trim()
              : normalizedUrl === DEFAULT_PUSH_BRIDGE_URL
                ? ''
                : settingsRef.current.vapidPublicKey.trim()
          const result = await registerWithPushBridge({
            bridgeUrl: normalizedUrl,
            vapidPublicKey: manualKey || undefined,
            pubkey,
            aliasPubkeys: aliasPubkeysRef.current,
            relays: relayUrlsRef.current,
            geohashes: pinnedGeohashesRef.current,
            serverIds: joinedServersRef.current.map((s) => s.id),
            settings: settingsRef.current,
            publicPinnedRoomFallback: publicPinnedRoomFallbackRef.current,
            replaceSubscription: opts.replaceSubscription,
            signEvent: (tmpl) => {
              if (!remainsCurrent()) return Promise.reject(new Error('Push account changed.'))
              return signEvent(tmpl)
            },
          })

          if (!remainsCurrent()) return false
          lastPushRegistrationAtRef.current = Date.now()
          const cur = settingsRef.current
          if (
            !cur.enabled ||
            !cur.backgroundPushEnabled ||
            cur.pushBridgeUrl !== normalizedUrl ||
            cur.vapidPublicKey !== result.vapidPublicKey
          ) {
            updateSettings({
              enabled: true,
              backgroundPushEnabled: true,
              pushBridgeUrl: normalizedUrl,
              vapidPublicKey: result.vapidPublicKey,
            })
          }
          autoRetryAttemptRef.current = 0
          if (autoRetryTimerRef.current !== null) {
            window.clearTimeout(autoRetryTimerRef.current)
            autoRetryTimerRef.current = null
          }
          setPushEndpoint(result.endpoint)
          pushEndpointRef.current = result.endpoint
          setPushStatus('connected')
          pushStatusRef.current = 'connected'
          setPushError(null)
          pushErrorRef.current = null
          // Pin the preferences actually sent to the bridge, not the newest
          // render after this async registration. Normalize a discovered key
          // so updating it in settings doesn't immediately resync.
          lastSyncedPushFingerprintRef.current = requestedFingerprint
            ? JSON.stringify({
                ...JSON.parse(requestedFingerprint),
                url: normalizedUrl,
                key: result.vapidPublicKey,
              })
            : result.endpoint
          if (!opts.silent) {
            pushToastRef.current(
              'success',
              'Background Web Push connected',
              'Your device is registered to wake on closed-app notifications and DM calls.'
            )
          }
          return true
        } catch (err) {
          if (!remainsCurrent()) return false
          const msg =
            err instanceof Error
              ? err.message
              : 'Unable to register with push bridge.'
          // Always record diagnostic error and NEVER cache syncFingerprint on failure so retries run cleanly
          setPushError(msg)
          pushErrorRef.current = msg
          if (opts.silent) {
            if (opts.isFinalAutoRetry) {
              setPushStatus('error')
              pushStatusRef.current = 'error'
            } else if (pushStatusRef.current !== 'connected') {
              setPushStatus('disconnected')
              pushStatusRef.current = 'disconnected'
            }
          } else {
            setPushStatus('error')
            pushStatusRef.current = 'error'
            pushToastRef.current('error', 'Push bridge connection failed', msg)
          }
          return false
        }
      })()
      const running = { key, operation }
      pushRegisterInFlightRef.current = running
      try {
        return await operation
      } finally {
        if (pushRegisterInFlightRef.current === running) pushRegisterInFlightRef.current = null
      }
    },
    [updateSettings]
  )

  // User-gesture actions
  const requestPermission =
    useCallback(async (): Promise<NotificationPermissionState> => {
      const result = await requestBrowserNotificationPermission()
      permissionRef.current = result
      setPermission(result)

      if (result === 'granted') {
        updateSettings({ enabled: true })
        pushToastRef.current(
          'success',
          'Notifications enabled',
          'You will receive live alerts and incoming DM call ringing.'
        )
        if (
          isWebPushSupported() &&
          settingsRef.current.backgroundPushEnabled &&
          normalizePushBridgeUrl(settingsRef.current.pushBridgeUrl)
        ) {
          void registerBridgeInternal({
            silent: true,
            promptPermission: false,
            vapidKeyOverride: settingsRef.current.vapidPublicKey || undefined,
            syncFingerprint: prefsFingerprintRef.current || undefined,
          })
        }
      } else if (result === 'denied') {
        setSettings((prev) => {
          const updated: NotificationSettings = { ...prev, enabled: false }
          settingsRef.current = updated
          saveNotificationSettings(updated)
          return updated
        })
        pushToastRef.current(
          'warning',
          'Notifications blocked',
          'Allow notifications for Agnostr in your browser or OS site settings.'
        )
      } else if (result === 'unsupported') {
        pushToastRef.current(
          'warning',
          'Notifications unavailable',
          isIosSafariNonStandalone()
            ? 'Add Agnostr to your Home Screen via Share → Add to Home Screen first.'
            : 'This browser does not support Web Notifications.'
        )
      }
      return result
    }, [registerBridgeInternal, updateSettings])

  const sendTestNotification = useCallback(async (): Promise<boolean> => {
    let perm = permissionRef.current
    if (perm === 'default') {
      perm = await requestPermission()
    }
    if (perm !== 'granted') return false

    if (settingsRef.current.soundEnabled) {
      soundEngine.playTestChime(settingsRef.current.vibrationEnabled)
    }

    const ok = await showOsNotification({
      title: 'Agnostr Notifications Ready',
      body: 'Live alerts for DMs, calls, groups, and Bitchat are active.',
      tag: 'agnostr-test',
      vibrate: settingsRef.current.vibrationEnabled ? [140, 80, 140] : undefined,
      data: { category: 'test' },
      onDirectClick: handleDirectNotificationClick,
    })

    if (ok) {
      pushToastRef.current('success', 'Test notification sent')
    } else {
      pushToastRef.current(
        'warning',
        'Could not show OS notification',
        'Check system Do Not Disturb or browser notification permissions.'
      )
    }
    return ok
  }, [requestPermission, handleDirectNotificationClick])

  const testRingtone = useCallback(() => {
    soundEngine.playTestRingtone(settingsRef.current.vibrationEnabled)
  }, [])

  const muteCurrentRing = useCallback(() => {
    soundEngine.muteCurrentRing()
    setIsRingMuted(true)
  }, [])

  const consumePendingAction = useCallback(() => {
    setPendingAction(null)
  }, [])

  // Background Web Push Bridge (auto-configured to Agnostr built-in worker, optional custom override)
  const connectPushBridge = useCallback(
    async (
      bridgeUrlOverride?: string,
      vapidKeyOverride?: string
    ): Promise<boolean> => {
      return registerBridgeInternal({
        bridgeUrlOverride,
        vapidKeyOverride,
        silent: false,
        promptPermission: true,
      })
    },
    [registerBridgeInternal]
  )

  const disconnectPushBridge = useCallback(async (opts?: {
    keepAutomaticRegistration?: boolean
  }): Promise<void> => {
    if (!opts?.keepAutomaticRegistration) updateSettings({ backgroundPushEnabled: false })
    const pubkey = masterPubkeyRef.current
    const bridgeUrl = settingsRef.current.pushBridgeUrl
    const signEvent = signEventRef.current
    await pushRegisterInFlightRef.current?.operation
    if (pubkey !== masterPubkeyRef.current) return
    try {
      await unregisterFromPushBridge({
        bridgeUrl,
        pubkey,
        signEvent,
        // Turning alerts off must never get stuck waiting on an interactive
        // signer. Once the local endpoint is invalid it cannot receive pushes.
        skipBridgeCleanup: opts?.keepAutomaticRegistration && !canAutoSignRef.current,
      })
    } finally {
      if (pubkey === masterPubkeyRef.current) {
        lastSyncedPushFingerprintRef.current = null
        setPushEndpoint(null)
        pushEndpointRef.current = null
        const nextStatus = isWebPushSupported() ? 'disconnected' : 'unsupported'
        setPushStatus(nextStatus)
        pushStatusRef.current = nextStatus
        setPushError(null)
        pushErrorRef.current = null
        if (!opts?.keepAutomaticRegistration) {
          pushToastRef.current('info', 'Background Web Push disconnected')
        } else if (settingsRef.current.enabled && canAutoSignRef.current) {
          // A user may turn alerts back on while the old endpoint is disabling.
          setAutoSyncTick(t => t + 1)
        }
      }
    }
  }, [updateSettings])

  const sendTestPush = useCallback(async (): Promise<{ ok: boolean; detail: string }> => {
    if (!isWebPushSupported()) {
      const detail = 'Background Web Push is unavailable in this browser.'
      pushToastRef.current('warning', 'Push unavailable', detail)
      return { ok: false, detail }
    }

    let perm = permissionRef.current
    if (perm === 'default') {
      perm = await requestPermission()
    }
    if (perm !== 'granted') {
      const detail = 'Enable browser notifications first.'
      return { ok: false, detail }
    }

    const pubkey = masterPubkeyRef.current
    const signEvent = signEventRef.current
    const sign = (template: EventTemplate) => {
      if (pubkey !== masterPubkeyRef.current) return Promise.reject(new Error('Push account changed.'))
      return signEvent(template)
    }
    const bridgeUrl =
      normalizePushBridgeUrl(settingsRef.current.pushBridgeUrl) || DEFAULT_PUSH_BRIDGE_URL
    const vapidKey =
      bridgeUrl === DEFAULT_PUSH_BRIDGE_URL ? '' : settingsRef.current.vapidPublicKey.trim()

    if (
      !lastSyncedPushFingerprintRef.current ||
      pushStatusRef.current !== 'connected' ||
      !pushEndpointRef.current ||
      (await readCurrentPushEndpoint().catch(() => null)) !== pushEndpointRef.current
    ) {
      const connected = await registerBridgeInternal({
        bridgeUrlOverride: bridgeUrl,
        vapidKeyOverride: vapidKey || undefined,
        silent: false,
        promptPermission: false,
        syncFingerprint: prefsFingerprintRef.current || undefined,
      })
      if (!connected) {
        return {
          ok: false,
          detail: pushErrorRef.current || 'Could not connect to push bridge.',
        }
      }
    }

    let res = await sendTestWebPush({
      bridgeUrl,
      pubkey,
      signEvent: sign,
    })

    // A missing bridge record can be repaired without changing the browser
    // endpoint. HTTP 410 means the provider invalidated that endpoint itself.
    if (!res.ok && pubkey === masterPubkeyRef.current && (res.status === 404 || res.status === 410)) {
      lastSyncedPushFingerprintRef.current = null
      const reconnected = await registerBridgeInternal({
        bridgeUrlOverride: bridgeUrl,
        vapidKeyOverride: vapidKey || undefined,
        silent: true,
        replaceSubscription: res.status === 410,
        promptPermission: false,
        syncFingerprint: prefsFingerprintRef.current || undefined,
      })
      if (reconnected) {
        res = await sendTestWebPush({
          bridgeUrl,
          pubkey,
          signEvent: sign,
        })
      }
    }

    if (res.ok) {
      pushToastRef.current('success', 'Test push displayed on this device', res.detail)
    } else {
      pushToastRef.current('warning', 'Test background push failed', res.detail)
    }
    return { ok: res.ok, detail: res.detail }
  }, [registerBridgeInternal, requestPermission])

  const pokeRecipients = useCallback((payload: PushPokePayload): void => {
    const permitted = () => canAutoSignRef.current || settingsRef.current.extensionPushPokes
    if (!permitted()) return
    const bridgeUrl = normalizePushBridgeUrl(settingsRef.current.pushBridgeUrl)
    if (!bridgeUrl) return

    const recipients = Array.from(
      new Set(
        payload.recipientPubkeys
          .map((pk) => pk.trim().toLowerCase())
          .filter((pk) => /^[0-9a-f]{64}$/.test(pk) && !ownPubkeysRef.current.has(pk))
      )
    )
    if (recipients.length === 0) return

    const pubkey = masterPubkeyRef.current
    const signEvent = signEventRef.current
    const shouldContinue = () =>
      permitted() && masterPubkeyRef.current === pubkey &&
      normalizePushBridgeUrl(settingsRef.current.pushBridgeUrl) === bridgeUrl
    void sendPushPoke({
      bridgeUrl,
      signEvent,
      shouldContinue,
      payload: {
        ...payload,
        recipientPubkeys: recipients,
      },
    }).then((result) => {
      if (result.kind !== 'failed' || !shouldContinue() ||
          Date.now() - lastPokeErrorAtRef.current < 60_000) return
      lastPokeErrorAtRef.current = Date.now()
      pushToastRef.current('warning', 'Could not notify the recipient’s device',
        'Your message was sent to Nostr. Its background push request did not complete.')
    })
  }, [])

  // Debounced startup & preference-sync auto-registration for local-key PWAs (with backoff retries)
  const prefsFingerprint = useMemo(() => {
    const bridgeUrl = normalizePushBridgeUrl(settings.pushBridgeUrl)
    if (!bridgeUrl || !masterPubkey) return ''
    return JSON.stringify({
      url: bridgeUrl,
      key: settings.vapidPublicKey.trim(),
      pk: masterPubkey.toLowerCase(),
      aliases: normalizedAliasPubkeys,
      dms: settings.dms,
      agmail: settings.agmail,
      agmailCcBcc: settings.agmailCcBcc,
      directPings: settings.directPings,
      dmCallRinging: settings.dmCallRinging,
      serverMessages: settings.serverMessages,
      serverCalls: settings.serverCalls,
      geoMessages: settings.geoMessages,
      publicPinnedRoomFallback,
      agoraRepliesMentions: settings.agoraRepliesMentions,
      agoraReactionsReposts: settings.agoraReactionsReposts,
      agoraZaps: settings.agoraZaps,
      agoraFollows: settings.agoraFollows,
      showPreviews: settings.showPreviews,
      relays: [...relayUrls].slice(0, 12).sort(),
      geohashes: [...pinnedGeohashes].sort(),
      servers: joinedServers.map((s) => s.id).sort(),
    })
  }, [
    joinedServers,
    masterPubkey,
    normalizedAliasPubkeys,
    pinnedGeohashes,
    publicPinnedRoomFallback,
    relayUrls,
    settings.agmail,
    settings.agmailCcBcc,
    settings.agoraFollows,
    settings.agoraReactionsReposts,
    settings.agoraRepliesMentions,
    settings.agoraZaps,
    settings.directPings,
    settings.dmCallRinging,
    settings.dms,
    settings.geoMessages,
    settings.pushBridgeUrl,
    settings.serverCalls,
    settings.serverMessages,
    settings.showPreviews,
    settings.vapidPublicKey,
  ])
  prefsFingerprintRef.current = prefsFingerprint

  useEffect(() => {
    if (!canAutoSign && pushStatus === 'connected' &&
        lastSyncedPushFingerprintRef.current !== prefsFingerprint) {
      // An interactive signer must not be prompted in the background, and
      // settings changes have not reached the bridge until they are signed.
      const msg = 'Reconnect this device in Settings to apply push settings with your signer.'
      setPushStatus('disconnected')
      pushStatusRef.current = 'disconnected'
      setPushError(msg)
      pushErrorRef.current = msg
    }
  }, [canAutoSign, prefsFingerprint, pushStatus])

  useEffect(() => {
    autoRetryAttemptRef.current = 0
    if (autoRetryTimerRef.current !== null) {
      window.clearTimeout(autoRetryTimerRef.current)
      autoRetryTimerRef.current = null
    }
  }, [prefsFingerprint])

  useEffect(() => {
    if (
      permission !== 'granted' ||
      !settings.enabled ||
      !settings.backgroundPushEnabled ||
      !isPushSupported ||
      !canAutoSign ||
      !prefsFingerprint
    ) {
      return
    }
    if (lastSyncedPushFingerprintRef.current === prefsFingerprint) {
      return
    }

    let cancelled = false
    const delayMs = autoSyncTick > 0 ? 400 : 2500
    const timer = window.setTimeout(() => {
      if (cancelled || lastSyncedPushFingerprintRef.current === prefsFingerprint) return
      const currentAttempt = autoRetryAttemptRef.current
      const isFinalAutoRetry = currentAttempt >= AUTO_PUSH_RETRY_DELAYS_MS.length
      void registerBridgeInternal({
        silent: true,
        promptPermission: false,
        syncFingerprint: prefsFingerprint,
        isFinalAutoRetry,
      }).then((ok) => {
        if (cancelled || ok) return
        if (lastSyncedPushFingerprintRef.current === prefsFingerprint) return
        if (currentAttempt < AUTO_PUSH_RETRY_DELAYS_MS.length) {
          autoRetryAttemptRef.current = currentAttempt + 1
          const retryWaitMs = AUTO_PUSH_RETRY_DELAYS_MS[currentAttempt]
          if (autoRetryTimerRef.current !== null) {
            window.clearTimeout(autoRetryTimerRef.current)
          }
          autoRetryTimerRef.current = window.setTimeout(() => {
            autoRetryTimerRef.current = null
            setAutoSyncTick((t) => t + 1)
          }, retryWaitMs)
        }
      })
    }, delayMs)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    autoSyncTick,
    canAutoSign,
    isPushSupported,
    permission,
    prefsFingerprint,
    registerBridgeInternal,
    settings.enabled,
    settings.backgroundPushEnabled,
  ])

  // Reconcile the actual current browser subscription; a cached HTTP 200
  // never proves the old endpoint still exists after an OS/browser reset.
  useEffect(() => {
    if (!isPushSupported) return
    let cancelled = false
    const recover = async (forceBrowserCheck = false) => {
      if (permissionRef.current !== 'granted' || !settingsRef.current.enabled ||
          !settingsRef.current.backgroundPushEnabled || !prefsFingerprintRef.current ||
          pushRegisterInFlightRef.current) return
      const fingerprint = prefsFingerprintRef.current
      const epoch = pushRegistrationEpochRef.current
      const endpoint = await readCurrentPushEndpoint().catch(() => undefined)
      if (cancelled || epoch !== pushRegistrationEpochRef.current ||
          fingerprint !== prefsFingerprintRef.current || pushRegisterInFlightRef.current) return
      const changed = endpoint !== undefined && endpoint !== pushEndpointRef.current
      const refreshMs = publicPinnedRoomFallbackRef.current
        ? PUBLIC_ROOM_PUSH_REFRESH_MS : PUSH_REFRESH_MS
      const stale = forceBrowserCheck || changed ||
        Date.now() - lastPushRegistrationAtRef.current >= refreshMs
      if (!stale && lastSyncedPushFingerprintRef.current === fingerprint) return
      if (stale) {
        lastSyncedPushFingerprintRef.current = null
        if (changed) {
          setPushEndpoint(endpoint ?? null)
          pushEndpointRef.current = endpoint ?? null
        }
      }
      if (!canAutoSignRef.current) {
        if (stale && pushStatusRef.current === 'connected') {
          setPushStatus('disconnected')
          pushStatusRef.current = 'disconnected'
          const msg = 'Reconnect this device in Settings to authorize background push with your signer.'
          setPushError(msg)
          pushErrorRef.current = msg
        }
        return
      }
      if (autoRetryTimerRef.current !== null) {
        window.clearTimeout(autoRetryTimerRef.current)
        autoRetryTimerRef.current = null
      }
      autoRetryAttemptRef.current = 0
      setAutoSyncTick((t) => t + 1)
    }

    const onOnline = () => void recover()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void recover()
    }
    const onController = () => void recover()
    const onWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type === 'agnostr:push-subscription-changed') void recover(true)
    }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisibility)
    navigator.serviceWorker.addEventListener('controllerchange', onController)
    navigator.serviceWorker.addEventListener('message', onWorkerMessage)
    const periodic = window.setInterval(onVisibility, PUSH_RECHECK_MS)

    return () => {
      cancelled = true
      window.clearInterval(periodic)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisibility)
      navigator.serviceWorker.removeEventListener('controllerchange', onController)
      navigator.serviceWorker.removeEventListener('message', onWorkerMessage)
      if (autoRetryTimerRef.current !== null) {
        window.clearTimeout(autoRetryTimerRef.current)
        autoRetryTimerRef.current = null
      }
    }
  }, [isPushSupported])

  const resetAllNotifications = useCallback(() => {
    soundEngine.stopAll()
    void closeCallNotificationsViaSw()
    void unregisterFromPushBridge({
      bridgeUrl: settingsRef.current.pushBridgeUrl,
      pubkey: masterPubkeyRef.current,
      signEvent: (tmpl) => signEventRef.current(tmpl),
    })
    activeRingingCallIdRef.current = null
    lastSyncedPushFingerprintRef.current = null
    pushRegistrationEpochRef.current += 1
    autoRetryAttemptRef.current = 0
    explicitlyDisabledRef.current = false
    if (autoRetryTimerRef.current !== null) {
      window.clearTimeout(autoRetryTimerRef.current)
      autoRetryTimerRef.current = null
    }
    notifiedIdsRef.current.clear()
    seenDmIdsRef.current = null
    seenServerMsgIdsRef.current.clear()
    seenRosterKeysRef.current.clear()
    seenGeoRosterKeysRef.current.clear()
    sessionBootSecRef.current = Math.floor(Date.now() / 1000)
    setIsRinging(false)
    setIsRingMuted(false)
    setPendingAction(null)
    setPushEndpoint(null)
    pushEndpointRef.current = null
    setPushError(null)
    pushErrorRef.current = null
    const nextStatus = isWebPushSupported() ? 'disconnected' : 'unsupported'
    setPushStatus(nextStatus)
    pushStatusRef.current = nextStatus
    void closeDmPreviews(() => false)
    settingsRef.current = DEFAULT_NOTIFICATION_SETTINGS
    setSettings(DEFAULT_NOTIFICATION_SETTINGS)
  }, [])

  const isUsingDefaultBridge = useMemo(
    () => normalizePushBridgeUrl(settings.pushBridgeUrl) === DEFAULT_PUSH_BRIDGE_URL,
    [settings.pushBridgeUrl]
  )

  const notifications: NotificationEngine = useMemo(
    () => ({
      permission,
      isSupported,
      isPushSupported,
      usesExternalPushSigner: !canAutoSign,
      publicPinnedRoomFallbackAvailable,
      isIosRequiresInstall,
      settings,
      updateSettings,
      requestPermission,
      sendTestNotification,
      sendTestPush,
      pokeRecipients,
      testRingtone,
      isRinging,
      isRingMuted,
      muteCurrentRing,
      pendingAction,
      consumePendingAction,
      pushStatus,
      pushError,
      pushEndpoint,
      isUsingDefaultBridge,
      connectPushBridge,
      disconnectPushBridge,
    }),
    [
      permission,
      isSupported,
      isPushSupported,
      canAutoSign,
      publicPinnedRoomFallbackAvailable,
      isIosRequiresInstall,
      settings,
      updateSettings,
      requestPermission,
      sendTestNotification,
      sendTestPush,
      pokeRecipients,
      testRingtone,
      isRinging,
      isRingMuted,
      muteCurrentRing,
      pendingAction,
      consumePendingAction,
      pushStatus,
      pushError,
      pushEndpoint,
      isUsingDefaultBridge,
      connectPushBridge,
      disconnectPushBridge,
    ]
  )

  return {
    notifications,
    notifyGeoMessage,
    notifyLocationNote,
    notifyAmail,
    notifyAgora,
    resetAllNotifications,
  }
}
