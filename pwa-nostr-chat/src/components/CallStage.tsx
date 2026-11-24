import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { nip19 } from 'nostr-tools'
import {
  AlertCircle,
  Bluetooth,
  Captions,
  Check,
  ChevronUp,
  Circle,
  Copy,
  Download,
  FileText,
  Hash,
  HeadphoneOff,
  Headphones,
  Link2,
  Loader2,
  Lock,
  Maximize2,
  MessageCircle,
  Mic,
  MicOff,
  Minimize2,
  MonitorOff,
  MonitorUp,
  PhoneCall,
  PhoneOff,
  Pin,
  PinOff,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Square,
  Trash2,
  User,
  Users,
  Video,
  VideoOff,
  Volume2,
  Waves,
  X,
} from 'lucide-react'
import type { AgnostrEngine, PeerInfo } from '../types/protocol.ts'
import type { CallEngine, CallParticipant, PeerIceConnectionState } from '../types/calls.ts'
import type { ContentFilterEngine } from '../types/contentFilter.ts'
import type { LiveCaptionEntry } from '../types/transcription.ts'
import {
  RECORDING_QUALITY_PRESETS,
  getRecordingQualitySpec,
} from '../lib/callRecorder.ts'
import { buildDmShareUrl } from '../lib/shareLinks.ts'
import { formatBitchatChannelLabel, isTopicChannel } from '../lib/bitchatChannel.ts'
import type { SoundCue } from '../utils/sound.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import { pubkeyToColor } from '../utils/identicon.ts'
import { AvatarImg } from './AvatarImg.tsx'
import { useContextMenu, type ContextMenuItem } from './ContextMenu.tsx'

export interface CallStageProps {
  calls: CallEngine
  engine: AgnostrEngine
  expanded: boolean
  compactFloating?: boolean
  onToggleExpand: () => void
  onPlaySound?: (cue: SoundCue) => void
  onInspectPeer?: (peer: PeerInfo) => void
  onOpenDm?: (pubkey: string, nickname?: string) => void
  onReturnToCall?: () => void
}

function formatCallDuration(startedAtMs: number, nowMs: number): string {
  const totalSec = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
  const hrs = Math.floor(totalSec / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

function formatRecordingBytes(bytes: number): string {
  const safe = Math.max(0, Number.isFinite(bytes) ? bytes : 0)
  if (safe < 1023.5 * 1024) {
    const kb = safe === 0 ? 0 : Math.max(1, Math.round(safe / 1024))
    return `${kb} KB`
  }
  if (safe < 1023.95 * 1024 * 1024) {
    return `${(safe / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(safe / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatCaptionClock(unixMs: number): string {
  try {
    return new Date(unixMs).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  } catch {
    return ''
  }
}

function formatTranscriptLine(entry: LiveCaptionEntry, startedAtMs: number): string {
  const who = entry.isSelf ? `${entry.displayHandle} (you)` : entry.displayHandle
  const wallClock = formatCaptionClock(entry.timestamp)
  const elapsed =
    startedAtMs > 0
      ? ` | +${formatCallDuration(startedAtMs, Math.max(startedAtMs, entry.timestamp))}`
      : ''
  const ts = wallClock ? `[${wallClock}${elapsed}] ` : ''
  return `${ts}${who}: ${entry.text}`
}

function iceLedClass(state: PeerIceConnectionState): string {
  if (state === 'connected' || state === 'completed') return 'ag-led-ok'
  if (state === 'checking' || state === 'new') return 'ag-led-warn ag-led-pulse'
  if (state === 'disconnected' || state === 'failed') return 'ag-led-danger'
  return 'ag-led-muted'
}

type AudioRouteKind = 'bluetooth' | 'headphones' | 'earpiece' | 'speaker'

function classifyAudioRoute(label: string): AudioRouteKind {
  const lower = label.toLowerCase()
  if (
    /bluetooth|airpods|buds|bose|beats|jabra|jbl|sony|wf-|wh-|hands-free|headset/.test(lower)
  ) {
    return 'bluetooth'
  }
  if (/earpiece|receiver|handset|phone speaker/.test(lower)) {
    return 'earpiece'
  }
  if (/headphone|earphone|earbud|usb audio|aux|wired|jack/.test(lower)) {
    return 'headphones'
  }
  return 'speaker'
}

function formatAudioDeviceLabel(
  device: MediaDeviceInfo,
  index: number,
  kind: 'audiooutput' | 'audioinput',
): string {
  const clean = device.label.trim()
  if (clean) return clean
  if (device.deviceId === 'default' || device.deviceId === '') {
    return kind === 'audiooutput' ? 'System Default' : 'Default Microphone'
  }
  if (device.deviceId === 'communications') {
    return kind === 'audiooutput' ? 'Communications Output' : 'Communications Mic'
  }
  return kind === 'audiooutput' ? `Audio Output ${index + 1}` : `Microphone ${index + 1}`
}

function renderAudioRouteIcon(route: AudioRouteKind, size: number, isInput = false) {
  if (route === 'bluetooth') return <Bluetooth size={size} />
  if (route === 'headphones') return <Headphones size={size} />
  if (route === 'earpiece') return <Smartphone size={size} />
  return isInput ? <Mic size={size} /> : <Volume2 size={size} />
}

function hasParticipantLiveVideo(participant: CallParticipant, shielded: boolean): boolean {
  if (shielded || !participant.stream || (!participant.videoEnabled && !participant.screenSharing)) {
    return false
  }
  return participant.stream.getVideoTracks().some((t) => t.readyState === 'live')
}

/**
 * Persistent remote audio sink so audio playback never interrupts when switching
 * between docked, full-screen expanded, and compact floating call bar modes.
 * Hardened for iOS Safari / Android PWA async remote-track arrival, autoplay unlock,
 * and live setSinkId() output device routing (speakerphone / earpiece / Bluetooth).
 */
function RemoteAudioTrack({
  stream,
  deafened,
  sinkId,
}: {
  stream: MediaStream | null
  deafened: boolean
  sinkId?: string
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const liveAudioTrack =
    stream?.getAudioTracks().find((t) => t.readyState === 'live') ?? null
  const audioTrackId = liveAudioTrack?.id ?? null

  useEffect(() => {
    const el = audioRef.current
    if (!el) return

    let cancelled = false
    let unlockListener: (() => void) | null = null

    const cleanupUnlock = () => {
      if (!unlockListener) return
      window.removeEventListener('pointerdown', unlockListener, true)
      window.removeEventListener('touchend', unlockListener, true)
      window.removeEventListener('click', unlockListener, true)
      unlockListener = null
    }

    const attemptPlay = () => {
      if (cancelled || el.muted || !el.srcObject) return
      const playResult = el.play()
      if (!playResult || typeof playResult.then !== 'function') return
      playResult
        .then(() => {
          cleanupUnlock()
        })
        .catch(() => {
          // iOS Safari / Android PWA may reject async remote audio with NotAllowedError;
          // retry synchronously on the next user gesture anywhere in the window.
          if (cancelled || unlockListener) return
          unlockListener = () => {
            cleanupUnlock()
            attemptPlay()
          }
          window.addEventListener('pointerdown', unlockListener, {
            capture: true,
            once: true,
          })
          window.addEventListener('touchend', unlockListener, {
            capture: true,
            once: true,
          })
          window.addEventListener('click', unlockListener, {
            capture: true,
            once: true,
          })
        })
    }

    const syncAudioSource = () => {
      const activeTrack =
        stream?.getAudioTracks().find((t) => t.readyState === 'live') ?? null
      const activeId = activeTrack?.id ?? null

      if (!stream || !activeId) {
        if (el.srcObject) {
          el.srcObject = null
        }
        cleanupUnlock()
        return
      }

      const currentSrc = el.srcObject
      const alreadyAttached =
        currentSrc instanceof MediaStream &&
        currentSrc
          .getAudioTracks()
          .some((t) => t.id === activeId && t.readyState === 'live')

      // Do not reset srcObject when only a peer video track changes
      if (!alreadyAttached) {
        el.srcObject = stream
      }

      el.muted = deafened
      if (!deafened && (!alreadyAttached || el.paused)) {
        attemptPlay()
      }
    }

    el.muted = deafened
    if (deafened) {
      cleanupUnlock()
    }
    syncAudioSource()

    const handleTrackAdded = (ev: MediaStreamTrackEvent) => {
      if (ev.track.kind === 'audio') {
        syncAudioSource()
      }
    }

    const handleTrackUnmute = () => {
      if (!deafened && el.paused) {
        attemptPlay()
      }
    }

    stream?.addEventListener('addtrack', handleTrackAdded)
    liveAudioTrack?.addEventListener('unmute', handleTrackUnmute)

    return () => {
      cancelled = true
      cleanupUnlock()
      stream?.removeEventListener('addtrack', handleTrackAdded)
      liveAudioTrack?.removeEventListener('unmute', handleTrackUnmute)
    }
  }, [stream, audioTrackId, liveAudioTrack, deafened])

  useEffect(() => {
    const el = audioRef.current as
      | (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> })
      | null
    if (!el || typeof el.setSinkId !== 'function') return
    el.setSinkId(sinkId || '').catch(() => {
      // Browser may reject unavailable/unpermitted sinkId; keep default route silently
    })
  }, [sinkId, audioTrackId])

  return <audio ref={audioRef} autoPlay playsInline className="sr-only" />
}

function safeEncodeNpub(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey)
  } catch {
    return pubkey
  }
}

function ParticipantTile({
  participant,
  avatarUrl,
  compact,
  shielded,
  screenVideo = false,
  contentFilter,
  isPinned = false,
  stripMode = false,
  onTogglePin,
  onTrustPeer,
  onContextMenu,
}: {
  participant: CallParticipant
  avatarUrl?: string
  compact: boolean
  shielded: boolean
  screenVideo?: boolean
  contentFilter?: ContentFilterEngine
  isPinned?: boolean
  stripMode?: boolean
  onTogglePin?: () => void
  onTrustPeer?: () => void
  onContextMenu?: (e: ReactMouseEvent) => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null)
  const lastTouchToggleAtRef = useRef<number>(0)
  const screenInFlightRef = useRef(false)
  const screenSeqRef = useRef(0)
  const [videoScreenStatus, setVideoScreenStatus] = useState<'screening' | 'safe' | 'flagged'>(
    'screening',
  )
  const [videoFlagDetail, setVideoFlagDetail] = useState('')

  const liveVideoTrack =
    !shielded && participant.stream && (participant.videoEnabled || participant.screenSharing)
      ? (participant.stream.getVideoTracks().find((t) => t.readyState === 'live') ?? null)
      : null
  const liveVideoTrackId = liveVideoTrack?.id ?? null
  const hasLiveVideo = !shielded && liveVideoTrack !== null

  useEffect(() => {
    const el = videoRef.current
    if (!el) return

    let cancelled = false
    let unlockListener: (() => void) | null = null

    const cleanupUnlock = () => {
      if (!unlockListener) return
      window.removeEventListener('pointerdown', unlockListener, true)
      window.removeEventListener('touchend', unlockListener, true)
      window.removeEventListener('click', unlockListener, true)
      unlockListener = null
    }

    if (shielded) {
      if (el.srcObject) {
        el.srcObject = null
      }
      return
    }

    const attemptPlay = () => {
      if (cancelled || !el.srcObject) return
      el.muted = true
      el.playsInline = true
      const playResult = el.play()
      if (!playResult || typeof playResult.then !== 'function') return
      playResult
        .then(() => {
          cleanupUnlock()
        })
        .catch(() => {
          if (cancelled || unlockListener) return
          unlockListener = () => {
            cleanupUnlock()
            attemptPlay()
          }
          window.addEventListener('pointerdown', unlockListener, {
            capture: true,
            once: true,
          })
          window.addEventListener('touchend', unlockListener, {
            capture: true,
            once: true,
          })
          window.addEventListener('click', unlockListener, {
            capture: true,
            once: true,
          })
        })
    }

    if (hasLiveVideo && participant.stream && liveVideoTrackId) {
      const currentSrc = el.srcObject
      const alreadyAttached =
        currentSrc instanceof MediaStream &&
        currentSrc
          .getVideoTracks()
          .some((t) => t.id === liveVideoTrackId && t.readyState === 'live')

      if (!alreadyAttached) {
        el.srcObject = participant.stream
      }
      if (!alreadyAttached || el.paused) {
        attemptPlay()
      }
    } else if (el.srcObject) {
      el.srcObject = null
      cleanupUnlock()
    }

    const handleTrackUnmute = () => {
      if (el.paused) {
        attemptPlay()
      }
    }

    liveVideoTrack?.addEventListener('unmute', handleTrackUnmute)

    return () => {
      cancelled = true
      cleanupUnlock()
      liveVideoTrack?.removeEventListener('unmute', handleTrackUnmute)
    }
  }, [shielded, hasLiveVideo, participant.stream, liveVideoTrackId, liveVideoTrack])

  // Periodic offscreen frame screening via on-device Safety Filter when user opted into video screening
  useEffect(() => {
    if (!screenVideo || !hasLiveVideo || !contentFilter || shielded) {
      setVideoScreenStatus('screening')
      setVideoFlagDetail('')
      return
    }

    let cancelled = false
    setVideoScreenStatus('screening')
    setVideoFlagDetail('')

    const sampleAndScreen = async () => {
      if (cancelled || screenInFlightRef.current) return
      const el = videoRef.current
      if (!el || el.readyState < 2 || el.videoWidth <= 0 || el.videoHeight <= 0) return

      const maxDim = 384
      const scale = Math.min(1, maxDim / Math.max(el.videoWidth, el.videoHeight))
      const w = Math.max(32, Math.round(el.videoWidth * scale))
      const h = Math.max(32, Math.round(el.videoHeight * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(el, 0, 0, w, h)

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.78)
      })
      if (!blob || cancelled) return

      screenInFlightRef.current = true
      try {
        const seq = ++screenSeqRef.current
        const verdict = await contentFilter.screenImageBlob(
          `call-frame:${participant.pubkey}:${seq}`,
          blob,
          { skipCache: true },
        )
        if (cancelled) return
        if (verdict.flagged) {
          const cats =
            verdict.categories.length > 0
              ? verdict.categories
                  .map((c) => (c === 'nsfw' ? 'NSFW' : c === 'illegal' ? 'Illegal' : 'Custom'))
                  .join(', ')
              : verdict.reason || 'Policy'
          setVideoFlagDetail(cats)
          setVideoScreenStatus('flagged')
        } else if (verdict.safe) {
          setVideoFlagDetail('')
          setVideoScreenStatus('safe')
        }
      } catch {
        // Keep veiled until a frame passes screening
      } finally {
        screenInFlightRef.current = false
      }
    }

    const el = videoRef.current
    const onFrameReady = () => {
      void sampleAndScreen()
    }
    el?.addEventListener('loadeddata', onFrameReady)
    el?.addEventListener('playing', onFrameReady)

    const initialTimer = window.setTimeout(() => {
      void sampleAndScreen()
    }, 600)
    const intervalId = window.setInterval(() => {
      void sampleAndScreen()
    }, 4500)

    return () => {
      cancelled = true
      window.clearTimeout(initialTimer)
      window.clearInterval(intervalId)
      el?.removeEventListener('loadeddata', onFrameReady)
      el?.removeEventListener('playing', onFrameReady)
    }
  }, [screenVideo, hasLiveVideo, liveVideoTrackId, contentFilter, shielded, participant.pubkey])

  const handleColor = pubkeyToColor(participant.pubkey)

  if (shielded) {
    return (
      <div
        className={`ag-call-tile is-shielded ${compact || stripMode ? 'is-compact' : ''} ${
          stripMode ? 'is-strip' : ''
        }`}
        onContextMenu={onContextMenu}
      >
        <div className="ag-call-shield-body">
          <div className="ag-call-shield-avatar-wrap">
            <AvatarImg
              pubkey={participant.pubkey}
              pictureUrl={avatarUrl}
              width={compact || stripMode ? 30 : 40}
              height={compact || stripMode ? 30 : 40}
              className="ag-call-shield-avatar"
            />
            <span className="ag-call-shield-icon-badge" aria-hidden="true">
              <ShieldAlert size={compact || stripMode ? 11 : 13} />
            </span>
          </div>
          <span className="ag-call-shield-name truncate" style={{ color: handleColor }}>
            {participant.displayHandle}
          </span>
          <span className="ag-call-shield-caption">Untrusted · Camera &amp; audio hidden</span>
          {onTrustPeer && (
            <button
              type="button"
              className="ag-call-shield-trust-btn"
              onClick={(e) => {
                e.stopPropagation()
                onTrustPeer()
              }}
              title={`Trust ${participant.displayHandle} to connect audio and camera`}
              aria-label={`Trust ${participant.displayHandle}`}
            >
              <ShieldCheck size={13} />
              <span>Trust</span>
            </button>
          )}
        </div>
      </div>
    )
  }

  const avatarSize = stripMode ? 34 : compact ? 44 : 60
  const levelScale = 1 + Math.min(0.32, participant.audioLevel * 0.45)
  const isVideoVeiled = screenVideo && hasLiveVideo && videoScreenStatus !== 'safe'
  const canPinVideo = hasLiveVideo && !isVideoVeiled && Boolean(onTogglePin)

  const handleTileDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!canPinVideo || !onTogglePin) return
    if ((e.target as HTMLElement | null)?.closest('button')) return
    if (Date.now() - lastTouchToggleAtRef.current < 450) return
    e.preventDefault()
    onTogglePin()
  }

  const handleTileTouchEnd = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (!canPinVideo || !onTogglePin) return
    if (e.changedTouches.length !== 1) {
      lastTapRef.current = null
      return
    }
    if ((e.target as HTMLElement | null)?.closest('button')) return
    const touch = e.changedTouches[0]
    const now = Date.now()
    const prev = lastTapRef.current
    if (
      prev &&
      now - prev.time < 320 &&
      Math.hypot(touch.clientX - prev.x, touch.clientY - prev.y) < 28
    ) {
      e.preventDefault()
      lastTapRef.current = null
      lastTouchToggleAtRef.current = now
      onTogglePin()
    } else {
      lastTapRef.current = { time: now, x: touch.clientX, y: touch.clientY }
    }
  }

  return (
    <div
      className={`ag-call-tile ${participant.isSpeaking ? 'speaking' : ''} ${
        hasLiveVideo ? 'has-video' : 'audio-only'
      } ${participant.screenSharing ? 'is-screen' : ''} ${
        participant.isRecording ? 'is-recording' : ''
      } ${isPinned ? 'is-pinned' : ''} ${stripMode ? 'is-strip' : ''} ${
        canPinVideo ? 'is-pinnable' : ''
      }`}
      onContextMenu={onContextMenu}
      onDoubleClick={handleTileDoubleClick}
      onTouchEnd={handleTileTouchEnd}
      title={
        canPinVideo
          ? isPinned
            ? 'Double-click or double-tap to unpin video'
            : 'Double-click or double-tap to pin video solo'
          : undefined
      }
    >
      {hasLiveVideo ? (
        <>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`ag-call-video ${
              participant.isSelf && !participant.screenSharing ? 'mirrored' : ''
            } ${participant.screenSharing || isPinned ? 'contain' : ''} ${
              isVideoVeiled ? 'is-veiled' : ''
            }`}
          />
          {isVideoVeiled && (
            <div
              className={`ag-call-video-veil ${videoScreenStatus === 'flagged' ? 'flagged' : ''}`}
              role="status"
              aria-live="polite"
            >
              {videoScreenStatus === 'flagged' ? (
                <>
                  <span className="ag-call-veil-icon flagged" aria-hidden="true">
                    <ShieldAlert size={20} />
                  </span>
                  <span className="ag-call-veil-title">
                    Video blocked by Safety Filter · Flagged
                  </span>
                  {videoFlagDetail && (
                    <span className="ag-call-veil-sub">{videoFlagDetail}</span>
                  )}
                </>
              ) : (
                <>
                  <span className="ag-call-veil-icon" aria-hidden="true">
                    <Loader2 size={18} className="ag-spin" />
                  </span>
                  <span className="ag-call-veil-title">
                    {contentFilter?.modelStatus === 'downloading'
                      ? `Downloading Safety Filter · ${Math.round(contentFilter.downloadProgress)}%`
                      : 'Screening video…'}
                  </span>
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="ag-call-avatar-stage">
          <div className="ag-call-avatar-wrap">
            {participant.isSpeaking && (
              <span
                className="ag-call-vad-halo"
                style={{ transform: `scale(${levelScale})` }}
                aria-hidden="true"
              />
            )}
            <AvatarImg
              pubkey={participant.pubkey}
              pictureUrl={avatarUrl}
              width={avatarSize}
              height={avatarSize}
              className="ag-call-avatar"
            />
          </div>
        </div>
      )}

      {/* Top-left telemetry / Pinned Stage banner */}
      {(isPinned || (screenVideo && hasLiveVideo && videoScreenStatus === 'safe') || participant.screenSharing || !participant.isSelf) && (
        <div className="ag-call-tile-top ag-call-tile-net">
          {isPinned && (
            <span className="ag-call-pinned-pill">
              <Pin size={10} />
              <span>Pinned · Double-tap to unpin</span>
            </span>
          )}
          {screenVideo && hasLiveVideo && videoScreenStatus === 'safe' && (
            <span
              className="ag-call-micro-pill ag-call-pill-screened mono"
              title="Video screened safe on-device by Safety Filter"
            >
              <ShieldCheck size={10} />
              <span>Screened</span>
            </span>
          )}
          {participant.screenSharing && (
            <span className="ag-call-micro-pill ag-call-pill-screen mono">SCREEN</span>
          )}
          {!participant.isSelf && (
            <span
              className="ag-call-micro-pill mono"
              title={`ICE: ${participant.iceState}${participant.rttMs !== null ? ` · ${Math.round(participant.rttMs)}ms` : ''}`}
            >
              <span className={`ag-led ${iceLedClass(participant.iceState)}`} />
              {participant.rttMs !== null ? `${Math.round(participant.rttMs)}ms` : participant.iceState}
            </span>
          )}
        </div>
      )}

      {/* Top-right 1-click Unpin button when pinned */}
      {isPinned && onTogglePin && (
        <button
          type="button"
          className="ag-call-unpin-btn"
          onClick={(e) => {
            e.stopPropagation()
            onTogglePin()
          }}
          title="Unpin video"
          aria-label="Unpin video"
        >
          <X size={13} />
        </button>
      )}

      {/* Top-right pulsing crimson recording dot */}
      {participant.isRecording && (
        <span
          className={`ag-call-rec-dot ${isPinned ? 'with-unpin' : ''}`}
          role="status"
          title={`${participant.displayHandle} is recording this call`}
          aria-label="Recording"
        />
      )}

      {/* Bottom-left identity pill */}
      <div className="ag-call-tile-bottom">
        <span className="ag-call-name-pill">
          <span className="ag-call-name truncate" style={{ color: handleColor }}>
            {participant.displayHandle}
          </span>
          {participant.isSelf && <span className="ag-call-you mono">YOU</span>}
          {participant.audioMuted && (
            <span className="ag-call-muted-icon" title="Muted" aria-label="Muted">
              <MicOff size={11} />
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

export function CallStage({
  calls,
  engine,
  expanded,
  compactFloating = false,
  onToggleExpand,
  onPlaySound,
  onInspectPeer,
  onOpenDm,
  onReturnToCall,
}: CallStageProps) {
  const { activeCall } = calls
  const { transcription, contentFilter } = engine
  const { openContextMenu } = useContextMenu()
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [togglingRec, setTogglingRec] = useState(false)
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false)
  const [audioMenuOpen, setAudioMenuOpen] = useState(false)
  const [switchingAudioInput, setSwitchingAudioInput] = useState(false)
  const [pinnedVideoPubkey, setPinnedVideoPubkey] = useState<string | null>(null)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [copiedTranscript, setCopiedTranscript] = useState(false)
  const [promptCopied, setPromptCopied] = useState(false)
  const [promptSaved, setPromptSaved] = useState(false)
  const qualityWrapRef = useRef<HTMLDivElement | null>(null)
  const audioWrapRef = useRef<HTMLDivElement | null>(null)
  const transcriptListRef = useRef<HTMLDivElement | null>(null)
  const promptDismissTimerRef = useRef<number | null>(null)
  const promptCopyTimerRef = useRef<number | null>(null)
  const endedTranscript = transcription.endedCallTranscript
  const endedTranscriptId = endedTranscript?.id ?? null

  // Prefetch verified kind: 0 profile pictures for all active call participants
  const callParticipantPubkeysKey = useMemo(() => {
    if (!activeCall) return ''
    const set = new Set<string>()
    for (const p of activeCall.participants) {
      const pk = p.pubkey.trim().toLowerCase()
      if (/^[0-9a-f]{64}$/.test(pk)) set.add(pk)
    }
    return Array.from(set).sort().join(',')
  }, [activeCall])

  const ensureProfilePictures = engine.ensureProfilePictures
  useEffect(() => {
    if (!callParticipantPubkeysKey) return
    ensureProfilePictures(callParticipantPubkeysKey.split(','))
  }, [callParticipantPubkeysKey, ensureProfilePictures])

  useEffect(() => {
    setPromptCopied(false)
    setPromptSaved(false)
    return () => {
      if (promptDismissTimerRef.current !== null) {
        window.clearTimeout(promptDismissTimerRef.current)
        promptDismissTimerRef.current = null
      }
      if (promptCopyTimerRef.current !== null) {
        window.clearTimeout(promptCopyTimerRef.current)
        promptCopyTimerRef.current = null
      }
    }
  }, [endedTranscriptId])

  useEffect(() => {
    if (activeCall || !endedTranscript) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        transcription.dismissEndedCallTranscript()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeCall, endedTranscript, transcription])

  useEffect(() => {
    if (!activeCall) {
      setAudioMenuOpen(false)
      setPinnedVideoPubkey(null)
      return
    }
    setNowMs(Date.now())
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [activeCall])

  // Auto-clear pinned solo video if participant leaves, stops video, or becomes untrusted/shielded
  useEffect(() => {
    if (!pinnedVideoPubkey || !activeCall) return
    const target = activeCall.participants.find((p) => p.pubkey === pinnedVideoPubkey)
    if (!target) {
      setPinnedVideoPubkey(null)
      return
    }
    const shielded =
      !target.isSelf &&
      !contentFilter.shouldAllowScreenedCallVideo(target.pubkey, false) &&
      (Boolean(target.isUntrusted) || !engine.isTrusted(target.pubkey))
    if (!hasParticipantLiveVideo(target, shielded)) {
      setPinnedVideoPubkey(null)
    }
  }, [pinnedVideoPubkey, activeCall, engine, contentFilter])

  useEffect(() => {
    if (!transcriptOpen) return
    const el = transcriptListRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [transcriptOpen, transcription.liveCaptions.length])

  const isQualityPopoverVisible =
    qualityMenuOpen && Boolean(activeCall) && !activeCall?.localRecording
  const isAudioPopoverVisible = audioMenuOpen && Boolean(activeCall)

  // Android / PWA Back button closes CallStage overlays (LIFO: audio -> quality -> pinned -> transcript)
  useBackHandler(Boolean(activeCall) && transcriptOpen, () => setTranscriptOpen(false))
  useBackHandler(Boolean(activeCall) && Boolean(pinnedVideoPubkey), () => setPinnedVideoPubkey(null))
  useBackHandler(isQualityPopoverVisible, () => setQualityMenuOpen(false))
  useBackHandler(isAudioPopoverVisible, () => setAudioMenuOpen(false))

  useEffect(() => {
    if (!isQualityPopoverVisible) return
    const onPointerDown = (e: PointerEvent) => {
      if (qualityWrapRef.current && !qualityWrapRef.current.contains(e.target as Node)) {
        setQualityMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [isQualityPopoverVisible])

  useEffect(() => {
    if (!isAudioPopoverVisible) return
    const onPointerDown = (e: PointerEvent) => {
      if (audioWrapRef.current && !audioWrapRef.current.contains(e.target as Node)) {
        setAudioMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [isAudioPopoverVisible])

  useEffect(() => {
    if (
      !activeCall ||
      (!expanded &&
        !isAudioPopoverVisible &&
        !isQualityPopoverVisible &&
        !pinnedVideoPubkey &&
        !transcriptOpen)
    ) {
      return
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (isAudioPopoverVisible) {
          setAudioMenuOpen(false)
        } else if (isQualityPopoverVisible) {
          setQualityMenuOpen(false)
        } else if (pinnedVideoPubkey) {
          setPinnedVideoPubkey(null)
        } else if (transcriptOpen) {
          setTranscriptOpen(false)
        } else if (expanded) {
          onToggleExpand()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    expanded,
    activeCall,
    isAudioPopoverVisible,
    isQualityPopoverVisible,
    pinnedVideoPubkey,
    transcriptOpen,
    onToggleExpand,
  ])

  if (!activeCall) {
    if (!endedTranscript) return null

    const lineCount = endedTranscript.entries.length

    const handlePromptSave = () => {
      if (promptSaved) return
      transcription.downloadEndedCallTranscript()
      onPlaySound?.('click')
      setPromptSaved(true)
      if (promptDismissTimerRef.current !== null) {
        window.clearTimeout(promptDismissTimerRef.current)
      }
      promptDismissTimerRef.current = window.setTimeout(() => {
        promptDismissTimerRef.current = null
        transcription.dismissEndedCallTranscript()
      }, 1100)
    }

    const handlePromptCopy = async () => {
      if (!endedTranscript.plainText.trim()) return
      try {
        await navigator.clipboard.writeText(endedTranscript.plainText)
        onPlaySound?.('click')
        setPromptCopied(true)
        engine.pushToast('success', 'Copied timestamped transcript')
        if (promptCopyTimerRef.current !== null) {
          window.clearTimeout(promptCopyTimerRef.current)
        }
        promptCopyTimerRef.current = window.setTimeout(() => {
          promptCopyTimerRef.current = null
          setPromptCopied(false)
        }, 1800)
      } catch {
        engine.pushToast('error', 'Failed to copy transcript')
      }
    }

    const handlePromptDismiss = () => {
      if (promptDismissTimerRef.current !== null) {
        window.clearTimeout(promptDismissTimerRef.current)
        promptDismissTimerRef.current = null
      }
      onPlaySound?.('click')
      transcription.dismissEndedCallTranscript()
    }

    return createPortal(
      <aside
        className="ag-transcript-save-prompt"
        role="status"
        aria-live="polite"
        aria-label="Save call transcript"
      >
        <div className="ag-transcript-prompt-top">
          <span className="ag-transcript-prompt-icon" aria-hidden="true">
            <Captions size={15} />
          </span>
          <div className="ag-transcript-prompt-copy">
            <span className="ag-transcript-prompt-title">Save call transcript?</span>
            <span className="ag-transcript-prompt-sub truncate">
              {lineCount} {lineCount === 1 ? 'line' : 'lines'} · {endedTranscript.callTitle}
            </span>
          </div>
          <button
            type="button"
            className="ag-transcript-prompt-dismiss"
            onClick={handlePromptDismiss}
            title="Dismiss"
            aria-label="Dismiss transcript prompt"
          >
            <X size={14} />
          </button>
        </div>

        <div className="ag-transcript-prompt-actions">
          <button
            type="button"
            className={`ag-transcript-prompt-btn primary ${promptSaved ? 'is-done' : ''}`}
            onClick={handlePromptSave}
          >
            {promptSaved ? <Check size={13} /> : <Download size={13} />}
            <span>{promptSaved ? 'Saved' : 'Save .md'}</span>
          </button>
          <button
            type="button"
            className="ag-transcript-prompt-btn"
            onClick={() => void handlePromptCopy()}
          >
            {promptCopied ? <Check size={13} /> : <Copy size={13} />}
            <span>{promptCopied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </aside>,
      document.body,
    )
  }

  const isParticipantShielded = (p: CallParticipant) => {
    if (p.isSelf) return false
    if (contentFilter.shouldAllowScreenedCallVideo(p.pubkey, false)) return false
    return Boolean(p.isUntrusted) || !engine.isTrusted(p.pubkey)
  }

  const remoteParticipants = activeCall.participants.filter((p) => !p.isSelf)
  const trustedRemoteParticipants = remoteParticipants.filter((p) => !isParticipantShielded(p))
  const activeSpeaker =
    activeCall.participants.find((p) => p.isSpeaking && !isParticipantShielded(p)) ?? null
  const count = Math.max(1, Math.min(activeCall.maxParticipants, activeCall.participants.length))

  const recorders = activeCall.participants.filter((p) => p.isRecording)
  const remoteRecorders = recorders.filter((p) => !p.isSelf)
  const isAnyRecording = activeCall.localRecording || recorders.length > 0
  const recTimer =
    activeCall.localRecording && activeCall.localRecordingStartedAt
      ? formatCallDuration(activeCall.localRecordingStartedAt, nowMs)
      : null

  const recSize = activeCall.localRecording
    ? formatRecordingBytes(activeCall.localRecordingBytes)
    : null

  let recPillLabel: string | null = null
  let recPillTitle = ''
  if (isAnyRecording) {
    if (activeCall.localRecording && remoteRecorders.length === 0) {
      recPillLabel = `REC · ${recTimer ?? '00:00'} · ${recSize ?? '0 KB'}`
      recPillTitle = `You are recording this call (${recSize ?? '0 KB'}${activeCall.localRecordingMode ? `, ${activeCall.localRecordingMode}` : ''})`
    } else if (activeCall.localRecording && remoteRecorders.length > 0) {
      recPillLabel = `REC · ${recTimer ?? '00:00'} · ${recSize ?? '0 KB'} · +${remoteRecorders.length}`
      recPillTitle = `You (${recSize ?? '0 KB'}) and ${remoteRecorders.map((p) => p.displayHandle).join(', ')} are recording this call`
    } else if (remoteRecorders.length === 1) {
      const peer = remoteRecorders[0]
      const shortName = peer.nickname ? `@${peer.nickname}` : peer.displayHandle
      recPillLabel = `REC · ${shortName}`
      recPillTitle = `${peer.displayHandle} is recording this call`
    } else {
      recPillLabel = `REC · ${remoteRecorders.length} recording`
      recPillTitle = `${remoteRecorders.map((p) => p.displayHandle).join(', ')} are recording this call`
    }
  }

  const isOutgoingRinging =
    calls.isOutgoingDmRinging || activeCall.status === 'ringing-out'

  const statusText =
    isOutgoingRinging
      ? 'Ringing…'
      : activeCall.status === 'connecting'
        ? 'Connecting…'
        : formatCallDuration(activeCall.connectedAt ?? activeCall.startedAt, nowMs)

  const handleToggleMute = () => {
    onPlaySound?.('click')
    calls.toggleMute()
  }

  const handleToggleDeafen = () => {
    onPlaySound?.('click')
    calls.toggleDeafen()
  }

  const handleToggleCamera = () => {
    onPlaySound?.('click')
    void calls.toggleCamera()
  }

  const handleToggleScreen = () => {
    onPlaySound?.('click')
    void calls.toggleScreenShare()
  }

  const effectiveQuality = activeCall.localRecording
    ? (activeCall.localRecordingQuality ?? calls.recordingQuality)
    : calls.recordingQuality
  const activeQualitySpec = getRecordingQualitySpec(effectiveQuality)

  const handleToggleRecording = async () => {
    if (!activeCall.recordingSupported || togglingRec) return
    setQualityMenuOpen(false)
    setTogglingRec(true)
    try {
      await calls.toggleRecording()
    } finally {
      setTogglingRec(false)
    }
  }

  const handleLeave = () => {
    onPlaySound?.('call-leave')
    calls.leaveCall()
  }

  const audioSinks = (
    <div className="sr-only" aria-hidden="true">
      {trustedRemoteParticipants.map((p) => (
        <RemoteAudioTrack
          key={p.pubkey}
          stream={p.stream}
          deafened={activeCall.localDeafened}
          sinkId={calls.selectedAudioOutputId}
        />
      ))}
    </div>
  )

  const recBadge = recPillLabel ? (
    <span className="ag-call-rec-pill mono" role="status" title={recPillTitle}>
      <span className="ag-call-rec-pill-dot" aria-hidden="true" />
      <span className="truncate">{recPillLabel}</span>
    </span>
  ) : null

  const isGeoCall = activeCall.mode === 'geo'
  const isTopicCall = isGeoCall && isTopicChannel(activeCall.geohash ?? '')
  const isGroupCall = activeCall.mode === 'server' || isGeoCall
  const geoTag = activeCall.geohash ? formatBitchatChannelLabel(activeCall.geohash) : null

  const handleReturnToCall = () => {
    onPlaySound?.('click')
    if (onReturnToCall) {
      onReturnToCall()
      return
    }
    if (isGeoCall && activeCall.geohash) {
      engine.tuneGeohash(activeCall.geohash)
    } else {
      onToggleExpand()
    }
  }

  // Compact Floating Bar when user is browsing another channel/server
  if (compactFloating && !expanded) {
    return (
      <>
        {audioSinks}
        <div
          className={`ag-call-floating-bar ${activeSpeaker ? 'has-speaker' : ''} ${
            isAnyRecording ? 'is-recording' : ''
          }`}
          role="region"
          aria-label={`Active call: ${activeCall.title}`}
        >
          <div className="ag-call-float-left">
            <span
              className={`ag-led ${
                activeCall.status === 'active'
                  ? 'ag-led-ok ag-led-pulse'
                  : 'ag-led-warn ag-led-pulse'
              }`}
            />
            {isGeoCall ? (
              <button
                type="button"
                className="ag-call-float-return"
                onClick={handleReturnToCall}
                title={`Return to ${geoTag ?? activeCall.title}`}
              >
                <span className="ag-badge ag-badge-accent mono">
                  {isTopicCall ? <Hash size={9} /> : <Waves size={9} />}
                  <span>{geoTag ?? activeCall.title}</span>
                </span>
                <span className="ag-badge ag-badge-muted ag-hide-xs">
                  {isTopicCall ? 'Topic Bitchat · P2P' : 'Public Bitchat · P2P'}
                </span>
              </button>
            ) : (
              <>
                <span
                  className={`ag-call-float-title truncate ${onReturnToCall ? 'clickable' : ''}`}
                  onClick={onReturnToCall ? handleReturnToCall : undefined}
                >
                  {activeCall.title}
                </span>
                {activeCall.encrypted && (
                  <span className="ag-badge ag-badge-dm ag-hide-xs">
                    <Lock size={9} />
                    <span>E2EE P2P</span>
                  </span>
                )}
              </>
            )}
            {isOutgoingRinging ? (
              <span className="ag-call-ringing-pill" role="status">
                <PhoneCall size={11} className="ag-call-ringing-icon" />
                <span>Ringing…</span>
              </span>
            ) : (
              <span className="ag-call-float-meta mono">
                {count}/{activeCall.maxParticipants} · {statusText}
              </span>
            )}
            {recBadge}
            {transcription.liveCaptionsEnabled && (
              <span className="ag-badge ag-badge-accent mono ag-hide-xs" title="Live captions active">
                <Captions size={10} />
                <span>CC</span>
              </span>
            )}
            {activeSpeaker && (
              <span className="ag-call-float-speaker truncate ag-hide-xs">
                <Waves size={10} />
                <span>{activeSpeaker.displayHandle}</span>
              </span>
            )}
          </div>

          <div className="ag-call-float-actions">
            <button
              type="button"
              className={`ag-call-float-btn ${activeCall.localMuted ? 'danger' : ''}`}
              onClick={handleToggleMute}
              title={activeCall.localMuted ? 'Unmute mic' : 'Mute mic'}
              aria-label={activeCall.localMuted ? 'Unmute mic' : 'Mute mic'}
              aria-pressed={activeCall.localMuted}
            >
              {activeCall.localMuted ? <MicOff size={14} /> : <Mic size={14} />}
            </button>
            <button
              type="button"
              className="ag-call-float-btn"
              onClick={() => {
                onPlaySound?.('click')
                onToggleExpand()
              }}
              title="Expand call stage"
              aria-label="Expand call stage"
            >
              <Maximize2 size={14} />
            </button>
            <button
              type="button"
              className="ag-call-float-btn hangup"
              onClick={handleLeave}
              title={isGroupCall ? 'Leave call' : 'Hang up'}
              aria-label={isGroupCall ? 'Leave call' : 'Hang up call'}
            >
              <PhoneOff size={14} />
            </button>
          </div>
        </div>
      </>
    )
  }

  const showTranscriptTrigger =
    transcription.liveCaptionsEnabled || transcription.liveCaptions.length > 0
  const recentCaptions = transcription.liveCaptionsEnabled
    ? transcription.liveCaptions.slice(-3).filter((entry) => nowMs - entry.timestamp < 24_000)
    : []

  const transcriptStartMs =
    activeCall.connectedAt ?? activeCall.startedAt ?? transcription.liveCaptions[0]?.timestamp ?? 0

  const handleCopyTranscript = async () => {
    if (transcription.liveCaptions.length === 0) return
    const plainText = transcription.liveCaptions
      .map((entry) => formatTranscriptLine(entry, transcriptStartMs))
      .join('\n')
    if (!plainText.trim()) return
    try {
      await navigator.clipboard.writeText(plainText)
      setCopiedTranscript(true)
      onPlaySound?.('click')
      engine.pushToast('success', 'Copied timestamped transcript')
      window.setTimeout(() => setCopiedTranscript(false), 1800)
    } catch {
      engine.pushToast('error', 'Failed to copy transcript')
    }
  }

  const handleDownloadTranscript = () => {
    const { filename, content, mimeType } = transcription.exportCallTranscriptMarkdown()
    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    onPlaySound?.('click')
    engine.pushToast('success', `Saved ${filename}`)
  }

  const copyCallText = async (value: string, toastTitle: string) => {
    try {
      await navigator.clipboard.writeText(value)
      onPlaySound?.('click')
      engine.pushToast('success', toastTitle)
    } catch {
      engine.pushToast('error', 'Failed to copy to clipboard')
    }
  }

  const togglePinVideo = (pubkey: string) => {
    onPlaySound?.('click')
    setPinnedVideoPubkey((prev) => (prev === pubkey ? null : pubkey))
  }

  const openParticipantContextMenu = (e: ReactMouseEvent, participant: CallParticipant) => {
    const npub = safeEncodeNpub(participant.pubkey)
    const items: ContextMenuItem[] = []
    const shielded = isParticipantShielded(participant)
    const liveVideo = hasParticipantLiveVideo(participant, shielded)

    if (liveVideo) {
      const pinned = pinnedVideoPubkey === participant.pubkey
      items.push({
        id: 'pin-video',
        label: pinned ? 'Unpin Video' : 'Pin Video to Stage',
        icon: pinned ? <PinOff size={14} /> : <Pin size={14} />,
        onSelect: () => togglePinVideo(participant.pubkey),
      })
    }

    if (participant.isSelf) {
      items.push(
        {
          id: 'toggle-mute',
          label: activeCall.localMuted ? 'Unmute Microphone' : 'Mute Microphone',
          icon: activeCall.localMuted ? <Mic size={14} /> : <MicOff size={14} />,
          dividerBefore: liveVideo,
          onSelect: handleToggleMute,
        },
        {
          id: 'toggle-camera',
          label: activeCall.localCameraOn ? 'Turn Camera Off' : 'Turn Camera On',
          icon: activeCall.localCameraOn ? <VideoOff size={14} /> : <Video size={14} />,
          onSelect: handleToggleCamera,
        },
        {
          id: 'copy-handle',
          label: 'Copy Handle',
          icon: <Copy size={14} />,
          dividerBefore: true,
          onSelect: () => {
            void copyCallText(participant.displayHandle, 'Copied handle')
          },
        },
        {
          id: 'copy-npub',
          label: 'Copy npub',
          icon: <Copy size={14} />,
          onSelect: () => {
            void copyCallText(npub, 'Copied public key')
          },
        },
      )
    } else {
      const trusted = engine.isExplicitlyTrusted(participant.pubkey)
      const knownPeer = engine.getPeerByPubkey(participant.pubkey)

      if (onInspectPeer) {
        items.push({
          id: 'view-profile',
          label: 'View Profile',
          icon: <User size={14} />,
          onSelect: () => {
            onPlaySound?.('click')
            onInspectPeer(
              knownPeer ?? {
                pubkey: participant.pubkey,
                npub,
                nickname: participant.nickname,
                displayHandle: participant.displayHandle,
                lastSeenAt: Math.floor(Date.now() / 1000),
                isOnline: true,
                isSelf: false,
                isTeleported: false,
                isMeshBridge: false,
                isBlocked: engine.isPeerBlocked(participant.pubkey),
                isTrusted: trusted,
                messageCount: 0,
                channels: [],
              },
            )
          },
        })
      }

      items.push(
        {
          id: 'direct-message',
          label: 'Direct Message',
          icon: <MessageCircle size={14} />,
          onSelect: () => {
            onPlaySound?.('click')
            if (expanded) onToggleExpand()
            if (onOpenDm) {
              onOpenDm(participant.pubkey, participant.nickname)
            } else {
              engine.openDmThread(participant.pubkey, participant.nickname)
            }
          },
        },
        {
          id: 'copy-handle',
          label: 'Copy Handle',
          icon: <Copy size={14} />,
          dividerBefore: true,
          onSelect: () => {
            void copyCallText(participant.displayHandle, 'Copied handle')
          },
        },
        {
          id: 'copy-npub',
          label: 'Copy npub',
          icon: <Copy size={14} />,
          onSelect: () => {
            void copyCallText(npub, 'Copied public key')
          },
        },
        {
          id: 'copy-dm-link',
          label: 'Copy DM Link',
          icon: <Link2 size={14} />,
          onSelect: () => {
            void copyCallText(
              buildDmShareUrl(participant.pubkey, participant.nickname),
              'Copied DM link',
            )
          },
        },
        {
          id: 'trust-peer',
          label: trusted ? 'Remove Trust' : 'Trust Peer',
          icon: <ShieldCheck size={14} />,
          dividerBefore: true,
          onSelect: () => {
            onPlaySound?.('click')
            if (trusted) {
              engine.untrustPubkey(participant.pubkey)
            } else {
              engine.trustPubkey(participant.pubkey, participant.nickname)
            }
          },
        },
      )
    }

    openContextMenu(e, {
      header: participant.isSelf ? `${participant.displayHandle} (You)` : participant.displayHandle,
      items,
    })
  }

  const openTranscriptContextMenu = (
    e: ReactMouseEvent,
    entry: LiveCaptionEntry,
  ) => {
    openContextMenu(e, {
      header: entry.displayHandle,
      items: [
        {
          id: 'copy-line',
          label: 'Copy Line',
          icon: <Copy size={14} />,
          onSelect: () => {
            void copyCallText(
              formatTranscriptLine(entry, transcriptStartMs),
              'Copied transcript line',
            )
          },
        },
        {
          id: 'copy-transcript',
          label: 'Copy Full Transcript',
          icon: <FileText size={14} />,
          onSelect: () => {
            void handleCopyTranscript()
          },
        },
        {
          id: 'download-transcript',
          label: 'Download Markdown (.md)',
          icon: <Download size={14} />,
          dividerBefore: true,
          onSelect: handleDownloadTranscript,
        },
      ],
    })
  }

  // Stage priority ordering: active trusted screen/camera feeds FIRST, then trusted audio, then shielded
  const stageParticipants = activeCall.participants
    .map((participant, index) => {
      const shielded = isParticipantShielded(participant)
      const liveVideo = hasParticipantLiveVideo(participant, shielded)
      return { participant, shielded, liveVideo, index }
    })
    .sort((a, b) => {
      const rank = (item: {
        participant: CallParticipant
        shielded: boolean
        liveVideo: boolean
      }) => {
        if (item.liveVideo && item.participant.screenSharing) return 0
        if (item.liveVideo) return 1
        if (!item.shielded) return 2
        return 3
      }
      const diff = rank(a) - rank(b)
      return diff !== 0 ? diff : a.index - b.index
    })

  const pinnedStageItem = pinnedVideoPubkey
    ? (stageParticipants.find(
        (item) => item.participant.pubkey === pinnedVideoPubkey && item.liveVideo,
      ) ?? null)
    : null
  const videoStageItems = stageParticipants.filter((item) => item.liveVideo)
  const audioStageItems = stageParticipants.filter((item) => !item.liveVideo)
  const useVideoPrioritySplit =
    !pinnedStageItem && videoStageItems.length > 0 && audioStageItems.length > 0

  const selectedOutputDevice =
    calls.audioOutputDevices.find((d) => d.deviceId === calls.selectedAudioOutputId) ?? null
  const selectedInputDevice =
    calls.audioInputDevices.find((d) => d.deviceId === calls.selectedAudioInputId) ?? null
  const activeOutputRoute: AudioRouteKind = selectedOutputDevice
    ? classifyAudioRoute(selectedOutputDevice.label)
    : selectedInputDevice && classifyAudioRoute(selectedInputDevice.label) === 'bluetooth'
      ? 'bluetooth'
      : 'speaker'

  const hasDefaultOutputEntry = calls.audioOutputDevices.some(
    (d) => d.deviceId === '' || d.deviceId === 'default',
  )

  const renderParticipantTile = (
    item: (typeof stageParticipants)[number],
    opts?: { compact?: boolean; isPinned?: boolean; stripMode?: boolean },
  ) => {
    const screenVideo =
      !item.participant.isSelf &&
      !item.shielded &&
      contentFilter.shouldScreenCallVideo(item.participant.pubkey, false)
    return (
      <ParticipantTile
        key={item.participant.pubkey}
        participant={item.participant}
        avatarUrl={engine.getProfilePicture(item.participant.pubkey)}
        compact={opts?.compact ?? (!expanded && count > 2)}
        shielded={item.shielded}
        screenVideo={screenVideo}
        contentFilter={screenVideo ? contentFilter : undefined}
        isPinned={opts?.isPinned ?? false}
        stripMode={opts?.stripMode ?? false}
        onTogglePin={
          item.liveVideo ? () => togglePinVideo(item.participant.pubkey) : undefined
        }
        onTrustPeer={
          item.shielded
            ? () => {
                onPlaySound?.('click')
                engine.trustPubkey(item.participant.pubkey, item.participant.nickname)
              }
            : undefined
        }
        onContextMenu={(e) => openParticipantContextMenu(e, item.participant)}
      />
    )
  }

  const stageContent = (
    <section
      className={`ag-call-stage ${expanded ? 'ag-call-stage-expanded' : 'ag-call-stage-docked'}`}
      aria-label={`Active call: ${activeCall.title}`}
    >
      {/* Header */}
      <div className="ag-call-head">
        <div className="ag-call-head-left">
          <span
            className={`ag-led ${
              activeCall.status === 'active'
                ? 'ag-led-ok ag-led-pulse'
                : 'ag-led-warn ag-led-pulse'
            }`}
          />
          {isGeoCall ? (
            <>
              <span className="ag-badge ag-badge-accent mono">
                {isTopicCall ? <Hash size={10} /> : <Waves size={10} />}
                <span>{geoTag ?? activeCall.title}</span>
              </span>
              <span className="ag-call-title truncate ag-hide-xs">
                {isTopicCall ? 'Topic Bitchat' : 'Bitchat'}
              </span>
              <span className="ag-badge ag-badge-muted ag-hide-xs">
                {isTopicCall ? 'Topic Bitchat · P2P' : 'Public Bitchat · P2P'}
              </span>
            </>
          ) : (
            <>
              <span className="ag-call-title truncate">{activeCall.title}</span>
              <span
                className={`ag-badge ag-hide-xs ${
                  activeCall.encrypted ? 'ag-badge-dm' : 'ag-badge-accent'
                }`}
              >
                <Lock size={9} />
                <span>{activeCall.encrypted ? 'E2EE P2P' : 'P2P'}</span>
              </span>
            </>
          )}
          <span className="ag-chip ag-chip-mono">
            <Users size={10} />
            <span>
              {count}/{activeCall.maxParticipants}
            </span>
          </span>
          {isOutgoingRinging ? (
            <span className="ag-call-ringing-pill" role="status">
              <PhoneCall size={11} className="ag-call-ringing-icon" />
              <span>Ringing…</span>
            </span>
          ) : (
            <span className="ag-call-timer mono">{statusText}</span>
          )}
          {recBadge}
        </div>

        <div className="ag-call-head-actions">
          {showTranscriptTrigger && (
            <button
              type="button"
              className={`ag-call-head-btn ${transcriptOpen ? 'active' : ''}`}
              onClick={() => {
                onPlaySound?.('click')
                setTranscriptOpen((v) => !v)
              }}
              aria-pressed={transcriptOpen}
              title={transcriptOpen ? 'Hide call transcript' : 'Show call transcript'}
              aria-label={transcriptOpen ? 'Hide call transcript' : 'Show call transcript'}
            >
              <FileText size={14} />
              <span className="ag-hide-xs">Transcript</span>
              {transcription.liveCaptions.length > 0 && (
                <span className="ag-call-head-btn-count mono">
                  {transcription.liveCaptions.length}
                </span>
              )}
            </button>
          )}
          <button
            type="button"
            className="ag-icon-btn-sm"
            onClick={() => {
              onPlaySound?.('click')
              onToggleExpand()
            }}
            title={expanded ? 'Minimize call stage (Esc)' : 'Full-screen spotlight'}
            aria-label={expanded ? 'Minimize call stage' : 'Expand call stage'}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>

      {/* Main Stage Body: Participant Grid + Live Captions Overlay + Optional Transcript Panel */}
      <div className={`ag-call-stage-body ${transcriptOpen ? 'with-transcript' : ''}`}>
        <div className="ag-call-stage-main">
          {/* Outgoing DM Call Ringback Status Banner */}
          {isOutgoingRinging && (
            <div className="ag-call-ringback-dock" role="status" aria-live="polite">
              <span className="ag-call-ringback-banner">
                <PhoneCall size={13} className="ag-call-ringing-icon" />
                <span className="truncate">Ringing {activeCall.title}…</span>
                <span className="ag-call-ringback-sep ag-hide-xs" aria-hidden="true">
                  ·
                </span>
                <span className="ag-call-ringback-sub ag-hide-xs">Waiting for answer</span>
              </span>
            </div>
          )}

          {/* Video-Priority Stage / Solo Pinned Video / Responsive 1–6 Grid */}
          {pinnedStageItem ? (
            <div className="ag-call-stage-pinned">
              {renderParticipantTile(pinnedStageItem, { compact: false, isPinned: true })}
            </div>
          ) : useVideoPrioritySplit ? (
            <div className="ag-call-stage-split">
              <div
                className="ag-call-video-stage"
                data-video-count={Math.min(6, videoStageItems.length)}
              >
                {videoStageItems.map((item) =>
                  renderParticipantTile(item, {
                    compact: !expanded && videoStageItems.length > 2,
                  }),
                )}
              </div>
              <div className="ag-call-audio-strip" role="list" aria-label="Audio participants">
                {audioStageItems.map((item) =>
                  renderParticipantTile(item, { compact: true, stripMode: true }),
                )}
              </div>
            </div>
          ) : (
            <div className="ag-call-grid" data-count={count}>
              {stageParticipants.map((item) => renderParticipantTile(item))}
            </div>
          )}

          {/* Live Captions & Model Download Progress Overlay */}
          {transcription.liveCaptionsEnabled && (
            <div className="ag-call-cc-dock">
              {transcription.modelStatus === 'downloading' && (
                <div className="ag-call-cc-status mono" role="status">
                  <Loader2 size={12} className="ag-spin" />
                  <span className="truncate">
                    Loading {transcription.activeModel.label} ·{' '}
                    {Math.round(transcription.downloadProgress)}%
                  </span>
                </div>
              )}

              {transcription.modelStatus === 'error' && transcription.modelError && (
                <div className="ag-call-cc-status error" role="alert">
                  <AlertCircle size={12} />
                  <span className="truncate">{transcription.modelError}</span>
                </div>
              )}

              {recentCaptions.length > 0 && (
                <div
                  className="ag-call-cc-overlay"
                  role="log"
                  aria-live="polite"
                  aria-label="Live call captions"
                >
                  {recentCaptions.map((entry) => (
                    <div
                      key={entry.id}
                      className={`ag-call-cc-line ${
                        nowMs - entry.timestamp >= 12_000 ? 'fading' : ''
                      }`}
                    >
                      <span
                        className="ag-call-cc-speaker"
                        style={{ color: pubkeyToColor(entry.pubkey) }}
                      >
                        {entry.nickname ? `@${entry.nickname}` : entry.displayHandle}
                      </span>
                      <span className="ag-call-cc-text">{entry.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Speaker-Attributed Call Transcript Panel */}
        {transcriptOpen && (
          <aside className="ag-call-transcript-pane" aria-label="Call transcript">
            <div className="ag-call-transcript-head">
              <div className="ag-call-transcript-title-wrap">
                <span className="ag-call-transcript-title">Transcript</span>
                <span className="ag-call-transcript-model mono truncate">
                  {transcription.activeModel.label}
                </span>
              </div>
              <div className="ag-call-transcript-actions">
                <button
                  type="button"
                  className="ag-icon-btn-xs"
                  disabled={transcription.liveCaptions.length === 0}
                  onClick={() => void handleCopyTranscript()}
                  title="Copy transcript"
                  aria-label="Copy transcript"
                >
                  {copiedTranscript ? (
                    <Check size={13} className="ag-tone-ok" />
                  ) : (
                    <Copy size={13} />
                  )}
                </button>
                <button
                  type="button"
                  className="ag-icon-btn-xs"
                  disabled={transcription.liveCaptions.length === 0}
                  onClick={handleDownloadTranscript}
                  title="Download Markdown (.md)"
                  aria-label="Download transcript as Markdown"
                >
                  <Download size={13} />
                </button>
                {transcription.liveCaptions.length > 0 && (
                  <button
                    type="button"
                    className="ag-icon-btn-xs ag-icon-btn-danger"
                    onClick={() => {
                      onPlaySound?.('click')
                      transcription.clearCallTranscript()
                    }}
                    title="Clear transcript"
                    aria-label="Clear call transcript"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
                <button
                  type="button"
                  className="ag-icon-btn-xs"
                  onClick={() => setTranscriptOpen(false)}
                  title="Close transcript"
                  aria-label="Close transcript"
                >
                  <X size={13} />
                </button>
              </div>
            </div>

            <div className="ag-call-transcript-list" ref={transcriptListRef}>
              {transcription.liveCaptions.length === 0 ? (
                <div className="ag-call-transcript-empty">
                  {transcription.modelStatus === 'downloading'
                    ? `Loading ${transcription.activeModel.label} (${Math.round(transcription.downloadProgress)}%)…`
                    : transcription.liveCaptionsEnabled
                      ? 'Listening locally for speech…'
                      : 'Enable CC to transcribe call speech on your device.'}
                </div>
              ) : (
                transcription.liveCaptions.map((entry) => (
                  <div
                    key={entry.id}
                    className="ag-call-transcript-row"
                    onContextMenu={(e) => openTranscriptContextMenu(e, entry)}
                  >
                    <div className="ag-call-transcript-meta">
                      <span
                        className="ag-call-transcript-speaker truncate"
                        style={{ color: pubkeyToColor(entry.pubkey) }}
                      >
                        {entry.displayHandle}
                      </span>
                      <span className="ag-call-transcript-time mono">
                        {formatCaptionClock(entry.timestamp)}
                      </span>
                    </div>
                    <p className="ag-call-transcript-text">{entry.text}</p>
                  </div>
                ))
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Tactical Control Dock */}
      <div className="ag-call-controls" role="toolbar" aria-label="Call controls">
        <button
          type="button"
          className={`ag-call-ctrl-btn ${activeCall.localMuted ? 'active-danger' : ''}`}
          onClick={handleToggleMute}
          aria-pressed={activeCall.localMuted}
          aria-label={activeCall.localMuted ? 'Unmute microphone' : 'Mute microphone'}
          title={activeCall.localMuted ? 'Unmute microphone' : 'Mute microphone'}
        >
          {activeCall.localMuted ? <MicOff size={17} /> : <Mic size={17} />}
          <span>{activeCall.localMuted ? 'Unmute' : 'Mute'}</span>
        </button>

        <button
          type="button"
          className={`ag-call-ctrl-btn ${activeCall.localDeafened ? 'active-warn' : ''}`}
          onClick={handleToggleDeafen}
          aria-pressed={activeCall.localDeafened}
          aria-label={activeCall.localDeafened ? 'Undeafen audio' : 'Deafen audio'}
          title={activeCall.localDeafened ? 'Undeafen audio' : 'Deafen audio'}
        >
          {activeCall.localDeafened ? <HeadphoneOff size={17} /> : <Headphones size={17} />}
          <span>{activeCall.localDeafened ? 'Deafened' : 'Deafen'}</span>
        </button>

        {/* Audio Output & Microphone Device Picker (Speakerphone / Earpiece / Bluetooth) */}
        <div className={`ag-call-audio-wrap ${isAudioPopoverVisible ? 'open' : ''}`} ref={audioWrapRef}>
          <button
            type="button"
            className={`ag-call-ctrl-btn ${
              isAudioPopoverVisible || activeOutputRoute !== 'speaker' ? 'active-accent' : ''
            }`}
            onClick={() => {
              onPlaySound?.('click')
              setQualityMenuOpen(false)
              setAudioMenuOpen((prev) => {
                const next = !prev
                if (next) {
                  void calls.refreshAudioDevices()
                }
                return next
              })
            }}
            aria-haspopup="menu"
            aria-expanded={isAudioPopoverVisible}
            aria-label="Audio output and microphone devices"
            title="Audio devices (Speaker / Earpiece / Bluetooth / Mic)"
          >
            {renderAudioRouteIcon(activeOutputRoute, 17)}
            <span>Audio</span>
          </button>

          {isAudioPopoverVisible && (
            <div
              className="ag-call-audio-menu"
              role="menu"
              aria-label="Audio output and microphone selection"
            >
              <div className="ag-call-audio-sec-head mono">AUDIO OUTPUT</div>
              {calls.supportsAudioOutputSelection ? (
                <div className="ag-call-audio-list">
                  {!hasDefaultOutputEntry && (
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={calls.selectedAudioOutputId === ''}
                      className={`ag-call-audio-opt ${
                        calls.selectedAudioOutputId === '' ? 'selected' : ''
                      }`}
                      onClick={() => {
                        calls.selectAudioOutput('')
                        onPlaySound?.('click')
                        setAudioMenuOpen(false)
                      }}
                    >
                      <span className="ag-call-audio-opt-left">
                        <Volume2 size={14} />
                        <span className="truncate">System Default</span>
                      </span>
                      {calls.selectedAudioOutputId === '' && (
                        <Check size={13} className="ag-call-quality-check" />
                      )}
                    </button>
                  )}
                  {calls.audioOutputDevices.map((dev, idx) => {
                    const label = formatAudioDeviceLabel(dev, idx, 'audiooutput')
                    const route = classifyAudioRoute(label)
                    const selected =
                      calls.selectedAudioOutputId === dev.deviceId ||
                      (calls.selectedAudioOutputId === '' && dev.deviceId === 'default')
                    return (
                      <button
                        key={dev.deviceId || `out-${idx}`}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={selected}
                        className={`ag-call-audio-opt ${selected ? 'selected' : ''}`}
                        onClick={() => {
                          calls.selectAudioOutput(dev.deviceId)
                          onPlaySound?.('click')
                          setAudioMenuOpen(false)
                        }}
                      >
                        <span className="ag-call-audio-opt-left">
                          {renderAudioRouteIcon(route, 14)}
                          <span className="truncate">{label}</span>
                        </span>
                        {selected && <Check size={13} className="ag-call-quality-check" />}
                      </button>
                    )
                  })}
                </div>
              ) : !calls.supportsSystemAudioOutputPicker ? (
                <p className="ag-call-audio-note">
                  Speaker &amp; Bluetooth output is routed via your device&apos;s system audio
                  picker.
                </p>
              ) : null}

              {calls.supportsSystemAudioOutputPicker && (
                <button
                  type="button"
                  role="menuitem"
                  className="ag-call-audio-sys-btn"
                  onClick={() => {
                    onPlaySound?.('click')
                    void calls.promptSystemAudioOutput().then((ok) => {
                      if (ok) setAudioMenuOpen(false)
                    })
                  }}
                >
                  <Volume2 size={13} />
                  <span>Choose System Output…</span>
                </button>
              )}

              <div className="ag-call-audio-sec-head mono ag-call-audio-sec-divider">
                MICROPHONE / INPUT
              </div>
              <div className="ag-call-audio-list">
                {calls.audioInputDevices.length === 0 ? (
                  <div className="ag-call-audio-opt selected">
                    <span className="ag-call-audio-opt-left">
                      <Mic size={14} />
                      <span className="truncate">Default Microphone</span>
                    </span>
                    <Check size={13} className="ag-call-quality-check" />
                  </div>
                ) : (
                  calls.audioInputDevices.map((dev, idx) => {
                    const label = formatAudioDeviceLabel(dev, idx, 'audioinput')
                    const route = classifyAudioRoute(label)
                    const selected =
                      calls.selectedAudioInputId === dev.deviceId ||
                      (calls.selectedAudioInputId === '' &&
                        (dev.deviceId === 'default' || idx === 0))
                    return (
                      <button
                        key={dev.deviceId || `in-${idx}`}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={selected}
                        disabled={switchingAudioInput}
                        className={`ag-call-audio-opt ${selected ? 'selected' : ''}`}
                        onClick={() => {
                          if (switchingAudioInput) return
                          onPlaySound?.('click')
                          setSwitchingAudioInput(true)
                          void calls
                            .selectAudioInput(dev.deviceId)
                            .then((ok) => {
                              if (ok) setAudioMenuOpen(false)
                            })
                            .finally(() => setSwitchingAudioInput(false))
                        }}
                      >
                        <span className="ag-call-audio-opt-left">
                          {renderAudioRouteIcon(route, 14, true)}
                          <span className="truncate">{label}</span>
                        </span>
                        {selected && <Check size={13} className="ag-call-quality-check" />}
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          className={`ag-call-ctrl-btn ${activeCall.localCameraOn ? 'active-accent' : ''}`}
          onClick={handleToggleCamera}
          aria-pressed={activeCall.localCameraOn}
          aria-label={activeCall.localCameraOn ? 'Turn camera off' : 'Turn camera on'}
          title={activeCall.localCameraOn ? 'Turn camera off' : 'Turn camera on'}
        >
          {activeCall.localCameraOn ? <Video size={17} /> : <VideoOff size={17} />}
          <span>Camera</span>
        </button>

        {activeCall.screenShareSupported && (
          <button
            type="button"
            className={`ag-call-ctrl-btn ${activeCall.localScreenSharing ? 'active-accent' : ''}`}
            onClick={handleToggleScreen}
            aria-pressed={activeCall.localScreenSharing}
            aria-label={activeCall.localScreenSharing ? 'Stop screen share' : 'Share screen'}
            title={activeCall.localScreenSharing ? 'Stop screen share' : 'Share screen'}
          >
            {activeCall.localScreenSharing ? <MonitorOff size={17} /> : <MonitorUp size={17} />}
            <span>{activeCall.localScreenSharing ? 'Stop Share' : 'Share'}</span>
          </button>
        )}

        <button
          type="button"
          className={`ag-call-ctrl-btn ag-call-cc-btn ${
            transcription.liveCaptionsEnabled ? 'active-accent' : ''
          }`}
          onClick={() => {
            onPlaySound?.('click')
            transcription.toggleLiveCaptions()
          }}
          aria-pressed={transcription.liveCaptionsEnabled}
          aria-label={
            transcription.liveCaptionsEnabled
              ? transcription.modelStatus === 'downloading'
                ? `Loading ${transcription.activeModel.label} (${Math.round(transcription.downloadProgress)}%) — click to disable live captions`
                : `Disable live captions (${transcription.activeModel.label})`
              : `Enable live captions (${transcription.activeModel.label})`
          }
          title={
            transcription.liveCaptionsEnabled
              ? transcription.modelStatus === 'downloading'
                ? `Loading ${transcription.activeModel.label} · ${Math.round(transcription.downloadProgress)}% — click to turn off`
                : `Live captions ON (${transcription.activeModel.label}) — click to turn off`
              : `Enable live on-device captions (${transcription.activeModel.label})`
          }
        >
          <Captions size={17} />
          <span>CC</span>
        </button>

        <div
          className={`ag-call-rec-split ${activeCall.localRecording ? 'recording' : ''} ${
            isQualityPopoverVisible ? 'open' : ''
          } ${!activeCall.recordingSupported ? 'disabled' : ''}`}
          ref={qualityWrapRef}
        >
          <button
            type="button"
            className="ag-call-rec-main"
            onClick={() => void handleToggleRecording()}
            disabled={!activeCall.recordingSupported || togglingRec}
            aria-pressed={activeCall.localRecording}
            aria-label={
              !activeCall.recordingSupported
                ? 'Call recording is not supported in this browser'
                : activeCall.localRecording
                  ? 'Stop recording call'
                  : `Record call (${activeQualitySpec.label} ${activeQualitySpec.shortLabel})`
            }
            title={
              !activeCall.recordingSupported
                ? 'Call recording is not supported in this browser'
                : activeCall.localRecording
                  ? `Stop recording (${activeQualitySpec.shortLabel})`
                  : `Record call locally at ${activeQualitySpec.label} (${activeQualitySpec.shortLabel} · ${activeQualitySpec.approxMbPerMin})`
            }
          >
            {activeCall.localRecording ? (
              <Square size={15} fill="currentColor" />
            ) : (
              <Circle size={15} fill="currentColor" className="ag-call-rec-icon" />
            )}
            <span className="ag-call-rec-text">
              {activeCall.localRecording ? 'Stop' : 'Record'}
            </span>
          </button>

          {activeCall.recordingSupported && (
            <button
              type="button"
              className="ag-call-rec-caret"
              disabled={activeCall.localRecording}
              onClick={() => {
                onPlaySound?.('click')
                setAudioMenuOpen(false)
                setQualityMenuOpen((v) => !v)
              }}
              aria-haspopup="listbox"
              aria-expanded={isQualityPopoverVisible}
              aria-label={
                activeCall.localRecording
                  ? `Recording at ${activeQualitySpec.shortLabel} — stop to change quality`
                  : `Recording quality: ${activeQualitySpec.label} (${activeQualitySpec.shortLabel})`
              }
              title={
                activeCall.localRecording
                  ? `Recording at ${activeQualitySpec.shortLabel} — stop to change quality`
                  : `Recording quality: ${activeQualitySpec.label} (${activeQualitySpec.shortLabel} · ${activeQualitySpec.approxMbPerMin})`
              }
            >
              <span className="ag-call-rec-res mono">{activeQualitySpec.shortLabel}</span>
              <ChevronUp
                size={12}
                className={`ag-call-quality-chevron ${isQualityPopoverVisible ? 'open' : ''}`}
              />
            </button>
          )}

          {isQualityPopoverVisible && (
            <div
              className="ag-call-quality-menu"
              role="listbox"
              aria-label="Select call recording quality"
            >
              <div className="ag-call-quality-menu-head mono">RECORDING QUALITY</div>
              {RECORDING_QUALITY_PRESETS.map((spec) => {
                const selected = spec.id === calls.recordingQuality
                return (
                  <button
                    key={spec.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`ag-call-quality-opt ${selected ? 'selected' : ''}`}
                    onClick={() => {
                      calls.setRecordingQuality(spec.id)
                      onPlaySound?.('click')
                      setQualityMenuOpen(false)
                    }}
                  >
                    <span className="ag-call-quality-opt-main">
                      <span className="ag-call-quality-opt-name">{spec.label}</span>
                      <span className="ag-call-quality-opt-meta mono">
                        {spec.shortLabel} · {spec.approxMbPerMin.replace('/min', '/m')}
                      </span>
                    </span>
                    {selected && <Check size={13} className="ag-call-quality-check" />}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <button
          type="button"
          className="ag-call-ctrl-btn ag-call-hangup-btn"
          onClick={handleLeave}
          aria-label={
            isGeoCall
              ? 'Leave Bitchat call'
              : activeCall.mode === 'server'
                ? 'Leave voice lounge'
                : 'Hang up call'
          }
          title={
            isGeoCall
              ? 'Leave Bitchat call'
              : activeCall.mode === 'server'
                ? 'Leave voice lounge'
                : 'Hang up call'
          }
        >
          <PhoneOff size={17} />
          <span>{isGroupCall ? 'Leave' : 'Hang Up'}</span>
        </button>
      </div>
    </section>
  )

  if (expanded) {
    return (
      <>
        {audioSinks}
        <div
          className="ag-call-modal-backdrop"
          onClick={onToggleExpand}
          role="presentation"
        >
          <div
            className="ag-call-modal-frame"
            role="dialog"
            aria-modal="true"
            aria-label={`Full-screen call: ${activeCall.title}`}
            onClick={(e) => e.stopPropagation()}
          >
            {stageContent}
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      {audioSinks}
      {stageContent}
    </>
  )
}

export default CallStage
