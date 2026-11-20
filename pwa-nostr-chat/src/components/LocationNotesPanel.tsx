import { useEffect, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import {
  Clock,
  Loader2,
  MapPin,
  RefreshCw,
  Send,
  StickyNote,
} from 'lucide-react'
import type { AgnostrEngine } from '../types/protocol.ts'
import type { SoundCue } from '../utils/sound.ts'
import { formatHandle, identiconDataUrl, pubkeyToColor } from '../utils/identicon.ts'

export interface LocationNotesPanelProps {
  engine: AgnostrEngine
  onPlaySound?: (cue: SoundCue) => void
}

const MAX_NOTE_LENGTH = 280

function formatCountdown(expiresAtSec: number, nowSec: number): {
  label: string
  urgent: boolean
  expired: boolean
} {
  const remaining = expiresAtSec - nowSec
  if (remaining <= 0) {
    return { label: 'Expired', urgent: true, expired: true }
  }
  const hours = Math.floor(remaining / 3600)
  const mins = Math.floor((remaining % 3600) / 60)
  if (hours >= 1) {
    return {
      label: `${hours}h ${mins.toString().padStart(2, '0')}m`,
      urgent: hours < 2,
      expired: false,
    }
  }
  if (mins >= 1) {
    return { label: `${mins}m left`, urgent: true, expired: false }
  }
  return { label: '<1m left', urgent: true, expired: false }
}

function formatAge(createdAtSec: number, nowSec: number): string {
  const diff = Math.max(0, nowSec - createdAtSec)
  if (diff < 60) return 'just now'
  const mins = Math.floor(diff / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function LocationNotesPanel({ engine, onPlaySound }: LocationNotesPanelProps) {
  const { activeGeohash, cell, locationNotes } = engine
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    const id = window.setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000))
    }, 30_000)
    return () => window.clearInterval(id)
  }, [])

  const submitNote = async () => {
    const trimmed = draft.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      const ok = await engine.postLocationNote(trimmed)
      if (ok) {
        setDraft('')
        onPlaySound?.('send')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    void submitNote()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void submitNote()
    }
  }

  const handleRefresh = () => {
    setRefreshing(true)
    onPlaySound?.('click')
    engine.refreshLocationNotes()
    window.setTimeout(() => setRefreshing(false), 600)
  }

  const activeNotes = locationNotes
    .filter((note) => note.expiresAt > nowSec - 60)
    .sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div className="ag-panel ag-notes-panel">
      {/* Header & Composer */}
      <section className="ag-panel-card">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <StickyNote size={13} />
            <span>DEAD-DROP NOTES</span>
          </div>
          <div className="ag-notes-head-actions">
            <span className="ag-chip ag-chip-mono">#{activeGeohash}</span>
            <button
              type="button"
              className="ag-icon-btn-xs"
              onClick={handleRefresh}
              title="Refresh location notes from relays"
              aria-label="Refresh location notes"
            >
              <RefreshCw size={12} className={refreshing ? 'ag-spin' : ''} />
            </button>
          </div>
        </div>

        <p className="ag-field-hint">
          Leave an ephemeral 24h note pinned to <strong>#{activeGeohash}</strong>
          {cell.nearestCity ? ` (${cell.nearestCity})` : ''}. Compatible with Bitchat{' '}
          <code className="mono">/drop</code> (NIP-40).
        </p>

        <form className="ag-note-composer" onSubmit={handleSubmit}>
          <textarea
            className="ag-textarea"
            rows={3}
            maxLength={MAX_NOTE_LENGTH}
            placeholder={`Drop a 24h note at #${activeGeohash}…`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={submitting}
            aria-label={`Drop a 24-hour location note at #${activeGeohash}`}
          />
          <div className="ag-note-composer-foot">
            <span className="ag-char-count mono">
              {draft.length}/{MAX_NOTE_LENGTH}
            </span>
            <button
              type="submit"
              className="ag-btn ag-btn-primary ag-btn-sm"
              disabled={submitting || !draft.trim()}
            >
              {submitting ? (
                <>
                  <Loader2 size={13} className="ag-spin" />
                  <span>Dropping…</span>
                </>
              ) : (
                <>
                  <Send size={13} />
                  <span>Drop Note</span>
                </>
              )}
            </button>
          </div>
        </form>
      </section>

      {/* Pinned Dead-Drop List */}
      <div className="ag-notes-list" role="list" aria-label={`Location notes at #${activeGeohash}`}>
        {activeNotes.length === 0 ? (
          <div className="ag-empty-panel">
            <MapPin size={20} className="ag-empty-icon" />
            <p className="ag-empty-title">No dead-drops at #{activeGeohash}</p>
            <p className="ag-empty-sub">
              Be the first to leave a 24-hour beacon note here using the box above or{' '}
              <code className="mono">/drop</code> in chat.
            </p>
          </div>
        ) : (
          activeNotes.map((note) => {
            const handle = formatHandle(note.nickname, note.pubkey)
            const color = pubkeyToColor(note.pubkey)
            const countdown = formatCountdown(note.expiresAt, nowSec)
            return (
              <article
                key={note.id}
                role="listitem"
                className={`ag-note-card ${countdown.expired ? 'expired' : ''}`}
              >
                <div className="ag-note-card-head">
                  <div className="ag-note-author">
                    <img
                      src={identiconDataUrl(note.pubkey)}
                      alt=""
                      className="ag-note-avatar"
                      width={24}
                      height={24}
                    />
                    <div className="ag-note-author-meta">
                      <span className="ag-note-handle truncate" style={{ color }}>
                        @{handle.base}
                        <span className="ag-peer-suffix mono">#{handle.suffix}</span>
                      </span>
                      <span className="ag-note-age mono">{formatAge(note.createdAt, nowSec)}</span>
                    </div>
                    {note.isOwn && <span className="ag-badge ag-badge-accent">YOU</span>}
                  </div>

                  <span
                    className={`ag-expiry-pill mono ${countdown.urgent ? 'urgent' : ''}`}
                    title={`Expires at ${new Date(note.expiresAt * 1000).toLocaleString()}`}
                  >
                    <Clock size={10} />
                    <span>{countdown.label}</span>
                  </span>
                </div>

                <p className="ag-note-body">{note.content}</p>
              </article>
            )
          })
        )}
      </div>
    </div>
  )
}
