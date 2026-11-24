import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  ArrowUp,
  AtSign,
  BadgeCheck,
  Ban,
  Bell,
  Bookmark,
  Check,
  Copy,
  Flame,
  Globe,
  Hash,
  Heart,
  ImagePlus,
  Landmark,
  Link2,
  Loader2,
  Mail,
  MessageCircle,
  MoreHorizontal,
  PenLine,
  Quote,
  RefreshCw,
  Repeat2,
  Search,
  Share2,
  ShieldAlert,
  Upload,
  User,
  Users,
  X,
  Zap,
} from 'lucide-react'
import type {
  AgoraFeedItem,
  AgoraFeedTab,
  AgoraMediaItem,
  AgoraNote,
  AgoraNotification,
  AgoraProfile,
  AgoraProfileDraft,
  AgoraProfileTab,
  AgoraUploadedMedia,
} from '../types/agora.ts'
import type { AgnostrEngine } from '../types/protocol.ts'
import type { ZapTarget } from '../types/wallet.ts'
import {
  encodeNoteEventId,
  getProfileDisplayName,
  sanitizeHttpUrl,
  tokenizeAgoraContent,
} from '../lib/agoraProtocol.ts'
import { encodeNpubSafe } from '../lib/identity.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import { identiconDataUrl, shortPubkey } from '../utils/identicon.ts'
import type { SoundCue } from '../utils/sound.ts'
import type { LightboxImagePayload } from './ImageLightboxModal.tsx'
import '../styles/agora.css'

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
}> = [
  { id: 'following', label: 'Following', mobileLabel: 'Following', icon: Users },
  { id: 'global', label: 'Global', mobileLabel: 'Global', icon: Globe },
  { id: 'trending', label: 'Trending', mobileLabel: 'Trending', icon: Flame },
  { id: 'bookmarks', label: 'Bookmarks', mobileLabel: 'Saved', icon: Bookmark },
  { id: 'notifications', label: 'Notifications', mobileLabel: 'Alerts', icon: Bell },
]

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

/* --------------------------------------------------------------------------
   Safe Avatar with Identicon Fallback (Zero broken images)
   -------------------------------------------------------------------------- */
const AgoraAvatar: React.FC<{
  pubkey: string
  picture?: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  alt?: string
}> = ({ pubkey, picture, size = 'md', alt = '' }) => {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const safeSrc = useMemo(() => sanitizeHttpUrl(picture), [picture])
  const fallback = useMemo(() => identiconDataUrl(pubkey || 'anon'), [pubkey])
  const showPicture = Boolean(safeSrc) && failedSrc !== safeSrc

  return (
    <img
      src={showPicture ? safeSrc : fallback}
      alt={alt}
      className={`ag-agora-avatar ag-agora-avatar-${size}`}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => {
        if (safeSrc) setFailedSrc(safeSrc)
      }}
    />
  )
}

/* --------------------------------------------------------------------------
   Reusable Composer (Inline Quick Post, Thread Reply, Modal Post/Reply/Quote)
   -------------------------------------------------------------------------- */
interface AgoraComposerBoxProps {
  engine: AgnostrEngine
  placeholder: string
  submitLabel: string
  replyTarget?: AgoraNote
  quoteTarget?: AgoraNote
  inModal?: boolean
  autoFocus?: boolean
  onSubmitted?: () => void
  onPlaySound?: (cue: SoundCue) => void
}

const AgoraComposerBox: React.FC<AgoraComposerBoxProps> = ({
  engine,
  placeholder,
  submitLabel,
  replyTarget,
  quoteTarget,
  inModal = false,
  autoFocus = false,
  onSubmitted,
  onPlaySound,
}) => {
  const { agora } = engine
  const [draft, setDraft] = useState('')
  const [uploads, setUploads] = useState<AgoraUploadedMedia[]>([])
  const [cwEnabled, setCwEnabled] = useState(false)
  const [cwReason, setCwReason] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (autoFocus) {
      window.setTimeout(() => textareaRef.current?.focus(), 40)
    }
  }, [autoFocus])

  const resizeTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(220, Math.max(60, el.scrollHeight))}px`
  }, [])

  const handleFilesSelected = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return

    const remaining = Math.max(0, 4 - uploads.length)
    for (const file of files.slice(0, remaining)) {
      try {
        const uploaded = await agora.uploadMedia(file)
        setUploads((prev) => [...prev, uploaded].slice(0, 4))
      } catch (err) {
        engine.pushToast(
          'error',
          'Upload failed',
          err instanceof Error ? err.message : 'Unable to upload media to Blossom.'
        )
      }
    }
  }

  const handleSubmit = async () => {
    const trimmed = draft.trim()
    if ((!trimmed && uploads.length === 0) || agora.publishing || agora.uploadingMedia) return

    const opts = {
      media: uploads.length > 0 ? uploads : undefined,
      contentWarning: cwEnabled ? cwReason.trim() || 'Sensitive content' : undefined,
    }

    const res = replyTarget
      ? await agora.replyToNote(replyTarget, trimmed, opts)
      : quoteTarget
        ? await agora.quoteNote(quoteTarget, trimmed, opts)
        : await agora.publishNote(trimmed, opts)

    if (res.ok) {
      setDraft('')
      setUploads([])
      setCwEnabled(false)
      setCwReason('')
      if (textareaRef.current) {
        textareaRef.current.style.height = '60px'
      }
      onPlaySound?.('send')
      onSubmitted?.()
    } else {
      engine.pushToast('error', 'Could not publish note', res.error || 'Try again in a moment.')
    }
  }

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleSubmit()
    }
  }

  const replyAuthorName = replyTarget
    ? getProfileDisplayName(agora.getProfile(replyTarget.pubkey), replyTarget.pubkey)
    : null
  const quoteAuthorProfile = quoteTarget ? agora.getProfile(quoteTarget.pubkey) : null
  const quoteAuthorName = quoteTarget
    ? getProfileDisplayName(quoteAuthorProfile, quoteTarget.pubkey)
    : null

  const canPost =
    (draft.trim().length > 0 || uploads.length > 0) && !agora.publishing && !agora.uploadingMedia

  return (
    <div className={`ag-agora-composer${inModal ? ' in-modal' : ''}`}>
      <AgoraAvatar
        pubkey={agora.myPubkey}
        picture={agora.myProfile?.picture}
        size="md"
        alt={getProfileDisplayName(agora.myProfile, agora.myPubkey)}
      />

      <div className="ag-agora-composer-main">
        {replyAuthorName && (
          <div className="ag-agora-composer-reply-ctx">
            <span>Replying to</span>
            <strong>@{replyAuthorName}</strong>
          </div>
        )}

        <textarea
          ref={textareaRef}
          className="ag-agora-composer-textarea"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            resizeTextarea(e.currentTarget)
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={2}
          aria-label={placeholder}
        />

        {cwEnabled && (
          <div className="ag-agora-cw-row">
            <ShieldAlert size={14} aria-hidden="true" />
            <input
              type="text"
              className="ag-agora-cw-input"
              value={cwReason}
              onChange={(e) => setCwReason(e.target.value)}
              placeholder="Content warning reason (optional)…"
              maxLength={120}
              aria-label="Content warning reason"
            />
            <button
              type="button"
              className="ag-agora-filter-clear"
              onClick={() => {
                setCwEnabled(false)
                setCwReason('')
              }}
              aria-label="Remove content warning"
            >
              <X size={13} />
            </button>
          </div>
        )}

        {uploads.length > 0 && (
          <div className="ag-agora-upload-grid">
            {uploads.map((item) => (
              <div key={item.url} className="ag-agora-upload-thumb">
                {item.kind === 'video' ? (
                  <video src={item.url} muted playsInline preload="metadata" />
                ) : (
                  <img src={item.url} alt={item.alt || 'Uploaded media'} />
                )}
                <button
                  type="button"
                  className="ag-agora-upload-remove"
                  onClick={() => setUploads((prev) => prev.filter((u) => u.url !== item.url))}
                  aria-label="Remove attachment"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {quoteTarget && quoteAuthorName && (
          <div className="ag-agora-quote-card" style={{ cursor: 'default' }}>
            <div className="ag-agora-quote-head">
              <AgoraAvatar
                pubkey={quoteTarget.pubkey}
                picture={quoteAuthorProfile?.picture}
                size="xs"
              />
              <span className="ag-agora-quote-author">{quoteAuthorName}</span>
              <span className="ag-agora-dot-sep">·</span>
              <span className="ag-agora-time tabular">
                {formatRelativeSeconds(quoteTarget.createdAt)}
              </span>
            </div>
            <div className="ag-agora-quote-body">{quoteTarget.content}</div>
          </div>
        )}

        <div className="ag-agora-composer-bar">
          <div className="ag-agora-composer-tools">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => void handleFilesSelected(e)}
            />
            <button
              type="button"
              className="ag-agora-icon-btn"
              disabled={agora.uploadingMedia || uploads.length >= 4}
              onClick={() => fileInputRef.current?.click()}
              title="Upload image or video via Blossom"
              aria-label="Upload image or video"
            >
              {agora.uploadingMedia ? (
                <Loader2 size={16} className="ag-agora-spin" />
              ) : (
                <ImagePlus size={16} />
              )}
            </button>

            <button
              type="button"
              className={`ag-agora-icon-btn${cwEnabled ? ' active' : ''}`}
              onClick={() => setCwEnabled((v) => !v)}
              aria-pressed={cwEnabled}
              title="Add NIP-36 content warning"
              aria-label="Toggle content warning"
            >
              <ShieldAlert size={16} />
            </button>
          </div>

          <div className="ag-agora-composer-right">
            {draft.length > 0 && (
              <span
                className={`ag-agora-char-count tabular${draft.length > 2000 ? ' warn' : ''}`}
              >
                {draft.length.toLocaleString()}
              </span>
            )}
            <button
              type="button"
              className="ag-agora-post-btn"
              disabled={!canPost}
              onClick={() => void handleSubmit()}
            >
              {agora.publishing ? <Loader2 size={13} className="ag-agora-spin" /> : null}
              <span>{agora.publishing ? 'Posting…' : submitLabel}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------------
   Embedded Quoted Note Card
   -------------------------------------------------------------------------- */
const AgoraQuotedNoteCard: React.FC<{
  eventId: string
  engine: AgnostrEngine
  onOpenThread: (noteId: string) => void
}> = ({ eventId, engine, onOpenThread }) => {
  const { agora } = engine
  const note = agora.getNote(eventId)
  const profile = note ? agora.getProfile(note.pubkey) : null

  useEffect(() => {
    if (!note) {
      agora.ensureNotes([eventId])
    } else if (!profile) {
      agora.ensureProfiles([note.pubkey])
    }
  }, [agora, eventId, note, profile])

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
  const firstImg = note.media.find((m) => m.kind === 'image')

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
        <AgoraAvatar pubkey={note.pubkey} picture={profile?.picture} size="xs" alt={authorName} />
        <span className="ag-agora-quote-author">{authorName}</span>
        <span className="ag-agora-dot-sep">·</span>
        <span className="ag-agora-time tabular">{formatRelativeSeconds(note.createdAt)}</span>
      </div>
      {note.content && <div className="ag-agora-quote-body">{note.content}</div>}
      {firstImg && (
        <img
          src={firstImg.url}
          alt={firstImg.alt || 'Quoted media'}
          className="ag-agora-quote-thumb"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
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
  engine: AgnostrEngine
  focused?: boolean
  isAncestor?: boolean
  showThreadConnector?: boolean
  revealedCw: boolean
  onRevealCw: (noteId: string) => void
  onOpenThread: (noteId: string) => void
  onOpenProfile: (pubkey: string) => void
  onSelectHashtag: (tag: string) => void
  onReplyClick: (note: AgoraNote) => void
  onQuoteClick: (note: AgoraNote) => void
  onOpenDm: (pubkey: string, nickname?: string) => void
  onOpenAmailCompose?: (pubkey: string, nickname?: string) => void
  onOpenZap?: (target: ZapTarget) => void
  onOpenLightbox?: (payload: LightboxImagePayload) => void
  onPlaySound?: (cue: SoundCue) => void
}

const AgoraNoteCard: React.FC<AgoraNoteCardProps> = ({
  note,
  repostedBy,
  engine,
  focused = false,
  isAncestor = false,
  showThreadConnector = false,
  revealedCw,
  onRevealCw,
  onOpenThread,
  onOpenProfile,
  onSelectHashtag,
  onReplyClick,
  onQuoteClick,
  onOpenDm,
  onOpenAmailCompose,
  onOpenZap,
  onOpenLightbox,
  onPlaySound,
}) => {
  const { agora } = engine
  const [menuOpen, setMenuOpen] = useState(false)
  const [repostMenuOpen, setRepostMenuOpen] = useState(false)
  const menuWrapRef = useRef<HTMLDivElement | null>(null)
  const repostWrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen && !repostMenuOpen) return
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
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        setRepostMenuOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen, repostMenuOpen])

  const authorProfile = agora.getProfile(note.pubkey)
  const authorName = getProfileDisplayName(authorProfile, note.pubkey)
  const nip05 = formatNip05Display(authorProfile?.nip05)
  const reposterProfile = repostedBy ? agora.getProfile(repostedBy) : null
  const reposterName = repostedBy ? getProfileDisplayName(reposterProfile, repostedBy) : null

  const stats = agora.getNoteStats(note.id)
  const isSelf = note.pubkey.toLowerCase() === agora.myPubkey.toLowerCase()
  const following = agora.isFollowing(note.pubkey)
  const bookmarked = agora.isBookmarked(note.id)

  const tokens = useMemo(
    () => tokenizeAgoraContent(note.content, note.media),
    [note.content, note.media]
  )

  const embeddedQuoteIds = useMemo(() => {
    const ids = new Set<string>()
    for (const tok of tokens) {
      if (tok.type === 'quote') ids.add(tok.eventId)
    }
    for (const qid of note.quoteIds) {
      ids.add(qid)
    }
    return Array.from(ids).slice(0, 2)
  }, [note.quoteIds, tokens])

  const mediaSlice = useMemo(() => note.media.slice(0, 4), [note.media])
  const needsCwGate = Boolean(note.contentWarning) && !revealedCw

  const handleCopyNevent = async () => {
    const nevent = encodeNoteEventId(note.id, note.pubkey, agora.socialRelays)
    const ok = await copyTextSafe(`nostr:${nevent}`)
    if (ok) {
      onPlaySound?.('click')
      engine.pushToast('success', 'Note link copied', `nostr:${nevent.slice(0, 20)}…`)
    }
  }

  const handleOpenMediaLightbox = (item: AgoraMediaItem) => {
    if (!onOpenLightbox || item.kind !== 'image') return
    const { width, height } = parseDimTuple(item.dim)
    onOpenLightbox({
      blobUrl: item.url,
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
      caption: item.alt || undefined,
    })
  }

  const handleZap = () => {
    onPlaySound?.('click')
    onOpenZap?.({
      pubkey: note.pubkey,
      nickname: authorName,
      lud16: authorProfile?.lud16 ?? null,
      eventId: note.id,
      channelLabel: 'Agora',
    })
  }

  const cardClasses = [
    'ag-agora-card',
    !focused ? 'is-clickable' : 'is-focused',
    isAncestor ? 'is-ancestor' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <article
      className={cardClasses}
      onClick={() => {
        if (!focused) onOpenThread(note.id)
      }}
    >
      {repostedBy && reposterName && (
        <div className="ag-agora-repost-bar">
          <Repeat2 size={13} aria-hidden="true" />
          <span>Reposted by</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onOpenProfile(repostedBy)
            }}
          >
            {reposterName}
          </button>
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
            aria-label={`View ${authorName}'s profile`}
          >
            <AgoraAvatar
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
              >
                {authorName}
              </button>
              {nip05 && (
                <span className="ag-agora-nip05" title={nip05}>
                  <BadgeCheck size={12} aria-hidden="true" />
                  <span className="truncate">{nip05}</span>
                </span>
              )}
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
                      void handleCopyNevent()
                    }}
                  >
                    <Copy size={14} />
                    <span>Copy nevent1</span>
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
              {tokens.some((t) => t.type !== 'quote') && (
                <div className="ag-agora-body">
                  {tokens.map((tok, idx) => {
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
                      return (
                        <a
                          key={idx}
                          href={tok.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ag-agora-ext-link"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {tok.display}
                        </a>
                      )
                    }
                    return null
                  })}
                </div>
              )}

              {mediaSlice.length > 0 && (
                <div
                  className={`ag-agora-media-grid count-${mediaSlice.length}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {mediaSlice.map((item) =>
                    item.kind === 'video' ? (
                      <video
                        key={item.url}
                        src={item.url}
                        controls
                        playsInline
                        preload="metadata"
                        className="ag-agora-media-video"
                      />
                    ) : (
                      <button
                        key={item.url}
                        type="button"
                        className="ag-agora-media-cell"
                        onClick={() => handleOpenMediaLightbox(item)}
                        aria-label={item.alt || 'Open image preview'}
                      >
                        <img
                          src={item.url}
                          alt={item.alt || 'Attached image'}
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      </button>
                    )
                  )}
                </div>
              )}

              {embeddedQuoteIds.map((qid) => (
                <AgoraQuotedNoteCard
                  key={qid}
                  eventId={qid}
                  engine={engine}
                  onOpenThread={onOpenThread}
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

            <button
              type="button"
              className={`ag-agora-act-btn zap${stats.zappedByMe ? ' is-zapped' : ''}`}
              onClick={handleZap}
              aria-label="Zap"
              title={stats.zapSats > 0 ? `${stats.zapSats.toLocaleString()} sats zapped` : 'Zap'}
            >
              <Zap size={15} fill={stats.zappedByMe ? 'currentColor' : 'none'} />
              {stats.zapSats > 0 && (
                <span className="tabular">{formatCompactCount(stats.zapSats)}</span>
              )}
            </button>

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
              onClick={() => void handleCopyNevent()}
              aria-label="Share note link"
              title="Copy nostr:nevent1 link"
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

  const avatarFileRef = useRef<HTMLInputElement | null>(null)
  const bannerFileRef = useRef<HTMLInputElement | null>(null)

  useBackHandler(true, onClose)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
        displayName: displayName.trim() || undefined,
        name: name.trim() || undefined,
        about: about.trim() || undefined,
        picture: picture.trim() || undefined,
        banner: banner.trim() || undefined,
        nip05: nip05.trim() || undefined,
        lud16: lud16.trim() || undefined,
        website: website.trim() || undefined,
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <AgoraAvatar
              pubkey={agora.myPubkey}
              picture={picture}
              size="md"
              alt="Avatar preview"
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                {displayName.trim() || name.trim() || getProfileDisplayName(current, agora.myPubkey)}
              </span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {shortPubkey(encodeNpubSafe(agora.myPubkey), 10, 6)}
              </span>
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
            <label className="ag-agora-label" htmlFor="ag-agora-prof-picture">
              Avatar URL
            </label>
            <div className="ag-agora-input-with-btn">
              <input
                id="ag-agora-prof-picture"
                type="url"
                className="ag-agora-input"
                value={picture}
                onChange={(e) => setPicture(e.target.value)}
                placeholder="https://…"
              />
              <input
                ref={avatarFileRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => void handlePhotoUpload('picture', e)}
              />
              <button
                type="button"
                className="ag-agora-pill-btn"
                disabled={uploadingField !== null}
                onClick={() => avatarFileRef.current?.click()}
              >
                {uploadingField === 'picture' ? (
                  <Loader2 size={13} className="ag-agora-spin" />
                ) : (
                  <Upload size={13} />
                )}
                <span>Upload</span>
              </button>
            </div>
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
  profile: AgoraProfile
  isSelf: boolean
  following: boolean
  onOpenProfile: (pubkey: string) => void
  onToggleFollow: (pubkey: string) => void
}> = ({ profile, isSelf, following, onOpenProfile, onToggleFollow }) => {
  const name = getProfileDisplayName(profile, profile.pubkey)
  const bio = profile.about?.trim() || formatNip05Display(profile.nip05) || shortPubkey(profile.npub, 8, 4)

  return (
    <div className="ag-agora-voice-row">
      <button
        type="button"
        className="ag-agora-voice-main"
        onClick={() => onOpenProfile(profile.pubkey)}
      >
        <AgoraAvatar pubkey={profile.pubkey} picture={profile.picture} size="sm" alt={name} />
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
  const { agora } = engine
  const streamRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const [manualComposerModal, setManualComposerModal] = useState<ComposerModalState | null>(null)
  const [editProfileOpen, setEditProfileOpen] = useState(false)
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [searchDraft, setSearchDraft] = useState(agora.searchQuery)
  const [revealedCwIds, setRevealedCwIds] = useState<Set<string>>(() => new Set())
  const [copiedNpub, setCopiedNpub] = useState(false)
  const [failedBannerUrl, setFailedBannerUrl] = useState<string | null>(null)

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

  useBackHandler(Boolean(activeComposerModal), closeComposerModal)
  useBackHandler(!activeComposerModal && !editProfileOpen && Boolean(agora.thread), agora.closeThread)
  useBackHandler(
    !activeComposerModal && !editProfileOpen && !agora.thread && Boolean(agora.profileView),
    agora.closeProfile
  )

  useEffect(() => {
    if (!activeComposerModal) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeComposerModal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeComposerModal, closeComposerModal])

  const handleSelectTab = useCallback(
    (tab: AgoraFeedTab) => {
      onPlaySound?.('click')
      if (agora.thread) agora.closeThread()
      if (agora.profileView) agora.closeProfile()
      if (agora.searchQuery || agora.activeHashtag) agora.clearSearch()
      agora.setActiveTab(tab)
      if (tab === 'notifications') {
        agora.markNotificationsRead()
      }
      streamRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    },
    [agora, onPlaySound]
  )

  const handleOpenProfile = useCallback(
    (pubkey: string) => {
      onPlaySound?.('click')
      if (agora.thread) agora.closeThread()
      agora.openProfile(pubkey)
      streamRef.current?.scrollTo({ top: 0 })
    },
    [agora, onPlaySound]
  )

  const handleOpenThread = useCallback(
    (noteId: string) => {
      onPlaySound?.('click')
      agora.openThread(noteId)
      streamRef.current?.scrollTo({ top: 0 })
    },
    [agora, onPlaySound]
  )

  const handleSelectHashtag = useCallback(
    (tag: string) => {
      onPlaySound?.('click')
      if (agora.thread) agora.closeThread()
      if (agora.profileView) agora.closeProfile()
      setSearchDraft(`#${tag}`)
      setMobileSearchOpen(false)
      agora.selectHashtag(tag)
      streamRef.current?.scrollTo({ top: 0 })
    },
    [agora, onPlaySound]
  )

  const handleSearchSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      const q = searchDraft.trim()
      if (!q) {
        agora.clearSearch()
        return
      }
      onPlaySound?.('click')
      if (agora.thread) agora.closeThread()
      if (agora.profileView) agora.closeProfile()
      void agora.runSearch(q)
      if (isMobileViewport) setMobileSearchOpen(false)
      streamRef.current?.scrollTo({ top: 0 })
    },
    [agora, isMobileViewport, onPlaySound, searchDraft]
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

  const handleToggleFollow = useCallback(
    (pubkey: string) => {
      onPlaySound?.('click')
      void agora.toggleFollow(pubkey)
    },
    [agora, onPlaySound]
  )

  const myDisplayName = getProfileDisplayName(agora.myProfile, agora.myPubkey)
  const myNpub = useMemo(() => encodeNpubSafe(agora.myPubkey), [agora.myPubkey])

  const inThread = agora.thread !== null
  const inProfile = !inThread && agora.profileView !== null
  const inSearch = !inThread && !inProfile && Boolean(agora.searchQuery || agora.activeHashtag)
  const inNotifications = !inThread && !inProfile && !inSearch && agora.activeTab === 'notifications'
  const showInlineComposer =
    !inThread &&
    !inProfile &&
    !inSearch &&
    (agora.activeTab === 'following' ||
      agora.activeTab === 'global' ||
      agora.activeTab === 'trending')

  const isMyProfileOpen =
    inProfile && agora.profileView?.pubkey.toLowerCase() === agora.myPubkey.toLowerCase()

  const activeTabTitle = useMemo(() => {
    switch (agora.activeTab) {
      case 'following':
        return 'Following'
      case 'global':
        return 'Global'
      case 'trending':
        return 'Trending'
      case 'bookmarks':
        return 'Bookmarks'
      case 'notifications':
        return 'Notifications'
    }
  }, [agora.activeTab])

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
  const showProfileBannerImg = Boolean(profileTargetBanner) && failedBannerUrl !== profileTargetBanner

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

  const renderNoteCard = (
    note: AgoraNote,
    opts?: {
      repostedBy?: string
      focused?: boolean
      isAncestor?: boolean
      showThreadConnector?: boolean
    }
  ) => (
    <AgoraNoteCard
      key={opts?.repostedBy ? `repost:${opts.repostedBy}:${note.id}` : note.id}
      note={note}
      repostedBy={opts?.repostedBy}
      engine={engine}
      focused={opts?.focused}
      isAncestor={opts?.isAncestor}
      showThreadConnector={opts?.showThreadConnector}
      revealedCw={revealedCwIds.has(note.id)}
      onRevealCw={handleRevealCw}
      onOpenThread={handleOpenThread}
      onOpenProfile={handleOpenProfile}
      onSelectHashtag={handleSelectHashtag}
      onReplyClick={(target) => setManualComposerModal({ kind: 'reply', targetNote: target })}
      onQuoteClick={(target) => setManualComposerModal({ kind: 'quote', targetNote: target })}
      onOpenDm={onOpenDm}
      onOpenAmailCompose={onOpenAmailCompose}
      onOpenZap={onOpenZap}
      onOpenLightbox={onOpenLightbox}
      onPlaySound={onPlaySound}
    />
  )

  const renderFeedItem = (item: AgoraFeedItem) => (
    <AgoraNoteCard
      key={item.key}
      note={item.note}
      repostedBy={item.kind === 'repost' ? item.repostedBy : undefined}
      engine={engine}
      revealedCw={revealedCwIds.has(item.note.id)}
      onRevealCw={handleRevealCw}
      onOpenThread={handleOpenThread}
      onOpenProfile={handleOpenProfile}
      onSelectHashtag={handleSelectHashtag}
      onReplyClick={(target) => setManualComposerModal({ kind: 'reply', targetNote: target })}
      onQuoteClick={(target) => setManualComposerModal({ kind: 'quote', targetNote: target })}
      onOpenDm={onOpenDm}
      onOpenAmailCompose={onOpenAmailCompose}
      onOpenZap={onOpenZap}
      onOpenLightbox={onOpenLightbox}
      onPlaySound={onPlaySound}
    />
  )

  const renderNotificationRow = (notif: AgoraNotification) => {
    const actorProfile = agora.getProfile(notif.actorPubkey)
    const actorName = getProfileDisplayName(actorProfile, notif.actorPubkey)
    const targetNote = notif.targetNoteId ? agora.getNote(notif.targetNoteId) : null
    const snippet = notif.content?.trim() || targetNote?.content?.trim() || ''

    const actionText =
      notif.kind === 'reply'
        ? 'replied to your note'
        : notif.kind === 'mention'
          ? 'mentioned you'
          : notif.kind === 'like'
            ? 'liked your note'
            : notif.kind === 'repost'
              ? 'reposted your note'
              : 'zapped your note'

    const Icon =
      notif.kind === 'reply'
        ? MessageCircle
        : notif.kind === 'mention'
          ? AtSign
          : notif.kind === 'like'
            ? Heart
            : notif.kind === 'repost'
              ? Repeat2
              : Zap

    return (
      <button
        key={notif.id}
        type="button"
        className="ag-agora-notif-row"
        onClick={() => {
          const destNoteId = notif.targetNoteId || notif.noteId
          if (destNoteId) handleOpenThread(destNoteId)
          else handleOpenProfile(notif.actorPubkey)
        }}
      >
        <span className={`ag-agora-notif-icon ${notif.kind}`} aria-hidden="true">
          <Icon size={14} />
        </span>

        <AgoraAvatar
          pubkey={notif.actorPubkey}
          picture={actorProfile?.picture}
          size="sm"
          alt={actorName}
        />

        <div className="ag-agora-notif-body">
          <div className="ag-agora-notif-top">
            <strong>{actorName}</strong>
            <span>{actionText}</span>
            {notif.kind === 'zap' && notif.zapSats && notif.zapSats > 0 && (
              <span className="ag-agora-notif-sats tabular">
                +{notif.zapSats.toLocaleString()} sats
              </span>
            )}
            <span className="ag-agora-dot-sep">·</span>
            <span className="ag-agora-time tabular">
              {formatRelativeSeconds(notif.createdAt)}
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
                <AgoraComposerBox
                  engine={engine}
                  inModal
                  autoFocus
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

  return (
    <div className="ag-agora-workspace" aria-label="Agora social feed" data-no-swipe="true">
      <div className="ag-agora-shell">
        {/* ================= LEFT AGORA SIDEBAR (Desktop >= 868px) ================= */}
        <aside className="ag-agora-left" aria-label="Agora navigation">
          <div className="ag-agora-brand">
            <span className="ag-agora-brand-icon" aria-hidden="true">
              <Landmark size={17} />
            </span>
            <div className="ag-agora-brand-copy">
              <span className="ag-agora-brand-title">Agora</span>
              <span className="ag-agora-brand-sub">Nostr public square</span>
            </div>
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
          {/* Mobile Horizontal Tab Strip (<= 867px) */}
          <nav className="ag-agora-mobile-tabs" aria-label="Agora tabs">
            {FEED_NAV_ITEMS.map((item) => {
              const Icon = item.icon
              const isActive =
                !inThread && !inProfile && !inSearch && agora.activeTab === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`ag-agora-mobile-tab${isActive ? ' active' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => handleSelectTab(item.id)}
                >
                  <Icon size={13} />
                  <span>{item.mobileLabel}</span>
                  {item.id === 'notifications' && agora.unreadNotificationCount > 0 && (
                    <span className="ag-agora-mobile-tab-badge tabular">
                      {agora.unreadNotificationCount > 99 ? '99+' : agora.unreadNotificationCount}
                    </span>
                  )}
                </button>
              )
            })}
            <button
              type="button"
              className={`ag-agora-mobile-tab${isMyProfileOpen ? ' active' : ''}`}
              aria-current={isMyProfileOpen ? 'page' : undefined}
              onClick={() => handleOpenProfile(agora.myPubkey)}
            >
              <User size={13} />
              <span>Profile</span>
            </button>
          </nav>

          {/* Sticky Center Header */}
          <header className="ag-agora-header">
            <div className="ag-agora-header-left">
              {inThread ? (
                <>
                  <button
                    type="button"
                    className="ag-agora-icon-btn"
                    onClick={agora.closeThread}
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
                    onClick={agora.closeProfile}
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
              ) : agora.activeHashtag ? (
                <>
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
                </>
              ) : agora.searchQuery ? (
                <>
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
                </>
              ) : (
                <div className="ag-agora-header-titles">
                  <span className="ag-agora-header-title">Agora · {activeTabTitle}</span>
                </div>
              )}
            </div>

            <div className="ag-agora-header-actions">
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
                  setManualComposerModal({ kind: 'post' })
                }}
                aria-label="New Post"
                title="New Post"
              >
                <PenLine size={16} />
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

          {/* Collapsible Mobile / Tablet Search & Trending Drawer */}
          {mobileSearchOpen && (
            <div className="ag-agora-inline-search-drawer">
              {searchFormEl}
              {agora.trendingHashtags.length > 0 && (
                <div className="ag-agora-tag-cloud">
                  {agora.trendingHashtags.slice(0, 8).map((item) => (
                    <button
                      key={item.tag}
                      type="button"
                      className={`ag-agora-tag-chip${agora.activeHashtag === item.tag ? ' active' : ''}`}
                      onClick={() => handleSelectHashtag(item.tag)}
                    >
                      <span>#{item.tag}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Main Scrollable Stream Body */}
          <div className="ag-agora-stream" ref={streamRef}>
            {/* ===== VIEW A: FULL THREAD VIEW ===== */}
            {inThread && agora.thread && (
              <>
                {agora.thread.ancestors.map((anc) =>
                  renderNoteCard(anc, { isAncestor: true, showThreadConnector: true })
                )}

                {agora.thread.focusedNote ? (
                  <>
                    {renderNoteCard(agora.thread.focusedNote, { focused: true })}
                    <AgoraComposerBox
                      engine={engine}
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

                {agora.thread.replies.length > 0 ? (
                  agora.thread.replies.map((reply) => renderNoteCard(reply))
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
                  {showProfileBannerImg && (
                    <img
                      src={profileTargetBanner}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={() => {
                        if (profileTargetBanner) setFailedBannerUrl(profileTargetBanner)
                      }}
                    />
                  )}
                </div>

                <div className="ag-agora-profile-body">
                  <div className="ag-agora-profile-top-row">
                    <AgoraAvatar
                      pubkey={agora.profileView.pubkey}
                      picture={profileTarget?.picture}
                      size="lg"
                      alt={profileTargetName}
                    />

                    <div className="ag-agora-profile-actions">
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
                    <h2 className="ag-agora-profile-name">{profileTargetName}</h2>
                    <div className="ag-agora-profile-handles">
                      {formatNip05Display(profileTarget?.nip05) && (
                        <span className="ag-agora-nip05" style={{ maxWidth: 'none' }}>
                          <BadgeCheck size={13} aria-hidden="true" />
                          <span>{formatNip05Display(profileTarget?.nip05)}</span>
                        </span>
                      )}
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
                    {profileTargetWebsite && (
                      <a
                        href={profileTargetWebsite}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ag-agora-profile-meta-item ag-agora-ext-link"
                      >
                        <Link2 size={13} />
                        <span className="truncate">
                          {profileTargetWebsite.replace(/^https?:\/\//i, '').replace(/\/+$/, '')}
                        </span>
                      </a>
                    )}
                    {profileTarget?.lud16 && (
                      <span className="ag-agora-profile-meta-item">
                        <Zap size={13} />
                        <span className="truncate">{profileTarget.lud16}</span>
                      </span>
                    )}
                    <span className="ag-agora-profile-meta-item tabular">
                      <strong>{agora.profileView.followingPubkeys.length.toLocaleString()}</strong>
                      <span>Following</span>
                    </span>
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
                  <div className="ag-agora-empty">
                    <Loader2 size={22} className="ag-agora-spin" />
                    <p className="ag-agora-empty-sub">Loading profile notes…</p>
                  </div>
                ) : profileDisplayedNotes.length > 0 ? (
                  profileDisplayedNotes.map((n) => renderNoteCard(n))
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
                  <div className="ag-agora-empty">
                    <Loader2 size={22} className="ag-agora-spin" />
                    <p className="ag-agora-empty-sub">Searching Nostr relays…</p>
                  </div>
                ) : agora.searchResults.length > 0 ? (
                  agora.searchResults.map((n) => renderNoteCard(n))
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

            {/* ===== VIEW D: NOTIFICATIONS ===== */}
            {inNotifications &&
              (agora.notifications.length > 0 ? (
                agora.notifications.map(renderNotificationRow)
              ) : (
                <div className="ag-agora-empty">
                  <Bell size={22} />
                  <p className="ag-agora-empty-title">All caught up</p>
                  <p className="ag-agora-empty-sub">
                    Replies, mentions, likes, reposts, and zaps on your notes appear here.
                  </p>
                </div>
              ))}

            {/* ===== VIEW E: STANDARD FEED (Following / Global / Trending / Bookmarks) ===== */}
            {!inThread && !inProfile && !inSearch && !inNotifications && (
              <>
                {showInlineComposer && (
                  <AgoraComposerBox
                    engine={engine}
                    placeholder="What's happening on Nostr?"
                    submitLabel="Post"
                    onPlaySound={onPlaySound}
                  />
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

                {agora.activeTab === 'following' &&
                  !agora.loadingFeed &&
                  agora.followingPubkeys.length === 0 &&
                  agora.feedItems.length === 0 && (
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

                {agora.loadingFeed && agora.feedItems.length === 0 ? (
                  <div className="ag-agora-empty">
                    <Loader2 size={22} className="ag-agora-spin" />
                    <p className="ag-agora-empty-sub">Connecting to Agora Nostr relays…</p>
                  </div>
                ) : agora.feedItems.length > 0 ? (
                  <>
                    {agora.feedItems.map(renderFeedItem)}
                    {agora.hasMore && (
                      <div className="ag-agora-load-more-wrap">
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
        </section>

        {/* ================= RIGHT DISCOVERY RAIL (Desktop >= 1180px) ================= */}
        <aside className="ag-agora-right" aria-label="Discover on Agora">
          {searchFormEl}

          <section className="ag-agora-disc-card" aria-label="Trending topics">
            <h3 className="ag-agora-disc-title">
              <Flame size={14} />
              <span>Trending Topics</span>
            </h3>
            {agora.trendingHashtags.length > 0 ? (
              <div className="ag-agora-tag-cloud">
                {agora.trendingHashtags.slice(0, 10).map((item) => (
                  <button
                    key={item.tag}
                    type="button"
                    className={`ag-agora-tag-chip${agora.activeHashtag === item.tag ? ' active' : ''}`}
                    onClick={() => handleSelectHashtag(item.tag)}
                  >
                    <span>#{item.tag}</span>
                    <span className="ag-agora-tag-chip-cnt tabular">{item.count}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="ag-agora-empty-sub" style={{ fontSize: 12 }}>
                Discovering active hashtags across social relays…
              </p>
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
    </div>
  )
}

export default AgoraView
