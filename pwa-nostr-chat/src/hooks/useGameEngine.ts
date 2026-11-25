import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  isGameAllowedInScope,
  makeGameScopeKey,
  type ActiveChessSession,
  type ActiveGoSession,
  type ActivePokerSession,
  type ChessSetupOptions,
  type GameEngine,
  type GameScope,
  type GameScopeKey,
  type GameSessionStatus,
  type GameSignalPayload,
  type GoSetupOptions,
  type IncomingGameInvite,
  type PokerSetupOptions,
  type RoomGameScope,
  type RoomPokerAnnouncement,
} from '../types/games.ts'
import type { ToastLevel } from '../types/protocol.ts'
import type { ServerSummary } from '../types/servers.ts'
import {
  formatBitchatChannelLabel,
  isValidBitchatChannelKey,
  normalizeBitchatChannelKey,
} from '../lib/bitchatChannel.ts'
import { verifyEventCached } from '../lib/bitchatProtocol.ts'
import {
  applyChessDrawOffer,
  applyChessDrawResponse,
  applyChessMove,
  applyChessResign,
  createInitialChessState,
  deserializeChessState,
  serializeChessState,
  type ChessColor,
  type ChessMove,
  type ChessState,
} from '../lib/games/chessEngine.ts'
import {
  acceptGoScore as engineAcceptGoScore,
  applyGoMove,
  applyGoResign,
  createInitialGoState,
  resumeGoFromScoring,
  toggleGoDeadGroup,
  type GoColor,
  type GoConfig,
  type GoMove,
  type GoState,
} from '../lib/games/goEngine.ts'
import {
  applyPokerAction,
  canStartPokerHand,
  createPokerTable as engineCreatePokerTable,
  getRecommendedBlinds,
  removePokerPlayer,
  seatPokerPlayer,
  startPokerHand as engineStartPokerHand,
  type PokerAction,
  type PokerCard,
  type PokerDealerPrivateState,
  type PokerPublicState,
} from '../lib/games/pokerEngine.ts'
import {
  buildDirectGameSignalTemplate,
  buildGeoGameSignalTemplate,
  buildServerGameSignalTemplate,
  DM_GAME_SIGNAL_TAG,
  GAME_SIGNALING_RELAYS,
  generateGameId,
  getGeoGameRoomTag,
  getRelaysForServerGame,
  getServerGameRoomTag,
  KIND_GAME_SIGNAL,
  MAX_GAME_SIGNAL_AGE_SEC,
  parseDirectGameSignalEvent,
  parseGeoGameSignalEvent,
  parseServerGameSignalEvent,
  POKER_HOLE_SIGNAL_TAG,
} from '../lib/gameSignaling.ts'
import { normalizeGeohash } from '../lib/geohash.ts'
import type { IdentityManager, SigningKeyMaterial } from '../lib/identity.ts'
import type { RelayPool } from '../lib/relayPool.ts'

const INVITE_REBROADCAST_MS = 5_000
const INVITE_TIMEOUT_MS = 45_000
const POKER_ANNOUNCE_INTERVAL_MS = 6_000
const ROOM_POKER_TTL_MS = 22_000
const ROOM_POKER_SWEEP_MS = 5_000
const MAX_SEEN_EVENT_IDS = 800

export interface LiveChessGameSession extends ActiveChessSession {
  chessState: ChessState
}

export interface LiveGoGameSession extends ActiveGoSession {
  goState: GoState
}

export interface LivePokerGameSession extends ActivePokerSession {
  pokerState: PokerPublicState
}

export type LiveGameSession =
  | LiveChessGameSession
  | LiveGoGameSession
  | LivePokerGameSession

export interface UseGameEngineParams {
  pool: RelayPool | null
  identityManager: IdentityManager
  servers: ServerSummary[]
  activeGeohash: string
  identityVersion: number
  blockedSet: Set<string>
  getPeerNickname?: (pubkey: string) => string | undefined
  onIncomingInvite?: (invite: IncomingGameInvite) => void
  pushToast: (level: ToastLevel, title: string, detail?: string) => void
}

export interface GameEngineController extends GameEngine {
  activeGamesByScope: Record<GameScopeKey, LiveGameSession>
  focusGame: (scopeKey: GameScopeKey) => void
  minimizeGame: () => void
  startDmChess: (
    peerPubkey: string,
    peerDisplayName: string,
    opts: ChessSetupOptions,
  ) => Promise<boolean>
  startDmGo: (
    peerPubkey: string,
    peerDisplayName: string,
    opts: GoSetupOptions,
  ) => Promise<boolean>
  acceptInvite: (scopeKey: GameScopeKey) => Promise<boolean>
  declineInvite: (scopeKey: GameScopeKey) => Promise<void>
  playChessMove: (scopeKey: GameScopeKey, move: ChessMove) => Promise<boolean>
  offerChessDraw: (scopeKey: GameScopeKey) => Promise<void>
  respondChessDraw: (scopeKey: GameScopeKey, accept: boolean) => Promise<void>
  playGoMove: (scopeKey: GameScopeKey, move: GoMove) => Promise<boolean>
  resumeGoScoring: (scopeKey: GameScopeKey) => Promise<void>
  closeGame: (scopeKey: GameScopeKey) => Promise<void>
  startPokerTable: (
    scope: RoomGameScope,
    targetId: string,
    targetLabel: string,
    opts: PokerSetupOptions,
  ) => Promise<boolean>
  sitInPokerTable: (scopeKey: GameScopeKey) => Promise<void>
  playPokerAction: (scopeKey: GameScopeKey, action: PokerAction) => Promise<boolean>
  getActiveGameForScope: (scope: GameScope, targetId: string) => LiveGameSession | null
  getIncomingInviteForPeer: (peerPubkey: string) => IncomingGameInvite | null
  getRoomPokerTable: (scope: RoomGameScope, targetId: string) => RoomPokerAnnouncement | null
}

export interface UseGameEngineResult {
  games: GameEngineController
  gameSignalingRelays: string[]
  resetAllGames: () => void
}

function randomBit(): boolean {
  const arr = new Uint8Array(1)
  crypto.getRandomValues(arr)
  return (arr[0] & 1) === 1
}

function resolveSelfDisplayName(identityManager: IdentityManager): string {
  const nick = identityManager.getNickname().trim()
  return nick || 'anon'
}

function normalizeGeoTarget(channelKey: string): string {
  if (isValidBitchatChannelKey(channelKey)) {
    return normalizeBitchatChannelKey(channelKey) ?? normalizeGeohash(channelKey)
  }
  return normalizeGeohash(channelKey)
}

function parseJsonSafe<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function isValidGoStateSnapshot(raw: unknown): raw is GoState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const obj = raw as Record<string, unknown>
  if (!obj.config || typeof obj.config !== 'object') return false
  if (!Array.isArray(obj.board)) return false
  if (obj.turn !== 'b' && obj.turn !== 'w') return false
  if (obj.phase !== 'playing' && obj.phase !== 'scoring' && obj.phase !== 'finished') return false
  return true
}

function isValidPokerPublicState(raw: unknown): raw is PokerPublicState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const obj = raw as Record<string, unknown>
  if (typeof obj.tableId !== 'string' || !obj.tableId) return false
  if (typeof obj.hostPubkey !== 'string' || !obj.hostPubkey) return false
  if (!Array.isArray(obj.seats) || !Array.isArray(obj.communityCards)) return false
  if (typeof obj.fixedBuyIn !== 'number' || typeof obj.handNumber !== 'number') return false
  return true
}

function makeChessSession(
  base: Omit<LiveChessGameSession, 'stateJson'>,
): LiveChessGameSession {
  return {
    ...base,
    stateJson: serializeChessState(base.chessState),
  }
}

function makeGoSession(base: Omit<LiveGoGameSession, 'stateJson'>): LiveGoGameSession {
  return {
    ...base,
    stateJson: JSON.stringify(base.goState),
  }
}

function makePokerSession(
  base: Omit<LivePokerGameSession, 'publicStateJson'>,
): LivePokerGameSession {
  return {
    ...base,
    publicStateJson: JSON.stringify(base.pokerState),
  }
}

export function useGameEngine(params: UseGameEngineParams): UseGameEngineResult {
  const {
    pool,
    identityManager,
    servers,
    activeGeohash,
    identityVersion,
    blockedSet,
    getPeerNickname,
    onIncomingInvite,
    pushToast,
  } = params

  const [activeGamesByScope, setActiveGamesByScope] = useState<
    Record<GameScopeKey, LiveGameSession>
  >({})
  const [incomingInvites, setIncomingInvites] = useState<IncomingGameInvite[]>([])
  const [roomPokerTables, setRoomPokerTables] = useState<
    Record<GameScopeKey, RoomPokerAnnouncement>
  >({})
  const [focusedScopeKey, setFocusedScopeKey] = useState<GameScopeKey | null>(null)
  const [minimized, setMinimized] = useState(false)

  const poolRef = useRef<RelayPool | null>(pool)
  poolRef.current = pool

  const serversRef = useRef<ServerSummary[]>(servers)
  serversRef.current = servers

  const blockedSetRef = useRef<Set<string>>(blockedSet)
  blockedSetRef.current = blockedSet

  const getPeerNicknameRef = useRef(getPeerNickname)
  getPeerNicknameRef.current = getPeerNickname

  const onIncomingInviteRef = useRef(onIncomingInvite)
  onIncomingInviteRef.current = onIncomingInvite

  const pushToastRef = useRef(pushToast)
  pushToastRef.current = pushToast

  const activeGamesRef = useRef<Record<GameScopeKey, LiveGameSession>>(activeGamesByScope)
  activeGamesRef.current = activeGamesByScope

  const incomingInvitesRef = useRef<IncomingGameInvite[]>(incomingInvites)
  incomingInvitesRef.current = incomingInvites

  const roomPokerTablesRef = useRef<Record<GameScopeKey, RoomPokerAnnouncement>>(roomPokerTables)
  roomPokerTablesRef.current = roomPokerTables

  const focusedScopeKeyRef = useRef<GameScopeKey | null>(focusedScopeKey)
  focusedScopeKeyRef.current = focusedScopeKey

  // Strictly host-private Poker decks & hole cards (NEVER published publicly!)
  const pokerPrivateStateRef = useRef<Map<string, PokerDealerPrivateState>>(new Map())
  // Pending hole cards received slightly before poker-state arrives
  const pendingHoleCardsRef = useRef<
    Map<string, { handNumber: number; cards: [PokerCard, PokerCard] }>
  >(new Map())
  // Outgoing DM invite rebroadcast + timeout timers keyed by gameId
  const inviteTimersRef = useRef<Map<string, { intervalId: number; timeoutId: number }>>(new Map())
  // Seen ephemeral event IDs ring-set
  const seenEventIdsRef = useRef<Set<string>>(new Set())
  // Recently closed/ended game/table IDs to ignore late relay echoes
  const endedGameIdsRef = useRef<Set<string>>(new Set())

  const masterPubkey = useMemo(() => {
    void identityVersion
    return identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
  }, [identityManager, identityVersion])

  const gameSignalingRelays = useMemo(() => {
    const set = new Set<string>(GAME_SIGNALING_RELAYS)
    for (const s of servers) {
      for (const r of s.relays) {
        if (r.startsWith('wss://')) set.add(r)
      }
    }
    return Array.from(set)
  }, [servers])

  const rememberSeenEvent = useCallback((eventId: string): boolean => {
    if (seenEventIdsRef.current.has(eventId)) return false
    seenEventIdsRef.current.add(eventId)
    if (seenEventIdsRef.current.size > MAX_SEEN_EVENT_IDS) {
      const oldest = seenEventIdsRef.current.values().next().value
      if (oldest) seenEventIdsRef.current.delete(oldest)
    }
    return true
  }, [])

  const clearInviteTimer = useCallback((gameId: string) => {
    const entry = inviteTimersRef.current.get(gameId)
    if (!entry) return
    window.clearInterval(entry.intervalId)
    window.clearTimeout(entry.timeoutId)
    inviteTimersRef.current.delete(gameId)
  }, [])

  const getMaterialForRoom = useCallback(
    (scope: RoomGameScope, targetId: string): SigningKeyMaterial => {
      if (scope === 'geo') {
        return identityManager.getDerivedGeohashKeyMaterial(normalizeGeoTarget(targetId))
      }
      return identityManager.getMasterKeyMaterial()
    },
    [identityManager],
  )

  const publishDirectSignal = useCallback(
    async (
      recipientPubkey: string,
      payload: GameSignalPayload,
      options?: {
        material?: SigningKeyMaterial
        tag?: string
        relays?: readonly string[]
        notifyError?: boolean
      },
    ): Promise<boolean> => {
      const currentPool = poolRef.current
      if (!currentPool) return false
      try {
        const material = options?.material ?? identityManager.getMasterKeyMaterial()
        const template = await buildDirectGameSignalTemplate(
          payload,
          material,
          recipientPubkey,
          options?.tag ?? DM_GAME_SIGNAL_TAG,
        )
        const signed = await identityManager.signEventWithMaterial(template, material)
        const relays = options?.relays ? [...options.relays] : [...GAME_SIGNALING_RELAYS]
        await currentPool.publish(relays, signed, 2_000)
        return true
      } catch (err) {
        if (options?.notifyError) {
          pushToastRef.current(
            'error',
            'Game signaling failed',
            err instanceof Error ? err.message : 'Unable to encrypt or publish game signal.',
          )
        }
        return false
      }
    },
    [identityManager],
  )

  const publishRoomSignal = useCallback(
    async (
      scope: RoomGameScope,
      targetId: string,
      payload: GameSignalPayload,
      notifyError = false,
    ): Promise<boolean> => {
      const currentPool = poolRef.current
      if (!currentPool) return false
      try {
        if (scope === 'geo') {
          const normGeo = normalizeGeoTarget(targetId)
          const material = identityManager.getDerivedGeohashKeyMaterial(normGeo)
          const template = buildGeoGameSignalTemplate(payload, normGeo)
          const signed = await identityManager.signEventWithMaterial(template, material)
          await currentPool.publish([...GAME_SIGNALING_RELAYS], signed, 2_000)
          return true
        }
        const server = serversRef.current.find((s) => s.id === targetId)
        if (!server) return false
        const template = await buildServerGameSignalTemplate(payload, server)
        const signed = await identityManager.signEvent(template)
        await currentPool.publish(getRelaysForServerGame(server), signed, 2_000)
        return true
      } catch (err) {
        if (notifyError) {
          pushToastRef.current(
            'error',
            'Poker signaling failed',
            err instanceof Error ? err.message : 'Unable to publish room poker signal.',
          )
        }
        return false
      }
    },
    [identityManager],
  )

  const buildPokerAnnouncementPayload = useCallback(
    (session: LivePokerGameSession): GameSignalPayload => ({
      v: 1,
      type: 'poker-announce',
      tableId: session.tableId,
      scope: session.scope,
      targetId: session.targetId,
      hostPubkey: session.hostPubkey,
      hostDisplayName: session.hostDisplayName,
      fixedBuyIn: session.pokerState.fixedBuyIn,
      smallBlind: session.pokerState.smallBlind,
      bigBlind: session.pokerState.bigBlind,
      seatedCount: session.pokerState.seats.length,
      maxSeats: session.pokerState.maxSeats,
      phase: session.pokerState.phase,
      ts: Date.now(),
    }),
    [],
  )

  const broadcastHostPokerUpdate = useCallback(
    async (session: LivePokerGameSession) => {
      await Promise.all([
        publishRoomSignal(session.scope, session.targetId, {
          v: 1,
          type: 'poker-state',
          tableId: session.tableId,
          seq: session.seq,
          publicState: session.publicStateJson,
          ts: Date.now(),
        }),
        publishRoomSignal(session.scope, session.targetId, buildPokerAnnouncementPayload(session)),
      ])
    },
    [buildPokerAnnouncementPayload, publishRoomSignal],
  )

  const updateGameSession = useCallback((session: LiveGameSession) => {
    setActiveGamesByScope((prev) => {
      const next = { ...prev, [session.scopeKey]: session }
      activeGamesRef.current = next
      return next
    })
  }, [])

  const removeGameSession = useCallback(
    (scopeKey: GameScopeKey) => {
      const existing = activeGamesRef.current[scopeKey]
      if (existing) {
        clearInviteTimer(existing.gameId)
        if (existing.kind === 'poker') {
          pokerPrivateStateRef.current.delete(existing.tableId)
        }
      }
      setActiveGamesByScope((prev) => {
        if (!(scopeKey in prev)) return prev
        const next = { ...prev }
        delete next[scopeKey]
        activeGamesRef.current = next
        return next
      })
      if (focusedScopeKeyRef.current === scopeKey) {
        setFocusedScopeKey(null)
        setMinimized(false)
      }
    },
    [clearInviteTimer],
  )

  /* ------------------------------------------------------------------------
     1-on-1 DM Chess & Go Actions
     ------------------------------------------------------------------------ */
  const startDmChess = useCallback(
    async (
      peerPubkey: string,
      peerDisplayName: string,
      opts: ChessSetupOptions,
    ): Promise<boolean> => {
      if (!isGameAllowedInScope('dm', 'chess')) {
        pushToastRef.current('warning', 'Chess is only available in 1-on-1 People chats')
        return false
      }
      const peerPk = peerPubkey.trim().toLowerCase()
      if (!peerPk || peerPk === masterPubkey) return false
      const scopeKey = makeGameScopeKey('dm', peerPk)
      const existing = activeGamesRef.current[scopeKey]
      if (existing && existing.status !== 'finished') {
        setFocusedScopeKey(scopeKey)
        setMinimized(false)
        pushToastRef.current('info', 'A game is already active here')
        return false
      }

      const myColor: ChessColor =
        opts.colorPref === 'random' ? (randomBit() ? 'w' : 'b') : opts.colorPref
      const gameId = generateGameId()
      const now = Date.now()
      const cleanName = peerDisplayName.trim() || getPeerNicknameRef.current?.(peerPk) || 'Opponent'

      const session = makeChessSession({
        gameId,
        kind: 'chess',
        scope: 'dm',
        scopeKey,
        targetId: peerPk,
        title: `Chess · ${cleanName}`,
        status: 'inviting',
        localPubkey: masterPubkey,
        localColor: myColor,
        opponentPubkey: peerPk,
        opponentDisplayName: cleanName,
        seq: 0,
        createdAtMs: now,
        updatedAtMs: now,
        chessState: createInitialChessState(),
      })

      updateGameSession(session)
      setFocusedScopeKey(scopeKey)
      setMinimized(false)

      const sendInvite = () =>
        publishDirectSignal(
          peerPk,
          {
            v: 1,
            type: 'game-invite',
            gameId,
            kind: 'chess',
            challengerColor: myColor,
            displayName: resolveSelfDisplayName(identityManager),
            ts: Date.now(),
          },
          { notifyError: false },
        )

      const ok = await publishDirectSignal(
        peerPk,
        {
          v: 1,
          type: 'game-invite',
          gameId,
          kind: 'chess',
          challengerColor: myColor,
          displayName: resolveSelfDisplayName(identityManager),
          ts: now,
        },
        { notifyError: true },
      )
      if (!ok) {
        removeGameSession(scopeKey)
        return false
      }

      clearInviteTimer(gameId)
      const intervalId = window.setInterval(() => {
        const cur = activeGamesRef.current[scopeKey]
        if (!cur || cur.gameId !== gameId || cur.status !== 'inviting') {
          clearInviteTimer(gameId)
          return
        }
        void sendInvite()
      }, INVITE_REBROADCAST_MS)

      const timeoutId = window.setTimeout(() => {
        clearInviteTimer(gameId)
        const cur = activeGamesRef.current[scopeKey]
        if (cur && cur.gameId === gameId && cur.status === 'inviting') {
          pushToastRef.current(
            'info',
            'Chess invite waiting',
            `${cleanName} hasn't accepted yet — you can keep waiting or close the board.`,
          )
        }
      }, INVITE_TIMEOUT_MS)

      inviteTimersRef.current.set(gameId, { intervalId, timeoutId })
      return true
    },
    [
      clearInviteTimer,
      identityManager,
      masterPubkey,
      publishDirectSignal,
      removeGameSession,
      updateGameSession,
    ],
  )

  const startDmGo = useCallback(
    async (
      peerPubkey: string,
      peerDisplayName: string,
      opts: GoSetupOptions,
    ): Promise<boolean> => {
      if (!isGameAllowedInScope('dm', 'go')) {
        pushToastRef.current('warning', 'Go is only available in 1-on-1 People chats')
        return false
      }
      const peerPk = peerPubkey.trim().toLowerCase()
      if (!peerPk || peerPk === masterPubkey) return false
      const scopeKey = makeGameScopeKey('dm', peerPk)
      const existing = activeGamesRef.current[scopeKey]
      if (existing && existing.status !== 'finished') {
        setFocusedScopeKey(scopeKey)
        setMinimized(false)
        pushToastRef.current('info', 'A game is already active here')
        return false
      }

      const myColor: GoColor =
        opts.colorPref === 'random' ? (randomBit() ? 'b' : 'w') : opts.colorPref
      const goConfig: GoConfig = {
        boardSize: opts.boardSize,
        komi: opts.komi,
        handicap: opts.handicap,
        scoring: opts.scoring,
      }
      const gameId = generateGameId()
      const now = Date.now()
      const cleanName = peerDisplayName.trim() || getPeerNicknameRef.current?.(peerPk) || 'Opponent'

      const session = makeGoSession({
        gameId,
        kind: 'go',
        scope: 'dm',
        scopeKey,
        targetId: peerPk,
        title: `Go ${goConfig.boardSize}×${goConfig.boardSize} · ${cleanName}`,
        status: 'inviting',
        localPubkey: masterPubkey,
        localColor: myColor,
        opponentPubkey: peerPk,
        opponentDisplayName: cleanName,
        goConfig,
        seq: 0,
        createdAtMs: now,
        updatedAtMs: now,
        goState: createInitialGoState(goConfig),
      })

      updateGameSession(session)
      setFocusedScopeKey(scopeKey)
      setMinimized(false)

      const sendInvite = () =>
        publishDirectSignal(
          peerPk,
          {
            v: 1,
            type: 'game-invite',
            gameId,
            kind: 'go',
            challengerColor: myColor,
            displayName: resolveSelfDisplayName(identityManager),
            goConfig,
            ts: Date.now(),
          },
          { notifyError: false },
        )

      const ok = await publishDirectSignal(
        peerPk,
        {
          v: 1,
          type: 'game-invite',
          gameId,
          kind: 'go',
          challengerColor: myColor,
          displayName: resolveSelfDisplayName(identityManager),
          goConfig,
          ts: now,
        },
        { notifyError: true },
      )
      if (!ok) {
        removeGameSession(scopeKey)
        return false
      }

      clearInviteTimer(gameId)
      const intervalId = window.setInterval(() => {
        const cur = activeGamesRef.current[scopeKey]
        if (!cur || cur.gameId !== gameId || cur.status !== 'inviting') {
          clearInviteTimer(gameId)
          return
        }
        void sendInvite()
      }, INVITE_REBROADCAST_MS)

      const timeoutId = window.setTimeout(() => {
        clearInviteTimer(gameId)
        const cur = activeGamesRef.current[scopeKey]
        if (cur && cur.gameId === gameId && cur.status === 'inviting') {
          pushToastRef.current(
            'info',
            'Go invite waiting',
            `${cleanName} hasn't accepted yet — you can keep waiting or close the board.`,
          )
        }
      }, INVITE_TIMEOUT_MS)

      inviteTimersRef.current.set(gameId, { intervalId, timeoutId })
      return true
    },
    [
      clearInviteTimer,
      identityManager,
      masterPubkey,
      publishDirectSignal,
      removeGameSession,
      updateGameSession,
    ],
  )

  const acceptInviteInternal = useCallback(
    async (invite: IncomingGameInvite): Promise<boolean> => {
      const { scopeKey } = invite
      const existing = activeGamesRef.current[scopeKey]
      if (existing && existing.status !== 'finished') {
        setFocusedScopeKey(scopeKey)
        setMinimized(false)
        pushToastRef.current('info', 'A game is already active here')
        return false
      }

      const now = Date.now()
      const peerPk = invite.fromPubkey.toLowerCase()
      const cleanName = invite.fromDisplayName || getPeerNicknameRef.current?.(peerPk) || 'Opponent'

      if (invite.kind === 'chess') {
        const myColor: ChessColor = invite.challengerColor === 'w' ? 'b' : 'w'
        updateGameSession(
          makeChessSession({
            gameId: invite.gameId,
            kind: 'chess',
            scope: 'dm',
            scopeKey,
            targetId: peerPk,
            title: `Chess · ${cleanName}`,
            status: 'active',
            localPubkey: masterPubkey,
            localColor: myColor,
            opponentPubkey: peerPk,
            opponentDisplayName: cleanName,
            seq: 0,
            createdAtMs: now,
            updatedAtMs: now,
            chessState: createInitialChessState(),
          }),
        )
      } else {
        const goConfig: GoConfig = invite.goConfig ?? {
          boardSize: 19,
          komi: 6.5,
          handicap: 0,
          scoring: 'japanese',
        }
        const myColor: GoColor = invite.challengerColor === 'b' ? 'w' : 'b'
        updateGameSession(
          makeGoSession({
            gameId: invite.gameId,
            kind: 'go',
            scope: 'dm',
            scopeKey,
            targetId: peerPk,
            title: `Go ${goConfig.boardSize}×${goConfig.boardSize} · ${cleanName}`,
            status: 'active',
            localPubkey: masterPubkey,
            localColor: myColor,
            opponentPubkey: peerPk,
            opponentDisplayName: cleanName,
            goConfig,
            seq: 0,
            createdAtMs: now,
            updatedAtMs: now,
            goState: createInitialGoState(goConfig),
          }),
        )
      }

      setIncomingInvites((prev) => {
        const next = prev.filter((i) => i.scopeKey !== scopeKey && i.gameId !== invite.gameId)
        incomingInvitesRef.current = next
        return next
      })
      setFocusedScopeKey(scopeKey)
      setMinimized(false)

      await publishDirectSignal(
        peerPk,
        {
          v: 1,
          type: 'game-accept',
          gameId: invite.gameId,
          kind: invite.kind,
          displayName: resolveSelfDisplayName(identityManager),
          ts: now,
        },
        { notifyError: true },
      )
      return true
    },
    [identityManager, masterPubkey, publishDirectSignal, updateGameSession],
  )

  const acceptInvite = useCallback(
    async (scopeKey: GameScopeKey): Promise<boolean> => {
      const invite = incomingInvitesRef.current.find((i) => i.scopeKey === scopeKey)
      if (!invite) return false
      return await acceptInviteInternal(invite)
    },
    [acceptInviteInternal],
  )

  const acceptGameInvite = useCallback(
    async (gameIdOrScopeKey: string): Promise<boolean> => {
      const invite = incomingInvitesRef.current.find(
        (i) => i.gameId === gameIdOrScopeKey || i.scopeKey === gameIdOrScopeKey,
      )
      if (!invite) return false
      return await acceptInviteInternal(invite)
    },
    [acceptInviteInternal],
  )

  const declineInviteInternal = useCallback(
    async (invite: IncomingGameInvite): Promise<void> => {
      endedGameIdsRef.current.add(invite.gameId)
      setIncomingInvites((prev) => {
        const next = prev.filter((i) => i.scopeKey !== invite.scopeKey && i.gameId !== invite.gameId)
        incomingInvitesRef.current = next
        return next
      })
      await publishDirectSignal(invite.fromPubkey, {
        v: 1,
        type: 'game-decline',
        gameId: invite.gameId,
        reason: 'declined',
        ts: Date.now(),
      })
    },
    [publishDirectSignal],
  )

  const declineInvite = useCallback(
    async (scopeKey: GameScopeKey): Promise<void> => {
      const invite = incomingInvitesRef.current.find((i) => i.scopeKey === scopeKey)
      if (!invite) return
      await declineInviteInternal(invite)
    },
    [declineInviteInternal],
  )

  const declineGameInvite = useCallback(
    async (gameIdOrScopeKey: string): Promise<void> => {
      const invite = incomingInvitesRef.current.find(
        (i) => i.gameId === gameIdOrScopeKey || i.scopeKey === gameIdOrScopeKey,
      )
      if (!invite) return
      await declineInviteInternal(invite)
    },
    [declineInviteInternal],
  )

  const playChessMove = useCallback(
    async (scopeKey: GameScopeKey, move: ChessMove): Promise<boolean> => {
      const session = activeGamesRef.current[scopeKey]
      if (!session || session.kind !== 'chess' || session.status !== 'active') return false
      if (session.chessState.turn !== session.localColor) return false

      const nextState = applyChessMove(session.chessState, move)
      if (!nextState) return false

      const nextSeq = session.seq + 1
      const nextStatus: GameSessionStatus = nextState.status === 'finished' ? 'finished' : 'active'
      updateGameSession(
        makeChessSession({
          ...session,
          seq: nextSeq,
          status: nextStatus,
          updatedAtMs: Date.now(),
          chessState: nextState,
        }),
      )

      await publishDirectSignal(session.opponentPubkey, {
        v: 1,
        type: 'game-move',
        gameId: session.gameId,
        kind: 'chess',
        seq: nextSeq,
        move: JSON.stringify(move),
        ts: Date.now(),
      })
      return true
    },
    [publishDirectSignal, updateGameSession],
  )

  const offerChessDraw = useCallback(
    async (scopeKey: GameScopeKey): Promise<void> => {
      const session = activeGamesRef.current[scopeKey]
      if (!session || session.kind !== 'chess' || session.status !== 'active') return
      const nextState = applyChessDrawOffer(session.chessState, session.localColor)
      updateGameSession(
        makeChessSession({
          ...session,
          updatedAtMs: Date.now(),
          chessState: nextState,
        }),
      )
      await publishDirectSignal(session.opponentPubkey, {
        v: 1,
        type: 'game-draw-offer',
        gameId: session.gameId,
        ts: Date.now(),
      })
    },
    [publishDirectSignal, updateGameSession],
  )

  const respondChessDraw = useCallback(
    async (scopeKey: GameScopeKey, accept: boolean): Promise<void> => {
      const session = activeGamesRef.current[scopeKey]
      if (!session || session.kind !== 'chess' || session.status !== 'active') return
      const nextState = applyChessDrawResponse(session.chessState, accept)
      updateGameSession(
        makeChessSession({
          ...session,
          status: nextState.status === 'finished' ? 'finished' : 'active',
          updatedAtMs: Date.now(),
          chessState: nextState,
        }),
      )
      await publishDirectSignal(session.opponentPubkey, {
        v: 1,
        type: 'game-draw-response',
        gameId: session.gameId,
        accept,
        ts: Date.now(),
      })
    },
    [publishDirectSignal, updateGameSession],
  )

  const playGoMove = useCallback(
    async (scopeKey: GameScopeKey, move: GoMove): Promise<boolean> => {
      const session = activeGamesRef.current[scopeKey]
      if (!session || session.kind !== 'go' || session.status !== 'active') return false
      if (session.goState.phase !== 'playing' || session.goState.turn !== session.localColor) {
        return false
      }
      const applied = applyGoMove(session.goState, move)
      if (!applied) return false

      const nextSeq = session.seq + 1
      updateGameSession(
        makeGoSession({
          ...session,
          seq: nextSeq,
          status: applied.state.phase === 'finished' ? 'finished' : 'active',
          updatedAtMs: Date.now(),
          goState: applied.state,
        }),
      )

      await publishDirectSignal(session.opponentPubkey, {
        v: 1,
        type: 'game-move',
        gameId: session.gameId,
        kind: 'go',
        seq: nextSeq,
        move: JSON.stringify(move),
        ts: Date.now(),
      })
      return true
    },
    [publishDirectSignal, updateGameSession],
  )

  const toggleGoDeadStone = useCallback(
    async (scopeKey: GameScopeKey, row: number, col: number): Promise<void> => {
      const session = activeGamesRef.current[scopeKey]
      if (!session || session.kind !== 'go' || session.goState.phase !== 'scoring') return
      const nextState = toggleGoDeadGroup(session.goState, row, col)
      const nextSeq = session.seq + 1
      updateGameSession(
        makeGoSession({
          ...session,
          seq: nextSeq,
          updatedAtMs: Date.now(),
          goState: nextState,
        }),
      )
      await publishDirectSignal(session.opponentPubkey, {
        v: 1,
        type: 'game-scoring-toggle',
        gameId: session.gameId,
        seq: nextSeq,
        row,
        col,
        ts: Date.now(),
      })
    },
    [publishDirectSignal, updateGameSession],
  )

  const acceptGoScore = useCallback(
    async (scopeKey: GameScopeKey): Promise<void> => {
      const session = activeGamesRef.current[scopeKey]
      if (!session || session.kind !== 'go' || session.goState.phase !== 'scoring') return
      const nextState = engineAcceptGoScore(session.goState, session.localColor)
      const nextSeq = session.seq + 1
      updateGameSession(
        makeGoSession({
          ...session,
          seq: nextSeq,
          status: nextState.phase === 'finished' ? 'finished' : 'active',
          updatedAtMs: Date.now(),
          goState: nextState,
        }),
      )
      await publishDirectSignal(session.opponentPubkey, {
        v: 1,
        type: 'game-scoring-accept',
        gameId: session.gameId,
        seq: nextSeq,
        ts: Date.now(),
      })
    },
    [publishDirectSignal, updateGameSession],
  )

  const resumeGoScoring = useCallback(
    async (scopeKey: GameScopeKey): Promise<void> => {
      const session = activeGamesRef.current[scopeKey]
      if (!session || session.kind !== 'go' || session.goState.phase !== 'scoring') return
      const nextState = resumeGoFromScoring(session.goState)
      const nextSeq = session.seq + 1
      updateGameSession(
        makeGoSession({
          ...session,
          seq: nextSeq,
          status: 'active',
          updatedAtMs: Date.now(),
          goState: nextState,
        }),
      )
      await publishDirectSignal(session.opponentPubkey, {
        v: 1,
        type: 'game-scoring-resume',
        gameId: session.gameId,
        seq: nextSeq,
        ts: Date.now(),
      })
    },
    [publishDirectSignal, updateGameSession],
  )

  const resignGame = useCallback(
    async (scopeKey: GameScopeKey): Promise<void> => {
      const session = activeGamesRef.current[scopeKey]
      if (!session || session.kind === 'poker' || session.status === 'finished') return
      clearInviteTimer(session.gameId)

      if (session.kind === 'chess') {
        const nextState = applyChessResign(session.chessState, session.localColor)
        updateGameSession(
          makeChessSession({
            ...session,
            status: 'finished',
            updatedAtMs: Date.now(),
            chessState: nextState,
          }),
        )
      } else {
        const nextState = applyGoResign(session.goState, session.localColor)
        updateGameSession(
          makeGoSession({
            ...session,
            status: 'finished',
            updatedAtMs: Date.now(),
            goState: nextState,
          }),
        )
      }

      await publishDirectSignal(session.opponentPubkey, {
        v: 1,
        type: 'game-resign',
        gameId: session.gameId,
        ts: Date.now(),
      })
    },
    [clearInviteTimer, publishDirectSignal, updateGameSession],
  )

  /* ------------------------------------------------------------------------
     Multiplayer Bitchat & Group Texas Hold'em Poker Actions
     ------------------------------------------------------------------------ */
  const startPokerTable = useCallback(
    async (
      scope: RoomGameScope,
      targetId: string,
      targetLabel: string,
      opts: PokerSetupOptions,
    ): Promise<boolean> => {
      if (!isGameAllowedInScope(scope, 'poker')) {
        pushToastRef.current('warning', 'Poker is only available in Bitchat channels and Groups')
        return false
      }
      const cleanTarget = scope === 'geo' ? normalizeGeoTarget(targetId) : targetId.trim()
      if (!cleanTarget) return false
      const scopeKey = makeGameScopeKey(scope, cleanTarget)

      const existing = activeGamesRef.current[scopeKey]
      if (existing && existing.status !== 'finished') {
        setFocusedScopeKey(scopeKey)
        setMinimized(false)
        pushToastRef.current('info', 'A game is already active here')
        return false
      }

      const existingRoomTable = roomPokerTablesRef.current[scopeKey]
      if (existingRoomTable && Date.now() - existingRoomTable.updatedAtMs < ROOM_POKER_TTL_MS) {
        pushToastRef.current(
          'info',
          'A poker table is already open here',
          'Join the existing table instead (1 game at a time per room).',
        )
        return false
      }

      const material = getMaterialForRoom(scope, cleanTarget)
      const myPubkey = material.pubkey.toLowerCase()
      const myName = resolveSelfDisplayName(identityManager)
      const tableId = generateGameId()
      const now = Date.now()

      const publicState = engineCreatePokerTable({
        tableId,
        hostPubkey: myPubkey,
        hostDisplayName: myName,
        fixedBuyIn: opts.fixedBuyIn,
        maxSeats: opts.maxSeats,
      })

      const label =
        targetLabel.trim() ||
        (scope === 'geo'
          ? formatBitchatChannelLabel(cleanTarget)
          : serversRef.current.find((s) => s.id === cleanTarget)?.name || cleanTarget)

      const session = makePokerSession({
        gameId: tableId,
        tableId,
        kind: 'poker',
        scope,
        scopeKey,
        targetId: cleanTarget,
        title: `Poker · ${label}`,
        status: 'active',
        localPubkey: myPubkey,
        hostPubkey: myPubkey,
        hostDisplayName: myName,
        isHost: true,
        seq: 1,
        createdAtMs: now,
        updatedAtMs: now,
        pokerState: publicState,
        myHoleCards: null,
        myHoleHandNumber: 0,
      })

      updateGameSession(session)
      setRoomPokerTables((prev) => {
        const ann: RoomPokerAnnouncement = {
          tableId,
          scope,
          scopeKey,
          targetId: cleanTarget,
          hostPubkey: myPubkey,
          hostDisplayName: myName,
          fixedBuyIn: publicState.fixedBuyIn,
          smallBlind: publicState.smallBlind,
          bigBlind: publicState.bigBlind,
          seatedCount: publicState.seats.length,
          maxSeats: publicState.maxSeats,
          phase: publicState.phase,
          updatedAtMs: now,
        }
        const next = { ...prev, [scopeKey]: ann }
        roomPokerTablesRef.current = next
        return next
      })
      setFocusedScopeKey(scopeKey)
      setMinimized(false)

      await broadcastHostPokerUpdate(session)
      return true
    },
    [broadcastHostPokerUpdate, getMaterialForRoom, identityManager, updateGameSession],
  )

  const createPokerTable = useCallback(
    async (
      scope: RoomGameScope,
      targetId: string,
      opts: PokerSetupOptions,
    ): Promise<boolean> => {
      const label =
        scope === 'geo'
          ? formatBitchatChannelLabel(targetId)
          : serversRef.current.find((s) => s.id === targetId)?.name || targetId
      return await startPokerTable(scope, targetId, label, opts)
    },
    [startPokerTable],
  )

  const sitInPokerTable = useCallback(
    async (scopeKey: GameScopeKey): Promise<void> => {
      const session = activeGamesRef.current[scopeKey]
      if (!session || session.kind !== 'poker' || session.status !== 'active') return
      const myName = resolveSelfDisplayName(identityManager)
      if (session.isHost) {
        const seated = seatPokerPlayer(session.pokerState, session.localPubkey, myName)
        if (!seated) return
        const nextSession = makePokerSession({
          ...session,
          seq: session.seq + 1,
          updatedAtMs: Date.now(),
          pokerState: seated,
        })
        updateGameSession(nextSession)
        await broadcastHostPokerUpdate(nextSession)
        return
      }
      await publishRoomSignal(session.scope, session.targetId, {
        v: 1,
        type: 'poker-join',
        tableId: session.tableId,
        displayName: myName,
        ts: Date.now(),
      })
    },
    [broadcastHostPokerUpdate, identityManager, publishRoomSignal, updateGameSession],
  )

  const joinPokerTable = useCallback(
    async (
      scope: RoomGameScope,
      targetId: string,
      tableIdOrLabel?: string,
    ): Promise<boolean> => {
      if (!isGameAllowedInScope(scope, 'poker')) return false
      const cleanTarget = scope === 'geo' ? normalizeGeoTarget(targetId) : targetId.trim()
      if (!cleanTarget) return false
      const scopeKey = makeGameScopeKey(scope, cleanTarget)

      const existing = activeGamesRef.current[scopeKey]
      if (existing && existing.kind === 'poker' && existing.status !== 'finished') {
        setFocusedScopeKey(scopeKey)
        setMinimized(false)
        const alreadySeated = existing.pokerState.seats.some(
          (s) => s.pubkey.toLowerCase() === existing.localPubkey.toLowerCase(),
        )
        if (!alreadySeated) {
          await sitInPokerTable(scopeKey)
        }
        return true
      }

      const announcement = roomPokerTablesRef.current[scopeKey]
      if (!announcement) {
        pushToastRef.current('info', 'No active poker table found in this room')
        return false
      }

      const material = getMaterialForRoom(scope, cleanTarget)
      const myPubkey = material.pubkey.toLowerCase()
      const myName = resolveSelfDisplayName(identityManager)
      const now = Date.now()

      const blinds = getRecommendedBlinds(announcement.fixedBuyIn)
      const placeholderState = engineCreatePokerTable({
        tableId: announcement.tableId,
        hostPubkey: announcement.hostPubkey,
        hostDisplayName: announcement.hostDisplayName,
        fixedBuyIn: announcement.fixedBuyIn,
        maxSeats: announcement.maxSeats,
      })
      placeholderState.smallBlind = announcement.smallBlind || blinds.smallBlind
      placeholderState.bigBlind = announcement.bigBlind || blinds.bigBlind
      placeholderState.phase = announcement.phase

      const pendingHole = pendingHoleCardsRef.current.get(announcement.tableId)
      const fallbackLabel =
        scope === 'geo'
          ? formatBitchatChannelLabel(cleanTarget)
          : serversRef.current.find((s) => s.id === cleanTarget)?.name || cleanTarget
      const displayLabel =
        tableIdOrLabel && tableIdOrLabel !== announcement.tableId
          ? tableIdOrLabel.trim() || fallbackLabel
          : fallbackLabel

      const session = makePokerSession({
        gameId: announcement.tableId,
        tableId: announcement.tableId,
        kind: 'poker',
        scope,
        scopeKey,
        targetId: cleanTarget,
        title: `Poker · ${displayLabel}`,
        status: 'active',
        localPubkey: myPubkey,
        hostPubkey: announcement.hostPubkey,
        hostDisplayName: announcement.hostDisplayName,
        isHost: announcement.hostPubkey.toLowerCase() === myPubkey,
        seq: 0,
        createdAtMs: now,
        updatedAtMs: now,
        pokerState: placeholderState,
        myHoleCards: pendingHole?.cards ?? null,
        myHoleHandNumber: pendingHole?.handNumber ?? 0,
      })

      updateGameSession(session)
      setFocusedScopeKey(scopeKey)
      setMinimized(false)

      await publishRoomSignal(
        scope,
        cleanTarget,
        {
          v: 1,
          type: 'poker-join',
          tableId: announcement.tableId,
          displayName: myName,
          ts: now,
        },
        true,
      )
      return true
    },
    [getMaterialForRoom, identityManager, publishRoomSignal, sitInPokerTable, updateGameSession],
  )

  const startPokerHand = useCallback(
    async (scopeKey: GameScopeKey): Promise<boolean> => {
      const session = activeGamesRef.current[scopeKey]
      if (!session || session.kind !== 'poker' || !session.isHost) return false
      if (!canStartPokerHand(session.pokerState)) {
        pushToastRef.current('info', 'Need at least 2 seated players with chips to deal')
        return false
      }

      const dealt = engineStartPokerHand(session.pokerState)
      if (!dealt) return false

      // Hold deck & hole cards strictly in host memory
      pokerPrivateStateRef.current.set(session.tableId, dealt.privateState)

      const myCards = dealt.privateState.holeCards[session.localPubkey] ?? null
      const nextSession = makePokerSession({
        ...session,
        seq: session.seq + 1,
        updatedAtMs: Date.now(),
        pokerState: dealt.publicState,
        myHoleCards: myCards,
        myHoleHandNumber: dealt.publicState.handNumber,
      })
      updateGameSession(nextSession)

      const roomMaterial = getMaterialForRoom(session.scope, session.targetId)
      const server =
        session.scope === 'server'
          ? serversRef.current.find((s) => s.id === session.targetId)
          : null
      const directRelays =
        session.scope === 'server' ? getRelaysForServerGame(server) : GAME_SIGNALING_RELAYS

      await broadcastHostPokerUpdate(nextSession)
      const holeDispatches: Array<Promise<boolean>> = []
      for (const [seatPubkey, cards] of Object.entries(dealt.privateState.holeCards)) {
        if (seatPubkey.toLowerCase() === session.localPubkey) continue
        holeDispatches.push(
          publishDirectSignal(
            seatPubkey,
            {
              v: 1,
              type: 'poker-hole-cards',
              tableId: session.tableId,
              handNumber: dealt.publicState.handNumber,
              cards,
              ts: Date.now(),
            },
            {
              material: roomMaterial,
              tag: POKER_HOLE_SIGNAL_TAG,
              relays: directRelays,
            },
          ),
        )
      }
      await Promise.all(holeDispatches)
      return true
    },
    [broadcastHostPokerUpdate, getMaterialForRoom, publishDirectSignal, updateGameSession],
  )

  const playPokerAction = useCallback(
    async (scopeKey: GameScopeKey, action: PokerAction): Promise<boolean> => {
      const session = activeGamesRef.current[scopeKey]
      if (!session || session.kind !== 'poker' || session.status !== 'active') return false
      if (session.pokerState.actingPubkey?.toLowerCase() !== session.localPubkey) return false

      if (session.isHost) {
        const priv = pokerPrivateStateRef.current.get(session.tableId)
        if (!priv) return false
        const res = applyPokerAction(session.pokerState, priv, session.localPubkey, action)
        if (!res) return false
        pokerPrivateStateRef.current.set(session.tableId, res.privateState)
        const nextSession = makePokerSession({
          ...session,
          seq: session.seq + 1,
          status: res.publicState.phase === 'finished' ? 'finished' : 'active',
          updatedAtMs: Date.now(),
          pokerState: res.publicState,
        })
        updateGameSession(nextSession)
        await broadcastHostPokerUpdate(nextSession)
        return true
      }

      return await publishRoomSignal(session.scope, session.targetId, {
        v: 1,
        type: 'poker-action',
        tableId: session.tableId,
        handNumber: session.pokerState.handNumber,
        action: JSON.stringify(action),
        ts: Date.now(),
      })
    },
    [broadcastHostPokerUpdate, publishRoomSignal, updateGameSession],
  )

  const endPokerTable = useCallback(
    async (scopeKey: GameScopeKey): Promise<void> => {
      const session = activeGamesRef.current[scopeKey]
      if (!session || session.kind !== 'poker') return
      endedGameIdsRef.current.add(session.tableId)
      pokerPrivateStateRef.current.delete(session.tableId)
      pendingHoleCardsRef.current.delete(session.tableId)
      removeGameSession(scopeKey)
      setRoomPokerTables((prev) => {
        if (!(scopeKey in prev)) return prev
        const next = { ...prev }
        delete next[scopeKey]
        roomPokerTablesRef.current = next
        return next
      })
      if (session.isHost) {
        await publishRoomSignal(session.scope, session.targetId, {
          v: 1,
          type: 'poker-end',
          tableId: session.tableId,
          reason: 'host-ended',
          ts: Date.now(),
        })
      }
    },
    [publishRoomSignal, removeGameSession],
  )

  const leavePokerTable = useCallback(
    async (scopeKey: GameScopeKey): Promise<void> => {
      const session = activeGamesRef.current[scopeKey]
      if (!session || session.kind !== 'poker') return
      if (session.isHost) {
        await endPokerTable(scopeKey)
        return
      }
      pendingHoleCardsRef.current.delete(session.tableId)
      removeGameSession(scopeKey)
      await publishRoomSignal(session.scope, session.targetId, {
        v: 1,
        type: 'poker-leave',
        tableId: session.tableId,
        ts: Date.now(),
      })
    },
    [endPokerTable, publishRoomSignal, removeGameSession],
  )

  const closeGame = useCallback(
    async (scopeKey: GameScopeKey): Promise<void> => {
      const session = activeGamesRef.current[scopeKey]
      if (!session) return
      if (session.kind === 'poker') {
        await leavePokerTable(scopeKey)
        return
      }
      endedGameIdsRef.current.add(session.gameId)
      const shouldNotify = session.status === 'inviting' || session.status === 'active'
      removeGameSession(scopeKey)
      if (shouldNotify) {
        await publishDirectSignal(session.opponentPubkey, {
          v: 1,
          type: 'game-end',
          gameId: session.gameId,
          reason: 'closed',
          ts: Date.now(),
        })
      }
    },
    [leavePokerTable, publishDirectSignal, removeGameSession],
  )

  /* ------------------------------------------------------------------------
     Inbound Signal Handlers (DM, Private Hole Cards, Room Poker)
     ------------------------------------------------------------------------ */
  const handleDirectSignalPayload = useCallback(
    (senderPubkey: string, payload: GameSignalPayload) => {
      const sender = senderPubkey.toLowerCase()
      if (blockedSetRef.current.has(sender)) return

      // Private NIP-44 Poker hole cards
      if (payload.type === 'poker-hole-cards') {
        if (endedGameIdsRef.current.has(payload.tableId)) return
        pendingHoleCardsRef.current.set(payload.tableId, {
          handNumber: payload.handNumber,
          cards: payload.cards,
        })
        const matchingEntry = Object.values(activeGamesRef.current).find(
          (g): g is LivePokerGameSession =>
            g.kind === 'poker' &&
            g.tableId === payload.tableId &&
            g.hostPubkey.toLowerCase() === sender,
        )
        if (matchingEntry && payload.handNumber >= matchingEntry.myHoleHandNumber) {
          updateGameSession(
            makePokerSession({
              ...matchingEntry,
              myHoleCards: payload.cards,
              myHoleHandNumber: payload.handNumber,
              updatedAtMs: Date.now(),
            }),
          )
        }
        return
      }

      const scopeKey = makeGameScopeKey('dm', sender)
      const session = activeGamesRef.current[scopeKey]

      switch (payload.type) {
        case 'game-invite': {
          if (endedGameIdsRef.current.has(payload.gameId)) return
          if (!isGameAllowedInScope('dm', payload.kind)) return
          if (session && session.status !== 'finished') return
          const existingInv = incomingInvitesRef.current.find((i) => i.scopeKey === scopeKey)
          if (existingInv && existingInv.gameId === payload.gameId) return

          const fromName =
            payload.displayName?.trim() || getPeerNicknameRef.current?.(sender) || 'Peer'
          const invite: IncomingGameInvite = {
            gameId: payload.gameId,
            kind: payload.kind,
            scopeKey,
            fromPubkey: sender,
            fromDisplayName: fromName,
            challengerColor: payload.challengerColor,
            goConfig: payload.goConfig,
            createdAtMs: Date.now(),
          }
          setIncomingInvites((prev) => {
            const next = [invite, ...prev.filter((i) => i.scopeKey !== scopeKey)]
            incomingInvitesRef.current = next
            return next
          })
          onIncomingInviteRef.current?.(invite)
          break
        }

        case 'game-accept': {
          if (!session || session.kind === 'poker' || session.gameId !== payload.gameId) return
          if (session.opponentPubkey !== sender) return
          clearInviteTimer(session.gameId)
          if (session.status === 'inviting') {
            const oppName = payload.displayName?.trim() || session.opponentDisplayName
            if (session.kind === 'chess') {
              updateGameSession(
                makeChessSession({
                  ...session,
                  status: 'active',
                  opponentDisplayName: oppName,
                  updatedAtMs: Date.now(),
                }),
              )
            } else {
              updateGameSession(
                makeGoSession({
                  ...session,
                  status: 'active',
                  opponentDisplayName: oppName,
                  updatedAtMs: Date.now(),
                }),
              )
            }
            pushToastRef.current(
              'success',
              `${session.kind === 'chess' ? 'Chess' : 'Go'} match started`,
              `${oppName} accepted your challenge.`,
            )
          }
          break
        }

        case 'game-decline': {
          if (!session || session.kind === 'poker' || session.gameId !== payload.gameId) return
          if (session.opponentPubkey !== sender) return
          endedGameIdsRef.current.add(session.gameId)
          const opponentName = session.opponentDisplayName
          removeGameSession(scopeKey)
          pushToastRef.current('info', 'Game invite declined', `${opponentName} declined the match.`)
          break
        }

        case 'game-move': {
          if (!session || session.kind === 'poker' || session.gameId !== payload.gameId) return
          if (session.opponentPubkey !== sender || session.kind !== payload.kind) return
          if (payload.seq <= session.seq) return
          if (payload.seq > session.seq + 1) {
            void publishDirectSignal(sender, {
              v: 1,
              type: 'game-sync-req',
              gameId: session.gameId,
              lastSeq: session.seq,
              ts: Date.now(),
            })
            return
          }

          if (session.kind === 'chess') {
            if (session.chessState.turn === session.localColor) return
            const move = parseJsonSafe<ChessMove>(payload.move)
            if (!move || typeof move.from !== 'number' || typeof move.to !== 'number') return
            const nextState = applyChessMove(session.chessState, move)
            if (!nextState) return
            updateGameSession(
              makeChessSession({
                ...session,
                seq: payload.seq,
                status: nextState.status === 'finished' ? 'finished' : 'active',
                updatedAtMs: Date.now(),
                chessState: nextState,
              }),
            )
          } else {
            if (session.goState.phase !== 'playing' || session.goState.turn === session.localColor) {
              return
            }
            const move = parseJsonSafe<GoMove>(payload.move)
            if (!move || (move.type !== 'play' && move.type !== 'pass')) return
            const applied = applyGoMove(session.goState, move)
            if (!applied) return
            updateGameSession(
              makeGoSession({
                ...session,
                seq: payload.seq,
                status: applied.state.phase === 'finished' ? 'finished' : 'active',
                updatedAtMs: Date.now(),
                goState: applied.state,
              }),
            )
          }
          break
        }

        case 'game-scoring-toggle': {
          if (!session || session.kind !== 'go' || session.gameId !== payload.gameId) return
          if (session.opponentPubkey !== sender || session.goState.phase !== 'scoring') return
          if (payload.seq <= session.seq) return
          const nextState = toggleGoDeadGroup(session.goState, payload.row, payload.col)
          updateGameSession(
            makeGoSession({
              ...session,
              seq: payload.seq,
              updatedAtMs: Date.now(),
              goState: nextState,
            }),
          )
          break
        }

        case 'game-scoring-accept': {
          if (!session || session.kind !== 'go' || session.gameId !== payload.gameId) return
          if (session.opponentPubkey !== sender || session.goState.phase !== 'scoring') return
          if (payload.seq <= session.seq) return
          const oppColor: GoColor = session.localColor === 'b' ? 'w' : 'b'
          const nextState = engineAcceptGoScore(session.goState, oppColor)
          updateGameSession(
            makeGoSession({
              ...session,
              seq: payload.seq,
              status: nextState.phase === 'finished' ? 'finished' : 'active',
              updatedAtMs: Date.now(),
              goState: nextState,
            }),
          )
          break
        }

        case 'game-scoring-resume': {
          if (!session || session.kind !== 'go' || session.gameId !== payload.gameId) return
          if (session.opponentPubkey !== sender || session.goState.phase !== 'scoring') return
          if (payload.seq <= session.seq) return
          const nextState = resumeGoFromScoring(session.goState)
          updateGameSession(
            makeGoSession({
              ...session,
              seq: payload.seq,
              status: 'active',
              updatedAtMs: Date.now(),
              goState: nextState,
            }),
          )
          break
        }

        case 'game-draw-offer': {
          if (!session || session.kind !== 'chess' || session.gameId !== payload.gameId) return
          if (session.opponentPubkey !== sender || session.status !== 'active') return
          const oppColor: ChessColor = session.localColor === 'w' ? 'b' : 'w'
          const nextState = applyChessDrawOffer(session.chessState, oppColor)
          updateGameSession(
            makeChessSession({
              ...session,
              updatedAtMs: Date.now(),
              chessState: nextState,
            }),
          )
          break
        }

        case 'game-draw-response': {
          if (!session || session.kind !== 'chess' || session.gameId !== payload.gameId) return
          if (session.opponentPubkey !== sender || session.status !== 'active') return
          const nextState = applyChessDrawResponse(session.chessState, payload.accept)
          updateGameSession(
            makeChessSession({
              ...session,
              status: nextState.status === 'finished' ? 'finished' : 'active',
              updatedAtMs: Date.now(),
              chessState: nextState,
            }),
          )
          break
        }

        case 'game-resign': {
          if (!session || session.kind === 'poker' || session.gameId !== payload.gameId) return
          if (session.opponentPubkey !== sender) return
          clearInviteTimer(session.gameId)
          if (session.kind === 'chess') {
            const oppColor: ChessColor = session.localColor === 'w' ? 'b' : 'w'
            const nextState = applyChessResign(session.chessState, oppColor)
            updateGameSession(
              makeChessSession({
                ...session,
                status: 'finished',
                updatedAtMs: Date.now(),
                chessState: nextState,
              }),
            )
          } else {
            const oppColor: GoColor = session.localColor === 'b' ? 'w' : 'b'
            const nextState = applyGoResign(session.goState, oppColor)
            updateGameSession(
              makeGoSession({
                ...session,
                status: 'finished',
                updatedAtMs: Date.now(),
                goState: nextState,
              }),
            )
          }
          break
        }

        case 'game-end': {
          endedGameIdsRef.current.add(payload.gameId)
          setIncomingInvites((prev) => {
            const next = prev.filter((i) => i.gameId !== payload.gameId)
            incomingInvitesRef.current = next
            return next
          })
          if (session && session.kind !== 'poker' && session.gameId === payload.gameId) {
            const oppName = session.opponentDisplayName
            removeGameSession(scopeKey)
            pushToastRef.current('info', 'Game ended', `${oppName} closed the board.`)
          }
          break
        }

        case 'game-sync-req': {
          if (!session || session.kind === 'poker' || session.gameId !== payload.gameId) return
          if (session.opponentPubkey !== sender || session.seq <= payload.lastSeq) return
          void publishDirectSignal(sender, {
            v: 1,
            type: 'game-sync-state',
            gameId: session.gameId,
            kind: session.kind,
            seq: session.seq,
            stateJson: session.stateJson,
            ts: Date.now(),
          })
          break
        }

        case 'game-sync-state': {
          if (!session || session.kind === 'poker' || session.gameId !== payload.gameId) return
          if (session.opponentPubkey !== sender || session.kind !== payload.kind) return
          if (payload.seq <= session.seq) return
          if (session.kind === 'chess') {
            const restored = deserializeChessState(payload.stateJson)
            if (!restored) return
            updateGameSession(
              makeChessSession({
                ...session,
                seq: payload.seq,
                status: restored.status === 'finished' ? 'finished' : 'active',
                updatedAtMs: Date.now(),
                chessState: restored,
              }),
            )
          } else {
            const restored = parseJsonSafe<unknown>(payload.stateJson)
            if (!isValidGoStateSnapshot(restored)) return
            updateGameSession(
              makeGoSession({
                ...session,
                seq: payload.seq,
                status: restored.phase === 'finished' ? 'finished' : 'active',
                updatedAtMs: Date.now(),
                goState: restored,
              }),
            )
          }
          break
        }

        default:
          break
      }
    },
    [clearInviteTimer, publishDirectSignal, removeGameSession, updateGameSession],
  )

  const handleRoomPokerPayload = useCallback(
    (scope: RoomGameScope, targetId: string, senderPubkey: string, payload: GameSignalPayload) => {
      const sender = senderPubkey.toLowerCase()
      if (blockedSetRef.current.has(sender)) return
      const cleanTarget = scope === 'geo' ? normalizeGeoTarget(targetId) : targetId.trim()
      const scopeKey = makeGameScopeKey(scope, cleanTarget)
      const session = activeGamesRef.current[scopeKey]

      switch (payload.type) {
        case 'poker-announce': {
          if (endedGameIdsRef.current.has(payload.tableId)) return
          if (payload.hostPubkey.toLowerCase() !== sender) return
          const ann: RoomPokerAnnouncement = {
            tableId: payload.tableId,
            scope,
            scopeKey,
            targetId: cleanTarget,
            hostPubkey: sender,
            hostDisplayName: payload.hostDisplayName,
            fixedBuyIn: payload.fixedBuyIn,
            smallBlind: payload.smallBlind,
            bigBlind: payload.bigBlind,
            seatedCount: payload.seatedCount,
            maxSeats: payload.maxSeats,
            phase: payload.phase,
            updatedAtMs: Date.now(),
          }
          setRoomPokerTables((prev) => {
            const next = { ...prev, [scopeKey]: ann }
            roomPokerTablesRef.current = next
            return next
          })
          break
        }

        case 'poker-state': {
          if (endedGameIdsRef.current.has(payload.tableId)) return
          if (!session || session.kind !== 'poker' || session.tableId !== payload.tableId) return
          if (session.isHost || session.hostPubkey.toLowerCase() !== sender) return
          if (payload.seq <= session.seq) return
          const parsed = parseJsonSafe<unknown>(payload.publicState)
          if (!isValidPokerPublicState(parsed) || parsed.tableId !== session.tableId) return

          const pendingHole = pendingHoleCardsRef.current.get(session.tableId)
          const holeMatchesHand =
            pendingHole && pendingHole.handNumber === parsed.handNumber ? pendingHole.cards : null
          const nextHoleCards =
            parsed.handNumber !== session.myHoleHandNumber
              ? holeMatchesHand
              : (session.myHoleCards ?? holeMatchesHand)

          updateGameSession(
            makePokerSession({
              ...session,
              seq: payload.seq,
              status: parsed.phase === 'finished' ? 'finished' : 'active',
              updatedAtMs: Date.now(),
              pokerState: parsed,
              myHoleCards: nextHoleCards,
              myHoleHandNumber: nextHoleCards ? parsed.handNumber : session.myHoleHandNumber,
            }),
          )
          break
        }

        case 'poker-join': {
          if (!session || session.kind !== 'poker' || !session.isHost) return
          if (session.tableId !== payload.tableId) return
          const seated = seatPokerPlayer(
            session.pokerState,
            sender,
            payload.displayName.trim() || getPeerNicknameRef.current?.(sender) || 'Player',
          )
          const nextState = seated ?? session.pokerState
          const nextSession = makePokerSession({
            ...session,
            seq: session.seq + 1,
            updatedAtMs: Date.now(),
            pokerState: nextState,
          })
          updateGameSession(nextSession)
          void broadcastHostPokerUpdate(nextSession)

          const priv = pokerPrivateStateRef.current.get(session.tableId)
          const existingHole = priv?.holeCards[sender]
          if (existingHole && nextState.handNumber > 0) {
            const roomMaterial = getMaterialForRoom(session.scope, session.targetId)
            const server =
              session.scope === 'server'
                ? serversRef.current.find((s) => s.id === session.targetId)
                : null
            const relays =
              session.scope === 'server' ? getRelaysForServerGame(server) : GAME_SIGNALING_RELAYS
            void publishDirectSignal(
              sender,
              {
                v: 1,
                type: 'poker-hole-cards',
                tableId: session.tableId,
                handNumber: nextState.handNumber,
                cards: existingHole,
                ts: Date.now(),
              },
              { material: roomMaterial, tag: POKER_HOLE_SIGNAL_TAG, relays },
            )
          }
          break
        }

        case 'poker-leave': {
          if (!session || session.kind !== 'poker' || !session.isHost) return
          if (session.tableId !== payload.tableId) return
          const updatedState = removePokerPlayer(session.pokerState, sender)
          const nextSession = makePokerSession({
            ...session,
            seq: session.seq + 1,
            status: updatedState.phase === 'finished' ? 'finished' : 'active',
            updatedAtMs: Date.now(),
            pokerState: updatedState,
          })
          updateGameSession(nextSession)
          void broadcastHostPokerUpdate(nextSession)
          break
        }

        case 'poker-action': {
          if (!session || session.kind !== 'poker' || !session.isHost) return
          if (session.tableId !== payload.tableId) return
          if (payload.handNumber !== session.pokerState.handNumber) return
          if (session.pokerState.actingPubkey?.toLowerCase() !== sender) return
          const priv = pokerPrivateStateRef.current.get(session.tableId)
          if (!priv) return
          const action = parseJsonSafe<PokerAction>(payload.action)
          if (!action || typeof action.type !== 'string') return
          const res = applyPokerAction(session.pokerState, priv, sender, action)
          if (!res) return
          pokerPrivateStateRef.current.set(session.tableId, res.privateState)
          const nextSession = makePokerSession({
            ...session,
            seq: session.seq + 1,
            status: res.publicState.phase === 'finished' ? 'finished' : 'active',
            updatedAtMs: Date.now(),
            pokerState: res.publicState,
          })
          updateGameSession(nextSession)
          void broadcastHostPokerUpdate(nextSession)
          break
        }

        case 'poker-end': {
          endedGameIdsRef.current.add(payload.tableId)
          const ann = roomPokerTablesRef.current[scopeKey]
          if (ann && ann.tableId === payload.tableId && ann.hostPubkey.toLowerCase() === sender) {
            setRoomPokerTables((prev) => {
              const next = { ...prev }
              delete next[scopeKey]
              roomPokerTablesRef.current = next
              return next
            })
          }
          if (
            session &&
            session.kind === 'poker' &&
            session.tableId === payload.tableId &&
            session.hostPubkey.toLowerCase() === sender
          ) {
            removeGameSession(scopeKey)
            pushToastRef.current('info', 'Poker table closed', 'The host ended the table.')
          }
          break
        }

        default:
          break
      }
    },
    [
      broadcastHostPokerUpdate,
      getMaterialForRoom,
      publishDirectSignal,
      removeGameSession,
      updateGameSession,
    ],
  )

  /* ------------------------------------------------------------------------
     Nostr Relay Subscriptions (KIND_GAME_SIGNAL = 25055)
     ------------------------------------------------------------------------ */
  // 1. Master Direct Subscription (DM Chess/Go + Group Poker private hole cards)
  useEffect(() => {
    if (!pool || !masterPubkey) return
    const subId = `game-direct:${masterPubkey.slice(0, 10)}`
    const since = Math.floor(Date.now() / 1000) - 30

    const unsub = pool.subscribe(
      subId,
      gameSignalingRelays,
      [
        {
          kinds: [KIND_GAME_SIGNAL],
          '#p': [masterPubkey],
          '#t': [DM_GAME_SIGNAL_TAG, POKER_HOLE_SIGNAL_TAG],
          since,
        },
      ],
      {
        onEvent: (event) => {
          if (!rememberSeenEvent(event.id)) return
          const sender = event.pubkey.toLowerCase()
          if (sender === masterPubkey || blockedSetRef.current.has(sender)) return
          if (Math.abs(Math.floor(Date.now() / 1000) - event.created_at) > MAX_GAME_SIGNAL_AGE_SEC) {
            return
          }
          if (!verifyEventCached(event)) return

          void (async () => {
            const material = identityManager.getMasterKeyMaterial()
            const payload = await parseDirectGameSignalEvent(event, material)
            if (!payload) return
            handleDirectSignalPayload(sender, payload)
          })()
        },
      },
    )

    return () => {
      unsub()
    }
  }, [gameSignalingRelays, handleDirectSignalPayload, identityManager, masterPubkey, pool, rememberSeenEvent])

  const watchedGeoKeys = useMemo(() => {
    const keys = new Set<string>()
    if (activeGeohash && isValidBitchatChannelKey(activeGeohash)) {
      keys.add(normalizeGeoTarget(activeGeohash))
    }
    for (const g of Object.values(activeGamesByScope)) {
      if (g.kind === 'poker' && g.scope === 'geo') {
        keys.add(normalizeGeoTarget(g.targetId))
      }
    }
    return Array.from(keys).sort()
  }, [activeGeohash, activeGamesByScope])

  const watchedGeoKeySig = watchedGeoKeys.join('|')

  // 2. Bitchat Derived-Key Private Hole-Cards Subscription
  useEffect(() => {
    if (!pool || !watchedGeoKeySig) return
    void identityVersion
    const keys = watchedGeoKeySig.split('|').filter(Boolean)
    const pubkeyToMaterial = new Map<string, SigningKeyMaterial>()
    for (const geoKey of keys) {
      const mat = identityManager.getDerivedGeohashKeyMaterial(geoKey)
      pubkeyToMaterial.set(mat.pubkey.toLowerCase(), mat)
    }
    const derivedPubkeys = Array.from(pubkeyToMaterial.keys())
    if (derivedPubkeys.length === 0) return

    const subId = `game-geo-hole:${derivedPubkeys[0].slice(0, 8)}:${derivedPubkeys.length}`
    const since = Math.floor(Date.now() / 1000) - 30

    const unsub = pool.subscribe(
      subId,
      [...GAME_SIGNALING_RELAYS],
      [
        {
          kinds: [KIND_GAME_SIGNAL],
          '#p': derivedPubkeys,
          '#t': [POKER_HOLE_SIGNAL_TAG],
          since,
        },
      ],
      {
        onEvent: (event) => {
          if (!rememberSeenEvent(event.id)) return
          const sender = event.pubkey.toLowerCase()
          if (blockedSetRef.current.has(sender)) return
          if (Math.abs(Math.floor(Date.now() / 1000) - event.created_at) > MAX_GAME_SIGNAL_AGE_SEC) {
            return
          }
          if (!verifyEventCached(event)) return

          let recipientMat: SigningKeyMaterial | undefined
          for (const tag of event.tags) {
            if (tag[0] === 'p' && tag[1]) {
              const found = pubkeyToMaterial.get(tag[1].toLowerCase())
              if (found) {
                recipientMat = found
                break
              }
            }
          }
          if (!recipientMat || sender === recipientMat.pubkey.toLowerCase()) return

          void (async () => {
            const payload = await parseDirectGameSignalEvent(event, recipientMat)
            if (!payload) return
            handleDirectSignalPayload(sender, payload)
          })()
        },
      },
    )

    return () => {
      unsub()
    }
  }, [
    handleDirectSignalPayload,
    identityManager,
    identityVersion,
    pool,
    rememberSeenEvent,
    watchedGeoKeySig,
  ])

  // 3. Bitchat Channel Poker Room Subscription
  useEffect(() => {
    if (!pool || !watchedGeoKeySig) return
    const keys = watchedGeoKeySig.split('|').filter(Boolean)
    const tagToGeo = new Map<string, string>()
    const tags: string[] = []
    for (const geoKey of keys) {
      const tag = getGeoGameRoomTag(geoKey)
      tagToGeo.set(tag, geoKey)
      tags.push(tag)
    }
    if (tags.length === 0) return

    const subId = `game-geo-rooms:${tags.length}:${tags[0].slice(-8)}`
    const since = Math.floor(Date.now() / 1000) - 35

    const unsub = pool.subscribe(
      subId,
      [...GAME_SIGNALING_RELAYS],
      [
        {
          kinds: [KIND_GAME_SIGNAL],
          '#t': tags,
          since,
        },
      ],
      {
        onEvent: (event) => {
          if (!rememberSeenEvent(event.id)) return
          const sender = event.pubkey.toLowerCase()
          if (blockedSetRef.current.has(sender)) return
          if (Math.abs(Math.floor(Date.now() / 1000) - event.created_at) > MAX_GAME_SIGNAL_AGE_SEC) {
            return
          }

          let matchedGeo: string | null = null
          for (const tag of event.tags) {
            if (tag[0] === 't' && tag[1]) {
              const found = tagToGeo.get(tag[1])
              if (found) {
                matchedGeo = found
                break
              }
            }
          }
          if (!matchedGeo) return

          const myGeoPk = identityManager
            .getDerivedGeohashKeyMaterial(matchedGeo)
            .pubkey.toLowerCase()
          if (sender === myGeoPk) return

          const payload = parseGeoGameSignalEvent(event)
          if (!payload) return
          handleRoomPokerPayload('geo', matchedGeo, sender, payload)
        },
      },
    )

    return () => {
      unsub()
    }
  }, [handleRoomPokerPayload, identityManager, pool, rememberSeenEvent, watchedGeoKeySig])

  // 4. Joined Groups Poker Room Subscription (AES-256-GCM decrypted when E2EE)
  const serverSig = useMemo(
    () => servers.map((s) => `${s.id}:${s.encrypted ? '1' : '0'}`).sort().join('|'),
    [servers],
  )

  useEffect(() => {
    if (!pool || !serverSig) return
    const currentServers = serversRef.current
    const tagToServer = new Map<string, ServerSummary>()
    const roomTags: string[] = []
    for (const srv of currentServers) {
      const tag = getServerGameRoomTag(srv.id)
      tagToServer.set(tag, srv)
      roomTags.push(tag)
    }
    if (roomTags.length === 0) return

    const subId = `game-srv-rooms:${roomTags.length}`
    const since = Math.floor(Date.now() / 1000) - 35

    const unsub = pool.subscribe(
      subId,
      gameSignalingRelays,
      [
        {
          kinds: [KIND_GAME_SIGNAL],
          '#t': roomTags,
          since,
        },
      ],
      {
        onEvent: (event) => {
          if (!rememberSeenEvent(event.id)) return
          const sender = event.pubkey.toLowerCase()
          if (sender === masterPubkey || blockedSetRef.current.has(sender)) return
          if (Math.abs(Math.floor(Date.now() / 1000) - event.created_at) > MAX_GAME_SIGNAL_AGE_SEC) {
            return
          }

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
          void (async () => {
            const payload = await parseServerGameSignalEvent(event, srv)
            if (!payload) return
            handleRoomPokerPayload('server', srv.id, sender, payload)
          })()
        },
      },
    )

    return () => {
      unsub()
    }
  }, [gameSignalingRelays, handleRoomPokerPayload, masterPubkey, pool, rememberSeenEvent, serverSig])

  /* ------------------------------------------------------------------------
     Periodic Host Poker Announcements (6s) & Stale Room Poker Sweep (22s TTL)
     ------------------------------------------------------------------------ */
  useEffect(() => {
    const announceTimer = window.setInterval(() => {
      const sessions = Object.values(activeGamesRef.current)
      for (const s of sessions) {
        if (s.kind === 'poker' && s.isHost && s.status === 'active') {
          void publishRoomSignal(s.scope, s.targetId, buildPokerAnnouncementPayload(s))
          setRoomPokerTables((prev) => {
            const existing = prev[s.scopeKey]
            if (!existing || existing.tableId !== s.tableId) return prev
            const updated: RoomPokerAnnouncement = {
              ...existing,
              seatedCount: s.pokerState.seats.length,
              phase: s.pokerState.phase,
              updatedAtMs: Date.now(),
            }
            const next = { ...prev, [s.scopeKey]: updated }
            roomPokerTablesRef.current = next
            return next
          })
        }
      }
    }, POKER_ANNOUNCE_INTERVAL_MS)

    const sweepTimer = window.setInterval(() => {
      const now = Date.now()
      setRoomPokerTables((prev) => {
        let changed = false
        const next: Record<GameScopeKey, RoomPokerAnnouncement> = {}
        for (const [k, ann] of Object.entries(prev)) {
          const ownHosted = activeGamesRef.current[k]
          const isOwnHost =
            ownHosted?.kind === 'poker' && ownHosted.isHost && ownHosted.tableId === ann.tableId
          if (isOwnHost || now - ann.updatedAtMs <= ROOM_POKER_TTL_MS) {
            next[k] = ann
          } else {
            changed = true
          }
        }
        if (!changed) return prev
        roomPokerTablesRef.current = next
        return next
      })
    }, ROOM_POKER_SWEEP_MS)

    return () => {
      window.clearInterval(announceTimer)
      window.clearInterval(sweepTimer)
    }
  }, [buildPokerAnnouncementPayload, publishRoomSignal])

  /* ------------------------------------------------------------------------
     Cleanup & Reset (Profile Switches / Panic Wipe)
     ------------------------------------------------------------------------ */
  const resetAllGames = useCallback(() => {
    for (const timers of inviteTimersRef.current.values()) {
      window.clearInterval(timers.intervalId)
      window.clearTimeout(timers.timeoutId)
    }
    inviteTimersRef.current.clear()
    pokerPrivateStateRef.current.clear()
    pendingHoleCardsRef.current.clear()
    seenEventIdsRef.current.clear()
    endedGameIdsRef.current.clear()
    activeGamesRef.current = {}
    incomingInvitesRef.current = []
    roomPokerTablesRef.current = {}
    focusedScopeKeyRef.current = null
    setActiveGamesByScope({})
    setIncomingInvites([])
    setRoomPokerTables({})
    setFocusedScopeKey(null)
    setMinimized(false)
  }, [])

  useEffect(() => {
    const timersMap = inviteTimersRef.current
    return () => {
      for (const timers of timersMap.values()) {
        window.clearInterval(timers.intervalId)
        window.clearTimeout(timers.timeoutId)
      }
      timersMap.clear()
    }
  }, [])

  const focusGame = useCallback((scopeKey: GameScopeKey) => {
    setFocusedScopeKey(scopeKey)
    setMinimized(false)
  }, [])

  const minimizeGame = useCallback(() => {
    setMinimized(true)
  }, [])

  const getActiveGameForScope = useCallback(
    (scope: GameScope, targetId: string): LiveGameSession | null => {
      const clean = scope === 'geo' ? normalizeGeoTarget(targetId) : targetId
      const key = makeGameScopeKey(scope, clean)
      return activeGamesByScope[key] ?? null
    },
    [activeGamesByScope],
  )

  const getIncomingInviteForPeer = useCallback(
    (peerPubkey: string): IncomingGameInvite | null => {
      const key = makeGameScopeKey('dm', peerPubkey)
      return incomingInvites.find((i) => i.scopeKey === key) ?? null
    },
    [incomingInvites],
  )

  const getRoomPokerTable = useCallback(
    (scope: RoomGameScope, targetId: string): RoomPokerAnnouncement | null => {
      const clean = scope === 'geo' ? normalizeGeoTarget(targetId) : targetId
      const key = makeGameScopeKey(scope, clean)
      return roomPokerTables[key] ?? null
    },
    [roomPokerTables],
  )

  const games = useMemo<GameEngineController>(
    () => ({
      activeGamesByScope,
      incomingInvites,
      roomPokerTables,
      focusedScopeKey,
      minimized,
      setFocusedScopeKey,
      setMinimized,
      focusGame,
      minimizeGame,
      // GameEngine canonical interface (consumed by GameStage.tsx)
      startChessGame: startDmChess,
      startGoGame: startDmGo,
      acceptGameInvite,
      declineGameInvite,
      makeChessMove: playChessMove,
      makeGoMove: playGoMove,
      toggleGoDeadStone,
      acceptGoScore,
      resumeGoGame: resumeGoScoring,
      offerDraw: offerChessDraw,
      respondDrawOffer: respondChessDraw,
      resignGame,
      endGame: closeGame,
      createPokerTable,
      joinPokerTable,
      leavePokerTable,
      startPokerHand,
      sendPokerAction: playPokerAction,
      endPokerTable,
      // Convenience & explicit #1106 method aliases
      startDmChess,
      startDmGo,
      acceptInvite,
      declineInvite,
      playChessMove,
      offerChessDraw,
      respondChessDraw,
      playGoMove,
      resumeGoScoring,
      closeGame,
      startPokerTable,
      sitInPokerTable,
      playPokerAction,
      getActiveGameForScope,
      getIncomingInviteForPeer,
      getRoomPokerTable,
    }),
    [
      activeGamesByScope,
      incomingInvites,
      roomPokerTables,
      focusedScopeKey,
      minimized,
      focusGame,
      minimizeGame,
      startDmChess,
      startDmGo,
      acceptGameInvite,
      declineGameInvite,
      acceptInvite,
      declineInvite,
      playChessMove,
      offerChessDraw,
      respondChessDraw,
      playGoMove,
      toggleGoDeadStone,
      acceptGoScore,
      resumeGoScoring,
      resignGame,
      closeGame,
      createPokerTable,
      startPokerTable,
      joinPokerTable,
      sitInPokerTable,
      leavePokerTable,
      startPokerHand,
      playPokerAction,
      endPokerTable,
      getActiveGameForScope,
      getIncomingInviteForPeer,
      getRoomPokerTable,
    ],
  )

  return {
    games,
    gameSignalingRelays,
    resetAllGames,
  }
}

export default useGameEngine
