import React from 'react'
import { Map as MapIcon, Radio, Server, Settings, Users } from 'lucide-react'
import type { ListTab } from './ConversationList'

export interface MobileTabBarProps {
  activeTab: ListTab
  mapActive?: boolean
  settingsActive?: boolean
  radioUnread?: number
  radioMentions?: number
  dmUnread: number
  serverUnread: number
  serverMentions?: number
  onSelectTab: (tab: ListTab) => void
  onOpenMap: () => void
  onOpenSettings: () => void
}

function formatBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

export const MobileTabBar: React.FC<MobileTabBarProps> = ({
  activeTab,
  mapActive = false,
  settingsActive = false,
  radioUnread = 0,
  radioMentions = 0,
  dmUnread,
  serverUnread,
  serverMentions = 0,
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
          <Server size={20} strokeWidth={isServersActive ? 2.2 : 1.8} />
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
          <Users size={20} strokeWidth={isDmsActive ? 2.2 : 1.8} />
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
