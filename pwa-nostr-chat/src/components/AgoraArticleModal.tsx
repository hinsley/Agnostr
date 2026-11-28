import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  BadgeCheck,
  BookOpen,
  Check,
  Clock,
  Link2,
  Loader2,
  UserPlus,
  X,
  Zap,
} from 'lucide-react'
import type { AgoraArticle, AgoraContentBlock } from '../types/agora.ts'
import type { AgnostrEngine } from '../types/protocol.ts'
import type { ZapTarget } from '../types/wallet.ts'
import { estimateReadingTimeMin, parseRichContentBlocks } from '../lib/agoraExtras.ts'
import { getProfileDisplayName, sanitizeHttpUrl } from '../lib/agoraProtocol.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import { identiconDataUrl } from '../utils/identicon.ts'
import type { SoundCue } from '../utils/sound.ts'
import { requestUntrustedLinkOpen } from './UntrustedLinkModal.tsx'

export interface AgoraArticleCardProps {
  engine: AgnostrEngine
  article: AgoraArticle
  onOpen: (article: AgoraArticle) => void
  onOpenProfile?: (pubkey: string) => void
  onSelectHashtag?: (tag: string) => void
}

export interface AgoraArticleModalProps {
  engine: AgnostrEngine
  article: AgoraArticle | null
  onClose: () => void
  onOpenProfile?: (pubkey: string) => void
  onOpenZap?: (target: ZapTarget) => void
  onSelectHashtag?: (tag: string) => void
  onPlaySound?: (cue: SoundCue) => void
}

function formatPublishedDate(tsSec: number): string {
  if (!Number.isFinite(tsSec) || tsSec <= 0) return ''
  try {
    return new Date(tsSec * 1000).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return ''
  }
}

function deriveSummarySnippet(article: AgoraArticle): string {
  const cleanSummary = article.summary?.trim()
  if (cleanSummary) return cleanSummary
  const plain = article.content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > 200 ? `${plain.slice(0, 197)}…` : plain
}

function useScreenedSafeUrl(
  engine: AgnostrEngine,
  url: string | undefined,
  senderPubkey: string
): string | null {
  const { contentFilter } = engine
  const requestedRef = useRef<string | null>(null)
  const safeHttpsUrl = useMemo(() => {
    const clean = sanitizeHttpUrl(url)
    return clean && clean.startsWith('https://') ? clean : null
  }, [url])
  const cacheKey = safeHttpsUrl
    ? `agora-img:${(senderPubkey || 'anon').trim().toLowerCase()}:${safeHttpsUrl}`
    : ''
  const verdict = cacheKey ? contentFilter.getVerdict(cacheKey) : null
  const safeBlobUrl =
    cacheKey && verdict?.status === 'safe' ? contentFilter.getSafeImageObjectUrl(cacheKey) : null

  useEffect(() => {
    if (!safeHttpsUrl || !cacheKey) return
    const needsScreen = !verdict || verdict.status === 'idle'
    const needsRehydrate = verdict?.status === 'safe' && !safeBlobUrl
    if (!needsScreen && !needsRehydrate) return
    if (requestedRef.current === cacheKey) return
    requestedRef.current = cacheKey
    void contentFilter.screenExternalImageUrl(cacheKey, safeHttpsUrl, senderPubkey)
  }, [safeHttpsUrl, cacheKey, verdict, safeBlobUrl, contentFilter, senderPubkey])

  return verdict?.status === 'safe' && safeBlobUrl ? safeBlobUrl : null
}

function renderInlineSafeText(
  text: string,
  senderPubkey: string,
  senderName: string,
  isTrusted: boolean
): React.ReactNode[] {
  const urlRe = /(https:\/\/[^\s<>()[\]"']+)/gi
  const segments = text.split(urlRe)
  return segments.map((seg, i) => {
    if (/^https:\/\//i.test(seg)) {
      const cleanUrl = sanitizeHttpUrl(seg)
      if (cleanUrl) {
        return (
          <a
            key={i}
            href={cleanUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ag-agora-link"
            onClick={(e) => {
              if (!isTrusted) {
                e.preventDefault()
                requestUntrustedLinkOpen({
                  url: cleanUrl,
                  senderHandle: senderName,
                  senderPubkey,
                })
              }
            }}
          >
            {cleanUrl.replace(/^https:\/\//i, '').slice(0, 56)}
          </a>
        )
      }
    }
    return <React.Fragment key={i}>{seg}</React.Fragment>
  })
}

export const AgoraArticleCard: React.FC<AgoraArticleCardProps> = ({
  engine,
  article,
  onOpen,
  onOpenProfile,
  onSelectHashtag,
}) => {
  const { agora } = engine
  const pk = article.pubkey.trim().toLowerCase()
  const profile = agora.getProfile(pk)
  const displayName = getProfileDisplayName(profile, pk)
  const nip05Status = agora.nip05StatusByPubkey[pk] ?? 'unverified'

  useEffect(() => {
    if (pk) agora.ensureProfiles([pk])
  }, [agora, pk])

  useEffect(() => {
    if (pk && profile?.nip05) {
      agora.ensureNip05Verified(pk, profile.nip05)
    }
  }, [agora, pk, profile?.nip05])

  const avatarBlobUrl = useScreenedSafeUrl(engine, profile?.picture, pk)
  const coverBlobUrl = useScreenedSafeUrl(engine, article.image, pk)
  const identicon = useMemo(() => identiconDataUrl(pk || 'anon'), [pk])
  const readMin = useMemo(() => estimateReadingTimeMin(article.content), [article.content])
  const snippet = useMemo(() => deriveSummarySnippet(article), [article])
  const pubDate = formatPublishedDate(article.publishedAt || article.createdAt)

  return (
    <article
      className="ag-agora-article-card"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(article)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(article)
        }
      }}
      aria-label={`Read article: ${article.title}`}
    >
      {coverBlobUrl && (
        <div className="ag-agora-article-card-cover">
          <img src={coverBlobUrl} alt={article.title} loading="lazy" />
        </div>
      )}

      <div className="ag-agora-article-card-body">
        <div className="ag-agora-article-author-row">
          <button
            type="button"
            className="ag-agora-article-author-btn"
            onClick={(e) => {
              e.stopPropagation()
              onOpenProfile?.(pk)
            }}
          >
            <img
              src={avatarBlobUrl || identicon}
              alt={displayName}
              className="ag-agora-avatar ag-agora-avatar-xs"
              loading="lazy"
            />
            <span className="ag-agora-article-author-name truncate">{displayName}</span>
            {profile?.nip05 && nip05Status === 'verified' && (
              <BadgeCheck size={12} className="ag-agora-nip05-icon" aria-hidden="true" />
            )}
          </button>
          {pubDate && (
            <>
              <span className="ag-agora-dot-sep">·</span>
              <span className="ag-agora-time">{pubDate}</span>
            </>
          )}
          <span className="ag-agora-dot-sep">·</span>
          <span className="ag-agora-article-readtime">
            <Clock size={11} aria-hidden="true" />
            <span>~{readMin} min read</span>
          </span>
        </div>

        <h3 className="ag-agora-article-card-title">{article.title}</h3>
        {snippet && <p className="ag-agora-article-card-summary">{snippet}</p>}

        {article.hashtags.length > 0 && (
          <div className="ag-agora-article-tags">
            {article.hashtags.slice(0, 4).map((tag) => (
              <button
                key={tag}
                type="button"
                className="ag-agora-article-tag"
                onClick={(e) => {
                  e.stopPropagation()
                  onSelectHashtag?.(tag)
                }}
              >
                #{tag}
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

export const AgoraArticleModal: React.FC<AgoraArticleModalProps> = ({
  engine,
  article,
  onClose,
  onOpenProfile,
  onOpenZap,
  onSelectHashtag,
  onPlaySound,
}) => {
  const { agora } = engine
  const [followBusy, setFollowBusy] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)

  useBackHandler(Boolean(article), onClose)

  useEffect(() => {
    if (!article) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [article, onClose])

  const pk = article ? article.pubkey.trim().toLowerCase() : ''
  const profile = pk ? agora.getProfile(pk) : null

  useEffect(() => {
    if (pk) agora.ensureProfiles([pk])
  }, [agora, pk])

  useEffect(() => {
    if (pk && profile?.nip05) {
      agora.ensureNip05Verified(pk, profile.nip05)
    }
  }, [agora, pk, profile?.nip05])

  const avatarBlobUrl = useScreenedSafeUrl(engine, profile?.picture, pk)
  const coverBlobUrl = useScreenedSafeUrl(engine, article?.image, pk)
  const identicon = useMemo(() => identiconDataUrl(pk || 'anon'), [pk])
  const blocks = useMemo<AgoraContentBlock[]>(
    () => (article ? parseRichContentBlocks(article.content) : []),
    [article]
  )
  const readMin = useMemo(
    () => (article ? estimateReadingTimeMin(article.content) : 1),
    [article]
  )

  if (!article || typeof document === 'undefined') return null

  const displayName = getProfileDisplayName(profile, pk)
  const nip05Status = agora.nip05StatusByPubkey[pk] ?? 'unverified'
  const isSelf = pk === agora.myPubkey.toLowerCase()
  const isFollowing = !isSelf && agora.isFollowing(pk)
  const isTrusted = isSelf || engine.isTrusted(pk)
  const pubDate = formatPublishedDate(article.publishedAt || article.createdAt)

  const handleToggleFollow = async () => {
    if (followBusy || isSelf) return
    setFollowBusy(true)
    try {
      await agora.toggleFollow(pk)
      onPlaySound?.('click')
    } finally {
      setFollowBusy(false)
    }
  }

  const handleCopyLink = async () => {
    const shareText = article.naddr ? `nostr:${article.naddr}` : article.title
    try {
      await navigator.clipboard.writeText(shareText)
      setCopiedLink(true)
      engine.pushToast('success', 'Article link copied', shareText.slice(0, 64))
      window.setTimeout(() => setCopiedLink(false), 1800)
    } catch {
      engine.pushToast('error', 'Copy failed', 'Clipboard access is unavailable.')
    }
  }

  const handleZap = () => {
    if (!onOpenZap) return
    onPlaySound?.('click')
    onOpenZap({
      pubkey: pk,
      nickname: displayName,
      lud16: profile?.lud16 ?? null,
      eventId: article.id,
      channelLabel: 'Agora Article',
    })
  }

  return createPortal(
    <div
      className="ag-agora-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={article.title}
      onClick={onClose}
    >
      <div
        className="ag-agora-article-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ag-agora-article-modal-bar">
          <div className="ag-agora-article-modal-kicker">
            <BookOpen size={14} aria-hidden="true" />
            <span>Article</span>
            <span className="ag-agora-dot-sep">·</span>
            <span>~{readMin} min read</span>
          </div>

          <div className="ag-agora-article-modal-actions">
            <button
              type="button"
              className="ag-agora-icon-btn"
              onClick={() => void handleCopyLink()}
              title="Copy article Nostr link"
              aria-label="Copy article link"
            >
              {copiedLink ? <Check size={15} /> : <Link2 size={15} />}
            </button>
            <button
              type="button"
              className="ag-agora-icon-btn"
              onClick={onClose}
              title="Close reader (Esc)"
              aria-label="Close article reader"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="ag-agora-article-modal-scroll">
          {coverBlobUrl && (
            <div className="ag-agora-article-modal-cover">
              <img src={coverBlobUrl} alt={article.title} />
            </div>
          )}

          <header className="ag-agora-article-modal-head">
            <h1 className="ag-agora-article-modal-title">{article.title}</h1>
            {article.summary?.trim() && (
              <p className="ag-agora-article-modal-summary">{article.summary.trim()}</p>
            )}

            <div className="ag-agora-article-modal-authorbar">
              <button
                type="button"
                className="ag-agora-article-author-btn"
                onClick={() => {
                  onClose()
                  onOpenProfile?.(pk)
                }}
              >
                <img
                  src={avatarBlobUrl || identicon}
                  alt={displayName}
                  className="ag-agora-avatar ag-agora-avatar-sm"
                />
                <div className="ag-agora-article-author-info">
                  <span className="ag-agora-article-author-name">
                    {displayName}
                    {profile?.nip05 && nip05Status === 'verified' && (
                      <BadgeCheck size={13} className="ag-agora-nip05-icon" aria-hidden="true" />
                    )}
                  </span>
                  {pubDate && <span className="ag-agora-time">{pubDate}</span>}
                </div>
              </button>

              <div className="ag-agora-article-author-cta">
                {!isSelf && (
                  <button
                    type="button"
                    className={`ag-agora-follow-btn${isFollowing ? ' following' : ''}`}
                    disabled={followBusy}
                    onClick={() => void handleToggleFollow()}
                  >
                    {followBusy ? (
                      <Loader2 size={13} className="ag-agora-spin" />
                    ) : isFollowing ? (
                      <Check size={13} />
                    ) : (
                      <UserPlus size={13} />
                    )}
                    <span>{isFollowing ? 'Following' : 'Follow'}</span>
                  </button>
                )}
                {onOpenZap && !isSelf && (
                  <button
                    type="button"
                    className="ag-agora-composer-pill-btn"
                    onClick={handleZap}
                    title={`Zap ${displayName}`}
                  >
                    <Zap size={13} />
                    <span>Zap</span>
                  </button>
                )}
              </div>
            </div>

            {article.hashtags.length > 0 && (
              <div className="ag-agora-article-tags">
                {article.hashtags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="ag-agora-article-tag"
                    onClick={() => {
                      onClose()
                      onSelectHashtag?.(tag)
                    }}
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            )}
          </header>

          <div className="ag-agora-article-prose">
            {blocks.map((block, idx) => {
              if (block.type === 'heading') {
                if (block.level === 1) {
                  return (
                    <h2 key={idx} className="ag-agora-article-h1">
                      {block.text}
                    </h2>
                  )
                }
                if (block.level === 2) {
                  return (
                    <h3 key={idx} className="ag-agora-article-h2">
                      {block.text}
                    </h3>
                  )
                }
                return (
                  <h4 key={idx} className="ag-agora-article-h3">
                    {block.text}
                  </h4>
                )
              }
              if (block.type === 'blockquote') {
                return (
                  <blockquote key={idx} className="ag-agora-article-quote">
                    {renderInlineSafeText(block.text, pk, displayName, isTrusted)}
                  </blockquote>
                )
              }
              if (block.type === 'code') {
                return (
                  <pre key={idx} className="ag-agora-code-block">
                    {block.lang && <div className="ag-agora-code-lang">{block.lang}</div>}
                    <code>{block.code}</code>
                  </pre>
                )
              }
              return (
                <p key={idx} className="ag-agora-article-p">
                  {renderInlineSafeText(block.text, pk, displayName, isTrusted)}
                </p>
              )
            })}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default AgoraArticleModal
