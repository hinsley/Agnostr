import React, { useState } from 'react'
import {
  AlertCircle,
  Check,
  CheckCheck,
  Copy,
  CornerUpLeft,
  Loader2,
  Radio,
  ShieldCheck,
  Smile,
  Trash2,
} from 'lucide-react'
import type { GeoMessage, ImageAttachment, VoiceMemoAttachment } from '../types/protocol'
import { identiconDataUrl, pubkeyToColor, formatHandle } from '../utils/identicon'
import { RichMessageContent } from '../utils/markdown'
import { VoiceMemoPlayer } from './VoiceMemoPlayer'
import { ImageAttachmentCard, type LightboxImagePayload } from './ImageAttachmentCard'

function extractMediaCaption(
  content: string,
  voiceUrl?: string,
  imageUrl?: string
): string {
  let text = content.trim()
  if (!text) return ''
  for (const rawUrl of [voiceUrl, imageUrl]) {
    const target = rawUrl?.trim()
    if (!target) continue
    if (text === target) return ''
    text = text.split(target).join('')
  }
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

const QUICK_EMOJIS = ['❤️', '👍', '🔥', '😂', '👀', '⚡']

function formatClock(unixSec: number): string {
  try {
    const d = new Date(unixSec * 1000)
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
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
  actionsRevealed: boolean
  highlightQuery?: string
  showBridgeBadges: boolean
  isDmMode?: boolean
  isEncryptedContext?: boolean
  isSenderTrusted: boolean
  isSenderExplicitlyTrusted: boolean
  fetchVoiceMemoBlob: (memo: VoiceMemoAttachment, senderPubkey: string) => Promise<string>
  fetchImageAttachmentBlob: (image: ImageAttachment, senderPubkey: string) => Promise<string>
  onOpenLightbox: (payload: LightboxImagePayload) => void
  onToggleActions: (messageId: string | null) => void
  onTrustSender: (pubkey: string, nickname: string) => void
  onBlockSender: (pubkey: string, displayHandle: string) => void
  onReply?: (message: GeoMessage) => void
  onReact?: (message: GeoMessage, emoji: string) => void
  onDelete?: (message: GeoMessage) => void
  onInspectAuthor?: (pubkey: string, nickname: string) => void
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
    actionsRevealed,
    highlightQuery,
    showBridgeBadges,
    isDmMode = false,
    isEncryptedContext = false,
    isSenderTrusted,
    isSenderExplicitlyTrusted,
    fetchVoiceMemoBlob,
    fetchImageAttachmentBlob,
    onOpenLightbox,
    onToggleActions,
    onTrustSender,
    onBlockSender,
    onReply,
    onReact,
    onDelete,
    onInspectAuthor,
    onTuneGeohash,
    onClickMention,
    onJumpToMessage,
    onCopyText,
  }) => {
    const [pickerOpen, setPickerOpen] = useState(false)
    const [copied, setCopied] = useState(false)

    // System notice pill (centered, calm)
    if (message.isSystem) {
      return (
        <div
          id={`msg-${message.id}`}
          className={`ag-msg-system ${isLive ? 'is-live' : ''} ${isSearchActive ? 'is-search-active' : ''}`}
          role="note"
        >
          <div className="ag-msg-system-card">
            <RichMessageContent
              content={message.content}
              onTuneGeohash={onTuneGeohash}
              onClickMention={onClickMention}
              highlightQuery={highlightQuery}
            />
            <span className="ag-msg-system-time tabular" title={formatFullTimestamp(message.createdAt)}>
              {formatClock(message.createdAt)}
            </span>
          </div>
        </div>
      )
    }

    const handle = formatHandle(message.nickname, message.pubkey)
    const authorColor = pubkeyToColor(message.pubkey)
    const visibleContent =
      message.voiceMemo || message.imageAttachment
        ? extractMediaCaption(
            message.content,
            message.voiceMemo?.url,
            message.imageAttachment?.url
          )
        : message.content

    const handleCopy = () => {
      const toCopy = visibleContent || message.content
      navigator.clipboard?.writeText(toCopy).catch(() => {})
      onCopyText?.(toCopy)
      setCopied(true)
      onToggleActions(null)
      window.setTimeout(() => setCopied(false), 1200)
    }

    const handleBubbleClick = (e: React.MouseEvent<HTMLDivElement>) => {
      // Never intercept clicks on links, buttons, images, audio controls, or waveforms
      const target = e.target as HTMLElement | null
      if (
        target?.closest(
          'button, a, img, audio, input, .ag-voice-waveform, .ag-codeblock-copy, .ag-nostr-chip'
        )
      ) {
        return
      }
      // Don't toggle if user is highlighting text
      const sel = window.getSelection?.()
      if (sel && sel.toString().length > 0) return

      onToggleActions(actionsRevealed ? null : message.id)
    }

    const showIncomingHeader = !message.isOwn && !grouped && !isDmMode
    const hasMediaOnly =
      Boolean(message.imageAttachment || message.voiceMemo) && visibleContent.length === 0

    const rowClasses = [
      'ag-msg-row',
      message.isOwn ? 'is-own' : 'is-other',
      grouped ? 'grouped' : '',
      isLive ? 'is-live' : '',
      message.isEmote ? 'is-emote' : '',
      isMentioned ? 'is-mentioned' : '',
      isSearchActive ? 'is-search-active' : '',
      actionsRevealed || pickerOpen ? 'actions-open' : '',
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <article id={`msg-${message.id}`} className={rowClasses}>
        {/* Left Avatar Gutter — Incoming Messages Only (32px circular, once per group) */}
        {!message.isOwn && (
          <div className="ag-msg-gutter">
            {!grouped ? (
              <button
                type="button"
                className="ag-msg-avatar-btn"
                onClick={() => onInspectAuthor?.(message.pubkey, handle.base)}
                title={`View ${handle.full}`}
                aria-label={`View ${handle.full}`}
              >
                <img
                  src={identiconDataUrl(message.pubkey)}
                  alt=""
                  className="ag-bubble-avatar"
                  loading="lazy"
                />
              </button>
            ) : (
              <span className="ag-bubble-avatar-spacer" aria-hidden="true" />
            )}
          </div>
        )}

        {/* Bubble Column (Bubble + Floating Action Pill + Reactions) */}
        <div className="ag-msg-col">
          <div className="ag-msg-bubble-wrap">
            <div
              className={`ag-bubble ${message.isOwn ? 'own' : 'other'} ${isEncryptedContext ? 'encrypted' : ''} ${grouped ? 'grouped' : ''} ${hasMediaOnly ? 'media-only' : ''}`}
              onClick={handleBubbleClick}
            >
              {/* Clean Sender Header on First Incoming Bubble in Group Rooms */}
              {showIncomingHeader && (
                <div className="ag-bubble-sender-row">
                  <button
                    type="button"
                    className="ag-bubble-sender"
                    style={{ color: authorColor }}
                    onClick={() => onInspectAuthor?.(message.pubkey, handle.base)}
                    title={handle.full}
                  >
                    <span>{handle.base}</span>
                  </button>

                  {isSenderExplicitlyTrusted && (
                    <span
                      className="ag-trusted-shield-icon"
                      title={`Trusted peer (${handle.full})`}
                      aria-label="Trusted peer"
                    >
                      <ShieldCheck size={12} />
                    </span>
                  )}

                  {showBridgeBadges && message.isMeshBridge && (
                    <span
                      className="ag-mesh-inline-icon"
                      title={
                        message.bridgeClient
                          ? `Bridged via ${message.bridgeClient}`
                          : 'Bridged from radio mesh'
                      }
                      aria-label="Mesh bridge"
                    >
                      <Radio size={11} />
                    </span>
                  )}
                </div>
              )}

              {/* Threaded Reply Quote */}
              {message.replyTo && (
                <button
                  type="button"
                  className="ag-reply-quote"
                  onClick={() => message.replyTo && onJumpToMessage?.(message.replyTo.id)}
                  title="Jump to replied message"
                >
                  <span className="ag-reply-quote-author">
                    {message.replyTo.nickname
                      ? message.replyTo.nickname
                      : message.replyTo.pubkey
                        ? `#${message.replyTo.pubkey.slice(-4)}`
                        : 'Reply'}
                  </span>
                  <span className="ag-reply-quote-text">
                    {message.replyTo.preview || 'Referenced message'}
                  </span>
                </button>
              )}

              {/* Voice Memo Player / Untrusted Shielded Card */}
              {message.voiceMemo && (
                <VoiceMemoPlayer
                  memo={message.voiceMemo}
                  senderPubkey={message.pubkey}
                  senderNickname={handle.base}
                  senderDisplayHandle={handle.full}
                  isTrusted={isSenderTrusted}
                  isDmMode={isEncryptedContext}
                  fetchVoiceMemoBlob={fetchVoiceMemoBlob}
                  onTrustSender={onTrustSender}
                  onInspectSender={(pk, nick) => onInspectAuthor?.(pk, nick)}
                  onBlockSender={onBlockSender}
                />
              )}

              {/* Image Attachment / Untrusted Shielded Card */}
              {message.imageAttachment && (
                <ImageAttachmentCard
                  image={message.imageAttachment}
                  senderPubkey={message.pubkey}
                  senderNickname={handle.base}
                  senderDisplayHandle={handle.full}
                  isTrusted={isSenderTrusted}
                  isDmMode={isEncryptedContext}
                  caption={visibleContent || undefined}
                  fetchImageAttachmentBlob={fetchImageAttachmentBlob}
                  onTrustSender={onTrustSender}
                  onInspectSender={(pk, nick) => onInspectAuthor?.(pk, nick)}
                  onBlockSender={onBlockSender}
                  onOpenLightbox={onOpenLightbox}
                />
              )}

              {/* Message Text Body */}
              {visibleContent.length > 0 && (
                <RichMessageContent
                  content={visibleContent}
                  onTuneGeohash={onTuneGeohash}
                  onClickMention={onClickMention}
                  highlightQuery={highlightQuery}
                />
              )}

              {/* Subtle Bottom-Right Inline Timestamp + Delivery Check */}
              <div className="ag-bubble-meta">
                <time
                  className="ag-bubble-time tabular"
                  dateTime={new Date(message.createdAt * 1000).toISOString()}
                  title={formatFullTimestamp(message.createdAt)}
                >
                  {formatClock(message.createdAt)}
                </time>

                {message.isOwn && message.deliveryStatus && (
                  <span
                    className={`ag-bubble-delivery ${message.deliveryStatus}`}
                    title={
                      message.deliveryStatus === 'sending'
                        ? 'Sending…'
                        : message.deliveryStatus === 'failed'
                          ? 'Failed to send'
                          : message.relayCount
                            ? `Sent to ${message.relayCount} relay${message.relayCount === 1 ? '' : 's'}`
                            : 'Sent'
                    }
                  >
                    {message.deliveryStatus === 'sending' && (
                      <Loader2 size={11} className="ag-spin" />
                    )}
                    {message.deliveryStatus === 'sent' &&
                      (message.relayCount && message.relayCount > 1 ? (
                        <CheckCheck size={13} />
                      ) : (
                        <Check size={13} />
                      ))}
                    {message.deliveryStatus === 'failed' && <AlertCircle size={12} />}
                  </span>
                )}
              </div>
            </div>

            {/* Hover (Desktop) / Tap-to-Reveal (Mobile) Floating Action Pill */}
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
                    title="React"
                    aria-label="Add reaction"
                  >
                    <Smile size={15} />
                  </button>
                  {pickerOpen && (
                    <div
                      className={`ag-emoji-popover ${message.isOwn ? 'own' : 'other'}`}
                      role="menu"
                    >
                      {QUICK_EMOJIS.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          className="ag-emoji-opt"
                          onClick={() => {
                            onReact(message, emoji)
                            setPickerOpen(false)
                            onToggleActions(null)
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
                  onClick={() => {
                    onReply(message)
                    onToggleActions(null)
                  }}
                  title="Reply"
                  aria-label="Reply to message"
                >
                  <CornerUpLeft size={15} />
                </button>
              )}

              <button
                type="button"
                className="ag-msg-act-btn"
                onClick={handleCopy}
                title={copied ? 'Copied' : 'Copy'}
                aria-label="Copy message"
              >
                {copied ? (
                  <Check size={15} style={{ color: 'var(--status-ok)' }} />
                ) : (
                  <Copy size={15} />
                )}
              </button>

              {onDelete && (
                <button
                  type="button"
                  className="ag-msg-act-btn danger"
                  onClick={() => {
                    onDelete(message)
                    onToggleActions(null)
                  }}
                  title="Delete"
                  aria-label="Delete message"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </div>

          {/* Aggregated Emoji Reactions */}
          {!isDmMode && message.reactions.length > 0 && (
            <div
              className={`ag-reactions ${message.isOwn ? 'own' : 'other'}`}
              role="group"
              aria-label="Message reactions"
            >
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
      </article>
    )
  }
)

MessageItem.displayName = 'MessageItem'

export default MessageItem
