import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, MouseEvent } from 'react'
import {
  ArrowRight,
  Compass,
  Crosshair,
  Globe,
  Loader2,
  MapPin,
  Navigation,
  Radio,
  ShieldAlert,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { AgnostrEngine, GeoNeighbors, PulseRoom } from '../types/protocol.ts'
import type { SoundCue } from '../utils/sound.ts'
import { encodeGeohash, findNearestCityLabel, resolveGeohashOrCity } from '../lib/geohash.ts'
import {
  formatCoordPair,
  GRATICULE_LATITUDES,
  GRATICULE_LONGITUDES,
  LANDMASS_PATHS,
  MAP_HEIGHT,
  MAP_VIEWBOX,
  MAP_WIDTH,
  projectBoundsToRect,
  projectLatLon,
  unprojectXY,
} from '../utils/worldMapData.ts'

export interface GeoRadarPanelProps {
  engine: AgnostrEngine
  onTuneChannel: (geohash: string) => void
  onPlaySound?: (cue: SoundCue) => void
}

interface HoverReadout {
  x: number
  y: number
  lat: number
  lon: number
  geohash: string
  label: string | null
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

export function GeoRadarPanel({ engine, onTuneChannel, onPlaySound }: GeoRadarPanelProps) {
  const { cell, location, isTeleported, pulseRooms, quickCities } = engine
  const svgRef = useRef<SVGSVGElement | null>(null)
  const prefixChainRef = useRef<HTMLDivElement | null>(null)

  const [hoverPoint, setHoverPoint] = useState<HoverReadout | null>(null)
  const [hoveredRoom, setHoveredRoom] = useState<PulseRoom | null>(null)
  const [jumpInput, setJumpInput] = useState('')
  const [jumpError, setJumpError] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [])

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

  const clickPrecision = Math.min(5, Math.max(2, cell.precision))

  const cellCenterPt = useMemo(
    () => projectLatLon(cell.center.lat, cell.center.lon),
    [cell.center.lat, cell.center.lon],
  )

  const cellRect = useMemo(
    () =>
      projectBoundsToRect(
        cell.bounds.latMin,
        cell.bounds.latMax,
        cell.bounds.lonMin,
        cell.bounds.lonMax,
      ),
    [cell.bounds.latMin, cell.bounds.latMax, cell.bounds.lonMin, cell.bounds.lonMax],
  )

  const gpsPoint = useMemo(
    () => (location.coords ? projectLatLon(location.coords.lat, location.coords.lon) : null),
    [location.coords],
  )

  const activePulseSet = useMemo(() => {
    const map = new Map<string, PulseRoom>()
    for (const room of pulseRooms) {
      map.set(room.geohash, room)
    }
    return map
  }, [pulseRooms])

  const visibleBlips = useMemo(() => pulseRooms.slice(0, 32), [pulseRooms])

  const tune = (target: string): boolean => {
    const resolved = resolveGeohashOrCity(target)
    if (!resolved) return false
    onTuneChannel(resolved)
    onPlaySound?.('tune')
    return true
  }

  const getSvgCoords = (e: MouseEvent<SVGSVGElement>): { x: number; y: number } | null => {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const x = ((e.clientX - rect.left) / rect.width) * MAP_WIDTH
    const y = ((e.clientY - rect.top) / rect.height) * MAP_HEIGHT
    return { x, y }
  }

  const handleMapMove = (e: MouseEvent<SVGSVGElement>) => {
    const pt = getSvgCoords(e)
    if (!pt) return
    const { lat, lon } = unprojectXY(pt.x, pt.y)
    const gh = encodeGeohash(lat, lon, clickPrecision)
    const label = findNearestCityLabel(lat, lon, gh)
    setHoverPoint({ x: pt.x, y: pt.y, lat, lon, geohash: gh, label })
  }

  const handleMapLeave = () => {
    setHoverPoint(null)
    setHoveredRoom(null)
  }

  const handleMapClick = (e: MouseEvent<SVGSVGElement>) => {
    const pt = getSvgCoords(e)
    if (!pt) return
    const { lat, lon } = unprojectXY(pt.x, pt.y)
    const gh = encodeGeohash(lat, lon, clickPrecision)
    tune(gh)
  }

  const handleBlipClick = (e: MouseEvent, room: PulseRoom) => {
    e.stopPropagation()
    tune(room.geohash)
  }

  const handleBlipKeyDown = (e: KeyboardEvent, room: PulseRoom) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      tune(room.geohash)
    }
  }

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

  const showCellBox = cellRect.width >= 3.5 || cellRect.height >= 3.5

  return (
    <div className="ag-panel ag-radar-panel">
      {/* Interactive World Radar */}
      <section className="ag-panel-card ag-radar-card" aria-label="Interactive World Radar">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <Globe size={13} />
            <span>WORLD RADAR</span>
          </div>
          <div className="ag-radar-meta-pills">
            <span className="ag-chip ag-chip-mono" title="Live active global frequencies">
              <span className="ag-led ag-led-ok ag-led-pulse" />
              {pulseRooms.length} live
            </span>
          </div>
        </div>

        <div className="ag-radar-viewport">
          <svg
            ref={svgRef}
            viewBox={MAP_VIEWBOX}
            className="ag-radar-svg"
            onMouseMove={handleMapMove}
            onMouseLeave={handleMapLeave}
            onClick={handleMapClick}
            role="img"
            aria-label={`Interactive world radar centered on #${cell.geohash}. Click anywhere to tune.`}
          >
            <defs>
              <radialGradient id="ag-radar-vignette" cx="50%" cy="50%" r="72%">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.06" />
                <stop offset="100%" stopColor="var(--bg-canvas)" stopOpacity="0.35" />
              </radialGradient>
              <linearGradient id="ag-radar-scan-grad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0" />
                <stop offset="82%" stopColor="var(--accent)" stopOpacity="0.14" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.42" />
              </linearGradient>
            </defs>

            {/* Ambient ocean backdrop */}
            <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="url(#ag-radar-vignette)" />

            {/* Graticule lines */}
            <g className="ag-radar-graticule">
              {GRATICULE_LATITUDES.map((lat) => {
                const { y } = projectLatLon(lat, 0)
                const isEquator = lat === 0
                return (
                  <line
                    key={`lat-${lat}`}
                    x1={0}
                    y1={y}
                    x2={MAP_WIDTH}
                    y2={y}
                    className={isEquator ? 'ag-radar-axis' : 'ag-radar-grid'}
                  />
                )
              })}
              {GRATICULE_LONGITUDES.map((lon) => {
                const { x } = projectLatLon(0, lon)
                const isPrime = lon === 0
                return (
                  <line
                    key={`lon-${lon}`}
                    x1={x}
                    y1={0}
                    x2={x}
                    y2={MAP_HEIGHT}
                    className={isPrime ? 'ag-radar-axis' : 'ag-radar-grid'}
                  />
                )
              })}
            </g>

            {/* Vector Continents */}
            <g className="ag-radar-landmasses">
              {LANDMASS_PATHS.map((land) => (
                <path
                  key={land.id}
                  d={land.d}
                  className={land.isAntarctica ? 'ag-radar-land ag-radar-antarctica' : 'ag-radar-land'}
                />
              ))}
            </g>

            {/* Sweeping HF propagation scan bar */}
            <rect
              className="ag-radar-scan-beam"
              x={-36}
              y={0}
              width={36}
              height={MAP_HEIGHT}
              fill="url(#ag-radar-scan-grad)"
              pointerEvents="none"
            />

            {/* Teleport link line from GPS to active cell */}
            {gpsPoint && isTeleported && (
              <line
                x1={gpsPoint.x}
                y1={gpsPoint.y}
                x2={cellCenterPt.x}
                y2={cellCenterPt.y}
                className="ag-radar-teleport-arc"
                pointerEvents="none"
              />
            )}

            {/* Active geohash cell bounding box */}
            {showCellBox && (
              <rect
                x={cellRect.x}
                y={cellRect.y}
                width={cellRect.width}
                height={cellRect.height}
                className="ag-radar-cell-box"
                pointerEvents="none"
              />
            )}

            {/* Global Pulse Sonar Blips */}
            <g className="ag-radar-blips">
              {visibleBlips.map((room) => {
                const pt = projectLatLon(room.center.lat, room.center.lon)
                const isCurrent = room.geohash === cell.geohash
                const isFresh = nowMs - room.lastActivityAt < 180_000
                const radius = Math.min(3.8, 2.0 + Math.log2(1 + room.peerCount + room.messagesPerMin) * 0.6)
                return (
                  <g
                    key={room.geohash}
                    transform={`translate(${pt.x}, ${pt.y})`}
                    className={`ag-radar-blip ${isCurrent ? 'active' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Tune to #${room.geohash}${room.nearestCity ? ` (${room.nearestCity})` : ''}, ${room.peerCount} peers`}
                    onClick={(e) => handleBlipClick(e, room)}
                    onKeyDown={(e) => handleBlipKeyDown(e, room)}
                    onMouseEnter={() => setHoveredRoom(room)}
                    onMouseLeave={() => setHoveredRoom((prev) => (prev?.geohash === room.geohash ? null : prev))}
                  >
                    <circle r={6.5} fill="transparent" />
                    {isFresh && <circle r={radius + 2.2} className="ag-radar-blip-ring" />}
                    <circle r={radius} className="ag-radar-blip-core" />
                  </g>
                )
              })}
            </g>

            {/* User Physical GPS Beacon */}
            {gpsPoint && (
              <g
                transform={`translate(${gpsPoint.x}, ${gpsPoint.y})`}
                className="ag-radar-gps"
                pointerEvents="none"
              >
                <circle r={6} className="ag-radar-gps-halo" />
                <circle r={2.6} className="ag-radar-gps-dot" />
              </g>
            )}

            {/* Active Target Reticle */}
            <g
              transform={`translate(${cellCenterPt.x}, ${cellCenterPt.y})`}
              className="ag-radar-target"
              pointerEvents="none"
            >
              <circle r={7.5} className="ag-radar-target-ring" />
              <line x1={-11} y1={0} x2={-4.5} y2={0} className="ag-radar-target-cross" />
              <line x1={4.5} y1={0} x2={11} y2={0} className="ag-radar-target-cross" />
              <line x1={0} y1={-11} x2={0} y2={-4.5} className="ag-radar-target-cross" />
              <line x1={0} y1={4.5} x2={0} y2={11} className="ag-radar-target-cross" />
              <circle r={2.2} className="ag-radar-target-core" />
            </g>

            {/* Live Hover Crosshair */}
            {hoverPoint && !hoveredRoom && (
              <g
                transform={`translate(${hoverPoint.x}, ${hoverPoint.y})`}
                className="ag-radar-hover-reticle"
                pointerEvents="none"
              >
                <line x1={-6} y1={0} x2={6} y2={0} />
                <line x1={0} y1={-6} x2={0} y2={6} />
                <circle r={3.2} fill="none" />
              </g>
            )}
          </svg>

          {/* Compact HUD Readout Bar */}
          <div className="ag-radar-hud mono">
            {hoveredRoom ? (
              <>
                <span className="ag-radar-hud-accent">#{hoveredRoom.geohash}</span>
                <span className="ag-radar-hud-sep">·</span>
                <span className="truncate">{hoveredRoom.nearestCity ?? 'Active cell'}</span>
                <span className="ag-radar-hud-right">
                  {hoveredRoom.peerCount} {hoveredRoom.peerCount === 1 ? 'peer' : 'peers'}
                </span>
              </>
            ) : hoverPoint ? (
              <>
                <span className="ag-radar-hud-accent">#{hoverPoint.geohash}</span>
                <span className="ag-radar-hud-sep">·</span>
                <span className="truncate">{hoverPoint.label ?? formatCoordPair(hoverPoint.lat, hoverPoint.lon)}</span>
                <span className="ag-radar-hud-right">click</span>
              </>
            ) : (
              <>
                <span className="ag-radar-hud-accent">#{cell.geohash}</span>
                <span className="ag-radar-hud-sep">·</span>
                <span className="truncate">{formatCoordPair(cell.center.lat, cell.center.lon)}</span>
                <span className="ag-radar-hud-right">click map</span>
              </>
            )}
          </div>
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
          {gpsPoint && (
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
            <span>{cell.approxSizeLabel}</span>
            <span>·</span>
            <span>{formatCoordPair(cell.center.lat, cell.center.lon)}</span>
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
          onClick={handleLocateMe}
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
