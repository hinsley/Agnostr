import { compareConfirmedChat, isUnconfirmed } from './chatDelivery.ts'

/**
 * Per-conversation strict FIFO async send queue.
 *
 * Guarantees that multiple rapid sends to the same scope (channel, server channel,
 * or DM peer) execute strictly in submission order without deadlocking if an earlier
 * send fails, while independent scopes run concurrently without head-of-line blocking.
 */
export class KeyedFifoQueue {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly pendingCounts = new Map<string, number>()
  private readonly scopeEpochs = new Map<string, number>()
  private globalEpoch = 0

  /**
   * Enqueues `task` behind all previously enqueued tasks for `scopeKey`.
   * If `clearScope(scopeKey)` or `clearAll()` is called before `task` starts,
   * `task` is skipped and `onCancelled()` is returned (or the promise rejects).
   */
  enqueue<T>(
    scopeKey: string,
    task: () => Promise<T>,
    onCancelled?: () => T
  ): Promise<T> {
    const key = scopeKey || '__default__'
    const enqueuedGlobal = this.globalEpoch
    const enqueuedScope = this.scopeEpochs.get(key) ?? 0

    this.pendingCounts.set(key, (this.pendingCounts.get(key) ?? 0) + 1)

    const prev = this.tails.get(key) ?? Promise.resolve()
    const runPromise = prev.then(async (): Promise<T> => {
      const currentScope = this.scopeEpochs.get(key) ?? 0
      if (this.globalEpoch !== enqueuedGlobal || currentScope !== enqueuedScope) {
        if (onCancelled) return onCancelled()
        throw new Error('Queued send cancelled.')
      }
      return await task()
    })

    // Swallow errors on the internal chain link so a failed send never deadlocks subsequent items
    const tailLink = runPromise.then(
      () => undefined,
      () => undefined
    )

    const cleanupLink = tailLink.finally(() => {
      const remaining = (this.pendingCounts.get(key) ?? 1) - 1
      if (remaining <= 0) {
        this.pendingCounts.delete(key)
      } else {
        this.pendingCounts.set(key, remaining)
      }
      if (this.tails.get(key) === cleanupLink) {
        this.tails.delete(key)
      }
    })

    this.tails.set(key, cleanupLink)
    return runPromise
  }

  /**
   * Returns the number of active + waiting tasks for `scopeKey`, or total across all scopes.
   */
  getPendingCount(scopeKey?: string): number {
    if (scopeKey !== undefined) {
      return this.pendingCounts.get(scopeKey || '__default__') ?? 0
    }
    let total = 0
    for (const count of this.pendingCounts.values()) {
      total += count
    }
    return total
  }

  /**
   * Cancels queued-not-yet-started tasks for a single scope and resets its tail tracker.
   */
  clearScope(scopeKey: string): void {
    const key = scopeKey || '__default__'
    this.scopeEpochs.set(key, (this.scopeEpochs.get(key) ?? 0) + 1)
    this.tails.delete(key)
    this.pendingCounts.delete(key)
  }

  /**
   * Cancels all queued-not-yet-started tasks across every scope (used on Panic Wipe).
   */
  clearAll(): void {
    this.globalEpoch += 1
    this.tails.clear()
    this.pendingCounts.clear()
    this.scopeEpochs.clear()
  }
}

export const chatSendQueue = new KeyedFifoQueue()

/** Keep local drafts out of the shared wire ordering until delivery is known. */
export function sortChannelMessagesWithPending<
  T extends { id: string; createdAt: number; deliveryStatus?: string },
>(messages: readonly T[], pendingPrefix: string): T[] {
  const confirmed: T[] = []
  const pending: T[] = []
  for (const message of messages) {
    (message.id.startsWith(pendingPrefix) || isUnconfirmed(message) ? pending : confirmed).push(message)
  }
  return [...confirmed.sort(compareConfirmedChat), ...pending]
}

/**
 * Replaces a local draft with its signed row without copying any local timestamp.
 * Do not create a second row if an echo made it into the timeline first.
 */
export function swapPendingWithSigned<
  T extends { id: string; createdAt: number; deliveryStatus?: string },
>(
  prev: readonly T[],
  tempId: string,
  signedMsg: T,
  pendingPrefix: string
): T[] {
  const alreadyPresent = prev.some((m) => m.id === signedMsg.id && m.id !== tempId)
  const next = prev.filter((m) => m.id !== tempId)
  if (!alreadyPresent) {
    const index = prev.findIndex((m) => m.id === tempId)
    next.splice(index < 0 ? next.length : index, 0, signedMsg)
  }
  return sortChannelMessagesWithPending(next, pendingPrefix)
}
