import { isNativeAndroidBuild } from '../lib/appPlatform.ts'
import { useNearbyRuntime } from './useNearbyRuntime.ts'
import { isGatewayGeohash } from '../lib/nearby/gatewayPolicy.ts'
import { acceptChatEcho, chatRetries, publishChatWire } from '../lib/chatDelivery.ts'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Event as NostrEvent, Filter } from 'nostr-tools'
import type { PushPokePayload } from '../types/notifications.ts'
import type {
  ActiveView,
  AgnostrEngine,
  AppSettings,
  DmProtocol,
  DmSendContext,
  GeoMessage,
  ImageAttachment,
  LocationNote,
  PeerInfo,
  PendingTrustRequest,
  PinnedChannel,
  PreparedImage,
  ProfileAccountRecord,
  ProfileSwitcherEngine,
  BitchatChannelPreview,
  RecordedVoiceMemo,
  RelayTelemetry,
  SignMode,
  ThemeId,
  TrustedPeerEntry,
  VoiceMemoAttachment,
  VoiceSendPhase,
} from '../types/protocol.ts'
import {
  cleanMimeType,
  DEFAULT_BLOSSOM_SERVERS,
  encryptMediaBytesAesGcm,
  encryptVoiceBytesAesGcm,
  normalizeBlossomServerUrl,
  uploadBlobToBlossom,
  VoiceBlobCache,
} from '../lib/blossom.ts'
import { revokeImagePreviewUrl } from '../lib/imageProcessor.ts'
import {
  buildGeohashChatTemplate,
  AGNOSTR_CLIENT_TAG,
  buildLocationNoteTemplate,
  buildNamedBitchatChatTemplate,
  buildPresenceTemplate,
  buildReactionTemplate,
  clearProtocolCaches,
  createSystemMessage,
  doesContentMentionUser,
  extractGeohashTag,
  extractMentions,
  extractTopicChannelTag,
  getTagValue,
  hasTagPair,
  isAgnostrClientTag,
  KIND_EPHEMERAL_REACTION,
  KIND_GEOHASH_CHAT,
  KIND_GEOHASH_PRESENCE,
  KIND_LOCATION_NOTE,
  KIND_NAMED_BITCHAT_CHAT,
  mineNip13NonceTag,
  parseClientTag,
  parseGeohashChatEvent,
  parseLocationNoteEvent,
  parseNamedBitchatChatEvent,
  parseReactionEvent,
  verifyEventCached,
  type ParsedReaction,
} from '../lib/bitchatProtocol.ts'
import { executeSlashCommand, SLASH_COMMANDS } from '../lib/commands.ts'
import { isAutoAnonNickname } from '../lib/deviceSync.ts'
import {
  buildGeohashCell,
  DEFAULT_GEOHASH,
  normalizeGeohash,
  QUICK_CITIES,
} from '../lib/geohash.ts'
import {
  BUNDLED_GEO_RELAYS,
  CORE_DM_RELAYS,
  fetchBitchatGeoRelays,
  mergeGeoDirectories,
  normalizeRelayUrl,
  PULSE_RELAYS,
  selectRelaysForGeohash,
  type ChannelRelaySelection,
  type GeoRelayEntry,
  type SelectedRelayMeta,
} from '../lib/geoRelays.ts'
import {
  decodePubkeyInput,
  detectNip07,
  encodeNpubSafe,
  formatDisplayHandle,
  generateRandomNickname,
  IdentityManager,
} from '../lib/identity.ts'
import {
  canBroadcastPresenceForGeohash,
  nextPresenceDelayMs,
  PresenceTracker,
} from '../lib/presenceService.ts'
import {
  bootstrapActiveProfile,
  createAndSwitchProfile,
  deleteStoredProfile,
  importAndSwitchProfile,
  snapshotCurrentProfileToVault,
  switchToProfile,
  syncActiveProfileMetadata,
} from '../lib/profileVault.ts'
import {
  formatBitchatChannelHash,
  getChannelRawGeohash,
  getTopicSlug,
  isCelestialNonEarthChannel,
  isTopicChannel,
  isValidBitchatChannelKey,
  makeTopicChannelKey,
  normalizeBitchatChannelKey,
  parseCelestialChannelKey,
  parseQuickTuneInput,
  parseBitchatChannelHash,
  TOPIC_CHANNEL_PREFIX,
} from '../lib/bitchatChannel.ts'
import { findNearestCelestialLandmark, getBodyDef } from '../lib/solarSystem.ts'
import { RelayPool } from '../lib/relayPool.ts'
import {
  KeyedFifoQueue,
  sortChannelMessagesWithPending,
  swapPendingWithSigned,
} from '../lib/sendQueue.ts'
import {
  clearChannelMessagesStorage,
  DEFAULT_SETTINGS,
  formatTranscriptExport,
  isEphemeralPendingMessage,
  isStuckMediaPlaceholder,
  loadActiveGeohash,
  loadBlockedPeerNames,
  loadBlockedPubkeys,
  loadBlossomServers,
  loadChannelMessages,
  loadCustomRelays,
  loadDeviceSeedHex,
  loadGeoDirectoryCache,
  loadLocalSecret,
  loadNickname,
  loadPeerNotes,
  loadPinnedChannels,
  loadRecentChannels,
  loadSettings,
  loadSignMode,
  loadTrustedPubkeys,
  panicWipeStorage,
  saveActiveGeohash,
  saveBlockedPeerNames,
  saveBlockedPubkeys,
  saveBlossomServers,
  saveChannelMessages,
  saveCustomRelays,
  saveDeviceSeedHex,
  saveGeoDirectoryCache,
  saveLocalSecret,
  saveNickname,
  savePeerNotes,
  savePinnedChannels,
  saveRecentChannels,
  saveSettings,
  saveSignMode,
  saveTrustedPubkeys,
  scrubAllPersistedStuckPlaceholders,
  scrubBlockedPubkeyFromChannelStorage,
} from '../lib/storage.ts'
import { archiveChannelMessages, clearProfileChannelHistory } from '../lib/bitchatHistory.ts'
import { buildNip42AuthTemplate } from '../lib/nip29.ts'
import { CALL_SIGNALING_RELAYS } from '../lib/callSignaling.ts'
import { revokeVoicePreviewUrl } from '../lib/voiceRecorder.ts'
import { useAgora } from './useAgora.ts'
import { useAmail } from './useAmail.ts'
import { useCallEngine } from './useCallEngine.ts'
import { useGameEngine } from './useGameEngine.ts'
import { useCashuWallet } from './useCashuWallet.ts'
import { useContentFilter } from './useContentFilter.ts'
import { useDeviceSync } from './useDeviceSync.ts'
import { useDirectMessages } from './useDirectMessages.ts'
import { formatBitchatPreviewText, useGlobalPulse } from './useGlobalPulse.ts'
import { useLocation } from './useLocation.ts'
import {
  useNotifications,
  type NotifyAgoraInput,
  type NotifyAmailInput,
  type NotifyGeoMessageInput,
  type NotifyLocationNoteInput,
} from './useNotifications.ts'
import { useProfileNotifications } from './useProfileNotifications.ts'
import { useServers } from './useServers.ts'
import { useToasts } from './useToasts.ts'
import { useTranscription } from './useTranscription.ts'
import { useTranslator } from './useTranslator.ts'
import { useZaps } from './useZaps.ts'

const THEME_META_COLORS: Record<ThemeId, string> = {
  phosphor: '#090c0a',
  amber: '#0d0a07',
  indigo: '#09090f',
  daylight: '#f4f5f2',
}

function extractLatestVisiblePreview(
  items: readonly GeoMessage[],
  blocked: Set<string>,
  trusted: Set<string>,
  own: Set<string>,
  strict: boolean
): BitchatChannelPreview | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const m = items[i]
    if (!m || m.isSystem || m.isBlockedPlaceholder) continue
    const pk = (m.pubkey || '').toLowerCase()
    if (!pk || blocked.has(pk)) continue
    if (strict && !m.isOwn && !own.has(pk) && !trusted.has(pk)) continue
    const preview = formatBitchatPreviewText({
      content: m.content,
      hasImage: Boolean(m.imageAttachment),
      hasVoice: Boolean(m.voiceMemo),
      mediaUrl: m.imageAttachment?.url ?? m.voiceMemo?.url,
      tags: m.tags,
    })
    if (!preview) continue
    const nowMs = Date.now()
    const nowSec = Math.floor(nowMs / 1000)
    const createdAt = Math.min(Math.floor(m.createdAt || nowSec), nowSec)
    return {
      id: m.id,
      preview,
      sender: (m.nickname || m.displayHandle || `anon${pk.slice(-4)}`).trim(),
      senderPubkey: pk,
      createdAt,
      updatedAtMs: Math.min(createdAt * 1000, nowMs),
    }
  }
  return null
}

function applyReactionToMessage(
  msg: GeoMessage,
  reaction: ParsedReaction,
  ownPubkeys: Set<string>
): GeoMessage {
  const existingIdx = msg.reactions.findIndex((r) => r.emoji === reaction.emoji)
  if (existingIdx !== -1) {
    const rec = msg.reactions[existingIdx]
    if (rec.pubkeys.includes(reaction.pubkey)) return msg
    const pubkeys = [...rec.pubkeys, reaction.pubkey]
    const updatedReactions = [...msg.reactions]
    updatedReactions[existingIdx] = {
      emoji: reaction.emoji,
      count: pubkeys.length,
      pubkeys,
      reactedByMe: rec.reactedByMe || ownPubkeys.has(reaction.pubkey),
    }
    return { ...msg, reactions: updatedReactions }
  }
  return {
    ...msg,
    reactions: [
      ...msg.reactions,
      {
        emoji: reaction.emoji,
        count: 1,
        pubkeys: [reaction.pubkey],
        reactedByMe: ownPubkeys.has(reaction.pubkey),
      },
    ],
  }
}

function backfillReplyReferences(list: GeoMessage[]): GeoMessage[] {
  const byId = new Map<string, GeoMessage>()
  for (const m of list) byId.set(m.id, m)
  let changed = false
  const next = list.map((m) => {
    if (!m.replyTo || (m.replyTo.preview && m.replyTo.nickname)) return m
    const parent = byId.get(m.replyTo.id)
    if (!parent) return m
    changed = true
    return {
      ...m,
      replyTo: {
        ...m.replyTo,
        pubkey: parent.pubkey,
        nickname: parent.nickname,
        preview: parent.content.slice(0, 120),
      },
    }
  })
  return changed ? next : list
}

function readInitialGeohash(): string {
  if (typeof window !== 'undefined') {
    const parsed = parseBitchatChannelHash(window.location.hash || '')
    if (parsed) return parsed
  }
  return loadActiveGeohash()
}

function buildCelestialRelaySelection(
  directory: readonly GeoRelayEntry[],
  customRelays: readonly string[]
): ChannelRelaySelection {
  const metaMap = new Map<string, SelectedRelayMeta>()
  const coreDmSet = new Set<string>(CORE_DM_RELAYS)

  const addRole = (
    url: string,
    role: 'core' | 'pulse' | 'custom',
    coords?: { lat: number; lon: number },
    supportsDm = false
  ) => {
    const existing = metaMap.get(url)
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role)
      if (coords && existing.lat === undefined) {
        existing.lat = coords.lat
        existing.lon = coords.lon
      }
      if (supportsDm) existing.supportsDm = true
    } else {
      metaMap.set(url, {
        url,
        roles: [role],
        lat: coords?.lat,
        lon: coords?.lon,
        supportsDm: supportsDm || coreDmSet.has(url),
      })
    }
  }

  const channelSet = new Set<string>()
  const dmSet = new Set<string>()
  const pulseSet = new Set<string>()

  for (const url of PULSE_RELAYS) {
    channelSet.add(url)
    pulseSet.add(url)
    const dirEntry = directory.find((d) => d.url === url)
    addRole(
      url,
      'pulse',
      dirEntry ? { lat: dirEntry.lat, lon: dirEntry.lon } : undefined,
      coreDmSet.has(url)
    )
  }

  for (const url of CORE_DM_RELAYS) {
    channelSet.add(url)
    dmSet.add(url)
    const dirEntry = directory.find((d) => d.url === url)
    addRole(
      url,
      'core',
      dirEntry ? { lat: dirEntry.lat, lon: dirEntry.lon } : undefined,
      true
    )
  }

  for (const raw of customRelays) {
    const url = normalizeRelayUrl(raw)
    if (!url) continue
    channelSet.add(url)
    dmSet.add(url)
    addRole(url, 'custom', undefined, true)
  }

  return {
    channelRelays: Array.from(channelSet),
    dmRelays: Array.from(dmSet),
    pulseRelays: Array.from(pulseSet),
    allMetadata: metaMap,
  }
}

export function useAgnostrEngine(): AgnostrEngine {
  // Cold-boot storage sweep BEFORE any channel/DM/server state hydrates from localStorage
  const bootScrubbedCountRef = useRef<number | null>(null)
  if (bootScrubbedCountRef.current === null) {
    bootScrubbedCountRef.current = scrubAllPersistedStuckPlaceholders()
  }

  const { toasts, pushToast, dismissToast, clearToasts } = useToasts()

  // Persistent app settings
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())

  // Single long-lived IdentityManager, PresenceTracker, and RelayPool
  const identityManagerRef = useRef<IdentityManager | null>(null)
  if (!identityManagerRef.current) {
    const { hasNip07 } = detectNip07()
    const initialNick = loadNickname() ?? generateRandomNickname()
    const initialSeed = loadDeviceSeedHex()
    const mgr = new IdentityManager({
      deviceSeedHex: initialSeed,
      signMode: loadSignMode(hasNip07),
      localSecretRaw: loadLocalSecret(),
      nickname: initialNick,
    })
    saveDeviceSeedHex(mgr.getDeviceSeedHex())
    saveNickname(mgr.getNickname())
    identityManagerRef.current = mgr
  }
  const identityManager = identityManagerRef.current

  // Synchronously bootstrap multi-profile registry BEFORE Amail/sub-engines initialize
  const initialProfilesRef = useRef<ProfileAccountRecord[] | null>(null)
  if (!initialProfilesRef.current) {
    initialProfilesRef.current = bootstrapActiveProfile(identityManager.getState())
  }
  const [storedProfiles, setStoredProfiles] = useState<ProfileAccountRecord[]>(
    () => initialProfilesRef.current ?? []
  )
  const [profileSwitching, setProfileSwitching] = useState(false)
  const profileSwitchingRef = useRef(false)
  const lastSyncedMasterPubkeyRef = useRef<string>(
    identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
  )

  const presenceTrackerRef = useRef<PresenceTracker | null>(null)
  if (!presenceTrackerRef.current) {
    presenceTrackerRef.current = new PresenceTracker()
  }
  const presenceTracker = presenceTrackerRef.current

  const poolRef = useRef<RelayPool | null>(null)
  if (!poolRef.current) {
    poolRef.current = new RelayPool()
  }
  const pool = poolRef.current
  const [relays, setRelays] = useState<RelayTelemetry[]>([])

  useEffect(() => {
    pool.revive()
    const unsub = pool.onTelemetryChange((snap) => setRelays(snap))
    return () => {
      unsub()
      pool.dispose()
    }
  }, [pool])

  // Active navigation state
  const [activeGeohash, setActiveGeohash] = useState<string>(() => readInitialGeohash())
  const [activeView, setActiveView] = useState<ActiveView>(() => ({
    type: 'channel',
    geohash: readInitialGeohash(),
  }))
  const [identityVersion, setIdentityVersion] = useState(0)

  // Geolocation
  const { location, localFullGeohash, locateMe: rawLocateMe, resetLocation } = useLocation(activeGeohash)

  const activeCelestial = useMemo(
    () => parseCelestialChannelKey(activeGeohash),
    [activeGeohash]
  )
  const isNonEarthCelestial = Boolean(activeCelestial && activeCelestial.bodyId !== 'earth')
  const effectiveIsTeleported = isNonEarthCelestial ? false : location.isTeleported
  const effectiveLocation = useMemo(
    () => (isNonEarthCelestial ? { ...location, isTeleported: false } : location),
    [isNonEarthCelestial, location]
  )

  const cell = useMemo(() => {
    const rawGh = getChannelRawGeohash(activeGeohash)
    if (activeCelestial && activeCelestial.bodyId !== 'earth') {
      const baseCell = buildGeohashCell(activeCelestial.geohash)
      const landmark =
        findNearestCelestialLandmark(
          activeCelestial.bodyId,
          baseCell.center.lat,
          baseCell.center.lon
        ) ?? getBodyDef(activeCelestial.bodyId).name
      return {
        ...baseCell,
        nearestCity: landmark,
      }
    }
    return buildGeohashCell(rawGh ?? activeGeohash, localFullGeohash)
  }, [activeGeohash, activeCelestial, localFullGeohash])

  const identity = useMemo(
    () => identityManager.getState(activeGeohash),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identityManager, activeGeohash, identityVersion]
  )

  const ownPubkeys = useMemo(() => {
    const set = new Set<string>()
    if (identity.masterPubkey) set.add(identity.masterPubkey.toLowerCase())
    if (identity.activePubkey) set.add(identity.activePubkey.toLowerCase())
    return set
  }, [identity.masterPubkey, identity.activePubkey])

  // Fetch NIP-07 pubkey when in extension mode
  useEffect(() => {
    if (identity.signMode !== 'extension') return
    void identityManager.ensureNip07Pubkey().then((pk) => {
      if (pk) setIdentityVersion((v) => v + 1)
    })
  }, [identity.signMode, identityManager])

  // Apply theme token & PWA meta theme-color
  useEffect(() => {
    try {
      document.documentElement.dataset.theme = settings.theme
      const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      if (meta) meta.content = THEME_META_COLORS[settings.theme]
    } catch {
      // Ignore SSR/non-DOM
    }
    saveSettings(settings)
  }, [settings])

  // Sync URL hash <-> activeGeohash (preserve #invite=..., #notify=..., and #dm=... deep links until consumed)
  useEffect(() => {
    saveActiveGeohash(activeGeohash)
    try {
      const rawHash = (window.location.hash || '').replace(/^#/, '').trim()
      const lowerHash = rawHash.toLowerCase()
      if (
        lowerHash.startsWith('invite=') ||
        lowerHash.startsWith('notify=') ||
        lowerHash.startsWith('dm=') ||
        lowerHash === 'agora' ||
        lowerHash.startsWith('agora=') ||
        lowerHash.startsWith('post=')
      ) {
        return
      }
      const currentKey = parseBitchatChannelHash(window.location.hash || '')
      const targetHash = formatBitchatChannelHash(activeGeohash)
      if (currentKey !== activeGeohash || window.location.hash !== targetHash) {
        window.history.replaceState(window.history.state, '', targetHash)
      }
    } catch {
      // Ignore
    }
  }, [activeGeohash])

  useEffect(() => {
    const onHashChange = () => {
      const rawHash = (window.location.hash || '').replace(/^#/, '').trim()
      const lowerHash = rawHash.toLowerCase()
      if (
        lowerHash.startsWith('invite=') ||
        lowerHash.startsWith('notify=') ||
        lowerHash.startsWith('dm=') ||
        lowerHash === 'agora' ||
        lowerHash.startsWith('agora=') ||
        lowerHash.startsWith('post=')
      ) {
        return
      }
      const parsed = parseBitchatChannelHash(window.location.hash || '')
      if (parsed) {
        activeGeohashRef.current = parsed
        setActiveGeohash(parsed)
        setActiveView({ type: 'channel', geohash: parsed })
      }
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Geo-relay directory (bundled live-verified + optional live Bitchat CSV refresh)
  const [geoDirectory, setGeoDirectory] = useState<GeoRelayEntry[]>(() => {
    const cached = loadGeoDirectoryCache()
    return cached ? mergeGeoDirectories(cached) : [...BUNDLED_GEO_RELAYS]
  })
  const [customRelays, setCustomRelays] = useState<string[]>(() => loadCustomRelays())

  useEffect(() => {
    if (loadGeoDirectoryCache()) return
    let cancelled = false
    void fetchBitchatGeoRelays().then((remote) => {
      if (cancelled || !remote) return
      saveGeoDirectoryCache(remote)
      setGeoDirectory(mergeGeoDirectories(remote))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const relaySelection = useMemo(
    () =>
      isNonEarthCelestial
        ? buildCelestialRelaySelection(geoDirectory, customRelays)
        : selectRelaysForGeohash(activeGeohash, geoDirectory, customRelays, 5),
    [isNonEarthCelestial, activeGeohash, geoDirectory, customRelays]
  )

  // Channel-scoped messages, peers, and location notes (tagged by channelKey so rapid channel switches
  // can NEVER bleed stale frames or cross-contaminate localStorage across channels!)
  const [channelMessagesState, setChannelMessagesState] = useState<{
    channelKey: string
    items: GeoMessage[]
  }>(() => ({
    channelKey: activeGeohash,
    items: backfillReplyReferences(loadChannelMessages(activeGeohash)),
  }))
  const [peersState, setPeersState] = useState<{ channelKey: string; items: PeerInfo[] }>({
    channelKey: activeGeohash,
    items: [],
  })
  const [locationNotesState, setLocationNotesState] = useState<{
    channelKey: string
    items: LocationNote[]
  }>({
    channelKey: activeGeohash,
    items: [],
  })
  const [notesRefreshNonce, setNotesRefreshNonce] = useState(0)
  const [channelHistoryEpoch, setChannelHistoryEpoch] = useState(0)
  const [unreadDividerId, setUnreadDividerId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [replyingTo, setReplyingTo] = useState<GeoMessage | null>(null)

  const [pinnedChannels, setPinnedChannels] = useState<PinnedChannel[]>(() => loadPinnedChannels())
  const [geoUnreadCounts, setGeoUnreadCounts] = useState<Record<string, number>>({})
  const [geoMentionCounts, setGeoMentionCounts] = useState<Record<string, number>>({})
  const [recentChannels, setRecentChannels] = useState<string[]>(() => {
    const loaded = loadRecentChannels()
    return loaded.includes(activeGeohash) ? loaded : [activeGeohash, ...loaded].slice(0, 12)
  })
  const [blockedPubkeys, setBlockedPubkeys] = useState<string[]>(() => loadBlockedPubkeys())
  const blockedSet = useMemo(() => new Set(blockedPubkeys), [blockedPubkeys])
  const [blockedPeerNames, setBlockedPeerNames] = useState<Record<string, string>>(() =>
    loadBlockedPeerNames()
  )
  const blockedPeerNamesRef = useRef<Record<string, string>>(blockedPeerNames)
  blockedPeerNamesRef.current = blockedPeerNames

  // Synchronously derive current channel slices on render frame 0 (zero 1-frame stale bleed)
  const messages = useMemo(() => {
    const raw =
      channelMessagesState.channelKey === activeGeohash
        ? channelMessagesState.items
        : backfillReplyReferences(loadChannelMessages(activeGeohash))
    return raw.filter((m) => {
      if (m.isSystem) return true
      const pk = m.pubkey.toLowerCase()
      if (m.isBlockedPlaceholder) return blockedSet.has(pk)
      return !blockedSet.has(pk)
    })
  }, [channelMessagesState, activeGeohash, blockedSet])

  const peers = useMemo(
    () => (peersState.channelKey === activeGeohash ? peersState.items : []),
    [peersState, activeGeohash]
  )

  // Whitelist-based receipt & Blossom media servers
  const [trustedPubkeys, setTrustedPubkeys] = useState<TrustedPeerEntry[]>(() => loadTrustedPubkeys())
  const trustedSet = useMemo(() => new Set(trustedPubkeys.map((t) => t.pubkey)), [trustedPubkeys])
  const [peerNotes, setPeerNotes] = useState<Record<string, string>>(() => loadPeerNotes())

  const locationNotes = useMemo(() => {
    if (locationNotesState.channelKey !== activeGeohash) return []
    return locationNotesState.items.filter((n) => {
      const pk = n.pubkey.toLowerCase()
      if (blockedSet.has(pk)) return false
      if (!settings.strictWhitelistMode) return true
      return n.isOwn || ownPubkeys.has(pk) || trustedSet.has(pk)
    })
  }, [
    locationNotesState,
    activeGeohash,
    blockedSet,
    settings.strictWhitelistMode,
    ownPubkeys,
    trustedSet,
  ])
  const [pendingTrustRequest, setPendingTrustRequest] = useState<PendingTrustRequest | null>(null)
  const pendingTrustRequestRef = useRef<PendingTrustRequest | null>(null)
  pendingTrustRequestRef.current = pendingTrustRequest
  const [blossomServers, setBlossomServers] = useState<string[]>(() => loadBlossomServers())
  const [voiceSendPhase, setVoiceSendPhase] = useState<VoiceSendPhase>('idle')

  const geoUnreadCountsRef = useRef<Record<string, number>>(geoUnreadCounts)
  geoUnreadCountsRef.current = geoUnreadCounts
  const geoMentionCountsRef = useRef<Record<string, number>>(geoMentionCounts)
  geoMentionCountsRef.current = geoMentionCounts
  const geoUnreadItemsRef = useRef<
    Record<string, Array<{ id: string; pubkey: string; isDirectPing: boolean }>>
  >({})
  const geoSeenIdsRef = useRef<Set<string>>(new Set())

  const refreshTrustedPeerLabel = useCallback((pubkey: string, rawNickname?: string | null) => {
    const pk = pubkey.toLowerCase()
    if (!trustedSetRef.current.has(pk)) return
    const clean = rawNickname?.trim().slice(0, 48)
    if (!clean || isAutoAnonNickname(clean)) return
    setTrustedPubkeys((prev) => {
      const idx = prev.findIndex((t) => t.pubkey === pk)
      if (idx === -1) return prev
      const existing = prev[idx]
      if (existing.label === clean) return prev
      const next = [...prev]
      next[idx] = { ...existing, label: clean }
      saveTrustedPubkeys(next)
      return next
    })
  }, [])

  const voiceCacheRef = useRef<VoiceBlobCache | null>(null)
  if (!voiceCacheRef.current) {
    voiceCacheRef.current = new VoiceBlobCache()
  }
  const optimisticVoiceUrlsRef = useRef<Set<string>>(new Set())
  const optimisticVoiceTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  const trackOptimisticVoiceUrl = useCallback((url: string): string => {
    optimisticVoiceUrlsRef.current.add(url)
    return url
  }, [])

  const releaseOptimisticVoiceUrl = useCallback((url: string, immediate = false) => {
    if (!optimisticVoiceUrlsRef.current.has(url)) return
    const revokeNow = () => {
      if (!optimisticVoiceUrlsRef.current.delete(url)) return
      try {
        URL.revokeObjectURL(url)
      } catch {
        // Ignore
      }
    }
    if (immediate) {
      revokeNow()
      return
    }
    const timer = globalThis.setTimeout(() => {
      optimisticVoiceTimersRef.current.delete(timer)
      revokeNow()
    }, 1500)
    optimisticVoiceTimersRef.current.add(timer)
  }, [])

  const revokeAllOptimisticVoiceUrls = useCallback(() => {
    for (const timer of optimisticVoiceTimersRef.current) {
      globalThis.clearTimeout(timer)
    }
    optimisticVoiceTimersRef.current.clear()
    for (const url of optimisticVoiceUrlsRef.current) {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // Ignore
      }
    }
    optimisticVoiceUrlsRef.current.clear()
  }, [])

  useEffect(() => {
    const cache = voiceCacheRef.current
    return () => {
      revokeAllOptimisticVoiceUrls()
      cache?.revokeAll()
    }
  }, [revokeAllOptimisticVoiceUrls])

  const activeGeohashRef = useRef<string>(activeGeohash)
  const activeChannelGenRef = useRef<number>(0)
  const subSeqRef = useRef<number>(0)
  const messagesRef = useRef<GeoMessage[]>(messages)
  const messagesChannelRef = useRef<string>(activeGeohash)
  const blockedSetRef = useRef<Set<string>>(blockedSet)
  const trustedSetRef = useRef<Set<string>>(trustedSet)
  const strictWhitelistRef = useRef<boolean>(settings.strictWhitelistMode)
  const allowUntrustedVoiceMemosRef = useRef<boolean>(settings.allowUntrustedVoiceMemos)
  const ownPubkeysRef = useRef<Set<string>>(ownPubkeys)
  const activeViewRef = useRef<ActiveView>(activeView)
  const notifyGeoMessageRef = useRef<(input: NotifyGeoMessageInput) => void>(() => {})
  const notifyLocationNoteRef = useRef<(input: NotifyLocationNoteInput) => void>(() => {})
  const notifyAmailRef = useRef<(input: NotifyAmailInput) => boolean>(() => true)
  const notifyAgoraRef = useRef<(input: NotifyAgoraInput) => void>(() => {})
  const seedMemoTranscriptRef = useRef<
    (memoKey: string, text: string, modelLabel?: string) => void
  >(() => {})
  const relaySelectionRef = useRef(relaySelection)
  const activeServerRelaysRef = useRef<string[]>([])
  const zapsIngestEventTagsRef = useRef<(pubkey: string, tags: string[][]) => void>(() => {})
  const bitchatSendQueueRef = useRef<KeyedFifoQueue>(new KeyedFifoQueue())
  const inFlightSendCountRef = useRef<number>(0)
  const inFlightMediaCountRef = useRef<number>(0)
  const optimisticBitchatSeqRef = useRef<number>(0)
  const replyingToRef = useRef<GeoMessage | null>(replyingTo)

  const adjustInFlightSend = useCallback((delta: number) => {
    inFlightSendCountRef.current = Math.max(0, inFlightSendCountRef.current + delta)
    setSending(inFlightSendCountRef.current > 0)
  }, [])

  const beginMediaSend = useCallback(() => {
    inFlightMediaCountRef.current += 1
  }, [])

  const endMediaSend = useCallback(() => {
    inFlightMediaCountRef.current = Math.max(0, inFlightMediaCountRef.current - 1)
    if (inFlightMediaCountRef.current === 0) {
      setVoiceSendPhase('idle')
    }
  }, [])

  const setServerVoiceSendPhase = useCallback((phase: VoiceSendPhase) => {
    if (phase === 'idle') {
      if (inFlightMediaCountRef.current === 0) {
        setVoiceSendPhase('idle')
      }
    } else {
      setVoiceSendPhase(phase)
    }
  }, [])

  useLayoutEffect(() => {
    replyingToRef.current = replyingTo
  }, [replyingTo])

  // Sync security-critical refs in useLayoutEffect so they are always up to date
  // BEFORE any child component's mount/update useEffect (e.g. TrustedImageView) runs!
  useLayoutEffect(() => {
    relaySelectionRef.current = relaySelection
  }, [relaySelection])

  useLayoutEffect(() => {
    activeGeohashRef.current = activeGeohash
  }, [activeGeohash])

  useLayoutEffect(() => {
    messagesRef.current = messages
    messagesChannelRef.current = activeGeohash
  }, [messages, activeGeohash])

  useLayoutEffect(() => {
    blockedSetRef.current = blockedSet
  }, [blockedSet])

  useLayoutEffect(() => {
    trustedSetRef.current = trustedSet
  }, [trustedSet])

  useLayoutEffect(() => {
    strictWhitelistRef.current = settings.strictWhitelistMode
  }, [settings.strictWhitelistMode])

  useLayoutEffect(() => {
    allowUntrustedVoiceMemosRef.current = settings.allowUntrustedVoiceMemos
  }, [settings.allowUntrustedVoiceMemos])

  useLayoutEffect(() => {
    ownPubkeysRef.current = ownPubkeys
  }, [ownPubkeys])

  useLayoutEffect(() => {
    activeViewRef.current = activeView
  }, [activeView])

  // Priority channels (active + pinned) are never evicted from Global Pulse's 48-room cap
  const priorityChannels = useMemo(
    () => [activeGeohash, ...pinnedChannels.map((p) => p.geohash)],
    [activeGeohash, pinnedChannels]
  )

  const onObserveClientTagRef = useRef<
    (pubkey: string, clientName: string | undefined, isAgnostr: boolean) => void
  >(() => {})
  const handleObserveGlobalClientTag = useCallback(
    (pubkey: string, clientName: string | undefined, isAgnostr: boolean) => {
      onObserveClientTagRef.current(pubkey, clientName, isAgnostr)
    },
    []
  )
  const onLivePulseRoomEventRef = useRef<(roomKey: string, event: NostrEvent) => void>(() => {})
  const handleLivePulseRoomEvent = useCallback((roomKey: string, event: NostrEvent) => {
    onLivePulseRoomEventRef.current(roomKey, event)
  }, [])

  // Global Pulse Radar (strictly respects muted/blocked peers & strict whitelist mode)
  const {
    pulseRooms,
    recordRoomMessage,
    getRoomEvents: getPulseRoomEvents,
    clearRoomMessages,
    clearPulse,
  } = useGlobalPulse(pool, true, {
    blockedSet,
    trustedSet,
    ownPubkeys,
    strictWhitelistMode: settings.strictWhitelistMode,
    priorityChannels,
    onObserveClientTag: handleObserveGlobalClientTag,
    onLiveRoomEvent: handleLivePulseRoomEvent,
  })

  // Authoritative per-channel latest visible Bitchat message previews (geo + topic)
  // Cold-boot skips any channel with 0 persisted messages so stale/evicted rooms never show ghost previews.
  const [channelPreviews, setChannelPreviews] = useState<Record<string, BitchatChannelPreview>>(() => {
    const initial: Record<string, BitchatChannelPreview> = {}
    const keys = Array.from(
      new Set([
        activeGeohash.toLowerCase(),
        ...pinnedChannels.map((p) => p.geohash.toLowerCase()),
      ])
    )
    for (const key of keys) {
      const storedMsgs = loadChannelMessages(key)
      if (storedMsgs.length === 0) continue
      const latest = extractLatestVisiblePreview(
        storedMsgs,
        blockedSet,
        trustedSet,
        ownPubkeys,
        settings.strictWhitelistMode
      )
      if (latest) initial[key] = latest
    }
    return initial
  })

  const upsertChannelPreview = useCallback(
    (
      geohash: string,
      entry: {
        id: string
        replaceId?: string
        preview: string
        sender: string
        senderPubkey: string
        createdAt: number
      },
      options?: { force?: boolean; preferExistingOnTie?: boolean }
    ) => {
      const ghKey = geohash.trim().toLowerCase()
      const pk = entry.senderPubkey.trim().toLowerCase()
      const cleanPreview = entry.preview.trim().slice(0, 96)
      if (!ghKey || !entry.id || !pk || !cleanPreview) return
      if (blockedSetRef.current.has(pk)) return
      if (
        strictWhitelistRef.current &&
        !ownPubkeysRef.current.has(pk) &&
        !trustedSetRef.current.has(pk)
      ) {
        return
      }
      const nowMs = Date.now()
      const nowSec = Math.floor(nowMs / 1000)
      const createdAt = Math.min(Math.floor(entry.createdAt || nowSec), nowSec)
      const nextItem: BitchatChannelPreview = {
        id: entry.id,
        preview: cleanPreview,
        sender: entry.sender.trim() || `anon${pk.slice(-4)}`,
        senderPubkey: pk,
        createdAt,
        updatedAtMs: Math.min(createdAt * 1000, nowMs),
      }
      setChannelPreviews((prev) => {
        const existing = prev[ghKey]
        const isReplacing = Boolean(entry.replaceId && existing?.id === entry.replaceId)
        if (existing && !options?.force && !isReplacing) {
          if (nextItem.createdAt < existing.createdAt) {
            return prev
          }
          if (
            options?.preferExistingOnTie &&
            nextItem.createdAt === existing.createdAt &&
            existing.id !== nextItem.id
          ) {
            return prev
          }
        }
        if (
          existing &&
          existing.id === nextItem.id &&
          existing.preview === nextItem.preview &&
          existing.sender === nextItem.sender &&
          existing.senderPubkey === nextItem.senderPubkey &&
          existing.createdAt === nextItem.createdAt
        ) {
          return prev
        }
        return {
          ...prev,
          [ghKey]: nextItem,
        }
      })
    },
    []
  )

  const pinnedChannelKeys = useMemo(
    () =>
      pinnedChannels
        .map((p) => p.geohash.toLowerCase())
        .sort()
        .join(','),
    [pinnedChannels]
  )

  // Seed cached channel previews & immediately scrub blocked/untrusted senders on moderation changes
  useEffect(() => {
    const trackedKeys = new Set<string>([activeGeohash.toLowerCase()])
    if (pinnedChannelKeys) {
      for (const key of pinnedChannelKeys.split(',')) {
        if (key) trackedKeys.add(key)
      }
    }
    setChannelPreviews((prev) => {
      let changed = false
      const next: Record<string, BitchatChannelPreview> = { ...prev }

      for (const [ghKey, entry] of Object.entries(next)) {
        const pk = entry.senderPubkey.toLowerCase()
        const hidden =
          blockedSet.has(pk) ||
          (settings.strictWhitelistMode && !ownPubkeys.has(pk) && !trustedSet.has(pk))
        if (hidden) {
          const fallback = extractLatestVisiblePreview(
            loadChannelMessages(ghKey),
            blockedSet,
            trustedSet,
            ownPubkeys,
            settings.strictWhitelistMode
          )
          if (fallback) {
            next[ghKey] = fallback
          } else {
            delete next[ghKey]
          }
          changed = true
        }
      }

      for (const ghKey of trackedKeys) {
        const cachedLatest = extractLatestVisiblePreview(
          loadChannelMessages(ghKey),
          blockedSet,
          trustedSet,
          ownPubkeys,
          settings.strictWhitelistMode
        )
        if (!cachedLatest) continue
        const existing = next[ghKey]
        if (!existing || cachedLatest.createdAt > existing.createdAt) {
          next[ghKey] = cachedLatest
          changed = true
        }
      }

      return changed ? next : prev
    })
  }, [
    activeGeohash,
    pinnedChannelKeys,
    blockedSet,
    trustedSet,
    ownPubkeys,
    settings.strictWhitelistMode,
  ])

  const recomputeGeoUnreads = useCallback(() => {
    const blocked = blockedSetRef.current
    const trusted = trustedSetRef.current
    const own = ownPubkeysRef.current
    const strict = strictWhitelistRef.current

    const nextUnread: Record<string, number> = {}
    const nextMentions: Record<string, number> = {}

    for (const [gh, items] of Object.entries(geoUnreadItemsRef.current)) {
      // Permanently drop muted/blocked senders from unread ledger
      const unblocked = items.filter((item) => !blocked.has(item.pubkey))
      if (unblocked.length === 0) {
        delete geoUnreadItemsRef.current[gh]
        continue
      }
      if (unblocked.length !== items.length) {
        geoUnreadItemsRef.current[gh] = unblocked
      }

      let unread = 0
      let mentions = 0
      for (const item of unblocked) {
        if (strict && !own.has(item.pubkey) && !trusted.has(item.pubkey)) continue
        unread += 1
        if (item.isDirectPing) mentions += 1
      }
      if (unread > 0) nextUnread[gh] = unread
      if (mentions > 0) nextMentions[gh] = mentions
    }

    geoUnreadCountsRef.current = nextUnread
    setGeoUnreadCounts(nextUnread)
    geoMentionCountsRef.current = nextMentions
    setGeoMentionCounts(nextMentions)

    setPinnedChannels((prev) => {
      let changed = false
      const next = prev.map((p) => {
        const u = nextUnread[p.geohash] ?? 0
        const m = nextMentions[p.geohash] ?? 0
        if (p.unreadCount === u && p.mentionCount === m) return p
        changed = true
        return { ...p, unreadCount: u, mentionCount: m }
      })
      return changed ? next : prev
    })
  }, [])

  const incrementGeoUnread = useCallback(
    (rawGh: string, isDirectPing: boolean, meta?: { id: string; pubkey: string }) => {
      const gh = normalizeBitchatChannelKey(rawGh) ?? normalizeGeohash(rawGh)
      if (!gh) return
      const pk = meta?.pubkey.toLowerCase() ?? ''
      if (pk) {
        if (blockedSetRef.current.has(pk) || ownPubkeysRef.current.has(pk)) return
        if (strictWhitelistRef.current && !trustedSetRef.current.has(pk)) return
      }

      const itemId = meta?.id ?? `anon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const list = geoUnreadItemsRef.current[gh] ?? []
      if (list.some((item) => item.id === itemId)) return
      list.push({ id: itemId, pubkey: pk, isDirectPing })
      if (list.length > 400) {
        list.splice(0, list.length - 400)
      }
      geoUnreadItemsRef.current[gh] = list
      recomputeGeoUnreads()
    },
    [recomputeGeoUnreads]
  )

  const clearGeoUnread = useCallback(
    (rawGh: string) => {
      const gh = normalizeBitchatChannelKey(rawGh) ?? normalizeGeohash(rawGh)
      if (!gh) return
      delete geoUnreadItemsRef.current[gh]
      recomputeGeoUnreads()
    },
    [recomputeGeoUnreads]
  )

  // Immediately recompute all Bitchat unread & mention counts when mute/block or whitelist changes
  useEffect(() => {
    recomputeGeoUnreads()
  }, [blockedSet, trustedSet, ownPubkeys, settings.strictWhitelistMode, recomputeGeoUnreads])

  const [localBitchatSend, setLocalBitchatSend] = useState<AgnostrEngine['localBitchatSend']>(null)
  const revealLocalBitchatSend = useCallback((channelKey: string, messageId: string) => {
    // An upload can finish after switching rooms or opening a DM; never pull a different view to bottom.
    if (activeViewRef.current.type === 'channel' && activeGeohashRef.current === channelKey) {
      setLocalBitchatSend({ channelKey, messageId })
    }
  }, [])

  /**
   * Channel-safe state + storage mutator:
   * - Refuses to ever write messages belonging to another channel into live state or localStorage.
   * - If the user switched channels while an async send/upload/publish was in flight and
   *   `allowBackgroundPersist` is true, updates ONLY `rawChannelKey`'s own localStorage bucket
   *   without touching the currently active channel's UI state.
   */
  const updateChannelMessages = useCallback(
    (
      rawChannelKey: string,
      updater: (prevItems: GeoMessage[]) => GeoMessage[] | null,
      opts?: { persist?: boolean; allowBackgroundPersist?: boolean }
    ) => {
      const targetKey = normalizeBitchatChannelKey(rawChannelKey) ?? normalizeGeohash(rawChannelKey)
      if (!targetKey) return
      const profile = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const shouldPersist = opts?.persist !== false
      const allowBg = opts?.allowBackgroundPersist === true

      const keepForTarget = (list: GeoMessage[]): GeoMessage[] =>
        list.filter((m) => {
          if (m.isSystem) return true
          const mk = normalizeBitchatChannelKey(m.geohash) ?? normalizeGeohash(m.geohash)
          return mk === targetKey
        })

      if (activeGeohashRef.current !== targetKey) {
        if (allowBg && shouldPersist) {
          const cached = loadChannelMessages(targetKey)
          const updated = updater(cached)
          if (updated && updated !== cached) {
            saveChannelMessages(targetKey, keepForTarget(updated), profile)
          }
        }
        return
      }

      setChannelMessagesState((prev) => {
        if (activeGeohashRef.current !== targetKey) {
          if (allowBg && shouldPersist) {
            const cached = loadChannelMessages(targetKey)
            const updated = updater(cached)
            if (updated && updated !== cached) {
              saveChannelMessages(targetKey, keepForTarget(updated), profile)
            }
          }
          return prev
        }

        const baseItems =
          prev.channelKey === targetKey
            ? prev.items
            : backfillReplyReferences(
                loadChannelMessages(targetKey).filter(
                  (m) => !blockedSetRef.current.has(m.pubkey.toLowerCase())
                )
              )
        const updated = updater(baseItems)
        if (!updated || updated === baseItems) {
          return prev.channelKey === targetKey ? prev : { channelKey: targetKey, items: baseItems }
        }
        const safeItems = keepForTarget(updated)
        if (shouldPersist) {
          saveChannelMessages(targetKey, safeItems, profile)
        }
        return { channelKey: targetKey, items: safeItems }
      })
    },
    [identityManager]
  )

  const refreshPeers = useCallback(
    (geohash: string) => {
      if (activeGeohashRef.current !== geohash) return
      const base = presenceTracker.getPeers(geohash, ownPubkeysRef.current, blockedSetRef.current)
      setPeersState({
        channelKey: geohash,
        items: base.map((p) => ({
          ...p,
          isTrusted: p.isSelf || trustedSetRef.current.has(p.pubkey),
        })),
      })
    },
    [presenceTracker]
  )

  const applyObservedClientHint = useCallback(
    (
      pubkey: string,
      clientName: string | undefined,
      isAgnostr: boolean,
      channelHint?: string
    ) => {
      if (!clientName && !isAgnostr) return
      const pk = pubkey.toLowerCase()
      if (blockedSetRef.current.has(pk) || ownPubkeysRef.current.has(pk)) return
      const updated = presenceTracker.recordClientHint(pk, clientName, isAgnostr)
      if (!updated) return
      const gh = channelHint ?? activeGeohashRef.current
      updateChannelMessages(gh, (prev) => {
        let changed = false
        const next = prev.map((m) => {
          if (m.pubkey.toLowerCase() !== pk) return m
          const needsAgnostr = isAgnostr && !m.isAgnostrClient
          const needsClient = Boolean(clientName && m.clientName !== clientName)
          if (needsAgnostr || needsClient) {
            changed = true
            return {
              ...m,
              ...(needsAgnostr ? { isAgnostrClient: true } : {}),
              ...(clientName ? { clientName } : {}),
            }
          }
          return m
        })
        return changed ? next : null
      })
      if (gh === activeGeohashRef.current) {
        refreshPeers(gh)
      }
    },
    [presenceTracker, updateChannelMessages, refreshPeers]
  )

  useLayoutEffect(() => {
    onObserveClientTagRef.current = (pk, clientName, isAgnostr) => {
      applyObservedClientHint(pk, clientName, isAgnostr)
    }
  }, [applyObservedClientHint])

  const matchesBitchatChatEventForChannel = useCallback((gh: string, ev: NostrEvent): boolean => {
    const isTopic = isTopicChannel(gh)
    if (isTopic) {
      if (ev.kind !== KIND_NAMED_BITCHAT_CHAT) return false
      const expectedSlug = getTopicSlug(gh)
      const slug = extractTopicChannelTag(ev.tags)
      return Boolean(expectedSlug && slug && slug === expectedSlug)
    }
    if (ev.kind !== KIND_GEOHASH_CHAT) return false
    return extractGeohashTag(ev.tags) === gh
  }, [])

  const buildBlockedGeoPlaceholder = useCallback(
    (gh: string, ev: NostrEvent): GeoMessage => {
      const pk = ev.pubkey.toLowerCase()
      const rawEventNick = getTagValue(ev.tags, 'n')?.trim() || ''
      const savedBlockedName = blockedPeerNamesRef.current[pk]?.trim() || ''
      const trackerNick = presenceTracker.getNickname(pk)?.trim() || ''
      const rawNick = rawEventNick || savedBlockedName || trackerNick
      const strippedNick = rawNick
        .replace(/^@/, '')
        .replace(/#[0-9a-f]{4}$/i, '')
        .trim()
      const cleanNick = strippedNick.slice(0, 32) || `anon${pk.slice(-4)}`
      return {
        id: ev.id,
        geohash: gh,
        pubkey: pk,
        nickname: cleanNick,
        displayHandle: formatDisplayHandle(cleanNick, pk),
        content: '',
        createdAt: ev.created_at,
        tags: [],
        isOwn: false,
        isBlockedPlaceholder: true,
        isTeleported: false,
        isMeshBridge: false,
        powBits: 0,
        reactions: [],
        mentions: [],
      }
    },
    [presenceTracker]
  )

  const parseRetainedPulseEvent = useCallback(
    (
      gh: string,
      ev: NostrEvent,
      findParent?: (id: string) => GeoMessage | undefined
    ): GeoMessage | null => {
      const isTopic = isTopicChannel(gh)
      if (isTopic && ev.kind !== KIND_NAMED_BITCHAT_CHAT) return null
      if (!isTopic && ev.kind !== KIND_GEOHASH_CHAT) return null
      const pk = ev.pubkey.toLowerCase()
      if (blockedSetRef.current.has(pk)) return null

      const geoPk = identityManager.getKeyMaterialForGeohash(gh).pubkey.toLowerCase()
      const masterPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const ownSet = new Set<string>(ownPubkeysRef.current)
      ownSet.add(geoPk)
      ownSet.add(masterPk)

      const parsed = isTopic
        ? parseNamedBitchatChatEvent(ev, gh, ownSet, findParent)
        : parseGeohashChatEvent(ev, gh, ownSet, findParent)
      if (!parsed || parsed.geohash !== gh) return null
      if (!parsed.isOwn && strictWhitelistRef.current && !trustedSetRef.current.has(pk)) {
        return null
      }

      zapsIngestEventTagsRef.current(pk, ev.tags)
      const knownClient =
        parsed.clientName || (!parsed.isOwn ? presenceTracker.getKnownClient(pk) : undefined)
      const knownAgnostr = Boolean(
        parsed.isAgnostrClient ||
          knownClient?.toLowerCase() === AGNOSTR_CLIENT_TAG ||
          (!parsed.isOwn && presenceTracker.isKnownAgnostrPeer(pk))
      )
      if (knownAgnostr || (knownClient && parsed.clientName !== knownClient)) {
        return {
          ...parsed,
          isAgnostrClient: knownAgnostr || parsed.isAgnostrClient,
          clientName: knownClient ?? parsed.clientName,
        }
      }
      return parsed
    },
    [identityManager, presenceTracker]
  )

  const nearby = useNearbyRuntime({
    selectedGeohash: () => activeGeohashRef.current,
    canBridge: () => navigator.onLine && pool.getTelemetrySnapshot().some(relay => relay.status === 'connected'),
    publish: async (event, geohash) => {
      if (!pool || !isGatewayGeohash(geohash)) return false
      const relayUrls = selectRelaysForGeohash(geohash, geoDirectory, customRelays, 5).channelRelays
      return (await pool.publish(relayUrls, event)).acceptedRelays.length > 0
    },
    receive: (event, geohash) => {
      if (activeGeohashRef.current !== geohash || blockedSetRef.current.has(event.pubkey)) return
      const message = parseRetainedPulseEvent(geohash, event, (id) =>
        messagesChannelRef.current === geohash ? messagesRef.current.find(m => m.id === id) : undefined)
      if (!message) return
      geoSeenIdsRef.current.add(event.id)
      if (geoSeenIdsRef.current.size > 1200) geoSeenIdsRef.current.delete(geoSeenIdsRef.current.values().next().value!)
      updateChannelMessages(geohash, previous => {
        if (previous.some(m => m.id === event.id)) return null
        return sortChannelMessagesWithPending([...previous, { ...message, viaMeshGateway: true }], 'pending-bitchat-').slice(-350)
      }, { persist: false })
    },
  }, identity.masterPubkey, identity.nickname)
  const nearbyRef = useRef(nearby)
  nearbyRef.current = nearby

  // Live-bridge PULSE_RELAYS events straight into the active Bitchat room when channelRelays miss them
  useLayoutEffect(() => {
    onLivePulseRoomEventRef.current = (roomKey, ev) => {
      const gh = activeGeohashRef.current
      if (!gh || roomKey.trim().toLowerCase() !== gh.toLowerCase()) return

      const rawPk = ev.pubkey.toLowerCase()
      if (blockedSetRef.current.has(rawPk)) {
        if (!ownPubkeysRef.current.has(rawPk) && matchesBitchatChatEventForChannel(gh, ev)) {
          const placeholder = buildBlockedGeoPlaceholder(gh, ev)
          updateChannelMessages(
            gh,
            (prev) => {
              if (prev.some((m) => m.id === placeholder.id)) return null
              return sortChannelMessagesWithPending([...prev, placeholder], 'pending-bitchat-').slice(
                -200
              )
            },
            { persist: false }
          )
        }
        return
      }

      const findParent = (id: string) =>
        messagesChannelRef.current === gh
          ? messagesRef.current.find((m) => m.id === id)
          : undefined
      const parsed = parseRetainedPulseEvent(gh, ev, findParent)
      if (!parsed) return

      const alreadyInChannel =
        messagesChannelRef.current === gh &&
        messagesRef.current.some((m) => m.id === parsed.id)
      if (alreadyInChannel) return

      const pk = parsed.pubkey.toLowerCase()
      const nowSec = Math.floor(Date.now() / 1000)
      const isRecentLive = nowSec - ev.created_at <= 30

      presenceTracker.recordActivity({
        geohash: gh,
        pubkey: pk,
        seenAtSec: isRecentLive ? nowSec : parsed.createdAt,
        nickname: parsed.nickname,
        isTeleported: parsed.isTeleported,
        isMeshBridge: parsed.isMeshBridge,
        clientName: parsed.clientName,
        isAgnostrClient: parsed.isAgnostrClient,
        isMessage: true,
      })
      refreshPeers(gh)

      updateChannelMessages(gh, (prev) => {
        if (prev.some((m) => m.id === parsed.id)) {
          const echoed = acceptChatEcho(prev, parsed)
          return echoed ? sortChannelMessagesWithPending(echoed, 'pending-bitchat-') : null
        }
        let hydrated = parsed
        if (hydrated.replyTo && (!hydrated.replyTo.preview || !hydrated.replyTo.nickname)) {
          const parent = prev.find((m) => m.id === hydrated.replyTo!.id)
          if (parent) {
            hydrated = {
              ...hydrated,
              replyTo: {
                ...hydrated.replyTo,
                pubkey: parent.pubkey,
                nickname: parent.nickname,
                preview: parent.content.slice(0, 120),
              },
            }
          }
        }
        const backfilledPrev = prev.map((m) => {
          if (!hydrated.isOwn && m.pubkey.toLowerCase() === pk) {
            const needsAgnostr = hydrated.isAgnostrClient && !m.isAgnostrClient
            const needsClient = Boolean(hydrated.clientName && m.clientName !== hydrated.clientName)
            if (needsAgnostr || needsClient) {
              return {
                ...m,
                ...(needsAgnostr ? { isAgnostrClient: true } : {}),
                ...(hydrated.clientName ? { clientName: hydrated.clientName } : {}),
              }
            }
          }
          return m
        })
        const combined = sortChannelMessagesWithPending(
          [...backfilledPrev, hydrated],
          'pending-bitchat-'
        )
        return backfillReplyReferences(combined).slice(-200)
      })

      const parsedPreview = formatBitchatPreviewText({
        content: parsed.content,
        hasImage: Boolean(parsed.imageAttachment),
        hasVoice: Boolean(parsed.voiceMemo),
        mediaUrl: parsed.imageAttachment?.url ?? parsed.voiceMemo?.url,
        tags: ev.tags,
      })
      if (parsedPreview) {
        upsertChannelPreview(gh, {
          id: parsed.id,
          preview: parsedPreview,
          sender: parsed.nickname || parsed.displayHandle || `anon${pk.slice(-4)}`,
          senderPubkey: pk,
          createdAt: parsed.createdAt,
        })
      }

      const alreadyCountedUnread = geoSeenIdsRef.current.has(parsed.id)
      geoSeenIdsRef.current.add(parsed.id)
      if (geoSeenIdsRef.current.size > 1200) {
        const first = geoSeenIdsRef.current.values().next().value
        if (first) geoSeenIdsRef.current.delete(first)
      }

      if (isRecentLive && !parsed.isOwn && !blockedSetRef.current.has(pk)) {
        refreshTrustedPeerLabel(pk, parsed.nickname)
        const view = activeViewRef.current
        const isViewingThisGeo = view.type === 'channel' && view.geohash === gh
        if (!isViewingThisGeo && !alreadyCountedUnread) {
          setUnreadDividerId((curr) => curr ?? parsed.id)
          const myNick = identityManager.getNickname()
          const geoPk = identityManager.getKeyMaterialForGeohash(gh).pubkey
          const masterPk = identityManager.getMasterKeyMaterial().pubkey
          const mentionedMe =
            doesContentMentionUser(parsed.content, parsed.mentions, myNick, geoPk) ||
            (masterPk !== geoPk &&
              doesContentMentionUser(parsed.content, parsed.mentions, myNick, masterPk))
          const repliedToMe = Boolean(
            parsed.replyTo?.pubkey &&
              ownPubkeysRef.current.has(parsed.replyTo.pubkey.toLowerCase())
          )
          incrementGeoUnread(gh, mentionedMe || repliedToMe, {
            id: parsed.id,
            pubkey: pk,
          })
          notifyGeoMessageRef.current({
            id: parsed.id,
            geohash: gh,
            senderPubkey: pk,
            senderHandle: parsed.displayHandle,
            content: parsed.content,
            mentionedMe,
            repliedToMe,
            hasVoice: Boolean(parsed.voiceMemo),
            hasImage: Boolean(parsed.imageAttachment),
          })
        }
      }
    }
  }, [
    identityManager,
    presenceTracker,
    matchesBitchatChatEventForChannel,
    buildBlockedGeoPlaceholder,
    parseRetainedPulseEvent,
    refreshPeers,
    updateChannelMessages,
    upsertChannelPreview,
    refreshTrustedPeerLabel,
    incrementGeoUnread,
  ])

  // Periodic peer online-window refresh (every 15s) & immediate update when trust/block changes
  useEffect(() => {
    refreshPeers(activeGeohash)
    const timer = window.setInterval(() => refreshPeers(activeGeohash), 15_000)
    return () => window.clearInterval(timer)
  }, [activeGeohash, blockedSet, trustedSet, ownPubkeys, refreshPeers])

  // Record self in presence tracker for active geohash
  useEffect(() => {
    presenceTracker.setSelfAgnostrFlag(identity.activePubkey, settings.broadcastClientTag)
    presenceTracker.recordActivity({
      geohash: activeGeohash,
      pubkey: identity.activePubkey,
      seenAtSec: Math.floor(Date.now() / 1000),
      nickname: identity.nickname,
      isTeleported: effectiveIsTeleported,
      clientName: settings.broadcastClientTag ? AGNOSTR_CLIENT_TAG : undefined,
      isAgnostrClient: settings.broadcastClientTag,
    })
    refreshPeers(activeGeohash)
  }, [
    activeGeohash,
    identity.activePubkey,
    identity.nickname,
    effectiveIsTeleported,
    settings.broadcastClientTag,
    presenceTracker,
    refreshPeers,
  ])

  // Active Bitchat channel subscription (geohash: kind 20000/20001/20007; topic: kind 23333/20007 #d)
  useEffect(() => {
    let cancelled = false
    const myGen = ++activeChannelGenRef.current
    const gh = activeGeohash
    const isTopic = isTopicChannel(gh)
    const topicSlug = getTopicSlug(gh)
    const stored = loadChannelMessages(gh).filter(
      (m) => !blockedSetRef.current.has(m.pubkey.toLowerCase())
    )
    const profile = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
    archiveChannelMessages(profile, gh, stored)
    const storedIds = new Set<string>(stored.map((m) => m.id))
    const pulseMsgs: GeoMessage[] = []
    const blockedPulsePlaceholders: GeoMessage[] = []
    for (const rawEv of getPulseRoomEvents(gh)) {
      if (storedIds.has(rawEv.id)) continue
      const rawPk = rawEv.pubkey.toLowerCase()
      if (blockedSetRef.current.has(rawPk)) {
        if (!ownPubkeysRef.current.has(rawPk) && matchesBitchatChatEventForChannel(gh, rawEv)) {
          storedIds.add(rawEv.id)
          blockedPulsePlaceholders.push(buildBlockedGeoPlaceholder(gh, rawEv))
        }
        continue
      }
      const parsedPulse = parseRetainedPulseEvent(gh, rawEv, (id) =>
        stored.find((m) => m.id === id) ?? pulseMsgs.find((m) => m.id === id)
      )
      if (!parsedPulse || storedIds.has(parsedPulse.id)) continue
      storedIds.add(parsedPulse.id)
      pulseMsgs.push(parsedPulse)
      geoSeenIdsRef.current.add(parsedPulse.id)
    }
    const cached = backfillReplyReferences(
      pulseMsgs.length > 0
        ? sortChannelMessagesWithPending([...stored, ...pulseMsgs], 'pending-bitchat-')
        : stored
    ).slice(-200)
    if (pulseMsgs.length > 0) {
      saveChannelMessages(gh, cached, profile)
    }
    const initialInMemory =
      blockedPulsePlaceholders.length > 0
        ? sortChannelMessagesWithPending(
            [...cached, ...blockedPulsePlaceholders],
            'pending-bitchat-'
          ).slice(-200)
        : cached
    setChannelMessagesState((prev) => {
      if (prev.channelKey === gh && prev.items.length > 0) {
        const allIncoming = [...pulseMsgs, ...blockedPulsePlaceholders]
        if (allIncoming.length === 0) return prev
        const existingIds = new Set(prev.items.map((m) => m.id))
        const extras = allIncoming.filter((m) => !existingIds.has(m.id))
        if (extras.length === 0) return prev
        const combined = backfillReplyReferences(
          sortChannelMessagesWithPending([...prev.items, ...extras], 'pending-bitchat-')
        ).slice(-200)
        if (pulseMsgs.some((m) => !existingIds.has(m.id))) {
          saveChannelMessages(gh, combined, profile)
        }
        return { channelKey: gh, items: combined }
      }
      return { channelKey: gh, items: initialInMemory }
    })
    setReplyingTo(null)
    setUnreadDividerId(null)

    // Seed peers from cached + hydrated pulse messages (historical seenAt)
    for (const m of cached) {
      if (m.isSystem || m.isBlockedPlaceholder) continue
      presenceTracker.recordActivity({
        geohash: gh,
        pubkey: m.pubkey,
        seenAtSec: m.createdAt,
        nickname: m.nickname,
        isTeleported: m.isTeleported,
        isMeshBridge: m.isMeshBridge,
        clientName: m.clientName ?? m.bridgeClient,
        isAgnostrClient: m.isAgnostrClient,
        isMessage: true,
      })
    }
    refreshPeers(gh)

    if (!pool) return

    let isHistoryReplay = true
    const seenIds = new Set<string>(initialInMemory.map((m) => m.id))
    const pendingReactions = new Map<string, ParsedReaction[]>()
    const eoseFallback = window.setTimeout(() => {
      if (cancelled) return
      isHistoryReplay = false
    }, 3000)

    const since = Math.floor(Date.now() / 1000) - 3600
    const subSeq = ++subSeqRef.current
    const subId =
      isTopic && topicSlug
        ? `agnostr-bitchat-t-${subSeq}`
        : `agnostr-bitchat-g-${subSeq}`
    const filters =
      isTopic && topicSlug
        ? [
            {
              kinds: [KIND_NAMED_BITCHAT_CHAT],
              '#d': [topicSlug],
              limit: 80,
            },
            {
              kinds: [KIND_EPHEMERAL_REACTION],
              '#d': [topicSlug],
              since,
            },
          ]
        : [
            {
              kinds: [KIND_GEOHASH_CHAT, KIND_GEOHASH_PRESENCE, KIND_EPHEMERAL_REACTION],
              '#g': [gh],
              since,
              limit: 250,
            },
          ]

    const isStale = () =>
      cancelled || activeChannelGenRef.current !== myGen || activeGeohashRef.current !== gh

    const unsub = pool.subscribe(
      subId,
      relaySelection.channelRelays,
      filters,
      {
        onEose: () => {
          if (isStale()) return
          isHistoryReplay = false
          window.clearTimeout(eoseFallback)
        },
        onEvent: (ev) => {
          if (isStale()) return
          if (seenIds.has(ev.id)) return
          if (!verifyEventCached(ev)) return
          if (isStale()) return
          seenIds.add(ev.id)
          const alreadyCountedUnread = geoSeenIdsRef.current.has(ev.id)
          geoSeenIdsRef.current.add(ev.id)
          if (geoSeenIdsRef.current.size > 1200) {
            const first = geoSeenIdsRef.current.values().next().value
            if (first) geoSeenIdsRef.current.delete(first)
          }

          const pk = ev.pubkey.toLowerCase()
          if (!isHistoryReplay && !isTopic && ev.kind === KIND_GEOHASH_CHAT && !blockedSetRef.current.has(pk)) {
            nearbyRef.current.api()?.relayEvent(ev, gh)
          }
          if (blockedSetRef.current.has(pk)) {
            if (!ownPubkeysRef.current.has(pk) && matchesBitchatChatEventForChannel(gh, ev)) {
              const placeholder = buildBlockedGeoPlaceholder(gh, ev)
              updateChannelMessages(
                gh,
                (prev) => {
                  if (prev.some((m) => m.id === placeholder.id)) return null
                  return sortChannelMessagesWithPending(
                    [...prev, placeholder],
                    'pending-bitchat-'
                  ).slice(-350)
                },
                { persist: false }
              )
            }
            return
          }

          // Ephemeral reaction (kind 20007)
          if (ev.kind === KIND_EPHEMERAL_REACTION) {
            const parsed = parseReactionEvent(ev, gh)
            if (!parsed || parsed.geohash !== gh) return
            const evClient = parseClientTag(ev.tags, ev.kind)
            const isAgnostr = isAgnostrClientTag(ev.tags)
            if (evClient || isAgnostr) {
              applyObservedClientHint(pk, evClient, isAgnostr, gh)
            }
            updateChannelMessages(gh, (prev) => {
              let foundTarget = false
              let changed = false
              const next = prev.map((m) => {
                if (m.id !== parsed.targetEventId) return m
                foundTarget = true
                const updated = applyReactionToMessage(m, parsed, ownPubkeysRef.current)
                if (updated !== m) changed = true
                return updated
              })
              if (!foundTarget) {
                const queue = pendingReactions.get(parsed.targetEventId) ?? []
                if (!queue.some((q) => q.id === parsed.id)) {
                  queue.push(parsed)
                  pendingReactions.set(parsed.targetEventId, queue)
                }
                return null
              }
              return changed ? next : null
            })
            return
          }

          // Geohash presence heartbeat (kind 20001 — geohash channels only)
          if (!isTopic && ev.kind === KIND_GEOHASH_PRESENCE) {
            const evGh = extractGeohashTag(ev.tags)
            if (evGh !== gh) return
            const evClient = parseClientTag(ev.tags, ev.kind)
            const isAgnostr = isAgnostrClientTag(ev.tags)
            presenceTracker.recordActivity({
              geohash: gh,
              pubkey: pk,
              seenAtSec: isHistoryReplay ? ev.created_at : Math.floor(Date.now() / 1000),
              clientName: evClient,
              isAgnostrClient: isAgnostr,
            })
            if (isAgnostr || evClient) {
              updateChannelMessages(gh, (prev) => {
                let changed = false
                const next = prev.map((m) => {
                  if (m.pubkey.toLowerCase() !== pk) return m
                  const needsAgnostr = isAgnostr && !m.isAgnostrClient
                  const needsClient = Boolean(evClient && m.clientName !== evClient)
                  if (needsAgnostr || needsClient) {
                    changed = true
                    return {
                      ...m,
                      ...(needsAgnostr ? { isAgnostrClient: true } : {}),
                      ...(evClient ? { clientName: evClient } : {}),
                    }
                  }
                  return m
                })
                return changed ? next : null
              })
            }
            refreshPeers(gh)
            return
          }

          // Bitchat public message (kind 20000 for geohash, kind 23333 for named topic)
          const isExpectedChatKind = isTopic
            ? ev.kind === KIND_NAMED_BITCHAT_CHAT
            : ev.kind === KIND_GEOHASH_CHAT
          if (isExpectedChatKind) {
            const findParent = (id: string) =>
              messagesChannelRef.current === gh
                ? messagesRef.current.find((m) => m.id === id)
                : undefined
            const parsed = isTopic
              ? parseNamedBitchatChatEvent(ev, gh, ownPubkeysRef.current, findParent)
              : parseGeohashChatEvent(ev, gh, ownPubkeysRef.current, findParent)
            if (!parsed || parsed.geohash !== gh) {
              if (!isTopic && !parsed) {
                // Empty teleport ping still updates presence if valid #g
                const evGh = extractGeohashTag(ev.tags)
                if (evGh === gh) {
                  presenceTracker.recordActivity({
                    geohash: gh,
                    pubkey: pk,
                    seenAtSec: isHistoryReplay ? ev.created_at : Math.floor(Date.now() / 1000),
                    nickname: getTagValue(ev.tags, 'n'),
                    isTeleported: hasTagPair(ev.tags, 't', 'teleport'),
                    clientName: parseClientTag(ev.tags, ev.kind),
                    isAgnostrClient: isAgnostrClientTag(ev.tags),
                  })
                  refreshPeers(gh)
                }
              }
              return
            }

            zapsIngestEventTagsRef.current(pk, ev.tags)
            const knownClient =
              parsed.clientName || (!parsed.isOwn ? presenceTracker.getKnownClient(pk) : undefined)
            const knownAgnostr = Boolean(
              parsed.isAgnostrClient ||
                knownClient?.toLowerCase() === AGNOSTR_CLIENT_TAG ||
                (!parsed.isOwn && presenceTracker.isKnownAgnostrPeer(pk))
            )
            presenceTracker.recordActivity({
              geohash: gh,
              pubkey: pk,
              seenAtSec: isHistoryReplay ? parsed.createdAt : Math.floor(Date.now() / 1000),
              nickname: parsed.nickname,
              isTeleported: parsed.isTeleported,
              isMeshBridge: parsed.isMeshBridge,
              clientName: knownClient,
              isAgnostrClient: knownAgnostr,
              isMessage: true,
            })
            refreshPeers(gh)

            updateChannelMessages(gh, (prev) => {
              if (prev.some((m) => m.id === parsed.id)) {
          const echoed = acceptChatEcho(prev, parsed)
          return echoed ? sortChannelMessagesWithPending(echoed, 'pending-bitchat-') : null
        }

              // Resolve incoming replyTo against latest prev state
              let hydrated: GeoMessage =
                knownAgnostr || (knownClient && parsed.clientName !== knownClient)
                  ? {
                      ...parsed,
                      isAgnostrClient: knownAgnostr || parsed.isAgnostrClient,
                      clientName: knownClient ?? parsed.clientName,
                    }
                  : parsed
              if (hydrated.replyTo && (!hydrated.replyTo.preview || !hydrated.replyTo.nickname)) {
                const parent = prev.find((m) => m.id === hydrated.replyTo!.id)
                if (parent) {
                  hydrated = {
                    ...hydrated,
                    replyTo: {
                      ...hydrated.replyTo,
                      pubkey: parent.pubkey,
                      nickname: parent.nickname,
                      preview: parent.content.slice(0, 120),
                    },
                  }
                }
              }

              // Attach any reactions that arrived earlier during newest-first REQ replay
              const queuedReactions = pendingReactions.get(hydrated.id)
              if (queuedReactions && queuedReactions.length > 0) {
                pendingReactions.delete(hydrated.id)
                for (const qr of queuedReactions) {
                  hydrated = applyReactionToMessage(hydrated, qr, ownPubkeysRef.current)
                }
              }

              // Backfill any earlier-arrived replies referencing this newly arrived parent
              // and propagate newly discovered client metadata to earlier messages from this peer
              const backfilledPrev = prev.map((m) => {
                let updated = m
                if (m.replyTo?.id === hydrated.id && (!m.replyTo.preview || !m.replyTo.nickname)) {
                  updated = {
                    ...updated,
                    replyTo: {
                      ...m.replyTo,
                      pubkey: hydrated.pubkey,
                      nickname: hydrated.nickname,
                      preview: hydrated.content.slice(0, 120),
                    },
                  }
                }
                if (!hydrated.isOwn && updated.pubkey.toLowerCase() === pk) {
                  const needsAgnostr = knownAgnostr && !updated.isAgnostrClient
                  const needsClient = Boolean(knownClient && updated.clientName !== knownClient)
                  if (needsAgnostr || needsClient) {
                    updated = {
                      ...updated,
                      ...(needsAgnostr ? { isAgnostrClient: true } : {}),
                      ...(knownClient ? { clientName: knownClient } : {}),
                    }
                  }
                }
                return updated
              })

              return sortChannelMessagesWithPending(
                [...backfilledPrev, hydrated],
                'pending-bitchat-'
              ).slice(-350)
            })

            const parsedPreview = formatBitchatPreviewText({
              content: parsed.content,
              hasImage: Boolean(parsed.imageAttachment),
              hasVoice: Boolean(parsed.voiceMemo),
              mediaUrl: parsed.imageAttachment?.url ?? parsed.voiceMemo?.url,
              tags: ev.tags,
            })
            if (parsedPreview) {
              const previewSender =
                parsed.nickname || parsed.displayHandle || `anon${pk.slice(-4)}`
              upsertChannelPreview(
                gh,
                {
                  id: parsed.id,
                  preview: parsedPreview,
                  sender: previewSender,
                  senderPubkey: pk,
                  createdAt: parsed.createdAt,
                },
                { preferExistingOnTie: isHistoryReplay }
              )
              recordRoomMessage({
                id: parsed.id,
                geohash: gh,
                pubkey: pk,
                sender: previewSender,
                preview: parsedPreview,
                createdAtSec: parsed.createdAt,
                rawEvent: ev,
              })
            }

            if (!isHistoryReplay && !parsed.isOwn && !isStale() && !blockedSetRef.current.has(pk)) {
              refreshTrustedPeerLabel(pk, parsed.nickname)
              const view = activeViewRef.current
              const isViewingThisGeo = view.type === 'channel' && view.geohash === gh
              if (!strictWhitelistRef.current || trustedSetRef.current.has(pk)) {
                if (!isViewingThisGeo) {
                  setUnreadDividerId((curr) => curr ?? parsed.id)
                }
                const myNick = identityManager.getNickname()
                const geoPk = identityManager.getKeyMaterialForGeohash(gh).pubkey
                const masterPk = identityManager.getMasterKeyMaterial().pubkey
                const mentionedMe =
                  doesContentMentionUser(parsed.content, parsed.mentions, myNick, geoPk) ||
                  (masterPk !== geoPk &&
                    doesContentMentionUser(parsed.content, parsed.mentions, myNick, masterPk))
                const repliedToMe = Boolean(
                  parsed.replyTo &&
                    ((parsed.replyTo.pubkey &&
                      ownPubkeysRef.current.has(parsed.replyTo.pubkey.toLowerCase())) ||
                      (messagesChannelRef.current === gh &&
                        messagesRef.current.some(
                          (m) =>
                            m.id === parsed.replyTo?.id &&
                            (m.isOwn || ownPubkeysRef.current.has(m.pubkey.toLowerCase()))
                        )))
                )
                if (!isViewingThisGeo && !alreadyCountedUnread) {
                  incrementGeoUnread(gh, mentionedMe || repliedToMe, {
                    id: parsed.id,
                    pubkey: pk,
                  })
                }
                notifyGeoMessageRef.current({
                  id: parsed.id,
                  geohash: gh,
                  senderPubkey: pk,
                  senderHandle: parsed.displayHandle,
                  content: parsed.content,
                  mentionedMe,
                  repliedToMe,
                  hasVoice: Boolean(parsed.voiceMemo),
                  hasImage: Boolean(parsed.imageAttachment),
                })
              }
            }
          }
        },
      }
    )

    return () => {
      cancelled = true
      window.clearTimeout(eoseFallback)
      unsub()
    }
  }, [
    pool,
    activeGeohash,
    relaySelection.channelRelays,
    presenceTracker,
    refreshPeers,
    applyObservedClientHint,
    getPulseRoomEvents,
    matchesBitchatChatEventForChannel,
    buildBlockedGeoPlaceholder,
    parseRetainedPulseEvent,
    updateChannelMessages,
    identityManager,
    incrementGeoUnread,
    refreshTrustedPeerLabel,
    upsertChannelPreview,
    recordRoomMessage,
  ])

  // Location dead-drop notes subscription (kind 1 + NIP-40 expiration — geohash channels only)
  useEffect(() => {
    let cancelled = false
    const gh = activeGeohash
    setLocationNotesState({ channelKey: gh, items: [] })
    if (!pool || isTopicChannel(gh)) return

    let isNoteReplay = true
    const seenNoteIds = new Set<string>()
    const noteEoseFallback = window.setTimeout(() => {
      if (cancelled) return
      isNoteReplay = false
    }, 3000)
    const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60
    const subId = `agnostr-notes-${++subSeqRef.current}`
    const unsub = pool.subscribe(
      subId,
      relaySelection.dmRelays,
      [{ kinds: [KIND_LOCATION_NOTE], '#g': [gh], since, limit: 60 }],
      {
        onEose: () => {
          if (cancelled || activeGeohashRef.current !== gh) return
          isNoteReplay = false
          window.clearTimeout(noteEoseFallback)
        },
        onEvent: (ev) => {
          if (cancelled || activeGeohashRef.current !== gh) return
          if (seenNoteIds.has(ev.id)) return
          if (!verifyEventCached(ev)) return
          if (cancelled || activeGeohashRef.current !== gh) return
          seenNoteIds.add(ev.id)
          const notePk = ev.pubkey.toLowerCase()
          if (blockedSetRef.current.has(notePk)) return

          const parsed = parseLocationNoteEvent(ev, gh, ownPubkeysRef.current)
          if (!parsed || parsed.geohash !== gh) return
          const noteClient = parseClientTag(ev.tags, ev.kind)
          const noteIsAgnostr = isAgnostrClientTag(ev.tags)
          if (noteClient || noteIsAgnostr) {
            applyObservedClientHint(notePk, noteClient, noteIsAgnostr, gh)
          }
          zapsIngestEventTagsRef.current(notePk, ev.tags)
          setLocationNotesState((prev) => {
            if (activeGeohashRef.current !== gh) return prev
            const base = prev.channelKey === gh ? prev.items : []
            if (base.some((n) => n.id === parsed.id)) return prev
            return {
              channelKey: gh,
              items: [parsed, ...base].sort((a, b) => b.createdAt - a.createdAt).slice(0, 60),
            }
          })
          if (
            !isNoteReplay &&
            !parsed.isOwn &&
            !blockedSetRef.current.has(notePk) &&
            (!strictWhitelistRef.current || trustedSetRef.current.has(notePk))
          ) {
            notifyLocationNoteRef.current({
              id: parsed.id,
              geohash: gh,
              senderPubkey: notePk,
              senderHandle: parsed.displayHandle,
              content: parsed.content,
            })
          }
        },
      }
    )

    return () => {
      cancelled = true
      window.clearTimeout(noteEoseFallback)
      unsub()
    }
  }, [pool, activeGeohash, relaySelection.dmRelays, notesRefreshNonce, applyObservedClientHint])

  // Background unread watcher for pinned channels (excluding activeGeohash, which has its own live subscription).
  // Depend on a stable sorted primitive key so unread/mention increments NEVER tear down & re-subscribe!
  const watchedPinnedKey = useMemo(
    () =>
      pinnedChannels
        .map((p) => p.geohash)
        .filter((g) => g !== activeGeohash)
        .sort()
        .join(','),
    [pinnedChannels, activeGeohash]
  )

  const watchedPinnedRelaysKey = useMemo(() => {
    if (!watchedPinnedKey) return ''
    const watchedChannels = watchedPinnedKey.split(',').filter(Boolean)
    const set = new Set<string>(CORE_DM_RELAYS)
    for (const raw of customRelays) {
      const normalized = normalizeRelayUrl(raw)
      if (normalized) set.add(normalized)
    }
    const geoChannels: string[] = []
    let hasGlobalBroadcast = false
    for (const ch of watchedChannels) {
      if (isTopicChannel(ch) || isCelestialNonEarthChannel(ch)) {
        hasGlobalBroadcast = true
      } else {
        geoChannels.push(ch)
      }
    }
    if (hasGlobalBroadcast) {
      for (const url of PULSE_RELAYS.slice(0, 2)) {
        set.add(url)
      }
    }
    for (const ch of geoChannels) {
      const sel = selectRelaysForGeohash(ch, geoDirectory, customRelays, 2)
      for (const url of sel.channelRelays.slice(0, 2)) {
        set.add(url)
      }
    }
    if (hasGlobalBroadcast) {
      for (const url of PULSE_RELAYS.slice(2, 7)) {
        set.add(url)
      }
    }
    return Array.from(set).slice(0, 10).sort().join(',')
  }, [watchedPinnedKey, geoDirectory, customRelays])

  useEffect(() => {
    if (!pool || !watchedPinnedKey || !watchedPinnedRelaysKey) return
    const watchedChannels = watchedPinnedKey.split(',').filter(Boolean)
    const watchRelays = watchedPinnedRelaysKey.split(',').filter(Boolean)
    if (watchedChannels.length === 0 || watchRelays.length === 0) return

    const watchedSet = new Set(watchedChannels)
    const watchedGeos: string[] = []
    const watchedTopicSlugs: string[] = []
    for (const ch of watchedChannels) {
      const slug = getTopicSlug(ch)
      if (slug) {
        watchedTopicSlugs.push(slug)
      } else {
        watchedGeos.push(ch)
      }
    }
    if (watchedGeos.length === 0 && watchedTopicSlugs.length === 0) return

    const liveSince = Math.floor(Date.now() / 1000)
    const backfillSince = liveSince - 900
    const filters: Filter[] = []
    if (watchedGeos.length > 0) {
      filters.push({ kinds: [KIND_GEOHASH_CHAT], '#g': watchedGeos, since: backfillSince, limit: 40 })
    }
    if (watchedTopicSlugs.length > 0) {
      filters.push({
        kinds: [KIND_NAMED_BITCHAT_CHAT],
        '#d': watchedTopicSlugs,
        since: backfillSince,
        limit: 40,
      })
    }

    let cancelled = false
    let backfillDone = false
    const pinnedSeenIds = new Set<string>()
    const eoseFallback = window.setTimeout(() => {
      if (cancelled) return
      backfillDone = true
    }, 2500)

    const unsub = pool.subscribe(
      `agnostr-pinned-watch-${++subSeqRef.current}`,
      watchRelays,
      filters,
      {
        onEose: () => {
          if (cancelled) return
          backfillDone = true
          window.clearTimeout(eoseFallback)
        },
        onEvent: (ev) => {
          if (cancelled) return
          if (ev.kind !== KIND_GEOHASH_CHAT && ev.kind !== KIND_NAMED_BITCHAT_CHAT) return
          if (pinnedSeenIds.has(ev.id)) return
          if (!verifyEventCached(ev)) return
          if (cancelled) return
          pinnedSeenIds.add(ev.id)
          if (pinnedSeenIds.size > 1200) {
            const first = pinnedSeenIds.values().next().value
            if (first) pinnedSeenIds.delete(first)
          }

          const pk = ev.pubkey.toLowerCase()
          if (blockedSetRef.current.has(pk)) return

          let gh: string | null = null
          if (ev.kind === KIND_NAMED_BITCHAT_CHAT) {
            const slug = extractTopicChannelTag(ev.tags)
            gh = slug ? `${TOPIC_CHANNEL_PREFIX}${slug}` : null
          } else {
            gh = extractGeohashTag(ev.tags)
          }
          if (!gh || !watchedSet.has(gh) || gh === activeGeohashRef.current) return

          const previewText = formatBitchatPreviewText({
            content: ev.content,
            tags: ev.tags,
          })
          if (!previewText) return

          const geoPubkey = identityManager.getKeyMaterialForGeohash(gh).pubkey.toLowerCase()
          const masterPubkey = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
          const ownSet = new Set<string>(ownPubkeysRef.current)
          ownSet.add(geoPubkey)
          ownSet.add(masterPubkey)
          const isOwnSender = ownSet.has(pk)
          if (!isOwnSender && strictWhitelistRef.current && !trustedSetRef.current.has(pk)) {
            return
          }

          const existingCached = loadChannelMessages(gh)
          const parsedPinned =
            ev.kind === KIND_NAMED_BITCHAT_CHAT
              ? parseNamedBitchatChatEvent(ev, gh, ownSet, (id) =>
                  existingCached.find((m) => m.id === id)
                )
              : parseGeohashChatEvent(ev, gh, ownSet, (id) =>
                  existingCached.find((m) => m.id === id)
                )
          if (!parsedPinned || parsedPinned.geohash !== gh) return

          zapsIngestEventTagsRef.current(pk, ev.tags)
          const knownClient =
            parsedPinned.clientName ||
            (!isOwnSender ? presenceTracker.getKnownClient(pk) : undefined)
          const knownAgnostr = Boolean(
            parsedPinned.isAgnostrClient ||
              knownClient?.toLowerCase() === AGNOSTR_CLIENT_TAG ||
              (!isOwnSender && presenceTracker.isKnownAgnostrPeer(pk))
          )
          presenceTracker.recordActivity({
            geohash: gh,
            pubkey: pk,
            seenAtSec: !backfillDone ? parsedPinned.createdAt : Math.floor(Date.now() / 1000),
            nickname: parsedPinned.nickname,
            isTeleported: parsedPinned.isTeleported,
            isMeshBridge: parsedPinned.isMeshBridge,
            clientName: knownClient,
            isAgnostrClient: knownAgnostr,
            isMessage: true,
          })

          // Persist full parsed message for background pinned rooms so opening any pinned room
          // with a preview ALWAYS displays that exact message immediately (even across reload).
          if (!existingCached.some((m) => m.id === parsedPinned.id)) {
            const hydratedPinned: GeoMessage =
              knownAgnostr || (knownClient && parsedPinned.clientName !== knownClient)
                ? {
                    ...parsedPinned,
                    isAgnostrClient: knownAgnostr || parsedPinned.isAgnostrClient,
                    clientName: knownClient ?? parsedPinned.clientName,
                  }
                : parsedPinned
            const mergedPinned = backfillReplyReferences(
              sortChannelMessagesWithPending([...existingCached, hydratedPinned], 'pending-bitchat-')
            ).slice(-200)
            saveChannelMessages(gh, mergedPinned, identityManager.getMasterKeyMaterial().pubkey.toLowerCase())
          }

          const rawNick = getTagValue(ev.tags, 'n')
          const previewSender =
            parsedPinned.nickname || rawNick?.trim() || `anon${pk.slice(-4)}`

          // Always keep pinned room activity previews up to date (including media-only
          // events and own same-key messages sent from another device)
          upsertChannelPreview(
            gh,
            {
              id: ev.id,
              preview: previewText,
              sender: previewSender,
              senderPubkey: pk,
              createdAt: parsedPinned.createdAt,
            },
            { preferExistingOnTie: !backfillDone }
          )
          recordRoomMessage({
            id: ev.id,
            geohash: gh,
            pubkey: pk,
            sender: previewSender,
            preview: previewText,
            createdAtSec: parsedPinned.createdAt,
            rawEvent: ev,
          })

          // Only count unreads & fire notifications for genuinely live, non-own events
          if (!backfillDone || ev.created_at < liveSince - 2) return
          if (geoSeenIdsRef.current.has(ev.id)) return
          geoSeenIdsRef.current.add(ev.id)
          if (geoSeenIdsRef.current.size > 1200) {
            const first = geoSeenIdsRef.current.values().next().value
            if (first) geoSeenIdsRef.current.delete(first)
          }

          // Never double-count if user just switched onto this geohash
          if (activeViewRef.current.type === 'channel' && activeViewRef.current.geohash === gh) {
            return
          }
          if (isOwnSender) return

          refreshTrustedPeerLabel(pk, rawNick)

          const mentions = extractMentions(ev.content)
          const myNick = identityManager.getNickname()
          const mentionedMe =
            doesContentMentionUser(ev.content, mentions, myNick, geoPubkey) ||
            (masterPubkey !== geoPubkey && doesContentMentionUser(ev.content, mentions, myNick, masterPubkey))

          const eTag = ev.tags.find((t) => t[0] === 'e' && typeof t[1] === 'string' && t[1].length >= 16)
          const replyTargetPubkey = eTag ? getTagValue(ev.tags, 'p')?.toLowerCase() : undefined
          let repliedToMe = Boolean(
            replyTargetPubkey &&
              (replyTargetPubkey === geoPubkey ||
                replyTargetPubkey === masterPubkey ||
                ownPubkeysRef.current.has(replyTargetPubkey))
          )
          if (!repliedToMe && eTag) {
            const cachedMsgs = loadChannelMessages(gh)
            repliedToMe = cachedMsgs.some(
              (m) =>
                m.id === eTag[1] &&
                (m.isOwn ||
                  m.pubkey.toLowerCase() === geoPubkey ||
                  m.pubkey.toLowerCase() === masterPubkey ||
                  ownPubkeysRef.current.has(m.pubkey.toLowerCase()))
            )
          }

          incrementGeoUnread(gh, mentionedMe || repliedToMe, {
            id: ev.id,
            pubkey: pk,
          })

          notifyGeoMessageRef.current({
            id: ev.id,
            geohash: gh,
            senderPubkey: pk,
            senderHandle: formatDisplayHandle(rawNick, pk),
            content: ev.content,
            mentionedMe,
            repliedToMe,
          })
        },
      }
    )

    return () => {
      cancelled = true
      window.clearTimeout(eoseFallback)
      unsub()
    }
  }, [
    pool,
    watchedPinnedKey,
    watchedPinnedRelaysKey,
    identityManager,
    presenceTracker,
    incrementGeoUnread,
    refreshTrustedPeerLabel,
    upsertChannelPreview,
    recordRoomMessage,
  ])

  // Privacy-safe kind 20001 presence heartbeat (strictly precision <= 5 per GeohashPresenceSpec.md)
  useEffect(() => {
    if (!pool) return
    const rawPresenceKey = isTopicChannel(activeGeohash)
      ? activeGeohash
      : (getChannelRawGeohash(activeGeohash) ?? activeGeohash)
    if (!canBroadcastPresenceForGeohash(rawPresenceKey, settings.presenceEnabled)) return
    // Don't prompt NIP-07 extension popups on background heartbeats
    if (identityManager.getSignMode() === 'extension') return

    let cancelled = false
    let timerId: number | null = null
    let sentCount = 0

    const broadcastOnce = async () => {
      if (cancelled) return
      try {
        const template = buildPresenceTemplate(activeGeohash, settings.broadcastClientTag)
        const signed = await identityManager.signEvent(template, activeGeohash)
        if (!cancelled) {
          void pool.publish(relaySelection.channelRelays, signed, 3500)
        }
      } catch {
        // Ignore transient signing/network failures
      }
      sentCount += 1
      if (!cancelled) {
        // One fast confirmation heartbeat (~14s) after the initial cold-start ping so slower
        // WebSockets connecting after the 2–5s window still receive our ['client', 'agnostr'] tag quickly.
        const delayMs = sentCount === 1 ? 14_000 : nextPresenceDelayMs()
        timerId = window.setTimeout(() => void broadcastOnce(), delayMs)
      }
    }

    // Small initial jitter (2-5s) to prevent cross-channel temporal correlation
    timerId = window.setTimeout(() => void broadcastOnce(), 2000 + Math.floor(Math.random() * 3000))

    return () => {
      cancelled = true
      if (timerId !== null) window.clearTimeout(timerId)
    }
  }, [
    pool,
    activeGeohash,
    settings.presenceEnabled,
    settings.broadcastClientTag,
    relaySelection.channelRelays,
    identityManager,
    identityVersion,
  ])

  // Direct Messages (dual-stack: Bitchat v2 + NIP-17)
  const activeDmPeer = activeView.type === 'dm' ? activeView.peerPubkey : null
  const pokeRecipientsRef = useRef<(payload: PushPokePayload) => void>(() => {})
  const handlePushPoke = useCallback((payload: PushPokePayload) => {
    pokeRecipientsRef.current(payload)
  }, [])

  const {
    dmThreads,
    visibleDmThreads,
    dmClearedAt,
    totalDmUnread,
    ensureThread,
    sendDirectMessage,
    sendDmReaction,
    sendDirectVoiceMemo,
    sendDirectImageAttachment,
    clearThread,
    closeThread: closeDmThreadRaw,
    mergeSyncedDmClearedAt,
    mergeSyncedDmMessages,
    applySyncedDmPeerNames,
    clearAllDms,
  } = useDirectMessages({
    pool,
    identityManager,
    presenceTracker,
    dmRelays: relaySelection.dmRelays,
    activeGeohash,
    activeDmPeer,
    blockedPubkeys: blockedSet,
    identityVersion,
    onIncomingDm: (senderHandle, preview) => {
      pushToast('info', `Encrypted DM from ${senderHandle}`, preview)
    },
    onNotifyPushPoke: handlePushPoke,
    onError: (title, detail, retryMessageId) => {
      pushToast('error', title, detail, retryMessageId)
    },
  })

  const activeDmThread = useMemo(
    () => (activeDmPeer ? visibleDmThreads.find((t) => t.peerPubkey === activeDmPeer.toLowerCase()) ?? null : null),
    [activeDmPeer, visibleDmThreads]
  )

  // The public channel composer must never see a private reply target.
  const [dmReply, setDmReply] = useState<{ peer: string; message: GeoMessage } | null>(null)
  const dmReplyingTo = activeDmPeer && dmReply?.peer === activeDmPeer &&
    activeDmThread?.messages.some(m => m.id === dmReply.message.id) ? dmReply.message : null
  const setDmReplyingTo = useCallback((message: GeoMessage | null) => {
    setDmReply(message && activeDmPeer ? { peer: activeDmPeer, message } : null)
  }, [activeDmPeer])
  useEffect(() => { setDmReply(null) }, [activeDmPeer, identityVersion])

  const handleSeedMemoTranscript = useCallback(
    (memoKey: string, text: string, modelLabel?: string) => {
      seedMemoTranscriptRef.current(memoKey, text, modelLabel)
    },
    []
  )

  const handleSeedVoiceBlob = useCallback(
    (
      attachment: VoiceMemoAttachment,
      blob: Blob,
      senderPubkey: string,
      adoptObjectUrl?: string
    ): string | void => {
      return voiceCacheRef.current?.seedBlob(attachment, blob, senderPubkey, adoptObjectUrl)
    },
    []
  )

  // Client-side Cashu Ecash Wallet + Boltz Swaps + NIP-57 Lightning Zaps
  const walletEngine = useCashuWallet({
    pushToast,
  })

  const getZapPublishRelayUrls = useCallback(
    () =>
      Array.from(
        new Set([
          ...relaySelectionRef.current.dmRelays,
          ...relaySelectionRef.current.channelRelays,
          ...activeServerRelaysRef.current,
        ])
      ),
    []
  )

  const zapsEngine = useZaps({
    relayPool: pool,
    identityManager,
    wallet: walletEngine,
    masterPubkey: identity.masterPubkey,
    getPublishRelayUrls: getZapPublishRelayUrls,
    ownPubkeys,
    activeNickname: identity.nickname,
    pushToast,
  })

  useLayoutEffect(() => {
    zapsIngestEventTagsRef.current = zapsEngine.ingestEventTags
  }, [zapsEngine.ingestEventTags])

  // Group Servers (Instant Virtual Public/E2EE + NIP-29 Relay Communities)
  const {
    engine: serversEngine,
    activeServerRelays,
    applySyncedJoinedServers,
    mergeSyncedServerMessages,
    resetAllServers,
  } = useServers({
    pool,
    identityManager,
    presenceTracker,
    activeView,
    setActiveView,
    activeGeohash,
    ownPubkeys,
    blockedSet,
    trustedSet,
    settings,
    blossomServers,
    lightningAddress: zapsEngine.lightningAddress,
    onIngestEventTags: zapsEngine.ingestEventTags,
    setVoiceSendPhase: setServerVoiceSendPhase,
    onSeedMemoTranscript: handleSeedMemoTranscript,
    onSeedVoiceBlob: handleSeedVoiceBlob,
    onNotifyPushPoke: handlePushPoke,
    sendDirectMessage,
    pushToast,
  })

  // P2P WebRTC Voice & Video Calls (1-on-1 DM Calls + Server Group Calls up to 6)
  const getCallPeerNickname = useCallback(
    (pk: string): string | undefined => {
      const lower = pk.toLowerCase()
      const dm = dmThreads.find((t) => t.peerPubkey === lower)
      if (dm?.peerNickname) return dm.peerNickname
      const trusted = trustedPubkeys.find((t) => t.pubkey === lower)
      if (trusted?.label) return trusted.label
      return presenceTracker.getNickname(lower) ?? undefined
    },
    [dmThreads, trustedPubkeys, presenceTracker]
  )

  const checkExplicitlyTrusted = useCallback(
    (pk: string) => trustedSetRef.current.has(pk.toLowerCase()),
    []
  )

  const pinnedGeohashList = useMemo(
    () => pinnedChannels.map((p) => p.geohash),
    [pinnedChannels]
  )

  // On-device AI Content Filtering (LiquidAI/d1-2B-ONNX via WebGPU/WASM)
  const contentFilterEngine = useContentFilter({
    ownPubkeys,
    trustedSet,
    blockedSet,
    pushToast,
  })

  // On-device AI Translation (onnx-community/LFM3-1.7B-ONNX via WebGPU/WASM)
  const translatorEngine = useTranslator({
    pushToast,
  })

  // Allow untrusted group-call WebRTC connections ONLY when user explicitly opted into AI video screening
  const allowScreenedUntrustedGroupCalls = Boolean(
    contentFilterEngine.settings.enabled &&
      (contentFilterEngine.settings.filterNsfw || contentFilterEngine.settings.filterIllegal) &&
      (contentFilterEngine.settings.callVideoMode === 'screen-untrusted' ||
        contentFilterEngine.settings.callVideoMode === 'screen-all')
  )

  const {
    calls: callsEngine,
    callSignalingRelays,
    resetAllCalls,
  } = useCallEngine({
    pool,
    identityManager,
    servers: serversEngine.joinedServers,
    activeGeohash,
    pinnedGeohashes: pinnedGeohashList,
    identityVersion,
    blockedSet,
    trustedSet,
    isExplicitlyTrusted: checkExplicitlyTrusted,
    allowScreenedUntrustedGroupCalls,
    strictWhitelistMode: settings.strictWhitelistMode,
    getPeerNickname: getCallPeerNickname,
    onNotifyPushPoke: handlePushPoke,
    pushToast,
  })

  const { games: gamesEngine, resetAllGames } = useGameEngine({
    pool,
    identityManager,
    servers: serversEngine.joinedServers,
    activeGeohash,
    identityVersion,
    blockedSet,
    getPeerNickname: getCallPeerNickname,
    onIncomingInvite: (invite) => {
      const label =
        invite.kind === 'chess'
          ? 'Chess'
          : `Go ${invite.goConfig?.boardSize ?? 19}×${invite.goConfig?.boardSize ?? 19}`
      pushToast('info', `${invite.fromDisplayName} invited you to ${label}`)
    },
    pushToast,
  })

  // Agmail — E2EE Store-and-Forward Meshnet Mail
  const notifyAmailChangedRef = useRef<() => void>(() => {})
  const handleAmailLocalChange = useCallback(() => {
    notifyAmailChangedRef.current()
  }, [])
  const handleIncomingAmail = useCallback(
    (input: NotifyAmailInput) => notifyAmailRef.current(input),
    []
  )

  const amailEngine = useAmail({
    relayPool: pool,
    identityManager,
    masterPubkey: identity.masterPubkey,
    activeNickname: identity.nickname,
    trustedPubkeys,
    blockedPubkeys,
    blossomServers,
    turnConfig: callsEngine.turnConfig,
    onLocalChange: handleAmailLocalChange,
    onIncomingMail: handleIncomingAmail,
    onNotifyPushPoke: handlePushPoke,
    pushToast,
  })

  const setNicknameRef = useRef<(nick: string) => void>(() => {})
  const handleAgoraProfileNameSaved = useCallback((name: string) => {
    setNicknameRef.current(name)
  }, [])
  const handleIncomingAgora = useCallback((input: NotifyAgoraInput) => {
    notifyAgoraRef.current(input)
  }, [])

  // Agora — Lazy-activated Nostr public social engine (NIP-01/02/10/18/19/25/27/36/50/51/57/65/92)
  const agoraEngine = useAgora({
    relayPool: pool,
    identityManager,
    masterPubkey: identity.masterPubkey,
    blockedSet,
    customRelays,
    blossomServers,
    pushToast,
    onDiscoverProfileLud16: zapsEngine.ingestPeerLightningAddress,
    onProfileNameSaved: handleAgoraProfileNameSaved,
    onNotifyAgora: handleIncomingAgora,
    onNotifyPushPoke: handlePushPoke,
  })

  // Verified kind: 0 profile pictures strictly keyed by exact pubkey
  const getProfilePicture = useCallback(
    (pubkey: string): string | undefined => {
      if (typeof pubkey !== 'string') return undefined
      const pk = pubkey.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pk)) return undefined
      const raw = agoraEngine.profilesByPubkey[pk]?.picture
      if (typeof raw !== 'string') return undefined
      const trimmed = raw.trim()
      if (!trimmed || !/^https:\/\//i.test(trimmed)) return undefined
      try {
        const parsed = new URL(trimmed)
        return parsed.protocol === 'https:' ? parsed.toString() : undefined
      } catch {
        return undefined
      }
    },
    [agoraEngine.profilesByPubkey]
  )

  const myMasterPkLower = identity.masterPubkey.toLowerCase()
  const hasLoadedOwnAgoraProfile = Boolean(agoraEngine.profilesByPubkey[myMasterPkLower])
  const myVerifiedPicture = getProfilePicture(myMasterPkLower)

  useEffect(() => {
    if (!/^[0-9a-f]{64}$/.test(myMasterPkLower)) return
    const prevPk = lastSyncedMasterPubkeyRef.current
    const rotatedInPlace = Boolean(prevPk && prevPk !== myMasterPkLower)
    lastSyncedMasterPubkeyRef.current = myMasterPkLower
    const updated = syncActiveProfileMetadata({
      pubkey: myMasterPkLower,
      npub: identity.masterNpub,
      nickname: identity.nickname,
      ...(myVerifiedPicture
        ? { picture: myVerifiedPicture }
        : hasLoadedOwnAgoraProfile
          ? { picture: null }
          : {}),
      signMode: identity.signMode,
      ...(rotatedInPlace ? { prevPubkey: prevPk } : {}),
    })
    setStoredProfiles(updated)
  }, [
    myMasterPkLower,
    identity.masterNpub,
    identity.nickname,
    identity.signMode,
    myVerifiedPicture,
    hasLoadedOwnAgoraProfile,
  ])

  const switchProfile = useCallback(
    async (targetPubkey: string): Promise<void> => {
      const tgt = targetPubkey.trim().toLowerCase()
      const cur = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      if (!tgt || tgt === cur || profileSwitchingRef.current) return
      profileSwitchingRef.current = true
      setProfileSwitching(true)
      try {
        resetAllGames()
        const ok = await switchToProfile(cur, tgt)
        if (!ok) {
          profileSwitchingRef.current = false
          setProfileSwitching(false)
          pushToast('error', 'Profile switch failed', 'Selected profile could not be loaded.')
        }
      } catch (err) {
        profileSwitchingRef.current = false
        setProfileSwitching(false)
        pushToast(
          'error',
          'Profile switch failed',
          err instanceof Error ? err.message : 'Unable to switch profiles.'
        )
      }
    },
    [identityManager, pushToast, resetAllGames]
  )

  const createProfile = useCallback(
    async (opts?: { nickname?: string }): Promise<ProfileAccountRecord | null> => {
      if (profileSwitchingRef.current) return null
      profileSwitchingRef.current = true
      setProfileSwitching(true)
      try {
        const cur = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
        return await createAndSwitchProfile(cur, opts)
      } catch (err) {
        profileSwitchingRef.current = false
        setProfileSwitching(false)
        pushToast(
          'error',
          'Could not create profile',
          err instanceof Error ? err.message : 'Unable to initialize new profile.'
        )
        return null
      }
    },
    [identityManager, pushToast]
  )

  const importProfile = useCallback(
    async (
      secretInput: string,
      opts?: { nickname?: string }
    ): Promise<{ ok: boolean; error?: string; profile?: ProfileAccountRecord }> => {
      if (profileSwitchingRef.current) {
        return { ok: false, error: 'Profile switch already in progress.' }
      }
      profileSwitchingRef.current = true
      setProfileSwitching(true)
      try {
        const cur = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
        const res = await importAndSwitchProfile(cur, secretInput, opts)
        if (!res.ok || (res.profile && res.profile.id === cur)) {
          profileSwitchingRef.current = false
          setProfileSwitching(false)
        }
        return res
      } catch (err) {
        profileSwitchingRef.current = false
        setProfileSwitching(false)
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Unable to import private key.',
        }
      }
    },
    [identityManager]
  )

  const deleteProfile = useCallback(
    async (targetPubkey: string): Promise<boolean> => {
      if (profileSwitchingRef.current) return false
      const cur = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const tgt = targetPubkey.trim().toLowerCase()
      const deletingActive = tgt === cur
      if (deletingActive) {
        profileSwitchingRef.current = true
        setProfileSwitching(true)
      }
      try {
        const res = await deleteStoredProfile(cur, tgt)
        if (!res.reloaded) {
          setStoredProfiles(res.profiles)
          if (deletingActive) {
            profileSwitchingRef.current = false
            setProfileSwitching(false)
          }
          if (res.deleted) {
            pushToast(
              'info',
              'Profile removed',
              'Removed profile and its local data from this device.'
            )
          }
        }
        return res.deleted
      } catch (err) {
        if (deletingActive) {
          profileSwitchingRef.current = false
          setProfileSwitching(false)
        }
        pushToast(
          'error',
          'Could not remove profile',
          err instanceof Error ? err.message : 'Unable to delete stored profile.'
        )
        return false
      }
    },
    [identityManager, pushToast]
  )

  const ensureAgoraProfiles = agoraEngine.ensureProfiles
  const ensureProfilePictures = useCallback(
    (pubkeys: readonly string[]) => {
      const valid: string[] = []
      for (const raw of pubkeys) {
        if (typeof raw !== 'string') continue
        const pk = raw.trim().toLowerCase()
        if (/^[0-9a-f]{64}$/.test(pk)) valid.push(pk)
      }
      if (valid.length > 0) {
        ensureAgoraProfiles(valid)
      }
    },
    [ensureAgoraProfiles]
  )

  const uploadAgoraMedia = agoraEngine.uploadMedia
  const updateAgoraProfile = agoraEngine.updateMyProfile
  const getAgoraProfile = agoraEngine.getProfile
  const updateMyProfilePicture = useCallback(
    async (
      fileOrUrl: File | string | null
    ): Promise<{ ok: boolean; error?: string; pictureUrl?: string }> => {
      let nextUrl = ''
      if (fileOrUrl instanceof File) {
        const mime = (fileOrUrl.type || '').toLowerCase()
        if (!mime.startsWith('image/')) {
          return { ok: false, error: 'Please select an image file.' }
        }
        try {
          const uploaded = await uploadAgoraMedia(fileOrUrl, {
            alt: 'Profile picture',
            mime: fileOrUrl.type,
          })
          const cleanUploaded = uploaded.url.trim()
          if (!/^https:\/\//i.test(cleanUploaded)) {
            return { ok: false, error: 'Uploaded image URL must use HTTPS.' }
          }
          nextUrl = new URL(cleanUploaded).toString()
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to upload profile picture.'
          return { ok: false, error: msg }
        }
      } else if (typeof fileOrUrl === 'string') {
        const trimmed = fileOrUrl.trim()
        if (trimmed.length > 0) {
          if (!/^https:\/\//i.test(trimmed)) {
            return { ok: false, error: 'Profile picture URL must start with https://.' }
          }
          try {
            const parsed = new URL(trimmed)
            if (parsed.protocol !== 'https:') {
              return { ok: false, error: 'Profile picture URL must use HTTPS.' }
            }
            nextUrl = parsed.toString()
          } catch {
            return { ok: false, error: 'Invalid profile picture URL.' }
          }
        }
      }

      const masterPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const existing = getAgoraProfile(masterPk)
      const res = await updateAgoraProfile({
        name: existing?.name || identityManager.getNickname(),
        displayName: existing?.displayName,
        about: existing?.about,
        banner: existing?.banner,
        nip05: existing?.nip05,
        lud16: existing?.lud16,
        website: existing?.website,
        picture: nextUrl,
      })
      if (!res.ok) {
        return { ok: false, error: res.error ?? 'Failed to publish profile update.' }
      }
      return { ok: true, pictureUrl: nextUrl || undefined }
    },
    [identityManager, uploadAgoraMedia, updateAgoraProfile, getAgoraProfile]
  )

  // Silent Multi-Device Same-Key Background Sync (NIP-44 self-encrypted CRDT + delta messages)
  const getDeviceSyncRelayUrls = useCallback(
    () =>
      Array.from(
        new Set([
          ...CALL_SIGNALING_RELAYS,
          ...CORE_DM_RELAYS,
          ...relaySelectionRef.current.dmRelays,
          ...relaySelectionRef.current.channelRelays,
        ])
      ),
    []
  )

  const handleApplySyncedTrusted = useCallback(
    (nextTrusted: TrustedPeerEntry[]) => {
      trustedSetRef.current = new Set(nextTrusted.map((t) => t.pubkey.toLowerCase()))
      setTrustedPubkeys(nextTrusted)
      saveTrustedPubkeys(nextTrusted)
      recomputeGeoUnreads()
      refreshPeers(activeGeohashRef.current)
    },
    [recomputeGeoUnreads, refreshPeers]
  )

  const handleApplySyncedBlocked = useCallback(
    (nextBlocked: string[], syncedBlockedNames?: Record<string, string>) => {
      const prevSet = blockedSetRef.current
      const normalized = Array.from(new Set(nextBlocked.map((p) => p.toLowerCase())))
      const nextSet = new Set(normalized)
      blockedSetRef.current = nextSet
      setBlockedPubkeys(normalized)
      saveBlockedPubkeys(normalized)

      const mergedNames: Record<string, string> = {}
      for (const pk of normalized) {
        const incoming =
          typeof syncedBlockedNames?.[pk] === 'string'
            ? syncedBlockedNames[pk].trim().slice(0, 64)
            : ''
        const existing = blockedPeerNamesRef.current[pk]?.trim().slice(0, 64) ?? ''
        const chosen = incoming || existing
        if (chosen) {
          mergedNames[pk] = chosen
        }
      }
      blockedPeerNamesRef.current = mergedNames
      setBlockedPeerNames(mergedNames)
      saveBlockedPeerNames(mergedNames)

      const newlyBlocked = normalized.filter((pk) => !prevSet.has(pk))
      const newlyUnblocked = Array.from(prevSet).filter((pk) => !nextSet.has(pk))
      if (newlyBlocked.length > 0 || newlyUnblocked.length > 0) {
        const newlyBlockedSet = new Set(newlyBlocked)
        const newlyUnblockedSet = new Set(newlyUnblocked)
        for (const pk of newlyBlocked) {
          scrubBlockedPubkeyFromChannelStorage(pk, identityManager.getMasterKeyMaterial().pubkey.toLowerCase())
        }
        setChannelMessagesState((curr) => {
          let changed = false
          const nextItems: GeoMessage[] = []
          for (const m of curr.items) {
            if (m.isSystem) {
              nextItems.push(m)
              continue
            }
            const mpk = m.pubkey.toLowerCase()
            if (m.isBlockedPlaceholder) {
              if (newlyUnblockedSet.has(mpk)) {
                changed = true
                continue
              }
              nextItems.push(m)
              continue
            }
            if (newlyBlockedSet.has(mpk)) {
              changed = true
              nextItems.push({
                id: m.id,
                geohash: m.geohash,
                pubkey: mpk,
                nickname: m.nickname,
                displayHandle: m.displayHandle,
                content: '',
                createdAt: m.createdAt,
                tags: [],
                isOwn: false,
                isBlockedPlaceholder: true,
                isTeleported: false,
                isMeshBridge: false,
                powBits: 0,
                reactions: [],
                mentions: [],
              })
              continue
            }
            nextItems.push(m)
          }
          if (!changed) return curr
          saveChannelMessages(curr.channelKey, nextItems, identityManager.getMasterKeyMaterial().pubkey.toLowerCase())
          return { channelKey: curr.channelKey, items: nextItems }
        })
        if (newlyBlocked.length > 0) {
          setLocationNotesState((curr) => {
            const filtered = curr.items.filter((n) => !newlyBlockedSet.has(n.pubkey.toLowerCase()))
            if (filtered.length === curr.items.length) return curr
            return { channelKey: curr.channelKey, items: filtered }
          })
          for (const pk of newlyBlocked) {
            voiceCacheRef.current?.revokeForSender(pk)
            contentFilterEngine.revokeForSender(pk)
          }
        }
      }
      recomputeGeoUnreads()
      refreshPeers(activeGeohashRef.current)
    },
    [contentFilterEngine, identityManager, recomputeGeoUnreads, refreshPeers]
  )

  const handleApplySyncedPinned = useCallback((nextPinned: PinnedChannel[]) => {
    const hydrated = nextPinned.map((p) => ({
      ...p,
      unreadCount: geoUnreadCountsRef.current[p.geohash] ?? 0,
      mentionCount: geoMentionCountsRef.current[p.geohash] ?? 0,
    }))
    setPinnedChannels(hydrated)
    savePinnedChannels(hydrated)
  }, [])

  const zapsLightningAddressRef = useRef<string | null>(zapsEngine.lightningAddress)
  const zapsSetLightningAddressRef = useRef(zapsEngine.setLightningAddress)
  useLayoutEffect(() => {
    zapsLightningAddressRef.current = zapsEngine.lightningAddress
    zapsSetLightningAddressRef.current = zapsEngine.setLightningAddress
  }, [zapsEngine.lightningAddress, zapsEngine.setLightningAddress])

  const handleApplySyncedLightningAddress = useCallback((addr: string | null) => {
    const normalized = addr?.trim() || null
    if (normalized === (zapsLightningAddressRef.current?.trim() || null)) return
    void zapsSetLightningAddressRef.current(normalized)
  }, [])

  const handleApplySyncedNickname = useCallback(
    (nick: string) => {
      const clean = nick.trim().slice(0, 32)
      if (!clean || clean === identityManager.getNickname()) return
      identityManager.setNickname(clean)
      saveNickname(identityManager.getNickname())
      setIdentityVersion((v) => v + 1)
    },
    [identityManager]
  )

  const handleMergeSyncedBitchatMessages = useCallback(
    (channelKey: string, incoming: GeoMessage[]): number => {
      const gh = normalizeBitchatChannelKey(channelKey)
      if (!gh || incoming.length === 0) return 0

      const validIncoming: GeoMessage[] = []
      for (const raw of incoming) {
        if (!raw || raw.isSystem || typeof raw.id !== 'string' || !raw.id) continue
        if (isStuckMediaPlaceholder(raw) || isEphemeralPendingMessage(raw)) continue
        const msgKey = normalizeBitchatChannelKey(raw.geohash)
        if (msgKey !== gh) continue
        const pk = (raw.pubkey || '').toLowerCase()
        if (!/^[0-9a-f]{64}$/.test(pk)) continue
        if (blockedSetRef.current.has(pk)) continue
        validIncoming.push({
          ...raw,
          geohash: gh,
          pubkey: pk,
          isOwn: ownPubkeysRef.current.has(pk),
        })
      }
      if (validIncoming.length === 0) return 0

      let addedCount = 0
      updateChannelMessages(
        gh,
        (prev) => {
          const seen = new Set(prev.map((m) => m.id))
          const toAdd = validIncoming.filter((m) => !seen.has(m.id))
          if (toAdd.length === 0) return null
          addedCount = toAdd.length
          return backfillReplyReferences(
            sortChannelMessagesWithPending([...prev, ...toAdd], 'pending-bitchat-')
          )
        },
        { persist: true, allowBackgroundPersist: true }
      )
      const sortedSynced = sortChannelMessagesWithPending(validIncoming, 'pending-bitchat-')
      const latestSynced = extractLatestVisiblePreview(
        sortedSynced,
        blockedSetRef.current,
        trustedSetRef.current,
        ownPubkeysRef.current,
        strictWhitelistRef.current
      )
      if (latestSynced) {
        upsertChannelPreview(gh, {
          id: latestSynced.id,
          preview: latestSynced.preview,
          sender: latestSynced.sender,
          senderPubkey: latestSynced.senderPubkey,
          createdAt: latestSynced.createdAt,
        })
        recordRoomMessage({
          id: latestSynced.id,
          geohash: gh,
          pubkey: latestSynced.senderPubkey,
          sender: latestSynced.sender,
          preview: latestSynced.preview,
          createdAtSec: latestSynced.createdAt,
        })
      }
      return addedCount
    },
    [updateChannelMessages, upsertChannelPreview, recordRoomMessage]
  )

  const setPeerNote = useCallback((pubkeyOrNpub: string, rawNote: string) => {
    const pk = decodePubkeyInput(pubkeyOrNpub)
    if (!pk) return
    const clean = rawNote.trim().slice(0, 400)
    setPeerNotes((prev) => {
      const existing = prev[pk] ?? ''
      if (existing === clean) return prev
      const next = { ...prev }
      if (clean) {
        next[pk] = clean
      } else {
        delete next[pk]
      }
      savePeerNotes(next)
      return next
    })
  }, [])

  const handleApplySyncedPeerNotes = useCallback((nextNotes: Record<string, string>) => {
    const clean: Record<string, string> = {}
    for (const [rawPk, rawText] of Object.entries(nextNotes)) {
      const pk = rawPk.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pk) || typeof rawText !== 'string') continue
      const trimmed = rawText.trim().slice(0, 400)
      if (trimmed) clean[pk] = trimmed
    }
    setPeerNotes(clean)
    savePeerNotes(clean)
  }, [])

  const handleApplySyncedDmPeerNames = useCallback(
    (namesByPubkey: Record<string, string>) => {
      applySyncedDmPeerNames(namesByPubkey)
    },
    [applySyncedDmPeerNames]
  )

  const notifyCallTranscriptsChangedRef = useRef<() => void>(() => {})
  const handleCallTranscriptsLocalChange = useCallback(() => {
    notifyCallTranscriptsChangedRef.current()
  }, [])

  const {
    deviceSync: deviceSyncEngine,
    registerAmailSyncProvider,
    notifyAmailChanged,
    registerCallTranscriptSyncProvider,
    notifyCallTranscriptsChanged,
  } = useDeviceSync({
    relayPool: pool,
    identityManager,
    identityVersion,
    masterPubkey: identity.masterPubkey,
    nickname: identity.nickname,
    getSyncRelayUrls: getDeviceSyncRelayUrls,
    joinedServers: serversEngine.joinedServers,
    trustedPubkeys,
    blockedPubkeys,
    blockedPeerNames,
    pinnedChannels,
    dmClearedAt,
    lightningAddress: zapsEngine.lightningAddress,
    peerNotes,
    dmThreads,
    activeGeohash,
    activeBitchatMessages: messages,
    activeServerMessages: serversEngine.messages,
    initialHealCheckpoint: (bootScrubbedCountRef.current ?? 0) > 0,
    onApplyServers: applySyncedJoinedServers,
    onApplyTrusted: handleApplySyncedTrusted,
    onApplyBlocked: handleApplySyncedBlocked,
    onApplyPinned: handleApplySyncedPinned,
    onApplyDmClearedAt: mergeSyncedDmClearedAt,
    onApplyLightningAddress: handleApplySyncedLightningAddress,
    onApplyNickname: handleApplySyncedNickname,
    onApplyPeerNotes: handleApplySyncedPeerNotes,
    onApplyDmPeerNames: handleApplySyncedDmPeerNames,
    onMergeDmMessages: mergeSyncedDmMessages,
    onMergeServerMessages: mergeSyncedServerMessages,
    onMergeBitchatMessages: handleMergeSyncedBitchatMessages,
  })

  useLayoutEffect(() => {
    notifyAmailChangedRef.current = notifyAmailChanged
  }, [notifyAmailChanged])

  useLayoutEffect(() => {
    notifyCallTranscriptsChangedRef.current = notifyCallTranscriptsChanged
  }, [notifyCallTranscriptsChanged])

  const exportAmailSyncState = amailEngine.exportSyncState
  const mergeAmailSyncState = amailEngine.mergeSyncState
  useEffect(() => {
    registerAmailSyncProvider({
      exportSyncState: exportAmailSyncState,
      mergeSyncState: (remote) =>
        mergeAmailSyncState(remote as Parameters<typeof mergeAmailSyncState>[0]),
    })
    return () => {
      registerAmailSyncProvider(null)
    }
  }, [registerAmailSyncProvider, exportAmailSyncState, mergeAmailSyncState])

  // Keep active geohash + DM + pulse + active server/NIP-29 + call signaling relays synced in RelayPool
  useLayoutEffect(() => {
    activeServerRelaysRef.current = activeServerRelays
  }, [activeServerRelays])

  useEffect(() => {
    if (!pool) return
    const keepUrls = new Set<string>([
      ...relaySelection.channelRelays,
      ...relaySelection.dmRelays,
      ...relaySelection.pulseRelays,
      ...activeServerRelays,
      ...callSignalingRelays,
    ])
    const combinedMeta = new Map(relaySelection.allMetadata)
    for (const url of [...activeServerRelays, ...callSignalingRelays]) {
      if (!combinedMeta.has(url)) {
        combinedMeta.set(url, { url, roles: ['custom'], supportsDm: false })
      }
    }
    pool.syncMetadata(combinedMeta, keepUrls)
  }, [pool, relaySelection, activeServerRelays, callSignalingRelays])

  // Wire NIP-42 AUTH responder onto RelayPool (auto-signs for NIP-29 relays)
  useEffect(() => {
    if (!pool) return
    pool.setAuthSigner(async (relayUrl, challenge) => {
      if (identityManager.getSignMode() === 'extension' && !activeServerRelaysRef.current.includes(relayUrl)) {
        return null
      }
      try {
        return await identityManager.signEvent(buildNip42AuthTemplate(relayUrl, challenge))
      } catch {
        return null
      }
    })
    return () => {
      pool.setAuthSigner(null)
    }
  }, [pool, identityManager])

  const presence = useMemo(() => {
    const rawPresenceKey = isTopicChannel(activeGeohash)
      ? activeGeohash
      : (getChannelRawGeohash(activeGeohash) ?? activeGeohash)
    return presenceTracker.getSummary(
      rawPresenceKey,
      peers,
      settings.presenceEnabled && identity.signMode !== 'extension'
    )
  }, [presenceTracker, activeGeohash, peers, settings.presenceEnabled, identity.signMode])

  // Channel navigation & pins
  useEffect(() => {
    if (activeView.type !== 'channel') return
    clearGeoUnread(activeView.geohash)
  }, [activeView, clearGeoUnread])

  const markChannelRead = useCallback((geohash?: string) => {
    const raw = geohash ?? activeGeohash
    const target = normalizeBitchatChannelKey(raw) ?? normalizeGeohash(raw)
    setUnreadDividerId(null)
    clearGeoUnread(target)
  }, [activeGeohash, clearGeoUnread])

  const applyTunedChannel = useCallback((channelKey: string) => {
    activeGeohashRef.current = channelKey
    setActiveGeohash(channelKey)
    setActiveView({ type: 'channel', geohash: channelKey })
    setUnreadDividerId(null)
    setRecentChannels((prev) => {
      const next = [channelKey, ...prev.filter((g) => g !== channelKey)].slice(0, 12)
      saveRecentChannels(next)
      return next
    })
    clearGeoUnread(channelKey)
  }, [clearGeoUnread])

  const tuneBitchatChannel = useCallback((channelKeyOrInput: string): boolean => {
    const direct = normalizeBitchatChannelKey(channelKeyOrInput)
    if (direct) {
      applyTunedChannel(direct)
      return true
    }
    const resolved = parseQuickTuneInput(channelKeyOrInput, 'geo')
    if (!resolved) {
      pushToast(
        'warning',
        'Invalid Bitchat channel',
        `"${channelKeyOrInput}" is not a valid geohash, city, or topic name.`
      )
      return false
    }
    applyTunedChannel(resolved.key)
    return true
  }, [applyTunedChannel, pushToast])

  const tuneTopicChannel = useCallback((rawSlug: string): boolean => {
    const topicKey = makeTopicChannelKey(rawSlug)
    if (!topicKey) {
      pushToast(
        'warning',
        'Invalid topic name',
        'Use 1–48 letters, numbers, hyphens, or underscores (e.g. bitcoin, nostr).'
      )
      return false
    }
    applyTunedChannel(topicKey)
    return true
  }, [applyTunedChannel, pushToast])

  const tuneGeohash = useCallback((geohashOrCity: string): boolean => {
    return tuneBitchatChannel(geohashOrCity)
  }, [tuneBitchatChannel])

  const locateMe = useCallback(async (): Promise<string | null> => {
    const gh = await rawLocateMe()
    if (gh) {
      tuneGeohash(gh)
      pushToast('success', `GPS locked to #${gh}`, 'Broadcasting local channel signal (not teleported).')
    } else {
      pushToast('warning', 'Location unavailable', 'Enable browser location permission or teleport manually.')
    }
    return gh
  }, [rawLocateMe, tuneGeohash, pushToast])

  const isChannelPinned = useCallback(
    (geohash: string) => {
      const key = normalizeBitchatChannelKey(geohash) ?? normalizeGeohash(geohash)
      return pinnedChannels.some((p) => p.geohash === key)
    },
    [pinnedChannels]
  )

  const togglePinChannel = useCallback(
    (geohash: string, label?: string) => {
      const gh = normalizeBitchatChannelKey(geohash)
      if (!gh) return
      setPinnedChannels((prev) => {
        const exists = prev.some((p) => p.geohash === gh)
        const next = exists
          ? prev.filter((p) => p.geohash !== gh)
          : [
              {
                geohash: gh,
                label,
                pinnedAt: Date.now(),
                unreadCount: geoUnreadCountsRef.current[gh] ?? 0,
                mentionCount: geoMentionCountsRef.current[gh] ?? 0,
              },
              ...prev,
            ]
        savePinnedChannels(next)
        return next
      })
    },
    []
  )

  const reorderPinnedChannels = useCallback((fromIndex: number, toIndex: number) => {
    setPinnedChannels((prev) => {
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= prev.length ||
        toIndex >= prev.length ||
        fromIndex === toIndex
      ) {
        return prev
      }
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      if (!moved) return prev
      next.splice(toIndex, 0, moved)
      savePinnedChannels(next)
      return next
    })
  }, [])

  const openDmThread = useCallback(
    (peerPubkey: string, nicknameHint?: string, preferredProtocol?: DmProtocol) => {
      const pk = peerPubkey.toLowerCase()
      ensureThread(pk, nicknameHint, preferredProtocol)
      setActiveView({ type: 'dm', peerPubkey: pk })
    },
    [ensureThread]
  )

  // Publish public Bitchat message (kind 20000 geohash or kind 23333 topic + optional NIP-13 PoW)
  const sendPublicContent = useCallback(
    async (
      rawText: string,
      replyOverride?: GeoMessage | null,
      onPublishedId?: (id: string) => void
    ): Promise<boolean> => {
      const content = rawText.trim()
      if (!content || !pool) return false

      // Synchronously capture channel, relays, reply target, signer metadata & append optimistic message
      // BEFORE awaiting the per-channel FIFO queue so rapid sends appear in exact 1 -> 2 -> 3 order.
      const gh = activeGeohashRef.current
      const targetRelays = [...relaySelectionRef.current.channelRelays]
      const isTopic = isTopicChannel(gh)
      const isNonEarth = isCelestialNonEarthChannel(gh)
      const nick = identityManager.getNickname()
      const activeKey = identityManager.getKeyMaterialForGeohash(gh)
      const replyTarget = replyOverride !== undefined ? replyOverride : replyingToRef.current
      const isTeleported = isTopic || isNonEarth ? false : location.isTeleported
      const broadcastClientTag = settings.broadcastClientTag
      const lightningAddr = zapsEngine.lightningAddress
      const powEnabled = settings.powEnabled
      const powTargetBits = settings.powTargetBits
      const wipeGen = identityManager.getWipeGeneration()

      if (replyOverride === undefined) {
        replyingToRef.current = null
        if (activeGeohashRef.current === gh) {
          setReplyingTo(null)
        }
      }

      const tempId = `pending-bitchat-${Date.now()}-${++optimisticBitchatSeqRef.current}`
      const nowSec = Math.floor(Date.now() / 1000)
      const activePk = activeKey.pubkey.toLowerCase()
      const optimisticBase: GeoMessage = {
        id: tempId,
        geohash: gh,
        pubkey: activePk,
        nickname: nick,
        displayHandle: formatDisplayHandle(nick, activePk),
        content,
        createdAt: nowSec,
        tags: [],
        isOwn: true,
        isTeleported: !isTopic && isTeleported,
        isMeshBridge: false,
        clientName: broadcastClientTag ? AGNOSTR_CLIENT_TAG : undefined,
        isAgnostrClient: broadcastClientTag,
        powBits: 0,
        replyTo:
          replyTarget && !replyTarget.isSystem
            ? {
                id: replyTarget.id,
                pubkey: replyTarget.pubkey,
                nickname: replyTarget.nickname,
                preview: replyTarget.content.slice(0, 120),
              }
            : undefined,
        reactions: [],
        mentions: extractMentions(content),
        deliveryStatus: 'sending',
      }

      onPublishedId?.(tempId)
      updateChannelMessages(
        gh,
        (prev) => {
          const lastSec = prev.length > 0 ? prev[prev.length - 1].createdAt : 0
          return [...prev, { ...optimisticBase, createdAt: Math.max(nowSec, lastSec) }]
        },
        { allowBackgroundPersist: true }
      )
      revealLocalBitchatSend(gh, tempId)
      const queueAttempt = async (attempt: () => Promise<boolean>) => {
        adjustInFlightSend(1)
        try {
          return await bitchatSendQueueRef.current.enqueue(`bitchat:${gh}`, attempt, () => false)
        } finally {
          adjustInFlightSend(-1)
        }
      }
      const attempt = async (): Promise<boolean> => {
        if (identityManager.getWipeGeneration() !== wipeGen) return false
        let activeMsgId = tempId
        try {
          updateChannelMessages(gh, (prev) => prev.map((m) =>
            m.id === tempId ? { ...m, deliveryStatus: 'sending' } : m
          ), { allowBackgroundPersist: true })
          const latestRelays = activeGeohashRef.current === gh ? relaySelectionRef.current.channelRelays : []
          const mesh = nearbyRef.current.api()
          const hasGateway = !isTopic && !isNonEarth && isGatewayGeohash(gh) && Boolean(mesh?.hasGateway())
          const directReady = !(hasGateway && typeof navigator !== 'undefined' && navigator.onLine === false) &&
            await pool.waitForChatRelay([...targetRelays, ...latestRelays])
          const viaGateway = !directReady && hasGateway
          if (!directReady && !viaGateway) {
            throw new Error('No connected relay or Bluetooth gateway is available.')
          }
          if (identityManager.getWipeGeneration() !== wipeGen) return false
          const template = isTopic
            ? buildNamedBitchatChatTemplate({
                content,
                topic: gh,
                nickname: nick,
                replyTo: replyTarget,
                broadcastClientTag,
                lightningAddress: lightningAddr,
              })
            : buildGeohashChatTemplate({
                content,
                geohash: gh,
                nickname: nick,
                isTeleported,
                replyTo: replyTarget,
                broadcastClientTag,
                lightningAddress: lightningAddr,
              })

          // Mine 8-bit NIP-13 PoW non-blocking when enabled and pubkey is known
          if (!viaGateway && powEnabled && powTargetBits > 0 && activeKey.pubkey) {
            const nonceTag = await mineNip13NonceTag(
              template,
              activeKey.pubkey,
              powTargetBits,
              450
            )
            if (nonceTag) {
              template.tags = [...template.tags, nonceTag]
            }
          }

          if (identityManager.getWipeGeneration() !== wipeGen) return false
          const signed = viaGateway ? mesh?.offlineEvent(template, gh) : await identityManager.signEvent(template, gh)
          if (!signed) throw new Error('Bluetooth gateway messages must be public text under 480 bytes.')
          if (identityManager.getWipeGeneration() !== wipeGen) return false

          if (viaGateway && !await mesh?.sendThroughGateway(signed, gh)) {
            throw new Error('No Bluetooth link queued your message. Try again when a gateway is nearby.')
          }
          if (identityManager.getWipeGeneration() !== wipeGen) return false
          activeMsgId = signed.id
          chatRetries.confirm(tempId)
          onPublishedId?.(signed.id)

          const findParent = (id: string) =>
            messagesChannelRef.current === gh
              ? messagesRef.current.find((m) => m.id === id)
              : undefined
          const parsed = isTopic
            ? parseNamedBitchatChatEvent(signed, gh, ownPubkeysRef.current, findParent)
            : parseGeohashChatEvent(signed, gh, ownPubkeysRef.current, findParent)

          if (parsed) {
            parsed.deliveryStatus = viaGateway ? undefined : 'sending'
            parsed.viaMeshGateway = viaGateway || undefined
            parsed.isOwn = true
            // Atomically promote tempId -> signed.id into confirmed messages BEFORE publishing,
            // keeping unconfirmed rows pinned at the tail.
            updateChannelMessages(
              gh,
              (prev) => swapPendingWithSigned(prev, tempId, parsed, 'pending-bitchat-'),
              { allowBackgroundPersist: true }
            )
          }

          if (viaGateway) return true

          return await publishChatWire({
            rowId: signed.id,
            publish: (ack) => pool.publish([...new Set([...targetRelays, ...(activeGeohashRef.current === gh ? relaySelectionRef.current.channelRelays : [])])], signed, undefined, ack),
            isCurrent: () => identityManager.getWipeGeneration() === wipeGen,
            queueRetry: queueAttempt,
            update: (deliveryStatus, relayCount) => updateChannelMessages(
              gh,
              (prev) => sortChannelMessagesWithPending(prev.map((m) =>
                m.id !== signed.id || (m.deliveryStatus === 'sent' && deliveryStatus !== 'sent')
                    ? m : { ...m, deliveryStatus, relayCount: Math.max(m.relayCount ?? 0, relayCount) }
              ), 'pending-bitchat-'),
              { allowBackgroundPersist: true }
            ),
            onFailure: (reason) => pushToast('error', 'Failed to broadcast message', reason, signed.id),
            onSuccess: () => {
              if (parsed) {
                const signedPreview = formatBitchatPreviewText({
                  content: parsed.content,
                  hasImage: Boolean(parsed.imageAttachment),
                  hasVoice: Boolean(parsed.voiceMemo),
                  mediaUrl: parsed.imageAttachment?.url ?? parsed.voiceMemo?.url,
                  tags: signed.tags,
                })
                if (signedPreview) {
                  upsertChannelPreview(
                    gh,
                    {
                      id: parsed.id,
                      replaceId: tempId,
                      preview: signedPreview,
                      sender: parsed.nickname || nick,
                      senderPubkey: parsed.pubkey,
                      createdAt: parsed.createdAt,
                    },
                    { force: activeGeohashRef.current === gh }
                  )
                  recordRoomMessage({
                    id: parsed.id,
                    replaceId: tempId,
                    geohash: gh,
                    pubkey: parsed.pubkey,
                    sender: parsed.nickname || nick,
                    preview: signedPreview,
                    createdAtSec: parsed.createdAt,
                    isAuthoritative: activeGeohashRef.current === gh,
                  })
                }
              }
              const pokeSet = new Set<string>()
              if (replyTarget && !replyTarget.isSystem && replyTarget.pubkey) {
                const rpk = replyTarget.pubkey.toLowerCase()
                if (/^[0-9a-f]{64}$/.test(rpk) && !ownPubkeysRef.current.has(rpk)) {
                  pokeSet.add(rpk)
                }
              }
              const contentMentions = extractMentions(content)
              if (contentMentions.length > 0) {
                const roomPeers = presenceTracker.getPeers(
                  gh,
                  ownPubkeysRef.current,
                  blockedSetRef.current
                )
                for (const peer of roomPeers) {
                  const ppk = peer.pubkey.toLowerCase()
                  if (peer.isSelf || ownPubkeysRef.current.has(ppk)) continue
                  if (doesContentMentionUser(content, contentMentions, peer.nickname, ppk)) {
                    pokeSet.add(ppk)
                  }
                }
              }
              if (pokeSet.size > 0) {
                handlePushPoke({
                  recipientPubkeys: Array.from(pokeSet),
                  category: 'geo-message',
                  isMention: true,
                  eventId: signed.id,
                  geohash: gh,
                  senderName: nick,
                  preview: content.slice(0, 110),
                })
              }
            },
          })
        } catch (err) {
          if (identityManager.getWipeGeneration() === wipeGen) {
            if (activeMsgId === tempId) chatRetries.hold(tempId, () => queueAttempt(attempt))
            updateChannelMessages(
              gh,
              (prev) => {
                let changed = false
                const next = prev.map((m) => {
                  if ((m.id !== activeMsgId && m.id !== tempId) || m.deliveryStatus === 'sent') return m
                  changed = true
                  return {
                    ...m,
                    deliveryStatus: 'failed' as GeoMessage['deliveryStatus'],
                  }
                })
                return changed ? next : null
              },
              { allowBackgroundPersist: true }
            )
            pushToast(
              'error',
              'Message failed to send',
              err instanceof Error ? err.message : 'Unable to sign event.',
              tempId
            )
          }
          return false
        }
      }
      return await queueAttempt(attempt)
    },
    [
      pool,
      identityManager,
      location.isTeleported,
      settings.powEnabled,
      settings.powTargetBits,
      settings.broadcastClientTag,
      zapsEngine.lightningAddress,
      updateChannelMessages,
      revealLocalBitchatSend,
      upsertChannelPreview,
      recordRoomMessage,
      adjustInFlightSend,
      presenceTracker,
      handlePushPoke,
      pushToast,
    ]
  )

  const sendReaction = useCallback(
    async (message: GeoMessage, emoji: string): Promise<void> => {
      if (!pool || message.isSystem) return
      const cleanEmoji = emoji.trim()
      if (!cleanEmoji) return

      const gh = normalizeBitchatChannelKey(message.geohash) ?? activeGeohashRef.current
      const targets = Array.from(new Set([...relaySelection.dmRelays, ...relaySelection.channelRelays]))
      const template = buildReactionTemplate({
        geohash: gh,
        targetEventId: message.id,
        targetPubkey: message.pubkey,
        emoji: cleanEmoji,
        broadcastClientTag: settings.broadcastClientTag,
      })

      try {
        const signed = await identityManager.signEvent(template, gh)
        const myPk = signed.pubkey.toLowerCase()

        // Optimistic reaction update (scoped strictly to message's own channel)
        updateChannelMessages(
          gh,
          (prev) => {
            let changed = false
            const next = prev.map((m) => {
              if (m.id !== message.id) return m
              const idx = m.reactions.findIndex((r) => r.emoji === cleanEmoji)
              if (idx !== -1) {
                if (m.reactions[idx].pubkeys.includes(myPk)) return m
                changed = true
                const pubkeys = [...m.reactions[idx].pubkeys, myPk]
                const copy = [...m.reactions]
                copy[idx] = { emoji: cleanEmoji, count: pubkeys.length, pubkeys, reactedByMe: true }
                return { ...m, reactions: copy }
              }
              changed = true
              return {
                ...m,
                reactions: [...m.reactions, { emoji: cleanEmoji, count: 1, pubkeys: [myPk], reactedByMe: true }],
              }
            })
            return changed ? next : null
          },
          { allowBackgroundPersist: true }
        )

        await pool.publish(targets, signed, 3500)
      } catch (err) {
        pushToast('error', 'Reaction failed', err instanceof Error ? err.message : 'Could not sign reaction.')
      }
    },
    [pool, identityManager, relaySelection.dmRelays, relaySelection.channelRelays, settings.broadcastClientTag, updateChannelMessages, pushToast]
  )

  const postLocationNote = useCallback(
    async (rawContent: string): Promise<boolean> => {
      const content = rawContent.trim()
      if (!content || !pool) return false
      const gh = activeGeohashRef.current
      if (isTopicChannel(gh)) {
        pushToast(
          'warning',
          'Dead-drop notes are geohash-only',
          'Switch to a geohash channel to drop a 24h location note.'
        )
        return false
      }
      try {
        const template = buildLocationNoteTemplate({
          geohash: gh,
          nickname: identityManager.getNickname(),
          content,
          broadcastClientTag: settings.broadcastClientTag,
        })
        const signed = await identityManager.signEvent(template, gh)
        const res = await pool.publish(relaySelection.dmRelays, signed)
        const ok = res.acceptedRelays.length > 0
        if (ok) {
          const parsed = parseLocationNoteEvent(signed, gh, ownPubkeysRef.current)
          if (parsed) {
            setLocationNotesState((prev) => {
              if (activeGeohashRef.current !== gh) return prev
              const base = prev.channelKey === gh ? prev.items : []
              return {
                channelKey: gh,
                items: [parsed, ...base.filter((n) => n.id !== parsed.id)],
              }
            })
          }
          pushToast('success', `Note dropped in #${gh}`, `Pinned across ${res.acceptedRelays.length} relays (24h).`)
        } else {
          pushToast('error', 'Dead-drop failed', 'No relay accepted the location note.')
        }
        return ok
      } catch (err) {
        pushToast('error', 'Failed to drop note', err instanceof Error ? err.message : 'Signing error')
        return false
      }
    },
    [pool, identityManager, relaySelection.dmRelays, settings.broadcastClientTag, pushToast]
  )

  const refreshLocationNotes = useCallback(() => {
    setNotesRefreshNonce((n) => n + 1)
  }, [])

  const clearCurrentTimeline = useCallback(() => {
    if (activeView.type === 'dm') {
      clearThread(activeView.peerPubkey)
      pushToast('info', 'DM cleared', 'Local conversation messages cleared.')
      return
    }
    if (activeView.type === 'server') {
      serversEngine.clearChannelCache()
      pushToast('info', 'Channel cleared', 'Local group channel cache cleared.')
      return
    }
    const gh = activeGeohashRef.current
    const ghKey = gh.toLowerCase()
    setChannelMessagesState({ channelKey: gh, items: [] })
    setUnreadDividerId(null)
    clearChannelMessagesStorage(gh, identityManager.getMasterKeyMaterial().pubkey.toLowerCase())
    setChannelHistoryEpoch((n) => n + 1)
    setChannelPreviews((prev) => {
      if (!(ghKey in prev)) return prev
      const next = { ...prev }
      delete next[ghKey]
      return next
    })
    clearRoomMessages(ghKey)
  }, [activeView, clearThread, serversEngine, clearRoomMessages, identityManager, pushToast])

  // Moderation
  const isPeerBlocked = useCallback((pubkey: string) => blockedSet.has(pubkey.toLowerCase()), [blockedSet])

  const resolveBestBlockedLabel = useCallback(
    (pubkey: string, explicitLabel?: string): string | undefined => {
      const pk = pubkey.trim().toLowerCase()
      const clean = (raw?: string | null): string | undefined => {
        if (typeof raw !== 'string') return undefined
        const trimmed = raw.trim().slice(0, 64)
        return trimmed || undefined
      }
      const isGeneric = (val: string): boolean => {
        const lower = val.trim().toLowerCase()
        if (!lower) return true
        if (/^@?a(?:gn|n)on(?:[0-9a-f]{4})?(?:#[0-9a-f]{4})?$/i.test(lower)) return true
        const stripped = lower.replace(/^@/, '').replace(/#[0-9a-f]{4}$/i, '').trim()
        if (!stripped || isAutoAnonNickname(stripped)) return true
        if (/^#?[0-9a-f]{4,64}$/i.test(lower)) return true
        if (/^[0-9a-f]{4,16}[….]{1,3}[0-9a-f]{4,16}$/i.test(lower)) return true
        if (/^npub1[02-9ac-hj-np-z….]+$/i.test(lower)) return true
        if (pk && lower.length >= 6 && pk.startsWith(lower)) return true
        return false
      }
      const pickNonGeneric = (raw?: string | null): string | undefined => {
        const c = clean(raw)
        return c && !isGeneric(c) ? c : undefined
      }

      const explicitReal = pickNonGeneric(explicitLabel)
      if (explicitReal) return explicitReal

      const trackedPeer = presenceTracker.getPeerByPubkey(
        pk,
        ownPubkeysRef.current,
        blockedSetRef.current
      )
      const trackedReal =
        pickNonGeneric(trackedPeer?.displayHandle) ?? pickNonGeneric(trackedPeer?.nickname)
      if (trackedReal) return trackedReal

      const agoraProfile = agoraEngine.profilesByPubkey[pk]
      const agoraReal =
        pickNonGeneric(agoraProfile?.displayName) ?? pickNonGeneric(agoraProfile?.name)
      if (agoraReal) return agoraReal

      const dmThread = dmThreads.find((t) => t.peerPubkey.toLowerCase() === pk)
      const dmReal =
        pickNonGeneric(dmThread?.peerDisplayHandle) ?? pickNonGeneric(dmThread?.peerNickname)
      if (dmReal) return dmReal

      const serverMember = serversEngine.members.find((m) => m.pubkey.toLowerCase() === pk)
      const serverReal =
        pickNonGeneric(serverMember?.displayHandle) ?? pickNonGeneric(serverMember?.nickname)
      if (serverReal) return serverReal

      const streamMsg = messagesRef.current.find(
        (m) => !m.isSystem && m.pubkey.toLowerCase() === pk
      )
      const msgReal =
        pickNonGeneric(streamMsg?.displayHandle) ?? pickNonGeneric(streamMsg?.nickname)
      if (msgReal) return msgReal

      const trustedEntry = trustedPubkeys.find((t) => t.pubkey.toLowerCase() === pk)
      const trustedReal = pickNonGeneric(trustedEntry?.label)
      if (trustedReal) return trustedReal

      return clean(explicitLabel)
    },
    [
      presenceTracker,
      agoraEngine.profilesByPubkey,
      dmThreads,
      serversEngine.members,
      trustedPubkeys,
    ]
  )

  const toggleBlockPeer = useCallback(
    (pubkey: string, label?: string) => {
      const pk = pubkey.toLowerCase()
      const wasBlocked = blockedSetRef.current.has(pk)
      const resolvedLabel = !wasBlocked
        ? resolveBestBlockedLabel(pk, label)
        : (blockedPeerNamesRef.current[pk] ?? resolveBestBlockedLabel(pk, label))

      if (!wasBlocked) {
        if (resolvedLabel) {
          const nextNames = { ...blockedPeerNamesRef.current, [pk]: resolvedLabel }
          blockedPeerNamesRef.current = nextNames
          setBlockedPeerNames(nextNames)
          saveBlockedPeerNames(nextNames)
        }
      } else if (pk in blockedPeerNamesRef.current) {
        const nextNames = { ...blockedPeerNamesRef.current }
        delete nextNames[pk]
        blockedPeerNamesRef.current = nextNames
        setBlockedPeerNames(nextNames)
        saveBlockedPeerNames(nextNames)
      }

      setBlockedPubkeys((prev) => {
        const exists = prev.includes(pk)
        const next = exists ? prev.filter((p) => p !== pk) : [...prev, pk]
        blockedSetRef.current = new Set(next)
        saveBlockedPubkeys(next)
        if (!exists) {
          scrubBlockedPubkeyFromChannelStorage(pk, identityManager.getMasterKeyMaterial().pubkey.toLowerCase())
          setChannelMessagesState((curr) => {
            let changed = false
            const nextItems = curr.items.map((m) => {
              if (m.isSystem || m.pubkey.toLowerCase() !== pk) return m
              if (m.isBlockedPlaceholder) return m
              changed = true
              return {
                id: m.id,
                geohash: m.geohash,
                pubkey: pk,
                nickname: m.nickname,
                displayHandle: m.displayHandle,
                content: '',
                createdAt: m.createdAt,
                tags: [],
                isOwn: false,
                isBlockedPlaceholder: true,
                isTeleported: false,
                isMeshBridge: false,
                powBits: 0,
                reactions: [],
                mentions: [],
              }
            })
            if (!changed) return curr
            saveChannelMessages(curr.channelKey, nextItems, identityManager.getMasterKeyMaterial().pubkey.toLowerCase())
            return { channelKey: curr.channelKey, items: nextItems }
          })
          setLocationNotesState((curr) => {
            const filtered = curr.items.filter((n) => n.pubkey.toLowerCase() !== pk)
            if (filtered.length === curr.items.length) return curr
            return { channelKey: curr.channelKey, items: filtered }
          })
          // Synchronously revoke trust, cached media, unread counts & peer roster for this peer
          if (trustedSetRef.current.has(pk)) {
            const nextTrusted = new Set(trustedSetRef.current)
            nextTrusted.delete(pk)
            trustedSetRef.current = nextTrusted
          }
          voiceCacheRef.current?.revokeForSender(pk)
          contentFilterEngine.revokeForSender(pk)
          setTrustedPubkeys((trustedPrev) => {
            if (!trustedPrev.some((t) => t.pubkey === pk)) return trustedPrev
            const trimmed = trustedPrev.filter((t) => t.pubkey !== pk)
            saveTrustedPubkeys(trimmed)
            return trimmed
          })
          recomputeGeoUnreads()
          refreshPeers(activeGeohashRef.current)
          pushToast(
            'info',
            `Blocked ${resolvedLabel ?? label ?? pk.slice(0, 8)}`,
            'Their messages are now hidden.'
          )
        } else {
          setChannelMessagesState((curr) => {
            const filtered = curr.items.filter(
              (m) => !(m.isBlockedPlaceholder && m.pubkey.toLowerCase() === pk)
            )
            if (filtered.length === curr.items.length) return curr
            return { channelKey: curr.channelKey, items: filtered }
          })
          recomputeGeoUnreads()
          refreshPeers(activeGeohashRef.current)
          pushToast('info', `Unblocked ${resolvedLabel ?? label ?? pk.slice(0, 8)}`)
        }
        return next
      })
    },
    [resolveBestBlockedLabel, pushToast, recomputeGeoUnreads, refreshPeers, contentFilterEngine, identityManager]
  )

  const getPeerByPubkey = useCallback(
    (pubkey: string) => {
      const peer = presenceTracker.getPeerByPubkey(pubkey, ownPubkeys, blockedSet)
      if (!peer) return null
      return {
        ...peer,
        isTrusted: peer.isSelf || trustedSet.has(peer.pubkey),
      }
    },
    [presenceTracker, ownPubkeys, blockedSet, trustedSet]
  )

  // Whitelist-based receipt controls
  const isExplicitlyTrusted = useCallback(
    (pubkey: string) => trustedSet.has(pubkey.toLowerCase()),
    [trustedSet]
  )

  const isTrusted = useCallback(
    (pubkey: string) => {
      const pk = pubkey.toLowerCase()
      return ownPubkeys.has(pk) || trustedSet.has(pk)
    },
    [ownPubkeys, trustedSet]
  )

  const canLoadVoiceMemo = useCallback(
    (pubkey: string): boolean => {
      const pk = pubkey.trim().toLowerCase()
      if (!pk) return false
      if (ownPubkeys.has(pk)) return true
      if (blockedSet.has(pk)) return false
      if (trustedSet.has(pk)) return true
      return settings.allowUntrustedVoiceMemos && !settings.strictWhitelistMode
    },
    [
      ownPubkeys,
      blockedSet,
      trustedSet,
      settings.allowUntrustedVoiceMemos,
      settings.strictWhitelistMode,
    ]
  )

  const commitTrustPubkey = useCallback(
    (pk: string, cleanLabel?: string) => {
      // Synchronously update trustedSetRef before next render / child useEffect mounts
      if (!trustedSetRef.current.has(pk)) {
        const nextTrusted = new Set(trustedSetRef.current)
        nextTrusted.add(pk)
        trustedSetRef.current = nextTrusted
      }
      setTrustedPubkeys((prev) => {
        const existingIdx = prev.findIndex((t) => t.pubkey === pk)
        let next: TrustedPeerEntry[]
        if (existingIdx !== -1) {
          const updated: TrustedPeerEntry = {
            ...prev[existingIdx],
            label: cleanLabel ?? prev[existingIdx].label,
          }
          next = [...prev]
          next[existingIdx] = updated
        } else {
          const entry: TrustedPeerEntry = {
            pubkey: pk,
            npub: encodeNpubSafe(pk),
            label: cleanLabel,
            addedAt: Date.now(),
          }
          next = [entry, ...prev]
        }
        saveTrustedPubkeys(next)
        return next
      })
      setBlockedPubkeys((prev) => {
        if (!prev.includes(pk)) return prev
        const unblocked = prev.filter((p) => p !== pk)
        blockedSetRef.current = new Set(unblocked)
        saveBlockedPubkeys(unblocked)
        return unblocked
      })
      if (pk in blockedPeerNamesRef.current) {
        const nextNames = { ...blockedPeerNamesRef.current }
        delete nextNames[pk]
        blockedPeerNamesRef.current = nextNames
        setBlockedPeerNames(nextNames)
        saveBlockedPeerNames(nextNames)
      }
      pushToast(
        'success',
        `Trusted ${cleanLabel ?? `#${pk.slice(-6)}`}`,
        allowUntrustedVoiceMemosRef.current && !strictWhitelistRef.current
          ? 'Images and P2P calls from this peer are now unlocked.'
          : 'Images, voice memos, and P2P calls from this peer are now unlocked.'
      )
    },
    [pushToast]
  )

  const trustPubkey = useCallback(
    (pubkeyOrNpub: string, label?: string): boolean => {
      const pk = decodePubkeyInput(pubkeyOrNpub)
      if (!pk) {
        pushToast('warning', 'Invalid pubkey', 'Expected npub1… or 64-character hex pubkey.')
        return false
      }
      if (ownPubkeysRef.current.has(pk)) {
        return false
      }
      const pickRealName = (raw?: string | null): string | undefined => {
        const clean = raw?.trim().slice(0, 48)
        return clean && !isAutoAnonNickname(clean) ? clean : undefined
      }
      const dmNick = dmThreads.find((t) => t.peerPubkey === pk)?.peerNickname
      const serverNick = serversEngine.members.find((m) => m.pubkey === pk)?.nickname
      const msgNick = messagesRef.current.find((m) => m.pubkey.toLowerCase() === pk)?.nickname
      const callNick = callsEngine.activeCall?.participants.find(
        (p) => p.pubkey.toLowerCase() === pk
      )?.nickname
      const cleanLabel =
        pickRealName(label) ||
        pickRealName(presenceTracker.getNickname(pk)) ||
        pickRealName(dmNick) ||
        pickRealName(serverNick) ||
        pickRealName(msgNick) ||
        pickRealName(callNick) ||
        undefined

      // Already trusted: silently refresh label if better, no redundant confirmation modal
      if (trustedSetRef.current.has(pk)) {
        if (cleanLabel) {
          setTrustedPubkeys((prev) => {
            const idx = prev.findIndex((t) => t.pubkey === pk)
            if (idx === -1 || prev[idx].label === cleanLabel) return prev
            const next = [...prev]
            next[idx] = { ...prev[idx], label: cleanLabel }
            saveTrustedPubkeys(next)
            return next
          })
        }
        return true
      }

      // Central chokepoint: require explicit user confirmation before trusting any new peer
      const req: PendingTrustRequest = {
        pubkey: pk,
        npub: encodeNpubSafe(pk),
        label: cleanLabel,
      }
      pendingTrustRequestRef.current = req
      setPendingTrustRequest(req)
      return true
    },
    [presenceTracker, dmThreads, serversEngine.members, callsEngine.activeCall, pushToast]
  )

  const confirmPendingTrust = useCallback(() => {
    const req = pendingTrustRequestRef.current
    if (!req) return
    pendingTrustRequestRef.current = null
    setPendingTrustRequest(null)
    commitTrustPubkey(req.pubkey, req.label)
  }, [commitTrustPubkey])

  const cancelPendingTrust = useCallback(() => {
    pendingTrustRequestRef.current = null
    setPendingTrustRequest(null)
  }, [])

  // Keep persisted trusted peer labels fresh when real nicknames arrive from DMs or Server rosters
  useEffect(() => {
    if (trustedPubkeys.length === 0) return
    const updates = new Map<string, string>()
    const pickReal = (raw?: string | null): string | null => {
      const clean = raw?.trim().slice(0, 48)
      return clean && !isAutoAnonNickname(clean) ? clean : null
    }
    for (const entry of trustedPubkeys) {
      const currentReal = pickReal(entry.label)
      const fromDm = pickReal(dmThreads.find((t) => t.peerPubkey === entry.pubkey)?.peerNickname)
      const fromPresence = pickReal(presenceTracker.getNickname(entry.pubkey))
      const fromServer = pickReal(serversEngine.members.find((m) => m.pubkey === entry.pubkey)?.nickname)
      const best = fromDm || fromPresence || fromServer
      if (best && (!currentReal || currentReal !== best)) {
        updates.set(entry.pubkey, best)
      }
    }
    if (updates.size === 0) return
    setTrustedPubkeys((prev) => {
      let changed = false
      const next = prev.map((t) => {
        const nextLabel = updates.get(t.pubkey)
        if (!nextLabel || t.label === nextLabel) return t
        changed = true
        return { ...t, label: nextLabel }
      })
      if (changed) saveTrustedPubkeys(next)
      return changed ? next : prev
    })
  }, [trustedPubkeys, dmThreads, serversEngine.members, presenceTracker])

  // Upgrade active DM threads still showing generic `agnonXXXX` / `anonXXXX` from already-in-memory sources (zero extra storage)
  useEffect(() => {
    if (dmThreads.length === 0) return
    const resolved: Record<string, string> = {}
    for (const thread of dmThreads) {
      if (!isAutoAnonNickname(thread.peerNickname)) continue
      const pk = thread.peerPubkey.toLowerCase()
      const candidates = [
        trustedPubkeys.find((t) => t.pubkey.toLowerCase() === pk)?.label,
        amailEngine.contacts.find((c) => c.pubkey.toLowerCase() === pk)?.nickname,
        serversEngine.members.find((m) => m.pubkey.toLowerCase() === pk)?.nickname,
        presenceTracker.getNickname(pk),
      ]
      for (const raw of candidates) {
        const clean = raw?.trim().slice(0, 32)
        if (clean && !isAutoAnonNickname(clean)) {
          resolved[pk] = clean
          break
        }
      }
    }
    if (Object.keys(resolved).length > 0) {
      applySyncedDmPeerNames(resolved, { upgradeAnonOnly: true })
    }
  }, [
    dmThreads,
    trustedPubkeys,
    amailEngine.contacts,
    serversEngine.members,
    peers,
    presenceTracker,
    applySyncedDmPeerNames,
  ])

  // Lightweight, zero-extra-storage, once-per-session `kind: 0` fallback ONLY for active DM threads still showing `agnonXXXX` / `anonXXXX`
  const queriedDmProfilePksRef = useRef<Set<string>>(new Set())
  const dmProfileLookupUnsubsRef = useRef<Set<() => void>>(new Set())
  const dmProfileUnmountedRef = useRef(false)

  useEffect(() => {
    dmProfileUnmountedRef.current = false
    const unsubs = dmProfileLookupUnsubsRef.current
    return () => {
      dmProfileUnmountedRef.current = true
      for (const unsub of unsubs) {
        try {
          unsub()
        } catch {
          // Ignore cleanup errors
        }
      }
      unsubs.clear()
    }
  }, [])

  useEffect(() => {
    if (!pool || dmThreads.length === 0) return
    const needLookup: string[] = []
    for (const thread of dmThreads) {
      if (!isAutoAnonNickname(thread.peerNickname)) continue
      const pk = thread.peerPubkey.toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pk)) continue
      if (blockedSetRef.current.has(pk) || queriedDmProfilePksRef.current.has(pk)) continue
      needLookup.push(pk)
      if (needLookup.length >= 25) break
    }
    if (needLookup.length === 0) return

    const relays = Array.from(
      new Set([...relaySelection.dmRelays, ...relaySelection.channelRelays])
    )
    if (relays.length === 0) return

    for (const pk of needLookup) {
      queriedDmProfilePksRef.current.add(pk)
    }

    const targetSet = new Set(needLookup)
    const latestByPk = new Map<string, { createdAt: number; name: string }>()
    let finished = false
    let eoseCount = 0
    let unsub: (() => void) | null = null
    let timer = 0

    const finish = () => {
      if (finished) return
      finished = true
      window.clearTimeout(timer)
      if (unsub) {
        dmProfileLookupUnsubsRef.current.delete(unsub)
        try {
          unsub()
        } catch {
          // Ignore unsubscribe errors
        }
      }
      if (dmProfileUnmountedRef.current || latestByPk.size === 0) return
      const resolved: Record<string, string> = {}
      for (const [pk, rec] of latestByPk.entries()) {
        resolved[pk] = rec.name
      }
      applySyncedDmPeerNames(resolved, { upgradeAnonOnly: true })
    }

    timer = window.setTimeout(finish, 4500)
    unsub = pool.subscribe(
      `agnostr-dm-k0-${Date.now().toString(36)}`,
      relays,
      [{ kinds: [0], authors: needLookup, limit: needLookup.length * 2 }],
      {
        onEvent: (ev) => {
          if (ev.kind !== 0) return
          const pk = ev.pubkey.toLowerCase()
          if (!targetSet.has(pk) || !ev.content) return
          try {
            const parsed = JSON.parse(ev.content) as Record<string, unknown>
            const rawName =
              (typeof parsed.display_name === 'string' && parsed.display_name.trim()) ||
              (typeof parsed.name === 'string' && parsed.name.trim()) ||
              ''
            const cleanName = rawName.trim().slice(0, 32)
            if (isAutoAnonNickname(cleanName)) return
            const prev = latestByPk.get(pk)
            if (!prev || ev.created_at > prev.createdAt) {
              latestByPk.set(pk, { createdAt: ev.created_at, name: cleanName })
            }
          } catch {
            // Ignore malformed kind: 0 JSON
          }
        },
        onEose: () => {
          eoseCount += 1
          if (eoseCount >= relays.length) {
            finish()
          }
        },
      }
    )
    dmProfileLookupUnsubsRef.current.add(unsub)
  }, [pool, dmThreads, relaySelection.dmRelays, relaySelection.channelRelays, applySyncedDmPeerNames])

  const untrustPubkey = useCallback(
    (pubkey: string) => {
      const pk = pubkey.toLowerCase()
      if (trustedSetRef.current.has(pk)) {
        const nextTrusted = new Set(trustedSetRef.current)
        nextTrusted.delete(pk)
        trustedSetRef.current = nextTrusted
      }
      if (!allowUntrustedVoiceMemosRef.current || strictWhitelistRef.current) {
        voiceCacheRef.current?.revokeForSender(pk)
      }
      setTrustedPubkeys((prev) => {
        const next = prev.filter((t) => t.pubkey !== pk)
        saveTrustedPubkeys(next)
        return next
      })
      pushToast(
        'info',
        'Removed from Trusted Peers',
        allowUntrustedVoiceMemosRef.current && !strictWhitelistRef.current
          ? `Images and calls from #${pk.slice(-6)} now require trust.`
          : `Images, voice memos, and calls from #${pk.slice(-6)} are now shielded again.`
      )
    },
    [pushToast]
  )

  const clearTrustedPubkeys = useCallback(() => {
    trustedSetRef.current = new Set()
    if (!allowUntrustedVoiceMemosRef.current || strictWhitelistRef.current) {
      voiceCacheRef.current?.revokeAll()
    }
    setTrustedPubkeys([])
    saveTrustedPubkeys([])
    pushToast(
      'info',
      'Trusted Peers cleared',
      allowUntrustedVoiceMemosRef.current && !strictWhitelistRef.current
        ? 'External images and calls now require trust.'
        : 'All external images, voice memos, and calls are shielded.'
    )
  }, [pushToast])

  // Blossom media server management
  const addBlossomServer = useCallback(
    (rawUrl: string): boolean => {
      const url = normalizeBlossomServerUrl(rawUrl)
      if (!url) {
        pushToast('warning', 'Invalid Blossom server', 'Use a valid https:// Blossom server URL.')
        return false
      }
      setBlossomServers((prev) => {
        if (prev.includes(url)) return prev
        const next = [url, ...prev]
        saveBlossomServers(next)
        return next
      })
      pushToast('success', 'Blossom server added', url)
      return true
    },
    [pushToast]
  )

  const removeBlossomServer = useCallback(
    (url: string) => {
      setBlossomServers((prev) => {
        if (prev.length <= 1) {
          pushToast('warning', 'Keep at least one server', 'Use Reset Defaults to restore default Blossom servers.')
          return prev
        }
        const next = prev.filter((s) => s !== url)
        saveBlossomServers(next)
        return next
      })
    },
    [pushToast]
  )

  const resetBlossomServers = useCallback(() => {
    const defaults = [...DEFAULT_BLOSSOM_SERVERS]
    setBlossomServers(defaults)
    saveBlossomServers(defaults)
    pushToast('info', 'Blossom servers reset', 'Restored live-verified default Blossom servers.')
  }, [pushToast])

  // Voice memo send (Blossom BUD-02 + NIP-92 imeta for public; AES-256-GCM + kind 1059 for DMs; delegates to Servers in server view)
  const sendVoiceMemo = useCallback(
    async (recorded: RecordedVoiceMemo, caption?: string, dm?: DmSendContext): Promise<boolean> => {
      const view = dm ? { type: 'dm' as const, peerPubkey: dm.peerPubkey } : activeViewRef.current
      if (view.type === 'server') {
        beginMediaSend()
        try {
          return await serversEngine.sendVoiceMemo(recorded, caption)
        } finally {
          endMediaSend()
        }
      }
      if (!pool) {
        revokeVoicePreviewUrl(recorded)
        return false
      }
      if (recorded.size <= 0) {
        revokeVoicePreviewUrl(recorded)
        pushToast('warning', 'Empty recording', 'Hold or record for at least a second before sending.')
        return false
      }

      const gh = activeGeohashRef.current
      const targetRelays = [...relaySelectionRef.current.channelRelays]
      const targetDmPeer = view.type === 'dm' ? view.peerPubkey : null
      const isDm = targetDmPeer !== null
      const cleanMime = cleanMimeType(recorded.mime)
      const cleanCaption = caption?.trim() ?? ''
      const uploadServers = [...blossomServers]
      const wipeGen = identityManager.getWipeGeneration()

      if (isDm && targetDmPeer) {
        // Create a dedicated local object URL for 0ms optimistic display so revoking the
        // recorder's preview URL never invalidates optimistic playback or failed-send retries.
        const optimisticUrl = trackOptimisticVoiceUrl(URL.createObjectURL(recorded.blob))
        revokeVoicePreviewUrl(recorded)
        const signerPk = identityManager.getKeyMaterialForGeohash(gh).pubkey.toLowerCase()
        const optimisticAttachment: VoiceMemoAttachment = {
          url: optimisticUrl,
          mime: cleanMime,
          size: recorded.size,
          durationSec: recorded.durationSec,
          waveform: recorded.waveform,
          sha256: '',
        }

        if (recorded.previewTranscript?.trim()) {
          seedMemoTranscriptRef.current(
            optimisticUrl,
            recorded.previewTranscript,
            recorded.previewTranscriptModel
          )
        }

        adjustInFlightSend(1)
        beginMediaSend()
        try {
          const ok = await sendDirectVoiceMemo(
            targetDmPeer,
            async () => {
              beginMediaSend()
              try {
                const rawBytes = new Uint8Array(await recorded.blob.arrayBuffer())
                setVoiceSendPhase('encrypting')
                const { ciphertext, ciphertextSha256, encryption } =
                  await encryptVoiceBytesAesGcm(rawBytes)

                setVoiceSendPhase('uploading')
                const upload = await uploadBlobToBlossom({
                  bytes: ciphertext,
                  mime: 'application/octet-stream',
                  servers: uploadServers,
                  precomputedSha256: ciphertextSha256,
                  signAuthEvent: (tmpl) => identityManager.signEvent(tmpl, gh),
                })

                const attachment: VoiceMemoAttachment = {
                  url: upload.url,
                  mime: cleanMime,
                  size: recorded.size,
                  durationSec: recorded.durationSec,
                  waveform: recorded.waveform,
                  sha256: upload.sha256,
                  encryption,
                  server: upload.server,
                }

                // Seed local cache immediately (adopting optimisticUrl so active playback continues uninterrupted)
                const seededUrl = voiceCacheRef.current?.seedBlob(
                  attachment,
                  recorded.blob,
                  signerPk,
                  optimisticUrl
                )
                if (seededUrl === optimisticUrl) {
                  optimisticVoiceUrlsRef.current.delete(optimisticUrl)
                }

                if (attachment.sha256 && recorded.previewTranscript?.trim()) {
                  seedMemoTranscriptRef.current(
                    attachment.sha256,
                    recorded.previewTranscript,
                    recorded.previewTranscriptModel
                  )
                }

                setVoiceSendPhase('publishing')
                return attachment
              } finally {
                endMediaSend()
              }
            },
            cleanCaption,
            undefined,
            dm?.replyToId,
            optimisticAttachment,
            () => releaseOptimisticVoiceUrl(optimisticUrl)
          )
          if (ok) {
            pushToast(
              'success',
              'Encrypted voice memo sent',
              'AES-256-GCM audio delivered inside E2EE gift wrap.'
            )
          }
          return ok
        } finally {
          endMediaSend()
          adjustInFlightSend(-1)
        }
      }

      const replyTarget = replyingToRef.current
      replyingToRef.current = null
      if (activeGeohashRef.current === gh) {
        setReplyingTo(null)
      }

      const isTopic = isTopicChannel(gh)
      const isNonEarth = isCelestialNonEarthChannel(gh)
      const nick = identityManager.getNickname()
      const activeKey = identityManager.getKeyMaterialForGeohash(gh)
      const activePk = activeKey.pubkey.toLowerCase()
      const isTeleported = isTopic || isNonEarth ? false : location.isTeleported
      const broadcastClientTag = settings.broadcastClientTag
      const lightningAddr = zapsEngine.lightningAddress
      const powEnabled = settings.powEnabled
      const powTargetBits = settings.powTargetBits

      // Synchronously build & insert optimistic voice memo at 0ms BEFORE async Blossom upload
      const tempId = `pending-bitchat-${Date.now()}-${++optimisticBitchatSeqRef.current}`
      const nowSec = Math.floor(Date.now() / 1000)
      const optimisticUrl = trackOptimisticVoiceUrl(URL.createObjectURL(recorded.blob))
      revokeVoicePreviewUrl(recorded)

      const optimisticAttachment: VoiceMemoAttachment = {
        url: optimisticUrl,
        mime: cleanMime,
        size: recorded.size,
        durationSec: recorded.durationSec,
        waveform: recorded.waveform,
        sha256: '',
      }

      if (recorded.previewTranscript?.trim()) {
        seedMemoTranscriptRef.current(
          optimisticUrl,
          recorded.previewTranscript,
          recorded.previewTranscriptModel
        )
      }

      const optimisticBase: GeoMessage = {
        id: tempId,
        geohash: gh,
        pubkey: activePk,
        nickname: nick,
        displayHandle: formatDisplayHandle(nick, activePk),
        content: cleanCaption,
        createdAt: nowSec,
        tags: [],
        isOwn: true,
        isTeleported: !isTopic && isTeleported,
        isMeshBridge: false,
        clientName: broadcastClientTag ? AGNOSTR_CLIENT_TAG : undefined,
        isAgnostrClient: broadcastClientTag,
        powBits: 0,
        replyTo:
          replyTarget && !replyTarget.isSystem
            ? {
                id: replyTarget.id,
                pubkey: replyTarget.pubkey,
                nickname: replyTarget.nickname,
                preview: replyTarget.content.slice(0, 120),
              }
            : undefined,
        reactions: [],
        mentions: extractMentions(cleanCaption),
        voiceMemo: optimisticAttachment,
        deliveryStatus: 'sending',
      }

      updateChannelMessages(
        gh,
        (prev) => {
          const lastSec = prev.length > 0 ? prev[prev.length - 1].createdAt : 0
          return [...prev, { ...optimisticBase, createdAt: Math.max(nowSec, lastSec) }]
        },
        { allowBackgroundPersist: true }
      )
      revealLocalBitchatSend(gh, tempId)

      let uploadedAttachment: VoiceMemoAttachment | null = null

      const queueAttempt = async (fn: () => Promise<boolean>) => {
        adjustInFlightSend(1)
        beginMediaSend()
        try {
          return await bitchatSendQueueRef.current.enqueue(`bitchat:${gh}`, fn, () => {
            if (identityManager.getWipeGeneration() !== wipeGen) {
              releaseOptimisticVoiceUrl(optimisticUrl, true)
            }
            return false
          })
        } finally {
          endMediaSend()
          adjustInFlightSend(-1)
        }
      }

      const attempt = async (): Promise<boolean> => {
        if (identityManager.getWipeGeneration() !== wipeGen) {
          releaseOptimisticVoiceUrl(optimisticUrl, true)
          return false
        }
        let activeMsgId = tempId
        try {
          updateChannelMessages(
            gh,
            (prev) =>
              prev.map((m) =>
                m.id === tempId && m.deliveryStatus !== 'sent'
                  ? { ...m, deliveryStatus: 'sending' }
                  : m
              ),
            { allowBackgroundPersist: true }
          )

          if (!uploadedAttachment) {
            const rawBytes = new Uint8Array(await recorded.blob.arrayBuffer())

            // Public geohash/topic channel: upload audio to Blossom + publish with NIP-92 imeta
            setVoiceSendPhase('uploading')
            const upload = await uploadBlobToBlossom({
              bytes: rawBytes,
              mime: cleanMime,
              servers: uploadServers,
              signAuthEvent: (tmpl) => identityManager.signEvent(tmpl, gh),
            })

            if (identityManager.getWipeGeneration() !== wipeGen) {
              releaseOptimisticVoiceUrl(optimisticUrl, true)
              return false
            }

            const attachment: VoiceMemoAttachment = {
              url: upload.url,
              mime: cleanMime,
              size: upload.size,
              durationSec: recorded.durationSec,
              waveform: recorded.waveform,
              sha256: upload.sha256,
              server: upload.server,
            }

            // Immediately seed local cache (adopting optimisticUrl so active playback continues uninterrupted)
            const seededUrl = voiceCacheRef.current?.seedBlob(
              attachment,
              recorded.blob,
              activePk,
              optimisticUrl
            )
            if (seededUrl === optimisticUrl) {
              optimisticVoiceUrlsRef.current.delete(optimisticUrl)
            }

            if (attachment.sha256 && recorded.previewTranscript?.trim()) {
              seedMemoTranscriptRef.current(
                attachment.sha256,
                recorded.previewTranscript,
                recorded.previewTranscriptModel
              )
            }

            uploadedAttachment = attachment
            updateChannelMessages(
              gh,
              (prev) =>
                prev.map((m) => (m.id === tempId ? { ...m, voiceMemo: attachment } : m)),
              { allowBackgroundPersist: true }
            )
            if (seededUrl !== optimisticUrl) {
              releaseOptimisticVoiceUrl(optimisticUrl)
            }
          }

          const attachment = uploadedAttachment
          const latestRelays =
            activeGeohashRef.current === gh ? relaySelectionRef.current.channelRelays : []
          if (!(await pool.waitForChatRelay([...targetRelays, ...latestRelays]))) {
            throw new Error('No connected relay is available.')
          }
          if (identityManager.getWipeGeneration() !== wipeGen) {
            releaseOptimisticVoiceUrl(optimisticUrl, true)
            return false
          }

          setVoiceSendPhase('signing')
          const content = cleanCaption ? `${cleanCaption}\n${attachment.url}` : attachment.url
          const template = isTopic
            ? buildNamedBitchatChatTemplate({
                content,
                topic: gh,
                nickname: nick,
                replyTo: replyTarget,
                voiceMemo: attachment,
                broadcastClientTag,
                lightningAddress: lightningAddr,
              })
            : buildGeohashChatTemplate({
                content,
                geohash: gh,
                nickname: nick,
                isTeleported,
                replyTo: replyTarget,
                voiceMemo: attachment,
                broadcastClientTag,
                lightningAddress: lightningAddr,
              })

          if (powEnabled && powTargetBits > 0 && activeKey.pubkey) {
            const nonceTag = await mineNip13NonceTag(
              template,
              activeKey.pubkey,
              powTargetBits,
              450
            )
            if (nonceTag) {
              template.tags = [...template.tags, nonceTag]
            }
          }

          if (identityManager.getWipeGeneration() !== wipeGen) {
            releaseOptimisticVoiceUrl(optimisticUrl, true)
            return false
          }
          const signed = await identityManager.signEvent(template, gh)
          if (identityManager.getWipeGeneration() !== wipeGen) {
            releaseOptimisticVoiceUrl(optimisticUrl, true)
            return false
          }

          activeMsgId = signed.id
          chatRetries.confirm(tempId)

          const findParent = (id: string) =>
            messagesChannelRef.current === gh
              ? messagesRef.current.find((m) => m.id === id)
              : undefined
          const parsed = isTopic
            ? parseNamedBitchatChatEvent(signed, gh, ownPubkeysRef.current, findParent)
            : parseGeohashChatEvent(signed, gh, ownPubkeysRef.current, findParent)
          if (parsed) {
            parsed.deliveryStatus = 'sending'
            parsed.isOwn = true
            // Atomically replace tempId -> signed.id into confirmed messages BEFORE publishing
            updateChannelMessages(
              gh,
              (prev) => swapPendingWithSigned(prev, tempId, parsed, 'pending-bitchat-'),
              { allowBackgroundPersist: true }
            )
          }
          releaseOptimisticVoiceUrl(optimisticUrl)

          setVoiceSendPhase('publishing')
          return await publishChatWire({
            rowId: signed.id,
            publish: (ack) =>
              pool.publish(
                [
                  ...new Set([
                    ...targetRelays,
                    ...(activeGeohashRef.current === gh
                      ? relaySelectionRef.current.channelRelays
                      : []),
                  ]),
                ],
                signed,
                undefined,
                ack
              ),
            isCurrent: () => identityManager.getWipeGeneration() === wipeGen,
            queueRetry: queueAttempt,
            update: (deliveryStatus, relayCount) =>
              updateChannelMessages(
                gh,
                (prev) =>
                  sortChannelMessagesWithPending(
                    prev.map((m) =>
                      m.id !== signed.id || (m.deliveryStatus === 'sent' && deliveryStatus !== 'sent')
                        ? m
                        : { ...m, deliveryStatus, relayCount: Math.max(m.relayCount ?? 0, relayCount) }
                    ),
                    'pending-bitchat-'
                  ),
                { allowBackgroundPersist: true }
              ),
            onFailure: (reason) =>
              pushToast('error', 'Voice memo publish failed', reason, signed.id),
            onSuccess: () => {
              if (parsed) {
                const signedVoicePreview = formatBitchatPreviewText({
                  content: parsed.content,
                  hasVoice: true,
                  mediaUrl: parsed.voiceMemo?.url ?? attachment.url,
                  tags: signed.tags,
                })
                upsertChannelPreview(
                  gh,
                  {
                    id: parsed.id,
                    replaceId: tempId,
                    preview: signedVoicePreview,
                    sender: parsed.nickname || nick,
                    senderPubkey: parsed.pubkey,
                    createdAt: parsed.createdAt,
                  },
                  { force: activeGeohashRef.current === gh }
                )
                recordRoomMessage({
                  id: parsed.id,
                  replaceId: tempId,
                  geohash: gh,
                  pubkey: parsed.pubkey,
                  sender: parsed.nickname || nick,
                  preview: signedVoicePreview,
                  createdAtSec: parsed.createdAt,
                  isAuthoritative: activeGeohashRef.current === gh,
                })
              }
            },
          })
        } catch (err) {
          if (identityManager.getWipeGeneration() === wipeGen) {
            if (activeMsgId === tempId) {
              chatRetries.hold(tempId, () => queueAttempt(attempt))
            }
            updateChannelMessages(
              gh,
              (prev) => {
                let changed = false
                const next = prev.map((m) => {
                  if ((m.id !== activeMsgId && m.id !== tempId) || m.deliveryStatus === 'sent') {
                    return m
                  }
                  changed = true
                  return {
                    ...m,
                    deliveryStatus: 'failed' as GeoMessage['deliveryStatus'],
                  }
                })
                return changed ? next : null
              },
              { allowBackgroundPersist: true }
            )
            pushToast(
              'error',
              'Voice memo failed',
              err instanceof Error ? err.message : 'Unable to upload voice memo.',
              activeMsgId
            )
          } else {
            releaseOptimisticVoiceUrl(optimisticUrl, true)
          }
          return false
        }
      }

      return await queueAttempt(attempt)
    },
    [
      pool,
      serversEngine,
      blossomServers,
      identityManager,
      sendDirectVoiceMemo,
      location.isTeleported,
      settings.powEnabled,
      settings.powTargetBits,
      settings.broadcastClientTag,
      zapsEngine.lightningAddress,
      updateChannelMessages,
      revealLocalBitchatSend,
      upsertChannelPreview,
      recordRoomMessage,
      trackOptimisticVoiceUrl,
      releaseOptimisticVoiceUrl,
      adjustInFlightSend,
      beginMediaSend,
      endMediaSend,
      pushToast,
    ]
  )

  // Engine-level voice memo authorization guard: blocked peers always denied;
  // untrusted non-blocked peers allowed by default unless disabled or strictWhitelistMode is on
  const fetchVoiceMemoBlob = useCallback(
    async (memo: VoiceMemoAttachment, senderPubkey: string): Promise<string> => {
      const pk = senderPubkey.trim().toLowerCase()
      const assertAuthorized = () => {
        if (ownPubkeysRef.current.has(pk)) return
        if (blockedSetRef.current.has(pk)) {
          throw new Error('Blocked: voice memos from blocked peers cannot be loaded.')
        }
        if (trustedSetRef.current.has(pk)) return
        if (!allowUntrustedVoiceMemosRef.current || strictWhitelistRef.current) {
          throw new Error('Blocked: trust this sender before loading voice memos.')
        }
      }
      // Enforce immediately before touching cache or network
      assertAuthorized()
      const cache = voiceCacheRef.current
      if (!cache) throw new Error('Media cache unavailable.')
      return await cache.getOrFetch(memo, assertAuthorized, pk)
    },
    []
  )

  // Client-side local voice transcription (Voice Memos + Live Per-Speaker Call Captions)
  const {
    transcription: transcriptionEngine,
    resetAllTranscription,
    exportCallTranscriptsSyncDigest,
    exportCallTranscriptsSyncPayload,
    mergeCallTranscriptsSyncPayload,
  } = useTranscription({
    activeCall: callsEngine.activeCall,
    fetchVoiceMemoBlob,
    pushToast,
    onCallTranscriptsChanged: handleCallTranscriptsLocalChange,
  })

  useLayoutEffect(() => {
    registerCallTranscriptSyncProvider({
      exportSyncDigest: exportCallTranscriptsSyncDigest,
      exportSyncPayload: exportCallTranscriptsSyncPayload,
      mergeSyncPayload: mergeCallTranscriptsSyncPayload,
    })
    return () => {
      registerCallTranscriptSyncProvider(null)
    }
  }, [
    registerCallTranscriptSyncProvider,
    exportCallTranscriptsSyncDigest,
    exportCallTranscriptsSyncPayload,
    mergeCallTranscriptsSyncPayload,
  ])

  useLayoutEffect(() => {
    seedMemoTranscriptRef.current = transcriptionEngine.seedMemoTranscript
  }, [transcriptionEngine.seedMemoTranscript])

  const closeDmThread = useCallback(
    (pubkey: string) => {
      const pk = pubkey.trim().toLowerCase()
      if (!pk) return
      closeDmThreadRaw(pk)
      if (
        activeViewRef.current.type === 'dm' &&
        activeViewRef.current.peerPubkey.toLowerCase() === pk
      ) {
        setActiveView({ type: 'channel', geohash: activeGeohash })
      }
    },
    [closeDmThreadRaw, activeGeohash]
  )

  // Push Notifications, Live Incoming DM Call Ringing & Optional NIP-98/VAPID Web Push Bridge
  const notificationRelayUrls = useMemo(
    () =>
      Array.from(
        new Set([
          ...relaySelection.dmRelays,
          ...relaySelection.channelRelays,
          ...callSignalingRelays,
        ])
      ),
    [relaySelection.dmRelays, relaySelection.channelRelays, callSignalingRelays]
  )
  const ownGeoCallPubkeys = useMemo(() => {
    void identityVersion
    const set = new Set<string>()
    const hashes = new Set<string>([activeGeohash, ...pinnedGeohashList])
    if (callsEngine.activeCall?.mode === 'geo' && callsEngine.activeCall.geohash) {
      hashes.add(callsEngine.activeCall.geohash)
    }
    for (const gh of hashes) {
      if (isValidBitchatChannelKey(gh)) {
        set.add(identityManager.getDerivedGeohashKeyMaterial(gh).pubkey.toLowerCase())
      }
    }
    return set
  }, [identityManager, identityVersion, activeGeohash, pinnedGeohashList, callsEngine.activeCall])

  const notificationAliasPubkeys = useMemo(() => {
    void identityVersion
    const masterPk = identity.masterPubkey.toLowerCase()
    const out: string[] = []
    const seen = new Set<string>()
    const hashes = new Set<string>([activeGeohash, ...pinnedGeohashList])
    for (const gh of hashes) {
      if (!isValidBitchatChannelKey(gh)) continue
      const derivedPk = identityManager.getDerivedGeohashKeyMaterial(gh).pubkey.toLowerCase()
      if (
        derivedPk === masterPk ||
        seen.has(derivedPk) ||
        !/^[0-9a-f]{64}$/.test(derivedPk)
      ) {
        continue
      }
      seen.add(derivedPk)
      out.push(derivedPk)
      if (out.length >= 16) break
    }
    return out
  }, [identityManager, identityVersion, identity.masterPubkey, activeGeohash, pinnedGeohashList])

  const signNotificationEvent = useCallback(
    (tmpl: Parameters<IdentityManager['signEvent']>[0]) =>
      identityManager.signEventWithMaterial(tmpl, identityManager.getMasterKeyMaterial()),
    [identityManager]
  )

  const {
    notifications: notificationsEngine,
    notifyGeoMessage,
    notifyLocationNote,
    notifyAmail,
    notifyAgora,
    resetAllNotifications,
  } = useNotifications({
    activeView,
    activeGeohash,
    ownPubkeys,
    blockedSet,
    trustedSet,
    strictWhitelistMode: settings.strictWhitelistMode,
    masterPubkey: identity.masterPubkey,
    aliasPubkeys: notificationAliasPubkeys,
    nickname: identity.nickname,
    dmThreads,
    joinedServers: serversEngine.joinedServers,
    activeServer: serversEngine.activeServer,
    activeChannelId: serversEngine.activeChannel?.id ?? null,
    activeServerMessages: serversEngine.messages,
    incomingCall: callsEngine.incomingCall,
    isOutgoingDmRinging: callsEngine.isOutgoingDmRinging,
    serverCallRosters: callsEngine.serverCallRosters,
    activeCallServerId:
      callsEngine.activeCall?.mode === 'server'
        ? callsEngine.activeCall.serverId ?? null
        : null,
    geoCallRosters: callsEngine.geoCallRosters,
    activeCallGeohash:
      callsEngine.activeCall?.mode === 'geo'
        ? callsEngine.activeCall.geohash ?? null
        : null,
    ownGeoCallPubkeys,
    relayUrls: notificationRelayUrls,
    pinnedGeohashes: pinnedGeohashList,
    canAutoSign: identityManager.getMasterKeyMaterial().mode === 'local',
    signEvent: signNotificationEvent,
    pushToast,
  })

  useLayoutEffect(() => {
    pokeRecipientsRef.current = notificationsEngine.pokeRecipients
  }, [notificationsEngine.pokeRecipients])

  useLayoutEffect(() => {
    notifyGeoMessageRef.current = notifyGeoMessage
  }, [notifyGeoMessage])

  useLayoutEffect(() => {
    notifyLocationNoteRef.current = notifyLocationNote
  }, [notifyLocationNote])

  useLayoutEffect(() => {
    notifyAmailRef.current = notifyAmail
  }, [notifyAmail])

  useLayoutEffect(() => {
    notifyAgoraRef.current = notifyAgora
  }, [notifyAgora])

  const {
    notificationsByProfile,
    otherProfilesUnreadCount,
    clearProfileNotifications,
  } = useProfileNotifications({
    relayPool: pool,
    profiles: storedProfiles,
    activeProfileId: myMasterPkLower,
    notificationsEnabled: notificationsEngine.settings.enabled,
    soundEnabled: settings.soundEnabled,
    onSwitchProfile: switchProfile,
    pushToast,
  })

  const profilesEngine = useMemo<ProfileSwitcherEngine>(
    () => ({
      profiles: storedProfiles,
      activeProfileId: myMasterPkLower,
      switching: profileSwitching,
      notificationsByProfile,
      otherProfilesUnreadCount,
      clearProfileNotifications,
      switchProfile,
      createProfile,
      importProfile,
      deleteProfile,
    }),
    [
      storedProfiles,
      myMasterPkLower,
      profileSwitching,
      notificationsByProfile,
      otherProfilesUnreadCount,
      clearProfileNotifications,
      switchProfile,
      createProfile,
      importProfile,
      deleteProfile,
    ]
  )

  const sendImageAttachment = useCallback(
    async (image: PreparedImage, caption?: string, dm?: DmSendContext): Promise<boolean> => {
      if (!pool || image.size <= 0) {
        revokeImagePreviewUrl(image)
        return false
      }

      const view = dm ? { type: 'dm' as const, peerPubkey: dm.peerPubkey } : activeViewRef.current
      if (view.type === 'server') {
        beginMediaSend()
        try {
          return await serversEngine.sendImageAttachment(image, caption)
        } finally {
          endMediaSend()
        }
      }

      const gh = activeGeohashRef.current
      const targetRelays = [...relaySelectionRef.current.channelRelays]
      const targetDmPeer = view.type === 'dm' ? view.peerPubkey : null
      const isDm = targetDmPeer !== null
      const cleanMime = cleanMimeType(image.mime, 'image/webp')
      const cleanCaption = caption?.trim() ?? ''
      const uploadServers = [...blossomServers]
      const wipeGen = identityManager.getWipeGeneration()

      if (isDm && targetDmPeer) {
        adjustInFlightSend(1)
        beginMediaSend()
        try {
          const ok = await sendDirectImageAttachment(
            targetDmPeer,
            async () => {
              const rawBytes = new Uint8Array(await image.blob.arrayBuffer())
              setVoiceSendPhase('encrypting')
              const { ciphertext, encryption } = await encryptMediaBytesAesGcm(rawBytes)

              setVoiceSendPhase('uploading')
              const upload = await uploadBlobToBlossom({
                bytes: ciphertext,
                mime: 'application/octet-stream',
                servers: uploadServers,
                signAuthEvent: (tmpl) => identityManager.signEvent(tmpl, gh),
              })

              const attachment: ImageAttachment = {
                url: upload.url,
                mime: cleanMime,
                sha256: upload.sha256,
                size: image.size,
                width: image.width,
                height: image.height,
                alt: image.fileName,
                encryption,
                server: upload.server,
              }

              setVoiceSendPhase('publishing')
              return attachment
            },
            cleanCaption, undefined, dm?.replyToId
          )
          if (ok) {
            pushToast(
              'success',
              'Encrypted image sent',
              'AES-256-GCM image delivered inside E2EE gift wrap.'
            )
          }
          return ok
        } finally {
          revokeImagePreviewUrl(image)
          endMediaSend()
          adjustInFlightSend(-1)
        }
      }

      const replyTarget = replyingToRef.current
      replyingToRef.current = null
      if (activeGeohashRef.current === gh) {
        setReplyingTo(null)
      }

      const isTopic = isTopicChannel(gh)
      const isNonEarth = isCelestialNonEarthChannel(gh)
      const nick = identityManager.getNickname()
      const activeKey = identityManager.getKeyMaterialForGeohash(gh)
      const isTeleported = isTopic || isNonEarth ? false : location.isTeleported
      const broadcastClientTag = settings.broadcastClientTag
      const lightningAddr = zapsEngine.lightningAddress
      const powEnabled = settings.powEnabled
      const powTargetBits = settings.powTargetBits

      adjustInFlightSend(1)
      beginMediaSend()
      try {
        return await bitchatSendQueueRef.current.enqueue(
          `bitchat:${gh}`,
          async () => {
            if (identityManager.getWipeGeneration() !== wipeGen) {
              revokeImagePreviewUrl(image)
              return false
            }
            let signedMsgId: string | null = null
            try {
              const rawBytes = new Uint8Array(await image.blob.arrayBuffer())

              // Public geohash/topic channel: upload EXIF-stripped image to Blossom + publish with NIP-92 imeta
              setVoiceSendPhase('uploading')
              const upload = await uploadBlobToBlossom({
                bytes: rawBytes,
                mime: cleanMime,
                servers: uploadServers,
                signAuthEvent: (tmpl) => identityManager.signEvent(tmpl, gh),
              })

              const attachment: ImageAttachment = {
                url: upload.url,
                mime: cleanMime,
                sha256: upload.sha256,
                size: upload.size,
                width: image.width,
                height: image.height,
                alt: image.fileName,
                server: upload.server,
              }

              setVoiceSendPhase('signing')
              const content = cleanCaption ? `${cleanCaption}\n${upload.url}` : upload.url
              const template = isTopic
                ? buildNamedBitchatChatTemplate({
                    content,
                    topic: gh,
                    nickname: nick,
                    replyTo: replyTarget,
                    imageAttachment: attachment,
                    broadcastClientTag,
                    lightningAddress: lightningAddr,
                  })
                : buildGeohashChatTemplate({
                    content,
                    geohash: gh,
                    nickname: nick,
                    isTeleported,
                    replyTo: replyTarget,
                    imageAttachment: attachment,
                    broadcastClientTag,
                    lightningAddress: lightningAddr,
                  })

              if (powEnabled && powTargetBits > 0 && activeKey.pubkey) {
                const nonceTag = await mineNip13NonceTag(
                  template,
                  activeKey.pubkey,
                  powTargetBits,
                  450
                )
                if (nonceTag) {
                  template.tags = [...template.tags, nonceTag]
                }
              }

              if (identityManager.getWipeGeneration() !== wipeGen) return false
              const signed = await identityManager.signEvent(template, gh)
              if (identityManager.getWipeGeneration() !== wipeGen) return false

              signedMsgId = signed.id
              const findParent = (id: string) =>
                messagesChannelRef.current === gh
                  ? messagesRef.current.find((m) => m.id === id)
                  : undefined
              const parsed = isTopic
                ? parseNamedBitchatChatEvent(signed, gh, ownPubkeysRef.current, findParent)
                : parseGeohashChatEvent(signed, gh, ownPubkeysRef.current, findParent)
              if (parsed) {
                parsed.deliveryStatus = 'sending'
                parsed.isOwn = true
                updateChannelMessages(
                  gh,
                  (prev) => {
                    if (prev.some((m) => m.id === parsed.id)) return null
                    return sortChannelMessagesWithPending(
                      [...prev, parsed],
                      'pending-bitchat-'
                    ).slice(-350)
                  },
                  { allowBackgroundPersist: true }
                )
                revealLocalBitchatSend(gh, parsed.id)
                const signedImagePreview = formatBitchatPreviewText({
                  content: parsed.content,
                  hasImage: true,
                  mediaUrl: parsed.imageAttachment?.url ?? upload.url,
                  tags: signed.tags,
                })
                upsertChannelPreview(
                  gh,
                  {
                    id: parsed.id,
                    preview: signedImagePreview,
                    sender: parsed.nickname || nick,
                    senderPubkey: parsed.pubkey,
                    createdAt: parsed.createdAt,
                  },
                  { force: activeGeohashRef.current === gh }
                )
                recordRoomMessage({
                  id: parsed.id,
                  geohash: gh,
                  pubkey: parsed.pubkey,
                  sender: parsed.nickname || nick,
                  preview: signedImagePreview,
                  createdAtSec: parsed.createdAt,
                  isAuthoritative: activeGeohashRef.current === gh,
                })
              }

              setVoiceSendPhase('publishing')
              return await publishChatWire({
                rowId: signed.id,
                publish: (ack) => pool.publish(targetRelays, signed, undefined, ack),
                isCurrent: () => identityManager.getWipeGeneration() === wipeGen,
                queueRetry: (replay) => bitchatSendQueueRef.current.enqueue(`bitchat:${gh}`, replay, () => false),
                update: (deliveryStatus, relayCount) => updateChannelMessages(gh, (prev) =>
                  sortChannelMessagesWithPending(prev.map((m) =>
                    m.id !== signed.id || (m.deliveryStatus === 'sent' && deliveryStatus !== 'sent')
                    ? m : { ...m, deliveryStatus, relayCount: Math.max(m.relayCount ?? 0, relayCount) }
                  ), 'pending-bitchat-'), { allowBackgroundPersist: true }),
                onFailure: (reason) => pushToast('error', 'Image publish failed', reason, signed.id),
              })
            } catch (err) {
              if (identityManager.getWipeGeneration() === wipeGen) {
                if (signedMsgId) {
                  updateChannelMessages(
                    gh,
                    (prev) => {
                      let changed = false
                      const next = prev.map((m) => {
                        if (m.id !== signedMsgId) return m
                        changed = true
                        return {
                          ...m,
                          deliveryStatus: 'failed' as GeoMessage['deliveryStatus'],
                        }
                      })
                      return changed ? next : null
                    },
                    { allowBackgroundPersist: true }
                  )
                }
                pushToast(
                  'error',
                  'Image upload failed',
                  err instanceof Error ? err.message : 'Unable to upload image.'
                )
              }
              return false
            } finally {
              revokeImagePreviewUrl(image)
            }
          },
          () => {
            revokeImagePreviewUrl(image)
            return false
          }
        )
      } finally {
        endMediaSend()
        adjustInFlightSend(-1)
      }
    },
    [
      pool,
      serversEngine,
      blossomServers,
      identityManager,
      sendDirectImageAttachment,
      location.isTeleported,
      settings.powEnabled,
      settings.powTargetBits,
      settings.broadcastClientTag,
      zapsEngine.lightningAddress,
      updateChannelMessages,
      revealLocalBitchatSend,
      upsertChannelPreview,
      recordRoomMessage,
      adjustInFlightSend,
      beginMediaSend,
      endMediaSend,
      pushToast,
    ]
  )

  // STRICT engine-level Trusted Peers guard: zero network requests for untrusted senders
  const fetchImageAttachmentBlob = useCallback(
    async (image: ImageAttachment, senderPubkey: string): Promise<string> => {
      const pk = senderPubkey.toLowerCase()
      const assertAuthorized = () => {
        if (!ownPubkeysRef.current.has(pk) && !trustedSetRef.current.has(pk)) {
          throw new Error('Blocked: trust this sender before loading images or media.')
        }
      }
      // Enforce immediately before touching cache or network
      assertAuthorized()
      const cache = voiceCacheRef.current
      if (!cache) throw new Error('Media cache unavailable.')
      return await cache.getOrFetch(image, assertAuthorized, pk)
    },
    []
  )

  // Relay management
  const addCustomRelay = useCallback(
    (rawUrl: string): boolean => {
      const url = normalizeRelayUrl(rawUrl)
      if (!url) {
        pushToast('warning', 'Invalid relay URL', 'Use a valid wss:// relay address.')
        return false
      }
      setCustomRelays((prev) => {
        if (prev.includes(url)) return prev
        const next = [...prev, url]
        saveCustomRelays(next)
        return next
      })
      pushToast('success', 'Custom relay added', url)
      return true
    },
    [pushToast]
  )

  const removeCustomRelay = useCallback((url: string) => {
    setCustomRelays((prev) => {
      const next = prev.filter((u) => u !== url)
      saveCustomRelays(next)
      return next
    })
  }, [])

  const resetCustomRelays = useCallback(() => {
    setCustomRelays([])
    saveCustomRelays([])
    pushToast('info', 'Custom relays cleared', 'Using live-verified Bitchat geo-routing defaults.')
  }, [pushToast])

  const reconnectRelays = useCallback(() => {
    pool?.reconnectAll()
    pushToast('info', 'Reconnecting relays', 'Refreshing WebSocket connections.')
  }, [pool, pushToast])

  // Identity & settings actions
  const setNickname = useCallback(
    (nick: string) => {
      identityManager.setNickname(nick)
      saveNickname(identityManager.getNickname())
      setIdentityVersion((v) => v + 1)
    },
    [identityManager]
  )

  useLayoutEffect(() => {
    setNicknameRef.current = setNickname
  }, [setNickname])

  const setSignMode = useCallback(
    (mode: SignMode) => {
      if (mode === 'extension' && !detectNip07().hasNip07) {
        pushToast('warning', 'NIP-07 extension not detected', 'Install Alby, nos2x, or another Nostr extension.')
        return
      }
      identityManager.setSignMode(mode)
      saveSignMode(mode)
      setIdentityVersion((v) => v + 1)
    },
    [identityManager, pushToast]
  )

  const setLocalSecret = useCallback(
    (nsecOrHex: string): boolean => {
      const ok = identityManager.setLocalSecret(nsecOrHex)
      saveLocalSecret(nsecOrHex)
      setIdentityVersion((v) => v + 1)
      if (ok) {
        pushToast('success', 'Local key loaded', 'Ready to sign events with your imported secret key.')
      } else if (nsecOrHex.trim()) {
        pushToast('warning', 'Invalid secret key', 'Expected nsec1… or 64-character hex.')
      }
      return ok
    },
    [identityManager, pushToast]
  )

  const rotateIdentity = useCallback(() => {
    const prevPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
    const newSeedHex = identityManager.rotateEphemeral()
    saveDeviceSeedHex(newSeedHex)
    const nextState = identityManager.getState()
    const nextPk = nextState.masterPubkey.toLowerCase()
    lastSyncedMasterPubkeyRef.current = nextPk
    setStoredProfiles(
      syncActiveProfileMetadata({
        pubkey: nextPk,
        npub: nextState.masterNpub,
        nickname: nextState.nickname,
        picture: null,
        signMode: nextState.signMode,
        prevPubkey: prevPk,
      })
    )
    void snapshotCurrentProfileToVault(nextPk)
    setIdentityVersion((v) => v + 1)
    pushToast('success', 'Identity rotated', 'Fresh ephemeral keypair generated.')
  }, [identityManager, pushToast])

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
  }, [])

  const setTheme = useCallback(
    (theme: ThemeId) => {
      updateSettings({ theme })
    },
    [updateSettings]
  )

  const setBroadcastClientTag = useCallback(
    (enabled: boolean) => {
      updateSettings({ broadcastClientTag: enabled })
    },
    [updateSettings]
  )

  const setStrictWhitelistMode = useCallback(
    (enabled: boolean) => {
      strictWhitelistRef.current = enabled
      updateSettings({ strictWhitelistMode: enabled })
      if (enabled) {
        voiceCacheRef.current?.revokeAll()
      }
      pushToast(
        'info',
        enabled ? 'Trusted Peers Only ON' : 'Trusted Peers Only OFF',
        enabled
          ? 'Hiding text and voice memos from untrusted peers.'
          : allowUntrustedVoiceMemosRef.current
            ? 'Public text and voice memos visible; images & calls still require trust.'
            : 'Public text visible; images, voice memos & calls still require trusting the sender.'
      )
    },
    [updateSettings, pushToast]
  )

  const setAllowUntrustedVoiceMemos = useCallback(
    (enabled: boolean) => {
      allowUntrustedVoiceMemosRef.current = enabled
      updateSettings({ allowUntrustedVoiceMemos: enabled })
      if (!enabled) {
        voiceCacheRef.current?.revokeAll()
      }
      pushToast(
        'info',
        enabled ? 'Untrusted voice memos enabled' : 'Voice memos now require Trusted Peers',
        enabled
          ? 'Voice memos from non-blocked peers can play and transcribe.'
          : 'Untrusted voice memos are now shielded until you trust the sender.'
      )
    },
    [updateSettings, pushToast]
  )

  const panicWipe = useCallback(() => {
    try {
      walletEngine.resetAll()
    } catch (error) {
      pushToast('error', 'Wallet reset blocked', error instanceof Error ? error.message : undefined)
      return
    }
    if (isNativeAndroidBuild) nearbyRef.current.setEnabled(false)
    else void nearbyRef.current.api()?.stop()
    const prevPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
    trustedSetRef.current = new Set()
    blockedSetRef.current = new Set()
    resetAllNotifications()
    resetAllTranscription()
    bitchatSendQueueRef.current.clearAll()
    chatRetries.clear()
    inFlightSendCountRef.current = 0
    inFlightMediaCountRef.current = 0
    setSending(false)
    replyingToRef.current = null
    contentFilterEngine.resetAll()
    translatorEngine.resetAll()
    zapsEngine.resetAll()
    deviceSyncEngine.resetAll()
    void amailEngine.resetAll()
    agoraEngine.resetAll()
    resetAllCalls()
    resetAllGames()
    pool.closeAll()
    revokeAllOptimisticVoiceUrls()
    voiceCacheRef.current?.revokeAll()
    clearProtocolCaches()
    presenceTracker.clear()
    clearPulse()
    setChannelPreviews({})
    queriedDmProfilePksRef.current.clear()
    for (const unsub of dmProfileLookupUnsubsRef.current) {
      try {
        unsub()
      } catch {
        // Ignore
      }
    }
    dmProfileLookupUnsubsRef.current.clear()
    clearAllDms()
    resetAllServers()
    resetLocation()
    panicWipeStorage()
    void clearProfileChannelHistory(prevPk)
    setChannelHistoryEpoch((n) => n + 1)

    const { deviceSeedHex, nickname } = identityManager.panicReset()
    saveDeviceSeedHex(deviceSeedHex)
    saveNickname(nickname)
    saveSignMode('auto')
    const freshState = identityManager.getState()
    const freshPk = freshState.masterPubkey.toLowerCase()
    lastSyncedMasterPubkeyRef.current = freshPk
    setStoredProfiles(
      syncActiveProfileMetadata({
        pubkey: freshPk,
        npub: freshState.masterNpub,
        nickname: freshState.nickname,
        picture: null,
        signMode: 'auto',
        prevPubkey: prevPk,
      })
    )
    void snapshotCurrentProfileToVault(freshPk)

    setSettings(DEFAULT_SETTINGS)
    setPinnedChannels([])
    geoSeenIdsRef.current.clear()
    geoUnreadItemsRef.current = {}
    geoUnreadCountsRef.current = {}
    setGeoUnreadCounts({})
    geoMentionCountsRef.current = {}
    setGeoMentionCounts({})
    setRecentChannels([DEFAULT_GEOHASH])
    setBlockedPubkeys([])
    blockedPeerNamesRef.current = {}
    setBlockedPeerNames({})
    setTrustedPubkeys([])
    setPeerNotes({})
    pendingTrustRequestRef.current = null
    setPendingTrustRequest(null)
    setBlossomServers([...DEFAULT_BLOSSOM_SERVERS])
    setVoiceSendPhase('idle')
    setCustomRelays([])
    activeGeohashRef.current = DEFAULT_GEOHASH
    activeChannelGenRef.current += 1
    setChannelMessagesState({ channelKey: DEFAULT_GEOHASH, items: [] })
    setPeersState({ channelKey: DEFAULT_GEOHASH, items: [] })
    setLocationNotesState({ channelKey: DEFAULT_GEOHASH, items: [] })
    setReplyingTo(null)
    setUnreadDividerId(null)
    setActiveGeohash(DEFAULT_GEOHASH)
    setActiveView({ type: 'channel', geohash: DEFAULT_GEOHASH })
    setIdentityVersion((v) => v + 1)

    clearToasts()
    pushToast(
      'warning',
      'Panic Wipe Complete',
      'All local keys, caches, Agmail vault, Agwallet proofs, groups, trusted peers, active calls, and decrypted audio purged. Fresh identity active.'
    )
  }, [
    pool,
    presenceTracker,
    revokeAllOptimisticVoiceUrls,
    clearPulse,
    clearAllDms,
    resetAllServers,
    resetAllCalls,
    resetAllGames,
    resetAllTranscription,
    resetAllNotifications,
    contentFilterEngine,
    translatorEngine,
    walletEngine,
    zapsEngine,
    deviceSyncEngine,
    amailEngine,
    agoraEngine,
    resetLocation,
    identityManager,
    clearToasts,
    pushToast,
  ])

  // Unified composer submit (commands, DMs, public messages)
  const addSystemMessage = useCallback(
    (text: string) => {
      const gh = activeGeohashRef.current
      const msg = createSystemMessage(gh, text)
      updateChannelMessages(gh, (prev) => [...prev, msg], { persist: false })
    },
    [updateChannelMessages]
  )

  const sendInput = useCallback(
    async (
      rawText: string,
      options?: {
        onPublishedId?: (id: string) => void
        originalText?: string
        translatedToLang?: string
        sourceLang?: string
      }
    ): Promise<boolean> => {
      const trimmed = rawText.trim()
      if (!trimmed) return false

      if (trimmed.startsWith('/')) {
        return await executeSlashCommand(trimmed, {
          nickname: identityManager.getNickname(),
          activeGeohash,
          peers,
          blockedPubkeys,
          blockedPeerNames,
          trustedPubkeys,
          strictWhitelistMode: settings.strictWhitelistMode,
          setNickname,
          tuneGeohash,
          tuneTopicChannel,
          openDmThread,
          sendDirectMessage,
          sendPublicContent: (text) => sendPublicContent(text, null, options?.onPublishedId),
          postLocationNote,
          refreshLocationNotes,
          toggleBlockPeer,
          trustPubkey,
          untrustPubkey,
          setStrictWhitelistMode,
          clearCurrentTimeline,
          setTheme,
          rotateIdentity,
          addSystemMessage,
        })
      }

      const handlePublishedId = (id: string) => {
        options?.onPublishedId?.(id)
        if (options?.originalText && options.translatedToLang) {
          translatorEngine.recordOutgoingOriginal(
            id,
            options.originalText,
            trimmed,
            options.translatedToLang,
            options.sourceLang
          )
        }
      }

      if (activeView.type === 'dm') {
        return await sendDirectMessage(activeView.peerPubkey, trimmed, undefined, handlePublishedId)
      }

      if (activeView.type === 'server') {
        return await serversEngine.sendMessage(trimmed, { onPublishedId: handlePublishedId })
      }

      return await sendPublicContent(trimmed, undefined, handlePublishedId)
    },
    [
      identityManager,
      activeGeohash,
      peers,
      blockedPubkeys,
      blockedPeerNames,
      trustedPubkeys,
      settings.strictWhitelistMode,
      setNickname,
      tuneGeohash,
      tuneTopicChannel,
      openDmThread,
      sendDirectMessage,
      sendPublicContent,
      postLocationNote,
      refreshLocationNotes,
      toggleBlockPeer,
      trustPubkey,
      untrustPubkey,
      setStrictWhitelistMode,
      clearCurrentTimeline,
      setTheme,
      rotateIdentity,
      addSystemMessage,
      activeView,
      serversEngine,
      translatorEngine,
    ]
  )

  const visibleMessages = useMemo(() => {
    if (!settings.strictWhitelistMode) return messages
    return messages.filter(
      (m) =>
        m.isSystem ||
        m.isBlockedPlaceholder ||
        m.isOwn ||
        ownPubkeys.has(m.pubkey.toLowerCase()) ||
        trustedSet.has(m.pubkey.toLowerCase())
    )
  }, [messages, settings.strictWhitelistMode, ownPubkeys, trustedSet])

  // Authoritatively sync active channel's exact bottom visible message to BOTH
  // channelPreviews and Global Pulse so the sidebar preview ALWAYS matches MessageStream 1:1.
  useEffect(() => {
    const ghKey = activeGeohash.toLowerCase()
    const latest = extractLatestVisiblePreview(
      visibleMessages,
      blockedSet,
      trustedSet,
      ownPubkeys,
      settings.strictWhitelistMode
    )
    if (!latest) return
    upsertChannelPreview(
      ghKey,
      {
        id: latest.id,
        preview: latest.preview,
        sender: latest.sender,
        senderPubkey: latest.senderPubkey,
        createdAt: latest.createdAt,
      },
      { force: true }
    )
    recordRoomMessage({
      id: latest.id,
      geohash: ghKey,
      pubkey: latest.senderPubkey,
      sender: latest.sender,
      preview: latest.preview,
      createdAtSec: latest.createdAt,
      isAuthoritative: true,
    })
  }, [
    activeGeohash,
    visibleMessages,
    blockedSet,
    trustedSet,
    ownPubkeys,
    settings.strictWhitelistMode,
    upsertChannelPreview,
    recordRoomMessage,
  ])

  // Watch visible public Bitchat & Server message event IDs for live NIP-57 (kind: 9735) zap receipts
  const watchZapEventIds = zapsEngine.watchEventIds
  useEffect(() => {
    const source =
      activeView.type === 'channel'
        ? visibleMessages
        : activeView.type === 'server'
          ? serversEngine.messages
          : []
    if (source.length === 0) return
    const ids: string[] = []
    for (let i = Math.max(0, source.length - 80); i < source.length; i += 1) {
      const msg = source[i]
      if (!msg.isSystem && !msg.isBlockedPlaceholder && msg.id) {
        ids.push(msg.id)
      }
    }
    if (ids.length > 0) {
      watchZapEventIds(ids)
    }
  }, [activeView.type, visibleMessages, serversEngine.messages, watchZapEventIds])

  const hiddenByWhitelistCount = settings.strictWhitelistMode
    ? Math.max(0, messages.length - visibleMessages.length)
    : 0

  const exportTranscript = useCallback(
    (format: 'markdown' | 'json') =>
      formatTranscriptExport(
        format,
        cell,
        visibleMessages.filter((m) => !m.isBlockedPlaceholder),
        activeGeohash
      ),
    [cell, visibleMessages, activeGeohash]
  )

  // Relay telemetry aggregates
  const connectedRelays = useMemo(() => relays.filter((r) => r.status === 'connected'), [relays])
  const avgLatencyMs = useMemo(() => {
    const samples = connectedRelays
      .map((r) => r.rttMs)
      .filter((v): v is number => v !== null && Number.isFinite(v))
    if (samples.length === 0) return null
    return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
  }, [connectedRelays])

  const totalGeoUnread = useMemo(
    () => Object.values(geoUnreadCounts).reduce((sum, n) => sum + n, 0),
    [geoUnreadCounts]
  )
  const totalGeoMentions = useMemo(
    () => Object.values(geoMentionCounts).reduce((sum, n) => sum + n, 0),
    [geoMentionCounts]
  )

  return {
    activeView,
    activeGeohash,
    cell,
    isTeleported: effectiveIsTeleported,
    location: effectiveLocation,
    quickCities: QUICK_CITIES,

    messages: visibleMessages,
    nearby,
    peers,
    readRoomPeers: () => presenceTracker.getPeers(activeGeohash, ownPubkeys, blockedSet),
    presence,
    locationNotes,
    channelHistoryEpoch,
    localBitchatSend,
    unreadDividerId,
    sending,
    replyingTo,
    setReplyingTo,

    pulseRooms,
    channelPreviews,
    pinnedChannels,
    recentChannels,
    unreadCounts: geoUnreadCounts,
    mentionCounts: geoMentionCounts,
    totalGeoUnread,
    totalGeoMentions,
    isChannelPinned,
    togglePinChannel,
    reorderPinnedChannels,

    dmThreads,
    activeDmThread,
    dmReplyingTo,
    setDmReplyingTo,
    sendDmReaction,
    totalDmUnread,
    openDmThread,
    closeDmThread,
    sendDirectMessage,

    tuneGeohash,
    tuneBitchatChannel,
    tuneTopicChannel,
    locateMe,
    sendInput,
    sendReaction,
    postLocationNote,
    refreshLocationNotes,
    clearCurrentTimeline,
    markChannelRead,

    blockedPubkeys,
    blockedPeerNames,
    isPeerBlocked,
    toggleBlockPeer,
    getPeerByPubkey,
    trustedPubkeys,
    isTrusted,
    isExplicitlyTrusted,
    canLoadVoiceMemo,
    trustPubkey,
    pendingTrustRequest,
    confirmPendingTrust,
    cancelPendingTrust,
    untrustPubkey,
    clearTrustedPubkeys,
    peerNotes,
    setPeerNote,
    strictWhitelistMode: settings.strictWhitelistMode,
    setStrictWhitelistMode,
    setAllowUntrustedVoiceMemos,
    hiddenByWhitelistCount,

    blossomServers,
    addBlossomServer,
    removeBlossomServer,
    resetBlossomServers,
    voiceSendPhase,
    sendVoiceMemo,
    fetchVoiceMemoBlob,
    sendImageAttachment,
    fetchImageAttachmentBlob,

    relays,
    connectedRelayCount: connectedRelays.length,
    totalRelayCount: relays.length,
    avgLatencyMs,
    customRelays,
    geoDirectoryCount: geoDirectory.length,
    addCustomRelay,
    removeCustomRelay,
    resetCustomRelays,
    reconnectRelays,

    identity,
    profiles: profilesEngine,
    getProfilePicture,
    ensureProfilePictures,
    updateMyProfilePicture,
    settings,
    broadcastClientTag: settings.broadcastClientTag,
    setBroadcastClientTag,
    setNickname,
    setSignMode,
    setLocalSecret,
    rotateIdentity,
    updateSettings,
    setTheme,
    panicWipe,

    servers: serversEngine,
    calls: callsEngine,
    games: gamesEngine,
    transcription: transcriptionEngine,
    contentFilter: contentFilterEngine,
    translator: translatorEngine,
    wallet: walletEngine,
    zaps: zapsEngine,
    deviceSync: deviceSyncEngine,
    amail: amailEngine,
    agora: agoraEngine,
    notifications: notificationsEngine,

    commands: SLASH_COMMANDS,
    exportTranscript,
    toasts,
    pushToast,
    dismissToast,
  }
}
