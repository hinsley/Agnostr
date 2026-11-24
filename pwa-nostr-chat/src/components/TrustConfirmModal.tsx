import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  Check,
  Copy,
  Image as ImageIcon,
  Mic,
  ShieldAlert,
  Users,
  Video,
  X,
} from 'lucide-react'
import type { PendingTrustRequest } from '../types/protocol.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import { pubkeyToColor, shortPubkey } from '../utils/identicon.ts'
import { AvatarImg } from './AvatarImg.tsx'

export interface TrustConfirmModalProps {
  request: PendingTrustRequest | null
  avatarUrl?: string
  onConfirm: () => void
  onCancel: () => void
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

export function TrustConfirmModal({
  request,
  avatarUrl,
  onConfirm,
  onCancel,
}: TrustConfirmModalProps) {
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null)
  const [copiedNpub, setCopiedNpub] = useState(false)
  const copyTimerRef = useRef<number | null>(null)
  const open = Boolean(request)
  const requestPubkey = request?.pubkey
  const resolvedAvatarUrl = useMemo(
    () => avatarUrl ?? readVerifiedCachedPicture(requestPubkey),
    [avatarUrl, requestPubkey],
  )

  // Android / PWA Back button cancels trust confirmation
  useBackHandler(open, onCancel)

  useEffect(() => {
    setCopiedNpub(false)
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = null
    }
    if (!request) return

    // Default focus on Cancel so accidental Enter/Space never blindly trusts
    const rafId = window.requestAnimationFrame(() => {
      cancelBtnRef.current?.focus()
    })

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.cancelAnimationFrame(rafId)
      window.removeEventListener('keydown', onKeyDown, true)
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
        copyTimerRef.current = null
      }
    }
  }, [request, onCancel])

  if (!request) return null

  const rawLabel = request.label?.trim()
  const displayTarget = rawLabel
    ? rawLabel.startsWith('@')
      ? rawLabel
      : `@${rawLabel}`
    : shortPubkey(request.npub, 10, 6)

  const handleCopyNpub = async () => {
    try {
      await navigator.clipboard.writeText(request.npub)
      setCopiedNpub(true)
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null
        setCopiedNpub(false)
      }, 1800)
    } catch {
      // Clipboard may be restricted in non-HTTPS contexts
    }
  }

  return createPortal(
    <div
      className="ag-trust-confirm-backdrop"
      role="presentation"
      onClick={onCancel}
    >
      <div
        className="ag-trust-confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ag-trust-confirm-title"
        aria-describedby="ag-trust-confirm-desc"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ag-trust-confirm-head">
          <span className="ag-trust-confirm-badge" aria-hidden="true">
            <ShieldAlert size={22} />
          </span>
          <div className="ag-trust-confirm-title-wrap">
            <h2 id="ag-trust-confirm-title" className="ag-trust-confirm-title">
              Trust{' '}
              <span
                className="ag-trust-confirm-target"
                style={{ color: pubkeyToColor(request.pubkey) }}
              >
                {displayTarget}
              </span>
              ?
            </h2>
            <p className="ag-trust-confirm-subtitle">High-trust security permission</p>
          </div>
          <button
            type="button"
            className="ag-trust-confirm-close"
            onClick={onCancel}
            aria-label="Cancel trust confirmation"
            title="Cancel (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        {/* Identity Verification Chip */}
        <div className="ag-trust-confirm-id-row">
          <AvatarImg
            pubkey={request.pubkey}
            pictureUrl={resolvedAvatarUrl}
            width={30}
            height={30}
            className="ag-trust-confirm-avatar"
          />
          <button
            type="button"
            className="ag-trust-confirm-npub-btn mono"
            onClick={() => void handleCopyNpub()}
            title={`Copy full npub: ${request.npub}`}
            aria-label={`Copy public key ${request.npub}`}
          >
            <span className="truncate">{shortPubkey(request.npub, 12, 6)}</span>
            {copiedNpub ? (
              <Check size={13} className="ag-trust-confirm-copied-icon" />
            ) : (
              <Copy size={13} />
            )}
          </button>
        </div>

        {/* Primary Unmistakable Warning Callout */}
        <div id="ag-trust-confirm-desc" className="ag-trust-confirm-callout">
          <AlertTriangle size={16} className="ag-trust-confirm-callout-icon" aria-hidden="true" />
          <p className="ag-trust-confirm-callout-text">
            Once trusted, this person can send you <strong>anything</strong> directly to your
            device. Be extremely careful before continuing.
          </p>
        </div>

        {/* Explicit Risk Breakdown */}
        <ul className="ag-trust-confirm-risks">
          <li className="ag-trust-confirm-risk-item">
            <span className="ag-trust-confirm-risk-icon" aria-hidden="true">
              <ImageIcon size={15} />
            </span>
            <span>
              <strong>Images &amp; photos</strong> will auto-load and display on your device
              (revealing your IP to the media host, and potentially unsolicited, shocking, or
              dangerous media).
            </span>
          </li>
          <li className="ag-trust-confirm-risk-item">
            <span className="ag-trust-confirm-risk-icon" aria-hidden="true">
              <Mic size={15} />
            </span>
            <span>
              <strong>Voice memos</strong> will automatically download, play, and transcribe
              locally.
            </span>
          </li>
          <li className="ag-trust-confirm-risk-item">
            <span className="ag-trust-confirm-risk-icon" aria-hidden="true">
              <Video size={15} />
            </span>
            <span>
              <strong>Live 1-on-1 DM calls &amp; Group Call audio/video</strong> will establish
              direct P2P WebRTC connections (revealing your IP address and streaming live camera
              &amp; microphone feeds).
            </span>
          </li>
          <li className="ag-trust-confirm-risk-item">
            <span className="ag-trust-confirm-risk-icon" aria-hidden="true">
              <Users size={15} />
            </span>
            <span>
              <strong>People list &amp; call ringing</strong>: they will appear in your{' '}
              <strong>People</strong> tab and can ring your device with DM calls.
            </span>
          </li>
        </ul>

        <p className="ag-trust-confirm-footer-note">
          Only trust people you genuinely know and have verified. Never trust strangers on public
          channels — you can remove trust or block them at any time.
        </p>

        <div className="ag-trust-confirm-actions">
          <button
            ref={cancelBtnRef}
            type="button"
            className="ag-trust-confirm-cancel-btn"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ag-trust-confirm-accept-btn"
            onClick={onConfirm}
          >
            <ShieldAlert size={15} />
            <span>I Understand — Trust Peer</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default TrustConfirmModal
