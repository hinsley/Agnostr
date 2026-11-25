export type GameScope = 'dm' | 'geo' | 'server'

export type GameKind = 'chess' | 'go' | 'poker'

export type DmGameKind = 'chess' | 'go'

export type RoomGameScope = 'geo' | 'server'

export type GameScopeKey = string

export type ColorPreference = 'first' | 'second' | 'random'

export type ChessPieceColor = 'w' | 'b'

export type GoStoneColor = 'b' | 'w'

export type GoBoardDimension = 9 | 13 | 19

export type GoScoringMode = 'chinese' | 'japanese'

export type PokerCardSuit = 's' | 'h' | 'd' | 'c'

export type PokerCardRank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14

export interface PokerWireCard {
  rank: PokerCardRank
  suit: PokerCardSuit
}

export type PokerGamePhase =
  | 'lobby'
  | 'preflop'
  | 'flop'
  | 'turn'
  | 'river'
  | 'showdown'
  | 'finished'

export type PokerWireActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all-in'

export interface PokerWireAction {
  type: PokerWireActionType
  amount?: number
}

export interface ChessWireMove {
  from: number
  to: number
  promotion?: 'q' | 'r' | 'b' | 'n'
}

export type GoWireMove = { type: 'play'; row: number; col: number } | { type: 'pass' }

export interface GoGameConfig {
  boardSize: GoBoardDimension
  komi: number
  handicap: number
  scoring: GoScoringMode
}

export interface GoSetupOptions extends GoGameConfig {
  colorPref: GoStoneColor | 'random'
}

export interface ChessSetupOptions {
  colorPref: ChessPieceColor | 'random'
}

export interface PokerSetupOptions {
  fixedBuyIn: number
  maxSeats: number
}

const DM_ALLOWED_GAMES: readonly GameKind[] = ['go', 'chess']
const ROOM_ALLOWED_GAMES: readonly GameKind[] = ['poker']

/**
 * Enforces context-scoped game availability:
 * - People (1-on-1 DMs): Go & Chess ONLY (never Poker)
 * - Bitchat channels & Groups: Poker ONLY (never Go/Chess)
 */
export function getAllowedGamesForScope(scope: GameScope): readonly GameKind[] {
  if (scope === 'dm') return DM_ALLOWED_GAMES
  return ROOM_ALLOWED_GAMES
}

export function isGameAllowedInScope(scope: GameScope, kind: GameKind): boolean {
  return getAllowedGamesForScope(scope).includes(kind)
}

/**
 * Canonical per-channel / per-person / per-group scope key guaranteeing
 * strictly 1 active game at a time in each context.
 */
export function makeGameScopeKey(scope: GameScope, targetId: string): GameScopeKey {
  const clean = targetId.trim()
  if (scope === 'dm') return `dm:${clean.toLowerCase()}`
  if (scope === 'geo') return `geo:${clean.replace(/^#+/, '').toLowerCase()}`
  return `server:${clean}`
}

export interface IncomingGameInvite {
  gameId: string
  kind: DmGameKind
  scopeKey: GameScopeKey
  fromPubkey: string
  fromDisplayName: string
  challengerColor: 'w' | 'b'
  goConfig?: GoGameConfig
  createdAtMs: number
}

export interface RoomPokerAnnouncement {
  tableId: string
  scope: RoomGameScope
  scopeKey: GameScopeKey
  targetId: string
  hostPubkey: string
  hostDisplayName: string
  fixedBuyIn: number
  smallBlind: number
  bigBlind: number
  seatedCount: number
  maxSeats: number
  phase: PokerGamePhase
  updatedAtMs: number
}

/* --------------------------------------------------------------------------
   Nostr Signaling Payload Discriminated Union (kind: 25055)
   -------------------------------------------------------------------------- */
export interface GameInviteSignal {
  v: 1
  type: 'game-invite'
  gameId: string
  kind: DmGameKind
  challengerColor: 'w' | 'b'
  displayName?: string
  goConfig?: GoGameConfig
  ts: number
}

export interface GameAcceptSignal {
  v: 1
  type: 'game-accept'
  gameId: string
  kind: DmGameKind
  displayName?: string
  ts: number
}

export interface GameDeclineSignal {
  v: 1
  type: 'game-decline'
  gameId: string
  reason?: string
  ts: number
}

export interface GameMoveSignal {
  v: 1
  type: 'game-move'
  gameId: string
  kind: DmGameKind
  seq: number
  /** Compact JSON-serialized ChessMove or GoMove */
  move: string
  ts: number
}

export interface GameScoringToggleSignal {
  v: 1
  type: 'game-scoring-toggle'
  gameId: string
  seq: number
  row: number
  col: number
  ts: number
}

export interface GameScoringAcceptSignal {
  v: 1
  type: 'game-scoring-accept'
  gameId: string
  seq: number
  ts: number
}

export interface GameScoringResumeSignal {
  v: 1
  type: 'game-scoring-resume'
  gameId: string
  seq: number
  ts: number
}

export interface GameDrawOfferSignal {
  v: 1
  type: 'game-draw-offer'
  gameId: string
  ts: number
}

export interface GameDrawResponseSignal {
  v: 1
  type: 'game-draw-response'
  gameId: string
  accept: boolean
  ts: number
}

export interface GameResignSignal {
  v: 1
  type: 'game-resign'
  gameId: string
  ts: number
}

export interface GameEndSignal {
  v: 1
  type: 'game-end'
  gameId: string
  reason?: string
  ts: number
}

export interface GameSyncReqSignal {
  v: 1
  type: 'game-sync-req'
  gameId: string
  lastSeq: number
  ts: number
}

export interface GameSyncStateSignal {
  v: 1
  type: 'game-sync-state'
  gameId: string
  kind: DmGameKind
  seq: number
  /** Compact JSON-serialized full ChessState or GoState */
  stateJson: string
  ts: number
}

export interface PokerAnnounceSignal {
  v: 1
  type: 'poker-announce'
  tableId: string
  scope: RoomGameScope
  targetId: string
  hostPubkey: string
  hostDisplayName: string
  fixedBuyIn: number
  smallBlind: number
  bigBlind: number
  seatedCount: number
  maxSeats: number
  phase: PokerGamePhase
  ts: number
}

export interface PokerStateSignal {
  v: 1
  type: 'poker-state'
  tableId: string
  seq: number
  /** Compact JSON-serialized PokerPublicState */
  publicState: string
  ts: number
}

export interface PokerJoinSignal {
  v: 1
  type: 'poker-join'
  tableId: string
  displayName: string
  ts: number
}

export interface PokerLeaveSignal {
  v: 1
  type: 'poker-leave'
  tableId: string
  ts: number
}

export interface PokerStartSignal {
  v: 1
  type: 'poker-start'
  tableId: string
  ts: number
}

export interface PokerActionSignal {
  v: 1
  type: 'poker-action'
  tableId: string
  handNumber: number
  /** Compact JSON-serialized PokerAction */
  action: string
  ts: number
}

export interface PokerEndSignal {
  v: 1
  type: 'poker-end'
  tableId: string
  reason?: string
  ts: number
}

/** Private NIP-44 encrypted direct message sent strictly to the seated player's pubkey */
export interface PokerHoleCardsSignal {
  v: 1
  type: 'poker-hole-cards'
  tableId: string
  handNumber: number
  cards: [PokerWireCard, PokerWireCard]
  ts: number
}

export type GameSignalPayload =
  | GameInviteSignal
  | GameAcceptSignal
  | GameDeclineSignal
  | GameMoveSignal
  | GameScoringToggleSignal
  | GameScoringAcceptSignal
  | GameScoringResumeSignal
  | GameDrawOfferSignal
  | GameDrawResponseSignal
  | GameResignSignal
  | GameEndSignal
  | GameSyncReqSignal
  | GameSyncStateSignal
  | PokerAnnounceSignal
  | PokerStateSignal
  | PokerJoinSignal
  | PokerLeaveSignal
  | PokerStartSignal
  | PokerActionSignal
  | PokerEndSignal
  | PokerHoleCardsSignal

/* --------------------------------------------------------------------------
   Active Game Session & Hook Engine Contract
   -------------------------------------------------------------------------- */
export type GameSessionStatus = 'inviting' | 'active' | 'finished'

export interface ActiveGameSessionBase {
  gameId: string
  kind: GameKind
  scope: GameScope
  scopeKey: GameScopeKey
  targetId: string
  title: string
  status: GameSessionStatus
  localPubkey: string
  seq: number
  createdAtMs: number
  updatedAtMs: number
}

export interface ActiveChessSession extends ActiveGameSessionBase {
  kind: 'chess'
  scope: 'dm'
  opponentPubkey: string
  opponentDisplayName: string
  localColor: ChessPieceColor
  /** Serialized or live ChessState managed by useGames */
  stateJson: string
}

export interface ActiveGoSession extends ActiveGameSessionBase {
  kind: 'go'
  scope: 'dm'
  opponentPubkey: string
  opponentDisplayName: string
  localColor: GoStoneColor
  goConfig: GoGameConfig
  /** Serialized or live GoState managed by useGames */
  stateJson: string
}

export interface ActivePokerSession extends ActiveGameSessionBase {
  kind: 'poker'
  scope: RoomGameScope
  tableId: string
  hostPubkey: string
  hostDisplayName: string
  isHost: boolean
  /** Serialized or live PokerPublicState managed by useGames */
  publicStateJson: string
  myHoleCards: [PokerWireCard, PokerWireCard] | null
  myHoleHandNumber: number
}

export type ActiveGameSession = ActiveChessSession | ActiveGoSession | ActivePokerSession

export interface GameEngine {
  activeGamesByScope: Record<GameScopeKey, ActiveGameSession>
  incomingInvites: IncomingGameInvite[]
  roomPokerTables: Record<GameScopeKey, RoomPokerAnnouncement>
  focusedScopeKey: GameScopeKey | null
  minimized: boolean
  setFocusedScopeKey: (scopeKey: GameScopeKey | null) => void
  setMinimized: (minimized: boolean) => void
  startChessGame: (
    peerPubkey: string,
    peerDisplayName: string,
    options: ChessSetupOptions,
  ) => Promise<boolean>
  startGoGame: (
    peerPubkey: string,
    peerDisplayName: string,
    options: GoSetupOptions,
  ) => Promise<boolean>
  acceptGameInvite: (gameId: string) => Promise<boolean>
  declineGameInvite: (gameId: string) => Promise<void>
  makeChessMove: (scopeKey: GameScopeKey, move: ChessWireMove) => Promise<boolean>
  makeGoMove: (scopeKey: GameScopeKey, move: GoWireMove) => Promise<boolean>
  toggleGoDeadStone: (scopeKey: GameScopeKey, row: number, col: number) => Promise<void>
  acceptGoScore: (scopeKey: GameScopeKey) => Promise<void>
  resumeGoGame: (scopeKey: GameScopeKey) => Promise<void>
  offerDraw: (scopeKey: GameScopeKey) => Promise<void>
  respondDrawOffer: (scopeKey: GameScopeKey, accept: boolean) => Promise<void>
  resignGame: (scopeKey: GameScopeKey) => Promise<void>
  endGame: (scopeKey: GameScopeKey) => Promise<void>
  createPokerTable: (
    scope: RoomGameScope,
    targetId: string,
    options: PokerSetupOptions,
  ) => Promise<boolean>
  joinPokerTable: (
    scope: RoomGameScope,
    targetId: string,
    tableId: string,
  ) => Promise<boolean>
  leavePokerTable: (scopeKey: GameScopeKey) => Promise<void>
  startPokerHand: (scopeKey: GameScopeKey) => Promise<boolean>
  sendPokerAction: (scopeKey: GameScopeKey, action: PokerWireAction) => Promise<boolean>
  endPokerTable: (scopeKey: GameScopeKey) => Promise<void>
}
