export const MAX_CALL_PARTICIPANTS = 6
export const DEFAULT_SERVER_VOICE_ROOM_ID = 'lounge'

export type CallMode = 'dm' | 'server'

export type CallMediaType = 'audio' | 'video'

export type CallStatus = 'idle' | 'ringing-out' | 'connecting' | 'active'

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

export interface TurnServerConfig {
  url: string
  username?: string
  credential?: string
}

export interface CallEngine {
  activeCall: ActiveCallSession | null
  incomingCall: IncomingCallOffer | null
  /** Map of serverId -> active participants in that server's Voice & Video Lounge */
  serverCallRosters: Record<string, RoomCallPresence[]>
  maxParticipants: number
  turnConfig: TurnServerConfig | null
  saveTurnConfig: (config: TurnServerConfig) => boolean
  clearTurnConfig: () => void
  startDmCall: (peerPubkey: string, media: CallMediaType, nicknameHint?: string) => Promise<boolean>
  acceptIncomingCall: (media?: CallMediaType) => Promise<boolean>
  declineIncomingCall: () => void
  joinServerCall: (serverId: string, media: CallMediaType, roomId?: string) => Promise<boolean>
  leaveCall: () => void
  toggleMute: () => void
  toggleDeafen: () => void
  toggleCamera: () => Promise<boolean>
  toggleScreenShare: () => Promise<boolean>
  toggleRecording: () => Promise<void>
  getServerCallCount: (serverId: string) => number
}
