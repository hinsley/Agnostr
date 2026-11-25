import { memo, useEffect, useRef } from 'react'
import type { ActiveGameSession } from '../../types/games'
import { formatCardShort } from '../../lib/games/pokerEngine'
import { parseChessSessionState, parseGoSessionState, parsePokerSessionState } from './gameStageState'

const glyphs = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' }

/** A small local still image of the current position; no captureStream, camera, or render loop. */
export default memo(function GameFeedPreview({ session }: { session: ActiveGameSession }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const position = session.kind === 'poker' ? session.publicStateJson : session.stateJson
  const lastDraw = useRef<{ id: string; position: string } | null>(null)
  useEffect(() => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx || (lastDraw.current?.id === session.gameId && lastDraw.current.position === position)) return
    lastDraw.current = { id: session.gameId, position }
    ctx.clearRect(0, 0, 160, 160)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    if (session.kind === 'chess') {
      const { board } = parseChessSessionState(session)
      ctx.font = '18px serif'
      for (let i = 0; i < 64; i++) {
        const x = i % 8, y = Math.floor(i / 8)
        ctx.fillStyle = (x + y) % 2 ? '#8ca07b' : '#e1ddc3'
        ctx.fillRect(x * 20, y * 20, 20, 20)
        const p = board[session.localColor === 'b' ? 63 - i : i]
        if (!p || !(p.type in glyphs)) continue
        ctx.fillStyle = p.color === 'w' ? '#fffaf2' : '#182021'
        ctx.strokeStyle = '#26332b'
        ctx.lineWidth = 1
        ctx.strokeText(glyphs[p.type], x * 20 + 10, y * 20 + 11)
        ctx.fillText(glyphs[p.type], x * 20 + 10, y * 20 + 11)
      }
    } else if (session.kind === 'go') {
      const { board, config } = parseGoSessionState(session)
      const n = config.boardSize, step = 144 / (n - 1)
      if (![9, 13, 19].includes(n)) return
      ctx.fillStyle = '#d9b071'; ctx.fillRect(0, 0, 160, 160)
      ctx.strokeStyle = '#70583c'; ctx.beginPath()
      for (let i = 0; i < n; i++) {
        ctx.moveTo(8 + i * step, 8); ctx.lineTo(8 + i * step, 152)
        ctx.moveTo(8, 8 + i * step); ctx.lineTo(152, 8 + i * step)
      }
      ctx.stroke()
      for (let i = 0; i < n * n; i++) {
        if (!board[i]) continue
        ctx.fillStyle = board[i] === 'b' ? '#161717' : '#faf7eb'
        ctx.beginPath(); ctx.arc(8 + i % n * step, 8 + Math.floor(i / n) * step, step * .46, 0, Math.PI * 2); ctx.fill()
      }
    } else {
      const state = parsePokerSessionState(session)
      ctx.fillStyle = '#104c40'; ctx.fillRect(0, 0, 160, 160)
      ctx.font = 'bold 14px sans-serif'
      for (let i = 0; i < 5; i++) {
        const c = state?.communityCards?.[i] // Public cards only.
        ctx.fillStyle = c ? '#fff7e8' : '#206754'; ctx.fillRect(7 + i * 30, 57, 25, 36)
        if (!c) continue
        ctx.fillStyle = c.suit === 'h' || c.suit === 'd' ? '#af363a' : '#1c2628'
        ctx.fillText(formatCardShort(c), 19 + i * 30, 75, 23)
      }
      ctx.fillStyle = '#eaf4ef'; ctx.font = '12px sans-serif'
      ctx.fillText(`Pot: ${state?.pot ?? 0}`, 80, 108)
    }
  }, [session, position])
  return <canvas ref={ref} width={160} height={160} className="ag-game-feed-preview" aria-hidden="true" />
})
