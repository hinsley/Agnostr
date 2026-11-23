interface DetectedBarcode {
  rawValue?: string
}

interface BarcodeDetectorLike {
  detect: (source: ImageBitmapSource) => Promise<DetectedBarcode[]>
}

interface BarcodeDetectorConstructorLike {
  new (options?: { formats?: string[] }): BarcodeDetectorLike
  getSupportedFormats?: () => Promise<string[]>
}

const MAX_VIDEO_DECODE_DIM = 720
const MAX_IMAGE_DECODE_DIM = 1440

let barcodeDetectorPromise: Promise<BarcodeDetectorLike | null> | null = null

async function getNativeBarcodeDetector(): Promise<BarcodeDetectorLike | null> {
  if (barcodeDetectorPromise) return barcodeDetectorPromise
  barcodeDetectorPromise = (async () => {
    if (typeof window === 'undefined') return null
    const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructorLike })
      .BarcodeDetector
    if (typeof ctor !== 'function') return null
    try {
      if (typeof ctor.getSupportedFormats === 'function') {
        const formats = await ctor.getSupportedFormats()
        if (!formats.includes('qr_code')) return null
      }
      return new ctor({ formats: ['qr_code'] })
    } catch {
      return null
    }
  })()
  return barcodeDetectorPromise
}

/**
 * Generates crisp offline QR code SVG markup (`margin: 2`, `errorCorrectionLevel: 'M'`,
 * `#0B0C0F` modules on `#FFFFFF` quiet zone so scanners work cleanly in Dark & Light modes).
 * Lazily imports `qrcode` to keep the main JS bundle lean.
 */
export async function generateQrSvg(text: string): Promise<string> {
  const payload = text.trim()
  if (!payload) {
    throw new Error('Cannot generate a QR code for empty content.')
  }
  const mod = await import('qrcode')
  const toStringFn =
    typeof mod.toString === 'function'
      ? mod.toString
      : typeof mod.default?.toString === 'function'
        ? mod.default.toString
        : null
  if (!toStringFn) {
    throw new Error('QR SVG generator failed to initialize.')
  }
  const svg = await toStringFn(payload, {
    type: 'svg',
    margin: 2,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#0B0C0F',
      light: '#FFFFFF',
    },
  })
  return svg
}

/**
 * Decodes a QR code from an HTMLCanvasElement.
 * Tries native `BarcodeDetector` first when supported, automatically falling back to
 * lazily imported `jsqr` (works reliably on iOS Safari, Android Chrome, Firefox, and Desktop).
 */
export async function decodeQrFromCanvas(canvas: HTMLCanvasElement): Promise<string | null> {
  if (canvas.width <= 0 || canvas.height <= 0) return null

  // 1. Native BarcodeDetector fast path (Android Chrome / Chromium when available)
  const detector = await getNativeBarcodeDetector()
  if (detector) {
    try {
      const codes = await detector.detect(canvas)
      for (const code of codes) {
        const val = code.rawValue?.trim()
        if (val) return val
      }
    } catch {
      // Fall through to jsQR
    }
  }

  // 2. Universal cross-browser fallback via lazily imported jsQR
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  let imageData: ImageData
  try {
    imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  } catch {
    return null
  }

  const mod = await import('jsqr')
  const jsQR = mod.default
  if (typeof jsQR !== 'function') return null

  const decoded = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'attemptBoth',
  })
  const text = decoded?.data?.trim()
  return text || null
}

/**
 * Draws the current frame of a live `<video>` element onto a downscaled scratch canvas
 * (max 720px longest edge for snappy mobile frame scanning) and decodes any visible QR code.
 */
export async function decodeQrFromVideoFrame(
  video: HTMLVideoElement,
  scratchCanvas: HTMLCanvasElement
): Promise<string | null> {
  if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
    return null
  }
  const longest = Math.max(video.videoWidth, video.videoHeight)
  const scale = longest > MAX_VIDEO_DECODE_DIM ? MAX_VIDEO_DECODE_DIM / longest : 1
  const targetW = Math.max(1, Math.round(video.videoWidth * scale))
  const targetH = Math.max(1, Math.round(video.videoHeight * scale))

  if (scratchCanvas.width !== targetW || scratchCanvas.height !== targetH) {
    scratchCanvas.width = targetW
    scratchCanvas.height = targetH
  }
  const ctx = scratchCanvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, targetW, targetH)
  return await decodeQrFromCanvas(scratchCanvas)
}

function loadImageFromFile(file: File): Promise<{
  source: CanvasImageSource
  width: number
  height: number
  cleanup: () => void
}> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file)
      .then((bitmap) => ({
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close(),
      }))
      .catch(() => loadHtmlImageFromFile(file))
  }
  return loadHtmlImageFromFile(file)
}

function loadHtmlImageFromFile(file: File): Promise<{
  source: CanvasImageSource
  width: number
  height: number
  cleanup: () => void
}> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      resolve({
        source: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        cleanup: () => URL.revokeObjectURL(objectUrl),
      })
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Failed to load image file.'))
    }
    img.src = objectUrl
  })
}

/**
 * Decodes a QR code directly from a selected image or screenshot file.
 */
export async function decodeQrFromImageFile(file: File): Promise<string | null> {
  if (typeof document === 'undefined') return null
  let loaded: {
    source: CanvasImageSource
    width: number
    height: number
    cleanup: () => void
  }
  try {
    loaded = await loadImageFromFile(file)
  } catch {
    return null
  }

  try {
    if (loaded.width <= 0 || loaded.height <= 0) return null
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null

    const tryDecodeAtMaxDim = async (maxDim: number): Promise<string | null> => {
      const longest = Math.max(loaded.width, loaded.height)
      const scale = longest > maxDim ? maxDim / longest : 1
      const w = Math.max(1, Math.round(loaded.width * scale))
      const h = Math.max(1, Math.round(loaded.height * scale))
      canvas.width = w
      canvas.height = h
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(loaded.source, 0, 0, w, h)
      return await decodeQrFromCanvas(canvas)
    }

    const firstPass = await tryDecodeAtMaxDim(MAX_IMAGE_DECODE_DIM)
    if (firstPass) return firstPass

    // Retry at 720px for noisy/high-DPI camera photos where jsQR benefits from downsampling
    if (Math.max(loaded.width, loaded.height) > MAX_VIDEO_DECODE_DIM) {
      return await tryDecodeAtMaxDim(MAX_VIDEO_DECODE_DIM)
    }
    return null
  } finally {
    loaded.cleanup()
  }
}
