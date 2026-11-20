import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CornerUpLeft,
  Cpu,
  Loader2,
  Lock,
  Mic,
  Send,
  Terminal,
  X,
} from 'lucide-react'
import type {
  AgnostrEngine,
  RecordedVoiceMemo,
  SlashCommandDef,
} from '../types/protocol'
import { formatVoiceDuration, isVoiceRecordingSupported } from '../lib/voiceRecorder'
import { identiconDataUrl, pubkeyToColor } from '../utils/identicon'
import { VoiceRecorderBar } from './VoiceRecorderBar'

export interface ComposerProps {
  engine: AgnostrEngine
  externalDraftToken: { id: number; text: string } | null
  onSent?: (isDm: boolean) => void
}

interface MentionCandidate {
  pubkey: string
  nickname: string
  displayHandle: string
  subtitle: string
}

type AutocompleteMode =
  | { type: 'none' }
  | { type: 'command'; query: string; items: SlashCommandDef[] }
  | { type: 'mention'; query: string; startIdx: number; endIdx: number; items: MentionCandidate[] }

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
  const [voiceMode, setVoiceMode] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const voiceSupported = useMemo(() => isVoiceRecordingSupported(), [])
  const isDm = engine.activeView.type === 'dm' && engine.activeDmThread !== null
  const isServer =
    engine.activeView.type === 'server' &&
    engine.servers.activeServer !== null &&
    engine.servers.activeChannel !== null
  const dmThread = engine.activeDmThread
  const activeServer = engine.servers.activeServer
  const activeChannel = engine.servers.activeChannel
  const isServerE2ee = Boolean(isServer && activeServer?.encrypted)
  const isViolet = isDm || isServerE2ee
  const isSending = isServer ? engine.servers.sending : engine.sending
  const activeReply = isServer ? engine.servers.replyingTo : !isDm ? engine.replyingTo : null
  const activeTargetKey = isDm
    ? `dm:${dmThread?.peerPubkey ?? ''}`
    : isServer
      ? `srv:${activeServer?.id ?? ''}:${activeChannel?.id ?? ''}`
      : `ch:${engine.activeGeohash}`

  // Immediately tear down voice recorder (stops mic & revokes preview URL) on Panic Wipe,
  // key rotation, or switching target channel/DM so audio never leaks across contexts.
  const prevMasterPkRef = useRef(engine.identity.masterPubkey)
  const prevTargetKeyRef = useRef(activeTargetKey)
  useEffect(() => {
    const pkChanged = prevMasterPkRef.current !== engine.identity.masterPubkey
    const targetChanged = prevTargetKeyRef.current !== activeTargetKey
    prevMasterPkRef.current = engine.identity.masterPubkey
    prevTargetKeyRef.current = activeTargetKey
    if (pkChanged || targetChanged) {
      setVoiceMode(false)
    }
  }, [engine.identity.masterPubkey, activeTargetKey])

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
    // Slash commands only in geohash channel mode (never leak private server text to geo commands)
    if (!isDm && !isServer && draft.startsWith('/') && !draft.includes('\n')) {
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

    // @mention lookup before cursor (geohash peers OR server members)
    const beforeCursor = draft.slice(0, cursorPos)
    const mentionMatch = /(?:^|\s)@([a-zA-Z0-9_.-]{0,24})$/.exec(beforeCursor)
    if (mentionMatch && !isDm) {
      const q = mentionMatch[1].toLowerCase()
      const startIdx = beforeCursor.length - mentionMatch[1].length - 1
      const pool: MentionCandidate[] = isServer
        ? engine.servers.members
            .filter((m) => !m.isSelf && !m.isBanned)
            .map((m) => ({
              pubkey: m.pubkey,
              nickname: m.nickname,
              displayHandle: m.displayHandle,
              subtitle: m.isFounder ? 'founder' : m.isAdmin ? 'admin' : m.roles[0] || 'member',
            }))
        : engine.peers
            .filter((p) => !p.isSelf && !p.isBlocked)
            .map((p) => ({
              pubkey: p.pubkey,
              nickname: p.nickname,
              displayHandle: p.displayHandle,
              subtitle: p.isOnline
                ? 'online'
                : `${p.messageCount} ${p.messageCount === 1 ? 'msg' : 'msgs'}`,
            }))

      const candidates = pool
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
  }, [draft, cursorPos, engine.commands, engine.peers, engine.servers.members, isDm, isServer])

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

  const applyMentionCompletion = (peer: MentionCandidate, startIdx: number, endIdx: number) => {
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
    if (!trimmed || isSending || !canSign) return

    setHistory((prev) => [trimmed, ...prev.filter((x) => x !== trimmed)].slice(0, 30))
    setHistoryIdx(-1)
    setDraft('')

    let ok = false
    if (isServer) {
      if (trimmed.toLowerCase() === '/clear') {
        engine.servers.clearChannelCache()
        ok = true
      } else if (/^\/me\s+/i.test(trimmed)) {
        const action = trimmed.replace(/^\/me\s+/i, '').trim()
        ok = action
          ? await engine.servers.sendMessage(`* ${engine.identity.nickname} ${action} *`)
          : false
      } else {
        ok = await engine.servers.sendMessage(trimmed)
      }
    } else if (isDm && dmThread && !trimmed.startsWith('/')) {
      ok = await engine.sendDirectMessage(dmThread.peerPubkey, trimmed, dmThread.protocol)
    } else {
      ok = await engine.sendInput(trimmed)
    }

    if (ok) {
      onSent?.(isViolet)
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

    if (e.key === 'Escape' && activeReply) {
      e.preventDefault()
      if (isServer) engine.servers.setReplyingTo(null)
      else engine.setReplyingTo(null)
    }
  }

  const handleCancelVoice = useCallback(() => {
    setVoiceMode(false)
  }, [])

  const { pushToast } = engine
  const handleVoiceErrorToast = useCallback(
    (title: string, detail?: string) => {
      pushToast('warning', title, detail)
    },
    [pushToast]
  )

  const handleSendVoiceMemo = async (
    recorded: RecordedVoiceMemo,
    caption: string
  ): Promise<boolean> => {
    const ok = isServer
      ? await engine.servers.sendVoiceMemo(recorded, caption)
      : await engine.sendVoiceMemo(recorded, caption)
    if (ok) {
      onSent?.(isViolet)
    }
    return ok
  }

  const replyPreviewText = useMemo(() => {
    const target = activeReply
    if (!target) return ''
    if (target.voiceMemo) {
      const stripped = target.content.split(target.voiceMemo.url).join('').trim()
      if (stripped) return stripped.slice(0, 72)
      return `Voice memo (${formatVoiceDuration(target.voiceMemo.durationSec)})`
    }
    return target.content.slice(0, 72)
  }, [activeReply])

  const placeholder = !canSign
    ? engine.identity.signMode === 'extension'
      ? 'No NIP-07 extension detected — switch to Auto in Identity tab…'
      : 'Enter a valid nsec key in Identity tab to transmit…'
    : isDm && dmThread
      ? `Encrypted DM to ${dmThread.peerDisplayHandle}…`
      : isServer && activeServer && activeChannel
        ? isServerE2ee
          ? `Encrypted message to #${activeChannel.name} in ${activeServer.name}…`
          : `Message #${activeChannel.name} in ${activeServer.name}… (@ to mention)`
        : `Transmit to #${engine.activeGeohash}… (/ for commands, @ to mention)`

  const hasBanner = Boolean(activeReply) || isDm || isServerE2ee

  return (
    <div className="ag-composer-dock">
      <div className="ag-composer-inner">
        {/* Slash Command Autocomplete Popup */}
        {!voiceMode && autocomplete.type === 'command' && (
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
        {!voiceMode && autocomplete.type === 'mention' && (
          <div className="ag-autocomplete-popup" role="listbox" aria-label="Mention active peer">
            <div className="ag-ac-head">
              <span>
                {isServer && activeServer
                  ? `Members in ${activeServer.name}`
                  : `Active Peers in #${engine.activeGeohash}`}
              </span>
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
                <span className="ag-ac-desc mono">{peer.subtitle}</span>
              </button>
            ))}
          </div>
        )}

        {/* Contextual Encrypted Server / DM Banner */}
        {isServer && isServerE2ee && activeServer && activeChannel && (
          <div className={`ag-composer-banner dm ${activeReply ? 'has-next-banner' : ''}`}>
            <div className="ag-composer-banner-left">
              <Lock size={12} style={{ flexShrink: 0 }} />
              <span className="mono truncate" style={{ fontSize: 11 }}>
                E2EE Server · AES-256-GCM
              </span>
              <span
                className="ag-badge dm ag-e2ee-voice-pill"
                title="Voice memos in this E2EE server are encrypted client-side with AES-256-GCM before upload"
              >
                <Mic size={9} />
                E2EE VOICE
              </span>
            </div>
            <span className="mono ag-hide-xs" style={{ fontSize: 10.5, opacity: 0.85, flexShrink: 0 }}>
              #{activeChannel.name}
            </span>
          </div>
        )}

        {/* Contextual Reply Banner (Geohash Channels & Servers) */}
        {activeReply && (
          <div className={`ag-composer-banner ${isServerE2ee ? 'stacked' : ''}`}>
            <div className="ag-composer-banner-left">
              <CornerUpLeft size={13} style={{ color: isServerE2ee ? 'var(--dm-accent)' : 'var(--accent)', flexShrink: 0 }} />
              <span className="truncate">
                Replying to{' '}
                <strong style={{ color: 'var(--text-primary)' }}>
                  {activeReply.displayHandle}
                </strong>
                : {replyPreviewText}
              </span>
            </div>
            <button
              type="button"
              className="ag-icon-btn"
              style={{ height: 22, minWidth: 22 }}
              onClick={() =>
                isServer ? engine.servers.setReplyingTo(null) : engine.setReplyingTo(null)
              }
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
              <span className="mono truncate" style={{ fontSize: 11 }}>
                Encrypted ({dmThread.protocol === 'bitchat' ? 'Bitchat v2 XChaCha20' : 'NIP-17 Gift-Wrap'})
              </span>
              <span
                className="ag-badge dm ag-e2ee-voice-pill"
                title="DM voice memos are encrypted client-side with AES-256-GCM before Blossom upload"
              >
                <Mic size={9} />
                E2EE VOICE
              </span>
            </div>
            <span className="mono ag-hide-xs" style={{ fontSize: 10.5, opacity: 0.85, flexShrink: 0 }}>
              {dmThread.peerDisplayHandle}
            </span>
          </div>
        )}

        {/* Composer Input Capsule OR Tactical Voice Recorder Bar */}
        {voiceMode ? (
          <VoiceRecorderBar
            isDm={isViolet}
            hasBanner={hasBanner}
            sending={isSending}
            voiceSendPhase={engine.voiceSendPhase}
            onSend={handleSendVoiceMemo}
            onCancel={handleCancelVoice}
            onErrorToast={handleVoiceErrorToast}
          />
        ) : (
          <form
            className={`ag-composer-box ${hasBanner ? 'with-banner' : ''} ${isViolet ? 'dm' : ''}`}
            onSubmit={(e) => {
              e.preventDefault()
              void handleSubmit()
            }}
          >
            {!isDm && !isServer && (
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
              type="button"
              className={`ag-mic-btn ${isViolet ? 'dm' : ''}`}
              disabled={!voiceSupported || !canSign || isSending}
              onClick={() => setVoiceMode(true)}
              title={
                !voiceSupported
                  ? 'Voice memos require microphone & MediaRecorder support in this browser'
                  : !canSign
                    ? 'Configure a signing key in Identity tab to record voice memos'
                    : isViolet
                      ? 'Record E2EE voice memo (AES-256-GCM)'
                      : isServer && activeChannel
                        ? `Record voice memo for #${activeChannel.name}`
                        : `Record voice memo to #${engine.activeGeohash}`
              }
              aria-label={isViolet ? 'Record encrypted voice memo' : 'Record voice memo'}
            >
              <Mic size={16} />
            </button>

            <button
              type="submit"
              className={`ag-send-btn ${isViolet ? 'dm' : ''}`}
              disabled={!draft.trim() || isSending || !canSign}
              aria-label="Send message"
            >
              {isSending ? (
                <Loader2 size={15} style={{ animation: 'ag-spin 1s linear infinite' }} />
              ) : (
                <Send size={15} />
              )}
              <span className="ag-desktop-only">{isSending ? 'TX…' : 'Send'}</span>
            </button>
          </form>
        )}

        {/* Subtle Tactical Telemetry Footer */}
        <div className="ag-composer-hint-row">
          <span>
            {voiceMode
              ? isViolet
                ? 'AES-256-GCM E2EE audio · Up to 1:30 · Esc to discard'
                : 'Blossom voice memo · Up to 1:30 · Esc to discard'
              : isDm
                ? 'Enter to send encrypted DM · Mic for E2EE voice · Shift+Enter for newline'
                : isServer && activeServer
                  ? isServerE2ee
                    ? 'Enter to send E2EE message · Mic for E2EE voice · @ to mention · ⌘K palette'
                    : `Enter to send to ${activeServer.name} · Mic for voice · @ to mention · ⌘K palette`
                  : 'Enter to broadcast · Mic for voice · /trust · /strict · /j #geo · ⌘K palette'}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.55rem' }}>
            {engine.settings.powEnabled && !isDm && !(isServer && activeServer?.kind === 'nip29') && (
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
