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
  customRulesEnabled: boolean
  customInstructions: string
}

export type ContentFilterWorkerInMessage =
  | {
      type: 'preload'
      requestId: string
    }
  | {
      type: 'screen'
      requestId: string
      kind: 'image' | 'text'
      blob?: Blob
      text?: string
      caption?: string
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

// Stage 1: Default phone-safe NSFW + NSFL (gore/extreme violence) image classifier (22.6 MB)
const STAGE1_IMAGE_MODEL_URL = `https://huggingface.co/${CONTENT_FILTER_MODEL_ID}/resolve/main/onnx/image-safety-classifier-s.onnx`
const STAGE1_IMAGE_EXPECTED_BYTES = 23_701_765
const STAGE1_IMAGE_SIZE = 224
const THRESHOLD_IMAGE_NSFL = 0.5
const THRESHOLD_IMAGE_NSFW = 0.55

// Stage 2: Lazy MobileCLIP-S0 zero-shot visual custom rules (loaded ONLY when customRulesEnabled on images)
const MOBILECLIP_MODEL_ID = 'Xenova/mobileclip_s0'
const MOBILECLIP_VISION_FP16_URL = `https://huggingface.co/${MOBILECLIP_MODEL_ID}/resolve/main/onnx/vision_model_fp16.onnx`
const MOBILECLIP_VISION_FP32_URL = `https://huggingface.co/${MOBILECLIP_MODEL_ID}/resolve/main/onnx/vision_model.onnx`
const MOBILECLIP_TEXT_INT8_URL = `https://huggingface.co/${MOBILECLIP_MODEL_ID}/resolve/main/onnx/text_model_int8.onnx`
const MOBILECLIP_VISION_FP16_BYTES = 22_876_479
const MOBILECLIP_VISION_FP32_BYTES = 45_543_630
const MOBILECLIP_TEXT_INT8_BYTES = 42_799_230
const MOBILECLIP_IMAGE_SIZE = 256
const MOBILECLIP_EMBED_DIM = 512
const MOBILECLIP_LOGIT_SCALE = 100
const THRESHOLD_CLIP_CUSTOM_PROB = 0.72
const THRESHOLD_CLIP_CUSTOM_MIN_SIM = 0.21
const THRESHOLD_CLIP_CUSTOM_MARGIN = 0.03

const CLIP_NEUTRAL_BASELINES = [
  'a normal safe everyday photograph',
  'a casual portrait, selfie, or landscape photo',
  'an ordinary screenshot, meme, or graphic illustration',
  'an innocent picture of food, pets, nature, or daily life',
] as const

// Stage 3: Lazy DistilBERT 9-class text safety classifier (64.2 MB q8, loaded ONLY on text screening)
const COMMENT_MOD_MODEL_ID = 'onnx-community/Comment-Moderation-ONNX'
const COMMENT_MOD_ONNX_URL = `https://huggingface.co/${COMMENT_MOD_MODEL_ID}/resolve/main/onnx/model_int8.onnx`
const COMMENT_MOD_EXPECTED_BYTES = 67_353_541
// Exact id2label order verified from onnx-community/Comment-Moderation-ONNX/config.json:
// 0: S (Sexual), 1: H (Hate), 2: V (Violence), 3: HR (Harassment),
// 4: SH (Self-Harm), 5: S3 (Sexual/Minors), 6: H2 (Hate/Threat), 7: V2 (Violence/Graphic), 8: OK
const CM_IDX_S = 0
const CM_IDX_V = 2
const CM_IDX_SH = 4
const CM_IDX_S3 = 5
const CM_IDX_H2 = 6
const CM_IDX_V2 = 7
const CM_IDX_OK = 8

// Stage 3b: Lazy MobileBERT-MNLI zero-shot NLI for natural-language custom text rules (25.2 MB q8)
const MOBILEBERT_MNLI_MODEL_ID = 'Xenova/mobilebert-uncased-mnli'
const MOBILEBERT_MNLI_ONNX_URL = `https://huggingface.co/${MOBILEBERT_MNLI_MODEL_ID}/resolve/main/onnx/model_int8.onnx`
const MOBILEBERT_MNLI_EXPECTED_BYTES = 26_434_000
// Exact id2label order verified from Xenova/mobilebert-uncased-mnli/config.json:
// 0: ENTAILMENT, 1: NEUTRAL, 2: CONTRADICTION
const NLI_IDX_ENTAILMENT = 0
const NLI_IDX_CONTRADICTION = 2

const MAX_TEXT_CHARS = 1_500

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

interface TokenizerCallResult {
  input_ids: number[] | number[][]
  attention_mask?: number[] | number[][]
  token_type_ids?: number[] | number[][]
}

type TokenizerCallable = (
  text: string | string[],
  options?: Record<string, unknown>
) => TokenizerCallResult

interface Stage1ImageModel {
  device: ContentFilterRuntimeDevice
  ort: OrtModuleLike
  session: OrtSessionLike
}

interface Stage2ClipVisionModel {
  device: ContentFilterRuntimeDevice
  variant: 'fp16' | 'fp32'
  ort: OrtModuleLike
  session: OrtSessionLike
}

interface CachedClipRuleVectors {
  key: string
  ruleLabels: string[]
  ruleEmbeddings: Float32Array[]
  baselineEmbeddings: Float32Array[]
}

interface Stage3TextModModel {
  ort: OrtModuleLike
  tokenizer: TokenizerCallable
  session: OrtSessionLike
}

interface Stage3NliModel {
  ort: OrtModuleLike
  tokenizer: TokenizerCallable
  session: OrtSessionLike
}

type QueuedJob =
  | { type: 'preload'; requestId: string }
  | {
      type: 'screen'
      requestId: string
      kind: 'image' | 'text'
      blob?: Blob
      text?: string
      caption?: string
      rules: ContentFilterRulesPayload
    }
  | { type: 'clear-cache'; requestId: string }

let transformersPromise: Promise<typeof import('@huggingface/transformers')> | null = null
let ortPromise: Promise<OrtModuleLike> | null = null
let legacyEvictionStarted = false
let webGpuFailed = false

let stage1Model: Stage1ImageModel | null = null
let stage2VisionModel: Stage2ClipVisionModel | null = null
let stage2ClipTokenizer: TokenizerCallable | null = null
let cachedClipRules: CachedClipRuleVectors | null = null
let stage3TextModel: Stage3TextModModel | null = null
let stage3NliModel: Stage3NliModel | null = null

let lastActiveDevice: ContentFilterRuntimeDevice | null = null

const queue: QueuedJob[] = []
let processing = false

function postOut(msg: ContentFilterWorkerOutMessage): void {
  self.postMessage(msg)
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x)
    return 1 / (1 + z)
  }
  const z = Math.exp(x)
  return z / (1 + z)
}

function l2Normalize(vec: ArrayLike<number>): Float32Array {
  const out = new Float32Array(vec.length)
  let sumSq = 0
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]
    sumSq += v * v
  }
  const inv = 1 / (Math.sqrt(sumSq) || 1)
  for (let i = 0; i < vec.length; i++) {
    out[i] = vec[i] * inv
  }
  return out
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i]
  }
  return sum
}

/**
 * Silently evicts legacy 1.7 GB LiquidAI/d1-2B-ONNX entries from Cache Storage
 * so phones immediately reclaim cached storage without user intervention.
 */
async function evictLegacyD1CacheOnce(): Promise<void> {
  if (legacyEvictionStarted) return
  legacyEvictionStarted = true
  try {
    if (typeof caches === 'undefined') return
    const cache = await caches.open(CONTENT_FILTER_CACHE_NAME)
    const keys = await cache.keys()
    const deletions: Promise<boolean>[] = []
    for (const req of keys) {
      const u = req.url
      if (
        u.includes('LiquidAI/d1-2B-ONNX') ||
        u.includes('LiquidAI%2Fd1-2B-ONNX') ||
        u.includes('decoder_q4f16.onnx') ||
        u.includes('decoder_q4.onnx') ||
        u.includes('vision_encoder_q8.onnx')
      ) {
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

async function probeWebGpu(): Promise<{ available: boolean; hasFp16: boolean }> {
  try {
    const nav = navigator as Navigator & {
      gpu?: {
        requestAdapter?: () => Promise<{
          features?: { has?: (feature: string) => boolean }
        } | null>
      }
    }
    if (!nav.gpu || typeof nav.gpu.requestAdapter !== 'function') {
      return { available: false, hasFp16: false }
    }
    const adapter = await nav.gpu.requestAdapter()
    if (!adapter) return { available: false, hasFp16: false }
    const hasFp16 = Boolean(adapter.features?.has?.('shader-f16'))
    return { available: true, hasFp16 }
  } catch {
    return { available: false, hasFp16: false }
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

async function disposeAllModels(): Promise<void> {
  const s1 = stage1Model
  const s2 = stage2VisionModel
  const s3 = stage3TextModel
  const s3b = stage3NliModel

  stage1Model = null
  stage2VisionModel = null
  stage2ClipTokenizer = null
  cachedClipRules = null
  stage3TextModel = null
  stage3NliModel = null

  await Promise.all([
    releaseSessionSafe(s1?.session),
    releaseSessionSafe(s2?.session),
    releaseSessionSafe(s3?.session),
    releaseSessionSafe(s3b?.session),
  ])
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

async function fetchCachedBinary(
  url: string,
  expectedBytes: number,
  displayLabel: string,
  emitStatus: boolean
): Promise<Uint8Array> {
  let lastPercent = -1
  let lastTs = 0
  const report = (loaded: number, total: number) => {
    if (!emitStatus) return
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

  if (emitStatus) {
    postOut({
      type: 'status',
      status: 'downloading',
      progress: 0,
      file: displayLabel,
      runtimeDevice: lastActiveDevice,
    })
  }

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

// ---------------------------------------------------------------------------
// Stage 1: Default Phone-Safe Image Safety Classifier (22.6 MB SwiftFormer-S)
// ---------------------------------------------------------------------------

async function ensureStage1ImageModel(forceWasm = false): Promise<Stage1ImageModel> {
  void evictLegacyD1CacheOnce()

  if (stage1Model && (!forceWasm || stage1Model.device === 'wasm')) {
    return stage1Model
  }

  if (stage1Model) {
    await releaseSessionSafe(stage1Model.session)
    stage1Model = null
  }

  const ort = await getOrt()
  const bytes = await fetchCachedBinary(
    STAGE1_IMAGE_MODEL_URL,
    STAGE1_IMAGE_EXPECTED_BYTES,
    'image-safety-classifier-s.onnx',
    true
  )

  const gpu = await probeWebGpu()
  const tryWebGpu = !forceWasm && !webGpuFailed && gpu.available
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

  stage1Model = { device: chosenDevice, ort, session }
  lastActiveDevice = chosenDevice

  postOut({
    type: 'status',
    status: 'ready',
    progress: 100,
    file: null,
    runtimeDevice: chosenDevice,
  })

  return stage1Model
}

/**
 * Decodes an image Blob to RGB pixels resized to `targetSize x targetSize`.
 * When `centerCrop` is true, scales shortest edge to `targetSize` then center-crops.
 */
async function decodeImageToRgbNchw(
  blob: Blob,
  targetSize: number,
  rescaleToUnit: boolean,
  centerCrop: boolean
): Promise<Float32Array> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas image decoding is unavailable in this browser worker.')
  }

  const bitmap = await createImageBitmap(blob)
  let rgba: Uint8ClampedArray
  try {
    const canvas = new OffscreenCanvas(targetSize, targetSize)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      throw new Error('Unable to initialize 2D OffscreenCanvas context for image screening.')
    }
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    if (centerCrop && bitmap.width > 0 && bitmap.height > 0) {
      const side = Math.min(bitmap.width, bitmap.height)
      const sx = Math.floor((bitmap.width - side) / 2)
      const sy = Math.floor((bitmap.height - side) / 2)
      ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, targetSize, targetSize)
    } else {
      ctx.drawImage(bitmap, 0, 0, targetSize, targetSize)
    }
    rgba = ctx.getImageData(0, 0, targetSize, targetSize).data
  } finally {
    bitmap.close()
  }

  const plane = targetSize * targetSize
  const out = new Float32Array(3 * plane)
  const scale = rescaleToUnit ? 1 / 255 : 1
  for (let i = 0; i < plane; i++) {
    const base = i * 4
    out[i] = rgba[base] * scale
    out[plane + i] = rgba[base + 1] * scale
    out[2 * plane + i] = rgba[base + 2] * scale
  }
  return out
}

async function runStage1ImageClassification(
  blob: Blob
): Promise<{ pNsfl: number; pNsfw: number; pSfw: number; device: ContentFilterRuntimeDevice }> {
  let model = await ensureStage1ImageModel(false)
  // OwenElliott/image-safety-classifier-s expects RGB 0..255 float32 [1, 3, 224, 224]
  // (normalization and softmax are baked directly into the ONNX graph)
  const pixels = await decodeImageToRgbNchw(blob, STAGE1_IMAGE_SIZE, false, false)

  const invoke = async (m: Stage1ImageModel): Promise<Float32Array> => {
    const tensor = new m.ort.Tensor('float32', pixels, [
      1,
      3,
      STAGE1_IMAGE_SIZE,
      STAGE1_IMAGE_SIZE,
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
      model = await ensureStage1ImageModel(true)
      probs = await invoke(model)
    } else {
      throw err
    }
  }

  // Exact class order verified from config.json & README: ["NSFL", "NSFW", "SFW"]
  return {
    pNsfl: probs[0] ?? 0,
    pNsfw: probs[1] ?? 0,
    pSfw: probs[2] ?? 1,
    device: model.device,
  }
}

// ---------------------------------------------------------------------------
// Custom Rule Clause Parsing (shared by Stage 2 visual & Stage 3 text rules)
// ---------------------------------------------------------------------------

function parseCustomRuleClauses(rawInstructions: string): string[] {
  const cleaned = rawInstructions.trim().slice(0, 600)
  if (!cleaned) return []

  const rawParts = cleaned
    .split(/[\n,;]+/)
    .map((part) =>
      part
        .trim()
        .replace(/^(?:no|block|filter|hide|ban|avoid|disallow|disallow all|without)\s+/i, '')
        .replace(/[.!?]+$/, '')
        .trim()
    )
    .filter((part) => part.length >= 2)

  const deduped: string[] = []
  const seen = new Set<string>()
  for (const part of rawParts) {
    const key = part.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(part.slice(0, 80))
    }
    if (deduped.length >= 10) break
  }
  return deduped.length > 0 ? deduped : [cleaned.slice(0, 80)]
}

// ---------------------------------------------------------------------------
// Stage 2: Lazy MobileCLIP-S0 Visual Custom Rules (ONLY when customRulesEnabled)
// ---------------------------------------------------------------------------

async function ensureStage2ClipVision(forceWasm = false): Promise<Stage2ClipVisionModel> {
  if (stage2VisionModel && (!forceWasm || stage2VisionModel.device === 'wasm')) {
    return stage2VisionModel
  }

  if (stage2VisionModel) {
    await releaseSessionSafe(stage2VisionModel.session)
    stage2VisionModel = null
  }

  const ort = await getOrt()
  const gpu = await probeWebGpu()
  const tryWebGpuFp16 = !forceWasm && !webGpuFailed && gpu.available && gpu.hasFp16

  let session: OrtSessionLike
  let chosenDevice: ContentFilterRuntimeDevice
  let chosenVariant: 'fp16' | 'fp32'

  if (tryWebGpuFp16) {
    try {
      const bytes = await fetchCachedBinary(
        MOBILECLIP_VISION_FP16_URL,
        MOBILECLIP_VISION_FP16_BYTES,
        'mobileclip-vision-fp16.onnx',
        true
      )
      session = await ort.InferenceSession.create(bytes, createSessionOptions('webgpu'))
      chosenDevice = 'webgpu'
      chosenVariant = 'fp16'
    } catch {
      webGpuFailed = true
      const bytes = await fetchCachedBinary(
        MOBILECLIP_VISION_FP32_URL,
        MOBILECLIP_VISION_FP32_BYTES,
        'mobileclip-vision.onnx',
        true
      )
      session = await ort.InferenceSession.create(bytes, createSessionOptions('wasm'))
      chosenDevice = 'wasm'
      chosenVariant = 'fp32'
    }
  } else {
    // NEVER use broken vision_model_int8.onnx; use verified fp32 (43.4 MB)
    const bytes = await fetchCachedBinary(
      MOBILECLIP_VISION_FP32_URL,
      MOBILECLIP_VISION_FP32_BYTES,
      'mobileclip-vision.onnx',
      true
    )
    if (!forceWasm && !webGpuFailed && gpu.available) {
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
    chosenVariant = 'fp32'
  }

  stage2VisionModel = {
    device: chosenDevice,
    variant: chosenVariant,
    ort,
    session,
  }
  lastActiveDevice = chosenDevice

  postOut({
    type: 'status',
    status: 'ready',
    progress: 100,
    file: null,
    runtimeDevice: chosenDevice,
  })

  return stage2VisionModel
}

async function getClipCustomRuleVectors(
  rawInstructions: string
): Promise<CachedClipRuleVectors> {
  const clauses = parseCustomRuleClauses(rawInstructions)
  const key = clauses.map((c) => c.toLowerCase()).join('|')
  if (cachedClipRules && cachedClipRules.key === key) {
    return cachedClipRules
  }

  const mod = await getTransformers()
  const ort = await getOrt()

  if (!stage2ClipTokenizer) {
    stage2ClipTokenizer = (await mod.AutoTokenizer.from_pretrained(
      MOBILECLIP_MODEL_ID
    )) as unknown as TokenizerCallable
  }

  const rulePrompts = clauses.map((clause) => `a photo or image of ${clause}`)
  const allPrompts = [...rulePrompts, ...CLIP_NEUTRAL_BASELINES]

  const encoded = stage2ClipTokenizer(allPrompts, {
    padding: 'max_length',
    truncation: true,
    return_tensor: false,
  })
  const rows = encoded.input_ids as number[][]
  const seqLen = rows[0]?.length ?? 77
  const flatIds = new BigInt64Array(rows.length * seqLen)
  for (let b = 0; b < rows.length; b++) {
    const row = rows[b]
    for (let t = 0; t < seqLen; t++) {
      flatIds[b * seqLen + t] = BigInt(row[t] ?? 0)
    }
  }

  // Load 40.8 MB text encoder ONLY long enough to encode these prompts, then immediately release it!
  const textBytes = await fetchCachedBinary(
    MOBILECLIP_TEXT_INT8_URL,
    MOBILECLIP_TEXT_INT8_BYTES,
    'mobileclip-text-int8.onnx',
    true
  )
  const textSession = await ort.InferenceSession.create(
    textBytes,
    createSessionOptions('wasm')
  )

  let rawEmbeds: Float32Array
  const idsTensor = new ort.Tensor('int64', flatIds, [rows.length, seqLen])
  try {
    const out = await textSession.run({ input_ids: idsTensor })
    const embTensor = out.text_embeds ?? Object.values(out)[0]
    if (!embTensor) {
      throw new Error('MobileCLIP text encoder returned no embeddings.')
    }
    rawEmbeds = Float32Array.from(embTensor.data as Float32Array)
    embTensor.dispose?.()
  } finally {
    idsTensor.dispose?.()
    await releaseSessionSafe(textSession)
  }

  const ruleEmbeddings: Float32Array[] = []
  for (let i = 0; i < clauses.length; i++) {
    const slice = rawEmbeds.subarray(i * MOBILECLIP_EMBED_DIM, (i + 1) * MOBILECLIP_EMBED_DIM)
    ruleEmbeddings.push(l2Normalize(slice))
  }

  const baselineEmbeddings: Float32Array[] = []
  for (let i = 0; i < CLIP_NEUTRAL_BASELINES.length; i++) {
    const idx = clauses.length + i
    const slice = rawEmbeds.subarray(
      idx * MOBILECLIP_EMBED_DIM,
      (idx + 1) * MOBILECLIP_EMBED_DIM
    )
    baselineEmbeddings.push(l2Normalize(slice))
  }

  cachedClipRules = {
    key,
    ruleLabels: clauses,
    ruleEmbeddings,
    baselineEmbeddings,
  }

  postOut({
    type: 'status',
    status: 'ready',
    progress: 100,
    file: null,
    runtimeDevice: lastActiveDevice ?? 'wasm',
  })

  return cachedClipRules
}

async function runStage2ClipCustomImageCheck(
  blob: Blob,
  customInstructions: string
): Promise<{ flagged: boolean; score: number; matchedRule?: string }> {
  const vectors = await getClipCustomRuleVectors(customInstructions)
  let vision = await ensureStage2ClipVision(false)

  // MobileCLIP-S0 preprocessor: center crop 256x256, RGB rescaled 0..1 (do_normalize: false)
  const pixels = await decodeImageToRgbNchw(blob, MOBILECLIP_IMAGE_SIZE, true, true)

  const invokeVision = async (m: Stage2ClipVisionModel): Promise<Float32Array> => {
    const tensor = new m.ort.Tensor('float32', pixels, [
      1,
      3,
      MOBILECLIP_IMAGE_SIZE,
      MOBILECLIP_IMAGE_SIZE,
    ])
    try {
      const out = await m.session.run({ pixel_values: tensor })
      const embTensor = out.image_embeds ?? Object.values(out)[0]
      if (!embTensor) {
        throw new Error('MobileCLIP vision encoder returned no image embeddings.')
      }
      const vec = l2Normalize(embTensor.data as Float32Array)
      embTensor.dispose?.()
      return vec
    } finally {
      tensor.dispose?.()
    }
  }

  let imgVec: Float32Array
  try {
    imgVec = await invokeVision(vision)
  } catch (err) {
    if (vision.device === 'webgpu') {
      webGpuFailed = true
      vision = await ensureStage2ClipVision(true)
      imgVec = await invokeVision(vision)
    } else {
      throw err
    }
  }

  const baselineSims = vectors.baselineEmbeddings.map((b) => dotProduct(imgVec, b))
  const maxBaselineSim = Math.max(...baselineSims)

  let bestProb = 0
  let bestLabel: string | undefined
  let bestFlagged = false

  for (let i = 0; i < vectors.ruleEmbeddings.length; i++) {
    const ruleSim = dotProduct(imgVec, vectors.ruleEmbeddings[i])
    const allLogits = [
      ruleSim * MOBILECLIP_LOGIT_SCALE,
      ...baselineSims.map((s) => s * MOBILECLIP_LOGIT_SCALE),
    ]
    const maxLogit = Math.max(...allLogits)
    let sumExp = 0
    for (const l of allLogits) sumExp += Math.exp(l - maxLogit)
    const prob = Math.exp(allLogits[0] - maxLogit) / sumExp

    if (prob > bestProb) {
      bestProb = prob
      bestLabel = vectors.ruleLabels[i]
    }
    if (
      prob >= THRESHOLD_CLIP_CUSTOM_PROB &&
      ruleSim >= THRESHOLD_CLIP_CUSTOM_MIN_SIM &&
      ruleSim >= maxBaselineSim + THRESHOLD_CLIP_CUSTOM_MARGIN
    ) {
      bestFlagged = true
    }
  }

  return {
    flagged: bestFlagged,
    score: bestProb,
    matchedRule: bestFlagged ? bestLabel : undefined,
  }
}

// ---------------------------------------------------------------------------
// Stage 3: Lazy Text Moderation (Comment-Moderation-ONNX 64.2 MB + MobileBERT-MNLI 25.2 MB)
// ---------------------------------------------------------------------------

async function ensureStage3TextModModel(): Promise<Stage3TextModModel> {
  void evictLegacyD1CacheOnce()
  if (stage3TextModel) return stage3TextModel

  const mod = await getTransformers()
  const ort = await getOrt()

  const bytes = await fetchCachedBinary(
    COMMENT_MOD_ONNX_URL,
    COMMENT_MOD_EXPECTED_BYTES,
    'comment-moderation-int8.onnx',
    true
  )
  const tokenizer = (await mod.AutoTokenizer.from_pretrained(
    COMMENT_MOD_MODEL_ID
  )) as unknown as TokenizerCallable

  const session = await ort.InferenceSession.create(bytes, createSessionOptions('wasm'))
  stage3TextModel = { ort, tokenizer, session }
  if (!lastActiveDevice) lastActiveDevice = 'wasm'

  postOut({
    type: 'status',
    status: 'ready',
    progress: 100,
    file: null,
    runtimeDevice: lastActiveDevice,
  })

  return stage3TextModel
}

async function ensureStage3NliModel(): Promise<Stage3NliModel> {
  if (stage3NliModel) return stage3NliModel

  const mod = await getTransformers()
  const ort = await getOrt()

  const bytes = await fetchCachedBinary(
    MOBILEBERT_MNLI_ONNX_URL,
    MOBILEBERT_MNLI_EXPECTED_BYTES,
    'mobilebert-mnli-int8.onnx',
    true
  )
  const tokenizer = (await mod.AutoTokenizer.from_pretrained(
    MOBILEBERT_MNLI_MODEL_ID
  )) as unknown as TokenizerCallable

  const session = await ort.InferenceSession.create(bytes, createSessionOptions('wasm'))
  stage3NliModel = { ort, tokenizer, session }
  if (!lastActiveDevice) lastActiveDevice = 'wasm'

  postOut({
    type: 'status',
    status: 'ready',
    progress: 100,
    file: null,
    runtimeDevice: lastActiveDevice,
  })

  return stage3NliModel
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchCustomTextKeywords(text: string, clauses: readonly string[]): string | null {
  const lower = text.toLowerCase()
  for (const clause of clauses) {
    const c = clause.toLowerCase().trim()
    if (c.length < 3) continue
    // Direct word-boundary match for concise terms/phrases (<= 3 words)
    const words = c.split(/\s+/).filter(Boolean)
    if (words.length <= 3) {
      const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(c)}(?:$|[^\\p{L}\\p{N}])`, 'iu')
      if (re.test(lower)) {
        return clause
      }
    }
  }
  return null
}

async function runStage3CustomTextCheck(
  text: string,
  customInstructions: string
): Promise<{ flagged: boolean; score: number; matchedRule?: string }> {
  const clauses = parseCustomRuleClauses(customInstructions)
  if (clauses.length === 0) {
    return { flagged: false, score: 0 }
  }

  // 1. Zero-cost instant keyword/phrase match first
  const keywordHit = matchCustomTextKeywords(text, clauses)
  if (keywordHit) {
    return { flagged: true, score: 0.99, matchedRule: keywordHit }
  }

  // 2. Lazy MobileBERT-MNLI zero-shot NLI for natural-language rules
  const nli = await ensureStage3NliModel()
  let bestScore = 0
  let matchedRule: string | undefined
  let flagged = false

  for (const clause of clauses) {
    const hypothesis = `This message contains ${clause}.`
    const enc = nli.tokenizer(text, {
      text_pair: hypothesis,
      truncation: true,
      max_length: 256,
      return_tensor: false,
    })
    const idsArr = enc.input_ids as number[]
    const maskArr = (enc.attention_mask as number[] | undefined) ?? idsArr.map(() => 1)
    const ttiArr = (enc.token_type_ids as number[] | undefined) ?? idsArr.map(() => 0)

    const idsTensor = new nli.ort.Tensor(
      'int64',
      BigInt64Array.from(idsArr.map(BigInt)),
      [1, idsArr.length]
    )
    const maskTensor = new nli.ort.Tensor(
      'int64',
      BigInt64Array.from(maskArr.map(BigInt)),
      [1, maskArr.length]
    )
    const ttiTensor = new nli.ort.Tensor(
      'int64',
      BigInt64Array.from(ttiArr.map(BigInt)),
      [1, ttiArr.length]
    )

    let logits: Float32Array
    try {
      const out = await nli.session.run({
        input_ids: idsTensor,
        attention_mask: maskTensor,
        token_type_ids: ttiTensor,
      })
      const logitTensor = out.logits ?? Object.values(out)[0]
      logits = Float32Array.from(logitTensor.data as Float32Array)
      logitTensor.dispose?.()
    } finally {
      idsTensor.dispose?.()
      maskTensor.dispose?.()
      ttiTensor.dispose?.()
    }

    const eLogit = logits[NLI_IDX_ENTAILMENT] ?? -10
    const cLogit = logits[NLI_IDX_CONTRADICTION] ?? 0
    // Standard HF NLI zero-shot probability: entailment vs contradiction
    const maxEc = Math.max(eLogit, cLogit)
    const pEntail =
      Math.exp(eLogit - maxEc) / (Math.exp(eLogit - maxEc) + Math.exp(cLogit - maxEc))

    if (pEntail > bestScore) {
      bestScore = pEntail
    }
    if (pEntail >= 0.78 && eLogit > cLogit + 1.25) {
      flagged = true
      matchedRule = clause
      break
    }
  }

  return { flagged, score: bestScore, matchedRule }
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
  const categories: ContentFilterCategory[] = []
  const reasons: string[] = []
  const scores: Partial<Record<ContentFilterCategory, number>> = {}
  let device: ContentFilterRuntimeDevice | null = lastActiveDevice

  // Stage 1: Fast 22.6 MB NSFW + NSFL (gore/extreme violence) shield
  if (rules.filterIllegal || rules.filterNsfw) {
    const s1 = await runStage1ImageClassification(blob)
    device = s1.device
    if (rules.filterIllegal) {
      scores.illegal = Number(s1.pNsfl.toFixed(4))
      if (s1.pNsfl >= THRESHOLD_IMAGE_NSFL) {
        categories.push('illegal')
        reasons.push('NSFL / graphic violence')
      }
    }
    if (rules.filterNsfw) {
      scores.nsfw = Number(s1.pNsfw.toFixed(4))
      if (s1.pNsfw >= THRESHOLD_IMAGE_NSFW) {
        categories.push('nsfw')
        reasons.push('NSFW / explicit')
      }
    }
  }

  // Stage 2: Lazy MobileCLIP-S0 ONLY when user explicitly enabled custom rules
  const customText = rules.customInstructions.trim()
  if (rules.customRulesEnabled && customText.length > 0) {
    const s2 = await runStage2ClipCustomImageCheck(blob, customText)
    scores.custom = Number(s2.score.toFixed(4))
    if (s2.flagged) {
      categories.push('custom')
      reasons.push(s2.matchedRule ? `Custom rule (${s2.matchedRule})` : 'Custom filter rule')
    }
    if (stage2VisionModel) {
      device = stage2VisionModel.device
    }
  } else if (stage2VisionModel) {
    // Reclaim MobileCLIP vision RAM when user disables custom rules
    await releaseSessionSafe(stage2VisionModel.session)
    stage2VisionModel = null
  }

  const flagged = categories.length > 0
  return {
    safe: !flagged,
    flagged,
    categories,
    reason: reasons.length > 0 ? reasons.join(', ') : undefined,
    scores,
    runtimeDevice: device,
  }
}

async function screenTextJob(
  rawText: string,
  rules: ContentFilterRulesPayload
): Promise<{
  safe: boolean
  flagged: boolean
  categories: ContentFilterCategory[]
  reason?: string
  scores: Partial<Record<ContentFilterCategory, number>>
  runtimeDevice: ContentFilterRuntimeDevice | null
}> {
  const cleanText = rawText.trim().slice(0, MAX_TEXT_CHARS)
  if (!cleanText) {
    return {
      safe: true,
      flagged: false,
      categories: [],
      scores: {},
      runtimeDevice: lastActiveDevice,
    }
  }

  const categories: ContentFilterCategory[] = []
  const reasons: string[] = []
  const scores: Partial<Record<ContentFilterCategory, number>> = {}

  if (rules.filterIllegal || rules.filterNsfw) {
    const mod = await ensureStage3TextModModel()
    const enc = mod.tokenizer(cleanText, {
      truncation: true,
      max_length: 256,
      return_tensor: false,
    })
    const idsArr = enc.input_ids as number[]
    const maskArr = (enc.attention_mask as number[] | undefined) ?? idsArr.map(() => 1)

    const idsTensor = new mod.ort.Tensor(
      'int64',
      BigInt64Array.from(idsArr.map(BigInt)),
      [1, idsArr.length]
    )
    const maskTensor = new mod.ort.Tensor(
      'int64',
      BigInt64Array.from(maskArr.map(BigInt)),
      [1, maskArr.length]
    )

    let logits: Float32Array
    try {
      const out = await mod.session.run({
        input_ids: idsTensor,
        attention_mask: maskTensor,
      })
      const logitTensor = out.logits ?? Object.values(out)[0]
      logits = Float32Array.from(logitTensor.data as Float32Array)
      logitTensor.dispose?.()
    } finally {
      idsTensor.dispose?.()
      maskTensor.dispose?.()
    }

    const pS = sigmoid(logits[CM_IDX_S] ?? -10)
    const pV = sigmoid(logits[CM_IDX_V] ?? -10)
    const pSH = sigmoid(logits[CM_IDX_SH] ?? -10)
    const pS3 = sigmoid(logits[CM_IDX_S3] ?? -10)
    const pH2 = sigmoid(logits[CM_IDX_H2] ?? -10)
    const pV2 = sigmoid(logits[CM_IDX_V2] ?? -10)
    const pOK = sigmoid(logits[CM_IDX_OK] ?? 0)

    if (rules.filterIllegal) {
      const lowSafe = pOK < 0.2
      const veryLowSafe = pOK < 0.1
      const illegalReasons: string[] = []
      if (pS3 >= 0.4 || (pS3 >= 0.3 && lowSafe)) {
        illegalReasons.push('child safety')
      }
      if (pV2 >= 0.35 || (pV2 >= 0.22 && pV >= 0.6 && lowSafe)) {
        illegalReasons.push('graphic violence')
      }
      if (pSH >= 0.4 || (pSH >= 0.2 && veryLowSafe)) {
        illegalReasons.push('self-harm')
      }
      if (pH2 >= 0.5 || (pH2 >= 0.4 && lowSafe)) {
        illegalReasons.push('violent threat')
      }
      if ((pV >= 0.65 || (pV >= 0.62 && lowSafe)) && !illegalReasons.includes('graphic violence')) {
        illegalReasons.push('severe violence')
      }

      const violenceWeighted = pV * (1 - pOK)
      const illegalScore = Math.max(pS3, pV2, pSH, pH2, violenceWeighted)
      scores.illegal = Number(illegalScore.toFixed(4))

      if (illegalReasons.length > 0) {
        categories.push('illegal')
        reasons.push(`Illegal / severe harm (${illegalReasons.join(', ')})`)
      }
    }

    if (rules.filterNsfw) {
      scores.nsfw = Number(pS.toFixed(4))
      if (pS >= 0.55) {
        categories.push('nsfw')
        reasons.push('NSFW / sexual content')
      }
    }
  }

  const customText = rules.customInstructions.trim()
  if (rules.customRulesEnabled && customText.length > 0) {
    const customRes = await runStage3CustomTextCheck(cleanText, customText)
    scores.custom = Number(customRes.score.toFixed(4))
    if (customRes.flagged) {
      categories.push('custom')
      reasons.push(
        customRes.matchedRule ? `Custom rule (${customRes.matchedRule})` : 'Custom filter rule'
      )
    }
  } else if (stage3NliModel) {
    await releaseSessionSafe(stage3NliModel.session)
    stage3NliModel = null
  }

  const flagged = categories.length > 0
  return {
    safe: !flagged,
    flagged,
    categories,
    reason: reasons.length > 0 ? reasons.join(', ') : undefined,
    scores,
    runtimeDevice: lastActiveDevice ?? 'wasm',
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
          await disposeAllModels()
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
          const model = await ensureStage1ImageModel(false)
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

        if (job.kind === 'image') {
          if (!job.blob) {
            throw new Error('Missing image payload for screening.')
          }
          const res = await screenImageJob(job.blob, job.rules)
          postOut({
            type: 'result',
            requestId: job.requestId,
            ...res,
          })
          continue
        }

        const res = await screenTextJob(job.text ?? '', job.rules)
        postOut({
          type: 'result',
          requestId: job.requestId,
          ...res,
        })
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'On-device content screening failed.'
        if (job.type === 'preload' || !stage1Model) {
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

// Proactively evict any legacy 1.7 GB d1-2B weights on worker boot
void evictLegacyD1CacheOnce()

self.onmessage = (event: MessageEvent<ContentFilterWorkerInMessage>) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'dispose') {
    queue.length = 0
    void disposeAllModels()
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
      kind: msg.kind,
      blob: msg.blob,
      text: msg.text,
      caption: msg.caption,
      rules: msg.rules,
    })
    void processQueue()
  }
}
