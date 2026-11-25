import type { Env, IncomingPushPayload, StoredUserRecord } from './types.ts'
import { publicRoomEnabled, subKeyForPubkey } from './types.ts'
import { sendWebPushNotification, sha256Hex } from './webpush.ts'

export type Counts = { delivered: number; queued: number; duplicates: number; permanentFailures: number; failed: number }
export const emptyCounts = (): Counts => ({ delivered: 0, queued: 0, duplicates: 0, permanentFailures: 0, failed: 0 })
export function addCounts(to: Counts, from: Counts): void {
  for (const k of Object.keys(to) as (keyof Counts)[]) to[k] += from[k]
}

export interface Target {
  endpointHash: string
  preferences: string
  room?: string
  payload: IncomingPushPayload
}

export interface DeliveryJob {
  id: string
  targets: Target[]
  ttlSeconds: number
  topic?: string
}

interface ObservedJob extends DeliveryJob {
  eventId: string
}

interface QueueRequest {
  recipient: string
  jobs: DeliveryJob[]
  observation?: { relay: string; complete: boolean; events: ObservedJob[] }
}

interface Pending extends Target {
  recipient: string
  id: string
  deadline: number
  topic?: string
  nextAt: number
  attempts: number
}

interface FinalRow { outcome: 'accepted' | 'failed' | 'cancelled'; expiresAt: number }

const MAX_PENDING = 150
const MAX_ATTEMPTS = 10
const WINDOW_MS = 60 * 60 * 60_000
const PENDING_PREFIX = 'pending:'
const DONE_PREFIX = 'done:'
const BASELINE_PREFIX = 'baseline:'
const OBS_PREFIX = 'seen:'
const TIME_PREFIX = 'expire:'
const RETRY_DELAYS_MS = [4_000, 15_000, 60_000, 180_000, 600_000, 2_400_000, 7_200_000, 14_400_000, 21_600_000]
const bucketKey = (at: number, key: string) => `${TIME_PREFIX}${String(Math.ceil(at/3_600_000)).padStart(9,'0')}:${key}`
const expiredCutoff = (at: number) => TIME_PREFIX + String(Math.floor(at/3_600_000)).padStart(9,'0') + ';'

export interface ScanPage {
  tags: string[]
  rotation: number
  periodSeconds: number
}

interface ScanCursor {
  cursor?: string
  startedAt: number
  rotation: number
  previousPeriod: number
}

/** Independent KV keys are the recipient index. A single durable cursor never
 * writes or races with another account's subscription or a shared JSON list. */
export async function nextScanPage(env: Env, scheduledAt: number): Promise<ScanPage> {
  const namespace = env.PUSH_DELIVERY
  const stub = namespace.get(namespace.idFromName('agnostr-relay-scan-v2'))
  const response = await stub.fetch('https://delivery.internal/scan-page', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({scheduledAt}),
  })
  if (!response.ok) throw new Error(`Durable relay scan cursor failed: ${response.status}`)
  return response.json<ScanPage>()
}

export async function queueJobs(env: Env, input: QueueRequest): Promise<Counts> {
  const namespace = env.PUSH_DELIVERY
  const stub = namespace.get(namespace.idFromName(input.recipient))
  const response = await stub.fetch('https://delivery.internal/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(`Durable push enqueue failed: ${response.status}`)
  return response.json<Counts>()
}

// A provider's acceptance is not proof the operating system displayed the message.
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500
}

export class PushDelivery {
  private readonly storage: DurableObjectStorage
  private readonly state: DurableObjectState
  private readonly env: Env
  private draining = false

  constructor(state: DurableObjectState, env: Env) {
    this.storage = state.storage
    this.state = state
    this.env = env
  }

  private async schedule(at: number): Promise<void> {
    const current = await this.storage.getAlarm()
    const due = Math.max(Date.now() + 1, at)
    if (current === null || current > due) await this.storage.setAlarm(due)
  }

  private async scanPage(scheduledAt: number): Promise<ScanPage> {
    return this.state.blockConcurrencyWhile(async () => {
      const pre = await this.storage.get<{scheduledAt: number, page: ScanPage}>('scan:last')
      if (pre?.scheduledAt === scheduledAt) return pre.page
      if (pre && pre.scheduledAt > scheduledAt) return { ...pre.page, tags: [] }
      const entries = await Promise.all((['sub:', 'alias:'] as const).map(async (prefix,kind) => {
        const storeKey = 'scan:cursor:'+prefix
        let old = await this.storage.get<ScanCursor>(storeKey)
        const base = { startedAt: scheduledAt, rotation: old?.rotation ?? 0, previousPeriod: old?.previousPeriod ?? 0 }
        old ??= base
        const limit = kind===0 ? 6 : 2
        const keys = await this.env.PUSH_KV.list({ prefix, limit, cursor: old.cursor }).catch((err) => {
          if (!old?.cursor) throw err
          return this.env.PUSH_KV.list({prefix,limit})
        })
        const next: ScanCursor = keys.list_complete ? {
          startedAt: scheduledAt, rotation: old.rotation+1,
          previousPeriod: Math.max(60,Math.floor((scheduledAt-old.startedAt)/1000)+60),
        } : {...old,cursor:keys.cursor}
        return {storeKey,next,keys:keys.keys.map((entry) => entry.name.slice(prefix.length))}
      }))
      const page = {
        tags: [...new Set(entries.flatMap((x) => x.keys.filter((key) => /^[a-f0-9]{64}$/.test(key))))],
        rotation: entries[0].next.rotation,
        periodSeconds: Math.max(...entries.map((x) => Math.max(x.next.previousPeriod,Math.floor((scheduledAt-x.next.startedAt)/1000)))),
      }
      const writes = Object.fromEntries(entries.map((x) => [x.storeKey,x.next])) as Record<string,unknown>
      writes['scan:last'] = {scheduledAt,page}
      await this.storage.put(writes)
      return page
    })
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname
    if (request.method === 'POST' && pathname === '/scan-page') {
      const {scheduledAt} = await request.json<{scheduledAt: number}>()
      if (!Number.isSafeInteger(scheduledAt)) return new Response(null,{status:400})
      return Response.json(await this.scanPage(scheduledAt))
    }
    if (request.method !== 'POST' || pathname !== '/queue') return new Response(null, { status: 404 })
    const input = await request.json<QueueRequest>()
    const counts = await this.state.blockConcurrencyWhile(async () => {
      const result = emptyCounts()
      const existing = await this.storage.list<Pending>({ prefix: PENDING_PREFIX, limit: MAX_PENDING + 1 })
      const now = Date.now()
      const writes: Record<string, unknown> = {}
      const deletes: string[] = []
      const allJobs = input.jobs.concat(input.observation?.events ?? [])
      const finalKeys = [...new Set(allJobs.flatMap((job) => job.targets.map(
        (target) => DONE_PREFIX+`${job.id}:${target.endpointHash}`
      )))]
      const observedKeys = [...new Set((input.observation?.events ?? []).map((event) => OBS_PREFIX+event.eventId))]
      const readKeys = async <T>(keys: string[]): Promise<Map<string,T>> => {
        const result = new Map<string,T>()
        for (let i=0; i<keys.length; i+=128) {
          for (const [key,value] of await this.storage.get<T>(keys.slice(i,i+128))) result.set(key,value)
        }
        return result
      }
      const terminal = await readKeys<FinalRow>(finalKeys)
      const observed = await readKeys<number>(observedKeys)
      const track = (key: string, expires: number) => { writes[bucketKey(expires, key)] = key }
      const enqueue = async (job: DeliveryJob): Promise<boolean> => {
        let fullyQueued = true
        for (const target of job.targets) {
          const local = `${job.id}:${target.endpointHash}`
          const key = PENDING_PREFIX + local
          const doneKey = DONE_PREFIX + local
          const previous = terminal.get(doneKey)
          if (previous?.outcome === 'failed' || previous?.outcome === 'cancelled') {
            result.permanentFailures++; result.failed++; continue
          }
          if ((previous?.outcome === 'accepted') || seenWithinRequest.has(key) || existing.has(key)) { result.duplicates++; continue }

          if (job.topic && target.payload.action === 'call-cancel') {
            // Cancelling a call must remove a still-queued ring before the next attempt.
            for (const [oldKey, row] of existing) {
              if (row.topic === job.topic && row.endpointHash === target.endpointHash && row.payload.data?.category === 'dm-call') {
                deletes.push(oldKey)
                existing.delete(oldKey)
                const terminalKey = DONE_PREFIX + oldKey.slice(PENDING_PREFIX.length)
                writes[terminalKey] = { outcome: 'cancelled', expiresAt: now + WINDOW_MS } satisfies FinalRow
                track(terminalKey, now + WINDOW_MS)
              }
            }
          }

          if (existing.size + seenWithinRequest.size >= MAX_PENDING) {
            result.failed++
            fullyQueued = false
            continue
          }
          writes[key] = {
            ...target, recipient: input.recipient, id: job.id, deadline: now + job.ttlSeconds * 1000,
            topic: job.topic, attempts: 0, nextAt: now,
          } satisfies Pending
          seenWithinRequest.add(key)
          result.queued++
        }
        return fullyQueued
      }

      const seenWithinRequest = new Set<string>()
      for (const job of input.jobs) await enqueue(job)
      if (input.observation) {
        const { relay, complete, events } = input.observation
        const baselineKey = BASELINE_PREFIX + await sha256Hex(relay)
        const initialized = Boolean(await this.storage.get(baselineKey))
        // Don't baseline an incomplete first snapshot, which could turn old unobserved
        // messages into new notifications on the first healthy poll.
        if (initialized || complete) {
          for (const event of events) {
            const key = OBS_PREFIX + event.eventId
            if (key in writes || observed.has(key)) continue
            if (initialized && !await enqueue(event)) continue
            writes[key] = 1
            track(key, now + WINDOW_MS)
          }
          if (complete && !initialized) writes[baselineKey] = 1
        }
      }
      // Persist alarm scheduling before data so a lost request cannot strand durable work.
      await this.schedule(seenWithinRequest.size || deletes.length ? now : now + WINDOW_MS)
      if (Object.keys(writes).length || deletes.length) {
        await this.storage.transaction(async (txn) => {
          for (let i=0; i<deletes.length; i+=128) await txn.delete(deletes.slice(i,i+128))
          const entries=Object.entries(writes)
          for (let i=0; i<entries.length; i+=128) await txn.put(Object.fromEntries(entries.slice(i,i+128)))
        })
      }
      return result
    })
    if (counts.queued > 0) this.state.waitUntil(this.drain())
    return Response.json(counts)
  }

  private async finish(key: string, outcome: FinalRow['outcome']): Promise<void> {
    const done = DONE_PREFIX + key.slice(PENDING_PREFIX.length)
    const expiresAt = Date.now() + WINDOW_MS
    await this.storage.transaction(async (txn) => {
      // A newer cancellation may already have removed the old ring job.
      if (!await txn.get(key)) return
      await txn.put({ [done]: { outcome, expiresAt } satisfies FinalRow, [bucketKey(expiresAt, done)]: done })
      await txn.delete(key)
    })
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      const now = Date.now()
      const entries = await this.storage.list<Pending>({ prefix: PENDING_PREFIX, limit: MAX_PENDING + 1 })
      let runs = 0
      for (const [key, row] of entries) {
        if (row.deadline <= now) { await this.finish(key, 'failed'); continue }
        if (row.nextAt > now || runs >= 8) continue
        if (!await this.storage.get(key)) continue
        runs++
        const recipient = await this.env.PUSH_KV.get<StoredUserRecord>(subKeyForPubkey(row.recipient), 'json')
        const device = recipient?.devices?.find((dev) => dev.endpointHash === row.endpointHash)
        if (!device) {
          // KV reads on two edge locations can disagree briefly right after registration.
          if (row.attempts < 2 && Date.now()+5_000 < row.deadline) {
            await this.storage.transaction(async (txn) => {
              if (await txn.get(key)) await txn.put(key, { ...row, nextAt: Date.now()+5_000, attempts: row.attempts+1 })
            })
          } else await this.finish(key, 'cancelled')
          continue
        }
        // Do not retransmit a previously queued preview after device preferences changed.
        if (JSON.stringify(device.preferences) !== row.preferences
          || (row.room !== undefined && (!publicRoomEnabled(device) || !device.geohashes.includes(row.room)))) {
          await this.finish(key, 'cancelled')
          continue
        }
        const expired = `gone:${row.endpointHash}:${device.updatedAt}`
        if (await this.storage.get(expired)) { await this.finish(key, 'failed'); continue }

        const response = await sendWebPushNotification({
          subscription: device.subscription, payload: row.payload,
          vapidPublicKey: this.env.VAPID_PUBLIC_KEY, vapidPrivateKey: this.env.VAPID_PRIVATE_KEY,
          vapidSubject: this.env.VAPID_SUBJECT, ttlSeconds: Math.min(Math.max(1, Math.floor((row.deadline-Date.now())/1000)), 86_400),
          urgency: 'high', topic: row.topic,
        })
        console.info('push provider attempt', { status: response.status, attempt: row.attempts+1,
          accepted: response.ok, expired: response.expired })
        if (response.ok) {
          await this.finish(key, 'accepted')
        } else if (response.expired || !isRetryableStatus(response.status) || row.attempts + 1 >= MAX_ATTEMPTS) {
          if (response.expired) {
            const until = Date.now()+WINDOW_MS
            await this.storage.put({ [expired]: 1, [bucketKey(until, expired)]: expired })
          }
          await this.finish(key, 'failed')
        } else {
          const nextAt = Date.now()+Math.max(RETRY_DELAYS_MS[row.attempts] ?? 60_000, response.retryAfterMs ?? 0)
          if (nextAt >= row.deadline) await this.finish(key, 'failed')
          else await this.storage.transaction(async (txn) => {
            if (await txn.get(key)) await txn.put(key, { ...row, nextAt, attempts: row.attempts+1 })
          })
        }
      }
    } finally {
      this.draining = false
      const now = Date.now()
      const remaining = await this.storage.list<Pending>({ prefix: PENDING_PREFIX, limit: MAX_PENDING + 1 })
      const prune = await this.storage.list<string>({ start: TIME_PREFIX, end: expiredCutoff(now), limit: 128 })
      const deleted=[...prune.keys(), ...prune.values()]
      for (let i=0; i<deleted.length; i+=128) await this.storage.delete(deleted.slice(i,i+128))
      const expiry = await this.storage.list({ prefix: TIME_PREFIX, limit: 1 })
      const first = expiry.keys().next().value as string | undefined
      const earliest = first ? Number(first.slice(TIME_PREFIX.length).split(':')[0])*3_600_000 : Infinity
      const next = Math.min(earliest, ...Array.from(remaining.values(), (row) => Math.min(row.nextAt,row.deadline)))
      if (Number.isFinite(next)) await this.schedule(next)
    }
  }

  async alarm(): Promise<void> {
    // If an immediate handoff is already draining, preserve another durable
    // wake even if that asynchronous request is interrupted or evicted.
    if (this.draining) { await this.schedule(Date.now()+30_000); return }
    await this.drain()
  }
}
