export type GoBoardSize = 9 | 13 | 19

export type GoColor = 'b' | 'w'

export type GoScoringRules = 'chinese' | 'japanese'

export interface GoConfig {
  boardSize: GoBoardSize
  komi: number
  handicap: number
  scoring: GoScoringRules
}

export interface GoPoint {
  row: number
  col: number
}

export type GoMove = { type: 'play'; row: number; col: number } | { type: 'pass' }

export interface GoScoreBreakdown {
  rules: GoScoringRules
  blackTerritory: number
  whiteTerritory: number
  blackStonesOnBoard: number
  whiteStonesOnBoard: number
  blackCaptures: number
  whiteCaptures: number
  blackDeadStones: number
  whiteDeadStones: number
  komi: number
  blackTotal: number
  whiteTotal: number
  winner: GoColor | 'draw'
  margin: number
  territoryMap: Array<GoColor | null>
}

export interface GoState {
  config: GoConfig
  board: Array<GoColor | null>
  turn: GoColor
  capturesByBlack: number
  capturesByWhite: number
  consecutivePasses: number
  koPoint: number | null
  previousBoardHash: string | null
  moveCount: number
  lastMove: GoMove | null
  phase: 'playing' | 'scoring' | 'finished'
  deadStones: number[]
  scoreAcceptedBy: { b: boolean; w: boolean }
  winner: GoColor | 'draw' | null
  termination: 'score' | 'resign' | null
  finalScore: GoScoreBreakdown | null
}

export type GoMoveLegality =
  | { ok: true }
  | { ok: false; reason: 'occupied' | 'suicide' | 'ko' | 'phase' | 'bounds' }

export const GO_COL_LETTERS = 'ABCDEFGHJKLMNOPQRST'

function oppositeColor(color: GoColor): GoColor {
  return color === 'b' ? 'w' : 'b'
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100
}

function hashBoard(board: readonly (GoColor | null)[]): string {
  let out = ''
  for (let i = 0; i < board.length; i++) {
    const cell = board[i]
    out += cell === 'b' ? 'b' : cell === 'w' ? 'w' : '.'
  }
  return out
}

function getNeighborIndices(size: number, idx: number): number[] {
  const row = Math.floor(idx / size)
  const col = idx % size
  const neighbors: number[] = []
  if (row > 0) neighbors.push(idx - size)
  if (row < size - 1) neighbors.push(idx + size)
  if (col > 0) neighbors.push(idx - 1)
  if (col < size - 1) neighbors.push(idx + 1)
  return neighbors
}

interface StoneGroup {
  color: GoColor
  stones: number[]
  liberties: Set<number>
}

function collectGroup(
  board: readonly (GoColor | null)[],
  size: number,
  startIdx: number
): StoneGroup | null {
  const color = board[startIdx]
  if (!color) return null

  const visited = new Set<number>([startIdx])
  const stones: number[] = []
  const liberties = new Set<number>()
  const stack: number[] = [startIdx]

  while (stack.length > 0) {
    const cur = stack.pop()!
    stones.push(cur)
    const neighbors = getNeighborIndices(size, cur)
    for (let i = 0; i < neighbors.length; i++) {
      const nIdx = neighbors[i]
      const nVal = board[nIdx]
      if (nVal === null) {
        liberties.add(nIdx)
      } else if (nVal === color && !visited.has(nIdx)) {
        visited.add(nIdx)
        stack.push(nIdx)
      }
    }
  }

  return { color, stones, liberties }
}

interface SimulatedPlay {
  nextBoard: Array<GoColor | null>
  capturedStones: number[]
  nextKoPoint: number | null
}

function simulatePlay(
  state: GoState,
  row: number,
  col: number
): { ok: true; sim: SimulatedPlay } | { ok: false; reason: 'occupied' | 'suicide' | 'ko' | 'phase' | 'bounds' } {
  if (state.phase !== 'playing') {
    return { ok: false, reason: 'phase' }
  }
  const size = state.config.boardSize
  if (
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    row < 0 ||
    row >= size ||
    col < 0 ||
    col >= size
  ) {
    return { ok: false, reason: 'bounds' }
  }

  const idx = row * size + col
  if (state.board[idx] !== null) {
    return { ok: false, reason: 'occupied' }
  }
  if (state.koPoint !== null && state.koPoint === idx) {
    return { ok: false, reason: 'ko' }
  }

  const nextBoard = state.board.slice()
  const turn = state.turn
  const opponent = oppositeColor(turn)
  nextBoard[idx] = turn

  const capturedStones: number[] = []
  const checkedOpponentStones = new Set<number>()
  const neighbors = getNeighborIndices(size, idx)

  for (let i = 0; i < neighbors.length; i++) {
    const nIdx = neighbors[i]
    if (nextBoard[nIdx] !== opponent || checkedOpponentStones.has(nIdx)) continue
    const oppGroup = collectGroup(nextBoard, size, nIdx)
    if (!oppGroup) continue
    for (const s of oppGroup.stones) {
      checkedOpponentStones.add(s)
    }
    if (oppGroup.liberties.size === 0) {
      for (const s of oppGroup.stones) {
        nextBoard[s] = null
        capturedStones.push(s)
      }
    }
  }

  const placedGroup = collectGroup(nextBoard, size, idx)
  if (!placedGroup || placedGroup.liberties.size === 0) {
    return { ok: false, reason: 'suicide' }
  }

  // Guard against exact 1-ply simple Ko board repetition
  if (
    capturedStones.length > 0 &&
    state.previousBoardHash !== null &&
    hashBoard(nextBoard) === state.previousBoardHash
  ) {
    return { ok: false, reason: 'ko' }
  }

  const nextKoPoint =
    capturedStones.length === 1 &&
    placedGroup.stones.length === 1 &&
    placedGroup.liberties.size === 1
      ? capturedStones[0]
      : null

  return {
    ok: true,
    sim: {
      nextBoard,
      capturedStones,
      nextKoPoint,
    },
  }
}

/**
 * Returns the authentic hoshi (star) intersections for 9x9, 13x13, or 19x19 Go boards.
 */
export function getGoStarPoints(size: GoBoardSize): GoPoint[] {
  if (size === 9) {
    return [
      { row: 2, col: 2 },
      { row: 2, col: 6 },
      { row: 4, col: 4 },
      { row: 6, col: 2 },
      { row: 6, col: 6 },
    ]
  }
  if (size === 13) {
    return [
      { row: 3, col: 3 },
      { row: 3, col: 9 },
      { row: 6, col: 6 },
      { row: 9, col: 3 },
      { row: 9, col: 9 },
    ]
  }
  return [
    { row: 3, col: 3 },
    { row: 3, col: 9 },
    { row: 3, col: 15 },
    { row: 9, col: 3 },
    { row: 9, col: 9 },
    { row: 9, col: 15 },
    { row: 15, col: 3 },
    { row: 15, col: 9 },
    { row: 15, col: 15 },
  ]
}

/**
 * Maximum standard star-point handicap stones for a given board size.
 */
export function getMaxHandicap(size: GoBoardSize): number {
  return size === 9 ? 4 : 9
}

/**
 * Returns traditional star-point handicap stone coordinates (for 2..maxHandicap stones).
 */
export function getHandicapPoints(size: GoBoardSize, handicap: number): GoPoint[] {
  const max = getMaxHandicap(size)
  const h = Math.max(0, Math.min(max, Math.floor(handicap)))
  if (h < 2) return []

  const lo = size === 9 ? 2 : 3
  const hi = size - 1 - lo
  const mid = (size - 1) >> 1

  const tr: GoPoint = { row: lo, col: hi }
  const bl: GoPoint = { row: hi, col: lo }
  const br: GoPoint = { row: hi, col: hi }
  const tl: GoPoint = { row: lo, col: lo }
  const center: GoPoint = { row: mid, col: mid }
  const left: GoPoint = { row: mid, col: lo }
  const right: GoPoint = { row: mid, col: hi }
  const top: GoPoint = { row: lo, col: mid }
  const bottom: GoPoint = { row: hi, col: mid }

  switch (h) {
    case 2:
      return [tr, bl]
    case 3:
      return [tr, bl, br]
    case 4:
      return [tr, bl, br, tl]
    case 5:
      return [tr, bl, br, tl, center]
    case 6:
      return [tr, bl, br, tl, left, right]
    case 7:
      return [tr, bl, br, tl, left, right, center]
    case 8:
      return [tr, bl, br, tl, left, right, top, bottom]
    default:
      return [tr, bl, br, tl, left, right, top, bottom, center]
  }
}

/**
 * Creates a fresh Go game state, placing handicap stones for Black when `handicap >= 2`
 * and giving White the opening move in handicap games.
 */
export function createInitialGoState(config: GoConfig): GoState {
  const size = config.boardSize
  const clampedHandicap = Math.max(
    0,
    Math.min(getMaxHandicap(size), Math.floor(Number.isFinite(config.handicap) ? config.handicap : 0))
  )
  const normalizedKomi = Number.isFinite(config.komi) ? roundScore(config.komi) : 0
  const normalizedConfig: GoConfig = {
    boardSize: size,
    komi: normalizedKomi,
    handicap: clampedHandicap,
    scoring: config.scoring === 'japanese' ? 'japanese' : 'chinese',
  }

  const board = new Array<GoColor | null>(size * size).fill(null)
  const handicapPoints = getHandicapPoints(size, clampedHandicap)
  for (const pt of handicapPoints) {
    board[pt.row * size + pt.col] = 'b'
  }

  return {
    config: normalizedConfig,
    board,
    turn: handicapPoints.length >= 2 ? 'w' : 'b',
    capturesByBlack: 0,
    capturesByWhite: 0,
    consecutivePasses: 0,
    koPoint: null,
    previousBoardHash: null,
    moveCount: 0,
    lastMove: null,
    phase: 'playing',
    deadStones: [],
    scoreAcceptedBy: { b: false, w: false },
    winner: null,
    termination: null,
    finalScore: null,
  }
}

/**
 * Checks whether placing the active player's stone at `(row, col)` is legal.
 */
export function checkGoMoveLegality(state: GoState, row: number, col: number): GoMoveLegality {
  const res = simulatePlay(state, row, col)
  return res.ok ? { ok: true } : res
}

/**
 * Applies a play or pass move deterministically, returning the next state and captured stone count,
 * or `null` if the move is illegal. Two consecutive passes enter `phase: 'scoring'`.
 */
export function applyGoMove(
  state: GoState,
  move: GoMove
): { state: GoState; capturedCount: number } | null {
  if (state.phase !== 'playing') return null

  if (move.type === 'pass') {
    const nextPasses = state.consecutivePasses + 1
    const enteringScoring = nextPasses >= 2
    return {
      capturedCount: 0,
      state: {
        ...state,
        turn: oppositeColor(state.turn),
        consecutivePasses: nextPasses,
        koPoint: null,
        previousBoardHash: null,
        moveCount: state.moveCount + 1,
        lastMove: { type: 'pass' },
        phase: enteringScoring ? 'scoring' : 'playing',
        deadStones: enteringScoring ? [] : state.deadStones,
        scoreAcceptedBy: enteringScoring
          ? { b: false, w: false }
          : state.scoreAcceptedBy,
      },
    }
  }

  const res = simulatePlay(state, move.row, move.col)
  if (!res.ok) return null

  const { nextBoard, capturedStones, nextKoPoint } = res.sim
  const capturedCount = capturedStones.length
  const nextCapturesByBlack =
    state.turn === 'b' ? state.capturesByBlack + capturedCount : state.capturesByBlack
  const nextCapturesByWhite =
    state.turn === 'w' ? state.capturesByWhite + capturedCount : state.capturesByWhite

  return {
    capturedCount,
    state: {
      ...state,
      board: nextBoard,
      turn: oppositeColor(state.turn),
      capturesByBlack: nextCapturesByBlack,
      capturesByWhite: nextCapturesByWhite,
      consecutivePasses: 0,
      koPoint: nextKoPoint,
      previousBoardHash: hashBoard(state.board),
      moveCount: state.moveCount + 1,
      lastMove: { type: 'play', row: move.row, col: move.col },
    },
  }
}

/**
 * In scoring phase, toggles the entire connected stone group at `(row, col)` in/out of `deadStones`
 * and resets both players' score confirmation flags.
 */
export function toggleGoDeadGroup(state: GoState, row: number, col: number): GoState {
  if (state.phase !== 'scoring') return state
  const size = state.config.boardSize
  if (
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    row < 0 ||
    row >= size ||
    col < 0 ||
    col >= size
  ) {
    return state
  }

  const idx = row * size + col
  const group = collectGroup(state.board, size, idx)
  if (!group) return state

  const deadSet = new Set<number>(state.deadStones)
  const currentlyDead = deadSet.has(idx)
  for (const s of group.stones) {
    if (currentlyDead) {
      deadSet.delete(s)
    } else {
      deadSet.add(s)
    }
  }

  const nextDeadStones = Array.from(deadSet).sort((a, b) => a - b)

  return {
    ...state,
    deadStones: nextDeadStones,
    scoreAcceptedBy: { b: false, w: false },
  }
}

/**
 * Computes live Chinese (Area) or Japanese (Territory) score breakdown, including
 * territory ownership map (excluding dead stones) and exact komi handling.
 */
export function computeGoScore(state: GoState): GoScoreBreakdown {
  const size = state.config.boardSize
  const totalCells = size * size
  const deadSet = new Set<number>()

  for (const idx of state.deadStones) {
    if (idx >= 0 && idx < totalCells && state.board[idx] !== null) {
      deadSet.add(idx)
    }
  }

  const liveBoard = new Array<GoColor | null>(totalCells).fill(null)
  let blackStonesOnBoard = 0
  let whiteStonesOnBoard = 0
  let blackDeadStones = 0
  let whiteDeadStones = 0

  for (let i = 0; i < totalCells; i++) {
    const stone = state.board[i]
    if (stone === 'b') {
      if (deadSet.has(i)) {
        blackDeadStones += 1
      } else {
        blackStonesOnBoard += 1
        liveBoard[i] = 'b'
      }
    } else if (stone === 'w') {
      if (deadSet.has(i)) {
        whiteDeadStones += 1
      } else {
        whiteStonesOnBoard += 1
        liveBoard[i] = 'w'
      }
    }
  }

  const territoryMap = new Array<GoColor | null>(totalCells).fill(null)
  const visitedEmpty = new Uint8Array(totalCells)
  let blackTerritory = 0
  let whiteTerritory = 0

  for (let i = 0; i < totalCells; i++) {
    if (liveBoard[i] !== null || visitedEmpty[i] === 1) continue

    const region: number[] = []
    const stack: number[] = [i]
    visitedEmpty[i] = 1
    let touchesBlack = false
    let touchesWhite = false

    while (stack.length > 0) {
      const cur = stack.pop()!
      region.push(cur)
      const neighbors = getNeighborIndices(size, cur)
      for (let k = 0; k < neighbors.length; k++) {
        const nIdx = neighbors[k]
        const nVal = liveBoard[nIdx]
        if (nVal === 'b') {
          touchesBlack = true
        } else if (nVal === 'w') {
          touchesWhite = true
        } else if (visitedEmpty[nIdx] === 0) {
          visitedEmpty[nIdx] = 1
          stack.push(nIdx)
        }
      }
    }

    let owner: GoColor | null = null
    if (touchesBlack && !touchesWhite) {
      owner = 'b'
      blackTerritory += region.length
    } else if (touchesWhite && !touchesBlack) {
      owner = 'w'
      whiteTerritory += region.length
    }

    if (owner !== null) {
      for (let r = 0; r < region.length; r++) {
        territoryMap[region[r]] = owner
      }
    }
  }

  const komi = Number.isFinite(state.config.komi) ? roundScore(state.config.komi) : 0
  const rules = state.config.scoring

  const blackTotal =
    rules === 'chinese'
      ? roundScore(blackTerritory + blackStonesOnBoard)
      : roundScore(blackTerritory + state.capturesByBlack + whiteDeadStones)

  const whiteTotal =
    rules === 'chinese'
      ? roundScore(whiteTerritory + whiteStonesOnBoard + komi)
      : roundScore(whiteTerritory + state.capturesByWhite + blackDeadStones + komi)

  const diff = roundScore(blackTotal - whiteTotal)
  const winner: GoColor | 'draw' = diff > 0 ? 'b' : diff < 0 ? 'w' : 'draw'
  const margin = Math.abs(diff)

  return {
    rules,
    blackTerritory,
    whiteTerritory,
    blackStonesOnBoard,
    whiteStonesOnBoard,
    blackCaptures: state.capturesByBlack,
    whiteCaptures: state.capturesByWhite,
    blackDeadStones,
    whiteDeadStones,
    komi,
    blackTotal,
    whiteTotal,
    winner,
    margin,
    territoryMap,
  }
}

/**
 * Confirms the current dead-stone arrangement for `color`. When both Black and White confirm,
 * finalizes the score and finishes the game.
 */
export function acceptGoScore(state: GoState, color: GoColor): GoState {
  if (state.phase !== 'scoring') return state

  const nextAccepted = {
    ...state.scoreAcceptedBy,
    [color]: true,
  }

  if (nextAccepted.b && nextAccepted.w) {
    const finalScore = computeGoScore(state)
    return {
      ...state,
      scoreAcceptedBy: nextAccepted,
      phase: 'finished',
      termination: 'score',
      finalScore,
      winner: finalScore.winner,
    }
  }

  return {
    ...state,
    scoreAcceptedBy: nextAccepted,
  }
}

/**
 * Exits scoring phase back to active play, clearing dead-stone markings and pass streak.
 */
export function resumeGoFromScoring(state: GoState, nextTurn?: GoColor): GoState {
  if (state.phase !== 'scoring') return state
  return {
    ...state,
    phase: 'playing',
    turn: nextTurn ?? state.turn,
    deadStones: [],
    consecutivePasses: 0,
    koPoint: null,
    scoreAcceptedBy: { b: false, w: false },
    winner: null,
    termination: null,
    finalScore: null,
  }
}

/**
 * Applies resignation for `resigningColor`, awarding victory to the opponent.
 */
export function applyGoResign(state: GoState, resigningColor: GoColor): GoState {
  if (state.phase === 'finished') return state
  return {
    ...state,
    phase: 'finished',
    winner: oppositeColor(resigningColor),
    termination: 'resign',
    finalScore: null,
  }
}

/**
 * Formats a 0-indexed `(row, col)` point into standard Go coordinates (`A–T` skipping `I`, `1..size` from bottom).
 */
export function formatGoCoord(size: GoBoardSize, row: number, col: number): string {
  if (
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    row < 0 ||
    row >= size ||
    col < 0 ||
    col >= size
  ) {
    return ''
  }
  const letter = GO_COL_LETTERS[col]
  if (!letter) return ''
  return `${letter}${size - row}`
}
