import type { ActiveChessSession, ActiveGoSession, ActivePokerSession } from '../../types/games'
import {
  createInitialChessState,
  deserializeChessState,
  type ChessState,
} from '../../lib/games/chessEngine.ts'
import { createInitialGoState, type GoState } from '../../lib/games/goEngine.ts'
import type { PokerPublicState } from '../../lib/games/pokerEngine.ts'

export function parseChessSessionState(session: ActiveChessSession): ChessState {
  return deserializeChessState(session.stateJson) ?? createInitialChessState()
}

export function parseGoSessionState(session: ActiveGoSession): GoState {
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

export function parsePokerSessionState(session: ActivePokerSession): PokerPublicState | null {
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
