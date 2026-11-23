import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import {
  ArrowLeft,
  Ban,
  Check,
  Copy,
  Download,
  Hash,
  Link2,
  Lock,
  LogOut,
  Map as MapIcon,
  MessageCircle,
  Minus,
  Phone,
  PhoneOff,
  Pin,
  PinOff,
  Plus,
  QrCode,
  Radio,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
  User,
  Users,
  Video,
  X,
} from 'lucide-react'
import type { AgnostrEngine, PeerInfo } from '../types/protocol.ts'
import type { Nip29Member } from '../types/servers.ts'
import type { SoundCue } from '../utils/sound.ts'
import type { ServerSettingsTab } from './ServerSettingsModal.tsx'
import type { QrShareTarget } from './QrShareModal.tsx'
import { useContextMenu, type ContextMenuItem } from './ContextMenu.tsx'
import { encodeGeohash } from '../lib/geohash.ts'
import {
  buildRadioChannelShareUrl,
  formatRadioChannelLabel,
  isTopicChannel,
} from '../lib/radioChannel.ts'
import { buildDmShareUrl } from '../lib/shareLinks.ts'
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
  onCloseDmThread?: (pubkey: string) => void
  onPlaySound?: (cue: SoundCue) => void
  onShowQr?: (target: QrShareTarget) => void
  onOpenScanner?: () => void
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
  onCloseDmThread,
  onPlaySound,
  onShowQr,
  swipeProgress,
  isSwiping = false,
  inShell = false,
}: RoomInfoSheetProps) {
  const [copiedId, setCopiedId] = useState<'npub' | 'invite' | 'dm-link' | 'room-link' | null>(null)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const { openContextMenu } = useContextMenu()

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

  const copyText = async (
    key: 'npub' | 'invite' | 'dm-link' | 'room-link',
    value: string,
    toastTitle: string,
    detail?: string,
  ) => {
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

  const openPeerContextMenu = (
    e: ReactMouseEvent,
    target: {
      pubkey: string
      npub: string
      nickname: string
      displayHandle: string
      isSelf: boolean
      peerInfo?: PeerInfo
      serverMember?: Nip29Member
    },
  ) => {
    const trusted = !target.isSelf && engine.isExplicitlyTrusted(target.pubkey)
    const blocked = !target.isSelf && engine.isPeerBlocked(target.pubkey)
    const dmUrl = buildDmShareUrl(target.pubkey, target.nickname)
    const items: ContextMenuItem[] = []

    if (!target.isSelf) {
      items.push(
        {
          id: 'dm',
          label: 'Direct Message',
          icon: <MessageCircle size={14} />,
          onSelect: () => {
            onPlaySound?.('click')
            onClose()
            onStartDm(target.pubkey, target.nickname)
          },
        },
        {
          id: 'profile',
          label: 'View Profile',
          icon: <User size={14} />,
          onSelect: () => {
            onPlaySound?.('click')
            if (target.peerInfo) {
              onInspectPeer(target.peerInfo)
            } else if (target.serverMember) {
              handleInspectServerMember(target.serverMember)
            } else {
              const known = engine.getPeerByPubkey(target.pubkey)
              if (known) {
                onInspectPeer(known)
              } else {
                onInspectPeer({
                  pubkey: target.pubkey,
                  npub: target.npub,
                  nickname: target.nickname,
                  displayHandle: target.displayHandle,
                  lastSeenAt: Math.floor(Date.now() / 1000),
                  isOnline: true,
                  isSelf: false,
                  isTeleported: false,
                  isMeshBridge: false,
                  isBlocked: blocked,
                  isTrusted: trusted,
                  messageCount: 0,
                  channels: [],
                })
              }
            }
          },
        },
      )
    }

    items.push({
      id: 'copy-dm-link',
      label: 'Copy DM Link',
      icon: <Link2 size={14} />,
      dividerBefore: items.length > 0,
      onSelect: () => {
        void copyText('dm-link', dmUrl, 'Copied DM link')
      },
    })

    if (onShowQr) {
      items.push({
        id: 'show-dm-qr',
        label: 'Show DM QR',
        icon: <QrCode size={14} />,
        onSelect: () => {
          onPlaySound?.('click')
          onShowQr({
            kind: 'dm',
            title: target.displayHandle,
            subtitle: 'Direct message link',
            url: dmUrl,
            codeLabel: 'Public key (npub)',
            codeValue: target.npub,
          })
        },
      })
    }

    items.push({
      id: 'copy-npub',
      label: 'Copy npub',
      icon: <Copy size={14} />,
      onSelect: () => {
        void copyText('npub', target.npub, 'Copied public key')
      },
    })

    if (!target.isSelf) {
      items.push(
        {
          id: 'trust',
          label: trusted ? 'Remove Trust' : 'Trust Peer',
          icon: <ShieldCheck size={14} />,
          dividerBefore: true,
          onSelect: () => {
            onPlaySound?.('click')
            if (trusted) {
              engine.untrustPubkey(target.pubkey)
            } else {
              engine.trustPubkey(target.pubkey, target.nickname)
            }
          },
        },
        {
          id: 'block',
          label: blocked ? 'Unblock Peer' : 'Block Peer',
          icon: <Ban size={14} />,
          danger: !blocked,
          onSelect: () => {
            onPlaySound?.('click')
            engine.toggleBlockPeer(target.pubkey, target.displayHandle)
          },
        },
      )
    }

    openContextMenu(e, {
      header: target.displayHandle,
      items,
    })
  }

  const renderGeoBody = () => {
    const isTopic = isTopicChannel(activeGeohash)
    const channelLabel = formatRadioChannelLabel(activeGeohash)
    const isPinned = engine.isChannelPinned(activeGeohash)
    const cityLabel = isTopic ? null : cell.nearestCity || cell.label
    const subtitle = isTopic
      ? 'Topic Radio · kind 23333 · Ephemeral'
      : presence.isUncertainCount
        ? 'Ephemeral · High-precision room'
        : `Ephemeral · ${presence.onlineCount} online`

    const normalizedGh = activeGeohash.trim().toLowerCase()
    const geoCallRoster = calls.getGeoCallPresence(normalizedGh)
    const geoCallCount = calls.getGeoCallCount(normalizedGh)
    const isInThisGeoCall =
      calls.activeCall?.mode === 'geo' && calls.activeCall.geohash === normalizedGh
    const isGeoCallFull = !isInThisGeoCall && geoCallCount >= calls.maxParticipants

    const handleJoinGeoCall = async (media: 'audio' | 'video') => {
      onPlaySound?.('click')
      const ok = await calls.joinGeoCall(normalizedGh, media)
      if (ok) {
        onClose()
      }
    }

    return (
      <>
        {/* Hero */}
        <div className="ag-sheet-hero">
          <div className="ag-sheet-emblem accent">
            {isTopic ? <Hash size={26} /> : <Radio size={26} />}
          </div>
          <h2 className="ag-sheet-hero-title">
            <span className="mono">{channelLabel}</span>
            {cityLabel && <span className="ag-sheet-hero-city"> · {cityLabel}</span>}
          </h2>
          <p className="ag-sheet-hero-sub">{subtitle}</p>
        </div>

        {/* Primary Actions */}
        <div className="ag-sheet-action-grid">
          {isTopic ? (
            <button
              type="button"
              className="ag-sheet-action-btn primary"
              onClick={() =>
                void copyText(
                  'room-link',
                  buildRadioChannelShareUrl(activeGeohash),
                  `Copied ${channelLabel} link`,
                )
              }
            >
              {copiedId === 'room-link' ? <Check size={17} /> : <Link2 size={17} />}
              <span>{copiedId === 'room-link' ? 'Copied Link' : 'Copy Room Link'}</span>
            </button>
          ) : (
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
          )}
          <button
            type="button"
            className={`ag-sheet-action-btn ${isPinned ? 'active' : ''}`}
            onClick={() => {
              onPlaySound?.('click')
              engine.togglePinChannel(activeGeohash, isTopic ? undefined : cell.nearestCity || undefined)
            }}
          >
            {isPinned ? <PinOff size={17} /> : <Pin size={17} />}
            <span>{isPinned ? 'Unpin' : 'Pin Room'}</span>
          </button>
        </div>

        {/* Radio Group Call */}
        <section className="ag-sheet-section">
          <div className="ag-sheet-section-head">
            <span className="ag-sheet-section-title">
              {isTopic ? <Hash size={13} /> : <Radio size={13} />}
              <span>{isTopic ? 'Topic Radio Group Call' : 'Radio Group Call'}</span>
            </span>
            <span className="ag-sheet-section-meta mono">
              {geoCallCount > 0
                ? `${geoCallCount}/${calls.maxParticipants} live`
                : `Up to ${calls.maxParticipants} · P2P`}
            </span>
          </div>

          <div className={`ag-sheet-call-card ${isInThisGeoCall ? 'in-call' : ''}`}>
            {geoCallRoster.length > 0 && (
              <div className="ag-sheet-call-roster" role="list" aria-label="Peers in radio call">
                {geoCallRoster.map((p) => (
                  <span key={p.pubkey} role="listitem" className="ag-sheet-call-pill">
                    <img
                      src={identiconDataUrl(p.pubkey)}
                      alt=""
                      width={18}
                      height={18}
                      className="ag-sheet-call-pill-avatar"
                    />
                    <span
                      className="ag-sheet-call-pill-name truncate"
                      style={{ color: pubkeyToColor(p.pubkey) }}
                    >
                      {p.displayHandle}
                    </span>
                    {p.hasVideo && <Video size={11} className="ag-sheet-call-pill-icon" />}
                  </span>
                ))}
              </div>
            )}

            {isInThisGeoCall ? (
              <button
                type="button"
                className="ag-sheet-util-btn danger"
                onClick={() => {
                  onPlaySound?.('call-leave')
                  calls.leaveCall()
                }}
              >
                <PhoneOff size={15} />
                <span>Leave Radio Call</span>
              </button>
            ) : isGeoCallFull ? (
              <p className="ag-sheet-call-note">
                Call is full ({calls.maxParticipants}/{calls.maxParticipants} participants).
              </p>
            ) : (
              <div className="ag-sheet-action-grid">
                <button
                  type="button"
                  className="ag-sheet-action-btn primary"
                  onClick={() => void handleJoinGeoCall('audio')}
                >
                  <Phone size={16} />
                  <span>{geoCallCount > 0 ? 'Join Voice' : 'Voice Call'}</span>
                </button>
                <button
                  type="button"
                  className="ag-sheet-action-btn"
                  onClick={() => void handleJoinGeoCall('video')}
                >
                  <Video size={16} />
                  <span>{geoCallCount > 0 ? 'Join Video' : 'Video Call'}</span>
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Precision Zoom Stepper (Geohash rooms only) */}
        {!isTopic && (
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
        )}

        {/* People List */}
        <section className="ag-sheet-section">
          <div className="ag-sheet-section-head">
            <span className="ag-sheet-section-title">People</span>
            <span className="ag-sheet-section-meta">{sortedGeoPeers.length}</span>
          </div>

          {sortedGeoPeers.length === 0 ? (
            <p className="ag-sheet-empty">No one else seen in {channelLabel} yet.</p>
          ) : (
            <div className="ag-sheet-list" role="list">
              {sortedGeoPeers.map((peer) => {
                const trusted = !peer.isSelf && engine.isExplicitlyTrusted(peer.pubkey)
                return (
                  <div
                    key={peer.pubkey}
                    role="listitem"
                    className="ag-sheet-person-row"
                    onContextMenu={(e) =>
                      openPeerContextMenu(e, {
                        pubkey: peer.pubkey,
                        npub: peer.npub,
                        nickname: peer.nickname,
                        displayHandle: peer.displayHandle,
                        isSelf: peer.isSelf,
                        peerInfo: peer,
                      })
                    }
                  >
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
                        <span className="ag-sheet-person-name-row">
                          <span
                            className="ag-sheet-person-name truncate"
                            style={{ color: pubkeyToColor(peer.pubkey) }}
                          >
                            {peer.displayHandle}
                          </span>
                          {peer.isAgnostrClient && (
                            <span
                              className="ag-client-badge"
                              title="Using Agnostr"
                              aria-label="Using Agnostr"
                            >
                              <span className="ag-client-badge-mark" aria-hidden="true">
                                A
                              </span>
                              <span className="ag-client-badge-text">Agnostr</span>
                            </span>
                          )}
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
        <div
          className="ag-sheet-hero"
          onContextMenu={(e) =>
            openPeerContextMenu(e, {
              pubkey: thread.peerPubkey,
              npub: thread.peerNpub,
              nickname: thread.peerNickname,
              displayHandle: thread.peerDisplayHandle,
              isSelf: false,
            })
          }
        >
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
          <button
            type="button"
            className="ag-sheet-action-btn"
            onClick={() =>
              void copyText(
                'dm-link',
                buildDmShareUrl(thread.peerPubkey, thread.peerNickname),
                'Copied DM link',
              )
            }
          >
            {copiedId === 'dm-link' ? <Check size={16} /> : <Link2 size={16} />}
            <span>{copiedId === 'dm-link' ? 'Copied Link' : 'Copy DM Link'}</span>
          </button>
          {onShowQr && (
            <button
              type="button"
              className="ag-sheet-action-btn"
              onClick={() => {
                onPlaySound?.('click')
                onShowQr({
                  kind: 'dm',
                  title: thread.peerDisplayHandle,
                  subtitle: 'Direct message link',
                  url: buildDmShareUrl(thread.peerPubkey, thread.peerNickname),
                  codeLabel: 'Public key (npub)',
                  codeValue: thread.peerNpub,
                })
              }}
            >
              <QrCode size={16} />
              <span>Show QR</span>
            </button>
          )}
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
                if (onCloseDmThread) {
                  onCloseDmThread(thread.peerPubkey)
                } else {
                  engine.closeDmThread(thread.peerPubkey)
                }
                onClose()
              }}
            >
              <Trash2 size={15} />
              <span>Close &amp; Delete Chat</span>
            </button>
            {trusted && (
              <p className="ag-sheet-util-note">
                Deletes local DM history · Keeps peer trusted
              </p>
            )}

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

    const handleShowInviteQr = () => {
      if (!onShowQr) return
      const built = servers.buildInviteLink(activeServer.id)
      if (!built) {
        engine.pushToast('warning', 'Invite link unavailable for this server')
        return
      }
      onPlaySound?.('click')
      onShowQr({
        kind: 'server',
        title: activeServer.name,
        subtitle: activeServer.encrypted ? 'Encrypted community invite' : 'Community invite link',
        url: built.url,
        codeLabel: 'Invite code',
        codeValue: built.code,
      })
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
          {onShowQr && (
            <button
              type="button"
              className="ag-sheet-action-btn"
              onClick={handleShowInviteQr}
            >
              <QrCode size={17} />
              <span>Show Invite QR</span>
            </button>
          )}
          <button
            type="button"
            className={`ag-sheet-action-btn ${onShowQr ? 'span-full' : ''}`}
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
                  <div
                    key={m.pubkey}
                    role="listitem"
                    className="ag-sheet-person-row"
                    onContextMenu={(e) =>
                      openPeerContextMenu(e, {
                        pubkey: m.pubkey,
                        npub: m.npub,
                        nickname: m.nickname,
                        displayHandle: m.displayHandle,
                        isSelf: m.isSelf,
                        serverMember: m,
                      })
                    }
                  >
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
