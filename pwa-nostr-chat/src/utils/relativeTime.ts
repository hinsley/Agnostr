/**
 * Formats a Unix timestamp in seconds into an ultra-compact relative time string
 * (e.g. `just now`, `30m`, `4h`, `15d`, `2mo`, `1y`), or `'Offline'` if absent/invalid.
 */
export function formatCompactLastActive(
  unixSec: number | undefined | null,
  nowSec?: number
): string {
  if (!unixSec || !Number.isFinite(unixSec) || unixSec <= 0) {
    return 'Offline'
  }
  const referenceSec =
    typeof nowSec === 'number' && Number.isFinite(nowSec) ? nowSec : Date.now() / 1000
  const diff = Math.max(0, Math.floor(referenceSec - unixSec))
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`
  if (diff < 86400 * 365) return `${Math.max(1, Math.floor(diff / (86400 * 30)))}mo`
  return `${Math.max(1, Math.floor(diff / (86400 * 365)))}y`
}
