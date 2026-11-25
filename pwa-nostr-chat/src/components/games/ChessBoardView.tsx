import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Crown, Flag, Handshake, X } from 'lucide-react'
import {
  getLegalMoves,
  getMaterialBalance,
  squareToAlgebraic,
  type ChessColor,
  type ChessMove,
  type ChessPieceType,
  type ChessPromotion,
  type ChessState,
} from '../../lib/games/chessEngine.ts'
import { playGameSound } from '../../utils/gameSounds.ts'
import { AvatarImg } from '../AvatarImg.tsx'

export interface ChessBoardViewProps {
  state: ChessState
  myColor: ChessColor
  myDisplayName: string
  myPubkey?: string
  myAvatarUrl?: string
  opponentDisplayName: string
  opponentPubkey: string
  opponentAvatarUrl?: string
  waitingForOpponent?: boolean
  onMove: (move: ChessMove) => void
  onOfferDraw: () => void
  onRespondDraw: (accept: boolean) => void
  onResign: () => void
}

const FILES = 'abcdefgh'
const PROMOTION_ORDER: readonly ChessPromotion[] = ['q', 'r', 'b', 'n']
const PROMOTION_LABELS: Record<ChessPromotion, string> = {
  q: 'Queen',
  r: 'Rook',
  b: 'Bishop',
  n: 'Knight',
}
const CAPTURE_SORT_WEIGHT: Record<ChessPieceType, number> = {
  q: 5,
  r: 4,
  b: 3,
  n: 2,
  p: 1,
  k: 0,
}

interface PendingPromotionState {
  from: number
  to: number
  historyLen: number
}

/**
 * Crisp Staunton-inspired inline SVG chess piece silhouettes (zero OS emoji variance).
 * White pieces use warm ivory with crisp charcoal outlines; black pieces use deep
 * charcoal with soft silver outlines and accents so both read sharply on any square.
 */
const ChessPieceSvg: React.FC<{
  type: ChessPieceType
  color: ChessColor
  className?: string
  size?: number
}> = ({ type, color, className, size }) => {
  const isWhite = color === 'w'
  const fill = isWhite ? '#FAF7F0' : '#161922'
  const stroke = isWhite ? '#1E2330' : 'rgba(255, 255, 255, 0.36)'
  const strokeW = isWhite ? 1.55 : 1.1
  const accent = isWhite ? '#384152' : 'rgba(255, 255, 255, 0.3)'
  const accentW = isWhite ? 1.15 : 0.95
  const eyeFill = isWhite ? '#1E2330' : 'rgba(255, 255, 255, 0.56)'

  return (
    <svg
      viewBox="0 0 45 45"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {type === 'p' && (
        <g
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeW}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="22.5" cy="13.5" r="4.5" />
          <path d="M16.5 22.5c0-3 2.5-5 6-5s6 2 6 5c0 1.6-.7 3-1.8 3.9 2.3 2.4 3.8 5.8 4.3 9.6H14c.5-3.8 2-7.2 4.3-9.6-1.1-.9-1.8-2.3-1.8-3.9Z" />
          <path d="M12.5 39h20v-3h-20v3Z" />
        </g>
      )}

      {type === 'r' && (
        <g
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeW}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 39h25v-3.5H10V39Z" />
          <path d="M13 35.5v-3.5h19v3.5H13Z" />
          <path d="M15 32V17.5h15V32H15Z" />
          <path d="M12 17.5l3-2.5h15l3 2.5H12Z" />
          <path d="M12 15V9.5h4.5V12h3.5V9.5h5V12h3.5V9.5H33V15H12Z" />
          <path d="M15.5 21.5h14" stroke={accent} strokeWidth={accentW} />
          <path d="M15.5 28.5h14" stroke={accent} strokeWidth={accentW} />
        </g>
      )}

      {type === 'n' && (
        <g
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeW}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M11 39h23v-3.5H11V39Z" />
          <path d="M14 35.5c.6-6.2 4.4-8.8 5.4-12.5-2.6.8-5.1 2-6.8 3.2-1.2.8-2.8.2-3.1-1.2-.3-1.2.3-2.5 1.3-3.4 2.5-2.3 4.8-5.6 6.2-9.1l-1.4-3.3c2.4.3 4.4 1.2 5.9 2.5 1.1-.5 2.4-.8 3.8-.8 5.2 0 9.4 4.3 9.7 10.6.3 5.2-.6 10-2.5 14H14Z" />
          <circle cx="19.2" cy="15.8" r="1.15" fill={eyeFill} stroke="none" />
          <path d="M25.5 15.2c3.2 2.2 4.6 6.6 3.7 12.8" fill="none" stroke={accent} strokeWidth={accentW} />
        </g>
      )}

      {type === 'b' && (
        <g
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeW}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="22.5" cy="8.5" r="2.6" />
          <path d="M15 32.5c3.4-1.2 11.6-1.2 15 0 2.5-3.2 3.4-7.2 2.2-11.2-1.1-3.8-4.5-7.4-9.7-10.3-5.2 2.9-8.6 6.5-9.7 10.3-1.2 4-.3 8 2.2 11.2Z" />
          <path d="M15 32.5v3h15v-3H15Z" />
          <path d="M10.5 39c3.5-1.5 8-2.2 12-2.2s8.5.7 12 2.2v-2.2c-3.5-1.4-8-2.1-12-2.1s-8.5.7-12 2.1V39Z" />
          <path d="M22.5 16.5v6M19.5 19.5h6" fill="none" stroke={accent} strokeWidth={isWhite ? 1.4 : 1.1} />
        </g>
      )}

      {type === 'q' && (
        <g
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeW}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="8" cy="13.5" r="2.2" />
          <circle cx="15" cy="9.5" r="2.2" />
          <circle cx="22.5" cy="8" r="2.3" />
          <circle cx="30" cy="9.5" r="2.2" />
          <circle cx="37" cy="13.5" r="2.2" />
          <path d="M9.5 15.8l3.8 14.7h18.4l3.8-14.7-6.3 7.5-6.7-12.3-6.7 12.3-6.3-7.5Z" />
          <path d="M13 30.5v4.5c5.5-1.2 13.5-1.2 19 0v-4.5H13Z" />
          <path d="M11 39h23v-3.5c-6.5-1.3-16.5-1.3-23 0V39Z" />
          <path d="M14.5 33.2c4.8-.9 11.2-.9 16 0" fill="none" stroke={accent} strokeWidth={accentW} />
        </g>
      )}

      {type === 'k' && (
        <g
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeW}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M22.5 12V5.5M19.5 8.3h6" fill="none" strokeWidth={isWhite ? 1.85 : 1.35} />
          <path d="M22.5 12c-3.5 0-5.2 2.2-5.2 4.6 0 2.1 1.3 3.7 3 4.6-4.2-1.8-9.8-.5-10.8 4-.9 4.1 2.2 7.8 6.5 8.8h13c4.3-1 7.4-4.7 6.5-8.8-1-4.5-6.6-5.8-10.8-4 1.7-.9 3-2.5 3-4.6 0-2.4-1.7-4.6-5.2-4.6Z" />
          <path d="M13 34v5h19v-5c-5.8-1.4-13.2-1.4-19 0Z" />
          <path d="M14.5 36.2c4.8-1 11.2-1 16 0" fill="none" stroke={accent} strokeWidth={accentW} />
          <path d="M22.5 21.5v11.5" fill="none" stroke={accent} strokeWidth={accentW} />
        </g>
      )}
    </svg>
  )
}

function formatFinishedSummary(state: ChessState): string {
  const winnerName = state.winner === 'w' ? 'White' : state.winner === 'b' ? 'Black' : null
  const loserName = state.winner === 'w' ? 'Black' : state.winner === 'b' ? 'White' : null

  switch (state.termination) {
    case 'checkmate':
      return `Checkmate — ${winnerName ?? 'Game'} wins`
    case 'stalemate':
      return 'Draw by stalemate'
    case 'insufficient':
      return 'Draw — insufficient material'
    case 'threefold':
      return 'Draw by threefold repetition'
    case 'fifty-move':
      return 'Draw by 50-move rule'
    case 'draw-agreement':
      return 'Draw by agreement'
    case 'resign':
      return loserName && winnerName ? `${loserName} resigned — ${winnerName} wins` : 'Game resigned'
    default:
      return winnerName ? `${winnerName} wins` : 'Game finished'
  }
}

function sortCapturedPieces(pieces: readonly ChessPieceType[]): ChessPieceType[] {
  return pieces.slice().sort((a, b) => CAPTURE_SORT_WEIGHT[b] - CAPTURE_SORT_WEIGHT[a])
}

export const ChessBoardView: React.FC<ChessBoardViewProps> = ({
  state,
  myColor,
  myDisplayName,
  myPubkey,
  myAvatarUrl,
  opponentDisplayName,
  opponentPubkey,
  opponentAvatarUrl,
  waitingForOpponent = false,
  onMove,
  onOfferDraw,
  onRespondDraw,
  onResign,
}) => {
  const [selectedSq, setSelectedSq] = useState<number | null>(null)
  const [pendingPromo, setPendingPromo] = useState<PendingPromotionState | null>(null)
  const [confirmResign, setConfirmResign] = useState(false)
  const historyScrollRef = useRef<HTMLDivElement | null>(null)
  const prevHistoryLenRef = useRef<number>(state.history.length)

  useEffect(() => {
    const len = state.history.length
    if (len > prevHistoryLenRef.current) {
      const latest = state.history[len - 1]
      if (latest?.isCheck || latest?.isCheckmate || state.inCheck) {
        playGameSound('chess-check')
      } else if (latest?.captured) {
        playGameSound('chess-capture')
      } else {
        playGameSound('chess-move')
      }
    }
    prevHistoryLenRef.current = len
  }, [state.history, state.inCheck])

  const opponentColor: ChessColor = myColor === 'w' ? 'b' : 'w'
  const canInteract = !waitingForOpponent && state.status === 'active' && state.turn === myColor

  const effectiveSelectedSq = useMemo(() => {
    if (!canInteract || selectedSq === null) return null
    const piece = state.board[selectedSq]
    if (!piece || piece.color !== myColor) return null
    return selectedSq
  }, [canInteract, selectedSq, state.board, myColor])

  const effectivePendingPromo = useMemo(() => {
    if (!canInteract || !pendingPromo) return null
    if (pendingPromo.historyLen !== state.history.length) return null
    return pendingPromo
  }, [canInteract, pendingPromo, state.history.length])

  const legalMovesFromSelected = useMemo(() => {
    if (effectiveSelectedSq === null) return []
    return getLegalMoves(state, effectiveSelectedSq)
  }, [state, effectiveSelectedSq])

  const legalByDest = useMemo(() => {
    const map = new Map<number, ChessMove[]>()
    for (const mv of legalMovesFromSelected) {
      const list = map.get(mv.to)
      if (list) list.push(mv)
      else map.set(mv.to, [mv])
    }
    return map
  }, [legalMovesFromSelected])

  const checkedKingSq = useMemo(() => {
    if (!state.inCheck) return -1
    for (let sq = 0; sq < 64; sq += 1) {
      const p = state.board[sq]
      if (p && p.type === 'k' && p.color === state.turn) return sq
    }
    return -1
  }, [state.board, state.inCheck, state.turn])

  const { whiteAdvantage } = useMemo(() => getMaterialBalance(state), [state])
  const myAdvantage = myColor === 'w' ? whiteAdvantage : -whiteAdvantage
  const opponentAdvantage = -myAdvantage

  const myCaptures = useMemo(
    () => sortCapturedPieces(myColor === 'w' ? state.capturedByWhite : state.capturedByBlack),
    [myColor, state.capturedByWhite, state.capturedByBlack],
  )
  const opponentCaptures = useMemo(
    () => sortCapturedPieces(opponentColor === 'w' ? state.capturedByWhite : state.capturedByBlack),
    [opponentColor, state.capturedByWhite, state.capturedByBlack],
  )

  const movePairs = useMemo(() => {
    const pairs: Array<{ moveNumber: number; white: string; black?: string }> = []
    for (let i = 0; i < state.history.length; i += 2) {
      pairs.push({
        moveNumber: Math.floor(i / 2) + 1,
        white: state.history[i].san,
        black: state.history[i + 1]?.san,
      })
    }
    return pairs
  }, [state.history])

  // Auto-scroll SAN move ribbon to keep latest ply visible
  useEffect(() => {
    const el = historyScrollRef.current
    if (el) {
      el.scrollLeft = el.scrollWidth
    }
  }, [state.history.length])

  const displayRows = useMemo(
    () => (myColor === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0]),
    [myColor],
  )
  const displayCols = useMemo(
    () => (myColor === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0]),
    [myColor],
  )

  const handleSquareClick = (sq: number) => {
    if (effectivePendingPromo) {
      setPendingPromo(null)
      return
    }
    if (!canInteract) return

    if (effectiveSelectedSq !== null) {
      const matching = legalByDest.get(sq)
      if (matching && matching.length > 0) {
        if (matching.length > 1 && matching.some((m) => m.promotion)) {
          setPendingPromo({ from: effectiveSelectedSq, to: sq, historyLen: state.history.length })
          return
        }
        setSelectedSq(null)
        setConfirmResign(false)
        onMove(matching[0])
        return
      }
      if (sq === effectiveSelectedSq) {
        setSelectedSq(null)
        return
      }
      const clicked = state.board[sq]
      if (clicked && clicked.color === myColor) {
        setSelectedSq(sq)
        return
      }
      setSelectedSq(null)
      return
    }

    const clicked = state.board[sq]
    if (clicked && clicked.color === myColor) {
      setSelectedSq(sq)
    }
  }

  const handleChoosePromotion = (promotion: ChessPromotion) => {
    if (!effectivePendingPromo) return
    const move: ChessMove = {
      from: effectivePendingPromo.from,
      to: effectivePendingPromo.to,
      promotion,
    }
    setPendingPromo(null)
    setSelectedSq(null)
    setConfirmResign(false)
    onMove(move)
  }

  const incomingDrawOffer =
    state.status === 'active' && state.drawOfferBy !== null && state.drawOfferBy !== myColor
  const outgoingDrawOffer = state.status === 'active' && state.drawOfferBy === myColor
  const showConfirmResign = state.status === 'active' && confirmResign

  const selectedPiece = effectiveSelectedSq !== null ? state.board[effectiveSelectedSq] : null

  return (
    <div className="ag-chess-view" data-my-color={myColor}>
      {/* Opponent Strip (Top) */}
      <div
        className={`ag-chess-player-strip is-opponent${
          !waitingForOpponent && state.status === 'active' && state.turn === opponentColor
            ? ' is-turn'
            : ''
        }`}
        data-opponent-pubkey={opponentPubkey}
      >
        <div className="ag-chess-player-id">
          <AvatarImg
            pubkey={opponentPubkey}
            pictureUrl={opponentAvatarUrl}
            alt=""
            width={24}
            height={24}
            className="ag-chess-avatar"
          />
          <span
            className={`ag-chess-color-badge ${opponentColor === 'w' ? 'is-white' : 'is-black'}`}
            title={opponentColor === 'w' ? 'Playing White' : 'Playing Black'}
          >
            <ChessPieceSvg type="k" color={opponentColor} size={15} />
          </span>
          <span className="ag-chess-player-name truncate">{opponentDisplayName}</span>
          {!waitingForOpponent && state.status === 'active' && state.turn === opponentColor && (
            <span className="ag-chess-turn-pill">Turn</span>
          )}
        </div>

        <div className="ag-chess-captures" aria-label="Pieces captured by opponent">
          {opponentCaptures.map((pt, idx) => (
            <ChessPieceSvg
              key={`${pt}-${idx}`}
              type={pt}
              color={myColor}
              size={14}
              className="ag-chess-cap-icon"
            />
          ))}
          {opponentAdvantage > 0 && (
            <span className="ag-chess-mat-adv mono tabular">+{opponentAdvantage}</span>
          )}
        </div>
      </div>

      {/* Interactive 8x8 Board + Promotion Picker Overlay */}
      <div className="ag-chess-board-wrap">
        <div
          className={`ag-chess-board${canInteract ? ' is-interactive' : ''}`}
          role="grid"
          aria-label="Chess board"
        >
          {displayRows.map((row, displayRowIdx) =>
            displayCols.map((col, displayColIdx) => {
              const sq = row * 8 + col
              const piece = state.board[sq]
              const isLight = (row + col) % 2 === 0
              const isSelected = effectiveSelectedSq === sq
              const isLastFrom = state.lastMove?.from === sq
              const isLastTo = state.lastMove?.to === sq
              const isCheckedKing = sq === checkedKingSq
              const isLegalTarget = legalByDest.has(sq)
              const isLegalCapture =
                isLegalTarget &&
                (piece !== null || (state.enPassant === sq && selectedPiece?.type === 'p'))

              const sqAlg = squareToAlgebraic(sq)
              const showRankCoord = displayColIdx === 0
              const showFileCoord = displayRowIdx === 7
              const rankLabel = String(8 - row)
              const fileLabel = FILES[col]

              const sqClasses = [
                'ag-chess-sq',
                isLight ? 'is-light' : 'is-dark',
                isSelected ? 'is-selected' : '',
                isLastFrom ? 'is-last-from' : '',
                isLastTo ? 'is-last-to' : '',
                isCheckedKing ? 'is-check' : '',
                isLegalTarget ? 'is-legal-target' : '',
                isLegalCapture ? 'is-legal-capture' : '',
              ]
                .filter(Boolean)
                .join(' ')

              const ariaLabel = piece
                ? `${sqAlg}: ${piece.color === 'w' ? 'White' : 'Black'} ${piece.type.toUpperCase()}${
                    isLegalCapture ? ' (capturable)' : ''
                  }`
                : `${sqAlg}${isLegalTarget ? ' (legal move)' : ''}`

              return (
                <button
                  key={sq}
                  type="button"
                  role="gridcell"
                  className={sqClasses}
                  onClick={() => handleSquareClick(sq)}
                  aria-label={ariaLabel}
                  aria-pressed={isSelected || undefined}
                  data-square={sqAlg}
                >
                  {showRankCoord && (
                    <span className="ag-chess-coord ag-chess-coord-rank mono" aria-hidden="true">
                      {rankLabel}
                    </span>
                  )}
                  {showFileCoord && (
                    <span className="ag-chess-coord ag-chess-coord-file mono" aria-hidden="true">
                      {fileLabel}
                    </span>
                  )}
                  {piece && (
                    <ChessPieceSvg
                      type={piece.type}
                      color={piece.color}
                      className="ag-chess-piece"
                    />
                  )}
                  {isLegalTarget && !isLegalCapture && (
                    <span className="ag-chess-legal-dot" aria-hidden="true" />
                  )}
                  {isLegalCapture && <span className="ag-chess-capture-ring" aria-hidden="true" />}
                </button>
              )
            }),
          )}
        </div>

        {/* Inline 4-Piece Promotion Picker Overlay */}
        {effectivePendingPromo && (
          <div
            className="ag-chess-promo-backdrop"
            role="dialog"
            aria-label="Choose promotion piece"
            onClick={() => setPendingPromo(null)}
          >
            <div className="ag-chess-promo-picker" onClick={(e) => e.stopPropagation()}>
              <span className="ag-chess-promo-title">Promote pawn</span>
              <div className="ag-chess-promo-choices">
                {PROMOTION_ORDER.map((promo) => (
                  <button
                    key={promo}
                    type="button"
                    className="ag-chess-promo-btn"
                    onClick={() => handleChoosePromotion(promo)}
                    aria-label={`Promote to ${PROMOTION_LABELS[promo]}`}
                    title={PROMOTION_LABELS[promo]}
                  >
                    <ChessPieceSvg type={promo} color={myColor} size={34} />
                    <span className="ag-chess-promo-label mono">{promo.toUpperCase()}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="ag-chess-promo-cancel"
                onClick={() => setPendingPromo(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Your Strip (Bottom) */}
      <div
        className={`ag-chess-player-strip is-self${canInteract ? ' is-turn' : ''}`}
      >
        <div className="ag-chess-player-id">
          <AvatarImg
            pubkey={myPubkey || 'self'}
            pictureUrl={myAvatarUrl}
            alt=""
            width={24}
            height={24}
            className="ag-chess-avatar"
          />
          <span
            className={`ag-chess-color-badge ${myColor === 'w' ? 'is-white' : 'is-black'}`}
            title={myColor === 'w' ? 'Playing White' : 'Playing Black'}
          >
            <ChessPieceSvg type="k" color={myColor} size={15} />
          </span>
          <span className="ag-chess-player-name truncate">{myDisplayName}</span>
          {canInteract && state.inCheck ? (
            <span className="ag-chess-turn-pill is-mine">Check</span>
          ) : canInteract ? (
            <span className="ag-game-mini-turn-dot" aria-hidden="true" />
          ) : null}
        </div>

        <div className="ag-chess-captures" aria-label="Pieces captured by you">
          {myCaptures.map((pt, idx) => (
            <ChessPieceSvg
              key={`${pt}-${idx}`}
              type={pt}
              color={opponentColor}
              size={14}
              className="ag-chess-cap-icon"
            />
          ))}
          {myAdvantage > 0 && (
            <span className="ag-chess-mat-adv mono tabular">+{myAdvantage}</span>
          )}
        </div>
      </div>

      {/* Compact Scrollable SAN Move History Ribbon */}
      {movePairs.length > 0 && (
        <div
          ref={historyScrollRef}
          className="ag-chess-history mono tabular"
          aria-label="Move history"
        >
          {movePairs.map((pair) => (
            <span key={pair.moveNumber} className="ag-chess-history-pair">
              <span className="ag-chess-history-num">{pair.moveNumber}.</span>
              <span className="ag-chess-history-ply">{pair.white}</span>
              {pair.black && <span className="ag-chess-history-ply">{pair.black}</span>}
            </span>
          ))}
        </div>
      )}

      {/* Incoming Draw Offer Banner */}
      {incomingDrawOffer && (
        <div className="ag-chess-draw-banner" role="status" aria-live="polite">
          <div className="ag-chess-draw-copy">
            <Handshake size={14} aria-hidden="true" />
            <span>Opponent offered a draw</span>
          </div>
          <div className="ag-chess-draw-actions">
            <button
              type="button"
              className="ag-chess-btn primary"
              onClick={() => onRespondDraw(true)}
            >
              <Check size={13} aria-hidden="true" />
              <span>Accept Draw</span>
            </button>
            <button
              type="button"
              className="ag-chess-btn"
              onClick={() => onRespondDraw(false)}
            >
              <X size={13} aria-hidden="true" />
              <span>Decline</span>
            </button>
          </div>
        </div>
      )}

      {/* Finished Result Banner */}
      {state.status === 'finished' && (
        <div
          className={`ag-chess-finish-banner${
            state.winner === myColor
              ? ' is-win'
              : state.winner === 'draw'
                ? ' is-draw'
                : ' is-loss'
          }`}
          role="status"
          aria-live="polite"
        >
          <Crown size={15} aria-hidden="true" />
          <span>{formatFinishedSummary(state)}</span>
        </div>
      )}

      {/* Active Game Controls: Offer Draw + 2-Tap Resign */}
      {state.status === 'active' && (
        <div className="ag-chess-actions">
          <button
            type="button"
            className="ag-chess-btn"
            disabled={waitingForOpponent || state.drawOfferBy !== null}
            onClick={() => {
              setConfirmResign(false)
              onOfferDraw()
            }}
          >
            <Handshake size={13} aria-hidden="true" />
            <span>{outgoingDrawOffer ? 'Draw Offered' : 'Offer Draw'}</span>
          </button>

          {showConfirmResign ? (
            <div className="ag-chess-resign-confirm">
              <button
                type="button"
                className="ag-chess-btn danger"
                onClick={() => {
                  setConfirmResign(false)
                  onResign()
                }}
              >
                <Flag size={13} aria-hidden="true" />
                <span>Confirm Resign</span>
              </button>
              <button
                type="button"
                className="ag-chess-btn"
                onClick={() => setConfirmResign(false)}
              >
                <span>Cancel</span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="ag-chess-btn danger-ghost"
              disabled={waitingForOpponent}
              onClick={() => setConfirmResign(true)}
            >
              <Flag size={13} aria-hidden="true" />
              <span>Resign</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default ChessBoardView
