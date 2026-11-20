import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  CornerUpLeft,
  Cpu,
  Loader2,
  Lock,
  Send,
  Terminal,
  X,
} from 'lucide-react'
import type { AgnostrEngine, PeerInfo, SlashCommandDef } from '../types/protocol'
import { identiconDataUrl, pubkeyToColor } from '../utils/identicon'

export interface ComposerProps {
  engine: AgnostrEngine
  externalDraftToken: { id: number; text: string } | null
  onSent?: (isDm: boolean) => void
}

type AutocompleteMode =
  | { type: 'none' }
  | { type: 'command'; query: string; items: SlashCommandDef[] }
  | { type: 'mention'; query: string; startIdx: number; endIdx: number; items: PeerInfo[] }

export const Composer: React.FC<ComposerProps> = ({
  engine,
  externalDraftToken,
  onSent,
}) => {
  const [draft, setDraft] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const isDm = engine.activeView.type === 'dm' && engine.activeDmThread !== null
  const dmThread = engine.activeDmThread

  // Handle external mention or snippet insertions (e.g., clicking "Mention" in PeerInspector)
  useEffect(() => {
    if (!externalDraftToken) return
    if (externalDraftToken.text) {
      setDraft((prev) => {
        const needsSpace = prev.length > 0 && !prev.endsWith(' ')
        return `${prev}${needsSpace ? ' ' : ''}${externalDraftToken.text}`
      })
    }
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    })
  }, [externalDraftToken])

  // Auto-grow textarea cleanly
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [draft])

  // Compute slash-command or @mention autocomplete state
  const autocomplete: AutocompleteMode = useMemo(() => {
    // Slash commands only in channel mode or top-level `/`
    if (draft.startsWith('/') && !draft.includes('\n')) {
      const firstSpace = draft.indexOf(' ')
      if (firstSpace === -1) {
        const q = draft.slice(1).toLowerCase()
        const matches = engine.commands.filter(
          (c) =>
            c.name.toLowerCase().startsWith(q) ||
            c.aliases.some((a) => a.toLowerCase().startsWith(q)) ||
            (q.length >= 2 && c.description.toLowerCase().includes(q))
        )
        if (matches.length > 0) {
          return { type: 'command', query: q, items: matches.slice(0, 8) }
        }
      }
    }

    // @mention lookup before cursor
    const beforeCursor = draft.slice(0, cursorPos)
    const mentionMatch = /(?:^|\s)@([a-zA-Z0-9_.-]{0,24})$/.exec(beforeCursor)
    if (mentionMatch && !isDm) {
      const q = mentionMatch[1].toLowerCase()
      const startIdx = beforeCursor.length - mentionMatch[1].length - 1
      const candidates = engine.peers
        .filter((p) => !p.isSelf && !p.isBlocked)
        .filter(
          (p) =>
            !q ||
            p.nickname.toLowerCase().includes(q) ||
            p.displayHandle.toLowerCase().includes(q)
        )
        .slice(0, 7)

      if (candidates.length > 0) {
        return {
          type: 'mention',
          query: q,
          startIdx,
          endIdx: cursorPos,
          items: candidates,
        }
      }
    }

    return { type: 'none' }
  }, [draft, cursorPos, engine.commands, engine.peers, isDm])

  // Keep selectedIndex clamped
  const acQuery = autocomplete.type === 'none' ? '' : autocomplete.query
  useEffect(() => {
    setSelectedIndex(0)
  }, [autocomplete.type, acQuery])

  const applyCommandCompletion = (cmd: SlashCommandDef) => {
    const needsArg = cmd.usage.includes('<') || cmd.usage.includes('[')
    const next = `/${cmd.name}${needsArg ? ' ' : ''}`
    setDraft(next)
    setCursorPos(next.length)
    textareaRef.current?.focus()
  }

  const applyMentionCompletion = (peer: PeerInfo, startIdx: number, endIdx: number) => {
    const insert = `${peer.displayHandle} `
    const next = draft.slice(0, startIdx) + insert + draft.slice(endIdx)
    const nextCursor = startIdx + insert.length
    setDraft(next)
    setCursorPos(nextCursor)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(nextCursor, nextCursor)
      }
    })
  }

  const canSign =
    engine.identity.signMode === 'auto'
      ? Boolean(engine.identity.activePubkey)
      : engine.identity.signMode === 'extension'
        ? engine.identity.hasNip07
        : engine.identity.localSecretValid

  const handleSubmit = async () => {
    const trimmed = draft.trim()
    if (!trimmed || engine.sending || !canSign) return

    setHistory((prev) => [trimmed, ...prev.filter((x) => x !== trimmed)].slice(0, 30))
    setHistoryIdx(-1)
    setDraft('')

    let ok = false
    if (isDm && dmThread && !trimmed.startsWith('/')) {
      ok = await engine.sendDirectMessage(dmThread.peerPubkey, trimmed, dmThread.protocol)
    } else {
      ok = await engine.sendInput(trimmed)
    }

    if (ok) {
      onSent?.(isDm)
    } else {
      // Restore draft if sending failed
      setDraft(trimmed)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle Autocomplete keyboard navigation
    if (autocomplete.type !== 'none') {
      const count = autocomplete.items.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => (i + 1) % count)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => (i - 1 + count) % count)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        // If user already typed an exact zero-arg command (like `/who`), Enter submits it directly
        if (
          e.key === 'Enter' &&
          autocomplete.type === 'command' &&
          autocomplete.items[selectedIndex] &&
          draft.trim() === `/${autocomplete.items[selectedIndex].name}`
        ) {
          e.preventDefault()
          void handleSubmit()
          return
        }
        e.preventDefault()
        if (autocomplete.type === 'command') {
          const item = autocomplete.items[selectedIndex]
          if (item) applyCommandCompletion(item)
        } else {
          const peer = autocomplete.items[selectedIndex]
          if (peer) applyMentionCompletion(peer, autocomplete.startIdx, autocomplete.endIdx)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSelectedIndex(0)
        return
      }
    }

    // Enter sends, Shift+Enter inserts newline
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
      return
    }

    // Recall previous sent message/command with ArrowUp when input is empty
    if (e.key === 'ArrowUp' && draft.length === 0 && history.length > 0) {
      e.preventDefault()
      const nextIdx = Math.min(historyIdx + 1, history.length - 1)
      setHistoryIdx(nextIdx)
      const recalled = history[nextIdx]
      if (recalled) {
        setDraft(recalled)
        setCursorPos(recalled.length)
      }
      return
    }

    if (e.key === 'Escape' && engine.replyingTo) {
      e.preventDefault()
      engine.setReplyingTo(null)
    }
  }

  const placeholder = !canSign
    ? engine.identity.signMode === 'extension'
      ? 'No NIP-07 extension detected — switch to Auto in Identity tab…'
      : 'Enter a valid nsec key in Identity tab to transmit…'
    : isDm && dmThread
      ? `Encrypted DM to ${dmThread.peerDisplayHandle}…`
      : `Transmit to #${engine.activeGeohash}… (/ for commands, @ to mention)`

  const hasBanner = Boolean(engine.replyingTo && !isDm) || isDm

  return (
    <div className="ag-composer-dock">
      <div className="ag-composer-inner">
        {/* Slash Command Autocomplete Popup */}
        {autocomplete.type === 'command' && (
          <div className="ag-autocomplete-popup" role="listbox" aria-label="Slash commands">
            <div className="ag-ac-head">
              <span>Slash Commands</span>
              <span>Tab / Enter to complete</span>
            </div>
            {autocomplete.items.map((cmd, idx) => (
              <button
                key={cmd.name}
                type="button"
                role="option"
                aria-selected={idx === selectedIndex}
                className={`ag-ac-item ${idx === selectedIndex ? 'selected' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  applyCommandCompletion(cmd)
                }}
              >
                <div className="ag-ac-left">
                  <span className="ag-ac-cmd">/{cmd.name}</span>
                  <span className="ag-ac-usage">{cmd.usage.replace(`/${cmd.name}`, '').trim()}</span>
                </div>
                <span className="ag-ac-desc">{cmd.description}</span>
              </button>
            ))}
          </div>
        )}

        {/* @Mention Peer Autocomplete Popup */}
        {autocomplete.type === 'mention' && (
          <div className="ag-autocomplete-popup" role="listbox" aria-label="Mention active peer">
            <div className="ag-ac-head">
              <span>Active Peers in #{engine.activeGeohash}</span>
              <span>Tab / Enter to mention</span>
            </div>
            {autocomplete.items.map((peer, idx) => (
              <button
                key={peer.pubkey}
                type="button"
                role="option"
                aria-selected={idx === selectedIndex}
                className={`ag-ac-item ${idx === selectedIndex ? 'selected' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  applyMentionCompletion(peer, autocomplete.startIdx, autocomplete.endIdx)
                }}
              >
                <div className="ag-ac-left">
                  <img
                    src={identiconDataUrl(peer.pubkey)}
                    alt=""
                    className="ag-avatar-sm"
                    style={{ width: 22, height: 22, borderRadius: 6 }}
                  />
                  <span style={{ fontWeight: 600, color: pubkeyToColor(peer.pubkey) }}>
                    {peer.displayHandle}
                  </span>
                </div>
                <span className="ag-ac-desc mono">
                  {peer.isOnline
                    ? 'online'
                    : `${peer.messageCount} ${peer.messageCount === 1 ? 'msg' : 'msgs'}`}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Contextual Reply or Encrypted DM Banner */}
        {!isDm && engine.replyingTo && (
          <div className="ag-composer-banner">
            <div className="ag-composer-banner-left">
              <CornerUpLeft size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span className="truncate">
                Replying to{' '}
                <strong style={{ color: 'var(--text-primary)' }}>
                  {engine.replyingTo.displayHandle}
                </strong>
                : {engine.replyingTo.content.slice(0, 72)}
              </span>
            </div>
            <button
              type="button"
              className="ag-icon-btn"
              style={{ height: 22, minWidth: 22 }}
              onClick={() => engine.setReplyingTo(null)}
              aria-label="Cancel reply"
            >
              <X size={13} />
            </button>
          </div>
        )}

        {isDm && dmThread && (
          <div className="ag-composer-banner dm">
            <div className="ag-composer-banner-left">
              <Lock size={12} style={{ flexShrink: 0 }} />
              <span className="mono" style={{ fontSize: 11 }}>
                Encrypted ({dmThread.protocol === 'bitchat' ? 'Bitchat v2 XChaCha20' : 'NIP-17 Gift-Wrap'})
              </span>
            </div>
            <span className="mono" style={{ fontSize: 10.5, opacity: 0.85 }}>
              {dmThread.peerDisplayHandle}
            </span>
          </div>
        )}

        {/* Composer Input Capsule */}
        <form
          className={`ag-composer-box ${hasBanner ? 'with-banner' : ''} ${isDm ? 'dm' : ''}`}
          onSubmit={(e) => {
            e.preventDefault()
            void handleSubmit()
          }}
        >
          {!isDm && (
            <button
              type="button"
              className="ag-icon-btn"
              onClick={() => {
                setDraft((prev) => (prev.startsWith('/') ? prev : '/' + prev))
                setCursorPos(1)
                textareaRef.current?.focus()
              }}
              title="Insert slash command (/)"
              aria-label="Insert slash command"
              style={{ marginBottom: 2 }}
            >
              <Terminal size={16} />
            </button>
          )}

          <textarea
            ref={textareaRef}
            className="ag-composer-input"
            rows={1}
            value={draft}
            disabled={!canSign}
            placeholder={placeholder}
            onChange={(e) => {
              setDraft(e.target.value)
              setCursorPos(e.target.selectionStart ?? e.target.value.length)
            }}
            onClick={(e) => setCursorPos(e.currentTarget.selectionStart ?? draft.length)}
            onKeyUp={(e) => setCursorPos(e.currentTarget.selectionStart ?? draft.length)}
            onKeyDown={handleKeyDown}
            aria-label={placeholder}
          />

          <button
            type="submit"
            className={`ag-send-btn ${isDm ? 'dm' : ''}`}
            disabled={!draft.trim() || engine.sending || !canSign}
            aria-label="Send message"
          >
            {engine.sending ? (
              <Loader2 size={15} style={{ animation: 'ag-spin 1s linear infinite' }} />
            ) : (
              <Send size={15} />
            )}
            <span className="ag-desktop-only">{engine.sending ? 'TX…' : 'Send'}</span>
          </button>
        </form>

        {/* Subtle Tactical Telemetry Footer */}
        <div className="ag-composer-hint-row">
          <span>
            {isDm
              ? 'Enter to send encrypted DM · Shift+Enter for newline'
              : 'Enter to broadcast · /nick · /j #geo · /drop · /slap · ⌘K palette'}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.55rem' }}>
            {engine.settings.powEnabled && !isDm && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <Cpu size={10} />
                NIP-13 {engine.settings.powTargetBits}b PoW
              </span>
            )}
            {draft.length > 180 && <span className="tabular">{draft.length} chars</span>}
          </span>
        </div>
      </div>
    </div>
  )
}

export default Composer
