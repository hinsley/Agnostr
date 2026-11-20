import type { RecordedVoiceMemo } from '../types/protocol.ts'
import { cleanMimeType } from './blossom.ts'

export const MAX_VOICE_DURATION_SEC = 90
export const WAVEFORM_BARS = 32

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

export function downsampleWaveform(samples: readonly number[], bars = WAVEFORM_BARS): number[] {
  if (samples.length === 0) {
    return Array.from({ length: bars }, () => 12)
  }
  const out: number[] = []
  const step = samples.length / bars
  for (let i = 0; i < bars; i++) {
    const start = Math.floor(i * step)
    const end = Math.max(start + 1, Math.floor((i + 1) * step))
    let peak = 0
    for (let j = start; j < end && j < samples.length; j++) {
      if (samples[j] > peak) peak = samples[j]
    }
    out.push(Math.max(6, Math.min(100, Math.round(peak))))
  }
  return out
}

export function formatVoiceDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds))
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
  onLevel?: (level: number, liveBars: number[], elapsedSec: number) => void
  onAutoStop?: (recorded: RecordedVoiceMemo) => void
  onError?: (error: Error) => void
}

export class VoiceRecorderController {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private audioCtx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private levelTimer: number | null = null
  private chunks: Blob[] = []
  private samples: number[] = []
  private startedAtMs = 0
  private activeMime = 'audio/webm'
  private stopPromise: Promise<RecordedVoiceMemo | null> | null = null
  private resolveStop: ((memo: RecordedVoiceMemo | null) => void) | null = null
  private cancelled = false

  isRecording(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording'
  }

  async start(callbacks: VoiceRecorderCallbacks = {}): Promise<void> {
    if (!isVoiceRecordingSupported()) {
      throw new Error('Microphone recording is not supported in this browser.')
    }
    this.cancel()
    this.cancelled = false
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
    const options: MediaRecorderOptions = { audioBitsPerSecond: 32_000 }
    if (preferredMime) options.mimeType = preferredMime

    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, options)
    } catch {
      recorder = new MediaRecorder(stream)
    }
    this.recorder = recorder
    this.activeMime = cleanMimeType(recorder.mimeType || preferredMime || 'audio/webm')

    // Web Audio AnalyserNode for live VU meter & waveform peak capture
    try {
      const AudioCtxCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (AudioCtxCtor) {
        const ctx = new AudioCtxCtor()
        const src = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.45
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
      const elapsedSec = Math.max(0.5, (performance.now() - this.startedAtMs) / 1000)
      const mime = cleanMimeType(recorder.mimeType || this.activeMime || 'audio/webm')
      const blob = new Blob(this.chunks, { type: mime })
      const waveform = downsampleWaveform(this.samples, WAVEFORM_BARS)

      this.cleanupResources()

      if (wasCancelled || blob.size === 0) {
        this.resolveStop?.(null)
        this.resolveStop = null
        return
      }

      const recorded: RecordedVoiceMemo = {
        blob,
        mime,
        size: blob.size,
        durationSec: Math.min(MAX_VOICE_DURATION_SEC, Math.round(elapsedSec * 10) / 10),
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
    recorder.start(250)

    const timeDomain = this.analyser ? new Uint8Array(this.analyser.fftSize) : null
    this.levelTimer = window.setInterval(() => {
      const elapsedSec = (performance.now() - this.startedAtMs) / 1000
      let level = 15
      if (this.analyser && timeDomain) {
        this.analyser.getByteTimeDomainData(timeDomain)
        let sumSq = 0
        for (let i = 0; i < timeDomain.length; i++) {
          const centered = (timeDomain[i] - 128) / 128
          sumSq += centered * centered
        }
        const rms = Math.sqrt(sumSq / timeDomain.length)
        level = Math.max(6, Math.min(100, Math.round(Math.pow(rms * 3.2, 0.78) * 100)))
      }
      this.samples.push(level)
      const liveBars =
        this.samples.length <= WAVEFORM_BARS
          ? [
              ...Array.from({ length: WAVEFORM_BARS - this.samples.length }, () => 8),
              ...this.samples,
            ]
          : this.samples.slice(-WAVEFORM_BARS)
      callbacks.onLevel?.(level, liveBars, elapsedSec)

      if (elapsedSec >= MAX_VOICE_DURATION_SEC) {
        void this.stop().then((rec) => {
          if (rec) callbacks.onAutoStop?.(rec)
        })
      }
    }, 65)
  }

  async stop(): Promise<RecordedVoiceMemo | null> {
    if (!this.recorder) return null
    const promise = this.stopPromise
    if (this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop()
      } catch {
        this.cleanupResources()
        return null
      }
    }
    return promise ? await promise : null
  }

  cancel(): void {
    this.cancelled = true
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

  private cleanupResources(): void {
    if (this.levelTimer !== null) {
      window.clearInterval(this.levelTimer)
      this.levelTimer = null
    }
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
