/* ==========================================================================
   Zero-Dependency Web Audio API Game Sound Effects Synthesizer
   Procedural cards, clay casino chips, Go stones, and weighted Chess pieces.
   Respects bitchatAudio.isEnabled() and handles autoplay restrictions safely.
   ========================================================================== */

import { bitchatAudio } from './sound.ts'

export type GameSoundCue =
  | 'card-deal'
  | 'card-flip'
  | 'card-fold'
  | 'chip-bet'
  | 'chip-allin'
  | 'chip-pot-win'
  | 'check-tap'
  | 'your-turn'
  | 'go-stone'
  | 'go-capture'
  | 'chess-move'
  | 'chess-capture'
  | 'chess-check'

let sharedCtx: AudioContext | null = null
let cachedNoiseBuffer: AudioBuffer | null = null
const recentBuckets = new Map<string, number>()

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtx) return null
  if (!sharedCtx) {
    try {
      sharedCtx = new AudioCtx()
    } catch {
      return null
    }
  }
  if (sharedCtx.state === 'suspended') {
    sharedCtx.resume().catch(() => {
      // Autoplay policy may block resume before first user gesture
    })
  }
  return sharedCtx
}

function getNoiseBuffer(ctx: AudioContext): AudioBuffer | null {
  try {
    if (cachedNoiseBuffer && cachedNoiseBuffer.sampleRate === ctx.sampleRate) {
      return cachedNoiseBuffer
    }
    const length = Math.max(1, Math.floor(ctx.sampleRate * 0.35))
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1
    }
    cachedNoiseBuffer = buffer
    return buffer
  } catch {
    return null
  }
}

function playTone(
  ctx: AudioContext,
  startTime: number,
  startFreq: number,
  endFreq: number,
  duration: number,
  peakGain: number,
  type: OscillatorType,
  attackSec = 0.004,
): void {
  try {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(Math.max(20, startFreq), startTime)
    if (endFreq !== startFreq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), startTime + duration)
    }

    const atkEnd = startTime + Math.min(attackSec, duration * 0.45)
    gain.gain.setValueAtTime(0.0001, startTime)
    gain.gain.linearRampToValueAtTime(peakGain, atkEnd)
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(startTime)
    osc.stop(startTime + duration + 0.015)
  } catch {
    // Ignore audio errors on restricted devices
  }
}

function playFilteredNoise(
  ctx: AudioContext,
  startTime: number,
  duration: number,
  peakGain: number,
  filterType: BiquadFilterType,
  startFreq: number,
  endFreq: number,
  q = 1.6,
  attackSec = 0.005,
): void {
  try {
    const buffer = getNoiseBuffer(ctx)
    if (!buffer) return

    const source = ctx.createBufferSource()
    source.buffer = buffer

    const filter = ctx.createBiquadFilter()
    filter.type = filterType
    filter.frequency.setValueAtTime(Math.max(60, startFreq), startTime)
    if (endFreq !== startFreq) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(60, endFreq), startTime + duration)
    }
    filter.Q.setValueAtTime(q, startTime)

    const gain = ctx.createGain()
    const atkEnd = startTime + Math.min(attackSec, duration * 0.4)
    gain.gain.setValueAtTime(0.0001, startTime)
    gain.gain.linearRampToValueAtTime(peakGain, atkEnd)
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration)

    source.connect(filter)
    filter.connect(gain)
    gain.connect(ctx.destination)
    source.start(startTime)
    source.stop(startTime + duration + 0.012)
  } catch {
    // Ignore audio errors on restricted devices
  }
}

function playClayChipClink(
  ctx: AudioContext,
  t: number,
  f1: number,
  f2: number,
  gainScale = 1,
): void {
  // Dual ceramic resonant partials + micro-impact click
  playTone(ctx, t, f1, f1 * 0.985, 0.045, 0.036 * gainScale, 'sine', 0.002)
  playTone(ctx, t, f2, f2 * 0.99, 0.038, 0.024 * gainScale, 'triangle', 0.002)
  playFilteredNoise(ctx, t, 0.011, 0.022 * gainScale, 'bandpass', 3200, 2600, 2.2, 0.001)
}

function playGoStoneClack(ctx: AudioContext, t: number, gainScale = 1): void {
  // Warm kaya wood resonance + crisp slate stone snap
  playTone(ctx, t, 410, 235, 0.056, 0.048 * gainScale, 'triangle', 0.002)
  playTone(ctx, t, 1850, 1280, 0.022, 0.038 * gainScale, 'sine', 0.0015)
  playFilteredNoise(ctx, t, 0.012, 0.026 * gainScale, 'bandpass', 2600, 1900, 2.0, 0.001)
}

function playChessThud(ctx: AudioContext, t: number, sharper = false): void {
  if (sharper) {
    // Sharper wood-on-wood capture knock
    playTone(ctx, t, 315, 110, 0.06, 0.058, 'triangle', 0.002)
    playTone(ctx, t, 1180, 620, 0.024, 0.028, 'sine', 0.0015)
    playFilteredNoise(ctx, t, 0.018, 0.03, 'bandpass', 1950, 1300, 1.8, 0.002)
  } else {
    // Weighted wooden piece thud + soft felt tap
    playTone(ctx, t, 210, 85, 0.064, 0.052, 'sine', 0.003)
    playFilteredNoise(ctx, t, 0.015, 0.022, 'bandpass', 1200, 850, 1.4, 0.002)
  }
}

export function playGameSound(cue: GameSoundCue, delayMs = 0): void {
  if (!bitchatAudio.isEnabled()) return

  const safeDelayMs = Number.isFinite(delayMs) && delayMs > 0 ? Math.min(delayMs, 4000) : 0
  const nowMs = Date.now()
  const scheduledBucket = Math.round((nowMs + safeDelayMs) / 25)
  const dedupeKey = `${cue}:${scheduledBucket}`
  const prevTs = recentBuckets.get(dedupeKey)
  if (prevTs !== undefined && nowMs - prevTs < 120) return
  recentBuckets.set(dedupeKey, nowMs)
  if (recentBuckets.size > 48) {
    for (const [key, ts] of recentBuckets) {
      if (nowMs - ts > 1500) recentBuckets.delete(key)
    }
  }

  const ctx = getAudioContext()
  if (!ctx) return

  const t = ctx.currentTime + safeDelayMs / 1000

  switch (cue) {
    case 'card-deal':
      // Short papery sliding swish-snap (~48ms around 2200Hz) + soft transient click
      playFilteredNoise(ctx, t, 0.048, 0.034, 'bandpass', 1850, 2450, 1.7, 0.006)
      playTone(ctx, t + 0.012, 1100, 540, 0.018, 0.018, 'triangle', 0.002)
      break

    case 'card-flip':
      // Two-stage crisp flick-snap: bright papery lift + 1200Hz -> 600Hz snap
      playFilteredNoise(ctx, t, 0.024, 0.022, 'highpass', 2500, 3200, 1.1, 0.003)
      playFilteredNoise(ctx, t + 0.018, 0.036, 0.034, 'bandpass', 2900, 2100, 1.6, 0.003)
      playTone(ctx, t + 0.018, 1200, 600, 0.034, 0.028, 'triangle', 0.002)
      break

    case 'card-fold':
      // Soft low-passed papery whoosh-slide (90ms, 1600Hz -> 420Hz)
      playFilteredNoise(ctx, t, 0.09, 0.03, 'lowpass', 1600, 420, 0.9, 0.012)
      break

    case 'chip-bet':
      // Clay casino chip clack-clink + tiny 18ms secondary settle clink
      playClayChipClink(ctx, t, 2450, 3900, 1)
      playClayChipClink(ctx, t + 0.018, 2660, 4120, 0.52)
      break

    case 'chip-allin':
      // Cascading 4-chip ceramic stack clatter over ~190ms
      playClayChipClink(ctx, t, 2320, 3720, 0.85)
      playClayChipClink(ctx, t + 0.048, 2480, 3940, 0.95)
      playClayChipClink(ctx, t + 0.098, 2620, 4120, 1.0)
      playClayChipClink(ctx, t + 0.148, 2510, 3960, 0.8)
      playTone(ctx, t + 0.155, 190, 92, 0.045, 0.026, 'sine', 0.004)
      break

    case 'chip-pot-win':
      // Warm chip sweep + gentle C5-E5-G5 harmonic shimmer
      playClayChipClink(ctx, t, 2380, 3820, 0.65)
      playClayChipClink(ctx, t + 0.046, 2540, 4020, 0.72)
      playClayChipClink(ctx, t + 0.092, 2680, 4200, 0.6)
      playTone(ctx, t + 0.06, 523.25, 523.25, 0.18, 0.03, 'sine', 0.012)
      playTone(ctx, t + 0.125, 659.25, 659.25, 0.2, 0.03, 'sine', 0.012)
      playTone(ctx, t + 0.195, 783.99, 783.99, 0.28, 0.032, 'triangle', 0.014)
      break

    case 'check-tap':
      // Authentic wooden/felt table double-knock (155Hz -> 70Hz, 105ms apart)
      playTone(ctx, t, 155, 70, 0.052, 0.056, 'sine', 0.003)
      playFilteredNoise(ctx, t, 0.018, 0.018, 'bandpass', 480, 340, 1.3, 0.002)
      playTone(ctx, t + 0.105, 150, 68, 0.055, 0.052, 'sine', 0.003)
      playFilteredNoise(ctx, t + 0.105, 0.018, 0.016, 'bandpass', 460, 320, 1.3, 0.002)
      break

    case 'your-turn':
      // Subtle refined two-note chime (587Hz -> 880Hz)
      playTone(ctx, t, 587.33, 587.33, 0.08, 0.028, 'sine', 0.008)
      playTone(ctx, t + 0.08, 880, 880, 0.135, 0.03, 'sine', 0.008)
      break

    case 'go-stone':
      playGoStoneClack(ctx, t, 1)
      break

    case 'go-capture':
      // Stone clack + brief soft pebble scoop rattle
      playGoStoneClack(ctx, t, 1)
      playTone(ctx, t + 0.068, 1720, 1340, 0.02, 0.018, 'sine', 0.002)
      playTone(ctx, t + 0.104, 2060, 1580, 0.02, 0.016, 'sine', 0.002)
      playTone(ctx, t + 0.142, 1890, 1460, 0.022, 0.014, 'triangle', 0.002)
      break

    case 'chess-move':
      playChessThud(ctx, t, false)
      break

    case 'chess-capture':
      playChessThud(ctx, t, true)
      break

    case 'chess-check':
      playChessThud(ctx, t, false)
      playTone(ctx, t + 0.036, 987.77, 880, 0.125, 0.032, 'sine', 0.006)
      break
  }
}
