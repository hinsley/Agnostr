import React, { useEffect, useRef } from 'react'
import {
  Globe,
  Landmark,
  Mail,
  MessageCircle,
  Settings,
  Users,
  Wallet,
} from 'lucide-react'
import type { ActiveWorkspace } from './AppRail'
import type { ListTab } from './ConversationList'

export interface MobileTabBarProps {
  workspace: ActiveWorkspace
  activeTab: ListTab
  agoraUnread?: number
  bitchatUnread?: number
  bitchatMentions?: number
  dmUnread: number
  serverUnread: number
  serverMentions?: number
  mailUnread?: number
  settingsActive?: boolean
  onSelectAgora: () => void
  onSelectTab: (tab: ListTab) => void
  onSelectMail: () => void
  onSelectWallet: () => void
  onOpenSettings: () => void
}

function formatBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

export const MobileTabBar: React.FC<MobileTabBarProps> = ({
  workspace,
  activeTab,
  agoraUnread = 0,
  bitchatUnread = 0,
  bitchatMentions = 0,
  dmUnread,
  serverUnread,
  serverMentions = 0,
  mailUnread = 0,
  settingsActive = false,
  onSelectAgora,
  onSelectTab,
  onSelectMail,
  onSelectWallet,
  onOpenSettings,
}) => {
  const navRef = useRef<HTMLElement | null>(null)
  const hasMountedRef = useRef(false)

  const isAgoraActive = !settingsActive && workspace === 'agora'
  const isBitchatActive = !settingsActive && workspace === 'chat' && activeTab === 'bitchat'
  const isDmsActive = !settingsActive && workspace === 'chat' && activeTab === 'dms'
  const isGroupsActive = !settingsActive && workspace === 'chat' && activeTab === 'servers'
  const isMailActive = !settingsActive && workspace === 'mail'
  const isWalletActive = !settingsActive && workspace === 'wallet'
  const isSettingsActive = Boolean(settingsActive)

  const activeKey = isSettingsActive
    ? 'settings'
    : isAgoraActive
      ? 'agora'
      : isMailActive
        ? 'mail'
        : isWalletActive
          ? 'wallet'
          : isDmsActive
            ? 'dms'
            : isGroupsActive
              ? 'servers'
              : 'bitchat'

  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const activeBtn = nav.querySelector<HTMLElement>(`[data-mtab-id="${activeKey}"]`)
    if (!activeBtn) return
    try {
      activeBtn.scrollIntoView({
        behavior: hasMountedRef.current ? 'smooth' : 'auto',
        inline: 'nearest',
        block: 'nearest',
      })
    } catch {
      // Ignore scrollIntoView option errors on older WebViews
    }
    hasMountedRef.current = true
  }, [activeKey])

  return (
    <nav
      ref={navRef}
      className="ag-mobile-tabbar"
      data-no-swipe="true"
      aria-label="Primary navigation"
    >
      {/* 1. Agora */}
      <button
        type="button"
        data-mtab-id="agora"
        className={`ag-mtab-btn ${isAgoraActive ? 'active' : ''}`}
        onClick={onSelectAgora}
        aria-current={isAgoraActive ? 'page' : undefined}
        aria-label={agoraUnread > 0 ? `Agora (${agoraUnread} unread)` : 'Agora'}
      >
        <span className="ag-mtab-icon-wrap">
          <Landmark size={19} strokeWidth={isAgoraActive ? 2.15 : 1.75} />
          {agoraUnread > 0 && (
            <span
              className="ag-mtab-badge ping tabular"
              aria-label={`${agoraUnread} unread Agora notifications`}
            >
              {formatBadgeCount(agoraUnread)}
            </span>
          )}
        </span>
        <span className="ag-mtab-label">Agora</span>
      </button>

      {/* 2. Bitchat */}
      <button
        type="button"
        data-mtab-id="bitchat"
        className={`ag-mtab-btn ${isBitchatActive ? 'active' : ''}`}
        onClick={() => onSelectTab('bitchat')}
        aria-current={isBitchatActive ? 'page' : undefined}
      >
        <span className="ag-mtab-icon-wrap">
          <Globe size={19} strokeWidth={isBitchatActive ? 2.15 : 1.75} />
          {bitchatMentions > 0 ? (
            <span
              className="ag-mtab-badge ping tabular"
              aria-label={`${bitchatMentions} Bitchat pings`}
            >
              {formatBadgeCount(bitchatMentions)}
            </span>
          ) : bitchatUnread > 0 ? (
            <span
              className="ag-mtab-badge unread tabular"
              aria-label={`${bitchatUnread} unread Bitchat messages`}
            >
              {formatBadgeCount(bitchatUnread)}
            </span>
          ) : null}
        </span>
        <span className="ag-mtab-label">Bitchat</span>
      </button>

      {/* 3. People */}
      <button
        type="button"
        data-mtab-id="dms"
        className={`ag-mtab-btn dm ${isDmsActive ? 'active' : ''}`}
        onClick={() => onSelectTab('dms')}
        aria-current={isDmsActive ? 'page' : undefined}
      >
        <span className="ag-mtab-icon-wrap">
          <MessageCircle size={19} strokeWidth={isDmsActive ? 2.15 : 1.75} />
          {dmUnread > 0 && (
            <span
              className="ag-mtab-badge ping tabular"
              aria-label={`${dmUnread} unread messages`}
            >
              {formatBadgeCount(dmUnread)}
            </span>
          )}
        </span>
        <span className="ag-mtab-label">People</span>
      </button>

      {/* 4. Groups */}
      <button
        type="button"
        data-mtab-id="servers"
        className={`ag-mtab-btn ${isGroupsActive ? 'active' : ''}`}
        onClick={() => onSelectTab('servers')}
        aria-current={isGroupsActive ? 'page' : undefined}
      >
        <span className="ag-mtab-icon-wrap">
          <Users size={19} strokeWidth={isGroupsActive ? 2.15 : 1.75} />
          {serverMentions > 0 ? (
            <span
              className="ag-mtab-badge ping tabular"
              aria-label={`${serverMentions} group pings`}
            >
              {formatBadgeCount(serverMentions)}
            </span>
          ) : serverUnread > 0 ? (
            <span
              className="ag-mtab-badge unread tabular"
              aria-label={`${serverUnread} unread group messages`}
            >
              {formatBadgeCount(serverUnread)}
            </span>
          ) : null}
        </span>
        <span className="ag-mtab-label">Groups</span>
      </button>

      {/* 5. Agmail */}
      <button
        type="button"
        data-mtab-id="mail"
        className={`ag-mtab-btn ${isMailActive ? 'active' : ''}`}
        onClick={onSelectMail}
        aria-current={isMailActive ? 'page' : undefined}
        aria-label={mailUnread > 0 ? `Agmail (${mailUnread} unread)` : 'Agmail'}
      >
        <span className="ag-mtab-icon-wrap">
          <Mail size={19} strokeWidth={isMailActive ? 2.15 : 1.75} />
          {mailUnread > 0 && (
            <span
              className="ag-mtab-badge ping tabular"
              aria-label={`${mailUnread} unread Agmail`}
            >
              {formatBadgeCount(mailUnread)}
            </span>
          )}
        </span>
        <span className="ag-mtab-label">Agmail</span>
      </button>

      {/* 6. Agwallet */}
      <button
        type="button"
        data-mtab-id="wallet"
        className={`ag-mtab-btn ${isWalletActive ? 'active' : ''}`}
        onClick={onSelectWallet}
        aria-current={isWalletActive ? 'page' : undefined}
        aria-label="Agwallet"
      >
        <span className="ag-mtab-icon-wrap">
          <Wallet size={19} strokeWidth={isWalletActive ? 2.15 : 1.75} />
        </span>
        <span className="ag-mtab-label">Agwallet</span>
      </button>

      {/* 7. Settings */}
      <button
        type="button"
        data-mtab-id="settings"
        className={`ag-mtab-btn ${isSettingsActive ? 'active' : ''}`}
        onClick={onOpenSettings}
        aria-current={isSettingsActive ? 'page' : undefined}
        aria-label="Settings"
      >
        <span className="ag-mtab-icon-wrap">
          <Settings size={19} strokeWidth={isSettingsActive ? 2.15 : 1.75} />
        </span>
        <span className="ag-mtab-label">Settings</span>
      </button>
    </nav>
  )
}

export default MobileTabBar
