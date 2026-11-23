/* ==========================================================================
   Amail — E2EE Briar-Inspired Store-and-Forward Meshnet Snailmail Types
   ========================================================================== */

export type AmailFolder = 'inbox' | 'starred' | 'sent' | 'drafts' | 'archive' | 'trash'

export type AmailDeliveryStatus =
  | 'draft'
  | 'queued'
  | 'relayed'
  | 'delivered'
  | 'read'
  | 'expired'

export type AmailCapsuleSource = 'local' | 'webrtc-mesh' | 'ephemeral-mesh'

export interface AmailMessage {
  id: string
  threadId: string
  inReplyTo?: string
  folder: AmailFolder
  direction: 'in' | 'out'
  fromPubkey: string
  fromNpub: string
  fromName: string
  toPubkey: string
  toNpub: string
  toName: string
  subject: string
  body: string
  /** Unix seconds when composed/sent */
  sentAt: number
  /** Unix seconds when decrypted by recipient */
  receivedAt?: number
  /** Unix seconds when delivery ACK arrived (outgoing) */
  deliveredAt?: number
  /** Unix seconds when read receipt arrived (outgoing) or was emitted (incoming) */
  readAt?: number
  isRead: boolean
  isStarred: boolean
  requestReadReceipt: boolean
  deliveryStatus: AmailDeliveryStatus
  relayHopCount: number
  relayedPeerCount: number
  capsuleId?: string
  ttlSec: number
  /** Unix seconds when mesh relay propagation expires */
  expiresAt: number
  /** Unix ms for conflict-free multi-device sync */
  updatedAt: number
}

export interface AmailContact {
  pubkey: string
  npub: string
  nickname: string
  notes?: string
  addedAt: number
  updatedAt?: number
  isTrustedPeer?: boolean
}

/**
 * Sealed store-and-forward mesh capsule stored in the third-party relay vault.
 * Contains strictly ciphertext + blinded routing metadata (ZERO plaintext fields).
 */
export interface AmailSealedCapsule {
  capsuleId: string
  /** 12-char hex blinded routing hint: sha256('amail-dest:' + recipientPubkey).slice(0, 12) */
  recipientHint: string
  /** NIP-44 v2 ciphertext encrypted by senderPrivkey -> recipientPubkey */
  sealedPayload: string
  /** 64-hex sender pubkey required for NIP-44 decryption & Schnorr header verification */
  senderPubkey: string
  /** Schnorr signature over canonical header (prevents relayers tampering TTL/payload) */
  sig: string
  /** Unix seconds */
  createdAt: number
  /** Unix seconds */
  expiresAt: number
  hopCount: number
  maxHops: number
  sizeBytes: number
  receivedVia: AmailCapsuleSource
  /** Unix ms */
  storedAt: number
  relayedToCount: number
}

/**
 * Metadata-only summary exposed to the Mesh Relay & Storage Inspector UI.
 */
export type AmailRelayCapsuleMeta = Omit<
  AmailSealedCapsule,
  'sealedPayload' | 'sig' | 'senderPubkey'
>

/**
 * Signed delivery cancellation tombstone emitted by the recipient once a capsule
 * is decrypted. Couriers receiving a valid ACK immediately delete the ciphertext
 * capsule from their vault and stop propagating it until `expiresAt`.
 */
export interface AmailAckTombstone {
  capsuleId: string
  recipientHint: string
  /** Unix seconds */
  ackedAt: number
  /** Unix seconds */
  expiresAt: number
  sig: string
  pubkey: string
}

export interface AmailRelaySettings {
  relayEnabled: boolean
  sendReadReceipts: boolean
  maxVaultBytes: number
  maxHops: number
  defaultTtlSec: number
  maxMeshPeers: number
}

export const DEFAULT_AMAIL_RELAY_SETTINGS: AmailRelaySettings = {
  relayEnabled: true,
  sendReadReceipts: true,
  maxVaultBytes: 10 * 1024 * 1024, // 10 MB
  maxHops: 6,
  defaultTtlSec: 7 * 86_400, // 7 days
  maxMeshPeers: 4,
}

export interface AmailStorageStats {
  vaultBytes: number
  vaultLimitBytes: number
  vaultCapsuleCount: number
  mailBytes: number
  mailCount: number
  tombstoneCount: number
  contactCount: number
  totalRelayedOut: number
  totalDeliveredPurged: number
  totalExpiredPurged: number
}

export interface AmailMeshPeer {
  pubkey: string
  shortId: string
  transport: 'webrtc' | 'ephemeral'
  state: 'connecting' | 'connected'
  /** Unix ms */
  connectedAt: number
  /** Unix ms */
  lastSyncAt: number
  capsulesExchanged: number
}

export interface AmailSendInput {
  toPubkey: string
  subject: string
  body: string
  inReplyTo?: string
  threadId?: string
  requestReadReceipt?: boolean
  ttlSec?: number
  draftId?: string
}

export interface AmailDraftInput {
  id?: string
  toPubkey?: string
  subject: string
  body: string
  inReplyTo?: string
  threadId?: string
  requestReadReceipt?: boolean
  ttlSec?: number
}

export interface AmailSyncSnapshot {
  version: 1
  updatedAt: number
  messages: AmailMessage[]
  deletedMessageIds: Record<string, number>
  contacts: AmailContact[]
  removedContactPubkeys: Record<string, number>
  settings?: Partial<AmailRelaySettings>
}

export interface AmailEngine {
  messages: AmailMessage[]
  contacts: AmailContact[]
  unreadInboxCount: number
  relayCapsules: AmailRelayCapsuleMeta[]
  tombstonesCount: number
  meshPeers: AmailMeshPeer[]
  storageStats: AmailStorageStats
  settings: AmailRelaySettings
  isSyncing: boolean

  updateSettings: (patch: Partial<AmailRelaySettings>) => Promise<void>
  sendMail: (input: AmailSendInput) => Promise<AmailMessage | null>
  saveDraft: (draft: AmailDraftInput) => Promise<AmailMessage>
  deleteDraft: (id: string) => Promise<void>
  markRead: (id: string, isRead: boolean) => Promise<void>
  toggleStar: (id: string) => Promise<void>
  moveToFolder: (id: string, folder: AmailFolder) => Promise<void>
  deletePermanently: (id: string) => Promise<void>

  addContact: (
    pubkeyOrNpubOrDmLink: string,
    nickname?: string,
    notes?: string
  ) => Promise<AmailContact | null>
  updateContact: (
    pubkey: string,
    patch: { nickname?: string; notes?: string }
  ) => Promise<void>
  removeContact: (pubkey: string) => Promise<void>

  syncMeshNow: () => Promise<void>
  pruneExpired: () => Promise<number>
  purgeRelayVault: () => Promise<void>

  exportSyncState: () => AmailSyncSnapshot
  mergeSyncState: (remote: AmailSyncSnapshot) => Promise<boolean>
  resetAll: () => Promise<void>
}
