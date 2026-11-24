import { useEffect } from 'react'

const MOBILE_MAX_WIDTH = 867
const KEYBOARD_THRESHOLD_PX = 100
const KEYBOARD_LARGE_DROP_PX = 160

function getOrientation(layoutW: number, layoutH: number): 'portrait' | 'landscape' {
  const screenType = window.screen?.orientation?.type
  if (screenType) {
    return screenType.startsWith('landscape') ? 'landscape' : 'portrait'
  }
  const legacyOrientation = (window as unknown as { orientation?: number }).orientation
  if (typeof legacyOrientation === 'number') {
    return Math.abs(legacyOrientation) === 90 ? 'landscape' : 'portrait'
  }
  return layoutW > layoutH ? 'landscape' : 'portrait'
}

function isStandalonePwaMode(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)').matches ||
      (window.navigator as { standalone?: boolean }).standalone === true
  )
}

function isTextInputFocused(): boolean {
  if (typeof document === 'undefined') return false
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
    return [
      'text',
      'search',
      'url',
      'tel',
      'email',
      'password',
      'number',
    ].includes(type)
  }
  return Boolean(el.isContentEditable)
}

/**
 * Synchronizes CSS visual-viewport dimensions (`--ag-vvh`, `--ag-vvt`,
 * `--ag-mobile-tabbar-h`) and `html[data-keyboard-open]` across iOS Safari,
 * iOS standalone PWAs, Android Chrome (`interactive-widget=resizes-content`),
 * and desktop viewports, while preventing iOS document-scroll drift that can
 * leave headers or the bottom navbar stuck off-screen.
 */
export function useMobileViewport(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    const root = document.documentElement
    const baselineByOrientation = { portrait: 0, landscape: 0 }
    let lastLayoutW = 0
    let rafId: number | null = null
    let scrollGuardRafId: number | null = null
    const pendingTimers = new Set<number>()

    const scheduleTimer = (fn: () => void, delayMs: number) => {
      const id = window.setTimeout(() => {
        pendingTimers.delete(id)
        fn()
      }, delayMs)
      pendingTimers.add(id)
    }

    const resetStuckWindowScroll = () => {
      const layoutW = window.innerWidth || root.clientWidth || 0
      if (layoutW > MOBILE_MAX_WIDTH) return
      const drifted =
        window.scrollY !== 0 ||
        window.scrollX !== 0 ||
        root.scrollTop !== 0 ||
        document.body.scrollTop !== 0
      if (!drifted) return

      if (scrollGuardRafId !== null) {
        window.cancelAnimationFrame(scrollGuardRafId)
      }
      scrollGuardRafId = window.requestAnimationFrame(() => {
        scrollGuardRafId = null
        try {
          window.scrollTo(0, 0)
        } catch {
          // Ignore scroll errors in restricted contexts
        }
        if (root.scrollTop !== 0) root.scrollTop = 0
        if (document.body.scrollTop !== 0) document.body.scrollTop = 0
      })
    }

    const sync = () => {
      const vv = window.visualViewport
      const layoutW = window.innerWidth || root.clientWidth || 0
      const layoutH = window.innerHeight || root.clientHeight || 0
      const rootClientH = root.clientHeight || 0
      const vvHeight = vv ? Math.round(vv.height) : layoutH
      const vvOffsetTop = vv ? Math.max(0, Math.round(vv.offsetTop)) : 0
      const standalone = isStandalonePwaMode()

      const orientation = getOrientation(layoutW, layoutH)
      const focusedInput = isTextInputFocused()

      // If viewport width changed substantially (e.g. foldable/split-screen/resize),
      // reset stale height baselines so keyboard state cannot get stuck.
      if (lastLayoutW > 0 && Math.abs(layoutW - lastLayoutW) > 60) {
        baselineByOrientation.portrait = 0
        baselineByOrientation.landscape = 0
      }
      lastLayoutW = layoutW

      // Track full-height baseline per orientation when no keyboard is open,
      // and always grow baseline if the viewport expands (e.g. URL bar hides).
      const candidateMax = Math.max(layoutH, vvHeight, rootClientH)
      if (!focusedInput && vv && Math.abs(layoutH - vvHeight) <= 40) {
        baselineByOrientation[orientation] = Math.max(
          baselineByOrientation[orientation],
          candidateMax
        )
      } else if (candidateMax > baselineByOrientation[orientation]) {
        baselineByOrientation[orientation] = candidateMax
      } else if (baselineByOrientation[orientation] === 0) {
        baselineByOrientation[orientation] = candidateMax
      }

      const isMobile =
        layoutW <= MOBILE_MAX_WIDTH ||
        Boolean(window.matchMedia?.('(pointer: coarse)').matches)
      const baseline = Math.max(layoutH, rootClientH, baselineByOrientation[orientation])
      const heightDrop = baseline - vvHeight
      const visualDrop = layoutH - vvHeight
      const keyboardOpen =
        isMobile &&
        (visualDrop > KEYBOARD_THRESHOLD_PX ||
          heightDrop > KEYBOARD_LARGE_DROP_PX ||
          (focusedInput && heightDrop > KEYBOARD_THRESHOLD_PX))

      // When keyboard is closed, span the full physical viewport (avoiding iOS standalone
      // visualViewport truncation that can leave a bottom dead strip on installed PWAs).
      // When keyboard is open, lock tightly to exact visualViewport height & top offset.
      const resolvedVvh = keyboardOpen
        ? Math.max(120, vvHeight)
        : Math.max(120, vvHeight, layoutH, rootClientH)
      const resolvedVvt = keyboardOpen ? vvOffsetTop : 0

      root.style.setProperty('--ag-vvh', `${resolvedVvh}px`)
      root.style.setProperty('--ag-vvt', `${resolvedVvt}px`)
      root.style.setProperty('--ag-mobile-tabbar-h', keyboardOpen ? '0px' : '56px')
      root.dataset.keyboardOpen = keyboardOpen ? 'true' : 'false'
      root.dataset.standalone = standalone ? 'true' : 'false'

      resetStuckWindowScroll()
    }

    const scheduleSync = () => {
      if (rafId !== null) return
      rafId = window.requestAnimationFrame(() => {
        rafId = null
        sync()
      })
    }

    const handleOrientationChange = () => {
      // Clear stale baseline for the incoming orientation and re-measure cleanly
      baselineByOrientation.portrait = 0
      baselineByOrientation.landscape = 0
      scheduleSync()
      scheduleTimer(sync, 120)
      scheduleTimer(sync, 320)
    }

    const handleFocusIn = () => {
      scheduleSync()
      scheduleTimer(sync, 60)
      scheduleTimer(sync, 220)
    }

    const handleFocusOut = () => {
      scheduleSync()
      scheduleTimer(sync, 60)
      scheduleTimer(sync, 220)
      scheduleTimer(sync, 420)
    }

    const handleWindowScroll = () => {
      resetStuckWindowScroll()
      scheduleSync()
    }

    // Immediate initial measurement
    sync()

    const vv = window.visualViewport
    const screenOrientation = window.screen?.orientation
    vv?.addEventListener('resize', scheduleSync)
    vv?.addEventListener('scroll', scheduleSync)
    window.addEventListener('resize', scheduleSync)
    window.addEventListener('orientationchange', handleOrientationChange)
    screenOrientation?.addEventListener?.('change', handleOrientationChange)
    window.addEventListener('scroll', handleWindowScroll, { passive: true })
    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)

    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      if (scrollGuardRafId !== null) window.cancelAnimationFrame(scrollGuardRafId)
      for (const id of pendingTimers) window.clearTimeout(id)
      pendingTimers.clear()
      vv?.removeEventListener('resize', scheduleSync)
      vv?.removeEventListener('scroll', scheduleSync)
      window.removeEventListener('resize', scheduleSync)
      window.removeEventListener('orientationchange', handleOrientationChange)
      screenOrientation?.removeEventListener?.('change', handleOrientationChange)
      window.removeEventListener('scroll', handleWindowScroll)
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
    }
  }, [])
}

export default useMobileViewport
