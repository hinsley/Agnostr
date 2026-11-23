import type { Event as NostrEvent, Filter } from 'nostr-tools'
import type { RelayRole, RelayStatus, RelayTelemetry } from '../types/protocol.ts'
import type { SelectedRelayMeta } from './geoRelays.ts'

export type Nip42AuthSigner = (relayUrl: string, challenge: string) => Promise<NostrEvent | null>

export interface SubscriptionHandlers {
  onEvent: (event: NostrEvent, relayUrl: string) => void
  onEose?: (relayUrl: string) => void
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
  id: string
  relays: Set<string>
  filters: Filter[]
  handlers: SubscriptionHandlers
  eoseReceived: Set<string>
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

export class RelayPool {
  private connections = new Map<string, RelayConnection>()
  private subscriptions = new Map<string, ActiveSub>()
  private telemetryListeners = new Set<(telemetry: RelayTelemetry[]) => void>()
  private authSigner: Nip42AuthSigner | null = null
  private emitTimer: number | null = null
  private lastHiddenAt: number | null = null
  private disposed = false

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

    // Replace existing subscription with same ID cleanly
    if (this.subscriptions.has(subId)) {
      this.unsubscribe(subId)
    }

    const relaySet = new Set(relayUrls)
    const sub: ActiveSub = {
      id: subId,
      relays: relaySet,
      filters,
      handlers,
      eoseReceived: new Set(),
    }
    this.subscriptions.set(subId, sub)

    for (const url of relaySet) {
      const conn = this.ensureConnection(url)
      conn.activeSubIds.add(subId)
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        this.sendReq(conn, sub)
      }
    }

    this.scheduleTelemetryEmit()
    return () => this.unsubscribe(subId)
  }

  unsubscribe(subId: string): void {
    const sub = this.subscriptions.get(subId)
    if (!sub) return
    this.subscriptions.delete(subId)

    for (const url of sub.relays) {
      const conn = this.connections.get(url)
      if (!conn) continue
      conn.activeSubIds.delete(subId)
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(JSON.stringify(['CLOSE', subId]))
          conn.txCount += 1
        } catch {
          // Ignore close send error
        }
      }
    }
    this.scheduleTelemetryEmit()
  }

  async publish(
    relayUrls: readonly string[],
    event: NostrEvent,
    timeoutMs = 4500
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
    for (const subId of Array.from(this.subscriptions.keys())) {
      this.unsubscribe(subId)
    }
    for (const conn of this.connections.values()) {
      this.closeConnection(conn)
    }
    this.connections.clear()
    this.scheduleTelemetryEmit()
  }

  dispose(): void {
    this.disposed = true
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
      this.handleRelayMessage(conn, msgEvent.data)
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
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return
    try {
      conn.ws.send(JSON.stringify(['REQ', sub.id, ...sub.filters]))
      conn.txCount += 1
    } catch {
      // Ignore send failure
    }
  }

  private handleRelayMessage(conn: RelayConnection, raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!Array.isArray(parsed) || parsed.length < 2) return

    const frameType = parsed[0]
    if (frameType === 'EVENT' && parsed.length >= 3) {
      const subId = typeof parsed[1] === 'string' ? parsed[1] : null
      const ev = parsed[2] as NostrEvent | null
      if (!subId || !ev || typeof ev !== 'object') return
      const sub = this.subscriptions.get(subId)
      if (!sub) return
      sub.handlers.onEvent(ev, conn.url)
      this.scheduleTelemetryEmit()
      return
    }

    if (frameType === 'EOSE' && typeof parsed[1] === 'string') {
      const sub = this.subscriptions.get(parsed[1])
      if (sub && !sub.eoseReceived.has(conn.url)) {
        sub.eoseReceived.add(conn.url)
        sub.handlers.onEose?.(conn.url)
      }
      return
    }

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
            if (sub) this.sendReq(conn, sub)
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
