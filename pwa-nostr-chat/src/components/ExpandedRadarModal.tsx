import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Check,
  Crosshair,
  Globe,
  Grid3x3,
  Hash,
  Loader2,
  MapPin,
  MessageSquare,
  Minus,
  Orbit,
  Pin,
  PinOff,
  Plus,
  Search,
  Waves,
  X,
} from 'lucide-react'
import type { AgnostrEngine, PinnedChannel, PulseRoom } from '../types/protocol.ts'
import type { SoundCue } from '../utils/sound.ts'
import {
  buildGeohashCell,
  encodeGeohash,
  formatCoords,
  getZoomForPrecision,
  isValidGeohash,
} from '../lib/geohash.ts'
import {
  POPULAR_TOPIC_CHANNELS,
  getTopicSlug,
  isTopicChannel,
  makeTopicChannelKey,
  normalizeTopicSlug,
  parseQuickTuneInput,
} from '../lib/bitchatChannel.ts'
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
  /** When true, renders full-bleed inside the Bitchat workspace stage instead of a modal overlay. */
  embedded?: boolean
}

type GlobePopover = 'asteroids' | 'pulse' | null
type PulsePopoverTab = 'live' | 'pinned'

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
  embedded = false,
}: ExpandedRadarModalProps) {
  const { activeGeohash, location, pulseRooms, pinnedChannels, unreadCounts, mentionCounts, settings } =
    engine
  const mapRef = useRef<TacticalGeohashMapHandle | null>(null)

  const safeActiveGeo =
    activeGeohash && !isTopicChannel(activeGeohash) && isValidGeohash(activeGeohash)
      ? activeGeohash
      : location.localGeohashes[4] || '9q8y'

  const initialChannelKey =
    activeGeohash && (isTopicChannel(activeGeohash) || isValidGeohash(activeGeohash))
      ? activeGeohash
      : safeActiveGeo

  const geoPulseRooms = useMemo(
    () => pulseRooms.filter((r) => !isTopicChannel(r.geohash) && isValidGeohash(r.geohash)),
    [pulseRooms],
  )

  const topicPulseRooms = useMemo(
    () => pulseRooms.filter((r) => isTopicChannel(r.geohash)),
    [pulseRooms],
  )

  const pinnedGeohashes = useMemo(
    () => pinnedChannels.filter((p) => !isTopicChannel(p.geohash) && isValidGeohash(p.geohash)),
    [pinnedChannels],
  )

  const pinnedTopics = useMemo(
    () => pinnedChannels.filter((p) => isTopicChannel(p.geohash)),
    [pinnedChannels],
  )

  const [selectedChannel, setSelectedChannel] = useState<string>(initialChannelKey)
  const [precisionMode, setPrecisionMode] = useState<PrecisionSelection>('auto')
  const [showSubZones, setShowSubZones] = useState(false)
  const [showBubbles, setShowBubbles] = useState(true)
  const [activePopover, setActivePopover] = useState<GlobePopover>(null)
  const [pulseTab, setPulseTab] = useState<PulsePopoverTab>('live')
  const [searchDraft, setSearchDraft] = useState('')
  const [searchError, setSearchError] = useState<string | null>(null)
  const [topicJumpDraft, setTopicJumpDraft] = useState('')
  const [topicJumpError, setTopicJumpError] = useState<string | null>(null)

  // Reset inspection focus when modal opens or active channel changes
  useEffect(() => {
    if (!open) return
    setSelectedChannel(initialChannelKey)
    setPrecisionMode('auto')
    setActivePopover(null)
    setSearchError(null)
    setTopicJumpError(null)
  }, [open, initialChannelKey])

  // Escape closes open popovers first; closes modal ONLY when not embedded
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (activePopover) {
        e.preventDefault()
        setActivePopover(null)
      } else if (!embedded) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, activePopover, embedded, onClose])

  const isSelectedTopic = isTopicChannel(selectedChannel)
  const selectedTopicSlug = isSelectedTopic ? (getTopicSlug(selectedChannel) ?? '') : null

  const inspectedHash =
    !isSelectedTopic && isValidGeohash(selectedChannel) ? selectedChannel : safeActiveGeo
  const localFullGeohash = location.localGeohashes[8] || location.localGeohashes[7]

  const inspectedCell = useMemo(
    () => buildGeohashCell(inspectedHash, localFullGeohash),
    [inspectedHash, localFullGeohash],
  )

  const extraTopicKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const item of POPULAR_TOPIC_CHANNELS) {
      const k = makeTopicChannelKey(item.slug)
      if (k) keys.add(k)
    }
    if (isTopicChannel(selectedChannel)) keys.add(selectedChannel.toLowerCase())
    if (isTopicChannel(activeGeohash)) keys.add(activeGeohash.toLowerCase())
    return Array.from(keys)
  }, [selectedChannel, activeGeohash])

  const knownTopicSlugs = useMemo(() => {
    const set = new Set<string>()
    for (const item of POPULAR_TOPIC_CHANNELS) set.add(item.slug.toLowerCase())
    for (const pin of pinnedTopics) {
      const slug = getTopicSlug(pin.geohash)
      if (slug) set.add(slug)
    }
    for (const room of topicPulseRooms) {
      const slug = getTopicSlug(room.geohash)
      if (slug) set.add(slug)
    }
    return set
  }, [pinnedTopics, topicPulseRooms])

  const allTopicCount = useMemo(() => {
    const set = new Set<string>(extraTopicKeys)
    for (const pin of pinnedTopics) set.add(pin.geohash.toLowerCase())
    for (const room of topicPulseRooms) set.add(room.geohash.toLowerCase())
    return set.size
  }, [extraTopicKeys, pinnedTopics, topicPulseRooms])

  const totalLiveCount = geoPulseRooms.length + topicPulseRooms.length

  const matchingPulse: PulseRoom | null = useMemo(() => {
    if (isSelectedTopic) {
      const targetKey = selectedChannel.toLowerCase()
      return topicPulseRooms.find((r) => r.geohash.toLowerCase() === targetKey) ?? null
    }
    const exact = geoPulseRooms.find((r) => r.geohash === inspectedCell.geohash)
    if (exact) return exact
    return (
      geoPulseRooms.find(
        (r) =>
          r.geohash.startsWith(inspectedCell.geohash) ||
          inspectedCell.geohash.startsWith(r.geohash),
      ) ?? null
    )
  }, [isSelectedTopic, selectedChannel, topicPulseRooms, geoPulseRooms, inspectedCell.geohash])

  const matchingPulseSnippet = useMemo(
    () => (matchingPulse?.lastPreview ? formatInspectSnippet(matchingPulse.lastPreview) : ''),
    [matchingPulse],
  )

  const selectedTopicDescription = useMemo(() => {
    if (!selectedTopicSlug) return ''
    return (
      POPULAR_TOPIC_CHANNELS.find((c) => c.slug === selectedTopicSlug)?.description ??
      'Orbiting kind: 23333 topic channel'
    )
  }, [selectedTopicSlug])

  const handleSelectChannel = useCallback(
    (channelKey: string) => {
      setSelectedChannel(channelKey)
      setSearchError(null)
      onPlaySound?.('click')
    },
    [onPlaySound],
  )

  const handleSelectZone = useCallback(
    (gh: string) => {
      setSelectedChannel(gh)
      setSearchError(null)
      onPlaySound?.('click')
    },
    [onPlaySound],
  )

  const handleTuneAndClose = useCallback(
    (channelKey: string) => {
      onTuneChannel(channelKey)
      onPlaySound?.('tune')
      if (!embedded) {
        onClose()
      }
    },
    [onTuneChannel, onPlaySound, embedded, onClose],
  )

  if (!open) return null

  const flyToAnyChannel = (channelKey: string) => {
    setSelectedChannel(channelKey)
    setActivePopover(null)
    setSearchError(null)
    setTopicJumpError(null)
    onPlaySound?.('click')
    if (isTopicChannel(channelKey)) {
      mapRef.current?.flyToTopic(channelKey, { animate: true })
    } else {
      setPrecisionMode('auto')
      mapRef.current?.flyToGeohash(channelKey, { animate: true })
    }
  }

  const handleSearchSubmit = (e: FormEvent) => {
    e.preventDefault()
    const raw = searchDraft.trim()
    if (!raw) return

    const explicitTopic = /^#?topic:/i.test(raw) || raw.startsWith('/')
    const strippedSlug = normalizeTopicSlug(raw)
    const matchesKnownTopic = Boolean(strippedSlug && knownTopicSlugs.has(strippedSlug))

    if (explicitTopic || matchesKnownTopic) {
      const topicKey = makeTopicChannelKey(raw)
      if (topicKey) {
        setSearchDraft('')
        flyToAnyChannel(topicKey)
        return
      }
    }

    const resolved = parseQuickTuneInput(raw, 'geo')
    if (!resolved) {
      setSearchError('Enter a valid #geohash, city, or #topic')
      return
    }
    setSearchDraft('')
    flyToAnyChannel(resolved.key)
  }

  const handleTopicJumpSubmit = (e: FormEvent) => {
    e.preventDefault()
    const raw = topicJumpDraft.trim()
    if (!raw) return
    const topicKey = makeTopicChannelKey(raw)
    if (!topicKey) {
      setTopicJumpError('Use letters, numbers, - or _ (e.g. #nostr)')
      return
    }
    setTopicJumpDraft('')
    flyToAnyChannel(topicKey)
  }

  const handleZoomOutPrecision = () => {
    if (isSelectedTopic || inspectedCell.precision <= 1) return
    const parent = inspectedCell.geohash.slice(0, -1)
    const nextP = parent.length as PrecisionSelection
    setPrecisionMode(nextP)
    setSelectedChannel(parent)
    onPlaySound?.('click')
    mapRef.current?.flyToGeohash(parent, {
      animate: true,
      zoom: getZoomForPrecision(parent.length),
    })
  }

  const handleSubdivideZoomIn = () => {
    if (isSelectedTopic || inspectedCell.precision >= 8) return
    const nextP = inspectedCell.precision + 1
    const localChild = location.localGeohashes[nextP]
    const target =
      localChild && localChild.startsWith(inspectedCell.geohash)
        ? localChild
        : encodeGeohash(inspectedCell.center.lat, inspectedCell.center.lon, nextP)
    setPrecisionMode(nextP as PrecisionSelection)
    setSelectedChannel(target)
    onPlaySound?.('click')
    mapRef.current?.flyToGeohash(target, {
      animate: true,
      zoom: getZoomForPrecision(nextP),
    })
  }

  const handleLocateMe = async () => {
    onPlaySound?.('click')
    const gh = await engine.locateMe()
    if (gh) {
      setSelectedChannel(gh)
      setPrecisionMode('auto')
      setActivePopover(null)
      onPlaySound?.('tune')
      mapRef.current?.flyToGeohash(gh, { animate: true })
    }
  }

  const handleWorldView = () => {
    setPrecisionMode('auto')
    setShowSubZones(false)
    setActivePopover(null)
    onPlaySound?.('click')
    mapRef.current?.fitWorld()
  }

  const handleToggleAsteroidsPopover = () => {
    onPlaySound?.('click')
    setActivePopover((prev) => {
      const next = prev === 'asteroids' ? null : 'asteroids'
      if (next === 'asteroids') {
        mapRef.current?.fitAsteroids()
      }
      return next
    })
  }

  const handleTogglePulsePopover = () => {
    onPlaySound?.('click')
    setActivePopover((prev) => (prev === 'pulse' ? null : 'pulse'))
  }

  const isSelectedPinned = engine.isChannelPinned(selectedChannel)
  const isAlreadyActive = selectedChannel.toLowerCase() === activeGeohash.toLowerCase()

  const handleTogglePinSelected = () => {
    onPlaySound?.('click')
    const label = isSelectedTopic
      ? `#${selectedTopicSlug}`
      : (inspectedCell.nearestCity ?? undefined)
    engine.togglePinChannel(selectedChannel, label)
  }

  const getUnreadBadgeCount = (channelKey: string): number => {
    const keyLower = channelKey.toLowerCase()
    return (unreadCounts[keyLower] ?? 0) + (mentionCounts[keyLower] ?? 0)
  }

  const pinnedTopicKeySet = new Set(pinnedTopics.map((p) => p.geohash.toLowerCase()))
  const liveTopicsExcludingPinned = topicPulseRooms.filter(
    (r) => !pinnedTopicKeySet.has(r.geohash.toLowerCase()),
  )
  const shownTopicKeySet = new Set<string>([
    ...pinnedTopicKeySet,
    ...liveTopicsExcludingPinned.map((r) => r.geohash.toLowerCase()),
  ])
  const starterTopics = POPULAR_TOPIC_CHANNELS.filter((c) => {
    const key = makeTopicChannelKey(c.slug)
    return key ? !shownTopicKeySet.has(key) : false
  })

  const renderPinnedRow = (pin: PinnedChannel) => {
    const isPinTopic = isTopicChannel(pin.geohash)
    const slug = isPinTopic ? getTopicSlug(pin.geohash) : null
    const badgeCount = getUnreadBadgeCount(pin.geohash)
    const isSel = pin.geohash.toLowerCase() === selectedChannel.toLowerCase()
    return (
      <div
        key={pin.geohash}
        className={`ag-radar-pin-list-row${isSel ? ' active' : ''}`}
      >
        <button
          type="button"
          className="ag-radar-pin-list-main"
          onClick={() => flyToAnyChannel(pin.geohash)}
        >
          {isPinTopic ? (
            <Orbit size={12} className="ag-radar-hud-topic" aria-hidden="true" />
          ) : (
            <MapPin size={12} className="ag-radar-hud-accent" aria-hidden="true" />
          )}
          <span className={`${isPinTopic ? 'ag-radar-hud-topic' : 'ag-radar-hud-accent'} mono`}>
            #{isPinTopic ? slug : pin.geohash}
          </span>
          {pin.label && (
            <span className="ag-radar-pin-list-sub truncate">
              {pin.label.replace(/^#/, '')}
            </span>
          )}
          {badgeCount > 0 && (
            <span className="ag-radar-item-unread tabular">
              {badgeCount > 99 ? '99+' : badgeCount}
            </span>
          )}
        </button>
        <button
          type="button"
          className="ag-icon-btn-xs"
          onClick={() => {
            onPlaySound?.('click')
            engine.togglePinChannel(pin.geohash)
          }}
          aria-label={`Unpin ${isPinTopic ? `#${slug}` : `#${pin.geohash}`}`}
          title="Unpin"
        >
          <PinOff size={12} />
        </button>
      </div>
    )
  }

  const stageContent = (
    <>
      {/* Full-bleed 3D Earth + Topic Asteroids Globe */}
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
        pinnedChannels={pinnedChannels}
        topicRooms={topicPulseRooms}
        extraTopicKeys={extraTopicKeys}
        activeChannelKey={activeGeohash}
        selectedChannelKey={selectedChannel}
        userCoords={location.coords}
        isTeleported={engine.isTeleported}
        onSelectGeohash={handleSelectZone}
        onTuneGeohash={handleTuneAndClose}
        onSelectChannel={handleSelectChannel}
        onTuneChannel={handleTuneAndClose}
      />

      {/* Single Sleek Floating Top Row */}
      <div className="ag-radar-top-bar">
        <div className="ag-radar-top-row">
          <form className="ag-radar-search-form" onSubmit={handleSearchSubmit}>
            <Search size={14} className="ag-radar-search-icon" />
            <input
              type="text"
              className="ag-radar-search-input mono"
              placeholder="#geohash, city, or #topic…"
              value={searchDraft}
              onChange={(e) => {
                setSearchDraft(e.target.value)
                if (searchError) setSearchError(null)
              }}
              aria-label="Search geohash, city, or topic on globe"
            />
            {searchDraft && (
              <button
                type="submit"
                className="ag-radar-search-go mono"
                aria-label="Fly to location or topic"
              >
                GO
              </button>
            )}
          </form>

          <button
            type="button"
            className={`ag-radar-top-pill ag-radar-asteroids-pill mono ${
              activePopover === 'asteroids' ? 'active' : ''
            }`}
            onClick={handleToggleAsteroidsPopover}
            aria-expanded={activePopover === 'asteroids'}
            title="Orbiting Topic Asteroids (kind: 23333)"
          >
            <Orbit size={13} aria-hidden="true" />
            <span className="ag-radar-pill-label">Asteroids</span>
            <span className="ag-radar-pill-count tabular">{allTopicCount}</span>
          </button>

          <button
            type="button"
            className={`ag-radar-top-pill mono ${activePopover === 'pulse' ? 'active' : ''}`}
            onClick={handleTogglePulsePopover}
            aria-expanded={activePopover === 'pulse'}
            title="Browse live channels and pinned places"
          >
            <span className="ag-led ag-led-ok ag-led-pulse" />
            <span>
              {totalLiveCount}
              <span className="ag-radar-live-word"> live</span>
            </span>
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

          {!embedded && (
            <button
              type="button"
              className="ag-radar-close-btn"
              onClick={onClose}
              title="Close Map (Esc)"
              aria-label="Close expanded map"
            >
              <X size={18} />
            </button>
          )}
        </div>

        {searchError && (
          <div className="ag-radar-search-err" role="status">
            {searchError}
          </div>
        )}
      </div>

      {/* Topic Asteroids Quick-Fly Popover */}
      {activePopover === 'asteroids' && (
        <div
          className="ag-radar-pulse-popover ag-radar-asteroids-popover"
          role="region"
          aria-label="Topic Asteroids"
        >
          <div className="ag-radar-pulse-pop-head">
            <span className="ag-panel-card-title">
              <Orbit size={12} />
              <span>TOPIC ASTEROIDS</span>
            </span>
            <button
              type="button"
              className="ag-icon-btn-xs"
              onClick={() => setActivePopover(null)}
              aria-label="Close topic asteroids"
            >
              <X size={12} />
            </button>
          </div>

          <form className="ag-radar-topic-form" onSubmit={handleTopicJumpSubmit}>
            <input
              type="text"
              className="ag-input mono ag-radar-topic-input"
              placeholder="Jump to #topic…"
              maxLength={48}
              value={topicJumpDraft}
              onChange={(e) => {
                setTopicJumpDraft(e.target.value)
                if (topicJumpError) setTopicJumpError(null)
              }}
              aria-label="Jump to any topic asteroid"
            />
            <button
              type="submit"
              className="ag-btn ag-btn-primary ag-btn-xs"
              disabled={!topicJumpDraft.trim()}
            >
              Go
            </button>
          </form>

          {topicJumpError && (
            <p className="ag-radar-topic-err" role="alert">
              {topicJumpError}
            </p>
          )}

          <div className="ag-radar-pulse-pop-list">
            {pinnedTopics.length > 0 && (
              <>
                <span className="ag-radar-pop-kicker">Pinned Asteroids</span>
                {pinnedTopics.map(renderPinnedRow)}
              </>
            )}

            {liveTopicsExcludingPinned.length > 0 && (
              <>
                <span className="ag-radar-pop-kicker">Live Asteroids</span>
                {liveTopicsExcludingPinned.map((room) => {
                  const slug = getTopicSlug(room.geohash) ?? room.geohash
                  return (
                    <button
                      key={room.geohash}
                      type="button"
                      className={`ag-radar-pulse-item ${
                        room.geohash.toLowerCase() === selectedChannel.toLowerCase() ? 'active' : ''
                      }`}
                      onClick={() => flyToAnyChannel(room.geohash)}
                    >
                      <div className="ag-radar-pulse-item-main">
                        <Orbit size={12} className="ag-radar-hud-topic" aria-hidden="true" />
                        <span className="ag-radar-hud-topic mono">#{slug}</span>
                      </div>
                      <div className="ag-radar-pulse-item-meta mono">
                        <span>
                          {room.peerCount} {room.peerCount === 1 ? 'peer' : 'peers'}
                        </span>
                        <span>·</span>
                        <span>{formatPulseAge(room.lastActivityAt)}</span>
                      </div>
                    </button>
                  )
                })}
              </>
            )}

            {starterTopics.length > 0 && (
              <>
                <span className="ag-radar-pop-kicker">Popular Asteroids</span>
                {starterTopics.map((item) => {
                  const key = makeTopicChannelKey(item.slug)!
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`ag-radar-pulse-item ${
                        key === selectedChannel.toLowerCase() ? 'active' : ''
                      }`}
                      onClick={() => flyToAnyChannel(key)}
                    >
                      <div className="ag-radar-pulse-item-main">
                        <Hash size={12} className="ag-radar-hud-topic" aria-hidden="true" />
                        <span className="ag-radar-hud-topic mono">{item.label}</span>
                        <span className="ag-radar-pin-list-sub truncate">{item.description}</span>
                      </div>
                    </button>
                  )
                })}
              </>
            )}
          </div>
        </div>
      )}

      {/* Live & Pinned Channels Quick-Fly Popover */}
      {activePopover === 'pulse' && (
        <div
          className="ag-radar-pulse-popover"
          role="region"
          aria-label="Live and pinned Bitchat channels"
        >
          <div className="ag-radar-pulse-pop-head">
            <div className="ag-radar-popover-tabs" role="tablist" aria-label="Channel lists">
              <button
                type="button"
                role="tab"
                aria-selected={pulseTab === 'live'}
                className={`ag-radar-pop-tab${pulseTab === 'live' ? ' active' : ''}`}
                onClick={() => setPulseTab('live')}
              >
                <Waves size={11} />
                <span>Live ({totalLiveCount})</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={pulseTab === 'pinned'}
                className={`ag-radar-pop-tab${pulseTab === 'pinned' ? ' active' : ''}`}
                onClick={() => setPulseTab('pinned')}
              >
                <Pin size={11} />
                <span>Pinned ({pinnedChannels.length})</span>
              </button>
            </div>
            <button
              type="button"
              className="ag-icon-btn-xs"
              onClick={() => setActivePopover(null)}
              aria-label="Close channel list"
            >
              <X size={12} />
            </button>
          </div>

          {pulseTab === 'live' ? (
            totalLiveCount === 0 ? (
              <p className="ag-field-hint" style={{ padding: '0.6rem' }}>
                Listening across global relays for active Earth geohashes and topic asteroids…
              </p>
            ) : (
              <div className="ag-radar-pulse-pop-list">
                {geoPulseRooms.slice(0, 16).map((room) => (
                  <button
                    key={room.geohash}
                    type="button"
                    className={`ag-radar-pulse-item ${
                      room.geohash === selectedChannel ? 'active' : ''
                    }`}
                    onClick={() => flyToAnyChannel(room.geohash)}
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
                {topicPulseRooms.slice(0, 12).map((room) => {
                  const slug = getTopicSlug(room.geohash) ?? room.geohash
                  return (
                    <button
                      key={room.geohash}
                      type="button"
                      className={`ag-radar-pulse-item ${
                        room.geohash.toLowerCase() === selectedChannel.toLowerCase() ? 'active' : ''
                      }`}
                      onClick={() => flyToAnyChannel(room.geohash)}
                    >
                      <div className="ag-radar-pulse-item-main">
                        <Orbit size={12} className="ag-radar-hud-topic" aria-hidden="true" />
                        <span className="ag-radar-hud-topic mono">#{slug}</span>
                        <span className="ag-radar-pin-list-sub">Asteroid</span>
                      </div>
                      <div className="ag-radar-pulse-item-meta mono">
                        <span>
                          {room.peerCount} {room.peerCount === 1 ? 'peer' : 'peers'}
                        </span>
                        <span>·</span>
                        <span>{formatPulseAge(room.lastActivityAt)}</span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )
          ) : pinnedChannels.length === 0 ? (
            <p className="ag-field-hint" style={{ padding: '0.6rem' }}>
              No pinned channels yet. Select any Earth geohash or orbiting Topic Asteroid and tap
              Pin to plant a 3D marker on the globe.
            </p>
          ) : (
            <div className="ag-radar-pulse-pop-list">
              {pinnedGeohashes.length > 0 && (
                <>
                  <span className="ag-radar-pop-kicker">Pinned on Earth</span>
                  {pinnedGeohashes.map(renderPinnedRow)}
                </>
              )}
              {pinnedTopics.length > 0 && (
                <>
                  <span className="ag-radar-pop-kicker">Pinned Asteroids</span>
                  {pinnedTopics.map(renderPinnedRow)}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Right Floating Controls (3 Core Actions + Desktop-Only +/- Zoom) */}
      <div className="ag-radar-touch-stack" role="toolbar" aria-label="Globe controls">
        <button
          type="button"
          className={`ag-radar-fab ${location.status === 'ready' ? 'gps-ready' : ''}`}
          onClick={() => void handleLocateMe()}
          disabled={location.status === 'locating'}
          title="Locate Me"
          aria-label="Locate Me"
        >
          {location.status === 'locating' ? (
            <Loader2 size={17} className="ag-spin" />
          ) : (
            <Crosshair size={17} />
          )}
        </button>

        <button
          type="button"
          className="ag-radar-fab"
          onClick={handleWorldView}
          title="World View"
          aria-label="World View"
        >
          <Globe size={17} />
        </button>

        <button
          type="button"
          className={`ag-radar-fab ${showSubZones ? 'active' : ''}`}
          onClick={() => {
            onPlaySound?.('click')
            setShowSubZones((v) => !v)
          }}
          aria-pressed={showSubZones}
          title="Sub-Zones"
          aria-label="Toggle 32x sub-zones"
        >
          <Grid3x3 size={17} />
        </button>

        <div className="ag-radar-zoom-pair ag-radar-desktop-only">
          <button
            type="button"
            className="ag-radar-fab ag-radar-fab-compact"
            onClick={() => {
              onPlaySound?.('click')
              mapRef.current?.zoomIn()
            }}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <Plus size={16} />
          </button>
          <button
            type="button"
            className="ag-radar-fab ag-radar-fab-compact"
            onClick={() => {
              onPlaySound?.('click')
              mapRef.current?.zoomOut()
            }}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <Minus size={16} />
          </button>
        </div>
      </div>

      {/* Compact Bottom Selected-Channel Card (Earth Geohash OR Orbiting Topic Asteroid) */}
      <div className="ag-radar-bottom-card">
        <div className="ag-radar-bottom-info">
          <div className="ag-radar-inspect-title">
            {isSelectedTopic ? (
              <>
                <Hash size={14} className="ag-radar-hud-topic" aria-hidden="true" />
                <span className="ag-radar-inspect-hash is-topic mono">
                  #{selectedTopicSlug}
                </span>
                <span className="ag-radar-topic-chip">Asteroid</span>
              </>
            ) : (
              <>
                <MapPin size={14} className="ag-radar-hud-accent" aria-hidden="true" />
                <span className="ag-radar-inspect-hash mono">#{inspectedCell.geohash}</span>
                <span className="ag-radar-inspect-city truncate">
                  {inspectedCell.nearestCity ?? 'Open Coordinates'}
                </span>
              </>
            )}
            {matchingPulse && (
              <span
                className="ag-radar-live-chip mono"
                title={`${matchingPulse.peerCount} active ${matchingPulse.peerCount === 1 ? 'peer' : 'peers'}`}
              >
                <span className="ag-led ag-led-ok" />
                <span>{matchingPulse.peerCount}</span>
              </span>
            )}
          </div>

          {matchingPulseSnippet ? (
            <div className="ag-radar-inspect-snippet">
              <span className="ag-radar-inspect-snippet-sender">
                {matchingPulse?.lastSender?.trim().replace(/^@+/, '') || 'anon'}:
              </span>
              <span className="ag-radar-inspect-snippet-text truncate">
                {matchingPulseSnippet}
              </span>
            </div>
          ) : isSelectedTopic && selectedTopicDescription ? (
            <div className="ag-radar-inspect-snippet">
              <span className="ag-radar-inspect-snippet-text truncate">
                {selectedTopicDescription}
              </span>
            </div>
          ) : null}
        </div>

        <div className="ag-radar-bottom-actions">
          {!isSelectedTopic && (
            <div
              className="ag-radar-prec-stepper"
              role="group"
              aria-label="Geohash precision"
            >
              <button
                type="button"
                className="ag-radar-prec-step-btn"
                onClick={handleZoomOutPrecision}
                disabled={inspectedCell.precision <= 1}
                title="Broader precision (P−1)"
                aria-label="Decrease geohash precision"
              >
                <Minus size={13} />
              </button>
              <span
                className="ag-radar-prec-step-val mono"
                title={`Precision P${inspectedCell.precision}`}
              >
                P{inspectedCell.precision}
              </span>
              <button
                type="button"
                className="ag-radar-prec-step-btn"
                onClick={handleSubdivideZoomIn}
                disabled={inspectedCell.precision >= 8}
                title="Finer precision (P+1)"
                aria-label="Increase geohash precision"
              >
                <Plus size={13} />
              </button>
            </div>
          )}

          <button
            type="button"
            className={`ag-btn ag-btn-secondary ag-radar-pin-btn${isSelectedPinned ? ' is-pinned' : ''}`}
            onClick={handleTogglePinSelected}
            aria-pressed={isSelectedPinned}
            title={isSelectedPinned ? 'Unpin from Globe' : 'Pin to Globe'}
          >
            {isSelectedPinned ? <PinOff size={14} /> : <Pin size={14} />}
            <span>{isSelectedPinned ? 'Pinned' : 'Pin'}</span>
          </button>

          <button
            type="button"
            className="ag-btn ag-btn-primary ag-radar-tune-cta"
            onClick={() => handleTuneAndClose(selectedChannel)}
          >
            {isAlreadyActive ? (
              embedded ? (
                <>
                  <Waves size={14} />
                  <span>Open Chat</span>
                </>
              ) : (
                <>
                  <Check size={14} />
                  <span>Active</span>
                </>
              )
            ) : (
              <>
                <Waves size={14} />
                <span>Tune In</span>
              </>
            )}
          </button>
        </div>
      </div>
    </>
  )

  if (embedded) {
    return (
      <div
        className="ag-radar-embedded"
        role="region"
        aria-label="Bitchat 3D Globe"
        data-no-swipe="true"
      >
        {stageContent}
      </div>
    )
  }

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
        aria-label="Expanded Geohash Globe Map"
        onClick={(e) => e.stopPropagation()}
      >
        {stageContent}
      </div>
    </div>
  )
}

export default ExpandedRadarModal
