import type {
  IdentitySignMode,
  IdentityState,
  ProfileAccountRecord,
  ProfileNotificationSummary,
} from '../types/protocol.ts'
import { AMAIL_DB_NAME } from './amailStorage.ts'
import {
  encodeNpubSafe,
  generateFreshSeedKeypair,
  generateRandomNickname,
  parseSecretKeyInput,
} from './identity.ts'

export const PROFILES_REGISTRY_KEY = 'agnostr:v3:profiles'
export const ACTIVE_PROFILE_ID_KEY = 'agnostr:v3:active_profile_id'
export const LEGACY_AMAIL_OWNER_KEY = 'agnostr:v3:legacy_amail_owner'
export const PROFILE_NOTIFS_KEY = 'agnostr:v3:profile_notifs'

export const GLOBAL_KEYS: ReadonlySet<string> = new Set([
  PROFILES_REGISTRY_KEY,
  ACTIVE_PROFILE_ID_KEY,
  LEGACY_AMAIL_OWNER_KEY,
  PROFILE_NOTIFS_KEY,
])

const PROFILE_VAULT_DB_NAME = 'agnostr-profile-vault-v1'
const PROFILE_VAULT_DB_VERSION = 1
const PROFILE_VAULT_STORE = 'buckets'
const FALLBACK_BUCKET_PREFIX = 'agnostr:v3:vault_fallback:'

interface StoredProfileBucket {
  id: string
  entries: Record<string, string>
  updatedAt: number
}

const memoryFallbackBuckets = new Map<string, StoredProfileBucket>()

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value.trim())
}

function normalizePubkey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const clean = raw.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(clean) ? clean : null
}

function sanitizeHttpsPicture(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed || !/^https:\/\//i.test(trimmed)) return undefined
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'https:' ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

function sanitizeSignMode(raw: unknown): IdentitySignMode {
  if (raw === 'auto' || raw === 'local' || raw === 'extension') return raw
  return 'auto'
}

function safeGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

function safeRemove(key: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(key)
  } catch {
    // Ignore storage errors
  }
}

export function isGlobalProfileVaultKey(key: string): boolean {
  return GLOBAL_KEYS.has(key) || key.startsWith(FALLBACK_BUCKET_PREFIX)
}

function isProfileScopedStorageKey(key: string): boolean {
  if (isGlobalProfileVaultKey(key)) return false
  return key.startsWith('agnostr:') || key.startsWith('agnostr_') || key === 'ephemeral_sk'
}

function triggerAppReload(): void {
  if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
    window.location.reload()
  }
}

function openVaultDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null)
  }
  return new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(PROFILE_VAULT_DB_NAME, PROFILE_VAULT_DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(PROFILE_VAULT_STORE)) {
          db.createObjectStore(PROFILE_VAULT_STORE, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function writeBucket(bucket: StoredProfileBucket): Promise<boolean> {
  memoryFallbackBuckets.set(bucket.id, bucket)
  const db = await openVaultDb()
  if (db) {
    const ok = await new Promise<boolean>((resolve) => {
      try {
        const tx = db.transaction(PROFILE_VAULT_STORE, 'readwrite')
        tx.objectStore(PROFILE_VAULT_STORE).put(bucket)
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => resolve(false)
        tx.onabort = () => resolve(false)
      } catch {
        resolve(false)
      }
    })
    try {
      db.close()
    } catch {
      // Ignore close errors
    }
    if (ok) {
      const oldFallback = `${FALLBACK_BUCKET_PREFIX}${bucket.id}`
      safeRemove(oldFallback)
      return safeGet(oldFallback) === null
    }
  }
  // Graceful fallback ONLY when IndexedDB is unavailable or failed
  const fallbackKey = `${FALLBACK_BUCKET_PREFIX}${bucket.id}`
  const serialized = JSON.stringify(bucket)
  safeSet(fallbackKey, serialized)
  // If IndexedDB exists but couldn't be written, a previous snapshot may still be there.
  return typeof indexedDB === 'undefined' && safeGet(fallbackKey) === serialized
}

async function readBucket(id: string): Promise<StoredProfileBucket | null> {
  const db = await openVaultDb()
  if (db) {
    const rec = await new Promise<StoredProfileBucket | null>((resolve) => {
      try {
        const tx = db.transaction(PROFILE_VAULT_STORE, 'readonly')
        const req = tx.objectStore(PROFILE_VAULT_STORE).get(id)
        req.onsuccess = () => {
          const val = req.result as StoredProfileBucket | undefined
          if (val && typeof val === 'object' && val.entries && typeof val.entries === 'object') {
            resolve(val)
          } else {
            resolve(null)
          }
        }
        req.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
    try {
      db.close()
    } catch {
      // Ignore close errors
    }
    if (rec) {
      memoryFallbackBuckets.set(id, rec)
      return rec
    }
  }

  const fallbackRaw = safeGet(`${FALLBACK_BUCKET_PREFIX}${id}`)
  if (fallbackRaw) {
    try {
      const parsed = JSON.parse(fallbackRaw) as StoredProfileBucket
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        memoryFallbackBuckets.set(id, parsed)
        return parsed
      }
    } catch {
      // Ignore malformed fallback JSON
    }
  }

  return memoryFallbackBuckets.get(id) ?? null
}

export async function deleteProfileVaultBucket(pubkey: string): Promise<void> {
  const pk = normalizePubkey(pubkey)
  if (!pk) return
  memoryFallbackBuckets.delete(pk)
  safeRemove(`${FALLBACK_BUCKET_PREFIX}${pk}`)

  const db = await openVaultDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(PROFILE_VAULT_STORE, 'readwrite')
      tx.objectStore(PROFILE_VAULT_STORE).delete(pk)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
  try {
    db.close()
  } catch {
    // Ignore
  }
}

async function deleteIndexedDbByName(dbName: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(dbName)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}

function collectCurrentProfileEntries(): Record<string, string> {
  const entries: Record<string, string> = {}
  if (typeof localStorage === 'undefined') return entries
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (!key || !isProfileScopedStorageKey(key)) continue
      const val = localStorage.getItem(key)
      if (typeof val === 'string') {
        entries[key] = val
      }
    }
  } catch {
    // Ignore storage enumeration errors
  }
  return entries
}

function clearActiveProfileStorage(): void {
  if (typeof localStorage !== 'undefined') {
    try {
      const toRemove: string[] = []
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)
        if (key && isProfileScopedStorageKey(key)) {
          toRemove.push(key)
        }
      }
      for (const key of toRemove) {
        localStorage.removeItem(key)
      }
    } catch {
      // Ignore storage errors
    }
  }
  if (typeof sessionStorage !== 'undefined') {
    try {
      const toRemove: string[] = []
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const key = sessionStorage.key(i)
        if (
          key &&
          (key.startsWith('agnostr:') || key.startsWith('agnostr_') || key === 'ephemeral_sk')
        ) {
          toRemove.push(key)
        }
      }
      for (const key of toRemove) {
        sessionStorage.removeItem(key)
      }
    } catch {
      // Ignore sessionStorage errors
    }
  }
}

function restoreBucketEntriesToLocalStorage(entries: Record<string, string>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (!isProfileScopedStorageKey(key)) continue
    if (typeof value === 'string') {
      safeSet(key, value)
    }
  }
}

/**
 * Returns the profile-scoped Agmail IndexedDB database name.
 * Preserves the legacy `agnostr-amail-db` database for existing single-profile users on upgrade.
 */
export function getProfileAmailDbName(masterPubkey: string): string {
  const pk = normalizePubkey(masterPubkey)
  if (!pk) return AMAIL_DB_NAME
  const legacyOwner = safeGet(LEGACY_AMAIL_OWNER_KEY)
  if (!legacyOwner) {
    safeSet(LEGACY_AMAIL_OWNER_KEY, pk)
    return AMAIL_DB_NAME
  }
  if (legacyOwner.trim().toLowerCase() === pk) {
    return AMAIL_DB_NAME
  }
  return `agnostr-amail-v2-${pk.slice(0, 16)}`
}

export function loadProfilesRegistry(): ProfileAccountRecord[] {
  const raw = safeGet(PROFILES_REGISTRY_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const out: ProfileAccountRecord[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Partial<ProfileAccountRecord>
      const pk = normalizePubkey(rec.pubkey ?? rec.id)
      if (!pk || seen.has(pk)) continue
      seen.add(pk)
      const now = Date.now()
      out.push({
        id: pk,
        pubkey: pk,
        npub:
          typeof rec.npub === 'string' && rec.npub.startsWith('npub1')
            ? rec.npub
            : encodeNpubSafe(pk),
        nickname:
          typeof rec.nickname === 'string' && rec.nickname.trim()
            ? rec.nickname.trim().slice(0, 32)
            : `anon${pk.slice(-4)}`,
        picture: sanitizeHttpsPicture(rec.picture),
        signMode: sanitizeSignMode(rec.signMode),
        createdAt:
          typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) && rec.createdAt > 0
            ? rec.createdAt
            : now,
        lastUsedAt:
          typeof rec.lastUsedAt === 'number' &&
          Number.isFinite(rec.lastUsedAt) &&
          rec.lastUsedAt > 0
            ? rec.lastUsedAt
            : now,
      })
    }
    return out
  } catch {
    return []
  }
}

export function saveProfilesRegistry(list: readonly ProfileAccountRecord[]): void {
  const seen = new Set<string>()
  const clean: ProfileAccountRecord[] = []
  for (const item of list) {
    const pk = normalizePubkey(item.pubkey ?? item.id)
    if (!pk || seen.has(pk)) continue
    seen.add(pk)
    clean.push({
      id: pk,
      pubkey: pk,
      npub: item.npub?.startsWith('npub1') ? item.npub : encodeNpubSafe(pk),
      nickname: item.nickname?.trim().slice(0, 32) || `anon${pk.slice(-4)}`,
      ...(sanitizeHttpsPicture(item.picture) ? { picture: sanitizeHttpsPicture(item.picture) } : {}),
      signMode: sanitizeSignMode(item.signMode),
      createdAt: Number.isFinite(item.createdAt) && item.createdAt > 0 ? item.createdAt : Date.now(),
      lastUsedAt:
        Number.isFinite(item.lastUsedAt) && item.lastUsedAt > 0 ? item.lastUsedAt : Date.now(),
    })
  }
  safeSet(PROFILES_REGISTRY_KEY, JSON.stringify(clean))
}

export function getActiveProfileId(): string | null {
  return normalizePubkey(safeGet(ACTIVE_PROFILE_ID_KEY))
}

export function loadProfileNotifications(): Record<string, ProfileNotificationSummary> {
  const raw = safeGet(PROFILE_NOTIFS_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, ProfileNotificationSummary> = {}
    for (const [rawPk, val] of Object.entries(parsed as Record<string, unknown>)) {
      const pk = normalizePubkey(rawPk)
      if (!pk || !val || typeof val !== 'object') continue
      const entry = val as Partial<ProfileNotificationSummary>
      const unreadCount =
        typeof entry.unreadCount === 'number' && Number.isFinite(entry.unreadCount)
          ? Math.max(0, Math.floor(entry.unreadCount))
          : 0
      const lastNotifAt =
        typeof entry.lastNotifAt === 'number' && Number.isFinite(entry.lastNotifAt)
          ? Math.max(0, Math.floor(entry.lastNotifAt))
          : 0
      const lastCheckedAt =
        typeof entry.lastCheckedAt === 'number' && Number.isFinite(entry.lastCheckedAt)
          ? Math.max(0, Math.floor(entry.lastCheckedAt))
          : 0
      const lastSummary =
        typeof entry.lastSummary === 'string' && entry.lastSummary.trim()
          ? entry.lastSummary.trim().slice(0, 120)
          : undefined
      out[pk] = {
        unreadCount,
        lastNotifAt,
        ...(lastSummary ? { lastSummary } : {}),
        lastCheckedAt,
      }
    }
    return out
  } catch {
    return {}
  }
}

export function saveProfileNotifications(
  map: Record<string, ProfileNotificationSummary>
): void {
  const clean: Record<string, ProfileNotificationSummary> = {}
  for (const [rawPk, entry] of Object.entries(map)) {
    const pk = normalizePubkey(rawPk)
    if (!pk || !entry || typeof entry !== 'object') continue
    const lastSummary =
      typeof entry.lastSummary === 'string' && entry.lastSummary.trim()
        ? entry.lastSummary.trim().slice(0, 120)
        : undefined
    clean[pk] = {
      unreadCount: Math.max(0, Math.floor(Number(entry.unreadCount) || 0)),
      lastNotifAt: Math.max(0, Math.floor(Number(entry.lastNotifAt) || 0)),
      ...(lastSummary ? { lastSummary } : {}),
      lastCheckedAt: Math.max(0, Math.floor(Number(entry.lastCheckedAt) || 0)),
    }
  }
  safeSet(PROFILE_NOTIFS_KEY, JSON.stringify(clean))
}

export function recordInactiveProfileNotification(
  pubkey: string,
  summary: string,
  eventTsSec?: number
): Record<string, ProfileNotificationSummary> {
  const pk = normalizePubkey(pubkey)
  const map = loadProfileNotifications()
  if (!pk) return map
  const nowSec = Math.floor(Date.now() / 1000)
  const tsSec =
    typeof eventTsSec === 'number' && Number.isFinite(eventTsSec) && eventTsSec > 0
      ? Math.floor(eventTsSec)
      : nowSec
  const prev = map[pk]
  const cleanSummary = summary.trim().slice(0, 120) || 'New activity'
  const next: Record<string, ProfileNotificationSummary> = {
    ...map,
    [pk]: {
      unreadCount: (prev?.unreadCount ?? 0) + 1,
      lastNotifAt: Math.max(prev?.lastNotifAt ?? 0, tsSec),
      lastSummary: cleanSummary,
      lastCheckedAt: prev?.lastCheckedAt ?? nowSec,
    },
  }
  saveProfileNotifications(next)
  return next
}

export function markProfileChecked(
  pubkey: string,
  nowSec = Math.floor(Date.now() / 1000)
): Record<string, ProfileNotificationSummary> {
  const pk = normalizePubkey(pubkey)
  const map = loadProfileNotifications()
  if (!pk) return map
  const prev = map[pk]
  const next: Record<string, ProfileNotificationSummary> = {
    ...map,
    [pk]: {
      unreadCount: 0,
      lastNotifAt: prev?.lastNotifAt ?? 0,
      lastCheckedAt: Math.max(prev?.lastCheckedAt ?? 0, Math.floor(nowSec)),
    },
  }
  saveProfileNotifications(next)
  return next
}

export function clearProfileNotificationEntry(
  pubkey: string
): Record<string, ProfileNotificationSummary> {
  const pk = normalizePubkey(pubkey)
  const map = loadProfileNotifications()
  if (!pk || !(pk in map)) return map
  const next = { ...map }
  delete next[pk]
  saveProfileNotifications(next)
  return next
}

export async function snapshotCurrentProfileToVault(
  activePubkey: string,
  requiredEntry?: readonly [key: string, value: string],
): Promise<boolean> {
  const pk = normalizePubkey(activePubkey)
  if (!pk) return false
  const entries = collectCurrentProfileEntries()
  if (requiredEntry && (getActiveProfileId() !== pk || entries[requiredEntry[0]] !== requiredEntry[1])) {
    return false
  }
  return await writeBucket({
    id: pk,
    entries,
    updatedAt: Date.now(),
  })
}

export function bootstrapActiveProfile(
  identity: IdentityState,
  picture?: string
): ProfileAccountRecord[] {
  const pk = normalizePubkey(identity.masterPubkey)
  if (!pk) return loadProfilesRegistry()

  if (!safeGet(LEGACY_AMAIL_OWNER_KEY)) {
    safeSet(LEGACY_AMAIL_OWNER_KEY, pk)
  }

  const now = Date.now()
  const list = loadProfilesRegistry()
  const idx = list.findIndex((p) => p.id === pk)
  const cleanPicture = sanitizeHttpsPicture(picture)
  const cleanNick = identity.nickname.trim().slice(0, 32) || `anon${pk.slice(-4)}`

  let next: ProfileAccountRecord[]
  if (idx >= 0) {
    const existing = list[idx]
    const updated: ProfileAccountRecord = {
      ...existing,
      id: pk,
      pubkey: pk,
      npub: identity.masterNpub || encodeNpubSafe(pk),
      nickname: cleanNick,
      picture: cleanPicture ?? existing.picture,
      signMode: sanitizeSignMode(identity.signMode),
      lastUsedAt: now,
    }
    next = [...list]
    next[idx] = updated
  } else {
    next = [
      ...list,
      {
        id: pk,
        pubkey: pk,
        npub: identity.masterNpub || encodeNpubSafe(pk),
        nickname: cleanNick,
        ...(cleanPicture ? { picture: cleanPicture } : {}),
        signMode: sanitizeSignMode(identity.signMode),
        createdAt: now,
        lastUsedAt: now,
      },
    ]
  }

  saveProfilesRegistry(next)
  safeSet(ACTIVE_PROFILE_ID_KEY, pk)
  markProfileChecked(pk)
  void snapshotCurrentProfileToVault(pk)
  return next
}

export function syncActiveProfileMetadata(patch: {
  pubkey: string
  npub: string
  nickname: string
  picture?: string | null
  signMode: IdentitySignMode
  prevPubkey?: string
}): ProfileAccountRecord[] {
  const pk = normalizePubkey(patch.pubkey)
  if (!pk) return loadProfilesRegistry()

  const prevPk = normalizePubkey(patch.prevPubkey)
  const now = Date.now()
  let list = loadProfilesRegistry()

  let preservedCreatedAt = now
  let preservedPicture: string | undefined
  if (prevPk && prevPk !== pk) {
    const prevRec = list.find((p) => p.id === prevPk)
    if (prevRec) {
      preservedCreatedAt = prevRec.createdAt
      preservedPicture = prevRec.picture
    }
    list = list.filter((p) => p.id !== prevPk)
    void deleteProfileVaultBucket(prevPk)
  }

  const existingIdx = list.findIndex((p) => p.id === pk)
  const existing = existingIdx >= 0 ? list[existingIdx] : undefined
  const hasExplicitPicture = Object.prototype.hasOwnProperty.call(patch, 'picture')
  const resolvedPicture = hasExplicitPicture
    ? sanitizeHttpsPicture(patch.picture)
    : (existing?.picture ?? preservedPicture)

  const record: ProfileAccountRecord = {
    id: pk,
    pubkey: pk,
    npub: patch.npub?.startsWith('npub1') ? patch.npub : encodeNpubSafe(pk),
    nickname: patch.nickname.trim().slice(0, 32) || existing?.nickname || `anon${pk.slice(-4)}`,
    ...(resolvedPicture ? { picture: resolvedPicture } : {}),
    signMode: sanitizeSignMode(patch.signMode),
    createdAt: existing?.createdAt ?? preservedCreatedAt,
    lastUsedAt: now,
  }

  const next = [...list]
  if (existingIdx >= 0) {
    next[existingIdx] = record
  } else {
    next.push(record)
  }

  saveProfilesRegistry(next)
  safeSet(ACTIVE_PROFILE_ID_KEY, pk)
  return next
}

export async function switchToProfile(
  currentPubkey: string,
  targetPubkey: string
): Promise<boolean> {
  const curPk = normalizePubkey(currentPubkey)
  const tgtPk = normalizePubkey(targetPubkey)
  if (!tgtPk) return false
  if (curPk === tgtPk) return true

  const list = loadProfilesRegistry()
  const targetIdx = list.findIndex((p) => p.id === tgtPk)
  const targetBucket = await readBucket(tgtPk)
  if (targetIdx < 0 && !targetBucket) return false

  if (curPk) {
    markProfileChecked(curPk)
    await snapshotCurrentProfileToVault(curPk)
  }

  clearActiveProfileStorage()
  if (targetBucket) {
    restoreBucketEntriesToLocalStorage(targetBucket.entries)
  }

  const now = Date.now()
  if (targetIdx >= 0) {
    const next = [...list]
    next[targetIdx] = { ...next[targetIdx], lastUsedAt: now }
    saveProfilesRegistry(next)
  }
  safeSet(ACTIVE_PROFILE_ID_KEY, tgtPk)
  markProfileChecked(tgtPk)
  triggerAppReload()
  return true
}

function seedFreshAutoProfileLocalStorage(
  deviceSeedHex: string,
  nickname: string
): void {
  safeSet('agnostr:v2:device_seed', deviceSeedHex)
  safeSet('agnostr:v2:sign_mode', 'auto')
  safeSet('agnostr:v2:nickname', nickname)
}

export async function createAndSwitchProfile(
  currentPubkey: string,
  opts?: { nickname?: string }
): Promise<ProfileAccountRecord> {
  const curPk = normalizePubkey(currentPubkey)
  if (curPk) {
    markProfileChecked(curPk)
    await snapshotCurrentProfileToVault(curPk)
  }

  const { deviceSeedHex, pubkey, npub } = generateFreshSeedKeypair()
  const nick = opts?.nickname?.trim().slice(0, 24) || generateRandomNickname()
  const now = Date.now()

  clearActiveProfileStorage()
  seedFreshAutoProfileLocalStorage(deviceSeedHex, nick)

  const record: ProfileAccountRecord = {
    id: pubkey,
    pubkey,
    npub,
    nickname: nick,
    signMode: 'auto',
    createdAt: now,
    lastUsedAt: now,
  }

  const list = loadProfilesRegistry().filter((p) => p.id !== pubkey)
  saveProfilesRegistry([...list, record])
  safeSet(ACTIVE_PROFILE_ID_KEY, pubkey)
  markProfileChecked(pubkey)
  await snapshotCurrentProfileToVault(pubkey)
  triggerAppReload()
  return record
}

export async function importAndSwitchProfile(
  currentPubkey: string,
  secretInput: string,
  opts?: { nickname?: string }
): Promise<{ ok: boolean; error?: string; profile?: ProfileAccountRecord }> {
  const parsed = parseSecretKeyInput(secretInput)
  if (!parsed) {
    return { ok: false, error: 'Invalid nsec or 64-character hex private key.' }
  }

  const curPk = normalizePubkey(currentPubkey)
  const list = loadProfilesRegistry()
  const existing = list.find((p) => p.id === parsed.pubkey)

  if (existing) {
    if (curPk === parsed.pubkey) {
      return { ok: true, profile: existing }
    }
    await switchToProfile(curPk ?? '', parsed.pubkey)
    return { ok: true, profile: existing }
  }

  if (curPk) {
    markProfileChecked(curPk)
    await snapshotCurrentProfileToVault(curPk)
  }

  const nick = opts?.nickname?.trim().slice(0, 24) || generateRandomNickname()
  const now = Date.now()

  clearActiveProfileStorage()
  safeSet('agnostr:v2:device_seed', parsed.secretKeyHex)
  safeSet('agnostr:v2:local_secret', parsed.secretKeyHex)
  safeSet('agnostr:v2:sign_mode', 'local')
  safeSet('agnostr:v2:nickname', nick)

  const record: ProfileAccountRecord = {
    id: parsed.pubkey,
    pubkey: parsed.pubkey,
    npub: parsed.npub,
    nickname: nick,
    signMode: 'local',
    createdAt: now,
    lastUsedAt: now,
  }

  saveProfilesRegistry([...list, record])
  safeSet(ACTIVE_PROFILE_ID_KEY, parsed.pubkey)
  markProfileChecked(parsed.pubkey)
  await snapshotCurrentProfileToVault(parsed.pubkey)
  triggerAppReload()
  return { ok: true, profile: record }
}

export async function deleteStoredProfile(
  currentPubkey: string,
  targetPubkey: string
): Promise<{ deleted: boolean; reloaded: boolean; profiles: ProfileAccountRecord[] }> {
  const curPk = normalizePubkey(currentPubkey)
  const tgtPk = normalizePubkey(targetPubkey)
  const list = loadProfilesRegistry()
  if (!tgtPk || !list.some((p) => p.id === tgtPk)) {
    return { deleted: false, reloaded: false, profiles: list }
  }

  const amailDbName = getProfileAmailDbName(tgtPk)
  const remaining = list.filter((p) => p.id !== tgtPk)
  saveProfilesRegistry(remaining)
  clearProfileNotificationEntry(tgtPk)

  if (safeGet(LEGACY_AMAIL_OWNER_KEY)?.trim().toLowerCase() === tgtPk) {
    // Sentinel prevents any other profile from reclaiming the deleted legacy DB slot
    safeSet(LEGACY_AMAIL_OWNER_KEY, '__deleted__')
  }

  await deleteProfileVaultBucket(tgtPk)
  await deleteIndexedDbByName(amailDbName)

  if (tgtPk !== curPk) {
    return { deleted: true, reloaded: false, profiles: remaining }
  }

  // Deleting the currently active profile: switch to most recently used remaining profile, or create a fresh one
  if (remaining.length > 0) {
    const nextProfile = [...remaining].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]
    const nextBucket = await readBucket(nextProfile.id)
    clearActiveProfileStorage()
    if (nextBucket) {
      restoreBucketEntriesToLocalStorage(nextBucket.entries)
    }
    const now = Date.now()
    const updatedRemaining = remaining.map((p) =>
      p.id === nextProfile.id ? { ...p, lastUsedAt: now } : p
    )
    saveProfilesRegistry(updatedRemaining)
    safeSet(ACTIVE_PROFILE_ID_KEY, nextProfile.id)
    markProfileChecked(nextProfile.id)
    triggerAppReload()
    return { deleted: true, reloaded: true, profiles: updatedRemaining }
  }

  const { deviceSeedHex, pubkey, npub } = generateFreshSeedKeypair()
  const nick = generateRandomNickname()
  const now = Date.now()
  clearActiveProfileStorage()
  seedFreshAutoProfileLocalStorage(deviceSeedHex, nick)

  const freshRecord: ProfileAccountRecord = {
    id: pubkey,
    pubkey,
    npub,
    nickname: nick,
    signMode: 'auto',
    createdAt: now,
    lastUsedAt: now,
  }
  saveProfilesRegistry([freshRecord])
  safeSet(ACTIVE_PROFILE_ID_KEY, pubkey)
  markProfileChecked(pubkey)
  await snapshotCurrentProfileToVault(pubkey)
  triggerAppReload()
  return { deleted: true, reloaded: true, profiles: [freshRecord] }
}

export { isHex64 as isValidProfileId }
