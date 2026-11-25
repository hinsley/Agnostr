import type {
  DmMessage,
  DmProtocol,
  GeoMessage,
  PinnedChannel,
} from './protocol.ts'
import type { ServerMessage, ServerSummary } from './servers.ts'

/** Live metadata for another Agnostr device sharing the same master Nostr keypair */
export interface LinkedDeviceInfo {
  deviceId: string
  label: string
  nickname: string
  lastSeenAt: number
  /** Exact ms timestamp of last sync/checkpoint from this device */
  lastSyncedAt?: number
  online: boolean
}

/** LWW registry record for a device synced under this master Nostr keypair */
export interface SyncedDeviceRecord {
  deviceId: string
  label: string
  lastSyncedAt: number
  updatedAt: number
  removedAt?: number
}

/** Public engine surface exposed as `engine.deviceSync` */
export interface DeviceSyncEngine {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  deviceId: string
  deviceLabel: string
  setDeviceLabel: (label: string) => void
  linkedDevices: LinkedDeviceInfo[]
  onlineSiblingCount: number
  lastSyncedAt: number | null
  checkpointIssue: 'retry' | 'too-large' | null
  isSyncing: boolean
  syncedItemsCount: number
  syncNow: () => Promise<void>
  removeLinkedDevice: (deviceId: string) => void
  resetAll: () => void
}

/** Hook-in provider allowing optional subsystems (e.g. Amail) to ride multi-device encrypted sync */
export interface AmailSyncProvider {
  exportSyncState: () => Promise<unknown> | unknown
  mergeSyncState: (remote: unknown) => Promise<boolean | number | void> | boolean | number | void
}



/** LWW-Element-Set record for a joined/left Server (Virtual E2EE/Public or NIP-29) */
export interface SyncedServerRecord {
  id: string
  joinedAt: number
  leftAt: number
  updatedAt: number
  /** Present when joinedAt > leftAt; omitted on tombstones so left servers never resurrect */
  summary?: ServerSummary
}

/** LWW-Element-Set record for a Trusted Peer */
export interface SyncedTrustedRecord {
  pubkey: string
  npub: string
  label?: string
  addedAt: number
  removedAt: number
  updatedAt: number
}

/** LWW-Element-Set record for a Muted/Blocked Peer */
export interface SyncedBlockedRecord {
  pubkey: string
  label?: string
  addedAt: number
  removedAt: number
}

/** LWW-Register for custom Joined Groups / Servers sidebar ordering */
export interface SyncedServerOrderState {
  updatedAt: number
  ids: string[]
}

/** LWW-Register for ordered Pinned Bitchat Channels */
export interface SyncedPinnedState {
  updatedAt: number
  items: PinnedChannel[]
}

/** LWW-Register for Lightning Address (`lud16`) */
export interface SyncedLightningAddressState {
  value: string | null
  updatedAt: number
}

/** LWW-Register for Display Nickname */
export interface SyncedNicknameState {
  value: string
  updatedAt: number
}

/** LWW-Register record for a private per-peer note (`text: ''` acts as a deletion tombstone) */
export interface SyncedPeerNoteRecord {
  text: string
  updatedAt: number
}

/** Compact LWW-Register record for an active DM peer's latest known non-generic display name */
export interface SyncedDmPeerNameRecord {
  name: string
  updatedAt: number
}

/** Optional Amail sync snapshot bundled when size permits */
export interface SyncedAmailState {
  updatedAt: number
  hash: string
  payload: unknown
}

/** Compact bounded recent-message catch-up tail for offline kind:30078 checkpoints */
export interface SyncedRecentMessagesTail {
  dm?: Record<
    string,
    {
      peerNickname?: string
      protocol?: DmProtocol
      messages: DmMessage[]
    }
  >
  server?: Record<string, ServerMessage[]>
  bitchat?: Record<string, GeoMessage[]>
}

/** Full conflict-free timestamped CRDT state exchanged between same-key devices */
export interface DeviceSyncCrdtState {
  v: 1
  servers: Record<string, SyncedServerRecord>
  serverOrder?: SyncedServerOrderState
  trusted: Record<string, SyncedTrustedRecord>
  blocked: Record<string, SyncedBlockedRecord>
  pinned: SyncedPinnedState
  dmClearedAt: Record<string, number>
  lud16: SyncedLightningAddressState
  nickname: SyncedNicknameState
  peerNotes?: Record<string, SyncedPeerNoteRecord>
  dmPeerNames?: Record<string, SyncedDmPeerNameRecord>
  devices?: Record<string, SyncedDeviceRecord>
  amail?: SyncedAmailState | null
  recentMessages?: SyncedRecentMessagesTail
}

export type DeviceSyncMessageScopeKind = 'dm' | 'server' | 'bitchat'

export interface DeviceSyncScopeDigest {
  count: number
  latestTs: number
  hash: string
  versionsHash?: string // mutable DM metadata, independent of the legacy ID digest
}

export interface DeviceSyncMsgDigests {
  dm: Record<string, DeviceSyncScopeDigest>
  server: Record<string, DeviceSyncScopeDigest>
  bitchat: Record<string, DeviceSyncScopeDigest>
  amail?: { updatedAt: number; hash: string } | null
}

export interface DeviceSyncScopeRequest {
  kind: DeviceSyncMessageScopeKind
  key: string
  knownIds: string[]
  dmVersions?: boolean
  sinceSec?: number
}

export interface DeviceSyncHelloPacket {
  v: 1
  type: 'sync-hello'
  deviceId: string
  deviceLabel: string
  nickname: string
  ts: number
  stateRevision: number
  stateHash: string
  msgDigests: DeviceSyncMsgDigests
}

export interface DeviceSyncStatePacket {
  v: 1
  type: 'sync-state'
  deviceId: string
  deviceLabel: string
  nickname: string
  targetDeviceId?: string
  ts: number
  state: DeviceSyncCrdtState
}

export interface DeviceSyncMsgReqPacket {
  v: 1
  type: 'sync-msg-req'
  deviceId: string
  targetDeviceId: string
  ts: number
  scopes: DeviceSyncScopeRequest[]
  wantAmail?: boolean
}

export interface DeviceSyncMsgChunkPacket {
  v: 1
  type: 'sync-msg-chunk'
  deviceId: string
  targetDeviceId: string
  ts: number
  chunkIndex: number
  totalChunks: number
  scopeKind: DeviceSyncMessageScopeKind
  scopeKey: string
  peerMeta?: {
    peerNickname?: string
    protocol?: DmProtocol
  }
  messages: Array<DmMessage | ServerMessage | GeoMessage>
}

export interface DeviceSyncAmailChunkPacket {
  v: 1
  type: 'sync-amail-chunk'
  deviceId: string
  targetDeviceId: string
  ts: number
  transferId: string
  updatedAt: number
  hash: string
  chunkIndex: number
  totalChunks: number
  data: string
}

export type DeviceSyncWirePacket =
  | DeviceSyncHelloPacket
  | DeviceSyncStatePacket
  | DeviceSyncMsgReqPacket
  | DeviceSyncMsgChunkPacket
  | DeviceSyncAmailChunkPacket

/** Diff flags returned by CRDT merges between same-key devices */
export interface DeviceSyncMergeDiff {
  serversChanged: boolean
  serverOrderChanged?: boolean
  trustedChanged: boolean
  blockedChanged: boolean
  pinnedChanged: boolean
  dmClearedChanged: boolean
  lud16Changed: boolean
  nicknameChanged: boolean
  peerNotesChanged: boolean
  dmPeerNamesChanged: boolean
  devicesChanged?: boolean
  itemsUpdated: number
}

/** Persisted local CRDT journal + sync settings (under `agnostr:v2:` prefix) */
export interface PersistedDeviceSyncState {
  enabled: boolean
  ownerPubkey: string | null
  stateRevision: number
  lastSyncedAt: number | null
  crdt: DeviceSyncCrdtState
  linkedDevices: LinkedDeviceInfo[]
}
