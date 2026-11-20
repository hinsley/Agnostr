export type ThemeId = 'phosphor' | 'amber' | 'obsidian' | 'daylight'

export type InspectorTab = 'radar' | 'peers' | 'notes' | 'relays' | 'identity'

export type SignMode = 'auto' | 'local' | 'extension'

export type GeoPrecisionLevel =
  | 'continent'
  | 'region'
  | 'subregion'
  | 'province'
  | 'city'
  | 'neighborhood'
  | 'block'
  | 'building'

export interface GeoCoords {
  lat: number
  lon: number
}

export interface GeoBounds {
  latMin: number
  latMax: number
  lonMin: number
  lonMax: number
}

export interface PrecisionInfo {
  precision: number
  level: GeoPrecisionLevel
  label: string
  approxSizeLabel: string
  allowsPresence: boolean
}

export interface GeoPrefixStep {
  geohash: string
  precision: number
  label: string
  approxSizeLabel: string
}

export interface GeoNeighbors {
  nw: string | null
  n: string | null
  ne: string | null
  w: string | null
  center: string
  e: string | null
  sw: string | null
  s: string | null
  se: string | null
}

export interface GeohashCell {
  geohash: string
  precision: number
  level: GeoPrecisionLevel
  label: string
  approxSizeLabel: string
  allowsPresence: boolean
  center: GeoCoords
  bounds: GeoBounds
  neighbors: GeoNeighbors
  prefixChain: GeoPrefixStep[]
  nearestCity: string | null
}

export interface QuickCity {
  name: string
  region: string
  geohash: string
  lat: number
  lon: number
  isLounge?: boolean
}

export interface ReactionSummary {
  emoji: string
  count: number
  pubkeys: string[]
  reactedByMe: boolean
}

export interface ReplyReference {
  id: string
  pubkey?: string
  nickname?: string
  preview?: string
}

export type MessageDeliveryStatus = 'sending' | 'sent' | 'failed'

export interface GeoMessage {
  id: string
  geohash: string
  pubkey: string
  nickname: string
  displayHandle: string
  content: string
  createdAt: number // unix seconds
  tags: string[][]
  isOwn: boolean
  isSystem?: boolean
  isEmote?: boolean
  isTeleported: boolean
  isMeshBridge: boolean
  bridgeClient?: string
  powBits: number
  replyTo?: ReplyReference
  reactions: ReactionSummary[]
  mentions: string[]
  deliveryStatus?: MessageDeliveryStatus
  relayCount?: number
}

export interface PeerInfo {
  pubkey: string
  npub: string
  nickname: string
  displayHandle: string
  lastSeenAt: number // unix seconds
  isOnline: boolean
  isSelf: boolean
  isTeleported: boolean
  isMeshBridge: boolean
  isBlocked: boolean
  messageCount: number
  channels: string[]
}

export type RelayStatus =
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'disconnected'
  | 'error'

export type RelayRole = 'core' | 'geo' | 'pulse' | 'custom'

export interface RelayTelemetry {
  url: string
  status: RelayStatus
  roles: RelayRole[]
  lat?: number
  lon?: number
  distanceKm?: number
  rttMs: number | null
  rttHistory: number[]
  rxCount: number
  txCount: number
  okCount: number
  rejectCount: number
  connectedAt: number | null
  lastActivityAt: number | null
  lastError: string | null
  reconnectAttempts: number
  supportsEphemeral: boolean
  supportsDm: boolean
}

export interface PulseRoom {
  geohash: string
  center: GeoCoords
  precision: number
  messageCount: number
  peerCount: number
  lastActivityAt: number // unix ms
  lastPreview: string
  lastSender: string
  messagesPerMin: number
  nearestCity: string | null
}

export interface LocationNote {
  id: string
  geohash: string
  pubkey: string
  nickname: string
  displayHandle: string
  content: string
  createdAt: number // unix seconds
  expiresAt: number // unix seconds
  isOwn: boolean
}

export type DmProtocol = 'bitchat' | 'nip17'

export interface DmMessage {
  id: string
  peerPubkey: string
  senderPubkey: string
  content: string
  createdAt: number // unix seconds
  isOwn: boolean
  protocol: DmProtocol
  deliveryStatus: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
}

export interface DmThread {
  peerPubkey: string
  peerNpub: string
  peerNickname: string
  peerDisplayHandle: string
  protocol: DmProtocol
  messages: DmMessage[]
  unreadCount: number
  lastMessageAt: number // unix seconds
  lastPreview: string
}

export interface IdentityState {
  signMode: SignMode
  nickname: string
  masterPubkey: string
  masterNpub: string
  activePubkey: string
  activeNpub: string
  activeDisplayHandle: string
  perGeohashIdentity: boolean
  hasNip07: boolean
  hasNip07Nip44: boolean
  localSecretValid: boolean
  maskedNsec: string | null
  exportableNsec: string | null
}

export interface LocationState {
  status: 'idle' | 'locating' | 'ready' | 'denied' | 'unavailable'
  coords: GeoCoords | null
  localGeohashes: Record<number, string>
  accuracyMeters: number | null
  error: string | null
  isTeleported: boolean
}

export interface AppSettings {
  theme: ThemeId
  soundEnabled: boolean
  powEnabled: boolean
  powTargetBits: number
  presenceEnabled: boolean
  perGeohashIdentity: boolean
  showBridgeBadges: boolean
}

export type ToastLevel = 'info' | 'success' | 'warning' | 'error'

export interface ToastItem {
  id: string
  level: ToastLevel
  title: string
  detail?: string
  createdAt: number
}

export interface SlashCommandDef {
  name: string
  aliases: string[]
  usage: string
  description: string
  category: 'chat' | 'nav' | 'peer' | 'system'
}

export interface PinnedChannel {
  geohash: string
  label?: string
  pinnedAt: number
  unreadCount: number
  mentionCount: number
}

export type ActiveView =
  | { type: 'channel'; geohash: string }
  | { type: 'dm'; peerPubkey: string }

export interface ChannelPresenceSummary {
  onlineCount: number
  totalSeenCount: number
  /** True for high-precision (len >= 6) rooms where presence heartbeats are disabled and 0 peers detected */
  isUncertainCount: boolean
  isBroadcastingPresence: boolean
}

export interface AgnostrEngine {
  // Active navigation & channel geometry
  activeView: ActiveView
  activeGeohash: string
  cell: GeohashCell
  isTeleported: boolean
  location: LocationState
  quickCities: QuickCity[]

  // Messages, peers, presence & notes for active geohash
  messages: GeoMessage[]
  peers: PeerInfo[]
  presence: ChannelPresenceSummary
  locationNotes: LocationNote[]
  unreadDividerId: string | null
  sending: boolean
  replyingTo: GeoMessage | null
  setReplyingTo: (msg: GeoMessage | null) => void

  // Discovery & pins
  pulseRooms: PulseRoom[]
  pinnedChannels: PinnedChannel[]
  recentChannels: string[]
  isChannelPinned: (geohash: string) => boolean
  togglePinChannel: (geohash: string, label?: string) => void

  // Direct Messages (dual-stack: Bitchat v2 + NIP-17)
  dmThreads: DmThread[]
  activeDmThread: DmThread | null
  totalDmUnread: number
  openDmThread: (peerPubkey: string, nicknameHint?: string, preferredProtocol?: DmProtocol) => void
  sendDirectMessage: (peerPubkey: string, content: string, protocol?: DmProtocol) => Promise<boolean>

  // Channel & messaging actions
  tuneGeohash: (geohashOrCity: string) => boolean
  locateMe: () => Promise<string | null>
  sendInput: (rawText: string) => Promise<boolean>
  sendReaction: (message: GeoMessage, emoji: string) => Promise<void>
  postLocationNote: (content: string) => Promise<boolean>
  refreshLocationNotes: () => void
  clearCurrentTimeline: () => void
  markChannelRead: (geohash?: string) => void

  // Peer moderation
  blockedPubkeys: string[]
  isPeerBlocked: (pubkey: string) => boolean
  toggleBlockPeer: (pubkey: string, label?: string) => void
  getPeerByPubkey: (pubkey: string) => PeerInfo | null

  // Relays & telemetry
  relays: RelayTelemetry[]
  connectedRelayCount: number
  totalRelayCount: number
  avgLatencyMs: number | null
  customRelays: string[]
  geoDirectoryCount: number
  addCustomRelay: (url: string) => boolean
  removeCustomRelay: (url: string) => void
  resetCustomRelays: () => void
  reconnectRelays: () => void

  // Identity & settings
  identity: IdentityState
  settings: AppSettings
  setNickname: (nickname: string) => void
  setSignMode: (mode: SignMode) => void
  setLocalSecret: (nsecOrHex: string) => boolean
  rotateIdentity: () => void
  updateSettings: (patch: Partial<AppSettings>) => void
  setTheme: (theme: ThemeId) => void
  panicWipe: () => void

  // Commands, export & notifications
  commands: SlashCommandDef[]
  exportTranscript: (format: 'markdown' | 'json') => { filename: string; content: string; mimeType: string }
  toasts: ToastItem[]
  pushToast: (level: ToastLevel, title: string, detail?: string) => void
  dismissToast: (id: string) => void
}
