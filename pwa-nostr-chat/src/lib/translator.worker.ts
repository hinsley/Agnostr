/// <reference lib="webworker" />

import {
  DEFAULT_TRANSLATOR_MODEL_KEY,
  resolveLanguageCodes,
  TRANSLATOR_CACHE_KEY,
  TRANSLATOR_MODELS,
  type TranslatorModelDtype,
  type TranslatorModelKey,
  type TranslatorModelStatus,
  type TranslatorRuntimeDevice,
} from '../types/translator.ts'
import { detectLanguageDetailed, isNonTranslatableText } from './languageDetect.ts'

export type TranslatorJobPriority = 'high' | 'visible' | 'normal'

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

interface TranslationPipelineLike {
  (
    text: string,
    options?: Record<string, unknown>
  ): Promise<TranslationOutputItemLike | TranslationOutputItemLike[]>
  tokenizer?: {
    language_codes?: string[]
  }
  dispose?: () => Promise<void>
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
const INFERENCE_TIMEOUT_MS = 30_000
const LEGACY_TRANSFORMERS_CACHE_KEY = 'transformers-cache'

// Verified encoder + decoder ONNX byte totals from HuggingFace live probe:
// M2M-100 q8: 274.5 + 328.2 = 602.7 MiB (~632 MB)
// NLLB-200 q8: 399.7 + 453.5 = 853.2 MiB (~895 MB); q4f16: 583.9 + 611.9 = 1,195.9 MiB (~1,254 MB)
const EXPECTED_MODEL_BYTES: Record<TranslatorModelKey, Record<TranslatorModelDtype, number>> = {
  m2m100: {
    q8: 632_000_000,
    q4f16: 729_000_000,
  },
  nllb200: {
    q8: 895_000_000,
    q4f16: 1_254_000_000,
  },
}

const COMPACT_SCRIPT_RE = /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\u0E00-\u0E7F]/

let transformersModulePromise: Promise<typeof import('@huggingface/transformers')> | null = null
let activeHandle: ActiveModelHandle | null = null
let webGpuFailed = false
let legacyEvictionStarted = false

const queue: QueuedJob[] = []
const cancelledRequestIds = new Set<string>()
let activeJob: QueuedJob | null = null
let processing = false

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

async function disposeActiveModel(): Promise<void> {
  const prev = activeHandle
  activeHandle = null
  if (!prev) return
  if (typeof prev.pipe.dispose === 'function') {
    try {
      await prev.pipe.dispose()
    } catch {
      // Ignore disposal errors
    }
  }
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
  forceWasm = false
): Promise<ActiveModelHandle> {
  void evictLegacyCacheOnce()

  const modelKey: TranslatorModelKey =
    rawModelKey === 'nllb200' ? 'nllb200' : DEFAULT_TRANSLATOR_MODEL_KEY
  const modelId = rawModelId || TRANSLATOR_MODELS[modelKey].id

  if (
    activeHandle &&
    activeHandle.modelKey === modelKey &&
    activeHandle.modelId === modelId &&
    (!forceWasm || activeHandle.device === 'wasm')
  ) {
    return activeHandle
  }

  await disposeActiveModel()

  const mod = await getTransformersModule()

  // Empirically verified runtime matrix:
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
      activeHandle = {
        modelKey,
        modelId,
        device: attempt.device,
        dtype: attempt.dtype,
        pipe,
      }
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
      return activeHandle
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
  tgtCode: string
): Promise<string> {
  if (!prose.trim() || !/\p{L}/u.test(prose.replace(/XZ\d+ZX/g, ''))) {
    return prose
  }
  const chunks = splitLongProse(prose)
  const translatedParts: string[] = []
  // Strictly batch=1 sequential (batching corrupts M2M-100 attention & runs 4.4× slower)
  for (const chunk of chunks) {
    const maxNewTokens = computeMaxNewTokens(chunk)
    const out = await handle.pipe(chunk, {
      src_lang: srcCode,
      tgt_lang: tgtCode,
      num_beams: 1,
      max_new_tokens: maxNewTokens,
      repetition_penalty: 1.12,
      no_repeat_ngram_size: 4,
    })
    const result = extractTranslationText(out)
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

  if ((detected.confidence === 'high' || detected.confidence === 'medium') && detected.lang) {
    return { sourceLang: detected.lang, alreadySameLanguage: false }
  }

  const hintClean = roomHintLang?.trim() ?? ''
  if (hintClean && hintClean.toLowerCase() !== 'auto') {
    const hintResolved = resolveLanguageCodes(hintClean)
    if (
      hintClean.toLowerCase() !== targetLower &&
      hintResolved.nllbCode !== targetResolved.nllbCode
    ) {
      return { sourceLang: hintClean, alreadySameLanguage: false }
    }
  }

  if (detected.lang && detected.lang.toLowerCase() !== targetLower) {
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

async function runTranslation(
  handle: ActiveModelHandle,
  text: string,
  targetLang: string,
  sourceLang?: string,
  roomHintLang?: string | null
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

  // Split by fenced code blocks so code blocks stay 100% verbatim
  const fenceParts = text.split(/(```[\s\S]*?```)/g)
  const renderedParts: string[] = []

  for (let i = 0; i < fenceParts.length; i++) {
    const part = fenceParts[i]
    if (!part) continue
    if (part.startsWith('```') && part.endsWith('```')) {
      renderedParts.push(part)
      continue
    }

    const segments = buildParagraphSegments(part)
    const outLines: string[] = []
    for (const seg of segments) {
      if (seg.kind === 'raw') {
        outLines.push(seg.text)
        continue
      }
      const protectedLine = protectLine(seg.line)
      if (!protectedLine.prose) {
        outLines.push(seg.line)
        continue
      }
      const translatedProse = await translateProseChunk(
        handle,
        protectedLine.prose,
        srcCode,
        tgtCode
      )
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
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

function priorityRank(priority: TranslatorJobPriority): number {
  if (priority === 'high') return 0
  if (priority === 'visible') return 1
  return 2
}

function enqueueTranslateJob(job: QueuedJob): void {
  const rank = priorityRank(job.priority)
  if (rank === 0) {
    const idx = queue.findIndex((item) => item.type !== 'load' && priorityRank(item.priority) > 0)
    if (idx === -1) queue.push(job)
    else queue.splice(idx, 0, job)
    return
  }

  if (rank === 1) {
    const idx = queue.findIndex((item) => item.type !== 'load' && priorityRank(item.priority) > 1)
    if (idx === -1) queue.push(job)
    else queue.splice(idx, 0, job)
  } else {
    queue.push(job)
  }

  // Enforce bounded background queue (prefer dropping oldest 'normal' job first, never 'high')
  let nonHighCount = 0
  for (const item of queue) {
    if (item.type === 'translate' && item.priority !== 'high') {
      nonHighCount += 1
    }
  }
  while (nonHighCount > MAX_PENDING_NORMAL_JOBS) {
    let dropIdx = queue.findIndex(
      (item) => item.type === 'translate' && item.priority === 'normal'
    )
    if (dropIdx === -1) {
      dropIdx = queue.findIndex(
        (item) => item.type === 'translate' && item.priority === 'visible'
      )
    }
    if (dropIdx === -1) break
    const [dropped] = queue.splice(dropIdx, 1)
    nonHighCount -= 1
    if (dropped) {
      postOut({ type: 'dropped', requestId: dropped.requestId })
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
      activeJob = job
      try {
        if (cancelledRequestIds.delete(job.requestId)) {
          postOut({ type: 'dropped', requestId: job.requestId })
          continue
        }

        const handle = await ensureModel(job.modelKey, job.modelId)

        if (cancelledRequestIds.delete(job.requestId)) {
          postOut({ type: 'dropped', requestId: job.requestId })
          continue
        }

        if (job.type === 'load') {
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
          postOut({
            type: 'result',
            requestId: job.requestId,
            text: '',
            modelKey: handle.modelKey,
            modelId: handle.modelId,
            runtimeDevice: handle.device,
            dtype: handle.dtype,
            sameLanguage: true,
          })
          continue
        }

        let runOut: TranslationRunOutput
        let finalHandle = handle
        try {
          runOut = await withTimeout(
            runTranslation(handle, sourceText, targetLang, job.sourceLang, job.roomHintLang),
            INFERENCE_TIMEOUT_MS,
            'Translation timed out.'
          )
        } catch (inferErr) {
          if (handle.device === 'webgpu') {
            webGpuFailed = true
            finalHandle = await ensureModel(job.modelKey, job.modelId, true)
            if (cancelledRequestIds.delete(job.requestId)) {
              postOut({ type: 'dropped', requestId: job.requestId })
              continue
            }
            runOut = await withTimeout(
              runTranslation(
                finalHandle,
                sourceText,
                targetLang,
                job.sourceLang,
                job.roomHintLang
              ),
              INFERENCE_TIMEOUT_MS,
              'Translation timed out.'
            )
          } else {
            throw inferErr
          }
        }

        if (cancelledRequestIds.delete(job.requestId)) {
          postOut({ type: 'dropped', requestId: job.requestId })
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
        if (cancelledRequestIds.delete(job.requestId)) {
          postOut({ type: 'dropped', requestId: job.requestId })
          continue
        }
        const message = err instanceof Error ? err.message : 'Local translation failed.'
        if (job.type === 'load' || !activeHandle) {
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
        if (activeJob?.requestId === job.requestId) {
          activeJob = null
        }
      }
    }
  } finally {
    activeJob = null
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
    }
    void disposeActiveModel()
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
    }
    return
  }

  if (msg.type === 'load') {
    const modelKey: TranslatorModelKey =
      msg.modelKey === 'nllb200' ? 'nllb200' : DEFAULT_TRANSLATOR_MODEL_KEY
    queue.unshift({
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
    const modelKey: TranslatorModelKey =
      msg.modelKey === 'nllb200' ? 'nllb200' : DEFAULT_TRANSLATOR_MODEL_KEY
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
    void processQueue()
  }
}
