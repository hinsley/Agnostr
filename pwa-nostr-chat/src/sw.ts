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
import type { NotificationPayloadData } from './types/notifications.ts'

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

const BASE_PATH = '/Agnostr/'
const APP_ICON = '/Agnostr/icon-192.png'

// 1. Workbox precaching & offline caching (preserving all existing PWA offline capabilities)
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

registerRoute(
  new NavigationRoute(createHandlerBoundToURL(`${BASE_PATH}index.html`))
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

// 2. Service Worker lifecycle & client messaging (update flow + call notification cleanup)
swSelf.addEventListener('activate', (event) => {
  event.waitUntil(swSelf.clients.claim())
})

swSelf.addEventListener('message', (event) => {
  const data = event.data as { type?: string; callId?: string } | null
  if (!data || typeof data !== 'object') return

  if (data.type === 'SKIP_WAITING') {
    void swSelf.skipWaiting()
    return
  }

  if (data.type === 'CLOSE_CALL_NOTIFICATIONS') {
    event.waitUntil(closeCallNotifications(data.callId))
  }
})

// 3. Web Push reception (DM calls, DMs, Server messages/calls, Geo Radio, call cancel)
swSelf.addEventListener('push', (event) => {
  const handlePush = async () => {
    let payload: IncomingPushPayload = {}
    if (event.data) {
      try {
        payload = (await event.data.json()) as IncomingPushPayload
      } catch {
        try {
          const text = event.data.text()
          payload = { title: 'Agnostr', body: text, data: { category: 'test' } }
        } catch {
          payload = { title: 'Agnostr', body: 'New activity on Agnostr' }
        }
      }
    }

    const kindAction = payload.action || payload.type || ''
    const callId = payload.callId || payload.data?.callId
    if (kindAction === 'call-cancel' || kindAction === 'call-end') {
      await closeCallNotifications(callId)
      return
    }

    const data: NotificationPayloadData = {
      category: payload.data?.category ?? 'dm',
      tag: payload.tag ?? payload.data?.tag,
      callId,
      mediaType: payload.data?.mediaType,
      peerPubkey: payload.data?.peerPubkey,
      serverId: payload.data?.serverId,
      channelId: payload.data?.channelId,
      geohash: payload.data?.geohash,
      callerNickname: payload.data?.callerNickname,
    }

    const windowClients = await swSelf.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    })
    const hasFocusedClient = windowClients.some(
      (c) => c.visibilityState === 'visible' && c.focused
    )

    // Avoid duplicate OS notification when user is actively focused inside the app
    // (foreground engine already handles room-scoped notifications & live ringing)
    if (hasFocusedClient && !payload.forceShow && data.category !== 'dm-call') {
      return
    }

    if (!hasFocusedClient) {
      await setBadgeSafe(payload.badgeCount)
    }

    if (data.category === 'dm-call') {
      const tag = callId ? `agnostr-call-${callId}` : 'agnostr-call'
      const options: ExtendedNotificationOptions = {
        body:
          payload.body ||
          (data.mediaType === 'video'
            ? 'Incoming video call · Tap to answer'
            : 'Incoming voice call · Tap to answer'),
        icon: APP_ICON,
        badge: APP_ICON,
        tag,
        renotify: true,
        requireInteraction: true,
        vibrate: [380, 180, 380, 1000, 380, 180, 380],
        actions: [
          { action: 'answer', title: 'Answer' },
          { action: 'decline', title: 'Decline' },
        ],
        data: { ...data, tag },
      }
      await swSelf.registration.showNotification(
        payload.title || 'Incoming DM Call',
        options
      )
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
      body: payload.body || 'New message on Agnostr',
      icon: APP_ICON,
      badge: APP_ICON,
      tag,
      renotify: true,
      vibrate: [140, 80, 140],
      data: { ...data, tag },
    }
    await swSelf.registration.showNotification(payload.title || 'Agnostr', options)
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

    const agnostrClient =
      allClients.find((c) => c.url.includes(BASE_PATH)) ?? allClients[0] ?? null

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
