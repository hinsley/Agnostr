import { useCallback, useEffect, useRef, useState } from 'react'
import type { TouchEvent as ReactTouchEvent } from 'react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Image as ImageIcon,
  Lock,
  X,
} from 'lucide-react'
import type { ImageAttachment } from '../types/protocol.ts'
import { formatImageBytes } from '../lib/imageProcessor.ts'
import { copyImageToClipboard } from '../utils/clipboardImage.ts'
import { useContextMenu } from './ContextMenu.tsx'

export interface LightboxGalleryItem {
  blobUrl: string
  image: ImageAttachment
  caption?: string
}

export interface LightboxImagePayload {
  blobUrl: string
  image: ImageAttachment
  senderDisplayHandle: string
  caption?: string
  gallery?: LightboxGalleryItem[]
  initialIndex?: number
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
  const { openContextMenu } = useContextMenu()
  const imgRef = useRef<HTMLImageElement | null>(null)
  const copyTimerRef = useRef<number | null>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const [copiedForUrl, setCopiedForUrl] = useState<string | null>(null)
  const [indexState, setIndexState] = useState<{
    payload: LightboxImagePayload | null
    index: number
  }>({ payload: null, index: 0 })

  const galleryItems: LightboxGalleryItem[] = payload
    ? payload.gallery && payload.gallery.length > 0
      ? payload.gallery
      : [{ blobUrl: payload.blobUrl, image: payload.image, caption: payload.caption }]
    : []

  const totalCount = galleryItems.length
  const defaultIndex = payload
    ? Math.min(Math.max(0, payload.initialIndex ?? 0), Math.max(0, totalCount - 1))
    : 0
  const activeIndex =
    payload && indexState.payload === payload
      ? Math.min(Math.max(0, indexState.index), Math.max(0, totalCount - 1))
      : defaultIndex

  const stepGallery = useCallback(
    (delta: number) => {
      if (!payload || totalCount <= 1) return
      setIndexState((prev) => {
        const base =
          prev.payload === payload
            ? Math.min(Math.max(0, prev.index), totalCount - 1)
            : defaultIndex
        const next = (base + delta + totalCount) % totalCount
        return { payload, index: next }
      })
    },
    [payload, totalCount, defaultIndex]
  )

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!payload) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        onClose()
      } else if (totalCount > 1 && e.key === 'ArrowLeft') {
        e.preventDefault()
        e.stopPropagation()
        stepGallery(-1)
      } else if (totalCount > 1 && e.key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        stepGallery(1)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [payload, onClose, totalCount, stepGallery])

  if (!payload || galleryItems.length === 0) return null

  const currentItem = galleryItems[activeIndex] ?? galleryItems[0]
  const blobUrl = currentItem.blobUrl
  const activeImage = currentItem.image
  const senderDisplayHandle = payload.senderDisplayHandle
  const cleanCaption = (currentItem.caption ?? payload.caption ?? '').trim()
  const cleanAlt = (activeImage.alt ?? '').trim()
  const showAltStrip =
    cleanAlt.length > 0 && cleanAlt.toLowerCase() !== cleanCaption.toLowerCase()

  const isCopied = copiedForUrl === blobUrl
  const isE2ee = Boolean(activeImage.encryption)
  const dimText =
    activeImage.width > 0 && activeImage.height > 0
      ? `${activeImage.width}×${activeImage.height}`
      : ''
  const sizeText = activeImage.size > 0 ? formatImageBytes(activeImage.size) : ''
  const metaSummary = [dimText, sizeText].filter(Boolean).join(' · ')

  const handleCopyImage = () => {
    const source = imgRef.current ?? blobUrl
    void copyImageToClipboard(source).then((res) => {
      if (!res.ok) return
      setCopiedForUrl(blobUrl)
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedForUrl(null)
        copyTimerRef.current = null
      }, 2000)
    })
  }

  const handleDownload = () => {
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = buildDownloadFilename(activeImage)
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const handleTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (totalCount <= 1 || e.touches.length !== 1) return
    const t = e.touches[0]
    touchStartRef.current = { x: t.clientX, y: t.clientY }
  }

  const handleTouchEnd = (e: ReactTouchEvent<HTMLDivElement>) => {
    const start = touchStartRef.current
    touchStartRef.current = null
    if (!start || totalCount <= 1 || e.changedTouches.length !== 1) return
    const t = e.changedTouches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      stepGallery(dx < 0 ? 1 : -1)
    }
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
          {totalCount > 1 && (
            <span className="ag-lightbox-counter mono" aria-live="polite">
              {activeIndex + 1} / {totalCount}
            </span>
          )}
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
            onClick={handleCopyImage}
            title={isCopied ? 'Image copied' : 'Copy image'}
            aria-label={isCopied ? 'Image copied' : 'Copy image'}
          >
            {isCopied ? <Check size={15} /> : <Copy size={15} />}
            <span className="ag-hide-xs">{isCopied ? 'Copied' : 'Copy'}</span>
          </button>
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
      <div
        className="ag-lightbox-stage"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {totalCount > 1 && (
          <button
            type="button"
            className="ag-lightbox-nav prev"
            onClick={(e) => {
              e.stopPropagation()
              stepGallery(-1)
            }}
            title="Previous image (Left Arrow)"
            aria-label="Previous image"
          >
            <ChevronLeft size={22} />
          </button>
        )}

        <img
          ref={imgRef}
          src={blobUrl}
          alt={cleanAlt || cleanCaption || `Image from ${senderDisplayHandle}`}
          className="ag-lightbox-img"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            openContextMenu(e, {
              items: [
                {
                  id: 'lightbox-copy-image',
                  label: 'Copy Image',
                  icon: <ImageIcon size={14} />,
                  onSelect: handleCopyImage,
                },
                {
                  id: 'lightbox-download-image',
                  label: 'Download Image',
                  icon: <Download size={14} />,
                  onSelect: handleDownload,
                },
              ],
            })
          }}
        />

        {totalCount > 1 && (
          <button
            type="button"
            className="ag-lightbox-nav next"
            onClick={(e) => {
              e.stopPropagation()
              stepGallery(1)
            }}
            title="Next image (Right Arrow)"
            aria-label="Next image"
          >
            <ChevronRight size={22} />
          </button>
        )}
      </div>

      {/* Optional Alt-Text & Caption Footer */}
      {(showAltStrip || cleanCaption) && (
        <div className="ag-lightbox-footer" onClick={(e) => e.stopPropagation()}>
          {showAltStrip && (
            <div className="ag-lightbox-alt">
              <span className="ag-lightbox-alt-badge">ALT</span>
              <span>{cleanAlt}</span>
            </div>
          )}
          {cleanCaption && <div className="ag-lightbox-caption">{cleanCaption}</div>}
        </div>
      )}
    </div>
  )
}

export default ImageLightboxModal
