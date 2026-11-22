import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Circle,
  Compass,
  Crosshair,
  Download,
  Globe,
  Hash,
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
  Shield,
  ShieldCheck,
  Square,
  StickyNote,
  Terminal,
  Users,
  Volume2,
  Wifi,
} from 'lucide-react'
import type { AgnostrEngine, InspectorTab, ThemeId } from '../types/protocol'
import type { PwaState } from '../hooks/usePwa'
import type { ServerHubTab } from './ServerHubModal'

const GEOHASH_REGEX = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/i

const THEMES: Array<{ id: ThemeId; name: string; desc: string }> = [
  { id: 'phosphor', name: 'Bitchat Phosphor', desc: 'Deep obsidian pine & emerald radio signal' },
  { id: 'amber', name: 'Shortwave Amber', desc: 'Vintage Nixie amber field transceiver' },
  { id: 'obsidian', name: 'Midnight Obsidian', desc: 'Nocturnal indigo-cobalt precision dark' },
  { id: 'daylight', name: 'Daylight Field', desc: 'High-contrast Swiss topo daylight clarity' },
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
  onExpandRadar?: () => void
  onLocateMe: () => void
  onOpenInspectorTab: (tab: InspectorTab) => void
  onToggleSound: () => void
  onRunCommand: (cmdLine: string) => void
  onExport: (format: 'markdown' | 'json') => void
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
  onOpenInspectorTab,
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

    // Direct tune option whenever query looks like a valid geohash
    if (cleanHash.length >= 1 && GEOHASH_REGEX.test(cleanHash)) {
      list.push({
        id: `direct-${cleanHash}`,
        group: 'Tune Frequency',
        title: `Tune to #${cleanHash}`,
        subtitle: `Jump directly into geohash channel #${cleanHash}`,
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
                ? 'E2EE Private Server (AES-256-GCM)'
                : 'Public Virtual Server'),
          keywords: `server channel ${srv.name} ${chan.name} #${chan.name} ${srv.kind} ${srv.encrypted ? 'e2ee encrypted private' : 'public'}`,
          badge: srv.kind === 'nip29' ? 'NIP-29' : srv.encrypted ? 'E2EE' : 'SERVER',
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

    // Live Global Pulse Rooms
    for (const room of engine.pulseRooms.slice(0, 8)) {
      list.push({
        id: `pulse-${room.geohash}`,
        group: 'Live Global Pulse',
        title: `#${room.geohash}${room.nearestCity ? ` · ${room.nearestCity}` : ''}`,
        subtitle: `${room.peerCount} ${room.peerCount === 1 ? 'peer' : 'peers'} · ${room.messageCount} ${room.messageCount === 1 ? 'msg' : 'msgs'}${room.lastPreview ? ` · ${room.lastPreview}` : ''}`,
        keywords: `pulse live ${room.geohash} ${room.nearestCity ?? ''}`,
        badge: 'LIVE',
        icon: <Radio size={15} style={{ color: 'var(--status-ok)' }} />,
        run: () => {
          onTuneChannel(room.geohash)
          onClose()
        },
      })
    }

    // Quick Cities
    for (const city of engine.quickCities) {
      list.push({
        id: `city-${city.geohash}`,
        group: 'Quick Frequencies',
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

    // Tactical Actions
    if (engine.calls.activeCall) {
      const activeCall = engine.calls.activeCall
      list.push(
        {
          id: 'act-call-mute',
          group: 'Actions',
          title: 'Toggle Call Mute',
          subtitle: activeCall.localMuted
            ? `Currently muted in ${activeCall.title} — click to unmute`
            : `Mic live in ${activeCall.title} — click to mute`,
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
                  : 'Record call audio/video locally (shows live red dot to all participants)',
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
          id: 'act-call-leave',
          group: 'Actions',
          title: 'Leave Active Call',
          subtitle: `Hang up and disconnect from ${activeCall.title}`,
          keywords: 'leave hang up hangup end disconnect call voice video',
          badge: 'CALL',
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
        title: 'Join Server Voice Call',
        subtitle: `Join P2P Voice & Video Lounge in ${srv.name} (${count}/${engine.calls.maxParticipants})`,
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
        title: 'Start DM Voice Call',
        subtitle: trusted
          ? `Call ${dm.peerDisplayHandle} via E2EE P2P WebRTC`
          : `Trust ${dm.peerDisplayHandle} first (P2P calls share IP addresses)`,
        keywords: 'start dm voice video call phone webrtc p2p talk',
        badge: 'E2EE',
        icon: <Phone size={15} />,
        run: () => {
          onClose()
          if (!trusted) {
            engine.pushToast(
              'warning',
              `Trust ${dm.peerDisplayHandle} first`,
              'P2P WebRTC calls share IP addresses directly. Trust this peer in Inspect to unlock calls.'
            )
            return
          }
          void engine.calls.startDmCall(dm.peerPubkey, 'audio', dm.peerNickname)
        },
      })
    }

    list.push(
      {
        id: 'act-create-join-server',
        group: 'Actions',
        title: 'Create / Join Server',
        subtitle: 'Launch an Instant Public or E2EE Private server, or join via invite link',
        keywords: 'create join server new invite discord room e2ee private public',
        icon: <Plus size={15} />,
        run: () => {
          onClose()
          onOpenServerHub?.('create')
        },
      },
      {
        id: 'act-browse-nip29',
        group: 'Actions',
        title: 'Browse NIP-29 Communities',
        subtitle: 'Explore live relay-moderated NIP-29 communities & public groups',
        keywords: 'browse explore nip29 nip-29 communities groups relays servers',
        icon: <Server size={15} />,
        run: () => {
          onClose()
          onOpenServerHub?.('explore')
        },
      },
      {
        id: 'act-gps',
        group: 'Actions',
        title: 'GPS Locate Me',
        subtitle: 'Lock onto your physical geohash cell (local mode)',
        keywords: 'gps location locate nearby physical local',
        icon: <Crosshair size={15} />,
        run: () => {
          onClose()
          onLocateMe()
        },
      },
      {
        id: 'act-expand-radar',
        group: 'Actions',
        title: 'Open Full-Screen Geohash Radar',
        subtitle: 'Interactive zoomable Leaflet map with live geohash zone grids & 32× sub-zones',
        keywords: 'radar map fullscreen full-screen zoom geohash grid world explore expand',
        badge: 'MAP',
        icon: <MapIcon size={15} />,
        run: () => {
          onClose()
          if (onExpandRadar) {
            onExpandRadar()
          } else {
            onOpenInspectorTab('radar')
          }
        },
      },
      {
        id: 'act-radar',
        group: 'Actions',
        title: 'Open World Geo Radar & Neighbor Compass',
        subtitle: 'Interactive vector world map & 3×3 adjacent cell navigator',
        keywords: 'map radar world neighbors compass geo',
        icon: <Compass size={15} />,
        run: () => {
          onOpenInspectorTab('radar')
          onClose()
        },
      },
      {
        id: 'act-peers',
        group: 'Actions',
        title: 'View Active Peers',
        subtitle: `Inspect peers active in #${engine.activeGeohash}`,
        keywords: 'peers users online who roster',
        icon: <Users size={15} />,
        run: () => {
          onOpenInspectorTab('peers')
          onClose()
        },
      },
      {
        id: 'act-notes',
        group: 'Actions',
        title: 'View 24h Location Dead-Drop Notes',
        subtitle: 'Read or drop persistent 24h notes pinned to this geohash',
        keywords: 'notes drop dead-drop pin 24h',
        icon: <StickyNote size={15} />,
        run: () => {
          onOpenInspectorTab('notes')
          onClose()
        },
      },
      {
        id: 'act-relays',
        group: 'Actions',
        title: 'Open Relay Telemetry',
        subtitle: `${engine.connectedRelayCount}/${engine.totalRelayCount} relays online · latency sparklines`,
        keywords: 'relays network websocket telemetry latency',
        icon: <Wifi size={15} />,
        run: () => {
          onOpenInspectorTab('relays')
          onClose()
        },
      },
      {
        id: 'act-sound',
        group: 'Actions',
        title: engine.settings.soundEnabled ? 'Mute Radio Audio SFX' : 'Enable Radio Audio SFX',
        subtitle: 'Toggle Web Audio synthesized sonar & transceiver cues',
        keywords: 'sound audio sfx mute sonar radio',
        icon: <Volume2 size={15} />,
        run: () => {
          onToggleSound()
          onClose()
        },
      },
      {
        id: 'act-trusted-only',
        group: 'Actions',
        title: 'Toggle Trusted Peers Only',
        subtitle: engine.strictWhitelistMode
          ? 'Currently ON — hiding text from untrusted peers (click to show all text)'
          : 'Currently OFF — show all text (voice memos still require trusting sender)',
        keywords: 'trust trusted peers only strict whitelist safety filter hide untrusted',
        badge: engine.strictWhitelistMode ? 'ON' : 'OFF',
        icon: <Shield size={15} />,
        run: () => {
          engine.setStrictWhitelistMode(!engine.strictWhitelistMode)
          onClose()
        },
      },
      {
        id: 'act-trusted-safety',
        group: 'Actions',
        title: 'Trusted Peers & Safety Settings',
        subtitle: `${engine.trustedPubkeys.length} trusted ${engine.trustedPubkeys.length === 1 ? 'peer' : 'peers'} · manage trust list & Blossom voice servers`,
        keywords: 'trusted peers safety settings whitelist media voice blossom servers security',
        icon: <ShieldCheck size={15} />,
        run: () => {
          onOpenInspectorTab('identity')
          onClose()
        },
      },
      {
        id: 'act-identity',
        group: 'Actions',
        title: 'Identity Studio & Panic Wipe',
        subtitle: 'Manage NIP-07, nsec, per-geohash personas, or burn keys',
        keywords: 'identity key nsec npub nip07 burn wipe panic settings',
        icon: <Key size={15} />,
        run: () => {
          onOpenInspectorTab('identity')
          onClose()
        },
      },
      {
        id: 'act-rotate',
        group: 'Actions',
        title: 'Rotate Ephemeral Identity',
        subtitle: 'Generate a fresh anonymous keypair immediately',
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
        title: 'Export Channel Transcript (Markdown)',
        subtitle: `Download #${engine.activeGeohash} log as .md`,
        keywords: 'export download transcript markdown backup',
        icon: <Download size={15} />,
        run: () => {
          onExport('markdown')
          onClose()
        },
      },
      {
        id: 'act-export-json',
        group: 'Actions',
        title: 'Export Channel Transcript (JSON)',
        subtitle: `Download #${engine.activeGeohash} raw events as .json`,
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
        group: 'Actions',
        title: 'Install Agnostr App (PWA)',
        subtitle: pwa.canPromptInstall
          ? 'Install Agnostr for full-screen standalone mode & offline cache'
          : pwa.isIosSafari
            ? 'Add to Home Screen via Safari Share menu'
            : 'Install Agnostr as a standalone desktop or mobile app',
        keywords: 'install pwa app home screen homescreen standalone offline download',
        badge: pwa.canPromptInstall ? '1-TAP' : 'PWA',
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
        group: 'Actions',
        title: pwa.updateAvailable ? 'Reload to Apply App Update' : 'Check for App Updates',
        subtitle: pwa.updateAvailable
          ? 'A newer version of Agnostr is ready — reload now'
          : 'Check Service Worker for the latest Agnostr release',
        keywords: 'check update updates refresh reload pwa service worker version',
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
                  ? 'Click Reload in the update bar to activate the new version.'
                  : 'Running the latest cached build.'
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
        group: 'Themes',
        title: `Theme: ${theme.name}`,
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
    onOpenInspectorTab,
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

  // Group entries while keeping flat index for keyboard nav
  const groupedSections: Array<{ group: string; items: Array<{ entry: PaletteEntry; flatIdx: number }> }> = []
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
      aria-label="Command Palette"
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
            placeholder="Jump to server, #channel, #geohash, city, command, or action…"
          />
          <kbd className="ag-kbd">ESC</kbd>
        </div>

        <div className="ag-cmdk-list">
          {entries.length === 0 ? (
            <div className="ag-side-empty" style={{ padding: '1.2rem', textAlign: 'center' }}>
              No matching frequencies or actions. Type any valid base32 geohash (e.g. <code>9q8y</code>) to tune directly.
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
          <span>↑↓ Navigate · ↵ Select</span>
          <span>⌘K Palette · ⌘F Search · ⌘B Sidebar · ⌘I Inspector</span>
        </div>
      </div>
    </div>
  )
}

export default CommandPalette
