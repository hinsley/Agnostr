import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ActiveView,
  AgnostrEngine,
  AppSettings,
  DmProtocol,
  GeoMessage,
  LocationNote,
  PeerInfo,
  PinnedChannel,
  RelayTelemetry,
  SignMode,
  ThemeId,
} from '../types/protocol.ts'
import {
  buildGeohashChatTemplate,
  buildLocationNoteTemplate,
  buildPresenceTemplate,
  buildReactionTemplate,
  clearProtocolCaches,
  createSystemMessage,
  extractGeohashTag,
  extractMentions,
  getTagValue,
  hasTagPair,
  KIND_EPHEMERAL_REACTION,
  KIND_GEOHASH_CHAT,
  KIND_GEOHASH_PRESENCE,
  KIND_LOCATION_NOTE,
  mineNip13NonceTag,
  parseGeohashChatEvent,
  parseLocationNoteEvent,
  parseReactionEvent,
  verifyEventCached,
  type ParsedReaction,
} from '../lib/bitchatProtocol.ts'
import { executeSlashCommand, SLASH_COMMANDS } from '../lib/commands.ts'
import {
  buildGeohashCell,
  DEFAULT_GEOHASH,
  isValidGeohash,
  normalizeGeohash,
  QUICK_CITIES,
  resolveGeohashOrCity,
} from '../lib/geohash.ts'
import {
  BUNDLED_GEO_RELAYS,
  CORE_DM_RELAYS,
  fetchBitchatGeoRelays,
  mergeGeoDirectories,
  normalizeRelayUrl,
  selectRelaysForGeohash,
  type GeoRelayEntry,
} from '../lib/geoRelays.ts'
import {
  detectNip07,
  generateRandomNickname,
  IdentityManager,
} from '../lib/identity.ts'
import {
  canBroadcastPresenceForGeohash,
  nextPresenceDelayMs,
  PresenceTracker,
} from '../lib/presenceService.ts'
import { RelayPool } from '../lib/relayPool.ts'
import {
  clearChannelMessagesStorage,
  DEFAULT_SETTINGS,
  formatTranscriptExport,
  loadActiveGeohash,
  loadBlockedPubkeys,
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
  panicWipeStorage,
  saveActiveGeohash,
  saveBlockedPubkeys,
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
} from '../lib/storage.ts'
import { useDirectMessages } from './useDirectMessages.ts'
import { useGlobalPulse } from './useGlobalPulse.ts'
import { useLocation } from './useLocation.ts'
import { useToasts } from './useToasts.ts'

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
    const hash = normalizeGeohash(window.location.hash || '')
    if (hash && isValidGeohash(hash)) return hash
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

  // Sync URL hash <-> activeGeohash
  useEffect(() => {
    saveActiveGeohash(activeGeohash)
    try {
      const currentHash = normalizeGeohash(window.location.hash || '')
      if (currentHash !== activeGeohash) {
        window.history.replaceState(null, '', `#${activeGeohash}`)
      }
    } catch {
      // Ignore
    }
  }, [activeGeohash])

  useEffect(() => {
    const onHashChange = () => {
      const hash = normalizeGeohash(window.location.hash || '')
      if (hash && isValidGeohash(hash)) {
        setActiveGeohash(hash)
        setActiveView({ type: 'channel', geohash: hash })
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

  useEffect(() => {
    if (!pool) return
    const keepUrls = new Set<string>([
      ...relaySelection.channelRelays,
      ...relaySelection.dmRelays,
      ...relaySelection.pulseRelays,
    ])
    pool.syncMetadata(relaySelection.allMetadata, keepUrls)
  }, [pool, relaySelection])

  // Channel messages, peers, reactions, notes, pins, recents, blocks
  const [messages, setMessages] = useState<GeoMessage[]>(() => loadChannelMessages(activeGeohash))
  const [peers, setPeers] = useState<PeerInfo[]>([])
  const [locationNotes, setLocationNotes] = useState<LocationNote[]>([])
  const [notesRefreshNonce, setNotesRefreshNonce] = useState(0)
  const [unreadDividerId, setUnreadDividerId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [replyingTo, setReplyingTo] = useState<GeoMessage | null>(null)

  const [pinnedChannels, setPinnedChannels] = useState<PinnedChannel[]>(() => loadPinnedChannels())
  const [recentChannels, setRecentChannels] = useState<string[]>(() => {
    const loaded = loadRecentChannels()
    return loaded.includes(activeGeohash) ? loaded : [activeGeohash, ...loaded].slice(0, 12)
  })
  const [blockedPubkeys, setBlockedPubkeys] = useState<string[]>(() => loadBlockedPubkeys())
  const blockedSet = useMemo(() => new Set(blockedPubkeys), [blockedPubkeys])

  const messagesRef = useRef<GeoMessage[]>(messages)
  const blockedSetRef = useRef<Set<string>>(blockedSet)
  const ownPubkeysRef = useRef<Set<string>>(ownPubkeys)
  const activeViewRef = useRef<ActiveView>(activeView)

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    blockedSetRef.current = blockedSet
  }, [blockedSet])

  useEffect(() => {
    ownPubkeysRef.current = ownPubkeys
  }, [ownPubkeys])

  useEffect(() => {
    activeViewRef.current = activeView
  }, [activeView])

  const refreshPeers = useCallback(
    (geohash: string) => {
      setPeers(presenceTracker.getPeers(geohash, ownPubkeysRef.current, blockedSetRef.current))
    },
    [presenceTracker]
  )

  // Periodic peer online-window refresh (every 15s)
  useEffect(() => {
    refreshPeers(activeGeohash)
    const timer = window.setInterval(() => refreshPeers(activeGeohash), 15_000)
    return () => window.clearInterval(timer)
  }, [activeGeohash, blockedSet, ownPubkeys, refreshPeers])

  // Record self in presence tracker for active geohash
  useEffect(() => {
    presenceTracker.recordActivity({
      geohash: activeGeohash,
      pubkey: identity.activePubkey,
      seenAtSec: Math.floor(Date.now() / 1000),
      nickname: identity.nickname,
      isTeleported: location.isTeleported,
    })
    refreshPeers(activeGeohash)
  }, [activeGeohash, identity.activePubkey, identity.nickname, location.isTeleported, presenceTracker, refreshPeers])

  // Active geohash subscription (kind 20000 chat + kind 20001 presence + kind 20007 reactions)
  useEffect(() => {
    const gh = activeGeohash
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
    const unsub = pool.subscribe(
      `agnostr-geo-${gh}`,
      relaySelection.channelRelays,
      [
        {
          kinds: [KIND_GEOHASH_CHAT, KIND_GEOHASH_PRESENCE, KIND_EPHEMERAL_REACTION],
          '#g': [gh],
          since,
          limit: 250,
        },
      ],
      {
        onEose: () => {
          isHistoryReplay = false
          window.clearTimeout(eoseFallback)
        },
        onEvent: (ev) => {
          if (seenIds.has(ev.id)) return
          if (!verifyEventCached(ev)) return
          seenIds.add(ev.id)

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

          // Geohash presence heartbeat (kind 20001)
          if (ev.kind === KIND_GEOHASH_PRESENCE) {
            const evGh = extractGeohashTag(ev.tags)
            if (evGh !== gh) return
            presenceTracker.recordActivity({
              geohash: gh,
              pubkey: pk,
              seenAtSec: isHistoryReplay ? ev.created_at : Math.floor(Date.now() / 1000),
            })
            refreshPeers(gh)
            return
          }

          // Geohash public message (kind 20000)
          if (ev.kind === KIND_GEOHASH_CHAT) {
            const parsed = parseGeohashChatEvent(ev, gh, ownPubkeysRef.current, (id) =>
              messagesRef.current.find((m) => m.id === id)
            )
            if (!parsed) {
              // Empty teleport ping still updates presence if valid #g
              const evGh = extractGeohashTag(ev.tags)
              if (evGh === gh) {
                presenceTracker.recordActivity({
                  geohash: gh,
                  pubkey: pk,
                  seenAtSec: isHistoryReplay ? ev.created_at : Math.floor(Date.now() / 1000),
                  nickname: getTagValue(ev.tags, 'n'),
                  isTeleported: hasTagPair(ev.tags, 't', 'teleport'),
                })
                refreshPeers(gh)
              }
              return
            }

            presenceTracker.recordActivity({
              geohash: gh,
              pubkey: pk,
              seenAtSec: isHistoryReplay ? parsed.createdAt : Math.floor(Date.now() / 1000),
              nickname: parsed.nickname,
              isTeleported: parsed.isTeleported,
              isMeshBridge: parsed.isMeshBridge,
              isMessage: true,
            })
            refreshPeers(gh)

            setMessages((prev) => {
              if (prev.some((m) => m.id === parsed.id)) return prev

              // Resolve incoming replyTo against latest prev state
              let hydrated: GeoMessage = parsed
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
              const backfilledPrev = prev.map((m) => {
                if (m.replyTo?.id === hydrated.id && (!m.replyTo.preview || !m.replyTo.nickname)) {
                  return {
                    ...m,
                    replyTo: {
                      ...m.replyTo,
                      pubkey: hydrated.pubkey,
                      nickname: hydrated.nickname,
                      preview: hydrated.content.slice(0, 120),
                    },
                  }
                }
                return m
              })

              const next = [...backfilledPrev, hydrated]
                .sort((a, b) => a.createdAt - b.createdAt)
                .slice(-350)
              saveChannelMessages(gh, next)
              return next
            })

            if (!isHistoryReplay && !parsed.isOwn && activeViewRef.current.type === 'dm') {
              setUnreadDividerId((curr) => curr ?? parsed.id)
            }
          }
        },
      }
    )

    return () => {
      window.clearTimeout(eoseFallback)
      unsub()
    }
  }, [pool, activeGeohash, relaySelection.channelRelays, presenceTracker, refreshPeers])

  // Location dead-drop notes subscription (kind 1 + NIP-40 expiration)
  useEffect(() => {
    const gh = activeGeohash
    setLocationNotes([])
    if (!pool) return

    const seenNoteIds = new Set<string>()
    const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60
    const unsub = pool.subscribe(
      `agnostr-notes-${gh}-${notesRefreshNonce}`,
      relaySelection.dmRelays,
      [{ kinds: [KIND_LOCATION_NOTE], '#g': [gh], since, limit: 60 }],
      {
        onEvent: (ev) => {
          if (seenNoteIds.has(ev.id)) return
          if (!verifyEventCached(ev)) return
          seenNoteIds.add(ev.id)
          if (blockedSetRef.current.has(ev.pubkey.toLowerCase())) return

          const parsed = parseLocationNoteEvent(ev, gh, ownPubkeysRef.current)
          if (!parsed) return
          setLocationNotes((prev) => {
            if (prev.some((n) => n.id === parsed.id)) return prev
            return [parsed, ...prev].sort((a, b) => b.createdAt - a.createdAt).slice(0, 60)
          })
        },
      }
    )

    return () => unsub()
  }, [pool, activeGeohash, relaySelection.dmRelays, notesRefreshNonce])

  // Background unread watcher for pinned channels (excluding currently viewed channel)
  const watchedPinnedGeos = useMemo(() => {
    const viewingGh = activeView.type === 'channel' ? activeView.geohash : null
    return pinnedChannels.map((p) => p.geohash).filter((g) => g !== viewingGh)
  }, [pinnedChannels, activeView])

  useEffect(() => {
    if (!pool || watchedPinnedGeos.length === 0) return
    const seen = new Set<string>()
    const since = Math.floor(Date.now() / 1000)

    const unsub = pool.subscribe(
      'agnostr-pinned-watch',
      CORE_DM_RELAYS,
      [{ kinds: [KIND_GEOHASH_CHAT], '#g': watchedPinnedGeos, since }],
      {
        onEvent: (ev) => {
          if (ev.kind !== KIND_GEOHASH_CHAT || seen.has(ev.id)) return
          if (!verifyEventCached(ev)) return
          seen.add(ev.id)
          const pk = ev.pubkey.toLowerCase()
          if (ownPubkeysRef.current.has(pk) || blockedSetRef.current.has(pk)) return
          const gh = extractGeohashTag(ev.tags)
          if (!gh || !(ev.content ?? '').trim()) return

          const mentions = extractMentions(ev.content)
          const myNick = identityManager.getNickname().toLowerCase()
          const mentionedMe = mentions.some((m) => m.toLowerCase().startsWith(myNick))

          setPinnedChannels((prev) =>
            prev.map((p) =>
              p.geohash === gh
                ? {
                    ...p,
                    unreadCount: p.unreadCount + 1,
                    mentionCount: p.mentionCount + (mentionedMe ? 1 : 0),
                  }
                : p
            )
          )
        },
      }
    )

    return () => unsub()
  }, [pool, watchedPinnedGeos, identityManager])

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
        const template = buildPresenceTemplate(activeGeohash)
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
  }, [pool, activeGeohash, settings.presenceEnabled, relaySelection.channelRelays, identityManager, identityVersion])

  // Global Pulse Radar
  const { pulseRooms, clearPulse } = useGlobalPulse(pool, true)

  // Direct Messages (dual-stack: Bitchat v2 + NIP-17)
  const activeDmPeer = activeView.type === 'dm' ? activeView.peerPubkey : null
  const {
    dmThreads,
    totalDmUnread,
    ensureThread,
    sendDirectMessage,
    clearThread,
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
  const markChannelRead = useCallback((geohash?: string) => {
    const target = normalizeGeohash(geohash ?? activeGeohash)
    setUnreadDividerId(null)
    setPinnedChannels((prev) =>
      prev.map((p) => (p.geohash === target ? { ...p, unreadCount: 0, mentionCount: 0 } : p))
    )
  }, [activeGeohash])

  const tuneGeohash = useCallback((geohashOrCity: string): boolean => {
    const resolved = resolveGeohashOrCity(geohashOrCity)
    if (!resolved) {
      pushToast('warning', 'Invalid geohash or city', `"${geohashOrCity}" is not a valid base32 geohash or known city.`)
      return false
    }
    setActiveGeohash(resolved)
    setActiveView({ type: 'channel', geohash: resolved })
    setUnreadDividerId(null)
    setRecentChannels((prev) => {
      const next = [resolved, ...prev.filter((g) => g !== resolved)].slice(0, 12)
      saveRecentChannels(next)
      return next
    })
    setPinnedChannels((prev) =>
      prev.map((p) => (p.geohash === resolved ? { ...p, unreadCount: 0, mentionCount: 0 } : p))
    )
    return true
  }, [pushToast])

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
    (geohash: string) => pinnedChannels.some((p) => p.geohash === normalizeGeohash(geohash)),
    [pinnedChannels]
  )

  const togglePinChannel = useCallback(
    (geohash: string, label?: string) => {
      const gh = normalizeGeohash(geohash)
      if (!isValidGeohash(gh)) return
      setPinnedChannels((prev) => {
        const exists = prev.some((p) => p.geohash === gh)
        const next = exists
          ? prev.filter((p) => p.geohash !== gh)
          : [{ geohash: gh, label, pinnedAt: Date.now(), unreadCount: 0, mentionCount: 0 }, ...prev]
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

  // Publish public geohash message (kind 20000 + optional NIP-13 PoW)
  const sendPublicContent = useCallback(
    async (rawText: string, replyOverride?: GeoMessage | null): Promise<boolean> => {
      const content = rawText.trim()
      if (!content || !pool) return false

      const gh = activeGeohash
      const nick = identityManager.getNickname()
      const activeKey = identityManager.getKeyMaterialForGeohash(gh)
      const replyTarget = replyOverride !== undefined ? replyOverride : replyingTo

      setSending(true)
      try {
        const template = buildGeohashChatTemplate({
          content,
          geohash: gh,
          nickname: nick,
          isTeleported: location.isTeleported,
          replyTo: replyTarget,
        })

        // Mine 8-bit NIP-13 PoW non-blocking when enabled and pubkey is known
        if (settings.powEnabled && settings.powTargetBits > 0 && activeKey.pubkey) {
          const nonceTag = await mineNip13NonceTag(template, activeKey.pubkey, settings.powTargetBits, 450)
          if (nonceTag) {
            template.tags = [...template.tags, nonceTag]
          }
        }

        const signed = await identityManager.signEvent(template, gh)
        const optimistic = parseGeohashChatEvent(signed, gh, ownPubkeysRef.current, (id) =>
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
    setMessages([])
    setUnreadDividerId(null)
    clearChannelMessagesStorage(activeGeohash)
  }, [activeView, activeGeohash, clearThread, pushToast])

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
    (pubkey: string) => presenceTracker.getPeerByPubkey(pubkey, ownPubkeys, blockedSet),
    [presenceTracker, ownPubkeys, blockedSet]
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

  const panicWipe = useCallback(() => {
    pool?.closeAll()
    clearProtocolCaches()
    presenceTracker.clear()
    clearPulse()
    clearAllDms()
    resetLocation()
    panicWipeStorage()

    const { deviceSeedHex, nickname } = identityManager.panicReset()
    saveDeviceSeedHex(deviceSeedHex)
    saveNickname(nickname)
    saveSignMode('auto')

    setSettings(DEFAULT_SETTINGS)
    setPinnedChannels([])
    setRecentChannels([DEFAULT_GEOHASH])
    setBlockedPubkeys([])
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
    pushToast('warning', 'Panic Wipe Complete', 'All local keys, caches, and transcripts purged. Fresh identity active.')
  }, [pool, presenceTracker, clearPulse, clearAllDms, resetLocation, identityManager, clearToasts, pushToast])

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
          setNickname,
          tuneGeohash,
          openDmThread,
          sendDirectMessage,
          sendPublicContent: (text) => sendPublicContent(text, null),
          postLocationNote,
          refreshLocationNotes,
          toggleBlockPeer,
          clearCurrentTimeline,
          setTheme,
          rotateIdentity,
          addSystemMessage,
        })
      }

      if (activeView.type === 'dm') {
        return await sendDirectMessage(activeView.peerPubkey, trimmed)
      }

      return await sendPublicContent(trimmed)
    },
    [
      identityManager,
      activeGeohash,
      peers,
      blockedPubkeys,
      setNickname,
      tuneGeohash,
      openDmThread,
      sendDirectMessage,
      sendPublicContent,
      postLocationNote,
      refreshLocationNotes,
      toggleBlockPeer,
      clearCurrentTimeline,
      setTheme,
      rotateIdentity,
      addSystemMessage,
      activeView,
    ]
  )

  const exportTranscript = useCallback(
    (format: 'markdown' | 'json') => formatTranscriptExport(format, cell, messages),
    [cell, messages]
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

  return {
    activeView,
    activeGeohash,
    cell,
    isTeleported: location.isTeleported,
    location,
    quickCities: QUICK_CITIES,

    messages,
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
    isChannelPinned,
    togglePinChannel,

    dmThreads,
    activeDmThread,
    totalDmUnread,
    openDmThread,
    sendDirectMessage,

    tuneGeohash,
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
    setNickname,
    setSignMode,
    setLocalSecret,
    rotateIdentity,
    updateSettings,
    setTheme,
    panicWipe,

    commands: SLASH_COMMANDS,
    exportTranscript,
    toasts,
    pushToast,
    dismissToast,
  }
}
