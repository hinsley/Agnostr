// Local UI fixture: real stages, boards, and media elements; no relays, peers, camera, or wallet.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ActivityStages } from '../../src/components/ActivityStages'
import { ContextMenuProvider } from '../../src/components/ContextMenu'
import { createPokerTable } from '../../src/lib/games/pokerEngine'
import { makeGameScopeKey } from '../../src/types/games'
import '../../src/styles/tokens.css'
import '../../src/styles/base.css'
import '../../src/styles/layout.css'
import '../../src/styles/components.css'
import '../../src/styles/calls.css'
import '../../src/styles/games.css'

const pk = '01'.repeat(32), peer = '02'.repeat(32)
const query = new URLSearchParams(location.search)
const kind = query.get('kind') ?? 'chess'
const scope = kind === 'poker' ? (query.get('room') || 'geo') : 'dm'
const targetId = scope === 'dm' ? peer : 'test'
const scopeKey = makeGameScopeKey(scope, targetId)
const board = { kind, scope, scopeKey, targetId, gameId: 'synthetic-game', status: 'active',
  localPubkey: pk, title: 'Fixture', localColor: kind === 'go' ? 'b' : 'w',
  opponentDisplayName: 'Bob', opponentPubkey: peer, stateJson: '', updatedAtMs: 2,
  goConfig: { boardSize: 9, handicap: 0, komi: 6.5, scoring: 'japanese' },
  publicStateJson: JSON.stringify(createPokerTable({ tableId: 'chips-only', hostPubkey: peer,
    hostDisplayName: 'Bob', fixedBuyIn: 100 })), tableId: 'chips-only' }
const other = { ...board, kind: 'chess', scope: 'dm', scopeKey: 'dm:other', targetId: 'other',
  opponentDisplayName: 'Other', opponentPubkey: 'other', updatedAtMs: 0, gameId: 'other-game' }
const canvas = document.createElement('canvas')
canvas.getContext('2d').fillRect(0, 0, 100, 80)
const stream = canvas.captureStream(1)
const audio = new AudioContext()
stream.addTrack(audio.createMediaStreamDestination().stream.getAudioTracks()[0])
const noop = () => undefined
const peerTile = { pubkey: peer, nickname: 'Bob', displayHandle: '@bob', stream, videoEnabled: true,
  screenSharing: false, isSelf: false, iceState: 'connected', audioLevel: 0, rttMs: null }
const call = { callId: 'synthetic-call', mode: scope, peerPubkey: peer, geohash: '#TEST', serverId: 'test', status: 'active',
  mediaType: 'video', title: 'Test call', participants: [peerTile], maxParticipants: 6,
  startedAt: Date.now(), connectedAt: Date.now() }
function Fixture() {
  const [minimized, setMinimized] = useState(true)
  const [focusedScopeKey, setFocusedScopeKey] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const [activeCall, setActiveCall] = useState(call)
  const [chatMounted, setChatMounted] = useState(true)
  const [chatDock, setChatDock] = useState(null)
  const [callDock, setCallDock] = useState(null)
  const [lastMove, setLastMove] = useState('')
  const games = { activeGamesByScope: { [scopeKey]: board, [other.scopeKey]: other },
    minimized, focusedScopeKey, setMinimized, setFocusedScopeKey,
    makeChessMove: (...args) => setLastMove(prev => prev + JSON.stringify(args)),
    makeGoMove: (...args) => setLastMove(prev => prev + JSON.stringify(args)),
    joinPokerTable: (...args) => setLastMove(prev => prev + JSON.stringify(args)) }
  const engine = { calls: { activeCall, audioOutputDevices: [], audioInputDevices: [],
      recordingQuality: 'balanced', leaveCall: () => setActiveCall(null) }, games,
    identity: { masterPubkey: pk, nickname: 'Alice' }, servers: { joinedServers: [] },
    transcription: { liveCaptions: [], activeModel: { label: 'Test model' } },
    ensureProfilePictures: noop, getProfilePicture: noop, isTrusted: () => true,
    contentFilter: { shouldAllowScreenedCallVideo: () => false, shouldScreenCallVideo: () => false } }
  return <ContextMenuProvider>
    <output id="sent">{lastMove}</output>
    <button id="stop-test-call" onClick={() => {setActiveCall(null); setExpanded(false)}}>End fixture call</button>
    <button id="toggle-test-chat" onClick={() => setChatMounted(v => !v)}>Toggle fixture chat</button>
    {chatMounted && <main className="ag-main" style={{height: '80dvh'}}>
      <div className="ag-call-dock-slot" ref={setCallDock} />
      <div ref={setChatDock} className="ag-game-chat-slot" />
      <div className="ag-stream-wrap"><div className="ag-stream-scroll">A message to read</div></div>
      <div className="ag-composer-dock"><textarea id="fixture-composer" aria-label="Message" /></div>
    </main>}
    <ActivityStages engine={engine} expanded={expanded} onSetExpanded={setExpanded}
      gameChatDock={chatDock} onRequestGameChat={() => setChatMounted(true)}
      compactFloating={scope === 'dm' || !chatMounted} dockContainer={callDock} floatingContext={scope === 'geo' ? 'globe' : 'chat'} />
  </ContextMenuProvider>
}
createRoot(document.querySelector('#root')).render(<Fixture />)
