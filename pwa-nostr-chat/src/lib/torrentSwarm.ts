import { sha256 } from '@noble/hashes/sha256'
import type { TurnServerConfig } from '../types/calls.ts'
import type { TorrentAttachment, TorrentTransferState, TorrentTransport } from '../types/torrent.ts'
import { bytesToHex } from './identity.ts'
import {
  base64UrlDecode,
  base64UrlEncode,
  computeTorrentAuthProof,
  computeTorrentMerkleRoot,
  decryptTorrentPiece,
  MESH_CHUNK_BYTES,
  MESH_HASHES_PER_PAGE,
  type TorrentDirectSignalPayload,
  type TorrentMeshChunkReqPayload,
  type TorrentMeshChunkResPayload,
  type TorrentMeshMetaReqPayload,
  type TorrentMeshMetaResPayload,
  type TorrentSwarmBroadcastPayload,
} from './torrentProtocol.ts'
import type { StoredTorrentShare, TorrentVaultStore } from './torrentStore.ts'
import { buildIceServers } from './webrtcMesh.ts'

export const TORRENT_SUBCHUNK_BYTES = 16 * 1024
export const TORRENT_FRAME_HEADER_BYTES = 12
const BUFFER_LOW_THRESHOLD = 64 * 1024
const BUFFER_HIGH_WATERMARK = 256 * 1024
const MAX_INFLIGHT_PER_PEER = 4
const MAX_SEEDER_PEERS_PER_TORRENT = 8
const MAX_DOWNLOADER_PEERS_PER_TORRENT = 6
const MAX_PENDING_ICE = 64
const ICE_BATCH_DELAY_MS = 60
const SEEK_RETRY_INTERVAL_MS = 8_000
const WAITING_PHASE_TIMEOUT_MS = 3_500
const WEBRTC_FALLBACK_TO_MESH_MS = 6_000
const MESH_MAX_INFLIGHT_CHUNKS = 3
const MESH_RETRY_TIMEOUT_MS = 4_000
const MESH_TICK_INTERVAL_MS = 1_000
const MESH_MAX_REQS_PER_MIN = 210
const MESH_PEER_ACTIVE_TTL_MS = 12_000
const HERE_BROADCAST_THROTTLE_MS = 1_500
const GCM_TAG_BYTES = 16

export type TorrentControlMessage =
  | {
      t: 'hello'
      infoHash: string
      swarmId: string
      nonce: string
      authProof: string
      piecesHave: number
      pieceCount: number
    }
  | { t: 'meta-req'; infoHash: string }
  | { t: 'meta-res'; infoHash: string; pieceHashes: string[] }
  | { t: 'bitfield'; infoHash: string; all?: boolean; indices?: number[] }
  | { t: 'have'; infoHash: string; index: number }
  | { t: 'req'; infoHash: string; index: number }
  | { t: 'cancel'; infoHash: string; index: number }
  | { t: 'closed'; infoHash: string; reason: string }
  | { t: 'done'; infoHash: string }

export interface DecodedTorrentChunkFrame {
  pieceIndex: number
  byteOffset: number
  totalPieceByteLength: number
  payload: Uint8Array
}

export function encodeTorrentPieceChunkFrame(
  pieceIndex: number,
  byteOffset: number,
  totalPieceByteLength: number,
  payload: Uint8Array
): ArrayBuffer {
  const buf = new ArrayBuffer(TORRENT_FRAME_HEADER_BYTES + payload.byteLength)
  const view = new DataView(buf)
  view.setUint32(0, pieceIndex, false)
  view.setUint32(4, byteOffset, false)
  view.setUint32(8, totalPieceByteLength, false)
  new Uint8Array(buf, TORRENT_FRAME_HEADER_BYTES).set(payload)
  return buf
}

export function decodeTorrentPieceChunkFrame(
  data: ArrayBuffer
): DecodedTorrentChunkFrame | null {
  if (!(data instanceof ArrayBuffer) || data.byteLength <= TORRENT_FRAME_HEADER_BYTES) {
    return null
  }
  const view = new DataView(data)
  const pieceIndex = view.getUint32(0, false)
  const byteOffset = view.getUint32(4, false)
  const totalPieceByteLength = view.getUint32(8, false)
  const payload = new Uint8Array(data, TORRENT_FRAME_HEADER_BYTES)
  if (
    totalPieceByteLength <= 0 ||
    byteOffset + payload.byteLength > totalPieceByteLength ||
    payload.byteLength > TORRENT_SUBCHUNK_BYTES * 4
  ) {
    return null
  }
  return {
    pieceIndex,
    byteOffset,
    totalPieceByteLength,
    payload,
  }
}

function generateRandomTokenHex(byteLen = 12): string {
  const bytes = new Uint8Array(byteLen)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

interface PieceAssemblyBuffer {
  totalLength: number
  receivedBytes: number
  buffer: Uint8Array
  seenRanges: Set<number>
}

interface TorrentPeerLink {
  key: string
  infoHash: string
  swarmId: string
  peerPubkey: string
  sessionId: string
  role: 'seeder' | 'downloader'
  createdAt: number
  pc: RTCPeerConnection
  dc: RTCDataChannel | null
  pendingIce: RTCIceCandidateInit[]
  outboundIceBatch: RTCIceCandidateInit[]
  iceBatchTimer: number | null
  authed: boolean
  remoteHasAll: boolean
  remotePieces: Set<number>
  inFlightRequests: Set<number>
  pieceBuffers: Map<number, PieceAssemblyBuffer>
  uploadQueue: number[]
  uploading: boolean
  closed: boolean
  countedCompletion: boolean
}

interface MeshChunkAssembly {
  totalChunks: number
  totalPieceBytes: number
  buffer: Uint8Array
  receivedChunks: Set<number>
}

interface MeshInFlightChunk {
  pieceIndex: number
  chunkIndex: number
  peerPubkey: string
  sentAt: number
}

interface ActiveDownloadSession {
  torrent: TorrentAttachment
  senderPubkey: string
  relays: string[]
  keyBytes: Uint8Array
  noncePrefixBytes: Uint8Array
  transport: TorrentTransport
  pieceHashes: string[] | null
  completedPieces: Set<number>
  verifyingPieces: Set<number>
  inFlightGlobal: Map<number, string> // pieceIndex -> peerPubkey
  bytesTransferred: number
  speedSamples: Array<{ ts: number; bytes: number }>
  discoveredPeers: Set<string>
  meshPeers: string[]
  meshResponsivePeers: Set<string>
  meshPeerCursor: number
  meshMetaHashes: Array<string | undefined>
  meshMetaInFlight: Map<number, { peerPubkey: string; sentAt: number }>
  meshPieceBuffers: Map<number, MeshChunkAssembly>
  meshInFlightChunks: Map<string, MeshInFlightChunk>
  meshSentTimestamps: number[]
  seekTimer: ReturnType<typeof setInterval> | null
  waitingTimer: ReturnType<typeof setTimeout> | null
  webrtcFallbackTimer: ReturnType<typeof setTimeout> | null
  webrtcFallbackElapsed: boolean
  meshRetryTimer: ReturnType<typeof setInterval> | null
  aborted: boolean
  verifying: boolean
}

export interface TorrentSwarmCallbacks {
  getSelfPubkey: () => string
  getOwnPubkeys: () => ReadonlySet<string>
  getTrustedSet: () => ReadonlySet<string>
  getBlockedSet: () => ReadonlySet<string>
  getTurnConfig: () => TurnServerConfig | null
  getActiveSeedShare: (swarmId: string) => StoredTorrentShare | undefined
  isOfflineMeshOnly?: () => boolean
  sendDirectSignal: (
    recipientPubkey: string,
    payload: TorrentDirectSignalPayload,
    relays: string[]
  ) => Promise<void>
  publishSwarmBroadcast: (
    payload: TorrentSwarmBroadcastPayload,
    relays: string[]
  ) => Promise<void>
  onTransferUpdate: (state: TorrentTransferState) => void
  onShareStatsUpdate: (
    swarmId: string,
    patch: { activePeerCount?: number; bytesUploadedDelta?: number; completedDownloadsDelta?: number }
  ) => void
  onRemoteClosedBySender: (swarmId: string, closedAt: number) => void
  onDownloadCompleted: (torrent: TorrentAttachment, pieceHashes: string[]) => Promise<void>
}

export class TorrentSwarmManager {
  private readonly store: TorrentVaultStore
  private readonly cb: TorrentSwarmCallbacks
  /** Active download sessions keyed strictly by unique 32-hex swarmId */
  private readonly downloads = new Map<string, ActiveDownloadSession>()
  /** Active WebRTC links keyed strictly by `${role}:${swarmId}:${peerPubkey}` */
  private readonly links = new Map<string, TorrentPeerLink>()
  private readonly pendingCloseHandles = new Set<{
    timer: ReturnType<typeof setTimeout>
    flush: () => void
  }>()
  private readonly meshActiveSeedPeers = new Map<string, Map<string, number>>()
  private readonly meshCompletedPeers = new Set<string>()
  private readonly lastHereBroadcastAt = new Map<string, number>()
  private meshPeerExpiryTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  constructor(store: TorrentVaultStore, callbacks: TorrentSwarmCallbacks) {
    this.store = store
    this.cb = callbacks
  }

  private linkKey(swarmId: string, peerPubkey: string, role: 'seeder' | 'downloader'): string {
    return `${role}:${swarmId.toLowerCase()}:${peerPubkey.toLowerCase()}`
  }

  private isLinkAliveOrFresh(existing: TorrentPeerLink | undefined, graceMs: number): boolean {
    if (!existing || existing.closed) return false
    const dcState = existing.dc?.readyState
    const pcState = existing.pc.connectionState
    if (dcState === 'open' || pcState === 'connecting' || pcState === 'connected') {
      return true
    }
    if (
      (pcState === 'new' || dcState === 'connecting') &&
      Date.now() - existing.createdAt < graceMs
    ) {
      return true
    }
    return false
  }

  private getLinksForTorrent(swarmId: string, role?: 'seeder' | 'downloader'): TorrentPeerLink[] {
    const clean = swarmId.toLowerCase()
    const out: TorrentPeerLink[] = []
    for (const link of this.links.values()) {
      if (link.swarmId !== clean || link.closed) continue
      if (role && link.role !== role) continue
      out.push(link)
    }
    return out
  }

  private countActiveSeedPeers(swarmId: string): number {
    const clean = swarmId.toLowerCase()
    const webrtcCount = this.getLinksForTorrent(clean, 'seeder').filter(
      (l) => l.dc?.readyState === 'open' || l.pc.connectionState === 'connected'
    ).length
    const meshMap = this.meshActiveSeedPeers.get(clean)
    if (!meshMap || meshMap.size === 0) return webrtcCount
    const now = Date.now()
    let meshCount = 0
    for (const [peerPk, lastSeen] of meshMap.entries()) {
      if (now - lastSeen > MESH_PEER_ACTIVE_TTL_MS) {
        meshMap.delete(peerPk)
      } else {
        meshCount += 1
      }
    }
    if (meshMap.size === 0) this.meshActiveSeedPeers.delete(clean)
    return webrtcCount + meshCount
  }

  private recordMeshSeedPeerActivity(swarmId: string, peerPubkey: string): void {
    const clean = swarmId.toLowerCase()
    const pk = peerPubkey.toLowerCase()
    let map = this.meshActiveSeedPeers.get(clean)
    if (!map) {
      map = new Map()
      this.meshActiveSeedPeers.set(clean, map)
    }
    const hadPeer = map.has(pk)
    map.set(pk, Date.now())
    if (!hadPeer) {
      this.cb.onShareStatsUpdate(clean, {
        activePeerCount: this.countActiveSeedPeers(clean),
      })
    }
    this.scheduleMeshPeerExpirySweep()
  }

  private scheduleMeshPeerExpirySweep(): void {
    if (this.destroyed || this.meshPeerExpiryTimer !== null) return
    this.meshPeerExpiryTimer = globalThis.setTimeout(() => {
      this.meshPeerExpiryTimer = null
      if (this.destroyed) return
      const now = Date.now()
      let hasRemaining = false
      for (const [swarmId, map] of Array.from(this.meshActiveSeedPeers.entries())) {
        let changed = false
        for (const [peerPk, lastSeen] of Array.from(map.entries())) {
          if (now - lastSeen > MESH_PEER_ACTIVE_TTL_MS) {
            map.delete(peerPk)
            changed = true
          }
        }
        if (map.size === 0) {
          this.meshActiveSeedPeers.delete(swarmId)
        } else {
          hasRemaining = true
        }
        if (changed) {
          this.cb.onShareStatsUpdate(swarmId, {
            activePeerCount: this.countActiveSeedPeers(swarmId),
          })
        }
      }
      if (hasRemaining) {
        this.scheduleMeshPeerExpirySweep()
      }
    }, Math.ceil(MESH_PEER_ACTIVE_TTL_MS / 2))
  }

  private isOfflineMeshOnly(): boolean {
    return Boolean(this.cb.isOfflineMeshOnly?.())
  }

  private clearSessionTimers(session: ActiveDownloadSession): void {
    if (session.seekTimer !== null) {
      globalThis.clearInterval(session.seekTimer)
      session.seekTimer = null
    }
    if (session.waitingTimer !== null) {
      globalThis.clearTimeout(session.waitingTimer)
      session.waitingTimer = null
    }
    if (session.webrtcFallbackTimer !== null) {
      globalThis.clearTimeout(session.webrtcFallbackTimer)
      session.webrtcFallbackTimer = null
    }
    if (session.meshRetryTimer !== null) {
      globalThis.clearInterval(session.meshRetryTimer)
      session.meshRetryTimer = null
    }
  }

  private canConnectToPeerForDownload(session: ActiveDownloadSession, peerPubkey: string): boolean {
    const pk = peerPubkey.trim().toLowerCase()
    const selfPk = this.cb.getSelfPubkey().toLowerCase()
    if (!pk || pk === selfPk) return false
    if (this.cb.getBlockedSet().has(pk)) return false
    if (pk === session.senderPubkey) return true
    if (this.cb.getOwnPubkeys().has(pk)) return true
    return this.cb.getTrustedSet().has(pk)
  }

  private canAcceptPeerForSeed(
    share: StoredTorrentShare,
    peerPubkey: string,
    nonce: string,
    authProof: string
  ): boolean {
    const pk = peerPubkey.trim().toLowerCase()
    const selfPk = this.cb.getSelfPubkey().toLowerCase()
    if (!pk || pk === selfPk) return false
    if (share.status !== 'active' || !share.hasLocalData) return false
    if (this.cb.getBlockedSet().has(pk)) return false

    const keyBytes = base64UrlDecode(share.encryption.keyB64)
    if (!keyBytes || keyBytes.length !== 32) return false
    const expectedProof = computeTorrentAuthProof({
      infoHash: share.infoHash,
      swarmId: share.swarmId,
      keyBytes,
      peerPubkey: pk,
      nonce,
    })
    if (expectedProof !== authProof.toLowerCase()) return false

    if (this.cb.getOwnPubkeys().has(pk) || this.cb.getTrustedSet().has(pk)) {
      return true
    }
    if (!share.isReSeed && share.scope === 'dm' && share.targetPeerPubkey?.toLowerCase() === pk) {
      return true
    }
    if (share.isEncryptedGroup) {
      return true
    }
    return false
  }

  private canAcceptPeerForPartialDownloadSeed(
    session: ActiveDownloadSession,
    peerPubkey: string,
    nonce: string,
    authProof: string
  ): boolean {
    const pk = peerPubkey.trim().toLowerCase()
    const selfPk = this.cb.getSelfPubkey().toLowerCase()
    if (!pk || pk === selfPk) return false
    if (session.aborted || session.completedPieces.size === 0 || !session.pieceHashes) return false
    if (this.cb.getBlockedSet().has(pk)) return false
    if (!this.cb.getOwnPubkeys().has(pk) && !this.cb.getTrustedSet().has(pk)) return false

    const expectedProof = computeTorrentAuthProof({
      infoHash: session.torrent.infoHash,
      swarmId: session.torrent.swarmId,
      keyBytes: session.keyBytes,
      peerPubkey: pk,
      nonce,
    })
    return expectedProof === authProof.toLowerCase()
  }

  private emitTransferState(
    session: ActiveDownloadSession,
    phase: TorrentTransferState['phase'],
    opts?: { error?: string; completedAvailable?: boolean; isReSeeding?: boolean }
  ): void {
    const now = Date.now()
    const cutoff = now - 5_000
    session.speedSamples = session.speedSamples.filter((s) => s.ts >= cutoff)
    const windowBytes = session.speedSamples.reduce((acc, s) => acc + s.bytes, 0)
    const windowMs =
      session.speedSamples.length >= 2
        ? Math.max(500, now - session.speedSamples[0].ts)
        : 1_000
    const speedBytesPerSec =
      phase === 'downloading' ? Math.round((windowBytes * 1000) / windowMs) : 0

    const connectedPeers =
      session.transport === 'ble-mesh'
        ? session.meshResponsivePeers.size
        : this.getLinksForTorrent(session.torrent.swarmId, 'downloader').filter(
            (l) => l.dc?.readyState === 'open'
          ).length

    this.cb.onTransferUpdate({
      swarmId: session.torrent.swarmId,
      infoHash: session.torrent.infoHash,
      phase,
      transport: session.transport,
      piecesCompleted: session.completedPieces.size,
      pieceCount: session.torrent.pieceCount,
      bytesTransferred: Math.min(session.bytesTransferred, session.torrent.size),
      totalBytes: session.torrent.size,
      speedBytesPerSec,
      connectedPeers,
      completedAvailable: Boolean(opts?.completedAvailable),
      isReSeeding: Boolean(opts?.isReSeeding),
      ...(opts?.error ? { error: opts.error } : {}),
      updatedAt: now,
    })
  }

  async startDownload(
    torrent: TorrentAttachment,
    senderPubkey: string,
    relays: string[]
  ): Promise<void> {
    if (this.destroyed) return
    const infoHash = torrent.infoHash.toLowerCase()
    const swarmId = torrent.swarmId.toLowerCase()
    const cleanSender = senderPubkey.trim().toLowerCase()
    if (!cleanSender || !swarmId) return

    // Defense-in-depth trust check before ANY network call or RTCPeerConnection
    if (
      !this.cb.getOwnPubkeys().has(cleanSender) &&
      !this.cb.getTrustedSet().has(cleanSender)
    ) {
      return
    }

    const keyBytes = base64UrlDecode(torrent.encryption.keyB64)
    const noncePrefixBytes = base64UrlDecode(torrent.encryption.noncePrefixB64)
    if (!keyBytes || keyBytes.length !== 32 || !noncePrefixBytes || noncePrefixBytes.length !== 8) {
      this.cb.onTransferUpdate({
        swarmId,
        infoHash,
        phase: 'error',
        piecesCompleted: 0,
        pieceCount: torrent.pieceCount,
        bytesTransferred: 0,
        totalBytes: torrent.size,
        speedBytesPerSec: 0,
        connectedPeers: 0,
        completedAvailable: false,
        isReSeeding: false,
        error: 'Invalid E2EE torrent key metadata.',
        updatedAt: Date.now(),
      })
      return
    }

    // Resume or restart cleanly (strictly scoped to this unique swarmId)
    if (this.downloads.has(swarmId)) {
      this.cancelDownload(swarmId, false)
    }

    let existingIndices = (await this.store.listPieceIndices(swarmId)).filter(
      (i) => i >= 0 && i < torrent.pieceCount
    )
    const existingShare = await this.store.getShare(swarmId)
    const shareMetaMatches =
      !existingShare ||
      (existingShare.infoHash.toLowerCase() === infoHash &&
        existingShare.encryption.keyB64 === torrent.encryption.keyB64 &&
        existingShare.encryption.noncePrefixB64 === torrent.encryption.noncePrefixB64)

    // Belt-and-suspenders key verification: ensure any cached pieces under swarmId actually decrypt with this torrent's key
    if (existingIndices.length > 0) {
      let sampleValid = shareMetaMatches
      if (sampleValid) {
        const sampleCipher = await this.store.getPiece(swarmId, existingIndices[0])
        if (!sampleCipher) {
          sampleValid = false
        } else {
          const samplePlain = await decryptTorrentPiece({
            keyBytes,
            noncePrefixBytes,
            infoHash,
            pieceIndex: existingIndices[0],
            ciphertext: sampleCipher,
          })
          sampleValid = Boolean(
            samplePlain &&
              samplePlain.byteLength === this.expectedPlaintextPieceSize(torrent, existingIndices[0])
          )
        }
      }
      if (!sampleValid) {
        await this.store.deletePiecesForSwarm(swarmId)
        existingIndices = []
      }
    }

    const completedPieces = new Set<number>(existingIndices)
    const cachedHashes =
      existingShare &&
      shareMetaMatches &&
      Array.isArray(existingShare.pieceHashes) &&
      existingShare.pieceHashes.length === torrent.pieceCount &&
      computeTorrentMerkleRoot(existingShare.pieceHashes) === torrent.piecesRoot
        ? existingShare.pieceHashes
        : null

    let initialBytes = 0
    for (const idx of completedPieces) {
      initialBytes += this.expectedPlaintextPieceSize(torrent, idx)
    }

    const startInMesh = this.isOfflineMeshOnly()
    const session: ActiveDownloadSession = {
      torrent: { ...torrent, infoHash, swarmId, senderPubkey: cleanSender },
      senderPubkey: cleanSender,
      relays: Array.from(new Set(relays)),
      keyBytes,
      noncePrefixBytes,
      transport: startInMesh ? 'ble-mesh' : 'webrtc',
      pieceHashes: cachedHashes,
      completedPieces,
      verifyingPieces: new Set(),
      inFlightGlobal: new Map(),
      bytesTransferred: Math.min(initialBytes, torrent.size),
      speedSamples: [],
      discoveredPeers: new Set(),
      meshPeers: [],
      meshResponsivePeers: new Set(),
      meshPeerCursor: 0,
      meshMetaHashes: cachedHashes ? [...cachedHashes] : new Array<string | undefined>(torrent.pieceCount),
      meshMetaInFlight: new Map(),
      meshPieceBuffers: new Map(),
      meshInFlightChunks: new Map(),
      meshSentTimestamps: [],
      seekTimer: null,
      waitingTimer: null,
      webrtcFallbackTimer: null,
      webrtcFallbackElapsed: false,
      meshRetryTimer: null,
      aborted: false,
      verifying: false,
    }
    this.downloads.set(swarmId, session)

    if (completedPieces.size >= torrent.pieceCount) {
      await this.verifyAndFinalizeDownload(session)
      return
    }

    this.emitTransferState(session, 'connecting')

    const sendSeekWave = () => {
      if (session.aborted || this.destroyed || session.verifying) return
      const selfPk = this.cb.getSelfPubkey().toLowerCase()
      if (!selfPk) return
      const nonce = generateRandomTokenHex(10)
      const authProof = computeTorrentAuthProof({
        infoHash,
        swarmId,
        keyBytes: session.keyBytes,
        peerPubkey: selfPk,
        nonce,
      })
      const meshOnlyFlag = session.transport === 'ble-mesh' || this.isOfflineMeshOnly()

      // Direct NIP-44 seek to sender (if not already connected to sender)
      const senderLink = this.links.get(this.linkKey(swarmId, cleanSender, 'downloader'))
      const skipDirect =
        session.transport === 'ble-mesh'
          ? session.meshResponsivePeers.has(cleanSender)
          : Boolean(senderLink && !senderLink.closed)
      if (!skipDirect) {
        void this.cb
          .sendDirectSignal(
            cleanSender,
            {
              v: 1,
              action: 'seek',
              infoHash,
              swarmId,
              sessionId: generateRandomTokenHex(8),
              nonce,
              authProof,
              ...(meshOnlyFlag ? { meshOnly: true } : {}),
              ts: Date.now(),
            },
            session.relays
          )
          .catch(() => {})
      }

      // Blinded swarm seek so any online/BLE trusted peer re-seeding this torrent can respond too
      const openPeerCount =
        session.transport === 'ble-mesh'
          ? session.meshResponsivePeers.size
          : this.getLinksForTorrent(swarmId, 'downloader').length
      if (openPeerCount < MAX_DOWNLOADER_PEERS_PER_TORRENT) {
        void this.cb
          .publishSwarmBroadcast(
            {
              v: 1,
              action: 'seek',
              swarmId,
              nonce,
              authProof,
              piecesHave: session.completedPieces.size,
              pieceCount: torrent.pieceCount,
              ...(meshOnlyFlag ? { meshOnly: true } : {}),
              ts: Date.now(),
            },
            session.relays
          )
          .catch(() => {})
      }
    }

    sendSeekWave()

    if (startInMesh) {
      this.activateMeshTransport(session, [cleanSender])
    } else {
      this.armWebRtcFallbackTimer(session)
    }

    session.waitingTimer = globalThis.setTimeout(() => {
      if (session.aborted || session.verifying) return
      const connected =
        session.transport === 'ble-mesh'
          ? session.meshResponsivePeers.size > 0
          : this.getLinksForTorrent(swarmId, 'downloader').some((l) => l.dc?.readyState === 'open')
      if (!connected) {
        this.emitTransferState(session, 'waiting')
      }
    }, WAITING_PHASE_TIMEOUT_MS)

    session.seekTimer = globalThis.setInterval(sendSeekWave, SEEK_RETRY_INTERVAL_MS)
  }

  cancelDownload(swarmId: string, emitIdle = true): void {
    const clean = swarmId.trim().toLowerCase()
    const session = this.downloads.get(clean)
    if (session) {
      session.aborted = true
      this.clearSessionTimers(session)
      this.downloads.delete(clean)
    }
    for (const link of this.getLinksForTorrent(clean, 'downloader')) {
      this.closeLink(link)
    }
    if (emitIdle && session) {
      this.emitTransferState(session, 'idle')
    }
  }

  closeShareConnections(swarmId: string, reason = 'sender-closed'): void {
    const clean = swarmId.trim().toLowerCase()
    const allLinks = this.getLinksForTorrent(clean)
    for (const link of allLinks) {
      let sentClose = false
      if (link.dc && link.dc.readyState === 'open') {
        try {
          link.dc.send(JSON.stringify({ t: 'closed', infoHash: link.infoHash, reason }))
          sentClose = true
        } catch {
          // Best-effort close notification
        }
      }
      this.closeLink(link, sentClose ? 150 : 0)
    }
    this.meshActiveSeedPeers.delete(clean)
    const completedPrefix = `${clean}:`
    for (const key of Array.from(this.meshCompletedPeers)) {
      if (key.startsWith(completedPrefix)) this.meshCompletedPeers.delete(key)
    }
    this.cb.onShareStatsUpdate(clean, { activePeerCount: 0 })
  }

  abortDownloadAsClosed(swarmId: string): void {
    const clean = swarmId.trim().toLowerCase()
    const session = this.downloads.get(clean)
    if (session) {
      session.aborted = true
      this.clearSessionTimers(session)
      this.downloads.delete(clean)
      this.emitTransferState(session, 'closed', { error: 'Downloads closed by sender.' })
    }
    for (const link of this.getLinksForTorrent(clean)) {
      this.closeLink(link)
    }
  }

  handleSwarmBroadcast(
    senderPubkey: string,
    payload: TorrentSwarmBroadcastPayload
  ): void {
    if (this.destroyed) return
    const pk = senderPubkey.trim().toLowerCase()
    const selfPk = this.cb.getSelfPubkey().toLowerCase()
    if (!pk || pk === selfPk) return
    const swarmId = payload.swarmId.trim().toLowerCase()
    if (!swarmId) return

    if (payload.action === 'closed') {
      const dl = this.downloads.get(swarmId)
      if (dl && dl.senderPubkey === pk) {
        this.cb.onRemoteClosedBySender(swarmId, payload.closedAt ?? payload.ts)
        this.abortDownloadAsClosed(swarmId)
      }
      const seed = this.cb.getActiveSeedShare(swarmId)
      if (seed && seed.isReSeed && seed.senderPubkey.toLowerCase() === pk) {
        this.cb.onRemoteClosedBySender(swarmId, payload.closedAt ?? payload.ts)
        this.closeShareConnections(swarmId, 'sender-closed')
      }
      return
    }

    if (payload.action === 'here') {
      const session = this.downloads.get(swarmId)
      if (!session || session.aborted || session.verifying) return
      if (!this.canConnectToPeerForDownload(session, pk)) return
      session.discoveredPeers.add(pk)
      if (payload.meshOnly === true) {
        const hadResponsive = session.meshResponsivePeers.size > 0
        session.meshResponsivePeers.add(pk)
        if (!hadResponsive) {
          this.clearUnresponsiveMeshInFlight(session)
        }
        this.activateMeshTransport(session, [pk])
      } else if (session.transport === 'ble-mesh') {
        const hadResponsive = session.meshResponsivePeers.size > 0
        session.meshResponsivePeers.add(pk)
        if (!hadResponsive) {
          this.clearUnresponsiveMeshInFlight(session)
        }
        this.addMeshPeer(session, pk)
        this.driveMeshDownload(session)
      } else if (session.webrtcFallbackElapsed && session.webrtcFallbackTimer === null) {
        this.armWebRtcFallbackTimer(session)
      }
      return
    }

    if (payload.action === 'seek' && payload.nonce && payload.authProof) {
      const share = this.cb.getActiveSeedShare(swarmId)
      if (share) {
        if (this.canAcceptPeerForSeed(share, pk, payload.nonce, payload.authProof)) {
          this.broadcastHereIfAllowed(
            share.swarmId,
            share.pieceCount,
            share.pieceCount,
            share.relays
          )
          if (!payload.meshOnly && !this.isOfflineMeshOnly()) {
            void this.initiateSeederOffer(share, pk, generateRandomTokenHex(8))
          }
        }
        return
      }
      const partial = this.downloads.get(swarmId)
      if (
        partial &&
        this.canAcceptPeerForPartialDownloadSeed(partial, pk, payload.nonce, payload.authProof)
      ) {
        this.broadcastHereIfAllowed(
          partial.torrent.swarmId,
          partial.completedPieces.size,
          partial.torrent.pieceCount,
          partial.relays
        )
        if (!payload.meshOnly && !this.isOfflineMeshOnly()) {
          void this.initiatePartialSeederOffer(partial, pk, generateRandomTokenHex(8))
        }
      }
    }
  }

  async handleDirectSignal(
    senderPubkey: string,
    payload: TorrentDirectSignalPayload
  ): Promise<void> {
    if (this.destroyed) return
    const pk = senderPubkey.trim().toLowerCase()
    const selfPk = this.cb.getSelfPubkey().toLowerCase()
    if (!pk || pk === selfPk) return
    if (this.cb.getBlockedSet().has(pk)) return

    const infoHash = payload.infoHash.toLowerCase()
    const swarmId = payload.swarmId.toLowerCase()

    if (payload.action === 'mesh-meta-req') {
      await this.handleMeshMetaReq(pk, payload)
      return
    }
    if (payload.action === 'mesh-meta-res') {
      this.handleMeshMetaRes(pk, payload)
      return
    }
    if (payload.action === 'mesh-chunk-req') {
      await this.handleMeshChunkReq(pk, payload)
      return
    }
    if (payload.action === 'mesh-chunk-res') {
      await this.handleMeshChunkRes(pk, payload)
      return
    }

    if (payload.action === 'seek') {
      const share = this.cb.getActiveSeedShare(swarmId)
      if (share) {
        if (share.infoHash.toLowerCase() !== infoHash) return
        if (!this.canAcceptPeerForSeed(share, pk, payload.nonce, payload.authProof)) return
        this.broadcastHereIfAllowed(
          share.swarmId,
          share.pieceCount,
          share.pieceCount,
          share.relays
        )
        if (!payload.meshOnly && !this.isOfflineMeshOnly()) {
          await this.initiateSeederOffer(share, pk, payload.sessionId)
        }
        return
      }
      const partial = this.downloads.get(swarmId)
      if (
        partial &&
        partial.torrent.infoHash.toLowerCase() === infoHash &&
        this.canAcceptPeerForPartialDownloadSeed(partial, pk, payload.nonce, payload.authProof)
      ) {
        this.broadcastHereIfAllowed(
          partial.torrent.swarmId,
          partial.completedPieces.size,
          partial.torrent.pieceCount,
          partial.relays
        )
        if (!payload.meshOnly && !this.isOfflineMeshOnly()) {
          await this.initiatePartialSeederOffer(partial, pk, payload.sessionId)
        }
      }
      return
    }

    if (payload.action === 'offer') {
      const session = this.downloads.get(swarmId)
      if (!session || session.aborted) return
      if (session.torrent.infoHash.toLowerCase() !== infoHash) return
      if (!this.canConnectToPeerForDownload(session, pk)) return
      const expectedProof = computeTorrentAuthProof({
        infoHash,
        swarmId: session.torrent.swarmId,
        keyBytes: session.keyBytes,
        peerPubkey: pk,
        nonce: payload.nonce,
      })
      if (expectedProof !== payload.authProof.toLowerCase()) return
      session.discoveredPeers.add(pk)
      if (session.transport === 'ble-mesh') return
      if (!payload.sdp) return
      await this.acceptSeederOfferAsDownloader(session, pk, payload.sessionId, payload.sdp)
      return
    }

    if (payload.action === 'answer') {
      const link = this.links.get(this.linkKey(swarmId, pk, 'seeder'))
      if (
        !link ||
        link.closed ||
        link.infoHash !== infoHash ||
        link.sessionId !== payload.sessionId ||
        !payload.sdp
      ) {
        return
      }
      try {
        await link.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
        await this.flushPendingIce(link)
      } catch {
        this.closeLink(link)
      }
      return
    }

    if (payload.action === 'ice') {
      const candidates: RTCIceCandidateInit[] = []
      if (payload.candidate) candidates.push(payload.candidate)
      if (Array.isArray(payload.candidates)) candidates.push(...payload.candidates)
      if (candidates.length === 0) return

      const candidateLinks = [
        this.links.get(this.linkKey(swarmId, pk, 'seeder')),
        this.links.get(this.linkKey(swarmId, pk, 'downloader')),
      ].filter((l): l is TorrentPeerLink =>
        Boolean(l && !l.closed && l.infoHash === infoHash && l.sessionId === payload.sessionId)
      )

      for (const link of candidateLinks) {
        for (const c of candidates) {
          if (link.pc.remoteDescription) {
            try {
              await link.pc.addIceCandidate(c)
            } catch {
              // Ignore benign ICE race
            }
          } else if (link.pendingIce.length < MAX_PENDING_ICE) {
            link.pendingIce.push(c)
          }
        }
      }
    }
  }

  private async initiatePartialSeederOffer(
    session: ActiveDownloadSession,
    peerPubkey: string,
    sessionId: string
  ): Promise<void> {
    if (typeof RTCPeerConnection === 'undefined' || !session.pieceHashes) return
    const infoHash = session.torrent.infoHash
    const swarmId = session.torrent.swarmId
    const key = this.linkKey(swarmId, peerPubkey, 'seeder')
    const existing = this.links.get(key)
    if (this.isLinkAliveOrFresh(existing, 6_000)) {
      return
    }
    if (existing) this.closeLink(existing)
    if (this.getLinksForTorrent(swarmId, 'seeder').length >= MAX_SEEDER_PEERS_PER_TORRENT) {
      return
    }

    const pc = new RTCPeerConnection({ iceServers: buildIceServers(this.cb.getTurnConfig()) })
    const dc = pc.createDataChannel(`agnostr-torrent-${swarmId}`, { ordered: true })
    dc.binaryType = 'arraybuffer'
    dc.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD

    const link: TorrentPeerLink = {
      key,
      infoHash,
      swarmId,
      peerPubkey,
      sessionId,
      role: 'seeder',
      createdAt: Date.now(),
      pc,
      dc,
      pendingIce: [],
      outboundIceBatch: [],
      iceBatchTimer: null,
      authed: true,
      remoteHasAll: false,
      remotePieces: new Set(),
      inFlightRequests: new Set(),
      pieceBuffers: new Map(),
      uploadQueue: [],
      uploading: false,
      closed: false,
      countedCompletion: false,
    }
    this.links.set(key, link)
    this.wirePeerConnectionEvents(link, session.keyBytes, session.relays)
    this.wireSeederDataChannel(link, infoHash, swarmId, session.torrent.pieceCount, session.keyBytes)

    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const selfPk = this.cb.getSelfPubkey().toLowerCase()
      const nonce = generateRandomTokenHex(10)
      const authProof = computeTorrentAuthProof({
        infoHash,
        swarmId,
        keyBytes: session.keyBytes,
        peerPubkey: selfPk,
        nonce,
      })
      await this.cb.sendDirectSignal(
        peerPubkey,
        {
          v: 1,
          action: 'offer',
          infoHash,
          swarmId,
          sessionId,
          nonce,
          authProof,
          sdp: offer.sdp,
          ts: Date.now(),
        },
        session.relays
      )
    } catch {
      this.closeLink(link)
    }
  }

  private async initiateSeederOffer(
    share: StoredTorrentShare,
    peerPubkey: string,
    sessionId: string
  ): Promise<void> {
    if (typeof RTCPeerConnection === 'undefined') return
    const swarmId = share.swarmId.toLowerCase()
    const key = this.linkKey(swarmId, peerPubkey, 'seeder')
    const existing = this.links.get(key)
    if (this.isLinkAliveOrFresh(existing, 6_000)) {
      return
    }
    if (existing) this.closeLink(existing)

    if (this.getLinksForTorrent(swarmId, 'seeder').length >= MAX_SEEDER_PEERS_PER_TORRENT) {
      return
    }

    const keyBytes = base64UrlDecode(share.encryption.keyB64)
    if (!keyBytes || keyBytes.length !== 32) return

    const pc = new RTCPeerConnection({ iceServers: buildIceServers(this.cb.getTurnConfig()) })
    const dc = pc.createDataChannel(`agnostr-torrent-${share.swarmId}`, { ordered: true })
    dc.binaryType = 'arraybuffer'
    dc.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD

    const link: TorrentPeerLink = {
      key,
      infoHash: share.infoHash,
      swarmId: share.swarmId,
      peerPubkey,
      sessionId,
      role: 'seeder',
      createdAt: Date.now(),
      pc,
      dc,
      pendingIce: [],
      outboundIceBatch: [],
      iceBatchTimer: null,
      authed: true,
      remoteHasAll: false,
      remotePieces: new Set(),
      inFlightRequests: new Set(),
      pieceBuffers: new Map(),
      uploadQueue: [],
      uploading: false,
      closed: false,
      countedCompletion: false,
    }
    this.links.set(key, link)

    const relays = share.relays
    this.wirePeerConnectionEvents(link, keyBytes, relays)
    this.wireSeederDataChannel(link, share.infoHash, share.swarmId, share.pieceCount, keyBytes)

    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const selfPk = this.cb.getSelfPubkey().toLowerCase()
      const nonce = generateRandomTokenHex(10)
      const authProof = computeTorrentAuthProof({
        infoHash: share.infoHash,
        swarmId: share.swarmId,
        keyBytes,
        peerPubkey: selfPk,
        nonce,
      })
      await this.cb.sendDirectSignal(
        peerPubkey,
        {
          v: 1,
          action: 'offer',
          infoHash: share.infoHash,
          swarmId: share.swarmId,
          sessionId,
          nonce,
          authProof,
          sdp: offer.sdp,
          ts: Date.now(),
        },
        relays
      )
    } catch {
      this.closeLink(link)
    }
  }

  private async acceptSeederOfferAsDownloader(
    session: ActiveDownloadSession,
    peerPubkey: string,
    sessionId: string,
    remoteSdp: string
  ): Promise<void> {
    if (typeof RTCPeerConnection === 'undefined') return
    const key = this.linkKey(session.torrent.swarmId, peerPubkey, 'downloader')
    const existing = this.links.get(key)
    if (this.isLinkAliveOrFresh(existing, 4_000)) {
      return
    }
    if (existing) this.closeLink(existing)

    if (
      this.getLinksForTorrent(session.torrent.swarmId, 'downloader').length >=
      MAX_DOWNLOADER_PEERS_PER_TORRENT
    ) {
      return
    }

    const pc = new RTCPeerConnection({ iceServers: buildIceServers(this.cb.getTurnConfig()) })
    const link: TorrentPeerLink = {
      key,
      infoHash: session.torrent.infoHash,
      swarmId: session.torrent.swarmId,
      peerPubkey,
      sessionId,
      role: 'downloader',
      createdAt: Date.now(),
      pc,
      dc: null,
      pendingIce: [],
      outboundIceBatch: [],
      iceBatchTimer: null,
      authed: true,
      remoteHasAll: false,
      remotePieces: new Set(),
      inFlightRequests: new Set(),
      pieceBuffers: new Map(),
      uploadQueue: [],
      uploading: false,
      closed: false,
      countedCompletion: false,
    }
    this.links.set(key, link)
    this.wirePeerConnectionEvents(link, session.keyBytes, session.relays)

    pc.ondatachannel = (ev) => {
      if (link.closed || session.aborted) {
        ev.channel.close()
        return
      }
      const ch = ev.channel
      ch.binaryType = 'arraybuffer'
      ch.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD
      link.dc = ch
      this.wireDownloaderDataChannel(link, session)
    }

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: remoteSdp })
      await this.flushPendingIce(link)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      const selfPk = this.cb.getSelfPubkey().toLowerCase()
      const nonce = generateRandomTokenHex(10)
      const authProof = computeTorrentAuthProof({
        infoHash: session.torrent.infoHash,
        swarmId: session.torrent.swarmId,
        keyBytes: session.keyBytes,
        peerPubkey: selfPk,
        nonce,
      })
      await this.cb.sendDirectSignal(
        peerPubkey,
        {
          v: 1,
          action: 'answer',
          infoHash: session.torrent.infoHash,
          swarmId: session.torrent.swarmId,
          sessionId,
          nonce,
          authProof,
          sdp: answer.sdp,
          ts: Date.now(),
        },
        session.relays
      )
    } catch {
      this.closeLink(link)
    }
  }

  private wirePeerConnectionEvents(
    link: TorrentPeerLink,
    keyBytes: Uint8Array,
    relays: string[]
  ): void {
    const flushIceBatch = () => {
      link.iceBatchTimer = null
      if (link.closed || link.outboundIceBatch.length === 0) return
      const batch = link.outboundIceBatch.splice(0, 12)
      const selfPk = this.cb.getSelfPubkey().toLowerCase()
      const nonce = generateRandomTokenHex(8)
      const authProof = computeTorrentAuthProof({
        infoHash: link.infoHash,
        swarmId: link.swarmId,
        keyBytes,
        peerPubkey: selfPk,
        nonce,
      })
      void this.cb
        .sendDirectSignal(
          link.peerPubkey,
          {
            v: 1,
            action: 'ice',
            infoHash: link.infoHash,
            swarmId: link.swarmId,
            sessionId: link.sessionId,
            nonce,
            authProof,
            candidates: batch,
            ts: Date.now(),
          },
          relays
        )
        .catch(() => {})
    }

    link.pc.onicecandidate = (ev) => {
      if (link.closed || !ev.candidate) return
      const init = ev.candidate.toJSON()
      link.outboundIceBatch.push(init)
      if (link.outboundIceBatch.length >= 6) {
        if (link.iceBatchTimer !== null && typeof window !== 'undefined') {
          window.clearTimeout(link.iceBatchTimer)
        }
        flushIceBatch()
      } else if (link.iceBatchTimer === null && typeof window !== 'undefined') {
        link.iceBatchTimer = window.setTimeout(flushIceBatch, ICE_BATCH_DELAY_MS)
      }
    }

    link.pc.onconnectionstatechange = () => {
      if (link.closed) return
      const state = link.pc.connectionState
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.closeLink(link)
      }
    }
  }

  private async flushPendingIce(link: TorrentPeerLink): Promise<void> {
    if (link.closed || !link.pc.remoteDescription) return
    const queued = link.pendingIce.splice(0, link.pendingIce.length)
    for (const c of queued) {
      try {
        await link.pc.addIceCandidate(c)
      } catch {
        // Ignore benign candidate failure
      }
    }
  }

  private wireSeederDataChannel(
    link: TorrentPeerLink,
    infoHash: string,
    swarmId: string,
    pieceCount: number,
    keyBytes: Uint8Array
  ): void {
    const dc = link.dc
    if (!dc) return

    const resolveLiveSource = ():
      | { kind: 'share'; share: StoredTorrentShare }
      | { kind: 'partial'; session: ActiveDownloadSession }
      | null => {
      const liveShare = this.cb.getActiveSeedShare(swarmId)
      if (liveShare && liveShare.status === 'active' && liveShare.hasLocalData) {
        return { kind: 'share', share: liveShare }
      }
      const partial = this.downloads.get(swarmId)
      if (partial && !partial.aborted && partial.completedPieces.size > 0 && partial.pieceHashes) {
        return { kind: 'partial', session: partial }
      }
      return null
    }

    dc.onopen = () => {
      if (link.closed) return
      const source = resolveLiveSource()
      if (!source) {
        this.sendControl(dc, { t: 'closed', infoHash, reason: 'sender-closed' })
        this.closeLink(link)
        return
      }
      this.cb.onShareStatsUpdate(swarmId, {
        activePeerCount: this.countActiveSeedPeers(swarmId),
      })
      const selfPk = this.cb.getSelfPubkey().toLowerCase()
      const nonce = generateRandomTokenHex(8)
      const authProof = computeTorrentAuthProof({
        infoHash,
        swarmId,
        keyBytes,
        peerPubkey: selfPk,
        nonce,
      })
      const piecesHave =
        source.kind === 'share' ? source.share.pieceCount : source.session.completedPieces.size
      this.sendControl(dc, {
        t: 'hello',
        infoHash,
        swarmId,
        nonce,
        authProof,
        piecesHave,
        pieceCount,
      })
      if (source.kind === 'share') {
        this.sendControl(dc, {
          t: 'bitfield',
          infoHash,
          all: true,
        })
      } else {
        this.sendControl(dc, {
          t: 'bitfield',
          infoHash,
          indices: Array.from(source.session.completedPieces),
        })
      }
    }

    dc.onmessage = (ev) => {
      if (link.closed || typeof ev.data !== 'string') return
      const source = resolveLiveSource()
      if (!source) {
        this.sendControl(dc, { t: 'closed', infoHash, reason: 'sender-closed' })
        this.closeLink(link)
        return
      }
      let msg: TorrentControlMessage
      try {
        msg = JSON.parse(ev.data) as TorrentControlMessage
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object' || msg.infoHash !== infoHash) return

      if (msg.t === 'meta-req') {
        const pieceHashes =
          source.kind === 'share' ? source.share.pieceHashes : source.session.pieceHashes
        if (pieceHashes) {
          this.sendControl(dc, {
            t: 'meta-res',
            infoHash,
            pieceHashes,
          })
        }
        return
      }

      if (msg.t === 'req') {
        const idx = msg.index
        if (!Number.isInteger(idx) || idx < 0 || idx >= pieceCount) return
        if (source.kind === 'partial' && !source.session.completedPieces.has(idx)) return
        if (!link.uploadQueue.includes(idx) && link.uploadQueue.length < 32) {
          link.uploadQueue.push(idx)
          void this.drainSeederUploadQueue(link)
        }
        return
      }

      if (msg.t === 'cancel') {
        link.uploadQueue = link.uploadQueue.filter((i) => i !== msg.index)
        return
      }

      if (msg.t === 'done') {
        if (!link.countedCompletion) {
          link.countedCompletion = true
          this.cb.onShareStatsUpdate(swarmId, { completedDownloadsDelta: 1 })
        }
      }
    }

    dc.onclose = () => {
      this.closeLink(link)
    }

    dc.onerror = () => {
      this.closeLink(link)
    }
  }

  private async drainSeederUploadQueue(link: TorrentPeerLink): Promise<void> {
    if (link.uploading || link.closed || !link.dc || link.dc.readyState !== 'open') return
    link.uploading = true
    try {
      while (!link.closed && link.dc && link.dc.readyState === 'open' && link.uploadQueue.length > 0) {
        const liveShare = this.cb.getActiveSeedShare(link.swarmId)
        const partialSession = !liveShare ? this.downloads.get(link.swarmId) : undefined
        const canServe =
          Boolean(liveShare && liveShare.status === 'active' && liveShare.hasLocalData) ||
          Boolean(partialSession && !partialSession.aborted && partialSession.completedPieces.size > 0)
        if (!canServe) {
          this.sendControl(link.dc, { t: 'closed', infoHash: link.infoHash, reason: 'sender-closed' })
          this.closeLink(link)
          return
        }
        const pieceIndex = link.uploadQueue.shift()
        if (pieceIndex === undefined) break
        const encryptedPiece = await this.store.getPiece(link.swarmId, pieceIndex)
        if (!encryptedPiece || link.closed || !link.dc || link.dc.readyState !== 'open') continue

        const totalLen = encryptedPiece.byteLength
        let offset = 0
        while (offset < totalLen) {
          if (link.closed || !link.dc || link.dc.readyState !== 'open') return
          if (link.dc.bufferedAmount > BUFFER_HIGH_WATERMARK) {
            await this.waitForBufferedAmountLow(link.dc)
            if (link.closed || !link.dc || link.dc.readyState !== 'open') return
          }
          const end = Math.min(offset + TORRENT_SUBCHUNK_BYTES, totalLen)
          const slice = encryptedPiece.subarray(offset, end)
          const frame = encodeTorrentPieceChunkFrame(pieceIndex, offset, totalLen, slice)
          link.dc.send(frame)
          this.cb.onShareStatsUpdate(link.swarmId, { bytesUploadedDelta: slice.byteLength })
          offset = end
        }
      }
    } catch {
      this.closeLink(link)
    } finally {
      link.uploading = false
    }
  }

  private waitForBufferedAmountLow(dc: RTCDataChannel): Promise<void> {
    return new Promise<void>((resolve) => {
      if (dc.readyState !== 'open' || dc.bufferedAmount <= BUFFER_LOW_THRESHOLD) {
        resolve()
        return
      }
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        dc.removeEventListener('bufferedamountlow', done)
        dc.removeEventListener('close', done)
        dc.removeEventListener('error', done)
        globalThis.clearTimeout(fallback)
        resolve()
      }
      const fallback = globalThis.setTimeout(done, 1500)
      dc.addEventListener('bufferedamountlow', done, { once: true })
      dc.addEventListener('close', done, { once: true })
      dc.addEventListener('error', done, { once: true })
    })
  }

  private wireDownloaderDataChannel(
    link: TorrentPeerLink,
    session: ActiveDownloadSession
  ): void {
    const dc = link.dc
    if (!dc) return

    dc.onopen = () => {
      if (link.closed || session.aborted) return
      const selfPk = this.cb.getSelfPubkey().toLowerCase()
      const nonce = generateRandomTokenHex(8)
      const authProof = computeTorrentAuthProof({
        infoHash: session.torrent.infoHash,
        swarmId: session.torrent.swarmId,
        keyBytes: session.keyBytes,
        peerPubkey: selfPk,
        nonce,
      })
      this.sendControl(dc, {
        t: 'hello',
        infoHash: session.torrent.infoHash,
        swarmId: session.torrent.swarmId,
        nonce,
        authProof,
        piecesHave: session.completedPieces.size,
        pieceCount: session.torrent.pieceCount,
      })
      if (!session.pieceHashes) {
        this.sendControl(dc, { t: 'meta-req', infoHash: session.torrent.infoHash })
      }
      this.emitTransferState(session, 'downloading')
    }

    dc.onmessage = (ev) => {
      if (link.closed || session.aborted) return
      if (typeof ev.data === 'string') {
        this.handleDownloaderControlMessage(link, session, ev.data)
        return
      }
      if (ev.data instanceof ArrayBuffer) {
        void this.handleDownloaderBinaryFrame(link, session, ev.data)
      }
    }

    dc.onclose = () => {
      this.closeLink(link)
      if (!session.aborted && !session.verifying) {
        this.scheduleDownloadRequests(session)
      }
    }

    dc.onerror = () => {
      this.closeLink(link)
    }
  }

  private handleDownloaderControlMessage(
    link: TorrentPeerLink,
    session: ActiveDownloadSession,
    raw: string
  ): void {
    let msg: TorrentControlMessage
    try {
      msg = JSON.parse(raw) as TorrentControlMessage
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object' || msg.infoHash !== session.torrent.infoHash) return

    if (msg.t === 'closed') {
      if (link.peerPubkey === session.senderPubkey) {
        this.cb.onRemoteClosedBySender(session.torrent.swarmId, Date.now())
        this.abortDownloadAsClosed(session.torrent.swarmId)
      } else {
        this.closeLink(link)
        this.scheduleDownloadRequests(session)
      }
      return
    }

    if (msg.t === 'meta-res') {
      if (
        Array.isArray(msg.pieceHashes) &&
        msg.pieceHashes.length === session.torrent.pieceCount
      ) {
        try {
          const computedRoot = computeTorrentMerkleRoot(msg.pieceHashes)
          if (computedRoot === session.torrent.piecesRoot) {
            session.pieceHashes = msg.pieceHashes.map((h) => h.trim().toLowerCase())
            this.scheduleDownloadRequests(session)
          } else {
            // Peer sent bogus piece hashes — disconnect immediately
            this.closeLink(link)
          }
        } catch {
          this.closeLink(link)
        }
      }
      return
    }

    if (msg.t === 'bitfield') {
      if (msg.all) {
        link.remoteHasAll = true
      } else if (Array.isArray(msg.indices)) {
        for (const i of msg.indices) {
          if (Number.isInteger(i) && i >= 0 && i < session.torrent.pieceCount) {
            link.remotePieces.add(i)
          }
        }
      }
      this.scheduleDownloadRequests(session)
      return
    }

    if (msg.t === 'have') {
      if (
        Number.isInteger(msg.index) &&
        msg.index >= 0 &&
        msg.index < session.torrent.pieceCount
      ) {
        link.remotePieces.add(msg.index)
        this.scheduleDownloadRequests(session)
      }
    }
  }

  private async handleDownloaderBinaryFrame(
    link: TorrentPeerLink,
    session: ActiveDownloadSession,
    rawFrame: ArrayBuffer
  ): Promise<void> {
    const frame = decodeTorrentPieceChunkFrame(rawFrame)
    if (!frame) return
    const { pieceIndex, byteOffset, totalPieceByteLength, payload } = frame
    if (pieceIndex >= session.torrent.pieceCount) return
    if (session.completedPieces.has(pieceIndex) || session.verifyingPieces.has(pieceIndex)) return

    const maxEncryptedSize = session.torrent.pieceLength + 32
    if (totalPieceByteLength > maxEncryptedSize) {
      this.closeLink(link)
      return
    }

    let assembly = link.pieceBuffers.get(pieceIndex)
    if (!assembly || assembly.totalLength !== totalPieceByteLength) {
      assembly = {
        totalLength: totalPieceByteLength,
        receivedBytes: 0,
        buffer: new Uint8Array(totalPieceByteLength),
        seenRanges: new Set(),
      }
      link.pieceBuffers.set(pieceIndex, assembly)
    }

    if (!assembly.seenRanges.has(byteOffset)) {
      assembly.buffer.set(payload, byteOffset)
      assembly.seenRanges.add(byteOffset)
      assembly.receivedBytes += payload.byteLength
      session.speedSamples.push({ ts: Date.now(), bytes: payload.byteLength })
    }

    if (assembly.receivedBytes < assembly.totalLength) return

    // Full encrypted piece assembled — verify AES-256-GCM tag + AAD + Merkle piece hash!
    link.pieceBuffers.delete(pieceIndex)
    link.inFlightRequests.delete(pieceIndex)
    if (session.inFlightGlobal.get(pieceIndex) === link.peerPubkey) {
      session.inFlightGlobal.delete(pieceIndex)
    }
    session.verifyingPieces.add(pieceIndex)

    try {
      const decrypted = await decryptTorrentPiece({
        keyBytes: session.keyBytes,
        noncePrefixBytes: session.noncePrefixBytes,
        infoHash: session.torrent.infoHash,
        pieceIndex,
        ciphertext: assembly.buffer,
      })
      if (!decrypted || session.aborted) {
        if (!session.aborted) {
          // Tampered ciphertext — disconnect bad peer and retry from another trusted peer
          this.closeLink(link)
          session.verifyingPieces.delete(pieceIndex)
          this.scheduleDownloadRequests(session)
        }
        return
      }

      const expectedSize = this.expectedPlaintextPieceSize(session.torrent, pieceIndex)
      if (decrypted.byteLength !== expectedSize) {
        this.closeLink(link)
        session.verifyingPieces.delete(pieceIndex)
        this.scheduleDownloadRequests(session)
        return
      }

      if (session.pieceHashes) {
        const pieceDigest = bytesToHex(sha256(decrypted))
        if (pieceDigest !== session.pieceHashes[pieceIndex]) {
          this.closeLink(link)
          session.verifyingPieces.delete(pieceIndex)
          this.scheduleDownloadRequests(session)
          return
        }
      }

      await this.store.putPiece(session.torrent.swarmId, pieceIndex, assembly.buffer)
      if (session.aborted) return

      session.completedPieces.add(pieceIndex)
      session.verifyingPieces.delete(pieceIndex)
      session.bytesTransferred = Math.min(
        session.torrent.size,
        session.bytesTransferred + decrypted.byteLength
      )
    } finally {
      session.verifyingPieces.delete(pieceIndex)
    }

    // Notify ALL connected peers (downloaders & seeder upload channels) that we now have this piece
    for (const peerLink of this.getLinksForTorrent(session.torrent.swarmId)) {
      if (peerLink.dc?.readyState === 'open') {
        this.sendControl(peerLink.dc, {
          t: 'have',
          infoHash: session.torrent.infoHash,
          index: pieceIndex,
        })
      }
    }

    if (session.completedPieces.size >= session.torrent.pieceCount) {
      await this.verifyAndFinalizeDownload(session)
      return
    }

    this.emitTransferState(session, 'downloading')
    this.scheduleDownloadRequests(session)
  }

  private scheduleDownloadRequests(session: ActiveDownloadSession): void {
    if (session.aborted || session.verifying) return
    const downloaderLinks = this.getLinksForTorrent(session.torrent.swarmId, 'downloader').filter(
      (l) => l.dc?.readyState === 'open'
    )
    if (downloaderLinks.length === 0) return

    // Request piece hashes first if we don't have them yet
    if (!session.pieceHashes) {
      for (const link of downloaderLinks) {
        if (link.dc) {
          this.sendControl(link.dc, { t: 'meta-req', infoHash: session.torrent.infoHash })
        }
      }
      return
    }

    for (const link of downloaderLinks) {
      if (!link.dc || link.dc.readyState !== 'open') continue
      while (link.inFlightRequests.size < MAX_INFLIGHT_PER_PEER) {
        const nextIdx = this.pickNextPieceForLink(session, link)
        if (nextIdx === null) break
        link.inFlightRequests.add(nextIdx)
        session.inFlightGlobal.set(nextIdx, link.peerPubkey)
        this.sendControl(link.dc, {
          t: 'req',
          infoHash: session.torrent.infoHash,
          index: nextIdx,
        })
      }
    }
  }

  private pickNextPieceForLink(
    session: ActiveDownloadSession,
    link: TorrentPeerLink
  ): number | null {
    for (let i = 0; i < session.torrent.pieceCount; i += 1) {
      if (session.completedPieces.has(i) || session.verifyingPieces.has(i)) continue
      if (session.inFlightGlobal.has(i)) continue
      if (link.remoteHasAll || link.remotePieces.has(i)) {
        return i
      }
    }
    return null
  }

  private expectedPlaintextPieceSize(torrent: TorrentAttachment, pieceIndex: number): number {
    if (pieceIndex < torrent.pieceCount - 1) return torrent.pieceLength
    const remainder = torrent.size % torrent.pieceLength
    return remainder === 0 ? torrent.pieceLength : remainder
  }

  private expectedEncryptedPieceSize(torrent: TorrentAttachment, pieceIndex: number): number {
    return this.expectedPlaintextPieceSize(torrent, pieceIndex) + GCM_TAG_BYTES
  }

  private broadcastHereIfAllowed(
    swarmId: string,
    piecesHave: number,
    pieceCount: number,
    relays: string[]
  ): void {
    const clean = swarmId.toLowerCase()
    const now = Date.now()
    const last = this.lastHereBroadcastAt.get(clean) ?? 0
    if (now - last < HERE_BROADCAST_THROTTLE_MS) return
    this.lastHereBroadcastAt.set(clean, now)
    void this.cb
      .publishSwarmBroadcast(
        {
          v: 1,
          action: 'here',
          swarmId: clean,
          piecesHave,
          pieceCount,
          ...(this.isOfflineMeshOnly() ? { meshOnly: true } : {}),
          ts: now,
        },
        relays
      )
      .catch(() => {})
  }

  private armWebRtcFallbackTimer(session: ActiveDownloadSession): void {
    if (session.aborted || session.verifying || session.transport === 'ble-mesh') return
    if (session.webrtcFallbackTimer !== null) {
      globalThis.clearTimeout(session.webrtcFallbackTimer)
      session.webrtcFallbackTimer = null
    }
    session.webrtcFallbackElapsed = false
    session.webrtcFallbackTimer = globalThis.setTimeout(() => {
      session.webrtcFallbackTimer = null
      session.webrtcFallbackElapsed = true
      if (session.aborted || session.verifying || session.transport !== 'webrtc') return
      const hasOpenDc = this.getLinksForTorrent(session.torrent.swarmId, 'downloader').some(
        (l) => l.dc?.readyState === 'open'
      )
      if (!hasOpenDc && session.discoveredPeers.size > 0) {
        this.activateMeshTransport(session, Array.from(session.discoveredPeers))
      }
    }, WEBRTC_FALLBACK_TO_MESH_MS)
  }

  private addMeshPeer(session: ActiveDownloadSession, peerPubkey: string): void {
    const pk = peerPubkey.trim().toLowerCase()
    if (!pk || session.meshPeers.includes(pk)) return
    if (!this.canConnectToPeerForDownload(session, pk)) return
    session.meshPeers.push(pk)
  }

  private activateMeshTransport(session: ActiveDownloadSession, seedPeers: string[]): void {
    if (session.aborted || session.verifying || this.destroyed) return
    const wasMesh = session.transport === 'ble-mesh'
    session.transport = 'ble-mesh'
    if (session.webrtcFallbackTimer !== null) {
      globalThis.clearTimeout(session.webrtcFallbackTimer)
      session.webrtcFallbackTimer = null
    }

    // Close any stalled WebRTC downloader links when switching to BLE Mesh bridge
    if (!wasMesh) {
      for (const link of this.getLinksForTorrent(session.torrent.swarmId, 'downloader')) {
        this.closeLink(link)
      }
    }

    for (const peer of seedPeers) {
      this.addMeshPeer(session, peer)
    }
    this.addMeshPeer(session, session.senderPubkey)

    if (session.meshRetryTimer === null) {
      session.meshRetryTimer = globalThis.setInterval(() => {
        if (session.aborted || session.verifying || this.destroyed) return
        this.driveMeshDownload(session)
      }, MESH_TICK_INTERVAL_MS)
    }

    this.emitTransferState(
      session,
      session.meshResponsivePeers.size > 0 ? 'downloading' : 'connecting'
    )
    this.driveMeshDownload(session)
  }

  private canSendMeshRequestNow(session: ActiveDownloadSession, now: number): boolean {
    const cutoff = now - 60_000
    while (session.meshSentTimestamps.length > 0 && session.meshSentTimestamps[0] < cutoff) {
      session.meshSentTimestamps.shift()
    }
    return session.meshSentTimestamps.length < MESH_MAX_REQS_PER_MIN
  }

  private clearUnresponsiveMeshInFlight(session: ActiveDownloadSession): void {
    for (const [offset, meta] of Array.from(session.meshMetaInFlight.entries())) {
      if (!session.meshResponsivePeers.has(meta.peerPubkey)) {
        session.meshMetaInFlight.delete(offset)
      }
    }
    for (const [key, inflight] of Array.from(session.meshInFlightChunks.entries())) {
      if (!session.meshResponsivePeers.has(inflight.peerPubkey)) {
        session.meshInFlightChunks.delete(key)
      }
    }
  }

  private pickNextMeshPeer(session: ActiveDownloadSession): string | null {
    const responsive = session.meshPeers.filter((p) => session.meshResponsivePeers.has(p))
    const pool = responsive.length > 0 ? responsive : session.meshPeers
    if (pool.length === 0) return null
    const peer = pool[session.meshPeerCursor % pool.length]
    session.meshPeerCursor = (session.meshPeerCursor + 1) % pool.length
    return peer
  }

  private driveMeshDownload(session: ActiveDownloadSession): void {
    if (this.destroyed || session.aborted || session.verifying || session.transport !== 'ble-mesh') {
      return
    }
    if (session.meshPeers.length === 0) return
    const selfPk = this.cb.getSelfPubkey().toLowerCase()
    if (!selfPk) return

    const now = Date.now()

    // Phase 1: Paginate Merkle-verified piece hashes (20 hashes per frame, < 4096 B)
    if (!session.pieceHashes) {
      for (const [offset, meta] of Array.from(session.meshMetaInFlight.entries())) {
        if (now - meta.sentAt >= MESH_RETRY_TIMEOUT_MS) {
          session.meshMetaInFlight.delete(offset)
          if (session.meshResponsivePeers.size > 1) {
            session.meshResponsivePeers.delete(meta.peerPubkey)
          }
        }
      }
      for (
        let offset = 0;
        offset < session.torrent.pieceCount &&
        session.meshMetaInFlight.size < MESH_MAX_INFLIGHT_CHUNKS;
        offset += MESH_HASHES_PER_PAGE
      ) {
        if (session.meshMetaInFlight.has(offset)) continue
        const end = Math.min(offset + MESH_HASHES_PER_PAGE, session.torrent.pieceCount)
        let missing = false
        for (let i = offset; i < end; i += 1) {
          if (!session.meshMetaHashes[i]) {
            missing = true
            break
          }
        }
        if (!missing) continue
        if (!this.canSendMeshRequestNow(session, now)) break
        const peer = this.pickNextMeshPeer(session)
        if (!peer) break

        const nonce = generateRandomTokenHex(8)
        const authProof = computeTorrentAuthProof({
          infoHash: session.torrent.infoHash,
          swarmId: session.torrent.swarmId,
          keyBytes: session.keyBytes,
          peerPubkey: selfPk,
          nonce,
        })
        session.meshMetaInFlight.set(offset, { peerPubkey: peer, sentAt: now })
        session.meshSentTimestamps.push(now)
        void this.cb
          .sendDirectSignal(
            peer,
            {
              v: 1,
              action: 'mesh-meta-req',
              infoHash: session.torrent.infoHash,
              swarmId: session.torrent.swarmId,
              nonce,
              authProof,
              offset,
              ts: now,
            },
            session.relays
          )
          .catch(() => {})
      }
      return
    }

    // Phase 2: Pipeline 1280-byte encrypted piece chunks (max 3 in-flight, 4s retry)
    for (const [chunkKey, inflight] of Array.from(session.meshInFlightChunks.entries())) {
      if (now - inflight.sentAt >= MESH_RETRY_TIMEOUT_MS) {
        session.meshInFlightChunks.delete(chunkKey)
        if (session.meshResponsivePeers.size > 1) {
          session.meshResponsivePeers.delete(inflight.peerPubkey)
        }
      }
    }

    while (
      session.meshInFlightChunks.size < MESH_MAX_INFLIGHT_CHUNKS &&
      this.canSendMeshRequestNow(session, now)
    ) {
      const next = this.pickNextMeshChunk(session)
      if (!next) break
      const peer = this.pickNextMeshPeer(session)
      if (!peer) break
      const nonce = generateRandomTokenHex(8)
      const authProof = computeTorrentAuthProof({
        infoHash: session.torrent.infoHash,
        swarmId: session.torrent.swarmId,
        keyBytes: session.keyBytes,
        peerPubkey: selfPk,
        nonce,
      })
      const chunkKey = `${next.pieceIndex}:${next.chunkIndex}`
      session.meshInFlightChunks.set(chunkKey, {
        pieceIndex: next.pieceIndex,
        chunkIndex: next.chunkIndex,
        peerPubkey: peer,
        sentAt: now,
      })
      session.meshSentTimestamps.push(now)
      void this.cb
        .sendDirectSignal(
          peer,
          {
            v: 1,
            action: 'mesh-chunk-req',
            infoHash: session.torrent.infoHash,
            swarmId: session.torrent.swarmId,
            nonce,
            authProof,
            pieceIndex: next.pieceIndex,
            chunkIndex: next.chunkIndex,
            chunkSize: MESH_CHUNK_BYTES,
            ts: now,
          },
          session.relays
        )
        .catch(() => {})
    }
  }

  private pickNextMeshChunk(
    session: ActiveDownloadSession
  ): { pieceIndex: number; chunkIndex: number } | null {
    for (let pieceIndex = 0; pieceIndex < session.torrent.pieceCount; pieceIndex += 1) {
      if (session.completedPieces.has(pieceIndex) || session.verifyingPieces.has(pieceIndex)) {
        continue
      }
      const expectedCipherBytes = this.expectedEncryptedPieceSize(session.torrent, pieceIndex)
      const totalChunks = Math.ceil(expectedCipherBytes / MESH_CHUNK_BYTES)
      const assembly = session.meshPieceBuffers.get(pieceIndex)
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
        if (assembly?.receivedChunks.has(chunkIndex)) continue
        if (session.meshInFlightChunks.has(`${pieceIndex}:${chunkIndex}`)) continue
        return { pieceIndex, chunkIndex }
      }
    }
    return null
  }

  private recomputeMeshBytesTransferred(session: ActiveDownloadSession): number {
    let total = 0
    for (const idx of session.completedPieces) {
      total += this.expectedPlaintextPieceSize(session.torrent, idx)
    }
    for (const [pieceIndex, assembly] of session.meshPieceBuffers.entries()) {
      if (session.completedPieces.has(pieceIndex)) continue
      const plainLen = this.expectedPlaintextPieceSize(session.torrent, pieceIndex)
      const approx = Math.min(
        plainLen,
        Math.round((assembly.receivedChunks.size / Math.max(1, assembly.totalChunks)) * plainLen)
      )
      total += approx
    }
    return Math.min(session.torrent.size, total)
  }

  private async handleMeshMetaReq(
    peerPubkey: string,
    payload: TorrentMeshMetaReqPayload
  ): Promise<void> {
    const infoHash = payload.infoHash.toLowerCase()
    const swarmId = payload.swarmId.toLowerCase()
    const authNonce = payload.nonce ?? String(payload.ts)
    const share = this.cb.getActiveSeedShare(swarmId)
    const partial = !share ? this.downloads.get(swarmId) : undefined

    let pieceHashes: string[] | null = null
    let relays: string[] = []

    if (share) {
      if (share.infoHash.toLowerCase() !== infoHash) return
      if (!this.canAcceptPeerForSeed(share, peerPubkey, authNonce, payload.authProof)) return
      pieceHashes = share.pieceHashes
      relays = share.relays
    } else if (partial) {
      if (partial.torrent.infoHash.toLowerCase() !== infoHash) return
      if (!this.canAcceptPeerForPartialDownloadSeed(partial, peerPubkey, authNonce, payload.authProof)) {
        return
      }
      pieceHashes = partial.pieceHashes
      relays = partial.relays
    } else {
      return
    }

    if (!pieceHashes || pieceHashes.length === 0) return
    const offset = Math.max(0, Math.min(payload.offset ?? 0, pieceHashes.length))
    const page = pieceHashes.slice(offset, offset + MESH_HASHES_PER_PAGE)
    if (page.length === 0) return

    this.recordMeshSeedPeerActivity(swarmId, peerPubkey)
    await this.cb
      .sendDirectSignal(
        peerPubkey,
        {
          v: 1,
          action: 'mesh-meta-res',
          infoHash,
          swarmId,
          offset,
          totalHashes: pieceHashes.length,
          hashes: page,
          ts: Date.now(),
        },
        relays
      )
      .catch(() => {})
  }

  private handleMeshMetaRes(peerPubkey: string, payload: TorrentMeshMetaResPayload): void {
    const infoHash = payload.infoHash.toLowerCase()
    const swarmId = payload.swarmId.toLowerCase()
    const session = this.downloads.get(swarmId)
    if (!session || session.aborted || session.verifying || session.pieceHashes) return
    if (session.torrent.infoHash.toLowerCase() !== infoHash) return
    if (!this.canConnectToPeerForDownload(session, peerPubkey)) return
    if (payload.totalHashes !== session.torrent.pieceCount) return
    if (payload.offset + payload.hashes.length > session.torrent.pieceCount) return

    session.meshResponsivePeers.add(peerPubkey)
    this.addMeshPeer(session, peerPubkey)
    session.meshMetaInFlight.delete(payload.offset)

    for (let i = 0; i < payload.hashes.length; i += 1) {
      session.meshMetaHashes[payload.offset + i] = payload.hashes[i].toLowerCase()
    }

    let complete = true
    for (let i = 0; i < session.torrent.pieceCount; i += 1) {
      if (!session.meshMetaHashes[i]) {
        complete = false
        break
      }
    }

    if (complete) {
      const candidateHashes = session.meshMetaHashes as string[]
      const root = computeTorrentMerkleRoot(candidateHashes)
      if (root !== session.torrent.piecesRoot.toLowerCase()) {
        // Tampered metadata — discard and retry from another trusted peer
        session.meshMetaHashes = new Array<string | undefined>(session.torrent.pieceCount)
        session.meshMetaInFlight.clear()
        if (session.meshPeers.length > 1) {
          session.meshPeers = session.meshPeers.filter((p) => p !== peerPubkey)
          session.meshResponsivePeers.delete(peerPubkey)
        }
        this.driveMeshDownload(session)
        return
      }
      session.pieceHashes = candidateHashes
      session.meshMetaInFlight.clear()
      this.emitTransferState(session, 'downloading')
    }

    this.driveMeshDownload(session)
  }

  private async handleMeshChunkReq(
    peerPubkey: string,
    payload: TorrentMeshChunkReqPayload
  ): Promise<void> {
    const infoHash = payload.infoHash.toLowerCase()
    const swarmId = payload.swarmId.toLowerCase()
    const authNonce = payload.nonce ?? String(payload.ts)
    const share = this.cb.getActiveSeedShare(swarmId)
    const partial = !share ? this.downloads.get(swarmId) : undefined

    let pieceCount = 0
    let relays: string[] = []

    if (share) {
      if (share.infoHash.toLowerCase() !== infoHash) return
      if (!this.canAcceptPeerForSeed(share, peerPubkey, authNonce, payload.authProof)) return
      pieceCount = share.pieceCount
      relays = share.relays
    } else if (partial) {
      if (partial.torrent.infoHash.toLowerCase() !== infoHash) return
      if (!this.canAcceptPeerForPartialDownloadSeed(partial, peerPubkey, authNonce, payload.authProof)) {
        return
      }
      if (!partial.completedPieces.has(payload.pieceIndex)) return
      pieceCount = partial.torrent.pieceCount
      relays = partial.relays
    } else {
      return
    }

    if (payload.pieceIndex < 0 || payload.pieceIndex >= pieceCount) return
    const encryptedPiece = await this.store.getPiece(swarmId, payload.pieceIndex)
    if (!encryptedPiece || encryptedPiece.byteLength === 0) return

    const chunkSize = Math.max(1, Math.min(MESH_CHUNK_BYTES, payload.chunkSize))
    const totalChunks = Math.ceil(encryptedPiece.byteLength / chunkSize)
    if (payload.chunkIndex < 0 || payload.chunkIndex >= totalChunks) return

    const start = payload.chunkIndex * chunkSize
    const end = Math.min(start + chunkSize, encryptedPiece.byteLength)
    const slice = encryptedPiece.subarray(start, end)

    await this.cb
      .sendDirectSignal(
        peerPubkey,
        {
          v: 1,
          action: 'mesh-chunk-res',
          infoHash,
          swarmId,
          pieceIndex: payload.pieceIndex,
          chunkIndex: payload.chunkIndex,
          totalChunks,
          totalPieceBytes: encryptedPiece.byteLength,
          dataB64: base64UrlEncode(slice),
          ts: Date.now(),
        },
        relays
      )
      .catch(() => {})

    this.recordMeshSeedPeerActivity(swarmId, peerPubkey)
    let completedDownloadsDelta: number | undefined
    if (
      share &&
      payload.pieceIndex === share.pieceCount - 1 &&
      payload.chunkIndex === totalChunks - 1
    ) {
      const doneKey = `${swarmId}:${peerPubkey}`
      if (!this.meshCompletedPeers.has(doneKey)) {
        this.meshCompletedPeers.add(doneKey)
        completedDownloadsDelta = 1
      }
    }
    this.cb.onShareStatsUpdate(swarmId, {
      bytesUploadedDelta: slice.byteLength,
      ...(completedDownloadsDelta ? { completedDownloadsDelta } : {}),
    })
  }

  private async handleMeshChunkRes(
    peerPubkey: string,
    payload: TorrentMeshChunkResPayload
  ): Promise<void> {
    const infoHash = payload.infoHash.toLowerCase()
    const swarmId = payload.swarmId.toLowerCase()
    const session = this.downloads.get(swarmId)
    if (!session || session.aborted || session.verifying || !session.pieceHashes) return
    if (session.torrent.infoHash.toLowerCase() !== infoHash) return
    if (!this.canConnectToPeerForDownload(session, peerPubkey)) return
    if (payload.pieceIndex < 0 || payload.pieceIndex >= session.torrent.pieceCount) return
    if (
      session.completedPieces.has(payload.pieceIndex) ||
      session.verifyingPieces.has(payload.pieceIndex)
    ) {
      return
    }

    const expectedPlain = this.expectedPlaintextPieceSize(session.torrent, payload.pieceIndex)
    const expectedCipher = expectedPlain + GCM_TAG_BYTES
    const expectedTotalChunks = Math.ceil(expectedCipher / MESH_CHUNK_BYTES)
    if (
      payload.totalPieceBytes !== expectedCipher ||
      payload.totalChunks !== expectedTotalChunks ||
      payload.chunkIndex < 0 ||
      payload.chunkIndex >= expectedTotalChunks
    ) {
      return
    }

    const chunkBytes = base64UrlDecode(payload.dataB64)
    const byteOffset = payload.chunkIndex * MESH_CHUNK_BYTES
    const expectedChunkLen = Math.min(MESH_CHUNK_BYTES, expectedCipher - byteOffset)
    if (!chunkBytes || chunkBytes.byteLength !== expectedChunkLen) return

    session.meshResponsivePeers.add(peerPubkey)
    this.addMeshPeer(session, peerPubkey)
    session.meshInFlightChunks.delete(`${payload.pieceIndex}:${payload.chunkIndex}`)

    let assembly = session.meshPieceBuffers.get(payload.pieceIndex)
    if (!assembly || assembly.totalPieceBytes !== expectedCipher) {
      assembly = {
        totalChunks: expectedTotalChunks,
        totalPieceBytes: expectedCipher,
        buffer: new Uint8Array(expectedCipher),
        receivedChunks: new Set(),
      }
      session.meshPieceBuffers.set(payload.pieceIndex, assembly)
    }

    if (!assembly.receivedChunks.has(payload.chunkIndex)) {
      assembly.buffer.set(chunkBytes, byteOffset)
      assembly.receivedChunks.add(payload.chunkIndex)
      session.speedSamples.push({ ts: Date.now(), bytes: chunkBytes.byteLength })
      session.bytesTransferred = this.recomputeMeshBytesTransferred(session)
    }

    if (assembly.receivedChunks.size < assembly.totalChunks) {
      this.emitTransferState(session, 'downloading')
      this.driveMeshDownload(session)
      return
    }

    // All encrypted chunks for this piece assembled — verify AES-256-GCM + AAD + Merkle piece hash!
    session.meshPieceBuffers.delete(payload.pieceIndex)
    session.verifyingPieces.add(payload.pieceIndex)
    this.driveMeshDownload(session)

    try {
      const decrypted = await decryptTorrentPiece({
        keyBytes: session.keyBytes,
        noncePrefixBytes: session.noncePrefixBytes,
        infoHash,
        pieceIndex: payload.pieceIndex,
        ciphertext: assembly.buffer,
      })
      if (!decrypted || session.aborted || decrypted.byteLength !== expectedPlain) {
        session.verifyingPieces.delete(payload.pieceIndex)
        if (!session.aborted) this.driveMeshDownload(session)
        return
      }

      if (session.pieceHashes) {
        const pieceDigest = bytesToHex(sha256(decrypted))
        if (pieceDigest !== session.pieceHashes[payload.pieceIndex]) {
          session.verifyingPieces.delete(payload.pieceIndex)
          this.driveMeshDownload(session)
          return
        }
      }

      await this.store.putPiece(swarmId, payload.pieceIndex, assembly.buffer)
      if (session.aborted) return

      session.completedPieces.add(payload.pieceIndex)
      session.verifyingPieces.delete(payload.pieceIndex)
      session.bytesTransferred = this.recomputeMeshBytesTransferred(session)
    } finally {
      session.verifyingPieces.delete(payload.pieceIndex)
    }

    if (session.completedPieces.size >= session.torrent.pieceCount) {
      await this.verifyAndFinalizeDownload(session)
      return
    }

    this.emitTransferState(session, 'downloading')
    this.driveMeshDownload(session)
  }

  private async verifyAndFinalizeDownload(session: ActiveDownloadSession): Promise<void> {
    if (session.verifying || session.aborted) return
    session.verifying = true
    this.clearSessionTimers(session)

    this.emitTransferState(session, 'verifying')

    const swarmId = session.torrent.swarmId
    const fullHasher = sha256.create()
    const computedPieceHashes: string[] = []
    let totalVerifiedBytes = 0

    for (let i = 0; i < session.torrent.pieceCount; i += 1) {
      if (session.aborted) return
      const encrypted = await this.store.getPiece(swarmId, i)
      if (!encrypted) {
        await this.failDownload(session, `Missing piece ${i + 1}/${session.torrent.pieceCount}.`)
        return
      }
      const decrypted = await decryptTorrentPiece({
        keyBytes: session.keyBytes,
        noncePrefixBytes: session.noncePrefixBytes,
        infoHash: session.torrent.infoHash,
        pieceIndex: i,
        ciphertext: encrypted,
      })
      if (!decrypted) {
        await this.failDownload(session, 'Piece decryption integrity verification failed.')
        return
      }
      fullHasher.update(decrypted)
      computedPieceHashes.push(bytesToHex(sha256(decrypted)))
      totalVerifiedBytes += decrypted.byteLength
    }

    const actualFullHash = bytesToHex(fullHasher.digest())
    const actualPiecesRoot = computeTorrentMerkleRoot(computedPieceHashes)
    if (
      totalVerifiedBytes !== session.torrent.size ||
      actualFullHash !== session.torrent.plaintextSha256.toLowerCase() ||
      actualPiecesRoot !== session.torrent.piecesRoot.toLowerCase()
    ) {
      await this.store.deletePiecesForSwarm(swarmId)
      await this.failDownload(session, 'SHA-256 verification mismatch — file rejected.')
      return
    }

    // Notify connected seeders that transfer completed cleanly
    for (const link of this.getLinksForTorrent(swarmId, 'downloader')) {
      const sentDone = link.dc?.readyState === 'open'
      if (sentDone && link.dc) {
        this.sendControl(link.dc, { t: 'done', infoHash: session.torrent.infoHash })
      }
      this.closeLink(link, sentDone ? 150 : 0)
    }

    this.downloads.delete(swarmId)
    await this.cb.onDownloadCompleted(session.torrent, computedPieceHashes)
    this.emitTransferState(session, 'completed', {
      completedAvailable: true,
      isReSeeding: true,
    })
  }

  private async failDownload(session: ActiveDownloadSession, error: string): Promise<void> {
    this.clearSessionTimers(session)
    this.downloads.delete(session.torrent.swarmId)
    for (const link of this.getLinksForTorrent(session.torrent.swarmId, 'downloader')) {
      this.closeLink(link)
    }
    this.emitTransferState(session, 'error', { error })
  }

  private sendControl(dc: RTCDataChannel, msg: TorrentControlMessage): void {
    if (dc.readyState !== 'open') return
    try {
      dc.send(JSON.stringify(msg))
    } catch {
      // Ignore send race on closing channel
    }
  }

  private closeLink(link: TorrentPeerLink, flushDelayMs = 0): void {
    if (link.closed) return
    link.closed = true
    if (link.iceBatchTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(link.iceBatchTimer)
      link.iceBatchTimer = null
    }
    this.links.delete(link.key)

    // Release any in-flight pieces assigned to this peer so other peers can finish them
    if (link.role === 'downloader') {
      const session = this.downloads.get(link.swarmId)
      if (session) {
        for (const pieceIdx of link.inFlightRequests) {
          if (session.inFlightGlobal.get(pieceIdx) === link.peerPubkey) {
            session.inFlightGlobal.delete(pieceIdx)
          }
        }
      }
    }

    link.inFlightRequests.clear()
    link.pieceBuffers.clear()
    link.uploadQueue = []

    const closeTransports = () => {
      try {
        link.dc?.close()
      } catch {
        // Ignore
      }
      try {
        link.pc.close()
      } catch {
        // Ignore
      }
    }

    if (flushDelayMs > 0 && !this.destroyed && link.dc?.readyState === 'open') {
      const handle = {
        timer: globalThis.setTimeout(() => {
          this.pendingCloseHandles.delete(handle)
          closeTransports()
        }, flushDelayMs),
        flush: closeTransports,
      }
      this.pendingCloseHandles.add(handle)
    } else {
      closeTransports()
    }

    if (link.role === 'seeder') {
      this.cb.onShareStatsUpdate(link.swarmId, {
        activePeerCount: this.countActiveSeedPeers(link.swarmId),
      })
    }
  }

  destroy(): void {
    this.destroyed = true
    if (this.meshPeerExpiryTimer !== null) {
      globalThis.clearTimeout(this.meshPeerExpiryTimer)
      this.meshPeerExpiryTimer = null
    }
    this.meshActiveSeedPeers.clear()
    this.meshCompletedPeers.clear()
    this.lastHereBroadcastAt.clear()
    for (const swarmId of Array.from(this.downloads.keys())) {
      this.cancelDownload(swarmId, false)
    }
    for (const link of Array.from(this.links.values())) {
      this.closeLink(link)
    }
    for (const handle of Array.from(this.pendingCloseHandles)) {
      globalThis.clearTimeout(handle.timer)
      this.pendingCloseHandles.delete(handle)
      handle.flush()
    }
  }
}
