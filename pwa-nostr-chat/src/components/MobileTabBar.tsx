import React from 'react'
import { Landmark, LayoutGrid, MessageCircle, Users, Waves } from 'lucide-react'
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
  suiteOpen?: boolean
  mapActive?: boolean
  settingsActive?: boolean
  onSelectAgora: () => void
  onSelectTab: (tab: ListTab) => void
  onToggleSuite: () => void
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
  suiteOpen = false,
  mapActive = false,
  settingsActive = false,
  onSelectAgora,
  onSelectTab,
  onToggleSuite,
}) => {
  const isAgoraActive = workspace === 'agora'
  const isBitchatActive = workspace === 'chat' && activeTab === 'bitchat'
  const isDmsActive = workspace === 'chat' && activeTab === 'dms'
  const isGroupsActive = workspace === 'chat' && activeTab === 'servers'
  const isAppsActive = Boolean(
    suiteOpen || workspace === 'mail' || workspace === 'wallet' || mapActive || settingsActive
  )

  return (
    <nav className="ag-mobile-tabbar" aria-label="Primary navigation">
      {/* 1. Agora */}
      <button
        type="button"
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
        className={`ag-mtab-btn ${isBitchatActive ? 'active' : ''}`}
        onClick={() => onSelectTab('bitchat')}
        aria-current={isBitchatActive ? 'page' : undefined}
      >
        <span className="ag-mtab-icon-wrap">
          <Waves size={19} strokeWidth={isBitchatActive ? 2.15 : 1.75} />
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

      {/* 5. Apps (Suite Launcher Sheet) */}
      <button
        type="button"
        className={`ag-mtab-btn ${isAppsActive ? 'active' : ''}`}
        onClick={onToggleSuite}
        aria-haspopup="dialog"
        aria-expanded={suiteOpen}
        aria-label={mailUnread > 0 ? `Apps (${mailUnread} unread Agmail)` : 'Apps'}
      >
        <span className="ag-mtab-icon-wrap">
          <LayoutGrid size={19} strokeWidth={isAppsActive ? 2.15 : 1.75} />
          {mailUnread > 0 && (
            <span
              className="ag-mtab-badge ping tabular"
              aria-label={`${mailUnread} unread Agmail`}
            >
              {formatBadgeCount(mailUnread)}
            </span>
          )}
        </span>
        <span className="ag-mtab-label">Apps</span>
      </button>
    </nav>
  )
}

export default MobileTabBar
