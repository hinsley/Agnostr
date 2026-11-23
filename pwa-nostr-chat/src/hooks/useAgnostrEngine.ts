import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Filter } from 'nostr-tools'
import type {
  ActiveView,
  AgnostrEngine,
  AppSettings,
  DmProtocol,
  GeoMessage,
  ImageAttachment,
  LocationNote,
  PeerInfo,
  PendingTrustRequest,
  PinnedChannel,
  PreparedImage,
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
  buildLocationNoteTemplate,
  buildNamedRadioChatTemplate,
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
  KIND_NAMED_RADIO_CHAT,
  mineNip13NonceTag,
  parseGeohashChatEvent,
  parseLocationNoteEvent,
  parseNamedRadioChatEvent,
  parseReactionEvent,
  verifyEventCached,
  type ParsedReaction,
} from '../lib/bitchatProtocol.ts'
import { executeSlashCommand, SLASH_COMMANDS } from '../lib/commands.ts'
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
  type GeoRelayEntry,
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
  formatRadioChannelHash,
  getTopicSlug,
  isTopicChannel,
  isValidRadioChannelKey,
  makeTopicChannelKey,
  normalizeRadioChannelKey,
  parseQuickTuneInput,
  parseRadioChannelHash,
  TOPIC_CHANNEL_PREFIX,
} from '../lib/radioChannel.ts'
import { RelayPool } from '../lib/relayPool.ts'
import {
  clearChannelMessagesStorage,
  DEFAULT_SETTINGS,
  formatTranscriptExport,
  loadActiveGeohash,
  loadBlockedPubkeys,
  loadBlossomServers,
  loadChannelMessages,
  loadCustomRelays,
  loadDeviceSeedHex,
  loadGeoDirectoryCache,
  loadLocalSecret,
  loadNickname,
  loadPinnedChannels,
  loadRecentChannels,
  loadSettings,
  loadSignMode,
  loadTrustedPubkeys,
  panicWipeStorage,
  saveActiveGeohash,
  saveBlockedPubkeys,
  saveBlossomServers,
  saveChannelMessages,
  saveCustomRelays,
  saveDeviceSeedHex,
  saveGeoDirectoryCache,
  saveLocalSecret,
  saveNickname,
  savePinnedChannels,
  saveRecentChannels,
  saveSettings,
  saveSignMode,
  saveTrustedPubkeys,
} from '../lib/storage.ts'
import { buildNip42AuthTemplate } from '../lib/nip29.ts'
import { CALL_SIGNALING_RELAYS } from '../lib/callSignaling.ts'
import { revokeVoicePreviewUrl } from '../lib/voiceRecorder.ts'
import { useAmail } from './useAmail.ts'
import { useCallEngine } from './useCallEngine.ts'
import { useCashuWallet } from './useCashuWallet.ts'
import { useContentFilter } from './useContentFilter.ts'
import { useDeviceSync } from './useDeviceSync.ts'
import { useDirectMessages } from './useDirectMessages.ts'
import { useGlobalPulse } from './useGlobalPulse.ts'
import { useLocation } from './useLocation.ts'
import {
  useNotifications,
  type NotifyGeoMessageInput,
  type NotifyLocationNoteInput,
} from './useNotifications.ts'
import { useServers } from './useServers.ts'
import { useToasts } from './useToasts.ts'
import { useTranscription } from './useTranscription.ts'
import { useTranslator } from './useTranslator.ts'
import { useZaps } from './useZaps.ts'

const THEME_META_COLORS: Record<ThemeId, string> = {
  phosphor: '#090c0a',
  amber: '#0d0a07',
  obsidian: '#09090f',
  daylight: '#f4f5f2',
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
    const parsed = parseRadioChannelHash(window.location.hash || '')
    if (parsed) return parsed
  }
  return loadActiveGeohash()
}

export function useAgnostrEngine(): AgnostrEngine {
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
      perGeohashIdentity: settings.perGeohashIdentity,
    })
    saveDeviceSeedHex(mgr.getDeviceSeedHex())
    saveNickname(mgr.getNickname())
    identityManagerRef.current = mgr
  }
  const identityManager = identityManagerRef.current

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

  const cell = useMemo(
    () => buildGeohashCell(activeGeohash, localFullGeohash),
    [activeGeohash, localFullGeohash]
  )

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
      if (lowerHash.startsWith('invite=') || lowerHash.startsWith('notify=') || lowerHash.startsWith('dm=')) return
      const currentKey = parseRadioChannelHash(window.location.hash || '')
      const targetHash = formatRadioChannelHash(activeGeohash)
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
      if (lowerHash.startsWith('invite=') || lowerHash.startsWith('notify=') || lowerHash.startsWith('dm=')) return
      const parsed = parseRadioChannelHash(window.location.hash || '')
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
    () => selectRelaysForGeohash(activeGeohash, geoDirectory, customRelays, 5),
    [activeGeohash, geoDirectory, customRelays]
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

  // Synchronously derive current channel slices on render frame 0 (zero 1-frame stale bleed)
  const messages = useMemo(() => {
    const raw =
      channelMessagesState.channelKey === activeGeohash
        ? channelMessagesState.items
        : backfillReplyReferences(loadChannelMessages(activeGeohash))
    if (blockedSet.size === 0) return raw
    return raw.filter((m) => m.isSystem || !blockedSet.has(m.pubkey.toLowerCase()))
  }, [channelMessagesState, activeGeohash, blockedSet])

  const peers = useMemo(
    () => (peersState.channelKey === activeGeohash ? peersState.items : []),
    [peersState, activeGeohash]
  )

  // Whitelist-based receipt & Blossom media servers
  const [trustedPubkeys, setTrustedPubkeys] = useState<TrustedPeerEntry[]>(() => loadTrustedPubkeys())
  const trustedSet = useMemo(() => new Set(trustedPubkeys.map((t) => t.pubkey)), [trustedPubkeys])

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
    if (!clean || /^anon[0-9a-f]{4}$/i.test(clean)) return
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
  useEffect(() => {
    const cache = voiceCacheRef.current
    return () => {
      cache?.revokeAll()
    }
  }, [])

  const activeGeohashRef = useRef<string>(activeGeohash)
  const activeChannelGenRef = useRef<number>(0)
  const subSeqRef = useRef<number>(0)
  const messagesRef = useRef<GeoMessage[]>(messages)
  const messagesChannelRef = useRef<string>(activeGeohash)
  const blockedSetRef = useRef<Set<string>>(blockedSet)
  const trustedSetRef = useRef<Set<string>>(trustedSet)
  const strictWhitelistRef = useRef<boolean>(settings.strictWhitelistMode)
  const ownPubkeysRef = useRef<Set<string>>(ownPubkeys)
  const activeViewRef = useRef<ActiveView>(activeView)
  const notifyGeoMessageRef = useRef<(input: NotifyGeoMessageInput) => void>(() => {})
  const notifyLocationNoteRef = useRef<(input: NotifyLocationNoteInput) => void>(() => {})
  const seedMemoTranscriptRef = useRef<
    (memoKey: string, text: string, modelLabel?: string) => void
  >(() => {})
  const relaySelectionRef = useRef(relaySelection)
  const activeServerRelaysRef = useRef<string[]>([])
  const zapsIngestEventTagsRef = useRef<(pubkey: string, tags: string[][]) => void>(() => {})

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
    ownPubkeysRef.current = ownPubkeys
  }, [ownPubkeys])

  useLayoutEffect(() => {
    activeViewRef.current = activeView
  }, [activeView])

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
      const gh = normalizeRadioChannelKey(rawGh) ?? normalizeGeohash(rawGh)
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
      const gh = normalizeRadioChannelKey(rawGh) ?? normalizeGeohash(rawGh)
      if (!gh) return
      delete geoUnreadItemsRef.current[gh]
      recomputeGeoUnreads()
    },
    [recomputeGeoUnreads]
  )

  // Immediately recompute all radio unread & mention counts when mute/block or whitelist changes
  useEffect(() => {
    recomputeGeoUnreads()
  }, [blockedSet, trustedSet, ownPubkeys, settings.strictWhitelistMode, recomputeGeoUnreads])

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
      const targetKey = normalizeRadioChannelKey(rawChannelKey) ?? normalizeGeohash(rawChannelKey)
      if (!targetKey) return
      const shouldPersist = opts?.persist !== false
      const allowBg = opts?.allowBackgroundPersist === true

      const keepForTarget = (list: GeoMessage[]): GeoMessage[] =>
        list.filter((m) => {
          if (m.isSystem) return true
          const mk = normalizeRadioChannelKey(m.geohash) ?? normalizeGeohash(m.geohash)
          return mk === targetKey
        })

      if (activeGeohashRef.current !== targetKey) {
        if (allowBg && shouldPersist) {
          const cached = loadChannelMessages(targetKey)
          const updated = updater(cached)
          if (updated && updated !== cached) {
            saveChannelMessages(targetKey, keepForTarget(updated))
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
              saveChannelMessages(targetKey, keepForTarget(updated))
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
          saveChannelMessages(targetKey, safeItems)
        }
        return { channelKey: targetKey, items: safeItems }
      })
    },
    []
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
      isTeleported: location.isTeleported,
      isAgnostrClient: settings.broadcastClientTag,
    })
    refreshPeers(activeGeohash)
  }, [
    activeGeohash,
    identity.activePubkey,
    identity.nickname,
    location.isTeleported,
    settings.broadcastClientTag,
    presenceTracker,
    refreshPeers,
  ])

  // Active radio channel subscription (geohash: kind 20000/20001/20007; topic: kind 23333/20007 #d)
  useEffect(() => {
    let cancelled = false
    const myGen = ++activeChannelGenRef.current
    const gh = activeGeohash
    const isTopic = isTopicChannel(gh)
    const topicSlug = getTopicSlug(gh)
    const cached = backfillReplyReferences(
      loadChannelMessages(gh).filter((m) => !blockedSetRef.current.has(m.pubkey.toLowerCase()))
    )
    setChannelMessagesState((prev) => {
      if (prev.channelKey === gh && prev.items.length > 0) {
        return prev
      }
      return { channelKey: gh, items: cached }
    })
    setReplyingTo(null)
    setUnreadDividerId(null)

    // Seed peers from cached messages (historical seenAt)
    for (const m of cached) {
      if (m.isSystem) continue
      presenceTracker.recordActivity({
        geohash: gh,
        pubkey: m.pubkey,
        seenAtSec: m.createdAt,
        nickname: m.nickname,
        isTeleported: m.isTeleported,
        isMeshBridge: m.isMeshBridge,
        isAgnostrClient: m.isAgnostrClient,
        isMessage: true,
      })
    }
    refreshPeers(gh)

    if (!pool) return

    let isHistoryReplay = true
    const seenIds = new Set<string>(cached.map((m) => m.id))
    const pendingReactions = new Map<string, ParsedReaction[]>()
    const eoseFallback = window.setTimeout(() => {
      if (cancelled) return
      isHistoryReplay = false
    }, 3000)

    const since = Math.floor(Date.now() / 1000) - 3600
    const subSeq = ++subSeqRef.current
    const subId =
      isTopic && topicSlug
        ? `agnostr-radio-t-${subSeq}`
        : `agnostr-radio-g-${subSeq}`
    const filters =
      isTopic && topicSlug
        ? [
            {
              kinds: [KIND_NAMED_RADIO_CHAT],
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
          if (blockedSetRef.current.has(pk)) return

          // Ephemeral reaction (kind 20007)
          if (ev.kind === KIND_EPHEMERAL_REACTION) {
            const parsed = parseReactionEvent(ev, gh)
            if (!parsed || parsed.geohash !== gh) return
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
            const isAgnostr = isAgnostrClientTag(ev.tags)
            presenceTracker.recordActivity({
              geohash: gh,
              pubkey: pk,
              seenAtSec: isHistoryReplay ? ev.created_at : Math.floor(Date.now() / 1000),
              isAgnostrClient: isAgnostr,
            })
            if (isAgnostr) {
              updateChannelMessages(gh, (prev) => {
                let changed = false
                const next = prev.map((m) => {
                  if (m.pubkey.toLowerCase() === pk && !m.isAgnostrClient) {
                    changed = true
                    return { ...m, isAgnostrClient: true }
                  }
                  return m
                })
                return changed ? next : null
              })
            }
            refreshPeers(gh)
            return
          }

          // Radio public message (kind 20000 for geohash, kind 23333 for named topic)
          const isExpectedChatKind = isTopic
            ? ev.kind === KIND_NAMED_RADIO_CHAT
            : ev.kind === KIND_GEOHASH_CHAT
          if (isExpectedChatKind) {
            const findParent = (id: string) =>
              messagesChannelRef.current === gh
                ? messagesRef.current.find((m) => m.id === id)
                : undefined
            const parsed = isTopic
              ? parseNamedRadioChatEvent(ev, gh, ownPubkeysRef.current, findParent)
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
                    isAgnostrClient: isAgnostrClientTag(ev.tags),
                  })
                  refreshPeers(gh)
                }
              }
              return
            }

            zapsIngestEventTagsRef.current(pk, ev.tags)
            const knownAgnostr = Boolean(
              parsed.isAgnostrClient ||
                (!parsed.isOwn && presenceTracker.isKnownAgnostrPeer(pk))
            )
            presenceTracker.recordActivity({
              geohash: gh,
              pubkey: pk,
              seenAtSec: isHistoryReplay ? parsed.createdAt : Math.floor(Date.now() / 1000),
              nickname: parsed.nickname,
              isTeleported: parsed.isTeleported,
              isMeshBridge: parsed.isMeshBridge,
              isAgnostrClient: knownAgnostr,
              isMessage: true,
            })
            refreshPeers(gh)

            updateChannelMessages(gh, (prev) => {
              if (prev.some((m) => m.id === parsed.id)) return null

              // Resolve incoming replyTo against latest prev state
              let hydrated: GeoMessage = knownAgnostr
                ? { ...parsed, isAgnostrClient: true }
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
              // and propagate newly discovered Agnostr client flag to earlier messages from this peer
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
                if (knownAgnostr && !hydrated.isOwn && updated.pubkey.toLowerCase() === pk && !updated.isAgnostrClient) {
                  updated = { ...updated, isAgnostrClient: true }
                }
                return updated
              })

              return [...backfilledPrev, hydrated]
                .sort((a, b) => a.createdAt - b.createdAt)
                .slice(-350)
            })

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
    updateChannelMessages,
    identityManager,
    incrementGeoUnread,
    refreshTrustedPeerLabel,
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
  }, [pool, activeGeohash, relaySelection.dmRelays, notesRefreshNonce])

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

  useEffect(() => {
    if (!pool || !watchedPinnedKey) return
    const watchedChannels = watchedPinnedKey.split(',').filter(Boolean)
    if (watchedChannels.length === 0) return

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

    const since = Math.floor(Date.now() / 1000)
    const filters: Filter[] = []
    if (watchedGeos.length > 0) {
      filters.push({ kinds: [KIND_GEOHASH_CHAT], '#g': watchedGeos, since })
    }
    if (watchedTopicSlugs.length > 0) {
      filters.push({ kinds: [KIND_NAMED_RADIO_CHAT], '#d': watchedTopicSlugs, since })
    }
    const watchRelays =
      watchedTopicSlugs.length > 0
        ? Array.from(new Set([...CORE_DM_RELAYS, ...PULSE_RELAYS.slice(0, 7)]))
        : CORE_DM_RELAYS

    let cancelled = false
    let backfillDone = false
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
          if (ev.kind !== KIND_GEOHASH_CHAT && ev.kind !== KIND_NAMED_RADIO_CHAT) return
          if (geoSeenIdsRef.current.has(ev.id)) return
          if (!backfillDone && ev.created_at < since - 2) return
          if (!verifyEventCached(ev)) return
          geoSeenIdsRef.current.add(ev.id)
          if (geoSeenIdsRef.current.size > 1200) {
            const first = geoSeenIdsRef.current.values().next().value
            if (first) geoSeenIdsRef.current.delete(first)
          }
          const pk = ev.pubkey.toLowerCase()
          let gh: string | null = null
          if (ev.kind === KIND_NAMED_RADIO_CHAT) {
            const slug = extractTopicChannelTag(ev.tags)
            gh = slug ? `${TOPIC_CHANNEL_PREFIX}${slug}` : null
          } else {
            gh = extractGeohashTag(ev.tags)
          }
          if (!gh || !watchedSet.has(gh) || !(ev.content ?? '').trim()) return

          // Never double-count if user just switched onto this geohash
          if (activeViewRef.current.type === 'channel' && activeViewRef.current.geohash === gh) {
            return
          }

          const geoPubkey = identityManager.getKeyMaterialForGeohash(gh).pubkey.toLowerCase()
          const masterPubkey = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
          if (
            pk === geoPubkey ||
            pk === masterPubkey ||
            ownPubkeysRef.current.has(pk) ||
            blockedSetRef.current.has(pk)
          ) {
            return
          }
          if (strictWhitelistRef.current && !trustedSetRef.current.has(pk)) return

          const rawNick = getTagValue(ev.tags, 'n')
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
  }, [pool, watchedPinnedKey, identityManager, incrementGeoUnread, refreshTrustedPeerLabel])

  // Privacy-safe kind 20001 presence heartbeat (strictly precision <= 5 per GeohashPresenceSpec.md)
  useEffect(() => {
    if (!pool) return
    if (!canBroadcastPresenceForGeohash(activeGeohash, settings.presenceEnabled)) return
    // Don't prompt NIP-07 extension popups on background heartbeats
    if (identityManager.getSignMode() === 'extension') return

    let cancelled = false
    let timerId: number | null = null

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
      if (!cancelled) {
        timerId = window.setTimeout(() => void broadcastOnce(), nextPresenceDelayMs())
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

  // Global Pulse Radar (strictly respects muted/blocked peers & strict whitelist mode)
  const { pulseRooms, clearPulse } = useGlobalPulse(pool, true, {
    blockedSet,
    trustedSet,
    ownPubkeys,
    strictWhitelistMode: settings.strictWhitelistMode,
  })

  // Direct Messages (dual-stack: Bitchat v2 + NIP-17)
  const activeDmPeer = activeView.type === 'dm' ? activeView.peerPubkey : null
  const {
    dmThreads,
    dmClearedAt,
    totalDmUnread,
    ensureThread,
    sendDirectMessage,
    sendDirectVoiceMemo,
    sendDirectImageAttachment,
    clearThread,
    closeThread: closeDmThreadRaw,
    mergeSyncedDmClearedAt,
    mergeSyncedDmMessages,
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
    onError: (title, detail) => {
      pushToast('error', title, detail)
    },
  })

  const activeDmThread = useMemo(
    () => (activeDmPeer ? dmThreads.find((t) => t.peerPubkey === activeDmPeer.toLowerCase()) ?? null : null),
    [activeDmPeer, dmThreads]
  )

  const handleSeedMemoTranscript = useCallback(
    (memoKey: string, text: string, modelLabel?: string) => {
      seedMemoTranscriptRef.current(memoKey, text, modelLabel)
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
    getPublishRelayUrls: getZapPublishRelayUrls,
    ownPubkeys,
    activeNickname: identity.nickname,
    pushToast,
  })

  useLayoutEffect(() => {
    zapsIngestEventTagsRef.current = zapsEngine.ingestEventTags
  }, [zapsEngine.ingestEventTags])

  // Discord-like Servers (Instant Virtual Public/E2EE + NIP-29 Relay Communities)
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
    setVoiceSendPhase,
    onSeedMemoTranscript: handleSeedMemoTranscript,
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
    pushToast,
  })

  // Amail — E2EE Briar-Inspired Store-and-Forward Meshnet Snailmail
  const notifyAmailChangedRef = useRef<() => void>(() => {})
  const handleAmailLocalChange = useCallback(() => {
    notifyAmailChangedRef.current()
  }, [])

  const amailEngine = useAmail({
    relayPool: pool,
    identityManager,
    masterPubkey: identity.masterPubkey,
    activeNickname: identity.nickname,
    trustedPubkeys,
    blockedPubkeys,
    turnConfig: callsEngine.turnConfig,
    onLocalChange: handleAmailLocalChange,
    pushToast,
  })

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
    (nextBlocked: string[]) => {
      const prevSet = blockedSetRef.current
      const normalized = Array.from(new Set(nextBlocked.map((p) => p.toLowerCase())))
      const nextSet = new Set(normalized)
      blockedSetRef.current = nextSet
      setBlockedPubkeys(normalized)
      saveBlockedPubkeys(normalized)

      const newlyBlocked = normalized.filter((pk) => !prevSet.has(pk))
      if (newlyBlocked.length > 0) {
        const newlySet = new Set(newlyBlocked)
        setChannelMessagesState((curr) => {
          const filtered = curr.items.filter(
            (m) => m.isSystem || !newlySet.has(m.pubkey.toLowerCase())
          )
          if (filtered.length === curr.items.length) return curr
          saveChannelMessages(curr.channelKey, filtered)
          return { channelKey: curr.channelKey, items: filtered }
        })
        setLocationNotesState((curr) => {
          const filtered = curr.items.filter((n) => !newlySet.has(n.pubkey.toLowerCase()))
          if (filtered.length === curr.items.length) return curr
          return { channelKey: curr.channelKey, items: filtered }
        })
        for (const pk of newlyBlocked) {
          voiceCacheRef.current?.revokeForSender(pk)
          contentFilterEngine.revokeForSender(pk)
        }
      }
      recomputeGeoUnreads()
      refreshPeers(activeGeohashRef.current)
    },
    [contentFilterEngine, recomputeGeoUnreads, refreshPeers]
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

  const handleMergeSyncedRadioMessages = useCallback(
    (channelKey: string, incoming: GeoMessage[]): number => {
      const gh = normalizeRadioChannelKey(channelKey)
      if (!gh || incoming.length === 0) return 0

      const validIncoming: GeoMessage[] = []
      for (const raw of incoming) {
        if (!raw || raw.isSystem || typeof raw.id !== 'string' || !raw.id) continue
        const msgKey = normalizeRadioChannelKey(raw.geohash)
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
            [...prev, ...toAdd].sort((a, b) => a.createdAt - b.createdAt)
          )
        },
        { persist: true, allowBackgroundPersist: true }
      )
      return addedCount
    },
    [updateChannelMessages]
  )

  const {
    deviceSync: deviceSyncEngine,
    registerAmailSyncProvider,
    notifyAmailChanged,
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
    pinnedChannels,
    dmClearedAt,
    lightningAddress: zapsEngine.lightningAddress,
    dmThreads,
    activeGeohash,
    activeRadioMessages: messages,
    activeServerMessages: serversEngine.messages,
    onApplyServers: applySyncedJoinedServers,
    onApplyTrusted: handleApplySyncedTrusted,
    onApplyBlocked: handleApplySyncedBlocked,
    onApplyPinned: handleApplySyncedPinned,
    onApplyDmClearedAt: mergeSyncedDmClearedAt,
    onApplyLightningAddress: handleApplySyncedLightningAddress,
    onApplyNickname: handleApplySyncedNickname,
    onMergeDmMessages: mergeSyncedDmMessages,
    onMergeServerMessages: mergeSyncedServerMessages,
    onMergeRadioMessages: handleMergeSyncedRadioMessages,
  })

  useLayoutEffect(() => {
    notifyAmailChangedRef.current = notifyAmailChanged
  }, [notifyAmailChanged])

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

  const presence = useMemo(
    () =>
      presenceTracker.getSummary(
        activeGeohash,
        peers,
        settings.presenceEnabled && identity.signMode !== 'extension'
      ),
    [presenceTracker, activeGeohash, peers, settings.presenceEnabled, identity.signMode]
  )

  // Channel navigation & pins
  useEffect(() => {
    if (activeView.type !== 'channel') return
    clearGeoUnread(activeView.geohash)
  }, [activeView, clearGeoUnread])

  const markChannelRead = useCallback((geohash?: string) => {
    const raw = geohash ?? activeGeohash
    const target = normalizeRadioChannelKey(raw) ?? normalizeGeohash(raw)
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

  const tuneRadioChannel = useCallback((channelKeyOrInput: string): boolean => {
    const direct = normalizeRadioChannelKey(channelKeyOrInput)
    if (direct) {
      applyTunedChannel(direct)
      return true
    }
    const resolved = parseQuickTuneInput(channelKeyOrInput, 'geo')
    if (!resolved) {
      pushToast(
        'warning',
        'Invalid radio channel',
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
    return tuneRadioChannel(geohashOrCity)
  }, [tuneRadioChannel])

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
      const key = normalizeRadioChannelKey(geohash) ?? normalizeGeohash(geohash)
      return pinnedChannels.some((p) => p.geohash === key)
    },
    [pinnedChannels]
  )

  const togglePinChannel = useCallback(
    (geohash: string, label?: string) => {
      const gh = normalizeRadioChannelKey(geohash)
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

  // Publish public radio message (kind 20000 geohash or kind 23333 topic + optional NIP-13 PoW)
  const sendPublicContent = useCallback(
    async (
      rawText: string,
      replyOverride?: GeoMessage | null,
      onPublishedId?: (id: string) => void
    ): Promise<boolean> => {
      const content = rawText.trim()
      if (!content || !pool) return false

      const gh = activeGeohashRef.current
      const targetRelays = relaySelection.channelRelays
      const isTopic = isTopicChannel(gh)
      const nick = identityManager.getNickname()
      const activeKey = identityManager.getKeyMaterialForGeohash(gh)
      const replyTarget = replyOverride !== undefined ? replyOverride : replyingTo

      setSending(true)
      try {
        const template = isTopic
          ? buildNamedRadioChatTemplate({
              content,
              topic: gh,
              nickname: nick,
              replyTo: replyTarget,
              broadcastClientTag: settings.broadcastClientTag,
              lightningAddress: zapsEngine.lightningAddress,
            })
          : buildGeohashChatTemplate({
              content,
              geohash: gh,
              nickname: nick,
              isTeleported: location.isTeleported,
              replyTo: replyTarget,
              broadcastClientTag: settings.broadcastClientTag,
              lightningAddress: zapsEngine.lightningAddress,
            })

        // Mine 8-bit NIP-13 PoW non-blocking when enabled and pubkey is known
        if (settings.powEnabled && settings.powTargetBits > 0 && activeKey.pubkey) {
          const nonceTag = await mineNip13NonceTag(template, activeKey.pubkey, settings.powTargetBits, 450)
          if (nonceTag) {
            template.tags = [...template.tags, nonceTag]
          }
        }

        const signed = await identityManager.signEvent(template, gh)
        onPublishedId?.(signed.id)
        const findParent = (id: string) =>
          messagesChannelRef.current === gh
            ? messagesRef.current.find((m) => m.id === id)
            : undefined
        const optimistic = isTopic
          ? parseNamedRadioChatEvent(signed, gh, ownPubkeysRef.current, findParent)
          : parseGeohashChatEvent(signed, gh, ownPubkeysRef.current, findParent)
        if (optimistic) {
          optimistic.deliveryStatus = 'sending'
          optimistic.isOwn = true
          updateChannelMessages(
            gh,
            (prev) => {
              if (prev.some((m) => m.id === optimistic.id)) return null
              return [...prev, optimistic].sort((a, b) => a.createdAt - b.createdAt)
            },
            { allowBackgroundPersist: true }
          )
        }

        if (activeGeohashRef.current === gh) {
          setReplyingTo(null)
        }

        const res = await pool.publish(targetRelays, signed)
        const ok = res.acceptedRelays.length > 0

        updateChannelMessages(
          gh,
          (prev) => {
            let changed = false
            const next = prev.map((m) => {
              if (m.id !== signed.id) return m
              changed = true
              return {
                ...m,
                deliveryStatus: (ok ? 'sent' : 'failed') as GeoMessage['deliveryStatus'],
                relayCount: res.acceptedRelays.length,
              }
            })
            return changed ? next : null
          },
          { allowBackgroundPersist: true }
        )

        if (!ok) {
          pushToast('error', 'Failed to broadcast message', 'No connected relay accepted the event.')
        }
        return ok
      } catch (err) {
        pushToast('error', 'Signing failed', err instanceof Error ? err.message : 'Unable to sign event.')
        return false
      } finally {
        setSending(false)
      }
    },
    [
      pool,
      identityManager,
      replyingTo,
      location.isTeleported,
      settings.powEnabled,
      settings.powTargetBits,
      settings.broadcastClientTag,
      zapsEngine.lightningAddress,
      relaySelection.channelRelays,
      updateChannelMessages,
      pushToast,
    ]
  )

  const sendReaction = useCallback(
    async (message: GeoMessage, emoji: string): Promise<void> => {
      if (!pool || message.isSystem) return
      const cleanEmoji = emoji.trim()
      if (!cleanEmoji) return

      const gh = normalizeRadioChannelKey(message.geohash) ?? activeGeohashRef.current
      const targets = Array.from(new Set([...relaySelection.dmRelays, ...relaySelection.channelRelays]))
      const template = buildReactionTemplate({
        geohash: gh,
        targetEventId: message.id,
        targetPubkey: message.pubkey,
        emoji: cleanEmoji,
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
    [pool, identityManager, relaySelection.dmRelays, relaySelection.channelRelays, updateChannelMessages, pushToast]
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
          pushToast('error', 'Dead-drop failed', 'No relay accepted the kind-1 location note.')
        }
        return ok
      } catch (err) {
        pushToast('error', 'Failed to drop note', err instanceof Error ? err.message : 'Signing error')
        return false
      }
    },
    [pool, identityManager, relaySelection.dmRelays, pushToast]
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
      pushToast('info', 'Channel cleared', 'Local server channel cache cleared.')
      return
    }
    const gh = activeGeohashRef.current
    setChannelMessagesState({ channelKey: gh, items: [] })
    setUnreadDividerId(null)
    clearChannelMessagesStorage(gh)
  }, [activeView, clearThread, serversEngine, pushToast])

  // Moderation
  const isPeerBlocked = useCallback((pubkey: string) => blockedSet.has(pubkey.toLowerCase()), [blockedSet])

  const toggleBlockPeer = useCallback(
    (pubkey: string, label?: string) => {
      const pk = pubkey.toLowerCase()
      setBlockedPubkeys((prev) => {
        const exists = prev.includes(pk)
        const next = exists ? prev.filter((p) => p !== pk) : [...prev, pk]
        blockedSetRef.current = new Set(next)
        saveBlockedPubkeys(next)
        if (!exists) {
          setChannelMessagesState((curr) => {
            const filtered = curr.items.filter((m) => m.isSystem || m.pubkey.toLowerCase() !== pk)
            if (filtered.length === curr.items.length) return curr
            saveChannelMessages(curr.channelKey, filtered)
            return { channelKey: curr.channelKey, items: filtered }
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
          pushToast('info', `Blocked ${label ?? pk.slice(0, 8)}`, 'Their messages are now hidden.')
        } else {
          recomputeGeoUnreads()
          refreshPeers(activeGeohashRef.current)
          pushToast('info', `Unblocked ${label ?? pk.slice(0, 8)}`)
        }
        return next
      })
    },
    [pushToast, recomputeGeoUnreads, refreshPeers, contentFilterEngine]
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
        saveBlockedPubkeys(unblocked)
        return unblocked
      })
      pushToast(
        'success',
        `Trusted ${cleanLabel ?? `#${pk.slice(-6)}`}`,
        'Media, voice memos, and P2P calls from this peer are now unlocked.'
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
        return clean && !/^anon[0-9a-f]{4}$/i.test(clean) ? clean : undefined
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
      return clean && !/^anon[0-9a-f]{4}$/i.test(clean) ? clean : null
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

  const untrustPubkey = useCallback(
    (pubkey: string) => {
      const pk = pubkey.toLowerCase()
      if (trustedSetRef.current.has(pk)) {
        const nextTrusted = new Set(trustedSetRef.current)
        nextTrusted.delete(pk)
        trustedSetRef.current = nextTrusted
      }
      voiceCacheRef.current?.revokeForSender(pk)
      setTrustedPubkeys((prev) => {
        const next = prev.filter((t) => t.pubkey !== pk)
        saveTrustedPubkeys(next)
        return next
      })
      pushToast('info', 'Removed from Trusted Peers', `Media from #${pk.slice(-6)} is now shielded again.`)
    },
    [pushToast]
  )

  const clearTrustedPubkeys = useCallback(() => {
    trustedSetRef.current = new Set()
    voiceCacheRef.current?.revokeAll()
    setTrustedPubkeys([])
    saveTrustedPubkeys([])
    pushToast('info', 'Trusted Peers cleared', 'All external voice memos & media are shielded.')
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
    async (recorded: RecordedVoiceMemo, caption?: string): Promise<boolean> => {
      if (activeView.type === 'server') {
        return await serversEngine.sendVoiceMemo(recorded, caption)
      }
      if (!pool) return false
      if (recorded.size <= 0) {
        pushToast('warning', 'Empty recording', 'Hold or record for at least a second before sending.')
        return false
      }

      const gh = activeGeohashRef.current
      const targetRelays = relaySelection.channelRelays
      const replyTarget = replyingTo
      const targetDmPeer = activeView.type === 'dm' ? activeView.peerPubkey : null
      const isDm = targetDmPeer !== null
      const cleanMime = cleanMimeType(recorded.mime)
      const cleanCaption = caption?.trim() ?? ''

      setSending(true)
      try {
        const rawBytes = new Uint8Array(await recorded.blob.arrayBuffer())

        if (isDm && targetDmPeer) {
          setVoiceSendPhase('encrypting')
          const { ciphertext, encryption } = await encryptVoiceBytesAesGcm(rawBytes)

          setVoiceSendPhase('uploading')
          const upload = await uploadBlobToBlossom({
            bytes: ciphertext,
            mime: 'application/octet-stream',
            servers: blossomServers,
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

          if (attachment.sha256 && recorded.previewTranscript?.trim()) {
            seedMemoTranscriptRef.current(
              attachment.sha256,
              recorded.previewTranscript,
              recorded.previewTranscriptModel
            )
          }

          setVoiceSendPhase('publishing')
          const ok = await sendDirectVoiceMemo(targetDmPeer, attachment, cleanCaption)
          if (ok) {
            revokeVoicePreviewUrl(recorded)
            pushToast('success', 'Encrypted voice memo sent', 'AES-256-GCM audio delivered inside E2EE gift wrap.')
          }
          return ok
        }

        // Public geohash channel: upload audio to Blossom + publish kind 20000 with NIP-92 imeta
        setVoiceSendPhase('uploading')
        const upload = await uploadBlobToBlossom({
          bytes: rawBytes,
          mime: cleanMime,
          servers: blossomServers,
          signAuthEvent: (tmpl) => identityManager.signEvent(tmpl, gh),
        })

        const attachment: VoiceMemoAttachment = {
          url: upload.url,
          mime: cleanMime,
          size: upload.size,
          durationSec: recorded.durationSec,
          waveform: recorded.waveform,
          sha256: upload.sha256,
          server: upload.server,
        }

        if (attachment.sha256 && recorded.previewTranscript?.trim()) {
          seedMemoTranscriptRef.current(
            attachment.sha256,
            recorded.previewTranscript,
            recorded.previewTranscriptModel
          )
        }

        setVoiceSendPhase('signing')
        const content = cleanCaption ? `${cleanCaption}\n${upload.url}` : upload.url
        const isTopic = isTopicChannel(gh)
        const activeKey = identityManager.getKeyMaterialForGeohash(gh)
        const template = isTopic
          ? buildNamedRadioChatTemplate({
              content,
              topic: gh,
              nickname: identityManager.getNickname(),
              replyTo: replyTarget,
              voiceMemo: attachment,
              broadcastClientTag: settings.broadcastClientTag,
              lightningAddress: zapsEngine.lightningAddress,
            })
          : buildGeohashChatTemplate({
              content,
              geohash: gh,
              nickname: identityManager.getNickname(),
              isTeleported: location.isTeleported,
              replyTo: replyTarget,
              voiceMemo: attachment,
              broadcastClientTag: settings.broadcastClientTag,
              lightningAddress: zapsEngine.lightningAddress,
            })

        if (settings.powEnabled && settings.powTargetBits > 0 && activeKey.pubkey) {
          const nonceTag = await mineNip13NonceTag(template, activeKey.pubkey, settings.powTargetBits, 450)
          if (nonceTag) {
            template.tags = [...template.tags, nonceTag]
          }
        }

        const signed = await identityManager.signEvent(template, gh)
        const findParent = (id: string) =>
          messagesChannelRef.current === gh
            ? messagesRef.current.find((m) => m.id === id)
            : undefined
        const optimistic = isTopic
          ? parseNamedRadioChatEvent(signed, gh, ownPubkeysRef.current, findParent)
          : parseGeohashChatEvent(signed, gh, ownPubkeysRef.current, findParent)
        if (optimistic) {
          optimistic.deliveryStatus = 'sending'
          optimistic.isOwn = true
          updateChannelMessages(
            gh,
            (prev) => {
              if (prev.some((m) => m.id === optimistic.id)) return null
              return [...prev, optimistic].sort((a, b) => a.createdAt - b.createdAt)
            },
            { allowBackgroundPersist: true }
          )
        }

        if (activeGeohashRef.current === gh) {
          setReplyingTo(null)
        }
        setVoiceSendPhase('publishing')

        const res = await pool.publish(targetRelays, signed)
        const ok = res.acceptedRelays.length > 0

        updateChannelMessages(
          gh,
          (prev) => {
            let changed = false
            const next = prev.map((m) => {
              if (m.id !== signed.id) return m
              changed = true
              return {
                ...m,
                deliveryStatus: (ok ? 'sent' : 'failed') as GeoMessage['deliveryStatus'],
                relayCount: res.acceptedRelays.length,
              }
            })
            return changed ? next : null
          },
          { allowBackgroundPersist: true }
        )

        if (ok) {
          revokeVoicePreviewUrl(recorded)
        } else {
          pushToast('error', 'Voice memo publish failed', 'Uploaded to Blossom, but no Nostr relay accepted the event.')
        }
        return ok
      } catch (err) {
        pushToast('error', 'Voice memo failed', err instanceof Error ? err.message : 'Unable to upload voice memo.')
        return false
      } finally {
        setVoiceSendPhase('idle')
        setSending(false)
      }
    },
    [
      pool,
      activeView,
      serversEngine,
      blossomServers,
      identityManager,
      sendDirectVoiceMemo,
      location.isTeleported,
      replyingTo,
      settings.powEnabled,
      settings.powTargetBits,
      settings.broadcastClientTag,
      zapsEngine.lightningAddress,
      relaySelection.channelRelays,
      updateChannelMessages,
      pushToast,
    ]
  )

  // STRICT engine-level Trusted Peers guard: zero network requests for untrusted senders
  const fetchVoiceMemoBlob = useCallback(
    async (memo: VoiceMemoAttachment, senderPubkey: string): Promise<string> => {
      const pk = senderPubkey.toLowerCase()
      const assertAuthorized = () => {
        if (!ownPubkeysRef.current.has(pk) && !trustedSetRef.current.has(pk)) {
          throw new Error('Blocked: trust this sender before loading voice memos or media.')
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
  } = useTranscription({
    activeCall: callsEngine.activeCall,
    fetchVoiceMemoBlob,
    pushToast,
  })

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
      if (isValidRadioChannelKey(gh)) {
        set.add(identityManager.getDerivedGeohashKeyMaterial(gh).pubkey.toLowerCase())
      }
    }
    return set
  }, [identityManager, identityVersion, activeGeohash, pinnedGeohashList, callsEngine.activeCall])

  const signNotificationEvent = useCallback(
    (tmpl: Parameters<IdentityManager['signEvent']>[0]) =>
      identityManager.signEvent(tmpl),
    [identityManager]
  )

  const {
    notifications: notificationsEngine,
    notifyGeoMessage,
    notifyLocationNote,
    resetAllNotifications,
  } = useNotifications({
    activeView,
    activeGeohash,
    ownPubkeys,
    blockedSet,
    trustedSet,
    strictWhitelistMode: settings.strictWhitelistMode,
    masterPubkey: identity.masterPubkey,
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
    signEvent: signNotificationEvent,
    pushToast,
  })

  useLayoutEffect(() => {
    notifyGeoMessageRef.current = notifyGeoMessage
  }, [notifyGeoMessage])

  useLayoutEffect(() => {
    notifyLocationNoteRef.current = notifyLocationNote
  }, [notifyLocationNote])

  const sendImageAttachment = useCallback(
    async (image: PreparedImage, caption?: string): Promise<boolean> => {
      if (!pool || image.size <= 0) return false

      if (activeView.type === 'server') {
        return await serversEngine.sendImageAttachment(image, caption)
      }

      const gh = activeGeohashRef.current
      const targetRelays = relaySelection.channelRelays
      const replyTarget = replyingTo
      const targetDmPeer = activeView.type === 'dm' ? activeView.peerPubkey : null
      const isDm = targetDmPeer !== null
      const cleanMime = cleanMimeType(image.mime, 'image/webp')
      const cleanCaption = caption?.trim() ?? ''

      setSending(true)
      try {
        const rawBytes = new Uint8Array(await image.blob.arrayBuffer())

        if (isDm && targetDmPeer) {
          setVoiceSendPhase('encrypting')
          const { ciphertext, encryption } = await encryptMediaBytesAesGcm(rawBytes)

          setVoiceSendPhase('uploading')
          const upload = await uploadBlobToBlossom({
            bytes: ciphertext,
            mime: 'application/octet-stream',
            servers: blossomServers,
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
          const ok = await sendDirectImageAttachment(targetDmPeer, attachment, cleanCaption)
          if (ok) {
            revokeImagePreviewUrl(image)
            pushToast('success', 'Encrypted image sent', 'AES-256-GCM image delivered inside E2EE gift wrap.')
          }
          return ok
        }

        // Public geohash channel: upload EXIF-stripped image to Blossom + publish kind 20000 with NIP-92 imeta
        setVoiceSendPhase('uploading')
        const upload = await uploadBlobToBlossom({
          bytes: rawBytes,
          mime: cleanMime,
          servers: blossomServers,
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
        const isTopic = isTopicChannel(gh)
        const activeKey = identityManager.getKeyMaterialForGeohash(gh)
        const template = isTopic
          ? buildNamedRadioChatTemplate({
              content,
              topic: gh,
              nickname: identityManager.getNickname(),
              replyTo: replyTarget,
              imageAttachment: attachment,
              broadcastClientTag: settings.broadcastClientTag,
              lightningAddress: zapsEngine.lightningAddress,
            })
          : buildGeohashChatTemplate({
              content,
              geohash: gh,
              nickname: identityManager.getNickname(),
              isTeleported: location.isTeleported,
              replyTo: replyTarget,
              imageAttachment: attachment,
              broadcastClientTag: settings.broadcastClientTag,
              lightningAddress: zapsEngine.lightningAddress,
            })

        if (settings.powEnabled && settings.powTargetBits > 0 && activeKey.pubkey) {
          const nonceTag = await mineNip13NonceTag(template, activeKey.pubkey, settings.powTargetBits, 450)
          if (nonceTag) {
            template.tags = [...template.tags, nonceTag]
          }
        }

        const signed = await identityManager.signEvent(template, gh)
        const findParent = (id: string) =>
          messagesChannelRef.current === gh
            ? messagesRef.current.find((m) => m.id === id)
            : undefined
        const optimistic = isTopic
          ? parseNamedRadioChatEvent(signed, gh, ownPubkeysRef.current, findParent)
          : parseGeohashChatEvent(signed, gh, ownPubkeysRef.current, findParent)
        if (optimistic) {
          optimistic.deliveryStatus = 'sending'
          optimistic.isOwn = true
          updateChannelMessages(
            gh,
            (prev) => {
              if (prev.some((m) => m.id === optimistic.id)) return null
              return [...prev, optimistic].sort((a, b) => a.createdAt - b.createdAt)
            },
            { allowBackgroundPersist: true }
          )
        }

        if (activeGeohashRef.current === gh) {
          setReplyingTo(null)
        }
        setVoiceSendPhase('publishing')

        const res = await pool.publish(targetRelays, signed)
        const ok = res.acceptedRelays.length > 0

        updateChannelMessages(
          gh,
          (prev) => {
            let changed = false
            const next = prev.map((m) => {
              if (m.id !== signed.id) return m
              changed = true
              return {
                ...m,
                deliveryStatus: (ok ? 'sent' : 'failed') as GeoMessage['deliveryStatus'],
                relayCount: res.acceptedRelays.length,
              }
            })
            return changed ? next : null
          },
          { allowBackgroundPersist: true }
        )

        if (ok) {
          revokeImagePreviewUrl(image)
        } else {
          pushToast('error', 'Image publish failed', 'Uploaded to Blossom, but no Nostr relay accepted the event.')
        }
        return ok
      } catch (err) {
        pushToast('error', 'Image upload failed', err instanceof Error ? err.message : 'Unable to upload image.')
        return false
      } finally {
        setVoiceSendPhase('idle')
        setSending(false)
      }
    },
    [
      pool,
      activeView,
      serversEngine,
      blossomServers,
      identityManager,
      sendDirectImageAttachment,
      location.isTeleported,
      replyingTo,
      settings.powEnabled,
      settings.powTargetBits,
      settings.broadcastClientTag,
      zapsEngine.lightningAddress,
      relaySelection.channelRelays,
      updateChannelMessages,
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
    const newSeedHex = identityManager.rotateEphemeral()
    saveDeviceSeedHex(newSeedHex)
    setIdentityVersion((v) => v + 1)
    pushToast('success', 'Identity rotated', 'Fresh ephemeral keypair generated.')
  }, [identityManager, pushToast])

  const updateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch }
        if (typeof patch.perGeohashIdentity === 'boolean') {
          identityManager.setPerGeohashIdentity(patch.perGeohashIdentity)
          setIdentityVersion((v) => v + 1)
        }
        return next
      })
    },
    [identityManager]
  )

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
      updateSettings({ strictWhitelistMode: enabled })
      pushToast(
        'info',
        enabled ? 'Trusted Peers Only ON' : 'Trusted Peers Only OFF',
        enabled
          ? 'Hiding text and media from untrusted peers.'
          : 'Public text visible; voice memos & media still require trusting the sender.'
      )
    },
    [updateSettings, pushToast]
  )

  const panicWipe = useCallback(() => {
    trustedSetRef.current = new Set()
    blockedSetRef.current = new Set()
    resetAllNotifications()
    resetAllTranscription()
    contentFilterEngine.resetAll()
    translatorEngine.resetAll()
    walletEngine.resetAll()
    zapsEngine.resetAll()
    deviceSyncEngine.resetAll()
    void amailEngine.resetAll()
    resetAllCalls()
    pool.closeAll()
    voiceCacheRef.current?.revokeAll()
    clearProtocolCaches()
    presenceTracker.clear()
    clearPulse()
    clearAllDms()
    resetAllServers()
    resetLocation()
    panicWipeStorage()

    const { deviceSeedHex, nickname } = identityManager.panicReset()
    saveDeviceSeedHex(deviceSeedHex)
    saveNickname(nickname)
    saveSignMode('auto')

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
    setTrustedPubkeys([])
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
      'All local keys, caches, Amail vault, wallet proofs, servers, trusted peers, active calls, and decrypted audio purged. Fresh identity active.'
    )
  }, [
    pool,
    presenceTracker,
    clearPulse,
    clearAllDms,
    resetAllServers,
    resetAllCalls,
    resetAllTranscription,
    resetAllNotifications,
    contentFilterEngine,
    translatorEngine,
    walletEngine,
    zapsEngine,
    deviceSyncEngine,
    amailEngine,
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
          trustedPubkeys,
          strictWhitelistMode: settings.strictWhitelistMode,
          setNickname,
          tuneGeohash,
          tuneTopicChannel,
          openDmThread,
          sendDirectMessage,
          sendPublicContent: (text) => sendPublicContent(text, null),
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
            options.translatedToLang
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
        m.isOwn ||
        ownPubkeys.has(m.pubkey.toLowerCase()) ||
        trustedSet.has(m.pubkey.toLowerCase())
    )
  }, [messages, settings.strictWhitelistMode, ownPubkeys, trustedSet])

  // Watch visible public Radio & Server message event IDs for live NIP-57 (kind: 9735) zap receipts
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
      if (!msg.isSystem && msg.id) {
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
      formatTranscriptExport(format, cell, visibleMessages, activeGeohash),
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
    isTeleported: location.isTeleported,
    location,
    quickCities: QUICK_CITIES,

    messages: visibleMessages,
    peers,
    presence,
    locationNotes,
    unreadDividerId,
    sending,
    replyingTo,
    setReplyingTo,

    pulseRooms,
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
    totalDmUnread,
    openDmThread,
    closeDmThread,
    sendDirectMessage,

    tuneGeohash,
    tuneRadioChannel,
    tuneTopicChannel,
    locateMe,
    sendInput,
    sendReaction,
    postLocationNote,
    refreshLocationNotes,
    clearCurrentTimeline,
    markChannelRead,

    blockedPubkeys,
    isPeerBlocked,
    toggleBlockPeer,
    getPeerByPubkey,
    trustedPubkeys,
    isTrusted,
    isExplicitlyTrusted,
    trustPubkey,
    pendingTrustRequest,
    confirmPendingTrust,
    cancelPendingTrust,
    untrustPubkey,
    clearTrustedPubkeys,
    strictWhitelistMode: settings.strictWhitelistMode,
    setStrictWhitelistMode,
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
    transcription: transcriptionEngine,
    contentFilter: contentFilterEngine,
    translator: translatorEngine,
    wallet: walletEngine,
    zaps: zapsEngine,
    deviceSync: deviceSyncEngine,
    amail: amailEngine,
    notifications: notificationsEngine,

    commands: SLASH_COMMANDS,
    exportTranscript,
    toasts,
    pushToast,
    dismissToast,
  }
}
