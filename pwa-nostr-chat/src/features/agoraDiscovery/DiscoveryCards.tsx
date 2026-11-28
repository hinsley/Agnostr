import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  BadgeCheck,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Compass,
  Heart,
  ListPlus,
  Loader2,
  MessageCircle,
  Network,
  Repeat2,
  Sparkles,
  UserPlus,
  Users,
  X,
  Zap,
} from 'lucide-react'
import type { AgnostrEngine } from '../../types/protocol.ts'
import { getProfileDisplayName, sanitizeHttpUrl } from '../../lib/agoraProtocol.ts'
import { encodeNpubSafe } from '../../lib/identity.ts'
import { identiconDataUrl, shortPubkey } from '../../utils/identicon.ts'
import type { SoundCue } from '../../utils/sound.ts'
import type { DiscoveredAccount, DiscoveredNote, FollowPack } from './types.ts'

export interface DiscoveredAccountCardProps {
  engine: AgnostrEngine
  account: DiscoveredAccount
  onOpenProfile: (pubkey: string) => void
  onOpenThread: (noteId: string) => void
  onOpenArticle?: (articleId: string) => void
  onFindSimilar: (pubkey: string) => void
  onInspectInGraph?: (pubkey: string) => void
  onFollow?: (pubkey: string) => void | Promise<unknown>
  onDismiss: (pubkey: string) => void
  onPlaySound?: (cue: SoundCue) => void
}

export interface DiscoveredNoteCardProps {
  engine: AgnostrEngine
  item: DiscoveredNote
  onOpenProfile: (pubkey: string) => void
  onOpenThread: (noteId: string) => void
  onFollow?: (pubkey: string) => void | Promise<unknown>
  onPlaySound?: (cue: SoundCue) => void
}

export interface FollowPackCardProps {
  engine: AgnostrEngine
  pack: FollowPack
  onFollowSelected: (pubkeys: string[]) => void | Promise<unknown>
  onSaveAsCustomList: (pack: FollowPack, selectedPubkeys?: string[]) => void | Promise<unknown>
  onOpenProfile?: (pubkey: string) => void
  onPlaySound?: (cue: SoundCue) => void
}

function formatNip05Display(raw: string | undefined): string | null {
  if (!raw) return null
  const clean = raw.trim()
  if (!clean) return null
  return clean.startsWith('_@') ? clean.slice(1) : clean
}

function formatRelativeSeconds(tsSec: number): string {
  const nowSec = Math.floor(Date.now() / 1000)
  const diff = Math.max(0, nowSec - tsSec)
  if (diff < 45) return 'now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h`
  if (diff < 86_400 * 14) return `${Math.floor(diff / 86_400)}d`
  try {
    return new Date(tsSec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch {
    return `${Math.floor(diff / 86_400)}d`
  }
}

function formatCompactCount(n: number): string {
  if (n <= 0) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`
  }
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

function truncateClean(raw: string, maxChars: number): string {
  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`
}

interface DiscoveryAvatarProps {
  engine: AgnostrEngine
  pubkey: string
  picture?: string
  size?: 'xs' | 'sm' | 'md'
  alt: string
  className?: string
}

const DiscoveryAvatar: React.FC<DiscoveryAvatarProps> = ({
  engine,
  pubkey,
  picture,
  size = 'md',
  alt,
  className,
}) => {
  const { contentFilter } = engine
  const requestedRef = useRef<string | null>(null)
  const pk = pubkey.trim().toLowerCase()
  const safeHttpsUrl = useMemo(() => {
    const clean = sanitizeHttpUrl(picture)
    return clean && clean.startsWith('https://') ? clean : null
  }, [picture])
  const cacheKey = safeHttpsUrl ? `agora-img:${pk || 'anon'}:${safeHttpsUrl}` : ''
  const verdict = cacheKey ? contentFilter.getVerdict(cacheKey) : null
  const safeBlobUrl =
    cacheKey && verdict?.status === 'safe' ? contentFilter.getSafeImageObjectUrl(cacheKey) : null
  const identicon = useMemo(() => identiconDataUrl(pk || 'anon'), [pk])

  useEffect(() => {
    if (!safeHttpsUrl || !cacheKey) return
    const needsScreen = !verdict || verdict.status === 'idle'
    const needsRehydrate = verdict?.status === 'safe' && !safeBlobUrl
    if (!needsScreen && !needsRehydrate) return
    if (requestedRef.current === cacheKey) return
    requestedRef.current = cacheKey
    void contentFilter.screenExternalImageUrl(cacheKey, safeHttpsUrl, pk)
  }, [safeHttpsUrl, cacheKey, verdict, safeBlobUrl, contentFilter, pk])

  const classes = ['ag-agora-avatar', `ag-agora-avatar-${size}`, className ?? '']
    .filter(Boolean)
    .join(' ')
  return <img src={safeBlobUrl || identicon} alt={alt} className={classes} loading="lazy" />
}

/* --------------------------------------------------------------------------
   1. DiscoveredAccountCard (Sample-Before-You-Follow)
   -------------------------------------------------------------------------- */
export const DiscoveredAccountCard: React.FC<DiscoveredAccountCardProps> = ({
  engine,
  account,
  onOpenProfile,
  onOpenThread,
  onOpenArticle,
  onFindSimilar,
  onInspectInGraph,
  onFollow,
  onDismiss,
  onPlaySound,
}) => {
  const { agora } = engine
  const [followBusy, setFollowBusy] = useState(false)
  const pk = account.pubkey.trim().toLowerCase()
  const profile = agora.getProfile(pk)
  const displayName = getProfileDisplayName(profile, pk)
  const npub = profile?.npub || encodeNpubSafe(pk)
  const nip05Display = formatNip05Display(profile?.nip05)
  const isSelf = pk === agora.myPubkey.toLowerCase()
  const isFollowing = !isSelf && agora.isFollowing(pk)

  const stackedEndorsers = useMemo(() => {
    const merged = [...account.trustedEndorsers, ...account.endorsers]
    const unique: string[] = []
    const seen = new Set<string>()
    for (const raw of merged) {
      const epk = raw.trim().toLowerCase()
      if (!epk || seen.has(epk)) continue
      seen.add(epk)
      unique.push(epk)
      if (unique.length >= 3) break
    }
    return unique
  }, [account.trustedEndorsers, account.endorsers])

  useEffect(() => {
    const toEnsure = [pk, ...stackedEndorsers].filter(Boolean)
    if (toEnsure.length > 0) agora.ensureProfiles(toEnsure)
  }, [agora, pk, stackedEndorsers])

  const primaryReason = useMemo(() => {
    if (account.reasons.length > 0 && account.reasons[0].trim()) {
      return account.reasons[0]
    }
    if (stackedEndorsers.length > 0) {
      const names = stackedEndorsers
        .slice(0, 2)
        .map((epk) => `@${getProfileDisplayName(agora.getProfile(epk), epk)}`)
      const total = Math.max(account.endorsers.length, stackedEndorsers.length)
      const rest = Math.max(0, total - names.length)
      return rest > 0
        ? `Followed by ${names.join(', ')} + ${rest} ${rest === 1 ? 'other' : 'others'}`
        : `Followed by ${names.join(', ')}`
    }
    return 'High-signal voice in your network'
  }, [account.reasons, account.endorsers.length, stackedEndorsers, agora])

  const handleFollowClick = async () => {
    if (followBusy || isSelf) return
    setFollowBusy(true)
    try {
      if (onFollow) {
        await Promise.resolve(onFollow(pk))
      } else {
        await agora.toggleFollow(pk)
      }
      onPlaySound?.('click')
    } finally {
      setFollowBusy(false)
    }
  }

  return (
    <article className="ag-disc-account-card" aria-label={`Recommended account: ${displayName}`}>
      {/* Header Row */}
      <div className="ag-disc-card-head">
        <button
          type="button"
          className="ag-disc-card-author"
          onClick={() => {
            onPlaySound?.('click')
            onOpenProfile(pk)
          }}
        >
          <DiscoveryAvatar
            engine={engine}
            pubkey={pk}
            picture={profile?.picture}
            size="md"
            alt={displayName}
          />
          <div className="ag-disc-card-identity">
            <div className="ag-disc-card-name-row">
              <span className="ag-disc-card-name truncate">{displayName}</span>
              {account.isVerifiedNip05 && nip05Display && (
                <BadgeCheck
                  size={14}
                  className="ag-agora-nip05-icon"
                  aria-label="Verified NIP-05"
                />
              )}
            </div>
            <div className="ag-disc-card-sub">
              {account.isVerifiedNip05 && nip05Display ? (
                <span className="ag-agora-nip05 verified truncate">{nip05Display}</span>
              ) : null}
              <span className="ag-disc-npub mono">{shortPubkey(npub)}</span>
            </div>
          </div>
        </button>

        <span
          className="ag-disc-signal-pill tabular"
          title={`Web-of-Trust & quality signal score: ${Math.round(account.signalScore)}/100`}
        >
          <Sparkles size={11} aria-hidden="true" />
          <span>Signal {Math.round(account.signalScore)}</span>
        </span>
      </div>

      {/* Explainability Row */}
      <div className="ag-disc-explain-row">
        {stackedEndorsers.length > 0 && (
          <div className="ag-disc-endorser-stack" aria-hidden="true">
            {stackedEndorsers.map((epk) => {
              const ep = agora.getProfile(epk)
              return (
                <DiscoveryAvatar
                  key={epk}
                  engine={engine}
                  pubkey={epk}
                  picture={ep?.picture}
                  size="xs"
                  alt={getProfileDisplayName(ep, epk)}
                  className="ag-disc-stack-avatar"
                />
              )
            })}
          </div>
        )}
        <span className="ag-disc-explain-text">{primaryReason}</span>
      </div>

      {account.badges.length > 0 && (
        <div className="ag-disc-badge-row">
          {account.badges.slice(0, 4).map((badge) => (
            <span key={badge} className="ag-disc-quality-badge">
              {badge}
            </span>
          ))}
        </div>
      )}

      {/* Bio Snippet */}
      {profile?.about?.trim() && (
        <p className="ag-disc-card-bio">{profile.about.trim()}</p>
      )}

      {/* Sample-Before-You-Follow Preview */}
      {(account.sampleNotes.length > 0 || account.sampleArticle) && (
        <div className="ag-disc-samples">
          {account.sampleArticle && (
            <button
              type="button"
              className="ag-disc-sample-item is-article"
              onClick={() => {
                onPlaySound?.('click')
                if (onOpenArticle) {
                  onOpenArticle(account.sampleArticle!.id)
                } else {
                  onOpenProfile(pk)
                }
              }}
            >
              <div className="ag-disc-sample-meta">
                <BookOpen size={12} aria-hidden="true" />
                <span>Article</span>
                <span className="ag-agora-dot-sep">·</span>
                <span className="tabular">
                  {formatRelativeSeconds(
                    account.sampleArticle.publishedAt || account.sampleArticle.createdAt
                  )}
                </span>
              </div>
              <div className="ag-disc-sample-article-title">{account.sampleArticle.title}</div>
              {account.sampleArticle.summary?.trim() && (
                <p className="ag-disc-sample-body">
                  {truncateClean(account.sampleArticle.summary, 180)}
                </p>
              )}
            </button>
          )}

          {account.sampleNotes.slice(0, account.sampleArticle ? 1 : 2).map((note) => (
            <button
              key={note.id}
              type="button"
              className="ag-disc-sample-item"
              onClick={() => {
                onPlaySound?.('click')
                onOpenThread(note.id)
              }}
            >
              <p className="ag-disc-sample-body">{truncateClean(note.content, 200)}</p>
              <span className="ag-disc-sample-time tabular">
                {formatRelativeSeconds(note.createdAt)}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Footer Actions */}
      <div className="ag-disc-card-actions">
        {!isSelf && (
          <button
            type="button"
            className={`ag-agora-follow-btn${isFollowing ? ' following' : ''}`}
            disabled={followBusy}
            onClick={() => void handleFollowClick()}
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

        <button
          type="button"
          className="ag-disc-action-btn"
          onClick={() => {
            onPlaySound?.('click')
            onFindSimilar(pk)
          }}
        >
          <Compass size={13} aria-hidden="true" />
          <span>Similar Voices</span>
        </button>

        {onInspectInGraph && (
          <button
            type="button"
            className="ag-disc-action-btn"
            onClick={() => {
              onPlaySound?.('click')
              onInspectInGraph(pk)
            }}
          >
            <Network size={13} aria-hidden="true" />
            <span>Inspect in Graph</span>
          </button>
        )}

        <button
          type="button"
          className="ag-disc-action-btn is-dismiss"
          onClick={() => {
            onPlaySound?.('click')
            onDismiss(pk)
          }}
          title="Hide this recommendation"
          aria-label={`Not for me: hide ${displayName}`}
        >
          <X size={13} aria-hidden="true" />
          <span>Not for me</span>
        </button>
      </div>
    </article>
  )
}

/* --------------------------------------------------------------------------
   2. DiscoveredNoteCard (High-Signal Lens)
   -------------------------------------------------------------------------- */
export const DiscoveredNoteCard: React.FC<DiscoveredNoteCardProps> = ({
  engine,
  item,
  onOpenProfile,
  onOpenThread,
  onFollow,
  onPlaySound,
}) => {
  const { agora } = engine
  const [followBusy, setFollowBusy] = useState(false)
  const { note } = item
  const pk = note.pubkey.trim().toLowerCase()
  const profile = agora.getProfile(pk)
  const displayName = getProfileDisplayName(profile, pk)
  const nip05Status = agora.nip05StatusByPubkey[pk] ?? 'unverified'
  const isSelf = pk === agora.myPubkey.toLowerCase()
  const isFollowing = !isSelf && agora.isFollowing(pk)
  const stats = agora.getNoteStats(note.id)

  useEffect(() => {
    if (pk) agora.ensureProfiles([pk])
  }, [agora, pk])

  useEffect(() => {
    if (pk && profile?.nip05) {
      agora.ensureNip05Verified(pk, profile.nip05)
    }
  }, [agora, pk, profile?.nip05])

  const replies = Math.max(stats.replies, item.replyCount)
  const reposts = Math.max(stats.reposts, item.wotReposters)
  const likes = stats.likes
  const zapCount = Math.max(stats.zapCount, item.wotZappers)
  const zapSats = stats.zapSats

  const handleQuickFollow = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (followBusy || isSelf || isFollowing) return
    setFollowBusy(true)
    try {
      if (onFollow) {
        await Promise.resolve(onFollow(pk))
      } else {
        await agora.toggleFollow(pk)
      }
      onPlaySound?.('click')
    } finally {
      setFollowBusy(false)
    }
  }

  return (
    <article
      className="ag-disc-note-card"
      role="button"
      tabIndex={0}
      onClick={() => {
        onPlaySound?.('click')
        onOpenThread(note.id)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPlaySound?.('click')
          onOpenThread(note.id)
        }
      }}
      aria-label={`High-signal note by ${displayName}`}
    >
      <div className="ag-disc-note-head">
        <button
          type="button"
          className="ag-disc-card-author"
          onClick={(e) => {
            e.stopPropagation()
            onPlaySound?.('click')
            onOpenProfile(pk)
          }}
        >
          <DiscoveryAvatar
            engine={engine}
            pubkey={pk}
            picture={profile?.picture}
            size="sm"
            alt={displayName}
          />
          <div className="ag-disc-note-author-meta">
            <span className="ag-disc-card-name truncate">{displayName}</span>
            {profile?.nip05 && nip05Status === 'verified' && (
              <BadgeCheck size={13} className="ag-agora-nip05-icon" aria-label="Verified NIP-05" />
            )}
            <span className="ag-agora-dot-sep">·</span>
            <span className="ag-agora-time tabular">{formatRelativeSeconds(note.createdAt)}</span>
          </div>
        </button>

        <div className="ag-disc-note-head-right">
          <span className="ag-disc-signal-pill tabular">
            <Sparkles size={11} aria-hidden="true" />
            <span>{Math.round(item.signalScore)}</span>
          </span>
          {!isSelf && !isFollowing && (
            <button
              type="button"
              className="ag-disc-quick-follow-btn"
              disabled={followBusy}
              onClick={(e) => void handleQuickFollow(e)}
            >
              {followBusy ? (
                <Loader2 size={12} className="ag-agora-spin" />
              ) : (
                <UserPlus size={12} />
              )}
              <span>Follow</span>
            </button>
          )}
        </div>
      </div>

      {item.reasons.length > 0 && (
        <div className="ag-disc-reason-pills">
          {item.reasons.slice(0, 3).map((reason) => (
            <span key={reason} className="ag-disc-reason-pill">
              {reason}
            </span>
          ))}
        </div>
      )}

      <p className="ag-disc-note-body">{truncateClean(note.content, 360)}</p>

      <div className="ag-disc-note-stats tabular">
        <span className="ag-disc-stat-chip" title="Replies">
          <MessageCircle size={13} aria-hidden="true" />
          <span>{formatCompactCount(replies)}</span>
        </span>
        <span className="ag-disc-stat-chip" title="Reposts">
          <Repeat2 size={13} aria-hidden="true" />
          <span>{formatCompactCount(reposts)}</span>
        </span>
        <span className="ag-disc-stat-chip" title="Likes">
          <Heart size={13} aria-hidden="true" />
          <span>{formatCompactCount(likes)}</span>
        </span>
        <span className="ag-disc-stat-chip is-zap" title="Zaps">
          <Zap size={13} aria-hidden="true" />
          <span>
            {zapSats > 0
              ? `${formatCompactCount(zapSats)} sats`
              : formatCompactCount(zapCount)}
          </span>
        </span>
      </div>
    </article>
  )
}

/* --------------------------------------------------------------------------
   3. FollowPackCard (NIP-51 / Kind 39089 Follow Packs)
   -------------------------------------------------------------------------- */
export const FollowPackCard: React.FC<FollowPackCardProps> = ({
  engine,
  pack,
  onFollowSelected,
  onSaveAsCustomList,
  onOpenProfile,
  onPlaySound,
}) => {
  const { agora } = engine
  const myPk = agora.myPubkey.trim().toLowerCase()
  const [expanded, setExpanded] = useState(false)
  const [followBusy, setFollowBusy] = useState(false)
  const [saveBusy, setSaveBusy] = useState(false)

  const uniqueMembers = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of pack.memberPubkeys) {
      const pk = raw.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pk) || seen.has(pk)) continue
      seen.add(pk)
      out.push(pk)
    }
    return out
  }, [pack.memberPubkeys])

  const defaultSelected = useMemo(
    () => uniqueMembers.filter((pk) => pk !== myPk && !agora.isFollowing(pk)),
    [uniqueMembers, myPk, agora]
  )

  const [selectedState, setSelectedState] = useState<{
    packId: string
    pubkeys: string[]
  }>(() => ({ packId: pack.id, pubkeys: defaultSelected }))

  const selectedPubkeys =
    selectedState.packId === pack.id ? selectedState.pubkeys : defaultSelected
  const selectedSet = useMemo(() => new Set(selectedPubkeys), [selectedPubkeys])

  useEffect(() => {
    const batch = [pack.pubkey, ...uniqueMembers.slice(0, expanded ? 48 : 8)].filter(Boolean)
    if (batch.length > 0) agora.ensureProfiles(batch)
  }, [agora, pack.pubkey, uniqueMembers, expanded])

  const creatorPk = pack.pubkey.trim().toLowerCase()
  const creatorProfile = agora.getProfile(creatorPk)
  const creatorName = getProfileDisplayName(creatorProfile, creatorPk)

  const toggleMember = (pk: string) => {
    setSelectedState((prev) => {
      const base = prev.packId === pack.id ? prev.pubkeys : defaultSelected
      const next = base.includes(pk) ? base.filter((p) => p !== pk) : [...base, pk]
      return { packId: pack.id, pubkeys: next }
    })
  }

  const handleFollowSelectedClick = async () => {
    if (followBusy || selectedPubkeys.length === 0) return
    setFollowBusy(true)
    try {
      await Promise.resolve(onFollowSelected(selectedPubkeys))
      onPlaySound?.('send')
    } finally {
      setFollowBusy(false)
    }
  }

  const handleSaveListClick = async () => {
    if (saveBusy) return
    setSaveBusy(true)
    try {
      const listMembers = selectedPubkeys.length > 0 ? selectedPubkeys : uniqueMembers
      await Promise.resolve(onSaveAsCustomList(pack, listMembers))
      onPlaySound?.('click')
    } finally {
      setSaveBusy(false)
    }
  }

  return (
    <article className="ag-disc-pack-card" aria-label={`Follow Pack: ${pack.title}`}>
      <div className="ag-disc-pack-head">
        <div className="ag-disc-pack-title-col">
          <div className="ag-disc-pack-title-row">
            <h3 className="ag-disc-pack-title">{pack.title}</h3>
            {pack.wotOverlapCount > 0 ? (
              <span className="ag-disc-overlap-pill">
                {pack.wotOverlapCount}{' '}
                {pack.wotOverlapCount === 1 ? 'person' : 'people'} you follow{' '}
                {pack.wotOverlapCount === 1 ? 'is' : 'are'} here
              </span>
            ) : pack.isStarterFallback ? (
              <span className="ag-disc-overlap-pill is-starter">Curated Starter Pack</span>
            ) : null}
          </div>

          {pack.description?.trim() && (
            <p className="ag-disc-pack-desc">{pack.description.trim()}</p>
          )}

          <div className="ag-disc-pack-meta">
            <button
              type="button"
              className="ag-disc-pack-creator"
              onClick={() => onOpenProfile?.(creatorPk)}
            >
              <span>Curated by</span>
              <strong>@{creatorName}</strong>
            </button>
            <span className="ag-agora-dot-sep">·</span>
            <span className="ag-disc-pack-count tabular">
              <Users size={11} aria-hidden="true" />
              <span>
                {uniqueMembers.length} {uniqueMembers.length === 1 ? 'account' : 'accounts'}
              </span>
            </span>
          </div>
        </div>
      </div>

      {/* Stacked Preview Avatars + Expand Drawer Toggle */}
      <div className="ag-disc-pack-preview-row">
        <div className="ag-disc-pack-avatars" aria-hidden="true">
          {uniqueMembers.slice(0, 6).map((mpk) => {
            const mp = agora.getProfile(mpk)
            return (
              <DiscoveryAvatar
                key={mpk}
                engine={engine}
                pubkey={mpk}
                picture={mp?.picture}
                size="xs"
                alt={getProfileDisplayName(mp, mpk)}
                className="ag-disc-stack-avatar"
              />
            )
          })}
          {uniqueMembers.length > 6 && (
            <span className="ag-disc-pack-more-pill tabular">+{uniqueMembers.length - 6}</span>
          )}
        </div>

        <button
          type="button"
          className="ag-disc-pack-expand-btn"
          aria-expanded={expanded}
          onClick={() => {
            onPlaySound?.('click')
            setExpanded((v) => !v)
          }}
        >
          <span>Preview &amp; pick members</span>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {/* Expandable Member Selection Drawer */}
      {expanded && (
        <div className="ag-disc-pack-drawer">
          <div className="ag-disc-pack-drawer-bar">
            <span className="tabular">{selectedPubkeys.length} selected to follow</span>
            <div className="ag-disc-pack-drawer-links">
              <button
                type="button"
                className="ag-disc-link-btn"
                onClick={() =>
                  setSelectedState({ packId: pack.id, pubkeys: defaultSelected })
                }
              >
                Select unfollowed
              </button>
              <button
                type="button"
                className="ag-disc-link-btn"
                onClick={() => setSelectedState({ packId: pack.id, pubkeys: [] })}
              >
                Clear
              </button>
            </div>
          </div>

          <div className="ag-disc-pack-member-list">
            {uniqueMembers.map((mpk) => {
              const mp = agora.getProfile(mpk)
              const mName = getProfileDisplayName(mp, mpk)
              const alreadyFollowing = agora.isFollowing(mpk)
              const isSelfMember = mpk === myPk
              const checked = selectedSet.has(mpk)

              return (
                <label
                  key={mpk}
                  className={`ag-disc-pack-member-row${checked ? ' is-selected' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={isSelfMember}
                    onChange={() => toggleMember(mpk)}
                  />
                  <DiscoveryAvatar
                    engine={engine}
                    pubkey={mpk}
                    picture={mp?.picture}
                    size="xs"
                    alt={mName}
                  />
                  <span className="ag-disc-pack-member-info">
                    <span className="ag-disc-pack-member-name truncate">{mName}</span>
                    <span className="ag-disc-npub mono truncate">
                      {shortPubkey(mp?.npub || encodeNpubSafe(mpk))}
                    </span>
                  </span>
                  {isSelfMember ? (
                    <span className="ag-disc-member-tag">You</span>
                  ) : alreadyFollowing ? (
                    <span className="ag-disc-member-tag is-following">Following</span>
                  ) : null}
                </label>
              )
            })}
          </div>
        </div>
      )}

      {/* Pack Action Footer */}
      <div className="ag-disc-card-actions">
        <button
          type="button"
          className="ag-agora-follow-btn"
          disabled={followBusy || selectedPubkeys.length === 0}
          onClick={() => void handleFollowSelectedClick()}
        >
          {followBusy ? <Loader2 size={13} className="ag-agora-spin" /> : <UserPlus size={13} />}
          <span>
            {selectedPubkeys.length > 0
              ? `Follow Selected (${selectedPubkeys.length})`
              : 'All Followed'}
          </span>
        </button>

        <button
          type="button"
          className="ag-disc-action-btn"
          disabled={saveBusy || uniqueMembers.length === 0}
          onClick={() => void handleSaveListClick()}
        >
          {saveBusy ? <Loader2 size={13} className="ag-agora-spin" /> : <ListPlus size={13} />}
          <span>Save as Custom List</span>
        </button>
      </div>
    </article>
  )
}
