import { verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure'
import {
  aliasKeyForPubkey,
  publicRoomEnabled,
  subKeyForPubkey,
  type Env,
  type IncomingPushPayload,
  type StoredDeviceSubscription,
  type StoredUserRecord,
} from './types.ts'
import { addCounts, emptyCounts, nextScanPage, queueJobs, type DeliveryJob } from './delivery.ts'
import { sha256Hex } from './webpush.ts'

const CRON_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://offchain.pub',
] as const

const PUBLIC_KINDS = [4, 1, 6, 7, 9, 20000, 23333, 9735, 9321]
const RELAY_TIMEOUT_MS = 4_500
const GIFT_LOOKBACK_SECONDS = 48 * 3600 + 600
const GIFT_WINDOW_SECONDS = 12 * 3600
const PUBLIC_LOOKBACK_SECONDS = 600
const LIMIT_PER_QUERY = 64
const MAX_GIFT_QUERIES = 11
const SCAN_WORK_MS = 28_000
const ROOMS_PER_TICK = 12
interface RelaySnapshot { events: NostrEvent[]; complete: boolean }

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
  kinds: number[],
  sinceSec: number,
  untilSec: number,
  deadlineMs = Date.now()+2*RELAY_TIMEOUT_MS,
  tag: '#p' | '#g' | '#d' = '#p'
): Promise<RelaySnapshot> {
  if (pubkeys.length === 0) return { events: [], complete: true }
  if (Date.now() >= deadlineMs) return { events: [], complete: false }
  const events: NostrEvent[] = []
  const subId = `agpush-${Math.random().toString(36).slice(2, 10)}`

  let ws: WebSocket | null = null
  let complete = false
  try {
    const controller = new AbortController()
    const connectTimer = setTimeout(() => controller.abort(), Math.min(RELAY_TIMEOUT_MS,deadlineMs-Date.now()))
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
    if (!ws) return { events, complete: false }
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

      const timer = setTimeout(done, Math.max(1,Math.min(RELAY_TIMEOUT_MS,deadlineMs-Date.now())))

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
          if (events.length >= LIMIT_PER_QUERY) done()
        } else if (frame[0] === 'EOSE' && frame[1] === subId) {
          complete = true
          done()
        } else if (frame[0] === 'CLOSED' && frame[1] === subId) {
          // Recipient-authenticated relays may refuse queries; never answer their
          // challenge as a user or treat an access denial as an empty history.
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
              kinds,
              [tag]: pubkeys,
              since: sinceSec,
              until: untilSec,
              limit: LIMIT_PER_QUERY,
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

  return { events, complete }
}

function extractHexEventTag(tags: string[][], preferLast = false): string | undefined {
  if (preferLast) {
    for (let i = tags.length - 1; i >= 0; i -= 1) {
      const tag = tags[i]
      if (Array.isArray(tag) && tag[0] === 'e' && typeof tag[1] === 'string' && /^[0-9a-f]{64}$/i.test(tag[1])) {
        return tag[1].toLowerCase()
      }
    }
    return undefined
  }
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === 'e' && typeof tag[1] === 'string' && /^[0-9a-f]{64}$/i.test(tag[1])) {
      return tag[1].toLowerCase()
    }
  }
  return undefined
}

function buildPayloadForEvent(
  ev: NostrEvent,
  device: StoredDeviceSubscription,
  recipientPubkey: string
): IncomingPushPayload | null {
  const prefs = device.preferences
  const showPreviews = prefs.showPreviews !== false
  const senderNick = getTagValue(ev.tags, 'n')?.trim()
  const cleanPreview =
    showPreviews && typeof ev.content === 'string'
      ? ev.content.trim().replace(/\s+/g, ' ').slice(0, 110)
      : ''
  const authorPk = ev.pubkey.toLowerCase()

  if (ev.kind === 1059) {
    if (!prefs.dms && prefs.agmail === false && prefs.agmailCcBcc === false) return null
    return {
      title: 'New encrypted message',
      body: 'Open Agnostr to read your private message.',
      tag: 'agnostr-dm-wrap',
      data: {
        category: 'dm',
        tag: 'agnostr-dm-wrap',
        recipientPubkey,
      },
    }
  }

  if (ev.kind === 4) {
    if (!prefs.dms) return null
    return {
      title: 'New encrypted message',
      body: 'Open Agnostr to read your private message.',
      tag: 'agnostr-dm-encrypted',
      data: { category: 'dm', recipientPubkey, peerPubkey: authorPk },
    }
  }

  if (ev.kind === 9735 || ev.kind === 9321) {
    const noteId = extractHexEventTag(ev.tags)
    if (noteId) {
      if (prefs.agoraZaps === false) return null
      return {
        title: 'New Zap on Agora',
        body: showPreviews && cleanPreview ? cleanPreview : 'Someone zapped your post on Agora.',
        tag: `agnostr-agora-zap-${noteId.slice(0, 12)}`,
        data: {
          category: 'agora-zap',
          noteId,
          peerPubkey: authorPk,
          recipientPubkey,
          tag: `agnostr-agora-zap-${noteId.slice(0, 12)}`,
        },
      }
    }
    if (prefs.agoraZaps === false && !prefs.dms && !prefs.directPings) return null
    return {
      title: 'New Zap received',
      body: showPreviews && cleanPreview ? cleanPreview : 'Someone zapped you on Agnostr.',
      tag: `agnostr-zap-${ev.id.slice(0, 12)}`,
      data: {
        category: prefs.agoraZaps !== false ? 'agora-zap' : 'dm',
        peerPubkey: authorPk,
        recipientPubkey,
        tag: `agnostr-zap-${ev.id.slice(0, 12)}`,
      },
    }
  }

  if (ev.kind === 6) {
    if (prefs.agoraReactionsReposts === false) return null
    const noteId = extractHexEventTag(ev.tags)
    return {
      title: showPreviews && senderNick ? `${senderNick} reposted your note` : 'New repost on Agora',
      body: 'Someone reposted your note on Agora.',
      tag: noteId ? `agnostr-agora-repost-${noteId.slice(0, 12)}` : `agnostr-agora-repost-${ev.id.slice(0, 12)}`,
      data: {
        category: 'agora-repost',
        noteId,
        peerPubkey: authorPk,
        recipientPubkey,
      },
    }
  }

  if (ev.kind === 7) {
    if (typeof ev.content === 'string' && ev.content.trim() === '-') return null
    if (prefs.agoraReactionsReposts === false) return null
    const noteId = extractHexEventTag(ev.tags, true)
    return {
      title: showPreviews && senderNick ? `${senderNick} liked your post` : 'New like on Agora',
      body: 'Someone liked your post on Agora.',
      tag: noteId ? `agnostr-agora-like-${noteId.slice(0, 12)}` : `agnostr-agora-like-${ev.id.slice(0, 12)}`,
      data: {
        category: 'agora-like',
        noteId,
        peerPubkey: authorPk,
        recipientPubkey,
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
        peerPubkey: authorPk,
        recipientPubkey,
      },
    }
  }

  if (ev.kind === 1) {
    const geohash = getTagValue(ev.tags, 'g') || undefined
    if (!geohash) {
      // Public Nostr/Agora reply or mention
      if (prefs.agoraRepliesMentions === false) return null
      const hasParent = Boolean(extractHexEventTag(ev.tags))
      const category = hasParent ? 'agora-reply' : 'agora-mention'
      const noteId = ev.id.toLowerCase()
      const title =
        showPreviews && senderNick
          ? hasParent
            ? `${senderNick} replied on Agora`
            : `${senderNick} mentioned you on Agora`
          : hasParent
            ? 'New reply on Agora'
            : 'New mention on Agora'
      return {
        title,
        body:
          cleanPreview ||
          (hasParent ? 'Someone replied to your post on Agora.' : 'Someone mentioned you on Agora.'),
        tag: `agnostr-${category}-${noteId.slice(0, 12)}`,
        data: {
          category,
          noteId,
          peerPubkey: authorPk,
          recipientPubkey,
        },
      }
    }
    const geoMode = prefs.geoMessages as string | boolean | undefined
    const geoOff = geoMode === 'off' || geoMode === false
    if (!prefs.directPings && geoOff) return null
    const title =
      showPreviews && senderNick
        ? `${senderNick} mentioned you in #${geohash}`
        : 'New mention on Agnostr'
    return {
      title,
      body: cleanPreview || 'Someone mentioned or replied to you.',
      tag: `agnostr-geo-${geohash}`,
      data: {
        category: 'geo-message',
        geohash,
        peerPubkey: authorPk,
        recipientPubkey,
      },
    }
  }

  if (ev.kind === 20000 || ev.kind === 23333) {
    const geoMode = prefs.geoMessages as string | boolean | undefined
    const geoOff = geoMode === 'off' || geoMode === false
    if (!prefs.directPings && geoOff) return null
    const geohash = eventRoom(ev) || undefined
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
        peerPubkey: authorPk,
        recipientPubkey,
      },
    }
  }

  return null
}

async function giftSnapshot(relay: string, recipients: string[], now: number, deadline: number, lookback: number): Promise<RelaySnapshot> {
  // created_at is intentionally backdated. Requery overlapping creation-time
  // bands, but decide "new" using a durable observed-ID cursor, never the date.
  const bands: [number, number][] = []
  for (let from = now-lookback; from <= now+900; from += GIFT_WINDOW_SECONDS) {
    bands.push([from, Math.min(from+GIFT_WINDOW_SECONDS-1, now+900)])
  }
  let queries = 0
  let complete = true
  const events = new Map<string,NostrEvent>()
  const partial = async (from: number, to: number): Promise<void> => {
    if (queries >= MAX_GIFT_QUERIES || Date.now() >= deadline) { complete = false; return }
    queries++
    const page = await queryRelayEvents(relay, recipients, [1059], from, to, deadline)
    for (const ev of page.events) if (ev?.kind === 1059 && typeof ev.id === 'string') events.set(ev.id,ev)
    if (page.complete) return
    if (page.events.length >= LIMIT_PER_QUERY && from < to && queries+2 <= MAX_GIFT_QUERIES) {
      const middle = Math.floor((from+to)/2)
      await partial(from, middle)
      await partial(middle+1, to)
      return
    }
    complete = false
  }
  // Start each coarse band even when an earlier band is busy, then refine
  // saturated ones; otherwise an oldest bucket could starve newer arrivals.
  const refine: [number, number][] = []
  for (const [from,to] of bands) {
    queries++
    const page = await queryRelayEvents(relay, recipients, [1059], from, to, deadline)
    for (const ev of page.events) if (ev?.kind === 1059 && typeof ev.id === 'string') events.set(ev.id,ev)
    if (!page.complete) {
      if (page.events.length >= LIMIT_PER_QUERY && from < to) refine.push([from,to])
      else complete=false
    }
  }
  for (const [from,to] of refine) {
    const middle=Math.floor((from+to)/2)
    await partial(from,middle)
    await partial(middle+1,to)
  }
  return { events: [...events.values()], complete }
}

function publicRoomKey(key: string): boolean {
  // Earth/celestial #g tags or named Bitchat #d slugs, never a virtual/private
  // channel key. The subscriptions below are on the fixed public relay set.
  return (/^(?:[a-z][a-z0-9_-]{0,25}:)?[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/.test(key) &&
    !key.startsWith('topic:')) || /^topic:[a-z0-9][a-z0-9_-]{0,47}$/.test(key)
}

function eventRoom(ev: NostrEvent): string | null {
  if (ev.kind === 20000) return getTagValue(ev.tags, 'g')
  const slug = ev.kind === 23333 ? getTagValue(ev.tags, 'd') : null
  return slug ? 'topic:'+slug : null
}

function validEvent(ev: NostrEvent): boolean {
  if (!ev || !/^[0-9a-f]{64}$/.test(ev.id) || !Array.isArray(ev.tags)) return false
  try { return verifyEvent(ev) } catch { return false }
}

function roomJob(ev: NostrEvent, record: StoredUserRecord, allowed: Set<string>): DeliveryJob | null {
  if (!validEvent(ev) || ev.pubkey === record.pubkey || record.aliasPubkeys?.includes(ev.pubkey)) return null
  const room = eventRoom(ev)
  if (!room || !allowed.has(room)) return null
  return {
    id: `relay:${ev.id}`,
    ttlSeconds: 600,
    targets: record.devices.flatMap((dev) => {
      if (!publicRoomEnabled(dev) || ev.created_at*1000+999 < (dev.publicPinnedRoomSince ?? Infinity)
          || !dev.geohashes.includes(room)) return []
      const payload: IncomingPushPayload = {
        title: 'New Bitchat room message',
        body: 'Open Agnostr to read a new message in your pinned public room.',
        tag: `agnostr-geo-${room}`,
        data: { category: 'geo-message', geohash: room, recipientPubkey: record.pubkey,
          peerPubkey: ev.pubkey, deliveryEventId: ev.id },
      }
      return [{ endpointHash: dev.endpointHash, preferences: JSON.stringify(dev.preferences), room, payload }]
    }),
  }
}

function buildJob(ev: NostrEvent, record: StoredUserRecord): DeliveryJob | null {
  const isSelf = ev.pubkey === record.pubkey || record.aliasPubkeys?.includes(ev.pubkey)
  if (isSelf && ev.kind !== 1059 && ev.kind !== 9735 && ev.kind !== 9321) return null
  const targets = record.devices.flatMap((dev) => {
    const payload = buildPayloadForEvent(ev, dev, record.pubkey)
    if (!payload) return []
    if (payload.data) payload.data.deliveryEventId = ev.id
    return [{ endpointHash: dev.endpointHash, preferences: JSON.stringify(dev.preferences), payload }]
  })
  // IDs here are relay event hashes. The blind sender path uses a separate
  // authenticated namespace; no correlation of ephemeral wraps to senders.
  return { id: `relay:${ev.id}`, targets, ttlSeconds: 86_400 }
}

function validForTag(ev: NostrEvent, tag: string): boolean {
  return Array.isArray(ev?.tags) &&
    getAllTagValues(ev.tags, 'p').some((pk) => pk.toLowerCase() === tag) && validEvent(ev)
}

/** Budgeted per-recipient relay scanning. Incomplete/reset scans are explicit;
 * private relays are never impersonated and may be unavailable to the bridge. */
export async function runNostrPushCron(env: Env, scheduledAt = Date.now()): Promise<{
  checkedPubkeys: number
  fetchedEvents: number
  delivered: number
  queued: number
  partialGiftScans: number
  failed: number
}> {
  const {tags,rotation,periodSeconds} = await nextScanPage(env,scheduledAt)
  if (!tags.length) return { checkedPubkeys: 0, fetchedEvents: 0, delivered: 0, queued: 0, partialGiftScans: 0, failed: 0 }
  const now = Math.floor(scheduledAt/1000)
  // Use observed full sweep length to cover moderate backlogs without
  // making either public or encrypted Nostr reads unbounded.
  const publicWindow = Math.min(3600,Math.max(PUBLIC_LOOKBACK_SECONDS,2*periodSeconds))
  const giftWindow = GIFT_LOOKBACK_SECONDS+Math.min(6*3600,2*periodSeconds)
  const records = new Map<string,StoredUserRecord>()
  for (const tag of tags) {
    const direct = await env.PUSH_KV.get<StoredUserRecord>(subKeyForPubkey(tag),'json')
    if (direct?.devices?.length) { records.set(tag,direct); continue }
    const alias = await env.PUSH_KV.get(aliasKeyForPubkey(tag))
    if (!alias || !/^[0-9a-f]{64}$/i.test(alias)) continue
    const rec = await env.PUSH_KV.get<StoredUserRecord>(subKeyForPubkey(alias),'json')
    if (rec?.devices?.length) records.set(tag,rec)
  }
  const uniqueRoomRecords = Array.from(new Map([...records.values()].map((rec) => [rec.pubkey,rec])).values())
  const allRooms = [...new Set(uniqueRoomRecords.flatMap((record) =>
    record.devices.flatMap((dev) => publicRoomEnabled(dev)
      ? (dev.geohashes ?? []).filter(publicRoomKey) : [])))].sort()
  // Recipient batches already rotate each minute. Rotate room slices on
  // successive visits to a batch, not raw wall minutes (which may share a
  // divisor with the room count and leave some rooms starved indefinitely).
  const roomOffset = allRooms.length
    ? (rotation % Math.ceil(allRooms.length/ROOMS_PER_TICK))*ROOMS_PER_TICK : 0
  const rooms = allRooms.slice(roomOffset,roomOffset+ROOMS_PER_TICK)
  const geoRooms = rooms.filter((room) => !room.startsWith('topic:'))
  const topicRooms = rooms.filter((room) => room.startsWith('topic:')).map((room) => room.slice(6))
  const deadline = Date.now()+SCAN_WORK_MS
  const [payloads, roomSnapshots] = await Promise.all([
    Promise.all(CRON_RELAYS.map(async (relay) => {
      const publicEvents = await queryRelayEvents(relay, tags, PUBLIC_KINDS, now-publicWindow, now+90, deadline)
      const gift = await giftSnapshot(relay, tags, now, deadline, giftWindow)
      return { relay, publicEvents, gift }
    })),
    Promise.all(CRON_RELAYS.map(async (relay) => {
      const geo = await queryRelayEvents(relay, geoRooms, [20000], now-publicWindow, now+90, deadline, '#g')
      const topics = await queryRelayEvents(relay, topicRooms, [23333], now-publicWindow, now+90, deadline, '#d')
      return [...geo.events, ...topics.events]
    })),
  ])
  const seen = new Set<string>()
  const result = emptyCounts()
  for (const {relay,gift,publicEvents} of payloads) {
    for (const tag of tags) {
      const record = records.get(tag)
      if (!record) continue
      const publicJobs: DeliveryJob[] = []
      for (const ev of publicEvents.events) {
        if (!PUBLIC_KINDS.includes(ev.kind) || !validForTag(ev,tag)) continue
        seen.add(ev.id)
        const job = buildJob(ev,record)
        if (job?.targets.length) publicJobs.push(job)
      }
      const events = gift.events.flatMap((ev) => {
        if (!validForTag(ev,tag)) return []
        seen.add(ev.id)
        const job = buildJob(ev,record)
        return job ? [{ ...job, eventId: ev.id }] : []
      })
      try {
        addCounts(result, await queueJobs(env, {
          recipient: record.pubkey,
          jobs: publicJobs,
          observation: { relay: await sha256Hex(relay+':'+tag), complete: gift.complete, events },
        }))
      } catch {
        result.failed += Math.max(1, publicJobs.length+events.length)
      }
    }
  }
  if (rooms.length) {
    const allowed = new Set(rooms)
    const roomEvents = roomSnapshots.flat().filter((ev) => {
      const room = eventRoom(ev)
      return room && allowed.has(room) && validEvent(ev)
    })
    const deduped = [...new Map(roomEvents.map((ev) => [ev.id,ev])).values()]
    for (const record of uniqueRoomRecords) {
      const jobs = deduped.flatMap((ev) => {
        const job = roomJob(ev, record, allowed)
        if (!job?.targets.length) return []
        seen.add(ev.id)
        return [job]
      })
      if (!jobs.length) continue
      try { addCounts(result,await queueJobs(env,{ recipient:record.pubkey,jobs })) }
      catch { result.failed += jobs.length }
    }
  }
  return {
    checkedPubkeys: tags.length, fetchedEvents: seen.size, delivered: result.delivered, queued: result.queued,
    partialGiftScans: payloads.filter((x) => !x.gift.complete).length, failed: result.failed,
  }
}
