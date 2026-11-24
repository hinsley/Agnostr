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
  SyncedRecentMessagesTail,
  SyncedWalletState,
  WalletSyncProvider,
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
  buildSignedDeviceSyncCheckpointEvent,
  buildSignedDeviceSyncEphemeralEvent,
  buildWalletChunkPackets,
  computeCrdtStateHash,
  computeJsonDigest,
  computeScopeDigest,
  createEmptyCrdtState,
  detectDeviceLabel,
  DEVICE_SYNC_CHECKPOINT_D_TAG,
  DEVICE_SYNC_CHECKPOINT_DEBOUNCE_MS,
  DEVICE_SYNC_HELLO_INTERVAL_MS,
  DEVICE_SYNC_ONLINE_TTL_MS,
  DEVICE_SYNC_TAG,
  extractActiveBlocked,
  extractActivePeerNotes,
  extractActiveServers,
  extractActiveTrusted,
  fitCheckpointStateWithinBudget,
  KIND_DEVICE_SYNC_CHECKPOINT,
  KIND_DEVICE_SYNC_EPHEMERAL,
  MAX_NIP44_CHUNK_BYTES,
  mergeCrdtStates,
  parseDeviceSyncCheckpointEvent,
  parseDeviceSyncEphemeralEvent,
  reconcileLocalSnapshotIntoCrdt,
  type LocalSyncSnapshot,
} from '../lib/deviceSync.ts'
import type { IdentityManager } from '../lib/identity.ts'
import type { RelayPool } from '../lib/relayPool.ts'
import {
  clearDeviceSyncState,
  isEphemeralPendingMessage,
  isStuckMediaPlaceholder,
  loadChannelMessages,
  loadDeviceSyncState,
  loadOrCreateDeviceId,
  loadServerChannelMessages,
  resetDeviceId,
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
  pinnedChannels: PinnedChannel[]
  dmClearedAt: Record<string, number>
  lightningAddress: string | null
  peerNotes: Record<string, string>
  dmThreads: DmThread[]
  activeGeohash: string
  activeRadioMessages: GeoMessage[]
  activeServerMessages: ServerMessage[]
  initialHealCheckpoint?: boolean
  onApplyServers: (servers: ServerSummary[]) => void
  onApplyTrusted: (trusted: TrustedPeerEntry[]) => void
  onApplyBlocked: (blocked: string[]) => void
  onApplyPinned: (pinned: PinnedChannel[]) => void
  onApplyDmClearedAt: (clearedAt: Record<string, number>) => number
  onApplyLightningAddress: (addr: string | null) => void
  onApplyNickname: (nick: string) => void
  onApplyPeerNotes: (notes: Record<string, string>) => void
  onMergeDmMessages: (
    peerPubkey: string,
    messages: DmMessage[],
    peerMeta?: { peerNickname?: string; protocol?: DmProtocol }
  ) => number
  onMergeServerMessages: (serverId: string, channelId: string, messages: ServerMessage[]) => number
  onMergeRadioMessages: (channelKey: string, messages: GeoMessage[]) => number
}

interface PendingAmailTransfer {
  totalChunks: number
  updatedAt: number
  hash: string
  chunks: Map<number, string>
  startedAt: number
}

interface PendingWalletTransfer {
  totalChunks: number
  fingerprint: string
  updatedAt: number
  hash: string
  chunks: Map<number, string>
  startedAt: number
}

const SIBLING_STATE_COOLDOWN_MS = 3_000
const SIBLING_REQ_COOLDOWN_MS = 4_000
const MAX_SEEN_SYNC_EVENTS = 1200

export function useDeviceSync(options: UseDeviceSyncOptions): {
  deviceSync: DeviceSyncEngine
  registerAmailSyncProvider: (provider: AmailSyncProvider | null) => void
  notifyAmailChanged: () => void
  registerWalletSyncProvider: (provider: WalletSyncProvider | null) => void
  notifyWalletChanged: () => void
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
    pinnedChannels,
    dmClearedAt,
    lightningAddress,
    peerNotes,
    dmThreads,
    activeGeohash,
    activeRadioMessages,
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
    onMergeDmMessages,
    onMergeServerMessages,
    onMergeRadioMessages,
  } = options

  const persistedInitial = useMemo(() => loadDeviceSyncState(), [])

  const [deviceId, setDeviceId] = useState<string>(() => loadOrCreateDeviceId())
  const deviceLabel = useMemo(() => detectDeviceLabel(), [])
  const [enabled, setEnabledState] = useState<boolean>(() => persistedInitial?.enabled ?? true)
  const [linkedDevices, setLinkedDevices] = useState<LinkedDeviceInfo[]>(() =>
    persistedInitial && persistedInitial.ownerPubkey === masterPubkey.toLowerCase()
      ? persistedInitial.linkedDevices.map((d) => ({ ...d, online: false }))
      : []
  )
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(() =>
    persistedInitial && persistedInitial.ownerPubkey === masterPubkey.toLowerCase()
      ? persistedInitial.lastSyncedAt
      : null
  )
  const [isSyncing, setIsSyncing] = useState<boolean>(false)
  const [syncedItemsCount, setSyncedItemsCount] = useState<number>(0)

  const deviceIdRef = useRef<string>(deviceId)
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
  const checkpointDirtyRef = useRef<boolean>(Boolean(initialHealCheckpoint))
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
  const walletProviderRef = useRef<WalletSyncProvider | null>(null)
  const walletTransfersRef = useRef<Map<string, PendingWalletTransfer>>(new Map())
  const walletNotifyTimerRef = useRef<number | null>(null)
  const subSeqRef = useRef<number>(0)

  // Always-fresh refs for callbacks and live snapshots
  const getSyncRelayUrlsRef = useRef(getSyncRelayUrls)
  const snapshotRef = useRef<LocalSyncSnapshot>({
    joinedServers,
    trustedPubkeys,
    blockedPubkeys,
    pinnedChannels,
    dmClearedAt,
    lightningAddress,
    nickname,
    peerNotes,
  })
  const dmThreadsRef = useRef<DmThread[]>(dmThreads)
  const activeGeohashRef = useRef<string>(activeGeohash)
  const activeRadioMessagesRef = useRef<GeoMessage[]>(activeRadioMessages)
  const activeServerMessagesRef = useRef<ServerMessage[]>(activeServerMessages)

  const callbacksRef = useRef({
    onApplyServers,
    onApplyTrusted,
    onApplyBlocked,
    onApplyPinned,
    onApplyDmClearedAt,
    onApplyLightningAddress,
    onApplyNickname,
    onApplyPeerNotes,
    onMergeDmMessages,
    onMergeServerMessages,
    onMergeRadioMessages,
  })

  useLayoutEffect(() => {
    deviceIdRef.current = deviceId
  }, [deviceId])

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
      pinnedChannels,
      dmClearedAt,
      lightningAddress,
      nickname,
      peerNotes,
    }
  }, [
    joinedServers,
    trustedPubkeys,
    blockedPubkeys,
    pinnedChannels,
    dmClearedAt,
    lightningAddress,
    nickname,
    peerNotes,
  ])

  useLayoutEffect(() => {
    dmThreadsRef.current = dmThreads
    activeGeohashRef.current = activeGeohash
    activeRadioMessagesRef.current = activeRadioMessages
    activeServerMessagesRef.current = activeServerMessages
  }, [dmThreads, activeGeohash, activeRadioMessages, activeServerMessages])

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
      onMergeDmMessages,
      onMergeServerMessages,
      onMergeRadioMessages,
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
    onMergeDmMessages,
    onMergeServerMessages,
    onMergeRadioMessages,
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

  const touchSiblingDevice = useCallback(
    (siblingId: string, label: string, nick: string) => {
      if (!siblingId || siblingId === deviceIdRef.current) return
      const now = Date.now()
      setLinkedDevices((prev) => {
        const idx = prev.findIndex((d) => d.deviceId === siblingId)
        const nextEntry: LinkedDeviceInfo = {
          deviceId: siblingId,
          label: label.trim().slice(0, 48) || 'Sibling Device',
          nickname: nick.trim().slice(0, 32),
          lastSeenAt: now,
          online: true,
        }
        let next: LinkedDeviceInfo[]
        if (idx !== -1) {
          next = [...prev]
          next[idx] = nextEntry
        } else {
          next = [nextEntry, ...prev].slice(0, 16)
        }
        next.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
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

  /** Collects current local messages per scope (DM, Server channels, Pinned/Active Radio) */
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
          peerNickname: thread.peerNickname,
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

    const radioMap = new Map<string, GeoMessage[]>()
    const radioKeys = new Set<string>([
      activeGeohashRef.current,
      ...snapshotRef.current.pinnedChannels.map((p) => p.geohash),
    ])
    for (const gh of Array.from(radioKeys).slice(0, 16)) {
      const source =
        gh === activeGeohashRef.current && activeRadioMessagesRef.current.length > 0
          ? activeRadioMessagesRef.current
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
        radioMap.set(gh, clean.slice(-150))
      }
    }

    return { dmMap, serverMap, radioMap }
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

  const getWalletExportInfo = useCallback(async (): Promise<{
    initialized: true
    fingerprint: string
    updatedAt: number
    hash: string
    payload: unknown
  } | null> => {
    const provider = walletProviderRef.current
    if (!provider) return null
    try {
      const info = await provider.exportSyncState()
      if (!info || !info.initialized || !info.fingerprint || !info.payload) return null
      const cleanFp = info.fingerprint.trim()
      if (!cleanFp) return null
      const updatedAt =
        typeof info.updatedAt === 'number' && Number.isFinite(info.updatedAt)
          ? info.updatedAt
          : Date.now()
      return {
        initialized: true,
        fingerprint: cleanFp,
        updatedAt,
        hash: computeJsonDigest(info.payload),
        payload: info.payload,
      }
    } catch {
      return null
    }
  }, [])

  const computeLocalMsgDigests = useCallback(async (): Promise<DeviceSyncMsgDigests> => {
    const { dmMap, serverMap, radioMap } = collectLocalMessageBuckets()
    const dm: Record<string, DeviceSyncScopeDigest> = {}
    for (const [pk, entry] of dmMap.entries()) {
      dm[pk] = computeScopeDigest(entry.messages)
    }
    const server: Record<string, DeviceSyncScopeDigest> = {}
    for (const [k, msgs] of serverMap.entries()) {
      server[k] = computeScopeDigest(msgs)
    }
    const radio: Record<string, DeviceSyncScopeDigest> = {}
    for (const [gh, msgs] of radioMap.entries()) {
      radio[gh] = computeScopeDigest(msgs)
    }
    const [amailInfo, walletInfo] = await Promise.all([
      getAmailExportInfo(),
      getWalletExportInfo(),
    ])
    return {
      dm,
      server,
      radio,
      amail: amailInfo ? { updatedAt: amailInfo.updatedAt, hash: amailInfo.hash } : null,
      wallet: walletInfo
        ? {
            initialized: true,
            fingerprint: walletInfo.fingerprint,
            updatedAt: walletInfo.updatedAt,
            hash: walletInfo.hash,
          }
        : null,
    }
  }, [collectLocalMessageBuckets, getAmailExportInfo, getWalletExportInfo])

  const buildRecentMessagesTail = useCallback((): SyncedRecentMessagesTail => {
    const { dmMap, serverMap, radioMap } = collectLocalMessageBuckets()
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

    const radio: Record<string, GeoMessage[]> = {}
    const radioEntries = Array.from(radioMap.entries())
      .sort((a, b) => {
        const aTs = a[1][a[1].length - 1]?.createdAt ?? 0
        const bTs = b[1][b[1].length - 1]?.createdAt ?? 0
        return bTs - aTs
      })
      .slice(0, 6)
    for (const [gh, msgs] of radioEntries) {
      radio[gh] = msgs.slice(-10)
    }

    return { dm, server, radio }
  }, [collectLocalMessageBuckets])

  const publishEphemeralPacket = useCallback(
    async (packet: DeviceSyncWirePacket, allowExtensionPrompt = false): Promise<boolean> => {
      if (!enabledRef.current) return false
      const material = identityManager.getMasterKeyMaterial()
      if (!material.secretKey && !allowExtensionPrompt) return false
      const relays = getSyncRelayUrlsRef.current()
      if (relays.length === 0) return false
      const signed = await buildSignedDeviceSyncEphemeralEvent(packet, material, allowExtensionPrompt)
      if (!signed) return false
      seenEventIdsRef.current.add(signed.id)
      const res = await relayPool.publish(relays, signed, 3500)
      return res.acceptedRelays.length > 0
    },
    [identityManager, relayPool]
  )

  const publishCheckpointNow = useCallback(
    async (allowExtensionPrompt = false): Promise<boolean> => {
      if (!enabledRef.current) return false
      const material = identityManager.getMasterKeyMaterial()
      if (!material.secretKey && !allowExtensionPrompt) return false
      const relays = getSyncRelayUrlsRef.current()
      if (relays.length === 0) return false

      const [amailInfo, walletInfo] = await Promise.all([
        getAmailExportInfo(),
        getWalletExportInfo(),
      ])
      const walletSnapshot: SyncedWalletState | null = walletInfo
        ? {
            updatedAt: walletInfo.updatedAt,
            fingerprint: walletInfo.fingerprint,
            hash: walletInfo.hash,
            payload: walletInfo.payload,
          }
        : null
      const recentTail = buildRecentMessagesTail()
      const bounded = fitCheckpointStateWithinBudget(
        crdtRef.current,
        amailInfo,
        recentTail,
        MAX_NIP44_CHUNK_BYTES,
        walletSnapshot
      )

      const signed = await buildSignedDeviceSyncCheckpointEvent(
        bounded,
        material,
        allowExtensionPrompt
      )
      if (!signed) return false
      seenEventIdsRef.current.add(signed.id)
      checkpointDirtyRef.current = false
      const res = await relayPool.publish(relays, signed, 4500)
      if (res.acceptedRelays.length > 0) {
        recordSyncedActivity(0)
        return true
      }
      return false
    },
    [
      identityManager,
      relayPool,
      getAmailExportInfo,
      getWalletExportInfo,
      buildRecentMessagesTail,
      recordSyncedActivity,
    ]
  )

  const scheduleCheckpointPublish = useCallback(() => {
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
      const packet: DeviceSyncHelloPacket = {
        v: 1,
        type: 'sync-hello',
        deviceId: deviceIdRef.current,
        deviceLabel,
        nickname: snapshotRef.current.nickname,
        ts: Date.now(),
        stateRevision: stateRevisionRef.current,
        stateHash: computeCrdtStateHash(crdtRef.current),
        msgDigests,
      }
      lastHelloSentAtRef.current = Date.now()
      return await publishEphemeralPacket(packet, allowExtensionPrompt)
    },
    [identityManager, deviceLabel, computeLocalMsgDigests, publishEphemeralPacket]
  )

  const sendStateToPeer = useCallback(
    async (targetDeviceId?: string, allowExtensionPrompt = false): Promise<boolean> => {
      if (!enabledRef.current) return false
      const key = targetDeviceId ?? '__broadcast__'
      const now = Date.now()
      const lastSent = lastStateSentToPeerRef.current.get(key) ?? 0
      if (!allowExtensionPrompt && now - lastSent < SIBLING_STATE_COOLDOWN_MS) {
        return false
      }
      lastStateSentToPeerRef.current.set(key, now)

      const [amailInfo, walletInfo] = await Promise.all([
        getAmailExportInfo(),
        getWalletExportInfo(),
      ])
      const walletSnapshot: SyncedWalletState | null = walletInfo
        ? {
            updatedAt: walletInfo.updatedAt,
            fingerprint: walletInfo.fingerprint,
            hash: walletInfo.hash,
            payload: walletInfo.payload,
          }
        : null
      const statePayload = fitCheckpointStateWithinBudget(
        crdtRef.current,
        amailInfo,
        undefined,
        MAX_NIP44_CHUNK_BYTES,
        walletSnapshot
      )
      const packet: DeviceSyncStatePacket = {
        v: 1,
        type: 'sync-state',
        deviceId: deviceIdRef.current,
        deviceLabel,
        nickname: snapshotRef.current.nickname,
        ...(targetDeviceId ? { targetDeviceId } : {}),
        ts: now,
        state: statePayload,
      }
      return await publishEphemeralPacket(packet, allowExtensionPrompt)
    },
    [deviceLabel, getAmailExportInfo, getWalletExportInfo, publishEphemeralPacket]
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
      if (tail.radio) {
        for (const [gh, msgs] of Object.entries(tail.radio)) {
          if (gh && Array.isArray(msgs) && msgs.length > 0) {
            const clean = msgs.filter(
              (m) => !isStuckMediaPlaceholder(m) && !isEphemeralPendingMessage(m)
            )
            if (clean.length < msgs.length) sawRemotePollution = true
            if (clean.length > 0) {
              added += callbacksRef.current.onMergeRadioMessages(gh, clean)
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
      const { merged, changed, diff } = mergeCrdtStates(crdtRef.current, remoteState)
      let itemsApplied = 0

      if (changed) {
        isApplyingRemoteRef.current = true
        try {
          crdtRef.current = merged
          stateRevisionRef.current += 1

          if (diff.dmClearedChanged) {
            callbacksRef.current.onApplyDmClearedAt(merged.dmClearedAt)
          }
          if (diff.blockedChanged) {
            callbacksRef.current.onApplyBlocked(extractActiveBlocked(merged))
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
            callbacksRef.current.onApplyNickname(merged.nickname.value)
          }
          if (diff.peerNotesChanged) {
            callbacksRef.current.onApplyPeerNotes(extractActivePeerNotes(merged))
          }
          itemsApplied += diff.itemsUpdated
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

      if (remoteState.wallet && walletProviderRef.current) {
        try {
          const res = await walletProviderRef.current.mergeSyncState(remoteState.wallet.payload)
          if (typeof res === 'number' && res > 0) {
            itemsApplied += res
          } else if (res === true) {
            itemsApplied += 1
          }
        } catch {
          // Ignore malformed optional wallet payload
        }
      }

      if (itemsApplied > 0 || changed) {
        recordSyncedActivity(itemsApplied)
      }
      return { changed, itemsApplied }
    },
    [applyRecentMessagesTail, recordSyncedActivity]
  )

  const requestMissingMessagesFromPeer = useCallback(
    async (peerDeviceId: string, remoteDigests: DeviceSyncMsgDigests, bypassCooldown = false) => {
      const now = Date.now()
      const lastReq = lastReqSentToPeerRef.current.get(peerDeviceId) ?? 0
      if (!bypassCooldown && now - lastReq < SIBLING_REQ_COOLDOWN_MS) return

      const { dmMap, serverMap, radioMap } = collectLocalMessageBuckets()
      const localDigests = await computeLocalMsgDigests()
      const blocked = new Set(snapshotRef.current.blockedPubkeys.map((p) => p.toLowerCase()))
      const scopes: DeviceSyncScopeRequest[] = []

      for (const [pk, remoteDigest] of Object.entries(remoteDigests.dm)) {
        if (!remoteDigest || remoteDigest.count <= 0 || blocked.has(pk.toLowerCase())) continue
        const localDigest = localDigests.dm[pk]
        if (!localDigest || localDigest.hash !== remoteDigest.hash) {
          const knownIds = (dmMap.get(pk)?.messages ?? []).map((m) => m.id).slice(-200)
          scopes.push({
            kind: 'dm',
            key: pk,
            knownIds,
            sinceSec: snapshotRef.current.dmClearedAt[pk.toLowerCase()],
          })
        }
        if (scopes.length >= 24) break
      }

      for (const [scopeKey, remoteDigest] of Object.entries(remoteDigests.server)) {
        if (scopes.length >= 36) break
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

      for (const [gh, remoteDigest] of Object.entries(remoteDigests.radio)) {
        if (scopes.length >= 44) break
        if (!remoteDigest || remoteDigest.count <= 0) continue
        const localDigest = localDigests.radio[gh]
        if (!localDigest || localDigest.hash !== remoteDigest.hash) {
          const knownIds = (radioMap.get(gh) ?? []).map((m) => m.id).slice(-200)
          scopes.push({ kind: 'radio', key: gh, knownIds })
        }
      }

      const wantAmail = Boolean(
        amailProviderRef.current &&
          remoteDigests.amail &&
          remoteDigests.amail.hash &&
          remoteDigests.amail.hash !== localDigests.amail?.hash
      )

      const remoteWallet = remoteDigests.wallet
      const localWallet = localDigests.wallet
      const wantWallet = Boolean(
        walletProviderRef.current &&
          remoteWallet?.initialized &&
          remoteWallet.fingerprint &&
          remoteWallet.hash &&
          (!localWallet?.initialized ||
            (localWallet.fingerprint === remoteWallet.fingerprint &&
              localWallet.hash !== remoteWallet.hash))
      )

      if (scopes.length > 0 || wantAmail || wantWallet) {
        lastReqSentToPeerRef.current.set(peerDeviceId, now)
        const req: DeviceSyncMsgReqPacket = {
          v: 1,
          type: 'sync-msg-req',
          deviceId: deviceIdRef.current,
          targetDeviceId: peerDeviceId,
          ts: now,
          scopes,
          ...(wantAmail ? { wantAmail: true } : {}),
          ...(wantWallet ? { wantWallet: true } : {}),
        }
        void publishEphemeralPacket(req, false)
      }
    },
    [collectLocalMessageBuckets, computeLocalMsgDigests, publishEphemeralPacket]
  )

  const handleIncomingWirePacket = useCallback(
    async (packet: DeviceSyncWirePacket) => {
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
        touchSiblingDevice(packet.deviceId, packet.deviceLabel, packet.nickname)
        const remoteHashBefore = computeCrdtStateHash(packet.state)
        const { changed } = await applyMergedRemoteCrdt(packet.state)
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
        const { dmMap, serverMap, radioMap } = collectLocalMessageBuckets()
        for (const req of packet.scopes.slice(0, 32)) {
          const known = new Set(req.knownIds)
          if (req.kind === 'dm') {
            const bucket = dmMap.get(req.key.toLowerCase())
            if (!bucket) continue
            const missing = bucket.messages.filter(
              (m) => !known.has(m.id) && (!req.sinceSec || m.createdAt > req.sinceSec)
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
              await publishEphemeralPacket(chunk, false)
            }
          } else if (req.kind === 'radio') {
            const msgs = radioMap.get(req.key)
            if (!msgs) continue
            const missing = msgs.filter((m) => !known.has(m.id))
            if (missing.length === 0) continue
            const chunks = buildMessageChunkPackets({
              deviceId: deviceIdRef.current,
              targetDeviceId: packet.deviceId,
              scopeKind: 'radio',
              scopeKey: req.key,
              messages: missing,
            })
            for (const chunk of chunks) {
              await publishEphemeralPacket(chunk, false)
            }
          }
        }

        if (packet.wantAmail) {
          const amailInfo = await getAmailExportInfo()
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
              await publishEphemeralPacket(chunk, false)
            }
          }
        }

        if (packet.wantWallet) {
          const walletInfo = await getWalletExportInfo()
          if (walletInfo) {
            const chunks = buildWalletChunkPackets({
              deviceId: deviceIdRef.current,
              targetDeviceId: packet.deviceId,
              transferId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
              fingerprint: walletInfo.fingerprint,
              updatedAt: walletInfo.updatedAt,
              hash: walletInfo.hash,
              payload: walletInfo.payload,
            })
            for (const chunk of chunks) {
              await publishEphemeralPacket(chunk, false)
            }
          }
        }
        return
      }

      if (packet.type === 'sync-msg-chunk') {
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
        } else if (packet.scopeKind === 'radio') {
          added = callbacksRef.current.onMergeRadioMessages(
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
          transfer = {
            totalChunks: packet.totalChunks,
            updatedAt: packet.updatedAt,
            hash: packet.hash,
            chunks: new Map(),
            startedAt: now,
          }
          amailTransfersRef.current.set(tKey, transfer)
        }
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
            const res = await amailProviderRef.current.mergeSyncState(parsed)
            const count = typeof res === 'number' ? res : res === true ? 1 : 0
            if (count > 0) {
              recordSyncedActivity(count)
            }
          } catch {
            // Ignore malformed reassembled payload
          }
        }
        return
      }

      if (packet.type === 'sync-wallet-chunk') {
        if (!walletProviderRef.current || packet.totalChunks <= 0 || packet.totalChunks > 64) {
          return
        }
        const tKey = `${packet.deviceId}:${packet.transferId}`
        const now = Date.now()
        // Prune stale incomplete transfers (> 90s old)
        for (const [k, v] of walletTransfersRef.current.entries()) {
          if (now - v.startedAt > 90_000) {
            walletTransfersRef.current.delete(k)
          }
        }
        let transfer = walletTransfersRef.current.get(tKey)
        if (!transfer) {
          transfer = {
            totalChunks: packet.totalChunks,
            fingerprint: packet.fingerprint,
            updatedAt: packet.updatedAt,
            hash: packet.hash,
            chunks: new Map(),
            startedAt: now,
          }
          walletTransfersRef.current.set(tKey, transfer)
        }
        transfer.chunks.set(packet.chunkIndex, packet.data)
        if (transfer.chunks.size >= transfer.totalChunks) {
          walletTransfersRef.current.delete(tKey)
          let combined = ''
          for (let i = 0; i < transfer.totalChunks; i += 1) {
            const part = transfer.chunks.get(i)
            if (typeof part !== 'string') return
            combined += part
          }
          try {
            const parsed: unknown = JSON.parse(combined)
            const res = await walletProviderRef.current.mergeSyncState(parsed)
            const count = typeof res === 'number' ? res : res === true ? 1 : 0
            if (count > 0) {
              recordSyncedActivity(count)
              scheduleCheckpointPublish()
            }
          } catch {
            // Ignore malformed reassembled wallet payload
          }
        }
      }
    },
    [
      touchSiblingDevice,
      sendStateToPeer,
      requestMissingMessagesFromPeer,
      collectLocalMessageBuckets,
      publishEphemeralPacket,
      applyMergedRemoteCrdt,
      scheduleCheckpointPublish,
      getAmailExportInfo,
      getWalletExportInfo,
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
    stateRevisionRef.current = 0
    checkpointHydratedRef.current = false
    checkpointDirtyRef.current = false
    seenEventIdsRef.current.clear()
    amailTransfersRef.current.clear()
    walletTransfersRef.current.clear()
    if (walletNotifyTimerRef.current !== null) {
      window.clearTimeout(walletNotifyTimerRef.current)
      walletNotifyTimerRef.current = null
    }
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
    const { crdt, changed } = reconcileLocalSnapshotIntoCrdt(
      crdtRef.current,
      {
        joinedServers,
        trustedPubkeys,
        blockedPubkeys,
        pinnedChannels,
        dmClearedAt,
        lightningAddress,
        nickname,
        peerNotes,
      },
      Date.now(),
      isInitialSeed
    )
    crdtInitializedForOwnerRef.current = true
    if (!changed) return

    crdtRef.current = crdt
    stateRevisionRef.current += 1
    persistLocalJournal()

    if (!enabledRef.current) return
    if (!isInitialSeed) {
      scheduleCheckpointPublish()
      const hasOnlineSibling = linkedDevicesRef.current.some(
        (d) => Date.now() - d.lastSeenAt <= DEVICE_SYNC_ONLINE_TTL_MS
      )
      if (hasOnlineSibling) {
        void sendStateToPeer(undefined, false)
      }
    }
  }, [
    masterPubkey,
    joinedServers,
    trustedPubkeys,
    blockedPubkeys,
    pinnedChannels,
    dmClearedAt,
    lightningAddress,
    nickname,
    peerNotes,
    persistLocalJournal,
    scheduleCheckpointPublish,
    sendStateToPeer,
  ])

  // When new local messages appear (sent or received), silently nudge online siblings & refresh checkpoint
  const msgActivitySignature = useMemo(() => {
    let dmCount = 0
    let dmLatest = 0
    for (const t of dmThreads) {
      dmCount += t.messages.length
      if (t.lastMessageAt > dmLatest) dmLatest = t.lastMessageAt
    }
    const radioTail = activeRadioMessages[activeRadioMessages.length - 1]?.id ?? ''
    const serverTail = activeServerMessages[activeServerMessages.length - 1]?.id ?? ''
    return `${dmCount}:${dmLatest}:${activeRadioMessages.length}:${radioTail}:${activeServerMessages.length}:${serverTail}`
  }, [dmThreads, activeRadioMessages, activeServerMessages])

  const prevMsgSigRef = useRef<string>(msgActivitySignature)
  useEffect(() => {
    if (prevMsgSigRef.current === msgActivitySignature) return
    prevMsgSigRef.current = msgActivitySignature
    if (!enabledRef.current || isApplyingRemoteRef.current || !checkpointHydratedRef.current) {
      return
    }
    scheduleCheckpointPublish()
    const hasOnlineSibling = linkedDevicesRef.current.some(
      (d) => Date.now() - d.lastSeenAt <= DEVICE_SYNC_ONLINE_TTL_MS
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
    let newestCheckpointEvent: NostrEvent | null = null
    let checkpointEoseDone = false

    const applyHydratedCheckpoint = async () => {
      if (cancelled || checkpointHydratedRef.current) return
      checkpointHydratedRef.current = true
      if (newestCheckpointEvent) {
        const parsed = await parseDeviceSyncCheckpointEvent(newestCheckpointEvent, material, false)
        if (!cancelled && parsed) {
          await applyMergedRemoteCrdt(parsed)
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
            if (!newestCheckpointEvent || ev.created_at > newestCheckpointEvent.created_at) {
              newestCheckpointEvent = ev
            }
            return
          }
          seenEventIdsRef.current.add(ev.id)
          void parseDeviceSyncCheckpointEvent(ev, material, false).then((parsed) => {
            if (!cancelled && parsed) {
              void applyMergedRemoteCrdt(parsed)
            }
          })
        },
        onEose: () => {
          if (cancelled || checkpointEoseDone) return
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
            if (!cancelled && packet) {
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

    const intervalId = window.setInterval(() => {
      if (!cancelled) void broadcastHello(false)
    }, DEVICE_SYNC_HELLO_INTERVAL_MS)

    const handleVisibility = () => {
      if (cancelled || document.visibilityState !== 'visible') return
      if (Date.now() - lastHelloSentAtRef.current < 5_000) return
      void broadcastHello(false)
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility)
    }

    // Periodic 15s refresh of sibling online indicators (120s TTL)
    const onlineTick = window.setInterval(() => {
      const now = Date.now()
      setLinkedDevices((prev) => {
        let changed = false
        const next = prev.map((d) => {
          const isOnline = now - d.lastSeenAt <= DEVICE_SYNC_ONLINE_TTL_MS
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
      if (walletNotifyTimerRef.current !== null) {
        window.clearTimeout(walletNotifyTimerRef.current)
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
      const fetchedCheckpoint = await new Promise<NostrEvent | null>((resolve) => {
        let newest: NostrEvent | null = null
        let settled = false
        let unsub: (() => void) | null = null
        const finish = () => {
          if (settled) return
          settled = true
          window.clearTimeout(timer)
          unsub?.()
          resolve(newest)
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
                if (!newest || ev.created_at > newest.created_at) newest = ev
              }
            },
            onEose: finish,
          }
        )
      })

      if (fetchedCheckpoint) {
        const parsed = await parseDeviceSyncCheckpointEvent(fetchedCheckpoint, material, allowExt)
        if (parsed) {
          await applyMergedRemoteCrdt(parsed)
        }
      }
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
      (d) => Date.now() - d.lastSeenAt <= DEVICE_SYNC_ONLINE_TTL_MS
    )
    if (hasOnlineSibling) {
      void broadcastHello(false)
    }
  }, [scheduleCheckpointPublish, broadcastHello])

  const registerWalletSyncProvider = useCallback((provider: WalletSyncProvider | null) => {
    walletProviderRef.current = provider
  }, [])

  const notifyWalletChanged = useCallback(() => {
    if (!enabledRef.current || isApplyingRemoteRef.current) return
    scheduleCheckpointPublish()
    const hasOnlineSibling = linkedDevicesRef.current.some(
      (d) => Date.now() - d.lastSeenAt <= DEVICE_SYNC_ONLINE_TTL_MS
    )
    if (!hasOnlineSibling) return
    if (walletNotifyTimerRef.current !== null) {
      window.clearTimeout(walletNotifyTimerRef.current)
    }
    walletNotifyTimerRef.current = window.setTimeout(() => {
      walletNotifyTimerRef.current = null
      if (!enabledRef.current || isApplyingRemoteRef.current) return
      void broadcastHello(false)
      void sendStateToPeer(undefined, false)
    }, 600)
  }, [scheduleCheckpointPublish, broadcastHello, sendStateToPeer])

  const resetAll = useCallback(() => {
    if (checkpointTimerRef.current !== null) {
      window.clearTimeout(checkpointTimerRef.current)
      checkpointTimerRef.current = null
    }
    if (msgSyncNotifyTimerRef.current !== null) {
      window.clearTimeout(msgSyncNotifyTimerRef.current)
      msgSyncNotifyTimerRef.current = null
    }
    if (walletNotifyTimerRef.current !== null) {
      window.clearTimeout(walletNotifyTimerRef.current)
      walletNotifyTimerRef.current = null
    }
    clearDeviceSyncState()
    const freshId = resetDeviceId()
    deviceIdRef.current = freshId
    setDeviceId(freshId)
    enabledRef.current = true
    setEnabledState(true)
    crdtRef.current = createEmptyCrdtState()
    crdtInitializedForOwnerRef.current = false
    stateRevisionRef.current = 0
    checkpointHydratedRef.current = false
    checkpointDirtyRef.current = false
    seenEventIdsRef.current.clear()
    amailTransfersRef.current.clear()
    walletTransfersRef.current.clear()
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
      linkedDevices,
      onlineSiblingCount,
      lastSyncedAt,
      isSyncing,
      syncedItemsCount,
      syncNow,
      resetAll,
    }),
    [
      enabled,
      setEnabled,
      deviceId,
      deviceLabel,
      linkedDevices,
      onlineSiblingCount,
      lastSyncedAt,
      isSyncing,
      syncedItemsCount,
      syncNow,
      resetAll,
    ]
  )

  return {
    deviceSync,
    registerAmailSyncProvider,
    notifyAmailChanged,
    registerWalletSyncProvider,
    notifyWalletChanged,
  }
}
