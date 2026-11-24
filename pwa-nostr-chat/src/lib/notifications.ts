import { sha256 } from '@noble/hashes/sha256'
import type { EventTemplate, VerifiedEvent } from 'nostr-tools'
import type {
  NotificationPayloadData,
  NotificationPermissionState,
  NotificationSettings,
  PendingNotificationAction,
  PushPokePayload,
} from '../types/notifications.ts'
import { getPwaSwRegistration } from '../hooks/usePwa.ts'
import { bytesToHex } from './identity.ts'

export const KIND_NIP98_HTTP_AUTH = 27235
const APP_ICON = '/icon-192.png'
const utf8Encoder = new TextEncoder()

interface ExtendedNotificationOptions extends NotificationOptions {
  renotify?: boolean
  vibrate?: number[]
  actions?: Array<{ action: string; title: string; icon?: string }>
}

export function getBrowserNotificationPermission(): NotificationPermissionState {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'unsupported'
  }
  const perm = Notification.permission
  if (perm === 'granted' || perm === 'denied' || perm === 'default') {
    return perm
  }
  return 'unsupported'
}

export function isWebPushSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false
  }
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  )
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'unsupported'
  }
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied') return 'denied'
  try {
    // Must be called synchronously inside the user gesture handler
    const result = await Notification.requestPermission()
    return result === 'granted' || result === 'denied' ? result : 'default'
  } catch {
    return getBrowserNotificationPermission()
  }
}

export function normalizePushBridgeUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    const isLocal =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]'
    if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLocal)) {
      return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '')
    }
    return null
  } catch {
    return null
  }
}

export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const clean = base64Url.trim()
  const pad = '='.repeat((4 - (clean.length % 4)) % 4)
  const b64 = (clean + pad).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const buf = new ArrayBuffer(raw.length)
  const out = new Uint8Array(buf)
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i)
  }
  return out
}

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function normalizeBase64Url(value: string): string {
  return value.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function parseNotifyHash(rawHash: string): PendingNotificationAction | null {
  const trimmed = rawHash.replace(/^#/, '').trim()
  if (!trimmed.toLowerCase().startsWith('notify=')) return null
  const encoded = trimmed.slice('notify='.length).trim()
  if (!encoded) return null

  try {
    const pad = '='.repeat((4 - (encoded.length % 4)) % 4)
    const b64 = (encoded + pad).replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i)
    }
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as {
      action?: unknown
      payload?: Partial<NotificationPayloadData>
    }
    if (!decoded || typeof decoded !== 'object' || !decoded.payload) return null
    const rawAction = decoded.action
    const action: PendingNotificationAction['action'] =
      rawAction === 'answer' ||
      rawAction === 'answer-audio' ||
      rawAction === 'decline'
        ? rawAction
        : 'open'
    const rawRecipient = decoded.payload.recipientPubkey
    const recipientPubkey =
      typeof rawRecipient === 'string' && /^[0-9a-f]{64}$/i.test(rawRecipient.trim())
        ? rawRecipient.trim().toLowerCase()
        : undefined
    const rawNoteId = decoded.payload.noteId
    const noteId =
      typeof rawNoteId === 'string' && /^[0-9a-f]{64}$/i.test(rawNoteId.trim())
        ? rawNoteId.trim().toLowerCase()
        : undefined
    return {
      action,
      payload: {
        category: decoded.payload.category ?? 'dm',
        tag: decoded.payload.tag,
        callId: decoded.payload.callId,
        mediaType: decoded.payload.mediaType,
        peerPubkey: decoded.payload.peerPubkey,
        recipientPubkey,
        serverId: decoded.payload.serverId,
        channelId: decoded.payload.channelId,
        geohash: decoded.payload.geohash,
        noteId,
        callerNickname: decoded.payload.callerNickname,
      },
      receivedAt: Date.now(),
    }
  } catch {
    return null
  }
}

export interface ShowOsNotificationInput {
  title: string
  body: string
  tag: string
  data: NotificationPayloadData
  requireInteraction?: boolean
  vibrate?: number[]
  actions?: Array<{ action: string; title: string }>
  onDirectClick?: (payload: NotificationPayloadData) => void
}

export async function showOsNotification(
  input: ShowOsNotificationInput
): Promise<boolean> {
  if (getBrowserNotificationPermission() !== 'granted') return false

  const options: ExtendedNotificationOptions = {
    body: input.body,
    icon: APP_ICON,
    badge: APP_ICON,
    tag: input.tag,
    renotify: true,
    requireInteraction: Boolean(input.requireInteraction),
    vibrate: input.vibrate,
    actions: input.actions,
    data: { ...input.data, tag: input.tag },
  }

  // Prefer ServiceWorkerRegistration.showNotification (required on mobile PWAs & supports action buttons)
  const reg = await getPwaSwRegistration()
  if (reg && typeof reg.showNotification === 'function') {
    try {
      await reg.showNotification(input.title, options)
      return true
    } catch {
      // Some browsers reject `actions` with TypeError — retry cleanly without actions before falling back
      if (options.actions && options.actions.length > 0) {
        try {
          const withoutActions: ExtendedNotificationOptions = { ...options }
          delete withoutActions.actions
          await reg.showNotification(input.title, withoutActions)
          return true
        } catch {
          // Fall back to direct Notification constructor below
        }
      }
    }
  }

  try {
    const directOpts: NotificationOptions = {
      body: input.body,
      icon: APP_ICON,
      tag: input.tag,
      requireInteraction: Boolean(input.requireInteraction),
      data: { ...input.data, tag: input.tag },
    }
    const notif = new Notification(input.title, directOpts)
    notif.onclick = () => {
      try {
        window.focus()
      } catch {
        // Ignore
      }
      notif.close()
      input.onDirectClick?.(input.data)
    }
    return true
  } catch {
    return false
  }
}

export async function closeCallNotificationsViaSw(callId?: string): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  try {
    navigator.serviceWorker.controller?.postMessage({
      type: 'CLOSE_CALL_NOTIFICATIONS',
      callId,
    })
  } catch {
    // Ignore
  }

  const reg = await getPwaSwRegistration()
  if (!reg) return
  try {
    reg.active?.postMessage({
      type: 'CLOSE_CALL_NOTIFICATIONS',
      callId,
    })
  } catch {
    // Ignore
  }
  try {
    if (typeof reg.getNotifications === 'function') {
      const list = await reg.getNotifications()
      const targetTag = callId ? `agnostr-call-${callId}` : null
      for (const n of list) {
        const nTag = n.tag || ''
        const nData = (n.data || {}) as Partial<NotificationPayloadData>
        if (targetTag) {
          if (nTag === targetTag || nData.callId === callId) n.close()
        } else if (nTag.startsWith('agnostr-call') || nData.category === 'dm-call') {
          n.close()
        }
      }
    }
  } catch {
    // Ignore
  }
}

export async function buildNip98AuthHeader(opts: {
  url: string
  method: 'POST' | 'DELETE'
  bodyJson: string
  signEvent: (tmpl: EventTemplate) => Promise<VerifiedEvent>
}): Promise<string> {
  const payloadHash = bytesToHex(sha256(utf8Encoder.encode(opts.bodyJson)))
  const template: EventTemplate = {
    kind: KIND_NIP98_HTTP_AUTH,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', opts.url],
      ['method', opts.method],
      ['payload', payloadHash],
    ],
    content: '',
  }
  const signed = await opts.signEvent(template)
  const json = JSON.stringify(signed)
  const bytes = utf8Encoder.encode(json)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return `Nostr ${btoa(binary)}`
}

export async function fetchVapidPublicKey(bridgeUrl: string): Promise<string> {
  const res = await fetch(`${bridgeUrl}/vapid-public-key`, {
    method: 'GET',
    headers: { Accept: 'application/json, text/plain' },
  })
  if (!res.ok) {
    throw new Error(`Push bridge returned HTTP ${res.status} for /vapid-public-key.`)
  }
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const data = (await res.json()) as {
      publicKey?: string
      vapidPublicKey?: string
    }
    const key = (data.publicKey || data.vapidPublicKey || '').trim()
    if (!key) throw new Error('Push bridge returned an empty VAPID public key.')
    return key
  }
  const text = (await res.text()).trim()
  if (!text) throw new Error('Push bridge returned an empty VAPID public key.')
  return text
}

export interface PushBridgeRegisterParams {
  bridgeUrl: string
  vapidPublicKey?: string
  pubkey: string
  aliasPubkeys?: string[]
  relays: string[]
  geohashes: string[]
  serverIds: string[]
  settings: NotificationSettings
  signEvent: (tmpl: EventTemplate) => Promise<VerifiedEvent>
}

async function waitForActiveSwRegistration(
  timeoutMs = 8000
): Promise<ServiceWorkerRegistration | null> {
  const existing = await getPwaSwRegistration()
  if (existing?.active && existing.pushManager) {
    return existing
  }
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return existing?.pushManager ? existing : null
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const ready = await Promise.race<ServiceWorkerRegistration | null>([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => {
        timer = globalThis.setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
    if (ready?.pushManager) return ready
  } catch {
    // Fall through to any available registration
  } finally {
    if (timer !== null) {
      globalThis.clearTimeout(timer)
    }
  }

  const fallback = existing ?? (await getPwaSwRegistration())
  return fallback?.pushManager ? fallback : null
}

export async function registerWithPushBridge(
  params: PushBridgeRegisterParams
): Promise<{ endpoint: string; vapidPublicKey: string }> {
  if (!isWebPushSupported()) {
    throw new Error('Web Push (PushManager) is unavailable in this browser.')
  }
  const reg = await waitForActiveSwRegistration(8000)
  if (!reg || !reg.pushManager) {
    throw new Error('Service Worker is not active yet. Reload once and retry.')
  }

  const normalizedBridge =
    normalizePushBridgeUrl(params.bridgeUrl) ||
    params.bridgeUrl.trim().replace(/\/+$/, '')

  const resolvedKey =
    params.vapidPublicKey?.trim() ||
    (await fetchVapidPublicKey(normalizedBridge))

  let subscription = await reg.pushManager.getSubscription()
  if (subscription) {
    const existingKeyBuf = subscription.options?.applicationServerKey
    if (existingKeyBuf) {
      const existingKeyB64 = arrayBufferToBase64Url(existingKeyBuf)
      if (existingKeyB64 !== normalizeBase64Url(resolvedKey)) {
        try {
          await subscription.unsubscribe()
        } catch {
          // Proceed to create a fresh subscription with the new VAPID key
        }
        subscription = null
      }
    }
  }
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(resolvedKey),
    })
  }

  const normalizedPubkey = params.pubkey.toLowerCase()
  const aliasPubkeys = Array.from(
    new Set(
      (params.aliasPubkeys ?? [])
        .map((pk) => pk.trim().toLowerCase())
        .filter((pk) => /^[0-9a-f]{64}$/.test(pk) && pk !== normalizedPubkey)
    )
  ).slice(0, 16)

  const endpointUrl = `${normalizedBridge}/subscribe`
  const bodyObj = {
    pubkey: normalizedPubkey,
    aliasPubkeys,
    subscription: subscription.toJSON(),
    relays: params.relays.slice(0, 12),
    geohashes: params.geohashes.slice(0, 12),
    serverIds: params.serverIds.slice(0, 20),
    preferences: {
      dms: params.settings.dms,
      agmail: params.settings.agmail,
      agmailCcBcc: params.settings.agmailCcBcc,
      directPings: params.settings.directPings,
      dmCallRinging: params.settings.dmCallRinging,
      serverMessages: params.settings.serverMessages,
      serverCalls: params.settings.serverCalls,
      geoMessages: params.settings.geoMessages,
      agoraRepliesMentions: params.settings.agoraRepliesMentions,
      agoraReactionsReposts: params.settings.agoraReactionsReposts,
      agoraZaps: params.settings.agoraZaps,
      agoraFollows: params.settings.agoraFollows,
      showPreviews: params.settings.showPreviews,
    },
  }
  const bodyJson = JSON.stringify(bodyObj)
  const authHeader = await buildNip98AuthHeader({
    url: endpointUrl,
    method: 'POST',
    bodyJson,
    signEvent: params.signEvent,
  })

  const res = await fetch(endpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: bodyJson,
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(
      `Push bridge registration failed (HTTP ${res.status})${errText ? `: ${errText.slice(0, 120)}` : ''}`
    )
  }

  return { endpoint: subscription.endpoint, vapidPublicKey: resolvedKey }
}

export async function unregisterFromPushBridge(opts: {
  bridgeUrl?: string
  pubkey: string
  signEvent: (tmpl: EventTemplate) => Promise<VerifiedEvent>
}): Promise<void> {
  const reg = await getPwaSwRegistration()
  const sub = reg?.pushManager ? await reg.pushManager.getSubscription() : null
  const endpoint = sub?.endpoint ?? null

  if (opts.bridgeUrl && endpoint) {
    const normalized = normalizePushBridgeUrl(opts.bridgeUrl)
    if (normalized) {
      try {
        const endpointUrl = `${normalized}/subscribe`
        const bodyJson = JSON.stringify({
          pubkey: opts.pubkey.toLowerCase(),
          endpoint,
        })
        const authHeader = await buildNip98AuthHeader({
          url: endpointUrl,
          method: 'DELETE',
          bodyJson,
          signEvent: opts.signEvent,
        })
        await fetch(endpointUrl, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader,
          },
          body: bodyJson,
        })
      } catch {
        // Proceed with local PushManager unsubscribe even if bridge is unreachable
      }
    }
  }

  if (sub) {
    try {
      await sub.unsubscribe()
    } catch {
      // Ignore
    }
  }
}

export async function sendTestWebPush(opts: {
  bridgeUrl: string
  pubkey: string
  signEvent: (tmpl: EventTemplate) => Promise<VerifiedEvent>
}): Promise<{ ok: boolean; delivered: number; failed: number; status?: number; detail: string }> {
  const normalized = normalizePushBridgeUrl(opts.bridgeUrl)
  if (!normalized) {
    return {
      ok: false,
      delivered: 0,
      failed: 0,
      detail: 'Push bridge URL must use https:// (or http://localhost).',
    }
  }

  const endpointUrl = `${normalized}/test-push`
  const bodyJson = JSON.stringify({
    pubkey: opts.pubkey.toLowerCase(),
  })

  const controller = new AbortController()
  const timeoutId = globalThis.setTimeout(() => controller.abort(), 12000)

  try {
    const authHeader = await buildNip98AuthHeader({
      url: endpointUrl,
      method: 'POST',
      bodyJson,
      signEvent: opts.signEvent,
    })

    const res = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: bodyJson,
      signal: controller.signal,
    })

    const rawText = await res.text().catch(() => '')
    let parsed: {
      ok?: boolean
      delivered?: number
      failed?: number
      error?: string
      detail?: string
    } | null = null
    if (rawText) {
      try {
        parsed = JSON.parse(rawText) as {
          ok?: boolean
          delivered?: number
          failed?: number
          error?: string
          detail?: string
        }
      } catch {
        parsed = null
      }
    }

    const delivered =
      typeof parsed?.delivered === 'number' ? parsed.delivered : 0
    const failed = typeof parsed?.failed === 'number' ? parsed.failed : 0

    if (!res.ok) {
      const errDetail =
        parsed?.error ||
        parsed?.detail ||
        rawText.slice(0, 120) ||
        `HTTP ${res.status}`
      return {
        ok: false,
        delivered,
        failed,
        status: res.status,
        detail: `Test push failed (HTTP ${res.status}): ${errDetail}`,
      }
    }

    if (delivered > 0) {
      return {
        ok: true,
        delivered,
        failed,
        status: res.status,
        detail: `Background push delivered to ${delivered} device${delivered === 1 ? '' : 's'}${failed > 0 ? ` (${failed} failed)` : ''}.`,
      }
    }

    return {
      ok: false,
      delivered,
      failed,
      status: res.status,
      detail:
        parsed?.error ||
        parsed?.detail ||
        (failed > 0
          ? `Push bridge could not reach ${failed} registered device${failed === 1 ? '' : 's'}. Reconnect this device and retry.`
          : 'No active push subscription registered on bridge yet.'),
    }
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : 'Unable to reach push bridge.'
    return {
      ok: false,
      delivered: 0,
      failed: 0,
      detail: `Test push error: ${msg}`,
    }
  } finally {
    globalThis.clearTimeout(timeoutId)
  }
}

export async function sendPushPoke(opts: {
  bridgeUrl: string
  signEvent: (tmpl: EventTemplate) => Promise<VerifiedEvent>
  payload: PushPokePayload
}): Promise<void> {
  const normalized = normalizePushBridgeUrl(opts.bridgeUrl)
  if (!normalized) return

  const recipientPubkeys = Array.from(
    new Set(
      (opts.payload.recipientPubkeys || [])
        .map((pk) => pk.trim().toLowerCase())
        .filter((pk) => /^[0-9a-f]{64}$/.test(pk))
    )
  ).slice(0, 20)
  if (recipientPubkeys.length === 0) return

  const endpointUrl = `${normalized}/poke`
  const bodyJson = JSON.stringify({
    ...opts.payload,
    recipientPubkeys,
  })

  const controller = new AbortController()
  const timeoutId = globalThis.setTimeout(() => controller.abort(), 5000)

  try {
    const authHeader = await buildNip98AuthHeader({
      url: endpointUrl,
      method: 'POST',
      bodyJson,
      signEvent: opts.signEvent,
    })

    await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: bodyJson,
      signal: controller.signal,
      keepalive: true,
    })
  } catch {
    // Fire-and-forget: never block or fail sending messages on push poke errors
  } finally {
    globalThis.clearTimeout(timeoutId)
  }
}
