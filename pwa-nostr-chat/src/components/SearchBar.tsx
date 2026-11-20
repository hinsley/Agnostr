import React, { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'

export interface SearchBarProps {
  open: boolean
  query: string
  matchCount: number
  activeMatchIndex: number
  onQueryChange: (q: string) => void
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}

export const SearchBar: React.FC<SearchBarProps> = ({
  open,
  query,
  matchCount,
  activeMatchIndex,
  onQueryChange,
  onPrev,
  onNext,
  onClose,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [open])

  if (!open) return null

  return (
    <div className="ag-searchbar" role="search" aria-label="Search messages in channel">
      <div className="ag-searchbar-input-wrap">
        <Search size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input
          ref={inputRef}
          type="text"
          className="ag-searchbar-input"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            } else if (e.key === 'Enter') {
              e.preventDefault()
              if (e.shiftKey) onPrev()
              else onNext()
            }
          }}
          placeholder="Search messages, handles, or tags in this stream…"
        />
        {query.trim() && (
          <span className="ag-searchbar-count tabular">
            {matchCount > 0 ? `${activeMatchIndex + 1} / ${matchCount}` : '0 matches'}
          </span>
        )}
      </div>
      <button
        type="button"
        className="ag-icon-btn"
        disabled={matchCount === 0}
        onClick={onPrev}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >
        <ChevronUp size={15} />
      </button>
      <button
        type="button"
        className="ag-icon-btn"
        disabled={matchCount === 0}
        onClick={onNext}
        title="Next match (Enter)"
        aria-label="Next match"
      >
        <ChevronDown size={15} />
      </button>
      <button
        type="button"
        className="ag-icon-btn"
        onClick={onClose}
        title="Close search (Esc)"
        aria-label="Close search"
      >
        <X size={15} />
      </button>
    </div>
  )
}

export default SearchBar
