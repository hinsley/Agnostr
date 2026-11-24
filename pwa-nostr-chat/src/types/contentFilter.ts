import type { ImageAttachment } from './protocol.ts'

export const CONTENT_FILTER_MODEL_ID = 'OwenElliott/image-safety-classifier-s'
export const CONTENT_FILTER_MODEL_LABEL = 'Image Safety Classifier (23 MB)'
export const CONTENT_FILTER_CACHE_NAME = 'content-filter-cache'

export type ContentFilterMediaScope = 'untrusted' | 'all'
export type ContentFilterCallVideoMode = 'trusted-only' | 'screen-untrusted' | 'screen-all'
export type ContentFilterCategory = 'nsfw' | 'illegal'
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
  /** On-device image safety filtering is permanently enforced (always true; non-disableable) */
  enabled: boolean
  /** Flag NSFW / pornographic / sexually explicit imagery (default: true) */
  filterNsfw: boolean
  /** Flag illegal / NSFL / extreme gore & graphic violence imagery (permanently enforced true; non-disableable) */
  filterIllegal: boolean
  /** Incoming image & media interception scope ('untrusted' | 'all'; default: 'untrusted') */
  mediaScope: ContentFilterMediaScope
  /** Incoming call video handling mode (default: 'trusted-only') */
  callVideoMode: ContentFilterCallVideoMode
}

export const DEFAULT_CONTENT_FILTER_SETTINGS: ContentFilterSettings = {
  enabled: true,
  filterNsfw: true,
  filterIllegal: true,
  mediaScope: 'untrusted',
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

export interface PreloadModelOptions {
  /** Suppress standard toast notifications (used for automatic startup preload with dedicated popup) */
  silent?: boolean
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

  preloadModel: (opts?: PreloadModelOptions) => Promise<boolean>
  cancelDownload: () => void
  clearModelCache: () => Promise<void>
  clearVerdictCache: () => void
  cachedVerdictCount: number

  /** True when media from this sender must be intercepted & screened before display */
  shouldScreenMedia: (senderPubkey: string, isSelf: boolean) => boolean
  /** True when untrusted call video is explicitly opted into screening (false under default 'trusted-only') */
  shouldAllowScreenedCallVideo: (senderPubkey: string, isSelf: boolean) => boolean
  /** True when incoming video frames from this peer must pass screening before unveiling */
  shouldScreenCallVideo: (senderPubkey: string, isSelf: boolean) => boolean

  verdicts: Record<string, ContentFilterVerdict>
  getVerdict: (cacheKey: string) => ContentFilterVerdict | null

  /** Fetches media bytes in-memory only, runs on-device safety screening in worker, and exposes objectUrl ONLY if safe */
  screenImageAttachment: (
    cacheKey: string,
    image: ImageAttachment,
    senderPubkey: string,
    opts?: ScreenImageAttachmentOptions
  ) => Promise<ContentFilterVerdict>

  /** Fetches an external HTTPS image URL in-memory only, always runs on-device safety screening in worker, and exposes objectUrl ONLY if safe */
  screenExternalImageUrl: (
    cacheKey: string,
    url: string,
    senderPubkey: string,
    opts?: ScreenContentOptions
  ) => Promise<ContentFilterVerdict>

  /** Screens an in-memory image Blob (Settings test file or live call video frame snapshot) */
  screenImageBlob: (
    cacheKey: string,
    blob: Blob,
    opts?: ScreenContentOptions
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
