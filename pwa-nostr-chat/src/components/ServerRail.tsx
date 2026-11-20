import type { CSSProperties } from 'react'
import { Lock, Plus, Radio, Server } from 'lucide-react'
import type { ServerSummary } from '../types/servers.ts'
import type { SoundCue } from '../utils/sound.ts'
import type { ServerHubTab } from './ServerHubModal.tsx'

export interface ServerRailProps {
  mode: 'channel' | 'dm' | 'server'
  activeServerId: string | null
  joinedServers: ServerSummary[]
  totalDmUnread: number
  onSelectGeoRadio: () => void
  onSelectDms: () => void
  onSelectServer: (serverId: string) => void
  onOpenHub: (initialTab?: ServerHubTab) => void
  onPlaySound?: (cue: SoundCue) => void
}

function getServerMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'SV'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase()
}

function serverKindLabel(server: ServerSummary): string {
  if (server.kind === 'nip29') return 'NIP-29 Relay Community'
  return server.encrypted ? 'E2EE Private Server' : 'Public Virtual Server'
}

export function ServerRail({
  mode,
  activeServerId,
  joinedServers,
  totalDmUnread,
  onSelectGeoRadio,
  onSelectDms,
  onSelectServer,
  onOpenHub,
  onPlaySound,
}: ServerRailProps) {
  return (
    <nav className="ag-server-rail" aria-label="Workspaces and servers">
      {/* Primary Modes: Geo Radio & Encrypted DMs */}
      <div className="ag-rail-group">
        <button
          type="button"
          className={`ag-rail-item ag-rail-geo ${mode === 'channel' ? 'active' : ''}`}
          onClick={() => {
            onPlaySound?.('click')
            onSelectGeoRadio()
          }}
          title="Geo Radio — Geohash rooms, Global Pulse & World Radar"
          aria-label="Geo Radio"
          aria-current={mode === 'channel' ? 'page' : undefined}
        >
          <span className="ag-rail-pill" aria-hidden="true" />
          <Radio size={18} />
        </button>

        <button
          type="button"
          className={`ag-rail-item ag-rail-dm ${mode === 'dm' ? 'active' : ''}`}
          onClick={() => {
            onPlaySound?.('click')
            onSelectDms()
          }}
          title="Encrypted Direct Messages"
          aria-label={
            totalDmUnread > 0
              ? `Encrypted DMs (${totalDmUnread} unread)`
              : 'Encrypted Direct Messages'
          }
          aria-current={mode === 'dm' ? 'page' : undefined}
        >
          <span className="ag-rail-pill" aria-hidden="true" />
          <Lock size={17} />
          {totalDmUnread > 0 && (
            <span className="ag-rail-badge ag-rail-badge-dm mono">
              {totalDmUnread > 99 ? '99+' : totalDmUnread}
            </span>
          )}
        </button>
      </div>

      <div className="ag-rail-divider" aria-hidden="true" />

      {/* Joined Servers */}
      <div className="ag-rail-servers" role="list" aria-label="Joined servers">
        {joinedServers.map((server) => {
          const isActive = mode === 'server' && activeServerId === server.id
          const hasIcon = Boolean(server.icon && server.icon.trim().length > 0)
          const style = {
            '--srv-accent': server.accentColor || 'var(--accent)',
          } as CSSProperties

          return (
            <div key={server.id} role="listitem" className="ag-rail-slot">
              <button
                type="button"
                style={style}
                className={`ag-rail-item ag-rail-server ${isActive ? 'active' : ''}`}
                onClick={() => {
                  onPlaySound?.('click')
                  onSelectServer(server.id)
                }}
                title={`${server.name} · ${serverKindLabel(server)} (${server.channels.length} ${server.channels.length === 1 ? 'channel' : 'channels'})`}
                aria-label={`${server.name} (${serverKindLabel(server)})`}
                aria-current={isActive ? 'page' : undefined}
              >
                <span className="ag-rail-pill" aria-hidden="true" />
                {server.picture && /^https?:\/\//i.test(server.picture) ? (
                  <img
                    src={server.picture}
                    alt=""
                    className="ag-rail-server-img"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                ) : hasIcon ? (
                  <span className="ag-rail-server-emoji" aria-hidden="true">
                    {server.icon}
                  </span>
                ) : (
                  <span className="ag-rail-server-mono mono" aria-hidden="true">
                    {getServerMonogram(server.name)}
                  </span>
                )}

                {/* Kind micro-indicator */}
                {server.encrypted && (
                  <span
                    className="ag-rail-kind-dot e2ee"
                    title="End-to-End Encrypted"
                    aria-hidden="true"
                  >
                    <Lock size={8} />
                  </span>
                )}
                {!server.encrypted && server.kind === 'nip29' && (
                  <span
                    className="ag-rail-kind-dot nip29"
                    title="NIP-29 Relay Community"
                    aria-hidden="true"
                  >
                    <Server size={8} />
                  </span>
                )}

                {/* Unread / Mention pill */}
                {server.mentionCount > 0 ? (
                  <span className="ag-rail-badge ag-rail-badge-mention mono">
                    @{server.mentionCount > 9 ? '9+' : server.mentionCount}
                  </span>
                ) : server.unreadCount > 0 ? (
                  <span className="ag-rail-badge ag-rail-badge-unread mono">
                    {server.unreadCount > 99 ? '99+' : server.unreadCount}
                  </span>
                ) : null}
              </button>
            </div>
          )
        })}

        {/* Add / Join / Explore Servers Button */}
        <div role="listitem" className="ag-rail-slot">
          <button
            type="button"
            className="ag-rail-item ag-rail-add"
            onClick={() => {
              onPlaySound?.('click')
              onOpenHub('create')
            }}
            title="Create, Join, or Explore Servers"
            aria-label="Create, join, or explore servers"
          >
            <Plus size={18} />
          </button>
        </div>
      </div>
    </nav>
  )
}

export default ServerRail
