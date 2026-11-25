/** Monotonic deletions: a lagging sibling must not roll back the cutoff. */
export function mergeAmailTombstones(local: Record<string, number>, incoming?: Record<string, number>) {
  const merged = { ...local }
  let changed = false
  for (const [key, ts] of Object.entries(incoming ?? {})) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (Number.isFinite(ts) && ts > (merged[key] ?? 0)) {
      merged[key] = ts
      changed = true
    }
  }
  return { merged, changed }
}

export function amailTombstoneCovers(deletedAt: number, updatedAt: number): boolean {
  return deletedAt > 0 && deletedAt >= updatedAt
}
