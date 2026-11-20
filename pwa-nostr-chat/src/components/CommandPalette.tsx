import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Compass,
  Crosshair,
  Download,
  Globe,
  Hash,
  Key,
  Palette,
  Radio,
  RotateCw,
  Search,
  StickyNote,
  Terminal,
  Users,
  Volume2,
  Wifi,
} from 'lucide-react'
import type { AgnostrEngine, InspectorTab, ThemeId } from '../types/protocol'

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
  onLocateMe: () => void
  onOpenInspectorTab: (tab: InspectorTab) => void
  onToggleSound: () => void
  onRunCommand: (cmdLine: string) => void
  onExport: (format: 'markdown' | 'json') => void
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  engine,
  onClose,
  onTuneChannel,
  onLocateMe,
  onOpenInspectorTab,
  onToggleSound,
  onRunCommand,
  onExport,
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
    list.push(
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
    onClose,
    onLocateMe,
    onOpenInspectorTab,
    onToggleSound,
    onExport,
    onRunCommand,
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
            placeholder="Jump to #geohash, city, command, theme, or action…"
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
                        className={`ag-badge ${entry.badge === 'LIVE' ? 'ok' : 'accent'}`}
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
