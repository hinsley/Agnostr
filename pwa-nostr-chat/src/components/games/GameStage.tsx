import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CircleDot,
  Crown,
  Gamepad2,
  Minimize2,
  Maximize2,
  Phone,
  Spade,
  X,
} from 'lucide-react'
import type { AgnostrEngine } from '../../types/protocol.ts'
import type {
  ActiveGameSession,
  GameEngine,
  GameKind,
} from '../../types/games.ts'
import { parseChessSessionState, parseGoSessionState, parsePokerSessionState } from './gameStageState'
import { formatBitchatChannelLabel } from '../../lib/bitchatChannel.ts'
import { useBackHandler } from '../../hooks/useBackNavigation.ts'
import type { SoundCue } from '../../utils/sound.ts'
import { ChessBoardView } from './ChessBoardView.tsx'
import { GoBoardView } from './GoBoardView.tsx'
import { PokerTableView } from './PokerTableView.tsx'

export interface GameStageProps {
  engine: AgnostrEngine
  games: GameEngine
  floatingDock?: HTMLElement | null
  chatDock?: HTMLElement | null
  roomTileDock?: HTMLElement | null
  modalOverRoomCall?: boolean
  onOpenInChat?: (session: ActiveGameSession, maximize?: boolean) => void
  compactCallDocks?: {
    video: (el: HTMLDivElement | null) => void
    controls: (el: HTMLDivElement | null) => void
  }
  onPlaySound?: (cue: SoundCue) => void
}

function formatScoreNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '')
}

function renderGameIcon(kind: GameKind, size = 15) {
  if (kind === 'chess') return <Crown size={size} />
  if (kind === 'go') return <CircleDot size={size} />
  if (kind === 'poker') return <Spade size={size} />
  return <Gamepad2 size={size} />
}

interface SessionDisplayMeta {
  title: string
  scopeLabel: string
  subtitle: string
  statusLabel: string
  headerStatus: string | null
  isMyTurn: boolean
  isFinished: boolean
  isWaiting: boolean
}

function computeSessionMeta(
  session: ActiveGameSession,
  engine: AgnostrEngine,
): SessionDisplayMeta {
  let scopeLabel = session.title
  if (session.scope === 'dm') {
    const clean = session.opponentDisplayName.trim() || 'Peer'
    scopeLabel = clean.startsWith('@') ? clean : `@${clean}`
  } else if (session.scope === 'geo') {
    scopeLabel = formatBitchatChannelLabel(session.targetId)
  } else {
    const srv = engine.servers.joinedServers.find((s) => s.id === session.targetId)
    scopeLabel = srv?.name || session.title || 'Group'
  }

  if (session.kind === 'chess') {
    const st = parseChessSessionState(session)
    const isWaiting = session.status === 'inviting'
    const isFinished = session.status === 'finished' || st.status === 'finished'
    const isMyTurn = !isWaiting && !isFinished && st.turn === session.localColor
    const statusLabel = isWaiting
      ? 'Invited'
      : isFinished
        ? 'Finished'
        : isMyTurn
          ? 'Your turn'
          : "Opponent's turn"
    const headerStatus = isWaiting
      ? 'Invited'
      : isFinished
        ? 'Finished'
        : isMyTurn
          ? 'Your turn'
          : null
    return {
      title: 'Chess',
      scopeLabel,
      subtitle: scopeLabel,
      statusLabel,
      headerStatus,
      isMyTurn,
      isFinished,
      isWaiting,
    }
  }

  if (session.kind === 'go') {
    const st = parseGoSessionState(session)
    const isWaiting = session.status === 'inviting'
    const isFinished = session.status === 'finished' || st.phase === 'finished'
    const isScoring = !isWaiting && !isFinished && st.phase === 'scoring'
    const isMyTurn =
      !isWaiting &&
      !isFinished &&
      ((st.phase === 'playing' && st.turn === session.localColor) ||
        (isScoring && !st.scoreAcceptedBy[session.localColor]))
    const statusLabel = isWaiting
      ? 'Invited'
      : isFinished
        ? 'Finished'
        : isScoring
          ? 'Scoring'
          : isMyTurn
            ? 'Your turn'
            : "Opponent's turn"
    const headerStatus = isWaiting
      ? 'Invited'
      : isFinished
        ? 'Finished'
        : isScoring
          ? 'Scoring'
          : isMyTurn
            ? 'Your turn'
            : null
    const rulesLabel = session.goConfig.scoring === 'chinese' ? 'Chinese' : 'Japanese'
    const goMeta = `Komi ${formatScoreNum(session.goConfig.komi)}${
      session.goConfig.handicap >= 2 ? ` · H${session.goConfig.handicap}` : ''
    } · ${rulesLabel}`
    return {
      title: `Go ${session.goConfig.boardSize}×${session.goConfig.boardSize}`,
      scopeLabel,
      subtitle: `${scopeLabel} · ${goMeta}`,
      statusLabel,
      headerStatus,
      isMyTurn,
      isFinished,
      isWaiting,
    }
  }

  const pkState = parsePokerSessionState(session)
  const localPk = session.localPubkey.trim().toLowerCase()
  const isFinished = session.status === 'finished' || pkState?.phase === 'finished'
  const isLive = Boolean(
    pkState &&
      (pkState.phase === 'preflop' ||
        pkState.phase === 'flop' ||
        pkState.phase === 'turn' ||
        pkState.phase === 'river'),
  )
  const isMyTurn = Boolean(
    !isFinished && isLive && pkState?.actingPubkey?.toLowerCase() === localPk,
  )
  const statusLabel = isFinished
    ? 'Finished'
    : !pkState
      ? 'Connecting…'
      : pkState.phase === 'lobby'
        ? `Lobby · ${pkState.seats.length}/${pkState.maxSeats}`
        : pkState.phase === 'showdown'
          ? 'Showdown'
          : isMyTurn
            ? 'Your turn'
            : `Hand #${pkState.handNumber}`
  const headerStatus = isFinished
    ? 'Finished'
    : !pkState
      ? 'Connecting…'
      : pkState.phase === 'showdown'
        ? 'Showdown'
        : isMyTurn
          ? 'Your turn'
          : null
  const subtitle = pkState
    ? `${scopeLabel} · ${pkState.smallBlind}/${pkState.bigBlind}`
    : scopeLabel
  return {
    title: "Texas Hold'em",
    scopeLabel,
    subtitle,
    statusLabel,
    headerStatus,
    isMyTurn,
    isFinished,
    isWaiting: false,
  }
}

export function GameStage({
  engine,
  games,
  floatingDock,
  chatDock,
  roomTileDock,
  modalOverRoomCall,
  onOpenInChat,
  compactCallDocks,
  onPlaySound,
}: GameStageProps) {
  const [confirmClose, setConfirmClose] = useState(false)

  const allSessions = useMemo(
    () => Object.values(games.activeGamesByScope),
    [games.activeGamesByScope],
  )

  const focusedSession = games.focusedScopeKey ? games.activeGamesByScope[games.focusedScopeKey] : null
  const inRoomTile = roomTileDock !== undefined
  const compact = inRoomTile || games.minimized
  // A compact board belongs to the chat layout or a matching call tile, never a floating window.
  const boardTarget = inRoomTile ? roomTileDock
    : !chatDock || compact ? chatDock
      : typeof document !== 'undefined' ? document.body : null
  const showBoard = Boolean(focusedSession && boardTarget)
  const activeCall = engine.calls.activeCall

  // Prioritize a session where it's your turn when minimized across multiple active scopes
  const pillSessions = useMemo(() => {
    const ranked = allSessions.filter((s) => !(showBoard || inRoomTile) || s.scopeKey !== games.focusedScopeKey).map((s) => ({
      session: s,
      meta: computeSessionMeta(s, engine),
    }))
    ranked.sort((a, b) => {
      if (a.meta.isMyTurn !== b.meta.isMyTurn) return a.meta.isMyTurn ? -1 : 1
      if (a.session.scopeKey === games.focusedScopeKey) return -1
      if (b.session.scopeKey === games.focusedScopeKey) return 1
      return b.session.updatedAtMs - a.session.updatedAtMs
    })
    return ranked
  }, [showBoard, inRoomTile, allSessions, engine, games.focusedScopeKey])

  // Reset close confirmation when switching/minimizing sessions
  const focusedKey = focusedSession?.scopeKey ?? null
  useEffect(() => {
    setConfirmClose(false)
  }, [focusedKey, showBoard, compact])

  // Prefetch kind:0 profile pictures for local user, DM opponent, and all seated Poker players
  const focusedPokerSeatPubkeysKey = useMemo(() => {
    if (!focusedSession || focusedSession.kind !== 'poker') return ''
    const pkState = parsePokerSessionState(focusedSession)
    if (!pkState) return ''
    return pkState.seats
      .map((s) => s.pubkey.trim().toLowerCase())
      .filter(Boolean)
      .sort()
      .join(',')
  }, [focusedSession])

  const hasFocusedSession = Boolean(focusedSession)
  const myMasterPubkey = engine.identity.masterPubkey
  const focusedOpponentPubkey =
    focusedSession && focusedSession.scope === 'dm' ? focusedSession.opponentPubkey : null
  const ensureProfilePictures = engine.ensureProfilePictures

  useEffect(() => {
    if (!hasFocusedSession) return
    const pks: string[] = []
    if (myMasterPubkey) pks.push(myMasterPubkey)
    if (focusedOpponentPubkey) pks.push(focusedOpponentPubkey)
    if (focusedPokerSeatPubkeysKey) {
      for (const pk of focusedPokerSeatPubkeysKey.split(',')) {
        if (pk) pks.push(pk)
      }
    }
    if (pks.length > 0) {
      ensureProfilePictures(pks)
    }
  }, [
    hasFocusedSession,
    myMasterPubkey,
    focusedOpponentPubkey,
    focusedPokerSeatPubkeysKey,
    ensureProfilePictures,
  ])

  // Back/Escape dismiss the expanded dialog to the dock, never dismiss the dock itself.
  useBackHandler(showBoard && !compact, () => games.setMinimized(true))

  useEffect(() => {
    if (!showBoard || compact) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        onPlaySound?.('click')
        games.setMinimized(true)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [showBoard, compact, games, onPlaySound])

  if (typeof document === 'undefined') return null

  const myDisplayName =
    engine.identity.nickname.trim() || engine.identity.activeDisplayHandle || 'You'
  const myAvatarUrl = myMasterPubkey ? engine.getProfilePicture(myMasterPubkey) : undefined

  // Use the original centered game dialog when expanded; only compact play shares chat space.
  let visibleBoard: React.ReactNode = null
  if (showBoard && focusedSession) {
    const meta = computeSessionMeta(focusedSession, engine)
    const watchingPoker = focusedSession.kind === 'poker' &&
      !parsePokerSessionState(focusedSession)?.seats.some((seat) => seat.pubkey === focusedSession.localPubkey)

    const handleResize = () => {
      onPlaySound?.('click')
      if (compact && !chatDock) onOpenInChat?.(focusedSession, true)
      else games.setMinimized(!compact)
    }

    const handleCloseImmediate = () => {
      onPlaySound?.('click')
      setConfirmClose(false)
      if (focusedSession.kind === 'poker') {
        void games.leavePokerTable(focusedSession.scopeKey)
      } else {
        void games.endGame(focusedSession.scopeKey)
      }
    }

    const handleStartQuickVoiceCall = () => {
      onPlaySound?.('click')
      if (focusedSession.scope === 'dm') {
        void engine.calls.startDmCall(
          focusedSession.opponentPubkey,
          'audio',
          focusedSession.opponentDisplayName,
        )
      } else if (focusedSession.scope === 'geo') {
        void engine.calls.joinGeoCall(focusedSession.targetId, 'audio')
      } else {
        void engine.calls.joinServerCall(focusedSession.targetId, 'audio')
      }
    }

    let boardBody: React.ReactNode = null
    if (focusedSession.kind === 'chess') {
      const chessState = parseChessSessionState(focusedSession)
      boardBody = (
        <ChessBoardView
          state={chessState}
          myColor={focusedSession.localColor}
          myDisplayName={myDisplayName}
          myPubkey={myMasterPubkey}
          myAvatarUrl={myAvatarUrl}
          opponentDisplayName={focusedSession.opponentDisplayName}
          opponentPubkey={focusedSession.opponentPubkey}
          opponentAvatarUrl={engine.getProfilePicture(focusedSession.opponentPubkey)}
          waitingForOpponent={focusedSession.status === 'inviting'}
          onMove={(move) => {
            onPlaySound?.('click')
            void games.makeChessMove(focusedSession.scopeKey, move)
          }}
          onOfferDraw={() => {
            onPlaySound?.('click')
            void games.offerDraw(focusedSession.scopeKey)
          }}
          onRespondDraw={(accept) => {
            onPlaySound?.('click')
            void games.respondDrawOffer(focusedSession.scopeKey, accept)
          }}
          onResign={() => {
            onPlaySound?.('click')
            void games.resignGame(focusedSession.scopeKey)
          }}
        />
      )
    } else if (focusedSession.kind === 'go') {
      const goState = parseGoSessionState(focusedSession)
      boardBody = (
        <GoBoardView
          state={goState}
          myColor={focusedSession.localColor}
          myDisplayName={myDisplayName}
          myPubkey={myMasterPubkey}
          myAvatarUrl={myAvatarUrl}
          opponentDisplayName={focusedSession.opponentDisplayName}
          opponentPubkey={focusedSession.opponentPubkey}
          opponentAvatarUrl={engine.getProfilePicture(focusedSession.opponentPubkey)}
          waitingForOpponent={focusedSession.status === 'inviting'}
          onPlayMove={(move) => {
            onPlaySound?.('click')
            void games.makeGoMove(focusedSession.scopeKey, move)
          }}
          onToggleDeadGroup={(row, col) => {
            onPlaySound?.('click')
            void games.toggleGoDeadStone(focusedSession.scopeKey, row, col)
          }}
          onAcceptScore={() => {
            onPlaySound?.('click')
            void games.acceptGoScore(focusedSession.scopeKey)
          }}
          onResumeScoring={() => {
            onPlaySound?.('click')
            void games.resumeGoGame(focusedSession.scopeKey)
          }}
          onResign={() => {
            onPlaySound?.('click')
            void games.resignGame(focusedSession.scopeKey)
          }}
        />
      )
    } else {
      const pokerState = parsePokerSessionState(focusedSession)
      const myHoleCards =
        pokerState &&
        !watchingPoker &&
        focusedSession.myHoleCards &&
        focusedSession.myHoleHandNumber === pokerState.handNumber
          ? focusedSession.myHoleCards
          : null

      boardBody = pokerState ? (
        <PokerTableView
          compact={compact}
          state={pokerState}
          myPubkey={focusedSession.localPubkey}
          myHoleCards={myHoleCards}
          isHost={focusedSession.isHost}
          getAvatarUrl={(pk) =>
            engine.getProfilePicture(pk) ??
            (pk.trim().toLowerCase() === focusedSession.localPubkey.trim().toLowerCase()
              ? myAvatarUrl
              : undefined)
          }
          onJoinSeat={() => {
            onPlaySound?.('click')
            void games.joinPokerTable(
              focusedSession.scope,
              focusedSession.targetId,
              focusedSession.tableId,
            )
          }}
          onLeaveSeat={() => {
            onPlaySound?.('click')
            void games.leavePokerTable(focusedSession.scopeKey)
          }}
          onStartHand={() => {
            onPlaySound?.('click')
            void games.startPokerHand(focusedSession.scopeKey)
          }}
          onAction={(action) => {
            onPlaySound?.('click')
            void games.sendPokerAction(focusedSession.scopeKey, action)
          }}
          myVoteTargets={focusedSession.myVoteTargets ?? []}
          onVoteOut={(target) => { void games.voteOutPokerPlayer(focusedSession.scopeKey, target) }}
        />
      ) : (
        <div className="ag-game-loading-state">Syncing table state…</div>
      )
    }

    const board = (
      <section key={focusedSession.gameId}
        className={`ag-game-stage-panel is-${focusedSession.kind} ${compact
          ? `is-compact ${inRoomTile ? 'ag-game-in-call' : 'ag-game-in-chat'}` : 'ag-game-modal-frame'}`}
        role={compact ? 'region' : 'dialog'}
        aria-modal={compact ? undefined : true}
        aria-label={`${meta.title} · ${meta.scopeLabel}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ag-game-stage-head">
          <div className="ag-game-stage-head-left">
            <span className="ag-game-stage-icon" aria-hidden="true">
              {renderGameIcon(focusedSession.kind, 14)}
            </span>
            <span className="ag-game-stage-title truncate">{meta.title}</span>
            <span
              className="ag-game-scope-pill ag-game-stage-sub mono truncate"
              title={meta.subtitle}
            >
              {meta.subtitle}
            </span>
          </div>

          <div className="ag-game-stage-head-actions">
            {watchingPoker && !meta.isFinished && <span className="ag-game-status-pill">Watching</span>}
            {meta.headerStatus && (
              <span
                className={`ag-game-status-pill${meta.isMyTurn ? ' is-my-turn' : ''}${
                  meta.isFinished ? ' is-finished' : ''
                }${meta.isWaiting ? ' is-waiting' : ''}`}
              >
                {meta.isMyTurn && <span className="ag-game-mini-turn-dot" aria-hidden="true" />}
                <span>{meta.headerStatus}</span>
              </span>
            )}

            {!activeCall && (
              <button
                type="button"
                className="ag-game-head-btn icon-only"
                onClick={handleStartQuickVoiceCall}
                title={`Start voice call in ${meta.scopeLabel}`}
                aria-label={`Start voice call in ${meta.scopeLabel}`}
              >
                <Phone size={14} />
              </button>
            )}

            <button
              type="button"
              className="ag-game-head-btn icon-only"
              onClick={handleResize}
              title={compact ? 'Expand game' : 'Minimize game'}
              aria-label={compact ? 'Expand game' : 'Minimize game'}
            >
              {compact ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
            </button>

            {confirmClose && !meta.isFinished ? (
              <div className="ag-game-close-confirm">
                <button
                  type="button"
                  className="ag-game-head-btn is-danger"
                  onClick={handleCloseImmediate}
                >
                  {focusedSession.kind === 'poker' ? 'Leave table' : 'End'}
                </button>
                <button
                  type="button"
                  className="ag-game-head-btn"
                  onClick={() => setConfirmClose(false)}
                >
                  Keep
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="ag-game-head-btn icon-only"
                onClick={() => {
                  if (meta.isFinished || watchingPoker) {
                    handleCloseImmediate()
                  } else {
                    onPlaySound?.('click')
                    setConfirmClose(true)
                  }
                }}
                title={
                  meta.isFinished || watchingPoker
                    ? 'Close game'
                    : focusedSession.kind === 'poker'
                      ? 'Leave table'
                      : 'End game'
                }
                aria-label={meta.isFinished || watchingPoker ? 'Close game' : focusedSession.kind === 'poker' ? 'Leave table' : 'End game'}
              >
                <X size={15} />
              </button>
            )}
          </div>
        </header>

        {compactCallDocks && (
          <div className="ag-game-compact-media">
            <div className="ag-game-video-dock" ref={compactCallDocks.video} />
            <div className="ag-game-compact-call-controls" ref={compactCallDocks.controls} />
          </div>
        )}
        <div className="ag-game-stage-body">{boardBody}</div>
      </section>
    )
    if (boardTarget) {
      visibleBoard = createPortal(compact ? board : (
        <div className={`ag-game-modal-backdrop${modalOverRoomCall ? ' is-over-room-call' : ''}`}
          role="presentation" onClick={handleResize}>
          {board}
        </div>
      ), boardTarget, 'game-board')
    }
  }

  if (floatingDock && pillSessions.length) {
    return <>{visibleBoard}{createPortal(
      <div className="ag-game-dock-list" aria-label="Background games" role="region">
        {pillSessions.map(({ session: pillSession, meta }) => (
          <div
            key={pillSession.scopeKey}
            className={`ag-game-mini-pill${meta.isMyTurn ? ' is-my-turn' : ''}${
              meta.isFinished ? ' is-finished' : ''
            }`}
            role="region"
            aria-label={`Background game: ${meta.title} (${meta.scopeLabel})`}
          >
            <button
              type="button"
              className="ag-game-mini-main"
              onClick={() => {
                onPlaySound?.('click')
                onOpenInChat?.(pillSession)
              }}
              title={`Resume ${meta.title} · ${meta.scopeLabel}`}
            >
              <span className="ag-game-mini-icon" aria-hidden="true">
                {renderGameIcon(pillSession.kind, 14)}
              </span>
              <span className="ag-game-mini-copy">
                <span className="ag-game-mini-title-row">
                  <span className="ag-game-mini-title truncate">{meta.title}</span>
                  <span className="ag-game-mini-scope mono truncate">{meta.scopeLabel}</span>
                </span>
                <span className="ag-game-mini-meta">
                  {meta.isMyTurn && <span className="ag-game-mini-turn-dot" aria-hidden="true" />}
                  <span>{meta.isMyTurn ? 'Your turn' : meta.statusLabel}</span>
                </span>
              </span>
            </button>

            {meta.isFinished && (
              <button
                type="button"
                className="ag-game-mini-dismiss"
                onClick={(e) => {
                  e.stopPropagation()
                  onPlaySound?.('click')
                  if (pillSession.kind === 'poker') {
                    void games.leavePokerTable(pillSession.scopeKey)
                  } else {
                    void games.endGame(pillSession.scopeKey)
                  }
                }}
                title="Dismiss finished game"
                aria-label="Dismiss finished game"
              >
                <X size={13} />
              </button>
            )}
          </div>
        ))}
      </div>,
      floatingDock,
    )}</>
  }

  return visibleBoard
}

export default GameStage
