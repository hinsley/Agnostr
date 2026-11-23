import type { ImageAttachment } from './protocol.ts'

export const CONTENT_FILTER_MODEL_ID = 'LiquidAI/d1-2B-ONNX'
export const CONTENT_FILTER_MODEL_LABEL = 'Liquid AI d1-2B'

export type ContentFilterMediaScope = 'untrusted' | 'all' | 'off'
export type ContentFilterTextScope = 'off' | 'untrusted' | 'all'
export type ContentFilterCallVideoMode = 'trusted-only' | 'screen-untrusted' | 'screen-all'
export type ContentFilterCategory = 'nsfw' | 'illegal' | 'custom'
export type ContentFilterModelStatus = 'idle' | 'downloading' | 'ready' | 'error'
export type ContentFilterRuntimeDevice = 'webgpu' | 'wasm'
export type ContentFilterVerdictStatus =
  | 'idle'
  | 'downloading'
  | 'scanning'
  | 'safe'
  | 'flagged'
  | 'error'

export interface ContentFilterSettings {
  /** Master on/off toggle for Liquid AI d1-2B on-device content filtering (default: true) */
  enabled: boolean
  /** Flag NSFW / pornographic / sexually explicit content (default: true) */
  filterNsfw: boolean
  /** Flag illegal / CSAM / extreme violence / severe harm content (default: true) */
  filterIllegal: boolean
  /** Enable user-defined natural-language moderation rule (default: false) */
  customRulesEnabled: boolean
  /** User-defined moderation instructions (e.g. profanity, slurs, scam spam) */
  customInstructions: string
  /** Incoming image & media interception scope (default: 'untrusted') */
  mediaScope: ContentFilterMediaScope
  /** Incoming chat text filtering scope (default: 'off') */
  textScope: ContentFilterTextScope
  /** Incoming call video handling mode (default: 'trusted-only') */
  callVideoMode: ContentFilterCallVideoMode
}

export const DEFAULT_CONTENT_FILTER_SETTINGS: ContentFilterSettings = {
  enabled: true,
  filterNsfw: true,
  filterIllegal: true,
  customRulesEnabled: false,
  customInstructions: '',
  mediaScope: 'untrusted',
  textScope: 'off',
  callVideoMode: 'trusted-only',
}

export interface ContentFilterVerdict {
  status: ContentFilterVerdictStatus
  safe: boolean
  flagged: boolean
  categories: ContentFilterCategory[]
  reason?: string
  scores?: Partial<Record<ContentFilterCategory, number>>
  error?: string
  checkedAt: number
}

export interface ScreenImageAttachmentOptions {
  decryptKeyHex?: string
  ivHex?: string
  caption?: string
}

export interface ScreenContentOptions {
  caption?: string
  skipCache?: boolean
}

export interface ContentFilterEngine {
  settings: ContentFilterSettings
  updateSettings: (patch: Partial<ContentFilterSettings>) => void

  modelId: string
  modelLabel: string
  modelStatus: ContentFilterModelStatus
  downloadProgress: number
  downloadFile: string | null
  runtimeDevice: ContentFilterRuntimeDevice | null
  modelError: string | null
  webGpuSupported: boolean

  preloadModel: () => Promise<boolean>
  clearModelCache: () => Promise<void>
  clearVerdictCache: () => void
  cachedVerdictCount: number

  /** True when media from this sender must be intercepted & screened by d1-2B before display */
  shouldScreenMedia: (senderPubkey: string, isSelf: boolean) => boolean
  /** True when text messages from this sender must be screened by d1-2B before display */
  shouldScreenText: (senderPubkey: string, isSelf: boolean) => boolean
  /** True when untrusted call video is explicitly opted into d1-2B screening (false under default 'trusted-only') */
  shouldAllowScreenedCallVideo: (senderPubkey: string, isSelf: boolean) => boolean
  /** True when incoming video frames from this peer must pass d1-2B screening before unveiling */
  shouldScreenCallVideo: (senderPubkey: string, isSelf: boolean) => boolean

  verdicts: Record<string, ContentFilterVerdict>
  getVerdict: (cacheKey: string) => ContentFilterVerdict | null

  /** Fetches media bytes in-memory only, runs Liquid d1-2B in worker, and exposes objectUrl ONLY if safe */
  screenImageAttachment: (
    cacheKey: string,
    image: ImageAttachment,
    senderPubkey: string,
    opts?: ScreenImageAttachmentOptions
  ) => Promise<ContentFilterVerdict>

  /** Screens an in-memory image Blob (Settings test file or live call video frame snapshot) */
  screenImageBlob: (
    cacheKey: string,
    blob: Blob,
    opts?: ScreenContentOptions
  ) => Promise<ContentFilterVerdict>

  /** Screens text content (chat messages when textScope !== 'off', or Settings quick test) */
  screenText: (
    cacheKey: string,
    text: string,
    opts?: { skipCache?: boolean }
  ) => Promise<ContentFilterVerdict>

  /** Returns the verified local blob: objectUrl ONLY for images cleared safe (null otherwise) */
  getSafeImageObjectUrl: (cacheKey: string) => string | null

  /** Explicitly reveals a non-illegal flagged image on user click; ALWAYS returns null if flagged 'illegal' */
  revealFlaggedImage: (cacheKey: string) => string | null

  /** Revokes any cached blobs & verdicts for a newly muted/blocked sender */
  revokeForSender: (senderPubkey: string) => void

  /** Purges all settings, verdicts, object URLs, and worker state (called on Panic Wipe) */
  resetAll: () => void
}
