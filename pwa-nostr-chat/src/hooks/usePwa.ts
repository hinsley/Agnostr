import { useCallback, useEffect, useState } from 'react'

export type InstallPromptOutcome = 'accepted' | 'dismissed' | 'unavailable'

export interface PwaState {
  canPromptInstall: boolean
  isInstalled: boolean
  isIosSafari: boolean
  swReady: boolean
  offlineReady: boolean
  updateAvailable: boolean
  checkingUpdate: boolean
  isOffline: boolean
  promptInstall: () => Promise<InstallPromptOutcome>
  applyUpdate: () => Promise<void>
  checkForUpdates: () => Promise<boolean>
  dismissUpdate: () => void
}

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[]
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
  prompt(): Promise<void>
}

interface NavigatorPwaExtensions extends Navigator {
  standalone?: boolean
}

const VISIBILITY_CHECK_THROTTLE_MS = 5 * 60 * 1000
const PERIODIC_UPDATE_INTERVAL_MS = 30 * 60 * 1000

interface PwaStoreSnapshot {
  canPromptInstall: boolean
  isInstalled: boolean
  swReady: boolean
  offlineReady: boolean
  updateAvailable: boolean
}

let deferredPrompt: BeforeInstallPromptEvent | null = null
let swRegistration: ServiceWorkerRegistration | null = null
let swInitialized = false
let reloadOnActivation = false
let controllerReplaced = false
let lastAutoCheckAt = 0

const storeListeners = new Set<() => void>()

function detectInstalled(): boolean {
  if (typeof window === 'undefined') return false
  const nav = navigator as NavigatorPwaExtensions
  if (nav.standalone === true) return true
  try {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: window-controls-overlay)').matches
    )
  } catch {
    return false
  }
}

function detectIosSafariBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const isIosDevice =
    /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1)
  if (!isIosDevice) return false
  const isWebKit = /WebKit/i.test(ua)
  const isNonSafariIos = /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(ua)
  return isWebKit && !isNonSafariIos
}

let storeState: PwaStoreSnapshot = {
  canPromptInstall: false,
  isInstalled: detectInstalled(),
  swReady: typeof navigator !== 'undefined' && 'serviceWorker' in navigator && Boolean(navigator.serviceWorker.controller),
  offlineReady:
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator && Boolean(navigator.serviceWorker.controller),
  updateAvailable: false,
}

function emitStoreChange(): void {
  storeListeners.forEach((listener) => listener())
}

function patchStore(partial: Partial<PwaStoreSnapshot>): void {
  let changed = false
  const next = { ...storeState }
  for (const key of Object.keys(partial) as (keyof PwaStoreSnapshot)[]) {
    const value = partial[key]
    if (value !== undefined && next[key] !== value) {
      next[key] = value
      changed = true
    }
  }
  if (changed) {
    storeState = next
    emitStoreChange()
  }
}

// Capture beforeinstallprompt & appinstalled as early as possible (even before React mounts)
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event: Event) => {
    event.preventDefault()
    deferredPrompt = event as BeforeInstallPromptEvent
    patchStore({ canPromptInstall: true })
  })

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    patchStore({ canPromptInstall: false, isInstalled: true })
  })
}

async function resolveRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (swRegistration) return swRegistration
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  try {
    const existing = await navigator.serviceWorker.getRegistration()
    if (existing) {
      swRegistration = existing
      return existing
    }
  } catch {
    // Ignore restricted contexts
  }
  return null
}

async function runSwUpdateCheck(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.onLine) return false
  const reg = await resolveRegistration()
  if (!reg) return false

  lastAutoCheckAt = Date.now()
  try {
    await reg.update()
  } catch {
    return storeState.updateAvailable
  }

  if (reg.waiting || controllerReplaced) {
    patchStore({ updateAvailable: true })
    return true
  }

  const installing = reg.installing
  if (!installing) {
    return storeState.updateAvailable
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (found: boolean) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      installing.removeEventListener('statechange', onStateChange)
      resolve(found)
    }
    const onStateChange = () => {
      if (installing.state === 'installed') {
        if (navigator.serviceWorker.controller || reg.waiting) {
          patchStore({ updateAvailable: true })
          finish(true)
        } else {
          patchStore({ offlineReady: true, swReady: true })
          finish(false)
        }
      } else if (installing.state === 'redundant' || installing.state === 'activated') {
        finish(storeState.updateAvailable)
      }
    }
    const timer = window.setTimeout(() => {
      finish(Boolean(reg.waiting) || storeState.updateAvailable)
    }, 6000)
    installing.addEventListener('statechange', onStateChange)
  })
}

function ensureSwRegistered(): void {
  if (swInitialized || typeof window === 'undefined') return
  swInitialized = true

  if (!('serviceWorker' in navigator)) return

  // First-install claim makes this page available offline. Only a tab that
  // explicitly accepted an update should reload; other tabs keep their drafts.
  if (!import.meta.env.PROD) return
  const workers = navigator.serviceWorker
  let controller = workers.controller
  workers.addEventListener('controllerchange', () => {
    const previous = controller
    controller = workers.controller
    if (!controller || controller === previous) return
    if (reloadOnActivation) {
      reloadOnActivation = false
      window.location.reload()
      return
    }
    if (previous) controllerReplaced = true
    patchStore({ offlineReady: true, swReady: true, updateAvailable: controllerReplaced })
  })

  void workers.register(`${import.meta.env.BASE_URL}sw.js`).then((registration) => {
    swRegistration = registration
    const watchInstall = () => {
      const worker = registration.installing
      if (!worker) return
      const onState = () => {
        if (worker.state === 'installed' && registration.active) {
          patchStore({ updateAvailable: true })
        }
        if (worker.state === 'activated' || worker.state === 'redundant') {
          worker.removeEventListener('statechange', onState)
        }
      }
      worker.addEventListener('statechange', onState)
      onState()
    }
    registration.addEventListener('updatefound', watchInstall)
    watchInstall()
    patchStore({
      swReady: true,
      offlineReady: storeState.offlineReady || Boolean(registration.active),
      updateAvailable: controllerReplaced || Boolean(registration.waiting),
    })
  }).catch((error) => {
    console.warn('[Agnostr PWA] Service worker registration failed:', error)
  })
}

export async function getPwaSwRegistration(): Promise<ServiceWorkerRegistration | null> {
  const existing = await resolveRegistration()
  if (existing) return existing
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  try {
    const ready = await Promise.race<ServiceWorkerRegistration | null>([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 3000)),
    ])
    if (ready) {
      swRegistration = ready
      return ready
    }
  } catch {
    // Ignore restricted contexts
  }
  return null
}

export function isPwaStandaloneMode(): boolean {
  return detectInstalled()
}

export function isIosSafariNonStandalone(): boolean {
  return detectIosSafariBrowser() && !detectInstalled()
}

export function usePwa(badgeCount?: number): PwaState {
  const [snapshot, setSnapshot] = useState<PwaStoreSnapshot>(() => storeState)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [isOffline, setIsOffline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? !navigator.onLine : false
  )

  useEffect(() => {
    ensureSwRegistered()

    const handleStoreUpdate = () => {
      setSnapshot(storeState)
    }
    storeListeners.add(handleStoreUpdate)
    handleStoreUpdate()

    // Display-mode standalone / window-controls-overlay listener
    const standaloneMq = window.matchMedia?.('(display-mode: standalone)')
    const wcoMq = window.matchMedia?.('(display-mode: window-controls-overlay)')
    const handleDisplayModeChange = () => {
      patchStore({ isInstalled: detectInstalled() })
    }
    standaloneMq?.addEventListener?.('change', handleDisplayModeChange)
    wcoMq?.addEventListener?.('change', handleDisplayModeChange)

    // Network status listeners
    const handleOnline = () => setIsOffline(false)
    const handleOffline = () => setIsOffline(true)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    // Auto-check SW updates on visibility change (throttled to max once per 5 min)
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      if (!navigator.onLine) return
      if (Date.now() - lastAutoCheckAt < VISIBILITY_CHECK_THROTTLE_MS) return
      void runSwUpdateCheck()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    // Periodic 30-min SW update check so installed PWAs stay fresh
    const periodicTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        void runSwUpdateCheck()
      }
    }, PERIODIC_UPDATE_INTERVAL_MS)

    return () => {
      storeListeners.delete(handleStoreUpdate)
      standaloneMq?.removeEventListener?.('change', handleDisplayModeChange)
      wcoMq?.removeEventListener?.('change', handleDisplayModeChange)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.clearInterval(periodicTimer)
    }
  }, [])

  // Sync unread count with the App Badging API (when supported)
  useEffect(() => {
    if (typeof navigator === 'undefined') return
    const nav = navigator as NavigatorPwaExtensions
    const normalized = typeof badgeCount === 'number' && Number.isFinite(badgeCount) ? Math.max(0, Math.floor(badgeCount)) : 0
    try {
      if (normalized > 0 && typeof nav.setAppBadge === 'function') {
        void Promise.resolve(nav.setAppBadge(normalized)).catch(() => {
          // Ignore unsupported / permission-denied badge errors
        })
      } else if (typeof nav.clearAppBadge === 'function') {
        void Promise.resolve(nav.clearAppBadge()).catch(() => {
          // Ignore unsupported / permission-denied badge errors
        })
      }
    } catch {
      // Ignore synchronous API errors on unsupported browsers
    }
  }, [badgeCount])

  const promptInstall = useCallback(async (): Promise<InstallPromptOutcome> => {
    const promptEvent = deferredPrompt
    if (!promptEvent) {
      patchStore({ canPromptInstall: false })
      return 'unavailable'
    }
    deferredPrompt = null
    patchStore({ canPromptInstall: false })
    try {
      await promptEvent.prompt()
      const choice = await promptEvent.userChoice
      if (choice.outcome === 'accepted') {
        patchStore({ isInstalled: true })
        return 'accepted'
      }
      return 'dismissed'
    } catch {
      return 'unavailable'
    }
  }, [])

  const applyUpdate = useCallback(async (): Promise<void> => {
    const reg = await resolveRegistration()
    if (reg?.waiting) {
      reloadOnActivation = true
      reg.waiting.postMessage({ type: 'SKIP_WAITING' })
    } else if (controllerReplaced) {
      // Another open tab already activated it. The new shell is ready to use.
      window.location.reload()
    }
  }, [])

  const checkForUpdates = useCallback(async (): Promise<boolean> => {
    setCheckingUpdate(true)
    try {
      return await runSwUpdateCheck()
    } finally {
      setCheckingUpdate(false)
    }
  }, [])

  const dismissUpdate = useCallback(() => {
    patchStore({ updateAvailable: false })
  }, [])

  const isIosSafari = detectIosSafariBrowser() && !snapshot.isInstalled

  return {
    canPromptInstall: snapshot.canPromptInstall,
    isInstalled: snapshot.isInstalled,
    isIosSafari,
    swReady: snapshot.swReady,
    offlineReady: snapshot.offlineReady,
    updateAvailable: snapshot.updateAvailable,
    checkingUpdate,
    isOffline,
    promptInstall,
    applyUpdate,
    checkForUpdates,
    dismissUpdate,
  }
}
