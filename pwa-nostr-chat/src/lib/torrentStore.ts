import type { TorrentShareRecord } from '../types/torrent.ts'

/** Profile-scoped localStorage revocation cache (cleared on panic wipe, snapshotted per profile) */
export const TORRENT_REVOCATIONS_STORAGE_KEY = 'agnostr:v2:torrent_revocations'

const TORRENT_DB_PREFIX = 'agnostr-torrent-vault-'
const TORRENT_DB_REGISTRY_KEY = 'agnostr:v2:torrent_db_registry'
const TORRENT_DB_VERSION = 1
const STORE_SHARES = 'shares'
const STORE_PIECES = 'pieces'
const MAX_CACHED_REVOCATIONS = 1000
const HEX_64_RE = /^[0-9a-f]{64}$/i

export interface StoredTorrentShare extends TorrentShareRecord {
  /** Verified per-piece plaintext SHA-256 hex digests matching `piecesRoot` */
  pieceHashes: string[]
}

interface StoredPieceEntry {
  key: string
  infoHash: string
  pieceIndex: number
  data: ArrayBuffer
}

function safeStorageGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  } catch {
    // Ignore storage quota or restricted context errors
  }
}

function registerTorrentDbName(dbName: string): void {
  if (!dbName.startsWith(TORRENT_DB_PREFIX)) return
  try {
    const raw = safeStorageGet(TORRENT_DB_REGISTRY_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    const set = new Set<string>(
      Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
    )
    if (!set.has(dbName)) {
      set.add(dbName)
      safeStorageSet(TORRENT_DB_REGISTRY_KEY, JSON.stringify(Array.from(set).slice(-32)))
    }
  } catch {
    // Ignore
  }
}

function unregisterTorrentDbName(dbName: string): void {
  try {
    const raw = safeStorageGet(TORRENT_DB_REGISTRY_KEY)
    if (!raw) return
    const list = JSON.parse(raw) as unknown
    if (!Array.isArray(list)) return
    const next = list.filter((x): x is string => typeof x === 'string' && x !== dbName)
    safeStorageSet(TORRENT_DB_REGISTRY_KEY, JSON.stringify(next))
  } catch {
    // Ignore
  }
}

export function getProfileTorrentDbName(masterPubkey: string): string {
  const pk = (masterPubkey ?? '').trim().toLowerCase()
  const prefix = HEX_64_RE.test(pk) ? pk.slice(0, 16) : 'default'
  return `${TORRENT_DB_PREFIX}${prefix}`
}

function deleteIndexedDbByName(dbName: string): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof indexedDB === 'undefined' || !dbName) {
      resolve()
      return
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      unregisterTorrentDbName(dbName)
      resolve()
    }
    const fallbackTimer = globalThis.setTimeout(finish, 2500)
    try {
      const req = indexedDB.deleteDatabase(dbName)
      req.onsuccess = () => {
        globalThis.clearTimeout(fallbackTimer)
        finish()
      }
      req.onerror = () => {
        globalThis.clearTimeout(fallbackTimer)
        finish()
      }
      req.onblocked = () => {
        globalThis.clearTimeout(fallbackTimer)
        finish()
      }
    } catch {
      globalThis.clearTimeout(fallbackTimer)
      finish()
    }
  })
}

export async function deleteProfileTorrentDb(masterPubkey: string): Promise<void> {
  const dbName = getProfileTorrentDbName(masterPubkey)
  await deleteIndexedDbByName(dbName)
}

export async function deleteAllTorrentDbs(): Promise<void> {
  const names = new Set<string>([`${TORRENT_DB_PREFIX}default`])
  try {
    const raw = safeStorageGet(TORRENT_DB_REGISTRY_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string' && item.startsWith(TORRENT_DB_PREFIX)) {
            names.add(item)
          }
        }
      }
    }
  } catch {
    // Ignore
  }
  try {
    if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases()
      for (const db of dbs) {
        if (db?.name && db.name.startsWith(TORRENT_DB_PREFIX)) {
          names.add(db.name)
        }
      }
    }
  } catch {
    // Ignore browsers without indexedDB.databases()
  }
  await Promise.all(Array.from(names).map((n) => deleteIndexedDbByName(n)))
}

export function loadCachedRevocations(): Record<string, number> {
  const raw = safeStorageGet(TORRENT_REVOCATIONS_STORAGE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const infoHash = k.trim().toLowerCase()
      if (!HEX_64_RE.test(infoHash)) continue
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        out[infoHash] = Math.floor(v)
      }
    }
    return out
  } catch {
    return {}
  }
}

function persistRevocations(map: Record<string, number>): void {
  const entries = Object.entries(map)
    .filter(([k, v]) => HEX_64_RE.test(k) && typeof v === 'number' && Number.isFinite(v) && v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_CACHED_REVOCATIONS)
  safeStorageSet(TORRENT_REVOCATIONS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
}

export function saveCachedRevocation(infoHash: string, closedAt: number): void {
  const cleanHash = infoHash.trim().toLowerCase()
  if (!HEX_64_RE.test(cleanHash)) return
  const ts = Number.isFinite(closedAt) && closedAt > 0 ? Math.floor(closedAt) : Date.now()
  const current = loadCachedRevocations()
  if ((current[cleanHash] ?? 0) >= ts) return
  current[cleanHash] = ts
  persistRevocations(current)
}

export function clearCachedRevocation(infoHash: string): void {
  const cleanHash = infoHash.trim().toLowerCase()
  if (!HEX_64_RE.test(cleanHash)) return
  const current = loadCachedRevocations()
  if (!(cleanHash in current)) return
  delete current[cleanHash]
  persistRevocations(current)
}

function makePieceKey(infoHash: string, pieceIndex: number): string {
  return `${infoHash.toLowerCase()}:${pieceIndex}`
}

function toCopiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: unknown }).name
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
}

/**
 * Profile-scoped persistent IndexedDB vault for E2EE torrent metadata and encrypted pieces.
 * Stores shares with ZERO TTL / ZERO automatic expiry until explicitly closed or deleted.
 * Automatically falls back to an in-memory map if IndexedDB is unavailable or hits storage quota.
 */
export class TorrentVaultStore {
  private readonly dbName: string
  private dbPromise: Promise<IDBDatabase | null> | null = null
  private dbInstance: IDBDatabase | null = null
  private useMemoryFallback = false
  private readonly memShares = new Map<string, StoredTorrentShare>()
  private readonly memPieces = new Map<string, Uint8Array>()

  constructor(masterPubkey: string) {
    this.dbName = getProfileTorrentDbName(masterPubkey)
  }

  getDbName(): string {
    return this.dbName
  }

  private open(): Promise<IDBDatabase | null> {
    if (this.useMemoryFallback || typeof indexedDB === 'undefined') {
      this.useMemoryFallback = true
      return Promise.resolve(null)
    }
    if (this.dbInstance) return Promise.resolve(this.dbInstance)
    if (this.dbPromise) return this.dbPromise

    registerTorrentDbName(this.dbName)
    this.dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = indexedDB.open(this.dbName, TORRENT_DB_VERSION)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(STORE_SHARES)) {
            db.createObjectStore(STORE_SHARES, { keyPath: 'infoHash' })
          }
          if (!db.objectStoreNames.contains(STORE_PIECES)) {
            const store = db.createObjectStore(STORE_PIECES, { keyPath: 'key' })
            store.createIndex('byInfoHash', 'infoHash', { unique: false })
          }
        }
        req.onsuccess = () => {
          const db = req.result
          this.dbInstance = db
          db.onversionchange = () => {
            db.close()
            this.dbInstance = null
            this.dbPromise = null
          }
          resolve(db)
        }
        req.onerror = () => {
          this.useMemoryFallback = true
          this.dbPromise = null
          resolve(null)
        }
        req.onblocked = () => {
          this.useMemoryFallback = true
          this.dbPromise = null
          resolve(null)
        }
      } catch {
        this.useMemoryFallback = true
        this.dbPromise = null
        resolve(null)
      }
    })
    return this.dbPromise
  }

  async putShare(share: StoredTorrentShare): Promise<boolean> {
    const normalized: StoredTorrentShare = {
      ...share,
      infoHash: share.infoHash.toLowerCase(),
      swarmId: share.swarmId.toLowerCase(),
      senderPubkey: share.senderPubkey.toLowerCase(),
      activePeerCount: Math.max(0, share.activePeerCount || 0),
    }
    this.memShares.set(normalized.infoHash, normalized)
    const db = await this.open()
    if (!db) return true
    return await new Promise<boolean>((resolve) => {
      try {
        const tx = db.transaction(STORE_SHARES, 'readwrite')
        tx.objectStore(STORE_SHARES).put(normalized)
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => {
          if (isQuotaError(tx.error)) {
            this.useMemoryFallback = true
          }
          resolve(false)
        }
        tx.onabort = () => {
          if (isQuotaError(tx.error)) {
            this.useMemoryFallback = true
          }
          resolve(false)
        }
      } catch (err) {
        if (isQuotaError(err)) this.useMemoryFallback = true
        resolve(false)
      }
    })
  }

  async getShare(infoHash: string): Promise<StoredTorrentShare | null> {
    const key = infoHash.trim().toLowerCase()
    if (!key) return null
    const db = await this.open()
    if (!db) return this.memShares.get(key) ?? null
    return await new Promise<StoredTorrentShare | null>((resolve) => {
      try {
        const tx = db.transaction(STORE_SHARES, 'readonly')
        const req = tx.objectStore(STORE_SHARES).get(key)
        req.onsuccess = () => {
          const found = (req.result as StoredTorrentShare | undefined) ?? null
          if (found) this.memShares.set(key, found)
          resolve(found ?? this.memShares.get(key) ?? null)
        }
        req.onerror = () => resolve(this.memShares.get(key) ?? null)
      } catch {
        resolve(this.memShares.get(key) ?? null)
      }
    })
  }

  async listShares(): Promise<StoredTorrentShare[]> {
    const db = await this.open()
    if (!db) {
      return Array.from(this.memShares.values()).sort((a, b) => b.createdAt - a.createdAt)
    }
    return await new Promise<StoredTorrentShare[]>((resolve) => {
      try {
        const tx = db.transaction(STORE_SHARES, 'readonly')
        const req = tx.objectStore(STORE_SHARES).getAll()
        req.onsuccess = () => {
          const rows = Array.isArray(req.result) ? (req.result as StoredTorrentShare[]) : []
          const byHash = new Map<string, StoredTorrentShare>()
          for (const mem of this.memShares.values()) {
            byHash.set(mem.infoHash, mem)
          }
          for (const row of rows) {
            if (row && typeof row.infoHash === 'string') {
              byHash.set(row.infoHash.toLowerCase(), row)
              this.memShares.set(row.infoHash.toLowerCase(), row)
            }
          }
          const out = Array.from(byHash.values()).sort((a, b) => b.createdAt - a.createdAt)
          resolve(out)
        }
        req.onerror = () =>
          resolve(Array.from(this.memShares.values()).sort((a, b) => b.createdAt - a.createdAt))
      } catch {
        resolve(Array.from(this.memShares.values()).sort((a, b) => b.createdAt - a.createdAt))
      }
    })
  }

  async updateShare(
    infoHash: string,
    patch: Partial<StoredTorrentShare>
  ): Promise<StoredTorrentShare | null> {
    const existing = await this.getShare(infoHash)
    if (!existing) return null
    const updated: StoredTorrentShare = { ...existing, ...patch, infoHash: existing.infoHash }
    await this.putShare(updated)
    return updated
  }

  async putPiece(infoHash: string, pieceIndex: number, data: Uint8Array): Promise<boolean> {
    const cleanHash = infoHash.trim().toLowerCase()
    const key = makePieceKey(cleanHash, pieceIndex)
    const db = await this.open()
    if (!db) {
      this.memPieces.set(key, new Uint8Array(data))
      return true
    }
    const entry: StoredPieceEntry = {
      key,
      infoHash: cleanHash,
      pieceIndex,
      data: toCopiedArrayBuffer(data),
    }
    return await new Promise<boolean>((resolve) => {
      try {
        const tx = db.transaction(STORE_PIECES, 'readwrite')
        tx.objectStore(STORE_PIECES).put(entry)
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => {
          if (isQuotaError(tx.error)) {
            this.memPieces.set(key, new Uint8Array(data))
          }
          resolve(false)
        }
        tx.onabort = () => {
          if (isQuotaError(tx.error)) {
            this.memPieces.set(key, new Uint8Array(data))
          }
          resolve(false)
        }
      } catch (err) {
        if (isQuotaError(err)) {
          this.memPieces.set(key, new Uint8Array(data))
        }
        resolve(false)
      }
    })
  }

  async getPiece(infoHash: string, pieceIndex: number): Promise<Uint8Array | null> {
    const cleanHash = infoHash.trim().toLowerCase()
    const key = makePieceKey(cleanHash, pieceIndex)
    const memHit = this.memPieces.get(key)
    if (memHit) return memHit
    const db = await this.open()
    if (!db) return null
    return await new Promise<Uint8Array | null>((resolve) => {
      try {
        const tx = db.transaction(STORE_PIECES, 'readonly')
        const req = tx.objectStore(STORE_PIECES).get(key)
        req.onsuccess = () => {
          const entry = req.result as StoredPieceEntry | undefined
          if (!entry || !(entry.data instanceof ArrayBuffer)) {
            resolve(null)
            return
          }
          resolve(new Uint8Array(entry.data))
        }
        req.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }

  async listPieceIndices(infoHash: string): Promise<number[]> {
    const cleanHash = infoHash.trim().toLowerCase()
    const indices = new Set<number>()
    const prefix = `${cleanHash}:`
    for (const k of this.memPieces.keys()) {
      if (k.startsWith(prefix)) {
        const idx = Number.parseInt(k.slice(prefix.length), 10)
        if (Number.isInteger(idx) && idx >= 0) indices.add(idx)
      }
    }
    const db = await this.open()
    if (!db) {
      return Array.from(indices).sort((a, b) => a - b)
    }
    return await new Promise<number[]>((resolve) => {
      try {
        const tx = db.transaction(STORE_PIECES, 'readonly')
        const idx = tx.objectStore(STORE_PIECES).index('byInfoHash')
        const req = idx.openKeyCursor(IDBKeyRange.only(cleanHash))
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) {
            resolve(Array.from(indices).sort((a, b) => a - b))
            return
          }
          const primaryKey = String(cursor.primaryKey)
          if (primaryKey.startsWith(prefix)) {
            const pieceIndex = Number.parseInt(primaryKey.slice(prefix.length), 10)
            if (Number.isInteger(pieceIndex) && pieceIndex >= 0) {
              indices.add(pieceIndex)
            }
          }
          cursor.continue()
        }
        req.onerror = () => resolve(Array.from(indices).sort((a, b) => a - b))
      } catch {
        resolve(Array.from(indices).sort((a, b) => a - b))
      }
    })
  }

  async hasAllPieces(infoHash: string, pieceCount: number): Promise<boolean> {
    if (!Number.isInteger(pieceCount) || pieceCount < 1) return false
    const indices = await this.listPieceIndices(infoHash)
    if (indices.length < pieceCount) return false
    for (let i = 0; i < pieceCount; i += 1) {
      if (indices[i] !== i) return false
    }
    return true
  }

  async deletePiecesForInfoHash(infoHash: string): Promise<void> {
    const cleanHash = infoHash.trim().toLowerCase()
    const prefix = `${cleanHash}:`
    for (const k of Array.from(this.memPieces.keys())) {
      if (k.startsWith(prefix)) this.memPieces.delete(k)
    }
    const db = await this.open()
    if (!db) return
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_PIECES, 'readwrite')
        const store = tx.objectStore(STORE_PIECES)
        const idx = store.index('byInfoHash')
        const req = idx.openKeyCursor(IDBKeyRange.only(cleanHash))
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          store.delete(cursor.primaryKey)
          cursor.continue()
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  }

  async deleteShare(infoHash: string): Promise<void> {
    const cleanHash = infoHash.trim().toLowerCase()
    this.memShares.delete(cleanHash)
    await this.deletePiecesForInfoHash(cleanHash)
    const db = await this.open()
    if (!db) return
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_SHARES, 'readwrite')
        tx.objectStore(STORE_SHARES).delete(cleanHash)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  }

  close(): void {
    if (this.dbInstance) {
      try {
        this.dbInstance.close()
      } catch {
        // Ignore
      }
      this.dbInstance = null
      this.dbPromise = null
    }
  }
}
