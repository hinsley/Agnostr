import React, { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  Download,
  Landmark,
  LayoutGrid,
  Link2,
  LogOut,
  Mail,
  Map as MapIcon,
  MessageCircle,
  Plus,
  Search,
  Settings,
  Users,
  Wallet,
  Waves,
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

export type ActiveWorkspace = 'chat' | 'agora' | 'mail' | 'wallet'

export interface AppRailProps {
  engine: AgnostrEngine
  workspace: ActiveWorkspace
  listTab: ListTab
  selectedServerId: string | null
  mapActive: boolean
  settingsActive: boolean
  pwa?: PwaState
  agoraUnread?: number
  suiteLauncherOpen?: boolean
  onToggleSuiteLauncher?: () => void
  onSelectWorkspace: (workspace: ActiveWorkspace) => void
  onSelectChatTab: (tab: ListTab) => void
  onSelectGroups?: () => void
  onSelectServer: (serverId: string) => void
  onOpenServerHub: (tab?: ServerHubTab) => void
  onOpenServerSettings: (serverId: string, tab?: ServerSettingsTab) => void
  onOpenMap: () => void
  onOpenSearch?: () => void
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
  agoraUnread = 0,
  suiteLauncherOpen = false,
  onToggleSuiteLauncher,
  onSelectWorkspace,
  onSelectChatTab,
  onSelectGroups,
  onSelectServer,
  onOpenServerHub,
  onOpenServerSettings,
  onOpenMap,
  onOpenSearch,
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

  const isAgoraActive = workspace === 'agora'
  const isBitchatActive = workspace === 'chat' && listTab === 'bitchat'
  const isPeopleActive = workspace === 'chat' && listTab === 'dms'
  const isGroupsActive = workspace === 'chat' && listTab === 'servers'
  const isMailActive = workspace === 'mail'
  const isWalletActive = workspace === 'wallet'

  const bitchatMentions = engine.totalGeoMentions
  const bitchatUnread = engine.totalGeoUnread
  const dmUnread = engine.totalDmUnread
  const mailUnread = engine.amail.unreadInboxCount
  const walletSats = engine.wallet.totalBalanceSats
  const activeCall = engine.calls.activeCall

  let totalServerUnread = 0
  let totalServerMentions = 0
  for (const s of engine.servers.joinedServers) {
    totalServerUnread += Math.max(s.unreadCount, engine.servers.getServerUnreadCount(s.id))
    totalServerMentions += Math.max(s.mentionCount, engine.servers.getServerMentionCount(s.id))
  }

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
        label: 'Group Settings',
        icon: <Settings size={14} />,
        onSelect: () => {
          onPlaySound?.('click')
          onOpenServerSettings(server.id, 'overview')
        },
      },
      {
        id: `rail-srv-leave-${server.id}`,
        label: 'Leave Group',
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
    <nav className="ag-app-rail ag-desktop-only" aria-label="Agnostr Suite and groups">
      {/* Top Brand Suite Launcher Crest */}
      <div className="ag-rail-slot ag-rail-brand-slot">
        <button
          type="button"
          className={`ag-rail-brand ${suiteLauncherOpen ? 'active' : ''}`}
          onClick={() => {
            onPlaySound?.('click')
            hideTooltip()
            onToggleSuiteLauncher?.()
          }}
          onMouseEnter={(e) => showTooltip(e.currentTarget, 'Agnostr Suite', 'Alt+0')}
          onMouseLeave={hideTooltip}
          onFocus={(e) => showTooltip(e.currentTarget, 'Agnostr Suite', 'Alt+0')}
          onBlur={hideTooltip}
          aria-label="Agnostr Suite (Alt+0)"
          aria-haspopup="dialog"
          aria-expanded={suiteLauncherOpen}
        >
          <span className="ag-rail-brand-monogram" aria-hidden="true">
            A
          </span>
          <LayoutGrid size={11} strokeWidth={2.2} className="ag-rail-brand-grid" aria-hidden="true" />
        </button>
      </div>

      {/* Consistent 6-App Primary Stack */}
      <div className="ag-rail-group" role="list" aria-label="Agnostr apps">
        {/* 1. Agora */}
        <div className="ag-rail-slot" role="listitem">
          <button
            type="button"
            className={`ag-rail-app-tile ag-rail-agora ${isAgoraActive ? 'active' : ''} ${agoraUnread > 0 ? 'has-unread' : ''}`}
            onClick={() => {
              onPlaySound?.('click')
              onSelectWorkspace('agora')
            }}
            onMouseEnter={(e) =>
              showTooltip(
                e.currentTarget,
                'Agora',
                agoraUnread > 0 ? `${agoraUnread} new · Alt+1` : 'Alt+1'
              )
            }
            onMouseLeave={hideTooltip}
            onFocus={(e) =>
              showTooltip(
                e.currentTarget,
                'Agora',
                agoraUnread > 0 ? `${agoraUnread} new · Alt+1` : 'Alt+1'
              )
            }
            onBlur={hideTooltip}
            aria-label={agoraUnread > 0 ? `Agora (${agoraUnread} unread)` : 'Agora'}
            aria-current={isAgoraActive ? 'page' : undefined}
          >
            <span className="ag-rail-indicator" aria-hidden="true" />
            <Landmark size={18} strokeWidth={isAgoraActive ? 2.15 : 1.8} />
            <span className="ag-rail-app-label">Agora</span>
            {agoraUnread > 0 && (
              <span className="ag-rail-badge ping tabular">{formatBadgeCount(agoraUnread)}</span>
            )}
          </button>
        </div>

        {/* 2. Bitchat */}
        <div className="ag-rail-slot" role="listitem">
          <button
            type="button"
            className={`ag-rail-app-tile ag-rail-bitchat ${isBitchatActive ? 'active' : ''} ${bitchatUnread > 0 || bitchatMentions > 0 ? 'has-unread' : ''}`}
            onClick={() => {
              onPlaySound?.('click')
              if (workspace !== 'chat') onSelectWorkspace('chat')
              onSelectChatTab('bitchat')
            }}
            onMouseEnter={(e) => showTooltip(e.currentTarget, 'Bitchat', 'Alt+2')}
            onMouseLeave={hideTooltip}
            onFocus={(e) => showTooltip(e.currentTarget, 'Bitchat', 'Alt+2')}
            onBlur={hideTooltip}
            aria-label="Bitchat"
            aria-current={isBitchatActive ? 'page' : undefined}
          >
            <span className="ag-rail-indicator" aria-hidden="true" />
            <Waves size={18} strokeWidth={isBitchatActive ? 2.15 : 1.8} />
            <span className="ag-rail-app-label">Bitchat</span>
            {bitchatMentions > 0 ? (
              <span className="ag-rail-badge ping tabular">
                {formatBadgeCount(bitchatMentions)}
              </span>
            ) : bitchatUnread > 0 ? (
              <span className="ag-rail-badge unread tabular">
                {formatBadgeCount(bitchatUnread)}
              </span>
            ) : null}
          </button>
        </div>

        {/* 3. People */}
        <div className="ag-rail-slot" role="listitem">
          <button
            type="button"
            className={`ag-rail-app-tile ag-rail-people ${isPeopleActive ? 'active' : ''} ${dmUnread > 0 ? 'has-unread' : ''}`}
            onClick={() => {
              onPlaySound?.('click')
              if (workspace !== 'chat') onSelectWorkspace('chat')
              onSelectChatTab('dms')
            }}
            onMouseEnter={(e) =>
              showTooltip(
                e.currentTarget,
                'People',
                dmUnread > 0 ? `${dmUnread} unread · Alt+3` : 'Alt+3'
              )
            }
            onMouseLeave={hideTooltip}
            onFocus={(e) =>
              showTooltip(
                e.currentTarget,
                'People',
                dmUnread > 0 ? `${dmUnread} unread · Alt+3` : 'Alt+3'
              )
            }
            onBlur={hideTooltip}
            aria-label={dmUnread > 0 ? `People (${dmUnread} unread)` : 'People'}
            aria-current={isPeopleActive ? 'page' : undefined}
          >
            <span className="ag-rail-indicator" aria-hidden="true" />
            <MessageCircle size={18} strokeWidth={isPeopleActive ? 2.15 : 1.8} />
            <span className="ag-rail-app-label">People</span>
            {dmUnread > 0 && (
              <span className="ag-rail-badge ping tabular">{formatBadgeCount(dmUnread)}</span>
            )}
          </button>
        </div>

        {/* 4. Groups */}
        <div className="ag-rail-slot" role="listitem">
          <button
            type="button"
            className={`ag-rail-app-tile ag-rail-groups ${isGroupsActive ? 'active' : ''} ${totalServerUnread > 0 || totalServerMentions > 0 ? 'has-unread' : ''}`}
            onClick={() => {
              onPlaySound?.('click')
              if (onSelectGroups) {
                onSelectGroups()
              } else {
                if (workspace !== 'chat') onSelectWorkspace('chat')
                onSelectChatTab('servers')
              }
            }}
            onMouseEnter={(e) => showTooltip(e.currentTarget, 'Groups', 'Alt+4')}
            onMouseLeave={hideTooltip}
            onFocus={(e) => showTooltip(e.currentTarget, 'Groups', 'Alt+4')}
            onBlur={hideTooltip}
            aria-label="Groups"
            aria-current={isGroupsActive ? 'page' : undefined}
          >
            <span className="ag-rail-indicator" aria-hidden="true" />
            <Users size={18} strokeWidth={isGroupsActive ? 2.15 : 1.8} />
            <span className="ag-rail-app-label">Groups</span>
            {totalServerMentions > 0 ? (
              <span className="ag-rail-badge ping tabular">
                {formatBadgeCount(totalServerMentions)}
              </span>
            ) : totalServerUnread > 0 ? (
              <span className="ag-rail-badge unread tabular">
                {formatBadgeCount(totalServerUnread)}
              </span>
            ) : null}
          </button>
        </div>

        {/* 5. Agmail */}
        <div className="ag-rail-slot" role="listitem">
          <button
            type="button"
            className={`ag-rail-app-tile ag-rail-mail ${isMailActive ? 'active' : ''} ${mailUnread > 0 ? 'has-unread' : ''}`}
            onClick={() => {
              onPlaySound?.('click')
              onSelectWorkspace('mail')
            }}
            onMouseEnter={(e) =>
              showTooltip(
                e.currentTarget,
                'Agmail',
                mailUnread > 0 ? `${mailUnread} unread · Alt+5` : 'Alt+5'
              )
            }
            onMouseLeave={hideTooltip}
            onFocus={(e) =>
              showTooltip(
                e.currentTarget,
                'Agmail',
                mailUnread > 0 ? `${mailUnread} unread · Alt+5` : 'Alt+5'
              )
            }
            onBlur={hideTooltip}
            aria-label={mailUnread > 0 ? `Agmail (${mailUnread} unread)` : 'Agmail'}
            aria-current={isMailActive ? 'page' : undefined}
          >
            <span className="ag-rail-indicator" aria-hidden="true" />
            <Mail size={18} strokeWidth={isMailActive ? 2.15 : 1.8} />
            <span className="ag-rail-app-label">Agmail</span>
            {mailUnread > 0 && (
              <span className="ag-rail-badge ping tabular">{formatBadgeCount(mailUnread)}</span>
            )}
          </button>
        </div>

        {/* 6. Agwallet */}
        <div className="ag-rail-slot" role="listitem">
          <button
            type="button"
            className={`ag-rail-app-tile ag-rail-wallet ${isWalletActive ? 'active' : ''}`}
            onClick={() => {
              onPlaySound?.('click')
              onSelectWorkspace('wallet')
            }}
            onMouseEnter={(e) =>
              showTooltip(
                e.currentTarget,
                'Agwallet',
                walletSats > 0 ? `${walletSats.toLocaleString()} sats · Alt+6` : 'Alt+6'
              )
            }
            onMouseLeave={hideTooltip}
            onFocus={(e) =>
              showTooltip(
                e.currentTarget,
                'Agwallet',
                walletSats > 0 ? `${walletSats.toLocaleString()} sats · Alt+6` : 'Alt+6'
              )
            }
            onBlur={hideTooltip}
            aria-label={
              walletSats > 0 ? `Agwallet (${walletSats.toLocaleString()} sats)` : 'Agwallet'
            }
            aria-current={isWalletActive ? 'page' : undefined}
          >
            <span className="ag-rail-indicator" aria-hidden="true" />
            <Wallet size={18} strokeWidth={isWalletActive ? 2.15 : 1.8} />
            <span className="ag-rail-app-label">Agwallet</span>
          </button>
        </div>
      </div>

      <div className="ag-rail-divider" aria-hidden="true" />

      {/* Compact Joined Groups Quick-Jump Strip */}
      <div className="ag-rail-servers" onScroll={hideTooltip} role="list" aria-label="Joined groups">
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
                className={`ag-rail-tile compact ag-rail-srv ${active ? 'active' : ''} ${hasUnread ? 'has-unread' : ''}`}
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

        {/* Add / Join Group */}
        <div className="ag-rail-slot" role="listitem">
          <button
            type="button"
            className="ag-rail-tile compact ag-rail-add"
            onClick={() => {
              onPlaySound?.('click')
              onOpenServerHub('create')
            }}
            onMouseEnter={(e) => showTooltip(e.currentTarget, 'Create or join group')}
            onMouseLeave={hideTooltip}
            onFocus={(e) => showTooltip(e.currentTarget, 'Create or join group')}
            onBlur={hideTooltip}
            aria-label="Create or join group"
          >
            <Plus size={17} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Bottom Utility Dock */}
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
            onMouseEnter={(e) => showTooltip(e.currentTarget, 'Radar Map')}
            onMouseLeave={hideTooltip}
            onFocus={(e) => showTooltip(e.currentTarget, 'Radar Map')}
            onBlur={hideTooltip}
            aria-label="Radar Map"
            aria-pressed={mapActive}
          >
            <MapIcon size={17} strokeWidth={mapActive ? 2.1 : 1.8} />
          </button>
        </div>

        {onOpenSearch && (
          <div className="ag-rail-slot">
            <button
              type="button"
              className="ag-rail-util"
              onClick={() => {
                onPlaySound?.('click')
                onOpenSearch()
              }}
              onMouseEnter={(e) => showTooltip(e.currentTarget, 'Quick Search', '⌘K')}
              onMouseLeave={hideTooltip}
              onFocus={(e) => showTooltip(e.currentTarget, 'Quick Search', '⌘K')}
              onBlur={hideTooltip}
              aria-label="Quick Search"
            >
              <Search size={17} strokeWidth={1.8} />
            </button>
          </div>
        )}

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
            <Settings size={17} strokeWidth={settingsActive ? 2.1 : 1.8} />
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
              <Download size={17} strokeWidth={1.85} />
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
