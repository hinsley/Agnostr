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
  online: boolean
}

/** Public engine surface exposed as `engine.deviceSync` */
export interface DeviceSyncEngine {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  deviceId: string
  deviceLabel: string
  linkedDevices: LinkedDeviceInfo[]
  onlineSiblingCount: number
  lastSyncedAt: number | null
  isSyncing: boolean
  syncedItemsCount: number
  syncNow: () => Promise<void>
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
  addedAt: number
  removedAt: number
}

/** LWW-Register for ordered Pinned Radio Channels */
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
  radio?: Record<string, GeoMessage[]>
}

/** Full conflict-free timestamped CRDT state exchanged between same-key devices */
export interface DeviceSyncCrdtState {
  v: 1
  servers: Record<string, SyncedServerRecord>
  trusted: Record<string, SyncedTrustedRecord>
  blocked: Record<string, SyncedBlockedRecord>
  pinned: SyncedPinnedState
  dmClearedAt: Record<string, number>
  lud16: SyncedLightningAddressState
  nickname: SyncedNicknameState
  amail?: SyncedAmailState | null
  recentMessages?: SyncedRecentMessagesTail
}

export type DeviceSyncMessageScopeKind = 'dm' | 'server' | 'radio'

export interface DeviceSyncScopeDigest {
  count: number
  latestTs: number
  hash: string
}

export interface DeviceSyncMsgDigests {
  dm: Record<string, DeviceSyncScopeDigest>
  server: Record<string, DeviceSyncScopeDigest>
  radio: Record<string, DeviceSyncScopeDigest>
  amail?: { updatedAt: number; hash: string } | null
}

export interface DeviceSyncScopeRequest {
  kind: DeviceSyncMessageScopeKind
  key: string
  knownIds: string[]
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

/** Persisted local CRDT journal + sync settings (under `agnostr:v2:` prefix) */
export interface PersistedDeviceSyncState {
  enabled: boolean
  ownerPubkey: string | null
  stateRevision: number
  lastSyncedAt: number | null
  crdt: DeviceSyncCrdtState
  linkedDevices: LinkedDeviceInfo[]
}
