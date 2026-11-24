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
import { getTopicSlug, isTopicChannel, makeTopicChannelKey } from '../lib/bitchatChannel.ts'
import {
  computeSublunarPoint,
  computeSubsolarPoint,
  latLonToUnitVec3,
} from '../lib/astronomy.ts'
import {
  computeAsteroidWorldPosition,
  computeTopicAsteroidSpec,
  isPointOccludedByEarth,
  type TopicAsteroidSpec,
} from '../lib/asteroids.ts'

export type PrecisionSelection = 'auto' | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export interface TacticalGeohashMapHandle {
  zoomIn: () => void
  zoomOut: () => void
  flyToGeohash: (geohash: string, options?: { animate?: boolean; zoom?: number }) => void
  flyToTopic: (topicChannelKey: string, options?: { animate?: boolean }) => void
  flyToCoords: (lat: number, lon: number, zoom?: number) => void
  fitWorld: () => void
  fitAsteroids: () => void
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
  userCoords: GeoCoords | null
  isTeleported: boolean
  onSelectGeohash: (geohash: string) => void
  onTuneGeohash?: (geohash: string) => void
  onSelectChannel?: (channelKey: string) => void
  onTuneChannel?: (channelKey: string) => void
  onViewportInfoChange?: (info: { zoom: number; effectivePrecision: number }) => void
  className?: string
}

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI
const MAX_MERCATOR_LAT = 85.05112878

const MIN_VIRTUAL_ZOOM = -1.7 // distance ~ 15.8 at full solar-orbit pullback
const MAX_VIRTUAL_ZOOM = 15.5
const MAX_ALTITUDE = 3.6 // distance = 4.6 at zoom 1
const ALTITUDE_DECAY = 0.52325 // distance ~ 1.004 at zoom 14, ~ 1.0018 at zoom 15.5
const CAMERA_FOV_DEG = 42

const EARTH_RADIUS = 1.0
const PATCH_RADIUS = 1.00014
const OVERLAY_FILL_RADIUS = 1.00045
const OVERLAY_LINE_RADIUS = 1.00075
const FOCUS_LINE_RADIUS = 1.00105

const ESRI_TOPO_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'

const MAX_CACHED_PATCH_TILES = 64
const MAX_VISIBLE_PATCH_TILES = 12
const MAX_BUBBLES_PER_GEOHASH = 4
const BUBBLE_DEMOTE_LIFETIME_MS = 5_000
const BUBBLE_FADE_DURATION_MS = 380
const RECENT_BUBBLE_WINDOW_MS = 120_000
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
  return EARTH_RADIUS + MAX_ALTITUDE * Math.exp(-ALTITUDE_DECAY * (z - 1))
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
    return Math.max(0.0005, Math.asin(k) - halfFovRad)
  }
  return Math.acos(clamp(1 / Math.max(1.0001, distance), -1, 1))
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
    gl_Position = projectionMatrix * viewMatrix * worldPos;
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

    vec3 haloColor = mix(vec3(0.28, 0.62, 1.0), vec3(0.98, 0.58, 0.28), twilight * 0.35);
    float alpha = rim * sunSide * 0.62;
    gl_FragColor = vec4(haloColor * alpha, alpha);
  }
`

const MOON_VERTEX_SHADER = `
  varying vec2 vUv;
  varying vec3 vWorldNormal;

  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const MOON_FRAGMENT_SHADER = `
  uniform sampler2D uMap;
  uniform vec3 uSunDir;

  varying vec2 vUv;
  varying vec3 vWorldNormal;

  void main() {
    vec3 albedo = texture2D(uMap, vUv).rgb;
    vec3 N = normalize(vWorldNormal);
    vec3 L = normalize(uSunDir);
    float ndotl = dot(N, L);
    float lit = smoothstep(-0.08, 0.14, ndotl);
    float shade = mix(0.08, 1.32, lit);
    vec3 color = albedo * shade;
    color += vec3(0.04, 0.06, 0.10) * (1.0 - lit);
    gl_FragColor = vec4(color, 1.0);
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

function createLunarSurfaceTexture(): THREE.CanvasTexture {
  const w = 256
  const h = 128
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const rand = mulberry32(4201969)
    ctx.fillStyle = '#B7B5B0'
    ctx.fillRect(0, 0, w, h)

    for (let i = 0; i < 18; i++) {
      const mx = rand() * w
      const my = (0.18 + rand() * 0.64) * h
      const mr = 10 + rand() * 26
      const g = ctx.createRadialGradient(mx, my, mr * 0.15, mx, my, mr)
      g.addColorStop(0, 'rgba(92, 92, 96, 0.52)')
      g.addColorStop(0.7, 'rgba(110, 110, 114, 0.25)')
      g.addColorStop(1, 'rgba(110, 110, 114, 0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(mx, my, mr, 0, Math.PI * 2)
      ctx.fill()
    }

    for (let i = 0; i < 160; i++) {
      const cx = rand() * w
      const cy = rand() * h
      const r = 1.2 + Math.pow(rand(), 2.2) * 8.5
      ctx.fillStyle = `rgba(74, 74, 78, ${0.14 + rand() * 0.22})`
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.fill()

      ctx.strokeStyle = `rgba(222, 220, 214, ${0.16 + rand() * 0.18})`
      ctx.lineWidth = 0.8
      ctx.beginPath()
      ctx.arc(cx - r * 0.12, cy - r * 0.12, r * 0.94, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
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

    const r = 70 + rand() * 60
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
    positions[idx * 3] = px * 68
    positions[idx * 3 + 1] = py * 68
    positions[idx * 3 + 2] = pz * 68
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

function createMercatorPatchGeometry(z: number, tx: number, ty: number): THREE.BufferGeometry {
  const n = 1 << z
  const seg = z <= 4 ? 10 : z <= 6 ? 6 : 4
  const stride = seg + 1
  const vertexCount = stride * stride
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)

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
      positions[vi] = nx * PATCH_RADIUS
      positions[vi + 1] = ny * PATCH_RADIUS
      positions[vi + 2] = nz * PATCH_RADIUS
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
  return geometry
}

function pushCurvedRectSegments(
  out: number[],
  latMin: number,
  latMax: number,
  lonMin: number,
  lonMax: number,
  radius: number,
): void {
  const cLatMin = clamp(latMin, -85, 85)
  const cLatMax = clamp(latMax, -85, 85)
  const span = Math.max(Math.abs(cLatMax - cLatMin), Math.abs(lonMax - lonMin))
  const steps = span > 25 ? 8 : span > 8 ? 4 : span > 2 ? 2 : 1

  const pushArc = (la0: number, lo0: number, la1: number, lo1: number) => {
    let prev = latLonToUnitVec3(la0, lo0)
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const curr = latLonToUnitVec3(la0 + (la1 - la0) * t, lo0 + (lo1 - lo0) * t)
      out.push(
        prev[0] * radius,
        prev[1] * radius,
        prev[2] * radius,
        curr[0] * radius,
        curr[1] * radius,
        curr[2] * radius,
      )
      prev = curr
    }
  }

  pushArc(cLatMin, lonMin, cLatMin, lonMax)
  pushArc(cLatMin, lonMax, cLatMax, lonMax)
  pushArc(cLatMax, lonMax, cLatMax, lonMin)
  pushArc(cLatMax, lonMin, cLatMin, lonMin)
}

function buildCurvedRectFillGeometry(
  boxes: Array<{ latMin: number; latMax: number; lonMin: number; lonMax: number }>,
  radius: number,
): THREE.BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []
  let baseVertex = 0

  for (const box of boxes) {
    const latMin = clamp(box.latMin, -85, 85)
    const latMax = clamp(box.latMax, -85, 85)
    const span = Math.max(Math.abs(latMax - latMin), Math.abs(box.lonMax - box.lonMin))
    const seg = span > 25 ? 6 : span > 8 ? 3 : 1
    const stride = seg + 1

    for (let iv = 0; iv <= seg; iv++) {
      const lat = latMin + ((latMax - latMin) * iv) / seg
      for (let iu = 0; iu <= seg; iu++) {
        const lon = box.lonMin + ((box.lonMax - box.lonMin) * iu) / seg
        const [x, y, z] = latLonToUnitVec3(lat, lon)
        positions.push(x * radius, y * radius, z * radius)
      }
    }

    for (let iv = 0; iv < seg; iv++) {
      for (let iu = 0; iu < seg; iu++) {
        const i00 = baseVertex + iv * stride + iu
        const i10 = i00 + 1
        const i01 = i00 + stride
        const i11 = i01 + 1
        indices.push(i00, i10, i11, i00, i11, i01)
      }
    }
    baseVertex += stride * stride
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

function disposeObject3D(obj: THREE.Object3D | null): void {
  if (!obj) return
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.geometry) {
      mesh.geometry.dispose()
    }
    const mat = mesh.material
    if (Array.isArray(mat)) {
      for (const m of mat) m.dispose()
    } else if (mat) {
      mat.dispose()
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
  geohash: string // canonical channelKey ('9q8y' or 'topic:nostr')
  displayTag: string // '#9q8y' or '#nostr'
  isTopic: boolean
  center: GeoCoords
  bubbles: QueuedGlobeBubble[]
  latestTsMs: number
  isFocused: boolean
}

interface EarthPinRenderItem {
  geohash: string
  center: GeoCoords
  unreadCount: number
  mentionCount: number
  isActive: boolean
  isSelected: boolean
}

interface EarthPinRuntimeEntry {
  channelKey: string
  root: THREE.Group
  normal: THREE.Vector3
  headTipY: number
  hitMesh: THREE.Mesh
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
  hitMesh: THREE.Mesh
  orbitLine: THREE.LineLoop | null
  orbitMaterial: THREE.LineBasicMaterial | null
  spinAxis: THREE.Vector3
  orbitElapsedSec: number
  worldPos: THREE.Vector3
  isPinned: boolean
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
      userCoords,
      isTeleported,
      onSelectGeohash,
      onTuneGeohash,
      onSelectChannel,
      onTuneChannel,
      onViewportInfoChange,
      className = '',
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null)
    const canvasWrapRef = useRef<HTMLDivElement | null>(null)

    const [webglError, setWebglError] = useState(false)
    const [hoverHud, setHoverHud] = useState<{ geohash: string; coords: string } | null>(null)
    const [viewportTick, setViewportTick] = useState(0)
    const [bubbleStacks, setBubbleStacks] = useState<GlobeBubbleStackRender[]>([])

    const effectiveActiveKey = (activeChannelKey ?? activeGeohash ?? '').trim().toLowerCase()
    const effectiveSelectedKey =
      (selectedChannelKey !== undefined ? selectedChannelKey : selectedGeohash)
        ?.trim()
        .toLowerCase() || null

    const safeActiveGeohash =
      activeGeohash && !isTopicChannel(activeGeohash) && isValidGeohash(activeGeohash)
        ? normalizeGeohash(activeGeohash)
        : '9q8y'
    const safeSelectedGeohash =
      selectedGeohash && !isTopicChannel(selectedGeohash) && isValidGeohash(selectedGeohash)
        ? normalizeGeohash(selectedGeohash)
        : effectiveSelectedKey &&
            !isTopicChannel(effectiveSelectedKey) &&
            isValidGeohash(effectiveSelectedKey)
          ? normalizeGeohash(effectiveSelectedKey)
          : null

    // Keep fresh callbacks & reactive props in refs for rAF & Three.js event listeners
    const onSelectRef = useRef(onSelectGeohash)
    const onTuneRef = useRef(onTuneGeohash)
    const onSelectChannelRef = useRef(onSelectChannel)
    const onTuneChannelRef = useRef(onTuneChannel)
    const onViewportInfoRef = useRef(onViewportInfoChange)
    const precisionModeRef = useRef(precisionMode)
    const modeRef = useRef(mode)
    const themeRef = useRef(theme)
    const prevActiveRef = useRef(safeActiveGeohash)
    const activeGeohashRef = useRef(safeActiveGeohash)
    const selectedGeohashRef = useRef(safeSelectedGeohash)
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
      precisionModeRef.current = precisionMode
      modeRef.current = mode
      themeRef.current = theme
      activeGeohashRef.current = safeActiveGeohash
      selectedGeohashRef.current = safeSelectedGeohash
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
      precisionMode,
      mode,
      theme,
      safeActiveGeohash,
      safeSelectedGeohash,
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
      } else if (!isTopicChannel(channelKey) && isValidGeohash(channelKey)) {
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

    // Initial wide camera framing in expanded mode so Earth, push-pins, & orbiting asteroids are immediately visible
    const initialCamCenter = decodeCenter(safeActiveGeohash)
    const initialCamZoom = clamp(
      mode === 'compact'
        ? Math.max(2, getZoomForPrecision(safeActiveGeohash.length) - 1)
        : Math.min(getZoomForPrecision(safeActiveGeohash.length), 2.15),
      MIN_VIRTUAL_ZOOM,
      MAX_VIRTUAL_ZOOM,
    )
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
    })

    const sceneRefs = useRef<{
      scene: THREE.Scene
      camera: THREE.PerspectiveCamera
      renderer: THREE.WebGLRenderer
      earthMesh: THREE.Mesh
      earthMaterial: THREE.ShaderMaterial
      baseCanvas: HTMLCanvasElement
      baseTexture: THREE.CanvasTexture
      sunDir: THREE.Vector3
      sunGroup: THREE.Group
      moonMesh: THREE.Mesh
      moonMaterial: THREE.ShaderMaterial
      atmosphereMaterial: THREE.ShaderMaterial
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
      tileKind: 'dark' | 'light'
      baseLoadGen: number
      hoveredGeohash: string | null
      hoveredAsteroidKey: string | null
      orbitClockSec: number
      scheduleViewportEmit: () => void
      reloadBaseTiles: (kind: 'dark' | 'light') => void
      updatePatchTiles: () => void
      updateHoverMesh: (gh: string | null) => void
    } | null>(null)

    // Runtime 3D maps for pins & orbiting asteroids (mutated in-place inside rAF)
    const pinEntriesRef = useRef<Map<string, EarthPinRuntimeEntry>>(new Map())
    const asteroidEntriesRef = useRef<Map<string, AsteroidRuntimeEntry>>(new Map())

    // Projected DOM overlay refs (updated directly in rAF for zero-re-render 60fps positioning)
    const bubbleStackElsRef = useRef<Map<string, HTMLDivElement>>(new Map())
    const beaconElsRef = useRef<Map<string, HTMLButtonElement>>(new Map())
    const pinChipElsRef = useRef<Map<string, HTMLButtonElement>>(new Map())
    const asteroidChipElsRef = useRef<Map<string, HTMLButtonElement>>(new Map())
    const activePillElRef = useRef<HTMLDivElement | null>(null)
    const selectedPillElRef = useRef<HTMLDivElement | null>(null)
    const gpsBeaconElRef = useRef<HTMLDivElement | null>(null)
    const bubbleStacksRef = useRef<GlobeBubbleStackRender[]>([])
    const visiblePulseRoomsRef = useRef<PulseRoom[]>([])

    // Per-channel queue state for upward-sliding speech bubbles (Earth geohashes + Topic asteroids)
    const bubbleQueuesRef = useRef<Map<string, QueuedGlobeBubble[]>>(new Map())
    const evictedBubbleKeysRef = useRef<Map<string, Set<string>>>(new Map())
    const seededRoomsRef = useRef<Set<string>>(new Set())

    const validPulseRooms = useMemo(
      () =>
        showPulse
          ? pulseRooms
              .filter((r) => !isTopicChannel(r.geohash) && isValidGeohash(r.geohash))
              .slice(0, mode === 'compact' ? 24 : 48)
          : [],
      [showPulse, pulseRooms, mode],
    )

    const validTopicRooms = useMemo(() => {
      if (!showPulse) return []
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
    }, [showPulse, topicRooms, pulseRooms])

    const pinnedEarthItems = useMemo<EarthPinRenderItem[]>(() => {
      if (!pinnedChannels || pinnedChannels.length === 0) return []
      const seen = new Set<string>()
      const out: EarthPinRenderItem[] = []
      for (const pin of pinnedChannels) {
        if (isTopicChannel(pin.geohash) || !isValidGeohash(pin.geohash)) continue
        const gh = normalizeGeohash(pin.geohash)
        if (seen.has(gh)) continue
        seen.add(gh)
        out.push({
          geohash: gh,
          center: decodeCenter(gh),
          unreadCount: pin.unreadCount || 0,
          mentionCount: pin.mentionCount || 0,
          isActive: gh === effectiveActiveKey,
          isSelected: gh === effectiveSelectedKey,
        })
      }
      return out
    }, [pinnedChannels, effectiveActiveKey, effectiveSelectedKey])

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

    useEffect(() => {
      visiblePulseRoomsRef.current = validPulseRooms
    }, [validPulseRooms])

    useEffect(() => {
      bubbleStacksRef.current = bubbleStacks
    }, [bubbleStacks])

    const subZoneParent = useMemo(() => {
      if (!showSubZones) return null
      const candidate = safeSelectedGeohash || safeActiveGeohash
      return candidate && candidate.length < 8 ? candidate : null
    }, [showSubZones, safeSelectedGeohash, safeActiveGeohash])

    const allBubbleSourceRooms = useMemo(
      () => [...validPulseRooms, ...validTopicRooms],
      [validPulseRooms, validTopicRooms],
    )
    const allBubbleSourceRoomsRef = useRef<PulseRoom[]>(allBubbleSourceRooms)
    useEffect(() => {
      allBubbleSourceRoomsRef.current = allBubbleSourceRooms
    }, [allBubbleSourceRooms])

    const buildRenderStacks = useCallback(
      (rooms: PulseRoom[]): GlobeBubbleStackRender[] => {
        const roomByKey = new Map<string, PulseRoom>()
        for (const r of rooms) roomByKey.set(r.geohash, r)

        const out: GlobeBubbleStackRender[] = []
        const queues = bubbleQueuesRef.current
        for (const [key, list] of queues.entries()) {
          if (list.length === 0) continue
          const room = roomByKey.get(key)
          if (!room) continue
          const isTopic = isTopicChannel(key)
          if (!isTopic && subZoneParent === key) continue
          const latest = list[list.length - 1]
          const isFocused = key === effectiveActiveKey || key === effectiveSelectedKey
          const slug = isTopic ? getTopicSlug(key) : null
          out.push({
            geohash: key,
            displayTag: slug ? `#${slug}` : `#${key}`,
            isTopic,
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

      setBubbleStacks(buildRenderStacks(allBubbleSourceRooms))
    }, [showPulse, showBubbles, allBubbleSourceRooms, buildRenderStacks])

    // 5s post-demotion fadeout & eviction ticker
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

    const flyToCellInternal = useCallback(
      (geohash: string, options?: { animate?: boolean; zoom?: number }) => {
        if (!geohash || isTopicChannel(geohash) || !isValidGeohash(geohash)) return
        const center = decodeCenter(geohash)
        const rawZoom =
          options?.zoom ??
          (modeRef.current === 'compact'
            ? Math.max(2, getZoomForPrecision(geohash.length) - 1)
            : Math.min(MAX_VIRTUAL_ZOOM, getZoomForPrecision(geohash.length)))
        startFlyTo(center.lat, center.lon, rawZoom, options?.animate !== false)
      },
      [startFlyTo],
    )

    const flyToTopicInternal = useCallback(
      (topicChannelKey: string, options?: { animate?: boolean }) => {
        const canonical = makeTopicChannelKey(topicChannelKey)
        if (!canonical) return
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
          cam.targetZoom = clamp(cam.targetZoom + 1.15, MIN_VIRTUAL_ZOOM, MAX_VIRTUAL_ZOOM)
          cam.isFlying = true
          cam.targetLat = cam.lat
          cam.targetLon = cam.lon
        },
        zoomOut() {
          const cam = cameraStateRef.current
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
          const cam = cameraStateRef.current
          startFlyTo(16, wrapLongitude(cam.lon), 0.25, true)
        },
        getZoom() {
          return cameraStateRef.current.zoom
        },
      }),
      [flyToCellInternal, flyToTopicInternal, startFlyTo],
    )

    // -----------------------------------------------------------------------
    // 1. Mount Three.js 3D Earth Globe, Solar System Skybox, Controls & rAF
    // -----------------------------------------------------------------------
    useEffect(() => {
      const wrap = canvasWrapRef.current
      if (!wrap) return

      let renderer: THREE.WebGLRenderer
      try {
        renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: false,
          powerPreference: 'high-performance',
        })
      } catch {
        setWebglError(true)
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

      const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, initW / initH, 0.01, 240)
      camera.up.set(0, 1, 0)

      // Live Astronomical Positions (Sun & Real Moon — 100% pure, untouched)
      const sunDir = new THREE.Vector3(1, 0.25, 0.2).normalize()
      const initSun = computeSubsolarPoint(new Date())
      sunDir.set(...latLonToUnitVec3(initSun.lat, initSun.lon)).normalize()

      const starfield = createStarfieldPoints(dpr)
      scene.add(starfield.points)

      const sunGroup = new THREE.Group()
      const sunCoreGeo = new THREE.SphereGeometry(0.88, 24, 16)
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
      sunCoronaSprite.scale.set(8.6, 8.6, 1)
      sunGroup.add(sunCoronaSprite)
      sunGroup.position.copy(sunDir).multiplyScalar(38)
      scene.add(sunGroup)

      // Pure Real-Time Sun-Lit Moon (zero topic markers on Moon)
      const moonTex = createLunarSurfaceTexture()
      const moonGeo = new THREE.SphereGeometry(0.145, 32, 24)
      const moonMaterial = new THREE.ShaderMaterial({
        vertexShader: MOON_VERTEX_SHADER,
        fragmentShader: MOON_FRAGMENT_SHADER,
        uniforms: {
          uMap: { value: moonTex },
          uSunDir: { value: sunDir.clone() },
        },
      })
      const moonMesh = new THREE.Mesh(moonGeo, moonMaterial)
      const initMoon = computeSublunarPoint(new Date())
      moonMesh.position.set(...latLonToUnitVec3(initMoon.lat, initMoon.lon)).multiplyScalar(4.2)
      scene.add(moonMesh)

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

      const earthGeo = new THREE.SphereGeometry(EARTH_RADIUS, 72, 48)
      const earthMaterial = new THREE.ShaderMaterial({
        vertexShader: EARTH_VERTEX_SHADER,
        fragmentShader: EARTH_FRAGMENT_SHADER,
        uniforms: {
          uMap: { value: baseTexture },
          uSunDir: { value: sunDir.clone() },
          uIsLight: { value: initialTileKind === 'light' ? 1.0 : 0.0 },
          uOpacity: { value: 1.0 },
        },
      })
      const earthMesh = new THREE.Mesh(earthGeo, earthMaterial)
      earthMesh.renderOrder = 1
      scene.add(earthMesh)

      // Outer Atmosphere Shell
      const atmosphereGeo = new THREE.SphereGeometry(1.032, 48, 32)
      const atmosphereMaterial = new THREE.ShaderMaterial({
        vertexShader: ATMOSPHERE_VERTEX_SHADER,
        fragmentShader: ATMOSPHERE_FRAGMENT_SHADER,
        uniforms: {
          uSunDir: { value: sunDir.clone() },
        },
        side: THREE.BackSide,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const atmosphereMesh = new THREE.Mesh(atmosphereGeo, atmosphereMaterial)
      atmosphereMesh.renderOrder = 3
      scene.add(atmosphereMesh)

      // Layered Scene Groups (Earth overlays + 3D Push-Pins + Orbiting Topic Asteroid Belt)
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
      const pinEntries = pinEntriesRef.current
      const asteroidEntries = asteroidEntriesRef.current
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
              compositeMercatorTileOntoEquirect(ctx, img, z, tx, ty, baseCanvas.width, baseCanvas.height)
              baseTexture.needsUpdate = true
            }
            img.src = tileUrl(ESRI_TOPO_URL, z, tx, ty)
          }
        }
      }

      const updatePatchTiles = () => {
        if (isDisposed) return
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
        const latSpanDeg = Math.max(0.01, 2 * halfAngRad * RAD2DEG)
        const cosLat = Math.max(0.2, Math.cos(cam.lat * DEG2RAD))
        const tileZ = clamp(
          Math.round(Math.log2((360 * cosLat) / Math.max(0.008, latSpanDeg * 0.72))),
          3,
          12,
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

            const geometry = createMercatorPatchGeometry(tileZ, tx, ty)
            const material = new THREE.ShaderMaterial({
              vertexShader: EARTH_VERTEX_SHADER,
              fragmentShader: EARTH_FRAGMENT_SHADER,
              uniforms: {
                uMap: { value: texture },
                uSunDir: { value: sunDir.clone() },
                uIsLight: { value: isLight ? 1.0 : 0.0 },
                uOpacity: { value: 1.0 },
              },
              polygonOffset: true,
              polygonOffsetFactor: -1,
              polygonOffsetUnits: -1,
            })

            const mesh = new THREE.Mesh(geometry, material)
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
              if (
                lastPatchKeySig.includes(`${tx},${ty}`) &&
                lastPatchKeySig.startsWith(`topo:${tileZ}:`)
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
        const pal = readCanvasPalette(hostRef.current, themeRef.current)
        const color = new THREE.Color(pal.accent)

        const fillGeo = buildCurvedRectFillGeometry([b], OVERLAY_FILL_RADIUS)
        const fillMat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: pal.isLight ? 0.14 : 0.12,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        })
        const fillMesh = new THREE.Mesh(fillGeo, fillMat)
        fillMesh.renderOrder = 4
        hoverGroup.add(fillMesh)

        const segs: number[] = []
        pushCurvedRectSegments(segs, b.latMin, b.latMax, b.lonMin, b.lonMax, FOCUS_LINE_RADIUS)
        const lineGeo = new THREE.BufferGeometry()
        lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
        const lineMat = new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0.72,
          depthWrite: false,
        })
        const line = new THREE.LineSegments(lineGeo, lineMat)
        line.renderOrder = 6
        hoverGroup.add(line)
      }

      sceneRefs.current = {
        scene,
        camera,
        renderer,
        earthMesh,
        earthMaterial,
        baseCanvas,
        baseTexture,
        sunDir,
        sunGroup,
        moonMesh,
        moonMaterial,
        atmosphereMaterial,
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
        tileKind: initialTileKind,
        baseLoadGen,
        hoveredGeohash: null,
        hoveredAsteroidKey: null,
        orbitClockSec: 0,
        scheduleViewportEmit,
        reloadBaseTiles,
        updatePatchTiles,
        updateHoverMesh,
      }

      reloadBaseTiles(initialTileKind)

      // Refresh live Sun & Moon astronomical positions every 30s (+ sync uSunDir on asteroids & pins)
      const syncCelestialBodies = () => {
        const now = new Date()
        const sun = computeSubsolarPoint(now)
        const moon = computeSublunarPoint(now)
        sunDir.set(...latLonToUnitVec3(sun.lat, sun.lon)).normalize()
        sunGroup.position.copy(sunDir).multiplyScalar(38)
        earthMaterial.uniforms.uSunDir.value.copy(sunDir)
        atmosphereMaterial.uniforms.uSunDir.value.copy(sunDir)
        moonMaterial.uniforms.uSunDir.value.copy(sunDir)
        moonMesh.position.set(...latLonToUnitVec3(moon.lat, moon.lon)).multiplyScalar(4.2)
        for (const entry of patchCache.values()) {
          entry.material.uniforms.uSunDir.value.copy(sunDir)
        }
        for (const entry of asteroidEntries.values()) {
          entry.rockMaterial.uniforms.uSunDir.value.copy(sunDir)
        }
        pinGroup.traverse((child) => {
          const m = (child as THREE.Mesh).material as THREE.ShaderMaterial | undefined
          if (m && m.uniforms?.uSunDir) {
            m.uniforms.uSunDir.value.copy(sunDir)
          }
        })
      }
      const sunTimer = window.setInterval(syncCelestialBodies, SUN_REFRESH_INTERVAL_MS)

      // ---------------------------------------------------------------------
      // Pointer, Touch Pinch-Zoom, Wheel Zoom & Priority Raycast Controller
      // Priority: 1) 3D Asteroids  2) 3D Earth Push-Pins  3) Earth Surface
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
        | { kind: 'pin'; channelKey: string }
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

        // 1. 3D Topic Asteroids (filter out asteroids hidden behind Earth's limb)
        if (asteroidEntries.size > 0) {
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

        // 2. 3D Earth Push-Pins (only front-facing hemisphere)
        if (pinEntries.size > 0) {
          const camDirNorm = camera.position.clone().normalize()
          const pinTargets: THREE.Object3D[] = []
          for (const entry of pinEntries.values()) {
            if (entry.normal.dot(camDirNorm) >= 0.1) {
              pinTargets.push(entry.hitMesh)
            }
          }
          if (pinTargets.length > 0) {
            const hits = raycaster.intersectObjects(pinTargets, false)
            if (hits.length > 0) {
              const ud = hits[0].object.userData as { channelKey?: string }
              if (ud.channelKey) {
                return { kind: 'pin', channelKey: ud.channelKey }
              }
            }
          }
        }

        // 3. Earth Globe Surface
        const earthHits = raycaster.intersectObject(earthMesh, false)
        if (earthHits.length > 0) {
          const { lat, lon } = unitVec3ToLatLon(earthHits[0].point)
          return { kind: 'earth', lat, lon }
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

          if (lastPinchDist > 8 && dist > 8) {
            const scaleRatio = dist / lastPinchDist
            const zoomDelta = Math.log(scaleRatio) / ALTITUDE_DECAY
            cam.zoom = clamp(cam.zoom + zoomDelta, MIN_VIRTUAL_ZOOM, MAX_VIRTUAL_ZOOM)
            cam.targetZoom = cam.zoom
          }

          const dpp = degPerPixel()
          const dx = midX - lastPinchMidX
          const dy = midY - lastPinchMidY
          const cosLat = Math.max(0.24, Math.cos(cam.lat * DEG2RAD))
          cam.lat = clamp(cam.lat + dy * dpp, -82, 82)
          cam.lon -= (dx * dpp) / cosLat
          cam.targetLat = cam.lat
          cam.targetLon = cam.lon

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

        // Desktop hover readout + curved hover highlight / asteroid highlight
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
            canvas.style.cursor = 'pointer'
            setHoverHud({ geohash: hit.slug, coords: 'Topic Asteroid' })
            return
          }

          sr.hoveredAsteroidKey = null

          if (hit.kind === 'pin') {
            if (sr.hoveredGeohash !== hit.channelKey) {
              sr.hoveredGeohash = hit.channelKey
              updateHoverMesh(hit.channelKey)
            }
            canvas.style.cursor = 'pointer'
            setHoverHud({ geohash: hit.channelKey, coords: 'Pinned' })
            return
          }

          canvas.style.cursor = ''
          const p =
            precisionModeRef.current === 'auto'
              ? getRecommendedPrecisionForZoom(cam.zoom)
              : precisionModeRef.current
          const gh = encodeGeohash(hit.lat, hit.lon, p)
          if (sr.hoveredGeohash !== gh) {
            sr.hoveredGeohash = gh
            updateHoverMesh(gh)
          }
          setHoverHud({
            geohash: gh,
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
                    : encodeGeohash(
                        hit.lat,
                        hit.lon,
                        precisionModeRef.current === 'auto'
                          ? getRecommendedPrecisionForZoom(cam.zoom)
                          : precisionModeRef.current,
                      )

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
        const hit = raycastScene(e.clientX, e.clientY)
        if (!hit) return
        if (hit.kind === 'asteroid' || hit.kind === 'pin') {
          emitTuneChannel(hit.channelKey)
          return
        }
        const cam = cameraStateRef.current
        const p =
          precisionModeRef.current === 'auto'
            ? getRecommendedPrecisionForZoom(cam.zoom)
            : precisionModeRef.current
        const gh = encodeGeohash(hit.lat, hit.lon, p)
        emitTuneChannel(gh)
      }

      const onPointerLeave = () => {
        if (sceneRefs.current) {
          if (sceneRefs.current.hoveredGeohash !== null) {
            sceneRefs.current.hoveredGeohash = null
            updateHoverMesh(null)
          }
          sceneRefs.current.hoveredAsteroidKey = null
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
        cam.targetZoom = clamp(
          (cam.isFlying ? cam.targetZoom : cam.zoom) + zoomStep,
          MIN_VIRTUAL_ZOOM,
          MAX_VIRTUAL_ZOOM,
        )
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
        setWebglError(true)
      }

      canvas.addEventListener('pointerdown', onPointerDown)
      canvas.addEventListener('pointermove', onPointerMove)
      canvas.addEventListener('pointerup', finishPointer)
      canvas.addEventListener('pointercancel', finishPointer)
      canvas.addEventListener('pointerleave', onPointerLeave)
      canvas.addEventListener('dblclick', onDoubleClick)
      canvas.addEventListener('wheel', onWheel, { passive: false })
      canvas.addEventListener('gesturestart', preventGesture, { passive: false })
      canvas.addEventListener('gesturechange', preventGesture, { passive: false })
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
        renderer.setSize(nextW, nextH, false)
        scheduleViewportEmit()
      })
      ro.observe(wrap)

      // ---------------------------------------------------------------------
      // Main 60fps rAF Loop: Camera + Pin Scaling + Orbiting Asteroids + Projection
      // ---------------------------------------------------------------------
      const tmpVec = new THREE.Vector3()
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
      ): { x: number; y: number; visible: boolean } => {
        const [ux, uy, uz] = latLonToUnitVec3(lat, lon)
        const facing = ux * camDir.x + uy * camDir.y + uz * camDir.z
        if (facing < 0.14) {
          return { x: 0, y: 0, visible: false }
        }
        tmpVec.set(ux * FOCUS_LINE_RADIUS, uy * FOCUS_LINE_RADIUS, uz * FOCUS_LINE_RADIUS)
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
        if (el.dataset.vis !== '1') {
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
          const alpha = 1 - Math.exp(-dt * 8.5)
          const dLat = cam.targetLat - cam.lat
          const dLon = cam.targetLon - cam.lon
          const dZoom = cam.targetZoom - cam.zoom

          if (Math.abs(dLat) < 0.002 && Math.abs(dLon) < 0.002 && Math.abs(dZoom) < 0.003) {
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
        const nextNear = clamp((dist - EARTH_RADIUS) * 0.16, 0.0003, 0.08)
        if (Math.abs(camera.near - nextNear) > 0.0001) {
          camera.near = nextNear
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

        // Dynamically scale Earth 3D Push-Pins proportionally to altitude
        const pinScale = clamp((dist - EARTH_RADIUS) * 0.044, 0.0024, 0.095)
        for (const entry of pinEntries.values()) {
          entry.root.scale.setScalar(pinScale)
        }

        // Advance gentle orbital drift & rocky tumble for every 3D Topic Asteroid
        const hoveredAst = sr?.hoveredAsteroidKey ?? null
        const activeKey = activeChannelKeyRef.current
        const selectedKey = selectedChannelKeyRef.current
        for (const entry of asteroidEntries.values()) {
          const isSteady =
            entry.channelKey === hoveredAst || entry.channelKey === selectedKey
          if (!isSteady) {
            entry.orbitElapsedSec += dt
          }
          const [ax, ay, az] = computeAsteroidWorldPosition(entry.spec, entry.orbitElapsedSec)
          entry.worldPos.set(ax, ay, az)
          entry.root.position.set(ax, ay, az)
          entry.rockMesh.rotateOnAxis(entry.spinAxis, entry.spec.spinSpeed * dt)

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

        if (nowMs - lastPatchCheckMs > 160 || cameraMoved) {
          if (nowMs - lastPatchCheckMs > 160) {
            lastPatchCheckMs = nowMs
            updatePatchTiles()
          }
        }

        renderer.render(scene, camera)

        // Project 3D anchors -> 2D screen coordinates for DOM overlays
        const viewW = lastW
        const viewH = lastH
        const isCompact = modeRef.current === 'compact'
        const isNarrow = viewW < 640

        // 1. Active & Selected Geohash Pill Badges (suppressed if a Pinned Push-Pin chip owns that exact geohash)
        const subParent = showSubZonesRef.current
          ? selectedGeohashRef.current || activeGeohashRef.current
          : null
        const activeSubParent = subParent && subParent.length < 8 ? subParent : null

        const activeEl = activePillElRef.current
        if (activeEl) {
          const gh = activeGeohashRef.current
          const isTopicActive = isTopicChannel(activeChannelKeyRef.current)
          const hasPinHere = pinEntries.has(gh)
          if (gh && !isTopicActive && !hasPinHere && activeSubParent !== gh) {
            const c = decodeCenter(gh)
            const p = projectPointToScreen(c.lat, c.lon, viewW, viewH)
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
          const hasPinHere = gh ? pinEntries.has(gh) : false
          if (
            gh &&
            !isTopicSelected &&
            !hasPinHere &&
            gh !== activeGeohashRef.current &&
            activeSubParent !== gh
          ) {
            const c = decodeCenter(gh)
            const p = projectPointToScreen(c.lat, c.lon, viewW, viewH)
            if (p.visible) showElAt(selEl, p.x, p.y)
            else hideEl(selEl)
          } else {
            hideEl(selEl)
          }
        }

        // 2. User GPS Beacon
        const gpsEl = gpsBeaconElRef.current
        if (gpsEl) {
          const coords = userCoordsRef.current
          if (coords) {
            const p = projectPointToScreen(coords.lat, coords.lon, viewW, viewH)
            if (p.visible) showElAt(gpsEl, p.x, p.y)
            else hideEl(gpsEl)
          } else {
            hideEl(gpsEl)
          }
        }

        // 3. Projected Earth 3D Push-Pin Chips (anchored cleanly right above each 3D pinhead tip)
        const tipVec = new THREE.Vector3()
        for (const [gh, entry] of pinEntries.entries()) {
          const chipEl = pinChipElsRef.current.get(gh)
          if (!chipEl) continue
          if (entry.normal.dot(camDir) < 0.14 || activeSubParent === gh) {
            hideEl(chipEl)
            continue
          }
          tipVec
            .copy(entry.normal)
            .multiplyScalar(EARTH_RADIUS + 0.0008 + entry.headTipY * pinScale)
          const p = projectWorldVecToScreen(tipVec, viewW, viewH)
          if (!p.visible) {
            hideEl(chipEl)
            continue
          }
          showElAt(chipEl, p.x, p.y - 6, 'bottom-center')
        }

        // 4. Projected Topic Asteroid Chips (occluded cleanly only when behind Earth's limb)
        const visibleAsteroidScreen = new Map<string, { x: number; y: number }>()
        for (const [key, entry] of asteroidEntries.entries()) {
          const chipEl = asteroidChipElsRef.current.get(key)
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
            // Keep chips clean in narrow viewports by hiding distant unpinned/non-selected starter rocks if zoomed deep onto Earth
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

        // 5. Upward-Queued Speech Bubble Stacks (Earth Rooms AND Orbiting Topic Asteroids!)
        const placedBubbleBoxes: Array<{ l: number; r: number; t: number; b: number }> = []
        const visibleBubbleKeys = new Set<string>()
        const maxStacks = isCompact ? 3 : isNarrow ? 5 : 10
        const stackW = isNarrow ? 142 : 162
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

          let p: { x: number; y: number; visible: boolean }
          if (stack.isTopic) {
            const astPt = visibleAsteroidScreen.get(stack.geohash)
            p = astPt ? { x: astPt.x, y: astPt.y, visible: true } : { x: 0, y: 0, visible: false }
          } else {
            p = projectPointToScreen(stack.center.lat, stack.center.lon, viewW, viewH)
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

        // 6. Live Pulse Surface Sonar Beacons (Earth rooms without a 3D push-pin)
        const rooms = visiblePulseRoomsRef.current
        for (const room of rooms) {
          const el = beaconElsRef.current.get(room.geohash)
          if (!el) continue
          if (
            !showPulseRef.current ||
            activeSubParent === room.geohash ||
            pinEntries.has(room.geohash)
          ) {
            hideEl(el)
            continue
          }
          const p = projectPointToScreen(room.center.lat, room.center.lon, viewW, viewH)
          if (!p.visible) {
            hideEl(el)
            continue
          }
          showElAt(el, p.x, p.y)
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
        canvas.removeEventListener('wheel', onWheel)
        canvas.removeEventListener('gesturestart', preventGesture)
        canvas.removeEventListener('gesturechange', preventGesture)
        canvas.removeEventListener('webglcontextlost', onContextLost)

        starfield.geometry.dispose()
        starfield.material.dispose()
        sunCoreGeo.dispose()
        sunCoreMat.dispose()
        sunCoronaTex.dispose()
        sunCoronaMat.dispose()
        moonGeo.dispose()
        moonTex.dispose()
        moonMaterial.dispose()
        earthGeo.dispose()
        earthMaterial.dispose()
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
    }, [emitSelectChannel, emitTuneChannel, flyToTopicInternal])

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
    // 3. Smoothly Fly Globe Whenever activeGeohash Changes Externally
    // -----------------------------------------------------------------------
    useEffect(() => {
      if (prevActiveRef.current === safeActiveGeohash) return
      prevActiveRef.current = safeActiveGeohash
      if (isTopicChannel(effectiveActiveKey)) return
      flyToCellInternal(safeActiveGeohash, { animate: true })
    }, [safeActiveGeohash, effectiveActiveKey, flyToCellInternal])

    // -----------------------------------------------------------------------
    // 4. Emit Effective Precision Whenever precisionMode Changes
    // -----------------------------------------------------------------------
    useEffect(() => {
      const z = cameraStateRef.current.zoom
      const p = precisionMode === 'auto' ? getRecommendedPrecisionForZoom(z) : precisionMode
      onViewportInfoRef.current?.({ zoom: z, effectivePrecision: p })
    }, [precisionMode])

    // -----------------------------------------------------------------------
    // 5. Render Curved Geohash Grid Lines on the Sphere Surface
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

      const focusSet = new Set<string>([safeActiveGeohash])
      if (safeSelectedGeohash) focusSet.add(safeSelectedGeohash)

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
      lines.renderOrder = 4
      group.add(lines)
    }, [viewportTick, precisionMode, safeActiveGeohash, safeSelectedGeohash, mode, theme])

    // -----------------------------------------------------------------------
    // 6. Render Optional 32× Child Sub-Zones Curved on the Sphere
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

      const pal = readCanvasPalette(hostRef.current, theme)
      const color = new THREE.Color(pal.accentSecondary)

      const fillGeo = buildCurvedRectFillGeometry(
        children.map((c) => c.bounds),
        OVERLAY_FILL_RADIUS,
      )
      const fillMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.06,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      })
      const fillMesh = new THREE.Mesh(fillGeo, fillMat)
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
      lines.renderOrder = 5
      group.add(lines)
    }, [subZoneParent, theme])

    // -----------------------------------------------------------------------
    // 7. Render Live Global Pulse Zone Highlights on the Sphere Surface
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
      const boxes = validPulseRooms.map((r) => decodeBounds(r.geohash))

      const fillGeo = buildCurvedRectFillGeometry(boxes, OVERLAY_FILL_RADIUS)
      const fillMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.11,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      })
      const fillMesh = new THREE.Mesh(fillGeo, fillMat)
      fillMesh.renderOrder = 4
      group.add(fillMesh)

      const segs: number[] = []
      for (const b of boxes) {
        pushCurvedRectSegments(segs, b.latMin, b.latMax, b.lonMin, b.lonMax, OVERLAY_LINE_RADIUS)
      }
      const lineGeo = new THREE.BufferGeometry()
      lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
      const lineMat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.56,
        depthWrite: false,
      })
      const lines = new THREE.LineSegments(lineGeo, lineMat)
      lines.renderOrder = 5
      group.add(lines)
    }, [showPulse, validPulseRooms, theme])

    // -----------------------------------------------------------------------
    // 8. Render Active Tuned & Selected Geohash Curved Polygon Fill & Borders
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
        const col = new THREE.Color(hexColor)

        const fillGeo = buildCurvedRectFillGeometry([b], OVERLAY_FILL_RADIUS)
        const fillMat = new THREE.MeshBasicMaterial({
          color: col,
          transparent: true,
          opacity: fillOpacity,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -3,
          polygonOffsetUnits: -3,
        })
        const fillMesh = new THREE.Mesh(fillGeo, fillMat)
        fillMesh.renderOrder = 5
        group.add(fillMesh)

        const segs: number[] = []
        pushCurvedRectSegments(segs, b.latMin, b.latMax, b.lonMin, b.lonMax, FOCUS_LINE_RADIUS)
        const lineGeo = new THREE.BufferGeometry()
        lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
        const lineMat = new THREE.LineBasicMaterial({
          color: col,
          transparent: true,
          opacity: 0.94,
          depthWrite: false,
        })
        const lines = new THREE.LineSegments(lineGeo, lineMat)
        lines.renderOrder = 7
        group.add(lines)
      }

      if (safeActiveGeohash && !isTopicChannel(effectiveActiveKey)) {
        addFocusCell(safeActiveGeohash, pal.accent, 0.16)
      }
      if (
        safeSelectedGeohash &&
        safeSelectedGeohash !== safeActiveGeohash &&
        !(effectiveSelectedKey && isTopicChannel(effectiveSelectedKey))
      ) {
        addFocusCell(safeSelectedGeohash, pal.accentSecondary, 0.15)
      }
    }, [safeActiveGeohash, safeSelectedGeohash, effectiveActiveKey, effectiveSelectedKey, theme])

    // -----------------------------------------------------------------------
    // 9. Render Orbital Great-Circle Teleport Vector Arc When Teleported
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
      if (!userCoords || !isTeleported || !safeActiveGeohash || isTopicChannel(effectiveActiveKey)) {
        return
      }

      const activeCenter = decodeCenter(safeActiveGeohash)
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
    }, [userCoords, isTeleported, safeActiveGeohash, effectiveActiveKey, theme])

    // -----------------------------------------------------------------------
    // 10. Build Physical Sculpted 3D Earth Push-Pins for Pinned Geohashes
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

      const pal = readCanvasPalette(hostRef.current, theme)
      const dist = zoomToDistance(cameraStateRef.current.zoom)
      const initPinScale = clamp((dist - EARTH_RADIUS) * 0.044, 0.0024, 0.095)

      for (const item of pinnedEarthItems) {
        const normal = latLonToVec3(item.center.lat, item.center.lon, 1).normalize()
        const root = new THREE.Group()
        root.position.copy(normal).multiplyScalar(EARTH_RADIUS + 0.0008)
        root.quaternion.setFromUnitVectors(UP_Y, normal)
        root.scale.setScalar(initPinScale)

        const headHex = item.isActive || item.isSelected ? pal.accent : '#EF4444'
        const hasUnread = item.unreadCount > 0 || item.mentionCount > 0
        const ud = { channelKey: item.geohash, hitKind: 'pin' }

        // 1. Base contact glow ring flush on Earth
        const ringGeo = new THREE.RingGeometry(0.16, 0.36, 24)
        ringGeo.rotateX(-Math.PI / 2)
        const ringMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(headHex),
          transparent: true,
          opacity: 0.72,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
        const ringMesh = new THREE.Mesh(ringGeo, ringMat)
        ringMesh.position.y = 0.02
        ringMesh.userData = ud
        ringMesh.renderOrder = 8
        root.add(ringMesh)

        // 2. Metallic tapered pin shaft
        const shaftGeo = new THREE.CylinderGeometry(0.055, 0.022, 1.25, 10)
        const shaftMat = new THREE.MeshBasicMaterial({ color: '#E2E8F0' })
        const shaftMesh = new THREE.Mesh(shaftGeo, shaftMat)
        shaftMesh.position.y = 0.64
        shaftMesh.userData = ud
        shaftMesh.renderOrder = 9
        root.add(shaftMesh)

        // 3. Glossy 3D spherical pinhead (custom lit specular shader)
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

        // 4. Subtle warm halo ring around pinhead when unread / mentions exist
        if (hasUnread) {
          const haloGeo = new THREE.TorusGeometry(0.43, 0.045, 8, 24)
          haloGeo.rotateX(Math.PI / 2)
          const haloMat = new THREE.MeshBasicMaterial({
            color: item.mentionCount > 0 ? '#F59E0B' : '#FB7185',
            transparent: true,
            opacity: 0.9,
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
        pinEntriesRef.current.set(item.geohash, {
          channelKey: item.geohash,
          root,
          normal,
          headTipY: 1.74,
          hitMesh,
        })
      }
    }, [pinnedEarthItems, theme])

    // -----------------------------------------------------------------------
    // 11. Build Orbiting Procedural 3D Topic Asteroids + Orbital Track Rings
    // -----------------------------------------------------------------------
    useEffect(() => {
      const sr = sceneRefs.current
      if (!sr) return

      // Preserve smooth continuous orbit elapsed timestamps across prop updates
      const prevElapsedByKey = new Map<string, number>()
      for (const [key, entry] of asteroidEntriesRef.current.entries()) {
        prevElapsedByKey.set(key, entry.orbitElapsedSec)
      }

      const group = sr.asteroidGroup
      const orbitGroup = sr.asteroidOrbitGroup
      while (group.children.length > 0) {
        const ch = group.children[0]
        group.remove(ch)
        disposeObject3D(ch)
      }
      while (orbitGroup.children.length > 0) {
        const ch = orbitGroup.children[0]
        orbitGroup.remove(ch)
        disposeObject3D(ch)
      }
      asteroidEntriesRef.current.clear()

      if (topicAsteroidItems.length === 0) return

      const pal = readCanvasPalette(hostRef.current, theme)
      const rimColor = new THREE.Color(pal.accentSecondary)
      const pinAccent = new THREE.Color('#EF4444')
      const activeAccent = new THREE.Color(pal.accent)

      for (const item of topicAsteroidItems) {
        const { spec } = item
        const elapsed = prevElapsedByKey.get(item.channelKey) ?? sr.orbitClockSec
        const [wx, wy, wz] = computeAsteroidWorldPosition(spec, elapsed)
        const ud = { channelKey: item.channelKey, slug: item.slug, hitKind: 'asteroid' }

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
              value: item.isActive || item.isSelected ? activeAccent.clone() : rimColor.clone(),
            },
            uHighlight: {
              value: item.isActive || item.isSelected ? 1.0 : item.isPinned ? 0.22 : 0.0,
            },
            uMeanRadius: { value: spec.rockRadius },
          },
        })
        const rockMesh = new THREE.Mesh(rockGeo, rockMaterial)
        rockMesh.userData = ud
        rockMesh.renderOrder = 9
        root.add(rockMesh)

        // Miniature glowing 3D pin/beacon planted right onto pinned topic asteroids
        if (item.isPinned) {
          const pinStemH = spec.rockRadius * 0.72
          const stemGeo = new THREE.CylinderGeometry(
            spec.rockRadius * 0.07,
            spec.rockRadius * 0.04,
            pinStemH,
            8,
          )
          const stemMat = new THREE.MeshBasicMaterial({ color: '#E2E8F0' })
          const stemMesh = new THREE.Mesh(stemGeo, stemMat)
          stemMesh.position.y = spec.rockRadius * 0.92 + pinStemH * 0.45
          stemMesh.userData = ud
          stemMesh.renderOrder = 10
          root.add(stemMesh)

          const beaconGeo = new THREE.SphereGeometry(spec.rockRadius * 0.26, 12, 10)
          const beaconMat = new THREE.ShaderMaterial({
            vertexShader: PINHEAD_VERTEX_SHADER,
            fragmentShader: PINHEAD_FRAGMENT_SHADER,
            uniforms: {
              uColor: {
                value: item.isActive || item.isSelected ? activeAccent.clone() : pinAccent.clone(),
              },
              uSunDir: { value: sr.sunDir.clone() },
            },
          })
          const beaconMesh = new THREE.Mesh(beaconGeo, beaconMat)
          beaconMesh.position.y = spec.rockRadius * 0.92 + pinStemH + spec.rockRadius * 0.16
          beaconMesh.userData = ud
          beaconMesh.renderOrder = 10
          root.add(beaconMesh)
        }

        // Invisible larger hit-sphere (1.9x rockRadius) for effortless mobile & desktop tapping
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

        // Delicate orbital track ring (subtle for pinned/live, highlighted for active/selected/hovered)
        const orbitGeo = createAsteroidOrbitLoopGeometry(spec)
        const isHighlighted = item.isActive || item.isSelected
        const orbitMaterial = new THREE.LineBasicMaterial({
          color: isHighlighted ? activeAccent : rimColor,
          transparent: true,
          opacity: isHighlighted ? 0.38 : item.isPinned || item.isLive ? 0.075 : 0.03,
          depthWrite: false,
        })
        const orbitLine = new THREE.LineLoop(orbitGeo, orbitMaterial)
        orbitLine.renderOrder = 2
        orbitGroup.add(orbitLine)

        asteroidEntriesRef.current.set(item.channelKey, {
          channelKey: item.channelKey,
          slug: item.slug,
          spec,
          root,
          rockMesh,
          rockMaterial,
          hitMesh,
          orbitLine,
          orbitMaterial,
          spinAxis: new THREE.Vector3(...spec.spinAxis).normalize(),
          orbitElapsedSec: elapsed,
          worldPos: new THREE.Vector3(wx, wy, wz),
          isPinned: item.isPinned,
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

    const setPinChipEl = useCallback((gh: string, node: HTMLButtonElement | null) => {
      if (node) pinChipElsRef.current.set(gh, node)
      else pinChipElsRef.current.delete(gh)
    }, [])

    const setAsteroidChipEl = useCallback((key: string, node: HTMLButtonElement | null) => {
      if (node) asteroidChipElsRef.current.set(key, node)
      else asteroidChipElsRef.current.delete(key)
    }, [])

    const nowMsForRecent = Date.now()
    const placedBubbleKeySet = useMemo(
      () => new Set(bubbleStacks.map((s) => s.geohash)),
      [bubbleStacks],
    )

    return (
      <div
        ref={hostRef}
        className={`ag-radar-map-host ag-radar-map-${mode} ${className}`}
        data-map-theme={theme}
      >
        {/* Three.js WebGL 3D Earth Globe + Topic Asteroid Belt Canvas */}
        <div
          ref={canvasWrapRef}
          className="ag-globe-canvas-wrap"
          aria-label={`Interactive 3D geohash globe centered on #${safeActiveGeohash}`}
        />

        {/* Graceful Fallback if WebGL Cannot Initialize */}
        {webglError && (
          <div className="ag-globe-fallback" role="status">
            <div className="ag-globe-fallback-card">
              <div className="ag-globe-fallback-title">3D Globe Unavailable</div>
              <p className="ag-globe-fallback-sub">
                WebGL hardware graphics could not initialize on this device. Active cell:{' '}
                <span className="mono">#{safeActiveGeohash}</span>.
              </p>
            </div>
          </div>
        )}

        {/* Projected 3D -> 2D Interactive Overlay Layer (Horizon & Earth-Limb Occluded in rAF) */}
        {!webglError && (
          <div className="ag-globe-bubble-layer" aria-hidden={false}>
            {/* Live Pulse Surface Sonar Beacons */}
            {showPulse &&
              validPulseRooms.map((room) => {
                const isFocused =
                  room.geohash === safeActiveGeohash || room.geohash === safeSelectedGeohash
                const hasBubble = showBubbles && placedBubbleKeySet.has(room.geohash)
                const showPill = !isFocused && !hasBubble && mode === 'expanded' && room.peerCount >= 2
                const countTag = room.peerCount > 0 ? `${room.peerCount}p` : `${room.messageCount}m`
                return (
                  <button
                    key={room.geohash}
                    ref={(node) => setBeaconEl(room.geohash, node)}
                    type="button"
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      pointerEvents: 'auto',
                      zIndex: 6,
                      visibility: 'hidden',
                      opacity: 0,
                    }}
                    title={`#${room.geohash}${room.nearestCity ? ` · ${room.nearestCity}` : ''} (${room.peerCount} ${room.peerCount === 1 ? 'peer' : 'peers'})`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      emitSelectChannel(room.geohash)
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      if (modeRef.current === 'expanded') {
                        emitTuneChannel(room.geohash)
                      }
                    }}
                  >
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: '999px',
                        backgroundColor: 'var(--accent)',
                        border: '2px solid var(--bg-canvas)',
                        boxShadow:
                          '0 0 0 3px color-mix(in srgb, var(--accent) 34%, transparent), 0 0 10px var(--accent)',
                        flexShrink: 0,
                      }}
                    />
                    {showPill && (
                      <span
                        className="mono"
                        style={{
                          padding: '1px 6px',
                          borderRadius: '999px',
                          backgroundColor: 'color-mix(in srgb, var(--bg-surface) 92%, transparent)',
                          border: '1px solid color-mix(in srgb, var(--accent) 52%, transparent)',
                          color: 'var(--text-primary)',
                          fontSize: 10,
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                          boxShadow: 'var(--shadow-sm)',
                        }}
                      >
                        #{room.geohash}{' '}
                        <b style={{ color: 'var(--accent)', fontWeight: 700 }}>{countTag}</b>
                      </span>
                    )}
                  </button>
                )
              })}

            {/* Pinned Earth Geohash Push-Pin Chips (Anchored Above 3D Pinhead Tips) */}
            {pinnedEarthItems.map((item) => {
              const badgeCount = item.mentionCount > 0 ? item.mentionCount : item.unreadCount
              return (
                <button
                  key={item.geohash}
                  ref={(node) => setPinChipEl(item.geohash, node)}
                  type="button"
                  className={`ag-globe-pin-chip${item.isActive ? ' is-active' : ''}${item.isSelected ? ' is-selected' : ''}${badgeCount > 0 ? ' has-unread' : ''}`}
                  style={{ visibility: 'hidden', opacity: 0 }}
                  title={`Pinned #${item.geohash} — click to inspect, double-click to join`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    emitSelectChannel(item.geohash)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    emitTuneChannel(item.geohash)
                  }}
                >
                  <span className="ag-globe-pin-dot" aria-hidden="true" />
                  <span className="ag-globe-pin-label mono">#{item.geohash}</span>
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

            {/* Orbiting Topic Asteroid Chips (`kind: 23333`) */}
            {topicAsteroidItems.map((item) => {
              const badgeCount = item.mentionCount > 0 ? item.mentionCount : item.unreadCount
              return (
                <button
                  key={item.channelKey}
                  ref={(node) => setAsteroidChipEl(item.channelKey, node)}
                  type="button"
                  className={`ag-globe-asteroid-chip${item.isPinned ? ' is-pinned' : ''}${item.isLive ? ' is-live' : ''}${item.isActive ? ' is-active' : ''}${item.isSelected ? ' is-selected' : ''}${badgeCount > 0 ? ' has-unread' : ''}`}
                  style={{ visibility: 'hidden', opacity: 0 }}
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
                    <span className="ag-globe-asteroid-pin" aria-hidden="true">
                      <Pin size={10} />
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

            {/* Active Tuned Geohash Pill */}
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
                #{safeActiveGeohash}
              </span>
            </div>

            {/* Selected / Inspected Geohash Pill */}
            {safeSelectedGeohash && safeSelectedGeohash !== safeActiveGeohash && (
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
                  #{safeSelectedGeohash}
                </span>
              </div>
            )}

            {/* Physical User GPS Beacon */}
            {userCoords && (
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

            {/* Upward-Queued Speech Bubbles (Earth Geohashes & Orbiting Topic Asteroids — Max 4 / 5s Fadeout) */}
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
                    const isRecent = nowMsForRecent - bubble.tsMs < RECENT_BUBBLE_WINDOW_MS
                    return (
                      <div
                        key={bubble.key}
                        role="button"
                        tabIndex={0}
                        className={`ag-globe-bubble${isLatest ? ' is-latest' : ' is-older'}${isDemoted ? ' is-demoted' : ''}${bubble.fadingOut ? ' is-fading' : ''}${isRecent ? ' is-recent' : ''}${stack.isFocused ? ' is-focused' : ''}`}
                        title={`${stack.displayTag} — ${bubble.sender}: ${bubble.snippet}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          emitSelectChannel(stack.geohash)
                          if (stack.isTopic) {
                            flyToTopicInternal(stack.geohash, { animate: true })
                          }
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          emitTuneChannel(stack.geohash)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            emitSelectChannel(stack.geohash)
                          }
                        }}
                      >
                        <div className="ag-globe-bubble-head">
                          <span
                            className={`ag-globe-bubble-dot${isRecent && isLatest ? ' is-live' : ''}`}
                          />
                          <span className="ag-globe-bubble-sender">{bubble.sender}</span>
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

        {/* Compact Unobtrusive Map Tile Attribution */}
        {!webglError && (
          <div
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
              pointerEvents: 'none',
            }}
            aria-hidden="true"
          >
            © Esri · OSM
          </div>
        )}

        {/* Desktop Hover Coordinate / Pin / Topic Asteroid Readout */}
        {hoverHud && !webglError && (
          <div className="ag-radar-hover-hud mono" aria-hidden="true">
            <span className="ag-radar-hud-accent">#{hoverHud.geohash}</span>
            <span className="ag-radar-hud-sep">·</span>
            <span>{hoverHud.coords}</span>
          </div>
        )}
      </div>
    )
  },
)

export default TacticalGeohashMap
