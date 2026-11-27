import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActiveCallSession } from '../types/calls.ts'
import type { ToastLevel, VoiceMemoAttachment } from '../types/protocol.ts'
import type {
  CallTranscriptSyncDigest,
  CallTranscriptSyncPayload,
  EndedCallTranscript,
  LiveCaptionEntry,
  MemoTranscriptState,
  SavedCallTranscript,
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
  buildCallTranscriptSyncDigest,
  clearCallTranscriptDraft,
  clearCallTranscriptStore,
  clearSavedCallTranscriptsInStore,
  createEmptyCallTranscriptStore,
  deleteSavedCallTranscriptInStore,
  formatCallTranscriptArtifact,
  loadCallTranscriptStore,
  makeCallTranscriptId,
  mergeCallTranscriptSyncPayload,
  pruneExpiredCallTranscriptStore,
  recoverCrashDraftIntoStore,
  saveCallTranscriptDraft,
  saveCallTranscriptStore,
  selectDeltaCallTranscripts,
  upsertFinalizedCallTranscript,
} from '../lib/callTranscriptStore.ts'
import {
  clearMemoTranscriptCache,
  loadMemoTranscriptCache,
  loadTranscriptionConfig,
  saveMemoTranscriptCache,
  saveTranscriptionConfig,
  type PersistedMemoTranscriptEntry,
} from '../lib/storage.ts'
import type {
  WorkerInMessage,
  WorkerOutMessage,
} from '../lib/transcription.worker.ts'
import {
  createCustomTranscriptionModel,
  DEFAULT_AUTO_TRANSCRIBE,
  DEFAULT_TRANSCRIPTION_MODEL_ID,
  mergeTranscriptionModels,
  resolveActiveTranscriptionModel,
} from '../lib/transcriptionModels.ts'

const MAX_CALL_CAPTION_ENTRIES = 500
const TRANSFORMERS_CACHE_KEY = 'transformers-cache'
const PARAKEET_IDB_NAME = 'parakeet-cache-db'
const IDLE_WORKER_TEARDOWN_MS = 5 * 60 * 1000 // Reclaim WASM/ONNX RAM after 5m idle with no active call or job
const CALL_TRANSCRIPT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000 // Periodic 30-day retention sweep while open

export interface UseTranscriptionParams {
  activeCall: ActiveCallSession | null
  fetchVoiceMemoBlob: (
    memo: VoiceMemoAttachment,
    senderPubkey: string
  ) => Promise<string>
  pushToast: (level: ToastLevel, title: string, detail?: string) => void
  onCallTranscriptsChanged?: () => void
}

export interface UseTranscriptionResult {
  transcription: TranscriptionEngine
  resetAllTranscription: () => void
  exportCallTranscriptsSyncDigest: () => CallTranscriptSyncDigest
  exportCallTranscriptsSyncPayload: (
    knownHashes?: Record<string, string>,
    remoteDeleted?: Record<string, number>
  ) => CallTranscriptSyncPayload
  mergeCallTranscriptsSyncPayload: (remote: unknown) => number
}

interface PendingLoadRequest {
  kind: 'load'
  resolve: (ok: boolean) => void
}

interface PendingMemoRequest {
  kind: 'memo'
  memoKey: string
  canonicalKey: string
  modelLabel: string
  resolve: () => void
}

interface PendingBlobRequest {
  kind: 'blob'
  resolve: (text: string) => void
  reject: (err: Error) => void
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
  | PendingBlobRequest
  | PendingLiveRequest

interface QueuedMemoItem {
  memoKey: string
  canonicalKey: string
  memo: VoiceMemoAttachment
  senderPubkey: string
  resolvers: Array<() => void>
}

function deleteIndexedDbSafe(name: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve()
  return new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}

function buildFinalizedSignature(callId: string, entries: readonly LiveCaptionEntry[]): string {
  const lastId = entries[entries.length - 1]?.id ?? ''
  return `${callId}:${entries.length}:${lastId}`
}

export function useTranscription(
  params: UseTranscriptionParams
): UseTranscriptionResult {
  const { activeCall, fetchVoiceMemoBlob, pushToast, onCallTranscriptsChanged } = params

  const initialConfig = useMemo(() => loadTranscriptionConfig(), [])
  const [customModels, setCustomModels] = useState<TranscriptionModelSpec[]>(
    () => initialConfig.customModels
  )
  const [activeModelId, setActiveModelIdState] = useState<string>(
    () => initialConfig.activeModelId
  )
  const [autoTranscribe, setAutoTranscribeState] = useState<boolean>(
    () => initialConfig.autoTranscribe
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
  const modelErrorRef = useRef<string | null>(modelError)
  modelErrorRef.current = modelError

  const initialPersistedTranscripts = useMemo(() => loadMemoTranscriptCache(), [])
  const persistedTranscriptsRef = useRef<Record<string, PersistedMemoTranscriptEntry>>(
    initialPersistedTranscripts
  )

  const [memoTranscripts, setMemoTranscripts] = useState<
    Record<string, MemoTranscriptState>
  >(() => {
    const hydrated: Record<string, MemoTranscriptState> = {}
    for (const [key, entry] of Object.entries(initialPersistedTranscripts)) {
      hydrated[key] = {
        status: 'done',
        text: entry.text,
        modelLabel: entry.modelLabel,
        updatedAt: entry.updatedAt,
      }
    }
    return hydrated
  })
  const [cachedTranscriptCount, setCachedTranscriptCount] = useState<number>(
    () => Object.keys(initialPersistedTranscripts).length
  )
  const [liveCaptionsEnabled, setLiveCaptionsEnabled] = useState<boolean>(false)
  const [liveCaptions, setLiveCaptions] = useState<LiveCaptionEntry[]>([])
  const [endedCallTranscript, setEndedCallTranscript] =
    useState<EndedCallTranscript | null>(null)

  const initialCallTranscriptStore = useMemo(() => loadCallTranscriptStore(), [])
  const callTranscriptStoreRef = useRef<CallTranscriptSyncPayload>(initialCallTranscriptStore)
  const [savedCallTranscripts, setSavedCallTranscripts] = useState<SavedCallTranscript[]>(
    () => initialCallTranscriptStore.transcripts
  )
  const lastSavedSignatureRef = useRef<string | null>(null)

  const workerRef = useRef<Worker | null>(null)
  const idleTeardownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const capturerRef = useRef<LiveStreamSpeechCapturer | null>(null)
  const pendingRef = useRef<Map<string, PendingWorkerRequest>>(new Map())
  const memoQueueRef = useRef<QueuedMemoItem[]>([])
  const memoQueueRunningRef = useRef<boolean>(false)
  const activeMemoKeyRef = useRef<string | null>(null)
  const reqSeqRef = useRef<number>(0)
  const loadedModelKeyRef = useRef<string | null>(null)
  const downloadCancelledRef = useRef<boolean>(false)
  const activeCallRef = useRef<ActiveCallSession | null>(activeCall)
  activeCallRef.current = activeCall
  const lastCallIdRef = useRef<string | null>(activeCall?.callId ?? null)
  const activeCallMetaRef = useRef<{
    callId: string
    title: string
    startedAt: number
  } | null>(
    activeCall
      ? {
          callId: activeCall.callId,
          title: activeCall.title,
          startedAt: activeCall.connectedAt ?? activeCall.startedAt,
        }
      : null
  )
  const liveCaptionsRef = useRef<LiveCaptionEntry[]>(liveCaptions)
  liveCaptionsRef.current = liveCaptions
  const endedCallTranscriptRef = useRef<EndedCallTranscript | null>(endedCallTranscript)
  endedCallTranscriptRef.current = endedCallTranscript

  const activeModelRef = useRef<TranscriptionModelSpec>(activeModel)
  activeModelRef.current = activeModel

  const modelsRef = useRef<TranscriptionModelSpec[]>(models)
  modelsRef.current = models

  const customModelsRef = useRef<TranscriptionModelSpec[]>(customModels)
  customModelsRef.current = customModels

  const autoTranscribeRef = useRef<boolean>(autoTranscribe)
  autoTranscribeRef.current = autoTranscribe

  const memoTranscriptsRef =
    useRef<Record<string, MemoTranscriptState>>(memoTranscripts)
  memoTranscriptsRef.current = memoTranscripts

  const liveCaptionsEnabledRef = useRef<boolean>(liveCaptionsEnabled)
  liveCaptionsEnabledRef.current = liveCaptionsEnabled

  const fetchVoiceMemoBlobRef = useRef(fetchVoiceMemoBlob)
  fetchVoiceMemoBlobRef.current = fetchVoiceMemoBlob

  const pushToastRef = useRef(pushToast)
  pushToastRef.current = pushToast

  const onCallTranscriptsChangedRef = useRef(onCallTranscriptsChanged)
  onCallTranscriptsChangedRef.current = onCallTranscriptsChanged

  const sweepExpiredCallTranscripts = useCallback(() => {
    const { store: pruned, changed } = pruneExpiredCallTranscriptStore(
      callTranscriptStoreRef.current
    )
    if (!changed) return
    const persisted = saveCallTranscriptStore(pruned)
    callTranscriptStoreRef.current = persisted
    setSavedCallTranscripts(persisted.transcripts)
    onCallTranscriptsChangedRef.current?.()
  }, [])

  const writeActiveCallDraft = useCallback((entries: readonly LiveCaptionEntry[]) => {
    const call = activeCallRef.current
    const meta = activeCallMetaRef.current
    const callId = call?.callId ?? lastCallIdRef.current
    if (!callId || entries.length === 0) return
    const now = Date.now()
    const startedAt =
      call?.connectedAt ??
      call?.startedAt ??
      meta?.startedAt ??
      entries[0]?.timestamp ??
      now
    const model = activeModelRef.current
    saveCallTranscriptDraft({
      v: 1,
      callId,
      callTitle: call?.title || meta?.title || 'Call',
      startedAt,
      updatedAt: now,
      modelLabel: model.label,
      hfModelId: model.hfModelId,
      entries: [...entries],
    })
  }, [])

  /**
   * Finalize-only persistence & SHA-256 hashing.
   * Called strictly when recording finishes (call end, live captions toggled off,
   * direct call switch, or pagehide/unmount) — NEVER while live captions stream in.
   */
  const finalizeAndSaveCallTranscript = useCallback(
    (opts: {
      callId: string
      callTitle: string
      startedAt: number
      endedAt?: number
      entries: readonly LiveCaptionEntry[]
      setEndedSnapshot?: boolean
      updateState?: boolean
      notifySync?: boolean
    }): SavedCallTranscript | null => {
      const {
        callId,
        callTitle,
        startedAt,
        entries,
        setEndedSnapshot = false,
        updateState = true,
        notifySync = true,
      } = opts
      if (!callId || entries.length === 0) return null

      const endedAt = opts.endedAt ?? Date.now()
      const signature = buildFinalizedSignature(callId, entries)
      const model = activeModelRef.current
      const targetId = makeCallTranscriptId(callId)

      let saved: SavedCallTranscript | null = null
      let changed = false

      if (lastSavedSignatureRef.current === signature) {
        saved =
          callTranscriptStoreRef.current.transcripts.find((t) => t.id === targetId) ?? null
        if (saved) {
          clearCallTranscriptDraft()
        }
      }

      if (!saved) {
        const res = upsertFinalizedCallTranscript(
          callTranscriptStoreRef.current,
          {
            callId,
            callTitle,
            startedAt,
            endedAt,
            modelLabel: model.label,
            hfModelId: model.hfModelId,
            entries,
          },
          endedAt
        )
        saved = res.saved
        changed = res.changed
        if (saved) {
          lastSavedSignatureRef.current = signature
          const persisted = saveCallTranscriptStore(res.store)
          callTranscriptStoreRef.current = persisted
          clearCallTranscriptDraft()
          if (updateState) {
            setSavedCallTranscripts(persisted.transcripts)
          }
          if (changed && notifySync) {
            onCallTranscriptsChangedRef.current?.()
          }
        }
      }

      if (setEndedSnapshot && updateState) {
        const artifactSource = saved ?? {
          callTitle,
          startedAt,
          endedAt,
          modelLabel: model.label,
          hfModelId: model.hfModelId,
          entries,
        }
        const artifact = formatCallTranscriptArtifact(artifactSource)
        const snapshot: EndedCallTranscript = {
          id: saved?.id ?? `${callId}:${endedAt}`,
          callTitle: artifactSource.callTitle,
          startedAt: artifactSource.startedAt,
          endedAt: artifactSource.endedAt,
          modelLabel: artifactSource.modelLabel,
          entries: [...artifactSource.entries],
          filename: artifact.filename,
          markdown: artifact.markdown,
          plainText: artifact.plainText,
          contentHash: saved?.contentHash,
          savedAt: saved?.savedAt,
        }
        endedCallTranscriptRef.current = snapshot
        setEndedCallTranscript(snapshot)
      }

      return saved
    },
    []
  )

  const loadedKeyForModel = (m: TranscriptionModelSpec) =>
    `${m.engine}::${m.hfModelId}`

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

  const clearMemoQueue = useCallback(() => {
    const queued = memoQueueRef.current.splice(0)
    activeMemoKeyRef.current = null
    for (const item of queued) {
      for (const res of item.resolvers) res()
    }
  }, [])

  const clearIdleTeardownTimer = useCallback(() => {
    if (idleTeardownTimerRef.current !== null) {
      clearTimeout(idleTeardownTimerRef.current)
      idleTeardownTimerRef.current = null
    }
  }, [])

  const terminateWorker = useCallback(() => {
    clearIdleTeardownTimer()
    const w = workerRef.current
    workerRef.current = null
    loadedModelKeyRef.current = null

    for (const req of pendingRef.current.values()) {
      if (req.kind === 'load') {
        req.resolve(false)
      } else if (req.kind === 'memo') {
        req.resolve()
      } else if (req.kind === 'blob') {
        req.reject(new Error('Transcription worker was stopped.'))
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
  }, [clearIdleTeardownTimer])

  const scheduleIdleWorkerTeardown = useCallback(() => {
    clearIdleTeardownTimer()
    if (!workerRef.current) return
    if (
      activeCallRef.current ||
      pendingRef.current.size > 0 ||
      memoQueueRef.current.length > 0 ||
      memoQueueRunningRef.current
    ) {
      return
    }

    idleTeardownTimerRef.current = setTimeout(() => {
      idleTeardownTimerRef.current = null
      if (
        !workerRef.current ||
        activeCallRef.current ||
        pendingRef.current.size > 0 ||
        memoQueueRef.current.length > 0 ||
        memoQueueRunningRef.current
      ) {
        return
      }
      terminateWorker()
      setModelStatus('idle')
      setDownloadProgress(0)
      setDownloadFile(null)
      setRuntimeDevice(null)
      setModelError(null)
    }, IDLE_WORKER_TEARDOWN_MS)
  }, [clearIdleTeardownTimer, terminateWorker])

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
          loadedModelKeyRef.current = loadedKeyForModel(activeModelRef.current)
          setModelError(null)
          setDownloadProgress(100)
          setDownloadFile(null)
        } else if (msg.status === 'error') {
          loadedModelKeyRef.current = null
          setModelError(msg.error ?? 'Failed to load transcription model.')
        } else if (msg.status === 'downloading') {
          setModelError(null)
        }
        return
      }

      if (msg.type === 'dropped') {
        const dropped = pendingRef.current.get(msg.requestId)
        pendingRef.current.delete(msg.requestId)
        if (dropped?.kind === 'blob') {
          dropped.reject(new Error('Transcription request was dropped.'))
        }
        scheduleIdleWorkerTeardown()
        return
      }

      const pending = pendingRef.current.get(msg.requestId)
      if (!pending) return
      pendingRef.current.delete(msg.requestId)

      if (msg.type === 'result') {
        if (msg.hfModelId === activeModelRef.current.hfModelId) {
          loadedModelKeyRef.current = loadedKeyForModel(activeModelRef.current)
        }
        setRuntimeDevice(msg.runtimeDevice)

        if (pending.kind === 'load') {
          pending.resolve(true)
          scheduleIdleWorkerTeardown()
          return
        }

        if (pending.kind === 'memo') {
          const text = msg.text.trim()
          const now = Date.now()
          const nextState: MemoTranscriptState = {
            status: 'done',
            text: text || '(No speech detected)',
            modelLabel: pending.modelLabel,
            updatedAt: now,
          }
          if (text.length > 0) {
            const nextPersisted = saveMemoTranscriptCache({
              ...persistedTranscriptsRef.current,
              [pending.canonicalKey]: {
                text,
                modelLabel: pending.modelLabel,
                updatedAt: now,
              },
            })
            persistedTranscriptsRef.current = nextPersisted
            setCachedTranscriptCount(Object.keys(nextPersisted).length)
          }
          setMemoTranscripts((prev) => {
            const updated: Record<string, MemoTranscriptState> = {
              ...prev,
              [pending.memoKey]: nextState,
            }
            if (pending.canonicalKey && pending.canonicalKey !== pending.memoKey) {
              updated[pending.canonicalKey] = nextState
            }
            return updated
          })
          pending.resolve()
          scheduleIdleWorkerTeardown()
          return
        }

        if (pending.kind === 'blob') {
          pending.resolve(msg.text.trim())
          scheduleIdleWorkerTeardown()
          return
        }

        if (pending.kind === 'live') {
          const text = msg.text.trim()
          if (
            !text ||
            !liveCaptionsEnabledRef.current ||
            activeCallRef.current?.callId !== pending.callId
          ) {
            scheduleIdleWorkerTeardown()
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
          const next = [...liveCaptionsRef.current, entry]
          const capped =
            next.length > MAX_CALL_CAPTION_ENTRIES
              ? next.slice(-MAX_CALL_CAPTION_ENTRIES)
              : next
          liveCaptionsRef.current = capped
          setLiveCaptions(capped)
          // Crash-safe unhashed draft write (ZERO SHA-256 hashing during active call!)
          writeActiveCallDraft(capped)
          scheduleIdleWorkerTeardown()
          return
        }
      }

      if (msg.type === 'error') {
        if (pending.kind === 'load') {
          pending.resolve(false)
          scheduleIdleWorkerTeardown()
          return
        }
        if (pending.kind === 'blob') {
          pending.reject(new Error(msg.error || 'Unable to transcribe audio.'))
          scheduleIdleWorkerTeardown()
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
          scheduleIdleWorkerTeardown()
        }
      }
    },
    [scheduleIdleWorkerTeardown, writeActiveCallDraft]
  )

  const ensureWorker = useCallback((): Worker => {
    clearIdleTeardownTimer()
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
      loadedModelKeyRef.current = null
      for (const req of pendingRef.current.values()) {
        if (req.kind === 'load') {
          req.resolve(false)
        } else if (req.kind === 'blob') {
          req.reject(new Error(errMsg))
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
  }, [clearIdleTeardownTimer, handleWorkerMessage])

  const preloadModel = useCallback(async (): Promise<boolean> => {
    downloadCancelledRef.current = false
    const model = activeModelRef.current
    const targetKey = loadedKeyForModel(model)
    if (loadedModelKeyRef.current === targetKey && workerRef.current) {
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
          engine: model.engine,
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

  const cancelDownload = useCallback(() => {
    downloadCancelledRef.current = true
    clearMemoQueue()
    if (liveCaptionsEnabledRef.current) {
      liveCaptionsEnabledRef.current = false
      setLiveCaptionsEnabled(false)
      stopCapturer()
    }
    terminateWorker()
    setMemoTranscripts((prev) => {
      let changed = false
      const next = { ...prev }
      for (const [key, entry] of Object.entries(next)) {
        if (entry.status === 'loading') {
          delete next[key]
          changed = true
        }
      }
      if (changed) {
        memoTranscriptsRef.current = next
        return next
      }
      return prev
    })
    setModelStatus('idle')
    setDownloadProgress(0)
    setDownloadFile(null)
    setRuntimeDevice(null)
    setModelError(null)
    pushToastRef.current('info', 'Transcription model download cancelled')
  }, [clearMemoQueue, stopCapturer, terminateWorker])

  const setActiveModelId = useCallback(
    (modelId: string) => {
      const found = modelsRef.current.find((m) => m.id === modelId)
      if (!found) return
      activeModelRef.current = found
      setActiveModelIdState(found.id)
      saveTranscriptionConfig({
        activeModelId: found.id,
        autoTranscribe: autoTranscribeRef.current,
        customModels: customModelsRef.current,
      })

      if (loadedModelKeyRef.current !== loadedKeyForModel(found)) {
        setModelStatus('idle')
        setDownloadProgress(0)
        setDownloadFile(null)
        setRuntimeDevice(null)
        setModelError(null)
        if (liveCaptionsEnabledRef.current && activeCallRef.current) {
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

  const setAutoTranscribe = useCallback(
    (enabled: boolean) => {
      autoTranscribeRef.current = enabled
      setAutoTranscribeState(enabled)
      saveTranscriptionConfig({
        activeModelId: activeModelRef.current.id,
        autoTranscribe: enabled,
        customModels: customModelsRef.current,
      })

      // If currently in an active call, immediately sync live captions with the preference
      if (activeCallRef.current) {
        if (enabled && !liveCaptionsEnabledRef.current) {
          liveCaptionsEnabledRef.current = true
          setLiveCaptionsEnabled(true)
          void preloadModel().then((ok) => {
            if (!ok && liveCaptionsEnabledRef.current) {
              liveCaptionsEnabledRef.current = false
              setLiveCaptionsEnabled(false)
              stopCapturer()
            }
          })
        } else if (!enabled && liveCaptionsEnabledRef.current) {
          liveCaptionsEnabledRef.current = false
          setLiveCaptionsEnabled(false)
          stopCapturer()
          const call = activeCallRef.current
          const meta = activeCallMetaRef.current
          if (call && liveCaptionsRef.current.length > 0) {
            finalizeAndSaveCallTranscript({
              callId: call.callId,
              callTitle: call.title || meta?.title || 'Call',
              startedAt:
                call.connectedAt ??
                call.startedAt ??
                meta?.startedAt ??
                liveCaptionsRef.current[0]?.timestamp ??
                Date.now(),
              entries: liveCaptionsRef.current,
              setEndedSnapshot: false,
            })
          }
        }
      }
    },
    [finalizeAndSaveCallTranscript, preloadModel, stopCapturer]
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
      activeModelRef.current = created
      setCustomModels(nextCustom)
      setActiveModelIdState(created.id)
      saveTranscriptionConfig({
        activeModelId: created.id,
        autoTranscribe: autoTranscribeRef.current,
        customModels: nextCustom,
      })

      if (loadedModelKeyRef.current !== loadedKeyForModel(created)) {
        setModelStatus('idle')
        setDownloadProgress(0)
        setDownloadFile(null)
        setRuntimeDevice(null)
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

    const removingActive = activeModelRef.current.id === modelId
    const nextActiveId = removingActive
      ? DEFAULT_TRANSCRIPTION_MODEL_ID
      : activeModelRef.current.id
    setActiveModelIdState(nextActiveId)
    saveTranscriptionConfig({
      activeModelId: nextActiveId,
      autoTranscribe: autoTranscribeRef.current,
      customModels: nextCustom,
    })

    if (removingActive) {
      setModelStatus('idle')
      setDownloadProgress(0)
      setDownloadFile(null)
      setRuntimeDevice(null)
      setModelError(null)
    }
    pushToastRef.current('info', `Removed ${target.label}`)
  }, [])

  const clearModelCache = useCallback(async (): Promise<void> => {
    clearMemoQueue()
    stopCapturer()
    liveCaptionsEnabledRef.current = false
    setLiveCaptionsEnabled(false)
    terminateWorker()
    setModelStatus('idle')
    setDownloadProgress(0)
    setDownloadFile(null)
    setRuntimeDevice(null)
    setModelError(null)

    try {
      const tasks: Promise<unknown>[] = [deleteIndexedDbSafe(PARAKEET_IDB_NAME)]
      if (typeof caches !== 'undefined') {
        tasks.push(caches.delete(TRANSFORMERS_CACHE_KEY))
      }
      await Promise.all(tasks)
      pushToastRef.current(
        'info',
        'Model cache cleared',
        'Cached Moonshine & Parakeet speech models removed from browser storage.'
      )
    } catch {
      pushToastRef.current(
        'warning',
        'Cache clear incomplete',
        'Browser storage prevented removing cached model weights.'
      )
    }
  }, [clearMemoQueue, stopCapturer, terminateWorker])

  // Sequential voice memo transcription drain (prevents fetch/decode stampedes when auto-transcribing)
  const drainMemoQueue = useCallback(async (): Promise<void> => {
    if (memoQueueRunningRef.current) return
    memoQueueRunningRef.current = true
    try {
      while (memoQueueRef.current.length > 0) {
        const item = memoQueueRef.current.shift()
        if (!item) continue
        activeMemoKeyRef.current = item.memoKey
        const model = activeModelRef.current

        try {
          // Strict engine-level Trusted-Peers guard (never fetches untrusted memos)
          const blobUrl = await fetchVoiceMemoBlobRef.current(
            item.memo,
            item.senderPubkey
          )
          const response = await fetch(blobUrl)
          const blob = await response.blob()
          const pcm16k = await decodeBlobToPcm16k(blob)

          const worker = ensureWorker()
          const requestId = nextRequestId('memo')

          await new Promise<void>((resolve) => {
            pendingRef.current.set(requestId, {
              kind: 'memo',
              memoKey: item.memoKey,
              canonicalKey: item.canonicalKey,
              modelLabel: model.label,
              resolve,
            })
            const payload: WorkerInMessage = {
              type: 'transcribe',
              requestId,
              kind: 'memo',
              engine: model.engine,
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
            [item.memoKey]: {
              status: 'error',
              error: message,
              modelLabel: model.label,
              updatedAt: Date.now(),
            },
          }))
        } finally {
          activeMemoKeyRef.current = null
          for (const res of item.resolvers) res()
        }
      }
    } finally {
      memoQueueRunningRef.current = false
      scheduleIdleWorkerTeardown()
    }
  }, [ensureWorker, nextRequestId, scheduleIdleWorkerTeardown])

  const clearTranscriptCache = useCallback(() => {
    clearMemoQueue()
    clearMemoTranscriptCache()
    persistedTranscriptsRef.current = {}
    setMemoTranscripts({})
    setCachedTranscriptCount(0)
    pushToastRef.current(
      'info',
      'Transcript cache cleared',
      'Cached voice memo transcripts removed from local storage.'
    )
  }, [clearMemoQueue])

  // On-demand & automatic voice memo transcription (strictly Trusted-Peers gated + serialized)
  const transcribeVoiceMemo = useCallback(
    async (
      memoKey: string,
      memo: VoiceMemoAttachment,
      senderPubkey: string
    ): Promise<void> => {
      if (!memoKey) return
      const canonicalKey = memo.sha256?.trim() || memoKey

      // Serve immediately from persistent hash cache with zero audio fetch & zero model load
      const cachedHit =
        memoTranscriptsRef.current[canonicalKey] ??
        memoTranscriptsRef.current[memoKey]
      if (cachedHit?.status === 'done' && cachedHit.text && cachedHit.text.trim()) {
        if (!memoTranscriptsRef.current[memoKey]) {
          setMemoTranscripts((prev) => ({
            ...prev,
            [memoKey]: cachedHit,
          }))
        }
        return
      }
      const persistedHit =
        persistedTranscriptsRef.current[canonicalKey] ??
        persistedTranscriptsRef.current[memoKey]
      if (persistedHit && persistedHit.text.trim()) {
        const hydrated: MemoTranscriptState = {
          status: 'done',
          text: persistedHit.text,
          modelLabel: persistedHit.modelLabel,
          updatedAt: persistedHit.updatedAt,
        }
        setMemoTranscripts((prev) => ({
          ...prev,
          [canonicalKey]: hydrated,
          [memoKey]: hydrated,
        }))
        return
      }

      if (activeMemoKeyRef.current === memoKey || activeMemoKeyRef.current === canonicalKey) {
        return
      }

      const existingQueued = memoQueueRef.current.find(
        (item) => item.memoKey === memoKey || item.canonicalKey === canonicalKey
      )
      if (existingQueued) {
        return await new Promise<void>((resolve) => {
          existingQueued.resolvers.push(resolve)
        })
      }

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

      await new Promise<void>((resolve) => {
        memoQueueRef.current.push({
          memoKey,
          canonicalKey,
          memo,
          senderPubkey,
          resolvers: [resolve],
        })
        void drainMemoQueue()
      })
    },
    [drainMemoQueue]
  )

  const transcribeAudioBlob = useCallback(
    async (blob: Blob): Promise<string> => {
      const pcm16k = await decodeBlobToPcm16k(blob)
      const model = activeModelRef.current
      const targetKey = loadedKeyForModel(model)

      if (loadedModelKeyRef.current !== targetKey || !workerRef.current) {
        const ok = await preloadModel()
        if (!ok) {
          throw new Error(
            downloadCancelledRef.current
              ? 'Transcription model download cancelled.'
              : modelErrorRef.current || `Failed to load ${model.label} for transcription.`
          )
        }
      }

      const activeNow = activeModelRef.current
      const worker = ensureWorker()
      const requestId = nextRequestId('blob')

      return await new Promise<string>((resolve, reject) => {
        pendingRef.current.set(requestId, {
          kind: 'blob',
          resolve,
          reject,
        })
        const payload: WorkerInMessage = {
          type: 'transcribe',
          requestId,
          kind: 'memo',
          engine: activeNow.engine,
          hfModelId: activeNow.hfModelId,
          dtype: activeNow.dtype,
          pcm16k,
        }
        worker.postMessage(payload, [pcm16k.buffer])
      })
    },
    [ensureWorker, nextRequestId, preloadModel]
  )

  const seedMemoTranscript = useCallback(
    (memoKey: string, text: string, modelLabel?: string) => {
      const cleanKey = memoKey.trim()
      const cleanText = text.trim()
      if (!cleanKey || !cleanText) return
      const resolvedModel = modelLabel?.trim() || activeModelRef.current.label
      const now = Date.now()
      const nextPersisted = saveMemoTranscriptCache({
        ...persistedTranscriptsRef.current,
        [cleanKey]: {
          text: cleanText,
          modelLabel: resolvedModel,
          updatedAt: now,
        },
      })
      persistedTranscriptsRef.current = nextPersisted
      setCachedTranscriptCount(Object.keys(nextPersisted).length)

      const entry: MemoTranscriptState = {
        status: 'done',
        text: cleanText,
        modelLabel: resolvedModel,
        updatedAt: now,
      }
      setMemoTranscripts((prev) => {
        const next = { ...prev, [cleanKey]: entry }
        memoTranscriptsRef.current = next
        return next
      })
    },
    []
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
          engine: model.engine,
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
      // Trigger B: Live captions turned OFF -> finalize, hash ONCE, and persist locally + notify sync
      const call = activeCallRef.current
      const meta = activeCallMetaRef.current
      const callId = call?.callId ?? lastCallIdRef.current
      if (callId && liveCaptionsRef.current.length > 0) {
        finalizeAndSaveCallTranscript({
          callId,
          callTitle: call?.title || meta?.title || 'Call',
          startedAt:
            call?.connectedAt ??
            call?.startedAt ??
            meta?.startedAt ??
            liveCaptionsRef.current[0]?.timestamp ??
            Date.now(),
          entries: liveCaptionsRef.current,
          setEndedSnapshot: false,
        })
      }
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
  }, [finalizeAndSaveCallTranscript, preloadModel, stopCapturer])

  // Lifecycle sync between activeCall, autoTranscribe, liveCaptionsEnabled, and LiveStreamSpeechCapturer
  useEffect(() => {
    const currentCallId = activeCall?.callId ?? null

    if (!activeCall) {
      stopCapturer()
      if (liveCaptionsEnabledRef.current) {
        liveCaptionsEnabledRef.current = false
        setLiveCaptionsEnabled(false)
      }
      if (lastCallIdRef.current !== null) {
        // Trigger A: Call ended -> finalize, hash ONCE (if changed since last save), save & expose ended snapshot
        const prevCallId = lastCallIdRef.current
        const capturedEntries = liveCaptionsRef.current
        const meta = activeCallMetaRef.current
        if (capturedEntries.length > 0) {
          const endedAt = Date.now()
          const startedAt =
            meta?.startedAt ?? capturedEntries[0]?.timestamp ?? endedAt
          const callTitle = meta?.title || 'Call'
          finalizeAndSaveCallTranscript({
            callId: prevCallId,
            callTitle,
            startedAt,
            endedAt,
            entries: capturedEntries,
            setEndedSnapshot: true,
          })
        }
        lastCallIdRef.current = null
        activeCallMetaRef.current = null
        lastSavedSignatureRef.current = null
        liveCaptionsRef.current = []
        setLiveCaptions([])
      }
      scheduleIdleWorkerTeardown()
      return
    }

    clearIdleTeardownTimer()

    // Detect brand-new call join/start BEFORE overwriting activeCallMetaRef
    const isNewCall = lastCallIdRef.current !== currentCallId
    if (isNewCall) {
      if (lastCallIdRef.current !== null && liveCaptionsRef.current.length > 0) {
        // Trigger A (direct call switch): finalize previous call's transcript before resetting
        const prevCallId = lastCallIdRef.current
        const prevMeta = activeCallMetaRef.current
        const endedAt = Date.now()
        finalizeAndSaveCallTranscript({
          callId: prevCallId,
          callTitle: prevMeta?.title || 'Call',
          startedAt:
            prevMeta?.startedAt ?? liveCaptionsRef.current[0]?.timestamp ?? endedAt,
          endedAt,
          entries: liveCaptionsRef.current,
          setEndedSnapshot: false,
        })
      }
      if (endedCallTranscriptRef.current) {
        endedCallTranscriptRef.current = null
        setEndedCallTranscript(null)
      }
      if (lastCallIdRef.current !== null) {
        liveCaptionsRef.current = []
        setLiveCaptions([])
      }
      lastSavedSignatureRef.current = null
      lastCallIdRef.current = currentCallId
      const shouldEnable = autoTranscribeRef.current
      if (liveCaptionsEnabledRef.current !== shouldEnable) {
        liveCaptionsEnabledRef.current = shouldEnable
        setLiveCaptionsEnabled(shouldEnable)
      }
      if (shouldEnable) {
        void preloadModel().then((ok) => {
          if (
            !ok &&
            liveCaptionsEnabledRef.current &&
            activeCallRef.current?.callId === currentCallId
          ) {
            liveCaptionsEnabledRef.current = false
            setLiveCaptionsEnabled(false)
            stopCapturer()
          }
        })
      }
    }

    activeCallMetaRef.current = {
      callId: activeCall.callId,
      title: activeCall.title,
      startedAt: activeCall.connectedAt ?? activeCall.startedAt,
    }

    const effectiveEnabled = isNewCall
      ? autoTranscribeRef.current
      : liveCaptionsEnabled

    if (!effectiveEnabled) {
      stopCapturer()
      return
    }

    const trustedParticipants = activeCall.participants.filter(
      (p) => p.isSelf || !p.isUntrusted
    )
    if (!capturerRef.current) {
      const capturer = new LiveStreamSpeechCapturer(handleCapturedSpeechSegment)
      capturerRef.current = capturer
      void capturer.start(trustedParticipants).catch((err) => {
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
      capturerRef.current.syncParticipants(trustedParticipants)
    }
  }, [
    activeCall,
    liveCaptionsEnabled,
    finalizeAndSaveCallTranscript,
    handleCapturedSpeechSegment,
    preloadModel,
    stopCapturer,
    clearIdleTeardownTimer,
    scheduleIdleWorkerTeardown,
  ])

  // Recover any unfinalized mid-call transcript draft left behind by a tab crash / OS kill
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const { store: recoveredStore, recovered } = recoverCrashDraftIntoStore(
        callTranscriptStoreRef.current
      )
      if (!recovered) return
      callTranscriptStoreRef.current = recoveredStore
      setSavedCallTranscripts(recoveredStore.transcripts)
      onCallTranscriptsChangedRef.current?.()
      pushToastRef.current('info', 'Recovered call transcript', recovered.callTitle)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  // Periodic 30-day retention sweep (on tab foreground + every 6h), hidden draft flush & Trigger C (pagehide / unmount persist)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') return
      if (document.visibilityState === 'visible') {
        sweepExpiredCallTranscripts()
      } else if (document.visibilityState === 'hidden') {
        if (activeCallRef.current && liveCaptionsRef.current.length > 0) {
          writeActiveCallDraft(liveCaptionsRef.current)
        }
      }
    }

    const persistUnsavedOnExit = () => {
      const callId = activeCallRef.current?.callId ?? lastCallIdRef.current
      const entries = liveCaptionsRef.current
      if (!callId || entries.length === 0) return
      const meta = activeCallMetaRef.current
      const now = Date.now()
      finalizeAndSaveCallTranscript({
        callId,
        callTitle: activeCallRef.current?.title || meta?.title || 'Call',
        startedAt:
          activeCallRef.current?.connectedAt ??
          activeCallRef.current?.startedAt ??
          meta?.startedAt ??
          entries[0]?.timestamp ??
          now,
        endedAt: now,
        entries,
        setEndedSnapshot: false,
        updateState: false,
        notifySync: false,
      })
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', persistUnsavedOnExit)
    }
    const sweepTimer = setInterval(sweepExpiredCallTranscripts, CALL_TRANSCRIPT_SWEEP_INTERVAL_MS)

    return () => {
      clearInterval(sweepTimer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', persistUnsavedOnExit)
      }
      persistUnsavedOnExit()
    }
  }, [finalizeAndSaveCallTranscript, sweepExpiredCallTranscripts, writeActiveCallDraft])

  // Clean up capturer & worker on unmount
  useEffect(() => {
    return () => {
      clearMemoQueue()
      stopCapturer()
      terminateWorker()
    }
  }, [clearMemoQueue, stopCapturer, terminateWorker])

  const clearCallTranscript = useCallback(() => {
    liveCaptionsRef.current = []
    setLiveCaptions([])
    lastSavedSignatureRef.current = null
    clearCallTranscriptDraft()
  }, [])

  const exportCallTranscriptMarkdown = useCallback(() => {
    const now = Date.now()
    const call = activeCallRef.current
    const meta = activeCallMetaRef.current
    const callTitle = call?.title || meta?.title || 'Call'
    const startedAt =
      call?.connectedAt ??
      call?.startedAt ??
      meta?.startedAt ??
      liveCaptions[0]?.timestamp ??
      now
    const artifact = formatCallTranscriptArtifact({
      callTitle,
      startedAt,
      endedAt: now,
      modelLabel: activeModelRef.current.label,
      hfModelId: activeModelRef.current.hfModelId,
      entries: liveCaptions,
    })

    return {
      filename: artifact.filename,
      mimeType: 'text/markdown;charset=utf-8',
      content: artifact.markdown,
    }
  }, [liveCaptions])

  const dismissEndedCallTranscript = useCallback(() => {
    endedCallTranscriptRef.current = null
    setEndedCallTranscript(null)
  }, [])

  const triggerMarkdownDownload = useCallback((filename: string, markdown: string) => {
    try {
      const blob = new Blob([markdown], {
        type: 'text/markdown;charset=utf-8',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      pushToastRef.current('success', 'Call transcript saved', filename)
    } catch {
      pushToastRef.current(
        'error',
        'Unable to download transcript',
        'Try copying the transcript to your clipboard instead.'
      )
    }
  }, [])

  const downloadEndedCallTranscript = useCallback(() => {
    const snap = endedCallTranscriptRef.current
    if (!snap) return
    triggerMarkdownDownload(snap.filename, snap.markdown)
  }, [triggerMarkdownDownload])

  const formatSavedCallTranscriptMarkdown = useCallback((transcript: SavedCallTranscript) => {
    return formatCallTranscriptArtifact({
      callTitle: transcript.callTitle,
      startedAt: transcript.startedAt,
      endedAt: transcript.endedAt,
      modelLabel: transcript.modelLabel,
      hfModelId: transcript.hfModelId,
      entries: transcript.entries,
    })
  }, [])

  const downloadSavedCallTranscript = useCallback(
    (id: string) => {
      const found = callTranscriptStoreRef.current.transcripts.find((t) => t.id === id)
      if (!found) return
      const artifact = formatSavedCallTranscriptMarkdown(found)
      triggerMarkdownDownload(artifact.filename, artifact.markdown)
    },
    [formatSavedCallTranscriptMarkdown, triggerMarkdownDownload]
  )

  const deleteSavedCallTranscript = useCallback((id: string) => {
    const { store: nextStore, changed } = deleteSavedCallTranscriptInStore(
      callTranscriptStoreRef.current,
      id
    )
    if (!changed) return
    const persisted = saveCallTranscriptStore(nextStore)
    callTranscriptStoreRef.current = persisted
    setSavedCallTranscripts(persisted.transcripts)
    if (endedCallTranscriptRef.current?.id === id) {
      endedCallTranscriptRef.current = null
      setEndedCallTranscript(null)
    }
    onCallTranscriptsChangedRef.current?.()
    pushToastRef.current('info', 'Call transcript deleted')
  }, [])

  const clearSavedCallTranscripts = useCallback(() => {
    const { store: nextStore, changed } = clearSavedCallTranscriptsInStore(
      callTranscriptStoreRef.current
    )
    if (!changed) return
    const persisted = saveCallTranscriptStore(nextStore)
    callTranscriptStoreRef.current = persisted
    setSavedCallTranscripts(persisted.transcripts)
    endedCallTranscriptRef.current = null
    setEndedCallTranscript(null)
    lastSavedSignatureRef.current = null
    onCallTranscriptsChangedRef.current?.()
    pushToastRef.current(
      'info',
      'Saved call transcripts cleared',
      'Call transcripts removed from local storage.'
    )
  }, [])

  // O(1) sync digest read — reads precomputed collectionHash with ZERO re-hashing
  const exportCallTranscriptsSyncDigest = useCallback((): CallTranscriptSyncDigest => {
    return buildCallTranscriptSyncDigest(callTranscriptStoreRef.current)
  }, [])

  const exportCallTranscriptsSyncPayload = useCallback(
    (
      knownHashes?: Record<string, string>,
      remoteDeleted?: Record<string, number>
    ): CallTranscriptSyncPayload => {
      return selectDeltaCallTranscripts(
        callTranscriptStoreRef.current,
        knownHashes,
        remoteDeleted
      )
    },
    []
  )

  const mergeCallTranscriptsSyncPayload = useCallback((remote: unknown): number => {
    const { store: merged, changed, addedOrUpdatedCount } = mergeCallTranscriptSyncPayload(
      callTranscriptStoreRef.current,
      remote
    )
    if (!changed) return 0
    const persisted = saveCallTranscriptStore(merged)
    callTranscriptStoreRef.current = persisted
    setSavedCallTranscripts(persisted.transcripts)
    return addedOrUpdatedCount
  }, [])

  const resetAllTranscription = useCallback(() => {
    downloadCancelledRef.current = false
    clearMemoQueue()
    clearMemoTranscriptCache()
    clearCallTranscriptDraft()
    clearCallTranscriptStore()
    const emptyStore = createEmptyCallTranscriptStore()
    callTranscriptStoreRef.current = emptyStore
    setSavedCallTranscripts([])
    lastSavedSignatureRef.current = null
    persistedTranscriptsRef.current = {}
    stopCapturer()
    terminateWorker()
    liveCaptionsEnabledRef.current = false
    setLiveCaptionsEnabled(false)
    liveCaptionsRef.current = []
    setLiveCaptions([])
    endedCallTranscriptRef.current = null
    setEndedCallTranscript(null)
    activeCallMetaRef.current = null
    setMemoTranscripts({})
    setCachedTranscriptCount(0)
    customModelsRef.current = []
    setCustomModels([])
    autoTranscribeRef.current = DEFAULT_AUTO_TRANSCRIBE
    setAutoTranscribeState(DEFAULT_AUTO_TRANSCRIBE)
    setActiveModelIdState(DEFAULT_TRANSCRIPTION_MODEL_ID)
    setModelStatus('idle')
    setDownloadProgress(0)
    setDownloadFile(null)
    setRuntimeDevice(null)
    setModelError(null)
    lastCallIdRef.current = null
  }, [clearMemoQueue, stopCapturer, terminateWorker])

  const transcription: TranscriptionEngine = useMemo(
    () => ({
      models,
      activeModelId: activeModel.id,
      activeModel,
      setActiveModelId,
      addCustomModel,
      removeCustomModel,
      autoTranscribe,
      setAutoTranscribe,
      modelStatus,
      downloadProgress,
      downloadFile,
      runtimeDevice,
      modelError,
      preloadModel,
      cancelDownload,
      clearModelCache,
      memoTranscripts,
      cachedTranscriptCount,
      clearTranscriptCache,
      transcribeVoiceMemo,
      transcribeAudioBlob,
      seedMemoTranscript,
      liveCaptionsEnabled,
      toggleLiveCaptions,
      liveCaptions,
      clearCallTranscript,
      exportCallTranscriptMarkdown,
      endedCallTranscript,
      dismissEndedCallTranscript,
      downloadEndedCallTranscript,
      savedCallTranscripts,
      deleteSavedCallTranscript,
      clearSavedCallTranscripts,
      downloadSavedCallTranscript,
      formatSavedCallTranscriptMarkdown,
    }),
    [
      models,
      activeModel,
      setActiveModelId,
      addCustomModel,
      removeCustomModel,
      autoTranscribe,
      setAutoTranscribe,
      modelStatus,
      downloadProgress,
      downloadFile,
      runtimeDevice,
      modelError,
      preloadModel,
      cancelDownload,
      clearModelCache,
      memoTranscripts,
      cachedTranscriptCount,
      clearTranscriptCache,
      transcribeVoiceMemo,
      transcribeAudioBlob,
      seedMemoTranscript,
      liveCaptionsEnabled,
      toggleLiveCaptions,
      liveCaptions,
      clearCallTranscript,
      exportCallTranscriptMarkdown,
      endedCallTranscript,
      dismissEndedCallTranscript,
      downloadEndedCallTranscript,
      savedCallTranscripts,
      deleteSavedCallTranscript,
      clearSavedCallTranscripts,
      downloadSavedCallTranscript,
      formatSavedCallTranscriptMarkdown,
    ]
  )

  return {
    transcription,
    resetAllTranscription,
    exportCallTranscriptsSyncDigest,
    exportCallTranscriptsSyncPayload,
    mergeCallTranscriptsSyncPayload,
  }
}
