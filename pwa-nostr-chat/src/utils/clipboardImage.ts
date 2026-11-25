const REDACTED_IMAGE_SELECTOR =
  '.is-blurred, .is-redacted, .is-hidden, .ag-cf-blurred, .ag-agora-media-blocked, .ag-agora-img-shield'

export interface CopyImageResult {
  ok: boolean
  error?: string
}

export type ClipboardImageSource = HTMLImageElement | string | (() => Promise<string>)

/**
 * True when the browser supports writing binary image items via the Async Clipboard API.
 */
export function canCopyImagesToClipboard(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function' &&
    typeof ClipboardItem !== 'undefined'
  )
}

/**
 * Checks that an <img> element is loaded, visible, and NOT safety-redacted or blurred.
 */
export function isCopyableImageElement(
  img: HTMLImageElement | null | undefined
): img is HTMLImageElement {
  if (!(img instanceof HTMLImageElement)) return false
  if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return false
  if (img.closest(REDACTED_IMAGE_SELECTOR)) return false
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    const style = window.getComputedStyle(img)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (Number.parseFloat(style.opacity || '1') <= 0) return false
    if (style.filter && style.filter.includes('blur(')) return false
  }
  return true
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob && blob.size > 0) {
          resolve(blob)
        } else {
          reject(new Error('Failed to encode image as PNG.'))
        }
      }, 'image/png')
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Canvas export blocked.'))
    }
  })
}

async function decodeViaHtmlImage(blob: Blob): Promise<Blob> {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    throw new Error('Image decoding is unavailable in this environment.')
  }
  const objectUrl = URL.createObjectURL(blob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Unable to decode image blob.'))
      el.src = objectUrl
    })
    const width = img.naturalWidth
    const height = img.naturalHeight
    if (width <= 0 || height <= 0) {
      throw new Error('Decoded image has empty dimensions.')
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('Unable to allocate 2D canvas context.')
    }
    ctx.drawImage(img, 0, 0, width, height)
    return await canvasToPngBlob(canvas)
  } finally {
    try {
      URL.revokeObjectURL(objectUrl)
    } catch {
      // Ignore revoke error
    }
  }
}

async function convertBlobToPng(blob: Blob): Promise<Blob> {
  if (blob.size <= 0) {
    throw new Error('Image payload is empty.')
  }
  if (blob.type === 'image/png') {
    return blob
  }

  if (typeof createImageBitmap === 'function' && typeof document !== 'undefined') {
    let bitmap: ImageBitmap | null = null
    try {
      bitmap = await createImageBitmap(blob)
      if (bitmap.width > 0 && bitmap.height > 0) {
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          throw new Error('Unable to allocate 2D canvas context.')
        }
        ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height)
        return await canvasToPngBlob(canvas)
      }
    } catch {
      // Fall through to HTMLImageElement decoder
    } finally {
      bitmap?.close()
    }
  }

  return await decodeViaHtmlImage(blob)
}

async function fetchUrlToPngBlob(url: string): Promise<Blob> {
  const cleanUrl = url.trim()
  if (!cleanUrl) {
    throw new Error('Missing image URL.')
  }
  const isRemoteHttp = /^https?:\/\//i.test(cleanUrl)
  const res = isRemoteHttp
    ? await fetch(cleanUrl, { mode: 'cors', credentials: 'omit' })
    : await fetch(cleanUrl)
  if (!res.ok) {
    throw new Error(`Failed to fetch image (${res.status}).`)
  }
  const blob = await res.blob()
  return await convertBlobToPng(blob)
}

async function renderHtmlImageToPngBlob(img: HTMLImageElement): Promise<Blob> {
  const src = (img.currentSrc || img.src || '').trim()

  if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0 && typeof document !== 'undefined') {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        throw new Error('Unable to allocate 2D canvas context.')
      }
      ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight)
      return await canvasToPngBlob(canvas)
    } catch {
      // Cross-origin tainted canvas (SecurityError) -> retry via CORS fetch below
    }
  }

  if (!src) {
    throw new Error('Image source is unavailable.')
  }
  return await fetchUrlToPngBlob(src)
}

async function resolveImageToPngBlob(source: ClipboardImageSource): Promise<Blob> {
  if (typeof source === 'string') {
    return await fetchUrlToPngBlob(source)
  }
  if (typeof source === 'function') {
    const resolvedUrl = await source()
    return await fetchUrlToPngBlob(resolvedUrl)
  }
  return await renderHtmlImageToPngBlob(source)
}

/**
 * Copies an image (DOM <img>, URL string, or async URL getter) to the system
 * clipboard as `image/png`. Calls `navigator.clipboard.write` synchronously
 * inside the user click gesture with a Promise-backed `ClipboardItem` for
 * Safari compatibility, with automatic resolved-Blob fallback for older browsers.
 */
export async function copyImageToClipboard(
  source: ClipboardImageSource
): Promise<CopyImageResult> {
  if (!canCopyImagesToClipboard()) {
    return {
      ok: false,
      error: 'Copying images to clipboard is not supported in this browser.',
    }
  }

  const pngBlobPromise = resolveImageToPngBlob(source)
  // Attach a no-op catch so a synchronous ClipboardItem throw cannot cause an unhandled rejection
  pngBlobPromise.catch(() => {})

  try {
    let item: ClipboardItem
    try {
      item = new ClipboardItem({ 'image/png': pngBlobPromise })
    } catch {
      const blob = await pngBlobPromise
      item = new ClipboardItem({ 'image/png': blob })
    }
    await navigator.clipboard.write([item])
    return { ok: true }
  } catch (err) {
    // Fallback for engines where ClipboardItem accepts a Promise at construction
    // time but rejects inside clipboard.write() until given a concrete Blob.
    try {
      const blob = await pngBlobPromise
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return { ok: true }
    } catch (retryErr) {
      const message =
        retryErr instanceof Error
          ? retryErr.message
          : err instanceof Error
            ? err.message
            : 'Unable to copy image to clipboard.'
      return { ok: false, error: message }
    }
  }
}
