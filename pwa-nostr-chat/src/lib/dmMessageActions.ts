import type { DmMessage, ReactionSummary, ReplyReference } from '../types/protocol.ts'

export function isDmTargetId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 255 && !/[\s\p{Cc}]/u.test(id)
}

// Only target IDs known to the other participant. Older sent NIP-17 messages
// and long BitChat messages stored only the optimistic, device-local ID.
export function dmTargetId(message: DmMessage): string | undefined {
  if (message.deliveryStatus === 'sending' || message.deliveryStatus === 'failed') return
  if (isDmTargetId(message.wireId)) return message.wireId
  if (!isDmTargetId(message.id)) return
  if (!message.isOwn || (message.protocol === 'bitchat' && !message.imageAttachment && !message.voiceMemo &&
    new TextEncoder().encode(message.content).length <= 255)) return message.id
}

export function addDmReaction(message: DmMessage, sender: string, emoji: string, own: boolean): DmMessage {
  const reactions = message.reactions ?? []
  const match = reactions.find(r => r.emoji === emoji)
  if (match?.pubkeys.includes(sender)) {
    if (!own || match.reactedByMe) return message
    return { ...message, reactions: reactions.map(r => r === match ? { ...r, reactedByMe: true } : r) }
  }
  if (!match && reactions.length >= 64) return message
  const next: ReactionSummary = {
    emoji, pubkeys: [...(match?.pubkeys ?? []), sender], count: (match?.pubkeys.length ?? 0) + 1,
    reactedByMe: own || !!match?.reactedByMe,
  }
  return { ...message, reactions: match ? reactions.map(r => r === match ? next : r) : [...reactions, next] }
}

export function dmReplyReference(id: string, parent: DmMessage | undefined, me: string, peer: string): ReplyReference {
  if (!parent) return { id, preview: 'Original message unavailable' }
  return { id: parent.id, pubkey: parent.senderPubkey, nickname: parent.isOwn ? me : peer,
    preview: parent.content.slice(0, 96) || (parent.voiceMemo ? 'Voice memo' : parent.imageAttachment ? 'Image' : 'Message') }
}

const DM_DELIVERY_RANK: Record<DmMessage['deliveryStatus'], number> = {
  failed: 0, sending: 1, sent: 2, delivered: 3, read: 4,
}

export function mergeDmMessageMetadata(local: DmMessage, remote: DmMessage): DmMessage {
  if (local.id !== remote.id || local.senderPubkey !== remote.senderPubkey) return local
  const wireId = local.wireId ?? (isDmTargetId(remote.wireId) ? remote.wireId : undefined)
  const replyToId = local.replyToId ?? (isDmTargetId(remote.replyToId) ? remote.replyToId : undefined)
  const deliveryStatus = DM_DELIVERY_RANK[remote.deliveryStatus] > DM_DELIVERY_RANK[local.deliveryStatus]
    ? remote.deliveryStatus : local.deliveryStatus
  let merged = deliveryStatus !== local.deliveryStatus || wireId !== local.wireId || replyToId !== local.replyToId
    ? { ...local, deliveryStatus, wireId, replyToId } : local
  for (const r of Array.isArray(remote.reactions) ? remote.reactions.slice(0, 64) : []) {
    if (!r || typeof r.emoji !== 'string' || !r.emoji || r.emoji.length > 32 || !Array.isArray(r.pubkeys)) continue
    for (const sender of r.pubkeys.slice(0, 2)) {
      if (typeof sender === 'string' && /^[0-9a-f]{64}$/.test(sender)) {
        merged = addDmReaction(merged, sender, r.emoji, Boolean(r.reactedByMe) && sender !== local.peerPubkey)
      }
    }
  }
  return merged
}
