import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_SERVER_VOICE_ROOM_ID,
  MAX_CALL_PARTICIPANTS,
  type ActiveCallSession,
  type CallEngine,
  type CallMediaType,
  type CallParticipant,
  type GeoCallPresence,
  type IncomingCallOffer,
  type RecordingQualityPreset,
  type RoomCallPresence,
  type TurnServerConfig,
} from '../types/calls.ts'
import type { ToastLevel } from '../types/protocol.ts'
import type { ServerSummary } from '../types/servers.ts'
import { verifyEventCached } from '../lib/bitchatProtocol.ts'
import {
  CallRecorderController,
  DEFAULT_RECORDING_QUALITY,
  getRecordingQualitySpec,
  isCallRecordingSupported,
  isValidRecordingQuality,
  type CallRecordingMode,
} from '../lib/callRecorder.ts'
import {
  buildDirectCallSignalTemplate,
  buildGeoCallSignalTemplate,
  buildRoomCallSignalTemplate,
  CALL_SIGNALING_RELAYS,
  DM_CALL_SIGNAL_TAG,
  generateCallId,
  getGeoCallRoomId,
  getGeoCallRoomTag,
  getRelaysForServerCall,
  getServerCallRoomTag,
  KIND_CALL_SIGNAL,
  MAX_SIGNAL_AGE_SEC,
  parseDirectCallSignalEvent,
  parseGeoCallSignalEvent,
  parseRoomCallSignalEvent,
  ROOM_HEARTBEAT_INTERVAL_MS,
  ROOM_PEER_TTL_MS,
  type DirectCallSignalPayload,
  type GeoCallSignalPayload,
  type RoomCallSignalPayload,
} from '../lib/callSignaling.ts'
import { normalizeGeohash } from '../lib/geohash.ts'
import {
  formatDisplayHandle,
  type IdentityManager,
  type SigningKeyMaterial,
} from '../lib/identity.ts'
import {
  formatRadioChannelLabel,
  isTopicChannel,
  isValidRadioChannelKey,
  normalizeRadioChannelKey,
} from '../lib/radioChannel.ts'
import type { RelayPool } from '../lib/relayPool.ts'
import {
  loadRecordingQuality,
  loadTurnConfig,
  normalizeTurnUrl,
  saveRecordingQuality as persistRecordingQuality,
  saveTurnConfig as persistTurnConfig,
} from '../lib/storage.ts'
import { isScreenShareSupported, WebRtcMesh } from '../lib/webrtcMesh.ts'

const RING_TIMEOUT_MS = 45_000
const OUTGOING_INVITE_REBROADCAST_MS = 3_500
const ROSTER_SWEEP_INTERVAL_MS = 5_000
const MAX_SEEN_SIGNALS = 600

export interface UseCallEngineParams {
  pool: RelayPool | null
  identityManager: IdentityManager
  servers: ServerSummary[]
  activeGeohash: string
  pinnedGeohashes: string[]
  identityVersion: number
  blockedSet: Set<string>
  trustedSet: Set<string>
  isExplicitlyTrusted: (pubkey: string) => boolean
  strictWhitelistMode?: boolean
  getPeerNickname: (pubkey: string) => string | undefined
  pushToast: (level: ToastLevel, title: string, detail?: string) => void
}

export interface UseCallEngineResult {
  calls: CallEngine
  callSignalingRelays: string[]
  resetAllCalls: () => void
}

export function useCallEngine(params: UseCallEngineParams): UseCallEngineResult {
  const {
    pool,
    identityManager,
    servers,
    activeGeohash,
    pinnedGeohashes,
    identityVersion,
    blockedSet,
    trustedSet,
    isExplicitlyTrusted,
    getPeerNickname,
    pushToast,
  } = params

  const [activeCall, setActiveCall] = useState<ActiveCallSession | null>(null)
  const [incomingCall, setIncomingCall] = useState<IncomingCallOffer | null>(null)
  const [serverCallRosters, setServerCallRosters] = useState<Record<string, RoomCallPresence[]>>({})
  const [geoCallRosters, setGeoCallRosters] = useState<Record<string, GeoCallPresence[]>>({})
  const [turnConfig, setTurnConfig] = useState<TurnServerConfig | null>(() => loadTurnConfig())
  const [recordingQuality, setRecordingQualityState] = useState<RecordingQualityPreset>(() => loadRecordingQuality())

  const poolRef = useRef<RelayPool | null>(pool)
  poolRef.current = pool

  const serversRef = useRef<ServerSummary[]>(servers)
  serversRef.current = servers

  const blockedSetRef = useRef<Set<string>>(blockedSet)
  blockedSetRef.current = blockedSet

  const isExplicitlyTrustedRef = useRef(isExplicitlyTrusted)
  isExplicitlyTrustedRef.current = isExplicitlyTrusted

  const getPeerNicknameRef = useRef(getPeerNickname)
  getPeerNicknameRef.current = getPeerNickname

  const pushToastRef = useRef(pushToast)
  pushToastRef.current = pushToast

  const turnConfigRef = useRef<TurnServerConfig | null>(turnConfig)
  turnConfigRef.current = turnConfig

  const recordingQualityRef = useRef<RecordingQualityPreset>(recordingQuality)
  recordingQualityRef.current = recordingQuality

  const activeCallRef = useRef<ActiveCallSession | null>(activeCall)
  activeCallRef.current = activeCall

  const incomingCallRef = useRef<IncomingCallOffer | null>(incomingCall)
  incomingCallRef.current = incomingCall

  const rostersRef = useRef<Record<string, RoomCallPresence[]>>(serverCallRosters)
  rostersRef.current = serverCallRosters

  const geoRostersRef = useRef<Record<string, GeoCallPresence[]>>(geoCallRosters)
  geoRostersRef.current = geoCallRosters

  const meshRef = useRef<WebRtcMesh | null>(null)
  const activeGeoMaterialRef = useRef<SigningKeyMaterial | null>(null)
  const geoDirectUnsubRef = useRef<(() => void) | null>(null)
  const recorderRef = useRef<CallRecorderController | null>(null)
  const recordingStartedAtRef = useRef<number | null>(null)
  const recordingModeRef = useRef<CallRecordingMode | null>(null)
  const recordingQualityActiveRef = useRef<RecordingQualityPreset | null>(null)
  const recordingBytesRef = useRef<number>(0)
  const remoteRecordingRef = useRef<Map<string, boolean>>(new Map())
  const seenEventIdsRef = useRef<Set<string>>(new Set())
  const lastLeaveTsByRoomPeerRef = useRef<Map<string, number>>(new Map())
  const lastPresenceTsByRoomPeerRef = useRef<Map<string, number>>(new Map())
  const endedCallIdsRef = useRef<Set<string>>(new Set())
  const outgoingRingTimerRef = useRef<number | null>(null)
  const outgoingRingInviteTimerRef = useRef<number | null>(null)
  const incomingRingTimerRef = useRef<number | null>(null)
  const roomHeartbeatTimerRef = useRef<number | null>(null)
  const lastRoomPongRef = useRef<number>(0)
  const lastGeoRoomPongRef = useRef<number>(0)

  const masterPubkey = useMemo(() => {
    void identityVersion
    return identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
  }, [identityManager, identityVersion])

  // Keep self nickname fresh inside any active WebRTC mesh
  useEffect(() => {
    void identityVersion
    meshRef.current?.updateSelfNickname(identityManager.getNickname())
  }, [identityManager, identityVersion])

  // Compute combined signaling relays (live-verified core call relays + joined server relays)
  const callSignalingRelays = useMemo(() => {
    const set = new Set<string>(CALL_SIGNALING_RELAYS)
    for (const s of servers) {
      for (const r of s.relays) {
        if (r.startsWith('wss://')) set.add(r)
      }
    }
    return Array.from(set)
  }, [servers])

  const syncActiveCallFromMesh = useCallback(() => {
    const mesh = meshRef.current
    const current = activeCallRef.current
    if (!mesh || !current) return

    const rawMeshParticipants = mesh.getParticipantsSnapshot()
    // Defense-in-depth: never expose media streams or record/transcribe untrusted remote peers
    const trustedMeshParticipants: CallParticipant[] = []
    for (const p of rawMeshParticipants) {
      if (p.isSelf) {
        trustedMeshParticipants.push({ ...p, isUntrusted: false })
      } else if (isExplicitlyTrustedRef.current(p.pubkey)) {
        trustedMeshParticipants.push({ ...p, isUntrusted: false })
      }
    }

    if (recorderRef.current?.isRecording()) {
      recorderRef.current.syncParticipants(trustedMeshParticipants)
    }

    // Merge untrusted remote peers from the room's live presence roster as shielded tiles
    // (zero RTCPeerConnection, zero MediaStream, zero audio/video) so the user can Trust them inline.
    const participants: CallParticipant[] = [...trustedMeshParticipants]
    const seenPks = new Set(participants.map((p) => p.pubkey.toLowerCase()))
    const now = Date.now()

    if (current.mode === 'server' && current.serverId) {
      const srv = serversRef.current.find((s) => s.id === current.serverId)
      const bannedSet = new Set((srv?.bannedPubkeys ?? []).map((b) => b.toLowerCase()))
      const roomId = current.roomId ?? DEFAULT_SERVER_VOICE_ROOM_ID
      const roster = rostersRef.current[current.serverId] ?? []
      for (const peer of roster) {
        if (peer.roomId !== roomId) continue
        if (now - peer.lastSeenAt >= ROOM_PEER_TTL_MS) continue
        const pk = peer.pubkey.toLowerCase()
        if (seenPks.has(pk) || blockedSetRef.current.has(pk) || bannedSet.has(pk)) continue
        if (isExplicitlyTrustedRef.current(pk)) continue
        seenPks.add(pk)
        participants.push({
          pubkey: pk,
          nickname: peer.nickname,
          displayHandle: peer.displayHandle,
          isSelf: false,
          isUntrusted: true,
          stream: null,
          audioMuted: true,
          videoEnabled: false,
          screenSharing: false,
          isRecording: Boolean(peer.isRecording),
          isSpeaking: false,
          audioLevel: 0,
          iceState: 'new',
          rttMs: null,
          joinedAt: peer.lastSeenAt,
        })
      }
    } else if (current.mode === 'geo' && current.geohash) {
      const gh = normalizeRadioChannelKey(current.geohash) ?? normalizeGeohash(current.geohash)
      const roster = geoRostersRef.current[gh] ?? []
      for (const peer of roster) {
        if (now - peer.lastSeenAt >= ROOM_PEER_TTL_MS) continue
        const pk = peer.pubkey.toLowerCase()
        if (seenPks.has(pk) || blockedSetRef.current.has(pk)) continue
        if (isExplicitlyTrustedRef.current(pk)) continue
        seenPks.add(pk)
        participants.push({
          pubkey: pk,
          nickname: peer.nickname,
          displayHandle: peer.displayHandle,
          isSelf: false,
          isUntrusted: true,
          stream: null,
          audioMuted: true,
          videoEnabled: false,
          screenSharing: false,
          isRecording: Boolean(peer.isRecording),
          isSpeaking: false,
          audioLevel: 0,
          iceState: 'new',
          rttMs: null,
          joinedAt: peer.lastSeenAt,
        })
      }
    }

    const isDmConnected = current.mode === 'dm' && mesh.hasAnyConnectedPeer()
    const nextStatus =
      isDmConnected && (current.status === 'connecting' || current.status === 'ringing-out')
        ? 'active'
        : current.status
    if (nextStatus === 'active' && current.mode === 'dm') {
      if (outgoingRingTimerRef.current !== null) {
        window.clearTimeout(outgoingRingTimerRef.current)
        outgoingRingTimerRef.current = null
      }
      if (outgoingRingInviteTimerRef.current !== null) {
        window.clearInterval(outgoingRingInviteTimerRef.current)
        outgoingRingInviteTimerRef.current = null
      }
    }
    const nextConnectedAt =
      nextStatus === 'active' && current.connectedAt === null ? Date.now() : current.connectedAt

    const updated: ActiveCallSession = {
      ...current,
      status: nextStatus,
      connectedAt: nextConnectedAt,
      localMuted: mesh.getLocalMuted(),
      localDeafened: mesh.getLocalDeafened(),
      localCameraOn: mesh.getLocalCameraOn(),
      localScreenSharing: mesh.getLocalScreenSharing(),
      localRecording: mesh.getLocalRecording(),
      localRecordingStartedAt: recordingStartedAtRef.current,
      localRecordingMode: recordingModeRef.current,
      localRecordingQuality: recordingQualityActiveRef.current,
      localRecordingBytes: recordingBytesRef.current,
      recordingSupported: isCallRecordingSupported(),
      participants,
    }
    activeCallRef.current = updated
    setActiveCall(updated)
  }, [])

  const notifyRemoteRecordingChange = useCallback(
    (pubkey: string, nickname: string | undefined, nextRecording: boolean | undefined) => {
      if (typeof nextRecording !== 'boolean') return
      const pk = pubkey.toLowerCase()
      const prev = remoteRecordingRef.current.get(pk) ?? false
      if (prev === nextRecording) return
      remoteRecordingRef.current.set(pk, nextRecording)
      const handle = formatDisplayHandle(nickname || getPeerNicknameRef.current(pk), pk)
      if (nextRecording) {
        pushToastRef.current('warning', `${handle} started recording this call`)
      } else {
        pushToastRef.current('info', `${handle} stopped recording`)
      }
    },
    []
  )

  const clearRingTimers = useCallback(() => {
    if (outgoingRingTimerRef.current !== null) {
      window.clearTimeout(outgoingRingTimerRef.current)
      outgoingRingTimerRef.current = null
    }
    if (outgoingRingInviteTimerRef.current !== null) {
      window.clearInterval(outgoingRingInviteTimerRef.current)
      outgoingRingInviteTimerRef.current = null
    }
    if (incomingRingTimerRef.current !== null) {
      window.clearTimeout(incomingRingTimerRef.current)
      incomingRingTimerRef.current = null
    }
  }, [])

  const stopRoomHeartbeat = useCallback(() => {
    if (roomHeartbeatTimerRef.current !== null) {
      window.clearInterval(roomHeartbeatTimerRef.current)
      roomHeartbeatTimerRef.current = null
    }
  }, [])

  const publishDirectSignalWithMaterial = useCallback(
    async (
      material: SigningKeyMaterial,
      recipientPubkey: string,
      payload: DirectCallSignalPayload
    ): Promise<void> => {
      const currentPool = poolRef.current
      if (!currentPool) return
      try {
        const template = await buildDirectCallSignalTemplate({
          material,
          recipientPubkey,
          payload,
        })
        const signed = await identityManager.signEventWithMaterial(template, material)
        await currentPool.publish(CALL_SIGNALING_RELAYS, signed, 2_000)
      } catch (err) {
        if (payload.action === 'call-invite' || payload.action === 'call-accept') {
          pushToastRef.current(
            'error',
            'Call signaling failed',
            err instanceof Error ? err.message : 'Unable to encrypt/publish call signal.'
          )
        }
      }
    },
    [identityManager]
  )

  const publishDirectSignal = useCallback(
    async (recipientPubkey: string, payload: DirectCallSignalPayload): Promise<void> => {
      const material = identityManager.getMasterKeyMaterial()
      await publishDirectSignalWithMaterial(material, recipientPubkey, payload)
    },
    [identityManager, publishDirectSignalWithMaterial]
  )

  const publishRoomSignal = useCallback(
    async (
      server: ServerSummary,
      roomId: string,
      payload: RoomCallSignalPayload
    ): Promise<void> => {
      const currentPool = poolRef.current
      if (!currentPool) return
      try {
        const template = await buildRoomCallSignalTemplate({ server, roomId, payload })
        const signed = await identityManager.signEvent(template)
        await currentPool.publish(getRelaysForServerCall(server), signed, 2_000)
      } catch {
        // Ignore transient publish failure
      }
    },
    [identityManager]
  )

  const publishGeoRoomSignal = useCallback(
    async (
      geohash: string,
      payload: GeoCallSignalPayload,
      materialOverride?: SigningKeyMaterial
    ): Promise<void> => {
      const currentPool = poolRef.current
      if (!currentPool) return
      try {
        const material =
          materialOverride ?? identityManager.getDerivedGeohashKeyMaterial(geohash)
        const template = buildGeoCallSignalTemplate({ geohash, payload })
        const signed = await identityManager.signEventWithMaterial(template, material)
        await currentPool.publish(CALL_SIGNALING_RELAYS, signed, 2_000)
      } catch {
        // Ignore transient publish failure
      }
    },
    [identityManager]
  )

  const upsertRosterMember = useCallback((entry: RoomCallPresence) => {
    setServerCallRosters((prev) => {
      const list = prev[entry.serverId] ?? []
      const idx = list.findIndex((p) => p.pubkey === entry.pubkey && p.roomId === entry.roomId)
      let nextList: RoomCallPresence[]
      if (idx >= 0) {
        nextList = [...list]
        nextList[idx] = entry
      } else {
        nextList = [...list, entry].slice(0, MAX_CALL_PARTICIPANTS + 2)
      }
      const next = { ...prev, [entry.serverId]: nextList }
      rostersRef.current = next
      return next
    })
  }, [])

  const removeRosterMember = useCallback((serverId: string, pubkey: string) => {
    const pk = pubkey.toLowerCase()
    setServerCallRosters((prev) => {
      const list = prev[serverId]
      if (!list || !list.some((p) => p.pubkey === pk)) return prev
      const filtered = list.filter((p) => p.pubkey !== pk)
      const next = { ...prev }
      if (filtered.length > 0) {
        next[serverId] = filtered
      } else {
        delete next[serverId]
      }
      rostersRef.current = next
      return next
    })
  }, [])

  const upsertGeoRosterMember = useCallback((entry: GeoCallPresence) => {
    const gh = normalizeRadioChannelKey(entry.geohash) ?? normalizeGeohash(entry.geohash)
    if (!gh) return
    const normalized: GeoCallPresence = { ...entry, geohash: gh }
    setGeoCallRosters((prev) => {
      const list = prev[gh] ?? []
      const idx = list.findIndex((p) => p.pubkey === normalized.pubkey)
      let nextList: GeoCallPresence[]
      if (idx >= 0) {
        nextList = [...list]
        nextList[idx] = normalized
      } else {
        nextList = [...list, normalized].slice(0, MAX_CALL_PARTICIPANTS + 2)
      }
      const next = { ...prev, [gh]: nextList }
      geoRostersRef.current = next
      return next
    })
  }, [])

  const removeGeoRosterMember = useCallback((geohash: string, pubkey: string) => {
    const gh = normalizeRadioChannelKey(geohash) ?? normalizeGeohash(geohash)
    const pk = pubkey.toLowerCase()
    if (!gh) return
    setGeoCallRosters((prev) => {
      const list = prev[gh]
      if (!list || !list.some((p) => p.pubkey === pk)) return prev
      const filtered = list.filter((p) => p.pubkey !== pk)
      const next = { ...prev }
      if (filtered.length > 0) {
        next[gh] = filtered
      } else {
        delete next[gh]
      }
      geoRostersRef.current = next
      return next
    })
  }, [])

  const teardownActiveCall = useCallback(
    (notifyNetwork: boolean, opts?: { abortRecording?: boolean }) => {
      const current = activeCallRef.current
      const meshToDispose = meshRef.current
      const geoMaterialToUse = activeGeoMaterialRef.current
      meshRef.current = null
      activeGeoMaterialRef.current = null
      if (geoDirectUnsubRef.current) {
        geoDirectUnsubRef.current()
        geoDirectUnsubRef.current = null
      }
      clearRingTimers()
      stopRoomHeartbeat()
      remoteRecordingRef.current.clear()

      const wasRecording = Boolean(recorderRef.current?.isRecording())
      recordingStartedAtRef.current = null
      recordingModeRef.current = null
      recordingQualityActiveRef.current = null
      recordingBytesRef.current = 0

      if (wasRecording && !opts?.abortRecording && meshToDispose) {
        // Broadcast recording: false before hanging up
        meshToDispose.setLocalRecording(false)
      }

      if (notifyNetwork && current) {
        const selfPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
        if (current.mode === 'dm' && current.peerPubkey) {
          const action = current.status === 'ringing-out' ? 'call-cancel' : 'call-hangup'
          void publishDirectSignal(current.peerPubkey, {
            v: 1,
            action,
            callId: current.callId,
            ts: Date.now(),
          })
        } else if (current.mode === 'server' && current.serverId) {
          const roomId = current.roomId ?? DEFAULT_SERVER_VOICE_ROOM_ID
          const server = serversRef.current.find((s) => s.id === current.serverId)
          removeRosterMember(current.serverId, selfPk)
          if (server) {
            void publishRoomSignal(server, roomId, {
              v: 1,
              action: 'room-leave',
              serverId: server.id,
              roomId,
              ts: Date.now(),
            })
          }
        } else if (current.mode === 'geo' && current.geohash) {
          const gh = normalizeRadioChannelKey(current.geohash) ?? normalizeGeohash(current.geohash)
          const geoMaterial =
            geoMaterialToUse ?? identityManager.getDerivedGeohashKeyMaterial(gh)
          const selfGeoPk = geoMaterial.pubkey.toLowerCase()
          const roomId = current.roomId ?? getGeoCallRoomId(gh)
          removeGeoRosterMember(gh, selfGeoPk)
          void publishGeoRoomSignal(
            gh,
            {
              v: 1,
              action: 'room-leave',
              geohash: gh,
              roomId,
              ts: Date.now(),
            },
            geoMaterial
          )
        }
      } else if (current?.mode === 'geo' && current.geohash) {
        const gh = normalizeRadioChannelKey(current.geohash) ?? normalizeGeohash(current.geohash)
        const selfGeoPk = (
          geoMaterialToUse ?? identityManager.getDerivedGeohashKeyMaterial(gh)
        ).pubkey.toLowerCase()
        removeGeoRosterMember(gh, selfGeoPk)
      }

      activeCallRef.current = null
      setActiveCall(null)

      if (wasRecording && recorderRef.current) {
        if (opts?.abortRecording) {
          recorderRef.current.abort()
          meshToDispose?.dispose()
        } else {
          const title = current?.title || 'call'
          const activeRecorder = recorderRef.current
          void activeRecorder
            .stopAndDownload(title)
            .then((res) => {
              if (res) {
                pushToastRef.current('success', 'Recording saved', `${res.filename} (${res.durationSec}s)`)
              }
            })
            .catch(() => {
              // Ignore finalize error during teardown
            })
            .finally(() => {
              meshToDispose?.dispose()
            })
        }
      } else {
        meshToDispose?.dispose()
      }
    },
    [
      clearRingTimers,
      stopRoomHeartbeat,
      identityManager,
      publishDirectSignal,
      publishGeoRoomSignal,
      publishRoomSignal,
      removeGeoRosterMember,
      removeRosterMember,
    ]
  )

  const leaveCall = useCallback(() => {
    teardownActiveCall(true)
  }, [teardownActiveCall])

  const createMeshForCall = useCallback(
    (sessionMeta: {
      callId: string
      mode: 'dm' | 'server' | 'geo'
      peerPubkey?: string
      server?: ServerSummary
      geohash?: string
      geoMaterial?: SigningKeyMaterial
      roomId?: string
    }): WebRtcMesh => {
      const selfPk =
        sessionMeta.mode === 'geo' && sessionMeta.geoMaterial
          ? sessionMeta.geoMaterial.pubkey.toLowerCase()
          : identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const selfNick = identityManager.getNickname()

      const mesh = new WebRtcMesh({
        selfPubkey: selfPk,
        selfNickname: selfNick,
        turnConfig: turnConfigRef.current,
        callbacks: {
          onSendOffer: (targetPk, sdp) => {
            const nick = identityManager.getNickname()
            if (sessionMeta.mode === 'dm') {
              void publishDirectSignal(targetPk, {
                v: 1,
                action: 'offer',
                callId: sessionMeta.callId,
                nickname: nick,
                sdp,
                ts: Date.now(),
              })
            } else if (sessionMeta.mode === 'geo' && sessionMeta.geohash && sessionMeta.geoMaterial) {
              const gh = sessionMeta.geohash
              const roomId = sessionMeta.roomId ?? getGeoCallRoomId(gh)
              void publishDirectSignalWithMaterial(sessionMeta.geoMaterial, targetPk, {
                v: 1,
                action: 'offer',
                callId: sessionMeta.callId,
                geohash: gh,
                roomId,
                nickname: nick,
                sdp,
                ts: Date.now(),
              })
            } else if (sessionMeta.server) {
              const roomId = sessionMeta.roomId ?? DEFAULT_SERVER_VOICE_ROOM_ID
              if (sessionMeta.server.encrypted) {
                void publishRoomSignal(sessionMeta.server, roomId, {
                  v: 1,
                  action: 'offer',
                  serverId: sessionMeta.server.id,
                  roomId,
                  targetPubkey: targetPk,
                  nickname: nick,
                  sdp,
                  ts: Date.now(),
                })
              } else {
                void publishDirectSignal(targetPk, {
                  v: 1,
                  action: 'offer',
                  callId: sessionMeta.callId,
                  serverId: sessionMeta.server.id,
                  roomId,
                  nickname: nick,
                  sdp,
                  ts: Date.now(),
                })
              }
            }
          },
          onSendAnswer: (targetPk, sdp) => {
            const nick = identityManager.getNickname()
            if (sessionMeta.mode === 'dm') {
              void publishDirectSignal(targetPk, {
                v: 1,
                action: 'answer',
                callId: sessionMeta.callId,
                nickname: nick,
                sdp,
                ts: Date.now(),
              })
            } else if (sessionMeta.mode === 'geo' && sessionMeta.geohash && sessionMeta.geoMaterial) {
              const gh = sessionMeta.geohash
              const roomId = sessionMeta.roomId ?? getGeoCallRoomId(gh)
              void publishDirectSignalWithMaterial(sessionMeta.geoMaterial, targetPk, {
                v: 1,
                action: 'answer',
                callId: sessionMeta.callId,
                geohash: gh,
                roomId,
                nickname: nick,
                sdp,
                ts: Date.now(),
              })
            } else if (sessionMeta.server) {
              const roomId = sessionMeta.roomId ?? DEFAULT_SERVER_VOICE_ROOM_ID
              if (sessionMeta.server.encrypted) {
                void publishRoomSignal(sessionMeta.server, roomId, {
                  v: 1,
                  action: 'answer',
                  serverId: sessionMeta.server.id,
                  roomId,
                  targetPubkey: targetPk,
                  nickname: nick,
                  sdp,
                  ts: Date.now(),
                })
              } else {
                void publishDirectSignal(targetPk, {
                  v: 1,
                  action: 'answer',
                  callId: sessionMeta.callId,
                  serverId: sessionMeta.server.id,
                  roomId,
                  nickname: nick,
                  sdp,
                  ts: Date.now(),
                })
              }
            }
          },
          onSendIce: (targetPk, candidate) => {
            if (sessionMeta.mode === 'dm') {
              void publishDirectSignal(targetPk, {
                v: 1,
                action: 'ice',
                callId: sessionMeta.callId,
                candidate,
                ts: Date.now(),
              })
            } else if (sessionMeta.mode === 'geo' && sessionMeta.geohash && sessionMeta.geoMaterial) {
              const gh = sessionMeta.geohash
              const roomId = sessionMeta.roomId ?? getGeoCallRoomId(gh)
              void publishDirectSignalWithMaterial(sessionMeta.geoMaterial, targetPk, {
                v: 1,
                action: 'ice',
                callId: sessionMeta.callId,
                geohash: gh,
                roomId,
                candidate,
                ts: Date.now(),
              })
            } else if (sessionMeta.server) {
              const roomId = sessionMeta.roomId ?? DEFAULT_SERVER_VOICE_ROOM_ID
              if (sessionMeta.server.encrypted) {
                void publishRoomSignal(sessionMeta.server, roomId, {
                  v: 1,
                  action: 'ice',
                  serverId: sessionMeta.server.id,
                  roomId,
                  targetPubkey: targetPk,
                  candidate,
                  ts: Date.now(),
                })
              } else {
                void publishDirectSignal(targetPk, {
                  v: 1,
                  action: 'ice',
                  callId: sessionMeta.callId,
                  serverId: sessionMeta.server.id,
                  roomId,
                  candidate,
                  ts: Date.now(),
                })
              }
            }
          },
          onSendIceBatch: (targetPk, candidates) => {
            if (candidates.length === 0) return
            const first = candidates[0]
            if (sessionMeta.mode === 'dm') {
              void publishDirectSignal(targetPk, {
                v: 1,
                action: 'ice',
                callId: sessionMeta.callId,
                candidate: first,
                candidates,
                ts: Date.now(),
              })
            } else if (sessionMeta.mode === 'geo' && sessionMeta.geohash && sessionMeta.geoMaterial) {
              const gh = sessionMeta.geohash
              const roomId = sessionMeta.roomId ?? getGeoCallRoomId(gh)
              void publishDirectSignalWithMaterial(sessionMeta.geoMaterial, targetPk, {
                v: 1,
                action: 'ice',
                callId: sessionMeta.callId,
                geohash: gh,
                roomId,
                candidate: first,
                candidates,
                ts: Date.now(),
              })
            } else if (sessionMeta.server) {
              const roomId = sessionMeta.roomId ?? DEFAULT_SERVER_VOICE_ROOM_ID
              if (sessionMeta.server.encrypted) {
                void publishRoomSignal(sessionMeta.server, roomId, {
                  v: 1,
                  action: 'ice',
                  serverId: sessionMeta.server.id,
                  roomId,
                  targetPubkey: targetPk,
                  candidate: first,
                  candidates,
                  ts: Date.now(),
                })
              } else {
                void publishDirectSignal(targetPk, {
                  v: 1,
                  action: 'ice',
                  callId: sessionMeta.callId,
                  serverId: sessionMeta.server.id,
                  roomId,
                  candidate: first,
                  candidates,
                  ts: Date.now(),
                })
              }
            }
          },
          onRequestPeerSync: (targetPk) => {
            const active = activeCallRef.current
            if (sessionMeta.mode === 'dm' && active && active.mode === 'dm' && active.callId === sessionMeta.callId) {
              poolRef.current?.ensureRelaysAlive(CALL_SIGNALING_RELAYS)
              void publishDirectSignal(targetPk, {
                v: 1,
                action: 'call-accept',
                callId: sessionMeta.callId,
                media: active.mediaType,
                nickname: identityManager.getNickname(),
                ts: Date.now(),
              })
            }
          },
          onBroadcastMediaState: (mediaState) => {
            const nick = identityManager.getNickname()
            if (sessionMeta.mode === 'dm' && sessionMeta.peerPubkey) {
              void publishDirectSignal(sessionMeta.peerPubkey, {
                v: 1,
                action: 'media-state',
                callId: sessionMeta.callId,
                nickname: nick,
                audioMuted: mediaState.audioMuted,
                videoEnabled: mediaState.videoEnabled,
                screenSharing: mediaState.screenSharing,
                recording: mediaState.recording,
                ts: Date.now(),
              })
            } else if (sessionMeta.mode === 'geo' && sessionMeta.geohash && sessionMeta.geoMaterial) {
              const gh = sessionMeta.geohash
              const roomId = sessionMeta.roomId ?? getGeoCallRoomId(gh)
              upsertGeoRosterMember({
                geohash: gh,
                roomId,
                pubkey: selfPk,
                nickname: nick,
                displayHandle: formatDisplayHandle(nick, selfPk),
                hasVideo: mediaState.videoEnabled || mediaState.screenSharing,
                audioMuted: mediaState.audioMuted,
                isRecording: mediaState.recording,
                lastSeenAt: Date.now(),
              })
              void publishGeoRoomSignal(
                gh,
                {
                  v: 1,
                  action: 'media-state',
                  geohash: gh,
                  roomId,
                  nickname: nick,
                  audioMuted: mediaState.audioMuted,
                  videoEnabled: mediaState.videoEnabled,
                  screenSharing: mediaState.screenSharing,
                  recording: mediaState.recording,
                  ts: Date.now(),
                },
                sessionMeta.geoMaterial
              )
            } else if (sessionMeta.server) {
              const roomId = sessionMeta.roomId ?? DEFAULT_SERVER_VOICE_ROOM_ID
              upsertRosterMember({
                serverId: sessionMeta.server.id,
                roomId,
                pubkey: selfPk,
                nickname: nick,
                displayHandle: formatDisplayHandle(nick, selfPk),
                hasVideo: mediaState.videoEnabled || mediaState.screenSharing,
                audioMuted: mediaState.audioMuted,
                isRecording: mediaState.recording,
                lastSeenAt: Date.now(),
              })
              void publishRoomSignal(sessionMeta.server, roomId, {
                v: 1,
                action: 'media-state',
                serverId: sessionMeta.server.id,
                roomId,
                nickname: nick,
                audioMuted: mediaState.audioMuted,
                videoEnabled: mediaState.videoEnabled,
                screenSharing: mediaState.screenSharing,
                recording: mediaState.recording,
                ts: Date.now(),
              })
            }
          },
          onStateChange: () => {
            syncActiveCallFromMesh()
          },
          onPeerConnected: (connectedPeerPk) => {
            syncActiveCallFromMesh()
            // Sync current media & recording state to newly connected peer (late-joiner guarantee)
            const activeMesh = meshRef.current
            if (!activeMesh) return
            const state = activeMesh.getLocalMediaState()
            const nick = identityManager.getNickname()
            if (sessionMeta.mode === 'dm') {
              void publishDirectSignal(connectedPeerPk, {
                v: 1,
                action: 'media-state',
                callId: sessionMeta.callId,
                nickname: nick,
                audioMuted: state.audioMuted,
                videoEnabled: state.videoEnabled,
                screenSharing: state.screenSharing,
                recording: state.recording,
                ts: Date.now(),
              })
            } else if (sessionMeta.mode === 'geo' && sessionMeta.geohash && sessionMeta.geoMaterial) {
              const gh = sessionMeta.geohash
              const roomId = sessionMeta.roomId ?? getGeoCallRoomId(gh)
              void publishGeoRoomSignal(
                gh,
                {
                  v: 1,
                  action: 'media-state',
                  geohash: gh,
                  roomId,
                  nickname: nick,
                  audioMuted: state.audioMuted,
                  videoEnabled: state.videoEnabled,
                  screenSharing: state.screenSharing,
                  recording: state.recording,
                  ts: Date.now(),
                },
                sessionMeta.geoMaterial
              )
            } else if (sessionMeta.server) {
              const roomId = sessionMeta.roomId ?? DEFAULT_SERVER_VOICE_ROOM_ID
              void publishRoomSignal(sessionMeta.server, roomId, {
                v: 1,
                action: 'media-state',
                serverId: sessionMeta.server.id,
                roomId,
                nickname: nick,
                audioMuted: state.audioMuted,
                videoEnabled: state.videoEnabled,
                screenSharing: state.screenSharing,
                recording: state.recording,
                ts: Date.now(),
              })
            }
          },
          onPeerFailed: () => {
            pushToastRef.current(
              'warning',
              'P2P ICE connection failed',
              'Strict NAT/firewall may block direct UDP. Configure a custom TURN server in Settings.'
            )
          },
          onNotice: (level, title, detail) => {
            pushToastRef.current(level, title, detail)
          },
        },
      })

      return mesh
    },
    [
      identityManager,
      publishDirectSignal,
      publishDirectSignalWithMaterial,
      publishGeoRoomSignal,
      publishRoomSignal,
      syncActiveCallFromMesh,
      upsertGeoRosterMember,
      upsertRosterMember,
    ]
  )

  // Start 1-on-1 encrypted DM Voice/Video Call
  const startDmCall = useCallback(
    async (peerPubkey: string, media: CallMediaType, nicknameHint?: string): Promise<boolean> => {
      const pk = peerPubkey.toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pk)) return false

      // Strict Trust Gate: P2P WebRTC exposes IP addresses — require explicit Trust first
      if (!isExplicitlyTrustedRef.current(pk)) {
        pushToastRef.current(
          'warning',
          'Trust peer before calling',
          'P2P WebRTC shares IP addresses directly. Trust this peer first to enable voice & video calls.'
        )
        return false
      }

      if (
        activeCallRef.current?.mode === 'dm' &&
        activeCallRef.current.peerPubkey === pk
      ) {
        return true
      }

      if (activeCallRef.current) {
        teardownActiveCall(true)
      }

      const callId = generateCallId()
      const mesh = createMeshForCall({ callId, mode: 'dm', peerPubkey: pk })
      try {
        await mesh.initLocalMedia(media)
      } catch (err) {
        mesh.dispose()
        pushToastRef.current(
          'error',
          'Unable to start call',
          err instanceof Error ? err.message : 'Microphone access is required.'
        )
        return false
      }

      meshRef.current = mesh
      const resolvedNick = nicknameHint?.trim() || getPeerNicknameRef.current(pk) || `anon${pk.slice(-4)}`
      const displayHandle = formatDisplayHandle(resolvedNick, pk)

      const session: ActiveCallSession = {
        callId,
        mode: 'dm',
        status: 'ringing-out',
        mediaType: mesh.getLocalCameraOn() ? 'video' : 'audio',
        encrypted: true,
        title: displayHandle,
        peerPubkey: pk,
        startedAt: Date.now(),
        connectedAt: null,
        localMuted: mesh.getLocalMuted(),
        localDeafened: mesh.getLocalDeafened(),
        localCameraOn: mesh.getLocalCameraOn(),
        localScreenSharing: mesh.getLocalScreenSharing(),
        localRecording: false,
        localRecordingStartedAt: null,
        localRecordingMode: null,
        localRecordingQuality: null,
        localRecordingBytes: 0,
        recordingSupported: isCallRecordingSupported(),
        screenShareSupported: isScreenShareSupported(),
        participants: mesh.getParticipantsSnapshot(),
        maxParticipants: MAX_CALL_PARTICIPANTS,
      }
      activeCallRef.current = session
      setActiveCall(session)

      // Wake any sleeping/backed-off signaling relays before sending call-invite (critical on mobile PWA)
      poolRef.current?.ensureRelaysAlive(CALL_SIGNALING_RELAYS)

      void publishDirectSignal(pk, {
        v: 1,
        action: 'call-invite',
        callId,
        media: session.mediaType,
        nickname: identityManager.getNickname(),
        ts: Date.now(),
      })

      // Periodically re-broadcast call-invite every 3.5s while awaiting pickup so waking/reconnecting PWAs ring reliably
      outgoingRingInviteTimerRef.current = window.setInterval(() => {
        const cur = activeCallRef.current
        if (!cur || cur.callId !== callId || cur.status !== 'ringing-out') {
          if (outgoingRingInviteTimerRef.current !== null) {
            window.clearInterval(outgoingRingInviteTimerRef.current)
            outgoingRingInviteTimerRef.current = null
          }
          return
        }
        void publishDirectSignal(pk, {
          v: 1,
          action: 'call-invite',
          callId,
          media: cur.mediaType,
          nickname: identityManager.getNickname(),
          ts: Date.now(),
        })
      }, OUTGOING_INVITE_REBROADCAST_MS)

      outgoingRingTimerRef.current = window.setTimeout(() => {
        if (activeCallRef.current?.callId === callId && activeCallRef.current.status === 'ringing-out') {
          teardownActiveCall(true)
          pushToastRef.current('info', 'No answer', `${displayHandle} did not pick up.`)
        }
      }, RING_TIMEOUT_MS)

      return true
    },
    [createMeshForCall, identityManager, publishDirectSignal, teardownActiveCall]
  )

  // Accept incoming 1-on-1 DM call
  const acceptIncomingCall = useCallback(
    async (mediaOverride?: CallMediaType): Promise<boolean> => {
      const offer = incomingCallRef.current
      if (!offer) return false

      if (incomingRingTimerRef.current !== null) {
        window.clearTimeout(incomingRingTimerRef.current)
        incomingRingTimerRef.current = null
      }
      incomingCallRef.current = null
      setIncomingCall(null)

      // Re-enforce strict Trust Gate before touching ICE/media
      if (!isExplicitlyTrustedRef.current(offer.callerPubkey)) {
        return false
      }

      if (activeCallRef.current) {
        teardownActiveCall(true)
      }

      const desiredMedia: CallMediaType = mediaOverride ?? offer.mediaType
      const mesh = createMeshForCall({
        callId: offer.callId,
        mode: 'dm',
        peerPubkey: offer.callerPubkey,
      })

      try {
        await mesh.initLocalMedia(desiredMedia)
      } catch (err) {
        mesh.dispose()
        pushToastRef.current(
          'error',
          'Unable to accept call',
          err instanceof Error ? err.message : 'Microphone access is required.'
        )
        void publishDirectSignal(offer.callerPubkey, {
          v: 1,
          action: 'call-decline',
          callId: offer.callId,
          reason: 'media-error',
          ts: Date.now(),
        })
        return false
      }

      meshRef.current = mesh
      const session: ActiveCallSession = {
        callId: offer.callId,
        mode: 'dm',
        status: 'connecting',
        mediaType: mesh.getLocalCameraOn() ? 'video' : 'audio',
        encrypted: true,
        title: offer.callerDisplayHandle,
        peerPubkey: offer.callerPubkey,
        startedAt: Date.now(),
        connectedAt: null,
        localMuted: mesh.getLocalMuted(),
        localDeafened: mesh.getLocalDeafened(),
        localCameraOn: mesh.getLocalCameraOn(),
        localScreenSharing: mesh.getLocalScreenSharing(),
        localRecording: false,
        localRecordingStartedAt: null,
        localRecordingMode: null,
        localRecordingQuality: null,
        localRecordingBytes: 0,
        recordingSupported: isCallRecordingSupported(),
        screenShareSupported: isScreenShareSupported(),
        participants: mesh.getParticipantsSnapshot(),
        maxParticipants: MAX_CALL_PARTICIPANTS,
      }
      activeCallRef.current = session
      setActiveCall(session)

      // Wake any sleeping/backed-off signaling relays before publishing call-accept (mobile PWA wakeup)
      poolRef.current?.ensureRelaysAlive(CALL_SIGNALING_RELAYS)

      const selfPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const callerPk = offer.callerPubkey.toLowerCase()
      const weInitiateOffer = selfPk < callerPk

      // When caller is the offerer (selfPk > callerPk), create the peer entry SYNCHRONOUSLY
      // BEFORE sending call-accept so incoming offer & early ICE candidates can never race
      // ahead of connectToPeer or get dropped while publishDirectSignal awaits slow relays.
      if (!weInitiateOffer) {
        mesh.connectToPeer(callerPk, offer.callerNickname, false)
      }

      // Fire call-accept without blocking connectToPeer on slow relay OK timeouts
      void publishDirectSignal(callerPk, {
        v: 1,
        action: 'call-accept',
        callId: offer.callId,
        media: session.mediaType,
        nickname: identityManager.getNickname(),
        ts: Date.now(),
      })

      if (weInitiateOffer) {
        mesh.connectToPeer(callerPk, offer.callerNickname, true)
      }

      syncActiveCallFromMesh()
      return true
    },
    [createMeshForCall, identityManager, publishDirectSignal, syncActiveCallFromMesh, teardownActiveCall]
  )

  const declineIncomingCall = useCallback(() => {
    const offer = incomingCallRef.current
    if (!offer) return
    if (incomingRingTimerRef.current !== null) {
      window.clearTimeout(incomingRingTimerRef.current)
      incomingRingTimerRef.current = null
    }
    incomingCallRef.current = null
    setIncomingCall(null)
    void publishDirectSignal(offer.callerPubkey, {
      v: 1,
      action: 'call-decline',
      callId: offer.callId,
      reason: 'declined',
      ts: Date.now(),
    })
  }, [publishDirectSignal])

  // Join a Server Group Voice/Video Lounge (hard cap: 6 participants)
  const joinServerCall = useCallback(
    async (
      serverId: string,
      media: CallMediaType,
      roomId = DEFAULT_SERVER_VOICE_ROOM_ID
    ): Promise<boolean> => {
      const server = serversRef.current.find((s) => s.id === serverId)
      if (!server) {
        pushToastRef.current('warning', 'Server not found', 'Join the server before entering its voice lounge.')
        return false
      }

      if (
        activeCallRef.current?.mode === 'server' &&
        activeCallRef.current.serverId === serverId &&
        activeCallRef.current.roomId === roomId
      ) {
        return true
      }

      const selfPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const currentRoster = (rostersRef.current[serverId] ?? []).filter(
        (p) => p.roomId === roomId && p.pubkey !== selfPk && Date.now() - p.lastSeenAt < ROOM_PEER_TTL_MS
      )

      if (currentRoster.length >= MAX_CALL_PARTICIPANTS) {
        pushToastRef.current(
          'warning',
          `Voice Lounge is full (${MAX_CALL_PARTICIPANTS}/${MAX_CALL_PARTICIPANTS})`,
          'P2P group calls are capped at 6 participants for low-latency stability.'
        )
        return false
      }

      if (activeCallRef.current) {
        teardownActiveCall(true)
      }

      const callId = `srv:${server.id}:${roomId}`
      const mesh = createMeshForCall({
        callId,
        mode: 'server',
        server,
        roomId,
      })

      try {
        await mesh.initLocalMedia(media)
      } catch (err) {
        mesh.dispose()
        pushToastRef.current(
          'error',
          'Unable to join voice lounge',
          err instanceof Error ? err.message : 'Microphone access is required.'
        )
        return false
      }

      meshRef.current = mesh
      poolRef.current?.ensureRelaysAlive(getRelaysForServerCall(server))
      const now = Date.now()
      const selfNick = identityManager.getNickname()

      const session: ActiveCallSession = {
        callId,
        mode: 'server',
        status: 'active',
        mediaType: mesh.getLocalCameraOn() ? 'video' : 'audio',
        encrypted: true,
        title: `${server.name} · Voice Lounge`,
        serverId: server.id,
        roomId,
        startedAt: now,
        connectedAt: now,
        localMuted: mesh.getLocalMuted(),
        localDeafened: mesh.getLocalDeafened(),
        localCameraOn: mesh.getLocalCameraOn(),
        localScreenSharing: mesh.getLocalScreenSharing(),
        localRecording: false,
        localRecordingStartedAt: null,
        localRecordingMode: null,
        localRecordingQuality: null,
        localRecordingBytes: 0,
        recordingSupported: isCallRecordingSupported(),
        screenShareSupported: isScreenShareSupported(),
        participants: mesh.getParticipantsSnapshot(),
        maxParticipants: MAX_CALL_PARTICIPANTS,
      }
      activeCallRef.current = session
      setActiveCall(session)

      upsertRosterMember({
        serverId: server.id,
        roomId,
        pubkey: selfPk,
        nickname: selfNick,
        displayHandle: formatDisplayHandle(selfNick, selfPk),
        hasVideo: mesh.getLocalCameraOn(),
        audioMuted: mesh.getLocalMuted(),
        isRecording: false,
        lastSeenAt: now,
      })

      // Connect WebRTC ONLY to explicitly Trusted peers already in this room (untrusted peers
      // appear as shielded tiles with zero RTCPeerConnection / zero media until trusted!)
      const bannedSet = new Set(server.bannedPubkeys.map((p) => p.toLowerCase()))
      for (const peer of currentRoster) {
        const pk = peer.pubkey.toLowerCase()
        if (blockedSetRef.current.has(pk) || bannedSet.has(pk)) continue
        if (!isExplicitlyTrustedRef.current(pk)) continue
        if (!mesh.canAddPeer(pk)) break
        mesh.connectToPeer(pk, peer.nickname)
        mesh.updatePeerMetadata(pk, {
          nickname: peer.nickname,
          audioMuted: peer.audioMuted,
          videoEnabled: peer.hasVideo,
          isRecording: Boolean(peer.isRecording),
        })
        if (peer.isRecording) {
          notifyRemoteRecordingChange(pk, peer.nickname, true)
        }
      }
      syncActiveCallFromMesh()

      // Broadcast initial room-join + start 12s heartbeat
      const sendPresence = (action: 'room-join' | 'room-ping') => {
        const m = meshRef.current
        if (!m || activeCallRef.current?.serverId !== server.id) return
        const nick = identityManager.getNickname()
        const hasVid = m.getLocalCameraOn() || m.getLocalScreenSharing()
        const isRec = m.getLocalRecording()
        upsertRosterMember({
          serverId: server.id,
          roomId,
          pubkey: selfPk,
          nickname: nick,
          displayHandle: formatDisplayHandle(nick, selfPk),
          hasVideo: hasVid,
          audioMuted: m.getLocalMuted(),
          isRecording: isRec,
          lastSeenAt: Date.now(),
        })
        void publishRoomSignal(server, roomId, {
          v: 1,
          action,
          serverId: server.id,
          roomId,
          nickname: nick,
          media: hasVid ? 'video' : 'audio',
          audioMuted: m.getLocalMuted(),
          videoEnabled: m.getLocalCameraOn(),
          screenSharing: m.getLocalScreenSharing(),
          recording: isRec,
          ts: Date.now(),
        })
      }

      sendPresence('room-join')
      roomHeartbeatTimerRef.current = window.setInterval(() => {
        sendPresence('room-ping')
      }, ROOM_HEARTBEAT_INTERVAL_MS)

      return true
    },
    [
      createMeshForCall,
      identityManager,
      notifyRemoteRecordingChange,
      publishRoomSignal,
      syncActiveCallFromMesh,
      teardownActiveCall,
      upsertRosterMember,
    ]
  )

  // Dedicated NIP-44 kind:25050 subscription for the active Geo Radio call's derived geohash pubkey.
  // Opened synchronously inside joinGeoCall BEFORE room-join so TCP FIFO delivers REQ before EVENT
  // and keeps the derived geohash pubkey completely isolated from the masterPubkey DM subscription.
  const openGeoDirectSubscription = useCallback(
    (geohash: string, geoMaterial: SigningKeyMaterial) => {
      if (geoDirectUnsubRef.current) {
        geoDirectUnsubRef.current()
        geoDirectUnsubRef.current = null
      }
      const currentPool = poolRef.current
      if (!currentPool) return

      const gh = normalizeRadioChannelKey(geohash) ?? normalizeGeohash(geohash)
      const selfGeoPk = geoMaterial.pubkey.toLowerCase()
      const subId = `call-geo-direct:${gh}:${selfGeoPk.slice(0, 8)}`
      const since = Math.floor(Date.now() / 1000) - 15

      geoDirectUnsubRef.current = currentPool.subscribe(
        subId,
        CALL_SIGNALING_RELAYS,
        [
          {
            kinds: [KIND_CALL_SIGNAL],
            '#p': [selfGeoPk],
            '#t': [DM_CALL_SIGNAL_TAG],
            since,
          },
        ],
        {
          onEvent: (event) => {
            if (seenEventIdsRef.current.has(event.id)) return
            seenEventIdsRef.current.add(event.id)
            if (seenEventIdsRef.current.size > MAX_SEEN_SIGNALS) {
              const first = seenEventIdsRef.current.values().next().value
              if (first) seenEventIdsRef.current.delete(first)
            }

            const sender = event.pubkey.toLowerCase()
            if (sender === selfGeoPk) return
            if (blockedSetRef.current.has(sender)) return
            if (Math.abs(Math.floor(Date.now() / 1000) - event.created_at) > MAX_SIGNAL_AGE_SEC) return
            if (!verifyEventCached(event)) return

            const currentActive = activeCallRef.current
            if (!currentActive || currentActive.mode !== 'geo' || currentActive.geohash !== gh) {
              return
            }
            // STRICT TRUST GATE: never decrypt or negotiate WebRTC SDP/ICE with untrusted peers!
            if (!isExplicitlyTrustedRef.current(sender)) {
              return
            }

            void (async () => {
              const payload = await parseDirectCallSignalEvent(event, geoMaterial)
              if (!payload || payload.geohash !== gh) return

              const active = activeCallRef.current
              const mesh = meshRef.current
              if (!active || !mesh || active.mode !== 'geo' || active.geohash !== gh) return
              if (!isExplicitlyTrustedRef.current(sender)) return

              const eventTs =
                typeof payload.ts === 'number' && Number.isFinite(payload.ts) && payload.ts > 0
                  ? payload.ts
                  : event.created_at * 1000
              const lastLeaveTs =
                lastLeaveTsByRoomPeerRef.current.get(`geo:${gh}:${sender}`) ?? 0
              if (eventTs <= lastLeaveTs) return

              if (payload.action === 'offer' && payload.sdp) {
                await mesh.handleRemoteOffer(sender, payload.sdp, payload.nickname)
              } else if (payload.action === 'answer' && payload.sdp) {
                await mesh.handleRemoteAnswer(sender, payload.sdp)
              } else if (payload.action === 'ice') {
                const iceList =
                  payload.candidates && payload.candidates.length > 0
                    ? payload.candidates
                    : payload.candidate
                      ? [payload.candidate]
                      : []
                if (iceList.length > 0) {
                  await mesh.handleRemoteIceBatch(sender, iceList)
                }
              } else if (payload.action === 'media-state') {
                mesh.updatePeerMetadata(sender, {
                  nickname: payload.nickname,
                  audioMuted: payload.audioMuted,
                  videoEnabled: payload.videoEnabled,
                  screenSharing: payload.screenSharing,
                  isRecording: payload.recording,
                })
                notifyRemoteRecordingChange(sender, payload.nickname, payload.recording)
              }
            })()
          },
        }
      )
    },
    [notifyRemoteRecordingChange]
  )

  // Join a Radio Group Voice/Video Call (geohash or kind:23333 topic; hard cap: 6 participants; ALWAYS signed with HMAC-derived per-channel identity)
  const joinGeoCall = useCallback(
    async (rawGeohash: string, media: CallMediaType): Promise<boolean> => {
      if (!isValidRadioChannelKey(rawGeohash)) {
        pushToastRef.current('warning', 'Invalid Radio channel', 'Tune to a valid geohash or topic channel first.')
        return false
      }
      const gh = normalizeRadioChannelKey(rawGeohash)
      if (!gh) return false
      const channelLabel = formatRadioChannelLabel(gh)
      const isTopic = isTopicChannel(gh)

      if (
        activeCallRef.current?.mode === 'geo' &&
        activeCallRef.current.geohash === gh
      ) {
        return true
      }

      const geoMaterial = identityManager.getDerivedGeohashKeyMaterial(gh)
      const selfGeoPk = geoMaterial.pubkey.toLowerCase()
      const currentRoster = (geoRostersRef.current[gh] ?? []).filter(
        (p) => p.pubkey !== selfGeoPk && Date.now() - p.lastSeenAt < ROOM_PEER_TTL_MS
      )

      if (currentRoster.length >= MAX_CALL_PARTICIPANTS) {
        pushToastRef.current(
          'warning',
          `${channelLabel} radio call is full (${MAX_CALL_PARTICIPANTS}/${MAX_CALL_PARTICIPANTS})`,
          'P2P group calls are capped at 6 participants for low-latency stability.'
        )
        return false
      }

      if (activeCallRef.current) {
        teardownActiveCall(true)
      }

      const roomId = getGeoCallRoomId(gh)
      const callId = roomId
      const mesh = createMeshForCall({
        callId,
        mode: 'geo',
        geohash: gh,
        roomId,
        geoMaterial,
      })

      try {
        await mesh.initLocalMedia(media)
      } catch (err) {
        mesh.dispose()
        pushToastRef.current(
          'error',
          'Unable to join radio call',
          err instanceof Error ? err.message : 'Microphone access is required.'
        )
        return false
      }

      meshRef.current = mesh
      activeGeoMaterialRef.current = geoMaterial
      poolRef.current?.ensureRelaysAlive(CALL_SIGNALING_RELAYS)
      const now = Date.now()
      const selfNick = identityManager.getNickname()

      const session: ActiveCallSession = {
        callId,
        mode: 'geo',
        status: 'active',
        mediaType: mesh.getLocalCameraOn() ? 'video' : 'audio',
        encrypted: true,
        title: isTopic ? `${channelLabel} · Topic Radio` : `${channelLabel} · Geo Radio`,
        geohash: gh,
        roomId,
        startedAt: now,
        connectedAt: now,
        localMuted: mesh.getLocalMuted(),
        localDeafened: mesh.getLocalDeafened(),
        localCameraOn: mesh.getLocalCameraOn(),
        localScreenSharing: mesh.getLocalScreenSharing(),
        localRecording: false,
        localRecordingStartedAt: null,
        localRecordingMode: null,
        localRecordingQuality: null,
        localRecordingBytes: 0,
        recordingSupported: isCallRecordingSupported(),
        screenShareSupported: isScreenShareSupported(),
        participants: mesh.getParticipantsSnapshot(),
        maxParticipants: MAX_CALL_PARTICIPANTS,
      }
      activeCallRef.current = session
      setActiveCall(session)

      upsertGeoRosterMember({
        geohash: gh,
        roomId,
        pubkey: selfGeoPk,
        nickname: selfNick,
        displayHandle: formatDisplayHandle(selfNick, selfGeoPk),
        hasVideo: mesh.getLocalCameraOn(),
        audioMuted: mesh.getLocalMuted(),
        isRecording: false,
        lastSeenAt: now,
      })

      // Open direct NIP-44 subscription for selfGeoPk BEFORE publishing room-join or offers
      openGeoDirectSubscription(gh, geoMaterial)

      // Synchronously create peer entries ONLY for explicitly Trusted peers already in this room
      // (untrusted peers appear as shielded tiles with zero RTCPeerConnection / zero media!)
      for (const peer of currentRoster) {
        const pk = peer.pubkey.toLowerCase()
        if (blockedSetRef.current.has(pk)) continue
        if (!isExplicitlyTrustedRef.current(pk)) continue
        if (!mesh.canAddPeer(pk)) break
        mesh.connectToPeer(pk, peer.nickname)
        mesh.updatePeerMetadata(pk, {
          nickname: peer.nickname,
          audioMuted: peer.audioMuted,
          videoEnabled: peer.hasVideo,
          isRecording: Boolean(peer.isRecording),
        })
        if (peer.isRecording) {
          notifyRemoteRecordingChange(pk, peer.nickname, true)
        }
      }
      syncActiveCallFromMesh()

      // Broadcast initial room-join + start 12s heartbeat using the derived geohash keypair
      const sendGeoPresence = (action: 'room-join' | 'room-ping') => {
        const m = meshRef.current
        if (!m || activeCallRef.current?.mode !== 'geo' || activeCallRef.current.geohash !== gh) {
          return
        }
        const nick = identityManager.getNickname()
        const hasVid = m.getLocalCameraOn() || m.getLocalScreenSharing()
        const isRec = m.getLocalRecording()
        upsertGeoRosterMember({
          geohash: gh,
          roomId,
          pubkey: selfGeoPk,
          nickname: nick,
          displayHandle: formatDisplayHandle(nick, selfGeoPk),
          hasVideo: hasVid,
          audioMuted: m.getLocalMuted(),
          isRecording: isRec,
          lastSeenAt: Date.now(),
        })
        void publishGeoRoomSignal(
          gh,
          {
            v: 1,
            action,
            geohash: gh,
            roomId,
            nickname: nick,
            media: hasVid ? 'video' : 'audio',
            audioMuted: m.getLocalMuted(),
            videoEnabled: m.getLocalCameraOn(),
            screenSharing: m.getLocalScreenSharing(),
            recording: isRec,
            ts: Date.now(),
          },
          geoMaterial
        )
      }

      sendGeoPresence('room-join')
      roomHeartbeatTimerRef.current = window.setInterval(() => {
        sendGeoPresence('room-ping')
      }, ROOM_HEARTBEAT_INTERVAL_MS)

      return true
    },
    [
      createMeshForCall,
      identityManager,
      notifyRemoteRecordingChange,
      openGeoDirectSubscription,
      publishGeoRoomSignal,
      syncActiveCallFromMesh,
      teardownActiveCall,
      upsertGeoRosterMember,
    ]
  )

  // Direct NIP-44 kind:25050 subscription (1-on-1 DM calls + Public/NIP-29 server P2P SDP/ICE)
  useEffect(() => {
    if (!pool || !masterPubkey) return
    const subId = `call-direct:${masterPubkey.slice(0, 10)}`
    const since = Math.floor(Date.now() / 1000) - 15

    const unsub = pool.subscribe(
      subId,
      CALL_SIGNALING_RELAYS,
      [
        {
          kinds: [KIND_CALL_SIGNAL],
          '#p': [masterPubkey],
          '#t': [DM_CALL_SIGNAL_TAG],
          since,
        },
      ],
      {
        onEvent: (event) => {
          if (seenEventIdsRef.current.has(event.id)) return
          seenEventIdsRef.current.add(event.id)
          if (seenEventIdsRef.current.size > MAX_SEEN_SIGNALS) {
            const first = seenEventIdsRef.current.values().next().value
            if (first) seenEventIdsRef.current.delete(first)
          }

          const sender = event.pubkey.toLowerCase()
          if (sender === masterPubkey) return
          if (blockedSetRef.current.has(sender)) return
          if (Math.abs(Math.floor(Date.now() / 1000) - event.created_at) > MAX_SIGNAL_AGE_SEC) return
          if (!verifyEventCached(event)) return

          // STRICT TRUST GATE BEFORE DECRYPTING OR TOUCHING WEBRTC:
          // Never negotiate WebRTC SDP/ICE or ring for any untrusted remote peer
          // (enforced unconditionally for 1-on-1 DM calls AND Server/Community group calls).
          if (!isExplicitlyTrustedRef.current(sender)) {
            // Silently drop untrusted signals — zero ringing, zero RTCPeerConnection, zero IP leak!
            return
          }

          void (async () => {
            const material = identityManager.getMasterKeyMaterial()
            const payload = await parseDirectCallSignalEvent(event, material)
            if (!payload) return

            // Branch A: Direct NIP-44 SDP/ICE for a Public or NIP-29 Server room
            if (payload.serverId) {
              const active = activeCallRef.current
              const mesh = meshRef.current
              if (
                !active ||
                !mesh ||
                active.mode !== 'server' ||
                active.serverId !== payload.serverId ||
                (payload.roomId && active.roomId && payload.roomId !== active.roomId)
              ) {
                return
              }
              const srv = serversRef.current.find((s) => s.id === active.serverId)
              if (!srv || srv.encrypted) return
              if (srv.bannedPubkeys.some((p) => p.toLowerCase() === sender)) return
              if (!isExplicitlyTrustedRef.current(sender)) return
              const directRoomId = payload.roomId || active.roomId || DEFAULT_SERVER_VOICE_ROOM_ID
              const directEventTs =
                typeof payload.ts === 'number' && Number.isFinite(payload.ts) && payload.ts > 0
                  ? payload.ts
                  : event.created_at * 1000
              const directLastLeaveTs =
                lastLeaveTsByRoomPeerRef.current.get(`${srv.id}:${directRoomId}:${sender}`) ?? 0
              if (directEventTs <= directLastLeaveTs) return

              if (payload.action === 'offer' && payload.sdp) {
                await mesh.handleRemoteOffer(sender, payload.sdp, payload.nickname)
              } else if (payload.action === 'answer' && payload.sdp) {
                await mesh.handleRemoteAnswer(sender, payload.sdp)
              } else if (payload.action === 'ice') {
                const iceList =
                  payload.candidates && payload.candidates.length > 0
                    ? payload.candidates
                    : payload.candidate
                      ? [payload.candidate]
                      : []
                if (iceList.length > 0) {
                  await mesh.handleRemoteIceBatch(sender, iceList)
                }
              } else if (payload.action === 'media-state') {
                mesh.updatePeerMetadata(sender, {
                  nickname: payload.nickname,
                  audioMuted: payload.audioMuted,
                  videoEnabled: payload.videoEnabled,
                  screenSharing: payload.screenSharing,
                  isRecording: payload.recording,
                })
                notifyRemoteRecordingChange(sender, payload.nickname, payload.recording)
              }
              return
            }

            // Branch B: 1-on-1 DM Call — ALWAYS enforce strict explicit Trust Gate!
            if (!isExplicitlyTrustedRef.current(sender)) return

            if (payload.action === 'call-invite') {
              // Drop replayed invite if this callId was already hung up / canceled / declined
              if (endedCallIdsRef.current.has(payload.callId)) return
              // Ignore re-broadcasted invite for a call we are already ringing or answered
              if (
                incomingCallRef.current?.callId === payload.callId ||
                activeCallRef.current?.callId === payload.callId
              ) {
                return
              }
              // If already in another call or ringing, reply busy
              if (activeCallRef.current || incomingCallRef.current) {
                void publishDirectSignal(sender, {
                  v: 1,
                  action: 'call-decline',
                  callId: payload.callId,
                  reason: 'busy',
                  ts: Date.now(),
                })
                return
              }

              const nick = payload.nickname?.trim() || getPeerNicknameRef.current(sender) || `anon${sender.slice(-4)}`
              const offer: IncomingCallOffer = {
                callId: payload.callId,
                callerPubkey: sender,
                callerNickname: nick,
                callerDisplayHandle: formatDisplayHandle(nick, sender),
                mediaType: payload.media ?? 'audio',
                receivedAt: Date.now(),
              }
              incomingCallRef.current = offer
              setIncomingCall(offer)

              if (incomingRingTimerRef.current !== null) {
                window.clearTimeout(incomingRingTimerRef.current)
              }
              incomingRingTimerRef.current = window.setTimeout(() => {
                if (incomingCallRef.current?.callId === offer.callId) {
                  incomingCallRef.current = null
                  setIncomingCall(null)
                }
              }, RING_TIMEOUT_MS)
              return
            }

            if (payload.action === 'call-accept') {
              const active = activeCallRef.current
              const mesh = meshRef.current
              if (!active || !mesh || active.mode !== 'dm' || active.callId !== payload.callId) return
              if (active.peerPubkey !== sender) return

              if (outgoingRingTimerRef.current !== null) {
                window.clearTimeout(outgoingRingTimerRef.current)
                outgoingRingTimerRef.current = null
              }
              if (outgoingRingInviteTimerRef.current !== null) {
                window.clearInterval(outgoingRingInviteTimerRef.current)
                outgoingRingInviteTimerRef.current = null
              }
              // Only transition ringing-out -> connecting (never downgrade an already active call)
              if (active.status === 'ringing-out') {
                const nextSession: ActiveCallSession = { ...active, status: 'connecting' }
                activeCallRef.current = nextSession
                setActiveCall(nextSession)
              }

              const alreadyTracked = mesh.hasPeer(sender)
              mesh.connectToPeer(sender, payload.nickname)
              if (alreadyTracked) {
                // Callee re-sent call-accept after missing our initial offer/ICE — re-emit immediately
                mesh.resendOfferIfPending(sender)
              }
              syncActiveCallFromMesh()
              return
            }

            if (payload.action === 'call-decline') {
              endedCallIdsRef.current.add(payload.callId)
              if (endedCallIdsRef.current.size > 200) {
                const first = endedCallIdsRef.current.values().next().value
                if (first) endedCallIdsRef.current.delete(first)
              }
              const active = activeCallRef.current
              if (!active || active.mode !== 'dm' || active.callId !== payload.callId) return
              if (active.peerPubkey !== sender) return
              const title = active.title
              teardownActiveCall(false)
              pushToastRef.current(
                'info',
                payload.reason === 'busy' ? 'Peer is busy' : 'Call declined',
                `${title} ${payload.reason === 'busy' ? 'is currently in another call.' : 'declined the call.'}`
              )
              return
            }

            if (payload.action === 'call-hangup' || payload.action === 'call-cancel') {
              endedCallIdsRef.current.add(payload.callId)
              if (endedCallIdsRef.current.size > 200) {
                const first = endedCallIdsRef.current.values().next().value
                if (first) endedCallIdsRef.current.delete(first)
              }
              if (incomingCallRef.current?.callId === payload.callId && incomingCallRef.current.callerPubkey === sender) {
                if (incomingRingTimerRef.current !== null) {
                  window.clearTimeout(incomingRingTimerRef.current)
                  incomingRingTimerRef.current = null
                }
                incomingCallRef.current = null
                setIncomingCall(null)
                return
              }
              const active = activeCallRef.current
              if (active && active.mode === 'dm' && active.callId === payload.callId && active.peerPubkey === sender) {
                const title = active.title
                teardownActiveCall(false)
                pushToastRef.current('info', 'Call ended', `${title} hung up.`)
              }
              return
            }

            const active = activeCallRef.current
            const mesh = meshRef.current
            if (!active || !mesh || active.mode !== 'dm' || active.callId !== payload.callId) return
            if (active.peerPubkey !== sender) return

            // If callee's offer/ice/media-state overtakes call-accept across relays,
            // treat it as implicit acceptance so caller exits ringing-out and clears ring timers!
            if (active.status === 'ringing-out') {
              if (outgoingRingTimerRef.current !== null) {
                window.clearTimeout(outgoingRingTimerRef.current)
                outgoingRingTimerRef.current = null
              }
              if (outgoingRingInviteTimerRef.current !== null) {
                window.clearInterval(outgoingRingInviteTimerRef.current)
                outgoingRingInviteTimerRef.current = null
              }
              const nextSession: ActiveCallSession = { ...active, status: 'connecting' }
              activeCallRef.current = nextSession
              setActiveCall(nextSession)
            }

            if (payload.action === 'offer' && payload.sdp) {
              await mesh.handleRemoteOffer(sender, payload.sdp, payload.nickname)
            } else if (payload.action === 'answer' && payload.sdp) {
              await mesh.handleRemoteAnswer(sender, payload.sdp)
            } else if (payload.action === 'ice') {
              const iceList =
                payload.candidates && payload.candidates.length > 0
                  ? payload.candidates
                  : payload.candidate
                    ? [payload.candidate]
                    : []
              if (iceList.length > 0) {
                await mesh.handleRemoteIceBatch(sender, iceList)
              }
            } else if (payload.action === 'media-state') {
              mesh.updatePeerMetadata(sender, {
                nickname: payload.nickname,
                audioMuted: payload.audioMuted,
                videoEnabled: payload.videoEnabled,
                screenSharing: payload.screenSharing,
                isRecording: payload.recording,
              })
              notifyRemoteRecordingChange(sender, payload.nickname, payload.recording)
            }
          })()
        },
      }
    )

    return () => {
      unsub()
    }
  }, [pool, masterPubkey, identityManager, notifyRemoteRecordingChange, publishDirectSignal, syncActiveCallFromMesh, teardownActiveCall])

  // Server Voice Lounge room presence & E2EE room signaling subscription across all joined servers
  const serverRoomTagsKey = useMemo(
    () =>
      servers
        .map((s) => `${s.id}:${s.encrypted ? '1' : '0'}:${getServerCallRoomTag(s, DEFAULT_SERVER_VOICE_ROOM_ID)}`)
        .sort()
        .join('|'),
    [servers]
  )

  useEffect(() => {
    if (!pool || servers.length === 0) return

    const tagToServer = new Map<string, ServerSummary>()
    const roomTags: string[] = []
    for (const srv of servers) {
      const tag = getServerCallRoomTag(srv, DEFAULT_SERVER_VOICE_ROOM_ID)
      tagToServer.set(tag, srv)
      roomTags.push(tag)
    }
    if (roomTags.length === 0) return

    const subId = `call-rooms:${roomTags.length}`
    const since = Math.floor(Date.now() / 1000) - 35

    const unsub = pool.subscribe(
      subId,
      callSignalingRelays,
      [
        {
          kinds: [KIND_CALL_SIGNAL],
          '#t': roomTags,
          since,
        },
      ],
      {
        onEvent: (event) => {
          if (seenEventIdsRef.current.has(event.id)) return
          seenEventIdsRef.current.add(event.id)
          if (seenEventIdsRef.current.size > MAX_SEEN_SIGNALS) {
            const first = seenEventIdsRef.current.values().next().value
            if (first) seenEventIdsRef.current.delete(first)
          }

          const sender = event.pubkey.toLowerCase()
          const selfPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
          if (sender === selfPk) return
          if (blockedSetRef.current.has(sender)) return
          if (Math.abs(Math.floor(Date.now() / 1000) - event.created_at) > MAX_SIGNAL_AGE_SEC) return
          if (!verifyEventCached(event)) return

          // Match incoming event's `#t` tag to the corresponding joined server
          let matchedServer: ServerSummary | null = null
          for (const tag of event.tags) {
            if (tag[0] === 't' && tag[1]) {
              const found = tagToServer.get(tag[1])
              if (found) {
                matchedServer = found
                break
              }
            }
          }
          if (!matchedServer) return
          const srv = matchedServer
          if (srv.bannedPubkeys.some((p) => p.toLowerCase() === sender)) return

          void (async () => {
            const payload = await parseRoomCallSignalEvent(event, srv)
            if (!payload) return
            const roomId = payload.roomId || DEFAULT_SERVER_VOICE_ROOM_ID
            const roomPeerKey = `${srv.id}:${roomId}:${sender}`
            const eventTs =
              typeof payload.ts === 'number' && Number.isFinite(payload.ts) && payload.ts > 0
                ? payload.ts
                : event.created_at * 1000

            if (payload.action === 'room-leave') {
              const prevLeaveTs = lastLeaveTsByRoomPeerRef.current.get(roomPeerKey) ?? 0
              const maxLeaveTs = Math.max(prevLeaveTs, eventTs)
              lastLeaveTsByRoomPeerRef.current.set(roomPeerKey, maxLeaveTs)

              // Ignore stale leave replayed after a newer rejoin from this same peer
              const lastPresenceTs = lastPresenceTsByRoomPeerRef.current.get(roomPeerKey) ?? 0
              if (eventTs < lastPresenceTs) return

              removeRosterMember(srv.id, sender)
              remoteRecordingRef.current.delete(sender)
              const active = activeCallRef.current
              if (active?.mode === 'server' && active.serverId === srv.id && active.roomId === roomId) {
                meshRef.current?.removePeer(sender)
                syncActiveCallFromMesh()
              }
              return
            }

            // Guard against newest-first relay replay resurrecting departed peers
            const lastLeaveTs = lastLeaveTsByRoomPeerRef.current.get(roomPeerKey) ?? 0
            if (eventTs <= lastLeaveTs) return

            if (payload.action === 'room-join' || payload.action === 'room-ping') {
              // Drop stale out-of-order presence replays older than a newer join/ping from this peer
              const prevPresenceTs = lastPresenceTsByRoomPeerRef.current.get(roomPeerKey) ?? 0
              if (eventTs < prevPresenceTs) return
              // Also drop expired presence replays older than ROOM_PEER_TTL_MS
              if (Date.now() - event.created_at * 1000 > ROOM_PEER_TTL_MS) return
              lastPresenceTsByRoomPeerRef.current.set(roomPeerKey, eventTs)

              const nick = payload.nickname?.trim() || getPeerNicknameRef.current(sender) || `anon${sender.slice(-4)}`
              upsertRosterMember({
                serverId: srv.id,
                roomId,
                pubkey: sender,
                nickname: nick,
                displayHandle: formatDisplayHandle(nick, sender),
                hasVideo: Boolean(payload.videoEnabled || payload.screenSharing || payload.media === 'video'),
                audioMuted: Boolean(payload.audioMuted),
                isRecording: Boolean(payload.recording),
                lastSeenAt: Date.now(),
              })

              const active = activeCallRef.current
              const mesh = meshRef.current
              if (active?.mode === 'server' && active.serverId === srv.id && active.roomId === roomId && mesh) {
                if (isExplicitlyTrustedRef.current(sender)) {
                  if (!mesh.hasPeer(sender) && mesh.canAddPeer(sender)) {
                    mesh.connectToPeer(sender, nick)
                  } else if (mesh.hasPeer(sender)) {
                    // Peer may have just trusted us and re-emitted room-join — resend pending offer immediately
                    mesh.resendOfferIfPending(sender)
                  }
                  mesh.updatePeerMetadata(sender, {
                    nickname: nick,
                    audioMuted: payload.audioMuted,
                    videoEnabled: payload.videoEnabled,
                    screenSharing: payload.screenSharing,
                    isRecording: payload.recording,
                  })
                  notifyRemoteRecordingChange(sender, nick, payload.recording)
                }

                // Always sync so newly arrived/updated untrusted peers render as shielded tiles immediately
                syncActiveCallFromMesh()

                // Immediately echo a throttled room-ping on room-join so newcomers see us fast (presence only, zero WebRTC)
                if (payload.action === 'room-join' && Date.now() - lastRoomPongRef.current > 1500) {
                  lastRoomPongRef.current = Date.now()
                  const myNick = identityManager.getNickname()
                  const hasVid = mesh.getLocalCameraOn() || mesh.getLocalScreenSharing()
                  void publishRoomSignal(srv, roomId, {
                    v: 1,
                    action: 'room-ping',
                    serverId: srv.id,
                    roomId,
                    nickname: myNick,
                    media: hasVid ? 'video' : 'audio',
                    audioMuted: mesh.getLocalMuted(),
                    videoEnabled: mesh.getLocalCameraOn(),
                    screenSharing: mesh.getLocalScreenSharing(),
                    recording: mesh.getLocalRecording(),
                    ts: Date.now(),
                  })
                }
              }
              return
            }

            if (payload.action === 'media-state') {
              const prevPresenceTs = lastPresenceTsByRoomPeerRef.current.get(roomPeerKey) ?? 0
              if (eventTs < prevPresenceTs) return
              if (Date.now() - event.created_at * 1000 > ROOM_PEER_TTL_MS) return
              lastPresenceTsByRoomPeerRef.current.set(roomPeerKey, eventTs)

              const existing = (rostersRef.current[srv.id] ?? []).find((p) => p.pubkey === sender)
              const nick =
                payload.nickname?.trim() ||
                existing?.nickname ||
                getPeerNicknameRef.current(sender) ||
                `anon${sender.slice(-4)}`
              upsertRosterMember({
                serverId: srv.id,
                roomId,
                pubkey: sender,
                nickname: nick,
                displayHandle: formatDisplayHandle(nick, sender),
                hasVideo: Boolean(payload.videoEnabled || payload.screenSharing),
                audioMuted: Boolean(payload.audioMuted),
                isRecording: typeof payload.recording === 'boolean' ? payload.recording : existing?.isRecording,
                lastSeenAt: Date.now(),
              })
              const active = activeCallRef.current
              if (active?.mode === 'server' && active.serverId === srv.id && active.roomId === roomId) {
                if (isExplicitlyTrustedRef.current(sender)) {
                  meshRef.current?.updatePeerMetadata(sender, {
                    nickname: nick,
                    audioMuted: payload.audioMuted,
                    videoEnabled: payload.videoEnabled,
                    screenSharing: payload.screenSharing,
                    isRecording: payload.recording,
                  })
                  notifyRemoteRecordingChange(sender, nick, payload.recording)
                }
                syncActiveCallFromMesh()
              }
              return
            }

            // E2EE Private Server room-tunnelled WebRTC offer/answer/ice — STRICT TRUST GATE
            if (!srv.encrypted) return
            if (payload.targetPubkey !== selfPk) return
            if (!isExplicitlyTrustedRef.current(sender)) return
            const active = activeCallRef.current
            const mesh = meshRef.current
            if (!active || !mesh || active.mode !== 'server' || active.serverId !== srv.id || active.roomId !== roomId) {
              return
            }

            if (payload.action === 'offer' && payload.sdp) {
              await mesh.handleRemoteOffer(sender, payload.sdp, payload.nickname)
            } else if (payload.action === 'answer' && payload.sdp) {
              await mesh.handleRemoteAnswer(sender, payload.sdp)
            } else if (payload.action === 'ice') {
              const iceList =
                payload.candidates && payload.candidates.length > 0
                  ? payload.candidates
                  : payload.candidate
                    ? [payload.candidate]
                    : []
              if (iceList.length > 0) {
                await mesh.handleRemoteIceBatch(sender, iceList)
              }
            }
          })()
        },
      }
    )

    return () => {
      unsub()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, serverRoomTagsKey, callSignalingRelays, identityManager, publishRoomSignal, removeRosterMember, upsertRosterMember])

  // Passive Radio call presence subscription (active geohash/topic + pinned rooms + any active radio call).
  // Zero RTCPeerConnections or STUN/ICE traffic until user explicitly clicks Join.
  const activeGeoCallHash = activeCall?.mode === 'geo' ? activeCall.geohash ?? '' : ''
  const watchedGeoCallKey = useMemo(() => {
    const set = new Set<string>()
    const activeKey = normalizeRadioChannelKey(activeGeohash)
    if (activeKey) set.add(activeKey)
    for (const gh of pinnedGeohashes) {
      const k = normalizeRadioChannelKey(gh)
      if (k) set.add(k)
    }
    const callKey = normalizeRadioChannelKey(activeGeoCallHash)
    if (callKey) set.add(callKey)
    return Array.from(set).sort().join('|')
  }, [activeGeohash, pinnedGeohashes, activeGeoCallHash])

  useEffect(() => {
    if (!pool || !watchedGeoCallKey) return
    const watchedHashes = watchedGeoCallKey.split('|').filter(Boolean)
    if (watchedHashes.length === 0) return

    const tagToGeohash = new Map<string, string>()
    const geoTags: string[] = []
    for (const gh of watchedHashes) {
      const tag = getGeoCallRoomTag(gh)
      tagToGeohash.set(tag, gh)
      geoTags.push(tag)
    }

    const subId = `call-geo-rooms:${geoTags.length}`
    const since = Math.floor(Date.now() / 1000) - 35

    const unsub = pool.subscribe(
      subId,
      CALL_SIGNALING_RELAYS,
      [
        {
          kinds: [KIND_CALL_SIGNAL],
          '#t': geoTags,
          since,
        },
      ],
      {
        onEvent: (event) => {
          if (seenEventIdsRef.current.has(event.id)) return
          seenEventIdsRef.current.add(event.id)
          if (seenEventIdsRef.current.size > MAX_SEEN_SIGNALS) {
            const first = seenEventIdsRef.current.values().next().value
            if (first) seenEventIdsRef.current.delete(first)
          }

          const sender = event.pubkey.toLowerCase()
          if (blockedSetRef.current.has(sender)) return
          if (Math.abs(Math.floor(Date.now() / 1000) - event.created_at) > MAX_SIGNAL_AGE_SEC) return
          if (!verifyEventCached(event)) return

          let matchedGh: string | null = null
          for (const tag of event.tags) {
            if (tag[0] === 't' && tag[1]) {
              const found = tagToGeohash.get(tag[1])
              if (found) {
                matchedGh = found
                break
              }
            }
          }
          if (!matchedGh) return
          const gh = matchedGh

          const selfGeoPk = (
            activeCallRef.current?.mode === 'geo' &&
            activeCallRef.current.geohash === gh &&
            activeGeoMaterialRef.current
              ? activeGeoMaterialRef.current.pubkey
              : identityManager.getDerivedGeohashKeyMaterial(gh).pubkey
          ).toLowerCase()
          if (sender === selfGeoPk) return

          const payload = parseGeoCallSignalEvent(event, gh)
          if (!payload) return

          const roomId = payload.roomId || getGeoCallRoomId(gh)
          const roomPeerKey = `geo:${gh}:${sender}`
          const eventTs =
            typeof payload.ts === 'number' && Number.isFinite(payload.ts) && payload.ts > 0
              ? payload.ts
              : event.created_at * 1000

          if (payload.action === 'room-leave') {
            const prevLeaveTs = lastLeaveTsByRoomPeerRef.current.get(roomPeerKey) ?? 0
            lastLeaveTsByRoomPeerRef.current.set(roomPeerKey, Math.max(prevLeaveTs, eventTs))

            const lastPresenceTs = lastPresenceTsByRoomPeerRef.current.get(roomPeerKey) ?? 0
            if (eventTs < lastPresenceTs) return

            removeGeoRosterMember(gh, sender)
            remoteRecordingRef.current.delete(sender)
            const active = activeCallRef.current
            if (active?.mode === 'geo' && active.geohash === gh) {
              meshRef.current?.removePeer(sender)
              syncActiveCallFromMesh()
            }
            return
          }

          const lastLeaveTs = lastLeaveTsByRoomPeerRef.current.get(roomPeerKey) ?? 0
          if (eventTs <= lastLeaveTs) return

          if (payload.action === 'room-join' || payload.action === 'room-ping') {
            const prevPresenceTs = lastPresenceTsByRoomPeerRef.current.get(roomPeerKey) ?? 0
            if (eventTs < prevPresenceTs) return
            if (Date.now() - event.created_at * 1000 > ROOM_PEER_TTL_MS) return
            lastPresenceTsByRoomPeerRef.current.set(roomPeerKey, eventTs)

            const nick =
              payload.nickname?.trim() ||
              getPeerNicknameRef.current(sender) ||
              `anon${sender.slice(-4)}`
            upsertGeoRosterMember({
              geohash: gh,
              roomId,
              pubkey: sender,
              nickname: nick,
              displayHandle: formatDisplayHandle(nick, sender),
              hasVideo: Boolean(
                payload.videoEnabled || payload.screenSharing || payload.media === 'video'
              ),
              audioMuted: Boolean(payload.audioMuted),
              isRecording: Boolean(payload.recording),
              lastSeenAt: Date.now(),
            })

            const active = activeCallRef.current
            const mesh = meshRef.current
            if (active?.mode === 'geo' && active.geohash === gh && mesh) {
              if (isExplicitlyTrustedRef.current(sender)) {
                if (!mesh.hasPeer(sender) && mesh.canAddPeer(sender)) {
                  mesh.connectToPeer(sender, nick)
                } else if (mesh.hasPeer(sender)) {
                  // Peer may have just trusted us and re-emitted room-join — resend pending offer immediately
                  mesh.resendOfferIfPending(sender)
                }
                mesh.updatePeerMetadata(sender, {
                  nickname: nick,
                  audioMuted: payload.audioMuted,
                  videoEnabled: payload.videoEnabled,
                  screenSharing: payload.screenSharing,
                  isRecording: payload.recording,
                })
                notifyRemoteRecordingChange(sender, nick, payload.recording)
              }

              // Always sync so newly arrived/updated untrusted peers render as shielded tiles immediately
              syncActiveCallFromMesh()

              // Throttled room-ping echo on room-join so newcomers discover us quickly (presence only, zero WebRTC)
              if (payload.action === 'room-join' && Date.now() - lastGeoRoomPongRef.current > 1500) {
                lastGeoRoomPongRef.current = Date.now()
                const myNick = identityManager.getNickname()
                const hasVid = mesh.getLocalCameraOn() || mesh.getLocalScreenSharing()
                void publishGeoRoomSignal(
                  gh,
                  {
                    v: 1,
                    action: 'room-ping',
                    geohash: gh,
                    roomId,
                    nickname: myNick,
                    media: hasVid ? 'video' : 'audio',
                    audioMuted: mesh.getLocalMuted(),
                    videoEnabled: mesh.getLocalCameraOn(),
                    screenSharing: mesh.getLocalScreenSharing(),
                    recording: mesh.getLocalRecording(),
                    ts: Date.now(),
                  },
                  activeGeoMaterialRef.current ?? undefined
                )
              }
            }
            return
          }

          if (payload.action === 'media-state') {
            const prevPresenceTs = lastPresenceTsByRoomPeerRef.current.get(roomPeerKey) ?? 0
            if (eventTs < prevPresenceTs) return
            if (Date.now() - event.created_at * 1000 > ROOM_PEER_TTL_MS) return
            lastPresenceTsByRoomPeerRef.current.set(roomPeerKey, eventTs)

            const existing = (geoRostersRef.current[gh] ?? []).find((p) => p.pubkey === sender)
            const nick =
              payload.nickname?.trim() ||
              existing?.nickname ||
              getPeerNicknameRef.current(sender) ||
              `anon${sender.slice(-4)}`
            upsertGeoRosterMember({
              geohash: gh,
              roomId,
              pubkey: sender,
              nickname: nick,
              displayHandle: formatDisplayHandle(nick, sender),
              hasVideo: Boolean(payload.videoEnabled || payload.screenSharing),
              audioMuted: Boolean(payload.audioMuted),
              isRecording:
                typeof payload.recording === 'boolean' ? payload.recording : existing?.isRecording,
              lastSeenAt: Date.now(),
            })

            const active = activeCallRef.current
            if (active?.mode === 'geo' && active.geohash === gh) {
              if (isExplicitlyTrustedRef.current(sender)) {
                meshRef.current?.updatePeerMetadata(sender, {
                  nickname: nick,
                  audioMuted: payload.audioMuted,
                  videoEnabled: payload.videoEnabled,
                  screenSharing: payload.screenSharing,
                  isRecording: payload.recording,
                })
                notifyRemoteRecordingChange(sender, nick, payload.recording)
              }
              syncActiveCallFromMesh()
            }
          }
        },
      }
    )

    return () => {
      unsub()
    }
  }, [
    pool,
    watchedGeoCallKey,
    identityManager,
    notifyRemoteRecordingChange,
    publishGeoRoomSignal,
    removeGeoRosterMember,
    syncActiveCallFromMesh,
    upsertGeoRosterMember,
  ])

  // Live Dynamic Trust / Untrust Reactivity inside Server & Geo Radio group calls:
  // - Untrusted -> immediately disconnect WebRTC, drop MediaStream, revert to shielded tile.
  // - Newly Trusted -> immediately connect WebRTC & re-emit room-join so both sides connect live without rejoining!
  useEffect(() => {
    const active = activeCallRef.current
    const mesh = meshRef.current
    if (!active || !mesh) return
    if (active.mode !== 'server' && active.mode !== 'geo') return

    // 1. Immediately sever any connected/connecting peer that was removed from Trusted Peers
    for (const p of mesh.getParticipantsSnapshot()) {
      if (p.isSelf) continue
      const pk = p.pubkey.toLowerCase()
      if (!trustedSet.has(pk)) {
        mesh.removePeer(pk)
        remoteRecordingRef.current.delete(pk)
      }
    }

    // 2. Connect any freshly trusted peer currently present in the active room call roster
    const now = Date.now()
    let newlyConnected = false

    if (active.mode === 'server' && active.serverId) {
      const srv = serversRef.current.find((s) => s.id === active.serverId)
      if (srv) {
        const roomId = active.roomId ?? DEFAULT_SERVER_VOICE_ROOM_ID
        const bannedSet = new Set(srv.bannedPubkeys.map((b) => b.toLowerCase()))
        const roster = rostersRef.current[srv.id] ?? []
        for (const peer of roster) {
          if (peer.roomId !== roomId) continue
          if (now - peer.lastSeenAt >= ROOM_PEER_TTL_MS) continue
          const pk = peer.pubkey.toLowerCase()
          if (pk === masterPubkey || blockedSetRef.current.has(pk) || bannedSet.has(pk)) continue
          if (!trustedSet.has(pk)) continue
          if (!mesh.hasPeer(pk) && mesh.canAddPeer(pk)) {
            mesh.connectToPeer(pk, peer.nickname)
            mesh.updatePeerMetadata(pk, {
              nickname: peer.nickname,
              audioMuted: peer.audioMuted,
              videoEnabled: peer.hasVideo,
              isRecording: Boolean(peer.isRecording),
            })
            if (peer.isRecording) {
              notifyRemoteRecordingChange(pk, peer.nickname, true)
            }
            newlyConnected = true
          }
        }
        if (newlyConnected) {
          const nick = identityManager.getNickname()
          const hasVid = mesh.getLocalCameraOn() || mesh.getLocalScreenSharing()
          void publishRoomSignal(srv, roomId, {
            v: 1,
            action: 'room-join',
            serverId: srv.id,
            roomId,
            nickname: nick,
            media: hasVid ? 'video' : 'audio',
            audioMuted: mesh.getLocalMuted(),
            videoEnabled: mesh.getLocalCameraOn(),
            screenSharing: mesh.getLocalScreenSharing(),
            recording: mesh.getLocalRecording(),
            ts: Date.now(),
          })
        }
      }
    } else if (active.mode === 'geo' && active.geohash) {
      const gh = normalizeRadioChannelKey(active.geohash) ?? normalizeGeohash(active.geohash)
      const roomId = active.roomId ?? getGeoCallRoomId(gh)
      const selfGeoPk = activeGeoMaterialRef.current?.pubkey.toLowerCase() ?? ''
      const roster = geoRostersRef.current[gh] ?? []
      for (const peer of roster) {
        if (now - peer.lastSeenAt >= ROOM_PEER_TTL_MS) continue
        const pk = peer.pubkey.toLowerCase()
        if (pk === selfGeoPk || blockedSetRef.current.has(pk)) continue
        if (!trustedSet.has(pk)) continue
        if (!mesh.hasPeer(pk) && mesh.canAddPeer(pk)) {
          mesh.connectToPeer(pk, peer.nickname)
          mesh.updatePeerMetadata(pk, {
            nickname: peer.nickname,
            audioMuted: peer.audioMuted,
            videoEnabled: peer.hasVideo,
            isRecording: Boolean(peer.isRecording),
          })
          if (peer.isRecording) {
            notifyRemoteRecordingChange(pk, peer.nickname, true)
          }
          newlyConnected = true
        }
      }
      if (newlyConnected) {
        const nick = identityManager.getNickname()
        const hasVid = mesh.getLocalCameraOn() || mesh.getLocalScreenSharing()
        void publishGeoRoomSignal(
          gh,
          {
            v: 1,
            action: 'room-join',
            geohash: gh,
            roomId,
            nickname: nick,
            media: hasVid ? 'video' : 'audio',
            audioMuted: mesh.getLocalMuted(),
            videoEnabled: mesh.getLocalCameraOn(),
            screenSharing: mesh.getLocalScreenSharing(),
            recording: mesh.getLocalRecording(),
            ts: Date.now(),
          },
          activeGeoMaterialRef.current ?? undefined
        )
      }
    }

    syncActiveCallFromMesh()
  }, [
    trustedSet,
    masterPubkey,
    identityManager,
    notifyRemoteRecordingChange,
    publishGeoRoomSignal,
    publishRoomSignal,
    syncActiveCallFromMesh,
  ])

  // Expire stale room presence entries after 30s (Servers + Geo Radio)
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now()
      const selfPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const activeGeoSelfPk = activeGeoMaterialRef.current?.pubkey.toLowerCase() ?? null
      const currentActive = activeCallRef.current

      let activeRoomRosterChanged = false
      setServerCallRosters((prev) => {
        let changed = false
        const next: Record<string, RoomCallPresence[]> = {}
        for (const [serverId, list] of Object.entries(prev)) {
          const kept = list.filter((p) => {
            if (p.pubkey === selfPk && currentActive?.mode === 'server' && currentActive.serverId === serverId) {
              return true
            }
            const fresh = now - p.lastSeenAt < ROOM_PEER_TTL_MS
            if (!fresh) {
              changed = true
              if (currentActive?.mode === 'server' && currentActive.serverId === serverId) {
                meshRef.current?.removePeer(p.pubkey)
                activeRoomRosterChanged = true
              }
            }
            return fresh
          })
          if (kept.length > 0) {
            next[serverId] = kept
          } else if (list.length > 0) {
            changed = true
          }
        }
        if (!changed) return prev
        rostersRef.current = next
        return next
      })

      setGeoCallRosters((prev) => {
        let changed = false
        const next: Record<string, GeoCallPresence[]> = {}
        for (const [gh, list] of Object.entries(prev)) {
          const kept = list.filter((p) => {
            if (
              activeGeoSelfPk &&
              p.pubkey === activeGeoSelfPk &&
              currentActive?.mode === 'geo' &&
              currentActive.geohash === gh
            ) {
              return true
            }
            const fresh = now - p.lastSeenAt < ROOM_PEER_TTL_MS
            if (!fresh) {
              changed = true
              if (currentActive?.mode === 'geo' && currentActive.geohash === gh) {
                meshRef.current?.removePeer(p.pubkey)
                activeRoomRosterChanged = true
              }
            }
            return fresh
          })
          if (kept.length > 0) {
            next[gh] = kept
          } else if (list.length > 0) {
            changed = true
          }
        }
        if (!changed) return prev
        geoRostersRef.current = next
        return next
      })
      if (activeRoomRosterChanged) {
        syncActiveCallFromMesh()
      }
      // Prune old timestamp ledger entries (> 5 min) so maps stay bounded
      const ledgerCutoff = now - 5 * 60 * 1000
      for (const [k, ts] of lastLeaveTsByRoomPeerRef.current.entries()) {
        if (ts < ledgerCutoff) lastLeaveTsByRoomPeerRef.current.delete(k)
      }
      for (const [k, ts] of lastPresenceTsByRoomPeerRef.current.entries()) {
        if (ts < ledgerCutoff) lastPresenceTsByRoomPeerRef.current.delete(k)
      }
    }, ROSTER_SWEEP_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [identityManager, syncActiveCallFromMesh])

  // Send room-leave / call-hangup and dispose tracks cleanly on page unload
  useEffect(() => {
    const handleUnload = () => {
      teardownActiveCall(true, { abortRecording: true })
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => {
      window.removeEventListener('beforeunload', handleUnload)
      teardownActiveCall(false, { abortRecording: true })
    }
  }, [teardownActiveCall])

  // Media controls
  const toggleMute = useCallback(() => {
    meshRef.current?.toggleMute()
  }, [])

  const toggleDeafen = useCallback(() => {
    meshRef.current?.toggleDeafen()
  }, [])

  const toggleCamera = useCallback(async (): Promise<boolean> => {
    if (!meshRef.current) return false
    return await meshRef.current.toggleCamera()
  }, [])

  const toggleScreenShare = useCallback(async (): Promise<boolean> => {
    if (!meshRef.current) return false
    return await meshRef.current.toggleScreenShare()
  }, [])

  const setRecordingQuality = useCallback((quality: RecordingQualityPreset) => {
    if (!isValidRecordingQuality(quality)) return
    const changed = recordingQualityRef.current !== quality
    persistRecordingQuality(quality)
    recordingQualityRef.current = quality
    setRecordingQualityState(quality)
    if (changed && recorderRef.current?.isRecording()) {
      const spec = getRecordingQualitySpec(quality)
      pushToastRef.current(
        'info',
        `Recording quality set to ${spec.label} (${spec.shortLabel})`,
        'Applies to your next recording.'
      )
    }
  }, [])

  const toggleRecording = useCallback(async (): Promise<void> => {
    const mesh = meshRef.current
    const active = activeCallRef.current
    if (!mesh || !active) return

    if (!isCallRecordingSupported()) {
      pushToastRef.current(
        'warning',
        'Recording unsupported',
        'MediaRecorder or Web Audio API is unavailable in this browser.'
      )
      return
    }

    if (!recorderRef.current) {
      recorderRef.current = new CallRecorderController()
    }
    const recorder = recorderRef.current

    // Stop active recording & download file
    if (recorder.isRecording()) {
      recordingStartedAtRef.current = null
      recordingModeRef.current = null
      recordingQualityActiveRef.current = null
      recordingBytesRef.current = 0
      mesh.setLocalRecording(false)
      syncActiveCallFromMesh()

      const res = await recorder.stopAndDownload(active.title)
      if (res) {
        pushToastRef.current('success', 'Recording saved', `${res.filename} (${res.durationSec}s)`)
      } else {
        pushToastRef.current('warning', 'Recording empty', 'No media frames were captured before stopping.')
      }
      return
    }

    // Start new call recording (defense-in-depth: strictly exclude untrusted remote peers)
    try {
      recordingBytesRef.current = 0
      const trustedForRecording = mesh
        .getParticipantsSnapshot()
        .filter((p) => p.isSelf || isExplicitlyTrustedRef.current(p.pubkey))
      const startInfo = recorder.start(trustedForRecording, {
        quality: recordingQualityRef.current,
        onBytesChange: (bytes) => {
          recordingBytesRef.current = bytes
          const cur = activeCallRef.current
          if (cur && cur.localRecordingBytes !== bytes) {
            const nextSession: ActiveCallSession = { ...cur, localRecordingBytes: bytes }
            activeCallRef.current = nextSession
            setActiveCall(nextSession)
          }
        },
        onUnexpectedStop: (errMsg) => {
          recordingStartedAtRef.current = null
          recordingModeRef.current = null
          recordingQualityActiveRef.current = null
          recordingBytesRef.current = 0
          meshRef.current?.setLocalRecording(false)
          syncActiveCallFromMesh()
          if (errMsg) {
            pushToastRef.current('error', 'Recording stopped unexpectedly', errMsg)
          }
        },
      })
      recordingStartedAtRef.current = startInfo.startedAt
      recordingModeRef.current = startInfo.mode
      recordingQualityActiveRef.current = startInfo.quality
      mesh.setLocalRecording(true)
      syncActiveCallFromMesh()
      const spec = getRecordingQualitySpec(startInfo.quality)
      pushToastRef.current(
        'info',
        `Recording started (${spec.label} · ${spec.shortLabel})`,
        startInfo.mode === 'video'
          ? `Capturing ${spec.width}×${spec.height} @ ${spec.fps}fps (${spec.approxMbPerMin}) + mixed audio. All participants are notified.`
          : `Capturing mixed call audio (${Math.round(spec.audioBitsPerSecond / 1000)} kbps). All participants are notified.`
      )
    } catch (err) {
      recordingStartedAtRef.current = null
      recordingModeRef.current = null
      recordingQualityActiveRef.current = null
      recordingBytesRef.current = 0
      recorder.abort()
      mesh.setLocalRecording(false)
      syncActiveCallFromMesh()
      pushToastRef.current(
        'error',
        'Unable to start recording',
        err instanceof Error ? err.message : 'MediaRecorder failed to initialize.'
      )
    }
  }, [syncActiveCallFromMesh])

  // Custom TURN/ICE server configuration
  const saveTurnConfigAction = useCallback((config: TurnServerConfig): boolean => {
    const url = normalizeTurnUrl(config.url)
    if (!url) {
      pushToastRef.current('warning', 'Invalid TURN/STUN URL', 'Expected turn:…, turns:…, or stun:…')
      return false
    }
    const clean: TurnServerConfig = {
      url,
      username: config.username?.trim() || undefined,
      credential: config.credential?.trim() || undefined,
    }
    persistTurnConfig(clean)
    setTurnConfig(clean)
    turnConfigRef.current = clean
    meshRef.current?.updateIceServers(clean)
    pushToastRef.current('success', 'TURN server saved', url)
    return true
  }, [])

  const clearTurnConfigAction = useCallback(() => {
    persistTurnConfig(null)
    setTurnConfig(null)
    turnConfigRef.current = null
    meshRef.current?.updateIceServers(null)
    pushToastRef.current('info', 'Custom TURN cleared', 'Using default public STUN servers.')
  }, [])

  const getServerCallCount = useCallback(
    (serverId: string): number => (serverCallRosters[serverId]?.length ?? 0),
    [serverCallRosters]
  )

  const getGeoCallPresence = useCallback(
    (geohash: string): GeoCallPresence[] => {
      const gh = normalizeRadioChannelKey(geohash) ?? normalizeGeohash(geohash)
      return gh ? (geoCallRosters[gh] ?? []) : []
    },
    [geoCallRosters]
  )

  const getGeoCallCount = useCallback(
    (geohash: string): number => {
      const gh = normalizeRadioChannelKey(geohash) ?? normalizeGeohash(geohash)
      return gh ? (geoCallRosters[gh]?.length ?? 0) : 0
    },
    [geoCallRosters]
  )

  const resetAllCalls = useCallback(() => {
    recordingBytesRef.current = 0
    recordingQualityActiveRef.current = null
    recorderRef.current?.abort()
    teardownActiveCall(true, { abortRecording: true })
    incomingCallRef.current = null
    setIncomingCall(null)
    rostersRef.current = {}
    setServerCallRosters({})
    geoRostersRef.current = {}
    setGeoCallRosters({})
    turnConfigRef.current = null
    setTurnConfig(null)
    recordingQualityRef.current = DEFAULT_RECORDING_QUALITY
    setRecordingQualityState(DEFAULT_RECORDING_QUALITY)
    seenEventIdsRef.current.clear()
    lastLeaveTsByRoomPeerRef.current.clear()
    lastPresenceTsByRoomPeerRef.current.clear()
    endedCallIdsRef.current.clear()
    remoteRecordingRef.current.clear()
  }, [teardownActiveCall])

  const isOutgoingDmRinging = Boolean(
    activeCall && activeCall.mode === 'dm' && activeCall.status === 'ringing-out'
  )

  const calls: CallEngine = useMemo(
    () => ({
      activeCall,
      incomingCall,
      isOutgoingDmRinging,
      serverCallRosters,
      geoCallRosters,
      maxParticipants: MAX_CALL_PARTICIPANTS,
      recordingQuality,
      setRecordingQuality,
      turnConfig,
      saveTurnConfig: saveTurnConfigAction,
      clearTurnConfig: clearTurnConfigAction,
      startDmCall,
      acceptIncomingCall,
      declineIncomingCall,
      joinServerCall,
      joinGeoCall,
      leaveCall,
      toggleMute,
      toggleDeafen,
      toggleCamera,
      toggleScreenShare,
      toggleRecording,
      getServerCallCount,
      getGeoCallPresence,
      getGeoCallCount,
    }),
    [
      activeCall,
      incomingCall,
      isOutgoingDmRinging,
      serverCallRosters,
      geoCallRosters,
      recordingQuality,
      setRecordingQuality,
      turnConfig,
      saveTurnConfigAction,
      clearTurnConfigAction,
      startDmCall,
      acceptIncomingCall,
      declineIncomingCall,
      joinServerCall,
      joinGeoCall,
      leaveCall,
      toggleMute,
      toggleDeafen,
      toggleCamera,
      toggleScreenShare,
      toggleRecording,
      getServerCallCount,
      getGeoCallPresence,
      getGeoCallCount,
    ]
  )

  return {
    calls,
    callSignalingRelays,
    resetAllCalls,
  }
}
