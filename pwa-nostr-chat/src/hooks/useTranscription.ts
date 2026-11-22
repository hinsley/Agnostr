import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActiveCallSession } from '../types/calls.ts'
import type { ToastLevel, VoiceMemoAttachment } from '../types/protocol.ts'
import type {
  LiveCaptionEntry,
  MemoTranscriptState,
  TranscriptionEngine,
  TranscriptionModelSpec,
  TranscriptionModelStatus,
  TranscriptionRuntimeDevice,
} from '../types/transcription.ts'
import {
  decodeBlobToPcm16k,
  LiveStreamSpeechCapturer,
  type CapturedSpeechSegment,
} from '../lib/audioResample.ts'
import {
  loadTranscriptionConfig,
  saveTranscriptionConfig,
} from '../lib/storage.ts'
import type {
  WorkerInMessage,
  WorkerOutMessage,
} from '../lib/transcription.worker.ts'
import {
  createCustomTranscriptionModel,
  DEFAULT_TRANSCRIPTION_MODEL_ID,
  mergeTranscriptionModels,
  resolveActiveTranscriptionModel,
} from '../lib/transcriptionModels.ts'

const MAX_CALL_CAPTION_ENTRIES = 500
const TRANSFORMERS_CACHE_KEY = 'transformers-cache'

export interface UseTranscriptionParams {
  activeCall: ActiveCallSession | null
  fetchVoiceMemoBlob: (
    memo: VoiceMemoAttachment,
    senderPubkey: string
  ) => Promise<string>
  pushToast: (level: ToastLevel, title: string, detail?: string) => void
}

export interface UseTranscriptionResult {
  transcription: TranscriptionEngine
  resetAllTranscription: () => void
}

interface PendingLoadRequest {
  kind: 'load'
  resolve: (ok: boolean) => void
}

interface PendingMemoRequest {
  kind: 'memo'
  memoKey: string
  modelLabel: string
  resolve: () => void
}

interface PendingLiveRequest {
  kind: 'live'
  callId: string
  pubkey: string
  nickname: string
  displayHandle: string
  isSelf: boolean
  timestamp: number
}

type PendingWorkerRequest =
  | PendingLoadRequest
  | PendingMemoRequest
  | PendingLiveRequest

function slugifyTitle(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42)
  return cleaned || 'call'
}

function formatClock(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function useTranscription(
  params: UseTranscriptionParams
): UseTranscriptionResult {
  const { activeCall, fetchVoiceMemoBlob, pushToast } = params

  const initialConfig = useMemo(() => loadTranscriptionConfig(), [])
  const [customModels, setCustomModels] = useState<TranscriptionModelSpec[]>(
    () => initialConfig.customModels
  )
  const [activeModelId, setActiveModelIdState] = useState<string>(
    () => initialConfig.activeModelId
  )

  const models = useMemo(
    () => mergeTranscriptionModels(customModels),
    [customModels]
  )
  const activeModel = useMemo(
    () => resolveActiveTranscriptionModel(models, activeModelId),
    [models, activeModelId]
  )

  const [modelStatus, setModelStatus] =
    useState<TranscriptionModelStatus>('idle')
  const [downloadProgress, setDownloadProgress] = useState<number>(0)
  const [downloadFile, setDownloadFile] = useState<string | null>(null)
  const [runtimeDevice, setRuntimeDevice] =
    useState<TranscriptionRuntimeDevice | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)

  const [memoTranscripts, setMemoTranscripts] = useState<
    Record<string, MemoTranscriptState>
  >({})
  const [liveCaptionsEnabled, setLiveCaptionsEnabled] = useState<boolean>(false)
  const [liveCaptions, setLiveCaptions] = useState<LiveCaptionEntry[]>([])

  const workerRef = useRef<Worker | null>(null)
  const capturerRef = useRef<LiveStreamSpeechCapturer | null>(null)
  const pendingRef = useRef<Map<string, PendingWorkerRequest>>(new Map())
  const reqSeqRef = useRef<number>(0)
  const loadedHfModelIdRef = useRef<string | null>(null)
  const activeCallRef = useRef<ActiveCallSession | null>(activeCall)
  activeCallRef.current = activeCall
  const lastCallIdRef = useRef<string | null>(activeCall?.callId ?? null)

  const activeModelRef = useRef<TranscriptionModelSpec>(activeModel)
  activeModelRef.current = activeModel

  const modelsRef = useRef<TranscriptionModelSpec[]>(models)
  modelsRef.current = models

  const customModelsRef = useRef<TranscriptionModelSpec[]>(customModels)
  customModelsRef.current = customModels

  const memoTranscriptsRef =
    useRef<Record<string, MemoTranscriptState>>(memoTranscripts)
  memoTranscriptsRef.current = memoTranscripts

  const liveCaptionsEnabledRef = useRef<boolean>(liveCaptionsEnabled)
  liveCaptionsEnabledRef.current = liveCaptionsEnabled

  const fetchVoiceMemoBlobRef = useRef(fetchVoiceMemoBlob)
  fetchVoiceMemoBlobRef.current = fetchVoiceMemoBlob

  const pushToastRef = useRef(pushToast)
  pushToastRef.current = pushToast

  const nextRequestId = useCallback((prefix: string): string => {
    reqSeqRef.current += 1
    return `${prefix}-${Date.now()}-${reqSeqRef.current}`
  }, [])

  const stopCapturer = useCallback(() => {
    if (capturerRef.current) {
      capturerRef.current.dispose()
      capturerRef.current = null
    }
  }, [])

  const terminateWorker = useCallback(() => {
    const w = workerRef.current
    workerRef.current = null
    loadedHfModelIdRef.current = null

    for (const req of pendingRef.current.values()) {
      if (req.kind === 'load') {
        req.resolve(false)
      } else if (req.kind === 'memo') {
        req.resolve()
      }
    }
    pendingRef.current.clear()

    if (w) {
      try {
        w.postMessage({ type: 'dispose' } satisfies WorkerInMessage)
      } catch {
        // Ignore
      }
      w.terminate()
    }
  }, [])

  const handleWorkerMessage = useCallback(
    (event: MessageEvent<WorkerOutMessage>) => {
      const msg = event.data
      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'status') {
        if (msg.hfModelId !== activeModelRef.current.hfModelId) return
        setModelStatus(msg.status)
        if (typeof msg.progress === 'number') {
          setDownloadProgress(msg.progress)
        }
        if (msg.file !== undefined) {
          setDownloadFile(msg.file)
        }
        if (msg.runtimeDevice !== undefined) {
          setRuntimeDevice(msg.runtimeDevice)
        }
        if (msg.status === 'ready') {
          loadedHfModelIdRef.current = msg.hfModelId
          setModelError(null)
          setDownloadProgress(100)
          setDownloadFile(null)
        } else if (msg.status === 'error') {
          loadedHfModelIdRef.current = null
          setModelError(msg.error ?? 'Failed to load transcription model.')
        } else if (msg.status === 'downloading') {
          setModelError(null)
        }
        return
      }

      if (msg.type === 'dropped') {
        pendingRef.current.delete(msg.requestId)
        return
      }

      const pending = pendingRef.current.get(msg.requestId)
      if (!pending) return
      pendingRef.current.delete(msg.requestId)

      if (msg.type === 'result') {
        loadedHfModelIdRef.current = msg.hfModelId
        setRuntimeDevice(msg.runtimeDevice)

        if (pending.kind === 'load') {
          pending.resolve(true)
          return
        }

        if (pending.kind === 'memo') {
          const text = msg.text.trim()
          setMemoTranscripts((prev) => ({
            ...prev,
            [pending.memoKey]: {
              status: 'done',
              text: text || '(No speech detected)',
              modelLabel: pending.modelLabel,
              updatedAt: Date.now(),
            },
          }))
          pending.resolve()
          return
        }

        if (pending.kind === 'live') {
          const text = msg.text.trim()
          if (
            !text ||
            !liveCaptionsEnabledRef.current ||
            activeCallRef.current?.callId !== pending.callId
          ) {
            return
          }
          const entry: LiveCaptionEntry = {
            id: msg.requestId,
            pubkey: pending.pubkey,
            nickname: pending.nickname,
            displayHandle: pending.displayHandle,
            isSelf: pending.isSelf,
            text,
            timestamp: pending.timestamp,
          }
          setLiveCaptions((prev) => {
            const next = [...prev, entry]
            return next.length > MAX_CALL_CAPTION_ENTRIES
              ? next.slice(-MAX_CALL_CAPTION_ENTRIES)
              : next
          })
          return
        }
      }

      if (msg.type === 'error') {
        if (pending.kind === 'load') {
          pending.resolve(false)
          return
        }
        if (pending.kind === 'memo') {
          setMemoTranscripts((prev) => ({
            ...prev,
            [pending.memoKey]: {
              status: 'error',
              error: msg.error,
              modelLabel: pending.modelLabel,
              updatedAt: Date.now(),
            },
          }))
          pending.resolve()
        }
      }
    },
    []
  )

  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current
    if (typeof Worker === 'undefined') {
      throw new Error('Web Workers are unavailable in this browser.')
    }
    const worker = new Worker(
      new URL('../lib/transcription.worker.ts', import.meta.url),
      { type: 'module' }
    )
    worker.onmessage = handleWorkerMessage
    worker.onerror = (ev) => {
      const errMsg = ev.message || 'Transcription worker crashed.'
      setModelStatus('error')
      setModelError(errMsg)
      loadedHfModelIdRef.current = null
      for (const req of pendingRef.current.values()) {
        if (req.kind === 'load') {
          req.resolve(false)
        } else if (req.kind === 'memo') {
          setMemoTranscripts((prev) => ({
            ...prev,
            [req.memoKey]: {
              status: 'error',
              error: errMsg,
              modelLabel: req.modelLabel,
              updatedAt: Date.now(),
            },
          }))
          req.resolve()
        }
      }
      pendingRef.current.clear()
      worker.terminate()
      if (workerRef.current === worker) {
        workerRef.current = null
      }
    }
    workerRef.current = worker
    return worker
  }, [handleWorkerMessage])

  const preloadModel = useCallback(async (): Promise<boolean> => {
    const model = activeModelRef.current
    if (
      loadedHfModelIdRef.current === model.hfModelId &&
      workerRef.current
    ) {
      setModelStatus('ready')
      setDownloadProgress(100)
      return true
    }

    try {
      const worker = ensureWorker()
      const requestId = nextRequestId('load')
      setModelStatus('downloading')
      setDownloadProgress(0)
      setDownloadFile(null)
      setModelError(null)

      return await new Promise<boolean>((resolve) => {
        pendingRef.current.set(requestId, { kind: 'load', resolve })
        const payload: WorkerInMessage = {
          type: 'load',
          requestId,
          hfModelId: model.hfModelId,
          dtype: model.dtype,
        }
        worker.postMessage(payload)
      })
    } catch (err) {
      const errMsg =
        err instanceof Error ? err.message : 'Unable to initialize worker.'
      setModelStatus('error')
      setModelError(errMsg)
      return false
    }
  }, [ensureWorker, nextRequestId])

  const setActiveModelId = useCallback(
    (modelId: string) => {
      const found = modelsRef.current.find((m) => m.id === modelId)
      if (!found) return
      setActiveModelIdState(found.id)
      saveTranscriptionConfig({
        activeModelId: found.id,
        customModels: customModelsRef.current,
      })

      if (loadedHfModelIdRef.current !== found.hfModelId) {
        setModelStatus('idle')
        setDownloadProgress(0)
        setDownloadFile(null)
        setModelError(null)
        if (liveCaptionsEnabledRef.current && activeCallRef.current) {
          activeModelRef.current = found
          void preloadModel()
        }
      } else {
        setModelStatus('ready')
        setDownloadProgress(100)
        setModelError(null)
      }
    },
    [preloadModel]
  )

  const addCustomModel = useCallback(
    (rawHfModelId: string, label?: string): boolean => {
      const created = createCustomTranscriptionModel(rawHfModelId, label)
      if (!created) {
        pushToastRef.current(
          'warning',
          'Invalid Hugging Face model ID',
          'Expected format: org/model-name (e.g. onnx-community/whisper-tiny.en)'
        )
        return false
      }

      const duplicate = modelsRef.current.find(
        (m) =>
          m.id === created.id ||
          m.hfModelId.toLowerCase() === created.hfModelId.toLowerCase()
      )
      if (duplicate) {
        setActiveModelId(duplicate.id)
        pushToastRef.current(
          'info',
          'Model already added',
          `Selected ${duplicate.label}.`
        )
        return true
      }

      const nextCustom = [...customModelsRef.current, created]
      customModelsRef.current = nextCustom
      setCustomModels(nextCustom)
      setActiveModelIdState(created.id)
      saveTranscriptionConfig({
        activeModelId: created.id,
        customModels: nextCustom,
      })

      if (loadedHfModelIdRef.current !== created.hfModelId) {
        setModelStatus('idle')
        setDownloadProgress(0)
        setDownloadFile(null)
        setModelError(null)
      }

      pushToastRef.current(
        'success',
        `Added ${created.label}`,
        `Selected ${created.hfModelId} for local transcription.`
      )
      return true
    },
    [setActiveModelId]
  )

  const removeCustomModel = useCallback((modelId: string) => {
    const target = customModelsRef.current.find((m) => m.id === modelId)
    if (!target || target.isBuiltIn) return

    const nextCustom = customModelsRef.current.filter((m) => m.id !== modelId)
    customModelsRef.current = nextCustom
    setCustomModels(nextCustom)

    const nextActiveId =
      activeModelRef.current.id === modelId
        ? DEFAULT_TRANSCRIPTION_MODEL_ID
        : activeModelRef.current.id
    setActiveModelIdState(nextActiveId)
    saveTranscriptionConfig({
      activeModelId: nextActiveId,
      customModels: nextCustom,
    })

    if (activeModelRef.current.id === modelId) {
      setModelStatus('idle')
      setDownloadProgress(0)
      setDownloadFile(null)
      setModelError(null)
    }
    pushToastRef.current('info', `Removed ${target.label}`)
  }, [])

  const clearModelCache = useCallback(async (): Promise<void> => {
    stopCapturer()
    setLiveCaptionsEnabled(false)
    terminateWorker()
    setModelStatus('idle')
    setDownloadProgress(0)
    setDownloadFile(null)
    setRuntimeDevice(null)
    setModelError(null)

    try {
      if (typeof caches !== 'undefined') {
        await caches.delete(TRANSFORMERS_CACHE_KEY)
      }
      pushToastRef.current(
        'info',
        'Model cache cleared',
        'Cached local speech models removed from browser storage.'
      )
    } catch {
      pushToastRef.current(
        'warning',
        'Cache clear incomplete',
        'Browser storage prevented removing cached model weights.'
      )
    }
  }, [stopCapturer, terminateWorker])

  // On-demand voice memo transcription (strictly reuses Trusted-Peers gated fetchVoiceMemoBlob)
  const transcribeVoiceMemo = useCallback(
    async (
      memoKey: string,
      memo: VoiceMemoAttachment,
      senderPubkey: string
    ): Promise<void> => {
      if (!memoKey) return
      if (memoTranscriptsRef.current[memoKey]?.status === 'loading') return

      const model = activeModelRef.current
      setMemoTranscripts((prev) => ({
        ...prev,
        [memoKey]: {
          status: 'loading',
          modelLabel: model.label,
          updatedAt: Date.now(),
        },
      }))

      try {
        // Strict engine-level Trusted-Peers guard (never fetches untrusted memos)
        const blobUrl = await fetchVoiceMemoBlobRef.current(memo, senderPubkey)
        const response = await fetch(blobUrl)
        const blob = await response.blob()
        const pcm16k = await decodeBlobToPcm16k(blob)

        const worker = ensureWorker()
        const requestId = nextRequestId('memo')

        await new Promise<void>((resolve) => {
          pendingRef.current.set(requestId, {
            kind: 'memo',
            memoKey,
            modelLabel: model.label,
            resolve,
          })
          const payload: WorkerInMessage = {
            type: 'transcribe',
            requestId,
            kind: 'memo',
            hfModelId: model.hfModelId,
            dtype: model.dtype,
            pcm16k,
          }
          worker.postMessage(payload, [pcm16k.buffer])
        })
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'Unable to transcribe voice memo.'
        setMemoTranscripts((prev) => ({
          ...prev,
          [memoKey]: {
            status: 'error',
            error: message,
            modelLabel: model.label,
            updatedAt: Date.now(),
          },
        }))
      }
    },
    [ensureWorker, nextRequestId]
  )

  const handleCapturedSpeechSegment = useCallback(
    (segment: CapturedSpeechSegment) => {
      if (!liveCaptionsEnabledRef.current) return
      const call = activeCallRef.current
      if (!call) return

      const model = activeModelRef.current
      try {
        const worker = ensureWorker()
        const requestId = nextRequestId('live')
        pendingRef.current.set(requestId, {
          kind: 'live',
          callId: call.callId,
          pubkey: segment.pubkey,
          nickname: segment.nickname,
          displayHandle: segment.displayHandle,
          isSelf: segment.isSelf,
          timestamp: segment.timestamp,
        })
        const payload: WorkerInMessage = {
          type: 'transcribe',
          requestId,
          kind: 'live',
          hfModelId: model.hfModelId,
          dtype: model.dtype,
          pcm16k: segment.pcm16k,
        }
        worker.postMessage(payload, [segment.pcm16k.buffer])
      } catch {
        // Ignore transient worker error on live chunk
      }
    },
    [ensureWorker, nextRequestId]
  )

  const toggleLiveCaptions = useCallback(() => {
    if (liveCaptionsEnabledRef.current) {
      liveCaptionsEnabledRef.current = false
      setLiveCaptionsEnabled(false)
      stopCapturer()
      return
    }

    if (!activeCallRef.current) {
      pushToastRef.current(
        'info',
        'Join a call first',
        'Live captions (CC) capture audio during an active voice or video call.'
      )
      return
    }

    liveCaptionsEnabledRef.current = true
    setLiveCaptionsEnabled(true)
    void preloadModel().then((ok) => {
      if (!ok && liveCaptionsEnabledRef.current) {
        liveCaptionsEnabledRef.current = false
        setLiveCaptionsEnabled(false)
        stopCapturer()
        pushToastRef.current(
          'error',
          'Live captions unavailable',
          'Failed to initialize the local speech recognition model.'
        )
      }
    })
  }, [preloadModel, stopCapturer])

  // Lifecycle sync between activeCall, liveCaptionsEnabled, and LiveStreamSpeechCapturer
  useEffect(() => {
    const currentCallId = activeCall?.callId ?? null

    if (!activeCall) {
      stopCapturer()
      if (liveCaptionsEnabledRef.current) {
        liveCaptionsEnabledRef.current = false
        setLiveCaptionsEnabled(false)
      }
      if (lastCallIdRef.current !== null) {
        lastCallIdRef.current = null
        setLiveCaptions([])
      }
      return
    }

    if (lastCallIdRef.current && lastCallIdRef.current !== currentCallId) {
      setLiveCaptions([])
    }
    lastCallIdRef.current = currentCallId

    if (!liveCaptionsEnabled) {
      stopCapturer()
      return
    }

    if (!capturerRef.current) {
      const capturer = new LiveStreamSpeechCapturer(handleCapturedSpeechSegment)
      capturerRef.current = capturer
      void capturer.start(activeCall.participants).catch((err) => {
        stopCapturer()
        liveCaptionsEnabledRef.current = false
        setLiveCaptionsEnabled(false)
        pushToastRef.current(
          'error',
          'Caption audio capture failed',
          err instanceof Error ? err.message : 'Web Audio capture unavailable.'
        )
      })
    } else {
      capturerRef.current.syncParticipants(activeCall.participants)
    }
  }, [activeCall, liveCaptionsEnabled, handleCapturedSpeechSegment, stopCapturer])

  // Clean up capturer & worker on unmount
  useEffect(() => {
    return () => {
      stopCapturer()
      terminateWorker()
    }
  }, [stopCapturer, terminateWorker])

  const clearCallTranscript = useCallback(() => {
    setLiveCaptions([])
  }, [])

  const exportCallTranscriptMarkdown = useCallback(() => {
    const callTitle = activeCallRef.current?.title || 'Call'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const slug = slugifyTitle(callTitle)
    const lines: string[] = [
      `# Agnostr Call Transcript — ${callTitle}`,
      '',
      `- **Exported**: ${new Date().toISOString()}`,
      `- **Model**: ${activeModelRef.current.label} (${activeModelRef.current.hfModelId})`,
      `- **Entries**: ${liveCaptions.length}`,
      '',
      '---',
      '',
    ]

    for (const entry of liveCaptions) {
      const who = entry.isSelf
        ? `${entry.displayHandle} (you)`
        : entry.displayHandle
      lines.push(`- **[${formatClock(entry.timestamp)}] ${who}**: ${entry.text}`)
    }

    return {
      filename: `agnostr-transcript-${slug}-${stamp}.md`,
      mimeType: 'text/markdown;charset=utf-8',
      content: lines.join('\n'),
    }
  }, [liveCaptions])

  const resetAllTranscription = useCallback(() => {
    stopCapturer()
    terminateWorker()
    liveCaptionsEnabledRef.current = false
    setLiveCaptionsEnabled(false)
    setLiveCaptions([])
    setMemoTranscripts({})
    customModelsRef.current = []
    setCustomModels([])
    setActiveModelIdState(DEFAULT_TRANSCRIPTION_MODEL_ID)
    setModelStatus('idle')
    setDownloadProgress(0)
    setDownloadFile(null)
    setRuntimeDevice(null)
    setModelError(null)
    lastCallIdRef.current = null
  }, [stopCapturer, terminateWorker])

  const transcription: TranscriptionEngine = useMemo(
    () => ({
      models,
      activeModelId: activeModel.id,
      activeModel,
      setActiveModelId,
      addCustomModel,
      removeCustomModel,
      modelStatus,
      downloadProgress,
      downloadFile,
      runtimeDevice,
      modelError,
      preloadModel,
      clearModelCache,
      memoTranscripts,
      transcribeVoiceMemo,
      liveCaptionsEnabled,
      toggleLiveCaptions,
      liveCaptions,
      clearCallTranscript,
      exportCallTranscriptMarkdown,
    }),
    [
      models,
      activeModel,
      setActiveModelId,
      addCustomModel,
      removeCustomModel,
      modelStatus,
      downloadProgress,
      downloadFile,
      runtimeDevice,
      modelError,
      preloadModel,
      clearModelCache,
      memoTranscripts,
      transcribeVoiceMemo,
      liveCaptionsEnabled,
      toggleLiveCaptions,
      liveCaptions,
      clearCallTranscript,
      exportCallTranscriptMarkdown,
    ]
  )

  return {
    transcription,
    resetAllTranscription,
  }
}
