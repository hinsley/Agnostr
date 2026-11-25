import type { AmailMessage } from '../types/amail.ts'

export function baseMailId(id: string): string {
  return id.endsWith(':self') ? id.slice(0, -5) : id
}

/** Follow the explicit reply links, not the thread's display order or timestamps. */
export function buildAmailReplyChain(messages: readonly AmailMessage[], replyTo: string) {
  const byId = new Map<string, AmailMessage>()
  for (const message of messages) {
    if (message.folder !== 'drafts') byId.set(message.id, message)
  }

  const chain: AmailMessage[] = []
  const seen = new Set<string>()
  let nextId = replyTo.trim()
  while (nextId) {
    const baseId = baseMailId(nextId)
    if (seen.has(baseId)) break
    const message = byId.get(nextId) ?? byId.get(baseId) ?? byId.get(`${baseId}:self`)
    if (!message) break
    chain.push(message)
    seen.add(baseId)
    nextId = message.inReplyTo?.trim() ?? ''
  }
  return { messages: chain.reverse(), incomplete: Boolean(nextId) }
}
