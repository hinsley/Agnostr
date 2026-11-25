import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  AtSign,
  Ban,
  Captions,
  Check,
  CheckCheck,
  Copy,
  CornerUpLeft,
  ExternalLink,
  Hash,
  Image as ImageIcon,
  Languages,
  Link2,
  Loader2,
  Maximize2,
  MessageCircle,
  Phone,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Smile,
  Trash2,
  User,
  Video,
  Waves,
  Zap,
} from 'lucide-react'
import type { GeoMessage, ImageAttachment, VoiceMemoAttachment } from '../types/protocol'
import type { ContentFilterEngine } from '../types/contentFilter'
import type {
  MemoTranscriptState,
  TranscriptionModelStatus,
} from '../types/transcription'
import type { CashuTokenPreview, ZapReceiptSummary, ZapTarget } from '../types/wallet'
import { clientAvatarRingClass } from '../lib/bitchatProtocol'
import { decodeCashuTokenPreview, extractCashuTokensFromText } from '../lib/cashuWallet'
import { usePinnedReactions } from '../lib/reactionEmojis'
import { parseAgoraShareUrl } from '../lib/shareLinks'
import { copyImageToClipboard, isCopyableImageElement } from '../utils/clipboardImage'
import { pubkeyToColor, formatHandle } from '../utils/identicon'
import { RichMessageContent } from '../utils/markdown'
import { AvatarImg } from './AvatarImg'
import { useContextMenu, type ContextMenuItem, type ContextMenuReaction } from './ContextMenu'
import { ReactionPickerPopover } from './ReactionPickerPopover'
import { requestUntrustedLinkOpen, tryOpenInternalAgoraLink } from './UntrustedLinkModal'
import { VoiceMemoPlayer } from './VoiceMemoPlayer'
import { ImageAttachmentCard, type LightboxImagePayload } from './ImageAttachmentCard'
import { parseInlineChatVoice } from '../lib/inlineChatVoice'
import { parseInlineChatImage } from '../lib/inlineChatImage'

function formatMintHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./i, '')
  } catch {
    return url.slice(0, 28)
  }
}

function stripCashuTokens(text: string, tokens: readonly string[]): string {
  if (tokens.length === 0) return text
  let out = text
  for (const tok of tokens) {
    out = out.split(`cashu:${tok}`).join('').split(tok).join('')
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

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
  knownHandles?: readonly string[]
  showBridgeBadges: boolean
  allowUntrustedLinks?: boolean
  isDmMode?: boolean
  isEncryptedContext?: boolean
  isSenderTrusted: boolean
  isSenderExplicitlyTrusted: boolean
  canLoadVoiceMemo?: boolean
  fetchVoiceMemoBlob: (memo: VoiceMemoAttachment, senderPubkey: string) => Promise<string>
  fetchImageAttachmentBlob: (image: ImageAttachment, senderPubkey: string) => Promise<string>
  autoTranscribe?: boolean
  memoTranscript?: MemoTranscriptState
  transcriptionModelStatus?: TranscriptionModelStatus
  transcriptionDownloadProgress?: number
  activeTranscriptionModelLabel?: string
  onTranscribeMemo?: (
    memoKey: string,
    memo: VoiceMemoAttachment,
    senderPubkey: string
  ) => Promise<void> | void
  onOpenLightbox: (payload: LightboxImagePayload) => void
  onToggleActions: (messageId: string | null) => void
  onTrustSender: (pubkey: string, nickname: string) => void
  onUntrustSender?: (pubkey: string) => void
  onBlockSender: (pubkey: string, displayHandle: string) => void
  onStartDm?: (pubkey: string, nickname?: string) => void
  onStartCall?: (pubkey: string, mediaType: 'audio' | 'video', nickname?: string) => void
  onMentionAuthor?: (handle: string) => void
  onReply?: (message: GeoMessage) => void
  onReact?: (message: GeoMessage, emoji: string) => void
  resolveReactorName?: (pubkey: string) => string
  onDelete?: (message: GeoMessage) => void
  onInspectAuthor?: (pubkey: string, nickname: string) => void
  onTuneGeohash?: (geohash: string) => void
  onClickMention?: (mention: string) => void
  onJumpToMessage?: (messageId: string) => void
  onCopyText?: (text: string) => void
  onNotify?: (title: string) => void
  // On-device Image Content Filter
  contentFilter?: ContentFilterEngine
  // Verified kind: 0 profile picture URL (falls back to identicon)
  senderAvatarUrl?: string
  // Cashu Ecash, NIP-57 Lightning Zaps & NIP-61 Nutzaps
  senderLightningAddress?: string | null
  canZapSender?: boolean
  zapTotalSats?: number
  zapReceipts?: readonly ZapReceiptSummary[]
  onOpenZap?: (target: ZapTarget) => void
  onClaimCashuToken?: (token: string) => void
  // Single-Column Translator Mode overrides
  displayContentOverride?: string
  originalContentInlay?: string
  translationStatus?: 'idle' | 'pending' | 'loading' | 'done' | 'error'
  translationLoadingLabel?: string
  translationError?: string
  translationBadge?: string
  onRetryTranslation?: () => void
  compactTranslatorRow?: boolean
  underlyingCollapsed?: boolean
  isOriginalColumn?: boolean
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
    knownHandles,
    showBridgeBadges,
    allowUntrustedLinks = false,
    isDmMode = false,
    isEncryptedContext = false,
    isSenderTrusted,
    isSenderExplicitlyTrusted,
    canLoadVoiceMemo,
    fetchVoiceMemoBlob,
    fetchImageAttachmentBlob,
    autoTranscribe,
    memoTranscript,
    transcriptionModelStatus,
    transcriptionDownloadProgress,
    activeTranscriptionModelLabel,
    onTranscribeMemo,
    onOpenLightbox,
    onToggleActions,
    onTrustSender,
    onUntrustSender,
    onBlockSender,
    onStartDm,
    onStartCall,
    onMentionAuthor,
    onReply,
    onReact,
    resolveReactorName,
    onDelete,
    onInspectAuthor,
    onTuneGeohash,
    onClickMention,
    onJumpToMessage,
    onCopyText,
    onNotify,
    contentFilter,
    senderAvatarUrl,
    senderLightningAddress = null,
    canZapSender: canZapSenderProp,
    zapTotalSats = 0,
    zapReceipts,
    onOpenZap,
    onClaimCashuToken,
    displayContentOverride,
    originalContentInlay,
    translationStatus,
    translationLoadingLabel,
    translationError,
    translationBadge,
    onRetryTranslation,
    compactTranslatorRow = false,
    underlyingCollapsed = false,
    isOriginalColumn = false,
  }) => {
    const pinnedReactions = usePinnedReactions()
    const [pickerOpen, setPickerOpen] = useState(false)
    const [expandedPickerAnchor, setExpandedPickerAnchor] = useState<DOMRect | null>(null)
    const [copied, setCopied] = useState(false)
    const quickPickerWrapRef = useRef<HTMLDivElement | null>(null)
    const messageBodyRef = useRef<HTMLDivElement | null>(null)
    const [hoveredReaction, setHoveredReaction] = useState<{
      emoji: string
      left: number
      top: number
      placement: 'above' | 'below'
    } | null>(null)
    const [hoveredZap, setHoveredZap] = useState<{
      left: number
      top: number
      placement: 'above' | 'below'
    } | null>(null)
    const { openContextMenu } = useContextMenu()

    const warnUntrustedLinks = !message.isOwn && !isSenderTrusted && !allowUntrustedLinks

    const myActiveEmojis = useMemo(
      () => message.reactions.filter((r) => r.reactedByMe).map((r) => r.emoji),
      [message.reactions]
    )

    useEffect(() => {
      if (!pickerOpen) return
      const onPointerDown = (e: PointerEvent) => {
        if (
          quickPickerWrapRef.current &&
          e.target instanceof Node &&
          quickPickerWrapRef.current.contains(e.target)
        ) {
          return
        }
        setPickerOpen(false)
      }
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          setPickerOpen(false)
        }
      }
      document.addEventListener('pointerdown', onPointerDown, true)
      window.addEventListener('keydown', onKeyDown)
      return () => {
        document.removeEventListener('pointerdown', onPointerDown, true)
        window.removeEventListener('keydown', onKeyDown)
      }
    }, [pickerOpen])

    const hideReactionTooltip = useCallback(() => {
      setHoveredReaction(null)
    }, [])

    const hideZapTooltip = useCallback(() => {
      setHoveredZap(null)
    }, [])

    const showReactionTooltip = useCallback((emoji: string, el: HTMLElement) => {
      const rect = el.getBoundingClientRect()
      const vw = window.innerWidth || 390
      const vh = window.innerHeight || 800
      const placement: 'above' | 'below' = rect.top < 110 ? 'below' : 'above'
      const halfMax = 110
      const rawCenter = rect.left + rect.width / 2
      const left =
        vw <= halfMax * 2 + 20
          ? vw / 2
          : Math.max(10 + halfMax, Math.min(vw - 10 - halfMax, rawCenter))
      const top =
        placement === 'above'
          ? Math.max(10, rect.top - 8)
          : Math.min(vh - 10, rect.bottom + 8)
      setHoveredZap(null)
      setHoveredReaction({ emoji, left, top, placement })
    }, [])

    const showZapTooltip = useCallback((el: HTMLElement) => {
      const rect = el.getBoundingClientRect()
      const vw = window.innerWidth || 390
      const vh = window.innerHeight || 800
      const placement: 'above' | 'below' = rect.top < 140 ? 'below' : 'above'
      const halfMax = 120
      const rawCenter = rect.left + rect.width / 2
      const left =
        vw <= halfMax * 2 + 20
          ? vw / 2
          : Math.max(10 + halfMax, Math.min(vw - 10 - halfMax, rawCenter))
      const top =
        placement === 'above'
          ? Math.max(10, rect.top - 8)
          : Math.min(vh - 10, rect.bottom + 8)
      setHoveredReaction(null)
      setHoveredZap({ left, top, placement })
    }, [])

    useEffect(() => {
      if (!hoveredReaction && !hoveredZap) return
      const onScroll = () => {
        setHoveredReaction(null)
        setHoveredZap(null)
      }
      window.addEventListener('scroll', onScroll, { capture: true, passive: true })
      return () => window.removeEventListener('scroll', onScroll, { capture: true })
    }, [hoveredReaction, hoveredZap])

    const zapTooltipContent = useMemo(() => {
      if (!hoveredZap || zapTotalSats <= 0) return null
      const totalsByKey = new Map<
        string,
        { label: string; isSelf: boolean; totalSats: number }
      >()

      for (const receipt of zapReceipts ?? []) {
        const sats = Math.max(0, Math.round(receipt.amountSats || 0))
        if (sats <= 0) continue
        const rawPk = receipt.senderPubkey?.trim().toLowerCase() || ''
        if (!rawPk) {
          const prev = totalsByKey.get('__anon__')
          if (prev) {
            prev.totalSats += sats
          } else {
            totalsByKey.set('__anon__', { label: 'Anonymous', isSelf: false, totalSats: sats })
          }
          continue
        }
        const existing = totalsByKey.get(rawPk)
        if (existing) {
          existing.totalSats += sats
        } else {
          const resolved = resolveReactorName ? resolveReactorName(rawPk) : `anon${rawPk.slice(-4)}`
          const isSelf = resolved === 'You'
          const label = isSelf ? 'You' : resolved.startsWith('@') ? resolved : `@${resolved}`
          totalsByKey.set(rawPk, { label, isSelf, totalSats: sats })
        }
      }

      const sorted = Array.from(totalsByKey.values()).sort((a, b) => {
        if (b.totalSats !== a.totalSats) return b.totalSats - a.totalSats
        if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
        return a.label.localeCompare(b.label)
      })

      const visibleEntries = sorted.slice(0, 5)
      const extraCount = Math.max(0, sorted.length - visibleEntries.length)
      return { visibleEntries, extraCount, totalSats: zapTotalSats }
    }, [hoveredZap, zapTotalSats, zapReceipts, resolveReactorName])

    const activeHoveredReaction = useMemo(() => {
      if (!hoveredReaction) return null
      return message.reactions.find((r) => r.emoji === hoveredReaction.emoji) ?? null
    }, [hoveredReaction, message.reactions])

    const reactionTooltipContent = useMemo(() => {
      if (!activeHoveredReaction) return null
      const seen = new Set<string>()
      const resolvedNames: string[] = []
      let hasYou = false

      for (const rawPk of activeHoveredReaction.pubkeys ?? []) {
        const pk = rawPk.trim().toLowerCase()
        if (!pk || seen.has(pk)) continue
        seen.add(pk)
        const name = resolveReactorName ? resolveReactorName(pk) : `anon${pk.slice(-4)}`
        if (name === 'You') {
          hasYou = true
        } else {
          resolvedNames.push(name)
        }
      }

      if (activeHoveredReaction.reactedByMe || hasYou) {
        resolvedNames.unshift('You')
      }

      const totalCount = Math.max(activeHoveredReaction.count, resolvedNames.length)
      const visibleNames = resolvedNames.slice(0, 5)
      const extraCount = Math.max(0, totalCount - visibleNames.length)

      return {
        emoji: activeHoveredReaction.emoji,
        visibleNames,
        extraCount,
        totalCount,
      }
    }, [activeHoveredReaction, resolveReactorName])

    const rawVisibleContent = useMemo(() => {
      if (message.isSystem) return message.content
      const inline = message.imageAttachment?.inlineMarker
        ? parseInlineChatImage(message.content, message.tags)
        : undefined
      const caption = inline?.caption ?? message.content
      const inlineVoice = message.voiceMemo?.inlineVoiceMarker
        ? parseInlineChatVoice(caption, message.tags)
        : undefined
      return message.voiceMemo || message.imageAttachment
        ? extractMediaCaption(
            inlineVoice?.caption ?? caption,
            inlineVoice ? undefined : message.voiceMemo?.url,
            inline ? undefined : message.imageAttachment?.url
          )
        : message.content
    }, [message.isSystem, message.voiceMemo, message.imageAttachment, message.content, message.tags])

    // Extract Cashu Ecash tokens (fast check -> empty array for 99.9% of messages)
    const cashuTokens: CashuTokenPreview[] = useMemo(() => {
      if (message.isSystem || !rawVisibleContent) return []
      if (!rawVisibleContent.includes('cashuA') && !rawVisibleContent.includes('cashuB')) {
        return []
      }
      const found = extractCashuTokensFromText(rawVisibleContent)
      const previews: CashuTokenPreview[] = []
      for (const tok of found) {
        const preview = decodeCashuTokenPreview(tok)
        if (preview) previews.push(preview)
      }
      return previews
    }, [message.isSystem, rawVisibleContent])

    // Annotate external http(s) links inside message text when sender is untrusted
    useLayoutEffect(() => {
      const root = messageBodyRef.current
      if (!root) return
      const anchors = root.querySelectorAll<HTMLAnchorElement>(
        'a.ag-md-link:not(.ag-md-link-internal)'
      )
      for (const anchor of anchors) {
        const rawHref = (anchor.getAttribute('href') || '').trim()
        if (!/^https?:\/\//i.test(rawHref)) continue
        if (warnUntrustedLinks) {
          if (anchor.dataset.origTitle === undefined) {
            anchor.dataset.origTitle = anchor.getAttribute('title') ?? ''
          }
          anchor.classList.add('ag-untrusted-link')
          anchor.setAttribute('title', 'Untrusted sender — click to review link before opening')
        } else {
          anchor.classList.remove('ag-untrusted-link')
          if (anchor.dataset.origTitle !== undefined) {
            if (anchor.dataset.origTitle) {
              anchor.setAttribute('title', anchor.dataset.origTitle)
            } else {
              anchor.removeAttribute('title')
            }
            delete anchor.dataset.origTitle
          }
        }
      }
    }, [warnUntrustedLinks, message.content, displayContentOverride, originalContentInlay])

    // System notice row (left-aligned with subtle accent rail)
    if (message.isSystem) {
      return (
        <div
          id={`msg-${message.id}`}
          className={`ag-msg-row is-system ${isLive ? 'is-live' : ''} ${isSearchActive ? 'is-search-active' : ''}`}
          role="note"
        >
          <div className="ag-msg-gutter">
            <span className="ag-msg-sys-dot" aria-hidden="true" />
          </div>
          <div className="ag-msg-content">
            <div className="ag-msg-head">
              <span className="ag-msg-sys-label">System</span>
              <time
                className="ag-msg-time tabular"
                dateTime={new Date(message.createdAt * 1000).toISOString()}
                title={formatFullTimestamp(message.createdAt)}
              >
                {formatClock(message.createdAt)}
              </time>
            </div>
            <div className="ag-msg-sys-body">
              <RichMessageContent
                content={message.content}
                onTuneGeohash={onTuneGeohash}
                onClickMention={onClickMention}
                highlightQuery={highlightQuery}
                knownHandles={knownHandles}
              />
            </div>
          </div>
        </div>
      )
    }

    const handle = formatHandle(message.nickname, message.pubkey)
    const authorColor = message.isOwn ? undefined : pubkeyToColor(message.pubkey)
    const baseTextContent =
      displayContentOverride !== undefined ? displayContentOverride : rawVisibleContent
    const visibleContent =
      cashuTokens.length > 0
        ? stripCashuTokens(
            baseTextContent,
            cashuTokens.map((t) => t.raw)
          )
        : baseTextContent
    const hideRawUntranslatedBody =
      displayContentOverride === undefined &&
      ((compactTranslatorRow &&
        (translationStatus === 'loading' ||
          translationStatus === 'pending' ||
          translationStatus === 'error')) ||
        translationStatus === 'loading')

    const canZapSender = Boolean(
      !message.isOwn && (canZapSenderProp || senderLightningAddress) && onOpenZap
    )

    const handleTriggerZap = () => {
      if (!canZapSender || !onOpenZap) return
      onOpenZap({
        pubkey: message.pubkey,
        nickname: handle.base,
        lud16: senderLightningAddress,
        eventId: message.id,
      })
    }

    const handleCopy = () => {
      const toCopy = visibleContent || message.content
      navigator.clipboard?.writeText(toCopy).catch(() => {})
      onCopyText?.(toCopy)
      setCopied(true)
      onToggleActions(null)
      window.setTimeout(() => setCopied(false), 1200)
    }

    const handleRowClick = (e: React.MouseEvent<HTMLElement>) => {
      const target = e.target as HTMLElement | null
      if (
        target?.closest(
          'button, a, img, audio, input, .ag-voice-waveform, .ag-codeblock-copy, .ag-nostr-chip'
        )
      ) {
        return
      }
      const sel = window.getSelection?.()
      if (sel && sel.toString().length > 0) return

      onToggleActions(actionsRevealed ? null : message.id)
    }

    const deliveryIcon =
      message.isOwn && message.deliveryStatus ? (
        <span
          className={`ag-msg-delivery ${message.deliveryStatus}`}
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
          {message.deliveryStatus === 'sending' && <Loader2 size={11} className="ag-spin" />}
          {message.deliveryStatus === 'sent' &&
            (message.relayCount && message.relayCount > 1 ? (
              <CheckCheck size={13} />
            ) : (
              <Check size={13} />
            ))}
          {message.deliveryStatus === 'failed' && <AlertCircle size={12} />}
        </span>
      ) : null

    const rowClasses = [
      'ag-msg-row',
      message.isOwn ? 'is-own' : 'is-other',
      grouped ? 'grouped' : '',
      isLive ? 'is-live' : '',
      message.isEmote ? 'is-emote' : '',
      isMentioned ? 'is-mentioned' : '',
      isSearchActive ? 'is-search-active' : '',
      actionsRevealed || pickerOpen || Boolean(expandedPickerAnchor) ? 'actions-open' : '',
    ]
      .filter(Boolean)
      .join(' ')

    const handleContextMenu = (e: React.MouseEvent<HTMLElement>) => {
      const items: ContextMenuItem[] = []

      // 1. If right-click landed on a link inside the message, surface link actions at top
      const targetEl = e.target as HTMLElement | null
      const anchorEl = targetEl?.closest('a[href]') as HTMLAnchorElement | null
      const rawHref = anchorEl?.getAttribute('href')?.trim() || ''
      const lowerHref = rawHref.toLowerCase()
      const isInternalHref =
        lowerHref.startsWith('#dm=') ||
        lowerHref.startsWith('#invite=') ||
        lowerHref.startsWith('#topic=')
      const isSafeExternalHref =
        lowerHref.startsWith('https://') ||
        lowerHref.startsWith('http://') ||
        lowerHref.startsWith('mailto:')

      if (anchorEl && (isInternalHref || isSafeExternalHref)) {
        const resolvedUrl = isInternalHref
          ? `${window.location.origin}${window.location.pathname}${rawHref}`
          : anchorEl.href
        items.push(
          {
            id: 'msg-open-link',
            label: 'Open Link',
            icon: <ExternalLink size={15} />,
            onSelect: () => {
              if (isInternalHref) {
                window.location.hash = rawHref
              } else if (warnUntrustedLinks && /^https?:\/\//i.test(resolvedUrl)) {
                requestUntrustedLinkOpen({
                  url: resolvedUrl,
                  senderHandle: handle.full,
                  senderPubkey: message.pubkey,
                })
              } else if (parseAgoraShareUrl(resolvedUrl) && tryOpenInternalAgoraLink(resolvedUrl)) {
                // Opened directly inside Agora
              } else {
                window.open(resolvedUrl, '_blank', 'noopener,noreferrer')
              }
            },
          },
          {
            id: 'msg-copy-link',
            label: 'Copy Link Address',
            icon: <Link2 size={15} />,
            onSelect: () => {
              navigator.clipboard?.writeText(resolvedUrl).catch(() => {})
              onNotify?.('Link copied')
            },
          }
        )
      }

      const hasLinkSection = items.length > 0

      // 2. Core message actions
      if (!isDmMode && onReply) {
        items.push({
          id: 'msg-reply',
          label: 'Reply',
          icon: <CornerUpLeft size={15} />,
          dividerBefore: hasLinkSection,
          onSelect: () => onReply(message),
        })
      }

      const selectedText = window.getSelection?.()?.toString().trim() || ''
      if (selectedText) {
        items.push({
          id: 'msg-copy-selected',
          label: 'Copy Selected Text',
          icon: <Copy size={15} />,
          dividerBefore: hasLinkSection && items.length === 2,
          onSelect: () => {
            navigator.clipboard?.writeText(selectedText).catch(() => {})
            onNotify?.('Selected text copied')
          },
        })
      }

      const textToCopy = visibleContent || (!message.voiceMemo && !message.imageAttachment ? message.content : '')
      if (textToCopy) {
        items.push({
          id: 'msg-copy-text',
          label: 'Copy Text',
          icon: <Copy size={15} />,
          dividerBefore: hasLinkSection && items.length === 2,
          onSelect: handleCopy,
        })
      }

      // Voice memo transcript actions
      const allowVoiceMemo = canLoadVoiceMemo ?? isSenderTrusted
      if (message.voiceMemo) {
        const voiceMemoKey = message.voiceMemo.sha256 || message.voiceMemo.url || message.id
        if (memoTranscript?.status === 'done' && memoTranscript.text) {
          const transcriptText = memoTranscript.text
          items.push({
            id: 'msg-copy-transcript',
            label: 'Copy Transcript',
            icon: <Captions size={15} />,
            onSelect: () => {
              navigator.clipboard?.writeText(transcriptText).catch(() => {})
              onNotify?.('Transcript copied')
            },
          })
        } else if (
          allowVoiceMemo &&
          onTranscribeMemo &&
          memoTranscript?.status !== 'loading'
        ) {
          const memo = message.voiceMemo
          items.push({
            id: 'msg-transcribe',
            label: 'Transcribe Voice Memo',
            icon: <Captions size={15} />,
            onSelect: () => {
              void onTranscribeMemo(voiceMemoKey, memo, message.pubkey)
            },
          })
        }
      }

      // Trusted image attachment actions
      const rawClickedImg = targetEl?.closest('img')
      const copyableClickedImg =
        rawClickedImg instanceof HTMLImageElement && isCopyableImageElement(rawClickedImg)
          ? rawClickedImg
          : null

      if (message.imageAttachment && isSenderTrusted) {
        const img = message.imageAttachment
        const cardImgEl =
          copyableClickedImg?.classList.contains('ag-img-media')
            ? copyableClickedImg
            : (e.currentTarget.querySelector('img.ag-img-media') as HTMLImageElement | null)
        const readyAttachmentImg = isCopyableImageElement(cardImgEl) ? cardImgEl : null

        items.push(
          {
            id: 'msg-view-image',
            label: 'View Fullscreen',
            icon: <Maximize2 size={15} />,
            onSelect: () => {
              void fetchImageAttachmentBlob(img, message.pubkey)
                .then((blobUrl) => {
                  onOpenLightbox({
                    blobUrl,
                    image: img,
                    senderDisplayHandle: handle.full,
                    caption: visibleContent || undefined,
                  })
                })
                .catch(() => {})
            },
          },
          {
            id: 'msg-copy-image',
            label: 'Copy Image',
            icon: <ImageIcon size={15} />,
            onSelect: () => {
              const source =
                readyAttachmentImg ?? (() => fetchImageAttachmentBlob(img, message.pubkey))
              void copyImageToClipboard(source).then((res) => {
                onNotify?.(res.ok ? 'Image copied' : 'Could not copy image')
              })
            },
          },
          {
            id: 'msg-copy-image-link',
            label: 'Copy Image Link',
            icon: <Link2 size={15} />,
            onSelect: () => {
              navigator.clipboard?.writeText(img.url).catch(() => {})
              onNotify?.('Image link copied')
            },
          }
        )
      } else if (copyableClickedImg) {
        items.push({
          id: 'msg-copy-image',
          label: 'Copy Image',
          icon: <ImageIcon size={15} />,
          onSelect: () => {
            void copyImageToClipboard(copyableClickedImg).then((res) => {
              onNotify?.(res.ok ? 'Image copied' : 'Could not copy image')
            })
          },
        })
      }

      if (!isDmMode && onMentionAuthor) {
        items.push({
          id: 'msg-mention',
          label: `Mention @${handle.base}`,
          icon: <AtSign size={15} />,
          onSelect: () => onMentionAuthor(handle.full),
        })
      }

      // 3. Peer actions for other authors
      if (!message.isOwn) {
        let addedPeerDivider = false
        const markPeerDivider = () => {
          if (addedPeerDivider) return false
          addedPeerDivider = true
          return items.length > 0
        }

        if (canZapSender) {
          items.push({
            id: 'msg-zap-peer',
            label: `Zap @${handle.base}`,
            icon: <Zap size={15} />,
            dividerBefore: markPeerDivider(),
            onSelect: handleTriggerZap,
          })
        }

        if (!isDmMode && onStartDm) {
          items.push({
            id: 'msg-dm-peer',
            label: 'Direct Message',
            icon: <MessageCircle size={15} />,
            dividerBefore: markPeerDivider(),
            onSelect: () => onStartDm(message.pubkey, handle.base),
          })
        }

        if (isSenderExplicitlyTrusted && onStartCall) {
          items.push(
            {
              id: 'msg-voice-call',
              label: 'Voice Call',
              icon: <Phone size={15} />,
              dividerBefore: markPeerDivider(),
              onSelect: () => onStartCall(message.pubkey, 'audio', handle.base),
            },
            {
              id: 'msg-video-call',
              label: 'Video Call',
              icon: <Video size={15} />,
              onSelect: () => onStartCall(message.pubkey, 'video', handle.base),
            }
          )
        }

        if (isSenderExplicitlyTrusted && onUntrustSender) {
          items.push({
            id: 'msg-untrust',
            label: 'Remove Trust',
            icon: <ShieldOff size={15} />,
            dividerBefore: markPeerDivider(),
            onSelect: () => onUntrustSender(message.pubkey),
          })
        } else {
          items.push({
            id: 'msg-trust',
            label: 'Trust Peer',
            icon: <ShieldCheck size={15} />,
            dividerBefore: markPeerDivider(),
            onSelect: () => onTrustSender(message.pubkey, handle.base),
          })
        }

        if (onInspectAuthor) {
          items.push({
            id: 'msg-profile',
            label: 'View Profile',
            icon: <User size={15} />,
            dividerBefore: markPeerDivider(),
            onSelect: () => onInspectAuthor(message.pubkey, handle.base),
          })
        }

        items.push({
          id: 'msg-block',
          label: 'Block Peer',
          icon: <Ban size={15} />,
          danger: true,
          onSelect: () => onBlockSender(message.pubkey, handle.full),
        })
      }

      // 4. Delete & Event ID
      if (onDelete) {
        items.push({
          id: 'msg-delete',
          label: 'Delete Message',
          icon: <Trash2 size={15} />,
          danger: true,
          dividerBefore: items.length > 0,
          onSelect: () => onDelete(message),
        })
      }

      items.push({
        id: 'msg-copy-id',
        label: 'Copy Event ID',
        icon: <Hash size={15} />,
        dividerBefore: !onDelete && items.length > 0,
        onSelect: () => {
          navigator.clipboard?.writeText(message.id).catch(() => {})
          onNotify?.('Event ID copied')
        },
      })

      const reactions: ContextMenuReaction[] | undefined =
        !isDmMode && onReact
          ? pinnedReactions.map((emoji) => ({
              emoji,
              active: message.reactions.some((r) => r.emoji === emoji && r.reactedByMe),
              onSelect: () => onReact(message, emoji),
            }))
          : undefined

      const onExpandReactions =
        !isDmMode && onReact
          ? (anchorRect: DOMRect) => {
              setPickerOpen(false)
              setExpandedPickerAnchor(anchorRect)
            }
          : undefined

      openContextMenu(e, {
        header: handle.full,
        reactions,
        onExpandReactions,
        items,
      })
    }

    const avatarRingClass = clientAvatarRingClass(message.clientName, message.isAgnostrClient)

    const interceptMessageLinkClick = (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null
      if (!anchor || anchor.classList.contains('ag-md-link-internal')) return
      const rawHref = (anchor.getAttribute('href') || '').trim()
      if (!/^https?:\/\//i.test(rawHref)) return
      const resolvedUrl = anchor.href || rawHref
      if (warnUntrustedLinks) {
        e.preventDefault()
        e.stopPropagation()
        requestUntrustedLinkOpen({
          url: resolvedUrl,
          senderHandle: handle.full,
          senderPubkey: message.pubkey,
        })
        return
      }
      if (parseAgoraShareUrl(resolvedUrl) && tryOpenInternalAgoraLink(resolvedUrl)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    const interceptMessageLinkAuxClick = (e: React.MouseEvent<HTMLDivElement>) => {
      if (!warnUntrustedLinks || e.button !== 1) return
      interceptMessageLinkClick(e)
    }

    return (
      <article
        id={isOriginalColumn ? `msg-${message.id}-orig` : `msg-${message.id}`}
        className={rowClasses}
        onClick={handleRowClick}
        onContextMenu={handleContextMenu}
      >
        {/* Left Fixed 36px Gutter: 34px Rounded-Square Avatar OR Subtle Hover Timestamp */}
        <div className="ag-msg-gutter">
          {!grouped ? (
            <button
              type="button"
              className="ag-msg-avatar-btn"
              onClick={() => onInspectAuthor?.(message.pubkey, handle.base)}
              title={`View ${handle.full}`}
              aria-label={`View ${handle.full}`}
            >
              <AvatarImg
                pubkey={message.pubkey}
                pictureUrl={senderAvatarUrl}
                alt=""
                width={34}
                height={34}
                className={`ag-stream-avatar ${avatarRingClass}`}
                loading="lazy"
              />
            </button>
          ) : (
            <span
              className={`ag-msg-gutter-time tabular ${message.deliveryStatus === 'failed' ? 'failed' : ''}`}
              title={formatFullTimestamp(message.createdAt)}
            >
              {message.deliveryStatus === 'failed' ? (
                <AlertCircle size={12} />
              ) : (
                formatClock(message.createdAt)
              )}
            </span>
          )}
        </div>

        {/* Full-Width Right Content Column */}
        <div className="ag-msg-content">
          {/* Group Header Line (First Message of Consecutive Group) */}
          {!grouped && (
            <div className="ag-msg-head">
              <button
                type="button"
                className={`ag-msg-author ${message.isOwn ? 'self' : ''}`}
                style={authorColor ? { color: authorColor } : undefined}
                onClick={() => onInspectAuthor?.(message.pubkey, handle.base)}
                title={handle.full}
              >
                {handle.base}
              </button>

              {isSenderExplicitlyTrusted && !message.isOwn && (
                <span
                  className="ag-trusted-shield-icon"
                  title={`Trusted peer (${handle.full})`}
                  aria-label="Trusted peer"
                >
                  <ShieldCheck size={13} />
                </span>
              )}

              {!isDmMode && showBridgeBadges && message.isMeshBridge && (
                <span
                  className="ag-mesh-inline-icon"
                  title={
                    message.bridgeClient
                      ? `Bridged via ${message.bridgeClient}`
                      : 'Bridged from Bitchat mesh'
                  }
                  aria-label="Mesh bridge"
                >
                  <Waves size={12} />
                </span>
              )}

              <time
                className="ag-msg-time tabular"
                dateTime={new Date(message.createdAt * 1000).toISOString()}
                title={formatFullTimestamp(message.createdAt)}
              >
                {formatClock(message.createdAt)}
              </time>

              {deliveryIcon}
            </div>
          )}

          {/* Compact Inline Reply Reference Strip */}
          {message.replyTo && (
            <button
              type="button"
              className={`ag-reply-quote ${isEncryptedContext ? 'encrypted' : ''}`}
              onClick={() => message.replyTo && onJumpToMessage?.(message.replyTo.id)}
              title="Jump to replied message"
            >
              <CornerUpLeft size={12} className="ag-reply-quote-icon" />
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

          {/* Full-Width Message Text Body (with optional Single-Column Translator Side Inlay) */}
          {(visibleContent.length > 0 ||
            translationStatus === 'loading' ||
            translationStatus === 'pending' ||
            translationStatus === 'error') && (
            <div
              ref={messageBodyRef}
              onClickCapture={interceptMessageLinkClick}
              onAuxClickCapture={interceptMessageLinkAuxClick}
            >
              {hideRawUntranslatedBody ? (
                translationStatus === 'loading' ? (
                  <div className="ag-translator-inline-status">
                    <Loader2 size={12} className="ag-spin" />
                    <span>{translationLoadingLabel || 'Translating…'}</span>
                  </div>
                ) : translationStatus === 'pending' ? (
                  <div className="ag-translator-inline-status pending">
                    <span>Queued…</span>
                  </div>
                ) : null
              ) : visibleContent.length > 0 ? (
                originalContentInlay ? (
                  <div className="ag-msg-translation-row">
                    <div className="ag-msg-translated-main">
                      <RichMessageContent
                        content={visibleContent}
                        onTuneGeohash={onTuneGeohash}
                        onClickMention={onClickMention}
                        highlightQuery={highlightQuery}
                        knownHandles={knownHandles}
                      />
                    </div>
                    <aside className="ag-msg-original-inlay" aria-label="Original message">
                      {originalContentInlay}
                    </aside>
                  </div>
                ) : (
                  <RichMessageContent
                    content={visibleContent}
                    onTuneGeohash={onTuneGeohash}
                    onClickMention={onClickMention}
                    highlightQuery={highlightQuery}
                    knownHandles={knownHandles}
                  />
                )
              ) : null}

              {translationBadge && (
                <div className="ag-translator-msg-meta" title={translationBadge}>
                  <Languages size={11} style={{ flexShrink: 0 }} aria-hidden="true" />
                  <span>{translationBadge}</span>
                </div>
              )}

              {translationStatus === 'error' && (
                <div className="ag-translator-error-wrap">
                  <div className="ag-translator-inline-status error">
                    <AlertCircle size={12} />
                    <span className="truncate">{translationError || 'Translation failed'}</span>
                    {onRetryTranslation && (
                      <button
                        type="button"
                        className="ag-translator-retry-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          onRetryTranslation()
                        }}
                      >
                        <RefreshCw size={11} />
                        <span>Retry</span>
                      </button>
                    )}
                  </div>
                  {underlyingCollapsed && hideRawUntranslatedBody && visibleContent.length > 0 && (
                    <div className="ag-translator-error-fallback">
                      <span className="ag-translator-error-fallback-label">Original:</span>{' '}
                      {visibleContent}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Inline Cashu Ecash Token Claim Cards */}
          {cashuTokens.length > 0 && (
            <div className="ag-cashu-token-list">
              {cashuTokens.map((tok, idx) => (
                <div key={`${tok.raw.slice(0, 18)}-${idx}`} className="ag-cashu-token-card">
                  <div className="ag-cashu-token-left">
                    <span className="ag-cashu-token-icon" aria-hidden="true">
                      <Zap size={14} />
                    </span>
                    <div className="ag-cashu-token-copy">
                      <div className="ag-cashu-token-title tabular">
                        <span>{tok.amountSats.toLocaleString()} sats</span>
                      </div>
                      <div className="ag-cashu-token-sub truncate">
                        <span>{formatMintHost(tok.mintUrl)}</span>
                        {tok.memo ? <span> · {tok.memo}</span> : null}
                      </div>
                    </div>
                  </div>
                  <div className="ag-cashu-token-actions">
                    <button
                      type="button"
                      className="ag-cashu-token-copy-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        navigator.clipboard?.writeText(tok.raw).catch(() => {})
                        onNotify?.('Token copied')
                      }}
                      title="Copy token"
                      aria-label="Copy token"
                    >
                      <Copy size={13} />
                    </button>
                    {onClaimCashuToken && (
                      <button
                        type="button"
                        className="ag-cashu-claim-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          onClaimCashuToken(tok.raw)
                        }}
                      >
                        Claim
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Left-Aligned Voice Memo Player / Untrusted Shielded Card */}
          {message.voiceMemo && (
            <div className="ag-msg-media-slot">
              <VoiceMemoPlayer
                memo={message.voiceMemo}
                memoKey={message.voiceMemo.sha256 || message.voiceMemo.url || message.id}
                senderPubkey={message.pubkey}
                senderNickname={handle.base}
                senderDisplayHandle={handle.full}
                isTrusted={isSenderTrusted}
                isAllowed={canLoadVoiceMemo ?? isSenderTrusted}
                isDmMode={isEncryptedContext}
                autoTranscribe={autoTranscribe}
                fetchVoiceMemoBlob={fetchVoiceMemoBlob}
                memoTranscript={memoTranscript}
                transcriptionModelStatus={transcriptionModelStatus}
                transcriptionDownloadProgress={transcriptionDownloadProgress}
                activeTranscriptionModelLabel={activeTranscriptionModelLabel}
                onTranscribeMemo={onTranscribeMemo}
                onTrustSender={onTrustSender}
                onInspectSender={(pk, nick) => onInspectAuthor?.(pk, nick)}
                onBlockSender={onBlockSender}
              />
            </div>
          )}

          {/* Left-Aligned Image Attachment / Untrusted Shielded Card */}
          {message.imageAttachment && (
            <div className="ag-msg-media-slot" onClickCapture={interceptMessageLinkClick} onAuxClickCapture={interceptMessageLinkAuxClick}>
              <ImageAttachmentCard
                image={message.imageAttachment}
                senderPubkey={message.pubkey}
                senderNickname={handle.base}
                senderDisplayHandle={handle.full}
                isTrusted={isSenderTrusted}
                isOwn={message.isOwn}
                isDmMode={isEncryptedContext}
                caption={visibleContent || undefined}
                contentFilter={contentFilter}
                fetchImageAttachmentBlob={fetchImageAttachmentBlob}
                onTrustSender={onTrustSender}
                onInspectSender={(pk, nick) => onInspectAuthor?.(pk, nick)}
                onBlockSender={onBlockSender}
                onOpenLightbox={onOpenLightbox}
              />
            </div>
          )}

          {/* Aggregated Emoji Reactions & Live NIP-57 Zap Receipt Total */}
          {((!isDmMode && message.reactions.length > 0) || zapTotalSats > 0) && (
            <div className="ag-reactions" role="group" aria-label="Message reactions and zaps">
              {zapTotalSats > 0 && (
                <button
                  type="button"
                  className={`ag-zap-receipt-pill tabular ${!canZapSender ? 'is-readonly' : ''}`}
                  aria-disabled={!canZapSender || undefined}
                  aria-label={
                    canZapSender
                      ? `${zapTotalSats.toLocaleString()} sats zapped — click to zap @${handle.base}`
                      : `${zapTotalSats.toLocaleString()} sats zapped`
                  }
                  onClick={() => {
                    hideZapTooltip()
                    if (canZapSender) handleTriggerZap()
                  }}
                  onMouseEnter={(e) => showZapTooltip(e.currentTarget)}
                  onMouseLeave={hideZapTooltip}
                  onFocus={(e) => showZapTooltip(e.currentTarget)}
                  onBlur={hideZapTooltip}
                >
                  <Zap size={12} fill="currentColor" />
                  <span>{zapTotalSats.toLocaleString()}</span>
                </button>
              )}
              {!isDmMode &&
                message.reactions.map((rx) => (
                  <button
                    key={rx.emoji}
                    type="button"
                    className={`ag-reaction-pill ${rx.reactedByMe ? 'mine' : ''}`}
                    onClick={() => {
                      hideReactionTooltip()
                      onReact?.(message, rx.emoji)
                    }}
                    onMouseEnter={(e) => showReactionTooltip(rx.emoji, e.currentTarget)}
                    onMouseLeave={hideReactionTooltip}
                    onFocus={(e) => showReactionTooltip(rx.emoji, e.currentTarget)}
                    onBlur={hideReactionTooltip}
                    aria-label={`React with ${rx.emoji} (${rx.count})`}
                  >
                    <span>{rx.emoji}</span>
                    <span className="ag-reaction-count tabular">{rx.count}</span>
                  </button>
                ))}
            </div>
          )}
        </div>

        {/* Unclipped Floating Portal Tooltip Showing Zap Breakdown (Greatest -> Least, Top 5) */}
        {hoveredZap &&
          zapTooltipContent &&
          typeof document !== 'undefined' &&
          createPortal(
            <div
              className={`ag-reaction-tooltip ag-zap-tooltip is-${hoveredZap.placement}`}
              role="tooltip"
              style={{
                left: `${hoveredZap.left}px`,
                top: `${hoveredZap.top}px`,
              }}
            >
              <span className="ag-reaction-tooltip-emoji ag-zap-tooltip-icon" aria-hidden="true">
                <Zap size={13} fill="currentColor" />
              </span>
              <div className="ag-reaction-tooltip-body">
                {zapTooltipContent.visibleEntries.length > 0 ? (
                  <div className="ag-zap-tooltip-list">
                    {zapTooltipContent.visibleEntries.map((entry, idx) => (
                      <span key={`${entry.label}-${idx}`} className="ag-zap-tooltip-row tabular">
                        <span className="ag-reaction-tooltip-names">{entry.label}</span>
                        <span className="ag-reaction-tooltip-more">
                          {' '}
                          · {entry.totalSats.toLocaleString()} sats
                        </span>
                      </span>
                    ))}
                    {zapTooltipContent.extraCount > 0 && (
                      <span className="ag-reaction-tooltip-more">
                        and {zapTooltipContent.extraCount} more
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="ag-reaction-tooltip-more tabular">
                    {zapTooltipContent.totalSats.toLocaleString()} sats zapped
                  </span>
                )}
              </div>
            </div>,
            document.body
          )}

        {/* Unclipped Floating Portal Tooltip Showing Who Reacted */}
        {hoveredReaction &&
          reactionTooltipContent &&
          typeof document !== 'undefined' &&
          createPortal(
            <div
              className={`ag-reaction-tooltip is-${hoveredReaction.placement}`}
              role="tooltip"
              style={{
                left: `${hoveredReaction.left}px`,
                top: `${hoveredReaction.top}px`,
              }}
            >
              <span className="ag-reaction-tooltip-emoji" aria-hidden="true">
                {reactionTooltipContent.emoji}
              </span>
              <div className="ag-reaction-tooltip-body">
                {reactionTooltipContent.visibleNames.length > 0 ? (
                  <>
                    <span className="ag-reaction-tooltip-names">
                      {reactionTooltipContent.visibleNames.join(', ')}
                    </span>
                    {reactionTooltipContent.extraCount > 0 && (
                      <span className="ag-reaction-tooltip-more">
                        {' '}
                        and {reactionTooltipContent.extraCount} more
                      </span>
                    )}
                  </>
                ) : (
                  <span className="ag-reaction-tooltip-more">
                    {reactionTooltipContent.totalCount}{' '}
                    {reactionTooltipContent.totalCount === 1 ? 'reaction' : 'reactions'}
                  </span>
                )}
              </div>
            </div>,
            document.body
          )}

        {/* Sleek Top-Right Floating Quick-Action Bar (Desktop Hover / Mobile Tap-to-Reveal) */}
        <div
          className={`ag-msg-actions ${pickerOpen || expandedPickerAnchor ? 'picker-open' : ''}`}
          role="toolbar"
          aria-label="Message actions"
        >
          {!isDmMode && onReact && (
            <div ref={quickPickerWrapRef} style={{ position: 'relative' }}>
              <button
                type="button"
                className="ag-msg-act-btn"
                onClick={(e) => {
                  if (pinnedReactions.length === 0) {
                    setPickerOpen(false)
                    setExpandedPickerAnchor(e.currentTarget.getBoundingClientRect())
                    return
                  }
                  setPickerOpen((v) => !v)
                }}
                title="React"
                aria-label="Add reaction"
                aria-expanded={pickerOpen || Boolean(expandedPickerAnchor)}
              >
                <Smile size={15} />
              </button>
              {pickerOpen && (
                <div className="ag-emoji-popover" role="menu" aria-label="Quick reactions">
                  {pinnedReactions.map((emoji) => {
                    const reacted = myActiveEmojis.includes(emoji)
                    return (
                      <button
                        key={emoji}
                        type="button"
                        className={`ag-emoji-opt ${reacted ? 'active' : ''}`}
                        aria-label={`React with ${emoji}`}
                        aria-pressed={reacted}
                        onClick={() => {
                          onReact(message, emoji)
                          setPickerOpen(false)
                          onToggleActions(null)
                        }}
                      >
                        {emoji}
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    className="ag-emoji-opt ag-emoji-expand-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      const rect = e.currentTarget.getBoundingClientRect()
                      setPickerOpen(false)
                      setExpandedPickerAnchor(rect)
                    }}
                    title="More reactions & pin emojis"
                    aria-label="More emoji reactions"
                  >
                    <Plus size={14} strokeWidth={2.3} />
                  </button>
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
              <Check size={15} style={{ color: 'var(--accent)' }} />
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

        {/* Expanded Detailed Emoji Reaction & Pin Picker (Portaled, Unclipped) */}
        {expandedPickerAnchor && !isDmMode && onReact && (
          <ReactionPickerPopover
            anchorRect={expandedPickerAnchor}
            activeEmojis={myActiveEmojis}
            onSelect={(emoji) => {
              onReact(message, emoji)
              setExpandedPickerAnchor(null)
              onToggleActions(null)
            }}
            onClose={() => {
              setExpandedPickerAnchor(null)
            }}
          />
        )}
      </article>
    )
  }
)

MessageItem.displayName = 'MessageItem'

export default MessageItem
