import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Event as NostrEvent, Filter } from 'nostr-tools'
import type { NotificationCategory } from '../types/notifications.ts'
import type {
  ProfileAccountRecord,
  ProfileNotificationSummary,
  ToastLevel,
} from '../types/protocol.ts'
import { AGORA_SOCIAL_RELAYS } from '../lib/agoraProtocol.ts'
import { computeRecipientHint } from '../lib/amailCrypto.ts'
import { KIND_AMAIL_EPHEMERAL_HOP } from '../lib/amailMesh.ts'
import { verifyEventCached } from '../lib/bitchatProtocol.ts'
import { CORE_DM_RELAYS } from '../lib/geoRelays.ts'
import { showOsNotification } from '../lib/notifications.ts'
import {
  loadProfileNotifications,
  markProfileChecked,
  recordInactiveProfileNotification,
} from '../lib/profileVault.ts'
import type { RelayPool } from '../lib/relayPool.ts'
import { bitchatAudio } from '../utils/sound.ts'

export interface UseProfileNotificationsOptions {
  relayPool: RelayPool
  profiles: readonly ProfileAccountRecord[]
  activeProfileId: string
  notificationsEnabled: boolean
  soundEnabled: boolean
  onSwitchProfile: (targetPubkey: string) => Promise<void>
  pushToast?: (level: ToastLevel, title: string, detail?: string) => void
}

export interface UseProfileNotificationsResult {
  notificationsByProfile: Record<string, ProfileNotificationSummary>
  otherProfilesUnreadCount: number
  clearProfileNotifications: (pubkey: string) => void
}

const WATCHED_TAGGED_KINDS = [1059, 4, 1, 9, 20000, 9735, 9321, 25050]
const AMAIL_HOP_TAG = 'agnostr-amail-hop'
const MAX_SEEN_EVENT_IDS = 800
const MAX_LOOKBACK_SEC = 7 * 24 * 60 * 60
const SOUND_COOLDOWN_MS = 3000

function describeEventKind(kind: number): {
  summary: string
  category: NotificationCategory
} {
  switch (kind) {
    case 1059:
    case 4:
      return { summary: 'New direct message', category: 'dm' }
    case 25050:
      return { summary: 'Incoming call', category: 'dm-call' }
    case 9735:
    case 9321:
      return { summary: 'New zap', category: 'dm' }
    case 20000:
      return { summary: 'Mentioned in Bitchat', category: 'geo-message' }
    case 9:
      return { summary: 'Mentioned in Group', category: 'server-message' }
    case 1:
      return { summary: 'New mention in Agora', category: 'dm' }
    case KIND_AMAIL_EPHEMERAL_HOP:
      return { summary: 'New Agmail', category: 'agmail' }
    default:
      return { summary: 'New notification', category: 'dm' }
  }
}

function describePushCategory(
  category: string | undefined,
  fallbackTitle?: string
): string {
  switch (category) {
    case 'dm':
      return 'New direct message'
    case 'dm-call':
      return 'Incoming call'
    case 'agmail':
      return 'New Agmail'
    case 'server-message':
      return 'Mentioned in Group'
    case 'server-call':
      return 'Incoming group call'
    case 'geo-message':
      return 'Mentioned in Bitchat'
    case 'geo-call':
      return 'Incoming Bitchat call'
    default:
      return fallbackTitle?.trim().slice(0, 80) || 'New notification'
  }
}

function extractAmailCapsuleRecipientHint(ev: NostrEvent): string | null {
  if (!ev.content) return null
  try {
    const parsed = JSON.parse(ev.content) as {
      t?: unknown
      capsule?: { recipientHint?: unknown }
    }
    if (
      parsed &&
      parsed.t === 'capsule' &&
      parsed.capsule &&
      typeof parsed.capsule.recipientHint === 'string' &&
      /^[0-9a-f]{12}$/i.test(parsed.capsule.recipientHint)
    ) {
      return parsed.capsule.recipientHint.toLowerCase()
    }
  } catch {
    // Ignore non-capsule mesh control packets
  }
  return null
}

function extractZapSenderPubkey(ev: NostrEvent): string | null {
  const desc = ev.tags.find((t) => t[0] === 'description' && typeof t[1] === 'string')?.[1]
  if (!desc) return null
  try {
    const req = JSON.parse(desc) as { pubkey?: unknown }
    if (typeof req?.pubkey === 'string' && /^[0-9a-f]{64}$/i.test(req.pubkey)) {
      return req.pubkey.toLowerCase()
    }
  } catch {
    // Ignore malformed zap description
  }
  return null
}

export function useProfileNotifications(
  options: UseProfileNotificationsOptions
): UseProfileNotificationsResult {
  const {
    relayPool,
    profiles,
    activeProfileId,
    notificationsEnabled,
    soundEnabled,
    onSwitchProfile,
    pushToast,
  } = options

  const activePkLower = activeProfileId.trim().toLowerCase()

  const [notificationsByProfile, setNotificationsByProfile] = useState<
    Record<string, ProfileNotificationSummary>
  >(() => {
    const initial = loadProfileNotifications()
    if (/^[0-9a-f]{64}$/.test(activePkLower)) {
      return markProfileChecked(activePkLower)
    }
    return initial
  })

  const notifsRef = useRef<Record<string, ProfileNotificationSummary>>(notificationsByProfile)
  const activePkRef = useRef<string>(activePkLower)
  const notificationsEnabledRef = useRef<boolean>(notificationsEnabled)
  const soundEnabledRef = useRef<boolean>(soundEnabled)
  const onSwitchProfileRef = useRef(onSwitchProfile)
  const pushToastRef = useRef(pushToast)
  const profilesByIdRef = useRef<Map<string, ProfileAccountRecord>>(new Map())
  const seenEventIdsRef = useRef<Set<string>>(new Set())
  const lastSoundAtRef = useRef<number>(0)

  useLayoutEffect(() => {
    notifsRef.current = notificationsByProfile
  }, [notificationsByProfile])

  useLayoutEffect(() => {
    activePkRef.current = activePkLower
    notificationsEnabledRef.current = notificationsEnabled
    soundEnabledRef.current = soundEnabled
    onSwitchProfileRef.current = onSwitchProfile
    pushToastRef.current = pushToast
    const map = new Map<string, ProfileAccountRecord>()
    for (const p of profiles) {
      map.set(p.id.toLowerCase(), p)
    }
    profilesByIdRef.current = map
  }, [
    activePkLower,
    notificationsEnabled,
    soundEnabled,
    onSwitchProfile,
    pushToast,
    profiles,
  ])

  // Keep active profile checked & unreadCount === 0
  useEffect(() => {
    if (!/^[0-9a-f]{64}$/.test(activePkLower)) return
    const next = markProfileChecked(activePkLower)
    notifsRef.current = next
    setNotificationsByProfile(next)
  }, [activePkLower])

  const clearProfileNotifications = useCallback((pubkey: string) => {
    const pk = pubkey.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pk)) return
    const next = markProfileChecked(pk)
    notifsRef.current = next
    setNotificationsByProfile(next)
  }, [])

  const notifyInactiveProfile = useCallback(
    (
      targetProfile: ProfileAccountRecord,
      summary: string,
      category: NotificationCategory,
      eventTsSec?: number,
      fromServiceWorkerPush = false
    ) => {
      const targetPk = targetProfile.id.toLowerCase()
      const updated = recordInactiveProfileNotification(targetPk, summary, eventTsSec)
      notifsRef.current = updated
      setNotificationsByProfile(updated)

      if (soundEnabledRef.current) {
        const nowMs = Date.now()
        if (nowMs - lastSoundAtRef.current >= SOUND_COOLDOWN_MS) {
          lastSoundAtRef.current = nowMs
          bitchatAudio.play('mention')
        }
      }

      const isVisible = typeof document !== 'undefined' && document.visibilityState === 'visible'
      if (isVisible) {
        pushToastRef.current?.(
          'info',
          `${targetProfile.nickname} · ${summary}`,
          'Open Profiles to switch.'
        )
      }

      if (!fromServiceWorkerPush && notificationsEnabledRef.current) {
        void showOsNotification({
          title: `${targetProfile.nickname} · ${summary}`,
          body: `Switch to ${targetProfile.nickname} to view`,
          tag: `agnostr-profile-${targetPk.slice(0, 12)}`,
          data: {
            category,
            recipientPubkey: targetPk,
          },
          onDirectClick: () => {
            void onSwitchProfileRef.current(targetPk)
          },
        })
      }
    },
    []
  )

  // Listen for Service Worker Web Push forwards for inactive saved profiles
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const onSwMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: unknown
        recipientPubkey?: unknown
        category?: unknown
        title?: unknown
        ts?: unknown
      } | null
      if (!data || data.type !== 'agnostr-profile-push') return
      if (typeof data.recipientPubkey !== 'string') return
      const targetPk = data.recipientPubkey.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(targetPk) || targetPk === activePkRef.current) return
      const targetProfile = profilesByIdRef.current.get(targetPk)
      if (!targetProfile) return

      const rawCategory = typeof data.category === 'string' ? data.category : 'dm'
      const summary = describePushCategory(
        rawCategory,
        typeof data.title === 'string' ? data.title : undefined
      )
      const tsSec =
        typeof data.ts === 'number' && Number.isFinite(data.ts) && data.ts > 0
          ? Math.floor(data.ts / 1000)
          : Math.floor(Date.now() / 1000)
      notifyInactiveProfile(
        targetProfile,
        summary,
        rawCategory as NotificationCategory,
        tsSec,
        true
      )
    }
    navigator.serviceWorker.addEventListener('message', onSwMessage)
    return () => {
      navigator.serviceWorker.removeEventListener('message', onSwMessage)
    }
  }, [notifyInactiveProfile])

  // Stable key of inactive saved profile pubkeys
  const inactivePubkeysKey = useMemo(() => {
    const pks: string[] = []
    for (const p of profiles) {
      const pk = p.id.toLowerCase()
      if (/^[0-9a-f]{64}$/.test(pk) && pk !== activePkLower) {
        pks.push(pk)
      }
    }
    pks.sort()
    return pks.join(',')
  }, [profiles, activePkLower])

  // Single lightweight live relay watcher across all inactive saved profiles
  useEffect(() => {
    if (!inactivePubkeysKey) return
    const inactivePubkeys = inactivePubkeysKey.split(',')
    if (inactivePubkeys.length === 0) return

    const inactiveSet = new Set(inactivePubkeys)
    const hintToProfilePk = new Map<string, string>()
    for (const pk of inactivePubkeys) {
      hintToProfilePk.set(computeRecipientHint(pk), pk)
    }

    const mountedAtSec = Math.floor(Date.now() / 1000)
    let minSinceSec = mountedAtSec - 60
    for (const pk of inactivePubkeys) {
      const checked = notifsRef.current[pk]?.lastCheckedAt ?? 0
      if (checked > 0 && checked < minSinceSec) {
        minSinceSec = checked
      }
    }
    minSinceSec = Math.max(mountedAtSec - MAX_LOOKBACK_SEC, minSinceSec)

    const relays = Array.from(new Set([...CORE_DM_RELAYS, ...AGORA_SOCIAL_RELAYS]))
    const filters: Filter[] = [
      {
        kinds: WATCHED_TAGGED_KINDS,
        '#p': inactivePubkeys,
        since: minSinceSec,
        limit: 80,
      },
      {
        kinds: [KIND_AMAIL_EPHEMERAL_HOP],
        '#t': [AMAIL_HOP_TAG],
        since: Math.max(minSinceSec, mountedAtSec - 60),
        limit: 40,
      },
    ]

    let cancelled = false
    let eoseReceived = false
    const eoseFallbackTimer = window.setTimeout(() => {
      eoseReceived = true
    }, 2500)

    const rememberSeen = (id: string): boolean => {
      const seen = seenEventIdsRef.current
      if (seen.has(id)) return false
      if (seen.size >= MAX_SEEN_EVENT_IDS) {
        const oldest = seen.values().next().value
        if (oldest) seen.delete(oldest)
      }
      seen.add(id)
      return true
    }

    const unsub = relayPool.subscribe(
      `agnostr-inactive-profiles-${inactivePubkeys.length}`,
      relays,
      filters,
      {
        onEose: () => {
          eoseReceived = true
        },
        onEvent: (ev) => {
          if (cancelled || !ev || typeof ev.id !== 'string') return
          const evId = ev.id.toLowerCase()
          if (!rememberSeen(evId)) return

          // NIP-17 kind:1059 randomizes created_at up to 2 days — only notify on post-EOSE live arrivals
          if (ev.kind === 1059 && !eoseReceived) {
            return
          }

          if (!verifyEventCached(ev)) return
          if (cancelled) return

          const authorPk = ev.pubkey.toLowerCase()
          const matchedTargets = new Set<string>()

          if (ev.kind === KIND_AMAIL_EPHEMERAL_HOP) {
            const hint = extractAmailCapsuleRecipientHint(ev)
            if (hint) {
              const target = hintToProfilePk.get(hint)
              if (target) matchedTargets.add(target)
            }
          } else {
            for (const tag of ev.tags) {
              if (tag[0] === 'p' && typeof tag[1] === 'string') {
                const candidate = tag[1].toLowerCase()
                if (inactiveSet.has(candidate)) {
                  matchedTargets.add(candidate)
                }
              }
            }
          }

          if (matchedTargets.size === 0) return

          const zapSenderPk = ev.kind === 9735 ? extractZapSenderPubkey(ev) : null
          const { summary, category } = describeEventKind(ev.kind)

          for (const targetPk of matchedTargets) {
            if (targetPk === activePkRef.current) continue
            if (authorPk === targetPk) continue
            if (zapSenderPk && zapSenderPk === targetPk) continue

            const targetProfile = profilesByIdRef.current.get(targetPk)
            if (!targetProfile) continue

            if (ev.kind !== 1059) {
              const checkedAt = notifsRef.current[targetPk]?.lastCheckedAt || mountedAtSec
              if (ev.created_at <= checkedAt) continue
            }

            const eventTsSec = ev.kind === 1059 ? Math.floor(Date.now() / 1000) : ev.created_at
            notifyInactiveProfile(targetProfile, summary, category, eventTsSec, false)
          }
        },
      }
    )

    return () => {
      cancelled = true
      window.clearTimeout(eoseFallbackTimer)
      unsub()
    }
  }, [relayPool, inactivePubkeysKey, notifyInactiveProfile])

  const otherProfilesUnreadCount = useMemo(() => {
    let total = 0
    for (const p of profiles) {
      const pk = p.id.toLowerCase()
      if (pk === activePkLower) continue
      total += notificationsByProfile[pk]?.unreadCount ?? 0
    }
    return total
  }, [profiles, activePkLower, notificationsByProfile])

  return {
    notificationsByProfile,
    otherProfilesUnreadCount,
    clearProfileNotifications,
  }
}
