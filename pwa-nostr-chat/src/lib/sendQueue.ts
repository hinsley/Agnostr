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

function isQueuedPending<T extends { id: string; deliveryStatus?: string }>(
  message: T,
  pendingPrefix: string
): boolean {
  return message.id.startsWith(pendingPrefix) && message.deliveryStatus !== 'failed'
}

/**
 * Sorts confirmed messages stably by `createdAt` while pinning queued optimistic
 * placeholders (`id.startsWith(pendingPrefix)` and not `'failed'`) strictly at the
 * tail in their original FIFO enqueue order (bumping their timestamps >= the latest
 * confirmed message so interleaved peer traffic can never sort pending sends ahead
 * of earlier confirmed sends).
 */
export function sortChannelMessagesWithPending<
  T extends { id: string; createdAt: number; deliveryStatus?: string },
>(messages: readonly T[], pendingPrefix: string): T[] {
  const confirmed: T[] = []
  const pending: T[] = []

  for (const m of messages) {
    if (isQueuedPending(m, pendingPrefix)) {
      pending.push(m)
    } else {
      confirmed.push(m)
    }
  }

  confirmed.sort((a, b) => a.createdAt - b.createdAt)
  if (pending.length === 0) return confirmed

  let floorSec = confirmed.length > 0 ? confirmed[confirmed.length - 1].createdAt : 0
  const adjustedPending: T[] = new Array(pending.length)
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i]
    const nextSec = Math.max(p.createdAt, floorSec)
    floorSec = nextSec
    adjustedPending[i] = nextSec === p.createdAt ? p : { ...p, createdAt: nextSec }
  }

  return [...confirmed, ...adjustedPending]
}

/**
 * Replaces an optimistic placeholder (`tempId`) with its signed event (`signedMsg`)
 * while preserving strict monotonic ordering across confirmed messages and bumping
 * any remaining queued placeholders to stay pinned at the tail.
 */
export function swapPendingWithSigned<
  T extends { id: string; createdAt: number; deliveryStatus?: string },
>(
  prev: readonly T[],
  tempId: string,
  signedMsg: T,
  pendingPrefix: string
): T[] {
  const confirmed: T[] = []
  const remainingPending: T[] = []
  let hasSigned = false
  let tempCreatedAt = 0

  for (const m of prev) {
    if (m.id === tempId) {
      tempCreatedAt = m.createdAt
      continue
    }
    if (m.id === signedMsg.id) {
      hasSigned = true
    }
    if (isQueuedPending(m, pendingPrefix)) {
      remainingPending.push(m)
    } else {
      confirmed.push(m)
    }
  }

  if (!hasSigned) {
    const nextSec = Math.max(signedMsg.createdAt, tempCreatedAt)
    confirmed.push(nextSec === signedMsg.createdAt ? signedMsg : { ...signedMsg, createdAt: nextSec })
  }

  return sortChannelMessagesWithPending([...confirmed, ...remainingPending], pendingPrefix)
}

