import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDown,
  ArrowUp,
  Bell,
  Download,
  Globe,
  Landmark,
  Link2,
  LogOut,
  Mail,
  MessageCircle,
  Plus,
  Search,
  Settings,
  Wallet,
} from 'lucide-react'
import type { AgnostrEngine } from '../types/protocol'
import type { ServerSummary } from '../types/servers'
import type { PwaState } from '../hooks/usePwa'
import { getGroupSpecifier, hasUploadedGroupPicture } from '../utils/groupIcon'
import type { SoundCue } from '../utils/sound'
import type { ListTab } from './ConversationList'
import type { ServerHubTab } from './ServerHubModal'
import type { ServerSettingsTab } from './ServerSettingsModal'
import type { SettingsTab } from './SettingsModal'
import { AgnostrLogo } from './AgnostrLogo'
import { useContextMenu, type ContextMenuItem } from './ContextMenu'
import { UserProfileDock } from './UserProfileDock'

export type ActiveWorkspace = 'chat' | 'agora' | 'mail' | 'wallet'

export interface AppRailProps {
  engine: AgnostrEngine
  workspace: ActiveWorkspace
  listTab: ListTab
  selectedServerId: string | null
  settingsActive: boolean
  pwa?: PwaState
  agoraUnread?: number
  onSelectWorkspace: (workspace: ActiveWorkspace) => void
  onSelectChatTab: (tab: ListTab) => void
  onSelectGroups?: () => void
  onSelectServer: (serverId: string) => void
  onOpenServerHub: (tab?: ServerHubTab) => void
  onOpenServerSettings: (serverId: string, tab?: ServerSettingsTab) => void
  onOpenSearch?: () => void
  onOpenSettings: (tab?: SettingsTab) => void
  onOpenNotificationOptions?: () => void
  onOpenOwnAgoraProfile?: () => void
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

export const AppRail: React.FC<AppRailProps> = ({
  engine,
  workspace,
  listTab,
  selectedServerId,
  settingsActive,
  pwa,
  agoraUnread = 0,
  onSelectWorkspace,
  onSelectChatTab,
  onSelectServer,
  onOpenServerHub,
  onOpenServerSettings,
  onOpenSearch,
  onOpenSettings,
  onOpenNotificationOptions,
  onOpenOwnAgoraProfile,
  onOpenInstall,
  onPlaySound,
}) => {
  const { openContextMenu } = useContextMenu()
  const [tooltip, setTooltip] = useState<RailTooltipState | null>(null)
  const [failedIconUrls, setFailedIconUrls] = useState<Set<string>>(() => new Set())
  const markIconFailed = useCallback((url: string) => {
    setFailedIconUrls((prev) => {
      if (prev.has(url)) return prev
      const next = new Set(prev)
      next.add(url)
      return next
    })
  }, [])
  const [dragServerIndex, setDragServerIndex] = useState<number | null>(null)
  const [dropServerTarget, setDropServerTarget] = useState<{
    index: number
    position: 'before' | 'after'
  } | null>(null)
  const appRailRef = useRef<HTMLElement | null>(null)
  const serversRailRef = useRef<HTMLDivElement | null>(null)
  const touchDragRef = useRef<{
    pointerId: number
    fromIndex: number
    startX: number
    startY: number
    active: boolean
    timerId: number | null
    targetIndex: number
    position: 'before' | 'after'
  } | null>(null)
  const suppressNextClickRef = useRef(false)
  const suppressResetTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (touchDragRef.current?.timerId !== null && touchDragRef.current?.timerId !== undefined) {
        window.clearTimeout(touchDragRef.current.timerId)
      }
      if (suppressResetTimerRef.current !== null) {
        window.clearTimeout(suppressResetTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (dragServerIndex === null) return
    const rail = serversRailRef.current
    if (!rail) return
    const onTouchMove = (ev: TouchEvent) => {
      if (touchDragRef.current?.active) {
        ev.preventDefault()
      }
    }
    rail.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => rail.removeEventListener('touchmove', onTouchMove)
  }, [dragServerIndex])

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
  const isMailActive = workspace === 'mail'
  const isWalletActive = workspace === 'wallet'

  const bitchatMentions = engine.totalGeoMentions
  const bitchatUnread = engine.totalGeoUnread
  const dmUnread = engine.totalDmUnread
  const mailUnread = engine.amail.unreadInboxCount
  const walletSats = engine.wallet.totalBalanceSats
  const activeCall = engine.calls.activeCall
  const otherProfilesUnread = engine.profiles.otherProfilesUnreadCount
  const profileTooltipLabel = `${engine.identity.nickname} · Profiles & Identity`
  const profileTooltipSub =
    otherProfilesUnread > 0
      ? `${otherProfilesUnread} unread on other profile${otherProfilesUnread === 1 ? '' : 's'}`
      : undefined

  const openServerMenu = (e: React.MouseEvent, server: ServerSummary) => {
    hideTooltip()
    const invite = engine.servers.buildInviteLink(server.id)
    const serverIndex = engine.servers.joinedServers.findIndex((s) => s.id === server.id)
    const totalServers = engine.servers.joinedServers.length
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
    ]

    if (serverIndex !== -1 && totalServers > 1) {
      if (serverIndex > 0) {
        items.push({
          id: `rail-srv-move-up-${server.id}`,
          label: 'Move Up',
          icon: <ArrowUp size={14} />,
          dividerBefore: true,
          onSelect: () => {
            onPlaySound?.('click')
            engine.servers.reorderJoinedServers(serverIndex, serverIndex - 1)
          },
        })
      }
      if (serverIndex < totalServers - 1) {
        items.push({
          id: `rail-srv-move-down-${server.id}`,
          label: 'Move Down',
          icon: <ArrowDown size={14} />,
          dividerBefore: serverIndex === 0,
          onSelect: () => {
            onPlaySound?.('click')
            engine.servers.reorderJoinedServers(serverIndex, serverIndex + 1)
          },
        })
      }
    }

    items.push({
      id: `rail-srv-leave-${server.id}`,
      label: 'Leave Group',
      icon: <LogOut size={14} />,
      danger: true,
      dividerBefore: true,
      onSelect: () => {
        onPlaySound?.('click')
        void engine.servers.leaveServer(server.id)
      },
    })

    openContextMenu(e, {
      header: server.name,
      items,
    })
  }

  const joinedServers = engine.servers.joinedServers
  const canReorderServers = joinedServers.length > 1

  const hitTestRailServerSlot = useCallback(
    (clientY: number): { index: number; position: 'before' | 'after' } | null => {
      const slots = serversRailRef.current?.querySelectorAll<HTMLElement>('[data-rail-srv-index]')
      if (!slots || slots.length === 0) return null
      let bestIdx = 0
      let bestPos: 'before' | 'after' = 'before'
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]
        const rect = slot.getBoundingClientRect()
        const slotIdx = Number(slot.dataset.railSrvIndex)
        if (clientY < rect.top + rect.height / 2) {
          bestIdx = slotIdx
          bestPos = 'before'
          break
        }
        bestIdx = slotIdx
        bestPos = 'after'
      }
      return { index: bestIdx, position: bestPos }
    },
    []
  )

  const autoScrollRail = useCallback((clientY: number) => {
    const rail = appRailRef.current ?? serversRailRef.current
    if (!rail) return
    const rect = rail.getBoundingClientRect()
    const edge = 36
    if (clientY < rect.top + edge) {
      rail.scrollTop -= Math.max(4, Math.round((rect.top + edge - clientY) * 0.4))
    } else if (clientY > rect.bottom - edge) {
      rail.scrollTop += Math.max(4, Math.round((clientY - (rect.bottom - edge)) * 0.4))
    }
  }, [])

  const scheduleSuppressReset = useCallback(() => {
    if (suppressResetTimerRef.current !== null) {
      window.clearTimeout(suppressResetTimerRef.current)
    }
    suppressResetTimerRef.current = window.setTimeout(() => {
      suppressNextClickRef.current = false
      suppressResetTimerRef.current = null
    }, 350)
  }, [])

  return (
    <nav
      ref={appRailRef}
      className="ag-app-rail ag-desktop-only"
      aria-label="Agnostr apps and groups"
      onScroll={hideTooltip}
    >
      {/* Static Brand Mark */}
      <div className="ag-rail-slot ag-rail-brand-slot" aria-hidden="true">
        <div className="ag-rail-brand">
          <AgnostrLogo size={22} className="ag-rail-brand-mark" />
        </div>
      </div>

      {/* Always-Visible All-Apps Stack */}
      <div className="ag-rail-group" role="list" aria-label="Agnostr apps">
        {onOpenNotificationOptions && (
          <div className="ag-rail-slot" role="listitem">
            <button
              type="button"
              className="ag-rail-app-tile ag-notification-shortcut"
              onClick={onOpenNotificationOptions}
              aria-label="Notification options"
              aria-haspopup="dialog"
              title="Notification options"
            >
              <Bell size={18} aria-hidden="true" />
              <span className="ag-rail-app-label">Alerts</span>
            </button>
          </div>
        )}

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
              showTooltip(e.currentTarget, 'Agora', agoraUnread > 0 ? `${agoraUnread} new` : undefined)
            }
            onMouseLeave={hideTooltip}
            onFocus={(e) =>
              showTooltip(e.currentTarget, 'Agora', agoraUnread > 0 ? `${agoraUnread} new` : undefined)
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
              onSelectChatTab('bitchat')
            }}
            onMouseEnter={(e) => showTooltip(e.currentTarget, 'Bitchat', '3D Globe')}
            onMouseLeave={hideTooltip}
            onFocus={(e) => showTooltip(e.currentTarget, 'Bitchat', '3D Globe')}
            onBlur={hideTooltip}
            aria-label="Bitchat"
            aria-current={isBitchatActive ? 'page' : undefined}
          >
            <span className="ag-rail-indicator" aria-hidden="true" />
            <Globe size={18} strokeWidth={isBitchatActive ? 2.15 : 1.8} />
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
              showTooltip(e.currentTarget, 'People', dmUnread > 0 ? `${dmUnread} unread` : undefined)
            }
            onMouseLeave={hideTooltip}
            onFocus={(e) =>
              showTooltip(e.currentTarget, 'People', dmUnread > 0 ? `${dmUnread} unread` : undefined)
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

        {/* 4. Agmail */}
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
            <Mail size={18} strokeWidth={isMailActive ? 2.15 : 1.8} />
            <span className="ag-rail-app-label">Agmail</span>
            {mailUnread > 0 && (
              <span className="ag-rail-badge ping tabular">{formatBadgeCount(mailUnread)}</span>
            )}
          </button>
        </div>

        {/* 5. Agwallet */}
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
            <Wallet size={18} strokeWidth={isWalletActive ? 2.15 : 1.8} />
            <span className="ag-rail-app-label">Agwallet</span>
          </button>
        </div>
      </div>

      <div className="ag-rail-divider" aria-hidden="true" />

      {/* Compact Joined Groups Quick-Jump Strip */}
      <div
        ref={serversRailRef}
        className={`ag-rail-servers ${dragServerIndex !== null ? 'is-reordering' : ''}`}
        onScroll={hideTooltip}
        onDragOver={(e) => {
          if (dragServerIndex === null || !canReorderServers) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          autoScrollRail(e.clientY)
          const hit = hitTestRailServerSlot(e.clientY)
          if (hit) {
            setDropServerTarget((prev) =>
              prev && prev.index === hit.index && prev.position === hit.position ? prev : hit
            )
          }
        }}
        onDrop={(e) => {
          if (dragServerIndex === null || !canReorderServers) return
          e.preventDefault()
          const hit = hitTestRailServerSlot(e.clientY) ?? dropServerTarget
          if (hit) {
            const toIndex = computeReorderToIndex(
              dragServerIndex,
              hit.index,
              hit.position,
              joinedServers.length
            )
            if (toIndex !== dragServerIndex) {
              onPlaySound?.('click')
              engine.servers.reorderJoinedServers(dragServerIndex, toIndex)
            }
          }
          setDragServerIndex(null)
          setDropServerTarget(null)
        }}
        role="list"
        aria-label="Joined groups"
      >
        {joinedServers.map((server, idx) => {
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
          const isDragging = dragServerIndex === idx
          const isDropBefore =
            dropServerTarget !== null &&
            dropServerTarget.index === idx &&
            dropServerTarget.position === 'before' &&
            dragServerIndex !== null &&
            dragServerIndex !== idx
          const isDropAfter =
            dropServerTarget !== null &&
            dropServerTarget.index === idx &&
            dropServerTarget.position === 'after' &&
            dragServerIndex !== null &&
            dragServerIndex !== idx

          return (
            <div
              key={server.id}
              data-rail-srv-index={idx}
              draggable={canReorderServers}
              className={`ag-rail-slot ${isDragging ? 'is-dragging' : ''} ${isDropBefore ? 'drop-before' : ''} ${isDropAfter ? 'drop-after' : ''}`}
              role="listitem"
              onDragStart={(e) => {
                if (!canReorderServers || touchDragRef.current?.active) {
                  e.preventDefault()
                  return
                }
                hideTooltip()
                setDragServerIndex(idx)
                e.dataTransfer.effectAllowed = 'move'
                try {
                  e.dataTransfer.setData('text/plain', server.id)
                } catch {
                  // Ignore browser dataTransfer restrictions
                }
              }}
              onDragOver={(e) => {
                if (dragServerIndex === null || !canReorderServers) return
                e.preventDefault()
                e.stopPropagation()
                e.dataTransfer.dropEffect = 'move'
                autoScrollRail(e.clientY)
                const rect = e.currentTarget.getBoundingClientRect()
                const pos: 'before' | 'after' =
                  e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                setDropServerTarget((prev) =>
                  prev && prev.index === idx && prev.position === pos
                    ? prev
                    : { index: idx, position: pos }
                )
              }}
              onDrop={(e) => {
                if (dragServerIndex === null || !canReorderServers) return
                e.preventDefault()
                e.stopPropagation()
                const rect = e.currentTarget.getBoundingClientRect()
                const pos: 'before' | 'after' =
                  e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                const toIndex = computeReorderToIndex(
                  dragServerIndex,
                  idx,
                  pos,
                  joinedServers.length
                )
                if (toIndex !== dragServerIndex) {
                  onPlaySound?.('click')
                  engine.servers.reorderJoinedServers(dragServerIndex, toIndex)
                }
                setDragServerIndex(null)
                setDropServerTarget(null)
              }}
              onDragEnd={() => {
                setDragServerIndex(null)
                setDropServerTarget(null)
              }}
            >
              <button
                type="button"
                data-no-swipe={canReorderServers ? 'true' : undefined}
                className={`ag-rail-tile compact ag-rail-srv ${active ? 'active' : ''} ${hasUnread ? 'has-unread' : ''}`}
                style={accentStyle}
                onClick={(e) => {
                  if (suppressNextClickRef.current) {
                    suppressNextClickRef.current = false
                    e.preventDefault()
                    e.stopPropagation()
                    return
                  }
                  onPlaySound?.('click')
                  if (workspace !== 'chat') onSelectWorkspace('chat')
                  onSelectServer(server.id)
                }}
                onContextMenu={(e) => {
                  if (touchDragRef.current?.active || dragServerIndex !== null) {
                    e.preventDefault()
                    return
                  }
                  openServerMenu(e, server)
                }}
                onKeyDown={(e) => {
                  if (!canReorderServers || !e.altKey) return
                  if (e.key === 'ArrowUp' && idx > 0) {
                    e.preventDefault()
                    onPlaySound?.('click')
                    engine.servers.reorderJoinedServers(idx, idx - 1)
                  } else if (e.key === 'ArrowDown' && idx < joinedServers.length - 1) {
                    e.preventDefault()
                    onPlaySound?.('click')
                    engine.servers.reorderJoinedServers(idx, idx + 1)
                  }
                }}
                onPointerDown={(e) => {
                  if (e.pointerType === 'mouse' || !canReorderServers) return
                  if (
                    touchDragRef.current?.timerId !== null &&
                    touchDragRef.current?.timerId !== undefined
                  ) {
                    window.clearTimeout(touchDragRef.current.timerId)
                  }
                  const pointerId = e.pointerId
                  const targetEl = e.currentTarget
                  const timerId = window.setTimeout(() => {
                    const drag = touchDragRef.current
                    if (!drag || drag.pointerId !== pointerId) return
                    drag.active = true
                    drag.timerId = null
                    if (suppressResetTimerRef.current !== null) {
                      window.clearTimeout(suppressResetTimerRef.current)
                      suppressResetTimerRef.current = null
                    }
                    suppressNextClickRef.current = true
                    hideTooltip()
                    try {
                      targetEl.setPointerCapture(pointerId)
                    } catch {
                      // Ignore capture errors
                    }
                    try {
                      navigator.vibrate?.(10)
                    } catch {
                      // Ignore unsupported vibrate
                    }
                    setDragServerIndex(idx)
                    setDropServerTarget({ index: idx, position: 'before' })
                  }, 220)
                  touchDragRef.current = {
                    pointerId,
                    fromIndex: idx,
                    startX: e.clientX,
                    startY: e.clientY,
                    active: false,
                    timerId,
                    targetIndex: idx,
                    position: 'before',
                  }
                }}
                onPointerMove={(e) => {
                  const drag = touchDragRef.current
                  if (!drag || drag.pointerId !== e.pointerId) return
                  if (!drag.active) {
                    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 8) {
                      if (drag.timerId !== null) window.clearTimeout(drag.timerId)
                      touchDragRef.current = null
                    }
                    return
                  }
                  e.preventDefault()
                  autoScrollRail(e.clientY)
                  const hit = hitTestRailServerSlot(e.clientY)
                  if (!hit) return
                  drag.targetIndex = hit.index
                  drag.position = hit.position
                  setDropServerTarget((prev) =>
                    prev && prev.index === hit.index && prev.position === hit.position ? prev : hit
                  )
                }}
                onPointerUp={(e) => {
                  const drag = touchDragRef.current
                  if (!drag || drag.pointerId !== e.pointerId) return
                  if (drag.timerId !== null) window.clearTimeout(drag.timerId)
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                    e.currentTarget.releasePointerCapture(e.pointerId)
                  }
                  if (drag.active) {
                    e.stopPropagation()
                    const toIndex = computeReorderToIndex(
                      drag.fromIndex,
                      drag.targetIndex,
                      drag.position,
                      joinedServers.length
                    )
                    if (toIndex !== drag.fromIndex) {
                      onPlaySound?.('click')
                      engine.servers.reorderJoinedServers(drag.fromIndex, toIndex)
                    }
                    scheduleSuppressReset()
                  }
                  touchDragRef.current = null
                  setDragServerIndex(null)
                  setDropServerTarget(null)
                }}
                onPointerCancel={(e) => {
                  const drag = touchDragRef.current
                  if (!drag || drag.pointerId !== e.pointerId) return
                  if (drag.timerId !== null) window.clearTimeout(drag.timerId)
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                    e.currentTarget.releasePointerCapture(e.pointerId)
                  }
                  if (drag.active) {
                    scheduleSuppressReset()
                  }
                  touchDragRef.current = null
                  setDragServerIndex(null)
                  setDropServerTarget(null)
                }}
                onMouseEnter={(e) => {
                  if (dragServerIndex === null) showTooltip(e.currentTarget, server.name, voiceSub)
                }}
                onMouseLeave={hideTooltip}
                onFocus={(e) => {
                  if (dragServerIndex === null) showTooltip(e.currentTarget, server.name, voiceSub)
                }}
                onBlur={hideTooltip}
                aria-label={voiceSub ? `${server.name} (${voiceSub})` : server.name}
                aria-current={active ? 'page' : undefined}
              >
                <span className="ag-rail-indicator" aria-hidden="true" />
                {hasUploadedGroupPicture(server.picture) && !failedIconUrls.has(server.picture!) ? (
                  <img
                    src={server.picture}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    draggable={false}
                    className="ag-rail-srv-img"
                    onError={() => markIconFailed(server.picture!)}
                  />
                ) : (
                  <span className="ag-rail-srv-mono mono ag-group-specifier" aria-hidden="true">
                    {getGroupSpecifier(server.name, server.icon)}
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

        <div className="ag-rail-slot">
          <UserProfileDock
            variant="rail"
            engine={engine}
            onOpenSettings={onOpenSettings}
            onOpenOwnAgoraProfile={onOpenOwnAgoraProfile}
            onPlaySound={onPlaySound}
            onTooltipShow={(el) => showTooltip(el, profileTooltipLabel, profileTooltipSub)}
            onTooltipHide={hideTooltip}
          />
        </div>
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
