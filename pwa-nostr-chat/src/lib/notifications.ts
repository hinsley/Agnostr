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
import { isNativeAndroidBuild } from './appPlatform.ts'
import { bytesToHex } from './identity.ts'
import { normalizeBitchatChannelKey } from './bitchatChannel.ts'
import { findDisplayedPush } from './pushDisplay.ts'

export const KIND_NIP98_HTTP_AUTH = 27235
const APP_ICON = '/icon-192.png'
const utf8Encoder = new TextEncoder()

interface ExtendedNotificationOptions extends NotificationOptions {
  renotify?: boolean
  vibrate?: number[]
  actions?: Array<{ action: string; title: string; icon?: string }>
}

export function getBrowserNotificationPermission(): NotificationPermissionState {
  if (isNativeAndroidBuild) return 'unsupported'
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
  if (isNativeAndroidBuild) return false
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
  if (isNativeAndroidBuild) return 'unsupported'
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
    // The worker may already have shown this exact delivery. If either of the
    // verified IDs is missing, a room/channel notification is not enough proof.
    if (await findDisplayedPush(reg, input.data)) return true
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

const PUSH_REQUEST_TIMEOUT_MS = 8_000

async function fetchPushRequest(
  url: string,
  init: RequestInit,
  timeoutMs = PUSH_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    // Keep the deadline through reading the reply; a response can stall after
    // returning only HTTP headers.
    const body = await response.text()
    return new Response(body || null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } finally {
    globalThis.clearTimeout(timer)
  }
}

export async function readCurrentPushEndpoint(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  const reg = await navigator.serviceWorker.getRegistration()
  const subscription = await reg?.pushManager?.getSubscription()
  return subscriptionIsCurrent(subscription) ? subscription?.endpoint ?? null : null
}

function subscriptionIsCurrent(subscription: PushSubscription | null | undefined): boolean {
  const expiry = subscription?.expirationTime
  return Boolean(subscription?.endpoint) && (expiry == null || expiry > Date.now())
}

export async function fetchVapidPublicKey(bridgeUrl: string): Promise<string> {
  const res = await fetchPushRequest(`${bridgeUrl}/vapid-public-key`, {
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

export function canUsePublicPinnedRoomFallback(opts: {
  canAutoSign: boolean
  geoMessages: NotificationSettings['geoMessages']
  hasBlockedPeers: boolean
  strictWhitelistMode: boolean
  pinnedGeohashes: readonly string[]
}): boolean {
  return opts.canAutoSign && opts.geoMessages === 'all' && !opts.hasBlockedPeers &&
    !opts.strictWhitelistMode && opts.pinnedGeohashes.some((room) =>
      normalizeBitchatChannelKey(room) !== null)
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
  publicPinnedRoomFallback?: boolean
  replaceSubscription?: boolean
  signEvent: (tmpl: EventTemplate) => Promise<VerifiedEvent>
}

async function waitForActiveSwRegistration(
  timeoutMs = 8000
): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  const existing = await navigator.serviceWorker.getRegistration()
  if (existing?.active && existing.pushManager) {
    return existing
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

  const fallback = await navigator.serviceWorker.getRegistration()
  return fallback?.active && fallback.pushManager ? fallback : null
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

  const keyBytes = urlBase64ToUint8Array(resolvedKey)
  if (keyBytes.length !== 65 || keyBytes[0] !== 4) {
    throw new Error('The push bridge did not provide a valid VAPID public key.')
  }
  let subscription = await reg.pushManager.getSubscription()
  if (subscription) {
    const existingKey = subscription.options?.applicationServerKey
    const changedKey =
      existingKey != null &&
      arrayBufferToBase64Url(existingKey) !== normalizeBase64Url(resolvedKey)
    if (params.replaceSubscription || !subscriptionIsCurrent(subscription) || changedKey) {
      await subscription.unsubscribe()
      const remaining = await reg.pushManager.getSubscription()
      if (remaining?.endpoint === subscription.endpoint) {
        throw new Error('Could not replace this browser’s stale push subscription.')
      }
      subscription = remaining
    }
  }
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes,
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

  const geohashes = Array.from(new Set(params.geohashes.map(normalizeBitchatChannelKey)
    .filter((key): key is string => key !== null))).slice(0, 12)
  const endpointUrl = `${normalizedBridge}/subscribe`
  const bodyObj = {
    pubkey: normalizedPubkey,
    aliasPubkeys,
    subscription: subscription.toJSON(),
    relays: params.relays.slice(0, 12),
    geohashes,
    publicPinnedRoomFallback: params.publicPinnedRoomFallback === true &&
      params.settings.publicPinnedRoomFallback && params.settings.geoMessages === 'all' &&
      geohashes.length > 0,
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

  const res = await fetchPushRequest(endpointUrl, {
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
  skipBridgeCleanup?: boolean
  signEvent: (tmpl: EventTemplate) => Promise<VerifiedEvent>
}): Promise<void> {
  const reg = await getPwaSwRegistration()
  const sub = reg?.pushManager ? await reg.pushManager.getSubscription() : null
  const endpoint = sub?.endpoint ?? null

  if (sub) {
    try {
      await sub.unsubscribe()
    } catch {
      // Ignore
    }
  }
  if (!opts.skipBridgeCleanup && opts.bridgeUrl && endpoint) {
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
        await fetchPushRequest(endpointUrl, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader,
          },
          body: bodyJson,
        })
      } catch {
        // Local delivery was disabled first. Remote cleanup is best effort.
      }
    }
  }
}

type PushTestResult = {
  ok: boolean
  delivered: number
  failed: number
  status?: number
  detail: string
}

function randomPushRequestId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
}

function listenForPushTestReceipt(testId: string, timeoutMs: number): {
  receipt: Promise<'displayed' | 'display-failed' | 'timed-out'>
  cancel: () => void
} {
  const workers = navigator.serviceWorker
  let resolve: (value: 'displayed' | 'display-failed' | 'timed-out') => void = () => {}
  const receipt = new Promise<'displayed' | 'display-failed' | 'timed-out'>(
    (done) => { resolve = done }
  )
  const receive = (event: MessageEvent) => {
    if (event.data?.type !== 'agnostr:push-test-receipt' || event.data.testId !== testId) return
    if (typeof event.data.displayed !== 'boolean') return
    finish(event.data.displayed ? 'displayed' : 'display-failed')
  }
  const timer = globalThis.setTimeout(() => finish('timed-out'), timeoutMs)
  function finish(value: 'displayed' | 'display-failed' | 'timed-out') {
    globalThis.clearTimeout(timer)
    workers.removeEventListener('message', receive)
    resolve(value)
  }
  workers.addEventListener('message', receive)
  return { receipt, cancel: () => finish('timed-out') }
}

export async function sendTestWebPush(opts: {
  bridgeUrl: string
  pubkey: string
  signEvent: (tmpl: EventTemplate) => Promise<VerifiedEvent>
  receiptTimeoutMs?: number
}): Promise<PushTestResult> {
  const failure = (detail: string, status?: number): PushTestResult =>
    ({ ok: false, delivered: 0, failed: 0, status, detail })
  const normalized = normalizePushBridgeUrl(opts.bridgeUrl)
  if (!normalized) return failure('Push bridge URL must use https:// (or http://localhost).')

  let listener: ReturnType<typeof listenForPushTestReceipt> | null = null
  try {
    const endpoint = await readCurrentPushEndpoint()
    if (!endpoint) return failure('This device has no current push subscription.', 404)
    // A legacy bridge ignores the endpoint field and sends its test to every
    // registered device. Do not POST to one, even if it would report success.
    const health = await fetchPushRequest(`${normalized}/health`, { cache: 'no-store' }, 5_000)
    const capabilities = await health.json().catch(() => null) as {
      ok?: boolean; service?: string; currentDeviceTest?: boolean
    } | null
    if (!health.ok || capabilities?.ok !== true || capabilities.service !== 'agnostr-push' ||
        capabilities.currentDeviceTest !== true) {
      return failure('This push bridge has not been updated to test only this device.', health.status)
    }
    const testId = randomPushRequestId()
    const endpointUrl = `${normalized}/test-push`
    const bodyJson = JSON.stringify({ pubkey: opts.pubkey.toLowerCase(), endpoint, testId })
    const authHeader = await buildNip98AuthHeader({
      url: endpointUrl,
      method: 'POST',
      bodyJson,
      signEvent: opts.signEvent,
    })

    // Subscribe before sending: the service worker may receive the test before
    // the HTTP response returns. A provider accepting a push is not a receipt.
    listener = listenForPushTestReceipt(testId, opts.receiptTimeoutMs ?? 15_000)
    const res = await fetchPushRequest(endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: bodyJson,
    }, 12_000)
    const parsed = await res.json().catch(() => null) as {
      accepted?: boolean
      testId?: string
      error?: string
      detail?: string
    } | null
    if (!res.ok) {
      return failure(
        `Test push failed (HTTP ${res.status}): ${parsed?.error || parsed?.detail || 'bridge rejected the request'}.`,
        res.status
      )
    }
    if (parsed?.accepted !== true || parsed.testId !== testId) {
      return failure(
        parsed?.error || parsed?.detail ||
          'The bridge did not confirm acceptance for this device. A custom bridge may need an update.',
        res.status
      )
    }

    const receipt = await listener.receipt
    if (receipt === 'displayed') {
      return { ok: true, delivered: 1, failed: 0, status: res.status,
        detail: 'This device’s service worker confirmed that the notification was displayed.' }
    }
    return failure(
      receipt === 'display-failed'
        ? 'The push reached this device, but the browser could not display it.'
        : 'The push provider accepted the test, but this device did not confirm display. Check notification settings and reload the app if it was just updated.',
      res.status
    )
  } catch (err) {
    return failure(`Test push error: ${err instanceof Error ? err.message : 'Unable to reach push bridge.'}`)
  } finally {
    listener?.cancel()
  }
}

export type PushPokeResult =
  | { kind: 'accepted' | 'skipped' }
  | { kind: 'failed'; detail: string }

export async function sendPushPoke(opts: {
  bridgeUrl: string
  signEvent: (tmpl: EventTemplate) => Promise<VerifiedEvent>
  payload: PushPokePayload
  retryDelaysMs?: readonly number[]
  shouldContinue?: () => boolean
}): Promise<PushPokeResult> {
  const normalized = normalizePushBridgeUrl(opts.bridgeUrl)
  if (!normalized || opts.shouldContinue?.() === false) return { kind: 'skipped' }

  const recipientPubkeys = Array.from(
    new Set(
      opts.payload.recipientPubkeys
        .map((pk) => pk.trim().toLowerCase())
        .filter((pk) => /^[0-9a-f]{64}$/.test(pk))
    )
  ).slice(0, 20)
  if (recipientPubkeys.length === 0) return { kind: 'skipped' }

  const endpointUrl = `${normalized}/poke`
  const bodyJson = JSON.stringify({
    ...opts.payload,
    // Some older callers don't have a message ID, e.g. a ring-cancel hint.
    // Make retries idempotent without using a timestamp to identify private messages.
    eventId: opts.payload.eventId || randomPushRequestId(),
    recipientPubkeys,
  })
  let authHeader: string
  try {
    authHeader = await buildNip98AuthHeader({
      url: endpointUrl,
      method: 'POST',
      bodyJson,
      signEvent: opts.signEvent,
    })
  } catch {
    return { kind: 'failed', detail: 'Push request was not signed.' }
  }

  // Build the signed request once; retries use the same body, auth and event ID,
  // and finish well within the bridge’s signed request freshness limit.
  const delays = opts.retryDelaysMs ?? [450, 1800]
  let detail = 'Unable to reach the push bridge.'
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (opts.shouldContinue?.() === false) return { kind: 'skipped' }
    try {
      const res = await fetchPushRequest(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authHeader },
        body: bodyJson,
        keepalive: true,
      }, 5_000)
      if (res.ok) {
        const data = await res.json().catch(() => null) as {
          ok?: boolean
          queued?: number
          delivered?: number
          duplicates?: number
          skipped?: number
          failed?: number
          permanentFailures?: number
          deduplicated?: boolean
        } | null
        if (data?.ok === true) {
          if ((data.queued ?? 0) > 0 || (data.delivered ?? 0) > 0 ||
              (data.duplicates ?? 0) > 0 || data.deduplicated === true) return { kind: 'accepted' }
          if ((data.permanentFailures ?? 0) > 0) {
            return { kind: 'failed', detail: 'Push delivery was permanently rejected.' }
          }
          if ((data.failed ?? 0) === 0 && (data.skipped ?? 0) > 0) return { kind: 'skipped' }
        }
        detail = 'The push bridge did not queue or accept the notification.'
      } else {
        detail = `Push bridge returned HTTP ${res.status}.`
        if (res.status !== 429 && res.status < 500) return { kind: 'failed', detail }
      }
    } catch {
      detail = 'Unable to reach the push bridge.'
    }
    if (attempt < delays.length) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delays[attempt]))
    }
  }
  return { kind: 'failed', detail }
}
