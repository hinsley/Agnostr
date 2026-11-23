import type { AmailEngine } from './amail.ts'
import type { CallEngine } from './calls.ts'
import type { ContentFilterEngine } from './contentFilter.ts'
import type { DeviceSyncEngine } from './deviceSync.ts'
import type { NotificationEngine } from './notifications.ts'
import type { ServersEngine } from './servers.ts'
import type { TranscriptionEngine } from './transcription.ts'
import type { TranslatorEngine } from './translator.ts'
import type { WalletEngine, ZapEngine } from './wallet.ts'

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

export interface VoiceMemoEncryption {
  alg: 'aes-gcm-256'
  keyB64: string
  ivB64: string
  plaintextSha256: string
}

export interface VoiceMemoAttachment {
  url: string
  mime: string
  size: number
  durationSec: number
  /** 32 normalized amplitude peaks in range 0..100 */
  waveform: number[]
  /** SHA-256 hex of the Blossom blob (ciphertext if encrypted, audio if public) */
  sha256: string
  encryption?: VoiceMemoEncryption
  server?: string
}

export interface RecordedVoiceMemo {
  blob: Blob
  mime: string
  size: number
  durationSec: number
  /** 32 normalized amplitude peaks in range 0..100 */
  waveform: number[]
  /** Local preview object URL (revoked on discard/send) */
  previewUrl: string
  /** Optional pre-send local transcript generated before uploading */
  previewTranscript?: string
  /** Optional model label that produced previewTranscript */
  previewTranscriptModel?: string
}

export interface ImageAttachment {
  url: string
  mime: string
  sha256: string
  size: number
  width: number
  height: number
  alt?: string
  encryption?: VoiceMemoEncryption
  server?: string
}

export interface PreparedImage {
  blob: Blob
  mime: string
  size: number
  width: number
  height: number
  /** Local preview object URL (revoked on discard/send/unmount) */
  previewUrl: string
  fileName: string
}

export interface TrustedPeerEntry {
  pubkey: string
  npub: string
  label?: string
  addedAt: number // unix ms
}

export interface PendingTrustRequest {
  pubkey: string
  npub: string
  label?: string
}

export type VoiceSendPhase = 'idle' | 'encrypting' | 'uploading' | 'signing' | 'publishing'

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
  clientName?: string
  isAgnostrClient?: boolean
  powBits: number
  replyTo?: ReplyReference
  reactions: ReactionSummary[]
  mentions: string[]
  voiceMemo?: VoiceMemoAttachment
  imageAttachment?: ImageAttachment
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
  clientName?: string
  isAgnostrClient?: boolean
  isBlocked: boolean
  isTrusted?: boolean
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
  lastMessageAt?: number // unix ms of latest visible chat message
  lastMessageId?: string
  lastPreview: string
  lastSender: string
  lastSenderPubkey?: string
  messagesPerMin: number
  nearestCity: string | null
}

export interface RadioChannelPreview {
  id: string
  preview: string
  sender: string
  senderPubkey: string
  createdAt: number // unix seconds
  updatedAtMs: number // unix ms
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
  /** Monotonic causal sort key in unix ms (prevents clock-skew reordering across sessions) */
  orderMs?: number
  isOwn: boolean
  protocol: DmProtocol
  voiceMemo?: VoiceMemoAttachment
  imageAttachment?: ImageAttachment
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
  /** When true, appends NIP-89 ["client", "agnostr"] tag to Geo Radio messages & presence */
  broadcastClientTag: boolean
  /** When true, hides text messages from unwhitelisted pubkeys too (media/voice is ALWAYS whitelist-gated) */
  strictWhitelistMode: boolean
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
  | { type: 'server'; serverId: string; channelId: string }

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

  // Discovery, pins & per-geohash unread/direct-ping counters
  pulseRooms: PulseRoom[]
  channelPreviews: Record<string, RadioChannelPreview>
  pinnedChannels: PinnedChannel[]
  recentChannels: string[]
  unreadCounts: Record<string, number>
  mentionCounts: Record<string, number>
  totalGeoUnread: number
  totalGeoMentions: number
  isChannelPinned: (geohash: string) => boolean
  togglePinChannel: (geohash: string, label?: string) => void
  reorderPinnedChannels: (fromIndex: number, toIndex: number) => void

  // Direct Messages (dual-stack: Bitchat v2 + NIP-17)
  dmThreads: DmThread[]
  activeDmThread: DmThread | null
  totalDmUnread: number
  openDmThread: (peerPubkey: string, nicknameHint?: string, preferredProtocol?: DmProtocol) => void
  closeDmThread: (pubkey: string) => void
  sendDirectMessage: (
    peerPubkey: string,
    content: string,
    protocol?: DmProtocol,
    onPublishedId?: (id: string) => void
  ) => Promise<boolean>

  // Channel & messaging actions
  tuneGeohash: (geohashOrCity: string) => boolean
  tuneRadioChannel: (channelKeyOrInput: string) => boolean
  tuneTopicChannel: (slug: string) => boolean
  locateMe: () => Promise<string | null>
  sendInput: (
    rawText: string,
    options?: {
      onPublishedId?: (id: string) => void
      originalText?: string
      translatedToLang?: string
      sourceLang?: string
    }
  ) => Promise<boolean>
  sendReaction: (message: GeoMessage, emoji: string) => Promise<void>
  postLocationNote: (content: string) => Promise<boolean>
  refreshLocationNotes: () => void
  clearCurrentTimeline: () => void
  markChannelRead: (geohash?: string) => void

  // Peer moderation & whitelist-based receipt
  blockedPubkeys: string[]
  isPeerBlocked: (pubkey: string) => boolean
  toggleBlockPeer: (pubkey: string, label?: string) => void
  getPeerByPubkey: (pubkey: string) => PeerInfo | null
  trustedPubkeys: TrustedPeerEntry[]
  /** True if pubkey is in trusted whitelist OR is one of the user's own pubkeys */
  isTrusted: (pubkey: string) => boolean
  /** True only if pubkey is explicitly stored in trustedPubkeys */
  isExplicitlyTrusted: (pubkey: string) => boolean
  trustPubkey: (pubkeyOrNpub: string, label?: string) => boolean
  pendingTrustRequest: PendingTrustRequest | null
  confirmPendingTrust: () => void
  cancelPendingTrust: () => void
  untrustPubkey: (pubkey: string) => void
  clearTrustedPubkeys: () => void
  /** Local private notes per peer pubkey (lowercase 64-hex -> trimmed note, non-empty only), synced across linked devices */
  peerNotes: Record<string, string>
  setPeerNote: (pubkey: string, note: string) => void
  strictWhitelistMode: boolean
  setStrictWhitelistMode: (enabled: boolean) => void
  /** Count of text messages in active channel currently hidden by strictWhitelistMode */
  hiddenByWhitelistCount: number

  // Blossom media servers & voice memos (BUD-01/BUD-02 + E2EE DM audio)
  blossomServers: string[]
  addBlossomServer: (url: string) => boolean
  removeBlossomServer: (url: string) => void
  resetBlossomServers: () => void
  voiceSendPhase: VoiceSendPhase
  sendVoiceMemo: (recorded: RecordedVoiceMemo, caption?: string) => Promise<boolean>
  /** STRICT trusted-peers-gated fetch: refuses untrusted senders with zero network requests */
  fetchVoiceMemoBlob: (memo: VoiceMemoAttachment, senderPubkey: string) => Promise<string>
  sendImageAttachment: (image: PreparedImage, caption?: string) => Promise<boolean>
  /** STRICT trusted-peers-gated fetch: refuses untrusted senders with zero network requests */
  fetchImageAttachmentBlob: (image: ImageAttachment, senderPubkey: string) => Promise<string>

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
  broadcastClientTag: boolean
  setBroadcastClientTag: (enabled: boolean) => void
  setNickname: (nickname: string) => void
  setSignMode: (mode: SignMode) => void
  setLocalSecret: (nsecOrHex: string) => boolean
  rotateIdentity: () => void
  updateSettings: (patch: Partial<AppSettings>) => void
  setTheme: (theme: ThemeId) => void
  panicWipe: () => void

  // Discord-like Servers (Instant Virtual Public/E2EE + NIP-29 Relay Communities)
  servers: ServersEngine

  // P2P WebRTC Voice & Video Calls (1-on-1 DM Calls + Server Group Calls up to 6)
  calls: CallEngine

  // On-device local voice transcription (Voice Memos + Live Call Captions)
  transcription: TranscriptionEngine

  // On-device AI Content Filtering (LiquidAI/d1-2B-ONNX via WebGPU/WASM)
  contentFilter: ContentFilterEngine

  // On-device AI Translation (onnx-community/LFM3-1.7B-ONNX via WebGPU/WASM)
  translator: TranslatorEngine

  // Built-in Multi-Mint Cashu Ecash Wallet + Boltz v2 On-Chain Swaps
  wallet: WalletEngine

  // Nymchat & NIP-57 Lightning Address Discovery + Zaps
  zaps: ZapEngine

  // Silent Multi-Device Same-Key Background Sync (NIP-44 self-encrypted CRDT + delta messages)
  deviceSync: DeviceSyncEngine

  // Amail — E2EE Briar-inspired Store-and-Forward Meshnet Snailmail
  amail: AmailEngine

  // Push notifications, live incoming DM call ringing & Web Push bridge
  notifications: NotificationEngine

  // Commands, export & notifications
  commands: SlashCommandDef[]
  exportTranscript: (format: 'markdown' | 'json') => { filename: string; content: string; mimeType: string }
  toasts: ToastItem[]
  pushToast: (level: ToastLevel, title: string, detail?: string) => void
  dismissToast: (id: string) => void
}
