import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Crown, LogOut, Play, Sparkles, Trophy, UserPlus } from 'lucide-react'
import {
  canStartPokerHand,
  evaluateBestFiveCardHand,
  getLegalPokerActions,
  type CardRank,
  type CardSuit,
  type PokerAction,
  type PokerCard,
  type PokerPhase,
  type PokerPublicState,
  type PokerSeat,
} from '../../lib/games/pokerEngine.ts'
import { playGameSound } from '../../utils/gameSounds.ts'
import { pokerVoteThreshold } from '../../lib/games/pokerGovernance.ts'
import { AvatarImg } from '../AvatarImg.tsx'

export interface PokerTableViewProps {
  state: PokerPublicState
  myPubkey: string
  myHoleCards: [PokerCard, PokerCard] | null
  isHost: boolean
  getAvatarUrl?: (pubkey: string) => string | undefined
  onJoinSeat: () => void
  onLeaveSeat: () => void
  onStartHand: () => void
  onAction: (action: PokerAction) => void
  onVoteOut: (target: string) => void
  myVoteTargets: string[]
}

interface SeatCoord {
  x: number
  y: number
}

const RANK_LABEL: Record<CardRank, string> = {
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

const SUIT_GLYPH: Record<CardSuit, string> = {
  s: '♠',
  h: '♥',
  d: '♦',
  c: '♣',
}

const PHASE_LABEL: Record<PokerPhase, string> = {
  lobby: 'LOBBY',
  preflop: 'PREFLOP',
  flop: 'FLOP',
  turn: 'TURN',
  river: 'RIVER',
  showdown: 'SHOWDOWN',
  finished: 'FINISHED',
}

/**
 * Clockwise perimeter seat coordinates (% of arena) for landscape desktop oval.
 * Slot 0 is always anchored at 6 o'clock (bottom center) for the local player.
 */
const DESKTOP_SEAT_LAYOUTS: Record<number, readonly SeatCoord[]> = {
  2: [
    { x: 50, y: 89 },
    { x: 50, y: 10 },
  ],
  3: [
    { x: 50, y: 89 },
    { x: 16, y: 24 },
    { x: 84, y: 24 },
  ],
  4: [
    { x: 50, y: 89 },
    { x: 9, y: 50 },
    { x: 50, y: 10 },
    { x: 91, y: 50 },
  ],
  5: [
    { x: 50, y: 89 },
    { x: 11, y: 63 },
    { x: 24, y: 14 },
    { x: 76, y: 14 },
    { x: 89, y: 63 },
  ],
  6: [
    { x: 50, y: 89 },
    { x: 11, y: 66 },
    { x: 15, y: 22 },
    { x: 50, y: 10 },
    { x: 85, y: 22 },
    { x: 89, y: 66 },
  ],
  7: [
    { x: 50, y: 89 },
    { x: 13, y: 72 },
    { x: 10, y: 33 },
    { x: 32, y: 10 },
    { x: 68, y: 10 },
    { x: 90, y: 33 },
    { x: 87, y: 72 },
  ],
  8: [
    { x: 50, y: 89 },
    { x: 15, y: 76 },
    { x: 9, y: 45 },
    { x: 24, y: 13 },
    { x: 50, y: 10 },
    { x: 76, y: 13 },
    { x: 91, y: 45 },
    { x: 85, y: 76 },
  ],
}

/**
 * Clockwise perimeter seat coordinates (% of arena) for vertical portrait oval on mobile (<= 640px).
 * Slot 0 is anchored at 6 o'clock (bottom center) for the local player.
 */
const MOBILE_SEAT_LAYOUTS: Record<number, readonly SeatCoord[]> = {
  2: [
    { x: 50, y: 90 },
    { x: 50, y: 9 },
  ],
  3: [
    { x: 50, y: 90 },
    { x: 20, y: 18 },
    { x: 80, y: 18 },
  ],
  4: [
    { x: 50, y: 90 },
    { x: 15, y: 49 },
    { x: 50, y: 9 },
    { x: 85, y: 49 },
  ],
  5: [
    { x: 50, y: 90 },
    { x: 15, y: 63 },
    { x: 20, y: 18 },
    { x: 80, y: 18 },
    { x: 85, y: 63 },
  ],
  6: [
    { x: 50, y: 90 },
    { x: 15, y: 66 },
    { x: 15, y: 27 },
    { x: 50, y: 9 },
    { x: 85, y: 27 },
    { x: 85, y: 66 },
  ],
  7: [
    { x: 50, y: 90 },
    { x: 15, y: 70 },
    { x: 14, y: 37 },
    { x: 28, y: 10 },
    { x: 72, y: 10 },
    { x: 86, y: 37 },
    { x: 85, y: 70 },
  ],
  8: [
    { x: 50, y: 90 },
    { x: 16, y: 74 },
    { x: 14, y: 48 },
    { x: 18, y: 21 },
    { x: 50, y: 9 },
    { x: 82, y: 21 },
    { x: 86, y: 48 },
    { x: 84, y: 74 },
  ],
}

function cardKey(card: PokerCard): string {
  return `${card.rank}:${card.suit}`
}

function isRedSuit(suit: CardSuit): boolean {
  return suit === 'h' || suit === 'd'
}

function getActionTone(label?: string): string {
  if (!label) return ''
  const lower = label.toLowerCase()
  if (lower.includes('fold')) return 'is-fold'
  if (lower.includes('all-in') || lower.includes('all in')) return 'is-allin'
  if (lower.includes('raise') || lower.includes('bet')) return 'is-raise'
  if (lower.includes('call')) return 'is-call'
  if (lower.includes('check')) return 'is-check'
  return 'is-blind'
}

function getChipTones(amount: number, maxDiscs = 5): string[] {
  if (amount <= 0) return []
  const denoms: Array<{ val: number; tone: string }> = [
    { val: 1000, tone: 'is-chip-1000' },
    { val: 500, tone: 'is-chip-500' },
    { val: 100, tone: 'is-chip-100' },
    { val: 25, tone: 'is-chip-25' },
    { val: 1, tone: 'is-chip-5' },
  ]
  const discs: string[] = []
  let rem = amount
  for (const d of denoms) {
    const count = Math.floor(rem / d.val)
    if (count > 0) {
      const add = Math.min(count, maxDiscs - discs.length)
      for (let i = 0; i < add; i += 1) {
        discs.push(d.tone)
      }
      rem %= d.val
    }
    if (discs.length >= maxDiscs) break
  }
  if (discs.length === 0) discs.push('is-chip-5')
  return discs
}

function computeTableCardPos(
  seatPos: SeatCoord,
  visualSlot: number,
  isCompact: boolean,
): SeatCoord {
  if (visualSlot === 0) {
    return { x: 50, y: isCompact ? 74 : 72.5 }
  }
  const dx = 50 - seatPos.x
  const dy = 50 - seatPos.y
  const isSide = Math.abs(seatPos.y - 50) < 16
  if (isCompact) {
    return {
      x: seatPos.x + dx * (isSide ? 0.25 : 0.22),
      y: seatPos.y + dy * (isSide ? 0.16 : 0.24),
    }
  }
  return {
    x: seatPos.x + dx * (isSide ? 0.205 : 0.245),
    y: seatPos.y + dy * 0.285,
  }
}

function computeBetPos(
  seatPos: SeatCoord,
  visualSlot: number,
  isCompact: boolean,
): SeatCoord {
  if (visualSlot === 0) {
    return { x: isCompact ? 71 : 63.5, y: isCompact ? 71 : 69 }
  }
  if (Math.abs(seatPos.x - 50) < 10 && seatPos.y < 25) {
    return { x: isCompact ? 70 : 62.5, y: isCompact ? 24 : 24.5 }
  }
  const dx = 50 - seatPos.x
  const dy = 48 - seatPos.y
  const isSide = Math.abs(seatPos.y - 50) < 16
  return {
    x: seatPos.x + dx * (isCompact ? 0.36 : 0.365),
    y: seatPos.y + dy * (isCompact ? 0.35 : 0.38) + (isSide ? 9.5 : 0),
  }
}

function computeDealerPuckPos(
  seatPos: SeatCoord,
  visualSlot: number,
  isCompact: boolean,
): SeatCoord {
  if (visualSlot === 0) {
    return { x: isCompact ? 30 : 37, y: isCompact ? 77 : 75 }
  }
  const dx = 50 - seatPos.x
  const dy = 50 - seatPos.y
  const dist = Math.hypot(dx, dy) || 1
  const perpX = dy / dist
  const perpY = -dx / dist
  return {
    x: Math.max(14, Math.min(86, seatPos.x + dx * 0.2 + perpX * (isCompact ? 7 : 6.2))),
    y: Math.max(17, Math.min(82, seatPos.y + dy * 0.21 + perpY * (isCompact ? 5.2 : 4.6))),
  }
}

function ChipStack({
  amount,
  size = 'sm',
}: {
  amount: number
  size?: 'sm' | 'md'
}) {
  const discs = getChipTones(amount, size === 'md' ? 6 : 5)
  if (discs.length === 0) return null
  return (
    <span className={`ag-poker-chip-stack is-${size}`} aria-hidden="true">
      {discs.map((tone, idx) => (
        <span key={idx} className={`ag-poker-chip-disc ${tone}`} />
      ))}
    </span>
  )
}

function TableCard3D({
  card,
  faceUp,
  size = 'md',
  highlighted = false,
  dimmed = false,
  className = '',
  style,
}: {
  card: PokerCard | null
  faceUp: boolean
  size?: 'sm' | 'md' | 'lg'
  highlighted?: boolean
  dimmed?: boolean
  className?: string
  style?: CSSProperties
}) {
  const isShownFaceUp = Boolean(faceUp && card)
  const rankText = card ? RANK_LABEL[card.rank] : ''
  const suitText = card ? SUIT_GLYPH[card.suit] : ''
  const toneClass = card ? (isRedSuit(card.suit) ? 'is-red' : 'is-black') : ''

  return (
    <span
      className={`ag-poker-card-3d is-${size}${isShownFaceUp ? ' is-face-up' : ''}${
        highlighted ? ' is-highlighted' : ''
      }${dimmed ? ' is-dimmed' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      aria-label={isShownFaceUp && card ? `${rankText}${suitText}` : 'Hidden card'}
    >
      <span className="ag-poker-card-inner">
        <span className={`ag-poker-card-face is-front ${toneClass}`}>
          {card && (
            <>
              <span className="ag-poker-card-corner top">
                <span className="ag-poker-card-rank">{rankText}</span>
                <span className="ag-poker-card-suit">{suitText}</span>
              </span>
              {size !== 'sm' && (
                <span className="ag-poker-card-pip" aria-hidden="true">
                  {suitText}
                </span>
              )}
              {size === 'lg' && (
                <span className="ag-poker-card-corner bottom" aria-hidden="true">
                  <span className="ag-poker-card-rank">{rankText}</span>
                  <span className="ag-poker-card-suit">{suitText}</span>
                </span>
              )}
            </>
          )}
        </span>
        <span className="ag-poker-card-face is-back" aria-hidden="true">
          <span className="ag-poker-card-back-pattern" />
        </span>
      </span>
    </span>
  )
}

interface SoundSnapshot {
  handNumber: number
  phase: PokerPhase
  communityCount: number
  actingPubkey: string | null
  winnerCount: number
  revealedCount: number
  seats: Record<
    string,
    { bet: number; folded: boolean; allIn: boolean; acted: boolean; label: string }
  >
}

function captureSoundSnapshot(state: PokerPublicState): SoundSnapshot {
  const seats: SoundSnapshot['seats'] = {}
  for (const s of state.seats) {
    seats[s.pubkey.toLowerCase()] = {
      bet: s.betThisStreet,
      folded: s.folded,
      allIn: s.allIn,
      acted: s.actedThisStreet,
      label: s.lastActionLabel ?? '',
    }
  }
  return {
    handNumber: state.handNumber,
    phase: state.phase,
    communityCount: state.communityCards.length,
    actingPubkey: state.actingPubkey ? state.actingPubkey.toLowerCase() : null,
    winnerCount: state.winners.length,
    revealedCount: Object.keys(state.revealedHands).length,
    seats,
  }
}

export function PokerTableView({
  state,
  myPubkey,
  myHoleCards,
  isHost,
  getAvatarUrl,
  onJoinSeat,
  onLeaveSeat,
  onStartHand,
  onAction,
  onVoteOut,
  myVoteTargets,
}: PokerTableViewProps) {
  const normalizedMyPubkey = myPubkey.trim().toLowerCase()
  const [voteTarget, setVoteTarget] = useState('')
  const [wagerAmount, setWagerAmount] = useState<number>(state.bigBlind * 2)
  const [isCompactViewport, setIsCompactViewport] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 640 : false,
  )
  const arenaRef = useRef<HTMLDivElement | null>(null)
  const [arenaSize, setArenaSize] = useState<{ w: number; h: number }>(() =>
    typeof window !== 'undefined' && window.innerWidth <= 640
      ? { w: 350, h: 420 }
      : { w: 840, h: 456 },
  )

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(max-width: 640px)')
    const onChange = (e: MediaQueryListEvent) => setIsCompactViewport(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const el = arenaRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect && rect.width > 0 && rect.height > 0) {
        setArenaSize({ w: rect.width, h: rect.height })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const mySeat: PokerSeat | null = useMemo(
    () => state.seats.find((s) => s.pubkey.toLowerCase() === normalizedMyPubkey) ?? null,
    [state.seats, normalizedMyPubkey],
  )

  const isLiveHand =
    state.phase === 'preflop' ||
    state.phase === 'flop' ||
    state.phase === 'turn' ||
    state.phase === 'river'
  const isLobby = state.phase === 'lobby'
  const isShowdown = state.phase === 'showdown' || state.phase === 'finished'
  const isMyTurn = Boolean(
    isLiveHand && state.actingPubkey && state.actingPubkey.toLowerCase() === normalizedMyPubkey,
  )

  const actingSeat = useMemo(
    () =>
      state.actingPubkey
        ? (state.seats.find(
            (s) => s.pubkey.toLowerCase() === state.actingPubkey?.toLowerCase(),
          ) ?? null)
        : null,
    [state.seats, state.actingPubkey],
  )

  const legal = useMemo(
    () => getLegalPokerActions(state, normalizedMyPubkey),
    [state, normalizedMyPubkey],
  )

  const canBetOrRaise =
    isMyTurn && legal.maxBetOrRaiseTo > 0 && legal.maxBetOrRaiseTo >= legal.minBetOrRaiseTo
  const clampedWager = canBetOrRaise
    ? Math.max(legal.minBetOrRaiseTo, Math.min(legal.maxBetOrRaiseTo, wagerAmount))
    : legal.minBetOrRaiseTo

  // Live made-hand hint once community cards are out
  const liveHandEvaluation = useMemo(() => {
    if (!myHoleCards || state.communityCards.length < 3) return null
    try {
      return evaluateBestFiveCardHand([...myHoleCards, ...state.communityCards])
    } catch {
      return null
    }
  }, [myHoleCards, state.communityCards])

  // Winning best-5 card keys for golden showdown highlight
  const highlightedCardKeys = useMemo(() => {
    const keys = new Set<string>()
    if (!isShowdown || state.winners.length === 0 || state.communityCards.length < 3) {
      return keys
    }
    for (const w of state.winners) {
      const pk = w.pubkey.toLowerCase()
      const hole =
        state.revealedHands[pk] ??
        (pk === normalizedMyPubkey && myHoleCards ? myHoleCards : undefined)
      if (!hole) continue
      try {
        const evalHand = evaluateBestFiveCardHand([...hole, ...state.communityCards])
        for (const c of evalHand.bestFive) {
          keys.add(cardKey(c))
        }
      } catch {
        // Ignore partial hands
      }
    }
    return keys
  }, [isShowdown, state.winners, state.communityCards, state.revealedHands, normalizedMyPubkey, myHoleCards])

  const winnerAmountByPubkey = useMemo(() => {
    const map = new Map<string, number>()
    for (const w of state.winners) {
      const pk = w.pubkey.toLowerCase()
      map.set(pk, (map.get(pk) ?? 0) + w.amountWon)
    }
    return map
  }, [state.winners])

  // Procedural WebAudio cues on live state transitions (silent on initial mount, zero double-fires)
  const prevSoundRef = useRef<SoundSnapshot | null>(null)
  useEffect(() => {
    const prev = prevSoundRef.current
    const curr = captureSoundSnapshot(state)
    prevSoundRef.current = curr
    if (!prev) return

    const liveNow =
      state.phase === 'preflop' ||
      state.phase === 'flop' ||
      state.phase === 'turn' ||
      state.phase === 'river'

    // 1. New hand dealt -> staggered card deal swishes + blind post chip clink
    if (state.handNumber > prev.handNumber && liveNow) {
      const activeCount = state.seats.filter((s) => !s.sittingOut).length
      const dealCards = Math.min(Math.max(activeCount * 2, 4), 12)
      for (let i = 0; i < dealCards; i += 1) {
        playGameSound('card-deal', i * 70)
      }
      playGameSound('chip-bet', 130)
    }

    // 2. Community cards dealt (Flop / Turn / River) -> staggered 3D card flips from deck
    if (
      state.handNumber === prev.handNumber &&
      state.communityCards.length > prev.communityCount
    ) {
      const added = state.communityCards.length - prev.communityCount
      for (let i = 0; i < added; i += 1) {
        playGameSound('card-flip', i * 115)
      }
    }

    // 3. Showdown hole card reveals
    if (
      state.handNumber === prev.handNumber &&
      curr.revealedCount > prev.revealedCount
    ) {
      playGameSound('card-flip', 70)
    }

    // 4. Individual seat actions within the same hand
    if (state.handNumber === prev.handNumber) {
      let playedAllIn = false
      let playedFold = false
      let playedBet = false
      let playedCheck = false

      for (const seat of state.seats) {
        const pk = seat.pubkey.toLowerCase()
        const old = prev.seats[pk]
        if (!old) continue

        if (seat.allIn && !old.allIn) {
          playedAllIn = true
        } else if (seat.folded && !old.folded) {
          playedFold = true
        } else if (seat.betThisStreet > old.bet) {
          playedBet = true
        } else if (
          (seat.actedThisStreet && !old.acted && seat.betThisStreet === old.bet && !seat.folded) ||
          (seat.lastActionLabel &&
            seat.lastActionLabel !== old.label &&
            seat.lastActionLabel.toLowerCase().startsWith('check'))
        ) {
          playedCheck = true
        }
      }

      if (playedAllIn) playGameSound('chip-allin')
      else if (playedBet) playGameSound('chip-bet')
      if (playedFold) playGameSound('card-fold')
      if (playedCheck) playGameSound('check-tap')
    }

    // 5. Pot awarded at showdown / fold-out
    if (curr.winnerCount > 0 && prev.winnerCount === 0) {
      playGameSound('chip-pot-win', 180)
    }

    // 6. Subtle chime when turn arrives on local player
    if (
      liveNow &&
      curr.actingPubkey === normalizedMyPubkey &&
      prev.actingPubkey !== normalizedMyPubkey
    ) {
      playGameSound('your-turn', state.handNumber > prev.handNumber ? 480 : 110)
    }
  }, [state, normalizedMyPubkey])

  // Build clockwise perimeter slots (2..8) rotated so local player sits at 6 o'clock (slot 0)
  const totalSlots = Math.max(2, Math.min(8, state.maxSeats))
  const seatLayout = (isCompactViewport ? MOBILE_SEAT_LAYOUTS : DESKTOP_SEAT_LAYOUTS)[totalSlots] ??
    DESKTOP_SEAT_LAYOUTS[6]
  const anchorSeatIndex = mySeat ? mySeat.seatIndex : 0

  const seatByIndex = useMemo(() => {
    const map = new Map<number, PokerSeat>()
    for (const s of state.seats) {
      map.set(s.seatIndex, s)
    }
    return map
  }, [state.seats])

  // Clockwise deal order starting left of dealer for staggered deal animation
  const dealOrderBySeatIndex = useMemo(() => {
    const active = state.seats
      .filter((s) => !s.sittingOut)
      .sort((a, b) => a.seatIndex - b.seatIndex)
    const map = new Map<number, number>()
    if (active.length === 0) return map
    const ordered = [...active].sort((a, b) => {
      const da = (a.seatIndex - state.dealerSeatIndex - 1 + totalSlots) % totalSlots
      const db = (b.seatIndex - state.dealerSeatIndex - 1 + totalSlots) % totalSlots
      return da - db
    })
    ordered.forEach((s, idx) => map.set(s.seatIndex, idx))
    return map
  }, [state.seats, state.dealerSeatIndex, totalSlots])

  const activeDealtSeatCount = dealOrderBySeatIndex.size || 1

  const canJoinOpenSeat = !mySeat && state.seats.length < state.maxSeats && state.phase !== 'finished'
  const canDealNext = isHost && (isLobby || isShowdown) && canStartPokerHand(state)

  const tableChampion = useMemo(() => {
    if (state.phase !== 'showdown' && state.phase !== 'finished') return null
    const withChips = state.seats.filter((s) => s.chips > 0)
    if (state.seats.length >= 2 && withChips.length === 1) {
      return withChips[0]
    }
    return null
  }, [state.phase, state.seats])

  // Deck anchor (% of arena) for exact flight vector calculations
  const deckAnchor: SeatCoord = isCompactViewport ? { x: 24, y: 47 } : { x: 27, y: 50 }

  // Smoothly gliding dealer button coordinates on the felt
  const dealerVisualSlot = useMemo(() => {
    if (state.seats.length < 2) return null
    const dealerSeat = seatByIndex.get(state.dealerSeatIndex)
    if (!dealerSeat) return null
    return (dealerSeat.seatIndex - anchorSeatIndex + totalSlots) % totalSlots
  }, [state.seats.length, seatByIndex, state.dealerSeatIndex, anchorSeatIndex, totalSlots])

  const dealerPuckPos = useMemo(() => {
    if (dealerVisualSlot === null) return null
    const pos = seatLayout[dealerVisualSlot]
    if (!pos) return null
    return computeDealerPuckPos(pos, dealerVisualSlot, isCompactViewport)
  }, [dealerVisualSlot, seatLayout, isCompactViewport])

  const seatSlots = useMemo(() => {
    const list: Array<{
      seatIndex: number
      visualSlot: number
      seat: PokerSeat | null
      pos: SeatCoord
      cardPos: SeatCoord
      betPos: SeatCoord
    }> = []
    for (let visualSlot = 0; visualSlot < totalSlots; visualSlot += 1) {
      const seatIndex = (anchorSeatIndex + visualSlot) % totalSlots
      const pos = seatLayout[visualSlot] ?? { x: 50, y: 50 }
      list.push({
        seatIndex,
        visualSlot,
        seat: seatByIndex.get(seatIndex) ?? null,
        pos,
        cardPos: computeTableCardPos(pos, visualSlot, isCompactViewport),
        betPos: computeBetPos(pos, visualSlot, isCompactViewport),
      })
    }
    return list
  }, [totalSlots, anchorSeatIndex, seatLayout, seatByIndex, isCompactViewport])

  // Quick bet sizing presets
  const halfPotTarget = useMemo(() => {
    if (!canBetOrRaise) return legal.minBetOrRaiseTo
    const raw = Math.round((state.currentBet + state.pot * 0.5) / state.smallBlind) * state.smallBlind
    return Math.max(legal.minBetOrRaiseTo, Math.min(legal.maxBetOrRaiseTo, raw))
  }, [canBetOrRaise, legal, state.currentBet, state.pot, state.smallBlind])

  const fullPotTarget = useMemo(() => {
    if (!canBetOrRaise) return legal.minBetOrRaiseTo
    const raw = Math.round((state.currentBet + state.pot) / state.smallBlind) * state.smallBlind
    return Math.max(legal.minBetOrRaiseTo, Math.min(legal.maxBetOrRaiseTo, raw))
  }, [canBetOrRaise, legal, state.currentBet, state.pot, state.smallBlind])

  const sliderStep = Math.max(1, state.smallBlind)

  const handleCommitWager = () => {
    if (!canBetOrRaise) return
    if (clampedWager >= legal.maxBetOrRaiseTo) {
      onAction({ type: 'all-in' })
    } else {
      onAction({ type: legal.isRaise ? 'raise' : 'bet', amount: clampedWager })
    }
  }

  return (
    <div className="ag-poker-view" data-phase={state.phase}>
      {/* True Elliptical Casino Poker Table Stage */}
      <div
        ref={arenaRef}
        className={`ag-poker-arena${isCompactViewport ? ' is-compact' : ''}${
          isLobby ? ' is-lobby' : ''
        }`}
      >
        {/* Outer Padded Rail + Inner Emerald Casino Felt */}
        <div className="ag-poker-rail" aria-hidden="true">
          <div className={`ag-poker-felt${isLobby ? ' is-lobby' : ''}`}>
            <div className="ag-poker-bet-line" />
          </div>
        </div>

        {/* Center Felt Surface: Pot, 3D Stacked Deck, Community Board, Lobby / Winners */}
        <div className="ag-poker-center-stage">
          {isLobby ? (
            <div className="ag-poker-lobby-center">
              <div className="ag-poker-lobby-deck-wrap" aria-hidden="true">
                <div className="ag-poker-deck is-resting">
                  <span className="ag-poker-deck-layer l3" />
                  <span className="ag-poker-deck-layer l2" />
                  <span className="ag-poker-deck-layer l1" />
                  <span className="ag-poker-deck-top">
                    <span className="ag-poker-card-back-pattern" />
                  </span>
                </div>
              </div>

              <div className="ag-poker-lobby-stakes mono">
                {state.smallBlind}/{state.bigBlind} blinds · {state.fixedBuyIn.toLocaleString()}{' '}
                buy-in
              </div>
              <div className="ag-poker-lobby-count mono">
                {state.seats.length} / {state.maxSeats} seated
              </div>

              {canJoinOpenSeat ? (
                <button
                  type="button"
                  className="ag-poker-btn is-primary"
                  onClick={onJoinSeat}
                >
                  <UserPlus size={14} aria-hidden="true" />
                  <span>Sit In · {state.fixedBuyIn.toLocaleString()}</span>
                </button>
              ) : canDealNext ? (
                <button
                  type="button"
                  className="ag-poker-btn is-primary"
                  onClick={onStartHand}
                >
                  <Play size={14} aria-hidden="true" />
                  <span>Deal Hand</span>
                </button>
              ) : (
                <div className="ag-poker-lobby-status">
                  {!canStartPokerHand(state) ? 'Waiting for players' : 'Waiting for host'}
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Center Pot Display with Visual Casino Chip Stack */}
              <div
                key={`pot-${state.handNumber}-${state.pot}`}
                className={`ag-poker-pot-display${
                  isShowdown && state.winners.length > 0 ? ' is-awarded' : ''
                }`}
                aria-live="polite"
              >
                {state.pot > 0 && <ChipStack amount={state.pot} size="md" />}
                <div className="ag-poker-pot-pill mono">
                  <span className="ag-poker-pot-label">POT</span>
                  <span className="ag-poker-pot-amount">{state.pot.toLocaleString()}</span>
                </div>
                <span className="ag-poker-phase-chip mono">{PHASE_LABEL[state.phase]}</span>
              </div>

              {/* Visible 3D Stacked Deck + 5 Community Board Slots */}
              <div className="ag-poker-board-row">
                <div
                  key={`deck-${state.handNumber}-${state.communityCards.length}`}
                  className={`ag-poker-deck${isLiveHand ? ' is-dealing' : ''}`}
                  aria-hidden="true"
                >
                  <span className="ag-poker-deck-layer l3" />
                  <span className="ag-poker-deck-layer l2" />
                  <span className="ag-poker-deck-layer l1" />
                  <span className="ag-poker-deck-top">
                    <span className="ag-poker-card-back-pattern" />
                  </span>
                </div>

                <div className="ag-poker-board" aria-label="Community cards">
                  {[0, 1, 2, 3, 4].map((slotIdx) => {
                    const card = state.communityCards[slotIdx] ?? null
                    if (!card) {
                      return (
                        <span
                          key={`slot-${slotIdx}`}
                          className="ag-poker-card-slot is-md"
                          aria-hidden="true"
                        />
                      )
                    }
                    const cardStride = isCompactViewport ? 42 : 58
                    const fromDeckX = -(slotIdx * cardStride + (isCompactViewport ? 44 : 64))
                    const dealDelayMs = slotIdx < 3 ? slotIdx * 115 : 0
                    const boardStyle = {
                      '--from-deck-x': `${fromDeckX}px`,
                      '--board-deal-delay': `${dealDelayMs}ms`,
                    } as CSSProperties

                    return (
                      <TableCard3D
                        key={`board-${state.handNumber}-${slotIdx}`}
                        card={card}
                        faceUp
                        size="md"
                        highlighted={highlightedCardKeys.has(cardKey(card))}
                        className="is-board-deal"
                        style={boardStyle}
                      />
                    )
                  })}
                </div>
              </div>

              {/* Showdown / Winner Banner */}
              {isShowdown && state.winners.length > 0 && (
                <div className="ag-poker-winner-banner" role="status" aria-live="polite">
                  <span className="ag-poker-winner-icon" aria-hidden="true">
                    {tableChampion ? <Crown size={13} /> : <Trophy size={13} />}
                  </span>
                  <div className="ag-poker-winner-list">
                    {state.winners.map((w, idx) => (
                      <div key={`${w.pubkey}-${w.potIndex}-${idx}`} className="ag-poker-winner-line">
                        <strong className="ag-poker-winner-name">{w.displayName}</strong>
                        <span className="ag-poker-winner-amt mono">
                          +{w.amountWon.toLocaleString()}
                        </span>
                        {w.handLabel && (
                          <span className="ag-poker-winner-hand">{w.handLabel}</span>
                        )}
                      </div>
                    ))}
                  </div>
                  {canDealNext && (
                    <button
                      type="button"
                      className="ag-poker-btn is-primary is-compact"
                      onClick={onStartHand}
                    >
                      <Play size={12} aria-hidden="true" />
                      <span>Next Hand</span>
                    </button>
                  )}
                </div>
              )}

              {isShowdown && state.winners.length === 0 && canDealNext && (
                <div className="ag-poker-deal-next-row">
                  <button
                    type="button"
                    className="ag-poker-btn is-primary is-compact"
                    onClick={onStartHand}
                  >
                    <Play size={12} aria-hidden="true" />
                    <span>Deal Next Hand</span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Smoothly Gliding Ivory Dealer Puck (D) on the Felt */}
        {dealerPuckPos && !isLobby && (
          <div
            className="ag-poker-dealer-puck"
            style={{ left: `${dealerPuckPos.x}%`, top: `${dealerPuckPos.y}%` }}
            title="Dealer button"
            aria-label="Dealer button"
          >
            D
          </div>
        )}

        {/* Per-Seat Cards ON THE FELT (Animated Out From Deck + 3D Showdown Flip + Fold Muck) */}
        {!isLobby &&
          seatSlots.map(({ seat, cardPos }) => {
            if (!seat || seat.sittingOut) return null
            const pk = seat.pubkey.toLowerCase()
            const isMe = pk === normalizedMyPubkey
            const revealedHand = state.revealedHands[pk] ?? null
            const visiblePair = isMe ? (myHoleCards ?? revealedHand) : revealedHand
            const hasCards = Boolean(visiblePair) || isLiveHand || (isShowdown && !seat.folded)
            if (!hasCards) return null

            const dealOrder = dealOrderBySeatIndex.get(seat.seatIndex) ?? 0
            const dealDx = Math.round(((deckAnchor.x - cardPos.x) / 100) * arenaSize.w)
            const dealDy = Math.round(((deckAnchor.y - cardPos.y) / 100) * arenaSize.h)
            const muckDx = Math.round(((50 - cardPos.x) / 100) * arenaSize.w * 0.24)
            const muckDy = Math.round(((50 - cardPos.y) / 100) * arenaSize.h * 0.24)

            const cardsAnchorStyle = {
              left: `${cardPos.x}%`,
              top: `${cardPos.y}%`,
              '--muck-dx': `${muckDx}px`,
              '--muck-dy': `${muckDy}px`,
            } as CSSProperties

            const cardSize: 'sm' | 'md' | 'lg' = isMe
              ? isCompactViewport
                ? 'md'
                : 'lg'
              : 'sm'

            return (
              <div
                key={`felt-cards-${seat.seatIndex}`}
                className={`ag-poker-felt-cards${isMe ? ' is-hero' : ' is-opponent'}${
                  seat.folded ? ' is-folded' : ''
                }`}
                style={cardsAnchorStyle}
                aria-label={isMe ? 'Your hole cards' : `${seat.displayName}'s cards`}
              >
                {[0, 1].map((ci) => {
                  const c = visiblePair ? visiblePair[ci] : null
                  const isFaceUp = Boolean(c && (isMe || revealedHand))
                  const fanDeg = ci === 0 ? -6.5 : 6.5
                  const delayMs = (dealOrder + ci * activeDealtSeatCount) * 70
                  const cardStyle = {
                    '--deal-dx': `${dealDx}px`,
                    '--deal-dy': `${dealDy}px`,
                    '--card-fan': `${fanDeg}deg`,
                    '--deal-delay': `${delayMs}ms`,
                  } as CSSProperties

                  return (
                    <TableCard3D
                      key={`hole-${state.handNumber}-${seat.seatIndex}-${ci}`}
                      card={c}
                      faceUp={isFaceUp}
                      size={cardSize}
                      highlighted={Boolean(c && highlightedCardKeys.has(cardKey(c)))}
                      dimmed={seat.folded}
                      className="is-dealt-hole"
                      style={cardStyle}
                    />
                  )
                })}
              </div>
            )
          })}

        {/* Per-Seat Animated Felt Chip Bets */}
        {!isLobby &&
          seatSlots.map(({ seat, pos, betPos }) => {
            if (!seat || seat.betThisStreet <= 0) return null
            const betFromX = Math.round(((pos.x - betPos.x) / 100) * arenaSize.w)
            const betFromY = Math.round(((pos.y - betPos.y) / 100) * arenaSize.h)
            const betStyle = {
              left: `${betPos.x}%`,
              top: `${betPos.y}%`,
              '--bet-from-x': `${betFromX}px`,
              '--bet-from-y': `${betFromY}px`,
            } as CSSProperties

            return (
              <div
                key={`bet-${state.handNumber}-${state.phase}-${seat.seatIndex}-${seat.betThisStreet}`}
                className="ag-poker-felt-bet"
                style={betStyle}
                aria-label={`${seat.displayName} bet ${seat.betThisStreet}`}
              >
                <ChipStack amount={seat.betThisStreet} size="sm" />
                <span className="ag-poker-felt-bet-amt mono">
                  {seat.betThisStreet.toLocaleString()}
                </span>
              </div>
            )
          })}

        {/* Perimeter Seat Pods & Empty Seat Rings Around All Sides of the Oval */}
        {seatSlots.map(({ seatIndex, visualSlot, seat, pos }) => {
          const seatStyle: CSSProperties = {
            left: `${pos.x}%`,
            top: `${pos.y}%`,
          }

          if (!seat) {
            if (canJoinOpenSeat) {
              return (
                <button
                  key={`empty-${seatIndex}`}
                  type="button"
                  className="ag-poker-empty-seat is-joinable"
                  style={seatStyle}
                  onClick={onJoinSeat}
                  title={`Sit in seat ${seatIndex + 1} (${state.fixedBuyIn.toLocaleString()} chips)`}
                >
                  <UserPlus size={12} aria-hidden="true" />
                  <span>Sit</span>
                </button>
              )
            }
            return (
              <div
                key={`empty-${seatIndex}`}
                className="ag-poker-empty-seat"
                style={seatStyle}
                aria-hidden="true"
              >
                <span>Open</span>
              </div>
            )
          }

          const pk = seat.pubkey.toLowerCase()
          const isMe = pk === normalizedMyPubkey
          const isActing = Boolean(
            isLiveHand && state.actingPubkey && state.actingPubkey.toLowerCase() === pk,
          )
          const isSB = !isLobby && state.smallBlindSeatIndex === seat.seatIndex
          const isBB = !isLobby && state.bigBlindSeatIndex === seat.seatIndex
          const wonAmount = winnerAmountByPubkey.get(pk) ?? 0
          const isWinner = wonAmount > 0
          const actionTone = getActionTone(seat.lastActionLabel)
          const tagPlacement = pos.y < 30 ? 'is-below' : 'is-above'

          return (
            <div
              key={`seat-${seat.seatIndex}`}
              className={`ag-poker-seat-pod${isMe ? ' is-me' : ''}${
                isActing ? ' is-acting' : ''
              }${seat.folded ? ' is-folded' : ''}${isWinner ? ' is-winner' : ''}${
                visualSlot === 0 ? ' is-bottom-anchor' : ''
              }`}
              style={seatStyle}
            >
              {/* Floating Winner Payout or Action Tag */}
              {isWinner ? (
                <span className={`ag-poker-seat-float is-win mono ${tagPlacement}`}>
                  +{wonAmount.toLocaleString()}
                </span>
              ) : (
                !isLobby &&
                seat.lastActionLabel && (
                  <span
                    key={`act-${state.handNumber}-${seat.seatIndex}-${seat.lastActionLabel}`}
                    className={`ag-poker-seat-float ${actionTone} ${tagPlacement}`}
                  >
                    {seat.lastActionLabel}
                  </span>
                )
              )}

              <div className="ag-poker-seat-pod-inner">
                <AvatarImg
                  pubkey={seat.pubkey}
                  pictureUrl={getAvatarUrl?.(seat.pubkey)}
                  alt={seat.displayName}
                  width={32}
                  height={32}
                  className="ag-poker-seat-avatar"
                />

                <div className="ag-poker-seat-meta">
                  <div className="ag-poker-seat-top-row">
                    <span className="ag-poker-seat-name truncate">
                      {seat.displayName}
                    </span>
                    {isSB && <span className="ag-poker-role-tag mono">SB</span>}
                    {isBB && <span className="ag-poker-role-tag mono">BB</span>}
                  </div>
                  <div className="ag-poker-seat-bottom-row">
                    <span className="ag-poker-seat-stack mono">
                      {seat.chips.toLocaleString()}
                    </span>
                    {seat.allIn && !seat.folded && (
                      <span className="ag-poker-state-pill is-allin">ALL-IN</span>
                    )}
                    {seat.sittingOut && <span className="ag-poker-state-pill">OUT</span>}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Sleek Compact Bottom Action & Utility Dock */}
      <div className="ag-poker-dock">
        {isLiveHand && mySeat && isMyTurn && legal.canFold ? (
          <div className="ag-poker-live-bar">
            <div className="ag-poker-live-status">
              <span className="ag-poker-turn-indicator">
                <span className="ag-game-mini-turn-dot" aria-hidden="true" />
                <span>Your turn</span>
              </span>
              {liveHandEvaluation && (
                <span className="ag-poker-hand-strength">
                  <Sparkles size={11} aria-hidden="true" />
                  <span>{liveHandEvaluation.label}</span>
                </span>
              )}
            </div>

            <div className="ag-poker-actions-dock" role="group" aria-label="Poker actions">
              {canBetOrRaise && (
                <div className="ag-poker-wager-controls">
                  <div className="ag-poker-presets">
                    <button
                      type="button"
                      className={`ag-poker-preset-btn mono${
                        clampedWager === legal.minBetOrRaiseTo ? ' is-active' : ''
                      }`}
                      onClick={() => setWagerAmount(legal.minBetOrRaiseTo)}
                    >
                      Min
                    </button>
                    <button
                      type="button"
                      className={`ag-poker-preset-btn mono${
                        clampedWager === halfPotTarget ? ' is-active' : ''
                      }`}
                      onClick={() => setWagerAmount(halfPotTarget)}
                    >
                      ½
                    </button>
                    <button
                      type="button"
                      className={`ag-poker-preset-btn mono${
                        clampedWager === fullPotTarget ? ' is-active' : ''
                      }`}
                      onClick={() => setWagerAmount(fullPotTarget)}
                    >
                      Pot
                    </button>
                    <button
                      type="button"
                      className={`ag-poker-preset-btn mono${
                        clampedWager === legal.maxBetOrRaiseTo ? ' is-active' : ''
                      }`}
                      onClick={() => setWagerAmount(legal.maxBetOrRaiseTo)}
                    >
                      All-In
                    </button>
                  </div>

                  <div className="ag-poker-slider-row">
                    <input
                      type="range"
                      className="ag-poker-slider"
                      min={legal.minBetOrRaiseTo}
                      max={legal.maxBetOrRaiseTo}
                      step={sliderStep}
                      value={clampedWager}
                      onChange={(e) => setWagerAmount(Number(e.target.value))}
                      aria-label={legal.isRaise ? 'Raise amount' : 'Bet amount'}
                    />
                    <span className="ag-poker-wager-readout mono">
                      {clampedWager.toLocaleString()}
                    </span>
                  </div>
                </div>
              )}

              <div className="ag-poker-action-row">
                <button
                  type="button"
                  className="ag-poker-btn is-fold"
                  onClick={() => onAction({ type: 'fold' })}
                >
                  Fold
                </button>

                {legal.canCheck ? (
                  <button
                    type="button"
                    className="ag-poker-btn is-check"
                    onClick={() => onAction({ type: 'check' })}
                  >
                    Check
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ag-poker-btn is-call"
                    onClick={() => onAction({ type: 'call' })}
                  >
                    {legal.callAmount >= mySeat.chips
                      ? `All-In ${legal.callAmount.toLocaleString()}`
                      : `Call ${legal.callAmount.toLocaleString()}`}
                  </button>
                )}

                {canBetOrRaise && (
                  <button
                    type="button"
                    className="ag-poker-btn is-raise"
                    onClick={handleCommitWager}
                  >
                    {clampedWager >= legal.maxBetOrRaiseTo
                      ? `All-In ${clampedWager.toLocaleString()}`
                      : legal.isRaise
                        ? `Raise ${clampedWager.toLocaleString()}`
                        : `Bet ${clampedWager.toLocaleString()}`}
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {/* Minimal Quiet Utility Strip */}
        <div className="ag-poker-util-bar">
          <div className="ag-poker-util-left">
            {!isLobby && canJoinOpenSeat && (
              <button
                type="button"
                className="ag-poker-btn is-primary is-compact"
                onClick={onJoinSeat}
              >
                <UserPlus size={13} aria-hidden="true" />
                <span>Sit In · {state.fixedBuyIn.toLocaleString()}</span>
              </button>
            )}
            {liveHandEvaluation && !isMyTurn && mySeat && !mySeat.folded && (
              <span className="ag-poker-hand-strength">
                <Sparkles size={11} aria-hidden="true" />
                <span>{liveHandEvaluation.label}</span>
              </span>
            )}
            {isLiveHand && !isMyTurn && (
              <span className="ag-poker-table-note">
                {mySeat?.folded
                  ? 'Folded'
                  : mySeat?.allIn
                    ? 'All-In'
                    : actingSeat
                      ? `${actingSeat.displayName} to act`
                      : 'Dealing…'}
              </span>
            )}
            {!mySeat && state.seats.length >= state.maxSeats && (
              <span className="ag-poker-table-note mono">
                {state.seats.length}/{state.maxSeats} · Watching
              </span>
            )}
            {mySeat && state.phase === 'showdown' && !canDealNext && (
              <span className="ag-poker-table-note">
                {!canStartPokerHand(state) ? 'Waiting for players' : 'Waiting for host'}
              </span>
            )}
          </div>

          <div className="ag-poker-util-right">
            {mySeat && (
              <button
                type="button"
                className="ag-poker-btn is-subtle"
                onClick={onLeaveSeat}
                title="Leave table"
              >
                <LogOut size={13} aria-hidden="true" />
                <span>Leave table</span>
              </button>
            )}

            {mySeat && state.seats.length >= 3 && (
              <div className="ag-poker-confirm-group" role="group" aria-label="Vote to remove a player">
                <select
                  className="ag-poker-btn is-subtle"
                  aria-label="Player to vote out"
                  value={state.seats.some((s) => s.pubkey === voteTarget) ? voteTarget : ''}
                  onChange={(e) => setVoteTarget(e.target.value)}
                >
                  <option value="">Select player</option>
                  {state.seats.filter((s) => s.pubkey !== normalizedMyPubkey).map((seat) => (
                    <option key={seat.pubkey} value={seat.pubkey} disabled={myVoteTargets.includes(seat.pubkey)}>
                      {seat.displayName}{seat.pubkey === state.hostPubkey ? ' (dealer)' : ''}
                    </option>
                  ))}
                </select>
                <button type="button" className="ag-poker-btn is-subtle"
                  disabled={!voteTarget || myVoteTargets.includes(voteTarget) || !state.seats.some((s) => s.pubkey === voteTarget)}
                  title={`Removal requires ${pokerVoteThreshold(state.seats.length)} seated votes`}
                  onClick={() => onVoteOut(voteTarget)}>
                  {myVoteTargets.includes(voteTarget) ? 'Vote sent' : 'Vote out'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default PokerTableView
