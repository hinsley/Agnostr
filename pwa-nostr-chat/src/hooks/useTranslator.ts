import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ToastLevel } from '../types/protocol.ts'
import {
  DEFAULT_TRANSLATOR_MODEL_KEY,
  DEFAULT_TRANSLATOR_SETTINGS,
  TRANSLATOR_CACHE_KEY,
  TRANSLATOR_MODELS,
  translationCacheKey,
  type OutgoingOriginalEntry,
  type TranslationEntry,
  type TranslatorEngine,
  type TranslatorModelKey,
  type TranslatorModelStatus,
  type TranslatorRuntimeDevice,
  type TranslatorSettings,
} from '../types/translator.ts'
import type {
  TranslatorWorkerInMessage,
  TranslatorWorkerOutMessage,
} from '../lib/translator.worker.ts'

const PREFS_STORAGE_KEY = 'agnostr:v2:translator_prefs'
const TRANSLATIONS_STORAGE_KEY = 'agnostr:v2:translations'
const OUTGOING_ORIGINALS_STORAGE_KEY = 'agnostr:v2:translator_outgoing'
const LEGACY_TRANSFORMERS_CACHE_KEY = 'transformers-cache'

const MAX_CACHED_TRANSLATIONS = 600
const MAX_OUTGOING_ORIGINALS = 200
const IDLE_WORKER_TEARDOWN_MS = 5 * 60 * 1000 // Reclaim WASM/ONNX RAM after 5m idle when Translator Mode is off

export interface UseTranslatorParams {
  pushToast?: (level: ToastLevel, title: string, detail?: string) => void
}

interface PersistedTranslationRecord {
  text: string
  targetLang: string
  modelKey?: TranslatorModelKey
  updatedAt: number
}

interface PersistedOutgoingRecord extends OutgoingOriginalEntry {
  updatedAt: number
}

interface PendingLoadRequest {
  kind: 'load'
  modelId: string
  resolve: (ok: boolean) => void
}

interface PendingMessageRequest {
  kind: 'message'
  modelKey: TranslatorModelKey
  cacheKey: string
  targetLang: string
  resolve: (text: string | null) => void
}

interface PendingOutgoingRequest {
  kind: 'outgoing'
  originalText: string
  resolve: (text: string) => void
  reject: (err: Error) => void
}

type PendingWorkerRequest =
  | PendingLoadRequest
  | PendingMessageRequest
  | PendingOutgoingRequest

function safeStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeStorageSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function safeStorageRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore storage removal errors
  }
}

function normalizeLanguageName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim().slice(0, 64)
  return trimmed || fallback
}

function normalizeModelKey(raw: unknown): TranslatorModelKey {
  if (raw === 'nllb200' || raw === 'm2m100') return raw
  return DEFAULT_TRANSLATOR_MODEL_KEY
}

function isLegacyLfm3CacheUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return (
    lower.includes('lfm3-1.7b-onnx') ||
    lower.includes('lfm3%2d1.7b') ||
    lower.includes('onnx-community/lfm3') ||
    lower.includes('onnx-community%2flfm3')
  )
}

async function evictLegacyLfm3Caches(): Promise<void> {
  if (typeof caches === 'undefined') return
  for (const cacheName of [TRANSLATOR_CACHE_KEY, LEGACY_TRANSFORMERS_CACHE_KEY]) {
    try {
      const exists = await caches.has(cacheName)
      if (!exists) continue
      const cache = await caches.open(cacheName)
      const keys = await cache.keys()
      for (const req of keys) {
        if (isLegacyLfm3CacheUrl(req.url)) {
          await cache.delete(req)
        }
      }
    } catch {
      // Ignore storage restrictions
    }
  }
}

function loadTranslatorSettings(): TranslatorSettings {
  const raw = safeStorageGet(PREFS_STORAGE_KEY)
  if (!raw) return { ...DEFAULT_TRANSLATOR_SETTINGS }
  try {
    const parsed = JSON.parse(raw) as Partial<TranslatorSettings>
    return {
      enabled: Boolean(parsed.enabled),
      model: normalizeModelKey(parsed.model),
      myLanguage: normalizeLanguageName(
        parsed.myLanguage,
        DEFAULT_TRANSLATOR_SETTINGS.myLanguage
      ),
      outgoingEnabled: Boolean(parsed.outgoingEnabled),
      outgoingLanguage: normalizeLanguageName(
        parsed.outgoingLanguage,
        DEFAULT_TRANSLATOR_SETTINGS.outgoingLanguage
      ),
      underlyingCollapsed: Boolean(parsed.underlyingCollapsed),
    }
  } catch {
    return { ...DEFAULT_TRANSLATOR_SETTINGS }
  }
}

function saveTranslatorSettings(settings: TranslatorSettings): void {
  safeStorageSet(PREFS_STORAGE_KEY, JSON.stringify(settings))
}

function pruneTranslationsMap(
  input: Record<string, PersistedTranslationRecord>,
  maxEntries: number
): Record<string, PersistedTranslationRecord> {
  const entries = Object.entries(input)
  if (entries.length <= maxEntries) return input
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
  const pruned: Record<string, PersistedTranslationRecord> = {}
  for (let i = 0; i < maxEntries; i++) {
    const [k, v] = entries[i]
    pruned[k] = v
  }
  return pruned
}

function loadTranslationCache(
  expectedModelKey: TranslatorModelKey
): Record<string, PersistedTranslationRecord> {
  const raw = safeStorageGet(TRANSLATIONS_STORAGE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const valid: Record<string, PersistedTranslationRecord> = {}
    for (const [key, val] of Object.entries(parsed)) {
      if (!val || typeof val !== 'object') continue
      const rec = val as Partial<PersistedTranslationRecord>
      // Only hydrate entries generated by the currently selected model (skip legacy or other model)
      if (rec.modelKey !== expectedModelKey) continue
      if (
        typeof rec.text === 'string' &&
        rec.text.trim().length > 0 &&
        typeof rec.targetLang === 'string' &&
        rec.targetLang.trim().length > 0
      ) {
        valid[key] = {
          text: rec.text,
          targetLang: rec.targetLang.trim(),
          modelKey: rec.modelKey,
          updatedAt:
            typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt)
              ? rec.updatedAt
              : 0,
        }
      }
    }
    return pruneTranslationsMap(valid, MAX_CACHED_TRANSLATIONS)
  } catch {
    return {}
  }
}

function saveTranslationCache(
  input: Record<string, PersistedTranslationRecord>
): Record<string, PersistedTranslationRecord> {
  const pruned = pruneTranslationsMap(input, MAX_CACHED_TRANSLATIONS)
  if (safeStorageSet(TRANSLATIONS_STORAGE_KEY, JSON.stringify(pruned))) {
    return pruned
  }
  // Quota fallback: keep most recent half and retry once
  const halved = pruneTranslationsMap(pruned, Math.floor(MAX_CACHED_TRANSLATIONS / 2))
  safeStorageSet(TRANSLATIONS_STORAGE_KEY, JSON.stringify(halved))
  return halved
}

function pruneOutgoingMap(
  input: Record<string, PersistedOutgoingRecord>,
  maxEntries: number
): Record<string, PersistedOutgoingRecord> {
  const entries = Object.entries(input)
  if (entries.length <= maxEntries) return input
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
  const pruned: Record<string, PersistedOutgoingRecord> = {}
  for (let i = 0; i < maxEntries; i++) {
    const [k, v] = entries[i]
    pruned[k] = v
  }
  return pruned
}

function loadOutgoingOriginals(): Record<string, PersistedOutgoingRecord> {
  const raw = safeStorageGet(OUTGOING_ORIGINALS_STORAGE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const valid: Record<string, PersistedOutgoingRecord> = {}
    for (const [msgId, val] of Object.entries(parsed)) {
      if (!val || typeof val !== 'object') continue
      const rec = val as Partial<PersistedOutgoingRecord>
      if (
        typeof rec.originalText === 'string' &&
        typeof rec.sourceLang === 'string' &&
        typeof rec.translatedText === 'string' &&
        typeof rec.targetLang === 'string'
      ) {
        valid[msgId] = {
          originalText: rec.originalText,
          sourceLang: rec.sourceLang,
          translatedText: rec.translatedText,
          targetLang: rec.targetLang,
          updatedAt:
            typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt)
              ? rec.updatedAt
              : 0,
        }
      }
    }
    return pruneOutgoingMap(valid, MAX_OUTGOING_ORIGINALS)
  } catch {
    return {}
  }
}

function saveOutgoingOriginals(
  input: Record<string, PersistedOutgoingRecord>
): Record<string, PersistedOutgoingRecord> {
  const pruned = pruneOutgoingMap(input, MAX_OUTGOING_ORIGINALS)
  safeStorageSet(OUTGOING_ORIGINALS_STORAGE_KEY, JSON.stringify(pruned))
  return pruned
}

function stripOutgoingTimestamps(
  records: Record<string, PersistedOutgoingRecord>
): Record<string, OutgoingOriginalEntry> {
  const out: Record<string, OutgoingOriginalEntry> = {}
  for (const [msgId, rec] of Object.entries(records)) {
    out[msgId] = {
      originalText: rec.originalText,
      sourceLang: rec.sourceLang,
      translatedText: rec.translatedText,
      targetLang: rec.targetLang,
    }
  }
  return out
}

function hydrateOutgoingIntoTranslations(
  outgoing: Record<string, PersistedOutgoingRecord>,
  base: Record<string, TranslationEntry> = {}
): Record<string, TranslationEntry> {
  const next = { ...base }
  for (const [msgId, rec] of Object.entries(outgoing)) {
    const key = translationCacheKey(msgId, rec.sourceLang)
    if (!next[key]) {
      next[key] = {
        status: 'done',
        text: rec.originalText,
        targetLang: rec.sourceLang,
        updatedAt: rec.updatedAt,
      }
    }
  }
  return next
}

/**
 * Returns true when text contains no translatable natural-language content
 * (empty, URL-only, emoji-only, mention/channel/Nostr-bech32-only, or pure numbers/symbols).
 */
function isNonTranslatableText(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return true

  const stripped = trimmed
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/\bnostr:(?:npub|nsec|note|nprofile|nevent|naddr)1[02-9ac-hj-np-z]+\b/gi, ' ')
    .replace(/\b(?:npub|note|nprofile|nevent|naddr)1[02-9ac-hj-np-z]{20,}\b/gi, ' ')
    .replace(/\blnbc[a-z0-9]{20,}\b/gi, ' ')
    .replace(/\bcashu[AB][A-Za-z0-9_\-+=]{20,}\b/g, ' ')
    .replace(/(^|\s)@[A-Za-z0-9_.\-#]+/g, ' ')
    .replace(/(^|\s)#[A-Za-z0-9_-]+/g, ' ')

  return !/\p{L}/u.test(stripped)
}

function hasInitialWebGpuApi(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { gpu?: { requestAdapter?: unknown } }
  return Boolean(nav.gpu && typeof nav.gpu.requestAdapter === 'function')
}

export function useTranslator(params?: UseTranslatorParams): TranslatorEngine {
  const pushToastRef = useRef(params?.pushToast)
  pushToastRef.current = params?.pushToast

  const [settings, setSettings] = useState<TranslatorSettings>(() =>
    loadTranslatorSettings()
  )
  const settingsRef = useRef<TranslatorSettings>(settings)
  settingsRef.current = settings

  const activeModel = TRANSLATOR_MODELS[settings.model]
  const activeModelRef = useRef(activeModel)
  activeModelRef.current = activeModel

  const [modelStatus, setModelStatus] = useState<TranslatorModelStatus>('idle')
  const modelStatusRef = useRef<TranslatorModelStatus>(modelStatus)
  modelStatusRef.current = modelStatus

  const [downloadProgress, setDownloadProgress] = useState<number>(0)
  const [downloadFile, setDownloadFile] = useState<string | null>(null)
  const [runtimeDevice, setRuntimeDevice] =
    useState<TranslatorRuntimeDevice | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [webGpuSupported, setWebGpuSupported] = useState<boolean>(() =>
    hasInitialWebGpuApi()
  )

  const initialPersistedTranslations = useMemo(
    () => loadTranslationCache(settings.model),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  const persistedTranslationsRef = useRef<
    Record<string, PersistedTranslationRecord>
  >(initialPersistedTranslations)

  const initialOutgoing = useMemo(() => loadOutgoingOriginals(), [])
  const persistedOutgoingRef = useRef<Record<string, PersistedOutgoingRecord>>(
    initialOutgoing
  )
  const [originalOutgoingById, setOriginalOutgoingById] = useState<
    Record<string, OutgoingOriginalEntry>
  >(() => stripOutgoingTimestamps(initialOutgoing))
  const originalOutgoingByIdRef =
    useRef<Record<string, OutgoingOriginalEntry>>(originalOutgoingById)
  originalOutgoingByIdRef.current = originalOutgoingById

  const [translations, setTranslations] = useState<
    Record<string, TranslationEntry>
  >(() => {
    const hydrated: Record<string, TranslationEntry> = {}
    for (const [key, rec] of Object.entries(initialPersistedTranslations)) {
      hydrated[key] = {
        status: 'done',
        text: rec.text,
        targetLang: rec.targetLang,
        updatedAt: rec.updatedAt,
      }
    }
    return hydrateOutgoingIntoTranslations(initialOutgoing, hydrated)
  })
  const translationsRef =
    useRef<Record<string, TranslationEntry>>(translations)
  translationsRef.current = translations

  const [cachedTranslationCount, setCachedTranslationCount] = useState<number>(
    () => Object.keys(initialPersistedTranslations).length
  )

  const workerRef = useRef<Worker | null>(null)
  const pendingRef = useRef<Map<string, PendingWorkerRequest>>(new Map())
  const inFlightByKeyRef = useRef<Map<string, Promise<string | null>>>(new Map())
  const loadPromiseRef = useRef<{ modelId: string; promise: Promise<boolean> } | null>(null)
  const loadedModelIdRef = useRef<string | null>(null)
  const reqSeqRef = useRef<number>(0)
  const idleTeardownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearIdleTeardownTimer = useCallback(() => {
    if (idleTeardownTimerRef.current !== null) {
      clearTimeout(idleTeardownTimerRef.current)
      idleTeardownTimerRef.current = null
    }
  }, [])

  // Verify actual WebGPU adapter availability + silently evict legacy LFM3 cache on mount
  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      try {
        const nav = navigator as Navigator & {
          gpu?: { requestAdapter?: () => Promise<unknown | null> }
        }
        if (!nav.gpu || typeof nav.gpu.requestAdapter !== 'function') {
          if (!cancelled) setWebGpuSupported(false)
          return
        }
        const adapter = await nav.gpu.requestAdapter()
        if (!cancelled) setWebGpuSupported(Boolean(adapter))
      } catch {
        if (!cancelled) setWebGpuSupported(false)
      }
    }
    void probe()
    void evictLegacyLfm3Caches()
    return () => {
      cancelled = true
    }
  }, [])

  const nextRequestId = useCallback((prefix: string): string => {
    reqSeqRef.current += 1
    return `${prefix}-${Date.now()}-${reqSeqRef.current}`
  }, [])

  const terminateWorker = useCallback(() => {
    clearIdleTeardownTimer()
    const w = workerRef.current
    workerRef.current = null
    loadedModelIdRef.current = null
    loadPromiseRef.current = null

    const staleKeys: string[] = []
    for (const req of pendingRef.current.values()) {
      if (req.kind === 'load') {
        req.resolve(false)
      } else if (req.kind === 'message') {
        staleKeys.push(req.cacheKey)
        req.resolve(null)
      } else if (req.kind === 'outgoing') {
        req.reject(new Error('Translator worker was stopped.'))
      }
    }
    pendingRef.current.clear()
    inFlightByKeyRef.current.clear()

    if (staleKeys.length > 0) {
      setTranslations((prev) => {
        let changed = false
        const next = { ...prev }
        for (const key of staleKeys) {
          if (next[key]?.status === 'loading') {
            delete next[key]
            changed = true
          }
        }
        if (changed) {
          translationsRef.current = next
          return next
        }
        return prev
      })
    }

    if (w) {
      try {
        w.postMessage({ type: 'dispose' } satisfies TranslatorWorkerInMessage)
      } catch {
        // Ignore postMessage failure on termination
      }
      w.terminate()
    }
  }, [clearIdleTeardownTimer])

  const scheduleIdleWorkerTeardown = useCallback(() => {
    clearIdleTeardownTimer()
    if (!workerRef.current) return
    if (settingsRef.current.enabled) return
    if (pendingRef.current.size > 0 || loadPromiseRef.current !== null) return

    idleTeardownTimerRef.current = setTimeout(() => {
      idleTeardownTimerRef.current = null
      if (
        !workerRef.current ||
        settingsRef.current.enabled ||
        pendingRef.current.size > 0 ||
        loadPromiseRef.current !== null
      ) {
        return
      }
      terminateWorker()
      setModelStatus('idle')
      modelStatusRef.current = 'idle'
      setDownloadProgress(0)
      setDownloadFile(null)
      setRuntimeDevice(null)
      setModelError(null)
    }, IDLE_WORKER_TEARDOWN_MS)
  }, [clearIdleTeardownTimer, terminateWorker])

  useEffect(() => {
    if (settings.enabled) {
      clearIdleTeardownTimer()
    } else {
      scheduleIdleWorkerTeardown()
    }
  }, [settings.enabled, clearIdleTeardownTimer, scheduleIdleWorkerTeardown])

  useEffect(() => {
    return () => {
      terminateWorker()
    }
  }, [terminateWorker])

  const handleWorkerMessage = useCallback(
    (event: MessageEvent<TranslatorWorkerOutMessage>) => {
      const msg = event.data
      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'status') {
        if (msg.modelId !== activeModelRef.current.id) return
        setModelStatus(msg.status)
        modelStatusRef.current = msg.status
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
          loadedModelIdRef.current = msg.modelId
          setModelError(null)
          setDownloadProgress(100)
          setDownloadFile(null)
        } else if (msg.status === 'error') {
          loadedModelIdRef.current = null
          setModelError(msg.error ?? 'Failed to load local translation model.')
        } else if (msg.status === 'downloading') {
          setModelError(null)
        }
        return
      }

      if (msg.type === 'dropped') {
        const dropped = pendingRef.current.get(msg.requestId)
        pendingRef.current.delete(msg.requestId)
        if (!dropped) {
          scheduleIdleWorkerTeardown()
          return
        }
        if (dropped.kind === 'load') {
          dropped.resolve(false)
        } else if (dropped.kind === 'outgoing') {
          dropped.reject(new Error('Translation request was cancelled.'))
        } else if (dropped.kind === 'message') {
          inFlightByKeyRef.current.delete(dropped.cacheKey)
          setTranslations((prev) => {
            if (prev[dropped.cacheKey]?.status !== 'loading') return prev
            const next = { ...prev }
            delete next[dropped.cacheKey]
            translationsRef.current = next
            return next
          })
          dropped.resolve(null)
        }
        scheduleIdleWorkerTeardown()
        return
      }

      const pending = pendingRef.current.get(msg.requestId)
      if (!pending) return
      pendingRef.current.delete(msg.requestId)

      if (msg.type === 'result') {
        if (msg.modelId === activeModelRef.current.id) {
          loadedModelIdRef.current = msg.modelId
          setRuntimeDevice(msg.runtimeDevice)
          if (modelStatusRef.current !== 'ready') {
            setModelStatus('ready')
            modelStatusRef.current = 'ready'
            setDownloadProgress(100)
            setDownloadFile(null)
            setModelError(null)
          }
        }

        if (pending.kind === 'load') {
          pending.resolve(true)
          scheduleIdleWorkerTeardown()
          return
        }

        if (pending.kind === 'outgoing') {
          const translated = msg.text.trim()
          pending.resolve(translated || pending.originalText)
          scheduleIdleWorkerTeardown()
          return
        }

        if (pending.kind === 'message') {
          inFlightByKeyRef.current.delete(pending.cacheKey)
          // Drop stale result if user switched models while this job was queued
          if (pending.modelKey !== settingsRef.current.model) {
            pending.resolve(null)
            scheduleIdleWorkerTeardown()
            return
          }
          const translated = msg.text.trim()
          const now = Date.now()
          if (!translated) {
            setTranslations((prev) => {
              if (prev[pending.cacheKey]?.status !== 'loading') return prev
              const next = { ...prev }
              delete next[pending.cacheKey]
              translationsRef.current = next
              return next
            })
            pending.resolve(null)
            scheduleIdleWorkerTeardown()
            return
          }

          const nextPersisted = saveTranslationCache({
            ...persistedTranslationsRef.current,
            [pending.cacheKey]: {
              text: translated,
              targetLang: pending.targetLang,
              modelKey: pending.modelKey,
              updatedAt: now,
            },
          })
          persistedTranslationsRef.current = nextPersisted
          setCachedTranslationCount(Object.keys(nextPersisted).length)

          const entry: TranslationEntry = {
            status: 'done',
            text: translated,
            targetLang: pending.targetLang,
            updatedAt: now,
          }
          setTranslations((prev) => {
            const next = { ...prev, [pending.cacheKey]: entry }
            translationsRef.current = next
            return next
          })
          pending.resolve(translated)
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
        if (pending.kind === 'outgoing') {
          pending.reject(new Error(msg.error || 'Unable to translate message.'))
          scheduleIdleWorkerTeardown()
          return
        }
        if (pending.kind === 'message') {
          inFlightByKeyRef.current.delete(pending.cacheKey)
          if (pending.modelKey !== settingsRef.current.model) {
            pending.resolve(null)
            scheduleIdleWorkerTeardown()
            return
          }
          setTranslations((prev) => {
            const next: Record<string, TranslationEntry> = {
              ...prev,
              [pending.cacheKey]: {
                status: 'error',
                error: msg.error || 'Translation failed.',
                targetLang: pending.targetLang,
                updatedAt: Date.now(),
              },
            }
            translationsRef.current = next
            return next
          })
          pending.resolve(null)
          scheduleIdleWorkerTeardown()
        }
      }
    },
    [scheduleIdleWorkerTeardown]
  )

  const ensureWorker = useCallback((): Worker => {
    clearIdleTeardownTimer()
    if (workerRef.current) return workerRef.current
    if (typeof Worker === 'undefined') {
      throw new Error('Web Workers are unavailable in this browser.')
    }
    const worker = new Worker(
      new URL('../lib/translator.worker.ts', import.meta.url),
      { type: 'module' }
    )
    worker.onmessage = handleWorkerMessage
    worker.onerror = (ev) => {
      const errMsg = ev.message || 'Translator worker crashed.'
      loadedModelIdRef.current = null
      loadPromiseRef.current = null
      setModelStatus('error')
      modelStatusRef.current = 'error'
      setModelError(errMsg)

      for (const req of pendingRef.current.values()) {
        if (req.kind === 'load') {
          req.resolve(false)
        } else if (req.kind === 'outgoing') {
          req.reject(new Error(errMsg))
        } else if (req.kind === 'message') {
          inFlightByKeyRef.current.delete(req.cacheKey)
          setTranslations((prev) => ({
            ...prev,
            [req.cacheKey]: {
              status: 'error',
              error: errMsg,
              targetLang: req.targetLang,
              updatedAt: Date.now(),
            },
          }))
          req.resolve(null)
        }
      }
      pendingRef.current.clear()
      inFlightByKeyRef.current.clear()
      worker.terminate()
      if (workerRef.current === worker) {
        workerRef.current = null
      }
    }
    workerRef.current = worker
    return worker
  }, [clearIdleTeardownTimer, handleWorkerMessage])

  const preloadModel = useCallback(async (): Promise<boolean> => {
    const model = activeModelRef.current
    if (loadedModelIdRef.current === model.id && workerRef.current) {
      setModelStatus('ready')
      modelStatusRef.current = 'ready'
      setDownloadProgress(100)
      return true
    }
    if (loadPromiseRef.current && loadPromiseRef.current.modelId === model.id) {
      return await loadPromiseRef.current.promise
    }

    const promise = (async (): Promise<boolean> => {
      try {
        const worker = ensureWorker()
        const requestId = nextRequestId('load')
        setModelStatus('downloading')
        modelStatusRef.current = 'downloading'
        setDownloadProgress(0)
        setDownloadFile(null)
        setModelError(null)

        return await new Promise<boolean>((resolve) => {
          pendingRef.current.set(requestId, {
            kind: 'load',
            modelId: model.id,
            resolve,
          })
          const payload: TranslatorWorkerInMessage = {
            type: 'load',
            requestId,
            modelKey: model.key,
            modelId: model.id,
          }
          worker.postMessage(payload)
        })
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : 'Unable to initialize translator worker.'
        setModelStatus('error')
        modelStatusRef.current = 'error'
        setModelError(errMsg)
        return false
      } finally {
        if (loadPromiseRef.current?.modelId === model.id) {
          loadPromiseRef.current = null
        }
        scheduleIdleWorkerTeardown()
      }
    })()

    loadPromiseRef.current = { modelId: model.id, promise }
    return await promise
  }, [ensureWorker, nextRequestId, scheduleIdleWorkerTeardown])

  const updateSettings = useCallback(
    (patch: Partial<TranslatorSettings>) => {
      const prev = settingsRef.current
      const nextModelKey =
        patch.model !== undefined ? normalizeModelKey(patch.model) : prev.model
      const modelChanged = nextModelKey !== prev.model

      const next: TranslatorSettings = {
        enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : prev.enabled,
        model: nextModelKey,
        myLanguage:
          patch.myLanguage !== undefined
            ? normalizeLanguageName(patch.myLanguage, prev.myLanguage)
            : prev.myLanguage,
        outgoingEnabled:
          patch.outgoingEnabled !== undefined
            ? Boolean(patch.outgoingEnabled)
            : prev.outgoingEnabled,
        outgoingLanguage:
          patch.outgoingLanguage !== undefined
            ? normalizeLanguageName(patch.outgoingLanguage, prev.outgoingLanguage)
            : prev.outgoingLanguage,
        underlyingCollapsed:
          patch.underlyingCollapsed !== undefined
            ? Boolean(patch.underlyingCollapsed)
            : prev.underlyingCollapsed,
      }

      settingsRef.current = next
      activeModelRef.current = TRANSLATOR_MODELS[next.model]
      setSettings(next)
      saveTranslatorSettings(next)

      if (modelChanged) {
        // Clear in-memory translations (preserving outgoing originals) so messages re-translate with the new model
        inFlightByKeyRef.current.clear()
        const rehydrated = loadTranslationCache(next.model)
        persistedTranslationsRef.current = rehydrated
        const hydratedEntries: Record<string, TranslationEntry> = {}
        for (const [key, rec] of Object.entries(rehydrated)) {
          hydratedEntries[key] = {
            status: 'done',
            text: rec.text,
            targetLang: rec.targetLang,
            updatedAt: rec.updatedAt,
          }
        }
        const merged = hydrateOutgoingIntoTranslations(
          persistedOutgoingRef.current,
          hydratedEntries
        )
        translationsRef.current = merged
        setTranslations(merged)
        setCachedTranslationCount(Object.keys(rehydrated).length)

        if (loadedModelIdRef.current !== TRANSLATOR_MODELS[next.model].id) {
          loadPromiseRef.current = null
          setModelStatus('idle')
          modelStatusRef.current = 'idle'
          setDownloadProgress(0)
          setDownloadFile(null)
          setRuntimeDevice(null)
          setModelError(null)
          if (next.enabled) {
            void preloadModel()
          }
        }
        return
      }

      // Kick off lazy model preload when user turns Translator Mode on while idle or errored
      if (
        !prev.enabled &&
        next.enabled &&
        (modelStatusRef.current === 'idle' || modelStatusRef.current === 'error')
      ) {
        void preloadModel()
      }
    },
    [preloadModel]
  )

  const recordOutgoingOriginal = useCallback(
    (
      msgId: string,
      originalText: string,
      translatedText: string,
      targetLang: string
    ) => {
      const cleanId = msgId.trim()
      if (!cleanId) return
      const sourceLang = settingsRef.current.myLanguage
      const cleanTarget = targetLang.trim() || settingsRef.current.outgoingLanguage
      const now = Date.now()
      const nextPersisted = saveOutgoingOriginals({
        ...persistedOutgoingRef.current,
        [cleanId]: {
          originalText,
          sourceLang,
          translatedText,
          targetLang: cleanTarget,
          updatedAt: now,
        },
      })
      persistedOutgoingRef.current = nextPersisted
      const stripped = stripOutgoingTimestamps(nextPersisted)
      originalOutgoingByIdRef.current = stripped
      setOriginalOutgoingById(stripped)

      // Also expose under translations[msgId:sourceLang] so left-column lookups are instant
      const sourceKey = translationCacheKey(cleanId, sourceLang)
      setTranslations((prev) => {
        const next: Record<string, TranslationEntry> = {
          ...prev,
          [sourceKey]: {
            status: 'done',
            text: originalText,
            targetLang: sourceLang,
            updatedAt: now,
          },
        }
        translationsRef.current = next
        return next
      })
    },
    []
  )

  const translateMessage = useCallback(
    (
      msgId: string,
      text: string,
      targetLang?: string
    ): Promise<string | null> => {
      const cleanId = msgId.trim()
      if (!cleanId || isNonTranslatableText(text)) {
        return Promise.resolve(null)
      }

      const resolvedLang = normalizeLanguageName(
        targetLang,
        settingsRef.current.myLanguage
      )

      // If this is our own previously translated outgoing message and target matches our source language,
      // return the exact original text we wrote instead of round-trip translating.
      const ownOriginal = originalOutgoingByIdRef.current[cleanId]
      if (
        ownOriginal &&
        ownOriginal.sourceLang.trim().toLowerCase() === resolvedLang.toLowerCase()
      ) {
        return Promise.resolve(ownOriginal.originalText)
      }

      const cacheKey = translationCacheKey(cleanId, resolvedLang)
      const existing = translationsRef.current[cacheKey]
      if (existing?.status === 'done' && existing.text) {
        const persisted = persistedTranslationsRef.current[cacheKey]
        if (persisted) {
          persisted.updatedAt = Date.now()
        }
        return Promise.resolve(existing.text)
      }

      const inFlight = inFlightByKeyRef.current.get(cacheKey)
      if (inFlight) return inFlight

      const model = activeModelRef.current
      const promise = new Promise<string | null>((resolve) => {
        try {
          const worker = ensureWorker()
          const requestId = nextRequestId('msg')

          setTranslations((prev) => {
            const next: Record<string, TranslationEntry> = {
              ...prev,
              [cacheKey]: {
                status: 'loading',
                targetLang: resolvedLang,
                updatedAt: Date.now(),
              },
            }
            translationsRef.current = next
            return next
          })

          pendingRef.current.set(requestId, {
            kind: 'message',
            modelKey: model.key,
            cacheKey,
            targetLang: resolvedLang,
            resolve,
          })

          const payload: TranslatorWorkerInMessage = {
            type: 'translate',
            requestId,
            modelKey: model.key,
            modelId: model.id,
            text,
            targetLang: resolvedLang,
            priority: 'normal',
          }
          worker.postMessage(payload)
        } catch (err) {
          const errMsg =
            err instanceof Error ? err.message : 'Unable to start local translator.'
          setTranslations((prev) => {
            const next: Record<string, TranslationEntry> = {
              ...prev,
              [cacheKey]: {
                status: 'error',
                error: errMsg,
                targetLang: resolvedLang,
                updatedAt: Date.now(),
              },
            }
            translationsRef.current = next
            return next
          })
          resolve(null)
        }
      }).finally(() => {
        inFlightByKeyRef.current.delete(cacheKey)
      })

      inFlightByKeyRef.current.set(cacheKey, promise)
      return promise
    },
    [ensureWorker, nextRequestId]
  )

  const translateOutgoingText = useCallback(
    async (text: string, targetLang?: string): Promise<string> => {
      if (isNonTranslatableText(text)) {
        return text
      }

      const resolvedTarget = normalizeLanguageName(
        targetLang,
        settingsRef.current.outgoingLanguage
      )
      const sourceLang = settingsRef.current.myLanguage

      if (sourceLang.trim().toLowerCase() === resolvedTarget.toLowerCase()) {
        return text
      }

      const model = activeModelRef.current
      const worker = ensureWorker()
      const requestId = nextRequestId('out')

      return await new Promise<string>((resolve, reject) => {
        pendingRef.current.set(requestId, {
          kind: 'outgoing',
          originalText: text,
          resolve,
          reject,
        })
        const payload: TranslatorWorkerInMessage = {
          type: 'translate',
          requestId,
          modelKey: model.key,
          modelId: model.id,
          text,
          sourceLang,
          targetLang: resolvedTarget,
          priority: 'high',
        }
        worker.postMessage(payload)
      })
    },
    [ensureWorker, nextRequestId]
  )

  const clearTranslationCache = useCallback(() => {
    safeStorageRemove(TRANSLATIONS_STORAGE_KEY)
    persistedTranslationsRef.current = {}
    setTranslations((prev) => {
      const loadingOnly: Record<string, TranslationEntry> = {}
      for (const [key, entry] of Object.entries(prev)) {
        if (entry.status === 'loading') {
          loadingOnly[key] = entry
        }
      }
      const next = hydrateOutgoingIntoTranslations(
        persistedOutgoingRef.current,
        loadingOnly
      )
      translationsRef.current = next
      return next
    })
    setCachedTranslationCount(0)
    pushToastRef.current?.(
      'info',
      'Translation cache cleared',
      'Saved message translations were removed from this device.'
    )
  }, [])

  const clearModelCache = useCallback(async (): Promise<void> => {
    terminateWorker()
    setModelStatus('idle')
    modelStatusRef.current = 'idle'
    setDownloadProgress(0)
    setDownloadFile(null)
    setRuntimeDevice(null)
    setModelError(null)

    try {
      if (typeof caches !== 'undefined') {
        await caches.delete(TRANSLATOR_CACHE_KEY)
      }
      await evictLegacyLfm3Caches()
      pushToastRef.current?.(
        'info',
        'Translator model cache cleared',
        'Cached M2M-100 / NLLB-200 translation weights were removed from browser storage.'
      )
    } catch {
      pushToastRef.current?.(
        'warning',
        'Cache clear incomplete',
        'Browser storage prevented removing cached translation model weights.'
      )
    }
  }, [terminateWorker])

  const resetAll = useCallback(() => {
    terminateWorker()
    safeStorageRemove(PREFS_STORAGE_KEY)
    safeStorageRemove(TRANSLATIONS_STORAGE_KEY)
    safeStorageRemove(OUTGOING_ORIGINALS_STORAGE_KEY)

    const defaults = { ...DEFAULT_TRANSLATOR_SETTINGS }
    settingsRef.current = defaults
    activeModelRef.current = TRANSLATOR_MODELS[defaults.model]
    setSettings(defaults)

    persistedTranslationsRef.current = {}
    translationsRef.current = {}
    setTranslations({})
    setCachedTranslationCount(0)

    persistedOutgoingRef.current = {}
    originalOutgoingByIdRef.current = {}
    setOriginalOutgoingById({})

    setModelStatus('idle')
    modelStatusRef.current = 'idle'
    setDownloadProgress(0)
    setDownloadFile(null)
    setRuntimeDevice(null)
    setModelError(null)
  }, [terminateWorker])

  return useMemo<TranslatorEngine>(
    () => ({
      settings,
      updateSettings,
      modelKey: activeModel.key,
      modelId: activeModel.id,
      modelLabel: activeModel.label,
      modelSizeHint: activeModel.sizeHint,
      modelStatus,
      downloadProgress,
      downloadFile,
      runtimeDevice,
      modelError,
      webGpuSupported,
      preloadModel,
      clearModelCache,
      translations,
      originalOutgoingById,
      recordOutgoingOriginal,
      translateMessage,
      translateOutgoingText,
      cachedTranslationCount,
      clearTranslationCache,
      resetAll,
    }),
    [
      settings,
      updateSettings,
      activeModel,
      modelStatus,
      downloadProgress,
      downloadFile,
      runtimeDevice,
      modelError,
      webGpuSupported,
      preloadModel,
      clearModelCache,
      translations,
      originalOutgoingById,
      recordOutgoingOriginal,
      translateMessage,
      translateOutgoingText,
      cachedTranslationCount,
      clearTranslationCache,
      resetAll,
    ]
  )
}
