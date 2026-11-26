/** An in-session outbox. Retrying a signed payload must not create a second event. */
export class ChatRetryRegistry {
  private readonly entries = new Map<string, { retry: () => Promise<boolean>; onConfirm?: () => void }>()
  private readonly retrying = new Set<string>()

  hold(id: string, retry: () => Promise<boolean>, onConfirm?: () => void) {
    this.entries.delete(id)
    this.entries.set(id, { retry, onConfirm })
    if (this.entries.size > 250) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  has(id: string) { return this.entries.has(id) }

  confirm(id: string) {
    const entry = this.entries.get(id)
    this.entries.delete(id)
    entry?.onConfirm?.()
  }

  clear() {
    this.entries.clear()
    this.retrying.clear()
  }

  async retry(id: string): Promise<boolean> {
    const attempt = this.entries.get(id)
    if (!attempt || this.retrying.has(id)) return false
    this.retrying.add(id)
    try {
      return await attempt.retry()
    } finally {
      this.retrying.delete(id)
    }
  }
}

export const chatRetries = new ChatRetryRegistry()

type PublishResult = { acceptedRelays: readonly string[]; rejectedRelays: readonly { reason: string }[] }
type DeliveryStatus = 'sending' | 'sent' | 'failed'

/** Owns the retry after signing, including a lost ACK or a late relay echo. */
export async function publishChatWire(opts: {
  rowId: string
  publish: (onAccepted: (count: number) => void) => Promise<PublishResult>
  isCurrent: () => boolean
  update: (status: DeliveryStatus, accepted: number) => void
  queueRetry: (attempt: () => Promise<boolean>) => Promise<boolean>
  onSuccess?: () => void
  onFailure: (reason: string) => void
}): Promise<boolean> {
  const { rowId, publish, isCurrent, update, queueRetry, onSuccess, onFailure } = opts
  let echoed = false
  const run = async (): Promise<boolean> => {
    if (!isCurrent()) {
      chatRetries.confirm(rowId)
      return false
    }
    if (echoed) return true // an echo arrived while the retry was queued
    update('sending', 0)
    let result: PublishResult
    try {
      result = await publish((accepted) => {
        if (!isCurrent()) return
        chatRetries.confirm(rowId)
        update('sent', accepted)
      })
    } catch (error) {
      result = { acceptedRelays: [], rejectedRelays: [{ reason: error instanceof Error ? error.message : 'Could not reach a relay.' }] }
    }
    if (!isCurrent()) return false
    const accepted = result.acceptedRelays.length + result.rejectedRelays.filter(({ reason }) => /^duplicate:/i.test(reason)).length
    if (accepted > 0 || echoed) {
      chatRetries.confirm(rowId)
      update('sent', accepted)
      onSuccess?.()
      return true
    }
    update('failed', 0)
    onFailure(result.rejectedRelays[0]?.reason || 'No connected relay accepted the message.')
    return false
  }
  chatRetries.hold(rowId, () => queueRetry(run), () => { echoed = true })
  return run()
}

export function isUnconfirmed(row: { id: string; deliveryStatus?: string }): boolean {
  return row.id.startsWith('pending-') || row.deliveryStatus === 'sending' || row.deliveryStatus === 'failed'
}

export function compareConfirmedChat(a: { id: string; createdAt: number }, b: { id: string; createdAt: number }): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export function acceptChatEcho<T extends { id: string; createdAt: number; deliveryStatus?: string }>(
  prev: readonly T[], received: T
): T[] | null {
  const found = prev.find(row => row.id === received.id)
  if (!found || !isUnconfirmed(found)) return null
  chatRetries.confirm(received.id)
  return prev.map(row => row.id === received.id ? { ...row, createdAt: received.createdAt, deliveryStatus: 'sent' } : row)
}
