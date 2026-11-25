import { normalizeBitchatChannelKey } from './bitchatChannel.ts'
import type { PinnedChannel, PulseRoom } from '../types/protocol.ts'

export interface DrawerChannel {
  key: string
  pin?: PinnedChannel
  pulse?: PulseRoom
  selected: boolean
}

const drawerKey = (key: string) =>
  normalizeBitchatChannelKey(key.trim().replace(/^#+/, '').toLowerCase())

/** Use the same pin and relay pulse sources as the desktop channel switcher. */
export function selectBitchatDrawerChannels(
  pinnedChannels: readonly PinnedChannel[],
  pulseRooms: readonly PulseRoom[],
  activeChannel: string,
): { pinned: DrawerChannel[]; live: DrawerChannel[]; current: DrawerChannel | null } {
  const selectedKey = drawerKey(activeChannel)
  const pulseByKey = new Map<string, PulseRoom>()
  for (const pulse of pulseRooms) {
    const key = drawerKey(pulse.geohash)
    if (!key || (pulse.peerCount <= 0 && pulse.messageCount <= 0)) continue
    const existing = pulseByKey.get(key)
    if (!existing || pulse.lastActivityAt > existing.lastActivityAt) pulseByKey.set(key, pulse)
  }

  const pinnedKeys = new Set<string>()
  const pinned: DrawerChannel[] = []
  for (const pin of pinnedChannels) {
    const key = drawerKey(pin.geohash)
    if (!key || pinnedKeys.has(key)) continue
    pinnedKeys.add(key)
    pinned.push({ key, pin, pulse: pulseByKey.get(key), selected: key === selectedKey })
  }

  const live = [...pulseByKey.entries()]
    .filter(([key]) => !pinnedKeys.has(key))
    .map(([key, pulse]) => ({ key, pulse, selected: key === selectedKey }))
  const current = selectedKey && !pinnedKeys.has(selectedKey) && !pulseByKey.has(selectedKey)
    ? { key: selectedKey, selected: true }
    : null
  return { pinned, live, current }
}
