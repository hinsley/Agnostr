import { makeTopicChannelKey, normalizeTopicSlug } from './bitchatChannel.ts'

const DEG2RAD = Math.PI / 180
const TWO_PI = Math.PI * 2

/**
 * Realistic rocky asteroid mineral surface hues:
 * silicate grey, iron-bronze, dark basalt, ochre regolith, dusty slate.
 */
const ASTEROID_MINERAL_HUES: readonly string[] = [
  '#8E8C87', // silicate grey
  '#9E8773', // iron-bronze
  '#70747D', // dark basalt
  '#AA967B', // ochre regolith
  '#7B8492', // dusty slate
  '#8B7D74', // chondrite umber
  '#979BA3', // nickel-silicate
]

export interface TopicAsteroidSpec {
  channelKey: string // 'topic:<slug>'
  slug: string
  orbitRadius: number // 1.56..2.28 (between Earth r=1.0 and Moon d=4.2)
  inclinationRad: number // -32deg..+32deg
  ascNodeRad: number // 0..2*PI
  basePhaseRad: number // 0..2*PI
  angularSpeedRadPerSec: number // gentle drift 0.0020..0.0044 rad/s
  rockRadius: number // 0.036..0.056
  seed: number
  baseColorHex: string
  spinAxis: [number, number, number]
  spinSpeed: number // gentle rock tumble 0.12..0.34 rad/s
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Deterministically computes orbital parameters, shape seed, mineral hue,
 * and tumble spin axis for any `kind: 23333` topic channel slug or key.
 */
export function computeTopicAsteroidSpec(channelKeyOrSlug: string): TopicAsteroidSpec {
  const normalizedSlug =
    normalizeTopicSlug(channelKeyOrSlug) ??
    (channelKeyOrSlug.trim().toLowerCase().replace(/^topic:/, '').replace(/^[#/]+/, '') || 'topic')
  const channelKey = makeTopicChannelKey(normalizedSlug) ?? `topic:${normalizedSlug}`

  const seed = fnv1a32(channelKey)
  const rand = mulberry32(seed)

  const orbitRadius = 1.56 + rand() * (2.28 - 1.56)
  const inclinationDeg = -32 + rand() * 64
  const inclinationRad = inclinationDeg * DEG2RAD
  const ascNodeRad = rand() * TWO_PI
  const basePhaseRad = rand() * TWO_PI
  const angularSpeedRadPerSec = 0.002 + rand() * (0.0044 - 0.002)
  const rockRadius = 0.036 + rand() * (0.056 - 0.036)
  const baseColorHex =
    ASTEROID_MINERAL_HUES[Math.floor(rand() * ASTEROID_MINERAL_HUES.length)] ??
    ASTEROID_MINERAL_HUES[0]

  // Uniform unit spin axis on the sphere
  const u = rand() * 2 - 1
  const phi = rand() * TWO_PI
  const s = Math.sqrt(Math.max(0, 1 - u * u))
  const sx = s * Math.cos(phi)
  const sy = u
  const sz = s * Math.sin(phi)
  const len = Math.hypot(sx, sy, sz) || 1
  const spinAxis: [number, number, number] = [sx / len, sy / len, sz / len]
  const spinSpeed = 0.12 + rand() * (0.34 - 0.12)

  return {
    channelKey,
    slug: normalizedSlug,
    orbitRadius,
    inclinationRad,
    ascNodeRad,
    basePhaseRad,
    angularSpeedRadPerSec,
    rockRadius,
    seed,
    baseColorHex,
    spinAxis,
    spinSpeed,
  }
}

/**
 * Computes exact 3D world position `[x, y, z]` along an asteroid's inclined
 * circular orbit around Earth `(0, 0, 0)` at `elapsedSec` seconds.
 */
export function computeAsteroidWorldPosition(
  spec: TopicAsteroidSpec,
  elapsedSec: number,
): [number, number, number] {
  const angle = spec.basePhaseRad + spec.angularSpeedRadPerSec * elapsedSec
  const r = spec.orbitRadius

  // Point in equatorial orbital plane
  const px = r * Math.cos(angle)
  const pz = r * Math.sin(angle)

  // Tilt orbital plane by inclination around X axis
  const cosInc = Math.cos(spec.inclinationRad)
  const sinInc = Math.sin(spec.inclinationRad)
  const x1 = px
  const y1 = pz * sinInc
  const z1 = pz * cosInc

  // Rotate ascending node around Y axis
  const cosAsc = Math.cos(spec.ascNodeRad)
  const sinAsc = Math.sin(spec.ascNodeRad)
  const x = x1 * cosAsc + z1 * sinAsc
  const y = y1
  const z = -x1 * sinAsc + z1 * cosAsc

  return [x, y, z]
}

/**
 * Exact ray-segment vs Earth sphere occlusion test.
 * Returns true iff the line segment from `camPos` to `targetPos` intersects
 * the Earth sphere centered at `(0, 0, 0)` of radius `earthRadius`.
 */
export function isPointOccludedByEarth(
  camPos: readonly [number, number, number],
  targetPos: readonly [number, number, number],
  earthRadius = 1.0,
): boolean {
  const ax = camPos[0]
  const ay = camPos[1]
  const az = camPos[2]

  const dx = targetPos[0] - ax
  const dy = targetPos[1] - ay
  const dz = targetPos[2] - az

  const dd = dx * dx + dy * dy + dz * dz
  if (dd < 1e-12) return false

  // Parameter t of closest point on segment to Earth center (0, 0, 0)
  const t = -(ax * dx + ay * dy + az * dz) / dd
  if (t <= 0 || t >= 1) return false

  const qx = ax + t * dx
  const qy = ay + t * dy
  const qz = az + t * dz
  const distSq = qx * qx + qy * qy + qz * qz
  const effectiveR = earthRadius * 0.992
  return distSq < effectiveR * effectiveR
}
