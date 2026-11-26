import type { DmMessage, PeerInfo } from '../types/protocol.ts'

/** Only actual activity from this peer counts, not our own DM or when a thread opened. */
export function getPeerLastActivity(
  pubkey: string,
  presence: Pick<PeerInfo, 'lastSeenAt'> | null | undefined,
  messages: readonly Pick<DmMessage, 'isOwn' | 'senderPubkey' | 'createdAt'>[] = [],
): number {
  const pk = pubkey.toLowerCase()
  let latest = presence?.lastSeenAt ?? 0
  if (!Number.isFinite(latest) || latest < 0) latest = 0
  for (const message of messages) {
    if (message && !message.isOwn && typeof message.senderPubkey === 'string' &&
        message.senderPubkey.toLowerCase() === pk && Number.isFinite(message.createdAt)) {
      latest = Math.max(latest, message.createdAt)
    }
  }
  return latest
}
