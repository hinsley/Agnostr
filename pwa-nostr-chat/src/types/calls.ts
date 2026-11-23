export const MAX_CALL_PARTICIPANTS = 6
export const DEFAULT_SERVER_VOICE_ROOM_ID = 'lounge'
export const DEFAULT_GEO_VOICE_ROOM_ID = 'radio'

export type CallMode = 'dm' | 'server' | 'geo'

export type CallMediaType = 'audio' | 'video'

export type CallStatus = 'idle' | 'ringing-out' | 'connecting' | 'active'

export type RecordingQualityPreset = 'saver' | 'standard' | 'high' | 'ultra'

export interface RecordingQualitySpec {
  id: RecordingQualityPreset
  label: string
  shortLabel: string
  width: number
  height: number
  fps: number
  videoBitsPerSecond: number
  audioBitsPerSecond: number
  approxMbPerMin: string
}

export type PeerIceConnectionState =
  | 'new'
  | 'checking'
  | 'connected'
  | 'completed'
  | 'disconnected'
  | 'failed'
  | 'closed'

export interface CallParticipant {
  pubkey: string
  nickname: string
  displayHandle: string
  isSelf: boolean
  /** True for remote group-call peers who are not yet in Trusted Peers (zero WebRTC / zero media) */
  isUntrusted?: boolean
  stream: MediaStream | null
  audioMuted: boolean
  videoEnabled: boolean
  screenSharing: boolean
  isRecording: boolean
  isSpeaking: boolean
  /** Normalized live audio level 0..1 */
  audioLevel: number
  iceState: PeerIceConnectionState
  rttMs: number | null
  joinedAt: number // unix ms
}

export interface ActiveCallSession {
  callId: string
  mode: CallMode
  status: CallStatus
  mediaType: CallMediaType
  encrypted: boolean
  title: string
  peerPubkey?: string
  serverId?: string
  geohash?: string
  roomId?: string
  startedAt: number // unix ms
  connectedAt: number | null // unix ms
  localMuted: boolean
  localDeafened: boolean
  localCameraOn: boolean
  localScreenSharing: boolean
  localRecording: boolean
  localRecordingStartedAt: number | null
  localRecordingMode: 'audio' | 'video' | null
  localRecordingQuality: RecordingQualityPreset | null
  localRecordingBytes: number
  recordingSupported: boolean
  screenShareSupported: boolean
  participants: CallParticipant[]
  maxParticipants: number
}

export interface IncomingCallOffer {
  callId: string
  callerPubkey: string
  callerNickname: string
  callerDisplayHandle: string
  mediaType: CallMediaType
  receivedAt: number // unix ms
}

export interface RoomCallPresence {
  serverId: string
  roomId: string
  pubkey: string
  nickname: string
  displayHandle: string
  hasVideo: boolean
  audioMuted: boolean
  isRecording?: boolean
  lastSeenAt: number // unix ms
}

export interface GeoCallPresence {
  geohash: string
  roomId: string
  pubkey: string
  nickname: string
  displayHandle: string
  hasVideo: boolean
  audioMuted: boolean
  isRecording?: boolean
  lastSeenAt: number // unix ms
}

export interface TurnServerConfig {
  url: string
  username?: string
  credential?: string
}

export interface CallEngine {
  activeCall: ActiveCallSession | null
  incomingCall: IncomingCallOffer | null
  /** True while an outgoing 1-on-1 DM call is ringing and awaiting remote pickup */
  isOutgoingDmRinging: boolean
  /** Map of serverId -> active participants in that server's Voice & Video Lounge */
  serverCallRosters: Record<string, RoomCallPresence[]>
  /** Map of normalized geohash -> active participants in that Geo Radio channel's group call */
  geoCallRosters: Record<string, GeoCallPresence[]>
  maxParticipants: number
  recordingQuality: RecordingQualityPreset
  setRecordingQuality: (quality: RecordingQualityPreset) => void
  turnConfig: TurnServerConfig | null
  saveTurnConfig: (config: TurnServerConfig) => boolean
  clearTurnConfig: () => void
  startDmCall: (peerPubkey: string, media: CallMediaType, nicknameHint?: string) => Promise<boolean>
  acceptIncomingCall: (media?: CallMediaType) => Promise<boolean>
  declineIncomingCall: () => void
  joinServerCall: (serverId: string, media: CallMediaType, roomId?: string) => Promise<boolean>
  joinGeoCall: (geohash: string, media: CallMediaType) => Promise<boolean>
  leaveCall: () => void
  toggleMute: () => void
  toggleDeafen: () => void
  toggleCamera: () => Promise<boolean>
  toggleScreenShare: () => Promise<boolean>
  toggleRecording: () => Promise<void>
  audioOutputDevices: MediaDeviceInfo[]
  audioInputDevices: MediaDeviceInfo[]
  selectedAudioOutputId: string
  selectedAudioInputId: string
  /** True when HTMLMediaElement.prototype.setSinkId is supported (Chrome/Edge/Android/Firefox desktop) */
  supportsAudioOutputSelection: boolean
  /** True when navigator.mediaDevices.selectAudioOutput() OS picker is available */
  supportsSystemAudioOutputPicker: boolean
  refreshAudioDevices: () => Promise<void>
  selectAudioOutput: (deviceId: string) => void
  promptSystemAudioOutput: () => Promise<boolean>
  selectAudioInput: (deviceId: string) => Promise<boolean>
  getServerCallCount: (serverId: string) => number
  getGeoCallPresence: (geohash: string) => GeoCallPresence[]
  getGeoCallCount: (geohash: string) => number
}
