import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Eye,
  File as FileIcon,
  FileWarning,
  Lock,
  ShieldAlert,
  ShieldCheck,
  Wifi,
  X,
} from 'lucide-react'
import type { PendingTorrentDownloadRequest } from '../types/torrent.ts'
import {
  formatTorrentBytes,
  getTorrentFileExtension,
  isRiskyExecutableExtension,
} from '../lib/torrentProtocol.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import { pubkeyToColor, shortPubkey } from '../utils/identicon.ts'
import { AvatarImg } from './AvatarImg.tsx'

export interface TorrentDownloadModalProps {
  request: PendingTorrentDownloadRequest | null
  avatarUrl?: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * MANDATORY download disclaimer popup before ANY P2P file download from another peer.
 * Intentionally has ZERO "Don't show again" option or bypass mechanism.
 */
export function TorrentDownloadModal({
  request,
  avatarUrl,
  onConfirm,
  onCancel,
}: TorrentDownloadModalProps) {
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null)
  const [copiedNpub, setCopiedNpub] = useState(false)
  const copyTimerRef = useRef<number | null>(null)
  const open = Boolean(request)

  useBackHandler(open, onCancel)

  useEffect(() => {
    setCopiedNpub(false)
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = null
    }
    if (!request) return

    // Auto-focus Cancel so accidental Enter/Space never starts a P2P transfer blindly
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

  if (!request || typeof document === 'undefined') return null

  const { torrent, senderPubkey, senderDisplayHandle, senderNpub } = request
  const ext = getTorrentFileExtension(torrent.fileName)
  const isRisky = isRiskyExecutableExtension(torrent.fileName)
  const formattedHandle = senderDisplayHandle.startsWith('@')
    ? senderDisplayHandle
    : `@${senderDisplayHandle}`
  const shortHash = torrent.infoHash.slice(0, 12)

  const handleCopyNpub = async () => {
    try {
      await navigator.clipboard.writeText(senderNpub)
      setCopiedNpub(true)
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null
        setCopiedNpub(false)
      }, 1800)
    } catch {
      // Clipboard may be unavailable in restricted contexts
    }
  }

  return createPortal(
    <div
      className="ag-torrent-download-modal-backdrop"
      role="presentation"
      onClick={onCancel}
    >
      <div
        className={`ag-torrent-download-modal${isRisky ? ' is-risky' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ag-torrent-dl-title"
        aria-describedby="ag-torrent-dl-disclaimer"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="ag-torrent-download-modal-head">
          <span
            className={`ag-torrent-download-modal-badge${isRisky ? ' is-danger' : ''}`}
            aria-hidden="true"
          >
            {isRisky ? <FileWarning size={20} /> : <Download size={20} />}
          </span>
          <div className="ag-torrent-download-modal-title-wrap">
            <h2 id="ag-torrent-dl-title" className="ag-torrent-download-modal-title">
              Download P2P File?
            </h2>
            <p className="ag-torrent-download-modal-subtitle">
              Review sender &amp; security notice before connecting
            </p>
          </div>
          <button
            type="button"
            className="ag-torrent-download-modal-close"
            onClick={onCancel}
            aria-label="Cancel download"
            title="Cancel (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        {/* Sender Identity Row */}
        <div className="ag-torrent-download-modal-sender">
          <AvatarImg
            pubkey={senderPubkey}
            pictureUrl={avatarUrl}
            width={30}
            height={30}
            className="ag-torrent-download-modal-avatar"
          />
          <div className="ag-torrent-download-modal-sender-copy">
            <div className="ag-torrent-download-modal-sender-top">
              <span
                className="ag-torrent-download-modal-handle truncate"
                style={{ color: pubkeyToColor(senderPubkey) }}
              >
                {formattedHandle}
              </span>
              <span className="ag-badge ag-torrent-trusted-badge">
                <ShieldCheck size={10} />
                <span>Trusted Peer</span>
              </span>
            </div>
            <button
              type="button"
              className="ag-torrent-download-modal-npub mono"
              onClick={() => void handleCopyNpub()}
              title={`Copy full npub: ${senderNpub}`}
              aria-label={`Copy sender public key ${senderNpub}`}
            >
              <span className="truncate">{shortPubkey(senderNpub, 12, 6)}</span>
              {copiedNpub ? (
                <Check size={12} className="ag-torrent-copied-icon" />
              ) : (
                <Copy size={12} />
              )}
            </button>
          </div>
        </div>

        {/* File Preview Card */}
        <div className="ag-torrent-download-modal-file">
          <div className="ag-torrent-download-modal-file-top">
            <span className="ag-torrent-download-modal-file-icon" aria-hidden="true">
              {isRisky ? <FileWarning size={17} /> : <FileIcon size={17} />}
            </span>
            <div className="ag-torrent-download-modal-file-copy">
              <div className="ag-torrent-download-modal-name-row">
                <span className="ag-torrent-download-modal-filename truncate" title={torrent.fileName}>
                  {torrent.fileName}
                </span>
                {ext && (
                  <span
                    className={`ag-torrent-ext-pill mono${isRisky ? ' is-risky' : ''}`}
                  >
                    .{ext}
                  </span>
                )}
              </div>
              <div className="ag-torrent-download-modal-file-meta mono tabular">
                <span>{formatTorrentBytes(torrent.size)}</span>
                <span>·</span>
                <span className="truncate" title={torrent.mime}>
                  {torrent.mime || 'application/octet-stream'}
                </span>
                <span>·</span>
                <span title={`Info hash: ${torrent.infoHash}`}>#{shortHash}</span>
              </div>
            </div>
          </div>

          <div className="ag-torrent-download-modal-crypto-row">
            <span className="ag-torrent-crypto-pill">
              <Lock size={10} aria-hidden="true" />
              <span>E2EE AES-256-GCM · SHA-256 Verified</span>
            </span>
          </div>
        </div>

        {/* Extra Warning for Executable / Script / Archive Extensions */}
        {isRisky && (
          <div className="ag-torrent-download-modal-risk-banner" role="alert">
            <AlertTriangle size={16} className="ag-torrent-risk-icon" aria-hidden="true" />
            <p className="ag-torrent-risk-copy">
              <strong>Executable or archive file (.{ext})</strong>: Opening this file type can run
              programs or unpack hidden scripts on your device. Only download and open if you
              explicitly asked {formattedHandle} to send it.
            </p>
          </div>
        )}

        {/* Mandatory 3-Point Security Disclaimer */}
        <ul id="ag-torrent-dl-disclaimer" className="ag-torrent-download-modal-disclaimer">
          <li className="ag-torrent-download-modal-point">
            <span className="ag-torrent-point-icon" aria-hidden="true">
              <Wifi size={14} />
            </span>
            <span>
              <strong>Direct P2P IP Exposure:</strong> Connecting over WebRTC torrents reveals your
              IP address to the sender and any connected trusted swarm peers.
            </span>
          </li>
          <li className="ag-torrent-download-modal-point">
            <span className="ag-torrent-point-icon" aria-hidden="true">
              <ShieldAlert size={14} />
            </span>
            <span>
              <strong>No Antivirus / Unscanned File:</strong> End-to-end encryption means no server
              has scanned this file. Even files from trusted people can contain malware or harmful
              content if their device or key is compromised.
            </span>
          </li>
          <li className="ag-torrent-download-modal-point">
            <span className="ag-torrent-point-icon" aria-hidden="true">
              <Eye size={14} />
            </span>
            <span>
              <strong>Verify Before Opening:</strong> Confirm with the sender that they intended to
              send this exact file before opening or executing it.
            </span>
          </li>
        </ul>

        {/* Actions: Cancel default-focused */}
        <div className="ag-torrent-download-modal-actions">
          <button
            ref={cancelBtnRef}
            type="button"
            className="ag-torrent-dl-btn-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`ag-torrent-dl-btn-confirm${isRisky ? ' is-risky' : ''}`}
            onClick={onConfirm}
          >
            <Download size={14} aria-hidden="true" />
            <span>I Understand — Start P2P Download</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default TorrentDownloadModal
