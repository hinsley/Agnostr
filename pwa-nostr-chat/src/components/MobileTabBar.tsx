import React from 'react'
import { Map as MapIcon, MessageCircle, Radio, Settings, Users } from 'lucide-react'
import type { ListTab } from './ConversationList'

export interface MobileTabBarProps {
  activeTab: ListTab
  mapActive?: boolean
  settingsActive?: boolean
  dmUnread: number
  serverUnread: number
  onSelectTab: (tab: ListTab) => void
  onOpenMap: () => void
  onOpenSettings: () => void
}

export const MobileTabBar: React.FC<MobileTabBarProps> = ({
  activeTab,
  mapActive = false,
  settingsActive = false,
  dmUnread,
  serverUnread,
  onSelectTab,
  onOpenMap,
  onOpenSettings,
}) => {
  const isSettingsActive = Boolean(settingsActive)
  const isMapActive = !isSettingsActive && Boolean(mapActive)
  const isRadioActive = !isSettingsActive && !isMapActive && activeTab === 'radio'
  const isDmsActive = !isSettingsActive && !isMapActive && activeTab === 'dms'
  const isServersActive = !isSettingsActive && !isMapActive && activeTab === 'servers'

  return (
    <nav className="ag-mobile-tabbar" aria-label="Primary navigation">
      <button
        type="button"
        className={`ag-mtab-btn ${isRadioActive ? 'active' : ''}`}
        onClick={() => onSelectTab('radio')}
        aria-current={isRadioActive ? 'page' : undefined}
      >
        <span className="ag-mtab-icon-wrap">
          <Radio size={20} strokeWidth={isRadioActive ? 2.2 : 1.8} />
        </span>
        <span className="ag-mtab-label">Radio</span>
      </button>

      <button
        type="button"
        className={`ag-mtab-btn dm ${isDmsActive ? 'active' : ''}`}
        onClick={() => onSelectTab('dms')}
        aria-current={isDmsActive ? 'page' : undefined}
      >
        <span className="ag-mtab-icon-wrap">
          <MessageCircle size={20} strokeWidth={isDmsActive ? 2.2 : 1.8} />
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
        className={`ag-mtab-btn ${isServersActive ? 'active' : ''}`}
        onClick={() => onSelectTab('servers')}
        aria-current={isServersActive ? 'page' : undefined}
      >
        <span className="ag-mtab-icon-wrap">
          <Users size={20} strokeWidth={isServersActive ? 2.2 : 1.8} />
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
        className={`ag-mtab-btn ${isMapActive ? 'active' : ''}`}
        onClick={onOpenMap}
        aria-current={isMapActive ? 'page' : undefined}
        aria-label="Open interactive Geohash Map"
      >
        <span className="ag-mtab-icon-wrap">
          <MapIcon size={20} strokeWidth={isMapActive ? 2.2 : 1.8} />
        </span>
        <span className="ag-mtab-label">Map</span>
      </button>

      <button
        type="button"
        className={`ag-mtab-btn ${isSettingsActive ? 'active' : ''}`}
        onClick={onOpenSettings}
        aria-current={isSettingsActive ? 'page' : undefined}
        aria-label="Open Settings"
      >
        <span className="ag-mtab-icon-wrap">
          <Settings size={20} strokeWidth={isSettingsActive ? 2.2 : 1.8} />
        </span>
        <span className="ag-mtab-label">Settings</span>
      </button>
    </nav>
  )
}

export default MobileTabBar
