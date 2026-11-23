import React, { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  Download,
  Link2,
  LogOut,
  Mail,
  Map as MapIcon,
  MessageCircle,
  Plus,
  Radio,
  Settings,
  Wallet,
} from 'lucide-react'
import type { AgnostrEngine } from '../types/protocol'
import type { ServerSummary } from '../types/servers'
import type { PwaState } from '../hooks/usePwa'
import type { SoundCue } from '../utils/sound'
import type { ListTab } from './ConversationList'
import type { ServerHubTab } from './ServerHubModal'
import type { ServerSettingsTab } from './ServerSettingsModal'
import type { SettingsTab } from './SettingsModal'
import { useContextMenu, type ContextMenuItem } from './ContextMenu'

export type ActiveWorkspace = 'chat' | 'mail' | 'wallet'

export interface AppRailProps {
  engine: AgnostrEngine
  workspace: ActiveWorkspace
  listTab: ListTab
  selectedServerId: string | null
  mapActive: boolean
  settingsActive: boolean
  pwa?: PwaState
  onSelectWorkspace: (workspace: ActiveWorkspace) => void
  onSelectChatTab: (tab: ListTab) => void
  onSelectServer: (serverId: string) => void
  onOpenServerHub: (tab?: ServerHubTab) => void
  onOpenServerSettings: (serverId: string, tab?: ServerSettingsTab) => void
  onOpenMap: () => void
  onOpenSettings: (tab?: SettingsTab) => void
  onOpenInstall?: () => void
  onPlaySound?: (cue: SoundCue) => void
}

interface RailTooltipState {
  label: string
  sub?: string
  top: number
  left: number
}

function formatBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

function getServerMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'SV'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase()
}

export const AppRail: React.FC<AppRailProps> = ({
  engine,
  workspace,
  listTab,
  selectedServerId,
  mapActive,
  settingsActive,
  pwa,
  onSelectWorkspace,
  onSelectChatTab,
  onSelectServer,
  onOpenServerHub,
  onOpenServerSettings,
  onOpenMap,
  onOpenSettings,
  onOpenInstall,
  onPlaySound,
}) => {
  const { openContextMenu } = useContextMenu()
  const [tooltip, setTooltip] = useState<RailTooltipState | null>(null)

  const hideTooltip = useCallback(() => {
    setTooltip(null)
  }, [])

  const showTooltip = useCallback((el: HTMLElement, label: string, sub?: string) => {
    const rect = el.getBoundingClientRect()
    setTooltip({
      label,
      sub,
      top: Math.round(rect.top + rect.height / 2),
      left: Math.round(rect.right + 10),
    })
  }, [])

  useEffect(() => {
    if (!tooltip) return
    const dismiss = () => setTooltip(null)
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [tooltip])

  const effectiveSelectedServerId =
    selectedServerId ||
    engine.servers.activeServer?.id ||
    engine.servers.joinedServers[0]?.id ||
    null

  const isRadioActive = workspace === 'chat' && listTab === 'radio'
  const isPeopleActive = workspace === 'chat' && listTab === 'dms'
  const isMailActive = workspace === 'mail'
  const isWalletActive = workspace === 'wallet'

  const radioMentions = engine.totalGeoMentions
  const radioUnread = engine.totalGeoUnread
  const dmUnread = engine.totalDmUnread
  const mailUnread = engine.amail.unreadInboxCount
  const walletSats = engine.wallet.totalBalanceSats
  const activeCall = engine.calls.activeCall

  const openServerMenu = (e: React.MouseEvent, server: ServerSummary) => {
    hideTooltip()
    const invite = engine.servers.buildInviteLink(server.id)
    const items: ContextMenuItem[] = [
      {
        id: `rail-srv-invite-${server.id}`,
        label: invite ? 'Invite' : 'Invite & Share',
        icon: <Link2 size={14} />,
        onSelect: () => {
          onPlaySound?.('click')
          if (invite) {
            navigator.clipboard?.writeText(invite.url).catch(() => {})
            engine.pushToast('success', 'Invite link copied', server.name)
          } else {
            onOpenServerSettings(server.id, 'overview')
          }
        },
      },
      {
        id: `rail-srv-settings-${server.id}`,
        label: 'Server Settings',
        icon: <Settings size={14} />,
        onSelect: () => {
          onPlaySound?.('click')
          onOpenServerSettings(server.id, 'overview')
        },
      },
      {
        id: `rail-srv-leave-${server.id}`,
        label: 'Leave Server',
        icon: <LogOut size={14} />,
        danger: true,
        dividerBefore: true,
        onSelect: () => {
          onPlaySound?.('click')
          void engine.servers.leaveServer(server.id)
        },
      },
    ]

    openContextMenu(e, {
      header: server.name,
      items,
    })
  }

  return (
    <nav className="ag-app-rail ag-desktop-only" aria-label="Workspace and servers">
      {/* Primary First-Class Workspaces */}
      <div className="ag-rail-group">
        {/* Radio */}
        <div className="ag-rail-slot">
          <button
            type="button"
            className={`ag-rail-tile ag-rail-radio ${isRadioActive ? 'active' : ''} ${radioUnread > 0 || radioMentions > 0 ? 'has-unread' : ''}`}
            onClick={() => {
              onPlaySound?.('click')
              if (workspace !== 'chat') onSelectWorkspace('chat')
              onSelectChatTab('radio')
            }}
            onMouseEnter={(e) => showTooltip(e.currentTarget, 'Radio')}
            onMouseLeave={hideTooltip}
            onFocus={(e) => showTooltip(e.currentTarget, 'Radio')}
            onBlur={hideTooltip}
            aria-label="Radio"
            aria-current={isRadioActive ? 'page' : undefined}
          >
            <span className="ag-rail-indicator" aria-hidden="true" />
            <Radio size={19} strokeWidth={isRadioActive ? 2.15 : 1.85} />
            {radioMentions > 0 ? (
              <span className="ag-rail-badge ping tabular">
                {formatBadgeCount(radioMentions)}
              </span>
            ) : radioUnread > 0 ? (
              <span className="ag-rail-badge unread tabular">
                {formatBadgeCount(radioUnread)}
              </span>
            ) : null}
          </button>
        </div>

        {/* People */}
        <div className="ag-rail-slot">
          <button
            type="button"
            className={`ag-rail-tile ag-rail-people ${isPeopleActive ? 'active' : ''} ${dmUnread > 0 ? 'has-unread' : ''}`}
            onClick={() => {
              onPlaySound?.('click')
              if (workspace !== 'chat') onSelectWorkspace('chat')
              onSelectChatTab('dms')
            }}
            onMouseEnter={(e) => showTooltip(e.currentTarget, 'People')}
            onMouseLeave={hideTooltip}
            onFocus={(e) => showTooltip(e.currentTarget, 'People')}
            onBlur={hideTooltip}
            aria-label="People"
            aria-current={isPeopleActive ? 'page' : undefined}
          >
            <span className="ag-rail-indicator" aria-hidden="true" />
            <MessageCircle size={19} strokeWidth={isPeopleActive ? 2.15 : 1.85} />
            {dmUnread > 0 && (
              <span className="ag-rail-badge ping tabular">{formatBadgeCount(dmUnread)}</span>
            )}
          </button>
        </div>

        {/* Agmail */}
        <div className="ag-rail-slot">
          <button
            type="button"
            className={`ag-rail-tile ag-rail-mail ${isMailActive ? 'active' : ''} ${mailUnread > 0 ? 'has-unread' : ''}`}
            onClick={() => {
              onPlaySound?.('click')
              onSelectWorkspace('mail')
            }}
            onMouseEnter={(e) =>
              showTooltip(
                e.currentTarget,
                'Agmail',
                mailUnread > 0 ? `${mailUnread} unread` : undefined
              )
            }
            onMouseLeave={hideTooltip}
            onFocus={(e) =>
              showTooltip(
                e.currentTarget,
                'Agmail',
                mailUnread > 0 ? `${mailUnread} unread` : undefined
              )
            }
            onBlur={hideTooltip}
            aria-label={mailUnread > 0 ? `Agmail (${mailUnread} unread)` : 'Agmail'}
            aria-current={isMailActive ? 'page' : undefined}
          >
            <span className="ag-rail-indicator" aria-hidden="true" />
            <Mail size={19} strokeWidth={isMailActive ? 2.15 : 1.85} />
            {mailUnread > 0 && (
              <span className="ag-rail-badge ping tabular">{formatBadgeCount(mailUnread)}</span>
            )}
          </button>
        </div>

        {/* Agwallet */}
        <div className="ag-rail-slot">
          <button
            type="button"
            className={`ag-rail-tile ag-rail-wallet ${isWalletActive ? 'active' : ''}`}
            onClick={() => {
              onPlaySound?.('click')
              onSelectWorkspace('wallet')
            }}
            onMouseEnter={(e) =>
              showTooltip(
                e.currentTarget,
                'Agwallet',
                walletSats > 0 ? `${walletSats.toLocaleString()} sats` : undefined
              )
            }
            onMouseLeave={hideTooltip}
            onFocus={(e) =>
              showTooltip(
                e.currentTarget,
                'Agwallet',
                walletSats > 0 ? `${walletSats.toLocaleString()} sats` : undefined
              )
            }
            onBlur={hideTooltip}
            aria-label={
              walletSats > 0 ? `Agwallet (${walletSats.toLocaleString()} sats)` : 'Agwallet'
            }
            aria-current={isWalletActive ? 'page' : undefined}
          >
            <span className="ag-rail-indicator" aria-hidden="true" />
            <Wallet size={19} strokeWidth={isWalletActive ? 2.15 : 1.85} />
          </button>
        </div>
      </div>

      <div className="ag-rail-divider" aria-hidden="true" />

      {/* Discord-Style Vertical Server Squircle Rail */}
      <div className="ag-rail-servers" onScroll={hideTooltip} role="list" aria-label="Servers">
        {engine.servers.joinedServers.map((server) => {
          const active =
            workspace === 'chat' &&
            listTab === 'servers' &&
            effectiveSelectedServerId === server.id
          const srvUnread = Math.max(
            server.unreadCount,
            engine.servers.getServerUnreadCount(server.id)
          )
          const srvMentions = Math.max(
            server.mentionCount,
            engine.servers.getServerMentionCount(server.id)
          )
          const hasUnread = srvUnread > 0 || srvMentions > 0
          const isInCall = activeCall?.mode === 'server' && activeCall.serverId === server.id
          const rosterLen = (engine.calls.serverCallRosters[server.id] ?? []).length
          const voiceCount = Math.max(
            engine.calls.getServerCallCount(server.id),
            isInCall ? activeCall.participants.length : rosterLen
          )
          const voiceSub = voiceCount > 0 ? `${voiceCount} in voice` : undefined
          const accentStyle = {
            '--srv-accent': server.accentColor || 'var(--accent)',
          } as CSSProperties

          return (
            <div key={server.id} className="ag-rail-slot" role="listitem">
              <button
                type="button"
                className={`ag-rail-tile ag-rail-srv ${active ? 'active' : ''} ${hasUnread ? 'has-unread' : ''}`}
                style={accentStyle}
                onClick={() => {
                  onPlaySound?.('click')
                  if (workspace !== 'chat') onSelectWorkspace('chat')
                  onSelectServer(server.id)
                }}
                onContextMenu={(e) => openServerMenu(e, server)}
                onMouseEnter={(e) => showTooltip(e.currentTarget, server.name, voiceSub)}
                onMouseLeave={hideTooltip}
                onFocus={(e) => showTooltip(e.currentTarget, server.name, voiceSub)}
                onBlur={hideTooltip}
                aria-label={voiceSub ? `${server.name} (${voiceSub})` : server.name}
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

        {/* Add / Join Server */}
        <div className="ag-rail-slot" role="listitem">
          <button
            type="button"
            className="ag-rail-tile ag-rail-add"
            onClick={() => {
              onPlaySound?.('click')
              onOpenServerHub('create')
            }}
            onMouseEnter={(e) => showTooltip(e.currentTarget, 'Create or join server')}
            onMouseLeave={hideTooltip}
            onFocus={(e) => showTooltip(e.currentTarget, 'Create or join server')}
            onBlur={hideTooltip}
            aria-label="Create or join server"
          >
            <Plus size={19} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Bottom Utility Actions */}
      <div className="ag-rail-bottom">
        <div className="ag-rail-divider" aria-hidden="true" />

        <div className="ag-rail-slot">
          <button
            type="button"
            className={`ag-rail-util ${mapActive ? 'active' : ''}`}
            onClick={() => {
              onPlaySound?.('click')
              onOpenMap()
            }}
            onMouseEnter={(e) => showTooltip(e.currentTarget, 'Map')}
            onMouseLeave={hideTooltip}
            onFocus={(e) => showTooltip(e.currentTarget, 'Map')}
            onBlur={hideTooltip}
            aria-label="Map"
            aria-pressed={mapActive}
          >
            <MapIcon size={18} strokeWidth={mapActive ? 2.1 : 1.8} />
          </button>
        </div>

        <div className="ag-rail-slot">
          <button
            type="button"
            className={`ag-rail-util ${settingsActive ? 'active' : ''}`}
            onClick={() => {
              onPlaySound?.('click')
              onOpenSettings()
            }}
            onMouseEnter={(e) => showTooltip(e.currentTarget, 'Settings', '⌘,')}
            onMouseLeave={hideTooltip}
            onFocus={(e) => showTooltip(e.currentTarget, 'Settings', '⌘,')}
            onBlur={hideTooltip}
            aria-label="Settings"
            aria-pressed={settingsActive}
          >
            <Settings size={18} strokeWidth={settingsActive ? 2.1 : 1.8} />
          </button>
        </div>

        {pwa && !pwa.isInstalled && pwa.canPromptInstall && onOpenInstall && (
          <div className="ag-rail-slot">
            <button
              type="button"
              className="ag-rail-util"
              onClick={() => {
                onPlaySound?.('click')
                onOpenInstall()
              }}
              onMouseEnter={(e) => showTooltip(e.currentTarget, 'Install App')}
              onMouseLeave={hideTooltip}
              onFocus={(e) => showTooltip(e.currentTarget, 'Install App')}
              onBlur={hideTooltip}
              aria-label="Install Agnostr App"
            >
              <Download size={18} strokeWidth={1.85} />
            </button>
          </div>
        )}
      </div>

      {tooltip &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="ag-rail-tooltip"
            role="tooltip"
            style={{ top: tooltip.top, left: tooltip.left }}
          >
            <span className="ag-rail-tooltip-title">{tooltip.label}</span>
            {tooltip.sub && <span className="ag-rail-tooltip-sub">{tooltip.sub}</span>}
          </div>,
          document.body
        )}
    </nav>
  )
}

export default AppRail
