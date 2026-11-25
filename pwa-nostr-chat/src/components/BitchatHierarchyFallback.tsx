import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronRight,
  Crosshair,
  Globe,
  Hash,
  ListTree,
  Loader2,
  MapPin,
  Orbit,
  Pin,
  PinOff,
  Plus,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import type { AgnostrEngine, GeoBounds, PulseRoom } from '../types/protocol.ts'
import type { SoundCue } from '../utils/sound.ts'
import {
  decodeBounds,
  decodeCenter,
  findNearestCityLabel,
  formatCellDimensions,
  formatCoords,
  getChildGeohashes,
  getPrecisionInfo,
  haversineKm,
} from '../lib/geohash.ts'
import {
  POPULAR_TOPIC_CHANNELS,
  getChannelBodyId,
  getChannelRawGeohash,
  getTopicSlug,
  isTopicChannel,
  makeCelestialChannelKey,
  makeTopicChannelKey,
  normalizeTopicSlug,
  parseCelestialChannelKey,
  parseQuickTuneInput,
} from '../lib/bitchatChannel.ts'
import {
  GEOHASHABLE_BODY_IDS,
  PLANET_BODY_IDS,
  SOLAR_BODIES,
  findNearestCelestialLandmark,
  getBodyDef,
  getMoonsOfBody,
  isGeohashableBodyId,
  type CelestialBodyDef,
  type GeohashableBodyId,
} from '../lib/solarSystem.ts'

export interface BitchatHierarchyFallbackProps {
  engine: AgnostrEngine
  onTuneChannel: (channelKey: string) => void
  onClose: () => void
  onPlaySound?: (cue: SoundCue) => void
  embedded?: boolean
  webglAvailable: boolean
  onSwitchToGlobe?: () => void
}

type HierarchyTab = 'live' | 'worlds' | 'asteroids'
type ChildSortMode = 'active' | 'az'
type WarmthTier = 'hot' | 'warm' | 'recent'

const WARMTH_HOT_MS = 5 * 60 * 1000
const WARMTH_WARM_MS = 60 * 60 * 1000
const EARTH_RADIUS_KM = 6371.0

function getWarmthTier(tsMs: number, nowMs: number): WarmthTier {
  const ageMs = Math.max(0, nowMs - tsMs)
  if (ageMs < WARMTH_HOT_MS) return 'hot'
  if (ageMs < WARMTH_WARM_MS) return 'warm'
  return 'recent'
}

function formatCompactAge(tsMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - tsMs) / 1000))
  if (diffSec < 5) return 'now'
  if (diffSec < 60) return `${diffSec}s`
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

function formatSnippet(preview: string): string {
  if (!preview) return ''
  const cleaned = preview
    .replace(/\bcashu[AB][A-Za-z0-9_+/-]{8,}={0,2}/g, 'Cashu ecash')
    .replace(/https?:\/\/\S+/gi, 'Link')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  if (cleaned.length <= 84) return cleaned
  return `${cleaned.slice(0, 83).trimEnd()}…`
}

function formatScaledKm(km: number): string {
  if (km < 1) {
    const meters = km * 1000
    if (meters < 10) return `${meters.toFixed(1)} m`
    return `${Math.round(meters).toLocaleString('en-US')} m`
  }
  if (km < 10) return `${km.toFixed(1)} km`
  if (km < 100) return `${km.toFixed(1).replace(/\.0$/, '')} km`
  return `${Math.round(km).toLocaleString('en-US')} km`
}

function formatBodyCellDimensions(body: CelestialBodyDef, bounds: GeoBounds): string {
  if (body.id === 'earth') {
    return formatCellDimensions(bounds)
  }
  const scale = body.realRadiusKm / EARTH_RADIUS_KM
  const centerLat = (bounds.latMin + bounds.latMax) / 2
  const centerLon = (bounds.lonMin + bounds.lonMax) / 2
  const heightKm = haversineKm(bounds.latMin, centerLon, bounds.latMax, centerLon) * scale
  const widthKm = haversineKm(centerLat, bounds.lonMin, centerLat, bounds.lonMax) * scale
  if (heightKm < 1 && widthKm < 1) {
    return `~${formatScaledKm(widthKm).replace(/ m$/, '')} × ${formatScaledKm(heightKm)}`
  }
  return `~${formatScaledKm(widthKm).replace(/ km$/, '')} × ${formatScaledKm(heightKm)}`
}

function resolveBodyQuery(raw: string): GeohashableBodyId | null {
  const cleaned = raw.trim().replace(/^#/, '').trim().toLowerCase()
  if (!cleaned) return null
  if (cleaned === 'luna' || cleaned === 'the moon') return 'moon'
  if (isGeohashableBodyId(cleaned)) return cleaned
  for (const id of GEOHASHABLE_BODY_IDS) {
    if (SOLAR_BODIES[id].name.toLowerCase() === cleaned) return id
  }
  return null
}

function getPlaceLabelForCelestial(bodyId: GeohashableBodyId, rawGeohash: string): string {
  const center = decodeCenter(rawGeohash)
  if (bodyId === 'earth') {
    return findNearestCityLabel(center.lat, center.lon, rawGeohash) ?? formatCoords(center)
  }
  return findNearestCelestialLandmark(bodyId, center.lat, center.lon) ?? formatCoords(center)
}

interface HierarchyLiveEntry {
  channelKey: string
  displayTag: string
  isTopic: boolean
  bodyId: GeohashableBodyId | null
  rawGeohash: string | null
  bodyColor: string | null
  bodyName: string | null
  subLabel: string
  peerCount: number
  lastActivityAt: number
  warmth: WarmthTier
  unreadCount: number
  isPinned: boolean
  snippetSender: string
  snippetText: string
}

export function BitchatHierarchyFallback({
  engine,
  onTuneChannel,
  onClose,
  onPlaySound,
  embedded = false,
  webglAvailable,
  onSwitchToGlobe,
}: BitchatHierarchyFallbackProps) {
  const {
    activeGeohash,
    location,
    pulseRooms,
    pinnedChannels,
    unreadCounts,
    mentionCounts,
  } = engine

  const [activeTab, setActiveTab] = useState<HierarchyTab>(() =>
    pulseRooms.length > 0 || pinnedChannels.length > 0 ? 'live' : 'worlds',
  )
  const [browseBodyId, setBrowseBodyId] = useState<GeohashableBodyId | null>(null)
  const [browsePrefix, setBrowsePrefix] = useState<string>('')
  const [childSort, setChildSort] = useState<ChildSortMode>('active')
  const [searchDraft, setSearchDraft] = useState('')
  const [searchError, setSearchError] = useState<string | null>(null)
  const [topicDraft, setTopicDraft] = useState('')
  const [topicError, setTopicError] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState<number>(() => Date.now())

  useEffect(() => {
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])

  const celestialPulseRooms = useMemo(
    () => pulseRooms.filter((r) => parseCelestialChannelKey(r.geohash) !== null),
    [pulseRooms],
  )

  const topicPulseRooms = useMemo(
    () => pulseRooms.filter((r) => isTopicChannel(r.geohash)),
    [pulseRooms],
  )

  const pinnedTopics = useMemo(
    () => pinnedChannels.filter((p) => isTopicChannel(p.geohash)),
    [pinnedChannels],
  )

  const pinnedKeySet = useMemo(
    () => new Set(pinnedChannels.map((p) => p.geohash.toLowerCase())),
    [pinnedChannels],
  )

  const liveRoomByKey = useMemo(() => {
    const map = new Map<string, PulseRoom>()
    for (const room of celestialPulseRooms) map.set(room.geohash.toLowerCase(), room)
    for (const room of topicPulseRooms) map.set(room.geohash.toLowerCase(), room)
    return map
  }, [celestialPulseRooms, topicPulseRooms])

  const liveCountByBody = useMemo(() => {
    const counts: Partial<Record<GeohashableBodyId, number>> = {}
    for (const room of celestialPulseRooms) {
      const bodyId = getChannelBodyId(room.geohash)
      if (!bodyId) continue
      counts[bodyId] = (counts[bodyId] ?? 0) + 1
    }
    return counts
  }, [celestialPulseRooms])

  const pinCountByBody = useMemo(() => {
    const counts: Partial<Record<GeohashableBodyId, number>> = {}
    for (const pin of pinnedChannels) {
      const bodyId = getChannelBodyId(pin.geohash)
      if (!bodyId) continue
      counts[bodyId] = (counts[bodyId] ?? 0) + 1
    }
    return counts
  }, [pinnedChannels])

  const totalLiveCount = celestialPulseRooms.length + topicPulseRooms.length

  const knownTopicSlugs = useMemo(() => {
    const set = new Set<string>()
    for (const item of POPULAR_TOPIC_CHANNELS) set.add(item.slug.toLowerCase())
    for (const pin of pinnedTopics) {
      const slug = getTopicSlug(pin.geohash)
      if (slug) set.add(slug)
    }
    for (const room of topicPulseRooms) {
      const slug = getTopicSlug(room.geohash)
      if (slug) set.add(slug)
    }
    return set
  }, [pinnedTopics, topicPulseRooms])

  const allTopicCount = knownTopicSlugs.size
  const searchQuery = searchDraft.trim().toLowerCase()

  // Resolve direct channel match for instant 1-click Tune banner when user types #dr5r, #mars:s000, or #topic:bitcoin
  const directTuneMatch = useMemo(() => {
    const raw = searchDraft.trim()
    if (!raw) return null
    if (raw.includes(':')) {
      const topicKey = /^#?topic:/i.test(raw) ? makeTopicChannelKey(raw) : null
      if (topicKey) {
        const slug = getTopicSlug(topicKey) ?? raw
        return { key: topicKey, label: `#${slug}`, isTopic: true, bodyId: null, rawGh: null }
      }
      const parsedCel = parseCelestialChannelKey(raw.replace(/^#/, ''))
      if (parsedCel) {
        const key = makeCelestialChannelKey(parsedCel.bodyId, parsedCel.geohash)
        if (key) {
          return {
            key,
            label: `#${key}`,
            isTopic: false,
            bodyId: parsedCel.bodyId,
            rawGh: parsedCel.geohash,
          }
        }
      }
    }
    if (raw.startsWith('#') || raw.startsWith('/')) {
      const slug = normalizeTopicSlug(raw)
      if (slug && (raw.startsWith('/') || knownTopicSlugs.has(slug))) {
        const topicKey = makeTopicChannelKey(slug)
        if (topicKey) {
          return { key: topicKey, label: `#${slug}`, isTopic: true, bodyId: null, rawGh: null }
        }
      }
      const parsedEarth = parseCelestialChannelKey(raw)
      if (parsedEarth) {
        return {
          key: parsedEarth.geohash,
          label: `#${parsedEarth.geohash}`,
          isTopic: false,
          bodyId: 'earth' as GeohashableBodyId,
          rawGh: parsedEarth.geohash,
        }
      }
    }
    return null
  }, [searchDraft, knownTopicSlugs])

  const liveEntries = useMemo<HierarchyLiveEntry[]>(() => {
    const items: HierarchyLiveEntry[] = []
    const addRoom = (room: PulseRoom) => {
      const keyLower = room.geohash.toLowerCase()
      const isTopic = isTopicChannel(room.geohash)
      const slug = isTopic ? (getTopicSlug(room.geohash) ?? room.geohash) : null
      const parsed = isTopic ? null : parseCelestialChannelKey(room.geohash)
      const bodyDef = parsed && parsed.bodyId !== 'earth' ? getBodyDef(parsed.bodyId) : null
      const unread = (unreadCounts[keyLower] ?? 0) + (mentionCounts[keyLower] ?? 0)
      const subLabel = isTopic
        ? 'Asteroid'
        : bodyDef && parsed
          ? room.nearestCity ||
            findNearestCelestialLandmark(parsed.bodyId, room.center.lat, room.center.lon) ||
            bodyDef.name
          : room.nearestCity || formatCoords(room.center)

      items.push({
        channelKey: room.geohash,
        displayTag: isTopic ? `#${slug}` : `#${room.geohash}`,
        isTopic,
        bodyId: parsed?.bodyId ?? null,
        rawGeohash: parsed?.geohash ?? null,
        bodyColor: bodyDef?.palette.primary ?? null,
        bodyName: bodyDef?.name ?? null,
        subLabel,
        peerCount: room.peerCount,
        lastActivityAt: room.lastActivityAt,
        warmth: getWarmthTier(room.lastActivityAt, nowMs),
        unreadCount: unread,
        isPinned: pinnedKeySet.has(keyLower),
        snippetSender: room.lastSender?.trim().replace(/^@+/, '') || '',
        snippetText: room.lastPreview ? formatSnippet(room.lastPreview) : '',
      })
    }

    for (const room of celestialPulseRooms) addRoom(room)
    for (const room of topicPulseRooms) addRoom(room)

    items.sort((a, b) => {
      if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt
      return b.peerCount - a.peerCount
    })
    return items
  }, [celestialPulseRooms, topicPulseRooms, unreadCounts, mentionCounts, nowMs, pinnedKeySet])

  const pinnedEntries = useMemo<HierarchyLiveEntry[]>(() => {
    const items: HierarchyLiveEntry[] = pinnedChannels.map((pin) => {
      const keyLower = pin.geohash.toLowerCase()
      const room = liveRoomByKey.get(keyLower)
      const isTopic = isTopicChannel(pin.geohash)
      const slug = isTopic ? (getTopicSlug(pin.geohash) ?? pin.geohash) : null
      const parsed = isTopic ? null : parseCelestialChannelKey(pin.geohash)
      const bodyDef = parsed && parsed.bodyId !== 'earth' ? getBodyDef(parsed.bodyId) : null
      const unread = (unreadCounts[keyLower] ?? 0) + (mentionCounts[keyLower] ?? 0)

      let subLabel = pin.label?.replace(/^#/, '').trim() ?? ''
      if (isTopic) {
        subLabel = 'Asteroid'
      } else if (bodyDef) {
        const prefix = `${bodyDef.name} · `
        if (subLabel.toLowerCase() === bodyDef.name.toLowerCase()) {
          subLabel = bodyDef.name
        } else if (subLabel.startsWith(prefix)) {
          subLabel = subLabel.slice(prefix.length)
        } else if (!subLabel && parsed) {
          subLabel = getPlaceLabelForCelestial(parsed.bodyId, parsed.geohash)
        }
      } else if (!subLabel && parsed) {
        subLabel = room?.nearestCity || getPlaceLabelForCelestial('earth', parsed.geohash)
      }

      return {
        channelKey: pin.geohash,
        displayTag: isTopic ? `#${slug}` : `#${pin.geohash}`,
        isTopic,
        bodyId: parsed?.bodyId ?? null,
        rawGeohash: parsed?.geohash ?? null,
        bodyColor: bodyDef?.palette.primary ?? null,
        bodyName: bodyDef?.name ?? null,
        subLabel,
        peerCount: room?.peerCount ?? 0,
        lastActivityAt: room?.lastActivityAt ?? 0,
        warmth: room ? getWarmthTier(room.lastActivityAt, nowMs) : 'recent',
        unreadCount: unread,
        isPinned: true,
        snippetSender: room?.lastSender?.trim().replace(/^@+/, '') || '',
        snippetText: room?.lastPreview ? formatSnippet(room.lastPreview) : '',
      }
    })

    items.sort((a, b) => {
      if (b.unreadCount !== a.unreadCount) return b.unreadCount - a.unreadCount
      if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt
      return b.peerCount - a.peerCount
    })
    return items
  }, [pinnedChannels, liveRoomByKey, unreadCounts, mentionCounts, nowMs])

  const filteredPinnedEntries = useMemo(() => {
    if (!searchQuery) return pinnedEntries
    return pinnedEntries.filter(
      (item) =>
        item.displayTag.toLowerCase().includes(searchQuery) ||
        item.channelKey.toLowerCase().includes(searchQuery) ||
        item.subLabel.toLowerCase().includes(searchQuery) ||
        (item.bodyName?.toLowerCase().includes(searchQuery) ?? false),
    )
  }, [pinnedEntries, searchQuery])

  const filteredLiveEntries = useMemo(() => {
    if (!searchQuery) return liveEntries
    return liveEntries.filter(
      (item) =>
        item.displayTag.toLowerCase().includes(searchQuery) ||
        item.channelKey.toLowerCase().includes(searchQuery) ||
        item.subLabel.toLowerCase().includes(searchQuery) ||
        (item.bodyName?.toLowerCase().includes(searchQuery) ?? false) ||
        item.snippetText.toLowerCase().includes(searchQuery),
    )
  }, [liveEntries, searchQuery])

  const browseBodyDef = browseBodyId ? getBodyDef(browseBodyId) : null
  const browseParentBody =
    browseBodyDef &&
    browseBodyDef.kind === 'moon' &&
    browseBodyDef.parentId &&
    isGeohashableBodyId(browseBodyDef.parentId)
      ? getBodyDef(browseBodyDef.parentId)
      : null
  const browseMoonsHostId: GeohashableBodyId | null = browseBodyId
    ? browseParentBody && isGeohashableBodyId(browseParentBody.id)
      ? browseParentBody.id
      : browseBodyId
    : null
  const browseRelatedMoons = useMemo(
    () => (browseMoonsHostId ? getMoonsOfBody(browseMoonsHostId) : []),
    [browseMoonsHostId],
  )

  const currentRegionCanonical =
    browseBodyId && browsePrefix ? makeCelestialChannelKey(browseBodyId, browsePrefix) : null

  const currentRegionMeta = useMemo(() => {
    if (!browseBodyId || !browseBodyDef || !browsePrefix || !currentRegionCanonical) return null
    const bounds = decodeBounds(browsePrefix)
    const center = decodeCenter(browsePrefix)
    const precInfo = getPrecisionInfo(browsePrefix.length)
    const placeLabel = getPlaceLabelForCelestial(browseBodyId, browsePrefix)
    const dimensions = formatBodyCellDimensions(browseBodyDef, bounds)
    const exactRoom = liveRoomByKey.get(currentRegionCanonical.toLowerCase()) ?? null
    return {
      canonicalKey: currentRegionCanonical,
      precision: browsePrefix.length,
      precLabel: precInfo.label,
      placeLabel,
      coordsLabel: formatCoords(center),
      dimensions,
      exactRoom,
      isPinned: pinnedKeySet.has(currentRegionCanonical.toLowerCase()),
      isActive: currentRegionCanonical.toLowerCase() === activeGeohash.toLowerCase(),
    }
  }, [
    browseBodyId,
    browseBodyDef,
    browsePrefix,
    currentRegionCanonical,
    liveRoomByKey,
    pinnedKeySet,
    activeGeohash,
  ])

  const liveInCurrentRegion = useMemo(() => {
    if (!browseBodyId) return []
    return liveEntries.filter((entry) => {
      if (entry.bodyId !== browseBodyId || !entry.rawGeohash) return false
      if (!browsePrefix) return true
      return entry.rawGeohash.startsWith(browsePrefix)
    })
  }, [browseBodyId, browsePrefix, liveEntries])

  const childRegions = useMemo(() => {
    if (!browseBodyId || browsePrefix.length >= 9) return []
    const rawChildren = getChildGeohashes(browsePrefix)
    const worldLiveRooms = celestialPulseRooms.filter(
      (r) => getChannelBodyId(r.geohash) === browseBodyId,
    )
    const worldPins = pinnedChannels.filter((p) => getChannelBodyId(p.geohash) === browseBodyId)

    const items = rawChildren.map((cell) => {
      const canonicalKey = makeCelestialChannelKey(browseBodyId, cell.geohash) ?? cell.geohash
      let liveRoomCount = 0
      let totalPeers = 0
      let freshestActivityAt = 0
      let liveCityHint: string | null = null

      for (const room of worldLiveRooms) {
        const raw = getChannelRawGeohash(room.geohash)
        if (!raw || !raw.startsWith(cell.geohash)) continue
        liveRoomCount += 1
        totalPeers += room.peerCount
        if (room.lastActivityAt > freshestActivityAt) {
          freshestActivityAt = room.lastActivityAt
          if (room.nearestCity) liveCityHint = room.nearestCity
        }
      }

      let pinCount = 0
      let exactPinned = false
      for (const pin of worldPins) {
        const raw = getChannelRawGeohash(pin.geohash)
        if (!raw || !raw.startsWith(cell.geohash)) continue
        pinCount += 1
        if (raw === cell.geohash) exactPinned = true
      }

      const placeLabel =
        liveCityHint ||
        (browseBodyId === 'earth'
          ? (findNearestCityLabel(cell.center.lat, cell.center.lon, cell.geohash) ??
            formatCoords(cell.center))
          : (findNearestCelestialLandmark(browseBodyId, cell.center.lat, cell.center.lon) ??
            formatCoords(cell.center)))

      return {
        rawGeohash: cell.geohash,
        canonicalKey,
        precision: cell.precision,
        placeLabel,
        liveRoomCount,
        totalPeers,
        freshestActivityAt,
        warmth: freshestActivityAt > 0 ? getWarmthTier(freshestActivityAt, nowMs) : null,
        pinCount,
        exactPinned,
        isActive: canonicalKey.toLowerCase() === activeGeohash.toLowerCase(),
      }
    })

    const filtered = searchQuery
      ? items.filter(
          (c) =>
            c.rawGeohash.includes(searchQuery) ||
            c.canonicalKey.toLowerCase().includes(searchQuery) ||
            c.placeLabel.toLowerCase().includes(searchQuery),
        )
      : items

    filtered.sort((a, b) => {
      if (childSort === 'active') {
        const aLive = a.liveRoomCount > 0 ? 1 : 0
        const bLive = b.liveRoomCount > 0 ? 1 : 0
        if (bLive !== aLive) return bLive - aLive
        if (b.freshestActivityAt !== a.freshestActivityAt) {
          return b.freshestActivityAt - a.freshestActivityAt
        }
        if (b.totalPeers !== a.totalPeers) return b.totalPeers - a.totalPeers
        if (b.pinCount !== a.pinCount) return b.pinCount - a.pinCount
      }
      return a.rawGeohash.localeCompare(b.rawGeohash)
    })

    return filtered
  }, [
    browseBodyId,
    browsePrefix,
    celestialPulseRooms,
    pinnedChannels,
    nowMs,
    activeGeohash,
    searchQuery,
    childSort,
  ])

  const filteredNonEarthPlanets = useMemo(() => {
    const others = PLANET_BODY_IDS.filter((id) => id !== 'earth')
    if (!searchQuery) return others
    return others.filter((planetId) => {
      const def = getBodyDef(planetId)
      if (def.name.toLowerCase().includes(searchQuery) || planetId.includes(searchQuery)) {
        return true
      }
      return getMoonsOfBody(planetId).some(
        (m) => m.name.toLowerCase().includes(searchQuery) || m.id.includes(searchQuery),
      )
    })
  }, [searchQuery])

  const showEarthInSolarRoot = useMemo(() => {
    if (!searchQuery) return true
    if ('earth'.includes(searchQuery) || 'moon'.includes(searchQuery) || 'luna'.includes(searchQuery)) {
      return true
    }
    return false
  }, [searchQuery])

  const earthMoons = useMemo(() => getMoonsOfBody('earth'), [])
  const earthBodyDef = getBodyDef('earth')

  // Asteroids tab lists
  const pinnedTopicEntries = useMemo(
    () => pinnedEntries.filter((e) => e.isTopic),
    [pinnedEntries],
  )
  const pinnedTopicKeySet = useMemo(
    () => new Set(pinnedTopics.map((p) => p.geohash.toLowerCase())),
    [pinnedTopics],
  )
  const liveTopicEntries = useMemo(
    () => liveEntries.filter((e) => e.isTopic && !pinnedTopicKeySet.has(e.channelKey.toLowerCase())),
    [liveEntries, pinnedTopicKeySet],
  )
  const shownTopicKeySet = useMemo(() => {
    const set = new Set<string>(pinnedTopicKeySet)
    for (const item of liveTopicEntries) set.add(item.channelKey.toLowerCase())
    return set
  }, [pinnedTopicKeySet, liveTopicEntries])

  const filteredPinnedTopics = useMemo(() => {
    if (!searchQuery) return pinnedTopicEntries
    return pinnedTopicEntries.filter(
      (e) =>
        e.displayTag.toLowerCase().includes(searchQuery) ||
        e.snippetText.toLowerCase().includes(searchQuery),
    )
  }, [pinnedTopicEntries, searchQuery])

  const filteredLiveTopics = useMemo(() => {
    if (!searchQuery) return liveTopicEntries
    return liveTopicEntries.filter(
      (e) =>
        e.displayTag.toLowerCase().includes(searchQuery) ||
        e.snippetText.toLowerCase().includes(searchQuery),
    )
  }, [liveTopicEntries, searchQuery])

  const filteredPopularTopics = useMemo(() => {
    return POPULAR_TOPIC_CHANNELS.filter((c) => {
      const key = makeTopicChannelKey(c.slug)
      if (!key || shownTopicKeySet.has(key)) return false
      if (!searchQuery) return true
      return (
        c.slug.toLowerCase().includes(searchQuery) ||
        c.label.toLowerCase().includes(searchQuery) ||
        c.description.toLowerCase().includes(searchQuery)
      )
    })
  }, [shownTopicKeySet, searchQuery])

  const handleTune = (channelKey: string) => {
    onPlaySound?.('tune')
    onTuneChannel(channelKey)
    if (!embedded) {
      onClose()
    }
  }

  const handleOpenInTree = (bodyId: GeohashableBodyId, prefix = '') => {
    onPlaySound?.('click')
    setActiveTab('worlds')
    setBrowseBodyId(bodyId)
    setBrowsePrefix(prefix)
    setSearchError(null)
  }

  const handleLocateMe = async () => {
    onPlaySound?.('click')
    const gh = await engine.locateMe()
    if (gh) {
      onPlaySound?.('tune')
      setActiveTab('worlds')
      setBrowseBodyId('earth')
      setBrowsePrefix(gh)
      setSearchDraft('')
      setSearchError(null)
    }
  }

  const handleSearchSubmit = (e: FormEvent) => {
    e.preventDefault()
    const raw = searchDraft.trim()
    if (!raw) return
    setSearchError(null)

    // 1. World / planet / moon name
    const bodyMatch = resolveBodyQuery(raw)
    if (bodyMatch) {
      setSearchDraft('')
      handleOpenInTree(bodyMatch, '')
      return
    }

    // 2. Explicit topic (`#topic:bitcoin`, `topic:nostr`, `/dev`)
    if (/^#?topic:/i.test(raw) || raw.startsWith('/')) {
      const topicKey = makeTopicChannelKey(raw)
      if (topicKey) {
        setSearchDraft('')
        handleTune(topicKey)
        return
      }
    }

    // 3. Celestial non-Earth geohash (`#mars:s000`, `europa:9q8y`)
    if (raw.includes(':')) {
      const parsedCel = parseCelestialChannelKey(raw.replace(/^#/, ''))
      if (parsedCel) {
        setSearchDraft('')
        handleOpenInTree(parsedCel.bodyId, parsedCel.geohash)
        return
      }
    }

    // 4. Known topic asteroid slug
    const strippedSlug = normalizeTopicSlug(raw)
    if (strippedSlug && knownTopicSlugs.has(strippedSlug)) {
      const topicKey = makeTopicChannelKey(strippedSlug)
      if (topicKey) {
        setSearchDraft('')
        handleTune(topicKey)
        return
      }
    }

    // 5. Earth geohash / city / coordinates
    const resolved = parseQuickTuneInput(raw, 'geo')
    if (resolved) {
      if (isTopicChannel(resolved.key)) {
        setSearchDraft('')
        handleTune(resolved.key)
        return
      }
      const parsed = parseCelestialChannelKey(resolved.key)
      if (parsed) {
        setSearchDraft('')
        handleOpenInTree(parsed.bodyId, parsed.geohash)
        return
      }
    }

    setSearchError('No matching world, city, #geohash, or #topic')
  }

  const handleTopicSubmit = (e: FormEvent) => {
    e.preventDefault()
    const raw = topicDraft.trim()
    if (!raw) return
    const topicKey = makeTopicChannelKey(raw)
    if (!topicKey) {
      setTopicError('Use letters, numbers, - or _ (e.g. #nostr)')
      return
    }
    setTopicDraft('')
    setTopicError(null)
    handleTune(topicKey)
  }

  const handleTogglePinEntry = (channelKey: string, label?: string) => {
    onPlaySound?.('click')
    engine.togglePinChannel(channelKey, label)
  }

  const renderChannelRow = (entry: HierarchyLiveEntry, showBrowse: boolean) => {
    const isAlreadyActive = entry.channelKey.toLowerCase() === activeGeohash.toLowerCase()
    const ageLabel =
      entry.lastActivityAt > 0 ? formatCompactAge(entry.lastActivityAt, nowMs) : null
    const pinLabel = entry.isTopic
      ? entry.displayTag
      : entry.bodyName && entry.subLabel && entry.subLabel !== entry.bodyName
        ? `${entry.bodyName} · ${entry.subLabel}`
        : entry.subLabel || entry.bodyName || undefined

    return (
      <div
        key={entry.channelKey}
        className={`ag-hier-row${isAlreadyActive ? ' is-active' : ''}`}
      >
        <div className="ag-hier-row-info">
          <div className="ag-hier-row-head">
            {entry.lastActivityAt > 0 ? (
              <span
                className={`ag-radar-warmth-dot is-${entry.warmth}`}
                aria-hidden="true"
              />
            ) : entry.isPinned ? (
              <Pin size={11} className="ag-radar-pin-icon-red" aria-hidden="true" />
            ) : null}

            {entry.bodyColor && (
              <span
                className="ag-radar-world-dot"
                style={{ backgroundColor: entry.bodyColor }}
                aria-hidden="true"
              />
            )}

            <span className={`ag-hier-row-tag mono${entry.isTopic ? ' is-topic' : ''}`}>
              {entry.displayTag}
            </span>

            {entry.bodyName && (
              <span className="ag-hier-world-chip">{entry.bodyName}</span>
            )}

            {entry.subLabel && entry.subLabel !== entry.bodyName && (
              <span className="ag-hier-row-sub truncate">{entry.subLabel}</span>
            )}

            {entry.unreadCount > 0 && (
              <span className="ag-radar-live-dock-unread mono tabular">
                {entry.unreadCount > 99 ? '99+' : entry.unreadCount}
              </span>
            )}
          </div>

          <div className="ag-hier-row-meta mono tabular">
            {entry.peerCount > 0 && (
              <span>
                {entry.peerCount} {entry.peerCount === 1 ? 'peer' : 'peers'}
              </span>
            )}
            {ageLabel && (
              <>
                {entry.peerCount > 0 && <span aria-hidden="true">·</span>}
                <span>{ageLabel}</span>
              </>
            )}
            {entry.snippetText && (
              <>
                {(entry.peerCount > 0 || ageLabel) && <span aria-hidden="true">·</span>}
                <span className="ag-hier-row-snippet truncate">
                  {entry.snippetSender ? `${entry.snippetSender}: ` : ''}
                  {entry.snippetText}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="ag-hier-row-actions">
          {showBrowse && entry.bodyId && entry.rawGeohash && (
            <button
              type="button"
              className="ag-hier-btn-ghost"
              onClick={() => handleOpenInTree(entry.bodyId!, entry.rawGeohash!)}
              title={`Browse ${entry.displayTag} in region hierarchy`}
            >
              <span>Tree</span>
              <ChevronRight size={13} aria-hidden="true" />
            </button>
          )}

          <button
            type="button"
            className={`ag-hier-pin-btn${entry.isPinned ? ' is-pinned' : ''}`}
            onClick={() => handleTogglePinEntry(entry.channelKey, pinLabel)}
            aria-label={entry.isPinned ? `Unpin ${entry.displayTag}` : `Pin ${entry.displayTag}`}
            title={entry.isPinned ? 'Unpin' : 'Pin'}
          >
            {entry.isPinned ? (
              <PinOff size={13} className="ag-radar-pin-icon-red" />
            ) : (
              <Pin size={13} className="ag-radar-pin-icon-red" />
            )}
          </button>

          <button
            type="button"
            className={`ag-hier-tune-btn${isAlreadyActive ? ' is-active' : ''}`}
            onClick={() => handleTune(entry.channelKey)}
          >
            {isAlreadyActive ? (
              <>
                <Check size={13} aria-hidden="true" />
                <span>{embedded ? 'Open' : 'Active'}</span>
              </>
            ) : (
              <>
                <span>Tune In</span>
                <ArrowUpRight size={13} aria-hidden="true" />
              </>
            )}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="ag-hier-shell" data-bitchat-hierarchy="true">
      {/* Top Header Bar: Breadcrumbs, View Mode / 3D Switch, Search & Section Tabs */}
      <header className="ag-hier-header">
        <div className="ag-hier-header-top">
          <nav className="ag-hier-breadcrumbs" aria-label="Bitchat hierarchy breadcrumbs">
            <button
              type="button"
              className={`ag-hier-crumb${
                activeTab === 'worlds' && browseBodyId === null ? ' is-current' : ''
              }`}
              onClick={() => {
                onPlaySound?.('click')
                setActiveTab('worlds')
                setBrowseBodyId(null)
                setBrowsePrefix('')
              }}
            >
              <Orbit size={13} aria-hidden="true" />
              <span>Solar System</span>
            </button>

            {activeTab === 'live' && (
              <>
                <ChevronRight size={12} className="ag-hier-crumb-sep" aria-hidden="true" />
                <span className="ag-hier-crumb is-current">Live &amp; Pinned</span>
              </>
            )}

            {activeTab === 'asteroids' && (
              <>
                <ChevronRight size={12} className="ag-hier-crumb-sep" aria-hidden="true" />
                <span className="ag-hier-crumb is-current">Topic Asteroids</span>
              </>
            )}

            {activeTab === 'worlds' && browseParentBody && (
              <>
                <ChevronRight size={12} className="ag-hier-crumb-sep" aria-hidden="true" />
                <button
                  type="button"
                  className="ag-hier-crumb"
                  onClick={() => {
                    if (isGeohashableBodyId(browseParentBody.id)) {
                      handleOpenInTree(browseParentBody.id, '')
                    }
                  }}
                >
                  <span
                    className="ag-radar-world-dot"
                    style={{ backgroundColor: browseParentBody.palette.primary }}
                    aria-hidden="true"
                  />
                  <span>{browseParentBody.name}</span>
                </button>
              </>
            )}

            {activeTab === 'worlds' && browseBodyDef && browseBodyId && (
              <>
                <ChevronRight size={12} className="ag-hier-crumb-sep" aria-hidden="true" />
                <button
                  type="button"
                  className={`ag-hier-crumb${browsePrefix === '' ? ' is-current' : ''}`}
                  onClick={() => handleOpenInTree(browseBodyId, '')}
                >
                  <span
                    className="ag-radar-world-dot"
                    style={{ backgroundColor: browseBodyDef.palette.primary }}
                    aria-hidden="true"
                  />
                  <span>{browseBodyDef.name}</span>
                </button>

                {Array.from({ length: browsePrefix.length }, (_, idx) => {
                  const step = browsePrefix.slice(0, idx + 1)
                  const isCurrent = idx === browsePrefix.length - 1
                  return (
                    <span key={step} className="ag-hier-crumb-group">
                      <ChevronRight size={12} className="ag-hier-crumb-sep" aria-hidden="true" />
                      <button
                        type="button"
                        className={`ag-hier-crumb mono${isCurrent ? ' is-current' : ''}`}
                        onClick={() => {
                          onPlaySound?.('click')
                          setBrowsePrefix(step)
                        }}
                      >
                        #{step}
                      </button>
                    </span>
                  )
                })}
              </>
            )}
          </nav>

          <div className="ag-hier-header-actions">
            {webglAvailable && onSwitchToGlobe ? (
              <button
                type="button"
                className="ag-hier-globe-btn"
                onClick={onSwitchToGlobe}
                title="Switch back to 3D Globe"
              >
                <Globe size={14} aria-hidden="true" />
                <span>3D Globe</span>
              </button>
            ) : (
              <span
                className="ag-hier-mode-badge mono"
                title="3D rendering is unavailable on this browser — using fast hierarchical view"
              >
                <ListTree size={13} aria-hidden="true" />
                <span>Hierarchy View · 3D unavailable</span>
              </span>
            )}

            {!embedded && (
              <button
                type="button"
                className="ag-hier-close-btn"
                onClick={onClose}
                aria-label="Close channel hierarchy"
                title="Close (Esc)"
              >
                <X size={17} />
              </button>
            )}
          </div>
        </div>

        <div className="ag-hier-toolbar">
          <div className="ag-hier-tabs" role="tablist" aria-label="Bitchat hierarchy sections">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'live'}
              className={`ag-hier-tab${activeTab === 'live' ? ' active' : ''}`}
              onClick={() => {
                onPlaySound?.('click')
                setActiveTab('live')
              }}
            >
              <span
                className={`ag-radar-warmth-dot ${totalLiveCount > 0 ? 'is-hot' : 'is-recent'}`}
                aria-hidden="true"
              />
              <span>Live &amp; Pinned</span>
              <span className="ag-hier-tab-count mono tabular">
                {totalLiveCount + pinnedChannels.length}
              </span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'worlds'}
              className={`ag-hier-tab${activeTab === 'worlds' ? ' active' : ''}`}
              onClick={() => {
                onPlaySound?.('click')
                setActiveTab('worlds')
              }}
            >
              <Orbit size={13} aria-hidden="true" />
              <span>Worlds</span>
              <span className="ag-hier-tab-count mono tabular">
                {GEOHASHABLE_BODY_IDS.length}
              </span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'asteroids'}
              className={`ag-hier-tab${activeTab === 'asteroids' ? ' active' : ''}`}
              onClick={() => {
                onPlaySound?.('click')
                setActiveTab('asteroids')
              }}
            >
              <Hash size={13} aria-hidden="true" />
              <span>Asteroids</span>
              <span className="ag-hier-tab-count mono tabular">{allTopicCount}</span>
            </button>
          </div>

          <form className="ag-hier-search-form" onSubmit={handleSearchSubmit}>
            <Search size={14} className="ag-hier-search-icon" aria-hidden="true" />
            <input
              type="text"
              className="ag-hier-search-input mono"
              placeholder="#dr5r, #mars:s000, #topic:bitcoin, or filter…"
              value={searchDraft}
              onChange={(e) => {
                setSearchDraft(e.target.value)
                if (searchError) setSearchError(null)
              }}
              aria-label="Search or quick-tune geohash, world, city, or topic"
            />
            {searchDraft && (
              <button
                type="button"
                className="ag-hier-search-clear"
                onClick={() => {
                  setSearchDraft('')
                  setSearchError(null)
                }}
                aria-label="Clear search"
              >
                <X size={13} />
              </button>
            )}
            {searchDraft && (
              <button type="submit" className="ag-hier-search-go mono">
                GO
              </button>
            )}
          </form>
        </div>

        {directTuneMatch && (
          <div className="ag-hier-direct-bar">
            <span className="ag-hier-direct-text">
              Quick jump: <strong className="mono">{directTuneMatch.label}</strong>
            </span>
            <div className="ag-hier-direct-actions">
              {directTuneMatch.bodyId && directTuneMatch.rawGh && (
                <button
                  type="button"
                  className="ag-hier-btn-ghost"
                  onClick={() => {
                    setSearchDraft('')
                    handleOpenInTree(directTuneMatch.bodyId!, directTuneMatch.rawGh!)
                  }}
                >
                  <span>Browse Region</span>
                  <ChevronRight size={13} />
                </button>
              )}
              <button
                type="button"
                className="ag-hier-tune-btn"
                onClick={() => {
                  setSearchDraft('')
                  handleTune(directTuneMatch.key)
                }}
              >
                <span>Tune {directTuneMatch.label}</span>
                <ArrowUpRight size={13} />
              </button>
            </div>
          </div>
        )}

        {searchError && (
          <div className="ag-hier-error" role="status">
            {searchError}
          </div>
        )}
      </header>

      {/* Main Scrollable Hierarchy Content */}
      <div className="ag-hier-scroll">
        {/* TAB 1: LIVE & PINNED */}
        {activeTab === 'live' && (
          <div className="ag-hier-pane">
            {filteredPinnedEntries.length > 0 && (
              <section className="ag-hier-section" aria-label="Pinned channels">
                <div className="ag-hier-section-head">
                  <span className="ag-hier-section-title">
                    <Pin size={13} className="ag-radar-pin-icon-red" aria-hidden="true" />
                    <span>Pinned Channels</span>
                    <span className="ag-hier-section-count mono tabular">
                      {filteredPinnedEntries.length}
                    </span>
                  </span>
                </div>
                <div className="ag-hier-list">
                  {filteredPinnedEntries.map((entry) => renderChannelRow(entry, true))}
                </div>
              </section>
            )}

            <section className="ag-hier-section" aria-label="Active now channels">
              <div className="ag-hier-section-head">
                <span className="ag-hier-section-title">
                  <span
                    className={`ag-radar-warmth-dot ${totalLiveCount > 0 ? 'is-hot' : 'is-recent'}`}
                    aria-hidden="true"
                  />
                  <span>Active Now</span>
                  <span className="ag-hier-section-count mono tabular">
                    {filteredLiveEntries.length}
                  </span>
                </span>
              </div>

              {filteredLiveEntries.length === 0 ? (
                <div className="ag-hier-empty-card">
                  <p className="ag-hier-empty-text">
                    {searchQuery
                      ? `No active channels match “${searchDraft.trim()}”.`
                      : 'Listening across global relays for active Earth, planetary, and topic asteroid channels…'}
                  </p>
                  <button
                    type="button"
                    className="ag-hier-btn-secondary"
                    onClick={() => {
                      onPlaySound?.('click')
                      setActiveTab('worlds')
                    }}
                  >
                    <Orbit size={14} aria-hidden="true" />
                    <span>Browse Worlds &amp; Regions</span>
                  </button>
                </div>
              ) : (
                <div className="ag-hier-list">
                  {filteredLiveEntries.map((entry) => renderChannelRow(entry, true))}
                </div>
              )}
            </section>
          </div>
        )}

        {/* TAB 2: WORLDS (Solar System -> Planet/Moon -> P1-P9 Geohash Tree) */}
        {activeTab === 'worlds' && browseBodyId === null && (
          <div className="ag-hier-pane">
            {/* Featured Earth Card */}
            {showEarthInSolarRoot && (
              <section className="ag-hier-earth-card" aria-label="Earth">
                <div className="ag-hier-earth-top">
                  <div className="ag-hier-earth-identity">
                    <span
                      className="ag-hier-planet-orb is-earth"
                      style={{ backgroundColor: earthBodyDef.palette.primary }}
                      aria-hidden="true"
                    />
                    <div className="ag-hier-earth-titles">
                      <div className="ag-hier-earth-name-row">
                        <h3 className="ag-hier-earth-name">Earth</h3>
                        <span className="ag-hier-world-chip">Home World</span>
                        {(liveCountByBody.earth ?? 0) > 0 && (
                          <span className="ag-hier-live-badge mono tabular">
                            <span className="ag-radar-warmth-dot is-hot" aria-hidden="true" />
                            <span>{liveCountByBody.earth} live</span>
                          </span>
                        )}
                        {(pinCountByBody.earth ?? 0) > 0 && (
                          <span className="ag-radar-solar-pin-badge mono tabular">
                            <Pin size={9} aria-hidden="true" />
                            <span>{pinCountByBody.earth}</span>
                          </span>
                        )}
                      </div>
                      <p className="ag-hier-earth-sub">
                        32 continental regions (P1) drilling down to block &amp; spot level (P9)
                        {location.localGeohashes[4] ? (
                          <span className="mono"> · Near #{location.localGeohashes[4]}</span>
                        ) : null}
                      </p>
                    </div>
                  </div>

                  <div className="ag-hier-earth-actions">
                    <button
                      type="button"
                      className="ag-hier-btn-secondary"
                      onClick={() => void handleLocateMe()}
                      disabled={location.status === 'locating'}
                    >
                      {location.status === 'locating' ? (
                        <Loader2 size={14} className="ag-spin" aria-hidden="true" />
                      ) : (
                        <Crosshair size={14} aria-hidden="true" />
                      )}
                      <span>Locate Me</span>
                    </button>

                    <button
                      type="button"
                      className="ag-hier-tune-btn"
                      onClick={() => handleOpenInTree('earth', '')}
                    >
                      <span>Browse Earth Regions</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {earthMoons.length > 0 && (
                  <div className="ag-hier-moons-bar">
                    <span className="ag-hier-moons-label">Moon</span>
                    {earthMoons.map((moon) => {
                      const moonId = moon.id as GeohashableBodyId
                      const mLive = liveCountByBody[moonId] ?? 0
                      const mPins = pinCountByBody[moonId] ?? 0
                      return (
                        <button
                          key={moon.id}
                          type="button"
                          className="ag-hier-moon-chip"
                          onClick={() => handleOpenInTree(moonId, '')}
                        >
                          <span
                            className="ag-radar-world-dot"
                            style={{ backgroundColor: moon.palette.primary }}
                            aria-hidden="true"
                          />
                          <span>{moon.name}</span>
                          {mLive > 0 && (
                            <span className="ag-hier-chip-live mono tabular">{mLive}</span>
                          )}
                          {mPins > 0 && (
                            <span className="ag-hier-chip-pin mono tabular">{mPins}</span>
                          )}
                          <ChevronRight size={12} aria-hidden="true" />
                        </button>
                      )
                    })}
                  </div>
                )}
              </section>
            )}

            {/* Solar System Planets & Moons */}
            <section className="ag-hier-section" aria-label="Solar System planets and moons">
              <div className="ag-hier-section-head">
                <span className="ag-hier-section-title">
                  <Orbit size={13} aria-hidden="true" />
                  <span>Solar System Planets &amp; Moons</span>
                  <span className="ag-hier-section-count mono tabular">
                    {filteredNonEarthPlanets.length}
                  </span>
                </span>
              </div>

              {filteredNonEarthPlanets.length === 0 ? (
                <div className="ag-hier-empty-card">
                  <p className="ag-hier-empty-text">
                    No planets or moons match “{searchDraft.trim()}”.
                  </p>
                </div>
              ) : (
                <div className="ag-hier-planets-grid">
                  {filteredNonEarthPlanets.map((planetId) => {
                    const planet = getBodyDef(planetId)
                    const moons = getMoonsOfBody(planetId)
                    const pLive = liveCountByBody[planetId] ?? 0
                    const pPins = pinCountByBody[planetId] ?? 0
                    return (
                      <div key={planetId} className="ag-hier-planet-card">
                        <div className="ag-hier-planet-row">
                          <div className="ag-hier-planet-main">
                            <span
                              className={`ag-radar-planet-dot${planet.rings ? ' has-rings' : ''}`}
                              style={{ backgroundColor: planet.palette.primary }}
                              aria-hidden="true"
                            />
                            <div className="ag-hier-planet-info">
                              <div className="ag-hier-planet-name-line">
                                <span className="ag-hier-planet-name">{planet.name}</span>
                                {pLive > 0 && (
                                  <span className="ag-hier-live-badge mono tabular">
                                    <span className="ag-radar-warmth-dot is-hot" aria-hidden="true" />
                                    <span>{pLive}</span>
                                  </span>
                                )}
                                {pPins > 0 && (
                                  <span className="ag-radar-solar-pin-badge mono tabular">
                                    <Pin size={9} aria-hidden="true" />
                                    <span>{pPins}</span>
                                  </span>
                                )}
                              </div>
                              <span className="ag-hier-planet-meta mono">
                                r={Math.round(planet.realRadiusKm).toLocaleString('en-US')} km
                                {moons.length > 0
                                  ? ` · ${moons.length} ${moons.length === 1 ? 'moon' : 'moons'}`
                                  : ''}
                              </span>
                            </div>
                          </div>

                          <button
                            type="button"
                            className="ag-hier-btn-secondary ag-hier-browse-btn"
                            onClick={() => handleOpenInTree(planetId, '')}
                          >
                            <span>Browse</span>
                            <ChevronRight size={13} aria-hidden="true" />
                          </button>
                        </div>

                        {moons.length > 0 && (
                          <div className="ag-hier-moons-bar">
                            <span className="ag-hier-moons-label">Moons</span>
                            {moons.map((moon) => {
                              const moonId = moon.id as GeohashableBodyId
                              const mLive = liveCountByBody[moonId] ?? 0
                              const mPins = pinCountByBody[moonId] ?? 0
                              return (
                                <button
                                  key={moon.id}
                                  type="button"
                                  className="ag-hier-moon-chip"
                                  onClick={() => handleOpenInTree(moonId, '')}
                                >
                                  <span
                                    className="ag-radar-world-dot"
                                    style={{ backgroundColor: moon.palette.primary }}
                                    aria-hidden="true"
                                  />
                                  <span>{moon.name}</span>
                                  {mLive > 0 && (
                                    <span className="ag-hier-chip-live mono tabular">{mLive}</span>
                                  )}
                                  {mPins > 0 && (
                                    <span className="ag-hier-chip-pin mono tabular">{mPins}</span>
                                  )}
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          </div>
        )}

        {/* TAB 2 (DRILLED): WORLD / P1-P9 GEOHASH TREE */}
        {activeTab === 'worlds' && browseBodyId !== null && browseBodyDef && (
          <div className="ag-hier-pane">
            {/* Current World or Region Summary Card */}
            {currentRegionMeta ? (
              <section className="ag-hier-region-card" aria-label="Selected region details">
                <div className="ag-hier-region-top">
                  <div className="ag-hier-region-identity">
                    <div className="ag-hier-region-title-row">
                      {browseBodyId === 'earth' ? (
                        <MapPin size={15} className="ag-radar-hud-accent" aria-hidden="true" />
                      ) : (
                        <span
                          className="ag-radar-world-dot ag-radar-world-dot-md"
                          style={{ backgroundColor: browseBodyDef.palette.primary }}
                          aria-hidden="true"
                        />
                      )}
                      <h3 className="ag-hier-region-hash mono">
                        #{currentRegionMeta.canonicalKey}
                      </h3>
                      <span className="ag-hier-prec-badge mono">
                        P{currentRegionMeta.precision} · {currentRegionMeta.precLabel}
                      </span>
                      <span className="ag-hier-size-badge mono">
                        {currentRegionMeta.dimensions}
                      </span>
                    </div>

                    <div className="ag-hier-region-sub">
                      <span>{currentRegionMeta.placeLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span className="mono">{currentRegionMeta.coordsLabel}</span>
                    </div>

                    {currentRegionMeta.exactRoom && (
                      <div className="ag-hier-region-live-note">
                        <span
                          className={`ag-radar-warmth-dot is-${getWarmthTier(
                            currentRegionMeta.exactRoom.lastActivityAt,
                            nowMs,
                          )}`}
                          aria-hidden="true"
                        />
                        <span className="mono tabular">
                          {currentRegionMeta.exactRoom.peerCount}{' '}
                          {currentRegionMeta.exactRoom.peerCount === 1 ? 'peer' : 'peers'} ·{' '}
                          {formatCompactAge(currentRegionMeta.exactRoom.lastActivityAt, nowMs)}
                        </span>
                        {currentRegionMeta.exactRoom.lastPreview && (
                          <span className="truncate">
                            — {formatSnippet(currentRegionMeta.exactRoom.lastPreview)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="ag-hier-region-actions">
                    <button
                      type="button"
                      className="ag-hier-btn-secondary"
                      onClick={() => {
                        onPlaySound?.('click')
                        setBrowsePrefix((prev) => prev.slice(0, -1))
                      }}
                    >
                      <ArrowUp size={14} aria-hidden="true" />
                      <span>
                        {currentRegionMeta.precision > 1
                          ? `Up (P${currentRegionMeta.precision - 1})`
                          : `All ${browseBodyDef.name} P1`}
                      </span>
                    </button>

                    <button
                      type="button"
                      className={`ag-hier-btn-secondary ag-hier-region-pin${
                        currentRegionMeta.isPinned ? ' is-pinned' : ''
                      }`}
                      onClick={() => {
                        const label =
                          browseBodyId === 'earth'
                            ? currentRegionMeta.placeLabel
                            : `${browseBodyDef.name} · ${currentRegionMeta.placeLabel}`
                        handleTogglePinEntry(currentRegionMeta.canonicalKey, label)
                      }}
                      aria-pressed={currentRegionMeta.isPinned}
                    >
                      {currentRegionMeta.isPinned ? (
                        <PinOff size={14} className="ag-radar-pin-icon-red" aria-hidden="true" />
                      ) : (
                        <Pin size={14} className="ag-radar-pin-icon-red" aria-hidden="true" />
                      )}
                      <span>{currentRegionMeta.isPinned ? 'Pinned' : 'Pin'}</span>
                    </button>

                    <button
                      type="button"
                      className="ag-hier-tune-btn"
                      onClick={() => handleTune(currentRegionMeta.canonicalKey)}
                    >
                      {currentRegionMeta.isActive ? (
                        <>
                          <Check size={14} aria-hidden="true" />
                          <span>{embedded ? 'Open Chat' : 'Active'}</span>
                        </>
                      ) : (
                        <>
                          <span>Tune In</span>
                          <ArrowUpRight size={14} aria-hidden="true" />
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </section>
            ) : (
              <section className="ag-hier-region-card" aria-label={`${browseBodyDef.name} overview`}>
                <div className="ag-hier-region-top">
                  <div className="ag-hier-region-identity">
                    <div className="ag-hier-region-title-row">
                      <span
                        className={`ag-radar-planet-dot${browseBodyDef.rings ? ' has-rings' : ''}`}
                        style={{ backgroundColor: browseBodyDef.palette.primary }}
                        aria-hidden="true"
                      />
                      <h3 className="ag-hier-region-hash">{browseBodyDef.name}</h3>
                      <span className="ag-hier-prec-badge mono">P1 Root · 32 Regions</span>
                      {(liveCountByBody[browseBodyId] ?? 0) > 0 && (
                        <span className="ag-hier-live-badge mono tabular">
                          <span className="ag-radar-warmth-dot is-hot" aria-hidden="true" />
                          <span>{liveCountByBody[browseBodyId]} live</span>
                        </span>
                      )}
                    </div>
                    <div className="ag-hier-region-sub">
                      <span>
                        Select any regional geohash below to drill down (P1 → P9) or join directly.
                      </span>
                    </div>
                  </div>

                  <div className="ag-hier-region-actions">
                    <button
                      type="button"
                      className="ag-hier-btn-secondary"
                      onClick={() => {
                        onPlaySound?.('click')
                        setBrowseBodyId(null)
                        setBrowsePrefix('')
                      }}
                    >
                      <ArrowLeft size={14} aria-hidden="true" />
                      <span>Solar System</span>
                    </button>

                    {browseBodyId === 'earth' && (
                      <button
                        type="button"
                        className="ag-hier-btn-secondary"
                        onClick={() => void handleLocateMe()}
                        disabled={location.status === 'locating'}
                      >
                        {location.status === 'locating' ? (
                          <Loader2 size={14} className="ag-spin" aria-hidden="true" />
                        ) : (
                          <Crosshair size={14} aria-hidden="true" />
                        )}
                        <span>Locate Me</span>
                      </button>
                    )}
                  </div>
                </div>

                {(browseParentBody || browseRelatedMoons.length > 0) && (
                  <div className="ag-hier-moons-bar">
                    <span className="ag-hier-moons-label">System</span>
                    {browseParentBody && isGeohashableBodyId(browseParentBody.id) && (
                      <button
                        type="button"
                        className="ag-hier-moon-chip"
                        onClick={() =>
                          handleOpenInTree(browseParentBody.id as GeohashableBodyId, '')
                        }
                      >
                        <span
                          className="ag-radar-world-dot"
                          style={{ backgroundColor: browseParentBody.palette.primary }}
                          aria-hidden="true"
                        />
                        <span>{browseParentBody.name}</span>
                      </button>
                    )}
                    {browseRelatedMoons.map((moon) => {
                      const moonId = moon.id as GeohashableBodyId
                      const isCurr = moonId === browseBodyId
                      return (
                        <button
                          key={moon.id}
                          type="button"
                          className={`ag-hier-moon-chip${isCurr ? ' active' : ''}`}
                          onClick={() => handleOpenInTree(moonId, '')}
                        >
                          <span
                            className="ag-radar-world-dot"
                            style={{ backgroundColor: moon.palette.primary }}
                            aria-hidden="true"
                          />
                          <span>{moon.name}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </section>
            )}

            {/* Live in This Region Strip (surfaces deep active rooms immediately) */}
            {liveInCurrentRegion.length > 0 && (
              <section className="ag-hier-section" aria-label="Live rooms in this region">
                <div className="ag-hier-section-head">
                  <span className="ag-hier-section-title">
                    <span className="ag-radar-warmth-dot is-hot" aria-hidden="true" />
                    <span>
                      Live in{' '}
                      {currentRegionCanonical ? `#${currentRegionCanonical}` : browseBodyDef.name}
                    </span>
                    <span className="ag-hier-section-count mono tabular">
                      {liveInCurrentRegion.length}
                    </span>
                  </span>
                </div>
                <div className="ag-hier-list">
                  {liveInCurrentRegion.slice(0, 8).map((entry) =>
                    renderChannelRow(entry, Boolean(entry.rawGeohash && entry.rawGeohash !== browsePrefix)),
                  )}
                </div>
              </section>
            )}

            {/* 32 Child Sub-Regions (P1..P9) */}
            {browsePrefix.length < 9 ? (
              <section className="ag-hier-section" aria-label="Sub-regions">
                <div className="ag-hier-section-head">
                  <span className="ag-hier-section-title">
                    <MapPin size={13} className="ag-radar-hud-accent" aria-hidden="true" />
                    <span>
                      32 Sub-Regions · P{browsePrefix.length + 1} (
                      {getPrecisionInfo(browsePrefix.length + 1).label})
                    </span>
                  </span>

                  <div className="ag-hier-sort-group" role="group" aria-label="Sort sub-regions">
                    <button
                      type="button"
                      className={`ag-hier-sort-btn${childSort === 'active' ? ' active' : ''}`}
                      onClick={() => {
                        onPlaySound?.('click')
                        setChildSort('active')
                      }}
                    >
                      Active first
                    </button>
                    <button
                      type="button"
                      className={`ag-hier-sort-btn${childSort === 'az' ? ' active' : ''}`}
                      onClick={() => {
                        onPlaySound?.('click')
                        setChildSort('az')
                      }}
                    >
                      A–Z
                    </button>
                  </div>
                </div>

                {childRegions.length === 0 ? (
                  <div className="ag-hier-empty-card">
                    <p className="ag-hier-empty-text">
                      No sub-regions match “{searchDraft.trim()}”.
                    </p>
                  </div>
                ) : (
                  <div className="ag-hier-children-grid">
                    {childRegions.map((child) => (
                      <div
                        key={child.canonicalKey}
                        className={`ag-hier-child-card${child.liveRoomCount > 0 ? ' has-live' : ''}${
                          child.isActive ? ' is-active' : ''
                        }`}
                      >
                        <div className="ag-hier-child-info">
                          <div className="ag-hier-child-head">
                            {child.warmth && (
                              <span
                                className={`ag-radar-warmth-dot is-${child.warmth}`}
                                aria-hidden="true"
                              />
                            )}
                            <span className="ag-hier-child-hash mono">#{child.canonicalKey}</span>
                            {child.pinCount > 0 && (
                              <span
                                className="ag-radar-solar-pin-badge mono tabular"
                                title={
                                  child.exactPinned
                                    ? 'Pinned channel'
                                    : `${child.pinCount} pinned inside`
                                }
                              >
                                <Pin size={9} aria-hidden="true" />
                                <span>{child.pinCount}</span>
                              </span>
                            )}
                            {child.liveRoomCount > 0 && (
                              <span className="ag-hier-child-peers mono tabular">
                                {child.totalPeers > 0
                                  ? `${child.totalPeers}p`
                                  : `${child.liveRoomCount} live`}
                              </span>
                            )}
                          </div>
                          <span className="ag-hier-child-place truncate">{child.placeLabel}</span>
                        </div>

                        <div className="ag-hier-child-actions">
                          {child.precision < 9 && (
                            <button
                              type="button"
                              className="ag-hier-btn-ghost"
                              onClick={() => {
                                onPlaySound?.('click')
                                setBrowsePrefix(child.rawGeohash)
                                setSearchDraft('')
                              }}
                              title={`Drill down into #${child.canonicalKey}`}
                            >
                              <span>Drill</span>
                              <ChevronRight size={13} aria-hidden="true" />
                            </button>
                          )}
                          <button
                            type="button"
                            className="ag-hier-child-join"
                            onClick={() => handleTune(child.canonicalKey)}
                            title={`Join #${child.canonicalKey}`}
                          >
                            <span>Join</span>
                            <ArrowUpRight size={12} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ) : (
              <div className="ag-hier-empty-card">
                <p className="ag-hier-empty-text">
                  Maximum geohash precision (P9 · ~4.8 m) reached for{' '}
                  <strong className="mono">#{currentRegionCanonical}</strong>.
                </p>
                <div className="ag-hier-direct-actions">
                  <button
                    type="button"
                    className="ag-hier-btn-secondary"
                    onClick={() => {
                      onPlaySound?.('click')
                      setBrowsePrefix((prev) => prev.slice(0, -1))
                    }}
                  >
                    <ArrowUp size={14} aria-hidden="true" />
                    <span>Up to P8</span>
                  </button>
                  {currentRegionCanonical && (
                    <button
                      type="button"
                      className="ag-hier-tune-btn"
                      onClick={() => handleTune(currentRegionCanonical)}
                    >
                      <span>Tune In</span>
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: TOPIC ASTEROIDS */}
        {activeTab === 'asteroids' && (
          <div className="ag-hier-pane">
            <form className="ag-hier-topic-form" onSubmit={handleTopicSubmit}>
              <div className="ag-hier-topic-input-wrap">
                <Hash size={14} className="ag-radar-hud-topic" aria-hidden="true" />
                <input
                  type="text"
                  className="ag-hier-topic-input mono"
                  placeholder="Join or create #topic (e.g. bitcoin, nostr, mesh)…"
                  value={topicDraft}
                  onChange={(e) => {
                    setTopicDraft(e.target.value)
                    if (topicError) setTopicError(null)
                  }}
                  aria-label="Join or create a topic asteroid channel"
                />
              </div>
              <button type="submit" className="ag-hier-tune-btn">
                <Plus size={14} aria-hidden="true" />
                <span>Join Topic</span>
              </button>
            </form>
            {topicError && (
              <div className="ag-hier-error" role="status">
                {topicError}
              </div>
            )}

            {filteredPinnedTopics.length > 0 && (
              <section className="ag-hier-section" aria-label="Pinned topic asteroids">
                <div className="ag-hier-section-head">
                  <span className="ag-hier-section-title">
                    <Pin size={13} className="ag-radar-pin-icon-red" aria-hidden="true" />
                    <span>Pinned Asteroids</span>
                    <span className="ag-hier-section-count mono tabular">
                      {filteredPinnedTopics.length}
                    </span>
                  </span>
                </div>
                <div className="ag-hier-list">
                  {filteredPinnedTopics.map((entry) => renderChannelRow(entry, false))}
                </div>
              </section>
            )}

            {filteredLiveTopics.length > 0 && (
              <section className="ag-hier-section" aria-label="Live topic asteroids">
                <div className="ag-hier-section-head">
                  <span className="ag-hier-section-title">
                    <span className="ag-radar-warmth-dot is-hot" aria-hidden="true" />
                    <span>Live Asteroids</span>
                    <span className="ag-hier-section-count mono tabular">
                      {filteredLiveTopics.length}
                    </span>
                  </span>
                </div>
                <div className="ag-hier-list">
                  {filteredLiveTopics.map((entry) => renderChannelRow(entry, false))}
                </div>
              </section>
            )}

            <section className="ag-hier-section" aria-label="Popular topic asteroids">
              <div className="ag-hier-section-head">
                <span className="ag-hier-section-title">
                  <Sparkles size={13} className="ag-radar-hud-topic" aria-hidden="true" />
                  <span>Popular Asteroids</span>
                  <span className="ag-hier-section-count mono tabular">
                    {filteredPopularTopics.length}
                  </span>
                </span>
              </div>
              {filteredPopularTopics.length === 0 ? (
                <div className="ag-hier-empty-card">
                  <p className="ag-hier-empty-text">
                    {searchQuery
                      ? `No popular topics match “${searchDraft.trim()}”. Use the input above to join any custom #topic.`
                      : 'All popular topics are already shown above.'}
                  </p>
                </div>
              ) : (
                <div className="ag-hier-list">
                  {filteredPopularTopics.map((topic) => {
                    const key = makeTopicChannelKey(topic.slug)
                    if (!key) return null
                    const isPinned = pinnedKeySet.has(key)
                    const isAct = key === activeGeohash.toLowerCase()
                    return (
                      <div key={key} className={`ag-hier-row${isAct ? ' is-active' : ''}`}>
                        <div className="ag-hier-row-info">
                          <div className="ag-hier-row-head">
                            <Hash size={12} className="ag-radar-hud-topic" aria-hidden="true" />
                            <span className="ag-hier-row-tag is-topic mono">{topic.label}</span>
                            <span className="ag-hier-row-sub truncate">{topic.description}</span>
                          </div>
                        </div>
                        <div className="ag-hier-row-actions">
                          <button
                            type="button"
                            className={`ag-hier-pin-btn${isPinned ? ' is-pinned' : ''}`}
                            onClick={() => handleTogglePinEntry(key, topic.label)}
                            aria-label={isPinned ? `Unpin ${topic.label}` : `Pin ${topic.label}`}
                            title={isPinned ? 'Unpin' : 'Pin'}
                          >
                            {isPinned ? (
                              <PinOff size={13} className="ag-radar-pin-icon-red" />
                            ) : (
                              <Pin size={13} className="ag-radar-pin-icon-red" />
                            )}
                          </button>
                          <button
                            type="button"
                            className={`ag-hier-tune-btn${isAct ? ' is-active' : ''}`}
                            onClick={() => handleTune(key)}
                          >
                            {isAct ? (
                              <>
                                <Check size={13} aria-hidden="true" />
                                <span>{embedded ? 'Open' : 'Active'}</span>
                              </>
                            ) : (
                              <>
                                <span>Tune In</span>
                                <ArrowUpRight size={13} aria-hidden="true" />
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

export default BitchatHierarchyFallback
