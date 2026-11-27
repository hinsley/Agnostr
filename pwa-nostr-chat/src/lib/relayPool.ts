import type { Event as NostrEvent, Filter } from 'nostr-tools'
import type { RelayRole, RelayStatus, RelayTelemetry } from '../types/protocol.ts'
import {
  getEventVerificationCacheResult,
  markEventVerifiedCached,
} from './bitchatProtocol.ts'
import type { SelectedRelayMeta } from './geoRelays.ts'
import {
  isOffMainThreadWorkerSupported,
  verifyEventsBatchOffMainThread,
} from './offMainThread.ts'

export type Nip42AuthSigner = (relayUrl: string, challenge: string) => Promise<NostrEvent | null>

export interface SubscriptionHandlers {
  onEvent: (event: NostrEvent, relayUrl: string) => void
  onEose?: (relayUrl: string) => void
  onRelayReset?: (relayUrl: string) => void
}

export interface PublishResult {
  eventId: string
  acceptedRelays: string[]
  rejectedRelays: Array<{ url: string; reason: string }>
  sentCount: number
}

interface PendingOk {
  eventId: string
  sentAt: number
  resolve: (result: { ok: boolean; reason: string }) => void
  timer: number
}

interface ActiveSub {
  logicalId: string
  wireId: string
  relays: Set<string>
  filters: Filter[]
  handlers: SubscriptionHandlers
  eoseReceived: Set<string>
  closed: boolean
}

interface RelayConnection {
  url: string
  ws: WebSocket | null
  status: RelayStatus
  roles: RelayRole[]
  lat?: number
  lon?: number
  distanceKm?: number
  supportsDm: boolean
  supportsEphemeral: boolean
  rttMs: number | null
  rttHistory: number[]
  rxCount: number
  txCount: number
  okCount: number
  rejectCount: number
  connectedAt: number | null
  lastActivityAt: number | null
  lastError: string | null
  reconnectAttempts: number
  handshakeFailures: number
  everConnected: boolean
  nextRetryAt: number | null
  reconnectTimer: number | null
  connectStartedAt: number | null
  activeSubIds: Set<string>
  pendingOks: Map<string, PendingOk>
  pendingAuthId: string | null
  authenticated: boolean
  manuallyClosed: boolean
}

const MAX_RTT_HISTORY = 16
const BASE_RECONNECT_MS = 2000
const MAX_RECONNECT_MS = 60_000
const HANDSHAKE_BASE_BACKOFF_MS = 10_000
const HANDSHAKE_MAX_BACKOFF_MS = 300_000
const MAX_HANDSHAKE_FAILURES = 3
const FRAME_BUDGET_MS = 8
const VERIFY_BATCH_MAX = 32

interface QueuedRawFrame {
  conn: RelayConnection
  ws: WebSocket
  raw: string
}

type PendingDispatchItem =
  | {
      kind: 'event'
      conn: RelayConnection
      ws: WebSocket
      wireSubId: string
      event: NostrEvent
    }
  | {
      kind: 'eose'
      conn: RelayConnection
      ws: WebSocket
      wireSubId: string
    }

export class RelayPool {
  private connections = new Map<string, RelayConnection>()
  /** Keyed by strictly unique monotonic wireId so late in-flight frames can NEVER collide across rapid resubscribes */
  private subscriptions = new Map<string, ActiveSub>()
  /** Maps caller logical subId -> current active wireId */
  private logicalToWire = new Map<string, string>()
  private nextSubSeq = 0
  private telemetryListeners = new Set<(telemetry: RelayTelemetry[]) => void>()
  private authSigner: Nip42AuthSigner | null = null
  private emitTimer: number | null = null
  private lastHiddenAt: number | null = null
  private disposed = false

  // Frame-budgeted inbound message & off-main-thread batch verification pipeline
  private inboundRawQueue: QueuedRawFrame[] = []
  private inboundRawHead = 0
  private pendingDispatchQueue: PendingDispatchItem[] = []
  private pendingDispatchHead = 0
  private inFlightVerifyIds = new Set<string>()
  private verifyEpoch = 0
  private yieldChannel: MessageChannel | null = null
  private yieldPending = false
  private yieldFallbackTimer: ReturnType<typeof setTimeout> | null = null
  private inboundScheduled = false
  private dispatchScheduled = false

  private readonly handleVisibilityChange = (): void => {
    if (this.disposed || typeof document === 'undefined') return
    if (document.visibilityState === 'hidden') {
      this.lastHiddenAt = Date.now()
      return
    }
    const hiddenMs = this.lastHiddenAt !== null ? Date.now() - this.lastHiddenAt : 0
    this.lastHiddenAt = null
    // After mobile background suspension (>15s), WebSockets may be half-open TCP zombies.
    // Refresh sockets that have had no traffic for >30s and wake any backed-off sockets.
    this.ensureRelaysAlive(undefined, { staleMs: hiddenMs >= 15_000 ? 30_000 : undefined })
  }

  private readonly handleOnline = (): void => {
    if (this.disposed) return
    this.ensureRelaysAlive(undefined, { staleMs: 15_000 })
  }

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline)
    }
  }

  setAuthSigner(signer: Nip42AuthSigner | null): void {
    this.authSigner = signer
  }

  onTelemetryChange(listener: (telemetry: RelayTelemetry[]) => void): () => void {
    this.telemetryListeners.add(listener)
    listener(this.getTelemetrySnapshot())
    return () => {
      this.telemetryListeners.delete(listener)
    }
  }

  getTelemetrySnapshot(): RelayTelemetry[] {
    const list: RelayTelemetry[] = []
    for (const conn of this.connections.values()) {
      list.push({
        url: conn.url,
        status: conn.status,
        roles: [...conn.roles],
        lat: conn.lat,
        lon: conn.lon,
        distanceKm: conn.distanceKm,
        rttMs: conn.rttMs,
        rttHistory: [...conn.rttHistory],
        rxCount: conn.rxCount,
        txCount: conn.txCount,
        okCount: conn.okCount,
        rejectCount: conn.rejectCount,
        connectedAt: conn.connectedAt,
        lastActivityAt: conn.lastActivityAt,
        lastError: conn.lastError,
        reconnectAttempts: conn.reconnectAttempts,
        supportsEphemeral: conn.supportsEphemeral,
        supportsDm: conn.supportsDm,
      })
    }
    list.sort((a, b) => {
      const rank = (s: RelayStatus) =>
        s === 'connected' ? 0 : s === 'connecting' ? 1 : s === 'degraded' ? 2 : 3
      const rDiff = rank(a.status) - rank(b.status)
      if (rDiff !== 0) return rDiff
      return (a.rttMs ?? 9999) - (b.rttMs ?? 9999)
    })
    return list
  }

  syncMetadata(metadata: Map<string, SelectedRelayMeta>, keepUrls: Set<string>): void {
    if (this.disposed) return

    for (const [url, meta] of metadata.entries()) {
      const existing = this.connections.get(url)
      if (existing) {
        existing.roles = [...meta.roles]
        existing.lat = meta.lat
        existing.lon = meta.lon
        existing.distanceKm = meta.distanceKm
        existing.supportsDm = meta.supportsDm
      } else if (keepUrls.has(url)) {
        this.ensureConnection(url, meta)
      }
    }

    // Close and prune relays that are no longer referenced by any active role or subscription
    for (const [url, conn] of Array.from(this.connections.entries())) {
      if (!keepUrls.has(url) && conn.activeSubIds.size === 0) {
        this.closeConnection(conn)
        this.connections.delete(url)
      }
    }

    this.scheduleTelemetryEmit()
  }

  subscribe(
    subId: string,
    relayUrls: readonly string[],
    filters: Filter[],
    handlers: SubscriptionHandlers
  ): () => void {
    if (this.disposed) return () => {}

    // Replace existing subscription under the same logical ID synchronously before minting a new wireId
    const existingWireId = this.logicalToWire.get(subId)
    if (existingWireId) {
      this.unsubscribeByWireId(existingWireId)
    }

    const seq = ++this.nextSubSeq
    const seqStr = String(seq)
    const maxPrefixLen = Math.max(1, 56 - seqStr.length)
    const wireId = `${subId.slice(0, maxPrefixLen)}-${seqStr}`

    const relaySet = new Set(relayUrls)
    const sub: ActiveSub = {
      logicalId: subId,
      wireId,
      relays: relaySet,
      filters,
      handlers,
      eoseReceived: new Set(),
      closed: false,
    }
    this.subscriptions.set(wireId, sub)
    this.logicalToWire.set(subId, wireId)

    for (const url of relaySet) {
      const conn = this.ensureConnection(url)
      conn.activeSubIds.add(wireId)
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        this.sendReq(conn, sub)
      }
    }

    this.scheduleTelemetryEmit()
    return () => this.unsubscribeByWireId(wireId)
  }

  unsubscribe(subId: string): void {
    const wireId = this.logicalToWire.get(subId) ?? (this.subscriptions.has(subId) ? subId : null)
    if (wireId) {
      this.unsubscribeByWireId(wireId)
    }
  }

  private unsubscribeByWireId(wireId: string): void {
    const sub = this.subscriptions.get(wireId)
    if (!sub) return
    // Synchronously mark closed & remove from callback map BEFORE sending CLOSE so in-flight frames drop immediately
    sub.closed = true
    this.subscriptions.delete(wireId)
    if (this.logicalToWire.get(sub.logicalId) === wireId) {
      this.logicalToWire.delete(sub.logicalId)
    }

    for (const url of sub.relays) {
      const conn = this.connections.get(url)
      if (!conn) continue
      conn.activeSubIds.delete(wireId)
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(JSON.stringify(['CLOSE', wireId]))
          conn.txCount += 1
        } catch {
          // Ignore close send error
        }
      }
    }
    this.scheduleTelemetryEmit()
  }

  /** Wait before constructing a chat event, rather than aging its timestamp during reconnect. */
  async waitForChatRelay(relayUrls: readonly string[]): Promise<boolean> {
    try {
      await Promise.any(Array.from(new Set(relayUrls), async (url) => {
        if (!await this.waitForOpen(this.ensureConnection(url), 1800)) throw new Error('Relay is offline')
      }))
      return true
    } catch {
      return false
    }
  }

  async publish(
    relayUrls: readonly string[],
    event: NostrEvent,
    timeoutMs = 4500,
    onAccepted?: (count: number) => void
  ): Promise<PublishResult> {
    const acceptedRelays: string[] = []
    const rejectedRelays: Array<{ url: string; reason: string }> = []
    let sentCount = 0

    const uniqueUrls = Array.from(new Set(relayUrls))
    const promises = uniqueUrls.map(async (url) => {
      const conn = this.ensureConnection(url)
      const ready = await this.waitForOpen(conn, 1800)
      if (!ready || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
        rejectedRelays.push({ url, reason: 'not connected' })
        return
      }

      const sentAt = performance.now()
      try {
        conn.ws.send(JSON.stringify(['EVENT', event]))
        conn.txCount += 1
        conn.lastActivityAt = Date.now()
        sentCount += 1
      } catch (err) {
        rejectedRelays.push({ url, reason: err instanceof Error ? err.message : 'send error' })
        return
      }

      const okRes = await new Promise<{ ok: boolean; reason: string }>((resolve) => {
        const timer = window.setTimeout(() => {
          conn.pendingOks.delete(event.id)
          resolve({ ok: false, reason: 'timeout' })
        }, timeoutMs)

        conn.pendingOks.set(event.id, {
          eventId: event.id,
          sentAt,
          resolve,
          timer,
        })
      })

      if (okRes.ok) {
        acceptedRelays.push(url)
        onAccepted?.(acceptedRelays.length)
      } else {
        rejectedRelays.push({ url, reason: okRes.reason || 'rejected' })
      }
    })

    await Promise.all(promises)
    this.scheduleTelemetryEmit()
    return {
      eventId: event.id,
      acceptedRelays,
      rejectedRelays,
      sentCount,
    }
  }

  /**
   * Ensures target relays (or all tracked relays) are actively connected, bypassing backoff
   * and refreshing stale half-open mobile sockets when requested.
   */
  ensureRelaysAlive(relayUrls?: readonly string[], opts?: { staleMs?: number }): void {
    if (this.disposed) return
    const now = Date.now()
    const staleMs = opts?.staleMs
    const targets: RelayConnection[] = []

    if (relayUrls && relayUrls.length > 0) {
      for (const url of new Set(relayUrls)) {
        targets.push(this.ensureConnection(url))
      }
    } else {
      for (const conn of this.connections.values()) {
        targets.push(conn)
      }
    }

    let touched = false
    for (const conn of targets) {
      if (conn.manuallyClosed) continue
      const readyState = conn.ws?.readyState
      const isOpen = readyState === WebSocket.OPEN
      const isConnecting = readyState === WebSocket.CONNECTING
      const lastTraffic = conn.lastActivityAt ?? conn.connectedAt ?? 0
      const isStaleOpen =
        isOpen &&
        typeof staleMs === 'number' &&
        staleMs > 0 &&
        lastTraffic > 0 &&
        now - lastTraffic > staleMs

      if (!isOpen && !isConnecting) {
        conn.reconnectAttempts = 0
        conn.handshakeFailures = 0
        conn.nextRetryAt = null
        conn.lastError = null
        this.closeSocketOnly(conn)
        this.openConnection(conn)
        touched = true
      } else if (isStaleOpen) {
        conn.reconnectAttempts = 0
        conn.handshakeFailures = 0
        conn.nextRetryAt = null
        this.closeSocketOnly(conn)
        this.openConnection(conn)
        touched = true
      }
    }

    if (touched) {
      this.scheduleTelemetryEmit()
    }
  }

  reconnectAll(): void {
    if (this.disposed) return
    for (const conn of this.connections.values()) {
      conn.reconnectAttempts = 0
      conn.handshakeFailures = 0
      conn.nextRetryAt = null
      conn.lastError = null
      this.closeSocketOnly(conn)
      conn.manuallyClosed = false
      this.openConnection(conn)
    }
    this.scheduleTelemetryEmit()
  }

  closeAll(): void {
    this.resetInboundPipeline()
    for (const wireId of Array.from(this.subscriptions.keys())) {
      this.unsubscribeByWireId(wireId)
    }
    this.logicalToWire.clear()
    for (const conn of this.connections.values()) {
      this.closeConnection(conn)
    }
    this.connections.clear()
    this.scheduleTelemetryEmit()
  }

  revive(): void {
    if (!this.disposed) return
    this.disposed = false
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline)
    }
  }

  dispose(): void {
    this.disposed = true
    this.resetInboundPipeline()
    if (this.yieldChannel) {
      try {
        this.yieldChannel.port1.onmessage = null
        this.yieldChannel.port1.close()
        this.yieldChannel.port2.close()
      } catch {
        // Ignore MessageChannel close error
      }
      this.yieldChannel = null
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline)
    }
    if (this.emitTimer !== null) {
      window.clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    this.closeAll()
    this.telemetryListeners.clear()
  }

  private ensureConnection(url: string, meta?: SelectedRelayMeta): RelayConnection {
    const existing = this.connections.get(url)
    if (existing) {
      if (meta) {
        existing.roles = [...meta.roles]
        existing.lat = meta.lat
        existing.lon = meta.lon
        existing.distanceKm = meta.distanceKm
        existing.supportsDm = meta.supportsDm
      }
      const haltedOnHandshake = !existing.everConnected && existing.handshakeFailures >= MAX_HANDSHAKE_FAILURES
      const backingOff = existing.nextRetryAt !== null && Date.now() < existing.nextRetryAt
      if (
        !existing.ws &&
        !existing.manuallyClosed &&
        existing.reconnectTimer === null &&
        !haltedOnHandshake &&
        !backingOff
      ) {
        this.openConnection(existing)
      }
      return existing
    }

    const conn: RelayConnection = {
      url,
      ws: null,
      status: 'connecting',
      roles: meta ? [...meta.roles] : ['custom'],
      lat: meta?.lat,
      lon: meta?.lon,
      distanceKm: meta?.distanceKm,
      supportsDm: meta?.supportsDm ?? false,
      supportsEphemeral: true,
      rttMs: null,
      rttHistory: [],
      rxCount: 0,
      txCount: 0,
      okCount: 0,
      rejectCount: 0,
      connectedAt: null,
      lastActivityAt: null,
      lastError: null,
      reconnectAttempts: 0,
      handshakeFailures: 0,
      everConnected: false,
      nextRetryAt: null,
      reconnectTimer: null,
      connectStartedAt: null,
      activeSubIds: new Set(),
      pendingOks: new Map(),
      pendingAuthId: null,
      authenticated: false,
      manuallyClosed: false,
    }
    this.connections.set(url, conn)
    this.openConnection(conn)
    return conn
  }

  private openConnection(conn: RelayConnection): void {
    if (this.disposed || conn.manuallyClosed) return
    if (conn.reconnectTimer !== null) {
      window.clearTimeout(conn.reconnectTimer)
      conn.reconnectTimer = null
    }

    conn.status = 'connecting'
    conn.connectStartedAt = performance.now()

    let ws: WebSocket
    try {
      ws = new WebSocket(conn.url)
    } catch (err) {
      conn.status = 'error'
      conn.lastError = err instanceof Error ? err.message : 'invalid url'
      this.scheduleReconnect(conn)
      this.scheduleTelemetryEmit()
      return
    }

    conn.ws = ws
    let socketOpened = false

    ws.addEventListener('open', () => {
      if (conn.ws !== ws || this.disposed) return
      socketOpened = true
      const rtt = conn.connectStartedAt !== null ? Math.round(performance.now() - conn.connectStartedAt) : null
      conn.status = 'connected'
      conn.everConnected = true
      conn.connectedAt = Date.now()
      conn.lastActivityAt = Date.now()
      conn.lastError = null
      conn.reconnectAttempts = 0
      conn.handshakeFailures = 0
      conn.nextRetryAt = null
      if (rtt !== null && rtt >= 0 && rtt < 15000) {
        this.recordRtt(conn, rtt)
      }

      // Replay all active subscriptions targeting this relay
      for (const subId of conn.activeSubIds) {
        const sub = this.subscriptions.get(subId)
        if (sub) {
          sub.eoseReceived.delete(conn.url)
          sub.handlers.onRelayReset?.(conn.url)
          this.sendReq(conn, sub)
        }
      }

      this.scheduleTelemetryEmit()
    })

    ws.addEventListener('message', (msgEvent) => {
      if (conn.ws !== ws || this.disposed) return
      conn.rxCount += 1
      conn.lastActivityAt = Date.now()
      if (typeof msgEvent.data !== 'string') return
      const raw = msgEvent.data
      // Keep OK / AUTH / NOTICE control frames immediately responsive even during EVENT bursts
      if (
        raw.startsWith('["OK"') ||
        raw.startsWith('["AUTH"') ||
        raw.startsWith('["NOTICE"')
      ) {
        this.handleImmediateControlFrame(conn, raw)
        return
      }
      this.inboundRawQueue.push({ conn, ws, raw })
      this.scheduleInboundDrain()
    })

    ws.addEventListener('error', () => {
      if (conn.ws !== ws || this.disposed) return
      conn.lastError = 'connection error'
      if (conn.status !== 'connected') {
        conn.status = 'error'
      } else {
        conn.status = 'degraded'
      }
      this.scheduleTelemetryEmit()
    })

    ws.addEventListener('close', (ev) => {
      if (conn.ws !== ws) return
      conn.ws = null
      conn.pendingAuthId = null
      conn.authenticated = false
      // Fail pending OKs
      for (const pending of conn.pendingOks.values()) {
        window.clearTimeout(pending.timer)
        pending.resolve({ ok: false, reason: 'socket closed' })
      }
      conn.pendingOks.clear()

      if (conn.manuallyClosed || this.disposed) {
        conn.status = 'disconnected'
      } else {
        if (!socketOpened) {
          conn.handshakeFailures += 1
        }
        conn.status = ev.wasClean ? 'disconnected' : 'error'
        if (!ev.wasClean && !conn.lastError) {
          conn.lastError = `closed (${ev.code})`
        }
        this.scheduleReconnect(conn)
      }
      this.scheduleTelemetryEmit()
    })
  }

  private sendReq(conn: RelayConnection, sub: ActiveSub): void {
    if (sub.closed || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) return
    try {
      conn.ws.send(JSON.stringify(['REQ', sub.wireId, ...sub.filters]))
      conn.txCount += 1
    } catch {
      // Ignore send failure
    }
  }

  private resetInboundPipeline(): void {
    this.verifyEpoch += 1
    this.inboundRawQueue = []
    this.inboundRawHead = 0
    this.pendingDispatchQueue = []
    this.pendingDispatchHead = 0
    this.inFlightVerifyIds.clear()
    this.inboundScheduled = false
    this.dispatchScheduled = false
    this.yieldPending = false
    if (this.yieldFallbackTimer !== null) {
      clearTimeout(this.yieldFallbackTimer)
      this.yieldFallbackTimer = null
    }
  }

  private triggerYield(): void {
    if (this.yieldPending || this.disposed) return
    this.yieldPending = true

    if (typeof MessageChannel !== 'undefined') {
      if (!this.yieldChannel) {
        const ch = new MessageChannel()
        ch.port1.onmessage = () => {
          this.yieldPending = false
          this.runScheduledWork()
        }
        this.yieldChannel = ch
      }
      this.yieldChannel.port2.postMessage(null)
      return
    }

    this.yieldFallbackTimer = setTimeout(() => {
      this.yieldFallbackTimer = null
      this.yieldPending = false
      this.runScheduledWork()
    }, 0)
  }

  private scheduleInboundDrain(): void {
    if (this.disposed) return
    this.inboundScheduled = true
    this.triggerYield()
  }

  private scheduleDispatchDrain(): void {
    if (this.disposed) return
    this.dispatchScheduled = true
    this.triggerYield()
  }

  private runScheduledWork(): void {
    if (this.disposed) return
    const sliceStart = performance.now()
    if (this.inboundScheduled) {
      this.inboundScheduled = false
      this.drainInboundRawSlice(sliceStart)
    }
    if (this.dispatchScheduled) {
      if (performance.now() - sliceStart >= FRAME_BUDGET_MS) {
        this.triggerYield()
        return
      }
      this.dispatchScheduled = false
      this.drainDispatchSlice(sliceStart)
    }
  }

  private drainInboundRawSlice(sliceStart: number): void {
    const unverifiedBatch: NostrEvent[] = []
    let processed = 0

    while (this.inboundRawHead < this.inboundRawQueue.length) {
      if (
        processed > 0 &&
        (performance.now() - sliceStart >= FRAME_BUDGET_MS ||
          unverifiedBatch.length >= VERIFY_BATCH_MAX)
      ) {
        break
      }

      const frame = this.inboundRawQueue[this.inboundRawHead++]
      processed += 1

      if (this.disposed || frame.conn.ws !== frame.ws) continue

      let parsed: unknown
      try {
        parsed = JSON.parse(frame.raw)
      } catch {
        continue
      }
      if (!Array.isArray(parsed) || parsed.length < 2) continue

      const frameType = parsed[0]
      if (frameType === 'EVENT' && parsed.length >= 3) {
        const wireSubId = typeof parsed[1] === 'string' ? parsed[1] : null
        const ev = parsed[2] as NostrEvent | null
        if (!wireSubId || !ev || typeof ev !== 'object') continue
        const sub = this.subscriptions.get(wireSubId)
        if (!sub || sub.closed) continue

        this.pendingDispatchQueue.push({
          kind: 'event',
          conn: frame.conn,
          ws: frame.ws,
          wireSubId,
          event: ev,
        })

        if (
          typeof ev.id === 'string' &&
          ev.id.length > 0 &&
          getEventVerificationCacheResult(ev.id) === null &&
          !this.inFlightVerifyIds.has(ev.id)
        ) {
          this.inFlightVerifyIds.add(ev.id)
          unverifiedBatch.push(ev)
        }
        continue
      }

      if (frameType === 'EOSE' && typeof parsed[1] === 'string') {
        const wireSubId = parsed[1]
        const sub = this.subscriptions.get(wireSubId)
        if (!sub || sub.closed) continue
        this.pendingDispatchQueue.push({
          kind: 'eose',
          conn: frame.conn,
          ws: frame.ws,
          wireSubId,
        })
        continue
      }

      this.handleParsedControlFrame(frame.conn, parsed)
    }

    if (this.inboundRawHead >= this.inboundRawQueue.length) {
      this.inboundRawQueue = []
      this.inboundRawHead = 0
    } else if (this.inboundRawHead >= 64) {
      this.inboundRawQueue = this.inboundRawQueue.slice(this.inboundRawHead)
      this.inboundRawHead = 0
    }

    if (unverifiedBatch.length > 0) {
      if (isOffMainThreadWorkerSupported()) {
        const epoch = this.verifyEpoch
        const batchIds = unverifiedBatch.map((ev) => ev.id)
        void verifyEventsBatchOffMainThread(unverifiedBatch)
          .then((results) => {
            if (this.disposed || this.verifyEpoch !== epoch) return
            for (const r of results) {
              markEventVerifiedCached(r.id, r.ok)
            }
          })
          .catch(() => {
            // Worker unavailable or crashed: subscribers' verifyEventCached(ev) falls back cleanly
          })
          .finally(() => {
            for (const id of batchIds) {
              this.inFlightVerifyIds.delete(id)
            }
            if (!this.disposed && this.verifyEpoch === epoch) {
              this.scheduleDispatchDrain()
            }
          })
      } else {
        for (const ev of unverifiedBatch) {
          this.inFlightVerifyIds.delete(ev.id)
        }
        this.scheduleDispatchDrain()
      }
    }

    if (this.pendingDispatchHead < this.pendingDispatchQueue.length) {
      this.dispatchScheduled = true
    }

    if (this.inboundRawHead < this.inboundRawQueue.length) {
      this.scheduleInboundDrain()
    }
  }

  private drainDispatchSlice(sliceStart: number): void {
    let dispatched = 0
    let blockedOnVerify = false

    while (this.pendingDispatchHead < this.pendingDispatchQueue.length) {
      if (dispatched > 0 && performance.now() - sliceStart >= FRAME_BUDGET_MS) {
        break
      }

      const item = this.pendingDispatchQueue[this.pendingDispatchHead]
      if (
        item.kind === 'event' &&
        typeof item.event.id === 'string' &&
        this.inFlightVerifyIds.has(item.event.id)
      ) {
        // Preserve strict per-stream EVENT -> EOSE order until off-main-thread batch resolves
        blockedOnVerify = true
        break
      }

      this.pendingDispatchHead += 1

      const sub = this.subscriptions.get(item.wireSubId)
      if (!sub || sub.closed || this.disposed || item.conn.ws !== item.ws) continue

      if (item.kind === 'event') {
        sub.handlers.onEvent(item.event, item.conn.url)
        dispatched += 1
      } else if (!sub.eoseReceived.has(item.conn.url)) {
        sub.eoseReceived.add(item.conn.url)
        sub.handlers.onEose?.(item.conn.url)
      }
    }

    if (this.pendingDispatchHead >= this.pendingDispatchQueue.length) {
      this.pendingDispatchQueue = []
      this.pendingDispatchHead = 0
    } else if (this.pendingDispatchHead >= 64) {
      this.pendingDispatchQueue = this.pendingDispatchQueue.slice(this.pendingDispatchHead)
      this.pendingDispatchHead = 0
    }

    if (dispatched > 0) {
      this.scheduleTelemetryEmit()
    }

    if (!blockedOnVerify && this.pendingDispatchHead < this.pendingDispatchQueue.length) {
      this.scheduleDispatchDrain()
    }
  }

  private handleImmediateControlFrame(conn: RelayConnection, raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!Array.isArray(parsed) || parsed.length < 2) return
    this.handleParsedControlFrame(conn, parsed)
  }

  private handleParsedControlFrame(conn: RelayConnection, parsed: unknown[]): void {
    const frameType = parsed[0]

    if (frameType === 'AUTH' && typeof parsed[1] === 'string') {
      const challenge = parsed[1]
      if (!this.authSigner || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) return
      const activeWs = conn.ws
      void this.authSigner(conn.url, challenge)
        .then((signedAuth) => {
          if (!signedAuth || this.disposed || conn.ws !== activeWs || activeWs.readyState !== WebSocket.OPEN) {
            return
          }
          conn.pendingAuthId = signedAuth.id
          activeWs.send(JSON.stringify(['AUTH', signedAuth]))
          conn.txCount += 1
        })
        .catch(() => {
          // Ignore auth rejection
        })
      return
    }

    if (frameType === 'OK' && parsed.length >= 3 && typeof parsed[1] === 'string') {
      const eventId = parsed[1]
      const accepted = Boolean(parsed[2])
      const reason = typeof parsed[3] === 'string' ? parsed[3] : ''

      if (conn.pendingAuthId && eventId === conn.pendingAuthId) {
        conn.pendingAuthId = null
        conn.authenticated = accepted
        if (accepted && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
          // Replay subscriptions that may have required NIP-42 AUTH
          for (const subId of conn.activeSubIds) {
            const sub = this.subscriptions.get(subId)
            if (sub) {
              sub.eoseReceived.delete(conn.url)
              sub.handlers.onRelayReset?.(conn.url)
              this.sendReq(conn, sub)
            }
          }
        }
        this.scheduleTelemetryEmit()
        return
      }

      if (accepted) {
        conn.okCount += 1
      } else {
        conn.rejectCount += 1
        if (reason.toLowerCase().includes('ephemeral')) {
          conn.supportsEphemeral = false
        }
      }

      const pending = conn.pendingOks.get(eventId)
      if (pending) {
        window.clearTimeout(pending.timer)
        conn.pendingOks.delete(eventId)
        const rtt = Math.round(performance.now() - pending.sentAt)
        if (rtt >= 0 && rtt < 15000) {
          this.recordRtt(conn, rtt)
        }
        pending.resolve({ ok: accepted, reason })
      }
      this.scheduleTelemetryEmit()
      return
    }

    if (frameType === 'NOTICE' && typeof parsed[1] === 'string') {
      conn.lastError = parsed[1].slice(0, 120)
      this.scheduleTelemetryEmit()
    }
  }

  private recordRtt(conn: RelayConnection, rttMs: number): void {
    conn.rttMs = rttMs
    conn.rttHistory.push(rttMs)
    if (conn.rttHistory.length > MAX_RTT_HISTORY) {
      conn.rttHistory.shift()
    }
  }

  private scheduleReconnect(conn: RelayConnection): void {
    if (this.disposed || conn.manuallyClosed) return
    if (conn.reconnectTimer !== null) return

    // Stop auto-retrying relays that repeatedly fail WebSocket handshake without ever connecting
    if (!conn.everConnected && conn.handshakeFailures >= MAX_HANDSHAKE_FAILURES) {
      conn.status = 'error'
      conn.nextRetryAt = null
      if (!conn.lastError || conn.lastError === 'connection error') {
        conn.lastError = 'handshake failed'
      }
      return
    }

    conn.reconnectAttempts += 1
    let delayMs: number
    if (!conn.everConnected) {
      // Steep backoff for relays failing before open: ~10s, ~30s, then halt at MAX_HANDSHAKE_FAILURES
      const base = Math.min(
        HANDSHAKE_MAX_BACKOFF_MS,
        HANDSHAKE_BASE_BACKOFF_MS * Math.pow(3, Math.max(0, conn.handshakeFailures - 1))
      )
      delayMs = Math.round(base * (0.85 + Math.random() * 0.3))
    } else {
      const base = Math.min(
        MAX_RECONNECT_MS,
        BASE_RECONNECT_MS * Math.pow(2, Math.min(conn.reconnectAttempts - 1, 5))
      )
      delayMs = Math.round(base * (0.75 + Math.random() * 0.5))
    }

    conn.nextRetryAt = Date.now() + delayMs
    conn.reconnectTimer = window.setTimeout(() => {
      conn.reconnectTimer = null
      conn.nextRetryAt = null
      this.openConnection(conn)
    }, delayMs)
  }

  private waitForOpen(conn: RelayConnection, maxWaitMs: number): Promise<boolean> {
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(true)
    }
    // Never bypass backoff or wake dormant handshake-failed relays during publish
    if (!conn.ws) {
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      const ws = conn.ws
      if (!ws) {
        resolve(false)
        return
      }
      let done = false
      const finish = (val: boolean) => {
        if (done) return
        done = true
        window.clearTimeout(timer)
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onFail)
        ws.removeEventListener('close', onFail)
        resolve(val)
      }
      const onOpen = () => finish(true)
      const onFail = () => finish(false)
      const timer = window.setTimeout(() => finish(ws.readyState === WebSocket.OPEN), maxWaitMs)
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onFail)
      ws.addEventListener('close', onFail)
    })
  }

  private closeSocketOnly(conn: RelayConnection): void {
    if (conn.reconnectTimer !== null) {
      window.clearTimeout(conn.reconnectTimer)
      conn.reconnectTimer = null
    }
    if (conn.ws) {
      try {
        conn.ws.close()
      } catch {
        // Ignore
      }
      conn.ws = null
    }
  }

  private closeConnection(conn: RelayConnection): void {
    conn.manuallyClosed = true
    this.closeSocketOnly(conn)
    for (const pending of conn.pendingOks.values()) {
      window.clearTimeout(pending.timer)
      pending.resolve({ ok: false, reason: 'pool closed' })
    }
    conn.pendingOks.clear()
    conn.status = 'disconnected'
  }

  private scheduleTelemetryEmit(): void {
    if (this.emitTimer !== null || this.disposed) return
    this.emitTimer = window.setTimeout(() => {
      this.emitTimer = null
      if (this.disposed) return
      const snap = this.getTelemetrySnapshot()
      for (const listener of this.telemetryListeners) {
        listener(snap)
      }
    }, 180)
  }
}
