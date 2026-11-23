import { nip44, type Event as NostrEvent } from 'nostr-tools'
import type {
  AmailAckTombstone,
  AmailMeshPeer,
  AmailRelaySettings,
  AmailSealedCapsule,
} from '../types/amail.ts'
import {
  computeRecipientHint,
  estimateCapsuleSizeBytes,
  verifyAckTombstone,
  verifySealedCapsule,
} from './amailCrypto.ts'
import type { AmailStorage } from './amailStorage.ts'
import { CALL_SIGNALING_RELAYS } from './callSignaling.ts'
import type { IdentityManager } from './identity.ts'
import type { RelayPool } from './relayPool.ts'
import { buildIceServers } from './webrtcMesh.ts'
import type { TurnServerConfig } from '../types/calls.ts'

export const KIND_AMAIL_MESH_SIGNAL = 25058
export const KIND_AMAIL_EPHEMERAL_HOP = 25059

const MESH_SIGNAL_TAG = 'agnostr-amail-mesh'
const MESH_HOP_TAG = 'agnostr-amail-hop'

const BEACON_INTERVAL_MS = 28_000
const ANTI_ENTROPY_INTERVAL_MS = 38_000
const SWEEP_INTERVAL_MS = 60_000
const PEER_STALE_MS = 95_000
const CAPSULE_RELAY_COOLDOWN_MS = 45_000
const MAX_SEEN_PACKETS = 2000
const MAX_INV_ITEMS = 160
const MAX_GET_BATCH = 16
const MAX_DC_CHUNK_CHARS = 12_000
const MAX_FANOUT_PEERS = 3

interface InvSummaryItem {
  id: string
  exp: number
  h: number
}

type MeshWireMessage =
  | { t: 'inv'; ids: InvSummaryItem[]; acks: string[] }
  | { t: 'get'; ids: string[]; ackIds: string[] }
  | { t: 'capsule'; capsule: AmailSealedCapsule }
  | { t: 'ack'; ack: AmailAckTombstone }
  | { t: 'chunk'; mid: string; idx: number; total: number; data: string }

interface SignalEnvelope {
  v: 1
  action: 'offer' | 'answer' | 'ice'
  sdp?: string
  candidate?: RTCIceCandidateInit
  ts: number
}

interface ActiveWebRtcPeer {
  pubkey: string
  pc: RTCPeerConnection
  dc: RTCDataChannel | null
  state: 'connecting' | 'connected'
  connectedAt: number
  lastSyncAt: number
  capsulesExchanged: number
  pendingIce: RTCIceCandidateInit[]
  remoteDescSet: boolean
  chunkBuffers: Map<string, { total: number; parts: string[]; createdAt: number }>
}

interface EphemeralCourierEntry {
  pubkey: string
  lastSeenAt: number
  capsulesExchanged: number
}

export interface AmailMeshCallbacks {
  onCapsuleForSelf: (capsule: AmailSealedCapsule) => Promise<void>
  onAckObserved: (ack: AmailAckTombstone) => Promise<void>
  onCapsuleRelayed?: (capsuleId: string, peerCount: number) => void
  onStateChange: () => void
}

export class AmailMeshNode {
  private readonly relayPool: RelayPool
  private readonly identityManager: IdentityManager
  private readonly storage: AmailStorage
  private readonly callbacks: AmailMeshCallbacks

  private settings: AmailRelaySettings
  private turnConfig: TurnServerConfig | null = null
  private started = false
  private syncing = false

  private unsubSignal: (() => void) | null = null
  private unsubDirectSignal: (() => void) | null = null
  private unsubHop: (() => void) | null = null
  private unsubDirectHop: (() => void) | null = null

  private beaconTimer: number | null = null
  private antiEntropyTimer: number | null = null
  private sweepTimer: number | null = null

  private rtcPeers = new Map<string, ActiveWebRtcPeer>()
  private ephemeralPeers = new Map<string, EphemeralCourierEntry>()
  private seenPacketIds = new Set<string>()
  private lastRelayedAt = new Map<string, number>()
  private relayedPeerSetByCapsule = new Map<string, Set<string>>()

  constructor(params: {
    relayPool: RelayPool
    identityManager: IdentityManager
    storage: AmailStorage
    settings: AmailRelaySettings
    turnConfig?: TurnServerConfig | null
    callbacks: AmailMeshCallbacks
  }) {
    this.relayPool = params.relayPool
    this.identityManager = params.identityManager
    this.storage = params.storage
    this.settings = { ...params.settings }
    this.turnConfig = params.turnConfig ?? null
    this.callbacks = params.callbacks
  }

  private get myPubkey(): string {
    return this.identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
  }

  private get myRecipientHint(): string {
    return computeRecipientHint(this.myPubkey)
  }

  updateSettings(next: AmailRelaySettings): void {
    this.settings = { ...next }
    // Trim excess WebRTC peers if maxMeshPeers was reduced
    if (this.rtcPeers.size > this.settings.maxMeshPeers) {
      const excess = Array.from(this.rtcPeers.keys()).slice(this.settings.maxMeshPeers)
      for (const pk of excess) {
        this.closeRtcPeer(pk)
      }
      this.callbacks.onStateChange()
    }
  }

  updateTurnConfig(turnConfig: TurnServerConfig | null): void {
    this.turnConfig = turnConfig
  }

  isSyncing(): boolean {
    return this.syncing
  }

  getMeshPeers(): AmailMeshPeer[] {
    const now = Date.now()
    const out: AmailMeshPeer[] = []
    const rtcSet = new Set<string>()

    for (const peer of this.rtcPeers.values()) {
      rtcSet.add(peer.pubkey)
      out.push({
        pubkey: peer.pubkey,
        shortId: `${peer.pubkey.slice(0, 6)}…${peer.pubkey.slice(-4)}`,
        transport: 'webrtc',
        state: peer.state,
        connectedAt: peer.connectedAt,
        lastSyncAt: peer.lastSyncAt,
        capsulesExchanged: peer.capsulesExchanged,
      })
    }

    for (const ep of this.ephemeralPeers.values()) {
      if (rtcSet.has(ep.pubkey)) continue
      if (now - ep.lastSeenAt > PEER_STALE_MS) continue
      out.push({
        pubkey: ep.pubkey,
        shortId: `${ep.pubkey.slice(0, 6)}…${ep.pubkey.slice(-4)}`,
        transport: 'ephemeral',
        state: 'connected',
        connectedAt: ep.lastSeenAt,
        lastSyncAt: ep.lastSeenAt,
        capsulesExchanged: ep.capsulesExchanged,
      })
    }

    return out.sort((a, b) => {
      if (a.transport !== b.transport) return a.transport === 'webrtc' ? -1 : 1
      return b.lastSyncAt - a.lastSyncAt
    })
  }

  start(): void {
    if (this.started) return
    this.started = true

    const myPk = this.myPubkey
    const sinceSec = Math.floor(Date.now() / 1000) - 20

    // Layer 1a: Mesh courier discovery beacons
    this.unsubSignal = this.relayPool.subscribe(
      'agnostr-amail-mesh-beacons',
      CALL_SIGNALING_RELAYS,
      [{ kinds: [KIND_AMAIL_MESH_SIGNAL], '#t': [MESH_SIGNAL_TAG], since: sinceSec }],
      {
        onEvent: (ev) => {
          void this.handleMeshSignalEvent(ev)
        },
      }
    )

    // Layer 1b: Targeted WebRTC SDP/ICE signaling addressed to us
    this.unsubDirectSignal = this.relayPool.subscribe(
      'agnostr-amail-mesh-direct',
      CALL_SIGNALING_RELAYS,
      [{ kinds: [KIND_AMAIL_MESH_SIGNAL], '#p': [myPk], '#t': [MESH_SIGNAL_TAG], since: sinceSec }],
      {
        onEvent: (ev) => {
          void this.handleMeshSignalEvent(ev)
        },
      }
    )

    // Layer 2a: Bounded ephemeral mesh hop broadcast (INV / CAPSULE / ACK)
    this.unsubHop = this.relayPool.subscribe(
      'agnostr-amail-hop-pub',
      CALL_SIGNALING_RELAYS,
      [{ kinds: [KIND_AMAIL_EPHEMERAL_HOP], '#t': [MESH_HOP_TAG], since: sinceSec }],
      {
        onEvent: (ev) => {
          void this.handleEphemeralHopEvent(ev)
        },
      }
    )

    // Layer 2b: Targeted ephemeral GET / CAPSULE responses addressed to us
    this.unsubDirectHop = this.relayPool.subscribe(
      'agnostr-amail-hop-direct',
      CALL_SIGNALING_RELAYS,
      [{ kinds: [KIND_AMAIL_EPHEMERAL_HOP], '#p': [myPk], '#t': [MESH_HOP_TAG], since: sinceSec }],
      {
        onEvent: (ev) => {
          void this.handleEphemeralHopEvent(ev)
        },
      }
    )

    // Initial discovery & anti-entropy sync after brief socket settle
    window.setTimeout(() => {
      if (!this.started) return
      void this.emitMeshBeacon()
      void this.syncNow()
    }, 1200)

    this.beaconTimer = window.setInterval(() => {
      if (!this.started) return
      void this.emitMeshBeacon()
    }, BEACON_INTERVAL_MS)

    this.antiEntropyTimer = window.setInterval(() => {
      if (!this.started) return
      void this.syncNow()
    }, ANTI_ENTROPY_INTERVAL_MS)

    this.sweepTimer = window.setInterval(() => {
      if (!this.started) return
      void this.runPeriodicSweep()
    }, SWEEP_INTERVAL_MS)
  }

  stop(): void {
    this.started = false
    if (this.unsubSignal) {
      this.unsubSignal()
      this.unsubSignal = null
    }
    if (this.unsubDirectSignal) {
      this.unsubDirectSignal()
      this.unsubDirectSignal = null
    }
    if (this.unsubHop) {
      this.unsubHop()
      this.unsubHop = null
    }
    if (this.unsubDirectHop) {
      this.unsubDirectHop()
      this.unsubDirectHop = null
    }
    if (this.beaconTimer !== null) {
      window.clearInterval(this.beaconTimer)
      this.beaconTimer = null
    }
    if (this.antiEntropyTimer !== null) {
      window.clearInterval(this.antiEntropyTimer)
      this.antiEntropyTimer = null
    }
    if (this.sweepTimer !== null) {
      window.clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    for (const pk of Array.from(this.rtcPeers.keys())) {
      this.closeRtcPeer(pk)
    }
    this.ephemeralPeers.clear()
    this.seenPacketIds.clear()
    this.lastRelayedAt.clear()
    this.relayedPeerSetByCapsule.clear()
  }

  /**
   * Triggers an immediate Briar anti-entropy sync round across all connected
   * WebRTC couriers + Layer 2 ephemeral mesh peers.
   */
  async syncNow(): Promise<void> {
    if (!this.started) return
    this.syncing = true
    this.callbacks.onStateChange()
    try {
      const inv = this.buildInvMessage()
      // Layer 1: Direct WebRTC DataChannels
      for (const peer of this.rtcPeers.values()) {
        if (peer.dc && peer.dc.readyState === 'open') {
          this.sendWireMessage(peer, inv)
          peer.lastSyncAt = Date.now()
        }
      }
      // Layer 2: Bounded ephemeral mesh INV + courier beacon
      await this.emitMeshBeacon()
      if (inv.ids.length > 0 || inv.acks.length > 0) {
        await this.publishEphemeralHop(inv)
      }
    } finally {
      this.syncing = false
      this.callbacks.onStateChange()
    }
  }

  /**
   * Dispatches a newly sealed local capsule into connected WebRTC couriers (fanout <= 3)
   * AND emits a bounded Layer 2 ephemeral hop so both online recipients and offline
   * Briar couriers pick it up immediately.
   */
  async publishLocalCapsule(capsule: AmailSealedCapsule): Promise<number> {
    let relayedCount = 0
    const connected = Array.from(this.rtcPeers.values()).filter(
      (p) => p.dc && p.dc.readyState === 'open'
    )
    const fanoutPeers = connected.slice(0, MAX_FANOUT_PEERS)
    const nextHopCapsule: AmailSealedCapsule = {
      ...capsule,
      hopCount: capsule.hopCount + 1,
    }

    for (const peer of fanoutPeers) {
      if (this.sendWireMessage(peer, { t: 'capsule', capsule: nextHopCapsule })) {
        peer.capsulesExchanged += 1
        peer.lastSyncAt = Date.now()
        relayedCount += 1
        this.recordRelayedToPeer(capsule.capsuleId, peer.pubkey)
      }
    }

    const res = await this.publishEphemeralHop({ t: 'capsule', capsule: nextHopCapsule })
    if (res > 0) {
      relayedCount = Math.max(relayedCount, 1)
    }

    if (relayedCount > 0) {
      await this.storage.incrementCapsuleRelayed(capsule.capsuleId)
      this.lastRelayedAt.set(capsule.capsuleId, Date.now())
      this.callbacks.onCapsuleRelayed?.(
        capsule.capsuleId,
        this.getRelayedPeerCount(capsule.capsuleId)
      )
    }

    this.callbacks.onStateChange()
    return relayedCount
  }

  /**
   * Broadcasts a recipient-signed ACK cancellation tombstone across ALL connected
   * WebRTC couriers + Layer 2 ephemeral mesh so couriers purge ciphertext immediately.
   */
  async broadcastAckTombstone(ack: AmailAckTombstone): Promise<void> {
    const packet: MeshWireMessage = { t: 'ack', ack }
    for (const peer of this.rtcPeers.values()) {
      if (peer.dc && peer.dc.readyState === 'open') {
        this.sendWireMessage(peer, packet)
      }
    }
    await this.publishEphemeralHop(packet)
  }

  /* ------------------------------------------------------------------------
     Layer 1: Direct WebRTC DataChannel Mesh Discovery & Signaling
     ------------------------------------------------------------------------ */

  private async emitMeshBeacon(): Promise<void> {
    if (!this.started) return
    try {
      const material = this.identityManager.getMasterKeyMaterial()
      const payload = JSON.stringify({
        v: 1,
        action: 'beacon',
        relay: this.settings.relayEnabled,
        caps: this.storage.getAllVaultCapsules().length,
        ts: Date.now(),
      })
      const signed = await this.identityManager.signEventWithMaterial(
        {
          kind: KIND_AMAIL_MESH_SIGNAL,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['t', MESH_SIGNAL_TAG],
            ['m', 'beacon'],
          ],
          content: payload,
        },
        material
      )
      await this.relayPool.publish(CALL_SIGNALING_RELAYS, signed, 2500)
    } catch {
      // Best-effort discovery
    }
  }

  private async handleMeshSignalEvent(ev: NostrEvent): Promise<void> {
    if (!this.started || ev.kind !== KIND_AMAIL_MESH_SIGNAL) return
    if (this.markPacketSeen(ev.id)) return

    const peerPk = ev.pubkey.toLowerCase()
    const myPk = this.myPubkey
    if (!peerPk || peerPk === myPk) return

    const nowSec = Math.floor(Date.now() / 1000)
    if (Math.abs(nowSec - ev.created_at) > 75) return

    const pTag = ev.tags.find((t) => t[0] === 'p' && t[1])?.[1]?.toLowerCase()
    const mTag = ev.tags.find((t) => t[0] === 'm' && t[1])?.[1]

    // Public beacon discovery
    if (mTag === 'beacon' && !pTag) {
      this.touchEphemeralPeer(peerPk)
      if (
        typeof RTCPeerConnection !== 'undefined' &&
        !this.rtcPeers.has(peerPk) &&
        this.rtcPeers.size < this.settings.maxMeshPeers &&
        myPk > peerPk
      ) {
        // Deterministic glare avoidance: lexicographically higher pubkey sends Offer
        void this.initiateWebRtcOffer(peerPk)
      }
      return
    }

    // Targeted NIP-44 encrypted WebRTC SDP/ICE signal
    if (pTag !== myPk) return
    const env = await this.decryptSignalEnvelope(ev.content, peerPk)
    if (!env) return

    if (env.action === 'offer' && env.sdp) {
      await this.handleWebRtcOffer(peerPk, env.sdp)
    } else if (env.action === 'answer' && env.sdp) {
      await this.handleWebRtcAnswer(peerPk, env.sdp)
    } else if (env.action === 'ice' && env.candidate) {
      await this.handleWebRtcIce(peerPk, env.candidate)
    }
  }

  private async encryptSignalEnvelope(
    env: SignalEnvelope,
    peerPk: string
  ): Promise<string | null> {
    try {
      const material = this.identityManager.getMasterKeyMaterial()
      const plaintext = JSON.stringify(env)
      if (material.mode === 'extension') {
        if (!window.nostr?.nip44?.encrypt) return null
        return await window.nostr.nip44.encrypt(peerPk, plaintext)
      }
      if (!material.secretKey) return null
      const convKey = nip44.v2.utils.getConversationKey(material.secretKey, peerPk)
      return nip44.v2.encrypt(plaintext, convKey)
    } catch {
      return null
    }
  }

  private async decryptSignalEnvelope(
    ciphertext: string,
    peerPk: string
  ): Promise<SignalEnvelope | null> {
    try {
      const material = this.identityManager.getMasterKeyMaterial()
      let raw: string
      if (material.mode === 'extension') {
        if (!window.nostr?.nip44?.decrypt) return null
        raw = await window.nostr.nip44.decrypt(peerPk, ciphertext)
      } else {
        if (!material.secretKey) return null
        const convKey = nip44.v2.utils.getConversationKey(material.secretKey, peerPk)
        raw = nip44.v2.decrypt(ciphertext, convKey)
      }
      const parsed = JSON.parse(raw) as Partial<SignalEnvelope>
      if (
        !parsed ||
        parsed.v !== 1 ||
        (parsed.action !== 'offer' && parsed.action !== 'answer' && parsed.action !== 'ice')
      ) {
        return null
      }
      return parsed as SignalEnvelope
    } catch {
      return null
    }
  }

  private async publishSignalEnvelope(peerPk: string, env: SignalEnvelope): Promise<void> {
    const ciphertext = await this.encryptSignalEnvelope(env, peerPk)
    if (!ciphertext) return
    try {
      const material = this.identityManager.getMasterKeyMaterial()
      const signed = await this.identityManager.signEventWithMaterial(
        {
          kind: KIND_AMAIL_MESH_SIGNAL,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['t', MESH_SIGNAL_TAG],
            ['p', peerPk],
          ],
          content: ciphertext,
        },
        material
      )
      await this.relayPool.publish(CALL_SIGNALING_RELAYS, signed, 2500)
    } catch {
      // Ignore transient publish errors
    }
  }

  private createRtcPeer(peerPk: string): ActiveWebRtcPeer {
    const existing = this.rtcPeers.get(peerPk)
    if (existing) this.closeRtcPeer(peerPk)

    const pc = new RTCPeerConnection({
      iceServers: buildIceServers(this.turnConfig),
    })

    const peer: ActiveWebRtcPeer = {
      pubkey: peerPk,
      pc,
      dc: null,
      state: 'connecting',
      connectedAt: Date.now(),
      lastSyncAt: Date.now(),
      capsulesExchanged: 0,
      pendingIce: [],
      remoteDescSet: false,
      chunkBuffers: new Map(),
    }

    pc.onicecandidate = (e) => {
      if (e.candidate && this.started) {
        void this.publishSignalEnvelope(peerPk, {
          v: 1,
          action: 'ice',
          candidate: e.candidate.toJSON(),
          ts: Date.now(),
        })
      }
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.closeRtcPeer(peerPk)
        this.callbacks.onStateChange()
      }
    }

    pc.ondatachannel = (e) => {
      if (e.channel.label === 'amail-mesh') {
        this.attachDataChannel(peer, e.channel)
      }
    }

    this.rtcPeers.set(peerPk, peer)
    this.callbacks.onStateChange()
    return peer
  }

  private attachDataChannel(peer: ActiveWebRtcPeer, dc: RTCDataChannel): void {
    peer.dc = dc
    dc.onopen = () => {
      peer.state = 'connected'
      peer.connectedAt = Date.now()
      peer.lastSyncAt = Date.now()
      this.callbacks.onStateChange()
      // Immediately start Briar anti-entropy INV exchange upon DataChannel open
      this.sendWireMessage(peer, this.buildInvMessage())
    }
    dc.onclose = () => {
      this.closeRtcPeer(peer.pubkey)
      this.callbacks.onStateChange()
    }
    dc.onerror = () => {
      this.closeRtcPeer(peer.pubkey)
      this.callbacks.onStateChange()
    }
    dc.onmessage = (e) => {
      if (typeof e.data !== 'string') return
      void this.handleDataChannelMessage(peer, e.data)
    }
  }

  private async initiateWebRtcOffer(peerPk: string): Promise<void> {
    try {
      const peer = this.createRtcPeer(peerPk)
      const dc = peer.pc.createDataChannel('amail-mesh', { ordered: true })
      this.attachDataChannel(peer, dc)

      const offer = await peer.pc.createOffer()
      await peer.pc.setLocalDescription(offer)
      if (offer.sdp) {
        await this.publishSignalEnvelope(peerPk, {
          v: 1,
          action: 'offer',
          sdp: offer.sdp,
          ts: Date.now(),
        })
      }
    } catch {
      this.closeRtcPeer(peerPk)
    }
  }

  private async handleWebRtcOffer(peerPk: string, sdp: string): Promise<void> {
    if (!this.rtcPeers.has(peerPk) && this.rtcPeers.size >= this.settings.maxMeshPeers) {
      return
    }
    try {
      const peer = this.createRtcPeer(peerPk)
      await peer.pc.setRemoteDescription({ type: 'offer', sdp })
      peer.remoteDescSet = true
      await this.flushPendingIce(peer)

      const answer = await peer.pc.createAnswer()
      await peer.pc.setLocalDescription(answer)
      if (answer.sdp) {
        await this.publishSignalEnvelope(peerPk, {
          v: 1,
          action: 'answer',
          sdp: answer.sdp,
          ts: Date.now(),
        })
      }
    } catch {
      this.closeRtcPeer(peerPk)
    }
  }

  private async handleWebRtcAnswer(peerPk: string, sdp: string): Promise<void> {
    const peer = this.rtcPeers.get(peerPk)
    if (!peer || peer.pc.signalingState !== 'have-local-offer') return
    try {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp })
      peer.remoteDescSet = true
      await this.flushPendingIce(peer)
    } catch {
      this.closeRtcPeer(peerPk)
    }
  }

  private async handleWebRtcIce(peerPk: string, candidate: RTCIceCandidateInit): Promise<void> {
    const peer = this.rtcPeers.get(peerPk)
    if (!peer) return
    if (!peer.remoteDescSet) {
      if (peer.pendingIce.length < 40) {
        peer.pendingIce.push(candidate)
      }
      return
    }
    try {
      await peer.pc.addIceCandidate(candidate)
    } catch {
      // Ignore late ICE candidates
    }
  }

  private async flushPendingIce(peer: ActiveWebRtcPeer): Promise<void> {
    const queued = peer.pendingIce.splice(0, peer.pendingIce.length)
    for (const cand of queued) {
      try {
        await peer.pc.addIceCandidate(cand)
      } catch {
        // Ignore
      }
    }
  }

  private closeRtcPeer(peerPk: string): void {
    const peer = this.rtcPeers.get(peerPk)
    if (!peer) return
    this.rtcPeers.delete(peerPk)
    try {
      peer.dc?.close()
    } catch {
      // Ignore
    }
    try {
      peer.pc.close()
    } catch {
      // Ignore
    }
  }

  private sendWireMessage(peer: ActiveWebRtcPeer, msg: MeshWireMessage): boolean {
    if (!peer.dc || peer.dc.readyState !== 'open') return false
    try {
      const encoded = JSON.stringify(msg)
      if (encoded.length <= MAX_DC_CHUNK_CHARS) {
        peer.dc.send(encoded)
        return true
      }
      // Split large sealed capsules cleanly into ordered chunks
      const mid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const total = Math.ceil(encoded.length / MAX_DC_CHUNK_CHARS)
      for (let idx = 0; idx < total; idx++) {
        const chunk: MeshWireMessage = {
          t: 'chunk',
          mid,
          idx,
          total,
          data: encoded.slice(idx * MAX_DC_CHUNK_CHARS, (idx + 1) * MAX_DC_CHUNK_CHARS),
        }
        peer.dc.send(JSON.stringify(chunk))
      }
      return true
    } catch {
      return false
    }
  }

  private async handleDataChannelMessage(peer: ActiveWebRtcPeer, raw: string): Promise<void> {
    let parsed: MeshWireMessage
    try {
      parsed = JSON.parse(raw) as MeshWireMessage
    } catch {
      return
    }

    if (parsed.t === 'chunk') {
      if (parsed.total > 20 || parsed.idx < 0 || parsed.idx >= parsed.total) return
      let buf = peer.chunkBuffers.get(parsed.mid)
      if (!buf) {
        buf = { total: parsed.total, parts: new Array(parsed.total).fill(''), createdAt: Date.now() }
        peer.chunkBuffers.set(parsed.mid, buf)
      }
      buf.parts[parsed.idx] = parsed.data
      if (buf.parts.every((p) => p.length > 0)) {
        peer.chunkBuffers.delete(parsed.mid)
        await this.handleDataChannelMessage(peer, buf.parts.join(''))
      }
      return
    }

    peer.lastSyncAt = Date.now()

    if (parsed.t === 'inv') {
      const getMsg = this.computeGetRequestFromInv(parsed)
      if (getMsg.ids.length > 0 || getMsg.ackIds.length > 0) {
        this.sendWireMessage(peer, getMsg)
      }
      return
    }

    if (parsed.t === 'get') {
      for (const id of parsed.ids.slice(0, MAX_GET_BATCH)) {
        const cap = this.storage.getVaultCapsule(id)
        if (!cap || cap.hopCount >= cap.maxHops) continue
        if (this.storage.hasTombstone(cap.capsuleId)) continue
        const nextCap: AmailSealedCapsule = { ...cap, hopCount: cap.hopCount + 1 }
        if (this.sendWireMessage(peer, { t: 'capsule', capsule: nextCap })) {
          peer.capsulesExchanged += 1
          this.recordRelayedToPeer(cap.capsuleId, peer.pubkey)
          await this.storage.incrementCapsuleRelayed(cap.capsuleId)
          this.callbacks.onCapsuleRelayed?.(
            cap.capsuleId,
            this.getRelayedPeerCount(cap.capsuleId)
          )
        }
      }
      for (const ackId of parsed.ackIds.slice(0, MAX_GET_BATCH)) {
        const ack = this.storage.getTombstone(ackId)
        if (ack) {
          this.sendWireMessage(peer, { t: 'ack', ack })
        }
      }
      this.callbacks.onStateChange()
      return
    }

    if (parsed.t === 'capsule') {
      peer.capsulesExchanged += 1
      await this.handleIncomingCapsule(parsed.capsule, 'webrtc-mesh', peer.pubkey)
      return
    }

    if (parsed.t === 'ack') {
      await this.handleIncomingAck(parsed.ack, peer.pubkey)
    }
  }

  /* ------------------------------------------------------------------------
     Layer 2: Bounded Ephemeral Mesh Hop (`kind: 25059`)
     ------------------------------------------------------------------------ */

  private async publishEphemeralHop(
    msg: MeshWireMessage,
    targetPeerPubkey?: string
  ): Promise<number> {
    if (!this.started) return 0
    try {
      const material = this.identityManager.getMasterKeyMaterial()
      const tags: string[][] = [['t', MESH_HOP_TAG]]
      if (targetPeerPubkey) {
        tags.push(['p', targetPeerPubkey.toLowerCase()])
      }
      const signed = await this.identityManager.signEventWithMaterial(
        {
          kind: KIND_AMAIL_EPHEMERAL_HOP,
          created_at: Math.floor(Date.now() / 1000),
          tags,
          content: JSON.stringify(msg),
        },
        material
      )
      this.markPacketSeen(signed.id)
      const res = await this.relayPool.publish(CALL_SIGNALING_RELAYS, signed, 2500)
      return res.acceptedRelays.length
    } catch {
      return 0
    }
  }

  private async handleEphemeralHopEvent(ev: NostrEvent): Promise<void> {
    if (!this.started || ev.kind !== KIND_AMAIL_EPHEMERAL_HOP) return
    if (this.markPacketSeen(ev.id)) return

    const peerPk = ev.pubkey.toLowerCase()
    const myPk = this.myPubkey
    if (!peerPk || peerPk === myPk) return

    const pTag = ev.tags.find((t) => t[0] === 'p' && t[1])?.[1]?.toLowerCase()
    if (pTag && pTag !== myPk) return

    let parsed: MeshWireMessage
    try {
      parsed = JSON.parse(ev.content) as MeshWireMessage
    } catch {
      return
    }

    const ep = this.touchEphemeralPeer(peerPk)

    if (parsed.t === 'inv') {
      const getMsg = this.computeGetRequestFromInv(parsed)
      if (getMsg.ids.length > 0 || getMsg.ackIds.length > 0) {
        await this.publishEphemeralHop(getMsg, peerPk)
      }
      return
    }

    if (parsed.t === 'get' && pTag === myPk) {
      for (const id of parsed.ids.slice(0, MAX_GET_BATCH)) {
        const cap = this.storage.getVaultCapsule(id)
        if (!cap || cap.hopCount >= cap.maxHops) continue
        if (this.storage.hasTombstone(cap.capsuleId)) continue
        const nextCap: AmailSealedCapsule = { ...cap, hopCount: cap.hopCount + 1 }
        const sent = await this.publishEphemeralHop({ t: 'capsule', capsule: nextCap }, peerPk)
        if (sent > 0) {
          ep.capsulesExchanged += 1
          this.recordRelayedToPeer(cap.capsuleId, peerPk)
          await this.storage.incrementCapsuleRelayed(cap.capsuleId)
          this.callbacks.onCapsuleRelayed?.(cap.capsuleId, this.getRelayedPeerCount(cap.capsuleId))
        }
      }
      for (const ackId of parsed.ackIds.slice(0, MAX_GET_BATCH)) {
        const ack = this.storage.getTombstone(ackId)
        if (ack) {
          await this.publishEphemeralHop({ t: 'ack', ack }, peerPk)
        }
      }
      this.callbacks.onStateChange()
      return
    }

    if (parsed.t === 'capsule') {
      ep.capsulesExchanged += 1
      await this.handleIncomingCapsule(parsed.capsule, 'ephemeral-mesh', peerPk)
      return
    }

    if (parsed.t === 'ack') {
      await this.handleIncomingAck(parsed.ack, peerPk)
    }
  }

  /* ------------------------------------------------------------------------
     Anti-Entropy Set Reconciliation, Verification & Bounded Forwarding
     ------------------------------------------------------------------------ */

  private buildInvMessage(): Extract<MeshWireMessage, { t: 'inv' }> {
    const nowSec = Math.floor(Date.now() / 1000)
    const ids: InvSummaryItem[] = []
    for (const c of this.storage.getAllVaultCapsules()) {
      if (c.expiresAt <= nowSec) continue
      if (c.hopCount >= c.maxHops) continue
      if (this.storage.hasTombstone(c.capsuleId)) continue
      ids.push({ id: c.capsuleId, exp: c.expiresAt, h: c.hopCount })
      if (ids.length >= MAX_INV_ITEMS) break
    }
    const acks: string[] = []
    for (const a of this.storage.getAllTombstones()) {
      if (a.expiresAt <= nowSec) continue
      acks.push(a.capsuleId)
      if (acks.length >= MAX_INV_ITEMS) break
    }
    return { t: 'inv', ids, acks }
  }

  private computeGetRequestFromInv(
    inv: Extract<MeshWireMessage, { t: 'inv' }>
  ): Extract<MeshWireMessage, { t: 'get' }> {
    const nowSec = Math.floor(Date.now() / 1000)
    const wantIds: string[] = []
    const wantAckIds: string[] = []

    if (Array.isArray(inv.acks)) {
      for (const ackId of inv.acks) {
        if (typeof ackId !== 'string') continue
        if (!this.storage.hasTombstone(ackId)) {
          wantAckIds.push(ackId)
          if (wantAckIds.length >= MAX_GET_BATCH) break
        }
      }
    }

    if (Array.isArray(inv.ids)) {
      for (const item of inv.ids) {
        if (!item || typeof item.id !== 'string') continue
        if (item.exp <= nowSec) continue
        if (item.h >= this.settings.maxHops) continue
        if (this.storage.hasTombstone(item.id)) continue
        if (this.storage.getVaultCapsule(item.id)) continue
        // Even if relayEnabled is false, we STILL request capsules so we can check
        // if they match our blinded recipientHint (we simply won't persist third-party ones!)
        wantIds.push(item.id)
        if (wantIds.length >= MAX_GET_BATCH) break
      }
    }

    return { t: 'get', ids: wantIds, ackIds: wantAckIds }
  }

  private async handleIncomingCapsule(
    rawCapsule: AmailSealedCapsule,
    via: 'webrtc-mesh' | 'ephemeral-mesh',
    fromPeerPk: string
  ): Promise<void> {
    if (!verifySealedCapsule(rawCapsule)) return

    const nowSec = Math.floor(Date.now() / 1000)
    if (rawCapsule.expiresAt <= nowSec) return
    if (rawCapsule.hopCount > rawCapsule.maxHops) return
    if (this.storage.hasTombstone(rawCapsule.capsuleId)) {
      // Remind sender with our verified ACK tombstone so they purge it too!
      const ack = this.storage.getTombstone(rawCapsule.capsuleId)
      if (ack) {
        const rtc = this.rtcPeers.get(fromPeerPk)
        if (rtc && rtc.dc?.readyState === 'open') {
          this.sendWireMessage(rtc, { t: 'ack', ack })
        }
      }
      return
    }

    const normalized: AmailSealedCapsule = {
      ...rawCapsule,
      receivedVia: via,
      storedAt: Date.now(),
      sizeBytes: estimateCapsuleSizeBytes(rawCapsule),
      relayedToCount: 0,
    }

    // 1. Check blinded recipient hint: is this capsule addressed to US?
    if (normalized.recipientHint === this.myRecipientHint) {
      await this.callbacks.onCapsuleForSelf(normalized)
      this.callbacks.onStateChange()
      return
    }

    // 2. Third-party capsule: store in IndexedDB relayVault ONLY when Mesh Relay is enabled
    if (!this.settings.relayEnabled) return
    if (normalized.hopCount >= Math.min(normalized.maxHops, this.settings.maxHops)) {
      return
    }

    const storedNew = await this.storage.putRelayCapsule(normalized, {
      ownPubkey: this.myPubkey,
    })

    if (storedNew) {
      // Bounded opportunistic forward to up to MAX_FANOUT_PEERS other connected WebRTC couriers
      const lastFwd = this.lastRelayedAt.get(normalized.capsuleId) ?? 0
      if (Date.now() - lastFwd >= CAPSULE_RELAY_COOLDOWN_MS) {
        const nextHop = normalized.hopCount + 1
        if (nextHop < Math.min(normalized.maxHops, this.settings.maxHops)) {
          const forwardCapsule: AmailSealedCapsule = { ...normalized, hopCount: nextHop }
          let forwarded = 0
          for (const peer of this.rtcPeers.values()) {
            if (peer.pubkey === fromPeerPk) continue
            if (!peer.dc || peer.dc.readyState !== 'open') continue
            if (this.sendWireMessage(peer, { t: 'capsule', capsule: forwardCapsule })) {
              peer.capsulesExchanged += 1
              forwarded += 1
              this.recordRelayedToPeer(normalized.capsuleId, peer.pubkey)
              if (forwarded >= MAX_FANOUT_PEERS) break
            }
          }
          if (forwarded > 0) {
            this.lastRelayedAt.set(normalized.capsuleId, Date.now())
            await this.storage.incrementCapsuleRelayed(normalized.capsuleId)
          }
        }
      }
      this.callbacks.onStateChange()
    }
  }

  private async handleIncomingAck(ack: AmailAckTombstone, fromPeerPk: string): Promise<void> {
    if (!verifyAckTombstone(ack)) return
    const { isNew } = await this.storage.applyAckTombstone(ack)
    if (!isNew) return

    // Notify hook so outgoing mail matching `ack.capsuleId` advances to `delivered`!
    await this.callbacks.onAckObserved(ack)

    // Propagate signed ACK cancellation once to other connected WebRTC couriers
    for (const peer of this.rtcPeers.values()) {
      if (peer.pubkey === fromPeerPk) continue
      if (peer.dc && peer.dc.readyState === 'open') {
        this.sendWireMessage(peer, { t: 'ack', ack })
      }
    }
    this.callbacks.onStateChange()
  }

  private async runPeriodicSweep(): Promise<void> {
    const now = Date.now()
    for (const [pk, entry] of Array.from(this.ephemeralPeers.entries())) {
      if (now - entry.lastSeenAt > PEER_STALE_MS) {
        this.ephemeralPeers.delete(pk)
      }
    }
    for (const peer of this.rtcPeers.values()) {
      for (const [mid, buf] of Array.from(peer.chunkBuffers.entries())) {
        if (now - buf.createdAt > 30_000) {
          peer.chunkBuffers.delete(mid)
        }
      }
    }
    await this.storage.pruneExpired()
    this.callbacks.onStateChange()
  }

  private touchEphemeralPeer(pubkey: string): EphemeralCourierEntry {
    const existing = this.ephemeralPeers.get(pubkey)
    if (existing) {
      existing.lastSeenAt = Date.now()
      return existing
    }
    const created: EphemeralCourierEntry = {
      pubkey,
      lastSeenAt: Date.now(),
      capsulesExchanged: 0,
    }
    this.ephemeralPeers.set(pubkey, created)
    this.callbacks.onStateChange()
    return created
  }

  private markPacketSeen(id: string): boolean {
    if (this.seenPacketIds.has(id)) return true
    this.seenPacketIds.add(id)
    if (this.seenPacketIds.size > MAX_SEEN_PACKETS) {
      const oldest = this.seenPacketIds.values().next().value
      if (oldest) this.seenPacketIds.delete(oldest)
    }
    return false
  }

  private recordRelayedToPeer(capsuleId: string, peerPk: string): void {
    let set = this.relayedPeerSetByCapsule.get(capsuleId)
    if (!set) {
      set = new Set()
      this.relayedPeerSetByCapsule.set(capsuleId, set)
    }
    set.add(peerPk)
  }

  private getRelayedPeerCount(capsuleId: string): number {
    return this.relayedPeerSetByCapsule.get(capsuleId)?.size ?? 0
  }
}
