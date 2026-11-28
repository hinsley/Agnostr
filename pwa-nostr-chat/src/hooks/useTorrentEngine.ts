import { sha256 } from '@noble/hashes/sha256'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Event as NostrEvent, EventTemplate, Filter } from 'nostr-tools'
import type { TurnServerConfig } from '../types/calls.ts'
import type { ToastLevel } from '../types/protocol.ts'
import type {
  PendingTorrentDownloadRequest,
  TorrentAttachment,
  TorrentCreateScopeContext,
  TorrentEngine,
  TorrentMeshBridge,
  TorrentShareRecord,
  TorrentShareScope,
  TorrentShareStatus,
  TorrentTransferState,
} from '../types/torrent.ts'
import { bytesToHex, encodeNpubSafe, type IdentityManager } from '../lib/identity.ts'
import type { RelayPool } from '../lib/relayPool.ts'
import {
  base64UrlDecode,
  buildTorrentDirectSignalTemplate,
  buildTorrentStatusEventTemplate,
  buildTorrentSwarmBroadcastTemplate,
  computeTorrentInfoHash,
  computeTorrentMerkleRoot,
  computeTorrentSwarmId,
  decryptTorrentPiece,
  encryptTorrentPiece,
  formatTorrentBytes,
  generateTorrentEncryption,
  getTorrentStatusDTag,
  getTorrentSwarmTag,
  KIND_TORRENT_SIGNAL,
  KIND_TORRENT_STATUS,
  MAX_TORRENT_FILE_BYTES,
  parseTorrentDirectSignalEvent,
  parseTorrentStatusEvent,
  parseTorrentSwarmBroadcastEvent,
  sanitizeTorrentFileName,
  selectTorrentPieceLength,
  TORRENT_DIRECT_SIGNAL_TAG,
  TORRENT_SIGNALING_RELAYS,
  type TorrentDirectSignalPayload,
  type TorrentSwarmBroadcastPayload,
} from '../lib/torrentProtocol.ts'
import {
  clearCachedRevocation,
  loadCachedRevocations,
  saveCachedRevocation,
  TorrentVaultStore,
  type StoredTorrentShare,
} from '../lib/torrentStore.ts'
import { TorrentSwarmManager } from '../lib/torrentSwarm.ts'

export interface UseTorrentEngineOptions {
  relayPool: RelayPool | null
  identityManager: IdentityManager
  masterPubkey: string
  ownPubkeys: Set<string>
  trustedSet: Set<string>
  blockedSet: Set<string>
  turnConfig: TurnServerConfig | null
  extraRelays: string[]
  activeScope?: { scope: TorrentShareScope; isEncryptedGroup?: boolean }
  meshBridge?: TorrentMeshBridge
  pushToast: (level: ToastLevel, title: string, detail?: string) => void
}

const MAX_SEEN_SIGNAL_IDS = 500
const REMOTE_STATUS_QUERY_TIMEOUT_MS = 1_800
const IDB_STATS_THROTTLE_MS = 1_500
const UI_STATS_THROTTLE_MS = 300

function stripStoredPieceHashes(stored: StoredTorrentShare): TorrentShareRecord {
  const { pieceHashes: _ignored, ...record } = stored
  void _ignored
  return record
}

function sortSharesActiveFirst(list: TorrentShareRecord[]): TorrentShareRecord[] {
  return [...list].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1
    return b.createdAt - a.createdAt
  })
}

export function useTorrentEngine(opts: UseTorrentEngineOptions): TorrentEngine {
  const {
    relayPool,
    identityManager,
    masterPubkey,
    ownPubkeys,
    trustedSet,
    blockedSet,
    turnConfig,
    extraRelays,
    activeScope,
    meshBridge,
    pushToast,
  } = opts

  const masterPkLower = masterPubkey.trim().toLowerCase()

  const [allStoredShares, setAllStoredShares] = useState<StoredTorrentShare[]>([])
  const [transfers, setTransfers] = useState<Record<string, TorrentTransferState>>({})
  const [closedBySender, setClosedBySender] = useState<Record<string, number>>(() =>
    loadCachedRevocations()
  )
  const [pendingDownloadRequest, setPendingDownloadRequest] =
    useState<PendingTorrentDownloadRequest | null>(null)
  const [sharesModalOpen, setSharesModalOpen] = useState<boolean>(false)

  const relayPoolRef = useRef<RelayPool | null>(relayPool)
  const masterPkRef = useRef<string>(masterPkLower)
  const ownPubkeysRef = useRef<Set<string>>(ownPubkeys)
  const trustedSetRef = useRef<Set<string>>(trustedSet)
  const blockedSetRef = useRef<Set<string>>(blockedSet)
  const turnConfigRef = useRef<TurnServerConfig | null>(turnConfig)
  const extraRelaysRef = useRef<string[]>(extraRelays)
  const activeScopeRef = useRef<{ scope: TorrentShareScope; isEncryptedGroup?: boolean } | undefined>(
    activeScope
  )
  const meshBridgeRef = useRef<TorrentMeshBridge | undefined>(meshBridge)
  const pushToastRef = useRef(pushToast)
  const saveLocalFileRef = useRef<(infoHash: string) => Promise<boolean>>(async () => false)
  const allSharesRef = useRef<Map<string, StoredTorrentShare>>(new Map())
  const closedBySenderRef = useRef<Record<string, number>>(closedBySender)
  const pendingDownloadRef = useRef<PendingTorrentDownloadRequest | null>(pendingDownloadRequest)
  const activeDownloadTorrentsRef = useRef<
    Map<
      string,
      {
        torrent: TorrentAttachment
        senderPubkey: string
        senderDisplayHandle: string
        relays: string[]
        scope: TorrentShareScope
        isEncryptedGroup: boolean
      }
    >
  >(new Map())
  const idbStatsTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const uiStatsSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const storeRef = useRef<TorrentVaultStore | null>(null)
  const swarmRef = useRef<TorrentSwarmManager | null>(null)
  const subSeqRef = useRef<number>(0)

  useLayoutEffect(() => {
    relayPoolRef.current = relayPool
    masterPkRef.current = masterPkLower
    ownPubkeysRef.current = ownPubkeys
    trustedSetRef.current = trustedSet
    blockedSetRef.current = blockedSet
    turnConfigRef.current = turnConfig
    extraRelaysRef.current = extraRelays
    activeScopeRef.current = activeScope
    meshBridgeRef.current = meshBridge
    pushToastRef.current = pushToast
  }, [
    relayPool,
    masterPkLower,
    ownPubkeys,
    trustedSet,
    blockedSet,
    turnConfig,
    extraRelays,
    activeScope,
    meshBridge,
    pushToast,
  ])

  useLayoutEffect(() => {
    closedBySenderRef.current = closedBySender
  }, [closedBySender])

  useLayoutEffect(() => {
    pendingDownloadRef.current = pendingDownloadRequest
  }, [pendingDownloadRequest])

  const getSignalRelays = useCallback((additional?: readonly string[]): string[] => {
    const out: string[] = []
    const seen = new Set<string>()
    for (const src of [additional ?? [], extraRelaysRef.current, TORRENT_SIGNALING_RELAYS]) {
      for (const raw of src) {
        if (typeof raw !== 'string') continue
        const clean = raw.trim()
        if (!/^wss?:\/\/[^\s]+$/i.test(clean)) continue
        const low = clean.toLowerCase()
        if (seen.has(low)) continue
        seen.add(low)
        out.push(clean)
        if (out.length >= 10) return out
      }
    }
    return out
  }, [])

  const isTrustedOrOwnSender = useCallback((senderPubkey: string): boolean => {
    const pk = senderPubkey.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pk)) return false
    if (blockedSetRef.current.has(pk)) return false
    return ownPubkeysRef.current.has(pk) || trustedSetRef.current.has(pk)
  }, [])

  const signAndPublishTemplate = useCallback(
    async (template: EventTemplate, relays: string[]): Promise<boolean> => {
      const pool = relayPoolRef.current
      const bridge = meshBridgeRef.current
      const canMesh = Boolean(bridge?.isMeshAvailable())
      const offlineMeshOnly = Boolean(bridge?.isOfflineMeshOnly())
      const canRelay = Boolean(pool && relays.length > 0 && !offlineMeshOnly)
      if (!canRelay && !canMesh) return false
      const material = identityManager.getMasterKeyMaterial()
      try {
        const signed = await identityManager.signEventWithMaterial(template, material)
        const tasks: Array<Promise<boolean>> = []
        if (canRelay && pool) {
          tasks.push(
            pool
              .publish(relays, signed)
              .then((res) => res.acceptedRelays.length > 0)
              .catch(() => false)
          )
        }
        if (canMesh && bridge) {
          tasks.push(bridge.sendEvent(signed).catch(() => false))
        }
        const results = await Promise.all(tasks)
        return results.some(Boolean)
      } catch {
        return false
      }
    },
    [identityManager]
  )

  const syncSharesStateFromRef = useCallback(() => {
    setAllStoredShares(Array.from(allSharesRef.current.values()))
  }, [])

  const recordClosedBySender = useCallback(
    (infoHash: string, closedAt: number) => {
      const cleanHash = infoHash.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(cleanHash)) return
      const ts = Number.isFinite(closedAt) && closedAt > 0 ? Math.floor(closedAt) : Date.now()
      saveCachedRevocation(cleanHash, ts)
      setClosedBySender((prev) => {
        if ((prev[cleanHash] ?? 0) >= ts) return prev
        const next = { ...prev, [cleanHash]: ts }
        closedBySenderRef.current = next
        return next
      })
      activeDownloadTorrentsRef.current.delete(cleanHash)
      // If we were re-seeding a downloaded copy of this torrent, stop immediately
      const existing = allSharesRef.current.get(cleanHash)
      if (existing && existing.isReSeed && existing.status === 'active') {
        const closedCopy: StoredTorrentShare = {
          ...existing,
          status: 'closed',
          closedAt: ts,
          activePeerCount: 0,
        }
        allSharesRef.current.set(cleanHash, closedCopy)
        syncSharesStateFromRef()
        void storeRef.current?.putShare(closedCopy)
        swarmRef.current?.closeShareConnections(cleanHash, 'sender-closed')
      }
      setTransfers((prev) => {
        const cur = prev[cleanHash]
        if (!cur) return prev
        return {
          ...prev,
          [cleanHash]: {
            ...cur,
            phase: cur.completedAvailable ? 'completed' : 'closed',
            isReSeeding: false,
            connectedPeers: 0,
            speedBytesPerSec: 0,
            error: cur.completedAvailable ? undefined : 'Downloads closed by sender.',
            updatedAt: Date.now(),
          },
        }
      })
    },
    [syncSharesStateFromRef]
  )

  // Initialize profile-scoped IndexedDB vault + WebRTC swarm manager and auto-resume persistent shares
  useEffect(() => {
    let cancelled = false
    const activeDownloadsMap = activeDownloadTorrentsRef.current
    const idbStatsTimers = idbStatsTimersRef.current
    const store = new TorrentVaultStore(masterPkLower)
    storeRef.current = store

    const swarm = new TorrentSwarmManager(store, {
      getSelfPubkey: () => masterPkRef.current,
      getOwnPubkeys: () => ownPubkeysRef.current,
      getTrustedSet: () => trustedSetRef.current,
      getBlockedSet: () => blockedSetRef.current,
      getTurnConfig: () => turnConfigRef.current,
      getActiveSeedShare: (infoHash) => {
        const s = allSharesRef.current.get(infoHash.toLowerCase())
        if (!s || s.status !== 'active' || !s.hasLocalData) return undefined
        return s
      },
      isOfflineMeshOnly: () => Boolean(meshBridgeRef.current?.isOfflineMeshOnly()),
      sendDirectSignal: async (recipientPubkey, payload: TorrentDirectSignalPayload, relays) => {
        const material = identityManager.getMasterKeyMaterial()
        if (material.mode === 'extension') return
        const targetRelays = getSignalRelays(relays)
        const tmpl = await buildTorrentDirectSignalTemplate({
          material,
          recipientPubkey,
          payload,
        })
        await signAndPublishTemplate(tmpl, targetRelays)
      },
      publishSwarmBroadcast: async (payload: TorrentSwarmBroadcastPayload, relays) => {
        const material = identityManager.getMasterKeyMaterial()
        if (material.mode === 'extension') return
        const targetRelays = getSignalRelays(relays)
        const tmpl = buildTorrentSwarmBroadcastTemplate(payload)
        await signAndPublishTemplate(tmpl, targetRelays)
      },
      onTransferUpdate: (state) => {
        if (cancelled) return
        if (
          state.phase === 'completed' ||
          state.phase === 'closed' ||
          state.phase === 'error' ||
          state.phase === 'idle'
        ) {
          activeDownloadTorrentsRef.current.delete(state.infoHash)
        }
        const isClosed = Boolean(closedBySenderRef.current[state.infoHash])
        const normalizedState: TorrentTransferState =
          isClosed && state.isReSeeding
            ? {
                ...state,
                phase: state.completedAvailable ? 'completed' : 'closed',
                isReSeeding: false,
              }
            : state
        setTransfers((prev) => ({ ...prev, [state.infoHash]: normalizedState }))
      },
      onShareStatsUpdate: (infoHash, patch) => {
        if (cancelled) return
        const clean = infoHash.toLowerCase()
        const existing = allSharesRef.current.get(clean)
        if (!existing) return
        const updated: StoredTorrentShare = {
          ...existing,
          activePeerCount:
            patch.activePeerCount !== undefined ? patch.activePeerCount : existing.activePeerCount,
          bytesUploaded: existing.bytesUploaded + (patch.bytesUploadedDelta ?? 0),
          completedDownloads: existing.completedDownloads + (patch.completedDownloadsDelta ?? 0),
        }
        allSharesRef.current.set(clean, updated)

        const isImmediateUi =
          Boolean(patch.completedDownloadsDelta) || patch.activePeerCount !== undefined
        if (isImmediateUi) {
          if (uiStatsSyncTimerRef.current !== null) {
            globalThis.clearTimeout(uiStatsSyncTimerRef.current)
            uiStatsSyncTimerRef.current = null
          }
          syncSharesStateFromRef()
        } else if (uiStatsSyncTimerRef.current === null) {
          uiStatsSyncTimerRef.current = globalThis.setTimeout(() => {
            uiStatsSyncTimerRef.current = null
            if (!cancelled) syncSharesStateFromRef()
          }, UI_STATS_THROTTLE_MS)
        }

        const isImmediateIdb =
          Boolean(patch.completedDownloadsDelta) || patch.activePeerCount === 0
        if (isImmediateIdb) {
          const pending = idbStatsTimers.get(clean)
          if (pending !== undefined) {
            globalThis.clearTimeout(pending)
            idbStatsTimers.delete(clean)
          }
          void store.putShare(updated)
        } else if (patch.bytesUploadedDelta && patch.bytesUploadedDelta > 0) {
          if (!idbStatsTimers.has(clean)) {
            const timer = globalThis.setTimeout(() => {
              idbStatsTimers.delete(clean)
              if (cancelled) return
              const latest = allSharesRef.current.get(clean)
              if (latest) void store.putShare(latest)
            }, IDB_STATS_THROTTLE_MS)
            idbStatsTimers.set(clean, timer)
          }
        }
      },
      onRemoteClosedBySender: (infoHash, closedAt) => {
        if (cancelled) return
        recordClosedBySender(infoHash, closedAt)
      },
      onDownloadCompleted: async (torrent, pieceHashes) => {
        if (cancelled) return
        const infoHash = torrent.infoHash.toLowerCase()
        const dlMeta = activeDownloadTorrentsRef.current.get(infoHash)
        const isClosed = Boolean(closedBySenderRef.current[infoHash])
        const origSender = (dlMeta?.senderPubkey || torrent.senderPubkey || '').toLowerCase()
        const targetLabel = dlMeta?.senderDisplayHandle
          ? `From ${dlMeta.senderDisplayHandle}`
          : torrent.fileName
        const reSeedShare: StoredTorrentShare = {
          infoHash,
          swarmId: torrent.swarmId.toLowerCase(),
          fileName: torrent.fileName,
          mime: torrent.mime,
          size: torrent.size,
          pieceLength: torrent.pieceLength,
          pieceCount: torrent.pieceCount,
          plaintextSha256: torrent.plaintextSha256.toLowerCase(),
          piecesRoot: torrent.piecesRoot.toLowerCase(),
          encryption: torrent.encryption,
          relays: getSignalRelays(torrent.relays),
          senderPubkey: origSender,
          scope: dlMeta?.scope ?? 'dm',
          ...(dlMeta?.isEncryptedGroup ? { isEncryptedGroup: true } : {}),
          targetLabel,
          status: isClosed ? 'closed' : 'active',
          hasLocalData: true,
          createdAt: torrent.createdAt ?? Date.now(),
          activePeerCount: 0,
          completedDownloads: 0,
          bytesUploaded: 0,
          isReSeed: true,
          pieceHashes,
        }
        allSharesRef.current.set(infoHash, reSeedShare)
        syncSharesStateFromRef()
        await store.putShare(reSeedShare)
        void saveLocalFileRef.current(infoHash)
        pushToastRef.current(
          'success',
          'P2P download verified',
          `${torrent.fileName} (${formatTorrentBytes(torrent.size)}) verified and saving — now seeding to trusted peers.`
        )
      },
    })
    swarmRef.current = swarm

    // Hydrate persisted shares (zero TTL / no expiry) and auto-resume seeding
    void store.listShares().then((loaded) => {
      if (cancelled) return
      const map = new Map<string, StoredTorrentShare>()
      const hydratedTransfers: Record<string, TorrentTransferState> = {}
      const cachedClosed = loadCachedRevocations()
      closedBySenderRef.current = cachedClosed
      setClosedBySender(cachedClosed)

      for (const s of loaded) {
        const cleanHash = s.infoHash.toLowerCase()
        const normalized: StoredTorrentShare = {
          ...s,
          infoHash: cleanHash,
          activePeerCount: 0,
        }
        map.set(cleanHash, normalized)
        if (normalized.isReSeed && normalized.hasLocalData) {
          const isReSeeding =
            normalized.status === 'active' && !cachedClosed[cleanHash]
          hydratedTransfers[cleanHash] = {
            infoHash: cleanHash,
            phase: isReSeeding ? 'seeding' : 'completed',
            piecesCompleted: normalized.pieceCount,
            pieceCount: normalized.pieceCount,
            bytesTransferred: normalized.size,
            totalBytes: normalized.size,
            speedBytesPerSec: 0,
            connectedPeers: 0,
            completedAvailable: true,
            isReSeeding,
            updatedAt: Date.now(),
          }
        }
      }
      allSharesRef.current = map
      setAllStoredShares(Array.from(map.values()))
      if (Object.keys(hydratedTransfers).length > 0) {
        setTransfers((prev) => ({ ...hydratedTransfers, ...prev }))
      }
    })

    return () => {
      cancelled = true
      if (uiStatsSyncTimerRef.current !== null) {
        globalThis.clearTimeout(uiStatsSyncTimerRef.current)
        uiStatsSyncTimerRef.current = null
      }
      for (const timer of idbStatsTimers.values()) {
        globalThis.clearTimeout(timer)
      }
      idbStatsTimers.clear()
      swarm.destroy()
      swarmRef.current = null
      store.close()
      storeRef.current = null
      allSharesRef.current.clear()
      activeDownloadsMap.clear()
    }
  }, [
    masterPkLower,
    identityManager,
    getSignalRelays,
    signAndPublishTemplate,
    syncSharesStateFromRef,
    recordClosedBySender,
  ])

  // Compute active swarm subscriptions key (ONLY subscribe when seeding or downloading!)
  const activeSwarmDescriptors = useMemo(() => {
    const bySwarm = new Map<
      string,
      {
        swarmId: string
        infoHashes: Set<string>
        senderPubkeys: Set<string>
        relays: Set<string>
      }
    >()
    const addEntry = (
      swarmId: string,
      infoHash: string,
      senderPubkey?: string,
      relays?: readonly string[]
    ) => {
      const sid = swarmId.toLowerCase()
      let entry = bySwarm.get(sid)
      if (!entry) {
        entry = {
          swarmId: sid,
          infoHashes: new Set(),
          senderPubkeys: new Set(),
          relays: new Set(),
        }
        bySwarm.set(sid, entry)
      }
      entry.infoHashes.add(infoHash.toLowerCase())
      if (senderPubkey) entry.senderPubkeys.add(senderPubkey.toLowerCase())
      for (const r of relays ?? []) entry.relays.add(r)
    }

    for (const share of allStoredShares) {
      if (share.status === 'active' && share.hasLocalData) {
        addEntry(share.swarmId, share.infoHash, share.isReSeed ? share.senderPubkey : undefined, share.relays)
      }
    }
    for (const [infoHash, t] of Object.entries(transfers)) {
      if (
        t.phase === 'checking' ||
        t.phase === 'waiting' ||
        t.phase === 'connecting' ||
        t.phase === 'downloading' ||
        t.phase === 'verifying'
      ) {
        const dl = activeDownloadTorrentsRef.current.get(infoHash)
        if (dl) {
          addEntry(dl.torrent.swarmId, infoHash, dl.senderPubkey, dl.relays)
        }
      }
    }
    return Array.from(bySwarm.values())
  }, [allStoredShares, transfers])

  const activeSwarmDescriptorsRef = useRef(activeSwarmDescriptors)
  useLayoutEffect(() => {
    activeSwarmDescriptorsRef.current = activeSwarmDescriptors
  }, [activeSwarmDescriptors])

  const activeSwarmKey = useMemo(
    () =>
      activeSwarmDescriptors
        .map((d) => {
          const hashes = Array.from(d.infoHashes).sort().join(',')
          const senders = Array.from(d.senderPubkeys).sort().join(',')
          const relays = Array.from(d.relays).sort().join(',')
          return `${d.swarmId}:${hashes}:${senders}:${relays}`
        })
        .sort()
        .join('|'),
    [activeSwarmDescriptors]
  )

  const hasMeshBridge = Boolean(meshBridge)

  // Live relay + BLE mesh subscriptions for active seeds + active downloads (direct NIP-44 signals + swarm broadcasts + live status)
  useEffect(() => {
    if (!masterPkLower || !activeSwarmKey) return
    const descriptors = activeSwarmDescriptorsRef.current
    if (descriptors.length === 0) return

    const extraList: string[] = []
    const swarmTags: string[] = []
    const statusDTags: string[] = []
    const statusAuthors = new Set<string>()
    const swarmToInfoHashes = new Map<string, string[]>()
    const statusDTagToEntry = new Map<
      string,
      { swarmId: string; infoHashes: string[]; senderPubkeys: Set<string> }
    >()

    for (const d of descriptors) {
      swarmTags.push(getTorrentSwarmTag(d.swarmId))
      const hashes = Array.from(d.infoHashes)
      swarmToInfoHashes.set(d.swarmId, hashes)
      for (const r of d.relays) extraList.push(r)
      if (d.senderPubkeys.size > 0) {
        const dTag = getTorrentStatusDTag(d.swarmId)
        statusDTags.push(dTag)
        for (const pk of d.senderPubkeys) statusAuthors.add(pk)
        statusDTagToEntry.set(dTag, {
          swarmId: d.swarmId,
          infoHashes: hashes,
          senderPubkeys: d.senderPubkeys,
        })
      }
    }

    const relays = getSignalRelays(extraList)
    const bridge = hasMeshBridge ? meshBridgeRef.current : undefined
    if ((!relayPool || relays.length === 0) && !bridge) return

    let cancelled = false
    const seenIds = new Set<string>()

    const handleIncomingEvent = (ev: NostrEvent) => {
      if (cancelled || !ev || typeof ev.id !== 'string') return
      const evId = ev.id.toLowerCase()
      if (seenIds.has(evId)) return
      seenIds.add(evId)
      if (seenIds.size > MAX_SEEN_SIGNAL_IDS) {
        const oldest = seenIds.values().next().value
        if (oldest) seenIds.delete(oldest)
      }

      if (ev.kind === KIND_TORRENT_STATUS) {
        const dTag = ev.tags.find((t) => t[0] === 'd' && typeof t[1] === 'string')?.[1]
        if (!dTag) return
        const entry = statusDTagToEntry.get(dTag)
        if (!entry) return
        const authorPk = ev.pubkey.trim().toLowerCase()
        if (!entry.senderPubkeys.has(authorPk)) return
        const parsed = parseTorrentStatusEvent(ev, entry.swarmId, authorPk)
        if (!parsed || parsed.status !== 'closed') return
        for (const ih of entry.infoHashes) {
          recordClosedBySender(ih, parsed.updatedAt)
          swarmRef.current?.abortDownloadAsClosed(ih)
        }
        return
      }

      if (ev.kind !== KIND_TORRENT_SIGNAL) return

      const isDirect = ev.tags.some(
        (t) => t[0] === 't' && t[1] === TORRENT_DIRECT_SIGNAL_TAG
      )
      if (isDirect) {
        const material = identityManager.getMasterKeyMaterial()
        if (material.mode === 'extension') return
        void parseTorrentDirectSignalEvent(ev, material).then((parsed) => {
          if (cancelled || !parsed) return
          void swarmRef.current?.handleDirectSignal(parsed.senderPubkey, parsed.payload)
        })
        return
      }

      for (const tag of ev.tags) {
        if (tag[0] !== 't' || typeof tag[1] !== 'string') continue
        if (!tag[1].startsWith('agnostr-torrent-')) continue
        const swarmId = tag[1].slice('agnostr-torrent-'.length).toLowerCase()
        const matchingHashes = swarmToInfoHashes.get(swarmId)
        if (!matchingHashes || matchingHashes.length === 0) continue
        const parsed = parseTorrentSwarmBroadcastEvent(ev, swarmId)
        if (!parsed) continue
        swarmRef.current?.handleSwarmBroadcast(
          parsed.senderPubkey,
          parsed.payload,
          matchingHashes
        )
        break
      }
    }

    let unsubRelay: (() => void) | null = null
    if (relayPool && relays.length > 0) {
      const since = Math.floor(Date.now() / 1000) - 30
      const filters: Filter[] = [
        {
          kinds: [KIND_TORRENT_SIGNAL],
          '#p': [masterPkLower],
          '#t': [TORRENT_DIRECT_SIGNAL_TAG],
          since,
          limit: 50,
        },
        {
          kinds: [KIND_TORRENT_SIGNAL],
          '#t': swarmTags,
          since,
          limit: 50,
        },
      ]
      if (statusDTags.length > 0 && statusAuthors.size > 0) {
        filters.push({
          kinds: [KIND_TORRENT_STATUS],
          authors: Array.from(statusAuthors),
          '#d': statusDTags,
          limit: Math.min(40, statusDTags.length * 2),
        })
      }

      unsubRelay = relayPool.subscribe(
        `agnostr-torrent-swarm-${++subSeqRef.current}`,
        relays,
        filters,
        {
          onEvent: handleIncomingEvent,
        }
      )
    }

    const unsubMesh = bridge ? bridge.subscribe(handleIncomingEvent) : null

    return () => {
      cancelled = true
      unsubRelay?.()
      unsubMesh?.()
    }
  }, [
    relayPool,
    masterPkLower,
    activeSwarmKey,
    hasMeshBridge,
    identityManager,
    getSignalRelays,
    recordClosedBySender,
  ])

  const checkRemoteStatus = useCallback(
    async (torrent: TorrentAttachment, senderPubkey: string): Promise<TorrentShareStatus> => {
      const infoHash = torrent.infoHash.trim().toLowerCase()
      const senderPk = senderPubkey.trim().toLowerCase()

      // STRICT TRUSTED-ONLY ENFORCEMENT: zero network requests for untrusted senders!
      if (!isTrustedOrOwnSender(senderPk)) {
        return closedBySenderRef.current[infoHash] ? 'closed' : 'active'
      }

      const pool = relayPoolRef.current
      const relays = getSignalRelays(torrent.relays)
      if (!pool || relays.length === 0 || meshBridgeRef.current?.isOfflineMeshOnly()) {
        return closedBySenderRef.current[infoHash] ? 'closed' : 'active'
      }

      const dTag = getTorrentStatusDTag(torrent.swarmId)
      return await new Promise<TorrentShareStatus>((resolve) => {
        let settled = false
        let bestStatus: TorrentShareStatus | null = null
        let bestUpdatedAt = 0

        const finish = () => {
          if (settled) return
          settled = true
          globalThis.clearTimeout(timer)
          unsub()
          if (bestStatus === 'closed') {
            recordClosedBySender(infoHash, bestUpdatedAt)
            swarmRef.current?.abortDownloadAsClosed(infoHash)
            resolve('closed')
            return
          }
          if (bestStatus === 'active' && bestUpdatedAt > (closedBySenderRef.current[infoHash] ?? 0)) {
            clearCachedRevocation(infoHash)
            setClosedBySender((prev) => {
              if (!(infoHash in prev)) return prev
              const next = { ...prev }
              delete next[infoHash]
              closedBySenderRef.current = next
              return next
            })
            resolve('active')
            return
          }
          resolve(closedBySenderRef.current[infoHash] ? 'closed' : 'active')
        }

        const timer = globalThis.setTimeout(finish, REMOTE_STATUS_QUERY_TIMEOUT_MS)
        const unsub = pool.subscribe(
          `agnostr-torrent-status-chk-${++subSeqRef.current}`,
          relays,
          [
            {
              kinds: [KIND_TORRENT_STATUS],
              authors: [senderPk],
              '#d': [dTag],
              limit: 2,
            },
          ],
          {
            onEvent: (ev) => {
              const parsed = parseTorrentStatusEvent(ev, torrent.swarmId, senderPk)
              if (!parsed) return
              if (parsed.updatedAt >= bestUpdatedAt) {
                bestUpdatedAt = parsed.updatedAt
                bestStatus = parsed.status
              }
            },
            onEose: () => {
              if (bestStatus !== null) {
                finish()
              }
            },
          }
        )
      })
    },
    [isTrustedOrOwnSender, getSignalRelays, recordClosedBySender]
  )

  const createAndSeedFile = useCallback(
    async (file: File, ctx: TorrentCreateScopeContext): Promise<TorrentAttachment | null> => {
      if (!file || typeof file.size !== 'number' || file.size < 1) {
        pushToastRef.current('error', 'Empty file', 'Choose a non-empty file to share via P2P.')
        return null
      }
      if (file.size > MAX_TORRENT_FILE_BYTES) {
        pushToastRef.current(
          'error',
          'File too large',
          `Maximum P2P torrent size is ${formatTorrentBytes(MAX_TORRENT_FILE_BYTES)}.`
        )
        return null
      }

      const store = storeRef.current
      if (!store) return null

      const fileName = sanitizeTorrentFileName(file.name)
      const mime =
        typeof file.type === 'string' && file.type.trim().length > 0
          ? file.type.trim().slice(0, 128)
          : 'application/octet-stream'
      const size = file.size
      const pieceLength = selectTorrentPieceLength(size)
      const pieceCount = Math.ceil(size / pieceLength)
      const encryption = generateTorrentEncryption()
      const keyBytes = base64UrlDecode(encryption.keyB64)
      const noncePrefixBytes = base64UrlDecode(encryption.noncePrefixB64)
      if (!keyBytes || !noncePrefixBytes) return null

      try {
        // Pass 1: Stream-hash plaintext pieces & full file without holding whole file in RAM
        const fullHasher = sha256.create()
        const pieceHashes: string[] = []
        for (let i = 0; i < pieceCount; i += 1) {
          const start = i * pieceLength
          const end = Math.min(start + pieceLength, size)
          const plainBuf = await file.slice(start, end).arrayBuffer()
          const plainBytes = new Uint8Array(plainBuf)
          fullHasher.update(plainBytes)
          pieceHashes.push(bytesToHex(sha256(plainBytes)))
        }

        const plaintextSha256 = bytesToHex(fullHasher.digest())
        const piecesRoot = computeTorrentMerkleRoot(pieceHashes)
        const infoHash = computeTorrentInfoHash({
          fileName,
          mime,
          size,
          pieceLength,
          pieceCount,
          plaintextSha256,
          piecesRoot,
        })
        const swarmId = computeTorrentSwarmId(infoHash, keyBytes)

        // Pass 2: Encrypt every piece with AES-256-GCM + AAD and persist into profile-scoped IndexedDB (NO expiry)
        for (let i = 0; i < pieceCount; i += 1) {
          const start = i * pieceLength
          const end = Math.min(start + pieceLength, size)
          const plainBuf = await file.slice(start, end).arrayBuffer()
          const encrypted = await encryptTorrentPiece({
            keyBytes,
            noncePrefixBytes,
            infoHash,
            pieceIndex: i,
            plaintext: new Uint8Array(plainBuf),
          })
          await store.putPiece(infoHash, i, encrypted)
        }

        const relays = getSignalRelays(ctx.extraRelays)
        const senderPubkey = masterPkRef.current
        const createdAt = Date.now()
        const shareRecord: StoredTorrentShare = {
          infoHash,
          swarmId,
          fileName,
          mime,
          size,
          pieceLength,
          pieceCount,
          plaintextSha256,
          piecesRoot,
          encryption,
          relays,
          senderPubkey,
          scope: ctx.scope,
          targetLabel: ctx.targetLabel,
          ...(ctx.targetPeerPubkey
            ? { targetPeerPubkey: ctx.targetPeerPubkey.trim().toLowerCase() }
            : {}),
          ...(ctx.isEncryptedGroup ? { isEncryptedGroup: true } : {}),
          status: 'active',
          hasLocalData: true,
          createdAt,
          activePeerCount: 0,
          completedDownloads: 0,
          bytesUploaded: 0,
          isReSeed: false,
          pieceHashes,
        }

        await store.putShare(shareRecord)
        clearCachedRevocation(infoHash)
        setClosedBySender((prev) => {
          if (!(infoHash in prev)) return prev
          const next = { ...prev }
          delete next[infoHash]
          closedBySenderRef.current = next
          return next
        })

        allSharesRef.current.set(infoHash, shareRecord)
        syncSharesStateFromRef()

        // Publish signed replaceable kind:30078 'active' status (best-effort)
        const statusTmpl = buildTorrentStatusEventTemplate({
          swarmId,
          status: 'active',
          updatedAt: createdAt,
        })
        void signAndPublishTemplate(statusTmpl, relays)

        return {
          v: 1,
          infoHash,
          swarmId,
          fileName,
          mime,
          size,
          pieceLength,
          pieceCount,
          plaintextSha256,
          piecesRoot,
          encryption,
          relays: relays.slice(0, 6),
          senderPubkey,
          createdAt,
        }
      } catch (err) {
        pushToastRef.current(
          'error',
          'Failed to prepare P2P file',
          err instanceof Error ? err.message : 'Unable to encrypt and chunk file.'
        )
        return null
      }
    },
    [getSignalRelays, signAndPublishTemplate, syncSharesStateFromRef]
  )

  const requestDownload = useCallback(
    (
      torrent: TorrentAttachment,
      senderPubkey: string,
      senderNickname: string,
      senderDisplayHandle: string
    ) => {
      const senderPk = senderPubkey.trim().toLowerCase()
      const infoHash = torrent.infoHash.trim().toLowerCase()

      // STRICT TRUSTED-ONLY ENFORCEMENT: hard-reject untrusted pubkeys with ZERO network requests!
      if (!isTrustedOrOwnSender(senderPk)) {
        pushToastRef.current(
          'error',
          'Trusted peers only',
          'You must trust this peer before downloading P2P files from them.'
        )
        return
      }

      if (closedBySenderRef.current[infoHash]) {
        pushToastRef.current(
          'info',
          'Downloads closed',
          'The sender has closed downloads for this file.'
        )
        return
      }

      const req: PendingTorrentDownloadRequest = {
        torrent: { ...torrent, infoHash, senderPubkey: senderPk },
        senderPubkey: senderPk,
        senderNickname: senderNickname.trim() || `anon${senderPk.slice(-4)}`,
        senderDisplayHandle: senderDisplayHandle.trim() || senderNickname.trim() || senderPk.slice(0, 12),
        senderNpub: encodeNpubSafe(senderPk),
      }
      pendingDownloadRef.current = req
      setPendingDownloadRequest(req)
    },
    [isTrustedOrOwnSender]
  )

  const cancelPendingDownload = useCallback(() => {
    pendingDownloadRef.current = null
    setPendingDownloadRequest(null)
  }, [])

  const confirmPendingDownload = useCallback(async (): Promise<void> => {
    // Atomically consume pendingDownloadRequest so this is the ONLY download entry point for non-own files
    const req = pendingDownloadRef.current
    pendingDownloadRef.current = null
    setPendingDownloadRequest(null)
    if (!req) return

    const senderPk = req.senderPubkey.trim().toLowerCase()
    const infoHash = req.torrent.infoHash.trim().toLowerCase()

    // Re-verify trust boundary right before initiating any network activity
    if (!isTrustedOrOwnSender(senderPk)) {
      pushToastRef.current(
        'error',
        'Trusted peers only',
        'Download aborted because this sender is not in your Trusted Peers list.'
      )
      return
    }

    const relays = getSignalRelays(req.torrent.relays)
    const currentScope = activeScopeRef.current
    activeDownloadTorrentsRef.current.set(infoHash, {
      torrent: req.torrent,
      senderPubkey: senderPk,
      senderDisplayHandle: req.senderDisplayHandle,
      relays,
      scope: currentScope?.scope ?? 'dm',
      isEncryptedGroup: Boolean(currentScope?.isEncryptedGroup),
    })

    const initialTransport = meshBridgeRef.current?.isOfflineMeshOnly() ? 'ble-mesh' : 'webrtc'
    setTransfers((prev) => ({
      ...prev,
      [infoHash]: {
        infoHash,
        phase: 'checking',
        transport: initialTransport,
        piecesCompleted: 0,
        pieceCount: req.torrent.pieceCount,
        bytesTransferred: 0,
        totalBytes: req.torrent.size,
        speedBytesPerSec: 0,
        connectedPeers: 0,
        completedAvailable: false,
        isReSeeding: false,
        updatedAt: Date.now(),
      },
    }))

    const remoteStatus = await checkRemoteStatus(req.torrent, senderPk)
    if (remoteStatus === 'closed' || closedBySenderRef.current[infoHash]) {
      activeDownloadTorrentsRef.current.delete(infoHash)
      setTransfers((prev) => ({
        ...prev,
        [infoHash]: {
          infoHash,
          phase: 'closed',
          piecesCompleted: 0,
          pieceCount: req.torrent.pieceCount,
          bytesTransferred: 0,
          totalBytes: req.torrent.size,
          speedBytesPerSec: 0,
          connectedPeers: 0,
          completedAvailable: false,
          isReSeeding: false,
          error: 'Downloads closed by sender.',
          updatedAt: Date.now(),
        },
      }))
      return
    }

    await swarmRef.current?.startDownload(req.torrent, senderPk, relays)
  }, [isTrustedOrOwnSender, getSignalRelays, checkRemoteStatus])

  const cancelDownload = useCallback((infoHash: string) => {
    const clean = infoHash.trim().toLowerCase()
    activeDownloadTorrentsRef.current.delete(clean)
    swarmRef.current?.cancelDownload(clean, true)
  }, [])

  const stopReSeeding = useCallback(
    (infoHash: string) => {
      const clean = infoHash.trim().toLowerCase()
      swarmRef.current?.closeShareConnections(clean, 'reseed-stopped')
      const existing = allSharesRef.current.get(clean)
      if (existing && existing.isReSeed) {
        const stopped: StoredTorrentShare = {
          ...existing,
          status: 'closed',
          activePeerCount: 0,
        }
        allSharesRef.current.set(clean, stopped)
        syncSharesStateFromRef()
        void storeRef.current?.putShare(stopped)
      }
      setTransfers((prev) => {
        const cur = prev[clean]
        if (!cur) return prev
        return {
          ...prev,
          [clean]: {
            ...cur,
            phase: cur.completedAvailable ? 'completed' : 'idle',
            isReSeeding: false,
            connectedPeers: 0,
            updatedAt: Date.now(),
          },
        }
      })
    },
    [syncSharesStateFromRef]
  )

  const resumeReSeeding = useCallback(
    async (infoHash: string): Promise<boolean> => {
      const clean = infoHash.trim().toLowerCase()
      const store = storeRef.current
      const existing = allSharesRef.current.get(clean) ?? (await store?.getShare(clean)) ?? null
      if (!existing || !existing.isReSeed || !existing.hasLocalData) {
        return false
      }
      if (closedBySenderRef.current[clean]) {
        pushToastRef.current(
          'info',
          'Downloads closed by sender',
          'The original sender has closed downloads for this file.'
        )
        return false
      }
      // Verify against original sender's authoritative kind:30078 status before resuming
      if (existing.senderPubkey && /^[0-9a-f]{64}$/i.test(existing.senderPubkey)) {
        const remoteStatus = await checkRemoteStatus(
          {
            v: 1,
            infoHash: existing.infoHash,
            swarmId: existing.swarmId,
            fileName: existing.fileName,
            mime: existing.mime,
            size: existing.size,
            pieceLength: existing.pieceLength,
            pieceCount: existing.pieceCount,
            plaintextSha256: existing.plaintextSha256,
            piecesRoot: existing.piecesRoot,
            encryption: existing.encryption,
            relays: existing.relays,
            senderPubkey: existing.senderPubkey,
            createdAt: existing.createdAt,
          },
          existing.senderPubkey
        )
        if (remoteStatus === 'closed' || closedBySenderRef.current[clean]) {
          pushToastRef.current(
            'info',
            'Downloads closed by sender',
            'Cannot resume seeding because the original sender closed this share.'
          )
          return false
        }
      }
      const hasPieces = store ? await store.hasAllPieces(clean, existing.pieceCount) : false
      if (!hasPieces) {
        pushToastRef.current(
          'error',
          'Local file copy incomplete',
          'Some encrypted pieces are missing from browser storage.'
        )
        return false
      }
      const resumed: StoredTorrentShare = {
        ...existing,
        status: 'active',
        closedAt: undefined,
        activePeerCount: 0,
      }
      allSharesRef.current.set(clean, resumed)
      syncSharesStateFromRef()
      await store?.putShare(resumed)
      setTransfers((prev) => {
        const cur = prev[clean]
        return {
          ...prev,
          [clean]: {
            infoHash: clean,
            phase: 'seeding',
            piecesCompleted: existing.pieceCount,
            pieceCount: existing.pieceCount,
            bytesTransferred: existing.size,
            totalBytes: existing.size,
            speedBytesPerSec: 0,
            connectedPeers: cur?.connectedPeers ?? 0,
            completedAvailable: true,
            isReSeeding: true,
            updatedAt: Date.now(),
          },
        }
      })
      return true
    },
    [checkRemoteStatus, syncSharesStateFromRef]
  )

  const removeDownloadedSeed = useCallback(
    async (infoHash: string): Promise<boolean> => {
      const clean = infoHash.trim().toLowerCase()
      const existing = allSharesRef.current.get(clean) ?? (await storeRef.current?.getShare(clean)) ?? null
      if (existing && !existing.isReSeed) {
        // Strictly for downloaded peer seeds; never publish sender revocation or remove own share here
        return false
      }
      swarmRef.current?.closeShareConnections(clean, 'reseed-removed')
      await storeRef.current?.deleteShare(clean)
      allSharesRef.current.delete(clean)
      syncSharesStateFromRef()
      setTransfers((prev) => {
        if (!(clean in prev)) return prev
        const next = { ...prev }
        delete next[clean]
        return next
      })
      return true
    },
    [syncSharesStateFromRef]
  )

  const closeShareDownloads = useCallback(
    async (infoHash: string): Promise<void> => {
      const clean = infoHash.trim().toLowerCase()
      const store = storeRef.current
      const existing = allSharesRef.current.get(clean) ?? (await store?.getShare(clean)) ?? null
      if (existing?.isReSeed) {
        // Peer seeds NEVER publish a sender-signed kind:30078 revocation
        stopReSeeding(clean)
        return
      }
      const closedAt = Date.now()

      if (existing) {
        const updated: StoredTorrentShare = {
          ...existing,
          status: 'closed',
          closedAt,
          activePeerCount: 0,
        }
        allSharesRef.current.set(clean, updated)
        syncSharesStateFromRef()
        saveCachedRevocation(clean, closedAt)
        setClosedBySender((prev) => {
          const next = { ...prev, [clean]: closedAt }
          closedBySenderRef.current = next
          return next
        })
        await store?.putShare(updated)

        // Immediately send { t: 'closed' } over every open DataChannel and close all RTCPeerConnections
        swarmRef.current?.closeShareConnections(clean, 'sender-closed')

        const relays = getSignalRelays(updated.relays)
        // Publish ephemeral kind:25057 swarm-closed broadcast
        const broadcastTmpl = buildTorrentSwarmBroadcastTemplate({
          v: 1,
          action: 'closed',
          swarmId: updated.swarmId,
          closedAt,
          ts: closedAt,
        })
        // Publish signed replaceable kind:30078 status='closed'
        const statusTmpl = buildTorrentStatusEventTemplate({
          swarmId: updated.swarmId,
          status: 'closed',
          updatedAt: closedAt,
        })
        await Promise.all([
          signAndPublishTemplate(broadcastTmpl, relays),
          signAndPublishTemplate(statusTmpl, relays),
        ])
      } else {
        swarmRef.current?.closeShareConnections(clean, 'sender-closed')
      }
    },
    [getSignalRelays, signAndPublishTemplate, stopReSeeding, syncSharesStateFromRef]
  )

  const reopenShareDownloads = useCallback(
    async (infoHash: string): Promise<void> => {
      const clean = infoHash.trim().toLowerCase()
      const store = storeRef.current
      const existing = allSharesRef.current.get(clean) ?? (await store?.getShare(clean)) ?? null
      if (existing?.isReSeed) {
        await resumeReSeeding(clean)
        return
      }
      if (!existing || !existing.hasLocalData) {
        pushToastRef.current(
          'error',
          'Local file copy missing',
          'Cannot reopen downloads because local encrypted pieces were deleted.'
        )
        return
      }
      const hasPieces = store ? await store.hasAllPieces(clean, existing.pieceCount) : false
      if (!hasPieces) {
        const missingCopy: StoredTorrentShare = {
          ...existing,
          hasLocalData: false,
          status: 'closed',
        }
        allSharesRef.current.set(clean, missingCopy)
        syncSharesStateFromRef()
        await store?.putShare(missingCopy)
        pushToastRef.current(
          'error',
          'Local file copy incomplete',
          'Some local pieces are missing from browser storage.'
        )
        return
      }

      const reopenedAt = Date.now()
      const reopened: StoredTorrentShare = {
        ...existing,
        status: 'active',
        closedAt: undefined,
        activePeerCount: 0,
      }
      allSharesRef.current.set(clean, reopened)
      syncSharesStateFromRef()
      clearCachedRevocation(clean)
      setClosedBySender((prev) => {
        if (!(clean in prev)) return prev
        const next = { ...prev }
        delete next[clean]
        closedBySenderRef.current = next
        return next
      })
      await store?.putShare(reopened)

      const relays = getSignalRelays(reopened.relays)
      const statusTmpl = buildTorrentStatusEventTemplate({
        swarmId: reopened.swarmId,
        status: 'active',
        updatedAt: reopenedAt,
      })
      await signAndPublishTemplate(statusTmpl, relays)
    },
    [getSignalRelays, resumeReSeeding, signAndPublishTemplate, syncSharesStateFromRef]
  )

  const deleteShareLocalData = useCallback(
    async (infoHash: string): Promise<void> => {
      const clean = infoHash.trim().toLowerCase()
      const existing = allSharesRef.current.get(clean)
      if (existing?.isReSeed) {
        await removeDownloadedSeed(clean)
        return
      }
      if (existing && existing.status === 'active') {
        await closeShareDownloads(clean)
      } else {
        swarmRef.current?.closeShareConnections(clean, 'sender-closed')
      }
      await storeRef.current?.deleteShare(clean)
      allSharesRef.current.delete(clean)
      syncSharesStateFromRef()
      setTransfers((prev) => {
        if (!(clean in prev)) return prev
        const next = { ...prev }
        delete next[clean]
        return next
      })
    },
    [closeShareDownloads, removeDownloadedSeed, syncSharesStateFromRef]
  )

  const saveLocalFile = useCallback(async (infoHash: string): Promise<boolean> => {
    const clean = infoHash.trim().toLowerCase()
    const store = storeRef.current
    if (!store) return false
    const share = allSharesRef.current.get(clean) ?? (await store.getShare(clean))
    if (!share || !share.hasLocalData) {
      pushToastRef.current('error', 'File unavailable', 'Local encrypted copy not found.')
      return false
    }

    const keyBytes = base64UrlDecode(share.encryption.keyB64)
    const noncePrefixBytes = base64UrlDecode(share.encryption.noncePrefixB64)
    if (!keyBytes || !noncePrefixBytes) return false

    try {
      const chunks: BlobPart[] = []
      const fullHasher = sha256.create()
      for (let i = 0; i < share.pieceCount; i += 1) {
        const encrypted = await store.getPiece(clean, i)
        if (!encrypted) {
          pushToastRef.current('error', 'Incomplete file', `Missing piece ${i + 1}/${share.pieceCount}.`)
          return false
        }
        const decrypted = await decryptTorrentPiece({
          keyBytes,
          noncePrefixBytes,
          infoHash: clean,
          pieceIndex: i,
          ciphertext: encrypted,
        })
        if (!decrypted) {
          pushToastRef.current('error', 'Decryption failed', 'File integrity verification failed.')
          return false
        }
        fullHasher.update(decrypted)
        const copy = new Uint8Array(decrypted.byteLength)
        copy.set(decrypted)
        chunks.push(copy.buffer)
      }

      const actualHash = bytesToHex(fullHasher.digest())
      if (actualHash !== share.plaintextSha256.toLowerCase()) {
        pushToastRef.current('error', 'Verification failed', 'SHA-256 checksum mismatch.')
        return false
      }

      const blob = new Blob(chunks, { type: share.mime || 'application/octet-stream' })
      if (typeof document !== 'undefined' && typeof URL !== 'undefined') {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = sanitizeTorrentFileName(share.fileName)
        a.rel = 'noopener'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      }
      return true
    } catch (err) {
      pushToastRef.current(
        'error',
        'Save failed',
        err instanceof Error ? err.message : 'Unable to decrypt and save file.'
      )
      return false
    }
  }, [])

  useLayoutEffect(() => {
    saveLocalFileRef.current = saveLocalFile
  }, [saveLocalFile])

  const getShare = useCallback((infoHash: string): TorrentShareRecord | undefined => {
    const found = allSharesRef.current.get(infoHash.trim().toLowerCase())
    return found ? stripStoredPieceHashes(found) : undefined
  }, [])

  const shares = useMemo<TorrentShareRecord[]>(
    () => sortSharesActiveFirst(allStoredShares.map(stripStoredPieceHashes)),
    [allStoredShares]
  )

  const activeShareCount = useMemo(
    () => shares.filter((s) => s.status === 'active' && s.hasLocalData).length,
    [shares]
  )

  return useMemo<TorrentEngine>(
    () => ({
      shares,
      activeShareCount,
      transfers,
      closedBySender,
      pendingDownloadRequest,
      sharesModalOpen,
      setSharesModalOpen,
      createAndSeedFile,
      requestDownload,
      confirmPendingDownload,
      cancelPendingDownload,
      cancelDownload,
      saveLocalFile,
      closeShareDownloads,
      reopenShareDownloads,
      deleteShareLocalData,
      stopReSeeding,
      resumeReSeeding,
      removeDownloadedSeed,
      checkRemoteStatus,
      getShare,
    }),
    [
      shares,
      activeShareCount,
      transfers,
      closedBySender,
      pendingDownloadRequest,
      sharesModalOpen,
      createAndSeedFile,
      requestDownload,
      confirmPendingDownload,
      cancelPendingDownload,
      cancelDownload,
      saveLocalFile,
      closeShareDownloads,
      reopenShareDownloads,
      deleteShareLocalData,
      stopReSeeding,
      resumeReSeeding,
      removeDownloadedSeed,
      checkRemoteStatus,
      getShare,
    ]
  )
}
