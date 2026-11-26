import { formatCompactLastActive } from '../utils/relativeTime.ts'

export function PeerPresence({ isOnline = false, isMuted = false, lastSeenAt, sampledAt, compact = false }: {
  isOnline?: boolean
  isMuted?: boolean
  lastSeenAt?: number
  sampledAt?: number
  compact?: boolean
}) {
  const state = isMuted ? 'muted' : isOnline ? 'online' : 'offline'
  const activity = formatCompactLastActive(lastSeenAt, sampledAt)
  const title = state === 'offline' && lastSeenAt && lastSeenAt > 0 && Number.isFinite(lastSeenAt)
    ? `Last active ${new Date(lastSeenAt * 1000).toLocaleString()}`
    : undefined
  return (
    <span className={`ag-peer-presence ${state} truncate`} title={title}>
      {isMuted ? 'Muted' : isOnline ? 'Online' : compact || !title ? activity : `Last active ${activity}`}
    </span>
  )
}
