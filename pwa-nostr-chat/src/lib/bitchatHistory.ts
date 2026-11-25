import type { GeoMessage } from '../types/protocol.ts'

const DB_NAME = 'agnostr-bitchat-history-v1'
const STORE = 'messages'
const PROFILE_KEY = 'agnostr:v3:active_profile_id'
const ROOM_LIMIT = 5000
// Bounds for temporary public-room history, in addition to the existing recent cache.
const DEVICE_LIMIT = 20_000
const MAX_EVENT_BYTES = 4 * 1024
const textEncoder = new TextEncoder()
export const BITCHAT_WINDOW = 160
export const BITCHAT_HISTORY_STEP = 100

export type HistoryCursor = Pick<GeoMessage, 'id' | 'createdAt'>
export type HistoryDirection = 'older' | 'newer'
export interface HistoryPage {
  messages: GeoMessage[]
  more: boolean
}

interface ArchiveRow {
  profile: string
  room: string
  at: number
  id: string
  author: string
  message: GeoMessage
}

const written = new WeakMap<GeoMessage, string>()
let dbPromise: Promise<IDBDatabase | null> | undefined

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: ['profile', 'room', 'at', 'id'] })
        store.createIndex('byAuthor', ['profile', 'author'])
        store.createIndex('byDate', 'at')
      }
      req.onsuccess = () => {
        const db = req.result
        db.onversionchange = () => {
          db.close()
          dbPromise = undefined
        }
        db.onclose = () => { dbPromise = undefined }
        resolve(db)
      }
      req.onerror = req.onblocked = () => {
        dbPromise = undefined
        resolve(null)
      }
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function activeProfile(): string | null {
  try {
    const key = localStorage.getItem(PROFILE_KEY)
    return key && /^[0-9a-f]{64}$/.test(key) ? key : null
  } catch {
    return null
  }
}

export function compareHistory(a: HistoryCursor, b: HistoryCursor): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function roomRange(profile: string, room: string): IDBKeyRange {
  return IDBKeyRange.bound([profile, room], [profile, room, []], false, true)
}

function deleteKeys(source: IDBObjectStore | IDBIndex, range?: IDBKeyRange, limit = Infinity) {
  const store = 'objectStore' in source ? source.objectStore : source
  const req = source.openKeyCursor(range)
  req.onsuccess = () => {
    const cursor = req.result
    if (!cursor || limit <= 0) return
    store.delete(cursor.primaryKey)
    limit -= 1
    if (limit > 0) cursor.continue()
  }
}

function trim(source: IDBObjectStore | IDBIndex, limit: number, range?: IDBKeyRange) {
  const req = source.count(range)
  req.onsuccess = () => {
    if (req.result > limit) deleteKeys(source, range, req.result - limit)
  }
}

/** Cache confirmed public room events only, without blocking send/receive on disk. */
export function archiveChannelMessages(profile: string, room: string, messages: readonly GeoMessage[]): void {
  if (profile !== activeProfile() || typeof indexedDB === 'undefined') return
  const scope = profile + ':' + room
  const rows = messages.filter((m) =>
    !m.isSystem && !m.isBlockedPlaceholder && !m.id.startsWith('pending-') &&
    m.deliveryStatus !== 'failed' && m.deliveryStatus !== 'sending' &&
    Number.isFinite(m.createdAt) && written.get(m) !== scope &&
    // No media bytes. Oversized public events still appear in the recent cache,
    // but they may not consume an unbounded amount of archive space.
    textEncoder.encode(JSON.stringify(m)).byteLength <= MAX_EVENT_BYTES
  )
  if (rows.length === 0) return
  for (const m of rows) written.set(m, scope)
  const retry = () => {
    for (const m of rows) if (written.get(m) === scope) written.delete(m)
  }
  void open().then((db) => {
    if (!db || profile !== activeProfile()) return retry()
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.onabort = retry
      const store = tx.objectStore(STORE)
      for (const m of rows) {
        // The parent event owns its text. Keep reply references, not another
        // durable copy of a parent's preview that might later be blocked.
        const message = m.replyTo?.preview ? { ...m, replyTo: { ...m.replyTo, preview: undefined } } : m
        store.put({
          profile, room, at: m.createdAt, id: m.id, author: m.pubkey.toLowerCase(), message,
        } satisfies ArchiveRow)
      }
      trim(store, ROOM_LIMIT, roomRange(profile, room))
      trim(store.index('byDate'), DEVICE_LIMIT)
    } catch {
      retry()
    }
  })
}

export async function readChannelHistory(
  profile: string,
  room: string,
  cursor: HistoryCursor,
  direction: HistoryDirection,
  accept: (message: GeoMessage) => boolean,
): Promise<HistoryPage> {
  const empty: HistoryPage = { messages: [], more: false }
  const db = activeProfile() === profile ? await open() : null
  if (!db || activeProfile() !== profile) return empty
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const edge = [profile, room, cursor.createdAt, cursor.id]
      const older = direction === 'older'
      const range = older
        ? IDBKeyRange.bound([profile, room], edge, false, true)
        : IDBKeyRange.bound(edge, [profile, room, []], true, true)
      const req = tx.objectStore(STORE).openCursor(range, older ? 'prev' : 'next')
      const messages: GeoMessage[] = []
      req.onsuccess = () => {
        const message = (req.result?.value as ArchiveRow | undefined)?.message
        const accepted = message !== undefined && accept(message)
        if (!req.result || (accepted && messages.length === BITCHAT_HISTORY_STEP)) {
          resolve(activeProfile() === profile
            ? { messages: older ? messages.reverse() : messages, more: Boolean(req.result) }
            : empty)
          return
        }
        if (accepted) messages.push(message)
        req.result.continue()
      }
      tx.onabort = req.onerror = () => resolve(empty)
    } catch {
      resolve(empty)
    }
  })
}

async function remove(range: IDBKeyRange, index?: 'byAuthor'): Promise<void> {
  const db = await open()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.oncomplete = tx.onabort = () => resolve()
      const store = tx.objectStore(STORE)
      deleteKeys(index ? store.index(index) : store, range)
    } catch {
      resolve()
    }
  })
}

export function clearChannelHistory(profile: string, room: string): void {
  if (profile && typeof IDBKeyRange !== 'undefined') void remove(roomRange(profile, room))
}

export function removeBlockedFromChannelHistory(profile: string, author: string): void {
  if (profile && typeof IDBKeyRange !== 'undefined') {
    void remove(IDBKeyRange.only([profile, author]), 'byAuthor')
  }
}

export function clearProfileChannelHistory(profile: string): Promise<void> {
  if (typeof IDBKeyRange === 'undefined') return Promise.resolve()
  return remove(IDBKeyRange.bound([profile], [profile, []], false, true))
}
