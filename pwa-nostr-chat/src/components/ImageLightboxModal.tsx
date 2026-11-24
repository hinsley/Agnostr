import { useEffect } from 'react'
import { Download, Lock, X } from 'lucide-react'
import type { ImageAttachment } from '../types/protocol.ts'
import { formatImageBytes } from '../lib/imageProcessor.ts'

export interface LightboxImagePayload {
  blobUrl: string
  image: ImageAttachment
  senderDisplayHandle: string
  caption?: string
}

export interface ImageLightboxModalProps {
  payload: LightboxImagePayload | null
  onClose: () => void
}

function extensionForMime(mime: string): string {
  const lower = (mime || '').toLowerCase()
  if (lower.includes('webp')) return 'webp'
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg'
  if (lower.includes('png')) return 'png'
  if (lower.includes('gif')) return 'gif'
  if (lower.includes('avif')) return 'avif'
  return 'webp'
}

function buildDownloadFilename(image: ImageAttachment): string {
  const hashPart = (image.sha256 || '').replace(/[^a-f0-9]/gi, '').slice(0, 10) || 'attachment'
  const ext = extensionForMime(image.mime)
  return `agnostr-image-${hashPart}.${ext}`
}

export function ImageLightboxModal({ payload, onClose }: ImageLightboxModalProps) {
  useEffect(() => {
    if (!payload) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [payload, onClose])

  if (!payload) return null

  const { blobUrl, image, senderDisplayHandle, caption } = payload
  const isE2ee = Boolean(image.encryption)
  const dimText = image.width > 0 && image.height > 0 ? `${image.width}×${image.height}` : ''
  const sizeText = image.size > 0 ? formatImageBytes(image.size) : ''
  const metaSummary = [dimText, sizeText].filter(Boolean).join(' · ')
  const cleanCaption = caption?.trim() || ''

  const handleDownload = () => {
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = buildDownloadFilename(image)
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return (
    <div
      className="ag-lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Image from ${senderDisplayHandle}`}
      onClick={onClose}
    >
      {/* Top Tactical Bar */}
      <div className="ag-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <div className="ag-lightbox-meta">
          <span className="ag-lightbox-handle truncate" title={senderDisplayHandle}>
            {senderDisplayHandle}
          </span>
          {metaSummary && <span className="ag-lightbox-dim mono">{metaSummary}</span>}
          {isE2ee && (
            <span className="ag-badge dm" title="End-to-end encrypted image (AES-256-GCM)">
              <Lock size={9} />
              <span>E2EE</span>
            </span>
          )}
        </div>

        <div className="ag-lightbox-actions">
          <button
            type="button"
            className="ag-lightbox-btn"
            onClick={handleDownload}
            title="Download image"
            aria-label="Download image"
          >
            <Download size={15} />
            <span className="ag-hide-xs">Download</span>
          </button>
          <button
            type="button"
            className="ag-lightbox-btn ag-lightbox-close"
            onClick={onClose}
            title="Close viewer (Esc)"
            aria-label="Close image viewer"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Full-Resolution Image Stage */}
      <div className="ag-lightbox-stage">
        <img
          src={blobUrl}
          alt={image.alt || cleanCaption || `Image from ${senderDisplayHandle}`}
          className="ag-lightbox-img"
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      {/* Optional Caption Footer */}
      {cleanCaption && (
        <div className="ag-lightbox-caption" onClick={(e) => e.stopPropagation()}>
          {cleanCaption}
        </div>
      )}
    </div>
  )
}

export default ImageLightboxModal
