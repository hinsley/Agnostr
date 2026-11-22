/// <reference lib="webworker" />

import type {
  TranscriptionModelDtype,
  TranscriptionModelEngine,
  TranscriptionModelStatus,
  TranscriptionRuntimeDevice,
} from '../types/transcription.ts'

export type WorkerInMessage =
  | {
      type: 'load'
      requestId: string
      engine: TranscriptionModelEngine
      hfModelId: string
      dtype: TranscriptionModelDtype
    }
  | {
      type: 'transcribe'
      requestId: string
      kind: 'memo' | 'live'
      engine: TranscriptionModelEngine
      hfModelId: string
      dtype: TranscriptionModelDtype
      pcm16k: Float32Array
    }
  | {
      type: 'dispose'
    }

export type WorkerOutMessage =
  | {
      type: 'status'
      status: TranscriptionModelStatus
      hfModelId: string
      progress?: number
      file?: string | null
      runtimeDevice?: TranscriptionRuntimeDevice | null
      error?: string
    }
  | {
      type: 'result'
      requestId: string
      kind: 'memo' | 'live'
      text: string
      hfModelId: string
      runtimeDevice: TranscriptionRuntimeDevice
    }
  | {
      type: 'error'
      requestId: string
      kind: 'load' | 'memo' | 'live'
      error: string
    }
  | {
      type: 'dropped'
      requestId: string
    }

interface AsrOutputLike {
  text?: string
}

interface AsrPipelineLike {
  (audio: Float32Array): Promise<AsrOutputLike | AsrOutputLike[]>
  dispose?: () => Promise<void>
}

interface ParakeetSessionLike {
  release?: () => Promise<void>
}

interface ParakeetTensorLike {
  dispose?: () => void
}

interface ParakeetModelLike {
  encoderSession?: ParakeetSessionLike
  joinerSession?: ParakeetSessionLike
  _combState1?: ParakeetTensorLike
  _combState2?: ParakeetTensorLike
  _targetTensor?: ParakeetTensorLike
  _targetLenTensor?: ParakeetTensorLike
  clearIncrementalCache?: () => void
  resetMelCache?: () => void
  transcribe: (
    audio: Float32Array,
    sampleRate?: number,
    opts?: { enableProfiling?: boolean }
  ) => Promise<{ utterance_text?: string }>
  transcribeLongAudio?: (
    audio: Float32Array,
    sampleRate?: number,
    opts?: { chunkLengthS?: number; enableProfiling?: boolean }
  ) => Promise<{ text?: string }>
}

interface ProgressEventLike {
  status?: string
  file?: string
  loaded?: number
  total?: number
  progress?: number
}

interface QueuedJob {
  type: 'load' | 'transcribe'
  requestId: string
  kind: 'load' | 'memo' | 'live'
  engine: TranscriptionModelEngine
  hfModelId: string
  dtype: TranscriptionModelDtype
  pcm16k?: Float32Array
}

interface ActiveModelHandle {
  engine: TranscriptionModelEngine
  key: string
  device: TranscriptionRuntimeDevice
  transformersPipe?: AsrPipelineLike
  parakeetModel?: ParakeetModelLike
}

const SAMPLE_RATE = 16_000
const LONG_AUDIO_THRESHOLD_SAMPLES = SAMPLE_RATE * 28
const CHUNK_SLICE_SAMPLES = SAMPLE_RATE * 25
const MAX_PENDING_LIVE_JOBS = 2

let transformersModulePromise: Promise<typeof import('@huggingface/transformers')> | null = null
let parakeetModulePromise: Promise<typeof import('parakeet.js')> | null = null

let activeHandle: ActiveModelHandle | null = null
let transformersWebGpuFailed = false
let parakeetWebGpuFailed = false

const queue: QueuedJob[] = []
let processing = false

function postOut(msg: WorkerOutMessage): void {
  self.postMessage(msg)
}

function modelCacheKey(
  engine: TranscriptionModelEngine,
  hfModelId: string,
  dtype: TranscriptionModelDtype
): string {
  return `${engine}::${hfModelId}::${JSON.stringify(dtype)}`
}

async function getTransformersModule(): Promise<typeof import('@huggingface/transformers')> {
  if (!transformersModulePromise) {
    transformersModulePromise = import('@huggingface/transformers')
  }
  const mod = await transformersModulePromise
  mod.env.allowLocalModels = false
  mod.env.useBrowserCache = true
  mod.env.useWasmCache = true
  mod.env.cacheKey = 'transformers-cache'
  // On GitHub Pages (crossOriginIsolated === false), SharedArrayBuffer is unavailable.
  // Force single-threaded WASM so ONNX Runtime Web never fails spawning pthreads.
  const wasmEnv = mod.env.backends?.onnx?.wasm
  if (wasmEnv) {
    wasmEnv.proxy = false
    if (!self.crossOriginIsolated) {
      wasmEnv.numThreads = 1
    }
  }
  return mod
}

async function getParakeetModule(): Promise<typeof import('parakeet.js')> {
  if (!parakeetModulePromise) {
    parakeetModulePromise = import('parakeet.js')
  }
  return await parakeetModulePromise
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

  if (prev.transformersPipe && typeof prev.transformersPipe.dispose === 'function') {
    try {
      await prev.transformersPipe.dispose()
    } catch {
      // Ignore disposal errors
    }
  }

  if (prev.parakeetModel) {
    const pm = prev.parakeetModel
    try {
      pm.clearIncrementalCache?.()
      pm.resetMelCache?.()
      pm._combState1?.dispose?.()
      pm._combState2?.dispose?.()
      pm._targetTensor?.dispose?.()
      pm._targetLenTensor?.dispose?.()
    } catch {
      // Ignore tensor cleanup errors
    }
    try {
      await pm.encoderSession?.release?.()
    } catch {
      // Ignore session release errors
    }
    try {
      await pm.joinerSession?.release?.()
    } catch {
      // Ignore session release errors
    }
  }
}

async function ensureTransformersModel(
  hfModelId: string,
  dtype: TranscriptionModelDtype,
  forceWasm = false
): Promise<ActiveModelHandle> {
  const targetKey = modelCacheKey('transformers', hfModelId, dtype)
  if (
    activeHandle &&
    activeHandle.key === targetKey &&
    activeHandle.transformersPipe &&
    (!forceWasm || activeHandle.device === 'wasm')
  ) {
    return activeHandle
  }

  await disposeActiveModel()

  const mod = await getTransformersModule()
  const fileProgress = new Map<string, { loaded: number; total: number }>()
  let lastReportTs = 0
  let lastPercent = -1

  postOut({
    type: 'status',
    status: 'downloading',
    hfModelId,
    progress: 0,
    file: null,
    runtimeDevice: null,
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
    }

    let sumLoaded = 0
    let sumTotal = 0
    for (const entry of fileProgress.values()) {
      if (entry.total > 0) {
        sumLoaded += Math.min(entry.loaded, entry.total)
        sumTotal += entry.total
      }
    }

    let percent = lastPercent >= 0 ? lastPercent : 0
    if (sumTotal > 0) {
      percent = Math.min(99, Math.max(0, Math.round((sumLoaded / sumTotal) * 100)))
    } else if (typeof info.progress === 'number' && Number.isFinite(info.progress)) {
      percent = Math.min(99, Math.max(0, Math.round(info.progress)))
    }

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
        hfModelId,
        progress: percent,
        file: fileName || null,
      })
    }
  }

  const createWithDevice = async (
    device: TranscriptionRuntimeDevice
  ): Promise<AsrPipelineLike> => {
    const options: Record<string, unknown> = {
      device,
      dtype,
      progress_callback: onProgress,
    }
    const loader = mod.pipeline as unknown as (
      task: string,
      model: string,
      opts: Record<string, unknown>
    ) => Promise<AsrPipelineLike>
    return await loader('automatic-speech-recognition', hfModelId, options)
  }

  const gpu = await probeWebGpu()
  const tryWebGpu = !forceWasm && !transformersWebGpuFailed && gpu.available
  let pipe: AsrPipelineLike
  let chosenDevice: TranscriptionRuntimeDevice

  if (tryWebGpu) {
    try {
      pipe = await createWithDevice('webgpu')
      chosenDevice = 'webgpu'
    } catch {
      transformersWebGpuFailed = true
      pipe = await createWithDevice('wasm')
      chosenDevice = 'wasm'
    }
  } else {
    pipe = await createWithDevice('wasm')
    chosenDevice = 'wasm'
  }

  activeHandle = {
    engine: 'transformers',
    key: targetKey,
    device: chosenDevice,
    transformersPipe: pipe,
  }

  postOut({
    type: 'status',
    status: 'ready',
    hfModelId,
    progress: 100,
    file: null,
    runtimeDevice: chosenDevice,
  })

  return activeHandle
}

function weightForParakeetFile(fileName: string): number {
  const lower = fileName.toLowerCase()
  if (lower.includes('encoder')) return 0.96
  if (lower.includes('decoder')) return 0.035
  return 0.005
}

async function ensureParakeetModel(
  hfModelId: string,
  dtype: TranscriptionModelDtype,
  forceWasm = false
): Promise<ActiveModelHandle> {
  const targetKey = modelCacheKey('parakeet', hfModelId, dtype)
  if (
    activeHandle &&
    activeHandle.key === targetKey &&
    activeHandle.parakeetModel &&
    (!forceWasm || activeHandle.device === 'wasm')
  ) {
    return activeHandle
  }

  await disposeActiveModel()

  const parakeet = await getParakeetModule()
  const cpuThreads = self.crossOriginIsolated ? undefined : 1

  postOut({
    type: 'status',
    status: 'downloading',
    hfModelId,
    progress: 0,
    file: null,
    runtimeDevice: null,
  })

  const loadWithBackend = async (
    backend: 'webgpu-hybrid' | 'wasm',
    encoderQuant: 'fp16' | 'int8'
  ): Promise<ParakeetModelLike> => {
    const fileFractions = new Map<string, number>()
    let maxReportedPercent = 0
    let lastReportTs = 0

    const onProgress = (info: { loaded: number; total: number; file: string }) => {
      const file = info.file || ''
      const frac =
        info.total > 0 ? Math.min(1, Math.max(0, info.loaded / info.total)) : 0
      if (file) {
        fileFractions.set(file, Math.max(fileFractions.get(file) ?? 0, frac))
      }

      let weighted = 0
      for (const [name, f] of fileFractions.entries()) {
        weighted += f * weightForParakeetFile(name)
      }
      const percent = Math.min(99, Math.max(maxReportedPercent, Math.round(weighted * 100)))
      const now = Date.now()
      if (percent !== maxReportedPercent || now - lastReportTs > 150) {
        maxReportedPercent = percent
        lastReportTs = now
        postOut({
          type: 'status',
          status: 'downloading',
          hfModelId,
          progress: percent,
          file: file || null,
        })
      }
    }

    const hubResult = await parakeet.getParakeetModel(hfModelId, {
      backend,
      encoderQuant,
      decoderQuant: 'int8',
      preprocessorBackend: 'js',
      progress: onProgress,
    })

    try {
      const model = (await parakeet.ParakeetModel.fromUrls({
        ...hubResult.urls,
        filenames: hubResult.filenames,
        preprocessorBackend: 'js',
        backend,
        cpuThreads,
      })) as unknown as ParakeetModelLike
      return model
    } finally {
      // Revoke temporary blob URLs created from IndexedDB/fetch once sessions are built
      for (const value of Object.values(hubResult.urls)) {
        if (typeof value === 'string' && value.startsWith('blob:')) {
          try {
            URL.revokeObjectURL(value)
          } catch {
            // Ignore revoke failure
          }
        }
      }
    }
  }

  // On WebGPU with shader-f16, use webgpu-hybrid + fp16 encoder (avoids 2.36 GB fp32).
  // Otherwise (or if WebGPU fails), fall back cleanly to int8 (~640 MB) on WASM.
  const gpu = await probeWebGpu()
  const tryWebGpuFp16 =
    !forceWasm && !parakeetWebGpuFailed && gpu.available && gpu.hasFp16

  let model: ParakeetModelLike
  let chosenDevice: TranscriptionRuntimeDevice

  if (tryWebGpuFp16) {
    try {
      model = await loadWithBackend('webgpu-hybrid', 'fp16')
      chosenDevice = 'webgpu'
    } catch {
      parakeetWebGpuFailed = true
      model = await loadWithBackend('wasm', 'int8')
      chosenDevice = 'wasm'
    }
  } else {
    model = await loadWithBackend('wasm', 'int8')
    chosenDevice = 'wasm'
  }

  activeHandle = {
    engine: 'parakeet',
    key: targetKey,
    device: chosenDevice,
    parakeetModel: model,
  }

  postOut({
    type: 'status',
    status: 'ready',
    hfModelId,
    progress: 100,
    file: null,
    runtimeDevice: chosenDevice,
  })

  return activeHandle
}

async function ensureModel(
  engine: TranscriptionModelEngine,
  hfModelId: string,
  dtype: TranscriptionModelDtype,
  forceWasm = false
): Promise<ActiveModelHandle> {
  if (engine === 'parakeet') {
    return await ensureParakeetModel(hfModelId, dtype, forceWasm)
  }
  return await ensureTransformersModel(hfModelId, dtype, forceWasm)
}

function cleanTranscriptText(raw: string): string {
  return raw
    .replace(/\[(?:BLANK_AUDIO|SILENCE|NO_SPEECH|MUSIC|INAUDIBLE)\]/gi, '')
    .replace(/\((?:silence|inaudible|music|blank audio)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractTextFromOutput(out: AsrOutputLike | AsrOutputLike[]): string {
  if (Array.isArray(out)) {
    return out
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .join(' ')
  }
  return typeof out?.text === 'string' ? out.text : ''
}

async function runTranscription(
  handle: ActiveModelHandle,
  pcm16k: Float32Array
): Promise<string> {
  if (handle.engine === 'parakeet' && handle.parakeetModel) {
    if (
      pcm16k.length > LONG_AUDIO_THRESHOLD_SAMPLES &&
      typeof handle.parakeetModel.transcribeLongAudio === 'function'
    ) {
      const longRes = await handle.parakeetModel.transcribeLongAudio(
        pcm16k,
        SAMPLE_RATE,
        { chunkLengthS: 30, enableProfiling: false }
      )
      return cleanTranscriptText(longRes?.text ?? '')
    }
    const res = await handle.parakeetModel.transcribe(pcm16k, SAMPLE_RATE, {
      enableProfiling: false,
    })
    return cleanTranscriptText(res?.utterance_text ?? '')
  }

  const pipe = handle.transformersPipe
  if (!pipe) {
    throw new Error('ASR pipeline is not initialized.')
  }

  if (pcm16k.length <= LONG_AUDIO_THRESHOLD_SAMPLES) {
    const out = await pipe(pcm16k)
    return cleanTranscriptText(extractTextFromOutput(out))
  }

  // Model-agnostic 25s slicing for longer voice memos (up to 90s)
  const parts: string[] = []
  for (let offset = 0; offset < pcm16k.length; offset += CHUNK_SLICE_SAMPLES) {
    const slice = pcm16k.subarray(
      offset,
      Math.min(pcm16k.length, offset + CHUNK_SLICE_SAMPLES)
    )
    if (slice.length < SAMPLE_RATE * 0.25) break
    const out = await pipe(slice)
    const text = cleanTranscriptText(extractTextFromOutput(out))
    if (text) parts.push(text)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true
  try {
    while (queue.length > 0) {
      const job = queue.shift()
      if (!job) continue
      try {
        const handle = await ensureModel(job.engine, job.hfModelId, job.dtype)
        if (job.type === 'load') {
          postOut({
            type: 'result',
            requestId: job.requestId,
            kind: 'memo',
            text: '',
            hfModelId: job.hfModelId,
            runtimeDevice: handle.device,
          })
          continue
        }

        const pcm = job.pcm16k
        if (!pcm || pcm.length === 0) {
          postOut({
            type: 'result',
            requestId: job.requestId,
            kind: job.kind === 'live' ? 'live' : 'memo',
            text: '',
            hfModelId: job.hfModelId,
            runtimeDevice: handle.device,
          })
          continue
        }

        let text: string
        let finalDevice = handle.device
        try {
          text = await runTranscription(handle, pcm)
        } catch (inferErr) {
          if (handle.device === 'webgpu') {
            if (job.engine === 'parakeet') {
              parakeetWebGpuFailed = true
            } else {
              transformersWebGpuFailed = true
            }
            const fallback = await ensureModel(
              job.engine,
              job.hfModelId,
              job.dtype,
              true
            )
            finalDevice = fallback.device
            text = await runTranscription(fallback, pcm)
          } else {
            throw inferErr
          }
        }
        postOut({
          type: 'result',
          requestId: job.requestId,
          kind: job.kind === 'live' ? 'live' : 'memo',
          text,
          hfModelId: job.hfModelId,
          runtimeDevice: finalDevice,
        })
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Local transcription failed.'
        if (job.type === 'load' || !activeHandle) {
          postOut({
            type: 'status',
            status: 'error',
            hfModelId: job.hfModelId,
            error: message,
          })
        }
        postOut({
          type: 'error',
          requestId: job.requestId,
          kind: job.kind,
          error: message,
        })
      }
    }
  } finally {
    processing = false
  }
}

self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'dispose') {
    queue.length = 0
    void disposeActiveModel()
    return
  }

  if (msg.type === 'load') {
    queue.push({
      type: 'load',
      requestId: msg.requestId,
      kind: 'load',
      engine: msg.engine,
      hfModelId: msg.hfModelId,
      dtype: msg.dtype,
    })
    void processQueue()
    return
  }

  if (msg.type === 'transcribe') {
    if (msg.kind === 'live') {
      // Keep live captions real-time by dropping oldest queued live chunks if backlog > 2
      const pendingLiveIndices: number[] = []
      for (let i = 0; i < queue.length; i++) {
        if (queue[i].kind === 'live') pendingLiveIndices.push(i)
      }
      while (pendingLiveIndices.length >= MAX_PENDING_LIVE_JOBS) {
        const dropIdx = pendingLiveIndices.shift()
        if (dropIdx === undefined) break
        const [dropped] = queue.splice(dropIdx, 1)
        if (dropped) {
          postOut({ type: 'dropped', requestId: dropped.requestId })
        }
        for (let j = 0; j < pendingLiveIndices.length; j++) {
          if (pendingLiveIndices[j] > dropIdx) pendingLiveIndices[j] -= 1
        }
      }
    }

    queue.push({
      type: 'transcribe',
      requestId: msg.requestId,
      kind: msg.kind,
      engine: msg.engine,
      hfModelId: msg.hfModelId,
      dtype: msg.dtype,
      pcm16k: msg.pcm16k,
    })
    void processQueue()
  }
}
