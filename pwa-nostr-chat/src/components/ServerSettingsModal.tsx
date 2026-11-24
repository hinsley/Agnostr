import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties, FormEvent } from 'react'
import {
  AlertTriangle,
  Ban,
  Camera,
  Check,
  Copy,
  Hash,
  Loader2,
  Lock,
  LogOut,
  Plus,
  QrCode,
  Search,
  Send,
  Server,
  Shield,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Upload,
  UserCheck,
  Users,
  X,
} from 'lucide-react'
import type { AgnostrEngine } from '../types/protocol.ts'
import type { ServersEngine, ServerSummary } from '../types/servers.ts'
import type { SoundCue } from '../utils/sound.ts'
import { pubkeyToColor, shortPubkey } from '../utils/identicon.ts'
import {
  getGroupSpecifier,
  hasUploadedGroupPicture,
  sanitizeGroupSpecifier,
} from '../utils/groupIcon.ts'
import { AvatarImg } from './AvatarImg.tsx'
import { IconCropModal } from './IconCropModal.tsx'
import type { QrShareTarget } from './QrShareModal.tsx'

export type ServerSettingsTab = 'overview' | 'channels' | 'members' | 'bans'

export interface ServerSettingsModalProps {
  server: ServerSummary | null
  initialTab?: ServerSettingsTab
  engine: AgnostrEngine
  servers: ServersEngine
  onClose: () => void
  onLeftServer?: () => void
  onPlaySound?: (cue: SoundCue) => void
  onShowQr?: (target: QrShareTarget) => void
  onOpenScanner?: () => void
}

const ACCENT_CHOICES = [
  '#22E584',
  '#38BDF8',
  '#A78BFA',
  '#F5A623',
  '#FB7185',
  '#2DD4BF',
] as const

interface ContactOption {
  pubkey: string
  label: string
  sub: string
}

export function ServerSettingsModal({
  server,
  initialTab = 'overview',
  engine,
  servers,
  onClose,
  onLeftServer,
  onPlaySound,
  onShowQr,
}: ServerSettingsModalProps) {
  const [tab, setTab] = useState<ServerSettingsTab>(initialTab)
  const [copiedMode, setCopiedMode] = useState<'url' | 'code' | null>(null)
  const [dmSearch, setDmSearch] = useState('')
  const [sentDmPubkeys, setSentDmPubkeys] = useState<Record<string, boolean>>({})
  const [sendingDmPubkey, setSendingDmPubkey] = useState<string | null>(null)

  // Metadata & icon edit drafts
  const [nameDraft, setNameDraft] = useState('')
  const [descDraft, setDescDraft] = useState('')
  const [specifierDraft, setSpecifierDraft] = useState('')
  const [accentDraft, setAccentDraft] = useState('#22E584')
  const [savingMeta, setSavingMeta] = useState(false)
  const [iconCropFile, setIconCropFile] = useState<File | null>(null)
  const [iconUploading, setIconUploading] = useState(false)
  const [iconError, setIconError] = useState<string | null>(null)
  const [failedPictureUrl, setFailedPictureUrl] = useState<string | null>(null)
  const iconFileInputRef = useRef<HTMLInputElement | null>(null)

  // Channels edit drafts
  const [newChanName, setNewChanName] = useState('')
  const [newChanTopic, setNewChanTopic] = useState('')
  const [addingChan, setAddingChan] = useState(false)

  // Mod / Ban drafts
  const [modKeyDraft, setModKeyDraft] = useState('')
  const [banKeyDraft, setBanKeyDraft] = useState('')
  const [banReasonDraft, setBanReasonDraft] = useState('')
  const [confirmLeave, setConfirmLeave] = useState(false)

  const liveServer = useMemo(() => {
    if (!server) return null
    return servers.joinedServers.find((s) => s.id === server.id) ?? server
  }, [server, servers.joinedServers])

  useEffect(() => {
    if (!liveServer) return
    setTab(initialTab)
    setNameDraft(liveServer.name)
    setDescDraft(liveServer.description)
    setSpecifierDraft(sanitizeGroupSpecifier(liveServer.icon))
    setAccentDraft(liveServer.accentColor || '#22E584')
    setIconCropFile(null)
    setIconError(null)
    setFailedPictureUrl(null)
    setConfirmLeave(false)
    setSentDmPubkeys({})
  }, [liveServer?.id, initialTab]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!liveServer) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (iconCropFile || document.querySelector('[data-icon-crop-modal="true"]')) {
          return
        }
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [liveServer, iconCropFile, onClose])

  // Known peers/contacts for "Send Invite via Encrypted DM"
  const dmContacts = useMemo<ContactOption[]>(() => {
    const map = new Map<string, ContactOption>()
    const selfKeys = new Set([engine.identity.masterPubkey, engine.identity.activePubkey])

    for (const thread of engine.dmThreads) {
      if (selfKeys.has(thread.peerPubkey)) continue
      map.set(thread.peerPubkey, {
        pubkey: thread.peerPubkey,
        label: thread.peerDisplayHandle,
        sub: 'Encrypted DM thread',
      })
    }
    for (const trusted of engine.trustedPubkeys) {
      if (selfKeys.has(trusted.pubkey) || map.has(trusted.pubkey)) continue
      map.set(trusted.pubkey, {
        pubkey: trusted.pubkey,
        label: trusted.label ? `@${trusted.label}` : shortPubkey(trusted.pubkey, 8, 6),
        sub: 'Trusted peer',
      })
    }
    for (const peer of engine.peers) {
      if (peer.isSelf || selfKeys.has(peer.pubkey) || map.has(peer.pubkey)) continue
      map.set(peer.pubkey, {
        pubkey: peer.pubkey,
        label: peer.displayHandle,
        sub: 'Active peer',
      })
    }

    const q = dmSearch.trim().toLowerCase()
    const list = Array.from(map.values())
    if (!q) return list
    return list.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.pubkey.toLowerCase().includes(q),
    )
  }, [engine.dmThreads, engine.trustedPubkeys, engine.peers, engine.identity, dmSearch])

  // Prefetch verified kind: 0 profile pictures for visible contacts, moderators, members & bans
  const visibleAvatarPubkeysKey = useMemo(() => {
    if (!liveServer) return ''
    const set = new Set<string>()
    const addPk = (raw?: string | null) => {
      if (!raw) return
      const pk = raw.trim().toLowerCase()
      if (/^[0-9a-f]{64}$/.test(pk)) set.add(pk)
    }
    for (const c of dmContacts) addPk(c.pubkey)
    for (const pk of liveServer.moderators) addPk(pk)
    for (const m of servers.members) addPk(m.pubkey)
    for (const pk of liveServer.bannedPubkeys) addPk(pk)
    return Array.from(set).sort().join(',')
  }, [liveServer, dmContacts, servers.members])

  const ensureProfilePictures = engine.ensureProfilePictures
  useEffect(() => {
    if (!visibleAvatarPubkeysKey) return
    ensureProfilePictures(visibleAvatarPubkeysKey.split(','))
  }, [visibleAvatarPubkeysKey, ensureProfilePictures])

  if (!liveServer) return null

  const myKeys = new Set([engine.identity.masterPubkey, engine.identity.activePubkey])
  const isFounder = myKeys.has(liveServer.founderPubkey)
  const isModOrAdmin =
    isFounder ||
    liveServer.moderators.some((pk) => myKeys.has(pk)) ||
    Boolean(liveServer.admins?.some((a) => myKeys.has(a.pubkey))) ||
    (servers.activeServer?.id === liveServer.id && servers.canModerate)
  const canEditIcon = liveServer.kind === 'virtual' ? isFounder : isModOrAdmin

  const hasCustomPicture = hasUploadedGroupPicture(liveServer.picture)
  const showCustomPicture = hasCustomPicture && failedPictureUrl !== liveServer.picture
  const liveSpecifier = getGroupSpecifier(liveServer.name, liveServer.icon)
  const draftSpecifier = getGroupSpecifier(nameDraft || liveServer.name, specifierDraft)
  const autoSpecifierPlaceholder = getGroupSpecifier(nameDraft || liveServer.name)

  const inviteData = servers.buildInviteLink(liveServer.id)

  const handleCopyInvite = async (mode: 'url' | 'code') => {
    if (!inviteData) return
    const text = mode === 'url' ? inviteData.url : inviteData.code
    try {
      await navigator.clipboard.writeText(text)
      setCopiedMode(mode)
      onPlaySound?.('click')
      engine.pushToast('success', mode === 'url' ? 'Copied invite link' : 'Copied invite code')
      window.setTimeout(() => setCopiedMode((prev) => (prev === mode ? null : prev)), 1800)
    } catch {
      engine.pushToast('error', 'Clipboard copy failed')
    }
  }

  const handleSendDmInvite = async (pubkey: string) => {
    setSendingDmPubkey(pubkey)
    try {
      const ok = await servers.sendInviteViaDm(liveServer.id, pubkey)
      if (ok) {
        setSentDmPubkeys((prev) => ({ ...prev, [pubkey]: true }))
        onPlaySound?.('dm')
      }
    } finally {
      setSendingDmPubkey(null)
    }
  }

  const handleSaveMetadata = async (e: FormEvent) => {
    e.preventDefault()
    if (!isModOrAdmin || savingMeta || !nameDraft.trim()) return
    setSavingMeta(true)
    try {
      const ok = await servers.updateServerMetadata(liveServer.id, {
        name: nameDraft.trim(),
        description: descDraft.trim(),
        ...(canEditIcon ? { icon: sanitizeGroupSpecifier(specifierDraft) } : {}),
        accentColor: accentDraft,
      })
      if (ok) onPlaySound?.('click')
    } finally {
      setSavingMeta(false)
    }
  }

  const handleIconFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !canEditIcon || iconUploading) return
    if (!file.type.startsWith('image/')) {
      setIconError('Choose an image file (PNG, JPG, GIF, or WebP).')
      return
    }
    setIconError(null)
    setIconCropFile(file)
  }

  const handleIconCropConfirm = async (croppedBlob: Blob) => {
    if (!canEditIcon || iconUploading) return
    setIconUploading(true)
    setIconError(null)
    try {
      const res = await servers.uploadServerIcon(liveServer.id, croppedBlob)
      if (res.ok) {
        setFailedPictureUrl(null)
        setIconCropFile(null)
        onPlaySound?.('send')
      } else {
        setIconError(res.error || 'Could not upload group icon.')
        setIconCropFile(null)
      }
    } catch (err) {
      setIconError(err instanceof Error ? err.message : 'Could not upload group icon.')
      setIconCropFile(null)
    } finally {
      setIconUploading(false)
    }
  }

  const handleRemoveIcon = async () => {
    if (!canEditIcon || iconUploading || !hasCustomPicture) return
    setIconUploading(true)
    setIconError(null)
    try {
      const ok = await servers.updateServerMetadata(liveServer.id, { picture: null })
      if (ok) {
        setFailedPictureUrl(null)
        onPlaySound?.('click')
      } else {
        setIconError('Could not remove group icon.')
      }
    } finally {
      setIconUploading(false)
    }
  }

  const handleAddChannel = async (e: FormEvent) => {
    e.preventDefault()
    const clean = newChanName.trim().replace(/^#+/, '')
    if (!clean || addingChan) return
    setAddingChan(true)
    try {
      const ok = await servers.addChannel(
        liveServer.id,
        clean,
        newChanTopic.trim() || undefined,
      )
      if (ok) {
        setNewChanName('')
        setNewChanTopic('')
        onPlaySound?.('tune')
      }
    } finally {
      setAddingChan(false)
    }
  }

  const handleAddModerator = async (e: FormEvent) => {
    e.preventDefault()
    const clean = modKeyDraft.trim()
    if (!clean) return
    const ok = await servers.addModerator(liveServer.id, clean)
    if (ok) {
      setModKeyDraft('')
      onPlaySound?.('click')
    }
  }

  const handleBanSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const clean = banKeyDraft.trim()
    if (!clean) return
    const ok = await servers.banMember(liveServer.id, clean, banReasonDraft.trim() || undefined)
    if (ok) {
      setBanKeyDraft('')
      setBanReasonDraft('')
      onPlaySound?.('click')
    }
  }

  const handleLeave = async () => {
    if (!confirmLeave) {
      setConfirmLeave(true)
      window.setTimeout(() => setConfirmLeave(false), 3500)
      return
    }
    onPlaySound?.('click')
    await servers.leaveServer(liveServer.id)
    onLeftServer?.()
    onClose()
  }

  return (
    <div className="ag-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="ag-srv-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-srv-settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="ag-srv-modal-head">
          <div className="ag-srv-head-identity">
            <div
              className="ag-srv-head-emblem"
              style={
                {
                  '--srv-accent': liveServer.accentColor || 'var(--accent)',
                } as CSSProperties
              }
              aria-hidden="true"
            >
              {showCustomPicture ? (
                <img
                  src={liveServer.picture}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={() => setFailedPictureUrl(liveServer.picture ?? null)}
                />
              ) : (
                <span className="mono">{liveSpecifier}</span>
              )}
            </div>
            <div className="ag-srv-modal-title-group">
              <h2 id="ag-srv-settings-title" className="ag-srv-modal-title truncate">
                {liveServer.name}
              </h2>
              <div className="ag-srv-info-badges">
                {liveServer.kind === 'nip29' ? (
                  <span className="ag-badge ag-badge-mesh">
                    <Server size={9} />
                    <span>HOSTED</span>
                  </span>
                ) : liveServer.encrypted ? (
                  <span className="ag-badge ag-badge-dm">
                    <Lock size={9} />
                    <span>ENCRYPTED</span>
                  </span>
                ) : (
                  <span className="ag-badge ag-badge-accent">PUBLIC</span>
                )}
                {isModOrAdmin && (
                  <span className="ag-badge ag-badge-ok">
                    {isFounder ? 'FOUNDER' : 'MODERATOR'}
                  </span>
                )}
              </div>
            </div>
          </div>

          <button
            type="button"
            className="ag-icon-btn-sm"
            onClick={onClose}
            aria-label="Close group settings"
          >
            <X size={15} />
          </button>
        </div>

        {/* Settings Tabs */}
        <div className="ag-segmented ag-srv-settings-tabs" role="tablist" aria-label="Group settings tabs">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'overview'}
            className={tab === 'overview' ? 'active' : ''}
            onClick={() => setTab('overview')}
          >
            Overview &amp; Invite
          </button>
          {liveServer.kind === 'virtual' && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'channels'}
              className={tab === 'channels' ? 'active' : ''}
              onClick={() => setTab('channels')}
            >
              Channels ({liveServer.channels.length})
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'members'}
            className={tab === 'members' ? 'active' : ''}
            onClick={() => setTab('members')}
          >
            Mods &amp; Roster
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'bans'}
            className={tab === 'bans' ? 'active' : ''}
            onClick={() => setTab('bans')}
          >
            Bans ({liveServer.bannedPubkeys.length})
          </button>
        </div>

        {/* Body */}
        <div className="ag-srv-modal-body">
          {/* TAB: OVERVIEW & INVITE */}
          {tab === 'overview' && (
            <div className="ag-srv-settings-stack">
              {/* Shareable Invite Box */}
              {inviteData && (
                <section className="ag-panel-card">
                  <div className="ag-panel-card-head">
                    <div className="ag-panel-card-title">
                      <Send size={13} />
                      <span>SHAREABLE INVITE</span>
                    </div>
                  </div>

                  {liveServer.encrypted && (
                    <div className="ag-privacy-callout">
                      <AlertTriangle size={13} />
                      <span>
                        This invite includes the <strong>group decryption key</strong>. Share only
                        with invited people.
                      </span>
                    </div>
                  )}

                  <div className="ag-key-row">
                    <div className="ag-key-meta">
                      <span className="ag-key-label">INVITE LINK</span>
                      <span className="ag-key-value mono truncate" title={inviteData.url}>
                        {inviteData.url}
                      </span>
                    </div>
                    <div className="ag-key-actions">
                      <button
                        type="button"
                        className="ag-btn ag-btn-primary ag-btn-xs"
                        onClick={() => void handleCopyInvite('url')}
                      >
                        {copiedMode === 'url' ? <Check size={12} /> : <Copy size={12} />}
                        <span>{copiedMode === 'url' ? 'Copied' : 'Copy Link'}</span>
                      </button>
                      {onShowQr && (
                        <button
                          type="button"
                          className="ag-btn ag-btn-secondary ag-btn-xs"
                          onClick={() => {
                            onPlaySound?.('click')
                            onShowQr({
                              kind: 'server',
                              title: liveServer.name,
                              subtitle: liveServer.encrypted
                                ? 'Encrypted group invite'
                                : 'Group invite link',
                              url: inviteData.url,
                              codeLabel: 'Invite code',
                              codeValue: inviteData.code,
                            })
                          }}
                          title="Show invite QR code"
                        >
                          <QrCode size={12} />
                          <span>Show QR</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="ag-btn ag-btn-secondary ag-btn-xs"
                        onClick={() => void handleCopyInvite('code')}
                        title="Copy compact invite code"
                      >
                        {copiedMode === 'code' ? <Check size={12} /> : <span>Code</span>}
                      </button>
                    </div>
                  </div>
                </section>
              )}

              {/* Send Invite via Encrypted DM */}
              <section className="ag-panel-card">
                <div className="ag-panel-card-head">
                  <div className="ag-panel-card-title">
                    <Lock size={13} />
                    <span>SEND INVITE VIA ENCRYPTED DM</span>
                  </div>
                </div>

                {dmContacts.length === 0 && !dmSearch ? (
                  <p className="ag-field-hint">
                    No recent peers or DM contacts yet. Copy the invite link above or message a
                    peer first.
                  </p>
                ) : (
                  <>
                    <div className="ag-search-field">
                      <Search size={13} className="ag-search-icon" />
                      <input
                        type="text"
                        className="ag-input ag-search-input"
                        placeholder="Search known peers or trusted contacts…"
                        value={dmSearch}
                        onChange={(e) => setDmSearch(e.target.value)}
                      />
                    </div>
                    <div className="ag-whitelist-list">
                      {dmContacts.slice(0, 12).map((contact) => {
                        const sent = Boolean(sentDmPubkeys[contact.pubkey])
                        const busy = sendingDmPubkey === contact.pubkey
                        return (
                          <div key={contact.pubkey} className="ag-whitelist-row">
                            <AvatarImg
                              pubkey={contact.pubkey}
                              pictureUrl={engine.getProfilePicture(contact.pubkey)}
                              className="ag-whitelist-avatar"
                              width={26}
                              height={26}
                            />
                            <div className="ag-whitelist-meta">
                              <span
                                className="ag-whitelist-name truncate"
                                style={{ color: pubkeyToColor(contact.pubkey) }}
                              >
                                {contact.label}
                              </span>
                              <span className="ag-whitelist-npub">{contact.sub}</span>
                            </div>
                            <button
                              type="button"
                              className={`ag-btn ag-btn-xs ${sent ? 'ag-btn-ok-outline' : 'ag-btn-dm'}`}
                              onClick={() => void handleSendDmInvite(contact.pubkey)}
                              disabled={busy || sent}
                            >
                              {busy ? (
                                <Loader2 size={11} className="ag-spin" />
                              ) : sent ? (
                                <>
                                  <Check size={11} />
                                  <span>Sent</span>
                                </>
                              ) : (
                                <>
                                  <Send size={11} />
                                  <span>Send DM</span>
                                </>
                              )}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </section>

              {/* Group Profile (Editable for Moderators/Founders; Icon strictly Founder / NIP-29 Admin) */}
              <section className="ag-panel-card">
                <div className="ag-panel-card-head">
                  <div className="ag-panel-card-title">
                    <Server size={13} />
                    <span>GROUP PROFILE</span>
                  </div>
                </div>

                <div className="ag-srv-emblem-row">
                  {canEditIcon && (
                    <input
                      ref={iconFileInputRef}
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={handleIconFileSelect}
                    />
                  )}

                  {canEditIcon ? (
                    <button
                      type="button"
                      className="ag-srv-emblem-preview ag-srv-emblem-btn"
                      style={
                        {
                          '--srv-accent': accentDraft || liveServer.accentColor || 'var(--accent)',
                        } as CSSProperties
                      }
                      disabled={iconUploading}
                      onClick={() => iconFileInputRef.current?.click()}
                      aria-label={hasCustomPicture ? 'Change group icon' : 'Upload group icon'}
                      title={hasCustomPicture ? 'Change group icon' : 'Upload group icon'}
                    >
                      {showCustomPicture ? (
                        <img
                          src={liveServer.picture}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          onError={() => setFailedPictureUrl(liveServer.picture ?? null)}
                        />
                      ) : (
                        <span className="mono">{draftSpecifier}</span>
                      )}
                      <span
                        className={`ag-srv-emblem-overlay${iconUploading ? ' is-busy' : ''}`}
                        aria-hidden="true"
                      >
                        {iconUploading ? (
                          <Loader2 size={16} className="ag-spin" />
                        ) : (
                          <Camera size={16} />
                        )}
                      </span>
                    </button>
                  ) : (
                    <div
                      className="ag-srv-emblem-preview"
                      style={
                        {
                          '--srv-accent': liveServer.accentColor || 'var(--accent)',
                        } as CSSProperties
                      }
                      aria-label={`Group emblem ${liveSpecifier}`}
                    >
                      {showCustomPicture ? (
                        <img
                          src={liveServer.picture}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          onError={() => setFailedPictureUrl(liveServer.picture ?? null)}
                        />
                      ) : (
                        <span className="mono">{liveSpecifier}</span>
                      )}
                    </div>
                  )}

                  <div className="ag-srv-emblem-copy">
                    {canEditIcon ? (
                      <>
                        <div className="ag-srv-emblem-actions">
                          <button
                            type="button"
                            className="ag-btn ag-btn-secondary ag-btn-xs"
                            disabled={iconUploading}
                            onClick={() => iconFileInputRef.current?.click()}
                          >
                            {iconUploading ? (
                              <Loader2 size={12} className="ag-spin" />
                            ) : (
                              <Upload size={12} />
                            )}
                            <span>{hasCustomPicture ? 'Change Icon' : 'Upload Icon'}</span>
                          </button>
                          {hasCustomPicture && (
                            <button
                              type="button"
                              className="ag-btn ag-btn-ghost ag-btn-xs"
                              disabled={iconUploading}
                              onClick={() => void handleRemoveIcon()}
                            >
                              <Trash2 size={12} />
                              <span>Remove Icon</span>
                            </button>
                          )}
                        </div>
                        <p className="ag-field-hint">
                          {hasCustomPicture
                            ? 'Custom square icon uploaded. Remove to revert to the 2-letter specifier.'
                            : 'Defaults to a 2-letter specifier. Upload an image to crop a custom icon.'}
                        </p>
                      </>
                    ) : (
                      <>
                        <span className="ag-srv-readonly-name truncate">{liveServer.name}</span>
                        <p className="ag-field-hint">
                          {liveServer.description ||
                            'Only the group founder can change the group icon.'}
                        </p>
                      </>
                    )}
                  </div>
                </div>

                {iconError && (
                  <p className="ag-field-hint ag-field-hint-danger" role="alert">
                    {iconError}
                  </p>
                )}

                {isModOrAdmin && (
                  <form className="ag-srv-form" onSubmit={(e) => void handleSaveMetadata(e)}>
                    <div className="ag-srv-meta-fields">
                      {canEditIcon && (
                        <div className="ag-srv-meta-specifier-col">
                          <label className="ag-field-label" htmlFor="ag-srv-settings-specifier">
                            2-Letter Specifier
                          </label>
                          <input
                            id="ag-srv-settings-specifier"
                            type="text"
                            maxLength={2}
                            className="ag-input mono ag-srv-specifier-input"
                            value={specifierDraft}
                            onChange={(e) =>
                              setSpecifierDraft(sanitizeGroupSpecifier(e.target.value))
                            }
                            placeholder={autoSpecifierPlaceholder}
                            aria-label="2-letter group specifier"
                            title="2-letter group specifier (optional)"
                          />
                        </div>
                      )}
                      <div className="ag-srv-meta-name-col">
                        <label className="ag-field-label" htmlFor="ag-srv-settings-name">
                          Group Name
                        </label>
                        <input
                          id="ag-srv-settings-name"
                          type="text"
                          maxLength={48}
                          className="ag-input"
                          value={nameDraft}
                          onChange={(e) => setNameDraft(e.target.value)}
                          placeholder="Group name"
                          aria-label="Group name"
                        />
                      </div>
                    </div>
                    <input
                      type="text"
                      maxLength={140}
                      className="ag-input"
                      value={descDraft}
                      onChange={(e) => setDescDraft(e.target.value)}
                      placeholder="Group description"
                      aria-label="Group description"
                    />
                    <div className="ag-srv-meta-save-row">
                      <div className="ag-color-swatches">
                        {ACCENT_CHOICES.map((hex) => (
                          <button
                            key={hex}
                            type="button"
                            className={`ag-color-swatch ${accentDraft === hex ? 'active' : ''}`}
                            style={{ backgroundColor: hex }}
                            onClick={() => setAccentDraft(hex)}
                            aria-label={`Select accent color ${hex}`}
                          >
                            {accentDraft === hex && <Check size={11} />}
                          </button>
                        ))}
                      </div>
                      <button
                        type="submit"
                        className="ag-btn ag-btn-primary ag-btn-sm"
                        disabled={savingMeta || !nameDraft.trim()}
                      >
                        {savingMeta ? <Loader2 size={12} className="ag-spin" /> : 'Save Changes'}
                      </button>
                    </div>
                  </form>
                )}
              </section>

              {/* Leave Server */}
              <section className="ag-panel-card ag-danger-card">
                <div className="ag-panel-card-head">
                  <div className="ag-panel-card-title ag-tone-danger">
                    <LogOut size={13} />
                    <span>LEAVE GROUP</span>
                  </div>
                  <button
                    type="button"
                    className="ag-btn ag-btn-danger-outline ag-btn-sm"
                    onClick={() => void handleLeave()}
                  >
                    <LogOut size={13} />
                    <span>{confirmLeave ? 'Click Again to Leave' : 'Leave Group'}</span>
                  </button>
                </div>
                <p className="ag-field-hint">
                  Removes this group{liveServer.encrypted ? ' and its local E2EE key' : ''} from
                  your sidebar.
                </p>
              </section>
            </div>
          )}

          {/* TAB: CHANNELS (Virtual Servers) */}
          {tab === 'channels' && liveServer.kind === 'virtual' && (
            <div className="ag-srv-settings-stack">
              {isModOrAdmin && (
                <section className="ag-panel-card">
                  <div className="ag-panel-card-head">
                    <div className="ag-panel-card-title">
                      <Plus size={13} />
                      <span>CREATE CHANNEL</span>
                    </div>
                  </div>
                  <form className="ag-srv-form" onSubmit={(e) => void handleAddChannel(e)}>
                    <div className="ag-jump-form">
                      <input
                        type="text"
                        maxLength={28}
                        className="ag-input mono"
                        placeholder="channel-name"
                        value={newChanName}
                        onChange={(e) => setNewChanName(e.target.value)}
                      />
                      <button
                        type="submit"
                        className="ag-btn ag-btn-primary"
                        disabled={!newChanName.trim() || addingChan}
                      >
                        {addingChan ? <Loader2 size={13} className="ag-spin" /> : 'Add'}
                      </button>
                    </div>
                    <input
                      type="text"
                      maxLength={100}
                      className="ag-input"
                      placeholder="Optional channel topic…"
                      value={newChanTopic}
                      onChange={(e) => setNewChanTopic(e.target.value)}
                    />
                  </form>
                </section>
              )}

              <div className="ag-blossom-list">
                {liveServer.channels.map((ch) => (
                  <div key={ch.id} className="ag-blossom-row">
                    <div className="ag-blossom-host-wrap">
                      <Hash size={13} className="ag-tone-muted" />
                      <div className="ag-whitelist-meta">
                        <span className="ag-blossom-host mono">{ch.name}</span>
                        {ch.topic && <span className="ag-whitelist-npub">{ch.topic}</span>}
                      </div>
                    </div>
                    {isModOrAdmin && ch.id !== 'general' && (
                      <button
                        type="button"
                        className="ag-icon-btn-xs ag-icon-btn-danger"
                        onClick={() => {
                          void servers.removeChannel(liveServer.id, ch.id)
                          onPlaySound?.('click')
                        }}
                        title={`Delete #${ch.name}`}
                        aria-label={`Delete #${ch.name}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB: MEMBERS & MODS */}
          {tab === 'members' && (
            <div className="ag-srv-settings-stack">
              {isModOrAdmin && (
                <section className="ag-panel-card">
                  <div className="ag-panel-card-head">
                    <div className="ag-panel-card-title">
                      <UserCheck size={13} />
                      <span>ADD MODERATOR / ADMIN</span>
                    </div>
                  </div>
                  <form className="ag-jump-form" onSubmit={(e) => void handleAddModerator(e)}>
                    <input
                      type="text"
                      className="ag-input mono"
                      placeholder="npub1… or 64-char hex pubkey"
                      value={modKeyDraft}
                      onChange={(e) => setModKeyDraft(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="ag-btn ag-btn-primary"
                      disabled={!modKeyDraft.trim()}
                    >
                      Promote
                    </button>
                  </form>
                </section>
              )}

              {liveServer.moderators.length > 0 && (
                <section className="ag-panel-card">
                  <div className="ag-panel-card-head">
                    <div className="ag-panel-card-title">
                      <ShieldCheck size={13} />
                      <span>MODERATORS</span>
                    </div>
                    <span className="ag-chip ag-chip-mono">{liveServer.moderators.length}</span>
                  </div>
                  <div className="ag-whitelist-list">
                    {liveServer.moderators.map((pk) => (
                      <div key={pk} className="ag-whitelist-row">
                        <AvatarImg
                          pubkey={pk}
                          pictureUrl={engine.getProfilePicture(pk)}
                          className="ag-whitelist-avatar"
                          width={26}
                          height={26}
                        />
                        <div className="ag-whitelist-meta">
                          <span className="ag-whitelist-npub mono truncate">{shortPubkey(pk, 12, 8)}</span>
                        </div>
                        {isFounder && pk !== liveServer.founderPubkey && (
                          <button
                            type="button"
                            className="ag-btn ag-btn-ghost ag-btn-xs"
                            onClick={() => void servers.removeModerator(liveServer.id, pk)}
                          >
                            Demote
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className="ag-panel-card">
                <div className="ag-panel-card-head">
                  <div className="ag-panel-card-title">
                    <Users size={13} />
                    <span>MEMBERS</span>
                  </div>
                  <span className="ag-chip ag-chip-mono">{servers.members.length}</span>
                </div>

                {servers.members.length === 0 ? (
                  <p className="ag-field-hint">No active members recorded yet.</p>
                ) : (
                  <div className="ag-whitelist-list">
                    {servers.members.map((m) => {
                      const isTrusted = !m.isSelf && engine.isExplicitlyTrusted(m.pubkey)
                      const isMod = m.isAdmin || m.roles.includes('mod')
                      return (
                        <div key={m.pubkey} className="ag-whitelist-row">
                          <AvatarImg
                            pubkey={m.pubkey}
                            pictureUrl={engine.getProfilePicture(m.pubkey)}
                            className="ag-whitelist-avatar"
                            width={26}
                            height={26}
                          />
                          <div className="ag-whitelist-meta">
                            <span
                              className="ag-whitelist-name truncate"
                              style={{ color: pubkeyToColor(m.pubkey) }}
                            >
                              {m.displayHandle}
                            </span>
                            <span className="ag-whitelist-npub mono">
                              {m.isFounder ? 'FOUNDER' : isMod ? 'MOD' : 'MEMBER'}
                            </span>
                          </div>
                          {!m.isSelf && (
                            <div className="ag-key-actions">
                              <button
                                type="button"
                                className={`ag-icon-btn-xs ag-icon-btn-trust ${isTrusted ? 'trusted' : ''}`}
                                onClick={() =>
                                  isTrusted
                                    ? engine.untrustPubkey(m.pubkey)
                                    : engine.trustPubkey(m.pubkey, m.nickname)
                                }
                                title={isTrusted ? 'Untrust peer' : 'Trust peer'}
                                aria-label={isTrusted ? `Untrust ${m.displayHandle}` : `Trust ${m.displayHandle}`}
                              >
                                {isTrusted ? <ShieldCheck size={12} /> : <Shield size={12} />}
                              </button>
                              {isModOrAdmin && !m.isFounder && !isMod && (
                                <button
                                  type="button"
                                  className="ag-icon-btn-xs"
                                  onClick={() => void servers.addModerator(liveServer.id, m.pubkey)}
                                  title="Promote to Moderator"
                                  aria-label={`Promote ${m.displayHandle}`}
                                >
                                  <UserCheck size={12} />
                                </button>
                              )}
                              {isModOrAdmin && !m.isFounder && (
                                <button
                                  type="button"
                                  className="ag-icon-btn-xs ag-icon-btn-danger"
                                  onClick={() => void servers.banMember(liveServer.id, m.pubkey)}
                                  title={`Ban ${m.displayHandle}`}
                                  aria-label={`Ban ${m.displayHandle}`}
                                >
                                  <Ban size={12} />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* TAB: BANS */}
          {tab === 'bans' && (
            <div className="ag-srv-settings-stack">
              {isModOrAdmin && (
                <section className="ag-panel-card">
                  <div className="ag-panel-card-head">
                    <div className="ag-panel-card-title ag-tone-danger">
                      <Ban size={13} />
                      <span>BAN PUBKEY</span>
                    </div>
                  </div>
                  <form className="ag-srv-form" onSubmit={(e) => void handleBanSubmit(e)}>
                    <input
                      type="text"
                      className="ag-input mono"
                      placeholder="npub1… or 64-char hex pubkey"
                      value={banKeyDraft}
                      onChange={(e) => setBanKeyDraft(e.target.value)}
                    />
                    <div className="ag-jump-form">
                      <input
                        type="text"
                        className="ag-input"
                        placeholder="Reason (optional)"
                        value={banReasonDraft}
                        onChange={(e) => setBanReasonDraft(e.target.value)}
                      />
                      <button
                        type="submit"
                        className="ag-btn ag-btn-danger-outline"
                        disabled={!banKeyDraft.trim()}
                      >
                        Ban
                      </button>
                    </div>
                  </form>
                </section>
              )}

              {liveServer.bannedPubkeys.length === 0 ? (
                <div className="ag-empty-panel">
                  <ShieldOff size={20} className="ag-empty-icon" />
                  <p className="ag-empty-title">No banned pubkeys</p>
                  <p className="ag-empty-sub">
                    Banned people are hidden from this group.
                  </p>
                </div>
              ) : (
                <div className="ag-whitelist-list">
                  {liveServer.bannedPubkeys.map((pk) => (
                    <div key={pk} className="ag-whitelist-row">
                      <AvatarImg
                        pubkey={pk}
                        pictureUrl={engine.getProfilePicture(pk)}
                        className="ag-whitelist-avatar"
                        width={26}
                        height={26}
                      />
                      <div className="ag-whitelist-meta">
                        <span className="ag-whitelist-npub mono truncate" title={pk}>
                          {shortPubkey(pk, 12, 8)}
                        </span>
                      </div>
                      {isModOrAdmin && (
                        <button
                          type="button"
                          className="ag-btn ag-btn-ok-outline ag-btn-xs"
                          onClick={() => {
                            void servers.unbanMember(liveServer.id, pk)
                            onPlaySound?.('click')
                          }}
                        >
                          Unban
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <IconCropModal
        file={iconCropFile}
        label={liveServer.name}
        busy={iconUploading}
        onCancel={() => {
          if (!iconUploading) setIconCropFile(null)
        }}
        onConfirm={handleIconCropConfirm}
      />
    </div>
  )
}

export default ServerSettingsModal
