import type { CallParticipant } from '../types/calls.ts'

export type CallRecordingMode = 'audio' | 'video'

export interface CallRecordingStartOptions {
  onUnexpectedStop?: (errorMessage?: string) => void
  onBytesChange?: (bytes: number) => void
}

export interface CallRecordingStartResult {
  mode: CallRecordingMode
  startedAt: number
  mimeType: string
}

export interface CallRecordingStopResult {
  blob: Blob
  filename: string
  durationSec: number
  mode: CallRecordingMode
}

const CANVAS_WIDTH = 1280
const CANVAS_HEIGHT = 720
const CANVAS_FPS = 24

const VIDEO_MIME_CANDIDATES: readonly string[] = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
]

const AUDIO_MIME_CANDIDATES: readonly string[] = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
]

interface AudioSourceBinding {
  trackId: string
  source: MediaStreamAudioSourceNode
}

interface VideoElementBinding {
  trackId: string
  element: HTMLVideoElement
}

interface StreamListenerBinding {
  stream: MediaStream
  onTrackChange: () => void
}

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ||
    null
  )
}

export function isCallRecordingSupported(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof MediaRecorder === 'undefined') return false
  return getAudioContextCtor() !== null
}

function pickSupportedMime(mode: CallRecordingMode): string {
  const candidates = mode === 'video' ? VIDEO_MIME_CANDIDATES : AUDIO_MIME_CANDIDATES
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return ''
  }
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime
    } catch {
      // Ignore probe error
    }
  }
  return ''
}

function canRecordVideoCanvas(): boolean {
  if (typeof document === 'undefined' || typeof MediaRecorder === 'undefined') return false
  if (typeof HTMLCanvasElement === 'undefined') return false
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') return false
  if (typeof MediaRecorder.isTypeSupported === 'function') {
    return pickSupportedMime('video').length > 0
  }
  return true
}

function extensionForMime(mime: string, mode: CallRecordingMode): string {
  const lower = mime.toLowerCase()
  if (lower.includes('mp4')) return mode === 'video' ? 'mp4' : 'm4a'
  return 'webm'
}

function slugifyFilenameBase(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42)
  return cleaned || 'session'
}

function formatFilenameTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

function formatTimerLabel(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function getGridDimensions(count: number): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 }
  if (count === 2) return { cols: 2, rows: 1 }
  if (count <= 4) return { cols: 2, rows: 2 }
  return { cols: 3, rows: 2 }
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function pickActiveAudioTrack(participant: CallParticipant): MediaStreamTrack | null {
  const tracks = participant.stream?.getAudioTracks() ?? []
  return tracks.find((t) => t.readyState === 'live') ?? null
}

function pickActiveVideoTrack(participant: CallParticipant): MediaStreamTrack | null {
  if (!participant.videoEnabled && !participant.screenSharing) return null
  const liveTracks = (participant.stream?.getVideoTracks() ?? []).filter(
    (t) => t.readyState === 'live' && t.enabled
  )
  if (liveTracks.length === 0) return null
  return liveTracks.find((t) => !t.muted) ?? liveTracks[0] ?? null
}

export class CallRecorderController {
  private audioCtx: AudioContext | null = null
  private audioDest: MediaStreamAudioDestinationNode | null = null
  private silenceOsc: OscillatorNode | null = null
  private silenceGain: GainNode | null = null
  private audioSources = new Map<string, AudioSourceBinding>()

  private canvasCtx: CanvasRenderingContext2D | null = null
  private canvasStream: MediaStream | null = null
  private videoHostEl: HTMLDivElement | null = null
  private drawTimer: number | null = null
  private videoElements = new Map<string, VideoElementBinding>()
  private streamListeners = new Map<string, StreamListenerBinding>()

  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private recordedBytes = 0
  private onBytesChange: ((bytes: number) => void) | null = null
  private latestParticipants: CallParticipant[] = []
  private mode: CallRecordingMode | null = null
  private mimeType = ''
  private startedAt = 0
  private active = false
  private stopping = false
  private aborted = false

  isRecording(): boolean {
    return this.active && !this.aborted
  }

  getMode(): CallRecordingMode | null {
    return this.mode
  }

  getStartedAt(): number | null {
    return this.active ? this.startedAt : null
  }

  getRecordedBytes(): number {
    return this.active ? this.recordedBytes : 0
  }

  start(
    participants: readonly CallParticipant[],
    options?: CallRecordingStartOptions
  ): CallRecordingStartResult {
    if (this.active) {
      return {
        mode: this.mode ?? 'video',
        startedAt: this.startedAt,
        mimeType: this.mimeType,
      }
    }

    if (!isCallRecordingSupported()) {
      throw new Error('Call recording is not supported in this browser.')
    }

    const AudioCtxCtor = getAudioContextCtor()
    if (!AudioCtxCtor) {
      throw new Error('Web Audio API unavailable for call recording.')
    }

    this.aborted = false
    this.stopping = false
    this.chunks = []
    this.recordedBytes = 0
    this.onBytesChange = options?.onBytesChange ?? null
    this.latestParticipants = [...participants]

    // 1. Set up dynamic Web Audio mixer for all participants
    const ctx = new AudioCtxCtor()
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {})
    }
    const dest = ctx.createMediaStreamDestination()

    // Silent keepalive oscillator ensures valid audio frames even when everyone is muted
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    gain.gain.value = 0
    osc.connect(gain)
    gain.connect(dest)
    osc.start()

    this.audioCtx = ctx
    this.audioDest = dest
    this.silenceOsc = osc
    this.silenceGain = gain

    // 2. Always record with the 1280x720 canvas compositor + mixed audio whenever video
    // MediaRecorder is supported so voice-only participants seamlessly appear on video if
    // they enable camera or screen share mid-recording! Fall back to audio-only ONLY when
    // the browser has no video MediaRecorder / canvas.captureStream support.
    let chosenMode: CallRecordingMode = canRecordVideoCanvas() ? 'video' : 'audio'
    let combinedStream: MediaStream

    if (chosenMode === 'video' && typeof document !== 'undefined') {
      const canvas = document.createElement('canvas')
      canvas.width = CANVAS_WIDTH
      canvas.height = CANVAS_HEIGHT
      const c2d = canvas.getContext('2d')

      if (c2d && typeof canvas.captureStream === 'function') {
        this.canvasCtx = c2d
        this.canvasStream = canvas.captureStream(CANVAS_FPS)
        this.ensureVideoHostElement()
        const tracks: MediaStreamTrack[] = [
          ...this.canvasStream.getVideoTracks(),
          ...dest.stream.getAudioTracks(),
        ]
        combinedStream = new MediaStream(tracks)
      } else {
        chosenMode = 'audio'
        combinedStream = dest.stream
      }
    } else {
      chosenMode = 'audio'
      combinedStream = dest.stream
    }

    this.mode = chosenMode
    this.startedAt = Date.now()
    this.syncParticipants(participants)

    if (chosenMode === 'video') {
      this.drawCompositeFrame()
      this.drawTimer = window.setInterval(() => {
        this.drawCompositeFrame()
      }, Math.round(1000 / CANVAS_FPS))
    }

    // 3. Instantiate MediaRecorder with best supported codec
    const pickedMime = pickSupportedMime(chosenMode)
    const recorderOpts: MediaRecorderOptions = {
      audioBitsPerSecond: 64_000,
    }
    if (chosenMode === 'video') {
      recorderOpts.videoBitsPerSecond = 1_500_000
    }
    if (pickedMime) {
      recorderOpts.mimeType = pickedMime
    }

    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(combinedStream, recorderOpts)
    } catch {
      // Fallback without explicit bitrate/mime options
      recorder = new MediaRecorder(combinedStream)
    }

    this.mimeType =
      recorder.mimeType || pickedMime || (chosenMode === 'video' ? 'video/webm' : 'audio/webm')
    this.recorder = recorder
    this.active = true
    this.onBytesChange?.(0)

    recorder.ondataavailable = (event: BlobEvent) => {
      if (this.aborted) return
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data)
        this.recordedBytes += event.data.size
        this.onBytesChange?.(this.recordedBytes)
      }
    }

    recorder.onerror = () => {
      if (this.aborted || this.stopping) return
      this.abort()
      options?.onUnexpectedStop?.('MediaRecorder encountered an error while recording.')
    }

    recorder.start(1000)

    return {
      mode: chosenMode,
      startedAt: this.startedAt,
      mimeType: this.mimeType,
    }
  }

  syncParticipants(participants: readonly CallParticipant[]): void {
    this.latestParticipants = [...participants]
    if (!this.audioCtx || !this.audioDest) return

    const activePubkeys = new Set<string>()
    for (const p of participants) {
      const pk = p.pubkey.toLowerCase()
      activePubkeys.add(pk)

      // Attach addtrack/removetrack listeners so mid-call track additions on existing
      // MediaStream instances are captured immediately even without a React render.
      this.syncStreamListener(pk, p.stream)

      // Sync audio track by live track ID into Web Audio mixer
      const audioTrack = pickActiveAudioTrack(p)
      const existingAudio = this.audioSources.get(pk)
      if (audioTrack) {
        if (!existingAudio || existingAudio.trackId !== audioTrack.id) {
          if (existingAudio) {
            try {
              existingAudio.source.disconnect()
            } catch {
              // Ignore
            }
          }
          try {
            const source = this.audioCtx.createMediaStreamSource(new MediaStream([audioTrack]))
            source.connect(this.audioDest)
            this.audioSources.set(pk, { trackId: audioTrack.id, source })
          } catch {
            // Ignore unsupported track source errors
          }
        }
      } else if (existingAudio) {
        try {
          existingAudio.source.disconnect()
        } catch {
          // Ignore
        }
        this.audioSources.delete(pk)
      }

      // Sync video element by live video track ID for canvas compositor
      if (this.mode === 'video' && typeof document !== 'undefined') {
        const videoTrack = pickActiveVideoTrack(p)
        const existingVideo = this.videoElements.get(pk)
        if (videoTrack) {
          if (!existingVideo || existingVideo.trackId !== videoTrack.id) {
            if (existingVideo) {
              this.cleanupVideoElement(existingVideo.element)
            }
            const el = this.createCompositorVideoElement(videoTrack)
            this.videoElements.set(pk, { trackId: videoTrack.id, element: el })
          } else if (existingVideo.element.paused && existingVideo.element.readyState >= 1) {
            void existingVideo.element.play().catch(() => {})
          }
        } else if (existingVideo) {
          this.cleanupVideoElement(existingVideo.element)
          this.videoElements.delete(pk)
        }
      }
    }

    // Remove departed participants from audio mixer, video map, and stream listeners
    for (const [pk, binding] of Array.from(this.audioSources.entries())) {
      if (!activePubkeys.has(pk)) {
        try {
          binding.source.disconnect()
        } catch {
          // Ignore
        }
        this.audioSources.delete(pk)
      }
    }
    for (const [pk, binding] of Array.from(this.videoElements.entries())) {
      if (!activePubkeys.has(pk)) {
        this.cleanupVideoElement(binding.element)
        this.videoElements.delete(pk)
      }
    }
    for (const [pk] of Array.from(this.streamListeners.entries())) {
      if (!activePubkeys.has(pk)) {
        this.detachStreamListener(pk)
      }
    }
  }

  async stopAndDownload(filenameBase: string): Promise<CallRecordingStopResult | null> {
    if (!this.active || !this.recorder || this.stopping) {
      this.cleanupResources()
      return null
    }

    this.stopping = true
    const rec = this.recorder
    const recordedMode = this.mode ?? 'video'
    const recordedMime = this.mimeType || (recordedMode === 'video' ? 'video/webm' : 'audio/webm')
    const durationSec = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000))

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        resolve()
      }
      const timer = window.setTimeout(finish, 3000)
      rec.onstop = () => finish()
      try {
        if (rec.state !== 'inactive') {
          try {
            rec.requestData()
          } catch {
            // Some browsers ignore requestData right before stop
          }
          rec.stop()
        } else {
          finish()
        }
      } catch {
        finish()
      }
    })

    const collected = this.aborted ? [] : [...this.chunks]
    this.cleanupResources()

    if (collected.length === 0) return null

    const blob = new Blob(collected, { type: recordedMime })
    if (blob.size === 0) return null

    const ext = extensionForMime(recordedMime, recordedMode)
    const slug = slugifyFilenameBase(filenameBase)
    const stamp = formatFilenameTimestamp(new Date())
    const filename = `agnostr-call-${slug}-${stamp}.${ext}`

    if (typeof document !== 'undefined' && typeof URL !== 'undefined') {
      const objectUrl = URL.createObjectURL(blob)
      try {
        const link = document.createElement('a')
        link.href = objectUrl
        link.download = filename
        link.style.display = 'none'
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
      } finally {
        window.setTimeout(() => {
          URL.revokeObjectURL(objectUrl)
        }, 15_000)
      }
    }

    return {
      blob,
      filename,
      durationSec,
      mode: recordedMode,
    }
  }

  abort(): void {
    this.aborted = true
    this.stopping = true
    const rec = this.recorder
    if (rec && rec.state !== 'inactive') {
      try {
        rec.onstop = null
        rec.ondataavailable = null
        rec.onerror = null
        rec.stop()
      } catch {
        // Ignore
      }
    }
    this.chunks = []
    this.cleanupResources()
  }

  private ensureVideoHostElement(): HTMLDivElement | null {
    if (typeof document === 'undefined' || !document.body) return null
    if (this.videoHostEl && this.videoHostEl.isConnected) return this.videoHostEl
    const host = document.createElement('div')
    host.setAttribute('aria-hidden', 'true')
    host.style.position = 'fixed'
    host.style.left = '-4px'
    host.style.top = '-4px'
    host.style.width = '2px'
    host.style.height = '2px'
    host.style.opacity = '0.001'
    host.style.pointerEvents = 'none'
    host.style.overflow = 'hidden'
    host.style.zIndex = '-1'
    document.body.appendChild(host)
    this.videoHostEl = host
    return host
  }

  private createCompositorVideoElement(videoTrack: MediaStreamTrack): HTMLVideoElement {
    const el = document.createElement('video')
    el.muted = true
    el.playsInline = true
    el.autoplay = true
    el.style.width = '2px'
    el.style.height = '2px'
    el.srcObject = new MediaStream([videoTrack])
    el.onloadedmetadata = () => {
      void el.play().catch(() => {})
    }
    el.oncanplay = () => {
      if (el.paused) void el.play().catch(() => {})
    }
    const host = this.ensureVideoHostElement()
    if (host) {
      host.appendChild(el)
    }
    void el.play().catch(() => {})
    return el
  }

  private syncStreamListener(pk: string, stream: MediaStream | null): void {
    const existing = this.streamListeners.get(pk)
    if (existing && existing.stream === stream) return
    if (existing) this.detachStreamListener(pk)
    if (!stream) return
    const onTrackChange = () => {
      if (this.active) {
        this.syncParticipants(this.latestParticipants)
      }
    }
    stream.addEventListener('addtrack', onTrackChange)
    stream.addEventListener('removetrack', onTrackChange)
    this.streamListeners.set(pk, { stream, onTrackChange })
  }

  private detachStreamListener(pk: string): void {
    const existing = this.streamListeners.get(pk)
    if (!existing) return
    existing.stream.removeEventListener('addtrack', existing.onTrackChange)
    existing.stream.removeEventListener('removetrack', existing.onTrackChange)
    this.streamListeners.delete(pk)
  }

  private reconcileTracksBeforeDraw(): void {
    let needsSync = false
    for (const p of this.latestParticipants) {
      const pk = p.pubkey.toLowerCase()
      const activeAudio = pickActiveAudioTrack(p)
      const boundAudio = this.audioSources.get(pk)
      if ((activeAudio?.id ?? null) !== (boundAudio?.trackId ?? null)) {
        needsSync = true
        break
      }
      const activeVideo = pickActiveVideoTrack(p)
      const boundVideo = this.videoElements.get(pk)
      if ((activeVideo?.id ?? null) !== (boundVideo?.trackId ?? null)) {
        needsSync = true
        break
      }
    }
    if (needsSync) {
      this.syncParticipants(this.latestParticipants)
    }
  }

  private drawCompositeFrame(): void {
    const ctx = this.canvasCtx
    if (!ctx) return

    // Catch any mid-call track unmute/addTrack immediately before rendering this frame
    this.reconcileTracksBeforeDraw()

    ctx.fillStyle = '#090C0A'
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)

    const list = this.latestParticipants.slice(0, 6)
    if (list.length === 0) return

    const pad = 16
    const gap = 12
    const { cols, rows } = getGridDimensions(list.length)
    const tileW = Math.floor((CANVAS_WIDTH - pad * 2 - gap * (cols - 1)) / cols)
    const tileH = Math.floor((CANVAS_HEIGHT - pad * 2 - gap * (rows - 1)) / rows)

    list.forEach((p, idx) => {
      const col = idx % cols
      const row = Math.floor(idx / cols)
      const x = pad + col * (tileW + gap)
      const y = pad + row * (tileH + gap)

      ctx.save()
      drawRoundedRect(ctx, x, y, tileW, tileH, 14)
      ctx.clip()

      // Tile base background
      ctx.fillStyle = '#111814'
      ctx.fillRect(x, y, tileW, tileH)

      const vidBinding = this.videoElements.get(p.pubkey.toLowerCase())
      const vid = vidBinding?.element
      if (vid && vid.paused && vid.readyState >= 1) {
        void vid.play().catch(() => {})
      }

      if (vid && vid.readyState >= 2 && vid.videoWidth > 0 && vid.videoHeight > 0) {
        const vw = vid.videoWidth
        const vh = vid.videoHeight
        if (p.screenSharing) {
          // Contain-fit screen shares so shared text stays fully readable
          const scale = Math.min(tileW / vw, tileH / vh)
          const dw = vw * scale
          const dh = vh * scale
          const dx = x + (tileW - dw) / 2
          const dy = y + (tileH - dh) / 2
          ctx.drawImage(vid, dx, dy, dw, dh)
        } else {
          // Cover-fit camera tiles cleanly
          const scale = Math.max(tileW / vw, tileH / vh)
          const dw = vw * scale
          const dh = vh * scale
          const dx = x + (tileW - dw) / 2
          const dy = y + (tileH - dh) / 2
          ctx.drawImage(vid, dx, dy, dw, dh)
        }
      } else {
        // Audio-only tile monogram
        const cx = x + tileW / 2
        const cy = y + tileH / 2 - 8
        const radius = Math.min(tileW, tileH) * 0.17
        ctx.beginPath()
        ctx.arc(cx, cy, radius, 0, Math.PI * 2)
        ctx.fillStyle = p.isSpeaking ? 'rgba(34, 229, 132, 0.18)' : 'rgba(255, 255, 255, 0.06)'
        ctx.fill()
        ctx.lineWidth = p.isSpeaking ? 3 : 1.5
        ctx.strokeStyle = p.isSpeaking ? '#22E584' : 'rgba(255, 255, 255, 0.18)'
        ctx.stroke()

        const initials = (p.nickname || 'AN').slice(0, 2).toUpperCase()
        ctx.fillStyle = '#E6F2EB'
        ctx.font = `700 ${Math.max(18, Math.round(radius * 0.72))}px "JetBrains Mono", monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(initials, cx, cy + 1)
      }

      // Bottom-left handle badge
      const labelParts = [p.displayHandle]
      if (p.isSelf) labelParts.push('YOU')
      if (p.audioMuted) labelParts.push('MUTED')
      if (p.screenSharing) labelParts.push('SCREEN')
      const labelText = labelParts.join(' · ')
      ctx.font = '600 13px "JetBrains Mono", monospace'
      const textWidth = ctx.measureText(labelText).width
      const pillW = Math.min(tileW - 24, textWidth + 20)
      const pillH = 26
      const pillX = x + 12
      const pillY = y + tileH - pillH - 12

      drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 7)
      ctx.fillStyle = 'rgba(9, 12, 10, 0.78)'
      ctx.fill()
      ctx.fillStyle = '#E6F2EB'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(labelText, pillX + 10, pillY + pillH / 2 + 0.5, pillW - 18)

      // Top-right crimson recording dot on recording participants
      if (p.isRecording) {
        ctx.beginPath()
        ctx.arc(x + tileW - 18, y + 18, 6, 0, Math.PI * 2)
        ctx.fillStyle = '#EF4444'
        ctx.fill()
      }

      ctx.restore()

      // Outer tile border (glows green when speaking)
      drawRoundedRect(ctx, x, y, tileW, tileH, 14)
      ctx.lineWidth = p.isSpeaking ? 3 : 1
      ctx.strokeStyle = p.isSpeaking ? '#22E584' : 'rgba(255, 255, 255, 0.14)'
      ctx.stroke()
    })

    // Subtle REC timer stamp top-right of canvas
    const stampText = `● REC · ${formatTimerLabel(Date.now() - this.startedAt)}`
    ctx.font = '700 13px "JetBrains Mono", monospace'
    const sw = ctx.measureText(stampText).width + 20
    const sx = CANVAS_WIDTH - sw - 22
    const sy = 22
    drawRoundedRect(ctx, sx, sy, sw, 26, 13)
    ctx.fillStyle = 'rgba(127, 29, 29, 0.85)'
    ctx.fill()
    ctx.fillStyle = '#FEE2E2'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(stampText, sx + sw / 2, sy + 13.5)
  }

  private cleanupVideoElement(el: HTMLVideoElement): void {
    try {
      el.onloadedmetadata = null
      el.oncanplay = null
      el.pause()
      el.srcObject = null
      el.remove()
    } catch {
      // Ignore
    }
  }

  private cleanupResources(): void {
    const bytesCb = this.onBytesChange
    this.onBytesChange = null
    this.active = false
    this.stopping = false
    this.mode = null
    this.recorder = null
    this.chunks = []
    this.recordedBytes = 0
    bytesCb?.(0)

    if (this.drawTimer !== null) {
      window.clearInterval(this.drawTimer)
      this.drawTimer = null
    }

    for (const pk of Array.from(this.streamListeners.keys())) {
      this.detachStreamListener(pk)
    }

    for (const binding of this.videoElements.values()) {
      this.cleanupVideoElement(binding.element)
    }
    this.videoElements.clear()

    if (this.videoHostEl) {
      try {
        this.videoHostEl.remove()
      } catch {
        // Ignore
      }
      this.videoHostEl = null
    }

    if (this.canvasStream) {
      this.canvasStream.getTracks().forEach((t) => t.stop())
      this.canvasStream = null
    }
    this.canvasCtx = null

    for (const binding of this.audioSources.values()) {
      try {
        binding.source.disconnect()
      } catch {
        // Ignore
      }
    }
    this.audioSources.clear()

    if (this.silenceOsc) {
      try {
        this.silenceOsc.stop()
        this.silenceOsc.disconnect()
      } catch {
        // Ignore
      }
      this.silenceOsc = null
    }
    if (this.silenceGain) {
      try {
        this.silenceGain.disconnect()
      } catch {
        // Ignore
      }
      this.silenceGain = null
    }
    this.audioDest = null

    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {})
      this.audioCtx = null
    }
  }
}
