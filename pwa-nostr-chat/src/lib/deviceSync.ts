import { sha256 } from '@noble/hashes/sha256'
import {
  finalizeEvent,
  nip44,
  type Event as NostrEvent,
  type EventTemplate,
  type VerifiedEvent,
} from 'nostr-tools'
import type {
  DeviceSyncAmailChunkPacket,
  DeviceSyncCrdtState,
  DeviceSyncHelloPacket,
  DeviceSyncMessageScopeKind,
  DeviceSyncMsgChunkPacket,
  DeviceSyncMsgDigests,
  DeviceSyncMsgReqPacket,
  DeviceSyncScopeDigest,
  DeviceSyncScopeRequest,
  DeviceSyncStatePacket,
  DeviceSyncWirePacket,
  SyncedBlockedRecord,
  SyncedPeerNoteRecord,
  SyncedRecentMessagesTail,
  SyncedServerRecord,
  SyncedTrustedRecord,
} from '../types/deviceSync.ts'
import type {
  DmMessage,
  DmProtocol,
  GeoMessage,
  PinnedChannel,
  TrustedPeerEntry,
} from '../types/protocol.ts'
import type { ServerMessage, ServerSummary } from '../types/servers.ts'
import { verifyEventCached } from './bitchatProtocol.ts'
import { normalizeGeohash } from './geohash.ts'
import { bytesToHex, encodeNpubSafe, type SigningKeyMaterial } from './identity.ts'
import { isValidRadioChannelKey, normalizeRadioChannelKey } from './radioChannel.ts'

/** Ephemeral Nostr kind for live silent sibling-device sync */
export const KIND_DEVICE_SYNC_EPHEMERAL = 25055

/** Replaceable Nostr kind (NIP-78 application-specific data) for offline catch-up checkpoints */
export const KIND_DEVICE_SYNC_CHECKPOINT = 30078

/** Shared tag for filtering device-sync events */
export const DEVICE_SYNC_TAG = 'agnostr-device-sync'

/** Replaceable `d` tag for the encrypted multi-device catch-up checkpoint */
export const DEVICE_SYNC_CHECKPOINT_D_TAG = 'agnostr-device-sync-v1'

/** Heartbeat cadence & online threshold */
export const DEVICE_SYNC_HELLO_INTERVAL_MS = 45_000
export const DEVICE_SYNC_ONLINE_TTL_MS = 120_000
export const DEVICE_SYNC_CHECKPOINT_DEBOUNCE_MS = 2_500

/** Strict upper bound per NIP-44 plaintext payload (< 48 KB, safely below NIP-44's 65,535-byte hard limit) */
export const MAX_NIP44_CHUNK_BYTES = 45_000

/** Max age for ephemeral kind:25055 packets (allows clock skew while preventing stale replays) */
export const MAX_EPHEMERAL_SYNC_AGE_SEC = 180

const utf8Encoder = new TextEncoder()

export function utf8ByteLength(str: string): number {
  return utf8Encoder.encode(str).length
}

export function isAutoAnonNickname(nick: string | null | undefined): boolean {
  const clean = (nick ?? '').trim()
  return !clean || /^anon[0-9a-f]{4}$/i.test(clean)
}

/** Concise human-friendly device label (e.g. "Chrome · macOS", "PWA · iPhone") */
export function detectDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Agnostr Device'
  const ua = navigator.userAgent || ''
  const isStandalone =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches ||
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone))

  let os = 'Desktop'
  if (/iPhone/i.test(ua)) os = 'iPhone'
  else if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) os = 'iPad'
  else if (/Android/i.test(ua)) os = 'Android'
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS'
  else if (/Windows/i.test(ua)) os = 'Windows'
  else if (/CrOS/i.test(ua)) os = 'ChromeOS'
  else if (/Linux/i.test(ua)) os = 'Linux'

  let app = 'Browser'
  if (isStandalone) app = 'PWA'
  else if (/Edg\//i.test(ua)) app = 'Edge'
  else if (/Firefox\//i.test(ua) || /FxiOS/i.test(ua)) app = 'Firefox'
  else if (/OPR\/|Opera/i.test(ua)) app = 'Opera'
  else if (/Chrome\/|CriOS/i.test(ua)) app = 'Chrome'
  else if (/Safari\//i.test(ua)) app = 'Safari'

  return `${app} · ${os}`
}

export function createEmptyCrdtState(): DeviceSyncCrdtState {
  return {
    v: 1,
    servers: {},
    trusted: {},
    blocked: {},
    pinned: { updatedAt: 0, items: [] },
    dmClearedAt: {},
    lud16: { value: null, updatedAt: 0 },
    nickname: { value: '', updatedAt: 0 },
    peerNotes: {},
  }
}

function sha256ShortHex(input: string): string {
  return bytesToHex(sha256(utf8Encoder.encode(input))).slice(0, 16)
}

function stripServerRuntimeCounts(server: ServerSummary): ServerSummary {
  return {
    ...server,
    channels: server.channels.map((c) => ({
      id: c.id,
      name: c.name,
      topic: c.topic,
    })),
    unreadCount: 0,
    mentionCount: 0,
  }
}

function areServersEqual(a: ServerSummary | undefined, b: ServerSummary | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return JSON.stringify(stripServerRuntimeCounts(a)) === JSON.stringify(stripServerRuntimeCounts(b))
}

function arePinnedListsEqual(a: readonly PinnedChannel[], b: readonly PinnedChannel[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].geohash !== b[i].geohash || (a[i].label ?? '') !== (b[i].label ?? '')) {
      return false
    }
  }
  return true
}

export interface LocalSyncSnapshot {
  joinedServers: ServerSummary[]
  trustedPubkeys: TrustedPeerEntry[]
  blockedPubkeys: string[]
  pinnedChannels: PinnedChannel[]
  dmClearedAt: Record<string, number>
  lightningAddress: string | null
  nickname: string
  peerNotes: Record<string, string>
}

/**
 * Reconciles current local app state into our timestamped CRDT journal.
 * When `isInitialSeed` is true (first time populating CRDT for this key), empty collections stay at
 * `updatedAt = 0` so a brand-new sibling device adopts existing remote state instead of overwriting it.
 */
export function reconcileLocalSnapshotIntoCrdt(
  prev: DeviceSyncCrdtState,
  snapshot: LocalSyncSnapshot,
  nowMs: number,
  isInitialSeed: boolean
): { crdt: DeviceSyncCrdtState; changed: boolean } {
  let changed = false

  // 1. Servers (LWW-Element-Set with leftAt tombstones)
  const nextServers: Record<string, SyncedServerRecord> = { ...prev.servers }
  const currentServerMap = new Map<string, ServerSummary>()
  for (const s of snapshot.joinedServers) {
    currentServerMap.set(s.id, stripServerRuntimeCounts(s))
  }

  for (const [id, cleanSummary] of currentServerMap.entries()) {
    const existing = nextServers[id]
    if (!existing || existing.leftAt >= existing.joinedAt) {
      const joinedAt = existing
        ? Math.max(nowMs, existing.leftAt + 1, cleanSummary.joinedAt || 0)
        : Math.max(cleanSummary.joinedAt || nowMs, 1)
      nextServers[id] = {
        id,
        joinedAt,
        leftAt: existing?.leftAt ?? 0,
        updatedAt: nowMs,
        summary: cleanSummary,
      }
      changed = true
    } else if (!areServersEqual(existing.summary, cleanSummary)) {
      nextServers[id] = {
        ...existing,
        updatedAt: Math.max(nowMs, existing.updatedAt + 1),
        summary: cleanSummary,
      }
      changed = true
    }
  }

  if (!isInitialSeed) {
    for (const [id, rec] of Object.entries(nextServers)) {
      if (rec.joinedAt > rec.leftAt && !currentServerMap.has(id)) {
        nextServers[id] = {
          id,
          joinedAt: rec.joinedAt,
          leftAt: Math.max(nowMs, rec.joinedAt + 1),
          updatedAt: nowMs,
          summary: undefined,
        }
        changed = true
      }
    }
  }

  // 2. Trusted Peers (LWW-Element-Set)
  const nextTrusted: Record<string, SyncedTrustedRecord> = { ...prev.trusted }
  const currentTrustedMap = new Map<string, TrustedPeerEntry>()
  for (const entry of snapshot.trustedPubkeys) {
    const pk = entry.pubkey.toLowerCase()
    if (/^[0-9a-f]{64}$/.test(pk)) {
      currentTrustedMap.set(pk, entry)
    }
  }

  for (const [pk, entry] of currentTrustedMap.entries()) {
    const existing = nextTrusted[pk]
    if (!existing || existing.removedAt >= existing.addedAt) {
      const addedAt = existing
        ? Math.max(nowMs, existing.removedAt + 1, entry.addedAt || 0)
        : Math.max(entry.addedAt || nowMs, 1)
      nextTrusted[pk] = {
        pubkey: pk,
        npub: entry.npub || encodeNpubSafe(pk),
        label: entry.label,
        addedAt,
        removedAt: existing?.removedAt ?? 0,
        updatedAt: nowMs,
      }
      changed = true
    } else if ((existing.label ?? '') !== (entry.label ?? '')) {
      nextTrusted[pk] = {
        ...existing,
        label: entry.label,
        updatedAt: Math.max(nowMs, existing.updatedAt + 1),
      }
      changed = true
    }
  }

  if (!isInitialSeed) {
    for (const [pk, rec] of Object.entries(nextTrusted)) {
      if (rec.addedAt > rec.removedAt && !currentTrustedMap.has(pk)) {
        nextTrusted[pk] = {
          ...rec,
          removedAt: Math.max(nowMs, rec.addedAt + 1),
          updatedAt: nowMs,
        }
        changed = true
      }
    }
  }

  // 3. Blocked Peers (LWW-Element-Set)
  const nextBlocked: Record<string, SyncedBlockedRecord> = { ...prev.blocked }
  const currentBlockedSet = new Set<string>()
  for (const raw of snapshot.blockedPubkeys) {
    const pk = raw.toLowerCase()
    if (/^[0-9a-f]{64}$/.test(pk)) currentBlockedSet.add(pk)
  }

  for (const pk of currentBlockedSet) {
    const existing = nextBlocked[pk]
    if (!existing || existing.removedAt >= existing.addedAt) {
      nextBlocked[pk] = {
        pubkey: pk,
        addedAt: existing ? Math.max(nowMs, existing.removedAt + 1) : nowMs,
        removedAt: existing?.removedAt ?? 0,
      }
      changed = true
    }
  }

  if (!isInitialSeed) {
    for (const [pk, rec] of Object.entries(nextBlocked)) {
      if (rec.addedAt > rec.removedAt && !currentBlockedSet.has(pk)) {
        nextBlocked[pk] = {
          pubkey: pk,
          addedAt: rec.addedAt,
          removedAt: Math.max(nowMs, rec.addedAt + 1),
        }
        changed = true
      }
    }
  }

  // 4. Pinned Radio Channels (LWW ordered list)
  let nextPinned = prev.pinned
  const cleanPinned: PinnedChannel[] = snapshot.pinnedChannels.map((c) => ({
    geohash: normalizeRadioChannelKey(c.geohash) ?? normalizeGeohash(c.geohash),
    label: c.label,
    pinnedAt: c.pinnedAt,
    unreadCount: 0,
    mentionCount: 0,
  }))
  if (!arePinnedListsEqual(prev.pinned.items, cleanPinned)) {
    const seededTs =
      isInitialSeed && cleanPinned.length === 0
        ? 0
        : isInitialSeed
          ? Math.max(
              1,
              ...cleanPinned.map((c) => (typeof c.pinnedAt === 'number' ? c.pinnedAt : nowMs))
            )
          : Math.max(nowMs, prev.pinned.updatedAt + 1)
    nextPinned = {
      updatedAt: seededTs,
      items: cleanPinned,
    }
    changed = true
  }

  // 5. DM Cleared-At tombstones (per-peer max timestamp)
  const nextDmCleared: Record<string, number> = { ...prev.dmClearedAt }
  for (const [rawPk, ts] of Object.entries(snapshot.dmClearedAt)) {
    const pk = rawPk.toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pk) || typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) {
      continue
    }
    const cleanTs = Math.floor(ts)
    if ((nextDmCleared[pk] ?? 0) < cleanTs) {
      nextDmCleared[pk] = cleanTs
      changed = true
    }
  }

  // 6. Lightning Address (`lud16`) LWW scalar
  let nextLud16 = prev.lud16
  const normalizedLud16 = snapshot.lightningAddress?.trim() || null
  if (normalizedLud16 !== prev.lud16.value) {
    const updatedAt =
      isInitialSeed && normalizedLud16 === null
        ? 0
        : Math.max(nowMs, prev.lud16.updatedAt + 1)
    nextLud16 = {
      value: normalizedLud16,
      updatedAt,
    }
    changed = true
  }

  // 7. Display Nickname LWW scalar (auto-generated anonXXXX stays at updatedAt = 0 on initial seed)
  let nextNickname = prev.nickname
  const cleanNick = snapshot.nickname.trim().slice(0, 32)
  if (cleanNick !== prev.nickname.value) {
    const updatedAt =
      isInitialSeed && isAutoAnonNickname(cleanNick)
        ? 0
        : Math.max(nowMs, prev.nickname.updatedAt + 1)
    nextNickname = {
      value: cleanNick,
      updatedAt,
    }
    changed = true
  }

  // 8. Private Peer Notes (LWW-Map with `text: ''` deletion tombstones)
  const nextPeerNotes: Record<string, SyncedPeerNoteRecord> = { ...(prev.peerNotes ?? {}) }
  const currentPeerNotesMap = new Map<string, string>()
  for (const [rawPk, rawText] of Object.entries(snapshot.peerNotes)) {
    const pk = rawPk.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pk) || typeof rawText !== 'string') continue
    const clean = rawText.trim().slice(0, 400)
    if (clean) {
      currentPeerNotesMap.set(pk, clean)
    }
  }

  for (const [pk, cleanText] of currentPeerNotesMap.entries()) {
    const existing = nextPeerNotes[pk]
    if (!existing || existing.text !== cleanText) {
      nextPeerNotes[pk] = {
        text: cleanText,
        updatedAt: Math.max(nowMs, (existing?.updatedAt ?? 0) + 1),
      }
      changed = true
    }
  }

  if (!isInitialSeed) {
    for (const [pk, rec] of Object.entries(nextPeerNotes)) {
      if (rec.text.length > 0 && !currentPeerNotesMap.has(pk)) {
        nextPeerNotes[pk] = {
          text: '',
          updatedAt: Math.max(nowMs, rec.updatedAt + 1),
        }
        changed = true
      }
    }
  }

  if (!changed) {
    return { crdt: prev, changed: false }
  }

  return {
    crdt: {
      v: 1,
      servers: nextServers,
      trusted: nextTrusted,
      blocked: nextBlocked,
      pinned: nextPinned,
      dmClearedAt: nextDmCleared,
      lud16: nextLud16,
      nickname: nextNickname,
      peerNotes: nextPeerNotes,
    },
    changed: true,
  }
}

export interface CrdtMergeDiff {
  serversChanged: boolean
  trustedChanged: boolean
  blockedChanged: boolean
  pinnedChanged: boolean
  dmClearedChanged: boolean
  lud16Changed: boolean
  nicknameChanged: boolean
  peerNotesChanged: boolean
  itemsUpdated: number
}

/**
 * Commutative, idempotent, conflict-free CRDT merge between two same-key devices.
 * Guarantees tombstones (`leftAt`, `removedAt`, `dmClearedAt`, empty peer note) win cleanly without resurrection.
 */
export function mergeCrdtStates(
  local: DeviceSyncCrdtState,
  remote: DeviceSyncCrdtState
): { merged: DeviceSyncCrdtState; changed: boolean; diff: CrdtMergeDiff } {
  const diff: CrdtMergeDiff = {
    serversChanged: false,
    trustedChanged: false,
    blockedChanged: false,
    pinnedChanged: false,
    dmClearedChanged: false,
    lud16Changed: false,
    nicknameChanged: false,
    peerNotesChanged: false,
    itemsUpdated: 0,
  }

  // 1. Merge Servers
  const mergedServers: Record<string, SyncedServerRecord> = {}
  const serverIds = new Set([...Object.keys(local.servers), ...Object.keys(remote.servers)])
  for (const id of serverIds) {
    const a = local.servers[id]
    const b = remote.servers[id]
    if (a && !b) {
      mergedServers[id] = a
      continue
    }
    if (!a && b) {
      mergedServers[id] = b
      diff.serversChanged = true
      diff.itemsUpdated += 1
      continue
    }
    if (!a || !b) continue

    const joinedAt = Math.max(a.joinedAt, b.joinedAt)
    const leftAt = Math.max(a.leftAt, b.leftAt)
    const updatedAt = Math.max(a.updatedAt, b.updatedAt)

    let summary: ServerSummary | undefined
    if (joinedAt > leftAt) {
      if (a.summary && !b.summary) {
        summary = a.summary
      } else if (!a.summary && b.summary) {
        summary = b.summary
      } else if (a.summary && b.summary) {
        const bWins =
          b.summary.rev > a.summary.rev ||
          (b.summary.rev === a.summary.rev && b.updatedAt > a.updatedAt)
        const winner = bWins ? b.summary : a.summary
        const fallback = bWins ? a.summary : b.summary
        summary = stripServerRuntimeCounts({
          ...winner,
          encryptionKeyB64: winner.encryptionKeyB64 ?? fallback.encryptionKeyB64,
        })
      }
    }

    const nextRec: SyncedServerRecord = {
      id,
      joinedAt,
      leftAt,
      updatedAt,
      summary,
    }
    mergedServers[id] = nextRec

    const wasActive = a.joinedAt > a.leftAt && Boolean(a.summary)
    const nowActive = joinedAt > leftAt && Boolean(summary)
    if (
      wasActive !== nowActive ||
      joinedAt !== a.joinedAt ||
      leftAt !== a.leftAt ||
      !areServersEqual(a.summary, summary)
    ) {
      diff.serversChanged = true
      diff.itemsUpdated += 1
    }
  }

  // 2. Merge Blocked Peers
  const mergedBlocked: Record<string, SyncedBlockedRecord> = {}
  const blockedKeys = new Set([...Object.keys(local.blocked), ...Object.keys(remote.blocked)])
  for (const pk of blockedKeys) {
    const a = local.blocked[pk]
    const b = remote.blocked[pk]
    if (a && !b) {
      mergedBlocked[pk] = a
      continue
    }
    if (!a && b) {
      mergedBlocked[pk] = b
      diff.blockedChanged = true
      diff.itemsUpdated += 1
      continue
    }
    if (!a || !b) continue

    const addedAt = Math.max(a.addedAt, b.addedAt)
    const removedAt = Math.max(a.removedAt, b.removedAt)
    mergedBlocked[pk] = { pubkey: pk, addedAt, removedAt }
    if (addedAt !== a.addedAt || removedAt !== a.removedAt) {
      diff.blockedChanged = true
      diff.itemsUpdated += 1
    }
  }

  // 3. Merge Trusted Peers (respecting newer block events)
  const mergedTrusted: Record<string, SyncedTrustedRecord> = {}
  const trustedKeys = new Set([...Object.keys(local.trusted), ...Object.keys(remote.trusted)])
  for (const pk of trustedKeys) {
    const a = local.trusted[pk]
    const b = remote.trusted[pk]
    if (a && !b) {
      mergedTrusted[pk] = a
      continue
    }
    if (!a && b) {
      mergedTrusted[pk] = b
      diff.trustedChanged = true
      diff.itemsUpdated += 1
      continue
    }
    if (!a || !b) continue

    const addedAt = Math.max(a.addedAt, b.addedAt)
    const removedAt = Math.max(a.removedAt, b.removedAt)
    const updatedAt = Math.max(a.updatedAt, b.updatedAt)
    const label =
      b.updatedAt > a.updatedAt ? (b.label ?? a.label) : (a.label ?? b.label)
    const npub = a.npub || b.npub || encodeNpubSafe(pk)

    mergedTrusted[pk] = { pubkey: pk, npub, label, addedAt, removedAt, updatedAt }
    if (
      addedAt !== a.addedAt ||
      removedAt !== a.removedAt ||
      (label ?? '') !== (a.label ?? '')
    ) {
      diff.trustedChanged = true
      diff.itemsUpdated += 1
    }
  }

  // If a peer is actively blocked at a timestamp >= their trust timestamp, ensure untrusted locally
  for (const [pk, bRec] of Object.entries(mergedBlocked)) {
    if (bRec.addedAt > bRec.removedAt) {
      const tRec = mergedTrusted[pk]
      if (tRec && tRec.addedAt > tRec.removedAt && bRec.addedAt >= tRec.addedAt) {
        mergedTrusted[pk] = {
          ...tRec,
          removedAt: Math.max(tRec.removedAt, bRec.addedAt),
        }
        diff.trustedChanged = true
      }
    }
  }

  // 4. Merge Pinned Radio Channels (LWW ordered list)
  let mergedPinned = local.pinned
  if (
    remote.pinned.updatedAt > local.pinned.updatedAt ||
    (remote.pinned.updatedAt === local.pinned.updatedAt &&
      remote.pinned.updatedAt > 0 &&
      JSON.stringify(remote.pinned.items) > JSON.stringify(local.pinned.items))
  ) {
    mergedPinned = {
      updatedAt: remote.pinned.updatedAt,
      items: remote.pinned.items.map((c) => ({
        geohash: normalizeRadioChannelKey(c.geohash) ?? normalizeGeohash(c.geohash),
        label: c.label,
        pinnedAt: c.pinnedAt,
        unreadCount: 0,
        mentionCount: 0,
      })),
    }
    if (!arePinnedListsEqual(local.pinned.items, mergedPinned.items)) {
      diff.pinnedChanged = true
      diff.itemsUpdated += 1
    }
  }

  // 5. Merge DM Cleared-At Tombstones (per-peer max)
  const mergedDmCleared: Record<string, number> = { ...local.dmClearedAt }
  for (const [rawPk, ts] of Object.entries(remote.dmClearedAt)) {
    const pk = rawPk.toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pk) || typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) {
      continue
    }
    const cleanTs = Math.floor(ts)
    if ((mergedDmCleared[pk] ?? 0) < cleanTs) {
      mergedDmCleared[pk] = cleanTs
      diff.dmClearedChanged = true
      diff.itemsUpdated += 1
    }
  }

  // 6. Merge Lightning Address (`lud16`) LWW scalar
  let mergedLud16 = local.lud16
  if (
    remote.lud16.updatedAt > local.lud16.updatedAt ||
    (remote.lud16.updatedAt === local.lud16.updatedAt &&
      remote.lud16.value !== null &&
      local.lud16.value === null)
  ) {
    mergedLud16 = { ...remote.lud16 }
    if (mergedLud16.value !== local.lud16.value) {
      diff.lud16Changed = true
      diff.itemsUpdated += 1
    }
  }

  // 7. Merge Display Nickname LWW scalar
  let mergedNickname = local.nickname
  if (
    remote.nickname.updatedAt > local.nickname.updatedAt &&
    remote.nickname.value.trim().length > 0
  ) {
    mergedNickname = {
      value: remote.nickname.value.trim().slice(0, 32),
      updatedAt: remote.nickname.updatedAt,
    }
    if (mergedNickname.value !== local.nickname.value) {
      diff.nicknameChanged = true
      diff.itemsUpdated += 1
    }
  }

  // 8. Merge Private Peer Notes (LWW per pubkey with deterministic tie-break)
  const localNotes = local.peerNotes ?? {}
  const remoteNotes = remote.peerNotes ?? {}
  const mergedPeerNotes: Record<string, SyncedPeerNoteRecord> = {}
  const noteKeys = new Set([...Object.keys(localNotes), ...Object.keys(remoteNotes)])
  for (const rawPk of noteKeys) {
    const pk = rawPk.toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pk)) continue
    const a = localNotes[rawPk]
    const b = remoteNotes[rawPk]
    if (a && !b) {
      mergedPeerNotes[pk] = a
      continue
    }
    if (!a && b) {
      mergedPeerNotes[pk] = b
      diff.peerNotesChanged = true
      diff.itemsUpdated += 1
      continue
    }
    if (!a || !b) continue

    const bWins =
      b.updatedAt > a.updatedAt ||
      (b.updatedAt === a.updatedAt && b.text > a.text)
    const winner = bWins ? b : a
    mergedPeerNotes[pk] = winner
    if (winner.text !== a.text || winner.updatedAt !== a.updatedAt) {
      diff.peerNotesChanged = true
      diff.itemsUpdated += 1
    }
  }

  const changed =
    diff.serversChanged ||
    diff.trustedChanged ||
    diff.blockedChanged ||
    diff.pinnedChanged ||
    diff.dmClearedChanged ||
    diff.lud16Changed ||
    diff.nicknameChanged ||
    diff.peerNotesChanged

  return {
    merged: {
      v: 1,
      servers: mergedServers,
      trusted: mergedTrusted,
      blocked: mergedBlocked,
      pinned: mergedPinned,
      dmClearedAt: mergedDmCleared,
      lud16: mergedLud16,
      nickname: mergedNickname,
      peerNotes: mergedPeerNotes,
    },
    changed,
    diff,
  }
}

export function extractActiveServers(crdt: DeviceSyncCrdtState): ServerSummary[] {
  return Object.values(crdt.servers)
    .filter((r): r is SyncedServerRecord & { summary: ServerSummary } => r.joinedAt > r.leftAt && Boolean(r.summary))
    .sort((a, b) => b.joinedAt - a.joinedAt)
    .map((r) => r.summary)
}

export function extractActiveTrusted(crdt: DeviceSyncCrdtState): TrustedPeerEntry[] {
  return Object.values(crdt.trusted)
    .filter((r) => r.addedAt > r.removedAt)
    .sort((a, b) => b.addedAt - a.addedAt)
    .map((r) => ({
      pubkey: r.pubkey,
      npub: r.npub || encodeNpubSafe(r.pubkey),
      label: r.label,
      addedAt: r.addedAt,
    }))
}

export function extractActiveBlocked(crdt: DeviceSyncCrdtState): string[] {
  return Object.values(crdt.blocked)
    .filter((r) => r.addedAt > r.removedAt)
    .sort((a, b) => a.pubkey.localeCompare(b.pubkey))
    .map((r) => r.pubkey)
}

export function extractActivePeerNotes(crdt: DeviceSyncCrdtState): Record<string, string> {
  const out: Record<string, string> = {}
  const entries = Object.entries(crdt.peerNotes ?? {})
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
  let count = 0
  for (const [rawPk, rec] of entries) {
    if (count >= 500) break
    const pk = rawPk.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pk) || typeof rec?.text !== 'string') continue
    const clean = rec.text.trim().slice(0, 400)
    if (!clean) continue
    out[pk] = clean
    count += 1
  }
  return out
}

export function computeCrdtStateHash(crdt: DeviceSyncCrdtState): string {
  const notes = crdt.peerNotes ?? {}
  const canonical = {
    servers: Object.keys(crdt.servers)
      .sort()
      .map((k) => {
        const s = crdt.servers[k]
        return [
          k,
          s.joinedAt,
          s.leftAt,
          s.summary?.rev ?? 0,
          s.summary?.name ?? '',
          s.summary?.channels.map((c) => c.id).join(',') ?? '',
          s.summary?.moderators.join(',') ?? '',
          s.summary?.bannedPubkeys.join(',') ?? '',
        ]
      }),
    trusted: Object.keys(crdt.trusted)
      .sort()
      .map((k) => {
        const t = crdt.trusted[k]
        return [k, t.addedAt, t.removedAt, t.label ?? '']
      }),
    blocked: Object.keys(crdt.blocked)
      .sort()
      .map((k) => {
        const b = crdt.blocked[k]
        return [k, b.addedAt, b.removedAt]
      }),
    pinned: [crdt.pinned.updatedAt, crdt.pinned.items.map((p) => `${p.geohash}:${p.label ?? ''}`)],
    dmClearedAt: Object.keys(crdt.dmClearedAt)
      .sort()
      .map((k) => [k, crdt.dmClearedAt[k]]),
    lud16: [crdt.lud16.updatedAt, crdt.lud16.value ?? ''],
    nickname: [crdt.nickname.updatedAt, crdt.nickname.value],
    peerNotes: Object.keys(notes)
      .sort()
      .map((k) => [k, notes[k].updatedAt, notes[k].text]),
  }
  return sha256ShortHex(JSON.stringify(canonical))
}

export function computeScopeDigest(
  messages: ReadonlyArray<{ id: string; createdAt: number }>
): DeviceSyncScopeDigest {
  let latestTs = 0
  const ids: string[] = []
  for (const m of messages) {
    if (!m.id) continue
    ids.push(m.id)
    if (m.createdAt > latestTs) latestTs = m.createdAt
  }
  ids.sort()
  return {
    count: ids.length,
    latestTs,
    hash: ids.length === 0 ? 'empty' : sha256ShortHex(ids.join('|')),
  }
}

export function computeJsonDigest(value: unknown): string {
  try {
    return sha256ShortHex(JSON.stringify(value) ?? '')
  } catch {
    return 'err'
  }
}

/**
 * Fits a CRDT checkpoint (plus optional Amail snapshot & bounded recent messages tail)
 * strictly within `MAX_NIP44_CHUNK_BYTES` so NIP-44 encryption can never overflow.
 */
export function fitCheckpointStateWithinBudget(
  crdt: DeviceSyncCrdtState,
  amailSnapshot: { updatedAt: number; hash: string; payload: unknown } | null,
  recentMessages?: SyncedRecentMessagesTail,
  maxBytes = MAX_NIP44_CHUNK_BYTES
): DeviceSyncCrdtState {
  const base: DeviceSyncCrdtState = {
    v: 1,
    servers: crdt.servers,
    trusted: crdt.trusted,
    blocked: crdt.blocked,
    pinned: crdt.pinned,
    dmClearedAt: crdt.dmClearedAt,
    lud16: crdt.lud16,
    nickname: crdt.nickname,
    peerNotes: crdt.peerNotes ?? {},
  }

  let candidate: DeviceSyncCrdtState = {
    ...base,
    ...(amailSnapshot ? { amail: amailSnapshot } : {}),
    ...(recentMessages ? { recentMessages } : {}),
  }
  if (utf8ByteLength(JSON.stringify(candidate)) <= maxBytes) {
    return candidate
  }

  // Step 1: Trim recentMessages to compact recent slice if oversized
  if (recentMessages) {
    const trimmedTail: SyncedRecentMessagesTail = {}
    if (recentMessages.dm) {
      trimmedTail.dm = {}
      for (const [pk, entry] of Object.entries(recentMessages.dm).slice(0, 8)) {
        trimmedTail.dm[pk] = {
          peerNickname: entry.peerNickname,
          protocol: entry.protocol,
          messages: entry.messages.slice(-8),
        }
      }
    }
    if (recentMessages.server) {
      trimmedTail.server = {}
      for (const [k, msgs] of Object.entries(recentMessages.server).slice(0, 8)) {
        trimmedTail.server[k] = msgs.slice(-8)
      }
    }
    if (recentMessages.radio) {
      trimmedTail.radio = {}
      for (const [k, msgs] of Object.entries(recentMessages.radio).slice(0, 6)) {
        trimmedTail.radio[k] = msgs.slice(-8)
      }
    }
    candidate = {
      ...base,
      ...(amailSnapshot ? { amail: amailSnapshot } : {}),
      recentMessages: trimmedTail,
    }
    if (utf8ByteLength(JSON.stringify(candidate)) <= maxBytes) {
      return candidate
    }
  }

  // Step 2: Keep CRDT + Amail (omit recentMessages; live sibling sync will transfer full deltas)
  if (amailSnapshot) {
    candidate = { ...base, amail: amailSnapshot }
    if (utf8ByteLength(JSON.stringify(candidate)) <= maxBytes) {
      return candidate
    }
  }

  // Step 3: Keep CRDT + recentMessages without Amail (Amail transfers via chunked sync-amail-chunk)
  if (recentMessages) {
    const tinyTail: SyncedRecentMessagesTail = {}
    if (recentMessages.dm) {
      tinyTail.dm = {}
      for (const [pk, entry] of Object.entries(recentMessages.dm).slice(0, 5)) {
        tinyTail.dm[pk] = {
          peerNickname: entry.peerNickname,
          protocol: entry.protocol,
          messages: entry.messages.slice(-5),
        }
      }
    }
    candidate = { ...base, recentMessages: tinyTail }
    if (utf8ByteLength(JSON.stringify(candidate)) <= maxBytes) {
      return candidate
    }
  }

  // Step 4: Pure core CRDT state
  return base
}

/**
 * Packs missing messages into strictly `< 48 KB` NIP-44-safe `sync-msg-chunk` packets.
 */
export function buildMessageChunkPackets(params: {
  deviceId: string
  targetDeviceId: string
  scopeKind: DeviceSyncMessageScopeKind
  scopeKey: string
  peerMeta?: { peerNickname?: string; protocol?: DmProtocol }
  messages: Array<DmMessage | ServerMessage | GeoMessage>
  maxBytes?: number
}): DeviceSyncMsgChunkPacket[] {
  const maxBytes = params.maxBytes ?? MAX_NIP44_CHUNK_BYTES
  if (params.messages.length === 0) return []

  const groups: Array<Array<DmMessage | ServerMessage | GeoMessage>> = []
  let current: Array<DmMessage | ServerMessage | GeoMessage> = []

  const makeDraft = (
    slice: Array<DmMessage | ServerMessage | GeoMessage>,
    chunkIndex: number,
    totalChunks: number
  ): DeviceSyncMsgChunkPacket => ({
    v: 1,
    type: 'sync-msg-chunk',
    deviceId: params.deviceId,
    targetDeviceId: params.targetDeviceId,
    ts: Date.now(),
    chunkIndex,
    totalChunks,
    scopeKind: params.scopeKind,
    scopeKey: params.scopeKey,
    ...(params.peerMeta ? { peerMeta: params.peerMeta } : {}),
    messages: slice,
  })

  for (const msg of params.messages) {
    const candidate = [...current, msg]
    const draft = makeDraft(candidate, groups.length, groups.length + 1)
    if (utf8ByteLength(JSON.stringify(draft)) <= maxBytes) {
      current = candidate
      continue
    }
    if (current.length > 0) {
      groups.push(current)
      current = []
    }
    const singleDraft = makeDraft([msg], groups.length, groups.length + 1)
    if (utf8ByteLength(JSON.stringify(singleDraft)) <= maxBytes) {
      current = [msg]
    }
    // Single message exceeding 45 KB is skipped safely to avoid NIP-44 overflow
  }
  if (current.length > 0) {
    groups.push(current)
  }

  const totalChunks = groups.length
  return groups.map((slice, idx) => makeDraft(slice, idx, totalChunks))
}

/**
 * Splits a serialized Amail sync snapshot JSON string into `< 48 KB` NIP-44-safe chunk packets.
 */
export function buildAmailChunkPackets(params: {
  deviceId: string
  targetDeviceId: string
  transferId: string
  updatedAt: number
  hash: string
  payload: unknown
  maxChunkChars?: number
}): DeviceSyncAmailChunkPacket[] {
  const maxChunkChars = params.maxChunkChars ?? 28_000
  let serialized: string
  try {
    serialized = JSON.stringify(params.payload)
  } catch {
    return []
  }
  if (!serialized) return []

  const slices: string[] = []
  for (let i = 0; i < serialized.length; i += maxChunkChars) {
    slices.push(serialized.slice(i, i + maxChunkChars))
  }
  const totalChunks = slices.length
  const ts = Date.now()
  return slices.map((data, idx) => ({
    v: 1,
    type: 'sync-amail-chunk',
    deviceId: params.deviceId,
    targetDeviceId: params.targetDeviceId,
    ts,
    transferId: params.transferId,
    updatedAt: params.updatedAt,
    hash: params.hash,
    chunkIndex: idx,
    totalChunks,
    data,
  }))
}

/** Strictly NIP-44 v2 encrypt plaintext to our own master pubkey */
export async function encryptSelfPayload(
  plaintext: string,
  material: SigningKeyMaterial,
  allowExtensionPrompt = false
): Promise<string | null> {
  if (!material.pubkey || utf8ByteLength(plaintext) > 65_000) return null
  if (material.secretKey) {
    try {
      const convKey = nip44.v2.utils.getConversationKey(material.secretKey, material.pubkey)
      return nip44.v2.encrypt(plaintext, convKey)
    } catch {
      return null
    }
  }
  if (allowExtensionPrompt && material.mode === 'extension' && window.nostr?.nip44?.encrypt) {
    try {
      return await window.nostr.nip44.encrypt(material.pubkey, plaintext)
    } catch {
      return null
    }
  }
  return null
}

/** Strictly NIP-44 v2 decrypt self-encrypted ciphertext */
export async function decryptSelfPayload(
  ciphertext: string,
  material: SigningKeyMaterial,
  allowExtensionPrompt = false
): Promise<string | null> {
  if (!material.pubkey || !ciphertext) return null
  if (material.secretKey) {
    try {
      const convKey = nip44.v2.utils.getConversationKey(material.secretKey, material.pubkey)
      return nip44.v2.decrypt(ciphertext, convKey)
    } catch {
      return null
    }
  }
  if (allowExtensionPrompt && material.mode === 'extension' && window.nostr?.nip44?.decrypt) {
    try {
      return await window.nostr.nip44.decrypt(material.pubkey, ciphertext)
    } catch {
      return null
    }
  }
  return null
}

export async function buildSignedDeviceSyncEphemeralEvent(
  packet: DeviceSyncWirePacket,
  material: SigningKeyMaterial,
  allowExtensionPrompt = false
): Promise<VerifiedEvent | null> {
  const plaintext = JSON.stringify(packet)
  const ciphertext = await encryptSelfPayload(plaintext, material, allowExtensionPrompt)
  if (!ciphertext) return null

  const template: EventTemplate = {
    kind: KIND_DEVICE_SYNC_EPHEMERAL,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', material.pubkey.toLowerCase()],
      ['t', DEVICE_SYNC_TAG],
    ],
    content: ciphertext,
  }

  if (material.secretKey) {
    return finalizeEvent(template, material.secretKey)
  }
  if (allowExtensionPrompt && material.mode === 'extension' && window.nostr?.signEvent) {
    try {
      return await window.nostr.signEvent(template)
    } catch {
      return null
    }
  }
  return null
}

export async function buildSignedDeviceSyncCheckpointEvent(
  state: DeviceSyncCrdtState,
  material: SigningKeyMaterial,
  allowExtensionPrompt = false
): Promise<VerifiedEvent | null> {
  const plaintext = JSON.stringify(state)
  const ciphertext = await encryptSelfPayload(plaintext, material, allowExtensionPrompt)
  if (!ciphertext) return null

  const template: EventTemplate = {
    kind: KIND_DEVICE_SYNC_CHECKPOINT,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', DEVICE_SYNC_CHECKPOINT_D_TAG],
      ['t', DEVICE_SYNC_TAG],
    ],
    content: ciphertext,
  }

  if (material.secretKey) {
    return finalizeEvent(template, material.secretKey)
  }
  if (allowExtensionPrompt && material.mode === 'extension' && window.nostr?.signEvent) {
    try {
      return await window.nostr.signEvent(template)
    } catch {
      return null
    }
  }
  return null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

export function sanitizeRemoteCrdtState(raw: unknown): DeviceSyncCrdtState | null {
  if (!isRecord(raw) || raw.v !== 1) return null

  const servers: Record<string, SyncedServerRecord> = {}
  if (isRecord(raw.servers)) {
    for (const [id, val] of Object.entries(raw.servers)) {
      if (!id || !isRecord(val)) continue
      const joinedAt = typeof val.joinedAt === 'number' && Number.isFinite(val.joinedAt) ? val.joinedAt : 0
      const leftAt = typeof val.leftAt === 'number' && Number.isFinite(val.leftAt) ? val.leftAt : 0
      const updatedAt = typeof val.updatedAt === 'number' && Number.isFinite(val.updatedAt) ? val.updatedAt : 0
      let summary: ServerSummary | undefined
      if (joinedAt > leftAt && isRecord(val.summary)) {
        const s = val.summary as unknown as ServerSummary
        if (
          typeof s.id === 'string' &&
          s.id === id &&
          (s.kind === 'virtual' || s.kind === 'nip29') &&
          typeof s.name === 'string' &&
          Array.isArray(s.channels)
        ) {
          summary = stripServerRuntimeCounts(s)
        }
      }
      servers[id] = { id, joinedAt, leftAt, updatedAt, summary }
    }
  }

  const trusted: Record<string, SyncedTrustedRecord> = {}
  if (isRecord(raw.trusted)) {
    for (const [rawPk, val] of Object.entries(raw.trusted)) {
      const pk = rawPk.toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pk) || !isRecord(val)) continue
      const addedAt = typeof val.addedAt === 'number' && Number.isFinite(val.addedAt) ? val.addedAt : 0
      const removedAt = typeof val.removedAt === 'number' && Number.isFinite(val.removedAt) ? val.removedAt : 0
      const updatedAt = typeof val.updatedAt === 'number' && Number.isFinite(val.updatedAt) ? val.updatedAt : 0
      trusted[pk] = {
        pubkey: pk,
        npub: typeof val.npub === 'string' && val.npub.startsWith('npub1') ? val.npub : encodeNpubSafe(pk),
        label: typeof val.label === 'string' && val.label.trim() ? val.label.trim().slice(0, 48) : undefined,
        addedAt,
        removedAt,
        updatedAt,
      }
    }
  }

  const blocked: Record<string, SyncedBlockedRecord> = {}
  if (isRecord(raw.blocked)) {
    for (const [rawPk, val] of Object.entries(raw.blocked)) {
      const pk = rawPk.toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pk) || !isRecord(val)) continue
      const addedAt = typeof val.addedAt === 'number' && Number.isFinite(val.addedAt) ? val.addedAt : 0
      const removedAt = typeof val.removedAt === 'number' && Number.isFinite(val.removedAt) ? val.removedAt : 0
      blocked[pk] = { pubkey: pk, addedAt, removedAt }
    }
  }

  const pinnedItems: PinnedChannel[] = []
  let pinnedUpdatedAt = 0
  if (isRecord(raw.pinned)) {
    pinnedUpdatedAt =
      typeof raw.pinned.updatedAt === 'number' && Number.isFinite(raw.pinned.updatedAt)
        ? raw.pinned.updatedAt
        : 0
    if (Array.isArray(raw.pinned.items)) {
      const seen = new Set<string>()
      for (const item of raw.pinned.items) {
        if (!isRecord(item) || typeof item.geohash !== 'string' || !isValidRadioChannelKey(item.geohash)) {
          continue
        }
        const key = normalizeRadioChannelKey(item.geohash) ?? normalizeGeohash(item.geohash)
        if (seen.has(key)) continue
        seen.add(key)
        pinnedItems.push({
          geohash: key,
          label: typeof item.label === 'string' ? item.label.slice(0, 48) : undefined,
          pinnedAt: typeof item.pinnedAt === 'number' && Number.isFinite(item.pinnedAt) ? item.pinnedAt : Date.now(),
          unreadCount: 0,
          mentionCount: 0,
        })
      }
    }
  }

  const dmClearedAt: Record<string, number> = {}
  if (isRecord(raw.dmClearedAt)) {
    for (const [rawPk, val] of Object.entries(raw.dmClearedAt)) {
      const pk = rawPk.toLowerCase()
      if (/^[0-9a-f]{64}$/.test(pk) && typeof val === 'number' && Number.isFinite(val) && val > 0) {
        dmClearedAt[pk] = Math.floor(val)
      }
    }
  }

  const lud16 = isRecord(raw.lud16)
    ? {
        value: typeof raw.lud16.value === 'string' && raw.lud16.value.trim() ? raw.lud16.value.trim() : null,
        updatedAt:
          typeof raw.lud16.updatedAt === 'number' && Number.isFinite(raw.lud16.updatedAt)
            ? raw.lud16.updatedAt
            : 0,
      }
    : { value: null, updatedAt: 0 }

  const nickname = isRecord(raw.nickname)
    ? {
        value: typeof raw.nickname.value === 'string' ? raw.nickname.value.trim().slice(0, 32) : '',
        updatedAt:
          typeof raw.nickname.updatedAt === 'number' && Number.isFinite(raw.nickname.updatedAt)
            ? raw.nickname.updatedAt
            : 0,
      }
    : { value: '', updatedAt: 0 }

  const peerNotes: Record<string, SyncedPeerNoteRecord> = {}
  if (isRecord(raw.peerNotes)) {
    let count = 0
    for (const [rawPk, val] of Object.entries(raw.peerNotes)) {
      if (count >= 500) break
      const pk = rawPk.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pk) || !isRecord(val)) continue
      const text = typeof val.text === 'string' ? val.text.trim().slice(0, 400) : ''
      const updatedAt =
        typeof val.updatedAt === 'number' && Number.isFinite(val.updatedAt) ? val.updatedAt : 0
      peerNotes[pk] = { text, updatedAt }
      count += 1
    }
  }

  let amail: DeviceSyncCrdtState['amail'] = undefined
  if (isRecord(raw.amail) && typeof raw.amail.hash === 'string') {
    amail = {
      updatedAt:
        typeof raw.amail.updatedAt === 'number' && Number.isFinite(raw.amail.updatedAt)
          ? raw.amail.updatedAt
          : 0,
      hash: raw.amail.hash,
      payload: raw.amail.payload,
    }
  }

  let recentMessages: SyncedRecentMessagesTail | undefined
  if (isRecord(raw.recentMessages)) {
    recentMessages = raw.recentMessages as SyncedRecentMessagesTail
  }

  return {
    v: 1,
    servers,
    trusted,
    blocked,
    pinned: { updatedAt: pinnedUpdatedAt, items: pinnedItems },
    dmClearedAt,
    lud16,
    nickname,
    peerNotes,
    ...(amail ? { amail } : {}),
    ...(recentMessages ? { recentMessages } : {}),
  }
}

export async function parseDeviceSyncEphemeralEvent(
  ev: NostrEvent,
  material: SigningKeyMaterial,
  allowExtensionPrompt = false
): Promise<DeviceSyncWirePacket | null> {
  if (ev.kind !== KIND_DEVICE_SYNC_EPHEMERAL) return null
  if (ev.pubkey.toLowerCase() !== material.pubkey.toLowerCase()) return null
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - ev.created_at) > MAX_EPHEMERAL_SYNC_AGE_SEC) return null
  if (!verifyEventCached(ev)) return null

  const plaintext = await decryptSelfPayload(ev.content, material, allowExtensionPrompt)
  if (!plaintext) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.deviceId !== 'string' || !parsed.deviceId) {
    return null
  }

  switch (parsed.type) {
    case 'sync-hello': {
      if (
        typeof parsed.deviceLabel !== 'string' ||
        typeof parsed.stateHash !== 'string' ||
        !isRecord(parsed.msgDigests)
      ) {
        return null
      }
      const digests = parsed.msgDigests as unknown as DeviceSyncMsgDigests
      return {
        v: 1,
        type: 'sync-hello',
        deviceId: parsed.deviceId,
        deviceLabel: parsed.deviceLabel.slice(0, 48),
        nickname: typeof parsed.nickname === 'string' ? parsed.nickname.slice(0, 32) : '',
        ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now(),
        stateRevision: typeof parsed.stateRevision === 'number' ? parsed.stateRevision : 0,
        stateHash: parsed.stateHash,
        msgDigests: {
          dm: isRecord(digests.dm) ? digests.dm : {},
          server: isRecord(digests.server) ? digests.server : {},
          radio: isRecord(digests.radio) ? digests.radio : {},
          amail:
            isRecord(digests.amail) && typeof digests.amail.hash === 'string'
              ? {
                  updatedAt: typeof digests.amail.updatedAt === 'number' ? digests.amail.updatedAt : 0,
                  hash: digests.amail.hash,
                }
              : null,
        },
      } satisfies DeviceSyncHelloPacket
    }

    case 'sync-state': {
      const state = sanitizeRemoteCrdtState(parsed.state)
      if (!state) return null
      return {
        v: 1,
        type: 'sync-state',
        deviceId: parsed.deviceId,
        deviceLabel: typeof parsed.deviceLabel === 'string' ? parsed.deviceLabel.slice(0, 48) : 'Sibling Device',
        nickname: typeof parsed.nickname === 'string' ? parsed.nickname.slice(0, 32) : '',
        targetDeviceId: typeof parsed.targetDeviceId === 'string' ? parsed.targetDeviceId : undefined,
        ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now(),
        state,
      } satisfies DeviceSyncStatePacket
    }

    case 'sync-msg-req': {
      if (typeof parsed.targetDeviceId !== 'string' || !Array.isArray(parsed.scopes)) return null
      const scopes: DeviceSyncScopeRequest[] = []
      for (const s of parsed.scopes) {
        if (!isRecord(s) || typeof s.key !== 'string' || !Array.isArray(s.knownIds)) continue
        if (s.kind !== 'dm' && s.kind !== 'server' && s.kind !== 'radio') continue
        scopes.push({
          kind: s.kind,
          key: s.key,
          knownIds: s.knownIds.filter((id): id is string => typeof id === 'string').slice(0, 250),
          sinceSec: typeof s.sinceSec === 'number' ? s.sinceSec : undefined,
        })
      }
      return {
        v: 1,
        type: 'sync-msg-req',
        deviceId: parsed.deviceId,
        targetDeviceId: parsed.targetDeviceId,
        ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now(),
        scopes,
        wantAmail: Boolean(parsed.wantAmail),
      } satisfies DeviceSyncMsgReqPacket
    }

    case 'sync-msg-chunk': {
      if (
        typeof parsed.targetDeviceId !== 'string' ||
        typeof parsed.scopeKey !== 'string' ||
        (parsed.scopeKind !== 'dm' && parsed.scopeKind !== 'server' && parsed.scopeKind !== 'radio') ||
        !Array.isArray(parsed.messages)
      ) {
        return null
      }
      return {
        v: 1,
        type: 'sync-msg-chunk',
        deviceId: parsed.deviceId,
        targetDeviceId: parsed.targetDeviceId,
        ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now(),
        chunkIndex: typeof parsed.chunkIndex === 'number' ? parsed.chunkIndex : 0,
        totalChunks: typeof parsed.totalChunks === 'number' ? parsed.totalChunks : 1,
        scopeKind: parsed.scopeKind,
        scopeKey: parsed.scopeKey,
        peerMeta: isRecord(parsed.peerMeta)
          ? {
              peerNickname:
                typeof parsed.peerMeta.peerNickname === 'string'
                  ? parsed.peerMeta.peerNickname.slice(0, 32)
                  : undefined,
              protocol:
                parsed.peerMeta.protocol === 'bitchat' || parsed.peerMeta.protocol === 'nip17'
                  ? parsed.peerMeta.protocol
                  : undefined,
            }
          : undefined,
        messages: parsed.messages as Array<DmMessage | ServerMessage | GeoMessage>,
      } satisfies DeviceSyncMsgChunkPacket
    }

    case 'sync-amail-chunk': {
      if (
        typeof parsed.targetDeviceId !== 'string' ||
        typeof parsed.transferId !== 'string' ||
        typeof parsed.hash !== 'string' ||
        typeof parsed.data !== 'string' ||
        typeof parsed.chunkIndex !== 'number' ||
        typeof parsed.totalChunks !== 'number'
      ) {
        return null
      }
      return {
        v: 1,
        type: 'sync-amail-chunk',
        deviceId: parsed.deviceId,
        targetDeviceId: parsed.targetDeviceId,
        ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now(),
        transferId: parsed.transferId,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
        hash: parsed.hash,
        chunkIndex: parsed.chunkIndex,
        totalChunks: parsed.totalChunks,
        data: parsed.data,
      } satisfies DeviceSyncAmailChunkPacket
    }

    default:
      return null
  }
}

export async function parseDeviceSyncCheckpointEvent(
  ev: NostrEvent,
  material: SigningKeyMaterial,
  allowExtensionPrompt = false
): Promise<DeviceSyncCrdtState | null> {
  if (ev.kind !== KIND_DEVICE_SYNC_CHECKPOINT) return null
  if (ev.pubkey.toLowerCase() !== material.pubkey.toLowerCase()) return null
  const hasDTag = ev.tags.some(
    (t) => t[0] === 'd' && t[1] === DEVICE_SYNC_CHECKPOINT_D_TAG
  )
  if (!hasDTag) return null
  if (!verifyEventCached(ev)) return null

  const plaintext = await decryptSelfPayload(ev.content, material, allowExtensionPrompt)
  if (!plaintext) return null

  try {
    const parsed: unknown = JSON.parse(plaintext)
    return sanitizeRemoteCrdtState(parsed)
  } catch {
    return null
  }
}
