import type {
  ImageAttachment,
  MessageDeliveryStatus,
  PreparedImage,
  ReactionSummary,
  RecordedVoiceMemo,
  ReplyReference,
  VoiceMemoAttachment,
} from './protocol.ts'

export type ServerKind = 'virtual' | 'nip29'

export type ServerRole = 'founder' | 'admin' | 'mod' | 'member'

export interface ServerChannel {
  id: string
  name: string
  topic?: string
  unreadCount?: number
}

export interface VirtualServerManifest {
  v: 1
  id: string
  name: string
  description: string
  icon: string
  accentColor: string
  founderPubkey: string
  encrypted: boolean
  channels: ServerChannel[]
  moderators: string[]
  bannedPubkeys: string[]
  relays: string[]
  rev: number
  createdAt: number // unix seconds
  updatedAt: number // unix seconds
}

export interface Nip29RelayPreset {
  url: string
  name: string
  description: string
  supportsCreate: boolean
  requiresAuth?: boolean
}

export interface Nip29GroupMeta {
  relayUrl: string
  groupId: string
  name: string
  about: string
  picture?: string
  banner?: string
  isPrivate: boolean
  isClosed: boolean
  isRestricted: boolean
  isHidden: boolean
  supportedKinds?: number[]
  updatedAt: number // unix seconds
}

export interface Nip29Member {
  pubkey: string
  npub: string
  nickname: string
  displayHandle: string
  roles: string[]
  isAdmin: boolean
  isFounder: boolean
  isBanned?: boolean
  isSelf: boolean
  isTrusted: boolean
}

export interface ServerSummary {
  id: string
  kind: ServerKind
  name: string
  description: string
  icon: string
  picture?: string
  accentColor: string
  encrypted: boolean
  /** Local-only 32-byte AES-256-GCM key (base64url) for E2EE private virtual servers */
  encryptionKeyB64?: string
  founderPubkey: string
  /** For NIP-29 servers */
  relayUrl?: string
  groupId?: string
  isPrivate?: boolean
  isClosed?: boolean
  isRestricted?: boolean
  relays: string[]
  channels: ServerChannel[]
  moderators: string[]
  bannedPubkeys: string[]
  admins?: Array<{ pubkey: string; roles: string[] }>
  members?: string[]
  isJoinedMember?: boolean
  rev: number
  joinedAt: number // unix ms
  lastActiveChannelId: string
  unreadCount: number
  mentionCount: number
}

export interface ServerMessage {
  id: string
  serverId: string
  channelId: string
  pubkey: string
  nickname: string
  displayHandle: string
  content: string
  createdAt: number // unix seconds
  tags: string[][]
  isOwn: boolean
  isSystem?: boolean
  isEmote?: boolean
  encrypted: boolean
  decryptFailed?: boolean
  powBits: number
  replyTo?: ReplyReference
  reactions: ReactionSummary[]
  mentions: string[]
  voiceMemo?: VoiceMemoAttachment
  imageAttachment?: ImageAttachment
  deliveryStatus?: MessageDeliveryStatus
  relayCount?: number
}

export interface ServerInvite {
  v: 1
  kind: ServerKind
  /** Virtual serverId or NIP-29 groupId */
  id: string
  name: string
  description?: string
  icon?: string
  accentColor?: string
  founderPubkey?: string
  encrypted?: boolean
  /** Base64url 32-byte AES-256-GCM key for private virtual servers */
  key?: string
  relayUrl?: string
  relays?: string[]
  channels?: Array<{ id: string; name: string }>
  inviteCode?: string
  inviterPubkey?: string
  rawCode: string
}

export interface CreateVirtualServerInput {
  name: string
  description?: string
  icon?: string
  accentColor?: string
  encrypted: boolean
  channels?: string[]
}

export interface CreateNip29GroupInput {
  relayUrl: string
  name: string
  about?: string
  icon?: string
  accentColor?: string
  isPrivate?: boolean
  isClosed?: boolean
}

export interface ServersEngine {
  // Joined & active server state
  joinedServers: ServerSummary[]
  activeServer: ServerSummary | null
  activeChannel: ServerChannel | null
  messages: ServerMessage[]
  hiddenByTrustCount: number
  members: Nip29Member[]
  myRole: ServerRole
  canModerate: boolean
  sending: boolean
  creating: boolean
  replyingTo: ServerMessage | null
  setReplyingTo: (msg: ServerMessage | null) => void
  totalServerUnread: number

  // Invite URL detection (#invite=...)
  pendingInvite: ServerInvite | null
  clearPendingInvite: () => void

  // NIP-29 discovery explorer
  nip29Presets: Nip29RelayPreset[]
  exploredRelayUrl: string
  exploredGroups: Nip29GroupMeta[]
  exploringRelay: boolean
  exploreError: string | null
  exploreNip29Relay: (relayUrl: string) => Promise<void>

  // Navigation
  selectServer: (serverId: string, channelId?: string) => void
  selectChannel: (serverId: string, channelId: string) => void

  // Creation, invites & membership
  createVirtualServer: (input: CreateVirtualServerInput) => Promise<ServerSummary | null>
  createNip29Group: (input: CreateNip29GroupInput) => Promise<ServerSummary | null>
  parseInviteInput: (raw: string) => ServerInvite | null
  buildInviteLink: (serverId: string) => { code: string; url: string } | null
  joinFromInvite: (invite: ServerInvite) => Promise<ServerSummary | null>
  joinNip29Group: (
    relayUrl: string,
    groupId: string,
    metaHint?: Nip29GroupMeta,
    inviteCode?: string
  ) => Promise<ServerSummary | null>
  sendInviteViaDm: (serverId: string, recipientPubkey: string) => Promise<boolean>
  leaveServer: (serverId: string) => Promise<void>

  // Messaging, voice, images & reactions (all media strictly honors Trusted Peers gate)
  sendMessage: (rawText: string) => Promise<boolean>
  sendVoiceMemo: (recorded: RecordedVoiceMemo, caption?: string) => Promise<boolean>
  sendImageAttachment: (image: PreparedImage, caption?: string) => Promise<boolean>
  sendReaction: (message: ServerMessage, emoji: string) => Promise<void>
  deleteMessage: (message: ServerMessage) => Promise<boolean>
  clearChannelCache: () => void

  // Administration & moderation
  updateServerMetadata: (
    serverId: string,
    patch: { name?: string; description?: string; icon?: string; accentColor?: string }
  ) => Promise<boolean>
  addChannel: (serverId: string, name: string, topic?: string) => Promise<boolean>
  removeChannel: (serverId: string, channelId: string) => Promise<boolean>
  addModerator: (serverId: string, pubkeyOrNpub: string) => Promise<boolean>
  removeModerator: (serverId: string, pubkey: string) => Promise<boolean>
  banMember: (serverId: string, pubkeyOrNpub: string, reason?: string) => Promise<boolean>
  unbanMember: (serverId: string, pubkey: string) => Promise<boolean>
}
