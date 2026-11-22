/* ==========================================================================
   Zero-Asset Web Audio API Tactical Radio / Sonar SFX Synthesizer
   Generates crisp, subtle, low-volume tactile feedback without external files.
   ========================================================================== */

export type SoundCue =
  | 'send'
  | 'receive'
  | 'mention'
  | 'tune'
  | 'dm'
  | 'wipe'
  | 'click'
  | 'ring'
  | 'call-join'
  | 'call-leave'
  | 'rec-start'
  | 'rec-stop'

class RadioAudioEngine {
  private ctx: AudioContext | null = null
  private enabled = true
  private lastPlayed = new Map<SoundCue, number>()

  setEnabled(value: boolean) {
    this.enabled = value
  }

  isEnabled(): boolean {
    return this.enabled
  }

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return null
    if (!this.ctx) {
      try {
        this.ctx = new AudioCtx()
      } catch {
        return null
      }
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {})
    }
    return this.ctx
  }

  play(cue: SoundCue, force = false) {
    if (!this.enabled && !force) return

    // Rate-limit rapid bursts so busy channels stay pleasant
    const nowMs = Date.now()
    const minGap = cue === 'ring' ? 1200 : cue === 'receive' ? 350 : 90
    const prev = this.lastPlayed.get(cue) ?? 0
    if (nowMs - prev < minGap) return
    this.lastPlayed.set(cue, nowMs)

    const ctx = this.getContext()
    if (!ctx) return

    const t = ctx.currentTime

    switch (cue) {
      case 'send':
        this.tone(ctx, t, 740, 980, 0.065, 0.045, 'sine')
        break

      case 'receive':
        // Subtle glassy sonar ping
        this.tone(ctx, t, 660, 620, 0.09, 0.032, 'sine')
        break

      case 'mention':
        // Warm dual-tone transceiver chime
        this.tone(ctx, t, 659.25, 659.25, 0.09, 0.055, 'triangle')
        this.tone(ctx, t + 0.085, 880, 880, 0.14, 0.055, 'sine')
        break

      case 'dm':
        // Distinct 3-step ascending encrypted lock chime
        this.tone(ctx, t, 587.33, 587.33, 0.07, 0.05, 'sine')
        this.tone(ctx, t + 0.07, 783.99, 783.99, 0.07, 0.05, 'sine')
        this.tone(ctx, t + 0.14, 1046.5, 1046.5, 0.14, 0.05, 'sine')
        break

      case 'tune':
        // Crisp shortwave frequency lock click + micro-sweep
        this.noiseBurst(ctx, t, 0.035, 0.022, 2400)
        this.tone(ctx, t + 0.015, 420, 640, 0.075, 0.035, 'triangle')
        break

      case 'wipe':
        // Descending power-down sweep for Panic Wipe
        this.tone(ctx, t, 520, 110, 0.24, 0.065, 'sawtooth')
        break

      case 'click':
        this.tone(ctx, t, 920, 720, 0.028, 0.022, 'sine')
        break

      case 'ring':
        // Tactical dual-pulse sonar ringtone for incoming E2EE P2P calls
        this.tone(ctx, t, 587.33, 587.33, 0.14, 0.052, 'sine')
        this.tone(ctx, t + 0.01, 880, 880, 0.13, 0.032, 'triangle')
        this.tone(ctx, t + 0.22, 587.33, 587.33, 0.16, 0.052, 'sine')
        this.tone(ctx, t + 0.23, 880, 880, 0.15, 0.032, 'triangle')
        break

      case 'call-join':
        // Crisp 2-step ascending comms-channel lock-on chime
        this.tone(ctx, t, 440, 523.25, 0.08, 0.045, 'triangle')
        this.tone(ctx, t + 0.085, 659.25, 880, 0.14, 0.05, 'sine')
        break

      case 'call-leave':
        // Clean descending comms disconnect cadence
        this.tone(ctx, t, 587.33, 440, 0.09, 0.045, 'sine')
        this.tone(ctx, t + 0.09, 392, 293.66, 0.14, 0.04, 'triangle')
        break

      case 'rec-start':
        // Subtle crisp double-blip confirming call recording started
        this.tone(ctx, t, 880, 880, 0.055, 0.036, 'sine')
        this.tone(ctx, t + 0.075, 1174.66, 1174.66, 0.075, 0.04, 'sine')
        break

      case 'rec-stop':
        // Subtle descending single-blip confirming call recording saved
        this.tone(ctx, t, 987.77, 659.25, 0.095, 0.038, 'sine')
        break
    }
  }

  private tone(
    ctx: AudioContext,
    startTime: number,
    startFreq: number,
    endFreq: number,
    duration: number,
    peakGain: number,
    type: OscillatorType
  ) {
    try {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = type
      osc.frequency.setValueAtTime(startFreq, startTime)
      if (endFreq !== startFreq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(40, endFreq), startTime + duration)
      }

      gain.gain.setValueAtTime(0.0001, startTime)
      gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration)

      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(startTime)
      osc.stop(startTime + duration + 0.015)
    } catch {
      // Ignore audio errors on restricted devices
    }
  }

  private noiseBurst(
    ctx: AudioContext,
    startTime: number,
    duration: number,
    peakGain: number,
    centerFreq: number
  ) {
    try {
      const length = Math.max(1, Math.floor(ctx.sampleRate * duration))
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1
      }

      const source = ctx.createBufferSource()
      source.buffer = buffer

      const filter = ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.setValueAtTime(centerFreq, startTime)
      filter.Q.setValueAtTime(2.5, startTime)

      const gain = ctx.createGain()
      gain.gain.setValueAtTime(peakGain, startTime)
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration)

      source.connect(filter)
      filter.connect(gain)
      gain.connect(ctx.destination)
      source.start(startTime)
      source.stop(startTime + duration + 0.01)
    } catch {
      // Ignore audio errors
    }
  }
}

export const radioAudio = new RadioAudioEngine()
