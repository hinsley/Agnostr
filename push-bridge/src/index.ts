import { verifyNip98Request } from './nip98.ts'
import { runNostrPushCron } from './nostrCron.ts'
import {
  aliasKeyForPubkey,
  DEFAULT_PUSH_PREFERENCES,
  MAX_ALIAS_PUBKEYS,
  MAX_DEVICES_PER_PUBKEY,
  PUBKEYS_INDEX_KEY,
  subKeyForPubkey,
  type Env,
  type IncomingPushPayload,
  type PokeCategory,
  type PushFilterMode,
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

function normalizeAliasPubkeys(raw: unknown, masterPubkey: string): string[] {
  if (!Array.isArray(raw)) return []
  const master = masterPubkey.toLowerCase()
  const out: string[] = []
  for (const item of raw) {
    if (!isHex64(item)) continue
    const clean = item.toLowerCase()
    if (clean === master || out.includes(clean)) continue
    out.push(clean)
    if (out.length >= MAX_ALIAS_PUBKEYS) break
  }
  return out
}

function parseFilterOrBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') {
    const clean = raw.trim().toLowerCase()
    if (clean === 'off' || clean === 'false' || clean === 'none') return false
    if (clean === 'all' || clean === 'mentions' || clean === 'true') return true
  }
  return fallback
}

function parseFilterMode(raw: unknown, fallback: PushFilterMode): PushFilterMode {
  if (typeof raw === 'string') {
    const clean = raw.trim().toLowerCase()
    if (clean === 'all') return 'all'
    if (clean === 'mentions' || clean === 'pings') return 'mentions'
    if (clean === 'off' || clean === 'false' || clean === 'none') return 'off'
  }
  if (raw === true) return 'mentions'
  if (raw === false) return 'off'
  return fallback
}

function normalizePreferences(raw: unknown): StoredPushPreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PUSH_PREFERENCES }
  const obj = raw as Record<string, unknown>
  const dms = parseFilterOrBool(obj.dms, DEFAULT_PUSH_PREFERENCES.dms)
  const agmail =
    obj.agmail !== undefined
      ? parseFilterOrBool(obj.agmail, DEFAULT_PUSH_PREFERENCES.agmail)
      : obj.dms !== undefined
        ? dms
        : DEFAULT_PUSH_PREFERENCES.agmail
  const agmailCcBcc =
    obj.agmailCcBcc !== undefined
      ? parseFilterOrBool(obj.agmailCcBcc, DEFAULT_PUSH_PREFERENCES.agmailCcBcc)
      : agmail
  return {
    dms,
    agmail,
    agmailCcBcc,
    directPings: parseFilterOrBool(obj.directPings, DEFAULT_PUSH_PREFERENCES.directPings),
    dmCallRinging: parseFilterOrBool(obj.dmCallRinging, DEFAULT_PUSH_PREFERENCES.dmCallRinging),
    serverMessages: parseFilterMode(
      obj.serverMessages,
      DEFAULT_PUSH_PREFERENCES.serverMessages
    ),
    serverCalls: parseFilterOrBool(obj.serverCalls, DEFAULT_PUSH_PREFERENCES.serverCalls),
    geoMessages: parseFilterMode(obj.geoMessages, DEFAULT_PUSH_PREFERENCES.geoMessages),
    showPreviews: parseFilterOrBool(obj.showPreviews, DEFAULT_PUSH_PREFERENCES.showPreviews),
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

async function syncPubkeysIndex(
  kv: KVNamespace,
  addPubkeys: string[],
  removePubkeys: string[] = []
): Promise<void> {
  const list = await readPubkeysIndex(kv)
  const set = new Set<string>(list)
  let changed = false

  for (const raw of removePubkeys) {
    const pk = raw.toLowerCase()
    if (set.delete(pk)) changed = true
  }
  for (const raw of addPubkeys) {
    if (!isHex64(raw)) continue
    const pk = raw.toLowerCase()
    if (!set.has(pk)) {
      set.add(pk)
      changed = true
    }
  }

  if (changed) {
    await kv.put(PUBKEYS_INDEX_KEY, JSON.stringify(Array.from(set)))
  }
}

async function deleteOwnedAliases(
  kv: KVNamespace,
  masterPubkey: string,
  aliases: string[]
): Promise<string[]> {
  const owner = masterPubkey.toLowerCase()
  const deleted: string[] = []
  for (const raw of aliases) {
    if (!isHex64(raw)) continue
    const aliasPk = raw.toLowerCase()
    const key = aliasKeyForPubkey(aliasPk)
    const current = await kv.get(key)
    if (!current || current.toLowerCase() === owner) {
      if (current) {
        await kv.delete(key)
      }
      deleted.push(aliasPk)
    }
  }
  return deleted
}

async function deleteUserRecordAndAliases(
  kv: KVNamespace,
  masterPubkey: string,
  existingRecord?: StoredUserRecord | null
): Promise<void> {
  const pk = masterPubkey.toLowerCase()
  const priorAliases = Array.isArray(existingRecord?.aliasPubkeys)
    ? existingRecord.aliasPubkeys
    : []
  await kv.delete(subKeyForPubkey(pk))
  const removedAliases = await deleteOwnedAliases(kv, pk, priorAliases)
  await syncPubkeysIndex(kv, [], [pk, ...removedAliases])
}

async function handlePostSubscribe(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text()
  const auth = await verifyNip98Request(request, rawBody)
  if (!auth.ok) return jsonResponse({ ok: false, error: auth.error }, auth.status)

  let body: {
    pubkey?: unknown
    aliasPubkeys?: unknown
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

  const priorAliases = normalizeAliasPubkeys(existing?.aliasPubkeys, auth.pubkey)
  const nextAliases =
    body.aliasPubkeys !== undefined
      ? normalizeAliasPubkeys(body.aliasPubkeys, auth.pubkey)
      : priorAliases

  const nextAliasSet = new Set(nextAliases)
  const priorAliasSet = new Set(priorAliases)
  const staleAliases = priorAliases.filter((a) => !nextAliasSet.has(a))
  const addedAliases = nextAliases.filter((a) => !priorAliasSet.has(a))

  const record: StoredUserRecord = {
    pubkey: auth.pubkey,
    devices: capped,
    aliasPubkeys: nextAliases,
    updatedAt: now,
  }
  await env.PUSH_KV.put(key, JSON.stringify(record))

  for (const aliasPk of addedAliases) {
    await env.PUSH_KV.put(aliasKeyForPubkey(aliasPk), auth.pubkey)
  }
  const removedStaleAliases =
    staleAliases.length > 0
      ? await deleteOwnedAliases(env.PUSH_KV, auth.pubkey, staleAliases)
      : []

  await syncPubkeysIndex(env.PUSH_KV, [auth.pubkey, ...nextAliases], removedStaleAliases)

  return jsonResponse({ ok: true, devices: capped.length, aliases: nextAliases.length })
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
    await deleteUserRecordAndAliases(env.PUSH_KV, auth.pubkey, existing)
    return jsonResponse({ ok: true, devices: 0 })
  }

  const remaining = endpoint
    ? existing.devices.filter((d) => d.subscription?.endpoint !== endpoint)
    : []

  if (remaining.length === 0) {
    await deleteUserRecordAndAliases(env.PUSH_KV, auth.pubkey, existing)
  } else {
    await env.PUSH_KV.put(
      key,
      JSON.stringify({
        pubkey: auth.pubkey,
        devices: remaining,
        aliasPubkeys: normalizeAliasPubkeys(existing.aliasPubkeys, auth.pubkey),
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
      await deleteUserRecordAndAliases(env.PUSH_KV, auth.pubkey, record)
    } else {
      await env.PUSH_KV.put(
        key,
        JSON.stringify({
          pubkey: auth.pubkey,
          devices: surviving,
          aliasPubkeys: normalizeAliasPubkeys(record.aliasPubkeys, auth.pubkey),
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
  isMention?: unknown
}

const VALID_POKE_CATEGORIES = new Set<PokeCategory>([
  'dm',
  'dm-call',
  'server-message',
  'server-call',
  'geo-message',
  'geo-call',
  'agmail',
  'agmail-cc',
  'call-cancel',
])

function isPokeAllowedByPreferences(
  category: PokeCategory,
  rawPrefs: StoredPushPreferences,
  isMention?: boolean
): boolean {
  const prefs = normalizePreferences(rawPrefs)
  switch (category) {
    case 'dm':
      return prefs.dms
    case 'agmail':
      return prefs.agmail
    case 'agmail-cc':
      return prefs.agmailCcBcc
    case 'dm-call':
    case 'call-cancel':
      return prefs.dmCallRinging
    case 'server-message':
      if (isMention === false) return prefs.serverMessages === 'all'
      return (
        prefs.directPings ||
        prefs.serverMessages === 'all' ||
        prefs.serverMessages === 'mentions'
      )
    case 'server-call':
      return prefs.serverCalls
    case 'geo-message':
      if (isMention === false) return prefs.geoMessages === 'all'
      return (
        prefs.directPings ||
        prefs.geoMessages === 'all' ||
        prefs.geoMessages === 'mentions'
      )
    case 'geo-call':
      return prefs.serverCalls || prefs.dmCallRinging || prefs.geoMessages !== 'off'
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
      title: safeSender ? `${safeSender} started a group call` : 'Group Call Active',
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
        : 'Bitchat Call Active',
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

  if (category === 'agmail-cc') {
    return {
      title: safeSender ? `New Agmail (CC/BCC) from ${safeSender}` : 'New Agmail (CC/BCC)',
      body: safePreview || "You were CC'd or BCC'd on a new encrypted Agmail.",
      tag: `agnostr-mail-cc-${senderPubkey.slice(0, 12)}`,
      data: {
        category: 'agmail',
        peerPubkey: senderPubkey,
      },
    }
  }

  if (category === 'server-message') {
    return {
      title: safeSender ? `${safeSender}` : 'New Group Message',
      body: safePreview || 'New message in one of your groups.',
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
        : 'New Bitchat Message',
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

  const isAgmailCategory = category === 'agmail' || category === 'agmail-cc'
  // Block self-poke spam (allow self-mail in Agmail only)
  const filteredRecipients = recipients.filter(
    (pk) => isAgmailCategory || pk !== auth.pubkey
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
  const isMention = typeof body.isMention === 'boolean' ? body.isMention : undefined

  const isCall = category === 'dm-call' || category === 'server-call' || category === 'geo-call' || category === 'call-cancel'
  const ttlSeconds = isCall ? 60 : 86_400
  const topic = callId && (category === 'dm-call' || category === 'call-cancel')
    ? `call-${callId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)}`
    : undefined

  let delivered = 0
  let skipped = 0
  let failed = 0
  const handledMasterPubkeys = new Set<string>()

  for (const recipientPk of filteredRecipients) {
    let resolvedMasterPk = recipientPk
    let key = subKeyForPubkey(resolvedMasterPk)
    let record = (await env.PUSH_KV.get(key, 'json')) as StoredUserRecord | null

    // Resolve derived Bitchat alias pubkeys (`alias:<derivedPk> -> masterPubkey`)
    if (!record || !Array.isArray(record.devices) || record.devices.length === 0) {
      const mappedMaster = await env.PUSH_KV.get(aliasKeyForPubkey(recipientPk))
      if (isHex64(mappedMaster)) {
        resolvedMasterPk = mappedMaster.toLowerCase()
        if (!isAgmailCategory && resolvedMasterPk === auth.pubkey) {
          skipped += 1
          continue
        }
        key = subKeyForPubkey(resolvedMasterPk)
        record = (await env.PUSH_KV.get(key, 'json')) as StoredUserRecord | null
      }
    }

    if (!record || !Array.isArray(record.devices) || record.devices.length === 0) {
      skipped += 1
      continue
    }

    if (handledMasterPubkeys.has(resolvedMasterPk)) {
      skipped += 1
      continue
    }
    handledMasterPubkeys.add(resolvedMasterPk)

    const surviving: StoredDeviceSubscription[] = []
    let pruned = false

    for (const dev of record.devices) {
      if (!isPokeAllowedByPreferences(category, dev.preferences, isMention)) {
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
        await deleteUserRecordAndAliases(env.PUSH_KV, resolvedMasterPk, record)
      } else {
        await env.PUSH_KV.put(
          key,
          JSON.stringify({
            pubkey: resolvedMasterPk,
            devices: surviving,
            aliasPubkeys: normalizeAliasPubkeys(record.aliasPubkeys, resolvedMasterPk),
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
