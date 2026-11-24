import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bell,
  BellRing,
  Captions,
  Circle,
  Crosshair,
  Database,
  Download,
  Globe,
  Hash,
  Info,
  Key,
  Languages,
  Link2,
  Lock,
  Mail,
  Map as MapIcon,
  MessageCircle,
  Mic,
  MicOff,
  Palette,
  PenLine,
  Phone,
  PhoneOff,
  Plus,
  QrCode,
  Radio,
  RefreshCw,
  RotateCw,
  ScanLine,
  Search,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Square,
  Terminal,
  Video,
  Volume2,
  Wallet,
  Wifi,
  Zap,
} from 'lucide-react'
import type { AgnostrEngine, ThemeId } from '../types/protocol'
import type { WalletInitialIntent } from '../types/wallet'
import type { PwaState } from '../hooks/usePwa'
import {
  formatRadioChannelLabel,
  isTopicChannel,
  makeTopicChannelKey,
  normalizeTopicSlug,
  POPULAR_TOPIC_CHANNELS,
} from '../lib/radioChannel'
import { buildDmShareUrl, parseShareTarget, type ParsedShareTarget } from '../lib/shareLinks'
import { formatHandle } from '../utils/identicon'
import type { QrShareTarget } from './QrShareModal'
import type { ServerHubTab } from './ServerHubModal'
import type { SettingsTab } from './SettingsModal'

const GEOHASH_REGEX = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/i

const THEMES: Array<{ id: ThemeId; name: string; desc: string }> = [
  { id: 'phosphor', name: 'Carbon', desc: 'Neutral graphite & electric blue' },
  { id: 'obsidian', name: 'Indigo', desc: 'Deep ink & modern indigo' },
  { id: 'amber', name: 'Stone', desc: 'Warm charcoal & refined amber' },
  { id: 'daylight', name: 'Light', desc: 'Clean white & cobalt blue' },
]

interface PaletteEntry {
  id: string
  group: string
  title: string
  subtitle: string
  keywords: string
  badge?: string
  icon: React.ReactNode
  run: () => void
}

export interface CommandPaletteProps {
  open: boolean
  engine: AgnostrEngine
  onClose: () => void
  onTuneChannel: (geohash: string) => void
  onOpenDm?: (pubkey: string, nickname?: string) => void
  onSelectServerChannel?: (serverId: string, channelId: string) => void
  onOpenServerHub?: (initialTab?: ServerHubTab) => void
  onExpandRadar: () => void
  onLocateMe: () => void
  onOpenRoomInfo: () => void
  onOpenSettings: (tab?: SettingsTab) => void
  onOpenAmail?: (section?: 'inbox' | 'compose' | 'contacts' | 'mesh') => void
  onOpenWallet?: (intent?: WalletInitialIntent) => void
  onToggleSound: () => void
  onRunCommand: (cmdLine: string) => void
  onExport: (format: 'md' | 'json') => void
  onShowQr?: (target: QrShareTarget) => void
  onOpenScanner?: () => void
  onResolvedShareTarget?: (target: ParsedShareTarget) => void
  pwa?: PwaState
  onOpenInstall?: () => void
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  engine,
  onClose,
  onTuneChannel,
  onOpenDm,
  onSelectServerChannel,
  onOpenServerHub,
  onExpandRadar,
  onLocateMe,
  onOpenRoomInfo,
  onOpenSettings,
  onOpenAmail,
  onOpenWallet,
  onToggleSound,
  onRunCommand,
  onExport,
  onShowQr,
  onOpenScanner,
  onResolvedShareTarget,
  pwa,
  onOpenInstall,
}) => {
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIdx(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const entries: PaletteEntry[] = useMemo(() => {
    const q = query.trim().toLowerCase()
    const cleanHash = q.replace(/^#/, '')
    const list: PaletteEntry[] = []

    // Direct jump whenever query is a DM link / npub / community invite / Cashu token / Lightning invoice
    const parsedShare = query.trim().length >= 8 ? parseShareTarget(query.trim()) : null
    if (parsedShare && onResolvedShareTarget) {
      list.push({
        id: `direct-share-${parsedShare.kind}`,
        group:
          parsedShare.kind === 'dm'
            ? 'Direct Message'
            : parsedShare.kind === 'cashu'
              ? 'Cashu Ecash'
              : parsedShare.kind === 'lightning'
                ? 'Lightning'
                : 'Community Invite',
        title:
          parsedShare.kind === 'dm'
            ? `Start DM with ${parsedShare.nickname || `${parsedShare.npub.slice(0, 14)}…`}`
            : parsedShare.kind === 'cashu'
              ? 'Claim Cashu Ecash Token'
              : parsedShare.kind === 'lightning'
                ? parsedShare.lightningKind === 'lud16'
                  ? `Pay Lightning Address (${parsedShare.payload})`
                  : 'Pay Lightning Invoice'
                : 'Join Community from Invite',
        subtitle:
          parsedShare.kind === 'dm'
            ? parsedShare.npub
            : parsedShare.kind === 'cashu'
              ? 'Open Agwallet to verify & claim this ecash token'
              : parsedShare.kind === 'lightning'
                ? 'Open Agwallet to melt & pay via Lightning'
                : 'Open & join this community invite immediately',
        keywords: query.trim().toLowerCase(),
        badge:
          parsedShare.kind === 'dm'
            ? 'DM'
            : parsedShare.kind === 'cashu'
              ? 'CASHU'
              : parsedShare.kind === 'lightning'
                ? 'LN'
                : 'INVITE',
        icon:
          parsedShare.kind === 'dm' ? (
            <MessageCircle size={15} style={{ color: 'var(--dm-accent)' }} />
          ) : parsedShare.kind === 'cashu' || parsedShare.kind === 'lightning' ? (
            <Zap size={15} style={{ color: 'var(--status-warn)' }} />
          ) : (
            <Server size={15} style={{ color: 'var(--accent)' }} />
          ),
        run: () => {
          onClose()
          onResolvedShareTarget(parsedShare)
        },
      })
    }

    // Direct jump to Geohash or Named Topic Radio channel (`kind: 23333`)
    if (q.length >= 1 && !parsedShare) {
      const explicitTopic = /^#?topic:/i.test(q)
      const topicSlug = normalizeTopicSlug(q)
      const topicKey = topicSlug ? makeTopicChannelKey(topicSlug) : null

      if (explicitTopic && topicSlug && topicKey) {
        list.push({
          id: `direct-topic-${topicSlug}`,
          group: 'Jump to Room',
          title: `Open #${topicSlug}`,
          subtitle: `Join Topic Radio #${topicSlug}`,
          keywords: `${q} topic:${topicSlug} #${topicSlug} ${topicSlug} radio`,
          badge: 'TOPIC',
          icon: <Hash size={15} style={{ color: 'var(--accent)' }} />,
          run: () => {
            onTuneChannel(topicKey)
            onClose()
          },
        })
      } else if (!q.startsWith('/')) {
        const isGeo = cleanHash.length >= 1 && GEOHASH_REGEX.test(cleanHash)
        if (isGeo) {
          list.push({
            id: `direct-geo-${cleanHash}`,
            group: 'Jump to Room',
            title: `Open #${cleanHash}`,
            subtitle: `Join geohash room #${cleanHash}`,
            keywords: `${q} ${cleanHash} #${cleanHash} geohash radio`,
            badge: 'GEO',
            icon: <Radio size={15} />,
            run: () => {
              onTuneChannel(cleanHash)
              onClose()
            },
          })
          // Also offer Topic jump for words that happen to use base32 letters (e.g. tech, rust, news)
          if (cleanHash.length >= 2 && topicSlug && topicKey) {
            list.push({
              id: `direct-topic-${topicSlug}`,
              group: 'Jump to Room',
              title: `Open #${topicSlug} (Topic Radio)`,
              subtitle: `Join topic channel #${topicSlug}`,
              keywords: `${q} topic:${topicSlug} #${topicSlug} ${topicSlug} topic`,
              badge: 'TOPIC',
              icon: <Hash size={15} style={{ color: 'var(--accent)' }} />,
              run: () => {
                onTuneChannel(topicKey)
                onClose()
              },
            })
          }
        } else if (topicSlug && topicKey && cleanHash.length >= 2) {
          list.push({
            id: `direct-topic-${topicSlug}`,
            group: 'Jump to Room',
            title: `Open #${topicSlug}`,
            subtitle: `Join Topic Radio #${topicSlug}`,
            keywords: `${q} topic:${topicSlug} #${topicSlug} ${topicSlug} topic radio`,
            badge: 'TOPIC',
            icon: <Hash size={15} style={{ color: 'var(--accent)' }} />,
            run: () => {
              onTuneChannel(topicKey)
              onClose()
            },
          })
        }
      }
    }

    // People (Active DMs + Trusted Friends)
    const seenPeople = new Set<string>()
    for (const dm of engine.dmThreads) {
      const pk = dm.peerPubkey.toLowerCase()
      seenPeople.add(pk)
      const isTrusted = engine.isExplicitlyTrusted(dm.peerPubkey)
      const isBlocked = engine.isPeerBlocked(dm.peerPubkey)
      const visibleUnread = isBlocked ? 0 : dm.unreadCount
      const peerNote = engine.peerNotes[pk] ?? ''
      list.push({
        id: `person-dm-${pk}`,
        group: 'People',
        title: dm.peerDisplayHandle,
        subtitle: isBlocked
          ? 'Muted user'
          : dm.lastPreview || peerNote || (isTrusted ? 'Trusted friend · Encrypted DM' : 'Encrypted DM'),
        keywords: `people dm friend message ${dm.peerNickname} ${dm.peerDisplayHandle} ${dm.peerNpub} ${peerNote}`,
        badge: isBlocked
          ? 'MUTED'
          : visibleUnread > 0
            ? `${visibleUnread}`
            : isTrusted
              ? 'FRIEND'
              : 'DM',
        icon: <MessageCircle size={15} style={{ color: 'var(--dm-accent)' }} />,
        run: () => {
          if (onOpenDm) onOpenDm(dm.peerPubkey, dm.peerNickname)
          else engine.openDmThread(dm.peerPubkey, dm.peerNickname)
          onClose()
        },
      })
    }
    const selfMaster = engine.identity.masterPubkey.toLowerCase()
    const selfActive = engine.identity.activePubkey.toLowerCase()
    for (const entry of engine.trustedPubkeys) {
      const pk = entry.pubkey.toLowerCase()
      if (seenPeople.has(pk) || pk === selfMaster || pk === selfActive) continue
      seenPeople.add(pk)
      const livePeer = engine.getPeerByPubkey(entry.pubkey)
      const nick = entry.label?.trim() || livePeer?.nickname || 'anon'
      const handle = formatHandle(nick, entry.pubkey)
      const peerNote = engine.peerNotes[pk] ?? ''
      list.push({
        id: `person-friend-${pk}`,
        group: 'People',
        title: handle.full,
        subtitle: peerNote || 'Trusted',
        keywords: `people dm friend trusted ${handle.base} ${handle.full} ${entry.npub} ${peerNote}`,
        badge: 'FRIEND',
        icon: <ShieldCheck size={15} style={{ color: 'var(--accent)' }} />,
        run: () => {
          if (onOpenDm) onOpenDm(entry.pubkey, handle.base)
          else engine.openDmThread(entry.pubkey, handle.base)
          onClose()
        },
      })
    }

    // Joined Servers & Channels
    for (const srv of engine.servers.joinedServers) {
      for (const chan of srv.channels) {
        list.push({
          id: `srv-${srv.id}-${chan.id}`,
          group: 'Groups & Channels',
          title: `${srv.name} › #${chan.name}`,
          subtitle:
            chan.topic ||
            (srv.kind === 'nip29'
              ? srv.relayUrl?.replace(/^wss?:\/\//i, '') ?? 'Hosted group'
              : srv.encrypted
                ? 'Private encrypted group'
                : 'Public group'),
          keywords: `group server channel ${srv.name} ${chan.name} #${chan.name} ${srv.kind} ${srv.encrypted ? 'e2ee encrypted private' : 'public'}`,
          badge: srv.kind === 'nip29' ? 'HOSTED' : srv.encrypted ? 'PRIVATE' : undefined,
          icon: srv.encrypted ? (
            <Lock size={15} style={{ color: 'var(--dm-accent)' }} />
          ) : (
            <Server size={15} />
          ),
          run: () => {
            if (onSelectServerChannel) {
              onSelectServerChannel(srv.id, chan.id)
            } else {
              engine.servers.selectChannel(srv.id, chan.id)
            }
            onClose()
          },
        })
      }
    }

    // Active Rooms (Geohash + Named Topic Radio)
    const activePulseKeys = new Set<string>()
    for (const room of engine.pulseRooms.slice(0, 8)) {
      const keyLower = room.geohash.toLowerCase()
      activePulseKeys.add(keyLower)
      const isTopic = isTopicChannel(room.geohash)
      const displayLabel = formatRadioChannelLabel(room.geohash)
      const previewHidden = Boolean(
        room.lastSenderPubkey &&
          (engine.isPeerBlocked(room.lastSenderPubkey) ||
            (engine.strictWhitelistMode && !engine.isTrusted(room.lastSenderPubkey)))
      )
      const safePreview = previewHidden ? '' : room.lastPreview
      list.push({
        id: `pulse-${room.geohash}`,
        group: 'Active Rooms',
        title: `${displayLabel}${!isTopic && room.nearestCity ? ` · ${room.nearestCity}` : ''}`,
        subtitle: `${room.peerCount} ${room.peerCount === 1 ? 'person' : 'people'}${safePreview ? ` · ${safePreview}` : isTopic ? ' · Topic' : ''}`,
        keywords: `active live room radio ${isTopic ? 'topic' : 'geo'} ${room.geohash} ${displayLabel} ${room.nearestCity ?? ''}`,
        badge: isTopic ? 'TOPIC' : 'LIVE',
        icon: isTopic ? (
          <Hash size={15} style={{ color: 'var(--accent)' }} />
        ) : (
          <Radio size={15} style={{ color: 'var(--accent)' }} />
        ),
        run: () => {
          onTuneChannel(room.geohash)
          onClose()
        },
      })
    }

    // Popular Named Topic Channels
    for (const topic of POPULAR_TOPIC_CHANNELS) {
      const topicKey = makeTopicChannelKey(topic.slug) ?? `topic:${topic.slug}`
      if (activePulseKeys.has(topicKey)) continue
      list.push({
        id: `topic-popular-${topic.slug}`,
        group: 'Topic Channels',
        title: topic.label,
        subtitle: topic.description,
        keywords: `topic radio named channel ${topic.slug} ${topic.label} ${topic.description}`,
        badge: 'TOPIC',
        icon: <Hash size={15} style={{ color: 'var(--accent)' }} />,
        run: () => {
          onTuneChannel(topicKey)
          onClose()
        },
      })
    }

    // Cities
    for (const city of engine.quickCities) {
      list.push({
        id: `city-${city.geohash}`,
        group: 'Places',
        title: `${city.name} (#${city.geohash})`,
        subtitle: city.region,
        keywords: `${city.name} ${city.region} ${city.geohash}`,
        icon: <Globe size={15} />,
        run: () => {
          onTuneChannel(city.geohash)
          onClose()
        },
      })
    }

    // Active Call Actions
    if (engine.calls.activeCall) {
      const activeCall = engine.calls.activeCall
      list.push(
        {
          id: 'act-call-mute',
          group: 'Actions',
          title: activeCall.localMuted ? 'Unmute Microphone' : 'Mute Microphone',
          subtitle: activeCall.localMuted
            ? `Muted in ${activeCall.title}`
            : `Live in ${activeCall.title}`,
          keywords: 'call mute unmute mic audio voice video toggle',
          badge: activeCall.localMuted ? 'MUTED' : 'LIVE',
          icon: activeCall.localMuted ? <MicOff size={15} /> : <Mic size={15} />,
          run: () => {
            engine.calls.toggleMute()
            onClose()
          },
        },
        ...(activeCall.recordingSupported
          ? [
              {
                id: 'act-call-record',
                group: 'Actions',
                title: activeCall.localRecording ? 'Stop Call Recording' : 'Start Call Recording',
                subtitle: activeCall.localRecording
                  ? `Stop and save ${activeCall.localRecordingMode ?? 'call'} recording`
                  : 'Record call locally (shows live indicator to participants)',
                keywords: 'record recording rec start stop save download call audio video',
                badge: activeCall.localRecording ? 'REC' : undefined,
                icon: activeCall.localRecording ? (
                  <Square size={14} fill="currentColor" style={{ color: 'var(--status-danger)' }} />
                ) : (
                  <Circle size={14} fill="currentColor" style={{ color: 'var(--status-danger)' }} />
                ),
                run: () => {
                  void engine.calls.toggleRecording()
                  onClose()
                },
              },
            ]
          : []),
        {
          id: 'act-call-captions',
          group: 'Actions',
          title: 'Toggle Live Call Captions (CC)',
          subtitle: engine.transcription.liveCaptionsEnabled
            ? `On — transcribing speakers locally (${engine.transcription.activeModel.label})`
            : `Off — transcribe speakers locally on-device (${engine.transcription.activeModel.label})`,
          keywords: 'toggle live call captions cc subtitles transcribe transcript moonshine speech',
          badge: engine.transcription.liveCaptionsEnabled ? 'ON' : 'CC',
          icon: <Captions size={15} />,
          run: () => {
            engine.transcription.toggleLiveCaptions()
            onClose()
          },
        },
        {
          id: 'act-call-leave',
          group: 'Actions',
          title: 'Leave Active Call',
          subtitle: `Disconnect from ${activeCall.title}`,
          keywords: 'leave hang up hangup end disconnect call voice video',
          icon: <PhoneOff size={15} style={{ color: 'var(--status-danger)' }} />,
          run: () => {
            engine.calls.leaveCall()
            onClose()
          },
        }
      )
    } else if (engine.activeView.type === 'server' && engine.servers.activeServer) {
      const srv = engine.servers.activeServer
      const count = engine.calls.getServerCallCount(srv.id)
      list.push({
        id: 'act-call-join-server',
        group: 'Actions',
        title: 'Join Voice Lounge',
        subtitle: `${srv.name} (${count}/${engine.calls.maxParticipants})`,
        keywords: 'join group server voice video call lounge webrtc p2p talk',
        badge: `${count}/${engine.calls.maxParticipants}`,
        icon: <Phone size={15} />,
        run: () => {
          onClose()
          void engine.calls.joinServerCall(srv.id, 'audio')
        },
      })
    } else if (engine.activeView.type === 'dm' && engine.activeDmThread) {
      const dm = engine.activeDmThread
      const trusted = engine.isExplicitlyTrusted(dm.peerPubkey)
      list.push({
        id: 'act-call-start-dm',
        group: 'Actions',
        title: `Voice Call ${dm.peerNickname}`,
        subtitle: trusted
          ? 'Start an end-to-end encrypted P2P call'
          : `Trust ${dm.peerDisplayHandle} first in Chat Info to unlock calls`,
        keywords: 'start dm voice video call phone webrtc p2p talk',
        badge: 'E2EE',
        icon: <Phone size={15} />,
        run: () => {
          onClose()
          if (!trusted) {
            engine.pushToast(
              'warning',
              `Trust ${dm.peerDisplayHandle} first`,
              'Open Chat Info and trust this person to unlock direct calls.'
            )
            return
          }
          void engine.calls.startDmCall(dm.peerPubkey, 'audio', dm.peerNickname)
        },
      })
    } else if (engine.activeView.type === 'channel') {
      const gh = engine.activeGeohash
      const isTopic = isTopicChannel(gh)
      const radioLabel = formatRadioChannelLabel(gh)
      const radioKindLabel = isTopic ? 'Topic Radio' : 'Geo Radio'
      const count = engine.calls.getGeoCallCount(gh)
      const isFull = count >= engine.calls.maxParticipants
      list.push(
        {
          id: 'act-call-join-geo-voice',
          group: 'Actions',
          title:
            count > 0 ? `Join ${radioKindLabel} Voice Call` : `Start ${radioKindLabel} Voice Call`,
          subtitle: isFull
            ? `${radioLabel} call is full (${count}/${engine.calls.maxParticipants})`
            : `${radioLabel} · P2P group audio (${count}/${engine.calls.maxParticipants})`,
          keywords: `start join geo topic radio voice call audio ${radioLabel} ${gh} webrtc p2p talk`,
          badge: `${count}/${engine.calls.maxParticipants}`,
          icon: <Phone size={15} />,
          run: () => {
            onClose()
            if (isFull) {
              engine.pushToast(
                'warning',
                `${radioKindLabel} call full (${engine.calls.maxParticipants}/${engine.calls.maxParticipants})`
              )
              return
            }
            void engine.calls.joinGeoCall(gh, 'audio')
          },
        },
        {
          id: 'act-call-join-geo-video',
          group: 'Actions',
          title:
            count > 0 ? `Join ${radioKindLabel} Video Call` : `Start ${radioKindLabel} Video Call`,
          subtitle: isFull
            ? `${radioLabel} call is full (${count}/${engine.calls.maxParticipants})`
            : `${radioLabel} · P2P group video (${count}/${engine.calls.maxParticipants})`,
          keywords: `start join geo topic radio video call camera ${radioLabel} ${gh} webrtc p2p`,
          badge: `${count}/${engine.calls.maxParticipants}`,
          icon: <Video size={15} />,
          run: () => {
            onClose()
            if (isFull) {
              engine.pushToast(
                'warning',
                `${radioKindLabel} call full (${engine.calls.maxParticipants}/${engine.calls.maxParticipants})`
              )
              return
            }
            void engine.calls.joinGeoCall(gh, 'video')
          },
        }
      )
    }

    list.push(
      ...(onShowQr
        ? [
            {
              id: 'act-share-dm-qr',
              group: 'Actions',
              title: 'Share My DM Link & QR Code',
              subtitle: 'Show a scannable QR code and shareable link for direct messages',
              keywords: 'share my dm link qr code npub contact invite profile',
              badge: 'DM',
              icon: <QrCode size={15} style={{ color: 'var(--dm-accent)' }} />,
              run: () => {
                onClose()
                onShowQr({
                  kind: 'dm',
                  title: 'My DM QR Code',
                  subtitle: engine.identity.nickname || 'Scan to start an encrypted DM',
                  url: buildDmShareUrl(engine.identity.masterPubkey, engine.identity.nickname),
                  codeLabel: 'Public Key (npub)',
                  codeValue: engine.identity.masterNpub,
                })
              },
            },
          ]
        : []),
      {
        id: 'act-copy-dm-link',
        group: 'Actions',
        title: 'Copy My DM Link',
        subtitle: 'Copy your direct message invite link (#dm=npub1…) to clipboard',
        keywords: 'copy my dm link url share npub direct message',
        icon: <Link2 size={15} style={{ color: 'var(--dm-accent)' }} />,
        run: () => {
          const url = buildDmShareUrl(engine.identity.masterPubkey, engine.identity.nickname)
          onClose()
          navigator.clipboard
            ?.writeText(url)
            .then(() => {
              engine.pushToast('success', 'DM link copied', 'Anyone with this link can DM you directly.')
            })
            .catch(() => {
              engine.pushToast('error', 'Could not copy DM link')
            })
        },
      },
      ...(onOpenScanner
        ? [
            {
              id: 'act-scan-qr',
              group: 'Actions',
              title: 'Scan QR Code (DM or Community)',
              subtitle: 'Scan a QR code with your camera or pick a screenshot image',
              keywords: 'scan qr code camera dm community server invite join',
              icon: <ScanLine size={15} />,
              run: () => {
                onClose()
                onOpenScanner()
              },
            },
          ]
        : []),
      {
        id: 'act-expand-radar',
        group: 'Actions',
        title: 'Open Full Map',
        subtitle: 'Interactive zoomable geohash map & live rooms',
        keywords: 'map radar fullscreen zoom geohash world explore',
        icon: <MapIcon size={15} />,
        run: () => {
          onClose()
          onExpandRadar()
        },
      },
      {
        id: 'act-room-info',
        group: 'Actions',
        title: 'Chat Info & People',
        subtitle: 'View room details, people online, and precision zoom',
        keywords: 'info people peers members room details precision zoom',
        icon: <Info size={15} />,
        run: () => {
          onClose()
          onOpenRoomInfo()
        },
      },
      {
        id: 'act-gps',
        group: 'Actions',
        title: 'Locate Me (GPS)',
        subtitle: 'Join the local geohash room for your area',
        keywords: 'gps location locate nearby physical local',
        icon: <Crosshair size={15} />,
        run: () => {
          onClose()
          onLocateMe()
        },
      },
      {
        id: 'act-create-join-server',
        group: 'Actions',
        title: 'New or Join Group',
        subtitle: 'Create a private encrypted group or join with an invite link',
        keywords: 'create join group server new invite e2ee private public',
        icon: <Plus size={15} />,
        run: () => {
          onClose()
          onOpenServerHub?.('create')
        },
      },
      {
        id: 'act-browse-nip29',
        group: 'Actions',
        title: 'Browse Groups',
        subtitle: 'Explore public relay groups',
        keywords: 'browse explore nip29 communities groups relays servers',
        icon: <Server size={15} />,
        run: () => {
          onClose()
          onOpenServerHub?.('explore')
        },
      },
      {
        id: 'act-auto-transcribe',
        group: 'Actions',
        title: 'Toggle Automatic Transcription',
        subtitle: engine.transcription.autoTranscribe
          ? `On — auto-transcribing trusted voice memos & call captions (${engine.transcription.activeModel.label})`
          : 'Off — click Transcribe or CC manually when needed',
        keywords: 'auto automatic transcription captions voice memo moonshine parakeet speech toggle',
        badge: engine.transcription.autoTranscribe ? 'ON' : 'OFF',
        icon: <Captions size={15} />,
        run: () => {
          engine.transcription.setAutoTranscribe(!engine.transcription.autoTranscribe)
          onClose()
        },
      },
      {
        id: 'act-trusted-only',
        group: 'Actions',
        title: 'Toggle Trusted Peers Only',
        subtitle: engine.strictWhitelistMode
          ? 'On — hiding text from untrusted peers'
          : 'Off — showing all text (media & calls always require Trust)',
        keywords: 'trust trusted peers only strict whitelist safety filter',
        badge: engine.strictWhitelistMode ? 'ON' : 'OFF',
        icon: <Shield size={15} />,
        run: () => {
          engine.setStrictWhitelistMode(!engine.strictWhitelistMode)
          onClose()
        },
      },
      {
        id: 'act-notif-quick',
        group: 'Actions',
        title:
          engine.notifications.permission === 'granted'
            ? 'Send Test Notification'
            : 'Enable Notifications',
        subtitle:
          engine.notifications.permission === 'granted'
            ? 'Send a live test push alert to this device'
            : engine.notifications.isIosRequiresInstall
              ? 'Add Agnostr to your Home Screen first to enable iOS push alerts'
              : 'Allow push notifications for DMs, groups, rooms, and calls',
        keywords: 'notifications push alerts enable test permission bell',
        badge:
          engine.notifications.permission === 'granted'
            ? 'READY'
            : engine.notifications.permission === 'denied'
              ? 'OFF'
              : undefined,
        icon: <Bell size={15} />,
        run: () => {
          onClose()
          if (engine.notifications.permission === 'granted') {
            void engine.notifications.sendTestNotification()
          } else if (engine.notifications.isIosRequiresInstall && onOpenInstall) {
            onOpenInstall()
          } else {
            void engine.notifications.requestPermission()
          }
        },
      },
      {
        id: 'act-test-ringtone',
        group: 'Actions',
        title: 'Test Call Ringtone',
        subtitle: 'Preview the incoming DM call ringtone and vibration',
        keywords: 'test call ringtone ring sound vibrate phone dm audio',
        icon: <BellRing size={15} />,
        run: () => {
          onClose()
          engine.notifications.testRingtone()
        },
      },
      ...(onOpenAmail
        ? [
            {
              id: 'act-amail-inbox',
              group: 'Agmail',
              title: 'Open Agmail',
              subtitle:
                engine.amail.unreadInboxCount > 0
                  ? `${engine.amail.unreadInboxCount} unread · ${engine.amail.meshPeers.filter((p) => p.state === 'connected').length} mesh connected`
                  : `Encrypted mesh mail · ${engine.amail.contacts.length} ${engine.amail.contacts.length === 1 ? 'contact' : 'contacts'}`,
              keywords: 'open agmail amail inbox email snailmail mail encrypted mesh messages',
              badge:
                engine.amail.unreadInboxCount > 0
                  ? `${engine.amail.unreadInboxCount} UNREAD`
                  : 'MAIL',
              icon: <Mail size={15} style={{ color: 'var(--accent)' }} />,
              run: () => {
                onClose()
                onOpenAmail('inbox')
              },
            },
            {
              id: 'act-amail-compose',
              group: 'Agmail',
              title: 'Compose Agmail',
              subtitle: 'Write an encrypted message',
              keywords: 'compose write new send agmail amail email mail markdown mathjax mesh',
              badge: 'MAIL',
              icon: <PenLine size={15} style={{ color: 'var(--accent)' }} />,
              run: () => {
                onClose()
                onOpenAmail('compose')
              },
            },
            {
              id: 'act-amail-mesh',
              group: 'Agmail',
              title: 'Agmail Mesh & Storage',
              subtitle: `Vault ${Math.max(0, Math.round(engine.amail.storageStats.vaultBytes / 1024)).toLocaleString()} KB · ${engine.amail.storageStats.vaultCapsuleCount} ${engine.amail.storageStats.vaultCapsuleCount === 1 ? 'parcel' : 'parcels'}`,
              keywords: 'agmail amail mesh relay storage vault capsules quota inspector telemetry',
              badge: engine.amail.settings.relayEnabled ? 'RELAY ON' : 'RELAY OFF',
              icon: <Database size={15} style={{ color: 'var(--accent)' }} />,
              run: () => {
                onClose()
                onOpenAmail('mesh')
              },
            },
          ]
        : []),
      {
        id: 'act-device-sync-now',
        group: 'Actions',
        title: 'Sync Linked Devices Now',
        subtitle:
          engine.deviceSync.onlineSiblingCount > 0
            ? `${engine.deviceSync.onlineSiblingCount} ${engine.deviceSync.onlineSiblingCount === 1 ? 'device' : 'devices'} online · Encrypted sync`
            : engine.deviceSync.enabled
              ? `Background sync active (${engine.deviceSync.deviceLabel})`
              : 'Sync paused — enable and sync now',
        keywords: 'sync linked devices multi device multi-device background crdt groups servers messages nip44',
        badge:
          engine.deviceSync.onlineSiblingCount > 0
            ? `${engine.deviceSync.onlineSiblingCount} ONLINE`
            : engine.deviceSync.enabled
              ? 'SYNC'
              : 'OFF',
        icon: <RefreshCw size={15} style={{ color: 'var(--accent)' }} />,
        run: () => {
          onClose()
          if (!engine.deviceSync.enabled) {
            engine.deviceSync.setEnabled(true)
          }
          void engine.deviceSync.syncNow().then(() => {
            engine.pushToast(
              'info',
              'Linked devices sync triggered',
              engine.deviceSync.onlineSiblingCount > 0
                ? `Exchanging encrypted updates with ${engine.deviceSync.onlineSiblingCount} online sibling ${engine.deviceSync.onlineSiblingCount === 1 ? 'device' : 'devices'}.`
                : 'Published encrypted checkpoint for other devices using your key.'
            )
          })
        },
      },
      ...(onOpenWallet
        ? [
            {
              id: 'act-wallet-open',
              group: 'Agwallet & Zaps',
              title: 'Open Agwallet',
              subtitle: `${engine.wallet.totalBalanceSats.toLocaleString()} sats across ${engine.wallet.mints.length} ${engine.wallet.mints.length === 1 ? 'mint' : 'mints'}`,
              keywords: 'open agwallet cashu ecash wallet bitcoin sats lightning mint boltz balance zap',
              badge: `${engine.wallet.totalBalanceSats.toLocaleString()} sats`,
              icon: <Wallet size={15} style={{ color: 'var(--status-warn)' }} />,
              run: () => {
                onClose()
                onOpenWallet({ tab: 'overview' })
              },
            },
            {
              id: 'act-wallet-receive',
              group: 'Agwallet & Zaps',
              title: 'Receive in Agwallet (Cashu / Lightning / On-Chain)',
              subtitle: 'Claim Cashu token, generate Lightning invoice, or swap On-Chain BTC via Boltz',
              keywords: 'receive sats deposit agwallet wallet cashu ecash token lightning invoice onchain btc bitcoin boltz swap',
              badge: 'RECEIVE',
              icon: <ArrowDownLeft size={15} style={{ color: 'var(--status-warn)' }} />,
              run: () => {
                onClose()
                onOpenWallet({ tab: 'receive' })
              },
            },
            {
              id: 'act-wallet-send',
              group: 'Agwallet & Zaps',
              title: 'Send from Agwallet',
              subtitle: 'Mint Cashu ecash token, pay Lightning invoice/address, or send On-Chain BTC',
              keywords: 'send sats pay agwallet wallet cashu ecash token lightning invoice address onchain btc bitcoin boltz',
              badge: 'SEND',
              icon: <ArrowUpRight size={15} style={{ color: 'var(--status-warn)' }} />,
              run: () => {
                onClose()
                onOpenWallet({ tab: 'send' })
              },
            },
          ]
        : []),
      {
        id: 'act-translator-toggle',
        group: 'Actions',
        title: engine.translator.settings.enabled
          ? 'Exit Double-Column Translator'
          : 'Open Double-Column Translator',
        subtitle: `On-device ${engine.translator.modelLabel} · Reading in ${engine.translator.settings.myLanguage}`,
        keywords: 'translate translator language double column m2m100 nllb200 bilingual spanish french japanese',
        badge: engine.translator.settings.enabled ? 'ON' : 'OFF',
        icon: <Languages size={15} />,
        run: () => {
          engine.translator.updateSettings({ enabled: !engine.translator.settings.enabled })
          onClose()
        },
      },
      {
        id: 'act-settings-content-filter',
        group: 'Settings',
        title: 'Image Safety Filter Settings',
        subtitle: `${engine.contentFilter.modelLabel} · Images: ${engine.contentFilter.settings.mediaScope}`,
        keywords: 'content filter settings image safety classifier nsfw nsfl illegal gore media ai',
        badge: engine.contentFilter.settings.enabled ? 'ON' : 'OFF',
        icon: <ShieldAlert size={15} />,
        run: () => {
          onClose()
          onOpenSettings('content-filter')
        },
      },
      {
        id: 'act-settings-translator',
        group: 'Settings',
        title: 'Translator Settings',
        subtitle: `${engine.translator.modelLabel} · My language: ${engine.translator.settings.myLanguage}${engine.translator.settings.outgoingEnabled ? ` · Outgoing → ${engine.translator.settings.outgoingLanguage}` : ''}`,
        keywords: 'translator translation settings language m2m100 nllb200 model cache outgoing',
        icon: <Languages size={15} />,
        run: () => {
          onClose()
          onOpenSettings('translator')
        },
      },
      {
        id: 'act-settings-notifications',
        group: 'Settings',
        title: 'Notification Settings',
        subtitle:
          engine.notifications.permission === 'granted' && engine.notifications.settings.enabled
            ? 'Push alerts ON · DMs, DM call ringing, groups & Geo Radio'
            : 'Configure push alerts, DM call ringing & optional Web Push bridge',
        keywords: 'notifications settings push alerts ringtone call ringing vapid bridge bell',
        badge:
          engine.notifications.permission === 'granted' && engine.notifications.settings.enabled
            ? 'ON'
            : 'OFF',
        icon: <Bell size={15} />,
        run: () => {
          onClose()
          onOpenSettings('notifications')
        },
      },
      {
        id: 'act-settings-privacy',
        group: 'Settings',
        title: 'Privacy & Trust Settings',
        subtitle: `${engine.trustedPubkeys.length} trusted ${engine.trustedPubkeys.length === 1 ? 'peer' : 'peers'} · manage trust & blocked users`,
        keywords: 'trusted peers privacy safety settings whitelist blocked',
        icon: <ShieldCheck size={15} />,
        run: () => {
          onClose()
          onOpenSettings('privacy')
        },
      },
      {
        id: 'act-settings-profile',
        group: 'Settings',
        title: 'Profile & Identity Settings',
        subtitle: 'Nickname, keys, signer mode, and per-room privacy keys',
        keywords: 'profile identity key nsec npub nip07 settings account',
        icon: <Key size={15} />,
        run: () => {
          onClose()
          onOpenSettings('profile')
        },
      },
      {
        id: 'act-settings-calls',
        group: 'Settings',
        title: 'Calls, Recording & Transcription Settings',
        subtitle: `Recording quality, TURN server & local ${engine.transcription.activeModel.label} transcription`,
        keywords: 'calls recording quality video audio turn transcription captions moonshine model settings',
        icon: <Settings size={15} />,
        run: () => {
          onClose()
          onOpenSettings('calls')
        },
      },
      {
        id: 'act-settings-network',
        group: 'Settings',
        title: 'Network, Relays & Panic Wipe',
        subtitle: `${engine.connectedRelayCount}/${engine.totalRelayCount} relays connected · Blossom servers · Panic Wipe`,
        keywords: 'relays network blossom servers panic wipe burn app pwa',
        icon: <Wifi size={15} />,
        run: () => {
          onClose()
          onOpenSettings('network')
        },
      },
      {
        id: 'act-sound',
        group: 'Actions',
        title: engine.settings.soundEnabled ? 'Mute Sound Effects' : 'Enable Sound Effects',
        subtitle: 'Toggle subtle message and call notification sounds',
        keywords: 'sound audio sfx mute notifications',
        icon: <Volume2 size={15} />,
        run: () => {
          onToggleSound()
          onClose()
        },
      },
      {
        id: 'act-rotate',
        group: 'Actions',
        title: 'Rotate Identity',
        subtitle: 'Generate a fresh anonymous keypair right now',
        keywords: 'rotate identity fresh new key anon',
        icon: <RotateCw size={15} />,
        run: () => {
          engine.rotateIdentity()
          onClose()
        },
      },
      {
        id: 'act-export-md',
        group: 'Actions',
        title: 'Export Chat (Markdown)',
        subtitle: 'Download current conversation as .md',
        keywords: 'export download transcript markdown backup',
        icon: <Download size={15} />,
        run: () => {
          onExport('md')
          onClose()
        },
      },
      {
        id: 'act-export-json',
        group: 'Actions',
        title: 'Export Chat (JSON)',
        subtitle: 'Download current conversation as .json',
        keywords: 'export download transcript json',
        icon: <Download size={15} />,
        run: () => {
          onExport('json')
          onClose()
        },
      }
    )

    // PWA Install & Update Actions
    if (pwa && !pwa.isInstalled && onOpenInstall) {
      list.push({
        id: 'act-pwa-install',
        group: 'App',
        title: 'Install Agnostr App',
        subtitle: 'Add to your home screen or dock for standalone mode',
        keywords: 'install pwa app home screen standalone offline',
        icon: <Download size={15} />,
        run: () => {
          onClose()
          onOpenInstall()
        },
      })
    }

    if (pwa) {
      list.push({
        id: 'act-pwa-check-update',
        group: 'App',
        title: pwa.updateAvailable ? 'Reload to Update App' : 'Check for Updates',
        subtitle: pwa.updateAvailable
          ? 'A newer version of Agnostr is ready'
          : 'Check for the latest version',
        keywords: 'check update updates refresh reload pwa version',
        badge: pwa.updateAvailable ? 'READY' : undefined,
        icon: <RefreshCw size={15} />,
        run: () => {
          onClose()
          if (pwa.updateAvailable) {
            void pwa.applyUpdate()
          } else {
            void pwa.checkForUpdates().then((found) => {
              engine.pushToast(
                found ? 'success' : 'info',
                found ? 'Update ready' : 'Agnostr is up to date',
                found
                  ? 'Tap Reload in the banner to switch to the new version.'
                  : 'You are on the latest version.'
              )
            })
          }
        },
      })
    }

    // Themes
    for (const theme of THEMES) {
      list.push({
        id: `theme-${theme.id}`,
        group: 'Appearance',
        title: theme.name,
        subtitle: theme.desc,
        keywords: `theme color appearance ${theme.id} ${theme.name}`,
        badge: engine.settings.theme === theme.id ? 'ACTIVE' : undefined,
        icon: <Palette size={15} />,
        run: () => {
          engine.setTheme(theme.id)
          onClose()
        },
      })
    }

    // Slash commands
    for (const cmd of engine.commands) {
      list.push({
        id: `cmd-${cmd.name}`,
        group: 'Slash Commands',
        title: `/${cmd.name}`,
        subtitle: `${cmd.usage} — ${cmd.description}`,
        keywords: `command slash /${cmd.name} ${cmd.aliases.join(' ')} ${cmd.description}`,
        icon: <Terminal size={15} />,
        run: () => {
          onRunCommand(`/${cmd.name}`)
          onClose()
        },
      })
    }

    if (!q) return list
    return list.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q) ||
        item.keywords.toLowerCase().includes(q)
    )
  }, [
    query,
    engine,
    onTuneChannel,
    onOpenDm,
    onSelectServerChannel,
    onOpenServerHub,
    onExpandRadar,
    onClose,
    onLocateMe,
    onOpenRoomInfo,
    onOpenSettings,
    onOpenAmail,
    onOpenWallet,
    onToggleSound,
    onExport,
    onRunCommand,
    onShowQr,
    onOpenScanner,
    onResolvedShareTarget,
    pwa,
    onOpenInstall,
  ])

  useEffect(() => {
    setSelectedIdx(0)
  }, [query])

  if (!open) return null

  const clampedIdx = Math.min(selectedIdx, Math.max(0, entries.length - 1))

  const groupedSections: Array<{
    group: string
    items: Array<{ entry: PaletteEntry; flatIdx: number }>
  }> = []
  entries.forEach((entry, flatIdx) => {
    let sec = groupedSections.find((g) => g.group === entry.group)
    if (!sec) {
      sec = { group: entry.group, items: [] }
      groupedSections.push(sec)
    }
    sec.items.push({ entry, flatIdx })
  })

  return (
    <div
      className="ag-modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Quick Switcher"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="ag-cmdk-modal">
        <div className="ag-cmdk-input-bar">
          <Search size={17} />
          <input
            ref={inputRef}
            type="text"
            className="ag-cmdk-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelectedIdx((i) => (entries.length ? (i + 1) % entries.length : 0))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelectedIdx((i) =>
                  entries.length ? (i - 1 + entries.length) % entries.length : 0
                )
              } else if (e.key === 'Enter') {
                e.preventDefault()
                entries[clampedIdx]?.run()
              }
            }}
            placeholder="Search rooms, groups, #geohash, #topic, or actions…"
          />
          <kbd className="ag-kbd">ESC</kbd>
        </div>

        <div className="ag-cmdk-list">
          {entries.length === 0 ? (
            <div className="ag-conv-empty" style={{ padding: '1.5rem' }}>
              <p>
                No matches. Type any geohash (<code>9q8y</code>) or topic (<code>#bitcoin</code>, <code>topic:tech</code>) to jump right in.
              </p>
            </div>
          ) : (
            groupedSections.map((section) => (
              <div key={section.group}>
                <div className="ag-cmdk-group-label">{section.group}</div>
                {section.items.map(({ entry, flatIdx }) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`ag-cmdk-row ${flatIdx === clampedIdx ? 'selected' : ''}`}
                    onMouseEnter={() => setSelectedIdx(flatIdx)}
                    onClick={entry.run}
                  >
                    <div className="ag-cmdk-row-left">
                      <span className="ag-cmdk-row-icon">{entry.icon}</span>
                      <div className="ag-cmdk-row-text">
                        <span className="ag-cmdk-row-title">{entry.title}</span>
                        <span className="ag-cmdk-row-sub">{entry.subtitle}</span>
                      </div>
                    </div>
                    {entry.badge && (
                      <span
                        className={`ag-badge ${
                          entry.badge === 'LIVE' || entry.badge === 'ON' || entry.badge === 'READY'
                            ? 'ok'
                            : entry.badge === 'REC'
                              ? 'danger'
                              : entry.badge === 'OFF'
                                ? 'muted'
                                : entry.badge === 'PRIVATE'
                                  ? 'dm'
                                  : entry.badge === 'HOSTED'
                                    ? 'mesh'
                                    : 'accent'
                        }`}
                      >
                        {entry.badge}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="ag-cmdk-footer">
          <span>↑↓ Navigate · ↵ Open</span>
          <span>⌘K Search · ⌘F Find · ⌘I Info · ⌘, Settings</span>
        </div>
      </div>
    </div>
  )
}

export default CommandPalette
