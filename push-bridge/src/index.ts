import { verifyNip98Request } from './nip98.ts'
import { runNostrPushCron } from './nostrCron.ts'
import {
  DEFAULT_PUSH_PREFERENCES,
  MAX_DEVICES_PER_PUBKEY,
  PUBKEYS_INDEX_KEY,
  subKeyForPubkey,
  type Env,
  type IncomingPushPayload,
  type PokeCategory,
  type StoredDeviceSubscription,
  type StoredPushPreferences,
  type StoredUserRecord,
  type WebPushSubscriptionJSON,
} from './types.ts'
import { sendWebPushNotification, sha256Hex } from './webpush.ts'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  })
}

function isHex64(val: unknown): val is string {
  return typeof val === 'string' && /^[0-9a-f]{64}$/i.test(val)
}

function normalizeStringList(raw: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const clean = item.trim().slice(0, maxLen)
    if (clean && !out.includes(clean)) {
      out.push(clean)
      if (out.length >= maxItems) break
    }
  }
  return out
}

function normalizePreferences(raw: unknown): StoredPushPreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PUSH_PREFERENCES }
  const obj = raw as Partial<StoredPushPreferences>
  return {
    dms: typeof obj.dms === 'boolean' ? obj.dms : DEFAULT_PUSH_PREFERENCES.dms,
    directPings:
      typeof obj.directPings === 'boolean' ? obj.directPings : DEFAULT_PUSH_PREFERENCES.directPings,
    dmCallRinging:
      typeof obj.dmCallRinging === 'boolean'
        ? obj.dmCallRinging
        : DEFAULT_PUSH_PREFERENCES.dmCallRinging,
    serverMessages:
      typeof obj.serverMessages === 'boolean'
        ? obj.serverMessages
        : DEFAULT_PUSH_PREFERENCES.serverMessages,
    serverCalls:
      typeof obj.serverCalls === 'boolean' ? obj.serverCalls : DEFAULT_PUSH_PREFERENCES.serverCalls,
    geoMessages:
      typeof obj.geoMessages === 'boolean' ? obj.geoMessages : DEFAULT_PUSH_PREFERENCES.geoMessages,
    showPreviews:
      typeof obj.showPreviews === 'boolean'
        ? obj.showPreviews
        : DEFAULT_PUSH_PREFERENCES.showPreviews,
  }
}

function validateSubscription(raw: unknown): WebPushSubscriptionJSON | null {
  if (!raw || typeof raw !== 'object') return null
  const sub = raw as Partial<WebPushSubscriptionJSON>
  if (typeof sub.endpoint !== 'string' || !/^https:\/\//i.test(sub.endpoint.trim())) {
    return null
  }
  if (
    !sub.keys ||
    typeof sub.keys !== 'object' ||
    typeof sub.keys.p256dh !== 'string' ||
    sub.keys.p256dh.trim().length < 40 ||
    typeof sub.keys.auth !== 'string' ||
    sub.keys.auth.trim().length < 16
  ) {
    return null
  }
  return {
    endpoint: sub.endpoint.trim(),
    expirationTime: typeof sub.expirationTime === 'number' ? sub.expirationTime : null,
    keys: {
      p256dh: sub.keys.p256dh.trim(),
      auth: sub.keys.auth.trim(),
    },
  }
}

async function readPubkeysIndex(kv: KVNamespace): Promise<string[]> {
  const raw = await kv.get(PUBKEYS_INDEX_KEY, 'json')
  if (!Array.isArray(raw)) return []
  return Array.from(
    new Set(
      raw
        .filter((x): x is string => isHex64(x))
        .map((x) => x.toLowerCase())
    )
  )
}

async function addPubkeyToIndex(kv: KVNamespace, pubkey: string): Promise<void> {
  const pk = pubkey.toLowerCase()
  const list = await readPubkeysIndex(kv)
  if (list.includes(pk)) return
  list.push(pk)
  await kv.put(PUBKEYS_INDEX_KEY, JSON.stringify(list))
}

async function removePubkeyFromIndex(kv: KVNamespace, pubkey: string): Promise<void> {
  const pk = pubkey.toLowerCase()
  const list = await readPubkeysIndex(kv)
  if (!list.includes(pk)) return
  const next = list.filter((x) => x !== pk)
  await kv.put(PUBKEYS_INDEX_KEY, JSON.stringify(next))
}

async function handlePostSubscribe(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text()
  const auth = await verifyNip98Request(request, rawBody)
  if (!auth.ok) return jsonResponse({ ok: false, error: auth.error }, auth.status)

  let body: {
    pubkey?: unknown
    subscription?: unknown
    relays?: unknown
    geohashes?: unknown
    serverIds?: unknown
    preferences?: unknown
  }
  try {
    body = JSON.parse(rawBody) as typeof body
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON body.' }, 400)
  }

  if (!isHex64(body.pubkey) || body.pubkey.toLowerCase() !== auth.pubkey) {
    return jsonResponse({ ok: false, error: 'Pubkey mismatch with NIP-98 signer.' }, 403)
  }

  const subscription = validateSubscription(body.subscription)
  if (!subscription) {
    return jsonResponse({ ok: false, error: 'Invalid Web Push subscription payload.' }, 400)
  }

  const endpointHash = (await sha256Hex(subscription.endpoint)).slice(0, 24)
  const now = Date.now()
  const device: StoredDeviceSubscription = {
    endpointHash,
    subscription,
    relays: normalizeStringList(body.relays, 12, 160),
    geohashes: normalizeStringList(body.geohashes, 12, 32),
    serverIds: normalizeStringList(body.serverIds, 20, 96),
    preferences: normalizePreferences(body.preferences),
    updatedAt: now,
  }

  const key = subKeyForPubkey(auth.pubkey)
  const existing = (await env.PUSH_KV.get(key, 'json')) as StoredUserRecord | null
  const priorDevices = Array.isArray(existing?.devices) ? existing.devices : []
  const merged = priorDevices.filter(
    (d) => d.endpointHash !== endpointHash && d.subscription?.endpoint !== subscription.endpoint
  )
  merged.push(device)
  // Keep up to MAX_DEVICES_PER_PUBKEY most recently updated devices
  merged.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
  const capped = merged.slice(-MAX_DEVICES_PER_PUBKEY)

  const record: StoredUserRecord = {
    pubkey: auth.pubkey,
    devices: capped,
    updatedAt: now,
  }
  await env.PUSH_KV.put(key, JSON.stringify(record))
  await addPubkeyToIndex(env.PUSH_KV, auth.pubkey)

  return jsonResponse({ ok: true, devices: capped.length })
}

async function handleDeleteSubscribe(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text()
  const auth = await verifyNip98Request(request, rawBody)
  if (!auth.ok) return jsonResponse({ ok: false, error: auth.error }, auth.status)

  let body: { pubkey?: unknown; endpoint?: unknown }
  try {
    body = JSON.parse(rawBody) as typeof body
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON body.' }, 400)
  }

  if (!isHex64(body.pubkey) || body.pubkey.toLowerCase() !== auth.pubkey) {
    return jsonResponse({ ok: false, error: 'Pubkey mismatch with NIP-98 signer.' }, 403)
  }

  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : ''
  const key = subKeyForPubkey(auth.pubkey)
  const existing = (await env.PUSH_KV.get(key, 'json')) as StoredUserRecord | null

  if (!existing || !Array.isArray(existing.devices) || existing.devices.length === 0) {
    await removePubkeyFromIndex(env.PUSH_KV, auth.pubkey)
    return jsonResponse({ ok: true, devices: 0 })
  }

  const remaining = endpoint
    ? existing.devices.filter((d) => d.subscription?.endpoint !== endpoint)
    : []

  if (remaining.length === 0) {
    await env.PUSH_KV.delete(key)
    await removePubkeyFromIndex(env.PUSH_KV, auth.pubkey)
  } else {
    await env.PUSH_KV.put(
      key,
      JSON.stringify({
        pubkey: auth.pubkey,
        devices: remaining,
        updatedAt: Date.now(),
      } satisfies StoredUserRecord)
    )
  }

  return jsonResponse({ ok: true, devices: remaining.length })
}

async function handleTestPush(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text()
  const auth = await verifyNip98Request(request, rawBody)
  if (!auth.ok) return jsonResponse({ ok: false, error: auth.error }, auth.status)

  if (rawBody.trim()) {
    let body: { pubkey?: unknown }
    try {
      body = JSON.parse(rawBody) as { pubkey?: unknown }
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON body.' }, 400)
    }
    if (body.pubkey !== undefined && (!isHex64(body.pubkey) || body.pubkey.toLowerCase() !== auth.pubkey)) {
      return jsonResponse({ ok: false, error: 'Pubkey mismatch with NIP-98 signer.' }, 403)
    }
  }

  const key = subKeyForPubkey(auth.pubkey)
  const record = (await env.PUSH_KV.get(key, 'json')) as StoredUserRecord | null
  if (!record || !Array.isArray(record.devices) || record.devices.length === 0) {
    return jsonResponse({ ok: false, error: 'No registered push devices for this pubkey.' }, 404)
  }

  const payload: IncomingPushPayload = {
    title: 'Agnostr Push Active',
    body: 'Background push notifications are connected on this device.',
    tag: 'agnostr-test-push',
    forceShow: true,
    data: {
      category: 'test',
      tag: 'agnostr-test-push',
    },
  }

  const results: Array<{ status: number; ok: boolean; expired: boolean; error?: string }> = []
  const surviving: StoredDeviceSubscription[] = []
  let delivered = 0
  let failed = 0
  let pruned = false

  for (const dev of record.devices) {
    const res = await sendWebPushNotification({
      subscription: dev.subscription,
      payload,
      vapidPublicKey: env.VAPID_PUBLIC_KEY,
      vapidPrivateKey: env.VAPID_PRIVATE_KEY,
      vapidSubject: env.VAPID_SUBJECT,
      ttlSeconds: 300,
      urgency: 'high',
    })
    results.push({ status: res.status, ok: res.ok, expired: res.expired, error: res.error })
    if (res.ok) delivered += 1
    else failed += 1
    if (res.expired) pruned = true
    else surviving.push(dev)
  }

  if (pruned) {
    if (surviving.length === 0) {
      await env.PUSH_KV.delete(key)
      await removePubkeyFromIndex(env.PUSH_KV, auth.pubkey)
    } else {
      await env.PUSH_KV.put(
        key,
        JSON.stringify({
          pubkey: auth.pubkey,
          devices: surviving,
          updatedAt: Date.now(),
        } satisfies StoredUserRecord)
      )
    }
  }

  return jsonResponse({
    ok: delivered > 0,
    delivered,
    failed,
    results,
  })
}

interface PokeRequestBody {
  recipientPubkeys?: unknown
  category?: unknown
  eventId?: unknown
  callId?: unknown
  mediaType?: unknown
  serverId?: unknown
  channelId?: unknown
  geohash?: unknown
  senderName?: unknown
  preview?: unknown
}

const VALID_POKE_CATEGORIES = new Set<PokeCategory>([
  'dm',
  'dm-call',
  'server-message',
  'server-call',
  'geo-message',
  'geo-call',
  'agmail',
  'call-cancel',
])

function isPokeAllowedByPreferences(
  category: PokeCategory,
  prefs: StoredPushPreferences
): boolean {
  switch (category) {
    case 'dm':
    case 'agmail':
      return prefs.dms
    case 'dm-call':
    case 'call-cancel':
      return prefs.dmCallRinging
    case 'server-message':
      return prefs.serverMessages || prefs.directPings
    case 'server-call':
      return prefs.serverCalls
    case 'geo-message':
      return prefs.geoMessages || prefs.directPings
    case 'geo-call':
      return prefs.serverCalls || prefs.dmCallRinging || prefs.geoMessages
    case 'test':
      return true
  }
}

function buildPokePayload(opts: {
  category: PokeCategory
  senderPubkey: string
  senderName?: string
  preview?: string
  callId?: string
  mediaType?: 'audio' | 'video'
  serverId?: string
  channelId?: string
  geohash?: string
  showPreviews: boolean
}): IncomingPushPayload {
  const { category, senderPubkey, callId, mediaType, serverId, channelId, geohash, showPreviews } =
    opts
  const safeSender = showPreviews && opts.senderName ? opts.senderName.trim().slice(0, 48) : ''
  const safePreview = showPreviews && opts.preview ? opts.preview.trim().replace(/\s+/g, ' ').slice(0, 120) : ''

  if (category === 'call-cancel') {
    return {
      action: 'call-cancel',
      type: 'call-cancel',
      callId,
      data: {
        category: 'dm-call',
        callId,
        peerPubkey: senderPubkey,
      },
    }
  }

  if (category === 'dm-call') {
    const kindWord = mediaType === 'video' ? 'video' : 'voice'
    return {
      title: safeSender ? `Incoming ${kindWord} call · ${safeSender}` : `Incoming ${kindWord} call`,
      body: `Incoming ${kindWord} call · Tap to accept`,
      tag: callId ? `agnostr-call-${callId}` : 'agnostr-call',
      callId,
      data: {
        category: 'dm-call',
        callId,
        mediaType: mediaType ?? 'audio',
        peerPubkey: senderPubkey,
        callerNickname: safeSender || undefined,
      },
    }
  }

  if (category === 'server-call') {
    return {
      title: safeSender ? `${safeSender} started a server call` : 'Server Call Active',
      body: safePreview || 'Tap to join the call.',
      tag: serverId ? `agnostr-srvcall-${serverId.slice(0, 12)}` : 'agnostr-srvcall',
      callId,
      data: {
        category: 'server-call',
        callId,
        mediaType: mediaType ?? 'audio',
        serverId,
        channelId,
        peerPubkey: senderPubkey,
        callerNickname: safeSender || undefined,
      },
    }
  }

  if (category === 'geo-call') {
    return {
      title: safeSender
        ? `${safeSender} started a call${geohash ? ` in #${geohash}` : ''}`
        : 'Radio Call Active',
      body: safePreview || 'Tap to join the call.',
      tag: geohash ? `agnostr-geocall-${geohash}` : 'agnostr-geocall',
      callId,
      data: {
        category: 'geo-call',
        callId,
        mediaType: mediaType ?? 'audio',
        geohash,
        peerPubkey: senderPubkey,
        callerNickname: safeSender || undefined,
      },
    }
  }

  if (category === 'agmail') {
    return {
      title: safeSender ? `New Agmail from ${safeSender}` : 'New Agmail',
      body: safePreview || 'You received a new encrypted message in Agmail.',
      tag: `agnostr-mail-${senderPubkey.slice(0, 12)}`,
      data: {
        category: 'agmail',
        peerPubkey: senderPubkey,
      },
    }
  }

  if (category === 'server-message') {
    return {
      title: safeSender ? `${safeSender}` : 'New Server Message',
      body: safePreview || 'New message in one of your servers.',
      tag: serverId ? `agnostr-srv-${serverId.slice(0, 12)}` : 'agnostr-srv',
      data: {
        category: 'server-message',
        serverId,
        channelId,
        peerPubkey: senderPubkey,
      },
    }
  }

  if (category === 'geo-message') {
    return {
      title: safeSender
        ? geohash
          ? `${safeSender} in #${geohash}`
          : safeSender
        : 'New Radio Message',
      body: safePreview || 'New message on Agnostr.',
      tag: geohash ? `agnostr-geo-${geohash}` : 'agnostr-geo',
      data: {
        category: 'geo-message',
        geohash,
        peerPubkey: senderPubkey,
      },
    }
  }

  // Default: 'dm'
  return {
    title: safeSender ? `${safeSender}` : 'New encrypted message',
    body: safePreview || 'Open Agnostr to read your private message.',
    tag: `agnostr-dm-${senderPubkey.slice(0, 12)}`,
    data: {
      category: 'dm',
      peerPubkey: senderPubkey,
    },
  }
}

async function isDuplicateEventInCache(eventId: string, category: string): Promise<boolean> {
  try {
    const cache = caches.default
    const cacheKey = new Request(
      `https://agnostr-push.internal/dedupe/${encodeURIComponent(category)}/${encodeURIComponent(eventId)}`
    )
    const hit = await cache.match(cacheKey)
    if (hit) return true
    await cache.put(
      cacheKey,
      new Response('1', {
        headers: { 'Cache-Control': 'max-age=180' },
      })
    )
    return false
  } catch {
    return false
  }
}

async function handlePoke(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text()
  const auth = await verifyNip98Request(request, rawBody)
  if (!auth.ok) return jsonResponse({ ok: false, error: auth.error }, auth.status)

  let body: PokeRequestBody
  try {
    body = JSON.parse(rawBody) as PokeRequestBody
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON body.' }, 400)
  }

  const category = typeof body.category === 'string' ? (body.category.trim() as PokeCategory) : null
  if (!category || !VALID_POKE_CATEGORIES.has(category)) {
    return jsonResponse({ ok: false, error: 'Invalid poke category.' }, 400)
  }

  if (!Array.isArray(body.recipientPubkeys) || body.recipientPubkeys.length === 0) {
    return jsonResponse({ ok: false, error: 'recipientPubkeys must be a non-empty array.' }, 400)
  }

  const recipients = Array.from(
    new Set(
      body.recipientPubkeys
        .filter((x): x is string => isHex64(x))
        .map((x) => x.toLowerCase())
    )
  ).slice(0, 10)

  // Block self-poke spam (allow self-mail in Agmail only)
  const filteredRecipients = recipients.filter(
    (pk) => category === 'agmail' || pk !== auth.pubkey
  )

  if (filteredRecipients.length === 0) {
    return jsonResponse({ ok: true, delivered: 0, skipped: recipients.length, failed: 0 })
  }

  const eventId = typeof body.eventId === 'string' ? body.eventId.trim().slice(0, 96) : ''
  if (eventId) {
    const dup = await isDuplicateEventInCache(eventId, category)
    if (dup) {
      return jsonResponse({ ok: true, deduplicated: true, delivered: 0, skipped: filteredRecipients.length, failed: 0 })
    }
  }

  const callId = typeof body.callId === 'string' ? body.callId.trim().slice(0, 64) : undefined
  const mediaType = body.mediaType === 'video' ? 'video' : body.mediaType === 'audio' ? 'audio' : undefined
  const serverId = typeof body.serverId === 'string' ? body.serverId.trim().slice(0, 96) : undefined
  const channelId = typeof body.channelId === 'string' ? body.channelId.trim().slice(0, 96) : undefined
  const geohash = typeof body.geohash === 'string' ? body.geohash.trim().slice(0, 32) : undefined
  const senderName = typeof body.senderName === 'string' ? body.senderName.trim().slice(0, 48) : undefined
  const preview = typeof body.preview === 'string' ? body.preview.trim().slice(0, 140) : undefined

  const isCall = category === 'dm-call' || category === 'server-call' || category === 'geo-call' || category === 'call-cancel'
  const ttlSeconds = isCall ? 60 : 86_400
  const topic = callId && (category === 'dm-call' || category === 'call-cancel')
    ? `call-${callId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)}`
    : undefined

  let delivered = 0
  let skipped = 0
  let failed = 0

  for (const recipientPk of filteredRecipients) {
    const key = subKeyForPubkey(recipientPk)
    const record = (await env.PUSH_KV.get(key, 'json')) as StoredUserRecord | null
    if (!record || !Array.isArray(record.devices) || record.devices.length === 0) {
      skipped += 1
      continue
    }

    const surviving: StoredDeviceSubscription[] = []
    let pruned = false

    for (const dev of record.devices) {
      if (!isPokeAllowedByPreferences(category, dev.preferences)) {
        skipped += 1
        surviving.push(dev)
        continue
      }

      const payload = buildPokePayload({
        category,
        senderPubkey: auth.pubkey,
        senderName,
        preview,
        callId,
        mediaType,
        serverId,
        channelId,
        geohash,
        showPreviews: dev.preferences.showPreviews !== false,
      })

      const res = await sendWebPushNotification({
        subscription: dev.subscription,
        payload,
        vapidPublicKey: env.VAPID_PUBLIC_KEY,
        vapidPrivateKey: env.VAPID_PRIVATE_KEY,
        vapidSubject: env.VAPID_SUBJECT,
        ttlSeconds,
        urgency: 'high',
        topic,
      })

      if (res.ok) delivered += 1
      else failed += 1

      if (res.expired) pruned = true
      else surviving.push(dev)
    }

    if (pruned) {
      if (surviving.length === 0) {
        await env.PUSH_KV.delete(key)
        await removePubkeyFromIndex(env.PUSH_KV, recipientPk)
      } else {
        await env.PUSH_KV.put(
          key,
          JSON.stringify({
            pubkey: recipientPk,
            devices: surviving,
            updatedAt: Date.now(),
          } satisfies StoredUserRecord)
        )
      }
    }
  }

  return jsonResponse({ ok: true, delivered, skipped, failed })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const url = new URL(request.url)
    const pathname = url.pathname.replace(/\/+$/, '') || '/'

    if (request.method === 'GET' && pathname === '/health') {
      return jsonResponse({ ok: true, service: 'agnostr-push', version: 1 })
    }

    if (request.method === 'GET' && pathname === '/vapid-public-key') {
      return jsonResponse({ publicKey: env.VAPID_PUBLIC_KEY })
    }

    if (request.method === 'POST' && pathname === '/subscribe') {
      return await handlePostSubscribe(request, env)
    }

    if (request.method === 'DELETE' && pathname === '/subscribe') {
      return await handleDeleteSubscribe(request, env)
    }

    if (request.method === 'POST' && pathname === '/test-push') {
      return await handleTestPush(request, env)
    }

    if (request.method === 'POST' && pathname === '/poke') {
      return await handlePoke(request, env)
    }

    return jsonResponse({ ok: false, error: 'Not found' }, 404)
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runNostrPushCron(env))
  },
} satisfies ExportedHandler<Env>
