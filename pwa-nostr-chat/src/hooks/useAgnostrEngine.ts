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
import { revokeVoicePreviewUrl } from '../lib/voiceRecorder.ts'
import { useCallEngine } from './useCallEngine.ts'
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

  const [pool, setPool] = useState<RelayPool | null>(null)
  const [relays, setRelays] = useState<RelayTelemetry[]>([])

  useEffect(() => {
    const nextPool = new RelayPool()
    setPool(nextPool)
    const unsub = nextPool.onTelemetryChange((snap) => setRelays(snap))
    return () => {
      unsub()
      nextPool.dispose()
    }
  }, [])

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

  // Channel messages, peers, reactions, notes, pins, recents, blocks
  const [messages, setMessages] = useState<GeoMessage[]>(() => loadChannelMessages(activeGeohash))
  const [peers, setPeers] = useState<PeerInfo[]>([])
  const [locationNotes, setLocationNotes] = useState<LocationNote[]>([])
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

  // Whitelist-based receipt & Blossom media servers
  const [trustedPubkeys, setTrustedPubkeys] = useState<TrustedPeerEntry[]>(() => loadTrustedPubkeys())
  const trustedSet = useMemo(() => new Set(trustedPubkeys.map((t) => t.pubkey)), [trustedPubkeys])
  const [pendingTrustRequest, setPendingTrustRequest] = useState<PendingTrustRequest | null>(null)
  const pendingTrustRequestRef = useRef<PendingTrustRequest | null>(null)
  pendingTrustRequestRef.current = pendingTrustRequest
  const [blossomServers, setBlossomServers] = useState<string[]>(() => loadBlossomServers())
  const [voiceSendPhase, setVoiceSendPhase] = useState<VoiceSendPhase>('idle')

  const geoUnreadCountsRef = useRef<Record<string, number>>(geoUnreadCounts)
  geoUnreadCountsRef.current = geoUnreadCounts
  const geoMentionCountsRef = useRef<Record<string, number>>(geoMentionCounts)
  geoMentionCountsRef.current = geoMentionCounts
  const geoSeenIdsRef = useRef<Set<string>>(new Set())

  const incrementGeoUnread = useCallback((rawGh: string, isDirectPing: boolean) => {
    const gh = normalizeRadioChannelKey(rawGh) ?? normalizeGeohash(rawGh)
    if (!gh) return
    setGeoUnreadCounts((prev) => {
      const next = { ...prev, [gh]: (prev[gh] ?? 0) + 1 }
      geoUnreadCountsRef.current = next
      return next
    })
    if (isDirectPing) {
      setGeoMentionCounts((prev) => {
        const next = { ...prev, [gh]: (prev[gh] ?? 0) + 1 }
        geoMentionCountsRef.current = next
        return next
      })
    }
    setPinnedChannels((prev) => {
      if (!prev.some((p) => p.geohash === gh)) return prev
      return prev.map((p) =>
        p.geohash === gh
          ? {
              ...p,
              unreadCount: p.unreadCount + 1,
              mentionCount: p.mentionCount + (isDirectPing ? 1 : 0),
            }
          : p
      )
    })
  }, [])

  const clearGeoUnread = useCallback((rawGh: string) => {
    const gh = normalizeRadioChannelKey(rawGh) ?? normalizeGeohash(rawGh)
    if (!gh) return
    setGeoUnreadCounts((prev) => {
      if (!prev[gh]) return prev
      const next = { ...prev }
      delete next[gh]
      geoUnreadCountsRef.current = next
      return next
    })
    setGeoMentionCounts((prev) => {
      if (!prev[gh]) return prev
      const next = { ...prev }
      delete next[gh]
      geoMentionCountsRef.current = next
      return next
    })
    setPinnedChannels((prev) => {
      const target = prev.find((p) => p.geohash === gh)
      if (!target || (target.unreadCount === 0 && target.mentionCount === 0)) return prev
      return prev.map((p) =>
        p.geohash === gh ? { ...p, unreadCount: 0, mentionCount: 0 } : p
      )
    })
  }, [])

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

  const messagesRef = useRef<GeoMessage[]>(messages)
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

  // Sync security-critical refs in useLayoutEffect so they are always up to date
  // BEFORE any child component's mount/update useEffect (e.g. TrustedImageView) runs!
  useLayoutEffect(() => {
    messagesRef.current = messages
  }, [messages])

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

  const refreshPeers = useCallback(
    (geohash: string) => {
      const base = presenceTracker.getPeers(geohash, ownPubkeysRef.current, blockedSetRef.current)
      setPeers(
        base.map((p) => ({
          ...p,
          isTrusted: p.isSelf || trustedSetRef.current.has(p.pubkey),
        }))
      )
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
    const gh = activeGeohash
    const isTopic = isTopicChannel(gh)
    const topicSlug = getTopicSlug(gh)
    const cached = backfillReplyReferences(
      loadChannelMessages(gh).filter((m) => !blockedSetRef.current.has(m.pubkey.toLowerCase()))
    )
    setMessages(cached)
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
      isHistoryReplay = false
    }, 3000)

    const since = Math.floor(Date.now() / 1000) - 3600
    const subId = isTopic && topicSlug ? `agnostr-topic-${topicSlug}` : `agnostr-geo-${gh}`
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

    const unsub = pool.subscribe(
      subId,
      relaySelection.channelRelays,
      filters,
      {
        onEose: () => {
          isHistoryReplay = false
          window.clearTimeout(eoseFallback)
        },
        onEvent: (ev) => {
          if (seenIds.has(ev.id)) return
          if (!verifyEventCached(ev)) return
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
            if (!parsed) return
            setMessages((prev) => {
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
                return prev
              }
              if (changed) saveChannelMessages(gh, next)
              return changed ? next : prev
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
              setMessages((prev) => {
                let changed = false
                const next = prev.map((m) => {
                  if (m.pubkey.toLowerCase() === pk && !m.isAgnostrClient) {
                    changed = true
                    return { ...m, isAgnostrClient: true }
                  }
                  return m
                })
                if (changed) saveChannelMessages(gh, next)
                return changed ? next : prev
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
            const parsed = isTopic
              ? parseNamedRadioChatEvent(ev, gh, ownPubkeysRef.current, (id) =>
                  messagesRef.current.find((m) => m.id === id)
                )
              : parseGeohashChatEvent(ev, gh, ownPubkeysRef.current, (id) =>
                  messagesRef.current.find((m) => m.id === id)
                )
            if (!parsed) {
              if (!isTopic) {
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

            setMessages((prev) => {
              if (prev.some((m) => m.id === parsed.id)) return prev

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

              const next = [...backfilledPrev, hydrated]
                .sort((a, b) => a.createdAt - b.createdAt)
                .slice(-350)
              saveChannelMessages(gh, next)
              return next
            })

            if (!isHistoryReplay && !parsed.isOwn) {
              refreshTrustedPeerLabel(pk, parsed.nickname)
              const view = activeViewRef.current
              const isViewingThisGeo = view.type === 'channel' && view.geohash === gh
              if (!isViewingThisGeo) {
                setUnreadDividerId((curr) => curr ?? parsed.id)
              }
              if (!strictWhitelistRef.current || trustedSetRef.current.has(pk)) {
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
                      messagesRef.current.some(
                        (m) =>
                          m.id === parsed.replyTo?.id &&
                          (m.isOwn || ownPubkeysRef.current.has(m.pubkey.toLowerCase()))
                      ))
                )
                if (!isViewingThisGeo && !alreadyCountedUnread) {
                  incrementGeoUnread(gh, mentionedMe || repliedToMe)
                }
                notifyGeoMessageRef.current({
                  id: parsed.id,
                  geohash: gh,
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
      window.clearTimeout(eoseFallback)
      unsub()
    }
  }, [
    pool,
    activeGeohash,
    relaySelection.channelRelays,
    presenceTracker,
    refreshPeers,
    identityManager,
    incrementGeoUnread,
    refreshTrustedPeerLabel,
  ])

  // Location dead-drop notes subscription (kind 1 + NIP-40 expiration — geohash channels only)
  useEffect(() => {
    const gh = activeGeohash
    setLocationNotes([])
    if (!pool || isTopicChannel(gh)) return

    let isNoteReplay = true
    const seenNoteIds = new Set<string>()
    const noteEoseFallback = window.setTimeout(() => {
      isNoteReplay = false
    }, 3000)
    const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60
    const unsub = pool.subscribe(
      `agnostr-notes-${gh}-${notesRefreshNonce}`,
      relaySelection.dmRelays,
      [{ kinds: [KIND_LOCATION_NOTE], '#g': [gh], since, limit: 60 }],
      {
        onEose: () => {
          isNoteReplay = false
          window.clearTimeout(noteEoseFallback)
        },
        onEvent: (ev) => {
          if (seenNoteIds.has(ev.id)) return
          if (!verifyEventCached(ev)) return
          seenNoteIds.add(ev.id)
          const notePk = ev.pubkey.toLowerCase()
          if (blockedSetRef.current.has(notePk)) return

          const parsed = parseLocationNoteEvent(ev, gh, ownPubkeysRef.current)
          if (!parsed) return
          setLocationNotes((prev) => {
            if (prev.some((n) => n.id === parsed.id)) return prev
            return [parsed, ...prev].sort((a, b) => b.createdAt - a.createdAt).slice(0, 60)
          })
          if (
            !isNoteReplay &&
            !parsed.isOwn &&
            (!strictWhitelistRef.current || trustedSetRef.current.has(notePk))
          ) {
            notifyLocationNoteRef.current({
              id: parsed.id,
              geohash: gh,
              senderHandle: parsed.displayHandle,
              content: parsed.content,
            })
          }
        },
      }
    )

    return () => {
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

    let backfillDone = false
    const eoseFallback = window.setTimeout(() => {
      backfillDone = true
    }, 2500)

    const unsub = pool.subscribe(
      'agnostr-pinned-watch',
      watchRelays,
      filters,
      {
        onEose: () => {
          backfillDone = true
          window.clearTimeout(eoseFallback)
        },
        onEvent: (ev) => {
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

          incrementGeoUnread(gh, mentionedMe || repliedToMe)

          notifyGeoMessageRef.current({
            id: ev.id,
            geohash: gh,
            senderHandle: formatDisplayHandle(rawNick, pk),
            content: ev.content,
            mentionedMe,
            repliedToMe,
          })
        },
      }
    )

    return () => {
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

  // Global Pulse Radar
  const { pulseRooms, clearPulse } = useGlobalPulse(pool, true)

  // Direct Messages (dual-stack: Bitchat v2 + NIP-17)
  const activeDmPeer = activeView.type === 'dm' ? activeView.peerPubkey : null
  const {
    dmThreads,
    totalDmUnread,
    ensureThread,
    sendDirectMessage,
    sendDirectVoiceMemo,
    sendDirectImageAttachment,
    clearThread,
    closeThread: closeDmThreadRaw,
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

  // Discord-like Servers (Instant Virtual Public/E2EE + NIP-29 Relay Communities)
  const {
    engine: serversEngine,
    activeServerRelays,
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
    strictWhitelistMode: settings.strictWhitelistMode,
    getPeerNickname: getCallPeerNickname,
    pushToast,
  })

  // Keep active geohash + DM + pulse + active server/NIP-29 + call signaling relays synced in RelayPool
  const activeServerRelaysRef = useRef<string[]>(activeServerRelays)
  useEffect(() => {
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
    async (rawText: string, replyOverride?: GeoMessage | null): Promise<boolean> => {
      const content = rawText.trim()
      if (!content || !pool) return false

      const gh = activeGeohash
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
            })
          : buildGeohashChatTemplate({
              content,
              geohash: gh,
              nickname: nick,
              isTeleported: location.isTeleported,
              replyTo: replyTarget,
              broadcastClientTag: settings.broadcastClientTag,
            })

        // Mine 8-bit NIP-13 PoW non-blocking when enabled and pubkey is known
        if (settings.powEnabled && settings.powTargetBits > 0 && activeKey.pubkey) {
          const nonceTag = await mineNip13NonceTag(template, activeKey.pubkey, settings.powTargetBits, 450)
          if (nonceTag) {
            template.tags = [...template.tags, nonceTag]
          }
        }

        const signed = await identityManager.signEvent(template, gh)
        const optimistic = isTopic
          ? parseNamedRadioChatEvent(signed, gh, ownPubkeysRef.current, (id) =>
              messagesRef.current.find((m) => m.id === id)
            )
          : parseGeohashChatEvent(signed, gh, ownPubkeysRef.current, (id) =>
              messagesRef.current.find((m) => m.id === id)
            )
        if (optimistic) {
          optimistic.deliveryStatus = 'sending'
          optimistic.isOwn = true
          setMessages((prev) => {
            if (prev.some((m) => m.id === optimistic.id)) return prev
            const next = [...prev, optimistic].sort((a, b) => a.createdAt - b.createdAt)
            saveChannelMessages(gh, next)
            return next
          })
        }

        setReplyingTo(null)

        const res = await pool.publish(relaySelection.channelRelays, signed)
        const ok = res.acceptedRelays.length > 0

        setMessages((prev) => {
          const next = prev.map((m) =>
            m.id === signed.id
              ? {
                  ...m,
                  deliveryStatus: (ok ? 'sent' : 'failed') as GeoMessage['deliveryStatus'],
                  relayCount: res.acceptedRelays.length,
                }
              : m
          )
          saveChannelMessages(gh, next)
          return next
        })

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
      activeGeohash,
      identityManager,
      replyingTo,
      location.isTeleported,
      settings.powEnabled,
      settings.powTargetBits,
      settings.broadcastClientTag,
      relaySelection.channelRelays,
      pushToast,
    ]
  )

  const sendReaction = useCallback(
    async (message: GeoMessage, emoji: string): Promise<void> => {
      if (!pool || message.isSystem) return
      const cleanEmoji = emoji.trim()
      if (!cleanEmoji) return

      const gh = activeGeohash
      const template = buildReactionTemplate({
        geohash: gh,
        targetEventId: message.id,
        targetPubkey: message.pubkey,
        emoji: cleanEmoji,
      })

      try {
        const signed = await identityManager.signEvent(template, gh)
        const myPk = signed.pubkey.toLowerCase()

        // Optimistic reaction update
        setMessages((prev) => {
          const next = prev.map((m) => {
            if (m.id !== message.id) return m
            const idx = m.reactions.findIndex((r) => r.emoji === cleanEmoji)
            if (idx !== -1) {
              if (m.reactions[idx].pubkeys.includes(myPk)) return m
              const pubkeys = [...m.reactions[idx].pubkeys, myPk]
              const copy = [...m.reactions]
              copy[idx] = { emoji: cleanEmoji, count: pubkeys.length, pubkeys, reactedByMe: true }
              return { ...m, reactions: copy }
            }
            return {
              ...m,
              reactions: [...m.reactions, { emoji: cleanEmoji, count: 1, pubkeys: [myPk], reactedByMe: true }],
            }
          })
          saveChannelMessages(gh, next)
          return next
        })

        const targets = Array.from(new Set([...relaySelection.dmRelays, ...relaySelection.channelRelays]))
        await pool.publish(targets, signed, 3500)
      } catch (err) {
        pushToast('error', 'Reaction failed', err instanceof Error ? err.message : 'Could not sign reaction.')
      }
    },
    [pool, activeGeohash, identityManager, relaySelection.dmRelays, relaySelection.channelRelays, pushToast]
  )

  const postLocationNote = useCallback(
    async (rawContent: string): Promise<boolean> => {
      const content = rawContent.trim()
      if (!content || !pool) return false
      const gh = activeGeohash
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
            setLocationNotes((prev) => [parsed, ...prev.filter((n) => n.id !== parsed.id)])
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
    [pool, activeGeohash, identityManager, relaySelection.dmRelays, pushToast]
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
    setMessages([])
    setUnreadDividerId(null)
    clearChannelMessagesStorage(activeGeohash)
  }, [activeView, activeGeohash, clearThread, serversEngine, pushToast])

  // Moderation
  const isPeerBlocked = useCallback((pubkey: string) => blockedSet.has(pubkey.toLowerCase()), [blockedSet])

  const toggleBlockPeer = useCallback(
    (pubkey: string, label?: string) => {
      const pk = pubkey.toLowerCase()
      setBlockedPubkeys((prev) => {
        const exists = prev.includes(pk)
        const next = exists ? prev.filter((p) => p !== pk) : [...prev, pk]
        saveBlockedPubkeys(next)
        if (!exists) {
          setMessages((msgs) => msgs.filter((m) => m.pubkey.toLowerCase() !== pk))
          // Synchronously revoke trust & cached media for this peer before next render
          if (trustedSetRef.current.has(pk)) {
            const nextTrusted = new Set(trustedSetRef.current)
            nextTrusted.delete(pk)
            trustedSetRef.current = nextTrusted
          }
          voiceCacheRef.current?.revokeForSender(pk)
          setTrustedPubkeys((trustedPrev) => {
            if (!trustedPrev.some((t) => t.pubkey === pk)) return trustedPrev
            const trimmed = trustedPrev.filter((t) => t.pubkey !== pk)
            saveTrustedPubkeys(trimmed)
            return trimmed
          })
          pushToast('info', `Blocked ${label ?? pk.slice(0, 8)}`, 'Their messages are now hidden.')
        } else {
          pushToast('info', `Unblocked ${label ?? pk.slice(0, 8)}`)
        }
        return next
      })
    },
    [pushToast]
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

      const gh = activeGeohash
      const isDm = activeView.type === 'dm'
      const cleanMime = cleanMimeType(recorded.mime)
      const cleanCaption = caption?.trim() ?? ''

      setSending(true)
      try {
        const rawBytes = new Uint8Array(await recorded.blob.arrayBuffer())

        if (isDm) {
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
          const ok = await sendDirectVoiceMemo(activeView.peerPubkey, attachment, cleanCaption)
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
              replyTo: replyingTo,
              voiceMemo: attachment,
              broadcastClientTag: settings.broadcastClientTag,
            })
          : buildGeohashChatTemplate({
              content,
              geohash: gh,
              nickname: identityManager.getNickname(),
              isTeleported: location.isTeleported,
              replyTo: replyingTo,
              voiceMemo: attachment,
              broadcastClientTag: settings.broadcastClientTag,
            })

        if (settings.powEnabled && settings.powTargetBits > 0 && activeKey.pubkey) {
          const nonceTag = await mineNip13NonceTag(template, activeKey.pubkey, settings.powTargetBits, 450)
          if (nonceTag) {
            template.tags = [...template.tags, nonceTag]
          }
        }

        const signed = await identityManager.signEvent(template, gh)
        const optimistic = isTopic
          ? parseNamedRadioChatEvent(signed, gh, ownPubkeysRef.current, (id) =>
              messagesRef.current.find((m) => m.id === id)
            )
          : parseGeohashChatEvent(signed, gh, ownPubkeysRef.current, (id) =>
              messagesRef.current.find((m) => m.id === id)
            )
        if (optimistic) {
          optimistic.deliveryStatus = 'sending'
          optimistic.isOwn = true
          setMessages((prev) => {
            if (prev.some((m) => m.id === optimistic.id)) return prev
            const next = [...prev, optimistic].sort((a, b) => a.createdAt - b.createdAt)
            saveChannelMessages(gh, next)
            return next
          })
        }

        setReplyingTo(null)
        setVoiceSendPhase('publishing')

        const res = await pool.publish(relaySelection.channelRelays, signed)
        const ok = res.acceptedRelays.length > 0

        setMessages((prev) => {
          const next = prev.map((m) =>
            m.id === signed.id
              ? {
                  ...m,
                  deliveryStatus: (ok ? 'sent' : 'failed') as GeoMessage['deliveryStatus'],
                  relayCount: res.acceptedRelays.length,
                }
              : m
          )
          saveChannelMessages(gh, next)
          return next
        })

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
      activeGeohash,
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
      relaySelection.channelRelays,
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

      const gh = activeGeohash
      const isDm = activeView.type === 'dm'
      const cleanMime = cleanMimeType(image.mime, 'image/webp')
      const cleanCaption = caption?.trim() ?? ''

      setSending(true)
      try {
        const rawBytes = new Uint8Array(await image.blob.arrayBuffer())

        if (isDm) {
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
          const ok = await sendDirectImageAttachment(activeView.peerPubkey, attachment, cleanCaption)
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
              replyTo: replyingTo,
              imageAttachment: attachment,
              broadcastClientTag: settings.broadcastClientTag,
            })
          : buildGeohashChatTemplate({
              content,
              geohash: gh,
              nickname: identityManager.getNickname(),
              isTeleported: location.isTeleported,
              replyTo: replyingTo,
              imageAttachment: attachment,
              broadcastClientTag: settings.broadcastClientTag,
            })

        if (settings.powEnabled && settings.powTargetBits > 0 && activeKey.pubkey) {
          const nonceTag = await mineNip13NonceTag(template, activeKey.pubkey, settings.powTargetBits, 450)
          if (nonceTag) {
            template.tags = [...template.tags, nonceTag]
          }
        }

        const signed = await identityManager.signEvent(template, gh)
        const optimistic = isTopic
          ? parseNamedRadioChatEvent(signed, gh, ownPubkeysRef.current, (id) =>
              messagesRef.current.find((m) => m.id === id)
            )
          : parseGeohashChatEvent(signed, gh, ownPubkeysRef.current, (id) =>
              messagesRef.current.find((m) => m.id === id)
            )
        if (optimistic) {
          optimistic.deliveryStatus = 'sending'
          optimistic.isOwn = true
          setMessages((prev) => {
            if (prev.some((m) => m.id === optimistic.id)) return prev
            const next = [...prev, optimistic].sort((a, b) => a.createdAt - b.createdAt)
            saveChannelMessages(gh, next)
            return next
          })
        }

        setReplyingTo(null)
        setVoiceSendPhase('publishing')

        const res = await pool.publish(relaySelection.channelRelays, signed)
        const ok = res.acceptedRelays.length > 0

        setMessages((prev) => {
          const next = prev.map((m) =>
            m.id === signed.id
              ? {
                  ...m,
                  deliveryStatus: (ok ? 'sent' : 'failed') as GeoMessage['deliveryStatus'],
                  relayCount: res.acceptedRelays.length,
                }
              : m
          )
          saveChannelMessages(gh, next)
          return next
        })

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
      activeGeohash,
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
      relaySelection.channelRelays,
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
    resetAllCalls()
    pool?.closeAll()
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
    setMessages([])
    setPeers([])
    setLocationNotes([])
    setReplyingTo(null)
    setUnreadDividerId(null)
    setActiveGeohash(DEFAULT_GEOHASH)
    setActiveView({ type: 'channel', geohash: DEFAULT_GEOHASH })
    setIdentityVersion((v) => v + 1)

    clearToasts()
    pushToast('warning', 'Panic Wipe Complete', 'All local keys, caches, servers, trusted peers, active calls, and decrypted audio purged. Fresh identity active.')
  }, [pool, presenceTracker, clearPulse, clearAllDms, resetAllServers, resetAllCalls, resetAllTranscription, resetAllNotifications, resetLocation, identityManager, clearToasts, pushToast])

  // Unified composer submit (commands, DMs, public messages)
  const addSystemMessage = useCallback(
    (text: string) => {
      const msg = createSystemMessage(activeGeohash, text)
      setMessages((prev) => [...prev, msg])
    },
    [activeGeohash]
  )

  const sendInput = useCallback(
    async (rawText: string): Promise<boolean> => {
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

      if (activeView.type === 'dm') {
        return await sendDirectMessage(activeView.peerPubkey, trimmed)
      }

      if (activeView.type === 'server') {
        return await serversEngine.sendMessage(trimmed)
      }

      return await sendPublicContent(trimmed)
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
    notifications: notificationsEngine,

    commands: SLASH_COMMANDS,
    exportTranscript,
    toasts,
    pushToast,
    dismissToast,
  }
}
