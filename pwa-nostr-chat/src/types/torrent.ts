import type { Event as NostrEvent } from 'nostr-tools'

export type TorrentShareScope = 'dm' | 'server' | 'channel'

export type TorrentShareStatus = 'active' | 'closed'

export type TorrentTransport = 'webrtc' | 'ble-mesh'

export interface TorrentMeshBridge {
  isMeshAvailable: () => boolean
  isOfflineMeshOnly: () => boolean
  sendEvent: (event: NostrEvent) => Promise<boolean>
  subscribe: (listener: (event: NostrEvent) => void) => () => void
}

export type TorrentTransferPhase =
  | 'idle'
  | 'checking'
  | 'waiting'
  | 'connecting'
  | 'downloading'
  | 'verifying'
  | 'completed'
  | 'seeding'
  | 'closed'
  | 'error'

export interface TorrentEncryption {
  alg: 'aes-gcm-256'
  /** 32-byte base64url AES-256-GCM key */
  keyB64: string
  /** 8-byte base64url deterministic per-file nonce prefix (combined with 4-byte big-endian pieceIndex) */
  noncePrefixB64: string
}

export interface TorrentAttachment {
  v: 1
  /** 64-hex canonical infoHash binding file metadata + piece Merkle root + plaintext hash */
  infoHash: string
  /** 32-hex blinded swarm routing identifier derived from infoHash + fileKey */
  swarmId: string
  fileName: string
  mime: string
  size: number
  pieceLength: number
  pieceCount: number
  /** 64-hex SHA-256 of the entire decrypted file */
  plaintextSha256: string
  /** 64-hex binary Merkle root over encrypted piece SHA-256 digests */
  piecesRoot: string
  encryption: TorrentEncryption
  relays?: string[]
  senderPubkey?: string
  createdAt?: number
}

export interface TorrentShareRecord {
  infoHash: string
  swarmId: string
  fileName: string
  mime: string
  size: number
  pieceLength: number
  pieceCount: number
  plaintextSha256: string
  piecesRoot: string
  encryption: TorrentEncryption
  relays: string[]
  senderPubkey: string
  scope: TorrentShareScope
  targetLabel: string
  targetPeerPubkey?: string
  isEncryptedGroup?: boolean
  status: TorrentShareStatus
  hasLocalData: boolean
  createdAt: number
  closedAt?: number
  activePeerCount: number
  completedDownloads: number
  bytesUploaded: number
  isReSeed?: boolean
}

export interface TorrentTransferState {
  infoHash: string
  phase: TorrentTransferPhase
  transport?: TorrentTransport
  piecesCompleted: number
  pieceCount: number
  bytesTransferred: number
  totalBytes: number
  speedBytesPerSec: number
  connectedPeers: number
  completedAvailable: boolean
  isReSeeding: boolean
  error?: string
  updatedAt: number
}

export interface PendingTorrentDownloadRequest {
  torrent: TorrentAttachment
  senderPubkey: string
  senderNickname: string
  senderDisplayHandle: string
  senderNpub: string
}

export interface TorrentCreateScopeContext {
  scope: TorrentShareScope
  targetLabel: string
  targetPeerPubkey?: string
  isEncryptedGroup?: boolean
  extraRelays?: string[]
}

export interface TorrentEngine {
  shares: TorrentShareRecord[]
  activeShareCount: number
  transfers: Record<string, TorrentTransferState>
  closedBySender: Record<string, number>
  pendingDownloadRequest: PendingTorrentDownloadRequest | null
  sharesModalOpen: boolean
  setSharesModalOpen: (open: boolean) => void
  createAndSeedFile: (
    file: File,
    ctx: TorrentCreateScopeContext
  ) => Promise<TorrentAttachment | null>
  requestDownload: (
    torrent: TorrentAttachment,
    senderPubkey: string,
    senderNickname: string,
    senderDisplayHandle: string
  ) => void
  confirmPendingDownload: () => Promise<void>
  cancelPendingDownload: () => void
  cancelDownload: (infoHash: string) => void
  saveLocalFile: (infoHash: string) => Promise<boolean>
  closeShareDownloads: (infoHash: string) => Promise<void>
  reopenShareDownloads: (infoHash: string) => Promise<void>
  deleteShareLocalData: (infoHash: string) => Promise<void>
  stopReSeeding: (infoHash: string) => void
  resumeReSeeding: (infoHash: string) => Promise<boolean>
  removeDownloadedSeed: (infoHash: string) => Promise<boolean>
  checkRemoteStatus: (
    torrent: TorrentAttachment,
    senderPubkey: string
  ) => Promise<TorrentShareStatus>
  getShare: (infoHash: string) => TorrentShareRecord | undefined
}
