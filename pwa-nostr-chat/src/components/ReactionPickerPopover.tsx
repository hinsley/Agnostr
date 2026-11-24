import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pin, RotateCcw, Search, Sparkles, X } from 'lucide-react'
import { useBackHandler } from '../hooks/useBackNavigation'
import {
  findReactionEmojiEntry,
  isDefaultPinnedReactions,
  MAX_PINNED_REACTIONS,
  REACTION_EMOJI_CATALOG,
  REACTION_EMOJI_CATEGORIES,
  resetPinnedReactions,
  togglePinnedReaction,
  unpinReaction,
  usePinnedReactions,
  type ReactionEmojiCategoryId,
  type ReactionEmojiEntry,
} from '../lib/reactionEmojis'

export interface ReactionPickerPopoverProps {
  anchorRect: DOMRect
  activeEmojis?: readonly string[]
  onSelect: (emoji: string) => void
  onClose: () => void
}

const VIEWPORT_PAD = 8

export const ReactionPickerPopover: React.FC<ReactionPickerPopoverProps> = ({
  anchorRect,
  activeEmojis = [],
  onSelect,
  onClose,
}) => {
  const pinnedReactions = usePinnedReactions()
  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState<'all' | ReactionEmojiCategoryId>('all')
  const [pinMode, setPinMode] = useState(false)
  const [inspectedEmoji, setInspectedEmoji] = useState<string | null>(null)
  const [limitNotice, setLimitNotice] = useState(false)
  const [coords, setCoords] = useState<{ left: number; top: number; ready: boolean }>({
    left: Math.round(anchorRect.left),
    top: Math.round(anchorRect.bottom + 6),
    ready: false,
  })

  const popoverRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const limitTimerRef = useRef<number | null>(null)

  useBackHandler(true, onClose)

  const pinnedSet = useMemo(() => new Set(pinnedReactions), [pinnedReactions])
  const activeSet = useMemo(() => new Set(activeEmojis), [activeEmojis])
  const isCustomized = !isDefaultPinnedReactions(pinnedReactions)

  // Clear limit notice timer on unmount
  useEffect(() => {
    return () => {
      if (limitTimerRef.current !== null) {
        window.clearTimeout(limitTimerRef.current)
      }
    }
  }, [])

  // Auto-focus search input on desktop only (avoid popping mobile software keyboard on open)
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.innerWidth >= 868) {
      searchInputRef.current?.focus({ preventScroll: true })
    }
  }, [])

  // Dismiss on Escape or outside pointerdown
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    const onPointerDown = (e: PointerEvent) => {
      if (popoverRef.current && e.target instanceof Node && popoverRef.current.contains(e.target)) {
        return
      }
      onClose()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose])

  // Smartly position and clamp strictly inside the visual viewport on all 4 edges
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return

    const updatePosition = () => {
      const el = popoverRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const vv = window.visualViewport
      const vpLeft = vv ? Math.max(0, vv.offsetLeft) : 0
      const vpTop = vv ? Math.max(0, vv.offsetTop) : 0
      const vpW = vv ? vv.width : window.innerWidth
      const vpH = vv ? vv.height : window.innerHeight

      const maxLeft = Math.max(vpLeft + VIEWPORT_PAD, vpLeft + vpW - rect.width - VIEWPORT_PAD)
      const preferredLeft =
        anchorRect.right - rect.width >= vpLeft + VIEWPORT_PAD
          ? anchorRect.right - rect.width
          : anchorRect.left
      const left = Math.max(vpLeft + VIEWPORT_PAD, Math.min(preferredLeft, maxLeft))

      const spaceBelow = vpTop + vpH - anchorRect.bottom - VIEWPORT_PAD
      const spaceAbove = anchorRect.top - vpTop - VIEWPORT_PAD
      let top = anchorRect.bottom + 6
      if (spaceBelow < rect.height + 6 && spaceAbove > spaceBelow) {
        top = anchorRect.top - rect.height - 6
      }
      const maxTop = Math.max(vpTop + VIEWPORT_PAD, vpTop + vpH - rect.height - VIEWPORT_PAD)
      top = Math.max(vpTop + VIEWPORT_PAD, Math.min(top, maxTop))

      setCoords({ left: Math.round(left), top: Math.round(top), ready: true })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [anchorRect, pinnedReactions.length, query, limitNotice])

  const trimmedQuery = query.trim().toLowerCase()
  const isSearching = trimmedQuery.length > 0

  const filteredEntries: readonly ReactionEmojiEntry[] = useMemo(() => {
    if (isSearching) {
      return REACTION_EMOJI_CATALOG.filter((entry) => {
        if (entry.emoji === trimmedQuery || entry.emoji.includes(trimmedQuery)) return true
        if (entry.name.toLowerCase().includes(trimmedQuery)) return true
        return entry.keywords.some((kw) => kw.toLowerCase().includes(trimmedQuery))
      })
    }
    if (activeCategory === 'all') return REACTION_EMOJI_CATALOG
    return REACTION_EMOJI_CATALOG.filter((entry) => entry.category === activeCategory)
  }, [isSearching, trimmedQuery, activeCategory])

  const showLimitNotice = () => {
    setLimitNotice(true)
    if (limitTimerRef.current !== null) {
      window.clearTimeout(limitTimerRef.current)
    }
    limitTimerRef.current = window.setTimeout(() => {
      setLimitNotice(false)
      limitTimerRef.current = null
    }, 2600)
  }

  const handleTogglePin = (emoji: string) => {
    const res = togglePinnedReaction(emoji)
    if (res.reason === 'limit') {
      showLimitNotice()
      return
    }
    if (res.ok && res.action === 'unpinned') {
      setLimitNotice(false)
    }
  }

  const handleUnpin = (emoji: string) => {
    unpinReaction(emoji)
    setLimitNotice(false)
  }

  const handleResetPins = () => {
    resetPinnedReactions()
    setLimitNotice(false)
  }

  const inspectedEntry = inspectedEmoji ? findReactionEmojiEntry(inspectedEmoji) : undefined
  const inspectedIsPinned = inspectedEmoji ? pinnedSet.has(inspectedEmoji) : false

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={popoverRef}
      className={`ag-rpicker ${pinMode ? 'is-pin-mode' : ''} ${coords.ready ? 'is-ready' : ''}`}
      role="dialog"
      aria-label="Emoji reactions"
      data-no-swipe="true"
      data-no-long-press="true"
      style={{ left: `${coords.left}px`, top: `${coords.top}px` }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {/* Header: Search Input + Pin Mode Toggle */}
      <div className="ag-rpicker-head">
        <div className="ag-rpicker-search-wrap">
          <Search size={13} className="ag-rpicker-search-icon" aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="text"
            className="ag-rpicker-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search emoji…"
            aria-label="Search emoji reactions"
          />
          {query && (
            <button
              type="button"
              className="ag-rpicker-search-clear"
              onClick={() => {
                setQuery('')
                searchInputRef.current?.focus({ preventScroll: true })
              }}
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <button
          type="button"
          className={`ag-rpicker-pin-btn ${pinMode ? 'is-active' : ''}`}
          aria-pressed={pinMode}
          onClick={() => setPinMode((v) => !v)}
          title={pinMode ? 'Finish pinning emojis' : 'Pin or unpin quick-reaction emojis (up to 9)'}
        >
          <Pin size={13} />
          <span>{pinMode ? 'Done' : 'Pin'}</span>
        </button>
      </div>

      {/* Pinned Strip (N/9 + Reset) */}
      <div className="ag-rpicker-pinned">
        <div className="ag-rpicker-pinned-head">
          <span className="ag-rpicker-pinned-title tabular">
            Pinned · {pinnedReactions.length}/{MAX_PINNED_REACTIONS}
          </span>
          {isCustomized && (
            <button
              type="button"
              className="ag-rpicker-reset-btn"
              onClick={handleResetPins}
              title="Restore default 6 quick reactions"
            >
              <RotateCcw size={11} aria-hidden="true" />
              <span>Reset</span>
            </button>
          )}
        </div>

        {pinnedReactions.length > 0 ? (
          <div className="ag-rpicker-pinned-row" role="list" aria-label="Pinned quick reactions">
            {pinnedReactions.map((emoji) => {
              const entry = findReactionEmojiEntry(emoji)
              const label = entry ? entry.name : emoji
              return (
                <div key={emoji} className="ag-rpicker-pin-chip" role="listitem">
                  <button
                    type="button"
                    className={`ag-rpicker-pin-emoji ${activeSet.has(emoji) ? 'is-reacted' : ''}`}
                    title={pinMode ? `Unpin ${label}` : `React with ${label}`}
                    aria-label={pinMode ? `Unpin ${label}` : `React with ${label}`}
                    onMouseEnter={() => setInspectedEmoji(emoji)}
                    onFocus={() => setInspectedEmoji(emoji)}
                    onClick={() => {
                      if (pinMode) {
                        handleUnpin(emoji)
                      } else {
                        onSelect(emoji)
                        onClose()
                      }
                    }}
                  >
                    {emoji}
                  </button>
                  <button
                    type="button"
                    className="ag-rpicker-pin-unpin"
                    title={`Unpin ${label}`}
                    aria-label={`Unpin ${label}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleUnpin(emoji)
                    }}
                  >
                    <X size={9} strokeWidth={2.5} />
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="ag-rpicker-pinned-empty">
            No pinned emojis — tap Pin to choose up to {MAX_PINNED_REACTIONS}.
          </div>
        )}

        {limitNotice && (
          <div className="ag-rpicker-limit-notice" role="status" aria-live="polite">
            Max {MAX_PINNED_REACTIONS} pinned — unpin one first
          </div>
        )}
      </div>

      {/* Category Tabs (hidden while searching) */}
      {!isSearching && (
        <div className="ag-rpicker-cats" role="tablist" aria-label="Emoji categories">
          <button
            type="button"
            role="tab"
            aria-selected={activeCategory === 'all'}
            className={`ag-rpicker-cat-btn ${activeCategory === 'all' ? 'active' : ''}`}
            title="All"
            aria-label="All categories"
            onClick={() => setActiveCategory('all')}
          >
            <Sparkles size={13} />
          </button>
          {REACTION_EMOJI_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              role="tab"
              aria-selected={activeCategory === cat.id}
              className={`ag-rpicker-cat-btn ${activeCategory === cat.id ? 'active' : ''}`}
              title={cat.label}
              aria-label={cat.label}
              onClick={() => setActiveCategory(cat.id)}
            >
              <span>{cat.icon}</span>
            </button>
          ))}
        </div>
      )}

      {/* Emoji Grid */}
      <div className="ag-rpicker-grid-wrap">
        {filteredEntries.length > 0 ? (
          <div className="ag-rpicker-grid" role="grid" aria-label="Emoji options">
            {filteredEntries.map((entry) => {
              const isReacted = activeSet.has(entry.emoji)
              const isPinned = pinnedSet.has(entry.emoji)
              return (
                <button
                  key={entry.emoji}
                  type="button"
                  className={`ag-rpicker-cell ${isReacted ? 'is-reacted' : ''} ${isPinned ? 'is-pinned' : ''}`}
                  title={
                    pinMode
                      ? `${entry.name} (${isPinned ? 'click to unpin' : 'click to pin'})`
                      : `${entry.name} · Right-click to ${isPinned ? 'unpin' : 'pin'}`
                  }
                  aria-label={
                    pinMode
                      ? `${isPinned ? 'Unpin' : 'Pin'} ${entry.name}`
                      : `React with ${entry.name}`
                  }
                  aria-pressed={pinMode ? isPinned : isReacted}
                  onMouseEnter={() => setInspectedEmoji(entry.emoji)}
                  onFocus={() => setInspectedEmoji(entry.emoji)}
                  onClick={() => {
                    if (pinMode) {
                      handleTogglePin(entry.emoji)
                    } else {
                      onSelect(entry.emoji)
                      onClose()
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    handleTogglePin(entry.emoji)
                  }}
                >
                  <span className="ag-rpicker-cell-glyph">{entry.emoji}</span>
                  {isPinned && <span className="ag-rpicker-pin-dot" aria-hidden="true" />}
                </button>
              )
            })}
          </div>
        ) : (
          <div className="ag-rpicker-empty">No emojis matching “{query.trim()}”</div>
        )}
      </div>

      {/* Compact Detail Footer */}
      <div className="ag-rpicker-footer">
        {pinMode ? (
          inspectedEntry ? (
            <>
              <span className="ag-rpicker-footer-emoji" aria-hidden="true">
                {inspectedEntry.emoji}
              </span>
              <span className="ag-rpicker-footer-name truncate">{inspectedEntry.name}</span>
              <span className="ag-rpicker-footer-hint">
                {inspectedIsPinned ? 'Tap to unpin' : 'Tap to pin'}
              </span>
            </>
          ) : (
            <span className="ag-rpicker-footer-hint tabular">
              Tap any emoji to pin or unpin ({pinnedReactions.length}/{MAX_PINNED_REACTIONS})
            </span>
          )
        ) : inspectedEntry ? (
          <>
            <span className="ag-rpicker-footer-emoji" aria-hidden="true">
              {inspectedEntry.emoji}
            </span>
            <span className="ag-rpicker-footer-name truncate">{inspectedEntry.name}</span>
            <span className="ag-rpicker-footer-hint">
              {inspectedIsPinned ? 'Pinned · Right-click to unpin' : 'Right-click to pin'}
            </span>
          </>
        ) : (
          <span className="ag-rpicker-footer-hint">
            Click to react · Right-click or tap Pin to customize
          </span>
        )}
      </div>
    </div>,
    document.body
  )
}

export default ReactionPickerPopover
