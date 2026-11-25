import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Event as NostrEvent } from 'nostr-tools'
import type {
  AmailSyncProvider,
  DeviceSyncCrdtState,
  DeviceSyncEngine,
  DeviceSyncHelloPacket,
  DeviceSyncMsgDigests,
  DeviceSyncMsgReqPacket,
  DeviceSyncScopeDigest,
  DeviceSyncScopeRequest,
  DeviceSyncStatePacket,
  DeviceSyncWirePacket,
  LinkedDeviceInfo,
  SyncedDeviceRecord,
  SyncedDmPeerNameRecord,
  SyncedRecentMessagesTail,
} from '../types/deviceSync.ts'
import type {
  DmMessage,
  DmProtocol,
  DmThread,
  GeoMessage,
  PinnedChannel,
  TrustedPeerEntry,
} from '../types/protocol.ts'
import type { ServerMessage, ServerSummary } from '../types/servers.ts'
import {
  buildAmailChunkPackets,
  buildMessageChunkPackets,
  buildMessageRequestPackets,
  buildSignedDeviceSyncCheckpointEvent,
  buildSignedDeviceSyncEphemeralEvent,
  computeCrdtStateHash,
  computeJsonDigest,
  computeDmMessageVersion,
  computeDmScopeDigest,
  computeScopeDigest,
  createEmptyCrdtState,
  detectDeviceLabel,
  DEVICE_SYNC_CHECKPOINT_D_TAG,
  DEVICE_SYNC_CHECKPOINT_DEBOUNCE_MS,
  DEVICE_SYNC_HELLO_INTERVAL_MS,
  DEVICE_SYNC_ONLINE_TTL_MS,
  DEVICE_SYNC_TAG,
  extractActiveBlocked,
  extractActiveBlockedPeerNames,
  extractActiveDmPeerNames,
  extractActivePeerNotes,
  extractActiveServers,
  extractActiveSyncedDevices,
  extractActiveTrusted,
  fitCheckpointStateWithinBudget,
  isAutoAnonNickname,
  KIND_DEVICE_SYNC_CHECKPOINT,
  KIND_DEVICE_SYNC_EPHEMERAL,
  MAX_NIP44_CHUNK_BYTES,
  MAX_SYNCED_DEVICES,
  mergeCrdtStates,
  parseDeviceSyncCheckpointEvent,
  parseDeviceSyncEphemeralEvent,
  reconcileLocalSnapshotIntoCrdt,
  sanitizeSyncedDevicesMap,
  utf8ByteLength,
  type LocalSyncSnapshot,
} from '../lib/deviceSync.ts'
import type { IdentityManager } from '../lib/identity.ts'
import type { RelayPool } from '../lib/relayPool.ts'
import {
  clearDeviceSyncState,
  isEphemeralPendingMessage,
  isStuckMediaPlaceholder,
  loadChannelMessages,
  loadCustomDeviceLabel,
  loadDeviceSyncState,
  loadOrCreateDeviceId,
  loadServerChannelMessages,
  resetDeviceId,
  saveCustomDeviceLabel,
  saveDeviceSyncState,
} from '../lib/storage.ts'

export function encodeServerScopeKey(serverId: string, channelId: string): string {
  return `${encodeURIComponent(serverId)}|${encodeURIComponent(channelId)}`
}

export function decodeServerScopeKey(
  scopeKey: string
): { serverId: string; channelId: string } | null {
  const idx = scopeKey.indexOf('|')
  if (idx <= 0 || idx >= scopeKey.length - 1) return null
  try {
    const serverId = decodeURIComponent(scopeKey.slice(0, idx))
    const channelId = decodeURIComponent(scopeKey.slice(idx + 1))
    if (!serverId || !channelId) return null
    return { serverId, channelId }
  } catch {
    return null
  }
}

export interface UseDeviceSyncOptions {
  relayPool: RelayPool
  identityManager: IdentityManager
  identityVersion: number
  masterPubkey: string
  nickname: string
  getSyncRelayUrls: () => string[]
  joinedServers: ServerSummary[]
  trustedPubkeys: TrustedPeerEntry[]
  blockedPubkeys: string[]
  blockedPeerNames?: Record<string, string>
  pinnedChannels: PinnedChannel[]
  dmClearedAt: Record<string, number>
  lightningAddress: string | null
  peerNotes: Record<string, string>
  dmThreads: DmThread[]
  activeGeohash: string
  activeBitchatMessages: GeoMessage[]
  activeServerMessages: ServerMessage[]
  initialHealCheckpoint?: boolean
  onApplyServers: (servers: ServerSummary[]) => void
  onApplyTrusted: (trusted: TrustedPeerEntry[]) => void
  onApplyBlocked: (blocked: string[], blockedNames?: Record<string, string>) => void
  onApplyPinned: (pinned: PinnedChannel[]) => void
  onApplyDmClearedAt: (clearedAt: Record<string, number>) => number
  onApplyLightningAddress: (addr: string | null) => void
  onApplyNickname: (nick: string) => void
  onApplyPeerNotes: (notes: Record<string, string>) => void
  onApplyDmPeerNames: (namesByPubkey: Record<string, string>) => void
  onMergeDmMessages: (
    peerPubkey: string,
    messages: DmMessage[],
    peerMeta?: { peerNickname?: string; protocol?: DmProtocol }
  ) => number
  onMergeServerMessages: (serverId: string, channelId: string, messages: ServerMessage[]) => number
  onMergeBitchatMessages: (channelKey: string, messages: GeoMessage[]) => number
}

interface PendingAmailTransfer {
  totalChunks: number
  updatedAt: number
  hash: string
  chunks: Map<number, string>
  startedAt: number
}

const SIBLING_STATE_COOLDOWN_MS = 3_000
const SIBLING_REQ_COOLDOWN_MS = 4_000
const MAX_SEEN_SYNC_EVENTS = 1200
const SELF_CHECKPOINT_STALE_MS = 15 * 60 * 1000

const CHECKPOINT_PENDING_KEY = 'agnostr:v2:device_sync_checkpoint_pending'
function hasPendingCheckpoint(owner: string): boolean {
  try { return localStorage.getItem(CHECKPOINT_PENDING_KEY) === owner } catch { return false }
}
function savePendingCheckpoint(owner: string, pending: boolean) {
  if (!owner) return
  try {
    if (pending) localStorage.setItem(CHECKPOINT_PENDING_KEY, owner)
    else if (hasPendingCheckpoint(owner)) localStorage.removeItem(CHECKPOINT_PENDING_KEY)
  } catch { /* sync still works without persistent browser storage */ }
}

function rememberCheckpoint(candidates: Map<string, NostrEvent>, event: NostrEvent) {
  candidates.set(event.id, event)
  if (candidates.size <= 16) return
  const oldest = [...candidates.values()].sort((a,b) => a.created_at - b.created_at || a.id.localeCompare(b.id))[0]
  candidates.delete(oldest.id)
}

function sortLinkedDevices(list: LinkedDeviceInfo[]): LinkedDeviceInfo[] {
  return [...list].sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      Math.max(b.lastSyncedAt ?? 0, b.lastSeenAt) - Math.max(a.lastSyncedAt ?? 0, a.lastSeenAt) ||
      a.deviceId.localeCompare(b.deviceId)
  )
}

function areLinkedDevicesEqual(a: readonly LinkedDeviceInfo[], b: readonly LinkedDeviceInfo[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].deviceId !== b[i].deviceId ||
      a[i].label !== b[i].label ||
      a[i].nickname !== b[i].nickname ||
      a[i].lastSeenAt !== b[i].lastSeenAt ||
      (a[i].lastSyncedAt ?? 0) !== (b[i].lastSyncedAt ?? 0) ||
      a[i].online !== b[i].online
    ) {
      return false
    }
  }
  return true
}

function mergeCrdtDevicesIntoLinkedDevices(
  prev: readonly LinkedDeviceInfo[],
  crdt: DeviceSyncCrdtState,
  selfDeviceId: string,
  nowMs: number
): { next: LinkedDeviceInfo[]; changed: boolean } {
  const selfId = selfDeviceId.trim()
  const rawDevices = sanitizeSyncedDevicesMap(crdt.devices)
  const tombstones = new Map<string, number>()
  for (const [id, rec] of Object.entries(rawDevices)) {
    if ((rec.removedAt ?? 0) >= rec.updatedAt && (rec.removedAt ?? 0) > 0) {
      tombstones.set(id, rec.removedAt ?? 0)
    }
  }

  const byId = new Map<string, LinkedDeviceInfo>()
  for (const existing of prev) {
    if (!existing.deviceId || existing.deviceId === selfId) continue
    const removedAt = tombstones.get(existing.deviceId)
    if (
      removedAt !== undefined &&
      removedAt >= Math.max(existing.lastSeenAt, existing.lastSyncedAt ?? 0)
    ) {
      continue
    }
    const isOnline =
      existing.lastSeenAt > 0 && nowMs - existing.lastSeenAt <= DEVICE_SYNC_ONLINE_TTL_MS
    byId.set(existing.deviceId, {
      ...existing,
      online: isOnline,
    })
  }

  const activeCrdtDevices = extractActiveSyncedDevices(crdt, selfId)
  for (const rec of activeCrdtDevices) {
    const existing = byId.get(rec.deviceId)
    const lastSeenAt = existing?.lastSeenAt ?? 0
    const isOnline = lastSeenAt > 0 && nowMs - lastSeenAt <= DEVICE_SYNC_ONLINE_TTL_MS
    const lastSyncedAt = Math.max(existing?.lastSyncedAt ?? 0, rec.lastSyncedAt)
    const label =
      existing && existing.lastSeenAt > rec.updatedAt && existing.label.trim()
        ? existing.label.trim().slice(0, 48)
        : rec.label.trim().slice(0, 48) || existing?.label || 'Agnostr Device'
    byId.set(rec.deviceId, {
      deviceId: rec.deviceId,
      label,
      nickname: existing?.nickname ?? '',
      lastSeenAt,
      ...(lastSyncedAt > 0 ? { lastSyncedAt } : {}),
      online: isOnline,
    })
  }

  const next = sortLinkedDevices(Array.from(byId.values())).slice(0, MAX_SYNCED_DEVICES)
  return {
    next,
    changed: !areLinkedDevicesEqual(prev, next),
  }
}

export function useDeviceSync(options: UseDeviceSyncOptions): {
  deviceSync: DeviceSyncEngine
  registerAmailSyncProvider: (provider: AmailSyncProvider | null) => void
  notifyAmailChanged: () => void
} {
  const {
    relayPool,
    identityManager,
    identityVersion,
    masterPubkey,
    nickname,
    getSyncRelayUrls,
    joinedServers,
    trustedPubkeys,
    blockedPubkeys,
    blockedPeerNames,
    pinnedChannels,
    dmClearedAt,
    lightningAddress,
    peerNotes,
    dmThreads,
    activeGeohash,
    activeBitchatMessages,
    activeServerMessages,
    initialHealCheckpoint = false,
    onApplyServers,
    onApplyTrusted,
    onApplyBlocked,
    onApplyPinned,
    onApplyDmClearedAt,
    onApplyLightningAddress,
    onApplyNickname,
    onApplyPeerNotes,
    onApplyDmPeerNames,
    onMergeDmMessages,
    onMergeServerMessages,
    onMergeBitchatMessages,
  } = options

  const persistedInitial = useMemo(() => loadDeviceSyncState(), [])
  const initialDeviceId = useMemo(() => loadOrCreateDeviceId(), [])

  const [deviceId, setDeviceId] = useState<string>(initialDeviceId)
  const [deviceLabel, setDeviceLabelState] = useState<string>(
    () => loadCustomDeviceLabel() || detectDeviceLabel()
  )
  const [enabled, setEnabledState] = useState<boolean>(() => persistedInitial?.enabled ?? true)
  const [linkedDevices, setLinkedDevices] = useState<LinkedDeviceInfo[]>(() => {
    if (!persistedInitial || persistedInitial.ownerPubkey !== masterPubkey.toLowerCase()) {
      return []
    }
    return mergeCrdtDevicesIntoLinkedDevices(
      persistedInitial.linkedDevices.map((d) => ({ ...d, online: false })),
      persistedInitial.crdt,
      initialDeviceId,
      Date.now()
    ).next
  })
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(() =>
    persistedInitial && persistedInitial.ownerPubkey === masterPubkey.toLowerCase()
      ? persistedInitial.lastSyncedAt
      : null
  )
  const [checkpointIssue, setCheckpointIssue] = useState<DeviceSyncEngine['checkpointIssue']>(null)
  const [isSyncing, setIsSyncing] = useState<boolean>(false)
  const [syncedItemsCount, setSyncedItemsCount] = useState<number>(0)

  const deviceIdRef = useRef<string>(deviceId)
  const deviceLabelRef = useRef<string>(deviceLabel)
  const enabledRef = useRef<boolean>(enabled)
  const ownerPubkeyRef = useRef<string | null>(
    persistedInitial?.ownerPubkey ?? masterPubkey.toLowerCase()
  )
  const crdtRef = useRef<DeviceSyncCrdtState>(
    persistedInitial && persistedInitial.ownerPubkey === masterPubkey.toLowerCase()
      ? persistedInitial.crdt
      : createEmptyCrdtState()
  )
  const stateRevisionRef = useRef<number>(
    persistedInitial && persistedInitial.ownerPubkey === masterPubkey.toLowerCase()
      ? persistedInitial.stateRevision
      : 0
  )
  const crdtInitializedForOwnerRef = useRef<boolean>(
    Boolean(persistedInitial && persistedInitial.ownerPubkey === masterPubkey.toLowerCase())
  )
  const linkedDevicesRef = useRef<LinkedDeviceInfo[]>(linkedDevices)
  const lastSyncedAtRef = useRef<number | null>(lastSyncedAt)
  const isApplyingRemoteRef = useRef<boolean>(false)
  const checkpointHydratedRef = useRef<boolean>(false)
  const checkpointDirtyRef = useRef<boolean>(Boolean(initialHealCheckpoint) || hasPendingCheckpoint(masterPubkey.toLowerCase()))
  const publishingCheckpointRef = useRef(false)
  const checkpointTimerRef = useRef<number | null>(null)
  const msgSyncNotifyTimerRef = useRef<number | null>(null)
  const lastHelloSentAtRef = useRef<number>(0)
  const lastStateSentToPeerRef = useRef<Map<string, number>>(new Map())
  const lastReqSentToPeerRef = useRef<Map<string, number>>(new Map())
  const lastPeerDigestsRef = useRef<Map<string, DeviceSyncMsgDigests>>(new Map())
  const seenEventIdsRef = useRef<Set<string>>(new Set())
  const amailProviderRef = useRef<AmailSyncProvider | null>(null)
  const amailTransfersRef = useRef<Map<string, PendingAmailTransfer>>(new Map())
  const amailLastUpdatedAtRef = useRef<number>(0)
  const subSeqRef = useRef<number>(0)

  const activeDmPeerNames = useMemo<Record<string, SyncedDmPeerNameRecord>>(() => {
    const blocked = new Set(blockedPubkeys.map((p) => p.toLowerCase()))
    const out: Record<string, SyncedDmPeerNameRecord> = {}
    for (const thread of dmThreads) {
      const pk = thread.peerPubkey.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pk) || blocked.has(pk)) continue
      const cleanName = thread.peerNickname.trim().slice(0, 32)
      if (isAutoAnonNickname(cleanName)) continue
      const cutoff = dmClearedAt[pk] ?? 0
      const hasVisibleMessages = thread.messages.some(
        (m) =>
          !isStuckMediaPlaceholder(m) &&
          !isEphemeralPendingMessage(m) &&
          (cutoff > 0 ? m.createdAt > cutoff : true)
      )
      const latestMsgTs = thread.messages[thread.messages.length - 1]?.createdAt ?? 0
      const activitySec = Math.max(thread.lastMessageAt || 0, latestMsgTs)
      if (!hasVisibleMessages && cutoff > 0 && activitySec <= cutoff) continue
      const updatedAt = Math.max(activitySec * 1000, cutoff > 0 ? cutoff * 1000 + 1 : 1)
      out[pk] = { name: cleanName, updatedAt }
    }
    return out
  }, [dmThreads, blockedPubkeys, dmClearedAt])

  // Always-fresh refs for callbacks and live snapshots
  const getSyncRelayUrlsRef = useRef(getSyncRelayUrls)
  const snapshotRef = useRef<LocalSyncSnapshot>({
    joinedServers,
    trustedPubkeys,
    blockedPubkeys,
    blockedPeerNames,
    pinnedChannels,
    dmClearedAt,
    lightningAddress,
    nickname,
    peerNotes,
    dmPeerNames: activeDmPeerNames,
  })
  const dmThreadsRef = useRef<DmThread[]>(dmThreads)
  const activeGeohashRef = useRef<string>(activeGeohash)
  const activeBitchatMessagesRef = useRef<GeoMessage[]>(activeBitchatMessages)
  const activeServerMessagesRef = useRef<ServerMessage[]>(activeServerMessages)
  const pendingAppliedNicknameRef = useRef<{ applied: string; previous: string } | null>(null)

  const callbacksRef = useRef({
    onApplyServers,
    onApplyTrusted,
    onApplyBlocked,
    onApplyPinned,
    onApplyDmClearedAt,
    onApplyLightningAddress,
    onApplyNickname,
    onApplyPeerNotes,
    onApplyDmPeerNames,
    onMergeDmMessages,
    onMergeServerMessages,
    onMergeBitchatMessages,
  })

  useLayoutEffect(() => {
    deviceIdRef.current = deviceId
  }, [deviceId])

  useLayoutEffect(() => {
    deviceLabelRef.current = deviceLabel
  }, [deviceLabel])

  useLayoutEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  useLayoutEffect(() => {
    linkedDevicesRef.current = linkedDevices
  }, [linkedDevices])

  useLayoutEffect(() => {
    lastSyncedAtRef.current = lastSyncedAt
  }, [lastSyncedAt])

  useLayoutEffect(() => {
    getSyncRelayUrlsRef.current = getSyncRelayUrls
  }, [getSyncRelayUrls])

  useLayoutEffect(() => {
    snapshotRef.current = {
      joinedServers,
      trustedPubkeys,
      blockedPubkeys,
      blockedPeerNames,
      pinnedChannels,
      dmClearedAt,
      lightningAddress,
      nickname,
      peerNotes,
      dmPeerNames: activeDmPeerNames,
    }
  }, [
    joinedServers,
    trustedPubkeys,
    blockedPubkeys,
    blockedPeerNames,
    pinnedChannels,
    dmClearedAt,
    lightningAddress,
    nickname,
    peerNotes,
    activeDmPeerNames,
  ])

  useLayoutEffect(() => {
    dmThreadsRef.current = dmThreads
    activeGeohashRef.current = activeGeohash
    activeBitchatMessagesRef.current = activeBitchatMessages
    activeServerMessagesRef.current = activeServerMessages
  }, [dmThreads, activeGeohash, activeBitchatMessages, activeServerMessages])

  useLayoutEffect(() => {
    callbacksRef.current = {
      onApplyServers,
      onApplyTrusted,
      onApplyBlocked,
      onApplyPinned,
      onApplyDmClearedAt,
      onApplyLightningAddress,
      onApplyNickname,
      onApplyPeerNotes,
      onApplyDmPeerNames,
      onMergeDmMessages,
      onMergeServerMessages,
      onMergeBitchatMessages,
    }
  }, [
    onApplyServers,
    onApplyTrusted,
    onApplyBlocked,
    onApplyPinned,
    onApplyDmClearedAt,
    onApplyLightningAddress,
    onApplyNickname,
    onApplyPeerNotes,
    onApplyDmPeerNames,
    onMergeDmMessages,
    onMergeServerMessages,
    onMergeBitchatMessages,
  ])

  const persistLocalJournal = useCallback(() => {
    saveDeviceSyncState({
      enabled: enabledRef.current,
      ownerPubkey: ownerPubkeyRef.current,
      stateRevision: stateRevisionRef.current,
      lastSyncedAt: lastSyncedAtRef.current,
      crdt: crdtRef.current,
      linkedDevices: linkedDevicesRef.current,
    })
  }, [])

  const recordSyncedActivity = useCallback(
    (itemsDelta: number) => {
      const now = Date.now()
      lastSyncedAtRef.current = now
      setLastSyncedAt(now)
      if (itemsDelta > 0) {
        setSyncedItemsCount((c) => c + itemsDelta)
      }
      persistLocalJournal()
    },
    [persistLocalJournal]
  )

  const upsertSelfDeviceRecord = useCallback((nowMs = Date.now(), labelOverride?: string) => {
    const selfId = deviceIdRef.current.trim().slice(0, 64)
    if (!selfId) return
    const cleanLabel =
      (labelOverride ?? deviceLabelRef.current).trim().slice(0, 48) || detectDeviceLabel()
    const prevDevices = sanitizeSyncedDevicesMap(crdtRef.current.devices)
    const existing = prevDevices[selfId]
    const minNextTs = Math.max(
      nowMs,
      existing?.lastSyncedAt ?? 0,
      existing?.updatedAt ?? 0,
      existing?.removedAt ? existing.removedAt + 1 : 0
    )
    const nextRec: SyncedDeviceRecord = {
      deviceId: selfId,
      label: cleanLabel,
      lastSyncedAt: minNextTs,
      updatedAt: minNextTs,
      ...(existing?.removedAt ? { removedAt: existing.removedAt } : {}),
    }
    crdtRef.current = {
      ...crdtRef.current,
      devices: sanitizeSyncedDevicesMap({
        ...prevDevices,
        [selfId]: nextRec,
      }),
    }
  }, [])

  const syncLinkedDevicesFromCrdt = useCallback((crdt: DeviceSyncCrdtState) => {
    const now = Date.now()
    const { next, changed } = mergeCrdtDevicesIntoLinkedDevices(
      linkedDevicesRef.current,
      crdt,
      deviceIdRef.current,
      now
    )
    if (!changed) return false
    linkedDevicesRef.current = next
    setLinkedDevices(next)
    saveDeviceSyncState({
      enabled: enabledRef.current,
      ownerPubkey: ownerPubkeyRef.current,
      stateRevision: stateRevisionRef.current,
      lastSyncedAt: lastSyncedAtRef.current,
      crdt: crdtRef.current,
      linkedDevices: next,
    })
    return true
  }, [])

  const touchSiblingDevice = useCallback(
    (
      siblingId: string,
      label?: string,
      nick?: string,
      touchOptions?: { markSynced?: boolean; syncedAt?: number }
    ) => {
      const cleanId = siblingId.trim().slice(0, 64)
      if (!cleanId || cleanId === deviceIdRef.current) return
      const now = Date.now()
      const syncTs = touchOptions?.markSynced
        ? Math.max(now, touchOptions.syncedAt ?? 0)
        : touchOptions?.syncedAt
      setLinkedDevices((prev) => {
        const idx = prev.findIndex((d) => d.deviceId === cleanId)
        const existing = idx !== -1 ? prev[idx] : undefined
        const crdtRec = crdtRef.current.devices?.[cleanId]
        const nextLabel =
          (label && label.trim().slice(0, 48)) ||
          existing?.label ||
          crdtRec?.label ||
          'Sibling Device'
        const nextNick =
          nick !== undefined ? nick.trim().slice(0, 32) : (existing?.nickname ?? '')
        const nextLastSyncedAt = Math.max(
          existing?.lastSyncedAt ?? 0,
          syncTs ?? 0,
          crdtRec?.lastSyncedAt ?? 0
        )
        const nextEntry: LinkedDeviceInfo = {
          deviceId: cleanId,
          label: nextLabel,
          nickname: nextNick,
          lastSeenAt: now,
          ...(nextLastSyncedAt > 0 ? { lastSyncedAt: nextLastSyncedAt } : {}),
          online: true,
        }
        let next: LinkedDeviceInfo[]
        if (idx !== -1) {
          next = [...prev]
          next[idx] = nextEntry
        } else {
          next = [nextEntry, ...prev].slice(0, MAX_SYNCED_DEVICES)
        }
        next = sortLinkedDevices(next)
        linkedDevicesRef.current = next
        saveDeviceSyncState({
          enabled: enabledRef.current,
          ownerPubkey: ownerPubkeyRef.current,
          stateRevision: stateRevisionRef.current,
          lastSyncedAt: lastSyncedAtRef.current,
          crdt: crdtRef.current,
          linkedDevices: next,
        })
        return next
      })
    },
    []
  )

  /** Collects current local messages per scope (DM, Server channels, Pinned/Active Bitchat) */
  const collectLocalMessageBuckets = useCallback(() => {
    const blocked = new Set(snapshotRef.current.blockedPubkeys.map((p) => p.toLowerCase()))
    const cleared = snapshotRef.current.dmClearedAt

    const dmMap = new Map<
      string,
      { peerNickname?: string; protocol?: DmProtocol; messages: DmMessage[] }
    >()
    for (const thread of dmThreadsRef.current.slice(0, 30)) {
      const pk = thread.peerPubkey.toLowerCase()
      if (blocked.has(pk)) continue
      const cutoff = cleared[pk] ?? 0
      const msgs = thread.messages.filter(
        (m) =>
          !isStuckMediaPlaceholder(m) &&
          !isEphemeralPendingMessage(m) &&
          (cutoff > 0 ? m.createdAt > cutoff : true)
      )
      if (msgs.length > 0) {
        dmMap.set(pk, {
          peerNickname: !isAutoAnonNickname(thread.peerNickname)
            ? thread.peerNickname.trim().slice(0, 32)
            : undefined,
          protocol: thread.protocol,
          messages: msgs.slice(-150),
        })
      }
    }

    const serverMap = new Map<string, ServerMessage[]>()
    for (const server of snapshotRef.current.joinedServers.slice(0, 20)) {
      const banned = new Set(server.bannedPubkeys.map((p) => p.toLowerCase()))
      for (const ch of server.channels.slice(0, 8)) {
        const key = encodeServerScopeKey(server.id, ch.id)
        const cached = loadServerChannelMessages(server.id, ch.id).filter(
          (m) =>
            !m.isSystem &&
            !isStuckMediaPlaceholder(m) &&
            !isEphemeralPendingMessage(m) &&
            !blocked.has(m.pubkey.toLowerCase()) &&
            !banned.has(m.pubkey.toLowerCase())
        )
        if (cached.length > 0) {
          serverMap.set(key, cached.slice(-150))
        }
        if (serverMap.size >= 30) break
      }
      if (serverMap.size >= 30) break
    }

    const bitchatMap = new Map<string, GeoMessage[]>()
    const bitchatKeys = new Set<string>([
      activeGeohashRef.current,
      ...snapshotRef.current.pinnedChannels.map((p) => p.geohash),
    ])
    for (const gh of Array.from(bitchatKeys).slice(0, 16)) {
      const source =
        gh === activeGeohashRef.current && activeBitchatMessagesRef.current.length > 0
          ? activeBitchatMessagesRef.current
          : loadChannelMessages(gh)
      const clean = source.filter(
        (m) =>
          !m.isSystem &&
          !isStuckMediaPlaceholder(m) &&
          !isEphemeralPendingMessage(m) &&
          m.geohash === gh &&
          !blocked.has(m.pubkey.toLowerCase())
      )
      if (clean.length > 0) {
        bitchatMap.set(gh, clean.slice(-150))
      }
    }

    return { dmMap, serverMap, bitchatMap }
  }, [])

  const getAmailExportInfo = useCallback(async (): Promise<{
    updatedAt: number
    hash: string
    payload: unknown
  } | null> => {
    const provider = amailProviderRef.current
    if (!provider) return null
    try {
      const payload = await provider.exportSyncState()
      if (!payload || typeof payload !== 'object') return null
      const maybeUpdated = (payload as { updatedAt?: unknown }).updatedAt
      const updatedAt =
        typeof maybeUpdated === 'number' && Number.isFinite(maybeUpdated)
          ? maybeUpdated
          : amailLastUpdatedAtRef.current
      return {
        updatedAt,
        hash: computeJsonDigest(payload),
        payload,
      }
    } catch {
      return null
    }
  }, [])

  const computeLocalMsgDigests = useCallback(async (): Promise<DeviceSyncMsgDigests> => {
    const { dmMap, serverMap, bitchatMap } = collectLocalMessageBuckets()
    const dm: Record<string, DeviceSyncScopeDigest> = {}
    for (const [pk, entry] of dmMap.entries()) {
      dm[pk] = computeDmScopeDigest(entry.messages)
    }
    const server: Record<string, DeviceSyncScopeDigest> = {}
    for (const [k, msgs] of serverMap.entries()) {
      server[k] = computeScopeDigest(msgs)
    }
    const bitchat: Record<string, DeviceSyncScopeDigest> = {}
    for (const [gh, msgs] of bitchatMap.entries()) {
      bitchat[gh] = computeScopeDigest(msgs)
    }
    const amailInfo = await getAmailExportInfo()
    return {
      dm,
      server,
      bitchat,
      amail: amailInfo ? { updatedAt: amailInfo.updatedAt, hash: amailInfo.hash } : null,
    }
  }, [collectLocalMessageBuckets, getAmailExportInfo])

  const buildRecentMessagesTail = useCallback((): SyncedRecentMessagesTail => {
    const { dmMap, serverMap, bitchatMap } = collectLocalMessageBuckets()
    const dm: NonNullable<SyncedRecentMessagesTail['dm']> = {}
    const dmEntries = Array.from(dmMap.entries())
      .sort((a, b) => {
        const aTs = a[1].messages[a[1].messages.length - 1]?.createdAt ?? 0
        const bTs = b[1].messages[b[1].messages.length - 1]?.createdAt ?? 0
        return bTs - aTs
      })
      .slice(0, 10)
    for (const [pk, entry] of dmEntries) {
      dm[pk] = {
        peerNickname: entry.peerNickname,
        protocol: entry.protocol,
        messages: entry.messages.slice(-15),
      }
    }

    const server: Record<string, ServerMessage[]> = {}
    const serverEntries = Array.from(serverMap.entries())
      .sort((a, b) => {
        const aTs = a[1][a[1].length - 1]?.createdAt ?? 0
        const bTs = b[1][b[1].length - 1]?.createdAt ?? 0
        return bTs - aTs
      })
      .slice(0, 10)
    for (const [k, msgs] of serverEntries) {
      server[k] = msgs.slice(-12)
    }

    const bitchat: Record<string, GeoMessage[]> = {}
    const bitchatEntries = Array.from(bitchatMap.entries())
      .sort((a, b) => {
        const aTs = a[1][a[1].length - 1]?.createdAt ?? 0
        const bTs = b[1][b[1].length - 1]?.createdAt ?? 0
        return bTs - aTs
      })
      .slice(0, 6)
    for (const [gh, msgs] of bitchatEntries) {
      bitchat[gh] = msgs.slice(-10)
    }

    return { dm, server, bitchat }
  }, [collectLocalMessageBuckets])

  const publishEphemeralPacket = useCallback(
    async (packet: DeviceSyncWirePacket, allowExtensionPrompt = false): Promise<boolean> => {
      if (!enabledRef.current) return false
      const material = identityManager.getMasterKeyMaterial()
      if (!material.secretKey && !allowExtensionPrompt) return false
      const relays = getSyncRelayUrlsRef.current()
      if (relays.length === 0) return false
      const signed = await buildSignedDeviceSyncEphemeralEvent(packet, material, allowExtensionPrompt)
      if (!signed || !enabledRef.current || identityManager.getMasterKeyMaterial().pubkey !== material.pubkey) return false
      seenEventIdsRef.current.add(signed.id)
      const res = await relayPool.publish(relays, signed, 3500)
      return res.acceptedRelays.length > 0
    },
    [identityManager, relayPool]
  )

  const publishCheckpointNow = useCallback(
    async (allowExtensionPrompt = false): Promise<boolean> => {
      if (!enabledRef.current || publishingCheckpointRef.current) return false
      const material = identityManager.getMasterKeyMaterial()
      if (!material.secretKey && !allowExtensionPrompt) return false
      const relays = getSyncRelayUrlsRef.current()
      if (relays.length === 0) return false
      const device = deviceIdRef.current
      const isCurrent = () => enabledRef.current && deviceIdRef.current === device &&
        identityManager.getMasterKeyMaterial().pubkey === material.pubkey
      publishingCheckpointRef.current = true
      // Consume this attempt's dirtiness, not any changes made while we await the relay.
      checkpointDirtyRef.current = false
      savePendingCheckpoint(material.pubkey, true)
      let accepted = false
      let issue: DeviceSyncEngine['checkpointIssue'] = 'retry'
      try {
        const amailInfo = await getAmailExportInfo()
        if (!isCurrent()) return false
        const recentTail = buildRecentMessagesTail()
        upsertSelfDeviceRecord(Date.now())
        persistLocalJournal()
        const bounded = fitCheckpointStateWithinBudget(crdtRef.current, amailInfo, recentTail, MAX_NIP44_CHUNK_BYTES)
        if (utf8ByteLength(JSON.stringify(bounded)) > MAX_NIP44_CHUNK_BYTES) {
          issue = 'too-large'
          return false
        }
        const signed = await buildSignedDeviceSyncCheckpointEvent(bounded, material, allowExtensionPrompt)
        if (!signed || !isCurrent()) return false
        seenEventIdsRef.current.add(signed.id)
        const res = await relayPool.publish(relays, signed, 4500)
        if (!isCurrent() || res.acceptedRelays.length === 0) return false
        accepted = true
        recordSyncedActivity(0)
        return true
      } catch {
        return false
      } finally {
        publishingCheckpointRef.current = false
        if (isCurrent()) {
          setCheckpointIssue(accepted ? null : issue)
          if (!accepted) checkpointDirtyRef.current = true
          savePendingCheckpoint(material.pubkey, checkpointDirtyRef.current)
        }
      }
    },
    [
      identityManager,
      relayPool,
      getAmailExportInfo,
      buildRecentMessagesTail,
      upsertSelfDeviceRecord,
      persistLocalJournal,
      recordSyncedActivity,
    ]
  )

  const scheduleCheckpointPublish = useCallback(() => {
    if (!checkpointDirtyRef.current) savePendingCheckpoint(ownerPubkeyRef.current ?? '', true)
    checkpointDirtyRef.current = true
    if (!enabledRef.current || !checkpointHydratedRef.current) return
    if (checkpointTimerRef.current !== null) {
      window.clearTimeout(checkpointTimerRef.current)
    }
    checkpointTimerRef.current = window.setTimeout(() => {
      checkpointTimerRef.current = null
      if (!enabledRef.current || !checkpointDirtyRef.current) return
      void publishCheckpointNow(false)
    }, DEVICE_SYNC_CHECKPOINT_DEBOUNCE_MS)
  }, [publishCheckpointNow])

  const broadcastHello = useCallback(
    async (allowExtensionPrompt = false): Promise<boolean> => {
      if (!enabledRef.current) return false
      const material = identityManager.getMasterKeyMaterial()
      if (!material.secretKey && !allowExtensionPrompt) return false
      const msgDigests = await computeLocalMsgDigests()
      if (identityManager.getMasterKeyMaterial().pubkey !== material.pubkey) return false
      const packet: DeviceSyncHelloPacket = {
        v: 1,
        type: 'sync-hello',
        deviceId: deviceIdRef.current,
        deviceLabel: deviceLabelRef.current,
        nickname: snapshotRef.current.nickname,
        ts: Date.now(),
        stateRevision: stateRevisionRef.current,
        stateHash: computeCrdtStateHash(crdtRef.current),
        msgDigests,
      }
      lastHelloSentAtRef.current = Date.now()
      return await publishEphemeralPacket(packet, allowExtensionPrompt)
    },
    [identityManager, computeLocalMsgDigests, publishEphemeralPacket]
  )

  const sendStateToPeer = useCallback(
    async (
      targetDeviceId?: string,
      allowExtensionPrompt = false,
      force = false
    ): Promise<boolean> => {
      if (!enabledRef.current) return false
      const key = targetDeviceId ?? '__broadcast__'
      const now = Date.now()
      const lastSent = lastStateSentToPeerRef.current.get(key) ?? 0
      if (!allowExtensionPrompt && !force && now - lastSent < SIBLING_STATE_COOLDOWN_MS) {
        return false
      }
      lastStateSentToPeerRef.current.set(key, now)

      const owner = identityManager.getMasterKeyMaterial().pubkey
      const amailInfo = await getAmailExportInfo()
      if (identityManager.getMasterKeyMaterial().pubkey !== owner) return false
      upsertSelfDeviceRecord(now)
      persistLocalJournal()
      const statePayload = fitCheckpointStateWithinBudget(
        crdtRef.current,
        amailInfo,
        undefined,
        MAX_NIP44_CHUNK_BYTES
      )
      const packet: DeviceSyncStatePacket = {
        v: 1,
        type: 'sync-state',
        deviceId: deviceIdRef.current,
        deviceLabel: deviceLabelRef.current,
        nickname: snapshotRef.current.nickname,
        ...(targetDeviceId ? { targetDeviceId } : {}),
        ts: now,
        state: statePayload,
      }
      return await publishEphemeralPacket(packet, allowExtensionPrompt)
    },
    [
      identityManager,
      getAmailExportInfo,
      upsertSelfDeviceRecord,
      persistLocalJournal,
      publishEphemeralPacket,
    ]
  )

  const applyRecentMessagesTail = useCallback(
    (tail: SyncedRecentMessagesTail | undefined): number => {
      if (!tail) return 0
      let added = 0
      let sawRemotePollution = false
      if (tail.dm) {
        for (const [pk, entry] of Object.entries(tail.dm)) {
          if (entry && Array.isArray(entry.messages) && entry.messages.length > 0) {
            const clean = entry.messages.filter(
              (m) => !isStuckMediaPlaceholder(m) && !isEphemeralPendingMessage(m)
            )
            if (clean.length < entry.messages.length) sawRemotePollution = true
            if (clean.length > 0) {
              added += callbacksRef.current.onMergeDmMessages(pk, clean, {
                peerNickname: entry.peerNickname,
                protocol: entry.protocol,
              })
            }
          }
        }
      }
      if (tail.server) {
        for (const [scopeKey, msgs] of Object.entries(tail.server)) {
          const decoded = decodeServerScopeKey(scopeKey)
          if (decoded && Array.isArray(msgs) && msgs.length > 0) {
            const clean = msgs.filter(
              (m) => !isStuckMediaPlaceholder(m) && !isEphemeralPendingMessage(m)
            )
            if (clean.length < msgs.length) sawRemotePollution = true
            if (clean.length > 0) {
              added += callbacksRef.current.onMergeServerMessages(
                decoded.serverId,
                decoded.channelId,
                clean
              )
            }
          }
        }
      }
      if (tail.bitchat) {
        for (const [gh, msgs] of Object.entries(tail.bitchat)) {
          if (gh && Array.isArray(msgs) && msgs.length > 0) {
            const clean = msgs.filter(
              (m) => !isStuckMediaPlaceholder(m) && !isEphemeralPendingMessage(m)
            )
            if (clean.length < msgs.length) sawRemotePollution = true
            if (clean.length > 0) {
              added += callbacksRef.current.onMergeBitchatMessages(gh, clean)
            }
          }
        }
      }
      if (sawRemotePollution) {
        scheduleCheckpointPublish()
      }
      return added
    },
    [scheduleCheckpointPublish]
  )

  const applyMergedRemoteCrdt = useCallback(
    async (remoteState: DeviceSyncCrdtState): Promise<{ changed: boolean; itemsApplied: number }> => {
      const owner = identityManager.getMasterKeyMaterial().pubkey
      const { merged, changed, diff } = mergeCrdtStates(crdtRef.current, remoteState)
      let itemsApplied = 0

      const mergedDmNames = extractActiveDmPeerNames(merged)
      const hasMergedDmNames = Object.keys(mergedDmNames).length > 0

      if (changed || hasMergedDmNames) {
        isApplyingRemoteRef.current = true
        try {
          if (changed) {
            crdtRef.current = merged
            stateRevisionRef.current += 1

            if (diff.dmClearedChanged) {
              callbacksRef.current.onApplyDmClearedAt(merged.dmClearedAt)
            }
            if (diff.blockedChanged) {
              callbacksRef.current.onApplyBlocked(
                extractActiveBlocked(merged),
                extractActiveBlockedPeerNames(merged)
              )
            }
            if (diff.trustedChanged) {
              callbacksRef.current.onApplyTrusted(extractActiveTrusted(merged))
            }
            if (diff.serversChanged) {
              callbacksRef.current.onApplyServers(extractActiveServers(merged))
            }
            if (diff.pinnedChanged) {
              callbacksRef.current.onApplyPinned(merged.pinned.items)
            }
            if (diff.lud16Changed) {
              callbacksRef.current.onApplyLightningAddress(merged.lud16.value)
            }
            if (diff.nicknameChanged && merged.nickname.value) {
              pendingAppliedNicknameRef.current = {
                applied: merged.nickname.value.trim().slice(0, 32),
                previous: snapshotRef.current.nickname.trim().slice(0, 32),
              }
              callbacksRef.current.onApplyNickname(merged.nickname.value)
            }
            if (diff.peerNotesChanged) {
              callbacksRef.current.onApplyPeerNotes(extractActivePeerNotes(merged))
            }
            itemsApplied += diff.itemsUpdated
          }
          if (hasMergedDmNames) {
            callbacksRef.current.onApplyDmPeerNames(mergedDmNames)
          }
        } finally {
          // Release guard on microtask boundary after batched React state updates flush
          queueMicrotask(() => {
            isApplyingRemoteRef.current = false
          })
        }
      }

      if (remoteState.recentMessages) {
        itemsApplied += applyRecentMessagesTail(remoteState.recentMessages)
      }

      if (remoteState.amail && amailProviderRef.current) {
        try {
          const res = await amailProviderRef.current.mergeSyncState(remoteState.amail.payload)
          if (typeof res === 'number' && res > 0) {
            itemsApplied += res
          } else if (res === true) {
            itemsApplied += 1
          }
        } catch {
          // Ignore malformed optional amail payload
        }
      }

      if (identityManager.getMasterKeyMaterial().pubkey !== owner) return { changed: false, itemsApplied: 0 }
      syncLinkedDevicesFromCrdt(changed ? merged : crdtRef.current)

      if (itemsApplied > 0 || changed) {
        recordSyncedActivity(itemsApplied)
      }
      return { changed, itemsApplied }
    },
    [applyRecentMessagesTail, syncLinkedDevicesFromCrdt, recordSyncedActivity, identityManager]
  )

  const requestMissingMessagesFromPeer = useCallback(
    async (peerDeviceId: string, remoteDigests: DeviceSyncMsgDigests, bypassCooldown = false) => {
      const owner = identityManager.getMasterKeyMaterial().pubkey
      const now = Date.now()
      const lastReq = lastReqSentToPeerRef.current.get(peerDeviceId) ?? 0
      if (!bypassCooldown && now - lastReq < SIBLING_REQ_COOLDOWN_MS) return

      const { dmMap, serverMap, bitchatMap } = collectLocalMessageBuckets()
      const localDigests = await computeLocalMsgDigests()
      if (identityManager.getMasterKeyMaterial().pubkey !== owner) return
      const blocked = new Set(snapshotRef.current.blockedPubkeys.map((p) => p.toLowerCase()))
      const scopes: DeviceSyncScopeRequest[] = []

      for (const [pk, remoteDigest] of Object.entries(remoteDigests.dm)) {
        if (!remoteDigest || remoteDigest.count <= 0 || blocked.has(pk.toLowerCase())) continue
        const localDigest = localDigests.dm[pk]
        const useVersions = typeof remoteDigest.versionsHash === 'string'
        if (!localDigest || localDigest.hash !== remoteDigest.hash ||
            (useVersions && localDigest.versionsHash !== remoteDigest.versionsHash)) {
          const knownIds = (dmMap.get(pk)?.messages ?? [])
            .map(m => useVersions ? computeDmMessageVersion(m) : m.id).slice(-150)
          scopes.push({
            kind: 'dm',
            key: pk,
            knownIds,
            ...(useVersions ? { dmVersions: true } : {}),
            sinceSec: snapshotRef.current.dmClearedAt[pk.toLowerCase()],
          })
        }
      }

      for (const [scopeKey, remoteDigest] of Object.entries(remoteDigests.server)) {
        if (!remoteDigest || remoteDigest.count <= 0) continue
        const decoded = decodeServerScopeKey(scopeKey)
        if (!decoded) continue
        // Only request server messages once this server is actively joined locally (avoids pre-join drop race)
        const serverRec = crdtRef.current.servers[decoded.serverId]
        if (!serverRec || serverRec.leftAt >= serverRec.joinedAt || !serverRec.summary) continue
        const localDigest = localDigests.server[scopeKey]
        if (!localDigest || localDigest.hash !== remoteDigest.hash) {
          const knownIds = (serverMap.get(scopeKey) ?? []).map((m) => m.id).slice(-200)
          scopes.push({ kind: 'server', key: scopeKey, knownIds })
        }
      }

      for (const [gh, remoteDigest] of Object.entries(remoteDigests.bitchat)) {
        if (!remoteDigest || remoteDigest.count <= 0) continue
        const localDigest = localDigests.bitchat[gh]
        if (!localDigest || localDigest.hash !== remoteDigest.hash) {
          const knownIds = (bitchatMap.get(gh) ?? []).map((m) => m.id).slice(-200)
          scopes.push({ kind: 'bitchat', key: gh, knownIds })
        }
      }

      const wantAmail = Boolean(
        amailProviderRef.current &&
          remoteDigests.amail &&
          remoteDigests.amail.hash &&
          remoteDigests.amail.hash !== localDigests.amail?.hash
      )

      if (scopes.length > 0 || wantAmail) {
        lastReqSentToPeerRef.current.set(peerDeviceId, now)
        const req: DeviceSyncMsgReqPacket = {
          v: 1,
          type: 'sync-msg-req',
          deviceId: deviceIdRef.current,
          targetDeviceId: peerDeviceId,
          ts: now,
          scopes,
          ...(wantAmail ? { wantAmail: true } : {}),
        }
        for (const packet of buildMessageRequestPackets(req)) {
          if (identityManager.getMasterKeyMaterial().pubkey !== owner) return
          await publishEphemeralPacket(packet, false)
        }
      }
    },
    [collectLocalMessageBuckets, computeLocalMsgDigests, publishEphemeralPacket, identityManager]
  )

  const handleIncomingWirePacket = useCallback(
    async (packet: DeviceSyncWirePacket) => {
      const own = identityManager.getMasterKeyMaterial().pubkey
      const device = deviceIdRef.current
      const isCurrent = () => enabledRef.current && deviceIdRef.current === device &&
        identityManager.getMasterKeyMaterial().pubkey === own
      if (!isCurrent()) return
      if (packet.deviceId === deviceIdRef.current) return
      if ('targetDeviceId' in packet && packet.targetDeviceId && packet.targetDeviceId !== deviceIdRef.current) {
        return
      }

      if (packet.type === 'sync-hello') {
        touchSiblingDevice(packet.deviceId, packet.deviceLabel, packet.nickname)
        lastPeerDigestsRef.current.set(packet.deviceId, packet.msgDigests)
        const localHash = computeCrdtStateHash(crdtRef.current)
        if (packet.stateHash !== localHash) {
          void sendStateToPeer(packet.deviceId, false)
        }
        await requestMissingMessagesFromPeer(packet.deviceId, packet.msgDigests, false)
        return
      }

      if (packet.type === 'sync-state') {
        touchSiblingDevice(packet.deviceId, packet.deviceLabel, packet.nickname, {
          markSynced: true,
          syncedAt: packet.ts,
        })
        const remoteHashBefore = computeCrdtStateHash(packet.state)
        const { changed } = await applyMergedRemoteCrdt(packet.state)
        if (!isCurrent()) return
        const localHashAfter = computeCrdtStateHash(crdtRef.current)
        if (changed) {
          scheduleCheckpointPublish()
          const cachedDigests = lastPeerDigestsRef.current.get(packet.deviceId)
          if (cachedDigests) {
            void requestMissingMessagesFromPeer(packet.deviceId, cachedDigests, true)
          }
        }
        if (localHashAfter !== remoteHashBefore) {
          void sendStateToPeer(packet.deviceId, false)
        }
        return
      }

      if (packet.type === 'sync-msg-req') {
        touchSiblingDevice(packet.deviceId)
        const { dmMap, serverMap, bitchatMap } = collectLocalMessageBuckets()
        for (const req of packet.scopes.slice(0, 32)) {
          const known = new Set(req.knownIds)
          if (req.kind === 'dm') {
            const bucket = dmMap.get(req.key.toLowerCase())
            if (!bucket) continue
            const missing = bucket.messages.filter(
              (m) => !known.has(req.dmVersions ? computeDmMessageVersion(m) : m.id) && (!req.sinceSec || m.createdAt > req.sinceSec)
            )
            if (missing.length === 0) continue
            const chunks = buildMessageChunkPackets({
              deviceId: deviceIdRef.current,
              targetDeviceId: packet.deviceId,
              scopeKind: 'dm',
              scopeKey: req.key.toLowerCase(),
              peerMeta: {
                peerNickname: bucket.peerNickname,
                protocol: bucket.protocol,
              },
              messages: missing,
            })
            for (const chunk of chunks) {
              if (!isCurrent()) return
              await publishEphemeralPacket(chunk, false)
            }
          } else if (req.kind === 'server') {
            const msgs = serverMap.get(req.key)
            if (!msgs) continue
            const missing = msgs.filter((m) => !known.has(m.id))
            if (missing.length === 0) continue
            const chunks = buildMessageChunkPackets({
              deviceId: deviceIdRef.current,
              targetDeviceId: packet.deviceId,
              scopeKind: 'server',
              scopeKey: req.key,
              messages: missing,
            })
            for (const chunk of chunks) {
              if (!isCurrent()) return
              await publishEphemeralPacket(chunk, false)
            }
          } else if (req.kind === 'bitchat') {
            const msgs = bitchatMap.get(req.key)
            if (!msgs) continue
            const missing = msgs.filter((m) => !known.has(m.id))
            if (missing.length === 0) continue
            const chunks = buildMessageChunkPackets({
              deviceId: deviceIdRef.current,
              targetDeviceId: packet.deviceId,
              scopeKind: 'bitchat',
              scopeKey: req.key,
              messages: missing,
            })
            for (const chunk of chunks) {
              if (!isCurrent()) return
              await publishEphemeralPacket(chunk, false)
            }
          }
        }

        if (packet.wantAmail) {
          const amailInfo = await getAmailExportInfo()
          if (!isCurrent()) return
          if (amailInfo) {
            const chunks = buildAmailChunkPackets({
              deviceId: deviceIdRef.current,
              targetDeviceId: packet.deviceId,
              transferId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
              updatedAt: amailInfo.updatedAt,
              hash: amailInfo.hash,
              payload: amailInfo.payload,
            })
            for (const chunk of chunks) {
              if (!isCurrent()) return
              await publishEphemeralPacket(chunk, false)
            }
          }
        }

        return
      }

      if (packet.type === 'sync-msg-chunk') {
        touchSiblingDevice(packet.deviceId, undefined, undefined, {
          markSynced: true,
          syncedAt: packet.ts,
        })
        let added = 0
        const cleanChunk = packet.messages.filter(
          (m) => !isStuckMediaPlaceholder(m) && !isEphemeralPendingMessage(m)
        )
        if (cleanChunk.length === 0) return
        if (packet.scopeKind === 'dm') {
          added = callbacksRef.current.onMergeDmMessages(
            packet.scopeKey,
            cleanChunk as DmMessage[],
            packet.peerMeta
          )
        } else if (packet.scopeKind === 'server') {
          const decoded = decodeServerScopeKey(packet.scopeKey)
          if (decoded) {
            added = callbacksRef.current.onMergeServerMessages(
              decoded.serverId,
              decoded.channelId,
              cleanChunk as ServerMessage[]
            )
          }
        } else if (packet.scopeKind === 'bitchat') {
          added = callbacksRef.current.onMergeBitchatMessages(
            packet.scopeKey,
            cleanChunk as GeoMessage[]
          )
        }
        if (added > 0) {
          recordSyncedActivity(added)
        }
        return
      }

      if (packet.type === 'sync-amail-chunk') {
        if (!amailProviderRef.current || packet.totalChunks <= 0 || packet.totalChunks > 64) {
          return
        }
        touchSiblingDevice(packet.deviceId, undefined, undefined, {
          markSynced: true,
          syncedAt: packet.ts,
        })
        const tKey = `${packet.deviceId}:${packet.transferId}`
        const now = Date.now()
        // Prune stale incomplete transfers (> 90s old)
        for (const [k, v] of amailTransfersRef.current.entries()) {
          if (now - v.startedAt > 90_000) {
            amailTransfersRef.current.delete(k)
          }
        }
        let transfer = amailTransfersRef.current.get(tKey)
        if (!transfer) {
          if (amailTransfersRef.current.size >= 8) amailTransfersRef.current.delete(amailTransfersRef.current.keys().next().value!)
          transfer = {
            totalChunks: packet.totalChunks,
            updatedAt: packet.updatedAt,
            hash: packet.hash,
            chunks: new Map(),
            startedAt: now,
          }
          amailTransfersRef.current.set(tKey, transfer)
        }
        if (transfer.hash !== packet.hash || transfer.totalChunks !== packet.totalChunks ||
            transfer.updatedAt !== packet.updatedAt) return
        transfer.chunks.set(packet.chunkIndex, packet.data)
        if (transfer.chunks.size >= transfer.totalChunks) {
          amailTransfersRef.current.delete(tKey)
          let combined = ''
          for (let i = 0; i < transfer.totalChunks; i += 1) {
            const part = transfer.chunks.get(i)
            if (typeof part !== 'string') return
            combined += part
          }
          try {
            const parsed: unknown = JSON.parse(combined)
            if (computeJsonDigest(parsed) !== transfer.hash) return
            const res = await amailProviderRef.current.mergeSyncState(parsed)
            const count = typeof res === 'number' ? res : res === true ? 1 : 0
            if (isCurrent() && count > 0) {
              recordSyncedActivity(count)
            }
          } catch {
            // Ignore malformed reassembled payload
          }
        }
        return
      }

    },
    [
      identityManager,
      touchSiblingDevice,
      sendStateToPeer,
      requestMissingMessagesFromPeer,
      collectLocalMessageBuckets,
      publishEphemeralPacket,
      applyMergedRemoteCrdt,
      scheduleCheckpointPublish,
      getAmailExportInfo,
      recordSyncedActivity,
    ]
  )

  // Reset CRDT owner whenever the active master pubkey changes (e.g. importing nsec or rotating key)
  useEffect(() => {
    const pk = masterPubkey.toLowerCase()
    if (!pk || ownerPubkeyRef.current === pk) return
    ownerPubkeyRef.current = pk
    crdtRef.current = createEmptyCrdtState()
    crdtInitializedForOwnerRef.current = false
    pendingAppliedNicknameRef.current = null
    stateRevisionRef.current = 0
    checkpointHydratedRef.current = false
    setCheckpointIssue(null)
    checkpointDirtyRef.current = hasPendingCheckpoint(pk)
    seenEventIdsRef.current.clear()
    amailTransfersRef.current.clear()

    lastStateSentToPeerRef.current.clear()
    lastReqSentToPeerRef.current.clear()
    lastPeerDigestsRef.current.clear()
    linkedDevicesRef.current = []
    setLinkedDevices([])
    setSyncedItemsCount(0)
    lastSyncedAtRef.current = null
    setLastSyncedAt(null)
    persistLocalJournal()
  }, [masterPubkey, persistLocalJournal])

  // Reconcile local React state mutations into our timestamped CRDT journal
  useEffect(() => {
    if (isApplyingRemoteRef.current) return
    const isInitialSeed = !crdtInitializedForOwnerRef.current

    // Prevent a lagged previous-render React `nickname` prop from bouncing back over a freshly-applied remote nickname
    let effectiveNickname = nickname
    if (pendingAppliedNicknameRef.current !== null) {
      const cleanPropNick = nickname.trim().slice(0, 32)
      const { applied, previous } = pendingAppliedNicknameRef.current
      if (cleanPropNick === applied) {
        pendingAppliedNicknameRef.current = null
      } else if (cleanPropNick === previous) {
        effectiveNickname = crdtRef.current.nickname.value
      } else {
        // User explicitly entered a brand-new local nickname before React flushed the remote value
        pendingAppliedNicknameRef.current = null
      }
    }

    const { crdt, changed } = reconcileLocalSnapshotIntoCrdt(
      crdtRef.current,
      {
        joinedServers,
        trustedPubkeys,
        blockedPubkeys,
        blockedPeerNames,
        pinnedChannels,
        dmClearedAt,
        lightningAddress,
        nickname: effectiveNickname,
        peerNotes,
        dmPeerNames: activeDmPeerNames,
      },
      Date.now(),
      isInitialSeed
    )
    crdtInitializedForOwnerRef.current = true
    if (!changed) return

    crdtRef.current = crdt
    stateRevisionRef.current += 1
    persistLocalJournal()

    if (!isInitialSeed) {
      scheduleCheckpointPublish()
      if (enabledRef.current) void sendStateToPeer(undefined, false, true)
    }
  }, [
    masterPubkey,
    joinedServers,
    trustedPubkeys,
    blockedPubkeys,
    blockedPeerNames,
    pinnedChannels,
    dmClearedAt,
    lightningAddress,
    nickname,
    peerNotes,
    activeDmPeerNames,
    persistLocalJournal,
    scheduleCheckpointPublish,
    sendStateToPeer,
  ])

  // If a DM thread arrived from relays with `agnonXXXX` / `anonXXXX` after the CRDT checkpoint already hydrated a real name, upgrade it immediately
  useEffect(() => {
    if (isApplyingRemoteRef.current) return
    const syncedNames = extractActiveDmPeerNames(crdtRef.current)
    if (Object.keys(syncedNames).length === 0) return
    const upgrades: Record<string, string> = {}
    let count = 0
    for (const thread of dmThreads) {
      if (!isAutoAnonNickname(thread.peerNickname)) continue
      const pk = thread.peerPubkey.trim().toLowerCase()
      const known = syncedNames[pk]
      if (known && !isAutoAnonNickname(known)) {
        upgrades[pk] = known
        count += 1
      }
    }
    if (count > 0) {
      isApplyingRemoteRef.current = true
      try {
        callbacksRef.current.onApplyDmPeerNames(upgrades)
      } finally {
        queueMicrotask(() => {
          isApplyingRemoteRef.current = false
        })
      }
    }
  }, [dmThreads])

  // When new local messages appear (sent or received), silently nudge online siblings & refresh checkpoint
  const msgActivitySignature = useMemo(() => {
    const dmSignature = dmThreads.map(t => computeDmScopeDigest(
      t.messages.slice(-150).filter(m => !isEphemeralPendingMessage(m) && !isStuckMediaPlaceholder(m))
    ).versionsHash).join(':')
    const bitchatTail = activeBitchatMessages[activeBitchatMessages.length - 1]?.id ?? ''
    const serverTail = activeServerMessages[activeServerMessages.length - 1]?.id ?? ''
    return `${dmSignature}:${activeBitchatMessages.length}:${bitchatTail}:${activeServerMessages.length}:${serverTail}`
  }, [dmThreads, activeBitchatMessages, activeServerMessages])

  const prevMsgSigRef = useRef<string>(msgActivitySignature)
  useEffect(() => {
    if (prevMsgSigRef.current === msgActivitySignature) return
    prevMsgSigRef.current = msgActivitySignature
    if (isApplyingRemoteRef.current) return
    scheduleCheckpointPublish()
    if (!enabledRef.current || !checkpointHydratedRef.current) return
    const hasOnlineSibling = linkedDevicesRef.current.some(
      (d) => d.lastSeenAt > 0 && Date.now() - d.lastSeenAt <= DEVICE_SYNC_ONLINE_TTL_MS
    )
    if (!hasOnlineSibling) return
    if (msgSyncNotifyTimerRef.current !== null) {
      window.clearTimeout(msgSyncNotifyTimerRef.current)
    }
    msgSyncNotifyTimerRef.current = window.setTimeout(() => {
      msgSyncNotifyTimerRef.current = null
      void broadcastHello(false)
    }, 1200)
  }, [msgActivitySignature, scheduleCheckpointPublish, broadcastHello])

  // Main live + offline catch-up subscriptions (kind: 25055 + kind: 30078)
  useEffect(() => {
    if (!enabled) return
    const material = identityManager.getMasterKeyMaterial()
    if (!material.pubkey || !material.secretKey) {
      // Extension (NIP-07) mode skips silent background popups; manual Sync Now remains available
      return
    }

    const pk = material.pubkey.toLowerCase()
    const relays = getSyncRelayUrlsRef.current()
    if (relays.length === 0) return

    let cancelled = false
    checkpointHydratedRef.current = false
    const checkpoints = new Map<string, NostrEvent>()
    const checkpointEoses = new Set<string>()
    let checkpointEoseDone = false

    const applyHydratedCheckpoint = async () => {
      if (cancelled || checkpointHydratedRef.current) return
      checkpointHydratedRef.current = true
      const events = [...checkpoints.values()].sort((a,b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
      for (const event of events) {
        if (cancelled || identityManager.getMasterKeyMaterial().pubkey !== material.pubkey) return
        seenEventIdsRef.current.add(event.id)
        const parsed = await parseDeviceSyncCheckpointEvent(event, material, false)
        if (!cancelled && parsed && identityManager.getMasterKeyMaterial().pubkey === material.pubkey) {
          await applyMergedRemoteCrdt(parsed)
        }
      }
      if (!cancelled) {
        const selfId = deviceIdRef.current
        const selfRec = crdtRef.current.devices?.[selfId]
        const needsSelfRegistration =
          !selfRec ||
          (selfRec.removedAt ?? 0) >= selfRec.updatedAt ||
          selfRec.label !== deviceLabelRef.current ||
          Date.now() - selfRec.lastSyncedAt > SELF_CHECKPOINT_STALE_MS
        if (needsSelfRegistration) {
          checkpointDirtyRef.current = true
        }
      }
      if (!cancelled && checkpointDirtyRef.current) {
        scheduleCheckpointPublish()
      }
    }

    const checkpointFallback = window.setTimeout(() => {
      if (!checkpointEoseDone) {
        checkpointEoseDone = true
        void applyHydratedCheckpoint()
      }
    }, 2200)

    const seq = ++subSeqRef.current
    const unsubCheckpoint = relayPool.subscribe(
      `agnostr-devsync-ckpt-${seq}`,
      relays,
      [
        {
          kinds: [KIND_DEVICE_SYNC_CHECKPOINT],
          authors: [pk],
          '#d': [DEVICE_SYNC_CHECKPOINT_D_TAG],
          limit: 3,
        },
      ],
      {
        onEvent: (ev) => {
          if (cancelled || ev.kind !== KIND_DEVICE_SYNC_CHECKPOINT) return
          if (seenEventIdsRef.current.has(ev.id)) return
          if (!checkpointHydratedRef.current) {
            rememberCheckpoint(checkpoints, ev)
            return
          }
          seenEventIdsRef.current.add(ev.id)
          void parseDeviceSyncCheckpointEvent(ev, material, false).then((parsed) => {
            if (!cancelled && parsed && identityManager.getMasterKeyMaterial().pubkey === pk) {
              void applyMergedRemoteCrdt(parsed)
            }
          })
        },
        onEose: (relay) => {
          if (cancelled || checkpointEoseDone) return
          checkpointEoses.add(relay)
          if (checkpointEoses.size < relays.length) return
          checkpointEoseDone = true
          window.clearTimeout(checkpointFallback)
          void applyHydratedCheckpoint()
        },
      }
    )

    const unsubLive = relayPool.subscribe(
      `agnostr-devsync-live-${seq}`,
      relays,
      [
        {
          kinds: [KIND_DEVICE_SYNC_EPHEMERAL],
          '#p': [pk],
          '#t': [DEVICE_SYNC_TAG],
        },
      ],
      {
        onEvent: (ev) => {
          if (cancelled || ev.kind !== KIND_DEVICE_SYNC_EPHEMERAL) return
          if (seenEventIdsRef.current.has(ev.id)) return
          seenEventIdsRef.current.add(ev.id)
          if (seenEventIdsRef.current.size > MAX_SEEN_SYNC_EVENTS) {
            const oldest = seenEventIdsRef.current.values().next().value
            if (oldest) seenEventIdsRef.current.delete(oldest)
          }
          void parseDeviceSyncEphemeralEvent(ev, material, false).then((packet) => {
            if (!cancelled && packet && identityManager.getMasterKeyMaterial().pubkey === pk) {
              void handleIncomingWirePacket(packet)
            }
          })
        },
      }
    )

    // Initial boot hello (600ms grace for sockets to connect) + 45s periodic heartbeat
    const bootTimer = window.setTimeout(() => {
      if (!cancelled) void broadcastHello(false)
    }, 600)

    const retryCheckpoint = () => {
      if (!cancelled && checkpointDirtyRef.current && checkpointHydratedRef.current && !publishingCheckpointRef.current) {
        scheduleCheckpointPublish()
      }
    }
    const intervalId = window.setInterval(() => {
      if (!cancelled) void broadcastHello(false)
      retryCheckpoint()
    }, DEVICE_SYNC_HELLO_INTERVAL_MS)

    const handleVisibility = () => {
      if (cancelled || document.visibilityState !== 'visible') return
      retryCheckpoint()
      if (Date.now() - lastHelloSentAtRef.current < 5_000) return
      void broadcastHello(false)
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('online', retryCheckpoint)

    // Periodic 15s refresh of sibling online indicators (120s TTL)
    const onlineTick = window.setInterval(() => {
      const now = Date.now()
      setLinkedDevices((prev) => {
        let changed = false
        const next = prev.map((d) => {
          const isOnline = d.lastSeenAt > 0 && now - d.lastSeenAt <= DEVICE_SYNC_ONLINE_TTL_MS
          if (isOnline !== d.online) {
            changed = true
            return { ...d, online: isOnline }
          }
          return d
        })
        if (changed) {
          linkedDevicesRef.current = next
          return next
        }
        return prev
      })
    }, 15_000)

    return () => {
      cancelled = true
      window.clearTimeout(checkpointFallback)
      window.clearTimeout(bootTimer)
      window.clearInterval(intervalId)
      window.clearInterval(onlineTick)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility)
      }
      window.removeEventListener('online', retryCheckpoint)
      unsubCheckpoint()
      unsubLive()
    }
  }, [
    enabled,
    relayPool,
    identityManager,
    masterPubkey,
    identityVersion,
    applyMergedRemoteCrdt,
    scheduleCheckpointPublish,
    handleIncomingWirePacket,
    broadcastHello,
  ])

  useEffect(() => {
    return () => {
      if (checkpointTimerRef.current !== null) {
        window.clearTimeout(checkpointTimerRef.current)
      }
      if (msgSyncNotifyTimerRef.current !== null) {
        window.clearTimeout(msgSyncNotifyTimerRef.current)
      }

    }
  }, [])

  const setEnabled = useCallback(
    (next: boolean) => {
      enabledRef.current = next
      setEnabledState(next)
      saveDeviceSyncState({
        enabled: next,
        ownerPubkey: ownerPubkeyRef.current,
        stateRevision: stateRevisionRef.current,
        lastSyncedAt: lastSyncedAtRef.current,
        crdt: crdtRef.current,
        linkedDevices: linkedDevicesRef.current,
      })
    },
    []
  )

  const setDeviceLabel = useCallback(
    (rawLabel: string) => {
      const trimmed = rawLabel.trim().slice(0, 48)
      saveCustomDeviceLabel(trimmed || null)
      const resolved = trimmed || detectDeviceLabel()
      deviceLabelRef.current = resolved
      setDeviceLabelState(resolved)
      upsertSelfDeviceRecord(Date.now(), resolved)
      stateRevisionRef.current += 1
      persistLocalJournal()
      if (enabledRef.current) {
        scheduleCheckpointPublish()
        void sendStateToPeer(undefined, false, true)
        void broadcastHello(false)
      }
    },
    [
      upsertSelfDeviceRecord,
      persistLocalJournal,
      scheduleCheckpointPublish,
      sendStateToPeer,
      broadcastHello,
    ]
  )

  const removeLinkedDevice = useCallback(
    (targetDeviceId: string) => {
      const cleanId = targetDeviceId.trim().slice(0, 64)
      if (!cleanId || cleanId === deviceIdRef.current) return
      const now = Date.now()
      const prevDevices = sanitizeSyncedDevicesMap(crdtRef.current.devices)
      const existingRec = prevDevices[cleanId]
      const existingLinked = linkedDevicesRef.current.find((d) => d.deviceId === cleanId)
      const tombstoneTs = Math.max(
        now,
        (existingRec?.updatedAt ?? 0) + 1,
        (existingRec?.removedAt ?? 0) + 1
      )
      const nextRec: SyncedDeviceRecord = {
        deviceId: cleanId,
        label: existingRec?.label || existingLinked?.label || 'Sibling Device',
        lastSyncedAt: Math.max(existingRec?.lastSyncedAt ?? 0, existingLinked?.lastSyncedAt ?? 0),
        updatedAt: tombstoneTs,
        removedAt: tombstoneTs,
      }
      crdtRef.current = {
        ...crdtRef.current,
        devices: sanitizeSyncedDevicesMap({
          ...prevDevices,
          [cleanId]: nextRec,
        }),
      }
      stateRevisionRef.current += 1

      const nextLinked = linkedDevicesRef.current.filter((d) => d.deviceId !== cleanId)
      linkedDevicesRef.current = nextLinked
      setLinkedDevices(nextLinked)
      lastStateSentToPeerRef.current.delete(cleanId)
      lastReqSentToPeerRef.current.delete(cleanId)
      lastPeerDigestsRef.current.delete(cleanId)
      persistLocalJournal()

      if (enabledRef.current) {
        scheduleCheckpointPublish()
        void sendStateToPeer(undefined, false, true)
      }
    },
    [persistLocalJournal, scheduleCheckpointPublish, sendStateToPeer]
  )

  const syncNow = useCallback(async (): Promise<void> => {
    if (!enabledRef.current) return
    const material = identityManager.getMasterKeyMaterial()
    if (!material.pubkey) return
    const relays = getSyncRelayUrlsRef.current()
    if (relays.length === 0) return

    setIsSyncing(true)
    try {
      const allowExt = material.mode === 'extension'
      // 1. Pull latest kind:30078 checkpoint
      const fetchedCheckpoint = await new Promise<NostrEvent[]>((resolve) => {
        const candidates = new Map<string, NostrEvent>()
        const eoses = new Set<string>()
        let settled = false
        let unsub: (() => void) | null = null
        const finish = () => {
          if (settled) return
          settled = true
          window.clearTimeout(timer)
          unsub?.()
          resolve([...candidates.values()].sort((a,b) => b.created_at - a.created_at || a.id.localeCompare(b.id)))
        }
        const timer = window.setTimeout(finish, 2500)
        unsub = relayPool.subscribe(
          `agnostr-devsync-manual-${++subSeqRef.current}`,
          relays,
          [
            {
              kinds: [KIND_DEVICE_SYNC_CHECKPOINT],
              authors: [material.pubkey.toLowerCase()],
              '#d': [DEVICE_SYNC_CHECKPOINT_D_TAG],
              limit: 3,
            },
          ],
          {
            onEvent: (ev) => {
              if (ev.kind === KIND_DEVICE_SYNC_CHECKPOINT) {
                rememberCheckpoint(candidates, ev)
              }
            },
            onEose: relay => {
              eoses.add(relay)
              if (eoses.size >= relays.length) finish()
            },
          }
        )
      })

      const isCurrent = () => enabledRef.current && identityManager.getMasterKeyMaterial().pubkey === material.pubkey
      for (const event of fetchedCheckpoint) {
        if (!isCurrent()) return
        const parsed = await parseDeviceSyncCheckpointEvent(event, material, allowExt)
        if (parsed && isCurrent()) await applyMergedRemoteCrdt(parsed)
      }
      if (!isCurrent()) return
      checkpointHydratedRef.current = true

      // 2. Broadcast live hello + state & publish merged checkpoint
      await broadcastHello(allowExt)
      await sendStateToPeer(undefined, allowExt)
      await publishCheckpointNow(allowExt)
    } finally {
      setIsSyncing(false)
    }
  }, [
    identityManager,
    relayPool,
    applyMergedRemoteCrdt,
    broadcastHello,
    sendStateToPeer,
    publishCheckpointNow,
  ])

  const registerAmailSyncProvider = useCallback((provider: AmailSyncProvider | null) => {
    amailProviderRef.current = provider
  }, [])

  const notifyAmailChanged = useCallback(() => {
    amailLastUpdatedAtRef.current = Date.now()
    if (!enabledRef.current || isApplyingRemoteRef.current) return
    scheduleCheckpointPublish()
    const hasOnlineSibling = linkedDevicesRef.current.some(
      (d) => d.lastSeenAt > 0 && Date.now() - d.lastSeenAt <= DEVICE_SYNC_ONLINE_TTL_MS
    )
    if (hasOnlineSibling) {
      void broadcastHello(false)
    }
  }, [scheduleCheckpointPublish, broadcastHello])

  const resetAll = useCallback(() => {
    if (checkpointTimerRef.current !== null) {
      window.clearTimeout(checkpointTimerRef.current)
      checkpointTimerRef.current = null
    }
    if (msgSyncNotifyTimerRef.current !== null) {
      window.clearTimeout(msgSyncNotifyTimerRef.current)
      msgSyncNotifyTimerRef.current = null
    }

    clearDeviceSyncState()
    saveCustomDeviceLabel(null)
    const freshId = resetDeviceId()
    deviceIdRef.current = freshId
    setDeviceId(freshId)
    const freshLabel = detectDeviceLabel()
    deviceLabelRef.current = freshLabel
    setDeviceLabelState(freshLabel)
    enabledRef.current = true
    setEnabledState(true)
    crdtRef.current = createEmptyCrdtState()
    crdtInitializedForOwnerRef.current = false
    pendingAppliedNicknameRef.current = null
    stateRevisionRef.current = 0
    checkpointHydratedRef.current = false
    setCheckpointIssue(null)
    checkpointDirtyRef.current = false
    savePendingCheckpoint(ownerPubkeyRef.current ?? '', false)
    seenEventIdsRef.current.clear()
    amailTransfersRef.current.clear()
    lastStateSentToPeerRef.current.clear()
    lastReqSentToPeerRef.current.clear()
    lastPeerDigestsRef.current.clear()
    linkedDevicesRef.current = []
    setLinkedDevices([])
    lastSyncedAtRef.current = null
    setLastSyncedAt(null)
    setSyncedItemsCount(0)
    setIsSyncing(false)
  }, [])

  const onlineSiblingCount = useMemo(
    () => linkedDevices.filter((d) => d.online).length,
    [linkedDevices]
  )

  const deviceSync = useMemo<DeviceSyncEngine>(
    () => ({
      enabled,
      setEnabled,
      deviceId,
      deviceLabel,
      setDeviceLabel,
      linkedDevices,
      onlineSiblingCount,
      lastSyncedAt,
      checkpointIssue,
      isSyncing,
      syncedItemsCount,
      syncNow,
      removeLinkedDevice,
      resetAll,
    }),
    [
      enabled,
      setEnabled,
      deviceId,
      deviceLabel,
      setDeviceLabel,
      linkedDevices,
      onlineSiblingCount,
      lastSyncedAt,
      checkpointIssue,
      isSyncing,
      syncedItemsCount,
      syncNow,
      removeLinkedDevice,
      resetAll,
    ]
  )

  return {
    deviceSync,
    registerAmailSyncProvider,
    notifyAmailChanged,
  }
}
