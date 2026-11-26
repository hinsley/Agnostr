import { lazy, Suspense, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CallStageProps } from './CallStage'
import { makeGameScopeKey, type ActiveGameSession } from '../types/games'
import type { ActiveCallSession } from '../types/calls'

const CallStage = lazy(() => import('./CallStage'))
const GameStage = lazy(() => import('./games/GameStage'))

function gameKeyForCall(call: ActiveCallSession | null) {
  if (!call) return null
  const target = call.mode === 'dm' ? call.peerPubkey
    : call.mode === 'geo' ? call.geohash : call.serverId
  return target?.trim() ? makeGameScopeKey(call.mode, target) : null
}

type Props = Omit<CallStageProps, 'calls' | 'onToggleExpand' | 'gameFeed' | 'floatingDock' | 'gameVideoDock'> & {
  onSetExpanded: (expanded: boolean) => void
  gameChatDock: HTMLElement | null
  allowFloatingGame?: boolean
  onRequestGameChat: (session: ActiveGameSession) => void
}

/** The compact stage is local UI. Boards never become WebRTC tracks. */
export function ActivityStages({
  engine, expanded, onSetExpanded, gameChatDock, allowFloatingGame = true, onRequestGameChat, ...props
}: Props) {
  const { calls, games } = engine
  const [floatingDock, setFloatingDock] = useState<HTMLDivElement | null>(null)
  const [videoDock, setVideoDock] = useState<HTMLDivElement | null>(null)
  const [callControlsDock, setCallControlsDock] = useState<HTMLDivElement | null>(null)
  const scopeKey = gameKeyForCall(calls.activeCall)
  const session = scopeKey ? games.activeGamesByScope[scopeKey] : null
  const compactWithVideo = Boolean(!expanded && session && session.scopeKey === games.focusedScopeKey &&
    (games.minimized || !gameChatDock) && (gameChatDock || allowFloatingGame))
  const openGameInChat = (game: ActiveGameSession) => {
    onSetExpanded(false)
    if (!gameChatDock) onRequestGameChat(game)
    games.setFocusedScopeKey(game.scopeKey)
    games.setMinimized(false)
  }
  const gameFeed = session ? {
    label: session.kind === 'poker' ? 'Poker' : session.kind === 'go' ? 'Go' : 'Chess',
    pin: () => {
      games.setFocusedScopeKey(session.scopeKey)
      games.setMinimized(true)
      onSetExpanded(false)
    },
  } : undefined

  return <>
    {createPortal(<div className="ag-activity-dock" data-floating-context={props.floatingContext}
      ref={setFloatingDock} />, document.body)}
    {(calls.activeCall || engine.transcription.endedCallTranscript) && (
      <Suspense fallback={null}>
        <CallStage {...props} engine={engine} calls={calls}
          floatingDock={compactWithVideo ? callControlsDock ?? floatingDock : floatingDock}
          gameFeed={gameFeed} gameVideoDock={compactWithVideo ? videoDock : null} expanded={expanded}
          onReturnToCall={props.onReturnToCall ?? (() => onSetExpanded(true))}
          onCompactCall={() => {
            if (session && session.scopeKey === games.focusedScopeKey) games.setMinimized(true)
          }}
          onToggleExpand={() => onSetExpanded(!expanded)} />
      </Suspense>
    )}
    {Object.keys(games.activeGamesByScope).length > 0 && (
      <Suspense fallback={null}>
        <GameStage engine={engine} games={games} onPlaySound={props.onPlaySound}
          floatingDock={expanded || !allowFloatingGame ? null : floatingDock} chatDock={expanded ? null : gameChatDock}
          compactCallDocks={compactWithVideo ? { video: setVideoDock, controls: setCallControlsDock } : undefined}
          onOpenInChat={openGameInChat} />
      </Suspense>
    )}
  </>
}
