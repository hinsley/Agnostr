import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  BadgeCheck,
  Check,
  Loader2,
  MessageCircle,
  ShieldCheck,
  UserPlus,
} from 'lucide-react'
import type { AgnostrEngine } from '../types/protocol.ts'
import { getProfileDisplayName, sanitizeHttpUrl } from '../lib/agoraProtocol.ts'
import { encodeNpubSafe } from '../lib/identity.ts'
import { identiconDataUrl, shortPubkey } from '../utils/identicon.ts'
import type { SoundCue } from '../utils/sound.ts'

export interface AgoraProfileHoverCardProps {
  engine: AgnostrEngine
  pubkey: string
  anchorRect: DOMRect
  onMouseEnter: () => void
  onMouseLeave: () => void
  onOpenProfile: (pubkey: string) => void
  onOpenDm: (pubkey: string, nickname?: string) => void
  onPlaySound?: (cue: SoundCue) => void
}

function formatNip05Display(raw: string | undefined): string | null {
  if (!raw) return null
  const clean = raw.trim()
  if (!clean) return null
  return clean.startsWith('_@') ? clean.slice(1) : clean
}

function useScreenedSafeImageUrl(
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

export const AgoraProfileHoverCard: React.FC<AgoraProfileHoverCardProps> = ({
  engine,
  pubkey,
  anchorRect,
  onMouseEnter,
  onMouseLeave,
  onOpenProfile,
  onOpenDm,
  onPlaySound,
}) => {
  const { agora } = engine
  const pk = pubkey.trim().toLowerCase()
  const profile = agora.getProfile(pk)
  const [followBusy, setFollowBusy] = useState(false)

  useEffect(() => {
    if (!pk) return
    agora.ensureProfiles([pk])
  }, [agora, pk])

  useEffect(() => {
    if (pk && profile?.nip05) {
      agora.ensureNip05Verified(pk, profile.nip05)
    }
  }, [agora, pk, profile?.nip05])

  const avatarBlobUrl = useScreenedSafeImageUrl(engine, profile?.picture, pk)
  const bannerBlobUrl = useScreenedSafeImageUrl(engine, profile?.banner, pk)
  const identicon = useMemo(() => identiconDataUrl(pk || 'anon'), [pk])

  const displayName = getProfileDisplayName(profile, pk)
  const npub = profile?.npub || encodeNpubSafe(pk)
  const nip05Display = formatNip05Display(profile?.nip05)
  const nip05Status = agora.nip05StatusByPubkey[pk] ?? 'unverified'
  const isSelf = pk === agora.myPubkey.toLowerCase()
  const isFollowing = !isSelf && agora.isFollowing(pk)
  const isTrustedPeer = !isSelf && engine.isTrusted(pk)

  const cardWidth = 304
  const estimatedHeight = 236
  const margin = 12
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800

  const placeAbove =
    anchorRect.bottom + 8 + estimatedHeight > vh - margin &&
    anchorRect.top - 8 - estimatedHeight >= margin
  const left = Math.min(Math.max(margin, anchorRect.left), Math.max(margin, vw - cardWidth - margin))

  const posStyle: React.CSSProperties = placeAbove
    ? {
        position: 'fixed',
        left,
        bottom: Math.max(margin, vh - anchorRect.top + 8),
        width: Math.min(cardWidth, vw - margin * 2),
      }
    : {
        position: 'fixed',
        left,
        top: Math.min(vh - margin - 120, Math.max(margin, anchorRect.bottom + 8)),
        width: Math.min(cardWidth, vw - margin * 2),
      }

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

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="ag-agora-hover-card"
      style={posStyle}
      role="dialog"
      aria-label={`Profile preview for ${displayName}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="ag-agora-hover-banner">
        {bannerBlobUrl && <img src={bannerBlobUrl} alt="" />}
      </div>

      <div className="ag-agora-hover-body">
        <div className="ag-agora-hover-top">
          <button
            type="button"
            className="ag-agora-hover-avatar-btn"
            onClick={() => onOpenProfile(pk)}
            aria-label={`Open ${displayName}'s profile`}
          >
            <img
              src={avatarBlobUrl || identicon}
              alt={displayName}
              className="ag-agora-avatar ag-agora-avatar-md"
            />
          </button>

          <div className="ag-agora-hover-actions">
            {isSelf ? (
              <button
                type="button"
                className="ag-agora-hover-action-btn"
                onClick={() => onOpenProfile(pk)}
              >
                View Profile
              </button>
            ) : (
              <>
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
                <button
                  type="button"
                  className="ag-agora-icon-btn"
                  onClick={() => {
                    onPlaySound?.('click')
                    onOpenDm(pk, displayName)
                  }}
                  title={`Message ${displayName}`}
                  aria-label={`Message ${displayName}`}
                >
                  <MessageCircle size={15} />
                </button>
              </>
            )}
          </div>
        </div>

        <div className="ag-agora-hover-identity">
          <button
            type="button"
            className="ag-agora-hover-name truncate"
            onClick={() => onOpenProfile(pk)}
          >
            {displayName}
          </button>
          {isTrustedPeer && (
            <span className="ag-agora-trusted-pill" title="In your Trusted Peers list">
              <ShieldCheck size={11} aria-hidden="true" />
              <span>Trusted</span>
            </span>
          )}
        </div>

        <div className="ag-agora-hover-meta">
          {nip05Display && nip05Status !== 'invalid' && (
            <span className={`ag-agora-nip05${nip05Status === 'verified' ? ' verified' : ''}`}>
              {nip05Status === 'verified' && (
                <BadgeCheck size={12} className="ag-agora-nip05-icon" aria-hidden="true" />
              )}
              <span className="truncate">{nip05Display}</span>
            </span>
          )}
          <span className="ag-agora-hover-npub mono">{shortPubkey(npub)}</span>
        </div>

        {profile?.about?.trim() && (
          <p className="ag-agora-hover-bio">{profile.about.trim()}</p>
        )}
      </div>
    </div>,
    document.body
  )
}

export default AgoraProfileHoverCard
