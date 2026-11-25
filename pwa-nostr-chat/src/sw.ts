/// <reference lib="webworker" />

import { CacheableResponsePlugin } from 'workbox-cacheable-response'
import { ExpirationPlugin } from 'workbox-expiration'
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import type { NotificationCategory, NotificationPayloadData } from './types/notifications.ts'
import { findDisplayedPush, normalizePushIdentifier } from './lib/pushDisplay.ts'

interface ManifestEntry {
  url: string
  revision: string | null
}

interface ExtendedNotificationOptions extends NotificationOptions {
  renotify?: boolean
  vibrate?: number[]
  actions?: Array<{ action: string; title: string; icon?: string }>
}

interface IncomingPushPayload {
  title?: string
  body?: string
  tag?: string
  badgeCount?: number
  forceShow?: boolean
  action?: string
  type?: string
  callId?: string
  data?: Partial<NotificationPayloadData>
}

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | ManifestEntry>
}

const swSelf = self

function getBasePath(): string {
  try {
    const scope = swSelf.registration?.scope
    if (scope) {
      const pathname = new URL(scope).pathname
      return pathname.endsWith('/') ? pathname : `${pathname}/`
    }
  } catch {
    // Fall back to root path
  }
  return '/'
}

const BASE_PATH = getBasePath()
const APP_ICON = `${BASE_PATH}icon-192.png`

// 1. Workbox precaching & offline caching (preserving all existing PWA offline capabilities)
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

registerRoute(
  new NavigationRoute(createHandlerBoundToURL(`${BASE_PATH}index.html`))
)

// Cache only detail actually visited (content-hashed, same-origin files). The
// precached overview keeps every world usable offline even on its first visit.
registerRoute(
  ({ sameOrigin, url }) => sameOrigin && /\/assets\/surface-[a-z]+-(512|1024)-[\w-]+\.webp$/.test(url.pathname),
  new CacheFirst({
    cacheName: 'solar-surface-details-v1',
    plugins: [new ExpirationPlugin({ maxEntries: 8, maxAgeSeconds: 30 * 24 * 60 * 60 })],
  })
)

// Zoom tiles are immutable by revision and fetched only for the world in view.
registerRoute(
  ({ sameOrigin, url }) => sameOrigin && /\/solar-tiles\/[a-z]+\/[a-f0-9]{16}\/[0-5]\/\d+\/\d+\.webp$/.test(url.pathname),
  new CacheFirst({
    cacheName: 'solar-surface-tiles-v1',
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 96, maxAgeSeconds: 30 * 24 * 60 * 60, purgeOnQuotaError: true }),
    ],
  }),
)

registerRoute(
  ({ url }) => /^https:\/\/fonts\.googleapis\.com\/.*/i.test(url.href),
  new CacheFirst({
    cacheName: 'google-fonts-stylesheets',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 10,
        maxAgeSeconds: 60 * 60 * 24 * 365,
      }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  })
)

registerRoute(
  ({ url }) => /^https:\/\/fonts\.gstatic\.com\/.*/i.test(url.href),
  new CacheFirst({
    cacheName: 'google-fonts-webfonts',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 30,
        maxAgeSeconds: 60 * 60 * 24 * 365,
      }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  })
)

registerRoute(
  ({ url }) =>
    /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/.*/i.test(
      url.href
    ),
  new CacheFirst({
    cacheName: 'esri-basemap-tiles',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 250,
        maxAgeSeconds: 60 * 60 * 24 * 7,
      }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  })
)

function encodeNotifyHash(action: string, payload: NotificationPayloadData): string {
  try {
    const json = JSON.stringify({ action, payload })
    const bytes = new TextEncoder().encode(json)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    const b64url = btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    return `${BASE_PATH}#notify=${b64url}`
  } catch {
    return BASE_PATH
  }
}

async function closeCallNotifications(callId?: string): Promise<void> {
  try {
    const list = await swSelf.registration.getNotifications()
    const exactTag = callId ? `agnostr-call-${callId}` : null
    for (const n of list) {
      const nTag = n.tag || ''
      const nData = (n.data || {}) as Partial<NotificationPayloadData>
      if (exactTag) {
        if (nTag === exactTag || nData.callId === callId) {
          n.close()
        }
      } else if (nTag.startsWith('agnostr-call') || nData.category === 'dm-call') {
        n.close()
      }
    }
  } catch {
    // Ignore restricted notification queries
  }
}

async function setBadgeSafe(count?: number): Promise<void> {
  try {
    const nav = swSelf.navigator
    if (!nav) return
    if (typeof count === 'number' && count > 0 && typeof nav.setAppBadge === 'function') {
      await nav.setAppBadge(Math.floor(count))
    } else if (count === undefined && typeof nav.setAppBadge === 'function') {
      await nav.setAppBadge()
    } else if (count === 0 && typeof nav.clearAppBadge === 'function') {
      await nav.clearAppBadge()
    }
  } catch {
    // Ignore unsupported badging API
  }
}

// Precache on install, but do not interrupt open sessions. With clients open,
// activation waits for their explicit update button (SKIP_WAITING) or closure.
swSelf.addEventListener('activate', (event) => {
  event.waitUntil(swSelf.clients.claim())
})

swSelf.addEventListener('message', (event) => {
  const data = event.data as { type?: string; callId?: string } | null
  if (!data || typeof data !== 'object') return

  if (data.type === 'SKIP_WAITING') {
    event.waitUntil(swSelf.skipWaiting())
    return
  }

  if (data.type === 'CLOSE_CALL_NOTIFICATIONS') {
    event.waitUntil(closeCallNotifications(data.callId))
  }
})

/** Restrict worker forwards to this installation's same-origin scoped app windows.
 * Finding clients is best effort and must not prevent native delivery. */
async function getAppWindows(): Promise<WindowClient[]> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const scope = swSelf.registration.scope
    const windows = await Promise.race([
      swSelf.clients.matchAll({ type: 'window', includeUncontrolled: true }),
      new Promise<WindowClient[]>((resolve) => {
        timeout = setTimeout(() => resolve([]), 250)
      }),
    ])
    return windows.filter((window) => window.url.startsWith(scope))
  } catch {
    return []
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function postToWindows(windows: WindowClient[], message: Record<string, unknown>): void {
  for (const window of windows) {
    try {
      window.postMessage(message)
    } catch {
      // A window may have detached after matchAll.
    }
  }
}

// A subscription rotation requires fresh account-authenticated registration.
swSelf.addEventListener('pushsubscriptionchange', (event: Event) => {
  const subscriptionChange = event as ExtendableEvent
  subscriptionChange.waitUntil(
    getAppWindows().then((windows) => postToWindows(windows, {
      type: 'agnostr:push-subscription-changed',
    }))
  )
})

type DisplayFailure = 'notification-permission-denied' | 'notification-display-failed'

async function showSwNotificationSafe(
  title: string,
  options: ExtendedNotificationOptions,
  data: NotificationPayloadData,
  forceShow: boolean
): Promise<{ displayed: true } | { displayed: false; error: DisplayFailure }> {
  // A Web Push event must display a native notification on userVisibleOnly
  // platforms. An exact notification already displayed by the foreground app
  // can be replaced in place without alerting a second time. Neither focus,
  // unread badges nor matching conversation tags prove delivery of this event.
  const prior = forceShow ? undefined : await findDisplayedPush(swSelf.registration, data)
  const priorData = prior?.data as Partial<NotificationPayloadData> | undefined
  const resolvedData: NotificationPayloadData = {
    ...data,
    tag: prior?.tag || options.tag,
    // An exact local display may know the decrypted sender or destination
    // whereas the relay-only bridge can only announce a generic gift wrap.
    peerPubkey: normalizePushIdentifier(priorData?.peerPubkey) || data.peerPubkey,
    serverId: stringField(priorData?.serverId) || data.serverId,
    channelId: stringField(priorData?.channelId) || data.channelId,
    geohash: stringField(priorData?.geohash) || data.geohash,
    noteId: normalizePushIdentifier(priorData?.noteId) || data.noteId,
    callerNickname: stringField(priorData?.callerNickname) || data.callerNickname,
  }
  const display: ExtendedNotificationOptions = prior
    ? {
        ...options,
        body: prior.body || options.body,
        tag: prior.tag,
        data: resolvedData,
        renotify: false,
        vibrate: undefined,
        silent: true,
      }
    : options
  const displayTitle = prior?.title || title
  try {
    await swSelf.registration.showNotification(displayTitle, display)
    return { displayed: true }
  } catch (err) {
    // Some platforms reject actions, vibration, icons or other presentation hints.
    // Retry using the most portable options while retaining the click target.
    try {
      await swSelf.registration.showNotification(displayTitle, {
        body: display.body,
        tag: display.tag,
        data: display.data,
        ...(prior ? { silent: true } : {}),
      })
      return { displayed: true }
    } catch (fallbackError) {
      const permissionDenied = [err, fallbackError].some((failure) =>
        failure instanceof Error && failure.name === 'NotAllowedError'
      )
      return {
        displayed: false,
        error: permissionDenied ? 'notification-permission-denied' : 'notification-display-failed',
      }
    }
  }
}

const PUSH_CATEGORIES: ReadonlySet<string> = new Set<NotificationCategory>([
  'dm', 'dm-call', 'server-message', 'server-call', 'geo-message', 'geo-call',
  'location-note', 'agmail', 'agora-reply', 'agora-mention', 'agora-like',
  'agora-repost', 'agora-zap', 'agora-follow', 'test',
])

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// 3. Web Push reception (DM calls, DMs, Group messages/calls, Bitchat, call cancel)
swSelf.addEventListener('push', (event) => {
  const handlePush = async () => {
    let payload: IncomingPushPayload = {}
    if (event.data) {
      try {
        const parsed: unknown = event.data.json()
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = parsed as IncomingPushPayload
        }
      } catch {
        // An unreadable packet gets a generic notification, never an unvalidated preview.
      }
    }

    const kindAction = stringField(payload.action) || stringField(payload.type)
    const callId = stringField(payload.callId) || stringField(payload.data?.callId)
    if (kindAction === 'call-cancel' || kindAction === 'call-end') {
      if (callId) postToWindows(await getAppWindows(), { type: 'agnostr-incoming-call-cancel', callId })
      // Replace the call's ring with a quiet, non-answerable notification.
      // Web Push providers require a visible notification even when the
      // foreground app already handled a call-ending signal.
      const tag = callId ? `agnostr-call-${callId}` : 'agnostr-call-ended'
      const data: NotificationPayloadData = {
        category: 'dm',
        tag,
        peerPubkey: normalizePushIdentifier(payload.data?.peerPubkey),
        recipientPubkey: normalizePushIdentifier(payload.data?.recipientPubkey),
      }
      const result = await showSwNotificationSafe('Call ended', {
        tag, body: 'This call is no longer ringing.', icon: APP_ICON,
        silent: true, renotify: false, requireInteraction: false, data,
      }, data, true)
      if (!result.displayed) console.warn('[Agnostr Web Push] Call notification could not be updated', {
        error: result.error,
      })
      return
    }

    const fields = payload.data
    const recipientPubkey = normalizePushIdentifier(fields?.recipientPubkey)
    const rawCategory = fields?.category
    const category = typeof rawCategory === 'string' && PUSH_CATEGORIES.has(rawCategory)
      ? rawCategory as NotificationCategory
      : 'dm'
    const testId = category === 'test' && typeof fields?.testId === 'string' &&
      /^[0-9a-f]{32}$/.test(fields.testId) ? fields.testId : undefined
    const data: NotificationPayloadData = {
      category,
      tag: stringField(payload.tag) || stringField(fields?.tag),
      callId,
      mediaType: fields?.mediaType === 'video' ? 'video' : fields?.mediaType === 'audio' ? 'audio' : undefined,
      peerPubkey: normalizePushIdentifier(fields?.peerPubkey),
      recipientPubkey,
      serverId: stringField(fields?.serverId),
      channelId: stringField(fields?.channelId),
      geohash: stringField(fields?.geohash),
      noteId: normalizePushIdentifier(fields?.noteId),
      deliveryEventId: normalizePushIdentifier(fields?.deliveryEventId),
      callerNickname: stringField(fields?.callerNickname),
    }
    const title = stringField(payload.title)
    const body = stringField(payload.body)
    const windowsPromise = getAppWindows()

    const display = async (heading: string, options: ExtendedNotificationOptions) => {
      const result = await showSwNotificationSafe(heading, options, data, payload.forceShow === true)
      if (!result.displayed) {
        // Useful local diagnostics without previews, push endpoints or account data.
        console.warn('[Agnostr Web Push] Native notification could not be shown', {
          category, error: result.error,
        })
      }
      if (testId) {
        postToWindows(await windowsPromise, {
          type: 'agnostr:push-test-receipt',
          testId,
          displayed: result.displayed,
          ...(!result.displayed ? { error: result.error } : {}),
        })
      }
    }

    if (category === 'test') {
      const tag = testId ? `agnostr-test-${testId}` : data.tag || 'agnostr-test'
      await display(title || 'Agnostr Test Push', {
        body: body || 'This device received a Web Push test.',
        tag,
        icon: APP_ICON,
        badge: APP_ICON,
        data: { ...data, tag },
      })
      return
    }

    const windowClients = await windowsPromise
    if (recipientPubkey) {
      postToWindows(windowClients, {
        type: 'agnostr-profile-push',
        recipientPubkey,
        category,
        title,
        ts: Date.now(),
      })
    }
    const hasFocusedClient = windowClients.some(
      (c) => c.visibilityState === 'visible' && c.focused
    )
    if (!hasFocusedClient) {
      void setBadgeSafe(typeof payload.badgeCount === 'number' && Number.isFinite(payload.badgeCount)
        ? payload.badgeCount : undefined)
    }

    if (data.category === 'dm-call') {
      // Wake any open client windows immediately so loud phone-style ringtone starts without waiting for relay reconnect
      if (windowClients.length > 0) {
        for (const client of windowClients) {
          try {
            client.postMessage({
              type: 'agnostr-incoming-call-ring',
              callId,
              mediaType: data.mediaType ?? 'audio',
              peerPubkey: data.peerPubkey,
              callerNickname: data.callerNickname,
              recipientPubkey,
              ts: Date.now(),
            })
          } catch {
            // Ignore detached window postMessage errors
          }
        }
      }

      const tag = callId ? `agnostr-call-${callId}` : 'agnostr-call'
      const options: ExtendedNotificationOptions = {
        body:
          body ||
          (data.mediaType === 'video'
            ? 'Incoming video call · Tap to answer'
            : 'Incoming voice call · Tap to answer'),
        icon: APP_ICON,
        badge: APP_ICON,
        tag,
        renotify: true,
        requireInteraction: true,
        vibrate: [500, 220, 500, 220, 700],
        actions: [
          { action: 'answer', title: 'Answer' },
          { action: 'decline', title: 'Decline' },
        ],
        data: { ...data, tag },
      }
      await display(title || 'Incoming Call', options)
      return
    }

    if (data.category === 'server-call') {
      const tag =
        data.tag ||
        (data.serverId ? `agnostr-srvcall-${data.serverId.slice(0, 12)}` : 'agnostr-srvcall')
      const options: ExtendedNotificationOptions = {
        body: body || 'A group call started in one of your groups',
        icon: APP_ICON,
        badge: APP_ICON,
        tag,
        renotify: true,
        requireInteraction: true,
        vibrate: [180, 90, 180],
        actions: [
          { action: 'open', title: 'Accept' },
          { action: 'decline', title: 'Decline' },
        ],
        data: { ...data, tag },
      }
      await display(title || 'Group Call Active', options)
      return
    }

    if (data.category === 'geo-call') {
      const tag =
        data.tag ||
        (data.geohash ? `agnostr-geocall-${data.geohash}` : 'agnostr-geocall')
      const options: ExtendedNotificationOptions = {
        body: body || 'A group call started in a Bitchat channel',
        icon: APP_ICON,
        badge: APP_ICON,
        tag,
        renotify: true,
        requireInteraction: true,
        vibrate: [180, 90, 180],
        actions: [
          { action: 'open', title: 'Accept' },
          { action: 'decline', title: 'Decline' },
        ],
        data: { ...data, tag },
      }
      await display(title || 'Bitchat Call Active', options)
      return
    }

    if (data.category === 'agmail') {
      const tag = data.tag || 'agnostr-agmail'
      const options: ExtendedNotificationOptions = {
        body: body || 'You received an encrypted Agmail',
        icon: APP_ICON,
        badge: APP_ICON,
        tag,
        renotify: true,
        vibrate: [140, 80, 140],
        data: { ...data, tag },
      }
      await display(title || 'New Agmail', options)
      return
    }

    if (data.category.startsWith('agora-')) {
      const tag =
        data.tag ||
        (data.noteId
          ? `agnostr-agora-${data.noteId.slice(0, 12)}`
          : data.peerPubkey
            ? `agnostr-agora-${data.peerPubkey.slice(0, 12)}`
            : 'agnostr-agora')
      const options: ExtendedNotificationOptions = {
        body: body || 'New activity on Agora',
        icon: APP_ICON,
        badge: APP_ICON,
        tag,
        renotify: true,
        vibrate: [140, 80, 140],
        data: { ...data, tag },
      }
      await display(title || 'Agora', options)
      return
    }

    const tag =
      data.tag ||
      (data.peerPubkey
        ? `agnostr-dm-${data.peerPubkey.slice(0, 12)}`
        : data.serverId
          ? `agnostr-srv-${data.serverId.slice(0, 12)}`
          : data.geohash
            ? `agnostr-geo-${data.geohash}`
            : 'agnostr-msg')

    const options: ExtendedNotificationOptions = {
      body: body || 'New message on Agnostr',
      icon: APP_ICON,
      badge: APP_ICON,
      tag,
      renotify: true,
      vibrate: [140, 80, 140],
      data: { ...data, tag },
    }
    await display(title || 'Agnostr', options)
  }

  event.waitUntil(handlePush())
})

// 4. Notification click / Answer / Decline deep-link handoff
swSelf.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const rawAction = event.action || 'open'
  const action =
    rawAction === 'answer' || rawAction === 'answer-audio' || rawAction === 'decline'
      ? rawAction
      : 'open'
  const payload = (event.notification.data || {
    category: 'test',
  }) as NotificationPayloadData

  const handleClick = async () => {
    const allClients = await swSelf.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    })

    const scopeHref = swSelf.registration?.scope
    const agnostrClient =
      allClients.find((c) =>
        scopeHref ? c.url.startsWith(scopeHref) : c.url.includes(BASE_PATH)
      ) ??
      allClients[0] ??
      null

    if (agnostrClient) {
      agnostrClient.postMessage({
        type: 'AGNOSTR_NOTIFICATION_ACTION',
        action,
        payload,
      })
      if (action !== 'decline' && typeof agnostrClient.focus === 'function') {
        try {
          await agnostrClient.focus()
        } catch {
          // Ignore focus restrictions on mobile browsers
        }
      }
      return
    }

    // Cold launch from closed PWA / lock screen (skip opening a window just to decline)
    if (action === 'decline') return

    const deepLinkUrl = encodeNotifyHash(action, payload)
    if (typeof swSelf.clients.openWindow === 'function') {
      await swSelf.clients.openWindow(deepLinkUrl)
    }
  }

  event.waitUntil(handleClick())
})
