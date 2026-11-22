import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Ban,
  Captions,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  Lock,
  Pause,
  Play,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  User,
} from 'lucide-react'
import type { VoiceMemoAttachment } from '../types/protocol'
import type {
  MemoTranscriptState,
  TranscriptionModelStatus,
} from '../types/transcription'
import { formatVoiceDuration, WAVEFORM_BARS } from '../lib/voiceRecorder'

export interface VoiceMemoPlayerProps {
  memo: VoiceMemoAttachment
  memoKey?: string
  senderPubkey: string
  senderNickname: string
  senderDisplayHandle: string
  isTrusted: boolean
  isDmMode?: boolean
  fetchVoiceMemoBlob: (memo: VoiceMemoAttachment, senderPubkey: string) => Promise<string>
  memoTranscript?: MemoTranscriptState
  transcriptionModelStatus?: TranscriptionModelStatus
  transcriptionDownloadProgress?: number
  activeTranscriptionModelLabel?: string
  onTranscribeMemo?: (
    memoKey: string,
    memo: VoiceMemoAttachment,
    senderPubkey: string
  ) => Promise<void> | void
  onTrustSender: (pubkey: string, nickname: string) => void
  onInspectSender: (pubkey: string, nickname: string) => void
  onBlockSender: (pubkey: string, displayHandle: string) => void
}

const SPEED_STEPS = [1, 1.5, 2] as const
type PlaybackSpeed = (typeof SPEED_STEPS)[number]

// Coordinate playback across voice memos so starting one pauses any other active memo
let activeAudioEl: HTMLAudioElement | null = null

function claimActiveAudio(el: HTMLAudioElement): void {
  if (activeAudioEl && activeAudioEl !== el) {
    try {
      activeAudioEl.pause()
    } catch {
      // Ignore
    }
  }
  activeAudioEl = el
}

function releaseActiveAudio(el: HTMLAudioElement | null): void {
  if (el && activeAudioEl === el) {
    activeAudioEl = null
  }
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function codecLabelFromMime(mime: string): string {
  const lower = (mime || '').toLowerCase()
  if (lower.includes('opus') || lower.includes('webm') || lower.includes('ogg')) return 'OPUS'
  if (lower.includes('mp4') || lower.includes('m4a') || lower.includes('aac')) return 'M4A'
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'MP3'
  if (lower.includes('wav')) return 'WAV'
  return 'AUDIO'
}

function buildWaveformBars(raw: readonly number[], seedSource: string): number[] {
  if (raw.length === WAVEFORM_BARS) {
    return raw.map((v) => Math.max(14, Math.min(100, Math.round(v))))
  }
  if (raw.length > 0) {
    const resampled: number[] = []
    for (let i = 0; i < WAVEFORM_BARS; i++) {
      const idx = Math.min(raw.length - 1, Math.floor((i / WAVEFORM_BARS) * raw.length))
      resampled.push(Math.max(14, Math.min(100, Math.round(raw[idx]))))
    }
    return resampled
  }
  // Deterministic tactical fallback waveform when external client omits waveform peaks
  let hash = 2166136261
  for (let i = 0; i < seedSource.length; i++) {
    hash ^= seedSource.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const bars: number[] = []
  for (let i = 0; i < WAVEFORM_BARS; i++) {
    hash ^= hash << 13
    hash ^= hash >>> 17
    hash ^= hash << 5
    const envelope = Math.sin(((i + 1) / (WAVEFORM_BARS + 1)) * Math.PI)
    const jitter = ((hash >>> 0) % 58) + 18
    bars.push(Math.max(16, Math.min(96, Math.round(jitter * (0.45 + 0.55 * envelope)))))
  }
  return bars
}

/* --------------------------------------------------------------------------
   INERT SHIELDED CARD — Mounted ONLY for untrusted senders.
   Contains ZERO <audio> elements and ZERO fetchVoiceMemoBlob references.
   -------------------------------------------------------------------------- */
interface ShieldedVoiceCardProps {
  memo: VoiceMemoAttachment
  senderPubkey: string
  senderNickname: string
  senderDisplayHandle: string
  isDmMode?: boolean
  onTrustSender: (pubkey: string, nickname: string) => void
  onInspectSender: (pubkey: string, nickname: string) => void
  onBlockSender: (pubkey: string, displayHandle: string) => void
}

const ShieldedVoiceCard: React.FC<ShieldedVoiceCardProps> = ({
  memo,
  senderPubkey,
  senderNickname,
  senderDisplayHandle,
  isDmMode = false,
  onTrustSender,
  onInspectSender,
  onBlockSender,
}) => {
  const isE2ee = Boolean(memo.encryption)
  const sizeText = formatByteSize(memo.size)
  const durText = memo.durationSec > 0 ? formatVoiceDuration(memo.durationSec) : ''
  const metaSummary = [durText, sizeText].filter(Boolean).join(' · ')

  return (
    <div
      className={`ag-voice-shield-card ${isDmMode || isE2ee ? 'dm' : ''}`}
      role="region"
      aria-label={`Blocked voice memo from untrusted sender ${senderDisplayHandle}`}
    >
      <div className="ag-voice-shield-top">
        <div className="ag-voice-shield-title-wrap">
          <span className="ag-voice-shield-emblem" aria-hidden="true">
            {isE2ee ? <Lock size={14} /> : <ShieldAlert size={15} />}
          </span>
          <span className="ag-voice-shield-title">Voice Memo · Untrusted Sender</span>
        </div>

        <div className="ag-voice-shield-badges">
          {metaSummary && (
            <span className="ag-badge muted tabular">{metaSummary}</span>
          )}
          {isE2ee && (
            <span className="ag-badge dm" title="End-to-end encrypted audio blob">
              <Lock size={9} />
              E2EE
            </span>
          )}
        </div>
      </div>

      <p className="ag-voice-shield-note">
        Blocked until you trust <strong>{senderDisplayHandle}</strong> (zero bytes fetched)
      </p>

      <div className="ag-voice-shield-actions">
        <button
          type="button"
          className="ag-voice-shield-btn trust"
          onClick={() => onTrustSender(senderPubkey, senderNickname)}
          title={`Trust ${senderDisplayHandle} to unlock their voice memos`}
        >
          <ShieldCheck size={13} />
          <span>Trust {senderDisplayHandle}</span>
        </button>

        <button
          type="button"
          className="ag-voice-shield-btn"
          onClick={() => onInspectSender(senderPubkey, senderNickname)}
          title={`Inspect ${senderDisplayHandle}`}
        >
          <User size={13} />
          <span>Inspect</span>
        </button>

        <button
          type="button"
          className="ag-voice-shield-btn danger"
          onClick={() => onBlockSender(senderPubkey, senderDisplayHandle)}
          title={`Block ${senderDisplayHandle}`}
        >
          <Ban size={13} />
          <span>Block</span>
        </button>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------------
   TRUSTED WAVEFORM PLAYER — Lazily fetches, verifies SHA-256 & decrypts on Play.
   -------------------------------------------------------------------------- */
interface TrustedVoicePlayerProps {
  memo: VoiceMemoAttachment
  memoKey: string
  senderPubkey: string
  isDmMode?: boolean
  fetchVoiceMemoBlob: (memo: VoiceMemoAttachment, senderPubkey: string) => Promise<string>
  memoTranscript?: MemoTranscriptState
  transcriptionModelStatus?: TranscriptionModelStatus
  transcriptionDownloadProgress?: number
  activeTranscriptionModelLabel?: string
  onTranscribeMemo?: (
    memoKey: string,
    memo: VoiceMemoAttachment,
    senderPubkey: string
  ) => Promise<void> | void
}

const TrustedVoicePlayer: React.FC<TrustedVoicePlayerProps> = ({
  memo,
  memoKey,
  senderPubkey,
  isDmMode = false,
  fetchVoiceMemoBlob,
  memoTranscript,
  transcriptionModelStatus,
  transcriptionDownloadProgress = 0,
  activeTranscriptionModelLabel = 'Moonshine Base',
  onTranscribeMemo,
}) => {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(memo.durationSec > 0 ? memo.durationSec : 0)
  const [speedIdx, setSpeedIdx] = useState(0)
  const [transcriptOpen, setTranscriptOpen] = useState(true)
  const [copiedTranscript, setCopiedTranscript] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const waveRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef(true)
  const draggingRef = useRef(false)
  const pendingSeekRatioRef = useRef<number | null>(null)

  const speed: PlaybackSpeed = SPEED_STEPS[speedIdx]
  const isE2ee = Boolean(memo.encryption)
  const isViolet = isDmMode || isE2ee

  const bars = useMemo(
    () => buildWaveformBars(memo.waveform, memo.sha256 || memo.url),
    [memo.waveform, memo.sha256, memo.url]
  )

  const codecLabel = codecLabelFromMime(memo.mime)
  const sizeText = formatByteSize(memo.size)
  const codecPill = sizeText ? `${codecLabel} · ${sizeText}` : codecLabel

  // Reset player cleanly if the underlying attachment changes
  useEffect(() => {
    setStatus('idle')
    setBlobUrl(null)
    setErrorMsg(null)
    setIsPlaying(false)
    setCurrentTime(0)
    setDuration(memo.durationSec > 0 ? memo.durationSec : 0)
    pendingSeekRatioRef.current = null
    const audio = audioRef.current
    if (audio) {
      releaseActiveAudio(audio)
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
  }, [memo.url, memo.sha256, memo.durationSec])

  // Stop playback immediately on unmount (including if sender is untrusted or Panic Wiped)
  useEffect(() => {
    mountedRef.current = true
    const audioEl = audioRef.current
    return () => {
      mountedRef.current = false
      if (audioEl) {
        releaseActiveAudio(audioEl)
        try {
          audioEl.pause()
          audioEl.removeAttribute('src')
          audioEl.load()
        } catch {
          // Ignore
        }
      }
    }
  }, [])

  // Keep playbackRate synced
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = speed
    }
  }, [speed])

  const loadAndPlay = async (seekRatio?: number) => {
    if (status === 'loading') return
    const audio = audioRef.current
    if (!audio) return

    // Already fetched and verified: toggle or seek
    if (blobUrl && status === 'ready') {
      const total =
        Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration
      if (seekRatio !== undefined && total > 0) {
        const nextTime = seekRatio * total
        audio.currentTime = nextTime
        setCurrentTime(nextTime)
      }
      if (seekRatio === undefined && !audio.paused) {
        audio.pause()
        return
      }
      audio.playbackRate = speed
      claimActiveAudio(audio)
      try {
        await audio.play()
      } catch {
        // Stay ready if browser blocked autoplay
      }
      return
    }

    // Lazy fetch, SHA-256 verify, and (if E2EE) AES-256-GCM decrypt
    setStatus('loading')
    setErrorMsg(null)
    if (seekRatio !== undefined) {
      pendingSeekRatioRef.current = seekRatio
    }

    try {
      const objectUrl = await fetchVoiceMemoBlob(memo, senderPubkey)
      if (!mountedRef.current) return

      setBlobUrl(objectUrl)
      setStatus('ready')

      const el = audioRef.current
      if (!el) return
      el.src = objectUrl
      el.playbackRate = speed
      claimActiveAudio(el)
      try {
        await el.play()
      } catch {
        // Ready to play on next tap if autoplay gesture expired during fetch
      }
    } catch (err) {
      if (!mountedRef.current) return
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : 'Unable to load voice memo.')
    }
  }

  const seekByClientX = (clientX: number, triggerLoadIfIdle = false) => {
    const track = waveRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))

    const audio = audioRef.current
    if (blobUrl && status === 'ready' && audio) {
      const total =
        Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration
      if (total > 0) {
        const nextTime = ratio * total
        audio.currentTime = nextTime
        setCurrentTime(nextTime)
      }
    } else if (triggerLoadIfIdle) {
      void loadAndPlay(ratio)
    }
  }

  const cycleSpeed = () => {
    setSpeedIdx((i) => (i + 1) % SPEED_STEPS.length)
  }

  const handleTranscribeClick = () => {
    if (!onTranscribeMemo) return
    if (memoTranscript?.status === 'done') {
      setTranscriptOpen((open) => !open)
      return
    }
    if (memoTranscript?.status === 'loading') return
    setTranscriptOpen(true)
    void onTranscribeMemo(memoKey, memo, senderPubkey)
  }

  const handleCopyTranscript = () => {
    const text = memoTranscript?.text?.trim()
    if (!text) return
    navigator.clipboard?.writeText(text).catch(() => {})
    setCopiedTranscript(true)
    window.setTimeout(() => setCopiedTranscript(false), 1400)
  }

  const isTranscribing = memoTranscript?.status === 'loading'
  const isDownloadingModel = isTranscribing && transcriptionModelStatus === 'downloading'
  const downloadPct = Math.max(0, Math.min(100, Math.round(transcriptionDownloadProgress)))
  const hasTranscript = memoTranscript?.status === 'done'
  const hasTranscriptError = memoTranscript?.status === 'error'
  const transcriptModelLabel = memoTranscript?.modelLabel || activeTranscriptionModelLabel

  const effectiveDuration = duration > 0 ? duration : memo.durationSec
  const progressRatio =
    effectiveDuration > 0 ? Math.min(1, Math.max(0, currentTime / effectiveDuration)) : 0

  return (
    <div
      className={`ag-voice-player ${isViolet ? 'dm' : ''} ${isPlaying ? 'playing' : ''} ${status === 'error' ? 'has-error' : ''}`}
      role="region"
      aria-label="Voice memo player"
    >
      <audio
        ref={audioRef}
        preload="none"
        onLoadedMetadata={(e) => {
          const el = e.currentTarget
          if (Number.isFinite(el.duration) && el.duration > 0) {
            setDuration(el.duration)
            if (pendingSeekRatioRef.current !== null) {
              const target = pendingSeekRatioRef.current * el.duration
              pendingSeekRatioRef.current = null
              el.currentTime = target
              setCurrentTime(target)
            }
          }
          el.playbackRate = speed
        }}
        onTimeUpdate={(e) => {
          setCurrentTime(e.currentTarget.currentTime)
        }}
        onPlay={() => setIsPlaying(true)}
        onPause={() => {
          setIsPlaying(false)
          releaseActiveAudio(audioRef.current)
        }}
        onEnded={() => {
          setIsPlaying(false)
          setCurrentTime(0)
          releaseActiveAudio(audioRef.current)
        }}
        onError={() => {
          setIsPlaying(false)
          if (blobUrl) {
            setStatus('error')
            setErrorMsg('Audio format could not be decoded by this browser.')
          }
        }}
      />

      <div className="ag-voice-player-main">
        <button
          type="button"
          className={`ag-voice-play-btn ${isViolet ? 'dm' : ''}`}
          onClick={() => void loadAndPlay()}
          disabled={status === 'loading'}
          aria-label={
            status === 'loading'
              ? 'Loading voice memo'
              : isPlaying
                ? 'Pause voice memo'
                : 'Play voice memo'
          }
          title={
            status === 'loading'
              ? isE2ee
                ? 'Fetching & decrypting audio…'
                : 'Fetching & verifying SHA-256…'
              : isPlaying
                ? 'Pause'
                : 'Play voice memo'
          }
        >
          {status === 'loading' ? (
            <Loader2 size={15} className="ag-spin" />
          ) : isPlaying ? (
            <Pause size={14} fill="currentColor" />
          ) : (
            <Play size={14} fill="currentColor" style={{ marginLeft: 1 }} />
          )}
        </button>

        <div className="ag-voice-track-col">
          <div
            ref={waveRef}
            className={`ag-voice-waveform interactive ${isViolet ? 'dm' : ''}`}
            role="slider"
            tabIndex={0}
            aria-label="Voice memo playback position"
            aria-valuemin={0}
            aria-valuemax={Math.round(effectiveDuration)}
            aria-valuenow={Math.round(currentTime)}
            onPointerDown={(e) => {
              draggingRef.current = true
              e.currentTarget.setPointerCapture(e.pointerId)
              seekByClientX(e.clientX, true)
            }}
            onPointerMove={(e) => {
              if (!draggingRef.current) return
              seekByClientX(e.clientX, false)
            }}
            onPointerUp={(e) => {
              draggingRef.current = false
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === ' ') {
                e.preventDefault()
                void loadAndPlay()
                return
              }
              const audio = audioRef.current
              if (!audio || status !== 'ready' || effectiveDuration <= 0) return
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault()
                const step = effectiveDuration > 20 ? 5 : 2
                const delta = e.key === 'ArrowRight' ? step : -step
                const next = Math.min(effectiveDuration, Math.max(0, audio.currentTime + delta))
                audio.currentTime = next
                setCurrentTime(next)
              } else if (e.key === 'Home') {
                e.preventDefault()
                audio.currentTime = 0
                setCurrentTime(0)
              } else if (e.key === 'End') {
                e.preventDefault()
                audio.currentTime = effectiveDuration
                setCurrentTime(effectiveDuration)
              }
            }}
          >
            {bars.map((peak, idx) => {
              const barPos = (idx + 0.5) / WAVEFORM_BARS
              const played = progressRatio > 0 && barPos <= progressRatio
              return (
                <span
                  key={idx}
                  className={`ag-voice-wave-bar ${played ? 'played' : ''}`}
                  style={{ height: `${peak}%` }}
                />
              )
            })}
          </div>

          <div className="ag-voice-meta-row">
            <span className="ag-voice-time mono tabular">
              {status === 'loading'
                ? isE2ee
                  ? 'Decrypting…'
                  : 'Verifying…'
                : `${formatVoiceDuration(currentTime)} / ${formatVoiceDuration(effectiveDuration)}`}
            </span>

            <div className="ag-voice-pills">
              <button
                type="button"
                className={`ag-voice-speed-btn mono tabular ${speed !== 1 ? 'boosted' : ''}`}
                onClick={cycleSpeed}
                title="Cycle playback speed (1×, 1.5×, 2×)"
                aria-label={`Playback speed ${speed}x`}
              >
                {speed}×
              </button>

              <span className="ag-badge muted tabular">{codecPill}</span>

              {isE2ee && (
                <span className="ag-badge dm" title="Client-side AES-256-GCM encrypted voice memo">
                  <Lock size={9} />
                  E2EE
                </span>
              )}

              {onTranscribeMemo && (
                <button
                  type="button"
                  className={`ag-voice-transcribe-btn ${isViolet ? 'dm' : ''} ${hasTranscript && transcriptOpen ? 'active' : ''}`}
                  onClick={handleTranscribeClick}
                  disabled={isTranscribing}
                  title={
                    isTranscribing
                      ? isDownloadingModel
                        ? `Loading ${activeTranscriptionModelLabel} (${downloadPct}%)`
                        : 'Transcribing locally in your browser…'
                      : hasTranscript
                        ? transcriptOpen
                          ? 'Hide transcript'
                          : 'Show transcript'
                        : `Transcribe locally with ${activeTranscriptionModelLabel}`
                  }
                  aria-label={
                    hasTranscript
                      ? transcriptOpen
                        ? 'Hide voice memo transcript'
                        : 'Show voice memo transcript'
                      : 'Transcribe voice memo locally'
                  }
                  aria-expanded={hasTranscript ? transcriptOpen : undefined}
                >
                  {isTranscribing ? (
                    <Loader2 size={11} className="ag-spin" />
                  ) : (
                    <Captions size={12} />
                  )}
                  <span>
                    {isTranscribing
                      ? isDownloadingModel
                        ? `${downloadPct}%`
                        : 'Working…'
                      : hasTranscript
                        ? transcriptOpen
                          ? 'Hide'
                          : 'Transcript'
                        : 'Transcribe'}
                  </span>
                  {hasTranscript &&
                    (transcriptOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Live Model Download / On-Device Transcription Progress */}
      {isTranscribing && (
        <div
          className={`ag-voice-transcribe-status ${isViolet ? 'dm' : ''}`}
          role="status"
          aria-live="polite"
        >
          <div className="ag-voice-transcribe-status-row">
            <Loader2 size={12} className="ag-spin" />
            <span className="truncate">
              {isDownloadingModel
                ? `Loading ${activeTranscriptionModelLabel} · ${downloadPct}%`
                : `Transcribing locally…`}
            </span>
          </div>
          {isDownloadingModel && (
            <div className="ag-voice-transcribe-progress" aria-hidden="true">
              <div
                className="ag-voice-transcribe-fill"
                style={{ width: `${Math.max(4, downloadPct)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Selectable Local Transcript Box */}
      {hasTranscript && transcriptOpen && (
        <div
          className={`ag-voice-transcript-box ${isViolet ? 'dm' : ''}`}
          role="region"
          aria-label="Voice memo transcript"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="ag-voice-transcript-head">
            <span className="ag-voice-transcript-model truncate">
              <Captions size={11} />
              <span>{transcriptModelLabel}</span>
              <span className="ag-voice-transcript-local">· On-device</span>
            </span>
            <div className="ag-voice-transcript-actions">
              {memoTranscript.text?.trim() && (
                <button
                  type="button"
                  className="ag-voice-transcript-act"
                  onClick={handleCopyTranscript}
                  title={copiedTranscript ? 'Copied transcript' : 'Copy transcript'}
                  aria-label="Copy transcript"
                >
                  {copiedTranscript ? <Check size={12} /> : <Copy size={12} />}
                  <span>{copiedTranscript ? 'Copied' : 'Copy'}</span>
                </button>
              )}
              <button
                type="button"
                className="ag-voice-transcript-act"
                onClick={() => setTranscriptOpen(false)}
                title="Hide transcript"
                aria-label="Hide transcript"
              >
                <ChevronUp size={12} />
              </button>
            </div>
          </div>

          {memoTranscript.text?.trim() ? (
            <p className="ag-voice-transcript-text">{memoTranscript.text.trim()}</p>
          ) : (
            <p className="ag-voice-transcript-empty">No speech detected in this clip.</p>
          )}
        </div>
      )}

      {/* Transcription Error Row */}
      {hasTranscriptError && (
        <div className="ag-voice-error-row" role="alert">
          <div className="ag-voice-error-msg">
            <AlertCircle size={13} style={{ flexShrink: 0 }} />
            <span>{memoTranscript.error || 'Unable to transcribe voice memo.'}</span>
          </div>
          {onTranscribeMemo && (
            <button
              type="button"
              className="ag-voice-retry-btn"
              onClick={() => {
                setTranscriptOpen(true)
                void onTranscribeMemo(memoKey, memo, senderPubkey)
              }}
            >
              <RotateCw size={12} />
              <span>Retry</span>
            </button>
          )}
        </div>
      )}

      {status === 'error' && (
        <div className="ag-voice-error-row" role="alert">
          <div className="ag-voice-error-msg">
            <AlertCircle size={13} style={{ flexShrink: 0 }} />
            <span>{errorMsg || 'Failed to load voice memo.'}</span>
          </div>
          <button
            type="button"
            className="ag-voice-retry-btn"
            onClick={() => void loadAndPlay()}
          >
            <RotateCw size={12} />
            <span>Retry</span>
          </button>
        </div>
      )}
    </div>
  )
}

export const VoiceMemoPlayer: React.FC<VoiceMemoPlayerProps> = React.memo((props) => {
  // CRITICAL SAFETY GATE: Untrusted senders ALWAYS render an inert card with zero <audio> & zero fetches.
  if (!props.isTrusted) {
    return (
      <ShieldedVoiceCard
        memo={props.memo}
        senderPubkey={props.senderPubkey}
        senderNickname={props.senderNickname}
        senderDisplayHandle={props.senderDisplayHandle}
        isDmMode={props.isDmMode}
        onTrustSender={props.onTrustSender}
        onInspectSender={props.onInspectSender}
        onBlockSender={props.onBlockSender}
      />
    )
  }

  return (
    <TrustedVoicePlayer
      memo={props.memo}
      memoKey={props.memoKey || props.memo.sha256 || props.memo.url}
      senderPubkey={props.senderPubkey}
      isDmMode={props.isDmMode}
      fetchVoiceMemoBlob={props.fetchVoiceMemoBlob}
      memoTranscript={props.memoTranscript}
      transcriptionModelStatus={props.transcriptionModelStatus}
      transcriptionDownloadProgress={props.transcriptionDownloadProgress}
      activeTranscriptionModelLabel={props.activeTranscriptionModelLabel}
      onTranscribeMemo={props.onTranscribeMemo}
    />
  )
})

VoiceMemoPlayer.displayName = 'VoiceMemoPlayer'

export default VoiceMemoPlayer
