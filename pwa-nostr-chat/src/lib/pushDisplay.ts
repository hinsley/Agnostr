/** Only exact, authenticated delivery IDs can match an already displayed notification.
 * A room tag, sender, thread or referenced note ID alone never establishes a match. */
export function normalizePushIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
    ? value.toLowerCase()
    : undefined
}

export async function findDisplayedPush(
  registration: Pick<ServiceWorkerRegistration, 'getNotifications'>,
  target: { category: string; deliveryEventId?: string; recipientPubkey?: string },
  timeoutMs = 250
): Promise<Notification | undefined> {
  const deliveryEventId = normalizePushIdentifier(target.deliveryEventId)
  const recipientPubkey = normalizePushIdentifier(target.recipientPubkey)
  if (!deliveryEventId || !recipientPubkey || typeof registration.getNotifications !== 'function') {
    return undefined
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const pending = registration.getNotifications()
    const existing = await Promise.race([
      pending,
      new Promise<Notification[]>((resolve) => {
        timer = setTimeout(() => resolve([]), timeoutMs)
      }),
    ])
    return existing.find((item) => {
      const data = item.data as {
        category?: unknown
        deliveryEventId?: unknown
        recipientPubkey?: unknown
      } | null
      return item.tag && data?.category === target.category &&
        normalizePushIdentifier(data.deliveryEventId) === deliveryEventId &&
        normalizePushIdentifier(data.recipientPubkey) === recipientPubkey
    })
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Link a freshly decrypted DM to its verified outer event without storing
 * that association in DM history or device sync. The wrap ID is not the
 * decrypted message/rumor ID. Old cached messages intentionally lack it. */
const liveDmTransport = new WeakMap<object, { deliveryEventId: string; recipientPubkey: string }>()

export function rememberLiveDmPush(message: object, eventId: string, recipient: string): void {
  const deliveryEventId = normalizePushIdentifier(eventId)
  const recipientPubkey = normalizePushIdentifier(recipient)
  if (deliveryEventId && recipientPubkey) {
    liveDmTransport.set(message, { deliveryEventId, recipientPubkey })
  }
}

export function getLiveDmPush(message: object): {
  deliveryEventId: string
  recipientPubkey: string
} | undefined {
  return liveDmTransport.get(message)
}
