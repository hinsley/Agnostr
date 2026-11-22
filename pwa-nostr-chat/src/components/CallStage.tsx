import { useEffect, useRef, useState } from 'react'
import {
  HeadphoneOff,
  Headphones,
  Lock,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MonitorOff,
  MonitorUp,
  PhoneOff,
  Radio,
  Users,
  Video,
  VideoOff,
} from 'lucide-react'
import type { AgnostrEngine } from '../types/protocol.ts'
import type { CallEngine, CallParticipant, PeerIceConnectionState } from '../types/calls.ts'
import type { SoundCue } from '../utils/sound.ts'
import { identiconDataUrl, pubkeyToColor } from '../utils/identicon.ts'

export interface CallStageProps {
  calls: CallEngine
  engine: AgnostrEngine
  expanded: boolean
  compactFloating?: boolean
  onToggleExpand: () => void
  onPlaySound?: (cue: SoundCue) => void
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

function iceLedClass(state: PeerIceConnectionState): string {
  if (state === 'connected' || state === 'completed') return 'ag-led-ok'
  if (state === 'checking' || state === 'new') return 'ag-led-warn ag-led-pulse'
  if (state === 'disconnected' || state === 'failed') return 'ag-led-danger'
  return 'ag-led-muted'
}

/**
 * Persistent remote audio sink so audio playback never interrupts when switching
 * between docked, full-screen expanded, and compact floating call bar modes.
 */
function RemoteAudioTrack({
  stream,
  deafened,
}: {
  stream: MediaStream | null
  deafened: boolean
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    if (el.srcObject !== stream) {
      el.srcObject = stream
    }
    el.muted = deafened
    if (stream && !deafened) {
      el.play().catch(() => {
        // Ignore autoplay restriction; user gesture already initiated call
      })
    }
  }, [stream, deafened])

  return <audio ref={audioRef} autoPlay playsInline className="sr-only" />
}

function ParticipantTile({
  participant,
  compact,
}: {
  participant: CallParticipant
  compact: boolean
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const hasLiveVideo = Boolean(
    participant.stream &&
      (participant.videoEnabled || participant.screenSharing) &&
      participant.stream.getVideoTracks().some((t) => t.readyState === 'live'),
  )

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (hasLiveVideo && participant.stream) {
      if (el.srcObject !== participant.stream) {
        el.srcObject = participant.stream
      }
      el.play().catch(() => {
        // Ignore play interruption on track swap
      })
    } else if (el.srcObject) {
      el.srcObject = null
    }
  }, [hasLiveVideo, participant.stream])

  const handleColor = pubkeyToColor(participant.pubkey)
  const avatarSize = compact ? 44 : 60
  const levelScale = 1 + Math.min(0.32, participant.audioLevel * 0.45)

  return (
    <div
      className={`ag-call-tile ${participant.isSpeaking ? 'speaking' : ''} ${
        hasLiveVideo ? 'has-video' : 'audio-only'
      } ${participant.screenSharing ? 'is-screen' : ''}`}
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

      {/* Top-right telemetry corner */}
      <div className="ag-call-tile-top">
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
  expanded,
  compactFloating = false,
  onToggleExpand,
  onPlaySound,
}: CallStageProps) {
  const { activeCall } = calls
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!activeCall) return
    setNowMs(Date.now())
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [activeCall])

  useEffect(() => {
    if (!expanded || !activeCall) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onToggleExpand()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [expanded, activeCall, onToggleExpand])

  if (!activeCall) return null

  const remoteParticipants = activeCall.participants.filter((p) => !p.isSelf)
  const activeSpeaker = activeCall.participants.find((p) => p.isSpeaking) ?? null
  const count = Math.max(1, Math.min(activeCall.maxParticipants, activeCall.participants.length))

  const statusText =
    activeCall.status === 'ringing-out'
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

  // Compact Floating Bar when user is browsing another channel/server
  if (compactFloating && !expanded) {
    return (
      <>
        {audioSinks}
        <div
          className={`ag-call-floating-bar ${activeSpeaker ? 'has-speaker' : ''}`}
          role="region"
          aria-label={`Active call: ${activeCall.title}`}
        >
          <div className="ag-call-float-left">
            <span className="ag-led ag-led-ok ag-led-pulse" />
            <span className="ag-call-float-title truncate">{activeCall.title}</span>
            {activeCall.encrypted && (
              <span className="ag-badge ag-badge-dm ag-hide-xs">
                <Lock size={9} />
                <span>E2EE P2P</span>
              </span>
            )}
            <span className="ag-call-float-meta mono">
              {count}/{activeCall.maxParticipants} · {statusText}
            </span>
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
          <span className={`ag-badge ${activeCall.encrypted ? 'ag-badge-dm' : 'ag-badge-accent'}`}>
            <Lock size={9} />
            <span>{activeCall.encrypted ? 'E2EE P2P' : 'P2P'}</span>
          </span>
          <span className="ag-chip ag-chip-mono">
            <Users size={10} />
            <span>
              {count}/{activeCall.maxParticipants}
            </span>
          </span>
          <span className="ag-call-timer mono">{statusText}</span>
        </div>

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

      {/* Responsive 1–6 Participant Tile Grid */}
      <div className="ag-call-grid" data-count={count}>
        {activeCall.participants.map((participant) => (
          <ParticipantTile
            key={participant.pubkey}
            participant={participant}
            compact={!expanded && count > 2}
          />
        ))}
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
