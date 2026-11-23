import {
  DEFAULT_AMAIL_RELAY_SETTINGS,
  type AmailAckTombstone,
  type AmailContact,
  type AmailCustomFolder,
  type AmailFolderSortMode,
  type AmailMessage,
  type AmailRelayCapsuleMeta,
  type AmailRelaySettings,
  type AmailSealedCapsule,
  type AmailStorageStats,
} from '../types/amail.ts'
import { estimateCapsuleSizeBytes, utf8ByteLength } from './amailCrypto.ts'

export const AMAIL_DB_NAME = 'agnostr-amail-db'
const AMAIL_DB_VERSION = 1

const STORES = {
  mail: 'mail',
  contacts: 'contacts',
  relayVault: 'relayVault',
  tombstones: 'tombstones',
  meta: 'meta',
} as const

interface PersistedCounters {
  totalRelayedOut: number
  totalDeliveredPurged: number
  totalExpiredPurged: number
}

interface PersistedSyncTombstones {
  deletedMessageIds: Record<string, number>
  removedContactPubkeys: Record<string, number>
  deletedFolderIds: Record<string, number>
}

export interface AmailStorageSnapshot {
  messages: AmailMessage[]
  contacts: AmailContact[]
  customFolders: AmailCustomFolder[]
  folderSortMode: AmailFolderSortMode
  relayCapsules: AmailRelayCapsuleMeta[]
  tombstonesCount: number
  settings: AmailRelaySettings
  stats: AmailStorageStats
  deletedMessageIds: Record<string, number>
  removedContactPubkeys: Record<string, number>
  deletedFolderIds: Record<string, number>
}

function normalizeFolderSortMode(raw: unknown): AmailFolderSortMode {
  if (raw === 'az' || raw === 'za' || raw === 'manual') return raw
  return 'manual'
}

function toCapsuleMeta(c: AmailSealedCapsule): AmailRelayCapsuleMeta {
  return {
    capsuleId: c.capsuleId,
    recipientHint: c.recipientHint,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    hopCount: c.hopCount,
    maxHops: c.maxHops,
    sizeBytes: c.sizeBytes,
    receivedVia: c.receivedVia,
    storedAt: c.storedAt,
    relayedToCount: c.relayedToCount,
  }
}

function clampSettings(raw?: Partial<AmailRelaySettings> | null): AmailRelaySettings {
  return {
    relayEnabled:
      typeof raw?.relayEnabled === 'boolean'
        ? raw.relayEnabled
        : DEFAULT_AMAIL_RELAY_SETTINGS.relayEnabled,
    sendReadReceipts:
      typeof raw?.sendReadReceipts === 'boolean'
        ? raw.sendReadReceipts
        : DEFAULT_AMAIL_RELAY_SETTINGS.sendReadReceipts,
    maxVaultBytes:
      typeof raw?.maxVaultBytes === 'number' &&
      raw.maxVaultBytes >= 1024 * 1024 &&
      raw.maxVaultBytes <= 100 * 1024 * 1024
        ? Math.floor(raw.maxVaultBytes)
        : DEFAULT_AMAIL_RELAY_SETTINGS.maxVaultBytes,
    maxHops:
      typeof raw?.maxHops === 'number' && raw.maxHops >= 2 && raw.maxHops <= 12
        ? Math.floor(raw.maxHops)
        : DEFAULT_AMAIL_RELAY_SETTINGS.maxHops,
    defaultTtlSec:
      typeof raw?.defaultTtlSec === 'number' &&
      raw.defaultTtlSec >= 3600 &&
      raw.defaultTtlSec <= 30 * 86_400
        ? Math.floor(raw.defaultTtlSec)
        : DEFAULT_AMAIL_RELAY_SETTINGS.defaultTtlSec,
    maxMeshPeers:
      typeof raw?.maxMeshPeers === 'number' && raw.maxMeshPeers >= 1 && raw.maxMeshPeers <= 10
        ? Math.floor(raw.maxMeshPeers)
        : DEFAULT_AMAIL_RELAY_SETTINGS.maxMeshPeers,
  }
}

/**
 * Dedicated IndexedDB storage engine for Amail (`agnostr-amail-db`) with exact
 * UTF-8 byte accounting, third-party relay vault quota eviction, and automatic
 * fallback to in-memory Maps if IndexedDB is unavailable.
 */
export class AmailStorage {
  private dbPromise: Promise<IDBDatabase | null> | null = null
  private dbHandle: IDBDatabase | null = null

  // In-memory write-through mirror (guarantees fast sync queries & graceful fallback)
  private mailMap = new Map<string, AmailMessage>()
  private contactMap = new Map<string, AmailContact>()
  private customFolderMap = new Map<string, AmailCustomFolder>()
  private folderSortMode: AmailFolderSortMode = 'manual'
  private vaultMap = new Map<string, AmailSealedCapsule>()
  private tombstoneMap = new Map<string, AmailAckTombstone>()
  private settings: AmailRelaySettings = { ...DEFAULT_AMAIL_RELAY_SETTINGS }
  private counters: PersistedCounters = {
    totalRelayedOut: 0,
    totalDeliveredPurged: 0,
    totalExpiredPurged: 0,
  }
  private syncTombstones: PersistedSyncTombstones = {
    deletedMessageIds: {},
    removedContactPubkeys: {},
    deletedFolderIds: {},
  }
  private initialized = false

  async init(): Promise<void> {
    if (this.initialized) return
    const db = await this.openDb()
    if (db) {
      const [
        mails,
        contacts,
        capsules,
        tombstones,
        settingsRec,
        countersRec,
        syncTombRec,
        customFoldersRec,
        folderSortModeRec,
      ] = await Promise.all([
        this.idbGetAll<AmailMessage>(db, STORES.mail),
        this.idbGetAll<AmailContact>(db, STORES.contacts),
        this.idbGetAll<AmailSealedCapsule>(db, STORES.relayVault),
        this.idbGetAll<AmailAckTombstone>(db, STORES.tombstones),
        this.idbGet<{ key: string; value: Partial<AmailRelaySettings> }>(
          db,
          STORES.meta,
          'settings'
        ),
        this.idbGet<{ key: string; value: Partial<PersistedCounters> }>(
          db,
          STORES.meta,
          'counters'
        ),
        this.idbGet<{ key: string; value: Partial<PersistedSyncTombstones> }>(
          db,
          STORES.meta,
          'syncTombstones'
        ),
        this.idbGet<{ key: string; value: AmailCustomFolder[] }>(
          db,
          STORES.meta,
          'customFolders'
        ),
        this.idbGet<{ key: string; value: AmailFolderSortMode }>(
          db,
          STORES.meta,
          'folderSortMode'
        ),
      ])

      this.mailMap.clear()
      for (const m of mails) {
        if (m && m.id) this.mailMap.set(m.id, m)
      }
      this.contactMap.clear()
      for (const c of contacts) {
        if (c && c.pubkey) this.contactMap.set(c.pubkey.toLowerCase(), c)
      }
      this.customFolderMap.clear()
      if (Array.isArray(customFoldersRec?.value)) {
        for (const f of customFoldersRec.value) {
          if (f && typeof f.id === 'string' && f.id.startsWith('folder:') && typeof f.name === 'string') {
            this.customFolderMap.set(f.id, f)
          }
        }
      }
      this.folderSortMode = normalizeFolderSortMode(folderSortModeRec?.value)
      this.vaultMap.clear()
      for (const cap of capsules) {
        if (cap && cap.capsuleId) this.vaultMap.set(cap.capsuleId, cap)
      }
      this.tombstoneMap.clear()
      for (const t of tombstones) {
        if (t && t.capsuleId) this.tombstoneMap.set(t.capsuleId, t)
      }
      this.settings = clampSettings(settingsRec?.value)
      this.counters = {
        totalRelayedOut: Number(countersRec?.value?.totalRelayedOut) || 0,
        totalDeliveredPurged: Number(countersRec?.value?.totalDeliveredPurged) || 0,
        totalExpiredPurged: Number(countersRec?.value?.totalExpiredPurged) || 0,
      }
      this.syncTombstones = {
        deletedMessageIds: { ...(syncTombRec?.value?.deletedMessageIds ?? {}) },
        removedContactPubkeys: { ...(syncTombRec?.value?.removedContactPubkeys ?? {}) },
        deletedFolderIds: { ...(syncTombRec?.value?.deletedFolderIds ?? {}) },
      }
    }
    this.initialized = true
  }

  private openDb(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise
    if (typeof indexedDB === 'undefined') {
      this.dbPromise = Promise.resolve(null)
      return this.dbPromise
    }

    this.dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = indexedDB.open(AMAIL_DB_NAME, AMAIL_DB_VERSION)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(STORES.mail)) {
            db.createObjectStore(STORES.mail, { keyPath: 'id' })
          }
          if (!db.objectStoreNames.contains(STORES.contacts)) {
            db.createObjectStore(STORES.contacts, { keyPath: 'pubkey' })
          }
          if (!db.objectStoreNames.contains(STORES.relayVault)) {
            const store = db.createObjectStore(STORES.relayVault, { keyPath: 'capsuleId' })
            store.createIndex('expiresAt', 'expiresAt', { unique: false })
            store.createIndex('storedAt', 'storedAt', { unique: false })
          }
          if (!db.objectStoreNames.contains(STORES.tombstones)) {
            const store = db.createObjectStore(STORES.tombstones, { keyPath: 'capsuleId' })
            store.createIndex('expiresAt', 'expiresAt', { unique: false })
          }
          if (!db.objectStoreNames.contains(STORES.meta)) {
            db.createObjectStore(STORES.meta, { keyPath: 'key' })
          }
        }
        req.onsuccess = () => {
          this.dbHandle = req.result
          resolve(req.result)
        }
        req.onerror = () => {
          resolve(null)
        }
      } catch {
        resolve(null)
      }
    })
    return this.dbPromise
  }

  private idbGetAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readonly')
        const req = tx.objectStore(storeName).getAll()
        req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as T[]) : [])
        req.onerror = () => resolve([])
      } catch {
        resolve([])
      }
    })
  }

  private idbGet<T>(db: IDBDatabase, storeName: string, key: string): Promise<T | undefined> {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readonly')
        const req = tx.objectStore(storeName).get(key)
        req.onsuccess = () => resolve(req.result as T | undefined)
        req.onerror = () => resolve(undefined)
      } catch {
        resolve(undefined)
      }
    })
  }

  private async idbPut(storeName: string, value: unknown): Promise<void> {
    const db = await this.openDb()
    if (!db) return
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite')
        tx.objectStore(storeName).put(value)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  }

  private async idbDelete(storeName: string, key: string): Promise<void> {
    const db = await this.openDb()
    if (!db) return
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite')
        tx.objectStore(storeName).delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  }

  private async idbClear(storeName: string): Promise<void> {
    const db = await this.openDb()
    if (!db) return
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite')
        tx.objectStore(storeName).clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  }

  /* ------------------------------------------------------------------------
     Snapshot & Exact Byte Accounting
     ------------------------------------------------------------------------ */

  getSettings(): AmailRelaySettings {
    return { ...this.settings }
  }

  async updateSettings(patch: Partial<AmailRelaySettings>): Promise<AmailRelaySettings> {
    this.settings = clampSettings({ ...this.settings, ...patch })
    await this.idbPut(STORES.meta, { key: 'settings', value: this.settings })
    await this.enforceVaultQuota()
    return this.getSettings()
  }

  getAllMessages(): AmailMessage[] {
    return Array.from(this.mailMap.values()).sort((a, b) => b.sentAt - a.sentAt)
  }

  getMessage(id: string): AmailMessage | undefined {
    return this.mailMap.get(id)
  }

  getAllContacts(): AmailContact[] {
    return Array.from(this.contactMap.values()).sort((a, b) =>
      a.nickname.localeCompare(b.nickname, undefined, { sensitivity: 'base' })
    )
  }

  getContact(pubkey: string): AmailContact | undefined {
    return this.contactMap.get(pubkey.toLowerCase())
  }

  getFolderSortMode(): AmailFolderSortMode {
    return this.folderSortMode
  }

  getCustomFolder(id: string): AmailCustomFolder | undefined {
    return this.customFolderMap.get(id)
  }

  getAllCustomFolders(): AmailCustomFolder[] {
    const list = Array.from(this.customFolderMap.values())
    if (this.folderSortMode === 'az') {
      return list.sort(
        (a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
          a.createdAt - b.createdAt
      )
    }
    if (this.folderSortMode === 'za') {
      return list.sort(
        (a, b) =>
          b.name.localeCompare(a.name, undefined, { sensitivity: 'base' }) ||
          a.createdAt - b.createdAt
      )
    }
    return list.sort(
      (a, b) =>
        a.order - b.order ||
        a.createdAt - b.createdAt ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    )
  }

  getAllVaultCapsules(): AmailSealedCapsule[] {
    return Array.from(this.vaultMap.values()).sort((a, b) => b.storedAt - a.storedAt)
  }

  getVaultCapsule(capsuleId: string): AmailSealedCapsule | undefined {
    return this.vaultMap.get(capsuleId)
  }

  getAllTombstones(): AmailAckTombstone[] {
    return Array.from(this.tombstoneMap.values())
  }

  getTombstone(capsuleId: string): AmailAckTombstone | undefined {
    return this.tombstoneMap.get(capsuleId)
  }

  hasTombstone(capsuleId: string): boolean {
    return this.tombstoneMap.has(capsuleId)
  }

  computeStats(): AmailStorageStats {
    let vaultBytes = 0
    for (const c of this.vaultMap.values()) {
      vaultBytes += c.sizeBytes > 0 ? c.sizeBytes : estimateCapsuleSizeBytes(c)
    }
    let mailBytes = 0
    for (const m of this.mailMap.values()) {
      mailBytes += utf8ByteLength(JSON.stringify(m))
    }
    return {
      vaultBytes,
      vaultLimitBytes: this.settings.maxVaultBytes,
      vaultCapsuleCount: this.vaultMap.size,
      mailBytes,
      mailCount: this.mailMap.size,
      tombstoneCount: this.tombstoneMap.size,
      contactCount: this.contactMap.size,
      totalRelayedOut: this.counters.totalRelayedOut,
      totalDeliveredPurged: this.counters.totalDeliveredPurged,
      totalExpiredPurged: this.counters.totalExpiredPurged,
    }
  }

  getSnapshot(): AmailStorageSnapshot {
    return {
      messages: this.getAllMessages(),
      contacts: this.getAllContacts(),
      customFolders: this.getAllCustomFolders(),
      folderSortMode: this.getFolderSortMode(),
      relayCapsules: this.getAllVaultCapsules().map(toCapsuleMeta),
      tombstonesCount: this.tombstoneMap.size,
      settings: this.getSettings(),
      stats: this.computeStats(),
      deletedMessageIds: { ...this.syncTombstones.deletedMessageIds },
      removedContactPubkeys: { ...this.syncTombstones.removedContactPubkeys },
      deletedFolderIds: { ...this.syncTombstones.deletedFolderIds },
    }
  }

  /* ------------------------------------------------------------------------
     Mail & Contact Mutations
     ------------------------------------------------------------------------ */

  async putMessage(msg: AmailMessage): Promise<void> {
    this.mailMap.set(msg.id, msg)
    if (this.syncTombstones.deletedMessageIds[msg.id]) {
      delete this.syncTombstones.deletedMessageIds[msg.id]
      await this.persistSyncTombstones()
    }
    await this.idbPut(STORES.mail, msg)
  }

  async deleteMessage(id: string, recordTombstone = true): Promise<void> {
    this.mailMap.delete(id)
    await this.idbDelete(STORES.mail, id)
    if (recordTombstone) {
      this.syncTombstones.deletedMessageIds[id] = Date.now()
      await this.persistSyncTombstones()
    }
  }

  async putContact(contact: AmailContact): Promise<void> {
    const pk = contact.pubkey.toLowerCase()
    const clean: AmailContact = { ...contact, pubkey: pk }
    this.contactMap.set(pk, clean)
    if (this.syncTombstones.removedContactPubkeys[pk]) {
      delete this.syncTombstones.removedContactPubkeys[pk]
      await this.persistSyncTombstones()
    }
    await this.idbPut(STORES.contacts, clean)
  }

  async deleteContact(pubkey: string, recordTombstone = true): Promise<void> {
    const pk = pubkey.toLowerCase()
    this.contactMap.delete(pk)
    await this.idbDelete(STORES.contacts, pk)
    if (recordTombstone) {
      this.syncTombstones.removedContactPubkeys[pk] = Date.now()
      await this.persistSyncTombstones()
    }
  }

  /* ------------------------------------------------------------------------
     Custom Folders Persistence (stored in STORES.meta without schema bump)
     ------------------------------------------------------------------------ */

  async putCustomFolder(folder: AmailCustomFolder): Promise<void> {
    this.customFolderMap.set(folder.id, folder)
    if (this.syncTombstones.deletedFolderIds[folder.id]) {
      delete this.syncTombstones.deletedFolderIds[folder.id]
      await this.persistSyncTombstones()
    }
    await this.persistCustomFolders()
  }

  async putCustomFolders(folders: AmailCustomFolder[]): Promise<void> {
    let clearedTombstone = false
    for (const folder of folders) {
      this.customFolderMap.set(folder.id, folder)
      if (this.syncTombstones.deletedFolderIds[folder.id]) {
        delete this.syncTombstones.deletedFolderIds[folder.id]
        clearedTombstone = true
      }
    }
    if (clearedTombstone) {
      await this.persistSyncTombstones()
    }
    await this.persistCustomFolders()
  }

  async deleteCustomFolder(id: string, recordTombstone = true): Promise<void> {
    this.customFolderMap.delete(id)
    await this.persistCustomFolders()
    if (recordTombstone) {
      this.syncTombstones.deletedFolderIds[id] = Date.now()
      await this.persistSyncTombstones()
    }
  }

  async setFolderSortMode(mode: AmailFolderSortMode): Promise<void> {
    const normalized = normalizeFolderSortMode(mode)
    this.folderSortMode = normalized
    await this.idbPut(STORES.meta, { key: 'folderSortMode', value: normalized })
  }

  async mergeDeletedFolderTombstones(
    deletedFolderIds: Record<string, number>
  ): Promise<void> {
    let changed = false
    for (const [id, ts] of Object.entries(deletedFolderIds)) {
      if (typeof ts === 'number' && ts > (this.syncTombstones.deletedFolderIds[id] ?? 0)) {
        this.syncTombstones.deletedFolderIds[id] = ts
        changed = true
      }
    }
    if (changed) {
      await this.persistSyncTombstones()
    }
  }

  async mergeSyncTombstones(
    deletedMessageIds: Record<string, number>,
    removedContactPubkeys: Record<string, number>,
    deletedFolderIds?: Record<string, number>
  ): Promise<void> {
    let changed = false
    for (const [id, ts] of Object.entries(deletedMessageIds)) {
      if (typeof ts === 'number' && ts > (this.syncTombstones.deletedMessageIds[id] ?? 0)) {
        this.syncTombstones.deletedMessageIds[id] = ts
        changed = true
      }
    }
    for (const [pk, ts] of Object.entries(removedContactPubkeys)) {
      const low = pk.toLowerCase()
      if (typeof ts === 'number' && ts > (this.syncTombstones.removedContactPubkeys[low] ?? 0)) {
        this.syncTombstones.removedContactPubkeys[low] = ts
        changed = true
      }
    }
    if (deletedFolderIds) {
      for (const [id, ts] of Object.entries(deletedFolderIds)) {
        if (typeof ts === 'number' && ts > (this.syncTombstones.deletedFolderIds[id] ?? 0)) {
          this.syncTombstones.deletedFolderIds[id] = ts
          changed = true
        }
      }
    }
    if (changed) {
      await this.persistSyncTombstones()
    }
  }

  private async persistCustomFolders(): Promise<void> {
    await this.idbPut(STORES.meta, {
      key: 'customFolders',
      value: Array.from(this.customFolderMap.values()),
    })
  }

  private async persistCounters(): Promise<void> {
    await this.idbPut(STORES.meta, { key: 'counters', value: this.counters })
  }

  private async persistSyncTombstones(): Promise<void> {
    // Keep sync tombstones bounded to latest 1000 entries
    const trim = (map: Record<string, number>) => {
      const entries = Object.entries(map)
      if (entries.length <= 1000) return map
      entries.sort((a, b) => b[1] - a[1])
      return Object.fromEntries(entries.slice(0, 1000))
    }
    this.syncTombstones = {
      deletedMessageIds: trim(this.syncTombstones.deletedMessageIds),
      removedContactPubkeys: trim(this.syncTombstones.removedContactPubkeys),
      deletedFolderIds: trim(this.syncTombstones.deletedFolderIds),
    }
    await this.idbPut(STORES.meta, { key: 'syncTombstones', value: this.syncTombstones })
  }

  /* ------------------------------------------------------------------------
     Relay Vault & ACK Tombstone Management (Briar Anti-Flood Quota)
     ------------------------------------------------------------------------ */

  /**
   * Stores a sealed capsule in `relayVault` if not tombstoned or expired.
   * Automatically enforces `maxVaultBytes` by evicting oldest/nearest-expiry
   * third-party capsules without ever touching user's own `mail`.
   */
  async putRelayCapsule(
    capsule: AmailSealedCapsule,
    opts?: { ownPubkey?: string }
  ): Promise<boolean> {
    const nowSec = Math.floor(Date.now() / 1000)
    if (capsule.expiresAt <= nowSec) return false
    if (this.tombstoneMap.has(capsule.capsuleId)) return false

    const existing = this.vaultMap.get(capsule.capsuleId)
    if (existing) {
      // Keep the lowest hopCount seen for this capsule so mesh distance stays accurate
      if (capsule.hopCount < existing.hopCount) {
        const updated: AmailSealedCapsule = { ...existing, hopCount: capsule.hopCount }
        this.vaultMap.set(updated.capsuleId, updated)
        await this.idbPut(STORES.relayVault, updated)
      }
      return false
    }

    const normalized: AmailSealedCapsule = {
      ...capsule,
      sizeBytes:
        capsule.sizeBytes > 0 ? capsule.sizeBytes : estimateCapsuleSizeBytes(capsule),
      storedAt: capsule.storedAt || Date.now(),
      relayedToCount: capsule.relayedToCount || 0,
    }

    this.vaultMap.set(normalized.capsuleId, normalized)
    await this.idbPut(STORES.relayVault, normalized)
    await this.enforceVaultQuota(opts?.ownPubkey)
    return true
  }

  async incrementCapsuleRelayed(capsuleId: string): Promise<void> {
    const existing = this.vaultMap.get(capsuleId)
    if (existing) {
      const updated: AmailSealedCapsule = {
        ...existing,
        relayedToCount: existing.relayedToCount + 1,
      }
      this.vaultMap.set(capsuleId, updated)
      await this.idbPut(STORES.relayVault, updated)
    }
    this.counters.totalRelayedOut += 1
    await this.persistCounters()
  }

  /**
   * Applies a verified recipient ACK cancellation tombstone:
   * stores the tombstone and IMMEDIATELY purges the matching ciphertext capsule
   * from `relayVault` so propagation halts across the meshnet.
   */
  async applyAckTombstone(ack: AmailAckTombstone): Promise<{
    isNew: boolean
    purgedCapsule: boolean
  }> {
    const nowSec = Math.floor(Date.now() / 1000)
    if (ack.expiresAt <= nowSec) {
      return { isNew: false, purgedCapsule: false }
    }

    const isNew = !this.tombstoneMap.has(ack.capsuleId)
    if (isNew) {
      this.tombstoneMap.set(ack.capsuleId, ack)
      await this.idbPut(STORES.tombstones, ack)
    }

    let purgedCapsule = false
    if (this.vaultMap.has(ack.capsuleId)) {
      this.vaultMap.delete(ack.capsuleId)
      await this.idbDelete(STORES.relayVault, ack.capsuleId)
      this.counters.totalDeliveredPurged += 1
      await this.persistCounters()
      purgedCapsule = true
    }

    return { isNew, purgedCapsule }
  }

  async enforceVaultQuota(ownPubkey?: string): Promise<number> {
    const limit = this.settings.maxVaultBytes
    let totalBytes = 0
    for (const c of this.vaultMap.values()) {
      totalBytes += c.sizeBytes
    }
    if (totalBytes <= limit) return 0

    // Evict third-party capsules first (nearest expiry, then oldest storedAt)
    const ownPk = ownPubkey?.toLowerCase()
    const candidates = Array.from(this.vaultMap.values()).sort((a, b) => {
      const aOwn = ownPk && a.senderPubkey === ownPk ? 1 : 0
      const bOwn = ownPk && b.senderPubkey === ownPk ? 1 : 0
      if (aOwn !== bOwn) return aOwn - bOwn
      if (a.expiresAt !== b.expiresAt) return a.expiresAt - b.expiresAt
      return a.storedAt - b.storedAt
    })

    let evicted = 0
    for (const cap of candidates) {
      if (totalBytes <= limit) break
      if (ownPk && cap.senderPubkey === ownPk && cap.receivedVia === 'local') {
        // Protect user's own outbound capsules unless vault strictly overflows
        continue
      }
      this.vaultMap.delete(cap.capsuleId)
      await this.idbDelete(STORES.relayVault, cap.capsuleId)
      totalBytes -= cap.sizeBytes
      evicted += 1
    }

    if (evicted > 0) {
      this.counters.totalExpiredPurged += evicted
      await this.persistCounters()
    }
    return evicted
  }

  async pruneExpired(nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
    let removed = 0
    for (const [id, cap] of Array.from(this.vaultMap.entries())) {
      if (cap.expiresAt <= nowSec) {
        this.vaultMap.delete(id)
        await this.idbDelete(STORES.relayVault, id)
        removed += 1
      }
    }
    let tombRemoved = 0
    for (const [id, tomb] of Array.from(this.tombstoneMap.entries())) {
      if (tomb.expiresAt <= nowSec) {
        this.tombstoneMap.delete(id)
        await this.idbDelete(STORES.tombstones, id)
        tombRemoved += 1
      }
    }
    if (removed > 0) {
      this.counters.totalExpiredPurged += removed
      await this.persistCounters()
    }
    return removed + tombRemoved
  }

  async purgeRelayVault(): Promise<void> {
    this.vaultMap.clear()
    await this.idbClear(STORES.relayVault)
  }

  /**
   * Complete Panic Wipe teardown: closes handle and deletes `agnostr-amail-db`.
   */
  async wipeDatabase(): Promise<void> {
    this.mailMap.clear()
    this.contactMap.clear()
    this.customFolderMap.clear()
    this.folderSortMode = 'manual'
    this.vaultMap.clear()
    this.tombstoneMap.clear()
    this.settings = { ...DEFAULT_AMAIL_RELAY_SETTINGS }
    this.counters = {
      totalRelayedOut: 0,
      totalDeliveredPurged: 0,
      totalExpiredPurged: 0,
    }
    this.syncTombstones = {
      deletedMessageIds: {},
      removedContactPubkeys: {},
      deletedFolderIds: {},
    }

    if (this.dbHandle) {
      try {
        this.dbHandle.close()
      } catch {
        // Ignore
      }
      this.dbHandle = null
    }
    this.dbPromise = null
    this.initialized = false

    if (typeof indexedDB !== 'undefined') {
      await new Promise<void>((resolve) => {
        try {
          const req = indexedDB.deleteDatabase(AMAIL_DB_NAME)
          req.onsuccess = () => resolve()
          req.onerror = () => resolve()
          req.onblocked = () => resolve()
        } catch {
          resolve()
        }
      })
    }
  }
}
