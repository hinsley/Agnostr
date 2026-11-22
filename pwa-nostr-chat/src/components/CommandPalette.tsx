import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Captions,
  Circle,
  Crosshair,
  Download,
  Globe,
  Hash,
  Info,
  Key,
  Lock,
  Map as MapIcon,
  Mic,
  MicOff,
  Palette,
  Phone,
  PhoneOff,
  Plus,
  Radio,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  Settings,
  Shield,
  ShieldCheck,
  Square,
  Terminal,
  Volume2,
  Wifi,
} from 'lucide-react'
import type { AgnostrEngine, ThemeId } from '../types/protocol'
import type { PwaState } from '../hooks/usePwa'
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
  onSelectServerChannel?: (serverId: string, channelId: string) => void
  onOpenServerHub?: (initialTab?: ServerHubTab) => void
  onExpandRadar: () => void
  onLocateMe: () => void
  onOpenRoomInfo: () => void
  onOpenSettings: (tab?: SettingsTab) => void
  onToggleSound: () => void
  onRunCommand: (cmdLine: string) => void
  onExport: (format: 'md' | 'json') => void
  pwa?: PwaState
  onOpenInstall?: () => void
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  engine,
  onClose,
  onTuneChannel,
  onSelectServerChannel,
  onOpenServerHub,
  onExpandRadar,
  onLocateMe,
  onOpenRoomInfo,
  onOpenSettings,
  onToggleSound,
  onRunCommand,
  onExport,
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

    // Direct jump whenever query looks like a valid geohash
    if (cleanHash.length >= 1 && GEOHASH_REGEX.test(cleanHash)) {
      list.push({
        id: `direct-${cleanHash}`,
        group: 'Jump to Room',
        title: `Open #${cleanHash}`,
        subtitle: `Join geohash room #${cleanHash}`,
        keywords: cleanHash,
        badge: 'DIRECT',
        icon: <Hash size={15} />,
        run: () => {
          onTuneChannel(cleanHash)
          onClose()
        },
      })
    }

    // Joined Servers & Channels
    for (const srv of engine.servers.joinedServers) {
      for (const chan of srv.channels) {
        list.push({
          id: `srv-${srv.id}-${chan.id}`,
          group: 'Servers & Channels',
          title: `${srv.name} › #${chan.name}`,
          subtitle:
            chan.topic ||
            (srv.kind === 'nip29'
              ? `NIP-29 · ${srv.relayUrl?.replace(/^wss?:\/\//i, '') ?? 'relay'}`
              : srv.encrypted
                ? 'Private encrypted server'
                : 'Public server'),
          keywords: `server channel ${srv.name} ${chan.name} #${chan.name} ${srv.kind} ${srv.encrypted ? 'e2ee encrypted private' : 'public'}`,
          badge: srv.kind === 'nip29' ? 'NIP-29' : srv.encrypted ? 'E2EE' : undefined,
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

    // Live Active Rooms
    for (const room of engine.pulseRooms.slice(0, 8)) {
      list.push({
        id: `pulse-${room.geohash}`,
        group: 'Live Active Rooms',
        title: `#${room.geohash}${room.nearestCity ? ` · ${room.nearestCity}` : ''}`,
        subtitle: `${room.peerCount} ${room.peerCount === 1 ? 'person' : 'people'}${room.lastPreview ? ` · ${room.lastPreview}` : ''}`,
        keywords: `live room radio ${room.geohash} ${room.nearestCity ?? ''}`,
        badge: 'LIVE',
        icon: <Radio size={15} style={{ color: 'var(--accent)' }} />,
        run: () => {
          onTuneChannel(room.geohash)
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
        keywords: 'join server voice video call lounge webrtc p2p talk',
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
    }

    list.push(
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
        title: 'New or Join Server',
        subtitle: 'Create a private encrypted server or join with an invite link',
        keywords: 'create join server new invite e2ee private public',
        icon: <Plus size={15} />,
        run: () => {
          onClose()
          onOpenServerHub?.('create')
        },
      },
      {
        id: 'act-browse-nip29',
        group: 'Actions',
        title: 'Browse Communities',
        subtitle: 'Explore public NIP-29 relay communities',
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
    onSelectServerChannel,
    onOpenServerHub,
    onExpandRadar,
    onClose,
    onLocateMe,
    onOpenRoomInfo,
    onOpenSettings,
    onToggleSound,
    onExport,
    onRunCommand,
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
            placeholder="Search rooms, servers, #geohash, or actions…"
          />
          <kbd className="ag-kbd">ESC</kbd>
        </div>

        <div className="ag-cmdk-list">
          {entries.length === 0 ? (
            <div className="ag-conv-empty" style={{ padding: '1.5rem' }}>
              <p>
                No matches. Type any geohash (like <code>9q8y</code>) to jump right in.
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
                                : entry.badge === 'E2EE'
                                  ? 'dm'
                                  : entry.badge === 'NIP-29'
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
