import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EventTemplate, VerifiedEvent } from 'nostr-tools'
import type { IncomingCallOffer, RoomCallPresence } from '../types/calls.ts'
import type {
  NotificationPayloadData,
  NotificationPermissionState,
  NotificationSettings,
  NotificationEngine,
  PendingNotificationAction,
  PushSubscriptionStatus,
} from '../types/notifications.ts'
import type { ActiveView, DmThread, ToastLevel } from '../types/protocol.ts'
import type { ServerMessage, ServerSummary } from '../types/servers.ts'
import { doesContentMentionUser } from '../lib/bitchatProtocol.ts'
import {
  closeCallNotificationsViaSw,
  getBrowserNotificationPermission,
  isWebPushSupported,
  normalizePushBridgeUrl,
  parseNotifyHash,
  registerWithPushBridge,
  requestBrowserNotificationPermission,
  showOsNotification,
  unregisterFromPushBridge,
} from '../lib/notifications.ts'
import { soundEngine } from '../lib/soundEngine.ts'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  loadNotificationSettings,
  saveNotificationSettings,
} from '../lib/storage.ts'
import {
  getPwaSwRegistration,
  isIosSafariNonStandalone,
  isPwaStandaloneMode,
} from './usePwa.ts'

const MAX_NOTIFIED_IDS = 500
const LIVE_RECENCY_WINDOW_SEC = 20

export interface NotifyGeoMessageInput {
  id: string
  geohash: string
  senderHandle: string
  content: string
  mentionedMe: boolean
  hasVoice?: boolean
  hasImage?: boolean
}

export interface NotifyLocationNoteInput {
  id: string
  geohash: string
  senderHandle: string
  content: string
}

export interface UseNotificationsParams {
  activeView: ActiveView
  activeGeohash: string
  ownPubkeys: Set<string>
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
  relayUrls: string[]
  pinnedGeohashes: string[]
  signEvent: (tmpl: EventTemplate) => Promise<VerifiedEvent>
  pushToast: (level: ToastLevel, title: string, detail?: string) => void
}

export interface UseNotificationsResult {
  notifications: NotificationEngine
  notifyGeoMessage: (input: NotifyGeoMessageInput) => void
  notifyLocationNote: (input: NotifyLocationNoteInput) => void
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
    relayUrls,
    pinnedGeohashes,
    signEvent,
    pushToast,
  } = params

  const [permission, setPermission] = useState<NotificationPermissionState>(() =>
    getBrowserNotificationPermission()
  )
  const [settings, setSettings] = useState<NotificationSettings>(() => {
    const loaded = loadNotificationSettings()
    const perm = getBrowserNotificationPermission()
    if (perm === 'granted' && loaded.enabled) return loaded
    if (perm === 'denied' && loaded.enabled) return { ...loaded, enabled: false }
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
          window.history.replaceState(null, '', `#${activeGeohash}`)
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

  const sessionBootSecRef = useRef<number>(Math.floor(Date.now() / 1000))
  const notifiedIdsRef = useRef<Set<string>>(new Set())
  const seenDmIdsRef = useRef<Set<string> | null>(null)
  const seenServerMsgIdsRef = useRef<Set<string>>(new Set())
  const lastServerChanKeyRef = useRef<string>('')
  const seenRosterKeysRef = useRef<Set<string>>(new Set())
  const rosterBootedRef = useRef<boolean>(false)
  const activeRingingCallIdRef = useRef<string | null>(null)

  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const permissionRef = useRef(permission)
  permissionRef.current = permission
  const activeViewRef = useRef(activeView)
  activeViewRef.current = activeView
  const ownPubkeysRef = useRef(ownPubkeys)
  ownPubkeysRef.current = ownPubkeys
  const masterPubkeyRef = useRef(masterPubkey)
  masterPubkeyRef.current = masterPubkey
  const nicknameRef = useRef(nickname)
  nicknameRef.current = nickname
  const relayUrlsRef = useRef(relayUrls)
  relayUrlsRef.current = relayUrls
  const pinnedGeohashesRef = useRef(pinnedGeohashes)
  pinnedGeohashesRef.current = pinnedGeohashes
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

  const updateSettings = useCallback((patch: Partial<NotificationSettings>) => {
    setSettings((prev) => {
      const next: NotificationSettings = { ...prev, ...patch }
      settingsRef.current = next
      saveNotificationSettings(next)
      return next
    })
  }, [])

  // Sync browser permission on visibility return + detect existing PushManager subscription
  useEffect(() => {
    const syncPermission = () => {
      const next = getBrowserNotificationPermission()
      permissionRef.current = next
      setPermission(next)
      if (next === 'denied' && settingsRef.current.enabled) {
        updateSettings({ enabled: false })
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
            setPushStatus('connected')
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

  // Listen for Service Worker notification click actions + hash deep links
  useEffect(() => {
    const onSwMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string
        action?: unknown
        payload?: NotificationPayloadData
      } | null
      if (!data || data.type !== 'AGNOSTR_NOTIFICATION_ACTION' || !data.payload) {
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
          window.history.replaceState(null, '', `#${activeGeohash}`)
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
      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', onSwMessage)
      }
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [activeGeohash])

  // 1. Incoming 1-on-1 DM Call Ringing (Trusted peers only — strict Trust gate already enforced in useCallEngine)
  useEffect(() => {
    const prevCallId = activeRingingCallIdRef.current

    if (!incomingCall) {
      if (prevCallId) {
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
            { action: 'answer', title: 'Answer' },
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
      for (const msg of thread.messages) {
        if (seen.has(msg.id)) continue
        seen.add(msg.id)

        if (msg.isOwn || ownPubkeysRef.current.has(msg.senderPubkey.toLowerCase())) {
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
            title: cfg.showPreviews
              ? `DM from ${thread.peerDisplayHandle}`
              : 'New Encrypted DM',
            body: cfg.showPreviews
              ? previewText
              : 'New encrypted direct message on Agnostr',
            tag: `agnostr-dm-${thread.peerPubkey.slice(0, 12)}`,
            vibrate: cfg.vibrationEnabled ? [140, 80, 140] : undefined,
            data: {
              category: 'dm',
              peerPubkey: thread.peerPubkey,
              callerNickname: thread.peerNickname,
            },
            onDirectClick: handleDirectNotificationClick,
          })
        }
      }
    }
  }, [dmThreads, canSendOsNotification, handleDirectNotificationClick, rememberNotified])

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

    for (const msg of activeServerMessages) {
      if (seen.has(msg.id)) continue
      seen.add(msg.id)

      if (
        msg.isSystem ||
        msg.isOwn ||
        ownPubkeysRef.current.has(msg.pubkey.toLowerCase())
      ) {
        continue
      }
      if (msg.createdAt < sessionBootSecRef.current - LIVE_RECENCY_WINDOW_SEC) {
        continue
      }
      if (cfg.serverMessages === 'off') continue

      const mentionedMe = doesContentMentionUser(
        msg.content,
        msg.mentions,
        nicknameRef.current,
        masterPubkeyRef.current
      )
      if (cfg.serverMessages === 'mentions' && !mentionedMe) continue
      if (!rememberNotified(`srv:${msg.id}`)) continue

      const isViewingChannel =
        view.type === 'server' &&
        view.serverId === activeServer.id &&
        view.channelId === activeChannelId
      const docActive = isDocumentFocusedAndVisible()
      if (docActive && isViewingChannel) continue

      if (cfg.soundEnabled) {
        soundEngine.playNotificationChime(mentionedMe ? 'mention' : 'message', {
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

        void showOsNotification({
          title: cfg.showPreviews
            ? `${activeServer.name} · ${chanLabel}`
            : 'New Server Message',
          body: cfg.showPreviews
            ? `${msg.displayHandle}: ${preview}`
            : 'New activity in one of your servers',
          tag: `agnostr-srv-${activeServer.id.slice(0, 12)}-${activeChannelId}`,
          vibrate: cfg.vibrationEnabled ? [120, 70, 120] : undefined,
          data: {
            category: 'server-message',
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

        if (!rosterBootedRef.current) continue
        if (seenRosterKeysRef.current.has(key)) continue
        if (ownPubkeysRef.current.has(member.pubkey.toLowerCase())) continue
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
          const srvName = server?.name || 'Server'
          void showOsNotification({
            title: cfg.showPreviews
              ? `${srvName} · Voice Lounge`
              : 'Server Call Active',
            body: cfg.showPreviews
              ? `${member.displayHandle} started a ${member.hasVideo ? 'video' : 'voice'} call`
              : 'A group call started in one of your servers',
            tag: `agnostr-srvcall-${serverId.slice(0, 12)}`,
            vibrate: cfg.vibrationEnabled ? [180, 90, 180] : undefined,
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

  // 6. Live Geo Radio Messages & /drop Location Notes (invoked directly from live relay callbacks in useAgnostrEngine)
  const notifyGeoMessage = useCallback(
    (input: NotifyGeoMessageInput) => {
      const cfg = settingsRef.current
      if (cfg.geoMessages === 'off') return
      if (cfg.geoMessages === 'mentions' && !input.mentionedMe) return
      if (!rememberNotified(`geo:${input.id}`)) return

      const view = activeViewRef.current
      const isViewingRoom =
        view.type === 'channel' && view.geohash === input.geohash
      const docActive = isDocumentFocusedAndVisible()
      if (docActive && isViewingRoom) return

      if (cfg.soundEnabled) {
        soundEngine.playNotificationChime(
          input.mentionedMe ? 'mention' : 'message',
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

        void showOsNotification({
          title: cfg.showPreviews
            ? input.mentionedMe
              ? `Mention in #${input.geohash}`
              : `#${input.geohash}`
            : 'Geo Radio Activity',
          body: cfg.showPreviews
            ? `${input.senderHandle}: ${preview}`
            : 'New message in Geo Radio',
          tag: `agnostr-geo-${input.geohash}`,
          vibrate: cfg.vibrationEnabled ? [120] : undefined,
          data: {
            category: 'geo-message',
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
      const cfg = settingsRef.current
      if (cfg.geoMessages === 'off') return
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
            geohash: input.geohash,
          },
          onDirectClick: handleDirectNotificationClick,
        })
      }
    },
    [canSendOsNotification, handleDirectNotificationClick, rememberNotified]
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
      } else if (result === 'denied') {
        updateSettings({ enabled: false })
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
    }, [updateSettings])

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
      body: 'Live alerts for DMs, calls, servers, and Geo Radio are active.',
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

  // Optional NIP-98 / VAPID Background Web Push Bridge
  const connectPushBridge = useCallback(
    async (
      bridgeUrlOverride?: string,
      vapidKeyOverride?: string
    ): Promise<boolean> => {
      if (!isWebPushSupported()) {
        setPushStatus('unsupported')
        setPushError('Web Push (PushManager) is unavailable in this browser.')
        return false
      }

      const rawUrl =
        bridgeUrlOverride !== undefined
          ? bridgeUrlOverride
          : settingsRef.current.pushBridgeUrl
      const normalizedUrl = normalizePushBridgeUrl(rawUrl)
      if (!normalizedUrl) {
        const msg =
          'Enter a valid https:// push bridge URL (or http://localhost for local dev).'
        setPushStatus('error')
        setPushError(msg)
        pushToastRef.current('warning', 'Invalid push bridge URL', msg)
        return false
      }

      let perm = permissionRef.current
      if (perm !== 'granted') {
        perm = await requestPermission()
      }
      if (perm !== 'granted') {
        setPushStatus('error')
        setPushError('Notification permission must be granted first.')
        return false
      }

      setPushStatus('connecting')
      setPushError(null)

      try {
        const manualKey =
          vapidKeyOverride !== undefined
            ? vapidKeyOverride.trim()
            : settingsRef.current.vapidPublicKey.trim()

        const result = await registerWithPushBridge({
          bridgeUrl: normalizedUrl,
          vapidPublicKey: manualKey || undefined,
          pubkey: masterPubkeyRef.current,
          relays: relayUrlsRef.current,
          geohashes: pinnedGeohashesRef.current,
          serverIds: joinedServersRef.current.map((s) => s.id),
          settings: settingsRef.current,
          signEvent: (tmpl) => signEventRef.current(tmpl),
        })

        updateSettings({
          enabled: true,
          pushBridgeUrl: normalizedUrl,
          vapidPublicKey: result.vapidPublicKey,
        })
        setPushEndpoint(result.endpoint)
        setPushStatus('connected')
        setPushError(null)
        pushToastRef.current(
          'success',
          'Background Web Push connected',
          'Your device is registered to wake on closed-app notifications and DM calls.'
        )
        return true
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Unable to register with push bridge.'
        setPushStatus('error')
        setPushError(msg)
        pushToastRef.current('error', 'Push bridge connection failed', msg)
        return false
      }
    },
    [requestPermission, updateSettings]
  )

  const disconnectPushBridge = useCallback(async (): Promise<void> => {
    try {
      await unregisterFromPushBridge({
        bridgeUrl: settingsRef.current.pushBridgeUrl,
        pubkey: masterPubkeyRef.current,
        signEvent: (tmpl) => signEventRef.current(tmpl),
      })
    } finally {
      setPushEndpoint(null)
      setPushStatus(isWebPushSupported() ? 'disconnected' : 'unsupported')
      setPushError(null)
      pushToastRef.current('info', 'Background Web Push disconnected')
    }
  }, [])

  // Stop sounds on unmount
  useEffect(() => {
    return () => {
      soundEngine.stopAll()
    }
  }, [])

  const resetAllNotifications = useCallback(() => {
    soundEngine.stopAll()
    void closeCallNotificationsViaSw()
    void unregisterFromPushBridge({
      bridgeUrl: settingsRef.current.pushBridgeUrl,
      pubkey: masterPubkeyRef.current,
      signEvent: (tmpl) => signEventRef.current(tmpl),
    })
    activeRingingCallIdRef.current = null
    notifiedIdsRef.current.clear()
    seenDmIdsRef.current = null
    seenServerMsgIdsRef.current.clear()
    seenRosterKeysRef.current.clear()
    sessionBootSecRef.current = Math.floor(Date.now() / 1000)
    setIsRinging(false)
    setIsRingMuted(false)
    setPendingAction(null)
    setPushEndpoint(null)
    setPushError(null)
    setPushStatus(isWebPushSupported() ? 'disconnected' : 'unsupported')
    settingsRef.current = DEFAULT_NOTIFICATION_SETTINGS
    setSettings(DEFAULT_NOTIFICATION_SETTINGS)
  }, [])

  const notifications: NotificationEngine = useMemo(
    () => ({
      permission,
      isSupported,
      isPushSupported,
      isIosRequiresInstall,
      settings,
      updateSettings,
      requestPermission,
      sendTestNotification,
      testRingtone,
      isRinging,
      isRingMuted,
      muteCurrentRing,
      pendingAction,
      consumePendingAction,
      pushStatus,
      pushError,
      pushEndpoint,
      connectPushBridge,
      disconnectPushBridge,
    }),
    [
      permission,
      isSupported,
      isPushSupported,
      isIosRequiresInstall,
      settings,
      updateSettings,
      requestPermission,
      sendTestNotification,
      testRingtone,
      isRinging,
      isRingMuted,
      muteCurrentRing,
      pendingAction,
      consumePendingAction,
      pushStatus,
      pushError,
      pushEndpoint,
      connectPushBridge,
      disconnectPushBridge,
    ]
  )

  return {
    notifications,
    notifyGeoMessage,
    notifyLocationNote,
    resetAllNotifications,
  }
}
