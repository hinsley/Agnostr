import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  Globe,
  Hash,
  Info,
  Link2,
  Minus,
  Pin,
  PinOff,
  Plus,
  StickyNote,
  X,
} from 'lucide-react'
import type { AgnostrEngine } from '../types/protocol'
import type { PwaState } from '../hooks/usePwa'
import type { SoundCue } from '../utils/sound'
import type { SettingsTab } from './SettingsModal'
import { encodeGeohash, formatCellDimensions, formatCoords } from '../lib/geohash'
import {
  buildBitchatChannelShareUrl,
  formatBitchatChannelLabel,
  isTopicChannel,
  makeCelestialChannelKey,
  parseCelestialChannelKey,
} from '../lib/bitchatChannel'
import { findNearestCelestialLandmark, getBodyDef } from '../lib/solarSystem'
import { UserProfileDock } from './UserProfileDock'

export interface BitchatChannelDrawerProps {
  engine: AgnostrEngine
  isMobileViewport?: boolean
  pwa?: PwaState
  onClose: () => void
  onBackToGlobe: () => void
  onTuneChannel: (channelKey: string) => boolean | void
  onOpenRoomInfo: () => void
  onOpenSettings: (tab?: SettingsTab) => void
  onOpenOwnAgoraProfile?: () => void
  onOpenInstall?: () => void
  onPlaySound?: (cue: SoundCue) => void
}

function formatCompactNoteAge(tsSec: number): string {
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(tsSec))
  if (diffSec < 60) return 'now'
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

function formatLiveAgeMs(tsMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - tsMs) / 1000))
  if (diffSec < 5) return 'now'
  if (diffSec < 60) return `${diffSec}s`
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

function getLiveWarmth(tsMs: number, nowMs: number): 'hot' | 'warm' | 'cool' {
  const ageMs = Math.max(0, nowMs - tsMs)
  if (ageMs < 5 * 60_000) return 'hot'
  if (ageMs < 60 * 60_000) return 'warm'
  return 'cool'
}

export const BitchatChannelDrawer: React.FC<BitchatChannelDrawerProps> = ({
  engine,
  isMobileViewport = true,
  pwa,
  onClose,
  onBackToGlobe,
  onTuneChannel,
  onOpenRoomInfo,
  onOpenSettings,
  onOpenOwnAgoraProfile,
  onOpenInstall,
  onPlaySound,
}) => {
  const [copiedShare, setCopiedShare] = useState(false)
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now())
  const copyTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const tickId = window.setInterval(() => setLiveNowMs(Date.now()), 15_000)
    return () => {
      window.clearInterval(tickId)
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  const { activeGeohash, cell, presence, location, connectedRelayCount, locationNotes } = engine
  const isTopic = isTopicChannel(activeGeohash)
  const channelLabel = formatBitchatChannelLabel(activeGeohash)
  const isPinned = engine.isChannelPinned(activeGeohash)

  const parsedCelestial = isTopic ? null : parseCelestialChannelKey(activeGeohash)
  const activeBodyId = parsedCelestial?.bodyId ?? 'earth'
  const isNonEarth = !isTopic && activeBodyId !== 'earth'
  const bodyDef = getBodyDef(activeBodyId)
  const nonEarthLandmark = isNonEarth
    ? findNearestCelestialLandmark(activeBodyId, cell.center.lat, cell.center.lon)
    : null

  const headerSubtitle = isTopic
    ? 'Topic Asteroid · kind 23333'
    : isNonEarth
      ? `${bodyDef.name}${nonEarthLandmark ? ` · ${nonEarthLandmark}` : ''} · P${cell.precision}`
      : `${cell.nearestCity ?? cell.label} · P${cell.precision}`

  const pinLabel = isTopic
    ? channelLabel
    : isNonEarth
      ? nonEarthLandmark
        ? `${bodyDef.name} · ${nonEarthLandmark}`
        : bodyDef.name
      : (cell.nearestCity ?? undefined)

  const handleTogglePin = () => {
    onPlaySound?.('click')
    engine.togglePinChannel(activeGeohash, pinLabel)
  }

  const handleShareChannel = () => {
    const shareUrl = buildBitchatChannelShareUrl(activeGeohash)
    navigator.clipboard
      ?.writeText(shareUrl)
      .then(() => {
        onPlaySound?.('click')
        engine.pushToast('success', 'Channel link copied', channelLabel)
        setCopiedShare(true)
        if (copyTimerRef.current !== null) {
          window.clearTimeout(copyTimerRef.current)
        }
        copyTimerRef.current = window.setTimeout(() => {
          setCopiedShare(false)
          copyTimerRef.current = null
        }, 1800)
      })
      .catch(() => {
        engine.pushToast('error', 'Unable to copy link')
      })
  }

  const handleZoomOutPrecision = () => {
    if (isTopic || cell.precision <= 1) return
    const nextRaw = cell.geohash.slice(0, -1)
    const nextKey = makeCelestialChannelKey(activeBodyId, nextRaw)
    if (!nextKey) return
    onPlaySound?.('tune')
    onTuneChannel(nextKey)
  }

  const handleZoomInPrecision = () => {
    if (isTopic || cell.precision >= 9) return
    const nextPrecision = cell.precision + 1
    onPlaySound?.('tune')
    if (!isNonEarth) {
      const localNext = location.localGeohashes[nextPrecision]
      if (localNext && localNext.startsWith(cell.geohash)) {
        onTuneChannel(localNext)
        return
      }
    }
    const nextRaw = encodeGeohash(cell.center.lat, cell.center.lon, nextPrecision)
    const nextKey = makeCelestialChannelKey(activeBodyId, nextRaw) ?? nextRaw
    onTuneChannel(nextKey)
  }

  const presenceSummary = presence.isUncertainCount
    ? 'Local area'
    : `${presence.onlineCount} ${presence.onlineCount === 1 ? 'peer online' : 'peers online'}`

  const previewNotes = locationNotes.slice(0, 3)

  const activeGeoLower = activeGeohash.toLowerCase()
  const activeNowRooms = useMemo(() => {
    return engine.pulseRooms
      .slice()
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, 6)
      .map((room) => {
        const keyLower = room.geohash.toLowerCase()
        const roomIsTopic = isTopicChannel(room.geohash)
        const roomCelestial = roomIsTopic ? null : parseCelestialChannelKey(room.geohash)
        const roomNonEarth = Boolean(roomCelestial && roomCelestial.bodyId !== 'earth')
        const roomBodyDef = roomCelestial ? getBodyDef(roomCelestial.bodyId) : null
        const subtitle = roomIsTopic
          ? 'Asteroid'
          : roomNonEarth && roomBodyDef
            ? room.nearestCity && room.nearestCity !== roomBodyDef.name
              ? `${roomBodyDef.name} · ${room.nearestCity}`
              : roomBodyDef.name
            : (room.nearestCity ?? 'Earth')
        const cachedPrev = engine.channelPreviews[keyLower]
        const rawPreview = room.lastPreview?.trim() || cachedPrev?.preview?.trim() || ''
        const rawSender = room.lastSender?.trim() || cachedPrev?.sender?.trim() || ''
        const previewLine = rawPreview
          ? rawSender
            ? `${rawSender}: ${rawPreview}`
            : rawPreview
          : ''
        return {
          room,
          keyLower,
          label: formatBitchatChannelLabel(room.geohash),
          subtitle,
          bodyColor: roomNonEarth && roomBodyDef ? roomBodyDef.palette.primary : null,
          isTopic: roomIsTopic,
          previewLine,
          isActive: keyLower === activeGeoLower,
        }
      })
  }, [engine.pulseRooms, engine.channelPreviews, activeGeoLower])

  return (
    <aside
      className="ag-conv-pane ag-bitchat-drawer"
      aria-label="Channel overview"
      data-mobile={isMobileViewport ? 'true' : undefined}
    >
      {/* Header */}
      <div className="ag-bitchat-drawer-header">
        <div
          className={`ag-bitchat-drawer-emblem${isTopic ? ' is-topic' : ''}`}
          aria-hidden="true"
        >
          {isTopic ? <Hash size={18} /> : <Globe size={18} />}
          {isNonEarth && (
            <span
              className="ag-bitchat-drawer-emblem-dot"
              style={{ backgroundColor: bodyDef.palette.primary }}
            />
          )}
        </div>
        <div className="ag-bitchat-drawer-title-wrap">
          <h2 className="ag-bitchat-drawer-title mono truncate">{channelLabel}</h2>
          <p className="ag-bitchat-drawer-sub truncate">{headerSubtitle}</p>
        </div>
        <button
          type="button"
          className="ag-circle-btn ag-bitchat-drawer-close"
          onClick={() => {
            onPlaySound?.('click')
            onClose()
          }}
          aria-label="Close channel overview"
          title="Close"
        >
          <X size={17} />
        </button>
      </div>

      {/* Scrollable Channel Overview Body (NO list of other geohashes) */}
      <div className="ag-bitchat-drawer-body">
        {/* Quick Actions Grid */}
        <div className="ag-bitchat-drawer-actions" role="group" aria-label="Channel actions">
          <button
            type="button"
            className={`ag-bitchat-drawer-action${isPinned ? ' is-pinned' : ''}`}
            onClick={handleTogglePin}
            aria-pressed={isPinned}
          >
            {isPinned ? (
              <PinOff size={16} className="ag-bitchat-drawer-pin-icon" aria-hidden="true" />
            ) : (
              <Pin size={16} className="ag-bitchat-drawer-pin-icon" aria-hidden="true" />
            )}
            <span>{isPinned ? 'Pinned' : 'Pin'}</span>
          </button>

          <button
            type="button"
            className="ag-bitchat-drawer-action"
            onClick={() => {
              onPlaySound?.('click')
              onBackToGlobe()
            }}
          >
            <Globe size={16} aria-hidden="true" />
            <span>Globe</span>
          </button>

          <button
            type="button"
            className={`ag-bitchat-drawer-action${copiedShare ? ' is-copied' : ''}`}
            onClick={handleShareChannel}
          >
            {copiedShare ? (
              <Check size={16} aria-hidden="true" />
            ) : (
              <Link2 size={16} aria-hidden="true" />
            )}
            <span>{copiedShare ? 'Copied' : 'Share'}</span>
          </button>

          <button
            type="button"
            className="ag-bitchat-drawer-action"
            onClick={() => {
              onPlaySound?.('click')
              onClose()
              onOpenRoomInfo()
            }}
          >
            <Info size={16} aria-hidden="true" />
            <span>Details</span>
          </button>
        </div>

        {/* Channel Info Card */}
        <section className="ag-bitchat-drawer-card" aria-label="Channel details">
          <div className="ag-bitchat-drawer-card-head">
            <span className="ag-bitchat-drawer-kicker">Channel Overview</span>
          </div>
          <dl className="ag-bitchat-drawer-meta-list">
            <div className="ag-bitchat-drawer-meta-row">
              <dt>Presence</dt>
              <dd>
                <span className="ag-bitchat-drawer-live-inline">
                  <span
                    className={`ag-bitchat-drawer-status-dot${
                      connectedRelayCount > 0 ? ' is-online' : ''
                    }`}
                    aria-hidden="true"
                  />
                  <span>{presenceSummary}</span>
                </span>
              </dd>
            </div>

            <div className="ag-bitchat-drawer-meta-row">
              <dt>Relays</dt>
              <dd className="tabular">
                {connectedRelayCount} {connectedRelayCount === 1 ? 'connected' : 'connected'}
              </dd>
            </div>

            <div className="ag-bitchat-drawer-meta-row">
              <dt>Protocol</dt>
              <dd>{isTopic ? 'Topic Asteroid · kind 23333' : 'Ephemeral Nostr · kind 20000'}</dd>
            </div>

            {!isTopic && (
              <>
                <div className="ag-bitchat-drawer-meta-row">
                  <dt>World</dt>
                  <dd>
                    <span className="ag-bitchat-drawer-world-inline">
                      <span
                        className="ag-bitchat-drawer-world-dot"
                        style={{ backgroundColor: bodyDef.palette.primary }}
                        aria-hidden="true"
                      />
                      <span>{bodyDef.name}</span>
                    </span>
                  </dd>
                </div>

                <div className="ag-bitchat-drawer-meta-row">
                  <dt>Precision</dt>
                  <dd>
                    P{cell.precision} · {cell.label}
                  </dd>
                </div>

                <div className="ag-bitchat-drawer-meta-row">
                  <dt>Footprint</dt>
                  <dd className="mono">{formatCellDimensions(cell.bounds)}</dd>
                </div>

                <div className="ag-bitchat-drawer-meta-row">
                  <dt>Coordinates</dt>
                  <dd className="mono">{formatCoords(cell.center)}</dd>
                </div>
              </>
            )}
          </dl>
        </section>

        {/* Precision Scale Pills + P1..P9 Stepper (Geohash channels only) */}
        {!isTopic && (
          <section className="ag-bitchat-drawer-card" aria-label="Area precision">
            <div className="ag-bitchat-drawer-card-head">
              <span className="ag-bitchat-drawer-kicker">Precision Scale</span>
              <span className="ag-bitchat-drawer-kicker-meta mono">P{cell.precision} / P9</span>
            </div>

            <div className="ag-bitchat-drawer-prec-row">
              <button
                type="button"
                className="ag-bitchat-drawer-step-btn"
                onClick={handleZoomOutPrecision}
                disabled={cell.precision <= 1}
                aria-label="Broaden geohash precision"
                title="Broader area (P−1)"
              >
                <Minus size={14} />
              </button>

              <div
                className="ag-bitchat-drawer-prefix-pills"
                role="list"
                aria-label="Geohash precision levels"
              >
                {cell.prefixChain.map((step) => {
                  const isCurrent = step.geohash === cell.geohash
                  const stepKey =
                    makeCelestialChannelKey(activeBodyId, step.geohash) ?? step.geohash
                  const pillLabel = isNonEarth ? `#${stepKey}` : `#${step.geohash}`
                  return (
                    <button
                      key={stepKey}
                      type="button"
                      role="listitem"
                      className={`ag-bitchat-drawer-prefix-pill mono${isCurrent ? ' active' : ''}`}
                      aria-current={isCurrent ? 'true' : undefined}
                      title={`${bodyDef.name} · P${step.precision} (${step.approxSizeLabel})`}
                      onClick={() => {
                        if (isCurrent) return
                        onPlaySound?.('tune')
                        onTuneChannel(stepKey)
                      }}
                    >
                      {pillLabel}
                    </button>
                  )
                })}
              </div>

              <button
                type="button"
                className="ag-bitchat-drawer-step-btn"
                onClick={handleZoomInPrecision}
                disabled={cell.precision >= 9}
                aria-label="Tighten geohash precision"
                title="Tighter area (P+1)"
              >
                <Plus size={14} />
              </button>
            </div>
          </section>
        )}

        {/* Active Now Live Rooms Feed */}
        <section className="ag-bitchat-drawer-card" aria-label="Active now">
          <div className="ag-bitchat-drawer-card-head">
            <span className="ag-bitchat-drawer-kicker ag-bitchat-drawer-kicker-icon">
              <span className="ag-room-warmth-dot is-hot" aria-hidden="true" />
              <span>Active Now</span>
            </span>
            {activeNowRooms.length > 0 && (
              <span className="ag-bitchat-drawer-kicker-meta mono tabular">
                {activeNowRooms.length} live
              </span>
            )}
          </div>

          {activeNowRooms.length > 0 ? (
            <div className="ag-bitchat-drawer-live-list" role="list">
              {activeNowRooms.map((item) => {
                const warmth = getLiveWarmth(item.room.lastActivityAt, liveNowMs)
                const age = formatLiveAgeMs(item.room.lastActivityAt, liveNowMs)
                return (
                  <button
                    key={item.keyLower}
                    type="button"
                    role="listitem"
                    className={`ag-bitchat-drawer-live-row${item.isActive ? ' is-active' : ''}`}
                    aria-current={item.isActive ? 'page' : undefined}
                    onClick={() => {
                      onPlaySound?.('tune')
                      onTuneChannel(item.room.geohash)
                      onClose()
                    }}
                  >
                    <div className="ag-bitchat-drawer-live-head">
                      <span className="ag-bitchat-drawer-live-title-wrap">
                        <span className={`ag-room-warmth-dot is-${warmth}`} aria-hidden="true" />
                        <span className="ag-bitchat-drawer-live-tag mono truncate">
                          {item.label}
                        </span>
                        {item.bodyColor && (
                          <span
                            className="ag-bitchat-drawer-world-dot"
                            style={{ backgroundColor: item.bodyColor }}
                            aria-hidden="true"
                          />
                        )}
                      </span>
                      <span className="ag-bitchat-drawer-live-meta">
                        {item.room.peerCount > 0 && (
                          <span className="ag-bitchat-drawer-live-peers tabular">
                            {item.room.peerCount}p
                          </span>
                        )}
                        <span className="ag-bitchat-drawer-live-age mono tabular">{age}</span>
                        {item.isActive && (
                          <Check
                            size={13}
                            className="ag-bitchat-drawer-live-check"
                            aria-label="Current channel"
                          />
                        )}
                      </span>
                    </div>
                    <div className="ag-bitchat-drawer-live-sub truncate">{item.subtitle}</div>
                    {item.previewLine && (
                      <div className="ag-bitchat-drawer-live-preview truncate">
                        {item.previewLine}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="ag-bitchat-drawer-live-empty">
              Listening for active rooms across relays…
            </div>
          )}
        </section>

        {/* Channel Notes Summary */}
        {previewNotes.length > 0 && (
          <section className="ag-bitchat-drawer-card" aria-label="Channel notes">
            <div className="ag-bitchat-drawer-card-head">
              <span className="ag-bitchat-drawer-kicker ag-bitchat-drawer-kicker-icon">
                <StickyNote size={12} aria-hidden="true" />
                <span>Channel Notes ({locationNotes.length})</span>
              </span>
              <button
                type="button"
                className="ag-bitchat-drawer-link-btn"
                onClick={() => {
                  onPlaySound?.('click')
                  onClose()
                  onOpenRoomInfo()
                }}
              >
                View all
              </button>
            </div>

            <div className="ag-bitchat-drawer-notes">
              {previewNotes.map((note) => (
                <button
                  key={note.id}
                  type="button"
                  className="ag-bitchat-drawer-note-item"
                  onClick={() => {
                    onPlaySound?.('click')
                    onClose()
                    onOpenRoomInfo()
                  }}
                >
                  <div className="ag-bitchat-drawer-note-head">
                    <span className="ag-bitchat-drawer-note-author truncate">
                      {note.displayHandle || note.nickname}
                    </span>
                    <span className="ag-bitchat-drawer-note-age mono">
                      {formatCompactNoteAge(note.createdAt)}
                    </span>
                  </div>
                  <p className="ag-bitchat-drawer-note-body">{note.content}</p>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Shared Bottom User & Multi-Profile Picker Dock */}
      <UserProfileDock
        engine={engine}
        pwa={pwa}
        onOpenSettings={onOpenSettings}
        onOpenOwnAgoraProfile={onOpenOwnAgoraProfile}
        onOpenInstall={onOpenInstall}
        onPlaySound={onPlaySound}
      />
    </aside>
  )
}

export default BitchatChannelDrawer
