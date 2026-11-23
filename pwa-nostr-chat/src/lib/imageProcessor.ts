import type { PreparedImage } from '../types/protocol.ts'
import { isOffMainThreadWorkerSupported, processImageOffMainThread } from './offMainThread.ts'

export const MAX_RAW_IMAGE_BYTES = 20 * 1024 * 1024 // 20 MiB raw input cap
export const MAX_IMAGE_DIMENSION = 1920

const SUPPORTED_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i

export function isSupportedImageFile(file: File): boolean {
  if (!file) return false
  const mime = (file.type || '').toLowerCase()
  if (mime === 'image/svg+xml') return false // Disallow SVG scripts
  if (mime.startsWith('image/')) return true
  return SUPPORTED_EXT_RE.test(file.name || '')
}

export function revokeImagePreviewUrl(image: PreparedImage | null | undefined): void {
  if (!image?.previewUrl) return
  try {
    URL.revokeObjectURL(image.previewUrl)
  } catch {
    // Ignore revoke errors
  }
}

export function formatImageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface DecodedImageSurface {
  source: CanvasImageSource
  width: number
  height: number
  cleanup: () => void
}

async function decodeImageSource(file: File): Promise<DecodedImageSurface> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => {
          try {
            bitmap.close()
          } catch {
            // Ignore
          }
        },
      }
    } catch {
      // Fall back to HTMLImageElement decoding
    }
  }

  return await new Promise<DecodedImageSurface>((resolve, reject) => {
    const tempUrl = URL.createObjectURL(file)
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      const width = img.naturalWidth || img.width
      const height = img.naturalHeight || img.height
      if (width <= 0 || height <= 0) {
        URL.revokeObjectURL(tempUrl)
        reject(new Error('Image has invalid zero dimensions.'))
        return
      }
      resolve({
        source: img,
        width,
        height,
        cleanup: () => {
          URL.revokeObjectURL(tempUrl)
        },
      })
    }
    img.onerror = () => {
      URL.revokeObjectURL(tempUrl)
      reject(new Error('Unable to decode image file.'))
    }
    img.src = tempUrl
  })
}

function encodeCanvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), mime, quality)
    } catch {
      resolve(null)
    }
  })
}

/**
 * Decodes, auto-orients, scales down to <= 1920px max side, re-renders onto an offscreen
 * canvas (guaranteeing 100% EXIF / GPS / camera metadata stripping), and compresses to
 * WebP (quality 0.85, falling back to JPEG 0.86 on browsers lacking WebP canvas encode).
 *
 * Runs completely off the main thread in `mediaCrypto.worker.ts` (OffscreenCanvas +
 * transferable ArrayBuffer) when supported, falling back cleanly to DOM <canvas>.
 */
export async function prepareImageFile(file: File): Promise<PreparedImage> {
  if (!file || file.size <= 0) {
    throw new Error('Selected image file is empty.')
  }
  if (file.size > MAX_RAW_IMAGE_BYTES) {
    throw new Error('Image exceeds the 20 MB maximum file size limit.')
  }
  if (!isSupportedImageFile(file)) {
    throw new Error('Unsupported image format. Use PNG, JPEG, WebP, or GIF.')
  }

  // Primary path: 100% off-main-thread decode, scale, EXIF strip, and WebP/JPEG encode
  if (isOffMainThreadWorkerSupported()) {
    try {
      const workerResult = await processImageOffMainThread(file, MAX_IMAGE_DIMENSION)
      const blob = new Blob([workerResult.buffer], { type: workerResult.mime })
      const previewUrl = URL.createObjectURL(blob)
      return {
        blob,
        mime: workerResult.mime,
        size: workerResult.size,
        width: workerResult.width,
        height: workerResult.height,
        previewUrl,
        fileName: workerResult.fileName,
      }
    } catch {
      // Fall back cleanly to DOM <canvas> if OffscreenCanvas or worker decode is unavailable
    }
  }

  if (typeof document === 'undefined') {
    throw new Error('Canvas image processing requires a browser environment.')
  }

  const decoded = await decodeImageSource(file)
  try {
    const origW = decoded.width
    const origH = decoded.height
    if (origW <= 0 || origH <= 0) {
      throw new Error('Image dimensions could not be read.')
    }

    const longest = Math.max(origW, origH)
    const scale = longest > MAX_IMAGE_DIMENSION ? MAX_IMAGE_DIMENSION / longest : 1
    const width = Math.max(1, Math.round(origW * scale))
    const height = Math.max(1, Math.round(origH * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('Unable to initialize canvas 2D context for image processing.')
    }

    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(decoded.source, 0, 0, width, height)

    // Prefer WebP (0.85); if unsupported or browser silently fell back to PNG, use JPEG (0.86)
    let blob = await encodeCanvasToBlob(canvas, 'image/webp', 0.85)
    let mime = blob?.type?.toLowerCase() || ''

    if (!blob || mime !== 'image/webp') {
      // Fill solid dark background before JPEG encoding so transparent PNGs don't turn harsh black unexpectedly
      ctx.save()
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = '#090C0A'
      ctx.fillRect(0, 0, width, height)
      ctx.restore()
      const jpegBlob = await encodeCanvasToBlob(canvas, 'image/jpeg', 0.86)
      if (jpegBlob && jpegBlob.size > 0) {
        blob = jpegBlob
        mime = 'image/jpeg'
      }
    }

    if (!blob || blob.size === 0) {
      throw new Error('Failed to encode compressed image.')
    }

    const cleanMime = mime === 'image/webp' ? 'image/webp' : 'image/jpeg'
    const baseName = (file.name || 'image').replace(/\.[^.]+$/, '').slice(0, 48) || 'image'
    const ext = cleanMime === 'image/webp' ? 'webp' : 'jpg'
    const previewUrl = URL.createObjectURL(blob)

    return {
      blob,
      mime: cleanMime,
      size: blob.size,
      width,
      height,
      previewUrl,
      fileName: `${baseName}.${ext}`,
    }
  } finally {
    decoded.cleanup()
  }
}
