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

export interface QueueBatch {
  jobs: DeliveryJob[]
  observation?: { relay: string; complete: boolean; events: ObservedJob[] }
}

type QueueRequest = { recipient: string } & (QueueBatch | { batches: QueueBatch[] })

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
  discoveryDegraded?: true
}

// A single coordinator issues at most one pair of lists every eight minutes
// (360 calls/day), while the scheduled relay scan still runs every minute.
const MINUTE_MS = 60_000
const DISCOVERY_MINUTES = 8
const DISCOVERY_INTERVAL_MS = DISCOVERY_MINUTES * MINUTE_MS
const DISCOVERY_INTERVAL_SECONDS = DISCOVERY_INTERVAL_MS / 1000
const PER_MINUTE = [6, 2] as const

interface ScanSnapshot {
  scheduledAt: number
  // Old Worker versions have only page; new snapshots hold eight minutes
  // worth of identifiers, but never copy subscription records or endpoints.
  page: ScanPage
  batches?: [string[], string[]]
}

function invalidKvCursor(err: unknown): boolean {
  return err instanceof Error && /\binvalid (?:kv )?cursor\b|\bcursor (?:is )?expired\b/i.test(err.message)
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
      const pre = await this.storage.get<ScanSnapshot>('scan:last')
      if (pre && pre.scheduledAt > scheduledAt) return { ...pre.page, tags: [] }
      const lastAttempt = await this.storage.get<number>('scan:attempt')
      const relayPage = (snapshot: ScanSnapshot | undefined, degraded: boolean): ScanPage => {
        const age = snapshot ? Math.max(0, scheduledAt - snapshot.scheduledAt) : 0
        const minute = Math.floor(age / MINUTE_MS)
        const tags = snapshot?.batches ? snapshot.batches.flatMap((batch, i) => {
          if (batch.length === 0) return []
          const size = PER_MINUTE[i]
          const offset = (minute % Math.ceil(batch.length / size)) * size
          return batch.slice(offset,offset+size)
        }) : snapshot?.page.tags ?? []
        return {
          tags: [...new Set(tags)],
          rotation: (snapshot?.page.rotation ?? 0) + minute,
          periodSeconds: Math.max(snapshot?.page.periodSeconds ?? 0,
            Math.floor(age / 1000) + DISCOVERY_INTERVAL_SECONDS),
          ...(degraded ? { discoveryDegraded: true } : {}),
        }
      }
      const cached = () => relayPage(pre, !pre || pre.scheduledAt !== lastAttempt)
      if (lastAttempt !== undefined && scheduledAt - lastAttempt < DISCOVERY_INTERVAL_MS) return cached()

      // Reserve the budget before I/O, including on empty namespaces, worker
      // restart and outages. A retried scheduled invocation cannot re-list.
      await this.storage.put('scan:attempt', scheduledAt)
      const settled = await Promise.allSettled((['sub:', 'alias:'] as const).map(async (prefix,kind) => {
        const storeKey = 'scan:cursor:'+prefix
        const old = await this.storage.get<ScanCursor>(storeKey) ??
          { startedAt: scheduledAt, rotation: 0, previousPeriod: 0 }
        const limit = PER_MINUTE[kind] * DISCOVERY_MINUTES
        let keys: KVNamespaceListResult<unknown>
        try {
          keys = await this.env.PUSH_KV.list({prefix, limit, cursor: old.cursor})
        } catch (err) {
          // A known invalid/expired cursor restarts NEXT time; quota and
          // transport failures never trigger an immediate second KV request.
          if (old.cursor && invalidKvCursor(err)) {
            const { cursor: _cursor, ...reset } = old
            await this.storage.put(storeKey, reset)
          }
          throw err
        }
        const next: ScanCursor = keys.list_complete ? {
          startedAt: scheduledAt, rotation: old.rotation+1,
          previousPeriod: Math.max(DISCOVERY_INTERVAL_SECONDS,
            Math.floor((scheduledAt-old.startedAt)/1000)+DISCOVERY_INTERVAL_SECONDS),
        } : {...old,cursor:keys.cursor}
        return {storeKey,next,keys:keys.keys.map((entry) => entry.name.slice(prefix.length))}
      }))
      if (settled.some(entry => entry.status === 'rejected')) {
        // No cursor advances on a partially successful page. Previously
        // discovered tags remain usable; the cron rechecks live device state.
        return { ...cached(), discoveryDegraded: true }
      }
      const entries = settled.flatMap(entry => entry.status === 'fulfilled' ? [entry.value] : [])
      const page = {
        tags: [],
        rotation: entries[0].next.rotation,
        periodSeconds: Math.max(...entries.map((x) => Math.max(DISCOVERY_INTERVAL_SECONDS,
          x.next.previousPeriod,Math.floor((scheduledAt-x.next.startedAt)/1000)))),
      }
      const writes = Object.fromEntries(entries.map((x) => [x.storeKey,x.next])) as Record<string,unknown>
      const validTags = (keys: string[]) => keys.filter((key) => /^[a-f0-9]{64}$/.test(key))
      const batches: [string[],string[]] = [validTags(entries[0].keys),validTags(entries[1].keys)]
      const snapshot: ScanSnapshot = {scheduledAt,page,batches}
      // Keep the first bounded slice as a rollback-compatible old-format page.
      snapshot.page.tags = relayPage(snapshot,false).tags
      writes['scan:last'] = snapshot
      await this.storage.put(writes)
      return relayPage(snapshot,false)
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
      // Keep the order of each relay/tag observation while sharing the
      // reads and transaction across all observations for this recipient.
      const batches = 'batches' in input ? input.batches : [input]
      const now = Date.now()
      const writes: Record<string, unknown> = {}
      const deletes: string[] = []
      const readKeys = async <T>(keys: string[]): Promise<Map<string,T>> => {
        const result = new Map<string,T>()
        for (let i=0; i<keys.length; i+=128) {
          for (const [key,value] of await this.storage.get<T>(keys.slice(i,i+128))) result.set(key,value)
        }
        return result
      }
      const relayKeys = new Map<string,string>()
      for (const { observation } of batches) {
        if (observation && !relayKeys.has(observation.relay)) {
          relayKeys.set(observation.relay, BASELINE_PREFIX + await sha256Hex(observation.relay))
        }
      }
      const baselines = await readKeys<number>([...relayKeys.values()])
      // Eligibility for this observation is order-dependent: an incomplete
      // first response must not baseline old traffic, whereas a later
      // response for the same source can build on a complete one.
      const initializedKeys = new Set(baselines.keys())
      const observations = batches.map(({ observation }) => {
        if (!observation) return null
        const baselineKey = relayKeys.get(observation.relay)!
        const initialized = initializedKeys.has(baselineKey)
        if (observation.complete) initializedKeys.add(baselineKey)
        return { ...observation, baselineKey, initialized }
      })
      const observedKeys = [...new Set(observations.flatMap((observation) =>
        observation && (observation.initialized || observation.complete)
          ? observation.events.map(({eventId}) => OBS_PREFIX+eventId) : []
      ))]
      const observed = await readKeys<number>(observedKeys)
      // If a gift wrap was already observed, its device delivery state is
      // irrelevant. Skip both the terminal lookups and the pending scan
      // during ticks that contain only previously observed events.
      const possibleJobs = batches.flatMap(({jobs}, i) => {
        const observation = observations[i]
        return observation?.initialized
          ? jobs.concat(observation.events.filter(({eventId}) => !observed.has(OBS_PREFIX+eventId)))
          : jobs
      })
      const finalKeys = [...new Set(possibleJobs.flatMap((job) => job.targets.map(
        (target) => DONE_PREFIX+`${job.id}:${target.endpointHash}`
      )))]
      const terminal = await readKeys<FinalRow>(finalKeys)
      const existing = finalKeys.length
        ? await this.storage.list<Pending>({ prefix: PENDING_PREFIX, limit: MAX_PENDING + 1 })
        : new Map<string,Pending>()
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
      for (const [i, {jobs}] of batches.entries()) {
        for (const job of jobs) await enqueue(job)
        const observation = observations[i]
        if (!observation) continue
        const { baselineKey, initialized, complete, events } = observation
        // Don't baseline an incomplete first snapshot, which could turn old
        // unobserved messages into new notifications on the first healthy poll.
        if (!initialized && !complete) continue
        for (const event of events) {
          const key = OBS_PREFIX + event.eventId
          if (key in writes || observed.has(key)) continue
          if (initialized && !await enqueue(event)) continue
          writes[key] = 1
          track(key, now + WINDOW_MS)
        }
        if (complete && !initialized) writes[baselineKey] = 1
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
