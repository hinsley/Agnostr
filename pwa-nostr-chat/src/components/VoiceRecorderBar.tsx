import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowUp,
  Captions,
  Loader2,
  Lock,
  MessageSquareText,
  Mic,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
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
} from '../lib/voiceRecorder'

export interface VoicePreviewTranscript {
  text: string
  modelLabel: string
}

export interface VoiceRecorderBarProps {
  isDm: boolean
  hasBanner: boolean
  sending?: boolean
  voiceSendPhase?: VoiceSendPhase
  transcription: TranscriptionEngine
  onSend: (
    recorded: RecordedVoiceMemo,
    caption: string,
    previewTranscript?: VoicePreviewTranscript
  ) => Promise<boolean> | void
  onSendText: (text: string) => Promise<boolean> | void
  onCancel: () => void
  onErrorToast?: (title: string, detail?: string) => void
}

type RecorderStage = 'starting' | 'recording' | 'preview' | 'error'
type PreviewTranscriptStatus = 'idle' | 'transcribing' | 'done' | 'error'

const PREVIEW_WAVE_BARS = 64
const LIVE_BAR_WIDTH = 2.5
const LIVE_BAR_GAP = 2.5
const LIVE_BAR_STRIDE = LIVE_BAR_WIDTH + LIVE_BAR_GAP
const LIVE_SCROLL_PX_PER_SEC = 54
const MAX_HISTORY_BARS = 220

/**
 * Smoothly interpolates protocol waveform peaks (typically 32 bars) into a
 * slender high-resolution bar array for crisp continuous clip-path scrubbing.
 */
function interpolateWaveformBars(raw: readonly number[], targetCount = PREVIEW_WAVE_BARS): number[] {
  if (raw.length === 0) {
    return Array.from({ length: targetCount }, () => 18)
  }
  if (raw.length === 1) {
    const val = Math.max(14, Math.min(100, Math.round(raw[0])))
    return Array.from({ length: targetCount }, () => val)
  }
  const out: number[] = []
  const lastIdx = raw.length - 1
  for (let i = 0; i < targetCount; i++) {
    const pos = (i / (targetCount - 1)) * lastIdx
    const lo = Math.floor(pos)
    const hi = Math.min(lastIdx, lo + 1)
    const frac = pos - lo
    const interp = raw[lo] * (1 - frac) + raw[hi] * frac
    out.push(Math.max(14, Math.min(100, Math.round(interp))))
  }
  return out
}

function drawRoundedPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius)
  } else {
    ctx.moveTo(x + radius, y)
    ctx.lineTo(x + w - radius, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
    ctx.lineTo(x + w, y + h - radius)
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
    ctx.lineTo(x + radius, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
    ctx.lineTo(x, y + radius)
    ctx.quadraticCurveTo(x, y, x + radius, y)
    ctx.closePath()
  }
  ctx.fill()
}

export const VoiceRecorderBar: React.FC<VoiceRecorderBarProps> = ({
  isDm,
  hasBanner,
  transcription,
  onSend,
  onSendText,
  onCancel,
  onErrorToast,
}) => {
  const [stage, setStage] = useState<RecorderStage>('starting')
  const [flushingSend, setFlushingSend] = useState(false)
  const [recorded, setRecorded] = useState<RecordedVoiceMemo | null>(null)
  const [caption, setCaption] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Local preview playback state (displayed second updated at <=1Hz or on scrub; visual sweep runs at 60fps via rAF)
  const [previewPlaying, setPreviewPlaying] = useState(false)
  const [previewDisplaySec, setPreviewDisplaySec] = useState(0)
  const [previewDuration, setPreviewDuration] = useState(0)

  // Pre-send voice transcription preview state
  const [transcriptStatus, setTranscriptStatus] = useState<PreviewTranscriptStatus>('idle')
  const [transcriptText, setTranscriptText] = useState('')
  const [transcriptModelLabel, setTranscriptModelLabel] = useState('')
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [transcriptEmpty, setTranscriptEmpty] = useState(false)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const controllerRef = useRef<VoiceRecorderController | null>(null)
  const recordedRef = useRef<RecordedVoiceMemo | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const waveTrackRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const liveTimerRef = useRef<HTMLSpanElement | null>(null)
  const liveTimerMaxRef = useRef<HTMLSpanElement | null>(null)
  const captionInputRef = useRef<HTMLInputElement | null>(null)
  const transcriptInputRef = useRef<HTMLTextAreaElement | null>(null)

  const onErrorToastRef = useRef(onErrorToast)
  const onSendRef = useRef(onSend)
  const onCancelRef = useRef(onCancel)
  const transcriptionRef = useRef(transcription)
  const transcribedBlobRef = useRef<Blob | null>(null)
  const transcriptJobRef = useRef(0)
  const sessionIdRef = useRef(0)
  const stoppingRef = useRef(false)
  const submittedRef = useRef(false)
  const draggingRef = useRef(false)
  const stageRef = useRef<RecorderStage>('starting')

  // Zero-re-render 60fps live canvas waveform state
  const liveBarsRef = useRef<number[]>([])
  const liveScrollPxRef = useRef(0)
  const livePeakSincePushRef = useRef(0.08)
  const liveLastFrameMsRef = useRef(0)
  const liveLastTimerSecRef = useRef(-1)
  const liveColorsRef = useRef<{ bar: string; peak: string }>({
    bar: '#22c55e',
    peak: '#ef4444',
  })
  const canvasCssSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 30 })

  useEffect(() => {
    stageRef.current = stage
  }, [stage])

  useEffect(() => {
    onErrorToastRef.current = onErrorToast
  }, [onErrorToast])

  useEffect(() => {
    onSendRef.current = onSend
  }, [onSend])

  useEffect(() => {
    onCancelRef.current = onCancel
  }, [onCancel])

  useEffect(() => {
    transcriptionRef.current = transcription
  }, [transcription])

  const resolveCanvasColors = useCallback(() => {
    const el = rootRef.current || document.documentElement
    const styles = getComputedStyle(el)
    const accent = (
      isDm ? styles.getPropertyValue('--dm-accent') : styles.getPropertyValue('--accent')
    ).trim()
    const danger = styles.getPropertyValue('--status-danger').trim()
    liveColorsRef.current = {
      bar: accent || (isDm ? '#8b5cf6' : '#22c55e'),
      peak: danger || '#ef4444',
    }
  }, [isDm])

  // Keep canvas palette synced with theme and DM mode
  useEffect(() => {
    resolveCanvasColors()
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => resolveCanvasColors())
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [resolveCanvasColors])

  const drawLiveWaveform = useCallback((currentNorm: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { w, h } = canvasCssSizeRef.current
    if (w <= 0 || h <= 0) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, w, h)

    const bars = liveBarsRef.current
    const scrollPx = liveScrollPxRef.current
    const midY = h / 2
    const maxBarH = Math.max(6, h - 4)
    const minBarH = 3
    const fadeZone = Math.min(30, w * 0.18)
    const { bar: baseColor, peak: peakColor } = liveColorsRef.current

    // Incoming rightmost bar grows smoothly as scrollPx approaches LIVE_BAR_STRIDE
    const rightEdgeX = w - LIVE_BAR_WIDTH - scrollPx
    const leadGrow = Math.min(1, 0.45 + (scrollPx / LIVE_BAR_STRIDE) * 0.55)
    const leadAmp = Math.max(0.06, Math.min(1, currentNorm))
    const leadH = Math.max(minBarH, leadAmp * maxBarH * leadGrow)
    ctx.globalAlpha = 0.55 + 0.45 * leadGrow
    ctx.fillStyle = leadAmp >= 0.78 ? peakColor : baseColor
    drawRoundedPill(ctx, rightEdgeX + LIVE_BAR_STRIDE, midY - leadH / 2, LIVE_BAR_WIDTH, leadH, 1.5)

    // Committed bars scrolling smoothly right-to-left
    for (let i = 0; i < bars.length; i++) {
      const idx = bars.length - 1 - i
      const x = rightEdgeX - i * LIVE_BAR_STRIDE
      if (x + LIVE_BAR_WIDTH < 0) break

      const amp = bars[idx]
      const barH = Math.max(minBarH, amp * maxBarH)
      const leftAlpha = x < fadeZone ? Math.max(0, x / fadeZone) : 1
      const energyAlpha = 0.52 + 0.48 * amp
      ctx.globalAlpha = leftAlpha * energyAlpha
      ctx.fillStyle = amp >= 0.78 ? peakColor : baseColor
      drawRoundedPill(ctx, x, midY - barH / 2, LIVE_BAR_WIDTH, barH, 1.5)
    }
    ctx.globalAlpha = 1
  }, [])

  // Size HiDPI live waveform canvas crisply whenever recording mounts or resizes
  useEffect(() => {
    if (stage !== 'recording') return
    const canvas = canvasRef.current
    if (!canvas) return
    resolveCanvasColors()

    const syncCanvasSize = () => {
      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      const targetW = Math.round(rect.width * dpr)
      const targetH = Math.round(rect.height * dpr)
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
      }
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      canvasCssSizeRef.current = { w: rect.width, h: rect.height }
      drawLiveWaveform(livePeakSincePushRef.current)
    }

    syncCanvasSize()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(syncCanvasSize)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [stage, resolveCanvasColors, drawLiveWaveform])

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

  const applyPreviewProgress = useCallback((ratio: number) => {
    const clamped = Math.min(1, Math.max(0, ratio))
    const pct = clamped * 100
    if (waveTrackRef.current) {
      waveTrackRef.current.style.setProperty('--voice-progress', `${pct.toFixed(2)}%`)
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
    setPreviewDisplaySec(0)
    applyPreviewProgress(0)
  }, [applyPreviewProgress])

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
    submittedRef.current = false
    setFlushingSend(false)

    controllerRef.current?.cancel()
    controllerRef.current = null
    discardRecordedMemo()

    liveBarsRef.current = []
    liveScrollPxRef.current = 0
    livePeakSincePushRef.current = 0.08
    liveLastFrameMsRef.current = 0
    liveLastTimerSecRef.current = -1

    setStage('starting')
    setErrorMsg(null)

    const ctrl = new VoiceRecorderController()
    controllerRef.current = ctrl

    void ctrl
      .start({
        onFrame: (level, elapsedSec) => {
          if (sessionIdRef.current !== sid) return
          if (stageRef.current !== 'recording') {
            stageRef.current = 'recording'
            setStage('recording')
          }

          const now = performance.now()
          const dtMs =
            liveLastFrameMsRef.current > 0
              ? Math.max(4, Math.min(60, now - liveLastFrameMsRef.current))
              : 16.667
          liveLastFrameMsRef.current = now

          const norm = Math.max(0.06, Math.min(1, level / 100))
          livePeakSincePushRef.current = Math.max(
            norm,
            livePeakSincePushRef.current * 0.86 + norm * 0.14,
          )
          liveScrollPxRef.current += (dtMs / 1000) * LIVE_SCROLL_PX_PER_SEC

          while (liveScrollPxRef.current >= LIVE_BAR_STRIDE) {
            liveScrollPxRef.current -= LIVE_BAR_STRIDE
            const prev = liveBarsRef.current[liveBarsRef.current.length - 1]
            const organic =
              prev !== undefined
                ? prev * 0.22 + livePeakSincePushRef.current * 0.78
                : livePeakSincePushRef.current
            liveBarsRef.current.push(Math.max(0.06, Math.min(1, organic)))
            if (liveBarsRef.current.length > MAX_HISTORY_BARS) {
              liveBarsRef.current.shift()
            }
            livePeakSincePushRef.current = norm
          }

          drawLiveWaveform(norm)

          // Update timer DOM directly at 1Hz (ZERO React re-renders during recording!)
          const wholeSec = Math.floor(elapsedSec)
          if (wholeSec !== liveLastTimerSecRef.current) {
            liveLastTimerSecRef.current = wholeSec
            const timerEl = liveTimerRef.current
            if (timerEl) {
              timerEl.textContent = formatVoiceDuration(wholeSec)
              const nearLimit = wholeSec >= MAX_VOICE_DURATION_SEC - 15
              timerEl.classList.toggle('warn', nearLimit)
              const maxEl = liveTimerMaxRef.current
              if (maxEl) {
                maxEl.style.display = nearLimit ? 'inline' : 'none'
              }
            }
          }
        },
        onAutoStop: (rec) => {
          if (sessionIdRef.current !== sid) {
            revokeVoicePreviewUrl(rec)
            return
          }
          recordedRef.current = rec
          setRecorded(rec)
          setPreviewDuration(rec.durationSec)
          setPreviewDisplaySec(0)
          setPreviewPlaying(false)
          applyPreviewProgress(0)
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
  }, [discardRecordedMemo, drawLiveWaveform, applyPreviewProgress])

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

  // Auto-transcribe once per recorded blob when autoTranscribe is enabled (in preview stage)
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
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 48), 96)}px`
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

  // 60fps requestAnimationFrame continuous progress sweep during preview playback
  useEffect(() => {
    if (!previewPlaying || stage !== 'preview') return
    let rafId = 0
    let lastShownSec = -1

    const tick = () => {
      const audio = previewAudioRef.current
      if (!audio) return
      const total =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : previewDuration || (recordedRef.current?.durationSec ?? 0)
      if (total > 0) {
        applyPreviewProgress(audio.currentTime / total)
      }
      const sec = Math.floor(audio.currentTime)
      if (sec !== lastShownSec) {
        lastShownSec = sec
        setPreviewDisplaySec(sec)
      }
      if (!audio.paused && !audio.ended) {
        rafId = window.requestAnimationFrame(tick)
      }
    }

    rafId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(rafId)
  }, [previewPlaying, stage, previewDuration, applyPreviewProgress])

  const handleCancel = useCallback(() => {
    sessionIdRef.current += 1
    controllerRef.current?.cancel()
    controllerRef.current = null
    discardRecordedMemo()
    onCancelRef.current()
  }, [discardRecordedMemo])

  const handleInstantSend = useCallback(async () => {
    if (stoppingRef.current || submittedRef.current || stageRef.current !== 'recording') return
    stoppingRef.current = true
    setFlushingSend(true)
    const sid = sessionIdRef.current
    try {
      const rec = await controllerRef.current?.stop()
      if (sessionIdRef.current !== sid) {
        revokeVoicePreviewUrl(rec)
        return
      }
      if (!rec || rec.size <= 0) {
        setFlushingSend(false)
        setErrorMsg('Recording was empty — try speaking for a moment before sending.')
        setStage('error')
        return
      }
      submittedRef.current = true
      sessionIdRef.current += 1
      // Transfer ownership of rec & previewUrl directly to the engine's optimistic queue
      void onSendRef.current(rec, '')
      onCancelRef.current()
    } finally {
      stoppingRef.current = false
    }
  }, [])

  // Keyboard shortcuts: Escape cancels at any stage; Enter sends immediately while recording!
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleCancel()
        return
      }
      if (
        e.key === 'Enter' &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        stageRef.current === 'recording'
      ) {
        const tag = (e.target as HTMLElement | null)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        void handleInstantSend()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleCancel, handleInstantSend])

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
      setPreviewDisplaySec(0)
      setPreviewPlaying(false)
      applyPreviewProgress(0)
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
      applyPreviewProgress(ratio)
      setPreviewDisplaySec(Math.floor(nextTime))
    }
  }

  const handleTogglePreviewTranscript = () => {
    if (!recorded) return
    if (transcriptStatus === 'transcribing') return
    if (transcriptStatus === 'idle') {
      void runPreviewTranscription(recorded.blob)
    } else {
      resetTranscriptState()
    }
  }

  const handleSend = () => {
    const memo = recordedRef.current ?? recorded
    if (!memo || submittedRef.current) return
    submittedRef.current = true

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
    const sendCaption = caption

    // Transfer ownership of the recorded memo (and its previewUrl) to the engine's
    // optimistic delivery queue — do NOT call revokeVoicePreviewUrl here.
    recordedRef.current = null
    setRecorded(null)
    stopPreviewAudio()
    resetTranscriptState()
    setPreviewDuration(0)
    sessionIdRef.current += 1

    void onSend(memo, sendCaption, previewTranscript)
    onCancel()
  }

  const handleSendText = () => {
    const cleanText = transcriptText.trim()
    if (!cleanText || submittedRef.current) return
    submittedRef.current = true

    const audio = previewAudioRef.current
    if (audio && !audio.paused) {
      audio.pause()
      setPreviewPlaying(false)
    }

    sessionIdRef.current += 1
    discardRecordedMemo()
    onCancel()
    void onSendText(cleanText)
  }

  const previewBars = useMemo(
    () => interpolateWaveformBars(recorded?.waveform ?? [], PREVIEW_WAVE_BARS),
    [recorded?.waveform],
  )

  const activeModelLabel = transcription.activeModel.label
  const shownModelLabel = transcriptModelLabel || activeModelLabel
  const modelChangedSinceRun =
    transcriptStatus === 'done' &&
    Boolean(transcriptModelLabel) &&
    transcriptModelLabel !== activeModelLabel
  const isDownloadingModel = transcription.modelStatus === 'downloading'
  const downloadPct = Math.max(0, Math.min(100, Math.round(transcription.downloadProgress)))
  const hasEditableTranscript =
    transcriptStatus === 'done' && (!transcriptEmpty || transcriptText.length > 0)
  const canSendText = hasEditableTranscript && transcriptText.trim().length > 0

  const effectivePreviewDuration =
    previewDuration > 0 ? previewDuration : (recorded?.durationSec ?? 0)
  const showPreviewProgressTime = previewPlaying || previewDisplaySec > 0

  return (
    <div
      ref={rootRef}
      className={`ag-voice-recorder-bar ${hasBanner ? 'with-banner' : ''} ${isDm ? 'dm' : ''} stage-${stage}`}
      role="region"
      aria-label="Voice memo recorder"
    >
      {/* Starting / Requesting Mic State (exact same 44px height as composer & recording!) */}
      {stage === 'starting' && (
        <div className="ag-vrec-row">
          <div className="ag-vrec-status">
            <Loader2
              size={14}
              className="ag-spin"
              style={{ color: isDm ? 'var(--dm-accent)' : 'var(--accent)', flexShrink: 0 }}
            />
            <span className="truncate">Starting mic…</span>
            {isDm && (
              <span className="ag-vrec-lock" title="End-to-end encrypted voice">
                <Lock size={11} />
              </span>
            )}
          </div>
          <button
            type="button"
            className="ag-vrec-icon-btn discard"
            onClick={handleCancel}
            title="Cancel (Esc)"
            aria-label="Cancel voice recording"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {/* Active Recording State — Silky 60fps HiDPI Canvas + 1-Tap Instant Send */}
      {stage === 'recording' && (
        <div className="ag-vrec-row">
          <div className="ag-vrec-rec-meta">
            <span className="ag-rec-led" aria-hidden="true" />
            <span className="ag-vrec-timer mono tabular">
              <span ref={liveTimerRef}>0:00</span>
              <span
                ref={liveTimerMaxRef}
                className="ag-vrec-timer-max"
                style={{ display: 'none' }}
              >
                {' '}
                / {formatVoiceDuration(MAX_VOICE_DURATION_SEC)}
              </span>
            </span>
            {isDm && (
              <span className="ag-vrec-lock" title="End-to-end encrypted voice">
                <Lock size={11} />
              </span>
            )}
          </div>

          <canvas
            ref={canvasRef}
            className="ag-vrec-canvas"
            aria-label="Live microphone waveform"
          />

          <div className="ag-vrec-actions">
            <button
              type="button"
              className="ag-vrec-icon-btn discard"
              onClick={handleCancel}
              disabled={flushingSend}
              title="Discard recording (Esc)"
              aria-label="Discard recording"
            >
              <Trash2 size={14} />
            </button>

            <button
              type="button"
              className="ag-vrec-icon-btn stop"
              onClick={() => void handleStopToPreview()}
              disabled={flushingSend}
              title="Stop and review"
              aria-label="Stop recording to preview"
            >
              <Square size={11} fill="currentColor" />
            </button>

            <button
              type="button"
              className={`ag-vrec-instant-send ${isDm ? 'dm' : ''}`}
              onClick={() => void handleInstantSend()}
              disabled={flushingSend}
              title="Send voice memo now (Enter)"
              aria-label="Send voice memo"
            >
              {flushingSend ? (
                <Loader2 size={15} className="ag-spin" />
              ) : (
                <ArrowUp size={16} strokeWidth={2.4} />
              )}
            </button>
          </div>
        </div>
      )}

      {/* Compact Non-Blocky Preview & Optional Caption/Transcript Stage */}
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
            onEnded={() => {
              setPreviewPlaying(false)
              setPreviewDisplaySec(0)
              applyPreviewProgress(0)
            }}
            onPause={() => setPreviewPlaying(false)}
            onPlay={() => setPreviewPlaying(true)}
          />

          {/* Row 1: Play + 60fps Continuous Scrubber + Timer + Re-record + On-Demand Captions */}
          <div className="ag-vrec-row">
            <button
              type="button"
              className={`ag-voice-play-btn preview ${isDm ? 'dm' : ''}`}
              onClick={togglePreviewPlayback}
              aria-label={previewPlaying ? 'Pause preview' : 'Play preview'}
              title={previewPlaying ? 'Pause preview' : 'Play preview'}
            >
              {previewPlaying ? (
                <Pause size={13} fill="currentColor" />
              ) : (
                <Play size={13} fill="currentColor" style={{ marginLeft: 1 }} />
              )}
            </button>

            <div
              ref={waveTrackRef}
              className={`ag-voice-waveform interactive preview ${isDm ? 'dm' : ''} ${previewPlaying ? 'playing' : ''}`}
              role="slider"
              tabIndex={0}
              aria-label="Preview voice memo position"
              aria-valuemin={0}
              aria-valuemax={Math.round(effectivePreviewDuration)}
              aria-valuenow={previewDisplaySec}
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
                  const next = Math.min(
                    effectivePreviewDuration,
                    Math.max(0, audio.currentTime + delta),
                  )
                  audio.currentTime = next
                  applyPreviewProgress(next / effectivePreviewDuration)
                  setPreviewDisplaySec(Math.floor(next))
                } else if (e.key === ' ') {
                  e.preventDefault()
                  togglePreviewPlayback()
                }
              }}
            >
              <div className="ag-voice-wave-layer base" aria-hidden="true">
                {previewBars.map((peak, idx) => (
                  <span
                    key={idx}
                    className="ag-voice-wave-bar"
                    style={{ height: `${peak}%` }}
                  />
                ))}
              </div>
              <div className="ag-voice-wave-layer fill" aria-hidden="true">
                {previewBars.map((peak, idx) => (
                  <span
                    key={idx}
                    className="ag-voice-wave-bar"
                    style={{ height: `${peak}%` }}
                  />
                ))}
              </div>
            </div>

            <span className="ag-vrec-timer mono tabular">
              {showPreviewProgressTime
                ? `${formatVoiceDuration(previewDisplaySec)} / ${formatVoiceDuration(effectivePreviewDuration)}`
                : formatVoiceDuration(effectivePreviewDuration)}
            </span>

            {isDm && (
              <span className="ag-vrec-lock" title="End-to-end encrypted voice">
                <Lock size={11} />
              </span>
            )}

            <div className="ag-vrec-actions">
              <button
                type="button"
                className={`ag-vrec-icon-btn captions ${transcriptStatus !== 'idle' ? 'active' : ''} ${isDm ? 'dm' : ''}`}
                onClick={handleTogglePreviewTranscript}
                disabled={transcriptStatus === 'transcribing'}
                title={
                  transcriptStatus === 'idle'
                    ? `Transcribe preview (${activeModelLabel})`
                    : transcriptStatus === 'transcribing'
                      ? `Transcribing with ${activeModelLabel}…`
                      : 'Hide transcript preview'
                }
                aria-label={
                  transcriptStatus === 'idle'
                    ? 'Preview transcript'
                    : 'Toggle transcript preview'
                }
                aria-pressed={transcriptStatus !== 'idle'}
              >
                {transcriptStatus === 'transcribing' ? (
                  <Loader2 size={14} className="ag-spin" />
                ) : (
                  <Captions size={14} />
                )}
              </button>

              <button
                type="button"
                className="ag-vrec-icon-btn"
                onClick={() => beginRecording()}
                title="Re-record voice memo"
                aria-label="Re-record voice memo"
              >
                <RotateCcw size={13} />
              </button>
            </div>
          </div>

          {/* Sleek On-Demand Transcript Drawer (ONLY mounted when active — zero idle banner box!) */}
          {transcriptStatus !== 'idle' && (
            <div
              className={`ag-vrec-transcript-box ${isDm ? 'dm' : ''} status-${transcriptStatus}`}
              role="region"
              aria-label="Voice memo transcription preview"
            >
              {transcriptStatus === 'transcribing' && (
                <div className="ag-vrec-transcript-loading">
                  <div className="ag-vrec-transcript-bar">
                    <div className="ag-vrec-transcript-meta truncate">
                      <Loader2
                        size={12}
                        className="ag-spin ag-vrec-transcript-icon"
                        aria-hidden="true"
                      />
                      <span className="truncate">
                        {isDownloadingModel
                          ? `Loading ${activeModelLabel} · ${downloadPct}%`
                          : `Transcribing with ${activeModelLabel}…`}
                      </span>
                    </div>
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
                  <div
                    className="ag-vrec-transcript-meta truncate"
                    title={transcriptError ?? undefined}
                  >
                    <AlertCircle size={12} className="ag-vrec-transcript-icon" aria-hidden="true" />
                    <span className="truncate">
                      {transcriptError ?? 'Unable to transcribe preview.'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ag-vrec-mini-btn"
                    onClick={() => void runPreviewTranscription(recorded.blob)}
                  >
                    <RefreshCw size={11} />
                    <span>Retry</span>
                  </button>
                </div>
              )}

              {transcriptStatus === 'done' && !hasEditableTranscript && (
                <div className="ag-vrec-transcript-bar">
                  <div className="ag-vrec-transcript-meta truncate">
                    <Captions size={12} className="ag-vrec-transcript-icon" aria-hidden="true" />
                    <span className="truncate">No speech detected</span>
                    <span className="ag-vrec-transcript-model truncate">{shownModelLabel}</span>
                  </div>
                  <button
                    type="button"
                    className="ag-vrec-mini-btn"
                    onClick={() => void runPreviewTranscription(recorded.blob)}
                    title={`Re-transcribe with ${activeModelLabel}`}
                  >
                    <RefreshCw size={11} />
                    <span>Retry</span>
                  </button>
                </div>
              )}

              {hasEditableTranscript && (
                <div className="ag-vrec-transcript-editor">
                  <div className="ag-vrec-transcript-head">
                    <div className="ag-vrec-transcript-head-left truncate">
                      <Captions size={11} className="ag-vrec-transcript-icon" aria-hidden="true" />
                      <span className="ag-vrec-transcript-label">Transcript</span>
                      <span className="ag-vrec-transcript-model truncate" title={shownModelLabel}>
                        {shownModelLabel}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="ag-vrec-mini-btn"
                      onClick={() => void runPreviewTranscription(recorded.blob)}
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
                    onChange={(e) => setTranscriptText(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault()
                        handleSendText()
                      }
                    }}
                    placeholder="Edit transcript to send as text…"
                    aria-label="Edit voice memo transcript"
                  />
                </div>
              )}
            </div>
          )}

          {/* Row 2: Slim Caption Input + Discard + Optional Send Text + Primary Send */}
          <div className="ag-vrec-caption-row">
            <input
              ref={captionInputRef}
              type="text"
              maxLength={240}
              className="ag-vrec-caption-input"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              placeholder={isDm ? 'Optional encrypted caption…' : 'Optional caption…'}
              aria-label="Optional voice memo caption"
            />

            <div className="ag-vrec-footer-actions">
              <button
                type="button"
                className="ag-vrec-icon-btn discard"
                onClick={handleCancel}
                title="Discard voice memo (Esc)"
                aria-label="Discard voice memo"
              >
                <Trash2 size={14} />
              </button>

              {hasEditableTranscript && (
                <button
                  type="button"
                  className={`ag-vrec-send-text-btn ${isDm ? 'dm' : ''}`}
                  onClick={handleSendText}
                  disabled={!canSendText}
                  title="Send transcript as text only (⌘↵)"
                  aria-label="Send transcript as text"
                >
                  <MessageSquareText size={13} />
                  <span>Send Text</span>
                </button>
              )}

              <button
                type="button"
                className={`ag-vrec-send-btn ${isDm ? 'dm' : ''}`}
                onClick={handleSend}
                aria-label="Send Voice"
              >
                <ArrowUp size={15} strokeWidth={2.4} />
                <span>Send</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error State */}
      {stage === 'error' && (
        <div className="ag-vrec-row">
          <div className="ag-vrec-status error">
            <AlertCircle size={14} style={{ flexShrink: 0 }} />
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
              className="ag-vrec-icon-btn discard"
              onClick={handleCancel}
              aria-label="Close voice recorder"
              title="Close"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default VoiceRecorderBar
