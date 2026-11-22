import React, { useState } from 'react'
import {
  Clock,
  Command,
  Crosshair,
  Globe,
  Lock,
  Map as MapIcon,
  PanelLeftClose,
  Palette,
  Radio,
  Settings,
  Star,
  MapPin,
} from 'lucide-react'
import type { AgnostrEngine, InspectorTab, ThemeId } from '../types/protocol'
import { identiconDataUrl } from '../utils/identicon'

const THEME_ORDER: ThemeId[] = ['phosphor', 'amber', 'obsidian', 'daylight']

const THEME_LABELS: Record<ThemeId, string> = {
  phosphor: 'Phosphor',
  amber: 'Amber',
  obsidian: 'Obsidian',
  daylight: 'Daylight',
}

function formatAgeMs(tsMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000))
  if (diffSec < 60) return 'live'
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h`
}

export interface SidebarProps {
  engine: AgnostrEngine
  open: boolean
  onClose: () => void
  onTuneChannel: (geohash: string) => boolean | void
  onOpenDm: (pubkey: string, nickname?: string) => void
  onOpenCommandPalette: () => void
  onOpenInspectorTab: (tab: InspectorTab) => void
  onExpandRadar?: () => void
  onLocateMe: () => void
}

export const Sidebar: React.FC<SidebarProps> = ({
  engine,
  open,
  onClose,
  onTuneChannel,
  onOpenDm,
  onOpenCommandPalette,
  onOpenInspectorTab,
  onExpandRadar,
  onLocateMe,
}) => {
  const [freqDraft, setFreqDraft] = useState('')

  const handleQuickTune = (e: React.FormEvent) => {
    e.preventDefault()
    const clean = freqDraft.trim()
    if (!clean) return
    const ok = onTuneChannel(clean)
    if (ok !== false) {
      setFreqDraft('')
    }
  }

  const cycleTheme = () => {
    const idx = THEME_ORDER.indexOf(engine.settings.theme)
    const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length]
    engine.setTheme(next)
  }

  const isChannelActive = (gh: string) =>
    engine.activeView.type === 'channel' && engine.activeView.geohash === gh

  const isDmActive = (pk: string) =>
    engine.activeView.type === 'dm' && engine.activeView.peerPubkey === pk

  const topPulseRooms = engine.pulseRooms.slice(0, 7)

  return (
    <aside
      className={`ag-sidebar ${open ? '' : 'collapsed'}`}
      aria-label="Channels and frequencies"
    >
      {/* Brand Lockup */}
      <div className="ag-sidebar-brand">
        <div className="ag-brand-lockup">
          <img src="./icon.svg" alt="Agnostr" className="ag-brand-logo" />
          <div className="ag-brand-text">
            <span className="ag-brand-name">AGNOSTR</span>
            <span className="ag-brand-sub">Ephemeral Geo Radio</span>
          </div>
        </div>
        <button
          type="button"
          className="ag-icon-btn"
          onClick={onClose}
          title="Collapse sidebar (Cmd+B)"
          aria-label="Collapse sidebar"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      {/* Cmd+K Trigger + Direct Geohash Tuner */}
      <div className="ag-sidebar-controls">
        <button
          type="button"
          className="ag-cmdk-trigger"
          onClick={onOpenCommandPalette}
        >
          <span className="ag-cmdk-trigger-left">
            <Command size={13} />
            <span>Jump, search, commands…</span>
          </span>
          <kbd className="ag-kbd">⌘K</kbd>
        </button>

        <form className="ag-quick-tune-form" onSubmit={handleQuickTune}>
          <div className="ag-quick-tune-wrap">
            <span className="ag-quick-tune-hash">#</span>
            <input
              type="text"
              className="ag-quick-tune-input"
              value={freqDraft}
              onChange={(e) => setFreqDraft(e.target.value)}
              placeholder="Tune geohash or city…"
              aria-label="Tune geohash or city"
            />
          </div>
          <button
            type="button"
            className={`ag-gps-mini-btn ${engine.location.status === 'locating' ? 'locating' : ''}`}
            onClick={onLocateMe}
            disabled={engine.location.status === 'locating'}
            title="GPS Locate Me — tune to your physical area"
            aria-label="Locate my area with GPS"
          >
            <Crosshair size={15} />
          </button>
          {onExpandRadar && (
            <button
              type="button"
              className="ag-gps-mini-btn"
              onClick={onExpandRadar}
              title="Open Full-Screen Geohash Radar Map"
              aria-label="Open Full-Screen Geohash Radar Map"
            >
              <MapIcon size={15} />
            </button>
          )}
        </form>
      </div>

      {/* Scrollable Frequency & DM Lists */}
      <div className="ag-sidebar-scroll">
        {/* Global Pulse Live Scanner */}
        <section className="ag-side-section" aria-label="Global Pulse">
          <div className="ag-side-section-head">
            <span className="ag-side-section-title">
              <span className="ag-led ok" />
              <span>Global Pulse</span>
            </span>
            <button
              type="button"
              className="mono"
              style={{
                fontSize: 10,
                color: 'var(--accent)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
              }}
              onClick={() => (onExpandRadar ? onExpandRadar() : onOpenInspectorTab('radar'))}
              title="Open full-screen interactive Geohash Radar Map"
            >
              <MapIcon size={11} />
              <span>RADAR MAP</span>
            </button>
          </div>
          {topPulseRooms.length === 0 ? (
            <div className="ag-side-empty">
              Scanning global Nostr relays for active geohash chatter…
            </div>
          ) : (
            topPulseRooms.map((room) => (
              <button
                key={room.geohash}
                type="button"
                className={`ag-chan-row ${isChannelActive(room.geohash) ? 'active' : ''}`}
                onClick={() => onTuneChannel(room.geohash)}
                title={room.lastPreview || `Tune #${room.geohash}`}
              >
                <div className="ag-chan-left">
                  <Radio size={13} style={{ color: 'var(--status-ok)', flexShrink: 0 }} />
                  <div className="ag-chan-meta">
                    <div className="ag-chan-title-line">
                      <span className="ag-chan-hash">#{room.geohash}</span>
                      {room.nearestCity && (
                        <span className="ag-chan-sub">{room.nearestCity}</span>
                      )}
                    </div>
                    <span className="ag-chan-sub">
                      {room.peerCount > 0
                        ? `${room.peerCount} ${room.peerCount === 1 ? 'peer' : 'peers'}`
                        : `${room.messageCount} ${room.messageCount === 1 ? 'msg' : 'msgs'}`}
                      {room.lastPreview ? ` · ${room.lastPreview}` : ''}
                    </span>
                  </div>
                </div>
                <div className="ag-chan-right">
                  <span className="ag-pulse-rate tabular">{formatAgeMs(room.lastActivityAt)}</span>
                </div>
              </button>
            ))
          )}
        </section>

        {/* Pinned Frequencies */}
        {engine.pinnedChannels.length > 0 && (
          <section className="ag-side-section" aria-label="Pinned channels">
            <div className="ag-side-section-head">
              <span className="ag-side-section-title">
                <Star size={11} />
                <span>Pinned</span>
              </span>
              <span className="tabular">{engine.pinnedChannels.length}</span>
            </div>
            {engine.pinnedChannels.map((pin) => (
              <button
                key={pin.geohash}
                type="button"
                className={`ag-chan-row ${isChannelActive(pin.geohash) ? 'active' : ''}`}
                onClick={() => onTuneChannel(pin.geohash)}
              >
                <div className="ag-chan-left">
                  <span className="ag-chan-hash">#{pin.geohash}</span>
                  {pin.label && <span className="ag-chan-sub">{pin.label}</span>}
                </div>
                <div className="ag-chan-right">
                  {pin.mentionCount > 0 && (
                    <span className="ag-unread-pill tabular">@{pin.mentionCount}</span>
                  )}
                  {pin.unreadCount > 0 && (
                    <span className="ag-unread-pill tabular">{pin.unreadCount}</span>
                  )}
                </div>
              </button>
            ))}
          </section>
        )}

        {/* Encrypted Direct Messages */}
        <section className="ag-side-section" aria-label="Direct messages">
          <div className="ag-side-section-head">
            <span className="ag-side-section-title">
              <Lock size={11} />
              <span>Encrypted DMs</span>
            </span>
            {engine.totalDmUnread > 0 && (
              <span className="ag-unread-pill dm tabular">{engine.totalDmUnread}</span>
            )}
          </div>
          {engine.dmThreads.length === 0 ? (
            <div className="ag-side-empty">Click any peer handle to start an E2EE DM.</div>
          ) : (
            engine.dmThreads.map((thread) => (
              <button
                key={thread.peerPubkey}
                type="button"
                className={`ag-chan-row dm ${isDmActive(thread.peerPubkey) ? 'active' : ''}`}
                onClick={() => onOpenDm(thread.peerPubkey, thread.peerNickname)}
              >
                <div className="ag-chan-left">
                  <img
                    src={identiconDataUrl(thread.peerPubkey)}
                    alt=""
                    className="ag-avatar-sm"
                    style={{ width: 22, height: 22, borderRadius: 6 }}
                  />
                  <div className="ag-chan-meta">
                    <span className="ag-chan-name">{thread.peerDisplayHandle}</span>
                    {thread.lastPreview && (
                      <span className="ag-chan-sub">{thread.lastPreview}</span>
                    )}
                  </div>
                </div>
                <div className="ag-chan-right">
                  {thread.unreadCount > 0 && (
                    <span className="ag-unread-pill dm tabular">{thread.unreadCount}</span>
                  )}
                </div>
              </button>
            ))
          )}
        </section>

        {/* Quick-Tune Cities & Lounges */}
        <section className="ag-side-section" aria-label="Quick Cities">
          <div className="ag-side-section-head">
            <span className="ag-side-section-title">
              <Globe size={11} />
              <span>Quick Frequencies</span>
            </span>
          </div>
          {engine.quickCities.map((city) => (
            <button
              key={city.geohash}
              type="button"
              className={`ag-chan-row ${isChannelActive(city.geohash) ? 'active' : ''}`}
              onClick={() => onTuneChannel(city.geohash)}
            >
              <div className="ag-chan-left">
                <MapPin
                  size={13}
                  style={{
                    color: city.isLounge ? 'var(--accent-secondary)' : 'var(--text-muted)',
                    flexShrink: 0,
                  }}
                />
                <div className="ag-chan-meta">
                  <div className="ag-chan-title-line">
                    <span className="ag-chan-name">{city.name}</span>
                  </div>
                  <span className="ag-chan-sub">{city.region}</span>
                </div>
              </div>
              <span className="ag-chan-hash" style={{ fontSize: 11.5 }}>
                #{city.geohash}
              </span>
            </button>
          ))}
        </section>

        {/* Recent History */}
        {engine.recentChannels.length > 0 && (
          <section className="ag-side-section" aria-label="Recent frequencies">
            <div className="ag-side-section-head">
              <span className="ag-side-section-title">
                <Clock size={11} />
                <span>Recent</span>
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', padding: '0.2rem 0.35rem' }}>
              {engine.recentChannels.slice(0, 8).map((gh) => (
                <button
                  key={gh}
                  type="button"
                  className={`ag-geo-step ${isChannelActive(gh) ? 'active' : ''}`}
                  onClick={() => onTuneChannel(gh)}
                >
                  #{gh}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Bottom User Identity & Quick Theme Switcher */}
      <div className="ag-sidebar-footer">
        <button
          type="button"
          className="ag-me-card"
          onClick={() => onOpenInspectorTab('identity')}
          title="Open Identity & Settings"
        >
          <img
            src={identiconDataUrl(engine.identity.activePubkey)}
            alt=""
            className="ag-avatar-sm"
          />
          <div className="ag-me-info">
            <span className="ag-me-handle">{engine.identity.activeDisplayHandle}</span>
            <span className="ag-me-mode">
              {engine.identity.signMode}
              {engine.identity.perGeohashIdentity ? ' · per-geo' : ''}
            </span>
          </div>
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
          <button
            type="button"
            className="ag-icon-btn"
            onClick={cycleTheme}
            title={`Theme: ${THEME_LABELS[engine.settings.theme]} (click to cycle)`}
            aria-label="Cycle color theme"
          >
            <Palette size={15} />
          </button>
          <button
            type="button"
            className="ag-icon-btn"
            onClick={() => onOpenInspectorTab('identity')}
            title="Identity & Settings"
            aria-label="Open settings"
          >
            <Settings size={15} />
          </button>
        </div>
      </div>
    </aside>
  )
}

export default Sidebar
