import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, Flag, RotateCcw, SkipForward, Trophy } from 'lucide-react'
import {
  GO_COL_LETTERS,
  checkGoMoveLegality,
  computeGoScore,
  formatGoCoord,
  getGoStarPoints,
  type GoColor,
  type GoMove,
  type GoState,
} from '../../lib/games/goEngine'
import { AvatarImg } from '../AvatarImg'
import { playGameSound } from '../../utils/gameSounds'

export interface GoBoardViewProps {
  state: GoState
  myColor: GoColor
  myDisplayName: string
  myPubkey?: string
  myAvatarUrl?: string
  opponentDisplayName: string
  opponentPubkey: string
  opponentAvatarUrl?: string
  waitingForOpponent?: boolean
  onPlayMove: (move: GoMove) => void
  onToggleDeadGroup: (row: number, col: number) => void
  onAcceptScore: () => void
  onResumeScoring: () => void
  onResign: () => void
}

function formatScoreNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '')
}

function colorName(color: GoColor): string {
  return color === 'b' ? 'Black' : 'White'
}

export const GoBoardView: React.FC<GoBoardViewProps> = ({
  state,
  myColor,
  myDisplayName,
  myPubkey,
  myAvatarUrl,
  opponentDisplayName,
  opponentPubkey,
  opponentAvatarUrl,
  waitingForOpponent = false,
  onPlayMove,
  onToggleDeadGroup,
  onAcceptScore,
  onResumeScoring,
  onResign,
}) => {
  const uid = useId().replace(/:/g, '')
  const [hoverPt, setHoverPt] = useState<{ row: number; col: number } | null>(null)
  const [illegalHint, setIllegalHint] = useState<string | null>(null)
  const [confirmResignMoveCount, setConfirmResignMoveCount] = useState<number | null>(null)
  const hintTimerRef = useRef<number | null>(null)
  const prevMoveCountRef = useRef<number>(state.moveCount)
  const prevTotalCapturesRef = useRef<number>(state.capturesByBlack + state.capturesByWhite)

  useEffect(() => {
    const totalCaptures = state.capturesByBlack + state.capturesByWhite
    if (state.moveCount > prevMoveCountRef.current) {
      if (state.lastMove?.type === 'pass') {
        playGameSound('check-tap')
      } else if (totalCaptures > prevTotalCapturesRef.current) {
        playGameSound('go-capture')
      } else {
        playGameSound('go-stone')
      }
    }
    prevMoveCountRef.current = state.moveCount
    prevTotalCapturesRef.current = totalCaptures
  }, [state.moveCount, state.capturesByBlack, state.capturesByWhite, state.lastMove?.type])

  useEffect(() => {
    return () => {
      if (hintTimerRef.current !== null) {
        window.clearTimeout(hintTimerRef.current)
      }
    }
  }, [])

  const showHint = (message: string) => {
    setIllegalHint(message)
    if (hintTimerRef.current !== null) {
      window.clearTimeout(hintTimerRef.current)
    }
    hintTimerRef.current = window.setTimeout(() => {
      setIllegalHint(null)
      hintTimerRef.current = null
    }, 2600)
  }

  const size = state.config.boardSize
  const oppColor: GoColor = myColor === 'b' ? 'w' : 'b'
  const canPlay =
    !waitingForOpponent && state.phase === 'playing' && state.turn === myColor
  const isScoring = state.phase === 'scoring'
  const isFinished = state.phase === 'finished'
  const confirmResign =
    state.phase === 'playing' && confirmResignMoveCount === state.moveCount

  const starPoints = useMemo(() => getGoStarPoints(size), [size])

  const deadStoneSet = useMemo(
    () => new Set<number>(state.deadStones),
    [state.deadStones]
  )

  const scoreBreakdown = useMemo(() => {
    if (isFinished && state.finalScore) return state.finalScore
    if (isScoring) return computeGoScore(state)
    return null
  }, [isFinished, isScoring, state])

  // Responsive SVG coordinate geometry
  const cell = 40
  const margin = size === 19 ? 44 : size === 13 ? 46 : 48
  const boardSpan = (size - 1) * cell
  const vbSize = boardSpan + margin * 2
  const stoneR = cell * 0.465
  const coordFontSize = size === 19 ? 12.5 : size === 13 ? 13.5 : 14.5
  const hoshiR = size === 19 ? 3.8 : 4.2

  const lastPlayCoord =
    state.lastMove?.type === 'play'
      ? { row: state.lastMove.row, col: state.lastMove.col }
      : null

  const lastMoveLabel = useMemo(() => {
    if (!state.lastMove) return null
    if (state.lastMove.type === 'pass') return 'Pass'
    return formatGoCoord(size, state.lastMove.row, state.lastMove.col)
  }, [size, state.lastMove])

  const myCaptures = myColor === 'b' ? state.capturesByBlack : state.capturesByWhite
  const oppCaptures = oppColor === 'b' ? state.capturesByBlack : state.capturesByWhite
  const rulesShort = state.config.scoring === 'chinese' ? 'Chinese' : 'Japanese'
  const rulesFull =
    state.config.scoring === 'chinese' ? 'Chinese · Area' : 'Japanese · Territory'

  const hoverLegal = useMemo(() => {
    if (!canPlay || !hoverPt) return false
    return checkGoMoveLegality(state, hoverPt.row, hoverPt.col).ok
  }, [canPlay, hoverPt, state])

  const handleIntersectionClick = (row: number, col: number) => {
    if (isScoring) {
      if (state.board[row * size + col] !== null) {
        onToggleDeadGroup(row, col)
      }
      return
    }
    if (state.phase !== 'playing') return
    if (waitingForOpponent) {
      showHint('Waiting for opponent to accept the challenge')
      return
    }
    if (state.turn !== myColor) return

    const legality = checkGoMoveLegality(state, row, col)
    if (!legality.ok) {
      if (legality.reason === 'ko') {
        showHint('Ko rule — play elsewhere first')
      } else if (legality.reason === 'suicide') {
        showHint('Suicide move not allowed')
      }
      return
    }

    setIllegalHint(null)
    setConfirmResignMoveCount(null)
    onPlayMove({ type: 'play', row, col })
  }

  const finishedHeadline = useMemo(() => {
    if (!isFinished) return ''
    if (state.termination === 'resign' && state.winner && state.winner !== 'draw') {
      return `${colorName(state.winner)} wins by resignation`
    }
    const final = state.finalScore
    if (final) {
      if (final.winner === 'draw') return 'Game drawn'
      return `${colorName(final.winner)} wins by ${formatScoreNum(final.margin)}`
    }
    if (state.winner === 'draw') return 'Game drawn'
    if (state.winner) return `${colorName(state.winner)} wins`
    return 'Game finished'
  }, [isFinished, state.finalScore, state.termination, state.winner])

  const liveLeaderBadge = useMemo(() => {
    if (!scoreBreakdown) return ''
    if (scoreBreakdown.winner === 'draw') return 'Draw'
    const prefix = scoreBreakdown.winner === 'b' ? 'B+' : 'W+'
    return `${prefix}${formatScoreNum(scoreBreakdown.margin)}`
  }, [scoreBreakdown])

  const gridLines = useMemo(() => {
    const out: number[] = []
    for (let i = 0; i < size; i++) out.push(i)
    return out
  }, [size])

  const woodGradId = `ag-go-wood-${uid}`
  const blackStoneGradId = `ag-go-black-${uid}`
  const whiteStoneGradId = `ag-go-white-${uid}`
  const stoneShadowId = `ag-go-shadow-${uid}`

  return (
    <div className="ag-go-view" data-phase={state.phase} data-board-size={size}>
      {/* Opponent Strip */}
      <div
        className={`ag-go-strip is-opponent${
          !waitingForOpponent && state.phase === 'playing' && state.turn === oppColor
            ? ' is-active-turn'
            : ''
        }`}
      >
        <div className="ag-go-player-id">
          <AvatarImg
            pubkey={opponentPubkey}
            pictureUrl={opponentAvatarUrl}
            alt=""
            width={24}
            height={24}
            className="ag-go-avatar"
          />
          <span
            className={`ag-go-stone-dot is-${oppColor}`}
            title={colorName(oppColor)}
            aria-label={colorName(oppColor)}
          />
          <span className="ag-go-player-name truncate">{opponentDisplayName}</span>
          <span className="ag-go-captures mono tabular" title="Captured stones">
            Cap {oppCaptures}
          </span>
        </div>
        {!waitingForOpponent && state.phase === 'playing' && state.turn === oppColor && (
          <span className="ag-go-turn-pill">Turn</span>
        )}
      </div>

      {/* Finished Result Banner */}
      {isFinished && (
        <div className="ag-go-finished-banner" role="status">
          <Trophy size={16} className="ag-go-finished-icon" aria-hidden="true" />
          <div className="ag-go-finished-copy">
            <strong className="ag-go-finished-title">{finishedHeadline}</strong>
            {state.finalScore && (
              <span className="ag-go-finished-sub mono tabular">
                Black {formatScoreNum(state.finalScore.blackTotal)} — White{' '}
                {formatScoreNum(state.finalScore.whiteTotal)} · {rulesShort} · Komi{' '}
                {formatScoreNum(state.finalScore.komi)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Scoring Phase Breakdown Bar */}
      {isScoring && scoreBreakdown && (
        <div className="ag-go-scoring-bar" role="region" aria-label="Go score confirmation">
          <div className="ag-go-scoring-head">
            <span className="ag-go-scoring-rules">{rulesFull}</span>
            <span className="ag-go-scoring-leader mono tabular">{liveLeaderBadge}</span>
          </div>
          <p className="ag-go-scoring-hint">
            Click any dead stone group on the board to toggle it, then confirm the score.
          </p>
          <div className="ag-go-scoring-grid">
            <div className="ag-go-scoring-side">
              <div className="ag-go-scoring-side-head">
                <span className="ag-go-stone-dot is-b" aria-hidden="true" />
                <strong>Black</strong>
                <span className="ag-go-scoring-total mono tabular">
                  {formatScoreNum(scoreBreakdown.blackTotal)}
                </span>
              </div>
              <div className="ag-go-scoring-parts mono tabular">
                {scoreBreakdown.rules === 'chinese' ? (
                  <>
                    <span>Terr {scoreBreakdown.blackTerritory}</span>
                    <span>Stones {scoreBreakdown.blackStonesOnBoard}</span>
                  </>
                ) : (
                  <>
                    <span>Terr {scoreBreakdown.blackTerritory}</span>
                    <span>Cap {scoreBreakdown.blackCaptures}</span>
                    <span>Dead W {scoreBreakdown.whiteDeadStones}</span>
                  </>
                )}
              </div>
            </div>
            <div className="ag-go-scoring-side">
              <div className="ag-go-scoring-side-head">
                <span className="ag-go-stone-dot is-w" aria-hidden="true" />
                <strong>White</strong>
                <span className="ag-go-scoring-total mono tabular">
                  {formatScoreNum(scoreBreakdown.whiteTotal)}
                </span>
              </div>
              <div className="ag-go-scoring-parts mono tabular">
                {scoreBreakdown.rules === 'chinese' ? (
                  <>
                    <span>Terr {scoreBreakdown.whiteTerritory}</span>
                    <span>Stones {scoreBreakdown.whiteStonesOnBoard}</span>
                    <span>Komi {formatScoreNum(scoreBreakdown.komi)}</span>
                  </>
                ) : (
                  <>
                    <span>Terr {scoreBreakdown.whiteTerritory}</span>
                    <span>Cap {scoreBreakdown.whiteCaptures}</span>
                    <span>Dead B {scoreBreakdown.blackDeadStones}</span>
                    <span>Komi {formatScoreNum(scoreBreakdown.komi)}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="ag-go-scoring-footer">
            <div className="ag-go-confirm-pills">
              <span
                className={`ag-go-confirm-pill${state.scoreAcceptedBy.b ? ' is-confirmed' : ''}`}
              >
                Black {state.scoreAcceptedBy.b ? '✓' : '…'}
              </span>
              <span
                className={`ag-go-confirm-pill${state.scoreAcceptedBy.w ? ' is-confirmed' : ''}`}
              >
                White {state.scoreAcceptedBy.w ? '✓' : '…'}
              </span>
            </div>
            <div className="ag-go-scoring-actions">
              <button
                type="button"
                className="ag-go-btn ag-go-btn-primary"
                onClick={onAcceptScore}
                disabled={state.scoreAcceptedBy[myColor]}
              >
                <Check size={14} aria-hidden="true" />
                <span>{state.scoreAcceptedBy[myColor] ? 'Score Accepted' : 'Accept Score'}</span>
              </button>
              <button
                type="button"
                className="ag-go-btn"
                onClick={onResumeScoring}
              >
                <RotateCcw size={14} aria-hidden="true" />
                <span>Resume Play</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tactile SVG Goban */}
      <div className="ag-go-board-wrap">
        <svg
          className={`ag-go-goban${canPlay ? ' is-interactive' : ''}${
            isScoring ? ' is-scoring' : ''
          }`}
          viewBox={`0 0 ${vbSize} ${vbSize}`}
          role="grid"
          aria-label={`${size} by ${size} Go board`}
          onMouseLeave={() => setHoverPt(null)}
        >
          <defs>
            <radialGradient id={woodGradId} cx="42%" cy="34%" r="78%">
              <stop offset="0%" stopColor="#E6BE7C" />
              <stop offset="56%" stopColor="#D7A75E" />
              <stop offset="100%" stopColor="#C18D43" />
            </radialGradient>
            <radialGradient id={blackStoneGradId} cx="32%" cy="28%" r="68%">
              <stop offset="0%" stopColor="#58606E" />
              <stop offset="42%" stopColor="#1D2027" />
              <stop offset="100%" stopColor="#090A0D" />
            </radialGradient>
            <radialGradient id={whiteStoneGradId} cx="32%" cy="26%" r="70%">
              <stop offset="0%" stopColor="#FFFFFF" />
              <stop offset="62%" stopColor="#F0EEE8" />
              <stop offset="100%" stopColor="#C9C4B8" />
            </radialGradient>
            <filter id={stoneShadowId} x="-22%" y="-22%" width="150%" height="150%">
              <feDropShadow
                dx="1.2"
                dy="2"
                stdDeviation="1.6"
                floodColor="#1A1106"
                floodOpacity="0.42"
              />
            </filter>
          </defs>

          {/* Kaya Wood Board Frame */}
          <rect
            x="2"
            y="2"
            width={vbSize - 4}
            height={vbSize - 4}
            rx="14"
            fill={`url(#${woodGradId})`}
            stroke="#7A5628"
            strokeWidth="3"
          />
          <rect
            x="6"
            y="6"
            width={vbSize - 12}
            height={vbSize - 12}
            rx="10"
            fill="none"
            stroke="rgba(255, 240, 210, 0.28)"
            strokeWidth="1.2"
          />

          {/* Subtle Wood Grain Lines */}
          <g opacity="0.09" stroke="#6B461C" strokeWidth="1">
            {gridLines.map((i) => {
              const y = margin + i * cell + 14
              if (y >= vbSize - 14) return null
              return (
                <line
                  key={`grain-${i}`}
                  x1="12"
                  y1={y}
                  x2={vbSize - 12}
                  y2={y}
                />
              )
            })}
          </g>

          {/* Grid Lines */}
          <g stroke="#2C1E0E" strokeLinecap="square">
            {gridLines.map((i) => {
              const pos = margin + i * cell
              const isEdge = i === 0 || i === size - 1
              const sw = isEdge ? 1.75 : 1.15
              return (
                <React.Fragment key={`grid-${i}`}>
                  <line x1={margin} y1={pos} x2={margin + boardSpan} y2={pos} strokeWidth={sw} />
                  <line x1={pos} y1={margin} x2={pos} y2={margin + boardSpan} strokeWidth={sw} />
                </React.Fragment>
              )
            })}
          </g>

          {/* Coordinate Labels (A–T skipping I, 1..size from bottom) */}
          <g
            fill="#4B3419"
            fontSize={coordFontSize}
            fontWeight="700"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            textAnchor="middle"
            dominantBaseline="central"
            style={{ userSelect: 'none', pointerEvents: 'none' }}
          >
            {gridLines.map((i) => {
              const pos = margin + i * cell
              const letter = GO_COL_LETTERS[i] ?? ''
              const rowNum = String(size - i)
              return (
                <React.Fragment key={`coord-${i}`}>
                  <text x={pos} y={margin * 0.44}>
                    {letter}
                  </text>
                  <text x={pos} y={vbSize - margin * 0.44}>
                    {letter}
                  </text>
                  <text x={margin * 0.42} y={pos}>
                    {rowNum}
                  </text>
                  <text x={vbSize - margin * 0.42} y={pos}>
                    {rowNum}
                  </text>
                </React.Fragment>
              )
            })}
          </g>

          {/* Hoshi Star Points */}
          <g fill="#2C1E0E" style={{ pointerEvents: 'none' }}>
            {starPoints.map((pt) => (
              <circle
                key={`star-${pt.row}-${pt.col}`}
                cx={margin + pt.col * cell}
                cy={margin + pt.row * cell}
                r={hoshiR}
              />
            ))}
          </g>

          {/* Subtle Ko Point Indicator */}
          {state.phase === 'playing' && state.koPoint !== null && (
            <rect
              x={margin + (state.koPoint % size) * cell - 6}
              y={margin + Math.floor(state.koPoint / size) * cell - 6}
              width="12"
              height="12"
              rx="1.5"
              fill="none"
              stroke="#B91C1C"
              strokeWidth="2"
              opacity="0.72"
              style={{ pointerEvents: 'none' }}
            />
          )}

          {/* Territory Overlay Squares (Scoring & Final Score) */}
          {scoreBreakdown && (
            <g style={{ pointerEvents: 'none' }}>
              {scoreBreakdown.territoryMap.map((owner, idx) => {
                if (!owner) return null
                const row = Math.floor(idx / size)
                const col = idx % size
                const cx = margin + col * cell
                const cy = margin + row * cell
                const sq = cell * 0.34
                return (
                  <rect
                    key={`terr-${idx}`}
                    x={cx - sq / 2}
                    y={cy - sq / 2}
                    width={sq}
                    height={sq}
                    rx="2.2"
                    fill={owner === 'b' ? '#14161B' : '#FAF9F6'}
                    stroke={owner === 'b' ? 'rgba(255,255,255,0.65)' : 'rgba(20,22,27,0.55)'}
                    strokeWidth="1.4"
                  />
                )
              })}
            </g>
          )}

          {/* Hover Ghost Stone */}
          {canPlay && hoverPt && hoverLegal && (
            <circle
              cx={margin + hoverPt.col * cell}
              cy={margin + hoverPt.row * cell}
              r={stoneR}
              fill={myColor === 'b' ? `url(#${blackStoneGradId})` : `url(#${whiteStoneGradId})`}
              opacity="0.44"
              stroke={myColor === 'w' ? 'rgba(40,32,20,0.35)' : 'none'}
              strokeWidth="1"
              style={{ pointerEvents: 'none' }}
            />
          )}

          {/* Placed Stones */}
          <g>
            {state.board.map((stone, idx) => {
              if (!stone) return null
              const row = Math.floor(idx / size)
              const col = idx % size
              const cx = margin + col * cell
              const cy = margin + row * cell
              const isDead = (isScoring || isFinished) && deadStoneSet.has(idx)
              const isLastMove =
                lastPlayCoord !== null &&
                lastPlayCoord.row === row &&
                lastPlayCoord.col === col &&
                !isDead

              return (
                <g
                  key={`stone-${idx}`}
                  opacity={isDead ? 0.42 : 1}
                  style={{ pointerEvents: 'none' }}
                >
                  <circle
                    cx={cx}
                    cy={cy}
                    r={stoneR}
                    fill={
                      stone === 'b'
                        ? `url(#${blackStoneGradId})`
                        : `url(#${whiteStoneGradId})`
                    }
                    stroke={stone === 'w' ? 'rgba(45, 36, 24, 0.35)' : 'rgba(0, 0, 0, 0.45)'}
                    strokeWidth="1"
                    filter={`url(#${stoneShadowId})`}
                  />
                  {isLastMove && (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={stoneR * 0.44}
                      fill="none"
                      stroke={stone === 'b' ? '#F8FAFC' : '#18181B'}
                      strokeWidth="2.4"
                    />
                  )}
                  {isDead && (
                    <g
                      stroke={stone === 'b' ? '#F87171' : '#DC2626'}
                      strokeWidth="2.6"
                      strokeLinecap="round"
                    >
                      <line x1={cx - 7} y1={cy - 7} x2={cx + 7} y2={cy + 7} />
                      <line x1={cx + 7} y1={cy - 7} x2={cx - 7} y2={cy + 7} />
                    </g>
                  )}
                </g>
              )
            })}
          </g>

          {/* Clickable / Hoverable Intersection Hit Targets */}
          <g>
            {state.board.map((stone, idx) => {
              const row = Math.floor(idx / size)
              const col = idx % size
              const cx = margin + col * cell
              const cy = margin + row * cell
              const coord = formatGoCoord(size, row, col)
              const interactiveCell =
                (canPlay && stone === null) || (isScoring && stone !== null)

              return (
                <rect
                  key={`hit-${idx}`}
                  x={cx - cell / 2}
                  y={cy - cell / 2}
                  width={cell}
                  height={cell}
                  fill="transparent"
                  style={{ cursor: interactiveCell ? 'pointer' : 'default' }}
                  role="gridcell"
                  aria-label={`${coord}${
                    stone ? `, ${colorName(stone)} stone` : ', empty'
                  }`}
                  onMouseEnter={() => {
                    if (canPlay) setHoverPt({ row, col })
                  }}
                  onClick={() => handleIntersectionClick(row, col)}
                />
              )
            })}
          </g>
        </svg>

        {/* Inline Illegal Move / Pass Status Hint */}
        {illegalHint ? (
          <div className="ag-go-inline-hint is-warn" role="alert">
            {illegalHint}
          </div>
        ) : state.phase === 'playing' && state.consecutivePasses === 1 ? (
          <div className="ag-go-inline-hint" role="status">
            {state.turn === myColor
              ? `${opponentDisplayName} passed — pass to enter scoring, or keep playing.`
              : 'You passed — waiting for opponent.'}
          </div>
        ) : null}
      </div>

      {/* Player Strip */}
      <div
        className={`ag-go-strip is-self${canPlay ? ' is-active-turn' : ''}`}
      >
        <div className="ag-go-player-id">
          <AvatarImg
            pubkey={myPubkey || 'self'}
            pictureUrl={myAvatarUrl}
            alt=""
            width={24}
            height={24}
            className="ag-go-avatar"
          />
          <span
            className={`ag-go-stone-dot is-${myColor}`}
            title={colorName(myColor)}
            aria-label={colorName(myColor)}
          />
          <span className="ag-go-player-name truncate">{myDisplayName}</span>
          <span className="ag-go-captures mono tabular" title="Captured stones">
            Cap {myCaptures}
          </span>
        </div>
        <div className="ag-go-strip-meta mono tabular">
          {canPlay && <span className="ag-game-mini-turn-dot" aria-hidden="true" />}
          <span>Move {state.moveCount}</span>
          {lastMoveLabel && <span>{lastMoveLabel}</span>}
        </div>
      </div>

      {/* Play Controls (Pass + 2-tap Resign) */}
      {state.phase === 'playing' && (
        <div className="ag-go-controls">
          <button
            type="button"
            className="ag-go-btn"
            disabled={!canPlay}
            onClick={() => {
              setIllegalHint(null)
              setConfirmResignMoveCount(null)
              onPlayMove({ type: 'pass' })
            }}
          >
            <SkipForward size={14} aria-hidden="true" />
            <span>Pass</span>
          </button>

          {confirmResign ? (
            <div className="ag-go-resign-confirm">
              <button
                type="button"
                className="ag-go-btn ag-go-btn-danger"
                onClick={() => {
                  setConfirmResignMoveCount(null)
                  onResign()
                }}
              >
                <Flag size={14} aria-hidden="true" />
                <span>Confirm Resign</span>
              </button>
              <button
                type="button"
                className="ag-go-btn"
                onClick={() => setConfirmResignMoveCount(null)}
              >
                <span>Cancel</span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="ag-go-btn ag-go-btn-ghost-danger"
              disabled={waitingForOpponent}
              onClick={() => setConfirmResignMoveCount(state.moveCount)}
            >
              <Flag size={14} aria-hidden="true" />
              <span>Resign</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default GoBoardView
