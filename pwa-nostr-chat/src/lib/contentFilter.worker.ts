/// <reference lib="webworker" />

import {
  CONTENT_FILTER_CACHE_NAME,
  CONTENT_FILTER_MODEL_ID,
  type ContentFilterCategory,
  type ContentFilterModelStatus,
  type ContentFilterRuntimeDevice,
} from '../types/contentFilter.ts'

export { CONTENT_FILTER_CACHE_NAME }

export interface ContentFilterRulesPayload {
  filterNsfw: boolean
  filterIllegal: boolean
}

export type ContentFilterWorkerInMessage =
  | {
      type: 'preload'
      requestId: string
    }
  | {
      type: 'screen'
      requestId: string
      blob: Blob
      rules: ContentFilterRulesPayload
    }
  | {
      type: 'clear-cache'
      requestId: string
    }
  | {
      type: 'dispose'
    }

export type ContentFilterWorkerOutMessage =
  | {
      type: 'status'
      status: ContentFilterModelStatus
      progress?: number
      file?: string | null
      runtimeDevice?: ContentFilterRuntimeDevice | null
      error?: string
    }
  | {
      type: 'result'
      requestId: string
      safe: boolean
      flagged: boolean
      categories: ContentFilterCategory[]
      reason?: string
      scores: Partial<Record<ContentFilterCategory, number>>
      runtimeDevice: ContentFilterRuntimeDevice | null
    }
  | {
      type: 'cache-cleared'
      requestId: string
    }
  | {
      type: 'error'
      requestId: string
      error: string
    }

// Phone-safe NSFW + NSFL (gore/extreme violence) image safety classifier (22.6 MB SwiftFormer-S)
const IMAGE_MODEL_URL = `https://huggingface.co/${CONTENT_FILTER_MODEL_ID}/resolve/main/onnx/image-safety-classifier-s.onnx`
const IMAGE_MODEL_EXPECTED_BYTES = 23_701_765
const IMAGE_MODEL_SIZE = 224
const THRESHOLD_IMAGE_NSFL = 0.5
const THRESHOLD_IMAGE_NSFW = 0.55

interface OrtTensorLike {
  data: Float32Array | BigInt64Array | Int32Array | Uint8Array
  dims: readonly number[]
  dispose?: () => void
}

interface OrtSessionLike {
  run: (feeds: Record<string, OrtTensorLike>) => Promise<Record<string, OrtTensorLike>>
  release?: () => Promise<void>
}

interface OrtModuleLike {
  env: {
    logLevel?: string
    wasm: {
      numThreads?: number
      proxy?: boolean
      wasmPaths?: string | Record<string, string>
    }
    webgpu?: {
      powerPreference?: string
    }
  }
  Tensor: new (
    type: 'float32' | 'int64',
    data: Float32Array | BigInt64Array,
    dims: readonly number[]
  ) => OrtTensorLike
  InferenceSession: {
    create: (
      buffer: Uint8Array,
      options?: Record<string, unknown>
    ) => Promise<OrtSessionLike>
  }
}

interface LoadedImageModel {
  device: ContentFilterRuntimeDevice
  ort: OrtModuleLike
  session: OrtSessionLike
}

type QueuedJob =
  | { type: 'preload'; requestId: string }
  | {
      type: 'screen'
      requestId: string
      blob: Blob
      rules: ContentFilterRulesPayload
    }
  | { type: 'clear-cache'; requestId: string }

let transformersPromise: Promise<typeof import('@huggingface/transformers')> | null = null
let ortPromise: Promise<OrtModuleLike> | null = null
let legacyEvictionStarted = false
let webGpuFailed = false

let activeModel: LoadedImageModel | null = null
let lastActiveDevice: ContentFilterRuntimeDevice | null = null

const queue: QueuedJob[] = []
let processing = false

function postOut(msg: ContentFilterWorkerOutMessage): void {
  self.postMessage(msg)
}

function isLegacyCacheUrl(url: string): boolean {
  return (
    url.includes('LiquidAI/d1-2B-ONNX') ||
    url.includes('LiquidAI%2Fd1-2B-ONNX') ||
    url.includes('decoder_q4f16.onnx') ||
    url.includes('decoder_q4.onnx') ||
    url.includes('vision_encoder_q8.onnx') ||
    url.includes('mobileclip_s0') ||
    url.includes('Comment-Moderation-ONNX') ||
    url.includes('mobilebert-uncased-mnli')
  )
}

/**
 * Silently evicts legacy d1-2B, MobileCLIP, Comment-Moderation, and MobileBERT
 * entries from Cache Storage so phones immediately reclaim cached storage.
 */
async function evictLegacyCacheOnce(): Promise<void> {
  if (legacyEvictionStarted) return
  legacyEvictionStarted = true
  try {
    if (typeof caches === 'undefined') return
    const hasCache = await caches.has(CONTENT_FILTER_CACHE_NAME)
    if (!hasCache) return
    const cache = await caches.open(CONTENT_FILTER_CACHE_NAME)
    const keys = await cache.keys()
    const deletions: Promise<boolean>[] = []
    for (const req of keys) {
      if (isLegacyCacheUrl(req.url)) {
        deletions.push(cache.delete(req))
      }
    }
    if (deletions.length > 0) {
      await Promise.all(deletions)
    }
  } catch {
    // Ignore cache inspection failures on restricted browsers
  }
}

async function getTransformers(): Promise<typeof import('@huggingface/transformers')> {
  if (!transformersPromise) {
    transformersPromise = import('@huggingface/transformers')
  }
  const mod = await transformersPromise
  mod.env.allowLocalModels = false
  mod.env.useBrowserCache = true
  mod.env.useWasmCache = true
  mod.env.cacheKey = CONTENT_FILTER_CACHE_NAME
  const wasmEnv = mod.env.backends?.onnx?.wasm
  if (wasmEnv) {
    wasmEnv.proxy = false
    if (!self.crossOriginIsolated) {
      wasmEnv.numThreads = 1
    }
  }
  return mod
}

async function getOrt(): Promise<OrtModuleLike> {
  // Initialize transformers first so ORT wasmPaths are cleanly configured
  await getTransformers()
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web/webgpu') as unknown as Promise<OrtModuleLike>
  }
  const ort = await ortPromise
  if (ort.env) {
    ort.env.logLevel = 'error'
  }
  if (ort.env?.wasm) {
    ort.env.wasm.proxy = false
    if (!self.crossOriginIsolated) {
      ort.env.wasm.numThreads = 1
    }
  }
  if (ort.env?.webgpu) {
    ort.env.webgpu.powerPreference = 'low-power'
  }
  return ort
}

async function probeWebGpu(): Promise<boolean> {
  try {
    const nav = navigator as Navigator & {
      gpu?: { requestAdapter?: () => Promise<unknown | null> }
    }
    if (!nav.gpu || typeof nav.gpu.requestAdapter !== 'function') {
      return false
    }
    const adapter = await nav.gpu.requestAdapter()
    return Boolean(adapter)
  } catch {
    return false
  }
}

async function releaseSessionSafe(session: OrtSessionLike | null | undefined): Promise<void> {
  if (!session || typeof session.release !== 'function') return
  try {
    await session.release()
  } catch {
    // Ignore session release errors
  }
}

async function disposeActiveModel(): Promise<void> {
  const prev = activeModel
  activeModel = null
  await releaseSessionSafe(prev?.session)
}

async function readStreamWithProgress(
  response: Response,
  expectedBytes: number,
  onProgress: (loaded: number, total: number) => void
): Promise<Uint8Array> {
  const headerLen = Number(response.headers.get('content-length') || '0')
  const totalBytes = Number.isFinite(headerLen) && headerLen > 0 ? headerLen : expectedBytes

  if (!response.body) {
    const ab = await response.arrayBuffer()
    onProgress(ab.byteLength, Math.max(totalBytes, ab.byteLength))
    return new Uint8Array(ab)
  }

  const reader = response.body.getReader()
  if (totalBytes > 0) {
    const out = new Uint8Array(totalBytes)
    let offset = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      if (offset + value.byteLength > out.byteLength) {
        const chunks: Uint8Array[] = [out.subarray(0, offset), value]
        let extraOffset = offset + value.byteLength
        onProgress(extraOffset, extraOffset)
        while (true) {
          const next = await reader.read()
          if (next.done) break
          if (next.value && next.value.byteLength > 0) {
            chunks.push(next.value)
            extraOffset += next.value.byteLength
            onProgress(extraOffset, extraOffset)
          }
        }
        const merged = new Uint8Array(extraOffset)
        let pos = 0
        for (const chunk of chunks) {
          merged.set(chunk, pos)
          pos += chunk.byteLength
        }
        onProgress(extraOffset, extraOffset)
        return merged
      }
      out.set(value, offset)
      offset += value.byteLength
      onProgress(offset, totalBytes)
    }
    onProgress(offset, Math.max(offset, totalBytes))
    return offset === totalBytes ? out : out.subarray(0, offset)
  }

  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.byteLength === 0) continue
    chunks.push(value)
    received += value.byteLength
    onProgress(received, received)
  }
  const merged = new Uint8Array(received)
  let pos = 0
  for (const chunk of chunks) {
    merged.set(chunk, pos)
    pos += chunk.byteLength
  }
  return merged
}

async function fetchCachedModel(
  url: string,
  expectedBytes: number,
  displayLabel: string
): Promise<Uint8Array> {
  let lastPercent = -1
  let lastTs = 0
  const report = (loaded: number, total: number) => {
    const pct = total > 0 ? Math.min(99, Math.max(0, Math.round((loaded / total) * 100))) : 0
    const now = Date.now()
    if (pct !== lastPercent && (now - lastTs > 100 || pct >= 99)) {
      lastPercent = pct
      lastTs = now
      postOut({
        type: 'status',
        status: 'downloading',
        progress: pct,
        file: displayLabel,
        runtimeDevice: lastActiveDevice,
      })
    }
  }

  postOut({
    type: 'status',
    status: 'downloading',
    progress: 0,
    file: displayLabel,
    runtimeDevice: lastActiveDevice,
  })

  let cache: Cache | null = null
  try {
    if (typeof caches !== 'undefined') {
      cache = await caches.open(CONTENT_FILTER_CACHE_NAME)
      const cachedRes = await cache.match(url)
      if (cachedRes && cachedRes.ok) {
        return await readStreamWithProgress(cachedRes, expectedBytes, report)
      }
    }
  } catch {
    cache = null
  }

  const res = await fetch(url, { mode: 'cors', credentials: 'omit' })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading ${displayLabel}`)
  }

  const bytes = await readStreamWithProgress(res, expectedBytes, report)

  if (cache) {
    try {
      const storeBody =
        bytes.buffer instanceof ArrayBuffer
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : bytes
      await cache.put(
        url,
        new Response(storeBody as BodyInit, {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(bytes.byteLength),
          },
        })
      )
    } catch {
      // Ignore Cache Storage quota errors on constrained mobile devices
    }
  }

  return bytes
}

function createSessionOptions(device: ContentFilterRuntimeDevice): Record<string, unknown> {
  return {
    executionProviders: [device],
    graphOptimizationLevel: 'all',
  }
}

async function ensureImageModel(forceWasm = false): Promise<LoadedImageModel> {
  void evictLegacyCacheOnce()

  if (activeModel && (!forceWasm || activeModel.device === 'wasm')) {
    return activeModel
  }

  await disposeActiveModel()

  const ort = await getOrt()
  const bytes = await fetchCachedModel(
    IMAGE_MODEL_URL,
    IMAGE_MODEL_EXPECTED_BYTES,
    'image-safety-classifier-s.onnx'
  )

  const webGpuAvail = await probeWebGpu()
  const tryWebGpu = !forceWasm && !webGpuFailed && webGpuAvail
  let session: OrtSessionLike
  let chosenDevice: ContentFilterRuntimeDevice

  if (tryWebGpu) {
    try {
      session = await ort.InferenceSession.create(bytes, createSessionOptions('webgpu'))
      chosenDevice = 'webgpu'
    } catch {
      webGpuFailed = true
      session = await ort.InferenceSession.create(bytes, createSessionOptions('wasm'))
      chosenDevice = 'wasm'
    }
  } else {
    session = await ort.InferenceSession.create(bytes, createSessionOptions('wasm'))
    chosenDevice = 'wasm'
  }

  activeModel = { device: chosenDevice, ort, session }
  lastActiveDevice = chosenDevice

  postOut({
    type: 'status',
    status: 'ready',
    progress: 100,
    file: null,
    runtimeDevice: chosenDevice,
  })

  return activeModel
}

/**
 * Decodes an image Blob to RGB 0..255 float32 NCHW [1, 3, 224, 224].
 * Normalization & softmax are baked directly into image-safety-classifier-s.onnx.
 */
async function decodeImageToRgb224Nchw(blob: Blob): Promise<Float32Array> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas image decoding is unavailable in this browser worker.')
  }

  const bitmap = await createImageBitmap(blob)
  let rgba: Uint8ClampedArray
  try {
    const canvas = new OffscreenCanvas(IMAGE_MODEL_SIZE, IMAGE_MODEL_SIZE)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      throw new Error('Unable to initialize 2D OffscreenCanvas context for image screening.')
    }
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, IMAGE_MODEL_SIZE, IMAGE_MODEL_SIZE)
    rgba = ctx.getImageData(0, 0, IMAGE_MODEL_SIZE, IMAGE_MODEL_SIZE).data
  } finally {
    bitmap.close()
  }

  const plane = IMAGE_MODEL_SIZE * IMAGE_MODEL_SIZE
  const out = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    const base = i * 4
    out[i] = rgba[base]
    out[plane + i] = rgba[base + 1]
    out[2 * plane + i] = rgba[base + 2]
  }
  return out
}

async function screenImageJob(
  blob: Blob,
  rules: ContentFilterRulesPayload
): Promise<{
  safe: boolean
  flagged: boolean
  categories: ContentFilterCategory[]
  reason?: string
  scores: Partial<Record<ContentFilterCategory, number>>
  runtimeDevice: ContentFilterRuntimeDevice | null
}> {
  let model = await ensureImageModel(false)
  const pixels = await decodeImageToRgb224Nchw(blob)

  const invoke = async (m: LoadedImageModel): Promise<Float32Array> => {
    const tensor = new m.ort.Tensor('float32', pixels, [
      1,
      3,
      IMAGE_MODEL_SIZE,
      IMAGE_MODEL_SIZE,
    ])
    try {
      const out = await m.session.run({ image: tensor })
      const probTensor = out.probabilities ?? Object.values(out)[0]
      if (!probTensor) {
        throw new Error('Image safety classifier returned no probability tensor.')
      }
      const vals = Float32Array.from(probTensor.data as Float32Array)
      probTensor.dispose?.()
      return vals
    } finally {
      tensor.dispose?.()
    }
  }

  let probs: Float32Array
  try {
    probs = await invoke(model)
  } catch (err) {
    if (model.device === 'webgpu') {
      webGpuFailed = true
      model = await ensureImageModel(true)
      probs = await invoke(model)
    } else {
      throw err
    }
  }

  // Exact class order verified from config.json & README: ["NSFL", "NSFW", "SFW"]
  const pNsfl = probs[0] ?? 0
  const pNsfw = probs[1] ?? 0

  const categories: ContentFilterCategory[] = []
  const reasons: string[] = []
  const scores: Partial<Record<ContentFilterCategory, number>> = {}

  // NSFL / illegal imagery screening is permanently enforced and cannot be bypassed
  scores.illegal = Number(pNsfl.toFixed(4))
  if (pNsfl >= THRESHOLD_IMAGE_NSFL) {
    categories.push('illegal')
    reasons.push('NSFL / graphic violence')
  }

  if (rules.filterNsfw) {
    scores.nsfw = Number(pNsfw.toFixed(4))
    if (pNsfw >= THRESHOLD_IMAGE_NSFW) {
      categories.push('nsfw')
      reasons.push('NSFW / explicit')
    }
  }

  const flagged = categories.length > 0
  return {
    safe: !flagged,
    flagged,
    categories,
    reason: reasons.length > 0 ? reasons.join(', ') : undefined,
    scores,
    runtimeDevice: model.device,
  }
}

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true
  try {
    while (queue.length > 0) {
      const job = queue.shift()
      if (!job) continue

      try {
        if (job.type === 'clear-cache') {
          await disposeActiveModel()
          try {
            if (typeof caches !== 'undefined') {
              await caches.delete(CONTENT_FILTER_CACHE_NAME)
            }
          } catch {
            // Ignore cache delete failure
          }
          lastActiveDevice = null
          postOut({
            type: 'status',
            status: 'idle',
            progress: 0,
            file: null,
            runtimeDevice: null,
          })
          postOut({ type: 'cache-cleared', requestId: job.requestId })
          continue
        }

        if (job.type === 'preload') {
          const model = await ensureImageModel(false)
          postOut({
            type: 'result',
            requestId: job.requestId,
            safe: true,
            flagged: false,
            categories: [],
            scores: {},
            runtimeDevice: model.device,
          })
          continue
        }

        const res = await screenImageJob(job.blob, job.rules)
        postOut({
          type: 'result',
          requestId: job.requestId,
          ...res,
        })
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'On-device image safety screening failed.'
        if (job.type === 'preload' || !activeModel) {
          postOut({
            type: 'status',
            status: 'error',
            error: message,
          })
        }
        postOut({
          type: 'error',
          requestId: job.requestId,
          error: message,
        })
      }
    }
  } finally {
    processing = false
  }
}

// Proactively evict any legacy model weights on worker boot
void evictLegacyCacheOnce()

self.onmessage = (event: MessageEvent<ContentFilterWorkerInMessage>) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'dispose') {
    queue.length = 0
    void disposeActiveModel()
    return
  }

  if (msg.type === 'clear-cache') {
    queue.length = 0
    queue.push({ type: 'clear-cache', requestId: msg.requestId })
    void processQueue()
    return
  }

  if (msg.type === 'preload') {
    queue.push({ type: 'preload', requestId: msg.requestId })
    void processQueue()
    return
  }

  if (msg.type === 'screen') {
    queue.push({
      type: 'screen',
      requestId: msg.requestId,
      blob: msg.blob,
      rules: msg.rules,
    })
    void processQueue()
  }
}
