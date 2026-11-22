/* ==========================================================================
   Offline Web Audio Ringtone, Ringback, Chime & Mobile Vibration Engine
   Zero external audio assets — works 100% offline inside installed PWAs.
   ========================================================================== */

export type NotificationChimeKind = 'dm' | 'mention' | 'message' | 'call'

const RING_INTERVAL_MS = 2800
const RINGBACK_INTERVAL_MS = 3800
const CHIME_THROTTLE_MS = 1500
const RING_VIBRATE_PATTERN: number[] = [380, 180, 380, 1400]

class SoundEngine {
  private ctx: AudioContext | null = null
  private unlockBound = false

  private ringTimer: number | null = null
  private ringing = false
  private ringMuted = false
  private ringVibrationEnabled = true

  private ringbackTimer: number | null = null
  private ringbackActive = false

  private lastChimeAt = 0

  constructor() {
    this.bindAutoUnlock()
  }

  private bindAutoUnlock(): void {
    if (this.unlockBound || typeof window === 'undefined') return
    this.unlockBound = true

    const unlock = () => {
      const ctx = this.ensureContext()
      if (ctx && ctx.state === 'suspended') {
        void ctx.resume().catch(() => {})
      }
      if (ctx && ctx.state === 'running') {
        window.removeEventListener('pointerdown', unlock, true)
        window.removeEventListener('touchstart', unlock, true)
        window.removeEventListener('keydown', unlock, true)
      }
    }

    window.addEventListener('pointerdown', unlock, { capture: true, passive: true })
    window.addEventListener('touchstart', unlock, { capture: true, passive: true })
    window.addEventListener('keydown', unlock, { capture: true, passive: true })
  }

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!AudioCtx) return null
    if (!this.ctx) {
      try {
        this.ctx = new AudioCtx()
      } catch {
        return null
      }
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {})
    }
    return this.ctx
  }

  private vibrateSafe(pattern: number | number[]): void {
    try {
      if (
        typeof navigator !== 'undefined' &&
        typeof navigator.vibrate === 'function'
      ) {
        navigator.vibrate(pattern)
      }
    } catch {
      // Ignore vibration permission or unsupported platform errors
    }
  }

  private scheduleBellNote(
    ctx: AudioContext,
    startTime: number,
    freq: number,
    duration: number,
    peakGain: number
  ): void {
    try {
      // Fundamental sine + gentle second-harmonic shimmer
      const osc1 = ctx.createOscillator()
      const osc2 = ctx.createOscillator()
      const gain1 = ctx.createGain()
      const gain2 = ctx.createGain()

      osc1.type = 'sine'
      osc1.frequency.setValueAtTime(freq, startTime)
      osc2.type = 'triangle'
      osc2.frequency.setValueAtTime(freq * 2, startTime)

      gain1.gain.setValueAtTime(0.0001, startTime)
      gain1.gain.linearRampToValueAtTime(peakGain, startTime + 0.014)
      gain1.gain.exponentialRampToValueAtTime(0.0001, startTime + duration)

      gain2.gain.setValueAtTime(0.0001, startTime)
      gain2.gain.linearRampToValueAtTime(peakGain * 0.22, startTime + 0.01)
      gain2.gain.exponentialRampToValueAtTime(0.0001, startTime + duration * 0.72)

      osc1.connect(gain1)
      osc2.connect(gain2)
      gain1.connect(ctx.destination)
      gain2.connect(ctx.destination)

      osc1.start(startTime)
      osc2.start(startTime)
      osc1.stop(startTime + duration + 0.02)
      osc2.stop(startTime + duration + 0.02)
    } catch {
      // Ignore restricted audio state
    }
  }

  private playRingPhrase(): void {
    const ctx = this.ensureContext()
    if (!ctx) return
    const t = ctx.currentTime

    // Modern uplifting dual-phrase melodic ringtone (E5 - G#5 - B5 - E6, echoed gently)
    const notes: Array<[number, number, number, number]> = [
      [0.0, 659.25, 0.24, 0.085],
      [0.13, 830.61, 0.24, 0.085],
      [0.26, 987.77, 0.28, 0.09],
      [0.42, 1318.51, 0.38, 0.085],
      [0.95, 659.25, 0.22, 0.075],
      [1.08, 830.61, 0.22, 0.075],
      [1.21, 987.77, 0.26, 0.08],
      [1.37, 1318.51, 0.42, 0.08],
    ]
    for (const [offset, freq, dur, gain] of notes) {
      this.scheduleBellNote(ctx, t + offset, freq, dur, gain)
    }
  }

  private playRingbackPulse(): void {
    const ctx = this.ensureContext()
    if (!ctx) return
    const t = ctx.currentTime
    const duration = 1.05

    try {
      const oscA = ctx.createOscillator()
      const oscB = ctx.createOscillator()
      const gain = ctx.createGain()

      oscA.type = 'sine'
      oscB.type = 'sine'
      oscA.frequency.setValueAtTime(440, t)
      oscB.frequency.setValueAtTime(480, t)

      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.linearRampToValueAtTime(0.028, t + 0.04)
      gain.gain.setValueAtTime(0.028, t + duration - 0.08)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration)

      oscA.connect(gain)
      oscB.connect(gain)
      gain.connect(ctx.destination)

      oscA.start(t)
      oscB.start(t)
      oscA.stop(t + duration + 0.02)
      oscB.stop(t + duration + 0.02)
    } catch {
      // Ignore audio errors
    }
  }

  startIncomingRing(opts?: { playAudio?: boolean; vibrate?: boolean }): void {
    const playAudio = opts?.playAudio ?? true
    const vibrate = opts?.vibrate ?? true
    this.stopOutgoingRingback()

    if (this.ringing) return
    this.ringing = true
    this.ringMuted = false
    this.ringVibrationEnabled = vibrate

    const pulse = () => {
      if (!this.ringing || this.ringMuted) return
      if (playAudio) {
        this.playRingPhrase()
      }
      if (this.ringVibrationEnabled) {
        this.vibrateSafe(RING_VIBRATE_PATTERN)
      }
    }

    pulse()
    this.ringTimer = window.setInterval(pulse, RING_INTERVAL_MS)
  }

  muteCurrentRing(): void {
    if (!this.ringing) return
    this.ringMuted = true
    this.vibrateSafe(0)
  }

  stopIncomingRing(): void {
    this.ringing = false
    this.ringMuted = false
    if (this.ringTimer !== null) {
      window.clearInterval(this.ringTimer)
      this.ringTimer = null
    }
    this.vibrateSafe(0)
  }

  isIncomingRinging(): boolean {
    return this.ringing
  }

  isCurrentRingMuted(): boolean {
    return this.ringMuted
  }

  startOutgoingRingback(): void {
    if (this.ringbackActive) return
    this.ringbackActive = true
    this.playRingbackPulse()
    this.ringbackTimer = window.setInterval(() => {
      if (!this.ringbackActive) return
      this.playRingbackPulse()
    }, RINGBACK_INTERVAL_MS)
  }

  stopOutgoingRingback(): void {
    this.ringbackActive = false
    if (this.ringbackTimer !== null) {
      window.clearInterval(this.ringbackTimer)
      this.ringbackTimer = null
    }
  }

  playNotificationChime(
    kind: NotificationChimeKind = 'message',
    opts?: { bypassThrottle?: boolean; vibrate?: boolean }
  ): void {
    const now = Date.now()
    if (!opts?.bypassThrottle && now - this.lastChimeAt < CHIME_THROTTLE_MS) {
      return
    }
    this.lastChimeAt = now

    const ctx = this.ensureContext()
    if (ctx) {
      const t = ctx.currentTime
      if (kind === 'dm') {
        this.scheduleBellNote(ctx, t, 587.33, 0.16, 0.06)
        this.scheduleBellNote(ctx, t + 0.08, 880, 0.22, 0.065)
      } else if (kind === 'mention' || kind === 'call') {
        this.scheduleBellNote(ctx, t, 659.25, 0.16, 0.06)
        this.scheduleBellNote(ctx, t + 0.09, 987.77, 0.22, 0.065)
      } else {
        this.scheduleBellNote(ctx, t, 783.99, 0.15, 0.048)
      }
    }

    if (opts?.vibrate) {
      this.vibrateSafe(kind === 'call' ? [180, 90, 180] : [110])
    }
  }

  playTestRingtone(vibrate = true): void {
    this.playRingPhrase()
    if (vibrate) {
      this.vibrateSafe([300, 150, 300])
    }
  }

  playTestChime(vibrate = false): void {
    this.playNotificationChime('dm', { bypassThrottle: true, vibrate })
  }

  stopAll(): void {
    this.stopIncomingRing()
    this.stopOutgoingRingback()
  }
}

export const soundEngine = new SoundEngine()
