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
  if (match?.pubkeys.includes(sender) || (!match && reactions.length >= 64)) return message
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
