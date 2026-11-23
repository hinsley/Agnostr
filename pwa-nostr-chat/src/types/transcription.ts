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

export interface LiveCaptionEntry {
  id: string
  pubkey: string
  nickname: string
  displayHandle: string
  isSelf: boolean
  text: string
  timestamp: number // unix ms
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
}
