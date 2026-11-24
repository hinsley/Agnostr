import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  ArrowLeft,
  Check,
  Crosshair,
  Globe,
  Grid3x3,
  Hash,
  Loader2,
  MapPin,
  MessageSquare,
  Minus,
  Orbit,
  Pin,
  PinOff,
  Plus,
  Search,
  Sun,
  X,
} from 'lucide-react'
import type { AgnostrEngine, PinnedChannel, PulseRoom } from '../types/protocol.ts'
import type { SoundCue } from '../utils/sound.ts'
import {
  buildGeohashCell,
  decodeCenter,
  encodeGeohash,
  formatCoords,
  getZoomForPrecision,
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
  type GeohashableBodyId,
} from '../lib/solarSystem.ts'
import {
  TacticalGeohashMap,
  type PrecisionSelection,
  type TacticalGeohashMapHandle,
} from './TacticalGeohashMap.tsx'

export interface ExpandedRadarModalProps {
  open: boolean
  engine: AgnostrEngine
  onClose: () => void
  onTuneChannel: (geohash: string) => void
  onPlaySound?: (cue: SoundCue) => void
  /** When true on mobile, renders anchored inside .ag-shell-body above the always-present bottom navbar. */
  inShell?: boolean
  /** When true, renders full-bleed inside the Bitchat workspace stage instead of a modal overlay. */
  embedded?: boolean
}

type GlobePopover = 'world' | 'asteroids' | 'pulse' | null
type PulsePopoverTab = 'live' | 'pinned'

function formatPulseAge(tsMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000))
  if (diffSec < 60) return 'live'
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h`
}

function formatInspectSnippet(preview: string): string {
  if (!preview) return ''
  const cleaned = preview
    .replace(/\bcashu[AB][A-Za-z0-9_+/-]{8,}={0,2}/g, 'Cashu ecash')
    .replace(/https?:\/\/\S+/gi, 'Link')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  if (cleaned.length <= 72) return cleaned
  return `${cleaned.slice(0, 71).trimEnd()}…`
}

function resolveBodyNameQuery(raw: string): GeohashableBodyId | 'sun' | null {
  const cleaned = raw.trim().replace(/^#/, '').trim().toLowerCase()
  if (!cleaned) return null
  if (cleaned === 'sun' || cleaned === 'sol' || cleaned === 'solar system') return 'sun'
  if (cleaned === 'luna' || cleaned === 'the moon') return 'moon'
  if (isGeohashableBodyId(cleaned)) return cleaned
  for (const id of GEOHASHABLE_BODY_IDS) {
    if (SOLAR_BODIES[id].name.toLowerCase() === cleaned) return id
  }
  return null
}

function getDefaultBodyRawGeohash(bodyId: GeohashableBodyId, fallbackEarthGeo: string): string {
  if (bodyId === 'earth') return fallbackEarthGeo
  const firstLandmark = getBodyDef(bodyId).landmarks[0]
  if (firstLandmark) {
    return encodeGeohash(firstLandmark.lat, firstLandmark.lon, 4)
  }
  return 's000'
}

export function ExpandedRadarModal({
  open,
  engine,
  onClose,
  onTuneChannel,
  onPlaySound,
  inShell = false,
  embedded = false,
}: ExpandedRadarModalProps) {
  const {
    activeGeohash,
    location,
    pulseRooms,
    pinnedChannels,
    unreadCounts,
    mentionCounts,
    settings,
  } = engine
  const mapRef = useRef<TacticalGeohashMapHandle | null>(null)

  const activeParsed = useMemo(() => parseCelestialChannelKey(activeGeohash), [activeGeohash])
  const initialBodyId: GeohashableBodyId = activeParsed?.bodyId ?? 'earth'

  const safeActiveEarthGeo =
    activeParsed?.bodyId === 'earth'
      ? activeParsed.geohash
      : location.localGeohashes[4] || '9q8y'

  const initialChannelKey =
    activeGeohash && (isTopicChannel(activeGeohash) || activeParsed !== null)
      ? activeGeohash
      : safeActiveEarthGeo

  const celestialPulseRooms = useMemo(
    () => pulseRooms.filter((r) => parseCelestialChannelKey(r.geohash) !== null),
    [pulseRooms],
  )

  const topicPulseRooms = useMemo(
    () => pulseRooms.filter((r) => isTopicChannel(r.geohash)),
    [pulseRooms],
  )

  const pinnedEarth = useMemo(
    () => pinnedChannels.filter((p) => getChannelBodyId(p.geohash) === 'earth'),
    [pinnedChannels],
  )

  const pinnedWorlds = useMemo(
    () =>
      pinnedChannels.filter((p) => {
        const bodyId = getChannelBodyId(p.geohash)
        return bodyId !== null && bodyId !== 'earth'
      }),
    [pinnedChannels],
  )

  const pinnedTopics = useMemo(
    () => pinnedChannels.filter((p) => isTopicChannel(p.geohash)),
    [pinnedChannels],
  )

  const pinCountByBody = useMemo(() => {
    const counts: Partial<Record<GeohashableBodyId, number>> = {}
    for (const pin of pinnedChannels) {
      const bodyId = getChannelBodyId(pin.geohash)
      if (!bodyId) continue
      counts[bodyId] = (counts[bodyId] ?? 0) + 1
    }
    return counts
  }, [pinnedChannels])

  const [focusedBodyId, setFocusedBodyId] = useState<GeohashableBodyId>(initialBodyId)
  const [selectedChannel, setSelectedChannel] = useState<string>(initialChannelKey)
  const [precisionMode, setPrecisionMode] = useState<PrecisionSelection>('auto')
  const [showSubZones, setShowSubZones] = useState(false)
  const [showBubbles, setShowBubbles] = useState(true)
  const [activePopover, setActivePopover] = useState<GlobePopover>(null)
  const [pulseTab, setPulseTab] = useState<PulsePopoverTab>('live')
  const [searchDraft, setSearchDraft] = useState('')
  const [searchError, setSearchError] = useState<string | null>(null)
  const [topicJumpDraft, setTopicJumpDraft] = useState('')
  const [topicJumpError, setTopicJumpError] = useState<string | null>(null)

  // Reset inspection & focused body when modal opens or active channel changes
  useEffect(() => {
    if (!open) return
    setFocusedBodyId(initialBodyId)
    setSelectedChannel(initialChannelKey)
    setPrecisionMode('auto')
    setActivePopover(null)
    setSearchError(null)
    setTopicJumpError(null)
  }, [open, initialBodyId, initialChannelKey])

  // Escape closes open popovers first; closes modal ONLY when not embedded
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (activePopover) {
        e.preventDefault()
        setActivePopover(null)
      } else if (!embedded) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, activePopover, embedded, onClose])

  const focusedBodyDef = getBodyDef(focusedBodyId)
  const focusedParentBody =
    focusedBodyDef.kind === 'moon' &&
    focusedBodyDef.parentId &&
    isGeohashableBodyId(focusedBodyDef.parentId)
      ? getBodyDef(focusedBodyDef.parentId)
      : null
  const moonsHostBodyId: GeohashableBodyId =
    focusedParentBody && isGeohashableBodyId(focusedParentBody.id)
      ? focusedParentBody.id
      : focusedBodyId
  const moonsHostBodyDef = getBodyDef(moonsHostBodyId)
  const activeMoons = useMemo(() => getMoonsOfBody(moonsHostBodyId), [moonsHostBodyId])

  const isSelectedTopic = isTopicChannel(selectedChannel)
  const selectedTopicSlug = isSelectedTopic ? (getTopicSlug(selectedChannel) ?? '') : null
  const selectedCelestial = useMemo(
    () => (isSelectedTopic ? null : parseCelestialChannelKey(selectedChannel)),
    [isSelectedTopic, selectedChannel],
  )

  const selectedBodyId: GeohashableBodyId = selectedCelestial?.bodyId ?? focusedBodyId
  const selectedBodyDef = getBodyDef(selectedBodyId)
  const isSelectedNonEarth = !isSelectedTopic && selectedBodyId !== 'earth'

  const inspectedRawHash =
    selectedCelestial?.geohash ?? getDefaultBodyRawGeohash(focusedBodyId, safeActiveEarthGeo)
  const localFullGeohash =
    location.localGeohashes[9] || location.localGeohashes[8] || location.localGeohashes[7]

  const inspectedEarthCell = useMemo(
    () =>
      buildGeohashCell(
        selectedBodyId === 'earth' ? inspectedRawHash : safeActiveEarthGeo,
        localFullGeohash,
      ),
    [selectedBodyId, inspectedRawHash, safeActiveEarthGeo, localFullGeohash],
  )

  const selectedNonEarthMeta = useMemo(() => {
    if (!isSelectedNonEarth) return null
    const center = decodeCenter(inspectedRawHash)
    const landmark = findNearestCelestialLandmark(selectedBodyId, center.lat, center.lon)
    return {
      bodyId: selectedBodyId,
      bodyName: selectedBodyDef.name,
      geohash: inspectedRawHash,
      precision: inspectedRawHash.length,
      center,
      landmark,
      subtitle: `${selectedBodyDef.name} · ${landmark ?? formatCoords(center)}`,
    }
  }, [isSelectedNonEarth, inspectedRawHash, selectedBodyId, selectedBodyDef.name])

  const inspectedPrecision = isSelectedNonEarth
    ? inspectedRawHash.length
    : inspectedEarthCell.precision

  const activeRawGeoForFocusedBody = useMemo(() => {
    if (activeParsed?.bodyId === focusedBodyId) return activeParsed.geohash
    if (focusedBodyId === 'earth') return safeActiveEarthGeo
    return inspectedRawHash
  }, [activeParsed, focusedBodyId, safeActiveEarthGeo, inspectedRawHash])

  const extraTopicKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const item of POPULAR_TOPIC_CHANNELS) {
      const k = makeTopicChannelKey(item.slug)
      if (k) keys.add(k)
    }
    if (isTopicChannel(selectedChannel)) keys.add(selectedChannel.toLowerCase())
    if (isTopicChannel(activeGeohash)) keys.add(activeGeohash.toLowerCase())
    return Array.from(keys)
  }, [selectedChannel, activeGeohash])

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

  const allTopicCount = useMemo(() => {
    const set = new Set<string>(extraTopicKeys)
    for (const pin of pinnedTopics) set.add(pin.geohash.toLowerCase())
    for (const room of topicPulseRooms) set.add(room.geohash.toLowerCase())
    return set.size
  }, [extraTopicKeys, pinnedTopics, topicPulseRooms])

  const totalLiveCount = celestialPulseRooms.length + topicPulseRooms.length

  const matchingPulse: PulseRoom | null = useMemo(() => {
    if (isSelectedTopic) {
      const targetKey = selectedChannel.toLowerCase()
      return topicPulseRooms.find((r) => r.geohash.toLowerCase() === targetKey) ?? null
    }
    const targetBodyId = selectedCelestial?.bodyId ?? focusedBodyId
    const targetRaw = inspectedRawHash
    const sameWorldRooms = celestialPulseRooms.filter(
      (r) => getChannelBodyId(r.geohash) === targetBodyId,
    )
    const exact = sameWorldRooms.find((r) => getChannelRawGeohash(r.geohash) === targetRaw)
    if (exact) return exact
    return (
      sameWorldRooms.find((r) => {
        const raw = getChannelRawGeohash(r.geohash)
        return raw !== null && (raw.startsWith(targetRaw) || targetRaw.startsWith(raw))
      }) ?? null
    )
  }, [
    isSelectedTopic,
    selectedChannel,
    topicPulseRooms,
    selectedCelestial,
    focusedBodyId,
    inspectedRawHash,
    celestialPulseRooms,
  ])

  const matchingPulseSnippet = useMemo(
    () => (matchingPulse?.lastPreview ? formatInspectSnippet(matchingPulse.lastPreview) : ''),
    [matchingPulse],
  )

  const selectedTopicDescription = useMemo(() => {
    if (!selectedTopicSlug) return ''
    return (
      POPULAR_TOPIC_CHANNELS.find((c) => c.slug === selectedTopicSlug)?.description ??
      'Orbiting kind: 23333 topic channel'
    )
  }, [selectedTopicSlug])

  const pickDefaultChannelForBody = useCallback(
    (bodyId: GeohashableBodyId, explicitRawGh?: string): string => {
      if (explicitRawGh) {
        const explicitKey = makeCelestialChannelKey(bodyId, explicitRawGh)
        if (explicitKey) return explicitKey
      }
      if (getChannelBodyId(selectedChannel) === bodyId) return selectedChannel
      if (getChannelBodyId(activeGeohash) === bodyId) return activeGeohash
      const bodyPin = pinnedChannels.find((p) => getChannelBodyId(p.geohash) === bodyId)
      if (bodyPin) return bodyPin.geohash
      const bodyLive = celestialPulseRooms.find((r) => getChannelBodyId(r.geohash) === bodyId)
      if (bodyLive) return bodyLive.geohash
      const fallbackRaw = getDefaultBodyRawGeohash(bodyId, safeActiveEarthGeo)
      return makeCelestialChannelKey(bodyId, fallbackRaw) ?? safeActiveEarthGeo
    },
    [selectedChannel, activeGeohash, pinnedChannels, celestialPulseRooms, safeActiveEarthGeo],
  )

  const handleFocusBody = useCallback(
    (bodyId: GeohashableBodyId, options?: { geohash?: string; animate?: boolean }) => {
      const targetChannel = pickDefaultChannelForBody(bodyId, options?.geohash)
      setFocusedBodyId(bodyId)
      setSelectedChannel(targetChannel)
      setPrecisionMode('auto')
      setActivePopover(null)
      setSearchError(null)
      setTopicJumpError(null)
      onPlaySound?.('click')
      mapRef.current?.focusBody(bodyId, {
        geohash: options?.geohash,
        animate: options?.animate ?? true,
      })
    },
    [pickDefaultChannelForBody, onPlaySound],
  )

  const handleGlobeFocusBodyChange = useCallback(
    (bodyId: GeohashableBodyId) => {
      setFocusedBodyId(bodyId)
      setSelectedChannel((prev) =>
        getChannelBodyId(prev) === bodyId ? prev : pickDefaultChannelForBody(bodyId),
      )
      setPrecisionMode('auto')
      setActivePopover(null)
      setSearchError(null)
      setTopicJumpError(null)
      onPlaySound?.('click')
    },
    [pickDefaultChannelForBody, onPlaySound],
  )

  const handleSelectChannel = useCallback(
    (channelKey: string) => {
      setSelectedChannel(channelKey)
      const bodyId = getChannelBodyId(channelKey)
      if (bodyId && bodyId !== focusedBodyId) {
        setFocusedBodyId(bodyId)
      }
      setSearchError(null)
      onPlaySound?.('click')
    },
    [focusedBodyId, onPlaySound],
  )

  const handleSelectZone = useCallback(
    (gh: string) => {
      const parsed = parseCelestialChannelKey(gh)
      if (parsed && gh.includes(':')) {
        setSelectedChannel(makeCelestialChannelKey(parsed.bodyId, parsed.geohash) ?? gh)
        if (parsed.bodyId !== focusedBodyId) {
          setFocusedBodyId(parsed.bodyId)
        }
      } else {
        const canonical = makeCelestialChannelKey(focusedBodyId, gh) ?? gh
        setSelectedChannel(canonical)
      }
      setSearchError(null)
      onPlaySound?.('click')
    },
    [focusedBodyId, onPlaySound],
  )

  const handleTuneAndClose = useCallback(
    (channelKey: string) => {
      onTuneChannel(channelKey)
      onPlaySound?.('tune')
      if (!embedded) {
        onClose()
      }
    },
    [onTuneChannel, onPlaySound, embedded, onClose],
  )

  const handleTuneGeohash = useCallback(
    (gh: string) => {
      if (gh.includes(':') || isTopicChannel(gh)) {
        handleTuneAndClose(gh)
        return
      }
      const canonical = makeCelestialChannelKey(focusedBodyId, gh) ?? gh
      handleTuneAndClose(canonical)
    },
    [focusedBodyId, handleTuneAndClose],
  )

  if (!open) return null

  const flyToAnyChannel = (channelKey: string) => {
    setActivePopover(null)
    setSearchError(null)
    setTopicJumpError(null)
    onPlaySound?.('click')

    if (isTopicChannel(channelKey)) {
      setSelectedChannel(channelKey)
      if (focusedBodyId !== 'earth') {
        setFocusedBodyId('earth')
        mapRef.current?.focusBody('earth', { animate: false })
      }
      mapRef.current?.flyToTopic(channelKey, { animate: true })
      return
    }

    const parsed = parseCelestialChannelKey(channelKey)
    if (!parsed) return
    const canonical = makeCelestialChannelKey(parsed.bodyId, parsed.geohash) ?? channelKey
    setSelectedChannel(canonical)
    setPrecisionMode('auto')

    if (parsed.bodyId !== focusedBodyId) {
      setFocusedBodyId(parsed.bodyId)
      mapRef.current?.focusBody(parsed.bodyId, { geohash: parsed.geohash, animate: true })
    } else {
      mapRef.current?.flyToGeohash(canonical, { animate: true })
    }
  }

  const handleSearchSubmit = (e: FormEvent) => {
    e.preventDefault()
    const raw = searchDraft.trim()
    if (!raw) return

    // 1. Direct planet / moon / solar system name match
    const bodyMatch = resolveBodyNameQuery(raw)
    if (bodyMatch === 'sun') {
      setSearchDraft('')
      setSearchError(null)
      setActivePopover(null)
      onPlaySound?.('click')
      mapRef.current?.fitSolarSystem()
      return
    }
    if (bodyMatch) {
      setSearchDraft('')
      handleFocusBody(bodyMatch, { animate: true })
      return
    }

    // 2. Direct celestial geohash match (`#mars:s000`, `europa:9q8y`)
    if (raw.includes(':')) {
      const parsedCelestial = parseCelestialChannelKey(raw.replace(/^#/, ''))
      if (parsedCelestial) {
        const key = makeCelestialChannelKey(parsedCelestial.bodyId, parsedCelestial.geohash)
        if (key) {
          setSearchDraft('')
          flyToAnyChannel(key)
          return
        }
      }
    }

    // 3. Explicit or known Topic Asteroid
    const explicitTopic = /^#?topic:/i.test(raw) || raw.startsWith('/')
    const strippedSlug = normalizeTopicSlug(raw)
    const matchesKnownTopic = Boolean(strippedSlug && knownTopicSlugs.has(strippedSlug))

    if (explicitTopic || matchesKnownTopic) {
      const topicKey = makeTopicChannelKey(raw)
      if (topicKey) {
        setSearchDraft('')
        flyToAnyChannel(topicKey)
        return
      }
    }

    // 4. Earth geohash / city / coordinates or topic fallback
    const resolved = parseQuickTuneInput(raw, 'geo')
    if (!resolved) {
      setSearchError('Enter a #geohash, planet, city, or #topic')
      return
    }
    setSearchDraft('')
    flyToAnyChannel(resolved.key)
  }

  const handleTopicJumpSubmit = (e: FormEvent) => {
    e.preventDefault()
    const raw = topicJumpDraft.trim()
    if (!raw) return
    const topicKey = makeTopicChannelKey(raw)
    if (!topicKey) {
      setTopicJumpError('Use letters, numbers, - or _ (e.g. #nostr)')
      return
    }
    setTopicJumpDraft('')
    flyToAnyChannel(topicKey)
  }

  const handleZoomOutPrecision = () => {
    if (isSelectedTopic || inspectedPrecision <= 1) return
    const parentRaw = inspectedRawHash.slice(0, -1)
    const targetBodyId = selectedBodyId
    const parentKey = makeCelestialChannelKey(targetBodyId, parentRaw)
    if (!parentKey) return

    const nextP = parentRaw.length as PrecisionSelection
    setPrecisionMode(nextP)
    setSelectedChannel(parentKey)
    onPlaySound?.('click')
    if (targetBodyId !== focusedBodyId) {
      setFocusedBodyId(targetBodyId)
      mapRef.current?.focusBody(targetBodyId, { geohash: parentRaw, animate: true })
    } else {
      mapRef.current?.flyToGeohash(parentKey, {
        animate: true,
        zoom: getZoomForPrecision(parentRaw.length),
      })
    }
  }

  const handleSubdivideZoomIn = () => {
    if (isSelectedTopic || inspectedPrecision >= 9) return
    const nextP = inspectedPrecision + 1
    const targetBodyId = selectedBodyId
    const center =
      targetBodyId === 'earth'
        ? inspectedEarthCell.center
        : decodeCenter(inspectedRawHash)
    const localChild = targetBodyId === 'earth' ? location.localGeohashes[nextP] : null
    const targetRaw =
      localChild && localChild.startsWith(inspectedRawHash)
        ? localChild
        : encodeGeohash(center.lat, center.lon, nextP)
    const targetKey = makeCelestialChannelKey(targetBodyId, targetRaw)
    if (!targetKey) return

    setPrecisionMode(nextP as PrecisionSelection)
    setSelectedChannel(targetKey)
    onPlaySound?.('click')
    if (targetBodyId !== focusedBodyId) {
      setFocusedBodyId(targetBodyId)
      mapRef.current?.focusBody(targetBodyId, { geohash: targetRaw, animate: true })
    } else {
      mapRef.current?.flyToGeohash(targetKey, {
        animate: true,
        zoom: getZoomForPrecision(nextP),
      })
    }
  }

  const handleLocateMe = async () => {
    onPlaySound?.('click')
    const gh = await engine.locateMe()
    if (gh) {
      setSelectedChannel(gh)
      setPrecisionMode('auto')
      setActivePopover(null)
      onPlaySound?.('tune')
      if (focusedBodyId !== 'earth') {
        setFocusedBodyId('earth')
        mapRef.current?.focusBody('earth', { geohash: gh, animate: true })
      } else {
        mapRef.current?.flyToGeohash(gh, { animate: true })
      }
    }
  }

  const handleWorldView = () => {
    setPrecisionMode('auto')
    setShowSubZones(false)
    setActivePopover(null)
    onPlaySound?.('click')
    mapRef.current?.fitWorld()
  }

  const handleToggleWorldPopover = () => {
    onPlaySound?.('click')
    setActivePopover((prev) => (prev === 'world' ? null : 'world'))
  }

  const handleToggleAsteroidsPopover = () => {
    onPlaySound?.('click')
    setActivePopover((prev) => {
      const next = prev === 'asteroids' ? null : 'asteroids'
      if (next === 'asteroids') {
        if (focusedBodyId !== 'earth') {
          setFocusedBodyId('earth')
          mapRef.current?.focusBody('earth', { animate: false })
        }
        mapRef.current?.fitAsteroids()
      }
      return next
    })
  }

  const handleTogglePulsePopover = () => {
    onPlaySound?.('click')
    setActivePopover((prev) => (prev === 'pulse' ? null : 'pulse'))
  }

  const isSelectedPinned = engine.isChannelPinned(selectedChannel)
  const isAlreadyActive = selectedChannel.toLowerCase() === activeGeohash.toLowerCase()

  const handleTogglePinSelected = () => {
    onPlaySound?.('click')
    const label = isSelectedTopic
      ? `#${selectedTopicSlug}`
      : selectedNonEarthMeta
        ? selectedNonEarthMeta.landmark
          ? `${selectedNonEarthMeta.bodyName} · ${selectedNonEarthMeta.landmark}`
          : selectedNonEarthMeta.bodyName
        : (inspectedEarthCell.nearestCity ?? undefined)
    engine.togglePinChannel(selectedChannel, label)
  }

  const getUnreadBadgeCount = (channelKey: string): number => {
    const keyLower = channelKey.toLowerCase()
    return (unreadCounts[keyLower] ?? 0) + (mentionCounts[keyLower] ?? 0)
  }

  const pinnedTopicKeySet = new Set(pinnedTopics.map((p) => p.geohash.toLowerCase()))
  const liveTopicsExcludingPinned = topicPulseRooms.filter(
    (r) => !pinnedTopicKeySet.has(r.geohash.toLowerCase()),
  )
  const shownTopicKeySet = new Set<string>([
    ...pinnedTopicKeySet,
    ...liveTopicsExcludingPinned.map((r) => r.geohash.toLowerCase()),
  ])
  const starterTopics = POPULAR_TOPIC_CHANNELS.filter((c) => {
    const key = makeTopicChannelKey(c.slug)
    return key ? !shownTopicKeySet.has(key) : false
  })

  const renderPinnedRow = (pin: PinnedChannel) => {
    const isPinTopic = isTopicChannel(pin.geohash)
    const slug = isPinTopic ? getTopicSlug(pin.geohash) : null
    const parsedPin = isPinTopic ? null : parseCelestialChannelKey(pin.geohash)
    const pinBodyDef =
      parsedPin && parsedPin.bodyId !== 'earth' ? getBodyDef(parsedPin.bodyId) : null
    const badgeCount = getUnreadBadgeCount(pin.geohash)
    const isSel = pin.geohash.toLowerCase() === selectedChannel.toLowerCase()

    let subLabel = pin.label?.replace(/^#/, '').trim() ?? ''
    if (pinBodyDef) {
      const prefix = `${pinBodyDef.name} · `
      if (subLabel.toLowerCase() === pinBodyDef.name.toLowerCase()) {
        subLabel = ''
      } else if (subLabel.startsWith(prefix)) {
        subLabel = subLabel.slice(prefix.length)
      } else if (!subLabel && parsedPin) {
        const center = decodeCenter(parsedPin.geohash)
        subLabel = findNearestCelestialLandmark(parsedPin.bodyId, center.lat, center.lon) ?? ''
      }
    }

    return (
      <div
        key={pin.geohash}
        className={`ag-radar-pin-list-row${isSel ? ' active' : ''}`}
      >
        <button
          type="button"
          className="ag-radar-pin-list-main"
          onClick={() => flyToAnyChannel(pin.geohash)}
        >
          <Pin size={12} className="ag-radar-pin-icon-red" aria-hidden="true" />
          <span className={`${isPinTopic ? 'ag-radar-hud-topic' : 'ag-radar-hud-accent'} mono`}>
            #{isPinTopic ? slug : pin.geohash}
          </span>
          {pinBodyDef && (
            <span className="ag-radar-world-badge">
              <span
                className="ag-radar-world-dot"
                style={{ backgroundColor: pinBodyDef.palette.primary }}
                aria-hidden="true"
              />
              <span>{pinBodyDef.name}</span>
            </span>
          )}
          {subLabel && (
            <span className="ag-radar-pin-list-sub truncate">{subLabel}</span>
          )}
          {badgeCount > 0 && (
            <span className="ag-radar-item-unread tabular">
              {badgeCount > 99 ? '99+' : badgeCount}
            </span>
          )}
        </button>
        <button
          type="button"
          className="ag-icon-btn-xs"
          onClick={() => {
            onPlaySound?.('click')
            engine.togglePinChannel(pin.geohash)
          }}
          aria-label={`Unpin ${isPinTopic ? `#${slug}` : `#${pin.geohash}`}`}
          title="Unpin"
        >
          <PinOff size={12} />
        </button>
      </div>
    )
  }

  const stageContent = (
    <>
      {/* Full-bleed 3D Solar System, Planets, Moons & Topic Asteroids Globe */}
      <TacticalGeohashMap
        ref={mapRef}
        mode="expanded"
        theme={settings.theme}
        focusedBodyId={focusedBodyId}
        onFocusBodyChange={handleGlobeFocusBodyChange}
        activeGeohash={activeRawGeoForFocusedBody}
        selectedGeohash={inspectedRawHash}
        precisionMode={precisionMode}
        showSubZones={showSubZones}
        showPulse={true}
        showBubbles={showBubbles}
        pulseRooms={celestialPulseRooms}
        pinnedChannels={pinnedChannels}
        topicRooms={topicPulseRooms}
        extraTopicKeys={extraTopicKeys}
        activeChannelKey={activeGeohash}
        selectedChannelKey={selectedChannel}
        userCoords={location.coords}
        isTeleported={engine.isTeleported}
        onSelectGeohash={handleSelectZone}
        onTuneGeohash={handleTuneGeohash}
        onSelectChannel={handleSelectChannel}
        onTuneChannel={handleTuneAndClose}
      />

      {/* Single Sleek Floating Top Row */}
      <div className="ag-radar-top-bar">
        <div className="ag-radar-top-row">
          <form className="ag-radar-search-form" onSubmit={handleSearchSubmit}>
            <Search size={14} className="ag-radar-search-icon" />
            <input
              type="text"
              className="ag-radar-search-input mono"
              placeholder="#geohash, planet, city, or #topic…"
              value={searchDraft}
              onChange={(e) => {
                setSearchDraft(e.target.value)
                if (searchError) setSearchError(null)
              }}
              aria-label="Search geohash, planet, city, or topic"
            />
            {searchDraft && (
              <button
                type="submit"
                className="ag-radar-search-go mono"
                aria-label="Fly to world, location, or topic"
              >
                GO
              </button>
            )}
          </form>

          <button
            type="button"
            className={`ag-radar-top-pill ag-radar-world-pill mono ${
              activePopover === 'world' ? 'active' : ''
            }`}
            onClick={handleToggleWorldPopover}
            aria-expanded={activePopover === 'world'}
            aria-label={`Solar System navigator, currently focused on ${focusedBodyDef.name}`}
            title={`Focused on ${focusedBodyDef.name} — explore planets & moons`}
          >
            <span
              className="ag-radar-world-dot"
              style={{ backgroundColor: focusedBodyDef.palette.primary }}
              aria-hidden="true"
            />
            <Orbit size={13} aria-hidden="true" />
            <span className="ag-radar-world-name">{focusedBodyDef.name}</span>
          </button>

          <button
            type="button"
            className={`ag-radar-top-pill ag-radar-asteroids-pill mono ${
              activePopover === 'asteroids' ? 'active' : ''
            }`}
            onClick={handleToggleAsteroidsPopover}
            aria-expanded={activePopover === 'asteroids'}
            title={
              focusedBodyId === 'earth'
                ? 'Orbiting Topic Asteroids (kind: 23333)'
                : 'Return to Earth & view Topic Asteroids (kind: 23333)'
            }
          >
            <Hash size={13} aria-hidden="true" />
            <span className="ag-radar-pill-label">Asteroids</span>
            <span className="ag-radar-pill-count tabular">{allTopicCount}</span>
          </button>

          <button
            type="button"
            className={`ag-radar-top-pill mono ${activePopover === 'pulse' ? 'active' : ''}`}
            onClick={handleTogglePulsePopover}
            aria-expanded={activePopover === 'pulse'}
            title="Browse live and pinned Bitchat channels"
          >
            <span className="ag-led ag-led-ok ag-led-pulse" />
            <span>
              {totalLiveCount}
              <span className="ag-radar-live-word"> live</span>
            </span>
          </button>

          <button
            type="button"
            className={`ag-radar-top-pill ag-radar-bubbles-pill mono ${showBubbles ? 'active' : ''}`}
            onClick={() => {
              onPlaySound?.('click')
              setShowBubbles((v) => !v)
            }}
            aria-pressed={showBubbles}
            aria-label="Toggle live speech bubbles"
            title="Toggle live speech bubbles"
          >
            <MessageSquare size={13} />
            <span className="ag-radar-bubble-toggle-label">Bubbles</span>
          </button>

          {!embedded && (
            <button
              type="button"
              className="ag-radar-close-btn"
              onClick={onClose}
              title="Close Map (Esc)"
              aria-label="Close expanded map"
            >
              <X size={18} />
            </button>
          )}
        </div>

        {searchError && (
          <div className="ag-radar-search-err" role="status">
            {searchError}
          </div>
        )}
      </div>

      {/* Solar System & Moons Focus Navigator Popover */}
      {activePopover === 'world' && (
        <div
          className="ag-radar-pulse-popover ag-radar-solar-popover"
          role="region"
          aria-label="Solar System navigator"
        >
          <div className="ag-radar-pulse-pop-head">
            <span className="ag-panel-card-title">
              <Orbit size={12} />
              <span>SOLAR SYSTEM</span>
            </span>
            <button
              type="button"
              className="ag-icon-btn-xs"
              onClick={() => setActivePopover(null)}
              aria-label="Close solar system navigator"
            >
              <X size={12} />
            </button>
          </div>

          <div className="ag-radar-solar-actions">
            <button
              type="button"
              className="ag-radar-solar-overview-btn"
              onClick={() => {
                onPlaySound?.('click')
                setActivePopover(null)
                mapRef.current?.fitSolarSystem()
              }}
            >
              <Sun size={13} className="ag-radar-solar-sun-icon" aria-hidden="true" />
              <span>Solar System Overview</span>
              <span className="ag-radar-solar-hint mono">9 worlds</span>
            </button>

            {focusedParentBody && isGeohashableBodyId(focusedParentBody.id) && (
              <button
                type="button"
                className="ag-radar-solar-back-btn"
                onClick={() => handleFocusBody(focusedParentBody.id as GeohashableBodyId)}
              >
                <ArrowLeft size={13} aria-hidden="true" />
                <span
                  className="ag-radar-world-dot"
                  style={{ backgroundColor: focusedParentBody.palette.primary }}
                  aria-hidden="true"
                />
                <span>Back to {focusedParentBody.name}</span>
              </button>
            )}
          </div>

          <div className="ag-radar-pulse-pop-list">
            {activeMoons.length > 0 && (
              <>
                <span className="ag-radar-pop-kicker">
                  Moons of {moonsHostBodyDef.name}
                </span>
                <div className="ag-radar-moon-chips">
                  {activeMoons.map((moon) => {
                    if (!isGeohashableBodyId(moon.id)) return null
                    const moonId = moon.id
                    const moonPins = pinCountByBody[moonId] ?? 0
                    const isCurrentMoon = moonId === focusedBodyId
                    return (
                      <button
                        key={moonId}
                        type="button"
                        className={`ag-radar-moon-chip${isCurrentMoon ? ' active' : ''}`}
                        onClick={() => handleFocusBody(moonId)}
                      >
                        <span
                          className="ag-radar-world-dot"
                          style={{ backgroundColor: moon.palette.primary }}
                          aria-hidden="true"
                        />
                        <span>{moon.name}</span>
                        {moonPins > 0 && (
                          <span
                            className="ag-radar-solar-pin-badge mono tabular"
                            title={`${moonPins} pinned ${moonPins === 1 ? 'channel' : 'channels'} on ${moon.name}`}
                          >
                            <Pin size={9} aria-hidden="true" />
                            <span>{moonPins}</span>
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </>
            )}

            <span className="ag-radar-pop-kicker">All Planets</span>
            {PLANET_BODY_IDS.map((planetId) => {
              const planet = SOLAR_BODIES[planetId]
              const moons = getMoonsOfBody(planetId)
              const directPins = pinCountByBody[planetId] ?? 0
              const moonPins = moons.reduce(
                (acc, m) =>
                  acc + (isGeohashableBodyId(m.id) ? (pinCountByBody[m.id] ?? 0) : 0),
                0,
              )
              const totalPlanetPins = directPins + moonPins
              const isCurrentPlanet = focusedBodyId === planetId
              const isParentOfCurrentMoon = focusedParentBody?.id === planetId

              return (
                <button
                  key={planetId}
                  type="button"
                  className={`ag-radar-planet-row${isCurrentPlanet ? ' active' : ''}`}
                  onClick={() => handleFocusBody(planetId)}
                >
                  <div className="ag-radar-planet-row-main">
                    <span
                      className={`ag-radar-planet-dot${planet.rings ? ' has-rings' : ''}`}
                      style={{ backgroundColor: planet.palette.primary }}
                      aria-hidden="true"
                    />
                    <span className="ag-radar-planet-name">{planet.name}</span>
                    {isParentOfCurrentMoon && (
                      <span className="ag-radar-pin-list-sub">
                        · {focusedBodyDef.name}
                      </span>
                    )}
                  </div>
                  <div className="ag-radar-planet-row-meta mono">
                    {moons.length > 0 && (
                      <span className="ag-radar-planet-moons">
                        {moons.length} {moons.length === 1 ? 'moon' : 'moons'}
                      </span>
                    )}
                    {totalPlanetPins > 0 && (
                      <span
                        className="ag-radar-solar-pin-badge tabular"
                        title={`${totalPlanetPins} pinned ${totalPlanetPins === 1 ? 'channel' : 'channels'}`}
                      >
                        <Pin size={9} aria-hidden="true" />
                        <span>{totalPlanetPins}</span>
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Topic Asteroids Quick-Fly Popover */}
      {activePopover === 'asteroids' && (
        <div
          className="ag-radar-pulse-popover ag-radar-asteroids-popover"
          role="region"
          aria-label="Topic Asteroids"
        >
          <div className="ag-radar-pulse-pop-head">
            <span className="ag-panel-card-title">
              <Hash size={12} />
              <span>TOPIC ASTEROIDS</span>
            </span>
            <button
              type="button"
              className="ag-icon-btn-xs"
              onClick={() => setActivePopover(null)}
              aria-label="Close topic asteroids"
            >
              <X size={12} />
            </button>
          </div>

          <form className="ag-radar-topic-form" onSubmit={handleTopicJumpSubmit}>
            <input
              type="text"
              className="ag-input mono ag-radar-topic-input"
              placeholder="Jump to #topic…"
              maxLength={48}
              value={topicJumpDraft}
              onChange={(e) => {
                setTopicJumpDraft(e.target.value)
                if (topicJumpError) setTopicJumpError(null)
              }}
              aria-label="Jump to any topic asteroid"
            />
            <button
              type="submit"
              className="ag-btn ag-btn-primary ag-btn-xs"
              disabled={!topicJumpDraft.trim()}
            >
              Go
            </button>
          </form>

          {topicJumpError && (
            <p className="ag-radar-topic-err" role="alert">
              {topicJumpError}
            </p>
          )}

          <div className="ag-radar-pulse-pop-list">
            {pinnedTopics.length > 0 && (
              <>
                <span className="ag-radar-pop-kicker">Pinned Asteroids</span>
                {pinnedTopics.map(renderPinnedRow)}
              </>
            )}

            {liveTopicsExcludingPinned.length > 0 && (
              <>
                <span className="ag-radar-pop-kicker">Live Asteroids</span>
                {liveTopicsExcludingPinned.map((room) => {
                  const slug = getTopicSlug(room.geohash) ?? room.geohash
                  return (
                    <button
                      key={room.geohash}
                      type="button"
                      className={`ag-radar-pulse-item ${
                        room.geohash.toLowerCase() === selectedChannel.toLowerCase() ? 'active' : ''
                      }`}
                      onClick={() => flyToAnyChannel(room.geohash)}
                    >
                      <div className="ag-radar-pulse-item-main">
                        <Hash size={12} className="ag-radar-hud-topic" aria-hidden="true" />
                        <span className="ag-radar-hud-topic mono">#{slug}</span>
                      </div>
                      <div className="ag-radar-pulse-item-meta mono">
                        <span>
                          {room.peerCount} {room.peerCount === 1 ? 'peer' : 'peers'}
                        </span>
                        <span>·</span>
                        <span>{formatPulseAge(room.lastActivityAt)}</span>
                      </div>
                    </button>
                  )
                })}
              </>
            )}

            {starterTopics.length > 0 && (
              <>
                <span className="ag-radar-pop-kicker">Popular Asteroids</span>
                {starterTopics.map((item) => {
                  const key = makeTopicChannelKey(item.slug)!
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`ag-radar-pulse-item ${
                        key === selectedChannel.toLowerCase() ? 'active' : ''
                      }`}
                      onClick={() => flyToAnyChannel(key)}
                    >
                      <div className="ag-radar-pulse-item-main">
                        <Hash size={12} className="ag-radar-hud-topic" aria-hidden="true" />
                        <span className="ag-radar-hud-topic mono">{item.label}</span>
                        <span className="ag-radar-pin-list-sub truncate">{item.description}</span>
                      </div>
                    </button>
                  )
                })}
              </>
            )}
          </div>
        </div>
      )}

      {/* Restored 2-Tab Live | Pinned Channels Quick-Fly Popover */}
      {activePopover === 'pulse' && (
        <div
          className="ag-radar-pulse-popover"
          role="region"
          aria-label="Live and pinned Bitchat channels"
        >
          <div className="ag-radar-pulse-pop-head">
            <div className="ag-radar-popover-tabs" role="tablist" aria-label="Channel lists">
              <button
                type="button"
                role="tab"
                aria-selected={pulseTab === 'live'}
                className={`ag-radar-pop-tab${pulseTab === 'live' ? ' active' : ''}`}
                onClick={() => setPulseTab('live')}
              >
                <Globe size={11} />
                <span>Live ({totalLiveCount})</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={pulseTab === 'pinned'}
                className={`ag-radar-pop-tab ag-radar-pop-tab-pinned${
                  pulseTab === 'pinned' ? ' active' : ''
                }`}
                onClick={() => setPulseTab('pinned')}
              >
                <Pin size={11} className="ag-radar-pin-icon-red" />
                <span>Pinned ({pinnedChannels.length})</span>
              </button>
            </div>
            <button
              type="button"
              className="ag-icon-btn-xs"
              onClick={() => setActivePopover(null)}
              aria-label="Close channel list"
            >
              <X size={12} />
            </button>
          </div>

          {pulseTab === 'live' ? (
            totalLiveCount === 0 ? (
              <p className="ag-field-hint" style={{ padding: '0.6rem' }}>
                Listening across global relays for active Earth, planetary, and topic asteroid
                channels…
              </p>
            ) : (
              <div className="ag-radar-pulse-pop-list">
                {celestialPulseRooms.slice(0, 18).map((room) => {
                  const parsed = parseCelestialChannelKey(room.geohash)
                  const roomBodyDef =
                    parsed && parsed.bodyId !== 'earth' ? getBodyDef(parsed.bodyId) : null
                  return (
                    <button
                      key={room.geohash}
                      type="button"
                      className={`ag-radar-pulse-item ${
                        room.geohash.toLowerCase() === selectedChannel.toLowerCase() ? 'active' : ''
                      }`}
                      onClick={() => flyToAnyChannel(room.geohash)}
                    >
                      <div className="ag-radar-pulse-item-main">
                        <span className="ag-radar-hud-accent mono">#{room.geohash}</span>
                        {roomBodyDef && (
                          <span className="ag-radar-world-badge">
                            <span
                              className="ag-radar-world-dot"
                              style={{ backgroundColor: roomBodyDef.palette.primary }}
                              aria-hidden="true"
                            />
                            <span>{roomBodyDef.name}</span>
                          </span>
                        )}
                        <span className="truncate">
                          {room.nearestCity || formatCoords(room.center)}
                        </span>
                      </div>
                      <div className="ag-radar-pulse-item-meta mono">
                        <span>
                          {room.peerCount} {room.peerCount === 1 ? 'peer' : 'peers'}
                        </span>
                        <span>·</span>
                        <span>{formatPulseAge(room.lastActivityAt)}</span>
                      </div>
                    </button>
                  )
                })}
                {topicPulseRooms.slice(0, 12).map((room) => {
                  const slug = getTopicSlug(room.geohash) ?? room.geohash
                  return (
                    <button
                      key={room.geohash}
                      type="button"
                      className={`ag-radar-pulse-item ${
                        room.geohash.toLowerCase() === selectedChannel.toLowerCase() ? 'active' : ''
                      }`}
                      onClick={() => flyToAnyChannel(room.geohash)}
                    >
                      <div className="ag-radar-pulse-item-main">
                        <Hash size={12} className="ag-radar-hud-topic" aria-hidden="true" />
                        <span className="ag-radar-hud-topic mono">#{slug}</span>
                        <span className="ag-radar-pin-list-sub">Asteroid</span>
                      </div>
                      <div className="ag-radar-pulse-item-meta mono">
                        <span>
                          {room.peerCount} {room.peerCount === 1 ? 'peer' : 'peers'}
                        </span>
                        <span>·</span>
                        <span>{formatPulseAge(room.lastActivityAt)}</span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )
          ) : pinnedChannels.length === 0 ? (
            <p className="ag-field-hint" style={{ padding: '0.6rem' }}>
              No pinned channels yet. Select any Earth, planet, moon, or orbiting Topic Asteroid
              channel and tap Pin to plant a red 3D marker.
            </p>
          ) : (
            <div className="ag-radar-pulse-pop-list">
              {pinnedEarth.length > 0 && (
                <>
                  <span className="ag-radar-pop-kicker">Pinned on Earth</span>
                  {pinnedEarth.map(renderPinnedRow)}
                </>
              )}
              {pinnedWorlds.length > 0 && (
                <>
                  <span className="ag-radar-pop-kicker">Pinned Worlds</span>
                  {pinnedWorlds.map(renderPinnedRow)}
                </>
              )}
              {pinnedTopics.length > 0 && (
                <>
                  <span className="ag-radar-pop-kicker">Pinned Asteroids</span>
                  {pinnedTopics.map(renderPinnedRow)}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Right Floating Controls (3 Core Actions + Desktop-Only +/- Zoom) */}
      <div className="ag-radar-touch-stack" role="toolbar" aria-label="Globe controls">
        <button
          type="button"
          className={`ag-radar-fab ${location.status === 'ready' ? 'gps-ready' : ''}`}
          onClick={() => void handleLocateMe()}
          disabled={location.status === 'locating'}
          title="Locate Me on Earth"
          aria-label="Locate Me on Earth"
        >
          {location.status === 'locating' ? (
            <Loader2 size={17} className="ag-spin" />
          ) : (
            <Crosshair size={17} />
          )}
        </button>

        <button
          type="button"
          className="ag-radar-fab"
          onClick={handleWorldView}
          title={focusedBodyId === 'earth' ? 'World View' : `${focusedBodyDef.name} Overview`}
          aria-label={focusedBodyId === 'earth' ? 'World View' : `${focusedBodyDef.name} Overview`}
        >
          <Globe size={17} />
        </button>

        <button
          type="button"
          className={`ag-radar-fab ${showSubZones ? 'active' : ''}`}
          onClick={() => {
            onPlaySound?.('click')
            setShowSubZones((v) => !v)
          }}
          aria-pressed={showSubZones}
          title="Sub-Zones"
          aria-label="Toggle 32x sub-zones"
        >
          <Grid3x3 size={17} />
        </button>

        <div className="ag-radar-zoom-pair ag-radar-desktop-only">
          <button
            type="button"
            className="ag-radar-fab ag-radar-fab-compact"
            onClick={() => {
              onPlaySound?.('click')
              mapRef.current?.zoomIn()
            }}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <Plus size={16} />
          </button>
          <button
            type="button"
            className="ag-radar-fab ag-radar-fab-compact"
            onClick={() => {
              onPlaySound?.('click')
              mapRef.current?.zoomOut()
            }}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <Minus size={16} />
          </button>
        </div>
      </div>

      {/* Compact Bottom Selected-Channel Card (Earth, Planets & Moons, or Topic Asteroids) */}
      <div className="ag-radar-bottom-card">
        <div className="ag-radar-bottom-info">
          <div className="ag-radar-inspect-title">
            {isSelectedTopic ? (
              <>
                <Hash size={14} className="ag-radar-hud-topic" aria-hidden="true" />
                <span className="ag-radar-inspect-hash is-topic mono">
                  #{selectedTopicSlug}
                </span>
                <span className="ag-radar-topic-chip">Asteroid</span>
              </>
            ) : selectedNonEarthMeta ? (
              <>
                <span
                  className="ag-radar-world-dot ag-radar-world-dot-md"
                  style={{ backgroundColor: selectedBodyDef.palette.primary }}
                  aria-hidden="true"
                />
                <span className="ag-radar-inspect-hash mono">
                  #{selectedNonEarthMeta.bodyId}:{selectedNonEarthMeta.geohash}
                </span>
                <span className="ag-radar-inspect-city truncate">
                  {selectedNonEarthMeta.subtitle}
                </span>
              </>
            ) : (
              <>
                <MapPin size={14} className="ag-radar-hud-accent" aria-hidden="true" />
                <span className="ag-radar-inspect-hash mono">#{inspectedEarthCell.geohash}</span>
                <span className="ag-radar-inspect-city truncate">
                  {inspectedEarthCell.nearestCity ?? 'Open Coordinates'}
                </span>
              </>
            )}
            {matchingPulse && (
              <span
                className="ag-radar-live-chip mono"
                title={`${matchingPulse.peerCount} active ${matchingPulse.peerCount === 1 ? 'peer' : 'peers'}`}
              >
                <span className="ag-led ag-led-ok" />
                <span>{matchingPulse.peerCount}</span>
              </span>
            )}
          </div>

          {matchingPulseSnippet ? (
            <div className="ag-radar-inspect-snippet">
              <span className="ag-radar-inspect-snippet-sender">
                {matchingPulse?.lastSender?.trim().replace(/^@+/, '') || 'anon'}:
              </span>
              <span className="ag-radar-inspect-snippet-text truncate">
                {matchingPulseSnippet}
              </span>
            </div>
          ) : isSelectedTopic && selectedTopicDescription ? (
            <div className="ag-radar-inspect-snippet">
              <span className="ag-radar-inspect-snippet-text truncate">
                {selectedTopicDescription}
              </span>
            </div>
          ) : null}
        </div>

        <div className="ag-radar-bottom-actions">
          {!isSelectedTopic && (
            <div
              className="ag-radar-prec-stepper"
              role="group"
              aria-label="Geohash precision"
            >
              <button
                type="button"
                className="ag-radar-prec-step-btn"
                onClick={handleZoomOutPrecision}
                disabled={inspectedPrecision <= 1}
                title="Broader precision (P−1)"
                aria-label="Decrease geohash precision"
              >
                <Minus size={13} />
              </button>
              <span
                className="ag-radar-prec-step-val mono"
                title={`Precision P${inspectedPrecision}`}
              >
                P{inspectedPrecision}
              </span>
              <button
                type="button"
                className="ag-radar-prec-step-btn"
                onClick={handleSubdivideZoomIn}
                disabled={inspectedPrecision >= 9}
                title="Finer precision (P+1)"
                aria-label="Increase geohash precision"
              >
                <Plus size={13} />
              </button>
            </div>
          )}

          <button
            type="button"
            className={`ag-btn ag-btn-secondary ag-radar-pin-btn${
              isSelectedPinned ? ' is-pinned pinned' : ''
            }`}
            onClick={handleTogglePinSelected}
            aria-pressed={isSelectedPinned}
            title={isSelectedPinned ? 'Unpin from Globe' : 'Pin to Globe'}
          >
            {isSelectedPinned ? (
              <PinOff size={14} className="ag-radar-pin-icon-red" />
            ) : (
              <Pin size={14} className="ag-radar-pin-icon-red" />
            )}
            <span>{isSelectedPinned ? 'Pinned' : 'Pin'}</span>
          </button>

          <button
            type="button"
            className="ag-btn ag-btn-primary ag-radar-tune-cta"
            onClick={() => handleTuneAndClose(selectedChannel)}
          >
            {isAlreadyActive ? (
              embedded ? (
                <>
                  <Globe size={14} />
                  <span>Open Chat</span>
                </>
              ) : (
                <>
                  <Check size={14} />
                  <span>Active</span>
                </>
              )
            ) : (
              <>
                <Globe size={14} />
                <span>Tune In</span>
              </>
            )}
          </button>
        </div>
      </div>
    </>
  )

  if (embedded) {
    return (
      <div
        className="ag-radar-embedded"
        role="region"
        aria-label="Bitchat 3D Globe"
        data-no-swipe="true"
      >
        {stageContent}
      </div>
    )
  }

  return (
    <div
      className={`ag-radar-modal-backdrop ${inShell ? 'in-shell' : ''}`}
      onClick={onClose}
      role="presentation"
      data-no-swipe="true"
    >
      <div
        className="ag-radar-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Expanded Geohash Globe Map"
        onClick={(e) => e.stopPropagation()}
      >
        {stageContent}
      </div>
    </div>
  )
}

export default ExpandedRadarModal
