import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Gamepad2,
  Globe,
  Hash,
  Info,
  Languages,
  Lock,
  PanelLeft,
  Phone,
  Pin,
  Search,
  ShieldCheck,
  Users,
  Zap,
} from 'lucide-react'
import type { AgnostrEngine, PulseRoom } from '../types/protocol'
import { makeGameScopeKey } from '../types/games'
import type { ZapTarget } from '../types/wallet'
import {
  formatBitchatChannelLabel,
  getChannelBodyName,
  isTopicChannel,
  parseCelestialChannelKey,
} from '../lib/bitchatChannel'
import { getBodyDef } from '../lib/solarSystem'
import { getGroupSpecifier, hasUploadedGroupPicture } from '../utils/groupIcon'
import { AvatarImg } from './AvatarImg'

function formatCompactAgeMs(tsMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - tsMs) / 1000))
  if (diffSec < 5) return 'now'
  if (diffSec < 60) return `${diffSec}s`
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

function getRoomWarmth(lastActivityAtMs: number, nowMs: number): 'hot' | 'warm' | 'cool' {
  const ageMs = Math.max(0, nowMs - lastActivityAtMs)
  if (ageMs < 5 * 60_000) return 'hot'
  if (ageMs < 60 * 60_000) return 'warm'
  return 'cool'
}

function resolveChannelMeta(
  channelKey: string,
  nearestCity?: string | null,
  pinLabel?: string
): { isTopic: boolean; bodyColor: string | null; subtitle: string | null } {
  if (isTopicChannel(channelKey)) {
    return { isTopic: true, bodyColor: null, subtitle: 'Asteroid' }
  }
  const celestial = parseCelestialChannelKey(channelKey)
  if (celestial && celestial.bodyId !== 'earth') {
    const def = getBodyDef(celestial.bodyId)
    const city = nearestCity?.trim() || pinLabel?.trim() || ''
    const subtitle = city && city !== def.name ? `${def.name} · ${city}` : def.name
    return { isTopic: false, bodyColor: def.palette.primary, subtitle }
  }
  return {
    isTopic: false,
    bodyColor: null,
    subtitle: nearestCity?.trim() || pinLabel?.trim() || null,
  }
}

export interface ChannelHeaderProps {
  engine: AgnostrEngine
  sidebarCollapsed: boolean
  userListOpen?: boolean
  roomInfoOpen: boolean
  searchOpen: boolean
  hasOtherUnread?: boolean
  onMobileBack: () => void
  onOpenBitchatChannels?: () => void
  bitchatChannelsOpen?: boolean
  onToggleSidebar: () => void
  onToggleUserList?: () => void
  onOpenRoomInfo: () => void
  onOpenTrustedSettings: () => void
  onToggleSearch: () => void
  onExpandRadar: () => void
  onBackToGlobe?: () => void
  onTuneChannel?: (channelKey: string) => boolean | void
  onOpenGameLauncher?: () => void
  onFocusActiveCall?: () => void
  onOpenZap?: (target: ZapTarget) => void
}

export const ChannelHeader: React.FC<ChannelHeaderProps> = ({
  engine,
  sidebarCollapsed,
  userListOpen = false,
  roomInfoOpen,
  searchOpen,
  hasOtherUnread = false,
  onMobileBack,
  onOpenBitchatChannels,
  bitchatChannelsOpen,
  onToggleSidebar,
  onToggleUserList,
  onOpenRoomInfo,
  onOpenTrustedSettings,
  onToggleSearch,
  onExpandRadar,
  onBackToGlobe,
  onTuneChannel,
  onOpenGameLauncher,
  onFocusActiveCall,
  onOpenZap,
}) => {
  const isDm = engine.activeView.type === 'dm' && engine.activeDmThread !== null
  const isServer =
    engine.activeView.type === 'server' &&
    engine.servers.activeServer !== null &&
    engine.servers.activeChannel !== null
  const dmThread = engine.activeDmThread
  const activeServer = engine.servers.activeServer
  const activeChannel = engine.servers.activeChannel
  const [failedServerPictureUrl, setFailedServerPictureUrl] = useState<string | null>(null)
  const activeServerPicture = activeServer?.picture?.trim() || ''
  const showServerPicture =
    hasUploadedGroupPicture(activeServerPicture) &&
    failedServerPictureUrl !== activeServerPicture

  const activeCall = engine.calls.activeCall
  const dmPeerPubkey = isDm && dmThread ? dmThread.peerPubkey : null
  const dmPeerTrusted = Boolean(
    isDm && dmThread && engine.isExplicitlyTrusted(dmThread.peerPubkey)
  )
  const dmPeerLud16 = dmPeerPubkey ? engine.zaps.getPeerLightningAddress(dmPeerPubkey) : null
  const dmPeerCanZap = dmPeerPubkey ? engine.zaps.canZapPeer(dmPeerPubkey) : false
  const translatorEnabled = engine.translator.settings.enabled
  const translatorLang = engine.translator.settings.myLanguage

  const { ensureProfilePictures } = engine

  useEffect(() => {
    if (!dmPeerPubkey) return
    ensureProfilePictures([dmPeerPubkey])
    void engine.zaps.lookupPeerLightningAddress(dmPeerPubkey)
    void engine.zaps.lookupPeerNutzapInfo(dmPeerPubkey)
  }, [dmPeerPubkey, ensureProfilePictures, engine.zaps])

  const handleToggleTranslator = () => {
    engine.translator.updateSettings({ enabled: !translatorEnabled })
  }
  const inThisDmCall = Boolean(
    isDm &&
      dmThread &&
      activeCall?.mode === 'dm' &&
      activeCall.peerPubkey?.toLowerCase() === dmThread.peerPubkey.toLowerCase()
  )
  const serverCallCount =
    isServer && activeServer ? engine.calls.getServerCallCount(activeServer.id) : 0
  const inThisServerCall = Boolean(
    isServer &&
      activeServer &&
      activeCall?.mode === 'server' &&
      activeCall.serverId === activeServer.id
  )
  const isServerCallFull =
    isServer && !inThisServerCall && serverCallCount >= engine.calls.maxParticipants
  const activeGeoKey = engine.activeGeohash.toLowerCase()
  const isTopicBitchat = !isDm && !isServer && isTopicChannel(engine.activeGeohash)
  const celestialInfo = !isDm && !isServer ? parseCelestialChannelKey(engine.activeGeohash) : null
  const isNonEarthCelestial = Boolean(celestialInfo && celestialInfo.bodyId !== 'earth')
  const celestialBodyName = isNonEarthCelestial ? getChannelBodyName(engine.activeGeohash) : null
  const celestialLandmark =
    isNonEarthCelestial &&
    engine.cell.nearestCity &&
    engine.cell.nearestCity !== celestialBodyName
      ? engine.cell.nearestCity
      : null
  const bitchatLabel = formatBitchatChannelLabel(engine.activeGeohash)
  const geoCallCount = !isDm && !isServer ? engine.calls.getGeoCallCount(activeGeoKey) : 0
  const inThisGeoCall = Boolean(
    !isDm &&
      !isServer &&
      activeCall?.mode === 'geo' &&
      activeCall.geohash?.toLowerCase() === activeGeoKey
  )
  const isGeoCallFull =
    !isDm && !isServer && !inThisGeoCall && geoCallCount >= engine.calls.maxParticipants
  const isDisconnected = engine.connectedRelayCount === 0
  const isBitchatChannel = !isDm && !isServer

  const gameScopeKey =
    isDm && dmThread
      ? makeGameScopeKey('dm', dmThread.peerPubkey)
      : isServer && activeServer
        ? makeGameScopeKey('server', activeServer.id)
        : makeGameScopeKey('geo', engine.activeGeohash)
  const activeGameHere = engine.games?.activeGamesByScope?.[gameScopeKey]
  const inviteHere = Boolean(
    engine.games?.incomingInvites?.some((inv) => inv.scopeKey === gameScopeKey)
  )
  const pokerTableHere = engine.games?.roomPokerTables?.[gameScopeKey]
  const hasGameActivityHere = Boolean(activeGameHere || inviteHere || pokerTableHere)
  const dmGameTitle = activeGameHere
    ? 'Open active game'
    : inviteHere
      ? 'Incoming game invite'
      : 'Play Go or Chess'
  const roomGameTitle =
    activeGameHere ? "Open Texas Hold'em Poker"
      : pokerTableHere ? 'View poker table'
        : "Start Texas Hold'em Poker"

  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [switcherNowMs, setSwitcherNowMs] = useState(() => Date.now())
  const switcherWrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setSwitcherOpen(false)
  }, [activeGeoKey, isDm, isServer])

  useEffect(() => {
    if (!switcherOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setSwitcherOpen(false)
      }
    }
    const onPointerDown = (e: PointerEvent) => {
      const wrap = switcherWrapRef.current
      if (wrap && e.target instanceof Node && !wrap.contains(e.target)) {
        setSwitcherOpen(false)
      }
    }
    const tickId = window.setInterval(() => setSwitcherNowMs(Date.now()), 15_000)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.clearInterval(tickId)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [switcherOpen])

  const { pinnedRoomRows, activeNowRows, hasOtherLiveRooms } = useMemo(() => {
    if (!isBitchatChannel) {
      return { pinnedRoomRows: [], activeNowRows: [], hasOtherLiveRooms: false }
    }
    const pulseByKey = new Map<string, PulseRoom>()
    let otherLive = false
    for (const room of engine.pulseRooms) {
      const keyLower = room.geohash.toLowerCase()
      pulseByKey.set(keyLower, room)
      if (keyLower !== activeGeoKey) otherLive = true
    }

    const pinnedKeys = new Set<string>()
    const pinned = engine.pinnedChannels.map((pin) => {
      const keyLower = pin.geohash.toLowerCase()
      pinnedKeys.add(keyLower)
      const liveRoom = pulseByKey.get(keyLower)
      const meta = resolveChannelMeta(pin.geohash, liveRoom?.nearestCity, pin.label)
      const unread = engine.unreadCounts[keyLower] ?? 0
      const mentions = engine.mentionCounts[keyLower] ?? 0
      return {
        key: pin.geohash,
        keyLower,
        label: formatBitchatChannelLabel(pin.geohash),
        meta,
        unread,
        mentions,
        livePeers: liveRoom?.peerCount ?? 0,
        isActive: keyLower === activeGeoKey,
      }
    })

    const activeNow = engine.pulseRooms
      .filter((room) => !pinnedKeys.has(room.geohash.toLowerCase()))
      .slice()
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, 8)
      .map((room) => {
        const keyLower = room.geohash.toLowerCase()
        const meta = resolveChannelMeta(room.geohash, room.nearestCity)
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
          meta,
          previewLine,
          isActive: keyLower === activeGeoKey,
        }
      })

    return {
      pinnedRoomRows: pinned,
      activeNowRows: activeNow,
      hasOtherLiveRooms: otherLive,
    }
  }, [
    isBitchatChannel,
    engine.pulseRooms,
    engine.pinnedChannels,
    engine.unreadCounts,
    engine.mentionCounts,
    engine.channelPreviews,
    activeGeoKey,
  ])

  const handleSelectSwitcherRoom = (channelKey: string) => {
    setSwitcherOpen(false)
    if (onTuneChannel) {
      onTuneChannel(channelKey)
    } else {
      engine.tuneBitchatChannel(channelKey)
    }
  }

  const handleDmCallClick = () => {
    if (!dmThread) return
    if (inThisDmCall) {
      onFocusActiveCall?.()
      return
    }
    if (!dmPeerTrusted) {
      engine.pushToast(
        'warning',
        `Trust ${dmThread.peerDisplayHandle} first`,
        'Open Chat Info and trust this person to unlock calls.'
      )
      return
    }
    void engine.calls.startDmCall(dmThread.peerPubkey, 'audio', dmThread.peerNickname)
  }

  const handleServerCallClick = () => {
    if (!activeServer) return
    if (inThisServerCall) {
      onFocusActiveCall?.()
      return
    }
    if (isServerCallFull) {
      engine.pushToast(
        'warning',
        `Voice Lounge full (${engine.calls.maxParticipants}/${engine.calls.maxParticipants})`,
        'Up to 6 participants per call.'
      )
      return
    }
    void engine.calls.joinServerCall(activeServer.id, 'audio')
  }

  const handleGeoCallClick = () => {
    if (inThisGeoCall) {
      onFocusActiveCall?.()
      return
    }
    if (isGeoCallFull) {
      engine.pushToast(
        'warning',
        `Call full (${engine.calls.maxParticipants}/${engine.calls.maxParticipants})`,
        'Up to 6 participants per call.'
      )
      return
    }
    void engine.calls.joinGeoCall(engine.activeGeohash, 'audio')
  }

  const baseGeoOnlineText = engine.presence.isUncertainCount
    ? isNonEarthCelestial
      ? 'High-precision sector'
      : 'Local area'
    : `${engine.presence.onlineCount} online`
  const onlineSubtitle = isTopicBitchat
    ? 'Topic'
    : isNonEarthCelestial
      ? celestialLandmark
        ? `${celestialLandmark} · ${baseGeoOnlineText}`
        : baseGeoOnlineText
      : baseGeoOnlineText

  return (
    <header className="ag-header">
      <div className="ag-header-top">
        <div className="ag-header-left">
          {/* Native Mobile Back Button (< 868px) */}
          <button
            type="button"
            className="ag-circle-btn ag-mobile-back-btn ag-mobile-only"
            onClick={!isDm && !isServer ? (onBackToGlobe ?? onMobileBack) : onMobileBack}
            title={!isDm && !isServer ? 'Back to Globe' : 'Back to conversations'}
            aria-label={!isDm && !isServer ? 'Back to Globe' : 'Back to conversations'}
          >
            <ArrowLeft size={20} />
            {hasOtherUnread && <span className="ag-back-unread-dot" aria-hidden="true" />}
          </button>

          {/* Desktop Back-to-Globe (Bitchat) or Expand Sidebar Button (People/Groups) */}
          {!isDm && !isServer ? (
            <button
              type="button"
              className="ag-header-globe-back-btn ag-desktop-only"
              onClick={onBackToGlobe ?? onExpandRadar}
              title="Back to Bitchat Globe"
              aria-label="Back to Globe"
            >
              <ArrowLeft size={15} />
              <Globe size={15} />
              <span>Globe</span>
            </button>
          ) : (
            sidebarCollapsed && (
              <button
                type="button"
                className="ag-circle-btn ag-desktop-only"
                onClick={onToggleSidebar}
                title="Show conversations (Cmd+B)"
                aria-label="Show conversations"
              >
                <PanelLeft size={18} />
              </button>
            )
          )}

          {/* Clickable Chat Identity Area -> Opens RoomInfoSheet (DM/Group) or Pinned & Live Switcher (Bitchat) */}
          {isDm && dmThread ? (
            <button
              type="button"
              className="ag-header-identity"
              onClick={onOpenRoomInfo}
              aria-label="Open chat info"
            >
              <AvatarImg
                pubkey={dmThread.peerPubkey}
                pictureUrl={engine.getProfilePicture(dmThread.peerPubkey)}
                alt=""
                width={36}
                height={36}
                className="ag-header-avatar-img"
              />
              <div className="ag-header-text">
                <div className="ag-header-title-row">
                  <span className="ag-header-title truncate">{dmThread.peerNickname}</span>
                  {dmPeerTrusted && (
                    <ShieldCheck
                      size={14}
                      className="ag-trusted-shield-icon"
                      aria-label="Trusted peer"
                    />
                  )}
                </div>
                <div className="ag-header-sub truncate">
                  {isDisconnected && <span className="ag-offline-dot" aria-hidden="true" />}
                  <span>
                    {isDisconnected
                      ? 'Offline · Encrypted DM'
                      : dmPeerTrusted
                        ? 'Encrypted DM · Trusted'
                        : 'Encrypted DM'}
                  </span>
                </div>
              </div>
            </button>
          ) : isServer && activeServer && activeChannel ? (
            <button
              type="button"
              className="ag-header-identity"
              onClick={onOpenRoomInfo}
              aria-label="Open chat info"
            >
              <div
                className="ag-header-avatar server"
                style={
                  {
                    '--srv-accent': activeServer.accentColor || 'var(--accent)',
                  } as CSSProperties
                }
                aria-hidden="true"
              >
                {showServerPicture ? (
                  <img
                    src={activeServerPicture}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={() => setFailedServerPictureUrl(activeServerPicture)}
                  />
                ) : (
                  <span className="mono">
                    {getGroupSpecifier(activeServer.name, activeServer.icon)}
                  </span>
                )}
              </div>
              <div className="ag-header-text">
                <div className="ag-header-title-row">
                  <span className="ag-header-title truncate">#{activeChannel.name}</span>
                  {activeServer.encrypted && (
                    <Lock size={13} className="ag-header-lock-icon" aria-label="Encrypted" />
                  )}
                </div>
                <div className="ag-header-sub truncate">
                  {isDisconnected && <span className="ag-offline-dot" aria-hidden="true" />}
                  <span>
                    {isDisconnected
                      ? `Offline · ${activeServer.name}`
                      : activeServer.name}
                  </span>
                </div>
              </div>
            </button>
          ) : (
            <div ref={switcherWrapRef} className="ag-header-switcher-wrap">
              <button
                type="button"
                className={`ag-header-identity ag-header-switcher-btn ${switcherOpen ? 'is-open' : ''}`}
                onClick={() => {
                  if (onOpenBitchatChannels) {
                    setSwitcherOpen(false)
                    onOpenBitchatChannels()
                    return
                  }
                  setSwitcherNowMs(Date.now())
                  setSwitcherOpen((v) => !v)
                }}
                aria-haspopup={onOpenBitchatChannels ? undefined : 'dialog'}
                aria-controls={onOpenBitchatChannels ? 'ag-bitchat-channels' : undefined}
                aria-expanded={onOpenBitchatChannels ? bitchatChannelsOpen : switcherOpen}
                aria-label="Switch Bitchat channel"
              >
                <div
                  className={`ag-header-avatar ${isTopicBitchat ? 'topic' : 'bitchat'}`}
                  aria-hidden="true"
                >
                  {isTopicBitchat ? <Hash size={18} /> : <Globe size={18} />}
                </div>
                <div className="ag-header-text">
                  <div className="ag-header-title-row">
                    <span className="ag-header-title truncate">
                      <span className="mono">{bitchatLabel}</span>
                      {!isTopicBitchat &&
                        (isNonEarthCelestial
                          ? celestialBodyName && (
                              <span className="ag-header-city"> · {celestialBodyName}</span>
                            )
                          : engine.cell.nearestCity && (
                              <span className="ag-header-city"> · {engine.cell.nearestCity}</span>
                            ))}
                    </span>
                    {isTopicBitchat && (
                      <span
                        className="ag-header-topic-pill ag-hide-xs"
                        title="Orbiting Topic Asteroid"
                      >
                        Topic
                      </span>
                    )}
                    {hasOtherLiveRooms && (
                      <span
                        className="ag-header-switcher-live-dot"
                        aria-hidden="true"
                        title="Other active Bitchat rooms"
                      />
                    )}
                    <ChevronDown
                      size={14}
                      className="ag-header-switcher-chevron"
                      aria-hidden="true"
                    />
                  </div>
                  <div className="ag-header-sub truncate">
                    {isDisconnected && <span className="ag-offline-dot" aria-hidden="true" />}
                    <span>{isDisconnected ? 'Offline · Reconnecting…' : onlineSubtitle}</span>
                  </div>
                </div>
              </button>

              {switcherOpen && (
                <div
                  className="ag-room-switcher-popover"
                  role="dialog"
                  aria-label="Pinned and active Bitchat rooms"
                >
                  <div className="ag-room-switcher-list">
                    {pinnedRoomRows.length > 0 && (
                      <div className="ag-room-switcher-section">
                        <div className="ag-room-switcher-kicker">
                          <span>Pinned Rooms</span>
                          <span className="ag-room-switcher-count tabular">
                            {pinnedRoomRows.length}
                          </span>
                        </div>
                        {pinnedRoomRows.map((item) => (
                          <button
                            key={item.keyLower}
                            type="button"
                            className={`ag-room-switcher-row ${item.isActive ? 'is-active' : ''}`}
                            onClick={() => handleSelectSwitcherRoom(item.key)}
                            aria-current={item.isActive ? 'page' : undefined}
                          >
                            <span className="ag-room-switcher-leading" aria-hidden="true">
                              <Pin size={13} className="ag-room-switcher-pin-icon" />
                            </span>
                            <span className="ag-room-switcher-main">
                              <span className="ag-room-switcher-top">
                                <span className="ag-room-switcher-label mono truncate">
                                  {item.label}
                                </span>
                                {item.meta.isTopic ? (
                                  <span
                                    className="ag-room-switcher-kind-badge"
                                    title="Topic Asteroid"
                                  >
                                    <Hash size={10} aria-hidden="true" />
                                  </span>
                                ) : item.meta.bodyColor ? (
                                  <span
                                    className="ag-room-switcher-world-dot"
                                    style={{ backgroundColor: item.meta.bodyColor }}
                                    aria-hidden="true"
                                  />
                                ) : null}
                                {item.meta.subtitle && (
                                  <span className="ag-room-switcher-sub truncate">
                                    {item.meta.subtitle}
                                  </span>
                                )}
                              </span>
                            </span>
                            <span className="ag-room-switcher-trailing">
                              {item.livePeers > 0 && (
                                <span className="ag-room-switcher-peers tabular">
                                  {item.livePeers}p
                                </span>
                              )}
                              {(item.unread > 0 || item.mentions > 0) && (
                                <span
                                  className={`ag-room-switcher-unread tabular ${item.mentions > 0 ? 'is-ping' : ''}`}
                                >
                                  {item.unread > 99 ? '99+' : item.unread || item.mentions}
                                </span>
                              )}
                              {item.isActive && (
                                <Check
                                  size={14}
                                  className="ag-room-switcher-check"
                                  aria-label="Current channel"
                                />
                              )}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}

                    {activeNowRows.length > 0 && (
                      <div className="ag-room-switcher-section">
                        <div className="ag-room-switcher-kicker">
                          <span>Active Now</span>
                          <span className="ag-room-switcher-count tabular">
                            {activeNowRows.length}
                          </span>
                        </div>
                        {activeNowRows.map((item) => {
                          const warmth = getRoomWarmth(item.room.lastActivityAt, switcherNowMs)
                          const age = formatCompactAgeMs(item.room.lastActivityAt, switcherNowMs)
                          return (
                            <button
                              key={item.keyLower}
                              type="button"
                              className={`ag-room-switcher-row ${item.isActive ? 'is-active' : ''}`}
                              onClick={() => handleSelectSwitcherRoom(item.room.geohash)}
                              aria-current={item.isActive ? 'page' : undefined}
                            >
                              <span className="ag-room-switcher-leading" aria-hidden="true">
                                <span className={`ag-room-warmth-dot is-${warmth}`} />
                              </span>
                              <span className="ag-room-switcher-main">
                                <span className="ag-room-switcher-top">
                                  <span className="ag-room-switcher-label mono truncate">
                                    {item.label}
                                  </span>
                                  {item.meta.isTopic ? (
                                    <span className="ag-room-switcher-badge">Asteroid</span>
                                  ) : item.meta.bodyColor ? (
                                    <span
                                      className="ag-room-switcher-world-dot"
                                      style={{ backgroundColor: item.meta.bodyColor }}
                                      aria-hidden="true"
                                    />
                                  ) : null}
                                  {!item.meta.isTopic && item.meta.subtitle && (
                                    <span className="ag-room-switcher-sub truncate">
                                      {item.meta.subtitle}
                                    </span>
                                  )}
                                </span>
                                {item.previewLine && (
                                  <span className="ag-room-switcher-preview truncate">
                                    {item.previewLine}
                                  </span>
                                )}
                              </span>
                              <span className="ag-room-switcher-trailing">
                                {item.room.peerCount > 0 && (
                                  <span className="ag-room-switcher-peers tabular">
                                    {item.room.peerCount}p
                                  </span>
                                )}
                                <span className="ag-room-switcher-age mono tabular">{age}</span>
                                {item.isActive && (
                                  <Check
                                    size={14}
                                    className="ag-room-switcher-check"
                                    aria-label="Current channel"
                                  />
                                )}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    )}

                    {pinnedRoomRows.length === 0 && activeNowRows.length === 0 && (
                      <div className="ag-room-switcher-empty">
                        Listening for active rooms across relays…
                      </div>
                    )}
                  </div>

                  <div className="ag-room-switcher-footer">
                    <button
                      type="button"
                      className="ag-room-switcher-globe-btn"
                      onClick={() => {
                        setSwitcherOpen(false)
                        ;(onBackToGlobe ?? onExpandRadar)()
                      }}
                    >
                      <Globe size={14} aria-hidden="true" />
                      <span>Explore 3D Globe</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Subtle Trusted Only Pill — shown ONLY when strict mode is enabled */}
          {engine.strictWhitelistMode && (
            <button
              type="button"
              className="ag-trusted-only-pill"
              onClick={onOpenTrustedSettings}
              title="Trusted Peers Only mode is on — click to manage Privacy & Trust"
              aria-label="Trusted Peers Only active"
            >
              <ShieldCheck size={13} />
              <span className="ag-hide-xs">Trusted only</span>
            </button>
          )}
        </div>

        {/* Right Header Toolbar */}
        <div className="ag-header-actions">
          {isDm && dmThread ? (
            <>
              {dmPeerCanZap && onOpenZap && (
                <button
                  type="button"
                  className="ag-circle-btn ag-zap-btn"
                  onClick={() =>
                    onOpenZap({
                      pubkey: dmThread.peerPubkey,
                      nickname: dmThread.peerNickname,
                      lud16: dmPeerLud16,
                      channelLabel: dmThread.peerDisplayHandle,
                    })
                  }
                  title={
                    dmPeerLud16
                      ? `Zap ${dmThread.peerNickname} (${dmPeerLud16})`
                      : `Zap ${dmThread.peerNickname} (Nutzap)`
                  }
                  aria-label={`Zap ${dmThread.peerNickname}`}
                >
                  <Zap size={17} />
                </button>
              )}

              <button
                type="button"
                className={`ag-circle-btn ${inThisDmCall ? 'active-ok' : ''}`}
                onClick={handleDmCallClick}
                title={
                  inThisDmCall
                    ? 'Focus active call'
                    : dmPeerTrusted
                      ? `Call ${dmThread.peerDisplayHandle}`
                      : `Trust ${dmThread.peerDisplayHandle} first to unlock calls`
                }
                aria-label={inThisDmCall ? 'Focus active call' : 'Start call'}
              >
                <Phone size={18} />
              </button>

              <button
                type="button"
                className={`ag-circle-btn ag-header-game-btn ${hasGameActivityHere ? 'active' : ''}`}
                onClick={() => onOpenGameLauncher?.()}
                title={dmGameTitle}
                aria-label={dmGameTitle}
              >
                <Gamepad2 size={18} />
                {hasGameActivityHere && (
                  <span className="ag-back-unread-dot ag-header-game-dot" aria-hidden="true" />
                )}
              </button>

              <button
                type="button"
                className={`ag-circle-btn ${translatorEnabled ? 'active' : ''}`}
                onClick={handleToggleTranslator}
                title={
                  translatorEnabled
                    ? `Exit Translator Mode (${translatorLang})`
                    : `Translate chat (${translatorLang})`
                }
                aria-label={translatorEnabled ? 'Exit Translator Mode' : 'Open Translator Mode'}
                aria-pressed={translatorEnabled}
              >
                <Languages size={17} />
              </button>

              {onToggleUserList && (
                <button
                  type="button"
                  className={`ag-circle-btn ${userListOpen ? 'active' : ''}`}
                  onClick={onToggleUserList}
                  title={userListOpen ? 'Hide user list' : 'Show user list'}
                  aria-label={userListOpen ? 'Hide user list' : 'Show user list'}
                  aria-pressed={userListOpen}
                >
                  <Users size={18} />
                </button>
              )}

              <button
                type="button"
                className={`ag-circle-btn ${roomInfoOpen ? 'active' : ''}`}
                onClick={onOpenRoomInfo}
                title="Chat info (Cmd+I)"
                aria-label="Chat info"
              >
                <Info size={18} />
              </button>
            </>
          ) : isServer && activeServer ? (
            <>
              <button
                type="button"
                className={`ag-header-call-btn ${inThisServerCall || serverCallCount > 0 ? 'has-peers' : ''} ${inThisServerCall ? 'active-ok' : ''}`}
                onClick={handleServerCallClick}
                disabled={isServerCallFull}
                title={
                  inThisServerCall
                    ? 'Focus active Voice Lounge'
                    : isServerCallFull
                      ? `Voice Lounge full (${engine.calls.maxParticipants}/${engine.calls.maxParticipants})`
                      : `Join Voice Lounge (${serverCallCount}/${engine.calls.maxParticipants})`
                }
                aria-label={
                  inThisServerCall
                    ? 'Focus active voice call'
                    : `Join voice call (${serverCallCount} of ${engine.calls.maxParticipants})`
                }
              >
                <Phone size={17} />
                {(serverCallCount > 0 || inThisServerCall) && (
                  <span className="ag-header-call-count tabular">
                    {serverCallCount}/{engine.calls.maxParticipants}
                  </span>
                )}
              </button>

              <button
                type="button"
                className={`ag-circle-btn ag-header-game-btn ${hasGameActivityHere ? 'active' : ''}`}
                onClick={() => onOpenGameLauncher?.()}
                title={roomGameTitle}
                aria-label={roomGameTitle}
              >
                <Gamepad2 size={18} />
                {hasGameActivityHere && (
                  <span className="ag-back-unread-dot ag-header-game-dot" aria-hidden="true" />
                )}
              </button>

              <button
                type="button"
                className={`ag-circle-btn ${translatorEnabled ? 'active' : ''}`}
                onClick={handleToggleTranslator}
                title={
                  translatorEnabled
                    ? `Exit Translator Mode (${translatorLang})`
                    : `Translate chat (${translatorLang})`
                }
                aria-label={translatorEnabled ? 'Exit Translator Mode' : 'Open Translator Mode'}
                aria-pressed={translatorEnabled}
              >
                <Languages size={17} />
              </button>

              <button
                type="button"
                className={`ag-circle-btn ${searchOpen ? 'active' : ''}`}
                onClick={onToggleSearch}
                title="Search messages (Cmd+F)"
                aria-label="Search messages"
              >
                <Search size={18} />
              </button>

              {onToggleUserList && (
                <button
                  type="button"
                  className={`ag-circle-btn ${userListOpen ? 'active' : ''}`}
                  onClick={onToggleUserList}
                  title={userListOpen ? 'Hide member list' : 'Show member list'}
                  aria-label={userListOpen ? 'Hide member list' : 'Show member list'}
                  aria-pressed={userListOpen}
                >
                  <Users size={18} />
                </button>
              )}

              <button
                type="button"
                className={`ag-circle-btn ${roomInfoOpen ? 'active' : ''}`}
                onClick={onOpenRoomInfo}
                title="Group info & members (Cmd+I)"
                aria-label="Group info"
              >
                <Info size={18} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`ag-header-call-btn ${inThisGeoCall || geoCallCount > 0 ? 'has-peers' : ''} ${inThisGeoCall ? 'active-ok' : ''}`}
                onClick={handleGeoCallClick}
                disabled={isGeoCallFull}
                title={
                  inThisGeoCall
                    ? `Focus active ${bitchatLabel} call`
                    : isGeoCallFull
                      ? `${isTopicBitchat ? 'Topic Bitchat' : 'Geo Bitchat'} call full (${engine.calls.maxParticipants}/${engine.calls.maxParticipants})`
                      : geoCallCount > 0
                        ? `Join ${bitchatLabel} Call (${geoCallCount}/${engine.calls.maxParticipants})`
                        : `Start Call in ${bitchatLabel}`
                }
                aria-label={
                  inThisGeoCall
                    ? 'Focus active call'
                    : geoCallCount > 0
                      ? `Join call (${geoCallCount} of ${engine.calls.maxParticipants})`
                      : `Start call in ${bitchatLabel}`
                }
              >
                <Phone size={17} />
                {(geoCallCount > 0 || inThisGeoCall) && (
                  <span className="ag-header-call-count tabular">
                    {geoCallCount}/{engine.calls.maxParticipants}
                  </span>
                )}
              </button>

              <button
                type="button"
                className={`ag-circle-btn ag-header-game-btn ${hasGameActivityHere ? 'active' : ''}`}
                onClick={() => onOpenGameLauncher?.()}
                title={roomGameTitle}
                aria-label={roomGameTitle}
              >
                <Gamepad2 size={18} />
                {hasGameActivityHere && (
                  <span className="ag-back-unread-dot ag-header-game-dot" aria-hidden="true" />
                )}
              </button>

              <button
                type="button"
                className={`ag-circle-btn ${translatorEnabled ? 'active' : ''}`}
                onClick={handleToggleTranslator}
                title={
                  translatorEnabled
                    ? `Exit Translator Mode (${translatorLang})`
                    : `Translate chat (${translatorLang})`
                }
                aria-label={translatorEnabled ? 'Exit Translator Mode' : 'Open Translator Mode'}
                aria-pressed={translatorEnabled}
              >
                <Languages size={17} />
              </button>

              <button
                type="button"
                className={`ag-circle-btn ${searchOpen ? 'active' : ''}`}
                onClick={onToggleSearch}
                title="Search messages (Cmd+F)"
                aria-label="Search messages"
              >
                <Search size={18} />
              </button>

              {onToggleUserList && (
                <button
                  type="button"
                  className={`ag-circle-btn ${userListOpen ? 'active' : ''}`}
                  onClick={onToggleUserList}
                  title={userListOpen ? 'Hide user list' : 'Show user list'}
                  aria-label={userListOpen ? 'Hide user list' : 'Show user list'}
                  aria-pressed={userListOpen}
                >
                  <Users size={18} />
                </button>
              )}

              <button
                type="button"
                className={`ag-circle-btn ${roomInfoOpen ? 'active' : ''}`}
                onClick={onOpenRoomInfo}
                title="Room info & people (Cmd+I)"
                aria-label="Room info"
              >
                <Info size={18} />
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  )
}

export default ChannelHeader
