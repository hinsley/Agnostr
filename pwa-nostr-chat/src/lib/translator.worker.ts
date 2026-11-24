/// <reference lib="webworker" />

import {
  DEFAULT_TRANSLATOR_MODEL_KEY,
  OPUS_DEFAULT_FROM_EN_MODEL,
  OPUS_DEFAULT_TO_EN_MODEL,
  OPUS_FROM_EN_MODELS,
  OPUS_TO_EN_MODELS,
  resolveLanguageCodes,
  TRANSLATOR_CACHE_KEY,
  TRANSLATOR_MODELS,
  type ResolvedLanguageCodes,
  type TranslatorJobPriority,
  type TranslatorModelDtype,
  type TranslatorModelKey,
  type TranslatorModelStatus,
  type TranslatorRuntimeDevice,
} from '../types/translator.ts'
import { detectLanguageDetailed, isNonTranslatableText } from './languageDetect.ts'

export type { TranslatorJobPriority }

export type TranslatorWorkerInMessage =
  | {
      type: 'load'
      requestId: string
      modelKey: TranslatorModelKey
      modelId: string
    }
  | {
      type: 'translate'
      requestId: string
      modelKey: TranslatorModelKey
      modelId: string
      text: string
      targetLang: string
      sourceLang?: string
      roomHintLang?: string | null
      scopeKey?: string
      priority: TranslatorJobPriority
    }
  | {
      type: 'cancelScope'
      keepScopeKey?: string
    }
  | {
      type: 'dispose'
    }

export type TranslatorWorkerOutMessage =
  | {
      type: 'status'
      status: TranslatorModelStatus
      modelKey: TranslatorModelKey
      modelId: string
      progress?: number
      file?: string | null
      runtimeDevice?: TranslatorRuntimeDevice | null
      dtype?: TranslatorModelDtype | null
      error?: string
    }
  | {
      type: 'result'
      requestId: string
      text: string
      modelKey: TranslatorModelKey
      modelId: string
      runtimeDevice: TranslatorRuntimeDevice
      dtype: TranslatorModelDtype
      detectedSourceLang?: string
      sameLanguage?: boolean
    }
  | {
      type: 'error'
      requestId: string
      kind: 'load' | 'translate'
      error: string
    }
  | {
      type: 'dropped'
      requestId: string
    }

interface TranslationOutputItemLike {
  translation_text?: string
}

interface TensorLike {
  data: ArrayLike<number | bigint>
  dims: number[]
}

interface TokenizerLike {
  (
    text: string,
    options?: Record<string, unknown>
  ): {
    input_ids: TensorLike
    attention_mask?: TensorLike
  }
  language_codes?: string[]
  unk_token_id?: number
  _tokenizer?: {
    token_to_id?: (token: string) => number | undefined
  }
  convert_tokens_to_ids?: (token: string) => number | undefined
  batch_decode?: (
    sequences: unknown,
    options?: Record<string, unknown>
  ) => string[] | string
}

interface TranslationPipelineLike {
  (
    text: string,
    options?: Record<string, unknown>
  ): Promise<TranslationOutputItemLike | TranslationOutputItemLike[]>
  model?: {
    forward?: (...args: unknown[]) => Promise<unknown>
    generate?: (options: Record<string, unknown>) => Promise<unknown>
  }
  tokenizer?: TokenizerLike
  dispose?: () => Promise<void>
}

interface InterruptableCriteriaLike {
  interrupted: boolean
  interrupt: () => void
  reset: () => void
}

interface ProgressEventLike {
  status?: string
  file?: string
  loaded?: number
  total?: number
  progress?: number
}

interface QueuedJob {
  type: 'load' | 'translate'
  requestId: string
  modelKey: TranslatorModelKey
  modelId: string
  priority: TranslatorJobPriority
  text?: string
  targetLang?: string
  sourceLang?: string
  roomHintLang?: string | null
  scopeKey?: string
}

interface ActiveModelHandle {
  modelKey: TranslatorModelKey
  modelId: string
  device: TranslatorRuntimeDevice
  dtype: TranslatorModelDtype
  pipe: TranslationPipelineLike
}

interface TranslationRunOutput {
  text: string
  detectedSourceLang: string
  sameLanguage: boolean
}

const MAX_PENDING_NORMAL_JOBS = 64
const MAX_SEGMENT_CHARS = 900
const MAX_OPUS_RAM_HANDLES = 2
const INFERENCE_TIMEOUT_MS = 45_000
const INFERENCE_UNWIND_WAIT_MS = 4_000
const LEGACY_TRANSFORMERS_CACHE_KEY = 'transformers-cache'

// Verified encoder + decoder ONNX byte totals from HuggingFace live probe:
// Opus-MT q8: ~107 MiB (~112 MB per language pair)
// M2M-100 q8: 274.5 + 328.2 = 602.7 MiB (~632 MB)
// NLLB-200 q8: 399.7 + 453.5 = 853.2 MiB (~895 MB); q4f16: 583.9 + 611.9 = 1,195.9 MiB (~1,254 MB)
const EXPECTED_MODEL_BYTES: Record<TranslatorModelKey, Record<TranslatorModelDtype, number>> = {
  opus: {
    q8: 112_000_000,
    q4f16: 112_000_000,
  },
  m2m100: {
    q8: 632_000_000,
    q4f16: 729_000_000,
  },
  nllb200: {
    q8: 895_000_000,
    q4f16: 1_254_000_000,
  },
}

const ENGLISH_RESOLVED: ResolvedLanguageCodes = {
  name: 'English',
  m2mCode: 'en',
  nllbCode: 'eng_Latn',
  opusCode: 'eng',
}

function normalizeWorkerModelKey(raw: unknown): TranslatorModelKey {
  if (raw === 'opus' || raw === 'nllb200' || raw === 'm2m100') return raw
  return DEFAULT_TRANSLATOR_MODEL_KEY
}

const COMPACT_SCRIPT_RE = /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\u0E00-\u0E7F]/

let transformersModulePromise: Promise<typeof import('@huggingface/transformers')> | null = null
const opusHandles = new Map<string, ActiveModelHandle>()
let heavyHandle: ActiveModelHandle | null = null
let lastActiveHandle: ActiveModelHandle | null = null
let webGpuFailed = false
let legacyEvictionStarted = false

const queue: QueuedJob[] = []
const cancelledRequestIds = new Set<string>()
let activeJob: QueuedJob | null = null
let activeStoppingCriteria: InterruptableCriteriaLike | null = null
let activeInferencePromise: Promise<unknown> | null = null
let activePreempted = false
let activeCancelled = false
let disposePending = false
let processing = false

const wrappedForwardModels = new WeakSet<object>()
const yieldResolvers: Array<() => void> = []
let yieldChannel: MessageChannel | null = null

function yieldToMacrotask(): Promise<void> {
  if (typeof MessageChannel !== 'undefined') {
    if (!yieldChannel) {
      yieldChannel = new MessageChannel()
      yieldChannel.port1.onmessage = () => {
        const next = yieldResolvers.shift()
        if (next) next()
      }
    }
    return new Promise<void>((resolve) => {
      yieldResolvers.push(resolve)
      yieldChannel?.port2.postMessage(null)
    })
  }
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

function closeYieldChannel(): void {
  if (yieldChannel) {
    try {
      yieldChannel.port1.close()
      yieldChannel.port2.close()
    } catch {
      // Ignore close errors
    }
    yieldChannel = null
  }
  while (yieldResolvers.length > 0) {
    const resolve = yieldResolvers.shift()
    if (resolve) resolve()
  }
}

function jobPriorityRank(job: Pick<QueuedJob, 'type' | 'priority'>): number {
  if (job.type === 'load') return -1
  if (job.priority === 'high') return 0
  if (job.priority === 'live') return 1
  if (job.priority === 'visible') return 2
  return 3
}

function shouldYieldBetweenTokens(): boolean {
  return (
    activeStoppingCriteria !== null &&
    activeJob !== null &&
    activeJob.type === 'translate' &&
    jobPriorityRank(activeJob) > 0 &&
    !activePreempted &&
    !activeCancelled
  )
}

/**
 * In single-threaded WASM (`proxy: false`), `session.run()` resolves on the microtask queue,
 * which can starve `self.onmessage` until all decoder tokens finish. Yielding a ~0.03ms
 * `MessageChannel` macrotask after each decoder step lets incoming `'high'`/`'live'` jobs
 * and `cancelScope` calls fire `activeStoppingCriteria.interrupt()` mid-generation.
 */
function installCooperativeTokenYield(pipe: TranslationPipelineLike): void {
  const model = pipe.model
  if (!model || typeof model.forward !== 'function' || wrappedForwardModels.has(model)) {
    return
  }
  wrappedForwardModels.add(model)
  const originalForward = model.forward
  model.forward = async function (this: unknown, ...args: unknown[]) {
    const out = await originalForward.apply(this, args)
    if (shouldYieldBetweenTokens()) {
      await yieldToMacrotask()
    }
    return out
  }
}

function postOut(msg: TranslatorWorkerOutMessage): void {
  self.postMessage(msg)
}

function isLegacyOrBrokenCacheUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return (
    lower.includes('lfm3-1.7b-onnx') ||
    lower.includes('lfm3%2d1.7b') ||
    lower.includes('onnx-community/lfm3') ||
    lower.includes('onnx-community%2flfm3') ||
    // Evict broken m2m100 q4f16 weights from older builds (m2m100 always runs wasm/q8)
    ((lower.includes('m2m100_418m') || lower.includes('m2m100%5f418m')) &&
      lower.includes('_q4f16.onnx'))
  )
}

/**
 * Silently evicts legacy LFM3-1.7B-ONNX and broken M2M-100 q4f16 cache entries
 * from both `agnostr-translator-cache` and `transformers-cache`.
 */
async function evictLegacyCacheOnce(): Promise<void> {
  if (legacyEvictionStarted) return
  legacyEvictionStarted = true
  try {
    if (typeof caches === 'undefined') return
    for (const cacheName of [TRANSLATOR_CACHE_KEY, LEGACY_TRANSFORMERS_CACHE_KEY]) {
      const exists = await caches.has(cacheName)
      if (!exists) continue
      const cache = await caches.open(cacheName)
      const keys = await cache.keys()
      const deletions: Promise<boolean>[] = []
      for (const req of keys) {
        if (isLegacyOrBrokenCacheUrl(req.url)) {
          deletions.push(cache.delete(req))
        }
      }
      if (deletions.length > 0) {
        await Promise.all(deletions)
      }
    }
  } catch {
    // Ignore Cache Storage restrictions
  }
}

async function getTransformersModule(): Promise<typeof import('@huggingface/transformers')> {
  if (!transformersModulePromise) {
    transformersModulePromise = import('@huggingface/transformers')
  }
  const mod = await transformersModulePromise
  mod.env.allowLocalModels = false
  mod.env.useBrowserCache = true
  mod.env.useWasmCache = true
  mod.env.cacheKey = TRANSLATOR_CACHE_KEY
  const onnxBackend = mod.env.backends?.onnx as
    | {
        logLevel?: string
        wasm?: { proxy?: boolean; numThreads?: number }
      }
    | undefined
  if (onnxBackend) {
    onnxBackend.logLevel = 'error'
    if (onnxBackend.wasm) {
      onnxBackend.wasm.proxy = false
      if (!self.crossOriginIsolated) {
        onnxBackend.wasm.numThreads = 1
      }
    }
  }
  return mod
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

function getMruOpusHandle(): ActiveModelHandle | null {
  let mru: ActiveModelHandle | null = null
  for (const h of opusHandles.values()) {
    mru = h
  }
  return mru
}

function getLastActiveHandle(preferredModelKey?: TranslatorModelKey): ActiveModelHandle | null {
  if (preferredModelKey === 'opus') {
    return getMruOpusHandle()
  }
  if (preferredModelKey === 'm2m100' || preferredModelKey === 'nllb200') {
    return heavyHandle && heavyHandle.modelKey === preferredModelKey ? heavyHandle : null
  }
  return lastActiveHandle ?? heavyHandle ?? getMruOpusHandle()
}

function hasLoadedHandleForModelKey(modelKey: TranslatorModelKey): boolean {
  if (modelKey === 'opus') return opusHandles.size > 0
  return heavyHandle !== null && heavyHandle.modelKey === modelKey
}

async function waitForActiveInferenceUnwind(): Promise<void> {
  const pending = activeInferencePromise
  if (!pending) return
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      pending.then(
        () => undefined,
        () => undefined
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, INFERENCE_UNWIND_WAIT_MS)
      }),
    ])
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

async function trackInference<T>(fn: () => Promise<T>): Promise<T> {
  const promise = fn()
  activeInferencePromise = promise
  try {
    return await promise
  } finally {
    if (activeInferencePromise === promise) {
      activeInferencePromise = null
    }
  }
}

async function disposeHandleSafe(handle: ActiveModelHandle | null): Promise<void> {
  if (!handle) return
  await waitForActiveInferenceUnwind()
  if (lastActiveHandle === handle) {
    lastActiveHandle = heavyHandle ?? getMruOpusHandle()
  }
  if (typeof handle.pipe.dispose === 'function') {
    try {
      await handle.pipe.dispose()
    } catch {
      // Ignore disposal errors
    }
  }
}

async function disposeHeavyHandle(): Promise<void> {
  const prev = heavyHandle
  heavyHandle = null
  await disposeHandleSafe(prev)
}

async function disposeAllOpusHandles(): Promise<void> {
  if (opusHandles.size === 0) return
  await waitForActiveInferenceUnwind()
  const handles = Array.from(opusHandles.values())
  opusHandles.clear()
  if (lastActiveHandle?.modelKey === 'opus') {
    lastActiveHandle = heavyHandle
  }
  for (const handle of handles) {
    if (typeof handle.pipe.dispose === 'function') {
      try {
        await handle.pipe.dispose()
      } catch {
        // Ignore disposal errors
      }
    }
  }
}

async function disposeAllModels(): Promise<void> {
  await disposeHeavyHandle()
  await disposeAllOpusHandles()
  lastActiveHandle = null
}

function extractTranslationText(
  out: TranslationOutputItemLike | TranslationOutputItemLike[]
): string {
  const first = Array.isArray(out) ? out[0] : out
  return typeof first?.translation_text === 'string' ? first.translation_text.trim() : ''
}

async function createPipelineAttempt(
  mod: typeof import('@huggingface/transformers'),
  modelKey: TranslatorModelKey,
  modelId: string,
  device: TranslatorRuntimeDevice,
  dtype: TranslatorModelDtype
): Promise<TranslationPipelineLike> {
  const fileProgress = new Map<string, { loaded: number; total: number }>()
  const onnxFilesWithTotal = new Set<string>()
  let lastReportTs = 0
  let lastPercent = 0
  const expectedTotalBytes = EXPECTED_MODEL_BYTES[modelKey][dtype]

  postOut({
    type: 'status',
    status: 'downloading',
    modelKey,
    modelId,
    progress: 0,
    file: null,
    runtimeDevice: device,
    dtype,
  })

  const onProgress = (info: ProgressEventLike) => {
    const fileName = typeof info.file === 'string' ? info.file : ''
    if (fileName) {
      const prev = fileProgress.get(fileName) ?? { loaded: 0, total: 0 }
      const total =
        typeof info.total === 'number' && info.total > 0 ? info.total : prev.total
      const loaded =
        info.status === 'done'
          ? total || prev.loaded
          : typeof info.loaded === 'number' && info.loaded >= 0
            ? info.loaded
            : prev.loaded
      fileProgress.set(fileName, { loaded, total })
      if (fileName.endsWith('.onnx') && total > 0) {
        onnxFilesWithTotal.add(fileName)
      }
    }

    let sumLoaded = 0
    let sumTotal = 0
    for (const entry of fileProgress.values()) {
      if (entry.total > 0) {
        sumLoaded += Math.min(entry.loaded, entry.total)
        sumTotal += entry.total
      }
    }

    let computedPercent = lastPercent
    if (sumTotal > 0) {
      const effectiveTotal =
        onnxFilesWithTotal.size >= 2 ? sumTotal : Math.max(sumTotal, expectedTotalBytes)
      computedPercent = Math.min(
        99,
        Math.max(0, Math.round((sumLoaded / effectiveTotal) * 100))
      )
    } else if (typeof info.progress === 'number' && Number.isFinite(info.progress)) {
      const capped = onnxFilesWithTotal.size >= 2 ? info.progress : Math.min(2, info.progress)
      computedPercent = Math.min(99, Math.max(0, Math.round(capped)))
    }

    const percent = Math.min(99, Math.max(lastPercent, computedPercent))
    const now = Date.now()
    if (percent !== lastPercent || info.status === 'done' || now - lastReportTs > 120) {
      lastPercent = percent
      lastReportTs = now
      postOut({
        type: 'status',
        status: 'downloading',
        modelKey,
        modelId,
        progress: percent,
        file: fileName || null,
        runtimeDevice: device,
        dtype,
      })
    }
  }

  const loader = mod.pipeline as unknown as (
    task: string,
    model: string,
    opts: Record<string, unknown>
  ) => Promise<TranslationPipelineLike>

  return await loader('translation', modelId, {
    device,
    dtype,
    progress_callback: onProgress,
  })
}

/**
 * 1-shot sanity verification for WebGPU pipelines (guards against GPU driver / FP16
 * silent numerical collapse that outputs punctuation garbage without throwing).
 */
async function verifyNllbWebGpuSanity(pipe: TranslationPipelineLike): Promise<boolean> {
  try {
    const out = await pipe('Hello world', {
      src_lang: 'eng_Latn',
      tgt_lang: 'spa_Latn',
      num_beams: 1,
      max_new_tokens: 24,
      repetition_penalty: 1.12,
      no_repeat_ngram_size: 4,
    })
    const text = extractTranslationText(out)
    const letterCount = text.match(/\p{L}/gu)?.length ?? 0
    return letterCount >= 3
  } catch {
    return false
  }
}

async function ensureModel(
  rawModelKey: TranslatorModelKey,
  rawModelId: string,
  forceWasm = false,
  protectedOpusModelId?: string
): Promise<ActiveModelHandle> {
  void evictLegacyCacheOnce()

  const modelKey = normalizeWorkerModelKey(rawModelKey)
  const modelId = rawModelId || TRANSLATOR_MODELS[modelKey].id

  if (modelKey === 'opus') {
    if (heavyHandle) {
      await disposeHeavyHandle()
    }

    const cached = opusHandles.get(modelId)
    if (cached) {
      // Promote to MRU and return immediately (0 ms, zero status churn, zero dispose)
      opusHandles.delete(modelId)
      opusHandles.set(modelId, cached)
      lastActiveHandle = cached
      return cached
    }

    // Bounded 2-slot LRU RAM pool (~214 MB max — phone-safe on Pixel 8 / 4 GB Android).
    // Evict only the least-recently-used pair, never evicting the active sibling hop.
    while (opusHandles.size >= MAX_OPUS_RAM_HANDLES) {
      let victimKey: string | null = null
      for (const key of opusHandles.keys()) {
        if (key !== protectedOpusModelId) {
          victimKey = key
          break
        }
      }
      if (!victimKey) {
        victimKey = opusHandles.keys().next().value ?? null
      }
      if (!victimKey) break
      const victim = opusHandles.get(victimKey) ?? null
      opusHandles.delete(victimKey)
      await disposeHandleSafe(victim)
    }

    const mod = await getTransformersModule()
    let pipe: TranslationPipelineLike | null = null
    try {
      pipe = await createPipelineAttempt(mod, 'opus', modelId, 'wasm', 'q8')
      installCooperativeTokenYield(pipe)
      const nextHandle: ActiveModelHandle = {
        modelKey: 'opus',
        modelId,
        device: 'wasm',
        dtype: 'q8',
        pipe,
      }
      opusHandles.set(modelId, nextHandle)
      lastActiveHandle = nextHandle
      postOut({
        type: 'status',
        status: 'ready',
        modelKey: 'opus',
        modelId,
        progress: 100,
        file: null,
        runtimeDevice: 'wasm',
        dtype: 'q8',
      })
      return nextHandle
    } catch (err) {
      if (pipe && typeof pipe.dispose === 'function') {
        try {
          await pipe.dispose()
        } catch {
          // Ignore dispose error
        }
      }
      throw err instanceof Error
        ? err
        : new Error(`Unable to load local ${TRANSLATOR_MODELS.opus.shortLabel} translation model.`)
    }
  }

  // Heavy models (M2M-100 / NLLB-200): strictly 1 session in RAM
  if (opusHandles.size > 0) {
    await disposeAllOpusHandles()
  }

  if (
    heavyHandle &&
    heavyHandle.modelKey === modelKey &&
    heavyHandle.modelId === modelId &&
    (!forceWasm || heavyHandle.device === 'wasm')
  ) {
    lastActiveHandle = heavyHandle
    return heavyHandle
  }

  await disposeHeavyHandle()

  const mod = await getTransformersModule()

  // Empirically verified runtime matrix:
  // - Opus-MT Lite: ALWAYS WASM q8 (~107 MiB/pair, 2-slot LRU RAM pool, fast).
  // - M2M-100: ALWAYS WASM q8 (602.7 MiB, 260–650 ms/msg, 100% accurate).
  //   Never WebGPU q4f16/fp16 (FP16 collapse outputs "."/"¿ ¿,") or WebGPU q8 (3× slower).
  // - NLLB-200: WebGPU q4f16 when WebGPU+shader-f16 passes 1-shot sanity check (207–440 ms/msg),
  //   with automatic fallback to WASM q8 (853.2 MiB, 357–830 ms/msg).
  const attempts: Array<{
    device: TranslatorRuntimeDevice
    dtype: TranslatorModelDtype
  }> = []

  if (modelKey === 'nllb200' && !forceWasm && !webGpuFailed) {
    const gpu = await probeWebGpu()
    if (gpu.available && gpu.hasFp16) {
      attempts.push({ device: 'webgpu', dtype: 'q4f16' })
    }
  }
  attempts.push({ device: 'wasm', dtype: 'q8' })

  let lastErr: unknown = null
  for (const attempt of attempts) {
    let pipe: TranslationPipelineLike | null = null
    try {
      pipe = await createPipelineAttempt(mod, modelKey, modelId, attempt.device, attempt.dtype)
      if (attempt.device === 'webgpu' && modelKey === 'nllb200') {
        const sane = await verifyNllbWebGpuSanity(pipe)
        if (!sane) {
          webGpuFailed = true
          if (typeof pipe.dispose === 'function') {
            try {
              await pipe.dispose()
            } catch {
              // Ignore dispose error
            }
          }
          pipe = null
          lastErr = new Error('WebGPU self-check failed; falling back to WASM.')
          continue
        }
      }
      installCooperativeTokenYield(pipe)
      heavyHandle = {
        modelKey,
        modelId,
        device: attempt.device,
        dtype: attempt.dtype,
        pipe,
      }
      lastActiveHandle = heavyHandle
      postOut({
        type: 'status',
        status: 'ready',
        modelKey,
        modelId,
        progress: 100,
        file: null,
        runtimeDevice: attempt.device,
        dtype: attempt.dtype,
      })
      return heavyHandle
    } catch (err) {
      lastErr = err
      if (pipe && typeof pipe.dispose === 'function') {
        try {
          await pipe.dispose()
        } catch {
          // Ignore dispose error
        }
      }
      if (attempt.device === 'webgpu') {
        webGpuFailed = true
      }
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Unable to load local ${TRANSLATOR_MODELS[modelKey].shortLabel} translation model.`)
}

// ---------------------------------------------------------------------------
// Structured Token Protection (Code Blocks, URLs, Nostr IDs, Cashu, Mentions)
// ---------------------------------------------------------------------------

const INLINE_PROTECTED_RE =
  /(`[^`\n]+`|\$\$[^$\n]+\$\$|\$[^$\n]+\$|https?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+|\bnostr:(?:npub|nsec|note|nprofile|nevent|naddr)1[02-9ac-hj-np-z]+\b|\b(?:npub|note|nprofile|nevent|naddr)1[02-9ac-hj-np-z]{20,}\b|\blnbc[a-z0-9]{20,}\b|\bcashu[AB][A-Za-z0-9_\-+=]{20,}\b|(?:^|(?<=\s))@[A-Za-z0-9_.\-#]+|(?:^|(?<=\s))#[A-Za-z0-9_-]+)/gi

const STRUCTURAL_LINE_PREFIX_RE = /^\s*(?:[-*+]\s|\d+[.)]\s|>\s|#{1,6}\s)/

interface ProtectedLine {
  leading: string
  prose: string
  trailing: string
  tokens: string[]
}

function protectLine(line: string): ProtectedLine {
  const leadingParts: string[] = []
  const trailingParts: string[] = []
  let work = line

  // Peel leading protected tokens verbatim so seq2seq never touches leading @mentions/#channels/URLs
  while (true) {
    const m = work.match(
      /^(\s*(?:`[^`\n]+`|https?:\/\/[^\s<>()]+|www\.[^\s<>()]+|nostr:(?:npub|nsec|note|nprofile|nevent|naddr)1[02-9ac-hj-np-z]+|(?:npub|note|nprofile|nevent|naddr)1[02-9ac-hj-np-z]{20,}|lnbc[a-z0-9]{20,}|cashu[AB][A-Za-z0-9_\-+=]{20,}|@[A-Za-z0-9_.\-#]+|#[A-Za-z0-9_-]+)\s*)/i
    )
    if (!m) break
    leadingParts.push(m[1])
    work = work.slice(m[1].length)
  }

  // Peel trailing protected tokens verbatim
  while (true) {
    const m = work.match(
      /(\s*(?:`[^`\n]+`|https?:\/\/[^\s<>()]+|www\.[^\s<>()]+|nostr:(?:npub|nsec|note|nprofile|nevent|naddr)1[02-9ac-hj-np-z]+|(?:npub|note|nprofile|nevent|naddr)1[02-9ac-hj-np-z]{20,}|lnbc[a-z0-9]{20,}|cashu[AB][A-Za-z0-9_\-+=]{20,}|(?:^|(?<=\s))@[A-Za-z0-9_.\-#]+|(?:^|(?<=\s))#[A-Za-z0-9_-]+)\s*)$/i
    )
    if (!m) break
    trailingParts.unshift(m[1])
    work = work.slice(0, work.length - m[1].length)
  }

  const tokens: string[] = []
  const prose = work.replace(INLINE_PROTECTED_RE, (match) => {
    const idx = tokens.length
    tokens.push(match)
    return `XZ${idx}ZX`
  })

  return {
    leading: leadingParts.join(''),
    prose: prose.trim(),
    trailing: trailingParts.join(''),
    tokens,
  }
}

function restoreLine(translatedProse: string, info: ProtectedLine): string {
  let restored = translatedProse
  const missing: string[] = []

  for (let i = 0; i < info.tokens.length; i++) {
    const token = info.tokens[i]
    const placeholderRe = new RegExp(`XZ\\s*${i}\\s*ZX`, 'gi')
    if (placeholderRe.test(restored)) {
      restored = restored.replace(placeholderRe, () => token)
    } else {
      missing.push(token)
    }
  }

  if (missing.length > 0) {
    restored = restored ? `${restored} ${missing.join(' ')}` : missing.join(' ')
  }

  return `${info.leading}${restored}${info.trailing}`.trim()
}

function splitLongProse(prose: string): string[] {
  if (prose.length <= MAX_SEGMENT_CHARS) return [prose]
  const sentences = prose.split(/(?<=[.!?。！？])\s+/)
  const chunks: string[] = []
  let current = ''
  for (const s of sentences) {
    const candidate = current ? `${current} ${s}` : s
    if (candidate.length <= MAX_SEGMENT_CHARS) {
      current = candidate
    } else {
      if (current) {
        chunks.push(current)
        current = ''
      }
      if (s.length <= MAX_SEGMENT_CHARS) {
        current = s
      } else {
        for (let i = 0; i < s.length; i += MAX_SEGMENT_CHARS) {
          chunks.push(s.slice(i, i + MAX_SEGMENT_CHARS))
        }
      }
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function resolveModelLangCode(handle: ActiveModelHandle, langInput: string): string {
  const resolved = resolveLanguageCodes(langInput)
  const desired = handle.modelKey === 'nllb200' ? resolved.nllbCode : resolved.m2mCode
  const supported = handle.pipe.tokenizer?.language_codes
  if (!supported || supported.length === 0 || supported.includes(desired)) {
    return desired
  }
  const fallback = handle.modelKey === 'nllb200' ? 'eng_Latn' : 'en'
  return supported.includes(fallback) ? fallback : supported[0]
}

function computeMaxNewTokens(chunk: string): number {
  if (COMPACT_SCRIPT_RE.test(chunk)) {
    return Math.min(200, Math.max(32, Math.ceil(chunk.length * 2.5) + 24))
  }
  return Math.min(192, Math.max(24, Math.ceil(chunk.length * 0.9) + 24))
}

async function translateProseChunk(
  handle: ActiveModelHandle,
  prose: string,
  srcCode: string,
  tgtCode: string,
  stoppingCriteria: InterruptableCriteriaLike | null
): Promise<string> {
  if (!prose.trim() || !/\p{L}/u.test(prose.replace(/XZ\d+ZX/g, ''))) {
    return prose
  }
  const chunks = splitLongProse(prose)
  const translatedParts: string[] = []
  // Strictly batch=1 sequential (batching corrupts M2M-100 attention & runs 4.4× slower)
  for (const chunk of chunks) {
    if (stoppingCriteria?.interrupted || activePreempted || activeCancelled) {
      return ''
    }
    const maxNewTokens = computeMaxNewTokens(chunk)
    const pipeOptions: Record<string, unknown> = {
      src_lang: srcCode,
      tgt_lang: tgtCode,
      num_beams: 1,
      max_new_tokens: maxNewTokens,
      repetition_penalty: 1.12,
      no_repeat_ngram_size: 4,
    }
    if (stoppingCriteria) {
      pipeOptions.stopping_criteria = stoppingCriteria
    }
    const out = await trackInference(() => handle.pipe(chunk, pipeOptions))
    if (stoppingCriteria?.interrupted || activePreempted || activeCancelled) {
      return ''
    }
    const result = extractTranslationText(out)
    translatedParts.push(result || chunk)
  }
  return translatedParts.join(' ')
}

async function translateOpusDirectProseChunk(
  handle: ActiveModelHandle,
  prose: string,
  stoppingCriteria: InterruptableCriteriaLike | null
): Promise<string> {
  if (!prose.trim() || !/\p{L}/u.test(prose.replace(/XZ\d+ZX/g, ''))) {
    return prose
  }
  const chunks = splitLongProse(prose)
  const translatedParts: string[] = []
  for (const chunk of chunks) {
    if (stoppingCriteria?.interrupted || activePreempted || activeCancelled) {
      return ''
    }
    const maxNewTokens = computeMaxNewTokens(chunk)
    const pipeOptions: Record<string, unknown> = {
      num_beams: 1,
      max_new_tokens: maxNewTokens,
      repetition_penalty: 1.12,
      no_repeat_ngram_size: 4,
    }
    if (stoppingCriteria) {
      pipeOptions.stopping_criteria = stoppingCriteria
    }
    const out = await trackInference(() => handle.pipe(chunk, pipeOptions))
    if (stoppingCriteria?.interrupted || activePreempted || activeCancelled) {
      return ''
    }
    const result = extractTranslationText(out)
    translatedParts.push(result || chunk)
  }
  return translatedParts.join(' ')
}

function lookupOpusEnMulLangTokenId(
  tokenizer: TokenizerLike,
  target: ResolvedLanguageCodes
): number | null {
  const candidates: string[] = [`>>${target.opusCode}<<`]
  if (target.opusCode.includes('_')) {
    candidates.push(`>>${target.opusCode.split('_')[0]}<<`)
  }
  const unkId = typeof tokenizer.unk_token_id === 'number' ? tokenizer.unk_token_id : -1
  for (const tag of candidates) {
    const id =
      tokenizer._tokenizer?.token_to_id?.(tag) ??
      tokenizer.convert_tokens_to_ids?.(tag)
    if (typeof id === 'number' && Number.isInteger(id) && id >= 0 && id !== unkId) {
      return id
    }
  }
  return null
}

/**
 * Translates via `Xenova/opus-mt-en-mul` by prepending the exact target language token ID
 * (e.g. `>>por<<`, `>>pol<<`, `>>tur<<`) directly onto `input_ids` — raw string prefixing
 * splits the tag into subwords and produces garbled output.
 */
async function translateOpusEnMulProseChunk(
  mod: typeof import('@huggingface/transformers'),
  handle: ActiveModelHandle,
  prose: string,
  target: ResolvedLanguageCodes,
  stoppingCriteria: InterruptableCriteriaLike | null
): Promise<string> {
  if (!prose.trim() || !/\p{L}/u.test(prose.replace(/XZ\d+ZX/g, ''))) {
    return prose
  }
  const tokenizer = handle.pipe.tokenizer
  const model = handle.pipe.model
  if (
    !tokenizer ||
    typeof tokenizer !== 'function' ||
    typeof tokenizer.batch_decode !== 'function' ||
    !model ||
    typeof model.generate !== 'function'
  ) {
    throw new Error('Opus-MT multilingual tokenizer/model interface is unavailable.')
  }

  const langTokenId = lookupOpusEnMulLangTokenId(tokenizer, target)
  if (langTokenId === null) {
    throw new Error(
      `Opus-MT Lite does not support translating into ${target.name}. Switch to M2M-100 or NLLB-200 in Settings → Translator.`
    )
  }

  const chunks = splitLongProse(prose)
  const translatedParts: string[] = []
  for (const chunk of chunks) {
    if (stoppingCriteria?.interrupted || activePreempted || activeCancelled) {
      return ''
    }
    const encoded = tokenizer(chunk, { padding: true, truncation: true })
    const origIds = Array.from(encoded.input_ids.data, (v) => BigInt(v))
    const nextIds = new BigInt64Array([BigInt(langTokenId), ...origIds])
    const nextMask = new BigInt64Array(nextIds.length).fill(1n)

    const input_ids = new mod.Tensor('int64', nextIds, [1, nextIds.length])
    const attention_mask = new mod.Tensor('int64', nextMask, [1, nextMask.length])
    const maxNewTokens = computeMaxNewTokens(chunk)

    const generateOpts: Record<string, unknown> = {
      input_ids,
      attention_mask,
      max_new_tokens: maxNewTokens,
      num_beams: 1,
      repetition_penalty: 1.12,
      no_repeat_ngram_size: 4,
    }
    if (stoppingCriteria) {
      generateOpts.stopping_criteria = stoppingCriteria
    }

    const outputTokenIds = await trackInference(() => model.generate!(generateOpts))
    if (stoppingCriteria?.interrupted || activePreempted || activeCancelled) {
      return ''
    }
    const decoded = tokenizer.batch_decode(outputTokenIds, { skip_special_tokens: true })
    const result = (Array.isArray(decoded) ? decoded[0] : decoded)?.trim() ?? ''
    translatedParts.push(result || chunk)
  }
  return translatedParts.join(' ')
}

function resolveSourceLanguageForMessage(
  text: string,
  cleanTarget: string,
  explicitSource?: string,
  roomHintLang?: string | null
): { sourceLang: string; alreadySameLanguage: boolean } {
  const explicitClean = explicitSource?.trim() ?? ''
  if (explicitClean && explicitClean.toLowerCase() !== 'auto') {
    return { sourceLang: explicitClean, alreadySameLanguage: false }
  }

  const targetResolved = resolveLanguageCodes(cleanTarget)
  const targetLower = cleanTarget.toLowerCase()
  const detected = detectLanguageDetailed(text)

  const detectedMatchesTarget =
    Boolean(detected.lang) &&
    (detected.lang!.toLowerCase() === targetLower ||
      resolveLanguageCodes(detected.lang!).nllbCode === targetResolved.nllbCode)

  const hintClean = roomHintLang?.trim() ?? ''
  const hintResolved =
    hintClean && hintClean.toLowerCase() !== 'auto'
      ? resolveLanguageCodes(hintClean)
      : null
  const hasValidForeignRoomHint = Boolean(
    hintResolved &&
      hintClean.toLowerCase() !== targetLower &&
      hintResolved.nllbCode !== targetResolved.nllbCode
  )

  if (hasValidForeignRoomHint) {
    // Same-language message in a foreign room (high or medium confidence): skip in 0 ms
    if (
      detectedMatchesTarget &&
      (detected.confidence === 'high' || detected.confidence === 'medium') &&
      detected.lang
    ) {
      return { sourceLang: detected.lang, alreadySameLanguage: true }
    }
    // Only override sticky room language to a DIFFERENT foreign language on HIGH confidence;
    // medium/low single-word cognates stick to roomHintLang to prevent model flip-flopping.
    if (detected.confidence === 'high' && detected.lang) {
      return { sourceLang: detected.lang, alreadySameLanguage: false }
    }
    return { sourceLang: hintClean, alreadySameLanguage: false }
  }

  if ((detected.confidence === 'high' || detected.confidence === 'medium') && detected.lang) {
    return {
      sourceLang: detected.lang,
      alreadySameLanguage: detectedMatchesTarget,
    }
  }

  if (detected.lang && !detectedMatchesTarget) {
    return { sourceLang: detected.lang, alreadySameLanguage: false }
  }

  if (targetResolved.m2mCode !== 'en') {
    return { sourceLang: 'English', alreadySameLanguage: false }
  }

  return { sourceLang: cleanTarget, alreadySameLanguage: true }
}

/**
 * Coalesces consecutive short plain-prose lines within a paragraph so wrapped chat
 * messages translate in a single ONNX pass, while preserving blank lines, lists,
 * blockquotes, headings, and lines anchored by leading/trailing protected tokens.
 */
function buildParagraphSegments(part: string): Array<{ kind: 'raw'; text: string } | { kind: 'prose'; line: string }> {
  const rawLines = part.split('\n')
  const segments: Array<{ kind: 'raw'; text: string } | { kind: 'prose'; line: string }> = []
  let proseBuffer = ''

  const flushBuffer = () => {
    if (proseBuffer) {
      segments.push({ kind: 'prose', line: proseBuffer })
      proseBuffer = ''
    }
  }

  for (const line of rawLines) {
    if (!line.trim()) {
      flushBuffer()
      segments.push({ kind: 'raw', text: line })
      continue
    }

    if (isNonTranslatableText(line)) {
      flushBuffer()
      segments.push({ kind: 'raw', text: line })
      continue
    }

    const isStructural = STRUCTURAL_LINE_PREFIX_RE.test(line)
    const protectedInfo = protectLine(line)
    const hasEdgeTokens = Boolean(protectedInfo.leading || protectedInfo.trailing)

    if (isStructural || hasEdgeTokens || line.length > 260) {
      flushBuffer()
      segments.push({ kind: 'prose', line })
      continue
    }

    if (proseBuffer && proseBuffer.length + 1 + line.trim().length <= 360) {
      proseBuffer = `${proseBuffer} ${line.trim()}`
    } else {
      flushBuffer()
      proseBuffer = line.trim()
    }
  }

  flushBuffer()
  return segments
}

async function translateStructuredText(
  text: string,
  translateProseFn: (prose: string) => Promise<string>,
  effectiveSource: string,
  stoppingCriteria: InterruptableCriteriaLike | null
): Promise<TranslationRunOutput> {
  // Split by fenced code blocks so code blocks stay 100% verbatim
  const fenceParts = text.split(/(```[\s\S]*?```)/g)
  const renderedParts: string[] = []

  for (let i = 0; i < fenceParts.length; i++) {
    if (stoppingCriteria?.interrupted || activePreempted || activeCancelled) {
      return {
        text: '',
        detectedSourceLang: effectiveSource,
        sameLanguage: false,
      }
    }
    const part = fenceParts[i]
    if (!part) continue
    if (part.startsWith('```') && part.endsWith('```')) {
      renderedParts.push(part)
      continue
    }

    const segments = buildParagraphSegments(part)
    const outLines: string[] = []
    for (const seg of segments) {
      if (stoppingCriteria?.interrupted || activePreempted || activeCancelled) {
        return {
          text: '',
          detectedSourceLang: effectiveSource,
          sameLanguage: false,
        }
      }
      if (seg.kind === 'raw') {
        outLines.push(seg.text)
        continue
      }
      const protectedLine = protectLine(seg.line)
      if (!protectedLine.prose) {
        outLines.push(seg.line)
        continue
      }
      const translatedProse = await translateProseFn(protectedLine.prose)
      if (stoppingCriteria?.interrupted || activePreempted || activeCancelled) {
        return {
          text: '',
          detectedSourceLang: effectiveSource,
          sameLanguage: false,
        }
      }
      outLines.push(restoreLine(translatedProse, protectedLine))
    }
    renderedParts.push(outLines.join('\n'))
  }

  return {
    text: renderedParts.join('').trim(),
    detectedSourceLang: effectiveSource,
    sameLanguage: false,
  }
}

async function runTranslation(
  handle: ActiveModelHandle,
  text: string,
  targetLang: string,
  sourceLang?: string,
  roomHintLang?: string | null,
  stoppingCriteria: InterruptableCriteriaLike | null = null
): Promise<TranslationRunOutput> {
  const cleanTarget = targetLang.trim() || 'English'
  const { sourceLang: effectiveSource, alreadySameLanguage } = resolveSourceLanguageForMessage(
    text,
    cleanTarget,
    sourceLang,
    roomHintLang
  )

  if (alreadySameLanguage) {
    return {
      text: text.trim(),
      detectedSourceLang: effectiveSource,
      sameLanguage: true,
    }
  }

  const srcCode = resolveModelLangCode(handle, effectiveSource)
  const tgtCode = resolveModelLangCode(handle, cleanTarget)

  // Already in target language: return original text immediately (0 ms, zero garbling!)
  if (srcCode === tgtCode) {
    return {
      text: text.trim(),
      detectedSourceLang: effectiveSource,
      sameLanguage: true,
    }
  }

  return await translateStructuredText(
    text,
    (prose) => translateProseChunk(handle, prose, srcCode, tgtCode, stoppingCriteria),
    effectiveSource,
    stoppingCriteria
  )
}

interface OpusTranslationRunOutput extends TranslationRunOutput {
  handle: ActiveModelHandle | null
}

function getOpusPairModelId(src: ResolvedLanguageCodes, tgt: ResolvedLanguageCodes): string {
  if (tgt.m2mCode === 'en') {
    return OPUS_TO_EN_MODELS[src.m2mCode] ?? OPUS_DEFAULT_TO_EN_MODEL
  }
  return OPUS_FROM_EN_MODELS[tgt.m2mCode] ?? OPUS_DEFAULT_FROM_EN_MODEL
}

function predictOpusModelIdsForJob(job: QueuedJob): string[] {
  if (job.type !== 'translate' || job.modelKey !== 'opus') return []
  const sourceText = job.text ?? ''
  if (!sourceText.trim()) return []
  const cleanTarget = (job.targetLang ?? 'English').trim() || 'English'
  const { sourceLang: effectiveSource, alreadySameLanguage } = resolveSourceLanguageForMessage(
    sourceText,
    cleanTarget,
    job.sourceLang,
    job.roomHintLang
  )
  if (alreadySameLanguage) return []
  const srcResolved = resolveLanguageCodes(effectiveSource)
  const tgtResolved = resolveLanguageCodes(cleanTarget)
  if (srcResolved.m2mCode === tgtResolved.m2mCode) return []
  if (srcResolved.m2mCode === 'en' || tgtResolved.m2mCode === 'en') {
    return [getOpusPairModelId(srcResolved, tgtResolved)]
  }
  return [
    getOpusPairModelId(srcResolved, ENGLISH_RESOLVED),
    getOpusPairModelId(ENGLISH_RESOLVED, tgtResolved),
  ]
}

async function runOpusSingleHop(
  mod: typeof import('@huggingface/transformers'),
  text: string,
  src: ResolvedLanguageCodes,
  tgt: ResolvedLanguageCodes,
  effectiveSource: string,
  stoppingCriteria: InterruptableCriteriaLike,
  protectedOpusModelId?: string
): Promise<OpusTranslationRunOutput> {
  const isToEnglish = tgt.m2mCode === 'en'
  const pairModelId = getOpusPairModelId(src, tgt)
  const useEnMulTag = !isToEnglish && pairModelId === OPUS_DEFAULT_FROM_EN_MODEL

  // Load/swap outside inference timeout so slow mobile downloads never spuriously time out
  const pairHandle = await ensureModel('opus', pairModelId, true, protectedOpusModelId)

  if (stoppingCriteria.interrupted || activePreempted || activeCancelled) {
    return {
      text: '',
      detectedSourceLang: effectiveSource,
      sameLanguage: false,
      handle: pairHandle,
    }
  }

  const out = await withTimeout(
    translateStructuredText(
      text,
      (prose) =>
        useEnMulTag
          ? translateOpusEnMulProseChunk(mod, pairHandle, prose, tgt, stoppingCriteria)
          : translateOpusDirectProseChunk(pairHandle, prose, stoppingCriteria),
      effectiveSource,
      stoppingCriteria
    ),
    INFERENCE_TIMEOUT_MS,
    'Translation timed out.',
    () => stoppingCriteria.interrupt()
  )

  return {
    ...out,
    handle: pairHandle,
  }
}

async function runOpusTranslation(
  mod: typeof import('@huggingface/transformers'),
  text: string,
  targetLang: string,
  sourceLang: string | undefined,
  roomHintLang: string | null | undefined,
  stoppingCriteria: InterruptableCriteriaLike
): Promise<OpusTranslationRunOutput> {
  const cleanTarget = targetLang.trim() || 'English'
  const { sourceLang: effectiveSource, alreadySameLanguage } = resolveSourceLanguageForMessage(
    text,
    cleanTarget,
    sourceLang,
    roomHintLang
  )

  if (alreadySameLanguage) {
    return {
      text: text.trim(),
      detectedSourceLang: effectiveSource,
      sameLanguage: true,
      handle: getLastActiveHandle('opus'),
    }
  }

  const srcResolved = resolveLanguageCodes(effectiveSource)
  const tgtResolved = resolveLanguageCodes(cleanTarget)

  // Already in target language: return original text immediately (0 ms, zero model swap!)
  if (srcResolved.m2mCode === tgtResolved.m2mCode) {
    return {
      text: text.trim(),
      detectedSourceLang: effectiveSource,
      sameLanguage: true,
      handle: getLastActiveHandle('opus'),
    }
  }

  // Direct hop when either endpoint is English
  if (srcResolved.m2mCode === 'en' || tgtResolved.m2mCode === 'en') {
    return await runOpusSingleHop(
      mod,
      text,
      srcResolved,
      tgtResolved,
      effectiveSource,
      stoppingCriteria
    )
  }

  // Clean 2-step English pivot (src -> en -> tgt): both hops stay hot in the 2-slot LRU RAM pool
  const hop1ModelId = getOpusPairModelId(srcResolved, ENGLISH_RESOLVED)
  const hop2ModelId = getOpusPairModelId(ENGLISH_RESOLVED, tgtResolved)

  const toEn = await runOpusSingleHop(
    mod,
    text,
    srcResolved,
    ENGLISH_RESOLVED,
    effectiveSource,
    stoppingCriteria,
    hop2ModelId
  )
  if (stoppingCriteria.interrupted || activePreempted || activeCancelled || !toEn.text) {
    return toEn
  }

  return await runOpusSingleHop(
    mod,
    toEn.text,
    ENGLISH_RESOLVED,
    tgtResolved,
    effectiveSource,
    stoppingCriteria,
    hop1ModelId
  )
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.()
          reject(new Error(label))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

function insertJobAtTierTail(job: QueuedJob): void {
  const rank = jobPriorityRank(job)
  const idx = queue.findIndex((item) => jobPriorityRank(item) > rank)
  if (idx === -1) queue.push(job)
  else queue.splice(idx, 0, job)
}

function requeuePreemptedJobAtTierFront(job: QueuedJob): void {
  const rank = jobPriorityRank(job)
  const idx = queue.findIndex((item) => jobPriorityRank(item) >= rank)
  if (idx === -1) queue.push(job)
  else queue.splice(idx, 0, job)
}

function enforceBackfillQueueCap(): void {
  // Never evict 'high' (outgoing) or 'live' (incoming) jobs — only evict lowest-priority backfill
  let backfillCount = 0
  for (const item of queue) {
    if (
      item.type === 'translate' &&
      (item.priority === 'visible' || item.priority === 'normal')
    ) {
      backfillCount += 1
    }
  }
  while (backfillCount > MAX_PENDING_NORMAL_JOBS) {
    let dropIdx = -1
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const item = queue[i]
      if (item.type === 'translate' && item.priority === 'normal') {
        dropIdx = i
        break
      }
    }
    if (dropIdx === -1) {
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const item = queue[i]
        if (item.type === 'translate' && item.priority === 'visible') {
          dropIdx = i
          break
        }
      }
    }
    if (dropIdx === -1) break
    const [dropped] = queue.splice(dropIdx, 1)
    backfillCount -= 1
    if (dropped) {
      postOut({ type: 'dropped', requestId: dropped.requestId })
    }
  }
}

function enqueueTranslateJob(job: QueuedJob): void {
  insertJobAtTierTail(job)
  if (job.priority === 'visible' || job.priority === 'normal') {
    enforceBackfillQueueCap()
  }
}

/**
 * Picks the next job while strictly preserving priority order:
 * `load (-1) > high (0) > live (1) > visible (2) > normal (3)`.
 * Only within the SAME backfill tier (`visible` or `normal`) for Opus-MT, prefers
 * the newest job whose required model(s) are already hot in `opusHandles` to avoid
 * thrashing if 3+ dedicated models are interleaved in history.
 */
function pickNextJobFromQueue(): QueuedJob | undefined {
  if (queue.length === 0) return undefined
  const head = queue[0]
  if (
    head.type !== 'translate' ||
    head.modelKey !== 'opus' ||
    (head.priority !== 'visible' && head.priority !== 'normal') ||
    opusHandles.size === 0
  ) {
    return queue.shift()
  }

  const headNeeds = predictOpusModelIdsForJob(head)
  if (headNeeds.every((id) => opusHandles.has(id))) {
    return queue.shift()
  }

  // Scan only the contiguous prefix of the exact same backfill priority tier
  for (let i = 1; i < queue.length; i += 1) {
    const candidate = queue[i]
    if (
      candidate.type !== 'translate' ||
      candidate.modelKey !== 'opus' ||
      candidate.priority !== head.priority
    ) {
      break
    }
    const needs = predictOpusModelIdsForJob(candidate)
    if (needs.every((id) => opusHandles.has(id))) {
      return queue.splice(i, 1)[0]
    }
  }

  return queue.shift()
}

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true
  try {
    while (queue.length > 0 && !disposePending) {
      const job = pickNextJobFromQueue()
      if (!job) continue
      activeJob = job
      activePreempted = false
      activeCancelled = cancelledRequestIds.delete(job.requestId)
      activeStoppingCriteria = null
      try {
        if (activeCancelled) {
          postOut({ type: 'dropped', requestId: job.requestId })
          continue
        }

        if (job.type === 'load') {
          let handle: ActiveModelHandle
          if (job.modelKey === 'opus' && opusHandles.has(job.modelId)) {
            // Already hot in LRU pool: promote to MRU and confirm ready in 0 ms
            handle = opusHandles.get(job.modelId)!
            opusHandles.delete(job.modelId)
            opusHandles.set(job.modelId, handle)
            lastActiveHandle = handle
            postOut({
              type: 'status',
              status: 'ready',
              modelKey: 'opus',
              modelId: handle.modelId,
              progress: 100,
              file: null,
              runtimeDevice: handle.device,
              dtype: handle.dtype,
            })
          } else if (
            job.modelKey === 'opus' &&
            job.modelId === OPUS_DEFAULT_TO_EN_MODEL &&
            opusHandles.size >= MAX_OPUS_RAM_HANDLES
          ) {
            // Never evict an actively used Opus pair just for a generic preload
            handle = getMruOpusHandle()!
            lastActiveHandle = handle
            postOut({
              type: 'status',
              status: 'ready',
              modelKey: 'opus',
              modelId: handle.modelId,
              progress: 100,
              file: null,
              runtimeDevice: handle.device,
              dtype: handle.dtype,
            })
          } else {
            handle = await ensureModel(job.modelKey, job.modelId)
          }

          if (activeCancelled || cancelledRequestIds.delete(job.requestId) || disposePending) {
            postOut({ type: 'dropped', requestId: job.requestId })
            continue
          }
          postOut({
            type: 'result',
            requestId: job.requestId,
            text: '',
            modelKey: handle.modelKey,
            modelId: handle.modelId,
            runtimeDevice: handle.device,
            dtype: handle.dtype,
          })
          continue
        }

        const sourceText = job.text ?? ''
        const targetLang = job.targetLang ?? 'English'
        if (!sourceText.trim()) {
          const fallbackHandle = getLastActiveHandle(job.modelKey)
          postOut({
            type: 'result',
            requestId: job.requestId,
            text: '',
            modelKey: job.modelKey,
            modelId: fallbackHandle?.modelId || job.modelId,
            runtimeDevice: fallbackHandle?.device ?? 'wasm',
            dtype: fallbackHandle?.dtype ?? 'q8',
            sameLanguage: true,
          })
          continue
        }

        if (job.modelKey === 'opus') {
          const mod = await getTransformersModule()
          const stoppingCriteria: InterruptableCriteriaLike =
            new mod.InterruptableStoppingCriteria()
          activeStoppingCriteria = stoppingCriteria

          if (activeCancelled || cancelledRequestIds.delete(job.requestId) || disposePending) {
            postOut({ type: 'dropped', requestId: job.requestId })
            continue
          }
          if (activePreempted) {
            requeuePreemptedJobAtTierFront(job)
            continue
          }

          const opusOut = await runOpusTranslation(
            mod,
            sourceText,
            targetLang,
            job.sourceLang,
            job.roomHintLang,
            stoppingCriteria
          )

          if (activeCancelled || cancelledRequestIds.delete(job.requestId) || disposePending) {
            postOut({ type: 'dropped', requestId: job.requestId })
            continue
          }
          if (activePreempted || stoppingCriteria.interrupted) {
            requeuePreemptedJobAtTierFront(job)
            continue
          }

          const resolvedHandle = opusOut.handle ?? getLastActiveHandle('opus')
          postOut({
            type: 'result',
            requestId: job.requestId,
            text: opusOut.text,
            modelKey: 'opus',
            modelId: resolvedHandle?.modelId || job.modelId,
            runtimeDevice: resolvedHandle?.device ?? 'wasm',
            dtype: resolvedHandle?.dtype ?? 'q8',
            detectedSourceLang: opusOut.detectedSourceLang,
            sameLanguage: opusOut.sameLanguage,
          })
          continue
        }

        const handle = await ensureModel(job.modelKey, job.modelId)

        if (activeCancelled || cancelledRequestIds.delete(job.requestId) || disposePending) {
          postOut({ type: 'dropped', requestId: job.requestId })
          continue
        }
        if (activePreempted) {
          requeuePreemptedJobAtTierFront(job)
          continue
        }

        const mod = await getTransformersModule()
        const stoppingCriteria: InterruptableCriteriaLike =
          new mod.InterruptableStoppingCriteria()
        activeStoppingCriteria = stoppingCriteria

        if (activeCancelled || cancelledRequestIds.delete(job.requestId) || disposePending) {
          postOut({ type: 'dropped', requestId: job.requestId })
          continue
        }
        if (activePreempted) {
          requeuePreemptedJobAtTierFront(job)
          continue
        }

        let runOut: TranslationRunOutput
        let finalHandle = handle
        try {
          runOut = await withTimeout(
            runTranslation(
              handle,
              sourceText,
              targetLang,
              job.sourceLang,
              job.roomHintLang,
              stoppingCriteria
            ),
            INFERENCE_TIMEOUT_MS,
            'Translation timed out.',
            () => stoppingCriteria.interrupt()
          )
        } catch (inferErr) {
          stoppingCriteria.interrupt()
          await waitForActiveInferenceUnwind()
          if (activeCancelled || cancelledRequestIds.delete(job.requestId) || disposePending) {
            postOut({ type: 'dropped', requestId: job.requestId })
            continue
          }
          if (activePreempted) {
            requeuePreemptedJobAtTierFront(job)
            continue
          }
          if (handle.device === 'webgpu') {
            webGpuFailed = true
            finalHandle = await ensureModel(job.modelKey, job.modelId, true)
            if (activeCancelled || cancelledRequestIds.delete(job.requestId) || disposePending) {
              postOut({ type: 'dropped', requestId: job.requestId })
              continue
            }
            if (activePreempted) {
              requeuePreemptedJobAtTierFront(job)
              continue
            }
            stoppingCriteria.reset()
            runOut = await withTimeout(
              runTranslation(
                finalHandle,
                sourceText,
                targetLang,
                job.sourceLang,
                job.roomHintLang,
                stoppingCriteria
              ),
              INFERENCE_TIMEOUT_MS,
              'Translation timed out.',
              () => stoppingCriteria.interrupt()
            )
          } else {
            throw inferErr
          }
        }

        if (activeCancelled || cancelledRequestIds.delete(job.requestId) || disposePending) {
          postOut({ type: 'dropped', requestId: job.requestId })
          continue
        }
        if (activePreempted || stoppingCriteria.interrupted) {
          requeuePreemptedJobAtTierFront(job)
          continue
        }

        postOut({
          type: 'result',
          requestId: job.requestId,
          text: runOut.text,
          modelKey: finalHandle.modelKey,
          modelId: finalHandle.modelId,
          runtimeDevice: finalHandle.device,
          dtype: finalHandle.dtype,
          detectedSourceLang: runOut.detectedSourceLang,
          sameLanguage: runOut.sameLanguage,
        })
      } catch (err) {
        activeStoppingCriteria?.interrupt()
        await waitForActiveInferenceUnwind()
        if (activeCancelled || cancelledRequestIds.delete(job.requestId) || disposePending) {
          postOut({ type: 'dropped', requestId: job.requestId })
          continue
        }
        if (activePreempted && job.type === 'translate') {
          requeuePreemptedJobAtTierFront(job)
          continue
        }
        const message = err instanceof Error ? err.message : 'Local translation failed.'
        if (job.type === 'load' || !hasLoadedHandleForModelKey(job.modelKey)) {
          postOut({
            type: 'status',
            status: 'error',
            modelKey: job.modelKey,
            modelId: job.modelId,
            error: message,
          })
        }
        postOut({
          type: 'error',
          requestId: job.requestId,
          kind: job.type,
          error: message,
        })
      } finally {
        if (activeInferencePromise) {
          activeStoppingCriteria?.interrupt()
          await waitForActiveInferenceUnwind()
        }
        if (activeJob?.requestId === job.requestId) {
          activeJob = null
          activeStoppingCriteria = null
          activePreempted = false
          activeCancelled = false
        }
      }
    }
  } finally {
    activeJob = null
    activeStoppingCriteria = null
    activePreempted = false
    activeCancelled = false
    if (disposePending) {
      disposePending = false
      closeYieldChannel()
      await disposeAllModels()
    }
    processing = false
  }
}

// Proactively reclaim legacy LFM3-1.7B-ONNX & broken M2M-100 q4f16 cache entries on startup
void evictLegacyCacheOnce()

self.onmessage = (event: MessageEvent<TranslatorWorkerInMessage>) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'dispose') {
    while (queue.length > 0) {
      const dropped = queue.shift()
      if (dropped) {
        postOut({ type: 'dropped', requestId: dropped.requestId })
      }
    }
    if (activeJob) {
      cancelledRequestIds.add(activeJob.requestId)
      activeCancelled = true
      activeStoppingCriteria?.interrupt()
    }
    if (processing) {
      // Defer disposal until processQueue unwinds the active WASM session.run() safely
      disposePending = true
    } else {
      closeYieldChannel()
      void disposeAllModels()
    }
    return
  }

  if (msg.type === 'cancelScope') {
    const keep = msg.keepScopeKey
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const item = queue[i]
      if (item.type !== 'translate' || item.priority === 'high') continue
      if (!keep || item.scopeKey !== keep) {
        queue.splice(i, 1)
        postOut({ type: 'dropped', requestId: item.requestId })
      }
    }
    if (
      activeJob &&
      activeJob.type === 'translate' &&
      activeJob.priority !== 'high' &&
      (!keep || activeJob.scopeKey !== keep)
    ) {
      cancelledRequestIds.add(activeJob.requestId)
      activeCancelled = true
      activeStoppingCriteria?.interrupt()
    }
    return
  }

  if (msg.type === 'load') {
    disposePending = false
    const modelKey = normalizeWorkerModelKey(msg.modelKey)
    insertJobAtTierTail({
      type: 'load',
      requestId: msg.requestId,
      modelKey,
      modelId: msg.modelId || TRANSLATOR_MODELS[modelKey].id,
      priority: 'high',
    })
    void processQueue()
    return
  }

  if (msg.type === 'translate') {
    disposePending = false
    const modelKey = normalizeWorkerModelKey(msg.modelKey)
    const job: QueuedJob = {
      type: 'translate',
      requestId: msg.requestId,
      modelKey,
      modelId: msg.modelId || TRANSLATOR_MODELS[modelKey].id,
      priority: msg.priority,
      text: msg.text,
      targetLang: msg.targetLang,
      sourceLang: msg.sourceLang,
      roomHintLang: msg.roomHintLang,
      scopeKey: msg.scopeKey,
    }
    enqueueTranslateJob(job)
    // Preempt active lower-priority translation mid-token when a higher-priority job arrives:
    // 'high' (outgoing send) interrupts 'live'/'visible'/'normal';
    // 'live' (incoming) interrupts 'visible'/'normal';
    // 'visible' interrupts 'normal'.
    if (
      activeJob &&
      activeJob.type === 'translate' &&
      jobPriorityRank(job) < jobPriorityRank(activeJob)
    ) {
      activePreempted = true
      activeStoppingCriteria?.interrupt()
    }
    void processQueue()
  }
}
