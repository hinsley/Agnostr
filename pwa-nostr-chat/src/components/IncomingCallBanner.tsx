import { useEffect, useMemo, useState } from 'react'
import { Lock, Phone, PhoneOff, Users, Video, Volume2, VolumeX } from 'lucide-react'
import type { IncomingCallOffer } from '../types/calls.ts'
import { pubkeyToColor } from '../utils/identicon.ts'
import { AvatarImg } from './AvatarImg.tsx'

export interface IncomingCallBannerProps {
  incoming: IncomingCallOffer
  callerAvatarUrl?: string
  mode?: 'dm' | 'server'
  isRinging?: boolean
  isRingMuted?: boolean
  isStandalonePwa?: boolean
  onMuteRing?: () => void
  onAcceptAudio: () => void
  onAcceptVideo: () => void
  onDecline: () => void
}

function readVerifiedCachedPicture(pubkey: string | undefined): string | undefined {
  if (!pubkey || typeof localStorage === 'undefined') return undefined
  const pk = pubkey.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(pk)) return undefined
  try {
    const raw = localStorage.getItem('agnostr:v2:agora_profiles')
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return undefined
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const entry = item as { pubkey?: unknown; picture?: unknown }
      if (typeof entry.pubkey === 'string' && entry.pubkey.toLowerCase() === pk) {
        if (typeof entry.picture === 'string' && /^https:\/\//i.test(entry.picture.trim())) {
          return entry.picture.trim()
        }
        return undefined
      }
    }
  } catch {
    // Ignore storage parse failures
  }
  return undefined
}

function useIsNarrowViewport(maxWidthPx = 640): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= maxWidthPx : false,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(`(max-width: ${maxWidthPx}px)`)
    const update = () => setNarrow(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [maxWidthPx])

  return narrow
}

export function IncomingCallBanner({
  incoming,
  callerAvatarUrl,
  mode = 'dm',
  isRinging = true,
  isRingMuted = false,
  isStandalonePwa = false,
  onMuteRing,
  onAcceptAudio,
  onAcceptVideo,
  onDecline,
}: IncomingCallBannerProps) {
  const isNarrow = useIsNarrowViewport(640)
  const callerColor = pubkeyToColor(incoming.callerPubkey)
  const resolvedCallerAvatarUrl = useMemo(
    () => callerAvatarUrl ?? readVerifiedCachedPicture(incoming.callerPubkey),
    [callerAvatarUrl, incoming.callerPubkey],
  )
  const isVideo = incoming.mediaType === 'video'
  const isDm = mode === 'dm'
  const isFullScreenTakeover = isDm && (isNarrow || isStandalonePwa)
  const animateRing = isRinging && !isRingMuted

  const callTypeLabel = isVideo ? 'Incoming Video Call' : 'Incoming Audio Call'
  const ringingSubtitle = isRingMuted
    ? `${callTypeLabel} · Muted`
    : `${callTypeLabel} · Ringing…`

  // Mobile (<= 640px) & Standalone PWA Full-Screen Incoming DM Call Screen
  if (isFullScreenTakeover) {
    return (
      <div
        className={`ag-incoming-fullscreen ${animateRing ? 'ringing' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-live="assertive"
        aria-labelledby="ag-incoming-caller"
      >
        <div className="ag-incoming-fs-inner">
          {/* Top Bar: Encryption Pill + Mute Ringer */}
          <div className="ag-incoming-fs-top">
            <span className="ag-incoming-fs-e2ee">
              <Lock size={12} />
              <span>End-to-end encrypted</span>
            </span>

            {onMuteRing && (
              <button
                type="button"
                className={`ag-incoming-mute-pill ${isRingMuted ? 'muted' : ''}`}
                onClick={onMuteRing}
                aria-pressed={isRingMuted}
                aria-label={isRingMuted ? 'Ringer muted' : 'Mute ringer'}
              >
                {isRingMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                <span>{isRingMuted ? 'Muted' : 'Mute Ringer'}</span>
              </button>
            )}
          </div>

          {/* Center Caller Hero with Pulsing Blue Sonar Halo */}
          <div className="ag-incoming-fs-hero">
            <div className="ag-incoming-fs-avatar-wrap">
              {animateRing && (
                <>
                  <span className="ag-incoming-fs-halo" aria-hidden="true" />
                  <span className="ag-incoming-fs-halo delay" aria-hidden="true" />
                </>
              )}
              <AvatarImg
                pubkey={incoming.callerPubkey}
                pictureUrl={resolvedCallerAvatarUrl}
                width={104}
                height={104}
                className="ag-incoming-fs-avatar"
              />
            </div>

            <div className="ag-incoming-fs-identity">
              <h2 id="ag-incoming-caller" className="ag-incoming-fs-name truncate">
                {incoming.callerNickname || incoming.callerDisplayHandle}
              </h2>
              <p
                className="ag-incoming-fs-handle truncate"
                style={{ color: callerColor }}
              >
                {incoming.callerDisplayHandle}
              </p>
              <p className="ag-incoming-fs-status">{ringingSubtitle}</p>
            </div>
          </div>

          {/* Bottom Tactile Answer / Decline Controls */}
          <div className="ag-incoming-fs-controls">
            {isVideo && (
              <button
                type="button"
                className="ag-incoming-fs-audio-only"
                onClick={onAcceptAudio}
              >
                <Phone size={15} />
                <span>Answer Audio Only</span>
              </button>
            )}

            <div className="ag-incoming-fs-btns">
              <div className="ag-incoming-fs-btn-col">
                <button
                  type="button"
                  className="ag-incoming-fs-round decline"
                  onClick={onDecline}
                  aria-label="Decline call"
                >
                  <PhoneOff size={26} />
                </button>
                <span className="ag-incoming-fs-btn-label">Decline</span>
              </div>

              <div className="ag-incoming-fs-btn-col">
                <button
                  type="button"
                  className="ag-incoming-fs-round answer"
                  onClick={isVideo ? onAcceptVideo : onAcceptAudio}
                  aria-label={isVideo ? 'Answer video call' : 'Answer audio call'}
                >
                  {isVideo ? <Video size={26} /> : <Phone size={26} />}
                </button>
                <span className="ag-incoming-fs-btn-label">Answer</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Desktop (> 640px) Elevated Top-Center Ringing Card (and Server Group Call Invite Card)
  return (
    <div
      className={`ag-incoming-call ${animateRing ? 'ringing' : ''}`}
      role="alertdialog"
      aria-live="assertive"
      aria-labelledby="ag-incoming-caller"
    >
      <div className="ag-incoming-top">
        <div className="ag-incoming-avatar-wrap">
          {animateRing && <span className="ag-incoming-ring" aria-hidden="true" />}
          <AvatarImg
            pubkey={incoming.callerPubkey}
            pictureUrl={resolvedCallerAvatarUrl}
            width={44}
            height={44}
            className="ag-incoming-avatar"
          />
        </div>

        <div className="ag-incoming-info">
          <div
            id="ag-incoming-caller"
            className="ag-incoming-handle truncate"
            style={{ color: callerColor }}
          >
            {incoming.callerDisplayHandle}
          </div>
          <div className="ag-incoming-subtitle truncate">
            {isDm ? ringingSubtitle : `Group Call · ${isVideo ? 'Video' : 'Voice'}`}
          </div>
          <div className="ag-incoming-badges">
            <span className="ag-badge ag-badge-accent">
              {isDm ? (
                isVideo ? (
                  <Video size={10} />
                ) : (
                  <Phone size={10} />
                )
              ) : (
                <Users size={10} />
              )}
              <span>{isDm ? (isVideo ? 'Video' : 'Audio') : 'Group'}</span>
            </span>
            {isDm && (
              <span className="ag-badge ag-badge-dm">
                <Lock size={10} />
                <span>E2EE</span>
              </span>
            )}
          </div>
        </div>

        {isDm && onMuteRing && (
          <button
            type="button"
            className={`ag-icon-btn-sm ag-incoming-mute-icon ${isRingMuted ? 'muted' : ''}`}
            onClick={onMuteRing}
            aria-pressed={isRingMuted}
            title={isRingMuted ? 'Ringer muted' : 'Mute ringer'}
            aria-label={isRingMuted ? 'Ringer muted' : 'Mute ringer'}
          >
            {isRingMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
        )}
      </div>

      <div className="ag-incoming-actions">
        <button
          type="button"
          className="ag-btn ag-incoming-decline"
          onClick={onDecline}
        >
          <PhoneOff size={14} />
          <span>Decline</span>
        </button>

        {isVideo ? (
          <>
            <button
              type="button"
              className="ag-btn ag-btn-secondary ag-incoming-audio-alt"
              onClick={onAcceptAudio}
              title="Answer with audio only"
            >
              <Phone size={14} />
              <span>Audio</span>
            </button>
            <button
              type="button"
              className="ag-btn ag-btn-primary ag-incoming-accept"
              onClick={onAcceptVideo}
            >
              <Video size={14} />
              <span>Answer</span>
            </button>
          </>
        ) : (
          <button
            type="button"
            className="ag-btn ag-btn-primary ag-incoming-accept"
            onClick={onAcceptAudio}
          >
            <Phone size={14} />
            <span>Answer</span>
          </button>
        )}
      </div>
    </div>
  )
}

export default IncomingCallBanner
