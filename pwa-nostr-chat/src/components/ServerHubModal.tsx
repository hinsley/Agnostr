import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties, FormEvent } from 'react'
import {
  Camera,
  Check,
  Compass,
  Globe,
  Hash,
  Link2,
  Loader2,
  Lock,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react'
import type { AgnostrEngine } from '../types/protocol.ts'
import type {
  Nip29GroupMeta,
  ServerInvite,
  ServersEngine,
  ServerSummary,
} from '../types/servers.ts'
import type { SoundCue } from '../utils/sound.ts'
import { shortPubkey } from '../utils/identicon.ts'
import {
  getGroupSpecifier,
  hasUploadedGroupPicture,
  sanitizeGroupSpecifier,
} from '../utils/groupIcon.ts'
import { AvatarImg } from './AvatarImg.tsx'
import { IconCropModal } from './IconCropModal.tsx'
import type { QrShareTarget } from './QrShareModal.tsx'

export type ServerHubTab = 'create' | 'join' | 'explore'

export interface ServerHubModalProps {
  open: boolean
  initialTab?: ServerHubTab
  engine?: AgnostrEngine
  servers: ServersEngine
  onClose: () => void
  onJoinedServer?: (server: ServerSummary) => void
  onPlaySound?: (cue: SoundCue) => void
  onShowQr?: (target: QrShareTarget) => void
  onOpenScanner?: () => void
}

type CreateKindMode = 'virtual-public' | 'virtual-e2ee' | 'nip29'

const ACCENT_CHOICES = [
  { id: 'blue', hex: '#3B82F6', label: 'Cobalt' },
  { id: 'indigo', hex: '#6366F1', label: 'Indigo' },
  { id: 'sky', hex: '#38BDF8', label: 'Sky' },
  { id: 'violet', hex: '#8B5CF6', label: 'Violet' },
  { id: 'amber', hex: '#F59E0B', label: 'Amber' },
  { id: 'rose', hex: '#FB7185', label: 'Coral' },
] as const

function stripWs(url: string): string {
  return url.replace(/^wss?:\/\//i, '').replace(/\/+$/, '')
}

function readVerifiedCachedPicture(pubkey: string | undefined): string | undefined {
  if (!pubkey || typeof localStorage === 'undefined') return undefined
  const pk = pubkey.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(pk)) return undefined
  try {
    const raw = localStorage.getItem('agnostr:v2:agora_profiles')
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return undefined
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const entry = item as { pubkey?: unknown; picture?: unknown }
      if (typeof entry.pubkey === 'string' && entry.pubkey.toLowerCase() === pk) {
        if (typeof entry.picture === 'string' && /^https:\/\//i.test(entry.picture.trim())) {
          return entry.picture.trim()
        }
        return undefined
      }
    }
  } catch {
    // Ignore storage parse failures
  }
  return undefined
}

export function ServerHubModal({
  open,
  initialTab = 'create',
  engine,
  servers,
  onClose,
  onJoinedServer,
  onPlaySound,
  onOpenScanner,
}: ServerHubModalProps) {
  const [tab, setTab] = useState<ServerHubTab>(initialTab)

  // Create Group state
  const [createMode, setCreateMode] = useState<CreateKindMode>('virtual-e2ee')
  const [nameDraft, setNameDraft] = useState('')
  const [descDraft, setDescDraft] = useState('')
  const [specifierDraft, setSpecifierDraft] = useState('')
  const [accentDraft, setAccentDraft] = useState<string>(ACCENT_CHOICES[0].hex)
  const [pendingIconBlob, setPendingIconBlob] = useState<Blob | null>(null)
  const [pendingIconPreviewUrl, setPendingIconPreviewUrl] = useState<string | null>(null)
  const [cropFile, setCropFile] = useState<File | null>(null)
  const [uploadingPendingIcon, setUploadingPendingIcon] = useState(false)
  const [failedPictureUrls, setFailedPictureUrls] = useState<Record<string, boolean>>({})
  const createIconInputRef = useRef<HTMLInputElement | null>(null)
  const pendingIconUrlRef = useRef<string | null>(null)
  const [channelsDraft, setChannelsDraft] = useState<string[]>(['general', 'off-topic'])
  const [newChannelDraft, setNewChannelDraft] = useState('')
  const [nip29CreateRelay, setNip29CreateRelay] = useState('')
  const [nip29Private, setNip29Private] = useState(false)
  const [nip29Closed, setNip29Closed] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const setPendingIcon = useCallback((blob: Blob | null) => {
    if (pendingIconUrlRef.current) {
      URL.revokeObjectURL(pendingIconUrlRef.current)
      pendingIconUrlRef.current = null
    }
    if (blob) {
      const nextUrl = URL.createObjectURL(blob)
      pendingIconUrlRef.current = nextUrl
      setPendingIconBlob(blob)
      setPendingIconPreviewUrl(nextUrl)
    } else {
      setPendingIconBlob(null)
      setPendingIconPreviewUrl(null)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (pendingIconUrlRef.current) {
        URL.revokeObjectURL(pendingIconUrlRef.current)
        pendingIconUrlRef.current = null
      }
    }
  }, [])

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
    if (!nip29CreateRelay) {
      const fallback = createSupportedPresets[0]?.url ?? servers.nip29Presets[0]?.url
      if (fallback) setNip29CreateRelay(fallback)
    }
  }, [nip29CreateRelay, createSupportedPresets, servers.nip29Presets])

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
        if (cropFile || document.querySelector('[data-icon-crop-modal="true"]')) {
          return
        }
        e.preventDefault()
        if (servers.pendingInvite) servers.clearPendingInvite()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, cropFile, onClose, servers])

  const parsedInvite: ServerInvite | null = useMemo(() => {
    const trimmed = inviteDraft.trim()
    if (!trimmed) return servers.pendingInvite
    return servers.parseInviteInput(trimmed)
  }, [inviteDraft, servers])

  const inviterPubkey = parsedInvite?.inviterPubkey
  const ensureProfilePictures = engine?.ensureProfilePictures
  useEffect(() => {
    if (!open || !inviterPubkey || !ensureProfilePictures) return
    ensureProfilePictures([inviterPubkey])
  }, [open, inviterPubkey, ensureProfilePictures])

  const inviterPictureUrl = useMemo(() => {
    if (!inviterPubkey) return undefined
    return engine?.getProfilePicture(inviterPubkey) ?? readVerifiedCachedPicture(inviterPubkey)
  }, [engine, inviterPubkey])

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

  const handleCreateIconSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || servers.creating || uploadingPendingIcon) return
    if (!file.type.startsWith('image/')) {
      setCreateError('Choose an image file (PNG, JPG, GIF, or WebP).')
      return
    }
    setCreateError(null)
    setCropFile(file)
  }

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const cleanName = nameDraft.trim()
    if (!cleanName) {
      setCreateError('Give your group a name')
      return
    }
    setCreateError(null)
    const cleanSpecifier = sanitizeGroupSpecifier(specifierDraft)

    if (createMode === 'nip29') {
      const relay = nip29CreateRelay.trim()
      if (!relay || !/^wss?:\/\//i.test(relay)) {
        setCreateError('Enter a valid wss:// relay URL')
        return
      }
      const created = await servers.createNip29Group({
        relayUrl: relay,
        name: cleanName,
        about: descDraft.trim() || undefined,
        icon: cleanSpecifier || undefined,
        accentColor: accentDraft,
        isPrivate: nip29Private,
        isClosed: nip29Closed,
      })
      if (created) {
        let finalServer = created
        if (pendingIconBlob) {
          setUploadingPendingIcon(true)
          try {
            const uploadRes = await servers.uploadServerIcon(created.id, pendingIconBlob)
            if (uploadRes.ok && uploadRes.pictureUrl) {
              finalServer = { ...created, picture: uploadRes.pictureUrl }
            }
          } finally {
            setUploadingPendingIcon(false)
          }
        }
        onPlaySound?.('tune')
        setNameDraft('')
        setDescDraft('')
        setSpecifierDraft('')
        setPendingIcon(null)
        onJoinedServer?.(finalServer)
        onClose()
      } else {
        setCreateError('Relay did not accept group creation. Try another relay.')
      }
      return
    }

    const created = await servers.createVirtualServer({
      name: cleanName,
      description: descDraft.trim() || undefined,
      icon: cleanSpecifier || undefined,
      accentColor: accentDraft,
      encrypted: createMode === 'virtual-e2ee',
      channels: channelsDraft,
    })

    if (created) {
      let finalServer = created
      if (pendingIconBlob) {
        setUploadingPendingIcon(true)
        try {
          const uploadRes = await servers.uploadServerIcon(created.id, pendingIconBlob)
          if (uploadRes.ok && uploadRes.pictureUrl) {
            finalServer = { ...created, picture: uploadRes.pictureUrl }
          }
        } finally {
          setUploadingPendingIcon(false)
        }
      }
      onPlaySound?.('tune')
      setNameDraft('')
      setDescDraft('')
      setSpecifierDraft('')
      setPendingIcon(null)
      onJoinedServer?.(finalServer)
      onClose()
    } else {
      setCreateError('Failed to publish group manifest. Check relay connectivity.')
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
        setJoinError('Could not join group from this invite.')
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
              Groups
            </h2>
            <p className="ag-srv-modal-sub">
              Create, join, or browse groups.
            </p>
          </div>
          <button
            type="button"
            className="ag-icon-btn-sm"
            onClick={handleDismiss}
            aria-label="Close groups hub"
          >
            <X size={15} />
          </button>
        </div>

        {/* 3 Primary Tabs */}
        <div className="ag-segmented ag-srv-hub-tabs" role="tablist" aria-label="Groups hub sections">
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
            <span>Create Group</span>
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
            <span>Explore</span>
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="ag-srv-modal-body">
          {/* TAB 1: CREATE SERVER */}
          {tab === 'create' && (
            <form className="ag-srv-form" onSubmit={(e) => void handleCreateSubmit(e)}>
              {/* Mode Selector */}
              <div className="ag-srv-mode-grid" role="group" aria-label="Group type">
                <button
                  type="button"
                  aria-pressed={createMode === 'virtual-e2ee'}
                  className={`ag-srv-mode-card ${createMode === 'virtual-e2ee' ? 'active e2ee' : ''}`}
                  title="Encrypted invite-only group"
                  onClick={() => {
                    setCreateMode('virtual-e2ee')
                    setAccentDraft('#8B5CF6')
                  }}
                >
                  <div className="ag-srv-mode-top">
                    <Lock size={14} />
                    <span>Private</span>
                  </div>
                  <div className="ag-srv-mode-sub">
                    <span className="ag-srv-mode-desc">Encrypted</span>
                  </div>
                </button>

                <button
                  type="button"
                  aria-pressed={createMode === 'virtual-public'}
                  className={`ag-srv-mode-card ${createMode === 'virtual-public' ? 'active' : ''}`}
                  title="Open public group"
                  onClick={() => {
                    setCreateMode('virtual-public')
                    setAccentDraft('#3B82F6')
                  }}
                >
                  <div className="ag-srv-mode-top">
                    <Globe size={14} />
                    <span>Public</span>
                  </div>
                  <div className="ag-srv-mode-sub">
                    <span className="ag-srv-mode-desc">Open chat</span>
                  </div>
                </button>

                <button
                  type="button"
                  aria-pressed={createMode === 'nip29'}
                  className={`ag-srv-mode-card ${createMode === 'nip29' ? 'active nip29' : ''}`}
                  title="Relay-hosted moderated group"
                  onClick={() => {
                    setCreateMode('nip29')
                    setAccentDraft('#38BDF8')
                  }}
                >
                  <div className="ag-srv-mode-top">
                    <Server size={14} />
                    <span>Hosted</span>
                  </div>
                  <div className="ag-srv-mode-sub">
                    <span className="ag-srv-mode-desc">Moderated</span>
                  </div>
                </button>
              </div>

              {/* Name & Description */}
              <div className="ag-srv-field-row">
                <div>
                  <label className="ag-field-label" htmlFor="ag-srv-name-input">
                    Group Name
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
                          : 'Bay Area Bitchat'
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

              {/* Emblem Preview, 2-Letter Specifier, Custom Icon Upload & Accent Color */}
              <div className="ag-srv-customize-grid">
                <div className="ag-srv-create-identity">
                  <span className="ag-field-label">Group Icon</span>
                  <div className="ag-srv-create-emblem-row">
                    <input
                      ref={createIconInputRef}
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={handleCreateIconSelect}
                    />
                    <button
                      type="button"
                      className="ag-srv-create-emblem-preview ag-srv-emblem-btn"
                      style={{ '--srv-accent': accentDraft } as CSSProperties}
                      disabled={servers.creating || uploadingPendingIcon}
                      onClick={() => createIconInputRef.current?.click()}
                      aria-label={pendingIconPreviewUrl ? 'Change group icon' : 'Upload group icon'}
                      title={pendingIconPreviewUrl ? 'Change group icon' : 'Upload group icon'}
                    >
                      {pendingIconPreviewUrl ? (
                        <img src={pendingIconPreviewUrl} alt="" />
                      ) : (
                        <span className="mono">
                          {getGroupSpecifier(nameDraft, specifierDraft)}
                        </span>
                      )}
                      <span className="ag-srv-emblem-overlay" aria-hidden="true">
                        <Camera size={15} />
                      </span>
                    </button>

                    <div className="ag-srv-create-emblem-controls">
                      <div className="ag-srv-emblem-actions">
                        <button
                          type="button"
                          className="ag-btn ag-btn-secondary ag-btn-xs"
                          disabled={servers.creating || uploadingPendingIcon}
                          onClick={() => createIconInputRef.current?.click()}
                        >
                          <Upload size={12} />
                          <span>{pendingIconPreviewUrl ? 'Change Icon' : 'Upload Icon'}</span>
                        </button>
                        {pendingIconPreviewUrl && (
                          <button
                            type="button"
                            className="ag-btn ag-btn-ghost ag-btn-xs"
                            disabled={servers.creating || uploadingPendingIcon}
                            onClick={() => setPendingIcon(null)}
                          >
                            <Trash2 size={12} />
                            <span>Remove</span>
                          </button>
                        )}
                      </div>
                      <div className="ag-srv-specifier-inline">
                        <label
                          className="ag-srv-specifier-inline-label"
                          htmlFor="ag-srv-create-specifier"
                        >
                          2-Letter Specifier
                        </label>
                        <input
                          id="ag-srv-create-specifier"
                          type="text"
                          maxLength={2}
                          className="ag-input mono ag-srv-specifier-input"
                          value={specifierDraft}
                          onChange={(e) =>
                            setSpecifierDraft(sanitizeGroupSpecifier(e.target.value))
                          }
                          placeholder={getGroupSpecifier(nameDraft)}
                          aria-label="2-letter group specifier (optional)"
                        />
                      </div>
                    </div>
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
                    Host Relay
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
                    placeholder="wss://pyramid.fiatjaf.com"
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
                  disabled={servers.creating || uploadingPendingIcon || !nameDraft.trim()}
                >
                  {servers.creating || uploadingPendingIcon ? (
                    <>
                      <Loader2 size={14} className="ag-spin" />
                      <span>{uploadingPendingIcon ? 'Uploading icon…' : 'Creating…'}</span>
                    </>
                  ) : (
                    <>
                      <Sparkles size={14} />
                      <span>
                        {createMode === 'virtual-e2ee'
                          ? 'Create Private Group'
                          : createMode === 'nip29'
                            ? 'Create Hosted Group'
                            : 'Create Public Group'}
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
                <div className="ag-srv-join-head">
                  <label className="ag-field-label" htmlFor="ag-srv-invite-input">
                    Invite Link or Code
                  </label>
                  {onOpenScanner && (
                    <button
                      type="button"
                      className="ag-btn ag-btn-secondary ag-btn-xs"
                      onClick={() => {
                        onPlaySound?.('click')
                        handleDismiss()
                        onOpenScanner()
                      }}
                    >
                      <QrCode size={13} />
                      <span>Scan Invite QR</span>
                    </button>
                  )}
                </div>
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
                      {hasUploadedGroupPicture(parsedInvite.picture) &&
                      !failedPictureUrls[parsedInvite.picture!] ? (
                        <img
                          src={parsedInvite.picture}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          onError={() =>
                            setFailedPictureUrls((prev) => ({
                              ...prev,
                              [parsedInvite.picture!]: true,
                            }))
                          }
                        />
                      ) : (
                        <span className="mono">
                          {getGroupSpecifier(parsedInvite.name, parsedInvite.icon)}
                        </span>
                      )}
                    </div>
                    <div className="ag-srv-info-meta">
                      <span className="ag-srv-info-name truncate">{parsedInvite.name}</span>
                      <div className="ag-srv-info-badges">
                        {parsedInvite.kind === 'nip29' ? (
                          <span className="ag-badge ag-badge-mesh">
                            <Server size={9} />
                            <span>HOSTED</span>
                          </span>
                        ) : parsedInvite.encrypted ? (
                          <span className="ag-badge ag-badge-dm">
                            <Lock size={9} />
                            <span>ENCRYPTED</span>
                          </span>
                        ) : (
                          <span className="ag-badge ag-badge-accent">PUBLIC</span>
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
                      <AvatarImg
                        pubkey={parsedInvite.inviterPubkey}
                        pictureUrl={inviterPictureUrl}
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
                      Media from untrusted senders stays hidden until trusted.
                    </span>
                  </div>
                </div>
              ) : inviteDraft.trim().length > 0 ? (
                <p className="ag-field-hint ag-field-hint-warn">
                  Unrecognized invite — paste an <code className="mono">#invite=ag1…</code> link
                  or <code className="mono">relay&apos;groupId</code>.
                </p>
              ) : (
                <p className="ag-field-hint">
                  Paste an invite link or code to preview before joining.
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
                      <span>Join Group</span>
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
                  placeholder="Custom wss:// relay URL…"
                  value={customExploreRelay}
                  onChange={(e) => setCustomExploreRelay(e.target.value)}
                  aria-label="Custom relay URL"
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
                  aria-label="Filter discovered groups"
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
                    <p className="ag-empty-title">Scanning relay…</p>
                    <p className="ag-empty-sub mono">{stripWs(servers.exploredRelayUrl)}</p>
                  </div>
                ) : filteredExploredGroups.length === 0 ? (
                  <div className="ag-empty-panel">
                    <Users size={20} className="ag-empty-icon" />
                    <p className="ag-empty-title">No groups found</p>
                    <p className="ag-empty-sub">
                      Try another relay above or clear your search.
                    </p>
                  </div>
                ) : (
                  filteredExploredGroups.map((group) => {
                    const alreadyJoined = joinedKeySet.has(`${group.relayUrl}::${group.groupId}`)
                    const isJoining = joiningGroupId === group.groupId
                    return (
                      <div key={`${group.relayUrl}-${group.groupId}`} role="listitem" className="ag-srv-group-card">
                        <div className="ag-srv-group-avatar">
                          {hasUploadedGroupPicture(group.picture) &&
                          !failedPictureUrls[group.picture!] ? (
                            <img
                              src={group.picture}
                              alt=""
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              onError={() =>
                                setFailedPictureUrls((prev) => ({
                                  ...prev,
                                  [group.picture!]: true,
                                }))
                              }
                            />
                          ) : (
                            <span className="mono">
                              {getGroupSpecifier(group.name || group.groupId)}
                            </span>
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

      <IconCropModal
        file={cropFile}
        label={nameDraft.trim() || 'New Group'}
        onCancel={() => setCropFile(null)}
        onConfirm={(croppedBlob) => {
          setPendingIcon(croppedBlob)
          setCropFile(null)
          onPlaySound?.('click')
        }}
      />
    </div>
  )
}

export default ServerHubModal
