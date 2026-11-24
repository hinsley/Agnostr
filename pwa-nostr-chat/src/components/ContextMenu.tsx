import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Clipboard,
  Copy,
  ExternalLink,
  Link2,
  Plus,
  Scissors,
  TextSelect,
} from 'lucide-react'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import '../styles/contextMenu.css'

export interface ContextMenuItem {
  id: string
  label: string
  icon?: React.ReactNode
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  dividerBefore?: boolean
  onSelect: () => void
}

export interface ContextMenuReaction {
  emoji: string
  active?: boolean
  onSelect: () => void
}

export interface ContextMenuSpec {
  header?: string
  reactions?: ContextMenuReaction[]
  onExpandReactions?: (anchorRect: DOMRect) => void
  items: ContextMenuItem[]
}

export interface ContextMenuApi {
  openContextMenu: (e: React.MouseEvent | MouseEvent, spec: ContextMenuSpec) => void
  closeContextMenu: () => void
  isOpen: boolean
}

interface ActiveContextMenuState {
  anchorX: number
  anchorY: number
  spec: ContextMenuSpec
}

const EDITABLE_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'url',
  'email',
  'tel',
  'password',
])

const VIEWPORT_EDGE_PAD = 8
const LONG_PRESS_DURATION_MS = 480
const LONG_PRESS_MOVE_TOLERANCE_PX = 10
const LONG_PRESS_CLICK_SUPPRESS_MS = 700
const LONG_PRESS_NATIVE_CTX_GUARD_MS = 380
const LONG_PRESS_SKIP_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [contenteditable=""], [data-drag-handle="true"], [data-no-long-press="true"], .ag-globe-canvas-wrap'

const ContextMenuContext = createContext<ContextMenuApi | null>(null)

function copyTextSafe(text: string): void {
  if (!text) return
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {
      fallbackCopyText(text)
    })
    return
  }
  fallbackCopyText(text)
}

function fallbackCopyText(text: string): void {
  if (typeof document === 'undefined') return
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  } catch {
    // Ignore restricted clipboard environments
  }
}

function setNativeControlValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  nextValue: string
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) {
    setter.call(el, nextValue)
  } else {
    el.value = nextValue
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function resolveSafeAnchorTarget(
  anchor: HTMLAnchorElement
): { openUrl: string; copyUrl: string; isInternalHash: boolean } | null {
  const rawHref = (anchor.getAttribute('href') || '').trim()
  if (!rawHref) return null
  const lower = rawHref.toLowerCase()

  if (lower.startsWith('#dm=') || lower.startsWith('#invite=')) {
    const fullCopy =
      typeof window !== 'undefined'
        ? `${window.location.origin}${window.location.pathname}${rawHref}`
        : rawHref
    return { openUrl: rawHref, copyUrl: fullCopy, isInternalHash: true }
  }

  if (
    lower.startsWith('https://') ||
    lower.startsWith('http://') ||
    lower.startsWith('mailto:')
  ) {
    return { openUrl: anchor.href, copyUrl: anchor.href, isInternalHash: false }
  }

  return null
}

function findEditableControl(
  target: EventTarget | null
): HTMLInputElement | HTMLTextAreaElement | null {
  if (!(target instanceof Element)) return null
  const match = target.closest('textarea, input')
  if (!match) return null
  if (match instanceof HTMLTextAreaElement) return match
  if (match instanceof HTMLInputElement) {
    const type = (match.getAttribute('type') || 'text').toLowerCase()
    if (EDITABLE_INPUT_TYPES.has(type)) return match
  }
  return null
}

function buildGenericMenuSpec(target: EventTarget | null): ContextMenuSpec | null {
  // 1. Safe <a href> link
  if (target instanceof Element) {
    const anchor = target.closest('a[href]')
    if (anchor instanceof HTMLAnchorElement) {
      const safeLink = resolveSafeAnchorTarget(anchor)
      if (safeLink) {
        return {
          items: [
            {
              id: 'generic-open-link',
              label: 'Open Link',
              icon: <ExternalLink size={14} />,
              onSelect: () => {
                if (safeLink.isInternalHash) {
                  window.location.hash = safeLink.openUrl
                } else {
                  window.open(safeLink.openUrl, '_blank', 'noopener,noreferrer')
                }
              },
            },
            {
              id: 'generic-copy-link',
              label: 'Copy Link Address',
              icon: <Link2 size={14} />,
              onSelect: () => {
                copyTextSafe(safeLink.copyUrl)
              },
            },
          ],
        }
      }
    }
  }

  // 2. Editable <input> or <textarea>
  const inputEl = findEditableControl(target)
  if (inputEl) {
    const start = inputEl.selectionStart ?? 0
    const end = inputEl.selectionEnd ?? 0
    const selStart = Math.min(start, end)
    const selEnd = Math.max(start, end)
    const selectedText = selEnd > selStart ? inputEl.value.slice(selStart, selEnd) : ''
    const isEditable = !inputEl.disabled && !inputEl.readOnly
    const hasValue = inputEl.value.length > 0
    const canReadClipboard =
      typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function'

    const items: ContextMenuItem[] = []
    if (selectedText.length > 0) {
      items.push({
        id: 'generic-input-copy',
        label: 'Copy',
        icon: <Copy size={14} />,
        onSelect: () => {
          copyTextSafe(selectedText)
        },
      })
    }
    if (selectedText.length > 0 && isEditable) {
      items.push({
        id: 'generic-input-cut',
        label: 'Cut',
        icon: <Scissors size={14} />,
        onSelect: () => {
          copyTextSafe(selectedText)
          const nextValue =
            inputEl.value.slice(0, selStart) + inputEl.value.slice(selEnd)
          setNativeControlValue(inputEl, nextValue)
          inputEl.focus()
          try {
            inputEl.setSelectionRange(selStart, selStart)
          } catch {
            // Ignore unsupported selection range on email/number inputs
          }
        },
      })
    }
    if (isEditable && canReadClipboard) {
      items.push({
        id: 'generic-input-paste',
        label: 'Paste',
        icon: <Clipboard size={14} />,
        onSelect: () => {
          void navigator.clipboard
            .readText()
            .then((clip) => {
              if (typeof clip !== 'string' || clip.length === 0) return
              const s = inputEl.selectionStart ?? selStart
              const e = inputEl.selectionEnd ?? selEnd
              const lo = Math.min(s, e)
              const hi = Math.max(s, e)
              const nextValue =
                inputEl.value.slice(0, lo) + clip + inputEl.value.slice(hi)
              setNativeControlValue(inputEl, nextValue)
              inputEl.focus()
              const caret = lo + clip.length
              try {
                inputEl.setSelectionRange(caret, caret)
              } catch {
                // Ignore
              }
            })
            .catch(() => {
              // Ignore denied clipboard-read permission
            })
        },
      })
    }
    if (hasValue) {
      items.push({
        id: 'generic-input-select-all',
        label: 'Select All',
        icon: <TextSelect size={14} />,
        dividerBefore: items.length > 0,
        onSelect: () => {
          inputEl.focus()
          inputEl.select()
        },
      })
    }

    return items.length > 0 ? { items } : null
  }

  // 3. Non-empty page text selection
  const selectedText =
    typeof window !== 'undefined' ? window.getSelection()?.toString().trim() ?? '' : ''
  if (selectedText.length > 0) {
    return {
      items: [
        {
          id: 'generic-copy-selection',
          label: 'Copy Selected Text',
          icon: <Copy size={14} />,
          onSelect: () => {
            copyTextSafe(selectedText)
          },
        },
      ],
    }
  }

  // 4. Non-interesting surface -> show nothing
  return null
}

function getNextEnabledIndex(
  items: readonly ContextMenuItem[],
  startIdx: number,
  direction: 1 | -1
): number {
  const len = items.length
  if (len === 0) return -1
  for (let step = 0; step < len; step++) {
    const idx = (startIdx + direction * step + len) % len
    if (!items[idx]?.disabled) return idx
  }
  return -1
}

export function ContextMenuProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  const [menuState, setMenuState] = useState<ActiveContextMenuState | null>(null)
  const [coords, setCoords] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  const [focusedIndex, setFocusedIndex] = useState<number>(-1)

  const menuRef = useRef<HTMLDivElement | null>(null)
  const handledEventsRef = useRef<WeakSet<Event>>(new WeakSet())
  const openedEventsRef = useRef<WeakSet<Event>>(new WeakSet())
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  const closeContextMenu = useCallback(() => {
    setMenuState(null)
    setFocusedIndex(-1)
  }, [])

  const openContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent, spec: ContextMenuSpec) => {
      e.preventDefault()
      const nativeEvent: Event = 'nativeEvent' in e ? e.nativeEvent : e
      handledEventsRef.current.add(nativeEvent)

      const hasContent =
        spec.items.length > 0 ||
        (spec.reactions && spec.reactions.length > 0) ||
        Boolean(spec.onExpandReactions)
      if (!hasContent) {
        setMenuState(null)
        setFocusedIndex(-1)
        return
      }

      openedEventsRef.current.add(nativeEvent)
      setCoords({ left: e.clientX, top: e.clientY })
      setFocusedIndex(-1)
      setMenuState({
        anchorX: e.clientX,
        anchorY: e.clientY,
        spec,
      })
    },
    []
  )

  // Android / PWA Back button closes open context menu first
  useBackHandler(Boolean(menuState), closeContextMenu)

  // Global bubble-phase contextmenu interceptor
  useEffect(() => {
    if (typeof document === 'undefined') return
    const handleGlobalContextMenu = (e: MouseEvent) => {
      if (handledEventsRef.current.has(e)) return
      e.preventDefault()

      // Right-clicking inside the open context menu itself suppresses native menu cleanly
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return
      }

      const genericSpec = buildGenericMenuSpec(e.target)
      if (!genericSpec) {
        closeContextMenu()
        return
      }

      handledEventsRef.current.add(e)
      openedEventsRef.current.add(e)
      setCoords({ left: e.clientX, top: e.clientY })
      setFocusedIndex(-1)
      setMenuState({
        anchorX: e.clientX,
        anchorY: e.clientY,
        spec: genericSpec,
      })
    }

    document.addEventListener('contextmenu', handleGlobalContextMenu)
    return () => {
      document.removeEventListener('contextmenu', handleGlobalContextMenu)
    }
  }, [closeContextMenu])

  // Global mobile touch long-press synthesis (480ms stillness within 10px -> synthetic contextmenu)
  // Cancels immediately on scroll/swipe (>10px), multi-touch, or editable/drag-handle targets.
  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return

    let timerId: number | null = null
    let startX = 0
    let startY = 0
    let lastX = 0
    let lastY = 0
    let pressTarget: Element | null = null
    let openedOnCurrentTouch = false
    let suppressClickUntil = 0
    let lastSynthesizedAt = 0

    const clearPending = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId)
        timerId = null
      }
      pressTarget = null
    }

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        clearPending()
        return
      }
      const rawTarget = e.target
      if (!(rawTarget instanceof Element)) {
        clearPending()
        return
      }
      if (menuRef.current && menuRef.current.contains(rawTarget)) {
        clearPending()
        return
      }
      if (rawTarget.closest(LONG_PRESS_SKIP_SELECTOR)) {
        clearPending()
        return
      }

      clearPending()
      const touch = e.touches[0]
      startX = touch.clientX
      startY = touch.clientY
      lastX = touch.clientX
      lastY = touch.clientY
      pressTarget = rawTarget
      openedOnCurrentTouch = false

      timerId = window.setTimeout(() => {
        const target = pressTarget
        timerId = null
        pressTarget = null
        if (!target || !target.isConnected) return

        const syntheticEvent = new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: lastX,
          clientY: lastY,
          screenX: lastX,
          screenY: lastY,
          button: 2,
          buttons: 2,
          view: window,
        })
        target.dispatchEvent(syntheticEvent)

        if (openedEventsRef.current.has(syntheticEvent)) {
          openedOnCurrentTouch = true
          lastSynthesizedAt = Date.now()
          suppressClickUntil = lastSynthesizedAt + LONG_PRESS_CLICK_SUPPRESS_MS
          try {
            navigator.vibrate?.(12)
          } catch {
            // Ignore unsupported/blocked vibration
          }
          try {
            window.getSelection?.()?.removeAllRanges?.()
          } catch {
            // Ignore selection errors
          }
        }
      }, LONG_PRESS_DURATION_MS)
    }

    const onTouchMove = (e: TouchEvent) => {
      if (timerId === null) return
      if (e.touches.length !== 1) {
        clearPending()
        return
      }
      const touch = e.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE_PX) {
        clearPending()
        return
      }
      lastX = touch.clientX
      lastY = touch.clientY
    }

    const onTouchEnd = (e: TouchEvent) => {
      clearPending()
      if (openedOnCurrentTouch) {
        openedOnCurrentTouch = false
        suppressClickUntil = Date.now() + LONG_PRESS_CLICK_SUPPRESS_MS
        if (e.cancelable) {
          e.preventDefault()
        }
      }
    }

    const onTouchCancel = () => {
      clearPending()
      openedOnCurrentTouch = false
    }

    const onCaptureClick = (e: MouseEvent) => {
      if (Date.now() >= suppressClickUntil) return
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        suppressClickUntil = 0
        return
      }
      suppressClickUntil = 0
      e.preventDefault()
      e.stopPropagation()
    }

    const onCaptureContextMenu = (e: MouseEvent) => {
      if (e.isTrusted && Date.now() - lastSynthesizedAt < LONG_PRESS_NATIVE_CTX_GUARD_MS) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchmove', onTouchMove, { passive: true })
    document.addEventListener('touchend', onTouchEnd, { passive: false })
    document.addEventListener('touchcancel', onTouchCancel, { passive: true })
    document.addEventListener('click', onCaptureClick, true)
    document.addEventListener('contextmenu', onCaptureContextMenu, true)

    return () => {
      clearPending()
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('touchend', onTouchEnd)
      document.removeEventListener('touchcancel', onTouchCancel)
      document.removeEventListener('click', onCaptureClick, true)
      document.removeEventListener('contextmenu', onCaptureContextMenu, true)
    }
  }, [])

  // Clamp rendered menu strictly inside the visual viewport
  useLayoutEffect(() => {
    if (!menuState || !menuRef.current || typeof window === 'undefined') return
    const rect = menuRef.current.getBoundingClientRect()
    const vv = window.visualViewport
    const vpLeft = vv ? Math.max(0, vv.offsetLeft) : 0
    const vpTop = vv ? Math.max(0, vv.offsetTop) : 0
    const vpW = vv ? vv.width : window.innerWidth
    const vpH = vv ? vv.height : window.innerHeight

    const maxLeft = vpLeft + vpW - rect.width - VIEWPORT_EDGE_PAD
    const maxTop = vpTop + vpH - rect.height - VIEWPORT_EDGE_PAD

    let left = menuState.anchorX
    if (left + rect.width > vpLeft + vpW - VIEWPORT_EDGE_PAD) {
      left = menuState.anchorX - rect.width
    }
    left = Math.max(vpLeft + VIEWPORT_EDGE_PAD, Math.min(left, maxLeft))

    let top = menuState.anchorY
    if (top + rect.height > vpTop + vpH - VIEWPORT_EDGE_PAD) {
      top = menuState.anchorY - rect.height
    }
    top = Math.max(vpTop + VIEWPORT_EDGE_PAD, Math.min(top, maxTop))

    setCoords({ left: Math.round(left), top: Math.round(top) })
  }, [menuState])

  // Dismiss on outside click, capture-phase scroll, resize, window blur, and keyboard nav
  useEffect(() => {
    if (!menuState || typeof window === 'undefined') return

    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return
      }
      closeContextMenu()
    }

    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return
      }
      closeContextMenu()
    }

    const onResize = () => closeContextMenu()
    const onBlur = () => closeContextMenu()

    const onKeyDown = (e: KeyboardEvent) => {
      const items = menuState.spec.items
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeContextMenu()
        return
      }
      if (items.length === 0) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusedIndex((prev) => {
          const next = getNextEnabledIndex(items, prev < 0 ? 0 : prev + 1, 1)
          if (next >= 0) itemRefs.current[next]?.focus()
          return next
        })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusedIndex((prev) => {
          const next = getNextEnabledIndex(items, prev < 0 ? items.length - 1 : prev - 1, -1)
          if (next >= 0) itemRefs.current[next]?.focus()
          return next
        })
      } else if (e.key === 'Home') {
        e.preventDefault()
        const first = getNextEnabledIndex(items, 0, 1)
        setFocusedIndex(first)
        if (first >= 0) itemRefs.current[first]?.focus()
      } else if (e.key === 'End') {
        e.preventDefault()
        const last = getNextEnabledIndex(items, items.length - 1, -1)
        setFocusedIndex(last)
        if (last >= 0) itemRefs.current[last]?.focus()
      } else if (e.key === 'Enter' || e.key === ' ') {
        if (focusedIndex >= 0 && items[focusedIndex] && !items[focusedIndex].disabled) {
          e.preventDefault()
          const targetItem = items[focusedIndex]
          closeContextMenu()
          targetItem.onSelect()
        }
      }
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onKeyDown, true)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [menuState, focusedIndex, closeContextMenu])

  const api = useMemo<ContextMenuApi>(
    () => ({
      openContextMenu,
      closeContextMenu,
      isOpen: Boolean(menuState),
    }),
    [openContextMenu, closeContextMenu, menuState]
  )

  const menuPortal =
    menuState && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={menuRef}
            className="ag-ctx-menu"
            role="menu"
            aria-label={menuState.spec.header || 'Context menu'}
            data-no-swipe="true"
            style={{ left: `${coords.left}px`, top: `${coords.top}px` }}
            onMouseDown={(e) => {
              // Preserve text selection in underlying inputs/messages until click resolves
              e.preventDefault()
            }}
          >
            {menuState.spec.header && (
              <div className="ag-ctx-header">{menuState.spec.header}</div>
            )}

            {((menuState.spec.reactions && menuState.spec.reactions.length > 0) ||
              menuState.spec.onExpandReactions) && (
              <div className="ag-ctx-reactions" role="group" aria-label="Quick reactions">
                {menuState.spec.reactions?.map((reaction) => (
                  <button
                    key={reaction.emoji}
                    type="button"
                    className={`ag-ctx-react-btn ${reaction.active ? 'active' : ''}`}
                    aria-label={`React with ${reaction.emoji}`}
                    aria-pressed={Boolean(reaction.active)}
                    onClick={() => {
                      closeContextMenu()
                      reaction.onSelect()
                    }}
                  >
                    {reaction.emoji}
                  </button>
                ))}
                {menuState.spec.onExpandReactions && (
                  <button
                    type="button"
                    className="ag-ctx-react-btn ag-ctx-react-more"
                    title="More reactions & pin emojis"
                    aria-label="More emoji reactions"
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect()
                      const onExpand = menuState.spec.onExpandReactions
                      closeContextMenu()
                      onExpand?.(rect)
                    }}
                  >
                    <Plus size={15} strokeWidth={2.2} />
                  </button>
                )}
              </div>
            )}

            {menuState.spec.items.map((item, idx) => (
              <React.Fragment key={item.id}>
                {item.dividerBefore && idx > 0 && (
                  <div className="ag-ctx-divider" role="separator" />
                )}
                <button
                  ref={(el) => {
                    itemRefs.current[idx] = el
                  }}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  className={`ag-ctx-item ${item.danger ? 'danger' : ''} ${
                    focusedIndex === idx ? 'is-focused' : ''
                  }`}
                  onMouseEnter={() => {
                    if (!item.disabled) setFocusedIndex(idx)
                  }}
                  onClick={() => {
                    if (item.disabled) return
                    closeContextMenu()
                    item.onSelect()
                  }}
                >
                  {item.icon && (
                    <span className="ag-ctx-item-icon" aria-hidden="true">
                      {item.icon}
                    </span>
                  )}
                  <span className="ag-ctx-item-label">{item.label}</span>
                  {item.shortcut && (
                    <span className="ag-ctx-item-shortcut">{item.shortcut}</span>
                  )}
                </button>
              </React.Fragment>
            ))}
          </div>,
          document.body
        )
      : null

  return (
    <ContextMenuContext.Provider value={api}>
      {children}
      {menuPortal}
    </ContextMenuContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useContextMenu(): ContextMenuApi {
  const ctx = useContext(ContextMenuContext)
  if (!ctx) {
    return {
      openContextMenu: (e) => {
        e.preventDefault()
      },
      closeContextMenu: () => {},
      isOpen: false,
    }
  }
  return ctx
}
