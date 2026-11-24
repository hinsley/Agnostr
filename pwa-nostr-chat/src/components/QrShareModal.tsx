import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  Copy,
  Loader2,
  Lock,
  QrCode,
  Server,
  Share2,
  X,
} from 'lucide-react'
import { generateQrSvg } from '../lib/qrCode.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'

export interface QrShareTarget {
  kind: 'dm' | 'server'
  title: string
  subtitle?: string
  url: string
  codeLabel?: string
  codeValue?: string
}

export interface QrShareModalProps {
  target: QrShareTarget | null
  onClose: () => void
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function QrShareModalInner({
  target,
  onClose,
}: {
  target: QrShareTarget
  onClose: () => void
}) {
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null)
  const [qrError, setQrError] = useState<string | null>(null)
  const [copiedField, setCopiedField] = useState<'url' | 'code' | null>(null)

  const canNativeShare =
    typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  useBackHandler(true, onClose)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    generateQrSvg(target.url)
      .then((svg) => {
        if (!cancelled) {
          setSvgMarkup(svg)
          setQrError(null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQrError('Unable to generate QR code for this link.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [target.url])

  const handleCopy = useCallback(async (field: 'url' | 'code', value: string) => {
    const ok = await copyToClipboard(value)
    if (ok) {
      setCopiedField(field)
      window.setTimeout(() => {
        setCopiedField((prev) => (prev === field ? null : prev))
      }, 1800)
    }
  }, [])

  const handleNativeShare = useCallback(async () => {
    if (!canNativeShare) return
    try {
      await navigator.share({
        title: target.title,
        text: target.subtitle || target.title,
        url: target.url,
      })
    } catch {
      // User cancelled OS share sheet or share unavailable
    }
  }, [canNativeShare, target])

  return (
    <div
      className="ag-modal-backdrop ag-qr-modal-backdrop"
      onClick={onClose}
      role="presentation"
      data-no-swipe="true"
    >
      <div
        className="ag-qr-share-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-qr-share-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ag-qr-modal-head">
          <div className="ag-qr-modal-title-group">
            <span className="ag-qr-modal-badge-icon" aria-hidden="true">
              {target.kind === 'dm' ? <Lock size={16} /> : <Server size={16} />}
            </span>
            <div className="ag-qr-modal-title-copy">
              <h2 id="ag-qr-share-title" className="ag-qr-modal-title truncate">
                {target.title}
              </h2>
              {target.subtitle && (
                <p className="ag-qr-modal-sub truncate">{target.subtitle}</p>
              )}
            </div>
          </div>

          <button
            type="button"
            className="ag-sheet-close-btn ag-qr-close-btn"
            onClick={onClose}
            aria-label="Close QR code"
            title="Close (Esc)"
          >
            <X size={18} />
          </button>
        </header>

        <div className="ag-qr-share-body">
          {/* High-Contrast White Quiet-Zone QR Frame (Reliable Scanning in Dark & Light Modes) */}
          <div className="ag-qr-stage">
            <div className="ag-qr-card" aria-label={`QR code for ${target.title}`}>
              {qrError ? (
                <div className="ag-qr-error-box" role="alert">
                  <QrCode size={28} />
                  <span>{qrError}</span>
                </div>
              ) : svgMarkup ? (
                <div
                  className="ag-qr-svg-host"
                  // Generated offline by qrcode SVG builder inside src/lib/qrCode.ts
                  dangerouslySetInnerHTML={{ __html: svgMarkup }}
                />
              ) : (
                <div className="ag-qr-loading" role="status">
                  <Loader2 size={24} className="ag-spin" />
                </div>
              )}
            </div>
            <p className="ag-qr-scan-hint">
              {target.kind === 'dm'
                ? 'Scan with Agnostr or any camera app to open an encrypted DM.'
                : 'Scan with Agnostr or any camera app to join this group.'}
            </p>
          </div>

          {/* Copyable Link & Optional Compact Code */}
          <div className="ag-qr-link-stack">
            <div className="ag-qr-link-box">
              <span className="ag-qr-link-label">
                {target.kind === 'dm' ? 'DM Link' : 'Invite Link'}
              </span>
              <span className="ag-qr-link-val mono truncate" title={target.url}>
                {target.url}
              </span>
            </div>

            {target.codeValue && (
              <div className="ag-qr-code-row">
                <div className="ag-qr-code-meta">
                  <span className="ag-qr-link-label">
                    {target.codeLabel || 'Code'}
                  </span>
                  <span className="ag-qr-link-val mono truncate" title={target.codeValue}>
                    {target.codeValue}
                  </span>
                </div>
                <button
                  type="button"
                  className="ag-btn ag-btn-secondary ag-btn-xs"
                  onClick={() => void handleCopy('code', target.codeValue!)}
                >
                  {copiedField === 'code' ? <Check size={13} /> : <Copy size={13} />}
                  <span>{copiedField === 'code' ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            )}
          </div>

          {/* Primary Actions */}
          <div className="ag-qr-share-actions">
            <button
              type="button"
              className="ag-btn ag-btn-primary ag-qr-action-btn"
              onClick={() => void handleCopy('url', target.url)}
            >
              {copiedField === 'url' ? <Check size={16} /> : <Copy size={16} />}
              <span>{copiedField === 'url' ? 'Copied!' : 'Copy Link'}</span>
            </button>

            {canNativeShare && (
              <button
                type="button"
                className="ag-btn ag-btn-secondary ag-qr-action-btn"
                onClick={() => void handleNativeShare()}
              >
                <Share2 size={16} />
                <span>Share</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function QrShareModal({ target, onClose }: QrShareModalProps) {
  if (!target) return null
  if (typeof document === 'undefined') return null

  return createPortal(
    <QrShareModalInner key={target.url} target={target} onClose={onClose} />,
    document.body,
  )
}

export default QrShareModal
