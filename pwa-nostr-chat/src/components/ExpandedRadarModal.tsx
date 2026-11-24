import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Crosshair,
  Globe,
  Grid3x3,
  Loader2,
  MapPin,
  MessageSquare,
  Minus,
  Navigation,
  Plus,
  Radio,
  Search,
  ShieldAlert,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { AgnostrEngine, PulseRoom } from '../types/protocol.ts'
import type { SoundCue } from '../utils/sound.ts'
import {
  buildGeohashCell,
  encodeGeohash,
  formatCellDimensions,
  formatCoords,
  getZoomForPrecision,
  isValidGeohash,
  resolveGeohashOrCity,
} from '../lib/geohash.ts'
import { isTopicChannel } from '../lib/radioChannel.ts'
import {
  TacticalGeohashMap,
  type PrecisionSelection,
  type TacticalGeohashMapHandle,
} from './TacticalGeohashMap.tsx'

export interface ExpandedRadarModalProps {
  open: boolean
  engine: AgnostrEngine
  onClose: () => void
  onTuneChannel: (geohash: string) => void
  onPlaySound?: (cue: SoundCue) => void
  /** When true on mobile, renders anchored inside .ag-shell-body above the always-present bottom navbar. */
  inShell?: boolean
}

const PRECISION_OPTIONS: readonly PrecisionSelection[] = ['auto', 1, 2, 3, 4, 5, 6, 7, 8]

function formatPulseAge(tsMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000))
  if (diffSec < 60) return 'live'
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h`
}

function formatInspectSnippet(preview: string): string {
  if (!preview) return ''
  const cleaned = preview
    .replace(/\bcashu[AB][A-Za-z0-9_+/-]{8,}={0,2}/g, 'Cashu ecash')
    .replace(/https?:\/\/\S+/gi, 'Link')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  if (cleaned.length <= 72) return cleaned
  return `${cleaned.slice(0, 71).trimEnd()}…`
}

export function ExpandedRadarModal({
  open,
  engine,
  onClose,
  onTuneChannel,
  onPlaySound,
  inShell = false,
}: ExpandedRadarModalProps) {
  const { activeGeohash, location, pulseRooms, settings } = engine
  const mapRef = useRef<TacticalGeohashMapHandle | null>(null)

  const safeActiveGeo =
    activeGeohash && !isTopicChannel(activeGeohash) && isValidGeohash(activeGeohash)
      ? activeGeohash
      : location.localGeohashes[4] || '9q8y'

  const geoPulseRooms = useMemo(
    () => pulseRooms.filter((r) => !isTopicChannel(r.geohash) && isValidGeohash(r.geohash)),
    [pulseRooms],
  )

  const [selectedGeohash, setSelectedGeohash] = useState<string>(safeActiveGeo)
  const [precisionMode, setPrecisionMode] = useState<PrecisionSelection>('auto')
  const [effectivePrecision, setEffectivePrecision] = useState<number>(safeActiveGeo.length)
  const [showSubZones, setShowSubZones] = useState(false)
  const [showBubbles, setShowBubbles] = useState(true)
  const [pulseDrawerOpen, setPulseDrawerOpen] = useState(false)
  const [searchDraft, setSearchDraft] = useState('')
  const [searchError, setSearchError] = useState<string | null>(null)

  // Reset inspection focus when modal opens
  useEffect(() => {
    if (!open) return
    setSelectedGeohash(safeActiveGeo)
    setPulseDrawerOpen(false)
    setSearchError(null)
  }, [open, safeActiveGeo])

  // Escape closes pulse drawer first, then modal
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (pulseDrawerOpen) {
          setPulseDrawerOpen(false)
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, pulseDrawerOpen, onClose])

  const inspectedHash =
    selectedGeohash && !isTopicChannel(selectedGeohash) && isValidGeohash(selectedGeohash)
      ? selectedGeohash
      : safeActiveGeo
  const localFullGeohash = location.localGeohashes[8] || location.localGeohashes[7]

  const inspectedCell = useMemo(
    () => buildGeohashCell(inspectedHash, localFullGeohash),
    [inspectedHash, localFullGeohash],
  )

  const inspectedDimensions = useMemo(
    () => formatCellDimensions(inspectedCell.bounds),
    [inspectedCell.bounds],
  )

  const isInspectedLocal = useMemo(() => {
    const localAtP = location.localGeohashes[inspectedCell.precision]
    return Boolean(localAtP && localAtP === inspectedCell.geohash)
  }, [location.localGeohashes, inspectedCell.precision, inspectedCell.geohash])

  const matchingPulse: PulseRoom | null = useMemo(() => {
    const exact = geoPulseRooms.find((r) => r.geohash === inspectedCell.geohash)
    if (exact) return exact
    return (
      geoPulseRooms.find(
        (r) =>
          r.geohash.startsWith(inspectedCell.geohash) ||
          inspectedCell.geohash.startsWith(r.geohash),
      ) ?? null
    )
  }, [geoPulseRooms, inspectedCell.geohash])

  const matchingPulseSnippet = useMemo(
    () => (matchingPulse?.lastPreview ? formatInspectSnippet(matchingPulse.lastPreview) : ''),
    [matchingPulse],
  )

  const handleViewportInfoChange = useCallback(
    (info: { zoom: number; effectivePrecision: number }) => {
      setEffectivePrecision(info.effectivePrecision)
    },
    [],
  )

  const handleSelectZone = useCallback(
    (gh: string) => {
      setSelectedGeohash(gh)
      setSearchError(null)
      onPlaySound?.('click')
    },
    [onPlaySound],
  )

  const handleTuneAndClose = useCallback(
    (gh: string) => {
      onTuneChannel(gh)
      onPlaySound?.('tune')
      onClose()
    },
    [onTuneChannel, onPlaySound, onClose],
  )

  if (!open) return null

  const handleSearchSubmit = (e: FormEvent) => {
    e.preventDefault()
    const raw = searchDraft.trim()
    if (!raw) return
    const resolved = resolveGeohashOrCity(raw)
    if (!resolved) {
      setSearchError('Enter a valid #geohash, city, or lat, lon')
      return
    }
    setSearchError(null)
    setSelectedGeohash(resolved)
    setSearchDraft('')
    onPlaySound?.('click')
    mapRef.current?.flyToGeohash(resolved, { animate: true })
  }

  const handlePrecisionPick = (opt: PrecisionSelection) => {
    setPrecisionMode(opt)
    onPlaySound?.('click')
    if (opt !== 'auto') {
      const nextHash = encodeGeohash(
        inspectedCell.center.lat,
        inspectedCell.center.lon,
        opt,
      )
      setSelectedGeohash(nextHash)
      mapRef.current?.flyToGeohash(nextHash, {
        animate: true,
        zoom: getZoomForPrecision(opt),
      })
    }
  }

  const handleZoomOutPrecision = () => {
    if (inspectedCell.precision <= 1) return
    const parent = inspectedCell.geohash.slice(0, -1)
    setSelectedGeohash(parent)
    onPlaySound?.('click')
    mapRef.current?.flyToGeohash(parent, { animate: true })
  }

  const handleSubdivideZoomIn = () => {
    if (inspectedCell.precision >= 8) return
    const nextP = inspectedCell.precision + 1
    const localChild = location.localGeohashes[nextP]
    const target =
      localChild && localChild.startsWith(inspectedCell.geohash)
        ? localChild
        : encodeGeohash(inspectedCell.center.lat, inspectedCell.center.lon, nextP)
    setShowSubZones(true)
    setSelectedGeohash(target)
    onPlaySound?.('click')
    mapRef.current?.flyToGeohash(target, {
      animate: true,
      zoom: getZoomForPrecision(nextP),
    })
  }

  const handleCenterActive = () => {
    setSelectedGeohash(safeActiveGeo)
    onPlaySound?.('click')
    mapRef.current?.flyToGeohash(safeActiveGeo, { animate: true })
  }

  const handleLocateMe = async () => {
    onPlaySound?.('click')
    const gh = await engine.locateMe()
    if (gh) {
      setSelectedGeohash(gh)
      onPlaySound?.('tune')
      mapRef.current?.flyToGeohash(gh, { animate: true })
    }
  }

  const handleWorldView = () => {
    setPrecisionMode('auto')
    setShowSubZones(false)
    onPlaySound?.('click')
    mapRef.current?.fitWorld()
  }

  const handleFlyToPulseRoom = (room: PulseRoom) => {
    setSelectedGeohash(room.geohash)
    setPulseDrawerOpen(false)
    onPlaySound?.('click')
    mapRef.current?.flyToGeohash(room.geohash, { animate: true })
  }

  const isAlreadyActive = inspectedCell.geohash === activeGeohash

  return (
    <div
      className={`ag-radar-modal-backdrop ${inShell ? 'in-shell' : ''}`}
      onClick={onClose}
      role="presentation"
      data-no-swipe="true"
    >
      <div
        className="ag-radar-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Expanded Geohash Radar Map"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Full-bleed Leaflet Tactical Geohash Map */}
        <TacticalGeohashMap
          ref={mapRef}
          mode="expanded"
          theme={settings.theme}
          activeGeohash={safeActiveGeo}
          selectedGeohash={inspectedHash}
          precisionMode={precisionMode}
          showSubZones={showSubZones}
          showPulse={true}
          showBubbles={showBubbles}
          pulseRooms={geoPulseRooms}
          userCoords={location.coords}
          isTeleported={engine.isTeleported}
          onSelectGeohash={handleSelectZone}
          onTuneGeohash={handleTuneAndClose}
          onViewportInfoChange={handleViewportInfoChange}
        />

        {/* Top Floating Tactical Bar */}
        <div className="ag-radar-top-bar">
          <div className="ag-radar-top-row">
            <form className="ag-radar-search-form" onSubmit={handleSearchSubmit}>
              <Search size={14} className="ag-radar-search-icon" />
              <input
                type="text"
                className="ag-radar-search-input mono"
                placeholder="#geohash, city, or lat, lon…"
                value={searchDraft}
                onChange={(e) => {
                  setSearchDraft(e.target.value)
                  if (searchError) setSearchError(null)
                }}
                aria-label="Search geohash, city, or coordinates on radar"
              />
              {searchDraft && (
                <button
                  type="submit"
                  className="ag-radar-search-go mono"
                  aria-label="Fly to location"
                >
                  GO
                </button>
              )}
            </form>

            <button
              type="button"
              className={`ag-radar-top-pill mono ${pulseDrawerOpen ? 'active' : ''}`}
              onClick={() => {
                onPlaySound?.('click')
                setPulseDrawerOpen((v) => !v)
              }}
              aria-expanded={pulseDrawerOpen}
              title="Browse live Global Pulse channels"
            >
              <span className="ag-led ag-led-ok ag-led-pulse" />
              <span>{geoPulseRooms.length} live</span>
            </button>

            <button
              type="button"
              className={`ag-radar-top-pill ag-radar-bubbles-pill mono ${showBubbles ? 'active' : ''}`}
              onClick={() => {
                onPlaySound?.('click')
                setShowBubbles((v) => !v)
              }}
              aria-pressed={showBubbles}
              aria-label="Toggle live speech bubbles"
              title="Toggle live speech bubbles"
            >
              <MessageSquare size={13} />
              <span className="ag-radar-bubble-toggle-label">Bubbles</span>
            </button>

            <button
              type="button"
              className="ag-radar-close-btn"
              onClick={onClose}
              title="Close Expanded Radar (Esc)"
              aria-label="Close expanded radar"
            >
              <X size={18} />
            </button>
          </div>

          {searchError && (
            <div className="ag-radar-search-err" role="status">
              {searchError}
            </div>
          )}

          {/* Precision Selector Strip */}
          <div className="ag-radar-prec-bar" role="group" aria-label="Geohash grid precision">
            <span className="ag-radar-prec-label mono">GRID</span>
            <div className="ag-radar-prec-pills">
              {PRECISION_OPTIONS.map((opt) => {
                const active = precisionMode === opt
                return (
                  <button
                    key={String(opt)}
                    type="button"
                    className={`ag-radar-prec-pill mono ${active ? 'active' : ''}`}
                    onClick={() => handlePrecisionPick(opt)}
                    aria-pressed={active}
                    title={
                      opt === 'auto'
                        ? `Auto precision by zoom (currently P${effectivePrecision})`
                        : `Lock grid to ${opt}-character geohashes`
                    }
                  >
                    {opt === 'auto' ? `Auto · P${effectivePrecision}` : `P${opt}`}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Live Global Pulse Quick-Fly Popover */}
        {pulseDrawerOpen && (
          <div className="ag-radar-pulse-popover" role="region" aria-label="Live Global Pulse rooms">
            <div className="ag-radar-pulse-pop-head">
              <span className="ag-panel-card-title">
                <Radio size={12} />
                <span>LIVE GLOBAL PULSE</span>
              </span>
              <button
                type="button"
                className="ag-icon-btn-xs"
                onClick={() => setPulseDrawerOpen(false)}
                aria-label="Close live pulse list"
              >
                <X size={12} />
              </button>
            </div>

            {geoPulseRooms.length === 0 ? (
              <p className="ag-field-hint" style={{ padding: '0.5rem' }}>
                Listening across global relays for active geohash channels…
              </p>
            ) : (
              <div className="ag-radar-pulse-pop-list">
                {geoPulseRooms.slice(0, 20).map((room) => (
                  <button
                    key={room.geohash}
                    type="button"
                    className={`ag-radar-pulse-item ${room.geohash === inspectedHash ? 'active' : ''}`}
                    onClick={() => handleFlyToPulseRoom(room)}
                  >
                    <div className="ag-radar-pulse-item-main">
                      <span className="ag-radar-hud-accent mono">#{room.geohash}</span>
                      <span className="truncate">
                        {room.nearestCity || formatCoords(room.center)}
                      </span>
                    </div>
                    <div className="ag-radar-pulse-item-meta mono">
                      <span>
                        {room.peerCount} {room.peerCount === 1 ? 'peer' : 'peers'}
                      </span>
                      <span>·</span>
                      <span>{formatPulseAge(room.lastActivityAt)}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Right Floating Touch Stack (Fat-Finger 44×44px Buttons) */}
        <div className="ag-radar-touch-stack" role="toolbar" aria-label="Map controls">
          <button
            type="button"
            className="ag-radar-fab"
            onClick={() => {
              onPlaySound?.('click')
              mapRef.current?.zoomIn()
            }}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <Plus size={18} />
          </button>

          <button
            type="button"
            className="ag-radar-fab"
            onClick={() => {
              onPlaySound?.('click')
              mapRef.current?.zoomOut()
            }}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <Minus size={18} />
          </button>

          <button
            type="button"
            className={`ag-radar-fab ${showSubZones ? 'active' : ''}`}
            onClick={() => {
              onPlaySound?.('click')
              setShowSubZones((v) => !v)
            }}
            aria-pressed={showSubZones}
            title="Toggle 32× Base32 sub-zone grid inside selected cell"
            aria-label="Toggle 32x sub-zones overlay"
          >
            <Grid3x3 size={17} />
          </button>

          <button
            type="button"
            className="ag-radar-fab"
            onClick={handleCenterActive}
            title={`Center on active channel #${activeGeohash}`}
            aria-label="Center on active geohash"
          >
            <Crosshair size={17} />
          </button>

          <button
            type="button"
            className={`ag-radar-fab ${location.status === 'ready' ? 'gps-ready' : ''}`}
            onClick={() => void handleLocateMe()}
            disabled={location.status === 'locating'}
            title="GPS Locate Me"
            aria-label="Locate me via GPS"
          >
            {location.status === 'locating' ? (
              <Loader2 size={17} className="ag-spin" />
            ) : (
              <Navigation size={17} />
            )}
          </button>

          <button
            type="button"
            className="ag-radar-fab"
            onClick={handleWorldView}
            title="World View"
            aria-label="Zoom out to world view"
          >
            <Globe size={17} />
          </button>
        </div>

        {/* Bottom Thumb-Friendly Inspect & Tune Card */}
        <div className="ag-radar-bottom-card">
          <div className="ag-radar-inspect-head">
            <div className="ag-radar-inspect-title">
              <MapPin size={15} className="ag-radar-hud-accent" />
              <span className="ag-radar-inspect-hash mono">#{inspectedCell.geohash}</span>
              <span className="ag-radar-inspect-city truncate">
                {inspectedCell.nearestCity ?? 'Open Coordinates'}
              </span>
            </div>

            <div className="ag-radar-inspect-badges">
              {isAlreadyActive && <span className="ag-badge ag-badge-accent">TUNED</span>}
              <span className={`ag-badge ${isInspectedLocal ? 'ag-badge-ok' : 'ag-badge-warn'}`}>
                {isInspectedLocal ? 'LOCAL' : 'TELEPORT'}
              </span>
              {matchingPulse && (
                <span className="ag-badge ag-badge-ok">
                  <Radio size={9} />
                  <span>
                    {matchingPulse.peerCount}{' '}
                    {matchingPulse.peerCount === 1 ? 'peer' : 'peers'}
                  </span>
                </span>
              )}
            </div>
          </div>

          <div className="ag-radar-inspect-meta mono">
            <span>
              P{inspectedCell.precision} · {inspectedCell.label}
            </span>
            <span>·</span>
            <span>{inspectedDimensions}</span>
            <span>·</span>
            <span>{formatCoords(inspectedCell.center)}</span>
          </div>

          {matchingPulseSnippet && (
            <div className="ag-radar-inspect-snippet">
              <MessageSquare size={12} className="ag-radar-hud-accent" aria-hidden="true" />
              <span className="ag-radar-inspect-snippet-sender">
                {matchingPulse?.lastSender?.trim().replace(/^@+/, '') || 'anon'}:
              </span>
              <span className="ag-radar-inspect-snippet-text truncate">{matchingPulseSnippet}</span>
            </div>
          )}

          {!inspectedCell.allowsPresence && (
            <div className="ag-radar-inspect-privacy">
              <ShieldAlert size={12} />
              <span>Precision ≥6 mutes presence beacons for location privacy.</span>
            </div>
          )}

          <div className="ag-radar-inspect-actions">
            <button
              type="button"
              className="ag-btn ag-btn-secondary"
              onClick={handleZoomOutPrecision}
              disabled={inspectedCell.precision <= 1}
              title="Zoom out to parent geohash"
            >
              <ZoomOut size={14} />
              <span>Parent (p−1)</span>
            </button>

            <button
              type="button"
              className="ag-btn ag-btn-secondary"
              onClick={handleSubdivideZoomIn}
              disabled={inspectedCell.precision >= 8}
              title="Show 32× sub-zones and zoom in"
            >
              <ZoomIn size={14} />
              <span>Subdivide (p+1)</span>
            </button>

            <button
              type="button"
              className="ag-btn ag-btn-primary ag-radar-tune-cta"
              onClick={() => handleTuneAndClose(inspectedCell.geohash)}
            >
              <Radio size={14} />
              <span>
                {isAlreadyActive ? `Stay in #${inspectedCell.geohash}` : `Tune #${inspectedCell.geohash}`}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ExpandedRadarModal
