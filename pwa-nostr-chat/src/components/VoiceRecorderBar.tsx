import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Captions,
  Loader2,
  Lock,
  MessageSquareText,
  Mic,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  Square,
  Trash2,
} from 'lucide-react'
import type { RecordedVoiceMemo, VoiceSendPhase } from '../types/protocol'
import type { TranscriptionEngine } from '../types/transcription'
import {
  formatVoiceDuration,
  MAX_VOICE_DURATION_SEC,
  revokeVoicePreviewUrl,
  VoiceRecorderController,
  WAVEFORM_BARS,
} from '../lib/voiceRecorder'

export interface VoicePreviewTranscript {
  text: string
  modelLabel: string
}

export interface VoiceRecorderBarProps {
  isDm: boolean
  hasBanner: boolean
  sending: boolean
  voiceSendPhase: VoiceSendPhase
  transcription: TranscriptionEngine
  onSend: (
    recorded: RecordedVoiceMemo,
    caption: string,
    previewTranscript?: VoicePreviewTranscript
  ) => Promise<boolean>
  onSendText: (text: string) => Promise<boolean>
  onCancel: () => void
  onErrorToast?: (title: string, detail?: string) => void
}

type RecorderStage = 'starting' | 'recording' | 'preview' | 'error'
type PreviewTranscriptStatus = 'idle' | 'transcribing' | 'done' | 'error'

const INITIAL_LIVE_BARS: number[] = Array.from({ length: WAVEFORM_BARS }, () => 8)

const SEND_PHASE_LABEL: Record<VoiceSendPhase, string> = {
  idle: 'Send Voice',
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
  transcription,
  onSend,
  onSendText,
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

  // Pre-send voice transcription preview state
  const [transcriptStatus, setTranscriptStatus] = useState<PreviewTranscriptStatus>('idle')
  const [transcriptText, setTranscriptText] = useState('')
  const [transcriptModelLabel, setTranscriptModelLabel] = useState('')
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [transcriptEmpty, setTranscriptEmpty] = useState(false)
  const [sendingText, setSendingText] = useState(false)

  const controllerRef = useRef<VoiceRecorderController | null>(null)
  const recordedRef = useRef<RecordedVoiceMemo | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const waveTrackRef = useRef<HTMLDivElement | null>(null)
  const captionInputRef = useRef<HTMLInputElement | null>(null)
  const transcriptInputRef = useRef<HTMLTextAreaElement | null>(null)
  const onErrorToastRef = useRef(onErrorToast)
  const transcriptionRef = useRef(transcription)
  const transcribedBlobRef = useRef<Blob | null>(null)
  const transcriptJobRef = useRef(0)
  const sessionIdRef = useRef(0)
  const stoppingRef = useRef(false)
  const draggingRef = useRef(false)

  useEffect(() => {
    onErrorToastRef.current = onErrorToast
  }, [onErrorToast])

  useEffect(() => {
    transcriptionRef.current = transcription
  }, [transcription])

  const resetTranscriptState = useCallback(() => {
    transcriptJobRef.current += 1
    transcribedBlobRef.current = null
    setTranscriptStatus('idle')
    setTranscriptText('')
    setTranscriptModelLabel('')
    setTranscriptError(null)
    setTranscriptEmpty(false)
  }, [])

  const runPreviewTranscription = useCallback(async (blob: Blob) => {
    const jobId = ++transcriptJobRef.current
    transcribedBlobRef.current = blob
    const engine = transcriptionRef.current
    setTranscriptStatus('transcribing')
    setTranscriptError(null)
    setTranscriptEmpty(false)
    setTranscriptModelLabel(engine.activeModel.label)

    try {
      const rawText = await engine.transcribeAudioBlob(blob)
      if (transcriptJobRef.current !== jobId) return
      const cleaned = rawText.trim()
      setTranscriptModelLabel(transcriptionRef.current.activeModel.label)
      setTranscriptText(cleaned)
      setTranscriptEmpty(cleaned.length === 0)
      setTranscriptStatus('done')
    } catch (err) {
      if (transcriptJobRef.current !== jobId) return
      const msg =
        err instanceof Error && err.message.trim()
          ? err.message.trim()
          : 'Could not transcribe voice memo.'
      setTranscriptError(msg)
      setTranscriptStatus('error')
    }
  }, [])

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
    resetTranscriptState()
    if (recordedRef.current) {
      revokeVoicePreviewUrl(recordedRef.current)
      recordedRef.current = null
    }
    setRecorded(null)
    setPreviewDuration(0)
  }, [stopPreviewAudio, resetTranscriptState])

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
      transcriptJobRef.current += 1
      controllerRef.current?.cancel()
      controllerRef.current = null
      if (recordedRef.current) {
        revokeVoicePreviewUrl(recordedRef.current)
        recordedRef.current = null
      }
    }
  }, [beginRecording])

  // Auto-transcribe once per recorded blob when autoTranscribe is enabled
  useEffect(() => {
    if (stage !== 'preview' || !recorded) return
    if (!transcription.autoTranscribe) return
    if (transcribedBlobRef.current === recorded.blob) return
    void runPreviewTranscription(recorded.blob)
  }, [stage, recorded, transcription.autoTranscribe, runPreviewTranscription])

  // Auto-size editable transcript textarea cleanly (2-4 rows)
  useEffect(() => {
    const el = transcriptInputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 52), 104)}px`
  }, [transcriptText, transcriptStatus])

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

  const isUploading = sending || voiceSendPhase !== 'idle'
  const isBusy = isUploading || sendingText

  const handleCancel = useCallback(() => {
    if (sending || sendingText) return
    sessionIdRef.current += 1
    controllerRef.current?.cancel()
    controllerRef.current = null
    discardRecordedMemo()
    onCancel()
  }, [sending, sendingText, discardRecordedMemo, onCancel])

  // Escape key cancels when not actively uploading/sending
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !sending && !sendingText) {
        e.preventDefault()
        handleCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sending, sendingText, handleCancel])

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
    if (!recorded || isBusy) return
    const audio = previewAudioRef.current
    if (audio && !audio.paused) {
      audio.pause()
      setPreviewPlaying(false)
    }
    const cleanTranscript = transcriptText.trim()
    const previewTranscript: VoicePreviewTranscript | undefined =
      transcriptStatus === 'done' && cleanTranscript.length > 0
        ? {
            text: cleanTranscript,
            modelLabel: transcriptModelLabel || transcription.activeModel.label,
          }
        : undefined
    const ok = await onSend(recorded, caption, previewTranscript)
    if (ok) {
      sessionIdRef.current += 1
      discardRecordedMemo()
      onCancel()
    }
  }

  const handleSendText = async () => {
    const cleanText = transcriptText.trim()
    if (!cleanText || isBusy) return
    const audio = previewAudioRef.current
    if (audio && !audio.paused) {
      audio.pause()
      setPreviewPlaying(false)
    }
    setSendingText(true)
    try {
      const ok = await onSendText(cleanText)
      if (ok) {
        sessionIdRef.current += 1
        discardRecordedMemo()
        onCancel()
      }
    } finally {
      setSendingText(false)
    }
  }

  const sendLabel =
    voiceSendPhase !== 'idle'
      ? SEND_PHASE_LABEL[voiceSendPhase]
      : sending
        ? 'Sending…'
        : 'Send Voice'

  const activeModelLabel = transcription.activeModel.label
  const shownModelLabel = transcriptModelLabel || activeModelLabel
  const modelChangedSinceRun =
    transcriptStatus === 'done' &&
    Boolean(transcriptModelLabel) &&
    transcriptModelLabel !== activeModelLabel
  const isDownloadingModel = transcription.modelStatus === 'downloading'
  const downloadPct = Math.max(0, Math.min(100, Math.round(transcription.downloadProgress)))
  const hasEditableTranscript = transcriptStatus === 'done' && (!transcriptEmpty || transcriptText.length > 0)
  const canSendText = hasEditableTranscript && transcriptText.trim().length > 0

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
              disabled={isBusy}
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
              disabled={isBusy}
              title="Re-record voice memo"
              aria-label="Re-record voice memo"
            >
              <RotateCcw size={14} />
            </button>
          </div>

          {/* Pre-Send On-Device Transcription Preview */}
          <div
            className={`ag-vrec-transcript-box ${isDm ? 'dm' : ''} status-${transcriptStatus}`}
            role="region"
            aria-label="Voice memo transcription preview"
          >
            {transcriptStatus === 'idle' && (
              <div className="ag-vrec-transcript-bar">
                <div className="ag-vrec-transcript-meta truncate">
                  <Captions size={13} className="ag-vrec-transcript-icon" aria-hidden="true" />
                  <span className="truncate">Preview transcript with</span>
                  <span className="ag-vrec-transcript-model truncate">{activeModelLabel}</span>
                </div>
                <button
                  type="button"
                  className={`ag-vrec-preview-btn ${isDm ? 'dm' : ''}`}
                  onClick={() => void runPreviewTranscription(recorded.blob)}
                  disabled={isBusy}
                >
                  <Captions size={13} />
                  <span>Preview Transcript</span>
                </button>
              </div>
            )}

            {transcriptStatus === 'transcribing' && (
              <div className="ag-vrec-transcript-loading">
                <div className="ag-vrec-transcript-bar">
                  <div className="ag-vrec-transcript-meta truncate">
                    <Loader2 size={13} className="ag-spin ag-vrec-transcript-icon" aria-hidden="true" />
                    <span className="truncate">
                      {isDownloadingModel
                        ? `Loading ${activeModelLabel} · ${downloadPct}%`
                        : `Transcribing with ${activeModelLabel}…`}
                    </span>
                  </div>
                  <span className="ag-vrec-transcript-hint ag-desktop-only">
                    You can still send voice now
                  </span>
                </div>
                {isDownloadingModel && (
                  <div className="ag-vrec-transcript-progress" aria-hidden="true">
                    <div
                      className="ag-vrec-transcript-progress-fill"
                      style={{ width: `${Math.max(4, downloadPct)}%` }}
                    />
                  </div>
                )}
              </div>
            )}

            {transcriptStatus === 'error' && (
              <div className="ag-vrec-transcript-bar error">
                <div className="ag-vrec-transcript-meta truncate" title={transcriptError ?? undefined}>
                  <AlertCircle size={13} className="ag-vrec-transcript-icon" aria-hidden="true" />
                  <span className="truncate">
                    {transcriptError ?? 'Unable to transcribe preview.'}
                  </span>
                </div>
                <button
                  type="button"
                  className="ag-vrec-mini-btn"
                  onClick={() => void runPreviewTranscription(recorded.blob)}
                  disabled={isBusy}
                >
                  <RefreshCw size={12} />
                  <span>Retry</span>
                </button>
              </div>
            )}

            {transcriptStatus === 'done' && !hasEditableTranscript && (
              <div className="ag-vrec-transcript-bar">
                <div className="ag-vrec-transcript-meta truncate">
                  <Captions size={13} className="ag-vrec-transcript-icon" aria-hidden="true" />
                  <span className="truncate">No speech detected</span>
                  <span className="ag-vrec-transcript-model truncate">{shownModelLabel}</span>
                </div>
                <button
                  type="button"
                  className="ag-vrec-mini-btn"
                  onClick={() => void runPreviewTranscription(recorded.blob)}
                  disabled={isBusy}
                  title={`Re-transcribe with ${activeModelLabel}`}
                >
                  <RefreshCw size={12} />
                  <span>Retry</span>
                </button>
              </div>
            )}

            {hasEditableTranscript && (
              <div className="ag-vrec-transcript-editor">
                <div className="ag-vrec-transcript-head">
                  <div className="ag-vrec-transcript-head-left truncate">
                    <Captions size={12} className="ag-vrec-transcript-icon" aria-hidden="true" />
                    <span className="ag-vrec-transcript-label">Transcript</span>
                    <span className="ag-vrec-transcript-model truncate" title={shownModelLabel}>
                      {shownModelLabel}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ag-vrec-mini-btn"
                    onClick={() => void runPreviewTranscription(recorded.blob)}
                    disabled={isBusy}
                    title={`Re-transcribe with ${activeModelLabel}`}
                    aria-label={`Re-transcribe with ${activeModelLabel}`}
                  >
                    <RefreshCw size={11} />
                    <span>{modelChangedSinceRun ? `Re-run (${activeModelLabel})` : 'Retry'}</span>
                  </button>
                </div>
                <textarea
                  ref={transcriptInputRef}
                  rows={2}
                  className="ag-vrec-transcript-input"
                  value={transcriptText}
                  disabled={isBusy}
                  onChange={(e) => setTranscriptText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault()
                      void handleSendText()
                    }
                  }}
                  placeholder="Edit transcript to send as text…"
                  aria-label="Edit voice memo transcript"
                />
              </div>
            )}
          </div>

          <div className="ag-vrec-caption-row">
            <input
              ref={captionInputRef}
              type="text"
              maxLength={240}
              className="ag-vrec-caption-input"
              value={caption}
              disabled={isBusy}
              onChange={(e) => setCaption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSend()
                }
              }}
              placeholder={
                isDm
                  ? 'Optional encrypted caption…'
                  : 'Optional voice caption…'
              }
              aria-label="Optional voice memo caption"
            />

            <div className="ag-vrec-footer-actions">
              <button
                type="button"
                className="ag-vrec-btn discard"
                onClick={handleCancel}
                disabled={isBusy}
                title="Discard voice memo"
                aria-label="Discard voice memo"
              >
                <Trash2 size={14} />
                <span className="ag-desktop-only">Discard</span>
              </button>

              {(hasEditableTranscript || sendingText) && (
                <button
                  type="button"
                  className={`ag-vrec-send-text-btn ${isDm ? 'dm' : ''}`}
                  onClick={() => void handleSendText()}
                  disabled={isBusy || !canSendText}
                  title="Send transcript as text only (skips voice upload · ⌘↵)"
                  aria-label="Send transcript as text"
                >
                  {sendingText ? (
                    <Loader2 size={14} className="ag-spin" />
                  ) : (
                    <MessageSquareText size={14} />
                  )}
                  <span>{sendingText ? 'Sending…' : 'Send Text'}</span>
                </button>
              )}

              <button
                type="button"
                className={`ag-send-btn ${isDm ? 'dm' : ''}`}
                onClick={() => void handleSend()}
                disabled={isBusy}
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
