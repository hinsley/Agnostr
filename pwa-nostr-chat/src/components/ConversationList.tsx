import React, { useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import {
  Ban,
  ChevronDown,
  ChevronRight,
  Compass,
  Copy,
  Crosshair,
  Download,
  Globe,
  Hash,
  Headphones,
  Link2,
  Loader2,
  Lock,
  LogOut,
  Map as MapIcon,
  MessageCircle,
  Phone,
  PhoneOff,
  Pin,
  PinOff,
  Plus,
  QrCode,
  Radio,
  ScanLine,
  Search,
  Server,
  Settings,
  ShieldCheck,
  ShieldOff,
  Star,
  StarOff,
  User,
  UserPlus,
  Users,
  Video,
  X,
} from 'lucide-react'
import type { AgnostrEngine, DmThread, PeerInfo } from '../types/protocol'
import type { ServerChannel, ServerSummary } from '../types/servers'
import type { PwaState } from '../hooks/usePwa'
import type { SoundCue } from '../utils/sound'
import type { QrShareTarget } from './QrShareModal'
import type { ServerHubTab } from './ServerHubModal'
import type { ServerSettingsTab } from './ServerSettingsModal'
import type { SettingsTab } from './SettingsModal'
import { useContextMenu, type ContextMenuItem } from './ContextMenu'
import { isValidGeohash, normalizeGeohash } from '../lib/geohash'
import { encodeNpubSafe } from '../lib/identity'
import { buildDmShareUrl, parseShareTarget, type ParsedShareTarget } from '../lib/shareLinks'
import { formatHandle, identiconDataUrl } from '../utils/identicon'

export type ListTab = 'radio' | 'dms' | 'servers'

function formatBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

function formatRelativeTime(tsMsOrSec: number): string {
  const tsMs = tsMsOrSec > 1e12 ? tsMsOrSec : tsMsOrSec * 1000
  const diffSec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000))
  if (diffSec < 60) return 'now'
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  return `${days}d`
}

function getServerMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'SV'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase()
}

export interface ConversationListProps {
  engine: AgnostrEngine
  activeTab: ListTab
  collapsed?: boolean
  onTabChange: (tab: ListTab) => void
  onTuneChannel: (geohash: string) => boolean | void
  onOpenDm: (pubkey: string, nickname?: string) => void
  onSelectServerChannel: (serverId: string, channelId: string) => void
  onOpenServerHub: (initialTab?: ServerHubTab) => void
  onOpenServerSettings: (serverId: string, initialTab?: ServerSettingsTab) => void
  onOpenCommandPalette: () => void
  onExpandRadar: () => void
  onOpenSettings: (tab?: SettingsTab) => void
  onLocateMe: () => void
  onFocusActiveCall?: () => void
  onInspectPeer?: (peer: PeerInfo) => void
  onShowQr?: (target: QrShareTarget) => void
  onOpenScanner?: () => void
  onResolvedShareTarget?: (target: ParsedShareTarget) => void
  pwa?: PwaState
  onOpenInstall?: () => void
  onPlaySound?: (cue: SoundCue) => void
}

export const ConversationList: React.FC<ConversationListProps> = ({
  engine,
  activeTab,
  collapsed = false,
  onTabChange,
  onTuneChannel,
  onOpenDm,
  onSelectServerChannel,
  onOpenServerHub,
  onOpenServerSettings,
  onOpenCommandPalette,
  onExpandRadar,
  onOpenSettings,
  onLocateMe,
  onFocusActiveCall,
  onInspectPeer,
  onShowQr,
  onOpenScanner,
  onResolvedShareTarget,
  pwa,
  onOpenInstall,
  onPlaySound,
}) => {
  const { openContextMenu } = useContextMenu()
  const [freqDraft, setFreqDraft] = useState('')
  const [dmDraft, setDmDraft] = useState('')
  const [collapsedServers, setCollapsedServers] = useState<Record<string, boolean>>({})
  const [addingChannelServerId, setAddingChannelServerId] = useState<string | null>(null)
  const [channelNameDraft, setChannelNameDraft] = useState('')
  const [creatingChannel, setCreatingChannel] = useState(false)
  const [joiningVoiceServerId, setJoiningVoiceServerId] = useState<string | null>(null)
  const [joiningNip29ServerId, setJoiningNip29ServerId] = useState<string | null>(null)

  const handleQuickTune = (e: FormEvent) => {
    e.preventDefault()
    const clean = freqDraft.trim()
    if (!clean) return
    const ok = onTuneChannel(clean)
    if (ok !== false) {
      setFreqDraft('')
    }
  }

  const handleOpenMyDmQr = () => {
    onPlaySound?.('click')
    const url = buildDmShareUrl(engine.identity.masterPubkey, engine.identity.nickname)
    onShowQr?.({
      kind: 'dm',
      title: 'My DM QR Code',
      subtitle: engine.identity.nickname || 'Scan to start an encrypted DM',
      url,
      codeLabel: 'Public Key (npub)',
      codeValue: engine.identity.masterNpub,
    })
  }

  const handleQuickStartDm = (e: FormEvent) => {
    e.preventDefault()
    const clean = dmDraft.trim()
    if (!clean) return
    const parsed = parseShareTarget(clean)
    if (!parsed) {
      engine.pushToast(
        'warning',
        'Invalid DM link or key',
        'Paste a DM link (#dm=...), npub, nprofile, hex pubkey, or community invite.'
      )
      return
    }
    setDmDraft('')
    if (onResolvedShareTarget) {
      onResolvedShareTarget(parsed)
    } else if (parsed.kind === 'dm') {
      onOpenDm(parsed.pubkey, parsed.nickname)
    }
  }

  const openRoomContextMenu = (
    e: React.MouseEvent,
    geohash: string,
    label?: string
  ) => {
    const pinned = engine.isChannelPinned(geohash)
    const callCount = engine.calls.getGeoCallCount(geohash)
    const inThisGeoCall =
      activeCall?.mode === 'geo' &&
      (activeCall.geohash ?? '').toLowerCase() === geohash.toLowerCase()
    const isFull = !inThisGeoCall && callCount >= engine.calls.maxParticipants
    const roomUrl = `${window.location.origin}${window.location.pathname}#${geohash}`
    openContextMenu(e, {
      header: `#${geohash}${label ? ` · ${label}` : ''}`,
      items: [
        {
          id: `room-tune-${geohash}`,
          label: `Tune to #${geohash}`,
          icon: <Radio size={15} />,
          onSelect: () => onTuneChannel(geohash),
        },
        {
          id: `room-call-voice-${geohash}`,
          label: inThisGeoCall
            ? 'Focus Active Call'
            : isFull
              ? `Voice Call Full (${engine.calls.maxParticipants}/${engine.calls.maxParticipants})`
              : callCount > 0
                ? `Join Voice Call (${callCount}/${engine.calls.maxParticipants})`
                : 'Join Voice Call',
          icon: <Phone size={15} />,
          disabled: isFull,
          dividerBefore: true,
          onSelect: () => {
            onTuneChannel(geohash)
            if (inThisGeoCall) {
              onFocusActiveCall?.()
              return
            }
            void engine.calls.joinGeoCall(geohash, 'audio')
          },
        },
        {
          id: `room-call-video-${geohash}`,
          label: inThisGeoCall
            ? 'Focus Active Video Call'
            : isFull
              ? `Video Call Full (${engine.calls.maxParticipants}/${engine.calls.maxParticipants})`
              : callCount > 0
                ? `Join Video Call (${callCount}/${engine.calls.maxParticipants})`
                : 'Join Video Call',
          icon: <Video size={15} />,
          disabled: isFull,
          onSelect: () => {
            onTuneChannel(geohash)
            if (inThisGeoCall) {
              onFocusActiveCall?.()
              return
            }
            void engine.calls.joinGeoCall(geohash, 'video')
          },
        },
        {
          id: `room-copy-${geohash}`,
          label: 'Copy Room Link',
          icon: <Link2 size={15} />,
          dividerBefore: true,
          onSelect: () => {
            navigator.clipboard?.writeText(roomUrl).catch(() => {})
            engine.pushToast('info', `Copied #${geohash} room link`)
          },
        },
        {
          id: `room-map-${geohash}`,
          label: 'Open on Radar Map',
          icon: <MapIcon size={15} />,
          onSelect: () => {
            onTuneChannel(geohash)
            onExpandRadar()
          },
        },
        {
          id: `room-pin-${geohash}`,
          label: pinned ? 'Remove Bookmark' : 'Bookmark Room',
          icon: pinned ? <StarOff size={15} /> : <Star size={15} />,
          dividerBefore: true,
          onSelect: () => engine.togglePinChannel(geohash, label),
        },
      ],
    })
  }

  const openPeerDmContextMenu = (
    e: React.MouseEvent,
    peer: {
      peerPubkey: string
      peerNickname: string
      peerDisplayHandle: string
      lastMessageAt?: number
      messageCount?: number
    }
  ) => {
    const trusted = engine.isExplicitlyTrusted(peer.peerPubkey)
    const blocked = engine.isPeerBlocked(peer.peerPubkey)
    const npub = encodeNpubSafe(peer.peerPubkey)
    const dmUrl = buildDmShareUrl(peer.peerPubkey, peer.peerNickname)
    const items: ContextMenuItem[] = [
      {
        id: `dm-open-${peer.peerPubkey}`,
        label: 'Open DM',
        icon: <MessageCircle size={15} />,
        onSelect: () => onOpenDm(peer.peerPubkey, peer.peerNickname),
      },
    ]

    if (trusted) {
      items.push(
        {
          id: `dm-voice-${peer.peerPubkey}`,
          label: 'Voice Call',
          icon: <Phone size={15} />,
          onSelect: () => {
            void engine.calls.startDmCall(peer.peerPubkey, 'audio', peer.peerNickname)
          },
        },
        {
          id: `dm-video-${peer.peerPubkey}`,
          label: 'Video Call',
          icon: <Video size={15} />,
          onSelect: () => {
            void engine.calls.startDmCall(peer.peerPubkey, 'video', peer.peerNickname)
          },
        }
      )
    }

    if (onInspectPeer) {
      items.push({
        id: `dm-profile-${peer.peerPubkey}`,
        label: 'View Profile',
        icon: <User size={15} />,
        dividerBefore: true,
        onSelect: () => {
          const existing = engine.getPeerByPubkey(peer.peerPubkey)
          if (existing) {
            onInspectPeer(existing)
            return
          }
          onInspectPeer({
            pubkey: peer.peerPubkey,
            npub,
            nickname: peer.peerNickname,
            displayHandle: peer.peerDisplayHandle,
            lastSeenAt: peer.lastMessageAt || Math.floor(Date.now() / 1000),
            isOnline: false,
            isSelf: false,
            isTeleported: false,
            isMeshBridge: false,
            isBlocked: blocked,
            isTrusted: engine.isTrusted(peer.peerPubkey),
            messageCount: peer.messageCount ?? 0,
            channels: [],
          })
        },
      })
    }

    items.push({
      id: `dm-copy-link-${peer.peerPubkey}`,
      label: 'Copy DM Link',
      icon: <Link2 size={15} />,
      dividerBefore: !onInspectPeer,
      onSelect: () => {
        navigator.clipboard?.writeText(dmUrl).catch(() => {})
        engine.pushToast('info', 'DM link copied')
      },
    })

    if (onShowQr) {
      items.push({
        id: `dm-qr-${peer.peerPubkey}`,
        label: 'Show DM QR',
        icon: <QrCode size={15} />,
        onSelect: () => {
          onShowQr({
            kind: 'dm',
            title: `${peer.peerNickname} — DM QR`,
            subtitle: peer.peerDisplayHandle,
            url: dmUrl,
            codeLabel: 'Public Key (npub)',
            codeValue: npub,
          })
        },
      })
    }

    items.push(
      {
        id: `dm-trust-${peer.peerPubkey}`,
        label: trusted ? 'Remove Trust' : 'Trust Peer',
        icon: trusted ? <ShieldOff size={15} /> : <ShieldCheck size={15} />,
        dividerBefore: true,
        onSelect: () => {
          if (trusted) engine.untrustPubkey(peer.peerPubkey)
          else engine.trustPubkey(peer.peerPubkey, peer.peerNickname)
        },
      },
      {
        id: `dm-npub-${peer.peerPubkey}`,
        label: 'Copy npub',
        icon: <Copy size={15} />,
        onSelect: () => {
          navigator.clipboard?.writeText(npub).catch(() => {})
          engine.pushToast('info', 'Copied npub')
        },
      },
      {
        id: `dm-block-${peer.peerPubkey}`,
        label: blocked ? 'Unblock Peer' : 'Block Peer',
        icon: <Ban size={15} />,
        danger: !blocked,
        onSelect: () => engine.toggleBlockPeer(peer.peerPubkey, peer.peerDisplayHandle),
      }
    )

    openContextMenu(e, {
      header: peer.peerDisplayHandle,
      items,
    })
  }

  const openDmContextMenu = (e: React.MouseEvent, thread: DmThread) => {
    openPeerDmContextMenu(e, {
      peerPubkey: thread.peerPubkey,
      peerNickname: thread.peerNickname,
      peerDisplayHandle: thread.peerDisplayHandle,
      lastMessageAt: thread.lastMessageAt,
      messageCount: thread.messages.length,
    })
  }

  const openServerContextMenu = (
    e: React.MouseEvent,
    server: ServerSummary,
    channel?: ServerChannel
  ) => {
    const invite = engine.servers.buildInviteLink(server.id)
    const items: ContextMenuItem[] = []

    if (channel) {
      items.push({
        id: `srv-open-ch-${server.id}-${channel.id}`,
        label: `Open #${channel.name}`,
        icon: server.encrypted ? <Lock size={15} /> : <Hash size={15} />,
        onSelect: () => {
          onPlaySound?.('click')
          onSelectServerChannel(server.id, channel.id)
        },
      })
    } else if (server.channels[0]) {
      const targetCh =
        server.channels.find((c) => c.id === server.lastActiveChannelId) ?? server.channels[0]
      items.push({
        id: `srv-open-${server.id}`,
        label: `Open #${targetCh.name}`,
        icon: server.encrypted ? <Lock size={15} /> : <Hash size={15} />,
        onSelect: () => {
          onPlaySound?.('click')
          onSelectServerChannel(server.id, targetCh.id)
        },
      })
    }

    if (invite) {
      items.push({
        id: `srv-copy-invite-${server.id}`,
        label: 'Copy Invite Link',
        icon: <Link2 size={15} />,
        dividerBefore: items.length > 0,
        onSelect: () => {
          navigator.clipboard?.writeText(invite.url).catch(() => {})
          engine.pushToast('success', 'Invite link copied', server.name)
        },
      })
      if (onShowQr) {
        items.push({
          id: `srv-qr-invite-${server.id}`,
          label: 'Show Invite QR',
          icon: <QrCode size={15} />,
          onSelect: () => {
            onShowQr({
              kind: 'server',
              title: server.name,
              subtitle: server.encrypted ? 'Encrypted Community Invite' : 'Community Invite',
              url: invite.url,
              codeLabel: 'Invite Code',
              codeValue: invite.code,
            })
          },
        })
      }
    }

    items.push(
      {
        id: `srv-settings-${server.id}`,
        label: 'Server Info & Settings',
        icon: <Settings size={15} />,
        dividerBefore: true,
        onSelect: () => {
          onPlaySound?.('click')
          onOpenServerSettings(server.id, 'overview')
        },
      },
      {
        id: `srv-leave-${server.id}`,
        label: 'Leave Community',
        icon: <LogOut size={15} />,
        danger: true,
        dividerBefore: true,
        onSelect: () => {
          void engine.servers.leaveServer(server.id)
        },
      }
    )

    openContextMenu(e, {
      header: channel ? `${server.name} · #${channel.name}` : server.name,
      items,
    })
  }

  const isChannelActive = (gh: string) =>
    engine.activeView.type === 'channel' && engine.activeView.geohash === gh

  const isDmActive = (pk: string) =>
    engine.activeView.type === 'dm' && engine.activeView.peerPubkey === pk

  const isServerChannelActive = (serverId: string, channelId: string) =>
    engine.activeView.type === 'server' &&
    engine.activeView.serverId === serverId &&
    engine.activeView.channelId === channelId

  const toggleServerExpanded = (serverId: string) => {
    setCollapsedServers((prev) => ({ ...prev, [serverId]: !prev[serverId] }))
  }

  const handleAddChannel = async (e: FormEvent, serverId: string) => {
    e.preventDefault()
    const clean = channelNameDraft.trim().replace(/^#+/, '')
    if (!clean || creatingChannel) return
    setCreatingChannel(true)
    try {
      const ok = await engine.servers.addChannel(serverId, clean)
      if (ok) {
        setChannelNameDraft('')
        setAddingChannelServerId(null)
        onPlaySound?.('tune')
      }
    } finally {
      setCreatingChannel(false)
    }
  }

  const handleJoinVoice = async (serverId: string) => {
    if (joiningVoiceServerId) return
    setJoiningVoiceServerId(serverId)
    try {
      const ok = await engine.calls.joinServerCall(serverId, 'audio')
      if (ok) {
        onPlaySound?.('call-join')
        onFocusActiveCall?.()
      }
    } finally {
      setJoiningVoiceServerId(null)
    }
  }

  const handleJoinNip29 = async (server: ServerSummary) => {
    if (!server.relayUrl || !server.groupId || joiningNip29ServerId) return
    setJoiningNip29ServerId(server.id)
    try {
      await engine.servers.joinNip29Group(server.relayUrl, server.groupId)
      onPlaySound?.('tune')
    } finally {
      setJoiningNip29ServerId(null)
    }
  }

  const liveRooms = engine.pulseRooms.slice(0, 12)
  const pinnedHashes = new Set(engine.pinnedChannels.map((p) => p.geohash))
  const liveHashes = new Set(liveRooms.map((r) => r.geohash))
  const showActiveRoomCard =
    !pinnedHashes.has(engine.activeGeohash) && !liveHashes.has(engine.activeGeohash)

  const activeCall = engine.calls.activeCall

  return (
    <aside
      className={`ag-conv-pane ${collapsed ? 'collapsed' : ''}`}
      aria-label="Conversations"
    >
      {/* Top Brand Header */}
      <div className="ag-conv-header">
        <div className="ag-conv-brand">
          <img src="./icon.svg" alt="" className="ag-conv-logo" />
          <span className="ag-conv-title">Agnostr</span>
        </div>

        <div className="ag-conv-header-actions">
          {/* Desktop quick Map & Settings buttons */}
          <button
            type="button"
            className="ag-circle-btn ag-desktop-only"
            onClick={onExpandRadar}
            title="Open Full Map"
            aria-label="Open interactive Geohash Map"
          >
            <MapIcon size={18} />
          </button>
          <button
            type="button"
            className="ag-circle-btn ag-desktop-only"
            onClick={() => onOpenSettings()}
            title="Settings (Cmd+,)"
            aria-label="Open Settings"
          >
            <Settings size={18} />
          </button>

          {/* Mobile contextual quick action */}
          {activeTab === 'servers' && (
            <button
              type="button"
              className="ag-circle-btn ag-mobile-only"
              onClick={() => onOpenServerHub('create')}
              title="New or Join Server"
              aria-label="New or Join Server"
            >
              <Plus size={19} />
            </button>
          )}
          {activeTab === 'radio' && (
            <button
              type="button"
              className={`ag-circle-btn ag-mobile-only ${engine.location.status === 'locating' ? 'locating' : ''}`}
              onClick={onLocateMe}
              disabled={engine.location.status === 'locating'}
              title="Locate my area with GPS"
              aria-label="Locate my area with GPS"
            >
              <Crosshair size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Rounded Search / Jump Trigger */}
      <div className="ag-conv-search-wrap">
        <button
          type="button"
          className="ag-conv-search-btn"
          onClick={onOpenCommandPalette}
          aria-label="Search or jump to geohash"
        >
          <Search size={15} className="ag-conv-search-icon" />
          <span className="ag-conv-search-placeholder">Search or #geohash…</span>
          <kbd className="ag-kbd ag-desktop-only">⌘K</kbd>
        </button>
      </div>

      {/* Desktop 3-Pill Segmented Tab Switcher (Mobile uses MobileTabBar at bottom) */}
      <div className="ag-conv-tabs-wrap ag-desktop-only" role="tablist" aria-label="Chat categories">
        <div className="ag-conv-tabs">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'radio'}
            className={`ag-conv-tab ${activeTab === 'radio' ? 'active' : ''}`}
            onClick={() => onTabChange('radio')}
          >
            <span>Radio</span>
            {engine.totalGeoMentions > 0 ? (
              <span
                className="ag-tab-count ping tabular"
                title={`${engine.totalGeoMentions} pings · ${engine.totalGeoUnread} unread`}
              >
                {formatBadgeCount(engine.totalGeoMentions)}
              </span>
            ) : engine.totalGeoUnread > 0 ? (
              <span
                className="ag-tab-count tabular"
                title={`${engine.totalGeoUnread} unread`}
              >
                {formatBadgeCount(engine.totalGeoUnread)}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'servers'}
            className={`ag-conv-tab ${activeTab === 'servers' ? 'active' : ''}`}
            onClick={() => onTabChange('servers')}
          >
            <span>Servers</span>
            {engine.servers.totalServerMentions > 0 ? (
              <span
                className="ag-tab-count ping tabular"
                title={`${engine.servers.totalServerMentions} pings · ${engine.servers.totalServerUnread} unread`}
              >
                {formatBadgeCount(engine.servers.totalServerMentions)}
              </span>
            ) : engine.servers.totalServerUnread > 0 ? (
              <span
                className="ag-tab-count tabular"
                title={`${engine.servers.totalServerUnread} unread`}
              >
                {formatBadgeCount(engine.servers.totalServerUnread)}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'dms'}
            className={`ag-conv-tab dm ${activeTab === 'dms' ? 'active' : ''}`}
            onClick={() => onTabChange('dms')}
          >
            <span>People</span>
            {engine.totalDmUnread > 0 && (
              <span className="ag-tab-count ping tabular">
                {formatBadgeCount(engine.totalDmUnread)}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Scrollable Tab Content */}
      <div className="ag-conv-scroll">
        {/* ================= RADIO TAB ================= */}
        {activeTab === 'radio' && (
          <div className="ag-conv-section-stack">
            {/* Compact #geohash jump + Quick Pin + GPS + Open Map */}
            <div className="ag-radio-quickbar">
              <form className="ag-jump-form" onSubmit={handleQuickTune}>
                <span className="ag-jump-hash">#</span>
                <input
                  type="text"
                  className="ag-jump-input"
                  value={freqDraft}
                  onChange={(e) => setFreqDraft(e.target.value)}
                  placeholder="Geohash or city…"
                  aria-label="Jump to geohash or city"
                />
                {freqDraft.trim() && (
                  <button type="submit" className="ag-jump-go-btn" aria-label="Go">
                    Go
                  </button>
                )}
              </form>

              {(() => {
                const normalizedDraft = normalizeGeohash(freqDraft)
                const targetGh =
                  normalizedDraft && isValidGeohash(normalizedDraft)
                    ? normalizedDraft
                    : engine.activeGeohash
                const targetPinned = engine.isChannelPinned(targetGh)
                return (
                  <button
                    type="button"
                    className={`ag-quick-tool-btn ${targetPinned ? 'active' : ''}`}
                    onClick={() => {
                      onPlaySound?.('click')
                      engine.togglePinChannel(
                        targetGh,
                        targetGh === engine.activeGeohash
                          ? engine.cell.nearestCity || undefined
                          : undefined
                      )
                      if (normalizedDraft && isValidGeohash(normalizedDraft)) {
                        setFreqDraft('')
                      }
                    }}
                    title={targetPinned ? `Unpin #${targetGh}` : `Pin #${targetGh}`}
                    aria-label={targetPinned ? `Unpin #${targetGh}` : `Pin #${targetGh}`}
                    aria-pressed={targetPinned}
                  >
                    {targetPinned ? <PinOff size={15} /> : <Pin size={15} />}
                  </button>
                )
              })()}

              <button
                type="button"
                className={`ag-quick-tool-btn ${engine.location.status === 'locating' ? 'locating' : ''}`}
                onClick={onLocateMe}
                disabled={engine.location.status === 'locating'}
                title="Locate my area with GPS"
                aria-label="Locate my area with GPS"
              >
                <Crosshair size={16} />
              </button>

              <button
                type="button"
                className="ag-quick-map-pill"
                onClick={onExpandRadar}
                title="Open Full Map"
              >
                <MapIcon size={14} />
                <span>Map</span>
              </button>
            </div>

            {/* Active Room (if not already listed in Pinned or Live) */}
            {showActiveRoomCard && (() => {
              const gh = engine.activeGeohash
              const ghKey = gh.toLowerCase()
              const active = isChannelActive(gh)
              const pinned = engine.isChannelPinned(gh)
              const unread = engine.unreadCounts[ghKey] ?? 0
              const mentions = engine.mentionCounts[ghKey] ?? 0
              const hasUnread = unread > 0 || mentions > 0
              const callCount = engine.calls.getGeoCallCount(gh)
              const inCall =
                activeCall?.mode === 'geo' &&
                (activeCall.geohash ?? '').toLowerCase() === ghKey
              return (
              <section className="ag-conv-group" aria-label="Current room">
                <div className="ag-conv-group-label">Current Room</div>
                <div
                  className={`ag-chat-row-wrap ${active ? 'active' : ''} ${hasUnread ? 'is-unread' : ''} ${mentions > 0 ? 'has-pings' : ''}`}
                  onContextMenu={(e) =>
                    openRoomContextMenu(e, gh, engine.cell.nearestCity || undefined)
                  }
                >
                  <button
                    type="button"
                    className="ag-chat-row"
                    onClick={() => onTuneChannel(gh)}
                  >
                    <div className="ag-chat-row-avatar radio">
                      <Radio size={18} />
                    </div>
                    <div className="ag-chat-row-body">
                      <div className="ag-chat-row-top">
                        <span className="ag-chat-row-name truncate">
                          <span className="mono">#{gh}</span>
                          {engine.cell.nearestCity && (
                            <span className="ag-chat-row-city"> · {engine.cell.nearestCity}</span>
                          )}
                        </span>
                        <span className="ag-chat-row-time">live</span>
                      </div>
                      <div className="ag-chat-row-bottom">
                        <span className="ag-chat-row-preview truncate">
                          {engine.presence.isUncertainCount
                            ? 'Ephemeral room'
                            : `${engine.presence.onlineCount} online · Ephemeral`}
                        </span>
                        <span className="ag-row-badges">
                          {callCount > 0 && (
                            <span
                              className={`ag-row-call-pill tabular ${inCall ? 'in-call' : ''}`}
                              title={`${callCount} in live call`}
                            >
                              <span className="ag-live-dot" aria-hidden="true" />
                              <span>{callCount}</span>
                            </span>
                          )}
                          {mentions > 0 ? (
                            <span
                              className="ag-ping-badge tabular"
                              title={`${mentions} ${mentions === 1 ? 'ping' : 'pings'} · ${unread} unread`}
                            >
                              {formatBadgeCount(mentions)}
                            </span>
                          ) : unread > 0 ? (
                            <span className="ag-unread-pill tabular" title={`${unread} unread`}>
                              {formatBadgeCount(unread)}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    className={`ag-row-pin-btn ${pinned ? 'pinned' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onPlaySound?.('click')
                      engine.togglePinChannel(gh, engine.cell.nearestCity || undefined)
                    }}
                    title={pinned ? `Unpin #${gh}` : `Pin #${gh}`}
                    aria-label={pinned ? `Unpin #${gh}` : `Pin #${gh}`}
                    aria-pressed={pinned}
                  >
                    {pinned ? <PinOff size={14} /> : <Pin size={14} />}
                  </button>
                </div>
              </section>
              )
            })()}

            {/* Pinned Rooms */}
            {engine.pinnedChannels.length > 0 && (
              <section className="ag-conv-group" aria-label="Pinned rooms">
                <div className="ag-conv-group-label">Pinned</div>
                {engine.pinnedChannels.map((pin) => {
                  const ghKey = pin.geohash.toLowerCase()
                  const active = isChannelActive(pin.geohash)
                  const unread = Math.max(pin.unreadCount, engine.unreadCounts[ghKey] ?? 0)
                  const mentions = Math.max(pin.mentionCount, engine.mentionCounts[ghKey] ?? 0)
                  const hasUnread = unread > 0 || mentions > 0
                  const callCount = engine.calls.getGeoCallCount(pin.geohash)
                  const inCall =
                    activeCall?.mode === 'geo' &&
                    (activeCall.geohash ?? '').toLowerCase() === ghKey
                  return (
                    <div
                      key={pin.geohash}
                      className={`ag-chat-row-wrap ${active ? 'active' : ''} ${hasUnread ? 'is-unread' : ''} ${mentions > 0 ? 'has-pings' : ''}`}
                      onContextMenu={(e) => openRoomContextMenu(e, pin.geohash, pin.label)}
                    >
                      <button
                        type="button"
                        className="ag-chat-row"
                        onClick={() => onTuneChannel(pin.geohash)}
                      >
                        <div className="ag-chat-row-avatar pinned">
                          <Star size={17} fill="currentColor" />
                        </div>
                        <div className="ag-chat-row-body">
                          <div className="ag-chat-row-top">
                            <span className="ag-chat-row-name truncate">
                              <span className="mono">#{pin.geohash}</span>
                              {pin.label && <span className="ag-chat-row-city"> · {pin.label}</span>}
                            </span>
                          </div>
                          <div className="ag-chat-row-bottom">
                            <span className="ag-chat-row-preview truncate">Pinned room · Ephemeral</span>
                            <span className="ag-row-badges">
                              {callCount > 0 && (
                                <span
                                  className={`ag-row-call-pill tabular ${inCall ? 'in-call' : ''}`}
                                  title={`${callCount} in live call`}
                                >
                                  <span className="ag-live-dot" aria-hidden="true" />
                                  <span>{callCount}</span>
                                </span>
                              )}
                              {mentions > 0 ? (
                                <span
                                  className="ag-ping-badge tabular"
                                  title={`${mentions} ${mentions === 1 ? 'ping' : 'pings'} · ${unread} unread`}
                                >
                                  {formatBadgeCount(mentions)}
                                </span>
                              ) : unread > 0 ? (
                                <span className="ag-unread-pill tabular" title={`${unread} unread`}>
                                  {formatBadgeCount(unread)}
                                </span>
                              ) : null}
                            </span>
                          </div>
                        </div>
                      </button>
                      <button
                        type="button"
                        className="ag-row-pin-btn pinned"
                        onClick={(e) => {
                          e.stopPropagation()
                          onPlaySound?.('click')
                          engine.togglePinChannel(pin.geohash, pin.label)
                        }}
                        title={`Unpin #${pin.geohash}`}
                        aria-label={`Unpin #${pin.geohash}`}
                        aria-pressed={true}
                      >
                        <PinOff size={14} />
                      </button>
                    </div>
                  )
                })}
              </section>
            )}

            {/* Live Active Rooms */}
            <section className="ag-conv-group" aria-label="Live active rooms">
              <div className="ag-conv-group-head">
                <span className="ag-conv-group-label">Live Active Rooms</span>
                {liveRooms.length > 0 && (
                  <span className="ag-live-dot-label">
                    <span className="ag-live-dot" />
                    Live
                  </span>
                )}
              </div>

              {liveRooms.length === 0 ? (
                <div className="ag-conv-empty">
                  <p>Listening for nearby active rooms…</p>
                  <button type="button" className="ag-soft-pill-btn" onClick={onExpandRadar}>
                    <Compass size={14} />
                    <span>Explore World Map</span>
                  </button>
                </div>
              ) : (
                liveRooms.map((room) => {
                  const ghKey = room.geohash.toLowerCase()
                  const active = isChannelActive(room.geohash)
                  const pinned = engine.isChannelPinned(room.geohash)
                  const unread = engine.unreadCounts[ghKey] ?? 0
                  const mentions = engine.mentionCounts[ghKey] ?? 0
                  const hasUnread = unread > 0 || mentions > 0
                  const callCount = engine.calls.getGeoCallCount(room.geohash)
                  const inCall =
                    activeCall?.mode === 'geo' &&
                    (activeCall.geohash ?? '').toLowerCase() === ghKey
                  const subtitle = room.lastPreview
                    ? room.lastPreview
                    : room.peerCount > 0
                      ? `${room.peerCount} ${room.peerCount === 1 ? 'person' : 'people'} active`
                      : `${room.messageCount} recent ${room.messageCount === 1 ? 'message' : 'messages'}`
                  return (
                    <div
                      key={room.geohash}
                      className={`ag-chat-row-wrap ${active ? 'active' : ''} ${hasUnread ? 'is-unread' : ''} ${mentions > 0 ? 'has-pings' : ''}`}
                      onContextMenu={(e) =>
                        openRoomContextMenu(e, room.geohash, room.nearestCity || undefined)
                      }
                    >
                      <button
                        type="button"
                        className="ag-chat-row"
                        onClick={() => onTuneChannel(room.geohash)}
                      >
                        <div className="ag-chat-row-avatar radio">
                          <Radio size={18} />
                        </div>
                        <div className="ag-chat-row-body">
                          <div className="ag-chat-row-top">
                            <span className="ag-chat-row-name truncate">
                              <span className="mono">#{room.geohash}</span>
                              {room.nearestCity && (
                                <span className="ag-chat-row-city"> · {room.nearestCity}</span>
                              )}
                            </span>
                            <span className="ag-chat-row-time tabular">
                              {formatRelativeTime(room.lastActivityAt)}
                            </span>
                          </div>
                          <div className="ag-chat-row-bottom">
                            <span className="ag-chat-row-preview truncate">{subtitle}</span>
                            <span className="ag-row-badges">
                              {callCount > 0 && (
                                <span
                                  className={`ag-row-call-pill tabular ${inCall ? 'in-call' : ''}`}
                                  title={`${callCount} in live call`}
                                >
                                  <span className="ag-live-dot" aria-hidden="true" />
                                  <span>{callCount}</span>
                                </span>
                              )}
                              {mentions > 0 ? (
                                <span
                                  className="ag-ping-badge tabular"
                                  title={`${mentions} ${mentions === 1 ? 'ping' : 'pings'} · ${unread} unread`}
                                >
                                  {formatBadgeCount(mentions)}
                                </span>
                              ) : unread > 0 ? (
                                <span className="ag-unread-pill tabular" title={`${unread} unread`}>
                                  {formatBadgeCount(unread)}
                                </span>
                              ) : room.peerCount > 0 ? (
                                <span className="ag-row-peer-count tabular">{room.peerCount}</span>
                              ) : null}
                            </span>
                          </div>
                        </div>
                      </button>
                      <button
                        type="button"
                        className={`ag-row-pin-btn ${pinned ? 'pinned' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          onPlaySound?.('click')
                          engine.togglePinChannel(room.geohash, room.nearestCity || undefined)
                        }}
                        title={pinned ? `Unpin #${room.geohash}` : `Pin #${room.geohash}`}
                        aria-label={pinned ? `Unpin #${room.geohash}` : `Pin #${room.geohash}`}
                        aria-pressed={pinned}
                      >
                        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
                      </button>
                    </div>
                  )
                })
              )}
            </section>
          </div>
        )}

        {/* ================= PEOPLE TAB (Messages + Trusted Friends) ================= */}
        {activeTab === 'dms' && (() => {
          const filterQuery = dmDraft.trim().toLowerCase()
          const isShareableInput =
            dmDraft.trim().length >= 8 && parseShareTarget(dmDraft.trim()) !== null
          const selfMaster = engine.identity.masterPubkey.toLowerCase()
          const selfActive = engine.identity.activePubkey.toLowerCase()

          const dmPubkeys = new Set(engine.dmThreads.map((t) => t.peerPubkey.toLowerCase()))

          const sortedThreads = [...engine.dmThreads]
            .sort((a, b) => {
              if ((b.unreadCount > 0 ? 1 : 0) !== (a.unreadCount > 0 ? 1 : 0)) {
                return (b.unreadCount > 0 ? 1 : 0) - (a.unreadCount > 0 ? 1 : 0)
              }
              return b.lastMessageAt - a.lastMessageAt
            })
            .filter((t) => {
              if (!filterQuery || isShareableInput) return true
              return (
                t.peerNickname.toLowerCase().includes(filterQuery) ||
                t.peerDisplayHandle.toLowerCase().includes(filterQuery) ||
                t.peerNpub.toLowerCase().includes(filterQuery) ||
                t.peerPubkey.toLowerCase().includes(filterQuery)
              )
            })

          const seenFriends = new Set<string>()
          const trustedFriends = engine.trustedPubkeys
            .filter((entry) => {
              const pk = entry.pubkey.toLowerCase()
              if (dmPubkeys.has(pk) || seenFriends.has(pk) || pk === selfMaster || pk === selfActive) {
                return false
              }
              seenFriends.add(pk)
              return true
            })
            .map((entry) => {
              const livePeer = engine.getPeerByPubkey(entry.pubkey)
              const srvMember = engine.servers.members.find(
                (m) => m.pubkey.toLowerCase() === entry.pubkey.toLowerCase()
              )
              const rawLabel = entry.label?.trim()
              const bestName =
                (rawLabel && !/^anon[0-9a-f]{0,4}$/i.test(rawLabel) ? rawLabel : null) ??
                livePeer?.nickname ??
                srvMember?.nickname ??
                rawLabel ??
                'anon'
              const handle = formatHandle(bestName, entry.pubkey)
              return {
                entry,
                nickname: handle.base,
                displayHandle: handle.full,
              }
            })
            .filter((friend) => {
              if (!filterQuery || isShareableInput) return true
              return (
                friend.nickname.toLowerCase().includes(filterQuery) ||
                friend.displayHandle.toLowerCase().includes(filterQuery) ||
                friend.entry.npub.toLowerCase().includes(filterQuery) ||
                friend.entry.pubkey.toLowerCase().includes(filterQuery)
              )
            })
            .sort((a, b) => b.entry.addedAt - a.entry.addedAt)

          const hasAnyPeople = engine.dmThreads.length > 0 || engine.trustedPubkeys.length > 0
          const hasVisiblePeople = sortedThreads.length > 0 || trustedFriends.length > 0

          return (
          <div className="ag-conv-section-stack">
            {(onShowQr || onOpenScanner) && (
              <div className="ag-dm-actions-row">
                {onShowQr && (
                  <button
                    type="button"
                    className="ag-dm-action-btn dm"
                    onClick={handleOpenMyDmQr}
                    title="Show your shareable DM link & QR code"
                  >
                    <QrCode size={15} />
                    <span>My QR</span>
                  </button>
                )}
                {onOpenScanner && (
                  <button
                    type="button"
                    className="ag-dm-action-btn"
                    onClick={() => {
                      onPlaySound?.('click')
                      onOpenScanner()
                    }}
                    title="Scan a DM or community invite QR code"
                  >
                    <ScanLine size={15} />
                    <span>Scan QR</span>
                  </button>
                )}
              </div>
            )}

            <form className="ag-dm-jump-form" onSubmit={handleQuickStartDm}>
              <input
                type="text"
                className="ag-jump-input"
                value={dmDraft}
                onChange={(e) => setDmDraft(e.target.value)}
                placeholder="Search people, paste DM link or npub…"
                aria-label="Search people or paste a DM link or npub"
              />
              {dmDraft.trim() && (
                <button type="submit" className="ag-jump-go-btn dm" aria-label="Open DM">
                  Open
                </button>
              )}
            </form>

            {!hasVisiblePeople ? (
              <div className="ag-conv-empty-large">
                <div className="ag-conv-empty-icon dm">
                  <Users size={24} />
                </div>
                <h3>{hasAnyPeople ? 'No matching people' : 'No friends or messages yet'}</h3>
                <p>
                  {hasAnyPeople
                    ? 'Try another name, or paste a DM link / npub and press Open.'
                    : 'Trust someone in a room or server to add them as a friend, or share your DM link & QR code.'}
                </p>
              </div>
            ) : (
              <>
                {sortedThreads.length > 0 && (
                  <section className="ag-conv-group" aria-label="Messages">
                    <div className="ag-conv-group-label">Messages</div>
                    {sortedThreads.map((thread) => {
                      const active = isDmActive(thread.peerPubkey)
                      const trusted = engine.isExplicitlyTrusted(thread.peerPubkey)
                      const hasUnread = thread.unreadCount > 0
                      return (
                        <div
                          key={thread.peerPubkey}
                          className={`ag-chat-row-wrap dm ${active ? 'active' : ''} ${hasUnread ? 'is-unread has-pings' : ''}`}
                          onContextMenu={(e) => openDmContextMenu(e, thread)}
                        >
                          <button
                            type="button"
                            className="ag-chat-row dm"
                            onClick={() => onOpenDm(thread.peerPubkey, thread.peerNickname)}
                          >
                            <div className="ag-chat-row-avatar-img-wrap">
                              <img
                                src={identiconDataUrl(thread.peerPubkey)}
                                alt=""
                                className="ag-chat-row-avatar-img"
                              />
                              {trusted && (
                                <span className="ag-avatar-trust-badge" title="Trusted friend">
                                  <ShieldCheck size={11} />
                                </span>
                              )}
                            </div>
                            <div className="ag-chat-row-body">
                              <div className="ag-chat-row-top">
                                <span className="ag-chat-row-name truncate">
                                  {thread.peerDisplayHandle}
                                </span>
                                {thread.lastMessageAt > 0 && (
                                  <span className="ag-chat-row-time tabular">
                                    {formatRelativeTime(thread.lastMessageAt)}
                                  </span>
                                )}
                              </div>
                              <div className="ag-chat-row-bottom">
                                <span className="ag-chat-row-preview truncate">
                                  {thread.lastPreview || 'Encrypted conversation'}
                                </span>
                                {thread.unreadCount > 0 && (
                                  <span
                                    className="ag-ping-badge tabular"
                                    title={`${thread.unreadCount} unread`}
                                  >
                                    {formatBadgeCount(thread.unreadCount)}
                                  </span>
                                )}
                              </div>
                            </div>
                          </button>

                          {trusted ? (
                            <div className="ag-person-row-actions ag-desktop-only">
                              <button
                                type="button"
                                className="ag-mini-circle-btn"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void engine.calls.startDmCall(
                                    thread.peerPubkey,
                                    'audio',
                                    thread.peerNickname
                                  )
                                }}
                                title={`Voice call ${thread.peerNickname}`}
                                aria-label={`Voice call ${thread.peerNickname}`}
                              >
                                <Phone size={13} />
                              </button>
                              <button
                                type="button"
                                className="ag-mini-circle-btn"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void engine.calls.startDmCall(
                                    thread.peerPubkey,
                                    'video',
                                    thread.peerNickname
                                  )
                                }}
                                title={`Video call ${thread.peerNickname}`}
                                aria-label={`Video call ${thread.peerNickname}`}
                              >
                                <Video size={13} />
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="ag-person-trust-pill"
                              onClick={(e) => {
                                e.stopPropagation()
                                onPlaySound?.('click')
                                engine.trustPubkey(thread.peerPubkey, thread.peerNickname)
                              }}
                              title={`Trust ${thread.peerDisplayHandle} as a friend`}
                            >
                              <ShieldCheck size={11} />
                              <span>Trust</span>
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </section>
                )}

                {trustedFriends.length > 0 && (
                  <section className="ag-conv-group" aria-label="Trusted friends">
                    <div className="ag-conv-group-label">Trusted Friends</div>
                    {trustedFriends.map(({ entry, nickname, displayHandle }) => {
                      const active = isDmActive(entry.pubkey)
                      return (
                        <div
                          key={entry.pubkey}
                          className={`ag-chat-row-wrap dm ${active ? 'active' : ''}`}
                          onContextMenu={(e) =>
                            openPeerDmContextMenu(e, {
                              peerPubkey: entry.pubkey,
                              peerNickname: nickname,
                              peerDisplayHandle: displayHandle,
                            })
                          }
                        >
                          <button
                            type="button"
                            className="ag-chat-row dm"
                            onClick={() => onOpenDm(entry.pubkey, nickname)}
                          >
                            <div className="ag-chat-row-avatar-img-wrap">
                              <img
                                src={identiconDataUrl(entry.pubkey)}
                                alt=""
                                className="ag-chat-row-avatar-img"
                              />
                              <span className="ag-avatar-trust-badge" title="Trusted friend">
                                <ShieldCheck size={11} />
                              </span>
                            </div>
                            <div className="ag-chat-row-body">
                              <div className="ag-chat-row-top">
                                <span className="ag-chat-row-name truncate">{displayHandle}</span>
                              </div>
                              <div className="ag-chat-row-bottom">
                                <span className="ag-chat-row-preview truncate">
                                  Trusted · Tap to message
                                </span>
                              </div>
                            </div>
                          </button>

                          <div className="ag-person-row-actions ag-desktop-only">
                            <button
                              type="button"
                              className="ag-mini-circle-btn"
                              onClick={(e) => {
                                e.stopPropagation()
                                void engine.calls.startDmCall(entry.pubkey, 'audio', nickname)
                              }}
                              title={`Voice call ${nickname}`}
                              aria-label={`Voice call ${nickname}`}
                            >
                              <Phone size={13} />
                            </button>
                            <button
                              type="button"
                              className="ag-mini-circle-btn"
                              onClick={(e) => {
                                e.stopPropagation()
                                void engine.calls.startDmCall(entry.pubkey, 'video', nickname)
                              }}
                              title={`Video call ${nickname}`}
                              aria-label={`Video call ${nickname}`}
                            >
                              <Video size={13} />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </section>
                )}
              </>
            )}
          </div>
          )
        })()}

        {/* ================= SERVERS TAB ================= */}
        {activeTab === 'servers' && (
          <div className="ag-conv-section-stack">
            <div className="ag-srv-top-cta-wrap">
              <button
                type="button"
                className="ag-srv-new-btn"
                onClick={() => {
                  onPlaySound?.('click')
                  onOpenServerHub('create')
                }}
              >
                <Plus size={16} />
                <span>New or Join Server</span>
              </button>
              {onOpenScanner && (
                <button
                  type="button"
                  className="ag-srv-scan-btn"
                  onClick={() => {
                    onPlaySound?.('click')
                    onOpenScanner()
                  }}
                  title="Scan a community invite QR code"
                  aria-label="Scan QR code"
                >
                  <ScanLine size={15} />
                  <span>Scan QR</span>
                </button>
              )}
            </div>

            {engine.servers.joinedServers.length === 0 ? (
              <div className="ag-conv-empty-large">
                <div className="ag-conv-empty-icon">
                  <Users size={24} />
                </div>
                <h3>No servers yet</h3>
                <p>
                  Create a private encrypted space with channels and voice calls, or explore public
                  communities.
                </p>
                <button
                  type="button"
                  className="ag-soft-pill-btn"
                  onClick={() => onOpenServerHub('explore')}
                >
                  <Compass size={14} />
                  <span>Browse Communities</span>
                </button>
              </div>
            ) : (
              <div className="ag-srv-card-list">
                {engine.servers.joinedServers.map((server) => {
                  const isActiveServer =
                    engine.activeView.type === 'server' && engine.activeView.serverId === server.id
                  const isExpanded = !collapsedServers[server.id]
                  const isInThisCall =
                    activeCall?.mode === 'server' && activeCall.serverId === server.id
                  const callRoster = engine.calls.serverCallRosters[server.id] ?? []
                  const voiceParticipants = isInThisCall
                    ? activeCall.participants.map((p) => ({
                        pubkey: p.pubkey,
                        displayHandle: p.displayHandle,
                        isRecording: p.isRecording,
                      }))
                    : callRoster.map((r) => ({
                        pubkey: r.pubkey,
                        displayHandle: r.displayHandle,
                        isRecording: Boolean(r.isRecording),
                      }))
                  const voiceCount = Math.max(
                    engine.calls.getServerCallCount(server.id),
                    voiceParticipants.length
                  )
                  const voiceMax = engine.calls.maxParticipants
                  const voiceFull = voiceCount >= voiceMax && !isInThisCall
                  const anyoneRecording = voiceParticipants.some((p) => p.isRecording)
                  const canAddChannel =
                    server.kind === 'virtual' &&
                    (server.founderPubkey?.toLowerCase() ===
                      engine.identity.masterPubkey.toLowerCase() ||
                      (isActiveServer && engine.servers.canModerate))
                  const accentStyle = {
                    '--srv-accent': server.accentColor || 'var(--accent)',
                  } as CSSProperties
                  const srvUnread = Math.max(
                    server.unreadCount,
                    engine.servers.getServerUnreadCount(server.id)
                  )
                  const srvMentions = Math.max(
                    server.mentionCount,
                    engine.servers.getServerMentionCount(server.id)
                  )
                  const srvHasUnread = srvUnread > 0 || srvMentions > 0

                  return (
                    <div
                      key={server.id}
                      className={`ag-srv-card ${isActiveServer ? 'active' : ''} ${srvHasUnread ? 'is-unread' : ''} ${srvMentions > 0 ? 'has-pings' : ''}`}
                      style={accentStyle}
                    >
                      <div
                        className="ag-srv-card-head"
                        onContextMenu={(e) => openServerContextMenu(e, server)}
                      >
                        <button
                          type="button"
                          className="ag-srv-card-toggle"
                          onClick={() => toggleServerExpanded(server.id)}
                          aria-expanded={isExpanded}
                        >
                          <div className="ag-srv-card-avatar">
                            {server.picture && /^https?:\/\//i.test(server.picture) ? (
                              <img
                                src={server.picture}
                                alt=""
                                loading="lazy"
                                referrerPolicy="no-referrer"
                              />
                            ) : server.icon?.trim() ? (
                              <span>{server.icon}</span>
                            ) : (
                              <span className="mono">{getServerMonogram(server.name)}</span>
                            )}
                          </div>
                          <div className="ag-srv-card-info">
                            <div className="ag-srv-card-title-row">
                              <span className="ag-srv-card-name truncate">{server.name}</span>
                              {server.kind === 'nip29' ? (
                                <Server
                                  size={12}
                                  className="ag-srv-type-icon mesh"
                                  aria-label="NIP-29 Community"
                                />
                              ) : server.encrypted ? (
                                <Lock
                                  size={12}
                                  className="ag-srv-type-icon dm"
                                  aria-label="End-to-end encrypted"
                                />
                              ) : (
                                <Globe
                                  size={12}
                                  className="ag-srv-type-icon"
                                  aria-label="Public server"
                                />
                              )}
                            </div>
                            <span className="ag-srv-card-sub">
                              {server.channels.length}{' '}
                              {server.channels.length === 1 ? 'channel' : 'channels'}
                              {voiceCount > 0 ? ` · ${voiceCount} in voice` : ''}
                            </span>
                          </div>
                          {srvMentions > 0 ? (
                            <span
                              className="ag-ping-badge tabular"
                              title={`${srvMentions} ${srvMentions === 1 ? 'ping' : 'pings'} · ${srvUnread} unread`}
                            >
                              {formatBadgeCount(srvMentions)}
                            </span>
                          ) : !isExpanded && srvUnread > 0 ? (
                            <span
                              className="ag-unread-pill tabular"
                              title={`${srvUnread} unread`}
                            >
                              {formatBadgeCount(srvUnread)}
                            </span>
                          ) : null}
                          <span className="ag-srv-chevron" aria-hidden="true">
                            {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </span>
                        </button>

                        <div className="ag-srv-card-quick">
                          <button
                            type="button"
                            className="ag-mini-circle-btn"
                            onClick={() => {
                              onPlaySound?.('click')
                              onOpenServerSettings(server.id, 'overview')
                            }}
                            title={`Invite people to ${server.name}`}
                            aria-label={`Invite people to ${server.name}`}
                          >
                            <UserPlus size={14} />
                          </button>
                          <button
                            type="button"
                            className="ag-mini-circle-btn"
                            onClick={() => {
                              onPlaySound?.('click')
                              onOpenServerSettings(server.id, 'overview')
                            }}
                            title={`${server.name} settings`}
                            aria-label={`${server.name} settings`}
                          >
                            <Settings size={14} />
                          </button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="ag-srv-card-body">
                          {server.kind === 'nip29' && server.isJoinedMember === false && (
                            <button
                              type="button"
                              className="ag-srv-join-community-btn"
                              onClick={() => void handleJoinNip29(server)}
                              disabled={joiningNip29ServerId === server.id}
                            >
                              {joiningNip29ServerId === server.id ? (
                                <Loader2 size={13} className="ag-spin" />
                              ) : (
                                <UserPlus size={13} />
                              )}
                              <span>
                                {joiningNip29ServerId === server.id
                                  ? 'Joining…'
                                  : 'Join Community'}
                              </span>
                            </button>
                          )}

                          {/* Channels */}
                          <div className="ag-srv-channels">
                            {server.channels.map((ch) => {
                              const active = isServerChannelActive(server.id, ch.id)
                              const chUnread = ch.unreadCount ?? 0
                              const chMentions = ch.mentionCount ?? 0
                              const chHasUnread = chUnread > 0 || chMentions > 0
                              return (
                                <button
                                  key={ch.id}
                                  type="button"
                                  className={`ag-srv-ch-row ${server.encrypted ? 'dm' : ''} ${active ? 'active' : ''} ${chHasUnread ? 'is-unread' : ''} ${chMentions > 0 ? 'has-pings' : ''}`}
                                  onClick={() => {
                                    onPlaySound?.('click')
                                    onSelectServerChannel(server.id, ch.id)
                                  }}
                                  onContextMenu={(e) => openServerContextMenu(e, server, ch)}
                                >
                                  <span className="ag-srv-ch-left truncate">
                                    {server.encrypted ? (
                                      <Lock size={13} className="ag-srv-ch-icon dm" />
                                    ) : (
                                      <Hash size={14} className="ag-srv-ch-icon" />
                                    )}
                                    <span className="truncate">{ch.name}</span>
                                  </span>
                                  {chMentions > 0 ? (
                                    <span
                                      className="ag-ping-badge tabular"
                                      title={`${chMentions} ${chMentions === 1 ? 'ping' : 'pings'} · ${chUnread} unread`}
                                    >
                                      {formatBadgeCount(chMentions)}
                                    </span>
                                  ) : chUnread > 0 ? (
                                    <span
                                      className="ag-unread-pill tabular"
                                      title={`${chUnread} unread`}
                                    >
                                      {formatBadgeCount(chUnread)}
                                    </span>
                                  ) : null}
                                </button>
                              )
                            })}

                            {canAddChannel &&
                              (addingChannelServerId === server.id ? (
                                <form
                                  className="ag-srv-inline-add-form"
                                  onSubmit={(e) => void handleAddChannel(e, server.id)}
                                >
                                  <input
                                    type="text"
                                    className="ag-srv-inline-input"
                                    placeholder="channel-name"
                                    maxLength={28}
                                    value={channelNameDraft}
                                    onChange={(e) => setChannelNameDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Escape') {
                                        setAddingChannelServerId(null)
                                        setChannelNameDraft('')
                                      }
                                    }}
                                    autoFocus
                                    disabled={creatingChannel}
                                    aria-label="New channel name"
                                  />
                                  <button
                                    type="submit"
                                    className="ag-srv-inline-ok"
                                    disabled={!channelNameDraft.trim() || creatingChannel}
                                  >
                                    {creatingChannel ? (
                                      <Loader2 size={12} className="ag-spin" />
                                    ) : (
                                      'Add'
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    className="ag-srv-inline-cancel"
                                    onClick={() => {
                                      setAddingChannelServerId(null)
                                      setChannelNameDraft('')
                                    }}
                                    aria-label="Cancel"
                                  >
                                    <X size={13} />
                                  </button>
                                </form>
                              ) : (
                                <button
                                  type="button"
                                  className="ag-srv-add-ch-btn"
                                  onClick={() => {
                                    setAddingChannelServerId(server.id)
                                    setChannelNameDraft('')
                                  }}
                                >
                                  <Plus size={13} />
                                  <span>Add channel</span>
                                </button>
                              ))}
                          </div>

                          {/* Inline Voice Lounge */}
                          <div className={`ag-srv-voice-row ${isInThisCall ? 'in-call' : ''}`}>
                            <div className="ag-srv-voice-left">
                              <Headphones size={14} className="ag-srv-voice-icon" />
                              <span className="ag-srv-voice-label">Voice Lounge</span>
                              <span className="ag-srv-voice-count tabular">
                                {voiceCount}/{voiceMax}
                              </span>
                              {anyoneRecording && (
                                <span
                                  className="ag-voice-rec-dot"
                                  title="Recording in progress"
                                  aria-label="Recording in progress"
                                />
                              )}
                            </div>

                            <div className="ag-srv-voice-right">
                              {voiceParticipants.length > 0 && (
                                <div className="ag-srv-voice-avatars" aria-hidden="true">
                                  {voiceParticipants.slice(0, 3).map((p) => (
                                    <img
                                      key={p.pubkey}
                                      src={identiconDataUrl(p.pubkey)}
                                      alt=""
                                      className="ag-srv-voice-mini-avatar"
                                    />
                                  ))}
                                </div>
                              )}

                              {isInThisCall ? (
                                <button
                                  type="button"
                                  className="ag-srv-voice-pill leave"
                                  onClick={() => {
                                    onPlaySound?.('call-leave')
                                    engine.calls.leaveCall()
                                  }}
                                  title="Leave Voice Lounge"
                                >
                                  <PhoneOff size={12} />
                                  <span>Leave</span>
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="ag-srv-voice-pill join"
                                  disabled={voiceFull || joiningVoiceServerId === server.id}
                                  onClick={() => void handleJoinVoice(server.id)}
                                  title={
                                    voiceFull
                                      ? `Voice Lounge full (${voiceCount}/${voiceMax})`
                                      : 'Join Voice Lounge'
                                  }
                                >
                                  {joiningVoiceServerId === server.id ? (
                                    <Loader2 size={12} className="ag-spin" />
                                  ) : (
                                    <Phone size={12} />
                                  )}
                                  <span>{voiceFull ? 'Full' : 'Join'}</span>
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Desktop Bottom Profile Bar (hidden on mobile where MobileTabBar lives) */}
      <div className="ag-conv-footer ag-desktop-only">
        <button
          type="button"
          className="ag-profile-bar-btn"
          onClick={() => onOpenSettings('profile')}
          title="Open Profile & Settings"
        >
          <img
            src={identiconDataUrl(engine.identity.activePubkey)}
            alt=""
            className="ag-profile-avatar"
          />
          <div className="ag-profile-meta">
            <span className="ag-profile-name truncate">{engine.identity.nickname}</span>
            <span className="ag-profile-sub truncate">
              {engine.connectedRelayCount > 0
                ? `${engine.connectedRelayCount} relays connected`
                : 'Reconnecting…'}
            </span>
          </div>
        </button>

        {pwa && !pwa.isInstalled && onOpenInstall && (
          <button
            type="button"
            className="ag-install-pill-btn"
            onClick={onOpenInstall}
            title="Install Agnostr App"
          >
            <Download size={13} />
            <span>Install</span>
          </button>
        )}
      </div>
    </aside>
  )
}

export default ConversationList
