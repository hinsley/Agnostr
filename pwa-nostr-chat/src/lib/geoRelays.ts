import type { RelayRole } from '../types/protocol.ts'
import { decodeCenter, haversineKm } from './geohash.ts'
import { isTopicChannel } from './bitchatChannel.ts'

export interface GeoRelayEntry {
  url: string
  lat: number
  lon: number
  supportsDm: boolean
}

export const BITCHAT_GEO_RELAYS_CSV_URL =
  'https://raw.githubusercontent.com/permissionlesstech/bitchat/refs/heads/main/relays/online_relays_gps.csv'

/**
 * Live-verified core relays supporting kind 20000, 20001, 20007, 1059 (DMs), and 1 (/drop).
 */
export const CORE_DM_RELAYS: readonly string[] = [
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://nostr.bitcoiner.social',
  'wss://relay.damus.io',
]

/**
 * Geographically distributed live-verified relays for the Global Pulse Radar.
 */
export const PULSE_RELAYS: readonly string[] = [
  'wss://bitchat.nostr1.com',
  'wss://relay.fundstr.me',
  'wss://offchain.pub',
  'wss://nostr.bitcoiner.social',
  'wss://nostr-relay.zimage.com',
  'wss://relay.angor.io',
  'wss://nostr.mom',
  'wss://staging.yabu.me',
  'wss://nostr-01.yakihonne.com',
  'wss://relay.snort.social',
  'wss://nos.lol',
]

/**
 * Bundled fallback geo-relay directory (all live-verified for kind 20000 + 20001 echo).
 */
export const BUNDLED_GEO_RELAYS: readonly GeoRelayEntry[] = [
  { url: 'wss://bitchat.nostr1.com', lat: 40.7057, lon: -74.0136, supportsDm: false },
  { url: 'wss://relay.fundstr.me', lat: 42.3601, lon: -71.0589, supportsDm: false },
  { url: 'wss://relay.lightning.pub', lat: 39.0438, lon: -77.4874, supportsDm: false },
  { url: 'wss://strfry.bonsai.com', lat: 39.0438, lon: -77.4874, supportsDm: false },
  { url: 'wss://cdn.satellite.earth', lat: 40.8302, lon: -74.1299, supportsDm: false },
  { url: 'wss://offchain.pub', lat: 39.1585, lon: -94.5728, supportsDm: true },
  { url: 'wss://nostr.bitcoiner.social', lat: 47.6062, lon: -122.3321, supportsDm: true },
  { url: 'wss://nostr-relay.zimage.com', lat: 34.0549, lon: -118.243, supportsDm: false },
  { url: 'wss://articles.layer3.news', lat: 37.7749, lon: -122.4194, supportsDm: false },
  { url: 'wss://relay.sharegap.net', lat: 43.6532, lon: -79.3832, supportsDm: false },
  { url: 'wss://relay.angor.io', lat: 48.1046, lon: 11.6002, supportsDm: false },
  { url: 'wss://nostr.mom', lat: 52.52, lon: 13.405, supportsDm: false },
  { url: 'wss://staging.yabu.me', lat: 35.6092, lon: 139.73, supportsDm: false },
  { url: 'wss://nostr-01.yakihonne.com', lat: 1.32123, lon: 103.695, supportsDm: false },
  { url: 'wss://nos.lol', lat: 50.1109, lon: 8.6821, supportsDm: true },
  { url: 'wss://relay.snort.social', lat: 40.7128, lon: -74.006, supportsDm: true },
  { url: 'wss://relay.damus.io', lat: 43.6532, lon: -79.3832, supportsDm: true },
]

/** Relays confirmed offline or rejecting ephemeral events */
const BLOCKED_RELAY_HOSTS = new Set([
  'relay.nostr.band',
  'nostr.2b9t.xyz',
  'relay-testnet.k8s.layer3.news',
  'nostr21.com',
  'relay.nostu.be',
  'relay.nos.social',
  'nostr.thalheim.io',
])

export function normalizeRelayUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const candidate = trimmed.includes('://') ? trimmed : `wss://${trimmed}`
  try {
    const parsed = new URL(candidate)
    const scheme = parsed.protocol.toLowerCase()
    if (scheme !== 'wss:' && !(scheme === 'ws:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'))) {
      return null
    }
    const host = parsed.hostname.toLowerCase()
    if (!host || host.length > 253 || host.endsWith('.local') || host.endsWith('.internal')) {
      return null
    }
    if (scheme === 'wss:' && (host === 'localhost' || host.endsWith('.localhost'))) {
      return null
    }
    const portPart = parsed.port && parsed.port !== '443' ? `:${parsed.port}` : ''
    const pathPart = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : ''
    return `${scheme}//${host}${portPart}${pathPart}`
  } catch {
    return null
  }
}

export function parseGeoRelayCsv(csvText: string): GeoRelayEntry[] {
  if (!csvText || csvText.length > 512 * 1024) return []
  const lines = csvText.split(/\r?\n/)
  const seen = new Set<string>()
  const entries: GeoRelayEntry[] = []

  const coreDmSet = new Set<string>(CORE_DM_RELAYS)

  for (let i = 0; i < lines.length && entries.length < 1500; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(',')
    if (parts.length < 3) continue
    if (i === 0 && parts[0].toLowerCase().includes('relay')) continue

    const url = normalizeRelayUrl(parts[0])
    if (!url || seen.has(url)) continue
    try {
      const host = new URL(url).hostname.toLowerCase()
      if (BLOCKED_RELAY_HOSTS.has(host)) continue
    } catch {
      continue
    }

    const lat = Number.parseFloat(parts[1])
    const lon = Number.parseFloat(parts[2])
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      continue
    }
    seen.add(url)
    entries.push({ url, lat, lon, supportsDm: coreDmSet.has(url) })
  }

  return entries
}

export function mergeGeoDirectories(remoteEntries: GeoRelayEntry[]): GeoRelayEntry[] {
  const byUrl = new Map<string, GeoRelayEntry>()
  for (const entry of BUNDLED_GEO_RELAYS) {
    byUrl.set(entry.url, entry)
  }
  for (const entry of remoteEntries) {
    if (!byUrl.has(entry.url)) {
      byUrl.set(entry.url, entry)
    }
  }
  return Array.from(byUrl.values())
}

export async function fetchBitchatGeoRelays(timeoutMs = 6000): Promise<GeoRelayEntry[] | null> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(BITCHAT_GEO_RELAYS_CSV_URL, {
      signal: controller.signal,
      cache: 'no-cache',
    })
    if (!res.ok) return null
    const text = await res.text()
    const parsed = parseGeoRelayCsv(text)
    if (parsed.length < 20) return null
    return parsed
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

export interface SelectedRelayMeta {
  url: string
  roles: RelayRole[]
  lat?: number
  lon?: number
  distanceKm?: number
  supportsDm: boolean
}

export interface ChannelRelaySelection {
  channelRelays: string[]
  dmRelays: string[]
  pulseRelays: string[]
  allMetadata: Map<string, SelectedRelayMeta>
}

export function selectRelaysForGeohash(
  geohash: string,
  directory: readonly GeoRelayEntry[],
  customRelays: readonly string[],
  geoCount = 5
): ChannelRelaySelection {
  const isTopic = isTopicChannel(geohash)
  const center = isTopic ? null : decodeCenter(geohash)
  const metaMap = new Map<string, SelectedRelayMeta>()
  const coreDmSet = new Set<string>(CORE_DM_RELAYS)

  const addRole = (
    url: string,
    role: RelayRole,
    coords?: { lat: number; lon: number; distanceKm?: number },
    supportsDm = false
  ) => {
    const existing = metaMap.get(url)
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role)
      if (coords && existing.lat === undefined) {
        existing.lat = coords.lat
        existing.lon = coords.lon
        existing.distanceKm = coords.distanceKm
      }
      if (supportsDm) existing.supportsDm = true
    } else {
      metaMap.set(url, {
        url,
        roles: [role],
        lat: coords?.lat,
        lon: coords?.lon,
        distanceKm: coords?.distanceKm,
        supportsDm: supportsDm || coreDmSet.has(url),
      })
    }
  }

  const channelSet = new Set<string>()

  if (isTopic) {
    // Named kind:23333 topic channels are global (non-geographic): fan out across broad
    // core + top pulse relays (including bitchat.nostr1.com & ephemeral-friendly global relays).
    for (const url of PULSE_RELAYS.slice(0, 7)) {
      channelSet.add(url)
      const dirEntry = directory.find((d) => d.url === url)
      addRole(
        url,
        'pulse',
        dirEntry ? { lat: dirEntry.lat, lon: dirEntry.lon } : undefined,
        coreDmSet.has(url)
      )
    }
  } else if (center) {
    // Prefer bundled live-verified relays first when distances tie, plus full directory
    const bundledSet = new Set(BUNDLED_GEO_RELAYS.map((e) => e.url))
    const scored = directory
      .map((entry) => ({
        entry,
        distanceKm: haversineKm(center.lat, center.lon, entry.lat, entry.lon),
        verified: bundledSet.has(entry.url),
      }))
      .sort((a, b) => {
        // Slight preference (300km bonus) for live-verified relays so dead remote entries don't starve rooms
        const scoreA = a.distanceKm - (a.verified ? 300 : 0)
        const scoreB = b.distanceKm - (b.verified ? 300 : 0)
        return scoreA - scoreB
      })

    // 1. Closest N geo-routed relays
    for (const item of scored.slice(0, geoCount)) {
      channelSet.add(item.entry.url)
      addRole(
        item.entry.url,
        'geo',
        { lat: item.entry.lat, lon: item.entry.lon, distanceKm: Math.round(item.distanceKm) },
        item.entry.supportsDm
      )
    }
  }

  // 2. Core global + DM relays (always participate in channel + DMs)
  const dmSet = new Set<string>()
  for (const url of CORE_DM_RELAYS) {
    channelSet.add(url)
    dmSet.add(url)
    const dirEntry = directory.find((d) => d.url === url)
    addRole(
      url,
      'core',
      dirEntry
        ? {
            lat: dirEntry.lat,
            lon: dirEntry.lon,
            distanceKm: center ? Math.round(haversineKm(center.lat, center.lon, dirEntry.lat, dirEntry.lon)) : undefined,
          }
        : undefined,
      true
    )
  }

  // 3. User custom relays
  for (const raw of customRelays) {
    const url = normalizeRelayUrl(raw)
    if (!url) continue
    channelSet.add(url)
    dmSet.add(url)
    addRole(url, 'custom', undefined, true)
  }

  // 4. Global Pulse radar relays
  const pulseSet = new Set<string>()
  for (const url of PULSE_RELAYS) {
    pulseSet.add(url)
    const dirEntry = directory.find((d) => d.url === url)
    addRole(
      url,
      'pulse',
      dirEntry
        ? {
            lat: dirEntry.lat,
            lon: dirEntry.lon,
            distanceKm: center ? Math.round(haversineKm(center.lat, center.lon, dirEntry.lat, dirEntry.lon)) : undefined,
          }
        : undefined,
      coreDmSet.has(url)
    )
  }

  return {
    channelRelays: Array.from(channelSet),
    dmRelays: Array.from(dmSet),
    pulseRelays: Array.from(pulseSet),
    allMetadata: metaMap,
  }
}
