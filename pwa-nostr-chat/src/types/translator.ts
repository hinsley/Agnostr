export type TranslatorModelKey = 'opus' | 'm2m100' | 'nllb200'

export interface TranslatorModelOption {
  key: TranslatorModelKey
  id: string
  label: string
  shortLabel: string
  sizeHint: string
  description: string
}

export const TRANSLATOR_MODELS: Record<TranslatorModelKey, TranslatorModelOption> = {
  opus: {
    key: 'opus',
    id: 'Xenova/opus-mt-mul-en',
    label: 'Opus-MT Lite',
    shortLabel: 'Opus-MT',
    sizeHint: '~107 MB per language pair (WASM q8)',
    description: 'Fast, lightweight translation (~107 MB/pair, Default)',
  },
  m2m100: {
    key: 'm2m100',
    id: 'Xenova/m2m100_418M',
    label: 'M2M-100 (418M)',
    shortLabel: 'M2M-100',
    sizeHint: '~603 MB (WASM q8)',
    description: '100-language all-in-one model (~603 MB)',
  },
  nllb200: {
    key: 'nllb200',
    id: 'Xenova/nllb-200-distilled-600M',
    label: 'NLLB-200 (600M)',
    shortLabel: 'NLLB-200',
    sizeHint: '~853 MB (WASM) / ~1.2 GB (WebGPU)',
    description: 'Higher-quality 200-language translation',
  },
}

export const DEFAULT_TRANSLATOR_MODEL_KEY: TranslatorModelKey = 'opus'

export function getDefaultTranslatorModelKey(): TranslatorModelKey {
  return DEFAULT_TRANSLATOR_MODEL_KEY
}

export const TRANSLATOR_MODEL_ID = TRANSLATOR_MODELS.opus.id
export const TRANSLATOR_MODEL_LABEL = TRANSLATOR_MODELS.opus.label
export const TRANSLATOR_MODEL_SIZE_HINT = TRANSLATOR_MODELS.opus.sizeHint
export const TRANSLATOR_CACHE_KEY = 'agnostr-translator-cache' as const

/**
 * Dedicated `<src> -> en` Opus-MT pairs ONLY for languages where multilingual
 * `Xenova/opus-mt-mul-en` fails or underperforms (live-verified: Korean collapses
 * on `mul-en`, and dedicated `ja-en`/`zh-en` significantly improve CJK fidelity).
 * All other languages (es, fr, de, it, pt, nl, pl, ru, uk, tr, sv, cs, id, vi,
 * ar, hi, th, etc.) consolidate onto `Xenova/opus-mt-mul-en` for zero-swap
 * translation across mixed/global rooms.
 */
export const OPUS_TO_EN_MODELS: Readonly<Record<string, string>> = {
  ja: 'Xenova/opus-mt-ja-en',
  ko: 'Xenova/opus-mt-ko-en',
  zh: 'Xenova/opus-mt-zh-en',
}

export const OPUS_FROM_EN_MODELS: Readonly<Record<string, string>> = {
  es: 'Xenova/opus-mt-en-es',
  fr: 'Xenova/opus-mt-en-fr',
  de: 'Xenova/opus-mt-en-de',
  it: 'Xenova/opus-mt-en-it',
  ja: 'Xenova/opus-mt-en-jap',
  zh: 'Xenova/opus-mt-en-zh',
  ru: 'Xenova/opus-mt-en-ru',
  ar: 'Xenova/opus-mt-en-ar',
  hi: 'Xenova/opus-mt-en-hi',
  nl: 'Xenova/opus-mt-en-nl',
  vi: 'Xenova/opus-mt-en-vi',
  id: 'Xenova/opus-mt-en-id',
  sv: 'Xenova/opus-mt-en-sv',
  cs: 'Xenova/opus-mt-en-cs',
  uk: 'Xenova/opus-mt-en-uk',
  ro: 'Xenova/opus-mt-en-ro',
}

export const OPUS_DEFAULT_TO_EN_MODEL = 'Xenova/opus-mt-mul-en'
export const OPUS_DEFAULT_FROM_EN_MODEL = 'Xenova/opus-mt-en-mul'

export interface TranslationLanguageOption {
  name: string
  nativeName: string
  code: string
  /** Verified ISO language code for Xenova/m2m100_418M */
  m2mCode: string
  /** Verified FLORES-200 language code for Xenova/nllb-200-distilled-600M */
  nllbCode: string
  /** Verified Opus-MT `en-mul` target tag code (used as `>>${opusCode}<<`) */
  opusCode: string
}

export const TRANSLATION_LANGUAGE_OPTIONS: readonly TranslationLanguageOption[] = [
  { name: 'English', nativeName: 'English', code: 'en', m2mCode: 'en', nllbCode: 'eng_Latn', opusCode: 'eng' },
  { name: 'Spanish', nativeName: 'Español', code: 'es', m2mCode: 'es', nllbCode: 'spa_Latn', opusCode: 'spa' },
  { name: 'French', nativeName: 'Français', code: 'fr', m2mCode: 'fr', nllbCode: 'fra_Latn', opusCode: 'fra' },
  { name: 'German', nativeName: 'Deutsch', code: 'de', m2mCode: 'de', nllbCode: 'deu_Latn', opusCode: 'deu' },
  { name: 'Portuguese', nativeName: 'Português', code: 'pt', m2mCode: 'pt', nllbCode: 'por_Latn', opusCode: 'por' },
  { name: 'Italian', nativeName: 'Italiano', code: 'it', m2mCode: 'it', nllbCode: 'ita_Latn', opusCode: 'ita' },
  { name: 'Japanese', nativeName: '日本語', code: 'ja', m2mCode: 'ja', nllbCode: 'jpn_Jpan', opusCode: 'jpn' },
  { name: 'Korean', nativeName: '한국어', code: 'ko', m2mCode: 'ko', nllbCode: 'kor_Hang', opusCode: 'kor' },
  {
    name: 'Chinese (Simplified)',
    nativeName: '简体中文',
    code: 'zh-Hans',
    m2mCode: 'zh',
    nllbCode: 'zho_Hans',
    opusCode: 'cmn_Hans',
  },
  {
    name: 'Chinese (Traditional)',
    nativeName: '繁體中文',
    code: 'zh-Hant',
    m2mCode: 'zh',
    nllbCode: 'zho_Hant',
    opusCode: 'cmn_Hant',
  },
  { name: 'Russian', nativeName: 'Русский', code: 'ru', m2mCode: 'ru', nllbCode: 'rus_Cyrl', opusCode: 'rus' },
  { name: 'Arabic', nativeName: 'العربية', code: 'ar', m2mCode: 'ar', nllbCode: 'arb_Arab', opusCode: 'ara' },
  { name: 'Hindi', nativeName: 'हिन्दी', code: 'hi', m2mCode: 'hi', nllbCode: 'hin_Deva', opusCode: 'hin' },
  { name: 'Dutch', nativeName: 'Nederlands', code: 'nl', m2mCode: 'nl', nllbCode: 'nld_Latn', opusCode: 'nld' },
  { name: 'Polish', nativeName: 'Polski', code: 'pl', m2mCode: 'pl', nllbCode: 'pol_Latn', opusCode: 'pol' },
  { name: 'Turkish', nativeName: 'Türkçe', code: 'tr', m2mCode: 'tr', nllbCode: 'tur_Latn', opusCode: 'tur' },
  { name: 'Ukrainian', nativeName: 'Українська', code: 'uk', m2mCode: 'uk', nllbCode: 'ukr_Cyrl', opusCode: 'ukr' },
  { name: 'Vietnamese', nativeName: 'Tiếng Việt', code: 'vi', m2mCode: 'vi', nllbCode: 'vie_Latn', opusCode: 'vie' },
  { name: 'Thai', nativeName: 'ไทย', code: 'th', m2mCode: 'th', nllbCode: 'tha_Thai', opusCode: 'tha' },
  {
    name: 'Indonesian',
    nativeName: 'Bahasa Indonesia',
    code: 'id',
    m2mCode: 'id',
    nllbCode: 'ind_Latn',
    opusCode: 'ind',
  },
  { name: 'Swedish', nativeName: 'Svenska', code: 'sv', m2mCode: 'sv', nllbCode: 'swe_Latn', opusCode: 'swe' },
  { name: 'Czech', nativeName: 'Čeština', code: 'cs', m2mCode: 'cs', nllbCode: 'ces_Latn', opusCode: 'ces' },
  { name: 'Greek', nativeName: 'Ελληνικά', code: 'el', m2mCode: 'el', nllbCode: 'ell_Grek', opusCode: 'ell' },
  { name: 'Hebrew', nativeName: 'עברית', code: 'he', m2mCode: 'he', nllbCode: 'heb_Hebr', opusCode: 'heb' },
  { name: 'Romanian', nativeName: 'Română', code: 'ro', m2mCode: 'ro', nllbCode: 'ron_Latn', opusCode: 'ron' },
] as const

/**
 * Curated list of supported translation languages (freeform custom language names/codes are also accepted).
 */
export const SUPPORTED_TRANSLATION_LANGUAGES: readonly string[] =
  TRANSLATION_LANGUAGE_OPTIONS.map((opt) => opt.name)

export interface ResolvedLanguageCodes {
  name: string
  m2mCode: string
  nllbCode: string
  opusCode: string
}

const EXTRA_LANGUAGE_ALIASES: Record<string, ResolvedLanguageCodes> = {
  chinese: { name: 'Chinese (Simplified)', m2mCode: 'zh', nllbCode: 'zho_Hans', opusCode: 'cmn_Hans' },
  mandarin: { name: 'Chinese (Simplified)', m2mCode: 'zh', nllbCode: 'zho_Hans', opusCode: 'cmn_Hans' },
  zh: { name: 'Chinese (Simplified)', m2mCode: 'zh', nllbCode: 'zho_Hans', opusCode: 'cmn_Hans' },
  'zh-cn': { name: 'Chinese (Simplified)', m2mCode: 'zh', nllbCode: 'zho_Hans', opusCode: 'cmn_Hans' },
  'zh-tw': { name: 'Chinese (Traditional)', m2mCode: 'zh', nllbCode: 'zho_Hant', opusCode: 'cmn_Hant' },
  'zh-hk': { name: 'Chinese (Traditional)', m2mCode: 'zh', nllbCode: 'zho_Hant', opusCode: 'cmn_Hant' },
  cantonese: { name: 'Chinese (Traditional)', m2mCode: 'zh', nllbCode: 'zho_Hant', opusCode: 'cmn_Hant' },
  espanol: { name: 'Spanish', m2mCode: 'es', nllbCode: 'spa_Latn', opusCode: 'spa' },
  castilian: { name: 'Spanish', m2mCode: 'es', nllbCode: 'spa_Latn', opusCode: 'spa' },
  francais: { name: 'French', m2mCode: 'fr', nllbCode: 'fra_Latn', opusCode: 'fra' },
  portugues: { name: 'Portuguese', m2mCode: 'pt', nllbCode: 'por_Latn', opusCode: 'por' },
  'brazilian portuguese': { name: 'Portuguese', m2mCode: 'pt', nllbCode: 'por_Latn', opusCode: 'por' },
  'pt-br': { name: 'Portuguese', m2mCode: 'pt', nllbCode: 'por_Latn', opusCode: 'por' },
  farsi: { name: 'Persian', m2mCode: 'fa', nllbCode: 'pes_Arab', opusCode: 'pes' },
  persian: { name: 'Persian', m2mCode: 'fa', nllbCode: 'pes_Arab', opusCode: 'pes' },
  fa: { name: 'Persian', m2mCode: 'fa', nllbCode: 'pes_Arab', opusCode: 'pes' },
  tagalog: { name: 'Tagalog', m2mCode: 'tl', nllbCode: 'tgl_Latn', opusCode: 'tgl' },
  filipino: { name: 'Tagalog', m2mCode: 'tl', nllbCode: 'tgl_Latn', opusCode: 'tgl' },
  tl: { name: 'Tagalog', m2mCode: 'tl', nllbCode: 'tgl_Latn', opusCode: 'tgl' },
  danish: { name: 'Danish', m2mCode: 'da', nllbCode: 'dan_Latn', opusCode: 'dan' },
  dansk: { name: 'Danish', m2mCode: 'da', nllbCode: 'dan_Latn', opusCode: 'dan' },
  da: { name: 'Danish', m2mCode: 'da', nllbCode: 'dan_Latn', opusCode: 'dan' },
  norwegian: { name: 'Norwegian', m2mCode: 'no', nllbCode: 'nob_Latn', opusCode: 'nob' },
  norsk: { name: 'Norwegian', m2mCode: 'no', nllbCode: 'nob_Latn', opusCode: 'nob' },
  no: { name: 'Norwegian', m2mCode: 'no', nllbCode: 'nob_Latn', opusCode: 'nob' },
  nb: { name: 'Norwegian', m2mCode: 'no', nllbCode: 'nob_Latn', opusCode: 'nob' },
  finnish: { name: 'Finnish', m2mCode: 'fi', nllbCode: 'fin_Latn', opusCode: 'fin' },
  suomi: { name: 'Finnish', m2mCode: 'fi', nllbCode: 'fin_Latn', opusCode: 'fin' },
  fi: { name: 'Finnish', m2mCode: 'fi', nllbCode: 'fin_Latn', opusCode: 'fin' },
  hungarian: { name: 'Hungarian', m2mCode: 'hu', nllbCode: 'hun_Latn', opusCode: 'hun' },
  magyar: { name: 'Hungarian', m2mCode: 'hu', nllbCode: 'hun_Latn', opusCode: 'hun' },
  hu: { name: 'Hungarian', m2mCode: 'hu', nllbCode: 'hun_Latn', opusCode: 'hun' },
  bulgarian: { name: 'Bulgarian', m2mCode: 'bg', nllbCode: 'bul_Cyrl', opusCode: 'bul' },
  bg: { name: 'Bulgarian', m2mCode: 'bg', nllbCode: 'bul_Cyrl', opusCode: 'bul' },
  serbian: { name: 'Serbian', m2mCode: 'sr', nllbCode: 'srp_Cyrl', opusCode: 'srp_Cyrl' },
  sr: { name: 'Serbian', m2mCode: 'sr', nllbCode: 'srp_Cyrl', opusCode: 'srp_Cyrl' },
  croatian: { name: 'Croatian', m2mCode: 'hr', nllbCode: 'hrv_Latn', opusCode: 'hrv' },
  hr: { name: 'Croatian', m2mCode: 'hr', nllbCode: 'hrv_Latn', opusCode: 'hrv' },
  slovak: { name: 'Slovak', m2mCode: 'sk', nllbCode: 'slk_Latn', opusCode: 'slk' },
  sk: { name: 'Slovak', m2mCode: 'sk', nllbCode: 'slk_Latn', opusCode: 'slk' },
  catalan: { name: 'Catalan', m2mCode: 'ca', nllbCode: 'cat_Latn', opusCode: 'cat' },
  ca: { name: 'Catalan', m2mCode: 'ca', nllbCode: 'cat_Latn', opusCode: 'cat' },
  malay: { name: 'Malay', m2mCode: 'ms', nllbCode: 'zsm_Latn', opusCode: 'zsm' },
  ms: { name: 'Malay', m2mCode: 'ms', nllbCode: 'zsm_Latn', opusCode: 'zsm' },
  bengali: { name: 'Bengali', m2mCode: 'bn', nllbCode: 'ben_Beng', opusCode: 'ben' },
  bn: { name: 'Bengali', m2mCode: 'bn', nllbCode: 'ben_Beng', opusCode: 'ben' },
  urdu: { name: 'Urdu', m2mCode: 'ur', nllbCode: 'urd_Arab', opusCode: 'urd' },
  ur: { name: 'Urdu', m2mCode: 'ur', nllbCode: 'urd_Arab', opusCode: 'urd' },
  tamil: { name: 'Tamil', m2mCode: 'ta', nllbCode: 'tam_Taml', opusCode: 'tam' },
  ta: { name: 'Tamil', m2mCode: 'ta', nllbCode: 'tam_Taml', opusCode: 'tam' },
  swahili: { name: 'Swahili', m2mCode: 'sw', nllbCode: 'swh_Latn', opusCode: 'swh' },
  sw: { name: 'Swahili', m2mCode: 'sw', nllbCode: 'swh_Latn', opusCode: 'swh' },
  afrikaans: { name: 'Afrikaans', m2mCode: 'af', nllbCode: 'afr_Latn', opusCode: 'afr' },
  af: { name: 'Afrikaans', m2mCode: 'af', nllbCode: 'afr_Latn', opusCode: 'afr' },
  irish: { name: 'Irish', m2mCode: 'ga', nllbCode: 'gle_Latn', opusCode: 'gle' },
  ga: { name: 'Irish', m2mCode: 'ga', nllbCode: 'gle_Latn', opusCode: 'gle' },
  icelandic: { name: 'Icelandic', m2mCode: 'is', nllbCode: 'isl_Latn', opusCode: 'isl' },
  is: { name: 'Icelandic', m2mCode: 'is', nllbCode: 'isl_Latn', opusCode: 'isl' },
  estonian: { name: 'Estonian', m2mCode: 'et', nllbCode: 'est_Latn', opusCode: 'est' },
  et: { name: 'Estonian', m2mCode: 'et', nllbCode: 'est_Latn', opusCode: 'est' },
  latvian: { name: 'Latvian', m2mCode: 'lv', nllbCode: 'lvs_Latn', opusCode: 'lav' },
  lv: { name: 'Latvian', m2mCode: 'lv', nllbCode: 'lvs_Latn', opusCode: 'lav' },
  lithuanian: { name: 'Lithuanian', m2mCode: 'lt', nllbCode: 'lit_Latn', opusCode: 'lit' },
  lt: { name: 'Lithuanian', m2mCode: 'lt', nllbCode: 'lit_Latn', opusCode: 'lit' },
  slovenian: { name: 'Slovenian', m2mCode: 'sl', nllbCode: 'slv_Latn', opusCode: 'slv' },
  sl: { name: 'Slovenian', m2mCode: 'sl', nllbCode: 'slv_Latn', opusCode: 'slv' },
}

const DEFAULT_RESOLVED_LANG: ResolvedLanguageCodes = {
  name: 'English',
  m2mCode: 'en',
  nllbCode: 'eng_Latn',
  opusCode: 'eng',
}

/**
 * Resolves a human language name, native name, ISO code, or FLORES-200 code
 * into M2M-100 (`m2mCode`), NLLB-200 (`nllbCode`), and Opus-MT (`opusCode`) codes.
 */
export function resolveLanguageCodes(input: string): ResolvedLanguageCodes {
  const raw = input.trim()
  if (!raw) return DEFAULT_RESOLVED_LANG
  const lower = raw.toLowerCase()

  for (const opt of TRANSLATION_LANGUAGE_OPTIONS) {
    if (
      opt.name.toLowerCase() === lower ||
      opt.nativeName.toLowerCase() === lower ||
      opt.code.toLowerCase() === lower ||
      opt.m2mCode.toLowerCase() === lower ||
      opt.nllbCode.toLowerCase() === lower ||
      opt.opusCode.toLowerCase() === lower
    ) {
      return {
        name: opt.name,
        m2mCode: opt.m2mCode,
        nllbCode: opt.nllbCode,
        opusCode: opt.opusCode,
      }
    }
  }

  const alias = EXTRA_LANGUAGE_ALIASES[lower]
  if (alias) return alias

  // Match FLORES-200 code directly (e.g. "deu_Latn", "cat_Latn")
  if (/^[a-z]{3}_[A-Z][a-z]{3}$/.test(raw)) {
    const isoPrefix = raw.slice(0, 2).toLowerCase()
    const opusPrefix = raw.slice(0, 3).toLowerCase()
    const byNllb = Object.values(EXTRA_LANGUAGE_ALIASES).find(
      (entry) => entry.nllbCode === raw
    )
    if (byNllb) return byNllb
    return { name: raw, m2mCode: isoPrefix, nllbCode: raw, opusCode: opusPrefix }
  }

  // Match raw ISO 2-3 letter code (e.g. "fi", "da", "el")
  if (/^[a-z]{2,3}$/.test(lower)) {
    return {
      name: raw,
      m2mCode: lower,
      nllbCode: `${lower.slice(0, 3)}_Latn`,
      opusCode: lower,
    }
  }

  // Partial prefix match against curated options (e.g. "Japanese (JP)")
  for (const opt of TRANSLATION_LANGUAGE_OPTIONS) {
    if (lower.startsWith(opt.name.toLowerCase().split(' ')[0])) {
      return {
        name: opt.name,
        m2mCode: opt.m2mCode,
        nllbCode: opt.nllbCode,
        opusCode: opt.opusCode,
      }
    }
  }

  return DEFAULT_RESOLVED_LANG
}

/**
 * Picks the smartest initial Opus-MT pair repo ID for preloading based on user language settings.
 */
export function resolveInitialOpusModelId(
  myLanguage: string,
  sourceLanguage: string
): string {
  const myResolved = resolveLanguageCodes(myLanguage)
  if (myResolved.m2mCode === 'en') {
    const cleanSource = sourceLanguage.trim()
    if (cleanSource && cleanSource.toLowerCase() !== 'auto') {
      const srcResolved = resolveLanguageCodes(cleanSource)
      if (srcResolved.m2mCode !== 'en') {
        return OPUS_TO_EN_MODELS[srcResolved.m2mCode] ?? OPUS_DEFAULT_TO_EN_MODEL
      }
    }
    return OPUS_DEFAULT_TO_EN_MODEL
  }
  return OPUS_FROM_EN_MODELS[myResolved.m2mCode] ?? OPUS_DEFAULT_FROM_EN_MODEL
}

export interface TranslatorSettings {
  /** Switches chat view into Double-Column Translator Mode (default: false) */
  enabled: boolean
  /** On-device translation model selection (default: 'opus') */
  model: TranslatorModelKey
  /** Source language of incoming chat messages ('Auto' for automatic detection, or an explicit language) */
  sourceLanguage: string
  /** Target reading language for incoming messages (default: 'English') */
  myLanguage: string
  /** Translates outgoing messages before publishing to chat (default: false) */
  outgoingEnabled: boolean
  /** Target language for outgoing messages when outgoingEnabled is true (default: 'Spanish') */
  outgoingLanguage: string
  /** Collapses the right "Underlying Chat" column while in Translator Mode (default: false) */
  underlyingCollapsed: boolean
}

export const DEFAULT_TRANSLATOR_SETTINGS: TranslatorSettings = {
  enabled: false,
  model: DEFAULT_TRANSLATOR_MODEL_KEY,
  sourceLanguage: 'Auto',
  myLanguage: 'English',
  outgoingEnabled: false,
  outgoingLanguage: 'Spanish',
  underlyingCollapsed: false,
}

export type TranslatorModelStatus = 'idle' | 'downloading' | 'ready' | 'error'

export type TranslatorRuntimeDevice = 'webgpu' | 'wasm'

export type TranslatorModelDtype = 'q4f16' | 'q8'

export interface TranslationEntry {
  status: 'loading' | 'done' | 'error'
  text?: string
  error?: string
  targetLang: string
  detectedSourceLang?: string
  sameLanguage?: boolean
  updatedAt: number
}

export type TranslatorJobPriority = 'high' | 'live' | 'visible' | 'normal'

export interface TranslateMessageOptions {
  sourceLang?: string
  roomHintLang?: string | null
  scopeKey?: string
  priority?: 'live' | 'visible' | 'normal'
}

export interface OutgoingOriginalEntry {
  originalText: string
  sourceLang: string
  translatedText: string
  targetLang: string
}

/**
 * Canonical key for `TranslatorEngine.translations`:
 * - Auto source: `${msgId}:${targetLang}`
 * - Explicit source: `${msgId}:${targetLang}:from:${sourceLang}`
 */
export function translationCacheKey(
  msgId: string,
  targetLang: string,
  sourceLang?: string
): string {
  const cleanTarget = targetLang.trim()
  const cleanSource = sourceLang?.trim() ?? ''
  if (!cleanSource || cleanSource.toLowerCase() === 'auto') {
    return `${msgId}:${cleanTarget}`
  }
  return `${msgId}:${cleanTarget}:from:${cleanSource}`
}

export interface TranslatorEngine {
  // User preferences
  settings: TranslatorSettings
  updateSettings: (patch: Partial<TranslatorSettings>) => void

  // On-device model & runtime status
  modelKey: TranslatorModelKey
  modelId: string
  modelLabel: string
  modelSizeHint: string
  modelStatus: TranslatorModelStatus
  downloadProgress: number // 0..100
  downloadFile: string | null
  runtimeDevice: TranslatorRuntimeDevice | null
  modelError: string | null
  webGpuSupported: boolean
  isModelCached: boolean
  cachedModelBytes: number
  storagePersisted: boolean
  preloadModel: () => Promise<boolean>
  cancelDownload: () => void
  clearModelCache: () => Promise<void>

  // Message translations & outgoing originals
  translations: Record<string, TranslationEntry>
  originalOutgoingById: Record<string, OutgoingOriginalEntry>
  recordOutgoingOriginal: (
    msgId: string,
    originalText: string,
    translatedText: string,
    targetLang: string,
    sourceLang?: string
  ) => void
  translateMessage: (
    msgId: string,
    text: string,
    targetLang?: string,
    options?: TranslateMessageOptions
  ) => Promise<string | null>
  translateOutgoingText: (
    text: string,
    targetLang?: string,
    sourceLang?: string
  ) => Promise<string>
  cancelScope: (keepScopeKey?: string) => void

  // Local cache & Panic Wipe
  cachedTranslationCount: number
  clearTranslationCache: () => void
  resetAll: () => void
}
