import { useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import {
  ArrowLeft,
  Command,
  Compass,
  Database,
  Hash,
  Headphones,
  Loader2,
  Lock,
  MicOff,
  Palette,
  PanelLeftClose,
  Phone,
  PhoneOff,
  Plus,
  Radio,
  Server,
  Settings,
  ShieldCheck,
  UserPlus,
  Video,
  Volume2,
  X,
} from 'lucide-react'
import type { AgnostrEngine, InspectorTab, ThemeId } from '../types/protocol.ts'
import type { ServersEngine, ServerSummary } from '../types/servers.ts'
import type { SoundCue } from '../utils/sound.ts'
import { identiconDataUrl, pubkeyToColor } from '../utils/identicon.ts'
import type { ServerHubTab } from './ServerHubModal.tsx'
import type { ServerSettingsTab } from './ServerSettingsModal.tsx'

export interface ServerSidebarProps {
  engine: AgnostrEngine
  servers: ServersEngine
  server: ServerSummary
  activeChannelId: string
  open: boolean
  onClose: () => void
  onSelectChannel: (serverId: string, channelId: string) => void
  onBackToGeoRadio: () => void
  onOpenCommandPalette: () => void
  onOpenInspectorTab: (tab: InspectorTab) => void
  onOpenHub: (initialTab?: ServerHubTab) => void
  onOpenSettings: (serverId: string, initialTab?: ServerSettingsTab) => void
  onPlaySound?: (cue: SoundCue) => void
}

const THEME_ORDER: ThemeId[] = ['phosphor', 'amber', 'obsidian', 'daylight']

const THEME_LABELS: Record<ThemeId, string> = {
  phosphor: 'Phosphor',
  amber: 'Amber',
  obsidian: 'Obsidian',
  daylight: 'Daylight',
}

function stripWs(url: string): string {
  return url.replace(/^wss?:\/\//i, '').replace(/\/+$/, '')
}

function getMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'SV'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase()
}

export function ServerSidebar({
  engine,
  servers,
  server,
  activeChannelId,
  open,
  onClose,
  onSelectChannel,
  onBackToGeoRadio,
  onOpenCommandPalette,
  onOpenInspectorTab,
  onOpenHub,
  onOpenSettings,
  onPlaySound,
}: ServerSidebarProps) {
  const [addingChannel, setAddingChannel] = useState(false)
  const [channelNameDraft, setChannelNameDraft] = useState('')
  const [creatingChannel, setCreatingChannel] = useState(false)
  const [joiningNip29, setJoiningNip29] = useState(false)
  const [joiningVoice, setJoiningVoice] = useState<'audio' | 'video' | null>(null)

  const { calls } = engine
  const activeCall = calls.activeCall
  const isInThisServerCall =
    activeCall?.mode === 'server' && activeCall.serverId === server.id
  const callRoster = calls.serverCallRosters[server.id] ?? []
  const voiceParticipants = isInThisServerCall
    ? activeCall.participants.map((p) => ({
        pubkey: p.pubkey,
        displayHandle: p.displayHandle,
        hasVideo: p.videoEnabled || p.screenSharing,
        audioMuted: p.audioMuted,
        isSpeaking: p.isSpeaking,
        isRecording: p.isRecording,
      }))
    : callRoster.map((r) => ({
        pubkey: r.pubkey,
        displayHandle: r.displayHandle,
        hasVideo: r.hasVideo,
        audioMuted: r.audioMuted,
        isSpeaking: false,
        isRecording: Boolean(r.isRecording),
      }))
  const rawVoiceCount = calls.getServerCallCount(server.id)
  const voiceCount = isInThisServerCall
    ? Math.max(rawVoiceCount, activeCall.participants.length)
    : Math.max(rawVoiceCount, callRoster.length)
  const voiceMax = calls.maxParticipants
  const voiceFull = voiceCount >= voiceMax && !isInThisServerCall

  const handleJoinVoiceLounge = async (media: 'audio' | 'video') => {
    if (joiningVoice || voiceFull) return
    setJoiningVoice(media)
    try {
      const ok = await calls.joinServerCall(server.id, media)
      if (ok) {
        onPlaySound?.('call-join')
        if (window.matchMedia('(max-width: 1023px)').matches) {
          onClose()
        }
      }
    } finally {
      setJoiningVoice(null)
    }
  }

  const accentStyle = {
    '--srv-accent': server.accentColor || 'var(--accent)',
  } as CSSProperties

  const sameRelayGroups =
    server.kind === 'nip29' && server.relayUrl
      ? servers.joinedServers.filter(
          (s) => s.kind === 'nip29' && s.relayUrl === server.relayUrl && s.id !== server.id,
        )
      : []

  const cycleTheme = () => {
    const idx = THEME_ORDER.indexOf(engine.settings.theme)
    const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length]
    engine.setTheme(next)
    onPlaySound?.('click')
  }

  const handleAddChannel = async (e: FormEvent) => {
    e.preventDefault()
    const clean = channelNameDraft.trim().replace(/^#+/, '')
    if (!clean || creatingChannel) return
    setCreatingChannel(true)
    try {
      const ok = await servers.addChannel(server.id, clean)
      if (ok) {
        setChannelNameDraft('')
        setAddingChannel(false)
        onPlaySound?.('tune')
      }
    } finally {
      setCreatingChannel(false)
    }
  }

  const handleJoinNip29 = async () => {
    if (!server.relayUrl || !server.groupId || joiningNip29) return
    setJoiningNip29(true)
    try {
      await servers.joinNip29Group(server.relayUrl, server.groupId)
      onPlaySound?.('tune')
    } finally {
      setJoiningNip29(false)
    }
  }

  const handleExploreThisRelay = () => {
    onPlaySound?.('click')
    if (server.relayUrl) {
      void servers.exploreNip29Relay(server.relayUrl)
    }
    onOpenHub('explore')
  }

  return (
    <aside
      className={`ag-sidebar ag-server-sidebar ${open ? '' : 'collapsed'}`}
      style={accentStyle}
      aria-label={`${server.name} channels`}
    >
      {/* Server Header */}
      <div className="ag-srv-side-header">
        <div className="ag-srv-side-title-row">
          <div className="ag-srv-side-icon">
            {server.picture && /^https?:\/\//i.test(server.picture) ? (
              <img
                src={server.picture}
                alt=""
                className="ag-srv-side-img"
                referrerPolicy="no-referrer"
              />
            ) : server.icon ? (
              <span>{server.icon}</span>
            ) : (
              <span className="mono">{getMonogram(server.name)}</span>
            )}
          </div>

          <div className="ag-srv-side-heading">
            <span className="ag-srv-side-name truncate" title={server.name}>
              {server.name}
            </span>
            <div className="ag-srv-side-badges">
              {server.kind === 'nip29' ? (
                <span className="ag-badge ag-badge-mesh">
                  <Server size={9} />
                  <span>NIP-29</span>
                </span>
              ) : server.encrypted ? (
                <span className="ag-badge ag-badge-dm">
                  <Lock size={9} />
                  <span>E2EE</span>
                </span>
              ) : (
                <span className="ag-badge ag-badge-accent">PUBLIC</span>
              )}
              <span
                className="ag-badge ag-srv-saved-badge"
                title="Persistent history stored on relays — not ephemeral"
              >
                <Database size={9} />
                <span>SAVED</span>
              </span>
              {servers.myRole !== 'member' && (
                <span className="ag-badge ag-badge-ok">
                  <ShieldCheck size={9} />
                  <span>{servers.myRole.toUpperCase()}</span>
                </span>
              )}
            </div>
          </div>

          <div className="ag-srv-side-actions">
            <button
              type="button"
              className="ag-icon-btn"
              onClick={() => {
                onPlaySound?.('click')
                onOpenSettings(server.id, 'overview')
              }}
              title="Invite peers or configure server"
              aria-label="Invite peers"
            >
              <UserPlus size={15} />
            </button>
            <button
              type="button"
              className="ag-icon-btn"
              onClick={() => {
                onPlaySound?.('click')
                onOpenSettings(server.id, 'overview')
              }}
              title="Server Settings & Moderation"
              aria-label="Server settings"
            >
              <Settings size={15} />
            </button>
            <button
              type="button"
              className="ag-icon-btn"
              onClick={onClose}
              title="Collapse sidebar (Cmd+B)"
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose size={15} />
            </button>
          </div>
        </div>

        {(server.description || server.relayUrl) && (
          <div className="ag-srv-side-meta">
            {server.description && (
              <p className="ag-srv-side-desc">{server.description}</p>
            )}
            {server.kind === 'nip29' && server.relayUrl && (
              <span className="ag-srv-relay-pill mono truncate" title={server.relayUrl}>
                <Server size={10} />
                <span>{stripWs(server.relayUrl)}</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Cmd+K Trigger */}
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

        {server.kind === 'nip29' && server.isJoinedMember === false && (
          <button
            type="button"
            className="ag-btn ag-btn-primary ag-btn-block ag-btn-sm"
            onClick={() => void handleJoinNip29()}
            disabled={joiningNip29}
          >
            {joiningNip29 ? (
              <>
                <Loader2 size={13} className="ag-spin" />
                <span>Joining…</span>
              </>
            ) : (
              <>
                <UserPlus size={13} />
                <span>Join NIP-29 Community</span>
              </>
            )}
          </button>
        )}
      </div>

      {/* Channels List */}
      <div className="ag-sidebar-scroll">
        <section className="ag-side-section" aria-label="Server channels">
          <div className="ag-side-section-head">
            <span className="ag-side-section-title">
              {server.encrypted ? <Lock size={11} /> : <Hash size={11} />}
              <span>{server.kind === 'nip29' ? 'Community Room' : 'Channels'}</span>
            </span>

            {server.kind === 'virtual' && servers.canModerate && (
              <button
                type="button"
                className="ag-srv-add-ch-trigger"
                onClick={() => setAddingChannel((v) => !v)}
                title={addingChannel ? 'Cancel adding channel' : 'Create new channel'}
                aria-label={addingChannel ? 'Cancel adding channel' : 'Create new channel'}
              >
                {addingChannel ? <X size={12} /> : <Plus size={12} />}
              </button>
            )}
          </div>

          {addingChannel && server.kind === 'virtual' && (
            <form className="ag-srv-inline-add" onSubmit={(e) => void handleAddChannel(e)}>
              <input
                type="text"
                className="ag-input mono"
                placeholder="channel-name"
                maxLength={28}
                value={channelNameDraft}
                onChange={(e) => setChannelNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setAddingChannel(false)
                    setChannelNameDraft('')
                  }
                }}
                autoFocus
                disabled={creatingChannel}
                aria-label="New channel name"
              />
              <button
                type="submit"
                className="ag-btn ag-btn-primary ag-btn-sm"
                disabled={!channelNameDraft.trim() || creatingChannel}
              >
                {creatingChannel ? <Loader2 size={12} className="ag-spin" /> : 'Add'}
              </button>
            </form>
          )}

          {server.channels.map((ch) => {
            const isActive = ch.id === activeChannelId
            return (
              <button
                key={ch.id}
                type="button"
                className={`ag-chan-row ${server.encrypted ? 'dm' : ''} ${isActive ? 'active' : ''}`}
                onClick={() => {
                  onPlaySound?.('click')
                  onSelectChannel(server.id, ch.id)
                }}
                title={ch.topic || `#${ch.name}`}
              >
                <div className="ag-chan-left">
                  {server.encrypted ? (
                    <Lock size={13} style={{ color: 'var(--dm-accent)', flexShrink: 0 }} />
                  ) : (
                    <Hash size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  )}
                  <div className="ag-chan-meta">
                    <span className="ag-chan-name">{ch.name}</span>
                    {ch.topic && <span className="ag-chan-sub">{ch.topic}</span>}
                  </div>
                </div>

                {(ch.unreadCount ?? 0) > 0 && (
                  <div className="ag-chan-right">
                    <span className={`ag-unread-pill ${server.encrypted ? 'dm' : ''} tabular`}>
                      {ch.unreadCount}
                    </span>
                  </div>
                )}
              </button>
            )
          })}
        </section>

        {/* Live Voice & Video Lounge (up to 6 participants) */}
        <section className="ag-side-section" aria-label="Voice and video lounge">
          <div className="ag-side-section-head">
            <span className="ag-side-section-title">
              <Volume2 size={11} />
              <span>Voice &amp; Video</span>
            </span>
            <span
              className={`ag-badge mono ${
                voiceFull
                  ? 'ag-badge-warn'
                  : voiceCount > 0
                    ? 'ag-badge-ok'
                    : 'ag-badge-muted'
              }`}
              title={`${voiceCount} of ${voiceMax} peers in Voice Lounge`}
            >
              {voiceFull ? `FULL ${voiceCount}/${voiceMax}` : `${voiceCount}/${voiceMax}`}
            </span>
          </div>

          <div className={`ag-srv-voice-card ${isInThisServerCall ? 'in-call' : ''}`}>
            <div className="ag-srv-voice-room">
              <div className="ag-srv-voice-room-left">
                <Headphones size={13} />
                <span className="ag-srv-voice-room-name">Voice Lounge</span>
              </div>
              {isInThisServerCall ? (
                <span className="ag-badge ag-badge-ok">
                  <span className="ag-led ag-led-ok ag-led-pulse" />
                  <span>LIVE</span>
                </span>
              ) : voiceCount > 0 ? (
                <span className="ag-led ag-led-ok ag-led-pulse" aria-hidden="true" />
              ) : null}
            </div>

            {voiceParticipants.length > 0 && (
              <div className="ag-srv-voice-roster" role="list" aria-label="Voice lounge participants">
                {voiceParticipants.map((p) => (
                  <div
                    key={p.pubkey}
                    role="listitem"
                    className={`ag-srv-voice-peer ${p.isSpeaking ? 'speaking' : ''}`}
                  >
                    <img
                      src={identiconDataUrl(p.pubkey)}
                      alt=""
                      width={20}
                      height={20}
                      className="ag-srv-voice-avatar"
                    />
                    <span
                      className="ag-srv-voice-handle truncate"
                      style={{ color: pubkeyToColor(p.pubkey) }}
                      title={p.displayHandle}
                    >
                      {p.displayHandle}
                    </span>
                    <span className="ag-srv-voice-flags">
                      {p.hasVideo && (
                        <Video size={11} className="ag-srv-voice-flag video" aria-label="Video on" />
                      )}
                      {p.audioMuted && (
                        <MicOff size={11} className="ag-srv-voice-flag muted" aria-label="Muted" />
                      )}
                      {p.isRecording && (
                        <span
                          className="ag-srv-voice-rec-dot"
                          title={`${p.displayHandle} is recording this call`}
                          aria-label="Recording"
                        />
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="ag-srv-voice-actions">
              {isInThisServerCall ? (
                <>
                  <span className="ag-srv-voice-status">
                    <Radio size={12} />
                    <span>In Call</span>
                  </span>
                  <button
                    type="button"
                    className="ag-srv-voice-btn leave"
                    onClick={() => {
                      onPlaySound?.('call-leave')
                      calls.leaveCall()
                    }}
                    title="Leave Voice Lounge"
                  >
                    <PhoneOff size={12} />
                    <span>Leave</span>
                  </button>
                </>
              ) : voiceFull ? (
                <div className="ag-srv-voice-full mono">
                  Full ({voiceCount}/{voiceMax})
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="ag-srv-voice-btn join"
                    onClick={() => void handleJoinVoiceLounge('audio')}
                    disabled={joiningVoice !== null}
                    title="Join Voice Lounge (audio only)"
                  >
                    {joiningVoice === 'audio' ? (
                      <Loader2 size={12} className="ag-spin" />
                    ) : (
                      <Phone size={12} />
                    )}
                    <span>Join Voice</span>
                  </button>
                  <button
                    type="button"
                    className="ag-srv-voice-btn video"
                    onClick={() => void handleJoinVoiceLounge('video')}
                    disabled={joiningVoice !== null}
                    title="Join Voice Lounge with camera"
                  >
                    {joiningVoice === 'video' ? (
                      <Loader2 size={12} className="ag-spin" />
                    ) : (
                      <Video size={12} />
                    )}
                    <span>Join Video</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </section>

        {/* Other Joined Groups on the Same NIP-29 Relay */}
        {sameRelayGroups.length > 0 && (
          <section className="ag-side-section" aria-label="Other groups on this relay">
            <div className="ag-side-section-head">
              <span className="ag-side-section-title">
                <Server size={11} />
                <span>More on this Relay</span>
              </span>
            </div>
            {sameRelayGroups.map((other) => (
              <button
                key={other.id}
                type="button"
                className="ag-chan-row"
                onClick={() => {
                  onPlaySound?.('click')
                  servers.selectServer(other.id)
                }}
              >
                <div className="ag-chan-left">
                  <span className="ag-srv-mini-icon">
                    {other.icon || getMonogram(other.name)}
                  </span>
                  <div className="ag-chan-meta">
                    <span className="ag-chan-name">{other.name}</span>
                    {other.groupId && (
                      <span className="ag-chan-sub mono">{other.groupId}</span>
                    )}
                  </div>
                </div>
                {other.unreadCount > 0 && (
                  <div className="ag-chan-right">
                    <span className="ag-unread-pill tabular">{other.unreadCount}</span>
                  </div>
                )}
              </button>
            ))}
          </section>
        )}

        {/* Quick Navigation */}
        <section className="ag-side-section" aria-label="Workspace actions">
          <div className="ag-srv-quick-nav">
            {server.kind === 'nip29' && (
              <button
                type="button"
                className="ag-srv-nav-btn"
                onClick={handleExploreThisRelay}
              >
                <Compass size={13} />
                <span>Explore Relay Communities</span>
              </button>
            )}
            <button
              type="button"
              className="ag-srv-nav-btn"
              onClick={() => {
                onPlaySound?.('click')
                onBackToGeoRadio()
              }}
            >
              <ArrowLeft size={13} />
              <Radio size={13} />
              <span>Back to Geo Radio</span>
            </button>
          </div>
        </section>
      </div>

      {/* Bottom Operator Identity Footer */}
      <div className="ag-sidebar-footer">
        <button
          type="button"
          className="ag-me-card"
          onClick={() => onOpenInspectorTab('identity')}
          title="Open Identity & Trusted Peers Settings"
        >
          <img
            src={identiconDataUrl(engine.identity.activePubkey)}
            alt=""
            className="ag-avatar-sm"
          />
          <div className="ag-me-info">
            <span className="ag-me-handle">{engine.identity.activeDisplayHandle}</span>
            <span className="ag-me-mode">
              {engine.identity.signMode} · {servers.myRole}
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
            title="Identity & Trusted Peers Settings"
            aria-label="Open settings"
          >
            <Settings size={15} />
          </button>
        </div>
      </div>
    </aside>
  )
}

export default ServerSidebar
