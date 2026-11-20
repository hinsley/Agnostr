import type {
  GeoBounds,
  GeoCoords,
  GeohashCell,
  GeoNeighbors,
  GeoPrefixStep,
  PrecisionInfo,
  QuickCity,
} from '../types/protocol.ts'

export const BASE32_CHARS = '0123456789bcdefghjkmnpqrstuvwxyz'

const BASE32_MAP: Record<string, number> = (() => {
  const map: Record<string, number> = {}
  for (let i = 0; i < BASE32_CHARS.length; i++) {
    map[BASE32_CHARS[i]] = i
  }
  return map
})()

export const DEFAULT_GEOHASH = '9q'

export const QUICK_CITIES: QuickCity[] = [
  { name: 'California', region: 'US West', geohash: '9q', lat: 36.56, lon: -118.13 },
  { name: 'San Francisco', region: 'CA, USA', geohash: '9q8y', lat: 37.7749, lon: -122.4194 },
  { name: 'New York City', region: 'NY, USA', geohash: 'dr5r', lat: 40.7128, lon: -74.006 },
  { name: 'London', region: 'UK', geohash: 'gcpv', lat: 51.5072, lon: -0.1276 },
  { name: 'Berlin', region: 'Germany', geohash: 'u33d', lat: 52.52, lon: 13.405 },
  { name: 'Tokyo', region: 'Japan', geohash: 'xn77', lat: 35.6762, lon: 139.6503 },
  { name: 'Singapore', region: 'SG', geohash: 'w21z', lat: 1.3521, lon: 103.8198 },
  { name: 'Agnostr Lounge', region: 'Global', geohash: '4gn0str', lat: -44.65, lon: -11.22, isLounge: true },
]

interface CityReference {
  name: string
  lat: number
  lon: number
  aliases?: string[]
  geohash?: string
}

const WORLD_CITIES: CityReference[] = [
  { name: 'San Francisco', lat: 37.7749, lon: -122.4194, aliases: ['sf', 'bay area'], geohash: '9q8y' },
  { name: 'Los Angeles', lat: 34.0522, lon: -118.2437, aliases: ['la', 'socal'], geohash: '9q5c' },
  { name: 'San Diego', lat: 32.7157, lon: -117.1611, aliases: ['sd'], geohash: '9mud' },
  { name: 'Seattle', lat: 47.6062, lon: -122.3321, aliases: ['sea', 'pnw'], geohash: 'c23n' },
  { name: 'Portland', lat: 45.5152, lon: -122.6784, aliases: ['pdx'], geohash: 'c20f' },
  { name: 'Vancouver', lat: 49.2827, lon: -123.1207, aliases: ['yvr'], geohash: 'c2b2' },
  { name: 'Denver', lat: 39.7392, lon: -104.9903, aliases: ['den'], geohash: '9xj6' },
  { name: 'Phoenix', lat: 33.4484, lon: -112.074, aliases: ['phx'], geohash: '9tbq' },
  { name: 'Austin', lat: 30.2672, lon: -97.7431, aliases: ['atx'], geohash: '9v6k' },
  { name: 'San Antonio', lat: 29.4241, lon: -98.4936, aliases: ['satx'], geohash: '9v1z' },
  { name: 'Dallas', lat: 32.7767, lon: -96.797, aliases: ['dfw'], geohash: '9vg4' },
  { name: 'Houston', lat: 29.7604, lon: -95.3698, aliases: ['hou'], geohash: '9vk1' },
  { name: 'Chicago', lat: 41.8781, lon: -87.6298, aliases: ['chi'], geohash: 'dp3w' },
  { name: 'Minneapolis', lat: 44.9778, lon: -93.265, aliases: ['msp'], geohash: '9zvx' },
  { name: 'Atlanta', lat: 33.749, lon: -84.388, aliases: ['atl'], geohash: 'djgz' },
  { name: 'Miami', lat: 25.7617, lon: -80.1918, aliases: ['mia'], geohash: 'dhwf' },
  { name: 'Washington DC', lat: 38.9072, lon: -77.0369, aliases: ['dc', 'washington'], geohash: 'dqcj' },
  { name: 'Philadelphia', lat: 39.9526, lon: -75.1652, aliases: ['philly'], geohash: 'dr4e' },
  { name: 'New York City', lat: 40.7128, lon: -74.006, aliases: ['nyc', 'ny', 'new york', 'manhattan'], geohash: 'dr5r' },
  { name: 'Boston', lat: 42.3601, lon: -71.0589, aliases: ['bos'], geohash: 'drt2' },
  { name: 'Toronto', lat: 43.6532, lon: -79.3832, aliases: ['yyz'], geohash: 'dpz8' },
  { name: 'Montreal', lat: 45.5017, lon: -73.5673, aliases: ['mtl'], geohash: 'f25d' },
  { name: 'Mexico City', lat: 19.4326, lon: -99.1332, aliases: ['cdmx'], geohash: '9g3w' },
  { name: 'Bogotá', lat: 4.711, lon: -74.0721, aliases: ['bogota'], geohash: 'd2g6' },
  { name: 'Lima', lat: -12.0464, lon: -77.0428, geohash: '6mc5' },
  { name: 'Santiago', lat: -33.4489, lon: -70.6693, geohash: '66jc' },
  { name: 'Buenos Aires', lat: -34.6037, lon: -58.3816, aliases: ['ba'], geohash: '69y7' },
  { name: 'São Paulo', lat: -23.5505, lon: -46.6333, aliases: ['sao paulo', 'sp'], geohash: '6gyf' },
  { name: 'Rio de Janeiro', lat: -22.9068, lon: -43.1729, aliases: ['rio'], geohash: '75cm' },
  { name: 'London', lat: 51.5072, lon: -0.1276, aliases: ['ldn', 'uk'], geohash: 'gcpv' },
  { name: 'Dublin', lat: 53.3498, lon: -6.2603, geohash: 'gc7x' },
  { name: 'Paris', lat: 48.8566, lon: 2.3522, geohash: 'u09t' },
  { name: 'Brussels', lat: 50.8503, lon: 4.3517, geohash: 'u151' },
  { name: 'Amsterdam', lat: 52.3676, lon: 4.9041, aliases: ['ams'], geohash: 'u173' },
  { name: 'Madrid', lat: 40.4168, lon: -3.7038, geohash: 'ezjm' },
  { name: 'Barcelona', lat: 41.3874, lon: 2.1686, aliases: ['bcn'], geohash: 'sp3e' },
  { name: 'Lisbon', lat: 38.7223, lon: -9.1393, geohash: 'eycs' },
  { name: 'Zurich', lat: 47.3769, lon: 8.5417, geohash: 'u0qj' },
  { name: 'Milan', lat: 45.4642, lon: 9.19, geohash: 'u0nd' },
  { name: 'Rome', lat: 41.9028, lon: 12.4964, geohash: 'sr2y' },
  { name: 'Munich', lat: 48.1351, lon: 11.582, geohash: 'u281' },
  { name: 'Berlin', lat: 52.52, lon: 13.405, aliases: ['ber'], geohash: 'u33d' },
  { name: 'Vienna', lat: 48.2082, lon: 16.3738, geohash: 'u2ed' },
  { name: 'Prague', lat: 50.0755, lon: 14.4378, geohash: 'u2fk' },
  { name: 'Warsaw', lat: 52.2297, lon: 21.0122, geohash: 'u3qc' },
  { name: 'Stockholm', lat: 59.3293, lon: 18.0686, geohash: 'u6sc' },
  { name: 'Helsinki', lat: 60.1699, lon: 24.9384, geohash: 'ud9w' },
  { name: 'Athens', lat: 37.9838, lon: 23.7275, geohash: 'swbb' },
  { name: 'Istanbul', lat: 41.0082, lon: 28.9784, geohash: 'sxk9' },
  { name: 'Cairo', lat: 30.0444, lon: 31.2357, geohash: 'stq4' },
  { name: 'Lagos', lat: 6.5244, lon: 3.3792, geohash: 's14m' },
  { name: 'Nairobi', lat: -1.2921, lon: 36.8219, geohash: 'kzf0' },
  { name: 'Cape Town', lat: -33.9249, lon: 18.4241, geohash: 'k3vp' },
  { name: 'Dubai', lat: 25.2048, lon: 55.2708, aliases: ['dxb'], geohash: 'thrr' },
  { name: 'Mumbai', lat: 19.076, lon: 72.8777, geohash: 'te7u' },
  { name: 'Bengaluru', lat: 12.9716, lon: 77.5946, aliases: ['bangalore'], geohash: 'tdr1' },
  { name: 'Delhi', lat: 28.6139, lon: 77.209, geohash: 'ttn9' },
  { name: 'Bangkok', lat: 13.7563, lon: 100.5018, aliases: ['bkk'], geohash: 'w4rq' },
  { name: 'Singapore', lat: 1.3521, lon: 103.8198, aliases: ['sg'], geohash: 'w21z' },
  { name: 'Hong Kong', lat: 22.3193, lon: 114.1694, aliases: ['hk'], geohash: 'wecn' },
  { name: 'Taipei', lat: 25.033, lon: 121.5654, geohash: 'wsqq' },
  { name: 'Shanghai', lat: 31.2304, lon: 121.4737, geohash: 'wtw3' },
  { name: 'Beijing', lat: 39.9042, lon: 116.4074, geohash: 'wx4g' },
  { name: 'Seoul', lat: 37.5665, lon: 126.978, geohash: 'wydm' },
  { name: 'Osaka', lat: 34.6937, lon: 135.5023, geohash: 'xn0m' },
  { name: 'Tokyo', lat: 35.6762, lon: 139.6503, aliases: ['tyo'], geohash: 'xn77' },
  { name: 'Jakarta', lat: -6.2088, lon: 106.8456, geohash: 'qqgu' },
  { name: 'Sydney', lat: -33.8688, lon: 151.2093, aliases: ['syd'], geohash: 'r3gx' },
  { name: 'Melbourne', lat: -37.8136, lon: 144.9631, aliases: ['mel'], geohash: 'r1r0' },
  { name: 'Auckland', lat: -36.8509, lon: 174.7645, geohash: 'rckq' },
]

export function normalizeGeohash(raw: string): string {
  return raw.trim().replace(/^#+/, '').toLowerCase()
}

export function isValidGeohash(raw: string): boolean {
  const gh = normalizeGeohash(raw)
  if (gh.length < 1 || gh.length > 12) return false
  for (let i = 0; i < gh.length; i++) {
    if (BASE32_MAP[gh[i]] === undefined) return false
  }
  return true
}

export function clampLatitude(lat: number): number {
  return Math.max(-90, Math.min(90, lat))
}

export function wrapLongitude(lon: number): number {
  let w = lon
  while (w > 180) w -= 360
  while (w < -180) w += 360
  return w
}

export function encodeGeohash(lat: number, lon: number, precision: number): string {
  const p = Math.max(1, Math.min(12, Math.floor(precision)))
  let latMin = -90
  let latMax = 90
  let lonMin = -180
  let lonMax = 180

  const cLat = clampLatitude(lat)
  const cLon = wrapLongitude(lon)

  let isEven = true
  let bit = 0
  let ch = 0
  let out = ''

  while (out.length < p) {
    if (isEven) {
      const mid = (lonMin + lonMax) / 2
      if (cLon >= mid) {
        ch |= 1 << (4 - bit)
        lonMin = mid
      } else {
        lonMax = mid
      }
    } else {
      const mid = (latMin + latMax) / 2
      if (cLat >= mid) {
        ch |= 1 << (4 - bit)
        latMin = mid
      } else {
        latMax = mid
      }
    }
    isEven = !isEven
    if (bit < 4) {
      bit++
    } else {
      out += BASE32_CHARS[ch]
      bit = 0
      ch = 0
    }
  }
  return out
}

export function decodeBounds(raw: string): GeoBounds {
  const gh = normalizeGeohash(raw)
  let latMin = -90
  let latMax = 90
  let lonMin = -180
  let lonMax = 180

  let isEven = true
  for (let i = 0; i < gh.length; i++) {
    const cd = BASE32_MAP[gh[i]]
    if (cd === undefined) continue
    for (let mask = 16; mask >= 1; mask >>= 1) {
      if (isEven) {
        const mid = (lonMin + lonMax) / 2
        if ((cd & mask) !== 0) lonMin = mid
        else lonMax = mid
      } else {
        const mid = (latMin + latMax) / 2
        if ((cd & mask) !== 0) latMin = mid
        else latMax = mid
      }
      isEven = !isEven
    }
  }
  return { latMin, latMax, lonMin, lonMax }
}

export function decodeCenter(raw: string): GeoCoords {
  const b = decodeBounds(raw)
  return {
    lat: (b.latMin + b.latMax) / 2,
    lon: (b.lonMin + b.lonMax) / 2,
  }
}

export function getNeighbors(raw: string): GeoNeighbors {
  const gh = normalizeGeohash(raw)
  if (!gh) {
    return { nw: null, n: null, ne: null, w: null, center: '', e: null, sw: null, s: null, se: null }
  }
  const precision = gh.length
  const bounds = decodeBounds(gh)
  const center = decodeCenter(gh)
  const dLat = bounds.latMax - bounds.latMin
  const dLon = bounds.lonMax - bounds.lonMin

  const cellAt = (lat: number, lon: number): string | null => {
    if (lat > 90 || lat < -90) return null
    return encodeGeohash(clampLatitude(lat), wrapLongitude(lon), precision)
  }

  return {
    nw: cellAt(center.lat + dLat, center.lon - dLon),
    n: cellAt(center.lat + dLat, center.lon),
    ne: cellAt(center.lat + dLat, center.lon + dLon),
    w: cellAt(center.lat, center.lon - dLon),
    center: gh,
    e: cellAt(center.lat, center.lon + dLon),
    sw: cellAt(center.lat - dLat, center.lon - dLon),
    s: cellAt(center.lat - dLat, center.lon),
    se: cellAt(center.lat - dLat, center.lon + dLon),
  }
}

export function getPrecisionInfo(precision: number): PrecisionInfo {
  switch (precision) {
    case 1:
      return { precision: 1, level: 'continent', label: 'Continent', approxSizeLabel: '~5,000 km', allowsPresence: true }
    case 2:
      return { precision: 2, level: 'region', label: 'Region', approxSizeLabel: '~1,250 km', allowsPresence: true }
    case 3:
      return { precision: 3, level: 'subregion', label: 'Metro', approxSizeLabel: '~156 km', allowsPresence: true }
    case 4:
      return { precision: 4, level: 'province', label: 'Province', approxSizeLabel: '~39 km', allowsPresence: true }
    case 5:
      return { precision: 5, level: 'city', label: 'City', approxSizeLabel: '~4.9 km', allowsPresence: true }
    case 6:
      return { precision: 6, level: 'neighborhood', label: 'Neighborhood', approxSizeLabel: '~1.2 km', allowsPresence: false }
    case 7:
      return { precision: 7, level: 'block', label: 'Block', approxSizeLabel: '~153 m', allowsPresence: false }
    default:
      return {
        precision: Math.max(8, precision),
        level: 'building',
        label: 'Building',
        approxSizeLabel: precision >= 9 ? '~5 m' : '~38 m',
        allowsPresence: false,
      }
  }
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function findNearestCityLabel(lat: number, lon: number, geohash?: string): string | null {
  if (geohash && normalizeGeohash(geohash) === '4gn0str') {
    return 'Agnostr Lounge'
  }
  if (geohash && normalizeGeohash(geohash) === '9q') {
    return 'California'
  }
  let best: CityReference | null = null
  let bestDist = Infinity
  for (const city of WORLD_CITIES) {
    const d = haversineKm(lat, lon, city.lat, city.lon)
    if (d < bestDist) {
      bestDist = d
      best = city
    }
  }
  if (best && bestDist <= 320) {
    return bestDist <= 65 ? best.name : `Near ${best.name}`
  }
  const ns = lat >= 0 ? 'N' : 'S'
  const ew = lon >= 0 ? 'E' : 'W'
  return `${Math.abs(lat).toFixed(1)}°${ns}, ${Math.abs(lon).toFixed(1)}°${ew}`
}

export function resolveGeohashOrCity(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Coordinate pair "lat, lon"
  const coordMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/)
  if (coordMatch) {
    const lat = Number.parseFloat(coordMatch[1])
    const lon = Number.parseFloat(coordMatch[2])
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return encodeGeohash(lat, lon, 5)
    }
  }

  const lower = trimmed.toLowerCase()
  if (lower === 'lounge' || lower === 'agnostr' || lower === '#4gn0str') {
    return '4gn0str'
  }
  if (lower === 'california' || lower === 'ca') {
    return '9q'
  }

  for (const qc of QUICK_CITIES) {
    if (qc.name.toLowerCase() === lower || qc.geohash === normalizeGeohash(lower)) {
      return qc.geohash
    }
  }

  for (const city of WORLD_CITIES) {
    if (
      city.name.toLowerCase() === lower ||
      (city.aliases && city.aliases.some((a) => a === lower))
    ) {
      return city.geohash ?? encodeGeohash(city.lat, city.lon, 4)
    }
  }

  const normalized = normalizeGeohash(trimmed)
  if (isValidGeohash(normalized)) {
    return normalized
  }

  // Fuzzy prefix city search
  for (const city of WORLD_CITIES) {
    if (city.name.toLowerCase().startsWith(lower)) {
      return city.geohash ?? encodeGeohash(city.lat, city.lon, 4)
    }
  }

  return null
}

export function getPrefixChain(geohash: string, localFullGeohash?: string): GeoPrefixStep[] {
  const gh = normalizeGeohash(geohash)
  if (!gh) return []

  // If user's physical GPS geohash is inside this cell, allow one-click zoom deeper up to precision 7
  const target =
    localFullGeohash && localFullGeohash.startsWith(gh) && localFullGeohash.length > gh.length
      ? localFullGeohash.slice(0, Math.min(7, localFullGeohash.length))
      : gh

  const steps: GeoPrefixStep[] = []
  for (let len = 1; len <= target.length; len++) {
    const info = getPrecisionInfo(len)
    steps.push({
      geohash: target.slice(0, len),
      precision: len,
      label: info.label,
      approxSizeLabel: info.approxSizeLabel,
    })
  }
  return steps
}

export function buildGeohashCell(rawGeohash: string, localFullGeohash?: string): GeohashCell {
  const gh = isValidGeohash(rawGeohash) ? normalizeGeohash(rawGeohash) : DEFAULT_GEOHASH
  const info = getPrecisionInfo(gh.length)
  const bounds = decodeBounds(gh)
  const center = {
    lat: (bounds.latMin + bounds.latMax) / 2,
    lon: (bounds.lonMin + bounds.lonMax) / 2,
  }
  return {
    geohash: gh,
    precision: gh.length,
    level: info.level,
    label: info.label,
    approxSizeLabel: info.approxSizeLabel,
    allowsPresence: info.allowsPresence,
    center,
    bounds,
    neighbors: getNeighbors(gh),
    prefixChain: getPrefixChain(gh, localFullGeohash),
    nearestCity: findNearestCityLabel(center.lat, center.lon, gh),
  }
}

export function formatCoords(coords: GeoCoords): string {
  const ns = coords.lat >= 0 ? 'N' : 'S'
  const ew = coords.lon >= 0 ? 'E' : 'W'
  return `${Math.abs(coords.lat).toFixed(3)}°${ns} ${Math.abs(coords.lon).toFixed(3)}°${ew}`
}
