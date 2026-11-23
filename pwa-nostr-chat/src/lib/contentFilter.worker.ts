/// <reference lib="webworker" />

import {
  CONTENT_FILTER_MODEL_ID,
  type ContentFilterCategory,
  type ContentFilterModelStatus,
  type ContentFilterRuntimeDevice,
} from '../types/contentFilter.ts'

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

const HF_BASE_URL = `https://huggingface.co/${CONTENT_FILTER_MODEL_ID}/resolve/main`
export const CONTENT_FILTER_CACHE_NAME = 'content-filter-cache'

// Exact LiquidAI/d1-2B-ONNX constants verified from config.json, lfm3.py, calibration.json
const CALIBRATION_TEMP = 1.337398453966105
const IM_START = '<|im_start|>'
const IM_END = '<|im_end|>'
const VISION_START = '<|vision_start|>'
const IMAGE_TOKEN = '<|image|>'
const VISION_END = '<|vision_end|>'
const ASSISTANT_LEAD = '<think></think>'
const ZERO_WIDTH_BREAK = '\u200b'

const PATCH_SIZE = 16
const MERGE_SIZE = 2
const TEMPORAL_PATCH_SIZE = 2
const RESIZE_FACTOR = PATCH_SIZE * MERGE_SIZE // 32
const MIN_PIXELS = 65_536 // 256x256 -> 64 visual tokens
const MAX_PIXELS = 262_144 // 512x512 -> 256 visual tokens (fast + crisp in browser)
const MAX_TEXT_CHARS = 2_000
const HIDDEN_SIZE = 2048

const THRESHOLD_ILLEGAL = 0.5
const THRESHOLD_NSFW = 0.55
const THRESHOLD_CUSTOM = 0.55

const YES_FORMS = ['yes', 'Yes', 'YES']
const NO_FORMS = ['no', 'No', 'NO']

const SPECIAL_TOKEN_RE = /<\|[^|\s]{1,32}\|>|<\/?think>/g

interface ModerationQuestion {
  category: ContentFilterCategory
  label: string
  threshold: number
  instructions: string
  yesCriteria: string
  noCriteria: string
}

interface TokenizerLike {
  bos_token?: string | null
  encode: (text: string, options?: { add_special_tokens?: boolean }) => number[]
}

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

interface LoadedModelBundle {
  device: ContentFilterRuntimeDevice
  decoderVariant: 'q4f16' | 'q4'
  ort: OrtModuleLike
  tokenizer: TokenizerLike
  bosToken: string
  yesTokenIds: number[]
  noTokenIds: number[]
  visionSession: OrtSessionLike
  decoderSession: OrtSessionLike
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
let activeBundle: LoadedModelBundle | null = null
let webGpuFailed = false

const queue: QueuedJob[] = []
let processing = false

function postOut(msg: ContentFilterWorkerOutMessage): void {
  self.postMessage(msg)
}

function escapeSpecialTokens(raw: string): string {
  // Mirrors prompt.py `plain()`: inserts U+200B after '<' so untrusted user text
  // can never forge <|im_end|>, <|image|>, or <think> tokens.
  let out = raw
  for (let pass = 0; pass < 3; pass++) {
    const next = out.replace(SPECIAL_TOKEN_RE, (m) => `${m[0]}${ZERO_WIDTH_BREAK}${m.slice(1)}`)
    if (next === out) break
    out = next
  }
  return out
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
  // Load transformers first so its ORT wasmPaths & WebGPU defaults are initialized
  await getTransformers()
  if (!ortPromise) {
    // LiquidAI/d1-2B-ONNX requires onnxruntime-web/webgpu in browser environments
    ortPromise = import('onnxruntime-web/webgpu') as unknown as Promise<OrtModuleLike>
  }
  const ort = await ortPromise
  if (ort.env?.wasm) {
    ort.env.wasm.proxy = false
    if (!self.crossOriginIsolated) {
      ort.env.wasm.numThreads = 1
    }
  }
  if (ort.env?.webgpu) {
    ort.env.webgpu.powerPreference = 'high-performance'
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

async function disposeBundle(): Promise<void> {
  const prev = activeBundle
  activeBundle = null
  if (!prev) return
  try {
    await prev.visionSession.release?.()
  } catch {
    // Ignore session release error
  }
  try {
    await prev.decoderSession.release?.()
  } catch {
    // Ignore session release error
  }
}

function allocateLargeBuffer(byteLength: number): ArrayBuffer {
  try {
    return new ArrayBuffer(byteLength)
  } catch (err) {
    if (err instanceof RangeError) {
      const pages = Math.ceil(byteLength / 65_536)
      return new WebAssembly.Memory({ initial: pages, maximum: pages }).buffer
    }
    throw err
  }
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
    const buffer = allocateLargeBuffer(totalBytes)
    const out = new Uint8Array(buffer)
    let offset = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      if (offset + value.byteLength > out.byteLength) {
        // Fallback if server sent more bytes than Content-Length
        const grown = new Uint8Array(allocateLargeBuffer(offset + value.byteLength))
        grown.set(out.subarray(0, offset), 0)
        grown.set(value, offset)
        let extraOffset = offset + value.byteLength
        const extras: Uint8Array[] = [grown]
        while (true) {
          const next = await reader.read()
          if (next.done) break
          if (next.value && next.value.byteLength > 0) {
            extras.push(next.value)
            extraOffset += next.value.byteLength
            onProgress(extraOffset, extraOffset)
          }
        }
        const merged = new Uint8Array(allocateLargeBuffer(extraOffset))
        let pos = 0
        for (const chunk of extras) {
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
  const merged = new Uint8Array(allocateLargeBuffer(received))
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
  onProgress: (loaded: number, total: number) => void
): Promise<Uint8Array> {
  let cache: Cache | null = null
  try {
    if (typeof caches !== 'undefined') {
      cache = await caches.open(CONTENT_FILTER_CACHE_NAME)
      const cachedRes = await cache.match(url)
      if (cachedRes && cachedRes.ok) {
        return await readStreamWithProgress(cachedRes, expectedBytes, onProgress)
      }
    }
  } catch {
    cache = null
  }

  const res = await fetch(url, { mode: 'cors', credentials: 'omit' })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading ${url.split('/').pop() ?? 'model file'}`)
  }

  const bytes = await readStreamWithProgress(res, expectedBytes, onProgress)

  if (cache) {
    try {
      const storeBody = bytes.buffer instanceof ArrayBuffer
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

function resolveSingleTokenIds(tokenizer: TokenizerLike, forms: readonly string[]): number[] {
  const ids: number[] = []
  const seen = new Set<number>()
  for (const form of forms) {
    const enc = tokenizer.encode(form, { add_special_tokens: false })
    if (enc.length === 1 && !seen.has(enc[0])) {
      ids.push(enc[0])
      seen.add(enc[0])
    }
  }
  return ids
}

async function ensureModelLoaded(forceWasm = false): Promise<LoadedModelBundle> {
  if (activeBundle && (!forceWasm || activeBundle.device === 'wasm')) {
    return activeBundle
  }

  await disposeBundle()

  const gpu = await probeWebGpu()
  const tryWebGpu = !forceWasm && !webGpuFailed && gpu.available
  const desiredDevice: ContentFilterRuntimeDevice = tryWebGpu ? 'webgpu' : 'wasm'
  const desiredVariant: 'q4f16' | 'q4' = tryWebGpu && gpu.hasFp16 ? 'q4f16' : 'q4'

  const visionOnnxName = 'vision_encoder_q8.onnx'
  const visionDataName = 'vision_encoder_q8.onnx_data'
  const decoderOnnxName = desiredVariant === 'q4f16' ? 'decoder_q4f16.onnx' : 'decoder_q4.onnx'
  const decoderDataName =
    desiredVariant === 'q4f16' ? 'decoder_q4f16.onnx_data' : 'decoder_q4.onnx_data'

  const expectedVisionDataBytes = 196_200_000 // ~187.1 MB
  const expectedDecoderDataBytes =
    desiredVariant === 'q4f16' ? 1_567_500_000 : 1_741_800_000 // ~1.49 GB / ~1.66 GB

  const fileProgress = new Map<string, { loaded: number; total: number }>([
    ['tokenizer.json', { loaded: 0, total: 8_000_000 }],
    [visionOnnxName, { loaded: 0, total: 130_000 }],
    [visionDataName, { loaded: 0, total: expectedVisionDataBytes }],
    [decoderOnnxName, { loaded: 0, total: 360_000 }],
    [decoderDataName, { loaded: 0, total: expectedDecoderDataBytes }],
  ])

  let lastPercent = -1
  let lastReportTs = 0

  const reportProgress = (fileName: string, loaded: number, total: number, force = false) => {
    const prev = fileProgress.get(fileName) ?? { loaded: 0, total }
    const effTotal = total > 0 ? total : prev.total
    fileProgress.set(fileName, {
      loaded: Math.min(Math.max(loaded, 0), effTotal || loaded),
      total: effTotal,
    })

    let sumLoaded = 0
    let sumTotal = 0
    for (const entry of fileProgress.values()) {
      sumLoaded += entry.loaded
      sumTotal += entry.total
    }
    const percent =
      sumTotal > 0 ? Math.min(99, Math.max(0, Math.round((sumLoaded / sumTotal) * 100))) : 0

    const now = Date.now()
    if (force || percent !== lastPercent || now - lastReportTs > 160) {
      lastPercent = percent
      lastReportTs = now
      postOut({
        type: 'status',
        status: 'downloading',
        progress: percent,
        file: fileName,
        runtimeDevice: null,
      })
    }
  }

  postOut({
    type: 'status',
    status: 'downloading',
    progress: 0,
    file: 'tokenizer.json',
    runtimeDevice: null,
  })

  const transformersMod = await getTransformers()
  const ort = await getOrt()

  const tokenizer = (await transformersMod.AutoTokenizer.from_pretrained(CONTENT_FILTER_MODEL_ID, {
    progress_callback: (info: { file?: string; loaded?: number; total?: number; status?: string }) => {
      if (typeof info.loaded === 'number' && typeof info.total === 'number' && info.total > 0) {
        reportProgress('tokenizer.json', info.loaded, info.total)
      } else if (info.status === 'done') {
        reportProgress('tokenizer.json', 8_000_000, 8_000_000)
      }
    },
  })) as unknown as TokenizerLike
  reportProgress('tokenizer.json', 8_000_000, 8_000_000, true)

  const yesTokenIds = resolveSingleTokenIds(tokenizer, YES_FORMS)
  const noTokenIds = resolveSingleTokenIds(tokenizer, NO_FORMS)
  if (yesTokenIds.length === 0 || noTokenIds.length === 0) {
    throw new Error('Liquid d1-2B tokenizer missing yes/no decision tokens.')
  }
  const bosToken = typeof tokenizer.bos_token === 'string' ? tokenizer.bos_token : '<|startoftext|>'

  const createSessions = async (
    device: ContentFilterRuntimeDevice,
    decOnnx: string,
    decData: string,
    expDecBytes: number
  ): Promise<{ visionSession: OrtSessionLike; decoderSession: OrtSessionLike }> => {
    const visionEps = device === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm']
    const decoderEps = device === 'webgpu' ? ['webgpu'] : ['wasm']

    // 1. Load Vision Encoder first and free its external data buffer immediately after mount
    let visionOnnxBytes: Uint8Array | null = await fetchCachedBinary(
      `${HF_BASE_URL}/onnx/${visionOnnxName}`,
      130_000,
      (l, t) => reportProgress(visionOnnxName, l, t)
    )
    let visionDataBytes: Uint8Array | null = await fetchCachedBinary(
      `${HF_BASE_URL}/onnx/${visionDataName}`,
      expectedVisionDataBytes,
      (l, t) => reportProgress(visionDataName, l, t)
    )
    const visionSession = await ort.InferenceSession.create(visionOnnxBytes, {
      executionProviders: visionEps,
      externalData: [{ path: visionDataName, data: visionDataBytes }],
    })
    visionOnnxBytes = null
    visionDataBytes = null

    // 2. Load Decoder and free its external data buffer immediately after mount
    let decoderOnnxBytes: Uint8Array | null = await fetchCachedBinary(
      `${HF_BASE_URL}/onnx/${decOnnx}`,
      360_000,
      (l, t) => reportProgress(decOnnx, l, t)
    )
    let decoderDataBytes: Uint8Array | null = await fetchCachedBinary(
      `${HF_BASE_URL}/onnx/${decData}`,
      expDecBytes,
      (l, t) => reportProgress(decData, l, t)
    )
    try {
      const decoderSession = await ort.InferenceSession.create(decoderOnnxBytes, {
        executionProviders: decoderEps,
        externalData: [{ path: decData, data: decoderDataBytes }],
      })
      decoderOnnxBytes = null
      decoderDataBytes = null
      return { visionSession, decoderSession }
    } catch (err) {
      try {
        await visionSession.release?.()
      } catch {
        // Ignore cleanup failure
      }
      throw err
    }
  }

  let finalDevice: ContentFilterRuntimeDevice = desiredDevice
  let finalVariant: 'q4f16' | 'q4' = desiredVariant
  let sessions: { visionSession: OrtSessionLike; decoderSession: OrtSessionLike }

  if (desiredDevice === 'webgpu') {
    try {
      sessions = await createSessions(
        'webgpu',
        decoderOnnxName,
        decoderDataName,
        expectedDecoderDataBytes
      )
    } catch {
      webGpuFailed = true
      finalDevice = 'wasm'
      finalVariant = 'q4'
      fileProgress.delete(decoderOnnxName)
      fileProgress.delete(decoderDataName)
      fileProgress.set('decoder_q4.onnx', { loaded: 0, total: 360_000 })
      fileProgress.set('decoder_q4.onnx_data', { loaded: 0, total: 1_741_800_000 })
      sessions = await createSessions(
        'wasm',
        'decoder_q4.onnx',
        'decoder_q4.onnx_data',
        1_741_800_000
      )
    }
  } else {
    sessions = await createSessions(
      'wasm',
      'decoder_q4.onnx',
      'decoder_q4.onnx_data',
      1_741_800_000
    )
  }

  activeBundle = {
    device: finalDevice,
    decoderVariant: finalVariant,
    ort,
    tokenizer,
    bosToken,
    yesTokenIds,
    noTokenIds,
    visionSession: sessions.visionSession,
    decoderSession: sessions.decoderSession,
  }

  postOut({
    type: 'status',
    status: 'ready',
    progress: 100,
    file: null,
    runtimeDevice: finalDevice,
  })

  return activeBundle
}

function smartResize(
  origHeight: number,
  origWidth: number
): { height: number; width: number } {
  const safeH = Math.max(1, origHeight)
  const safeW = Math.max(1, origWidth)
  let hBar = Math.max(RESIZE_FACTOR, Math.round(safeH / RESIZE_FACTOR) * RESIZE_FACTOR)
  let wBar = Math.max(RESIZE_FACTOR, Math.round(safeW / RESIZE_FACTOR) * RESIZE_FACTOR)

  if (hBar * wBar > MAX_PIXELS) {
    const beta = Math.sqrt((safeH * safeW) / MAX_PIXELS)
    hBar = Math.max(RESIZE_FACTOR, Math.floor(safeH / beta / RESIZE_FACTOR) * RESIZE_FACTOR)
    wBar = Math.max(RESIZE_FACTOR, Math.floor(safeW / beta / RESIZE_FACTOR) * RESIZE_FACTOR)
  } else if (hBar * wBar < MIN_PIXELS) {
    const beta = Math.sqrt(MIN_PIXELS / (safeH * safeW))
    hBar = Math.max(RESIZE_FACTOR, Math.ceil((safeH * beta) / RESIZE_FACTOR) * RESIZE_FACTOR)
    wBar = Math.max(RESIZE_FACTOR, Math.ceil((safeW * beta) / RESIZE_FACTOR) * RESIZE_FACTOR)
  }
  return { height: hBar, width: wBar }
}

async function encodeImageToPatches(blob: Blob): Promise<{
  data: Float32Array
  hBlocks: number
  wBlocks: number
  numImageTokens: number
}> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas image decoding is unavailable in this browser worker.')
  }

  const bitmap = await createImageBitmap(blob)
  let rgba: Uint8ClampedArray
  let targetH: number
  let targetW: number
  try {
    const resized = smartResize(bitmap.height, bitmap.width)
    targetH = resized.height
    targetW = resized.width

    const canvas = new OffscreenCanvas(targetW, targetH)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      throw new Error('Unable to initialize 2D OffscreenCanvas context for image screening.')
    }
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, targetW, targetH)
    rgba = ctx.getImageData(0, 0, targetW, targetH).data
  } finally {
    bitmap.close()
  }

  const hBlocks = targetH / RESIZE_FACTOR
  const wBlocks = targetW / RESIZE_FACTOR
  const patchVecLen = 3 * TEMPORAL_PATCH_SIZE * PATCH_SIZE * PATCH_SIZE // 1536
  const data = new Float32Array(hBlocks * wBlocks * MERGE_SIZE * MERGE_SIZE * patchVecLen)

  // Exact Lfm3VlImageProcessor patchify layout:
  // [hBlocks, wBlocks, mergeH=2, mergeW=2, channel=3, temporal=2, py=16, px=16]
  let outIdx = 0
  for (let bh = 0; bh < hBlocks; bh++) {
    for (let bw = 0; bw < wBlocks; bw++) {
      for (let mh = 0; mh < MERGE_SIZE; mh++) {
        const baseY = (bh * MERGE_SIZE + mh) * PATCH_SIZE
        for (let mw = 0; mw < MERGE_SIZE; mw++) {
          const baseX = (bw * MERGE_SIZE + mw) * PATCH_SIZE
          for (let c = 0; c < 3; c++) {
            // Static image: temporal_patch_size = 2 duplicates the identical frame
            for (let t = 0; t < TEMPORAL_PATCH_SIZE; t++) {
              for (let py = 0; py < PATCH_SIZE; py++) {
                const rowOffset = (baseY + py) * targetW + baseX
                for (let px = 0; px < PATCH_SIZE; px++) {
                  const pixel = rgba[(rowOffset + px) * 4 + c]
                  data[outIdx++] = pixel / 127.5 - 1.0
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    data,
    hBlocks,
    wBlocks,
    numImageTokens: hBlocks * wBlocks,
  }
}

function buildActiveQuestions(rules: ContentFilterRulesPayload, isImage: boolean): ModerationQuestion[] {
  const subject = isImage ? 'image' : 'message'
  const questions: ModerationQuestion[] = []

  if (rules.filterNsfw) {
    questions.push({
      category: 'nsfw',
      label: 'NSFW / Explicit',
      threshold: THRESHOLD_NSFW,
      instructions: `Does this ${subject} contain NSFW, pornographic, sexually explicit, or graphic adult nudity?`,
      yesCriteria: `The ${subject} depicts explicit sexual acts, pornography, exposed genitals, or graphic adult NSFW content`,
      noCriteria: `The ${subject} is safe for work, normal photography, art, meme, clothing, or non-explicit`,
    })
  }

  if (rules.filterIllegal) {
    questions.push({
      category: 'illegal',
      label: 'Illegal / Extreme Harm',
      threshold: THRESHOLD_ILLEGAL,
      instructions: `Does this ${subject} depict or promote illegal content such as child sexual exploitation (CSAM), extreme graphic gore or murder, terrorism, or severe illegal harm?`,
      yesCriteria: `The ${subject} depicts or promotes CSAM, extreme violence/gore, terrorism, or severe illegal harm`,
      noCriteria: `The ${subject} does not depict or promote illegal or extremely harmful material`,
    })
  }

  const customRule = rules.customInstructions.trim()
  if (rules.customRulesEnabled && customRule.length > 0) {
    const cleanRule = escapeSpecialTokens(customRule.slice(0, 500))
    questions.push({
      category: 'custom',
      label: 'Custom Rule',
      threshold: THRESHOLD_CUSTOM,
      instructions: `Does this ${subject} violate the following content moderation rule? Rule: ${cleanRule}`,
      yesCriteria: `The ${subject} clearly violates the rule: ${cleanRule}`,
      noCriteria: `The ${subject} complies with the rule and should be allowed`,
    })
  }

  return questions
}

function buildQuestionSuffix(q: ModerationQuestion): string {
  const body =
    `${q.instructions}\n` +
    `Yes: ${q.yesCriteria}\n` +
    `No: ${q.noCriteria}\n\n` +
    `Reply with yes or no only.`
  return `${escapeSpecialTokens(body)}${IM_END}\n${IM_START}assistant\n${ASSISTANT_LEAD}`
}

async function runDecisionPass(
  bundle: LoadedModelBundle,
  kind: 'image' | 'text',
  rules: ContentFilterRulesPayload,
  blob?: Blob,
  text?: string,
  caption?: string
): Promise<{
  safe: boolean
  flagged: boolean
  categories: ContentFilterCategory[]
  reason?: string
  scores: Partial<Record<ContentFilterCategory, number>>
}> {
  const questions = buildActiveQuestions(rules, kind === 'image')
  if (questions.length === 0) {
    return { safe: true, flagged: false, categories: [], scores: {} }
  }

  const { ort, tokenizer, bosToken, yesTokenIds, noTokenIds } = bundle
  const disposables: OrtTensorLike[] = []

  try {
    let imageFeaturesTensor: OrtTensorLike
    let numImageTokens = 0

    if (kind === 'image' && blob) {
      const patches = await encodeImageToPatches(blob)
      numImageTokens = patches.numImageTokens
      const pixelTensor = new ort.Tensor('float32', patches.data, [
        patches.hBlocks,
        patches.wBlocks,
        MERGE_SIZE,
        MERGE_SIZE,
        3 * TEMPORAL_PATCH_SIZE * PATCH_SIZE * PATCH_SIZE,
      ])
      disposables.push(pixelTensor)

      const visionOut = await bundle.visionSession.run({ pixel_values: pixelTensor })
      const feat = visionOut.image_features ?? Object.values(visionOut)[0]
      if (!feat) {
        throw new Error('Vision encoder returned no image_features tensor.')
      }
      imageFeaturesTensor = feat
      disposables.push(imageFeaturesTensor)
    } else {
      imageFeaturesTensor = new ort.Tensor('float32', new Float32Array(0), [0, HIDDEN_SIZE])
      disposables.push(imageFeaturesTensor)
    }

    const videoFeaturesTensor = new ort.Tensor('float32', new Float32Array(0), [0, HIDDEN_SIZE])
    disposables.push(videoFeaturesTensor)

    const mediaMarkup =
      numImageTokens > 0
        ? `${VISION_START}${IMAGE_TOKEN.repeat(numImageTokens)}${VISION_END}`
        : ''

    const stateStr = (kind === 'text' ? text : caption)?.trim().slice(0, MAX_TEXT_CHARS) ?? ''
    const hasState = stateStr.length > 0
    const header = hasState ? 'QUESTION:\n' : ''
    const stateBody = hasState ? `${escapeSpecialTokens(stateStr)}\n\n\n${header}` : ''
    const prefix = `${bosToken}${IM_START}user\n${mediaMarkup}${stateBody}`

    const suffixes = questions.map(buildQuestionSuffix)

    // Exact attention.py `pack_set`: pack state (-1) + questions (1..N) in a single forward pass
    const firstFullIds = tokenizer.encode(prefix + suffixes[0], { add_special_tokens: false })
    const firstSuffixLen = tokenizer.encode(suffixes[0], { add_special_tokens: false }).length
    const stateLen = Math.max(0, firstFullIds.length - firstSuffixLen)

    const allIds: number[] = [...firstFullIds]
    const allQuestionIds: number[] = [
      ...new Array<number>(stateLen).fill(-1),
      ...new Array<number>(firstFullIds.length - stateLen).fill(1),
    ]
    const slotPositions: number[] = [allIds.length - 1]

    for (let k = 1; k < suffixes.length; k++) {
      const own = tokenizer.encode(header + suffixes[k], { add_special_tokens: false })
      for (const id of own) {
        allIds.push(id)
        allQuestionIds.push(k + 1)
      }
      slotPositions.push(allIds.length - 1)
    }

    const seqLen = allIds.length
    const inputIdsData = new BigInt64Array(seqLen)
    const attentionMaskData = new BigInt64Array(seqLen)
    const positionIdsData = new BigInt64Array(seqLen)
    const questionIdsData = new BigInt64Array(seqLen)
    for (let i = 0; i < seqLen; i++) {
      inputIdsData[i] = BigInt(allIds[i])
      attentionMaskData[i] = 1n
      positionIdsData[i] = BigInt(i)
      questionIdsData[i] = BigInt(allQuestionIds[i])
    }
    const slotPosData = new BigInt64Array(slotPositions.length)
    for (let j = 0; j < slotPositions.length; j++) {
      slotPosData[j] = BigInt(slotPositions[j])
    }

    const inputIdsTensor = new ort.Tensor('int64', inputIdsData, [1, seqLen])
    const attentionMaskTensor = new ort.Tensor('int64', attentionMaskData, [1, seqLen])
    const positionIdsTensor = new ort.Tensor('int64', positionIdsData, [1, seqLen])
    const questionIdsTensor = new ort.Tensor('int64', questionIdsData, [1, seqLen])
    const slotPosTensor = new ort.Tensor('int64', slotPosData, [slotPositions.length])
    disposables.push(
      inputIdsTensor,
      attentionMaskTensor,
      positionIdsTensor,
      questionIdsTensor,
      slotPosTensor
    )

    const decoderOut = await bundle.decoderSession.run({
      input_ids: inputIdsTensor,
      attention_mask: attentionMaskTensor,
      position_ids: positionIdsTensor,
      image_features: imageFeaturesTensor,
      video_features: videoFeaturesTensor,
      question_ids: questionIdsTensor,
      slot_positions: slotPosTensor,
    })

    for (const outTensor of Object.values(decoderOut)) {
      if (outTensor) disposables.push(outTensor)
    }

    const logitsTensor = decoderOut.logits ?? Object.values(decoderOut)[0]
    if (!logitsTensor) {
      throw new Error('Liquid d1-2B decoder returned no logits tensor.')
    }
    const logitsData = logitsTensor.data as Float32Array
    const vocabSize = logitsTensor.dims[logitsTensor.dims.length - 1] || 128_000

    const scores: Partial<Record<ContentFilterCategory, number>> = {}
    const flaggedCategories: ContentFilterCategory[] = []
    const reasonParts: string[] = []

    for (let j = 0; j < questions.length; j++) {
      const q = questions[j]
      const rowOffset = j * vocabSize

      let yesLogit = -Infinity
      for (const tid of yesTokenIds) {
        const v = logitsData[rowOffset + tid]
        if (typeof v === 'number' && v > yesLogit) yesLogit = v
      }
      let noLogit = -Infinity
      for (const tid of noTokenIds) {
        const v = logitsData[rowOffset + tid]
        if (typeof v === 'number' && v > noLogit) noLogit = v
      }

      const scaledDiff = (noLogit - yesLogit) / CALIBRATION_TEMP
      const pYes = Number.isFinite(scaledDiff)
        ? 1 / (1 + Math.exp(Math.max(-60, Math.min(60, scaledDiff))))
        : 0
      const rounded = Math.round(pYes * 1000) / 1000
      scores[q.category] = rounded

      if (pYes >= q.threshold) {
        flaggedCategories.push(q.category)
        reasonParts.push(`${q.label} (${Math.round(pYes * 100)}%)`)
      }
    }

    const flagged = flaggedCategories.length > 0
    return {
      safe: !flagged,
      flagged,
      categories: flaggedCategories,
      reason: flagged ? reasonParts.join(' · ') : undefined,
      scores,
    }
  } finally {
    for (const tensor of disposables) {
      try {
        tensor.dispose?.()
      } catch {
        // Ignore disposal errors
      }
    }
  }
}

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true
  try {
    while (queue.length > 0) {
      const job = queue.shift()
      if (!job) continue

      if (job.type === 'clear-cache') {
        await disposeBundle()
        try {
          if (typeof caches !== 'undefined') {
            await caches.delete(CONTENT_FILTER_CACHE_NAME)
          }
        } catch {
          // Ignore cache deletion failure
        }
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

      try {
        if (job.type === 'preload') {
          const bundle = await ensureModelLoaded()
          postOut({
            type: 'result',
            requestId: job.requestId,
            safe: true,
            flagged: false,
            categories: [],
            scores: {},
            runtimeDevice: bundle.device,
          })
          continue
        }

        // Fast short-circuit if no moderation rules are active
        const activeQuestions = buildActiveQuestions(job.rules, job.kind === 'image')
        if (activeQuestions.length === 0) {
          postOut({
            type: 'result',
            requestId: job.requestId,
            safe: true,
            flagged: false,
            categories: [],
            scores: {},
            runtimeDevice: activeBundle?.device ?? null,
          })
          continue
        }

        let bundle = await ensureModelLoaded()
        let outcome: Awaited<ReturnType<typeof runDecisionPass>>
        try {
          outcome = await runDecisionPass(
            bundle,
            job.kind,
            job.rules,
            job.blob,
            job.text,
            job.caption
          )
        } catch (inferErr) {
          if (bundle.device === 'webgpu') {
            webGpuFailed = true
            bundle = await ensureModelLoaded(true)
            outcome = await runDecisionPass(
              bundle,
              job.kind,
              job.rules,
              job.blob,
              job.text,
              job.caption
            )
          } else {
            throw inferErr
          }
        }

        postOut({
          type: 'result',
          requestId: job.requestId,
          safe: outcome.safe,
          flagged: outcome.flagged,
          categories: outcome.categories,
          reason: outcome.reason,
          scores: outcome.scores,
          runtimeDevice: bundle.device,
        })
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Liquid d1-2B content filtering failed.'
        if (job.type === 'preload' || !activeBundle) {
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

self.onmessage = (event: MessageEvent<ContentFilterWorkerInMessage>) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'dispose') {
    queue.length = 0
    void disposeBundle()
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
