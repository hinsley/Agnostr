export const TILE_PIXELS = 256
export const TILE_GUTTER = 2
export const TILE_STRIDE = TILE_PIXELS + 2 * TILE_GUTTER
export const MAX_TILE_LEVEL = 4
export const TILE_GRID_HEIGHT = 1 << MAX_TILE_LEVEL
export const TILE_GRID_WIDTH = 2 * TILE_GRID_HEIGHT
export const TILE_COLUMNS = 4

export type SurfaceTile = { level: number; x: number; y: number }
export const tileKey = ({ level, x, y }: SurfaceTile) => `${level}/${x}/${y}`

/** North-up, east-positive equirectangular tiles. The prime meridian is at u=.5.
 * The camera looks straight at the unit globe's center. Bound the viewport by
 * the cone through its corners, then intersect that cone with the globe. */
export function surfaceTilePlan(
  lat: number, lon: number, altitude: number, fov: number, aspect: number,
  height: number, baseWidth: number, maxLevel: number, budget: number,
): SurfaceTile[] {
  const d = 1 + altitude
  const tanHalfFov = Math.tan(fov / 2)
  const density = Math.PI * height / (altitude * tanHalfFov)
  if (density < baseWidth * 1.15) return []
  const desired = Math.min(maxLevel, Math.max(0, Math.ceil(Math.log2(density / (2 * TILE_PIXELS)))))
  const corner = Math.atan(tanHalfFov * Math.hypot(1, aspect))
  const cap = d * Math.sin(corner) >= 1 ? Math.acos(1 / d) : Math.asin(d * Math.sin(corner)) - corner
  const sinLat = Math.sin(lat)
  const cosLat = Math.cos(lat)
  const lonWrapped = ((lon + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
  const minLevel = baseWidth <= 512 ? 1 : 2
  for (let level = desired; level >= minLevel; level--) {
    const rows = 1 << level
    const columns = rows * 2
    const step = Math.PI / rows
    const candidates: Array<SurfaceTile & { distance: number }> = []
    const first = Math.max(0, Math.floor((Math.PI / 2 - lat - cap - 1e-10) / step))
    const last = Math.min(rows - 1, Math.floor((Math.PI / 2 - lat + cap + 1e-10) / step))
    const capDot = Math.cos(cap) - 1e-12
    for (let y = first; y <= last; y++) {
      const hi = Math.PI / 2 - y * step
      const lo = hi - step
      for (let x = 0; x < columns; x++) {
        const mid = (x + 0.5) * step - Math.PI
        const delta = Math.abs(mid - lonWrapped)
        const dLon = Math.max(0, Math.min(delta, 2 * Math.PI - delta) - step / 2)
        // Maximize the dot product on this lat/lon rectangle. No false
        // negatives along the date line, horizon, or at the poles.
        const a = sinLat
        const b = cosLat * Math.cos(dLon)
        const dotAt = (phi: number) => a * Math.sin(phi) + b * Math.cos(phi)
        const critical = Math.atan2(a, b)
        const dot = Math.max(dotAt(lo), dotAt(hi), critical >= lo && critical <= hi ? Math.hypot(a, b) : -1)
        if (dot < capDot) continue
        const midLat = (hi + lo) / 2
        candidates.push({ level, x, y, distance: 2 - dot - 0.01 * (sinLat * Math.sin(midLat) + cosLat * Math.cos(midLat) * Math.cos(delta)) })
      }
    }
    if (candidates.length <= budget || level === minLevel) {
      return candidates.sort((a, b) => a.distance - b.distance).slice(0, budget).map(({ level, x, y }) => ({ level, x, y }))
    }
  }
  return []
}
