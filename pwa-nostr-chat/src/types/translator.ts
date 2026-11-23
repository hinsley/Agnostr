export const TRANSLATOR_MODEL_ID = 'onnx-community/LFM3-1.7B-ONNX' as const
export const TRANSLATOR_MODEL_LABEL = 'LFM3-1.7B' as const
export const TRANSLATOR_MODEL_SIZE_HINT = '~1.1 GB (q4f16 WebGPU) / ~1.3 GB (q4)' as const
export const TRANSLATOR_CACHE_KEY = 'agnostr-translator-cache' as const

export interface TranslationLanguageOption {
  name: string
  nativeName: string
  code: string
}

export const TRANSLATION_LANGUAGE_OPTIONS: readonly TranslationLanguageOption[] = [
  { name: 'English', nativeName: 'English', code: 'en' },
  { name: 'Spanish', nativeName: 'Español', code: 'es' },
  { name: 'French', nativeName: 'Français', code: 'fr' },
  { name: 'German', nativeName: 'Deutsch', code: 'de' },
  { name: 'Portuguese', nativeName: 'Português', code: 'pt' },
  { name: 'Italian', nativeName: 'Italiano', code: 'it' },
  { name: 'Japanese', nativeName: '日本語', code: 'ja' },
  { name: 'Korean', nativeName: '한국어', code: 'ko' },
  { name: 'Chinese (Simplified)', nativeName: '简体中文', code: 'zh-Hans' },
  { name: 'Chinese (Traditional)', nativeName: '繁體中文', code: 'zh-Hant' },
  { name: 'Russian', nativeName: 'Русский', code: 'ru' },
  { name: 'Arabic', nativeName: 'العربية', code: 'ar' },
  { name: 'Hindi', nativeName: 'हिन्दी', code: 'hi' },
  { name: 'Dutch', nativeName: 'Nederlands', code: 'nl' },
  { name: 'Polish', nativeName: 'Polski', code: 'pl' },
  { name: 'Turkish', nativeName: 'Türkçe', code: 'tr' },
  { name: 'Ukrainian', nativeName: 'Українська', code: 'uk' },
  { name: 'Vietnamese', nativeName: 'Tiếng Việt', code: 'vi' },
  { name: 'Thai', nativeName: 'ไทย', code: 'th' },
  { name: 'Indonesian', nativeName: 'Bahasa Indonesia', code: 'id' },
] as const

/**
 * Curated list of supported translation languages (freeform custom language strings are also accepted).
 */
export const SUPPORTED_TRANSLATION_LANGUAGES: readonly string[] =
  TRANSLATION_LANGUAGE_OPTIONS.map((opt) => opt.name)

export interface TranslatorSettings {
  /** Switches chat view into Double-Column Translator Mode (default: false) */
  enabled: boolean
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
  myLanguage: 'English',
  outgoingEnabled: false,
  outgoingLanguage: 'Spanish',
  underlyingCollapsed: false,
}

export type TranslatorModelStatus = 'idle' | 'downloading' | 'ready' | 'error'

export type TranslatorRuntimeDevice = 'webgpu' | 'wasm'

export type TranslatorModelDtype = 'q4f16' | 'q4'

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
  modelId: string
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
