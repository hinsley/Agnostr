import React, { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import {
  ArrowLeft,
  Compass,
  Crosshair,
  Download,
  Globe,
  Lock,
  Navigation,
  PanelLeft,
  PanelRight,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Star,
  StickyNote,
  User,
  UserPlus,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react'
import type { AgnostrEngine, InspectorTab, PeerInfo } from '../types/protocol'
import type { ServerSettingsTab } from './ServerSettingsModal'
import { identiconDataUrl, pubkeyToColor } from '../utils/identicon'

function getServerMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'SV'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase()
}

export interface ChannelHeaderProps {
  engine: AgnostrEngine
  sidebarOpen: boolean
  inspectorOpen: boolean
  inspectorTab: InspectorTab
  searchOpen: boolean
  onToggleSidebar: () => void
  onOpenInspectorTab: (tab: InspectorTab) => void
  onToggleInspector: () => void
  onToggleSearch: () => void
  onToggleSound: () => void
  onTuneChannel: (geohash: string) => void
  onLocateMe: () => void
  onInspectPeer: (peer: PeerInfo) => void
  onOpenServerSettings?: (serverId: string, initialTab?: ServerSettingsTab) => void
  onExport?: (format: 'markdown' | 'json') => void
}

export const ChannelHeader: React.FC<ChannelHeaderProps> = ({
  engine,
  sidebarOpen,
  inspectorOpen,
  inspectorTab,
  searchOpen,
  onToggleSidebar,
  onOpenInspectorTab,
  onToggleInspector,
  onToggleSearch,
  onToggleSound,
  onTuneChannel,
  onLocateMe,
  onInspectPeer,
  onOpenServerSettings,
  onExport,
}) => {
  const isDm = engine.activeView.type === 'dm' && engine.activeDmThread !== null
  const isServer =
    engine.activeView.type === 'server' &&
    engine.servers.activeServer !== null &&
    engine.servers.activeChannel !== null
  const dmThread = engine.activeDmThread
  const activeServer = engine.servers.activeServer
  const activeChannel = engine.servers.activeChannel
  const pinned = engine.isChannelPinned(engine.activeGeohash)
  const activeStepRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!isDm && !isServer && activeStepRef.current) {
      activeStepRef.current.scrollIntoView({
        inline: 'nearest',
        block: 'nearest',
        behavior: 'smooth',
      })
    }
  }, [engine.activeGeohash, isDm, isServer])

  const relayStatusClass =
    engine.connectedRelayCount === 0
      ? 'danger'
      : engine.connectedRelayCount < Math.max(2, Math.floor(engine.totalRelayCount / 3))
        ? 'warn'
        : 'ok'

  // Determine deepest known local geohash if user has GPS lock & current cell is a prefix of it
  const deeperLocalStep = (() => {
    if (!engine.location.coords || isDm || isServer) return null
    const nextLen = engine.cell.precision + 1
    if (nextLen > 8) return null
    const localAtNext = engine.location.localGeohashes[nextLen]
    if (localAtNext && localAtNext.startsWith(engine.activeGeohash)) {
      return localAtNext
    }
    return null
  })()

  return (
    <header className="ag-header">
      <div className="ag-header-top">
        <div className="ag-header-left">
          {!sidebarOpen && (
            <button
              type="button"
              className="ag-icon-btn"
              onClick={onToggleSidebar}
              title="Open sidebar (Cmd+B)"
              aria-label="Open sidebar"
            >
              <PanelLeft size={18} />
            </button>
          )}

          {isDm && dmThread ? (
            <div className="ag-dm-header-peer">
              <button
                type="button"
                className="ag-icon-btn"
                onClick={() => onTuneChannel(engine.activeGeohash)}
                title={`Back to #${engine.activeGeohash}`}
                aria-label="Back to geohash channel"
              >
                <ArrowLeft size={16} />
              </button>
              <img
                src={identiconDataUrl(dmThread.peerPubkey)}
                alt=""
                className="ag-avatar-sm"
              />
              <div className="ag-chan-meta">
                <div className="ag-chan-title-line">
                  <span
                    className="ag-chan-name"
                    style={{ color: pubkeyToColor(dmThread.peerPubkey), fontWeight: 700 }}
                  >
                    {dmThread.peerDisplayHandle}
                  </span>
                  {engine.isExplicitlyTrusted(dmThread.peerPubkey) && (
                    <span
                      className="ag-trusted-shield-icon"
                      title={`Trusted peer — voice memos from ${dmThread.peerDisplayHandle} are unlocked`}
                      aria-label="Trusted peer"
                    >
                      <ShieldCheck size={13} />
                    </span>
                  )}
                  <span className="ag-badge dm">
                    <Lock size={10} />
                    {dmThread.protocol === 'bitchat' ? 'BITCHAT v2' : 'NIP-17 E2EE'}
                  </span>
                </div>
                <span className="ag-chan-sub mono">
                  End-to-end encrypted · {dmThread.messages.length}{' '}
                  {dmThread.messages.length === 1 ? 'msg' : 'msgs'}
                </span>
              </div>
            </div>
          ) : isServer && activeServer && activeChannel ? (
            <div className="ag-dm-header-peer">
              <div
                className="ag-srv-header-chip"
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
              <div className="ag-chan-meta">
                <div className="ag-chan-title-line">
                  <span className="ag-chan-title-geo">
                    <span
                      className="hash"
                      style={{ color: activeServer.accentColor || 'var(--accent)' }}
                    >
                      #
                    </span>
                    {activeChannel.name}
                  </span>
                  <span className="ag-chan-city ag-desktop-only">· {activeServer.name}</span>
                  {activeServer.kind === 'nip29' ? (
                    <span className="ag-badge mesh" title="NIP-29 Relay-Moderated Community">
                      <Server size={9} />
                      NIP-29
                    </span>
                  ) : activeServer.encrypted ? (
                    <span
                      className="ag-badge dm"
                      title="End-to-end encrypted virtual server (AES-256-GCM)"
                    >
                      <Lock size={9} />
                      E2EE
                    </span>
                  ) : (
                    <span className="ag-badge accent" title="Public Nostr virtual server">
                      <Globe size={9} />
                      PUBLIC
                    </span>
                  )}
                </div>
                {(activeChannel.topic || activeServer.description) && (
                  <span className="ag-chan-sub">
                    {activeChannel.topic || activeServer.description}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="ag-chan-heading">
              <div className="ag-chan-title-wrap">
                <span className="ag-chan-title-geo">
                  <span className="hash">#</span>
                  {engine.activeGeohash}
                </span>
                {engine.cell.nearestCity && (
                  <span className="ag-chan-city ag-desktop-only">
                    {engine.cell.nearestCity}
                  </span>
                )}
              </div>

              <button
                type="button"
                className={`ag-icon-btn ag-pin-btn ${pinned ? 'pinned' : ''}`}
                style={{ height: 28, minWidth: 28 }}
                onClick={() =>
                  engine.togglePinChannel(
                    engine.activeGeohash,
                    engine.cell.nearestCity ?? undefined
                  )
                }
                title={pinned ? 'Unpin frequency' : 'Pin frequency to sidebar'}
                aria-label={pinned ? 'Unpin channel' : 'Pin channel'}
              >
                <Star size={14} fill={pinned ? 'currentColor' : 'none'} />
              </button>

              {engine.isTeleported ? (
                <span
                  className="ag-badge warn ag-desktop-only"
                  title="Teleported away from GPS location (messages carry Bitchat teleport tag)"
                >
                  <Navigation size={10} />
                  TELEPORT
                </span>
              ) : (
                <span
                  className="ag-badge ok ag-desktop-only"
                  title="Matched to your physical GPS geohash (native local broadcast)"
                >
                  <Crosshair size={10} />
                  LOCAL
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right Header Toolbar */}
        <div className="ag-header-actions">
          {engine.strictWhitelistMode && (
            <button
              type="button"
              className={`ag-pill-btn ag-trusted-only-pill ${inspectorOpen && inspectorTab === 'identity' ? 'active' : ''}`}
              onClick={() => onOpenInspectorTab('identity')}
              title="Trusted Peers Only mode active — hiding messages from untrusted peers. Click to open Trusted Peers & Safety settings."
              aria-label="Trusted Peers Only active — open Trusted Peers and Safety settings"
            >
              <ShieldCheck size={13} />
              <span className="mono">TRUSTED ONLY</span>
            </button>
          )}

          {!isDm && !isServer && (
            <>
              <button
                type="button"
                className={`ag-pill-btn ${inspectorOpen && inspectorTab === 'peers' ? 'active' : ''}`}
                onClick={() => onOpenInspectorTab('peers')}
                title={
                  engine.presence.isUncertainCount
                    ? 'High-precision privacy mode: presence heartbeats paused; count uncertain'
                    : `${engine.presence.onlineCount} active peers in #${engine.activeGeohash}`
                }
              >
                <Users size={13} />
                <span className="mono tabular">
                  {engine.presence.isUncertainCount ? '?' : engine.presence.onlineCount}
                </span>
              </button>

              <button
                type="button"
                className={`ag-pill-btn ag-desktop-only ${inspectorOpen && inspectorTab === 'notes' ? 'active' : ''}`}
                onClick={() => onOpenInspectorTab('notes')}
                title="24h Location Dead-Drop Notes (/drop)"
              >
                <StickyNote size={13} />
                <span className="mono tabular">{engine.locationNotes.length}</span>
              </button>
            </>
          )}

          {isServer && activeServer && (
            <>
              <button
                type="button"
                className="ag-pill-btn ag-hide-xs"
                onClick={() => onOpenServerSettings?.(activeServer.id, 'overview')}
                title={`Invite peers to ${activeServer.name}`}
              >
                <UserPlus size={13} />
                <span className="ag-desktop-only">Invite</span>
              </button>

              <button
                type="button"
                className="ag-icon-btn ag-hide-xs"
                onClick={() => onOpenServerSettings?.(activeServer.id, 'overview')}
                title="Server settings, channels & moderation"
                aria-label="Server settings"
              >
                <Settings size={15} />
              </button>

              {onExport && (
                <button
                  type="button"
                  className="ag-icon-btn ag-hide-xs"
                  onClick={() => onExport('markdown')}
                  title="Export channel transcript (Markdown)"
                  aria-label="Export channel transcript"
                >
                  <Download size={15} />
                </button>
              )}
            </>
          )}

          {isDm && dmThread && (
            <button
              type="button"
              className="ag-pill-btn"
              onClick={() => {
                const existing = engine.getPeerByPubkey(dmThread.peerPubkey)
                onInspectPeer(
                  existing ?? {
                    pubkey: dmThread.peerPubkey,
                    npub: dmThread.peerNpub,
                    nickname: dmThread.peerNickname,
                    displayHandle: dmThread.peerDisplayHandle,
                    lastSeenAt: dmThread.lastMessageAt,
                    isOnline: false,
                    isSelf: false,
                    isTeleported: false,
                    isMeshBridge: false,
                    isBlocked: engine.isPeerBlocked(dmThread.peerPubkey),
                    isTrusted: engine.isTrusted(dmThread.peerPubkey),
                    messageCount: dmThread.messages.length,
                    channels: [engine.activeGeohash],
                  }
                )
              }}
            >
              <User size={13} />
              <span className="ag-desktop-only">Inspect</span>
            </button>
          )}

          <button
            type="button"
            className={`ag-icon-btn ${searchOpen ? 'active' : ''}`}
            onClick={onToggleSearch}
            title="Search stream (Cmd+F)"
            aria-label="Search messages"
          >
            <Search size={16} />
          </button>

          <button
            type="button"
            className={`ag-icon-btn ag-hide-xs ${engine.settings.soundEnabled ? 'active' : ''}`}
            onClick={onToggleSound}
            title={engine.settings.soundEnabled ? 'Mute radio audio SFX' : 'Enable radio audio SFX'}
            aria-label="Toggle radio sound effects"
          >
            {engine.settings.soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>

          <button
            type="button"
            className={`ag-pill-btn ag-relay-pill ${inspectorOpen && inspectorTab === 'relays' ? 'active' : ''}`}
            onClick={() => onOpenInspectorTab('relays')}
            title="Live Nostr Relay Telemetry"
          >
            <span className={`ag-led ${relayStatusClass}`} />
            <span className="tabular">
              {engine.connectedRelayCount}/{engine.totalRelayCount}
            </span>
            {engine.avgLatencyMs !== null && (
              <span className="ag-desktop-only tabular" style={{ opacity: 0.72 }}>
                {Math.round(engine.avgLatencyMs)}ms
              </span>
            )}
          </button>

          <button
            type="button"
            className={`ag-icon-btn ${inspectorOpen ? 'active' : ''}`}
            onClick={onToggleInspector}
            title="Toggle Inspector Drawer (Cmd+I)"
            aria-label="Toggle right inspector"
          >
            <PanelRight size={17} />
          </button>
        </div>
      </div>

      {/* Geohash Precision Zoom Stepper Bar (Channel Mode Only) */}
      {!isDm && !isServer && (
        <div className="ag-geozoom-bar" role="navigation" aria-label="Geohash precision zoom">
          <div className="ag-geozoom-steps">
            <span className="ag-geozoom-label">
              <Compass size={11} />
              SCALE
            </span>
            {engine.cell.prefixChain.map((step) => {
              const active = step.geohash === engine.activeGeohash
              return (
                <button
                  key={step.geohash}
                  ref={active ? activeStepRef : null}
                  type="button"
                  className={`ag-geo-step ${active ? 'active' : ''}`}
                  onClick={() => onTuneChannel(step.geohash)}
                  title={`${step.label} (${step.approxSizeLabel})`}
                >
                  <span>#{step.geohash}</span>
                  <span className="ag-geo-step-tier">{step.label}</span>
                </button>
              )
            })}
            {deeperLocalStep && (
              <button
                type="button"
                className="ag-geo-step"
                onClick={() => onTuneChannel(deeperLocalStep)}
                title={`Zoom in to local cell #${deeperLocalStep}`}
                style={{ borderStyle: 'dashed', color: 'var(--accent)' }}
              >
                + #{deeperLocalStep}
              </button>
            )}
          </div>

          <div className="ag-geozoom-telemetry">
            <span className="ag-geozoom-stat" title="Approximate geohash bounding footprint">
              {engine.cell.approxSizeLabel}
            </span>
            <span className="ag-geozoom-stat ag-desktop-only" title="Geohash cell center coordinates">
              {engine.cell.center.lat.toFixed(2)}°, {engine.cell.center.lon.toFixed(2)}°
            </span>
            <button
              type="button"
              className="ag-geo-step"
              onClick={onLocateMe}
              disabled={engine.location.status === 'locating'}
              title="Lock onto your GPS location"
            >
              <Crosshair size={11} />
              <span>{engine.location.status === 'locating' ? 'Locating…' : 'GPS'}</span>
            </button>
          </div>
        </div>
      )}
    </header>
  )
}

export default ChannelHeader
