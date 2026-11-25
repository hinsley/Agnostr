import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgnostrEngine } from '../types/protocol.ts'
import {
  captureRoomRoster,
  roomRosterKey,
  startRoomRosterSampling,
  type RoomRoster,
} from '../lib/roomRoster.ts'

/** Both room-list surfaces read the same sampled presentation state. */
export function useRoomRoster(engine: AgnostrEngine, enabled: boolean): RoomRoster | null {
  const key = enabled ? roomRosterKey(engine) : null
  const latest = useRef(engine)
  const [snapshot, setSnapshot] = useState<{ key: string; roster: RoomRoster | null } | null>(null)

  useLayoutEffect(() => {
    latest.current = engine
  }, [engine])

  useEffect(() => {
    if (key === null) return
    return startRoomRosterSampling(
      () => setSnapshot({ key, roster: captureRoomRoster(latest.current) }),
      { schedule: (callback, delay) => window.setTimeout(callback, delay),
        cancel: (timer) => window.clearTimeout(timer) },
    )
  }, [key])

  // A room/profile switch must not show the previous room's roster.
  return key !== null && snapshot?.key === key ? snapshot.roster : null
}
