import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { createPortal } from 'react-dom'
import {
  extractEmojiShortcodeToken,
  findExactEmojiShortcode,
  recordRecentEmojiShortcode,
  searchEmojiShortcodes,
  type EmojiShortcodeEntry,
  type EmojiShortcodeToken,
} from '../lib/emojiShortcodes.ts'

type TextControl = HTMLTextAreaElement | HTMLInputElement

const NON_PROSE_INPUT_RE =
  /search|filter|npub|nsec|relay|wss|geohash|lightning|lnurl|invoice|token|turn|url|address|handle|key/i

const EXCLUDED_INPUT_MODES = new Set(['numeric', 'decimal', 'tel', 'url', 'email', 'search'])

const MAX_SUGGESTIONS = 7
const POPOVER_MAX_WIDTH = 284
const VIEWPORT_PAD = 8

interface CaretAnchor {
  readonly left: number
  readonly top: number
  readonly bottom: number
}

interface OverlayState {
  readonly target: TextControl
  readonly token: EmojiShortcodeToken
  readonly matches: readonly EmojiShortcodeEntry[]
  readonly activeIndex: number
  readonly anchor: CaretAnchor
}

interface DismissedToken {
  readonly target: TextControl
  readonly start: number
  readonly query: string
}

function isEligibleEmojiTarget(node: EventTarget | null): TextControl | null {
  if (!(node instanceof HTMLTextAreaElement) && !(node instanceof HTMLInputElement)) {
    return null
  }
  if (node.disabled || node.readOnly) return null
  if (node.dataset.noEmojiSuggest === 'true') return null
  if (node.closest('[data-no-emoji-suggest="true"]')) return null

  if (node instanceof HTMLTextAreaElement) {
    return node
  }

  // Only prose <input type="text"> fields; skip search, password, email, url, tel, number, etc.
  if (node.type !== 'text') return null
  if (node.classList.contains('mono')) return null

  const inputMode = (node.inputMode || node.getAttribute('inputmode') || '').toLowerCase()
  if (EXCLUDED_INPUT_MODES.has(inputMode)) return null

  const role = (node.getAttribute('role') || '').toLowerCase()
  if (role === 'searchbox' || role === 'combobox') return null

  const hintText = [
    node.placeholder,
    node.getAttribute('aria-label') || '',
    node.name,
    node.id,
  ].join(' ')
  if (NON_PROSE_INPUT_RE.test(hintText)) return null

  return node
}

function applyEmojiReplacement(
  el: TextControl,
  start: number,
  end: number,
  emoji: string,
): void {
  const current = el.value
  const safeStart = Math.max(0, Math.min(start, current.length))
  const safeEnd = Math.max(safeStart, Math.min(end, current.length))
  const nextValue = `${current.slice(0, safeStart)}${emoji}${current.slice(safeEnd)}`
  const nextCaret = safeStart + emoji.length

  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
  if (descriptor?.set) {
    descriptor.set.call(el, nextValue)
  } else {
    el.value = nextValue
  }

  try {
    el.setSelectionRange(nextCaret, nextCaret)
  } catch {
    // Ignore selection errors on unsupported inputs
  }

  el.dispatchEvent(new Event('input', { bubbles: true }))

  window.requestAnimationFrame(() => {
    if (document.activeElement === el && el.value === nextValue) {
      try {
        el.setSelectionRange(nextCaret, nextCaret)
      } catch {
        // Ignore selection errors
      }
    }
  })
}

const MIRROR_STYLE_PROPS = [
  'boxSizing',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'letterSpacing',
  'textTransform',
  'textIndent',
  'lineHeight',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderTopStyle',
  'borderRightStyle',
  'borderBottomStyle',
  'borderLeftStyle',
  'tabSize',
] as const

function measureCaretAnchor(
  el: TextControl,
  caretIndex: number,
  mirrorEl: HTMLDivElement,
): CaretAnchor {
  const rect = el.getBoundingClientRect()
  const cs = window.getComputedStyle(el)
  const isTextarea = el instanceof HTMLTextAreaElement

  mirrorEl.style.width = `${rect.width}px`
  mirrorEl.style.whiteSpace = isTextarea ? 'pre-wrap' : 'pre'
  mirrorEl.style.wordWrap = isTextarea ? 'break-word' : 'normal'
  mirrorEl.style.overflowWrap = isTextarea ? 'break-word' : 'normal'

  for (const prop of MIRROR_STYLE_PROPS) {
    mirrorEl.style[prop] = cs[prop]
  }

  const beforeText = el.value.slice(0, Math.max(0, Math.min(caretIndex, el.value.length)))
  mirrorEl.textContent = beforeText

  const marker = document.createElement('span')
  marker.textContent = '\u200b'
  mirrorEl.appendChild(marker)

  const parsedLineHeight = Number.parseFloat(cs.lineHeight)
  const parsedFontSize = Number.parseFloat(cs.fontSize) || 14
  const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : parsedFontSize * 1.35

  const rawLeft = rect.left + marker.offsetLeft - el.scrollLeft
  const rawTop = rect.top + marker.offsetTop - el.scrollTop

  const clampedLeft = Math.max(rect.left, Math.min(rawLeft, rect.right))
  const clampedTop = Math.max(rect.top, Math.min(rawTop, Math.max(rect.top, rect.bottom - lineHeight)))
  const clampedBottom = Math.min(rect.bottom, clampedTop + lineHeight)

  return {
    left: clampedLeft,
    top: clampedTop,
    bottom: Math.max(clampedTop + 16, clampedBottom),
  }
}

export function EmojiAutocompleteOverlay(): ReactElement | null {
  const [overlay, setOverlay] = useState<OverlayState | null>(null)
  const overlayRef = useRef<OverlayState | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  const dismissedRef = useRef<DismissedToken | null>(null)
  const isReplacingRef = useRef(false)
  const rafRepositionRef = useRef<number | null>(null)

  const setOverlaySync = useCallback((next: OverlayState | null) => {
    overlayRef.current = next
    setOverlay(next)
  }, [])

  const getMirrorElement = useCallback((): HTMLDivElement => {
    if (mirrorRef.current && mirrorRef.current.isConnected) {
      return mirrorRef.current
    }
    const div = document.createElement('div')
    div.setAttribute('aria-hidden', 'true')
    div.style.position = 'fixed'
    div.style.top = '-9999px'
    div.style.left = '-9999px'
    div.style.visibility = 'hidden'
    div.style.pointerEvents = 'none'
    div.style.overflow = 'hidden'
    div.style.contain = 'layout style'
    document.body.appendChild(div)
    mirrorRef.current = div
    return div
  }, [])

  const commitEntry = useCallback(
    (entry: EmojiShortcodeEntry, stateSnapshot?: OverlayState | null) => {
      const current = stateSnapshot ?? overlayRef.current
      if (!current) return
      dismissedRef.current = null
      setOverlaySync(null)
      recordRecentEmojiShortcode(entry.shortcode)
      isReplacingRef.current = true
      try {
        applyEmojiReplacement(current.target, current.token.start, current.token.end, entry.emoji)
      } finally {
        isReplacingRef.current = false
      }
    },
    [setOverlaySync],
  )

  const evaluateTarget = useCallback(
    (target: EventTarget | null, allowAutoCloseReplace: boolean) => {
      if (isReplacingRef.current) return
      const el = isEligibleEmojiTarget(target)
      if (!el || document.activeElement !== el) {
        if (overlayRef.current) setOverlaySync(null)
        return
      }

      const caret = el.selectionStart
      const selEnd = el.selectionEnd
      if (caret === null || selEnd === null || caret !== selEnd) {
        if (overlayRef.current) setOverlaySync(null)
        return
      }

      const token = extractEmojiShortcodeToken(el.value, caret)
      if (!token) {
        dismissedRef.current = null
        if (overlayRef.current) setOverlaySync(null)
        return
      }

      // Instant exact :shortcode: conversion on typing the closing colon
      if (token.closed) {
        if (allowAutoCloseReplace) {
          const exact = findExactEmojiShortcode(token.query)
          if (exact) {
            dismissedRef.current = null
            setOverlaySync(null)
            recordRecentEmojiShortcode(exact.shortcode)
            isReplacingRef.current = true
            try {
              applyEmojiReplacement(el, token.start, token.end, exact.emoji)
            } finally {
              isReplacingRef.current = false
            }
            return
          }
        }
        if (overlayRef.current) setOverlaySync(null)
        return
      }

      const dismissed = dismissedRef.current
      if (
        dismissed &&
        dismissed.target === el &&
        dismissed.start === token.start &&
        dismissed.query === token.query
      ) {
        if (overlayRef.current) setOverlaySync(null)
        return
      }

      const matches = searchEmojiShortcodes(token.query, MAX_SUGGESTIONS)
      if (matches.length === 0) {
        if (overlayRef.current) setOverlaySync(null)
        return
      }

      const mirror = getMirrorElement()
      const anchor = measureCaretAnchor(el, token.start, mirror)
      const prev = overlayRef.current
      const sameQuery =
        prev !== null &&
        prev.target === el &&
        prev.token.start === token.start &&
        prev.token.query === token.query
      const nextIndex = sameQuery ? Math.min(prev.activeIndex, matches.length - 1) : 0

      setOverlaySync({
        target: el,
        token,
        matches,
        activeIndex: nextIndex,
        anchor,
      })
    },
    [getMirrorElement, setOverlaySync],
  )

  useEffect(() => {
    const onInput = (e: Event) => {
      evaluateTarget(e.target, true)
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (
        e.key === 'ArrowDown' ||
        e.key === 'ArrowUp' ||
        e.key === 'Enter' ||
        e.key === 'Tab' ||
        e.key === 'Escape'
      ) {
        return
      }
      evaluateTarget(e.target, false)
    }

    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && e.target instanceof Node && popoverRef.current.contains(e.target)) {
        return
      }
      evaluateTarget(e.target, false)
    }

    const onFocusIn = (e: FocusEvent) => {
      evaluateTarget(e.target, false)
    }

    const onFocusOut = () => {
      if (overlayRef.current) {
        setOverlaySync(null)
      }
    }

    const onPointerDown = (e: PointerEvent) => {
      const current = overlayRef.current
      if (!current) return
      if (e.target instanceof Node) {
        if (popoverRef.current?.contains(e.target)) return
        if (e.target === current.target) return
      }
      setOverlaySync(null)
    }

    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return
      const current = overlayRef.current
      if (!current) return
      if (document.activeElement !== current.target) {
        setOverlaySync(null)
        return
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        const nextIndex = (current.activeIndex + 1) % current.matches.length
        setOverlaySync({ ...current, activeIndex: nextIndex })
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        const nextIndex =
          (current.activeIndex - 1 + current.matches.length) % current.matches.length
        setOverlaySync({ ...current, activeIndex: nextIndex })
        return
      }

      if ((e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) || e.key === 'Tab') {
        const chosen = current.matches[current.activeIndex] ?? current.matches[0]
        if (!chosen) return
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        commitEntry(chosen, current)
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        dismissedRef.current = {
          target: current.target,
          start: current.token.start,
          query: current.token.query,
        }
        setOverlaySync(null)
      }
    }

    const scheduleReposition = (e: Event) => {
      const current = overlayRef.current
      if (!current) return
      if (e.target instanceof Node && popoverRef.current?.contains(e.target)) {
        return
      }
      if (rafRepositionRef.current !== null) return
      rafRepositionRef.current = window.requestAnimationFrame(() => {
        rafRepositionRef.current = null
        const latest = overlayRef.current
        if (!latest || document.activeElement !== latest.target || !latest.target.isConnected) {
          setOverlaySync(null)
          return
        }
        const mirror = getMirrorElement()
        const anchor = measureCaretAnchor(latest.target, latest.token.start, mirror)
        setOverlaySync({ ...latest, anchor })
      })
    }

    document.addEventListener('input', onInput)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('click', onClick)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDownCapture, true)
    window.addEventListener('scroll', scheduleReposition, true)
    window.addEventListener('resize', scheduleReposition)

    return () => {
      document.removeEventListener('input', onInput)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('click', onClick)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDownCapture, true)
      window.removeEventListener('scroll', scheduleReposition, true)
      window.removeEventListener('resize', scheduleReposition)
      if (rafRepositionRef.current !== null) {
        window.cancelAnimationFrame(rafRepositionRef.current)
        rafRepositionRef.current = null
      }
      if (mirrorRef.current?.isConnected) {
        mirrorRef.current.remove()
      }
      mirrorRef.current = null
    }
  }, [commitEntry, evaluateTarget, getMirrorElement, setOverlaySync])

  // Keep keyboard-selected row visible inside the popover list
  useLayoutEffect(() => {
    if (!overlay || !popoverRef.current) return
    const activeEl = popoverRef.current.querySelector<HTMLElement>(
      '.ag-emoji-suggest-item.active',
    )
    activeEl?.scrollIntoView({ block: 'nearest' })
  }, [overlay])

  if (!overlay || typeof document === 'undefined') return null

  const viewW = window.innerWidth
  const viewH = window.visualViewport?.height ?? window.innerHeight
  const viewTopOffset = window.visualViewport?.offsetTop ?? 0
  const popWidth = Math.min(POPOVER_MAX_WIDTH, viewW - VIEWPORT_PAD * 2)
  const clampedLeft = Math.max(
    VIEWPORT_PAD,
    Math.min(overlay.anchor.left, viewW - popWidth - VIEWPORT_PAD),
  )

  const estHeight = 34 + overlay.matches.length * 40 + (viewW >= 768 ? 26 : 0)
  const spaceAbove = overlay.anchor.top - viewTopOffset - VIEWPORT_PAD
  const spaceBelow = viewTopOffset + viewH - overlay.anchor.bottom - VIEWPORT_PAD
  const openAbove = spaceBelow < estHeight + 10 && spaceAbove >= spaceBelow

  const positionStyle: CSSProperties = openAbove
    ? {
        left: `${Math.round(clampedLeft)}px`,
        bottom: `${Math.max(VIEWPORT_PAD, Math.round(window.innerHeight - overlay.anchor.top + 6))}px`,
        width: `${Math.round(popWidth)}px`,
      }
    : {
        left: `${Math.round(clampedLeft)}px`,
        top: `${Math.max(
          VIEWPORT_PAD,
          Math.min(
            Math.round(overlay.anchor.bottom + 6),
            Math.round(viewTopOffset + viewH - Math.min(estHeight, 260) - VIEWPORT_PAD),
          ),
        )}px`,
        width: `${Math.round(popWidth)}px`,
      }

  return createPortal(
    <div
      ref={popoverRef}
      className={`ag-emoji-suggest-popover${openAbove ? ' is-above' : ' is-below'}`}
      style={positionStyle}
      role="listbox"
      aria-label="Emoji shortcode suggestions"
      data-emoji-suggest-popover="true"
    >
      <div className="ag-emoji-suggest-head">
        <span className="ag-emoji-suggest-query mono">:{overlay.token.query}</span>
        <span className="ag-emoji-suggest-count mono tabular">{overlay.matches.length}</span>
      </div>

      <div className="ag-emoji-suggest-list">
        {overlay.matches.map((entry, idx) => {
          const isActive = idx === overlay.activeIndex
          return (
            <button
              key={entry.shortcode}
              type="button"
              role="option"
              aria-selected={isActive}
              className={`ag-emoji-suggest-item${isActive ? ' active' : ''}`}
              onMouseEnter={() => {
                if (overlayRef.current && overlayRef.current.activeIndex !== idx) {
                  setOverlaySync({ ...overlayRef.current, activeIndex: idx })
                }
              }}
              onMouseDown={(e) => {
                e.preventDefault()
              }}
              onPointerDown={(e) => {
                e.preventDefault()
                commitEntry(entry)
              }}
              onClick={(e) => {
                e.preventDefault()
              }}
            >
              <span className="ag-emoji-suggest-glyph" aria-hidden="true">
                {entry.emoji}
              </span>
              <span className="ag-emoji-suggest-code mono">:{entry.shortcode}:</span>
              <span className="ag-emoji-suggest-name truncate">{entry.name}</span>
            </button>
          )
        })}
      </div>

      <div className="ag-emoji-suggest-foot">
        <span>↑↓ navigate</span>
        <span>Enter / Tab insert</span>
        <span>Esc close</span>
      </div>
    </div>,
    document.body,
  )
}

export default EmojiAutocompleteOverlay
