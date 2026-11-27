import type { VoiceMemoAttachment } from './protocol.ts'

export type TranscriptionModelEngine = 'transformers' | 'parakeet'

export type TranscriptionDtypeValue =
  | 'fp32'
  | 'fp16'
  | 'q8'
  | 'int8'
  | 'uint8'
  | 'q4'
  | 'bnb4'
  | 'q4f16'
  | 'auto'

export type TranscriptionModelDtype =
  | TranscriptionDtypeValue
  | Record<string, TranscriptionDtypeValue>

export interface TranscriptionModelSpec {
  id: string
  label: string
  hfModelId: string
  engine: TranscriptionModelEngine
  sizeHint: string
  languages: string
  description: string
  dtype: TranscriptionModelDtype
  isBuiltIn: boolean
}

export type TranscriptionModelStatus = 'idle' | 'downloading' | 'ready' | 'error'

export type TranscriptionRuntimeDevice = 'webgpu' | 'wasm'

export interface MemoTranscriptState {
  status: 'loading' | 'done' | 'error'
  text?: string
  error?: string
  modelLabel?: string
  updatedAt: number
}

export const CALL_TRANSCRIPT_RETENTION_DAYS = 30

export interface LiveCaptionEntry {
  id: string
  pubkey: string
  nickname: string
  displayHandle: string
  isSelf: boolean
  text: string
  timestamp: number // unix ms
}

export interface SavedCallTranscript {
  id: string
  callId: string
  callTitle: string
  startedAt: number // unix ms
  endedAt: number // unix ms
  savedAt: number // unix ms (retention baseline)
  expiresAt: number // savedAt + 30 days
  modelLabel: string
  hfModelId: string
  entries: LiveCaptionEntry[]
  contentHash: string // SHA-256 hex (computed ONLY on finalize)
}

export interface CallTranscriptSyncPayload {
  v: 1
  updatedAt: number
  collectionHash: string
  transcripts: SavedCallTranscript[]
  deleted: Record<string, number> // id -> deletedAtMs (30-day TTL tombstones)
}

export interface CallTranscriptSyncDigest {
  count: number
  updatedAt: number
  hash: string // precomputed collectionHash (O(1) read)
  itemHashes: Record<string, string> // id -> contentHash (for delta sync)
  deleted: Record<string, number> // id -> deletedAtMs
}

export interface EndedCallTranscript {
  id: string
  callTitle: string
  startedAt: number
  endedAt: number
  modelLabel: string
  entries: LiveCaptionEntry[]
  filename: string
  markdown: string
  plainText: string
  contentHash?: string
  savedAt?: number
}

export interface PersistedTranscriptionConfig {
  activeModelId: string
  autoTranscribe: boolean
  customModels: TranscriptionModelSpec[]
}

export interface TranscriptionEngine {
  // Multi-model registry & selection
  models: TranscriptionModelSpec[]
  activeModelId: string
  activeModel: TranscriptionModelSpec
  setActiveModelId: (modelId: string) => void
  addCustomModel: (hfModelId: string, label?: string) => boolean
  removeCustomModel: (modelId: string) => void

  // Automatic transcription preference (default ON)
  autoTranscribe: boolean
  setAutoTranscribe: (enabled: boolean) => void

  // Worker & model runtime state
  modelStatus: TranscriptionModelStatus
  downloadProgress: number // 0..100
  downloadFile: string | null
  runtimeDevice: TranscriptionRuntimeDevice | null
  modelError: string | null
  preloadModel: () => Promise<boolean>
  cancelDownload: () => void
  clearModelCache: () => Promise<void>

  // On-demand & automatic voice memo transcription (strictly Trusted-Peers gated)
  memoTranscripts: Record<string, MemoTranscriptState>
  cachedTranscriptCount: number
  clearTranscriptCache: () => void
  transcribeVoiceMemo: (
    memoKey: string,
    memo: VoiceMemoAttachment,
    senderPubkey: string
  ) => Promise<void>
  transcribeAudioBlob: (blob: Blob) => Promise<string>
  seedMemoTranscript: (memoKey: string, text: string, modelLabel?: string) => void

  // Live per-speaker call captions (CC) & rolling/full transcript
  liveCaptionsEnabled: boolean
  toggleLiveCaptions: () => void
  liveCaptions: LiveCaptionEntry[]
  clearCallTranscript: () => void
  exportCallTranscriptMarkdown: () => {
    filename: string
    content: string
    mimeType: string
  }
  endedCallTranscript: EndedCallTranscript | null
  dismissEndedCallTranscript: () => void
  downloadEndedCallTranscript: () => void

  // Automatically persisted call transcripts (30-day retention, hash-verified multi-device sync)
  savedCallTranscripts: SavedCallTranscript[]
  deleteSavedCallTranscript: (id: string) => void
  clearSavedCallTranscripts: () => void
  downloadSavedCallTranscript: (id: string) => void
  formatSavedCallTranscriptMarkdown: (transcript: SavedCallTranscript) => {
    filename: string
    markdown: string
    plainText: string
  }
}
