import React, { useState } from 'react'
import {
  Check,
  CheckCheck,
  Compass,
  Copy,
  CornerUpLeft,
  Cpu,
  Lock,
  Radio,
  Smile,
  User,
  AlertCircle,
  Loader2,
} from 'lucide-react'
import type { GeoMessage } from '../types/protocol'
import { identiconDataUrl, pubkeyToColor, formatHandle } from '../utils/identicon'
import { RichMessageContent } from '../utils/markdown'

const QUICK_EMOJIS = ['⚡', '🔥', '👍', '👀', '🫡', '❤️']

function formatClock(unixSec: number): string {
  try {
    const d = new Date(unixSec * 1000)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function formatFullTimestamp(unixSec: number): string {
  try {
    return new Date(unixSec * 1000).toLocaleString()
  } catch {
    return ''
  }
}

export interface MessageItemProps {
  message: GeoMessage
  grouped: boolean
  isLive: boolean
  isMentioned: boolean
  isSearchActive: boolean
  highlightQuery?: string
  showBridgeBadges: boolean
  isDmMode?: boolean
  dmProtocolLabel?: string
  onReply?: (message: GeoMessage) => void
  onReact?: (message: GeoMessage, emoji: string) => void
  onInspectAuthor?: (pubkey: string, nickname: string) => void
  onStartDm?: (pubkey: string, nickname?: string) => void
  onTuneGeohash?: (geohash: string) => void
  onClickMention?: (mention: string) => void
  onJumpToMessage?: (messageId: string) => void
  onCopyText?: (text: string) => void
}

export const MessageItem: React.FC<MessageItemProps> = React.memo(
  ({
    message,
    grouped,
    isLive,
    isMentioned,
    isSearchActive,
    highlightQuery,
    showBridgeBadges,
    isDmMode = false,
    dmProtocolLabel,
    onReply,
    onReact,
    onInspectAuthor,
    onStartDm,
    onTuneGeohash,
    onClickMention,
    onJumpToMessage,
    onCopyText,
  }) => {
    const [pickerOpen, setPickerOpen] = useState(false)
    const [copied, setCopied] = useState(false)

    // System telemetry notice row (e.g. /who, /help, /clear feedback)
    if (message.isSystem) {
      return (
        <div
          id={`msg-${message.id}`}
          className={`ag-msg-row is-system ${isLive ? 'is-live' : ''} ${isSearchActive ? 'is-search-active' : ''}`}
          role="note"
        >
          <div className="ag-msg-body">
            <div className="ag-msg-head" style={{ marginBottom: 2 }}>
              <span className="ag-badge accent">SYSTEM</span>
              <span className="ag-msg-time" title={formatFullTimestamp(message.createdAt)}>
                {formatClock(message.createdAt)}
              </span>
            </div>
            <RichMessageContent
              content={message.content}
              onTuneGeohash={onTuneGeohash}
              onClickMention={onClickMention}
              highlightQuery={highlightQuery}
            />
          </div>
        </div>
      )
    }

    const handle = formatHandle(message.nickname, message.pubkey)
    const authorColor = pubkeyToColor(message.pubkey)

    const handleCopy = () => {
      navigator.clipboard?.writeText(message.content).catch(() => {})
      onCopyText?.(message.content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    }

    const rowClasses = [
      'ag-msg-row',
      grouped ? 'grouped' : '',
      isLive ? 'is-live' : '',
      message.isOwn ? 'is-own' : '',
      message.isEmote ? 'is-emote' : '',
      isMentioned ? 'is-mentioned' : '',
      isSearchActive ? 'is-search-active' : '',
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <article id={`msg-${message.id}`} className={rowClasses}>
        {/* Left Avatar / Compact Hover Timestamp Gutter */}
        <div className="ag-msg-gutter">
          {grouped ? (
            <span className="ag-msg-hover-time tabular" title={formatFullTimestamp(message.createdAt)}>
              {formatClock(message.createdAt)}
            </span>
          ) : (
            <button
              type="button"
              className="ag-msg-avatar-btn"
              onClick={() => onInspectAuthor?.(message.pubkey, handle.base)}
              title={`Inspect ${handle.full}`}
              aria-label={`Inspect ${handle.full}`}
            >
              <img
                src={identiconDataUrl(message.pubkey)}
                alt=""
                className="ag-avatar-md"
                loading="lazy"
              />
            </button>
          )}
        </div>

        {/* Message Main Body */}
        <div className="ag-msg-body">
          {!grouped && (
            <div className="ag-msg-head">
              <button
                type="button"
                className="ag-msg-author"
                style={{ color: authorColor }}
                onClick={() => onInspectAuthor?.(message.pubkey, handle.base)}
                title={`Click to inspect ${handle.full}`}
              >
                <span>@{handle.base}</span>
                <span className="ag-msg-author-suffix">#{handle.suffix}</span>
              </button>

              {message.isOwn && <span className="ag-badge accent">YOU</span>}

              {isDmMode && dmProtocolLabel && (
                <span className="ag-badge dm">
                  <Lock size={9} />
                  {dmProtocolLabel}
                </span>
              )}

              {!isDmMode && message.isTeleported && (
                <span
                  className="ag-badge warn"
                  title="Sender is teleported into this geohash (Bitchat teleport tag)"
                >
                  <Compass size={9} />
                  TELEPORT
                </span>
              )}

              {!isDmMode && showBridgeBadges && message.isMeshBridge && (
                <span
                  className="ag-badge mesh"
                  title={
                    message.bridgeClient
                      ? `Bridged via ${message.bridgeClient}`
                      : 'Bridged from LoRa / Meshtastic radio mesh'
                  }
                >
                  <Radio size={9} />
                  MESH
                </span>
              )}

              {!isDmMode && message.powBits >= 8 && (
                <span
                  className="ag-badge muted"
                  title={`Verified NIP-13 Proof-of-Work (${message.powBits} leading zero bits)`}
                >
                  <Cpu size={9} />
                  {message.powBits}b
                </span>
              )}

              <time
                className="ag-msg-time tabular"
                dateTime={new Date(message.createdAt * 1000).toISOString()}
                title={formatFullTimestamp(message.createdAt)}
              >
                {formatClock(message.createdAt)}
              </time>

              {message.isOwn && message.deliveryStatus && (
                <span
                  className={`ag-msg-delivery ${message.deliveryStatus}`}
                  title={
                    message.deliveryStatus === 'sending'
                      ? 'Publishing to relays…'
                      : message.deliveryStatus === 'failed'
                        ? 'Failed to publish to any relay'
                        : message.relayCount
                          ? `Confirmed by ${message.relayCount} relay${message.relayCount === 1 ? '' : 's'}`
                          : 'Published'
                  }
                >
                  {message.deliveryStatus === 'sending' && (
                    <Loader2 size={11} style={{ animation: 'ag-spin 1s linear infinite' }} />
                  )}
                  {message.deliveryStatus === 'sent' &&
                    (message.relayCount && message.relayCount > 1 ? (
                      <CheckCheck size={12} style={{ color: 'var(--status-ok)' }} />
                    ) : (
                      <Check size={12} style={{ color: 'var(--status-ok)' }} />
                    ))}
                  {message.deliveryStatus === 'failed' && <AlertCircle size={12} />}
                </span>
              )}
            </div>
          )}

          {/* Threaded Reply Reference */}
          {message.replyTo && (
            <button
              type="button"
              className="ag-reply-quote"
              onClick={() => message.replyTo && onJumpToMessage?.(message.replyTo.id)}
              title="Jump to replied message"
            >
              <CornerUpLeft size={12} style={{ flexShrink: 0, color: 'var(--accent)' }} />
              <span className="ag-reply-quote-author">
                {message.replyTo.nickname
                  ? `@${message.replyTo.nickname}`
                  : message.replyTo.pubkey
                    ? `#${message.replyTo.pubkey.slice(-4)}`
                    : 'reply'}
              </span>
              <span className="ag-reply-quote-text">
                {message.replyTo.preview || 'Referenced transmission'}
              </span>
            </button>
          )}

          {/* Rich Content */}
          <RichMessageContent
            content={message.content}
            onTuneGeohash={onTuneGeohash}
            onClickMention={onClickMention}
            highlightQuery={highlightQuery}
          />

          {/* Aggregated Emoji Reactions */}
          {!isDmMode && message.reactions.length > 0 && (
            <div className="ag-reactions" role="group" aria-label="Message reactions">
              {message.reactions.map((rx) => (
                <button
                  key={rx.emoji}
                  type="button"
                  className={`ag-reaction-pill ${rx.reactedByMe ? 'mine' : ''}`}
                  onClick={() => onReact?.(message, rx.emoji)}
                  title={`React with ${rx.emoji}`}
                >
                  <span>{rx.emoji}</span>
                  <span className="ag-reaction-count tabular">{rx.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Floating Hover / Tap Action Bar */}
        <div
          className={`ag-msg-actions ${pickerOpen ? 'picker-open' : ''}`}
          role="toolbar"
          aria-label="Message actions"
        >
          {!isDmMode && onReact && (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="ag-msg-act-btn"
                onClick={() => setPickerOpen((v) => !v)}
                title="Add reaction"
                aria-label="Add reaction"
              >
                <Smile size={14} />
              </button>
              {pickerOpen && (
                <div className="ag-emoji-popover" role="menu">
                  {QUICK_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="ag-emoji-opt"
                      onClick={() => {
                        onReact(message, emoji)
                        setPickerOpen(false)
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {!isDmMode && onReply && (
            <button
              type="button"
              className="ag-msg-act-btn"
              onClick={() => onReply(message)}
              title="Reply to message"
              aria-label="Reply to message"
            >
              <CornerUpLeft size={14} />
            </button>
          )}

          <button
            type="button"
            className="ag-msg-act-btn"
            onClick={handleCopy}
            title={copied ? 'Copied!' : 'Copy message text'}
            aria-label="Copy message text"
          >
            {copied ? <Check size={14} style={{ color: 'var(--status-ok)' }} /> : <Copy size={14} />}
          </button>

          {!isDmMode && !message.isOwn && onStartDm && (
            <button
              type="button"
              className="ag-msg-act-btn"
              onClick={() => onStartDm(message.pubkey, handle.base)}
              title={`Encrypted DM with ${handle.full}`}
              aria-label={`Send DM to ${handle.full}`}
            >
              <Lock size={13} />
            </button>
          )}

          {onInspectAuthor && (
            <button
              type="button"
              className="ag-msg-act-btn"
              onClick={() => onInspectAuthor(message.pubkey, handle.base)}
              title={`Inspect ${handle.full}`}
              aria-label={`Inspect ${handle.full}`}
            >
              <User size={14} />
            </button>
          )}
        </div>
      </article>
    )
  }
)

MessageItem.displayName = 'MessageItem'

export default MessageItem
