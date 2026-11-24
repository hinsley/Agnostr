import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, Loader2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useBackHandler } from '../hooks/useBackNavigation.ts'

export interface IconCropModalProps {
  file: File | null
  label?: string
  busy?: boolean
  onCancel: () => void
  onConfirm: (croppedBlob: Blob) => void | Promise<void>
}

interface IconCropModalInnerProps {
  file: File
  label?: string
  busy: boolean
  onCancel: () => void
  onConfirm: (croppedBlob: Blob) => void | Promise<void>
}

interface LoadedMedia {
  url: string
  width: number
  height: number
}

const STAGE_PX = 240
const PREVIEW_PX = 44
const EXPORT_PX = 256
const MIN_ZOOM = 1
const MAX_ZOOM = 3
const ZOOM_STEP = 0.02

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val))
}

function getCoverScale(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 1
  return Math.max(STAGE_PX / width, STAGE_PX / height)
}

function clampOffsets(
  x: number,
  y: number,
  zoom: number,
  naturalW: number,
  naturalH: number,
): { x: number; y: number } {
  const coverScale = getCoverScale(naturalW, naturalH)
  const dispW = naturalW * coverScale * zoom
  const dispH = naturalH * coverScale * zoom
  const maxX = Math.max(0, (dispW - STAGE_PX) / 2)
  const maxY = Math.max(0, (dispH - STAGE_PX) / 2)
  return {
    x: clamp(x, -maxX, maxX),
    y: clamp(y, -maxY, maxY),
  }
}

function exportCanvasBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), mime, quality)
    } catch {
      resolve(null)
    }
  })
}

function IconCropModalInner({
  file,
  label,
  busy,
  onCancel,
  onConfirm,
}: IconCropModalInnerProps) {
  const [media, setMedia] = useState<LoadedMedia | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [exporting, setExporting] = useState(false)

  const imgElRef = useRef<HTMLImageElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const saveBtnRef = useRef<HTMLButtonElement | null>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)

  const isBusy = busy || exporting

  const handleSafeCancel = useCallback(() => {
    if (isBusy) return
    onCancel()
  }, [isBusy, onCancel])

  useBackHandler(true, handleSafeCancel)

  // Load selected File via object URL into an HTMLImageElement (auto-revoked on cleanup)
  useEffect(() => {
    let cancelled = false
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      if (cancelled) return
      const w = img.naturalWidth
      const h = img.naturalHeight
      if (w <= 0 || h <= 0) {
        setLoadError('Could not read image dimensions.')
        return
      }
      imgElRef.current = img
      setMedia({ url: objectUrl, width: w, height: h })
      setLoadError(null)
    }
    img.onerror = () => {
      if (cancelled) return
      setLoadError('Could not load that image. Choose a PNG, JPG, GIF, or WebP file.')
    }
    img.src = objectUrl

    return () => {
      cancelled = true
      imgElRef.current = null
      URL.revokeObjectURL(objectUrl)
    }
  }, [file])

  // Capture-phase Escape dismisses only the crop wizard
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      if (!isBusy) {
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [isBusy, onCancel])

  const applyZoom = useCallback(
    (nextRaw: number) => {
      if (!media) return
      const nextZoom = clamp(Math.round(nextRaw * 100) / 100, MIN_ZOOM, MAX_ZOOM)
      setZoom((prevZoom) => {
        if (nextZoom === prevZoom) return prevZoom
        const ratio = nextZoom / prevZoom
        setOffset((prev) =>
          clampOffsets(prev.x * ratio, prev.y * ratio, nextZoom, media.width, media.height),
        )
        return nextZoom
      })
    },
    [media],
  )

  // Non-passive mouse wheel zoom over the crop stage
  useEffect(() => {
    const stageEl = stageRef.current
    if (!stageEl || !media) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (isBusy) return
      const delta = -e.deltaY * 0.0018
      if (Math.abs(delta) < 0.001) return
      setZoom((prevZoom) => {
        const nextZoom = clamp(Math.round((prevZoom + delta) * 100) / 100, MIN_ZOOM, MAX_ZOOM)
        if (nextZoom === prevZoom) return prevZoom
        const ratio = nextZoom / prevZoom
        setOffset((prev) =>
          clampOffsets(prev.x * ratio, prev.y * ratio, nextZoom, media.width, media.height),
        )
        return nextZoom
      })
    }
    stageEl.addEventListener('wheel', onWheel, { passive: false })
    return () => stageEl.removeEventListener('wheel', onWheel)
  }, [media, isBusy])

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!media || isBusy) return
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: offset.x,
      originY: offset.y,
    }
    setDragging(true)
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId || !media) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    setOffset(
      clampOffsets(drag.originX + dx, drag.originY + dy, zoom, media.width, media.height),
    )
  }

  const handlePointerUpOrCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    dragRef.current = null
    setDragging(false)
  }

  const handleReset = () => {
    if (isBusy) return
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }

  const handleConfirm = async () => {
    const img = imgElRef.current
    if (!media || !img || isBusy) return
    setExporting(true)
    setLoadError(null)
    try {
      const coverScale = getCoverScale(media.width, media.height)
      const totalScale = coverScale * zoom
      const dispW = media.width * totalScale
      const dispH = media.height * totalScale
      const clamped = clampOffsets(offset.x, offset.y, zoom, media.width, media.height)

      const sw = Math.min(media.width, STAGE_PX / totalScale)
      const sh = Math.min(media.height, STAGE_PX / totalScale)
      const rawSx = (dispW / 2 - STAGE_PX / 2 - clamped.x) / totalScale
      const rawSy = (dispH / 2 - STAGE_PX / 2 - clamped.y) / totalScale
      const sx = clamp(rawSx, 0, Math.max(0, media.width - sw))
      const sy = clamp(rawSy, 0, Math.max(0, media.height - sh))

      const canvas = document.createElement('canvas')
      canvas.width = EXPORT_PX
      canvas.height = EXPORT_PX
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        throw new Error('Could not initialize image canvas.')
      }
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, EXPORT_PX, EXPORT_PX)

      let blob = await exportCanvasBlob(canvas, 'image/webp', 0.9)
      if (!blob || blob.size === 0) {
        blob = await exportCanvasBlob(canvas, 'image/png')
      }
      if (!blob || blob.size === 0) {
        throw new Error('Could not export cropped icon.')
      }

      await onConfirm(blob)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to crop icon.')
    } finally {
      setExporting(false)
    }
  }

  const coverScale = media ? getCoverScale(media.width, media.height) : 1
  const baseW = media ? media.width * coverScale : STAGE_PX
  const baseH = media ? media.height * coverScale : STAGE_PX
  const clamped = media
    ? clampOffsets(offset.x, offset.y, zoom, media.width, media.height)
    : { x: 0, y: 0 }
  const previewRatio = PREVIEW_PX / STAGE_PX

  return createPortal(
    <div
      className="ag-icon-crop-backdrop"
      role="presentation"
      data-icon-crop-modal="true"
      onClick={handleSafeCancel}
    >
      <div
        className="ag-icon-crop-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-icon-crop-title"
        aria-describedby="ag-icon-crop-desc"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ag-icon-crop-head">
          <div className="ag-icon-crop-title-wrap">
            <h2 id="ag-icon-crop-title" className="ag-icon-crop-title">
              {label ? `Crop Icon · ${label}` : 'Crop Group Icon'}
            </h2>
            <p id="ag-icon-crop-desc" className="ag-icon-crop-sub">
              Drag to reposition or zoom. Auto-fitted and exported at 256×256.
            </p>
          </div>
          <button
            type="button"
            className="ag-icon-btn-sm"
            disabled={isBusy}
            onClick={handleSafeCancel}
            aria-label="Cancel icon crop"
            title="Cancel (Esc)"
          >
            <X size={15} />
          </button>
        </div>

        <div className="ag-icon-crop-workspace">
          <div
            ref={stageRef}
            className={`ag-icon-crop-stage${dragging ? ' is-dragging' : ''}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUpOrCancel}
            onPointerCancel={handlePointerUpOrCancel}
            role="application"
            aria-label="Drag to reposition icon crop"
          >
            {media ? (
              <img
                src={media.url}
                alt=""
                draggable={false}
                className="ag-icon-crop-img"
                style={{
                  width: `${baseW}px`,
                  height: `${baseH}px`,
                  transform: `translate(-50%, -50%) translate(${clamped.x}px, ${clamped.y}px) scale(${zoom})`,
                }}
              />
            ) : loadError ? (
              <div className="ag-icon-crop-placeholder ag-tone-danger">{loadError}</div>
            ) : (
              <div className="ag-icon-crop-placeholder">
                <Loader2 size={20} className="ag-spin" aria-hidden="true" />
              </div>
            )}
            <div className="ag-icon-crop-guide" aria-hidden="true" />
          </div>

          <div className="ag-icon-crop-side">
            <div className="ag-icon-crop-preview-block">
              <span className="ag-icon-crop-preview-label">Rail preview</span>
              <div className="ag-icon-crop-preview-box" aria-hidden="true">
                {media && (
                  <img
                    src={media.url}
                    alt=""
                    draggable={false}
                    className="ag-icon-crop-img"
                    style={{
                      width: `${baseW * previewRatio}px`,
                      height: `${baseH * previewRatio}px`,
                      transform: `translate(-50%, -50%) translate(${clamped.x * previewRatio}px, ${clamped.y * previewRatio}px) scale(${zoom})`,
                    }}
                  />
                )}
              </div>
              {media && (
                <span className="ag-icon-crop-dims mono">
                  {media.width}×{media.height} → 256×256
                </span>
              )}
            </div>

            <div className="ag-icon-crop-controls">
              <div className="ag-icon-crop-zoom-row">
                <button
                  type="button"
                  className="ag-icon-btn-sm"
                  disabled={!media || isBusy || zoom <= MIN_ZOOM}
                  onClick={() => applyZoom(zoom - 0.15)}
                  aria-label="Zoom out"
                  title="Zoom out"
                >
                  <ZoomOut size={14} />
                </button>
                <input
                  type="range"
                  className="ag-icon-crop-slider"
                  min={MIN_ZOOM}
                  max={MAX_ZOOM}
                  step={ZOOM_STEP}
                  value={zoom}
                  disabled={!media || isBusy}
                  onChange={(e) => applyZoom(Number(e.target.value))}
                  aria-label="Zoom level"
                />
                <button
                  type="button"
                  className="ag-icon-btn-sm"
                  disabled={!media || isBusy || zoom >= MAX_ZOOM}
                  onClick={() => applyZoom(zoom + 0.15)}
                  aria-label="Zoom in"
                  title="Zoom in"
                >
                  <ZoomIn size={14} />
                </button>
              </div>

              <div className="ag-icon-crop-meta-row">
                <span className="ag-icon-crop-zoom-val mono">{Math.round(zoom * 100)}%</span>
                <button
                  type="button"
                  className="ag-btn ag-btn-ghost ag-btn-xs"
                  disabled={!media || isBusy || (zoom === 1 && offset.x === 0 && offset.y === 0)}
                  onClick={handleReset}
                >
                  <RotateCcw size={12} />
                  <span>Reset</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {loadError && media && (
          <p className="ag-field-hint ag-field-hint-danger" role="alert">
            {loadError}
          </p>
        )}

        <div className="ag-icon-crop-footer">
          <button
            type="button"
            className="ag-btn ag-btn-secondary"
            disabled={isBusy}
            onClick={handleSafeCancel}
          >
            Cancel
          </button>
          <button
            ref={saveBtnRef}
            type="button"
            className="ag-btn ag-btn-primary"
            disabled={!media || isBusy}
            onClick={() => void handleConfirm()}
          >
            {isBusy ? (
              <>
                <Loader2 size={14} className="ag-spin" aria-hidden="true" />
                <span>{busy ? 'Uploading…' : 'Processing…'}</span>
              </>
            ) : (
              <>
                <Check size={14} aria-hidden="true" />
                <span>Save Icon</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function IconCropModal({
  file,
  label,
  busy = false,
  onCancel,
  onConfirm,
}: IconCropModalProps) {
  if (!file) return null
  const fileKey = `${file.name}:${file.size}:${file.lastModified}`
  return (
    <IconCropModalInner
      key={fileKey}
      file={file}
      label={label}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}

export default IconCropModal
