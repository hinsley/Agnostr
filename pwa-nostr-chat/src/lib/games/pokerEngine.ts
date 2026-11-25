/**
 * Zero-dependency, pure TypeScript No-Limit Texas Hold'em Poker Engine.
 * Supports fixed buy-in tables for 2–8 players with CSPRNG Fisher-Yates shuffling,
 * exact 5–7 card hand evaluation (all 10 categories + wheel straight + kicker tiebreakers),
 * exact Heads-Up & multi-way blind/turn rules, all-in automatic board runout,
 * main + side pot construction, uncalled bet refunds, and clockwise odd-chip splits.
 */

export type CardSuit = 's' | 'h' | 'd' | 'c'
export type CardRank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14

export interface PokerCard {
  rank: CardRank
  suit: CardSuit
}

export type PokerPhase =
  | 'lobby'
  | 'preflop'
  | 'flop'
  | 'turn'
  | 'river'
  | 'showdown'
  | 'finished'

export type PokerActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all-in'

/**
 * Player betting action.
 * For `'bet'` and `'raise'`, `amount` is the target **street total bet**
 * ("bet to" / "raise to" on the current street, NOT an incremental delta).
 */
export interface PokerAction {
  type: PokerActionType
  amount?: number
}

export interface PokerSeat {
  seatIndex: number
  pubkey: string
  displayName: string
  chips: number
  betThisStreet: number
  totalCommitted: number
  folded: boolean
  allIn: boolean
  actedThisStreet: boolean
  sittingOut: boolean
  lastActionLabel?: string
}

export interface PokerEvaluatedHand {
  category: number
  categoryName: string
  label: string
  score: number
  bestFive: PokerCard[]
}

export interface PokerWinnerSummary {
  pubkey: string
  displayName: string
  amountWon: number
  handLabel: string
  potIndex: number
}

export interface PokerPublicState {
  tableId: string
  hostPubkey: string
  rosterRevision?: number
  expelledPubkeys?: string[]
  fixedBuyIn: number
  smallBlind: number
  bigBlind: number
  maxSeats: number
  handNumber: number
  phase: PokerPhase
  seats: PokerSeat[]
  dealerSeatIndex: number
  smallBlindSeatIndex: number | null
  bigBlindSeatIndex: number | null
  actingPubkey: string | null
  communityCards: PokerCard[]
  pot: number
  currentBet: number
  minRaise: number
  lastActionText: string | null
  revealedHands: Record<string, [PokerCard, PokerCard]>
  winners: PokerWinnerSummary[]
  updatedAtMs: number
}

export interface PokerDealerPrivateState {
  deck: PokerCard[]
  holeCards: Record<string, [PokerCard, PokerCard]>
}

export interface PokerLegalActions {
  canFold: boolean
  canCheck: boolean
  callAmount: number
  minBetOrRaiseTo: number
  maxBetOrRaiseTo: number
  isRaise: boolean
}

const SUITS: readonly CardSuit[] = ['s', 'h', 'd', 'c']
const RANKS: readonly CardRank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]

const SUIT_SYMBOLS: Record<CardSuit, string> = {
  s: '♠',
  h: '♥',
  d: '♦',
  c: '♣',
}

const RANK_SHORT: Record<CardRank, string> = {
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
}

const RANK_NAME: Record<CardRank, string> = {
  2: 'Two',
  3: 'Three',
  4: 'Four',
  5: 'Five',
  6: 'Six',
  7: 'Seven',
  8: 'Eight',
  9: 'Nine',
  10: 'Ten',
  11: 'Jack',
  12: 'Queen',
  13: 'King',
  14: 'Ace',
}

const RANK_PLURAL: Record<CardRank, string> = {
  2: 'Twos',
  3: 'Threes',
  4: 'Fours',
  5: 'Fives',
  6: 'Sixes',
  7: 'Sevens',
  8: 'Eights',
  9: 'Nines',
  10: 'Tens',
  11: 'Jacks',
  12: 'Queens',
  13: 'Kings',
  14: 'Aces',
}

function normalizePubkey(pubkey: string): string {
  return pubkey.trim().toLowerCase()
}

function isLiveHandPhase(phase: PokerPhase): boolean {
  return phase === 'preflop' || phase === 'flop' || phase === 'turn' || phase === 'river'
}

/**
 * Returns an unbiased CSPRNG integer in `[0, maxExclusive)`.
 */
function cryptoRandomInt(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const buf = new Uint32Array(1)
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive
    let val = 0
    do {
      cryptoObj.getRandomValues(buf)
      val = buf[0]
    } while (val >= limit)
    return val % maxExclusive
  }
  return Math.floor(Math.random() * maxExclusive)
}

/**
 * Generates a freshly shuffled 52-card standard deck using CSPRNG Fisher-Yates.
 */
export function createShuffledDeck(): PokerCard[] {
  const deck: PokerCard[] = []
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit })
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = cryptoRandomInt(i + 1)
    const tmp = deck[i]
    deck[i] = deck[j]
    deck[j] = tmp
  }
  return deck
}

/**
 * Formats a card concisely for UI display (e.g. `"A♠"`, `"10♥"`).
 */
export function formatCardShort(card: PokerCard): string {
  return `${RANK_SHORT[card.rank]}${SUIT_SYMBOLS[card.suit]}`
}

/**
 * Exact base-15 lexicographic hand score encoder (`category` 0..9, five kickers 0..14).
 * Guaranteed strictly monotonic and well inside IEEE-754 safe integer precision (`< 7.6e6`).
 */
function encodeHandScore(
  category: number,
  k0: number,
  k1: number,
  k2: number,
  k3: number,
  k4: number,
): number {
  return ((((category * 15 + k0) * 15 + k1) * 15 + k2) * 15 + k3) * 15 + k4
}

function evaluateExactFiveCards(five: PokerCard[]): PokerEvaluatedHand {
  const sorted = [...five].sort((a, b) => b.rank - a.rank)
  const r0 = sorted[0].rank
  const r1 = sorted[1].rank
  const r2 = sorted[2].rank
  const r3 = sorted[3].rank
  const r4 = sorted[4].rank

  const isFlush =
    sorted[0].suit === sorted[1].suit &&
    sorted[0].suit === sorted[2].suit &&
    sorted[0].suit === sorted[3].suit &&
    sorted[0].suit === sorted[4].suit

  const allDistinct = r0 !== r1 && r1 !== r2 && r2 !== r3 && r3 !== r4
  const isWheelStraight = allDistinct && r0 === 14 && r1 === 5 && r2 === 4 && r3 === 3 && r4 === 2
  const isNormalStraight = allDistinct && r0 - r4 === 4
  const isStraight = isNormalStraight || isWheelStraight
  const straightHigh: CardRank = isWheelStraight ? 5 : r0
  const straightOrdered = isWheelStraight
    ? [sorted[1], sorted[2], sorted[3], sorted[4], sorted[0]]
    : sorted

  if (isFlush && isStraight) {
    if (straightHigh === 14) {
      return {
        category: 9,
        categoryName: 'Royal Flush',
        label: 'Royal Flush',
        score: encodeHandScore(9, 14, 13, 12, 11, 10),
        bestFive: straightOrdered,
      }
    }
    return {
      category: 8,
      categoryName: 'Straight Flush',
      label: `Straight Flush, ${RANK_NAME[straightHigh]} High`,
      score: encodeHandScore(8, straightHigh, 0, 0, 0, 0),
      bestFive: straightOrdered,
    }
  }

  // Group cards by rank, ordered by (count desc, rank desc)
  const byRank = new Map<CardRank, PokerCard[]>()
  for (const c of sorted) {
    const arr = byRank.get(c.rank)
    if (arr) arr.push(c)
    else byRank.set(c.rank, [c])
  }
  const groups = Array.from(byRank.entries()).sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length
    return b[0] - a[0]
  })

  if (groups[0][1].length === 4) {
    const quadRank = groups[0][0]
    const kickerRank = groups[1][0]
    return {
      category: 7,
      categoryName: 'Four of a Kind',
      label: `Four of a Kind, ${RANK_PLURAL[quadRank]}`,
      score: encodeHandScore(7, quadRank, kickerRank, 0, 0, 0),
      bestFive: [...groups[0][1], ...groups[1][1]],
    }
  }

  if (groups[0][1].length === 3 && groups[1][1].length === 2) {
    const tripRank = groups[0][0]
    const pairRank = groups[1][0]
    return {
      category: 6,
      categoryName: 'Full House',
      label: `Full House, ${RANK_PLURAL[tripRank]} full of ${RANK_PLURAL[pairRank]}`,
      score: encodeHandScore(6, tripRank, pairRank, 0, 0, 0),
      bestFive: [...groups[0][1], ...groups[1][1]],
    }
  }

  if (isFlush) {
    return {
      category: 5,
      categoryName: 'Flush',
      label: `Flush, ${RANK_NAME[r0]} High`,
      score: encodeHandScore(5, r0, r1, r2, r3, r4),
      bestFive: sorted,
    }
  }

  if (isStraight) {
    return {
      category: 4,
      categoryName: 'Straight',
      label: `Straight, ${RANK_NAME[straightHigh]} High`,
      score: encodeHandScore(4, straightHigh, 0, 0, 0, 0),
      bestFive: straightOrdered,
    }
  }

  if (groups[0][1].length === 3) {
    const tripRank = groups[0][0]
    const k1 = groups[1][0]
    const k2 = groups[2][0]
    return {
      category: 3,
      categoryName: 'Three of a Kind',
      label: `Three of a Kind, ${RANK_PLURAL[tripRank]}`,
      score: encodeHandScore(3, tripRank, k1, k2, 0, 0),
      bestFive: [...groups[0][1], ...groups[1][1], ...groups[2][1]],
    }
  }

  if (groups[0][1].length === 2 && groups[1][1].length === 2) {
    const hiPair = groups[0][0]
    const loPair = groups[1][0]
    const kicker = groups[2][0]
    return {
      category: 2,
      categoryName: 'Two Pair',
      label: `Two Pair, ${RANK_PLURAL[hiPair]} & ${RANK_PLURAL[loPair]}`,
      score: encodeHandScore(2, hiPair, loPair, kicker, 0, 0),
      bestFive: [...groups[0][1], ...groups[1][1], ...groups[2][1]],
    }
  }

  if (groups[0][1].length === 2) {
    const pairRank = groups[0][0]
    const k1 = groups[1][0]
    const k2 = groups[2][0]
    const k3 = groups[3][0]
    return {
      category: 1,
      categoryName: 'One Pair',
      label: `Pair of ${RANK_PLURAL[pairRank]}`,
      score: encodeHandScore(1, pairRank, k1, k2, k3, 0),
      bestFive: [...groups[0][1], ...groups[1][1], ...groups[2][1], ...groups[3][1]],
    }
  }

  return {
    category: 0,
    categoryName: 'High Card',
    label: `High Card, ${RANK_NAME[r0]}`,
    score: encodeHandScore(0, r0, r1, r2, r3, r4),
    bestFive: sorted,
  }
}

/**
 * Evaluates the exact best 5-card Texas Hold'em hand out of 5, 6, or 7 cards.
 */
export function evaluateBestFiveCardHand(cards: PokerCard[]): PokerEvaluatedHand {
  const n = cards.length
  if (n < 5) {
    const sorted = [...cards].sort((a, b) => b.rank - a.rank)
    const r0 = sorted[0]?.rank ?? 2
    const r1 = sorted[1]?.rank ?? 0
    const r2 = sorted[2]?.rank ?? 0
    const r3 = sorted[3]?.rank ?? 0
    return {
      category: 0,
      categoryName: 'High Card',
      label: sorted.length > 0 ? `High Card, ${RANK_NAME[r0]}` : 'High Card',
      score: encodeHandScore(0, r0, r1, r2, r3, 0),
      bestFive: sorted,
    }
  }

  if (n === 5) {
    return evaluateExactFiveCards(cards)
  }

  let best: PokerEvaluatedHand | null = null
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            const candidate = evaluateExactFiveCards([
              cards[a],
              cards[b],
              cards[c],
              cards[d],
              cards[e],
            ])
            if (!best || candidate.score > best.score) {
              best = candidate
            }
          }
        }
      }
    }
  }

  return best ?? evaluateExactFiveCards(cards.slice(0, 5))
}

/**
 * Recommends crisp small/big blinds (~1%/2% of fixed buy-in, e.g. 500 -> 5/10, 1000 -> 10/20, 2500 -> 25/50, 5000 -> 50/100).
 */
export function getRecommendedBlinds(fixedBuyIn: number): {
  smallBlind: number
  bigBlind: number
} {
  const safeBuyIn = Math.max(20, Math.floor(Number.isFinite(fixedBuyIn) ? fixedBuyIn : 1000))
  if (safeBuyIn <= 200) return { smallBlind: 1, bigBlind: 2 }
  if (safeBuyIn <= 500) return { smallBlind: 5, bigBlind: 10 }
  if (safeBuyIn <= 1000) return { smallBlind: 10, bigBlind: 20 }
  if (safeBuyIn <= 2500) return { smallBlind: 25, bigBlind: 50 }
  if (safeBuyIn <= 5000) return { smallBlind: 50, bigBlind: 100 }
  const smallBlind = Math.max(5, Math.round(safeBuyIn / 100 / 5) * 5)
  return { smallBlind, bigBlind: smallBlind * 2 }
}

/**
 * Creates a new fixed-buy-in No-Limit Texas Hold'em table with the host seated at seat 0.
 */
export function createPokerTable(opts: {
  tableId: string
  hostPubkey: string
  hostDisplayName: string
  fixedBuyIn: number
  maxSeats?: number
}): PokerPublicState {
  const hostPk = normalizePubkey(opts.hostPubkey)
  const fixedBuyIn = Math.max(20, Math.floor(Number.isFinite(opts.fixedBuyIn) ? opts.fixedBuyIn : 1000))
  const maxSeats = Math.max(2, Math.min(8, Math.floor(opts.maxSeats ?? 8)))
  const { smallBlind, bigBlind } = getRecommendedBlinds(fixedBuyIn)

  return {
    tableId: opts.tableId,
    hostPubkey: hostPk,
    fixedBuyIn,
    smallBlind,
    bigBlind,
    maxSeats,
    handNumber: 0,
    phase: 'lobby',
    seats: [
      {
        seatIndex: 0,
        pubkey: hostPk,
        displayName: opts.hostDisplayName.trim() || 'Host',
        chips: fixedBuyIn,
        betThisStreet: 0,
        totalCommitted: 0,
        folded: false,
        allIn: false,
        actedThisStreet: false,
        sittingOut: false,
      },
    ],
    dealerSeatIndex: 0,
    smallBlindSeatIndex: null,
    bigBlindSeatIndex: null,
    actingPubkey: null,
    communityCards: [],
    pot: 0,
    currentBet: 0,
    minRaise: bigBlind,
    lastActionText: null,
    revealedHands: {},
    winners: [],
    updatedAtMs: Date.now(),
  }
}

/**
 * Seats a new player with the table's exact fixed buy-in.
 * Enforces `maxSeats`, blocks duplicate pubkeys (strictly fixed buy-in — no rebuys),
 * and marks players joining mid-hand as `sittingOut: true` until the next hand begins.
 */
export function seatPokerPlayer(
  state: PokerPublicState,
  pubkey: string,
  displayName: string,
): PokerPublicState | null {
  const pk = normalizePubkey(pubkey)
  if (!pk || state.expelledPubkeys?.includes(pk)) return null
  if (state.seats.length >= state.maxSeats) return null
  if (state.seats.some((s) => s.pubkey === pk)) return null

  const taken = new Set(state.seats.map((s) => s.seatIndex))
  let seatIndex = -1
  for (let i = 0; i < state.maxSeats; i++) {
    if (!taken.has(i)) {
      seatIndex = i
      break
    }
  }
  if (seatIndex < 0) return null

  const midHand = isLiveHandPhase(state.phase)
  const newSeat: PokerSeat = {
    seatIndex,
    pubkey: pk,
    displayName: displayName.trim() || pk.slice(0, 8),
    chips: state.fixedBuyIn,
    betThisStreet: 0,
    totalCommitted: 0,
    folded: midHand,
    allIn: false,
    actedThisStreet: midHand,
    sittingOut: midHand,
  }

  const seats = [...state.seats.map((s) => ({ ...s })), newSeat].sort(
    (a, b) => a.seatIndex - b.seatIndex,
  )

  return {
    ...state,
    seats,
    rosterRevision: (state.rosterRevision ?? 0) + 1,
    updatedAtMs: Date.now(),
  }
}

/**
 * Finds the next clockwise seat matching `predicate` strictly after `afterSeatIndex` (wrapping around).
 */
function findNextClockwiseSeat(
  seats: PokerSeat[],
  afterSeatIndex: number,
  predicate: (seat: PokerSeat) => boolean,
): PokerSeat | null {
  if (seats.length === 0) return null
  const ordered = [...seats].sort((a, b) => a.seatIndex - b.seatIndex)
  for (const s of ordered) {
    if (s.seatIndex > afterSeatIndex && predicate(s)) return s
  }
  for (const s of ordered) {
    if (s.seatIndex <= afterSeatIndex && predicate(s)) return s
  }
  return null
}

/**
 * Finds the next clockwise actor eligible to bet/check/call strictly after `afterSeatIndex`.
 */
function findNextActor(seats: PokerSeat[], afterSeatIndex: number): PokerSeat | null {
  return findNextClockwiseSeat(
    seats,
    afterSeatIndex,
    (s) => !s.sittingOut && !s.folded && !s.allIn,
  )
}

/**
 * Checks whether the current betting street is complete (all non-folded, non-all-in players
 * have acted AND matched `currentBet`, OR at most 1 non-folded player can act and already matches `currentBet`).
 */
function isStreetBettingComplete(seats: PokerSeat[], currentBet: number): boolean {
  const contenders = seats.filter((s) => !s.sittingOut && !s.folded)
  if (contenders.length <= 1) return true
  const canAct = contenders.filter((s) => !s.allIn)
  if (canAct.length === 0) return true
  if (canAct.length === 1 && canAct[0].betThisStreet >= currentBet) return true
  return canAct.every((s) => s.actedThisStreet && s.betThisStreet === currentBet)
}

/**
 * Checks whether any further betting is possible across future streets (requires >= 2 non-folded, non-all-in contenders).
 */
function canHaveFurtherBetting(seats: PokerSeat[], currentBet: number): boolean {
  const contenders = seats.filter((s) => !s.sittingOut && !s.folded)
  if (contenders.length <= 1) return false
  const canAct = contenders.filter((s) => !s.allIn)
  if (canAct.length >= 2) return true
  if (canAct.length === 1 && canAct[0].betThisStreet < currentBet) return true
  return false
}

function finalizeUncontestedWin(
  state: PokerPublicState,
  seats: PokerSeat[],
  winner: PokerSeat,
  actionText: string,
): PokerPublicState {
  const updatedSeats = seats.map((s) => ({
    ...s,
    chips: s.pubkey === winner.pubkey ? s.chips + state.pot : s.chips,
    betThisStreet: 0,
  }))
  return {
    ...state,
    seats: updatedSeats,
    phase: 'showdown',
    actingPubkey: null,
    currentBet: 0,
    minRaise: state.bigBlind,
    lastActionText: actionText,
    revealedHands: {},
    winners: [
      {
        pubkey: winner.pubkey,
        displayName: winner.displayName,
        amountWon: state.pot,
        handLabel: 'Uncontested Pot',
        potIndex: 0,
      },
    ],
    updatedAtMs: Date.now(),
  }
}


/**
 * Returns `true` when at least 2 seated players hold chips (`chips > 0`).
 */
export function canStartPokerHand(state: PokerPublicState): boolean {
  return state.seats.filter((s) => s.chips > 0).length >= 2
}

interface PotLayer {
  amount: number
  eligiblePubkeys: string[]
  contributorCount: number
}

/**
 * Computes exact main pot, side pots, uncalled overbet refunds, and showdown winner payouts
 * (including clockwise odd-chip distribution starting left of the dealer button).
 */
function resolveShowdown(
  state: PokerPublicState,
  privateState: PokerDealerPrivateState,
  seatsIn: PokerSeat[],
  communityCards: PokerCard[],
  lastActionText: string | null,
): { publicState: PokerPublicState; privateState: PokerDealerPrivateState } {
  const seats = seatsIn.map((s) => ({ ...s, betThisStreet: 0 }))
  const contenders = seats.filter((s) => !s.sittingOut && !s.folded)

  // Reveal all remaining contenders' hole cards at showdown
  const revealedHands: Record<string, [PokerCard, PokerCard]> = {}
  const evaluatedByPk = new Map<string, PokerEvaluatedHand>()
  for (const c of contenders) {
    const hole = privateState.holeCards[c.pubkey]
    if (hole) {
      revealedHands[c.pubkey] = hole
      evaluatedByPk.set(c.pubkey, evaluateBestFiveCardHand([...hole, ...communityCards]))
    }
  }

  const totalSeatCommitted = seats.reduce((sum, s) => sum + s.totalCommitted, 0)
  const deadMoney = Math.max(0, state.pot - totalSeatCommitted)

  const contenderLevels = Array.from(
    new Set(contenders.map((c) => c.totalCommitted).filter((v) => v > 0)),
  ).sort((a, b) => a - b)

  const rawLayers: PotLayer[] = []
  let prevLevel = 0
  for (const level of contenderLevels) {
    let layerAmount = 0
    let contributorCount = 0
    for (const s of seats) {
      const contrib = Math.max(0, Math.min(s.totalCommitted, level) - prevLevel)
      if (contrib > 0) {
        layerAmount += contrib
        contributorCount += 1
      }
    }
    const eligiblePubkeys = contenders
      .filter((c) => c.totalCommitted >= level)
      .map((c) => c.pubkey)
    if (layerAmount > 0 && eligiblePubkeys.length > 0) {
      rawLayers.push({ amount: layerAmount, eligiblePubkeys, contributorCount })
    }
    prevLevel = level
  }

  // Sweep any leftover committed chips above the highest contender (e.g. folded player who left)
  let overflowDead = deadMoney
  for (const s of seats) {
    if (s.totalCommitted > prevLevel) {
      overflowDead += s.totalCommitted - prevLevel
    }
  }

  const contestedPots: Array<{ amount: number; eligiblePubkeys: string[] }> = []
  let displayPot = state.pot

  for (const layer of rawLayers) {
    if (layer.eligiblePubkeys.length === 1 && layer.contributorCount === 1) {
      // Uncalled overbet: refund directly to that player's stack
      const seat = seats.find((s) => s.pubkey === layer.eligiblePubkeys[0])
      if (seat) {
        seat.chips += layer.amount
        displayPot = Math.max(0, displayPot - layer.amount)
      }
      continue
    }

    const prev = contestedPots[contestedPots.length - 1]
    const sameEligible =
      prev &&
      prev.eligiblePubkeys.length === layer.eligiblePubkeys.length &&
      prev.eligiblePubkeys.every((pk, idx) => pk === layer.eligiblePubkeys[idx])

    if (sameEligible) {
      prev.amount += layer.amount
    } else {
      contestedPots.push({
        amount: layer.amount,
        eligiblePubkeys: layer.eligiblePubkeys,
      })
    }
  }

  if (overflowDead > 0) {
    if (contestedPots.length > 0) {
      contestedPots[0].amount += overflowDead
    } else if (contenders.length > 0) {
      contestedPots.push({
        amount: overflowDead,
        eligiblePubkeys: contenders.map((c) => c.pubkey),
      })
    }
  }

  // Clockwise distance strictly left of dealer button for WSOP odd-chip tiebreaker
  const clockwiseOrderFromLeftOfDealer = (seatIdx: number): number => {
    const span = Math.max(state.maxSeats, 8)
    return (seatIdx - state.dealerSeatIndex - 1 + span * 4) % span
  }

  const winners: PokerWinnerSummary[] = []
  contestedPots.forEach((potDef, potIndex) => {
    let bestScore = -1
    const potWinnerSeats: PokerSeat[] = []

    for (const pk of potDef.eligiblePubkeys) {
      const seat = seats.find((s) => s.pubkey === pk)
      const evalHand = evaluatedByPk.get(pk)
      if (!seat || !evalHand) continue
      if (evalHand.score > bestScore) {
        bestScore = evalHand.score
        potWinnerSeats.length = 0
        potWinnerSeats.push(seat)
      } else if (evalHand.score === bestScore) {
        potWinnerSeats.push(seat)
      }
    }

    if (potWinnerSeats.length === 0) return

    potWinnerSeats.sort(
      (a, b) =>
        clockwiseOrderFromLeftOfDealer(a.seatIndex) - clockwiseOrderFromLeftOfDealer(b.seatIndex),
    )

    const baseShare = Math.floor(potDef.amount / potWinnerSeats.length)
    const remainder = potDef.amount % potWinnerSeats.length

    potWinnerSeats.forEach((winSeat, idx) => {
      const award = baseShare + (idx < remainder ? 1 : 0)
      winSeat.chips += award
      const handLabel = evaluatedByPk.get(winSeat.pubkey)?.label ?? 'Winning Hand'
      winners.push({
        pubkey: winSeat.pubkey,
        displayName: winSeat.displayName,
        amountWon: award,
        handLabel,
        potIndex,
      })
    })
  })

  const primarySummary =
    winners.length === 1
      ? `${winners[0].displayName} wins ${winners[0].amountWon} (${winners[0].handLabel})`
      : winners.length > 1
        ? `Showdown · ${winners.map((w) => `${w.displayName} +${w.amountWon}`).join(', ')}`
        : lastActionText

  return {
    publicState: {
      ...state,
      seats,
      communityCards,
      pot: displayPot,
      phase: 'showdown',
      actingPubkey: null,
      currentBet: 0,
      minRaise: state.bigBlind,
      lastActionText: primarySummary,
      revealedHands,
      winners,
      updatedAtMs: Date.now(),
    },
    privateState,
  }
}

/**
 * Deals remaining community cards automatically when all remaining contenders are all-in
 * and resolves showdown immediately.
 */
function runOutBoardAndResolve(
  state: PokerPublicState,
  privateState: PokerDealerPrivateState,
  seats: PokerSeat[],
  lastActionText: string | null,
): { publicState: PokerPublicState; privateState: PokerDealerPrivateState } {
  const deck = [...privateState.deck]
  const board = [...state.communityCards]

  // Deal Flop (3), Turn (1), River (1) with burn card per street
  if (board.length === 0 && deck.length >= 4) {
    deck.pop() // burn
    board.push(deck.pop()!, deck.pop()!, deck.pop()!)
  }
  if (board.length === 3 && deck.length >= 2) {
    deck.pop() // burn
    board.push(deck.pop()!)
  }
  if (board.length === 4 && deck.length >= 2) {
    deck.pop() // burn
    board.push(deck.pop()!)
  }

  return resolveShowdown(
    state,
    { deck, holeCards: privateState.holeCards },
    seats,
    board,
    lastActionText,
  )
}

/**
 * Starts a new hand: rotates dealer button, posts exact SB/BB (including Heads-Up 2-player rules),
 * deals 2 private hole cards per active seat, and sets `actingPubkey` (or runs out immediately if all-in on blinds).
 */
export function startPokerHand(
  state: PokerPublicState,
): { publicState: PokerPublicState; privateState: PokerDealerPrivateState } | null {
  const orderedSeats = [...state.seats].sort((a, b) => a.seatIndex - b.seatIndex)
  const eligible = orderedSeats.filter((s) => s.chips > 0)
  if (eligible.length < 2) return null

  const dealerSeat =
    state.handNumber === 0
      ? eligible[0]
      : (findNextClockwiseSeat(eligible, state.dealerSeatIndex, () => true) ?? eligible[0])

  const isHeadsUp = eligible.length === 2
  const sbSeat = isHeadsUp
    ? dealerSeat
    : (findNextClockwiseSeat(eligible, dealerSeat.seatIndex, () => true) ?? eligible[0])
  const bbSeat =
    findNextClockwiseSeat(eligible, sbSeat.seatIndex, (s) => s.seatIndex !== sbSeat.seatIndex) ??
    eligible[1]

  const deck = createShuffledDeck()
  const holeCards: Record<string, [PokerCard, PokerCard]> = {}
  const eligiblePks = new Set(eligible.map((s) => s.pubkey))

  let pot = 0
  let sbPosted = 0
  let bbPosted = 0

  const nextSeats: PokerSeat[] = orderedSeats.map((s) => {
    if (!eligiblePks.has(s.pubkey)) {
      return {
        ...s,
        betThisStreet: 0,
        totalCommitted: 0,
        folded: true,
        allIn: false,
        actedThisStreet: true,
        sittingOut: true,
        lastActionLabel: undefined,
      }
    }

    const c1 = deck.pop()!
    const c2 = deck.pop()!
    holeCards[s.pubkey] = [c1, c2]

    let chips = s.chips
    let betThisStreet = 0
    let lastActionLabel: string | undefined

    if (s.seatIndex === sbSeat.seatIndex) {
      sbPosted = Math.min(chips, state.smallBlind)
      chips -= sbPosted
      betThisStreet = sbPosted
      pot += sbPosted
      lastActionLabel = chips === 0 ? `SB All-In (${sbPosted})` : `SB ${sbPosted}`
    } else if (s.seatIndex === bbSeat.seatIndex) {
      bbPosted = Math.min(chips, state.bigBlind)
      chips -= bbPosted
      betThisStreet = bbPosted
      pot += bbPosted
      lastActionLabel = chips === 0 ? `BB All-In (${bbPosted})` : `BB ${bbPosted}`
    }

    return {
      ...s,
      chips,
      betThisStreet,
      totalCommitted: betThisStreet,
      folded: false,
      allIn: chips === 0,
      actedThisStreet: false,
      sittingOut: false,
      lastActionLabel,
    }
  })

  const currentBet = Math.max(sbPosted, bbPosted)
  const basePublicState: PokerPublicState = {
    ...state,
    handNumber: state.handNumber + 1,
    phase: 'preflop',
    seats: nextSeats,
    dealerSeatIndex: dealerSeat.seatIndex,
    smallBlindSeatIndex: sbSeat.seatIndex,
    bigBlindSeatIndex: bbSeat.seatIndex,
    actingPubkey: null,
    communityCards: [],
    pot,
    currentBet,
    minRaise: state.bigBlind,
    lastActionText: `Hand #${state.handNumber + 1} · Blinds ${state.smallBlind}/${state.bigBlind}`,
    revealedHands: {},
    winners: [],
    updatedAtMs: Date.now(),
  }

  const privateState: PokerDealerPrivateState = { deck, holeCards }

  // If blind posting already left everyone all-in (or only 1 player who already covers currentBet), run out board!
  if (!canHaveFurtherBetting(nextSeats, currentBet)) {
    return runOutBoardAndResolve(basePublicState, privateState, nextSeats, basePublicState.lastActionText)
  }

  // Preflop first to act:
  // - Heads-Up: Dealer / Small Blind acts first (unless already all-in -> Big Blind).
  // - 3+ players: first active seat clockwise after Big Blind (UTG).
  let firstActor: PokerSeat | null = null
  if (isHeadsUp) {
    const sbLive = nextSeats.find((s) => s.seatIndex === sbSeat.seatIndex)
    const bbLive = nextSeats.find((s) => s.seatIndex === bbSeat.seatIndex)
    if (sbLive && !sbLive.allIn) firstActor = sbLive
    else if (bbLive && !bbLive.allIn) firstActor = bbLive
  } else {
    firstActor = findNextActor(nextSeats, bbSeat.seatIndex)
  }

  return {
    publicState: {
      ...basePublicState,
      actingPubkey: firstActor?.pubkey ?? null,
    },
    privateState,
  }
}

/**
 * Computes exact legal actions and min/max bet/raise-to totals for `pubkey`.
 */
export function getLegalPokerActions(state: PokerPublicState, pubkey: string): PokerLegalActions {
  const pk = normalizePubkey(pubkey)
  if (!isLiveHandPhase(state.phase) || state.actingPubkey !== pk) {
    return {
      canFold: false,
      canCheck: false,
      callAmount: 0,
      minBetOrRaiseTo: 0,
      maxBetOrRaiseTo: 0,
      isRaise: false,
    }
  }

  const seat = state.seats.find((s) => s.pubkey === pk)
  if (!seat || seat.sittingOut || seat.folded || seat.allIn) {
    return {
      canFold: false,
      canCheck: false,
      callAmount: 0,
      minBetOrRaiseTo: 0,
      maxBetOrRaiseTo: 0,
      isRaise: false,
    }
  }

  const toCall = Math.max(0, state.currentBet - seat.betThisStreet)
  const callAmount = Math.min(toCall, seat.chips)
  const canCheck = toCall === 0
  const maxBetOrRaiseTo = seat.betThisStreet + seat.chips
  const isRaise = state.currentBet > 0

  let minBetOrRaiseTo = 0
  if (maxBetOrRaiseTo > state.currentBet) {
    const minFullTarget = isRaise
      ? state.currentBet + Math.max(state.minRaise, state.bigBlind)
      : state.bigBlind
    minBetOrRaiseTo = Math.min(minFullTarget, maxBetOrRaiseTo)
  }

  return {
    canFold: true,
    canCheck,
    callAmount,
    minBetOrRaiseTo,
    maxBetOrRaiseTo,
    isRaise,
  }
}

/**
 * Applies a validated player action, advancing turns, streets (`preflop -> flop -> turn -> river -> showdown`),
 * automatic all-in runouts, uncontested fold wins, and exact main/side pot showdowns.
 * Returns `null` if the action is illegal or out of turn.
 */
export function applyPokerAction(
  publicState: PokerPublicState,
  privateState: PokerDealerPrivateState,
  pubkey: string,
  action: PokerAction,
): { publicState: PokerPublicState; privateState: PokerDealerPrivateState } | null {
  const pk = normalizePubkey(pubkey)
  if (!isLiveHandPhase(publicState.phase) || publicState.actingPubkey !== pk) {
    return null
  }

  const legal = getLegalPokerActions(publicState, pk)
  if (!legal.canFold) return null

  const seats = publicState.seats.map((s) => ({ ...s }))
  const actor = seats.find((s) => s.pubkey === pk)
  if (!actor) return null

  let pot = publicState.pot
  let currentBet = publicState.currentBet
  let minRaise = publicState.minRaise
  let lastActionText = ''

  if (action.type === 'fold') {
    actor.folded = true
    actor.actedThisStreet = true
    actor.lastActionLabel = 'Fold'
    lastActionText = `${actor.displayName} folded`

    const remainingContenders = seats.filter((s) => !s.sittingOut && !s.folded)
    if (remainingContenders.length === 1) {
      const winner = remainingContenders[0]
      return {
        publicState: finalizeUncontestedWin(
          publicState,
          seats,
          winner,
          `${actor.displayName} folded · ${winner.displayName} wins ${pot}`,
        ),
        privateState,
      }
    }
  } else if (action.type === 'check') {
    if (!legal.canCheck) return null
    actor.actedThisStreet = true
    actor.lastActionLabel = 'Check'
    lastActionText = `${actor.displayName} checked`
  } else if (action.type === 'call') {
    if (legal.callAmount <= 0) return null
    const paid = legal.callAmount
    actor.chips -= paid
    actor.betThisStreet += paid
    actor.totalCommitted += paid
    pot += paid
    actor.actedThisStreet = true
    if (actor.chips === 0) {
      actor.allIn = true
      actor.lastActionLabel = `All-In (${actor.betThisStreet})`
      lastActionText = `${actor.displayName} called all-in (${paid})`
    } else {
      actor.lastActionLabel = `Call ${paid}`
      lastActionText = `${actor.displayName} called ${paid}`
    }
  } else if (action.type === 'bet') {
    if (legal.isRaise || legal.minBetOrRaiseTo <= 0) return null
    const targetTo = Math.floor(action.amount ?? legal.minBetOrRaiseTo)
    if (
      !Number.isFinite(targetTo) ||
      targetTo < legal.minBetOrRaiseTo ||
      targetTo > legal.maxBetOrRaiseTo
    ) {
      return null
    }
    const delta = targetTo - actor.betThisStreet
    if (delta <= 0 || delta > actor.chips) return null

    actor.chips -= delta
    actor.betThisStreet = targetTo
    actor.totalCommitted += delta
    pot += delta
    actor.actedThisStreet = true
    currentBet = targetTo
    minRaise = Math.max(publicState.bigBlind, targetTo)
    if (actor.chips === 0) {
      actor.allIn = true
      actor.lastActionLabel = `All-In (${targetTo})`
      lastActionText = `${actor.displayName} bet all-in to ${targetTo}`
    } else {
      actor.lastActionLabel = `Bet ${targetTo}`
      lastActionText = `${actor.displayName} bet ${targetTo}`
    }
    for (const s of seats) {
      if (s.pubkey !== pk && !s.sittingOut && !s.folded && !s.allIn) {
        s.actedThisStreet = false
      }
    }
  } else if (action.type === 'raise') {
    if (!legal.isRaise || legal.minBetOrRaiseTo <= 0) return null
    const targetTo = Math.floor(action.amount ?? legal.minBetOrRaiseTo)
    if (
      !Number.isFinite(targetTo) ||
      targetTo < legal.minBetOrRaiseTo ||
      targetTo > legal.maxBetOrRaiseTo
    ) {
      return null
    }
    const delta = targetTo - actor.betThisStreet
    if (delta <= 0 || delta > actor.chips) return null

    const raiseIncrement = targetTo - currentBet
    const isFullRaise = raiseIncrement >= minRaise

    actor.chips -= delta
    actor.betThisStreet = targetTo
    actor.totalCommitted += delta
    pot += delta
    actor.actedThisStreet = true
    currentBet = targetTo
    if (isFullRaise) {
      minRaise = raiseIncrement
    }

    if (actor.chips === 0) {
      actor.allIn = true
      actor.lastActionLabel = `All-In (${targetTo})`
      lastActionText = `${actor.displayName} raised all-in to ${targetTo}`
    } else {
      actor.lastActionLabel = `Raise ${targetTo}`
      lastActionText = `${actor.displayName} raised to ${targetTo}`
    }

    for (const s of seats) {
      if (s.pubkey !== pk && !s.sittingOut && !s.folded && !s.allIn) {
        if (isFullRaise || s.betThisStreet < currentBet) {
          s.actedThisStreet = false
        }
      }
    }
  } else if (action.type === 'all-in') {
    if (actor.chips <= 0) return null
    const delta = actor.chips
    const newBet = actor.betThisStreet + delta
    actor.chips = 0
    actor.betThisStreet = newBet
    actor.totalCommitted += delta
    pot += delta
    actor.allIn = true
    actor.actedThisStreet = true
    actor.lastActionLabel = `All-In (${newBet})`

    if (newBet > currentBet) {
      const raiseIncrement = newBet - currentBet
      const isFullRaise = currentBet === 0 || raiseIncrement >= minRaise
      lastActionText =
        currentBet === 0
          ? `${actor.displayName} moved all-in (${newBet})`
          : `${actor.displayName} raised all-in to ${newBet}`
      currentBet = newBet
      if (isFullRaise) {
        minRaise = Math.max(publicState.bigBlind, raiseIncrement)
      }
      for (const s of seats) {
        if (s.pubkey !== pk && !s.sittingOut && !s.folded && !s.allIn) {
          if (isFullRaise || s.betThisStreet < currentBet) {
            s.actedThisStreet = false
          }
        }
      }
    } else {
      lastActionText = `${actor.displayName} called all-in (${delta})`
    }
  } else {
    return null
  }

  const intermediateState: PokerPublicState = {
    ...publicState,
    seats,
    pot,
    currentBet,
    minRaise,
    lastActionText,
    updatedAtMs: Date.now(),
  }

  // Check if current betting round is complete
  if (!isStreetBettingComplete(seats, currentBet)) {
    const nextActor = findNextActor(seats, actor.seatIndex)
    if (nextActor) {
      return {
        publicState: {
          ...intermediateState,
          actingPubkey: nextActor.pubkey,
        },
        privateState,
      }
    }
  }

  // Street is complete! Check if everyone remaining is all-in (or <= 1 active bettor left)
  const resetStreetSeats = seats.map((s) => ({
    ...s,
    betThisStreet: 0,
    actedThisStreet: s.sittingOut || s.folded || s.allIn,
    lastActionLabel: s.folded ? 'Fold' : s.allIn ? 'All-In' : undefined,
  }))

  if (publicState.phase === 'river') {
    return resolveShowdown(
      intermediateState,
      privateState,
      resetStreetSeats,
      publicState.communityCards,
      lastActionText,
    )
  }

  if (!canHaveFurtherBetting(resetStreetSeats, 0)) {
    return runOutBoardAndResolve(intermediateState, privateState, resetStreetSeats, lastActionText)
  }

  // Deal the next street (Flop / Turn / River)
  const nextDeck = [...privateState.deck]
  const nextBoard = [...publicState.communityCards]
  let nextPhase: PokerPhase = publicState.phase

  if (publicState.phase === 'preflop') {
    nextPhase = 'flop'
    if (nextDeck.length >= 4) {
      nextDeck.pop() // burn
      nextBoard.push(nextDeck.pop()!, nextDeck.pop()!, nextDeck.pop()!)
    }
  } else if (publicState.phase === 'flop') {
    nextPhase = 'turn'
    if (nextDeck.length >= 2) {
      nextDeck.pop() // burn
      nextBoard.push(nextDeck.pop()!)
    }
  } else if (publicState.phase === 'turn') {
    nextPhase = 'river'
    if (nextDeck.length >= 2) {
      nextDeck.pop() // burn
      nextBoard.push(nextDeck.pop()!)
    }
  }

  // Postflop first to act: first non-folded, non-all-in player clockwise after dealer button
  // (Works identically for BOTH 3+ players AND Heads-Up, where BB is left of Dealer!)
  const firstPostflopActor = findNextActor(resetStreetSeats, publicState.dealerSeatIndex)

  return {
    publicState: {
      ...intermediateState,
      phase: nextPhase,
      seats: resetStreetSeats,
      communityCards: nextBoard,
      currentBet: 0,
      minRaise: publicState.bigBlind,
      actingPubkey: firstPostflopActor?.pubkey ?? null,
    },
    privateState: {
      deck: nextDeck,
      holeCards: privateState.holeCards,
    },
  }
}
