import React from 'react'
import { Map as MapIcon, MessageCircle, Radio, Settings, Users } from 'lucide-react'
import type { ListTab } from './ConversationList'

export interface MobileTabBarProps {
  activeTab: ListTab
  dmUnread: number
  serverUnread: number
  onSelectTab: (tab: ListTab) => void
  onOpenMap: () => void
  onOpenSettings: () => void
}

export const MobileTabBar: React.FC<MobileTabBarProps> = ({
  activeTab,
  dmUnread,
  serverUnread,
  onSelectTab,
  onOpenMap,
  onOpenSettings,
}) => {
  return (
    <nav className="ag-mobile-tabbar" aria-label="Primary navigation">
      <button
        type="button"
        className={`ag-mtab-btn ${activeTab === 'radio' ? 'active' : ''}`}
        onClick={() => onSelectTab('radio')}
        aria-current={activeTab === 'radio' ? 'page' : undefined}
      >
        <span className="ag-mtab-icon-wrap">
          <Radio size={20} strokeWidth={activeTab === 'radio' ? 2.2 : 1.8} />
        </span>
        <span className="ag-mtab-label">Radio</span>
      </button>

      <button
        type="button"
        className={`ag-mtab-btn dm ${activeTab === 'dms' ? 'active' : ''}`}
        onClick={() => onSelectTab('dms')}
        aria-current={activeTab === 'dms' ? 'page' : undefined}
      >
        <span className="ag-mtab-icon-wrap">
          <MessageCircle size={20} strokeWidth={activeTab === 'dms' ? 2.2 : 1.8} />
          {dmUnread > 0 && (
            <span className="ag-mtab-badge dm tabular" aria-label={`${dmUnread} unread DMs`}>
              {dmUnread > 99 ? '99+' : dmUnread}
            </span>
          )}
        </span>
        <span className="ag-mtab-label">DMs</span>
      </button>

      <button
        type="button"
        className={`ag-mtab-btn ${activeTab === 'servers' ? 'active' : ''}`}
        onClick={() => onSelectTab('servers')}
        aria-current={activeTab === 'servers' ? 'page' : undefined}
      >
        <span className="ag-mtab-icon-wrap">
          <Users size={20} strokeWidth={activeTab === 'servers' ? 2.2 : 1.8} />
          {serverUnread > 0 && (
            <span className="ag-mtab-badge tabular" aria-label={`${serverUnread} unread server messages`}>
              {serverUnread > 99 ? '99+' : serverUnread}
            </span>
          )}
        </span>
        <span className="ag-mtab-label">Servers</span>
      </button>

      <button
        type="button"
        className="ag-mtab-btn"
        onClick={onOpenMap}
        aria-label="Open interactive Geohash Map"
      >
        <span className="ag-mtab-icon-wrap">
          <MapIcon size={20} strokeWidth={1.8} />
        </span>
        <span className="ag-mtab-label">Map</span>
      </button>

      <button
        type="button"
        className="ag-mtab-btn"
        onClick={onOpenSettings}
        aria-label="Open Settings"
      >
        <span className="ag-mtab-icon-wrap">
          <Settings size={20} strokeWidth={1.8} />
        </span>
        <span className="ag-mtab-label">Settings</span>
      </button>
    </nav>
  )
}

export default MobileTabBar
