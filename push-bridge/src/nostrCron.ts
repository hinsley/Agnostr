import { verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure'
import {
  aliasKeyForPubkey,
  PUBKEYS_INDEX_KEY,
  seenKeyForEvent,
  subKeyForPubkey,
  type Env,
  type IncomingPushPayload,
  type StoredDeviceSubscription,
  type StoredUserRecord,
} from './types.ts'
import { sendWebPushNotification } from './webpush.ts'

const CRON_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://offchain.pub',
] as const

const CRON_KINDS = [1059, 1, 9, 20000, 9735, 9321]
const RELAY_TIMEOUT_MS = 4_500
const SEEN_TTL_SECONDS = 600
const LOOKBACK_SECONDS = 95

function wssToHttps(wssUrl: string): string {
  return wssUrl.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://')
}

function getTagValue(tags: string[][], name: string): string | null {
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === name && typeof tag[1] === 'string') {
      return tag[1]
    }
  }
  return null
}

function getAllTagValues(tags: string[][], name: string): string[] {
  const out: string[] = []
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === name && typeof tag[1] === 'string') {
      out.push(tag[1])
    }
  }
  return out
}

async function queryRelayEvents(
  relayWssUrl: string,
  pubkeys: string[],
  sinceSec: number
): Promise<NostrEvent[]> {
  if (pubkeys.length === 0) return []
  const events: NostrEvent[] = []
  const subId = `agpush-${Math.random().toString(36).slice(2, 10)}`

  let ws: WebSocket | null = null
  try {
    const controller = new AbortController()
    const connectTimer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS)
    let resp: Response
    try {
      resp = await fetch(wssToHttps(relayWssUrl), {
        headers: { Upgrade: 'websocket' },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(connectTimer)
    }

    ws = (resp as Response & { webSocket?: WebSocket | null }).webSocket ?? null
    if (!ws) return []
    ;(ws as WebSocket & { accept?: () => void }).accept?.()

    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          ws?.send(JSON.stringify(['CLOSE', subId]))
        } catch {
          // Ignore close send error
        }
        try {
          ws?.close(1000, 'done')
        } catch {
          // Ignore close error
        }
        resolve()
      }

      const timer = setTimeout(done, RELAY_TIMEOUT_MS)

      ws!.addEventListener('message', (msgEv: MessageEvent) => {
        if (typeof msgEv.data !== 'string') return
        let frame: unknown
        try {
          frame = JSON.parse(msgEv.data)
        } catch {
          return
        }
        if (!Array.isArray(frame) || frame.length < 2) return
        if (frame[0] === 'EVENT' && frame[1] === subId && frame[2] && typeof frame[2] === 'object') {
          events.push(frame[2] as NostrEvent)
          if (events.length >= 80) done()
        } else if (frame[0] === 'EOSE' && frame[1] === subId) {
          done()
        }
      })

      ws!.addEventListener('close', done)
      ws!.addEventListener('error', done)

      try {
        ws!.send(
          JSON.stringify([
            'REQ',
            subId,
            {
              kinds: CRON_KINDS,
              '#p': pubkeys,
              since: sinceSec,
              limit: 80,
            },
          ])
        )
      } catch {
        done()
      }
    })
  } catch {
    try {
      ws?.close()
    } catch {
      // Ignore
    }
  }

  return events
}

function buildPayloadForEvent(
  ev: NostrEvent,
  device: StoredDeviceSubscription
): IncomingPushPayload | null {
  const prefs = device.preferences
  const showPreviews = prefs.showPreviews !== false
  const senderNick = getTagValue(ev.tags, 'n')?.trim()
  const cleanPreview =
    showPreviews && typeof ev.content === 'string'
      ? ev.content.trim().replace(/\s+/g, ' ').slice(0, 110)
      : ''

  if (ev.kind === 1059) {
    if (!prefs.dms && prefs.agmail === false && prefs.agmailCcBcc === false) return null
    return {
      title: 'New encrypted message',
      body: 'Open Agnostr to read your private message.',
      tag: 'agnostr-dm-wrap',
      data: {
        category: 'dm',
        tag: 'agnostr-dm-wrap',
      },
    }
  }

  if (ev.kind === 9735 || ev.kind === 9321) {
    if (!prefs.dms && !prefs.directPings) return null
    return {
      title: 'New Zap received',
      body: showPreviews && cleanPreview ? cleanPreview : 'Someone zapped you on Agnostr.',
      tag: `agnostr-zap-${ev.id.slice(0, 12)}`,
      data: {
        category: 'dm',
        peerPubkey: ev.pubkey.toLowerCase(),
        tag: `agnostr-zap-${ev.id.slice(0, 12)}`,
      },
    }
  }

  if (ev.kind === 9) {
    const srvMode = prefs.serverMessages as string | boolean | undefined
    const srvOff = srvMode === 'off' || srvMode === false
    if (!prefs.directPings && srvOff) return null
    const serverId = getTagValue(ev.tags, 'h') || undefined
    return {
      title: showPreviews && senderNick ? `${senderNick} in Group` : 'New Group Message',
      body: cleanPreview || 'New message in one of your groups.',
      tag: serverId ? `agnostr-srv-${serverId.slice(0, 12)}` : 'agnostr-srv',
      data: {
        category: 'server-message',
        serverId,
        peerPubkey: ev.pubkey.toLowerCase(),
      },
    }
  }

  if (ev.kind === 20000 || ev.kind === 1) {
    const geoMode = prefs.geoMessages as string | boolean | undefined
    const geoOff = geoMode === 'off' || geoMode === false
    if (!prefs.directPings && geoOff) return null
    const geohash = getTagValue(ev.tags, 'g') || undefined
    const title =
      showPreviews && senderNick
        ? geohash
          ? `${senderNick} mentioned you in #${geohash}`
          : `${senderNick} mentioned you`
        : 'New mention on Agnostr'
    return {
      title,
      body: cleanPreview || 'Someone mentioned or replied to you.',
      tag: geohash ? `agnostr-geo-${geohash}` : `agnostr-ping-${ev.id.slice(0, 12)}`,
      data: {
        category: 'geo-message',
        geohash,
        peerPubkey: ev.pubkey.toLowerCase(),
      },
    }
  }

  return null
}

/**
 * 1-minute Cron Trigger — strictly KV Free-Tier safe:
 * - Reads `pubkeys:index` (1 KV read). If empty → 0 KV writes, exits immediately.
 * - Queries 3 fast Nostr relays in parallel (4.5s hard cap).
 * - If 0 matching events → 0 KV writes, exits immediately.
 * - Only writes `seen:<eventId>` (10-min TTL) when an actual matching event is delivered.
 */
export async function runNostrPushCron(env: Env): Promise<{
  checkedPubkeys: number
  fetchedEvents: number
  delivered: number
}> {
  const rawIndex = await env.PUSH_KV.get(PUBKEYS_INDEX_KEY, 'json')
  const pubkeys = Array.isArray(rawIndex)
    ? Array.from(
        new Set(
          rawIndex
            .filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/i.test(x))
            .map((x) => x.toLowerCase())
        )
      )
    : []

  if (pubkeys.length === 0) {
    return { checkedPubkeys: 0, fetchedEvents: 0, delivered: 0 }
  }

  const pubkeySet = new Set(pubkeys)
  const sinceSec = Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS

  // Chunk into groups of <= 60 pubkeys if needed
  const relayBatches: Promise<NostrEvent[]>[] = []
  for (let i = 0; i < pubkeys.length; i += 60) {
    const slice = pubkeys.slice(i, i + 60)
    for (const relayUrl of CRON_RELAYS) {
      relayBatches.push(queryRelayEvents(relayUrl, slice, sinceSec))
    }
  }

  const nestedResults = await Promise.all(relayBatches)
  const uniqueById = new Map<string, NostrEvent>()
  for (const list of nestedResults) {
    for (const ev of list) {
      if (
        ev &&
        typeof ev.id === 'string' &&
        /^[0-9a-f]{64}$/i.test(ev.id) &&
        !uniqueById.has(ev.id)
      ) {
        uniqueById.set(ev.id, ev)
      }
    }
  }

  if (uniqueById.size === 0) {
    return { checkedPubkeys: pubkeys.length, fetchedEvents: 0, delivered: 0 }
  }

  let delivered = 0
  const userCache = new Map<string, StoredUserRecord | null>()
  const aliasCache = new Map<string, string | null>()
  const dirtyUsers = new Set<string>()
  const removedPubkeys = new Set<string>()

  const resolveRecordForRecipient = async (
    rawPk: string
  ): Promise<{ masterPk: string; record: StoredUserRecord } | null> => {
    const pk = rawPk.toLowerCase()
    if (!userCache.has(pk)) {
      const direct = (await env.PUSH_KV.get(subKeyForPubkey(pk), 'json')) as StoredUserRecord | null
      userCache.set(pk, direct)
    }
    const directRec = userCache.get(pk)
    if (directRec && Array.isArray(directRec.devices) && directRec.devices.length > 0) {
      return { masterPk: pk, record: directRec }
    }

    if (!aliasCache.has(pk)) {
      const mapped = await env.PUSH_KV.get(aliasKeyForPubkey(pk))
      const clean =
        typeof mapped === 'string' && /^[0-9a-f]{64}$/i.test(mapped)
          ? mapped.toLowerCase()
          : null
      aliasCache.set(pk, clean)
    }
    const masterPk = aliasCache.get(pk)
    if (!masterPk) return null

    if (!userCache.has(masterPk)) {
      const stored = (await env.PUSH_KV.get(
        subKeyForPubkey(masterPk),
        'json'
      )) as StoredUserRecord | null
      userCache.set(masterPk, stored)
    }
    const aliasedRec = userCache.get(masterPk)
    if (aliasedRec && Array.isArray(aliasedRec.devices) && aliasedRec.devices.length > 0) {
      return { masterPk, record: aliasedRec }
    }
    return null
  }

  for (const ev of uniqueById.values()) {
    const authorPk = ev.pubkey.toLowerCase()
    const recipients = getAllTagValues(ev.tags, 'p')
      .map((p) => p.toLowerCase())
      .filter((p) => pubkeySet.has(p))

    // Avoid self-push noise on regular chat/mentions (keep gift-wrap 1059 since wrap pubkey is ephemeral)
    const filteredRecipients = Array.from(new Set(recipients)).filter(
      (r) => ev.kind === 1059 || ev.kind === 9735 || ev.kind === 9321 || r !== authorPk
    )
    if (filteredRecipients.length === 0) continue

    let sigOk = false
    try {
      sigOk = verifyEvent(ev)
    } catch {
      sigOk = false
    }
    if (!sigOk) continue

    const seenKey = seenKeyForEvent(ev.id)
    const alreadySeen = await env.PUSH_KV.get(seenKey)
    if (alreadySeen) continue
    await env.PUSH_KV.put(seenKey, '1', { expirationTtl: SEEN_TTL_SECONDS })

    const deliveredMastersForEvent = new Set<string>()

    for (const recipientPk of filteredRecipients) {
      const resolved = await resolveRecordForRecipient(recipientPk)
      if (!resolved) continue
      const { masterPk, record } = resolved

      if (deliveredMastersForEvent.has(masterPk)) continue
      if (
        ev.kind !== 1059 &&
        ev.kind !== 9735 &&
        ev.kind !== 9321 &&
        (masterPk === authorPk ||
          (Array.isArray(record.aliasPubkeys) && record.aliasPubkeys.includes(authorPk)))
      ) {
        continue
      }
      deliveredMastersForEvent.add(masterPk)

      const survivingDevices: StoredDeviceSubscription[] = []
      let recordChanged = false

      for (const dev of record.devices) {
        const payload = buildPayloadForEvent(ev, dev)
        if (!payload) {
          survivingDevices.push(dev)
          continue
        }

        const res = await sendWebPushNotification({
          subscription: dev.subscription,
          payload,
          vapidPublicKey: env.VAPID_PUBLIC_KEY,
          vapidPrivateKey: env.VAPID_PRIVATE_KEY,
          vapidSubject: env.VAPID_SUBJECT,
          ttlSeconds: 86_400,
          urgency: 'high',
        })
        if (res.ok) delivered += 1
        if (res.expired) {
          recordChanged = true
        } else {
          survivingDevices.push(dev)
        }
      }

      if (recordChanged) {
        record.devices = survivingDevices
        record.updatedAt = Date.now()
        dirtyUsers.add(masterPk)
        if (survivingDevices.length === 0) {
          removedPubkeys.add(masterPk)
          if (Array.isArray(record.aliasPubkeys)) {
            for (const aliasPk of record.aliasPubkeys) {
              removedPubkeys.add(aliasPk.toLowerCase())
            }
          }
        }
      }
    }
  }

  // Persist any expired-endpoint prunings
  for (const pk of dirtyUsers) {
    const rec = userCache.get(pk)
    if (!rec || rec.devices.length === 0) {
      await env.PUSH_KV.delete(subKeyForPubkey(pk))
      if (Array.isArray(rec?.aliasPubkeys)) {
        for (const aliasPk of rec.aliasPubkeys) {
          const aliasKey = aliasKeyForPubkey(aliasPk)
          const owner = await env.PUSH_KV.get(aliasKey)
          if (owner?.toLowerCase() === pk) {
            await env.PUSH_KV.delete(aliasKey)
          }
        }
      }
    } else {
      await env.PUSH_KV.put(subKeyForPubkey(pk), JSON.stringify(rec))
    }
  }

  if (removedPubkeys.size > 0) {
    const nextIndex = pubkeys.filter((pk) => !removedPubkeys.has(pk))
    await env.PUSH_KV.put(PUBKEYS_INDEX_KEY, JSON.stringify(nextIndex))
  }

  return {
    checkedPubkeys: pubkeys.length,
    fetchedEvents: uniqueById.size,
    delivered,
  }
}
