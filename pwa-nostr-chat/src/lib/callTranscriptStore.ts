/**
 * Persistent local storage, 30-day retention pruning, finalize-only SHA-256
 * hashing, and commutative CRDT sync merge for Agnostr call transcripts.
 *
 * Key starts with `agnostr:` so profileVault.ts automatically scopes it per
 * active profile and panicWipeStorage() clears it completely.
 */

import { sha256 } from '@noble/hashes/sha256'
import {
  CALL_TRANSCRIPT_RETENTION_DAYS,
  type CallTranscriptSyncDigest,
  type CallTranscriptSyncPayload,
  type LiveCaptionEntry,
  type SavedCallTranscript,
} from '../types/transcription.ts'
import { bytesToHex } from './identity.ts'

export const CALL_TRANSCRIPTS_STORAGE_KEY = 'agnostr:v2:call_transcripts'
export const CALL_TRANSCRIPT_DRAFT_KEY = 'agnostr:v2:call_transcript_draft'
export const CALL_TRANSCRIPT_TTL_MS = CALL_TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000
export const MAX_SAVED_CALL_TRANSCRIPTS = 60

export interface CallTranscriptCrashDraft {
  v: 1
  callId: string
  callTitle: string
  startedAt: number
  updatedAt: number
  modelLabel: string
  hfModelId: string
  entries: LiveCaptionEntry[]
}

const MAX_ENTRIES_PER_TRANSCRIPT = 500
const MAX_TOMBSTONES = 240
const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const COLLECTION_HASH_HEX_RE = /^[0-9a-f]{32}$/

const textEncoder = new TextEncoder()

export interface CallTranscriptHashInput {
  id: string
  callId: string
  callTitle: string
  startedAt: number
  endedAt: number
  modelLabel: string
  hfModelId: string
  entries: readonly LiveCaptionEntry[]
}

export interface FinalizedCallTranscriptDraft {
  id?: string
  callId: string
  callTitle: string
  startedAt: number
  endedAt: number
  modelLabel: string
  hfModelId: string
  entries: readonly LiveCaptionEntry[]
}

export interface CallTranscriptFormatInput {
  callTitle: string
  startedAt: number
  endedAt: number
  modelLabel: string
  hfModelId: string
  entries: readonly LiveCaptionEntry[]
}

export interface CallTranscriptArtifact {
  filename: string
  markdown: string
  plainText: string
}

export function makeCallTranscriptId(callId: string): string {
  const clean = String(callId || '')
    .trim()
    .replace(/[^a-zA-Z0-9:_-]/g, '_')
    .slice(0, 96)
  if (!clean) return 'call:session'
  return clean.startsWith('call:') ? clean : `call:${clean}`
}

function normalizeTimestamp(raw: unknown, fallback = 0): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return fallback
  return Math.floor(raw)
}

function sanitizeCaptionEntry(raw: unknown): LiveCaptionEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const text = typeof r.text === 'string' ? r.text.trim() : ''
  if (!text) return null
  const timestamp = normalizeTimestamp(r.timestamp, 0)
  const pubkey = typeof r.pubkey === 'string' ? r.pubkey.trim().slice(0, 128) : ''
  const nickname = typeof r.nickname === 'string' ? r.nickname.trim().slice(0, 120) : ''
  const displayHandle =
    typeof r.displayHandle === 'string' && r.displayHandle.trim()
      ? r.displayHandle.trim().slice(0, 140)
      : nickname || pubkey.slice(0, 12) || 'Speaker'
  const id =
    typeof r.id === 'string' && r.id.trim()
      ? r.id.trim().slice(0, 128)
      : `${timestamp}:${pubkey.slice(0, 16)}:${text.slice(0, 24)}`
  return {
    id,
    pubkey,
    nickname: nickname || displayHandle,
    displayHandle,
    isSelf: Boolean(r.isSelf),
    text: text.slice(0, 4000),
    timestamp,
  }
}

function dedupeAndSortEntries(entries: readonly LiveCaptionEntry[]): LiveCaptionEntry[] {
  // Sort deterministically first so semantic deduplication is strictly commutative across devices
  const ordered = [...entries]
    .filter((entry) => Boolean(entry.text))
    .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))

  const byId = new Set<string>()
  const bySemantic = new Set<string>()
  const list: LiveCaptionEntry[] = []

  for (const entry of ordered) {
    if (byId.has(entry.id)) continue
    const semKey = `${entry.timestamp}|${entry.pubkey.toLowerCase()}|${entry.text}`
    if (bySemantic.has(semKey)) continue
    byId.add(entry.id)
    bySemantic.add(semKey)
    list.push(entry)
  }

  return list.length > MAX_ENTRIES_PER_TRANSCRIPT
    ? list.slice(-MAX_ENTRIES_PER_TRANSCRIPT)
    : list
}

function sanitizeTranscript(
  raw: unknown,
  opts: { verifyProvidedHash: boolean; fallbackNowMs: number }
): SavedCallTranscript | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const callId =
    typeof r.callId === 'string' && r.callId.trim()
      ? r.callId.trim().slice(0, 96)
      : typeof r.id === 'string' && r.id.trim()
        ? r.id.trim().replace(/^call:/, '').slice(0, 96)
        : ''
  if (!callId) return null

  const id =
    typeof r.id === 'string' && r.id.trim()
      ? makeCallTranscriptId(r.id.trim())
      : makeCallTranscriptId(callId)

  if (!Array.isArray(r.entries)) return null
  const cleanEntries: LiveCaptionEntry[] = []
  for (const item of r.entries) {
    const clean = sanitizeCaptionEntry(item)
    if (clean) cleanEntries.push(clean)
  }
  const entries = dedupeAndSortEntries(cleanEntries)
  if (entries.length === 0) return null

  const firstTs = entries[0]?.timestamp ?? opts.fallbackNowMs
  const lastTs = entries[entries.length - 1]?.timestamp ?? firstTs
  const startedAt = normalizeTimestamp(r.startedAt, firstTs)
  const endedAt = Math.max(startedAt, normalizeTimestamp(r.endedAt, lastTs))
  const savedAt = normalizeTimestamp(r.savedAt, endedAt || opts.fallbackNowMs)
  const rawExpiresAt = normalizeTimestamp(r.expiresAt, 0)
  const maxAllowedExpires = savedAt + CALL_TRANSCRIPT_TTL_MS
  const expiresAt =
    rawExpiresAt > 0 ? Math.min(rawExpiresAt, maxAllowedExpires) : maxAllowedExpires

  const callTitle =
    typeof r.callTitle === 'string' && r.callTitle.trim()
      ? r.callTitle.trim().slice(0, 160)
      : 'Call'
  const modelLabel =
    typeof r.modelLabel === 'string' && r.modelLabel.trim()
      ? r.modelLabel.trim().slice(0, 120)
      : 'Local Whisper'
  const hfModelId =
    typeof r.hfModelId === 'string' ? r.hfModelId.trim().slice(0, 180) : ''

  const hashInput: CallTranscriptHashInput = {
    id,
    callId,
    callTitle,
    startedAt,
    endedAt,
    modelLabel,
    hfModelId,
    entries,
  }
  const expectedHash = computeCallTranscriptContentHash(hashInput)

  const providedHash =
    typeof r.contentHash === 'string' ? r.contentHash.trim().toLowerCase() : ''

  if (providedHash) {
    if (!SHA256_HEX_RE.test(providedHash)) {
      if (opts.verifyProvidedHash) return null
    } else if (opts.verifyProvidedHash && providedHash !== expectedHash) {
      return null
    }
  }

  return {
    id,
    callId,
    callTitle,
    startedAt,
    endedAt,
    savedAt,
    expiresAt,
    modelLabel,
    hfModelId,
    entries,
    contentHash: expectedHash,
  }
}

function sanitizeDeletedMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = k.trim()
    if (!id || id.length > 128) continue
    const ts = normalizeTimestamp(v, 0)
    if (ts > 0) {
      out[id] = ts
    }
  }
  return out
}

export function computeCallTranscriptContentHash(input: CallTranscriptHashInput): string {
  const canonical = JSON.stringify([
    input.id,
    input.callId,
    input.callTitle,
    input.startedAt,
    input.endedAt,
    input.modelLabel,
    input.hfModelId,
    input.entries.map((e) => [
      e.id,
      e.pubkey,
      e.nickname,
      e.displayHandle,
      e.isSelf,
      e.text,
      e.timestamp,
    ]),
  ])
  return bytesToHex(sha256(textEncoder.encode(canonical)))
}

export function computeCallTranscriptCollectionHash(
  transcripts: readonly Pick<SavedCallTranscript, 'id' | 'contentHash'>[],
  deleted: Readonly<Record<string, number>>
): string {
  const manifest: string[] = []
  const sortedTranscripts = [...transcripts].sort((a, b) => a.id.localeCompare(b.id))
  for (const t of sortedTranscripts) {
    manifest.push(`t:${t.id}:${t.contentHash}`)
  }
  const sortedDeletedKeys = Object.keys(deleted).sort()
  for (const id of sortedDeletedKeys) {
    const ts = deleted[id]
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
      manifest.push(`d:${id}:${Math.floor(ts)}`)
    }
  }
  return bytesToHex(sha256(textEncoder.encode(JSON.stringify(manifest)))).slice(0, 32)
}

export function createEmptyCallTranscriptStore(): CallTranscriptSyncPayload {
  return {
    v: 1,
    updatedAt: 0,
    collectionHash: computeCallTranscriptCollectionHash([], {}),
    transcripts: [],
    deleted: {},
  }
}

function isTranscriptExpired(t: SavedCallTranscript, nowMs: number): boolean {
  const baseline = Math.max(t.savedAt, t.endedAt)
  if (nowMs - baseline > CALL_TRANSCRIPT_TTL_MS) return true
  if (t.expiresAt <= nowMs) return true
  return false
}

function compareTranscriptsNewestFirst(a: SavedCallTranscript, b: SavedCallTranscript): number {
  return b.endedAt - a.endedAt || b.savedAt - a.savedAt || a.id.localeCompare(b.id)
}

export function pruneExpiredCallTranscriptStore(
  store: CallTranscriptSyncPayload,
  nowMs = Date.now()
): { store: CallTranscriptSyncPayload; changed: boolean } {
  let changed = false

  // 1. Prune tombstones older than 30 days
  const liveDeletedEntries: Array<[string, number]> = []
  for (const [id, rawTs] of Object.entries(store.deleted)) {
    const ts = normalizeTimestamp(rawTs, 0)
    if (ts <= 0 || nowMs - ts > CALL_TRANSCRIPT_TTL_MS) {
      changed = true
      continue
    }
    liveDeletedEntries.push([id, ts])
  }

  // Cap tombstones to MAX_TOMBSTONES (newest first)
  if (liveDeletedEntries.length > MAX_TOMBSTONES) {
    liveDeletedEntries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    liveDeletedEntries.length = MAX_TOMBSTONES
    changed = true
  }

  const nextDeleted: Record<string, number> = {}
  for (const [id, ts] of liveDeletedEntries) {
    nextDeleted[id] = ts
  }

  // 2. Drop expired transcripts and any transcript superseded by a tombstone
  const seenIds = new Set<string>()
  const surviving: SavedCallTranscript[] = []
  for (const t of store.transcripts) {
    if (seenIds.has(t.id)) {
      changed = true
      continue
    }
    if (isTranscriptExpired(t, nowMs)) {
      changed = true
      continue
    }
    const tombTs = nextDeleted[t.id]
    const itemTs = Math.max(t.savedAt, t.endedAt)
    if (tombTs !== undefined && tombTs >= itemTs) {
      changed = true
      continue
    }
    if (tombTs !== undefined && tombTs < itemTs) {
      delete nextDeleted[t.id]
      changed = true
    }
    seenIds.add(t.id)
    surviving.push(t)
  }

  // 3. Sort newest first and cap to MAX_SAVED_CALL_TRANSCRIPTS
  const sorted = [...surviving].sort(compareTranscriptsNewestFirst)
  if (sorted.length !== store.transcripts.length) {
    changed = true
  } else {
    for (let i = 0; i < sorted.length; i += 1) {
      if (sorted[i].id !== store.transcripts[i].id) {
        changed = true
        break
      }
    }
  }

  const capped =
    sorted.length > MAX_SAVED_CALL_TRANSCRIPTS
      ? sorted.slice(0, MAX_SAVED_CALL_TRANSCRIPTS)
      : sorted
  if (capped.length !== sorted.length) {
    changed = true
  }

  const needsHash = changed || !COLLECTION_HASH_HEX_RE.test(store.collectionHash)
  if (!needsHash) {
    return { store, changed: false }
  }

  const nextHash = computeCallTranscriptCollectionHash(capped, nextDeleted)
  const nextStore: CallTranscriptSyncPayload = {
    v: 1,
    updatedAt: changed ? Math.max(store.updatedAt, nowMs) : store.updatedAt,
    collectionHash: nextHash,
    transcripts: capped,
    deleted: nextDeleted,
  }

  return { store: nextStore, changed }
}

export function saveCallTranscriptStore(
  store: CallTranscriptSyncPayload
): CallTranscriptSyncPayload {
  if (typeof window === 'undefined' || !window.localStorage) return store

  let candidate = store
  while (true) {
    try {
      window.localStorage.setItem(CALL_TRANSCRIPTS_STORAGE_KEY, JSON.stringify(candidate))
      return candidate
    } catch {
      // Handle QuotaExceededError cleanly by evicting the oldest transcript
      if (candidate.transcripts.length === 0) {
        return candidate
      }
      const trimmed = candidate.transcripts.slice(0, -1)
      candidate = {
        ...candidate,
        transcripts: trimmed,
        collectionHash: computeCallTranscriptCollectionHash(trimmed, candidate.deleted),
      }
    }
  }
}

export function loadCallTranscriptStore(nowMs = Date.now()): CallTranscriptSyncPayload {
  if (typeof window === 'undefined' || !window.localStorage) {
    return createEmptyCallTranscriptStore()
  }

  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(CALL_TRANSCRIPTS_STORAGE_KEY)
  } catch {
    return createEmptyCallTranscriptStore()
  }
  if (!raw) return createEmptyCallTranscriptStore()

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return createEmptyCallTranscriptStore()
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return createEmptyCallTranscriptStore()
  }

  const obj = parsed as Record<string, unknown>
  const rawTranscripts = Array.isArray(obj.transcripts) ? obj.transcripts : []
  const transcripts: SavedCallTranscript[] = []
  let sanitizedChanged = false

  for (const item of rawTranscripts) {
    const clean = sanitizeTranscript(item, {
      verifyProvidedHash: false,
      fallbackNowMs: nowMs,
    })
    if (clean) {
      transcripts.push(clean)
    } else {
      sanitizedChanged = true
    }
  }

  const deleted = sanitizeDeletedMap(obj.deleted)
  const rawCollectionHash =
    typeof obj.collectionHash === 'string' ? obj.collectionHash.trim().toLowerCase() : ''
  const initialStore: CallTranscriptSyncPayload = {
    v: 1,
    updatedAt: normalizeTimestamp(obj.updatedAt, 0),
    collectionHash: COLLECTION_HASH_HEX_RE.test(rawCollectionHash)
      ? rawCollectionHash
      : computeCallTranscriptCollectionHash(transcripts, deleted),
    transcripts,
    deleted,
  }

  const { store: pruned, changed } = pruneExpiredCallTranscriptStore(initialStore, nowMs)
  if (changed || sanitizedChanged || !COLLECTION_HASH_HEX_RE.test(rawCollectionHash)) {
    return saveCallTranscriptStore(pruned)
  }
  return pruned
}

export function clearCallTranscriptStore(): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.removeItem(CALL_TRANSCRIPTS_STORAGE_KEY)
  } catch {
    // Ignore storage removal errors
  }
}

/**
 * Crash-safe unhashed draft journal written during an active call.
 * Performs ZERO SHA-256 hashing; handles QuotaExceededError by keeping the latest entries.
 */
export function saveCallTranscriptDraft(draft: CallTranscriptCrashDraft): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  if (!draft.callId || draft.entries.length === 0) return

  let entries =
    draft.entries.length > MAX_ENTRIES_PER_TRANSCRIPT
      ? draft.entries.slice(-MAX_ENTRIES_PER_TRANSCRIPT)
      : draft.entries

  while (entries.length > 0) {
    const candidate: CallTranscriptCrashDraft = {
      ...draft,
      v: 1,
      entries,
    }
    try {
      window.localStorage.setItem(CALL_TRANSCRIPT_DRAFT_KEY, JSON.stringify(candidate))
      return
    } catch {
      if (entries.length <= 1) return
      entries = entries.slice(Math.ceil(entries.length / 2))
    }
  }
}

export function loadCallTranscriptDraft(): CallTranscriptCrashDraft | null {
  if (typeof window === 'undefined' || !window.localStorage) return null

  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(CALL_TRANSCRIPT_DRAFT_KEY)
  } catch {
    return null
  }
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const r = parsed as Record<string, unknown>
  if (r.v !== 1) return null

  const callId = typeof r.callId === 'string' ? r.callId.trim().slice(0, 96) : ''
  if (!callId) return null

  if (!Array.isArray(r.entries)) return null
  const cleanEntries: LiveCaptionEntry[] = []
  for (const item of r.entries) {
    const clean = sanitizeCaptionEntry(item)
    if (clean) cleanEntries.push(clean)
  }
  const entries = dedupeAndSortEntries(cleanEntries)
  if (entries.length === 0) return null

  const firstTs = entries[0]?.timestamp ?? Date.now()
  const lastTs = entries[entries.length - 1]?.timestamp ?? firstTs
  const startedAt = normalizeTimestamp(r.startedAt, firstTs)
  const updatedAt = Math.max(startedAt, normalizeTimestamp(r.updatedAt, lastTs))

  return {
    v: 1,
    callId,
    callTitle:
      typeof r.callTitle === 'string' && r.callTitle.trim()
        ? r.callTitle.trim().slice(0, 160)
        : 'Call',
    startedAt,
    updatedAt,
    modelLabel:
      typeof r.modelLabel === 'string' && r.modelLabel.trim()
        ? r.modelLabel.trim().slice(0, 120)
        : 'Local Whisper',
    hfModelId: typeof r.hfModelId === 'string' ? r.hfModelId.trim().slice(0, 180) : '',
    entries,
  }
}

export function clearCallTranscriptDraft(): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.removeItem(CALL_TRANSCRIPT_DRAFT_KEY)
  } catch {
    // Ignore storage removal errors
  }
}

/**
 * Boot-time crash recovery: if an unfinalized call draft survived a tab crash / OS kill,
 * finalize it ONCE (computing SHA-256 contentHash), commit durably to the 30-day store,
 * and clear the draft journal.
 */
export function recoverCrashDraftIntoStore(
  store: CallTranscriptSyncPayload,
  nowMs = Date.now()
): { store: CallTranscriptSyncPayload; recovered: SavedCallTranscript | null } {
  const draft = loadCallTranscriptDraft()
  if (!draft || draft.entries.length === 0) {
    clearCallTranscriptDraft()
    return { store, recovered: null }
  }

  const lastEntryTs = draft.entries[draft.entries.length - 1]?.timestamp ?? draft.startedAt
  const endedAt = Math.max(draft.startedAt, draft.updatedAt, lastEntryTs)

  const res = upsertFinalizedCallTranscript(
    store,
    {
      callId: draft.callId,
      callTitle: draft.callTitle,
      startedAt: draft.startedAt,
      endedAt,
      modelLabel: draft.modelLabel,
      hfModelId: draft.hfModelId,
      entries: draft.entries,
    },
    nowMs
  )

  if (!res.saved) {
    clearCallTranscriptDraft()
    return { store: res.store, recovered: null }
  }

  // Crash-safe commit order: write durable store FIRST, then clear the WAL draft
  const persisted = saveCallTranscriptStore(res.store)
  clearCallTranscriptDraft()
  return { store: persisted, recovered: res.saved }
}

export function upsertFinalizedCallTranscript(
  store: CallTranscriptSyncPayload,
  draft: FinalizedCallTranscriptDraft,
  nowMs = Date.now()
): { store: CallTranscriptSyncPayload; saved: SavedCallTranscript | null; changed: boolean } {
  const { store: baseStore } = pruneExpiredCallTranscriptStore(store, nowMs)

  const cleanDraftEntries: LiveCaptionEntry[] = []
  for (const entry of draft.entries) {
    const clean = sanitizeCaptionEntry(entry)
    if (clean) cleanDraftEntries.push(clean)
  }
  if (cleanDraftEntries.length === 0) {
    return { store: baseStore, saved: null, changed: false }
  }

  const callId = draft.callId.trim().slice(0, 96) || 'session'
  const id = draft.id?.trim() ? makeCallTranscriptId(draft.id.trim()) : makeCallTranscriptId(callId)
  const existing = baseStore.transcripts.find((t) => t.id === id)

  const mergedEntries = existing
    ? dedupeAndSortEntries([...existing.entries, ...cleanDraftEntries])
    : dedupeAndSortEntries(cleanDraftEntries)

  const firstTs = mergedEntries[0]?.timestamp ?? nowMs
  const lastTs = mergedEntries[mergedEntries.length - 1]?.timestamp ?? firstTs
  const draftStarted = normalizeTimestamp(draft.startedAt, firstTs)
  const startedAt = existing ? Math.min(existing.startedAt, draftStarted) : draftStarted
  const draftEnded = Math.max(startedAt, normalizeTimestamp(draft.endedAt, lastTs))
  const endedAt = existing ? Math.max(existing.endedAt, draftEnded) : draftEnded

  const callTitle = draft.callTitle.trim().slice(0, 160) || existing?.callTitle || 'Call'
  const modelLabel =
    draft.modelLabel.trim().slice(0, 120) || existing?.modelLabel || 'Local Whisper'
  const hfModelId = draft.hfModelId.trim().slice(0, 180) || existing?.hfModelId || ''

  const contentHash = computeCallTranscriptContentHash({
    id,
    callId,
    callTitle,
    startedAt,
    endedAt,
    modelLabel,
    hfModelId,
    entries: mergedEntries,
  })

  // Idempotent short-circuit if the finalized transcript content is completely unchanged
  if (existing && existing.contentHash === contentHash) {
    return { store: baseStore, saved: existing, changed: false }
  }

  const savedAt = Math.max(nowMs, endedAt)
  const saved: SavedCallTranscript = {
    id,
    callId,
    callTitle,
    startedAt,
    endedAt,
    savedAt,
    expiresAt: savedAt + CALL_TRANSCRIPT_TTL_MS,
    modelLabel,
    hfModelId,
    entries: mergedEntries,
    contentHash,
  }

  const nextDeleted = { ...baseStore.deleted }
  if (nextDeleted[id] !== undefined && nextDeleted[id] < Math.max(savedAt, endedAt)) {
    delete nextDeleted[id]
  }

  const nextTranscripts = [
    saved,
    ...baseStore.transcripts.filter((t) => t.id !== id),
  ].sort(compareTranscriptsNewestFirst)

  const candidate: CallTranscriptSyncPayload = {
    v: 1,
    updatedAt: Math.max(baseStore.updatedAt, savedAt),
    collectionHash: '',
    transcripts: nextTranscripts,
    deleted: nextDeleted,
  }

  const { store: pruned } = pruneExpiredCallTranscriptStore(candidate, nowMs)
  const finalStore: CallTranscriptSyncPayload = {
    ...pruned,
    updatedAt: Math.max(baseStore.updatedAt, savedAt),
    collectionHash: computeCallTranscriptCollectionHash(pruned.transcripts, pruned.deleted),
  }

  return { store: finalStore, saved, changed: true }
}

export function deleteSavedCallTranscriptInStore(
  store: CallTranscriptSyncPayload,
  id: string,
  nowMs = Date.now()
): { store: CallTranscriptSyncPayload; changed: boolean } {
  const cleanId = id.trim()
  if (!cleanId) return { store, changed: false }

  const existing = store.transcripts.find((t) => t.id === cleanId)
  const prevTomb = store.deleted[cleanId] ?? 0
  if (!existing && prevTomb > 0 && nowMs - prevTomb <= CALL_TRANSCRIPT_TTL_MS) {
    return { store, changed: false }
  }

  const itemMaxTs = existing ? Math.max(existing.savedAt, existing.endedAt) : 0
  const tombTs = Math.max(nowMs, itemMaxTs + 1, prevTomb)

  const nextDeleted: Record<string, number> = {
    ...store.deleted,
    [cleanId]: tombTs,
  }
  const nextTranscripts = store.transcripts.filter((t) => t.id !== cleanId)

  const { store: pruned } = pruneExpiredCallTranscriptStore(
    {
      v: 1,
      updatedAt: Math.max(store.updatedAt, tombTs),
      collectionHash: '',
      transcripts: nextTranscripts,
      deleted: nextDeleted,
    },
    nowMs
  )

  return {
    store: {
      ...pruned,
      updatedAt: Math.max(store.updatedAt, tombTs),
      collectionHash: computeCallTranscriptCollectionHash(pruned.transcripts, pruned.deleted),
    },
    changed: true,
  }
}

export function clearSavedCallTranscriptsInStore(
  store: CallTranscriptSyncPayload,
  nowMs = Date.now()
): { store: CallTranscriptSyncPayload; changed: boolean } {
  if (store.transcripts.length === 0) {
    return pruneExpiredCallTranscriptStore(store, nowMs)
  }

  const nextDeleted: Record<string, number> = { ...store.deleted }
  let maxTs = Math.max(store.updatedAt, nowMs)

  for (const t of store.transcripts) {
    const itemMaxTs = Math.max(t.savedAt, t.endedAt)
    const tombTs = Math.max(nowMs, itemMaxTs + 1, nextDeleted[t.id] ?? 0)
    nextDeleted[t.id] = tombTs
    if (tombTs > maxTs) maxTs = tombTs
  }

  const { store: pruned } = pruneExpiredCallTranscriptStore(
    {
      v: 1,
      updatedAt: maxTs,
      collectionHash: '',
      transcripts: [],
      deleted: nextDeleted,
    },
    nowMs
  )

  return {
    store: {
      ...pruned,
      updatedAt: maxTs,
      collectionHash: computeCallTranscriptCollectionHash(pruned.transcripts, pruned.deleted),
    },
    changed: true,
  }
}

function mergeTwoTranscriptVersions(
  a: SavedCallTranscript,
  b: SavedCallTranscript
): SavedCallTranscript {
  if (a.contentHash === b.contentHash) {
    const savedAt = Math.max(a.savedAt, b.savedAt)
    return {
      ...a,
      savedAt,
      expiresAt: savedAt + CALL_TRANSCRIPT_TTL_MS,
    }
  }

  // Commutative tie-breaker for scalar metadata
  const pickA =
    a.endedAt > b.endedAt ||
    (a.endedAt === b.endedAt && a.savedAt > b.savedAt) ||
    (a.endedAt === b.endedAt &&
      a.savedAt === b.savedAt &&
      a.contentHash.localeCompare(b.contentHash) >= 0)
  const winner = pickA ? a : b
  const mergedEntries = dedupeAndSortEntries([...a.entries, ...b.entries])
  const startedAt = Math.min(a.startedAt, b.startedAt)
  const endedAt = Math.max(a.endedAt, b.endedAt)
  const savedAt = Math.max(a.savedAt, b.savedAt)

  const contentHash = computeCallTranscriptContentHash({
    id: winner.id,
    callId: winner.callId,
    callTitle: winner.callTitle,
    startedAt,
    endedAt,
    modelLabel: winner.modelLabel,
    hfModelId: winner.hfModelId,
    entries: mergedEntries,
  })

  return {
    id: winner.id,
    callId: winner.callId,
    callTitle: winner.callTitle,
    startedAt,
    endedAt,
    savedAt,
    expiresAt: savedAt + CALL_TRANSCRIPT_TTL_MS,
    modelLabel: winner.modelLabel,
    hfModelId: winner.hfModelId,
    entries: mergedEntries,
    contentHash,
  }
}

export function mergeCallTranscriptSyncPayload(
  localStore: CallTranscriptSyncPayload,
  remotePayload: unknown,
  nowMs = Date.now()
): { store: CallTranscriptSyncPayload; changed: boolean; addedOrUpdatedCount: number } {
  const { store: prunedLocal, changed: localPruned } = pruneExpiredCallTranscriptStore(
    localStore,
    nowMs
  )

  if (!remotePayload || typeof remotePayload !== 'object' || Array.isArray(remotePayload)) {
    return { store: prunedLocal, changed: localPruned, addedOrUpdatedCount: 0 }
  }

  const r = remotePayload as Record<string, unknown>
  if (r.v !== 1) {
    return { store: prunedLocal, changed: localPruned, addedOrUpdatedCount: 0 }
  }

  // 1. Merge deletion tombstones (max timestamp wins; ignore expired tombstones)
  const mergedDeleted: Record<string, number> = { ...prunedLocal.deleted }
  const remoteDeleted = sanitizeDeletedMap(r.deleted)
  let deletedChanged = false

  for (const [id, ts] of Object.entries(remoteDeleted)) {
    if (nowMs - ts > CALL_TRANSCRIPT_TTL_MS) continue
    const prev = mergedDeleted[id] ?? 0
    if (ts > prev) {
      mergedDeleted[id] = ts
      deletedChanged = true
    }
  }

  // 2. Index local transcripts
  const localById = new Map<string, SavedCallTranscript>()
  const mergedById = new Map<string, SavedCallTranscript>()
  for (const t of prunedLocal.transcripts) {
    localById.set(t.id, t)
    mergedById.set(t.id, t)
  }

  // 3. Validate, verify SHA-256 hash, and merge non-expired remote transcripts
  let addedOrUpdatedCount = 0
  const remoteList = Array.isArray(r.transcripts) ? r.transcripts : []

  for (const item of remoteList) {
    const cleanRemote = sanitizeTranscript(item, {
      verifyProvidedHash: true,
      fallbackNowMs: nowMs,
    })
    if (!cleanRemote) continue
    if (isTranscriptExpired(cleanRemote, nowMs)) continue

    const tombTs = mergedDeleted[cleanRemote.id] ?? 0
    const remoteTs = Math.max(cleanRemote.savedAt, cleanRemote.endedAt)
    if (tombTs >= remoteTs) continue

    const existing = mergedById.get(cleanRemote.id)
    if (!existing) {
      mergedById.set(cleanRemote.id, cleanRemote)
      addedOrUpdatedCount += 1
    } else if (existing.contentHash !== cleanRemote.contentHash) {
      const combined = mergeTwoTranscriptVersions(existing, cleanRemote)
      mergedById.set(cleanRemote.id, combined)
      if (combined.contentHash !== existing.contentHash) {
        addedOrUpdatedCount += 1
      }
    }
  }

  // 4. Apply merged tombstones against surviving transcripts (tombstone wins if >= max(savedAt, endedAt))
  for (const [id, transcript] of Array.from(mergedById.entries())) {
    const tombTs = mergedDeleted[id]
    if (tombTs === undefined) continue
    const itemTs = Math.max(transcript.savedAt, transcript.endedAt)
    if (tombTs >= itemTs) {
      mergedById.delete(id)
      if (localById.has(id)) {
        addedOrUpdatedCount += 1
      }
    } else {
      delete mergedDeleted[id]
    }
  }

  const candidateTranscripts = Array.from(mergedById.values()).sort(compareTranscriptsNewestFirst)
  const remoteUpdatedAt = normalizeTimestamp(r.updatedAt, 0)

  const { store: prunedMerged } = pruneExpiredCallTranscriptStore(
    {
      v: 1,
      updatedAt: Math.max(prunedLocal.updatedAt, remoteUpdatedAt),
      collectionHash: '',
      transcripts: candidateTranscripts,
      deleted: mergedDeleted,
    },
    nowMs
  )

  const finalCollectionHash = computeCallTranscriptCollectionHash(
    prunedMerged.transcripts,
    prunedMerged.deleted
  )
  const contentChanged =
    finalCollectionHash !== prunedLocal.collectionHash || localPruned || deletedChanged

  if (!contentChanged) {
    return { store: prunedLocal, changed: false, addedOrUpdatedCount: 0 }
  }

  const finalStore: CallTranscriptSyncPayload = {
    v: 1,
    updatedAt: Math.max(prunedLocal.updatedAt, remoteUpdatedAt, nowMs),
    collectionHash: finalCollectionHash,
    transcripts: prunedMerged.transcripts,
    deleted: prunedMerged.deleted,
  }

  return {
    store: finalStore,
    changed: true,
    addedOrUpdatedCount,
  }
}

export function buildCallTranscriptSyncDigest(
  store: CallTranscriptSyncPayload
): CallTranscriptSyncDigest {
  const itemHashes: Record<string, string> = {}
  for (const t of store.transcripts) {
    itemHashes[t.id] = t.contentHash
  }
  return {
    count: store.transcripts.length,
    updatedAt: store.updatedAt,
    hash: store.collectionHash,
    itemHashes,
    deleted: { ...store.deleted },
  }
}

export function selectDeltaCallTranscripts(
  store: CallTranscriptSyncPayload,
  remoteKnownHashes?: Readonly<Record<string, string>>,
  remoteDeleted?: Readonly<Record<string, number>>,
  nowMs = Date.now()
): CallTranscriptSyncPayload {
  const { store: pruned } = pruneExpiredCallTranscriptStore(store, nowMs)

  const transcripts: SavedCallTranscript[] = []
  for (const t of pruned.transcripts) {
    if (remoteKnownHashes && remoteKnownHashes[t.id] === t.contentHash) {
      continue
    }
    const remoteTomb = remoteDeleted?.[t.id] ?? 0
    if (remoteTomb >= Math.max(t.savedAt, t.endedAt)) {
      continue
    }
    transcripts.push(t)
  }

  const deleted: Record<string, number> = {}
  for (const [id, ts] of Object.entries(pruned.deleted)) {
    if (!remoteDeleted || (remoteDeleted[id] ?? 0) < ts) {
      deleted[id] = ts
    }
  }

  return {
    v: 1,
    updatedAt: pruned.updatedAt,
    collectionHash: pruned.collectionHash,
    transcripts,
    deleted,
  }
}

function slugifyTitle(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42)
  return cleaned || 'call'
}

function formatClock(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatDurationClock(totalMs: number): string {
  const totalSec = Math.max(0, Math.floor(totalMs / 1000))
  const hrs = Math.floor(totalSec / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`
}

function formatIsoDate(ms: number): string {
  try {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  } catch {
    return ''
  }
}

export function formatCallTranscriptArtifact(
  opts: CallTranscriptFormatInput
): CallTranscriptArtifact {
  const stamp = new Date(opts.endedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const slug = slugifyTitle(opts.callTitle)
  const durationLabel = formatDurationClock(Math.max(0, opts.endedAt - opts.startedAt))

  const mdLines: string[] = [
    `# Agnostr Call Transcript — ${opts.callTitle}`,
    '',
    `- **Date**: ${formatIsoDate(opts.startedAt)}`,
    `- **Started**: ${formatClock(opts.startedAt)}`,
    `- **Ended**: ${formatClock(opts.endedAt)}`,
    `- **Duration**: ${durationLabel}`,
    `- **Model**: ${opts.modelLabel} (${opts.hfModelId})`,
    `- **Entries**: ${opts.entries.length}`,
    '',
    '---',
    '',
  ]

  const plainLines: string[] = []
  for (const entry of opts.entries) {
    const who = entry.isSelf ? `${entry.displayHandle} (you)` : entry.displayHandle
    const wallClock = formatClock(entry.timestamp)
    const elapsedTag =
      opts.startedAt > 0
        ? ` | +${formatDurationClock(Math.max(0, entry.timestamp - opts.startedAt))}`
        : ''
    const tsLabel = `[${wallClock}${elapsedTag}]`
    mdLines.push(`- **${tsLabel} ${who}**: ${entry.text}`)
    plainLines.push(`${tsLabel} ${who}: ${entry.text}`)
  }

  return {
    filename: `agnostr-transcript-${slug}-${stamp}.md`,
    markdown: mdLines.join('\n'),
    plainText: plainLines.join('\n'),
  }
}
