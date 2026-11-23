export type TranslatorModelKey = 'm2m100' | 'nllb200'

export interface TranslatorModelOption {
  key: TranslatorModelKey
  id: string
  label: string
  shortLabel: string
  sizeHint: string
  description: string
}

export const TRANSLATOR_MODELS: Record<TranslatorModelKey, TranslatorModelOption> = {
  m2m100: {
    key: 'm2m100',
    id: 'Xenova/m2m100_418M',
    label: 'M2M-100 (418M)',
    shortLabel: 'M2M-100',
    sizeHint: '~603 MB (q8) / ~695 MB (WebGPU)',
    description: 'Fast, lightweight 100-language translation (Default)',
  },
  nllb200: {
    key: 'nllb200',
    id: 'Xenova/nllb-200-distilled-600M',
    label: 'NLLB-200 (600M)',
    shortLabel: 'NLLB-200',
    sizeHint: '~853 MB (q8) / ~1.2 GB (WebGPU)',
    description: 'Higher-quality 200-language translation',
  },
}

export const DEFAULT_TRANSLATOR_MODEL_KEY: TranslatorModelKey = 'm2m100'
export const TRANSLATOR_MODEL_ID = TRANSLATOR_MODELS.m2m100.id
export const TRANSLATOR_MODEL_LABEL = TRANSLATOR_MODELS.m2m100.label
export const TRANSLATOR_MODEL_SIZE_HINT = TRANSLATOR_MODELS.m2m100.sizeHint
export const TRANSLATOR_CACHE_KEY = 'agnostr-translator-cache' as const

export interface TranslationLanguageOption {
  name: string
  nativeName: string
  code: string
  /** Verified ISO language code for Xenova/m2m100_418M */
  m2mCode: string
  /** Verified FLORES-200 language code for Xenova/nllb-200-distilled-600M */
  nllbCode: string
}

export const TRANSLATION_LANGUAGE_OPTIONS: readonly TranslationLanguageOption[] = [
  { name: 'English', nativeName: 'English', code: 'en', m2mCode: 'en', nllbCode: 'eng_Latn' },
  { name: 'Spanish', nativeName: 'Español', code: 'es', m2mCode: 'es', nllbCode: 'spa_Latn' },
  { name: 'French', nativeName: 'Français', code: 'fr', m2mCode: 'fr', nllbCode: 'fra_Latn' },
  { name: 'German', nativeName: 'Deutsch', code: 'de', m2mCode: 'de', nllbCode: 'deu_Latn' },
  { name: 'Portuguese', nativeName: 'Português', code: 'pt', m2mCode: 'pt', nllbCode: 'por_Latn' },
  { name: 'Italian', nativeName: 'Italiano', code: 'it', m2mCode: 'it', nllbCode: 'ita_Latn' },
  { name: 'Japanese', nativeName: '日本語', code: 'ja', m2mCode: 'ja', nllbCode: 'jpn_Jpan' },
  { name: 'Korean', nativeName: '한국어', code: 'ko', m2mCode: 'ko', nllbCode: 'kor_Hang' },
  {
    name: 'Chinese (Simplified)',
    nativeName: '简体中文',
    code: 'zh-Hans',
    m2mCode: 'zh',
    nllbCode: 'zho_Hans',
  },
  {
    name: 'Chinese (Traditional)',
    nativeName: '繁體中文',
    code: 'zh-Hant',
    m2mCode: 'zh',
    nllbCode: 'zho_Hant',
  },
  { name: 'Russian', nativeName: 'Русский', code: 'ru', m2mCode: 'ru', nllbCode: 'rus_Cyrl' },
  { name: 'Arabic', nativeName: 'العربية', code: 'ar', m2mCode: 'ar', nllbCode: 'arb_Arab' },
  { name: 'Hindi', nativeName: 'हिन्दी', code: 'hi', m2mCode: 'hi', nllbCode: 'hin_Deva' },
  { name: 'Dutch', nativeName: 'Nederlands', code: 'nl', m2mCode: 'nl', nllbCode: 'nld_Latn' },
  { name: 'Polish', nativeName: 'Polski', code: 'pl', m2mCode: 'pl', nllbCode: 'pol_Latn' },
  { name: 'Turkish', nativeName: 'Türkçe', code: 'tr', m2mCode: 'tr', nllbCode: 'tur_Latn' },
  { name: 'Ukrainian', nativeName: 'Українська', code: 'uk', m2mCode: 'uk', nllbCode: 'ukr_Cyrl' },
  { name: 'Vietnamese', nativeName: 'Tiếng Việt', code: 'vi', m2mCode: 'vi', nllbCode: 'vie_Latn' },
  { name: 'Thai', nativeName: 'ไทย', code: 'th', m2mCode: 'th', nllbCode: 'tha_Thai' },
  {
    name: 'Indonesian',
    nativeName: 'Bahasa Indonesia',
    code: 'id',
    m2mCode: 'id',
    nllbCode: 'ind_Latn',
  },
  { name: 'Swedish', nativeName: 'Svenska', code: 'sv', m2mCode: 'sv', nllbCode: 'swe_Latn' },
  { name: 'Czech', nativeName: 'Čeština', code: 'cs', m2mCode: 'cs', nllbCode: 'ces_Latn' },
  { name: 'Greek', nativeName: 'Ελληνικά', code: 'el', m2mCode: 'el', nllbCode: 'ell_Grek' },
  { name: 'Hebrew', nativeName: 'עברית', code: 'he', m2mCode: 'he', nllbCode: 'heb_Hebr' },
  { name: 'Romanian', nativeName: 'Română', code: 'ro', m2mCode: 'ro', nllbCode: 'ron_Latn' },
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
}

const EXTRA_LANGUAGE_ALIASES: Record<string, ResolvedLanguageCodes> = {
  chinese: { name: 'Chinese (Simplified)', m2mCode: 'zh', nllbCode: 'zho_Hans' },
  mandarin: { name: 'Chinese (Simplified)', m2mCode: 'zh', nllbCode: 'zho_Hans' },
  zh: { name: 'Chinese (Simplified)', m2mCode: 'zh', nllbCode: 'zho_Hans' },
  'zh-cn': { name: 'Chinese (Simplified)', m2mCode: 'zh', nllbCode: 'zho_Hans' },
  'zh-tw': { name: 'Chinese (Traditional)', m2mCode: 'zh', nllbCode: 'zho_Hant' },
  'zh-hk': { name: 'Chinese (Traditional)', m2mCode: 'zh', nllbCode: 'zho_Hant' },
  cantonese: { name: 'Chinese (Traditional)', m2mCode: 'zh', nllbCode: 'zho_Hant' },
  espanol: { name: 'Spanish', m2mCode: 'es', nllbCode: 'spa_Latn' },
  castilian: { name: 'Spanish', m2mCode: 'es', nllbCode: 'spa_Latn' },
  francais: { name: 'French', m2mCode: 'fr', nllbCode: 'fra_Latn' },
  portugues: { name: 'Portuguese', m2mCode: 'pt', nllbCode: 'por_Latn' },
  'brazilian portuguese': { name: 'Portuguese', m2mCode: 'pt', nllbCode: 'por_Latn' },
  'pt-br': { name: 'Portuguese', m2mCode: 'pt', nllbCode: 'por_Latn' },
  farsi: { name: 'Persian', m2mCode: 'fa', nllbCode: 'pes_Arab' },
  persian: { name: 'Persian', m2mCode: 'fa', nllbCode: 'pes_Arab' },
  fa: { name: 'Persian', m2mCode: 'fa', nllbCode: 'pes_Arab' },
  tagalog: { name: 'Tagalog', m2mCode: 'tl', nllbCode: 'tgl_Latn' },
  filipino: { name: 'Tagalog', m2mCode: 'tl', nllbCode: 'tgl_Latn' },
  tl: { name: 'Tagalog', m2mCode: 'tl', nllbCode: 'tgl_Latn' },
  danish: { name: 'Danish', m2mCode: 'da', nllbCode: 'dan_Latn' },
  dansk: { name: 'Danish', m2mCode: 'da', nllbCode: 'dan_Latn' },
  da: { name: 'Danish', m2mCode: 'da', nllbCode: 'dan_Latn' },
  norwegian: { name: 'Norwegian', m2mCode: 'no', nllbCode: 'nob_Latn' },
  norsk: { name: 'Norwegian', m2mCode: 'no', nllbCode: 'nob_Latn' },
  no: { name: 'Norwegian', m2mCode: 'no', nllbCode: 'nob_Latn' },
  nb: { name: 'Norwegian', m2mCode: 'no', nllbCode: 'nob_Latn' },
  finnish: { name: 'Finnish', m2mCode: 'fi', nllbCode: 'fin_Latn' },
  suomi: { name: 'Finnish', m2mCode: 'fi', nllbCode: 'fin_Latn' },
  fi: { name: 'Finnish', m2mCode: 'fi', nllbCode: 'fin_Latn' },
  hungarian: { name: 'Hungarian', m2mCode: 'hu', nllbCode: 'hun_Latn' },
  magyar: { name: 'Hungarian', m2mCode: 'hu', nllbCode: 'hun_Latn' },
  hu: { name: 'Hungarian', m2mCode: 'hu', nllbCode: 'hun_Latn' },
  bulgarian: { name: 'Bulgarian', m2mCode: 'bg', nllbCode: 'bul_Cyrl' },
  bg: { name: 'Bulgarian', m2mCode: 'bg', nllbCode: 'bul_Cyrl' },
  serbian: { name: 'Serbian', m2mCode: 'sr', nllbCode: 'srp_Cyrl' },
  sr: { name: 'Serbian', m2mCode: 'sr', nllbCode: 'srp_Cyrl' },
  croatian: { name: 'Croatian', m2mCode: 'hr', nllbCode: 'hrv_Latn' },
  hr: { name: 'Croatian', m2mCode: 'hr', nllbCode: 'hrv_Latn' },
  slovak: { name: 'Slovak', m2mCode: 'sk', nllbCode: 'slk_Latn' },
  sk: { name: 'Slovak', m2mCode: 'sk', nllbCode: 'slk_Latn' },
  catalan: { name: 'Catalan', m2mCode: 'ca', nllbCode: 'cat_Latn' },
  ca: { name: 'Catalan', m2mCode: 'ca', nllbCode: 'cat_Latn' },
  malay: { name: 'Malay', m2mCode: 'ms', nllbCode: 'zsm_Latn' },
  ms: { name: 'Malay', m2mCode: 'ms', nllbCode: 'zsm_Latn' },
  bengali: { name: 'Bengali', m2mCode: 'bn', nllbCode: 'ben_Beng' },
  bn: { name: 'Bengali', m2mCode: 'bn', nllbCode: 'ben_Beng' },
  urdu: { name: 'Urdu', m2mCode: 'ur', nllbCode: 'urd_Arab' },
  ur: { name: 'Urdu', m2mCode: 'ur', nllbCode: 'urd_Arab' },
  tamil: { name: 'Tamil', m2mCode: 'ta', nllbCode: 'tam_Taml' },
  ta: { name: 'Tamil', m2mCode: 'ta', nllbCode: 'tam_Taml' },
  swahili: { name: 'Swahili', m2mCode: 'sw', nllbCode: 'swh_Latn' },
  sw: { name: 'Swahili', m2mCode: 'sw', nllbCode: 'swh_Latn' },
  afrikaans: { name: 'Afrikaans', m2mCode: 'af', nllbCode: 'afr_Latn' },
  af: { name: 'Afrikaans', m2mCode: 'af', nllbCode: 'afr_Latn' },
  irish: { name: 'Irish', m2mCode: 'ga', nllbCode: 'gle_Latn' },
  ga: { name: 'Irish', m2mCode: 'ga', nllbCode: 'gle_Latn' },
  icelandic: { name: 'Icelandic', m2mCode: 'is', nllbCode: 'isl_Latn' },
  is: { name: 'Icelandic', m2mCode: 'is', nllbCode: 'isl_Latn' },
  estonian: { name: 'Estonian', m2mCode: 'et', nllbCode: 'est_Latn' },
  et: { name: 'Estonian', m2mCode: 'et', nllbCode: 'est_Latn' },
  latvian: { name: 'Latvian', m2mCode: 'lv', nllbCode: 'lvs_Latn' },
  lv: { name: 'Latvian', m2mCode: 'lv', nllbCode: 'lvs_Latn' },
  lithuanian: { name: 'Lithuanian', m2mCode: 'lt', nllbCode: 'lit_Latn' },
  lt: { name: 'Lithuanian', m2mCode: 'lt', nllbCode: 'lit_Latn' },
  slovenian: { name: 'Slovenian', m2mCode: 'sl', nllbCode: 'slv_Latn' },
  sl: { name: 'Slovenian', m2mCode: 'sl', nllbCode: 'slv_Latn' },
}

const DEFAULT_RESOLVED_LANG: ResolvedLanguageCodes = {
  name: 'English',
  m2mCode: 'en',
  nllbCode: 'eng_Latn',
}

/**
 * Resolves a human language name, native name, ISO code, or FLORES-200 code
 * into both M2M-100 (`m2mCode`) and NLLB-200 (`nllbCode`) tokenizer codes.
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
      opt.nllbCode.toLowerCase() === lower
    ) {
      return { name: opt.name, m2mCode: opt.m2mCode, nllbCode: opt.nllbCode }
    }
  }

  const alias = EXTRA_LANGUAGE_ALIASES[lower]
  if (alias) return alias

  // Match FLORES-200 code directly (e.g. "deu_Latn", "cat_Latn")
  if (/^[a-z]{3}_[A-Z][a-z]{3}$/.test(raw)) {
    const isoPrefix = raw.slice(0, 2).toLowerCase()
    const byNllb = Object.values(EXTRA_LANGUAGE_ALIASES).find(
      (entry) => entry.nllbCode === raw
    )
    if (byNllb) return byNllb
    return { name: raw, m2mCode: isoPrefix, nllbCode: raw }
  }

  // Match raw ISO 2-3 letter code (e.g. "fi", "da", "el")
  if (/^[a-z]{2,3}$/.test(lower)) {
    return { name: raw, m2mCode: lower, nllbCode: `${lower.slice(0, 3)}_Latn` }
  }

  // Partial prefix match against curated options (e.g. "Japanese (JP)")
  for (const opt of TRANSLATION_LANGUAGE_OPTIONS) {
    if (lower.startsWith(opt.name.toLowerCase().split(' ')[0])) {
      return { name: opt.name, m2mCode: opt.m2mCode, nllbCode: opt.nllbCode }
    }
  }

  return DEFAULT_RESOLVED_LANG
}

export interface TranslatorSettings {
  /** Switches chat view into Double-Column Translator Mode (default: false) */
  enabled: boolean
  /** On-device translation model selection (default: 'm2m100') */
  model: TranslatorModelKey
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
  updatedAt: number
}

export interface OutgoingOriginalEntry {
  originalText: string
  sourceLang: string
  translatedText: string
  targetLang: string
}

/**
 * Canonical key for `TranslatorEngine.translations`: `${msgId}:${targetLang}`.
 */
export function translationCacheKey(msgId: string, targetLang: string): string {
  return `${msgId}:${targetLang.trim()}`
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
  preloadModel: () => Promise<boolean>
  clearModelCache: () => Promise<void>

  // Message translations & outgoing originals
  translations: Record<string, TranslationEntry>
  originalOutgoingById: Record<string, OutgoingOriginalEntry>
  recordOutgoingOriginal: (
    msgId: string,
    originalText: string,
    translatedText: string,
    targetLang: string
  ) => void
  translateMessage: (
    msgId: string,
    text: string,
    targetLang?: string
  ) => Promise<string | null>
  translateOutgoingText: (text: string, targetLang?: string) => Promise<string>

  // Local cache & Panic Wipe
  cachedTranslationCount: number
  clearTranslationCache: () => void
  resetAll: () => void
}
