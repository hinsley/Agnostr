import {
  MAX_CALL_PARTICIPANTS,
  type CallMediaType,
  type CallParticipant,
  type PeerIceConnectionState,
  type TurnServerConfig,
} from '../types/calls.ts'
import { optimizeOpusSdp } from './callSignaling.ts'
import { formatDisplayHandle } from './identity.ts'

export const DEFAULT_STUN_SERVERS: readonly string[] = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
]

const MAX_REMOTE_PEERS = MAX_CALL_PARTICIPANTS - 1
const VAD_POLL_INTERVAL_MS = 120
const STATS_POLL_INTERVAL_MS = 2_500
const VAD_SPEAKING_THRESHOLD = 0.055
const VAD_HANGOVER_MS = 380
const MAX_PENDING_ICE = 96
const ICE_BATCH_DELAY_MS = 70
const ICE_BATCH_MAX_SIZE = 6
const OFFER_RETRY_INTERVAL_MS = 3_200
const MAX_OFFER_RETRIES = 4
const PEER_SYNC_INITIAL_DELAY_MS = 2_500
const PEER_SYNC_INTERVAL_MS = 3_000
const MAX_PEER_SYNC_REQUESTS = 3
const POLITE_FALLBACK_OFFER_DELAY_MS = 5_500
const ICE_CHECKING_STALL_MS = 8_500
const ICE_DISCONNECTED_RESTART_MS = 4_500
const ICE_RESTART_COOLDOWN_MS = 6_000
const MAX_ICE_RESTARTS = 3
const RENEGOTIATE_AFTER_ANSWER_DELAY_MS = 320

export interface AdaptiveVideoProfile {
  width: number
  height: number
  frameRate: number
  maxBitrate: number
}

export function getAdaptiveVideoProfile(participantCount: number): AdaptiveVideoProfile {
  if (participantCount <= 2) {
    return { width: 1280, height: 720, frameRate: 24, maxBitrate: 900_000 }
  }
  if (participantCount <= 4) {
    return { width: 854, height: 480, frameRate: 20, maxBitrate: 450_000 }
  }
  return { width: 320, height: 240, frameRate: 15, maxBitrate: 220_000 }
}

export function buildIceServers(turnConfig?: TurnServerConfig | null): RTCIceServer[] {
  const servers: RTCIceServer[] = DEFAULT_STUN_SERVERS.map((url) => ({ urls: url }))
  if (turnConfig && turnConfig.url.trim()) {
    const entry: RTCIceServer = { urls: turnConfig.url.trim() }
    if (turnConfig.username?.trim()) entry.username = turnConfig.username.trim()
    if (turnConfig.credential?.trim()) entry.credential = turnConfig.credential.trim()
    servers.push(entry)
  }
  return servers
}

export function isScreenShareSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices !== 'undefined' &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function'
  )
}

export interface WebRtcMeshCallbacks {
  onSendOffer: (peerPubkey: string, sdp: string) => void
  onSendAnswer: (peerPubkey: string, sdp: string) => void
  onSendIce: (peerPubkey: string, candidate: RTCIceCandidateInit) => void
  onSendIceBatch?: (peerPubkey: string, candidates: RTCIceCandidateInit[]) => void
  onRequestPeerSync?: (peerPubkey: string) => void
  onBroadcastMediaState: (state: {
    audioMuted: boolean
    videoEnabled: boolean
    screenSharing: boolean
    recording: boolean
  }) => void
  onStateChange: () => void
  onPeerConnected?: (peerPubkey: string) => void
  onPeerFailed?: (peerPubkey: string) => void
  onNotice?: (level: 'info' | 'warning' | 'error', title: string, detail?: string) => void
}

interface PeerMetadataPatch {
  nickname?: string
  audioMuted?: boolean
  videoEnabled?: boolean
  screenSharing?: boolean
  isRecording?: boolean
}

interface VadChannel {
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  buffer: Uint8Array<ArrayBuffer>
  trackId: string
}

interface RemotePeerEntry {
  pubkey: string
  nickname: string
  pc: RTCPeerConnection
  remoteStream: MediaStream
  pendingIce: RTCIceCandidateInit[]
  outboundIceBatch: RTCIceCandidateInit[]
  sentLocalIce: RTCIceCandidateInit[]
  iceBatchTimer: number | null
  renegotiateTimer: number | null
  lastAppliedRemoteOfferSdp: string | null
  audioMuted: boolean
  videoEnabled: boolean
  screenSharing: boolean
  isRecording: boolean
  isSpeaking: boolean
  audioLevel: number
  lastSpokeAt: number
  iceState: PeerIceConnectionState
  rttMs: number | null
  joinedAt: number
  negotiatedAt: number | null
  lastOfferSentAt: number
  offerRetryCount: number
  lastSyncRequestAt: number
  syncRequestCount: number
  iceRestartCount: number
  lastIceRestartAt: number
  disconnectedAt: number | null
  failedToastNotified: boolean
  makingOffer: boolean
  negotiating: boolean
  renegotiateQueued: boolean
  videoSender: RTCRtpSender | null
  audioSender: RTCRtpSender | null
}

function normalizeIceState(state: RTCIceConnectionState): PeerIceConnectionState {
  switch (state) {
    case 'new':
    case 'checking':
    case 'connected':
    case 'completed':
    case 'disconnected':
    case 'failed':
    case 'closed':
      return state
    default:
      return 'new'
  }
}

function computeEffectivePeerState(pc: RTCPeerConnection): PeerIceConnectionState {
  const ice = normalizeIceState(pc.iceConnectionState)
  const conn = pc.connectionState
  if (ice === 'completed') return 'completed'
  if (ice === 'connected' || conn === 'connected') return 'connected'
  if (ice === 'failed' || conn === 'failed') return 'failed'
  if (ice === 'closed' || conn === 'closed') return 'closed'
  if (ice === 'disconnected' || conn === 'disconnected') return 'disconnected'
  if (ice === 'checking' || conn === 'connecting') return 'checking'
  return 'new'
}

function friendlyMediaError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      return 'Permission denied. Allow microphone/camera access in your browser settings.'
    }
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      return 'No microphone or camera device found.'
    }
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      return 'Audio/video device is currently in use by another application.'
    }
  }
  return err instanceof Error ? err.message : 'Unable to access media devices.'
}

export class WebRtcMesh {
  private selfPubkey: string
  private selfNickname: string
  private iceServers: RTCIceServer[]
  private callbacks: WebRtcMeshCallbacks
  private maxRemotePeers: number
  private allowedPeers: Set<string> | null

  private localStream: MediaStream | null = null
  private localAudioTrack: MediaStreamTrack | null = null
  private localCameraTrack: MediaStreamTrack | null = null
  private localScreenTrack: MediaStreamTrack | null = null

  private localMuted = false
  private localDeafened = false
  private localRecording = false
  private mutedBeforeDeafen = false
  private cameraBeforeScreen = false
  private localSpeaking = false
  private localAudioLevel = 0
  private localLastSpokeAt = 0
  private joinedAt = Date.now()

  private peers = new Map<string, RemotePeerEntry>()
  private prePeerIce = new Map<string, RTCIceCandidateInit[]>()
  private prePeerMetadata = new Map<string, PeerMetadataPatch>()
  private signalQueues = new Map<string, Promise<void>>()

  private audioCtx: AudioContext | null = null
  private vadChannels = new Map<string, VadChannel>()
  private vadTimer: number | null = null
  private statsTimer: number | null = null
  private disposed = false

  constructor(opts: {
    selfPubkey: string
    selfNickname: string
    turnConfig?: TurnServerConfig | null
    maxRemotePeers?: number
    allowedPeers?: ReadonlySet<string> | readonly string[]
    callbacks: WebRtcMeshCallbacks
  }) {
    this.selfPubkey = opts.selfPubkey.toLowerCase()
    this.selfNickname = opts.selfNickname
    this.iceServers = buildIceServers(opts.turnConfig)
    this.callbacks = opts.callbacks
    const requestedMax =
      typeof opts.maxRemotePeers === 'number' && Number.isFinite(opts.maxRemotePeers)
        ? Math.floor(opts.maxRemotePeers)
        : MAX_REMOTE_PEERS
    this.maxRemotePeers = Math.max(1, Math.min(MAX_REMOTE_PEERS, requestedMax))
    if (opts.allowedPeers) {
      const normalized = new Set<string>()
      for (const pk of opts.allowedPeers) {
        const clean = pk.trim().toLowerCase()
        if (clean && clean !== this.selfPubkey) {
          normalized.add(clean)
        }
      }
      this.allowedPeers = normalized
    } else {
      this.allowedPeers = null
    }
  }

  private isPeerAllowed(pubkeyLower: string): boolean {
    if (!pubkeyLower || pubkeyLower === this.selfPubkey) return false
    if (this.allowedPeers && !this.allowedPeers.has(pubkeyLower)) return false
    return true
  }

  getLocalMuted(): boolean {
    return this.localMuted
  }

  getLocalDeafened(): boolean {
    return this.localDeafened
  }

  getLocalCameraOn(): boolean {
    return Boolean(this.localCameraTrack && this.localCameraTrack.readyState === 'live')
  }

  getLocalScreenSharing(): boolean {
    return Boolean(this.localScreenTrack && this.localScreenTrack.readyState === 'live')
  }

  getLocalRecording(): boolean {
    return this.localRecording
  }

  getLocalAudioDeviceId(): string {
    try {
      return this.localAudioTrack?.getSettings?.().deviceId ?? ''
    } catch {
      return ''
    }
  }

  async replaceAudioTrack(nextTrack: MediaStreamTrack): Promise<boolean> {
    if (this.disposed) {
      nextTrack.stop()
      return false
    }

    nextTrack.enabled = !this.localMuted
    const prevTrack = this.localAudioTrack
    this.localAudioTrack = nextTrack
    this.rebuildLocalStream()

    const tasks: Promise<void>[] = []
    for (const entry of this.peers.values()) {
      tasks.push(
        (async () => {
          if (this.disposed) return
          try {
            if (entry.audioSender) {
              await entry.audioSender.replaceTrack(nextTrack)
              return
            }
            const existingAudioSender = entry.pc
              .getSenders()
              .find((s) => s.track?.kind === 'audio' || s.dtmf !== null)
            if (existingAudioSender) {
              await existingAudioSender.replaceTrack(nextTrack)
              entry.audioSender = existingAudioSender
              return
            }
            if (this.localStream) {
              entry.audioSender = entry.pc.addTrack(nextTrack, this.localStream)
              await this.enqueuePeerSignal(entry.pubkey, () =>
                this.initiateOfferInternal(entry, false)
              )
            }
          } catch {
            // Peer may have closed mid-transition
          }
        })()
      )
    }

    await Promise.all(tasks)

    if (prevTrack && prevTrack !== nextTrack) {
      try {
        prevTrack.stop()
      } catch {
        // Ignore stop error
      }
    }

    this.emitState()
    return true
  }

  getLocalMediaState(): {
    audioMuted: boolean
    videoEnabled: boolean
    screenSharing: boolean
    recording: boolean
  } {
    const activeVideo = this.getActiveLocalVideoTrack()
    return {
      audioMuted: this.localMuted,
      videoEnabled: Boolean(activeVideo && activeVideo.readyState === 'live' && activeVideo.enabled),
      screenSharing: this.getLocalScreenSharing(),
      recording: this.localRecording,
    }
  }

  setLocalRecording(recording: boolean): void {
    if (this.disposed) return
    if (this.localRecording === recording) return
    this.localRecording = recording
    this.broadcastLocalMediaState()
    this.emitState()
  }

  getParticipantCount(): number {
    return 1 + this.peers.size
  }

  hasPeer(pubkey: string): boolean {
    return this.peers.has(pubkey.toLowerCase())
  }

  canAddPeer(pubkey: string): boolean {
    const pk = pubkey.toLowerCase()
    if (!this.isPeerAllowed(pk)) return false
    if (this.peers.has(pk)) return true
    return this.peers.size < this.maxRemotePeers
  }

  hasAnyConnectedPeer(): boolean {
    for (const peer of this.peers.values()) {
      if (peer.iceState === 'connected' || peer.iceState === 'completed') {
        return true
      }
    }
    return false
  }

  updateSelfNickname(nickname: string): void {
    this.selfNickname = nickname
    this.emitState()
  }

  updateIceServers(turnConfig?: TurnServerConfig | null): void {
    this.iceServers = buildIceServers(turnConfig)
  }

  async initLocalMedia(
    media: CallMediaType,
    preferredAudioInputId?: string
  ): Promise<{ audioOk: boolean; videoOk: boolean }> {
    if (this.disposed) return { audioOk: false, videoOk: false }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('WebRTC media capture is unavailable in this browser context (requires HTTPS or localhost).')
    }

    const profile = getAdaptiveVideoProfile(this.getParticipantCount())
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(preferredAudioInputId && preferredAudioInputId !== 'default'
        ? { deviceId: { ideal: preferredAudioInputId } }
        : {}),
    }

    let stream: MediaStream
    let videoOk = false

    if (media === 'video') {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: {
            width: { ideal: profile.width },
            height: { ideal: profile.height },
            frameRate: { ideal: profile.frameRate },
            facingMode: 'user',
          },
        })
        videoOk = stream.getVideoTracks().length > 0
      } catch (videoErr) {
        // Fallback to audio-only if camera failed/missing while microphone is still usable
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: false,
          })
          this.callbacks.onNotice?.(
            'warning',
            'Camera unavailable — joined with voice only',
            friendlyMediaError(videoErr)
          )
        } catch (audioErr) {
          throw new Error(friendlyMediaError(audioErr))
        }
      }
    } else {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false,
        })
      } catch (audioErr) {
        throw new Error(friendlyMediaError(audioErr))
      }
    }

    if (this.disposed) {
      stream.getTracks().forEach((t) => t.stop())
      return { audioOk: false, videoOk: false }
    }

    this.localAudioTrack = stream.getAudioTracks()[0] ?? null
    this.localCameraTrack = stream.getVideoTracks()[0] ?? null
    this.rebuildLocalStream()
    this.startMonitors()
    this.emitState()
    return { audioOk: Boolean(this.localAudioTrack), videoOk }
  }

  /**
   * Ensures an RTCPeerConnection exists for `peerPubkey`.
   * Glare-free deterministic rule: lexicographically lower pubkey sends the initial offer;
   * higher pubkey waits and answers.
   */
  connectToPeer(peerPubkey: string, nicknameHint?: string, forceInitiate?: boolean): boolean {
    if (this.disposed) return false
    const pk = peerPubkey.toLowerCase()
    if (!this.isPeerAllowed(pk)) return false

    const existing = this.peers.get(pk)
    if (existing) {
      if (nicknameHint && nicknameHint.trim()) {
        existing.nickname = nicknameHint.trim()
        this.emitState()
      }
      if (forceInitiate === true && existing.pc.signalingState === 'stable' && !existing.pc.remoteDescription) {
        void this.enqueuePeerSignal(pk, () => this.initiateOfferInternal(existing, false))
      }
      return true
    }

    if (this.peers.size >= this.maxRemotePeers) {
      return false
    }

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 2,
    })

    const remoteStream = new MediaStream()
    const bufferedIce = this.prePeerIce.get(pk) ?? []
    this.prePeerIce.delete(pk)
    const bufferedMeta = this.prePeerMetadata.get(pk)
    this.prePeerMetadata.delete(pk)

    const entry: RemotePeerEntry = {
      pubkey: pk,
      nickname: bufferedMeta?.nickname?.trim() || nicknameHint?.trim() || `anon${pk.slice(-4)}`,
      pc,
      remoteStream,
      pendingIce: bufferedIce.slice(0, MAX_PENDING_ICE),
      outboundIceBatch: [],
      sentLocalIce: [],
      iceBatchTimer: null,
      renegotiateTimer: null,
      lastAppliedRemoteOfferSdp: null,
      audioMuted: bufferedMeta?.audioMuted ?? false,
      videoEnabled: bufferedMeta?.videoEnabled ?? false,
      screenSharing: bufferedMeta?.screenSharing ?? false,
      isRecording: bufferedMeta?.isRecording ?? false,
      isSpeaking: false,
      audioLevel: 0,
      lastSpokeAt: 0,
      iceState: 'new',
      rttMs: null,
      joinedAt: Date.now(),
      negotiatedAt: null,
      lastOfferSentAt: 0,
      offerRetryCount: 0,
      lastSyncRequestAt: 0,
      syncRequestCount: 0,
      iceRestartCount: 0,
      lastIceRestartAt: 0,
      disconnectedAt: null,
      failedToastNotified: false,
      makingOffer: false,
      negotiating: false,
      renegotiateQueued: false,
      videoSender: null,
      audioSender: null,
    }

    // Attach current local audio & active video track (screen or camera)
    const activeVideoTrack = this.getActiveLocalVideoTrack()
    if (this.localAudioTrack && this.localStream) {
      entry.audioSender = pc.addTrack(this.localAudioTrack, this.localStream)
    }
    if (activeVideoTrack && this.localStream) {
      entry.videoSender = pc.addTrack(activeVideoTrack, this.localStream)
    }

    pc.onicecandidate = (event) => {
      if (this.disposed) return
      if (!event.candidate) {
        this.flushOutboundIceBatch(entry)
        return
      }
      const candJson = event.candidate.toJSON()
      if (entry.sentLocalIce.length < MAX_PENDING_ICE) {
        entry.sentLocalIce.push(candJson)
      }
      entry.outboundIceBatch.push(candJson)
      if (entry.outboundIceBatch.length >= ICE_BATCH_MAX_SIZE) {
        this.flushOutboundIceBatch(entry)
      } else if (entry.iceBatchTimer === null) {
        entry.iceBatchTimer = window.setTimeout(() => {
          entry.iceBatchTimer = null
          this.flushOutboundIceBatch(entry)
        }, ICE_BATCH_DELAY_MS)
      }
    }

    pc.ontrack = (event) => {
      if (this.disposed) return
      const track = event.track
      // Mutate entry.remoteStream in place so <audio> srcObject stays stable on iOS Safari PWA
      // when a video track arrives right after an audio track.
      for (const existingTrack of entry.remoteStream.getTracks()) {
        if (
          existingTrack.id === track.id ||
          existingTrack.readyState !== 'live' ||
          (track.kind === 'video' && existingTrack.kind === 'video') ||
          (track.kind === 'audio' && existingTrack.kind === 'audio')
        ) {
          entry.remoteStream.removeTrack(existingTrack)
        }
      }
      entry.remoteStream.addTrack(track)

      if (track.kind === 'video') {
        entry.videoEnabled = true
        track.onended = () => {
          entry.remoteStream.removeTrack(track)
          entry.videoEnabled = entry.remoteStream
            .getVideoTracks()
            .some((t) => t.readyState === 'live' && t.enabled)
          this.emitState()
        }
        track.onmute = () => {
          this.emitState()
        }
        track.onunmute = () => {
          entry.videoEnabled = true
          this.emitState()
        }
      } else if (track.kind === 'audio') {
        track.onended = () => {
          entry.remoteStream.removeTrack(track)
          this.emitState()
        }
        track.onunmute = () => {
          this.attachVadStream(pk, entry.remoteStream)
          this.emitState()
        }
        this.attachVadStream(pk, entry.remoteStream)
      }
      this.emitState()
    }

    const onStateChange = () => {
      if (this.disposed) return
      this.handlePeerConnectionStateChange(entry)
    }
    pc.oniceconnectionstatechange = onStateChange
    pc.onconnectionstatechange = onStateChange

    this.peers.set(pk, entry)
    void this.applyAdaptiveVideoScaling()
    this.emitState()

    const shouldOffer = forceInitiate !== undefined ? forceInitiate : this.selfPubkey < pk
    if (shouldOffer) {
      void this.enqueuePeerSignal(pk, () => this.initiateOfferInternal(entry, false))
    }
    return true
  }

  /**
   * Re-emits the current local SDP offer + gathered local ICE candidates if we are still
   * waiting in `have-local-offer` (e.g., when callee re-sends `call-accept` after missing
   * our initial offer on a waking mobile socket).
   */
  resendOfferIfPending(peerPubkey: string): void {
    if (this.disposed) return
    const pk = peerPubkey.toLowerCase()
    const entry = this.peers.get(pk)
    if (!entry) return
    if (entry.pc.signalingState !== 'have-local-offer' || !entry.pc.localDescription?.sdp) return
    const now = Date.now()
    if (now - entry.lastOfferSentAt < 1_000) return
    entry.lastOfferSentAt = now
    this.callbacks.onSendOffer(pk, entry.pc.localDescription.sdp)
    this.reemitSentLocalIce(entry)
  }

  removePeer(peerPubkey: string): void {
    const pk = peerPubkey.toLowerCase()
    this.prePeerIce.delete(pk)
    this.prePeerMetadata.delete(pk)
    this.signalQueues.delete(pk)
    const entry = this.peers.get(pk)
    if (!entry) return
    this.peers.delete(pk)
    if (entry.iceBatchTimer !== null) {
      window.clearTimeout(entry.iceBatchTimer)
      entry.iceBatchTimer = null
    }
    if (entry.renegotiateTimer !== null) {
      window.clearTimeout(entry.renegotiateTimer)
      entry.renegotiateTimer = null
    }
    this.detachVadChannel(pk)
    try {
      entry.pc.onicecandidate = null
      entry.pc.ontrack = null
      entry.pc.oniceconnectionstatechange = null
      entry.pc.onconnectionstatechange = null
      entry.pc.close()
    } catch {
      // Ignore close errors
    }
    void this.applyAdaptiveVideoScaling()
    this.emitState()
  }

  updatePeerMetadata(
    peerPubkey: string,
    patch: PeerMetadataPatch
  ): void {
    const pk = peerPubkey.toLowerCase()
    if (!this.isPeerAllowed(pk)) return
    const entry = this.peers.get(pk)
    if (!entry) {
      const prev = this.prePeerMetadata.get(pk) ?? {}
      this.prePeerMetadata.set(pk, {
        nickname: patch.nickname?.trim() || prev.nickname,
        audioMuted: typeof patch.audioMuted === 'boolean' ? patch.audioMuted : prev.audioMuted,
        videoEnabled: typeof patch.videoEnabled === 'boolean' ? patch.videoEnabled : prev.videoEnabled,
        screenSharing: typeof patch.screenSharing === 'boolean' ? patch.screenSharing : prev.screenSharing,
        isRecording: typeof patch.isRecording === 'boolean' ? patch.isRecording : prev.isRecording,
      })
      return
    }
    let changed = false
    if (patch.nickname && patch.nickname.trim() && entry.nickname !== patch.nickname.trim()) {
      entry.nickname = patch.nickname.trim()
      changed = true
    }
    if (typeof patch.audioMuted === 'boolean' && entry.audioMuted !== patch.audioMuted) {
      entry.audioMuted = patch.audioMuted
      changed = true
    }
    if (typeof patch.videoEnabled === 'boolean' && entry.videoEnabled !== patch.videoEnabled) {
      entry.videoEnabled = patch.videoEnabled
      changed = true
    }
    if (typeof patch.screenSharing === 'boolean' && entry.screenSharing !== patch.screenSharing) {
      entry.screenSharing = patch.screenSharing
      changed = true
    }
    if (typeof patch.isRecording === 'boolean' && entry.isRecording !== patch.isRecording) {
      entry.isRecording = patch.isRecording
      changed = true
    }
    if (changed) this.emitState()
  }

  handleRemoteOffer(peerPubkey: string, sdp: string, nicknameHint?: string): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    const pk = peerPubkey.toLowerCase()
    if (!this.isPeerAllowed(pk)) return Promise.resolve(false)
    if (!this.peers.has(pk)) {
      if (!this.canAddPeer(pk)) {
        // Hard cap reached (e.g. 1 remote peer for 1-on-1 DM calls or 6 participants for groups) — reject cleanly
        return Promise.resolve(false)
      }
      this.connectToPeer(pk, nicknameHint, false)
    }

    return this.enqueuePeerSignal(pk, async () => {
      if (this.disposed) return false
      const entry = this.peers.get(pk)
      if (!entry) return false
      if (nicknameHint && nicknameHint.trim()) {
        entry.nickname = nicknameHint.trim()
      }

      const pc = entry.pc
      const isPolite = this.selfPubkey > pk

      // Deduplicate re-emitted copies of an offer we already applied & answered
      if (entry.lastAppliedRemoteOfferSdp === sdp) {
        if (
          pc.signalingState === 'stable' &&
          pc.localDescription?.type === 'answer' &&
          pc.localDescription.sdp
        ) {
          this.callbacks.onSendAnswer(pk, pc.localDescription.sdp)
        }
        return true
      }

      const offerCollision = entry.makingOffer || pc.signalingState !== 'stable'

      if (offerCollision && !isPolite) {
        // Deterministic glare resolution: impolite (lower pubkey) wins collision.
        // Only re-emit our active offer if >= 1.2s old so we don't bounce stale offers
        // right as the polite peer's answer is already in flight.
        const now = Date.now()
        if (
          pc.signalingState === 'have-local-offer' &&
          pc.localDescription?.sdp &&
          now - entry.lastOfferSentAt >= 1_200
        ) {
          entry.lastOfferSentAt = now
          this.callbacks.onSendOffer(pk, pc.localDescription.sdp)
          const isConnected = entry.iceState === 'connected' || entry.iceState === 'completed'
          if (!isConnected) {
            this.reemitSentLocalIce(entry)
          }
        }
        return true
      }

      try {
        if (offerCollision && isPolite) {
          await pc.setLocalDescription({ type: 'rollback' })
        }
        await pc.setRemoteDescription({ type: 'offer', sdp })
        entry.lastAppliedRemoteOfferSdp = sdp
        entry.negotiatedAt = Date.now()
        await this.flushPendingIce(entry)

        const answer = await pc.createAnswer()
        await this.applyLocalDescription(pc, answer)
        if (pc.localDescription?.sdp) {
          this.callbacks.onSendAnswer(pk, pc.localDescription.sdp)
        }

        // Check if we have a live local video track whose transceiver was not included in the
        // remote audio-only offer (mid === null) — defer renegotiation briefly so our answer
        // settles the remote peer into 'stable' before our follow-up offer arrives across relays.
        const hasUnnegotiatedLocalVideo = Boolean(
          this.getActiveLocalVideoTrack() &&
            entry.videoSender &&
            pc.getTransceivers().some((t) => t.sender === entry.videoSender && t.mid === null)
        )
        if ((entry.renegotiateQueued || hasUnnegotiatedLocalVideo) && pc.signalingState === 'stable') {
          entry.renegotiateQueued = false
          this.scheduleDeferredRenegotiation(entry)
        }
        this.emitState()
        return true
      } catch (err) {
        console.warn('[WebRtcMesh] handleRemoteOffer failed:', err)
        return false
      }
    })
  }

  handleRemoteAnswer(peerPubkey: string, sdp: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const pk = peerPubkey.toLowerCase()
    if (!this.isPeerAllowed(pk)) return Promise.resolve()
    return this.enqueuePeerSignal(pk, async () => {
      if (this.disposed) return
      const entry = this.peers.get(pk)
      if (!entry) return
      if (entry.pc.signalingState !== 'have-local-offer') return
      try {
        await entry.pc.setRemoteDescription({ type: 'answer', sdp })
        entry.negotiatedAt = Date.now()
        entry.offerRetryCount = 0
        await this.flushPendingIce(entry)
        void this.applyAdaptiveVideoScaling()
        if (entry.renegotiateQueued) {
          entry.renegotiateQueued = false
          await this.initiateOfferInternal(entry, false)
        }
      } catch (err) {
        console.warn('[WebRtcMesh] handleRemoteAnswer failed:', err)
      }
    })
  }

  handleRemoteIce(peerPubkey: string, candidate: RTCIceCandidateInit): Promise<void> {
    return this.handleRemoteIceBatch(peerPubkey, [candidate])
  }

  handleRemoteIceBatch(peerPubkey: string, candidates: readonly RTCIceCandidateInit[]): Promise<void> {
    if (this.disposed || candidates.length === 0) return Promise.resolve()
    const pk = peerPubkey.toLowerCase()
    if (!this.isPeerAllowed(pk)) return Promise.resolve()
    if (!this.peers.has(pk)) {
      // Buffer early ICE candidates that arrive before connectToPeer / offer!
      const list = this.prePeerIce.get(pk) ?? []
      for (const cand of candidates) {
        if (list.length >= MAX_PENDING_ICE) break
        list.push(cand)
      }
      this.prePeerIce.set(pk, list)
      return Promise.resolve()
    }

    return this.enqueuePeerSignal(pk, async () => {
      if (this.disposed) return
      const entry = this.peers.get(pk)
      if (!entry) return
      if (!entry.pc.remoteDescription) {
        for (const cand of candidates) {
          if (entry.pendingIce.length >= MAX_PENDING_ICE) break
          entry.pendingIce.push(cand)
        }
        return
      }
      for (const cand of candidates) {
        try {
          await entry.pc.addIceCandidate(cand)
        } catch {
          // Ignore stale/invalid ICE candidate
        }
      }
    })
  }

  toggleMute(): void {
    if (this.disposed) return
    this.localMuted = !this.localMuted
    if (!this.localMuted && this.localDeafened) {
      this.localDeafened = false
    }
    if (this.localAudioTrack) {
      this.localAudioTrack.enabled = !this.localMuted
    }
    if (this.localMuted) {
      this.localSpeaking = false
      this.localAudioLevel = 0
    }
    this.broadcastLocalMediaState()
    this.emitState()
  }

  toggleDeafen(): void {
    if (this.disposed) return
    if (!this.localDeafened) {
      this.mutedBeforeDeafen = this.localMuted
      this.localDeafened = true
      this.localMuted = true
    } else {
      this.localDeafened = false
      this.localMuted = this.mutedBeforeDeafen
    }
    if (this.localAudioTrack) {
      this.localAudioTrack.enabled = !this.localMuted
    }
    if (this.localMuted) {
      this.localSpeaking = false
      this.localAudioLevel = 0
    }
    this.broadcastLocalMediaState()
    this.emitState()
  }

  async toggleCamera(): Promise<boolean> {
    if (this.disposed) return false

    // Turn camera OFF
    if (this.localCameraTrack && this.localCameraTrack.readyState === 'live') {
      this.localCameraTrack.stop()
      this.localCameraTrack = null
      this.cameraBeforeScreen = false
      this.rebuildLocalStream()
      await this.syncOutgoingVideoTrack(this.getActiveLocalVideoTrack())
      this.broadcastLocalMediaState()
      this.emitState()
      return false
    }

    // Turn camera ON (stop screen share first if active so user gets predictable camera feed)
    if (this.localScreenTrack) {
      this.localScreenTrack.onended = null
      this.localScreenTrack.stop()
      this.localScreenTrack = null
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.callbacks.onNotice?.('error', 'Camera unavailable', 'Browser does not support camera capture.')
      return false
    }

    try {
      const profile = getAdaptiveVideoProfile(this.getParticipantCount())
      const camStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: profile.width },
          height: { ideal: profile.height },
          frameRate: { ideal: profile.frameRate },
          facingMode: 'user',
        },
        audio: false,
      })
      const track = camStream.getVideoTracks()[0]
      if (!track) return false
      if (this.disposed) {
        track.stop()
        return false
      }
      this.localCameraTrack = track
      this.rebuildLocalStream()
      await this.syncOutgoingVideoTrack(track)
      await this.applyAdaptiveVideoScaling()
      this.broadcastLocalMediaState()
      this.emitState()
      return true
    } catch (err) {
      this.callbacks.onNotice?.('error', 'Camera permission denied', friendlyMediaError(err))
      return false
    }
  }

  async toggleScreenShare(): Promise<boolean> {
    if (this.disposed) return false

    if (this.localScreenTrack && this.localScreenTrack.readyState === 'live') {
      await this.stopScreenShareInternal()
      return false
    }

    if (!isScreenShareSupported()) {
      this.callbacks.onNotice?.('warning', 'Screen share unavailable', 'This browser does not support screen capture.')
      return false
    }

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 20, max: 30 } },
        audio: false,
      })
      const screenTrack = displayStream.getVideoTracks()[0]
      if (!screenTrack) return false
      if (this.disposed) {
        screenTrack.stop()
        return false
      }
      this.cameraBeforeScreen = this.getLocalCameraOn()
      this.localScreenTrack = screenTrack
      screenTrack.onended = () => {
        void this.stopScreenShareInternal()
      }
      this.rebuildLocalStream()
      await this.syncOutgoingVideoTrack(screenTrack)
      await this.applyAdaptiveVideoScaling()
      this.broadcastLocalMediaState()
      this.emitState()
      return true
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        // User cancelled screen picker — no harsh error needed
        return false
      }
      this.callbacks.onNotice?.('error', 'Screen share failed', friendlyMediaError(err))
      return false
    }
  }

  getParticipantsSnapshot(): CallParticipant[] {
    const activeVideo = this.getActiveLocalVideoTrack()
    const selfParticipant: CallParticipant = {
      pubkey: this.selfPubkey,
      nickname: this.selfNickname,
      displayHandle: formatDisplayHandle(this.selfNickname, this.selfPubkey),
      isSelf: true,
      stream: this.localStream,
      audioMuted: this.localMuted,
      videoEnabled: Boolean(activeVideo && activeVideo.readyState === 'live' && activeVideo.enabled),
      screenSharing: this.getLocalScreenSharing(),
      isRecording: this.localRecording,
      isSpeaking: this.localSpeaking && !this.localMuted,
      audioLevel: this.localMuted ? 0 : this.localAudioLevel,
      iceState: 'connected',
      rttMs: 0,
      joinedAt: this.joinedAt,
    }

    const remotes: CallParticipant[] = []
    for (const entry of this.peers.values()) {
      const hasLiveRemoteVideo = entry.remoteStream
        .getVideoTracks()
        .some((t) => t.readyState === 'live')
      remotes.push({
        pubkey: entry.pubkey,
        nickname: entry.nickname,
        displayHandle: formatDisplayHandle(entry.nickname, entry.pubkey),
        isSelf: false,
        stream: entry.remoteStream,
        audioMuted: entry.audioMuted,
        videoEnabled: entry.videoEnabled && hasLiveRemoteVideo,
        screenSharing: entry.screenSharing && hasLiveRemoteVideo,
        isRecording: entry.isRecording,
        isSpeaking: entry.isSpeaking && !entry.audioMuted,
        audioLevel: entry.audioMuted ? 0 : entry.audioLevel,
        iceState: entry.iceState,
        rttMs: entry.rttMs,
        joinedAt: entry.joinedAt,
      })
    }

    remotes.sort((a, b) => a.joinedAt - b.joinedAt)
    return [selfParticipant, ...remotes]
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    if (this.vadTimer !== null) {
      window.clearInterval(this.vadTimer)
      this.vadTimer = null
    }
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer)
      this.statsTimer = null
    }

    for (const key of Array.from(this.vadChannels.keys())) {
      this.detachVadChannel(key)
    }

    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {})
      this.audioCtx = null
    }

    for (const entry of this.peers.values()) {
      if (entry.iceBatchTimer !== null) {
        window.clearTimeout(entry.iceBatchTimer)
        entry.iceBatchTimer = null
      }
      if (entry.renegotiateTimer !== null) {
        window.clearTimeout(entry.renegotiateTimer)
        entry.renegotiateTimer = null
      }
      try {
        entry.pc.onicecandidate = null
        entry.pc.ontrack = null
        entry.pc.oniceconnectionstatechange = null
        entry.pc.onconnectionstatechange = null
        entry.pc.close()
      } catch {
        // Ignore close errors
      }
    }
    this.peers.clear()
    this.prePeerIce.clear()
    this.prePeerMetadata.clear()
    this.signalQueues.clear()

    if (this.localScreenTrack) {
      this.localScreenTrack.onended = null
      this.localScreenTrack.stop()
      this.localScreenTrack = null
    }
    if (this.localCameraTrack) {
      this.localCameraTrack.stop()
      this.localCameraTrack = null
    }
    if (this.localAudioTrack) {
      this.localAudioTrack.stop()
      this.localAudioTrack = null
    }
    this.localStream = null
  }

  private getActiveLocalVideoTrack(): MediaStreamTrack | null {
    if (this.localScreenTrack && this.localScreenTrack.readyState === 'live') {
      return this.localScreenTrack
    }
    if (this.localCameraTrack && this.localCameraTrack.readyState === 'live') {
      return this.localCameraTrack
    }
    return null
  }

  private rebuildLocalStream(): void {
    const tracks: MediaStreamTrack[] = []
    if (this.localAudioTrack && this.localAudioTrack.readyState === 'live') {
      this.localAudioTrack.enabled = !this.localMuted
      tracks.push(this.localAudioTrack)
    }
    const activeVideo = this.getActiveLocalVideoTrack()
    if (activeVideo) {
      tracks.push(activeVideo)
    }
    this.localStream = new MediaStream(tracks)
    if (this.localAudioTrack) {
      this.attachVadStream('__self__', this.localStream)
    }
  }

  private async stopScreenShareInternal(): Promise<void> {
    if (this.localScreenTrack) {
      this.localScreenTrack.onended = null
      this.localScreenTrack.stop()
      this.localScreenTrack = null
    }
    if (!this.cameraBeforeScreen && this.localCameraTrack) {
      this.localCameraTrack.stop()
      this.localCameraTrack = null
    }
    this.cameraBeforeScreen = false
    this.rebuildLocalStream()
    await this.syncOutgoingVideoTrack(this.getActiveLocalVideoTrack())
    await this.applyAdaptiveVideoScaling()
    this.broadcastLocalMediaState()
    this.emitState()
  }

  private async syncOutgoingVideoTrack(nextTrack: MediaStreamTrack | null): Promise<void> {
    const tasks: Promise<void>[] = []
    for (const entry of this.peers.values()) {
      tasks.push(this.syncPeerVideoTrack(entry, nextTrack))
    }
    await Promise.all(tasks)
  }

  private async syncPeerVideoTrack(
    entry: RemotePeerEntry,
    nextTrack: MediaStreamTrack | null
  ): Promise<void> {
    if (this.disposed) return
    try {
      if (entry.videoSender) {
        await entry.videoSender.replaceTrack(nextTrack)
        if (nextTrack) {
          const transceiver = entry.pc
            .getTransceivers()
            .find((t) => t.sender === entry.videoSender)
          if (
            transceiver &&
            transceiver.direction !== 'sendrecv' &&
            transceiver.direction !== 'sendonly'
          ) {
            transceiver.direction = 'sendrecv'
            await this.enqueuePeerSignal(entry.pubkey, () => this.initiateOfferInternal(entry, false))
          }
        }
        return
      }
      if (nextTrack && this.localStream) {
        // Reuse an existing recvonly/inactive video transceiver when upgrading voice -> video
        // (e.g., when remote joined with video while we joined audio-only)
        const reusableTransceiver = entry.pc
          .getTransceivers()
          .find(
            (t) =>
              t.receiver.track?.kind === 'video' &&
              !t.sender.track &&
              t.direction !== 'stopped'
          )
        if (reusableTransceiver) {
          await reusableTransceiver.sender.replaceTrack(nextTrack)
          reusableTransceiver.direction = 'sendrecv'
          entry.videoSender = reusableTransceiver.sender
          await this.enqueuePeerSignal(entry.pubkey, () => this.initiateOfferInternal(entry, false))
          return
        }
        entry.videoSender = entry.pc.addTrack(nextTrack, this.localStream)
        await this.enqueuePeerSignal(entry.pubkey, () => this.initiateOfferInternal(entry, false))
      }
    } catch {
      // Peer might have closed mid-transition
    }
  }

  private enqueuePeerSignal<T>(pk: string, task: () => Promise<T>): Promise<T> {
    const prev = this.signalQueues.get(pk) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(() => task())
    const tracked = next.then(
      () => undefined,
      () => undefined
    )
    this.signalQueues.set(pk, tracked)
    return next
  }

  private async applyLocalDescription(
    pc: RTCPeerConnection,
    desc: RTCSessionDescriptionInit
  ): Promise<void> {
    const optimizedSdp = desc.sdp ? optimizeOpusSdp(desc.sdp) : desc.sdp
    try {
      await pc.setLocalDescription({ type: desc.type, sdp: optimizedSdp })
    } catch (err) {
      if (optimizedSdp !== desc.sdp) {
        console.warn('[WebRtcMesh] Optimized SDP rejected; retrying unmodified SDP:', err)
        await pc.setLocalDescription({ type: desc.type, sdp: desc.sdp })
      } else {
        throw err
      }
    }
  }

  private emitIceBatch(pk: string, batch: RTCIceCandidateInit[]): void {
    if (this.disposed || batch.length === 0) return
    if (this.callbacks.onSendIceBatch) {
      this.callbacks.onSendIceBatch(pk, batch)
      return
    }
    for (const cand of batch) {
      this.callbacks.onSendIce(pk, cand)
    }
  }

  private flushOutboundIceBatch(entry: RemotePeerEntry): void {
    if (entry.iceBatchTimer !== null) {
      window.clearTimeout(entry.iceBatchTimer)
      entry.iceBatchTimer = null
    }
    if (entry.outboundIceBatch.length === 0) return
    const batch = entry.outboundIceBatch.splice(0, entry.outboundIceBatch.length)
    this.emitIceBatch(entry.pubkey, batch)
  }

  private reemitSentLocalIce(entry: RemotePeerEntry): void {
    if (this.disposed || entry.sentLocalIce.length === 0) return
    for (let i = 0; i < entry.sentLocalIce.length; i += ICE_BATCH_MAX_SIZE) {
      this.emitIceBatch(entry.pubkey, entry.sentLocalIce.slice(i, i + ICE_BATCH_MAX_SIZE))
    }
  }

  private handlePeerConnectionStateChange(entry: RemotePeerEntry): void {
    const nextState = computeEffectivePeerState(entry.pc)
    if (entry.iceState === nextState) return
    entry.iceState = nextState

    if (nextState === 'connected' || nextState === 'completed') {
      entry.disconnectedAt = null
      entry.failedToastNotified = false
      entry.offerRetryCount = 0
      void this.applyAdaptiveVideoScaling()
      this.callbacks.onPeerConnected?.(entry.pubkey)
    } else if (nextState === 'disconnected') {
      if (entry.disconnectedAt === null) {
        entry.disconnectedAt = Date.now()
      }
    } else if (nextState === 'failed') {
      entry.disconnectedAt = entry.disconnectedAt ?? Date.now()
      const now = Date.now()
      const canRestart =
        entry.iceRestartCount < MAX_ICE_RESTARTS &&
        now - entry.lastIceRestartAt >= ICE_RESTART_COOLDOWN_MS
      if (canRestart) {
        const isPolite = this.selfPubkey > entry.pubkey
        const delay = isPolite ? 1_200 : 150
        window.setTimeout(() => {
          if (this.disposed || this.peers.get(entry.pubkey) !== entry) return
          const curState = computeEffectivePeerState(entry.pc)
          if (curState === 'failed' || curState === 'disconnected') {
            void this.enqueuePeerSignal(entry.pubkey, () => this.initiateOfferInternal(entry, true))
          }
        }, delay)
      } else if (!entry.failedToastNotified) {
        entry.failedToastNotified = true
        this.callbacks.onPeerFailed?.(entry.pubkey)
      }
    }
    this.emitState()
  }

  private scheduleDeferredRenegotiation(
    entry: RemotePeerEntry,
    delayMs = RENEGOTIATE_AFTER_ANSWER_DELAY_MS
  ): void {
    if (entry.renegotiateTimer !== null) {
      window.clearTimeout(entry.renegotiateTimer)
      entry.renegotiateTimer = null
    }
    entry.renegotiateTimer = window.setTimeout(() => {
      entry.renegotiateTimer = null
      if (this.disposed || this.peers.get(entry.pubkey) !== entry) return
      void this.enqueuePeerSignal(entry.pubkey, async () => {
        if (this.disposed || this.peers.get(entry.pubkey) !== entry) return
        if (entry.pc.signalingState === 'stable') {
          await this.initiateOfferInternal(entry, false)
        } else {
          entry.renegotiateQueued = true
        }
      })
    }, delayMs)
  }

  private async initiateOfferInternal(entry: RemotePeerEntry, iceRestart: boolean): Promise<void> {
    if (this.disposed) return
    if (this.peers.get(entry.pubkey) !== entry) return
    if (entry.renegotiateTimer !== null) {
      window.clearTimeout(entry.renegotiateTimer)
      entry.renegotiateTimer = null
    }
    const pc = entry.pc
    if (!iceRestart && pc.signalingState !== 'stable') {
      entry.renegotiateQueued = true
      return
    }
    if (entry.makingOffer) {
      entry.renegotiateQueued = true
      return
    }
    entry.makingOffer = true
    try {
      if (iceRestart) {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setLocalDescription({ type: 'rollback' })
        } else if (pc.signalingState !== 'stable') {
          entry.renegotiateQueued = true
          return
        }
        entry.iceRestartCount += 1
        entry.lastIceRestartAt = Date.now()
        entry.sentLocalIce = []
      }
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined)
      await this.applyLocalDescription(pc, offer)
      if (pc.localDescription?.sdp) {
        entry.lastOfferSentAt = Date.now()
        entry.offerRetryCount = 0
        this.callbacks.onSendOffer(entry.pubkey, pc.localDescription.sdp)
      }
    } catch (err) {
      console.warn('[WebRtcMesh] initiateOffer failed:', err)
    } finally {
      entry.makingOffer = false
    }
  }

  private async flushPendingIce(entry: RemotePeerEntry): Promise<void> {
    if (entry.pendingIce.length === 0) return
    const queued = entry.pendingIce.splice(0, entry.pendingIce.length)
    for (const cand of queued) {
      try {
        await entry.pc.addIceCandidate(cand)
      } catch {
        // Ignore stale candidate
      }
    }
  }

  private async applyAdaptiveVideoScaling(): Promise<void> {
    if (this.disposed) return
    const profile = getAdaptiveVideoProfile(this.getParticipantCount())

    // Scale local camera capture constraints (leave screen share crisp)
    if (this.localCameraTrack && this.localCameraTrack.readyState === 'live' && !this.getLocalScreenSharing()) {
      try {
        await this.localCameraTrack.applyConstraints({
          width: { ideal: profile.width },
          height: { ideal: profile.height },
          frameRate: { ideal: profile.frameRate },
        })
      } catch {
        // Browser may not support dynamic constraint updates on all devices
      }
    }

    // Apply per-sender video maxBitrate cap
    for (const entry of this.peers.values()) {
      const sender =
        entry.videoSender ??
        entry.pc.getSenders().find((s) => s.track?.kind === 'video') ??
        null
      if (!sender) continue
      try {
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}]
        }
        const targetBitrate = this.getLocalScreenSharing()
          ? Math.max(profile.maxBitrate, 800_000)
          : profile.maxBitrate
        if (params.encodings[0].maxBitrate !== targetBitrate) {
          params.encodings[0].maxBitrate = targetBitrate
          await sender.setParameters(params)
        }
      } catch {
        // Ignore browsers that reject mid-flight setParameters
      }
    }
  }

  private ensureAudioContext(): AudioContext | null {
    if (this.disposed || typeof window === 'undefined') return null
    if (!this.audioCtx) {
      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioContextCtor) return null
      try {
        this.audioCtx = new AudioContextCtor()
      } catch {
        return null
      }
    }
    if (this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume().catch(() => {})
    }
    return this.audioCtx
  }

  private attachVadStream(key: string, stream: MediaStream): void {
    const audioTrack = stream.getAudioTracks()[0]
    if (!audioTrack) return
    const existing = this.vadChannels.get(key)
    if (existing && existing.trackId === audioTrack.id) return
    if (existing) this.detachVadChannel(key)

    const ctx = this.ensureAudioContext()
    if (!ctx) return
    try {
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.65
      source.connect(analyser)
      this.vadChannels.set(key, {
        source,
        analyser,
        buffer: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
        trackId: audioTrack.id,
      })
    } catch {
      // Ignore MediaStreamAudioSourceNode errors on unsupported tracks
    }
  }

  private detachVadChannel(key: string): void {
    const ch = this.vadChannels.get(key)
    if (!ch) return
    this.vadChannels.delete(key)
    try {
      ch.source.disconnect()
      ch.analyser.disconnect()
    } catch {
      // Ignore
    }
  }

  private sampleVadLevel(channel: VadChannel): number {
    channel.analyser.getByteTimeDomainData(channel.buffer)
    let sumSq = 0
    for (let i = 0; i < channel.buffer.length; i++) {
      const centered = (channel.buffer[i] - 128) / 128
      sumSq += centered * centered
    }
    const rms = Math.sqrt(sumSq / channel.buffer.length)
    return Math.min(1, rms * 3.2)
  }

  private startMonitors(): void {
    if (this.vadTimer === null) {
      this.vadTimer = window.setInterval(() => {
        if (this.disposed) return
        const now = Date.now()
        let changed = false

        // Self VAD
        const selfChan = this.vadChannels.get('__self__')
        if (selfChan && !this.localMuted) {
          const level = this.sampleVadLevel(selfChan)
          if (level >= VAD_SPEAKING_THRESHOLD) {
            this.localLastSpokeAt = now
          }
          const speaking = now - this.localLastSpokeAt <= VAD_HANGOVER_MS
          if (speaking !== this.localSpeaking || Math.abs(level - this.localAudioLevel) > 0.08) {
            this.localSpeaking = speaking
            this.localAudioLevel = level
            changed = true
          }
        } else if (this.localSpeaking || this.localAudioLevel > 0) {
          this.localSpeaking = false
          this.localAudioLevel = 0
          changed = true
        }

        // Remote peers VAD
        for (const [pk, entry] of this.peers.entries()) {
          const chan = this.vadChannels.get(pk)
          if (chan && !entry.audioMuted) {
            const level = this.sampleVadLevel(chan)
            if (level >= VAD_SPEAKING_THRESHOLD) {
              entry.lastSpokeAt = now
            }
            const speaking = now - entry.lastSpokeAt <= VAD_HANGOVER_MS
            if (speaking !== entry.isSpeaking || Math.abs(level - entry.audioLevel) > 0.08) {
              entry.isSpeaking = speaking
              entry.audioLevel = level
              changed = true
            }
          } else if (entry.isSpeaking || entry.audioLevel > 0) {
            entry.isSpeaking = false
            entry.audioLevel = 0
            changed = true
          }
        }

        if (changed) this.emitState()
      }, VAD_POLL_INTERVAL_MS)
    }

    if (this.statsTimer === null) {
      this.statsTimer = window.setInterval(() => {
        void this.pollPeerStats()
      }, STATS_POLL_INTERVAL_MS)
    }
  }

  private async pollPeerStats(): Promise<void> {
    if (this.disposed || this.peers.size === 0) return
    const now = Date.now()
    let changed = false
    for (const entry of this.peers.values()) {
      const prevState = entry.iceState
      this.handlePeerConnectionStateChange(entry)
      if (entry.iceState !== prevState) {
        changed = true
      }

      const pc = entry.pc
      const isConnected = entry.iceState === 'connected' || entry.iceState === 'completed'

      // Watchdog 1: Offerer waiting on answer (initial OR mid-call renegotiation while connected)
      // Re-emit offer if lost to glare/relay drop; also re-emit gathered ICE when not yet connected.
      if (
        pc.signalingState === 'have-local-offer' &&
        pc.localDescription?.sdp &&
        entry.offerRetryCount < MAX_OFFER_RETRIES &&
        now - entry.lastOfferSentAt >= OFFER_RETRY_INTERVAL_MS
      ) {
        entry.lastOfferSentAt = now
        entry.offerRetryCount += 1
        this.callbacks.onSendOffer(entry.pubkey, pc.localDescription.sdp)
        if (!isConnected) {
          this.reemitSentLocalIce(entry)
        }
      }

      // Watchdog 2: Waiting peer never received remote SDP — nudge sync, then send polite fallback offer
      if (!isConnected && pc.signalingState === 'stable' && !pc.remoteDescription && !entry.makingOffer) {
        if (
          now - entry.joinedAt >= PEER_SYNC_INITIAL_DELAY_MS &&
          now - entry.lastSyncRequestAt >= PEER_SYNC_INTERVAL_MS &&
          entry.syncRequestCount < MAX_PEER_SYNC_REQUESTS
        ) {
          entry.lastSyncRequestAt = now
          entry.syncRequestCount += 1
          this.callbacks.onRequestPeerSync?.(entry.pubkey)
        }
        if (
          now - entry.joinedAt >= POLITE_FALLBACK_OFFER_DELAY_MS &&
          entry.offerRetryCount < 2 &&
          now - entry.lastOfferSentAt >= OFFER_RETRY_INTERVAL_MS
        ) {
          entry.offerRetryCount += 1
          void this.enqueuePeerSignal(entry.pubkey, () => this.initiateOfferInternal(entry, false))
        }
      }

      // Watchdog 3: SDP negotiated but ICE stalled/disconnected/failed — trigger automatic ICE restart
      if (
        !isConnected &&
        pc.remoteDescription &&
        !entry.makingOffer &&
        entry.iceRestartCount < MAX_ICE_RESTARTS &&
        now - entry.lastIceRestartAt >= ICE_RESTART_COOLDOWN_MS
      ) {
        const isPolite = this.selfPubkey > entry.pubkey
        const stallAllowance = isPolite ? ICE_CHECKING_STALL_MS + 2_000 : ICE_CHECKING_STALL_MS
        const negotiatedSince = entry.negotiatedAt ?? entry.joinedAt
        const stalledChecking =
          (entry.iceState === 'checking' || entry.iceState === 'new') &&
          now - negotiatedSince >= stallAllowance
        const stalledDisconnected =
          entry.iceState === 'disconnected' &&
          entry.disconnectedAt !== null &&
          now - entry.disconnectedAt >= ICE_DISCONNECTED_RESTART_MS
        const failed = entry.iceState === 'failed'

        if (stalledChecking || stalledDisconnected || failed) {
          void this.enqueuePeerSignal(entry.pubkey, () => this.initiateOfferInternal(entry, true))
        }
      }

      try {
        const report = await entry.pc.getStats()
        let foundRtt: number | null = null
        report.forEach((stat) => {
          if (
            stat.type === 'candidate-pair' &&
            (stat.state === 'succeeded' || stat.nominated === true) &&
            typeof stat.currentRoundTripTime === 'number' &&
            Number.isFinite(stat.currentRoundTripTime)
          ) {
            foundRtt = Math.round(stat.currentRoundTripTime * 1000)
          }
        })
        if (foundRtt !== entry.rttMs) {
          entry.rttMs = foundRtt
          changed = true
        }
      } catch {
        // Ignore stats error on closed connection
      }
    }
    if (changed) this.emitState()
  }

  private broadcastLocalMediaState(): void {
    this.callbacks.onBroadcastMediaState(this.getLocalMediaState())
  }

  private emitState(): void {
    if (!this.disposed) {
      this.callbacks.onStateChange()
    }
  }
}
