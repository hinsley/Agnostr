import React from 'react'
import { Mail, MessageCircle, Radio, Server, Wallet } from 'lucide-react'
import type { ActiveWorkspace } from './AppRail'
import type { ListTab } from './ConversationList'

export interface MobileTabBarProps {
  workspace: ActiveWorkspace
  activeTab: ListTab
  radioUnread?: number
  radioMentions?: number
  dmUnread: number
  serverUnread: number
  serverMentions?: number
  mailUnread?: number
  onSelectTab: (tab: ListTab) => void
  onSelectMail: () => void
  onSelectWallet: () => void
}

function formatBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

export const MobileTabBar: React.FC<MobileTabBarProps> = ({
  workspace,
  activeTab,
  radioUnread = 0,
  radioMentions = 0,
  dmUnread,
  serverUnread,
  serverMentions = 0,
  mailUnread = 0,
  onSelectTab,
  onSelectMail,
  onSelectWallet,
}) => {
  const isRadioActive = workspace === 'chat' && activeTab === 'radio'
  const isServersActive = workspace === 'chat' && activeTab === 'servers'
  const isDmsActive = workspace === 'chat' && activeTab === 'dms'
  const isMailActive = workspace === 'mail'
  const isWalletActive = workspace === 'wallet'

  return (
    <nav className="ag-mobile-tabbar" aria-label="Primary navigation">
      <button
        type="button"
        className={`ag-mtab-btn ${isRadioActive ? 'active' : ''}`}
        onClick={() => onSelectTab('radio')}
        aria-current={isRadioActive ? 'page' : undefined}
      >
        <span className="ag-mtab-icon-wrap">
          <Radio size={20} strokeWidth={isRadioActive ? 2.15 : 1.75} />
          {radioMentions > 0 ? (
            <span
              className="ag-mtab-badge ping tabular"
              aria-label={`${radioMentions} radio pings`}
            >
              {formatBadgeCount(radioMentions)}
            </span>
          ) : radioUnread > 0 ? (
            <span
              className="ag-mtab-badge unread tabular"
              aria-label={`${radioUnread} unread radio messages`}
            >
              {formatBadgeCount(radioUnread)}
            </span>
          ) : null}
        </span>
        <span className="ag-mtab-label">Radio</span>
      </button>

      <button
        type="button"
        className={`ag-mtab-btn ${isServersActive ? 'active' : ''}`}
        onClick={() => onSelectTab('servers')}
        aria-current={isServersActive ? 'page' : undefined}
      >
        <span className="ag-mtab-icon-wrap">
          <Server size={20} strokeWidth={isServersActive ? 2.15 : 1.75} />
          {serverMentions > 0 ? (
            <span
              className="ag-mtab-badge ping tabular"
              aria-label={`${serverMentions} server pings`}
            >
              {formatBadgeCount(serverMentions)}
            </span>
          ) : serverUnread > 0 ? (
            <span
              className="ag-mtab-badge unread tabular"
              aria-label={`${serverUnread} unread server messages`}
            >
              {formatBadgeCount(serverUnread)}
            </span>
          ) : null}
        </span>
        <span className="ag-mtab-label">Servers</span>
      </button>

      <button
        type="button"
        className={`ag-mtab-btn dm ${isDmsActive ? 'active' : ''}`}
        onClick={() => onSelectTab('dms')}
        aria-current={isDmsActive ? 'page' : undefined}
      >
        <span className="ag-mtab-icon-wrap">
          <MessageCircle size={20} strokeWidth={isDmsActive ? 2.15 : 1.75} />
          {dmUnread > 0 && (
            <span className="ag-mtab-badge ping tabular" aria-label={`${dmUnread} unread messages`}>
              {formatBadgeCount(dmUnread)}
            </span>
          )}
        </span>
        <span className="ag-mtab-label">People</span>
      </button>

      <button
        type="button"
        className={`ag-mtab-btn ${isMailActive ? 'active' : ''}`}
        onClick={onSelectMail}
        aria-current={isMailActive ? 'page' : undefined}
        aria-label={mailUnread > 0 ? `Mail (${mailUnread} unread)` : 'Mail'}
      >
        <span className="ag-mtab-icon-wrap">
          <Mail size={20} strokeWidth={isMailActive ? 2.15 : 1.75} />
          {mailUnread > 0 && (
            <span
              className="ag-mtab-badge ping tabular"
              aria-label={`${mailUnread} unread mail`}
            >
              {formatBadgeCount(mailUnread)}
            </span>
          )}
        </span>
        <span className="ag-mtab-label">Mail</span>
      </button>

      <button
        type="button"
        className={`ag-mtab-btn ${isWalletActive ? 'active' : ''}`}
        onClick={onSelectWallet}
        aria-current={isWalletActive ? 'page' : undefined}
        aria-label="Wallet"
      >
        <span className="ag-mtab-icon-wrap">
          <Wallet size={20} strokeWidth={isWalletActive ? 2.15 : 1.75} />
        </span>
        <span className="ag-mtab-label">Wallet</span>
      </button>
    </nav>
  )
}

export default MobileTabBar
