import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Circle,
  Crown,
  Minus,
  Play,
  Plus,
  Shuffle,
  Spade,
  X,
} from 'lucide-react'
import {
  getAllowedGamesForScope,
  type ChessPieceColor,
  type ChessSetupOptions,
  type DmGameKind,
  type GameScope,
  type GoBoardDimension,
  type GoScoringMode,
  type GoSetupOptions,
  type GoStoneColor,
  type PokerSetupOptions,
} from '../../types/games.ts'
import { getMaxHandicap } from '../../lib/games/goEngine.ts'
import { getRecommendedBlinds } from '../../lib/games/pokerEngine.ts'

export interface GameSetupModalProps {
  open: boolean
  scope: GameScope
  targetLabel: string
  hasActiveGameInScope: boolean
  onClose: () => void
  onStartChess: (opts: ChessSetupOptions) => void
  onStartGo: (opts: GoSetupOptions) => void
  onStartPoker: (opts: PokerSetupOptions) => void
  onResumeExisting?: () => void
}

const GO_BOARD_SIZES: readonly { size: GoBoardDimension; title: string; sub: string }[] = [
  { size: 9, title: '9×9', sub: 'Quick' },
  { size: 13, title: '13×13', sub: 'Medium' },
  { size: 19, title: '19×19', sub: 'Full' },
]

const GO_KOMI_PRESETS = [0.5, 5.5, 6.5, 7.5] as const

const POKER_BUY_IN_PRESETS = [500, 1000, 2500, 5000] as const

const POKER_SEAT_OPTIONS = [2, 3, 4, 5, 6, 7, 8] as const

function defaultKomiFor(scoring: GoScoringMode, handicap: number): number {
  if (handicap >= 2) return 0.5
  return scoring === 'chinese' ? 7.5 : 6.5
}

function clampKomi(raw: string, fallback: number): number {
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed)) return fallback
  const clamped = Math.max(-50, Math.min(50, parsed))
  return Math.round(clamped * 10) / 10
}

export function GameSetupModal({
  open,
  scope,
  targetLabel,
  hasActiveGameInScope,
  onClose,
  onStartChess,
  onStartGo,
  onStartPoker,
  onResumeExisting,
}: GameSetupModalProps) {
  const titleId = useId()
  const komiInputId = useId()

  const allowedGames = getAllowedGamesForScope(scope)
  const isDmScope = scope === 'dm' && allowedGames.includes('go') && allowedGames.includes('chess')

  // DM tab state (Go | Chess)
  const [dmTab, setDmTab] = useState<DmGameKind>('go')

  // Go configuration
  const [boardSize, setBoardSize] = useState<GoBoardDimension>(19)
  const [scoring, setScoring] = useState<GoScoringMode>('japanese')
  const [handicap, setHandicap] = useState<number>(0)
  const [komiInput, setKomiInput] = useState<string>('6.5')
  const [komiCustom, setKomiCustom] = useState<boolean>(false)
  const [goColorPref, setGoColorPref] = useState<GoStoneColor | 'random'>('random')

  // Chess configuration
  const [chessColorPref, setChessColorPref] = useState<ChessPieceColor | 'random'>('random')

  // Poker configuration (Bitchat / Groups)
  const [fixedBuyIn, setFixedBuyIn] = useState<number>(1000)
  const [maxSeats, setMaxSeats] = useState<number>(6)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  const maxHandicap = getMaxHandicap(boardSize)
  const safeHandicap = Math.min(handicap, maxHandicap)
  const fallbackKomi = defaultKomiFor(scoring, safeHandicap)
  const numericKomi = clampKomi(komiInput, fallbackKomi)
  const selectedBlinds = getRecommendedBlinds(fixedBuyIn)

  const handleSelectBoardSize = (nextSize: GoBoardDimension) => {
    setBoardSize(nextSize)
    const nextMax = getMaxHandicap(nextSize)
    const clampedH = Math.min(handicap, nextMax)
    if (clampedH !== handicap) {
      setHandicap(clampedH)
      if (!komiCustom) {
        setKomiInput(String(defaultKomiFor(scoring, clampedH)))
      }
    }
  }

  const handleSelectScoring = (nextScoring: GoScoringMode) => {
    setScoring(nextScoring)
    if (!komiCustom) {
      setKomiInput(String(defaultKomiFor(nextScoring, safeHandicap)))
    }
  }

  const handleStepHandicap = (dir: -1 | 1) => {
    let next: number
    if (dir === 1) {
      next = safeHandicap === 0 ? 2 : Math.min(maxHandicap, safeHandicap + 1)
    } else {
      next = safeHandicap <= 2 ? 0 : safeHandicap - 1
    }
    setHandicap(next)
    if (!komiCustom) {
      setKomiInput(String(defaultKomiFor(scoring, next)))
    }
  }

  const handleSelectKomiPreset = (val: number) => {
    setKomiInput(String(val))
    setKomiCustom(true)
  }

  const handleSubmitGo = () => {
    onStartGo({
      boardSize,
      scoring,
      komi: numericKomi,
      handicap: safeHandicap,
      colorPref: goColorPref,
    })
    onClose()
  }

  const handleSubmitChess = () => {
    onStartChess({ colorPref: chessColorPref })
    onClose()
  }

  const handleSubmitPoker = () => {
    onStartPoker({
      fixedBuyIn,
      maxSeats,
    })
    onClose()
  }

  const handleResume = () => {
    onResumeExisting?.()
    onClose()
  }

  return createPortal(
    <div
      className="ag-game-setup-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section
        className="ag-game-setup-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="ag-game-setup-head">
          <div className="ag-game-setup-head-copy">
            <h2 id={titleId} className="ag-game-setup-title">
              {isDmScope ? 'Play' : "Texas Hold'em"}
            </h2>
            <span className="ag-game-setup-target mono truncate">{targetLabel}</span>
          </div>

          <button
            type="button"
            className="ag-game-setup-close"
            onClick={onClose}
            aria-label="Close game setup"
            title="Close"
          >
            <X size={16} />
          </button>
        </header>

        {/* Body */}
        <div className="ag-game-setup-body">
          {hasActiveGameInScope ? (
            <div className="ag-game-setup-active-notice" role="status">
              <p className="ag-game-setup-active-copy">A game is already active here.</p>
              <div className="ag-game-setup-active-actions">
                <button
                  type="button"
                  className="ag-game-setup-cta"
                  onClick={handleResume}
                >
                  <Play size={15} aria-hidden="true" />
                  <span>Open Game</span>
                </button>
                <button
                  type="button"
                  className="ag-game-setup-cancel"
                  onClick={onClose}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : isDmScope ? (
            <>
              {/* DM 2-Tab Segmented Switcher: Go | Chess */}
              <div className="ag-game-setup-tabs" role="tablist" aria-label="Choose a game">
                <button
                  type="button"
                  role="tab"
                  aria-selected={dmTab === 'go'}
                  className={`ag-game-setup-tab${dmTab === 'go' ? ' is-active' : ''}`}
                  onClick={() => setDmTab('go')}
                >
                  <Circle size={15} aria-hidden="true" />
                  <span>Go</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={dmTab === 'chess'}
                  className={`ag-game-setup-tab${dmTab === 'chess' ? ' is-active' : ''}`}
                  onClick={() => setDmTab('chess')}
                >
                  <Crown size={15} aria-hidden="true" />
                  <span>Chess</span>
                </button>
              </div>

              {dmTab === 'go' ? (
                <div className="ag-game-setup-panel" role="tabpanel" aria-label="Go setup">
                  {/* Board Size */}
                  <div className="ag-game-setup-field">
                    <span className="ag-game-setup-label">Board Size</span>
                    <div className="ag-game-setup-seg cols-3">
                      {GO_BOARD_SIZES.map((opt) => (
                        <button
                          key={opt.size}
                          type="button"
                          className={`ag-game-setup-seg-btn${
                            boardSize === opt.size ? ' is-active' : ''
                          }`}
                          aria-pressed={boardSize === opt.size}
                          onClick={() => handleSelectBoardSize(opt.size)}
                        >
                          <span className="ag-game-setup-seg-title mono">{opt.title}</span>
                          <span className="ag-game-setup-seg-sub">{opt.sub}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Scoring */}
                  <div className="ag-game-setup-field">
                    <span className="ag-game-setup-label">Scoring</span>
                    <div className="ag-game-setup-seg cols-2">
                      <button
                        type="button"
                        className={`ag-game-setup-seg-btn${
                          scoring === 'japanese' ? ' is-active' : ''
                        }`}
                        aria-pressed={scoring === 'japanese'}
                        onClick={() => handleSelectScoring('japanese')}
                      >
                        <span className="ag-game-setup-seg-title">Japanese</span>
                        <span className="ag-game-setup-seg-sub">Territory</span>
                      </button>
                      <button
                        type="button"
                        className={`ag-game-setup-seg-btn${
                          scoring === 'chinese' ? ' is-active' : ''
                        }`}
                        aria-pressed={scoring === 'chinese'}
                        onClick={() => handleSelectScoring('chinese')}
                      >
                        <span className="ag-game-setup-seg-title">Chinese</span>
                        <span className="ag-game-setup-seg-sub">Area</span>
                      </button>
                    </div>
                  </div>

                  {/* Komi */}
                  <div className="ag-game-setup-field">
                    <label htmlFor={komiInputId} className="ag-game-setup-label">
                      Komi
                    </label>
                    <div className="ag-game-setup-komi-row">
                      <div className="ag-game-setup-pills">
                        {GO_KOMI_PRESETS.map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            className={`ag-game-setup-pill mono${
                              numericKomi === preset ? ' is-active' : ''
                            }`}
                            aria-pressed={numericKomi === preset}
                            onClick={() => handleSelectKomiPreset(preset)}
                          >
                            {preset}
                          </button>
                        ))}
                      </div>
                      <input
                        id={komiInputId}
                        type="number"
                        className="ag-game-setup-num-input mono tabular"
                        step="0.5"
                        min={-50}
                        max={50}
                        value={komiInput}
                        onChange={(e) => {
                          setKomiInput(e.target.value)
                          setKomiCustom(true)
                        }}
                        aria-label="Custom Komi value"
                      />
                    </div>
                  </div>

                  {/* Handicap */}
                  <div className="ag-game-setup-field">
                    <div className="ag-game-setup-label-row">
                      <span className="ag-game-setup-label">Handicap</span>
                      <span className="ag-game-setup-hint">
                        {safeHandicap >= 2 ? `H${safeHandicap} · White first` : 'Even'}
                      </span>
                    </div>
                    <div className="ag-game-setup-stepper">
                      <button
                        type="button"
                        className="ag-game-setup-step-btn"
                        disabled={safeHandicap <= 0}
                        onClick={() => handleStepHandicap(-1)}
                        aria-label="Decrease handicap stones"
                      >
                        <Minus size={14} />
                      </button>
                      <span className="ag-game-setup-step-val mono tabular">
                        {safeHandicap === 0 ? '0' : `${safeHandicap} stones`}
                      </span>
                      <button
                        type="button"
                        className="ag-game-setup-step-btn"
                        disabled={safeHandicap >= maxHandicap}
                        onClick={() => handleStepHandicap(1)}
                        aria-label="Increase handicap stones"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Color */}
                  <div className="ag-game-setup-field">
                    <span className="ag-game-setup-label">Color</span>
                    <div className="ag-game-setup-seg cols-3">
                      <button
                        type="button"
                        className={`ag-game-setup-seg-btn compact${
                          goColorPref === 'b' ? ' is-active' : ''
                        }`}
                        aria-pressed={goColorPref === 'b'}
                        onClick={() => setGoColorPref('b')}
                      >
                        <span className="ag-game-setup-stone is-black" aria-hidden="true" />
                        <span>Black</span>
                      </button>
                      <button
                        type="button"
                        className={`ag-game-setup-seg-btn compact${
                          goColorPref === 'random' ? ' is-active' : ''
                        }`}
                        aria-pressed={goColorPref === 'random'}
                        onClick={() => setGoColorPref('random')}
                      >
                        <Shuffle size={13} aria-hidden="true" />
                        <span>Random</span>
                      </button>
                      <button
                        type="button"
                        className={`ag-game-setup-seg-btn compact${
                          goColorPref === 'w' ? ' is-active' : ''
                        }`}
                        aria-pressed={goColorPref === 'w'}
                        onClick={() => setGoColorPref('w')}
                      >
                        <span className="ag-game-setup-stone is-white" aria-hidden="true" />
                        <span>White</span>
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="ag-game-setup-cta"
                    onClick={handleSubmitGo}
                  >
                    <Circle size={15} aria-hidden="true" />
                    <span>Challenge to Go</span>
                  </button>
                </div>
              ) : (
                <div className="ag-game-setup-panel" role="tabpanel" aria-label="Chess setup">
                  {/* Color */}
                  <div className="ag-game-setup-field">
                    <span className="ag-game-setup-label">Color</span>
                    <div className="ag-game-setup-seg cols-3">
                      <button
                        type="button"
                        className={`ag-game-setup-seg-btn compact${
                          chessColorPref === 'w' ? ' is-active' : ''
                        }`}
                        aria-pressed={chessColorPref === 'w'}
                        onClick={() => setChessColorPref('w')}
                      >
                        <span className="ag-game-setup-stone is-white" aria-hidden="true" />
                        <span>White</span>
                      </button>
                      <button
                        type="button"
                        className={`ag-game-setup-seg-btn compact${
                          chessColorPref === 'random' ? ' is-active' : ''
                        }`}
                        aria-pressed={chessColorPref === 'random'}
                        onClick={() => setChessColorPref('random')}
                      >
                        <Shuffle size={13} aria-hidden="true" />
                        <span>Random</span>
                      </button>
                      <button
                        type="button"
                        className={`ag-game-setup-seg-btn compact${
                          chessColorPref === 'b' ? ' is-active' : ''
                        }`}
                        aria-pressed={chessColorPref === 'b'}
                        onClick={() => setChessColorPref('b')}
                      >
                        <span className="ag-game-setup-stone is-black" aria-hidden="true" />
                        <span>Black</span>
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="ag-game-setup-cta"
                    onClick={handleSubmitChess}
                  >
                    <Crown size={15} aria-hidden="true" />
                    <span>Challenge to Chess</span>
                  </button>
                </div>
              )}
            </>
          ) : (
            /* Bitchat Channel or Group — Texas Hold'em */
            <div className="ag-game-setup-panel">
              {/* Buy-In */}
              <div className="ag-game-setup-field">
                <div className="ag-game-setup-label-row">
                  <span className="ag-game-setup-label">Buy-In</span>
                  <span className="ag-game-setup-hint mono tabular">
                    Blinds {selectedBlinds.smallBlind}/{selectedBlinds.bigBlind}
                  </span>
                </div>
                <div className="ag-game-setup-seg cols-2">
                  {POKER_BUY_IN_PRESETS.map((amount) => {
                    const blinds = getRecommendedBlinds(amount)
                    const active = fixedBuyIn === amount
                    return (
                      <button
                        key={amount}
                        type="button"
                        className={`ag-game-setup-seg-btn${active ? ' is-active' : ''}`}
                        aria-pressed={active}
                        onClick={() => setFixedBuyIn(amount)}
                      >
                        <span className="ag-game-setup-seg-title mono tabular">
                          {amount.toLocaleString()}
                        </span>
                        <span className="ag-game-setup-seg-sub mono tabular">
                          {blinds.smallBlind}/{blinds.bigBlind}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Max Seats */}
              <div className="ag-game-setup-field">
                <span className="ag-game-setup-label">Max Seats</span>
                <div className="ag-game-setup-seat-grid" role="group" aria-label="Maximum seats">
                  {POKER_SEAT_OPTIONS.map((seats) => (
                    <button
                      key={seats}
                      type="button"
                      className={`ag-game-setup-seat-pill mono tabular${
                        maxSeats === seats ? ' is-active' : ''
                      }`}
                      aria-pressed={maxSeats === seats}
                      onClick={() => setMaxSeats(seats)}
                    >
                      {seats}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                className="ag-game-setup-cta"
                onClick={handleSubmitPoker}
              >
                <Spade size={15} aria-hidden="true" />
                <span>Open Poker Table</span>
              </button>
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  )
}

export default GameSetupModal
