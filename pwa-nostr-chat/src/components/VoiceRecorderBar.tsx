import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Loader2,
  Lock,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Send,
  Square,
  Trash2,
} from 'lucide-react'
import type { RecordedVoiceMemo, VoiceSendPhase } from '../types/protocol'
import {
  formatVoiceDuration,
  MAX_VOICE_DURATION_SEC,
  revokeVoicePreviewUrl,
  VoiceRecorderController,
  WAVEFORM_BARS,
} from '../lib/voiceRecorder'

export interface VoiceRecorderBarProps {
  isDm: boolean
  hasBanner: boolean
  sending: boolean
  voiceSendPhase: VoiceSendPhase
  onSend: (recorded: RecordedVoiceMemo, caption: string) => Promise<boolean>
  onCancel: () => void
  onErrorToast?: (title: string, detail?: string) => void
}

type RecorderStage = 'starting' | 'recording' | 'preview' | 'error'

const INITIAL_LIVE_BARS: number[] = Array.from({ length: WAVEFORM_BARS }, () => 8)

const SEND_PHASE_LABEL: Record<VoiceSendPhase, string> = {
  idle: 'Send',
  encrypting: 'Encrypting…',
  uploading: 'Uploading…',
  signing: 'Signing…',
  publishing: 'Publishing…',
}

function formatByteSize(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function normalizeBars(bars: readonly number[]): number[] {
  if (bars.length === WAVEFORM_BARS) return [...bars]
  if (bars.length === 0) return [...INITIAL_LIVE_BARS]
  const out: number[] = []
  for (let i = 0; i < WAVEFORM_BARS; i++) {
    const idx = Math.min(bars.length - 1, Math.floor((i / WAVEFORM_BARS) * bars.length))
    out.push(Math.max(8, Math.min(100, Math.round(bars[idx]))))
  }
  return out
}

export const VoiceRecorderBar: React.FC<VoiceRecorderBarProps> = ({
  isDm,
  hasBanner,
  sending,
  voiceSendPhase,
  onSend,
  onCancel,
  onErrorToast,
}) => {
  const [stage, setStage] = useState<RecorderStage>('starting')
  const [liveBars, setLiveBars] = useState<number[]>(INITIAL_LIVE_BARS)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [recorded, setRecorded] = useState<RecordedVoiceMemo | null>(null)
  const [caption, setCaption] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Local preview playback state
  const [previewPlaying, setPreviewPlaying] = useState(false)
  const [previewTime, setPreviewTime] = useState(0)
  const [previewDuration, setPreviewDuration] = useState(0)

  const controllerRef = useRef<VoiceRecorderController | null>(null)
  const recordedRef = useRef<RecordedVoiceMemo | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const waveTrackRef = useRef<HTMLDivElement | null>(null)
  const captionInputRef = useRef<HTMLInputElement | null>(null)
  const onErrorToastRef = useRef(onErrorToast)
  const sessionIdRef = useRef(0)
  const stoppingRef = useRef(false)
  const draggingRef = useRef(false)

  useEffect(() => {
    onErrorToastRef.current = onErrorToast
  }, [onErrorToast])

  const stopPreviewAudio = useCallback(() => {
    const audio = previewAudioRef.current
    if (audio) {
      try {
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      } catch {
        // Ignore browser media element cleanup quirks
      }
    }
    setPreviewPlaying(false)
    setPreviewTime(0)
  }, [])

  const discardRecordedMemo = useCallback(() => {
    stopPreviewAudio()
    if (recordedRef.current) {
      revokeVoicePreviewUrl(recordedRef.current)
      recordedRef.current = null
    }
    setRecorded(null)
    setPreviewDuration(0)
  }, [stopPreviewAudio])

  const beginRecording = useCallback(() => {
    const sid = ++sessionIdRef.current
    stoppingRef.current = false

    controllerRef.current?.cancel()
    controllerRef.current = null
    discardRecordedMemo()

    setStage('starting')
    setErrorMsg(null)
    setElapsedSec(0)
    setLiveBars(INITIAL_LIVE_BARS)

    const ctrl = new VoiceRecorderController()
    controllerRef.current = ctrl

    void ctrl
      .start({
        onLevel: (_level, bars, sec) => {
          if (sessionIdRef.current !== sid) return
          setStage('recording')
          setLiveBars(bars)
          setElapsedSec(sec)
        },
        onAutoStop: (rec) => {
          if (sessionIdRef.current !== sid) {
            revokeVoicePreviewUrl(rec)
            return
          }
          recordedRef.current = rec
          setRecorded(rec)
          setPreviewDuration(rec.durationSec)
          setPreviewTime(0)
          setPreviewPlaying(false)
          setStage('preview')
        },
        onError: (err) => {
          if (sessionIdRef.current !== sid) return
          setErrorMsg(err.message || 'Microphone recording error.')
          setStage('error')
        },
      })
      .then(() => {
        if (sessionIdRef.current !== sid) {
          ctrl.cancel()
          return
        }
        setStage('recording')
      })
      .catch((err) => {
        ctrl.cancel()
        if (sessionIdRef.current !== sid) return
        const msg =
          err instanceof DOMException &&
          (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
            ? 'Microphone permission denied — allow mic access in browser settings.'
            : err instanceof DOMException && err.name === 'NotFoundError'
              ? 'No microphone input device detected.'
              : err instanceof Error
                ? err.message
                : 'Could not start microphone recording.'
        setErrorMsg(msg)
        setStage('error')
        onErrorToastRef.current?.('Microphone unavailable', msg)
      })

    return sid
  }, [discardRecordedMemo])

  // Start recording on mount and ALWAYS stop mic tracks + revoke preview URL on unmount
  useEffect(() => {
    const sid = beginRecording()
    return () => {
      sessionIdRef.current = sid + 1
      controllerRef.current?.cancel()
      controllerRef.current = null
      if (recordedRef.current) {
        revokeVoicePreviewUrl(recordedRef.current)
        recordedRef.current = null
      }
    }
  }, [beginRecording])

  // Ensure preview <audio> element is paused and cleared whenever preview ends or unmounts
  useEffect(() => {
    const audioEl = previewAudioRef.current
    return () => {
      if (audioEl) {
        try {
          audioEl.pause()
          audioEl.removeAttribute('src')
          audioEl.load()
        } catch {
          // Ignore
        }
      }
    }
  }, [recorded])

  const handleCancel = useCallback(() => {
    if (sending) return
    sessionIdRef.current += 1
    controllerRef.current?.cancel()
    controllerRef.current = null
    discardRecordedMemo()
    onCancel()
  }, [sending, discardRecordedMemo, onCancel])

  // Escape key cancels when not actively uploading/sending
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !sending) {
        e.preventDefault()
        handleCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sending, handleCancel])

  const handleStopToPreview = async () => {
    if (stoppingRef.current || stage !== 'recording') return
    stoppingRef.current = true
    const sid = sessionIdRef.current
    try {
      const rec = await controllerRef.current?.stop()
      if (sessionIdRef.current !== sid) {
        revokeVoicePreviewUrl(rec)
        return
      }
      if (!rec || rec.size <= 0) {
        setErrorMsg('Recording was empty — try speaking for a moment before stopping.')
        setStage('error')
        return
      }
      recordedRef.current = rec
      setRecorded(rec)
      setPreviewDuration(rec.durationSec)
      setPreviewTime(0)
      setPreviewPlaying(false)
      setStage('preview')
    } finally {
      stoppingRef.current = false
    }
  }

  const togglePreviewPlayback = () => {
    const audio = previewAudioRef.current
    if (!audio || !recorded) return
    if (previewPlaying) {
      audio.pause()
      setPreviewPlaying(false)
    } else {
      void audio
        .play()
        .then(() => setPreviewPlaying(true))
        .catch(() => setPreviewPlaying(false))
    }
  }

  const seekPreviewByClientX = (clientX: number) => {
    const track = waveTrackRef.current
    const audio = previewAudioRef.current
    if (!track || !audio || !recorded) return
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const total =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : previewDuration || recorded.durationSec
    if (total > 0) {
      const nextTime = ratio * total
      audio.currentTime = nextTime
      setPreviewTime(nextTime)
    }
  }

  const handleSend = async () => {
    if (!recorded || sending) return
    const audio = previewAudioRef.current
    if (audio && !audio.paused) {
      audio.pause()
      setPreviewPlaying(false)
    }
    const ok = await onSend(recorded, caption)
    if (ok) {
      sessionIdRef.current += 1
      discardRecordedMemo()
      onCancel()
    }
  }

  const isUploading = sending || voiceSendPhase !== 'idle'
  const sendLabel =
    voiceSendPhase !== 'idle'
      ? SEND_PHASE_LABEL[voiceSendPhase]
      : sending
        ? 'Sending…'
        : 'Send'

  const effectivePreviewDuration =
    previewDuration > 0 ? previewDuration : (recorded?.durationSec ?? 0)
  const previewRatio =
    effectivePreviewDuration > 0
      ? Math.min(1, Math.max(0, previewTime / effectivePreviewDuration))
      : 0
  const nearLimit = elapsedSec >= MAX_VOICE_DURATION_SEC - 15

  return (
    <div
      className={`ag-voice-recorder-bar ${hasBanner ? 'with-banner' : ''} ${isDm ? 'dm' : ''} stage-${stage}`}
      role="region"
      aria-label="Voice memo recorder"
    >
      {/* Starting / Requesting Mic State */}
      {stage === 'starting' && (
        <div className="ag-vrec-row">
          <div className="ag-vrec-status">
            <Loader2 size={15} className="ag-spin" style={{ color: isDm ? 'var(--dm-accent)' : 'var(--accent)' }} />
            <span className="mono">Requesting microphone…</span>
            {isDm && (
              <span className="ag-badge dm">
                <Lock size={9} />
                E2EE VOICE
              </span>
            )}
          </div>
          <button
            type="button"
            className="ag-vrec-btn discard"
            onClick={handleCancel}
            aria-label="Cancel voice recording"
          >
            <Trash2 size={14} />
            <span>Cancel</span>
          </button>
        </div>
      )}

      {/* Active Recording State */}
      {stage === 'recording' && (
        <div className="ag-vrec-row">
          <div className="ag-vrec-rec-meta">
            <span className="ag-rec-led" aria-hidden="true" />
            <span className="ag-vrec-rec-label mono">REC</span>
            {isDm && (
              <span className="ag-badge dm ag-desktop-only">
                <Lock size={9} />
                E2EE VOICE
              </span>
            )}
          </div>

          <div
            className="ag-vrec-meter"
            role="meter"
            aria-label="Live microphone input level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={liveBars[liveBars.length - 1] ?? 0}
          >
            {normalizeBars(liveBars).map((val, idx) => (
              <span
                key={idx}
                className={`ag-vrec-bar ${val >= 72 ? 'hot' : ''}`}
                style={{ height: `${Math.max(12, Math.min(100, val))}%` }}
              />
            ))}
          </div>

          <span className={`ag-vrec-timer mono tabular ${nearLimit ? 'warn' : ''}`}>
            {formatVoiceDuration(elapsedSec)}
            <span className="ag-vrec-timer-max"> / {formatVoiceDuration(MAX_VOICE_DURATION_SEC)}</span>
          </span>

          <div className="ag-vrec-actions">
            <button
              type="button"
              className="ag-vrec-btn discard"
              onClick={handleCancel}
              title="Discard recording (Esc)"
              aria-label="Discard recording"
            >
              <Trash2 size={14} />
              <span className="ag-desktop-only">Discard</span>
            </button>
            <button
              type="button"
              className="ag-vrec-btn stop"
              onClick={() => void handleStopToPreview()}
              title="Stop and preview voice memo"
              aria-label="Stop recording to preview"
            >
              <Square size={12} fill="currentColor" />
              <span>Stop</span>
            </button>
          </div>
        </div>
      )}

      {/* Preview & Caption State */}
      {stage === 'preview' && recorded && (
        <div className="ag-vrec-preview-wrap">
          <audio
            ref={previewAudioRef}
            src={recorded.previewUrl}
            preload="metadata"
            onLoadedMetadata={(e) => {
              const dur = e.currentTarget.duration
              if (Number.isFinite(dur) && dur > 0) {
                setPreviewDuration(dur)
              }
            }}
            onTimeUpdate={(e) => {
              setPreviewTime(e.currentTarget.currentTime)
            }}
            onEnded={() => {
              setPreviewPlaying(false)
              setPreviewTime(0)
            }}
            onPause={() => setPreviewPlaying(false)}
            onPlay={() => setPreviewPlaying(true)}
          />

          <div className="ag-vrec-row">
            <button
              type="button"
              className={`ag-voice-play-btn ${isDm ? 'dm' : ''}`}
              onClick={togglePreviewPlayback}
              disabled={isUploading}
              aria-label={previewPlaying ? 'Pause preview' : 'Play preview'}
              title={previewPlaying ? 'Pause preview' : 'Listen to preview'}
            >
              {previewPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
            </button>

            <div
              ref={waveTrackRef}
              className={`ag-voice-waveform interactive ${isDm ? 'dm' : ''}`}
              role="slider"
              tabIndex={0}
              aria-label="Preview voice memo position"
              aria-valuemin={0}
              aria-valuemax={Math.round(effectivePreviewDuration)}
              aria-valuenow={Math.round(previewTime)}
              onPointerDown={(e) => {
                draggingRef.current = true
                e.currentTarget.setPointerCapture(e.pointerId)
                seekPreviewByClientX(e.clientX)
              }}
              onPointerMove={(e) => {
                if (!draggingRef.current) return
                seekPreviewByClientX(e.clientX)
              }}
              onPointerUp={(e) => {
                draggingRef.current = false
                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                  e.currentTarget.releasePointerCapture(e.pointerId)
                }
              }}
              onKeyDown={(e) => {
                const audio = previewAudioRef.current
                if (!audio || effectivePreviewDuration <= 0) return
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault()
                  const delta = e.key === 'ArrowRight' ? 2 : -2
                  const next = Math.min(effectivePreviewDuration, Math.max(0, audio.currentTime + delta))
                  audio.currentTime = next
                  setPreviewTime(next)
                } else if (e.key === ' ') {
                  e.preventDefault()
                  togglePreviewPlayback()
                }
              }}
            >
              {normalizeBars(recorded.waveform).map((peak, idx) => {
                const barPos = (idx + 0.5) / WAVEFORM_BARS
                const played = previewRatio > 0 && barPos <= previewRatio
                return (
                  <span
                    key={idx}
                    className={`ag-voice-wave-bar ${played ? 'played' : ''}`}
                    style={{ height: `${Math.max(14, Math.min(100, peak))}%` }}
                  />
                )
              })}
            </div>

            <div className="ag-vrec-preview-meta">
              <span className="ag-vrec-timer mono tabular">
                {formatVoiceDuration(previewTime)} / {formatVoiceDuration(effectivePreviewDuration)}
              </span>
              <span className="ag-badge muted ag-desktop-only">{formatByteSize(recorded.size)}</span>
              {isDm && (
                <span className="ag-badge dm">
                  <Lock size={9} />
                  E2EE VOICE
                </span>
              )}
            </div>

            <button
              type="button"
              className="ag-icon-btn"
              onClick={() => beginRecording()}
              disabled={isUploading}
              title="Re-record voice memo"
              aria-label="Re-record voice memo"
            >
              <RotateCcw size={14} />
            </button>
          </div>

          <div className="ag-vrec-caption-row">
            <input
              ref={captionInputRef}
              type="text"
              maxLength={240}
              className="ag-vrec-caption-input"
              value={caption}
              disabled={isUploading}
              onChange={(e) => setCaption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSend()
                }
              }}
              placeholder={
                isDm
                  ? 'Optional encrypted caption… (Enter to send)'
                  : 'Optional caption… (Enter to broadcast)'
              }
              aria-label="Optional voice memo caption"
            />

            <button
              type="button"
              className="ag-vrec-btn discard"
              onClick={handleCancel}
              disabled={isUploading}
              title="Discard voice memo"
              aria-label="Discard voice memo"
            >
              <Trash2 size={14} />
              <span className="ag-desktop-only">Discard</span>
            </button>

            <button
              type="button"
              className={`ag-send-btn ${isDm ? 'dm' : ''}`}
              onClick={() => void handleSend()}
              disabled={isUploading}
              aria-label={sendLabel}
            >
              {isUploading ? (
                <Loader2 size={14} className="ag-spin" />
              ) : (
                <Send size={14} />
              )}
              <span>{sendLabel}</span>
            </button>
          </div>
        </div>
      )}

      {/* Error State */}
      {stage === 'error' && (
        <div className="ag-vrec-row">
          <div className="ag-vrec-status error">
            <AlertCircle size={15} style={{ flexShrink: 0 }} />
            <span className="truncate">{errorMsg ?? 'Unable to record voice memo.'}</span>
          </div>
          <div className="ag-vrec-actions">
            <button
              type="button"
              className="ag-vrec-btn retry"
              onClick={() => beginRecording()}
            >
              <Mic size={13} />
              <span>Retry</span>
            </button>
            <button
              type="button"
              className="ag-vrec-btn discard"
              onClick={handleCancel}
            >
              <span>Close</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default VoiceRecorderBar
