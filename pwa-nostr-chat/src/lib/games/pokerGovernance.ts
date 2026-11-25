import type { PokerPublicState } from './pokerEngine.ts'

export const POKER_KEY_RE = /^[0-9a-f]{64}$/

export function pokerRosterRound(state: PokerPublicState): string {
  // Independent of hand/action state, but never recycled after a seat change.
  return JSON.stringify([
    state.rosterRevision ?? 0,
    state.hostPubkey,
    state.seats.map(({ pubkey }) => pubkey).sort(),
  ])
}

export function pokerVoteThreshold(seats: number): number {
  return seats >= 3 && seats <= 8 ? Math.floor(seats / 2) + 1 : Infinity
}

export interface PokerBallot {
  tableId: string
  room: string
  round: string
  target: string
}

/** Call only after verifying the room event and signer. */
export function qualifiesPokerBallot(
  state: PokerPublicState, room: string, ballot: PokerBallot, signer: string,
): boolean {
  return state.phase !== 'finished' && state.seats.length >= 3 &&
    ballot.tableId === state.tableId && ballot.room === room && ballot.round === pokerRosterRound(state) &&
    POKER_KEY_RE.test(signer) && POKER_KEY_RE.test(ballot.target) && ballot.target !== signer &&
    !state.expelledPubkeys?.includes(signer) &&
    state.seats.some((seat) => seat.pubkey === signer) &&
    state.seats.some((seat) => seat.pubkey === ballot.target)
}

export function addPokerBallot<T>(
  state: PokerPublicState, room: string, ballot: PokerBallot, signer: string, evidence: T,
  all: Map<string, Map<string, T>>,
): T[] | null {
  if (!qualifiesPokerBallot(state, room, ballot, signer)) return null
  const votes = all.get(ballot.target) ?? new Map<string, T>()
  votes.set(signer, evidence)
  all.set(ballot.target, votes)
  return votes.size >= pokerVoteThreshold(state.seats.length) ? [...votes.values()] : null
}

/** A membership transition is calculated by each informed peer. Never ask
 * a successor to reconstruct a private deck already seen by the old dealer. */
export function applyPokerDeparture(
  state: PokerPublicState, target: string, expelled: boolean, at: number,
): PokerPublicState | null {
  const leaving = state.seats.find((seat) => seat.pubkey === target)
  if (!leaving || state.phase === 'finished') return null
  const kept = state.seats.filter((seat) => seat.pubkey !== target)
  const hostChanged = state.hostPubkey === target
  const successor = hostChanged
    ? [...kept].sort((a, b) => a.seatIndex - b.seatIndex)[0]
    : kept.find((seat) => seat.pubkey === state.hostPubkey)
  const unfinished = state.phase !== 'lobby' && state.phase !== 'showdown'
  // A voted removal can happen during a hand. Abort on any departure to
  // avoid orphaned pot/turn state and make the result independent of private cards.
  const seats = kept.map((seat) => ({
    ...seat,
    chips: seat.chips + (unfinished ? seat.totalCommitted : 0),
    betThisStreet: 0,
    totalCommitted: 0,
    folded: false,
    allIn: false,
    actedThisStreet: false,
    sittingOut: false,
    lastActionLabel: undefined,
  }))
  return {
    ...state,
    hostPubkey: successor?.pubkey ?? state.hostPubkey,
    rosterRevision: (state.rosterRevision ?? 0) + 1,
    expelledPubkeys: expelled
      ? [...new Set([...(state.expelledPubkeys ?? []), target])]
      : state.expelledPubkeys,
    seats,
    // Invalidate all pre-transition actions and hole cards even if arriving late.
    handNumber: state.handNumber + (unfinished ? 1 : 0),
    phase: seats.length ? 'lobby' : 'finished',
    dealerSeatIndex: successor?.seatIndex ?? 0,
    smallBlindSeatIndex: null,
    bigBlindSeatIndex: null,
    actingPubkey: null,
    communityCards: [],
    pot: 0,
    currentBet: 0,
    minRaise: state.bigBlind,
    lastActionText: `${leaving.displayName} ${expelled ? 'was voted out' : 'left the table'}${unfinished && seats.length ? ' · hand canceled; remaining bets returned' : ''}`,
    revealedHands: {},
    winners: [],
    updatedAtMs: at,
  }
}
