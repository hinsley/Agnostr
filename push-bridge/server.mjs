import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { verifyEvent } from 'nostr-tools'
import webpush from 'web-push'
import WebSocket from 'ws'

const PORT = Number.parseInt(process.env.PORT || '8787', 10)
const HOST = process.env.HOST || '0.0.0.0'
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:agnostr@example.com'
const SUBSCRIPTIONS_FILE = process.env.SUBSCRIPTIONS_FILE || ''

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://nostr.bitcoiner.social',
  'wss://offchain.pub',
  'wss://nostr.mom',
]

let vapidPublicKey = (process.env.VAPID_PUBLIC_KEY || '').trim()
let vapidPrivateKey = (process.env.VAPID_PRIVATE_KEY || '').trim()

if (!vapidPublicKey || !vapidPrivateKey) {
  const generated = webpush.generateVAPIDKeys()
  vapidPublicKey = generated.publicKey
  vapidPrivateKey = generated.privateKey
  console.warn(
    '[push-bridge] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — generated ephemeral keys for this run.'
  )
  console.warn('[push-bridge] For production persistence, export:')
  console.warn(`  VAPID_PUBLIC_KEY=${vapidPublicKey}`)
  console.warn(`  VAPID_PRIVATE_KEY=${vapidPrivateKey}`)
}

webpush.setVapidDetails(VAPID_SUBJECT, vapidPublicKey, vapidPrivateKey)

/**
 * Map<pubkey, { pubkey, relays: string[], geohashes: string[], serverIds: string[], preferences: object, devices: Map<endpoint, PushSubscription> }>
 */
const subscribers = new Map()
const seenEventIds = new Set()
const throttleMap = new Map()
const relaySockets = new Map()
let relaySyncTimer = null

function loadPersistedSubscriptions() {
  if (!SUBSCRIPTIONS_FILE || !fs.existsSync(SUBSCRIPTIONS_FILE)) return
  try {
    const raw = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8'))
    if (!Array.isArray(raw)) return
    for (const entry of raw) {
      if (!entry?.pubkey || !Array.isArray(entry.devices)) continue
      const devices = new Map()
      for (const sub of entry.devices) {
        if (sub?.endpoint) devices.set(sub.endpoint, sub)
      }
      if (devices.size > 0) {
        subscribers.set(entry.pubkey.toLowerCase(), {
          pubkey: entry.pubkey.toLowerCase(),
          relays: Array.isArray(entry.relays) ? entry.relays : [],
          geohashes: Array.isArray(entry.geohashes) ? entry.geohashes : [],
          serverIds: Array.isArray(entry.serverIds) ? entry.serverIds : [],
          preferences: entry.preferences || {},
          devices,
        })
      }
    }
    console.log(`[push-bridge] Loaded ${subscribers.size} persisted subscriber(s).`)
  } catch (err) {
    console.warn('[push-bridge] Failed to load persisted subscriptions:', err.message)
  }
}

function persistSubscriptions() {
  if (!SUBSCRIPTIONS_FILE) return
  try {
    const serialized = Array.from(subscribers.values()).map((s) => ({
      pubkey: s.pubkey,
      relays: s.relays,
      geohashes: s.geohashes,
      serverIds: s.serverIds,
      preferences: s.preferences,
      devices: Array.from(s.devices.values()),
    }))
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(serialized, null, 2))
  } catch (err) {
    console.warn('[push-bridge] Failed to persist subscriptions:', err.message)
  }
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

function sendJson(res, status, data) {
  setCorsHeaders(res)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

async function readBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('Request payload too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function verifyNip98Auth(req, rawBody, expectedMethod) {
  const auth = req.headers.authorization || ''
  if (!auth.startsWith('Nostr ')) {
    throw new Error('Missing NIP-98 Authorization header (expected "Nostr <base64>")')
  }
  const decodedJson = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8')
  const event = JSON.parse(decodedJson)
  if (!event || event.kind !== 27235) {
    throw new Error('Invalid NIP-98 event kind (expected 27235)')
  }
  if (!verifyEvent(event)) {
    throw new Error('Invalid NIP-98 cryptographic signature')
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - Number(event.created_at)) > 120) {
    throw new Error('Expired NIP-98 auth timestamp')
  }

  const getTag = (name) => {
    const found = (event.tags || []).find((t) => t[0] === name)
    return found ? found[1] : null
  }

  const methodTag = (getTag('method') || '').toUpperCase()
  if (methodTag !== expectedMethod.toUpperCase()) {
    throw new Error('NIP-98 method mismatch')
  }

  const uTag = getTag('u') || ''
  const reqPath = new URL(req.url || '/', 'http://localhost').pathname
  if (!uTag.endsWith(reqPath)) {
    throw new Error('NIP-98 URL path mismatch')
  }

  const payloadTag = getTag('payload')
  if (rawBody && payloadTag) {
    const expectedHash = crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex')
    if (payloadTag.toLowerCase() !== expectedHash) {
      throw new Error('NIP-98 payload hash mismatch')
    }
  }

  return event.pubkey.toLowerCase()
}

function shouldThrottle(key, windowMs) {
  const now = Date.now()
  const prev = throttleMap.get(key) || 0
  if (now - prev < windowMs) return true
  throttleMap.set(key, now)
  if (throttleMap.size > 2000) {
    for (const [k, ts] of throttleMap.entries()) {
      if (now - ts > 120_000) throttleMap.delete(k)
    }
  }
  return false
}

async function dispatchPushToPubkey(pubkey, payload, urgency = 'normal') {
  const entry = subscribers.get(pubkey.toLowerCase())
  if (!entry || entry.devices.size === 0) return

  const body = JSON.stringify(payload)
  const deadEndpoints = []

  await Promise.all(
    Array.from(entry.devices.entries()).map(async ([endpoint, subscription]) => {
      try {
        await webpush.sendNotification(subscription, body, {
          TTL: urgency === 'high' ? 45 : 300,
          urgency,
        })
      } catch (err) {
        const status = err?.statusCode
        if (status === 404 || status === 410) {
          deadEndpoints.push(endpoint)
        } else {
          console.warn(`[push-bridge] Push send error (${status || 'unknown'}):`, err.message)
        }
      }
    })
  )

  if (deadEndpoints.length > 0) {
    for (const ep of deadEndpoints) entry.devices.delete(ep)
    if (entry.devices.size === 0) subscribers.delete(entry.pubkey)
    persistSubscriptions()
    scheduleRelaySync()
  }
}

function handleRelayEvent(event) {
  if (!event || !event.id || seenEventIds.has(event.id)) return
  seenEventIds.add(event.id)
  if (seenEventIds.size > 4000) {
    const first = seenEventIds.values().next().value
    if (first) seenEventIds.delete(first)
  }

  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - Number(event.created_at || 0)) > 90) return

  const tags = Array.isArray(event.tags) ? event.tags : []
  const sender = String(event.pubkey || '').toLowerCase()
  const pTags = tags
    .filter((t) => t[0] === 'p' && typeof t[1] === 'string')
    .map((t) => t[1].toLowerCase())
  const tTags = tags
    .filter((t) => t[0] === 't' && typeof t[1] === 'string')
    .map((t) => t[1])
  const gTag = tags.find((t) => t[0] === 'g' && typeof t[1] === 'string')?.[1]?.toLowerCase()

  // 1. Incoming 1-on-1 DM Call signal (kind 25050 + #t agnostr-call-v1)
  if (event.kind === 25050 && tTags.includes('agnostr-call-v1')) {
    for (const targetPk of pTags) {
      if (targetPk === sender) continue
      const sub = subscribers.get(targetPk)
      if (!sub || sub.preferences?.dmCallRinging === false) continue
      // Deduplicate periodic 3.5s call-invite rebroadcasts per caller
      if (shouldThrottle(`call:${targetPk}:${sender}`, 12_000)) continue
      void dispatchPushToPubkey(
        targetPk,
        {
          title: 'Incoming DM Call',
          body: 'Someone is calling you on Agnostr — tap to answer',
          data: {
            category: 'dm-call',
            peerPubkey: sender,
            callId: event.id.slice(0, 16),
            mediaType: 'audio',
          },
        },
        'high'
      )
    }
    return
  }

  // 2. Encrypted Direct Message Gift Wrap (kind 1059)
  if (event.kind === 1059) {
    for (const targetPk of pTags) {
      if (targetPk === sender) continue
      const sub = subscribers.get(targetPk)
      if (!sub || sub.preferences?.dms === false) continue
      if (shouldThrottle(`dm:${targetPk}`, 2500)) continue
      void dispatchPushToPubkey(
        targetPk,
        {
          title: 'New Encrypted DM',
          body: 'You received a private message on Agnostr',
          data: { category: 'dm' },
        },
        'high'
      )
    }
    return
  }

  // 3. Server Message mention / reply (kind 9)
  if (event.kind === 9) {
    for (const targetPk of pTags) {
      if (targetPk === sender) continue
      const sub = subscribers.get(targetPk)
      if (!sub || sub.preferences?.serverMessages === 'off') continue
      if (shouldThrottle(`srv:${targetPk}`, 4000)) continue
      void dispatchPushToPubkey(targetPk, {
        title: 'Server Activity',
        body: 'New message in one of your Agnostr servers',
        data: { category: 'server-message' },
      })
    }
    return
  }

  // 4. Geo Radio Message (kind 20000) in watched geohashes
  if (event.kind === 20000 && gTag) {
    for (const sub of subscribers.values()) {
      if (sub.pubkey === sender) continue
      if (sub.preferences?.geoMessages === 'off') continue
      if (!sub.geohashes.includes(gTag)) continue
      if (shouldThrottle(`geo:${sub.pubkey}:${gTag}`, 8000)) continue
      const showPreviews = sub.preferences?.showPreviews !== false
      void dispatchPushToPubkey(sub.pubkey, {
        title: `#${gTag}`,
        body: showPreviews
          ? String(event.content || '').slice(0, 110) || 'New message in Geo Radio'
          : 'New message in Geo Radio',
        data: { category: 'geo-message', geohash: gTag },
      })
    }
  }
}

function buildActiveFilters() {
  const pubkeys = Array.from(subscribers.keys())
  if (pubkeys.length === 0) return []
  const geohashes = Array.from(
    new Set(Array.from(subscribers.values()).flatMap((s) => s.geohashes))
  ).slice(0, 40)

  const since = Math.floor(Date.now() / 1000) - 5
  const filters = [
    { kinds: [1059, 9], '#p': pubkeys, since },
    { kinds: [25050], '#p': pubkeys, '#t': ['agnostr-call-v1'], since },
  ]
  if (geohashes.length > 0) {
    filters.push({ kinds: [20000], '#g': geohashes, since })
  }
  return filters
}

function syncRelayWatchers() {
  const desiredRelays = new Set(DEFAULT_RELAYS)
  for (const sub of subscribers.values()) {
    for (const r of sub.relays) {
      if (typeof r === 'string' && r.startsWith('wss://')) desiredRelays.add(r)
    }
  }

  const filters = buildActiveFilters()
  if (filters.length === 0) {
    for (const [url, ws] of relaySockets.entries()) {
      try {
        ws.close()
      } catch {
        // Ignore
      }
      relaySockets.delete(url)
    }
    return
  }

  for (const url of desiredRelays) {
    const existing = relaySockets.get(url)
    if (existing && existing.readyState === WebSocket.OPEN) {
      existing.send(JSON.stringify(['REQ', 'agnostr-push', ...filters]))
      continue
    }
    if (existing && existing.readyState === WebSocket.CONNECTING) continue

    const connect = () => {
      const ws = new WebSocket(url)
      relaySockets.set(url, ws)
      ws.on('open', () => {
        const latestFilters = buildActiveFilters()
        if (latestFilters.length > 0) {
          ws.send(JSON.stringify(['REQ', 'agnostr-push', ...latestFilters]))
        }
      })
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString('utf8'))
          if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[2]) {
            handleRelayEvent(msg[2])
          }
        } catch {
          // Ignore malformed relay frames
        }
      })
      ws.on('error', () => {
        // Handled by close reconnect
      })
      ws.on('close', () => {
        if (relaySockets.get(url) === ws) {
          relaySockets.delete(url)
          if (subscribers.size > 0) {
            setTimeout(scheduleRelaySync, 5000)
          }
        }
      })
    }

    connect()
  }
}

function scheduleRelaySync() {
  if (relaySyncTimer) clearTimeout(relaySyncTimer)
  relaySyncTimer = setTimeout(() => {
    relaySyncTimer = null
    syncRelayWatchers()
  }, 400)
}

const server = http.createServer(async (req, res) => {
  const method = (req.method || 'GET').toUpperCase()
  const pathname = new URL(req.url || '/', 'http://localhost').pathname

  if (method === 'OPTIONS') {
    setCorsHeaders(res)
    res.writeHead(204)
    res.end()
    return
  }

  if (method === 'GET' && pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      subscribers: subscribers.size,
      relays: relaySockets.size,
    })
    return
  }

  if (method === 'GET' && pathname === '/vapid-public-key') {
    sendJson(res, 200, { publicKey: vapidPublicKey })
    return
  }

  if (pathname === '/subscribe' && (method === 'POST' || method === 'DELETE')) {
    try {
      const rawBody = await readBody(req)
      const authedPubkey = verifyNip98Auth(req, rawBody, method)
      const body = JSON.parse(rawBody || '{}')
      const reqPubkey = String(body.pubkey || authedPubkey).toLowerCase()
      if (reqPubkey !== authedPubkey) {
        sendJson(res, 403, { error: 'NIP-98 signer pubkey does not match subscription pubkey' })
        return
      }

      if (method === 'POST') {
        const sub = body.subscription
        if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth) {
          sendJson(res, 400, { error: 'Invalid Web Push subscription object' })
          return
        }
        const existing = subscribers.get(authedPubkey) || {
          pubkey: authedPubkey,
          relays: [],
          geohashes: [],
          serverIds: [],
          preferences: {},
          devices: new Map(),
        }
        existing.devices.set(sub.endpoint, sub)
        if (Array.isArray(body.relays)) existing.relays = body.relays.slice(0, 12)
        if (Array.isArray(body.geohashes)) {
          existing.geohashes = body.geohashes.map((g) => String(g).toLowerCase()).slice(0, 12)
        }
        if (Array.isArray(body.serverIds)) existing.serverIds = body.serverIds.slice(0, 20)
        if (body.preferences && typeof body.preferences === 'object') {
          existing.preferences = body.preferences
        }
        subscribers.set(authedPubkey, existing)
        persistSubscriptions()
        scheduleRelaySync()
        sendJson(res, 200, { ok: true, devices: existing.devices.size })
        return
      }

      if (method === 'DELETE') {
        const existing = subscribers.get(authedPubkey)
        if (existing) {
          if (typeof body.endpoint === 'string') {
            existing.devices.delete(body.endpoint)
          } else {
            existing.devices.clear()
          }
          if (existing.devices.size === 0) {
            subscribers.delete(authedPubkey)
          }
          persistSubscriptions()
          scheduleRelaySync()
        }
        sendJson(res, 200, { ok: true })
        return
      }
    } catch (err) {
      sendJson(res, 401, { error: err instanceof Error ? err.message : 'Unauthorized' })
      return
    }
  }

  sendJson(res, 404, { error: 'Not found' })
})

loadPersistedSubscriptions()
server.listen(PORT, HOST, () => {
  console.log(`[push-bridge] Listening on http://${HOST}:${PORT}`)
  console.log(`[push-bridge] VAPID Public Key: ${vapidPublicKey}`)
  if (subscribers.size > 0) scheduleRelaySync()
})
