/// <reference lib="webworker" />

import type {
  TranscriptionModelDtype,
  TranscriptionModelStatus,
  TranscriptionRuntimeDevice,
} from '../types/transcription.ts'

export type WorkerInMessage =
  | {
      type: 'load'
      requestId: string
      hfModelId: string
      dtype: TranscriptionModelDtype
    }
  | {
      type: 'transcribe'
      requestId: string
      kind: 'memo' | 'live'
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
  hfModelId: string
  dtype: TranscriptionModelDtype
  pcm16k?: Float32Array
}

const SAMPLE_RATE = 16_000
const LONG_AUDIO_THRESHOLD_SAMPLES = SAMPLE_RATE * 28
const CHUNK_SLICE_SAMPLES = SAMPLE_RATE * 25
const MAX_PENDING_LIVE_JOBS = 2

let transformersModulePromise: Promise<typeof import('@huggingface/transformers')> | null = null
let activePipeline: AsrPipelineLike | null = null
let activeModelKey: string | null = null
let activeRuntimeDevice: TranscriptionRuntimeDevice | null = null
let webGpuFailed = false

const queue: QueuedJob[] = []
let processing = false

function postOut(msg: WorkerOutMessage): void {
  self.postMessage(msg)
}

function modelCacheKey(hfModelId: string, dtype: TranscriptionModelDtype): string {
  return `${hfModelId}::${JSON.stringify(dtype)}`
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

async function hasWorkingWebGpu(): Promise<boolean> {
  try {
    const nav = navigator as Navigator & {
      gpu?: { requestAdapter?: () => Promise<unknown> }
    }
    if (!nav.gpu || typeof nav.gpu.requestAdapter !== 'function') return false
    const adapter = await nav.gpu.requestAdapter()
    return Boolean(adapter)
  } catch {
    return false
  }
}

async function disposeActivePipeline(): Promise<void> {
  const prev = activePipeline
  activePipeline = null
  activeModelKey = null
  activeRuntimeDevice = null
  if (prev && typeof prev.dispose === 'function') {
    try {
      await prev.dispose()
    } catch {
      // Ignore disposal errors
    }
  }
}

async function ensurePipeline(
  hfModelId: string,
  dtype: TranscriptionModelDtype,
  forceWasm = false
): Promise<{ pipe: AsrPipelineLike; device: TranscriptionRuntimeDevice }> {
  const targetKey = modelCacheKey(hfModelId, dtype)
  if (
    activePipeline &&
    activeModelKey === targetKey &&
    activeRuntimeDevice &&
    (!forceWasm || activeRuntimeDevice === 'wasm')
  ) {
    return { pipe: activePipeline, device: activeRuntimeDevice }
  }

  await disposeActivePipeline()

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

  const tryWebGpu = !forceWasm && !webGpuFailed && (await hasWorkingWebGpu())
  let pipe: AsrPipelineLike
  let chosenDevice: TranscriptionRuntimeDevice

  if (tryWebGpu) {
    try {
      pipe = await createWithDevice('webgpu')
      chosenDevice = 'webgpu'
    } catch {
      // Fall back cleanly to single-threaded / browser WASM when WebGPU rejects an op
      webGpuFailed = true
      pipe = await createWithDevice('wasm')
      chosenDevice = 'wasm'
    }
  } else {
    pipe = await createWithDevice('wasm')
    chosenDevice = 'wasm'
  }

  activePipeline = pipe
  activeModelKey = targetKey
  activeRuntimeDevice = chosenDevice

  postOut({
    type: 'status',
    status: 'ready',
    hfModelId,
    progress: 100,
    file: null,
    runtimeDevice: chosenDevice,
  })

  return { pipe, device: chosenDevice }
}

function cleanTranscriptText(raw: string): string {
  const cleaned = raw
    .replace(/\[(?:BLANK_AUDIO|SILENCE|NO_SPEECH|MUSIC|INAUDIBLE)\]/gi, '')
    .replace(/\((?:silence|inaudible|music|blank audio)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned
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
  pipe: AsrPipelineLike,
  pcm16k: Float32Array
): Promise<string> {
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
        const { pipe, device } = await ensurePipeline(job.hfModelId, job.dtype)
        if (job.type === 'load') {
          postOut({
            type: 'result',
            requestId: job.requestId,
            kind: 'memo',
            text: '',
            hfModelId: job.hfModelId,
            runtimeDevice: device,
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
            runtimeDevice: device,
          })
          continue
        }

        let text: string
        let finalDevice = device
        try {
          text = await runTranscription(pipe, pcm)
        } catch (inferErr) {
          if (device === 'webgpu') {
            webGpuFailed = true
            const fallback = await ensurePipeline(job.hfModelId, job.dtype, true)
            finalDevice = fallback.device
            text = await runTranscription(fallback.pipe, pcm)
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
        if (job.type === 'load' || !activePipeline) {
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
    void disposeActivePipeline()
    return
  }

  if (msg.type === 'load') {
    queue.push({
      type: 'load',
      requestId: msg.requestId,
      kind: 'load',
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
        // Adjust remaining indices after splice
        for (let j = 0; j < pendingLiveIndices.length; j++) {
          if (pendingLiveIndices[j] > dropIdx) pendingLiveIndices[j] -= 1
        }
      }
    }

    queue.push({
      type: 'transcribe',
      requestId: msg.requestId,
      kind: msg.kind,
      hfModelId: msg.hfModelId,
      dtype: msg.dtype,
      pcm16k: msg.pcm16k,
    })
    void processQueue()
  }
}
