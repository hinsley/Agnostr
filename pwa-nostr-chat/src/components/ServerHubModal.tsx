import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import {
  Check,
  Compass,
  Globe,
  Hash,
  Link2,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  Sparkles,
  Users,
  X,
} from 'lucide-react'
import type {
  Nip29GroupMeta,
  ServerInvite,
  ServersEngine,
  ServerSummary,
} from '../types/servers.ts'
import type { SoundCue } from '../utils/sound.ts'
import { identiconDataUrl, shortPubkey } from '../utils/identicon.ts'

export type ServerHubTab = 'create' | 'join' | 'explore'

export interface ServerHubModalProps {
  open: boolean
  initialTab?: ServerHubTab
  servers: ServersEngine
  onClose: () => void
  onJoinedServer?: (server: ServerSummary) => void
  onPlaySound?: (cue: SoundCue) => void
}

type CreateKindMode = 'virtual-public' | 'virtual-e2ee' | 'nip29'

const EMOJI_CHOICES = [
  '📡', '🔐', '⚡', '🛰️', '🛡️', '🌐',
  '🔥', '🧪', '🎯', '🧭', '🎙️', '🏴‍☠️',
] as const

const ACCENT_CHOICES = [
  { id: 'emerald', hex: '#22E584', label: 'Emerald' },
  { id: 'sky', hex: '#38BDF8', label: 'Cyan' },
  { id: 'violet', hex: '#A78BFA', label: 'Violet' },
  { id: 'amber', hex: '#F5A623', label: 'Amber' },
  { id: 'rose', hex: '#FB7185', label: 'Coral' },
  { id: 'teal', hex: '#2DD4BF', label: 'Teal' },
] as const

function stripWs(url: string): string {
  return url.replace(/^wss?:\/\//i, '').replace(/\/+$/, '')
}

function getMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'SV'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase()
}

export function ServerHubModal({
  open,
  initialTab = 'create',
  servers,
  onClose,
  onJoinedServer,
  onPlaySound,
}: ServerHubModalProps) {
  const [tab, setTab] = useState<ServerHubTab>(initialTab)

  // Create Server state
  const [createMode, setCreateMode] = useState<CreateKindMode>('virtual-e2ee')
  const [nameDraft, setNameDraft] = useState('')
  const [descDraft, setDescDraft] = useState('')
  const [iconDraft, setIconDraft] = useState('📡')
  const [accentDraft, setAccentDraft] = useState<string>(ACCENT_CHOICES[0].hex)
  const [channelsDraft, setChannelsDraft] = useState<string[]>(['general', 'voice-drops', 'off-topic'])
  const [newChannelDraft, setNewChannelDraft] = useState('')
  const [nip29CreateRelay, setNip29CreateRelay] = useState('')
  const [nip29Private, setNip29Private] = useState(false)
  const [nip29Closed, setNip29Closed] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Join Invite state
  const [inviteDraft, setInviteDraft] = useState('')
  const [joiningInvite, setJoiningInvite] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)

  // Explore NIP-29 state
  const [customExploreRelay, setCustomExploreRelay] = useState('')
  const [exploreQuery, setExploreQuery] = useState('')
  const [joiningGroupId, setJoiningGroupId] = useState<string | null>(null)

  const createSupportedPresets = useMemo(
    () => servers.nip29Presets.filter((p) => p.supportsCreate),
    [servers.nip29Presets],
  )

  // Sync tab & pending invite on open
  useEffect(() => {
    if (!open) return
    if (servers.pendingInvite) {
      setTab('join')
      setInviteDraft(servers.pendingInvite.rawCode)
      setJoinError(null)
    } else {
      setTab(initialTab)
    }
  }, [open, initialTab, servers.pendingInvite])

  // Default NIP-29 creation relay
  useEffect(() => {
    if (!nip29CreateRelay && createSupportedPresets.length > 0) {
      setNip29CreateRelay(createSupportedPresets[0].url)
    }
  }, [nip29CreateRelay, createSupportedPresets])

  // Auto-load Explore relay when switching to Explore tab
  useEffect(() => {
    if (!open || tab !== 'explore') return
    if (servers.exploredGroups.length === 0 && !servers.exploringRelay && !servers.exploreError) {
      const target = servers.exploredRelayUrl || servers.nip29Presets[0]?.url
      if (target) {
        void servers.exploreNip29Relay(target)
      }
    }
  }, [
    open,
    tab,
    servers,
  ])

  // Escape key closes modal
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (servers.pendingInvite) servers.clearPendingInvite()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, servers])

  const parsedInvite: ServerInvite | null = useMemo(() => {
    const trimmed = inviteDraft.trim()
    if (!trimmed) return servers.pendingInvite
    return servers.parseInviteInput(trimmed)
  }, [inviteDraft, servers])

  const joinedKeySet = useMemo(() => {
    const set = new Set<string>()
    for (const s of servers.joinedServers) {
      if (s.kind === 'nip29' && s.relayUrl && s.groupId) {
        set.add(`${s.relayUrl}::${s.groupId}`)
      }
    }
    return set
  }, [servers.joinedServers])

  const filteredExploredGroups = useMemo(() => {
    const q = exploreQuery.trim().toLowerCase()
    if (!q) return servers.exploredGroups
    return servers.exploredGroups.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        g.about.toLowerCase().includes(q) ||
        g.groupId.toLowerCase().includes(q),
    )
  }, [servers.exploredGroups, exploreQuery])

  if (!open) return null

  const handleDismiss = () => {
    if (servers.pendingInvite) servers.clearPendingInvite()
    onClose()
  }

  const handleAddInitialChannel = () => {
    const clean = newChannelDraft
      .trim()
      .toLowerCase()
      .replace(/^#+/, '')
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (!clean) return
    if (!channelsDraft.includes(clean)) {
      setChannelsDraft((prev) => [...prev, clean])
    }
    setNewChannelDraft('')
  }

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const cleanName = nameDraft.trim()
    if (!cleanName) {
      setCreateError('Give your server a name')
      return
    }
    setCreateError(null)

    if (createMode === 'nip29') {
      const relay = nip29CreateRelay.trim()
      if (!relay || !/^wss?:\/\//i.test(relay)) {
        setCreateError('Select or enter a valid wss:// NIP-29 relay URL')
        return
      }
      const created = await servers.createNip29Group({
        relayUrl: relay,
        name: cleanName,
        about: descDraft.trim() || undefined,
        icon: iconDraft.trim() || undefined,
        accentColor: accentDraft,
        isPrivate: nip29Private,
        isClosed: nip29Closed,
      })
      if (created) {
        onPlaySound?.('tune')
        setNameDraft('')
        setDescDraft('')
        onJoinedServer?.(created)
        onClose()
      } else {
        setCreateError('Relay did not accept group creation. Try another open NIP-29 relay.')
      }
      return
    }

    const created = await servers.createVirtualServer({
      name: cleanName,
      description: descDraft.trim() || undefined,
      icon: iconDraft.trim() || undefined,
      accentColor: accentDraft,
      encrypted: createMode === 'virtual-e2ee',
      channels: channelsDraft,
    })

    if (created) {
      onPlaySound?.('tune')
      setNameDraft('')
      setDescDraft('')
      onJoinedServer?.(created)
      onClose()
    } else {
      setCreateError('Failed to publish server manifest. Check relay connectivity.')
    }
  }

  const handleJoinInviteSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!parsedInvite) {
      setJoinError('Paste a valid #invite= link, ag1… invite code, or wss://relay\'groupId')
      return
    }
    setJoinError(null)
    setJoiningInvite(true)
    try {
      const joined = await servers.joinFromInvite(parsedInvite)
      if (joined) {
        onPlaySound?.('tune')
        setInviteDraft('')
        servers.clearPendingInvite()
        onJoinedServer?.(joined)
        onClose()
      } else {
        setJoinError('Could not join server from this invite.')
      }
    } finally {
      setJoiningInvite(false)
    }
  }

  const handleExploreCustomRelay = (e: FormEvent) => {
    e.preventDefault()
    const raw = customExploreRelay.trim()
    if (!raw) return
    const normalized = /^wss?:\/\//i.test(raw) ? raw : `wss://${raw}`
    onPlaySound?.('click')
    void servers.exploreNip29Relay(normalized)
  }

  const handleJoinExploredGroup = async (group: Nip29GroupMeta) => {
    const existing = servers.joinedServers.find(
      (s) => s.kind === 'nip29' && s.relayUrl === group.relayUrl && s.groupId === group.groupId,
    )
    if (existing) {
      servers.selectServer(existing.id)
      onPlaySound?.('click')
      onJoinedServer?.(existing)
      onClose()
      return
    }

    setJoiningGroupId(group.groupId)
    try {
      const joined = await servers.joinNip29Group(group.relayUrl, group.groupId, group)
      if (joined) {
        onPlaySound?.('tune')
        onJoinedServer?.(joined)
        onClose()
      }
    } finally {
      setJoiningGroupId(null)
    }
  }

  return (
    <div className="ag-modal-backdrop" onClick={handleDismiss} role="presentation">
      <div
        className="ag-srv-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-srv-hub-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="ag-srv-modal-head">
          <div className="ag-srv-modal-title-group">
            <h2 id="ag-srv-hub-title" className="ag-srv-modal-title">
              Servers &amp; Communities
            </h2>
            <p className="ag-srv-modal-sub">
              Create or join a Nostr server.
            </p>
          </div>
          <button
            type="button"
            className="ag-icon-btn-sm"
            onClick={handleDismiss}
            aria-label="Close server hub"
          >
            <X size={15} />
          </button>
        </div>

        {/* 3 Primary Tabs */}
        <div className="ag-segmented ag-srv-hub-tabs" role="tablist" aria-label="Server hub sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'create'}
            className={tab === 'create' ? 'active' : ''}
            onClick={() => {
              onPlaySound?.('click')
              setTab('create')
            }}
          >
            <Sparkles size={12} />
            <span>Create Server</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'join'}
            className={tab === 'join' ? 'active' : ''}
            onClick={() => {
              onPlaySound?.('click')
              setTab('join')
            }}
          >
            <Link2 size={12} />
            <span>Join via Invite</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'explore'}
            className={tab === 'explore' ? 'active' : ''}
            onClick={() => {
              onPlaySound?.('click')
              setTab('explore')
            }}
          >
            <Compass size={12} />
            <span>Explore NIP-29</span>
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="ag-srv-modal-body">
          {/* TAB 1: CREATE SERVER */}
          {tab === 'create' && (
            <form className="ag-srv-form" onSubmit={(e) => void handleCreateSubmit(e)}>
              {/* Mode Selector */}
              <div className="ag-srv-mode-grid" role="radiogroup" aria-label="Server type">
                <button
                  type="button"
                  role="radio"
                  aria-checked={createMode === 'virtual-e2ee'}
                  className={`ag-srv-mode-card ${createMode === 'virtual-e2ee' ? 'active e2ee' : ''}`}
                  title="End-to-end encrypted channels & voice memos with an invite-only key"
                  onClick={() => {
                    setCreateMode('virtual-e2ee')
                    setIconDraft('🔐')
                    setAccentDraft('#A78BFA')
                  }}
                >
                  <div className="ag-srv-mode-top">
                    <Lock size={14} />
                    <span>E2EE Private</span>
                  </div>
                  <span className="ag-srv-mode-desc">Invite-only</span>
                </button>

                <button
                  type="button"
                  role="radio"
                  aria-checked={createMode === 'virtual-public'}
                  className={`ag-srv-mode-card ${createMode === 'virtual-public' ? 'active' : ''}`}
                  title="Multi-channel public server across standard Nostr relays"
                  onClick={() => {
                    setCreateMode('virtual-public')
                    setIconDraft('📡')
                    setAccentDraft('#22E584')
                  }}
                >
                  <div className="ag-srv-mode-top">
                    <Globe size={14} />
                    <span>Instant Public</span>
                  </div>
                  <span className="ag-srv-mode-desc">Open chat</span>
                </button>

                <button
                  type="button"
                  role="radio"
                  aria-checked={createMode === 'nip29'}
                  className={`ag-srv-mode-card ${createMode === 'nip29' ? 'active nip29' : ''}`}
                  title="Relay-enforced moderated community on a NIP-29 server"
                  onClick={() => {
                    setCreateMode('nip29')
                    setIconDraft('🛰️')
                    setAccentDraft('#38BDF8')
                  }}
                >
                  <div className="ag-srv-mode-top">
                    <Server size={14} />
                    <span>NIP-29 Relay</span>
                  </div>
                  <span className="ag-srv-mode-desc">Moderated</span>
                </button>
              </div>

              {/* Name & Description */}
              <div className="ag-srv-field-row">
                <div>
                  <label className="ag-field-label" htmlFor="ag-srv-name-input">
                    Server Name
                  </label>
                  <input
                    id="ag-srv-name-input"
                    type="text"
                    maxLength={48}
                    className="ag-input"
                    placeholder={
                      createMode === 'virtual-e2ee'
                        ? 'Field Ops Cell'
                        : createMode === 'nip29'
                          ? 'Mesh Builders'
                          : 'Bay Area Radio'
                    }
                    value={nameDraft}
                    onChange={(e) => {
                      setNameDraft(e.target.value)
                      if (createError) setCreateError(null)
                    }}
                    required
                  />
                </div>
              </div>

              <div>
                <label className="ag-field-label" htmlFor="ag-srv-desc-input">
                  Description (optional)
                </label>
                <input
                  id="ag-srv-desc-input"
                  type="text"
                  maxLength={140}
                  className="ag-input"
                  placeholder="Short topic or rules for members…"
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                />
              </div>

              {/* Icon & Accent Color */}
              <div className="ag-srv-customize-grid">
                <div>
                  <span className="ag-field-label">Icon</span>
                  <div className="ag-emoji-grid">
                    {EMOJI_CHOICES.map((em) => (
                      <button
                        key={em}
                        type="button"
                        className={`ag-emoji-pill ${iconDraft === em ? 'active' : ''}`}
                        onClick={() => setIconDraft(em)}
                      >
                        {em}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <span className="ag-field-label">Accent Color</span>
                  <div className="ag-color-swatches">
                    {ACCENT_CHOICES.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`ag-color-swatch ${accentDraft === c.hex ? 'active' : ''}`}
                        style={{ backgroundColor: c.hex }}
                        onClick={() => setAccentDraft(c.hex)}
                        title={c.label}
                        aria-label={c.label}
                      >
                        {accentDraft === c.hex && <Check size={12} />}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Virtual Server Channels Editor */}
              {createMode !== 'nip29' ? (
                <div>
                  <span className="ag-field-label">Initial Channels</span>
                  <div className="ag-channel-chips">
                    {channelsDraft.map((ch) => (
                      <span key={ch} className="ag-srv-edit-chip mono">
                        <Hash size={10} />
                        <span>{ch}</span>
                        {ch !== 'general' && (
                          <button
                            type="button"
                            className="ag-srv-chip-rm"
                            onClick={() =>
                              setChannelsDraft((prev) => prev.filter((item) => item !== ch))
                            }
                            aria-label={`Remove #${ch}`}
                          >
                            <X size={10} />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                  <div className="ag-jump-form" style={{ marginTop: '0.38rem' }}>
                    <input
                      type="text"
                      className="ag-input mono"
                      placeholder="Add #channel (e.g. alerts)"
                      maxLength={24}
                      value={newChannelDraft}
                      onChange={(e) => setNewChannelDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          handleAddInitialChannel()
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="ag-btn ag-btn-secondary"
                      onClick={handleAddInitialChannel}
                      disabled={!newChannelDraft.trim()}
                    >
                      <Plus size={13} />
                      <span>Add</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="ag-srv-nip29-create-box">
                  <label className="ag-field-label" htmlFor="ag-nip29-create-relay">
                    Host NIP-29 Relay
                  </label>
                  <div className="ag-srv-preset-pills">
                    {servers.nip29Presets.map((preset) => (
                      <button
                        key={preset.url}
                        type="button"
                        className={`ag-city-chip ${nip29CreateRelay === preset.url ? 'active' : ''}`}
                        onClick={() => setNip29CreateRelay(preset.url)}
                        title={preset.description}
                      >
                        <Server size={10} />
                        <span>{preset.name}</span>
                        {preset.supportsCreate && (
                          <span className="ag-badge ag-badge-ok">OPEN</span>
                        )}
                      </button>
                    ))}
                  </div>
                  <input
                    id="ag-nip29-create-relay"
                    type="text"
                    className="ag-input mono"
                    placeholder="wss://relay.epochshield.com"
                    value={nip29CreateRelay}
                    onChange={(e) => setNip29CreateRelay(e.target.value)}
                  />
                  <div className="ag-srv-inline-toggles">
                    <label className="ag-srv-check-pill">
                      <input
                        type="checkbox"
                        checked={nip29Private}
                        onChange={(e) => setNip29Private(e.target.checked)}
                      />
                      <span>Private (members read)</span>
                    </label>
                    <label className="ag-srv-check-pill">
                      <input
                        type="checkbox"
                        checked={nip29Closed}
                        onChange={(e) => setNip29Closed(e.target.checked)}
                      />
                      <span>Closed (invite/admin only)</span>
                    </label>
                  </div>
                </div>
              )}

              {createError && <p className="ag-field-hint ag-field-hint-danger">{createError}</p>}

              <div className="ag-srv-modal-footer">
                <button type="button" className="ag-btn ag-btn-ghost" onClick={handleDismiss}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="ag-btn ag-btn-primary"
                  disabled={servers.creating || !nameDraft.trim()}
                >
                  {servers.creating ? (
                    <>
                      <Loader2 size={14} className="ag-spin" />
                      <span>Creating…</span>
                    </>
                  ) : (
                    <>
                      <Sparkles size={14} />
                      <span>
                        {createMode === 'virtual-e2ee'
                          ? 'Create E2EE Server'
                          : createMode === 'nip29'
                            ? 'Create NIP-29 Group'
                            : 'Create Public Server'}
                      </span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* TAB 2: JOIN VIA INVITE */}
          {tab === 'join' && (
            <form className="ag-srv-form" onSubmit={(e) => void handleJoinInviteSubmit(e)}>
              <div>
                <label className="ag-field-label" htmlFor="ag-srv-invite-input">
                  Invite Link, Code, or NIP-29 Address
                </label>
                <textarea
                  id="ag-srv-invite-input"
                  className="ag-textarea mono"
                  rows={3}
                  placeholder="Paste https://…/#invite=ag1…, ag1… code, or wss://groups.hzrd149.com'test"
                  value={inviteDraft}
                  onChange={(e) => {
                    setInviteDraft(e.target.value)
                    if (joinError) setJoinError(null)
                  }}
                />
              </div>

              {parsedInvite ? (
                <div
                  className="ag-srv-invite-preview"
                  style={
                    {
                      '--srv-accent': parsedInvite.accentColor || 'var(--accent)',
                    } as CSSProperties
                  }
                >
                  <div className="ag-srv-preview-head">
                    <div className="ag-srv-info-avatar">
                      {parsedInvite.icon ? (
                        <span>{parsedInvite.icon}</span>
                      ) : (
                        <span className="mono">{getMonogram(parsedInvite.name)}</span>
                      )}
                    </div>
                    <div className="ag-srv-info-meta">
                      <span className="ag-srv-info-name truncate">{parsedInvite.name}</span>
                      <div className="ag-srv-info-badges">
                        {parsedInvite.kind === 'nip29' ? (
                          <span className="ag-badge ag-badge-mesh">
                            <Server size={9} />
                            <span>NIP-29</span>
                          </span>
                        ) : parsedInvite.encrypted ? (
                          <span className="ag-badge ag-badge-dm">
                            <Lock size={9} />
                            <span>E2EE AES-256-GCM</span>
                          </span>
                        ) : (
                          <span className="ag-badge ag-badge-accent">PUBLIC SERVER</span>
                        )}
                        {parsedInvite.channels && parsedInvite.channels.length > 0 && (
                          <span className="ag-badge ag-badge-muted">
                            {parsedInvite.channels.length}{' '}
                            {parsedInvite.channels.length === 1 ? 'channel' : 'channels'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {parsedInvite.description && (
                    <p className="ag-field-hint">{parsedInvite.description}</p>
                  )}

                  {parsedInvite.relayUrl && (
                    <div className="ag-srv-preview-meta mono">
                      <Server size={11} />
                      <span>
                        {stripWs(parsedInvite.relayUrl)} · {parsedInvite.id}
                      </span>
                    </div>
                  )}

                  {parsedInvite.inviterPubkey && (
                    <div className="ag-srv-preview-inviter">
                      <img
                        src={identiconDataUrl(parsedInvite.inviterPubkey)}
                        alt=""
                        width={20}
                        height={20}
                        className="ag-srv-tiny-avatar"
                      />
                      <span className="mono">
                        Invited by {shortPubkey(parsedInvite.inviterPubkey, 8, 6)}
                      </span>
                    </div>
                  )}

                  <div className="ag-safety-notice">
                    <ShieldAlert size={13} />
                    <span>
                      Joining connects to the server&apos;s relays. Voice memos &amp; media still
                      require <strong>trusting the sender</strong> (zero bytes fetched until trusted).
                    </span>
                  </div>
                </div>
              ) : inviteDraft.trim().length > 0 ? (
                <p className="ag-field-hint ag-field-hint-warn">
                  Unrecognized invite format — paste a full Agnostr <code className="mono">#invite=ag1…</code>{' '}
                  link or NIP-29 <code className="mono">relay&apos;groupId</code>.
                </p>
              ) : (
                <p className="ag-field-hint">
                  You&apos;ll see a full preview of the server, encryption mode, and relay before
                  joining.
                </p>
              )}

              {joinError && <p className="ag-field-hint ag-field-hint-danger">{joinError}</p>}

              <div className="ag-srv-modal-footer">
                <button type="button" className="ag-btn ag-btn-ghost" onClick={handleDismiss}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="ag-btn ag-btn-primary"
                  disabled={!parsedInvite || joiningInvite}
                >
                  {joiningInvite ? (
                    <>
                      <Loader2 size={14} className="ag-spin" />
                      <span>Joining…</span>
                    </>
                  ) : (
                    <>
                      <Link2 size={14} />
                      <span>Join Server</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* TAB 3: EXPLORE NIP-29 RELAYS */}
          {tab === 'explore' && (
            <div className="ag-srv-explore">
              {/* Preset NIP-29 Relays */}
              <div className="ag-srv-preset-pills">
                {servers.nip29Presets.map((preset) => {
                  const active = servers.exploredRelayUrl === preset.url
                  return (
                    <button
                      key={preset.url}
                      type="button"
                      className={`ag-city-chip ${active ? 'active' : ''}`}
                      onClick={() => {
                        onPlaySound?.('click')
                        void servers.exploreNip29Relay(preset.url)
                      }}
                      title={`${preset.url} — ${preset.description}`}
                    >
                      <Server size={10} />
                      <span>{preset.name}</span>
                      {preset.supportsCreate && <span className="ag-badge ag-badge-ok">NEW</span>}
                    </button>
                  )
                })}
              </div>

              {/* Custom NIP-29 Relay Input */}
              <form className="ag-jump-form" onSubmit={handleExploreCustomRelay}>
                <input
                  type="text"
                  className="ag-input mono"
                  placeholder="Custom wss:// NIP-29 relay…"
                  value={customExploreRelay}
                  onChange={(e) => setCustomExploreRelay(e.target.value)}
                  aria-label="Custom NIP-29 relay URL"
                />
                <button
                  type="submit"
                  className="ag-btn ag-btn-secondary"
                  disabled={!customExploreRelay.trim() || servers.exploringRelay}
                >
                  Scan
                </button>
                <button
                  type="button"
                  className="ag-icon-btn-sm"
                  onClick={() => {
                    if (servers.exploredRelayUrl) {
                      onPlaySound?.('click')
                      void servers.exploreNip29Relay(servers.exploredRelayUrl)
                    }
                  }}
                  disabled={servers.exploringRelay || !servers.exploredRelayUrl}
                  title="Refresh relay groups"
                  aria-label="Refresh relay groups"
                >
                  <RefreshCw size={13} className={servers.exploringRelay ? 'ag-spin' : ''} />
                </button>
              </form>

              {/* Group Search */}
              <div className="ag-search-field">
                <Search size={13} className="ag-search-icon" />
                <input
                  type="text"
                  className="ag-input ag-search-input"
                  placeholder={`Filter groups on ${stripWs(servers.exploredRelayUrl || 'relay')}…`}
                  value={exploreQuery}
                  onChange={(e) => setExploreQuery(e.target.value)}
                  aria-label="Filter discovered NIP-29 groups"
                />
                {exploreQuery && (
                  <button
                    type="button"
                    className="ag-search-clear"
                    onClick={() => setExploreQuery('')}
                    aria-label="Clear filter"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              {servers.exploreError && (
                <p className="ag-field-hint ag-field-hint-danger">{servers.exploreError}</p>
              )}

              {/* Results */}
              <div className="ag-srv-explore-list" role="list">
                {servers.exploringRelay ? (
                  <div className="ag-empty-panel">
                    <Loader2 size={20} className="ag-empty-icon ag-spin" />
                    <p className="ag-empty-title">Scanning NIP-29 relay…</p>
                    <p className="ag-empty-sub mono">{stripWs(servers.exploredRelayUrl)}</p>
                  </div>
                ) : filteredExploredGroups.length === 0 ? (
                  <div className="ag-empty-panel">
                    <Users size={20} className="ag-empty-icon" />
                    <p className="ag-empty-title">No communities found</p>
                    <p className="ag-empty-sub">
                      Try another NIP-29 relay above or clear your search filter.
                    </p>
                  </div>
                ) : (
                  filteredExploredGroups.map((group) => {
                    const alreadyJoined = joinedKeySet.has(`${group.relayUrl}::${group.groupId}`)
                    const isJoining = joiningGroupId === group.groupId
                    return (
                      <div key={`${group.relayUrl}-${group.groupId}`} role="listitem" className="ag-srv-group-card">
                        <div className="ag-srv-group-avatar">
                          {group.picture && /^https?:\/\//i.test(group.picture) ? (
                            <img
                              src={group.picture}
                              alt=""
                              loading="lazy"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <span className="mono">{getMonogram(group.name || group.groupId)}</span>
                          )}
                        </div>

                        <div className="ag-srv-group-meta">
                          <div className="ag-srv-group-title-row">
                            <span className="ag-srv-group-name truncate">
                              {group.name || group.groupId}
                            </span>
                            <span className="ag-srv-group-id mono truncate">{group.groupId}</span>
                          </div>
                          <div className="ag-srv-group-badges">
                            {group.isPrivate ? (
                              <span className="ag-badge ag-badge-dm">PRIVATE</span>
                            ) : group.isClosed ? (
                              <span className="ag-badge ag-badge-warn">CLOSED</span>
                            ) : (
                              <span className="ag-badge ag-badge-ok">OPEN</span>
                            )}
                            {group.isRestricted && (
                              <span className="ag-badge ag-badge-muted">MEMBERS POST</span>
                            )}
                          </div>
                          {group.about && (
                            <p className="ag-srv-group-about">{group.about}</p>
                          )}
                        </div>

                        <button
                          type="button"
                          className={`ag-btn ag-btn-sm ${alreadyJoined ? 'ag-btn-secondary' : 'ag-btn-primary'}`}
                          onClick={() => void handleJoinExploredGroup(group)}
                          disabled={isJoining}
                        >
                          {isJoining ? (
                            <Loader2 size={13} className="ag-spin" />
                          ) : alreadyJoined ? (
                            'Open'
                          ) : (
                            'Join'
                          )}
                        </button>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ServerHubModal
