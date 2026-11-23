import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { nip19 } from 'nostr-tools'
import {
  AlertCircle,
  Captions,
  Check,
  ChevronUp,
  Circle,
  Copy,
  Download,
  FileText,
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
  Radio,
  ShieldCheck,
  Square,
  Trash2,
  User,
  Users,
  Video,
  VideoOff,
  X,
} from 'lucide-react'
import type { AgnostrEngine, PeerInfo } from '../types/protocol.ts'
import type { CallEngine, CallParticipant, PeerIceConnectionState } from '../types/calls.ts'
import {
  RECORDING_QUALITY_PRESETS,
  getRecordingQualitySpec,
} from '../lib/callRecorder.ts'
import { buildDmShareUrl } from '../lib/shareLinks.ts'
import type { SoundCue } from '../utils/sound.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import { identiconDataUrl, pubkeyToColor } from '../utils/identicon.ts'
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
    })
  } catch {
    return ''
  }
}

function iceLedClass(state: PeerIceConnectionState): string {
  if (state === 'connected' || state === 'completed') return 'ag-led-ok'
  if (state === 'checking' || state === 'new') return 'ag-led-warn ag-led-pulse'
  if (state === 'disconnected' || state === 'failed') return 'ag-led-danger'
  return 'ag-led-muted'
}

/**
 * Persistent remote audio sink so audio playback never interrupts when switching
 * between docked, full-screen expanded, and compact floating call bar modes.
 * Hardened for iOS Safari / Android PWA async remote-track arrival & autoplay unlock.
 */
function RemoteAudioTrack({
  stream,
  deafened,
}: {
  stream: MediaStream | null
  deafened: boolean
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
  compact,
  onContextMenu,
}: {
  participant: CallParticipant
  compact: boolean
  onContextMenu?: (e: ReactMouseEvent) => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const liveVideoTrack =
    participant.stream && (participant.videoEnabled || participant.screenSharing)
      ? (participant.stream.getVideoTracks().find((t) => t.readyState === 'live') ?? null)
      : null
  const liveVideoTrackId = liveVideoTrack?.id ?? null
  const hasLiveVideo = liveVideoTrack !== null

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
  }, [hasLiveVideo, participant.stream, liveVideoTrackId, liveVideoTrack])

  const handleColor = pubkeyToColor(participant.pubkey)
  const avatarSize = compact ? 44 : 60
  const levelScale = 1 + Math.min(0.32, participant.audioLevel * 0.45)

  return (
    <div
      className={`ag-call-tile ${participant.isSpeaking ? 'speaking' : ''} ${
        hasLiveVideo ? 'has-video' : 'audio-only'
      } ${participant.screenSharing ? 'is-screen' : ''} ${
        participant.isRecording ? 'is-recording' : ''
      }`}
      onContextMenu={onContextMenu}
    >
      {hasLiveVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`ag-call-video ${
            participant.isSelf && !participant.screenSharing ? 'mirrored' : ''
          } ${participant.screenSharing ? 'contain' : ''}`}
        />
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
            <img
              src={identiconDataUrl(participant.pubkey)}
              alt=""
              width={avatarSize}
              height={avatarSize}
              className="ag-call-avatar"
            />
          </div>
        </div>
      )}

      {/* Top-left telemetry corner (SCREEN + ICE/RTT) */}
      {(participant.screenSharing || !participant.isSelf) && (
        <div className="ag-call-tile-top ag-call-tile-net">
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

      {/* Top-right pulsing crimson recording dot */}
      {participant.isRecording && (
        <span
          className="ag-call-rec-dot"
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
}: CallStageProps) {
  const { activeCall } = calls
  const { transcription } = engine
  const { openContextMenu } = useContextMenu()
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [togglingRec, setTogglingRec] = useState(false)
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [copiedTranscript, setCopiedTranscript] = useState(false)
  const qualityWrapRef = useRef<HTMLDivElement | null>(null)
  const transcriptListRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!activeCall) return
    setNowMs(Date.now())
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [activeCall])

  useEffect(() => {
    if (!transcriptOpen) return
    const el = transcriptListRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [transcriptOpen, transcription.liveCaptions.length])

  const isQualityPopoverVisible =
    qualityMenuOpen && Boolean(activeCall) && !activeCall?.localRecording

  // Android / PWA Back button closes CallStage overlays (LIFO: quality menu -> transcript)
  useBackHandler(Boolean(activeCall) && transcriptOpen, () => setTranscriptOpen(false))
  useBackHandler(isQualityPopoverVisible, () => setQualityMenuOpen(false))

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
    if (!activeCall || (!expanded && !isQualityPopoverVisible && !transcriptOpen)) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (isQualityPopoverVisible) {
          setQualityMenuOpen(false)
        } else if (transcriptOpen) {
          setTranscriptOpen(false)
        } else if (expanded) {
          onToggleExpand()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [expanded, activeCall, isQualityPopoverVisible, transcriptOpen, onToggleExpand])

  if (!activeCall) return null

  const remoteParticipants = activeCall.participants.filter((p) => !p.isSelf)
  const activeSpeaker = activeCall.participants.find((p) => p.isSpeaking) ?? null
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
      {remoteParticipants.map((p) => (
        <RemoteAudioTrack
          key={p.pubkey}
          stream={p.stream}
          deafened={activeCall.localDeafened}
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
            <span className="ag-call-float-title truncate">{activeCall.title}</span>
            {activeCall.encrypted && (
              <span className="ag-badge ag-badge-dm ag-hide-xs">
                <Lock size={9} />
                <span>E2EE P2P</span>
              </span>
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
                <Radio size={10} />
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
              title="Hang up"
              aria-label="Hang up call"
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

  const handleCopyTranscript = async () => {
    const { content } = transcription.exportCallTranscriptMarkdown()
    if (!content.trim()) return
    try {
      await navigator.clipboard.writeText(content)
      setCopiedTranscript(true)
      onPlaySound?.('click')
      engine.pushToast('success', 'Copied call transcript')
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

  const openParticipantContextMenu = (e: ReactMouseEvent, participant: CallParticipant) => {
    const npub = safeEncodeNpub(participant.pubkey)
    const items: ContextMenuItem[] = []

    if (participant.isSelf) {
      items.push(
        {
          id: 'toggle-mute',
          label: activeCall.localMuted ? 'Unmute Microphone' : 'Mute Microphone',
          icon: activeCall.localMuted ? <Mic size={14} /> : <MicOff size={14} />,
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
    entry: { displayHandle: string; text: string },
  ) => {
    openContextMenu(e, {
      header: entry.displayHandle,
      items: [
        {
          id: 'copy-line',
          label: 'Copy Line',
          icon: <Copy size={14} />,
          onSelect: () => {
            void copyCallText(`${entry.displayHandle}: ${entry.text}`, 'Copied transcript line')
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
          <span className="ag-call-title truncate">{activeCall.title}</span>
          <span className={`ag-badge ag-hide-xs ${activeCall.encrypted ? 'ag-badge-dm' : 'ag-badge-accent'}`}>
            <Lock size={9} />
            <span>{activeCall.encrypted ? 'E2EE P2P' : 'P2P'}</span>
          </span>
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

          {/* Responsive 1–6 Participant Tile Grid */}
          <div className="ag-call-grid" data-count={count}>
            {activeCall.participants.map((participant) => (
              <ParticipantTile
                key={participant.pubkey}
                participant={participant}
                compact={!expanded && count > 2}
                onContextMenu={(e) => openParticipantContextMenu(e, participant)}
              />
            ))}
          </div>

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
          aria-label={activeCall.mode === 'server' ? 'Leave voice lounge' : 'Hang up call'}
          title={activeCall.mode === 'server' ? 'Leave voice lounge' : 'Hang up call'}
        >
          <PhoneOff size={17} />
          <span>{activeCall.mode === 'server' ? 'Leave' : 'Hang Up'}</span>
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
