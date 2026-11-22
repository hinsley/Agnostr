import type {
  TranscriptionDtypeValue,
  TranscriptionModelDtype,
  TranscriptionModelSpec,
} from '../types/transcription.ts'

export const DEFAULT_TRANSCRIPTION_MODEL_ID = 'moonshine-base'

export const BUILTIN_TRANSCRIPTION_MODELS: readonly TranscriptionModelSpec[] = [
  {
    id: 'moonshine-base',
    label: 'Moonshine Base',
    hfModelId: 'onnx-community/moonshine-base-ONNX',
    sizeHint: '~64 MB',
    languages: 'English',
    description: 'Fast, low-latency on-device speech recognition tuned for voice memos and live captions.',
    dtype: {
      encoder_model: 'q8',
      decoder_model_merged: 'q8',
    },
    isBuiltIn: true,
  },
]

const VALID_DTYPES = new Set<TranscriptionDtypeValue>([
  'fp32',
  'fp16',
  'q8',
  'int8',
  'uint8',
  'q4',
  'bnb4',
  'q4f16',
  'auto',
])

const HF_MODEL_ID_RE = /^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,96}$/

export function normalizeHfModelId(raw: string): string | null {
  const trimmed = raw
    .trim()
    .replace(/^https?:\/\/huggingface\.co\//i, '')
    .replace(/\/+$/, '')
  if (!HF_MODEL_ID_RE.test(trimmed)) return null
  if (trimmed.includes('..')) return null
  return trimmed
}

export function isValidTranscriptionDtype(raw: unknown): raw is TranscriptionModelDtype {
  if (typeof raw === 'string') {
    return VALID_DTYPES.has(raw as TranscriptionDtypeValue)
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const entries = Object.entries(raw as Record<string, unknown>)
    if (entries.length === 0) return false
    return entries.every(
      ([k, v]) => k.trim().length > 0 && typeof v === 'string' && VALID_DTYPES.has(v as TranscriptionDtypeValue)
    )
  }
  return false
}

export function deriveCustomModelLabel(hfModelId: string, customLabel?: string): string {
  const cleaned = customLabel?.trim().slice(0, 48)
  if (cleaned) return cleaned
  const repo = hfModelId.split('/')[1] ?? hfModelId
  const pretty = repo
    .replace(/-onnx$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  if (!pretty) return hfModelId.slice(0, 48)
  return pretty
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
    .slice(0, 48)
}

export function createCustomTranscriptionModel(
  rawHfModelId: string,
  customLabel?: string
): TranscriptionModelSpec | null {
  const hfModelId = normalizeHfModelId(rawHfModelId)
  if (!hfModelId) return null
  const slug = hfModelId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return {
    id: `custom:${slug}`,
    label: deriveCustomModelLabel(hfModelId, customLabel),
    hfModelId,
    sizeHint: 'Custom ONNX',
    languages: 'Model-dependent',
    description: `Custom Hugging Face ONNX ASR model (${hfModelId}).`,
    dtype: 'q8',
    isBuiltIn: false,
  }
}

export function mergeTranscriptionModels(
  customModels: readonly TranscriptionModelSpec[]
): TranscriptionModelSpec[] {
  const seenIds = new Set<string>()
  const seenHfIds = new Set<string>()
  const out: TranscriptionModelSpec[] = []

  for (const builtIn of BUILTIN_TRANSCRIPTION_MODELS) {
    seenIds.add(builtIn.id)
    seenHfIds.add(builtIn.hfModelId.toLowerCase())
    out.push(builtIn)
  }

  for (const item of customModels) {
    if (!item || typeof item.id !== 'string' || typeof item.hfModelId !== 'string') continue
    const hfId = normalizeHfModelId(item.hfModelId)
    if (!hfId) continue
    if (seenIds.has(item.id) || seenHfIds.has(hfId.toLowerCase())) continue
    seenIds.add(item.id)
    seenHfIds.add(hfId.toLowerCase())
    out.push({
      id: item.id,
      label: deriveCustomModelLabel(hfId, item.label),
      hfModelId: hfId,
      sizeHint: typeof item.sizeHint === 'string' && item.sizeHint.trim() ? item.sizeHint.trim() : 'Custom ONNX',
      languages: typeof item.languages === 'string' && item.languages.trim() ? item.languages.trim() : 'Model-dependent',
      description:
        typeof item.description === 'string' && item.description.trim()
          ? item.description.trim()
          : `Custom Hugging Face ONNX ASR model (${hfId}).`,
      dtype: isValidTranscriptionDtype(item.dtype) ? item.dtype : 'q8',
      isBuiltIn: false,
    })
  }

  return out
}

export function resolveActiveTranscriptionModel(
  models: readonly TranscriptionModelSpec[],
  activeModelId: string
): TranscriptionModelSpec {
  return (
    models.find((m) => m.id === activeModelId) ??
    models[0] ??
    BUILTIN_TRANSCRIPTION_MODELS[0]
  )
}
