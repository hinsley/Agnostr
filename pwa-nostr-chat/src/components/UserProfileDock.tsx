import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  Camera,
  Check,
  Copy,
  Download,
  Landmark,
  Loader2,
  Pencil,
  Plus,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import type { AgnostrEngine, ProfileAccountRecord } from '../types/protocol'
import type { PwaState } from '../hooks/usePwa'
import type { SoundCue } from '../utils/sound'
import type { SettingsTab } from './SettingsModal'
import { AvatarImg } from './AvatarImg'
import { DeleteProfileConfirmModal } from './DeleteProfileConfirmModal'

function formatBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

export interface UserProfileDockProps {
  engine: AgnostrEngine
  variant?: 'dock' | 'rail'
  collapsed?: boolean
  pwa?: PwaState
  onOpenSettings: (tab?: SettingsTab) => void
  onOpenOwnAgoraProfile?: () => void
  onOpenInstall?: () => void
  onTooltipShow?: (el: HTMLElement) => void
  onTooltipHide?: () => void
  onPlaySound?: (cue: SoundCue) => void
}

export const UserProfileDock: React.FC<UserProfileDockProps> = ({
  engine,
  variant = 'dock',
  collapsed = false,
  pwa,
  onOpenSettings,
  onOpenOwnAgoraProfile,
  onOpenInstall,
  onTooltipShow,
  onTooltipHide,
  onPlaySound,
}) => {
  // Quick Profile Card Popover state (toggled from bottom user dock)
  const [quickProfileOpen, setQuickProfileOpen] = useState(false)
  const [qpAvatarMenuOpen, setQpAvatarMenuOpen] = useState(false)
  const [qpEditingName, setQpEditingName] = useState(false)
  const [qpNameDraft, setQpNameDraft] = useState('')
  const [qpUploadingPhoto, setQpUploadingPhoto] = useState(false)
  const [qpPhotoError, setQpPhotoError] = useState<string | null>(null)
  const [qpCopiedNpub, setQpCopiedNpub] = useState(false)
  const [qpProfileForm, setQpProfileForm] = useState<'none' | 'new' | 'import'>('none')
  const [qpNewProfileName, setQpNewProfileName] = useState('')
  const [qpImportSecret, setQpImportSecret] = useState('')
  const [qpProfileError, setQpProfileError] = useState<string | null>(null)
  const [qpProfileBusy, setQpProfileBusy] = useState(false)
  const [pendingDeleteProfile, setPendingDeleteProfile] = useState<ProfileAccountRecord | null>(
    null
  )
  const [qpPos, setQpPos] = useState<{
    left: number
    bottom: number
    width: number
    maxHeight: number
  } | null>(null)
  const footerRef = useRef<HTMLDivElement | null>(null)
  const profileTriggerRef = useRef<HTMLButtonElement | null>(null)
  const quickProfileRef = useRef<HTMLDivElement | null>(null)
  const qpAvatarWrapRef = useRef<HTMLDivElement | null>(null)
  const qpNameInputRef = useRef<HTMLInputElement | null>(null)
  const qpFileInputRef = useRef<HTMLInputElement | null>(null)
  const qpNewProfileInputRef = useRef<HTMLInputElement | null>(null)
  const qpImportInputRef = useRef<HTMLInputElement | null>(null)
  const qpCopyTimerRef = useRef<number | null>(null)

  const isQuickProfileVisible = quickProfileOpen && !collapsed

  // Prefetch verified kind: 0 profile pictures for self + all saved profiles
  const profilePubkeysKey = useMemo(() => {
    const set = new Set<string>()
    const addPk = (raw?: string | null) => {
      if (!raw) return
      const pk = raw.trim().toLowerCase()
      if (/^[0-9a-f]{64}$/.test(pk)) set.add(pk)
    }
    addPk(engine.identity.masterPubkey)
    for (const prof of engine.profiles.profiles) addPk(prof.pubkey)
    return Array.from(set).sort().join(',')
  }, [engine.identity.masterPubkey, engine.profiles.profiles])

  const ensureProfilePictures = engine.ensureProfilePictures
  useEffect(() => {
    if (!profilePubkeysKey) return
    ensureProfilePictures(profilePubkeysKey.split(','))
  }, [profilePubkeysKey, ensureProfilePictures])

  const computeQuickProfilePos = useCallback(() => {
    if (typeof window === 'undefined') return null
    const vw = window.innerWidth
    const vh = window.innerHeight
    const width = Math.min(296, Math.max(220, vw - 16))
    if (variant === 'rail') {
      const rect = profileTriggerRef.current?.getBoundingClientRect()
      if (!rect) {
        return { left: 78, bottom: 12, width, maxHeight: Math.max(220, Math.min(540, vh - 24)) }
      }
      const left = Math.max(8, Math.min(vw - width - 12, Math.round(rect.right + 10)))
      const bottom = Math.max(12, Math.min(Math.round(vh - rect.bottom), Math.max(12, vh - 120)))
      const maxHeight = Math.max(220, Math.min(540, vh - bottom - 12, vh - 24))
      return { left, bottom, width, maxHeight }
    }
    const rect = footerRef.current?.getBoundingClientRect()
    if (!rect) {
      return { left: 8, bottom: 68, width, maxHeight: Math.max(220, vh - 80) }
    }
    const left = Math.max(8, Math.min(Math.round(rect.left + 8), vw - width - 8))
    const bottom = Math.max(12, Math.min(Math.round(vh - rect.top + 8), Math.max(12, vh - 120)))
    const maxHeight = Math.max(220, Math.min(vh - bottom - 12, vh - 24))
    return { left, bottom, width, maxHeight }
  }, [variant])

  const closeQuickProfile = useCallback(() => {
    setQuickProfileOpen(false)
    setQpAvatarMenuOpen(false)
    setQpEditingName(false)
    setQpPhotoError(null)
    setQpProfileForm('none')
    setQpNewProfileName('')
    setQpImportSecret('')
    setQpProfileError(null)
    setPendingDeleteProfile(null)
  }, [])

  const handleToggleQuickProfile = useCallback(() => {
    onPlaySound?.('click')
    onTooltipHide?.()
    setQuickProfileOpen((prev) => {
      if (prev) {
        setQpAvatarMenuOpen(false)
        setQpEditingName(false)
        setQpPhotoError(null)
        setQpProfileForm('none')
        setQpNewProfileName('')
        setQpImportSecret('')
        setQpProfileError(null)
        setPendingDeleteProfile(null)
        return false
      }
      setQpPos(computeQuickProfilePos())
      setQpAvatarMenuOpen(false)
      setQpPhotoError(null)
      setQpEditingName(false)
      setQpProfileForm('none')
      setQpNewProfileName('')
      setQpImportSecret('')
      setQpProfileError(null)
      setPendingDeleteProfile(null)
      return true
    })
  }, [computeQuickProfilePos, onPlaySound, onTooltipHide])

  // Quick Profile Popover outside-click, Escape, and viewport reposition listeners
  useEffect(() => {
    if (!isQuickProfileVisible) return
    const handlePointerDown = (ev: PointerEvent) => {
      if (pendingDeleteProfile) return
      const target = ev.target as Node | null
      if (!target) return
      const targetEl = target instanceof Element ? target : target.parentElement
      if (targetEl?.closest('[data-profile-delete-modal="true"]')) return
      if (qpAvatarMenuOpen && !qpAvatarWrapRef.current?.contains(target)) {
        setQpAvatarMenuOpen(false)
      }
      if (quickProfileRef.current?.contains(target)) return
      if (profileTriggerRef.current?.contains(target)) return
      closeQuickProfile()
    }
    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      if (pendingDeleteProfile || document.querySelector('[data-profile-delete-modal="true"]')) {
        return
      }
      ev.preventDefault()
      ev.stopPropagation()
      if (qpAvatarMenuOpen) {
        setQpAvatarMenuOpen(false)
        return
      }
      if (qpProfileForm !== 'none') {
        setQpProfileForm('none')
        setQpProfileError(null)
        return
      }
      if (qpEditingName) {
        setQpEditingName(false)
        return
      }
      closeQuickProfile()
    }
    const handleViewportMove = () => {
      setQpPos(computeQuickProfilePos())
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('resize', handleViewportMove)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('resize', handleViewportMove)
    }
  }, [
    isQuickProfileVisible,
    pendingDeleteProfile,
    qpAvatarMenuOpen,
    qpProfileForm,
    qpEditingName,
    closeQuickProfile,
    computeQuickProfilePos,
  ])

  useEffect(() => {
    if (qpProfileForm === 'none') return
    const raf = window.requestAnimationFrame(() => {
      if (qpProfileForm === 'new') {
        qpNewProfileInputRef.current?.focus()
      } else if (qpProfileForm === 'import') {
        qpImportInputRef.current?.focus()
      }
    })
    return () => window.cancelAnimationFrame(raf)
  }, [qpProfileForm])

  useEffect(() => {
    if (!qpEditingName) return
    const raf = window.requestAnimationFrame(() => {
      const input = qpNameInputRef.current
      if (input) {
        input.focus()
        input.select()
      }
    })
    return () => window.cancelAnimationFrame(raf)
  }, [qpEditingName])

  useEffect(() => {
    return () => {
      if (qpCopyTimerRef.current !== null) {
        window.clearTimeout(qpCopyTimerRef.current)
      }
    }
  }, [])

  const handleQuickPhotoChange = useCallback(
    async (ev: React.ChangeEvent<HTMLInputElement>) => {
      const file = ev.target.files?.[0]
      ev.target.value = ''
      if (!file) return
      if (!file.type.startsWith('image/')) {
        setQpPhotoError('Please choose an image file.')
        return
      }
      setQpUploadingPhoto(true)
      setQpPhotoError(null)
      try {
        const res = await engine.updateMyProfilePicture(file)
        if (!res.ok) {
          setQpPhotoError(res.error || 'Could not update profile photo.')
        } else {
          onPlaySound?.('click')
        }
      } catch (err) {
        setQpPhotoError(err instanceof Error ? err.message : 'Could not update profile photo.')
      } finally {
        setQpUploadingPhoto(false)
      }
    },
    [engine, onPlaySound]
  )

  const handleQuickPhotoRemove = useCallback(async () => {
    setQpUploadingPhoto(true)
    setQpPhotoError(null)
    try {
      const res = await engine.updateMyProfilePicture(null)
      if (!res.ok) {
        setQpPhotoError(res.error || 'Could not remove profile photo.')
      } else {
        onPlaySound?.('click')
      }
    } catch (err) {
      setQpPhotoError(err instanceof Error ? err.message : 'Could not remove profile photo.')
    } finally {
      setQpUploadingPhoto(false)
    }
  }, [engine, onPlaySound])

  const handleStartQuickNameEdit = useCallback(() => {
    setQpAvatarMenuOpen(false)
    setQpNameDraft(engine.identity.nickname)
    setQpEditingName(true)
  }, [engine.identity.nickname])

  const handleSaveQuickName = useCallback(
    (ev?: FormEvent) => {
      ev?.preventDefault()
      const trimmed = qpNameDraft.trim().slice(0, 32)
      if (!trimmed) {
        setQpEditingName(false)
        return
      }
      if (trimmed !== engine.identity.nickname) {
        engine.setNickname(trimmed)
        onPlaySound?.('click')
      }
      setQpEditingName(false)
    },
    [qpNameDraft, engine, onPlaySound]
  )

  const handleCopyQuickNpub = useCallback(() => {
    const npub = engine.identity.masterNpub
    if (!npub) return
    navigator.clipboard
      ?.writeText(npub)
      .then(() => {
        onPlaySound?.('click')
        setQpCopiedNpub(true)
        if (qpCopyTimerRef.current !== null) {
          window.clearTimeout(qpCopyTimerRef.current)
        }
        qpCopyTimerRef.current = window.setTimeout(() => {
          setQpCopiedNpub(false)
          qpCopyTimerRef.current = null
        }, 1800)
      })
      .catch(() => {
        engine.pushToast('error', 'Could not copy npub')
      })
  }, [engine, onPlaySound])

  const handleSwitchProfile = useCallback(
    (targetPubkey: string) => {
      if (engine.profiles.switching || qpProfileBusy) return
      setQpProfileError(null)
      setPendingDeleteProfile(null)
      onPlaySound?.('click')
      void engine.profiles.switchProfile(targetPubkey)
    },
    [engine.profiles, qpProfileBusy, onPlaySound]
  )

  const handleCreateProfileSubmit = useCallback(
    async (ev: FormEvent) => {
      ev.preventDefault()
      if (engine.profiles.switching || qpProfileBusy) return
      setQpProfileBusy(true)
      setQpProfileError(null)
      try {
        const nickname = qpNewProfileName.trim().slice(0, 24) || undefined
        const created = await engine.profiles.createProfile(nickname ? { nickname } : undefined)
        if (!created) {
          setQpProfileError('Could not create profile.')
          setQpProfileBusy(false)
        } else {
          onPlaySound?.('click')
          setQpNewProfileName('')
          setQpProfileForm('none')
          setQpProfileBusy(false)
        }
      } catch (err) {
        setQpProfileError(err instanceof Error ? err.message : 'Could not create profile.')
        setQpProfileBusy(false)
      }
    },
    [engine.profiles, qpProfileBusy, qpNewProfileName, onPlaySound]
  )

  const handleImportProfileSubmit = useCallback(
    async (ev: FormEvent) => {
      ev.preventDefault()
      if (engine.profiles.switching || qpProfileBusy) return
      const secret = qpImportSecret.trim()
      if (!secret) {
        setQpProfileError('Enter an nsec1… or 64-character hex private key.')
        return
      }
      setQpProfileBusy(true)
      setQpProfileError(null)
      try {
        const res = await engine.profiles.importProfile(secret)
        if (!res.ok) {
          setQpProfileError(res.error || 'Invalid private key.')
          setQpProfileBusy(false)
          return
        }
        onPlaySound?.('click')
        setQpImportSecret('')
        setQpProfileForm('none')
        setQpProfileBusy(false)
      } catch (err) {
        setQpProfileError(err instanceof Error ? err.message : 'Could not import key.')
        setQpProfileBusy(false)
      }
    },
    [engine.profiles, qpProfileBusy, qpImportSecret, onPlaySound]
  )

  const handleConfirmDeleteProfile = useCallback(
    async (targetPubkey: string) => {
      if (engine.profiles.switching || qpProfileBusy) return
      setQpProfileBusy(true)
      setQpProfileError(null)
      try {
        const deleted = await engine.profiles.deleteProfile(targetPubkey)
        if (deleted) {
          onPlaySound?.('click')
          engine.pushToast('info', 'Profile removed from this device')
        } else {
          setQpProfileError('Could not remove profile.')
        }
      } catch (err) {
        setQpProfileError(err instanceof Error ? err.message : 'Could not remove profile.')
      } finally {
        setPendingDeleteProfile(null)
        setQpProfileBusy(false)
      }
    },
    [engine, qpProfileBusy, onPlaySound]
  )

  return (
    <>
      {variant === 'rail' ? (
        <button
          ref={profileTriggerRef}
          type="button"
          className={`ag-rail-profile-btn ${isQuickProfileVisible ? 'active' : ''}`}
          onClick={handleToggleQuickProfile}
          onMouseEnter={(e) => {
            if (!isQuickProfileVisible) onTooltipShow?.(e.currentTarget)
          }}
          onMouseLeave={() => onTooltipHide?.()}
          onFocus={(e) => {
            if (!isQuickProfileVisible) onTooltipShow?.(e.currentTarget)
          }}
          onBlur={() => onTooltipHide?.()}
          aria-label={`${engine.identity.nickname} · Profiles & Identity`}
          aria-haspopup="dialog"
          aria-expanded={isQuickProfileVisible}
        >
          <AvatarImg
            pubkey={engine.identity.masterPubkey}
            pictureUrl={engine.getProfilePicture(engine.identity.masterPubkey)}
            width={30}
            height={30}
            className="ag-rail-profile-img"
          />
          {engine.profiles.otherProfilesUnreadCount > 0 && (
            <span className="ag-rail-badge ping tabular">
              {formatBadgeCount(engine.profiles.otherProfilesUnreadCount)}
            </span>
          )}
        </button>
      ) : (
        /* Bottom User Dock (Compact Profile + Quiet Status; mobile-only Settings) */
        <div ref={footerRef} className="ag-conv-footer">
          <button
            ref={profileTriggerRef}
            type="button"
            className={`ag-profile-bar-btn ${isQuickProfileVisible ? 'active' : ''}`}
            onClick={handleToggleQuickProfile}
            title="Quick profile"
            aria-haspopup="dialog"
            aria-expanded={isQuickProfileVisible}
          >
            <span className="ag-profile-avatar-wrap">
              <AvatarImg
                pubkey={engine.identity.masterPubkey}
                pictureUrl={engine.getProfilePicture(engine.identity.masterPubkey)}
                width={30}
                height={30}
                className="ag-profile-avatar"
              />
              <span
                className={`ag-profile-status-dot ${engine.connectedRelayCount > 0 ? 'online' : 'reconnecting'}`}
                aria-hidden="true"
              />
            </span>
            <div className="ag-profile-meta">
              <span className="ag-profile-name truncate">{engine.identity.nickname}</span>
              <span className="ag-profile-sub truncate">
                {engine.connectedRelayCount > 0 ? 'Online' : 'Reconnecting…'}
              </span>
            </div>
            {engine.profiles.otherProfilesUnreadCount > 0 && (
              <span
                className="ag-profile-dock-badge tabular"
                aria-label={`${engine.profiles.otherProfilesUnreadCount} notifications on other profiles`}
                title={`${engine.profiles.otherProfilesUnreadCount} notification${engine.profiles.otherProfilesUnreadCount === 1 ? '' : 's'} on other profiles`}
              >
                {formatBadgeCount(engine.profiles.otherProfilesUnreadCount)}
              </span>
            )}
          </button>

          <div className="ag-conv-footer-actions ag-mobile-only">
            {pwa && !pwa.isInstalled && pwa.canPromptInstall && onOpenInstall && (
              <button
                type="button"
                className="ag-circle-btn ag-dock-icon-btn ag-mobile-only"
                onClick={onOpenInstall}
                title="Install App"
                aria-label="Install Agnostr App"
              >
                <Download size={16} aria-hidden="true" />
              </button>
            )}

            <button
              type="button"
              className="ag-circle-btn ag-dock-icon-btn ag-mobile-only"
              onClick={() => {
                onPlaySound?.('click')
                onOpenSettings()
              }}
              title="Settings"
              aria-label="Settings"
            >
              <Settings size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* Sleek Quick Profile Card Popover */}
      {isQuickProfileVisible &&
        typeof document !== 'undefined' &&
        (() => {
          const masterPk = engine.identity.masterPubkey
          const masterNpub = engine.identity.masterNpub
          const myPictureUrl = engine.getProfilePicture(masterPk)
          const truncatedNpub =
            masterNpub.length > 22
              ? `${masterNpub.slice(0, 12)}…${masterNpub.slice(-8)}`
              : masterNpub
          const relayCount = engine.connectedRelayCount
          const posStyle: CSSProperties = qpPos
            ? {
                left: `${qpPos.left}px`,
                bottom: `${qpPos.bottom}px`,
                width: `${qpPos.width}px`,
                maxHeight: `${qpPos.maxHeight}px`,
              }
            : { left: '8px', bottom: '68px', width: '296px' }
          const storedProfiles = engine.profiles.profiles
          const activeProfileId = engine.profiles.activeProfileId
          const otherNotifs = engine.profiles.otherProfilesUnreadCount
          const notificationsByProfile = engine.profiles.notificationsByProfile
          const isProfileActionBusy = engine.profiles.switching || qpProfileBusy

          return createPortal(
            <div
              ref={quickProfileRef}
              className="ag-quick-profile-popover"
              role="dialog"
              aria-label="Quick profile"
              style={posStyle}
            >
              <input
                ref={qpFileInputRef}
                type="file"
                accept="image/*"
                className="ag-qp-file-input"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(ev) => void handleQuickPhotoChange(ev)}
              />

              <div className="ag-qp-header">
                <div ref={qpAvatarWrapRef} className="ag-qp-avatar-wrap">
                  <button
                    type="button"
                    className={`ag-qp-avatar-btn ${qpAvatarMenuOpen ? 'menu-open' : ''}`}
                    disabled={qpUploadingPhoto}
                    onClick={() => {
                      if (myPictureUrl) {
                        onPlaySound?.('click')
                        setQpAvatarMenuOpen((v) => !v)
                      } else {
                        setQpAvatarMenuOpen(false)
                        qpFileInputRef.current?.click()
                      }
                    }}
                    title={myPictureUrl ? 'Profile photo options' : 'Upload profile photo'}
                    aria-label={myPictureUrl ? 'Profile photo options' : 'Upload profile photo'}
                    aria-haspopup={myPictureUrl ? 'menu' : undefined}
                    aria-expanded={myPictureUrl ? qpAvatarMenuOpen : undefined}
                  >
                    <AvatarImg
                      pubkey={masterPk}
                      pictureUrl={myPictureUrl}
                      width={52}
                      height={52}
                      className="ag-qp-avatar"
                    />
                    <span className="ag-qp-avatar-overlay" aria-hidden="true">
                      {qpUploadingPhoto ? (
                        <Loader2 size={15} className="ag-spin" />
                      ) : (
                        <Camera size={15} />
                      )}
                    </span>
                    <span
                      className={`ag-qp-status-ring ${relayCount > 0 ? 'online' : 'reconnecting'}`}
                      aria-hidden="true"
                    />
                  </button>

                  {myPictureUrl && qpAvatarMenuOpen && (
                    <div
                      className="ag-qp-avatar-menu"
                      role="menu"
                      aria-label="Profile photo options"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className="ag-qp-avatar-menu-item"
                        disabled={qpUploadingPhoto}
                        onClick={() => {
                          setQpAvatarMenuOpen(false)
                          qpFileInputRef.current?.click()
                        }}
                      >
                        <Camera size={13} aria-hidden="true" />
                        <span>Change photo</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="ag-qp-avatar-menu-item danger"
                        disabled={qpUploadingPhoto}
                        onClick={() => {
                          setQpAvatarMenuOpen(false)
                          void handleQuickPhotoRemove()
                        }}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                        <span>Remove photo</span>
                      </button>
                    </div>
                  )}
                </div>

                {/* Inline Display Name Editor + Live Status */}
                <div className="ag-qp-name-block">
                  {qpEditingName ? (
                    <form className="ag-qp-name-form" onSubmit={handleSaveQuickName}>
                      <input
                        ref={qpNameInputRef}
                        type="text"
                        className="ag-qp-name-input"
                        value={qpNameDraft}
                        maxLength={32}
                        placeholder="Display name"
                        aria-label="Display name"
                        onChange={(ev) => setQpNameDraft(ev.target.value)}
                      />
                      <button
                        type="submit"
                        className="ag-qp-icon-btn primary"
                        title="Save display name"
                        aria-label="Save display name"
                      >
                        <Check size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="ag-qp-icon-btn"
                        onClick={() => setQpEditingName(false)}
                        title="Cancel"
                        aria-label="Cancel editing display name"
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </form>
                  ) : (
                    <div className="ag-qp-name-row">
                      <span className="ag-qp-display-name truncate">
                        {engine.identity.nickname}
                      </span>
                      <button
                        type="button"
                        className="ag-qp-icon-btn"
                        onClick={handleStartQuickNameEdit}
                        title="Edit display name"
                        aria-label="Edit display name"
                      >
                        <Pencil size={13} aria-hidden="true" />
                      </button>
                    </div>
                  )}

                  <div className="ag-qp-status-line">
                    <span
                      className={`ag-qp-status-dot ${relayCount > 0 ? 'online' : 'reconnecting'}`}
                      aria-hidden="true"
                    />
                    <span className="truncate">
                      {relayCount > 0
                        ? `Online · ${relayCount} ${relayCount === 1 ? 'relay' : 'relays'}`
                        : 'Reconnecting…'}
                    </span>
                  </div>
                </div>
              </div>

              {qpPhotoError && (
                <div className="ag-qp-error" role="alert">
                  {qpPhotoError}
                </div>
              )}

              {/* Identity npub + 1-click Copy */}
              <div className="ag-qp-npub-row">
                <code className="ag-qp-npub-code truncate" title={masterNpub}>
                  {truncatedNpub}
                </code>
                <button
                  type="button"
                  className={`ag-qp-copy-btn ${qpCopiedNpub ? 'copied' : ''}`}
                  onClick={handleCopyQuickNpub}
                  title="Copy npub"
                  aria-label="Copy npub"
                >
                  {qpCopiedNpub ? (
                    <>
                      <Check size={12} aria-hidden="true" />
                      <span>Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy size={12} aria-hidden="true" />
                      <span>Copy npub</span>
                    </>
                  )}
                </button>
              </div>

              {/* View Agora Profile Shortcut (strictly NO Settings button inside popover) */}
              {onOpenOwnAgoraProfile && (
                <div className="ag-qp-footer">
                  <button
                    type="button"
                    className="ag-qp-agora-btn"
                    onClick={() => {
                      onPlaySound?.('click')
                      closeQuickProfile()
                      onOpenOwnAgoraProfile()
                    }}
                  >
                    <Landmark size={14} aria-hidden="true" />
                    <span>View Agora Profile</span>
                  </button>
                </div>
              )}

              {/* Compact Multi-Profile Switcher Section */}
              <div className="ag-qp-divider" aria-hidden="true" />

              <div className="ag-qp-profiles" aria-label="Profiles">
                <div className="ag-qp-profiles-head">
                  <div className="ag-qp-profiles-title-wrap">
                    <span className="ag-qp-profiles-title">Profiles</span>
                    <span className="ag-qp-profiles-count tabular">{storedProfiles.length}</span>
                    {otherNotifs > 0 && (
                      <span
                        className="ag-qp-profiles-notif-pill tabular"
                        title={`${otherNotifs} notification${otherNotifs === 1 ? '' : 's'} on other profiles`}
                        aria-label={`${otherNotifs} notifications on other profiles`}
                      >
                        {formatBadgeCount(otherNotifs)} new
                      </span>
                    )}
                  </div>
                  <div className="ag-qp-profiles-actions">
                    <button
                      type="button"
                      className={`ag-qp-mini-btn ${qpProfileForm === 'new' ? 'active' : ''}`}
                      disabled={isProfileActionBusy}
                      onClick={() => {
                        onPlaySound?.('click')
                        setQpProfileError(null)
                        setPendingDeleteProfile(null)
                        setQpImportSecret('')
                        setQpProfileForm((prev) => (prev === 'new' ? 'none' : 'new'))
                      }}
                    >
                      <Plus size={11} aria-hidden="true" />
                      <span>New</span>
                    </button>
                    <button
                      type="button"
                      className={`ag-qp-mini-btn ${qpProfileForm === 'import' ? 'active' : ''}`}
                      disabled={isProfileActionBusy}
                      onClick={() => {
                        onPlaySound?.('click')
                        setQpProfileError(null)
                        setPendingDeleteProfile(null)
                        setQpNewProfileName('')
                        setQpProfileForm((prev) => (prev === 'import' ? 'none' : 'import'))
                      }}
                    >
                      <span>Import</span>
                    </button>
                  </div>
                </div>

                {/* Inline New Profile Mini-Form */}
                {qpProfileForm === 'new' && (
                  <form
                    className="ag-qp-inline-form"
                    onSubmit={(ev) => void handleCreateProfileSubmit(ev)}
                  >
                    <input
                      ref={qpNewProfileInputRef}
                      type="text"
                      className="ag-qp-inline-input"
                      maxLength={24}
                      placeholder="Display name (optional)"
                      aria-label="New profile display name"
                      value={qpNewProfileName}
                      disabled={isProfileActionBusy}
                      onChange={(ev) => setQpNewProfileName(ev.target.value)}
                    />
                    {qpProfileError && (
                      <div className="ag-qp-error" role="alert">
                        {qpProfileError}
                      </div>
                    )}
                    <div className="ag-qp-inline-form-actions">
                      <button
                        type="submit"
                        className="ag-qp-inline-btn primary"
                        disabled={isProfileActionBusy}
                      >
                        {isProfileActionBusy ? (
                          <Loader2 size={12} className="ag-spin" aria-hidden="true" />
                        ) : null}
                        <span>Create</span>
                      </button>
                      <button
                        type="button"
                        className="ag-qp-inline-btn"
                        disabled={isProfileActionBusy}
                        onClick={() => {
                          setQpProfileForm('none')
                          setQpNewProfileName('')
                          setQpProfileError(null)
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                {/* Inline Import Key Mini-Form */}
                {qpProfileForm === 'import' && (
                  <form
                    className="ag-qp-inline-form"
                    onSubmit={(ev) => void handleImportProfileSubmit(ev)}
                  >
                    <input
                      ref={qpImportInputRef}
                      type="password"
                      className="ag-qp-inline-input mono"
                      placeholder="nsec1… or 64-hex private key"
                      aria-label="Private key (nsec or 64-character hex)"
                      autoComplete="off"
                      spellCheck={false}
                      value={qpImportSecret}
                      disabled={isProfileActionBusy}
                      onChange={(ev) => {
                        setQpImportSecret(ev.target.value)
                        if (qpProfileError) setQpProfileError(null)
                      }}
                    />
                    {qpProfileError && (
                      <div className="ag-qp-error" role="alert">
                        {qpProfileError}
                      </div>
                    )}
                    <div className="ag-qp-inline-form-actions">
                      <button
                        type="submit"
                        className="ag-qp-inline-btn primary"
                        disabled={isProfileActionBusy || !qpImportSecret.trim()}
                      >
                        {isProfileActionBusy ? (
                          <Loader2 size={12} className="ag-spin" aria-hidden="true" />
                        ) : null}
                        <span>Import</span>
                      </button>
                      <button
                        type="button"
                        className="ag-qp-inline-btn"
                        disabled={isProfileActionBusy}
                        onClick={() => {
                          setQpProfileForm('none')
                          setQpImportSecret('')
                          setQpProfileError(null)
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                {qpProfileForm === 'none' && qpProfileError && (
                  <div className="ag-qp-error" role="alert">
                    {qpProfileError}
                  </div>
                )}

                {/* Scrollable Stored Profiles List */}
                <div className="ag-qp-profile-list" role="list" aria-label="Saved profiles">
                  {storedProfiles.map((p) => {
                    const isActive = p.id === activeProfileId
                    const profileLabel = isActive ? engine.identity.nickname : p.nickname
                    const shortNpub =
                      p.npub.length > 15
                        ? `${p.npub.slice(0, 9)}…${p.npub.slice(-4)}`
                        : p.npub
                    const pNotif = !isActive ? notificationsByProfile[p.id] : undefined
                    const pUnread = pNotif?.unreadCount ?? 0
                    return (
                      <div
                        key={p.id}
                        role="listitem"
                        className={`ag-qp-profile-row ${isActive ? 'is-active' : ''} ${
                          pUnread > 0 ? 'has-notif' : ''
                        }`}
                      >
                        <button
                          type="button"
                          className="ag-qp-profile-select"
                          disabled={isActive || isProfileActionBusy}
                          aria-current={isActive ? 'true' : undefined}
                          title={
                            isActive
                              ? `${profileLabel} (Active)`
                              : pUnread > 0 && pNotif?.lastSummary
                                ? `Switch to ${profileLabel} · ${pNotif.lastSummary}`
                                : `Switch to ${profileLabel}`
                          }
                          onClick={() => {
                            if (!isActive) handleSwitchProfile(p.pubkey)
                          }}
                        >
                          <AvatarImg
                            pubkey={p.pubkey}
                            pictureUrl={
                              isActive
                                ? myPictureUrl
                                : (engine.getProfilePicture(p.pubkey) ?? p.picture)
                            }
                            width={28}
                            height={28}
                            className="ag-qp-profile-avatar"
                          />
                          <div className="ag-qp-profile-meta">
                            <span className="ag-qp-profile-name truncate">{profileLabel}</span>
                            {pUnread > 0 && pNotif?.lastSummary ? (
                              <span
                                className="ag-qp-profile-notif-summary truncate"
                                title={pNotif.lastSummary}
                              >
                                {pNotif.lastSummary}
                              </span>
                            ) : (
                              <span className="ag-qp-profile-sub mono truncate">
                                #{p.pubkey.slice(-4)} · {shortNpub}
                              </span>
                            )}
                          </div>
                          {isActive ? (
                            <span
                              className="ag-qp-profile-check"
                              aria-label="Active profile"
                              title="Active profile"
                            >
                              <Check size={14} aria-hidden="true" />
                            </span>
                          ) : pUnread > 0 ? (
                            <span
                              className="ag-qp-profile-badge tabular"
                              aria-label={`${pUnread} unread notification${pUnread === 1 ? '' : 's'}`}
                              title={pNotif?.lastSummary || `${pUnread} unread`}
                            >
                              {formatBadgeCount(pUnread)}
                            </span>
                          ) : null}
                        </button>

                        {!isActive && (
                          <button
                            type="button"
                            className="ag-qp-profile-remove-btn"
                            disabled={isProfileActionBusy}
                            onClick={() => {
                              onPlaySound?.('click')
                              setQpProfileError(null)
                              setPendingDeleteProfile(p)
                            }}
                            title={`Remove ${profileLabel}`}
                            aria-label={`Remove ${profileLabel}`}
                          >
                            <Trash2 size={12} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>,
            document.body
          )
        })()}

      <DeleteProfileConfirmModal
        profile={pendingDeleteProfile}
        avatarUrl={
          pendingDeleteProfile
            ? (engine.getProfilePicture(pendingDeleteProfile.pubkey) ??
              pendingDeleteProfile.picture)
            : undefined
        }
        busy={qpProfileBusy}
        onCancel={() => {
          if (!qpProfileBusy) {
            onPlaySound?.('click')
            setPendingDeleteProfile(null)
          }
        }}
        onConfirm={handleConfirmDeleteProfile}
      />
    </>
  )
}

export default UserProfileDock
