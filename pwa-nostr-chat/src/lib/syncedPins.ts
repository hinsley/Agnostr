import type { SyncedPinRecord, SyncedPinnedState } from '../types/deviceSync.ts'
import type { PinnedChannel } from '../types/protocol.ts'
import { normalizeBitchatChannelKey } from './bitchatChannel.ts'

function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function channelKey(value: unknown): string | null {
  if (typeof value !== 'string' || value === '__proto__' || value === 'constructor' || value === 'prototype') return null
  return normalizeBitchatChannelKey(value)
}

function cleanItems(items: readonly unknown[]): PinnedChannel[] {
  const seen = new Set<string>()
  return items.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Partial<PinnedChannel>
    const geohash = channelKey(raw.geohash)
    if (!geohash || seen.has(geohash)) return []
    seen.add(geohash)
    return [{ geohash, label: typeof raw.label === 'string' ? raw.label.slice(0, 48) : undefined,
      pinnedAt: timestamp(raw.pinnedAt), unreadCount: 0, mentionCount: 0 }]
  })
}

function legacyRecords(state: SyncedPinnedState): Record<string, SyncedPinRecord> {
  return Object.fromEntries(cleanItems(state.items).map(p => [
    p.geohash, { addedAt: p.pinnedAt || state.updatedAt || 1, removedAt: 0, pinnedAt: p.pinnedAt, label: p.label },
  ]))
}

function project(records: Record<string, SyncedPinRecord>, ids: string[]): PinnedChannel[] {
  const keys = [...new Set([...ids, ...Object.keys(records).sort((a,b) =>
    records[b].addedAt - records[a].addedAt || a.localeCompare(b))])]
  return keys.flatMap(geohash => {
    const r = records[geohash]
    return r && r.addedAt > r.removedAt
      ? [{ geohash, pinnedAt: r.pinnedAt, label: r.label, unreadCount: 0, mentionCount: 0 }]
      : []
  })
}

export function sanitizeSyncedPinnedState(raw: unknown): SyncedPinnedState {
  const obj = raw && typeof raw === 'object' ? raw as Partial<SyncedPinnedState> : {}
  const updatedAt = timestamp(obj.updatedAt)
  const items = cleanItems(Array.isArray(obj.items) ? obj.items : [])
  if (!obj.records || typeof obj.records !== 'object' || Array.isArray(obj.records)) return { updatedAt, items }
  const records = Object.create(null) as Record<string, SyncedPinRecord>
  for (const [key, value] of Object.entries(obj.records)) {
    const gh = channelKey(key)
    if (!gh || !value || typeof value !== 'object') continue
    const addedAt = timestamp(value.addedAt), removedAt = timestamp(value.removedAt)
    if (!addedAt && !removedAt) continue
    records[gh] = { addedAt, removedAt, pinnedAt: timestamp(value.pinnedAt),
      label: typeof value.label === 'string' ? value.label.slice(0, 48) : undefined }
  }
  const order = Array.isArray(obj.order) ? [...new Set(obj.order.map(channelKey).filter(k => k !== null))] : items.map(p => p.geohash)
  return { updatedAt, records, order, items: project(records, order) }
}

export function reconcileSyncedPins(
  previous: SyncedPinnedState,
  snapshot: readonly PinnedChannel[],
  now: number,
  initial: boolean
): SyncedPinnedState {
  const before = cleanItems(previous.items)
  const next = cleanItems(snapshot)
  const same = JSON.stringify(before) === JSON.stringify(next)
  if (same && previous.records) return previous
  const records = { ...(previous.records ?? legacyRecords(previous)) }
  const beforeKeys = new Map(before.map(item => [item.geohash, item]))
  const afterKeys = new Set(next.map(item => item.geohash))
  const ts = same ? previous.updatedAt : initial
    ? Math.max(1, previous.updatedAt, ...next.map(p => p.pinnedAt))
    : Math.max(now, previous.updatedAt + 1)
  for (const item of next) {
    const existing = records[item.geohash]
    const old = beforeKeys.get(item.geohash)
    if (!old || old.label !== item.label || old.pinnedAt !== item.pinnedAt) {
      records[item.geohash] = { addedAt: Math.max(ts, item.pinnedAt, (existing?.removedAt ?? 0) + 1),
        removedAt: existing?.removedAt ?? 0, label: item.label, pinnedAt: item.pinnedAt }
    }
  }
  if (!initial) for (const item of before) {
    if (afterKeys.has(item.geohash)) continue
    const existing = records[item.geohash]
    if (existing) records[item.geohash] = { ...existing, removedAt: Math.max(ts, existing.addedAt) }
  }
  const order = next.map(p => p.geohash)
  return { updatedAt: ts, items: project(records, order), order, records }
}

export function mergeSyncedPins(a: SyncedPinnedState, b: SyncedPinnedState): SyncedPinnedState {
  const aOrder = a.order ?? a.items.map(p => p.geohash)
  const bOrder = b.order ?? b.items.map(p => p.geohash)
  const bWins = b.updatedAt > a.updatedAt || (b.updatedAt === a.updatedAt && JSON.stringify(bOrder) > JSON.stringify(aOrder))
  const updatedAt = Math.max(a.updatedAt, b.updatedAt)
  if (!a.records && !b.records) return bWins ? b : a
  const ar = a.records ?? legacyRecords(a)
  const br = b.records ?? legacyRecords(b)
  const records = Object.create(null) as Record<string, SyncedPinRecord>
  for (const key of [...new Set([...Object.keys(ar), ...Object.keys(br)])].sort()) {
    const x = ar[key], y = br[key]
    if (!x || !y) { records[key] = x ?? y; continue }
    const dataX = JSON.stringify([x.label ?? '', x.pinnedAt]), dataY = JSON.stringify([y.label ?? '', y.pinnedAt])
    const winner = y.addedAt > x.addedAt || (y.addedAt === x.addedAt && dataY > dataX) ? y : x
    records[key] = { addedAt: winner.addedAt, removedAt: Math.max(x.removedAt, y.removedAt),
      label: winner.label, pinnedAt: winner.pinnedAt }
  }
  const order = bWins ? bOrder : aOrder
  const items = project(records, order)
  const stable = a.records && updatedAt === a.updatedAt && JSON.stringify(order) === JSON.stringify(aOrder) &&
    Object.keys(records).length === Object.keys(a.records).length && Object.entries(records).every(([k, v]) => {
      const before = a.records?.[k]
      return before && v.addedAt === before.addedAt && v.removedAt === before.removedAt && v.label === before.label && v.pinnedAt === before.pinnedAt
    })
  return stable ? a : { updatedAt, items, order, records }
}
