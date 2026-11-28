import React, { useEffect, useMemo, useRef, useState } from 'react'
import { BadgeCheck, BarChart2, Check, Clock, Loader2 } from 'lucide-react'
import type { AgoraPoll, AgoraPollResults } from '../types/agora.ts'
import type { AgnostrEngine } from '../types/protocol.ts'
import { getProfileDisplayName, sanitizeHttpUrl } from '../lib/agoraProtocol.ts'
import { identiconDataUrl } from '../utils/identicon.ts'
import type { SoundCue } from '../utils/sound.ts'

export interface AgoraPollCardProps {
  engine: AgnostrEngine
  poll: AgoraPoll
  results?: AgoraPollResults
  onOpenProfile?: (pubkey: string) => void
  onPlaySound?: (cue: SoundCue) => void
}

function formatRelativeSeconds(tsSec: number): string {
  const nowSec = Math.floor(Date.now() / 1000)
  const diff = Math.max(0, nowSec - tsSec)
  if (diff < 45) return 'now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86_400)}d`
}

function formatPollCountdown(endsAtSec: number | undefined, nowSec: number): {
  label: string
  ended: boolean
} {
  if (!endsAtSec || !Number.isFinite(endsAtSec)) {
    return { label: 'Open poll', ended: false }
  }
  const remaining = Math.floor(endsAtSec - nowSec)
  if (remaining <= 0) {
    return { label: 'Ended', ended: true }
  }
  if (remaining < 3600) {
    const mins = Math.max(1, Math.ceil(remaining / 60))
    return { label: `Ends in ${mins}m`, ended: false }
  }
  if (remaining < 86_400) {
    const hrs = Math.ceil(remaining / 3600)
    return { label: `Ends in ${hrs}h`, ended: false }
  }
  const days = Math.ceil(remaining / 86_400)
  return { label: `Ends in ${days}d`, ended: false }
}

export const AgoraPollCard: React.FC<AgoraPollCardProps> = ({
  engine,
  poll,
  results: resultsProp,
  onOpenProfile,
  onPlaySound,
}) => {
  const { agora, contentFilter } = engine
  const [votingOptionId, setVotingOptionId] = useState<string | null>(null)
  const [nowSec, setNowSec] = useState<number>(() => Math.floor(Date.now() / 1000))
  const requestedAvatarRef = useRef<string | null>(null)

  const pk = poll.pubkey.trim().toLowerCase()
  const profile = agora.getProfile(pk)
  const displayName = getProfileDisplayName(profile, pk)
  const nip05Status = agora.nip05StatusByPubkey[pk] ?? 'unverified'

  const results: AgoraPollResults = resultsProp ??
    agora.pollResultsById[poll.id] ?? {
      totalVotes: 0,
      countsByOption: {},
    }

  useEffect(() => {
    if (pk) agora.ensureProfiles([pk])
  }, [agora, pk])

  useEffect(() => {
    if (pk && profile?.nip05) {
      agora.ensureNip05Verified(pk, profile.nip05)
    }
  }, [agora, pk, profile?.nip05])

  // Refresh countdown clock every 30s while poll is open
  useEffect(() => {
    if (!poll.endsAt || poll.endsAt <= nowSec) return
    const timer = window.setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000))
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [poll.endsAt, nowSec])

  const safeAvatarUrl = useMemo(() => {
    const clean = sanitizeHttpUrl(profile?.picture)
    return clean && clean.startsWith('https://') ? clean : null
  }, [profile?.picture])
  const avatarCacheKey = safeAvatarUrl ? `agora-img:${pk || 'anon'}:${safeAvatarUrl}` : ''
  const avatarVerdict = avatarCacheKey ? contentFilter.getVerdict(avatarCacheKey) : null
  const avatarBlobUrl =
    avatarCacheKey && avatarVerdict?.status === 'safe'
      ? contentFilter.getSafeImageObjectUrl(avatarCacheKey)
      : null
  const identicon = useMemo(() => identiconDataUrl(pk || 'anon'), [pk])

  useEffect(() => {
    if (!safeAvatarUrl || !avatarCacheKey) return
    const needsScreen = !avatarVerdict || avatarVerdict.status === 'idle'
    const needsRehydrate = avatarVerdict?.status === 'safe' && !avatarBlobUrl
    if (!needsScreen && !needsRehydrate) return
    if (requestedAvatarRef.current === avatarCacheKey) return
    requestedAvatarRef.current = avatarCacheKey
    void contentFilter.screenExternalImageUrl(avatarCacheKey, safeAvatarUrl, pk)
  }, [safeAvatarUrl, avatarCacheKey, avatarVerdict, avatarBlobUrl, contentFilter, pk])

  const { label: countdownLabel, ended } = formatPollCountdown(poll.endsAt, nowSec)
  const showResults = Boolean(results.myOptionId) || ended || results.totalVotes > 0

  const handleVote = async (optionId: string) => {
    if (ended || votingOptionId) return
    if (results.myOptionId === optionId) return
    setVotingOptionId(optionId)
    try {
      const ok = await agora.votePoll(poll, optionId)
      if (ok) {
        onPlaySound?.('click')
      } else {
        engine.pushToast('error', 'Vote failed', 'Could not publish poll vote to relays.')
      }
    } finally {
      setVotingOptionId(null)
    }
  }

  return (
    <article
      className={`ag-agora-poll-card${ended ? ' is-ended' : ''}`}
      aria-label={`Poll: ${poll.question}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="ag-agora-poll-header">
        <button
          type="button"
          className="ag-agora-poll-author-btn"
          onClick={() => onOpenProfile?.(pk)}
        >
          <img
            src={avatarBlobUrl || identicon}
            alt={displayName}
            className="ag-agora-avatar ag-agora-avatar-xs"
            loading="lazy"
          />
          <span className="ag-agora-poll-author-name truncate">{displayName}</span>
          {profile?.nip05 && nip05Status === 'verified' && (
            <BadgeCheck size={12} className="ag-agora-nip05-icon" aria-hidden="true" />
          )}
        </button>
        <span className="ag-agora-dot-sep">·</span>
        <span className="ag-agora-time tabular">{formatRelativeSeconds(poll.createdAt)}</span>
        <span className="ag-agora-poll-badge">
          <BarChart2 size={11} aria-hidden="true" />
          <span>Poll</span>
        </span>
      </div>

      <div className="ag-agora-poll-question">{poll.question}</div>

      <div className="ag-agora-poll-options" role="group" aria-label="Poll choices">
        {poll.options.map((opt) => {
          const count = results.countsByOption[opt.id] ?? 0
          const pct =
            results.totalVotes > 0 ? Math.round((count / results.totalVotes) * 100) : 0
          const isSelected = results.myOptionId === opt.id
          const isVotingThis = votingOptionId === opt.id
          return (
            <button
              key={opt.id}
              type="button"
              className={`ag-agora-poll-option-btn${isSelected ? ' is-selected' : ''}${showResults ? ' show-results' : ''}`}
              disabled={ended || Boolean(votingOptionId)}
              aria-pressed={isSelected}
              onClick={() => void handleVote(opt.id)}
            >
              {showResults && (
                <span
                  className="ag-agora-poll-bar-fill"
                  style={{ width: `${pct}%` }}
                  aria-hidden="true"
                />
              )}
              <span className="ag-agora-poll-option-label">
                {isVotingThis ? (
                  <Loader2 size={13} className="ag-agora-spin" aria-hidden="true" />
                ) : isSelected ? (
                  <Check size={13} className="ag-agora-poll-check" aria-hidden="true" />
                ) : null}
                <span>{opt.label}</span>
              </span>
              {showResults && (
                <span className="ag-agora-poll-option-stats tabular">
                  <span className="ag-agora-poll-pct">{pct}%</span>
                  <span className="ag-agora-poll-votes">({count})</span>
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="ag-agora-poll-footer">
        <span className="tabular">
          {results.totalVotes.toLocaleString()} {results.totalVotes === 1 ? 'vote' : 'votes'}
        </span>
        <span className="ag-agora-dot-sep">·</span>
        <span className="ag-agora-poll-countdown">
          <Clock size={11} aria-hidden="true" />
          <span>{countdownLabel}</span>
        </span>
      </div>
    </article>
  )
}

export default AgoraPollCard
