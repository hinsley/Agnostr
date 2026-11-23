import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

const MOBILE_MAX_WIDTH = 867
const HORIZONTAL_SLOP_PX = 10
const VERTICAL_LOCK_SLOP_PX = 6
const VERTICAL_RATIO = 0.9
const HORIZONTAL_RATIO = 1.25
const OPEN_PROGRESS_THRESHOLD = 0.3
const CLOSE_PROGRESS_THRESHOLD = 0.72
const FLING_VELOCITY_PX_MS = 0.35
const VELOCITY_STALE_MS = 120

const EXCLUDED_SWIPE_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[role="slider"]',
  '.ag-voice-waveform',
  '.leaflet-container',
  '[data-no-swipe="true"]',
].join(', ')

type DrawerSide = 'left' | 'right'
type GestureLock = 'pending' | 'horizontal' | 'vertical'
type DragMode = 'opening' | 'closing'

interface ActiveDragVisual {
  drawer: DrawerSide
  progress: number
}

interface TouchSession {
  touchId: number
  startX: number
  startY: number
  lastX: number
  startTime: number
  lastTime: number
  lastMoveTime: number
  lock: GestureLock
  activeDrawer: DrawerSide | null
  mode: DragMode | null
  progress: number
  velocity: number
  viewportWidth: number
  drawerWidth: number
}

export interface UseMobileSwipeDrawersOptions {
  leftOpen: boolean
  rightOpen: boolean
  disabled: boolean
  onLeftOpenChange: (open: boolean) => void
  onRightOpenChange: (open: boolean) => void
}

export interface MobileSwipeDrawersState {
  bindRef: RefObject<HTMLDivElement | null>
  leftProgress: number
  rightProgress: number
  isSwipingLeft: boolean
  isSwipingRight: boolean
}

function clamp01(value: number): number {
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function findTouchById(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i += 1) {
    const t = list.item(i)
    if (t && t.identifier === id) return t
  }
  return null
}

function shouldIgnoreSwipeTarget(target: EventTarget | null, container: HTMLElement): boolean {
  let node: Element | null =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null

  while (node) {
    if (node.matches(EXCLUDED_SWIPE_SELECTOR)) {
      return true
    }
    if ((node as HTMLElement).isContentEditable) {
      return true
    }
    if (node !== container && node.scrollWidth > node.clientWidth + 4) {
      const overflowX = window.getComputedStyle(node).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll') {
        return true
      }
    }
    if (node === container) break
    node = node.parentElement
  }

  return false
}

/**
 * Interactive 60fps finger-following mobile swipe engine for Left (ConversationList)
 * and Right (UserListPane) slide-over drawers inside `.ag-shell-body`.
 */
export function useMobileSwipeDrawers(
  options: UseMobileSwipeDrawersOptions
): MobileSwipeDrawersState {
  const bindRef = useRef<HTMLDivElement | null>(null)
  const optionsRef = useRef(options)
  const sessionRef = useRef<TouchSession | null>(null)
  const [drag, setDrag] = useState<ActiveDragVisual | null>(null)

  useEffect(() => {
    optionsRef.current = options
  }, [options])

  // Cancel any in-flight gesture cleanly if swipe becomes disabled (e.g. modal or call opens)
  useEffect(() => {
    if (options.disabled && sessionRef.current) {
      sessionRef.current = null
      setDrag(null)
    }
  }, [options.disabled])

  useEffect(() => {
    const container = bindRef.current
    if (!container) return

    const clearSession = () => {
      const hadHorizontal = sessionRef.current?.lock === 'horizontal'
      sessionRef.current = null
      if (hadHorizontal) {
        setDrag(null)
      }
    }

    const handleTouchStart = (e: TouchEvent) => {
      const opts = optionsRef.current
      if (opts.disabled) return
      if (e.touches.length !== 1) {
        clearSession()
        return
      }

      const vw = window.innerWidth || container.clientWidth || 0
      if (vw <= 0 || vw > MOBILE_MAX_WIDTH) return
      if (shouldIgnoreSwipeTarget(e.target, container)) return

      const touch = e.touches[0]
      const now = performance.now()
      const drawerWidth = Math.max(240, Math.min(vw * 0.86, 320))

      sessionRef.current = {
        touchId: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        startTime: now,
        lastTime: now,
        lastMoveTime: now,
        lock: 'pending',
        activeDrawer: null,
        mode: null,
        progress: 0,
        velocity: 0,
        viewportWidth: vw,
        drawerWidth,
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      const session = sessionRef.current
      if (!session) return

      const opts = optionsRef.current
      if (opts.disabled || e.touches.length > 1) {
        clearSession()
        return
      }

      const touch = findTouchById(e.touches, session.touchId)
      if (!touch) return

      const x = touch.clientX
      const y = touch.clientY
      const dx = x - session.startX
      const dy = y - session.startY
      const absX = Math.abs(dx)
      const absY = Math.abs(dy)

      if (session.lock === 'vertical') return

      if (session.lock === 'pending') {
        if (absY >= VERTICAL_LOCK_SLOP_PX && absY > absX * VERTICAL_RATIO) {
          session.lock = 'vertical'
          return
        }

        if (absX >= HORIZONTAL_SLOP_PX && absX > absY * HORIZONTAL_RATIO) {
          if (!opts.leftOpen && !opts.rightOpen) {
            if (dx > 0 && session.startX <= session.viewportWidth * 0.65) {
              session.activeDrawer = 'left'
              session.mode = 'opening'
            } else if (dx < 0 && session.startX >= session.viewportWidth * 0.35) {
              session.activeDrawer = 'right'
              session.mode = 'opening'
            } else {
              session.lock = 'vertical'
              return
            }
          } else if (opts.leftOpen) {
            if (dx < 0) {
              session.activeDrawer = 'left'
              session.mode = 'closing'
            } else {
              session.lock = 'vertical'
              return
            }
          } else if (opts.rightOpen) {
            if (dx > 0) {
              session.activeDrawer = 'right'
              session.mode = 'closing'
            } else {
              session.lock = 'vertical'
              return
            }
          }

          session.drawerWidth = Math.max(
            240,
            Math.min(session.viewportWidth * 0.86, session.activeDrawer === 'left' ? 336 : 320)
          )
          session.lock = 'horizontal'
          const active = document.activeElement
          if (active instanceof HTMLElement && active !== document.body) {
            active.blur()
          }
        } else {
          return
        }
      }

      if (session.lock !== 'horizontal' || !session.activeDrawer || !session.mode) return

      if (e.cancelable) {
        e.preventDefault()
      }

      const progress =
        session.activeDrawer === 'left'
          ? session.mode === 'opening'
            ? clamp01(dx / session.drawerWidth)
            : clamp01(1 + dx / session.drawerWidth)
          : session.mode === 'opening'
            ? clamp01(-dx / session.drawerWidth)
            : clamp01(1 - dx / session.drawerWidth)

      const now = performance.now()
      const dt = now - session.lastTime
      const stepDx = x - session.lastX
      const signedStep = session.activeDrawer === 'left' ? stepDx : -stepDx
      if (dt > 0) {
        const instantVel = signedStep / dt
        session.velocity =
          session.lastTime === session.startTime
            ? instantVel
            : session.velocity * 0.35 + instantVel * 0.65
        session.lastMoveTime = now
      }
      session.lastX = x
      session.lastTime = now
      session.progress = progress

      setDrag({ drawer: session.activeDrawer, progress })
    }

    const handleTouchEnd = (e: TouchEvent) => {
      const session = sessionRef.current
      if (!session) return

      const ended =
        findTouchById(e.changedTouches, session.touchId) !== null || e.touches.length === 0
      if (!ended) return

      const opts = optionsRef.current
      if (session.lock === 'horizontal' && session.activeDrawer && session.mode && !opts.disabled) {
        const now = performance.now()
        const effectiveVelocity =
          now - session.lastMoveTime > VELOCITY_STALE_MS ? 0 : session.velocity

        if (session.mode === 'opening') {
          const shouldOpen =
            session.progress >= OPEN_PROGRESS_THRESHOLD ||
            effectiveVelocity >= FLING_VELOCITY_PX_MS
          if (shouldOpen) {
            if (session.activeDrawer === 'left') opts.onLeftOpenChange(true)
            else opts.onRightOpenChange(true)
          }
        } else {
          const shouldClose =
            session.progress <= CLOSE_PROGRESS_THRESHOLD ||
            effectiveVelocity <= -FLING_VELOCITY_PX_MS
          if (shouldClose) {
            if (session.activeDrawer === 'left') opts.onLeftOpenChange(false)
            else opts.onRightOpenChange(false)
          }
        }
      }

      sessionRef.current = null
      setDrag(null)
    }

    const handleTouchCancel = () => {
      clearSession()
    }

    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: false })
    container.addEventListener('touchend', handleTouchEnd, { passive: true })
    container.addEventListener('touchcancel', handleTouchCancel, { passive: true })

    return () => {
      container.removeEventListener('touchstart', handleTouchStart)
      container.removeEventListener('touchmove', handleTouchMove)
      container.removeEventListener('touchend', handleTouchEnd)
      container.removeEventListener('touchcancel', handleTouchCancel)
    }
  }, [])

  const isSwipingLeft = !options.disabled && drag?.drawer === 'left'
  const isSwipingRight = !options.disabled && drag?.drawer === 'right'
  const leftProgress = isSwipingLeft ? drag.progress : options.leftOpen ? 1 : 0
  const rightProgress = isSwipingRight ? drag.progress : options.rightOpen ? 1 : 0

  return {
    bindRef,
    leftProgress,
    rightProgress,
    isSwipingLeft,
    isSwipingRight,
  }
}

export default useMobileSwipeDrawers
