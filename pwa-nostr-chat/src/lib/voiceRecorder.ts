import type { RecordedVoiceMemo } from '../types/protocol.ts'
import { cleanMimeType } from './blossom.ts'

export const MAX_VOICE_DURATION_SEC = 90
export const WAVEFORM_BARS = 32

const MIN_VOICE_DURATION_SEC = 0.25
const LEVEL_CALLBACK_INTERVAL_MS = 62 // ~16Hz backward-compatible throttle for onLevel
const SAMPLE_RECORD_INTERVAL_MS = 28 // ~36Hz peak history capture for clean downsampling
const ENVELOPE_ATTACK = 0.42
const ENVELOPE_RELEASE = 0.16

const PREFERRED_MIMES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
] as const

export function isVoiceRecordingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  )
}

export function pickSupportedAudioMime(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm'
  for (const mime of PREFERRED_MIMES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime
    } catch {
      // Ignore browser quirks
    }
  }
  return ''
}

function pickAudioBitrate(mime: string): number {
  const lower = mime.toLowerCase()
  if (lower.includes('mp4') || lower.includes('aac') || lower.includes('m4a')) {
    return 64_000
  }
  return 48_000
}

export function downsampleWaveform(samples: readonly number[], bars = WAVEFORM_BARS): number[] {
  if (samples.length === 0) {
    return Array.from({ length: bars }, () => 14)
  }

  const rawBuckets: number[] = []
  const step = samples.length / bars
  let maxBucket = 0

  for (let i = 0; i < bars; i++) {
    const start = Math.floor(i * step)
    const end = Math.max(start + 1, Math.floor((i + 1) * step))
    let peak = 0
    let sum = 0
    let count = 0
    for (let j = start; j < end && j < samples.length; j++) {
      const v = samples[j]
      if (v > peak) peak = v
      sum += v
      count += 1
    }
    const avg = count > 0 ? sum / count : peak
    // Blend peak and average so speech syllables stay organic instead of spiky
    const blended = peak * 0.72 + avg * 0.28
    if (blended > maxBucket) maxBucket = blended
    rawBuckets.push(blended)
  }

  // Gentle dynamic normalization so quieter voices still render legible waveforms
  // without blowing up near-silent noise floors
  let gain = 1
  if (maxBucket > 10 && maxBucket < 82) {
    const targetPeak = Math.min(86, Math.max(48, maxBucket * 1.65))
    gain = Math.min(2.15, targetPeak / maxBucket)
  }

  return rawBuckets.map((val) => {
    const lifted = val * gain
    return Math.max(8, Math.min(100, Math.round(lifted)))
  })
}

export function formatVoiceDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds + 0.05))
  const mins = Math.floor(safe / 60)
  const secs = safe % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function revokeVoicePreviewUrl(memo: RecordedVoiceMemo | null | undefined): void {
  if (!memo?.previewUrl) return
  try {
    URL.revokeObjectURL(memo.previewUrl)
  } catch {
    // Ignore
  }
}

export interface VoiceRecorderCallbacks {
  /** High-frequency 60fps rAF level callback for zero-re-render canvas rendering. */
  onFrame?: (level: number, elapsedSec: number) => void
  /** Throttled (~16Hz) callback kept for backward compatibility with bar-array consumers. */
  onLevel?: (level: number, liveBars: number[], elapsedSec: number) => void
  onAutoStop?: (recorded: RecordedVoiceMemo) => void
  onError?: (error: Error) => void
}

export class VoiceRecorderController {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private audioCtx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private rafId: number | null = null
  private guardTimer: number | null = null
  private chunks: Blob[] = []
  private samples: number[] = []
  private startedAtMs = 0
  private activeMime = 'audio/webm'
  private stopPromise: Promise<RecordedVoiceMemo | null> | null = null
  private resolveStop: ((memo: RecordedVoiceMemo | null) => void) | null = null
  private cancelled = false
  private stopping = false
  private autoStopTriggered = false

  isRecording(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording' && !this.stopping
  }

  async start(callbacks: VoiceRecorderCallbacks = {}): Promise<void> {
    if (!isVoiceRecordingSupported()) {
      throw new Error('Microphone recording is not supported in this browser.')
    }
    this.cancel()
    this.cancelled = false
    this.stopping = false
    this.autoStopTriggered = false
    this.chunks = []
    this.samples = []

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    this.stream = stream

    const preferredMime = pickSupportedAudioMime()
    const options: MediaRecorderOptions = {
      audioBitsPerSecond: pickAudioBitrate(preferredMime),
    }
    if (preferredMime) options.mimeType = preferredMime

    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, options)
    } catch {
      recorder = new MediaRecorder(stream)
    }
    this.recorder = recorder
    this.activeMime = cleanMimeType(recorder.mimeType || preferredMime || 'audio/webm')

    // Web Audio AnalyserNode for silky 60fps VU envelope & waveform peak capture
    try {
      const AudioCtxCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (AudioCtxCtor) {
        const ctx = new AudioCtxCtor()
        if (ctx.state === 'suspended') {
          void ctx.resume().catch(() => {
            // Ignore autoplay gesture restrictions; recording still proceeds
          })
        }
        const src = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        analyser.smoothingTimeConstant = 0.25
        src.connect(analyser)
        this.audioCtx = ctx
        this.analyser = analyser
      }
    } catch {
      // Proceed without live analyser if AudioContext blocked
    }

    recorder.addEventListener('dataavailable', (ev) => {
      if (ev.data && ev.data.size > 0) {
        this.chunks.push(ev.data)
      }
    })

    this.stopPromise = new Promise<RecordedVoiceMemo | null>((resolve) => {
      this.resolveStop = resolve
    })

    recorder.addEventListener('stop', () => {
      const wasCancelled = this.cancelled
      const rawElapsed = (performance.now() - this.startedAtMs) / 1000
      const elapsedSec = Math.max(MIN_VOICE_DURATION_SEC, rawElapsed)
      const mime = cleanMimeType(recorder.mimeType || this.activeMime || 'audio/webm')
      const blob = new Blob(this.chunks, { type: mime })
      const waveform = downsampleWaveform(this.samples, WAVEFORM_BARS)

      this.cleanupResources()

      if (wasCancelled || blob.size === 0) {
        this.resolveStop?.(null)
        this.resolveStop = null
        return
      }

      const roundedDuration = Math.max(
        MIN_VOICE_DURATION_SEC,
        Math.min(MAX_VOICE_DURATION_SEC, Math.round(elapsedSec * 10) / 10),
      )

      const recorded: RecordedVoiceMemo = {
        blob,
        mime,
        size: blob.size,
        durationSec: roundedDuration,
        waveform,
        previewUrl: URL.createObjectURL(blob),
      }
      this.resolveStop?.(recorded)
      this.resolveStop = null
    })

    recorder.addEventListener('error', () => {
      const err = new Error('Audio recorder encountered an error.')
      callbacks.onError?.(err)
      this.cancel()
    })

    this.startedAtMs = performance.now()
    // 1000ms timeslice reduces container cluster fragmentation for cleaner playback & faster stop flush
    recorder.start(1000)

    const timeDomain = this.analyser ? new Uint8Array(this.analyser.fftSize) : null
    let smoothedLevel = 8
    let lastFrameMs = this.startedAtMs
    let lastSampleMs = this.startedAtMs
    let lastOnLevelMs = 0

    const triggerAutoStop = () => {
      if (this.autoStopTriggered || this.stopping || this.cancelled) return
      this.autoStopTriggered = true
      void this.stop().then((rec) => {
        if (rec && !this.cancelled) callbacks.onAutoStop?.(rec)
      })
    }

    const sampleFrame = (nowMs: number) => {
      if (this.cancelled || this.stopping || !this.recorder) {
        this.rafId = null
        return
      }

      const elapsedSec = Math.max(0, (nowMs - this.startedAtMs) / 1000)
      const dtMs = Math.max(4, Math.min(80, nowMs - lastFrameMs))
      lastFrameMs = nowMs

      let rawLevel = 12
      if (this.analyser && timeDomain) {
        this.analyser.getByteTimeDomainData(timeDomain)
        let sumSq = 0
        for (let i = 0; i < timeDomain.length; i++) {
          const centered = (timeDomain[i] - 128) / 128
          sumSq += centered * centered
        }
        const rms = Math.sqrt(sumSq / timeDomain.length)
        // Perceptual curve: quiet voice stays alive, loud peaks stay controlled
        rawLevel = Math.max(4, Math.min(100, Math.pow(rms * 3.4, 0.74) * 100))
      }

      // Frame-rate-independent asymmetric attack/release envelope smoothing
      const baseAlpha = rawLevel > smoothedLevel ? ENVELOPE_ATTACK : ENVELOPE_RELEASE
      const frameScale = dtMs / 16.667
      const alpha = 1 - Math.pow(1 - baseAlpha, frameScale)
      smoothedLevel += (rawLevel - smoothedLevel) * alpha

      if (nowMs - lastSampleMs >= SAMPLE_RECORD_INTERVAL_MS || this.samples.length === 0) {
        lastSampleMs = nowMs
        this.samples.push(smoothedLevel)
      }

      callbacks.onFrame?.(smoothedLevel, elapsedSec)

      if (callbacks.onLevel && nowMs - lastOnLevelMs >= LEVEL_CALLBACK_INTERVAL_MS) {
        lastOnLevelMs = nowMs
        const rounded = Math.max(6, Math.min(100, Math.round(smoothedLevel)))
        const recent =
          this.samples.length <= WAVEFORM_BARS
            ? [
                ...Array.from({ length: WAVEFORM_BARS - this.samples.length }, () => 8),
                ...this.samples.map((v) => Math.max(6, Math.min(100, Math.round(v)))),
              ]
            : this.samples
                .slice(-WAVEFORM_BARS)
                .map((v) => Math.max(6, Math.min(100, Math.round(v))))
        callbacks.onLevel(rounded, recent, elapsedSec)
      }

      if (elapsedSec >= MAX_VOICE_DURATION_SEC) {
        this.rafId = null
        triggerAutoStop()
        return
      }

      this.rafId = window.requestAnimationFrame(sampleFrame)
    }

    this.rafId = window.requestAnimationFrame(sampleFrame)

    // Safety guard so max-duration auto-stop still fires even if browser throttles rAF in a background tab
    this.guardTimer = window.setInterval(() => {
      if (this.cancelled || this.stopping) return
      const elapsedSec = (performance.now() - this.startedAtMs) / 1000
      if (elapsedSec >= MAX_VOICE_DURATION_SEC) {
        triggerAutoStop()
      }
    }, 250)
  }

  async stop(): Promise<RecordedVoiceMemo | null> {
    if (!this.recorder) {
      return this.stopPromise ? await this.stopPromise : null
    }
    const promise = this.stopPromise
    if (this.stopping) {
      return promise ? await promise : null
    }
    this.stopping = true
    this.stopSamplingLoops()

    if (this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop()
      } catch {
        this.cleanupResources()
        this.resolveStop?.(null)
        this.resolveStop = null
        return null
      }
    }
    return promise ? await promise : null
  }

  cancel(): void {
    this.cancelled = true
    this.stopping = true
    this.stopSamplingLoops()
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop()
      } catch {
        // Ignore
      }
    }
    this.cleanupResources()
    this.resolveStop?.(null)
    this.resolveStop = null
  }

  private stopSamplingLoops(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    if (this.guardTimer !== null) {
      window.clearInterval(this.guardTimer)
      this.guardTimer = null
    }
  }

  private cleanupResources(): void {
    this.stopSamplingLoops()
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop()
        } catch {
          // Ignore
        }
      }
      this.stream = null
    }
    if (this.audioCtx) {
      try {
        void this.audioCtx.close()
      } catch {
        // Ignore
      }
      this.audioCtx = null
      this.analyser = null
    }
    this.recorder = null
  }
}
