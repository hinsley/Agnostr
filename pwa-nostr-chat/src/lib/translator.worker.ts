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
      priority: 'high' | 'normal'
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
  priority: 'high' | 'normal'
  text?: string
  targetLang?: string
  sourceLang?: string
}

interface ActiveModelHandle {
  modelKey: TranslatorModelKey
  modelId: string
  device: TranslatorRuntimeDevice
  dtype: TranslatorModelDtype
  pipe: TranslationPipelineLike
}

const MAX_PENDING_NORMAL_JOBS = 48
const MAX_SEGMENT_CHARS = 900
const LEGACY_TRANSFORMERS_CACHE_KEY = 'transformers-cache'

// Verified encoder + decoder ONNX byte totals from HuggingFace live probe:
// M2M-100 q8: 274.5 + 328.2 = 602.7 MiB (~632 MB); q4f16: 333.7 + 361.6 = 695.3 MiB (~729 MB)
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

let transformersModulePromise: Promise<typeof import('@huggingface/transformers')> | null = null
let activeHandle: ActiveModelHandle | null = null
let webGpuFailed = false
let legacyEvictionStarted = false

const queue: QueuedJob[] = []
let processing = false

function postOut(msg: TranslatorWorkerOutMessage): void {
  self.postMessage(msg)
}

function isLegacyLfm3CacheUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return (
    lower.includes('lfm3-1.7b-onnx') ||
    lower.includes('lfm3%2d1.7b') ||
    lower.includes('onnx-community/lfm3') ||
    lower.includes('onnx-community%2flfm3')
  )
}

/**
 * Silently evicts legacy ~1.1–1.3 GB LFM3-1.7B-ONNX cache entries from both
 * `agnostr-translator-cache` and `transformers-cache` so users reclaim storage.
 */
async function evictLegacyLfm3CacheOnce(): Promise<void> {
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
        if (isLegacyLfm3CacheUrl(req.url)) {
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
      // Wait until both encoder + decoder ONNX chunks report totals before dropping the expected total floor
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
    if (
      percent !== lastPercent ||
      info.status === 'done' ||
      now - lastReportTs > 120
    ) {
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

async function ensureModel(
  rawModelKey: TranslatorModelKey,
  rawModelId: string,
  forceWasm = false
): Promise<ActiveModelHandle> {
  void evictLegacyLfm3CacheOnce()

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
  const gpu = await probeWebGpu()

  // Live-verified optimal dtype strategy:
  // - WebGPU w/ shader-f16: q4f16 (GPU MatMulNBits) with automatic fallback to WASM q8
  // - Otherwise: WASM q8 (602.7 MB M2M-100 / 853.2 MB NLLB-200 — never int8/q4 which are 1.1-2.2 GB!)
  const attempts: Array<{
    device: TranslatorRuntimeDevice
    dtype: TranslatorModelDtype
  }> = []

  if (!forceWasm && !webGpuFailed && gpu.available && gpu.hasFp16) {
    attempts.push({ device: 'webgpu', dtype: 'q4f16' })
  }
  attempts.push({ device: 'wasm', dtype: 'q8' })

  let lastErr: unknown = null
  for (const attempt of attempts) {
    try {
      const pipe = await createPipelineAttempt(
        mod,
        modelKey,
        modelId,
        attempt.device,
        attempt.dtype
      )
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
// Lightweight Deterministic Source Language Detection (Script + Latin Heuristics)
// ---------------------------------------------------------------------------

const TRADITIONAL_HAN_RE = /[體國臺學機時會來個點這為說們發與後經開關問進動對義無應當產車書長門東風雲龍電愛馬鳥魚麼]/g
const SIMPLIFIED_HAN_RE = /[体国台学机时会来个点这为说们发与后经开关问进动对义无应当产车书长门东风云龙电爱马鸟鱼么]/g

const LATIN_LANG_STOPWORDS: Record<string, ReadonlySet<string>> = {
  English: new Set([
    'the', 'and', 'you', 'that', 'this', 'with', 'for', 'are', 'have', 'not', 'but', 'what',
    'all', 'your', 'from', 'they', 'just', 'like', 'about', 'would', 'there', 'their', 'will',
    'can', 'how', 'when', 'where', 'hello', 'hey', 'thanks', 'thank', 'good', 'please', 'yes',
    'really', 'going', 'think', 'know', 'here', 'been', 'were', 'was', 'has', 'had', 'its',
    'dont', "don't", "it's", "i'm", "that's", "can't", "won't", 'because', 'should', 'could',
  ]),
  Spanish: new Set([
    'que', 'los', 'las', 'por', 'para', 'con', 'una', 'uno', 'pero', 'como', 'cómo', 'está',
    'estás', 'estoy', 'hola', 'gracias', 'amigo', 'buenos', 'buenas', 'días', 'tardes', 'noches',
    'porque', 'también', 'todo', 'todos', 'esta', 'este', 'eso', 'muy', 'bien', 'donde', 'dónde',
    'quien', 'quién', 'cuando', 'cuándo', 'tengo', 'tiene', 'tienes', 'hacer', 'puede', 'puedo',
    'quiero', 'algo', 'nada', 'siempre', 'nunca', 'ahora', 'aquí', 'mucho', 'más', 'sin', 'sobre',
  ]),
  French: new Set([
    'les', 'des', 'est', 'une', 'que', 'qui', 'dans', 'pour', 'pas', 'sur', 'avec', 'plus',
    'tout', 'mais', 'nous', 'vous', 'sont', 'être', 'avoir', 'faire', 'bonjour', 'salut', 'merci',
    'très', 'bien', 'aussi', 'comme', 'peut', 'veux', 'suis', 'chez', 'sans', 'donc', 'alors',
    'quand', 'comment', 'pourquoi', 'oui', 'non', "c'est", "j'ai", "n'est", "qu'il", 'toujours',
  ]),
  German: new Set([
    'der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'ein', 'eine', 'mit', 'auf', 'für',
    'von', 'den', 'dem', 'des', 'sich', 'auch', 'als', 'wie', 'aber', 'noch', 'nach', 'über',
    'bei', 'wir', 'ihr', 'sind', 'war', 'haben', 'wird', 'kann', 'hallo', 'danke', 'bitte',
    'geht', 'gut', 'sehr', 'hier', 'jetzt', 'oder', 'wenn', 'weil', 'schon', 'immer', 'nein',
  ]),
  Portuguese: new Set([
    'que', 'não', 'nao', 'com', 'uma', 'para', 'por', 'mais', 'como', 'mas', 'foi', 'são',
    'sao', 'está', 'esta', 'você', 'voce', 'tudo', 'bem', 'olá', 'ola', 'obrigado', 'obrigada',
    'muito', 'também', 'tambem', 'isso', 'aqui', 'agora', 'onde', 'quando', 'porque', 'tenho',
    'fazer', 'pode', 'posso', 'quero', 'ainda', 'então', 'entao', 'sempre', 'nunca', 'bom',
  ]),
  Italian: new Set([
    'che', 'non', 'per', 'con', 'una', 'sono', 'come', 'stai', 'ciao', 'grazie', 'prego',
    'questo', 'questa', 'quello', 'tutto', 'molto', 'bene', 'anche', 'perché', 'perche', 'dove',
    'quando', 'chi', 'cosa', 'fatto', 'fare', 'puoi', 'posso', 'voglio', 'sempre', 'ancora',
    'ora', 'qui', 'degli', 'della', 'delle', 'nel', 'nella', 'alla', 'dalla', 'buongiorno',
  ]),
  Dutch: new Set([
    'het', 'een', 'van', 'dat', 'niet', 'met', 'voor', 'zijn', 'maar', 'ook', 'aan', 'nog',
    'wel', 'naar', 'dan', 'wat', 'hoe', 'waar', 'wanneer', 'waarom', 'bedankt', 'dank', 'hallo',
    'goed', 'heel', 'veel', 'hier', 'jij', 'wij', 'zij', 'hebben', 'worden', 'kunnen', 'moeten',
  ]),
  Polish: new Set([
    'nie', 'jest', 'się', 'sie', 'jak', 'tak', 'ale', 'czy', 'dla', 'tym', 'tego', 'tylko',
    'bardzo', 'może', 'moze', 'gdzie', 'kiedy', 'cześć', 'czesc', 'dzięki', 'dzieki', 'proszę',
    'prosze', 'dobrze', 'tutaj', 'teraz', 'wszystko', 'jeszcze', 'już', 'juz', 'przez', 'które',
  ]),
  Turkish: new Set([
    'bir', 'bu', 've', 'için', 'icin', 'ile', 'ama', 'çok', 'cok', 'daha', 'gibi', 'kadar',
    'olan', 'olarak', 'var', 'yok', 'ben', 'sen', 'biz', 'siz', 'merhaba', 'selam', 'teşekkür',
    'tesekkur', 'teşekkürler', 'nasılsın', 'nasilsin', 'evet', 'hayır', 'hayir', 'şimdi', 'burada',
  ]),
  Vietnamese: new Set([
    'không', 'khong', 'của', 'cua', 'và', 'là', 'cho', 'một', 'mot', 'có', 'được', 'duoc',
    'trong', 'này', 'nay', 'những', 'nhung', 'người', 'nguoi', 'với', 'voi', 'bạn', 'ban',
    'tôi', 'toi', 'chào', 'chao', 'cảm', 'cam', 'ơn', 'rất', 'nhiều', 'nhieu', 'đang', 'sẽ',
  ]),
  Indonesian: new Set([
    'yang', 'dan', 'ini', 'itu', 'dengan', 'untuk', 'tidak', 'dari', 'pada', 'adalah', 'akan',
    'juga', 'bisa', 'ada', 'saya', 'kamu', 'kita', 'mereka', 'sudah', 'belum', 'halo', 'selamat',
    'terima', 'kasih', 'apa', 'kabar', 'baik', 'sangat', 'disini', 'sekarang', 'bagaimana',
  ]),
  Swedish: new Set([
    'och', 'det', 'att', 'som', 'inte', 'för', 'med', 'har', 'jag', 'han', 'hon', 'den',
    'till', 'men', 'var', 'kan', 'ska', 'hej', 'tack', 'bra', 'mycket', 'här', 'nu', 'hur',
    'vad', 'när', 'varför', 'också', 'eller', 'från', 'ett', 'alla', 'bara', 'vill',
  ]),
  Czech: new Set([
    'jsou', 'jsem', 'není', 'neni', 'ale', 'pro', 'jako', 'tak', 'byl', 'byla', 'být', 'byt',
    'který', 'ktery', 'která', 'ktera', 'když', 'kdyz', 'velmi', 'ahoj', 'děkuji', 'dekuji',
    'prosím', 'prosim', 'dobře', 'dobre', 'tady', 'teď', 'ted', 'kde', 'proč', 'proc', 'může',
  ]),
  Romanian: new Set([
    'este', 'sunt', 'care', 'pentru', 'dar', 'mai', 'din', 'sau', 'fost', 'când', 'cand',
    'dacă', 'daca', 'foarte', 'bine', 'bună', 'buna', 'salut', 'mulțumesc', 'multumesc',
    'acum', 'aici', 'unde', 'cum', 'toate', 'acest', 'această', 'aceasta', 'doar', 'poate',
  ]),
}

function stripNonProseForDetection(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/\bnostr:(?:npub|nsec|note|nprofile|nevent|naddr)1[02-9ac-hj-np-z]+\b/gi, ' ')
    .replace(/\b(?:npub|note|nprofile|nevent|naddr)1[02-9ac-hj-np-z]{20,}\b/gi, ' ')
    .replace(/\blnbc[a-z0-9]{20,}\b/gi, ' ')
    .replace(/\bcashu[AB][A-Za-z0-9_\-+=]{20,}\b/g, ' ')
    .replace(/(^|\s)@[A-Za-z0-9_.\-#]+/g, ' ')
    .replace(/(^|\s)#[A-Za-z0-9_-]+/g, ' ')
}

function detectSourceLanguage(text: string, targetLangName: string): string {
  const sample = stripNonProseForDetection(text).trim()
  if (!sample) return targetLangName

  // 1. Deterministic non-Latin Unicode script detection
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(sample)) return 'Japanese'
  if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(sample)) return 'Korean'
  if (/[\u4E00-\u9FFF]/.test(sample)) {
    const tradMatches = sample.match(TRADITIONAL_HAN_RE)?.length ?? 0
    const simpMatches = sample.match(SIMPLIFIED_HAN_RE)?.length ?? 0
    if (tradMatches > simpMatches) return 'Chinese (Traditional)'
    return 'Chinese (Simplified)'
  }
  if (/[\u0400-\u04FF]/.test(sample)) {
    return /[іїєґІЇЄҐ]/.test(sample) ? 'Ukrainian' : 'Russian'
  }
  if (/[\u0600-\u06FF]/.test(sample)) return 'Arabic'
  if (/[\u0900-\u097F]/.test(sample)) return 'Hindi'
  if (/[\u0E00-\u0E7F]/.test(sample)) return 'Thai'
  if (/[\u0370-\u03FF]/.test(sample)) return 'Greek'
  if (/[\u0590-\u05FF]/.test(sample)) return 'Hebrew'

  // 2. Latin diacritic + stopword scoring
  const scores: Record<string, number> = {}
  const addScore = (lang: string, pts: number) => {
    scores[lang] = (scores[lang] ?? 0) + pts
  }

  // Distinctive diacritics & punctuation
  if (/[¿¡ñÑ]/.test(sample)) addScore('Spanish', 5)
  if (/[áéíóúÁÉÍÓÚ]/.test(sample)) addScore('Spanish', 1)
  if (/[ãõÃÕ]/.test(sample)) addScore('Portuguese', 6)
  if (/[çÇ]/.test(sample)) {
    addScore('Portuguese', 1.5)
    addScore('French', 1.5)
    addScore('Turkish', 1.5)
  }
  if (/[œŒæÆêëîïûùàèçé]/i.test(sample) && /[àèùçœ]/i.test(sample)) addScore('French', 2.5)
  if (/[ß]/.test(sample)) addScore('German', 6)
  if (/[äöüÄÖÜ]/.test(sample)) addScore('German', 2)
  if (/[åÅ]/.test(sample)) addScore('Swedish', 6)
  if (/[łśźżćńąęŁŚŹŻĆŃĄĘ]/.test(sample)) addScore('Polish', 6)
  if (/[ğışİĞŞ]/.test(sample)) addScore('Turkish', 6)
  if (/[đĐơƠưƯạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/.test(sample)) {
    addScore('Vietnamese', 7)
  }
  if (/[řěůčšžďťňŘĚŮČŠŽĎŤŇ]/.test(sample)) addScore('Czech', 6)
  if (/[șțȘȚăĂîÎ]/.test(sample)) addScore('Romanian', 5)

  // Tokenize words (including contractions like don't / c'est)
  const words = sample.toLowerCase().match(/[\p{L}]+(?:'[\p{L}]+)?/gu) ?? []
  for (const word of words) {
    for (const [lang, dict] of Object.entries(LATIN_LANG_STOPWORDS)) {
      if (dict.has(word)) {
        addScore(lang, 2)
      }
    }
  }

  let bestLang = ''
  let bestScore = 0
  let secondScore = 0
  for (const [lang, sc] of Object.entries(scores)) {
    if (sc > bestScore) {
      secondScore = bestScore
      bestScore = sc
      bestLang = lang
    } else if (sc > secondScore) {
      secondScore = sc
    }
  }

  if (bestLang && bestScore >= 2 && bestScore > secondScore) {
    return bestLang
  }
  if (bestLang && bestScore >= 2) {
    // Tie-break: prefer target language if tied (avoids unnecessary re-translation)
    if ((scores[targetLangName] ?? 0) === bestScore) return targetLangName
    return bestLang
  }

  // Fallback for very short ASCII messages with no stopwords:
  // If user is reading in a non-English language, assume English; otherwise assume Spanish if non-ASCII, else English
  const targetResolved = resolveLanguageCodes(targetLangName)
  if (targetResolved.m2mCode !== 'en') {
    return 'English'
  }
  if (bestLang && bestScore > 0) {
    return bestLang
  }
  return 'English'
}

// ---------------------------------------------------------------------------
// Structured Token Protection (Code Blocks, URLs, Nostr IDs, Cashu, Mentions)
// ---------------------------------------------------------------------------

const INLINE_PROTECTED_RE =
  /(`[^`\n]+`|\$\$[^$\n]+\$\$|\$[^$\n]+\$|https?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+|\bnostr:(?:npub|nsec|note|nprofile|nevent|naddr)1[02-9ac-hj-np-z]+\b|\b(?:npub|note|nprofile|nevent|naddr)1[02-9ac-hj-np-z]{20,}\b|\blnbc[a-z0-9]{20,}\b|\bcashu[AB][A-Za-z0-9_\-+=]{20,}\b|(?:^|(?<=\s))@[A-Za-z0-9_.\-#]+|(?:^|(?<=\s))#[A-Za-z0-9_-]+)/gi

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

function resolveModelLangCode(
  handle: ActiveModelHandle,
  langInput: string
): string {
  const resolved = resolveLanguageCodes(langInput)
  const desired = handle.modelKey === 'nllb200' ? resolved.nllbCode : resolved.m2mCode
  const supported = handle.pipe.tokenizer?.language_codes
  if (!supported || supported.length === 0 || supported.includes(desired)) {
    return desired
  }
  const fallback = handle.modelKey === 'nllb200' ? 'eng_Latn' : 'en'
  return supported.includes(fallback) ? fallback : supported[0]
}

function extractTranslationText(
  out: TranslationOutputItemLike | TranslationOutputItemLike[]
): string {
  const first = Array.isArray(out) ? out[0] : out
  return typeof first?.translation_text === 'string' ? first.translation_text.trim() : ''
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
  for (const chunk of chunks) {
    const maxLength = Math.min(512, Math.max(96, Math.ceil(chunk.length * 2.5) + 48))
    const out = await handle.pipe(chunk, {
      src_lang: srcCode,
      tgt_lang: tgtCode,
      num_beams: 1,
      max_length: maxLength,
    })
    const result = extractTranslationText(out)
    translatedParts.push(result || chunk)
  }
  return translatedParts.join(' ')
}

async function runTranslation(
  handle: ActiveModelHandle,
  text: string,
  targetLang: string,
  sourceLang?: string
): Promise<string> {
  const cleanTarget = targetLang.trim() || 'English'
  const effectiveSource =
    sourceLang && sourceLang.trim() && sourceLang.trim().toLowerCase() !== 'auto'
      ? sourceLang.trim()
      : detectSourceLanguage(text, cleanTarget)

  const srcCode = resolveModelLangCode(handle, effectiveSource)
  const tgtCode = resolveModelLangCode(handle, cleanTarget)

  // Already in target language: return original text immediately (0 ms, zero garbling!)
  if (srcCode === tgtCode) {
    return text.trim()
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

    const lines = part.split('\n')
    const outLines: string[] = []
    for (const line of lines) {
      if (!line.trim()) {
        outLines.push(line)
        continue
      }
      const protectedLine = protectLine(line)
      if (!protectedLine.prose) {
        outLines.push(line)
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

  return renderedParts.join('').trim()
}

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true
  try {
    while (queue.length > 0) {
      const job = queue.shift()
      if (!job) continue
      try {
        const handle = await ensureModel(job.modelKey, job.modelId)
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
          })
          continue
        }

        let translatedText: string
        let finalHandle = handle
        try {
          translatedText = await runTranslation(
            handle,
            sourceText,
            targetLang,
            job.sourceLang
          )
        } catch (inferErr) {
          if (handle.device === 'webgpu') {
            webGpuFailed = true
            finalHandle = await ensureModel(job.modelKey, job.modelId, true)
            translatedText = await runTranslation(
              finalHandle,
              sourceText,
              targetLang,
              job.sourceLang
            )
          } else {
            throw inferErr
          }
        }

        postOut({
          type: 'result',
          requestId: job.requestId,
          text: translatedText,
          modelKey: finalHandle.modelKey,
          modelId: finalHandle.modelId,
          runtimeDevice: finalHandle.device,
          dtype: finalHandle.dtype,
        })
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Local translation failed.'
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
      }
    }
  } finally {
    processing = false
  }
}

// Proactively reclaim ~1.1 GB of legacy LFM3-1.7B-ONNX cache entries on worker startup
void evictLegacyLfm3CacheOnce()

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
    void disposeActiveModel()
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
    }

    if (msg.priority === 'high') {
      // Jump ahead of queued background incoming-message translations so outgoing send feels instant
      const firstNormalIdx = queue.findIndex((item) => item.priority === 'normal')
      if (firstNormalIdx === -1) {
        queue.push(job)
      } else {
        queue.splice(firstNormalIdx, 0, job)
      }
    } else {
      let normalCount = 0
      for (const item of queue) {
        if (item.priority === 'normal') normalCount += 1
      }
      while (normalCount >= MAX_PENDING_NORMAL_JOBS) {
        const dropIdx = queue.findIndex((item) => item.priority === 'normal')
        if (dropIdx === -1) break
        const [dropped] = queue.splice(dropIdx, 1)
        normalCount -= 1
        if (dropped) {
          postOut({ type: 'dropped', requestId: dropped.requestId })
        }
      }
      queue.push(job)
    }

    void processQueue()
  }
}
