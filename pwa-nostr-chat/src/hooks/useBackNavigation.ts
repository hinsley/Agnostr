import { useCallback, useEffect, useRef } from 'react'

export const AGNOSTR_BACK_EVENT = 'agnostr:back'

const DEFAULT_EXIT_CONFIRM_MS = 2_200

type BackMarker = 'root' | 'guard'

interface BackHandlerEntry {
  id: number
  invoke: () => void
}

let nextBackHandlerId = 1
const lifoBackHandlers: BackHandlerEntry[] = []
let globalBackListenerAttached = false

function dispatchTopBackHandler(event: Event): void {
  if (event.defaultPrevented || lifoBackHandlers.length === 0) return
  const top = lifoBackHandlers[lifoBackHandlers.length - 1]
  if (!top) return
  event.preventDefault()
  top.invoke()
}

function ensureGlobalBackListener(): void {
  if (globalBackListenerAttached || typeof window === 'undefined') return
  window.addEventListener(AGNOSTR_BACK_EVENT, dispatchTopBackHandler)
  globalBackListenerAttached = true
}

function releaseGlobalBackListenerIfIdle(): void {
  if (!globalBackListenerAttached || lifoBackHandlers.length > 0 || typeof window === 'undefined') {
    return
  }
  window.removeEventListener(AGNOSTR_BACK_EVENT, dispatchTopBackHandler)
  globalBackListenerAttached = false
}

function currentUrl(): string {
  return window.location.pathname + window.location.search + window.location.hash
}

function readBackMarker(state: unknown): BackMarker | null {
  if (!state || typeof state !== 'object') return null
  const value = (state as { __agnostrBack?: unknown }).__agnostrBack
  return value === 'root' || value === 'guard' ? value : null
}

function mergeHistoryState(existing: unknown, marker: BackMarker): Record<string, unknown> {
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return { ...(existing as Record<string, unknown>), __agnostrBack: marker }
  }
  return { __agnostrBack: marker }
}

export interface BackNavigationOptions {
  /**
   * Called on back press after dispatching cancelable `agnostr:back` to transient child overlays.
   * Return `true` if the app consumed the back press (e.g. closed a modal, minimized a call,
   * closed a sidebar, or returned from chat -> list); return `false` if already at app root.
   */
  onBack: () => boolean
  /** Called on the 1st root-level back press to show a subtle toast ("Press back again to exit"). */
  onExitHint?: () => void
  /** Window in ms during which a 2nd back press at root exits cleanly (default 2200). */
  exitConfirmMs?: number
  /** Whether interception is enabled (default true). */
  enabled?: boolean
}

export interface BackNavigationControls {
  /** Ensures the `[root, guard]` sentinel entry is armed (e.g. when opening an overlay). */
  rearmGuard: () => void
}

/**
 * Registers a transient child overlay handler for Android/browser back interception.
 * Active handlers run in strict LIFO order (most recently opened overlay wins) and
 * cancel the `agnostr:back` event so parent navigation is not triggered.
 */
export function useBackHandler(active: boolean, handler: () => void): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!active || typeof window === 'undefined') return
    const id = nextBackHandlerId++
    const entry: BackHandlerEntry = {
      id,
      invoke: () => handlerRef.current(),
    }
    lifoBackHandlers.push(entry)
    ensureGlobalBackListener()

    return () => {
      const idx = lifoBackHandlers.findIndex((item) => item.id === id)
      if (idx !== -1) {
        lifoBackHandlers.splice(idx, 1)
      }
      releaseGlobalBackListenerIfIdle()
    }
  }, [active])
}

/**
 * Chrome-Android-compliant History API back-button interceptor maintaining a strict
 * `[root, guard]` stack invariant (max depth 2) without clobbering URL hashes
 * (`#invite=...`, `#notify=...`, or `#geohash`).
 */
export function useBackNavigation(options: BackNavigationOptions): BackNavigationControls {
  const {
    onBack,
    onExitHint,
    exitConfirmMs = DEFAULT_EXIT_CONFIRM_MS,
    enabled = true,
  } = options

  const onBackRef = useRef(onBack)
  onBackRef.current = onBack

  const onExitHintRef = useRef(onExitHint)
  onExitHintRef.current = onExitHint

  const exitConfirmMsRef = useRef(exitConfirmMs)
  exitConfirmMsRef.current = exitConfirmMs

  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const guardArmedRef = useRef(false)
  const exitConfirmActiveRef = useRef(false)
  const exitTimerRef = useRef<number | null>(null)

  const clearExitConfirmTimer = useCallback(() => {
    if (exitTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(exitTimerRef.current)
      exitTimerRef.current = null
    }
    exitConfirmActiveRef.current = false
  }, [])

  const pushGuardEntry = useCallback(() => {
    if (typeof window === 'undefined') return
    try {
      const marker = readBackMarker(window.history.state)
      if (marker === 'guard') {
        guardArmedRef.current = true
        return
      }
      if (marker !== 'root') {
        window.history.replaceState(mergeHistoryState(window.history.state, 'root'), '', currentUrl())
      }
      window.history.pushState(mergeHistoryState(null, 'guard'), '', currentUrl())
      guardArmedRef.current = true
    } catch {
      // Ignore History API restriction in sandboxed frames
    }
  }, [])

  const rearmGuard = useCallback(() => {
    if (!enabledRef.current || typeof window === 'undefined') return
    clearExitConfirmTimer()
    pushGuardEntry()
  }, [clearExitConfirmTimer, pushGuardEntry])

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      clearExitConfirmTimer()
      guardArmedRef.current = false
      return
    }

    // Establish `[root, guard]` sentinel stack on mount without clobbering hash/query
    pushGuardEntry()

    // Chrome User-Activation Compliance: re-arm inside real user gestures if guard is unarmed,
    // or repair in-place via replaceState if external code wiped history.state while armed.
    const handleUserActivation = () => {
      if (!enabledRef.current || exitConfirmActiveRef.current) return
      const marker = readBackMarker(window.history.state)
      if (marker === 'guard') {
        guardArmedRef.current = true
        return
      }
      if (guardArmedRef.current) {
        try {
          window.history.replaceState(mergeHistoryState(window.history.state, 'guard'), '', currentUrl())
        } catch {
          // Ignore
        }
        return
      }
      pushGuardEntry()
    }

    const handlePopState = (event: PopStateEvent) => {
      if (!enabledRef.current) return
      const marker = readBackMarker(event.state)

      // Ignore hash changes or forward navigations that land on the guard state
      if (marker === 'guard') {
        guardArmedRef.current = true
        return
      }

      // Already inside the double-back exit window at root — allow browser/PWA exit
      if (exitConfirmActiveRef.current && !guardArmedRef.current) {
        return
      }

      guardArmedRef.current = false

      // 1. Give topmost transient child overlays (attach menu, camera modal, call transcript) first priority
      const backEvent = new CustomEvent(AGNOSTR_BACK_EVENT, { cancelable: true })
      window.dispatchEvent(backEvent)
      if (backEvent.defaultPrevented) {
        clearExitConfirmTimer()
        pushGuardEntry()
        return
      }

      // 2. Delegate to app-level back priority stack (modals -> call minimize -> drawers -> chat->list)
      let consumed = false
      try {
        consumed = Boolean(onBackRef.current())
      } catch {
        consumed = false
      }

      if (consumed) {
        clearExitConfirmTimer()
        pushGuardEntry()
        return
      }

      // 3. Already at top-level root: enter double-back exit window without re-pushing guard
      clearExitConfirmTimer()
      exitConfirmActiveRef.current = true
      onExitHintRef.current?.()

      const timeoutMs = Math.max(500, exitConfirmMsRef.current)
      exitTimerRef.current = window.setTimeout(() => {
        exitTimerRef.current = null
        exitConfirmActiveRef.current = false
        if (enabledRef.current && readBackMarker(window.history.state) !== 'guard') {
          pushGuardEntry()
        }
      }, timeoutMs)
    }

    window.addEventListener('popstate', handlePopState)
    window.addEventListener('pointerdown', handleUserActivation, { passive: true })
    window.addEventListener('keydown', handleUserActivation, { passive: true })

    return () => {
      window.removeEventListener('popstate', handlePopState)
      window.removeEventListener('pointerdown', handleUserActivation)
      window.removeEventListener('keydown', handleUserActivation)
      clearExitConfirmTimer()
    }
  }, [enabled, clearExitConfirmTimer, pushGuardEntry])

  return { rearmGuard }
}
