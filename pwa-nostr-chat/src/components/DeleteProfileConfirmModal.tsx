import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Loader2, Trash2, X } from 'lucide-react'
import type { ProfileAccountRecord } from '../types/protocol.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import { pubkeyToColor, shortPubkey } from '../utils/identicon.ts'
import { AvatarImg } from './AvatarImg.tsx'

export interface DeleteProfileConfirmModalProps {
  profile: ProfileAccountRecord | null
  avatarUrl?: string
  busy?: boolean
  onCancel: () => void
  onConfirm: (pubkey: string) => void | Promise<void>
}

interface DeleteProfileConfirmModalInnerProps {
  profile: ProfileAccountRecord
  avatarUrl?: string
  busy: boolean
  onCancel: () => void
  onConfirm: (pubkey: string) => void | Promise<void>
}

function DeleteProfileConfirmModalInner({
  profile,
  avatarUrl,
  busy,
  onCancel,
  onConfirm,
}: DeleteProfileConfirmModalInnerProps) {
  const [acknowledged, setAcknowledged] = useState(false)
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null)

  const handleSafeCancel = useCallback(() => {
    if (busy) return
    onCancel()
  }, [busy, onCancel])

  // Android / PWA Back button closes this confirmation modal before anything underneath
  useBackHandler(true, handleSafeCancel)

  // Default initial focus on the safe Cancel action
  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      cancelBtnRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [])

  // Capture-phase Escape handler so outer popovers/modals never dismiss prematurely
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      if (!busy) {
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [busy, onCancel])

  return createPortal(
    <div
      className="ag-cf-confirm-backdrop"
      role="presentation"
      data-profile-delete-modal="true"
      onClick={handleSafeCancel}
    >
      <div
        className="ag-cf-confirm-modal ag-rotate-confirm-modal ag-delete-profile-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ag-delete-profile-title"
        aria-describedby="ag-delete-profile-desc"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ag-cf-confirm-head">
          <span className="ag-cf-confirm-badge" aria-hidden="true">
            <AlertTriangle size={22} />
          </span>
          <div className="ag-cf-confirm-title-wrap">
            <h2 id="ag-delete-profile-title" className="ag-cf-confirm-title">
              Remove Profile From This Device?
            </h2>
            <p className="ag-cf-confirm-subtitle">
              Destructive action · Permanently erases local profile data
            </p>
          </div>
          <button
            type="button"
            className="ag-cf-confirm-close"
            disabled={busy}
            onClick={handleSafeCancel}
            aria-label="Cancel profile removal"
            title="Cancel (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        <div className="ag-delete-profile-chip" aria-label={`Profile to remove: ${profile.nickname}`}>
          <AvatarImg
            pubkey={profile.pubkey}
            pictureUrl={avatarUrl ?? profile.picture}
            alt=""
            width={36}
            height={36}
            className="ag-delete-profile-avatar"
          />
          <div className="ag-delete-profile-chip-meta">
            <span
              className="ag-delete-profile-chip-name truncate"
              style={{ color: pubkeyToColor(profile.pubkey) }}
            >
              {profile.nickname}
            </span>
            <span className="ag-delete-profile-chip-sub mono truncate">
              {shortPubkey(profile.npub, 12, 6)}
            </span>
          </div>
        </div>

        <div className="ag-cf-confirm-callout">
          <AlertTriangle size={16} className="ag-cf-confirm-callout-icon" aria-hidden="true" />
          <p id="ag-delete-profile-desc" className="ag-cf-confirm-callout-text">
            Removing <strong>{profile.nickname}</strong> permanently deletes all locally stored
            data for this profile from this device.
          </p>
        </div>

        <ul className="ag-rotate-confirm-list">
          <li>
            <strong>Permanent local data removal:</strong> Deletes this profile&apos;s chats, DMs,
            groups, Agmail inbox, settings, and any unbacked-up Agwallet funds on this device.
          </li>
          <li>
            <strong>Private key backup required:</strong> Without a saved copy of this
            profile&apos;s private key (<span className="mono">nsec</span>), you cannot recover
            this identity or its funds after removal.
          </li>
          <li>
            <strong>Other profiles stay safe:</strong> Your active and other saved profiles remain
            completely untouched.
          </li>
        </ul>

        <label className="ag-rotate-confirm-check">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={busy}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            I understand and have backed up this profile&apos;s private key (
            <span className="mono">nsec</span>) if I want to keep it
          </span>
        </label>

        <div className="ag-cf-confirm-actions">
          <button
            ref={cancelBtnRef}
            type="button"
            className="ag-btn ag-btn-secondary ag-rotate-confirm-cancel-btn"
            disabled={busy}
            onClick={handleSafeCancel}
          >
            <span>Cancel</span>
          </button>
          <button
            type="button"
            className="ag-rotate-confirm-danger-btn"
            disabled={!acknowledged || busy}
            onClick={() => void onConfirm(profile.pubkey)}
          >
            {busy ? (
              <Loader2 size={14} className="ag-spin" aria-hidden="true" />
            ) : (
              <Trash2 size={14} aria-hidden="true" />
            )}
            <span>{busy ? 'Removing…' : 'Remove Profile Permanently'}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function DeleteProfileConfirmModal({
  profile,
  avatarUrl,
  busy = false,
  onCancel,
  onConfirm,
}: DeleteProfileConfirmModalProps) {
  if (!profile) return null
  return (
    <DeleteProfileConfirmModalInner
      key={profile.id}
      profile={profile}
      avatarUrl={avatarUrl}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}

export default DeleteProfileConfirmModal
