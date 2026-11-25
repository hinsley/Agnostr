import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgnostrEngine } from '../types/protocol.ts'
import {
  appendRoomRosterJoins,
  captureRoomRoster,
  roomRosterKey,
  startRoomRosterSampling,
  type RoomRoster,
} from '../lib/roomRoster.ts'

type RoomRosterFrame = { key: string; roster: RoomRoster }

/** Both room-list surfaces read the same sampled presentation state. */
export function useRoomRoster(engine: AgnostrEngine, enabled: boolean): RoomRoster | null {
  const key = enabled ? roomRosterKey(engine) : null
  const latest = useRef(engine)
  const lastPublished = useRef<RoomRosterFrame | null>(null)
  const [snapshot, setSnapshot] = useState<RoomRosterFrame | null>(null)
  // These committed sources change when the app detects a peer or member.
  const channelPeers = engine.activeView.type === 'channel' ? engine.peers : null
  const groupMembers = engine.activeView.type === 'server' ? engine.servers.members : null

  useLayoutEffect(() => {
    latest.current = engine
  }, [engine])

  useLayoutEffect(() => {
    const current = lastPublished.current
    if (key === null || current?.key !== key) return
    const roster = appendRoomRosterJoins(current.roster, latest.current)
    if (roster === current.roster) return
    const next = { key, roster }
    lastPublished.current = next
    setSnapshot(next)
  }, [key, channelPeers, groupMembers])

  useEffect(() => {
    if (key === null) return
    return startRoomRosterSampling(
      () => {
        if (roomRosterKey(latest.current) !== key) return
        const roster = captureRoomRoster(latest.current)
        if (!roster) return
        const next = { key, roster }
        lastPublished.current = next
        setSnapshot(next)
      },
      { schedule: (callback, delay) => window.setTimeout(callback, delay),
        cancel: (timer) => window.clearTimeout(timer) },
    )
  }, [key])

  // A room/profile switch must not show the previous room's roster.
  return key !== null && snapshot?.key === key ? snapshot.roster : null
}
