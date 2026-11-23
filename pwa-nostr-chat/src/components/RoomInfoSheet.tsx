import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  ArrowLeft,
  Ban,
  Check,
  Copy,
  Download,
  Lock,
  LogOut,
  Map as MapIcon,
  MessageCircle,
  Minus,
  Phone,
  Pin,
  PinOff,
  Plus,
  Radio,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
  Users,
  Video,
  X,
} from 'lucide-react'
import type { AgnostrEngine, PeerInfo } from '../types/protocol.ts'
import type { Nip29Member } from '../types/servers.ts'
import type { SoundCue } from '../utils/sound.ts'
import type { ServerSettingsTab } from './ServerSettingsModal.tsx'
import { encodeGeohash } from '../lib/geohash.ts'
import { identiconDataUrl, pubkeyToColor, shortPubkey } from '../utils/identicon.ts'

export interface RoomInfoSheetProps {
  open: boolean
  engine: AgnostrEngine
  onClose: () => void
  onInspectPeer: (peer: PeerInfo) => void
  onStartDm: (pubkey: string, nickname?: string) => void
  onTuneChannel: (geohash: string) => void
  onExpandRadar: () => void
  onOpenServerSettings: (serverId: string, tab?: ServerSettingsTab) => void
  onExportTranscript: (format: 'md' | 'json') => void
  onLeftServer: () => void
  onPlaySound?: (cue: SoundCue) => void
  /** 0..1 open progress when swiping on mobile (defaults to open ? 1 : 0). */
  swipeProgress?: number
  /** True while finger is actively dragging so CSS disables transition for 1:1 60fps tracking. */
  isSwiping?: boolean
  /** When true on mobile, renders anchored inside .ag-shell-body above the always-present bottom navbar. */
  inShell?: boolean
}

function getMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'SV'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase()
}

export function RoomInfoSheet({
  open,
  engine,
  onClose,
  onInspectPeer,
  onStartDm,
  onTuneChannel,
  onExpandRadar,
  onOpenServerSettings,
  onExportTranscript,
  onLeftServer,
  onPlaySound,
  swipeProgress,
  isSwiping = false,
  inShell = false,
}: RoomInfoSheetProps) {
  const [copiedId, setCopiedId] = useState<'npub' | 'invite' | null>(null)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  const sortedGeoPeers = useMemo(() => {
    return [...engine.peers].sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1
      return b.lastSeenAt - a.lastSeenAt
    })
  }, [engine.peers])

  const isVisible =
    open || (swipeProgress !== undefined && swipeProgress > 0) || Boolean(isSwiping)

  if (!isVisible) return null

  const effectiveProgress = Math.max(
    0,
    Math.min(1, swipeProgress !== undefined ? swipeProgress : open ? 1 : 0),
  )

  const { activeView, activeGeohash, cell, presence, location, servers, calls } = engine

  const copyText = async (key: 'npub' | 'invite', value: string, toastTitle: string, detail?: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedId(key)
      onPlaySound?.('click')
      engine.pushToast('success', toastTitle, detail)
      window.setTimeout(() => setCopiedId((prev) => (prev === key ? null : prev)), 1800)
    } catch {
      engine.pushToast('error', 'Unable to copy to clipboard')
    }
  }

  const sheetTitle =
    activeView.type === 'dm'
      ? 'Contact Info'
      : activeView.type === 'server'
        ? 'Server Info'
        : 'Room Info'

  const handleZoomOut = () => {
    if (cell.precision <= 1) return
    onPlaySound?.('tune')
    onTuneChannel(cell.geohash.slice(0, -1))
  }

  const handleZoomIn = () => {
    if (cell.precision >= 8) return
    const nextPrecision = cell.precision + 1
    const localNext = location.localGeohashes[nextPrecision]
    onPlaySound?.('tune')
    if (localNext && localNext.startsWith(cell.geohash)) {
      onTuneChannel(localNext)
      return
    }
    onTuneChannel(encodeGeohash(cell.center.lat, cell.center.lon, nextPrecision))
  }

  const handleClearTimeline = () => {
    if (!confirmClear) {
      setConfirmClear(true)
      window.setTimeout(() => setConfirmClear(false), 3200)
      return
    }
    setConfirmClear(false)
    onPlaySound?.('click')
    engine.clearCurrentTimeline()
    engine.pushToast('info', `Cleared local cache for #${activeGeohash}`)
  }

  const handleInspectServerMember = (m: Nip29Member) => {
    const existing = engine.getPeerByPubkey(m.pubkey)
    if (existing) {
      onInspectPeer(existing)
      return
    }
    onInspectPeer({
      pubkey: m.pubkey,
      npub: m.npub,
      nickname: m.nickname,
      displayHandle: m.displayHandle,
      lastSeenAt: Math.floor(Date.now() / 1000),
      isOnline: true,
      isSelf: m.isSelf,
      isTeleported: false,
      isMeshBridge: false,
      isBlocked: engine.isPeerBlocked(m.pubkey),
      isTrusted: m.isTrusted,
      messageCount: 0,
      channels: [],
    })
  }

  const renderGeoBody = () => {
    const isPinned = engine.isChannelPinned(activeGeohash)
    const cityLabel = cell.nearestCity || cell.label
    const subtitle = presence.isUncertainCount
      ? 'Ephemeral · High-precision room'
      : `Ephemeral · ${presence.onlineCount} online`

    return (
      <>
        {/* Hero */}
        <div className="ag-sheet-hero">
          <div className="ag-sheet-emblem accent">
            <Radio size={26} />
          </div>
          <h2 className="ag-sheet-hero-title">
            <span className="mono">#{activeGeohash}</span>
            {cityLabel && <span className="ag-sheet-hero-city"> · {cityLabel}</span>}
          </h2>
          <p className="ag-sheet-hero-sub">{subtitle}</p>
        </div>

        {/* Primary Actions */}
        <div className="ag-sheet-action-grid">
          <button
            type="button"
            className="ag-sheet-action-btn primary"
            onClick={() => {
              onPlaySound?.('click')
              onClose()
              onExpandRadar()
            }}
          >
            <MapIcon size={17} />
            <span>Open Full Map</span>
          </button>
          <button
            type="button"
            className={`ag-sheet-action-btn ${isPinned ? 'active' : ''}`}
            onClick={() => {
              onPlaySound?.('click')
              engine.togglePinChannel(activeGeohash, cell.nearestCity || undefined)
            }}
          >
            {isPinned ? <PinOff size={17} /> : <Pin size={17} />}
            <span>{isPinned ? 'Unpin' : 'Pin Room'}</span>
          </button>
        </div>

        {/* Precision Zoom Stepper */}
        <section className="ag-sheet-section">
          <div className="ag-sheet-section-head">
            <span className="ag-sheet-section-title">Area Precision</span>
            <span className="ag-sheet-section-meta">
              {cell.label} · {cell.approxSizeLabel}
            </span>
          </div>
          <div className="ag-sheet-zoom-row">
            <button
              type="button"
              className="ag-sheet-step-btn"
              onClick={handleZoomOut}
              disabled={cell.precision <= 1}
              aria-label="Zoom out to wider area"
              title="Wider area"
            >
              <Minus size={15} />
            </button>
            <div className="ag-sheet-prefix-strip" role="list" aria-label="Geohash precision levels">
              {cell.prefixChain.map((step) => {
                const isCurrent = step.geohash === cell.geohash
                return (
                  <button
                    key={step.geohash}
                    type="button"
                    role="listitem"
                    className={`ag-sheet-prefix-pill mono ${isCurrent ? 'active' : ''}`}
                    title={`${step.label} (${step.approxSizeLabel})`}
                    onClick={() => {
                      if (isCurrent) return
                      onPlaySound?.('tune')
                      onTuneChannel(step.geohash)
                    }}
                  >
                    #{step.geohash}
                  </button>
                )
              })}
            </div>
            <button
              type="button"
              className="ag-sheet-step-btn"
              onClick={handleZoomIn}
              disabled={cell.precision >= 8}
              aria-label="Zoom in to narrower area"
              title="Closer area"
            >
              <Plus size={15} />
            </button>
          </div>
        </section>

        {/* People List */}
        <section className="ag-sheet-section">
          <div className="ag-sheet-section-head">
            <span className="ag-sheet-section-title">People</span>
            <span className="ag-sheet-section-meta">{sortedGeoPeers.length}</span>
          </div>

          {sortedGeoPeers.length === 0 ? (
            <p className="ag-sheet-empty">No one else seen in #{activeGeohash} yet.</p>
          ) : (
            <div className="ag-sheet-list" role="list">
              {sortedGeoPeers.map((peer) => {
                const trusted = !peer.isSelf && engine.isExplicitlyTrusted(peer.pubkey)
                return (
                  <div key={peer.pubkey} role="listitem" className="ag-sheet-person-row">
                    <button
                      type="button"
                      className="ag-sheet-person-main"
                      onClick={() => {
                        onPlaySound?.('click')
                        onInspectPeer(peer)
                      }}
                    >
                      <span className="ag-sheet-avatar-wrap">
                        <img
                          src={identiconDataUrl(peer.pubkey)}
                          alt=""
                          width={36}
                          height={36}
                          className="ag-sheet-avatar"
                        />
                        {peer.isOnline && <span className="ag-sheet-online-dot" />}
                      </span>
                      <span className="ag-sheet-person-text">
                        <span
                          className="ag-sheet-person-name truncate"
                          style={{ color: pubkeyToColor(peer.pubkey) }}
                        >
                          {peer.displayHandle}
                        </span>
                        <span className="ag-sheet-person-sub">
                          {peer.isSelf ? 'You' : peer.isOnline ? 'Online' : 'Recently active'}
                          {trusted && (
                            <span className="ag-sheet-trusted-inline">
                              <ShieldCheck size={12} />
                              Trusted
                            </span>
                          )}
                        </span>
                      </span>
                    </button>

                    {!peer.isSelf && (
                      <div className="ag-sheet-person-actions">
                        <button
                          type="button"
                          className={`ag-sheet-mini-btn ${trusted ? 'active' : ''}`}
                          onClick={() => {
                            onPlaySound?.('click')
                            if (trusted) {
                              engine.untrustPubkey(peer.pubkey)
                            } else {
                              engine.trustPubkey(peer.pubkey, peer.nickname)
                            }
                          }}
                          title={trusted ? `Remove trust for ${peer.displayHandle}` : `Trust ${peer.displayHandle}`}
                          aria-label={trusted ? `Untrust ${peer.displayHandle}` : `Trust ${peer.displayHandle}`}
                        >
                          <ShieldCheck size={15} />
                        </button>
                        <button
                          type="button"
                          className="ag-sheet-mini-btn"
                          onClick={() => {
                            onPlaySound?.('click')
                            onClose()
                            onStartDm(peer.pubkey, peer.nickname)
                          }}
                          title={`Message ${peer.displayHandle}`}
                          aria-label={`Message ${peer.displayHandle}`}
                        >
                          <MessageCircle size={15} />
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Utilities */}
        <section className="ag-sheet-section">
          <div className="ag-sheet-section-head">
            <span className="ag-sheet-section-title">Chat Tools</span>
          </div>
          <div className="ag-sheet-util-stack">
            <div className="ag-sheet-export-pair">
              <button
                type="button"
                className="ag-sheet-util-btn"
                onClick={() => {
                  onPlaySound?.('click')
                  onExportTranscript('md')
                }}
              >
                <Download size={15} />
                <span>Export Markdown</span>
              </button>
              <button
                type="button"
                className="ag-sheet-util-btn"
                onClick={() => {
                  onPlaySound?.('click')
                  onExportTranscript('json')
                }}
              >
                <Download size={15} />
                <span>Export JSON</span>
              </button>
            </div>
            <button
              type="button"
              className={`ag-sheet-util-btn ${confirmClear ? 'danger' : ''}`}
              onClick={handleClearTimeline}
            >
              <Trash2 size={15} />
              <span>{confirmClear ? 'Tap again to clear local cache' : 'Clear Local Cache'}</span>
            </button>
          </div>
        </section>
      </>
    )
  }

  const renderDmBody = () => {
    const thread = engine.activeDmThread
    if (!thread) {
      return <p className="ag-sheet-empty">No conversation selected.</p>
    }

    const trusted = engine.isExplicitlyTrusted(thread.peerPubkey)
    const blocked = engine.isPeerBlocked(thread.peerPubkey)

    const handleStartCall = async (media: 'audio' | 'video') => {
      onPlaySound?.('click')
      const ok = await calls.startDmCall(thread.peerPubkey, media, thread.peerNickname)
      if (ok) {
        onClose()
      }
    }

    return (
      <>
        {/* Hero */}
        <div className="ag-sheet-hero">
          <img
            src={identiconDataUrl(thread.peerPubkey)}
            alt=""
            width={72}
            height={72}
            className="ag-sheet-hero-avatar"
          />
          <h2
            className="ag-sheet-hero-title truncate"
            style={{ color: pubkeyToColor(thread.peerPubkey) }}
          >
            {thread.peerDisplayHandle}
          </h2>
          <p className="ag-sheet-hero-sub dm">
            <Lock size={12} />
            <span>End-to-end encrypted</span>
          </p>

          <button
            type="button"
            className="ag-sheet-npub-pill mono"
            onClick={() => void copyText('npub', thread.peerNpub, 'Copied public key')}
            title={thread.peerNpub}
          >
            <span>{shortPubkey(thread.peerNpub, 11, 6)}</span>
            {copiedId === 'npub' ? <Check size={13} className="ag-tone-ok" /> : <Copy size={13} />}
          </button>
        </div>

        {/* Voice & Video Call Buttons */}
        <div className="ag-sheet-action-grid">
          <button
            type="button"
            className="ag-sheet-action-btn primary"
            onClick={() => void handleStartCall('audio')}
          >
            <Phone size={17} />
            <span>Voice Call</span>
          </button>
          <button
            type="button"
            className="ag-sheet-action-btn dm"
            onClick={() => void handleStartCall('video')}
          >
            <Video size={17} />
            <span>Video Call</span>
          </button>
        </div>

        {/* Trust Toggle */}
        <section className="ag-sheet-section">
          <label className="ag-sheet-switch-card">
            <div className="ag-sheet-switch-copy">
              <span className="ag-sheet-switch-title">
                <ShieldCheck size={16} />
                <span>Trust Peer</span>
              </span>
              <span className="ag-sheet-switch-desc">
                Trusted peers can send voice memos, images, and start P2P calls with you.
              </span>
            </div>
            <input
              type="checkbox"
              className="ag-switch"
              checked={trusted}
              onChange={() => {
                onPlaySound?.('click')
                if (trusted) {
                  engine.untrustPubkey(thread.peerPubkey)
                } else {
                  engine.trustPubkey(thread.peerPubkey, thread.peerNickname)
                }
              }}
            />
          </label>
        </section>

        {/* Export & Block */}
        <section className="ag-sheet-section">
          <div className="ag-sheet-util-stack">
            <div className="ag-sheet-export-pair">
              <button
                type="button"
                className="ag-sheet-util-btn"
                onClick={() => {
                  onPlaySound?.('click')
                  onExportTranscript('md')
                }}
              >
                <Download size={15} />
                <span>Export Markdown</span>
              </button>
              <button
                type="button"
                className="ag-sheet-util-btn"
                onClick={() => {
                  onPlaySound?.('click')
                  onExportTranscript('json')
                }}
              >
                <Download size={15} />
                <span>Export JSON</span>
              </button>
            </div>

            <button
              type="button"
              className="ag-sheet-util-btn danger"
              onClick={() => {
                onPlaySound?.('click')
                engine.toggleBlockPeer(thread.peerPubkey, thread.peerDisplayHandle)
              }}
            >
              <Ban size={15} />
              <span>{blocked ? 'Unblock User' : 'Block User'}</span>
            </button>
          </div>
        </section>
      </>
    )
  }

  const renderServerBody = () => {
    const activeServer = servers.activeServer
    if (!activeServer) {
      return <p className="ag-sheet-empty">No server selected.</p>
    }

    const modeLabel =
      activeServer.kind === 'nip29'
        ? 'NIP-29 Community'
        : activeServer.encrypted
          ? 'End-to-end encrypted'
          : 'Public server'

    const handleCopyInvite = async () => {
      const built = servers.buildInviteLink(activeServer.id)
      if (!built) {
        engine.pushToast('warning', 'Invite link unavailable for this server')
        return
      }
      await copyText(
        'invite',
        built.url,
        'Copied invite link',
        activeServer.encrypted ? 'Includes server key — share only with invited peers' : undefined,
      )
    }

    const handleLeave = async () => {
      if (!confirmLeave) {
        setConfirmLeave(true)
        window.setTimeout(() => setConfirmLeave(false), 3500)
        return
      }
      setConfirmLeave(false)
      onPlaySound?.('click')
      await servers.leaveServer(activeServer.id)
      onClose()
      onLeftServer()
    }

    return (
      <>
        {/* Server Hero */}
        <div className="ag-sheet-hero">
          <div className="ag-sheet-emblem server">
            {activeServer.picture && /^https?:\/\//i.test(activeServer.picture) ? (
              <img
                src={activeServer.picture}
                alt=""
                className="ag-sheet-emblem-img"
                referrerPolicy="no-referrer"
              />
            ) : activeServer.icon ? (
              <span className="ag-sheet-emblem-emoji">{activeServer.icon}</span>
            ) : (
              <span className="mono">{getMonogram(activeServer.name)}</span>
            )}
          </div>
          <h2 className="ag-sheet-hero-title truncate">{activeServer.name}</h2>
          <p className={`ag-sheet-hero-sub ${activeServer.encrypted ? 'dm' : ''}`}>
            {activeServer.encrypted ? <Lock size={12} /> : <Server size={12} />}
            <span>{modeLabel} · Saved on relays</span>
          </p>
          {activeServer.description && (
            <p className="ag-sheet-hero-desc">{activeServer.description}</p>
          )}
        </div>

        {/* Server Primary Actions */}
        <div className="ag-sheet-action-grid">
          <button
            type="button"
            className="ag-sheet-action-btn primary"
            onClick={() => void handleCopyInvite()}
          >
            {copiedId === 'invite' ? <Check size={17} /> : <Copy size={17} />}
            <span>{copiedId === 'invite' ? 'Copied' : 'Copy Invite'}</span>
          </button>
          <button
            type="button"
            className="ag-sheet-action-btn"
            onClick={() => {
              onPlaySound?.('click')
              onClose()
              onOpenServerSettings(activeServer.id, 'overview')
            }}
          >
            <Settings size={17} />
            <span>Server Settings</span>
          </button>
        </div>

        {/* Members List */}
        <section className="ag-sheet-section">
          <div className="ag-sheet-section-head">
            <span className="ag-sheet-section-title">
              <Users size={13} />
              <span>Members</span>
            </span>
            <span className="ag-sheet-section-meta">{servers.members.length}</span>
          </div>

          {servers.members.length === 0 ? (
            <p className="ag-sheet-empty">Members appear here as they join or send messages.</p>
          ) : (
            <div className="ag-sheet-list" role="list">
              {servers.members.map((m) => {
                const trusted = !m.isSelf && engine.isExplicitlyTrusted(m.pubkey)
                const roleLabel = m.isFounder
                  ? 'Founder'
                  : m.isAdmin
                    ? 'Admin'
                    : m.roles[0] && m.roles[0] !== 'member'
                      ? m.roles[0]
                      : null

                return (
                  <div key={m.pubkey} role="listitem" className="ag-sheet-person-row">
                    <button
                      type="button"
                      className="ag-sheet-person-main"
                      onClick={() => {
                        onPlaySound?.('click')
                        handleInspectServerMember(m)
                      }}
                    >
                      <span className="ag-sheet-avatar-wrap">
                        <img
                          src={identiconDataUrl(m.pubkey)}
                          alt=""
                          width={36}
                          height={36}
                          className="ag-sheet-avatar"
                        />
                      </span>
                      <span className="ag-sheet-person-text">
                        <span
                          className="ag-sheet-person-name truncate"
                          style={{ color: pubkeyToColor(m.pubkey) }}
                        >
                          {m.displayHandle}
                        </span>
                        <span className="ag-sheet-person-sub">
                          {m.isSelf ? 'You' : roleLabel ? roleLabel : 'Member'}
                          {trusted && (
                            <span className="ag-sheet-trusted-inline">
                              <ShieldCheck size={12} />
                              Trusted
                            </span>
                          )}
                        </span>
                      </span>
                    </button>

                    {!m.isSelf && (
                      <div className="ag-sheet-person-actions">
                        <button
                          type="button"
                          className={`ag-sheet-mini-btn ${trusted ? 'active' : ''}`}
                          onClick={() => {
                            onPlaySound?.('click')
                            if (trusted) {
                              engine.untrustPubkey(m.pubkey)
                            } else {
                              engine.trustPubkey(m.pubkey, m.nickname)
                            }
                          }}
                          title={trusted ? `Untrust ${m.displayHandle}` : `Trust ${m.displayHandle}`}
                          aria-label={trusted ? `Untrust ${m.displayHandle}` : `Trust ${m.displayHandle}`}
                        >
                          <ShieldCheck size={15} />
                        </button>
                        <button
                          type="button"
                          className="ag-sheet-mini-btn"
                          onClick={() => {
                            onPlaySound?.('click')
                            onClose()
                            onStartDm(m.pubkey, m.nickname)
                          }}
                          title={`Message ${m.displayHandle}`}
                          aria-label={`Message ${m.displayHandle}`}
                        >
                          <MessageCircle size={15} />
                        </button>
                        {servers.canModerate && !m.isFounder && !m.isBanned && (
                          <button
                            type="button"
                            className="ag-sheet-mini-btn danger"
                            onClick={() => {
                              onPlaySound?.('click')
                              void servers.banMember(activeServer.id, m.pubkey)
                            }}
                            title={`Ban ${m.displayHandle}`}
                            aria-label={`Ban ${m.displayHandle}`}
                          >
                            <Ban size={15} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Leave Server */}
        <section className="ag-sheet-section">
          <button
            type="button"
            className="ag-sheet-util-btn danger"
            onClick={() => void handleLeave()}
          >
            <LogOut size={15} />
            <span>{confirmLeave ? 'Tap again to leave server' : 'Leave Server'}</span>
          </button>
        </section>
      </>
    )
  }

  const backdropStyle = {
    '--ag-right-drawer-p': String(effectiveProgress),
  } as CSSProperties

  const backdropClass = [
    'ag-sheet-backdrop',
    inShell ? 'in-shell' : '',
    isSwiping ? 'is-swiping' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const sheetClass = [
    'ag-info-sheet',
    inShell ? 'in-shell' : '',
    isSwiping ? 'is-swiping' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={backdropClass}
      style={backdropStyle}
      data-open={open ? 'true' : 'false'}
      onClick={onClose}
      role="presentation"
    >
      {inShell && (
        <div
          className="ag-sheet-scrim"
          aria-hidden="true"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
        />
      )}
      <aside
        className={sheetClass}
        role="dialog"
        aria-modal={!inShell || open}
        aria-label={sheetTitle}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ag-sheet-header">
          <button
            type="button"
            className="ag-sheet-back-btn"
            onClick={onClose}
            aria-label="Back to chat"
          >
            <ArrowLeft size={18} />
            <span>Back</span>
          </button>
          <span className="ag-sheet-title">{sheetTitle}</span>
          <button
            type="button"
            className="ag-sheet-close-btn"
            onClick={onClose}
            aria-label={`Close ${sheetTitle}`}
            title="Close (Esc)"
          >
            <X size={18} />
          </button>
        </header>

        <div className="ag-sheet-body">
          {activeView.type === 'dm'
            ? renderDmBody()
            : activeView.type === 'server'
              ? renderServerBody()
              : renderGeoBody()}
        </div>
      </aside>
    </div>
  )
}

export default RoomInfoSheet
