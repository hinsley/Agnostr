import { useEffect, useMemo, useState } from 'react'
import { Crown, LogOut, Play, Sparkles, Trophy, UserPlus, X } from 'lucide-react'
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
} from '../../lib/games/pokerEngine.ts'

export interface PokerTableViewProps {
  state: PokerPublicState
  myPubkey: string
  myHoleCards: [PokerCard, PokerCard] | null
  isHost: boolean
  onJoinSeat: () => void
  onLeaveSeat: () => void
  onStartHand: () => void
  onAction: (action: PokerAction) => void
  onEndTable?: () => void
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

function cardKey(card: PokerCard): string {
  return `${card.rank}:${card.suit}`
}

function isRedSuit(suit: CardSuit): boolean {
  return suit === 'h' || suit === 'd'
}

function PlayingCard({
  card,
  faceDown = false,
  size = 'md',
  highlighted = false,
  dimmed = false,
}: {
  card: PokerCard | null
  faceDown?: boolean
  size?: 'sm' | 'md' | 'lg'
  highlighted?: boolean
  dimmed?: boolean
}) {
  if (faceDown) {
    return (
      <span
        className={`ag-poker-card ag-poker-card-back is-${size}${dimmed ? ' is-dimmed' : ''}`}
        aria-label="Hidden card"
      >
        <span className="ag-poker-card-back-pattern" aria-hidden="true" />
      </span>
    )
  }

  if (!card) {
    return <span className={`ag-poker-card-slot is-${size}`} aria-hidden="true" />
  }

  const rankText = RANK_LABEL[card.rank]
  const suitText = SUIT_GLYPH[card.suit]
  const toneClass = isRedSuit(card.suit) ? 'is-red' : 'is-black'

  return (
    <span
      className={`ag-poker-card is-${size} ${toneClass}${highlighted ? ' is-highlighted' : ''}${
        dimmed ? ' is-dimmed' : ''
      }`}
      aria-label={`${rankText}${suitText}`}
    >
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
    </span>
  )
}

export function PokerTableView({
  state,
  myPubkey,
  myHoleCards,
  isHost,
  onJoinSeat,
  onLeaveSeat,
  onStartHand,
  onAction,
  onEndTable,
}: PokerTableViewProps) {
  const myPk = myPubkey.trim().toLowerCase()
  const mySeat = useMemo(
    () => state.seats.find((s) => s.pubkey.toLowerCase() === myPk) ?? null,
    [state.seats, myPk],
  )
  const isLiveHand =
    state.phase === 'preflop' ||
    state.phase === 'flop' ||
    state.phase === 'turn' ||
    state.phase === 'river'
  const isMyTurn = Boolean(isLiveHand && state.actingPubkey?.toLowerCase() === myPk)

  const legal = useMemo(
    () => getLegalPokerActions(state, myPk),
    [state, myPk],
  )

  const canBetOrRaise =
    isMyTurn && legal.minBetOrRaiseTo > 0 && legal.maxBetOrRaiseTo >= legal.minBetOrRaiseTo

  const [wagerAmount, setWagerAmount] = useState<number>(legal.minBetOrRaiseTo || state.bigBlind)
  const [confirmEndTable, setConfirmEndTable] = useState(false)

  // Keep wager slider smoothly synced within valid bounds whenever street/turn/bet changes
  useEffect(() => {
    if (!canBetOrRaise) return
    setWagerAmount((prev) => {
      if (prev < legal.minBetOrRaiseTo || prev > legal.maxBetOrRaiseTo) {
        return legal.minBetOrRaiseTo
      }
      return prev
    })
  }, [
    canBetOrRaise,
    legal.minBetOrRaiseTo,
    legal.maxBetOrRaiseTo,
    state.handNumber,
    state.phase,
    state.currentBet,
    state.actingPubkey,
  ])

  useEffect(() => {
    setConfirmEndTable(false)
  }, [state.tableId, state.handNumber])

  const clampedWager = canBetOrRaise
    ? Math.max(legal.minBetOrRaiseTo, Math.min(legal.maxBetOrRaiseTo, Math.floor(wagerAmount)))
    : 0

  const myHandEval = useMemo(() => {
    if (!myHoleCards || state.communityCards.length < 3) return null
    return evaluateBestFiveCardHand([...myHoleCards, ...state.communityCards])
  }, [myHoleCards, state.communityCards])

  const highlightedCardKeys = useMemo(() => {
    const keys = new Set<string>()
    if (myHandEval && mySeat && !mySeat.folded) {
      for (const c of myHandEval.bestFive) {
        keys.add(cardKey(c))
      }
    }
    return keys
  }, [myHandEval, mySeat])

  const winnerPubkeySet = useMemo(
    () => new Set(state.winners.map((w) => w.pubkey.toLowerCase())),
    [state.winners],
  )

  const tableChampion = useMemo(() => {
    if (state.phase !== 'finished') return null
    const survivors = state.seats.filter((s) => s.chips > 0)
    return survivors.length === 1 ? survivors[0] : null
  }, [state.phase, state.seats])

  const canDealNext = isHost && (state.phase === 'lobby' || state.phase === 'showdown') && canStartPokerHand(state)
  const canJoinOpenSeat = !mySeat && state.seats.length < state.maxSeats
  const hasMultiplePots = useMemo(
    () => state.winners.some((w) => w.potIndex > 0),
    [state.winners],
  )

  // Quick raise/bet presets clamped to exact No-Limit legal bounds
  const halfPotTarget = canBetOrRaise
    ? Math.max(
        legal.minBetOrRaiseTo,
        Math.min(
          legal.maxBetOrRaiseTo,
          Math.round(state.currentBet + Math.max(state.pot * 0.5, state.bigBlind)),
        ),
      )
    : 0
  const fullPotTarget = canBetOrRaise
    ? Math.max(
        legal.minBetOrRaiseTo,
        Math.min(
          legal.maxBetOrRaiseTo,
          Math.round(state.currentBet + Math.max(state.pot, state.bigBlind)),
        ),
      )
    : 0
  const sliderStep = Math.max(1, state.smallBlind >= 5 ? state.smallBlind : 1)

  const handleCommitWager = () => {
    if (!canBetOrRaise) return
    if (clampedWager >= legal.maxBetOrRaiseTo) {
      onAction({ type: 'all-in' })
      return
    }
    onAction({
      type: legal.isRaise ? 'raise' : 'bet',
      amount: clampedWager,
    })
  }

  return (
    <div className="ag-poker-root" data-phase={state.phase}>
      {/* Center Felt Oval: Table Metadata, Pot, 5 Community Cards, Status & Winners */}
      <div className="ag-poker-felt">
        <div className="ag-poker-felt-meta">
          <span className="ag-poker-phase-pill mono">{PHASE_LABEL[state.phase]}</span>
          <span className="ag-poker-blinds-pill mono">
            {state.smallBlind}/{state.bigBlind} · {state.fixedBuyIn.toLocaleString()} buy-in
            {state.handNumber > 0 ? ` · Hand #${state.handNumber}` : ''}
          </span>
        </div>

        <div className="ag-poker-pot-row">
          <div className="ag-poker-pot-pill mono" aria-live="polite">
            <span className="ag-poker-pot-label">POT</span>
            <span className="ag-poker-pot-amount">{state.pot.toLocaleString()}</span>
          </div>
          {isLiveHand && state.currentBet > 0 && (
            <span className="ag-poker-street-bet mono">
              Bet {state.currentBet.toLocaleString()}
            </span>
          )}
        </div>

        <div className="ag-poker-board" aria-label="Community cards">
          {[0, 1, 2, 3, 4].map((slotIdx) => {
            const card = state.communityCards[slotIdx] ?? null
            return (
              <PlayingCard
                key={slotIdx}
                card={card}
                size="md"
                highlighted={Boolean(card && highlightedCardKeys.has(cardKey(card)))}
              />
            )
          })}
        </div>

        {state.lastActionText && (
          <div className="ag-poker-ticker truncate" role="status" aria-live="polite">
            {state.lastActionText}
          </div>
        )}

        {(state.phase === 'showdown' || state.phase === 'finished') && state.winners.length > 0 && (
          <div className="ag-poker-winner-banner" role="status" aria-live="polite">
            <span className="ag-poker-winner-icon" aria-hidden="true">
              {tableChampion ? <Crown size={15} /> : <Trophy size={15} />}
            </span>
            <div className="ag-poker-winner-list">
              {state.winners.map((w, idx) => (
                <div key={`${w.pubkey}-${w.potIndex}-${idx}`} className="ag-poker-winner-line">
                  <strong>{w.displayName}</strong> won{' '}
                  <span className="mono">{w.amountWon.toLocaleString()}</span>
                  {w.handLabel ? ` — ${w.handLabel}` : ''}
                  {hasMultiplePots && (
                    <span className="ag-poker-pot-tag mono">
                      {w.potIndex === 0 ? 'Main Pot' : `Side Pot #${w.potIndex}`}
                    </span>
                  )}
                </div>
              ))}
              {tableChampion && (
                <div className="ag-poker-champion-line">
                  Table Champion: <strong>{tableChampion.displayName}</strong> (
                  <span className="mono">{tableChampion.chips.toLocaleString()}</span> chips)
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Seated Players Grid (2–8 Seats) */}
      <div
        className="ag-poker-seats"
        data-seat-count={state.seats.length}
        aria-label="Seated players"
      >
        {state.seats.map((seat) => {
          const pk = seat.pubkey.toLowerCase()
          const isMe = pk === myPk
          const isActing = isLiveHand && state.actingPubkey?.toLowerCase() === pk
          const isDealer = state.handNumber > 0 && seat.seatIndex === state.dealerSeatIndex
          const isSb = state.handNumber > 0 && seat.seatIndex === state.smallBlindSeatIndex
          const isBb = state.handNumber > 0 && seat.seatIndex === state.bigBlindSeatIndex
          const isWinner =
            (state.phase === 'showdown' || state.phase === 'finished') && winnerPubkeySet.has(pk)
          const isBusted = seat.chips === 0 && !isLiveHand

          const revealedPair = state.revealedHands[seat.pubkey] ?? state.revealedHands[pk] ?? null
          const visiblePair = revealedPair ?? (isMe && !seat.sittingOut ? myHoleCards : null)
          const showHiddenBacks =
            !visiblePair && isLiveHand && !seat.sittingOut && !seat.folded

          return (
            <div
              key={seat.pubkey}
              className={`ag-poker-seat${isActing ? ' is-acting' : ''}${isMe ? ' is-me' : ''}${
                seat.folded ? ' is-folded' : ''
              }${seat.sittingOut ? ' is-sitting-out' : ''}${seat.allIn ? ' is-all-in' : ''}${
                isWinner ? ' is-winner' : ''
              }${isBusted ? ' is-busted' : ''}`}
            >
              <div className="ag-poker-seat-head">
                <span className="ag-poker-seat-name truncate">
                  {seat.displayName}
                  {isMe && <span className="ag-poker-you-tag mono">YOU</span>}
                </span>
                <span className="ag-poker-seat-roles">
                  {isDealer && (
                    <span className="ag-poker-role-badge is-dealer mono" title="Dealer button">
                      D
                    </span>
                  )}
                  {isSb && (
                    <span className="ag-poker-role-badge is-sb mono" title="Small blind">
                      SB
                    </span>
                  )}
                  {isBb && (
                    <span className="ag-poker-role-badge is-bb mono" title="Big blind">
                      BB
                    </span>
                  )}
                </span>
              </div>

              <div className="ag-poker-seat-body">
                <div className="ag-poker-seat-stack-col">
                  <span className="ag-poker-seat-chips mono">
                    {seat.chips.toLocaleString()}
                  </span>
                  <div className="ag-poker-seat-tags">
                    {seat.betThisStreet > 0 && (
                      <span className="ag-poker-seat-bet mono">
                        Bet {seat.betThisStreet.toLocaleString()}
                      </span>
                    )}
                    {seat.lastActionLabel && (
                      <span className="ag-poker-seat-action mono">{seat.lastActionLabel}</span>
                    )}
                    {seat.sittingOut && !seat.lastActionLabel && (
                      <span className="ag-poker-seat-action mono">
                        {isBusted ? 'Busted' : 'Next Hand'}
                      </span>
                    )}
                  </div>
                </div>

                {(visiblePair || showHiddenBacks) && (
                  <div className="ag-poker-seat-cards">
                    {visiblePair ? (
                      <>
                        <PlayingCard
                          card={visiblePair[0]}
                          size="sm"
                          dimmed={seat.folded}
                          highlighted={isMe && highlightedCardKeys.has(cardKey(visiblePair[0]))}
                        />
                        <PlayingCard
                          card={visiblePair[1]}
                          size="sm"
                          dimmed={seat.folded}
                          highlighted={isMe && highlightedCardKeys.has(cardKey(visiblePair[1]))}
                        />
                      </>
                    ) : (
                      <>
                        <PlayingCard card={null} faceDown size="sm" />
                        <PlayingCard card={null} faceDown size="sm" />
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Bottom Dock: Your Hand + Live Betting Action Controls + Table Lifecycle */}
      <div className="ag-poker-footer">
        {mySeat && (
          <div className="ag-poker-my-hand">
            <div className="ag-poker-my-cards">
              {myHoleCards && !mySeat.sittingOut ? (
                <>
                  <PlayingCard
                    card={myHoleCards[0]}
                    size="lg"
                    dimmed={mySeat.folded}
                    highlighted={highlightedCardKeys.has(cardKey(myHoleCards[0]))}
                  />
                  <PlayingCard
                    card={myHoleCards[1]}
                    size="lg"
                    dimmed={mySeat.folded}
                    highlighted={highlightedCardKeys.has(cardKey(myHoleCards[1]))}
                  />
                </>
              ) : (
                <>
                  <PlayingCard card={null} size="lg" />
                  <PlayingCard card={null} size="lg" />
                </>
              )}
            </div>

            <div className="ag-poker-my-info">
              <div className="ag-poker-my-stack-row">
                <span className="ag-poker-my-stack-label">Your Stack</span>
                <span className="ag-poker-my-stack-val mono">
                  {mySeat.chips.toLocaleString()}
                </span>
              </div>
              {myHandEval && !mySeat.folded ? (
                <div className="ag-poker-hand-hint">
                  <Sparkles size={12} aria-hidden="true" />
                  <span className="truncate">{myHandEval.label}</span>
                </div>
              ) : mySeat.folded ? (
                <div className="ag-poker-hand-status">Folded this hand</div>
              ) : mySeat.allIn ? (
                <div className="ag-poker-hand-status is-accent">All-In — awaiting showdown</div>
              ) : mySeat.sittingOut ? (
                <div className="ag-poker-hand-status">
                  {mySeat.chips === 0 ? 'Out of chips (fixed buy-in)' : 'Joining on next hand'}
                </div>
              ) : isMyTurn ? (
                <div className="ag-poker-hand-status is-accent">Your turn to act</div>
              ) : isLiveHand ? (
                <div className="ag-poker-hand-status">Waiting for action…</div>
              ) : null}
            </div>
          </div>
        )}

        {/* Active Betting Action Dock (only on your turn) */}
        {isMyTurn && legal.canFold && (
          <div className="ag-poker-actions-dock" role="group" aria-label="Poker betting actions">
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
                    ½ Pot
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
                  {mySeat && legal.callAmount >= mySeat.chips
                    ? `Call All-In (${legal.callAmount.toLocaleString()})`
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
                      ? `Raise to ${clampedWager.toLocaleString()}`
                      : `Bet ${clampedWager.toLocaleString()}`}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Table Seating & Deal Lifecycle Bar */}
        <div className="ag-poker-table-bar">
          <div className="ag-poker-table-bar-left">
            {canJoinOpenSeat && (
              <button
                type="button"
                className="ag-poker-btn is-primary"
                onClick={onJoinSeat}
              >
                <UserPlus size={14} aria-hidden="true" />
                <span>Sit In ({state.fixedBuyIn.toLocaleString()} chips)</span>
              </button>
            )}

            {!mySeat && state.seats.length >= state.maxSeats && (
              <span className="ag-poker-table-note">
                Table full ({state.seats.length}/{state.maxSeats}) · Watching
              </span>
            )}

            {mySeat && canDealNext && (
              <button
                type="button"
                className="ag-poker-btn is-primary"
                onClick={onStartHand}
              >
                <Play size={14} aria-hidden="true" />
                <span>{state.handNumber === 0 ? 'Deal Hand' : 'Deal Next Hand'}</span>
              </button>
            )}

            {mySeat && (state.phase === 'lobby' || state.phase === 'showdown') && !canDealNext && (
              <span className="ag-poker-table-note">
                {!canStartPokerHand(state)
                  ? 'Waiting for another player to join…'
                  : 'Waiting for host to deal next hand…'}
              </span>
            )}
          </div>

          <div className="ag-poker-table-bar-right">
            {mySeat && (
              <button
                type="button"
                className="ag-poker-btn is-subtle"
                onClick={onLeaveSeat}
                title="Leave your seat at this table"
              >
                <LogOut size={13} aria-hidden="true" />
                <span>Leave Seat</span>
              </button>
            )}

            {isHost && onEndTable && (
              confirmEndTable ? (
                <div className="ag-poker-confirm-group">
                  <button
                    type="button"
                    className="ag-poker-btn is-danger"
                    onClick={() => {
                      setConfirmEndTable(false)
                      onEndTable()
                    }}
                  >
                    Confirm End
                  </button>
                  <button
                    type="button"
                    className="ag-poker-btn is-subtle"
                    onClick={() => setConfirmEndTable(false)}
                    aria-label="Cancel end table"
                    title="Cancel"
                  >
                    <X size={13} />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="ag-poker-btn is-subtle"
                  onClick={() => setConfirmEndTable(true)}
                >
                  End Table
                </button>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default PokerTableView
