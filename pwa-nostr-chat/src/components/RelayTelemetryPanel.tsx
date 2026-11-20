import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Activity,
  Globe,
  MapPin,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import type { AgnostrEngine, RelayStatus, RelayTelemetry } from '../types/protocol.ts'
import type { SoundCue } from '../utils/sound.ts'

export interface RelayTelemetryPanelProps {
  engine: AgnostrEngine
  onPlaySound?: (cue: SoundCue) => void
}

const STATUS_ORDER: Record<RelayStatus, number> = {
  connected: 0,
  connecting: 1,
  degraded: 2,
  disconnected: 3,
  error: 4,
}

function stripWsScheme(url: string): string {
  return url.replace(/^wss?:\/\//i, '').replace(/\/+$/, '')
}

function rttToneClass(rttMs: number | null): string {
  if (rttMs === null) return 'muted'
  if (rttMs < 180) return 'ok'
  if (rttMs < 450) return 'warn'
  return 'danger'
}

function LatencySparkline({ history, status }: { history: number[]; status: RelayStatus }) {
  const width = 84
  const height = 22
  const padY = 3
  const padX = 2

  const samples = history.slice(-18)

  if (samples.length === 0) {
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="ag-sparkline ag-sparkline-idle"
        aria-hidden="true"
      >
        <line
          x1={padX}
          y1={height / 2}
          x2={width - padX}
          y2={height / 2}
          strokeDasharray="2 3"
          className="ag-spark-baseline"
        />
      </svg>
    )
  }

  const maxVal = Math.max(120, ...samples)
  const minVal = Math.min(0, ...samples)
  const span = Math.max(1, maxVal - minVal)

  const points = samples.map((val, idx) => {
    const x =
      samples.length === 1
        ? width - padX - 2
        : padX + (idx / (samples.length - 1)) * (width - padX * 2)
    const norm = (val - minVal) / span
    const y = height - padY - norm * (height - padY * 2)
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }
  })

  const lineCoords =
    samples.length === 1
      ? `${padX},${points[0].y} ${points[0].x},${points[0].y}`
      : points.map((p) => `${p.x},${p.y}`).join(' ')

  const areaPath =
    samples.length === 1
      ? `M ${padX} ${height - 1} L ${padX} ${points[0].y} L ${points[0].x} ${points[0].y} L ${points[0].x} ${height - 1} Z`
      : `M ${points[0].x} ${height - 1} ${points.map((p) => `L ${p.x} ${p.y}`).join(' ')} L ${points[points.length - 1].x} ${height - 1} Z`

  const last = points[points.length - 1]
  const tone =
    status === 'error' || status === 'disconnected'
      ? 'danger'
      : status === 'degraded'
        ? 'warn'
        : rttToneClass(samples[samples.length - 1])

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={`ag-sparkline ag-spark-${tone}`}
      aria-label={`Latency sparkline, latest ${samples[samples.length - 1]} milliseconds`}
    >
      <path d={areaPath} className="ag-spark-area" />
      <polyline points={lineCoords} className="ag-spark-line" fill="none" />
      <circle cx={last.x} cy={last.y} r={2} className="ag-spark-dot" />
    </svg>
  )
}

export function RelayTelemetryPanel({ engine, onPlaySound }: RelayTelemetryPanelProps) {
  const {
    relays,
    connectedRelayCount,
    totalRelayCount,
    avgLatencyMs,
    customRelays,
    geoDirectoryCount,
  } = engine

  const [newUrl, setNewUrl] = useState('')
  const [urlError, setUrlError] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState(false)

  const sortedRelays = useMemo(() => {
    return [...relays].sort((a, b) => {
      const sDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
      if (sDiff !== 0) return sDiff
      const aRtt = a.rttMs ?? 99_999
      const bRtt = b.rttMs ?? 99_999
      if (aRtt !== bRtt) return aRtt - bRtt
      return a.url.localeCompare(b.url)
    })
  }, [relays])

  const customSet = useMemo(() => new Set(customRelays), [customRelays])

  const handleAddRelay = (e: FormEvent) => {
    e.preventDefault()
    const raw = newUrl.trim()
    if (!raw) return
    const normalized = /^wss?:\/\//i.test(raw) ? raw : `wss://${raw}`
    const ok = engine.addCustomRelay(normalized)
    if (ok) {
      setNewUrl('')
      setUrlError(null)
      onPlaySound?.('click')
    } else {
      setUrlError('Enter a valid wss:// relay URL')
    }
  }

  const handleReconnect = () => {
    setReconnecting(true)
    onPlaySound?.('tune')
    engine.reconnectRelays()
    window.setTimeout(() => setReconnecting(false), 750)
  }

  const handleRemoveCustom = (url: string) => {
    onPlaySound?.('click')
    engine.removeCustomRelay(url)
  }

  const handleResetCustom = () => {
    onPlaySound?.('click')
    engine.resetCustomRelays()
  }

  const renderRoleBadges = (relay: RelayTelemetry) => {
    const isGeo = relay.roles.includes('geo')
    const isCore = relay.roles.includes('core')
    const isPulse = relay.roles.includes('pulse')
    const isCustom = relay.roles.includes('custom') || customSet.has(relay.url)

    return (
      <div className="ag-relay-roles">
        {isGeo && (
          <span className="ag-badge ag-badge-accent">
            <MapPin size={9} />
            <span>
              GEO
              {relay.distanceKm !== undefined ? ` · ${Math.round(relay.distanceKm)}km` : ''}
            </span>
          </span>
        )}
        {isCore && (
          <span className="ag-badge ag-badge-mesh">
            <Globe size={9} />
            <span>GLOBAL</span>
          </span>
        )}
        {isPulse && !isCore && !isGeo && (
          <span className="ag-badge ag-badge-muted">PULSE</span>
        )}
        {isCustom && <span className="ag-badge ag-badge-warn">CUSTOM</span>}
        {relay.supportsDm && <span className="ag-badge ag-badge-dm">DM</span>}
      </div>
    )
  }

  return (
    <div className="ag-panel ag-relays-panel">
      {/* KPI Summary Strip */}
      <section className="ag-panel-card">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <Activity size={13} />
            <span>RELAY TELEMETRY</span>
          </div>
          <button
            type="button"
            className="ag-btn ag-btn-ghost ag-btn-xs"
            onClick={handleReconnect}
            title="Reconnect all relays"
          >
            <RefreshCw size={12} className={reconnecting ? 'ag-spin' : ''} />
            <span>Reconnect</span>
          </button>
        </div>

        <div className="ag-kpi-grid">
          <div className="ag-kpi-cell">
            <span className="ag-kpi-label">ONLINE</span>
            <span className="ag-kpi-value mono">
              <span
                className={`ag-led ${
                  connectedRelayCount > 0 ? 'ag-led-ok ag-led-pulse' : 'ag-led-danger'
                }`}
              />
              {connectedRelayCount}/{totalRelayCount}
            </span>
          </div>
          <div className="ag-kpi-cell">
            <span className="ag-kpi-label">AVG RTT</span>
            <span className={`ag-kpi-value mono ag-tone-${rttToneClass(avgLatencyMs)}`}>
              {avgLatencyMs !== null ? `${Math.round(avgLatencyMs)}ms` : '—'}
            </span>
          </div>
          <div className="ag-kpi-cell">
            <span className="ag-kpi-label">GEO DIR</span>
            <span className="ag-kpi-value mono">{geoDirectoryCount}</span>
          </div>
        </div>
      </section>

      {/* Add Custom Relay */}
      <section className="ag-panel-card">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <Radio size={13} />
            <span>CUSTOM RELAYS</span>
          </div>
          {customRelays.length > 0 && (
            <button
              type="button"
              className="ag-btn ag-btn-ghost ag-btn-xs"
              onClick={handleResetCustom}
              title="Remove all custom relays"
            >
              <RotateCcw size={11} />
              <span>Reset ({customRelays.length})</span>
            </button>
          )}
        </div>

        <form className="ag-jump-form" onSubmit={handleAddRelay}>
          <input
            type="text"
            className="ag-input mono"
            placeholder="wss://relay.example.com"
            value={newUrl}
            onChange={(e) => {
              setNewUrl(e.target.value)
              if (urlError) setUrlError(null)
            }}
            aria-label="Add custom Nostr WebSocket relay URL"
          />
          <button type="submit" className="ag-btn ag-btn-secondary" aria-label="Add relay">
            <Plus size={14} />
          </button>
        </form>
        {urlError && <p className="ag-field-hint ag-field-hint-danger">{urlError}</p>}
      </section>

      {/* Relay List */}
      <div className="ag-relay-list" role="list" aria-label="Connected Nostr relays">
        {sortedRelays.length === 0 ? (
          <div className="ag-empty-panel">
            <Radio size={20} className="ag-empty-icon" />
            <p className="ag-empty-title">No relays initialized</p>
            <p className="ag-empty-sub">Click Reconnect or add a custom wss:// relay above.</p>
          </div>
        ) : (
          sortedRelays.map((relay) => {
            const isCustom = relay.roles.includes('custom') || customSet.has(relay.url)
            const ledClass =
              relay.status === 'connected'
                ? 'ag-led-ok'
                : relay.status === 'connecting' || relay.status === 'degraded'
                  ? 'ag-led-warn ag-led-pulse'
                  : relay.status === 'error'
                    ? 'ag-led-danger'
                    : 'ag-led-muted'

            return (
              <div key={relay.url} role="listitem" className={`ag-relay-card status-${relay.status}`}>
                <div className="ag-relay-top">
                  <div className="ag-relay-host-wrap">
                    <span className={`ag-led ${ledClass}`} title={`Status: ${relay.status}`} />
                    <span className="ag-relay-host mono truncate" title={relay.url}>
                      {stripWsScheme(relay.url)}
                    </span>
                  </div>

                  <div className="ag-relay-right">
                    <span className={`ag-relay-rtt mono ag-tone-${rttToneClass(relay.rttMs)}`}>
                      {relay.rttMs !== null ? `${Math.round(relay.rttMs)}ms` : relay.status}
                    </span>
                    {isCustom && (
                      <button
                        type="button"
                        className="ag-icon-btn-xs ag-icon-btn-danger"
                        onClick={() => handleRemoveCustom(relay.url)}
                        title={`Remove custom relay ${relay.url}`}
                        aria-label={`Remove ${relay.url}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>

                {renderRoleBadges(relay)}

                <div className="ag-relay-telemetry-row">
                  <div className="ag-relay-counters mono">
                    <span title="Events received">
                      RX <b>{relay.rxCount}</b>
                    </span>
                    <span title="Events transmitted">
                      TX <b>{relay.txCount}</b>
                    </span>
                    <span title="Accepted OK acknowledgements">
                      OK <b>{relay.okCount}</b>
                    </span>
                    {relay.rejectCount > 0 && (
                      <span className="ag-tone-danger" title="Rejected publishes">
                        REJ <b>{relay.rejectCount}</b>
                      </span>
                    )}
                  </div>

                  <LatencySparkline history={relay.rttHistory} status={relay.status} />
                </div>

                {relay.lastError && (
                  <p className="ag-relay-error mono truncate" title={relay.lastError}>
                    {relay.lastError}
                  </p>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
