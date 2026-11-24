/* ==========================================================================
   Offline Web Audio Ringtone, Ringback, Chime & Mobile Vibration Engine
   Zero external audio assets — works 100% offline inside installed PWAs.
   ========================================================================== */

export type NotificationChimeKind = 'dm' | 'mention' | 'message' | 'call'

const RING_INTERVAL_MS = 2700
const RINGBACK_INTERVAL_MS = 3800
const CHIME_THROTTLE_MS = 1500
const RING_VIBRATE_PATTERN: number[] = [480, 220, 480, 220, 620]

class SoundEngine {
  private ctx: AudioContext | null = null
  private limiter: DynamicsCompressorNode | null = null
  private unlockBound = false

  private ringTimer: number | null = null
  private ringing = false
  private ringMuted = false
  private ringAudioEnabled = true
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
        void ctx
          .resume()
          .then(() => {
            if (this.ringing && !this.ringMuted && this.ringAudioEnabled) {
              this.playRingPhrase()
            }
          })
          .catch(() => {})
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
        this.limiter = null
      } catch {
        return null
      }
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {})
    }
    return this.ctx
  }

  /**
   * Soft-limiting DynamicsCompressorNode output bus so loud phone-style
   * ringtones stay clear and punchy on mobile & desktop speakers without clipping.
   */
  private getOutputBus(ctx: AudioContext): AudioNode {
    if (this.limiter && this.limiter.context === ctx) {
      return this.limiter
    }
    try {
      if (typeof ctx.createDynamicsCompressor === 'function') {
        const comp = ctx.createDynamicsCompressor()
        comp.threshold.setValueAtTime(-7, ctx.currentTime)
        comp.knee.setValueAtTime(10, ctx.currentTime)
        comp.ratio.setValueAtTime(6, ctx.currentTime)
        comp.attack.setValueAtTime(0.003, ctx.currentTime)
        comp.release.setValueAtTime(0.14, ctx.currentTime)
        comp.connect(ctx.destination)
        this.limiter = comp
        return comp
      }
    } catch {
      // Fall back to direct destination if compressor is unavailable
    }
    return ctx.destination
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
    peakGain: number,
    richHarmonics = false
  ): void {
    try {
      const output = this.getOutputBus(ctx)

      // Fundamental sine + warm 2nd harmonic triangle (+ optional 3rd harmonic shimmer for ringtones)
      const osc1 = ctx.createOscillator()
      const osc2 = ctx.createOscillator()
      const gain1 = ctx.createGain()
      const gain2 = ctx.createGain()

      osc1.type = 'sine'
      osc1.frequency.setValueAtTime(freq, startTime)
      osc2.type = 'triangle'
      osc2.frequency.setValueAtTime(freq * 2, startTime)

      gain1.gain.setValueAtTime(0.0001, startTime)
      gain1.gain.linearRampToValueAtTime(peakGain, startTime + 0.012)
      gain1.gain.exponentialRampToValueAtTime(0.0001, startTime + duration)

      const secondRatio = richHarmonics ? 0.34 : 0.22
      gain2.gain.setValueAtTime(0.0001, startTime)
      gain2.gain.linearRampToValueAtTime(peakGain * secondRatio, startTime + 0.01)
      gain2.gain.exponentialRampToValueAtTime(0.0001, startTime + duration * 0.78)

      osc1.connect(gain1)
      osc2.connect(gain2)
      gain1.connect(output)
      gain2.connect(output)

      osc1.start(startTime)
      osc2.start(startTime)
      osc1.stop(startTime + duration + 0.025)
      osc2.stop(startTime + duration + 0.025)

      if (richHarmonics) {
        const osc3 = ctx.createOscillator()
        const gain3 = ctx.createGain()
        osc3.type = 'sine'
        osc3.frequency.setValueAtTime(freq * 3, startTime)
        gain3.gain.setValueAtTime(0.0001, startTime)
        gain3.gain.linearRampToValueAtTime(peakGain * 0.14, startTime + 0.008)
        gain3.gain.exponentialRampToValueAtTime(0.0001, startTime + duration * 0.52)
        osc3.connect(gain3)
        gain3.connect(output)
        osc3.start(startTime)
        osc3.stop(startTime + duration + 0.025)
      }
    } catch {
      // Ignore restricted audio state
    }
  }

  private playRingPhrase(): void {
    const ctx = this.ensureContext()
    if (!ctx) return

    const scheduleNotes = () => {
      const t = ctx.currentTime + 0.01
      // Loud, unmistakable multi-harmonic phone-style dual-phrase chime (E5 - G#5 - B5 - E6)
      // Routed through the DynamicsCompressorNode soft limiter for crisp speaker loudness without clipping
      const notes: Array<[number, number, number, number]> = [
        [0.0, 659.25, 0.26, 0.36],
        [0.125, 830.61, 0.26, 0.38],
        [0.25, 987.77, 0.3, 0.41],
        [0.4, 1318.51, 0.42, 0.4],
        [0.92, 659.25, 0.24, 0.34],
        [1.045, 830.61, 0.24, 0.36],
        [1.17, 987.77, 0.28, 0.39],
        [1.32, 1318.51, 0.46, 0.38],
      ]
      for (const [offset, freq, dur, gain] of notes) {
        this.scheduleBellNote(ctx, t + offset, freq, dur, gain, true)
      }
    }

    if (ctx.state === 'suspended') {
      void ctx
        .resume()
        .then(() => {
          if (!this.ringMuted) scheduleNotes()
        })
        .catch(() => {})
      return
    }

    scheduleNotes()
  }

  private playRingbackPulse(): void {
    const ctx = this.ensureContext()
    if (!ctx) return
    const t = ctx.currentTime
    const duration = 1.05

    try {
      const output = this.getOutputBus(ctx)
      const oscA = ctx.createOscillator()
      const oscB = ctx.createOscillator()
      const gain = ctx.createGain()

      oscA.type = 'sine'
      oscB.type = 'sine'
      oscA.frequency.setValueAtTime(440, t)
      oscB.frequency.setValueAtTime(480, t)

      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.linearRampToValueAtTime(0.055, t + 0.04)
      gain.gain.setValueAtTime(0.055, t + duration - 0.08)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration)

      oscA.connect(gain)
      oscB.connect(gain)
      gain.connect(output)

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

    this.ringAudioEnabled = playAudio
    this.ringVibrationEnabled = vibrate

    if (this.ringing) {
      // Already ringing (e.g. repeat-ring poke arrived): keep interval intact without duplicating
      if (!this.ringMuted && this.ringAudioEnabled) {
        const ctx = this.ensureContext()
        if (ctx && ctx.state === 'suspended') {
          void ctx.resume().catch(() => {})
        }
      }
      return
    }

    this.ringing = true
    this.ringMuted = false

    const pulse = () => {
      if (!this.ringing || this.ringMuted) return
      if (this.ringAudioEnabled) {
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
        this.scheduleBellNote(ctx, t, 587.33, 0.16, 0.085)
        this.scheduleBellNote(ctx, t + 0.08, 880, 0.22, 0.095)
      } else if (kind === 'mention' || kind === 'call') {
        this.scheduleBellNote(ctx, t, 659.25, 0.16, 0.09)
        this.scheduleBellNote(ctx, t + 0.09, 987.77, 0.22, 0.1)
      } else {
        this.scheduleBellNote(ctx, t, 783.99, 0.15, 0.072)
      }
    }

    if (opts?.vibrate) {
      this.vibrateSafe(kind === 'call' ? [220, 110, 220] : [110])
    }
  }

  playTestRingtone(vibrate = true): void {
    const prevMuted = this.ringMuted
    this.ringMuted = false
    this.playRingPhrase()
    this.ringMuted = prevMuted
    if (vibrate) {
      this.vibrateSafe(RING_VIBRATE_PATTERN)
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
