import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  Landmark,
  LayoutGrid,
  Mail,
  Map as MapIcon,
  MessageCircle,
  Search,
  Settings,
  Users,
  Wallet,
  Waves,
  X,
} from 'lucide-react'
import { useBackHandler } from '../hooks/useBackNavigation'
import type { SoundCue } from '../utils/sound'
import type { ActiveWorkspace } from './AppRail'
import type { ListTab } from './ConversationList'

export interface SuiteLauncherProps {
  open: boolean
  variant: 'popover' | 'sheet'
  workspace: ActiveWorkspace
  listTab: ListTab
  mapActive: boolean
  settingsActive: boolean
  agoraUnread?: number
  bitchatUnread?: number
  bitchatMentions?: number
  dmUnread?: number
  serverUnread?: number
  serverMentions?: number
  mailUnread?: number
  walletSats?: number
  onClose: () => void
  onSelectAgora: () => void
  onSelectBitchat: () => void
  onSelectPeople: () => void
  onSelectGroups: () => void
  onSelectMail: () => void
  onSelectWallet: () => void
  onOpenMap: () => void
  onOpenSearch: () => void
  onOpenSettings: () => void
  onPlaySound?: (cue: SoundCue) => void
}

function formatBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

interface SuiteAppCardDef {
  id: string
  name: string
  subtitle: string
  shortcut: string
  active: boolean
  tone?: 'accent' | 'dm'
  badgeCount?: number
  badgeKind?: 'ping' | 'unread'
  icon: React.ReactNode
  onSelect: () => void
}

export const SuiteLauncher: React.FC<SuiteLauncherProps> = ({
  open,
  variant,
  workspace,
  listTab,
  mapActive,
  settingsActive,
  agoraUnread = 0,
  bitchatUnread = 0,
  bitchatMentions = 0,
  dmUnread = 0,
  serverUnread = 0,
  serverMentions = 0,
  mailUnread = 0,
  walletSats = 0,
  onClose,
  onSelectAgora,
  onSelectBitchat,
  onSelectPeople,
  onSelectGroups,
  onSelectMail,
  onSelectWallet,
  onOpenMap,
  onOpenSearch,
  onOpenSettings,
  onPlaySound,
}) => {
  useBackHandler(open, onClose)

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  const trigger = (fn: () => void) => {
    onPlaySound?.('click')
    onClose()
    fn()
  }

  const isAgoraActive = workspace === 'agora'
  const isBitchatActive = workspace === 'chat' && listTab === 'bitchat'
  const isPeopleActive = workspace === 'chat' && listTab === 'dms'
  const isGroupsActive = workspace === 'chat' && listTab === 'servers'
  const isMailActive = workspace === 'mail'
  const isWalletActive = workspace === 'wallet'

  const apps: SuiteAppCardDef[] = [
    {
      id: 'agora',
      name: 'Agora',
      subtitle: 'Public square',
      shortcut: 'Alt+1',
      active: isAgoraActive,
      badgeCount: agoraUnread > 0 ? agoraUnread : undefined,
      badgeKind: agoraUnread > 0 ? 'ping' : undefined,
      icon: <Landmark size={19} strokeWidth={isAgoraActive ? 2.15 : 1.85} />,
      onSelect: onSelectAgora,
    },
    {
      id: 'bitchat',
      name: 'Bitchat',
      subtitle: 'Geohash & topics',
      shortcut: 'Alt+2',
      active: isBitchatActive,
      badgeCount: bitchatMentions > 0 ? bitchatMentions : bitchatUnread > 0 ? bitchatUnread : undefined,
      badgeKind: bitchatMentions > 0 ? 'ping' : bitchatUnread > 0 ? 'unread' : undefined,
      icon: <Waves size={19} strokeWidth={isBitchatActive ? 2.15 : 1.85} />,
      onSelect: onSelectBitchat,
    },
    {
      id: 'people',
      name: 'People',
      subtitle: 'Encrypted DMs',
      shortcut: 'Alt+3',
      active: isPeopleActive,
      tone: 'dm',
      badgeCount: dmUnread > 0 ? dmUnread : undefined,
      badgeKind: dmUnread > 0 ? 'ping' : undefined,
      icon: <MessageCircle size={19} strokeWidth={isPeopleActive ? 2.15 : 1.85} />,
      onSelect: onSelectPeople,
    },
    {
      id: 'groups',
      name: 'Groups',
      subtitle: 'Communities & voice',
      shortcut: 'Alt+4',
      active: isGroupsActive,
      badgeCount: serverMentions > 0 ? serverMentions : serverUnread > 0 ? serverUnread : undefined,
      badgeKind: serverMentions > 0 ? 'ping' : serverUnread > 0 ? 'unread' : undefined,
      icon: <Users size={19} strokeWidth={isGroupsActive ? 2.15 : 1.85} />,
      onSelect: onSelectGroups,
    },
    {
      id: 'mail',
      name: 'Agmail',
      subtitle: 'Encrypted mail',
      shortcut: 'Alt+5',
      active: isMailActive,
      badgeCount: mailUnread > 0 ? mailUnread : undefined,
      badgeKind: mailUnread > 0 ? 'ping' : undefined,
      icon: <Mail size={19} strokeWidth={isMailActive ? 2.15 : 1.85} />,
      onSelect: onSelectMail,
    },
    {
      id: 'wallet',
      name: 'Agwallet',
      subtitle: walletSats > 0 ? `${walletSats.toLocaleString()} sats` : 'Ecash & Bitcoin',
      shortcut: 'Alt+6',
      active: isWalletActive,
      icon: <Wallet size={19} strokeWidth={isWalletActive ? 2.15 : 1.85} />,
      onSelect: onSelectWallet,
    },
  ]

  const isPopover = variant === 'popover'

  const content = (
    <div
      className={`ag-suite-backdrop ${isPopover ? 'popover' : 'sheet'}`}
      onClick={onClose}
      role="presentation"
    >
      <div
        className={isPopover ? 'ag-suite-popover' : 'ag-suite-sheet'}
        role="dialog"
        aria-modal={!isPopover}
        aria-label="Agnostr Suite"
        onClick={(e) => e.stopPropagation()}
      >
        {!isPopover && <div className="ag-suite-sheet-handle" aria-hidden="true" />}

        <div className="ag-suite-head">
          <div className="ag-suite-title-wrap">
            <span className="ag-suite-crest" aria-hidden="true">
              <LayoutGrid size={13} strokeWidth={2.2} />
            </span>
            <span className="ag-suite-title">Agnostr Suite</span>
          </div>
          <button
            type="button"
            className="ag-suite-close"
            onClick={() => {
              onPlaySound?.('click')
              onClose()
            }}
            aria-label="Close app launcher"
          >
            <X size={15} />
          </button>
        </div>

        <div className="ag-suite-grid" role="navigation" aria-label="Agnostr apps">
          {apps.map((app) => (
            <button
              key={app.id}
              type="button"
              className={`ag-suite-card ${app.tone === 'dm' ? 'dm' : ''} ${app.active ? 'active' : ''}`}
              onClick={() => trigger(app.onSelect)}
              aria-current={app.active ? 'page' : undefined}
            >
              <div className="ag-suite-card-top">
                <span className="ag-suite-card-icon" aria-hidden="true">
                  {app.icon}
                </span>
                {app.badgeCount ? (
                  <span
                    className={`ag-suite-card-badge tabular ${app.badgeKind === 'ping' ? 'ping' : 'unread'}`}
                  >
                    {formatBadgeCount(app.badgeCount)}
                  </span>
                ) : isPopover ? (
                  <span className="ag-suite-card-kbd mono" aria-hidden="true">
                    {app.shortcut}
                  </span>
                ) : null}
              </div>
              <div className="ag-suite-card-copy">
                <span className="ag-suite-card-name truncate">{app.name}</span>
                <span className="ag-suite-card-sub truncate">{app.subtitle}</span>
              </div>
            </button>
          ))}
        </div>

        <div className="ag-suite-divider" aria-hidden="true" />

        <div className="ag-suite-footer" role="group" aria-label="Suite utilities">
          <button
            type="button"
            className={`ag-suite-util-btn ${mapActive ? 'active' : ''}`}
            onClick={() => trigger(onOpenMap)}
            aria-pressed={mapActive}
          >
            <MapIcon size={14} strokeWidth={mapActive ? 2.15 : 1.85} />
            <span>Radar Map</span>
          </button>

          <button
            type="button"
            className="ag-suite-util-btn"
            onClick={() => trigger(onOpenSearch)}
          >
            <Search size={14} strokeWidth={1.85} />
            <span>Search</span>
            {isPopover && (
              <span className="ag-suite-util-kbd mono" aria-hidden="true">
                ⌘K
              </span>
            )}
          </button>

          <button
            type="button"
            className={`ag-suite-util-btn ${settingsActive ? 'active' : ''}`}
            onClick={() => trigger(onOpenSettings)}
            aria-pressed={settingsActive}
          >
            <Settings size={14} strokeWidth={settingsActive ? 2.15 : 1.85} />
            <span>Settings</span>
            {isPopover && (
              <span className="ag-suite-util-kbd mono" aria-hidden="true">
                ⌘,
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(content, document.body)
}

export default SuiteLauncher
