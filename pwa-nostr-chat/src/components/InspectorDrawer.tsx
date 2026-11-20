import { useEffect, useRef } from 'react'
import {
  Activity,
  Fingerprint,
  Radar,
  StickyNote,
  Users,
  X,
} from 'lucide-react'
import type { AgnostrEngine, InspectorTab, PeerInfo } from '../types/protocol.ts'
import type { SoundCue } from '../utils/sound.ts'
import { GeoRadarPanel } from './GeoRadarPanel.tsx'
import { IdentitySettingsPanel } from './IdentitySettingsPanel.tsx'
import { LocationNotesPanel } from './LocationNotesPanel.tsx'
import { PeersPanel } from './PeersPanel.tsx'
import { RelayTelemetryPanel } from './RelayTelemetryPanel.tsx'

export type { InspectorTab }

export interface InspectorDrawerProps {
  engine: AgnostrEngine
  activeTab: InspectorTab
  onTabChange: (tab: InspectorTab) => void
  open: boolean
  onClose: () => void
  onInspectPeer: (peer: PeerInfo) => void
  onMentionPeer: (handle: string) => void
  onStartDm: (pubkey: string, nickname?: string) => void
  onTuneChannel: (geohash: string) => void
  onPlaySound?: (cue: SoundCue) => void
}

const TAB_DEFS: readonly {
  id: InspectorTab
  label: string
  shortLabel: string
}[] = [
  { id: 'radar', label: 'Geo Radar', shortLabel: 'Radar' },
  { id: 'peers', label: 'Peers', shortLabel: 'Peers' },
  { id: 'notes', label: 'Location Notes', shortLabel: 'Notes' },
  { id: 'relays', label: 'Relays', shortLabel: 'Relays' },
  { id: 'identity', label: 'Identity & Settings', shortLabel: 'ID' },
]

export function InspectorDrawer({
  engine,
  activeTab,
  onTabChange,
  open,
  onClose,
  onInspectPeer,
  onMentionPeer,
  onStartDm,
  onTuneChannel,
  onPlaySound,
}: InspectorDrawerProps) {
  const { presence, locationNotes, connectedRelayCount, totalRelayCount } = engine
  const bodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0
    }
  }, [activeTab, open])

  const handleSelectTab = (tab: InspectorTab) => {
    if (tab !== activeTab) {
      onPlaySound?.('click')
      onTabChange(tab)
    }
  }

  const renderTabIcon = (id: InspectorTab) => {
    switch (id) {
      case 'radar':
        return <Radar size={14} />
      case 'peers':
        return <Users size={14} />
      case 'notes':
        return <StickyNote size={14} />
      case 'relays':
        return <Activity size={14} />
      case 'identity':
        return <Fingerprint size={14} />
    }
  }

  const relayDotClass =
    connectedRelayCount > 0
      ? 'ag-led-ok'
      : totalRelayCount > 0
        ? 'ag-led-warn'
        : 'ag-led-danger'

  const activeTitle = TAB_DEFS.find((t) => t.id === activeTab)?.label ?? 'Inspector'

  return (
    <>
      {open && (
        <div
          className="ag-inspector-backdrop"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={`ag-inspector ${open ? 'open' : 'collapsed'}`}
        aria-label="Channel telemetry and settings"
        aria-hidden={!open}
      >
        <div className="ag-inspector-header">
          <div className="ag-inspector-title-row">
            <span className="ag-inspector-heading">{activeTitle}</span>
            <button
              type="button"
              className="ag-icon-btn-sm"
              onClick={onClose}
              title="Close inspector (Cmd+I)"
              aria-label="Close inspector drawer"
            >
              <X size={15} />
            </button>
          </div>

          <nav className="ag-inspector-tabs" role="tablist" aria-label="Inspector sections">
            {TAB_DEFS.map((tab) => {
              const selected = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={`ag-inspector-tab ${selected ? 'active' : ''}`}
                  onClick={() => handleSelectTab(tab.id)}
                  title={tab.label}
                >
                  <span className="ag-inspector-tab-icon">
                    {renderTabIcon(tab.id)}
                    {tab.id === 'relays' && (
                      <span className={`ag-tab-dot ag-led ${relayDotClass}`} />
                    )}
                    {tab.id === 'peers' && (presence.isUncertainCount || presence.onlineCount > 0) && (
                      <span className="ag-tab-count mono">
                        {presence.isUncertainCount ? '?' : presence.onlineCount}
                      </span>
                    )}
                    {tab.id === 'notes' && locationNotes.length > 0 && (
                      <span className="ag-tab-count mono">{locationNotes.length}</span>
                    )}
                  </span>
                  <span className="ag-inspector-tab-label">{tab.shortLabel}</span>
                </button>
              )
            })}
          </nav>
        </div>

        <div ref={bodyRef} className="ag-inspector-body">
          {activeTab === 'radar' && (
            <GeoRadarPanel
              engine={engine}
              onTuneChannel={onTuneChannel}
              onPlaySound={onPlaySound}
            />
          )}
          {activeTab === 'peers' && (
            <PeersPanel
              engine={engine}
              onInspectPeer={onInspectPeer}
              onStartDm={onStartDm}
              onMentionPeer={onMentionPeer}
            />
          )}
          {activeTab === 'notes' && (
            <LocationNotesPanel engine={engine} onPlaySound={onPlaySound} />
          )}
          {activeTab === 'relays' && (
            <RelayTelemetryPanel engine={engine} onPlaySound={onPlaySound} />
          )}
          {activeTab === 'identity' && (
            <IdentitySettingsPanel engine={engine} onPlaySound={onPlaySound} />
          )}
        </div>
      </aside>
    </>
  )
}

export default InspectorDrawer
