import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  ArrowRight,
  Compass,
  Crosshair,
  Globe,
  Loader2,
  MapPin,
  Maximize2,
  Minus,
  Navigation,
  Plus,
  Radio,
  ShieldAlert,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { AgnostrEngine, GeoNeighbors, PulseRoom } from '../types/protocol.ts'
import type { SoundCue } from '../utils/sound.ts'
import {
  buildGeohashCell,
  encodeGeohash,
  formatCellDimensions,
  formatCoords,
  resolveGeohashOrCity,
} from '../lib/geohash.ts'
import {
  TacticalGeohashMap,
  type TacticalGeohashMapHandle,
} from './TacticalGeohashMap.tsx'

export interface GeoRadarPanelProps {
  engine: AgnostrEngine
  onTuneChannel: (geohash: string) => void
  onExpandRadar?: () => void
  onPlaySound?: (cue: SoundCue) => void
}

const COMPASS_CELLS: readonly { key: keyof GeoNeighbors; dir: string; isCenter?: boolean }[] = [
  { key: 'nw', dir: 'NW' },
  { key: 'n', dir: 'N' },
  { key: 'ne', dir: 'NE' },
  { key: 'w', dir: 'W' },
  { key: 'center', dir: 'LOCK', isCenter: true },
  { key: 'e', dir: 'E' },
  { key: 'sw', dir: 'SW' },
  { key: 's', dir: 'S' },
  { key: 'se', dir: 'SE' },
]

export function GeoRadarPanel({
  engine,
  onTuneChannel,
  onExpandRadar,
  onPlaySound,
}: GeoRadarPanelProps) {
  const { cell, location, isTeleported, pulseRooms, quickCities, settings } = engine
  const mapRef = useRef<TacticalGeohashMapHandle | null>(null)
  const prefixChainRef = useRef<HTMLDivElement | null>(null)

  const [selectedGeohash, setSelectedGeohash] = useState<string | null>(null)
  const [effectivePrecision, setEffectivePrecision] = useState<number>(cell.precision)
  const [jumpInput, setJumpInput] = useState('')
  const [jumpError, setJumpError] = useState<string | null>(null)

  // Clear pending compact selection when active channel changes
  useEffect(() => {
    setSelectedGeohash(null)
  }, [cell.geohash])

  // Keep active geohash precision pill fully visible inside horizontal scroll strip
  useEffect(() => {
    const container = prefixChainRef.current
    if (!container) return
    const activeEl = container.querySelector<HTMLElement>('.ag-prefix-pill.active')
    if (!activeEl) return
    const containerRect = container.getBoundingClientRect()
    const activeRect = activeEl.getBoundingClientRect()
    const relativeLeft = activeRect.left - containerRect.left + container.scrollLeft
    const targetLeft = relativeLeft - container.clientWidth / 2 + activeRect.width / 2
    container.scrollLeft = Math.max(0, targetLeft)
  }, [cell.geohash, cell.prefixChain.length])

  const activePulseSet = useMemo(() => {
    const map = new Map<string, PulseRoom>()
    for (const room of pulseRooms) {
      map.set(room.geohash, room)
    }
    return map
  }, [pulseRooms])

  const selectedCell = useMemo(() => {
    if (!selectedGeohash || selectedGeohash === cell.geohash) return null
    return buildGeohashCell(selectedGeohash)
  }, [selectedGeohash, cell.geohash])

  const activeDimensions = useMemo(() => formatCellDimensions(cell.bounds), [cell.bounds])

  const tune = useCallback(
    (target: string): boolean => {
      const resolved = resolveGeohashOrCity(target)
      if (!resolved) return false
      setSelectedGeohash(null)
      onTuneChannel(resolved)
      onPlaySound?.('tune')
      return true
    },
    [onTuneChannel, onPlaySound],
  )

  const handleSelectOnMap = useCallback(
    (gh: string) => {
      setSelectedGeohash(gh)
      onPlaySound?.('click')
    },
    [onPlaySound],
  )

  const handleViewportInfoChange = useCallback(
    (info: { zoom: number; effectivePrecision: number }) => {
      setEffectivePrecision(info.effectivePrecision)
    },
    [],
  )

  const handleZoomOut = () => {
    if (cell.precision <= 1) return
    tune(cell.geohash.slice(0, -1))
  }

  const handleZoomIn = () => {
    if (cell.precision >= 8) return
    const nextPrecision = cell.precision + 1
    const localNext = location.localGeohashes[nextPrecision]
    if (localNext && localNext.startsWith(cell.geohash)) {
      tune(localNext)
      return
    }
    const child = encodeGeohash(cell.center.lat, cell.center.lon, nextPrecision)
    tune(child)
  }

  const handleLocateMe = async () => {
    onPlaySound?.('click')
    const gh = await engine.locateMe()
    if (gh) {
      onTuneChannel(gh)
      onPlaySound?.('tune')
    }
  }

  const handleJumpSubmit = (e: FormEvent) => {
    e.preventDefault()
    const raw = jumpInput.trim()
    if (!raw) return
    const ok = tune(raw)
    if (ok) {
      setJumpInput('')
      setJumpError(null)
    } else {
      setJumpError('Enter a valid #geohash, city, or lat, lon')
    }
  }

  return (
    <div className="ag-panel ag-radar-panel">
      {/* Interactive Zoomable Geohash Radar Mini-Map */}
      <section className="ag-panel-card ag-radar-card" aria-label="Interactive Geohash Radar">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <Globe size={13} />
            <span>GEOHASH RADAR</span>
          </div>
          <div className="ag-radar-meta-pills">
            <span className="ag-chip ag-chip-mono" title="Live active global frequencies">
              <span className="ag-led ag-led-ok ag-led-pulse" />
              {pulseRooms.length} live
            </span>
            {onExpandRadar && (
              <button
                type="button"
                className="ag-btn ag-btn-secondary ag-btn-xs ag-radar-expand-head-btn"
                onClick={() => {
                  onPlaySound?.('click')
                  onExpandRadar()
                }}
                title="Expand full-screen zoomable Geohash Radar"
              >
                <Maximize2 size={11} />
                <span>Expand</span>
              </button>
            )}
          </div>
        </div>

        <div className="ag-radar-compact-frame">
          <TacticalGeohashMap
            ref={mapRef}
            mode="compact"
            theme={settings.theme}
            activeGeohash={cell.geohash}
            selectedGeohash={selectedGeohash}
            precisionMode="auto"
            showSubZones={false}
            showPulse={true}
            pulseRooms={pulseRooms}
            userCoords={location.coords}
            isTeleported={isTeleported}
            onSelectGeohash={handleSelectOnMap}
            onTuneGeohash={tune}
            onViewportInfoChange={handleViewportInfoChange}
          />

          {/* Compact Corner Controls */}
          <div className="ag-radar-compact-controls" role="toolbar" aria-label="Mini-map controls">
            <button
              type="button"
              className="ag-radar-mini-btn"
              onClick={() => {
                onPlaySound?.('click')
                mapRef.current?.zoomIn()
              }}
              title="Zoom in"
              aria-label="Zoom in map"
            >
              <Plus size={13} />
            </button>
            <button
              type="button"
              className="ag-radar-mini-btn"
              onClick={() => {
                onPlaySound?.('click')
                mapRef.current?.zoomOut()
              }}
              title="Zoom out"
              aria-label="Zoom out map"
            >
              <Minus size={13} />
            </button>
            <button
              type="button"
              className="ag-radar-mini-btn"
              onClick={() => {
                onPlaySound?.('click')
                mapRef.current?.flyToGeohash(cell.geohash, { animate: true })
              }}
              title={`Fit active zone #${cell.geohash}`}
              aria-label="Fit active geohash"
            >
              <Crosshair size={13} />
            </button>
            {onExpandRadar && (
              <button
                type="button"
                className="ag-radar-mini-btn ag-radar-mini-btn-accent"
                onClick={() => {
                  onPlaySound?.('click')
                  onExpandRadar()
                }}
                title="Expand full-screen Geohash Radar"
                aria-label="Expand full-screen radar"
              >
                <Maximize2 size={12} />
              </button>
            )}
          </div>

          {/* Inline Zone Selection & Quick-Tune Strip */}
          {selectedCell ? (
            <div className="ag-radar-compact-tune-bar">
              <div className="ag-radar-compact-sel-meta">
                <span className="ag-radar-hud-accent mono">#{selectedCell.geohash}</span>
                <span className="ag-radar-hud-sep">·</span>
                <span className="truncate">
                  {selectedCell.nearestCity ?? formatCellDimensions(selectedCell.bounds)}
                </span>
              </div>
              <div className="ag-radar-compact-sel-actions">
                <button
                  type="button"
                  className="ag-btn ag-btn-primary ag-btn-xs"
                  onClick={() => tune(selectedCell.geohash)}
                >
                  Tune #{selectedCell.geohash}
                </button>
                <button
                  type="button"
                  className="ag-icon-btn-xs"
                  onClick={() => setSelectedGeohash(null)}
                  aria-label="Clear selected zone"
                  title="Cancel selection"
                >
                  <X size={11} />
                </button>
              </div>
            </div>
          ) : (
            <div className="ag-radar-hud mono">
              <span className="ag-radar-hud-accent">#{cell.geohash}</span>
              <span className="ag-radar-hud-sep">·</span>
              <span className="truncate">Grid P{effectivePrecision}</span>
              <span className="ag-radar-hud-right">tap zone</span>
            </div>
          )}
        </div>

        {/* Legend strip */}
        <div className="ag-radar-legend">
          <span className="ag-radar-legend-item">
            <span className="ag-radar-swatch ag-radar-swatch-target" />
            Tuned
          </span>
          <span className="ag-radar-legend-item">
            <span className="ag-radar-swatch ag-radar-swatch-pulse" />
            Pulse
          </span>
          {location.coords && (
            <span className="ag-radar-legend-item">
              <span className="ag-radar-swatch ag-radar-swatch-gps" />
              GPS
            </span>
          )}
        </div>
      </section>

      {/* Active Cell & Precision Zoom */}
      <section className="ag-panel-card">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <MapPin size={13} />
            <span>CELL TELEMETRY</span>
          </div>
          <span className={`ag-badge ${isTeleported ? 'ag-badge-warn' : 'ag-badge-ok'}`}>
            {isTeleported ? 'TELEPORT' : 'LOCAL'}
          </span>
        </div>

        <div className="ag-cell-summary">
          <div className="ag-cell-primary">
            <span className="ag-cell-hash mono">#{cell.geohash}</span>
            <span className="ag-cell-city truncate">{cell.nearestCity ?? 'Open Coordinates'}</span>
          </div>
          <div className="ag-cell-sub mono">
            <span>{cell.label}</span>
            <span>·</span>
            <span>{activeDimensions}</span>
            <span>·</span>
            <span>{formatCoords(cell.center)}</span>
          </div>
        </div>

        {/* Precision Stepper */}
        <div className="ag-precision-row">
          <button
            type="button"
            className="ag-icon-btn-sm"
            onClick={handleZoomOut}
            disabled={cell.precision <= 1}
            title="Zoom out (parent geohash)"
            aria-label="Zoom out to parent geohash"
          >
            <ZoomOut size={13} />
          </button>

          <div
            ref={prefixChainRef}
            className="ag-prefix-chain"
            role="group"
            aria-label="Geohash precision chain"
          >
            {cell.prefixChain.map((step) => {
              const isCurrent = step.geohash === cell.geohash
              return (
                <button
                  key={step.geohash}
                  type="button"
                  className={`ag-prefix-pill mono ${isCurrent ? 'active' : ''}`}
                  onClick={() => tune(step.geohash)}
                  title={`${step.label} (${step.approxSizeLabel})`}
                >
                  #{step.geohash}
                </button>
              )
            })}
          </div>

          <button
            type="button"
            className="ag-icon-btn-sm"
            onClick={handleZoomIn}
            disabled={cell.precision >= 8}
            title="Zoom in (child geohash)"
            aria-label="Zoom in to finer geohash"
          >
            <ZoomIn size={13} />
          </button>
        </div>

        {!cell.allowsPresence && (
          <div className="ag-privacy-callout">
            <ShieldAlert size={13} />
            <span>Presence heartbeats muted at precision ≥6 for location privacy.</span>
          </div>
        )}
      </section>

      {/* 3×3 Neighbor Compass */}
      <section className="ag-panel-card">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <Compass size={13} />
            <span>ADJACENT COMPASS</span>
          </div>
          <span className="ag-panel-card-sub mono">3×3 GRID</span>
        </div>

        <div className="ag-compass-grid" role="group" aria-label="Adjacent geohash cells">
          {COMPASS_CELLS.map(({ key, dir, isCenter }) => {
            const hash = cell.neighbors[key]
            const hasPulse = hash ? activePulseSet.has(hash) : false
            return (
              <button
                key={key}
                type="button"
                disabled={!hash || isCenter}
                className={`ag-compass-tile ${isCenter ? 'center' : ''} ${hasPulse ? 'has-pulse' : ''}`}
                onClick={() => hash && !isCenter && tune(hash)}
                title={hash ? `${dir}: #${hash}${hasPulse ? ' (live traffic)' : ''}` : `${dir}: pole boundary`}
              >
                <span className="ag-compass-dir">
                  {dir}
                  {hasPulse && !isCenter && <span className="ag-compass-dot" />}
                </span>
                <span className="ag-compass-hash mono truncate">{hash ? `#${hash}` : '—'}</span>
              </button>
            )
          })}
        </div>
      </section>

      {/* GPS Locate + Manual Geohash/City Jump */}
      <section className="ag-panel-card">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <Navigation size={13} />
            <span>LOCATE &amp; TUNE</span>
          </div>
          {location.status === 'ready' && location.accuracyMeters !== null && (
            <span className="ag-panel-card-sub mono">±{Math.round(location.accuracyMeters)}m</span>
          )}
        </div>

        <button
          type="button"
          className={`ag-btn ag-btn-primary ag-btn-block ${location.status === 'locating' ? 'loading' : ''}`}
          onClick={() => void handleLocateMe()}
          disabled={location.status === 'locating'}
        >
          {location.status === 'locating' ? (
            <>
              <Loader2 size={14} className="ag-spin" />
              <span>Acquiring GPS Lock…</span>
            </>
          ) : (
            <>
              <Crosshair size={14} />
              <span>Locate Me (GPS)</span>
            </>
          )}
        </button>

        {location.error && (
          <p className="ag-field-hint ag-field-hint-warn" role="status">
            {location.error}
          </p>
        )}

        <form className="ag-jump-form" onSubmit={handleJumpSubmit}>
          <input
            type="text"
            className="ag-input mono"
            placeholder="#geohash, city, or lat, lon"
            value={jumpInput}
            onChange={(e) => {
              setJumpInput(e.target.value)
              if (jumpError) setJumpError(null)
            }}
            aria-label="Jump to geohash, city, or coordinates"
          />
          <button type="submit" className="ag-btn ag-btn-secondary" aria-label="Tune frequency">
            <ArrowRight size={14} />
          </button>
        </form>
        {jumpError && <p className="ag-field-hint ag-field-hint-danger">{jumpError}</p>}

        {/* Quick Cities */}
        <div className="ag-quick-cities">
          {quickCities.map((city) => {
            const isActive = cell.geohash === city.geohash
            return (
              <button
                key={city.geohash}
                type="button"
                className={`ag-city-chip ${isActive ? 'active' : ''}`}
                onClick={() => tune(city.geohash)}
                title={`${city.name} (${city.region}) — #${city.geohash}`}
              >
                <Radio size={10} />
                <span>{city.name}</span>
                <span className="ag-city-chip-hash mono">#{city.geohash}</span>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}
