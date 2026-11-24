import React, { useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Ban,
  ChevronDown,
  ChevronRight,
  Compass,
  Copy,
  Crosshair,
  Download,
  Globe,
  GripVertical,
  Hash,
  Link2,
  Loader2,
  Lock,
  LogOut,
  Mail,
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
  Settings,
  ShieldCheck,
  ShieldOff,
  Star,
  StickyNote,
  User,
  UserPlus,
  Users,
  Video,
  Volume2,
  X,
  Zap,
} from 'lucide-react'
import type { AgnostrEngine, DmThread, PeerInfo, PulseRoom } from '../types/protocol'
import type { ServerChannel, ServerSummary } from '../types/servers'
import type { WalletInitialIntent, ZapTarget } from '../types/wallet'
import type { PwaState } from '../hooks/usePwa'
import { formatRadioPreviewText } from '../hooks/useGlobalPulse'
import type { SoundCue } from '../utils/sound'
import type { QrShareTarget } from './QrShareModal'
import type { ServerHubTab } from './ServerHubModal'
import type { ServerSettingsTab } from './ServerSettingsModal'
import type { SettingsTab } from './SettingsModal'
import { useContextMenu, type ContextMenuItem } from './ContextMenu'
import { encodeNpubSafe } from '../lib/identity'
import {
  buildRadioChannelShareUrl,
  formatRadioChannelLabel,
  isTopicChannel,
  parseQuickTuneInput,
} from '../lib/radioChannel'
import { buildDmShareUrl, parseShareTarget, type ParsedShareTarget } from '../lib/shareLinks'
import { formatHandle, identiconDataUrl, pubkeyToColor } from '../utils/identicon'

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

function computeReorderToIndex(
  fromIndex: number,
  targetIndex: number,
  position: 'before' | 'after',
  total: number
): number {
  const slot = position === 'after' ? targetIndex + 1 : targetIndex
  const adjusted = fromIndex < slot ? slot - 1 : slot
  return Math.max(0, Math.min(total - 1, adjusted))
}

export interface ConversationListProps {
  engine: AgnostrEngine
  activeTab: ListTab
  collapsed?: boolean
  isMobileViewport?: boolean
  selectedServerId?: string | null
  onSelectServer?: (serverId: string) => void
  onTabChange: (tab: ListTab) => void
  onTuneChannel: (geohash: string) => boolean | void
  onOpenDm: (pubkey: string, nickname?: string) => void
  onCloseDmThread?: (pubkey: string) => void
  onSelectServerChannel: (serverId: string, channelId: string) => void
  onOpenServerHub: (initialTab?: ServerHubTab) => void
  onOpenServerSettings: (serverId: string, initialTab?: ServerSettingsTab) => void
  onOpenCommandPalette: () => void
  onExpandRadar: () => void
  onOpenSettings: (tab?: SettingsTab) => void
  amailOpen?: boolean
  onOpenAmail?: (section?: 'inbox' | 'compose' | 'contacts' | 'mesh') => void
  onOpenAmailCompose?: (pubkey: string, nickname?: string) => void
  onOpenWallet?: (intent?: WalletInitialIntent) => void
  onOpenZap?: (target: ZapTarget) => void
  onLocateMe: () => void
  onFocusActiveCall?: () => void
  onInspectPeer?: (peer: PeerInfo) => void
  onEditPeerNote?: (peer: { pubkey: string; nickname: string; displayHandle: string }) => void
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
  isMobileViewport = false,
  selectedServerId = null,
  onSelectServer,
  onTuneChannel,
  onOpenDm,
  onCloseDmThread,
  onSelectServerChannel,
  onOpenServerHub,
  onOpenServerSettings,
  onOpenCommandPalette,
  onExpandRadar,
  onOpenSettings,
  onOpenAmailCompose,
  onOpenZap,
  onLocateMe,
  onFocusActiveCall,
  onInspectPeer,
  onEditPeerNote,
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
  const [localSelectedServerId, setLocalSelectedServerId] = useState<string | null>(null)
  const [textSectionOpen, setTextSectionOpen] = useState(true)
  const [voiceSectionOpen, setVoiceSectionOpen] = useState(true)
  const [addingChannelServerId, setAddingChannelServerId] = useState<string | null>(null)
  const [channelNameDraft, setChannelNameDraft] = useState('')
  const [creatingChannel, setCreatingChannel] = useState(false)
  const [joiningVoiceServerId, setJoiningVoiceServerId] = useState<string | null>(null)
  const [joiningNip29ServerId, setJoiningNip29ServerId] = useState<string | null>(null)
  const [dragPinIndex, setDragPinIndex] = useState<number | null>(null)
  const [dropPinTarget, setDropPinTarget] = useState<{
    index: number
    position: 'before' | 'after'
  } | null>(null)
  const pinnedListRef = useRef<HTMLDivElement | null>(null)
  const touchDragRef = useRef<{
    pointerId: number
    fromIndex: number
    targetIndex: number
    position: 'before' | 'after'
  } | null>(null)

  const handleQuickTune = (e: FormEvent) => {
    e.preventDefault()
    const clean = freqDraft.trim()
    if (!clean) return
    const resolved = parseQuickTuneInput(clean, 'geo')
    if (!resolved) {
      engine.pushToast(
        'warning',
        'Invalid channel name',
        'Use letters, numbers, hyphens, or underscores — or enter a #geohash / city.'
      )
      return
    }
    const ok = onTuneChannel(resolved.key)
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
    channelKey: string,
    label?: string
  ) => {
    const isTopic = isTopicChannel(channelKey)
    const displayLabel = formatRadioChannelLabel(channelKey)
    const pinned = engine.isChannelPinned(channelKey)
    const pinIndex = engine.pinnedChannels.findIndex(
      (p) => p.geohash.toLowerCase() === channelKey.toLowerCase()
    )
    const canReorderPins = pinIndex !== -1 && engine.pinnedChannels.length > 1
    const callCount = engine.calls.getGeoCallCount(channelKey)
    const inThisGeoCall =
      activeCall?.mode === 'geo' &&
      (activeCall.geohash ?? '').toLowerCase() === channelKey.toLowerCase()
    const isFull = !inThisGeoCall && callCount >= engine.calls.maxParticipants
    const roomUrl = buildRadioChannelShareUrl(channelKey)
    const items: ContextMenuItem[] = [
      {
        id: `room-pin-${channelKey}`,
        label: pinned ? 'Unpin Channel' : 'Pin Channel',
        icon: pinned ? <PinOff size={15} /> : <Pin size={15} />,
        onSelect: () => {
          onPlaySound?.('click')
          engine.togglePinChannel(channelKey, isTopic ? undefined : label)
        },
      },
    ]

    if (canReorderPins) {
      if (pinIndex > 0) {
        items.push({
          id: `room-move-up-${channelKey}`,
          label: 'Move Up',
          icon: <ArrowUp size={15} />,
          onSelect: () => {
            onPlaySound?.('click')
            engine.reorderPinnedChannels(pinIndex, pinIndex - 1)
          },
        })
      }
      if (pinIndex < engine.pinnedChannels.length - 1) {
        items.push({
          id: `room-move-down-${channelKey}`,
          label: 'Move Down',
          icon: <ArrowDown size={15} />,
          onSelect: () => {
            onPlaySound?.('click')
            engine.reorderPinnedChannels(pinIndex, pinIndex + 1)
          },
        })
      }
    }

    items.push(
      {
        id: `room-tune-${channelKey}`,
        label: `Tune to ${displayLabel}`,
        icon: isTopic ? <Hash size={15} /> : <Radio size={15} />,
        dividerBefore: true,
        onSelect: () => onTuneChannel(channelKey),
      },
      {
        id: `room-call-voice-${channelKey}`,
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
          onTuneChannel(channelKey)
          if (inThisGeoCall) {
            onFocusActiveCall?.()
            return
          }
          void engine.calls.joinGeoCall(channelKey, 'audio')
        },
      },
      {
        id: `room-call-video-${channelKey}`,
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
          onTuneChannel(channelKey)
          if (inThisGeoCall) {
            onFocusActiveCall?.()
            return
          }
          void engine.calls.joinGeoCall(channelKey, 'video')
        },
      },
      {
        id: `room-copy-${channelKey}`,
        label: 'Copy Room Link',
        icon: <Link2 size={15} />,
        dividerBefore: true,
        onSelect: () => {
          navigator.clipboard?.writeText(roomUrl).catch(() => {})
          engine.pushToast('info', `Copied ${displayLabel} room link`)
        },
      }
    )

    if (!isTopic) {
      items.push({
        id: `room-map-${channelKey}`,
        label: 'Open on Radar Map',
        icon: <MapIcon size={15} />,
        onSelect: () => {
          onTuneChannel(channelKey)
          onExpandRadar()
        },
      })
    }

    openContextMenu(e, {
      header: `${displayLabel}${isTopic ? ' · Topic' : label ? ` · ${label}` : ''}`,
      items,
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
    },
    options?: { isDmThread?: boolean }
  ) => {
    const trusted = engine.isExplicitlyTrusted(peer.peerPubkey)
    const blocked = engine.isPeerBlocked(peer.peerPubkey)
    const existingNote = engine.peerNotes[peer.peerPubkey.toLowerCase()] ?? ''
    const peerLud16 = engine.zaps.getPeerLightningAddress(peer.peerPubkey)
    const peerCanZap = engine.zaps.canZapPeer(peer.peerPubkey)
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

    if (onOpenAmailCompose) {
      items.push({
        id: `dm-amail-${peer.peerPubkey}`,
        label: 'Send Agmail',
        icon: <Mail size={15} />,
        onSelect: () => onOpenAmailCompose(peer.peerPubkey, peer.peerNickname),
      })
    }

    if (peerCanZap && onOpenZap) {
      items.push({
        id: `dm-zap-${peer.peerPubkey}`,
        label: `Zap @${peer.peerNickname}`,
        icon: <Zap size={15} />,
        onSelect: () =>
          onOpenZap({
            pubkey: peer.peerPubkey,
            nickname: peer.peerNickname,
            lud16: peerLud16,
            channelLabel: peer.peerDisplayHandle,
          }),
      })
    }

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

    if (onEditPeerNote) {
      items.push({
        id: `dm-note-${peer.peerPubkey}`,
        label: existingNote ? 'Edit Note' : 'Add Note',
        icon: <StickyNote size={15} />,
        dividerBefore: true,
        onSelect: () => {
          onPlaySound?.('click')
          onEditPeerNote({
            pubkey: peer.peerPubkey,
            nickname: peer.peerNickname,
            displayHandle: peer.peerDisplayHandle,
          })
        },
      })
    }

    if (onInspectPeer) {
      items.push({
        id: `dm-profile-${peer.peerPubkey}`,
        label: 'View Profile',
        icon: <User size={15} />,
        dividerBefore: !onEditPeerNote,
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
      }
    )

    if (options?.isDmThread && onCloseDmThread) {
      items.push({
        id: `dm-close-${peer.peerPubkey}`,
        label: 'Close Chat',
        icon: <X size={15} />,
        danger: true,
        dividerBefore: true,
        onSelect: () => {
          onPlaySound?.('click')
          onCloseDmThread(peer.peerPubkey)
        },
      })
    }

    items.push({
      id: `dm-block-${peer.peerPubkey}`,
      label: blocked ? 'Unblock Peer' : 'Block Peer',
      icon: <Ban size={15} />,
      danger: !blocked,
      dividerBefore: !(options?.isDmThread && onCloseDmThread),
      onSelect: () => engine.toggleBlockPeer(peer.peerPubkey, peer.peerDisplayHandle),
    })

    openContextMenu(e, {
      header: peer.peerDisplayHandle,
      items,
    })
  }

  const openDmContextMenu = (e: React.MouseEvent, thread: DmThread) => {
    openPeerDmContextMenu(
      e,
      {
        peerPubkey: thread.peerPubkey,
        peerNickname: thread.peerNickname,
        peerDisplayHandle: thread.peerDisplayHandle,
        lastMessageAt: thread.lastMessageAt,
        messageCount: thread.messages.length,
      },
      { isDmThread: true }
    )
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
              subtitle: server.encrypted ? 'Encrypted Group Invite' : 'Group Invite',
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
        label: 'Group Info & Settings',
        icon: <Settings size={15} />,
        dividerBefore: true,
        onSelect: () => {
          onPlaySound?.('click')
          onOpenServerSettings(server.id, 'overview')
        },
      },
      {
        id: `srv-leave-${server.id}`,
        label: 'Leave Group',
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
    engine.activeView.type === 'channel' &&
    engine.activeView.geohash.toLowerCase() === gh.toLowerCase()

  const isDmActive = (pk: string) =>
    engine.activeView.type === 'dm' &&
    engine.activeView.peerPubkey.toLowerCase() === pk.toLowerCase()

  const isServerChannelActive = (serverId: string, channelId: string) =>
    engine.activeView.type === 'server' &&
    engine.activeView.serverId === serverId &&
    engine.activeView.channelId === channelId

  const openServerHeaderMenu = (
    e: React.MouseEvent,
    server: ServerSummary,
    canAddChannel: boolean
  ) => {
    const invite = engine.servers.buildInviteLink(server.id)
    const items: ContextMenuItem[] = [
      {
        id: `srv-head-invite-${server.id}`,
        label: 'Invite People',
        icon: <UserPlus size={14} />,
        onSelect: () => {
          onPlaySound?.('click')
          if (invite && onShowQr) {
            onShowQr({
              kind: 'server',
              title: server.name,
              subtitle: server.encrypted ? 'Encrypted Group Invite' : 'Group Invite',
              url: invite.url,
              codeLabel: 'Invite Code',
              codeValue: invite.code,
            })
          } else {
            onOpenServerSettings(server.id, 'overview')
          }
        },
      },
    ]

    if (invite) {
      items.push({
        id: `srv-head-copy-${server.id}`,
        label: 'Copy Invite Link',
        icon: <Link2 size={14} />,
        onSelect: () => {
          onPlaySound?.('click')
          navigator.clipboard?.writeText(invite.url).catch(() => {})
          engine.pushToast('success', 'Invite link copied', server.name)
        },
      })
    }

    if (canAddChannel) {
      items.push({
        id: `srv-head-add-ch-${server.id}`,
        label: 'Create Channel',
        icon: <Plus size={14} />,
        dividerBefore: true,
        onSelect: () => {
          onPlaySound?.('click')
          setTextSectionOpen(true)
          setAddingChannelServerId(server.id)
          setChannelNameDraft('')
        },
      })
    }

    items.push(
      {
        id: `srv-head-settings-${server.id}`,
        label: 'Group Settings',
        icon: <Settings size={14} />,
        dividerBefore: !canAddChannel,
        onSelect: () => {
          onPlaySound?.('click')
          onOpenServerSettings(server.id, 'overview')
        },
      },
      {
        id: `srv-head-leave-${server.id}`,
        label: 'Leave Group',
        icon: <LogOut size={14} />,
        danger: true,
        dividerBefore: true,
        onSelect: () => {
          onPlaySound?.('click')
          void engine.servers.leaveServer(server.id)
        },
      }
    )

    openContextMenu(e, {
      header: server.name,
      items,
    })
  }

  const handleSelectServerEntry = (serverId: string) => {
    setLocalSelectedServerId(serverId)
    if (onSelectServer) {
      onSelectServer(serverId)
      return
    }
    const srv = engine.servers.joinedServers.find((s) => s.id === serverId)
    if (srv) {
      const targetCh =
        srv.channels.find((c) => c.id === srv.lastActiveChannelId) ?? srv.channels[0]
      if (targetCh) {
        onSelectServerChannel(srv.id, targetCh.id)
      }
    }
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

  const isPulsePreviewHidden = (senderPubkey?: string): boolean => {
    if (!senderPubkey) return false
    if (engine.isPeerBlocked(senderPubkey)) return true
    if (engine.strictWhitelistMode && !engine.isTrusted(senderPubkey)) return true
    return false
  }

  const pulseByHash = new Map(
    engine.pulseRooms.map((room) => [room.geohash.toLowerCase(), room])
  )
  const pinnedSet = new Set(engine.pinnedChannels.map((p) => p.geohash.toLowerCase()))
  const activeGhLower = engine.activeGeohash.toLowerCase()
  const liveRooms = engine.pulseRooms
    .filter((room) => !pinnedSet.has(room.geohash.toLowerCase()))
    .slice(0, 12)
  const liveSet = new Set(liveRooms.map((r) => r.geohash.toLowerCase()))
  const showActiveRoomCard = !pinnedSet.has(activeGhLower) && !liveSet.has(activeGhLower)

  let activeChannelLatest: { preview: string; createdAt: number; activityMs: number } | null = null
  for (let i = engine.messages.length - 1; i >= 0; i -= 1) {
    const m = engine.messages[i]
    if (!m || m.isSystem) continue
    if (engine.isPeerBlocked(m.pubkey)) continue
    if (!m.isOwn && isPulsePreviewHidden(m.pubkey)) continue
    const preview = formatRadioPreviewText({
      content: m.content,
      hasImage: Boolean(m.imageAttachment),
      hasVoice: Boolean(m.voiceMemo),
      mediaUrl: m.imageAttachment?.url ?? m.voiceMemo?.url,
      tags: m.tags,
    })
    if (!preview) continue
    const nowMs = Date.now()
    const nowSec = Math.floor(nowMs / 1000)
    const createdAt = Math.min(Math.floor(m.createdAt || nowSec), nowSec)
    activeChannelLatest = {
      preview,
      createdAt,
      activityMs: Math.min(createdAt * 1000, nowMs),
    }
    break
  }

  const resolveRadioPreview = (
    ghKey: string,
    livePulse?: PulseRoom
  ): { preview: string; activityMs: number | null } => {
    if (ghKey === activeGhLower && activeChannelLatest) {
      return {
        preview: activeChannelLatest.preview,
        activityMs: Math.max(activeChannelLatest.activityMs, livePulse?.lastActivityAt ?? 0),
      }
    }

    const cp = engine.channelPreviews[ghKey]
    const safeCp = cp && cp.preview && !isPulsePreviewHidden(cp.senderPubkey) ? cp : null
    const safePulsePreview =
      livePulse?.lastPreview && !isPulsePreviewHidden(livePulse.lastSenderPubkey)
        ? livePulse.lastPreview
        : ''

    if (safeCp && safePulsePreview && livePulse) {
      const cpMs = safeCp.createdAt * 1000
      const pulseMsgMs = livePulse.lastMessageAt ?? livePulse.lastActivityAt
      if (cpMs >= pulseMsgMs) {
        return {
          preview: safeCp.preview,
          activityMs: Math.max(cpMs, livePulse.lastActivityAt),
        }
      }
      return {
        preview: safePulsePreview,
        activityMs: Math.max(livePulse.lastActivityAt, cpMs),
      }
    }

    if (safeCp) {
      return {
        preview: safeCp.preview,
        activityMs: Math.max(safeCp.createdAt * 1000, livePulse?.lastActivityAt ?? 0),
      }
    }

    if (safePulsePreview && livePulse) {
      return {
        preview: safePulsePreview,
        activityMs: livePulse.lastActivityAt,
      }
    }

    return {
      preview: '',
      activityMs: livePulse?.lastActivityAt ?? null,
    }
  }

  const activeCall = engine.calls.activeCall
  const joinedServers = engine.servers.joinedServers
  const effectiveServerId =
    selectedServerId || localSelectedServerId || engine.servers.activeServer?.id || null
  const selectedServer: ServerSummary | null =
    joinedServers.find((s) => s.id === effectiveServerId) ?? joinedServers[0] ?? null
  const isMobileServersSplit = isMobileViewport && activeTab === 'servers'

  const renderDiscordServerPane = (server: ServerSummary | null) => {
    if (!server) {
      return (
        <div className="ag-srv-discord-pane">
          <div className="ag-conv-header">
            <span className="ag-conv-section-title">Groups</span>
            <div className="ag-conv-header-actions">
              <button
                type="button"
                className="ag-circle-btn"
                onClick={() => {
                  onPlaySound?.('click')
                  onOpenServerHub('create')
                }}
                title="Create or join group"
                aria-label="Create or join group"
              >
                <Plus size={17} />
              </button>
            </div>
          </div>

          <div className="ag-srv-discord-empty">
            <div className="ag-conv-empty-icon">
              <Users size={22} />
            </div>
            <h3>No groups yet</h3>
            <div className="ag-srv-empty-actions">
              <button
                type="button"
                className="ag-srv-empty-primary"
                onClick={() => {
                  onPlaySound?.('click')
                  onOpenServerHub('create')
                }}
              >
                <Plus size={14} />
                <span>Create or Join</span>
              </button>
              <button
                type="button"
                className="ag-srv-empty-ghost"
                onClick={() => {
                  onPlaySound?.('click')
                  onOpenServerHub('explore')
                }}
              >
                <Compass size={14} />
                <span>Browse</span>
              </button>
            </div>
          </div>
        </div>
      )
    }

    const isActiveServer =
      engine.activeView.type === 'server' && engine.activeView.serverId === server.id
    const isInThisCall = activeCall?.mode === 'server' && activeCall.serverId === server.id
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
      (server.founderPubkey?.toLowerCase() === engine.identity.masterPubkey.toLowerCase() ||
        (isActiveServer && engine.servers.canModerate))
    const accentStyle = {
      '--srv-accent': server.accentColor || 'var(--accent)',
    } as CSSProperties

    const visibleChannels = textSectionOpen
      ? server.channels
      : server.channels.filter(
          (ch) =>
            isServerChannelActive(server.id, ch.id) ||
            (ch.unreadCount ?? 0) > 0 ||
            (ch.mentionCount ?? 0) > 0
        )

    return (
      <div className="ag-srv-discord-pane" style={accentStyle}>
        {/* Aligned 52px Server Header */}
        <button
          type="button"
          className="ag-srv-discord-header"
          onClick={(e) => {
            onPlaySound?.('click')
            openServerHeaderMenu(e, server, canAddChannel)
          }}
          onContextMenu={(e) => openServerHeaderMenu(e, server, canAddChannel)}
          aria-label={`${server.name} menu`}
        >
          <span className="ag-srv-discord-head-left truncate">
            {server.encrypted ? (
              <Lock size={13} className="ag-srv-discord-kind dm" aria-hidden="true" />
            ) : (
              <Globe size={13} className="ag-srv-discord-kind" aria-hidden="true" />
            )}
            <span className="ag-srv-discord-name truncate">{server.name}</span>
          </span>
          <ChevronDown size={15} className="ag-srv-discord-caret" aria-hidden="true" />
        </button>

        <div className="ag-srv-discord-scroll">
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
              <span>{joiningNip29ServerId === server.id ? 'Joining…' : 'Join Group'}</span>
            </button>
          )}

          {/* TEXT CHANNELS Category */}
          <section className="ag-srv-discord-section" aria-label="Text channels">
            <div className="ag-srv-discord-cat">
              <button
                type="button"
                className="ag-srv-discord-cat-toggle"
                onClick={() => setTextSectionOpen((v) => !v)}
                aria-expanded={textSectionOpen}
              >
                {textSectionOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                <span>Text Channels</span>
              </button>
              {canAddChannel && (
                <button
                  type="button"
                  className="ag-srv-discord-cat-add"
                  onClick={() => {
                    onPlaySound?.('click')
                    setTextSectionOpen(true)
                    setAddingChannelServerId(server.id)
                    setChannelNameDraft('')
                  }}
                  title="Create channel"
                  aria-label="Create channel"
                >
                  <Plus size={13} />
                </button>
              )}
            </div>

            <div className="ag-srv-channels">
              {visibleChannels.map((ch) => {
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
                        title={`${chMentions} ${chMentions === 1 ? 'ping' : 'pings'}`}
                      >
                        {formatBadgeCount(chMentions)}
                      </span>
                    ) : chUnread > 0 ? (
                      <span className="ag-unread-pill tabular" title={`${chUnread} unread`}>
                        {formatBadgeCount(chUnread)}
                      </span>
                    ) : null}
                  </button>
                )
              })}

              {canAddChannel && addingChannelServerId === server.id && (
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
                    {creatingChannel ? <Loader2 size={12} className="ag-spin" /> : 'Add'}
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
              )}
            </div>
          </section>

          {/* VOICE Category */}
          <section className="ag-srv-discord-section" aria-label="Voice">
            <div className="ag-srv-discord-cat">
              <button
                type="button"
                className="ag-srv-discord-cat-toggle"
                onClick={() => setVoiceSectionOpen((v) => !v)}
                aria-expanded={voiceSectionOpen}
              >
                {voiceSectionOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                <span>Voice</span>
              </button>
            </div>

            {(voiceSectionOpen || isInThisCall || voiceParticipants.length > 0) && (
              <div className="ag-srv-discord-voice-group">
                <div className={`ag-srv-discord-voice-row ${isInThisCall ? 'in-call' : ''}`}>
                  <button
                    type="button"
                    className="ag-srv-discord-voice-btn"
                    disabled={(!isInThisCall && voiceFull) || joiningVoiceServerId === server.id}
                    onClick={() => {
                      if (isInThisCall) {
                        onFocusActiveCall?.()
                      } else {
                        void handleJoinVoice(server.id)
                      }
                    }}
                  >
                    {joiningVoiceServerId === server.id ? (
                      <Loader2 size={14} className="ag-spin ag-srv-discord-voice-icon" />
                    ) : (
                      <Volume2 size={15} className="ag-srv-discord-voice-icon" />
                    )}
                    <span className="ag-srv-discord-voice-name truncate">Voice Lounge</span>
                    {anyoneRecording && (
                      <span className="ag-voice-rec-dot" aria-label="Recording in progress" />
                    )}
                    <span className="ag-srv-discord-voice-count tabular">
                      {voiceCount}/{voiceMax}
                    </span>
                  </button>

                  {isInThisCall && (
                    <button
                      type="button"
                      className="ag-srv-discord-voice-leave"
                      onClick={() => {
                        onPlaySound?.('call-leave')
                        engine.calls.leaveCall()
                      }}
                      title="Leave Voice Lounge"
                      aria-label="Leave Voice Lounge"
                    >
                      <PhoneOff size={13} />
                    </button>
                  )}
                </div>

                {voiceParticipants.length > 0 && (
                  <div className="ag-srv-discord-voice-users" role="list" aria-label="In voice">
                    {voiceParticipants.map((p) => (
                      <div key={p.pubkey} className="ag-srv-discord-voice-user" role="listitem">
                        <img
                          src={identiconDataUrl(p.pubkey)}
                          alt=""
                          width={22}
                          height={22}
                          className="ag-srv-discord-voice-avatar"
                        />
                        <span
                          className="ag-srv-discord-voice-uname truncate"
                          style={{ color: pubkeyToColor(p.pubkey) }}
                        >
                          {p.displayHandle}
                        </span>
                        {p.isRecording && (
                          <span className="ag-voice-rec-dot" aria-label="Recording" />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    )
  }

  return (
    <aside
      className={`ag-conv-pane ${collapsed ? 'collapsed' : ''} ${isMobileServersSplit ? 'is-mobile-servers' : ''}`}
      aria-label="Conversations"
    >
      {/* Top 52px Contextual Header (Radio & People views; Servers renders its own aligned 52px header) */}
      {activeTab !== 'servers' && (
        <div className="ag-conv-header">
          <span className="ag-conv-section-title">
            {activeTab === 'radio' ? 'Radio' : 'People'}
          </span>

          <div className="ag-conv-header-actions">
            {activeTab === 'radio' && (
              <>
                <button
                  type="button"
                  className={`ag-circle-btn ${engine.location.status === 'locating' ? 'locating' : ''}`}
                  onClick={onLocateMe}
                  disabled={engine.location.status === 'locating'}
                  title="Locate my area"
                  aria-label="Locate my area"
                >
                  <Crosshair size={16} />
                </button>
                <button
                  type="button"
                  className="ag-circle-btn ag-mobile-only"
                  onClick={onExpandRadar}
                  title="Open Map"
                  aria-label="Open Map"
                >
                  <MapIcon size={16} />
                </button>
              </>
            )}

            {activeTab === 'dms' && (
              <>
                {onShowQr && (
                  <button
                    type="button"
                    className="ag-circle-btn"
                    onClick={handleOpenMyDmQr}
                    title="My QR"
                    aria-label="Show my DM QR code"
                  >
                    <QrCode size={16} />
                  </button>
                )}
                {onOpenScanner && (
                  <button
                    type="button"
                    className="ag-circle-btn"
                    onClick={() => {
                      onPlaySound?.('click')
                      onOpenScanner()
                    }}
                    title="Scan QR"
                    aria-label="Scan QR code"
                  >
                    <ScanLine size={16} />
                  </button>
                )}
              </>
            )}

            <button
              type="button"
              className="ag-circle-btn"
              onClick={onOpenCommandPalette}
              title="Search (⌘K)"
              aria-label="Search or jump"
            >
              <Search size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area: Discord Servers (Desktop or Mobile 2-Col Split) OR Scrollable Radio/People */}
      {activeTab === 'servers' ? (
        isMobileServersSplit ? (
          <div className="ag-srv-mobile-split">
            <div className="ag-srv-mobile-rail" role="list" aria-label="Groups">
              {joinedServers.map((server) => {
                const active = selectedServer?.id === server.id
                const srvUnread = Math.max(
                  server.unreadCount,
                  engine.servers.getServerUnreadCount(server.id)
                )
                const srvMentions = Math.max(
                  server.mentionCount,
                  engine.servers.getServerMentionCount(server.id)
                )
                const hasUnread = srvUnread > 0 || srvMentions > 0
                const isInCall =
                  activeCall?.mode === 'server' && activeCall.serverId === server.id
                const voiceCount = Math.max(
                  engine.calls.getServerCallCount(server.id),
                  isInCall
                    ? activeCall.participants.length
                    : (engine.calls.serverCallRosters[server.id] ?? []).length
                )
                const accentStyle = {
                  '--srv-accent': server.accentColor || 'var(--accent)',
                } as CSSProperties
                return (
                  <div key={server.id} className="ag-rail-slot" role="listitem">
                    <button
                      type="button"
                      className={`ag-rail-tile ag-rail-srv compact ${active ? 'active' : ''} ${hasUnread ? 'has-unread' : ''}`}
                      style={accentStyle}
                      onClick={() => {
                        onPlaySound?.('click')
                        handleSelectServerEntry(server.id)
                      }}
                      onContextMenu={(e) => openServerContextMenu(e, server)}
                      aria-label={server.name}
                      aria-current={active ? 'page' : undefined}
                    >
                      <span className="ag-rail-indicator" aria-hidden="true" />
                      {server.picture && /^https?:\/\//i.test(server.picture) ? (
                        <img
                          src={server.picture}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          className="ag-rail-srv-img"
                        />
                      ) : server.icon?.trim() ? (
                        <span className="ag-rail-srv-emoji" aria-hidden="true">
                          {server.icon}
                        </span>
                      ) : (
                        <span className="ag-rail-srv-mono mono" aria-hidden="true">
                          {getServerMonogram(server.name)}
                        </span>
                      )}
                      {srvMentions > 0 && (
                        <span className="ag-rail-badge ping tabular">
                          {formatBadgeCount(srvMentions)}
                        </span>
                      )}
                      {voiceCount > 0 && (
                        <span
                          className={`ag-rail-voice-dot ${isInCall ? 'in-call' : ''}`}
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  </div>
                )
              })}

              <div className="ag-rail-slot" role="listitem">
                <button
                  type="button"
                  className="ag-rail-tile ag-rail-add compact"
                  onClick={() => {
                    onPlaySound?.('click')
                    onOpenServerHub('create')
                  }}
                  aria-label="Create or join group"
                >
                  <Plus size={18} strokeWidth={2} />
                </button>
              </div>
            </div>

            <div className="ag-srv-mobile-main">{renderDiscordServerPane(selectedServer)}</div>
          </div>
        ) : (
          renderDiscordServerPane(selectedServer)
        )
      ) : (
        <div className="ag-conv-scroll">
          {/* ================= RADIO TAB ================= */}
          {activeTab === 'radio' && (
            <div className="ag-conv-section-stack">
              <div className="ag-radio-quickbar">
                <form className="ag-jump-form" onSubmit={handleQuickTune}>
                  <span className="ag-jump-hash">#</span>
                  <input
                    type="text"
                    className="ag-jump-input"
                    value={freqDraft}
                    onChange={(e) => setFreqDraft(e.target.value)}
                    placeholder="Geohash, city, or topic…"
                    aria-label="Jump to geohash, city, or topic channel"
                  />
                  {freqDraft.trim() && (
                    <button type="submit" className="ag-jump-go-btn" aria-label="Go">
                      Go
                    </button>
                  )}
                </form>
              </div>

            {/* Active Room (if not already listed in Pinned or Active Rooms) */}
            {showActiveRoomCard && (() => {
              const gh = engine.activeGeohash
              const ghKey = gh.toLowerCase()
              const isTopic = isTopicChannel(gh)
              const displayLabel = formatRadioChannelLabel(gh)
              const active = isChannelActive(gh)
              const unread = engine.unreadCounts[ghKey] ?? 0
              const mentions = engine.mentionCounts[ghKey] ?? 0
              const hasUnread = unread > 0 || mentions > 0
              const callCount = engine.calls.getGeoCallCount(gh)
              const inCall =
                activeCall?.mode === 'geo' &&
                (activeCall.geohash ?? '').toLowerCase() === ghKey
              const livePulse = pulseByHash.get(ghKey)
              const resolved = resolveRadioPreview(ghKey, livePulse)
              const currentSubtitle = resolved.preview
                ? resolved.preview
                : isTopic
                  ? 'Topic'
                  : engine.presence.isUncertainCount
                    ? 'Radio room'
                    : `${engine.presence.onlineCount} online`
              return (
              <section className="ag-conv-group" aria-label="Current room">
                <div className="ag-conv-group-label">Current Room</div>
                <div
                  className={`ag-chat-row-wrap ${active ? 'active' : ''} ${hasUnread ? 'is-unread' : ''} ${mentions > 0 ? 'has-pings' : ''}`}
                  onContextMenu={(e) =>
                    openRoomContextMenu(e, gh, isTopic ? undefined : engine.cell.nearestCity || undefined)
                  }
                >
                  <button
                    type="button"
                    className="ag-chat-row"
                    onClick={() => onTuneChannel(gh)}
                  >
                    <div className={`ag-chat-row-avatar ${isTopic ? 'topic' : 'radio'}`}>
                      {isTopic ? <Hash size={17} /> : <Radio size={18} />}
                    </div>
                    <div className="ag-chat-row-body">
                      <div className="ag-chat-row-top">
                        <span className="ag-chat-row-name truncate">
                          <span className="mono">{displayLabel}</span>
                          {isTopic ? (
                            <span className="ag-topic-pill">Topic</span>
                          ) : engine.cell.nearestCity ? (
                            <span className="ag-chat-row-city"> · {engine.cell.nearestCity}</span>
                          ) : null}
                        </span>
                        <span className={`ag-chat-row-time${resolved.activityMs ? ' tabular' : ''}`}>
                          {resolved.activityMs ? formatRelativeTime(resolved.activityMs) : 'live'}
                        </span>
                      </div>
                      <div className="ag-chat-row-bottom">
                        <span className="ag-chat-row-preview truncate">{currentSubtitle}</span>
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
                </div>
              </section>
              )
            })()}

            {/* Pinned Rooms (Draggable + Touch Grip Handle + Context Menu Move Up/Down) */}
            {engine.pinnedChannels.length > 0 && (
              <section className="ag-conv-group" aria-label="Pinned rooms">
                <div className="ag-conv-group-label">Pinned</div>
                <div ref={pinnedListRef} className="ag-pinned-list">
                {engine.pinnedChannels.map((pin, idx) => {
                  const ghKey = pin.geohash.toLowerCase()
                  const isTopic = isTopicChannel(pin.geohash)
                  const displayLabel = formatRadioChannelLabel(pin.geohash)
                  const active = isChannelActive(pin.geohash)
                  const livePulse = pulseByHash.get(ghKey)
                  const unread = Math.max(pin.unreadCount, engine.unreadCounts[ghKey] ?? 0)
                  const mentions = Math.max(pin.mentionCount, engine.mentionCounts[ghKey] ?? 0)
                  const hasUnread = unread > 0 || mentions > 0
                  const callCount = engine.calls.getGeoCallCount(pin.geohash)
                  const inCall =
                    activeCall?.mode === 'geo' &&
                    (activeCall.geohash ?? '').toLowerCase() === ghKey
                  const displayCity = isTopic ? undefined : (pin.label || livePulse?.nearestCity || undefined)
                  const canReorder = engine.pinnedChannels.length > 1
                  const isDragging = dragPinIndex === idx
                  const isDropBefore =
                    dropPinTarget !== null &&
                    dropPinTarget.index === idx &&
                    dropPinTarget.position === 'before' &&
                    dragPinIndex !== null &&
                    dragPinIndex !== idx
                  const isDropAfter =
                    dropPinTarget !== null &&
                    dropPinTarget.index === idx &&
                    dropPinTarget.position === 'after' &&
                    dragPinIndex !== null &&
                    dragPinIndex !== idx
                  const resolved = resolveRadioPreview(ghKey, livePulse)
                  const subtitle = resolved.preview
                    ? resolved.preview
                    : livePulse && livePulse.peerCount > 0
                      ? `${livePulse.peerCount} ${livePulse.peerCount === 1 ? 'person' : 'people'} active`
                      : livePulse && livePulse.messageCount > 0
                        ? `${livePulse.messageCount} recent ${livePulse.messageCount === 1 ? 'message' : 'messages'}`
                        : isTopic
                          ? 'Pinned topic'
                          : active && !engine.presence.isUncertainCount && engine.presence.onlineCount > 0
                            ? `${engine.presence.onlineCount} online · Pinned`
                            : 'Pinned room'
                  return (
                    <div
                      key={pin.geohash}
                      data-pin-index={idx}
                      draggable={canReorder}
                      className={`ag-chat-row-wrap ag-pinned-row ${active ? 'active' : ''} ${hasUnread ? 'is-unread' : ''} ${mentions > 0 ? 'has-pings' : ''} ${isDragging ? 'is-dragging' : ''} ${isDropBefore ? 'drop-before' : ''} ${isDropAfter ? 'drop-after' : ''}`}
                      onContextMenu={(e) => openRoomContextMenu(e, pin.geohash, displayCity)}
                      onDragStart={(e) => {
                        if (!canReorder) return
                        setDragPinIndex(idx)
                        e.dataTransfer.effectAllowed = 'move'
                        try {
                          e.dataTransfer.setData('text/plain', pin.geohash)
                        } catch {
                          // Ignore browser dataTransfer restrictions
                        }
                      }}
                      onDragOver={(e) => {
                        if (dragPinIndex === null || !canReorder) return
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        const rect = e.currentTarget.getBoundingClientRect()
                        const pos: 'before' | 'after' =
                          e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                        setDropPinTarget((prev) =>
                          prev && prev.index === idx && prev.position === pos
                            ? prev
                            : { index: idx, position: pos }
                        )
                      }}
                      onDrop={(e) => {
                        if (dragPinIndex === null || !canReorder) return
                        e.preventDefault()
                        const rect = e.currentTarget.getBoundingClientRect()
                        const pos: 'before' | 'after' =
                          e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                        const toIndex = computeReorderToIndex(
                          dragPinIndex,
                          idx,
                          pos,
                          engine.pinnedChannels.length
                        )
                        if (toIndex !== dragPinIndex) {
                          onPlaySound?.('click')
                          engine.reorderPinnedChannels(dragPinIndex, toIndex)
                        }
                        setDragPinIndex(null)
                        setDropPinTarget(null)
                      }}
                      onDragEnd={() => {
                        setDragPinIndex(null)
                        setDropPinTarget(null)
                      }}
                    >
                      <button
                        type="button"
                        className="ag-chat-row"
                        onClick={() => onTuneChannel(pin.geohash)}
                      >
                        <div className={`ag-chat-row-avatar ${isTopic ? 'topic' : 'pinned'}`}>
                          {isTopic ? <Hash size={17} /> : <Star size={17} fill="currentColor" />}
                        </div>
                        <div className="ag-chat-row-body">
                          <div className="ag-chat-row-top">
                            <span className="ag-chat-row-name truncate">
                              <span className="mono">{displayLabel}</span>
                              {isTopic ? (
                                <span className="ag-topic-pill">Topic</span>
                              ) : displayCity ? (
                                <span className="ag-chat-row-city"> · {displayCity}</span>
                              ) : null}
                            </span>
                            {resolved.activityMs ? (
                              <span className="ag-chat-row-time tabular">
                                {formatRelativeTime(resolved.activityMs)}
                              </span>
                            ) : active ? (
                              <span className="ag-chat-row-time">live</span>
                            ) : null}
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
                              ) : livePulse && livePulse.peerCount > 0 ? (
                                <span className="ag-row-peer-count tabular">{livePulse.peerCount}</span>
                              ) : null}
                            </span>
                          </div>
                        </div>
                      </button>

                      {canReorder && (
                        <button
                          type="button"
                          className="ag-row-drag-handle"
                          data-drag-handle="true"
                          data-no-swipe="true"
                          title={`Drag to reorder ${displayLabel}`}
                          aria-label={`Reorder ${displayLabel} (use Up/Down arrows or drag)`}
                          onClick={(e) => e.stopPropagation()}
                          onPointerDown={(e) => {
                            if (e.pointerType === 'mouse') return
                            e.stopPropagation()
                            e.preventDefault()
                            try {
                              e.currentTarget.setPointerCapture(e.pointerId)
                            } catch {
                              // Ignore capture errors
                            }
                            touchDragRef.current = {
                              pointerId: e.pointerId,
                              fromIndex: idx,
                              targetIndex: idx,
                              position: 'before',
                            }
                            setDragPinIndex(idx)
                            setDropPinTarget({ index: idx, position: 'before' })
                            try {
                              navigator.vibrate?.(8)
                            } catch {
                              // Ignore unsupported vibrate
                            }
                          }}
                          onPointerMove={(e) => {
                            const drag = touchDragRef.current
                            if (!drag || drag.pointerId !== e.pointerId) return
                            e.preventDefault()
                            const rows = pinnedListRef.current?.querySelectorAll<HTMLElement>(
                              '[data-pin-index]'
                            )
                            if (!rows || rows.length === 0) return
                            let bestIdx = 0
                            let bestPos: 'before' | 'after' = 'before'
                            for (let i = 0; i < rows.length; i++) {
                              const row = rows[i]
                              const rect = row.getBoundingClientRect()
                              const rowIdx = Number(row.dataset.pinIndex)
                              if (e.clientY < rect.top + rect.height / 2) {
                                bestIdx = rowIdx
                                bestPos = 'before'
                                break
                              }
                              bestIdx = rowIdx
                              bestPos = 'after'
                            }
                            drag.targetIndex = bestIdx
                            drag.position = bestPos
                            setDropPinTarget((prev) =>
                              prev && prev.index === bestIdx && prev.position === bestPos
                                ? prev
                                : { index: bestIdx, position: bestPos }
                            )
                          }}
                          onPointerUp={(e) => {
                            const drag = touchDragRef.current
                            if (!drag || drag.pointerId !== e.pointerId) return
                            e.stopPropagation()
                            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                              e.currentTarget.releasePointerCapture(e.pointerId)
                            }
                            const toIndex = computeReorderToIndex(
                              drag.fromIndex,
                              drag.targetIndex,
                              drag.position,
                              engine.pinnedChannels.length
                            )
                            if (toIndex !== drag.fromIndex) {
                              onPlaySound?.('click')
                              engine.reorderPinnedChannels(drag.fromIndex, toIndex)
                            }
                            touchDragRef.current = null
                            setDragPinIndex(null)
                            setDropPinTarget(null)
                          }}
                          onPointerCancel={(e) => {
                            const drag = touchDragRef.current
                            if (!drag || drag.pointerId !== e.pointerId) return
                            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                              e.currentTarget.releasePointerCapture(e.pointerId)
                            }
                            touchDragRef.current = null
                            setDragPinIndex(null)
                            setDropPinTarget(null)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'ArrowUp' && idx > 0) {
                              e.preventDefault()
                              onPlaySound?.('click')
                              engine.reorderPinnedChannels(idx, idx - 1)
                            } else if (e.key === 'ArrowDown' && idx < engine.pinnedChannels.length - 1) {
                              e.preventDefault()
                              onPlaySound?.('click')
                              engine.reorderPinnedChannels(idx, idx + 1)
                            }
                          }}
                        >
                          <GripVertical size={14} />
                        </button>
                      )}
                    </div>
                  )
                })}
                </div>
              </section>
            )}

            {/* Active Rooms */}
            <section className="ag-conv-group" aria-label="Active rooms">
              <div className="ag-conv-group-label">Active Rooms</div>

              {liveRooms.length === 0 ? (
                <div className="ag-conv-empty">
                  <p>
                    {engine.pulseRooms.length > 0
                      ? 'All active rooms are pinned.'
                      : 'Listening for active rooms…'}
                  </p>
                  <button type="button" className="ag-soft-pill-btn" onClick={onExpandRadar}>
                    <Compass size={14} />
                    <span>Open Map</span>
                  </button>
                </div>
              ) : (
                liveRooms.map((room) => {
                  const ghKey = room.geohash.toLowerCase()
                  const isTopic = isTopicChannel(room.geohash)
                  const displayLabel = formatRadioChannelLabel(room.geohash)
                  const active = isChannelActive(room.geohash)
                  const unread = engine.unreadCounts[ghKey] ?? 0
                  const mentions = engine.mentionCounts[ghKey] ?? 0
                  const hasUnread = unread > 0 || mentions > 0
                  const callCount = engine.calls.getGeoCallCount(room.geohash)
                  const inCall =
                    activeCall?.mode === 'geo' &&
                    (activeCall.geohash ?? '').toLowerCase() === ghKey
                  const resolved = resolveRadioPreview(ghKey, room)
                  const subtitle = resolved.preview
                    ? resolved.preview
                    : room.peerCount > 0
                      ? `${room.peerCount} ${room.peerCount === 1 ? 'person' : 'people'} active`
                      : `${room.messageCount} recent ${room.messageCount === 1 ? 'message' : 'messages'}`
                  return (
                    <div
                      key={room.geohash}
                      className={`ag-chat-row-wrap ${active ? 'active' : ''} ${hasUnread ? 'is-unread' : ''} ${mentions > 0 ? 'has-pings' : ''}`}
                      onContextMenu={(e) =>
                        openRoomContextMenu(
                          e,
                          room.geohash,
                          isTopic ? undefined : room.nearestCity || undefined
                        )
                      }
                    >
                      <button
                        type="button"
                        className="ag-chat-row"
                        onClick={() => onTuneChannel(room.geohash)}
                      >
                        <div className={`ag-chat-row-avatar ${isTopic ? 'topic' : 'radio'}`}>
                          {isTopic ? <Hash size={17} /> : <Radio size={18} />}
                        </div>
                        <div className="ag-chat-row-body">
                          <div className="ag-chat-row-top">
                            <span className="ag-chat-row-name truncate">
                              <span className="mono">{displayLabel}</span>
                              {isTopic ? (
                                <span className="ag-topic-pill">Topic</span>
                              ) : room.nearestCity ? (
                                <span className="ag-chat-row-city"> · {room.nearestCity}</span>
                              ) : null}
                            </span>
                            <span className="ag-chat-row-time tabular">
                              {formatRelativeTime(resolved.activityMs ?? room.lastActivityAt)}
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
              const aUnread = engine.isPeerBlocked(a.peerPubkey) ? 0 : a.unreadCount
              const bUnread = engine.isPeerBlocked(b.peerPubkey) ? 0 : b.unreadCount
              if ((bUnread > 0 ? 1 : 0) !== (aUnread > 0 ? 1 : 0)) {
                return (bUnread > 0 ? 1 : 0) - (aUnread > 0 ? 1 : 0)
              }
              return b.lastMessageAt - a.lastMessageAt
            })
            .filter((t) => {
              if (!filterQuery || isShareableInput) return true
              const note = (engine.peerNotes[t.peerPubkey.toLowerCase()] ?? '').toLowerCase()
              return (
                t.peerNickname.toLowerCase().includes(filterQuery) ||
                t.peerDisplayHandle.toLowerCase().includes(filterQuery) ||
                t.peerNpub.toLowerCase().includes(filterQuery) ||
                t.peerPubkey.toLowerCase().includes(filterQuery) ||
                note.includes(filterQuery)
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
              const note = (engine.peerNotes[friend.entry.pubkey.toLowerCase()] ?? '').toLowerCase()
              return (
                friend.nickname.toLowerCase().includes(filterQuery) ||
                friend.displayHandle.toLowerCase().includes(filterQuery) ||
                friend.entry.npub.toLowerCase().includes(filterQuery) ||
                friend.entry.pubkey.toLowerCase().includes(filterQuery) ||
                note.includes(filterQuery)
              )
            })
            .sort((a, b) => b.entry.addedAt - a.entry.addedAt)

          const hasAnyPeople = engine.dmThreads.length > 0 || engine.trustedPubkeys.length > 0
          const hasVisiblePeople = sortedThreads.length > 0 || trustedFriends.length > 0

          return (
          <div className="ag-conv-section-stack">
            <form className="ag-dm-jump-form" onSubmit={handleQuickStartDm}>
              <input
                type="text"
                className="ag-jump-input"
                value={dmDraft}
                onChange={(e) => setDmDraft(e.target.value)}
                placeholder="Search or paste link / npub…"
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
                  <Users size={22} />
                </div>
                <h3>{hasAnyPeople ? 'No matching people' : 'No people yet'}</h3>
                <p>
                  {hasAnyPeople
                    ? 'Try another name or paste an npub.'
                    : 'Trust someone in a room or share your QR.'}
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
                      const blocked = engine.isPeerBlocked(thread.peerPubkey)
                      const visibleUnread = blocked ? 0 : thread.unreadCount
                      const hasUnread = visibleUnread > 0
                      const peerNote = engine.peerNotes[thread.peerPubkey.toLowerCase()]
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
                                  {blocked
                                    ? 'Muted'
                                    : thread.lastPreview || 'Encrypted chat'}
                                </span>
                                {visibleUnread > 0 && (
                                  <span
                                    className="ag-ping-badge tabular"
                                    title={`${visibleUnread} unread`}
                                  >
                                    {formatBadgeCount(visibleUnread)}
                                  </span>
                                )}
                              </div>
                              {peerNote && (
                                <span className="ag-person-note-line truncate" title={peerNote}>
                                  {peerNote}
                                </span>
                              )}
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

                          {onCloseDmThread && (
                            <button
                              type="button"
                              className="ag-row-close-btn"
                              onClick={(e) => {
                                e.stopPropagation()
                                onPlaySound?.('click')
                                onCloseDmThread(thread.peerPubkey)
                              }}
                              title="Close chat"
                              aria-label={`Close chat with ${thread.peerNickname}`}
                            >
                              <X size={14} />
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
                      const peerNote = engine.peerNotes[entry.pubkey.toLowerCase()]
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
                                <span
                                  className={`ag-chat-row-preview truncate ${peerNote ? 'is-note' : ''}`}
                                  title={peerNote || undefined}
                                >
                                  {peerNote || 'Trusted'}
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

        </div>
      )}

      {/* Bottom User Dock (Compact Discord-style Profile + Quiet Status + Settings) */}
      <div className="ag-conv-footer">
        <button
          type="button"
          className="ag-profile-bar-btn"
          onClick={() => onOpenSettings('profile')}
          title="Profile"
        >
          <span className="ag-profile-avatar-wrap">
            <img
              src={identiconDataUrl(engine.identity.activePubkey)}
              alt=""
              className="ag-profile-avatar"
            />
            <span
              className={`ag-profile-status-dot ${engine.connectedRelayCount > 0 ? 'online' : 'reconnecting'}`}
              aria-hidden="true"
            />
          </span>
          <div className="ag-profile-meta">
            <span className="ag-profile-name truncate">{engine.identity.nickname}</span>
            <span className="ag-profile-sub truncate">
              {engine.connectedRelayCount > 0 ? 'Online' : 'Reconnecting…'}
            </span>
          </div>
        </button>

        <div className="ag-conv-footer-actions">
          {pwa && !pwa.isInstalled && pwa.canPromptInstall && onOpenInstall && (
            <button
              type="button"
              className="ag-circle-btn ag-dock-icon-btn ag-mobile-only"
              onClick={onOpenInstall}
              title="Install App"
              aria-label="Install Agnostr App"
            >
              <Download size={16} aria-hidden="true" />
            </button>
          )}

          <button
            type="button"
            className="ag-circle-btn ag-dock-icon-btn"
            onClick={() => {
              onPlaySound?.('click')
              onOpenSettings()
            }}
            title="Settings"
            aria-label="Settings"
          >
            <Settings size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </aside>
  )
}

export default ConversationList
