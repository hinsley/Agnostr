import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  CONTENT_FILTER_CACHE_NAME,
  CONTENT_FILTER_MODEL_ID,
  CONTENT_FILTER_MODEL_LABEL,
  DEFAULT_CONTENT_FILTER_SETTINGS,
  type ContentFilterEngine,
  type ContentFilterModelStatus,
  type ContentFilterRuntimeDevice,
  type ContentFilterSettings,
  type ContentFilterVerdict,
  type PreloadModelOptions,
  type ScreenContentOptions,
  type ScreenImageAttachmentOptions,
} from '../types/contentFilter.ts'
import type { ImageAttachment, ToastLevel } from '../types/protocol.ts'
import { downloadAndVerifyMediaBlob } from '../lib/blossom.ts'
import type {
  ContentFilterRulesPayload,
  ContentFilterWorkerInMessage,
  ContentFilterWorkerOutMessage,
} from '../lib/contentFilter.worker.ts'
import {
  clearFilterVerdictsStorage,
  loadContentFilterSettings,
  loadFilterVerdicts,
  saveContentFilterSettings,
  saveFilterVerdicts,
} from '../lib/storage.ts'

const MAX_FLAGGED_REVEAL_BLOBS = 24
const MAX_IN_MEMORY_VERDICTS = 500

export interface UseContentFilterOptions {
  ownPubkeys: Set<string>
  trustedSet: Set<string>
  blockedSet: Set<string>
  pushToast?: (level: ToastLevel, title: string, detail?: string) => void
}

interface PendingWorkerRequest {
  resolve: (msg: ContentFilterWorkerOutMessage) => void
  reject: (err: Error) => void
}

function detectWebGpuSupport(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { gpu?: { requestAdapter?: unknown } }
  return Boolean(nav.gpu && typeof nav.gpu.requestAdapter === 'function')
}

function computeRulesFingerprint(settings: ContentFilterSettings): string {
  return [settings.filterNsfw ? '1' : '0', settings.filterIllegal ? '1' : '0'].join('|')
}

function hasAnyActiveRule(settings: ContentFilterSettings): boolean {
  if (!settings.enabled) return false
  return Boolean(settings.filterNsfw || settings.filterIllegal)
}

function shouldAutoPreloadModel(settings: ContentFilterSettings): boolean {
  if (!hasAnyActiveRule(settings)) return false
  return settings.mediaScope !== 'off' || settings.callVideoMode !== 'trusted-only'
}

function isLegacyCacheUrl(url: string): boolean {
  return (
    url.includes('LiquidAI/d1-2B-ONNX') ||
    url.includes('LiquidAI%2Fd1-2B-ONNX') ||
    url.includes('decoder_q4f16.onnx') ||
    url.includes('decoder_q4.onnx') ||
    url.includes('vision_encoder_q8.onnx') ||
    url.includes('mobileclip_s0') ||
    url.includes('Comment-Moderation-ONNX') ||
    url.includes('mobilebert-uncased-mnli')
  )
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '')
  const out = new Uint8Array(Math.floor(clean.length / 2))
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0
  }
  return out
}

function toStrictArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function decryptBlobWithHexKey(
  blob: Blob,
  decryptKeyHex: string,
  ivHex: string,
  mime: string
): Promise<Blob> {
  const cipherBytes = new Uint8Array(await blob.arrayBuffer())
  const keyBytes = hexToBytes(decryptKeyHex)
  const ivBytes = hexToBytes(ivHex)
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toStrictArrayBuffer(keyBytes),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  )
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toStrictArrayBuffer(ivBytes) },
    cryptoKey,
    toStrictArrayBuffer(cipherBytes)
  )
  return new Blob([plainBuf], { type: mime || 'image/webp' })
}

export function useContentFilter(opts: UseContentFilterOptions): ContentFilterEngine {
  const { ownPubkeys, trustedSet, blockedSet, pushToast } = opts

  const [settings, setSettings] = useState<ContentFilterSettings>(() =>
    loadContentFilterSettings()
  )
  const initialFingerprint = useMemo(
    () => computeRulesFingerprint(loadContentFilterSettings()),
    []
  )
  const [verdicts, setVerdicts] = useState<Record<string, ContentFilterVerdict>>(() =>
    loadFilterVerdicts(initialFingerprint)
  )
  const [modelStatus, setModelStatus] = useState<ContentFilterModelStatus>('idle')
  const [downloadProgress, setDownloadProgress] = useState<number>(0)
  const [downloadFile, setDownloadFile] = useState<string | null>(null)
  const [runtimeDevice, setRuntimeDevice] = useState<ContentFilterRuntimeDevice | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [safeUrlVersion, setSafeUrlVersion] = useState<number>(0)

  const webGpuSupported = useMemo(() => detectWebGpuSupport(), [])

  const settingsRef = useRef<ContentFilterSettings>(settings)
  const rulesFingerprintRef = useRef<string>(computeRulesFingerprint(settings))
  const verdictsRef = useRef<Record<string, ContentFilterVerdict>>(verdicts)
  const modelStatusRef = useRef<ContentFilterModelStatus>(modelStatus)
  const ownPubkeysRef = useRef<Set<string>>(ownPubkeys)
  const trustedSetRef = useRef<Set<string>>(trustedSet)
  const blockedSetRef = useRef<Set<string>>(blockedSet)
  const pushToastRef = useRef(pushToast)

  const workerRef = useRef<Worker | null>(null)
  const pendingReqRef = useRef<Map<string, PendingWorkerRequest>>(new Map())
  const inflightScreenRef = useRef<Map<string, Promise<ContentFilterVerdict>>>(new Map())
  const inflightPreloadRef = useRef<Promise<boolean> | null>(null)
  const skipNextAutoLoadRef = useRef<boolean>(false)
  const reqSeqRef = useRef<number>(0)

  const safeObjectUrlsRef = useRef<Map<string, string>>(new Map())
  const revealedFlaggedUrlsRef = useRef<Map<string, string>>(new Map())
  const flaggedBlobsRef = useRef<Map<string, Blob>>(new Map())
  const keysBySenderRef = useRef<Map<string, Set<string>>>(new Map())

  useLayoutEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useLayoutEffect(() => {
    verdictsRef.current = verdicts
  }, [verdicts])

  useLayoutEffect(() => {
    modelStatusRef.current = modelStatus
  }, [modelStatus])

  useLayoutEffect(() => {
    ownPubkeysRef.current = ownPubkeys
  }, [ownPubkeys])

  useLayoutEffect(() => {
    trustedSetRef.current = trustedSet
  }, [trustedSet])

  useLayoutEffect(() => {
    blockedSetRef.current = blockedSet
  }, [blockedSet])

  useLayoutEffect(() => {
    pushToastRef.current = pushToast
  }, [pushToast])

  const revokeAllObjectUrls = useCallback(() => {
    for (const url of safeObjectUrlsRef.current.values()) {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // Ignore revoke failure
      }
    }
    safeObjectUrlsRef.current.clear()

    for (const url of revealedFlaggedUrlsRef.current.values()) {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // Ignore revoke failure
      }
    }
    revealedFlaggedUrlsRef.current.clear()
    flaggedBlobsRef.current.clear()
    keysBySenderRef.current.clear()
    setSafeUrlVersion((v) => v + 1)
  }, [])

  const trackSenderKey = useCallback((senderPubkey: string, cacheKey: string) => {
    const pk = senderPubkey.toLowerCase()
    let set = keysBySenderRef.current.get(pk)
    if (!set) {
      set = new Set()
      keysBySenderRef.current.set(pk, set)
    }
    set.add(cacheKey)
  }, [])

  const storeSafeObjectUrl = useCallback(
    (cacheKey: string, blob: Blob, senderPubkey?: string): string => {
      const existing = safeObjectUrlsRef.current.get(cacheKey)
      if (existing) return existing
      const url = URL.createObjectURL(blob)
      safeObjectUrlsRef.current.set(cacheKey, url)
      if (senderPubkey) trackSenderKey(senderPubkey, cacheKey)
      setSafeUrlVersion((v) => v + 1)
      return url
    },
    [trackSenderKey]
  )

  const storeFlaggedBlobForReveal = useCallback(
    (cacheKey: string, blob: Blob, senderPubkey?: string) => {
      flaggedBlobsRef.current.set(cacheKey, blob)
      if (senderPubkey) trackSenderKey(senderPubkey, cacheKey)
      while (flaggedBlobsRef.current.size > MAX_FLAGGED_REVEAL_BLOBS) {
        const oldest = flaggedBlobsRef.current.keys().next().value
        if (!oldest) break
        flaggedBlobsRef.current.delete(oldest)
      }
    },
    [trackSenderKey]
  )

  const upsertVerdict = useCallback(
    (cacheKey: string, verdict: ContentFilterVerdict, persist = true) => {
      setVerdicts((prev) => {
        const next: Record<string, ContentFilterVerdict> = { ...prev, [cacheKey]: verdict }
        const keys = Object.keys(next)
        if (keys.length > MAX_IN_MEMORY_VERDICTS) {
          keys.sort((a, b) => (next[a]?.checkedAt ?? 0) - (next[b]?.checkedAt ?? 0))
          for (let i = 0; i < keys.length - MAX_IN_MEMORY_VERDICTS; i++) {
            delete next[keys[i]]
          }
        }
        verdictsRef.current = next
        if (persist && (verdict.status === 'safe' || verdict.status === 'flagged')) {
          saveFilterVerdicts(rulesFingerprintRef.current, next)
        }
        return next
      })
    },
    []
  )

  const getWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current

    const worker = new Worker(
      new URL('../lib/contentFilter.worker.ts', import.meta.url),
      { type: 'module' }
    )

    worker.onmessage = (event: MessageEvent<ContentFilterWorkerOutMessage>) => {
      const msg = event.data
      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'status') {
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
        if (msg.status === 'error') {
          setModelError(msg.error ?? `Failed to load ${CONTENT_FILTER_MODEL_LABEL}.`)
        } else if (msg.status === 'ready' || msg.status === 'idle') {
          setModelError(null)
        }
        return
      }

      if (msg.type === 'result' || msg.type === 'cache-cleared') {
        const pending = pendingReqRef.current.get(msg.requestId)
        if (pending) {
          pendingReqRef.current.delete(msg.requestId)
          pending.resolve(msg)
        }
        return
      }

      if (msg.type === 'error') {
        const pending = pendingReqRef.current.get(msg.requestId)
        if (pending) {
          pendingReqRef.current.delete(msg.requestId)
          pending.reject(new Error(msg.error || 'Image safety filtering error.'))
        }
      }
    }

    worker.onerror = (ev) => {
      const errMsg = ev.message || 'Content filter worker crashed.'
      setModelStatus('error')
      modelStatusRef.current = 'error'
      setModelError(errMsg)
      inflightPreloadRef.current = null
      for (const [id, pending] of Array.from(pendingReqRef.current.entries())) {
        pendingReqRef.current.delete(id)
        pending.reject(new Error(errMsg))
      }
    }

    workerRef.current = worker
    return worker
  }, [])

  const postWorkerRequest = useCallback(
    (
      payload: ContentFilterWorkerInMessage & { requestId: string }
    ): Promise<ContentFilterWorkerOutMessage> => {
      const worker = getWorker()
      return new Promise((resolve, reject) => {
        pendingReqRef.current.set(payload.requestId, { resolve, reject })
        worker.postMessage(payload)
      })
    },
    [getWorker]
  )

  const terminateWorker = useCallback(() => {
    const w = workerRef.current
    workerRef.current = null
    inflightPreloadRef.current = null
    if (w) {
      try {
        w.postMessage({ type: 'dispose' } satisfies ContentFilterWorkerInMessage)
      } catch {
        // Ignore postMessage failure
      }
      w.terminate()
    }
    for (const [id, pending] of Array.from(pendingReqRef.current.entries())) {
      pendingReqRef.current.delete(id)
      pending.reject(new Error('Content filter worker reset.'))
    }
    inflightScreenRef.current.clear()
  }, [])

  // Silently reclaim legacy d1-2B / MobileCLIP / text-filter weights cached by older builds
  useEffect(() => {
    if (typeof caches === 'undefined') return
    let cancelled = false
    void (async () => {
      try {
        const hasCache = await caches.has(CONTENT_FILTER_CACHE_NAME)
        if (!hasCache || cancelled) return
        const cache = await caches.open(CONTENT_FILTER_CACHE_NAME)
        const keys = await cache.keys()
        for (const req of keys) {
          if (cancelled) return
          if (isLegacyCacheUrl(req.url)) {
            await cache.delete(req)
          }
        }
      } catch {
        // Ignore storage errors on restricted mobile browsers
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return () => {
      terminateWorker()
      revokeAllObjectUrls()
    }
  }, [terminateWorker, revokeAllObjectUrls])

  const preloadModel = useCallback(
    async (preloadOpts?: PreloadModelOptions): Promise<boolean> => {
      if (modelStatusRef.current === 'ready') return true
      if (inflightPreloadRef.current) {
        return await inflightPreloadRef.current
      }

      const silent = Boolean(preloadOpts?.silent)
      skipNextAutoLoadRef.current = false
      const requestId = `cf-preload-${++reqSeqRef.current}`

      const task = (async (): Promise<boolean> => {
        try {
          const res = await postWorkerRequest({ type: 'preload', requestId })
          if (res.type === 'result') {
            if (!silent) {
              pushToastRef.current?.(
                'success',
                `${CONTENT_FILTER_MODEL_LABEL} ready`,
                `Running locally via ${res.runtimeDevice === 'webgpu' ? 'WebGPU' : 'WASM'}.`
              )
            }
            return true
          }
          return false
        } catch (err) {
          const message =
            err instanceof Error
              ? err.message
              : `Unable to download ${CONTENT_FILTER_MODEL_LABEL}.`
          if (!silent) {
            pushToastRef.current?.('error', 'Content Filter download failed', message)
          }
          return false
        } finally {
          inflightPreloadRef.current = null
        }
      })()

      inflightPreloadRef.current = task
      return await task
    },
    [postWorkerRequest]
  )

  // Auto-load the 22.6 MB image safety model on app startup (and whenever protection becomes active while idle)
  useEffect(() => {
    if (!shouldAutoPreloadModel(settings)) return
    if (skipNextAutoLoadRef.current) return
    if (modelStatusRef.current !== 'idle') return
    void preloadModel({ silent: true })
  }, [
    settings,
    preloadModel,
  ])

  const updateSettings = useCallback(
    (patch: Partial<ContentFilterSettings>) => {
      setSettings((prev) => {
        const next: ContentFilterSettings = {
          ...prev,
          ...patch,
        }
        settingsRef.current = next
        saveContentFilterSettings(next)

        if (!shouldAutoPreloadModel(prev) && shouldAutoPreloadModel(next)) {
          skipNextAutoLoadRef.current = false
        }

        const nextFp = computeRulesFingerprint(next)
        if (nextFp !== rulesFingerprintRef.current) {
          rulesFingerprintRef.current = nextFp
          clearFilterVerdictsStorage()
          verdictsRef.current = {}
          setVerdicts({})
          inflightScreenRef.current.clear()
          revokeAllObjectUrls()
        }
        return next
      })
    },
    [revokeAllObjectUrls]
  )

  const shouldScreenMedia = useCallback((senderPubkey: string, isSelf: boolean): boolean => {
    const cfg = settingsRef.current
    if (!hasAnyActiveRule(cfg) || cfg.mediaScope === 'off') return false
    const pk = senderPubkey.toLowerCase()
    if (isSelf || ownPubkeysRef.current.has(pk) || blockedSetRef.current.has(pk)) return false
    if (cfg.mediaScope === 'all') return true
    return !trustedSetRef.current.has(pk)
  }, [])

  const shouldAllowScreenedCallVideo = useCallback(
    (senderPubkey: string, isSelf: boolean): boolean => {
      const cfg = settingsRef.current
      if (!hasAnyActiveRule(cfg)) return false
      if (cfg.callVideoMode !== 'screen-untrusted' && cfg.callVideoMode !== 'screen-all') {
        return false
      }
      const pk = senderPubkey.toLowerCase()
      if (isSelf || ownPubkeysRef.current.has(pk) || blockedSetRef.current.has(pk)) return false
      return !trustedSetRef.current.has(pk)
    },
    []
  )

  const shouldScreenCallVideo = useCallback((senderPubkey: string, isSelf: boolean): boolean => {
    const cfg = settingsRef.current
    if (!hasAnyActiveRule(cfg) || cfg.callVideoMode === 'trusted-only') return false
    const pk = senderPubkey.toLowerCase()
    if (isSelf || ownPubkeysRef.current.has(pk) || blockedSetRef.current.has(pk)) return false
    if (cfg.callVideoMode === 'screen-all') return true
    return !trustedSetRef.current.has(pk)
  }, [])

  const clearVerdictCache = useCallback(() => {
    clearFilterVerdictsStorage()
    verdictsRef.current = {}
    setVerdicts({})
    inflightScreenRef.current.clear()
    revokeAllObjectUrls()
  }, [revokeAllObjectUrls])

  const clearModelCache = useCallback(async (): Promise<void> => {
    skipNextAutoLoadRef.current = true
    inflightPreloadRef.current = null
    clearVerdictCache()
    if (workerRef.current) {
      const requestId = `cf-clear-${++reqSeqRef.current}`
      try {
        await postWorkerRequest({ type: 'clear-cache', requestId })
      } catch {
        terminateWorker()
      }
    } else {
      try {
        if (typeof caches !== 'undefined') {
          await caches.delete(CONTENT_FILTER_CACHE_NAME)
        }
      } catch {
        // Ignore cache delete failure
      }
    }
    setModelStatus('idle')
    modelStatusRef.current = 'idle'
    setDownloadProgress(0)
    setDownloadFile(null)
    setRuntimeDevice(null)
    setModelError(null)
    pushToastRef.current?.(
      'info',
      'Content Filter cache cleared',
      'Cached safety filter model and screening verdicts removed.'
    )
  }, [clearVerdictCache, postWorkerRequest, terminateWorker])

  const getRulesPayload = useCallback((): ContentFilterRulesPayload => {
    const cfg = settingsRef.current
    return {
      filterNsfw: cfg.filterNsfw,
      filterIllegal: cfg.filterIllegal,
    }
  }, [])

  const screenImageBlob = useCallback(
    async (
      cacheKey: string,
      blob: Blob,
      options?: ScreenContentOptions
    ): Promise<ContentFilterVerdict> => {
      const skipCache = Boolean(options?.skipCache)
      if (!skipCache) {
        const cached = verdictsRef.current[cacheKey]
        if (cached && (cached.status === 'safe' || cached.status === 'flagged')) {
          return cached
        }
        const inflight = inflightScreenRef.current.get(cacheKey)
        if (inflight) return await inflight
      }

      const rules = getRulesPayload()
      const fpAtStart = rulesFingerprintRef.current
      if (!hasAnyActiveRule(settingsRef.current)) {
        const safeVerdict: ContentFilterVerdict = {
          status: 'safe',
          safe: true,
          flagged: false,
          categories: [],
          checkedAt: Date.now(),
        }
        if (!skipCache) upsertVerdict(cacheKey, safeVerdict, false)
        return safeVerdict
      }

      const pendingVerdict: ContentFilterVerdict = {
        status: modelStatusRef.current === 'ready' ? 'scanning' : 'downloading',
        safe: false,
        flagged: false,
        categories: [],
        checkedAt: Date.now(),
      }
      upsertVerdict(cacheKey, pendingVerdict, false)

      const task = (async (): Promise<ContentFilterVerdict> => {
        try {
          const requestId = `cf-img-${++reqSeqRef.current}`
          const res = await postWorkerRequest({
            type: 'screen',
            requestId,
            blob,
            rules,
          })
          if (res.type !== 'result') {
            throw new Error('Unexpected response from content filter worker.')
          }
          const finalVerdict: ContentFilterVerdict = {
            status: res.flagged ? 'flagged' : 'safe',
            safe: res.safe && !res.flagged,
            flagged: res.flagged,
            categories: res.categories,
            reason: res.reason,
            scores: res.scores,
            checkedAt: Date.now(),
          }
          if (rulesFingerprintRef.current === fpAtStart) {
            upsertVerdict(cacheKey, finalVerdict, !skipCache)
          }
          return finalVerdict
        } catch (err) {
          const errorVerdict: ContentFilterVerdict = {
            status: 'error',
            safe: false,
            flagged: false,
            categories: [],
            error: err instanceof Error ? err.message : 'Image screening failed.',
            checkedAt: Date.now(),
          }
          if (rulesFingerprintRef.current === fpAtStart) {
            upsertVerdict(cacheKey, errorVerdict, false)
          }
          return errorVerdict
        } finally {
          if (!skipCache) {
            inflightScreenRef.current.delete(cacheKey)
          }
        }
      })()

      if (!skipCache) {
        inflightScreenRef.current.set(cacheKey, task)
      }
      return await task
    },
    [getRulesPayload, postWorkerRequest, upsertVerdict]
  )

  const screenImageAttachment = useCallback(
    async (
      cacheKey: string,
      image: ImageAttachment,
      senderPubkey: string,
      options?: ScreenImageAttachmentOptions
    ): Promise<ContentFilterVerdict> => {
      const pk = senderPubkey.toLowerCase()
      if (blockedSetRef.current.has(pk)) {
        return {
          status: 'flagged',
          safe: false,
          flagged: true,
          categories: [],
          reason: 'Sender is muted / blocked',
          checkedAt: Date.now(),
        }
      }

      const isSelf = ownPubkeysRef.current.has(pk)
      const isTrusted = isSelf || trustedSetRef.current.has(pk)
      const allowedByFilter = shouldScreenMedia(pk, isSelf)
      if (!isTrusted && !allowedByFilter) {
        return {
          status: 'error',
          safe: false,
          flagged: false,
          categories: [],
          error: 'Untrusted media screening is disabled in Content Filter settings.',
          checkedAt: Date.now(),
        }
      }

      // Return immediately if already screened & safe with live blob URL
      const existing = verdictsRef.current[cacheKey]
      if (existing?.status === 'safe' && safeObjectUrlsRef.current.has(cacheKey)) {
        return existing
      }
      if (existing?.status === 'flagged') {
        return existing
      }

      const inflight = inflightScreenRef.current.get(cacheKey)
      if (inflight) return await inflight

      const fpAtStart = rulesFingerprintRef.current
      const rules = getRulesPayload()

      // Mark scanning/downloading immediately so UI shows progress before any network fetch settles
      if (!existing || existing.status !== 'safe') {
        upsertVerdict(
          cacheKey,
          {
            status: modelStatusRef.current === 'ready' ? 'scanning' : 'downloading',
            safe: false,
            flagged: false,
            categories: [],
            checkedAt: Date.now(),
          },
          false
        )
      }

      const task = (async (): Promise<ContentFilterVerdict> => {
        try {
          // 1. Fetch & SHA-256 verify raw bytes in memory ONLY (never mounted into DOM <img>)
          let blob = await downloadAndVerifyMediaBlob(image, () => {
            if (blockedSetRef.current.has(pk)) {
              throw new Error('Sender is muted / blocked.')
            }
            const stillTrusted =
              ownPubkeysRef.current.has(pk) || trustedSetRef.current.has(pk)
            if (!stillTrusted && !shouldScreenMedia(pk, ownPubkeysRef.current.has(pk))) {
              throw new Error('Untrusted media screening is disabled.')
            }
          })

          // Optional explicit hex key decryption if not already decrypted via image.encryption
          if (!image.encryption && options?.decryptKeyHex && options?.ivHex) {
            blob = await decryptBlobWithHexKey(
              blob,
              options.decryptKeyHex,
              options.ivHex,
              image.mime
            )
          }

          if (blockedSetRef.current.has(pk)) {
            throw new Error('Sender was muted while screening.')
          }

          // 2. If a valid persisted 'safe' verdict existed across reload, reveal cleanly without re-running model
          if (existing?.status === 'safe' && rulesFingerprintRef.current === fpAtStart) {
            storeSafeObjectUrl(cacheKey, blob, pk)
            return existing
          }

          // 3. Run on-device safety screening in Web Worker BEFORE any objectUrl is created!
          const requestId = `cf-att-${++reqSeqRef.current}`
          const res = await postWorkerRequest({
            type: 'screen',
            requestId,
            blob,
            rules,
          })
          if (res.type !== 'result') {
            throw new Error('Unexpected response from content filter worker.')
          }

          const finalVerdict: ContentFilterVerdict = {
            status: res.flagged ? 'flagged' : 'safe',
            safe: res.safe && !res.flagged,
            flagged: res.flagged,
            categories: res.categories,
            reason: res.reason,
            scores: res.scores,
            checkedAt: Date.now(),
          }

          if (rulesFingerprintRef.current === fpAtStart && !blockedSetRef.current.has(pk)) {
            if (finalVerdict.safe && !finalVerdict.flagged) {
              storeSafeObjectUrl(cacheKey, blob, pk)
            } else if (finalVerdict.flagged && !finalVerdict.categories.includes('illegal')) {
              // Hold raw blob ONLY for non-illegal flags in case user explicitly clicks "Reveal anyway"
              storeFlaggedBlobForReveal(cacheKey, blob, pk)
            }
            upsertVerdict(cacheKey, finalVerdict, true)
          }
          return finalVerdict
        } catch (err) {
          const errorVerdict: ContentFilterVerdict = {
            status: 'error',
            safe: false,
            flagged: false,
            categories: [],
            error: err instanceof Error ? err.message : 'Unable to screen media attachment.',
            checkedAt: Date.now(),
          }
          if (rulesFingerprintRef.current === fpAtStart) {
            upsertVerdict(cacheKey, errorVerdict, false)
          }
          return errorVerdict
        } finally {
          inflightScreenRef.current.delete(cacheKey)
        }
      })()

      inflightScreenRef.current.set(cacheKey, task)
      return await task
    },
    [
      shouldScreenMedia,
      getRulesPayload,
      upsertVerdict,
      storeSafeObjectUrl,
      storeFlaggedBlobForReveal,
      postWorkerRequest,
    ]
  )

  const getVerdict = useCallback((cacheKey: string): ContentFilterVerdict | null => {
    return verdictsRef.current[cacheKey] ?? null
  }, [])

  const getSafeImageObjectUrl = useCallback(
    (cacheKey: string): string | null => {
      void safeUrlVersion
      const verdict = verdictsRef.current[cacheKey]
      if (!verdict || verdict.status !== 'safe' || !verdict.safe || verdict.flagged) {
        return null
      }
      return safeObjectUrlsRef.current.get(cacheKey) ?? null
    },
    [safeUrlVersion]
  )

  const revealFlaggedImage = useCallback((cacheKey: string): string | null => {
    const verdict = verdictsRef.current[cacheKey]
    // Strictly refuse reveal if flagged as 'illegal'
    if (verdict?.categories.includes('illegal')) {
      return null
    }
    const existing = revealedFlaggedUrlsRef.current.get(cacheKey)
    if (existing) return existing
    const blob = flaggedBlobsRef.current.get(cacheKey)
    if (!blob) return null
    const url = URL.createObjectURL(blob)
    revealedFlaggedUrlsRef.current.set(cacheKey, url)
    setSafeUrlVersion((v) => v + 1)
    return url
  }, [])

  const revokeForSender = useCallback((senderPubkey: string) => {
    const pk = senderPubkey.toLowerCase()
    const keys = keysBySenderRef.current.get(pk)
    if (!keys || keys.size === 0) return
    for (const key of keys) {
      const safeUrl = safeObjectUrlsRef.current.get(key)
      if (safeUrl) {
        try {
          URL.revokeObjectURL(safeUrl)
        } catch {
          // Ignore
        }
        safeObjectUrlsRef.current.delete(key)
      }
      const revUrl = revealedFlaggedUrlsRef.current.get(key)
      if (revUrl) {
        try {
          URL.revokeObjectURL(revUrl)
        } catch {
          // Ignore
        }
        revealedFlaggedUrlsRef.current.delete(key)
      }
      flaggedBlobsRef.current.delete(key)
    }
    keysBySenderRef.current.delete(pk)
    setSafeUrlVersion((v) => v + 1)
  }, [])

  const resetAll = useCallback(() => {
    skipNextAutoLoadRef.current = true
    terminateWorker()
    revokeAllObjectUrls()
    clearFilterVerdictsStorage()
    const fresh = { ...DEFAULT_CONTENT_FILTER_SETTINGS }
    settingsRef.current = fresh
    rulesFingerprintRef.current = computeRulesFingerprint(fresh)
    setSettings(fresh)
    verdictsRef.current = {}
    setVerdicts({})
    setModelStatus('idle')
    modelStatusRef.current = 'idle'
    setDownloadProgress(0)
    setDownloadFile(null)
    setRuntimeDevice(null)
    setModelError(null)
  }, [terminateWorker, revokeAllObjectUrls])

  const cachedVerdictCount = useMemo(
    () =>
      Object.values(verdicts).filter((v) => v.status === 'safe' || v.status === 'flagged').length,
    [verdicts]
  )

  return useMemo<ContentFilterEngine>(
    () => ({
      settings,
      updateSettings,
      modelId: CONTENT_FILTER_MODEL_ID,
      modelLabel: CONTENT_FILTER_MODEL_LABEL,
      modelStatus,
      downloadProgress,
      downloadFile,
      runtimeDevice,
      modelError,
      webGpuSupported,
      preloadModel,
      clearModelCache,
      clearVerdictCache,
      cachedVerdictCount,
      shouldScreenMedia,
      shouldAllowScreenedCallVideo,
      shouldScreenCallVideo,
      verdicts,
      getVerdict,
      screenImageAttachment,
      screenImageBlob,
      getSafeImageObjectUrl,
      revealFlaggedImage,
      revokeForSender,
      resetAll,
    }),
    [
      settings,
      updateSettings,
      modelStatus,
      downloadProgress,
      downloadFile,
      runtimeDevice,
      modelError,
      webGpuSupported,
      preloadModel,
      clearModelCache,
      clearVerdictCache,
      cachedVerdictCount,
      shouldScreenMedia,
      shouldAllowScreenedCallVideo,
      shouldScreenCallVideo,
      verdicts,
      getVerdict,
      screenImageAttachment,
      screenImageBlob,
      getSafeImageObjectUrl,
      revealFlaggedImage,
      revokeForSender,
      resetAll,
    ]
  )
}
