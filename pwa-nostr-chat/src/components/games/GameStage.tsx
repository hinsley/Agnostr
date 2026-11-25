import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CircleDot,
  Crown,
  Gamepad2,
  Mic,
  MicOff,
  Minimize2,
  Phone,
  PhoneCall,
  Spade,
  X,
} from 'lucide-react'
import type { AgnostrEngine } from '../../types/protocol.ts'
import type {
  ActiveChessSession,
  ActiveGameSession,
  ActiveGoSession,
  ActivePokerSession,
  GameEngine,
  GameKind,
} from '../../types/games.ts'
import {
  createInitialChessState,
  deserializeChessState,
  type ChessState,
} from '../../lib/games/chessEngine.ts'
import { createInitialGoState, type GoState } from '../../lib/games/goEngine.ts'
import type { PokerPublicState } from '../../lib/games/pokerEngine.ts'
import { formatBitchatChannelLabel } from '../../lib/bitchatChannel.ts'
import { useBackHandler } from '../../hooks/useBackNavigation.ts'
import type { SoundCue } from '../../utils/sound.ts'
import { ChessBoardView } from './ChessBoardView.tsx'
import { GoBoardView } from './GoBoardView.tsx'
import { PokerTableView } from './PokerTableView.tsx'

export interface GameStageProps {
  engine: AgnostrEngine
  games: GameEngine
  onFocusCall?: () => void
  onPlaySound?: (cue: SoundCue) => void
}

function formatElapsed(startedAtMs: number, nowMs: number): string {
  const totalSec = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
  const hrs = Math.floor(totalSec / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

function parseChessSessionState(session: ActiveChessSession): ChessState {
  return deserializeChessState(session.stateJson) ?? createInitialChessState()
}

function parseGoSessionState(session: ActiveGoSession): GoState {
  try {
    const parsed = JSON.parse(session.stateJson) as GoState
    if (
      parsed &&
      Array.isArray(parsed.board) &&
      parsed.config &&
      typeof parsed.config.boardSize === 'number'
    ) {
      return parsed
    }
  } catch {
    // fallback to clean initial board matching goConfig
  }
  return createInitialGoState(session.goConfig)
}

function parsePokerSessionState(session: ActivePokerSession): PokerPublicState | null {
  try {
    const parsed = JSON.parse(session.publicStateJson) as PokerPublicState
    if (parsed && Array.isArray(parsed.seats) && typeof parsed.tableId === 'string') {
      return parsed
    }
  } catch {
    // ignore malformed state
  }
  return null
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
  statusLabel: string
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
      ? 'Waiting for opponent…'
      : isFinished
        ? 'Finished'
        : isMyTurn
          ? 'Your Turn'
          : "Opponent's Turn"
    return {
      title: 'Chess',
      scopeLabel,
      statusLabel,
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
      ? 'Waiting for opponent…'
      : isFinished
        ? 'Finished'
        : isScoring
          ? 'Scoring'
          : isMyTurn
            ? 'Your Turn'
            : "Opponent's Turn"
    return {
      title: `Go ${session.goConfig.boardSize}×${session.goConfig.boardSize}`,
      scopeLabel,
      statusLabel,
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
            ? 'Your Turn'
            : `Hand #${pkState.handNumber}`
  return {
    title: "Texas Hold'em Poker",
    scopeLabel,
    statusLabel,
    isMyTurn,
    isFinished,
    isWaiting: false,
  }
}

export function GameStage({
  engine,
  games,
  onFocusCall,
  onPlaySound,
}: GameStageProps) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [confirmClose, setConfirmClose] = useState(false)

  const allSessions = useMemo(
    () => Object.values(games.activeGamesByScope),
    [games.activeGamesByScope],
  )

  const focusedSession: ActiveGameSession | null = games.focusedScopeKey
    ? (games.activeGamesByScope[games.focusedScopeKey] ?? null)
    : null

  const showModal = Boolean(focusedSession && !games.minimized)
  const activeCall = engine.calls.activeCall

  // Prioritize a session where it's your turn when minimized across multiple active scopes
  const pillSession = useMemo<ActiveGameSession | null>(() => {
    if (showModal || allSessions.length === 0) return null
    const ranked = allSessions.map((s) => ({
      session: s,
      meta: computeSessionMeta(s, engine),
    }))
    ranked.sort((a, b) => {
      if (a.meta.isMyTurn !== b.meta.isMyTurn) return a.meta.isMyTurn ? -1 : 1
      if (a.session.scopeKey === games.focusedScopeKey) return -1
      if (b.session.scopeKey === games.focusedScopeKey) return 1
      return b.session.updatedAtMs - a.session.updatedAtMs
    })
    return ranked[0]?.session ?? null
  }, [showModal, allSessions, engine, games.focusedScopeKey])

  // Keep call elapsed timer ticking in game header only while modal + active call coexist
  useEffect(() => {
    if (!showModal || !activeCall) return
    setNowMs(Date.now())
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [showModal, activeCall])

  // Reset close confirmation when switching/minimizing sessions
  const focusedKey = focusedSession?.scopeKey ?? null
  useEffect(() => {
    setConfirmClose(false)
  }, [focusedKey, showModal])

  // Prefetch opponent avatar for DM Chess / Go games
  const focusedOpponentPubkey =
    focusedSession && focusedSession.scope === 'dm' ? focusedSession.opponentPubkey : null
  const ensureProfilePictures = engine.ensureProfilePictures
  useEffect(() => {
    if (!focusedOpponentPubkey) return
    ensureProfilePictures([focusedOpponentPubkey])
  }, [focusedOpponentPubkey, ensureProfilePictures])

  // Android / PWA Back button & Escape minimize the open game smoothly (never destroying the game)
  useBackHandler(showModal, () => {
    games.setMinimized(true)
  })

  useEffect(() => {
    if (!showModal) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onPlaySound?.('click')
        games.setMinimized(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showModal, games, onPlaySound])

  if (typeof document === 'undefined') return null

  const myDisplayName =
    engine.identity.nickname.trim() || engine.identity.activeDisplayHandle || 'You'

  // 1. Sleek Portaled Game Stage Modal (z-index: 62 — strictly below floating Call Pill/PiP at z-index: 68!)
  if (showModal && focusedSession) {
    const meta = computeSessionMeta(focusedSession, engine)

    const handleMinimize = () => {
      onPlaySound?.('click')
      games.setMinimized(true)
    }

    const handleCloseImmediate = () => {
      onPlaySound?.('click')
      setConfirmClose(false)
      if (focusedSession.kind === 'poker') {
        if (focusedSession.isHost) {
          void games.endPokerTable(focusedSession.scopeKey)
        } else {
          void games.leavePokerTable(focusedSession.scopeKey)
        }
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

    const callElapsed = activeCall
      ? activeCall.status === 'connecting' || activeCall.status === 'ringing-out'
        ? activeCall.status === 'ringing-out'
          ? 'Ringing…'
          : 'Connecting…'
        : formatElapsed(activeCall.connectedAt ?? activeCall.startedAt, nowMs)
      : null

    let boardBody: React.ReactNode = null
    if (focusedSession.kind === 'chess') {
      const chessState = parseChessSessionState(focusedSession)
      boardBody = (
        <ChessBoardView
          state={chessState}
          myColor={focusedSession.localColor}
          myDisplayName={myDisplayName}
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
        focusedSession.myHoleCards &&
        focusedSession.myHoleHandNumber === pokerState.handNumber
          ? focusedSession.myHoleCards
          : null

      boardBody = pokerState ? (
        <PokerTableView
          state={pokerState}
          myPubkey={focusedSession.localPubkey}
          myHoleCards={myHoleCards}
          isHost={focusedSession.isHost}
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
          onEndTable={
            focusedSession.isHost
              ? () => {
                  onPlaySound?.('click')
                  void games.endPokerTable(focusedSession.scopeKey)
                }
              : undefined
          }
        />
      ) : (
        <div className="ag-game-loading-state">Syncing table state…</div>
      )
    }

    return createPortal(
      <div
        className="ag-game-modal-backdrop"
        role="presentation"
        onClick={handleMinimize}
      >
        <section
          className={`ag-game-modal-frame is-${focusedSession.kind}`}
          role="dialog"
          aria-modal="true"
          aria-label={`${meta.title} · ${meta.scopeLabel}`}
          onClick={(e) => e.stopPropagation()}
        >
          <header className="ag-game-stage-head">
            <div className="ag-game-stage-head-left">
              <span className="ag-game-stage-icon" aria-hidden="true">
                {renderGameIcon(focusedSession.kind, 15)}
              </span>
              <span className="ag-game-stage-title truncate">{meta.title}</span>
              <span className="ag-game-scope-pill mono truncate">{meta.scopeLabel}</span>
              <span
                className={`ag-game-status-pill${meta.isMyTurn ? ' is-my-turn' : ''}${
                  meta.isFinished ? ' is-finished' : ''
                }`}
              >
                {meta.statusLabel}
              </span>
            </div>

            <div className="ag-game-stage-head-actions">
              {activeCall ? (
                <div className="ag-game-call-group">
                  <button
                    type="button"
                    className="ag-game-call-pill mono"
                    onClick={() => {
                      onPlaySound?.('click')
                      if (onFocusCall) onFocusCall()
                      else engine.calls.toggleMute()
                    }}
                    title={onFocusCall ? 'Open call stage' : 'Toggle microphone mute'}
                  >
                    <span className="ag-game-call-dot" aria-hidden="true" />
                    <PhoneCall size={12} aria-hidden="true" />
                    <span>In Call · {callElapsed}</span>
                  </button>
                  <button
                    type="button"
                    className={`ag-game-head-btn icon-only${
                      activeCall.localMuted ? ' is-danger' : ''
                    }`}
                    onClick={() => {
                      onPlaySound?.('click')
                      engine.calls.toggleMute()
                    }}
                    aria-pressed={activeCall.localMuted}
                    aria-label={activeCall.localMuted ? 'Unmute call mic' : 'Mute call mic'}
                    title={activeCall.localMuted ? 'Unmute mic' : 'Mute mic'}
                  >
                    {activeCall.localMuted ? <MicOff size={14} /> : <Mic size={14} />}
                  </button>
                </div>
              ) : (
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
                onClick={handleMinimize}
                title="Minimize game (keep playing in background)"
                aria-label="Minimize game"
              >
                <Minimize2 size={14} />
              </button>

              {confirmClose && !meta.isFinished ? (
                <div className="ag-game-close-confirm">
                  <button
                    type="button"
                    className="ag-game-head-btn is-danger"
                    onClick={handleCloseImmediate}
                  >
                    {focusedSession.kind === 'poker' && !focusedSession.isHost ? 'Leave' : 'End'}
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
                    if (meta.isFinished) {
                      handleCloseImmediate()
                    } else {
                      onPlaySound?.('click')
                      setConfirmClose(true)
                    }
                  }}
                  title={
                    meta.isFinished
                      ? 'Close game'
                      : focusedSession.kind === 'poker' && !focusedSession.isHost
                        ? 'Leave table'
                        : 'End game'
                  }
                  aria-label={meta.isFinished ? 'Close game' : 'End or leave game'}
                >
                  <X size={15} />
                </button>
              )}
            </div>
          </header>

          <div className="ag-game-stage-body">{boardBody}</div>
        </section>
      </div>,
      document.body,
    )
  }

  // 2. Minimized Floating Game Pill (bottom-left at z-index: 66 — opposite bottom-right Call Pill!)
  if (pillSession) {
    const meta = computeSessionMeta(pillSession, engine)
    const extraCount = allSessions.length - 1

    return createPortal(
      <div
        className={`ag-game-mini-pill${meta.isMyTurn ? ' is-my-turn' : ''}${
          meta.isFinished ? ' is-finished' : ''
        }`}
        role="region"
        aria-label={`Minimized game: ${meta.title} (${meta.scopeLabel})`}
      >
        <button
          type="button"
          className="ag-game-mini-main"
          onClick={() => {
            onPlaySound?.('click')
            games.setFocusedScopeKey(pillSession.scopeKey)
            games.setMinimized(false)
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
              {extraCount > 0 && (
                <span className="ag-game-mini-more mono">+{extraCount}</span>
              )}
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
                if (pillSession.isHost) void games.endPokerTable(pillSession.scopeKey)
                else void games.leavePokerTable(pillSession.scopeKey)
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
      </div>,
      document.body,
    )
  }

  return null
}

export default GameStage
