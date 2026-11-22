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
const STATS_POLL_INTERVAL_MS = 3_000
const VAD_SPEAKING_THRESHOLD = 0.055
const VAD_HANGOVER_MS = 380
const MAX_PENDING_ICE = 64

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

  private audioCtx: AudioContext | null = null
  private vadChannels = new Map<string, VadChannel>()
  private vadTimer: number | null = null
  private statsTimer: number | null = null
  private disposed = false

  constructor(opts: {
    selfPubkey: string
    selfNickname: string
    turnConfig?: TurnServerConfig | null
    callbacks: WebRtcMeshCallbacks
  }) {
    this.selfPubkey = opts.selfPubkey.toLowerCase()
    this.selfNickname = opts.selfNickname
    this.iceServers = buildIceServers(opts.turnConfig)
    this.callbacks = opts.callbacks
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
    if (pk === this.selfPubkey) return false
    if (this.peers.has(pk)) return true
    return this.peers.size < MAX_REMOTE_PEERS
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

  async initLocalMedia(media: CallMediaType): Promise<{ audioOk: boolean; videoOk: boolean }> {
    if (this.disposed) return { audioOk: false, videoOk: false }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('WebRTC media capture is unavailable in this browser context (requires HTTPS or localhost).')
    }

    const profile = getAdaptiveVideoProfile(this.getParticipantCount())
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
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
    if (pk === this.selfPubkey) return false

    const existing = this.peers.get(pk)
    if (existing) {
      if (nicknameHint && nicknameHint.trim()) {
        existing.nickname = nicknameHint.trim()
        this.emitState()
      }
      return true
    }

    if (this.peers.size >= MAX_REMOTE_PEERS) {
      return false
    }

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 2,
    })

    const remoteStream = new MediaStream()
    const entry: RemotePeerEntry = {
      pubkey: pk,
      nickname: nicknameHint?.trim() || `anon${pk.slice(-4)}`,
      pc,
      remoteStream,
      pendingIce: [],
      audioMuted: false,
      videoEnabled: false,
      screenSharing: false,
      isRecording: false,
      isSpeaking: false,
      audioLevel: 0,
      lastSpokeAt: 0,
      iceState: 'new',
      rttMs: null,
      joinedAt: Date.now(),
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
      if (this.disposed || !event.candidate) return
      this.callbacks.onSendIce(pk, event.candidate.toJSON())
    }

    pc.ontrack = (event) => {
      if (this.disposed) return
      const track = event.track
      const alreadyHas = entry.remoteStream.getTracks().some((t) => t.id === track.id)
      if (!alreadyHas) {
        entry.remoteStream.addTrack(track)
      }
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
        this.attachVadStream(pk, entry.remoteStream)
      }
      this.emitState()
    }

    pc.oniceconnectionstatechange = () => {
      if (this.disposed) return
      const nextState = normalizeIceState(pc.iceConnectionState)
      if (entry.iceState === nextState) return
      entry.iceState = nextState
      if (nextState === 'connected' || nextState === 'completed') {
        void this.applyAdaptiveVideoScaling()
        this.callbacks.onPeerConnected?.(pk)
      } else if (nextState === 'failed') {
        this.callbacks.onPeerFailed?.(pk)
      }
      this.emitState()
    }

    this.peers.set(pk, entry)
    void this.applyAdaptiveVideoScaling()
    this.emitState()

    const shouldOffer = forceInitiate !== undefined ? forceInitiate : this.selfPubkey < pk
    if (shouldOffer) {
      void this.initiateOffer(entry)
    }
    return true
  }

  removePeer(peerPubkey: string): void {
    const pk = peerPubkey.toLowerCase()
    const entry = this.peers.get(pk)
    if (!entry) return
    this.peers.delete(pk)
    this.detachVadChannel(pk)
    try {
      entry.pc.onicecandidate = null
      entry.pc.ontrack = null
      entry.pc.oniceconnectionstatechange = null
      entry.pc.close()
    } catch {
      // Ignore close errors
    }
    void this.applyAdaptiveVideoScaling()
    this.emitState()
  }

  updatePeerMetadata(
    peerPubkey: string,
    patch: {
      nickname?: string
      audioMuted?: boolean
      videoEnabled?: boolean
      screenSharing?: boolean
      isRecording?: boolean
    }
  ): void {
    const entry = this.peers.get(peerPubkey.toLowerCase())
    if (!entry) return
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

  async handleRemoteOffer(peerPubkey: string, sdp: string, nicknameHint?: string): Promise<boolean> {
    if (this.disposed) return false
    const pk = peerPubkey.toLowerCase()
    if (!this.peers.has(pk)) {
      if (!this.canAddPeer(pk)) {
        // Hard cap reached (6 participants) — reject cleanly without creating RTCPeerConnection
        return false
      }
      this.connectToPeer(pk, nicknameHint, false)
    }

    const entry = this.peers.get(pk)
    if (!entry) return false
    if (nicknameHint && nicknameHint.trim()) {
      entry.nickname = nicknameHint.trim()
    }

    const pc = entry.pc
    const isPolite = this.selfPubkey > pk
    const offerCollision = entry.makingOffer || pc.signalingState !== 'stable'

    if (offerCollision && !isPolite) {
      // Deterministic glare resolution: impolite (lower pubkey) wins collision
      return true
    }

    try {
      if (offerCollision && isPolite) {
        await pc.setLocalDescription({ type: 'rollback' })
      }
      await pc.setRemoteDescription({ type: 'offer', sdp })
      await this.flushPendingIce(entry)

      const answer = await pc.createAnswer()
      const optimizedSdp = answer.sdp ? optimizeOpusSdp(answer.sdp) : answer.sdp
      await pc.setLocalDescription({ type: 'answer', sdp: optimizedSdp })
      if (pc.localDescription?.sdp) {
        this.callbacks.onSendAnswer(pk, pc.localDescription.sdp)
      }
      this.emitState()
      return true
    } catch {
      return false
    }
  }

  async handleRemoteAnswer(peerPubkey: string, sdp: string): Promise<void> {
    if (this.disposed) return
    const entry = this.peers.get(peerPubkey.toLowerCase())
    if (!entry) return
    if (entry.pc.signalingState !== 'have-local-offer') return
    try {
      await entry.pc.setRemoteDescription({ type: 'answer', sdp })
      await this.flushPendingIce(entry)
      void this.applyAdaptiveVideoScaling()
      if (entry.renegotiateQueued) {
        entry.renegotiateQueued = false
        void this.initiateOffer(entry)
      }
    } catch {
      // Ignore stale answer
    }
  }

  async handleRemoteIce(peerPubkey: string, candidate: RTCIceCandidateInit): Promise<void> {
    if (this.disposed) return
    const entry = this.peers.get(peerPubkey.toLowerCase())
    if (!entry) return
    if (!entry.pc.remoteDescription) {
      if (entry.pendingIce.length < MAX_PENDING_ICE) {
        entry.pendingIce.push(candidate)
      }
      return
    }
    try {
      await entry.pc.addIceCandidate(candidate)
    } catch {
      // Ignore stale/invalid ICE candidate
    }
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
        .some((t) => t.readyState === 'live' && !t.muted)
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
      try {
        entry.pc.onicecandidate = null
        entry.pc.ontrack = null
        entry.pc.oniceconnectionstatechange = null
        entry.pc.close()
      } catch {
        // Ignore close errors
      }
    }
    this.peers.clear()

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
        return
      }
      if (nextTrack && this.localStream) {
        entry.videoSender = entry.pc.addTrack(nextTrack, this.localStream)
        await this.initiateOffer(entry)
      }
    } catch {
      // Peer might have closed mid-transition
    }
  }

  private async initiateOffer(entry: RemotePeerEntry): Promise<void> {
    if (this.disposed) return
    if (entry.pc.signalingState !== 'stable') {
      entry.renegotiateQueued = true
      return
    }
    if (entry.makingOffer) {
      entry.renegotiateQueued = true
      return
    }
    entry.makingOffer = true
    try {
      const offer = await entry.pc.createOffer()
      const optimizedSdp = offer.sdp ? optimizeOpusSdp(offer.sdp) : offer.sdp
      await entry.pc.setLocalDescription({ type: 'offer', sdp: optimizedSdp })
      if (entry.pc.localDescription?.sdp) {
        this.callbacks.onSendOffer(entry.pubkey, entry.pc.localDescription.sdp)
      }
    } catch {
      // Ignore if peer closed during offer
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
    let changed = false
    for (const entry of this.peers.values()) {
      const nextIce = normalizeIceState(entry.pc.iceConnectionState)
      if (entry.iceState !== nextIce) {
        entry.iceState = nextIce
        changed = true
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
