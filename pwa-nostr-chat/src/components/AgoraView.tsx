import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { InlineLinkCards } from './InlineLinkCards'
import { collectPreviewLink } from '../../../link-preview/src/url'
import type { ChangeEvent, FormEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  ArrowLeft,
  ArrowUp,
  AtSign,
  BadgeCheck,
  Ban,
  Bell,
  BellOff,
  Bookmark,
  BookOpen,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Compass,
  Copy,
  Eye,
  EyeOff,
  Flame,
  Globe,
  Hash,
  Heart,
  Landmark,
  Languages,
  LayoutList,
  Link2,
  Loader2,
  Lock,
  Mail,
  Menu,
  MessageCircle,
  MoreHorizontal,
  PenLine,
  PenSquare,
  Play,
  Quote,
  RefreshCw,
  Repeat2,
  Rows3,
  Search,
  Share2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  User,
  Users,
  X,
  Zap,
} from 'lucide-react'
import type {
  AgoraFeedFilter,
  AgoraFeedItem,
  AgoraFeedTab,
  AgoraGroupedNotification,
  AgoraMediaItem,
  AgoraNote,
  AgoraNotificationFilter,
  AgoraProfile,
  AgoraProfileDraft,
  AgoraProfileTab,
  AgoraReplyTreeNode,
} from '../types/agora.ts'
import type { AgnostrEngine, ImageAttachment } from '../types/protocol.ts'
import {
  TRANSLATION_LANGUAGE_OPTIONS,
  TRANSLATOR_MODELS,
  resolveLanguageCodes,
  translationCacheKey,
  type TranslationEntry,
} from '../types/translator.ts'
import type { ZapTarget } from '../types/wallet.ts'
import {
  encodeNoteEventId,
  getProfileDisplayName,
  sanitizeHttpUrl,
  tokenizeAgoraContent,
} from '../lib/agoraProtocol.ts'
import {
  buildThreadedReplyTree,
  groupAgoraNotifications,
  parseRichContentBlocks,
} from '../lib/agoraExtras.ts'
import { encodeNpubSafe } from '../lib/identity.ts'
import { isNonTranslatableText } from '../lib/languageDetect.ts'
import {
  buildAgoraNoteShareUrl,
  buildAgoraProfileShareUrl,
  parseAgoraShareUrl,
} from '../lib/shareLinks.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import { useMobileSwipeDrawers } from '../hooks/useMobileSwipeDrawers.ts'
import { identiconDataUrl, shortPubkey } from '../utils/identicon.ts'
import type { SoundCue } from '../utils/sound.ts'
import type { LightboxImagePayload } from './ImageLightboxModal.tsx'
import { AgoraComposer } from './AgoraComposer.tsx'
import { AgoraProfileHoverCard } from './AgoraProfileHoverCard.tsx'
import { AgoraArticleCard, AgoraArticleModal } from './AgoraArticleModal.tsx'
import { AgoraCurationModal } from './AgoraCurationModal.tsx'
import { AgoraPollCard } from './AgoraPollCard.tsx'
import {
  requestUntrustedLinkOpen,
  tryOpenInternalAgoraLink,
} from './UntrustedLinkModal.tsx'
import { AGORA_WOT_DISCOVERY_ENABLED } from '../features/agoraDiscovery/featureFlag.ts'
import '../styles/agora.css'

const AgoraDiscoveryView = React.lazy(
  () => import('../features/agoraDiscovery/AgoraDiscoveryView.tsx')
)

export interface AgoraViewProps {
  engine: AgnostrEngine
  isMobileViewport?: boolean
  initialComposeOpen?: boolean
  onConsumedInitialCompose?: () => void
  onOpenDm: (pubkey: string, nickname?: string) => void
  onOpenAmailCompose?: (pubkey: string, nickname?: string) => void
  onOpenZap?: (target: ZapTarget) => void
  onOpenLightbox?: (payload: LightboxImagePayload) => void
  onPlaySound?: (cue: SoundCue) => void
}

type ComposerModalState =
  | { kind: 'post' }
  | { kind: 'reply'; targetNote: AgoraNote }
  | { kind: 'quote'; targetNote: AgoraNote }

const FEED_NAV_ITEMS: ReadonlyArray<{
  id: AgoraFeedTab
  label: string
  mobileLabel: string
  icon: typeof Users
  beta?: boolean
}> = [
  { id: 'following', label: 'Following', mobileLabel: 'Following', icon: Users },
  { id: 'global', label: 'Global', mobileLabel: 'Global', icon: Globe },
  { id: 'trending', label: 'Trending', mobileLabel: 'Trending', icon: Flame },
  ...(AGORA_WOT_DISCOVERY_ENABLED
    ? [{ id: 'discover' as const, label: 'Discover', mobileLabel: 'Discover', icon: Compass, beta: true }]
    : []),
  { id: 'articles', label: 'Articles', mobileLabel: 'Articles', icon: BookOpen },
  { id: 'bookmarks', label: 'Bookmarks', mobileLabel: 'Saved', icon: Bookmark },
  { id: 'notifications', label: 'Notifications', mobileLabel: 'Alerts', icon: Bell },
]

const FEED_FILTER_OPTIONS: ReadonlyArray<{ id: AgoraFeedFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'no-reposts', label: 'No Reposts' },
  { id: 'media', label: 'Media' },
  { id: 'trusted', label: 'Trusted Only' },
]

const NOTIFICATION_FILTER_OPTIONS: ReadonlyArray<{
  id: AgoraNotificationFilter
  label: string
}> = [
  { id: 'all', label: 'All' },
  { id: 'replies', label: 'Replies & Mentions' },
  { id: 'zaps', label: 'Zaps' },
  { id: 'reactions', label: 'Reactions' },
]

const QUICK_ZAP_PRESETS: readonly number[] = [21, 100, 500]

const PROFILE_TABS: ReadonlyArray<{ id: AgoraProfileTab; label: string }> = [
  { id: 'posts', label: 'Posts' },
  { id: 'replies', label: 'Replies' },
  { id: 'media', label: 'Media' },
  { id: 'likes', label: 'Likes' },
]

function formatRelativeSeconds(tsSec: number): string {
  const nowSec = Math.floor(Date.now() / 1000)
  const diff = Math.max(0, nowSec - tsSec)
  if (diff < 45) return 'now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h`
  if (diff < 86_400 * 7) return `${Math.floor(diff / 86_400)}d`
  try {
    return new Date(tsSec * 1000).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return `${Math.floor(diff / 86_400)}d`
  }
}

function formatFullDateTime(tsSec: number): string {
  try {
    return new Date(tsSec * 1000).toLocaleString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return ''
  }
}

function formatCompactCount(n: number): string {
  if (n <= 0) return ''
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const val = (n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')
    return `${val}k`
  }
  const val = (n / 1_000_000).toFixed(1).replace(/\.0$/, '')
  return `${val}M`
}

function formatNip05Display(raw: string | undefined): string | null {
  if (!raw) return null
  const clean = raw.trim()
  if (!clean) return null
  return clean.startsWith('_@') ? clean.slice(1) : clean
}

function parseDimTuple(dim: string | undefined): { width: number; height: number } {
  if (!dim) return { width: 0, height: 0 }
  const parts = dim.toLowerCase().split('x')
  if (parts.length !== 2) return { width: 0, height: 0 }
  const w = Number.parseInt(parts[0], 10)
  const h = Number.parseInt(parts[1], 10)
  return {
    width: Number.isFinite(w) && w > 0 ? w : 0,
    height: Number.isFinite(h) && h > 0 ? h : 0,
  }
}

async function copyTextSafe(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

const MAX_AGORA_CONCURRENT_TRANSLATIONS = 3
const MAX_AGORA_TRANSLATE_NOTES = 40

const PTR_PULL_THRESHOLD = 54
const PTR_MAX_PULL_PX = 88
const PTR_REFRESH_HOLD_PX = 48
const PTR_REFRESH_HOLD_MS = 550
const PTR_EXCLUDED_SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[data-no-swipe="true"]',
].join(', ')

function findPtrTouchById(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i += 1) {
    const t = list.item(i)
    if (t && t.identifier === id) return t
  }
  return null
}

function shouldIgnorePtrTarget(target: EventTarget | null, stream: HTMLElement): boolean {
  let node: Element | null =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null

  while (node) {
    if (node.matches(PTR_EXCLUDED_SELECTOR)) {
      return true
    }
    if ((node as HTMLElement).isContentEditable) {
      return true
    }
    if (node !== stream && node.scrollWidth > node.clientWidth + 4) {
      const overflowX = window.getComputedStyle(node).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll') {
        return true
      }
    }
    if (node === stream) break
    node = node.parentElement
  }
  return false
}

function extractTranslatableAgoraText(note: AgoraNote): string | null {
  if (!note.content || !note.content.trim()) return null
  const tokens = tokenizeAgoraContent(note.content, note.media)
  const parts: string[] = []
  for (const tok of tokens) {
    if (tok.type === 'text') {
      parts.push(tok.text)
    } else if (tok.type === 'hashtag' || tok.type === 'mention') {
      parts.push(tok.raw)
    } else if (tok.type === 'link') {
      parts.push(tok.url)
    }
    // Strip 'quote' tokens (bare nostr:nevent1…/nostr:note1…)
  }
  const clean = parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!clean || isNonTranslatableText(clean)) return null
  return clean
}

function normalizeTranslationText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function textsDifferMeaningfully(original: string, translated: string): boolean {
  const normOrig = normalizeTranslationText(original)
  const normTrans = normalizeTranslationText(translated)
  return Boolean(normTrans) && normOrig !== normTrans
}

function resolveAgoraTranslatedFromLabel(
  entry: TranslationEntry | undefined,
  myLanguage: string,
  explicitSourceLang: string | undefined
): string | null {
  if (!entry || entry.status !== 'done' || entry.sameLanguage) return null
  const myLangClean = myLanguage.trim()
  if (!myLangClean) return null
  const myNllb = resolveLanguageCodes(myLangClean).nllbCode

  if (explicitSourceLang) {
    const srcClean = explicitSourceLang.trim()
    if (!srcClean) return null
    if (srcClean.toLowerCase() === myLangClean.toLowerCase()) return null
    if (resolveLanguageCodes(srcClean).nllbCode === myNllb) return null
    return `Translated from ${srcClean}`
  }

  // Auto mode: only show when worker confirmed sourceDetected (populates detectedSourceLang)
  const detectedLang = entry.detectedSourceLang?.trim()
  if (!detectedLang) return null
  if (detectedLang.toLowerCase() === myLangClean.toLowerCase()) return null
  if (resolveLanguageCodes(detectedLang).nllbCode === myNllb) return null
  return `Translated from ${detectedLang}`
}

function agoraShowOriginalKey(noteId: string, myLanguage: string, sourceLanguage: string): string {
  return `${noteId}:${myLanguage}:${sourceLanguage}`
}

/* --------------------------------------------------------------------------
   Universal Fail-Closed Screened Image & Trust-Gated Video Components
   (NEVER renders raw external <img src="https://..."> in Agora; videos from
   untrusted senders mount ZERO <video> and fetch ZERO video bytes)
   -------------------------------------------------------------------------- */
function makeAgoraImageCacheKey(senderPubkey: string, safeHttpsUrl: string): string {
  const pk = senderPubkey.trim().toLowerCase() || 'anon'
  return `agora-img:${pk}:${safeHttpsUrl}`
}

function isSafeHttpsUrl(raw: string | null | undefined): raw is string {
  return Boolean(raw && raw.startsWith('https://'))
}

interface AgoraScreenedImageProps {
  engine: AgnostrEngine
  url: string | undefined | null
  senderPubkey: string
  variant: 'media' | 'quote' | 'banner' | 'avatar' | 'thumb' | 'upload'
  alt?: string
  hasAltText?: boolean
  className?: string
  avatarSize?: 'xs' | 'sm' | 'md' | 'lg'
  avatarFallbackPubkey?: string
  caption?: string
  allowReveal?: boolean
  onResolvedBlobUrl?: (blobUrl: string) => void
  onOpenLightbox?: (verifiedBlobUrl: string) => void
}

const AgoraScreenedImage: React.FC<AgoraScreenedImageProps> = ({
  engine,
  url,
  senderPubkey,
  variant,
  alt = '',
  hasAltText = false,
  className,
  avatarSize = 'md',
  avatarFallbackPubkey,
  caption,
  allowReveal = true,
  onResolvedBlobUrl,
  onOpenLightbox,
}) => {
  const { contentFilter } = engine
  const hostRef = useRef<HTMLDivElement | null>(null)
  const avatarImgRef = useRef<HTMLImageElement | null>(null)
  const autoRequestedKeyRef = useRef<string | null>(null)
  const [inView, setInView] = useState<boolean>(
    () => typeof IntersectionObserver === 'undefined'
  )
  const [revealedState, setRevealedState] = useState<{ key: string; url: string } | null>(null)

  const sanitizedUrl = useMemo(() => sanitizeHttpUrl(url ?? undefined), [url])
  const safeHttpsUrl = isSafeHttpsUrl(sanitizedUrl) ? sanitizedUrl : null
  const cacheKey = safeHttpsUrl ? makeAgoraImageCacheKey(senderPubkey, safeHttpsUrl) : ''

  const verdict = cacheKey ? contentFilter.getVerdict(cacheKey) : null
  const safeBlobUrl =
    cacheKey && verdict?.status === 'safe' ? contentFilter.getSafeImageObjectUrl(cacheKey) : null
  const revealedUrl = revealedState && revealedState.key === cacheKey ? revealedState.url : null
  const activeVerifiedBlobUrl = safeBlobUrl ?? revealedUrl

  useEffect(() => {
    if (activeVerifiedBlobUrl && onResolvedBlobUrl) {
      onResolvedBlobUrl(activeVerifiedBlobUrl)
    }
  }, [activeVerifiedBlobUrl, onResolvedBlobUrl])
  const isIllegal = Boolean(verdict?.categories.includes('illegal'))
  const isNsfw = Boolean(verdict?.categories.includes('nsfw'))

  const identicon = useMemo(
    () =>
      variant === 'avatar'
        ? identiconDataUrl(avatarFallbackPubkey || senderPubkey || 'anon')
        : '',
    [avatarFallbackPubkey, senderPubkey, variant]
  )

  // Observe viewport entry to screen lazily without flooding offscreen feed history
  useEffect(() => {
    if (inView || !safeHttpsUrl) return
    const el = variant === 'avatar' ? avatarImgRef.current : hostRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true)
          io.disconnect()
        }
      },
      { rootMargin: '180px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [inView, safeHttpsUrl, variant])

  // Trigger on-device safety screening as soon as visible (or rehydrate blob URL for safe cache)
  useEffect(() => {
    if (!inView || !safeHttpsUrl || !cacheKey) return
    const needsAutoScreen = !verdict || verdict.status === 'idle'
    const needsSafeRehydrate = verdict?.status === 'safe' && !safeBlobUrl
    if (!needsAutoScreen && !needsSafeRehydrate) return
    if (autoRequestedKeyRef.current === cacheKey) return
    autoRequestedKeyRef.current = cacheKey
    void contentFilter.screenExternalImageUrl(cacheKey, safeHttpsUrl, senderPubkey, {
      caption,
    })
  }, [inView, safeHttpsUrl, cacheKey, verdict, safeBlobUrl, contentFilter, senderPubkey, caption])

  const handleRetry = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!safeHttpsUrl || !cacheKey) return
    autoRequestedKeyRef.current = cacheKey
    void contentFilter.screenExternalImageUrl(cacheKey, safeHttpsUrl, senderPubkey, {
      caption,
      skipCache: true,
    })
  }

  const handleReveal = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!cacheKey || isIllegal) return
    const blobUrl = contentFilter.revealFlaggedImage(cacheKey)
    if (blobUrl) {
      setRevealedState({ key: cacheKey, url: blobUrl })
    }
  }

  const handleHide = (e: React.MouseEvent) => {
    e.stopPropagation()
    setRevealedState(null)
  }

  // Variant 1: Avatar — silently shows geometric identicon until cleared SAFE
  if (variant === 'avatar') {
    const avatarClasses = [
      'ag-agora-avatar',
      `ag-agora-avatar-${avatarSize}`,
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ')
    const displaySrc = verdict?.status === 'safe' && safeBlobUrl ? safeBlobUrl : identicon
    return (
      <img
        ref={avatarImgRef}
        src={displaySrc}
        alt={alt}
        className={avatarClasses}
        loading="lazy"
      />
    )
  }

  // Variant 2: Profile Banner — empty backdrop when no HTTPS banner URL
  if (variant === 'banner' && !safeHttpsUrl) {
    return null
  }

  // Missing or non-HTTPS URL for media/quote/thumb/upload -> fail closed
  if (!safeHttpsUrl) {
    return (
      <div
        ref={hostRef}
        className={`ag-agora-img-shield is-error variant-${variant}`}
        onClick={(e) => e.stopPropagation()}
      >
        <AlertCircle size={15} aria-hidden="true" />
        <span className="ag-agora-img-shield-title">Unable to verify image safety</span>
      </div>
    )
  }

  // Cleared SAFE -> render verified in-memory blob: URL ONLY
  if (verdict?.status === 'safe' && safeBlobUrl) {
    if (variant === 'media' && onOpenLightbox) {
      return (
        <button
          type="button"
          className="ag-agora-media-cell"
          onClick={(e) => {
            e.stopPropagation()
            onOpenLightbox(safeBlobUrl)
          }}
          aria-label={alt || 'Open image preview'}
        >
          <img src={safeBlobUrl} alt={alt || 'Attached image'} className={className} />
          {hasAltText && alt && (
            <span className="ag-agora-media-alt-badge" title={alt} aria-hidden="true">
              ALT
            </span>
          )}
        </button>
      )
    }
    return <img src={safeBlobUrl} alt={alt} className={className} />
  }

  // Explicitly revealed non-illegal NSFW image -> render verified blob: URL + Hide pill
  if (verdict?.status === 'flagged' && !isIllegal && revealedUrl) {
    if (variant === 'media' && onOpenLightbox) {
      return (
        <div className="ag-agora-media-cell is-revealed" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="ag-agora-media-reveal-hit"
            onClick={(e) => {
              e.stopPropagation()
              onOpenLightbox(revealedUrl)
            }}
            aria-label={alt || 'Open revealed image preview'}
          >
            <img src={revealedUrl} alt={alt || 'Revealed image'} className={className} />
          </button>
          {hasAltText && alt && (
            <span className="ag-agora-media-alt-badge" title={alt} aria-hidden="true">
              ALT
            </span>
          )}
          <button
            type="button"
            className="ag-agora-shield-hide-btn"
            onClick={handleHide}
            aria-label="Hide flagged image"
          >
            <EyeOff size={12} aria-hidden="true" />
            <span>Hide</span>
          </button>
        </div>
      )
    }
    return (
      <div
        className={`ag-agora-revealed-wrap variant-${variant}`}
        onClick={(e) => e.stopPropagation()}
      >
        <img src={revealedUrl} alt={alt} className={className} />
        <button
          type="button"
          className="ag-agora-shield-hide-btn"
          onClick={handleHide}
          aria-label="Hide flagged image"
        >
          <EyeOff size={11} aria-hidden="true" />
          <span>Hide</span>
        </button>
      </div>
    )
  }

  // Flagged ILLEGAL / GORE -> PERMANENTLY BLOCKED & NON-REVEALABLE
  if (verdict?.status === 'flagged' && isIllegal) {
    return (
      <div
        ref={hostRef}
        className={`ag-agora-img-shield is-illegal variant-${variant}`}
        role="region"
        aria-label="Blocked by Safety Filter: Illegal or graphic violence"
        onClick={(e) => e.stopPropagation()}
      >
        <ShieldAlert size={16} aria-hidden="true" />
        <span className="ag-agora-img-shield-title">Blocked by Safety Filter</span>
        <span className="ag-agora-img-shield-sub">Illegal / Gore</span>
      </div>
    )
  }

  // Flagged NSFW (non-illegal) or blocked sender -> veiled shield (Reveal only for NSFW)
  if (verdict?.status === 'flagged') {
    const canReveal = allowReveal && isNsfw
    return (
      <div
        ref={hostRef}
        className={`ag-agora-img-shield is-nsfw variant-${variant}`}
        role="region"
        aria-label={canReveal ? 'Hidden by Safety Filter: NSFW' : 'Blocked by Safety Filter'}
        onClick={(e) => e.stopPropagation()}
      >
        <EyeOff size={16} aria-hidden="true" />
        <span className="ag-agora-img-shield-title">
          {canReveal ? 'Hidden by Safety Filter' : 'Blocked by Safety Filter'}
        </span>
        <span className="ag-agora-img-shield-sub">
          {canReveal ? 'NSFW' : verdict.reason || 'Restricted'}
        </span>
        {canReveal && (
          <div className="ag-agora-shield-actions">
            <button type="button" className="ag-agora-shield-btn" onClick={handleReveal}>
              <Eye size={12} aria-hidden="true" />
              <span>Reveal</span>
            </button>
          </div>
        )}
      </div>
    )
  }

  // Error (CORS / network / decode failure) -> fail closed with Retry (NEVER raw external <img>)
  if (verdict?.status === 'error') {
    return (
      <div
        ref={hostRef}
        className={`ag-agora-img-shield is-error variant-${variant}`}
        role="region"
        aria-label="Unable to verify image safety"
        onClick={(e) => e.stopPropagation()}
      >
        <AlertCircle size={15} aria-hidden="true" />
        <span className="ag-agora-img-shield-title">Unable to verify image safety</span>
        <div className="ag-agora-shield-actions">
          <button type="button" className="ag-agora-shield-btn" onClick={handleRetry}>
            <RefreshCw size={12} aria-hidden="true" />
            <span>Retry</span>
          </button>
        </div>
      </div>
    )
  }

  // Idle / Downloading / Scanning -> fail-closed calm shimmer
  const scanningCopy =
    contentFilter.modelStatus === 'downloading' ? 'Loading safety filter…' : 'Scanning image…'
  return (
    <div
      ref={hostRef}
      className={`ag-agora-img-scanning variant-${variant}`}
      role="status"
      aria-live="polite"
      onClick={(e) => e.stopPropagation()}
    >
      <Loader2 size={15} className="ag-agora-spin" aria-hidden="true" />
      <span className="ag-agora-img-scanning-label">{scanningCopy}</span>
    </div>
  )
}

interface AgoraTrustGatedVideoProps {
  engine: AgnostrEngine
  item: AgoraMediaItem
  senderPubkey: string
  authorName: string
  isOwn: boolean
  compact?: boolean
  onPlaySound?: (cue: SoundCue) => void
}

const AgoraTrustGatedVideo: React.FC<AgoraTrustGatedVideoProps> = ({
  engine,
  item,
  senderPubkey,
  authorName,
  isOwn,
  compact = false,
  onPlaySound,
}) => {
  const { contentFilter } = engine
  const hostRef = useRef<HTMLDivElement | null>(null)
  const autoRequestedKeyRef = useRef<string | null>(null)
  const [inView, setInView] = useState<boolean>(
    () => typeof IntersectionObserver === 'undefined'
  )
  const [revealedThumb, setRevealedThumb] = useState<{ key: string; url: string } | null>(null)

  const isSenderTrusted = isOwn || engine.isTrusted(senderPubkey)
  const sanitizedVideoUrl = useMemo(() => sanitizeHttpUrl(item.url), [item.url])
  const safeVideoUrl = isSafeHttpsUrl(sanitizedVideoUrl) ? sanitizedVideoUrl : null
  const sanitizedThumbUrl = useMemo(() => sanitizeHttpUrl(item.thumb), [item.thumb])
  const safeThumbUrl = isSafeHttpsUrl(sanitizedThumbUrl) ? sanitizedThumbUrl : null
  const thumbCacheKey = safeThumbUrl ? makeAgoraImageCacheKey(senderPubkey, safeThumbUrl) : ''

  const thumbVerdict = thumbCacheKey ? contentFilter.getVerdict(thumbCacheKey) : null
  const safeThumbBlobUrl =
    thumbCacheKey && thumbVerdict?.status === 'safe'
      ? contentFilter.getSafeImageObjectUrl(thumbCacheKey)
      : null
  const revealedThumbUrl =
    revealedThumb && revealedThumb.key === thumbCacheKey ? revealedThumb.url : null
  const thumbIsIllegal = Boolean(thumbVerdict?.categories.includes('illegal'))
  const thumbIsNsfw = Boolean(thumbVerdict?.categories.includes('nsfw'))

  // Observe viewport entry for trusted-video thumbnail screening
  useEffect(() => {
    if (inView || !isSenderTrusted || !safeThumbUrl) return
    const el = hostRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true)
          io.disconnect()
        }
      },
      { rootMargin: '180px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [inView, isSenderTrusted, safeThumbUrl])

  // Screen trusted video thumbnail BEFORE revealing thumbnail or mounting <video>
  useEffect(() => {
    if (!isSenderTrusted || !inView || !safeThumbUrl || !thumbCacheKey) return
    const needsAutoScreen = !thumbVerdict || thumbVerdict.status === 'idle'
    const needsSafeRehydrate = thumbVerdict?.status === 'safe' && !safeThumbBlobUrl
    if (!needsAutoScreen && !needsSafeRehydrate) return
    if (autoRequestedKeyRef.current === thumbCacheKey) return
    autoRequestedKeyRef.current = thumbCacheKey
    void contentFilter.screenExternalImageUrl(thumbCacheKey, safeThumbUrl, senderPubkey, {
      caption: item.alt,
    })
  }, [
    isSenderTrusted,
    inView,
    safeThumbUrl,
    thumbCacheKey,
    thumbVerdict,
    safeThumbBlobUrl,
    contentFilter,
    senderPubkey,
    item.alt,
  ])

  // 1. UNTRUSTED SENDER -> ZERO <video> mounted and ZERO video bytes fetched!
  if (!isSenderTrusted) {
    const thumbIsSafeVisible = thumbVerdict?.status === 'safe' && Boolean(safeThumbBlobUrl)
    return (
      <div
        className={`ag-agora-video-shield${compact ? ' is-compact' : ''}`}
        role="region"
        aria-label={`Video blocked from untrusted sender ${authorName}`}
        onClick={(e) => e.stopPropagation()}
      >
        {safeThumbUrl && (
          <div className="ag-agora-video-thumb-wrap">
            <AgoraScreenedImage
              engine={engine}
              url={safeThumbUrl}
              senderPubkey={senderPubkey}
              variant="thumb"
              alt={item.alt || 'Video thumbnail'}
              caption={item.alt}
            />
            {thumbIsSafeVisible && (
              <span className="ag-agora-video-lock-badge" aria-hidden="true">
                <Lock size={13} />
                <Play size={12} />
              </span>
            )}
          </div>
        )}
        <div className="ag-agora-video-shield-body">
          <div className="ag-agora-video-shield-head">
            <ShieldAlert size={15} aria-hidden="true" />
            <span className="ag-agora-video-shield-title">Video · Untrusted Sender</span>
          </div>
          <p className="ag-agora-video-shield-sub">
            Blocked until you trust @{authorName} (zero video bytes fetched)
          </p>
          <div className="ag-agora-shield-actions">
            <button
              type="button"
              className="ag-agora-shield-btn primary"
              onClick={(e) => {
                e.stopPropagation()
                onPlaySound?.('click')
                engine.trustPubkey(senderPubkey, authorName)
              }}
            >
              <ShieldCheck size={13} aria-hidden="true" />
              <span>Trust @{authorName}</span>
            </button>
            <button
              type="button"
              className="ag-agora-shield-btn danger"
              onClick={(e) => {
                e.stopPropagation()
                onPlaySound?.('click')
                engine.toggleBlockPeer(senderPubkey, authorName)
              }}
            >
              <Ban size={13} aria-hidden="true" />
              <span>Block</span>
            </button>
          </div>
        </div>
      </div>
    )
  }

  // 2. TRUSTED SENDER with thumbnail -> gate video playback behind thumbnail safety verdict
  if (safeThumbUrl) {
    if (thumbVerdict?.status === 'flagged' && thumbIsIllegal) {
      return (
        <div
          ref={hostRef}
          className={`ag-agora-img-shield is-illegal variant-media${compact ? ' is-compact' : ''}`}
          role="region"
          aria-label="Video blocked by Safety Filter: Illegal or graphic violence"
          onClick={(e) => e.stopPropagation()}
        >
          <ShieldAlert size={16} aria-hidden="true" />
          <span className="ag-agora-img-shield-title">Blocked by Safety Filter</span>
          <span className="ag-agora-img-shield-sub">Illegal / Gore</span>
        </div>
      )
    }

    if (thumbVerdict?.status === 'flagged' && !revealedThumbUrl) {
      return (
        <div
          ref={hostRef}
          className={`ag-agora-img-shield is-nsfw variant-media${compact ? ' is-compact' : ''}`}
          role="region"
          aria-label="Video hidden by Safety Filter: NSFW"
          onClick={(e) => e.stopPropagation()}
        >
          <EyeOff size={16} aria-hidden="true" />
          <span className="ag-agora-img-shield-title">
            {thumbIsNsfw ? 'Hidden by Safety Filter' : 'Blocked by Safety Filter'}
          </span>
          <span className="ag-agora-img-shield-sub">
            {thumbIsNsfw ? 'NSFW' : thumbVerdict.reason || 'Restricted'}
          </span>
          {thumbIsNsfw && (
            <div className="ag-agora-shield-actions">
              <button
                type="button"
                className="ag-agora-shield-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  const blobUrl = contentFilter.revealFlaggedImage(thumbCacheKey)
                  if (blobUrl) {
                    setRevealedThumb({ key: thumbCacheKey, url: blobUrl })
                  }
                }}
              >
                <Eye size={12} aria-hidden="true" />
                <span>Reveal</span>
              </button>
            </div>
          )}
        </div>
      )
    }

    if (thumbVerdict?.status === 'error') {
      return (
        <div
          ref={hostRef}
          className={`ag-agora-img-shield is-error variant-media${compact ? ' is-compact' : ''}`}
          role="region"
          aria-label="Unable to verify video thumbnail safety"
          onClick={(e) => e.stopPropagation()}
        >
          <AlertCircle size={15} aria-hidden="true" />
          <span className="ag-agora-img-shield-title">Unable to verify image safety</span>
          <div className="ag-agora-shield-actions">
            <button
              type="button"
              className="ag-agora-shield-btn"
              onClick={(e) => {
                e.stopPropagation()
                autoRequestedKeyRef.current = thumbCacheKey
                void contentFilter.screenExternalImageUrl(
                  thumbCacheKey,
                  safeThumbUrl,
                  senderPubkey,
                  { caption: item.alt, skipCache: true }
                )
              }}
            >
              <RefreshCw size={12} aria-hidden="true" />
              <span>Retry</span>
            </button>
          </div>
        </div>
      )
    }

    const verifiedPosterUrl = safeThumbBlobUrl ?? revealedThumbUrl
    if (!verifiedPosterUrl) {
      const scanningCopy =
        contentFilter.modelStatus === 'downloading'
          ? 'Loading safety filter…'
          : 'Scanning image…'
      return (
        <div
          ref={hostRef}
          className={`ag-agora-img-scanning variant-media${compact ? ' is-compact' : ''}`}
          role="status"
          aria-live="polite"
          onClick={(e) => e.stopPropagation()}
        >
          <Loader2 size={15} className="ag-agora-spin" aria-hidden="true" />
          <span className="ag-agora-img-scanning-label">{scanningCopy}</span>
        </div>
      )
    }

    if (!safeVideoUrl) return null
    return (
      <video
        src={safeVideoUrl}
        poster={verifiedPosterUrl}
        controls
        playsInline
        preload="metadata"
        className={`ag-agora-media-video${compact ? ' is-compact' : ''}`}
      />
    )
  }

  // 3. TRUSTED SENDER without thumbnail -> render native <video>
  if (!safeVideoUrl) return null
  return (
    <video
      src={safeVideoUrl}
      controls
      playsInline
      preload="metadata"
      className={`ag-agora-media-video${compact ? ' is-compact' : ''}`}
    />
  )
}

/* --------------------------------------------------------------------------
   Screened Avatar with Deterministic Geometric Identicon Fallback
   -------------------------------------------------------------------------- */
const AgoraAvatar: React.FC<{
  engine: AgnostrEngine
  pubkey: string
  picture?: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  alt?: string
  className?: string
}> = ({ engine, pubkey, picture, size = 'md', alt = '', className }) => {
  return (
    <AgoraScreenedImage
      engine={engine}
      url={picture}
      senderPubkey={pubkey}
      avatarFallbackPubkey={pubkey}
      variant="avatar"
      avatarSize={size}
      alt={alt}
      className={className}
      allowReveal={false}
    />
  )
}

/* --------------------------------------------------------------------------
   Real NIP-05 Verification Badge (Lazy DNS/HTTPS verified; emerald only when verified)
   -------------------------------------------------------------------------- */
const AgoraNip05Badge: React.FC<{
  engine: AgnostrEngine
  pubkey: string
  rawNip05?: string
  fullWidth?: boolean
  iconSize?: number
}> = ({ engine, pubkey, rawNip05, fullWidth = false, iconSize = 12 }) => {
  const { agora } = engine
  const display = formatNip05Display(rawNip05)

  useEffect(() => {
    if (rawNip05 && pubkey) {
      agora.ensureNip05Verified(pubkey, rawNip05)
    }
  }, [agora, pubkey, rawNip05])

  if (!display) return null
  const pkLower = pubkey.toLowerCase()
  const status =
    agora.nip05StatusByPubkey[pkLower] ?? agora.nip05StatusByPubkey[pubkey] ?? 'unverified'

  if (status === 'invalid') return null

  const verified = status === 'verified'
  return (
    <span
      className={`ag-agora-nip05${verified ? ' is-verified' : ' is-unverified'}`}
      style={fullWidth ? { maxWidth: 'none' } : undefined}
      title={verified ? `Verified NIP-05: ${display}` : display}
    >
      {verified && (
        <BadgeCheck size={iconSize} className="ag-agora-nip05-badge" aria-hidden="true" />
      )}
      <span className="truncate">{display}</span>
    </span>
  )
}

/* --------------------------------------------------------------------------
   Shimmer Loading Skeleton Card
   -------------------------------------------------------------------------- */
const AgoraSkeletonCard: React.FC = () => (
  <div className="ag-agora-skeleton-card" aria-hidden="true">
    <div className="ag-agora-skeleton-avatar" />
    <div className="ag-agora-skeleton-main">
      <div className="ag-agora-skeleton-line w-38" />
      <div className="ag-agora-skeleton-line w-92" />
      <div className="ag-agora-skeleton-line w-74" />
      <div className="ag-agora-skeleton-actions">
        <span className="ag-agora-skeleton-pill" />
        <span className="ag-agora-skeleton-pill" />
        <span className="ag-agora-skeleton-pill" />
        <span className="ag-agora-skeleton-pill" />
      </div>
    </div>
  </div>
)

/* --------------------------------------------------------------------------
   Profile Following / Followers List Modal
   -------------------------------------------------------------------------- */
const AgoraSocialListModal: React.FC<{
  engine: AgnostrEngine
  title: string
  pubkeys: readonly string[]
  onOpenProfile: (pubkey: string) => void
  onToggleFollow: (pubkey: string) => void
  onClose: () => void
}> = ({ engine, title, pubkeys, onOpenProfile, onToggleFollow, onClose }) => {
  const { agora } = engine

  useBackHandler(true, onClose)

  useEffect(() => {
    if (pubkeys.length > 0) {
      agora.ensureProfiles(pubkeys.slice(0, 80))
    }
  }, [agora, pubkeys])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const modal = (
    <div
      className="ag-agora-modal-backdrop"
      role="presentation"
      data-no-swipe="true"
      onClick={onClose}
    >
      <div
        className="ag-agora-modal ag-agora-social-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ag-agora-modal-head">
          <div className="ag-agora-social-modal-title-wrap">
            <h3 className="ag-agora-modal-title">{title}</h3>
            <span className="ag-badge ag-badge-muted mono tabular">{pubkeys.length}</span>
          </div>
          <button
            type="button"
            className="ag-agora-icon-btn"
            onClick={onClose}
            aria-label={`Close ${title}`}
          >
            <X size={17} />
          </button>
        </header>

        <div className="ag-agora-modal-body">
          {pubkeys.length === 0 ? (
            <div className="ag-agora-empty">
              <Users size={20} />
              <p className="ag-agora-empty-sub">No accounts found yet.</p>
            </div>
          ) : (
            <div className="ag-agora-voice-list">
              {pubkeys.slice(0, 120).map((pk) => {
                const prof: AgoraProfile = agora.getProfile(pk) ?? {
                  pubkey: pk,
                  npub: encodeNpubSafe(pk),
                  updatedAt: 0,
                }
                return (
                  <AgoraVoiceRow
                    key={pk}
                    engine={engine}
                    profile={prof}
                    isSelf={pk.toLowerCase() === agora.myPubkey.toLowerCase()}
                    following={agora.isFollowing(pk)}
                    onOpenProfile={(targetPk) => {
                      onClose()
                      onOpenProfile(targetPk)
                    }}
                    onToggleFollow={onToggleFollow}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal
}

/* --------------------------------------------------------------------------
   Embedded Quoted Note Card
   -------------------------------------------------------------------------- */
const AgoraQuotedNoteCard: React.FC<{
  eventId: string
  engine: AgnostrEngine
  translationScopeKey: string
  showOriginalKeys: Set<string>
  onToggleShowOriginal: (key: string) => void
  onOpenThread: (noteId: string) => void
  onOpenProfile: (pubkey: string) => void
  onSelectHashtag: (tag: string) => void
}> = ({
  eventId,
  engine,
  translationScopeKey,
  showOriginalKeys,
  onToggleShowOriginal,
  onOpenThread,
  onOpenProfile,
  onSelectHashtag,
}) => {
  const { agora, translator } = engine
  const note = agora.getNote(eventId)
  const profile = note ? agora.getProfile(note.pubkey) : null

  useEffect(() => {
    if (!note) {
      agora.ensureNotes([eventId])
    } else if (!profile) {
      agora.ensureProfiles([note.pubkey])
    }
  }, [agora, eventId, note, profile])

  const translatorEnabled = translator.settings.enabled
  const myLanguage = translator.settings.myLanguage
  const sourceLanguage = translator.settings.sourceLanguage
  const explicitSourceLang = sourceLanguage !== 'Auto' ? sourceLanguage : undefined

  const translatableText = useMemo(
    () => (note ? extractTranslatableAgoraText(note) : null),
    [note]
  )
  const translationEntry =
    note && translatorEnabled && translatableText
      ? translator.translations[
          translationCacheKey(`agora:${note.id}`, myLanguage, explicitSourceLang)
        ]
      : undefined

  const hasMeaningfulTranslation = Boolean(
    note &&
      translatorEnabled &&
      translatableText &&
      translationEntry?.status === 'done' &&
      !translationEntry.sameLanguage &&
      translationEntry.text?.trim() &&
      textsDifferMeaningfully(translatableText, translationEntry.text)
  )
  const origToggleKey = note ? agoraShowOriginalKey(note.id, myLanguage, sourceLanguage) : ''
  const showingOriginal = Boolean(origToggleKey) && showOriginalKeys.has(origToggleKey)
  const useTranslatedBody = hasMeaningfulTranslation && !showingOriginal

  const displayTokens = useMemo(() => {
    if (!note) return []
    const sourceText =
      useTranslatedBody && translationEntry?.text ? translationEntry.text : note.content
    return tokenizeAgoraContent(sourceText, note.media)
  }, [note, translationEntry?.text, useTranslatedBody])

  const translatedFromLabel = useMemo(
    () =>
      useTranslatedBody
        ? resolveAgoraTranslatedFromLabel(translationEntry, myLanguage, explicitSourceLang)
        : null,
    [explicitSourceLang, myLanguage, translationEntry, useTranslatedBody]
  )

  const translationLoading =
    Boolean(note) &&
    translatorEnabled &&
    Boolean(translatableText) &&
    translationEntry?.status === 'loading'
  const translationErrored =
    Boolean(note) &&
    translatorEnabled &&
    Boolean(translatableText) &&
    translationEntry?.status === 'error'

  if (!note) {
    return (
      <div
        className="ag-agora-quote-card"
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation()
          onOpenThread(eventId)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            onOpenThread(eventId)
          }
        }}
      >
        <div className="ag-agora-quote-head">
          <Quote size={12} />
          <span className="mono">{encodeNoteEventId(eventId).slice(0, 24)}…</span>
        </div>
        <div className="ag-agora-quote-body">Loading quoted note…</div>
      </div>
    )
  }

  const authorName = getProfileDisplayName(profile, note.pubkey)
  const isQuotedOwn = note.pubkey.toLowerCase() === agora.myPubkey.toLowerCase()
  const firstImg = note.media.find((m) => m.kind === 'image')
  const firstVideo = !firstImg ? note.media.find((m) => m.kind === 'video') : undefined
  const hasVisibleText = displayTokens.some((t) => t.type !== 'quote')

  return (
    <div
      className="ag-agora-quote-card"
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation()
        onOpenThread(note.id)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          onOpenThread(note.id)
        }
      }}
    >
      <div className="ag-agora-quote-head">
        <AgoraAvatar
          engine={engine}
          pubkey={note.pubkey}
          picture={profile?.picture}
          size="xs"
          alt={authorName}
        />
        <span className="ag-agora-quote-author">{authorName}</span>
        <span className="ag-agora-dot-sep">·</span>
        <span className="ag-agora-time tabular">{formatRelativeSeconds(note.createdAt)}</span>
      </div>
      {hasVisibleText && (
        <div className="ag-agora-quote-body">
          {displayTokens.map((tok, idx) => {
            if (tok.type === 'text') {
              return <React.Fragment key={idx}>{tok.text}</React.Fragment>
            }
            if (tok.type === 'hashtag') {
              return (
                <button
                  key={idx}
                  type="button"
                  className="ag-agora-tag-link"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelectHashtag(tok.tag)
                  }}
                >
                  #{tok.tag}
                </button>
              )
            }
            if (tok.type === 'mention') {
              const mProfile = agora.getProfile(tok.pubkey)
              const mName = getProfileDisplayName(mProfile, tok.pubkey)
              return (
                <button
                  key={idx}
                  type="button"
                  className="ag-agora-mention-link"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenProfile(tok.pubkey)
                  }}
                >
                  @{mName}
                </button>
              )
            }
            if (tok.type === 'link') {
              const warnUntrustedLinks =
                note.pubkey.toLowerCase() !== agora.myPubkey.toLowerCase() &&
                !engine.isTrusted(note.pubkey) &&
                !engine.settings.allowUntrustedLinks
              return (
                <a
                  key={idx}
                  href={tok.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`ag-agora-ext-link${warnUntrustedLinks ? ' ag-untrusted-link' : ''}`}
                  title={
                    warnUntrustedLinks
                      ? 'Untrusted sender — click to review link before opening'
                      : undefined
                  }
                  onClick={(e) => {
                    e.stopPropagation()
                    if (warnUntrustedLinks) {
                      e.preventDefault()
                      requestUntrustedLinkOpen({
                        url: tok.url,
                        senderHandle: authorName,
                        senderPubkey: note.pubkey,
                      })
                      return
                    }
                    if (parseAgoraShareUrl(tok.url) && tryOpenInternalAgoraLink(tok.url)) {
                      e.preventDefault()
                    }
                  }}
                  onAuxClick={(e) => {
                    if (warnUntrustedLinks && e.button === 1) {
                      e.preventDefault()
                      e.stopPropagation()
                      requestUntrustedLinkOpen({
                        url: tok.url,
                        senderHandle: authorName,
                        senderPubkey: note.pubkey,
                      })
                    }
                  }}
                >
                  {tok.display}
                </a>
              )
            }
            return null
          })}
        </div>
      )}
      {(hasMeaningfulTranslation || translationLoading || translationErrored) && (
        <div
          className="ag-agora-tr-note-foot ag-agora-quote-tr-foot"
          onClick={(e) => e.stopPropagation()}
        >
          {hasMeaningfulTranslation ? (
            <>
              {!showingOriginal && translatedFromLabel && (
                <span className="ag-agora-tr-badge">
                  <Languages size={11} aria-hidden="true" />
                  <span>{translatedFromLabel}</span>
                </span>
              )}
              <button
                type="button"
                className="ag-agora-tr-toggle-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleShowOriginal(origToggleKey)
                }}
              >
                {showingOriginal ? 'Show translation' : 'Show original'}
              </button>
            </>
          ) : translationLoading ? (
            <span className="ag-agora-tr-status-pill" aria-live="polite">
              <Loader2 size={11} className="ag-agora-spin" aria-hidden="true" />
              <span>
                {translator.modelStatus === 'downloading' ? 'Loading model…' : 'Translating…'}
              </span>
            </span>
          ) : (
            <button
              type="button"
              className="ag-agora-tr-retry-btn"
              title={translationEntry?.error || 'Retry translating this quoted post'}
              onClick={(e) => {
                e.stopPropagation()
                if (!translatableText) return
                void translator.translateMessage(`agora:${note.id}`, translatableText, myLanguage, {
                  sourceLang: explicitSourceLang ?? 'Auto',
                  scopeKey: translationScopeKey,
                  priority: 'visible',
                })
              }}
            >
              <AlertCircle size={11} aria-hidden="true" />
              <span>Translation failed · Retry</span>
            </button>
          )}
        </div>
      )}
      {firstImg && (
        <AgoraScreenedImage
          engine={engine}
          url={firstImg.url}
          senderPubkey={note.pubkey}
          variant="quote"
          alt={firstImg.alt || 'Quoted media'}
          caption={firstImg.alt}
          className="ag-agora-quote-thumb"
        />
      )}
      {firstVideo && (
        <div className="ag-agora-quote-video-wrap" onClick={(e) => e.stopPropagation()}>
          <AgoraTrustGatedVideo
            engine={engine}
            item={firstVideo}
            senderPubkey={note.pubkey}
            authorName={authorName}
            isOwn={isQuotedOwn}
            compact={true}
          />
        </div>
      )}
    </div>
  )
}

/* --------------------------------------------------------------------------
   Rich Note Card (Feed, Thread Ancestor, Thread Focus, Thread Reply, Profile)
   -------------------------------------------------------------------------- */
interface AgoraNoteCardProps {
  note: AgoraNote
  repostedBy?: string
  repostedByList?: string[]
  engine: AgnostrEngine
  focused?: boolean
  isAncestor?: boolean
  showThreadConnector?: boolean
  kbdFocused?: boolean
  kbdIndex?: number
  revealedCw: boolean
  onRevealCw: (noteId: string) => void
  translationScopeKey: string
  showOriginalKeys: Set<string>
  onToggleShowOriginal: (key: string) => void
  onOpenThread: (noteId: string) => void
  onOpenProfile: (pubkey: string) => void
  onSelectHashtag: (tag: string) => void
  onReplyClick: (note: AgoraNote) => void
  onQuoteClick: (note: AgoraNote) => void
  onOpenDm: (pubkey: string, nickname?: string) => void
  onOpenAmailCompose?: (pubkey: string, nickname?: string) => void
  onOpenZap?: (target: ZapTarget) => void
  onOpenLightbox?: (payload: LightboxImagePayload) => void
  onHoverAuthorStart?: (pubkey: string, el: HTMLElement) => void
  onHoverAuthorEnd?: () => void
  onPlaySound?: (cue: SoundCue) => void
}

const AgoraNoteCard: React.FC<AgoraNoteCardProps> = ({
  note,
  repostedBy,
  repostedByList,
  engine,
  focused = false,
  isAncestor = false,
  showThreadConnector = false,
  kbdFocused = false,
  kbdIndex,
  revealedCw,
  onRevealCw,
  translationScopeKey,
  showOriginalKeys,
  onToggleShowOriginal,
  onOpenThread,
  onOpenProfile,
  onSelectHashtag,
  onReplyClick,
  onQuoteClick,
  onOpenDm,
  onOpenAmailCompose,
  onOpenZap,
  onOpenLightbox,
  onHoverAuthorStart,
  onHoverAuthorEnd,
  onPlaySound,
}) => {
  const { agora, translator } = engine
  const [menuOpen, setMenuOpen] = useState(false)
  const [repostMenuOpen, setRepostMenuOpen] = useState(false)
  const [zapMenuOpen, setZapMenuOpen] = useState(false)
  const [quickZappingSats, setQuickZappingSats] = useState<number | null>(null)
  const [zapBurstActive, setZapBurstActive] = useState(false)
  const [expandedLong, setExpandedLong] = useState(false)
  const [zapTooltip, setZapTooltip] = useState<{
    left: number
    top: number
    placement: 'above' | 'below'
  } | null>(null)
  const menuWrapRef = useRef<HTMLDivElement | null>(null)
  const repostWrapRef = useRef<HTMLDivElement | null>(null)
  const zapWrapRef = useRef<HTMLDivElement | null>(null)
  const verifiedBlobsRef = useRef<Map<string, string>>(new Map())
  const zapBurstTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (zapBurstTimerRef.current !== null) {
        window.clearTimeout(zapBurstTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!zapTooltip) return
    const dismiss = () => setZapTooltip(null)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [zapTooltip])

  useEffect(() => {
    if (!menuOpen && !repostMenuOpen && !zapMenuOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (menuOpen && menuWrapRef.current && target && !menuWrapRef.current.contains(target)) {
        setMenuOpen(false)
      }
      if (
        repostMenuOpen &&
        repostWrapRef.current &&
        target &&
        !repostWrapRef.current.contains(target)
      ) {
        setRepostMenuOpen(false)
      }
      if (zapMenuOpen && zapWrapRef.current && target && !zapWrapRef.current.contains(target)) {
        setZapMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        setRepostMenuOpen(false)
        setZapMenuOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen, repostMenuOpen, zapMenuOpen])

  const authorProfile = agora.getProfile(note.pubkey)
  const authorName = getProfileDisplayName(authorProfile, note.pubkey)
  const effectiveReposters = useMemo(() => {
    if (repostedByList && repostedByList.length > 0) return repostedByList
    return repostedBy ? [repostedBy] : []
  }, [repostedBy, repostedByList])
  const primaryReposterPk = effectiveReposters[0]
  const reposterProfile = primaryReposterPk ? agora.getProfile(primaryReposterPk) : null
  const reposterName = primaryReposterPk
    ? getProfileDisplayName(reposterProfile, primaryReposterPk)
    : null
  const extraReposterCount = Math.max(0, effectiveReposters.length - 1)

  const stats = agora.getNoteStats(note.id)
  const isSelf = note.pubkey.toLowerCase() === agora.myPubkey.toLowerCase()
  const following = agora.isFollowing(note.pubkey)
  const bookmarked = agora.isBookmarked(note.id)
  const threadRootId = note.rootId || note.id
  const threadMuted = agora.isThreadMuted(threadRootId)
  const inlinePoll = agora.pollsById[note.id]

  const originalTokens = useMemo(
    () => tokenizeAgoraContent(note.content, note.media),
    [note.content, note.media]
  )

  const embeddedQuoteIds = useMemo(() => {
    const ids = new Set<string>()
    for (const tok of originalTokens) {
      if (tok.type === 'quote') ids.add(tok.eventId)
    }
    for (const qid of note.quoteIds) {
      ids.add(qid)
    }
    return Array.from(ids).slice(0, 2)
  }, [note.quoteIds, originalTokens])

  const translatorEnabled = translator.settings.enabled
  const myLanguage = translator.settings.myLanguage
  const sourceLanguage = translator.settings.sourceLanguage
  const explicitSourceLang = sourceLanguage !== 'Auto' ? sourceLanguage : undefined

  const translatableText = useMemo(() => extractTranslatableAgoraText(note), [note])
  const translationEntry =
    translatorEnabled && translatableText
      ? translator.translations[
          translationCacheKey(`agora:${note.id}`, myLanguage, explicitSourceLang)
        ]
      : undefined

  const hasMeaningfulTranslation = Boolean(
    translatorEnabled &&
      translatableText &&
      translationEntry?.status === 'done' &&
      !translationEntry.sameLanguage &&
      translationEntry.text?.trim() &&
      textsDifferMeaningfully(translatableText, translationEntry.text)
  )
  const origToggleKey = agoraShowOriginalKey(note.id, myLanguage, sourceLanguage)
  const showingOriginal = showOriginalKeys.has(origToggleKey)
  const useTranslatedBody = hasMeaningfulTranslation && !showingOriginal

  const activeBodyText =
    useTranslatedBody && translationEntry?.text ? translationEntry.text : note.content

  const displayTokens = useMemo(
    () =>
      useTranslatedBody && translationEntry?.text
        ? tokenizeAgoraContent(translationEntry.text, note.media)
        : originalTokens,
    [note.media, originalTokens, translationEntry?.text, useTranslatedBody]
  )

  const contentBlocks = useMemo(
    () => parseRichContentBlocks(activeBodyText),
    [activeBodyText]
  )

  const isLongNote = useMemo(() => {
    if (focused) return false
    if (activeBodyText.length > 560) return true
    let lineBreaks = 0
    for (let i = 0; i < activeBodyText.length; i += 1) {
      if (activeBodyText.charCodeAt(i) === 10) {
        lineBreaks += 1
        if (lineBreaks >= 10) return true
      }
    }
    return false
  }, [activeBodyText, focused])

  const isClamped = isLongNote && !expandedLong

  const translatedFromLabel = useMemo(
    () =>
      useTranslatedBody
        ? resolveAgoraTranslatedFromLabel(translationEntry, myLanguage, explicitSourceLang)
        : null,
    [explicitSourceLang, myLanguage, translationEntry, useTranslatedBody]
  )

  const translationLoading =
    translatorEnabled && Boolean(translatableText) && translationEntry?.status === 'loading'
  const translationErrored =
    translatorEnabled && Boolean(translatableText) && translationEntry?.status === 'error'

  const mediaSlice = useMemo(() => note.media.slice(0, 4), [note.media])
  const needsCwGate = Boolean(note.contentWarning) && !revealedCw

  const handleCopyShareLink = async () => {
    const shareUrl = buildAgoraNoteShareUrl(note.id, note.pubkey, agora.socialRelays)
    const ok = await copyTextSafe(shareUrl)
    if (ok) {
      onPlaySound?.('click')
      engine.pushToast('success', 'Agora post link copied', shareUrl)
    } else {
      engine.pushToast('error', 'Clipboard copy failed')
    }
  }

  const handleCopyNevent = async () => {
    const nevent = encodeNoteEventId(note.id, note.pubkey, agora.socialRelays)
    const ok = await copyTextSafe(`nostr:${nevent}`)
    if (ok) {
      onPlaySound?.('click')
      engine.pushToast('success', 'Note link copied', `nostr:${nevent.slice(0, 20)}…`)
    }
  }

  const handleOpenMediaLightbox = (item: AgoraMediaItem, verifiedBlobUrl: string) => {
    if (!onOpenLightbox || item.kind !== 'image' || !verifiedBlobUrl) return
    verifiedBlobsRef.current.set(item.url, verifiedBlobUrl)

    const galleryEntries: Array<{
      blobUrl: string
      image: ImageAttachment
      caption?: string
    }> = []
    let clickedIndex = 0

    for (const m of mediaSlice) {
      if (m.kind !== 'image') continue
      const safeUrl = sanitizeHttpUrl(m.url)
      const cacheKey =
        safeUrl && isSafeHttpsUrl(safeUrl) ? makeAgoraImageCacheKey(note.pubkey, safeUrl) : ''
      const resolvedBlob =
        (m.url === item.url ? verifiedBlobUrl : null) ||
        verifiedBlobsRef.current.get(m.url) ||
        (cacheKey ? engine.contentFilter.getSafeImageObjectUrl(cacheKey) : null) ||
        null
      if (!resolvedBlob) continue
      if (m.url === item.url) {
        clickedIndex = galleryEntries.length
      }
      const dims = parseDimTuple(m.dim)
      galleryEntries.push({
        blobUrl: resolvedBlob,
        image: {
          url: m.url,
          mime: m.mime || 'image/jpeg',
          sha256: '',
          size: 0,
          width: dims.width,
          height: dims.height,
          alt: m.alt,
        },
      })
    }

    const { width, height } = parseDimTuple(item.dim)
    onOpenLightbox({
      blobUrl: verifiedBlobUrl,
      image: {
        url: item.url,
        mime: item.mime || 'image/jpeg',
        sha256: '',
        size: 0,
        width,
        height,
        alt: item.alt,
      },
      senderDisplayHandle: authorName,
      gallery: galleryEntries.length > 1 ? galleryEntries : undefined,
      initialIndex: galleryEntries.length > 1 ? clickedIndex : undefined,
    })
  }

  const buildZapTarget = (): ZapTarget => ({
    pubkey: note.pubkey,
    nickname: authorName,
    lud16: authorProfile?.lud16 ?? engine.zaps.getPeerLightningAddress(note.pubkey) ?? null,
    eventId: note.id,
    channelLabel: 'Agora',
  })

  const handleZap = () => {
    onPlaySound?.('click')
    onOpenZap?.(buildZapTarget())
  }

  const handleQuickZap = async (sats: number) => {
    setZapMenuOpen(false)
    setZapTooltip(null)
    if (quickZappingSats !== null) return

    const target = buildZapTarget()
    if (engine.wallet.credentialsLocked || engine.wallet.totalBalanceSats < sats) {
      if (onOpenZap) {
        onPlaySound?.('click')
        onOpenZap(target)
      } else {
        engine.pushToast(
          'info',
          'Wallet balance required',
          `Need at least ${sats.toLocaleString()} sats unlocked in your Agwallet.`
        )
      }
      return
    }

    setQuickZappingSats(sats)
    try {
      let zapped = false
      const resolvedLud16 = target.lud16?.trim() || null

      if (resolvedLud16) {
        try {
          const inv = await engine.zaps.requestZapInvoice({ target, amountSats: sats })
          const payRes = await engine.wallet.payBolt11Invoice(inv.invoice, {
            counterparty: authorName,
            memo: `Zap ${authorName} on Agora`,
            txType: 'zap_out',
          })
          zapped = Boolean(payRes.paid)
        } catch {
          // Fall back to NIP-61 Nutzap below
        }
      }

      if (!zapped) {
        try {
          await engine.zaps.sendNutzap({ target, amountSats: sats })
          zapped = true
        } catch {
          // Fall through to full ZapModal so user can see options/QR
        }
      }

      if (zapped) {
        agora.recordOptimisticZap(note.id, sats)
        onPlaySound?.('send')
        setZapBurstActive(true)
        if (zapBurstTimerRef.current !== null) {
          window.clearTimeout(zapBurstTimerRef.current)
        }
        zapBurstTimerRef.current = window.setTimeout(() => {
          zapBurstTimerRef.current = null
          setZapBurstActive(false)
        }, 680)
        engine.pushToast('success', `Zapped ${sats.toLocaleString()} sats`, `Sent to ${authorName}`)
      } else if (onOpenZap) {
        onOpenZap(target)
      } else {
        engine.pushToast('warning', 'Quick zap unavailable', 'Open the Zap dialog to choose a payment method.')
      }
    } finally {
      setQuickZappingSats(null)
    }
  }

  const renderInlineTokens = (source: string) => {
    const toks = tokenizeAgoraContent(source, note.media)
    return toks.map((tok, idx) => {
      if (tok.type === 'text') {
        return <React.Fragment key={idx}>{tok.text}</React.Fragment>
      }
      if (tok.type === 'hashtag') {
        return (
          <button
            key={idx}
            type="button"
            className="ag-agora-tag-link"
            onClick={(e) => {
              e.stopPropagation()
              onSelectHashtag(tok.tag)
            }}
          >
            #{tok.tag}
          </button>
        )
      }
      if (tok.type === 'mention') {
        const mProfile = agora.getProfile(tok.pubkey)
        const mName = getProfileDisplayName(mProfile, tok.pubkey)
        return (
          <button
            key={idx}
            type="button"
            className="ag-agora-mention-link"
            onClick={(e) => {
              e.stopPropagation()
              onOpenProfile(tok.pubkey)
            }}
            onMouseEnter={(e) => onHoverAuthorStart?.(tok.pubkey, e.currentTarget)}
            onMouseLeave={() => onHoverAuthorEnd?.()}
          >
            @{mName}
          </button>
        )
      }
      if (tok.type === 'link') {
        const warnUntrustedLinks =
          !isSelf && !engine.isTrusted(note.pubkey) && !engine.settings.allowUntrustedLinks
        return (
          <a
            key={idx}
            href={tok.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`ag-agora-ext-link${warnUntrustedLinks ? ' ag-untrusted-link' : ''}`}
            title={
              warnUntrustedLinks
                ? 'Untrusted sender — click to review link before opening'
                : undefined
            }
            onClick={(e) => {
              e.stopPropagation()
              if (warnUntrustedLinks) {
                e.preventDefault()
                requestUntrustedLinkOpen({
                  url: tok.url,
                  senderHandle: authorName,
                  senderPubkey: note.pubkey,
                })
                return
              }
              if (parseAgoraShareUrl(tok.url) && tryOpenInternalAgoraLink(tok.url)) {
                e.preventDefault()
              }
            }}
            onAuxClick={(e) => {
              if (warnUntrustedLinks && e.button === 1) {
                e.preventDefault()
                e.stopPropagation()
                requestUntrustedLinkOpen({
                  url: tok.url,
                  senderHandle: authorName,
                  senderPubkey: note.pubkey,
                })
              }
            }}
          >
            {tok.display}
          </a>
        )
      }
      return null
    })
  }

  const cardClasses = [
    'ag-agora-card',
    !focused ? 'is-clickable' : 'is-focused',
    isAncestor ? 'is-ancestor' : '',
    kbdFocused ? 'is-kbd-focused' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <article
      className={cardClasses}
      data-agora-kbd-idx={kbdIndex !== undefined ? String(kbdIndex) : undefined}
      onClick={() => {
        if (!focused) onOpenThread(note.id)
      }}
    >
      {primaryReposterPk && reposterName && (
        <div className="ag-agora-repost-bar">
          <Repeat2 size={13} aria-hidden="true" />
          <span>Reposted by</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onOpenProfile(primaryReposterPk)
            }}
            onMouseEnter={(e) => onHoverAuthorStart?.(primaryReposterPk, e.currentTarget)}
            onMouseLeave={() => onHoverAuthorEnd?.()}
          >
            {reposterName}
          </button>
          {extraReposterCount > 0 && (
            <span>
              and {extraReposterCount} {extraReposterCount === 1 ? 'other' : 'others'}
            </span>
          )}
        </div>
      )}

      <div className="ag-agora-card-row">
        <div className="ag-agora-avatar-col">
          <button
            type="button"
            className="ag-agora-avatar-btn"
            onClick={(e) => {
              e.stopPropagation()
              onOpenProfile(note.pubkey)
            }}
            onMouseEnter={(e) => onHoverAuthorStart?.(note.pubkey, e.currentTarget)}
            onMouseLeave={() => onHoverAuthorEnd?.()}
            aria-label={`View ${authorName}'s profile`}
          >
            <AgoraAvatar
              engine={engine}
              pubkey={note.pubkey}
              picture={authorProfile?.picture}
              size="md"
              alt={authorName}
            />
          </button>
          {showThreadConnector && <div className="ag-agora-thread-line" aria-hidden="true" />}
        </div>

        <div className="ag-agora-card-main">
          <div className="ag-agora-card-head">
            <div className="ag-agora-author-meta">
              <button
                type="button"
                className="ag-agora-author-name"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenProfile(note.pubkey)
                }}
                onMouseEnter={(e) => onHoverAuthorStart?.(note.pubkey, e.currentTarget)}
                onMouseLeave={() => onHoverAuthorEnd?.()}
              >
                {authorName}
              </button>
              <AgoraNip05Badge
                engine={engine}
                pubkey={note.pubkey}
                rawNip05={authorProfile?.nip05}
              />
              <span className="ag-agora-dot-sep" aria-hidden="true">
                ·
              </span>
              <time
                className="ag-agora-time tabular"
                dateTime={new Date(note.createdAt * 1000).toISOString()}
                title={formatFullDateTime(note.createdAt)}
              >
                {formatRelativeSeconds(note.createdAt)}
              </time>
            </div>

            <div className="ag-agora-card-head-right" ref={menuWrapRef}>
              {!isSelf && !following && !focused && (
                <button
                  type="button"
                  className="ag-agora-follow-micro"
                  onClick={(e) => {
                    e.stopPropagation()
                    onPlaySound?.('click')
                    void agora.toggleFollow(note.pubkey)
                  }}
                >
                  Follow
                </button>
              )}

              <button
                type="button"
                className="ag-agora-icon-btn"
                style={{ width: 28, height: 28 }}
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen((v) => !v)
                  setRepostMenuOpen(false)
                  setZapMenuOpen(false)
                }}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="More options"
              >
                <MoreHorizontal size={15} />
              </button>

              {menuOpen && (
                <div
                  className="ag-agora-menu-popover"
                  role="menu"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="ag-agora-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      void handleCopyShareLink()
                    }}
                  >
                    <Link2 size={14} />
                    <span>Copy Link</span>
                  </button>
                  <button
                    type="button"
                    className="ag-agora-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      void handleCopyNevent()
                    }}
                  >
                    <Copy size={14} />
                    <span>Copy nevent1</span>
                  </button>
                  <button
                    type="button"
                    className="ag-agora-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      onPlaySound?.('click')
                      if (threadMuted) {
                        void agora.unmuteThread(threadRootId).then((ok) => {
                          if (ok) engine.pushToast('info', 'Thread unmuted')
                        })
                      } else {
                        void agora.muteThread(threadRootId).then((ok) => {
                          if (ok) engine.pushToast('info', 'Thread muted', 'Notifications suppressed for this thread.')
                        })
                      }
                    }}
                  >
                    {threadMuted ? <Bell size={14} /> : <BellOff size={14} />}
                    <span>{threadMuted ? 'Unmute Thread' : 'Mute Thread'}</span>
                  </button>
                  {!isSelf && (
                    <button
                      type="button"
                      className="ag-agora-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        onPlaySound?.('click')
                        void agora.toggleFollow(note.pubkey)
                      }}
                    >
                      <Users size={14} />
                      <span>{following ? 'Unfollow author' : 'Follow author'}</span>
                    </button>
                  )}
                  {!isSelf && (
                    <button
                      type="button"
                      className="ag-agora-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        onOpenDm(note.pubkey, authorName)
                      }}
                    >
                      <MessageCircle size={14} />
                      <span>Open DM</span>
                    </button>
                  )}
                  {!isSelf && onOpenAmailCompose && (
                    <button
                      type="button"
                      className="ag-agora-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        onOpenAmailCompose(note.pubkey, authorName)
                      }}
                    >
                      <Mail size={14} />
                      <span>Send Agmail</span>
                    </button>
                  )}
                  {onOpenZap && (
                    <button
                      type="button"
                      className="ag-agora-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        handleZap()
                      }}
                    >
                      <Zap size={14} />
                      <span>Zap author</span>
                    </button>
                  )}
                  {isSelf && (
                    <button
                      type="button"
                      className="ag-agora-menu-item danger"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        onPlaySound?.('click')
                        void agora.deleteNote(note.id).then((res) => {
                          if (res.ok) {
                            engine.pushToast('success', 'Post deleted', 'Published NIP-09 deletion request.')
                          } else {
                            engine.pushToast('error', 'Delete failed', res.error)
                          }
                        })
                      }}
                    >
                      <Trash2 size={14} />
                      <span>Delete Post</span>
                    </button>
                  )}
                  {!isSelf && (
                    <button
                      type="button"
                      className="ag-agora-menu-item danger"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        engine.toggleBlockPeer(note.pubkey, authorName)
                      }}
                    >
                      <Ban size={14} />
                      <span>Block author</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {needsCwGate ? (
            <div className="ag-agora-cw-gate" onClick={(e) => e.stopPropagation()}>
              <span className="ag-agora-cw-gate-left">
                <ShieldAlert size={14} aria-hidden="true" />
                <span>Content warning: {note.contentWarning}</span>
              </span>
              <button
                type="button"
                className="ag-agora-cw-btn"
                onClick={() => onRevealCw(note.id)}
              >
                Show content
              </button>
            </div>
          ) : (
            <>
              {displayTokens.some((t) => t.type !== 'quote') && (
                <div className="ag-agora-body-wrap">
                  <div className={`ag-agora-body${isClamped ? ' is-clamped' : ''}`}>
                    {contentBlocks.map((block, bIdx) => {
                      if (block.type === 'code') {
                        return (
                          <pre
                            key={bIdx}
                            className="ag-agora-code-block"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {block.lang && (
                              <span className="ag-agora-code-lang mono">{block.lang}</span>
                            )}
                            <code>{block.code}</code>
                          </pre>
                        )
                      }
                      if (block.type === 'blockquote') {
                        return (
                          <blockquote key={bIdx} className="ag-agora-blockquote">
                            {renderInlineTokens(block.text)}
                          </blockquote>
                        )
                      }
                      if (block.type === 'heading') {
                        return (
                          <div key={bIdx} className={`ag-agora-heading level-${block.level}`}>
                            {renderInlineTokens(block.text)}
                          </div>
                        )
                      }
                      return (
                        <p key={bIdx} className="ag-agora-paragraph">
                          {renderInlineTokens(block.text)}
                        </p>
                      )
                    })}
                  </div>
                  {isLongNote && (
                    <button
                      type="button"
                      className="ag-agora-show-more-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        setExpandedLong((v) => !v)
                      }}
                    >
                      {expandedLong ? 'Show less' : 'Show more'}
                    </button>
                  )}
                </div>
              )}

              {inlinePoll && (
                <div className="ag-agora-inline-poll" onClick={(e) => e.stopPropagation()}>
                  <AgoraPollCard
                    engine={engine}
                    poll={inlinePoll}
                    onOpenProfile={onOpenProfile}
                    onPlaySound={onPlaySound}
                  />
                </div>
              )}

              {(isSelf || engine.isExplicitlyTrusted(note.pubkey)) && (() => {
                const links = new Map<string, string>()
                for (const token of (showingOriginal || !hasMeaningfulTranslation) ? displayTokens : []) {
                  if (token.type === 'link') collectPreviewLink(links, token.url)
                }
                return <InlineLinkCards links={links} mode="automatic" />
              })()}

              {(hasMeaningfulTranslation || translationLoading || translationErrored) && (
                <div className="ag-agora-tr-note-foot" onClick={(e) => e.stopPropagation()}>
                  {hasMeaningfulTranslation ? (
                    <>
                      {!showingOriginal && translatedFromLabel && (
                        <span className="ag-agora-tr-badge">
                          <Languages size={11} aria-hidden="true" />
                          <span>{translatedFromLabel}</span>
                        </span>
                      )}
                      <button
                        type="button"
                        className="ag-agora-tr-toggle-btn"
                        onClick={() => onToggleShowOriginal(origToggleKey)}
                      >
                        {showingOriginal ? 'Show translation' : 'Show original'}
                      </button>
                    </>
                  ) : translationLoading ? (
                    <span className="ag-agora-tr-status-pill" aria-live="polite">
                      <Loader2 size={11} className="ag-agora-spin" aria-hidden="true" />
                      <span>
                        {translator.modelStatus === 'downloading'
                          ? 'Loading model…'
                          : 'Translating…'}
                      </span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="ag-agora-tr-retry-btn"
                      title={translationEntry?.error || 'Retry translating this post'}
                      onClick={() => {
                        if (!translatableText) return
                        void translator.translateMessage(
                          `agora:${note.id}`,
                          translatableText,
                          myLanguage,
                          {
                            sourceLang: explicitSourceLang ?? 'Auto',
                            scopeKey: translationScopeKey,
                            priority: 'visible',
                          }
                        )
                      }}
                    >
                      <AlertCircle size={11} aria-hidden="true" />
                      <span>Translation failed · Retry</span>
                    </button>
                  )}
                </div>
              )}

              {mediaSlice.length > 0 && (
                <div
                  className={`ag-agora-media-grid count-${mediaSlice.length}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {mediaSlice.map((item) =>
                    item.kind === 'video' ? (
                      <AgoraTrustGatedVideo
                        key={item.url}
                        engine={engine}
                        item={item}
                        senderPubkey={note.pubkey}
                        authorName={authorName}
                        isOwn={isSelf}
                        onPlaySound={onPlaySound}
                      />
                    ) : (
                      <AgoraScreenedImage
                        key={item.url}
                        engine={engine}
                        url={item.url}
                        senderPubkey={note.pubkey}
                        variant="media"
                        alt={item.alt || 'Attached image'}
                        hasAltText={Boolean(item.alt?.trim())}
                        caption={item.alt || undefined}
                        onResolvedBlobUrl={(blobUrl) => {
                          verifiedBlobsRef.current.set(item.url, blobUrl)
                        }}
                        onOpenLightbox={(verifiedBlobUrl) =>
                          handleOpenMediaLightbox(item, verifiedBlobUrl)
                        }
                      />
                    )
                  )}
                </div>
              )}

              {embeddedQuoteIds.map((qid) => (
                <AgoraQuotedNoteCard
                  key={qid}
                  eventId={qid}
                  engine={engine}
                  translationScopeKey={translationScopeKey}
                  showOriginalKeys={showOriginalKeys}
                  onToggleShowOriginal={onToggleShowOriginal}
                  onOpenThread={onOpenThread}
                  onOpenProfile={onOpenProfile}
                  onSelectHashtag={onSelectHashtag}
                />
              ))}
            </>
          )}

          {focused && (
            <div className="ag-agora-focused-meta">
              <span className="ag-agora-focused-date">{formatFullDateTime(note.createdAt)}</span>
              <div className="ag-agora-focused-stats tabular">
                <span>
                  <strong>{stats.replies.toLocaleString()}</strong>{' '}
                  {stats.replies === 1 ? 'Reply' : 'Replies'}
                </span>
                <span>
                  <strong>{stats.reposts.toLocaleString()}</strong>{' '}
                  {stats.reposts === 1 ? 'Repost' : 'Reposts'}
                </span>
                <span>
                  <strong>{stats.likes.toLocaleString()}</strong>{' '}
                  {stats.likes === 1 ? 'Like' : 'Likes'}
                </span>
                {stats.zapSats > 0 && (
                  <span>
                    <strong>{stats.zapSats.toLocaleString()}</strong> sats zapped
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="ag-agora-actions" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="ag-agora-act-btn reply"
              onClick={() => {
                onPlaySound?.('click')
                onReplyClick(note)
              }}
              aria-label="Reply"
              title="Reply"
            >
              <MessageCircle size={15} />
              {stats.replies > 0 && <span className="tabular">{formatCompactCount(stats.replies)}</span>}
            </button>

            <div className="ag-agora-action-wrap" ref={repostWrapRef}>
              <button
                type="button"
                className={`ag-agora-act-btn repost${stats.repostedByMe ? ' is-reposted' : ''}`}
                onClick={() => {
                  setRepostMenuOpen((v) => !v)
                  setMenuOpen(false)
                  setZapMenuOpen(false)
                }}
                aria-haspopup="menu"
                aria-expanded={repostMenuOpen}
                aria-label="Repost or quote"
                title="Repost or quote"
              >
                <Repeat2 size={15} />
                {stats.reposts > 0 && (
                  <span className="tabular">{formatCompactCount(stats.reposts)}</span>
                )}
              </button>

              {repostMenuOpen && (
                <div className="ag-agora-menu-popover align-left" role="menu">
                  <button
                    type="button"
                    className="ag-agora-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setRepostMenuOpen(false)
                      onPlaySound?.('click')
                      void agora.repostNote(note).then((res) => {
                        if (res.ok) {
                          engine.pushToast('success', 'Reposted to Agora')
                        } else {
                          engine.pushToast('error', 'Repost failed', res.error)
                        }
                      })
                    }}
                  >
                    <Repeat2 size={14} />
                    <span>{stats.repostedByMe ? 'Repost again' : 'Repost'}</span>
                  </button>
                  <button
                    type="button"
                    className="ag-agora-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setRepostMenuOpen(false)
                      onPlaySound?.('click')
                      onQuoteClick(note)
                    }}
                  >
                    <Quote size={14} />
                    <span>Quote Post</span>
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              className={`ag-agora-act-btn like${stats.likedByMe ? ' is-liked' : ''}`}
              onClick={() => {
                onPlaySound?.('click')
                void agora.toggleLike(note)
              }}
              aria-pressed={stats.likedByMe}
              aria-label="Like"
              title="Like"
            >
              <Heart size={15} fill={stats.likedByMe ? 'currentColor' : 'none'} />
              {stats.likes > 0 && <span className="tabular">{formatCompactCount(stats.likes)}</span>}
            </button>

            <div className="ag-agora-action-wrap" ref={zapWrapRef}>
              <button
                type="button"
                className={`ag-agora-act-btn zap${stats.zappedByMe ? ' is-zapped' : ''}${
                  zapBurstActive ? ' is-zap-burst' : ''
                }`}
                disabled={quickZappingSats !== null}
                onClick={() => {
                  setZapTooltip(null)
                  setMenuOpen(false)
                  setRepostMenuOpen(false)
                  setZapMenuOpen((v) => !v)
                }}
                onMouseEnter={(e) => {
                  if (zapMenuOpen) return
                  const breakdown = stats.zapBreakdown
                  if (stats.zapSats <= 0 || !breakdown || breakdown.length === 0) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  const placement: 'above' | 'below' = rect.top < 76 ? 'below' : 'above'
                  const top = placement === 'below' ? rect.bottom + 8 : rect.top - 8
                  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
                  const left = Math.max(120, Math.min(vw - 120, rect.left + rect.width / 2))
                  setZapTooltip({ left, top, placement })
                  const toFetch = breakdown
                    .slice(0, 5)
                    .map((z) => z.pubkey)
                    .filter((pk) => /^[0-9a-f]{64}$/i.test(pk))
                  if (toFetch.length > 0) {
                    agora.ensureProfiles(toFetch)
                  }
                }}
                onMouseLeave={() => setZapTooltip(null)}
                onFocus={(e) => {
                  if (zapMenuOpen) return
                  const breakdown = stats.zapBreakdown
                  if (stats.zapSats <= 0 || !breakdown || breakdown.length === 0) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  const placement: 'above' | 'below' = rect.top < 76 ? 'below' : 'above'
                  const top = placement === 'below' ? rect.bottom + 8 : rect.top - 8
                  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
                  const left = Math.max(120, Math.min(vw - 120, rect.left + rect.width / 2))
                  setZapTooltip({ left, top, placement })
                  const toFetch = breakdown
                    .slice(0, 5)
                    .map((z) => z.pubkey)
                    .filter((pk) => /^[0-9a-f]{64}$/i.test(pk))
                  if (toFetch.length > 0) {
                    agora.ensureProfiles(toFetch)
                  }
                }}
                onBlur={() => setZapTooltip(null)}
                aria-haspopup="menu"
                aria-expanded={zapMenuOpen}
                aria-label={
                  stats.zapSats > 0 ? `Zap (${stats.zapSats.toLocaleString()} sats zapped)` : 'Zap'
                }
                title={
                  stats.zapSats > 0 && stats.zapBreakdown && stats.zapBreakdown.length > 0
                    ? undefined
                    : stats.zapSats > 0
                      ? `${stats.zapSats.toLocaleString()} sats zapped`
                      : 'Quick Zap'
                }
              >
                {quickZappingSats !== null ? (
                  <Loader2 size={15} className="ag-agora-spin" />
                ) : (
                  <Zap size={15} fill={stats.zappedByMe ? 'currentColor' : 'none'} />
                )}
                {stats.zapSats > 0 && (
                  <span className="tabular">{formatCompactCount(stats.zapSats)}</span>
                )}
              </button>

              {zapMenuOpen && (
                <div className="ag-agora-zap-popover" role="menu" aria-label="Quick zap presets">
                  {QUICK_ZAP_PRESETS.map((sats) => (
                    <button
                      key={sats}
                      type="button"
                      role="menuitem"
                      className="ag-agora-zap-preset-btn tabular"
                      onClick={() => void handleQuickZap(sats)}
                    >
                      <Zap size={11} fill="currentColor" aria-hidden="true" />
                      <span>{sats}</span>
                    </button>
                  ))}
                  {onOpenZap && (
                    <button
                      type="button"
                      role="menuitem"
                      className="ag-agora-zap-custom-btn"
                      onClick={() => {
                        setZapMenuOpen(false)
                        handleZap()
                      }}
                    >
                      Custom…
                    </button>
                  )}
                </div>
              )}
            </div>

            {zapTooltip &&
              stats.zapSats > 0 &&
              stats.zapBreakdown &&
              stats.zapBreakdown.length > 0 &&
              typeof document !== 'undefined' &&
              (() => {
                const sorted = [...stats.zapBreakdown].sort(
                  (a, b) => b.sats - a.sats || (b.byMe ? 1 : 0) - (a.byMe ? 1 : 0),
                )
                const visible = sorted.slice(0, 5)
                const extraCount = Math.max(0, sorted.length - visible.length)
                const myPkLower = agora.myPubkey.toLowerCase()
                const entries = visible.map((z) => {
                  const who =
                    z.byMe || z.pubkey.toLowerCase() === myPkLower
                      ? 'You'
                      : /^[0-9a-f]{64}$/i.test(z.pubkey)
                        ? getProfileDisplayName(agora.getProfile(z.pubkey), z.pubkey)
                        : 'Anonymous'
                  return `${who} · ${z.sats.toLocaleString()} sats`
                })
                return createPortal(
                  <div
                    className={`ag-reaction-tooltip is-${zapTooltip.placement}`}
                    role="tooltip"
                    style={{
                      left: `${zapTooltip.left}px`,
                      top: `${zapTooltip.top}px`,
                    }}
                  >
                    <span
                      className="ag-reaction-tooltip-emoji ag-agora-zap-tooltip-icon"
                      aria-hidden="true"
                    >
                      <Zap size={14} fill="currentColor" />
                    </span>
                    <div className="ag-reaction-tooltip-body">
                      <span className="ag-reaction-tooltip-names">{entries.join(', ')}</span>
                      {extraCount > 0 && (
                        <span className="ag-reaction-tooltip-more">
                          {' '}
                          and {extraCount} more
                        </span>
                      )}
                    </div>
                  </div>,
                  document.body,
                )
              })()}

            <button
              type="button"
              className={`ag-agora-act-btn bookmark${bookmarked ? ' is-bookmarked' : ''}`}
              onClick={() => {
                onPlaySound?.('click')
                void agora.toggleBookmark(note.id)
              }}
              aria-pressed={bookmarked}
              aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark'}
              title={bookmarked ? 'Remove bookmark' : 'Bookmark'}
            >
              <Bookmark size={15} fill={bookmarked ? 'currentColor' : 'none'} />
            </button>

            <button
              type="button"
              className="ag-agora-act-btn"
              onClick={() => void handleCopyShareLink()}
              aria-label="Share link"
              title="Copy shareable Agora link"
            >
              <Share2 size={14} />
            </button>
          </div>
        </div>
      </div>
    </article>
  )
}

/* --------------------------------------------------------------------------
   Edit Profile (kind: 0) Modal
   -------------------------------------------------------------------------- */
const EditProfileModal: React.FC<{
  engine: AgnostrEngine
  onClose: () => void
  onPlaySound?: (cue: SoundCue) => void
}> = ({ engine, onClose, onPlaySound }) => {
  const { agora } = engine
  const current = agora.myProfile

  const [displayName, setDisplayName] = useState(current?.displayName ?? '')
  const [name, setName] = useState(current?.name ?? '')
  const [about, setAbout] = useState(current?.about ?? '')
  const [picture, setPicture] = useState(current?.picture ?? '')
  const [banner, setBanner] = useState(current?.banner ?? '')
  const [nip05, setNip05] = useState(current?.nip05 ?? '')
  const [lud16, setLud16] = useState(current?.lud16 ?? engine.zaps.lightningAddress ?? '')
  const [website, setWebsite] = useState(current?.website ?? '')
  const [saving, setSaving] = useState(false)
  const [uploadingField, setUploadingField] = useState<'picture' | 'banner' | null>(null)
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false)

  const avatarFileRef = useRef<HTMLInputElement | null>(null)
  const bannerFileRef = useRef<HTMLInputElement | null>(null)
  const avatarMenuWrapRef = useRef<HTMLDivElement | null>(null)

  useBackHandler(true, onClose)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (avatarMenuOpen) {
          setAvatarMenuOpen(false)
          return
        }
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [avatarMenuOpen, onClose])

  useEffect(() => {
    if (!avatarMenuOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (avatarMenuWrapRef.current && target && !avatarMenuWrapRef.current.contains(target)) {
        setAvatarMenuOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [avatarMenuOpen])

  const handlePhotoUpload = async (
    field: 'picture' | 'banner',
    e: ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploadingField(field)
    try {
      const uploaded = await agora.uploadMedia(file)
      if (field === 'picture') setPicture(uploaded.url)
      else setBanner(uploaded.url)
      onPlaySound?.('click')
      engine.pushToast('success', field === 'picture' ? 'Avatar uploaded' : 'Banner uploaded')
    } catch (err) {
      engine.pushToast(
        'error',
        'Upload failed',
        err instanceof Error ? err.message : 'Unable to upload image.'
      )
    } finally {
      setUploadingField(null)
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    try {
      const draft: AgoraProfileDraft = {
        displayName: displayName.trim(),
        name: name.trim(),
        about: about.trim(),
        picture: picture.trim(),
        banner: banner.trim(),
        nip05: nip05.trim(),
        lud16: lud16.trim(),
        website: website.trim(),
      }
      const res = await agora.updateMyProfile(draft)
      if (res.ok) {
        onPlaySound?.('send')
        engine.pushToast('success', 'Profile published to Nostr')
        onClose()
      } else {
        engine.pushToast('error', 'Profile update failed', res.error)
      }
    } finally {
      setSaving(false)
    }
  }

  const modal = (
    <div
      className="ag-agora-modal-backdrop"
      role="presentation"
      data-no-swipe="true"
      onClick={onClose}
    >
      <form
        className="ag-agora-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit Nostr Profile"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void handleSubmit(e)}
      >
        <header className="ag-agora-modal-head">
          <h3 className="ag-agora-modal-title">Edit Nostr Profile</h3>
          <button
            type="button"
            className="ag-agora-icon-btn"
            onClick={onClose}
            aria-label="Close edit profile"
          >
            <X size={17} />
          </button>
        </header>

        <div className="ag-agora-modal-body">
          <div className="ag-agora-edit-photo-card">
            <div className="ag-agora-edit-photo-top">
              <div className="ag-agora-edit-avatar-wrap" ref={avatarMenuWrapRef}>
                <input
                  ref={avatarFileRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => void handlePhotoUpload('picture', e)}
                />
                <button
                  type="button"
                  className="ag-agora-edit-avatar-btn"
                  disabled={uploadingField !== null}
                  onClick={() => {
                    if (picture.trim()) {
                      setAvatarMenuOpen((v) => !v)
                    } else {
                      avatarFileRef.current?.click()
                    }
                  }}
                  aria-haspopup={picture.trim() ? 'menu' : undefined}
                  aria-expanded={picture.trim() ? avatarMenuOpen : undefined}
                  aria-label={
                    picture.trim() ? 'Change or remove profile photo' : 'Upload profile photo'
                  }
                  title={picture.trim() ? 'Change or remove photo' : 'Upload profile photo'}
                >
                  <AgoraAvatar
                    engine={engine}
                    pubkey={agora.myPubkey}
                    picture={picture}
                    size="lg"
                    className="ag-agora-edit-avatar-img"
                    alt="Avatar preview"
                  />
                  <span
                    className={`ag-agora-edit-avatar-overlay${
                      uploadingField === 'picture' ? ' is-busy' : ''
                    }`}
                    aria-hidden="true"
                  >
                    {uploadingField === 'picture' ? (
                      <Loader2 size={18} className="ag-agora-spin" />
                    ) : (
                      <Camera size={18} />
                    )}
                  </span>
                </button>

                {avatarMenuOpen && picture.trim() && (
                  <div className="ag-agora-photo-menu" role="menu" aria-label="Profile photo options">
                    <button
                      type="button"
                      className="ag-agora-photo-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setAvatarMenuOpen(false)
                        avatarFileRef.current?.click()
                      }}
                    >
                      <Camera size={14} />
                      <span>Change photo</span>
                    </button>
                    <button
                      type="button"
                      className="ag-agora-photo-menu-item danger"
                      role="menuitem"
                      onClick={() => {
                        setAvatarMenuOpen(false)
                        onPlaySound?.('click')
                        setPicture('')
                      }}
                    >
                      <Trash2 size={14} />
                      <span>Remove photo</span>
                    </button>
                  </div>
                )}
              </div>

              <div className="ag-agora-edit-photo-meta">
                <span className="ag-agora-edit-photo-name truncate">
                  {displayName.trim() ||
                    name.trim() ||
                    getProfileDisplayName(current, agora.myPubkey)}
                </span>
                <span className="ag-agora-edit-photo-npub mono truncate">
                  {shortPubkey(encodeNpubSafe(agora.myPubkey), 10, 6)}
                </span>
                <span className="ag-agora-edit-photo-hint">
                  {uploadingField === 'picture'
                    ? 'Uploading photo…'
                    : picture.trim()
                      ? 'Click avatar to change or remove photo'
                      : 'Click avatar to upload a photo'}
                </span>
              </div>
            </div>

            <div className="ag-agora-edit-photo-url-wrap">
              <label className="ag-agora-label" htmlFor="ag-agora-prof-picture">
                Direct Image URL (optional HTTPS)
              </label>
              <input
                id="ag-agora-prof-picture"
                type="url"
                className="ag-agora-input"
                value={picture}
                onChange={(e) => setPicture(e.target.value)}
                placeholder="https://…"
              />
            </div>
          </div>

          <div className="ag-agora-field">
            <label className="ag-agora-label" htmlFor="ag-agora-prof-display">
              Display Name
            </label>
            <input
              id="ag-agora-prof-display"
              type="text"
              className="ag-agora-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Satoshi Nakamoto"
              maxLength={80}
            />
          </div>

          <div className="ag-agora-field">
            <label className="ag-agora-label" htmlFor="ag-agora-prof-name">
              Username
            </label>
            <input
              id="ag-agora-prof-name"
              type="text"
              className="ag-agora-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="agnon"
              maxLength={60}
            />
          </div>

          <div className="ag-agora-field">
            <label className="ag-agora-label" htmlFor="ag-agora-prof-about">
              Bio
            </label>
            <textarea
              id="ag-agora-prof-about"
              className="ag-agora-textarea"
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              placeholder="Tell people on Nostr about yourself…"
              maxLength={500}
            />
          </div>

          <div className="ag-agora-field">
            <label className="ag-agora-label" htmlFor="ag-agora-prof-banner">
              Banner URL
            </label>
            <div className="ag-agora-input-with-btn">
              <input
                id="ag-agora-prof-banner"
                type="url"
                className="ag-agora-input"
                value={banner}
                onChange={(e) => setBanner(e.target.value)}
                placeholder="https://…"
              />
              <input
                ref={bannerFileRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => void handlePhotoUpload('banner', e)}
              />
              <button
                type="button"
                className="ag-agora-pill-btn"
                disabled={uploadingField !== null}
                onClick={() => bannerFileRef.current?.click()}
              >
                {uploadingField === 'banner' ? (
                  <Loader2 size={13} className="ag-agora-spin" />
                ) : (
                  <Upload size={13} />
                )}
                <span>Upload</span>
              </button>
            </div>
          </div>

          <div className="ag-agora-field">
            <label className="ag-agora-label" htmlFor="ag-agora-prof-nip05">
              NIP-05 Identifier
            </label>
            <input
              id="ag-agora-prof-nip05"
              type="text"
              className="ag-agora-input"
              value={nip05}
              onChange={(e) => setNip05(e.target.value)}
              placeholder="you@domain.com"
            />
          </div>

          <div className="ag-agora-field">
            <label className="ag-agora-label" htmlFor="ag-agora-prof-lud16">
              Lightning Address (Zaps)
            </label>
            <input
              id="ag-agora-prof-lud16"
              type="text"
              className="ag-agora-input"
              value={lud16}
              onChange={(e) => setLud16(e.target.value)}
              placeholder="you@npub.cash"
            />
          </div>

          <div className="ag-agora-field">
            <label className="ag-agora-label" htmlFor="ag-agora-prof-web">
              Website
            </label>
            <input
              id="ag-agora-prof-web"
              type="url"
              className="ag-agora-input"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://agnostr.com"
            />
          </div>
        </div>

        <footer className="ag-agora-modal-foot">
          <button type="button" className="ag-agora-pill-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="ag-agora-pill-btn primary"
            disabled={saving || uploadingField !== null}
          >
            {saving ? <Loader2 size={13} className="ag-agora-spin" /> : null}
            <span>{saving ? 'Saving…' : 'Save Profile'}</span>
          </button>
        </footer>
      </form>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal
}

/* --------------------------------------------------------------------------
   Voice / Suggested Profile Compact Row
   -------------------------------------------------------------------------- */
const AgoraVoiceRow: React.FC<{
  engine: AgnostrEngine
  profile: AgoraProfile
  isSelf: boolean
  following: boolean
  onOpenProfile: (pubkey: string) => void
  onToggleFollow: (pubkey: string) => void
}> = ({ engine, profile, isSelf, following, onOpenProfile, onToggleFollow }) => {
  const name = getProfileDisplayName(profile, profile.pubkey)
  const bio = profile.about?.trim() || formatNip05Display(profile.nip05) || shortPubkey(profile.npub, 8, 4)

  return (
    <div className="ag-agora-voice-row">
      <button
        type="button"
        className="ag-agora-voice-main"
        onClick={() => onOpenProfile(profile.pubkey)}
      >
        <AgoraAvatar
          engine={engine}
          pubkey={profile.pubkey}
          picture={profile.picture}
          size="sm"
          alt={name}
        />
        <div className="ag-agora-voice-copy">
          <span className="ag-agora-voice-name truncate">{name}</span>
          <span className="ag-agora-voice-bio truncate">{bio}</span>
        </div>
      </button>
      {!isSelf && (
        <button
          type="button"
          className={`ag-agora-follow-micro${following ? ' following' : ''}`}
          onClick={() => onToggleFollow(profile.pubkey)}
        >
          {following ? 'Following' : 'Follow'}
        </button>
      )}
    </div>
  )
}

/* --------------------------------------------------------------------------
   Main AgoraView Component
   -------------------------------------------------------------------------- */
export const AgoraView: React.FC<AgoraViewProps> = ({
  engine,
  isMobileViewport = false,
  initialComposeOpen = false,
  onConsumedInitialCompose,
  onOpenDm,
  onOpenAmailCompose,
  onOpenZap,
  onOpenLightbox,
  onPlaySound,
}) => {
  const { agora, translator } = engine
  const streamRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const [manualComposerModal, setManualComposerModal] = useState<ComposerModalState | null>(null)
  const [editProfileOpen, setEditProfileOpen] = useState(false)
  const [curationModalOpen, setCurationModalOpen] = useState(false)
  const [discoverSimilarPubkey, setDiscoverSimilarPubkey] = useState<string | null>(null)
  const [socialListModal, setSocialListModal] = useState<{
    title: string
    pubkeys: string[]
  } | null>(null)
  const [notifFilter, setNotifFilter] = useState<AgoraNotificationFilter>('all')
  const [collapsedBranches, setCollapsedBranches] = useState<Set<string>>(() => new Set())
  const [showScrollTop, setShowScrollTop] = useState(false)
  const [kbdFocusedIndex, setKbdFocusedIndex] = useState(-1)
  const [hoverCard, setHoverCard] = useState<{ pubkey: string; rect: DOMRect } | null>(null)
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [hiddenTrendsOpen, setHiddenTrendsOpen] = useState(false)
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false)
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false)
  const [searchDraft, setSearchDraft] = useState(agora.searchQuery)
  const [revealedCwIds, setRevealedCwIds] = useState<Set<string>>(() => new Set())
  const [showOriginalKeys, setShowOriginalKeys] = useState<Set<string>>(() => new Set())
  const [copiedNpub, setCopiedNpub] = useState(false)
  const [ptrPullPx, setPtrPullPx] = useState(0)
  const [ptrDragging, setPtrDragging] = useState(false)
  const [ptrRefreshing, setPtrRefreshing] = useState(false)
  const ptrTimerRef = useRef<number | null>(null)
  const scrollPositionsRef = useRef<Map<string, number>>(new Map())
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null)
  const hoverOpenTimerRef = useRef<number | null>(null)
  const hoverCloseTimerRef = useRef<number | null>(null)

  const clearHoverTimers = useCallback(() => {
    if (hoverOpenTimerRef.current !== null) {
      window.clearTimeout(hoverOpenTimerRef.current)
      hoverOpenTimerRef.current = null
    }
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current)
      hoverCloseTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => clearHoverTimers()
  }, [clearHoverTimers])

  const handleHoverAuthorStart = useCallback(
    (pubkey: string, el: HTMLElement) => {
      if (isMobileViewport) return
      clearHoverTimers()
      hoverOpenTimerRef.current = window.setTimeout(() => {
        hoverOpenTimerRef.current = null
        if (!el.isConnected) return
        setHoverCard({ pubkey, rect: el.getBoundingClientRect() })
      }, 320)
    },
    [clearHoverTimers, isMobileViewport]
  )

  const handleHoverAuthorEnd = useCallback(() => {
    if (hoverOpenTimerRef.current !== null) {
      window.clearTimeout(hoverOpenTimerRef.current)
      hoverOpenTimerRef.current = null
    }
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current)
    }
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null
      setHoverCard(null)
    }, 200)
  }, [])

  const handleHoverCardEnter = useCallback(() => {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current)
      hoverCloseTimerRef.current = null
    }
  }, [])

  const dismissHoverCard = useCallback(() => {
    clearHoverTimers()
    setHoverCard(null)
  }, [clearHoverTimers])

  // Activate lazy Agora subscriptions on mount
  useEffect(() => {
    agora.activate()
  }, [agora])

  const activeComposerModal: ComposerModalState | null = useMemo(
    () => manualComposerModal ?? (initialComposeOpen ? { kind: 'post' } : null),
    [initialComposeOpen, manualComposerModal]
  )

  const closeComposerModal = useCallback(() => {
    setManualComposerModal(null)
    if (initialComposeOpen) {
      onConsumedInitialCompose?.()
    }
  }, [initialComposeOpen, onConsumedInitialCompose])

  const closeDrawers = useCallback(() => {
    setLeftDrawerOpen(false)
    setRightDrawerOpen(false)
  }, [])

  const handleLeftDrawerOpenChange = useCallback((open: boolean) => {
    setLeftDrawerOpen(open)
    if (open) setRightDrawerOpen(false)
  }, [])

  const handleRightDrawerOpenChange = useCallback((open: boolean) => {
    setRightDrawerOpen(open)
    if (open) setLeftDrawerOpen(false)
  }, [])

  const anySubModalOpen =
    Boolean(activeComposerModal) ||
    editProfileOpen ||
    curationModalOpen ||
    Boolean(socialListModal) ||
    Boolean(agora.activeArticle)

  const {
    bindRef: agoraStageRef,
    leftProgress: leftDrawerProgress,
    rightProgress: rightDrawerProgress,
    isSwipingLeft: isSwipingLeftDrawer,
    isSwipingRight: isSwipingRightDrawer,
  } = useMobileSwipeDrawers({
    leftOpen: leftDrawerOpen,
    rightOpen: rightDrawerOpen,
    disabled: anySubModalOpen || ptrDragging,
    onLeftOpenChange: handleLeftDrawerOpenChange,
    onRightOpenChange: handleRightDrawerOpenChange,
  })

  const handleNavigateBack = useCallback(() => {
    dismissHoverCard()
    if (agora.canNavigateBack) {
      agora.navigateBack()
    } else if (agora.thread) {
      agora.closeThread()
    } else if (agora.profileView) {
      agora.closeProfile()
    }
  }, [agora, dismissHoverCard])

  useBackHandler(Boolean(activeComposerModal), closeComposerModal)
  useBackHandler(
    !activeComposerModal &&
      !editProfileOpen &&
      !curationModalOpen &&
      !socialListModal &&
      !agora.activeArticle &&
      agora.canNavigateBack,
    agora.navigateBack
  )
  useBackHandler(
    !anySubModalOpen && !agora.canNavigateBack && Boolean(agora.thread),
    agora.closeThread
  )
  useBackHandler(
    !anySubModalOpen && !agora.canNavigateBack && !agora.thread && Boolean(agora.profileView),
    agora.closeProfile
  )
  useBackHandler(!anySubModalOpen && (leftDrawerOpen || rightDrawerOpen), closeDrawers)

  useEffect(() => {
    if (!activeComposerModal && !leftDrawerOpen && !rightDrawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (activeComposerModal) {
          closeComposerModal()
        } else if (leftDrawerOpen || rightDrawerOpen) {
          closeDrawers()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeComposerModal, leftDrawerOpen, rightDrawerOpen, closeComposerModal, closeDrawers])

  const inThread = agora.thread !== null
  const inProfile = !inThread && agora.profileView !== null
  const inSearch = !inThread && !inProfile && Boolean(agora.searchQuery || agora.activeHashtag)
  const inNotifications = !inThread && !inProfile && !inSearch && agora.activeTab === 'notifications'
  const inArticles = !inThread && !inProfile && !inSearch && agora.activeTab === 'articles'
  const inDiscover =
    AGORA_WOT_DISCOVERY_ENABLED &&
    !inThread &&
    !inProfile &&
    !inSearch &&
    agora.activeTab === 'discover'
  const inStandardFeed =
    !inThread && !inProfile && !inSearch && !inNotifications && !inArticles && !inDiscover
  const showInlineComposer =
    inStandardFeed &&
    (agora.activeTab === 'following' ||
      agora.activeTab === 'global' ||
      agora.activeTab === 'trending')

  const currentViewKey = inThread
    ? `thread:${agora.thread?.focusedNoteId ?? ''}`
    : inProfile
      ? `profile:${agora.profileView?.pubkey ?? ''}`
      : inSearch
        ? `search:${agora.activeHashtag || agora.searchQuery}`
        : `tab:${agora.activeTab}:${agora.activeListId ?? ''}`

  const saveCurrentScroll = useCallback(() => {
    if (streamRef.current) {
      scrollPositionsRef.current.set(currentViewKey, streamRef.current.scrollTop)
    }
  }, [currentViewKey])

  // Track scroll position per view key & toggle floating Back-to-Top pill
  useEffect(() => {
    const el = streamRef.current
    if (!el) return
    const onScroll = () => {
      const top = el.scrollTop
      scrollPositionsRef.current.set(currentViewKey, top)
      setShowScrollTop(top > 600)
      setHoverCard((prev) => (prev ? null : prev))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [currentViewKey])

  // Restore saved scrollTop cleanly on view transitions & reset keyboard focus
  useEffect(() => {
    setKbdFocusedIndex(-1)
    dismissHoverCard()
    const savedTop = scrollPositionsRef.current.get(currentViewKey) ?? 0
    const rafId = window.requestAnimationFrame(() => {
      if (streamRef.current) {
        streamRef.current.scrollTop = savedTop
        setShowScrollTop(savedTop > 600)
      }
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [currentViewKey, dismissHoverCard])

  const handleSelectTab = useCallback(
    (tab: AgoraFeedTab) => {
      saveCurrentScroll()
      dismissHoverCard()
      onPlaySound?.('click')
      setLeftDrawerOpen(false)
      setRightDrawerOpen(false)
      if (agora.thread) agora.closeThread()
      if (agora.profileView) agora.closeProfile()
      if (agora.searchQuery || agora.activeHashtag) agora.clearSearch()
      if (agora.activeListId) agora.setActiveListId(null)
      const sameTab = !inThread && !inProfile && !inSearch && agora.activeTab === tab
      agora.setActiveTab(tab)
      if (tab === 'notifications') {
        agora.markNotificationsRead()
      }
      if (sameTab) {
        streamRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      }
    },
    [agora, dismissHoverCard, inProfile, inSearch, inThread, onPlaySound, saveCurrentScroll]
  )

  const handleOpenProfile = useCallback(
    (pubkey: string) => {
      saveCurrentScroll()
      dismissHoverCard()
      onPlaySound?.('click')
      setLeftDrawerOpen(false)
      setRightDrawerOpen(false)
      agora.openProfile(pubkey)
    },
    [agora, dismissHoverCard, onPlaySound, saveCurrentScroll]
  )

  const handleOpenThread = useCallback(
    (noteId: string) => {
      saveCurrentScroll()
      dismissHoverCard()
      onPlaySound?.('click')
      setLeftDrawerOpen(false)
      setRightDrawerOpen(false)
      agora.openThread(noteId)
    },
    [agora, dismissHoverCard, onPlaySound, saveCurrentScroll]
  )

  const handleSelectHashtag = useCallback(
    (tag: string) => {
      saveCurrentScroll()
      dismissHoverCard()
      onPlaySound?.('click')
      setLeftDrawerOpen(false)
      setRightDrawerOpen(false)
      if (agora.thread) agora.closeThread()
      if (agora.profileView) agora.closeProfile()
      setSearchDraft(`#${tag}`)
      setMobileSearchOpen(false)
      agora.selectHashtag(tag)
    },
    [agora, dismissHoverCard, onPlaySound, saveCurrentScroll]
  )

  const handleSearchSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      const q = searchDraft.trim()
      if (!q) {
        agora.clearSearch()
        return
      }
      saveCurrentScroll()
      dismissHoverCard()
      onPlaySound?.('click')
      setLeftDrawerOpen(false)
      setRightDrawerOpen(false)
      if (agora.thread) agora.closeThread()
      if (agora.profileView) agora.closeProfile()
      void agora.runSearch(q)
      if (isMobileViewport) setMobileSearchOpen(false)
    },
    [agora, dismissHoverCard, isMobileViewport, onPlaySound, saveCurrentScroll, searchDraft]
  )

  const handleClearSearch = useCallback(() => {
    setSearchDraft('')
    agora.clearSearch()
  }, [agora])

  const handleRevealCw = useCallback((noteId: string) => {
    setRevealedCwIds((prev) => {
      const next = new Set(prev)
      next.add(noteId)
      return next
    })
  }, [])

  const handleToggleShowOriginal = useCallback((key: string) => {
    setShowOriginalKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const handleToggleFollow = useCallback(
    (pubkey: string) => {
      onPlaySound?.('click')
      void agora.toggleFollow(pubkey)
    },
    [agora, onPlaySound]
  )

  const handleToggleBranchCollapse = useCallback((noteId: string) => {
    setCollapsedBranches((prev) => {
      const next = new Set(prev)
      if (next.has(noteId)) next.delete(noteId)
      else next.add(noteId)
      return next
    })
  }, [])

  const myDisplayName = getProfileDisplayName(agora.myProfile, agora.myPubkey)
  const myNpub = useMemo(() => encodeNpubSafe(agora.myPubkey), [agora.myPubkey])

  const isMyProfileOpen =
    inProfile && agora.profileView?.pubkey.toLowerCase() === agora.myPubkey.toLowerCase()

  const ptrEnabled =
    isMobileViewport &&
    !anySubModalOpen &&
    !leftDrawerOpen &&
    !rightDrawerOpen &&
    !isSwipingLeftDrawer &&
    !isSwipingRightDrawer

  const ptrLatestRef = useRef({
    enabled: ptrEnabled,
    refreshing: ptrRefreshing,
    pendingNewCount: agora.pendingNewCount,
    inThread,
    inProfile,
    inNotifications,
    threadNoteId: agora.thread?.focusedNoteId ?? null,
    profilePubkey: agora.profileView?.pubkey ?? null,
    activeHashtag: agora.activeHashtag,
    searchQuery: agora.searchQuery,
    agora,
    onPlaySound,
  })

  useEffect(() => {
    ptrLatestRef.current = {
      enabled: ptrEnabled,
      refreshing: ptrRefreshing,
      pendingNewCount: agora.pendingNewCount,
      inThread,
      inProfile,
      inNotifications,
      threadNoteId: agora.thread?.focusedNoteId ?? null,
      profilePubkey: agora.profileView?.pubkey ?? null,
      activeHashtag: agora.activeHashtag,
      searchQuery: agora.searchQuery,
      agora,
      onPlaySound,
    }
  }, [
    ptrEnabled,
    ptrRefreshing,
    agora,
    inThread,
    inProfile,
    inNotifications,
    onPlaySound,
  ])

  useEffect(() => {
    return () => {
      if (ptrTimerRef.current !== null) {
        window.clearTimeout(ptrTimerRef.current)
        ptrTimerRef.current = null
      }
    }
  }, [])

  // Smooth single-finger mobile pull-to-refresh on the scrollable Agora stream
  useEffect(() => {
    if (!isMobileViewport) return
    const stream = streamRef.current
    if (!stream) return

    interface PtrTouchSession {
      touchId: number
      startX: number
      startY: number
      lock: 'pending' | 'pull' | 'rejected'
      pullPx: number
      crossedThreshold: boolean
    }

    let session: PtrTouchSession | null = null

    const abortPull = () => {
      const wasPulling = session?.lock === 'pull'
      session = null
      if (wasPulling) {
        setPtrDragging(false)
        setPtrPullPx(0)
      }
    }

    const onTouchStart = (e: TouchEvent) => {
      const latest = ptrLatestRef.current
      if (!latest.enabled || latest.refreshing) {
        abortPull()
        return
      }
      if (e.touches.length !== 1) {
        abortPull()
        return
      }
      if (stream.scrollTop > 1) {
        session = null
        return
      }
      if (shouldIgnorePtrTarget(e.target, stream)) {
        session = null
        return
      }
      const touch = e.touches.item(0)
      if (!touch) return
      session = {
        touchId: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        lock: 'pending',
        pullPx: 0,
        crossedThreshold: false,
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!session) return
      const latest = ptrLatestRef.current
      if (!latest.enabled || latest.refreshing || e.touches.length !== 1) {
        abortPull()
        return
      }
      const touch = findPtrTouchById(e.touches, session.touchId)
      if (!touch) {
        abortPull()
        return
      }

      const dx = touch.clientX - session.startX
      const dy = touch.clientY - session.startY

      if (session.lock === 'rejected') return

      if (session.lock === 'pending') {
        if (stream.scrollTop > 1) {
          session.lock = 'rejected'
          return
        }
        if (dy < -6) {
          session.lock = 'rejected'
          return
        }
        if (Math.abs(dx) > 8 && Math.abs(dx) >= Math.abs(dy) * 0.8) {
          session.lock = 'rejected'
          return
        }
        if (dy > 8 && Math.abs(dy) > Math.abs(dx) * 1.25) {
          session.lock = 'pull'
          setPtrDragging(true)
        } else {
          return
        }
      }

      if (e.cancelable) {
        e.preventDefault()
      }

      const nextPullPx =
        dy <= 0 ? 0 : Math.min(PTR_MAX_PULL_PX, Math.pow(dy, 0.78) * 1.45)

      if (nextPullPx >= PTR_PULL_THRESHOLD && !session.crossedThreshold) {
        session.crossedThreshold = true
        try {
          navigator.vibrate?.(10)
        } catch {
          /* ignore haptic errors */
        }
      } else if (nextPullPx < PTR_PULL_THRESHOLD - 6 && session.crossedThreshold) {
        session.crossedThreshold = false
      }

      if (Math.abs(nextPullPx - session.pullPx) >= 0.5 || nextPullPx === 0) {
        session.pullPx = nextPullPx
        setPtrPullPx(nextPullPx)
      }
    }

    const onTouchEndOrCancel = (e: TouchEvent) => {
      if (!session) return
      const finished = session
      session = null

      if (finished.lock !== 'pull') return
      setPtrDragging(false)

      const latest = ptrLatestRef.current
      const shouldRefresh =
        e.type === 'touchend' &&
        latest.enabled &&
        !latest.refreshing &&
        finished.pullPx >= PTR_PULL_THRESHOLD

      if (!shouldRefresh) {
        setPtrPullPx(0)
        return
      }

      latest.onPlaySound?.('click')
      setPtrRefreshing(true)
      setPtrPullPx(PTR_REFRESH_HOLD_PX)

      if (latest.pendingNewCount > 0) {
        latest.agora.flushPendingNotes()
      }
      if (latest.inThread && latest.threadNoteId) {
        latest.agora.openThread(latest.threadNoteId)
      } else if (latest.inProfile && latest.profilePubkey) {
        latest.agora.openProfile(latest.profilePubkey)
        latest.agora.refresh()
      } else if (latest.activeHashtag) {
        latest.agora.selectHashtag(latest.activeHashtag)
        latest.agora.refresh()
      } else if (latest.searchQuery) {
        void latest.agora.runSearch(latest.searchQuery)
        latest.agora.refresh()
      } else {
        latest.agora.refresh()
        if (latest.inNotifications) {
          latest.agora.markNotificationsRead()
        }
      }

      if (ptrTimerRef.current !== null) {
        window.clearTimeout(ptrTimerRef.current)
      }
      ptrTimerRef.current = window.setTimeout(() => {
        ptrTimerRef.current = null
        setPtrRefreshing(false)
        setPtrPullPx(0)
      }, PTR_REFRESH_HOLD_MS)
    }

    stream.addEventListener('touchstart', onTouchStart, { passive: true })
    stream.addEventListener('touchmove', onTouchMove, { passive: false })
    stream.addEventListener('touchend', onTouchEndOrCancel, { passive: true })
    stream.addEventListener('touchcancel', onTouchEndOrCancel, { passive: true })

    return () => {
      stream.removeEventListener('touchstart', onTouchStart)
      stream.removeEventListener('touchmove', onTouchMove)
      stream.removeEventListener('touchend', onTouchEndOrCancel)
      stream.removeEventListener('touchcancel', onTouchEndOrCancel)
    }
  }, [isMobileViewport])

  const effectivePtrHeight = ptrEnabled ? (ptrRefreshing ? PTR_REFRESH_HOLD_PX : ptrPullPx) : 0
  const ptrReady = !ptrRefreshing && effectivePtrHeight >= PTR_PULL_THRESHOLD
  const ptrProgress = Math.min(1, effectivePtrHeight / PTR_PULL_THRESHOLD)
  const ptrActive = effectivePtrHeight > 2
  const ptrLabel = ptrRefreshing
    ? 'Refreshing…'
    : ptrReady
      ? agora.pendingNewCount > 0
        ? `Release to load ${agora.pendingNewCount} new`
        : 'Release to refresh'
      : agora.pendingNewCount > 0
        ? `Pull to load ${agora.pendingNewCount} new`
        : 'Pull to refresh'

  const activeTabTitle = useMemo(() => {
    if (agora.activeListId) {
      const list = agora.customLists.find((l) => l.id === agora.activeListId)
      if (list) return list.title
    }
    switch (agora.activeTab) {
      case 'following':
        return 'Following'
      case 'global':
        return 'Global'
      case 'trending':
        return 'Trending'
      case 'discover':
        return 'Discover'
      case 'articles':
        return 'Articles'
      case 'bookmarks':
        return 'Bookmarks'
      case 'notifications':
        return 'Notifications'
    }
  }, [agora.activeListId, agora.activeTab, agora.customLists])

  const displayedFeedItems: AgoraFeedItem[] = useMemo(() => {
    let items = agora.feedItems
    if (agora.activeListId) {
      const activeList = agora.customLists.find((l) => l.id === agora.activeListId)
      if (activeList && activeList.pubkeys.length > 0) {
        const allowSet = new Set(activeList.pubkeys.map((pk) => pk.toLowerCase()))
        items = items.filter((item) => allowSet.has(item.note.pubkey.toLowerCase()))
      }
    }
    if (agora.activeTab === 'following' || agora.activeTab === 'global') {
      if (agora.feedFilter === 'no-reposts') {
        items = items.filter((item) => item.kind !== 'repost')
      } else if (agora.feedFilter === 'media') {
        items = items.filter((item) => item.note.media.length > 0)
      } else if (agora.feedFilter === 'trusted') {
        const myPk = agora.myPubkey.toLowerCase()
        items = items.filter(
          (item) => item.note.pubkey.toLowerCase() === myPk || engine.isTrusted(item.note.pubkey)
        )
      }
    }
    return items
  }, [
    agora.activeListId,
    agora.activeTab,
    agora.customLists,
    agora.feedFilter,
    agora.feedItems,
    agora.myPubkey,
    engine,
  ])

  const standalonePolls = useMemo(() => {
    if (!inStandardFeed || (agora.activeTab !== 'following' && agora.activeTab !== 'global')) {
      return []
    }
    if (agora.polls.length === 0) return []
    const inlineNoteIds = new Set(displayedFeedItems.map((it) => it.note.id))
    return agora.polls.filter((p) => !inlineNoteIds.has(p.id)).slice(0, 3)
  }, [agora.activeTab, agora.polls, displayedFeedItems, inStandardFeed])

  const replyTree = useMemo(
    () =>
      agora.thread
        ? buildThreadedReplyTree(agora.thread.focusedNoteId, agora.thread.replies)
        : [],
    [agora.thread]
  )

  const groupedNotifications: AgoraGroupedNotification[] = useMemo(() => {
    const filtered = agora.notifications.filter((n) => {
      if (notifFilter === 'all') return true
      if (notifFilter === 'replies') return n.kind === 'reply' || n.kind === 'mention'
      if (notifFilter === 'zaps') return n.kind === 'zap'
      if (notifFilter === 'reactions') return n.kind === 'like' || n.kind === 'repost'
      return true
    })
    return groupAgoraNotifications(filtered)
  }, [agora.notifications, notifFilter])

  // Automatic infinite scroll via IntersectionObserver sentinel
  useEffect(() => {
    if (!inStandardFeed || !agora.hasMore || agora.loadingMore) return
    const sentinel = loadMoreSentinelRef.current
    const root = streamRef.current
    if (!sentinel || !root || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void agora.loadMore()
        }
      },
      { root, rootMargin: '280px' }
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [agora, inStandardFeed, displayedFeedItems.length])

  const profileTarget = agora.profileView
    ? agora.getProfile(agora.profileView.pubkey)
    : null
  const profileTargetName = agora.profileView
    ? getProfileDisplayName(profileTarget, agora.profileView.pubkey)
    : ''
  const profileTargetNpub = useMemo(
    () => (agora.profileView ? encodeNpubSafe(agora.profileView.pubkey) : ''),
    [agora.profileView]
  )
  const profileTargetWebsite = sanitizeHttpUrl(profileTarget?.website, true)
  const profileTargetBanner = sanitizeHttpUrl(profileTarget?.banner)

  const profileDisplayedNotes: AgoraNote[] = useMemo(() => {
    if (!agora.profileView) return []
    switch (agora.profileView.tab) {
      case 'posts':
        return agora.profileView.posts
      case 'replies':
        return agora.profileView.replies
      case 'media': {
        const seen = new Set<string>()
        const combined: AgoraNote[] = []
        for (const n of [...agora.profileView.posts, ...agora.profileView.replies]) {
          if (n.media.length === 0 || seen.has(n.id)) continue
          seen.add(n.id)
          combined.push(n)
        }
        return combined.sort((a, b) => b.createdAt - a.createdAt)
      }
      case 'likes':
        return agora.profileView.likes
    }
  }, [agora.profileView])

  // ---------------------------------------------------------------------------
  // Agora Translation Mode (shared engine.translator: Opus-MT / M2M-100 / NLLB-200)
  // ---------------------------------------------------------------------------
  const translatorEnabled = translator.settings.enabled
  const myLanguage = translator.settings.myLanguage
  const sourceLanguage = translator.settings.sourceLanguage
  const explicitSourceLang = sourceLanguage !== 'Auto' ? sourceLanguage : undefined
  const translatorShortLabel = TRANSLATOR_MODELS[translator.modelKey].shortLabel
  const {
    translations: translatorTranslations,
    translateMessage,
    cancelScope,
    cancelDownload,
    preloadModel,
    updateSettings: updateTranslatorSettings,
    modelStatus: translatorModelStatus,
  } = translator

  const sourceLanguageOptions = useMemo(() => {
    const names = TRANSLATION_LANGUAGE_OPTIONS.map((o) => o.name)
    if (sourceLanguage !== 'Auto' && !names.includes(sourceLanguage)) {
      return [sourceLanguage, ...names]
    }
    return names
  }, [sourceLanguage])

  const myLanguageOptions = useMemo(() => {
    const names = TRANSLATION_LANGUAGE_OPTIONS.map((o) => o.name)
    return names.includes(myLanguage) ? names : [myLanguage, ...names]
  }, [myLanguage])

  const translationScopeKey = useMemo(() => {
    const viewPart = inThread
      ? `thread:${agora.thread?.focusedNoteId ?? ''}`
      : inProfile
        ? `profile:${agora.profileView?.pubkey ?? ''}:${agora.profileView?.tab ?? 'posts'}`
        : inSearch
          ? `search:${agora.activeHashtag || agora.searchQuery}`
          : `feed:${agora.activeTab}`
    return `agora:${viewPart}:${myLanguage}:${explicitSourceLang ?? 'Auto'}:${translator.modelKey}`
  }, [
    inThread,
    agora.thread?.focusedNoteId,
    inProfile,
    agora.profileView?.pubkey,
    agora.profileView?.tab,
    inSearch,
    agora.activeHashtag,
    agora.searchQuery,
    agora.activeTab,
    myLanguage,
    explicitSourceLang,
    translator.modelKey,
  ])

  const visibleTranslatableNotes = useMemo(() => {
    if (!translatorEnabled || inNotifications) {
      return [] as Array<{ note: AgoraNote; text: string }>
    }

    const rawPrimary: AgoraNote[] = []
    if (inThread && agora.thread) {
      if (agora.thread.focusedNote) rawPrimary.push(agora.thread.focusedNote)
      for (const anc of agora.thread.ancestors) rawPrimary.push(anc)
      for (const rep of agora.thread.replies) rawPrimary.push(rep)
    } else if (inProfile && agora.profileView) {
      for (const n of profileDisplayedNotes) rawPrimary.push(n)
    } else if (inSearch) {
      for (const n of agora.searchResults) rawPrimary.push(n)
    } else {
      for (const item of agora.feedItems) rawPrimary.push(item.note)
    }

    const result: Array<{ note: AgoraNote; text: string }> = []
    const seenIds = new Set<string>()

    const pushNote = (candidate: AgoraNote) => {
      if (result.length >= MAX_AGORA_TRANSLATE_NOTES) return
      if (seenIds.has(candidate.id)) return
      seenIds.add(candidate.id)
      if (candidate.contentWarning && !revealedCwIds.has(candidate.id)) return
      const text = extractTranslatableAgoraText(candidate)
      if (!text) return
      result.push({ note: candidate, text })
    }

    for (const primary of rawPrimary) {
      if (result.length >= MAX_AGORA_TRANSLATE_NOTES) break
      pushNote(primary)
      if (!primary.contentWarning || revealedCwIds.has(primary.id)) {
        const qIds = new Set<string>(primary.quoteIds)
        if (qIds.size < 2 && primary.content.includes('nostr:')) {
          for (const tok of tokenizeAgoraContent(primary.content, primary.media)) {
            if (tok.type === 'quote') qIds.add(tok.eventId)
          }
        }
        let qCount = 0
        for (const qid of qIds) {
          if (qCount >= 2 || result.length >= MAX_AGORA_TRANSLATE_NOTES) break
          qCount += 1
          const quoted = agora.getNote(qid)
          if (quoted) pushNote(quoted)
        }
      }
    }

    return result
  }, [
    translatorEnabled,
    inNotifications,
    inThread,
    inProfile,
    inSearch,
    agora,
    profileDisplayedNotes,
    revealedCwIds,
  ])

  const translationProgress = useMemo(() => {
    if (!translatorEnabled || visibleTranslatableNotes.length === 0) {
      return { totalTranslatable: 0, doneCount: 0, pendingCount: 0 }
    }
    let totalTranslatable = 0
    let doneCount = 0
    let pendingCount = 0
    for (const { note } of visibleTranslatableNotes) {
      totalTranslatable += 1
      const key = translationCacheKey(`agora:${note.id}`, myLanguage, explicitSourceLang)
      const entry = translatorTranslations[key]
      if (entry?.status === 'done' || entry?.status === 'error') {
        doneCount += 1
      } else {
        pendingCount += 1
      }
    }
    return { totalTranslatable, doneCount, pendingCount }
  }, [
    translatorEnabled,
    visibleTranslatableNotes,
    myLanguage,
    explicitSourceLang,
    translatorTranslations,
  ])

  // Cancel stale worker jobs immediately when switching Agora views, languages, model, or disabling
  useEffect(() => {
    cancelScope(translatorEnabled ? translationScopeKey : undefined)
  }, [translatorEnabled, translationScopeKey, cancelScope])

  // Cancel background Agora translation jobs cleanly on unmount
  useEffect(() => {
    return () => {
      cancelScope(undefined)
    }
  }, [cancelScope])

  // Auto-translate visible Agora posts, replies, ancestors & embedded quoted notes (max 3 in-flight)
  useEffect(() => {
    if (!translatorEnabled || translatorModelStatus === 'error') return
    if (visibleTranslatableNotes.length === 0) return

    let activeLoading = 0
    const candidates: Array<{ noteId: string; text: string }> = []

    for (const { note, text } of visibleTranslatableNotes) {
      const key = translationCacheKey(`agora:${note.id}`, myLanguage, explicitSourceLang)
      const entry = translatorTranslations[key]
      if (entry?.status === 'loading') {
        activeLoading += 1
        continue
      }
      if (entry?.status === 'done' || entry?.status === 'error') {
        continue
      }
      candidates.push({ noteId: note.id, text })
    }

    const slots = Math.max(0, MAX_AGORA_CONCURRENT_TRANSLATIONS - activeLoading)
    if (slots <= 0 || candidates.length === 0) return

    for (let i = 0; i < Math.min(slots, candidates.length); i += 1) {
      const cand = candidates[i]
      void translateMessage(`agora:${cand.noteId}`, cand.text, myLanguage, {
        sourceLang: explicitSourceLang ?? 'Auto',
        scopeKey: translationScopeKey,
        priority: 'visible',
      })
    }
  }, [
    translatorEnabled,
    translatorModelStatus,
    visibleTranslatableNotes,
    myLanguage,
    explicitSourceLang,
    translationScopeKey,
    translatorTranslations,
    translateMessage,
  ])

  const kbdNotes: AgoraNote[] = useMemo(() => {
    if (inProfile) return profileDisplayedNotes
    if (inSearch) return agora.searchResults
    if (inStandardFeed) return displayedFeedItems.map((it) => it.note)
    return []
  }, [agora.searchResults, displayedFeedItems, inProfile, inSearch, inStandardFeed, profileDisplayedNotes])

  // Desktop keyboard navigation (j/k, Enter/o, l, r, b, z, n, /, Esc)
  useEffect(() => {
    if (isMobileViewport) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (anySubModalOpen || leftDrawerOpen || rightDrawerOpen) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return
        }
      }

      const key = e.key
      if (key === '/') {
        e.preventDefault()
        if (searchInputRef.current) {
          searchInputRef.current.focus()
        } else {
          setMobileSearchOpen(true)
          window.setTimeout(() => searchInputRef.current?.focus(), 40)
        }
        return
      }

      if (key === 'n') {
        e.preventDefault()
        onPlaySound?.('click')
        setManualComposerModal({ kind: 'post' })
        return
      }

      if (key === 'Escape') {
        if (agora.canNavigateBack) {
          e.preventDefault()
          handleNavigateBack()
        } else if (kbdFocusedIndex >= 0) {
          e.preventDefault()
          setKbdFocusedIndex(-1)
        }
        return
      }

      if (kbdNotes.length === 0) return

      if (key === 'j' || key === 'k') {
        e.preventDefault()
        const nextIdx =
          key === 'j'
            ? Math.min(kbdNotes.length - 1, kbdFocusedIndex + 1)
            : Math.max(0, kbdFocusedIndex <= 0 ? 0 : kbdFocusedIndex - 1)
        setKbdFocusedIndex(nextIdx)
        window.requestAnimationFrame(() => {
          const cardEl = streamRef.current?.querySelector<HTMLElement>(
            `[data-agora-kbd-idx="${nextIdx}"]`
          )
          cardEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        })
        return
      }

      const focusedNote = kbdFocusedIndex >= 0 ? kbdNotes[kbdFocusedIndex] : undefined
      if (!focusedNote) return

      if (key === 'Enter' || key === 'o') {
        e.preventDefault()
        handleOpenThread(focusedNote.id)
      } else if (key === 'l') {
        e.preventDefault()
        onPlaySound?.('click')
        void agora.toggleLike(focusedNote)
      } else if (key === 'r') {
        e.preventDefault()
        onPlaySound?.('click')
        setManualComposerModal({ kind: 'reply', targetNote: focusedNote })
      } else if (key === 'b') {
        e.preventDefault()
        onPlaySound?.('click')
        void agora.toggleBookmark(focusedNote.id)
      } else if (key === 'z' && onOpenZap) {
        e.preventDefault()
        onPlaySound?.('click')
        const prof = agora.getProfile(focusedNote.pubkey)
        onOpenZap({
          pubkey: focusedNote.pubkey,
          nickname: getProfileDisplayName(prof, focusedNote.pubkey),
          lud16: prof?.lud16 ?? engine.zaps.getPeerLightningAddress(focusedNote.pubkey) ?? null,
          eventId: focusedNote.id,
          channelLabel: 'Agora',
        })
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    agora,
    anySubModalOpen,
    engine.zaps,
    handleNavigateBack,
    handleOpenThread,
    isMobileViewport,
    kbdFocusedIndex,
    kbdNotes,
    leftDrawerOpen,
    onOpenZap,
    onPlaySound,
    rightDrawerOpen,
  ])

  const renderNoteCard = (
    note: AgoraNote,
    opts?: {
      repostedBy?: string
      repostedByList?: string[]
      focused?: boolean
      isAncestor?: boolean
      showThreadConnector?: boolean
      kbdIndex?: number
    }
  ) => (
    <AgoraNoteCard
      key={opts?.repostedBy ? `repost:${opts.repostedBy}:${note.id}` : note.id}
      note={note}
      repostedBy={opts?.repostedBy}
      repostedByList={opts?.repostedByList}
      engine={engine}
      focused={opts?.focused}
      isAncestor={opts?.isAncestor}
      showThreadConnector={opts?.showThreadConnector}
      kbdFocused={opts?.kbdIndex !== undefined && opts.kbdIndex === kbdFocusedIndex}
      kbdIndex={opts?.kbdIndex}
      revealedCw={revealedCwIds.has(note.id)}
      onRevealCw={handleRevealCw}
      translationScopeKey={translationScopeKey}
      showOriginalKeys={showOriginalKeys}
      onToggleShowOriginal={handleToggleShowOriginal}
      onOpenThread={handleOpenThread}
      onOpenProfile={handleOpenProfile}
      onSelectHashtag={handleSelectHashtag}
      onReplyClick={(target) => setManualComposerModal({ kind: 'reply', targetNote: target })}
      onQuoteClick={(target) => setManualComposerModal({ kind: 'quote', targetNote: target })}
      onOpenDm={onOpenDm}
      onOpenAmailCompose={onOpenAmailCompose}
      onOpenZap={onOpenZap}
      onOpenLightbox={onOpenLightbox}
      onHoverAuthorStart={handleHoverAuthorStart}
      onHoverAuthorEnd={handleHoverAuthorEnd}
      onPlaySound={onPlaySound}
    />
  )

  const renderFeedItem = (item: AgoraFeedItem, idx: number) => (
    <AgoraNoteCard
      key={item.key}
      note={item.note}
      repostedBy={item.kind === 'repost' ? item.repostedBy : undefined}
      repostedByList={item.kind === 'repost' ? item.repostedByList : undefined}
      engine={engine}
      kbdFocused={idx === kbdFocusedIndex}
      kbdIndex={idx}
      revealedCw={revealedCwIds.has(item.note.id)}
      onRevealCw={handleRevealCw}
      translationScopeKey={translationScopeKey}
      showOriginalKeys={showOriginalKeys}
      onToggleShowOriginal={handleToggleShowOriginal}
      onOpenThread={handleOpenThread}
      onOpenProfile={handleOpenProfile}
      onSelectHashtag={handleSelectHashtag}
      onReplyClick={(target) => setManualComposerModal({ kind: 'reply', targetNote: target })}
      onQuoteClick={(target) => setManualComposerModal({ kind: 'quote', targetNote: target })}
      onOpenDm={onOpenDm}
      onOpenAmailCompose={onOpenAmailCompose}
      onOpenZap={onOpenZap}
      onOpenLightbox={onOpenLightbox}
      onHoverAuthorStart={handleHoverAuthorStart}
      onHoverAuthorEnd={handleHoverAuthorEnd}
      onPlaySound={onPlaySound}
    />
  )

  const countTreeDescendants = (node: AgoraReplyTreeNode): number => {
    let total = node.children.length
    for (const child of node.children) {
      total += countTreeDescendants(child)
    }
    return total
  }

  const renderReplyBranch = (node: AgoraReplyTreeNode): React.ReactNode => {
    const depth = Math.min(4, Math.max(0, node.depth))
    const hasChildren = node.children.length > 0
    const isCollapsed = collapsedBranches.has(node.note.id)
    const descendantCount = hasChildren ? countTreeDescendants(node) : 0

    return (
      <div
        key={node.note.id}
        className={`ag-agora-reply-branch depth-${depth}`}
        style={{ '--ag-reply-depth': String(depth) } as React.CSSProperties}
      >
        {renderNoteCard(node.note, {
          showThreadConnector: hasChildren && !isCollapsed,
        })}
        {hasChildren && (
          <div className="ag-agora-branch-toggle-wrap">
            <button
              type="button"
              className="ag-agora-branch-toggle"
              onClick={() => handleToggleBranchCollapse(node.note.id)}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? (
                <ChevronRight size={13} aria-hidden="true" />
              ) : (
                <ChevronDown size={13} aria-hidden="true" />
              )}
              <span>
                {isCollapsed ? 'Show' : 'Hide'} {descendantCount}{' '}
                {descendantCount === 1 ? 'reply' : 'replies'}
              </span>
            </button>
          </div>
        )}
        {hasChildren && !isCollapsed && (
          <div className="ag-agora-reply-children">
            {node.children.map((child) => renderReplyBranch(child))}
          </div>
        )}
      </div>
    )
  }

  const renderGroupedNotificationRow = (group: AgoraGroupedNotification) => {
    const primaryPk = group.actors[0] || group.items[0]?.actorPubkey || ''
    const primaryProfile = primaryPk ? agora.getProfile(primaryPk) : null
    const primaryName = primaryPk ? getProfileDisplayName(primaryProfile, primaryPk) : 'Someone'
    const secondPk = group.actors[1]
    const secondName = secondPk
      ? getProfileDisplayName(agora.getProfile(secondPk), secondPk)
      : null
    const extraCount = Math.max(0, group.actors.length - 2)
    const targetNote = group.targetNoteId ? agora.getNote(group.targetNoteId) : null
    const snippet = group.content?.trim() || targetNote?.content?.trim() || ''

    const actionText =
      group.kind === 'reply'
        ? 'replied to your post'
        : group.kind === 'mention'
          ? 'mentioned you'
          : group.kind === 'like'
            ? 'liked your post'
            : group.kind === 'repost'
              ? 'reposted your post'
              : 'zapped your post'

    const Icon =
      group.kind === 'reply'
        ? MessageCircle
        : group.kind === 'mention'
          ? AtSign
          : group.kind === 'like'
            ? Heart
            : group.kind === 'repost'
              ? Repeat2
              : Zap

    const stackedActors = group.actors.slice(0, 3)

    return (
      <button
        key={group.key}
        type="button"
        className="ag-agora-notif-row"
        onClick={() => {
          const destNoteId = group.targetNoteId || group.noteId
          if (destNoteId) handleOpenThread(destNoteId)
          else if (primaryPk) handleOpenProfile(primaryPk)
        }}
      >
        <span className={`ag-agora-notif-icon ${group.kind}`} aria-hidden="true">
          <Icon size={14} />
        </span>

        {stackedActors.length > 1 ? (
          <div className="ag-agora-notif-avatar-stack" aria-hidden="true">
            {stackedActors.map((pk) => {
              const prof = agora.getProfile(pk)
              return (
                <AgoraAvatar
                  key={pk}
                  engine={engine}
                  pubkey={pk}
                  picture={prof?.picture}
                  size="xs"
                  alt=""
                />
              )
            })}
          </div>
        ) : (
          <AgoraAvatar
            engine={engine}
            pubkey={primaryPk}
            picture={primaryProfile?.picture}
            size="sm"
            alt={primaryName}
          />
        )}

        <div className="ag-agora-notif-body">
          <div className="ag-agora-notif-top">
            <strong>
              {primaryName}
              {secondName && extraCount > 0 ? ',' : ''}
            </strong>
            {secondName && extraCount === 0 && (
              <>
                <span>and</span>
                <strong>{secondName}</strong>
              </>
            )}
            {secondName && extraCount > 0 && (
              <>
                <strong>{secondName}</strong>
                <span>
                  and {extraCount} {extraCount === 1 ? 'other' : 'others'}
                </span>
              </>
            )}
            <span>{actionText}</span>
            {group.kind === 'zap' && group.totalZapSats && group.totalZapSats > 0 && (
              <span className="ag-agora-notif-sats tabular">
                +{group.totalZapSats.toLocaleString()} sats
              </span>
            )}
            <span className="ag-agora-dot-sep">·</span>
            <span className="ag-agora-time tabular">
              {formatRelativeSeconds(group.createdAt)}
            </span>
          </div>
          {snippet && <div className="ag-agora-notif-snippet">{snippet}</div>}
        </div>
      </button>
    )
  }

  const searchFormEl = (
    <form className="ag-agora-search-form" onSubmit={handleSearchSubmit}>
      <Search size={14} className="ag-agora-search-icon" aria-hidden="true" />
      <input
        ref={searchInputRef}
        type="search"
        className="ag-agora-search-input"
        value={searchDraft}
        onChange={(e) => setSearchDraft(e.target.value)}
        placeholder="Search notes, #tags, npub, nevent…"
        aria-label="Search Agora notes, hashtags, or Nostr identifiers"
      />
      {(searchDraft || agora.searchQuery || agora.activeHashtag) && (
        <button
          type="button"
          className="ag-agora-search-clear"
          onClick={handleClearSearch}
          aria-label="Clear search"
        >
          <X size={13} />
        </button>
      )}
    </form>
  )

  const composerModalPortal = activeComposerModal
    ? (() => {
        const title =
          activeComposerModal.kind === 'reply'
            ? 'Reply'
            : activeComposerModal.kind === 'quote'
              ? 'Quote Post'
              : 'New Post'
        const submitLabel =
          activeComposerModal.kind === 'reply'
            ? 'Reply'
            : activeComposerModal.kind === 'quote'
              ? 'Quote Post'
              : 'Post'
        const placeholder =
          activeComposerModal.kind === 'reply'
            ? 'Write your reply…'
            : activeComposerModal.kind === 'quote'
              ? 'Add your commentary…'
              : "What's happening on Nostr?"

        const el = (
          <div
            className="ag-agora-modal-backdrop"
            role="presentation"
            data-no-swipe="true"
            onClick={closeComposerModal}
          >
            <div
              className="ag-agora-modal"
              role="dialog"
              aria-modal="true"
              aria-label={title}
              onClick={(e) => e.stopPropagation()}
            >
              <header className="ag-agora-modal-head">
                <h3 className="ag-agora-modal-title">{title}</h3>
                <button
                  type="button"
                  className="ag-agora-icon-btn"
                  onClick={closeComposerModal}
                  aria-label="Close composer"
                >
                  <X size={17} />
                </button>
              </header>
              <div className="ag-agora-modal-body">
                <AgoraComposer
                  engine={engine}
                  inModal
                  autoFocus
                  draftKey={
                    activeComposerModal.kind === 'reply'
                      ? `reply:${activeComposerModal.targetNote.id}`
                      : activeComposerModal.kind === 'quote'
                        ? `quote:${activeComposerModal.targetNote.id}`
                        : 'modal:new'
                  }
                  placeholder={placeholder}
                  submitLabel={submitLabel}
                  replyTarget={
                    activeComposerModal.kind === 'reply'
                      ? activeComposerModal.targetNote
                      : undefined
                  }
                  quoteTarget={
                    activeComposerModal.kind === 'quote'
                      ? activeComposerModal.targetNote
                      : undefined
                  }
                  onSubmitted={closeComposerModal}
                  onPlaySound={onPlaySound}
                />
              </div>
            </div>
          </div>
        )
        return typeof document !== 'undefined' ? createPortal(el, document.body) : el
      })()
    : null

  const drawerScrimProgress = Math.max(leftDrawerProgress, rightDrawerProgress)
  const isSwipingAnyDrawer = isSwipingLeftDrawer || isSwipingRightDrawer

  return (
    <div
      className={`ag-agora-workspace${agora.density === 'compact' ? ' is-compact' : ''}`}
      aria-label="Agora social feed"
      data-no-swipe="true"
    >
      <div
        ref={agoraStageRef}
        className="ag-agora-shell"
        style={
          {
            '--ag-agora-left-p': String(leftDrawerProgress),
            '--ag-agora-right-p': String(rightDrawerProgress),
            '--ag-agora-scrim-p': String(drawerScrimProgress),
          } as React.CSSProperties
        }
      >
        {/* Interactive Dimmed Scrim for Mobile Left/Right Slide-Over Drawers */}
        <div
          className={`ag-agora-drawer-scrim${
            leftDrawerOpen || rightDrawerOpen ? ' active' : ''
          }${isSwipingAnyDrawer ? ' is-swiping' : ''}`}
          onClick={closeDrawers}
          aria-hidden="true"
        />

        {/* ================= LEFT AGORA NAV (Desktop >= 868px | Slide-Over Tray <= 867px) ================= */}
        <aside
          className={`ag-agora-left ag-agora-left-drawer${leftDrawerOpen ? ' open' : ''}${
            isSwipingLeftDrawer ? ' is-swiping' : ''
          }`}
          aria-label="Agora navigation"
        >
          <div className="ag-agora-brand">
            <span className="ag-agora-brand-icon" aria-hidden="true">
              <Landmark size={17} />
            </span>
            <div className="ag-agora-brand-copy">
              <span className="ag-agora-brand-title">Agora</span>
              <span className="ag-agora-brand-sub">Nostr public square</span>
            </div>
            <button
              type="button"
              className="ag-agora-icon-btn ag-agora-drawer-close"
              onClick={() => setLeftDrawerOpen(false)}
              aria-label="Close Agora navigation"
            >
              <X size={17} />
            </button>
          </div>

          <nav className="ag-agora-nav" aria-label="Agora feeds">
            {FEED_NAV_ITEMS.map((item) => {
              const Icon = item.icon
              const isActive =
                !inThread && !inProfile && !inSearch && agora.activeTab === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`ag-agora-nav-item${isActive ? ' active' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => handleSelectTab(item.id)}
                >
                  <Icon size={17} />
                  <span className="truncate">{item.label}</span>
                  {item.beta && (
                    <span
                      className="ag-agora-nav-badge"
                      style={{
                        backgroundColor: 'var(--accent-soft)',
                        color: 'var(--accent)',
                        fontSize: '9.5px',
                        letterSpacing: '0.02em',
                        textTransform: 'uppercase',
                      }}
                    >
                      Beta
                    </span>
                  )}
                  {item.id === 'notifications' && agora.unreadNotificationCount > 0 && (
                    <span className="ag-agora-nav-badge tabular">
                      {agora.unreadNotificationCount > 99 ? '99+' : agora.unreadNotificationCount}
                    </span>
                  )}
                </button>
              )
            })}

            <button
              type="button"
              className={`ag-agora-nav-item${isMyProfileOpen ? ' active' : ''}`}
              aria-current={isMyProfileOpen ? 'page' : undefined}
              onClick={() => handleOpenProfile(agora.myPubkey)}
            >
              <User size={17} />
              <span className="truncate">My Profile</span>
            </button>
          </nav>

          <button
            type="button"
            className="ag-agora-compose-cta"
            onClick={() => {
              onPlaySound?.('click')
              closeDrawers()
              setManualComposerModal({ kind: 'post' })
            }}
          >
            <PenLine size={15} />
            <span>New Post</span>
          </button>

          <div className="ag-agora-identity-card">
            <button
              type="button"
              className="ag-agora-identity-main"
              onClick={() => handleOpenProfile(agora.myPubkey)}
              title="Open my Nostr profile"
            >
              <AgoraAvatar
                engine={engine}
                pubkey={agora.myPubkey}
                picture={agora.myProfile?.picture}
                size="sm"
                alt={myDisplayName}
              />
              <div className="ag-agora-identity-text">
                <span className="ag-agora-identity-name truncate">{myDisplayName}</span>
                <span className="ag-agora-identity-npub mono truncate">
                  {shortPubkey(myNpub, 8, 4)}
                </span>
              </div>
            </button>
            <button
              type="button"
              className="ag-agora-identity-edit"
              onClick={() => {
                onPlaySound?.('click')
                closeDrawers()
                setEditProfileOpen(true)
              }}
              title="Edit Profile"
              aria-label="Edit Nostr profile"
            >
              <PenLine size={14} />
            </button>
          </div>
        </aside>

        {/* ================= CENTER MAIN STREAM ================= */}
        <section className="ag-agora-center" aria-label="Agora stream">
          {/* Sticky Center Header */}
          <header className="ag-agora-header">
            <div className="ag-agora-header-left">
              {inThread ? (
                <>
                  <button
                    type="button"
                    className="ag-agora-icon-btn"
                    onClick={handleNavigateBack}
                    aria-label="Back from thread"
                  >
                    <ArrowLeft size={17} />
                  </button>
                  <div className="ag-agora-header-titles">
                    <span className="ag-agora-header-title">Thread</span>
                    {agora.thread && (
                      <span className="ag-agora-header-sub tabular">
                        {agora.thread.replies.length}{' '}
                        {agora.thread.replies.length === 1 ? 'reply' : 'replies'}
                      </span>
                    )}
                  </div>
                </>
              ) : inProfile ? (
                <>
                  <button
                    type="button"
                    className="ag-agora-icon-btn"
                    onClick={handleNavigateBack}
                    aria-label="Back from profile"
                  >
                    <ArrowLeft size={17} />
                  </button>
                  <div className="ag-agora-header-titles">
                    <span className="ag-agora-header-title truncate">{profileTargetName}</span>
                    {agora.profileView && (
                      <span className="ag-agora-header-sub tabular">
                        {agora.profileView.posts.length}{' '}
                        {agora.profileView.posts.length === 1 ? 'post' : 'posts'}
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={`ag-agora-icon-btn ag-agora-mobile-menu-btn${
                      leftDrawerOpen ? ' active' : ''
                    }`}
                    onClick={() => {
                      onPlaySound?.('click')
                      handleLeftDrawerOpenChange(!leftDrawerOpen)
                    }}
                    aria-expanded={leftDrawerOpen}
                    aria-label={
                      agora.unreadNotificationCount > 0
                        ? `Open Agora navigation (${agora.unreadNotificationCount} unread notifications)`
                        : 'Open Agora navigation'
                    }
                    title="Agora navigation"
                  >
                    <Menu size={19} />
                    {agora.unreadNotificationCount > 0 && (
                      <span className="ag-agora-menu-unread-dot" aria-hidden="true" />
                    )}
                  </button>

                  {agora.activeHashtag ? (
                    <span className="ag-agora-filter-chip">
                      <Hash size={12} />
                      <span className="truncate">{agora.activeHashtag}</span>
                      <button
                        type="button"
                        className="ag-agora-filter-clear"
                        onClick={handleClearSearch}
                        aria-label="Clear hashtag filter"
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ) : agora.searchQuery ? (
                    <span className="ag-agora-header-title">
                      <span>Search</span>
                      <span className="ag-agora-filter-chip">
                        <span className="truncate">{agora.searchQuery}</span>
                        <button
                          type="button"
                          className="ag-agora-filter-clear"
                          onClick={handleClearSearch}
                          aria-label="Clear search"
                        >
                          <X size={12} />
                        </button>
                      </span>
                    </span>
                  ) : (
                    <div className="ag-agora-header-titles">
                      <span className="ag-agora-header-title truncate">
                        <span className="ag-agora-header-prefix">Agora · </span>
                        {activeTabTitle}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="ag-agora-header-actions">
              {inThread && agora.thread && (
                <button
                  type="button"
                  className="ag-agora-icon-btn"
                  onClick={() => {
                    const focusedId =
                      agora.thread!.focusedNote?.id ?? agora.thread!.focusedNoteId
                    const focusedAuthor = agora.thread!.focusedNote?.pubkey
                    const shareUrl = buildAgoraNoteShareUrl(
                      focusedId,
                      focusedAuthor,
                      agora.socialRelays,
                    )
                    void copyTextSafe(shareUrl).then((ok) => {
                      if (ok) {
                        onPlaySound?.('click')
                        engine.pushToast('success', 'Agora post link copied', shareUrl)
                      } else {
                        engine.pushToast('error', 'Clipboard copy failed')
                      }
                    })
                  }}
                  aria-label="Copy thread link"
                  title="Copy shareable link to this post"
                >
                  <Link2 size={16} />
                </button>
              )}

              <button
                type="button"
                className={`ag-agora-icon-btn ag-agora-translate-toggle-btn${translatorEnabled ? ' active' : ''}`}
                onClick={() => {
                  onPlaySound?.('click')
                  updateTranslatorSettings({ enabled: !translatorEnabled })
                }}
                aria-pressed={translatorEnabled}
                aria-label={
                  translatorEnabled
                    ? `Exit Translator Mode (${myLanguage})`
                    : `Translate posts (${myLanguage})`
                }
                title={
                  translatorEnabled
                    ? `Exit Translator Mode (${myLanguage})`
                    : `Translate posts (${myLanguage})`
                }
              >
                <Languages size={16} />
              </button>

              <button
                type="button"
                className={`ag-agora-icon-btn ag-agora-search-toggle-btn${mobileSearchOpen ? ' active' : ''}`}
                onClick={() => {
                  setMobileSearchOpen((v) => !v)
                  window.setTimeout(() => searchInputRef.current?.focus(), 40)
                }}
                aria-expanded={mobileSearchOpen}
                aria-label="Search Agora"
                title="Search Agora"
              >
                <Search size={16} />
              </button>

              <button
                type="button"
                className="ag-agora-icon-btn ag-agora-mobile-compose-btn"
                onClick={() => {
                  onPlaySound?.('click')
                  closeDrawers()
                  setManualComposerModal({ kind: 'post' })
                }}
                aria-label="New Post"
                title="New Post"
              >
                <PenSquare size={17} />
              </button>

              <button
                type="button"
                className={`ag-agora-icon-btn ag-agora-mobile-discover-btn${
                  rightDrawerOpen ? ' active' : ''
                }`}
                onClick={() => {
                  onPlaySound?.('click')
                  handleRightDrawerOpenChange(!rightDrawerOpen)
                }}
                aria-expanded={rightDrawerOpen}
                aria-label="Discover on Agora"
                title="Discover"
              >
                <Compass size={18} />
              </button>

              <button
                type="button"
                className={`ag-agora-icon-btn ag-agora-density-btn${
                  agora.density === 'compact' ? ' active' : ''
                }`}
                onClick={() => {
                  onPlaySound?.('click')
                  agora.setDensity(agora.density === 'compact' ? 'comfortable' : 'compact')
                }}
                aria-pressed={agora.density === 'compact'}
                aria-label={
                  agora.density === 'compact'
                    ? 'Switch to comfortable density'
                    : 'Switch to compact density'
                }
                title={
                  agora.density === 'compact'
                    ? 'Density: Compact (click for Comfortable)'
                    : 'Density: Comfortable (click for Compact)'
                }
              >
                {agora.density === 'compact' ? <LayoutList size={15} /> : <Rows3 size={15} />}
              </button>

              <button
                type="button"
                className="ag-agora-icon-btn"
                disabled={agora.loadingFeed}
                onClick={() => {
                  onPlaySound?.('click')
                  agora.refresh()
                }}
                aria-label="Refresh feed"
                title="Refresh"
              >
                <RefreshCw size={15} className={agora.loadingFeed ? 'ag-agora-spin' : undefined} />
              </button>
            </div>
          </header>

          {/* Compact Agora Translation Status Bar (visible when Translator Mode is active) */}
          {translatorEnabled && (
            <div
              className="ag-agora-translator-bar"
              role="region"
              aria-label="Agora translator controls"
            >
              <div className="ag-agora-tr-row">
                <div className="ag-agora-tr-controls">
                  <span className="ag-agora-tr-icon" aria-hidden="true">
                    <Languages size={13} />
                  </span>

                  <label className="ag-agora-tr-select-wrap" title="Source post language">
                    <span className="ag-agora-tr-label">From</span>
                    <select
                      className="ag-agora-tr-select"
                      value={sourceLanguage}
                      onChange={(e) =>
                        updateTranslatorSettings({ sourceLanguage: e.target.value })
                      }
                      aria-label="Source post language"
                    >
                      <option value="Auto">Auto</option>
                      {sourceLanguageOptions.map((lang) => (
                        <option key={lang} value={lang}>
                          {lang}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="ag-agora-tr-select-wrap" title="Translate posts to language">
                    <span className="ag-agora-tr-label">To</span>
                    <select
                      className="ag-agora-tr-select"
                      value={myLanguage}
                      onChange={(e) => updateTranslatorSettings({ myLanguage: e.target.value })}
                      aria-label="Target reading language"
                    >
                      {myLanguageOptions.map((lang) => (
                        <option key={lang} value={lang}>
                          {lang}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="ag-agora-tr-right">
                  {translatorModelStatus === 'downloading' ? (
                    <>
                      <span
                        className="ag-agora-tr-status downloading tabular"
                        title={translator.modelLabel}
                      >
                        <Loader2 size={12} className="ag-agora-spin" aria-hidden="true" />
                        <span>
                          {translatorShortLabel} · {Math.round(translator.downloadProgress)}%
                        </span>
                      </span>
                      <button
                        type="button"
                        className="ag-agora-tr-pill-btn"
                        onClick={() => cancelDownload()}
                        title="Cancel model download"
                        aria-label="Cancel model download"
                      >
                        <span>Cancel</span>
                      </button>
                    </>
                  ) : translatorModelStatus === 'error' ? (
                    <button
                      type="button"
                      className="ag-agora-tr-status error"
                      onClick={() => void preloadModel()}
                      title={translator.modelError || 'Retry loading translator model'}
                    >
                      <AlertCircle size={12} aria-hidden="true" />
                      <span>Retry model</span>
                    </button>
                  ) : translationProgress.pendingCount > 0 ? (
                    <span
                      className="ag-agora-tr-status translating tabular"
                      title={`Translating posts (${translationProgress.doneCount} of ${translationProgress.totalTranslatable} done)`}
                    >
                      <Loader2 size={12} className="ag-agora-spin" aria-hidden="true" />
                      <span>
                        Translating ({translationProgress.doneCount}/
                        {translationProgress.totalTranslatable})
                      </span>
                    </span>
                  ) : (
                    <span
                      className="ag-agora-tr-status ready"
                      title={`${translator.modelLabel} · On-device translation`}
                    >
                      <span>
                        {translatorShortLabel}
                        {translator.runtimeDevice
                          ? ` · ${translator.runtimeDevice === 'webgpu' ? 'WebGPU' : 'WASM'}`
                          : ''}
                      </span>
                    </span>
                  )}

                  <button
                    type="button"
                    className="ag-agora-tr-exit-btn"
                    onClick={() => updateTranslatorSettings({ enabled: false })}
                    title="Exit Translator Mode"
                    aria-label="Exit Translator Mode"
                  >
                    <X size={13} aria-hidden="true" />
                    <span className="ag-agora-tr-exit-label">Exit</span>
                  </button>
                </div>
              </div>

              {translatorModelStatus === 'downloading' && (
                <div className="ag-agora-tr-progress-track" aria-hidden="true">
                  <div
                    className="ag-agora-tr-progress-fill"
                    style={{
                      width: `${Math.max(4, Math.min(100, Math.round(translator.downloadProgress)))}%`,
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Collapsible Mobile / Tablet Search & Trending Drawer */}
          {mobileSearchOpen && (
            <div className="ag-agora-inline-search-drawer">
              {searchFormEl}
              {agora.trendingHashtags.length > 0 && (
                <div className="ag-agora-tag-cloud">
                  {agora.trendingHashtags.slice(0, 8).map((item) => (
                    <span
                      key={item.tag}
                      className={`ag-agora-trend-item-wrap${
                        agora.activeHashtag === item.tag ? ' active' : ''
                      }`}
                    >
                      <button
                        type="button"
                        className={`ag-agora-tag-chip${
                          agora.activeHashtag === item.tag ? ' active' : ''
                        }`}
                        onClick={() => handleSelectHashtag(item.tag)}
                      >
                        <span>#{item.tag}</span>
                      </button>
                      <button
                        type="button"
                        className="ag-agora-trend-hide-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          onPlaySound?.('click')
                          agora.hideTrendingTopic(item.tag)
                        }}
                        aria-label={`Hide #${item.tag} from trending`}
                        title="Hide from trending"
                      >
                        <X size={11} aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Main Scrollable Stream Body */}
          <div className="ag-agora-stream" ref={streamRef}>
            {isMobileViewport && (
              <div
                className={`ag-agora-ptr${ptrDragging ? ' is-dragging' : ''}${
                  ptrReady ? ' is-ready' : ''
                }${ptrRefreshing ? ' is-refreshing' : ''}`}
                style={{ height: `${Math.round(effectivePtrHeight)}px` }}
                aria-hidden={!ptrActive}
                role={ptrRefreshing ? 'status' : undefined}
                aria-live={ptrRefreshing ? 'polite' : undefined}
              >
                <div
                  className="ag-agora-ptr-pill"
                  style={{
                    opacity: ptrRefreshing ? 1 : Math.min(1, ptrProgress * 1.15),
                    transform: ptrRefreshing
                      ? 'scale(1)'
                      : `scale(${(0.88 + 0.12 * ptrProgress).toFixed(3)})`,
                  }}
                >
                  <RefreshCw
                    size={14}
                    className={`ag-agora-ptr-icon${ptrRefreshing ? ' ag-spin ag-agora-spin' : ''}`}
                    style={
                      ptrRefreshing
                        ? undefined
                        : { transform: `rotate(${Math.round(ptrProgress * 270)}deg)` }
                    }
                    aria-hidden="true"
                  />
                  <span className="ag-agora-ptr-label">{ptrLabel}</span>
                </div>
              </div>
            )}

            {/* ===== VIEW A: FULL THREAD VIEW ===== */}
            {inThread && agora.thread && (
              <>
                {agora.thread.ancestors.map((anc) =>
                  renderNoteCard(anc, { isAncestor: true, showThreadConnector: true })
                )}

                {agora.thread.focusedNote ? (
                  <>
                    {renderNoteCard(agora.thread.focusedNote, { focused: true })}
                    <AgoraComposer
                      engine={engine}
                      draftKey={`reply:${agora.thread.focusedNote.id}`}
                      replyTarget={agora.thread.focusedNote}
                      placeholder={`Reply to @${getProfileDisplayName(
                        agora.getProfile(agora.thread.focusedNote.pubkey),
                        agora.thread.focusedNote.pubkey
                      )}…`}
                      submitLabel="Reply"
                      onPlaySound={onPlaySound}
                    />
                  </>
                ) : agora.thread.loading ? (
                  <div className="ag-agora-empty">
                    <Loader2 size={22} className="ag-agora-spin" />
                    <p className="ag-agora-empty-sub">Loading thread from Nostr relays…</p>
                  </div>
                ) : (
                  <div className="ag-agora-empty">
                    <p className="ag-agora-empty-title">Note not found</p>
                    <p className="ag-agora-empty-sub">
                      This note could not be fetched from connected social relays.
                    </p>
                  </div>
                )}

                {replyTree.length > 0 ? (
                  <div className="ag-agora-reply-tree">
                    {replyTree.map((branch) => renderReplyBranch(branch))}
                  </div>
                ) : !agora.thread.loading && agora.thread.focusedNote ? (
                  <div className="ag-agora-empty">
                    <p className="ag-agora-empty-sub">No replies yet — start the conversation above.</p>
                  </div>
                ) : null}
              </>
            )}

            {/* ===== VIEW B: FULL PROFILE VIEW ===== */}
            {inProfile && agora.profileView && (
              <>
                <div className="ag-agora-profile-banner">
                  {profileTargetBanner && (
                    <AgoraScreenedImage
                      engine={engine}
                      url={profileTargetBanner}
                      senderPubkey={agora.profileView.pubkey}
                      variant="banner"
                      alt=""
                    />
                  )}
                </div>

                <div className="ag-agora-profile-body">
                  <div className="ag-agora-profile-top-row">
                    {isMyProfileOpen ? (
                      <button
                        type="button"
                        className="ag-agora-profile-avatar-edit-btn"
                        onClick={() => {
                          onPlaySound?.('click')
                          setEditProfileOpen(true)
                        }}
                        aria-label="Change profile picture"
                        title="Change profile picture"
                      >
                        <AgoraAvatar
                          engine={engine}
                          pubkey={agora.profileView.pubkey}
                          picture={profileTarget?.picture}
                          size="lg"
                          alt={profileTargetName}
                        />
                        <span className="ag-agora-profile-avatar-cam" aria-hidden="true">
                          <Camera size={14} />
                        </span>
                      </button>
                    ) : (
                      <AgoraAvatar
                        engine={engine}
                        pubkey={agora.profileView.pubkey}
                        picture={profileTarget?.picture}
                        size="lg"
                        alt={profileTargetName}
                      />
                    )}

                    <div className="ag-agora-profile-actions">
                      <button
                        type="button"
                        className="ag-agora-pill-btn"
                        onClick={() => {
                          const shareUrl = buildAgoraProfileShareUrl(agora.profileView!.pubkey)
                          void copyTextSafe(shareUrl).then((ok) => {
                            if (ok) {
                              onPlaySound?.('click')
                              engine.pushToast('success', 'Agora profile link copied', shareUrl)
                            } else {
                              engine.pushToast('error', 'Clipboard copy failed')
                            }
                          })
                        }}
                        title="Copy shareable Agora profile link"
                      >
                        <Link2 size={13} />
                        <span>Copy Link</span>
                      </button>
                      {isMyProfileOpen ? (
                        <button
                          type="button"
                          className="ag-agora-pill-btn primary"
                          onClick={() => {
                            onPlaySound?.('click')
                            setEditProfileOpen(true)
                          }}
                        >
                          <PenLine size={13} />
                          <span>Edit Profile</span>
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={`ag-agora-pill-btn ${
                              agora.isFollowing(agora.profileView.pubkey) ? 'following' : 'primary'
                            }`}
                            onClick={() => handleToggleFollow(agora.profileView!.pubkey)}
                          >
                            <span>
                              {agora.isFollowing(agora.profileView.pubkey) ? 'Following' : 'Follow'}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="ag-agora-pill-btn"
                            onClick={() =>
                              onOpenDm(agora.profileView!.pubkey, profileTargetName)
                            }
                          >
                            <MessageCircle size={13} />
                            <span>Message</span>
                          </button>
                          {AGORA_WOT_DISCOVERY_ENABLED && (
                            <button
                              type="button"
                              className="ag-agora-pill-btn"
                              onClick={() => {
                                setDiscoverSimilarPubkey(agora.profileView!.pubkey)
                                handleSelectTab('discover')
                              }}
                              title="Find similar voices in Web-of-Trust Discovery"
                            >
                              <Compass size={13} />
                              <span>Similar</span>
                            </button>
                          )}
                          {onOpenAmailCompose && (
                            <button
                              type="button"
                              className="ag-agora-pill-btn"
                              onClick={() =>
                                onOpenAmailCompose(agora.profileView!.pubkey, profileTargetName)
                              }
                            >
                              <Mail size={13} />
                              <span>Agmail</span>
                            </button>
                          )}
                          {onOpenZap && (
                            <button
                              type="button"
                              className="ag-agora-pill-btn"
                              onClick={() =>
                                onOpenZap({
                                  pubkey: agora.profileView!.pubkey,
                                  nickname: profileTargetName,
                                  lud16: profileTarget?.lud16 ?? null,
                                  channelLabel: 'Agora',
                                })
                              }
                            >
                              <Zap size={13} />
                              <span>Zap</span>
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  <div className="ag-agora-profile-name-block">
                    <div className="ag-agora-profile-name-row">
                      <h2 className="ag-agora-profile-name">{profileTargetName}</h2>
                      {!isMyProfileOpen && agora.profileView.followsMe && (
                        <span className="ag-agora-follows-you-pill">Follows you</span>
                      )}
                    </div>
                    <div className="ag-agora-profile-handles">
                      <AgoraNip05Badge
                        engine={engine}
                        pubkey={agora.profileView.pubkey}
                        rawNip05={profileTarget?.nip05}
                        fullWidth
                        iconSize={13}
                      />
                      <button
                        type="button"
                        className="ag-agora-npub-copy mono"
                        onClick={() => {
                          void copyTextSafe(profileTargetNpub).then((ok) => {
                            if (ok) {
                              setCopiedNpub(true)
                              window.setTimeout(() => setCopiedNpub(false), 1600)
                            }
                          })
                        }}
                        title="Copy npub"
                      >
                        <span>{shortPubkey(profileTargetNpub, 10, 5)}</span>
                        {copiedNpub ? <Check size={11} /> : <Copy size={11} />}
                      </button>
                    </div>
                  </div>

                  {profileTarget?.about && (
                    <div className="ag-agora-profile-bio">{profileTarget.about}</div>
                  )}

                  <div className="ag-agora-profile-meta-row">
                    {profileTargetWebsite && (() => {
                      const profilePk = agora.profileView!.pubkey
                      const warnProfileLink =
                        !isMyProfileOpen &&
                        !engine.isTrusted(profilePk) &&
                        !engine.settings.allowUntrustedLinks
                      return (
                        <a
                          href={profileTargetWebsite}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`ag-agora-profile-meta-item ag-agora-ext-link${warnProfileLink ? ' ag-untrusted-link' : ''}`}
                          title={
                            warnProfileLink
                              ? 'Untrusted profile — click to review link before opening'
                              : undefined
                          }
                          onClick={(e) => {
                            if (warnProfileLink) {
                              e.preventDefault()
                              requestUntrustedLinkOpen({
                                url: profileTargetWebsite,
                                senderHandle: profileTargetName,
                                senderPubkey: profilePk,
                              })
                              return
                            }
                            if (
                              parseAgoraShareUrl(profileTargetWebsite) &&
                              tryOpenInternalAgoraLink(profileTargetWebsite)
                            ) {
                              e.preventDefault()
                            }
                          }}
                          onAuxClick={(e) => {
                            if (warnProfileLink && e.button === 1) {
                              e.preventDefault()
                              requestUntrustedLinkOpen({
                                url: profileTargetWebsite,
                                senderHandle: profileTargetName,
                                senderPubkey: profilePk,
                              })
                            }
                          }}
                        >
                          <Link2 size={13} />
                          <span className="truncate">
                            {profileTargetWebsite.replace(/^https?:\/\//i, '').replace(/\/+$/, '')}
                          </span>
                        </a>
                      )
                    })()}
                    {profileTarget?.lud16 && (
                      <span className="ag-agora-profile-meta-item">
                        <Zap size={13} />
                        <span className="truncate">{profileTarget.lud16}</span>
                      </span>
                    )}
                    <button
                      type="button"
                      className="ag-agora-profile-meta-item ag-agora-profile-stat-btn tabular"
                      onClick={() => {
                        onPlaySound?.('click')
                        setSocialListModal({
                          title: `${profileTargetName} · Following`,
                          pubkeys: agora.profileView!.followingPubkeys,
                        })
                      }}
                    >
                      <strong>{agora.profileView.followingPubkeys.length.toLocaleString()}</strong>
                      <span>Following</span>
                    </button>
                    <button
                      type="button"
                      className="ag-agora-profile-meta-item ag-agora-profile-stat-btn tabular"
                      onClick={() => {
                        onPlaySound?.('click')
                        setSocialListModal({
                          title: `${profileTargetName} · Followers`,
                          pubkeys: agora.profileView!.followerPubkeys,
                        })
                      }}
                    >
                      <strong>{agora.profileView.followerPubkeys.length.toLocaleString()}</strong>
                      <span>Followers</span>
                    </button>
                  </div>
                </div>

                <div className="ag-agora-subtabs" role="tablist" aria-label="Profile sections">
                  {PROFILE_TABS.map((t) => {
                    const active = agora.profileView?.tab === t.id
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className={`ag-agora-subtab${active ? ' active' : ''}`}
                        onClick={() => agora.setProfileTab(t.id)}
                      >
                        {t.label}
                      </button>
                    )
                  })}
                </div>

                {agora.profileView.loading && profileDisplayedNotes.length === 0 ? (
                  <div className="ag-agora-skeleton-list">
                    <AgoraSkeletonCard />
                    <AgoraSkeletonCard />
                    <AgoraSkeletonCard />
                  </div>
                ) : profileDisplayedNotes.length > 0 ? (
                  profileDisplayedNotes.map((n, idx) => renderNoteCard(n, { kbdIndex: idx }))
                ) : (
                  <div className="ag-agora-empty">
                    <p className="ag-agora-empty-sub">No {agora.profileView.tab} yet.</p>
                  </div>
                )}
              </>
            )}

            {/* ===== VIEW C: SEARCH / HASHTAG RESULTS ===== */}
            {inSearch && (
              <>
                {agora.searchProfiles.length > 0 && (
                  <div className="ag-agora-search-profiles">
                    <span className="ag-agora-section-kicker">Matching Profiles</span>
                    <div className="ag-agora-voice-list">
                      {agora.searchProfiles.slice(0, 5).map((p) => (
                        <AgoraVoiceRow
                          key={p.pubkey}
                          engine={engine}
                          profile={p}
                          isSelf={p.pubkey.toLowerCase() === agora.myPubkey.toLowerCase()}
                          following={agora.isFollowing(p.pubkey)}
                          onOpenProfile={handleOpenProfile}
                          onToggleFollow={handleToggleFollow}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {agora.searchLoading && agora.searchResults.length === 0 ? (
                  <div className="ag-agora-skeleton-list">
                    <AgoraSkeletonCard />
                    <AgoraSkeletonCard />
                    <AgoraSkeletonCard />
                  </div>
                ) : agora.searchResults.length > 0 ? (
                  agora.searchResults.map((n, idx) => renderNoteCard(n, { kbdIndex: idx }))
                ) : (
                  <div className="ag-agora-empty">
                    <p className="ag-agora-empty-title">No matching notes</p>
                    <p className="ag-agora-empty-sub">
                      Try another keyword, #hashtag, npub1, or nevent1 identifier.
                    </p>
                  </div>
                )}
              </>
            )}

            {/* ===== VIEW D: GROUPED & FILTERABLE NOTIFICATIONS ===== */}
            {inNotifications && (
              <>
                <div
                  className="ag-agora-feed-filters"
                  role="tablist"
                  aria-label="Filter notifications"
                >
                  {NOTIFICATION_FILTER_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="tab"
                      aria-selected={notifFilter === opt.id}
                      className={`ag-agora-filter-pill${notifFilter === opt.id ? ' active' : ''}`}
                      onClick={() => {
                        onPlaySound?.('click')
                        setNotifFilter(opt.id)
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {groupedNotifications.length > 0 ? (
                  groupedNotifications.map(renderGroupedNotificationRow)
                ) : (
                  <div className="ag-agora-empty">
                    <Bell size={22} />
                    <p className="ag-agora-empty-title">
                      {notifFilter === 'all' ? 'All caught up' : 'No matching notifications'}
                    </p>
                    <p className="ag-agora-empty-sub">
                      Replies, mentions, likes, reposts, and zaps on your posts appear here.
                    </p>
                  </div>
                )}
              </>
            )}

            {/* ===== VIEW D2: LONG-FORM ARTICLES (NIP-23) ===== */}
            {inArticles && (
              <>
                {agora.loadingFeed && agora.articles.length === 0 ? (
                  <div className="ag-agora-skeleton-list">
                    <AgoraSkeletonCard />
                    <AgoraSkeletonCard />
                    <AgoraSkeletonCard />
                  </div>
                ) : agora.articles.length > 0 ? (
                  <div className="ag-agora-articles-list">
                    {agora.articles.map((article) => (
                      <AgoraArticleCard
                        key={article.id}
                        engine={engine}
                        article={article}
                        onOpen={(art) => {
                          onPlaySound?.('click')
                          agora.openArticle(art.id)
                        }}
                        onOpenProfile={handleOpenProfile}
                        onSelectHashtag={handleSelectHashtag}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="ag-agora-empty">
                    <BookOpen size={22} />
                    <p className="ag-agora-empty-title">No long-form articles yet</p>
                    <p className="ag-agora-empty-sub">
                      NIP-23 essays and long-form articles from Nostr relays appear here.
                    </p>
                  </div>
                )}
              </>
            )}

            {/* ===== VIEW D3: WEB-OF-TRUST GRAPH DISCOVERY (Experimental) ===== */}
            {inDiscover && (
              <React.Suspense
                fallback={
                  <div className="ag-agora-skeleton-list">
                    <AgoraSkeletonCard />
                    <AgoraSkeletonCard />
                    <AgoraSkeletonCard />
                  </div>
                }
              >
                <AgoraDiscoveryView
                  engine={engine}
                  initialSimilarPubkey={discoverSimilarPubkey}
                  onConsumedInitialSimilar={() => setDiscoverSimilarPubkey(null)}
                  onOpenProfile={handleOpenProfile}
                  onOpenThread={handleOpenThread}
                  onOpenArticle={(articleId) => {
                    onPlaySound?.('click')
                    agora.openArticle(articleId)
                  }}
                  onOpenDm={onOpenDm}
                  onPlaySound={onPlaySound}
                />
              </React.Suspense>
            )}

            {/* ===== VIEW E: STANDARD FEED (Following / Global / Trending / Bookmarks) ===== */}
            {inStandardFeed && (
              <>
                {showInlineComposer && (
                  <AgoraComposer
                    engine={engine}
                    draftKey="feed:new"
                    placeholder="What's happening on Nostr?"
                    submitLabel="Post"
                    onPlaySound={onPlaySound}
                  />
                )}

                {(agora.activeTab === 'following' || agora.activeTab === 'global') && (
                  <div className="ag-agora-feed-filters" role="region" aria-label="Feed filters and lists">
                    <div className="ag-agora-filter-pills">
                      {FEED_FILTER_OPTIONS.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`ag-agora-filter-pill${
                            agora.feedFilter === opt.id ? ' active' : ''
                          }`}
                          aria-pressed={agora.feedFilter === opt.id}
                          onClick={() => {
                            onPlaySound?.('click')
                            agora.setFeedFilter(opt.id)
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}

                      {agora.customLists.map((list) => {
                        const listActive = agora.activeListId === list.id
                        return (
                          <button
                            key={list.id}
                            type="button"
                            className={`ag-agora-filter-pill is-list${listActive ? ' active' : ''}`}
                            aria-pressed={listActive}
                            onClick={() => {
                              onPlaySound?.('click')
                              agora.setActiveListId(listActive ? null : list.id)
                            }}
                            title={list.description || `${list.pubkeys.length} accounts`}
                          >
                            <span className="truncate">{list.title}</span>
                          </button>
                        )
                      })}
                    </div>

                    <button
                      type="button"
                      className="ag-agora-curation-btn"
                      onClick={() => {
                        onPlaySound?.('click')
                        setCurationModalOpen(true)
                      }}
                      title="Manage muted words, muted threads, and custom people lists"
                    >
                      <SlidersHorizontal size={12} aria-hidden="true" />
                      <span>Mutes &amp; Lists</span>
                    </button>
                  </div>
                )}

                {agora.pendingNewCount > 0 && (
                  <div className="ag-agora-pending-wrap">
                    <button
                      type="button"
                      className="ag-agora-pending-btn"
                      onClick={() => {
                        onPlaySound?.('click')
                        agora.flushPendingNotes()
                        streamRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
                      }}
                    >
                      <ArrowUp size={13} />
                      <span className="tabular">
                        {agora.pendingNewCount}{' '}
                        {agora.pendingNewCount === 1 ? 'new post' : 'new posts'}
                      </span>
                    </button>
                  </div>
                )}

                {standalonePolls.length > 0 && (
                  <div className="ag-agora-polls-strip" role="region" aria-label="Active Nostr polls">
                    {standalonePolls.map((poll) => (
                      <AgoraPollCard
                        key={poll.id}
                        engine={engine}
                        poll={poll}
                        onOpenProfile={handleOpenProfile}
                        onPlaySound={onPlaySound}
                      />
                    ))}
                  </div>
                )}

                {agora.activeTab === 'following' &&
                  !agora.loadingFeed &&
                  agora.followingPubkeys.length === 0 &&
                  displayedFeedItems.length === 0 && (
                    <div className="ag-agora-onboarding">
                      <div className="ag-agora-onboarding-head">
                        <div>
                          <h3 className="ag-agora-onboarding-title">
                            Your Following feed is quiet
                          </h3>
                          <p className="ag-agora-onboarding-sub">
                            Follow voices below or explore Global to start curating your public
                            square.
                          </p>
                        </div>
                        <button
                          type="button"
                          className="ag-agora-pill-btn primary"
                          onClick={() => handleSelectTab('global')}
                        >
                          <Globe size={13} />
                          <span>Browse Global</span>
                        </button>
                      </div>

                      {agora.suggestedProfiles.length > 0 && (
                        <div className="ag-agora-onboarding-list">
                          {agora.suggestedProfiles.slice(0, 5).map((p) => (
                            <AgoraVoiceRow
                              key={p.pubkey}
                              engine={engine}
                              profile={p}
                              isSelf={p.pubkey.toLowerCase() === agora.myPubkey.toLowerCase()}
                              following={agora.isFollowing(p.pubkey)}
                              onOpenProfile={handleOpenProfile}
                              onToggleFollow={handleToggleFollow}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                {agora.loadingFeed && displayedFeedItems.length === 0 ? (
                  <div className="ag-agora-skeleton-list" role="status" aria-label="Loading posts">
                    <AgoraSkeletonCard />
                    <AgoraSkeletonCard />
                    <AgoraSkeletonCard />
                    <AgoraSkeletonCard />
                  </div>
                ) : displayedFeedItems.length > 0 ? (
                  <>
                    {displayedFeedItems.map((item, idx) => renderFeedItem(item, idx))}
                    {agora.hasMore && (
                      <div ref={loadMoreSentinelRef} className="ag-agora-load-more-wrap">
                        <button
                          type="button"
                          className="ag-agora-load-more-btn"
                          disabled={agora.loadingMore}
                          onClick={() => void agora.loadMore()}
                        >
                          {agora.loadingMore ? (
                            <Loader2 size={14} className="ag-agora-spin" />
                          ) : null}
                          <span>{agora.loadingMore ? 'Loading…' : 'Load more'}</span>
                        </button>
                      </div>
                    )}
                  </>
                ) : agora.activeTab === 'bookmarks' ? (
                  <div className="ag-agora-empty">
                    <Bookmark size={22} />
                    <p className="ag-agora-empty-title">No bookmarks yet</p>
                    <p className="ag-agora-empty-sub">
                      Tap the bookmark icon on any note to save it to your NIP-51 list.
                    </p>
                  </div>
                ) : agora.feedFilter !== 'all' || agora.activeListId ? (
                  <div className="ag-agora-empty">
                    <SlidersHorizontal size={22} />
                    <p className="ag-agora-empty-title">No posts match this filter</p>
                    <p className="ag-agora-empty-sub">
                      Try switching back to All or clearing the active list filter.
                    </p>
                    <button
                      type="button"
                      className="ag-agora-pill-btn"
                      onClick={() => {
                        agora.setFeedFilter('all')
                        agora.setActiveListId(null)
                      }}
                    >
                      Reset filters
                    </button>
                  </div>
                ) : agora.activeTab !== 'following' || agora.followingPubkeys.length > 0 ? (
                  <div className="ag-agora-empty">
                    <Globe size={22} />
                    <p className="ag-agora-empty-title">No notes loaded yet</p>
                    <p className="ag-agora-empty-sub">
                      Waiting for posts from social relays, or compose the first note above.
                    </p>
                  </div>
                ) : null}
              </>
            )}
          </div>

          {/* Floating Back-to-Top Pill */}
          {showScrollTop && (
            <button
              type="button"
              className="ag-agora-scroll-top-btn"
              onClick={() => {
                onPlaySound?.('click')
                streamRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
              }}
              aria-label="Scroll back to top"
            >
              <ArrowUp size={14} aria-hidden="true" />
              <span>Top</span>
            </button>
          )}

          {/* Thumb-Friendly Mobile Floating Compose FAB */}
          {!anySubModalOpen && !leftDrawerOpen && !rightDrawerOpen && (
            <button
              type="button"
              className="ag-agora-mobile-fab"
              onClick={() => {
                onPlaySound?.('click')
                setManualComposerModal({ kind: 'post' })
              }}
              aria-label="Compose new post"
              title="New Post"
            >
              <PenSquare size={19} aria-hidden="true" />
            </button>
          )}
        </section>

        {/* ================= RIGHT DISCOVERY RAIL (Desktop >= 1180px | Slide-Over Tray <= 867px) ================= */}
        <aside
          className={`ag-agora-right ag-agora-right-drawer${rightDrawerOpen ? ' open' : ''}${
            isSwipingRightDrawer ? ' is-swiping' : ''
          }`}
          aria-label="Discover on Agora"
        >
          <div className="ag-agora-drawer-head">
            <div className="ag-agora-drawer-head-title">
              <Compass size={16} aria-hidden="true" />
              <span>Discover</span>
            </div>
            <button
              type="button"
              className="ag-agora-icon-btn ag-agora-drawer-close"
              onClick={() => setRightDrawerOpen(false)}
              aria-label="Close Discover drawer"
            >
              <X size={17} />
            </button>
          </div>
          {searchFormEl}

          <section className="ag-agora-disc-card" aria-label="Trending topics">
            <div className="ag-agora-disc-head">
              <h3 className="ag-agora-disc-title">
                <Flame size={14} />
                <span>Trending Topics</span>
              </h3>
              {agora.hiddenTrendingTopics.length > 0 && (
                <button
                  type="button"
                  className={`ag-agora-hidden-trends-toggle${hiddenTrendsOpen ? ' active' : ''}`}
                  onClick={() => {
                    onPlaySound?.('click')
                    setHiddenTrendsOpen((v) => !v)
                  }}
                  aria-expanded={hiddenTrendsOpen}
                >
                  <EyeOff size={11} aria-hidden="true" />
                  <span className="tabular">Hidden ({agora.hiddenTrendingTopics.length})</span>
                </button>
              )}
            </div>
            {agora.trendingHashtags.length > 0 ? (
              <div className="ag-agora-tag-cloud">
                {agora.trendingHashtags.slice(0, 10).map((item) => (
                  <span
                    key={item.tag}
                    className={`ag-agora-trend-item-wrap${
                      agora.activeHashtag === item.tag ? ' active' : ''
                    }`}
                  >
                    <button
                      type="button"
                      className={`ag-agora-tag-chip${
                        agora.activeHashtag === item.tag ? ' active' : ''
                      }`}
                      onClick={() => handleSelectHashtag(item.tag)}
                    >
                      <span>#{item.tag}</span>
                      <span className="ag-agora-tag-chip-cnt tabular">{item.count}</span>
                    </button>
                    <button
                      type="button"
                      className="ag-agora-trend-hide-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        onPlaySound?.('click')
                        agora.hideTrendingTopic(item.tag)
                      }}
                      aria-label={`Hide #${item.tag} from trending`}
                      title="Hide from trending"
                    >
                      <X size={11} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="ag-agora-empty-sub" style={{ fontSize: 12 }}>
                {agora.hiddenTrendingTopics.length > 0
                  ? 'All active trending topics are currently hidden.'
                  : 'Discovering active hashtags across social relays…'}
              </p>
            )}
            {hiddenTrendsOpen && agora.hiddenTrendingTopics.length > 0 && (
              <div className="ag-agora-hidden-trends" aria-label="Hidden trending topics">
                <div className="ag-agora-hidden-trends-head">
                  <span className="ag-agora-hidden-trends-label">Tap a topic to restore</span>
                  <button
                    type="button"
                    className="ag-agora-hidden-trends-clear"
                    onClick={() => {
                      onPlaySound?.('click')
                      agora.clearHiddenTrendingTopics()
                      setHiddenTrendsOpen(false)
                    }}
                  >
                    Restore all
                  </button>
                </div>
                <div className="ag-agora-hidden-trends-list">
                  {agora.hiddenTrendingTopics.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="ag-agora-hidden-trend-chip"
                      onClick={() => {
                        onPlaySound?.('click')
                        agora.unhideTrendingTopic(tag)
                      }}
                      aria-label={`Restore #${tag} to trending`}
                      title={`Restore #${tag}`}
                    >
                      <span>#{tag}</span>
                      <RefreshCw size={10} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="ag-agora-disc-card" aria-label="Voices on Agora">
            <h3 className="ag-agora-disc-title">
              <Users size={14} />
              <span>Voices on Agora</span>
            </h3>
            {agora.suggestedProfiles.length > 0 ? (
              <div className="ag-agora-voice-list">
                {agora.suggestedProfiles.slice(0, 6).map((p) => (
                  <AgoraVoiceRow
                    key={p.pubkey}
                    engine={engine}
                    profile={p}
                    isSelf={p.pubkey.toLowerCase() === agora.myPubkey.toLowerCase()}
                    following={agora.isFollowing(p.pubkey)}
                    onOpenProfile={handleOpenProfile}
                    onToggleFollow={handleToggleFollow}
                  />
                ))}
              </div>
            ) : (
              <p className="ag-agora-empty-sub" style={{ fontSize: 12 }}>
                Active profiles appear here as posts stream in.
              </p>
            )}
          </section>
        </aside>
      </div>

      {composerModalPortal}

      {editProfileOpen && (
        <EditProfileModal
          engine={engine}
          onClose={() => setEditProfileOpen(false)}
          onPlaySound={onPlaySound}
        />
      )}

      <AgoraArticleModal
        engine={engine}
        article={agora.activeArticle}
        onClose={agora.closeArticle}
        onOpenProfile={(pk) => {
          agora.closeArticle()
          handleOpenProfile(pk)
        }}
        onOpenZap={onOpenZap}
        onSelectHashtag={(tag) => {
          agora.closeArticle()
          handleSelectHashtag(tag)
        }}
        onPlaySound={onPlaySound}
      />

      <AgoraCurationModal
        open={curationModalOpen}
        engine={engine}
        onClose={() => setCurationModalOpen(false)}
        onPlaySound={onPlaySound}
      />

      {!isMobileViewport && hoverCard && !anySubModalOpen && (
        <AgoraProfileHoverCard
          engine={engine}
          pubkey={hoverCard.pubkey}
          anchorRect={hoverCard.rect}
          onMouseEnter={handleHoverCardEnter}
          onMouseLeave={handleHoverAuthorEnd}
          onOpenProfile={(pk) => {
            dismissHoverCard()
            handleOpenProfile(pk)
          }}
          onOpenDm={(pk, nick) => {
            dismissHoverCard()
            onOpenDm(pk, nick)
          }}
          onPlaySound={onPlaySound}
        />
      )}

      {socialListModal && (
        <AgoraSocialListModal
          engine={engine}
          title={socialListModal.title}
          pubkeys={socialListModal.pubkeys}
          onOpenProfile={handleOpenProfile}
          onToggleFollow={handleToggleFollow}
          onClose={() => setSocialListModal(null)}
        />
      )}
    </div>
  )
}

export default AgoraView
