/**
 * Pure, zero-dependency FIDE Chess Rules Engine.
 *
 * Square indexing: 0..63 where 0 = a8 (row 0, col 0) and 63 = h1 (row 7, col 7).
 * row = Math.floor(sq / 8), col = sq % 8.
 */

export type ChessColor = 'w' | 'b'
export type ChessPieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k'
export type ChessPromotion = 'q' | 'r' | 'b' | 'n'

export interface ChessPiece {
  type: ChessPieceType
  color: ChessColor
}

export interface ChessMove {
  from: number
  to: number
  promotion?: ChessPromotion
}

export type ChessMoveRecord = ChessMove & {
  san: string
  piece: ChessPieceType
  color: ChessColor
  captured?: ChessPieceType
  isCastle?: 'K' | 'Q'
  isEnPassant?: boolean
  isCheck?: boolean
  isCheckmate?: boolean
}

export type ChessTermination =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient'
  | 'threefold'
  | 'fifty-move'
  | 'resign'
  | 'draw-agreement'

export interface ChessCastlingRights {
  wK: boolean
  wQ: boolean
  bK: boolean
  bQ: boolean
}

export interface ChessState {
  board: Array<ChessPiece | null>
  turn: ChessColor
  castling: ChessCastlingRights
  enPassant: number | null
  halfmoveClock: number
  fullmoveNumber: number
  history: ChessMoveRecord[]
  positionCounts: Record<string, number>
  capturedByWhite: ChessPieceType[]
  capturedByBlack: ChessPieceType[]
  status: 'active' | 'finished'
  winner: ChessColor | 'draw' | null
  termination: ChessTermination | null
  drawOfferBy: ChessColor | null
  lastMove: { from: number; to: number } | null
  inCheck: boolean
}

const FILES = 'abcdefgh'
const PROMOTION_PIECES: readonly ChessPromotion[] = ['q', 'r', 'b', 'n']
const PIECE_VALUES: Record<ChessPieceType, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
}
const PIECE_SAN_LETTER: Record<ChessPieceType, string> = {
  p: '',
  n: 'N',
  b: 'B',
  r: 'R',
  q: 'Q',
  k: 'K',
}
const KNIGHT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-2, -1],
  [-2, 1],
  [-1, -2],
  [-1, 2],
  [1, -2],
  [1, 2],
  [2, -1],
  [2, 1],
]
const KING_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
]
const DIAGONAL_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
]
const ORTHOGONAL_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
]
const BACK_RANK: readonly ChessPieceType[] = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r']

const VALID_COLORS = new Set<string>(['w', 'b'])
const VALID_PIECES = new Set<string>(['p', 'n', 'b', 'r', 'q', 'k'])
const VALID_PROMOTIONS = new Set<string>(['q', 'r', 'b', 'n'])
const VALID_TERMINATIONS = new Set<string>([
  'checkmate',
  'stalemate',
  'insufficient',
  'threefold',
  'fifty-move',
  'resign',
  'draw-agreement',
])

function isValidSquare(sq: number): boolean {
  return Number.isInteger(sq) && sq >= 0 && sq < 64
}

function oppositeColor(color: ChessColor): ChessColor {
  return color === 'w' ? 'b' : 'w'
}

function cloneBoard(board: ReadonlyArray<ChessPiece | null>): Array<ChessPiece | null> {
  return board.map((piece) => (piece ? { type: piece.type, color: piece.color } : null))
}

function findKingSquare(board: ReadonlyArray<ChessPiece | null>, color: ChessColor): number {
  for (let sq = 0; sq < 64; sq += 1) {
    const p = board[sq]
    if (p && p.type === 'k' && p.color === color) return sq
  }
  return -1
}

export function squareToAlgebraic(sq: number): string {
  if (!isValidSquare(sq)) return ''
  const row = Math.floor(sq / 8)
  const col = sq % 8
  return `${FILES[col]}${8 - row}`
}

export function algebraicToSquare(alg: string): number | null {
  if (typeof alg !== 'string') return null
  const clean = alg.trim().toLowerCase()
  if (clean.length !== 2) return null
  const col = FILES.indexOf(clean[0])
  const rank = Number(clean[1])
  if (col < 0 || !Number.isInteger(rank) || rank < 1 || rank > 8) return null
  const row = 8 - rank
  return row * 8 + col
}

export function isSquareAttacked(
  board: ReadonlyArray<ChessPiece | null>,
  sq: number,
  byColor: ChessColor,
): boolean {
  if (!isValidSquare(sq)) return false
  const row = Math.floor(sq / 8)
  const col = sq % 8

  // 1. Pawn attacks: a white pawn attacks upwards (from row + 1); black attacks downwards (from row - 1)
  const pawnRow = byColor === 'w' ? row + 1 : row - 1
  if (pawnRow >= 0 && pawnRow < 8) {
    if (col > 0) {
      const p = board[pawnRow * 8 + (col - 1)]
      if (p && p.color === byColor && p.type === 'p') return true
    }
    if (col < 7) {
      const p = board[pawnRow * 8 + (col + 1)]
      if (p && p.color === byColor && p.type === 'p') return true
    }
  }

  // 2. Knight attacks
  for (const [dr, dc] of KNIGHT_OFFSETS) {
    const r = row + dr
    const c = col + dc
    if (r >= 0 && r < 8 && c >= 0 && c < 8) {
      const p = board[r * 8 + c]
      if (p && p.color === byColor && p.type === 'n') return true
    }
  }

  // 3. King attacks
  for (const [dr, dc] of KING_OFFSETS) {
    const r = row + dr
    const c = col + dc
    if (r >= 0 && r < 8 && c >= 0 && c < 8) {
      const p = board[r * 8 + c]
      if (p && p.color === byColor && p.type === 'k') return true
    }
  }

  // 4. Diagonal rays (Bishop / Queen)
  for (const [dr, dc] of DIAGONAL_DIRS) {
    let r = row + dr
    let c = col + dc
    while (r >= 0 && r < 8 && c >= 0 && c < 8) {
      const p = board[r * 8 + c]
      if (p) {
        if (p.color === byColor && (p.type === 'b' || p.type === 'q')) return true
        break
      }
      r += dr
      c += dc
    }
  }

  // 5. Orthogonal rays (Rook / Queen)
  for (const [dr, dc] of ORTHOGONAL_DIRS) {
    let r = row + dr
    let c = col + dc
    while (r >= 0 && r < 8 && c >= 0 && c < 8) {
      const p = board[r * 8 + c]
      if (p) {
        if (p.color === byColor && (p.type === 'r' || p.type === 'q')) return true
        break
      }
      r += dr
      c += dc
    }
  }

  return false
}

interface ExecutedBoardStep {
  board: Array<ChessPiece | null>
  captured?: ChessPieceType
  isCastle?: 'K' | 'Q'
  isEnPassant?: boolean
}

function executeMoveOnBoard(
  board: ReadonlyArray<ChessPiece | null>,
  move: ChessMove,
  enPassant: number | null,
): ExecutedBoardStep | null {
  const piece = board[move.from]
  if (!piece) return null

  const nextBoard = cloneBoard(board)
  const fromRow = Math.floor(move.from / 8)
  const fromCol = move.from % 8
  const toRow = Math.floor(move.to / 8)
  const toCol = move.to % 8

  let captured: ChessPieceType | undefined
  let isCastle: 'K' | 'Q' | undefined
  let isEnPassant = false

  if (piece.type === 'p' && enPassant !== null && move.to === enPassant && fromCol !== toCol) {
    const capturedSq = fromRow * 8 + toCol
    const capPiece = nextBoard[capturedSq]
    if (!capPiece || capPiece.type !== 'p' || capPiece.color === piece.color) {
      return null
    }
    captured = 'p'
    isEnPassant = true
    nextBoard[capturedSq] = null
  } else {
    const targetPiece = nextBoard[move.to]
    if (targetPiece) {
      if (targetPiece.color === piece.color) return null
      captured = targetPiece.type
    }
  }

  // Handle castling rook shift
  if (piece.type === 'k' && Math.abs(toCol - fromCol) === 2 && fromRow === toRow) {
    if (toCol === 6) {
      isCastle = 'K'
      const rookFrom = fromRow * 8 + 7
      const rookTo = fromRow * 8 + 5
      nextBoard[rookTo] = nextBoard[rookFrom]
      nextBoard[rookFrom] = null
    } else if (toCol === 2) {
      isCastle = 'Q'
      const rookFrom = fromRow * 8
      const rookTo = fromRow * 8 + 3
      nextBoard[rookTo] = nextBoard[rookFrom]
      nextBoard[rookFrom] = null
    }
  }

  nextBoard[move.from] = null
  const finalType: ChessPieceType =
    piece.type === 'p' && (toRow === 0 || toRow === 7) && move.promotion
      ? move.promotion
      : piece.type
  nextBoard[move.to] = { type: finalType, color: piece.color }

  return {
    board: nextBoard,
    captured,
    isCastle,
    isEnPassant: isEnPassant || undefined,
  }
}

function generatePseudoLegalMovesFromSquare(
  board: ReadonlyArray<ChessPiece | null>,
  turn: ChessColor,
  castling: ChessCastlingRights,
  enPassant: number | null,
  from: number,
): ChessMove[] {
  const piece = board[from]
  if (!piece || piece.color !== turn) return []

  const moves: ChessMove[] = []
  const row = Math.floor(from / 8)
  const col = from % 8
  const enemy = oppositeColor(turn)

  if (piece.type === 'p') {
    const dir = turn === 'w' ? -1 : 1
    const startRow = turn === 'w' ? 6 : 1
    const promoRow = turn === 'w' ? 0 : 7
    const nextRow = row + dir

    if (nextRow >= 0 && nextRow < 8) {
      // Single push
      const oneAhead = nextRow * 8 + col
      if (board[oneAhead] === null) {
        if (nextRow === promoRow) {
          for (const promotion of PROMOTION_PIECES) {
            moves.push({ from, to: oneAhead, promotion })
          }
        } else {
          moves.push({ from, to: oneAhead })
          // Double push from starting rank
          if (row === startRow) {
            const twoAhead = (row + dir * 2) * 8 + col
            if (board[twoAhead] === null) {
              moves.push({ from, to: twoAhead })
            }
          }
        }
      }

      // Diagonal captures & en passant
      for (const dc of [-1, 1]) {
        const targetCol = col + dc
        if (targetCol < 0 || targetCol > 7) continue
        const targetSq = nextRow * 8 + targetCol
        const targetPiece = board[targetSq]

        if (targetPiece && targetPiece.color === enemy) {
          if (nextRow === promoRow) {
            for (const promotion of PROMOTION_PIECES) {
              moves.push({ from, to: targetSq, promotion })
            }
          } else {
            moves.push({ from, to: targetSq })
          }
        } else if (enPassant !== null && targetSq === enPassant) {
          const epCaptured = board[row * 8 + targetCol]
          if (epCaptured && epCaptured.type === 'p' && epCaptured.color === enemy) {
            moves.push({ from, to: targetSq })
          }
        }
      }
    }
    return moves
  }

  if (piece.type === 'n') {
    for (const [dr, dc] of KNIGHT_OFFSETS) {
      const r = row + dr
      const c = col + dc
      if (r < 0 || r > 7 || c < 0 || c > 7) continue
      const to = r * 8 + c
      const target = board[to]
      if (!target || target.color === enemy) {
        moves.push({ from, to })
      }
    }
    return moves
  }

  if (piece.type === 'k') {
    for (const [dr, dc] of KING_OFFSETS) {
      const r = row + dr
      const c = col + dc
      if (r < 0 || r > 7 || c < 0 || c > 7) continue
      const to = r * 8 + c
      const target = board[to]
      if (!target || target.color === enemy) {
        moves.push({ from, to })
      }
    }

    // Castling (FIDE: king unmoved, rook unmoved, path clear, king not in check & transit/dest unattacked)
    if (turn === 'w' && from === 60) {
      if (
        castling.wK &&
        board[63]?.type === 'r' &&
        board[63]?.color === 'w' &&
        board[61] === null &&
        board[62] === null &&
        !isSquareAttacked(board, 60, 'b') &&
        !isSquareAttacked(board, 61, 'b') &&
        !isSquareAttacked(board, 62, 'b')
      ) {
        moves.push({ from: 60, to: 62 })
      }
      if (
        castling.wQ &&
        board[56]?.type === 'r' &&
        board[56]?.color === 'w' &&
        board[57] === null &&
        board[58] === null &&
        board[59] === null &&
        !isSquareAttacked(board, 60, 'b') &&
        !isSquareAttacked(board, 59, 'b') &&
        !isSquareAttacked(board, 58, 'b')
      ) {
        moves.push({ from: 60, to: 58 })
      }
    } else if (turn === 'b' && from === 4) {
      if (
        castling.bK &&
        board[7]?.type === 'r' &&
        board[7]?.color === 'b' &&
        board[5] === null &&
        board[6] === null &&
        !isSquareAttacked(board, 4, 'w') &&
        !isSquareAttacked(board, 5, 'w') &&
        !isSquareAttacked(board, 6, 'w')
      ) {
        moves.push({ from: 4, to: 6 })
      }
      if (
        castling.bQ &&
        board[0]?.type === 'r' &&
        board[0]?.color === 'b' &&
        board[1] === null &&
        board[2] === null &&
        board[3] === null &&
        !isSquareAttacked(board, 4, 'w') &&
        !isSquareAttacked(board, 3, 'w') &&
        !isSquareAttacked(board, 2, 'w')
      ) {
        moves.push({ from: 4, to: 2 })
      }
    }
    return moves
  }

  // Sliding pieces (Bishop, Rook, Queen)
  const dirs =
    piece.type === 'b'
      ? DIAGONAL_DIRS
      : piece.type === 'r'
        ? ORTHOGONAL_DIRS
        : [...DIAGONAL_DIRS, ...ORTHOGONAL_DIRS]

  for (const [dr, dc] of dirs) {
    let r = row + dr
    let c = col + dc
    while (r >= 0 && r < 8 && c >= 0 && c < 8) {
      const to = r * 8 + c
      const target = board[to]
      if (!target) {
        moves.push({ from, to })
      } else {
        if (target.color === enemy) {
          moves.push({ from, to })
        }
        break
      }
      r += dr
      c += dc
    }
  }

  return moves
}

function generateLegalMovesForPosition(
  board: ReadonlyArray<ChessPiece | null>,
  turn: ChessColor,
  castling: ChessCastlingRights,
  enPassant: number | null,
  fromSq?: number,
): ChessMove[] {
  const enemy = oppositeColor(turn)
  const legal: ChessMove[] = []

  const start = fromSq !== undefined ? fromSq : 0
  const end = fromSq !== undefined ? fromSq : 63

  if (fromSq !== undefined && !isValidSquare(fromSq)) {
    return []
  }

  for (let sq = start; sq <= end; sq += 1) {
    const p = board[sq]
    if (!p || p.color !== turn) continue
    const candidates = generatePseudoLegalMovesFromSquare(board, turn, castling, enPassant, sq)
    for (const cand of candidates) {
      const step = executeMoveOnBoard(board, cand, enPassant)
      if (!step) continue
      const kingSq = findKingSquare(step.board, turn)
      if (kingSq >= 0 && !isSquareAttacked(step.board, kingSq, enemy)) {
        legal.push(cand)
      }
    }
  }

  return legal
}

/**
 * Per FIDE Article 9.2, an en passant target square only distinguishes a position
 * for threefold repetition when the side to move has a LEGAL en passant capture.
 */
function hasLegalEnPassantCapture(
  board: ReadonlyArray<ChessPiece | null>,
  turn: ChessColor,
  enPassant: number | null,
): boolean {
  if (enPassant === null || !isValidSquare(enPassant)) return false
  const epRow = Math.floor(enPassant / 8)
  const epCol = enPassant % 8
  const pawnRow = turn === 'w' ? epRow + 1 : epRow - 1
  if (pawnRow < 0 || pawnRow > 7) return false
  const enemy = oppositeColor(turn)

  for (const dc of [-1, 1]) {
    const col = epCol + dc
    if (col < 0 || col > 7) continue
    const from = pawnRow * 8 + col
    const p = board[from]
    if (!p || p.color !== turn || p.type !== 'p') continue
    const step = executeMoveOnBoard(board, { from, to: enPassant }, enPassant)
    if (!step) continue
    const kingSq = findKingSquare(step.board, turn)
    if (kingSq >= 0 && !isSquareAttacked(step.board, kingSq, enemy)) {
      return true
    }
  }

  return false
}

function encodeBoardCompact(board: ReadonlyArray<ChessPiece | null>): string {
  let out = ''
  for (let sq = 0; sq < 64; sq += 1) {
    const p = board[sq]
    if (!p) {
      out += '.'
    } else {
      out += p.color === 'w' ? p.type.toUpperCase() : p.type
    }
  }
  return out
}

function decodeBoardCompact(encoded: string): Array<ChessPiece | null> | null {
  if (typeof encoded !== 'string' || encoded.length !== 64) return null
  const board: Array<ChessPiece | null> = new Array<ChessPiece | null>(64).fill(null)
  for (let sq = 0; sq < 64; sq += 1) {
    const ch = encoded[sq]
    if (ch === '.') continue
    const lower = ch.toLowerCase()
    if (!VALID_PIECES.has(lower)) return null
    const color: ChessColor = ch === lower ? 'b' : 'w'
    board[sq] = { type: lower as ChessPieceType, color }
  }
  return board
}

function computePositionKey(
  board: ReadonlyArray<ChessPiece | null>,
  turn: ChessColor,
  castling: ChessCastlingRights,
  enPassant: number | null,
): string {
  const castleStr =
    (castling.wK ? 'K' : '') +
    (castling.wQ ? 'Q' : '') +
    (castling.bK ? 'k' : '') +
    (castling.bQ ? 'q' : '')
  const epPart =
    enPassant !== null && hasLegalEnPassantCapture(board, turn, enPassant)
      ? squareToAlgebraic(enPassant)
      : '-'
  return `${encodeBoardCompact(board)}|${turn}|${castleStr || '-'}|${epPart}`
}

function isInsufficientMaterial(board: ReadonlyArray<ChessPiece | null>): boolean {
  let minorCount = 0
  let knightCount = 0
  let bishopSquareColor: number | null = null
  let allBishopsSameColor = true

  for (let sq = 0; sq < 64; sq += 1) {
    const p = board[sq]
    if (!p || p.type === 'k') continue
    if (p.type === 'p' || p.type === 'r' || p.type === 'q') {
      return false
    }
    minorCount += 1
    if (p.type === 'n') {
      knightCount += 1
    } else if (p.type === 'b') {
      const sqColor = (Math.floor(sq / 8) + (sq % 8)) % 2
      if (bishopSquareColor === null) {
        bishopSquareColor = sqColor
      } else if (bishopSquareColor !== sqColor) {
        allBishopsSameColor = false
      }
    }
  }

  // K vs K, K+B vs K, K+N vs K
  if (minorCount <= 1) return true

  // K+B vs K+B (or multiple bishops) all on the same square color with zero knights
  if (knightCount === 0 && allBishopsSameColor) return true

  return false
}

function formatSan(
  state: ChessState,
  move: ChessMove,
  piece: ChessPiece,
  step: ExecutedBoardStep,
  allLegalMoves: readonly ChessMove[],
  isCheck: boolean,
  isCheckmate: boolean,
): string {
  const checkSuffix = isCheckmate ? '#' : isCheck ? '+' : ''

  if (step.isCastle === 'K') return `O-O${checkSuffix}`
  if (step.isCastle === 'Q') return `O-O-O${checkSuffix}`

  const toAlg = squareToAlgebraic(move.to)
  const fromRow = Math.floor(move.from / 8)
  const fromCol = move.from % 8

  if (piece.type === 'p') {
    const capturePrefix = step.captured ? `${FILES[fromCol]}x` : ''
    const promoSuffix = move.promotion ? `=${move.promotion.toUpperCase()}` : ''
    return `${capturePrefix}${toAlg}${promoSuffix}${checkSuffix}`
  }

  // Piece disambiguation among other legal moves of the same piece type targeting move.to
  const contenders = allLegalMoves.filter((other) => {
    if (other.from === move.from || other.to !== move.to) return false
    const otherPiece = state.board[other.from]
    return otherPiece?.type === piece.type && otherPiece.color === piece.color
  })

  let disambig = ''
  if (contenders.length > 0) {
    const shareFile = contenders.some((c) => c.from % 8 === fromCol)
    const shareRank = contenders.some((c) => Math.floor(c.from / 8) === fromRow)
    if (!shareFile) {
      disambig = FILES[fromCol]
    } else if (!shareRank) {
      disambig = String(8 - fromRow)
    } else {
      disambig = squareToAlgebraic(move.from)
    }
  }

  const captureStr = step.captured ? 'x' : ''
  return `${PIECE_SAN_LETTER[piece.type]}${disambig}${captureStr}${toAlg}${checkSuffix}`
}

export function createInitialChessState(): ChessState {
  const board: Array<ChessPiece | null> = new Array<ChessPiece | null>(64).fill(null)

  for (let col = 0; col < 8; col += 1) {
    board[col] = { type: BACK_RANK[col], color: 'b' }
    board[8 + col] = { type: 'p', color: 'b' }
    board[48 + col] = { type: 'p', color: 'w' }
    board[56 + col] = { type: BACK_RANK[col], color: 'w' }
  }

  const castling: ChessCastlingRights = { wK: true, wQ: true, bK: true, bQ: true }
  const initialPosKey = computePositionKey(board, 'w', castling, null)

  return {
    board,
    turn: 'w',
    castling,
    enPassant: null,
    halfmoveClock: 0,
    fullmoveNumber: 1,
    history: [],
    positionCounts: { [initialPosKey]: 1 },
    capturedByWhite: [],
    capturedByBlack: [],
    status: 'active',
    winner: null,
    termination: null,
    drawOfferBy: null,
    lastMove: null,
    inCheck: false,
  }
}

export function getLegalMoves(state: ChessState, fromSq?: number): ChessMove[] {
  if (state.status !== 'active') return []
  return generateLegalMovesForPosition(
    state.board,
    state.turn,
    state.castling,
    state.enPassant,
    fromSq,
  )
}

export function applyChessMove(state: ChessState, move: ChessMove): ChessState | null {
  if (state.status !== 'active') return null
  if (!isValidSquare(move.from) || !isValidSquare(move.to)) return null

  const movingPiece = state.board[move.from]
  if (!movingPiece || movingPiece.color !== state.turn) return null

  // Validate promotion matches legal move set (defaulting omitted promotion on pawn promo fails safely unless provided)
  const allLegalMoves = generateLegalMovesForPosition(
    state.board,
    state.turn,
    state.castling,
    state.enPassant,
  )

  const matchedMove = allLegalMoves.find(
    (legal) =>
      legal.from === move.from &&
      legal.to === move.to &&
      (legal.promotion ?? undefined) === (move.promotion ?? undefined),
  )
  if (!matchedMove) return null

  const step = executeMoveOnBoard(state.board, matchedMove, state.enPassant)
  if (!step) return null

  // Update castling rights whenever king or corner rooks move OR a corner rook is captured
  const nextCastling: ChessCastlingRights = { ...state.castling }
  if (matchedMove.from === 60 || (movingPiece.type === 'k' && movingPiece.color === 'w')) {
    nextCastling.wK = false
    nextCastling.wQ = false
  }
  if (matchedMove.from === 4 || (movingPiece.type === 'k' && movingPiece.color === 'b')) {
    nextCastling.bK = false
    nextCastling.bQ = false
  }
  if (matchedMove.from === 56 || matchedMove.to === 56) nextCastling.wQ = false
  if (matchedMove.from === 63 || matchedMove.to === 63) nextCastling.wK = false
  if (matchedMove.from === 0 || matchedMove.to === 0) nextCastling.bQ = false
  if (matchedMove.from === 7 || matchedMove.to === 7) nextCastling.bK = false

  // Update en passant target square on double pawn push
  const fromRow = Math.floor(matchedMove.from / 8)
  const toRow = Math.floor(matchedMove.to / 8)
  let nextEnPassant: number | null = null
  if (movingPiece.type === 'p' && Math.abs(toRow - fromRow) === 2) {
    nextEnPassant = ((fromRow + toRow) / 2) * 8 + (matchedMove.from % 8)
  }

  const nextTurn = oppositeColor(state.turn)
  const nextHalfmoveClock =
    movingPiece.type === 'p' || step.captured ? 0 : state.halfmoveClock + 1
  const nextFullmoveNumber = state.turn === 'b' ? state.fullmoveNumber + 1 : state.fullmoveNumber

  const capturedByWhite = state.capturedByWhite.slice()
  const capturedByBlack = state.capturedByBlack.slice()
  if (step.captured) {
    if (state.turn === 'w') {
      capturedByWhite.push(step.captured)
    } else {
      capturedByBlack.push(step.captured)
    }
  }

  // Evaluate opponent check & legal responses
  const enemyKingSq = findKingSquare(step.board, nextTurn)
  const opponentInCheck = enemyKingSq >= 0 && isSquareAttacked(step.board, enemyKingSq, state.turn)
  const opponentLegalMoves = generateLegalMovesForPosition(
    step.board,
    nextTurn,
    nextCastling,
    nextEnPassant,
  )

  const posKey = computePositionKey(step.board, nextTurn, nextCastling, nextEnPassant)
  const nextPositionCounts: Record<string, number> = {
    ...state.positionCounts,
    [posKey]: (state.positionCounts[posKey] ?? 0) + 1,
  }

  let status: 'active' | 'finished' = 'active'
  let winner: ChessColor | 'draw' | null = null
  let termination: ChessTermination | null = null

  if (opponentLegalMoves.length === 0) {
    status = 'finished'
    if (opponentInCheck) {
      winner = state.turn
      termination = 'checkmate'
    } else {
      winner = 'draw'
      termination = 'stalemate'
    }
  } else if (isInsufficientMaterial(step.board)) {
    status = 'finished'
    winner = 'draw'
    termination = 'insufficient'
  } else if (nextPositionCounts[posKey] >= 3) {
    status = 'finished'
    winner = 'draw'
    termination = 'threefold'
  } else if (nextHalfmoveClock >= 100) {
    status = 'finished'
    winner = 'draw'
    termination = 'fifty-move'
  }

  const isCheckmate = termination === 'checkmate'
  const san = formatSan(
    state,
    matchedMove,
    movingPiece,
    step,
    allLegalMoves,
    opponentInCheck,
    isCheckmate,
  )

  const record: ChessMoveRecord = {
    from: matchedMove.from,
    to: matchedMove.to,
    ...(matchedMove.promotion ? { promotion: matchedMove.promotion } : {}),
    san,
    piece: movingPiece.type,
    color: state.turn,
    ...(step.captured ? { captured: step.captured } : {}),
    ...(step.isCastle ? { isCastle: step.isCastle } : {}),
    ...(step.isEnPassant ? { isEnPassant: true } : {}),
    ...(opponentInCheck ? { isCheck: true } : {}),
    ...(isCheckmate ? { isCheckmate: true } : {}),
  }

  return {
    board: step.board,
    turn: nextTurn,
    castling: nextCastling,
    enPassant: nextEnPassant,
    halfmoveClock: nextHalfmoveClock,
    fullmoveNumber: nextFullmoveNumber,
    history: [...state.history, record],
    positionCounts: nextPositionCounts,
    capturedByWhite,
    capturedByBlack,
    status,
    winner,
    termination,
    drawOfferBy: null,
    lastMove: { from: matchedMove.from, to: matchedMove.to },
    inCheck: opponentInCheck,
  }
}

export function applyChessResign(state: ChessState, resigningColor: ChessColor): ChessState {
  if (state.status !== 'active') return state
  return {
    ...state,
    status: 'finished',
    winner: oppositeColor(resigningColor),
    termination: 'resign',
    drawOfferBy: null,
  }
}

export function applyChessDrawOffer(state: ChessState, byColor: ChessColor): ChessState {
  if (state.status !== 'active') return state
  return {
    ...state,
    drawOfferBy: byColor,
  }
}

export function applyChessDrawResponse(state: ChessState, accept: boolean): ChessState {
  if (state.status !== 'active' || state.drawOfferBy === null) return state
  if (accept) {
    return {
      ...state,
      status: 'finished',
      winner: 'draw',
      termination: 'draw-agreement',
      drawOfferBy: null,
    }
  }
  return {
    ...state,
    drawOfferBy: null,
  }
}

export function getMaterialBalance(state: ChessState): { whiteAdvantage: number } {
  let score = 0
  for (let sq = 0; sq < 64; sq += 1) {
    const p = state.board[sq]
    if (!p) continue
    const val = PIECE_VALUES[p.type]
    score += p.color === 'w' ? val : -val
  }
  return { whiteAdvantage: score }
}

interface SerializedChessState {
  v: 1
  b: string
  t: ChessColor
  c: string
  ep: number | null
  hm: number
  fm: number
  h: ChessMoveRecord[]
  pc: Record<string, number>
  cw: ChessPieceType[]
  cb: ChessPieceType[]
  s: 'active' | 'finished'
  w: ChessColor | 'draw' | null
  term: ChessTermination | null
  do: ChessColor | null
  lm: [number, number] | null
  ic: boolean
}

export function serializeChessState(state: ChessState): string {
  const castleStr =
    (state.castling.wK ? 'K' : '') +
    (state.castling.wQ ? 'Q' : '') +
    (state.castling.bK ? 'k' : '') +
    (state.castling.bQ ? 'q' : '')

  const payload: SerializedChessState = {
    v: 1,
    b: encodeBoardCompact(state.board),
    t: state.turn,
    c: castleStr,
    ep: state.enPassant,
    hm: state.halfmoveClock,
    fm: state.fullmoveNumber,
    h: state.history,
    pc: state.positionCounts,
    cw: state.capturedByWhite,
    cb: state.capturedByBlack,
    s: state.status,
    w: state.winner,
    term: state.termination,
    do: state.drawOfferBy,
    lm: state.lastMove ? [state.lastMove.from, state.lastMove.to] : null,
    ic: state.inCheck,
  }

  return JSON.stringify(payload)
}

function isValidMoveRecord(raw: unknown): raw is ChessMoveRecord {
  if (!raw || typeof raw !== 'object') return false
  const rec = raw as Record<string, unknown>
  if (!isValidSquare(rec.from as number) || !isValidSquare(rec.to as number)) return false
  if (typeof rec.san !== 'string' || rec.san.length === 0) return false
  if (typeof rec.piece !== 'string' || !VALID_PIECES.has(rec.piece)) return false
  if (typeof rec.color !== 'string' || !VALID_COLORS.has(rec.color)) return false
  if (
    rec.promotion !== undefined &&
    (typeof rec.promotion !== 'string' || !VALID_PROMOTIONS.has(rec.promotion))
  ) {
    return false
  }
  if (
    rec.captured !== undefined &&
    (typeof rec.captured !== 'string' || !VALID_PIECES.has(rec.captured))
  ) {
    return false
  }
  if (rec.isCastle !== undefined && rec.isCastle !== 'K' && rec.isCastle !== 'Q') return false
  if (rec.isEnPassant !== undefined && typeof rec.isEnPassant !== 'boolean') return false
  if (rec.isCheck !== undefined && typeof rec.isCheck !== 'boolean') return false
  if (rec.isCheckmate !== undefined && typeof rec.isCheckmate !== 'boolean') return false
  return true
}

function parsePieceArray(raw: unknown): ChessPieceType[] | null {
  if (!Array.isArray(raw)) return null
  const out: ChessPieceType[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !VALID_PIECES.has(item)) return null
    out.push(item as ChessPieceType)
  }
  return out
}

export function deserializeChessState(raw: string): ChessState | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (obj.v !== 1) return null

  const board = decodeBoardCompact(obj.b as string)
  if (!board) return null

  if (typeof obj.t !== 'string' || !VALID_COLORS.has(obj.t)) return null
  const turn = obj.t as ChessColor

  if (typeof obj.c !== 'string') return null
  const castling: ChessCastlingRights = {
    wK: obj.c.includes('K'),
    wQ: obj.c.includes('Q'),
    bK: obj.c.includes('k'),
    bQ: obj.c.includes('q'),
  }

  let enPassant: number | null = null
  if (obj.ep !== null) {
    if (typeof obj.ep !== 'number' || !isValidSquare(obj.ep)) return null
    enPassant = obj.ep
  }

  if (
    typeof obj.hm !== 'number' ||
    !Number.isInteger(obj.hm) ||
    obj.hm < 0 ||
    typeof obj.fm !== 'number' ||
    !Number.isInteger(obj.fm) ||
    obj.fm < 1
  ) {
    return null
  }

  if (!Array.isArray(obj.h) || !obj.h.every(isValidMoveRecord)) return null

  if (!obj.pc || typeof obj.pc !== 'object' || Array.isArray(obj.pc)) return null
  const positionCounts: Record<string, number> = {}
  for (const [k, v] of Object.entries(obj.pc as Record<string, unknown>)) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return null
    positionCounts[k] = v
  }

  const capturedByWhite = parsePieceArray(obj.cw)
  const capturedByBlack = parsePieceArray(obj.cb)
  if (!capturedByWhite || !capturedByBlack) return null

  if (obj.s !== 'active' && obj.s !== 'finished') return null
  const status = obj.s

  let winner: ChessColor | 'draw' | null = null
  if (obj.w !== null) {
    if (obj.w !== 'w' && obj.w !== 'b' && obj.w !== 'draw') return null
    winner = obj.w
  }

  let termination: ChessTermination | null = null
  if (obj.term !== null) {
    if (typeof obj.term !== 'string' || !VALID_TERMINATIONS.has(obj.term)) return null
    termination = obj.term as ChessTermination
  }

  let drawOfferBy: ChessColor | null = null
  if (obj.do !== null) {
    if (typeof obj.do !== 'string' || !VALID_COLORS.has(obj.do)) return null
    drawOfferBy = obj.do as ChessColor
  }

  let lastMove: { from: number; to: number } | null = null
  if (obj.lm !== null) {
    if (
      !Array.isArray(obj.lm) ||
      obj.lm.length !== 2 ||
      !isValidSquare(obj.lm[0] as number) ||
      !isValidSquare(obj.lm[1] as number)
    ) {
      return null
    }
    lastMove = { from: obj.lm[0] as number, to: obj.lm[1] as number }
  }

  if (typeof obj.ic !== 'boolean') return null

  return {
    board,
    turn,
    castling,
    enPassant,
    halfmoveClock: obj.hm,
    fullmoveNumber: obj.fm,
    history: obj.h.map((m) => ({ ...m })),
    positionCounts,
    capturedByWhite,
    capturedByBlack,
    status,
    winner,
    termination,
    drawOfferBy,
    lastMove,
    inCheck: obj.ic,
  }
}
