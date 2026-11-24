import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ToastLevel } from '../types/protocol.ts'
import {
  DEFAULT_TRANSLATOR_SETTINGS,
  getDefaultTranslatorModelKey,
  resolveInitialOpusModelId,
  TRANSLATOR_CACHE_KEY,
  TRANSLATOR_MODELS,
  translationCacheKey,
  type OutgoingOriginalEntry,
  type TranslateMessageOptions,
  type TranslationEntry,
  type TranslatorEngine,
  type TranslatorJobPriority,
  type TranslatorModelKey,
  type TranslatorModelStatus,
  type TranslatorRuntimeDevice,
  type TranslatorSettings,
} from '../types/translator.ts'
import { isNonTranslatableText } from '../lib/languageDetect.ts'
import type {
  TranslatorWorkerInMessage,
  TranslatorWorkerOutMessage,
} from '../lib/translator.worker.ts'

const PREFS_STORAGE_KEY = 'agnostr:v2:translator_prefs'
const LEGACY_V2_TRANSLATIONS_STORAGE_KEY = 'agnostr:v2:translations'
const TRANSLATIONS_STORAGE_KEY = 'agnostr:v3:translations'
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
  detectedSourceLang?: string
  sameLanguage?: boolean
  updatedAt: number
}

interface PersistedOutgoingRecord extends OutgoingOriginalEntry {
  updatedAt: number
}

interface PendingLoadRequest {
  kind: 'load'
  modelKey: TranslatorModelKey
  modelId: string
  resolve: (ok: boolean) => void
}

interface PendingMessageRequest {
  kind: 'message'
  modelKey: TranslatorModelKey
  cacheKey: string
  targetLang: string
  scopeKey?: string
  resolve: (text: string | null) => void
}

interface PendingOutgoingRequest {
  kind: 'outgoing'
  modelKey: TranslatorModelKey
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

function normalizeModelKey(
  raw: unknown,
  fallback: TranslatorModelKey = getDefaultTranslatorModelKey()
): TranslatorModelKey {
  if (raw === 'opus' || raw === 'nllb200' || raw === 'm2m100') return raw
  return fallback
}

function isLegacyOrBrokenCacheUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return (
    lower.includes('lfm3-1.7b-onnx') ||
    lower.includes('lfm3%2d1.7b') ||
    lower.includes('onnx-community/lfm3') ||
    lower.includes('onnx-community%2flfm3') ||
    ((lower.includes('m2m100_418m') || lower.includes('m2m100%5f418m')) &&
      lower.includes('_q4f16.onnx'))
  )
}

function matchesActiveModelCacheUrl(
  lowerUrl: string,
  modelKey: TranslatorModelKey
): boolean {
  if (isLegacyOrBrokenCacheUrl(lowerUrl)) return false
  if (modelKey === 'opus') {
    return lowerUrl.includes('opus-mt-')
  }
  if (modelKey === 'm2m100') {
    return lowerUrl.includes('m2m100')
  }
  return lowerUrl.includes('nllb-200')
}

async function inspectTranslatorModelCache(
  activeModelKey: TranslatorModelKey
): Promise<{ isModelCached: boolean; cachedModelBytes: number }> {
  if (typeof caches === 'undefined') {
    return { isModelCached: false, cachedModelBytes: 0 }
  }
  try {
    const exists = await caches.has(TRANSLATOR_CACHE_KEY)
    if (!exists) {
      return { isModelCached: false, cachedModelBytes: 0 }
    }
    const cache = await caches.open(TRANSLATOR_CACHE_KEY)
    const keys = await cache.keys()
    let matchedActiveOnnx = 0
    let totalOnnxBytes = 0

    for (const req of keys) {
      const lowerUrl = req.url.toLowerCase()
      if (!lowerUrl.includes('.onnx') || isLegacyOrBrokenCacheUrl(lowerUrl)) {
        continue
      }
      if (matchesActiveModelCacheUrl(lowerUrl, activeModelKey)) {
        matchedActiveOnnx += 1
      }
      try {
        const res = await cache.match(req)
        const contentLength = res?.headers?.get('content-length')
        const parsedBytes = contentLength ? Number.parseInt(contentLength, 10) : 0
        if (Number.isFinite(parsedBytes) && parsedBytes > 0) {
          totalOnnxBytes += parsedBytes
        }
      } catch {
        // Never read response bodies into RAM; ignore header read failures
      }
    }

    return {
      isModelCached: matchedActiveOnnx >= 2,
      cachedModelBytes: totalOnnxBytes,
    }
  } catch {
    return { isModelCached: false, cachedModelBytes: 0 }
  }
}

async function evictLegacyTranslatorCaches(): Promise<void> {
  if (typeof caches === 'undefined') return
  for (const cacheName of [TRANSLATOR_CACHE_KEY, LEGACY_TRANSFORMERS_CACHE_KEY]) {
    try {
      const exists = await caches.has(cacheName)
      if (!exists) continue
      const cache = await caches.open(cacheName)
      const keys = await cache.keys()
      for (const req of keys) {
        if (isLegacyOrBrokenCacheUrl(req.url)) {
          await cache.delete(req)
        }
      }
    } catch {
      // Ignore storage restrictions
    }
  }
}

function loadTranslatorSettings(): TranslatorSettings {
  const defaultModel = getDefaultTranslatorModelKey()
  const raw = safeStorageGet(PREFS_STORAGE_KEY)
  if (!raw) return { ...DEFAULT_TRANSLATOR_SETTINGS, model: defaultModel }
  try {
    const parsed = JSON.parse(raw) as Partial<TranslatorSettings>
    return {
      enabled: Boolean(parsed.enabled),
      model: normalizeModelKey(parsed.model, defaultModel),
      sourceLanguage: normalizeLanguageName(
        parsed.sourceLanguage,
        DEFAULT_TRANSLATOR_SETTINGS.sourceLanguage
      ),
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
    return { ...DEFAULT_TRANSLATOR_SETTINGS, model: defaultModel }
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
  // Purge legacy v2 translation cache that could hold poisoned wrong-language/garbage entries
  safeStorageRemove(LEGACY_V2_TRANSLATIONS_STORAGE_KEY)
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
          detectedSourceLang:
            typeof rec.detectedSourceLang === 'string' && rec.detectedSourceLang.trim()
              ? rec.detectedSourceLang.trim()
              : undefined,
          sameLanguage: typeof rec.sameLanguage === 'boolean' ? rec.sameLanguage : undefined,
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
  const [isModelCached, setIsModelCached] = useState<boolean>(false)
  const [cachedModelBytes, setCachedModelBytes] = useState<number>(0)
  const [storagePersisted, setStoragePersisted] = useState<boolean>(false)

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
        detectedSourceLang: rec.detectedSourceLang,
        sameLanguage: rec.sameLanguage,
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
  const loadPromiseRef = useRef<{ modelKey: TranslatorModelKey; promise: Promise<boolean> } | null>(null)
  const loadedModelKeyRef = useRef<TranslatorModelKey | null>(null)
  const loadedModelIdRef = useRef<string | null>(null)
  const reqSeqRef = useRef<number>(0)
  const idleTeardownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistRequestedRef = useRef<boolean>(false)
  const downloadCancelledRef = useRef<boolean>(false)

  const clearIdleTeardownTimer = useCallback(() => {
    if (idleTeardownTimerRef.current !== null) {
      clearTimeout(idleTeardownTimerRef.current)
      idleTeardownTimerRef.current = null
    }
  }, [])

  const refreshModelCacheStatus = useCallback(
    async (modelKeyOverride?: TranslatorModelKey) => {
      const targetKey = modelKeyOverride ?? settingsRef.current.model
      const info = await inspectTranslatorModelCache(targetKey)
      // Only commit if active model hasn't switched while inspecting Cache Storage
      if (settingsRef.current.model !== targetKey) return
      setIsModelCached(info.isModelCached)
      setCachedModelBytes(info.cachedModelBytes)
    },
    []
  )

  const requestPersistentStorage = useCallback(async () => {
    if (persistRequestedRef.current) return
    persistRequestedRef.current = true
    try {
      const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined
      if (!storage) return
      if (typeof storage.persisted === 'function') {
        const already = await storage.persisted()
        if (already) {
          setStoragePersisted(true)
          return
        }
      }
      if (typeof storage.persist === 'function') {
        const granted = await storage.persist()
        setStoragePersisted(Boolean(granted))
      }
    } catch {
      // Ignore storage persistence restrictions
    }
  }, [])

  // Verify actual WebGPU adapter availability, read persistent storage status,
  // silently evict legacy LFM3/broken cache entries, and inspect cached ONNX weights on mount
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
    const checkPersisted = async () => {
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.storage?.persisted === 'function') {
          const persisted = await navigator.storage.persisted()
          if (!cancelled) setStoragePersisted(Boolean(persisted))
        }
      } catch {
        // Ignore storage query errors
      }
    }
    void probe()
    void checkPersisted()
    safeStorageRemove(LEGACY_V2_TRANSLATIONS_STORAGE_KEY)
    void evictLegacyTranslatorCaches().then(() => {
      if (!cancelled) {
        void refreshModelCacheStatus(settingsRef.current.model)
      }
    })
    return () => {
      cancelled = true
    }
  }, [refreshModelCacheStatus])

  const nextRequestId = useCallback((prefix: string): string => {
    reqSeqRef.current += 1
    return `${prefix}-${Date.now()}-${reqSeqRef.current}`
  }, [])

  const terminateWorker = useCallback(() => {
    clearIdleTeardownTimer()
    const w = workerRef.current
    workerRef.current = null
    loadedModelKeyRef.current = null
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

  const cancelScope = useCallback(
    (keepScopeKey?: string) => {
      if (workerRef.current) {
        try {
          workerRef.current.postMessage({
            type: 'cancelScope',
            keepScopeKey,
          } satisfies TranslatorWorkerInMessage)
        } catch {
          // Ignore postMessage failure
        }
      }

      const staleKeys: string[] = []
      for (const [reqId, req] of Array.from(pendingRef.current.entries())) {
        if (req.kind !== 'message') continue
        if (!keepScopeKey || req.scopeKey !== keepScopeKey) {
          pendingRef.current.delete(reqId)
          inFlightByKeyRef.current.delete(req.cacheKey)
          staleKeys.push(req.cacheKey)
          req.resolve(null)
        }
      }

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

      scheduleIdleWorkerTeardown()
    },
    [scheduleIdleWorkerTeardown]
  )

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
        // Match by modelKey (not strict modelId) so dynamic Opus-MT pair IDs update status cleanly
        if (msg.modelKey !== activeModelRef.current.key) return
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
          loadedModelKeyRef.current = msg.modelKey
          loadedModelIdRef.current = msg.modelId
          setModelError(null)
          setDownloadProgress(100)
          setDownloadFile(null)
          void refreshModelCacheStatus(msg.modelKey)
        } else if (msg.status === 'error') {
          loadedModelKeyRef.current = null
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
        if (msg.modelKey === activeModelRef.current.key) {
          loadedModelKeyRef.current = msg.modelKey
          loadedModelIdRef.current = msg.modelId
          setRuntimeDevice(msg.runtimeDevice)
          if (modelStatusRef.current !== 'ready') {
            setModelStatus('ready')
            modelStatusRef.current = 'ready'
            setDownloadProgress(100)
            setDownloadFile(null)
            setModelError(null)
            void refreshModelCacheStatus(msg.modelKey)
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
              detectedSourceLang: msg.detectedSourceLang,
              sameLanguage: msg.sameLanguage,
              updatedAt: now,
            },
          })
          persistedTranslationsRef.current = nextPersisted
          setCachedTranslationCount(Object.keys(nextPersisted).length)

          const entry: TranslationEntry = {
            status: 'done',
            text: translated,
            targetLang: pending.targetLang,
            detectedSourceLang: msg.detectedSourceLang,
            sameLanguage: msg.sameLanguage,
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
    [refreshModelCacheStatus, scheduleIdleWorkerTeardown]
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
      loadedModelKeyRef.current = null
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
    downloadCancelledRef.current = false
    const model = activeModelRef.current
    const targetModelId =
      model.key === 'opus'
        ? resolveInitialOpusModelId(
            settingsRef.current.myLanguage,
            settingsRef.current.sourceLanguage
          )
        : model.id

    if (
      loadedModelKeyRef.current === model.key &&
      (model.key === 'opus'
        ? Boolean(loadedModelIdRef.current)
        : loadedModelIdRef.current === targetModelId) &&
      workerRef.current
    ) {
      setModelStatus('ready')
      modelStatusRef.current = 'ready'
      setDownloadProgress(100)
      return true
    }
    if (loadPromiseRef.current && loadPromiseRef.current.modelKey === model.key) {
      return await loadPromiseRef.current.promise
    }

    // If a worker already has active requests for this same model key (e.g. a translate job
    // is already loading the needed Opus pair), do not post a competing `{ type: 'load' }` job.
    if (workerRef.current && pendingRef.current.size > 0) {
      for (const req of pendingRef.current.values()) {
        if (req.modelKey === model.key) {
          return true
        }
      }
    }

    void requestPersistentStorage()

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
            modelKey: model.key,
            modelId: targetModelId,
            resolve,
          })
          const payload: TranslatorWorkerInMessage = {
            type: 'load',
            requestId,
            modelKey: model.key,
            modelId: targetModelId,
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
        if (loadPromiseRef.current?.modelKey === model.key) {
          loadPromiseRef.current = null
        }
        scheduleIdleWorkerTeardown()
      }
    })()

    loadPromiseRef.current = { modelKey: model.key, promise }
    return await promise
  }, [ensureWorker, nextRequestId, requestPersistentStorage, scheduleIdleWorkerTeardown])

  const cancelDownload = useCallback(() => {
    downloadCancelledRef.current = true
    terminateWorker()
    setTranslations((prev) => {
      let changed = false
      const next = { ...prev }
      for (const [key, entry] of Object.entries(next)) {
        if (entry.status === 'loading') {
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
    setModelStatus('idle')
    modelStatusRef.current = 'idle'
    setDownloadProgress(0)
    setDownloadFile(null)
    setRuntimeDevice(null)
    setModelError(null)
    void refreshModelCacheStatus(settingsRef.current.model)
    pushToastRef.current?.('info', 'Translation model download cancelled')
  }, [refreshModelCacheStatus, terminateWorker])

  const updateSettings = useCallback(
    (patch: Partial<TranslatorSettings>) => {
      const prev = settingsRef.current
      const nextModelKey =
        patch.model !== undefined ? normalizeModelKey(patch.model) : prev.model
      const modelChanged = nextModelKey !== prev.model

      const next: TranslatorSettings = {
        enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : prev.enabled,
        model: nextModelKey,
        sourceLanguage:
          patch.sourceLanguage !== undefined
            ? normalizeLanguageName(patch.sourceLanguage, prev.sourceLanguage)
            : prev.sourceLanguage,
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

      const langChanged =
        next.myLanguage !== prev.myLanguage || next.sourceLanguage !== prev.sourceLanguage
      const turnedOff = prev.enabled && !next.enabled

      settingsRef.current = next
      activeModelRef.current = TRANSLATOR_MODELS[next.model]
      setSettings(next)
      saveTranslatorSettings(next)

      if (modelChanged || langChanged || turnedOff) {
        cancelScope()
      }

      if (modelChanged) {
        downloadCancelledRef.current = false
        if (modelStatusRef.current === 'downloading' || loadPromiseRef.current !== null) {
          terminateWorker()
        }
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
            detectedSourceLang: rec.detectedSourceLang,
            sameLanguage: rec.sameLanguage,
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
        void refreshModelCacheStatus(next.model)

        if (loadedModelKeyRef.current !== next.model) {
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

      if (langChanged && next.enabled) {
        downloadCancelledRef.current = false
      }

      // Kick off lazy model preload when user turns Translator Mode on while idle or errored
      if (
        !prev.enabled &&
        next.enabled &&
        (modelStatusRef.current === 'idle' || modelStatusRef.current === 'error')
      ) {
        downloadCancelledRef.current = false
        void preloadModel()
      }
    },
    [cancelScope, preloadModel, refreshModelCacheStatus, terminateWorker]
  )

  const recordOutgoingOriginal = useCallback(
    (
      msgId: string,
      originalText: string,
      translatedText: string,
      targetLang: string,
      sourceLang?: string
    ) => {
      const cleanId = msgId.trim()
      if (!cleanId) return
      const resolvedSource = normalizeLanguageName(
        sourceLang,
        settingsRef.current.myLanguage
      )
      const cleanTarget = targetLang.trim() || settingsRef.current.outgoingLanguage
      const now = Date.now()
      const nextPersisted = saveOutgoingOriginals({
        ...persistedOutgoingRef.current,
        [cleanId]: {
          originalText,
          sourceLang: resolvedSource,
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
      const sourceKey = translationCacheKey(cleanId, resolvedSource)
      setTranslations((prev) => {
        const next: Record<string, TranslationEntry> = {
          ...prev,
          [sourceKey]: {
            status: 'done',
            text: originalText,
            targetLang: resolvedSource,
            detectedSourceLang: resolvedSource,
            sameLanguage: true,
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
      targetLang?: string,
      options?: TranslateMessageOptions
    ): Promise<string | null> => {
      const cleanId = msgId.trim()
      if (!cleanId || isNonTranslatableText(text)) {
        return Promise.resolve(null)
      }

      const resolvedLang = normalizeLanguageName(
        targetLang,
        settingsRef.current.myLanguage
      )

      const rawSource = options?.sourceLang ?? settingsRef.current.sourceLanguage
      const explicitSource =
        rawSource && rawSource.trim() && rawSource.trim().toLowerCase() !== 'auto'
          ? rawSource.trim()
          : undefined

      // If this is our own previously translated outgoing message and target matches its original language,
      // return the exact original text we wrote instead of round-trip translating.
      const ownOriginal = originalOutgoingByIdRef.current[cleanId]
      if (
        ownOriginal &&
        !explicitSource &&
        ownOriginal.sourceLang.trim().toLowerCase() === resolvedLang.toLowerCase()
      ) {
        return Promise.resolve(ownOriginal.originalText)
      }

      const cacheKey = translationCacheKey(cleanId, resolvedLang, explicitSource)
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

      // Do not automatically restart a download the user explicitly cancelled or after a worker error
      // until the user explicitly retries/preloads or re-enables Translator Mode.
      if (
        (downloadCancelledRef.current || modelStatusRef.current === 'error') &&
        !workerRef.current
      ) {
        return Promise.resolve(null)
      }

      const model = activeModelRef.current
      void requestPersistentStorage()
      const targetModelId =
        model.key === 'opus'
          ? resolveInitialOpusModelId(resolvedLang, explicitSource ?? 'Auto')
          : model.id
      let promiseRef: Promise<string | null> | null = null
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
            scopeKey: options?.scopeKey,
            resolve,
          })

          const priority: TranslatorJobPriority =
            options?.priority === 'live' || options?.priority === 'visible'
              ? options.priority
              : 'normal'

          const payload: TranslatorWorkerInMessage = {
            type: 'translate',
            requestId,
            modelKey: model.key,
            modelId: targetModelId,
            text,
            targetLang: resolvedLang,
            sourceLang: explicitSource,
            roomHintLang: options?.roomHintLang ?? null,
            scopeKey: options?.scopeKey,
            priority,
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
        if (promiseRef && inFlightByKeyRef.current.get(cacheKey) === promiseRef) {
          inFlightByKeyRef.current.delete(cacheKey)
        }
      })

      promiseRef = promise
      inFlightByKeyRef.current.set(cacheKey, promise)
      return promise
    },
    [ensureWorker, nextRequestId, requestPersistentStorage]
  )

  const translateOutgoingText = useCallback(
    async (text: string, targetLang?: string, sourceLang?: string): Promise<string> => {
      if (isNonTranslatableText(text)) {
        return text
      }

      const resolvedTarget = normalizeLanguageName(
        targetLang,
        settingsRef.current.outgoingLanguage
      )
      const resolvedSource = normalizeLanguageName(
        sourceLang,
        settingsRef.current.myLanguage
      )

      if (resolvedSource.toLowerCase() === resolvedTarget.toLowerCase()) {
        return text
      }

      const model = activeModelRef.current
      void requestPersistentStorage()
      const targetModelId =
        model.key === 'opus'
          ? resolveInitialOpusModelId(resolvedTarget, resolvedSource)
          : model.id
      const worker = ensureWorker()
      const requestId = nextRequestId('out')

      return await new Promise<string>((resolve, reject) => {
        pendingRef.current.set(requestId, {
          kind: 'outgoing',
          modelKey: model.key,
          originalText: text,
          resolve,
          reject,
        })
        const payload: TranslatorWorkerInMessage = {
          type: 'translate',
          requestId,
          modelKey: model.key,
          modelId: targetModelId,
          text,
          sourceLang: resolvedSource,
          targetLang: resolvedTarget,
          priority: 'high',
        }
        worker.postMessage(payload)
      })
    },
    [ensureWorker, nextRequestId, requestPersistentStorage]
  )

  const clearTranslationCache = useCallback(() => {
    safeStorageRemove(TRANSLATIONS_STORAGE_KEY)
    safeStorageRemove(LEGACY_V2_TRANSLATIONS_STORAGE_KEY)
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
      await evictLegacyTranslatorCaches()
      setIsModelCached(false)
      setCachedModelBytes(0)
      await refreshModelCacheStatus(settingsRef.current.model)
      pushToastRef.current?.(
        'info',
        'Translator model cache cleared',
        'Cached Opus-MT / M2M-100 / NLLB-200 translation weights were removed from browser storage.'
      )
    } catch {
      pushToastRef.current?.(
        'warning',
        'Cache clear incomplete',
        'Browser storage prevented removing cached translation model weights.'
      )
    }
  }, [refreshModelCacheStatus, terminateWorker])

  const resetAll = useCallback(() => {
    downloadCancelledRef.current = false
    terminateWorker()
    safeStorageRemove(PREFS_STORAGE_KEY)
    safeStorageRemove(TRANSLATIONS_STORAGE_KEY)
    safeStorageRemove(LEGACY_V2_TRANSLATIONS_STORAGE_KEY)
    safeStorageRemove(OUTGOING_ORIGINALS_STORAGE_KEY)

    const defaults: TranslatorSettings = {
      ...DEFAULT_TRANSLATOR_SETTINGS,
      model: getDefaultTranslatorModelKey(),
    }
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
    void refreshModelCacheStatus(defaults.model)
  }, [refreshModelCacheStatus, terminateWorker])

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
      isModelCached,
      cachedModelBytes,
      storagePersisted,
      preloadModel,
      cancelDownload,
      clearModelCache,
      translations,
      originalOutgoingById,
      recordOutgoingOriginal,
      translateMessage,
      translateOutgoingText,
      cancelScope,
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
      isModelCached,
      cachedModelBytes,
      storagePersisted,
      preloadModel,
      cancelDownload,
      clearModelCache,
      translations,
      originalOutgoingById,
      recordOutgoingOriginal,
      translateMessage,
      translateOutgoingText,
      cancelScope,
      cachedTranslationCount,
      clearTranslationCache,
      resetAll,
    ]
  )
}
