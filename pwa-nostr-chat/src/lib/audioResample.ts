import type { CallParticipant } from '../types/calls.ts'

export const ASR_SAMPLE_RATE = 16_000
const DEFAULT_MAX_MEMO_DURATION_SEC = 90

const WORKLET_PROCESSOR_NAME = 'agnostr-pcm16k-capturer'
const WORKLET_CHUNK_SAMPLES = 1280 // 80ms @ 16kHz
const SPEECH_RMS_THRESHOLD = 0.014
const MIN_SPEECH_MS = 450
const SILENCE_FLUSH_MS = 650
const MAX_UTTERANCE_MS = 4500
const PRE_ROLL_CHUNKS = 2

export interface CapturedSpeechSegment {
  pubkey: string
  nickname: string
  displayHandle: string
  isSelf: boolean
  pcm16k: Float32Array
  timestamp: number
}

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ||
    null
  )
}

function getOfflineAudioContextCtor(): typeof OfflineAudioContext | null {
  if (typeof window === 'undefined') return null
  return (
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext ||
    null
  )
}

function mixAudioBufferToMono(audioBuffer: AudioBuffer, maxFrames: number): Float32Array {
  const frameCount = Math.min(audioBuffer.length, maxFrames)
  const channels = audioBuffer.numberOfChannels
  if (channels <= 1) {
    return audioBuffer.getChannelData(0).slice(0, frameCount)
  }
  const mono = new Float32Array(frameCount)
  const inv = 1 / channels
  for (let ch = 0; ch < channels; ch++) {
    const data = audioBuffer.getChannelData(ch)
    for (let i = 0; i < frameCount; i++) {
      mono[i] += data[i] * inv
    }
  }
  return mono
}

export function resampleMonoLinear(
  input: Float32Array,
  fromRate: number,
  toRate = ASR_SAMPLE_RATE
): Float32Array {
  if (input.length === 0) return new Float32Array(0)
  if (fromRate === toRate) return input.slice()
  const ratio = fromRate / toRate
  const outLength = Math.max(1, Math.round(input.length / ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio
    const idx = Math.floor(srcPos)
    const frac = srcPos - idx
    const s0 = input[Math.min(idx, input.length - 1)]
    const s1 = input[Math.min(idx + 1, input.length - 1)]
    out[i] = s0 + (s1 - s0) * frac
  }
  return out
}

/**
 * Decode an audio Blob (WebM/Opus, MP4/AAC, OGG, WAV, etc.) into a 16 kHz mono Float32Array
 * suitable for Hugging Face Transformers.js ASR pipelines.
 */
export async function decodeBlobToPcm16k(
  blob: Blob,
  maxDurationSec = DEFAULT_MAX_MEMO_DURATION_SEC
): Promise<Float32Array> {
  if (blob.size === 0) {
    throw new Error('Audio clip is empty.')
  }
  const AudioCtxCtor = getAudioContextCtor()
  if (!AudioCtxCtor) {
    throw new Error('Web Audio API is unavailable in this browser.')
  }

  const rawBytes = await blob.arrayBuffer()
  const decodeCtx = new AudioCtxCtor()
  try {
    const decoded = await decodeCtx.decodeAudioData(rawBytes.slice(0))
    if (decoded.length === 0 || decoded.duration <= 0) {
      throw new Error('Decoded audio clip contains no samples.')
    }

    const cappedDuration = Math.min(decoded.duration, maxDurationSec)
    const targetFrames = Math.max(1, Math.ceil(cappedDuration * ASR_SAMPLE_RATE))

    if (decoded.sampleRate === ASR_SAMPLE_RATE && decoded.numberOfChannels === 1) {
      return decoded.getChannelData(0).slice(0, targetFrames)
    }

    const OfflineCtxCtor = getOfflineAudioContextCtor()
    if (OfflineCtxCtor) {
      try {
        const offline = new OfflineCtxCtor(1, targetFrames, ASR_SAMPLE_RATE)
        const src = offline.createBufferSource()
        src.buffer = decoded
        src.connect(offline.destination)
        src.start(0, 0, cappedDuration)
        const rendered = await offline.startRendering()
        return rendered.getChannelData(0).slice()
      } catch {
        // Fall through to linear resampler if OfflineAudioContext rejects short clips
      }
    }

    const maxSourceFrames = Math.ceil(cappedDuration * decoded.sampleRate)
    const mono = mixAudioBufferToMono(decoded, maxSourceFrames)
    return resampleMonoLinear(mono, decoded.sampleRate, ASR_SAMPLE_RATE)
  } finally {
    await decodeCtx.close().catch(() => {})
  }
}

function concatFloat32Chunks(chunks: readonly Float32Array[]): Float32Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Float32Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]
    sumSq += v * v
  }
  return Math.sqrt(sumSq / samples.length)
}

function buildWorkletModuleCode(): string {
  return `
class AgnostrPcm16kCapturer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stopped = false;
    this.targetRate = ${ASR_SAMPLE_RATE};
    this.ratio = sampleRate / this.targetRate;
    this.phase = 0;
    this.buffer = new Float32Array(${WORKLET_CHUNK_SAMPLES});
    this.writeIdx = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'stop') {
        this.stopped = true;
      }
    };
  }

  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0 || ch0.length === 0) return true;
    const chCount = input.length;
    const frames = ch0.length;

    while (this.phase < frames) {
      const idx = Math.floor(this.phase);
      const nextIdx = idx + 1 < frames ? idx + 1 : idx;
      const frac = this.phase - idx;
      let sample = 0;
      for (let c = 0; c < chCount; c++) {
        const ch = input[c];
        sample += ch[idx] + (ch[nextIdx] - ch[idx]) * frac;
      }
      this.buffer[this.writeIdx++] = sample / chCount;
      if (this.writeIdx >= this.buffer.length) {
        const out = this.buffer;
        this.port.postMessage(out, [out.buffer]);
        this.buffer = new Float32Array(${WORKLET_CHUNK_SAMPLES});
        this.writeIdx = 0;
      }
      this.phase += this.ratio;
    }
    this.phase -= frames;
    return true;
  }
}
registerProcessor('${WORKLET_PROCESSOR_NAME}', AgnostrPcm16kCapturer);
`
}

interface ParticipantCaptureBinding {
  pubkey: string
  nickname: string
  displayHandle: string
  isSelf: boolean
  trackId: string
  source: MediaStreamAudioSourceNode
  processorNode: AudioNode
  workletNode: AudioWorkletNode | null
  preRoll: Float32Array[]
  speechChunks: Float32Array[]
  inSpeech: boolean
  speechMs: number
  silenceMs: number
  bufferedMs: number
}

function pickLiveAudioTrack(participant: CallParticipant): MediaStreamTrack | null {
  const tracks = participant.stream?.getAudioTracks() ?? []
  return tracks.find((t) => t.readyState === 'live') ?? null
}

/**
 * Per-participant Web Audio 16 kHz VAD-gated speech capturer.
 * Attaches dynamically to every CallParticipant's audio track in an active call
 * so every live caption carries accurate speaker attribution (@handle).
 */
export class LiveStreamSpeechCapturer {
  private audioCtx: AudioContext | null = null
  private silentSink: GainNode | null = null
  private workletUrl: string | null = null
  private workletReady = false
  private initPromise: Promise<void> | null = null
  private disposed = false
  private latestParticipants: CallParticipant[] = []
  private bindings = new Map<string, ParticipantCaptureBinding>()
  private readonly onSegment: (segment: CapturedSpeechSegment) => void

  constructor(onSegment: (segment: CapturedSpeechSegment) => void) {
    this.onSegment = onSegment
  }

  async start(participants: readonly CallParticipant[]): Promise<void> {
    this.latestParticipants = participants.filter((p) => p.isSelf || !p.isUntrusted)
    if (this.disposed) return

    if (!this.initPromise) {
      this.initPromise = this.initializeAudioContext()
    }
    await this.initPromise
    if (!this.disposed) {
      this.syncParticipants(this.latestParticipants)
    }
  }

  syncParticipants(participants: readonly CallParticipant[]): void {
    const trustedOnly = participants.filter((p) => p.isSelf || !p.isUntrusted)
    this.latestParticipants = [...trustedOnly]
    if (this.disposed || !this.audioCtx || !this.silentSink) return

    if (this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume().catch(() => {})
    }

    const activePubkeys = new Set<string>()
    for (const p of trustedOnly) {
      const pk = p.pubkey.toLowerCase()
      activePubkeys.add(pk)

      const track = pickLiveAudioTrack(p)
      const existing = this.bindings.get(pk)

      if (existing) {
        existing.nickname = p.nickname
        existing.displayHandle = p.displayHandle
        existing.isSelf = p.isSelf
        if (p.audioMuted && existing.inSpeech) {
          this.flushBinding(existing)
        }
      }

      if (track) {
        if (!existing || existing.trackId !== track.id) {
          if (existing) {
            this.detachBinding(pk, true)
          }
          this.attachParticipant(p, track)
        }
      } else if (existing) {
        this.detachBinding(pk, true)
      }
    }

    for (const pk of Array.from(this.bindings.keys())) {
      if (!activePubkeys.has(pk)) {
        this.detachBinding(pk, true)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    for (const pk of Array.from(this.bindings.keys())) {
      this.detachBinding(pk, false)
    }
    this.bindings.clear()

    if (this.silentSink) {
      try {
        this.silentSink.disconnect()
      } catch {
        // Ignore
      }
      this.silentSink = null
    }

    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {})
      this.audioCtx = null
    }

    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl)
      this.workletUrl = null
    }
  }

  private async initializeAudioContext(): Promise<void> {
    const AudioCtxCtor = getAudioContextCtor()
    if (!AudioCtxCtor) {
      throw new Error('Web Audio API unavailable for live call captions.')
    }

    const ctx = new AudioCtxCtor()
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {})
    }

    const sink = ctx.createGain()
    sink.gain.value = 0
    sink.connect(ctx.destination)

    this.audioCtx = ctx
    this.silentSink = sink

    if (typeof AudioWorkletNode !== 'undefined' && ctx.audioWorklet && typeof URL !== 'undefined') {
      try {
        const blob = new Blob([buildWorkletModuleCode()], { type: 'application/javascript' })
        const url = URL.createObjectURL(blob)
        this.workletUrl = url
        await ctx.audioWorklet.addModule(url)
        this.workletReady = true
      } catch {
        this.workletReady = false
      }
    }
  }

  private attachParticipant(participant: CallParticipant, audioTrack: MediaStreamTrack): void {
    const ctx = this.audioCtx
    const sink = this.silentSink
    if (!ctx || !sink) return

    const pk = participant.pubkey.toLowerCase()
    try {
      const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]))
      let processorNode: AudioNode
      let workletNode: AudioWorkletNode | null = null

      const binding: ParticipantCaptureBinding = {
        pubkey: pk,
        nickname: participant.nickname,
        displayHandle: participant.displayHandle,
        isSelf: participant.isSelf,
        trackId: audioTrack.id,
        source,
        processorNode: sink,
        workletNode: null,
        preRoll: [],
        speechChunks: [],
        inSpeech: false,
        speechMs: 0,
        silenceMs: 0,
        bufferedMs: 0,
      }

      if (this.workletReady && typeof AudioWorkletNode !== 'undefined') {
        const node = new AudioWorkletNode(ctx, WORKLET_PROCESSOR_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        })
        node.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (this.disposed) return
          if (event.data instanceof Float32Array) {
            this.handlePcm16kChunk(binding, event.data)
          }
        }
        source.connect(node)
        node.connect(sink)
        processorNode = node
        workletNode = node
      } else {
        // Fallback when AudioWorklet is unavailable
        const scriptNode = ctx.createScriptProcessor(4096, 1, 1)
        const nativeRate = ctx.sampleRate
        scriptNode.onaudioprocess = (ev: AudioProcessingEvent) => {
          if (this.disposed) return
          const input = ev.inputBuffer.getChannelData(0)
          const resampled = resampleMonoLinear(input, nativeRate, ASR_SAMPLE_RATE)
          this.handlePcm16kChunk(binding, resampled)
        }
        source.connect(scriptNode)
        scriptNode.connect(sink)
        processorNode = scriptNode
      }

      binding.processorNode = processorNode
      binding.workletNode = workletNode
      this.bindings.set(pk, binding)
    } catch {
      // Ignore unsupported track source errors
    }
  }

  private handlePcm16kChunk(binding: ParticipantCaptureBinding, chunk: Float32Array): void {
    if (chunk.length === 0) return
    const chunkMs = (chunk.length / ASR_SAMPLE_RATE) * 1000
    const rms = computeRms(chunk)
    const isVoice = rms >= SPEECH_RMS_THRESHOLD

    if (isVoice) {
      if (!binding.inSpeech) {
        binding.inSpeech = true
        binding.speechChunks = [...binding.preRoll]
        binding.bufferedMs = binding.preRoll.reduce(
          (acc, c) => acc + (c.length / ASR_SAMPLE_RATE) * 1000,
          0
        )
        binding.speechMs = 0
        binding.silenceMs = 0
      }
      binding.speechChunks.push(chunk)
      binding.speechMs += chunkMs
      binding.bufferedMs += chunkMs
      binding.silenceMs = 0

      if (binding.bufferedMs >= MAX_UTTERANCE_MS) {
        this.flushBinding(binding, true)
      }
      return
    }

    if (binding.inSpeech) {
      binding.speechChunks.push(chunk)
      binding.bufferedMs += chunkMs
      binding.silenceMs += chunkMs

      if (binding.silenceMs >= SILENCE_FLUSH_MS || binding.bufferedMs >= MAX_UTTERANCE_MS) {
        this.flushBinding(binding, false)
      }
    } else {
      binding.preRoll.push(chunk)
      if (binding.preRoll.length > PRE_ROLL_CHUNKS) {
        binding.preRoll.shift()
      }
    }
  }

  private flushBinding(binding: ParticipantCaptureBinding, keepTrailingTail = false): void {
    const shouldEmit = binding.speechMs >= MIN_SPEECH_MS && binding.speechChunks.length > 0
    const chunksToEmit = shouldEmit ? binding.speechChunks : null
    const tailChunks =
      keepTrailingTail && binding.speechChunks.length > 1
        ? binding.speechChunks.slice(-1)
        : []

    binding.speechChunks = tailChunks
    binding.inSpeech = keepTrailingTail && tailChunks.length > 0
    binding.speechMs = 0
    binding.silenceMs = 0
    binding.bufferedMs = tailChunks.reduce(
      (acc, c) => acc + (c.length / ASR_SAMPLE_RATE) * 1000,
      0
    )

    if (!chunksToEmit) return
    const pcm16k = concatFloat32Chunks(chunksToEmit)
    if (pcm16k.length < Math.floor(ASR_SAMPLE_RATE * 0.35)) return

    this.onSegment({
      pubkey: binding.pubkey,
      nickname: binding.nickname,
      displayHandle: binding.displayHandle,
      isSelf: binding.isSelf,
      pcm16k,
      timestamp: Date.now(),
    })
  }

  private detachBinding(pk: string, flushRemaining: boolean): void {
    const binding = this.bindings.get(pk)
    if (!binding) return
    if (flushRemaining && binding.inSpeech) {
      this.flushBinding(binding, false)
    }
    try {
      if (binding.workletNode) {
        binding.workletNode.port.postMessage({ type: 'stop' })
        binding.workletNode.port.onmessage = null
      }
      binding.source.disconnect()
      binding.processorNode.disconnect()
    } catch {
      // Ignore disconnect errors
    }
    this.bindings.delete(pk)
  }
}
