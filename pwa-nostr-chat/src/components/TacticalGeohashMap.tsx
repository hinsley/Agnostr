import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Pin } from 'lucide-react'
import type { GeoCoords, PinnedChannel, PulseRoom, ThemeId } from '../types/protocol.ts'
import {
  decodeBounds,
  decodeCenter,
  encodeGeohash,
  formatCoords,
  getChildGeohashes,
  getGeohashCellsInBounds,
  getRecommendedPrecisionForZoom,
  getZoomForPrecision,
  isValidGeohash,
  normalizeGeohash,
  wrapLongitude,
} from '../lib/geohash.ts'
import {
  getChannelBodyId,
  getChannelRawGeohash,
  getTopicSlug,
  isTopicChannel,
  makeCelestialChannelKey,
  makeTopicChannelKey,
  parseCelestialChannelKey,
} from '../lib/bitchatChannel.ts'
import { latLonToUnitVec3 } from '../lib/astronomy.ts'
import {
  computeAsteroidWorldPosition,
  computeTopicAsteroidSpec,
  isPointOccludedByEarth,
  type TopicAsteroidSpec,
} from '../lib/asteroids.ts'
import {
  PLANET_BODY_IDS,
  SOLAR_BODIES,
  computeSolarSystemSnapshot,
  getBodyDef,
  getMoonsOfBody,
  samplePlanetOrbitPoints,
  type CelestialBodyDef,
  type CelestialBodyId,
  type GeohashableBodyId,
  type SolarBodySnapshot,
  type SolarSystemSnapshot,
} from '../lib/solarSystem.ts'
import { createPlanetaryRingTexture } from '../lib/planetTextures.ts'
import { SolarSurfaceMaps } from '../lib/solarSurfaceMaps.ts'

export type PrecisionSelection = 'auto' | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

export interface TacticalGeohashMapHandle {
  zoomIn: () => void
  zoomOut: () => void
  flyToGeohash: (geohash: string, options?: { animate?: boolean; zoom?: number }) => void
  flyToTopic: (topicChannelKey: string, options?: { animate?: boolean }) => void
  flyToCoords: (lat: number, lon: number, zoom?: number) => void
  fitWorld: () => void
  fitAsteroids: () => void
  focusBody: (bodyId: GeohashableBodyId, options?: { geohash?: string; animate?: boolean }) => void
  fitSolarSystem: () => void
  getZoom: () => number
}

export interface TacticalGeohashMapProps {
  mode: 'compact' | 'expanded'
  theme: ThemeId
  activeGeohash: string
  selectedGeohash: string | null
  precisionMode: PrecisionSelection
  showSubZones: boolean
  showPulse: boolean
  showBubbles?: boolean
  pulseRooms: PulseRoom[]
  pinnedChannels?: PinnedChannel[]
  topicRooms?: PulseRoom[]
  extraTopicKeys?: string[]
  activeChannelKey?: string
  selectedChannelKey?: string | null
  focusedBodyId?: GeohashableBodyId
  onFocusBodyChange?: (bodyId: GeohashableBodyId) => void
  userCoords: GeoCoords | null
  isTeleported: boolean
  onSelectGeohash: (geohash: string) => void
  onTuneGeohash?: (geohash: string) => void
  onSelectChannel?: (channelKey: string) => void
  onTuneChannel?: (channelKey: string) => void
  onViewportInfoChange?: (info: { zoom: number; effectivePrecision: number }) => void
  onVisibleLiveCountChange?: (count: number) => void
  onWebglError?: () => void
  className?: string
}

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI
const MAX_MERCATOR_LAT = 85.05112878

const MIN_VIRTUAL_ZOOM = -6.8 // distance ~ 454 at max Solar System pullback (frames all 9 planets + Pluto)
const MAX_VIRTUAL_ZOOM = 20.5 // alt ~ 31m at P9 (~4.8m spot)
const MAX_ALTITUDE = 3.6 // distance = 4.6 at zoom 1
const DEEP_SPACE_DECAY = 0.62 // smooth exponential pull-back for zoom < 1 out past Pluto
const CAMERA_FOV_DEG = 42

// Zero radial parallax: all surface layers sit on exact unit sphere r = 1.0,
// ordered strictly by WebGL renderOrder + polygonOffset + depthWrite: false!
const EARTH_RADIUS = 1.0
const PATCH_RADIUS = 1.0
const OVERLAY_FILL_RADIUS = 1.0
const OVERLAY_LINE_RADIUS = 1.0
const FOCUS_LINE_RADIUS = 1.0

const ESRI_TOPO_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'

const MAX_CACHED_PATCH_TILES = 64
const MAX_VISIBLE_PATCH_TILES = 12
const MAX_BUBBLES_PER_GEOHASH = 4
const BUBBLE_DEMOTE_LIFETIME_MS = 18_000
const BUBBLE_FADE_DURATION_MS = 380
const RECENT_BUBBLE_WINDOW_MS = 10 * 60_000
const HOT_BEACON_WINDOW_MS = 5 * 60_000
const WARM_BEACON_WINDOW_MS = 60 * 60_000
const VIEWPORT_DEBOUNCE_MS = 130
const SUN_REFRESH_INTERVAL_MS = 30_000

const UP_Y = new THREE.Vector3(0, 1, 0)

interface MapCanvasPalette {
  accent: string
  accentSecondary: string
  isLight: boolean
  spaceBg: string
}

const THEME_FALLBACKS: Record<
  ThemeId,
  { accent: string; accentSecondary: string; spaceBg: string }
> = {
  phosphor: {
    accent: '#3B82F6',
    accentSecondary: '#38BDF8',
    spaceBg: '#04070E',
  },
  indigo: {
    accent: '#6366F1',
    accentSecondary: '#38BDF8',
    spaceBg: '#050712',
  },
  amber: {
    accent: '#F59E0B',
    accentSecondary: '#FB7185',
    spaceBg: '#090605',
  },
  daylight: {
    accent: '#2563EB',
    accentSecondary: '#0284C7',
    spaceBg: '#0B1324',
  },
}

function readCanvasPalette(el: HTMLElement | null, theme: ThemeId): MapCanvasPalette {
  const fb = THEME_FALLBACKS[theme] ?? THEME_FALLBACKS.phosphor
  const docTheme =
    typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null
  const themeMatchesDom =
    !docTheme || docTheme === theme || (theme === 'daylight' && docTheme === 'paper')
  const styles =
    el && themeMatchesDom && typeof window !== 'undefined' ? window.getComputedStyle(el) : null

  const accent = styles?.getPropertyValue('--accent').trim() || fb.accent
  const accentSecondary =
    styles?.getPropertyValue('--accent-secondary').trim() || fb.accentSecondary
  return {
    accent,
    accentSecondary,
    isLight: theme === 'daylight',
    spaceBg: fb.spaceBg,
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function wrapDeltaLon(deltaDeg: number): number {
  let d = ((deltaDeg + 180) % 360 + 360) % 360 - 180
  if (d === -180 && deltaDeg > 0) d = 180
  return d
}

function zoomToDistance(zoom: number): number {
  const z = clamp(zoom, MIN_VIRTUAL_ZOOM, MAX_VIRTUAL_ZOOM)
  if (z >= 1) {
    // True 2x-per-zoom altitude decay: z=15 -> ~1.4km (P7), z=17 -> ~350m (P8), z=19 -> ~87m (P9), z=20.5 -> ~31m
    return EARTH_RADIUS + MAX_ALTITUDE * Math.pow(2, 1 - z)
  }
  return EARTH_RADIUS + MAX_ALTITUDE * Math.exp(-DEEP_SPACE_DECAY * (z - 1))
}

/**
 * Precision-based zoom-out LOD cap for surface activity dots & speech bubbles
 * so high-precision neighborhood dots vanish cleanly when zooming far out.
 */
function getMaxVisibleSurfacePrecision(zoom: number): number {
  if (zoom < -1.8) return 0
  if (zoom < 0.1) return 2
  if (zoom < 1.8) return 3
  return 9
}

function latLonToVec3(latDeg: number, lonDeg: number, radius = EARTH_RADIUS): THREE.Vector3 {
  const [x, y, z] = latLonToUnitVec3(latDeg, lonDeg)
  return new THREE.Vector3(x * radius, y * radius, z * radius)
}

function unitVec3ToLatLon(v: THREE.Vector3): { lat: number; lon: number } {
  const len = v.length() || 1
  const nx = v.x / len
  const ny = clamp(v.y / len, -1, 1)
  const nz = v.z / len
  const lat = Math.asin(ny) * RAD2DEG
  const lon = Math.atan2(-nz, nx) * RAD2DEG
  return { lat, lon }
}

interface WheelZoomAnchor {
  wx: number
  wy: number
  wz: number
  ndcX: number
  ndcY: number
  clientX: number
  clientY: number
}

/**
 * Analytical Float64 ray-sphere intersection in camera-local coordinates.
 * Camera sits at (0, 0, dist) looking down -Z at the origin with vertical FOV CAMERA_FOV_DEG.
 * Uses the cancellation-free quadratic form so full Float64 precision holds even at P9 (dist ≈ 1.0000048).
 */
function intersectCameraRayWithUnitSphere(
  ndcX: number,
  ndcY: number,
  aspect: number,
  dist: number,
  radius = EARTH_RADIUS,
): [number, number, number] | null {
  if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY) || !Number.isFinite(aspect) || aspect <= 0) {
    return null
  }
  if (!Number.isFinite(dist) || dist <= radius) return null

  const tanHalfFov = Math.tan((CAMERA_FOV_DEG * DEG2RAD) / 2)
  const rx = ndcX * aspect * tanHalfFov
  const ry = ndcY * tanHalfFov
  const rz = -1
  const rLen = Math.hypot(rx, ry, rz)
  if (rLen <= 0) return null

  const dx = rx / rLen
  const dy = ry / rLen
  const dz = rz / rLen

  // Cancellation-free discriminant: b^2 - c = radius^2 - dist^2 * (dx^2 + dy^2)
  const disc = radius * radius - dist * dist * (dx * dx + dy * dy)
  if (disc < 0) return null

  const sqrtDisc = Math.sqrt(disc)
  const b = dist * dz // strictly negative because dz < 0
  const c = (dist - radius) * (dist + radius)
  const denom = -b + sqrtDisc
  if (denom <= 1e-12) return null

  const t = c / denom
  if (!Number.isFinite(t) || t <= 0) return null

  const hx = (t * dx) / radius
  const hy = (t * dy) / radius
  const hz = (dist + t * dz) / radius
  const hLen = Math.hypot(hx, hy, hz)
  if (hLen <= 1e-12) return null
  return [hx / hLen, hy / hLen, hz / hLen]
}

/**
 * Transforms a camera-local unit vector (hx, hy, hz) into world unit coordinates
 * for a zero-roll camera at (camLatDeg, camLonDeg) looking at the origin with up = (0, 1, 0).
 */
function cameraLocalToWorldUnit(
  hx: number,
  hy: number,
  hz: number,
  camLatDeg: number,
  camLonDeg: number,
): [number, number, number] {
  const phi = camLatDeg * DEG2RAD
  const lambda = camLonDeg * DEG2RAD
  const cosPhi = Math.cos(phi)
  const sinPhi = Math.sin(phi)
  const cosLam = Math.cos(lambda)
  const sinLam = Math.sin(lambda)

  const a = hz * cosPhi - hy * sinPhi
  const wx = a * cosLam - hx * sinLam
  const wy = hy * cosPhi + hz * sinPhi
  const wz = -a * sinLam - hx * cosLam
  return [wx, wy, wz]
}

/**
 * Samples the world-space unit vector on the unit sphere currently under screen NDC (ndcX, ndcY),
 * or returns null if the ray misses the sphere.
 */
function sampleWorldUnitAtNdc(
  ndcX: number,
  ndcY: number,
  aspect: number,
  camLatDeg: number,
  camLonDeg: number,
  dist: number,
  radius = EARTH_RADIUS,
): [number, number, number] | null {
  const localHit = intersectCameraRayWithUnitSphere(ndcX, ndcY, aspect, dist, radius)
  if (!localHit) return null
  return cameraLocalToWorldUnit(localHit[0], localHit[1], localHit[2], camLatDeg, camLonDeg)
}

/**
 * Closed-form Float64 inverse solver: given a world unit point `anchorUnit` on the sphere
 * and a camera distance `dist`, returns the exact camera `{ lat, lon }` (up = (0, 1, 0))
 * that projects `anchorUnit` back onto screen NDC `(ndcX, ndcY)`.
 * Returns null if the cursor ray misses the sphere at `dist` (e.g. zooming out past the limb).
 */
function solveCameraLatLonForAnchor(
  anchorUnit: [number, number, number],
  ndcX: number,
  ndcY: number,
  aspect: number,
  dist: number,
  currentLatDeg: number,
  currentLonDeg: number,
  radius = EARTH_RADIUS,
): { lat: number; lon: number } | null {
  const localHit = intersectCameraRayWithUnitSphere(ndcX, ndcY, aspect, dist, radius)
  if (!localHit) return null

  const [hx, hy, hz] = localHit
  const [wx, wy, wz] = anchorUnit
  const rYz = Math.hypot(hy, hz)
  if (rYz < 1e-9) return null

  const beta = Math.atan2(hy, hz)
  const sinSum = clamp(wy / rYz, -1, 1)
  const asinVal = Math.asin(sinSum)

  // Evaluate both branches of sin(phi + beta) = sinSum to avoid a 180-deg flip near the poles
  const rawPhiCandidates = [
    asinVal - beta,
    (sinSum >= 0 ? Math.PI - asinVal : -Math.PI - asinVal) - beta,
  ]

  const [curX, curY, curZ] = latLonToUnitVec3(currentLatDeg, currentLonDeg)
  const horizAnchorLen = Math.hypot(wx, wz)
  const anchorAzimuth = Math.atan2(-wz, wx)

  let bestLat = currentLatDeg
  let bestLon = currentLonDeg
  let bestScore = -Infinity
  let hasValidCandidate = false

  for (const rawPhi of rawPhiCandidates) {
    const withinHemisphere = Math.abs(rawPhi) <= Math.PI / 2 + 1e-6
    const latDeg = clamp(rawPhi * RAD2DEG, -82, 82)
    const phi = latDeg * DEG2RAD
    const a = hz * Math.cos(phi) - hy * Math.sin(phi)
    const b = hx
    const abLen = Math.hypot(b, a)

    let lonDeg = currentLonDeg
    if (abLen >= 1e-6 && horizAnchorLen >= 1e-6) {
      const lambda = anchorAzimuth - Math.atan2(b, a)
      lonDeg = currentLonDeg + wrapDeltaLon(lambda * RAD2DEG - currentLonDeg)
    }

    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) continue

    const [candX, candY, candZ] = latLonToUnitVec3(latDeg, lonDeg)
    const camDot = candX * curX + candY * curY + candZ * curZ
    const score = (withinHemisphere ? 4 : 0) + camDot
    if (!hasValidCandidate || score > bestScore) {
      hasValidCandidate = true
      bestScore = score
      bestLat = latDeg
      bestLon = lonDeg
    }
  }

  if (!hasValidCandidate) return null
  return { lat: bestLat, lon: bestLon }
}

function latToMercYNorm(latDeg: number): number {
  const clamped = clamp(latDeg, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT)
  const rad = clamped * DEG2RAD
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2
}

function mercYNormToLat(yNorm: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * yNorm))) * RAD2DEG
}

function lonToMercXNorm(lonDeg: number): number {
  return (wrapLongitude(lonDeg) + 180) / 360
}

function tileUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
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
 * Computes exact visible central angular half-span (radians) on the unit sphere
 * from camera distance `d` and vertical FOV half-angle `halfFovRad`.
 */
function computeVisibleHalfAngleRad(distance: number, halfFovRad: number): number {
  const sinAlpha = Math.sin(halfFovRad)
  const k = distance * sinAlpha
  if (k < 0.999) {
    return Math.max(1e-7, Math.asin(k) - halfFovRad)
  }
  return Math.acos(clamp(1 / Math.max(1.000001, distance), -1, 1))
}

/**
 * Formats a raw message preview for compact globe speech bubbles.
 */
function formatBubbleSnippet(preview: string): string {
  if (!preview) return ''
  const cleaned = preview
    .replace(/\bcashu[AB][A-Za-z0-9_+/-]{8,}={0,2}/g, 'Cashu ecash')
    .replace(/https?:\/\/\S+/gi, 'Link')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  if (cleaned.length <= 52) return cleaned
  return `${cleaned.slice(0, 51).trimEnd()}…`
}

function formatBubbleSender(sender: string): string {
  const cleaned = sender.replace(/^@+/, '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return 'anon'
  if (cleaned.length <= 11) return cleaned
  return `${cleaned.slice(0, 10).trimEnd()}…`
}

function formatBubbleAge(tsMs: number, nowMs: number): string {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return 'just now'
  const diffSec = Math.max(0, Math.floor((nowMs - tsMs) / 1000))
  if (diffSec < 5) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86400)}d ago`
}

function formatCompactAge(tsMs: number, nowMs: number): string {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return 'now'
  const diffSec = Math.max(0, Math.floor((nowMs - tsMs) / 1000))
  if (diffSec < 5) return 'now'
  if (diffSec < 60) return `${diffSec}s`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`
  return `${Math.floor(diffSec / 86400)}d`
}

type BeaconWarmthClass = 'is-hot' | 'is-warm' | 'is-recent'

function getBeaconWarmthClass(tsMs: number, nowMs: number): BeaconWarmthClass {
  const ageMs = Math.max(0, nowMs - tsMs)
  if (ageMs < HOT_BEACON_WINDOW_MS) return 'is-hot'
  if (ageMs < WARM_BEACON_WINDOW_MS) return 'is-warm'
  return 'is-recent'
}

// ---------------------------------------------------------------------------
// GLSL Shaders: Earth Day/Night + Atmosphere + Moon + Asteroids + Push-Pins + Stars
// ---------------------------------------------------------------------------

const EARTH_VERTEX_SHADER = `
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    // Use Three.js Float64-composed modelViewMatrix for sub-millimeter RTC precision at P7..P9
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const EARTH_FRAGMENT_SHADER = `
  uniform sampler2D uMap;
  uniform vec3 uSunDir;
  uniform float uIsLight;
  uniform float uOpacity;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  void main() {
    vec3 texel = texture2D(uMap, vUv).rgb;
    vec3 N = normalize(vWorldNormal);
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vWorldPos);

    float ndotl = dot(N, L);
    float dayFactor = smoothstep(-0.15, 0.18, ndotl);
    float twilight = exp(-pow((ndotl - 0.01) / 0.14, 2.0));

    // Luminous, vivid sunlit daylight hemisphere
    float sunFacing = pow(max(ndotl, 0.0), 0.62);
    vec3 dayColor = min(
      texel * vec3(1.06, 1.04, 0.99) * (0.94 + 0.28 * sunFacing),
      vec3(1.06)
    );

    // Rich midnight-indigo night hemisphere (keeps labels & geography softly legible)
    vec3 nightColor = uIsLight > 0.5
      ? pow(max(texel, vec3(0.001)), vec3(1.30)) * vec3(0.28, 0.36, 0.52)
      : pow(max(texel, vec3(0.001)), vec3(1.45)) * vec3(0.16, 0.23, 0.39);

    vec3 color = mix(nightColor, dayColor, dayFactor);

    // Vivid golden-amber twilight scatter right along the day/night terminator
    color += vec3(1.0, 0.48, 0.18) * twilight * 0.22;

    // Crisp ocean specular glint on sunlit water
    float oceanMask = smoothstep(0.02, 0.10, texel.b - texel.r * 0.85);
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 30.0) * oceanMask * dayFactor;
    color += vec3(0.94, 0.97, 1.0) * spec * 0.22;

    // Luminous sunlit atmospheric Fresnel rim
    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.4);
    float rimSun = 0.22 + 0.78 * smoothstep(-0.26, 0.35, ndotl);
    color += vec3(0.36, 0.68, 1.0) * fresnel * rimSun * 0.34;

    gl_FragColor = vec4(color, uOpacity);
  }
`

const ATMOSPHERE_VERTEX_SHADER = `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`

const ATMOSPHERE_FRAGMENT_SHADER = `
  uniform vec3 uSunDir;
  uniform vec3 uHaloColor;
  uniform float uIntensity;
  uniform float uTwilightMix;

  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 L = normalize(uSunDir);

    float edge = clamp(0.68 - dot(-N, V), 0.0, 1.0);
    float rim = pow(edge, 3.2);
    float ndotl = dot(N, L);
    float sunSide = 0.24 + 0.76 * smoothstep(-0.32, 0.42, ndotl);
    float twilight = exp(-pow((ndotl + 0.04) / 0.22, 2.0));

    vec3 haloColor = mix(uHaloColor, vec3(0.98, 0.58, 0.28), twilight * uTwilightMix);
    float alpha = rim * sunSide * uIntensity;
    gl_FragColor = vec4(haloColor * alpha, alpha);
  }
`

const PLANET_FRAGMENT_SHADER = `
  uniform sampler2D uMap;
  uniform vec4 uMapRect;
  uniform bool uMapReady;
  uniform vec3 uBaseColor;
  uniform vec3 uSunDir;
  uniform vec3 uAtmoColor;
  uniform float uAtmoStrength;
  uniform float uOpacity;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  void main() {
    vec3 texel = uMapReady ? texture2D(uMap, uMapRect.xy + vUv * uMapRect.zw).rgb : uBaseColor;
    vec3 N = normalize(vWorldNormal);
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vWorldPos);

    float ndotl = dot(N, L);
    float dayFactor = smoothstep(-0.14, 0.22, ndotl);
    float sunFacing = pow(max(ndotl, 0.0), 0.65);

    vec3 dayColor = min(texel * (0.94 + 0.34 * sunFacing), vec3(1.12));
    vec3 nightColor = texel * vec3(0.11, 0.14, 0.22);
    vec3 color = mix(nightColor, dayColor, dayFactor);

    if (uAtmoStrength > 0.001) {
      float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.0);
      float rimSun = 0.24 + 0.76 * smoothstep(-0.24, 0.36, ndotl);
      color += uAtmoColor * fresnel * rimSun * uAtmoStrength;
    }

    gl_FragColor = vec4(color, uOpacity);
    #include <colorspace_fragment>
  }
`

const ASTEROID_VERTEX_SHADER = `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying float vElev;

  void main() {
    vElev = length(position);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`

const ASTEROID_FRAGMENT_SHADER = `
  uniform vec3 uSunDir;
  uniform vec3 uBaseColor;
  uniform vec3 uRimColor;
  uniform float uHighlight;
  uniform float uMeanRadius;

  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying float vElev;

  void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vWorldPos);

    // Subtle elevation darkening inside craters and mineral brightening on ridges
    float elevFactor = clamp((vElev / max(0.001, uMeanRadius) - 0.84) / 0.34, 0.0, 1.0);
    vec3 rockAlbedo = uBaseColor * mix(0.76, 1.18, elevFactor);

    float ndotl = dot(N, L);
    float lit = smoothstep(-0.18, 0.38, ndotl);
    float diffuse = mix(0.24, 1.34, lit);
    vec3 color = rockAlbedo * diffuse;

    // Subtle cool space-rim readability + stronger accent rim when hovered/selected
    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.5);
    vec3 rimTint = mix(vec3(0.68, 0.80, 0.96), uRimColor, clamp(uHighlight, 0.0, 1.0));
    color += rimTint * fresnel * (0.28 + 0.62 * uHighlight);
    color += uRimColor * (0.12 * uHighlight);

    gl_FragColor = vec4(color, 1.0);
  }
`

const PINHEAD_VERTEX_SHADER = `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`

const PINHEAD_FRAGMENT_SHADER = `
  uniform vec3 uColor;
  uniform vec3 uSunDir;

  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 L = normalize(mix(V, normalize(uSunDir), 0.45));
    float ndotl = max(dot(N, L), 0.0);
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 28.0);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 2.8);

    vec3 color = uColor * (0.58 + 0.56 * ndotl) + vec3(1.0) * spec * 0.55 + uColor * rim * 0.25;
    gl_FragColor = vec4(color, 1.0);
  }
`

const STAR_VERTEX_SHADER = `
  attribute float aSize;
  attribute vec3 aColor;
  varying vec3 vColor;

  void main() {
    vColor = aColor;
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize;
    gl_Position = projectionMatrix * mvPos;
  }
`

const STAR_FRAGMENT_SHADER = `
  varying vec3 vColor;

  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    float d2 = dot(p, p);
    if (d2 > 0.25) discard;
    float alpha = exp(-d2 * 14.0);
    gl_FragColor = vec4(vColor, alpha);
  }
`

// ---------------------------------------------------------------------------
// Procedural Textures & Starfield / Asteroid / Patch / Overlay Builders
// ---------------------------------------------------------------------------

function paintProceduralBaseMap(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height

  // Bright sunlit Earth ocean blue + crisp polar caps (day/night shader handles night shadow)
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, '#DCE8F2')
  grad.addColorStop(0.06, '#5D9BD1')
  grad.addColorStop(0.5, '#2D74B8')
  grad.addColorStop(0.94, '#5D9BD1')
  grad.addColorStop(1, '#DCE8F2')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  ctx.strokeStyle = 'rgba(220, 238, 255, 0.18)'
  ctx.lineWidth = 1
  for (let lon = -150; lon <= 180; lon += 30) {
    const x = ((lon + 180) / 360) * w
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = ((90 - lat) / 180) * h
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(220, 238, 255, 0.28)'
  ctx.beginPath()
  ctx.moveTo(0, h / 2)
  ctx.lineTo(w, h / 2)
  ctx.stroke()
}

function compositeMercatorTileOntoEquirect(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  z: number,
  tx: number,
  ty: number,
  canvasW: number,
  canvasH: number,
): void {
  const n = 1 << z
  const dstX = (tx / n) * canvasW
  const dstW = canvasW / n + 0.5

  const latNorth = mercYNormToLat(ty / n)
  const latSouth = mercYNormToLat((ty + 1) / n)
  const pyTop = Math.max(0, Math.floor(((90 - latNorth) / 180) * canvasH))
  const pyBot = Math.min(canvasH - 1, Math.ceil(((90 - latSouth) / 180) * canvasH))

  const imgW = img.naturalWidth || img.width || 256
  const imgH = img.naturalHeight || img.height || 256

  for (let py = pyTop; py <= pyBot; py++) {
    const lat0 = 90 - (py / canvasH) * 180
    const lat1 = 90 - ((py + 1) / canvasH) * 180
    if (lat0 < -MAX_MERCATOR_LAT || lat1 > MAX_MERCATOR_LAT) continue
    const yNorm0 = latToMercYNorm(clamp(lat0, latSouth, latNorth))
    const yNorm1 = latToMercYNorm(clamp(lat1, latSouth, latNorth))
    const srcY0 = clamp((yNorm0 * n - ty) * imgH, 0, imgH - 0.5)
    const srcY1 = clamp((yNorm1 * n - ty) * imgH, srcY0 + 0.5, imgH)
    const srcH = Math.max(0.5, srcY1 - srcY0)
    ctx.drawImage(img, 0, srcY0, imgW, srcH, dstX, py, dstW, 1.2)
  }
}

function createSunCoronaTexture(): THREE.CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const cx = size / 2
    const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx)
    grad.addColorStop(0.0, 'rgba(255, 253, 240, 1.0)')
    grad.addColorStop(0.16, 'rgba(255, 236, 178, 0.88)')
    grad.addColorStop(0.38, 'rgba(255, 190, 96, 0.36)')
    grad.addColorStop(0.68, 'rgba(255, 145, 58, 0.10)')
    grad.addColorStop(1.0, 'rgba(255, 120, 40, 0.0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

function createPlanetaryRingMesh(
  innerRadius: number,
  outerRadius: number,
  color: string,
  opacity: number,
  tiltDeg: number,
  segments = 96,
): THREE.Mesh {
  const geo = new THREE.RingGeometry(innerRadius, outerRadius, segments, 1)
  const pos = geo.attributes.position as THREE.BufferAttribute
  const uv = geo.attributes.uv as THREE.BufferAttribute
  const span = Math.max(0.0001, outerRadius - innerRadius)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const r = Math.hypot(x, y)
    const u = clamp((r - innerRadius) / span, 0, 1)
    uv.setXY(i, u, 0.5)
  }
  uv.needsUpdate = true
  geo.rotateX(-Math.PI / 2)
  if (tiltDeg !== 0) {
    geo.rotateZ(tiltDeg * DEG2RAD)
  }

  const ringTex = createPlanetaryRingTexture(color)
  const mat = new THREE.MeshBasicMaterial({
    map: ringTex,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = 2
  return mesh
}

function createMoonOrbitLoopGeometry(
  centerPos: THREE.Vector3,
  moonPos: THREE.Vector3,
  segments = 72,
  orbitUp = UP_Y,
): THREE.BufferGeometry {
  const offset = moonPos.clone().sub(centerPos)
  const radius = offset.length()
  if (radius < 1e-4) {
    return new THREE.BufferGeometry()
  }
  const u = offset.clone().normalize()
  let v = new THREE.Vector3().crossVectors(orbitUp, u)
  if (v.lengthSq() < 1e-5) {
    v = new THREE.Vector3(1, 0, 0).cross(u)
  }
  v.normalize()

  const positions = new Float32Array(segments * 3)
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    const cosA = Math.cos(a)
    const sinA = Math.sin(a)
    positions[i * 3] = centerPos.x + (u.x * cosA + v.x * sinA) * radius
    positions[i * 3 + 1] = centerPos.y + (u.y * cosA + v.y * sinA) * radius
    positions[i * 3 + 2] = centerPos.z + (u.z * cosA + v.z * sinA) * radius
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return geo
}

/**
 * Generates a unique, watertight faceted cratered 3D rocky asteroid geometry
 * deterministically from `spec.seed` & `spec.rockRadius`.
 */
function createAsteroidRockGeometry(spec: TopicAsteroidSpec): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(spec.rockRadius, 2)
  const posAttr = geo.attributes.position as THREE.BufferAttribute
  const rand = mulberry32(spec.seed ^ 0x51f2a9c3)

  // Distinct triaxial potato/boulder proportions per topic
  const scaleX = 0.82 + rand() * 0.44
  const scaleY = 0.76 + rand() * 0.36
  const scaleZ = 0.82 + rand() * 0.42

  // Layered 3D trig-noise phase offsets
  const p1 = rand() * Math.PI * 2
  const p2 = rand() * Math.PI * 2
  const p3 = rand() * Math.PI * 2
  const p4 = rand() * Math.PI * 2

  // 5 deterministic impact craters on the rock surface
  const craters: Array<{ x: number; y: number; z: number; cosHalf: number; depth: number }> = []
  for (let c = 0; c < 5; c++) {
    const u = rand() * 2 - 1
    const az = rand() * Math.PI * 2
    const s = Math.sqrt(Math.max(0, 1 - u * u))
    craters.push({
      x: s * Math.cos(az),
      y: u,
      z: s * Math.sin(az),
      cosHalf: 0.74 + rand() * 0.16,
      depth: 0.1 + rand() * 0.1,
    })
  }

  for (let i = 0; i < posAttr.count; i++) {
    const vx = posAttr.getX(i)
    const vy = posAttr.getY(i)
    const vz = posAttr.getZ(i)
    const len = Math.hypot(vx, vy, vz) || 1
    const nx = vx / len
    const ny = vy / len
    const nz = vz / len

    const ridge1 = Math.sin(nx * 3.1 + p1) * Math.cos(ny * 2.9 + p2) * Math.sin(nz * 3.3 + p3)
    const ridge2 = Math.cos((nx + ny) * 5.2 + p4) * Math.sin((ny - nz) * 4.7 + p1)
    let rFactor = 1.0 + ridge1 * 0.15 + ridge2 * 0.065

    // Apply crater bowls with subtle raised rims
    for (const cr of craters) {
      const d = nx * cr.x + ny * cr.y + nz * cr.z
      if (d > cr.cosHalf) {
        const t = (d - cr.cosHalf) / (1 - cr.cosHalf) // 0 at rim, 1 at center
        rFactor -= cr.depth * t * t
      } else if (d > cr.cosHalf - 0.09) {
        const rimT = 1 - (cr.cosHalf - d) / 0.09
        rFactor += cr.depth * 0.18 * rimT * rimT
      }
    }

    const r = spec.rockRadius * clamp(rFactor, 0.72, 1.24)
    posAttr.setXYZ(i, nx * r * scaleX, ny * r * scaleY, nz * r * scaleZ)
  }

  posAttr.needsUpdate = true
  geo.computeVertexNormals()
  return geo
}

function createAsteroidOrbitLoopGeometry(spec: TopicAsteroidSpec): THREE.BufferGeometry {
  const segments = 96
  const positions = new Float32Array(segments * 3)
  const fullPeriodSec = (Math.PI * 2) / Math.max(1e-6, spec.angularSpeedRadPerSec)
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * fullPeriodSec
    const [x, y, z] = computeAsteroidWorldPosition(spec, t)
    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = z
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return geo
}

function createStarfieldPoints(pixelRatio: number): {
  points: THREE.Points
  geometry: THREE.BufferGeometry
  material: THREE.ShaderMaterial
} {
  const starCount = 2400
  const planetGlints = 4
  const total = starCount + planetGlints
  const positions = new Float32Array(total * 3)
  const colors = new Float32Array(total * 3)
  const sizes = new Float32Array(total)

  const rand = mulberry32(9021042)
  const tilt = 62 * DEG2RAD
  const cosTilt = Math.cos(tilt)
  const sinTilt = Math.sin(tilt)

  const spectralColors = [
    new THREE.Color('#CFE4FF'),
    new THREE.Color('#EEF4FF'),
    new THREE.Color('#FFFFFF'),
    new THREE.Color('#FFF4DE'),
    new THREE.Color('#FFD9A0'),
  ]

  for (let i = 0; i < starCount; i++) {
    const isBand = rand() < 0.44
    let x: number
    let y: number
    let z: number

    if (isBand) {
      const az = rand() * Math.PI * 2
      const u1 = Math.max(1e-6, rand())
      const u2 = rand()
      const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
      const lat = clamp(gauss * 0.22, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02)
      const gx = Math.cos(lat) * Math.cos(az)
      const gy = Math.sin(lat)
      const gz = Math.cos(lat) * Math.sin(az)
      x = gx
      y = gy * cosTilt - gz * sinTilt
      z = gy * sinTilt + gz * cosTilt
    } else {
      const u = rand() * 2 - 1
      const az = rand() * Math.PI * 2
      const s = Math.sqrt(Math.max(0, 1 - u * u))
      x = s * Math.cos(az)
      y = u
      z = s * Math.sin(az)
    }

    const r = 560 + rand() * 300
    positions[i * 3] = x * r
    positions[i * 3 + 1] = y * r
    positions[i * 3 + 2] = z * r

    const specIdx = Math.min(
      spectralColors.length - 1,
      Math.floor(Math.pow(rand(), 0.85) * spectralColors.length),
    )
    const c = spectralColors[specIdx]
    const brightness = 0.42 + Math.pow(rand(), 2.2) * 0.58
    colors[i * 3] = c.r * brightness
    colors[i * 3 + 1] = c.g * brightness
    colors[i * 3 + 2] = c.b * brightness

    const basePx = 1.2 + Math.pow(rand(), 3.6) * 2.9
    sizes[i] = basePx * Math.min(2, pixelRatio)
  }

  const planets: Array<{ lat: number; lon: number; color: string; size: number }> = [
    { lat: 14, lon: -42, color: '#FFF7DF', size: 4.8 },
    { lat: -11, lon: 118, color: '#FFBA8C', size: 4.2 },
    { lat: 19, lon: 48, color: '#FFE6B8', size: 4.6 },
    { lat: -17, lon: -146, color: '#B7DEFF', size: 3.9 },
  ]
  for (let p = 0; p < planets.length; p++) {
    const idx = starCount + p
    const pl = planets[p]
    const [px, py, pz] = latLonToUnitVec3(pl.lat, pl.lon)
    positions[idx * 3] = px * 620
    positions[idx * 3 + 1] = py * 620
    positions[idx * 3 + 2] = pz * 620
    const col = new THREE.Color(pl.color)
    colors[idx * 3] = col.r
    colors[idx * 3 + 1] = col.g
    colors[idx * 3 + 2] = col.b
    sizes[idx] = pl.size * Math.min(2, pixelRatio)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))

  const material = new THREE.ShaderMaterial({
    vertexShader: STAR_VERTEX_SHADER,
    fragmentShader: STAR_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })

  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false
  points.renderOrder = -10
  return { points, geometry, material }
}

function createMercatorPatchGeometry(
  z: number,
  tx: number,
  ty: number,
): { geometry: THREE.BufferGeometry; anchor: THREE.Vector3 } {
  const n = 1 << z
  // Dense curved tessellation (<= 1.6° quads at z=3..5) eliminates Mercator-to-sphere
  // text warping across triangles and minimizes chord sagitta.
  const seg = z <= 3 ? 28 : z === 4 ? 16 : z === 5 ? 10 : z <= 7 ? 8 : z <= 9 ? 6 : 4
  const stride = seg + 1
  const vertexCount = stride * stride
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)

  // Mathematically exact chord clearance radius so every interior patch triangle stays
  // strictly outside earthGeo (r <= 1.0) at z=3..9 while tapering to 0.000px parallax at z>=10.
  const tileSpanDeg = 360 / n
  const stepRad = (tileSpanDeg / seg) * DEG2RAD
  const halfDiagRad = stepRad * Math.SQRT1_2
  const sagittaLift = PATCH_RADIUS * (1 / Math.cos(halfDiagRad) - 1)
  const depthMargin = z <= 5 ? 0.00018 : z <= 7 ? 0.00008 : z <= 9 ? 0.000015 : 0
  const patchRadius = PATCH_RADIUS + sagittaLift * 1.35 + depthMargin

  // Float64 RTC anchor at tile center -> sub-millimeter Float32 accuracy up to z=18 (P9)
  const centerLat = mercYNormToLat((ty + 0.5) / n)
  const centerLon = ((tx + 0.5) / n) * 360 - 180
  const [ax, ay, az] = latLonToUnitVec3(centerLat, centerLon)
  const anchorX = ax * patchRadius
  const anchorY = ay * patchRadius
  const anchorZ = az * patchRadius

  let vi = 0
  let ui = 0
  for (let iv = 0; iv <= seg; iv++) {
    const v = iv / seg
    const mercY = (ty + (1 - v)) / n
    const lat = mercYNormToLat(mercY)
    for (let iu = 0; iu <= seg; iu++) {
      const u = iu / seg
      const lon = ((tx + u) / n) * 360 - 180
      const [nx, ny, nz] = latLonToUnitVec3(lat, lon)
      positions[vi] = nx * patchRadius - anchorX
      positions[vi + 1] = ny * patchRadius - anchorY
      positions[vi + 2] = nz * patchRadius - anchorZ
      normals[vi] = nx
      normals[vi + 1] = ny
      normals[vi + 2] = nz
      uvs[ui] = u
      uvs[ui + 1] = v
      vi += 3
      ui += 2
    }
  }

  const indices: number[] = []
  for (let iv = 0; iv < seg; iv++) {
    for (let iu = 0; iu < seg; iu++) {
      const i00 = iv * stride + iu
      const i10 = i00 + 1
      const i01 = i00 + stride
      const i11 = i01 + 1
      indices.push(i00, i10, i11)
      indices.push(i00, i11, i01)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  return { geometry, anchor: new THREE.Vector3(anchorX, anchorY, anchorZ) }
}

/**
 * Span-proportional sagitta clearance lift for curved geohash fills & lines:
 * - Clears every central-sphere facet on wide P1–P3 cells (zero sawtooth clipping),
 * - Tapers cleanly to 0.0 on P6–P9 so high-precision cells keep 0.000px radial parallax.
 */
function getSurfaceLiftForSpan(spanDeg: number): number {
  if (spanDeg > 0.5) {
    return clamp(spanDeg * 0.00004, 0.00012, 0.0014)
  }
  if (spanDeg > 0.02) {
    return 0.00004
  }
  return 0
}

function pushCurvedRectSegments(
  out: number[],
  latMin: number,
  latMax: number,
  lonMin: number,
  lonMax: number,
  radius: number,
  anchor: readonly [number, number, number] = [0, 0, 0],
): void {
  const cLatMin = clamp(latMin, -89.5, 89.5)
  const cLatMax = clamp(latMax, -89.5, 89.5)
  const latSpan = Math.abs(cLatMax - cLatMin)
  const lonSpan = Math.abs(lonMax - lonMin)
  const span = Math.max(latSpan, lonSpan)
  const latSteps = Math.max(2, Math.min(28, Math.ceil(latSpan / 1.8)))
  const lonSteps = Math.max(2, Math.min(28, Math.ceil(lonSpan / 1.8)))
  const lift = getSurfaceLiftForSpan(span)
  const r = radius + lift + (span > 0.5 ? 0.00004 : 0)
  const [ax, ay, az] = anchor

  const pushArc = (la0: number, lo0: number, la1: number, lo1: number, steps: number) => {
    let prev = latLonToUnitVec3(la0, lo0)
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const curr = latLonToUnitVec3(la0 + (la1 - la0) * t, lo0 + (lo1 - lo0) * t)
      out.push(
        prev[0] * r - ax,
        prev[1] * r - ay,
        prev[2] * r - az,
        curr[0] * r - ax,
        curr[1] * r - ay,
        curr[2] * r - az,
      )
      prev = curr
    }
  }

  pushArc(cLatMin, lonMin, cLatMin, lonMax, lonSteps)
  pushArc(cLatMin, lonMax, cLatMax, lonMax, latSteps)
  pushArc(cLatMax, lonMax, cLatMax, lonMin, lonSteps)
  pushArc(cLatMax, lonMin, cLatMin, lonMin, latSteps)
}

function buildCurvedRectFillGeometry(
  boxes: Array<{ latMin: number; latMax: number; lonMin: number; lonMax: number }>,
  radius: number,
  anchor: readonly [number, number, number] = [0, 0, 0],
): THREE.BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []
  const [ax, ay, az] = anchor
  let baseVertex = 0

  for (const box of boxes) {
    const latMin = clamp(box.latMin, -89.5, 89.5)
    const latMax = clamp(box.latMax, -89.5, 89.5)
    const latSpan = Math.abs(latMax - latMin)
    const lonSpan = Math.abs(box.lonMax - box.lonMin)
    const span = Math.max(latSpan, lonSpan)
    const segLat = Math.max(2, Math.min(28, Math.ceil(latSpan / 1.8)))
    const segLon = Math.max(2, Math.min(28, Math.ceil(lonSpan / 1.8)))
    const stride = segLon + 1
    const r = radius + getSurfaceLiftForSpan(span)

    for (let iv = 0; iv <= segLat; iv++) {
      const lat = latMin + ((latMax - latMin) * iv) / segLat
      for (let iu = 0; iu <= segLon; iu++) {
        const lon = box.lonMin + ((box.lonMax - box.lonMin) * iu) / segLon
        const [x, y, z] = latLonToUnitVec3(lat, lon)
        positions.push(x * r - ax, y * r - ay, z * r - az)
      }
    }

    for (let iv = 0; iv < segLat; iv++) {
      for (let iu = 0; iu < segLon; iu++) {
        const i00 = baseVertex + iv * stride + iu
        const i10 = i00 + 1
        const i01 = i00 + stride
        const i11 = i01 + 1
        indices.push(i00, i10, i11, i00, i11, i01)
      }
    }
    baseVertex += (segLat + 1) * stride
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  return geometry
}

function buildCurvedTeleportArcGeometry(
  from: GeoCoords,
  to: GeoCoords,
): THREE.BufferGeometry {
  const a = latLonToVec3(from.lat, from.lon, 1).normalize()
  const b = latLonToVec3(to.lat, to.lon, 1).normalize()
  const dot = clamp(a.dot(b), -1, 1)
  const omega = Math.acos(dot)
  const steps = 40
  const maxLift = clamp(omega * 0.09, 0.006, 0.22)
  const positions = new Float32Array((steps + 1) * 3)

  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    let p: THREE.Vector3
    if (omega < 1e-4) {
      p = a.clone().lerp(b, t).normalize()
    } else {
      const sinOmega = Math.sin(omega)
      const w0 = Math.sin((1 - t) * omega) / sinOmega
      const w1 = Math.sin(t * omega) / sinOmega
      p = a.clone().multiplyScalar(w0).addScaledVector(b, w1).normalize()
    }
    const r = FOCUS_LINE_RADIUS + Math.sin(t * Math.PI) * maxLift
    positions[i * 3] = p.x * r
    positions[i * 3 + 1] = p.y * r
    positions[i * 3 + 2] = p.z * r
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return geometry
}

function disposeMaterialSafe(mat: THREE.Material): void {
  const basic = mat as THREE.MeshBasicMaterial
  if (basic.map && !basic.map.userData?.cached) {
    basic.map.dispose()
  }
  const shader = mat as THREE.ShaderMaterial
  const uMap = shader.uniforms?.uMap?.value as THREE.Texture | undefined
  if (uMap && !uMap.userData?.cached) {
    uMap.dispose()
  }
  mat.dispose()
}

function disposeObject3D(obj: THREE.Object3D | null): void {
  if (!obj) return
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.geometry) {
      mesh.geometry.dispose()
    }
    const mat = mesh.material
    if (Array.isArray(mat)) {
      for (const m of mat) disposeMaterialSafe(m)
    } else if (mat) {
      disposeMaterialSafe(mat)
    }
  })
}

// ---------------------------------------------------------------------------
// Internal Types for Bubbles, Pins, Asteroids, Patches & Camera
// ---------------------------------------------------------------------------

interface QueuedGlobeBubble {
  key: string
  geohash: string
  sender: string
  snippet: string
  tsMs: number
  demotedAtMs: number | null
  fadingOut: boolean
  fadeStartedAtMs: number | null
}

interface GlobeBubbleStackRender {
  geohash: string // canonical channelKey ('9q8y', 'mars:s000', or 'topic:nostr')
  rawGeohash: string // bare base32 geohash (or rolled-up parent prefix) on focused body
  targetChannelKey: string
  displayTag: string // '#9q8y', '#dr (3)', '#mars:s000', or '#nostr'
  isTopic: boolean
  isRollup: boolean
  center: GeoCoords
  bubbles: QueuedGlobeBubble[]
  latestTsMs: number
  isFocused: boolean
}

interface PulseRoomOnBody extends PulseRoom {
  rawGeohash: string
}

interface DisplayPulseRoom extends PulseRoomOnBody {
  targetChannelKey: string
  isRollup: boolean
  rollupCount: number
}

function buildRolledUpPulseRooms(
  rooms: PulseRoomOnBody[],
  bodyId: GeohashableBodyId,
  maxPrecision: number,
): DisplayPulseRoom[] {
  if (rooms.length === 0 || maxPrecision <= 0) return []
  if (maxPrecision >= 9) {
    return rooms.map((r) => ({
      ...r,
      targetChannelKey: r.geohash,
      isRollup: false,
      rollupCount: 1,
    }))
  }

  const buckets = new Map<string, PulseRoomOnBody[]>()
  for (const r of rooms) {
    if (!r.rawGeohash) continue
    const parentGh =
      r.rawGeohash.length > maxPrecision ? r.rawGeohash.slice(0, maxPrecision) : r.rawGeohash
    const list = buckets.get(parentGh)
    if (list) list.push(r)
    else buckets.set(parentGh, [r])
  }

  const out: DisplayPulseRoom[] = []
  for (const [parentGh, members] of buckets.entries()) {
    members.sort(
      (a, b) => (b.lastMessageAt ?? b.lastActivityAt) - (a.lastMessageAt ?? a.lastActivityAt),
    )
    const freshest = members[0]
    const hasDeepChild = members.some((m) => m.rawGeohash.length > maxPrecision)

    if (!hasDeepChild && members.length === 1) {
      out.push({
        ...freshest,
        targetChannelKey: freshest.geohash,
        isRollup: false,
        rollupCount: 1,
      })
      continue
    }

    if (members.length === 1) {
      // Single deep child rolled up into parentGh: keep real city center & fly directly to child
      out.push({
        ...freshest,
        rawGeohash: parentGh,
        peerCount: Math.max(1, freshest.peerCount),
        targetChannelKey: freshest.geohash,
        isRollup: true,
        rollupCount: 1,
      })
      continue
    }

    // 2+ rooms merged under parentGh (children +/- direct parent room)
    const parentCanonical = makeCelestialChannelKey(bodyId, parentGh) ?? parentGh
    let totalPeers = 0
    let totalMessages = 0
    let maxActivity = 0
    let maxMessageAt: number | undefined
    for (const m of members) {
      totalPeers += Math.max(0, m.peerCount)
      totalMessages += Math.max(0, m.messageCount)
      if (m.lastActivityAt > maxActivity) maxActivity = m.lastActivityAt
      if (
        m.lastMessageAt !== undefined &&
        (maxMessageAt === undefined || m.lastMessageAt > maxMessageAt)
      ) {
        maxMessageAt = m.lastMessageAt
      }
    }

    out.push({
      ...freshest,
      geohash: parentCanonical,
      rawGeohash: parentGh,
      center: decodeCenter(parentGh),
      peerCount: Math.max(1, totalPeers),
      messageCount: Math.max(freshest.messageCount, totalMessages),
      lastActivityAt: maxActivity || freshest.lastActivityAt,
      lastMessageAt: maxMessageAt ?? freshest.lastMessageAt,
      targetChannelKey: parentCanonical,
      isRollup: true,
      rollupCount: members.length,
    })
  }

  out.sort(
    (a, b) => (b.lastMessageAt ?? b.lastActivityAt) - (a.lastMessageAt ?? a.lastActivityAt),
  )
  return out
}

interface EarthPinRenderItem {
  channelKey: string // canonical key ('9q8y' or 'mars:s000')
  geohash: string // bare base32 geohash on focused body
  center: GeoCoords
  unreadCount: number
  mentionCount: number
  isActive: boolean
  isSelected: boolean
}

interface EarthPinRuntimeEntry {
  channelKey: string
  rawGeohash: string
  root: THREE.Group
  normal: THREE.Vector3
  headTipY: number
  scaleBoost: number
  hitMesh: THREE.Mesh
}

interface SolarBodyRuntimeEntry {
  id: CelestialBodyId
  def: CelestialBodyDef
  root: THREE.Group
  material: THREE.ShaderMaterial | null
  hitMesh: THREE.Mesh
  worldPos: THREE.Vector3
  renderRadius: number
  isChildMoon: boolean
  isParentOfFocused: boolean
  isSiblingMoon: boolean
  isPlanet: boolean
  isSun: boolean
}

interface TopicAsteroidRenderItem {
  channelKey: string
  slug: string
  spec: TopicAsteroidSpec
  isPinned: boolean
  isLive: boolean
  isActive: boolean
  isSelected: boolean
  peerCount: number
  messageCount: number
  unreadCount: number
  mentionCount: number
}

interface AsteroidRuntimeEntry {
  channelKey: string
  slug: string
  spec: TopicAsteroidSpec
  root: THREE.Group
  rockMesh: THREE.Mesh
  rockMaterial: THREE.ShaderMaterial
  pinBeaconGroup: THREE.Group | null
  hitMesh: THREE.Mesh
  orbitLine: THREE.LineLoop | null
  orbitMaterial: THREE.LineBasicMaterial | null
  spinAxis: THREE.Vector3
  worldPos: THREE.Vector3
  isPinned: boolean
  isPinFocused: boolean
  isLive: boolean
}

interface PatchTileCacheEntry {
  key: string
  z: number
  tx: number
  ty: number
  kind: 'dark' | 'light'
  mesh: THREE.Mesh
  geometry: THREE.BufferGeometry
  material: THREE.ShaderMaterial
  texture: THREE.CanvasTexture
  canvas: HTMLCanvasElement
  loaded: boolean
  lastUsedMs: number
}

interface CameraState {
  lat: number
  lon: number
  zoom: number
  targetLat: number
  targetLon: number
  targetZoom: number
  velLat: number
  velLon: number
  isFlying: boolean
  dragging: boolean
  wheelAnchor: WheelZoomAnchor | null
}

// ---------------------------------------------------------------------------
// Main 3D Three.js Earth Globe + Push-Pins + Topic Asteroid Belt Component
// ---------------------------------------------------------------------------

export const TacticalGeohashMap = forwardRef<TacticalGeohashMapHandle, TacticalGeohashMapProps>(
  function TacticalGeohashMap(
    {
      mode,
      theme,
      activeGeohash,
      selectedGeohash,
      precisionMode,
      showSubZones,
      showPulse,
      showBubbles = true,
      pulseRooms,
      pinnedChannels,
      topicRooms,
      extraTopicKeys,
      activeChannelKey,
      selectedChannelKey,
      focusedBodyId,
      onFocusBodyChange,
      userCoords,
      isTeleported,
      onSelectGeohash,
      onTuneGeohash,
      onSelectChannel,
      onTuneChannel,
      onViewportInfoChange,
      onVisibleLiveCountChange,
      onWebglError,
      className = '',
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null)
    const canvasWrapRef = useRef<HTMLDivElement | null>(null)

    const [webglError, setWebglError] = useState(false)
    const [hoverHud, setHoverHud] = useState<{
      geohash: string
      coords: string
      noHash?: boolean
    } | null>(null)
    const [viewportTick, setViewportTick] = useState(0)
    const [bubbleStacks, setBubbleStacks] = useState<GlobeBubbleStackRender[]>([])
    const [bubbleNowMs, setBubbleNowMs] = useState<number>(() => Date.now())
    const [internalBodyId, setInternalBodyId] = useState<GeohashableBodyId>(
      () => focusedBodyId ?? parseCelestialChannelKey(activeChannelKey ?? activeGeohash)?.bodyId ?? 'earth',
    )

    const activeBodyId: GeohashableBodyId = focusedBodyId ?? internalBodyId

    const effectiveActiveKey = (activeChannelKey ?? activeGeohash ?? '').trim().toLowerCase()
    const effectiveSelectedKey =
      (selectedChannelKey !== undefined ? selectedChannelKey : selectedGeohash)
        ?.trim()
        .toLowerCase() || null

    const parsedActiveCell = parseCelestialChannelKey(effectiveActiveKey || activeGeohash)
    const parsedSelectedCell = parseCelestialChannelKey(effectiveSelectedKey ?? selectedGeohash)

    const activeGeohashOnBody =
      parsedActiveCell && parsedActiveCell.bodyId === activeBodyId ? parsedActiveCell.geohash : null
    const selectedGeohashOnBody =
      parsedSelectedCell && parsedSelectedCell.bodyId === activeBodyId
        ? parsedSelectedCell.geohash
        : null

    const safeActiveGeohash =
      activeGeohashOnBody ?? (activeBodyId === 'earth' ? '9q8y' : '')

    // Keep fresh callbacks & reactive props in refs for rAF & Three.js event listeners
    const onSelectRef = useRef(onSelectGeohash)
    const onTuneRef = useRef(onTuneGeohash)
    const onSelectChannelRef = useRef(onSelectChannel)
    const onTuneChannelRef = useRef(onTuneChannel)
    const onViewportInfoRef = useRef(onViewportInfoChange)
    const onVisibleLiveCountRef = useRef(onVisibleLiveCountChange)
    const onWebglErrorRef = useRef(onWebglError)
    const onFocusBodyChangeRef = useRef(onFocusBodyChange)
    const precisionModeRef = useRef(precisionMode)
    const modeRef = useRef(mode)
    const themeRef = useRef(theme)
    const activeBodyIdRef = useRef<GeohashableBodyId>(activeBodyId)
    const prevBodyIdRef = useRef<GeohashableBodyId>(activeBodyId)
    const lastFlyBodyRef = useRef<GeohashableBodyId | null>(null)
    const prevActiveKeyRef = useRef(effectiveActiveKey)
    const activeGeohashRef = useRef<string | null>(activeGeohashOnBody)
    const selectedGeohashRef = useRef<string | null>(selectedGeohashOnBody)
    const activeChannelKeyRef = useRef(effectiveActiveKey)
    const selectedChannelKeyRef = useRef(effectiveSelectedKey)
    const showSubZonesRef = useRef(showSubZones)
    const showPulseRef = useRef(showPulse)
    const showBubblesRef = useRef(showBubbles)
    const userCoordsRef = useRef(userCoords)

    useEffect(() => {
      onSelectRef.current = onSelectGeohash
      onTuneRef.current = onTuneGeohash
      onSelectChannelRef.current = onSelectChannel
      onTuneChannelRef.current = onTuneChannel
      onViewportInfoRef.current = onViewportInfoChange
      onVisibleLiveCountRef.current = onVisibleLiveCountChange
      onWebglErrorRef.current = onWebglError
      onFocusBodyChangeRef.current = onFocusBodyChange
      precisionModeRef.current = precisionMode
      modeRef.current = mode
      themeRef.current = theme
      activeBodyIdRef.current = activeBodyId
      activeGeohashRef.current = activeGeohashOnBody
      selectedGeohashRef.current = selectedGeohashOnBody
      activeChannelKeyRef.current = effectiveActiveKey
      selectedChannelKeyRef.current = effectiveSelectedKey
      showSubZonesRef.current = showSubZones
      showPulseRef.current = showPulse
      showBubblesRef.current = showBubbles
      userCoordsRef.current = userCoords
    }, [
      onSelectGeohash,
      onTuneGeohash,
      onSelectChannel,
      onTuneChannel,
      onViewportInfoChange,
      onVisibleLiveCountChange,
      onWebglError,
      onFocusBodyChange,
      precisionMode,
      mode,
      theme,
      activeBodyId,
      activeGeohashOnBody,
      selectedGeohashOnBody,
      effectiveActiveKey,
      effectiveSelectedKey,
      showSubZones,
      showPulse,
      showBubbles,
      userCoords,
    ])

    const emitSelectChannel = useCallback((channelKey: string) => {
      if (onSelectChannelRef.current) {
        onSelectChannelRef.current(channelKey)
      } else if (!isTopicChannel(channelKey) && parseCelestialChannelKey(channelKey)) {
        onSelectRef.current(channelKey)
      }
    }, [])

    const emitTuneChannel = useCallback((channelKey: string) => {
      if (onTuneChannelRef.current) {
        onTuneChannelRef.current(channelKey)
      } else if (onTuneRef.current) {
        onTuneRef.current(channelKey)
      }
    }, [])

    // Initial wide camera framing in expanded mode so the focused world, push-pins, & orbiting bodies are immediately visible
    const initialCamCenter = safeActiveGeohash
      ? decodeCenter(safeActiveGeohash)
      : { lat: 14, lon: 0 }
    const initialCamZoom = clamp(
      mode === 'compact'
        ? Math.max(2, getZoomForPrecision(Math.max(1, safeActiveGeohash.length)) - 1)
        : Math.min(getZoomForPrecision(Math.max(1, safeActiveGeohash.length)), 2.15),
      MIN_VIRTUAL_ZOOM,
      MAX_VIRTUAL_ZOOM,
    )
    const [surfaceLodPrecision, setSurfaceLodPrecision] = useState<number>(() =>
      getMaxVisibleSurfacePrecision(initialCamZoom),
    )
    const lastSurfaceLodRef = useRef<number>(getMaxVisibleSurfacePrecision(initialCamZoom))
    const lastVisibleLiveCountRef = useRef<number>(-1)

    const cameraStateRef = useRef<CameraState>({
      lat: initialCamCenter.lat,
      lon: initialCamCenter.lon,
      zoom: initialCamZoom,
      targetLat: initialCamCenter.lat,
      targetLon: initialCamCenter.lon,
      targetZoom: initialCamZoom,
      velLat: 0,
      velLon: 0,
      isFlying: false,
      dragging: false,
      wheelAnchor: null,
    })

    const sceneRefs = useRef<{
      scene: THREE.Scene
      camera: THREE.PerspectiveCamera
      renderer: THREE.WebGLRenderer
      earthMesh: THREE.Mesh
      earthMaterial: THREE.ShaderMaterial
      planetCentralMaterial: THREE.ShaderMaterial
      baseCanvas: HTMLCanvasElement
      baseTexture: THREE.CanvasTexture
      sunDir: THREE.Vector3
      sunGroup: THREE.Group
      sunHitMesh: THREE.Mesh
      atmosphereMesh: THREE.Mesh
      atmosphereMaterial: THREE.ShaderMaterial
      centralRingGroup: THREE.Group
      solarSystemGroup: THREE.Group
      planetOrbitGroup: THREE.Group
      moonOrbitGroup: THREE.Group
      planetOrbitMats: Map<CelestialBodyId, THREE.LineBasicMaterial>
      moonOrbitMats: THREE.LineBasicMaterial[]
      patchGroup: THREE.Group
      patchCache: Map<string, PatchTileCacheEntry>
      gridGroup: THREE.Group
      subZoneGroup: THREE.Group
      pulseGroup: THREE.Group
      focusGroup: THREE.Group
      hoverGroup: THREE.Group
      gpsGroup: THREE.Group
      pinGroup: THREE.Group
      asteroidGroup: THREE.Group
      asteroidOrbitGroup: THREE.Group
      snapshot: SolarSystemSnapshot
      tileKind: 'dark' | 'light'
      baseLoadGen: number
      hoveredGeohash: string | null
      hoveredAsteroidKey: string | null
      hoveredBodyId: CelestialBodyId | null
      orbitClockSec: number
      scheduleViewportEmit: () => void
      reloadBaseTiles: (kind: 'dark' | 'light') => void
      updatePatchTiles: () => void
      updateHoverMesh: (gh: string | null) => void
      rebuildSolarSystem: (bodyId: GeohashableBodyId, now?: Date) => SolarSystemSnapshot
      updateSolarPositions: (now?: Date) => void
    } | null>(null)

    // Runtime 3D maps for pins, orbiting asteroids, & Solar System bodies (mutated in-place inside rAF)
    const pinEntriesRef = useRef<Map<string, EarthPinRuntimeEntry>>(new Map())
    const asteroidEntriesRef = useRef<Map<string, AsteroidRuntimeEntry>>(new Map())
    // Persistent asteroid orbital & rotation motion state (NEVER reset on pulse/prop updates!)
    const asteroidMotionRef = useRef<Map<string, { orbitElapsedSec: number; spinAngle: number }>>(
      new Map(),
    )
    const bodyEntriesRef = useRef<Map<CelestialBodyId, SolarBodyRuntimeEntry>>(new Map())
    const pinCountByBodyRef = useRef<Map<GeohashableBodyId, number>>(new Map())

    // Projected DOM overlay refs (updated directly in rAF for zero-re-render 60fps positioning)
    const bubbleStackElsRef = useRef<Map<string, HTMLDivElement>>(new Map())
    const beaconElsRef = useRef<Map<string, HTMLButtonElement>>(new Map())
    const pinChipElsRef = useRef<Map<string, HTMLButtonElement>>(new Map())
    const asteroidChipElsRef = useRef<Map<string, HTMLButtonElement>>(new Map())
    const bodyChipElsRef = useRef<Map<CelestialBodyId, HTMLButtonElement>>(new Map())
    const activePillElRef = useRef<HTMLDivElement | null>(null)
    const selectedPillElRef = useRef<HTMLDivElement | null>(null)
    const gpsBeaconElRef = useRef<HTMLDivElement | null>(null)
    const rimLayerRef = useRef<HTMLDivElement | null>(null)
    const rimLeftBtnRef = useRef<HTMLButtonElement | null>(null)
    const rimLeftDotRef = useRef<HTMLSpanElement | null>(null)
    const rimLeftTagRef = useRef<HTMLSpanElement | null>(null)
    const rimLeftMetaRef = useRef<HTMLSpanElement | null>(null)
    const rimLeftMoreRef = useRef<HTMLSpanElement | null>(null)
    const rimRightBtnRef = useRef<HTMLButtonElement | null>(null)
    const rimRightDotRef = useRef<HTMLSpanElement | null>(null)
    const rimRightTagRef = useRef<HTMLSpanElement | null>(null)
    const rimRightMetaRef = useRef<HTMLSpanElement | null>(null)
    const rimRightMoreRef = useRef<HTMLSpanElement | null>(null)
    const rimTargetKeyRef = useRef<{ left: string; right: string }>({ left: '', right: '' })
    const rimRenderCacheRef = useRef<{
      left: {
        visible: boolean
        topPx: number
        warmth: BeaconWarmthClass | ''
        tag: string
        meta: string
        more: string
        key: string
        count: number
      }
      right: {
        visible: boolean
        topPx: number
        warmth: BeaconWarmthClass | ''
        tag: string
        meta: string
        more: string
        key: string
        count: number
      }
    }>({
      left: { visible: false, topPx: -1, warmth: '', tag: '', meta: '', more: '', key: '', count: 0 },
      right: { visible: false, topPx: -1, warmth: '', tag: '', meta: '', more: '', key: '', count: 0 },
    })
    const bubbleStacksRef = useRef<GlobeBubbleStackRender[]>([])
    const rawPulseRoomsRef = useRef<PulseRoomOnBody[]>([])
    const visiblePulseRoomsRef = useRef<DisplayPulseRoom[]>([])

    // Per-channel queue state for upward-sliding speech bubbles (Earth geohashes + Topic asteroids)
    const bubbleQueuesRef = useRef<Map<string, QueuedGlobeBubble[]>>(new Map())
    const evictedBubbleKeysRef = useRef<Map<string, Set<string>>>(new Map())
    const seededRoomsRef = useRef<Set<string>>(new Set())

    const validPulseRooms = useMemo<PulseRoomOnBody[]>(() => {
      if (!showPulse) return []
      const out: PulseRoomOnBody[] = []
      const limit = mode === 'compact' ? 24 : 48
      for (const r of pulseRooms) {
        if (out.length >= limit) break
        if (isTopicChannel(r.geohash)) continue
        const parsed = parseCelestialChannelKey(r.geohash)
        if (!parsed || parsed.bodyId !== activeBodyId) continue
        const canonical = makeCelestialChannelKey(parsed.bodyId, parsed.geohash)
        if (!canonical) continue
        out.push({
          ...r,
          geohash: canonical,
          rawGeohash: parsed.geohash,
          center: r.center ?? decodeCenter(parsed.geohash),
        })
      }
      return out
    }, [showPulse, pulseRooms, mode, activeBodyId])

    const validTopicRooms = useMemo(() => {
      if (!showPulse || activeBodyId !== 'earth') return []
      const byKey = new Map<string, PulseRoom>()
      for (const r of topicRooms ?? []) {
        if (!isTopicChannel(r.geohash)) continue
        const key = makeTopicChannelKey(r.geohash)
        if (key && !byKey.has(key)) byKey.set(key, { ...r, geohash: key })
      }
      // Also pick up any topic rooms passed via pulseRooms
      for (const r of pulseRooms) {
        if (!isTopicChannel(r.geohash)) continue
        const key = makeTopicChannelKey(r.geohash)
        if (key && !byKey.has(key)) byKey.set(key, { ...r, geohash: key })
      }
      return Array.from(byKey.values()).slice(0, 32)
    }, [showPulse, topicRooms, pulseRooms, activeBodyId])

      const pinCountByBody = useMemo(() => {
        const counts = new Map<GeohashableBodyId, number>()
        for (const pin of pinnedChannels ?? []) {
          const bodyId = getChannelBodyId(pin.geohash)
          if (bodyId) {
            counts.set(bodyId, (counts.get(bodyId) ?? 0) + 1)
          }
        }
        return counts
      }, [pinnedChannels])

      useEffect(() => {
        pinCountByBodyRef.current = pinCountByBody
      }, [pinCountByBody])

    const solarChipBodies = useMemo<CelestialBodyDef[]>(() => {
      const list: CelestialBodyDef[] = [SOLAR_BODIES.sun, SOLAR_BODIES[activeBodyId]]
      const seen = new Set<CelestialBodyId>(['sun', activeBodyId])
      const addBody = (id: CelestialBodyId) => {
        if (seen.has(id)) return
        seen.add(id)
        list.push(SOLAR_BODIES[id])
      }
      const focusedDef = SOLAR_BODIES[activeBodyId]
      if (focusedDef.kind === 'planet') {
        for (const m of getMoonsOfBody(activeBodyId)) addBody(m.id)
      } else if (focusedDef.kind === 'moon' && focusedDef.parentId) {
        addBody(focusedDef.parentId)
        for (const m of getMoonsOfBody(focusedDef.parentId)) addBody(m.id)
      }
      for (const pid of PLANET_BODY_IDS) addBody(pid)
      return list
    }, [activeBodyId])

    const pinnedEarthItems = useMemo<EarthPinRenderItem[]>(() => {
      if (!pinnedChannels || pinnedChannels.length === 0) return []
      const seen = new Set<string>()
      const out: EarthPinRenderItem[] = []
      for (const pin of pinnedChannels) {
        if (isTopicChannel(pin.geohash)) continue
        const parsed = parseCelestialChannelKey(pin.geohash)
        if (!parsed || parsed.bodyId !== activeBodyId) continue
        const channelKey = makeCelestialChannelKey(parsed.bodyId, parsed.geohash)
        if (!channelKey || seen.has(channelKey)) continue
        seen.add(channelKey)
        out.push({
          channelKey,
          geohash: parsed.geohash,
          center: decodeCenter(parsed.geohash),
          unreadCount: pin.unreadCount || 0,
          mentionCount: pin.mentionCount || 0,
          isActive: channelKey === effectiveActiveKey,
          isSelected: channelKey === effectiveSelectedKey,
        })
      }
      return out
    }, [pinnedChannels, activeBodyId, effectiveActiveKey, effectiveSelectedKey])

    const topicAsteroidItems = useMemo<TopicAsteroidRenderItem[]>(() => {
      const pinnedMap = new Map<string, PinnedChannel>()
      for (const p of pinnedChannels ?? []) {
        if (!isTopicChannel(p.geohash)) continue
        const key = makeTopicChannelKey(p.geohash)
        if (key) pinnedMap.set(key, p)
      }

      const liveMap = new Map<string, PulseRoom>()
      for (const r of validTopicRooms) {
        liveMap.set(r.geohash, r)
      }

      const orderedKeys: string[] = []
      const seen = new Set<string>()
      const addKey = (raw: string | null | undefined) => {
        if (!raw || !isTopicChannel(raw)) return
        const key = makeTopicChannelKey(raw)
        if (!key || seen.has(key)) return
        seen.add(key)
        orderedKeys.push(key)
      }

      for (const key of pinnedMap.keys()) addKey(key)
      for (const key of liveMap.keys()) addKey(key)
      addKey(effectiveActiveKey)
      addKey(effectiveSelectedKey)
      for (const raw of extraTopicKeys ?? []) addKey(raw)

      return orderedKeys.map((channelKey) => {
        const spec = computeTopicAsteroidSpec(channelKey)
        const pin = pinnedMap.get(channelKey)
        const live = liveMap.get(channelKey)
        return {
          channelKey,
          slug: spec.slug,
          spec,
          isPinned: Boolean(pin),
          isLive: Boolean(live),
          isActive: channelKey === effectiveActiveKey,
          isSelected: channelKey === effectiveSelectedKey,
          peerCount: live?.peerCount ?? 0,
          messageCount: live?.messageCount ?? 0,
          unreadCount: pin?.unreadCount ?? 0,
          mentionCount: pin?.mentionCount ?? 0,
        }
      })
    }, [
      pinnedChannels,
      validTopicRooms,
      effectiveActiveKey,
      effectiveSelectedKey,
      extraTopicKeys,
    ])

    const displayPulseRooms = useMemo<DisplayPulseRoom[]>(
      () => buildRolledUpPulseRooms(validPulseRooms, activeBodyId, surfaceLodPrecision),
      [validPulseRooms, activeBodyId, surfaceLodPrecision],
    )

    useEffect(() => {
      rawPulseRoomsRef.current = validPulseRooms
    }, [validPulseRooms])

    useEffect(() => {
      visiblePulseRoomsRef.current = displayPulseRooms
    }, [displayPulseRooms])

    useEffect(() => {
      bubbleStacksRef.current = bubbleStacks
    }, [bubbleStacks])

    const subZoneParent = useMemo(() => {
      if (!showSubZones) return null
      const candidate = selectedGeohashOnBody || activeGeohashOnBody
      return candidate && candidate.length < 9 ? candidate : null
    }, [showSubZones, selectedGeohashOnBody, activeGeohashOnBody])

    const allBubbleSourceRooms = useMemo<Array<DisplayPulseRoom | PulseRoom>>(
      () => [...displayPulseRooms, ...validTopicRooms],
      [displayPulseRooms, validTopicRooms],
    )
    const allBubbleSourceRoomsRef = useRef<Array<DisplayPulseRoom | PulseRoom>>(allBubbleSourceRooms)
    useEffect(() => {
      allBubbleSourceRoomsRef.current = allBubbleSourceRooms
    }, [allBubbleSourceRooms])

    const buildRenderStacks = useCallback(
      (rooms: Array<DisplayPulseRoom | PulseRoom>): GlobeBubbleStackRender[] => {
        const roomByKey = new Map<string, DisplayPulseRoom | PulseRoom>()
        for (const r of rooms) roomByKey.set(r.geohash, r)

        const out: GlobeBubbleStackRender[] = []
        const queues = bubbleQueuesRef.current
        for (const [key, list] of queues.entries()) {
          if (list.length === 0) continue
          const room = roomByKey.get(key)
          if (!room) continue
          const isTopic = isTopicChannel(key)
          const displayRoom = 'isRollup' in room ? room : null
          const rawGh = isTopic ? '' : (displayRoom?.rawGeohash ?? getChannelRawGeohash(key) ?? '')
          const targetKey = displayRoom?.targetChannelKey ?? key
          const targetRawGh = isTopic ? '' : (getChannelRawGeohash(targetKey) ?? rawGh)
          if (!isTopic && subZoneParent === targetRawGh) continue
          const latest = list[list.length - 1]
          const isFocused =
            key === effectiveActiveKey ||
            key === effectiveSelectedKey ||
            targetKey === effectiveActiveKey ||
            targetKey === effectiveSelectedKey
          const slug = isTopic ? getTopicSlug(key) : null
          const isMultiRollup = Boolean(displayRoom && displayRoom.isRollup && displayRoom.rollupCount >= 2)
          const displayTag = slug
            ? `#${slug}`
            : isMultiRollup && displayRoom
              ? `#${key} (${displayRoom.rollupCount})`
              : `#${key}`
          out.push({
            geohash: key,
            rawGeohash: rawGh,
            targetChannelKey: targetKey,
            displayTag,
            isTopic,
            isRollup: Boolean(displayRoom?.isRollup),
            center: room.center,
            bubbles: list.map((b) => ({ ...b })),
            latestTsMs: latest.tsMs,
            isFocused,
          })
        }

        out.sort((a, b) => {
          const aSel = a.geohash === effectiveSelectedKey ? 1 : 0
          const bSel = b.geohash === effectiveSelectedKey ? 1 : 0
          if (aSel !== bSel) return bSel - aSel
          const aAct = a.geohash === effectiveActiveKey ? 1 : 0
          const bAct = b.geohash === effectiveActiveKey ? 1 : 0
          if (aAct !== bAct) return bAct - aAct
          return b.latestTsMs - a.latestTsMs
        })
        return out
      },
      [effectiveActiveKey, effectiveSelectedKey, subZoneParent],
    )

    // Sync per-channel speech bubble queues (both Earth geohashes AND Topic asteroids)
    useEffect(() => {
      const queues = bubbleQueuesRef.current
      const evictedMap = evictedBubbleKeysRef.current
      const seeded = seededRoomsRef.current

      if (!showPulse || !showBubbles || allBubbleSourceRooms.length === 0) {
        if (queues.size > 0) queues.clear()
        setBubbleStacks([])
        return
      }

      const now = Date.now()
      const liveSet = new Set(allBubbleSourceRooms.map((r) => r.geohash))

      for (const key of Array.from(queues.keys())) {
        if (!liveSet.has(key)) {
          queues.delete(key)
          seeded.delete(key)
          evictedMap.delete(key)
        }
      }

      for (const room of allBubbleSourceRooms) {
        const key = room.geohash
        const isTopic = isTopicChannel(key)
        const targetKey = 'targetChannelKey' in room ? room.targetChannelKey : key
        const isFocused =
          key === effectiveActiveKey ||
          key === effectiveSelectedKey ||
          targetKey === effectiveActiveKey ||
          targetKey === effectiveSelectedKey
        const roomTs = room.lastMessageAt ?? room.lastActivityAt
        if (!isTopic && !isFocused && now - roomTs >= RECENT_BUBBLE_WINDOW_MS) {
          queues.delete(key)
          continue
        }
        const incoming: Array<{ key: string; sender: string; snippet: string; tsMs: number }> = []

        if (room.recentMessages && room.recentMessages.length > 0) {
          for (const msg of room.recentMessages) {
            const snippet = formatBubbleSnippet(msg.preview)
            if (!snippet) continue
            const msgKey = msg.id || `${msg.tsMs}:${snippet}`
            incoming.push({
              key: msgKey,
              sender: formatBubbleSender(msg.sender),
              snippet,
              tsMs: msg.tsMs,
            })
          }
        } else {
          const snippet = formatBubbleSnippet(room.lastPreview)
          if (snippet) {
            const tsMs = room.lastMessageAt ?? room.lastActivityAt
            const msgKey = room.lastMessageId || `${tsMs}:${snippet}`
            incoming.push({
              key: msgKey,
              sender: formatBubbleSender(room.lastSender),
              snippet,
              tsMs,
            })
          }
        }

        if (incoming.length === 0) continue
        incoming.sort((a, b) => a.tsMs - b.tsMs)
        const cappedIncoming = incoming.slice(-MAX_BUBBLES_PER_GEOHASH)

        let evicted = evictedMap.get(key)
        if (!evicted) {
          evicted = new Set<string>()
          evictedMap.set(key, evicted)
        }

        let queue = queues.get(key)
        if (!seeded.has(key) || !queue) {
          seeded.add(key)
          queue = []
          const latest = cappedIncoming[cappedIncoming.length - 1]
          const freshBurst = now - latest.tsMs < BUBBLE_DEMOTE_LIFETIME_MS
          if (freshBurst && cappedIncoming.length > 1) {
            for (let i = 0; i < cappedIncoming.length; i++) {
              const item = cappedIncoming[i]
              const isLast = i === cappedIncoming.length - 1
              queue.push({
                key: item.key,
                geohash: key,
                sender: item.sender,
                snippet: item.snippet,
                tsMs: item.tsMs,
                demotedAtMs: isLast ? null : now,
                fadingOut: false,
                fadeStartedAtMs: null,
              })
            }
          } else {
            for (let i = 0; i < cappedIncoming.length - 1; i++) {
              evicted.add(cappedIncoming[i].key)
            }
            queue.push({
              key: latest.key,
              geohash: key,
              sender: latest.sender,
              snippet: latest.snippet,
              tsMs: latest.tsMs,
              demotedAtMs: null,
              fadingOut: false,
              fadeStartedAtMs: null,
            })
          }
          queues.set(key, queue)
          continue
        }

        const existingKeys = new Set(queue.map((b) => b.key))
        const newlyArrived = cappedIncoming.filter(
          (item) => !existingKeys.has(item.key) && !evicted.has(item.key),
        )

        if (newlyArrived.length > 0) {
          for (const existing of queue) {
            if (existing.demotedAtMs === null) {
              existing.demotedAtMs = now
            }
          }
          for (let i = 0; i < newlyArrived.length; i++) {
            const item = newlyArrived[i]
            const isNewest = i === newlyArrived.length - 1
            queue.push({
              key: item.key,
              geohash: key,
              sender: item.sender,
              snippet: item.snippet,
              tsMs: item.tsMs,
              demotedAtMs: isNewest ? null : now,
              fadingOut: false,
              fadeStartedAtMs: null,
            })
          }
          while (queue.length > MAX_BUBBLES_PER_GEOHASH) {
            const dropped = queue.shift()
            if (dropped) evicted.add(dropped.key)
          }
          if (evicted.size > 64) {
            const keep = Array.from(evicted).slice(-32)
            evictedMap.set(key, new Set(keep))
          }
        }
      }

      setBubbleNowMs(now)
      setBubbleStacks(buildRenderStacks(allBubbleSourceRooms))
    }, [
      showPulse,
      showBubbles,
      allBubbleSourceRooms,
      buildRenderStacks,
      effectiveActiveKey,
      effectiveSelectedKey,
    ])

    // Live relative-age & warmth clock (ticks every 5s while bubbles or pulse rooms exist)
    const hasAnyLiveIndicators = bubbleStacks.length > 0 || validPulseRooms.length > 0
    useEffect(() => {
      if (!hasAnyLiveIndicators) return
      const timer = window.setInterval(() => {
        setBubbleNowMs(Date.now())
      }, 5_000)
      return () => window.clearInterval(timer)
    }, [hasAnyLiveIndicators])

    // 18s post-demotion fadeout & eviction ticker
    const hasDemotedBubbles = useMemo(
      () => bubbleStacks.some((s) => s.bubbles.some((b) => b.demotedAtMs !== null)),
      [bubbleStacks],
    )

    useEffect(() => {
      if (!hasDemotedBubbles) return
      const timer = window.setInterval(() => {
        const now = Date.now()
        const queues = bubbleQueuesRef.current
        const evictedMap = evictedBubbleKeysRef.current
        let mutated = false

        for (const [key, queue] of queues.entries()) {
          let evicted = evictedMap.get(key)
          if (!evicted) {
            evicted = new Set<string>()
            evictedMap.set(key, evicted)
          }
          for (let i = queue.length - 1; i >= 0; i--) {
            const b = queue[i]
            if (b.demotedAtMs === null) continue
            if (!b.fadingOut && now - b.demotedAtMs >= BUBBLE_DEMOTE_LIFETIME_MS) {
              b.fadingOut = true
              b.fadeStartedAtMs = now
              mutated = true
            } else if (
              b.fadingOut &&
              b.fadeStartedAtMs !== null &&
              now - b.fadeStartedAtMs >= BUBBLE_FADE_DURATION_MS
            ) {
              evicted.add(b.key)
              queue.splice(i, 1)
              mutated = true
            }
          }
        }

        if (mutated) {
          setBubbleStacks(buildRenderStacks(allBubbleSourceRoomsRef.current))
        }
      }, 220)

      return () => window.clearInterval(timer)
    }, [hasDemotedBubbles, buildRenderStacks])

    const startFlyTo = useCallback(
      (lat: number, lon: number, zoom: number, animate = true) => {
        const cam = cameraStateRef.current
        const clampedLat = clamp(lat, -82, 82)
        const clampedZoom = clamp(zoom, MIN_VIRTUAL_ZOOM, MAX_VIRTUAL_ZOOM)
        const dLon = wrapDeltaLon(lon - cam.lon)
        const nextLon = cam.lon + dLon

        cam.velLat = 0
        cam.velLon = 0
        cam.wheelAnchor = null

        if (!animate) {
          cam.lat = clampedLat
          cam.lon = nextLon
          cam.zoom = clampedZoom
          cam.targetLat = clampedLat
          cam.targetLon = nextLon
          cam.targetZoom = clampedZoom
          cam.isFlying = false
          sceneRefs.current?.scheduleViewportEmit()
        } else {
          cam.targetLat = clampedLat
          cam.targetLon = nextLon
          cam.targetZoom = clampedZoom
          cam.isFlying = true
        }
      },
      [],
    )

    const flyToSunlitFace = useCallback(
      (bodyId: GeohashableBodyId, animate = true, targetZoom = 1.95) => {
        const snap =
          sceneRefs.current && sceneRefs.current.snapshot.focusedBodyId === bodyId
            ? sceneRefs.current.snapshot
            : computeSolarSystemSnapshot(new Date(), bodyId)
        const sunLL = unitVec3ToLatLon(new THREE.Vector3(...snap.focusedSunDir))
        // Offset slightly off direct subsolar noon so the sunlit world shows sculptural terminator depth
        startFlyTo(
          clamp(sunLL.lat * 0.65 + 8, -38, 38),
          wrapLongitude(sunLL.lon - 22),
          targetZoom,
          animate,
        )
      },
      [startFlyTo],
    )

    const focusBodyInternal = useCallback(
      (bodyId: GeohashableBodyId, options?: { geohash?: string; animate?: boolean }) => {
        const animate = options?.animate !== false
        const changed = activeBodyIdRef.current !== bodyId
        lastFlyBodyRef.current = bodyId
        if (changed) {
          activeBodyIdRef.current = bodyId
          setInternalBodyId(bodyId)
          onFocusBodyChangeRef.current?.(bodyId)
        }
        const rawGh = options?.geohash
          ? (getChannelRawGeohash(options.geohash) ??
            (isValidGeohash(options.geohash) ? normalizeGeohash(options.geohash) : null))
          : null
        if (rawGh) {
          const center = decodeCenter(rawGh)
          const rawZoom =
            modeRef.current === 'compact'
              ? Math.max(2, getZoomForPrecision(rawGh.length) - 1)
              : Math.min(MAX_VIRTUAL_ZOOM, getZoomForPrecision(rawGh.length))
          startFlyTo(center.lat, center.lon, rawZoom, animate)
        } else {
          flyToSunlitFace(bodyId, animate, 1.95)
        }
      },
      [flyToSunlitFace, startFlyTo],
    )

    const fitSolarSystemInternal = useCallback(() => {
      // Align camera longitude with the Sun meridian so all 9 orbits sit symmetrically centered in viewport
      const snap = sceneRefs.current?.snapshot ?? computeSolarSystemSnapshot(new Date(), activeBodyIdRef.current)
      const sunLL = unitVec3ToLatLon(new THREE.Vector3(...snap.focusedSunDir))
      startFlyTo(32, wrapLongitude(sunLL.lon), -6.15, true)
    }, [startFlyTo])

    const flyToCellInternal = useCallback(
      (geohash: string, options?: { animate?: boolean; zoom?: number }) => {
        if (!geohash || isTopicChannel(geohash)) return
        const hasExplicitBody = geohash.includes(':')
        const parsed = parseCelestialChannelKey(geohash)
        const rawGh = parsed?.geohash ?? (isValidGeohash(geohash) ? normalizeGeohash(geohash) : null)
        if (!rawGh) return
        // Only switch focused world on explicit '<bodyId>:<geohash>' keys; bare geohashes stay on current world!
        const targetBody: GeohashableBodyId =
          hasExplicitBody && parsed ? parsed.bodyId : activeBodyIdRef.current
        if (targetBody !== activeBodyIdRef.current) {
          lastFlyBodyRef.current = targetBody
          activeBodyIdRef.current = targetBody
          setInternalBodyId(targetBody)
          onFocusBodyChangeRef.current?.(targetBody)
        }
        const center = decodeCenter(rawGh)
        const rawZoom =
          options?.zoom ??
          (modeRef.current === 'compact'
            ? Math.max(2, getZoomForPrecision(rawGh.length) - 1)
            : Math.min(MAX_VIRTUAL_ZOOM, getZoomForPrecision(rawGh.length)))
        startFlyTo(center.lat, center.lon, rawZoom, options?.animate !== false)
      },
      [startFlyTo],
    )

    const flyToTopicInternal = useCallback(
      (topicChannelKey: string, options?: { animate?: boolean }) => {
        const canonical = makeTopicChannelKey(topicChannelKey)
        if (!canonical) return
        if (activeBodyIdRef.current !== 'earth') {
          lastFlyBodyRef.current = 'earth'
          activeBodyIdRef.current = 'earth'
          setInternalBodyId('earth')
          onFocusBodyChangeRef.current?.('earth')
        }
        const liveEntry = asteroidEntriesRef.current.get(canonical)
        let wx: number
        let wy: number
        let wz: number
        if (liveEntry) {
          wx = liveEntry.worldPos.x
          wy = liveEntry.worldPos.y
          wz = liveEntry.worldPos.z
        } else {
          const spec = computeTopicAsteroidSpec(canonical)
          const elapsed = sceneRefs.current?.orbitClockSec ?? 0
          ;[wx, wy, wz] = computeAsteroidWorldPosition(spec, elapsed)
        }
        const dir = unitVec3ToLatLon(new THREE.Vector3(wx, wy, wz))
        // Frame the asteroid nicely in the foreground with Earth visible behind/beside it
        startFlyTo(clamp(dir.lat, -74, 74), dir.lon, 1.72, options?.animate !== false)
      },
      [startFlyTo],
    )

    useImperativeHandle(
      ref,
      () => ({
        zoomIn() {
          const cam = cameraStateRef.current
          cam.wheelAnchor = null
          cam.velLat = 0
          cam.velLon = 0
          cam.targetZoom = clamp(cam.targetZoom + 1.15, MIN_VIRTUAL_ZOOM, MAX_VIRTUAL_ZOOM)
          cam.isFlying = true
          cam.targetLat = cam.lat
          cam.targetLon = cam.lon
        },
        zoomOut() {
          const cam = cameraStateRef.current
          cam.wheelAnchor = null
          cam.velLat = 0
          cam.velLon = 0
          cam.targetZoom = clamp(cam.targetZoom - 1.15, MIN_VIRTUAL_ZOOM, MAX_VIRTUAL_ZOOM)
          cam.isFlying = true
          cam.targetLat = cam.lat
          cam.targetLon = cam.lon
        },
        flyToGeohash(geohash: string, options?: { animate?: boolean; zoom?: number }) {
          flyToCellInternal(geohash, options)
        },
        flyToTopic(topicChannelKey: string, options?: { animate?: boolean }) {
          flyToTopicInternal(topicChannelKey, options)
        },
        flyToCoords(lat: number, lon: number, zoom = 10.5) {
          startFlyTo(lat, lon, zoom, true)
        },
        fitWorld() {
          const cam = cameraStateRef.current
          startFlyTo(18, wrapLongitude(cam.lon), 0.85, true)
        },
        fitAsteroids() {
          if (activeBodyIdRef.current !== 'earth') {
            lastFlyBodyRef.current = 'earth'
            activeBodyIdRef.current = 'earth'
            setInternalBodyId('earth')
            onFocusBodyChangeRef.current?.('earth')
          }
          const cam = cameraStateRef.current
          startFlyTo(16, wrapLongitude(cam.lon), 0.25, true)
        },
        focusBody(bodyId: GeohashableBodyId, options?: { geohash?: string; animate?: boolean }) {
          focusBodyInternal(bodyId, options)
        },
        fitSolarSystem() {
          fitSolarSystemInternal()
        },
        getZoom() {
          return cameraStateRef.current.zoom
        },
      }),
      [
        fitSolarSystemInternal,
        flyToCellInternal,
        flyToTopicInternal,
        focusBodyInternal,
        startFlyTo,
      ],
    )

    // -----------------------------------------------------------------------
    // 1. Mount Three.js 3D Earth Globe, Solar System Skybox, Controls & rAF
    // -----------------------------------------------------------------------
    useEffect(() => {
      const wrap = canvasWrapRef.current
      if (!wrap) return

      let reportedWebglFailure = false
      const reportWebglFailure = () => {
        if (reportedWebglFailure) return
        reportedWebglFailure = true
        setWebglError(true)
        onWebglErrorRef.current?.()
      }

      let renderer: THREE.WebGLRenderer
      try {
        const initCanvas = document.createElement('canvas')
        const glCtx =
          initCanvas.getContext('webgl2', {
            alpha: true,
            antialias: true,
            powerPreference: 'high-performance',
          }) || initCanvas.getContext('webgl2')
        if (!glCtx || glCtx.isContextLost()) {
          reportWebglFailure()
          return
        }
        renderer = new THREE.WebGLRenderer({
          canvas: initCanvas,
          context: glCtx as unknown as WebGLRenderingContext,
          antialias: true,
          alpha: false,
          powerPreference: 'high-performance',
        })
        const activeCtx = renderer.getContext()
        if (!activeCtx || activeCtx.isContextLost()) {
          renderer.dispose()
          reportWebglFailure()
          return
        }
      } catch {
        reportWebglFailure()
        return
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      renderer.setPixelRatio(dpr)
      const initW = Math.max(1, wrap.clientWidth)
      const initH = Math.max(1, wrap.clientHeight)
      renderer.setSize(initW, initH, false)
      renderer.domElement.style.width = '100%'
      renderer.domElement.style.height = '100%'
      renderer.domElement.style.display = 'block'
      wrap.appendChild(renderer.domElement)

      const palette = readCanvasPalette(hostRef.current, themeRef.current)
      const scene = new THREE.Scene()
      scene.background = new THREE.Color(palette.spaceBg)

      const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, initW / initH, 0.01, 1400)
      camera.up.set(0, 1, 0)

      // Live Floating-Origin Solar System Snapshot (all 24 bodies: Sun + 9 Planets + 14 Moons)
      const initBodyId = activeBodyIdRef.current
      let currentSnapshot = computeSolarSystemSnapshot(new Date(), initBodyId)
      const sunDir = new THREE.Vector3(...currentSnapshot.focusedSunDir).normalize()

      const starfield = createStarfieldPoints(dpr)
      scene.add(starfield.points)

      // Radiant Sun (radius 5.2, positioned at snapshot.sunPos, clickable -> fitSolarSystem)
      const sunGroup = new THREE.Group()
      const sunCoreGeo = new THREE.SphereGeometry(SOLAR_BODIES.sun.visualRadius, 32, 24)
      const sunCoreMat = new THREE.MeshBasicMaterial({ color: '#FFF7E0' })
      const sunCoreMesh = new THREE.Mesh(sunCoreGeo, sunCoreMat)
      sunGroup.add(sunCoreMesh)

      const sunCoronaTex = createSunCoronaTexture()
      const sunCoronaMat = new THREE.SpriteMaterial({
        map: sunCoronaTex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const sunCoronaSprite = new THREE.Sprite(sunCoronaMat)
      sunCoronaSprite.scale.set(34, 34, 1)
      sunGroup.add(sunCoronaSprite)

      const sunHitGeo = new THREE.SphereGeometry(SOLAR_BODIES.sun.visualRadius * 1.45, 12, 10)
      const sunHitMat = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
      })
      const sunHitMesh = new THREE.Mesh(sunHitGeo, sunHitMat)
      sunHitMesh.userData = { hitKind: 'body', bodyId: 'sun' as CelestialBodyId }
      sunGroup.add(sunHitMesh)
      sunGroup.position.set(...currentSnapshot.sunPos)
      scene.add(sunGroup)

      // Earth Base Equirectangular Texture (bright daylight Esri Topo for all themes)
      const baseCanvas = document.createElement('canvas')
      baseCanvas.width = 1024
      baseCanvas.height = 512
      const initialTileKind: 'dark' | 'light' = themeRef.current === 'daylight' ? 'light' : 'dark'
      paintProceduralBaseMap(baseCanvas)

      const baseTexture = new THREE.CanvasTexture(baseCanvas)
      baseTexture.colorSpace = THREE.SRGBColorSpace
      baseTexture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy())
      baseTexture.needsUpdate = true

      const earthGeo = new THREE.SphereGeometry(EARTH_RADIUS, 96, 64)
      const earthMaterial = new THREE.ShaderMaterial({
        vertexShader: EARTH_VERTEX_SHADER,
        fragmentShader: EARTH_FRAGMENT_SHADER,
        uniforms: {
          uMap: { value: baseTexture },
          uSunDir: { value: sunDir.clone() },
          uIsLight: { value: initialTileKind === 'light' ? 1.0 : 0.0 },
          uOpacity: { value: 1.0 },
        },
        polygonOffset: true,
        polygonOffsetFactor: 2,
        polygonOffsetUnits: 2,
      })
      const surfaceMaps = new SolarSurfaceMaps(renderer.capabilities.getMaxAnisotropy())
      const planetCentralMaterial = new THREE.ShaderMaterial({
        vertexShader: EARTH_VERTEX_SHADER,
        fragmentShader: PLANET_FRAGMENT_SHADER,
        uniforms: {
          ...surfaceMaps.preview('earth'),
          uSunDir: { value: sunDir.clone() },
          uAtmoColor: { value: new THREE.Color('#60A5FA') },
          uAtmoStrength: { value: 0.0 },
          uOpacity: { value: 1.0 },
        },
        polygonOffset: true,
        polygonOffsetFactor: 2,
        polygonOffsetUnits: 2,
      })
      const earthMesh = new THREE.Mesh(earthGeo, earthMaterial)
      earthMesh.renderOrder = 1
      scene.add(earthMesh)

      // Outer Atmosphere Shell (adapts tint/visibility per focused body)
      const atmosphereGeo = new THREE.SphereGeometry(1.032, 48, 32)
      const atmosphereMaterial = new THREE.ShaderMaterial({
        vertexShader: ATMOSPHERE_VERTEX_SHADER,
        fragmentShader: ATMOSPHERE_FRAGMENT_SHADER,
        uniforms: {
          uSunDir: { value: sunDir.clone() },
          uHaloColor: { value: new THREE.Color(0.28, 0.62, 1.0) },
          uIntensity: { value: 0.62 },
          uTwilightMix: { value: 0.35 },
        },
        side: THREE.BackSide,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const atmosphereMesh = new THREE.Mesh(atmosphereGeo, atmosphereMaterial)
      atmosphereMesh.renderOrder = 3
      scene.add(atmosphereMesh)

      // Layered Scene Groups (Focused World + Rings + Solar System + Orbits + Push-Pins + Topic Asteroids)
      const centralRingGroup = new THREE.Group()
      const solarSystemGroup = new THREE.Group()
      const planetOrbitGroup = new THREE.Group()
      const moonOrbitGroup = new THREE.Group()
      const patchGroup = new THREE.Group()
      const gridGroup = new THREE.Group()
      const subZoneGroup = new THREE.Group()
      const pulseGroup = new THREE.Group()
      const focusGroup = new THREE.Group()
      const hoverGroup = new THREE.Group()
      const gpsGroup = new THREE.Group()
      const pinGroup = new THREE.Group()
      const asteroidOrbitGroup = new THREE.Group()
      const asteroidGroup = new THREE.Group()
      scene.add(
        planetOrbitGroup,
        moonOrbitGroup,
        solarSystemGroup,
        centralRingGroup,
        patchGroup,
        gridGroup,
        subZoneGroup,
        pulseGroup,
        focusGroup,
        hoverGroup,
        gpsGroup,
        pinGroup,
        asteroidOrbitGroup,
        asteroidGroup,
      )

      const patchCache = new Map<string, PatchTileCacheEntry>()
      const planetOrbitMats = new Map<CelestialBodyId, THREE.LineBasicMaterial>()
      const moonOrbitMats: THREE.LineBasicMaterial[] = []
      const pinEntries = pinEntriesRef.current
      const asteroidEntries = asteroidEntriesRef.current
      const bodyEntries = bodyEntriesRef.current
      let baseLoadGen = 0
      let isDisposed = false
      let viewportDebounceTimer: number | null = null
      let lastPatchKeySig = ''

      const emitViewport = () => {
        if (isDisposed) return
        const z = cameraStateRef.current.zoom
        const p =
          precisionModeRef.current === 'auto'
            ? getRecommendedPrecisionForZoom(z)
            : precisionModeRef.current
        onViewportInfoRef.current?.({ zoom: z, effectivePrecision: p })
        setViewportTick((t) => t + 1)
      }

      const scheduleViewportEmit = () => {
        if (viewportDebounceTimer !== null) {
          window.clearTimeout(viewportDebounceTimer)
        }
        viewportDebounceTimer = window.setTimeout(() => {
          viewportDebounceTimer = null
          emitViewport()
        }, VIEWPORT_DEBOUNCE_MS)
      }

      const reloadBaseTiles = (kind: 'dark' | 'light') => {
        baseLoadGen += 1
        const gen = baseLoadGen
        let tiled = false
        void surfaceMaps.paintEarthBackdrop(baseCanvas, () => !isDisposed && gen === baseLoadGen && !tiled).then((painted) => {
          if (painted && !isDisposed) baseTexture.needsUpdate = true
        })
        const isLight = kind === 'light'
        paintProceduralBaseMap(baseCanvas)
        baseTexture.needsUpdate = true
        earthMaterial.uniforms.uIsLight.value = isLight ? 1.0 : 0.0

        const ctx = baseCanvas.getContext('2d')
        if (!ctx) return

        const z = 2
        const n = 1 << z
        for (let ty = 0; ty < n; ty++) {
          for (let tx = 0; tx < n; tx++) {
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload = () => {
              if (isDisposed || gen !== baseLoadGen) return
              tiled = true
              compositeMercatorTileOntoEquirect(ctx, img, z, tx, ty, baseCanvas.width, baseCanvas.height)
              baseTexture.needsUpdate = true
            }
            img.src = tileUrl(ESRI_TOPO_URL, z, tx, ty)
          }
        }
      }

      const updatePatchTiles = () => {
        if (isDisposed) return
        if (activeBodyIdRef.current !== 'earth') {
          for (const entry of patchCache.values()) {
            entry.mesh.visible = false
          }
          lastPatchKeySig = 'non-earth'
          return
        }
        const cam = cameraStateRef.current
        const dist = zoomToDistance(cam.zoom)
        const currentKind: 'dark' | 'light' = themeRef.current === 'daylight' ? 'light' : 'dark'

        if (dist >= 2.2) {
          for (const entry of patchCache.values()) {
            entry.mesh.visible = false
          }
          lastPatchKeySig = 'orbital'
          return
        }

        const halfFovRad = (CAMERA_FOV_DEG * DEG2RAD) / 2
        const halfAngRad = computeVisibleHalfAngleRad(dist, halfFovRad)
        const latSpanDeg = Math.max(0.00005, 2 * halfAngRad * RAD2DEG)
        const cosLat = Math.max(0.2, Math.cos(cam.lat * DEG2RAD))
        const tileZ = clamp(
          Math.round(Math.log2((360 * cosLat) / Math.max(0.00005, latSpanDeg * 0.72))),
          3,
          18,
        )

        const n = 1 << tileZ
        const centerTx = Math.floor(lonToMercXNorm(cam.lon) * n)
        const centerTy = clamp(Math.floor(latToMercYNorm(cam.lat) * n), 0, n - 1)
        const aspect = camera.aspect || 1
        const radiusX = aspect > 1.25 ? 2 : 1
        const radiusY = 1

        const desired: Array<{ tx: number; ty: number; dist2: number }> = []
        for (let dy = -radiusY; dy <= radiusY; dy++) {
          const ty = centerTy + dy
          if (ty < 0 || ty >= n) continue
          for (let dx = -radiusX; dx <= radiusX; dx++) {
            const tx = ((centerTx + dx) % n + n) % n
            desired.push({ tx, ty, dist2: dx * dx + dy * dy })
          }
        }
        desired.sort((a, b) => a.dist2 - b.dist2)
        const chosen = desired.slice(0, MAX_VISIBLE_PATCH_TILES)
        const sig = `topo:${tileZ}:${chosen.map((c) => `${c.tx},${c.ty}`).join('|')}`
        if (sig === lastPatchKeySig) return
        lastPatchKeySig = sig

        const nowMs = Date.now()
        const activeKeys = new Set<string>()
        const isLight = currentKind === 'light'

        for (const { tx, ty } of chosen) {
          const key = `topo:${tileZ}:${tx}:${ty}`
          activeKeys.add(key)

          let entry = patchCache.get(key)
          if (!entry) {
            const tileCanvas = document.createElement('canvas')
            tileCanvas.width = 256
            tileCanvas.height = 256
            const texture = new THREE.CanvasTexture(tileCanvas)
            texture.colorSpace = THREE.SRGBColorSpace
            texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy())

            const { geometry, anchor } = createMercatorPatchGeometry(tileZ, tx, ty)
            const material = new THREE.ShaderMaterial({
              vertexShader: EARTH_VERTEX_SHADER,
              fragmentShader: EARTH_FRAGMENT_SHADER,
              uniforms: {
                uMap: { value: texture },
                uSunDir: { value: sunDir.clone() },
                uIsLight: { value: isLight ? 1.0 : 0.0 },
                uOpacity: { value: 1.0 },
              },
              depthWrite: false,
              polygonOffset: true,
              polygonOffsetFactor: -1,
              polygonOffsetUnits: -2,
            })

            const mesh = new THREE.Mesh(geometry, material)
            mesh.position.copy(anchor)
            mesh.visible = false
            mesh.renderOrder = 2
            patchGroup.add(mesh)

            entry = {
              key,
              z: tileZ,
              tx,
              ty,
              kind: 'light',
              mesh,
              geometry,
              material,
              texture,
              canvas: tileCanvas,
              loaded: false,
              lastUsedMs: nowMs,
            }
            patchCache.set(key, entry)

            const localEntry = entry
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload = () => {
              if (isDisposed || !patchCache.has(key)) return
              const ctx = localEntry.canvas.getContext('2d')
              if (!ctx) return
              ctx.clearRect(0, 0, 256, 256)
              ctx.drawImage(img, 0, 0, 256, 256)
              localEntry.texture.needsUpdate = true
              localEntry.loaded = true
              const prefix = `topo:${tileZ}:`
              if (
                lastPatchKeySig.startsWith(prefix) &&
                lastPatchKeySig.slice(prefix.length).split('|').includes(`${tx},${ty}`)
              ) {
                localEntry.mesh.visible = true
              }
            }
            img.src = tileUrl(ESRI_TOPO_URL, tileZ, tx, ty)
          } else {
            entry.material.uniforms.uIsLight.value = isLight ? 1.0 : 0.0
          }

          entry.lastUsedMs = nowMs
          entry.mesh.visible = entry.loaded
        }

        for (const [k, entry] of patchCache.entries()) {
          if (!activeKeys.has(k)) {
            entry.mesh.visible = false
          }
        }
        if (patchCache.size > MAX_CACHED_PATCH_TILES) {
          const evictable = Array.from(patchCache.values())
            .filter((e) => !activeKeys.has(e.key))
            .sort((a, b) => a.lastUsedMs - b.lastUsedMs)
          let toDrop = patchCache.size - MAX_CACHED_PATCH_TILES
          for (const victim of evictable) {
            if (toDrop <= 0) break
            patchGroup.remove(victim.mesh)
            victim.geometry.dispose()
            victim.material.dispose()
            victim.texture.dispose()
            patchCache.delete(victim.key)
            toDrop -= 1
          }
        }
      }

      const updateHoverMesh = (gh: string | null) => {
        while (hoverGroup.children.length > 0) {
          const ch = hoverGroup.children[0]
          hoverGroup.remove(ch)
          disposeObject3D(ch)
        }
        if (!gh || gh === activeGeohashRef.current || gh === selectedGeohashRef.current) return
        const b = decodeBounds(gh)
        const c = decodeCenter(gh)
        const anchor = latLonToUnitVec3(c.lat, c.lon)
        const pal = readCanvasPalette(hostRef.current, themeRef.current)
        const color = new THREE.Color(pal.accent)

        const fillGeo = buildCurvedRectFillGeometry([b], OVERLAY_FILL_RADIUS, anchor)
        const fillMat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: pal.isLight ? 0.14 : 0.12,
          side: THREE.FrontSide,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
        })
        const fillMesh = new THREE.Mesh(fillGeo, fillMat)
        fillMesh.position.set(anchor[0], anchor[1], anchor[2])
        fillMesh.renderOrder = 6
        hoverGroup.add(fillMesh)

        const segs: number[] = []
        pushCurvedRectSegments(segs, b.latMin, b.latMax, b.lonMin, b.lonMax, FOCUS_LINE_RADIUS, anchor)
        const lineGeo = new THREE.BufferGeometry()
        lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
        const lineMat = new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0.72,
          depthWrite: false,
        })
        const line = new THREE.LineSegments(lineGeo, lineMat)
        line.position.set(anchor[0], anchor[1], anchor[2])
        line.renderOrder = 7
        hoverGroup.add(line)
      }

      const clearGroupChildren = (g: THREE.Group) => {
        while (g.children.length > 0) {
          const ch = g.children[0]
          g.remove(ch)
          disposeObject3D(ch)
        }
      }

      const syncSunDirUniforms = (dir: THREE.Vector3) => {
        earthMaterial.uniforms.uSunDir.value.copy(dir)
        planetCentralMaterial.uniforms.uSunDir.value.copy(dir)
        atmosphereMaterial.uniforms.uSunDir.value.copy(dir)
        for (const entry of patchCache.values()) {
          entry.material.uniforms.uSunDir.value.copy(dir)
        }
        for (const entry of asteroidEntries.values()) {
          entry.rockMaterial.uniforms.uSunDir.value.copy(dir)
        }
        asteroidGroup.traverse((child) => {
          const m = (child as THREE.Mesh).material as THREE.ShaderMaterial | undefined
          if (m && m.uniforms?.uSunDir) {
            m.uniforms.uSunDir.value.copy(dir)
          }
        })
        pinGroup.traverse((child) => {
          const m = (child as THREE.Mesh).material as THREE.ShaderMaterial | undefined
          if (m && m.uniforms?.uSunDir) {
            m.uniforms.uSunDir.value.copy(dir)
          }
        })
      }

      const surfaceRotation = new THREE.Matrix4()
      const setBodyPose = (root: THREE.Group, body: SolarBodySnapshot) => {
        root.position.set(...body.position)
        const m = body.surfaceAxes
        if (m) {
          surfaceRotation.set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1)
          root.quaternion.setFromRotationMatrix(surfaceRotation)
        } else {
          root.quaternion.identity()
        }
      }

      const rebuildSolarSystem = (
        bodyId: GeohashableBodyId,
        now: Date = new Date(),
      ): SolarSystemSnapshot => {
        const snap = computeSolarSystemSnapshot(now, bodyId)
        currentSnapshot = snap
        sunDir.set(...snap.focusedSunDir).normalize()
        sunGroup.position.set(...snap.sunPos)

        // 1. Configure Central Focused World Surface, Atmosphere, Rings & Earth-only groups
        const isEarth = bodyId === 'earth'
        const focusedDef = SOLAR_BODIES[bodyId]
        surfaceMaps.focus(isEarth ? null : bodyId, planetCentralMaterial.uniforms)
        if (isEarth) {
          earthMesh.material = earthMaterial
          atmosphereMesh.visible = true
          atmosphereMaterial.uniforms.uHaloColor.value.setRGB(0.28, 0.62, 1.0)
          atmosphereMaterial.uniforms.uIntensity.value = 0.62
          atmosphereMaterial.uniforms.uTwilightMix.value = 0.35
        } else {
          planetCentralMaterial.uniforms.uSunDir.value.copy(sunDir)
          if (focusedDef.palette.atmosphere) {
            planetCentralMaterial.uniforms.uAtmoColor.value.set(focusedDef.palette.atmosphere)
            planetCentralMaterial.uniforms.uAtmoStrength.value = 0.34
            atmosphereMesh.visible = true
            atmosphereMaterial.uniforms.uHaloColor.value.set(focusedDef.palette.atmosphere)
            atmosphereMaterial.uniforms.uIntensity.value = 0.44
            atmosphereMaterial.uniforms.uTwilightMix.value = 0.08
          } else {
            planetCentralMaterial.uniforms.uAtmoStrength.value = 0.0
            atmosphereMesh.visible = false
          }
          earthMesh.material = planetCentralMaterial
        }

        patchGroup.visible = isEarth
        gpsGroup.visible = isEarth
        asteroidGroup.visible = isEarth
        asteroidOrbitGroup.visible = isEarth

        clearGroupChildren(centralRingGroup)
        if (focusedDef.rings) {
          const centralRings = createPlanetaryRingMesh(
            focusedDef.rings.innerRadius,
            focusedDef.rings.outerRadius,
            focusedDef.rings.color,
            focusedDef.rings.opacity,
            0, // Equatorial plane around the geohash-aligned central planet
            112,
          )
          centralRingGroup.add(centralRings)
        }

        // 2. Rebuild Orbiting Planets, Child/Sibling Moons, & Rings
        clearGroupChildren(solarSystemGroup)
        clearGroupChildren(planetOrbitGroup)
        clearGroupChildren(moonOrbitGroup)
        bodyEntries.clear()
        planetOrbitMats.clear()
        moonOrbitMats.length = 0

        // Register Sun in bodyEntries for unified chip projection & raycasting
        bodyEntries.set('sun', {
          id: 'sun',
          def: SOLAR_BODIES.sun,
          root: sunGroup,
          material: null,
          hitMesh: sunHitMesh,
          worldPos: new THREE.Vector3(...snap.sunPos),
          renderRadius: SOLAR_BODIES.sun.visualRadius,
          isChildMoon: false,
          isParentOfFocused: false,
          isSiblingMoon: false,
          isPlanet: false,
          isSun: true,
        })

        // Determine all relevant non-focused bodies to render in 3D
        const renderIds: GeohashableBodyId[] = []
        const renderSet = new Set<CelestialBodyId>(['sun', bodyId])
        const addRenderBody = (id: GeohashableBodyId) => {
          if (renderSet.has(id)) return
          renderSet.add(id)
          renderIds.push(id)
        }
        if (focusedDef.kind === 'planet') {
          for (const m of getMoonsOfBody(bodyId)) addRenderBody(m.id as GeohashableBodyId)
        } else if (focusedDef.kind === 'moon' && focusedDef.parentId) {
          if (focusedDef.parentId !== 'sun') addRenderBody(focusedDef.parentId)
          for (const m of getMoonsOfBody(focusedDef.parentId)) {
            addRenderBody(m.id as GeohashableBodyId)
          }
        }
        for (const pid of PLANET_BODY_IDS) addRenderBody(pid)

        for (const id of renderIds) {
          const bSnap = snap.bodies[id]
          const def = SOLAR_BODIES[id]
          const root = new THREE.Group()
          setBodyPose(root, bSnap)

          const sphereGeo = new THREE.SphereGeometry(bSnap.renderRadius, 32, 24)
          const bMat = new THREE.ShaderMaterial({
            vertexShader: EARTH_VERTEX_SHADER,
            fragmentShader: PLANET_FRAGMENT_SHADER,
            uniforms: {
              ...surfaceMaps.preview(id),
              uSunDir: { value: new THREE.Vector3(...bSnap.sunDir).normalize() },
              uAtmoColor: {
                value: new THREE.Color(def.palette.atmosphere ?? def.palette.accent),
              },
              uAtmoStrength: { value: def.palette.atmosphere ? 0.36 : 0.0 },
              uOpacity: { value: 1.0 },
            },
          })
          const sphereMesh = new THREE.Mesh(sphereGeo, bMat)
          sphereMesh.userData = { hitKind: 'body', bodyId: id }
          sphereMesh.renderOrder = 2
          root.add(sphereMesh)

          if (def.rings) {
            const ringMesh = createPlanetaryRingMesh(
              def.rings.innerRadius * bSnap.renderRadius,
              def.rings.outerRadius * bSnap.renderRadius,
              def.rings.color,
              def.rings.opacity,
              def.rings.tiltDeg,
              72,
            )
            ringMesh.userData = { hitKind: 'body', bodyId: id }
            root.add(ringMesh)
          }

          const hitRadius = Math.max(
            bSnap.renderRadius * 2.15,
            bSnap.isChildMoonOfFocused ? 0.42 : 0.9,
          )
          const hitGeo = new THREE.SphereGeometry(hitRadius, 10, 8)
          const hitMat = new THREE.MeshBasicMaterial({
            transparent: true,
            opacity: 0,
            depthWrite: false,
          })
          const hitMesh = new THREE.Mesh(hitGeo, hitMat)
          hitMesh.userData = { hitKind: 'body', bodyId: id }
          root.add(hitMesh)

          solarSystemGroup.add(root)
          bodyEntries.set(id, {
            id,
            def,
            root,
            material: bMat,
            hitMesh,
            worldPos: new THREE.Vector3(...bSnap.position),
            renderRadius: bSnap.renderRadius,
            isChildMoon: bSnap.isChildMoonOfFocused,
            isParentOfFocused: bSnap.isParentOfFocused,
            isSiblingMoon: bSnap.isSiblingMoon,
            isPlanet: def.kind === 'planet',
            isSun: false,
          })
        }

        // 3. Elliptical Planetary Orbital Rings around snapshot.sunPos
        for (const pid of PLANET_BODY_IDS) {
          const pts = samplePlanetOrbitPoints(pid, snap.sunPos, now, 160, snap.earthToViewAxes)
          if (pts.length === 0) continue
          const oGeo = new THREE.BufferGeometry()
          oGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3))
          const oMat = new THREE.LineBasicMaterial({
            color: new THREE.Color(SOLAR_BODIES[pid].palette.orbitColor),
            transparent: true,
            opacity: 0,
            depthWrite: false,
          })
          const oLine = new THREE.Line(oGeo, oMat)
          oLine.renderOrder = 0
          planetOrbitGroup.add(oLine)
          planetOrbitMats.set(pid, oMat)
        }

        // 4. Faint Moon Orbital Rings around focused planet (or parent planet when on a moon)
        const originCenter = new THREE.Vector3(0, 0, 0)
        if (focusedDef.kind === 'planet') {
          for (const m of getMoonsOfBody(bodyId)) {
            const mSnap = snap.bodies[m.id]
            const mGeo = createMoonOrbitLoopGeometry(
              originCenter,
              new THREE.Vector3(...mSnap.position),
              72,
            )
            const mMat = new THREE.LineBasicMaterial({
              color: new THREE.Color(m.palette.orbitColor),
              transparent: true,
              opacity: 0.14,
              depthWrite: false,
            })
            const mLoop = new THREE.LineLoop(mGeo, mMat)
            mLoop.renderOrder = 0
            moonOrbitGroup.add(mLoop)
            moonOrbitMats.push(mMat)
          }
        } else if (focusedDef.kind === 'moon' && focusedDef.parentId) {
          const parentPos = new THREE.Vector3(...snap.bodies[focusedDef.parentId].position)
          const mAxes = snap.earthToViewAxes
          const orbitUp = mAxes ? new THREE.Vector3(mAxes[1], mAxes[4], mAxes[7]) : UP_Y
          for (const m of getMoonsOfBody(focusedDef.parentId)) {
            const mSnap = snap.bodies[m.id]
            const mPos = m.id === bodyId ? originCenter : new THREE.Vector3(...mSnap.position)
            const mGeo = createMoonOrbitLoopGeometry(parentPos, mPos, 72, orbitUp)
            const mMat = new THREE.LineBasicMaterial({
              color: new THREE.Color(m.palette.orbitColor),
              transparent: true,
              opacity: m.id === bodyId ? 0.22 : 0.12,
              depthWrite: false,
            })
            const mLoop = new THREE.LineLoop(mGeo, mMat)
            mLoop.renderOrder = 0
            moonOrbitGroup.add(mLoop)
            moonOrbitMats.push(mMat)
          }
        }

        syncSunDirUniforms(sunDir)
        if (sceneRefs.current) {
          sceneRefs.current.snapshot = snap
        }
        return snap
      }

      const updateSolarPositions = (now: Date = new Date()) => {
        const snap = computeSolarSystemSnapshot(now, activeBodyIdRef.current)
        currentSnapshot = snap
        sunDir.set(...snap.focusedSunDir).normalize()
        sunGroup.position.set(...snap.sunPos)

        for (const [id, entry] of bodyEntries.entries()) {
          const bSnap = snap.bodies[id]
          if (!bSnap) continue
          entry.worldPos.set(...bSnap.position)
          if (!entry.isSun) {
            setBodyPose(entry.root, bSnap)
            if (entry.material) {
              entry.material.uniforms.uSunDir.value.set(...bSnap.sunDir).normalize()
            }
          }
        }
        syncSunDirUniforms(sunDir)
        if (sceneRefs.current) {
          sceneRefs.current.snapshot = snap
        }
      }

      sceneRefs.current = {
        scene,
        camera,
        renderer,
        earthMesh,
        earthMaterial,
        planetCentralMaterial,
        baseCanvas,
        baseTexture,
        sunDir,
        sunGroup,
        sunHitMesh,
        atmosphereMesh,
        atmosphereMaterial,
        centralRingGroup,
        solarSystemGroup,
        planetOrbitGroup,
        moonOrbitGroup,
        planetOrbitMats,
        moonOrbitMats,
        patchGroup,
        patchCache,
        gridGroup,
        subZoneGroup,
        pulseGroup,
        focusGroup,
        hoverGroup,
        gpsGroup,
        pinGroup,
        asteroidGroup,
        asteroidOrbitGroup,
        snapshot: currentSnapshot,
        tileKind: initialTileKind,
        baseLoadGen,
        hoveredGeohash: null,
        hoveredAsteroidKey: null,
        hoveredBodyId: null,
        orbitClockSec: 0,
        scheduleViewportEmit,
        reloadBaseTiles,
        updatePatchTiles,
        updateHoverMesh,
        rebuildSolarSystem,
        updateSolarPositions,
      }

      reloadBaseTiles(initialTileKind)
      rebuildSolarSystem(initBodyId, new Date())

      // Refresh live Solar System ephemeris positions every 30s
      const sunTimer = window.setInterval(() => {
        if (!isDisposed) updateSolarPositions(new Date())
      }, SUN_REFRESH_INTERVAL_MS)

      // ---------------------------------------------------------------------
      // Pointer, Touch Pinch-Zoom, Wheel Zoom & Priority Raycast Controller
      // Priority: 1) Earth Topic Asteroids  2) 3D Red Push-Pins  3) Solar Bodies  4) Focused World
      // ---------------------------------------------------------------------
      const canvas = renderer.domElement
      const raycaster = new THREE.Raycaster()
      const ndcPointer = new THREE.Vector2()
      const activePointers = new Map<number, { x: number; y: number }>()

      let dragPrimaryId: number | null = null
      let dragStartX = 0
      let dragStartY = 0
      let dragLastX = 0
      let dragLastY = 0
      let dragMovedPx = 0
      let dragDownMs = 0
      let lastPinchDist = 0
      let lastPinchMidX = 0
      let lastPinchMidY = 0
      let lastTapMs = 0
      let lastTapX = 0
      let lastTapY = 0

      const isTouchOnly =
        typeof window !== 'undefined' &&
        Boolean(window.matchMedia?.('(hover: none)').matches)

      type SceneHitResult =
        | { kind: 'asteroid'; channelKey: string; slug: string }
        | { kind: 'pin'; channelKey: string; rawGeohash: string }
        | { kind: 'body'; bodyId: CelestialBodyId }
        | { kind: 'earth'; lat: number; lon: number }
        | null

      const raycastScene = (clientX: number, clientY: number): SceneHitResult => {
        const rect = canvas.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return null
        ndcPointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
        ndcPointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
        raycaster.setFromCamera(ndcPointer, camera)

        const camPosTuple: [number, number, number] = [
          camera.position.x,
          camera.position.y,
          camera.position.z,
        ]
        const camDist = Math.max(EARTH_RADIUS + 0.001, camera.position.length())
        const rayHorizonCos = clamp(EARTH_RADIUS / camDist, 0.01, 0.996)

        // 1. 3D Topic Asteroids (Earth only, filter out asteroids behind Earth's limb)
        if (activeBodyIdRef.current === 'earth' && asteroidEntries.size > 0) {
          const hitTargets: THREE.Object3D[] = []
          for (const entry of asteroidEntries.values()) {
            const p: [number, number, number] = [
              entry.worldPos.x,
              entry.worldPos.y,
              entry.worldPos.z,
            ]
            if (!isPointOccludedByEarth(camPosTuple, p, EARTH_RADIUS)) {
              hitTargets.push(entry.hitMesh)
            }
          }
          if (hitTargets.length > 0) {
            const hits = raycaster.intersectObjects(hitTargets, false)
            if (hits.length > 0) {
              const ud = hits[0].object.userData as { channelKey?: string; slug?: string }
              if (ud.channelKey) {
                return {
                  kind: 'asteroid',
                  channelKey: ud.channelKey,
                  slug: ud.slug || getTopicSlug(ud.channelKey) || ud.channelKey,
                }
              }
            }
          }
        }

        // 2. 3D Red Push-Pins on the focused world (exact geometric horizon check)
        if (pinEntries.size > 0) {
          const camDirNorm = camera.position.clone().normalize()
          const pinTargets: THREE.Object3D[] = []
          for (const entry of pinEntries.values()) {
            if (entry.normal.dot(camDirNorm) > rayHorizonCos + 0.004) {
              pinTargets.push(entry.hitMesh)
            }
          }
          if (pinTargets.length > 0) {
            const hits = raycaster.intersectObjects(pinTargets, false)
            if (hits.length > 0) {
              const ud = hits[0].object.userData as { channelKey?: string; rawGeohash?: string }
              if (ud.channelKey) {
                return {
                  kind: 'pin',
                  channelKey: ud.channelKey,
                  rawGeohash: ud.rawGeohash ?? getChannelRawGeohash(ud.channelKey) ?? ud.channelKey,
                }
              }
            }
          }
        }

        // 3. Orbiting Planets, Moons & Sun (skip bodies occluded behind the central world)
        if (bodyEntries.size > 0) {
          const bodyTargets: THREE.Object3D[] = []
          for (const entry of bodyEntries.values()) {
            const p: [number, number, number] = [
              entry.worldPos.x,
              entry.worldPos.y,
              entry.worldPos.z,
            ]
            if (!isPointOccludedByEarth(camPosTuple, p, EARTH_RADIUS)) {
              bodyTargets.push(entry.hitMesh)
            }
          }
          if (bodyTargets.length > 0) {
            const hits = raycaster.intersectObjects(bodyTargets, false)
            if (hits.length > 0) {
              const ud = hits[0].object.userData as { bodyId?: CelestialBodyId }
              if (ud.bodyId) {
                return { kind: 'body', bodyId: ud.bodyId }
              }
            }
          }
        }

        // 4. Focused World Surface — Exact Float64 Analytical Ray-Unit-Sphere Intersection (nanometer precision at P9!)
        const o = raycaster.ray.origin
        const d = raycaster.ray.direction
        const b = o.x * d.x + o.y * d.y + o.z * d.z
        const c = o.x * o.x + o.y * o.y + o.z * o.z - EARTH_RADIUS * EARTH_RADIUS
        const disc = b * b - c
        if (disc >= 0) {
          const t = -b - Math.sqrt(disc)
          if (t > 0) {
            const hitPt = new THREE.Vector3(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t)
            const { lat, lon } = unitVec3ToLatLon(hitPt)
            return { kind: 'earth', lat, lon }
          }
        }
        return null
      }

      const degPerPixel = (): number => {
        const cam = cameraStateRef.current
        const dist = zoomToDistance(cam.zoom)
        const halfFovRad = (CAMERA_FOV_DEG * DEG2RAD) / 2
        const halfAngRad = computeVisibleHalfAngleRad(dist, halfFovRad)
        const h = Math.max(180, canvas.clientHeight)
        return ((2 * halfAngRad * RAD2DEG) / h) * 1.05
      }

      const onPointerDown = (e: PointerEvent) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        canvas.setPointerCapture(e.pointerId)
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

        const cam = cameraStateRef.current
        cam.isFlying = false
        cam.velLat = 0
        cam.velLon = 0
        cam.wheelAnchor = null
        cam.targetLat = cam.lat
        cam.targetLon = cam.lon
        cam.targetZoom = cam.zoom

        if (activePointers.size === 1) {
          cam.dragging = true
          wrap.classList.add('is-dragging')
          dragPrimaryId = e.pointerId
          dragStartX = e.clientX
          dragStartY = e.clientY
          dragLastX = e.clientX
          dragLastY = e.clientY
          dragMovedPx = 0
          dragDownMs = performance.now()
        } else if (activePointers.size === 2) {
          cam.dragging = true
          wrap.classList.add('is-dragging')
          dragPrimaryId = null
          dragMovedPx = 999
          const pts = Array.from(activePointers.values())
          lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
          lastPinchMidX = (pts[0].x + pts[1].x) / 2
          lastPinchMidY = (pts[0].y + pts[1].y) / 2
        }
      }

      const onPointerMove = (e: PointerEvent) => {
        const cam = cameraStateRef.current
        if (activePointers.has(e.pointerId)) {
          activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        }

        if (activePointers.size >= 2) {
          const pts = Array.from(activePointers.values())
          const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
          const midX = (pts[0].x + pts[1].x) / 2
          const midY = (pts[0].y + pts[1].y) / 2

          const rect = canvas.getBoundingClientRect()
          let pinchAnchor: [number, number, number] | null = null
          let newMidNdcX = 0
          let newMidNdcY = 0
          if (rect.width > 0 && rect.height > 0) {
            const oldMidNdcX = ((lastPinchMidX - rect.left) / rect.width) * 2 - 1
            const oldMidNdcY = -(((lastPinchMidY - rect.top) / rect.height) * 2 - 1)
            newMidNdcX = ((midX - rect.left) / rect.width) * 2 - 1
            newMidNdcY = -(((midY - rect.top) / rect.height) * 2 - 1)
            if (Math.abs(oldMidNdcX) <= 1 && Math.abs(oldMidNdcY) <= 1) {
              pinchAnchor = sampleWorldUnitAtNdc(
                oldMidNdcX,
                oldMidNdcY,
                camera.aspect,
                cam.lat,
                cam.lon,
                zoomToDistance(cam.zoom),
              )
            }
          }

          if (lastPinchDist > 8 && dist > 8) {
            const scaleRatio = dist / lastPinchDist
            const pinchDecay = cam.zoom >= 1 ? Math.LN2 : DEEP_SPACE_DECAY
            const zoomDelta = Math.log(scaleRatio) / pinchDecay
            cam.zoom = clamp(cam.zoom + zoomDelta, MIN_VIRTUAL_ZOOM, MAX_VIRTUAL_ZOOM)
            cam.targetZoom = cam.zoom
          }

          const solvedPinch =
            pinchAnchor && Math.abs(newMidNdcX) <= 1 && Math.abs(newMidNdcY) <= 1
              ? solveCameraLatLonForAnchor(
                  pinchAnchor,
                  newMidNdcX,
                  newMidNdcY,
                  camera.aspect,
                  zoomToDistance(cam.zoom),
                  cam.lat,
                  cam.lon,
                )
              : null

          if (solvedPinch) {
            cam.lat = solvedPinch.lat
            cam.lon = solvedPinch.lon
            cam.targetLat = solvedPinch.lat
            cam.targetLon = solvedPinch.lon
          } else {
            const dpp = degPerPixel()
            const dx = midX - lastPinchMidX
            const dy = midY - lastPinchMidY
            const cosLat = Math.max(0.24, Math.cos(cam.lat * DEG2RAD))
            cam.lat = clamp(cam.lat + dy * dpp, -82, 82)
            cam.lon -= (dx * dpp) / cosLat
            cam.targetLat = cam.lat
            cam.targetLon = cam.lon
          }

          lastPinchDist = dist
          lastPinchMidX = midX
          lastPinchMidY = midY
          scheduleViewportEmit()
          return
        }

        if (cam.dragging && e.pointerId === dragPrimaryId) {
          const dx = e.clientX - dragLastX
          const dy = e.clientY - dragLastY
          dragLastX = e.clientX
          dragLastY = e.clientY
          dragMovedPx += Math.hypot(dx, dy)

          const dpp = degPerPixel()
          const cosLat = Math.max(0.24, Math.cos(cam.lat * DEG2RAD))
          const dLat = dy * dpp
          const dLon = -(dx * dpp) / cosLat

          cam.lat = clamp(cam.lat + dLat, -82, 82)
          cam.lon += dLon
          cam.targetLat = cam.lat
          cam.targetLon = cam.lon
          cam.velLat = cam.velLat * 0.45 + dLat * 36 * 0.55
          cam.velLon = cam.velLon * 0.45 + dLon * 36 * 0.55
          scheduleViewportEmit()
          return
        }

        // Desktop hover readout + curved hover highlight / asteroid / Solar body highlight
        if (!isTouchOnly && e.pointerType === 'mouse' && activePointers.size === 0) {
          const hit = raycastScene(e.clientX, e.clientY)
          const sr = sceneRefs.current
          if (!sr) return

          if (!hit) {
            if (sr.hoveredGeohash !== null) {
              sr.hoveredGeohash = null
              updateHoverMesh(null)
            }
            sr.hoveredAsteroidKey = null
            sr.hoveredBodyId = null
            canvas.style.cursor = ''
            setHoverHud(null)
            return
          }

          if (hit.kind === 'asteroid') {
            if (sr.hoveredGeohash !== null) {
              sr.hoveredGeohash = null
              updateHoverMesh(null)
            }
            sr.hoveredAsteroidKey = hit.channelKey
            sr.hoveredBodyId = null
            canvas.style.cursor = 'pointer'
            setHoverHud({ geohash: hit.slug, coords: 'Topic Asteroid' })
            return
          }

          sr.hoveredAsteroidKey = null

          if (hit.kind === 'pin') {
            sr.hoveredBodyId = null
            if (sr.hoveredGeohash !== hit.rawGeohash) {
              sr.hoveredGeohash = hit.rawGeohash
              updateHoverMesh(hit.rawGeohash)
            }
            canvas.style.cursor = 'pointer'
            setHoverHud({ geohash: hit.channelKey, coords: 'Pinned' })
            return
          }

          if (hit.kind === 'body') {
            if (sr.hoveredGeohash !== null) {
              sr.hoveredGeohash = null
              updateHoverMesh(null)
            }
            sr.hoveredBodyId = hit.bodyId
            const def = getBodyDef(hit.bodyId)
            canvas.style.cursor = 'pointer'
            setHoverHud({
              geohash: def.name,
              coords:
                def.kind === 'star'
                  ? 'Solar System Overview'
                  : def.kind === 'moon'
                    ? 'Moon · Click to visit'
                    : 'Planet · Click to visit',
              noHash: true,
            })
            return
          }

          sr.hoveredBodyId = null
          canvas.style.cursor = ''
          const p =
            precisionModeRef.current === 'auto'
              ? getRecommendedPrecisionForZoom(cam.zoom)
              : precisionModeRef.current
          const rawGh = encodeGeohash(hit.lat, hit.lon, p)
          const channelKey = makeCelestialChannelKey(activeBodyIdRef.current, rawGh) ?? rawGh
          if (sr.hoveredGeohash !== rawGh) {
            sr.hoveredGeohash = rawGh
            updateHoverMesh(rawGh)
          }
          setHoverHud({
            geohash: channelKey,
            coords: formatCoords({ lat: hit.lat, lon: hit.lon }),
          })
        }
      }

      const finishPointer = (e: PointerEvent) => {
        activePointers.delete(e.pointerId)
        try {
          if (canvas.hasPointerCapture(e.pointerId)) {
            canvas.releasePointerCapture(e.pointerId)
          }
        } catch {
          // ignore already-released capture
        }

        const cam = cameraStateRef.current
        if (activePointers.size === 1) {
          const [remId, pt] = Array.from(activePointers.entries())[0]
          dragPrimaryId = remId
          dragLastX = pt.x
          dragLastY = pt.y
          lastPinchDist = 0
          return
        }

        if (activePointers.size === 0) {
          const wasClick =
            e.pointerId === dragPrimaryId &&
            dragMovedPx < 6 &&
            performance.now() - dragDownMs < 380 &&
            Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY) < 8

          cam.dragging = false
          wrap.classList.remove('is-dragging')
          dragPrimaryId = null
          lastPinchDist = 0

          if (wasClick) {
            cam.velLat = 0
            cam.velLon = 0
            const hit = raycastScene(e.clientX, e.clientY)
            if (hit) {
              if (hit.kind === 'body') {
                lastTapMs = 0
                if (hit.bodyId === 'sun') {
                  fitSolarSystemInternal()
                } else {
                  focusBodyInternal(hit.bodyId, { animate: true })
                }
                return
              }

              const nowMs = performance.now()
              const isTouchDoubleTap =
                e.pointerType !== 'mouse' &&
                nowMs - lastTapMs < 320 &&
                Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 22

              const resolvedKey =
                hit.kind === 'asteroid'
                  ? hit.channelKey
                  : hit.kind === 'pin'
                    ? hit.channelKey
                    : (() => {
                        const rawGh = encodeGeohash(
                          hit.lat,
                          hit.lon,
                          precisionModeRef.current === 'auto'
                            ? getRecommendedPrecisionForZoom(cam.zoom)
                            : precisionModeRef.current,
                        )
                        return makeCelestialChannelKey(activeBodyIdRef.current, rawGh) ?? rawGh
                      })()

              if (isTouchDoubleTap && modeRef.current === 'expanded') {
                lastTapMs = 0
                emitTuneChannel(resolvedKey)
              } else {
                lastTapMs = nowMs
                lastTapX = e.clientX
                lastTapY = e.clientY
                emitSelectChannel(resolvedKey)
                if (hit.kind === 'asteroid') {
                  flyToTopicInternal(hit.channelKey, { animate: true })
                }
              }
            }
          } else {
            scheduleViewportEmit()
          }
        }
      }

      const onDoubleClick = (e: MouseEvent) => {
        if (modeRef.current !== 'expanded') return
        cameraStateRef.current.wheelAnchor = null
        const hit = raycastScene(e.clientX, e.clientY)
        if (!hit) return
        if (hit.kind === 'body') {
          if (hit.bodyId === 'sun') fitSolarSystemInternal()
          else focusBodyInternal(hit.bodyId, { animate: true })
          return
        }
        if (hit.kind === 'asteroid' || hit.kind === 'pin') {
          emitTuneChannel(hit.channelKey)
          return
        }
        const cam = cameraStateRef.current
        const p =
          precisionModeRef.current === 'auto'
            ? getRecommendedPrecisionForZoom(cam.zoom)
            : precisionModeRef.current
        const rawGh = encodeGeohash(hit.lat, hit.lon, p)
        const channelKey = makeCelestialChannelKey(activeBodyIdRef.current, rawGh) ?? rawGh
        emitTuneChannel(channelKey)
      }

      const onPointerLeave = () => {
        if (sceneRefs.current) {
          if (sceneRefs.current.hoveredGeohash !== null) {
            sceneRefs.current.hoveredGeohash = null
            updateHoverMesh(null)
          }
          sceneRefs.current.hoveredAsteroidKey = null
          sceneRefs.current.hoveredBodyId = null
        }
        canvas.style.cursor = ''
        setHoverHud(null)
      }

      const onWheel = (e: WheelEvent) => {
        e.preventDefault()
        e.stopPropagation()

        let delta = e.deltaY
        if (e.deltaMode === 1) delta *= 18
        else if (e.deltaMode === 2) delta *= 160
        if (!Number.isFinite(delta) || delta === 0) return

        let zoomStep: number
        if (e.ctrlKey) {
          zoomStep = clamp(-delta * 0.012, -0.55, 0.55)
        } else if (e.deltaMode === 0 && Math.abs(delta) < 48) {
          zoomStep = clamp(-delta * 0.0052, -0.4, 0.4)
        } else {
          zoomStep = -Math.sign(delta) * Math.min(0.85, Math.max(0.32, Math.abs(delta) * 0.0052))
        }

        const cam = cameraStateRef.current
        const isPureZoomFlight =
          cam.isFlying &&
          (cam.wheelAnchor !== null ||
            (Math.abs(cam.targetLat - cam.lat) < 1e-4 && Math.abs(cam.targetLon - cam.lon) < 1e-4))
        const nextTargetZoom = clamp(
          (isPureZoomFlight ? cam.targetZoom : cam.zoom) + zoomStep,
          MIN_VIRTUAL_ZOOM,
          MAX_VIRTUAL_ZOOM,
        )

        const rect = canvas.getBoundingClientRect()
        const canReuseAnchor =
          cam.isFlying &&
          cam.wheelAnchor !== null &&
          Math.hypot(e.clientX - cam.wheelAnchor.clientX, e.clientY - cam.wheelAnchor.clientY) <= 2

        if (!canReuseAnchor) {
          if (rect.width > 0 && rect.height > 0) {
            const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1
            const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1)
            const hitUnit =
              Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1
                ? sampleWorldUnitAtNdc(
                    ndcX,
                    ndcY,
                    camera.aspect,
                    cam.lat,
                    cam.lon,
                    zoomToDistance(cam.zoom),
                  )
                : null
            cam.wheelAnchor = hitUnit
              ? {
                  wx: hitUnit[0],
                  wy: hitUnit[1],
                  wz: hitUnit[2],
                  ndcX,
                  ndcY,
                  clientX: e.clientX,
                  clientY: e.clientY,
                }
              : null
          } else {
            cam.wheelAnchor = null
          }
        }

        cam.velLat = 0
        cam.velLon = 0
        cam.targetZoom = nextTargetZoom
        cam.targetLat = cam.lat
        cam.targetLon = cam.lon
        cam.isFlying = true
        scheduleViewportEmit()
      }

      const preventGesture = (e: Event) => {
        e.preventDefault()
      }

      const onContextLost = (e: Event) => {
        e.preventDefault()
        reportWebglFailure()
      }

      const wheelTarget: HTMLElement = hostRef.current ?? canvas
      canvas.addEventListener('pointerdown', onPointerDown)
      canvas.addEventListener('pointermove', onPointerMove)
      canvas.addEventListener('pointerup', finishPointer)
      canvas.addEventListener('pointercancel', finishPointer)
      canvas.addEventListener('pointerleave', onPointerLeave)
      canvas.addEventListener('dblclick', onDoubleClick)
      wheelTarget.addEventListener('wheel', onWheel, { passive: false })
      wheelTarget.addEventListener('gesturestart', preventGesture, { passive: false })
      wheelTarget.addEventListener('gesturechange', preventGesture, { passive: false })
      canvas.addEventListener('webglcontextlost', onContextLost, false)

      let lastW = initW
      let lastH = initH
      const ro = new ResizeObserver(() => {
        const nextW = Math.max(1, wrap.clientWidth)
        const nextH = Math.max(1, wrap.clientHeight)
        if (nextW === lastW && nextH === lastH) return
        lastW = nextW
        lastH = nextH
        camera.aspect = nextW / nextH
        camera.updateProjectionMatrix()
        cameraStateRef.current.wheelAnchor = null
        renderer.setSize(nextW, nextH, false)
        scheduleViewportEmit()
      })
      ro.observe(wrap)

      // ---------------------------------------------------------------------
      // Main 60fps rAF Loop: Camera + Solar System + Pin Scaling + Asteroids + Exact Projection
      // ---------------------------------------------------------------------
      const tmpVec = new THREE.Vector3()
      const tipVec = new THREE.Vector3()
      const camDir = new THREE.Vector3()
      let lastFrameMs = performance.now()
      let lastPatchCheckMs = 0
      let rafId = 0

      const projectWorldVecToScreen = (
        worldVec: THREE.Vector3,
        viewW: number,
        viewH: number,
      ): { x: number; y: number; visible: boolean } => {
        tmpVec.copy(worldVec)
        tmpVec.project(camera)
        if (tmpVec.z > 1 || tmpVec.z < -1) {
          return { x: 0, y: 0, visible: false }
        }
        const x = (tmpVec.x * 0.5 + 0.5) * viewW
        const y = (-tmpVec.y * 0.5 + 0.5) * viewH
        if (x < -160 || x > viewW + 160 || y < -160 || y > viewH + 160) {
          return { x, y, visible: false }
        }
        return { x, y, visible: true }
      }

      const projectPointToScreen = (
        lat: number,
        lon: number,
        viewW: number,
        viewH: number,
        minFacingDot: number,
      ): { x: number; y: number; visible: boolean } => {
        const [ux, uy, uz] = latLonToUnitVec3(lat, lon)
        const facing = ux * camDir.x + uy * camDir.y + uz * camDir.z
        if (facing <= minFacingDot) {
          return { x: 0, y: 0, visible: false }
        }
        tmpVec.set(ux * EARTH_RADIUS, uy * EARTH_RADIUS, uz * EARTH_RADIUS)
        return projectWorldVecToScreen(tmpVec, viewW, viewH)
      }

      const hideEl = (el: HTMLElement) => {
        if (el.dataset.vis !== '0') {
          el.dataset.vis = '0'
          el.style.visibility = 'hidden'
          el.style.opacity = '0'
          el.style.pointerEvents = 'none'
        }
      }

      const showElAt = (
        el: HTMLElement,
        x: number,
        y: number,
        anchor: 'center' | 'bottom-center' | 'top-center' = 'center',
      ) => {
        if (el.dataset.vis !== '1' || el.style.visibility !== 'visible') {
          el.dataset.vis = '1'
          el.style.visibility = 'visible'
          el.style.opacity = '1'
          el.style.pointerEvents = ''
        }
        if (anchor === 'bottom-center') {
          el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`
        } else if (anchor === 'top-center') {
          el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, 0)`
        } else {
          el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`
        }
      }

      const tick = (nowMs: number) => {
        if (isDisposed) return
        rafId = window.requestAnimationFrame(tick)

        const dt = clamp((nowMs - lastFrameMs) / 1000, 0.004, 0.064)
        lastFrameMs = nowMs

        const sr = sceneRefs.current
        if (sr) sr.orbitClockSec += dt

        const cam = cameraStateRef.current
        let cameraMoved = false

        if (cam.isFlying) {
          const alpha = 1 - Math.exp(-dt * 11.5)
          if (cam.wheelAnchor) {
            const dZoom = cam.targetZoom - cam.zoom
            const done = Math.abs(dZoom) < 0.002
            cam.zoom = done ? cam.targetZoom : cam.zoom + dZoom * alpha

            const solved = solveCameraLatLonForAnchor(
              [cam.wheelAnchor.wx, cam.wheelAnchor.wy, cam.wheelAnchor.wz],
              cam.wheelAnchor.ndcX,
              cam.wheelAnchor.ndcY,
              camera.aspect,
              zoomToDistance(cam.zoom),
              cam.lat,
              cam.lon,
            )
            if (solved) {
              cam.lat = solved.lat
              cam.lon = solved.lon
              cam.targetLat = solved.lat
              cam.targetLon = solved.lon
            } else {
              // Cursor zoomed past the sphere limb (e.g. pulling out into Solar System):
              // release the surface anchor and continue zooming smoothly toward targetZoom.
              cam.wheelAnchor = null
              cam.targetLat = cam.lat
              cam.targetLon = cam.lon
            }

            if (done) {
              cam.isFlying = false
              cam.wheelAnchor = null
              scheduleViewportEmit()
            }
          } else {
            const dLat = cam.targetLat - cam.lat
            const dLon = cam.targetLon - cam.lon
            const dZoom = cam.targetZoom - cam.zoom

            if (Math.abs(dLat) < 1e-5 && Math.abs(dLon) < 1e-5 && Math.abs(dZoom) < 0.002) {
              cam.lat = cam.targetLat
              cam.lon = cam.targetLon
              cam.zoom = cam.targetZoom
              cam.isFlying = false
              scheduleViewportEmit()
            } else {
              cam.lat += dLat * alpha
              cam.lon += dLon * alpha
              cam.zoom += dZoom * alpha
            }
          }
          cameraMoved = true
        } else if (!cam.dragging && (Math.abs(cam.velLat) > 0.02 || Math.abs(cam.velLon) > 0.02)) {
          cam.lat = clamp(cam.lat + cam.velLat * dt, -82, 82)
          cam.lon += cam.velLon * dt
          const decay = Math.exp(-dt * 7.5)
          cam.velLat *= decay
          cam.velLon *= decay
          if (Math.abs(cam.velLat) <= 0.02 && Math.abs(cam.velLon) <= 0.02) {
            cam.velLat = 0
            cam.velLon = 0
            scheduleViewportEmit()
          }
          cameraMoved = true
        }

        const dist = zoomToDistance(cam.zoom)
        const alt = Math.max(0, dist - EARTH_RADIUS)
        const nextNear = clamp(alt * 0.12, 5e-7, 1.5)
        const nextFar = alt < 0.05 ? Math.max(20, alt * 4000) : 1400
        if (
          Math.abs(camera.near - nextNear) > Math.max(1e-7, camera.near * 0.05) ||
          Math.abs(camera.far - nextFar) > Math.max(0.5, camera.far * 0.05)
        ) {
          camera.near = nextNear
          camera.far = nextFar
          camera.updateProjectionMatrix()
        }

        const [cx, cy, cz] = latLonToUnitVec3(cam.lat, cam.lon)
        camera.position.set(cx * dist, cy * dist, cz * dist)
        camera.lookAt(0, 0, 0)
        camDir.set(cx, cy, cz).normalize()
        const camPosTuple: [number, number, number] = [
          camera.position.x,
          camera.position.y,
          camera.position.z,
        ]

        // Exact geometric horizon cosine on unit sphere (eliminates back-hemisphere sliding dots!)
        const horizonCos = clamp(EARTH_RADIUS / Math.max(EARTH_RADIUS + 0.00001, dist), 0.01, 0.996)
        const visibleHorizonDot = horizonCos + 0.008
        const maxVisiblePrecision = getMaxVisibleSurfacePrecision(cam.zoom)
        if (maxVisiblePrecision !== lastSurfaceLodRef.current) {
          lastSurfaceLodRef.current = maxVisiblePrecision
          setSurfaceLodPrecision(maxVisiblePrecision)
        }
        const focusedBody = activeBodyIdRef.current
        const isEarthFocused = focusedBody === 'earth'
        const inDeepSpaceView = cam.zoom < -1.8
        const wallNowMs = Date.now()

        // Smoothly fade planetary orbital ellipses as user zooms out into Solar System view
        const orbitFade = cam.zoom < 0.8 ? clamp((0.8 - cam.zoom) / 3.2, 0, 1) : 0
        planetOrbitGroup.visible = orbitFade > 0.005
        if (planetOrbitGroup.visible) {
          for (const [pid, mat] of planetOrbitMats.entries()) {
            mat.opacity = orbitFade * (pid === focusedBody ? 0.36 : 0.22)
          }
        }
        const moonOrbitFade =
          cam.zoom < 2.6 && cam.zoom > -3.2
            ? clamp(Math.min((2.6 - cam.zoom) / 1.2, (cam.zoom + 3.2) / 1.2), 0, 1)
            : 0
        moonOrbitGroup.visible = moonOrbitFade > 0.01
        if (moonOrbitGroup.visible) {
          for (const mat of moonOrbitMats) {
            mat.opacity = 0.16 * moonOrbitFade
          }
        }

        // Dynamically scale 3D Red Push-Pins proportionally down to P9 (~31m altitude)
        const pinScale = clamp(alt * 0.044, 1.5e-7, 0.095)
        for (const entry of pinEntries.values()) {
          entry.root.scale.setScalar(pinScale * entry.scaleBoost)
        }

        // Advance smooth eternal orbital drift & rocky tumble for Earth Topic Asteroids (ZERO angle resets!)
        const hoveredAst = sr?.hoveredAsteroidKey ?? null
        const activeKey = activeChannelKeyRef.current
        const selectedKey = selectedChannelKeyRef.current
        if (isEarthFocused) {
          const motionMap = asteroidMotionRef.current
          for (const entry of asteroidEntries.values()) {
            let motion = motionMap.get(entry.channelKey)
            if (!motion) {
              motion = { orbitElapsedSec: sr?.orbitClockSec ?? 0, spinAngle: 0 }
              motionMap.set(entry.channelKey, motion)
            }
            const isSteady =
              entry.channelKey === hoveredAst || entry.channelKey === selectedKey
            if (!isSteady) {
              motion.orbitElapsedSec += dt
            }
            motion.spinAngle = (motion.spinAngle + entry.spec.spinSpeed * dt) % (Math.PI * 2)

            const [ax, ay, az] = computeAsteroidWorldPosition(entry.spec, motion.orbitElapsedSec)
            entry.worldPos.set(ax, ay, az)
            entry.root.position.set(ax, ay, az)
            entry.rockMesh.quaternion.setFromAxisAngle(entry.spinAxis, motion.spinAngle)

            const isHighlighted =
              entry.channelKey === selectedKey || entry.channelKey === activeKey
            const isHovered = entry.channelKey === hoveredAst
            entry.rockMaterial.uniforms.uHighlight.value = isHighlighted
              ? 1.0
              : isHovered
                ? 0.65
                : entry.isPinned
                  ? 0.22
                  : 0.0

            if (entry.orbitMaterial) {
              entry.orbitMaterial.opacity = isHighlighted || isHovered
                ? 0.38
                : entry.isPinned || entry.isLive
                  ? 0.075
                  : 0.03
            }
          }
        }

        if (nowMs - lastPatchCheckMs > 160 || cameraMoved) {
          if (nowMs - lastPatchCheckMs > 160) {
            lastPatchCheckMs = nowMs
            updatePatchTiles()
          }
        }

        try {
          renderer.render(scene, camera)
        } catch {
          isDisposed = true
          window.cancelAnimationFrame(rafId)
          reportWebglFailure()
          return
        }

        // Project 3D anchors -> 2D screen coordinates for DOM overlays
        const viewW = lastW
        const viewH = lastH
        const isCompact = modeRef.current === 'compact'
        const isNarrow = viewW < 640

        // 1. Active & Selected Geohash Pill Badges (suppressed in deep space or when a Red Pin chip owns that cell)
        const subParent = showSubZonesRef.current
          ? selectedGeohashRef.current || activeGeohashRef.current
          : null
        const activeSubParent = subParent && subParent.length < 9 ? subParent : null

        const activeEl = activePillElRef.current
        if (activeEl) {
          const gh = activeGeohashRef.current
          const isTopicActive = isTopicChannel(activeChannelKeyRef.current)
          const activeChanKey = gh ? makeCelestialChannelKey(focusedBody, gh) : null
          const hasPinHere = activeChanKey ? pinEntries.has(activeChanKey) : false
          if (
            !inDeepSpaceView &&
            gh &&
            !isTopicActive &&
            !hasPinHere &&
            activeSubParent !== gh
          ) {
            const c = decodeCenter(gh)
            const p = projectPointToScreen(c.lat, c.lon, viewW, viewH, visibleHorizonDot)
            if (p.visible) showElAt(activeEl, p.x, p.y)
            else hideEl(activeEl)
          } else {
            hideEl(activeEl)
          }
        }

        const selEl = selectedPillElRef.current
        if (selEl) {
          const gh = selectedGeohashRef.current
          const isTopicSelected = Boolean(
            selectedChannelKeyRef.current && isTopicChannel(selectedChannelKeyRef.current),
          )
          const selChanKey = gh ? makeCelestialChannelKey(focusedBody, gh) : null
          const hasPinHere = selChanKey ? pinEntries.has(selChanKey) : false
          if (
            !inDeepSpaceView &&
            gh &&
            !isTopicSelected &&
            !hasPinHere &&
            gh !== activeGeohashRef.current &&
            activeSubParent !== gh
          ) {
            const c = decodeCenter(gh)
            const p = projectPointToScreen(c.lat, c.lon, viewW, viewH, visibleHorizonDot)
            if (p.visible) showElAt(selEl, p.x, p.y)
            else hideEl(selEl)
          } else {
            hideEl(selEl)
          }
        }

        // 2. User GPS Beacon (Earth only, hidden in deep Solar System pullback)
        const gpsEl = gpsBeaconElRef.current
        if (gpsEl) {
          const coords = userCoordsRef.current
          if (isEarthFocused && !inDeepSpaceView && coords) {
            const p = projectPointToScreen(coords.lat, coords.lon, viewW, viewH, visibleHorizonDot)
            if (p.visible) showElAt(gpsEl, p.x, p.y)
            else hideEl(gpsEl)
          } else {
            hideEl(gpsEl)
          }
        }

        // 3. Projected 3D Red Push-Pin Chips (exact geometric horizon occlusion!)
        for (const [chanKey, entry] of pinEntries.entries()) {
          const chipEl = pinChipElsRef.current.get(chanKey)
          if (!chipEl) continue
          if (
            inDeepSpaceView ||
            entry.normal.dot(camDir) <= visibleHorizonDot ||
            activeSubParent === entry.rawGeohash
          ) {
            hideEl(chipEl)
            continue
          }
          tipVec
            .copy(entry.normal)
            .multiplyScalar(EARTH_RADIUS + entry.headTipY * pinScale * entry.scaleBoost)
          const p = projectWorldVecToScreen(tipVec, viewW, viewH)
          if (!p.visible) {
            hideEl(chipEl)
            continue
          }
          showElAt(chipEl, p.x, p.y - 6, 'bottom-center')
        }

        // 4. Projected Topic Asteroid Chips (Earth only; hidden in deep Solar System view or behind Earth)
        const visibleAsteroidScreen = new Map<string, { x: number; y: number }>()
        for (const [key, entry] of asteroidEntries.entries()) {
          const chipEl = asteroidChipElsRef.current.get(key)
          if (!isEarthFocused || inDeepSpaceView) {
            if (chipEl) hideEl(chipEl)
            continue
          }
          const posArr: [number, number, number] = [
            entry.worldPos.x,
            entry.worldPos.y,
            entry.worldPos.z,
          ]
          const occluded = isPointOccludedByEarth(camPosTuple, posArr, EARTH_RADIUS)
          if (occluded) {
            if (chipEl) hideEl(chipEl)
            continue
          }
          const p = projectWorldVecToScreen(entry.worldPos, viewW, viewH)
          if (!p.visible) {
            if (chipEl) hideEl(chipEl)
            continue
          }
          visibleAsteroidScreen.set(key, { x: p.x, y: p.y })
          if (chipEl) {
            const hideInDeepEarthZoom =
              dist < 1.35 &&
              !entry.isPinned &&
              !entry.isLive &&
              key !== selectedKey &&
              key !== activeKey
            if (hideInDeepEarthZoom) {
              hideEl(chipEl)
            } else {
              showElAt(chipEl, p.x, p.y + 13, 'top-center')
            }
          }
        }

        // 5. Upward-Queued Speech Bubble Stacks (Precision-LOD filtered + Exact Horizon Occluded!)
        const placedBubbleBoxes: Array<{ l: number; r: number; t: number; b: number }> = []
        const visibleBubbleKeys = new Set<string>()
        const maxStacks = isCompact ? 3 : isNarrow ? 5 : 10
        const stackW = isNarrow ? 150 : 184
        const marginTop = !isCompact && viewH >= 440 ? (isNarrow ? 76 : 68) : 12
        const marginBottom = !isCompact && viewH >= 440 ? (isNarrow ? 104 : 96) : 12
        const marginRight = !isCompact ? (isNarrow ? 56 : 64) : 10

        const stacks = bubbleStacksRef.current
        for (const stack of stacks) {
          const el = bubbleStackElsRef.current.get(stack.geohash)
          if (!el) continue
          if (
            !showPulseRef.current ||
            !showBubblesRef.current ||
            visibleBubbleKeys.size >= maxStacks
          ) {
            hideEl(el)
            continue
          }

          if (stack.isTopic) {
            if (!isEarthFocused || inDeepSpaceView) {
              hideEl(el)
              continue
            }
          } else {
            if (
              stack.rawGeohash.length === 0 ||
              stack.rawGeohash.length > maxVisiblePrecision ||
              (!stack.isFocused && wallNowMs - stack.latestTsMs >= RECENT_BUBBLE_WINDOW_MS)
            ) {
              hideEl(el)
              continue
            }
          }

          let p: { x: number; y: number; visible: boolean }
          if (stack.isTopic) {
            const astPt = visibleAsteroidScreen.get(stack.geohash)
            p = astPt ? { x: astPt.x, y: astPt.y, visible: true } : { x: 0, y: 0, visible: false }
          } else {
            p = projectPointToScreen(
              stack.center.lat,
              stack.center.lon,
              viewW,
              viewH,
              visibleHorizonDot,
            )
          }

          if (!p.visible) {
            hideEl(el)
            continue
          }

          const approxH = Math.min(200, stack.bubbles.length * 46)
          const hasPin = !stack.isTopic && pinEntries.has(stack.geohash)
          const tailOffset = stack.isTopic ? 18 : hasPin ? 38 : stack.isFocused ? 22 : 14
          const box = {
            l: p.x - stackW / 2,
            r: p.x + stackW / 2,
            t: p.y - tailOffset - approxH,
            b: p.y - tailOffset,
          }

          const inSafeBounds =
            box.l >= 8 &&
            box.r <= viewW - marginRight &&
            box.b >= marginTop + 26 &&
            box.b <= viewH - marginBottom

          const overlaps = placedBubbleBoxes.some(
            (o) => box.l < o.r + 6 && box.r + 6 > o.l && box.t < o.b + 6 && box.b + 6 > o.t,
          )

          if (!inSafeBounds || overlaps) {
            hideEl(el)
            continue
          }

          placedBubbleBoxes.push(box)
          visibleBubbleKeys.add(stack.geohash)
          showElAt(el, p.x, p.y - tailOffset, 'bottom-center')
        }

        // 6. Live Pulse Surface Sonar Beacons (Dead-centered on exact lat/lon + Zoom Rollups + Exact Horizon!)
        const rooms = visiblePulseRoomsRef.current
        for (const room of rooms) {
          const el = beaconElsRef.current.get(room.geohash)
          if (!el) continue
          const targetRaw = getChannelRawGeohash(room.targetChannelKey) ?? room.rawGeohash
          if (
            !showPulseRef.current ||
            inDeepSpaceView ||
            room.rawGeohash.length === 0 ||
            room.rawGeohash.length > maxVisiblePrecision ||
            activeSubParent === targetRaw ||
            (!(room.isRollup && room.rollupCount >= 2) && pinEntries.has(room.targetChannelKey))
          ) {
            hideEl(el)
            continue
          }
          const p = projectPointToScreen(
            room.center.lat,
            room.center.lon,
            viewW,
            viewH,
            visibleHorizonDot,
          )
          if (!p.visible) {
            hideEl(el)
            continue
          }
          showElAt(el, p.x, p.y)
        }

        // 6b. On-Screen Live Room Count (onVisibleLiveCountChange) & Off-Screen Horizon Rim Pills
        const rawRooms = rawPulseRoomsRef.current
        const visMinY = isCompact ? 12 : 64
        const visMaxY = isCompact ? Math.max(24, viewH - 12) : Math.max(visMinY + 24, viewH - 120)

        let visibleLiveCount = 0
        let leftCount = 0
        let rightCount = 0
        let bestLeft: {
          room: PulseRoomOnBody
          ts: number
          underHour: boolean
          dotUp: number
        } | null = null
        let bestRight: {
          room: PulseRoomOnBody
          ts: number
          underHour: boolean
          dotUp: number
        } | null = null

        if (!inDeepSpaceView && showPulseRef.current && rawRooms.length > 0) {
          const camPhi = cam.lat * DEG2RAD
          const camLam = cam.lon * DEG2RAD
          const sinPhi = Math.sin(camPhi)
          const cosPhi = Math.cos(camPhi)
          const sinLam = Math.sin(camLam)
          const cosLam = Math.cos(camLam)
          // Orthonormal camera basis: camRight = (-sinλ, 0, -cosλ), camUp = (-sinφ cosλ, cosφ, sinφ sinλ)
          const camRightX = -sinLam
          const camRightZ = -cosLam
          const camUpX = -sinPhi * cosLam
          const camUpY = cosPhi
          const camUpZ = sinPhi * sinLam
          const rimMaxY = Math.max(88, viewH - 120)

          for (const room of rawRooms) {
            const [ux, uy, uz] = latLonToUnitVec3(room.center.lat, room.center.lon)
            const facing = ux * camDir.x + uy * camDir.y + uz * camDir.z
            let screenX = 0
            let screenY = 0
            let projectedFront = false
            if (facing > visibleHorizonDot) {
              tmpVec.set(ux * EARTH_RADIUS, uy * EARTH_RADIUS, uz * EARTH_RADIUS)
              const p = projectWorldVecToScreen(tmpVec, viewW, viewH)
              if (p.visible) {
                projectedFront = true
                screenX = p.x
                screenY = p.y
              }
            }

            if (
              projectedFront &&
              screenX >= 16 &&
              screenX <= viewW - 16 &&
              screenY >= visMinY &&
              screenY <= visMaxY
            ) {
              visibleLiveCount += 1
            }

            const onScreenForRim =
              projectedFront &&
              screenX >= 20 &&
              screenX <= viewW - 20 &&
              screenY >= 64 &&
              screenY <= rimMaxY

            if (!isCompact && !onScreenForRim) {
              const dotRight = ux * camRightX + uz * camRightZ
              const dotUp = ux * camUpX + uy * camUpY + uz * camUpZ
              const ts = room.lastMessageAt ?? room.lastActivityAt
              const underHour = wallNowMs - ts < WARM_BEACON_WINDOW_MS

              if (dotRight < 0) {
                leftCount += 1
                if (
                  !bestLeft ||
                  (underHour && !bestLeft.underHour) ||
                  (underHour === bestLeft.underHour && ts > bestLeft.ts)
                ) {
                  bestLeft = { room, ts, underHour, dotUp }
                }
              } else {
                rightCount += 1
                if (
                  !bestRight ||
                  (underHour && !bestRight.underHour) ||
                  (underHour === bestRight.underHour && ts > bestRight.ts)
                ) {
                  bestRight = { room, ts, underHour, dotUp }
                }
              }
            }
          }
        }

        if (visibleLiveCount !== lastVisibleLiveCountRef.current) {
          lastVisibleLiveCountRef.current = visibleLiveCount
          onVisibleLiveCountRef.current?.(visibleLiveCount)
        }

        const updateRimPill = (
          side: 'left' | 'right',
          candidate: { room: PulseRoomOnBody; ts: number; dotUp: number } | null,
          count: number,
        ) => {
          const btn = side === 'left' ? rimLeftBtnRef.current : rimRightBtnRef.current
          const dot = side === 'left' ? rimLeftDotRef.current : rimRightDotRef.current
          const tag = side === 'left' ? rimLeftTagRef.current : rimRightTagRef.current
          const metaEl = side === 'left' ? rimLeftMetaRef.current : rimRightMetaRef.current
          const moreEl = side === 'left' ? rimLeftMoreRef.current : rimRightMoreRef.current
          const cache = rimRenderCacheRef.current[side]
          if (!btn || !dot || !tag || !metaEl || !moreEl) return

          if (!candidate || count <= 0 || inDeepSpaceView || isCompact || viewH < 240) {
            if (cache.visible) {
              cache.visible = false
              cache.key = ''
              cache.count = 0
              rimTargetKeyRef.current[side] = ''
              btn.style.visibility = 'hidden'
              btn.style.opacity = '0'
              btn.style.pointerEvents = 'none'
            }
            return
          }

          const topPx = Math.round(
            clamp(viewH * 0.5 - candidate.dotUp * (viewH * 0.28), 96, Math.max(120, viewH - 220)),
          )
          const nextKey = candidate.room.geohash
          const nextTag = `#${nextKey}`
          const nextMeta = formatCompactAge(candidate.ts, wallNowMs)
          const nextMore = count > 1 ? `+${count - 1}` : ''
          const nextWarmth = getBeaconWarmthClass(candidate.ts, wallNowMs)

          rimTargetKeyRef.current[side] = nextKey
          if (!cache.visible) {
            cache.visible = true
            btn.style.visibility = 'visible'
            btn.style.opacity = '1'
            btn.style.pointerEvents = 'auto'
          }
          if (cache.topPx !== topPx) {
            cache.topPx = topPx
            btn.style.top = `${topPx}px`
          }
          if (cache.warmth !== nextWarmth) {
            cache.warmth = nextWarmth
            dot.className = `ag-globe-rim-dot ${nextWarmth}`
          }
          if (cache.tag !== nextTag) {
            cache.tag = nextTag
            tag.textContent = nextTag
          }
          const metaChanged = cache.meta !== nextMeta
          if (metaChanged) {
            cache.meta = nextMeta
            metaEl.textContent = nextMeta
          }
          if (cache.more !== nextMore) {
            cache.more = nextMore
            moreEl.textContent = nextMore
            moreEl.style.display = nextMore ? '' : 'none'
          }
          if (cache.key !== nextKey || cache.count !== count || metaChanged) {
            cache.key = nextKey
            cache.count = count
            const cityPart = candidate.room.nearestCity ? ` · ${candidate.room.nearestCity}` : ''
            const morePart = count > 1 ? ` (+${count - 1} more ${side})` : ''
            btn.title = `${nextTag}${cityPart} · ${nextMeta}${morePart} — click to fly`
            btn.setAttribute('aria-label', `Fly to ${nextTag}, active ${nextMeta} ago${morePart}`)
          }
        }

        updateRimPill('left', bestLeft, leftCount)
        updateRimPill('right', bestRight, rightCount)

        // 7. Projected Clickable Solar System Planet, Moon, Sun & Focused-World Chips (.ag-globe-body-chip)
        const placedBodyBoxes: Array<{ l: number; r: number; t: number; b: number }> = []
        const originWorldVec = new THREE.Vector3(0, 0, 0)
        const bodyCandidates: Array<{
          id: CelestialBodyId
          def: CelestialBodyDef
          worldPos: THREE.Vector3
          isSun: boolean
          isParent: boolean
          isFocusedCentral: boolean
          el: HTMLButtonElement
          prio: number
        }> = []
        const pinCounts = pinCountByBodyRef.current

        for (const [bodyId, el] of bodyChipElsRef.current.entries()) {
          if (bodyId === focusedBody) {
            // In Solar System Overview (zoom < -1.8), label the central focused world (e.g. Earth) too!
            if (!inDeepSpaceView) {
              hideEl(el)
              continue
            }
            bodyCandidates.push({
              id: bodyId,
              def: SOLAR_BODIES[bodyId],
              worldPos: originWorldVec,
              isSun: false,
              isParent: false,
              isFocusedCentral: true,
              el,
              prio: 96,
            })
            continue
          }

          const entry = bodyEntries.get(bodyId)
          if (!entry) {
            hideEl(el)
            continue
          }

          let shouldShow = false
          let prio = 10
          if (entry.isParentOfFocused) {
            shouldShow = cam.zoom < 2.8
            prio = 100
          } else if (entry.isChildMoon) {
            shouldShow = cam.zoom < 2.2 && cam.zoom > -3.4
            prio = 85
          } else if (entry.isSiblingMoon) {
            shouldShow = cam.zoom < 2.4 && cam.zoom > -3.4
            prio = 75
          } else if (entry.isSun) {
            shouldShow = cam.zoom < -0.6
            prio = 92
          } else if (entry.isPlanet) {
            shouldShow = cam.zoom < -0.6
            const pins = bodyId !== 'sun' ? (pinCounts.get(bodyId) ?? 0) : 0
            prio = 40 + (pins > 0 ? 30 : 0) + Math.min(18, entry.def.visualRadius * 6)
          }

          if (!shouldShow) {
            hideEl(el)
            continue
          }

          bodyCandidates.push({
            id: bodyId,
            def: entry.def,
            worldPos: entry.worldPos,
            isSun: entry.isSun,
            isParent: entry.isParentOfFocused,
            isFocusedCentral: false,
            el,
            prio,
          })
        }

        bodyCandidates.sort((a, b) => b.prio - a.prio)
        for (const cand of bodyCandidates) {
          if (!cand.isFocusedCentral) {
            const posArr: [number, number, number] = [
              cand.worldPos.x,
              cand.worldPos.y,
              cand.worldPos.z,
            ]
            if (isPointOccludedByEarth(camPosTuple, posArr, EARTH_RADIUS)) {
              hideEl(cand.el)
              continue
            }
          }
          const p = projectWorldVecToScreen(cand.worldPos, viewW, viewH)
          if (
            !p.visible ||
            p.x < 24 ||
            p.x > viewW - 24 ||
            p.y < 38 ||
            p.y > viewH - 30
          ) {
            hideEl(cand.el)
            continue
          }
          const approxW = Math.max(54, cand.def.name.length * 7.2 + 24)
          const offsetPx = cand.isSun ? 20 : cand.isParent ? 22 : 14
          const belowBox = {
            l: p.x - approxW / 2,
            r: p.x + approxW / 2,
            t: p.y + offsetPx,
            b: p.y + offsetPx + 22,
          }
          const belowOverlaps = placedBodyBoxes.some(
            (o) =>
              belowBox.l < o.r + 3 &&
              belowBox.r + 3 > o.l &&
              belowBox.t < o.b + 3 &&
              belowBox.b + 3 > o.t,
          )
          if (!belowOverlaps) {
            placedBodyBoxes.push(belowBox)
            showElAt(cand.el, p.x, p.y + offsetPx, 'top-center')
            continue
          }
          // Try placing cleanly above the body so inner Solar System worlds (Sun/Mercury/Venus/Earth) stay all visible!
          const aboveBox = {
            l: p.x - approxW / 2,
            r: p.x + approxW / 2,
            t: p.y - offsetPx - 22,
            b: p.y - offsetPx,
          }
          const aboveOverlaps =
            aboveBox.t < 42 ||
            placedBodyBoxes.some(
              (o) =>
                aboveBox.l < o.r + 3 &&
                aboveBox.r + 3 > o.l &&
                aboveBox.t < o.b + 3 &&
                aboveBox.b + 3 > o.t,
            )
          if (!aboveOverlaps) {
            placedBodyBoxes.push(aboveBox)
            showElAt(cand.el, p.x, p.y - offsetPx, 'bottom-center')
            continue
          }
          hideEl(cand.el)
        }
      }

      rafId = window.requestAnimationFrame(tick)
      emitViewport()
      updatePatchTiles()

      return () => {
        isDisposed = true
        window.cancelAnimationFrame(rafId)
        window.clearInterval(sunTimer)
        if (viewportDebounceTimer !== null) {
          window.clearTimeout(viewportDebounceTimer)
        }
        ro.disconnect()
        canvas.removeEventListener('pointerdown', onPointerDown)
        canvas.removeEventListener('pointermove', onPointerMove)
        canvas.removeEventListener('pointerup', finishPointer)
        canvas.removeEventListener('pointercancel', finishPointer)
        canvas.removeEventListener('pointerleave', onPointerLeave)
        canvas.removeEventListener('dblclick', onDoubleClick)
        wheelTarget.removeEventListener('wheel', onWheel)
        wheelTarget.removeEventListener('gesturestart', preventGesture)
        wheelTarget.removeEventListener('gesturechange', preventGesture)
        canvas.removeEventListener('webglcontextlost', onContextLost)

        starfield.geometry.dispose()
        starfield.material.dispose()
        sunCoreGeo.dispose()
        sunCoreMat.dispose()
        sunCoronaTex.dispose()
        sunCoronaMat.dispose()
        sunHitGeo.dispose()
        sunHitMat.dispose()
        earthGeo.dispose()
        earthMaterial.dispose()
        planetCentralMaterial.dispose()
        surfaceMaps.dispose()
        baseTexture.dispose()
        atmosphereGeo.dispose()
        atmosphereMaterial.dispose()

        for (const entry of patchCache.values()) {
          entry.geometry.dispose()
          entry.material.dispose()
          entry.texture.dispose()
        }
        patchCache.clear()
        pinEntries.clear()
        asteroidEntries.clear()
        bodyEntries.clear()
        planetOrbitMats.clear()
        moonOrbitMats.length = 0
        disposeObject3D(centralRingGroup)
        disposeObject3D(solarSystemGroup)
        disposeObject3D(planetOrbitGroup)
        disposeObject3D(moonOrbitGroup)
        disposeObject3D(gridGroup)
        disposeObject3D(subZoneGroup)
        disposeObject3D(pulseGroup)
        disposeObject3D(focusGroup)
        disposeObject3D(hoverGroup)
        disposeObject3D(gpsGroup)
        disposeObject3D(pinGroup)
        disposeObject3D(asteroidOrbitGroup)
        disposeObject3D(asteroidGroup)

        renderer.dispose()
        if (canvas.parentElement === wrap) {
          wrap.removeChild(canvas)
        }
        sceneRefs.current = null
      }
      // Intentionally mount once per component instance
    }, [emitSelectChannel, emitTuneChannel, fitSolarSystemInternal, flyToTopicInternal, focusBodyInternal])

    // -----------------------------------------------------------------------
    // 2. React to Theme Switches
    // -----------------------------------------------------------------------
    useEffect(() => {
      const sr = sceneRefs.current
      if (!sr) return
      const palette = readCanvasPalette(hostRef.current, theme)
      sr.scene.background = new THREE.Color(palette.spaceBg)

      const nextKind: 'dark' | 'light' = theme === 'daylight' ? 'light' : 'dark'
      if (sr.tileKind !== nextKind) {
        sr.tileKind = nextKind
        const isLightVal = nextKind === 'light' ? 1.0 : 0.0
        sr.earthMaterial.uniforms.uIsLight.value = isLightVal
        for (const entry of sr.patchCache.values()) {
          entry.material.uniforms.uIsLight.value = isLightVal
        }
      }
    }, [theme])

    // -----------------------------------------------------------------------
    // 2b. React to Focused Solar System Body Switches (Floating-Origin World)
    // -----------------------------------------------------------------------
    useEffect(() => {
      const sr = sceneRefs.current
      if (!sr) return
      sr.rebuildSolarSystem(activeBodyId, new Date())
      sr.hoveredGeohash = null
      sr.hoveredAsteroidKey = null
      sr.hoveredBodyId = null
      sr.updateHoverMesh(null)
      sr.updatePatchTiles()
      sr.scheduleViewportEmit()

      if (prevBodyIdRef.current !== activeBodyId) {
        prevBodyIdRef.current = activeBodyId
        if (lastFlyBodyRef.current !== activeBodyId) {
          flyToSunlitFace(activeBodyId, true, 1.95)
        }
      }
      lastFlyBodyRef.current = null
    }, [activeBodyId, flyToSunlitFace])

    // -----------------------------------------------------------------------
    // 3. Smoothly Fly Globe Whenever activeGeohash Changes Externally
    // -----------------------------------------------------------------------
    useEffect(() => {
      if (prevActiveKeyRef.current === effectiveActiveKey) return
      prevActiveKeyRef.current = effectiveActiveKey
      if (!effectiveActiveKey || isTopicChannel(effectiveActiveKey)) return
      if (!parseCelestialChannelKey(effectiveActiveKey)) return
      flyToCellInternal(effectiveActiveKey, { animate: true })
    }, [effectiveActiveKey, flyToCellInternal])

    // -----------------------------------------------------------------------
    // 4. Emit Effective Precision Whenever precisionMode Changes
    // -----------------------------------------------------------------------
    useEffect(() => {
      const z = cameraStateRef.current.zoom
      const p = precisionMode === 'auto' ? getRecommendedPrecisionForZoom(z) : precisionMode
      onViewportInfoRef.current?.({ zoom: z, effectivePrecision: p })
    }, [precisionMode])

    // -----------------------------------------------------------------------
    // 5. Render Curved Geohash Grid Lines on the Focused Sphere (Float64 RTC)
    // -----------------------------------------------------------------------
    useEffect(() => {
      const sr = sceneRefs.current
      if (!sr) return
      const group = sr.gridGroup
      while (group.children.length > 0) {
        const ch = group.children[0]
        group.remove(ch)
        disposeObject3D(ch)
      }

      const cam = cameraStateRef.current
      if (cam.zoom < -1.8) return
      const dist = zoomToDistance(cam.zoom)
      const effectivePrecision =
        precisionMode === 'auto' ? getRecommendedPrecisionForZoom(cam.zoom) : precisionMode

      const halfFovRad = (CAMERA_FOV_DEG * DEG2RAD) / 2
      const halfAngRad = computeVisibleHalfAngleRad(dist, halfFovRad)
      const halfLatDeg = Math.min(84, halfAngRad * RAD2DEG * 1.15)
      const aspect = sr.camera.aspect || 1
      const cosLat = Math.max(0.22, Math.cos(cam.lat * DEG2RAD))
      const halfLonDeg = Math.min(180, (halfLatDeg * aspect) / cosLat)

      const bounds =
        halfLonDeg >= 175
          ? {
              latMin: Math.max(-85, cam.lat - halfLatDeg),
              latMax: Math.min(85, cam.lat + halfLatDeg),
              lonMin: -180,
              lonMax: 180,
            }
          : {
              latMin: Math.max(-85, cam.lat - halfLatDeg),
              latMax: Math.min(85, cam.lat + halfLatDeg),
              lonMin: cam.lon - halfLonDeg,
              lonMax: cam.lon + halfLonDeg,
            }

      const cells = getGeohashCellsInBounds(bounds, effectivePrecision, mode === 'compact' ? 84 : 164)
      if (cells.length === 0) return

      const focusSet = new Set<string>()
      if (activeGeohashOnBody) focusSet.add(activeGeohashOnBody)
      if (selectedGeohashOnBody) focusSet.add(selectedGeohashOnBody)

      const anchor = latLonToUnitVec3(cam.lat, cam.lon)
      const segs: number[] = []
      for (const cell of cells) {
        if (focusSet.has(cell.geohash)) continue
        pushCurvedRectSegments(
          segs,
          cell.bounds.latMin,
          cell.bounds.latMax,
          cell.bounds.lonMin,
          cell.bounds.lonMax,
          OVERLAY_LINE_RADIUS,
          anchor,
        )
      }
      if (segs.length === 0) return

      const pal = readCanvasPalette(hostRef.current, theme)
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
      const mat = new THREE.LineBasicMaterial({
        color: new THREE.Color(pal.accent),
        transparent: true,
        opacity: pal.isLight ? 0.34 : 0.28,
        depthWrite: false,
      })
      const lines = new THREE.LineSegments(geo, mat)
      lines.position.set(anchor[0], anchor[1], anchor[2])
      lines.renderOrder = 5
      group.add(lines)
    }, [viewportTick, precisionMode, activeGeohashOnBody, selectedGeohashOnBody, activeBodyId, mode, theme])

    // -----------------------------------------------------------------------
    // 6. Render Optional 32× Child Sub-Zones Curved on the Sphere (Float64 RTC)
    // -----------------------------------------------------------------------
    useEffect(() => {
      const sr = sceneRefs.current
      if (!sr) return
      const group = sr.subZoneGroup
      while (group.children.length > 0) {
        const ch = group.children[0]
        group.remove(ch)
        disposeObject3D(ch)
      }
      if (!subZoneParent) return

      const children = getChildGeohashes(subZoneParent)
      if (children.length === 0) return

      const parentCenter = decodeCenter(subZoneParent)
      const anchor = latLonToUnitVec3(parentCenter.lat, parentCenter.lon)
      const pal = readCanvasPalette(hostRef.current, theme)
      const color = new THREE.Color(pal.accentSecondary)

      const fillGeo = buildCurvedRectFillGeometry(
        children.map((c) => c.bounds),
        OVERLAY_FILL_RADIUS,
        anchor,
      )
      const fillMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.06,
        side: THREE.FrontSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      })
      const fillMesh = new THREE.Mesh(fillGeo, fillMat)
      fillMesh.position.set(anchor[0], anchor[1], anchor[2])
      fillMesh.renderOrder = 4
      group.add(fillMesh)

      const segs: number[] = []
      for (const child of children) {
        pushCurvedRectSegments(
          segs,
          child.bounds.latMin,
          child.bounds.latMax,
          child.bounds.lonMin,
          child.bounds.lonMax,
          OVERLAY_LINE_RADIUS,
          anchor,
        )
      }
      const lineGeo = new THREE.BufferGeometry()
      lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
      const lineMat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
      })
      const lines = new THREE.LineSegments(lineGeo, lineMat)
      lines.position.set(anchor[0], anchor[1], anchor[2])
      lines.renderOrder = 5
      group.add(lines)
    }, [subZoneParent, activeBodyId, theme])

    // -----------------------------------------------------------------------
    // 7. Render Live Global Pulse Zone Highlights on the Sphere (Per-Cell Float64 RTC)
    // -----------------------------------------------------------------------
    useEffect(() => {
      const sr = sceneRefs.current
      if (!sr) return
      const group = sr.pulseGroup
      while (group.children.length > 0) {
        const ch = group.children[0]
        group.remove(ch)
        disposeObject3D(ch)
      }
      if (!showPulse || validPulseRooms.length === 0) return

      const pal = readCanvasPalette(hostRef.current, theme)
      const color = new THREE.Color(pal.accent)

      for (const room of validPulseRooms) {
        const b = decodeBounds(room.rawGeohash)
        const c = decodeCenter(room.rawGeohash)
        const anchor = latLonToUnitVec3(c.lat, c.lon)

        const fillGeo = buildCurvedRectFillGeometry([b], OVERLAY_FILL_RADIUS, anchor)
        const fillMat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.11,
          side: THREE.FrontSide,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
        })
        const fillMesh = new THREE.Mesh(fillGeo, fillMat)
        fillMesh.position.set(anchor[0], anchor[1], anchor[2])
        fillMesh.renderOrder = 4
        group.add(fillMesh)

        const segs: number[] = []
        pushCurvedRectSegments(segs, b.latMin, b.latMax, b.lonMin, b.lonMax, OVERLAY_LINE_RADIUS, anchor)
        const lineGeo = new THREE.BufferGeometry()
        lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
        const lineMat = new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0.56,
          depthWrite: false,
        })
        const lines = new THREE.LineSegments(lineGeo, lineMat)
        lines.position.set(anchor[0], anchor[1], anchor[2])
        lines.renderOrder = 5
        group.add(lines)
      }
    }, [showPulse, validPulseRooms, theme])

    // -----------------------------------------------------------------------
    // 8. Render Active Tuned & Selected Geohash Curved Polygon Fill & Borders (Float64 RTC)
    // -----------------------------------------------------------------------
    useEffect(() => {
      const sr = sceneRefs.current
      if (!sr) return
      const group = sr.focusGroup
      while (group.children.length > 0) {
        const ch = group.children[0]
        group.remove(ch)
        disposeObject3D(ch)
      }

      const pal = readCanvasPalette(hostRef.current, theme)

      const addFocusCell = (gh: string, hexColor: string, fillOpacity: number) => {
        const b = decodeBounds(gh)
        const c = decodeCenter(gh)
        const anchor = latLonToUnitVec3(c.lat, c.lon)
        const col = new THREE.Color(hexColor)

        const fillGeo = buildCurvedRectFillGeometry([b], OVERLAY_FILL_RADIUS, anchor)
        const fillMat = new THREE.MeshBasicMaterial({
          color: col,
          transparent: true,
          opacity: fillOpacity,
          side: THREE.FrontSide,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
        })
        const fillMesh = new THREE.Mesh(fillGeo, fillMat)
        fillMesh.position.set(anchor[0], anchor[1], anchor[2])
        fillMesh.renderOrder = 6
        group.add(fillMesh)

        const segs: number[] = []
        pushCurvedRectSegments(segs, b.latMin, b.latMax, b.lonMin, b.lonMax, FOCUS_LINE_RADIUS, anchor)
        const lineGeo = new THREE.BufferGeometry()
        lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
        const lineMat = new THREE.LineBasicMaterial({
          color: col,
          transparent: true,
          opacity: 0.94,
          depthWrite: false,
        })
        const lines = new THREE.LineSegments(lineGeo, lineMat)
        lines.position.set(anchor[0], anchor[1], anchor[2])
        lines.renderOrder = 7
        group.add(lines)
      }

      if (activeGeohashOnBody && !isTopicChannel(effectiveActiveKey)) {
        addFocusCell(activeGeohashOnBody, pal.accent, 0.16)
      }
      if (
        selectedGeohashOnBody &&
        selectedGeohashOnBody !== activeGeohashOnBody &&
        !(effectiveSelectedKey && isTopicChannel(effectiveSelectedKey))
      ) {
        addFocusCell(selectedGeohashOnBody, pal.accentSecondary, 0.15)
      }
    }, [activeGeohashOnBody, selectedGeohashOnBody, effectiveActiveKey, effectiveSelectedKey, activeBodyId, theme])

    // -----------------------------------------------------------------------
    // 9. Render Orbital Great-Circle Teleport Vector Arc When Teleported (Earth Only)
    // -----------------------------------------------------------------------
    useEffect(() => {
      const sr = sceneRefs.current
      if (!sr) return
      const group = sr.gpsGroup
      while (group.children.length > 0) {
        const ch = group.children[0]
        group.remove(ch)
        disposeObject3D(ch)
      }
      if (
        activeBodyId !== 'earth' ||
        !userCoords ||
        !isTeleported ||
        !activeGeohashOnBody ||
        isTopicChannel(effectiveActiveKey)
      ) {
        return
      }

      const activeCenter = decodeCenter(activeGeohashOnBody)
      const pal = readCanvasPalette(hostRef.current, theme)
      const arcGeo = buildCurvedTeleportArcGeometry(userCoords, activeCenter)
      const arcMat = new THREE.LineBasicMaterial({
        color: new THREE.Color(pal.accentSecondary),
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      })
      const line = new THREE.Line(arcGeo, arcMat)
      line.renderOrder = 7
      group.add(line)
    }, [activeBodyId, userCoords, isTeleported, activeGeohashOnBody, effectiveActiveKey, theme])

    // -----------------------------------------------------------------------
    // 10. Build Physical Sculpted 3D Red Push-Pins for Pinned Channels on Focused World
    // -----------------------------------------------------------------------
    useEffect(() => {
      const sr = sceneRefs.current
      if (!sr) return
      const group = sr.pinGroup
      while (group.children.length > 0) {
        const ch = group.children[0]
        group.remove(ch)
        disposeObject3D(ch)
      }
      pinEntriesRef.current.clear()

      if (pinnedEarthItems.length === 0) return

      const dist = zoomToDistance(cameraStateRef.current.zoom)
      const initPinScale = clamp(Math.max(0, dist - EARTH_RADIUS) * 0.044, 1.5e-7, 0.095)

      for (const item of pinnedEarthItems) {
        const normal = latLonToVec3(item.center.lat, item.center.lon, 1).normalize()
        const isFocused = item.isActive || item.isSelected
        const scaleBoost = isFocused ? 1.18 : 1.0
        const root = new THREE.Group()
        root.position.copy(normal).multiplyScalar(EARTH_RADIUS)
        root.quaternion.setFromUnitVectors(UP_Y, normal)
        root.scale.setScalar(initPinScale * scaleBoost)

        // All 3D push-pins are unambiguously vivid classic red (active/selected distinguished by 1.18x scale + base halo)
        const headHex = isFocused ? '#EF4444' : '#DC2626'
        const hasUnread = item.unreadCount > 0 || item.mentionCount > 0
        const ud = { channelKey: item.channelKey, rawGeohash: item.geohash, hitKind: 'pin' }

        // 1. Red base contact glow ring flush on world (+ crisp white/red halo ring when active/selected)
        const ringGeo = new THREE.RingGeometry(0.16, 0.36, 24)
        ringGeo.rotateX(-Math.PI / 2)
        const ringMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color('#EF4444'),
          transparent: true,
          opacity: isFocused ? 0.9 : 0.74,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
        const ringMesh = new THREE.Mesh(ringGeo, ringMat)
        ringMesh.position.y = 0.02
        ringMesh.userData = ud
        ringMesh.renderOrder = 8
        root.add(ringMesh)

        if (isFocused) {
          const whiteHaloGeo = new THREE.RingGeometry(0.39, 0.53, 28)
          whiteHaloGeo.rotateX(-Math.PI / 2)
          const whiteHaloMat = new THREE.MeshBasicMaterial({
            color: new THREE.Color('#FFFFFF'),
            transparent: true,
            opacity: 0.94,
            side: THREE.DoubleSide,
            depthWrite: false,
          })
          const whiteHaloMesh = new THREE.Mesh(whiteHaloGeo, whiteHaloMat)
          whiteHaloMesh.position.y = 0.028
          whiteHaloMesh.userData = ud
          whiteHaloMesh.renderOrder = 8
          root.add(whiteHaloMesh)

          const redOuterHaloGeo = new THREE.RingGeometry(0.53, 0.69, 28)
          redOuterHaloGeo.rotateX(-Math.PI / 2)
          const redOuterHaloMat = new THREE.MeshBasicMaterial({
            color: new THREE.Color('#F87171'),
            transparent: true,
            opacity: 0.62,
            side: THREE.DoubleSide,
            depthWrite: false,
          })
          const redOuterHaloMesh = new THREE.Mesh(redOuterHaloGeo, redOuterHaloMat)
          redOuterHaloMesh.position.y = 0.024
          redOuterHaloMesh.userData = ud
          redOuterHaloMesh.renderOrder = 8
          root.add(redOuterHaloMesh)
        }

        // 2. Metallic tapered pin shaft
        const shaftGeo = new THREE.CylinderGeometry(0.055, 0.022, 1.25, 10)
        const shaftMat = new THREE.MeshBasicMaterial({ color: '#E2E8F0' })
        const shaftMesh = new THREE.Mesh(shaftGeo, shaftMat)
        shaftMesh.position.y = 0.64
        shaftMesh.userData = ud
        shaftMesh.renderOrder = 9
        root.add(shaftMesh)

        // 3. Glossy 3D spherical red pinhead (custom lit specular shader)
        const headGeo = new THREE.SphereGeometry(0.32, 18, 14)
        const headMat = new THREE.ShaderMaterial({
          vertexShader: PINHEAD_VERTEX_SHADER,
          fragmentShader: PINHEAD_FRAGMENT_SHADER,
          uniforms: {
            uColor: { value: new THREE.Color(headHex) },
            uSunDir: { value: sr.sunDir.clone() },
          },
        })
        const headMesh = new THREE.Mesh(headGeo, headMat)
        headMesh.position.y = 1.38
        headMesh.userData = ud
        headMesh.renderOrder = 10
        root.add(headMesh)

        // 4. Red-accented halo ring around pinhead when unread / mentions exist
        if (hasUnread) {
          const haloGeo = new THREE.TorusGeometry(0.43, 0.045, 8, 24)
          haloGeo.rotateX(Math.PI / 2)
          const haloMat = new THREE.MeshBasicMaterial({
            color: item.mentionCount > 0 ? '#EF4444' : '#F87171',
            transparent: true,
            opacity: 0.92,
          })
          const haloMesh = new THREE.Mesh(haloGeo, haloMat)
          haloMesh.position.y = 1.38
          haloMesh.userData = ud
          haloMesh.renderOrder = 10
          root.add(haloMesh)
        }

        // 5. Generous invisible hit-sphere for easy mobile/desktop tapping
        const hitGeo = new THREE.SphereGeometry(0.72, 10, 8)
        const hitMat = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          depthWrite: false,
        })
        const hitMesh = new THREE.Mesh(hitGeo, hitMat)
        hitMesh.position.y = 1.22
        hitMesh.userData = ud
        root.add(hitMesh)

        group.add(root)
        pinEntriesRef.current.set(item.channelKey, {
          channelKey: item.channelKey,
          rawGeohash: item.geohash,
          root,
          normal,
          headTipY: 1.74,
          scaleBoost,
          hitMesh,
        })
      }
    }, [pinnedEarthItems])

    // -----------------------------------------------------------------------
    // 11. Reconcile Orbiting Procedural 3D Topic Asteroids In-Place (ZERO rotation resets!)
    // -----------------------------------------------------------------------
    useEffect(() => {
      const sr = sceneRefs.current
      if (!sr) return

      const group = sr.asteroidGroup
      const orbitGroup = sr.asteroidOrbitGroup
      const entries = asteroidEntriesRef.current
      const motionMap = asteroidMotionRef.current

      const pal = readCanvasPalette(hostRef.current, theme)
      const rimColor = new THREE.Color(pal.accentSecondary)
      const pinAccent = new THREE.Color('#EF4444')
      const activeAccent = new THREE.Color(pal.accent)

      const buildAsteroidPinBeacon = (
        spec: TopicAsteroidSpec,
        isPinFocused: boolean,
        ud: Record<string, unknown>,
      ): THREE.Group => {
        const beaconGroup = new THREE.Group()
        const pinBoost = isPinFocused ? 1.18 : 1.0
        const pinStemH = spec.rockRadius * 0.72 * pinBoost
        const stemGeo = new THREE.CylinderGeometry(
          spec.rockRadius * 0.07 * pinBoost,
          spec.rockRadius * 0.04 * pinBoost,
          pinStemH,
          8,
        )
        const stemMat = new THREE.MeshBasicMaterial({ color: '#E2E8F0' })
        const stemMesh = new THREE.Mesh(stemGeo, stemMat)
        stemMesh.position.y = spec.rockRadius * 0.92 + pinStemH * 0.45
        stemMesh.userData = ud
        stemMesh.renderOrder = 10
        beaconGroup.add(stemMesh)

        if (isPinFocused) {
          const collarGeo = new THREE.TorusGeometry(
            spec.rockRadius * 0.22,
            spec.rockRadius * 0.035,
            8,
            18,
          )
          collarGeo.rotateX(Math.PI / 2)
          const collarMat = new THREE.MeshBasicMaterial({
            color: '#FFFFFF',
            transparent: true,
            opacity: 0.9,
          })
          const collarMesh = new THREE.Mesh(collarGeo, collarMat)
          collarMesh.position.y = spec.rockRadius * 0.94
          collarMesh.userData = ud
          collarMesh.renderOrder = 10
          beaconGroup.add(collarMesh)
        }

        const beaconGeo = new THREE.SphereGeometry(spec.rockRadius * 0.27 * pinBoost, 12, 10)
        const beaconMat = new THREE.ShaderMaterial({
          vertexShader: PINHEAD_VERTEX_SHADER,
          fragmentShader: PINHEAD_FRAGMENT_SHADER,
          uniforms: {
            uColor: { value: pinAccent.clone() },
            uSunDir: { value: sr.sunDir.clone() },
          },
        })
        const beaconMesh = new THREE.Mesh(beaconGeo, beaconMat)
        beaconMesh.position.y =
          spec.rockRadius * 0.92 + pinStemH + spec.rockRadius * 0.16 * pinBoost
        beaconMesh.userData = ud
        beaconMesh.renderOrder = 10
        beaconGroup.add(beaconMesh)
        return beaconGroup
      }

      const desiredKeys = new Set(topicAsteroidItems.map((it) => it.channelKey))

      // 1. Remove asteroids no longer present
      for (const [key, entry] of Array.from(entries.entries())) {
        if (!desiredKeys.has(key)) {
          group.remove(entry.root)
          disposeObject3D(entry.root)
          if (entry.orbitLine) {
            orbitGroup.remove(entry.orbitLine)
            disposeObject3D(entry.orbitLine)
          }
          entries.delete(key)
          motionMap.delete(key)
        }
      }

      // 2. Reconcile existing asteroids in-place or mount new ones without resetting rock rotation!
      for (const item of topicAsteroidItems) {
        const { spec } = item
        const isHighlighted = item.isActive || item.isSelected
        const ud = { channelKey: item.channelKey, slug: item.slug, hitKind: 'asteroid' }
        const existing = entries.get(item.channelKey)

        if (existing) {
          existing.isLive = item.isLive
          existing.rockMaterial.uniforms.uRimColor.value.copy(
            isHighlighted ? activeAccent : rimColor,
          )
          if (existing.orbitMaterial) {
            existing.orbitMaterial.color.copy(isHighlighted ? activeAccent : rimColor)
          }
          // Only touch miniature red 3D pin beacon when pin/focus state actually changes
          if (existing.isPinned !== item.isPinned || existing.isPinFocused !== isHighlighted) {
            if (existing.pinBeaconGroup) {
              existing.root.remove(existing.pinBeaconGroup)
              disposeObject3D(existing.pinBeaconGroup)
              existing.pinBeaconGroup = null
            }
            if (item.isPinned) {
              const beaconGroup = buildAsteroidPinBeacon(spec, isHighlighted, ud)
              existing.root.add(beaconGroup)
              existing.pinBeaconGroup = beaconGroup
            }
            existing.isPinned = item.isPinned
            existing.isPinFocused = isHighlighted
          }
          continue
        }

        // Seed persistent motion state if brand new
        let motion = motionMap.get(item.channelKey)
        if (!motion) {
          motion = { orbitElapsedSec: sr.orbitClockSec, spinAngle: (spec.seed % 628) / 100 }
          motionMap.set(item.channelKey, motion)
        }
        const [wx, wy, wz] = computeAsteroidWorldPosition(spec, motion.orbitElapsedSec)
        const spinAxis = new THREE.Vector3(...spec.spinAxis).normalize()

        const root = new THREE.Group()
        root.position.set(wx, wy, wz)

        // Faceted cratered procedural 3D asteroid rock
        const rockGeo = createAsteroidRockGeometry(spec)
        const rockMaterial = new THREE.ShaderMaterial({
          vertexShader: ASTEROID_VERTEX_SHADER,
          fragmentShader: ASTEROID_FRAGMENT_SHADER,
          uniforms: {
            uSunDir: { value: sr.sunDir.clone() },
            uBaseColor: { value: new THREE.Color(spec.baseColorHex) },
            uRimColor: {
              value: isHighlighted ? activeAccent.clone() : rimColor.clone(),
            },
            uHighlight: {
              value: isHighlighted ? 1.0 : item.isPinned ? 0.22 : 0.0,
            },
            uMeanRadius: { value: spec.rockRadius },
          },
        })
        const rockMesh = new THREE.Mesh(rockGeo, rockMaterial)
        rockMesh.quaternion.setFromAxisAngle(spinAxis, motion.spinAngle)
        rockMesh.userData = ud
        rockMesh.renderOrder = 9
        root.add(rockMesh)

        let pinBeaconGroup: THREE.Group | null = null
        if (item.isPinned) {
          pinBeaconGroup = buildAsteroidPinBeacon(spec, isHighlighted, ud)
          root.add(pinBeaconGroup)
        }

        // Invisible larger hit-sphere (1.95x rockRadius) for effortless mobile & desktop tapping
        const hitGeo = new THREE.SphereGeometry(spec.rockRadius * 1.95, 10, 8)
        const hitMat = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          depthWrite: false,
        })
        const hitMesh = new THREE.Mesh(hitGeo, hitMat)
        hitMesh.userData = ud
        root.add(hitMesh)

        group.add(root)

        // Delicate orbital track ring
        const orbitGeo = createAsteroidOrbitLoopGeometry(spec)
        const orbitMaterial = new THREE.LineBasicMaterial({
          color: isHighlighted ? activeAccent : rimColor,
          transparent: true,
          opacity: isHighlighted ? 0.38 : item.isPinned || item.isLive ? 0.075 : 0.03,
          depthWrite: false,
        })
        const orbitLine = new THREE.LineLoop(orbitGeo, orbitMaterial)
        orbitLine.renderOrder = 2
        orbitGroup.add(orbitLine)

        entries.set(item.channelKey, {
          channelKey: item.channelKey,
          slug: item.slug,
          spec,
          root,
          rockMesh,
          rockMaterial,
          pinBeaconGroup,
          hitMesh,
          orbitLine,
          orbitMaterial,
          spinAxis,
          worldPos: new THREE.Vector3(wx, wy, wz),
          isPinned: item.isPinned,
          isPinFocused: isHighlighted,
          isLive: item.isLive,
        })
      }
    }, [topicAsteroidItems, theme])

    // Ref callbacks for projected DOM layers
    const setBubbleStackEl = useCallback((key: string, node: HTMLDivElement | null) => {
      if (node) bubbleStackElsRef.current.set(key, node)
      else bubbleStackElsRef.current.delete(key)
    }, [])

    const setBeaconEl = useCallback((gh: string, node: HTMLButtonElement | null) => {
      if (node) beaconElsRef.current.set(gh, node)
      else beaconElsRef.current.delete(gh)
    }, [])

    const setPinChipEl = useCallback((chanKey: string, node: HTMLButtonElement | null) => {
      if (node) pinChipElsRef.current.set(chanKey, node)
      else pinChipElsRef.current.delete(chanKey)
    }, [])

    const setAsteroidChipEl = useCallback((key: string, node: HTMLButtonElement | null) => {
      if (node) asteroidChipElsRef.current.set(key, node)
      else asteroidChipElsRef.current.delete(key)
    }, [])

    const setBodyChipEl = useCallback((id: CelestialBodyId, node: HTMLButtonElement | null) => {
      if (node) bodyChipElsRef.current.set(id, node)
      else bodyChipElsRef.current.delete(id)
    }, [])

    const placedBubbleKeySet = useMemo(
      () => new Set(bubbleStacks.map((s) => s.geohash)),
      [bubbleStacks],
    )

    const focusedBodyDef = SOLAR_BODIES[activeBodyId]
    const activePillLabel = activeGeohashOnBody
      ? makeCelestialChannelKey(activeBodyId, activeGeohashOnBody) ?? activeGeohashOnBody
      : ''
    const selectedPillLabel = selectedGeohashOnBody
      ? makeCelestialChannelKey(activeBodyId, selectedGeohashOnBody) ?? selectedGeohashOnBody
      : ''

    return (
      <div
        ref={hostRef}
        className={`ag-radar-map-host ag-radar-map-${mode} ${className}`}
        data-map-theme={theme}
        data-focused-body={activeBodyId}
      >
        {/* Three.js WebGL 3D Interactive Solar System + Focused Geohash Globe Canvas */}
        <div
          ref={canvasWrapRef}
          className="ag-globe-canvas-wrap"
          aria-label={`Interactive 3D Solar System globe focused on ${focusedBodyDef.name}${activePillLabel ? ` (#${activePillLabel})` : ''}`}
        />

        {/* Graceful Fallback if WebGL Cannot Initialize */}
        {webglError && (
          <div className="ag-globe-fallback" role="status">
            <div className="ag-globe-fallback-card">
              <div className="ag-globe-fallback-title">3D Globe Unavailable</div>
              <p className="ag-globe-fallback-sub">
                WebGL hardware graphics could not initialize on this device. Active cell:{' '}
                <span className="mono">#{activePillLabel || safeActiveGeohash || focusedBodyDef.name}</span>.
              </p>
            </div>
          </div>
        )}

        {/* Projected 3D -> 2D Interactive Overlay Layer (Exact Horizon & Limb Occluded in rAF) */}
        {!webglError && (
          <div className="ag-globe-bubble-layer" aria-hidden={false}>
            {/* Live Pulse Surface Sonar Beacons (Dot Dead-Centered on Exact lat/lon; 3-Tier Warmth + Rollups) */}
            {showPulse &&
              displayPulseRooms.map((room) => {
                const lastTs = room.lastMessageAt ?? room.lastActivityAt
                const warmth = getBeaconWarmthClass(lastTs, bubbleNowMs)
                const isFocused =
                  room.geohash === effectiveActiveKey ||
                  room.geohash === effectiveSelectedKey ||
                  room.targetChannelKey === effectiveActiveKey ||
                  room.targetChannelKey === effectiveSelectedKey
                const hasBubble =
                  showBubbles &&
                  placedBubbleKeySet.has(room.geohash) &&
                  (isFocused || bubbleNowMs - lastTs < RECENT_BUBBLE_WINDOW_MS)
                const isMultiRollup = room.isRollup && room.rollupCount >= 2
                const showPill =
                  !isFocused &&
                  !hasBubble &&
                  mode === 'expanded' &&
                  (isMultiRollup ||
                    warmth === 'is-warm' ||
                    (warmth === 'is-hot' && (room.peerCount >= 1 || room.isRollup)))
                const ageTag = formatCompactAge(lastTs, bubbleNowMs)
                const peerTag = room.peerCount > 0 ? `${room.peerCount}p` : `${room.messageCount}m`
                const pillSummary = isMultiRollup
                  ? `(${room.rollupCount}) · ${peerTag}`
                  : warmth === 'is-warm'
                    ? `${ageTag} · ${peerTag}`
                    : peerTag
                const titleDetail = isMultiRollup
                  ? `#${room.geohash} · ${room.rollupCount} active rooms (${room.peerCount} ${room.peerCount === 1 ? 'peer' : 'peers'}) — click to zoom in`
                  : `#${room.targetChannelKey}${room.nearestCity ? ` · ${room.nearestCity}` : ''} · ${ageTag} (${room.peerCount} ${room.peerCount === 1 ? 'peer' : 'peers'})`
                return (
                  <button
                    key={room.geohash}
                    ref={(node) => setBeaconEl(room.geohash, node)}
                    type="button"
                    className={`ag-globe-beacon ${warmth}${room.isRollup ? ' is-rollup' : ''}`}
                    style={{
                      visibility: 'hidden',
                      opacity: 0,
                    }}
                    title={titleDetail}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      emitSelectChannel(room.targetChannelKey)
                      if (room.isRollup) {
                        flyToCellInternal(room.targetChannelKey, { animate: true })
                      }
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      if (modeRef.current === 'expanded') {
                        emitTuneChannel(room.targetChannelKey)
                      }
                    }}
                  >
                    <span className={`ag-globe-beacon-dot ${warmth}`} />
                    {showPill && (
                      <span className="ag-globe-beacon-pill mono">
                        #{room.geohash}{' '}
                        <b style={{ color: 'var(--accent)', fontWeight: 700 }}>{pillSummary}</b>
                      </span>
                    )}
                  </button>
                )
              })}

            {/* Pinned Geohash Push-Pin Chips on Focused World (Anchored Above 3D Red Pinhead Tips) */}
            {pinnedEarthItems.map((item) => {
              const badgeCount = item.mentionCount > 0 ? item.mentionCount : item.unreadCount
              const isFocused = item.isActive || item.isSelected
              return (
                <button
                  key={item.channelKey}
                  ref={(node) => setPinChipEl(item.channelKey, node)}
                  type="button"
                  data-pin-color="red"
                  className={`ag-globe-pin-chip${item.isActive ? ' is-active' : ''}${item.isSelected ? ' is-selected' : ''}${badgeCount > 0 ? ' has-unread' : ''}`}
                  style={{
                    visibility: 'hidden',
                    opacity: 0,
                    borderColor: isFocused ? '#EF4444' : 'rgba(239, 68, 68, 0.56)',
                    boxShadow: isFocused
                      ? 'var(--shadow-md), 0 0 0 1.5px rgba(239, 68, 68, 0.45)'
                      : undefined,
                  }}
                  title={`Pinned #${item.channelKey} — click to inspect, double-click to join`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    emitSelectChannel(item.channelKey)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    emitTuneChannel(item.channelKey)
                  }}
                >
                  <span
                    className="ag-globe-pin-dot"
                    style={{
                      backgroundColor: '#EF4444',
                      boxShadow: '0 0 6px rgba(239, 68, 68, 0.8)',
                    }}
                    aria-hidden="true"
                  />
                  <span className="ag-globe-pin-label mono">#{item.channelKey}</span>
                  {badgeCount > 0 && (
                    <span
                      className={`ag-globe-pin-badge mono${item.mentionCount > 0 ? ' is-mention' : ''}`}
                    >
                      {item.mentionCount > 0 ? `@${item.mentionCount}` : badgeCount > 99 ? '99+' : badgeCount}
                    </span>
                  )}
                </button>
              )
            })}

            {/* Orbiting Solar System Planet, Moon & Sun Chips */}
            {solarChipBodies.map((body) => {
              const pinCount =
                body.id !== 'sun' ? (pinCountByBody.get(body.id) ?? 0) : 0
              const isParent = focusedBodyDef.kind === 'moon' && focusedBodyDef.parentId === body.id
              return (
                <button
                  key={body.id}
                  ref={(node) => setBodyChipEl(body.id, node)}
                  type="button"
                  data-body-id={body.id}
                  className={`ag-globe-body-chip${body.kind === 'star' ? ' is-sun' : ''}${body.kind === 'moon' ? ' is-moon' : ''}${isParent ? ' is-parent' : ''}${pinCount > 0 ? ' has-pins' : ''}`}
                  style={{ visibility: 'hidden', opacity: 0 }}
                  title={
                    body.id === 'sun'
                      ? 'Sun — click for Solar System Overview'
                      : `${body.name} — click to visit ${body.name}`
                  }
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (body.id === 'sun') {
                      fitSolarSystemInternal()
                    } else {
                      focusBodyInternal(body.id, { animate: true })
                    }
                  }}
                >
                  <span
                    className="ag-globe-body-dot"
                    style={{ backgroundColor: body.palette.primary }}
                    aria-hidden="true"
                  />
                  <span className="ag-globe-body-name">{body.name}</span>
                  {pinCount > 0 && (
                    <span className="ag-globe-body-pins mono" aria-label={`${pinCount} pinned`}>
                      <Pin size={9} color="#EF4444" aria-hidden="true" />
                      {pinCount}
                    </span>
                  )}
                </button>
              )
            })}

            {/* Orbiting Topic Asteroid Chips (`kind: 23333` — Earth Only) */}
            {activeBodyId === 'earth' &&
              topicAsteroidItems.map((item) => {
                const badgeCount = item.mentionCount > 0 ? item.mentionCount : item.unreadCount
                const isFocused = item.isActive || item.isSelected
                return (
                  <button
                    key={item.channelKey}
                    ref={(node) => setAsteroidChipEl(item.channelKey, node)}
                    type="button"
                    data-pin-color={item.isPinned ? 'red' : undefined}
                    className={`ag-globe-asteroid-chip${item.isPinned ? ' is-pinned' : ''}${item.isLive ? ' is-live' : ''}${item.isActive ? ' is-active' : ''}${item.isSelected ? ' is-selected' : ''}${badgeCount > 0 ? ' has-unread' : ''}`}
                    style={{
                      visibility: 'hidden',
                      opacity: 0,
                      borderColor: item.isPinned
                        ? isFocused
                          ? '#EF4444'
                          : 'rgba(239, 68, 68, 0.58)'
                        : undefined,
                      boxShadow:
                        item.isPinned && isFocused
                          ? '0 4px 16px rgba(2, 6, 23, 0.58), 0 0 0 1.5px rgba(239, 68, 68, 0.5)'
                          : undefined,
                    }}
                    title={`#${item.slug} · Topic Asteroid — click to focus, double-click to join`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      emitSelectChannel(item.channelKey)
                      flyToTopicInternal(item.channelKey, { animate: true })
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      emitTuneChannel(item.channelKey)
                    }}
                  >
                    {item.isPinned ? (
                      <span
                        className="ag-globe-asteroid-pin"
                        style={{ color: '#EF4444' }}
                        aria-hidden="true"
                      >
                        <Pin size={10} color="#EF4444" />
                      </span>
                    ) : (
                      <span
                        className={`ag-globe-asteroid-dot${item.isLive ? ' is-live' : ''}`}
                        aria-hidden="true"
                      />
                    )}
                    <span className="ag-globe-asteroid-slug mono">#{item.slug}</span>
                    {item.isLive && item.peerCount > 0 && (
                      <span className="ag-globe-asteroid-peers mono">{item.peerCount}p</span>
                    )}
                    {badgeCount > 0 && (
                      <span
                        className={`ag-globe-asteroid-badge mono${item.mentionCount > 0 ? ' is-mention' : ''}`}
                      >
                        {item.mentionCount > 0 ? `@${item.mentionCount}` : badgeCount > 99 ? '99+' : badgeCount}
                      </span>
                    )}
                  </button>
                )
              })}

            {/* Active Tuned Geohash Pill on Focused World */}
            {activePillLabel && (
              <div
                ref={activePillElRef}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  pointerEvents: 'none',
                  zIndex: 8,
                  visibility: 'hidden',
                  opacity: 0,
                }}
                aria-hidden="true"
              >
                <span
                  className="mono"
                  style={{
                    display: 'inline-block',
                    padding: '2px 7px',
                    borderRadius: '999px',
                    backgroundColor: 'var(--accent)',
                    color: 'var(--text-inverse)',
                    border: '1px solid color-mix(in srgb, var(--text-inverse) 28%, transparent)',
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.03em',
                    whiteSpace: 'nowrap',
                    boxShadow: 'var(--shadow-sm)',
                  }}
                >
                  #{activePillLabel}
                </span>
              </div>
            )}

            {/* Selected / Inspected Geohash Pill on Focused World */}
            {selectedPillLabel && selectedPillLabel !== activePillLabel && (
              <div
                ref={selectedPillElRef}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  pointerEvents: 'none',
                  zIndex: 9,
                  visibility: 'hidden',
                  opacity: 0,
                }}
                aria-hidden="true"
              >
                <span
                  className="mono"
                  style={{
                    display: 'inline-block',
                    padding: '2px 7px',
                    borderRadius: '999px',
                    backgroundColor: 'var(--accent-secondary)',
                    color: '#06131c',
                    border: '1px solid rgba(255, 255, 255, 0.35)',
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.03em',
                    whiteSpace: 'nowrap',
                    boxShadow: 'var(--shadow-sm)',
                  }}
                >
                  #{selectedPillLabel}
                </span>
              </div>
            )}

            {/* Physical User GPS Beacon (Earth Only) */}
            {activeBodyId === 'earth' && userCoords && (
              <div
                ref={gpsBeaconElRef}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  pointerEvents: 'none',
                  zIndex: 10,
                  visibility: 'hidden',
                  opacity: 0,
                }}
                aria-hidden="true"
              >
                <span
                  style={{
                    display: 'block',
                    width: 11,
                    height: 11,
                    borderRadius: '999px',
                    backgroundColor: 'var(--status-ok, #22c55e)',
                    border: '2px solid #ffffff',
                    boxShadow:
                      '0 0 0 4px rgba(34, 197, 94, 0.32), 0 0 10px rgba(34, 197, 94, 0.72)',
                  }}
                />
              </div>
            )}

            {/* Upward-Queued Speech Bubbles (Focused World Geohashes & Earth Topic Asteroids) */}
            {showPulse &&
              showBubbles &&
              bubbleStacks.map((stack) => (
                <div
                  key={stack.geohash}
                  ref={(node) => setBubbleStackEl(stack.geohash, node)}
                  className={`ag-globe-bubble-stack${stack.isTopic ? ' is-topic' : ''}${stack.isFocused ? ' is-focused' : ''}`}
                  style={{ visibility: 'hidden', opacity: 0 }}
                >
                  {stack.bubbles.map((bubble, idx) => {
                    const isLatest = idx === stack.bubbles.length - 1
                    const isDemoted = bubble.demotedAtMs !== null
                    const isRecent = bubbleNowMs - bubble.tsMs < RECENT_BUBBLE_WINDOW_MS
                    const bubbleAge = formatBubbleAge(bubble.tsMs, bubbleNowMs)
                    return (
                      <div
                        key={bubble.key}
                        role="button"
                        tabIndex={0}
                        className={`ag-globe-bubble${isLatest ? ' is-latest' : ' is-older'}${isDemoted ? ' is-demoted' : ''}${bubble.fadingOut ? ' is-fading' : ''}${isRecent ? ' is-recent' : ''}${stack.isFocused ? ' is-focused' : ''}`}
                        title={`${stack.displayTag} · ${bubbleAge} — ${bubble.sender}: ${bubble.snippet}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          emitSelectChannel(stack.targetChannelKey)
                          if (stack.isTopic) {
                            flyToTopicInternal(stack.targetChannelKey, { animate: true })
                          } else if (stack.isRollup) {
                            flyToCellInternal(stack.targetChannelKey, { animate: true })
                          }
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          emitTuneChannel(stack.targetChannelKey)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            emitSelectChannel(stack.targetChannelKey)
                            if (stack.isRollup && !stack.isTopic) {
                              flyToCellInternal(stack.targetChannelKey, { animate: true })
                            }
                          }
                        }}
                      >
                        <div className="ag-globe-bubble-head">
                          <span
                            className={`ag-globe-bubble-dot${isRecent && isLatest ? ' is-live' : ''}`}
                          />
                          <span className="ag-globe-bubble-sender">{bubble.sender}</span>
                          <span className="ag-globe-bubble-age mono">{bubbleAge}</span>
                          {isLatest && (
                            <span className="ag-globe-bubble-tag mono">{stack.displayTag}</span>
                          )}
                        </div>
                        <div className="ag-globe-bubble-body">{bubble.snippet}</div>
                      </div>
                    )
                  })}
                </div>
              ))}
          </div>
        )}

        {/* Off-Screen / Far-Side Horizon Rim Directional Pills (2 Pooled Buttons Updated Imperatively in rAF) */}
        {!webglError && (
          <div
            ref={rimLayerRef}
            className="ag-globe-rim-layer"
            aria-label="Off-screen active channels"
          >
            <button
              ref={rimLeftBtnRef}
              type="button"
              className="ag-globe-rim-pill is-left"
              style={{ visibility: 'hidden', opacity: 0, pointerEvents: 'none' }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                const targetKey = rimTargetKeyRef.current.left
                if (!targetKey) return
                flyToCellInternal(targetKey, { animate: true })
                emitSelectChannel(targetKey)
              }}
            >
              <span className="ag-globe-rim-arrow" aria-hidden="true">
                ←
              </span>
              <span ref={rimLeftDotRef} className="ag-globe-rim-dot is-hot" aria-hidden="true" />
              <span ref={rimLeftTagRef} className="ag-globe-rim-tag mono" />
              <span ref={rimLeftMetaRef} className="ag-globe-rim-meta mono" />
              <span
                ref={rimLeftMoreRef}
                className="ag-globe-rim-more mono"
                style={{ display: 'none' }}
              />
            </button>
            <button
              ref={rimRightBtnRef}
              type="button"
              className="ag-globe-rim-pill is-right"
              style={{ visibility: 'hidden', opacity: 0, pointerEvents: 'none' }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                const targetKey = rimTargetKeyRef.current.right
                if (!targetKey) return
                flyToCellInternal(targetKey, { animate: true })
                emitSelectChannel(targetKey)
              }}
            >
              <span ref={rimRightDotRef} className="ag-globe-rim-dot is-hot" aria-hidden="true" />
              <span ref={rimRightTagRef} className="ag-globe-rim-tag mono" />
              <span ref={rimRightMetaRef} className="ag-globe-rim-meta mono" />
              <span
                ref={rimRightMoreRef}
                className="ag-globe-rim-more mono"
                style={{ display: 'none' }}
              />
              <span className="ag-globe-rim-arrow" aria-hidden="true">
                →
              </span>
            </button>
          </div>
        )}

        {/* Compact Unobtrusive Attribution */}
        {!webglError && (
          <a
            href={`${import.meta.env.BASE_URL}solar-map-credits.html`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Planetary map sources, imagery credits and coverage"
            className="mono"
            style={{
              position: 'absolute',
              right: 8,
              bottom: 3,
              zIndex: 5,
              padding: '1px 5px',
              borderRadius: '4px',
              backgroundColor: 'color-mix(in srgb, var(--bg-surface) 70%, transparent)',
              color: 'var(--text-muted)',
              fontSize: 9,
              lineHeight: 1.3,
              opacity: 0.72,
              textDecoration: 'underline',
            }}
          >
            {activeBodyId === 'earth' ? '© Esri · OSM · Map credits' : `${focusedBodyDef.name} · Map credits`}
          </a>
        )}

        {/* Desktop Hover Coordinate / Pin / Solar Body / Topic Asteroid Readout */}
        {hoverHud && !webglError && (
          <div className="ag-radar-hover-hud mono" aria-hidden="true">
            <span className="ag-radar-hud-accent">
              {hoverHud.noHash ? hoverHud.geohash : `#${hoverHud.geohash}`}
            </span>
            <span className="ag-radar-hud-sep">·</span>
            <span>{hoverHud.coords}</span>
          </div>
        )}
      </div>
    )
  },
)

export default TacticalGeohashMap
