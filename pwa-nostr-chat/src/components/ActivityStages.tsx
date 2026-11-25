import { lazy, Suspense, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CallStageProps } from './CallStage'
import { makeGameScopeKey } from '../types/games'
import type { ActiveCallSession } from '../types/calls'

const CallStage = lazy(() => import('./CallStage'))
const GameFeedPreview = lazy(() => import('./games/GameFeedPreview'))
const GameStage = lazy(() => import('./games/GameStage'))

function gameKeyForCall(call: ActiveCallSession | null) {
  if (!call) return null
  const target = call.mode === 'dm' ? call.peerPubkey
    : call.mode === 'geo' ? call.geohash : call.serverId
  return target?.trim() ? makeGameScopeKey(call.mode, target) : null
}

type Props = Omit<CallStageProps, 'calls' | 'onToggleExpand' | 'gameFeed' | 'floatingDock'> & {
  onSetExpanded: (expanded: boolean) => void
}

/** One local activity dock; a board belongs to a call only if its scope matches.
 * The board is DOM, not a WebRTC track (private poker cards never leave the client here). */
export function ActivityStages({ engine, expanded, onSetExpanded, ...props }: Props) {
  const { calls, games } = engine
  const [floatingDock, setFloatingDock] = useState<HTMLDivElement | null>(null)
  const [savedPin, setSavedPin] = useState<{ callId: string; gameId: string } | null>(null)
  const scopeKey = gameKeyForCall(calls.activeCall)
  const session = scopeKey ? games.activeGamesByScope[scopeKey] : null
  // Just like a pinned camera, a minimized board regains the spotlight on restore.
  const restorePin = Boolean(session && savedPin && calls.activeCall?.callId === savedPin.callId &&
    session.gameId === savedPin.gameId)
  const gamePinned = Boolean(session && ((games.focusedScopeKey === scopeKey && !games.minimized) ||
    (expanded && games.minimized && restorePin)))
  const stageExpanded = expanded || gamePinned
  const unpinGame = () => {
    setSavedPin(null)
    onSetExpanded(true)
    games.setMinimized(true)
  }
  const gameFeed = session ? {
    label: session.kind === 'poker' ? 'Poker' : session.kind === 'go' ? 'Go' : 'Chess',
    pinned: gamePinned,
    preview: <Suspense fallback={null}><GameFeedPreview session={session} /></Suspense>,
    pin: () => {
      games.setFocusedScopeKey(session.scopeKey)
      games.setMinimized(false)
    },
    unpin: unpinGame,
    board: gamePinned ? (
      <Suspense fallback={<span role="status">Loading board…</span>}>
        <GameStage key={session.gameId} embeddedSession={session} engine={engine} games={games}
          onPlaySound={props.onPlaySound} onUnpin={unpinGame} />
      </Suspense>
    ) : null,
  } : undefined

  return <>
    {createPortal(<div className="ag-activity-dock" data-floating-context={props.floatingContext}
      ref={setFloatingDock} />, document.body)}
    {(calls.activeCall || engine.transcription.endedCallTranscript) && (
      <Suspense fallback={null}>
        <CallStage {...props} engine={engine} calls={calls} floatingDock={floatingDock}
          gameFeed={gameFeed} expanded={stageExpanded}
          onReturnToCall={() => {
            if (games.focusedScopeKey && !games.minimized) games.setMinimized(true)
            props.onReturnToCall?.()
            if (restorePin || !props.onReturnToCall) onSetExpanded(true)
          }}
          onToggleExpand={() => {
            if (gamePinned && session && calls.activeCall) {
              setSavedPin({ callId: calls.activeCall.callId, gameId: session.gameId })
            }
            if (games.focusedScopeKey && !games.minimized) games.setMinimized(true)
            onSetExpanded(!stageExpanded)
          }} />
      </Suspense>
    )}
    {!gamePinned && Object.keys(games.activeGamesByScope).length > 0 && (
      <Suspense fallback={null}>
        <GameStage engine={engine} games={games} onPlaySound={props.onPlaySound}
          floatingDock={expanded ? null : floatingDock} />
      </Suspense>
    )}
  </>
}
