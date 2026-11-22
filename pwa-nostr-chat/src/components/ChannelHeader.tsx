import React from 'react'
import type { CSSProperties } from 'react'
import {
  ArrowLeft,
  Info,
  Lock,
  Map as MapIcon,
  PanelLeft,
  Phone,
  Radio,
  Search,
  ShieldCheck,
  Video,
} from 'lucide-react'
import type { AgnostrEngine } from '../types/protocol'
import { identiconDataUrl } from '../utils/identicon'

function getServerMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'SV'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase()
}

export interface ChannelHeaderProps {
  engine: AgnostrEngine
  sidebarCollapsed: boolean
  roomInfoOpen: boolean
  searchOpen: boolean
  hasOtherUnread?: boolean
  onMobileBack: () => void
  onToggleSidebar: () => void
  onOpenRoomInfo: () => void
  onOpenTrustedSettings: () => void
  onToggleSearch: () => void
  onExpandRadar: () => void
  onFocusActiveCall?: () => void
}

export const ChannelHeader: React.FC<ChannelHeaderProps> = ({
  engine,
  sidebarCollapsed,
  roomInfoOpen,
  searchOpen,
  hasOtherUnread = false,
  onMobileBack,
  onToggleSidebar,
  onOpenRoomInfo,
  onOpenTrustedSettings,
  onToggleSearch,
  onExpandRadar,
  onFocusActiveCall,
}) => {
  const isDm = engine.activeView.type === 'dm' && engine.activeDmThread !== null
  const isServer =
    engine.activeView.type === 'server' &&
    engine.servers.activeServer !== null &&
    engine.servers.activeChannel !== null
  const dmThread = engine.activeDmThread
  const activeServer = engine.servers.activeServer
  const activeChannel = engine.servers.activeChannel

  const activeCall = engine.calls.activeCall
  const dmPeerTrusted = Boolean(
    isDm && dmThread && engine.isExplicitlyTrusted(dmThread.peerPubkey)
  )
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
  const isDisconnected = engine.connectedRelayCount === 0

  const handleDmCallClick = (media: 'audio' | 'video') => {
    if (!dmThread) return
    if (inThisDmCall) {
      onFocusActiveCall?.()
      return
    }
    if (!dmPeerTrusted) {
      engine.pushToast(
        'warning',
        `Trust ${dmThread.peerDisplayHandle} first`,
        'P2P calls connect directly. Open Chat Info and trust this person to unlock calls.'
      )
      return
    }
    void engine.calls.startDmCall(dmThread.peerPubkey, media, dmThread.peerNickname)
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
        'Group calls support up to 6 participants at once.'
      )
      return
    }
    void engine.calls.joinServerCall(activeServer.id, 'audio')
  }

  const onlineSubtitle = engine.presence.isUncertainCount
    ? 'Private precision · Ephemeral'
    : `${engine.presence.onlineCount} online · Ephemeral`

  return (
    <header className="ag-header">
      <div className="ag-header-top">
        <div className="ag-header-left">
          {/* Native Mobile Back Button (< 868px) */}
          <button
            type="button"
            className="ag-circle-btn ag-mobile-back-btn ag-mobile-only"
            onClick={onMobileBack}
            aria-label="Back to conversations"
          >
            <ArrowLeft size={20} />
            {hasOtherUnread && <span className="ag-back-unread-dot" aria-hidden="true" />}
          </button>

          {/* Desktop Expand Sidebar Button (only shown if collapsed with Cmd+B) */}
          {sidebarCollapsed && (
            <button
              type="button"
              className="ag-circle-btn ag-desktop-only"
              onClick={onToggleSidebar}
              title="Show conversations (Cmd+B)"
              aria-label="Show conversations"
            >
              <PanelLeft size={18} />
            </button>
          )}

          {/* Clickable Chat Identity Area -> Opens RoomInfoSheet */}
          <button
            type="button"
            className="ag-header-identity"
            onClick={onOpenRoomInfo}
            aria-label="Open chat info"
          >
            {isDm && dmThread ? (
              <>
                <img
                  src={identiconDataUrl(dmThread.peerPubkey)}
                  alt=""
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
              </>
            ) : isServer && activeServer && activeChannel ? (
              <>
                <div
                  className="ag-header-avatar server"
                  style={
                    {
                      '--srv-accent': activeServer.accentColor || 'var(--accent)',
                    } as CSSProperties
                  }
                  aria-hidden="true"
                >
                  {activeServer.picture && /^https?:\/\//i.test(activeServer.picture) ? (
                    <img
                      src={activeServer.picture}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  ) : activeServer.icon?.trim() ? (
                    <span>{activeServer.icon}</span>
                  ) : (
                    <span className="mono">{getServerMonogram(activeServer.name)}</span>
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
                        : `${activeServer.name} · Saved`}
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="ag-header-avatar radio" aria-hidden="true">
                  <Radio size={18} />
                </div>
                <div className="ag-header-text">
                  <div className="ag-header-title-row">
                    <span className="ag-header-title truncate">
                      <span className="mono">#{engine.activeGeohash}</span>
                      {engine.cell.nearestCity && (
                        <span className="ag-header-city"> · {engine.cell.nearestCity}</span>
                      )}
                    </span>
                  </div>
                  <div className="ag-header-sub truncate">
                    {isDisconnected && <span className="ag-offline-dot" aria-hidden="true" />}
                    <span>{isDisconnected ? 'Offline · Reconnecting…' : onlineSubtitle}</span>
                  </div>
                </div>
              </>
            )}
          </button>

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

        {/* Right Header Toolbar — Strictly 3 Clean Circular Buttons */}
        <div className="ag-header-actions">
          {isDm && dmThread ? (
            <>
              <button
                type="button"
                className={`ag-circle-btn ${inThisDmCall ? 'active-ok' : ''}`}
                onClick={() => handleDmCallClick('audio')}
                title={
                  inThisDmCall
                    ? 'Focus active voice call'
                    : dmPeerTrusted
                      ? `Voice call ${dmThread.peerDisplayHandle}`
                      : `Trust ${dmThread.peerDisplayHandle} first to unlock calls`
                }
                aria-label={inThisDmCall ? 'Focus active voice call' : 'Start voice call'}
              >
                <Phone size={18} />
              </button>

              <button
                type="button"
                className={`ag-circle-btn ${inThisDmCall && activeCall?.mediaType === 'video' ? 'active-ok' : ''}`}
                onClick={() => handleDmCallClick('video')}
                title={
                  inThisDmCall
                    ? 'Focus active video call'
                    : dmPeerTrusted
                      ? `Video call ${dmThread.peerDisplayHandle}`
                      : `Trust ${dmThread.peerDisplayHandle} first to unlock calls`
                }
                aria-label={inThisDmCall ? 'Focus active video call' : 'Start video call'}
              >
                <Video size={18} />
              </button>

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
                className={`ag-circle-btn ${searchOpen ? 'active' : ''}`}
                onClick={onToggleSearch}
                title="Search messages (Cmd+F)"
                aria-label="Search messages"
              >
                <Search size={18} />
              </button>

              <button
                type="button"
                className={`ag-circle-btn ${roomInfoOpen ? 'active' : ''}`}
                onClick={onOpenRoomInfo}
                title="Server info & members (Cmd+I)"
                aria-label="Server info"
              >
                <Info size={18} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="ag-circle-btn"
                onClick={onExpandRadar}
                title="Open Full Map"
                aria-label="Open Geohash Map"
              >
                <MapIcon size={18} />
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
