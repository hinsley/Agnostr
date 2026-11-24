import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ActiveView,
  AppSettings,
  ImageAttachment,
  PreparedImage,
  RecordedVoiceMemo,
  ToastLevel,
  VoiceMemoAttachment,
  VoiceSendPhase,
} from '../types/protocol.ts'
import type { PushPokePayload } from '../types/notifications.ts'
import type {
  CreateNip29GroupInput,
  CreateVirtualServerInput,
  Nip29GroupMeta,
  Nip29Member,
  ServerChannel,
  ServerInvite,
  ServerMessage,
  ServerRole,
  ServerSummary,
  ServersEngine,
  VirtualServerManifest,
} from '../types/servers.ts'
import {
  cleanMimeType,
  encryptMediaBytesAesGcm,
  encryptVoiceBytesAesGcm,
  uploadBlobToBlossom,
} from '../lib/blossom.ts'
import { revokeImagePreviewUrl } from '../lib/imageProcessor.ts'
import {
  clampTimestamp,
  doesContentMentionUser,
  extractMentions,
  getTagValue,
  KIND_EPHEMERAL_REACTION,
  mineNip13NonceTag,
  verifyEventCached,
} from '../lib/bitchatProtocol.ts'
import { CORE_DM_RELAYS, normalizeRelayUrl } from '../lib/geoRelays.ts'
import { formatBitchatChannelHash } from '../lib/bitchatChannel.ts'
import {
  decodePubkeyInput,
  encodeNpubSafe,
  formatDisplayHandle,
  type IdentityManager,
} from '../lib/identity.ts'
import {
  buildNip29ChatTemplate,
  buildNip29CreateGroupTemplate,
  buildNip29DeleteEventTemplate,
  buildNip29EditMetadataTemplate,
  buildNip29JoinTemplate,
  buildNip29LeaveTemplate,
  buildNip29PutUserTemplate,
  buildNip29ReactionTemplate,
  buildNip29RemoveUserTemplate,
  DEFAULT_NIP29_RELAYS,
  fetchNip11Info,
  generateNip29GroupId,
  KIND_NIP29_CHAT,
  KIND_NIP29_DELETE_EVENT,
  KIND_NIP29_GROUP_ADMINS,
  KIND_NIP29_GROUP_MEMBERS,
  KIND_NIP29_GROUP_META,
  nip29ServerId,
  parseNip29AdminsEvent,
  parseNip29ChatEvent,
  parseNip29GroupMeta,
  parseNip29MembersEvent,
} from '../lib/nip29.ts'
import type { PresenceTracker } from '../lib/presenceService.ts'
import type { RelayPool } from '../lib/relayPool.ts'
import {
  KeyedFifoQueue,
  sortChannelMessagesWithPending,
  swapPendingWithSigned,
} from '../lib/sendQueue.ts'
import {
  clearServerChannelMessagesStorage,
  isEphemeralPendingMessage,
  isStuckMediaPlaceholder,
  loadJoinedServers,
  loadServerChannelMessages,
  saveJoinedServers,
  saveServerChannelMessages,
  scrubBlockedPubkeyFromServerStorage,
} from '../lib/storage.ts'
import {
  buildVirtualChatTemplate,
  buildVirtualManifestTemplate,
  buildVirtualReactionTemplate,
  defaultMonogram,
  encodeServerInvite,
  extractInviteFromHash,
  generateServerId,
  generateServerKeyB64,
  getVirtualChannelTag,
  KIND_VIRTUAL_CHAT,
  KIND_VIRTUAL_MANIFEST,
  manifestDTag,
  parseServerInvite,
  parseVirtualChatEvent,
  parseVirtualManifestEvent,
  SERVER_ACCENT_SWATCHES,
  slugifyChannelName,
} from '../lib/virtualServers.ts'
import { revokeVoicePreviewUrl } from '../lib/voiceRecorder.ts'

interface PendingServerReaction {
  id: string
  targetEventId: string
  pubkey: string
  emoji: string
}

interface ServerUnreadItem {
  id: string
  pubkey: string
  isDirectPing: boolean
}

function makeServerChanKey(serverId: string, channelId: string): string {
  return `${serverId}:${channelId}`
}

function applyReaction(
  msg: ServerMessage,
  reaction: PendingServerReaction,
  ownPubkeys: Set<string>
): ServerMessage {
  const idx = msg.reactions.findIndex((r) => r.emoji === reaction.emoji)
  if (idx !== -1) {
    const rec = msg.reactions[idx]
    if (rec.pubkeys.includes(reaction.pubkey)) return msg
    const pubkeys = [...rec.pubkeys, reaction.pubkey]
    const copy = [...msg.reactions]
    copy[idx] = {
      emoji: reaction.emoji,
      count: pubkeys.length,
      pubkeys,
      reactedByMe: rec.reactedByMe || ownPubkeys.has(reaction.pubkey),
    }
    return { ...msg, reactions: copy }
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

function backfillServerReplies(list: ServerMessage[]): ServerMessage[] {
  const byId = new Map<string, ServerMessage>()
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

export interface UseServersOptions {
  pool: RelayPool | null
  identityManager: IdentityManager
  presenceTracker: PresenceTracker
  activeView: ActiveView
  setActiveView: (view: ActiveView) => void
  activeGeohash: string
  ownPubkeys: Set<string>
  blockedSet: Set<string>
  trustedSet: Set<string>
  settings: AppSettings
  blossomServers: string[]
  setVoiceSendPhase: (phase: VoiceSendPhase) => void
  onSeedMemoTranscript?: (memoKey: string, text: string, modelLabel?: string) => void
  lightningAddress?: string | null
  onIngestEventTags?: (pubkey: string, tags: string[][]) => void
  onNotifyPushPoke?: (payload: PushPokePayload) => void
  sendDirectMessage: (peerPubkey: string, content: string) => Promise<boolean>
  pushToast: (level: ToastLevel, title: string, detail?: string) => void
}

export interface UseServersResult {
  engine: ServersEngine
  activeServerRelays: string[]
  applySyncedJoinedServers: (incomingServers: ServerSummary[]) => void
  mergeSyncedServerMessages: (serverId: string, channelId: string, incoming: ServerMessage[]) => number
  resetAllServers: () => void
}

export function useServers(opts: UseServersOptions): UseServersResult {
  const {
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
    onSeedMemoTranscript,
    lightningAddress,
    onIngestEventTags,
    onNotifyPushPoke,
    sendDirectMessage,
    pushToast,
  } = opts

  const [joinedServers, setJoinedServers] = useState<ServerSummary[]>(() => loadJoinedServers())
  const [serverMessagesState, setServerMessagesState] = useState<{
    key: string
    items: ServerMessage[]
  }>({ key: '', items: [] })
  const [sending, setSending] = useState(false)
  const [creating, setCreating] = useState(false)
  const [replyingTo, setReplyingTo] = useState<ServerMessage | null>(null)
  const [pendingInvite, setPendingInvite] = useState<ServerInvite | null>(() => {
    if (typeof window === 'undefined') return null
    return extractInviteFromHash(window.location.hash || '')
  })

  // NIP-29 Relay Explorer state
  const [exploredRelayUrl, setExploredRelayUrl] = useState<string>(DEFAULT_NIP29_RELAYS[0].url)
  const [exploredGroups, setExploredGroups] = useState<Nip29GroupMeta[]>([])
  const [exploringRelay, setExploringRelay] = useState(false)
  const [exploreError, setExploreError] = useState<string | null>(null)
  const exploreUnsubRef = useRef<(() => void) | null>(null)

  const activeServer = useMemo(() => {
    if (activeView.type !== 'server') return null
    return joinedServers.find((s) => s.id === activeView.serverId) ?? null
  }, [activeView, joinedServers])

  const activeChannel = useMemo<ServerChannel | null>(() => {
    if (!activeServer || activeView.type !== 'server') return null
    return (
      activeServer.channels.find((c) => c.id === activeView.channelId) ??
      activeServer.channels[0] ??
      null
    )
  }, [activeServer, activeView])

  const activeServerChanKey =
    activeServer && activeChannel ? makeServerChanKey(activeServer.id, activeChannel.id) : ''

  // Synchronously derive current server channel slice on render frame 0 (zero 1-frame stale bleed)
  const rawMessages = useMemo(() => {
    if (!activeServer || !activeChannel || !activeServerChanKey) return []
    if (serverMessagesState.key === activeServerChanKey) {
      return serverMessagesState.items
    }
    const bannedSet = new Set(activeServer.bannedPubkeys.map((p) => p.toLowerCase()))
    return backfillServerReplies(
      loadServerChannelMessages(activeServer.id, activeChannel.id).filter(
        (m) =>
          m.isSystem ||
          (!blockedSet.has(m.pubkey.toLowerCase()) && !bannedSet.has(m.pubkey.toLowerCase()))
      )
    )
  }, [activeServer, activeChannel, activeServerChanKey, serverMessagesState, blockedSet])

  const activeServerChanKeyRef = useRef<string>(activeServerChanKey)
  const rawMessagesRef = useRef<ServerMessage[]>(rawMessages)
  const rawMessagesKeyRef = useRef<string>(activeServerChanKey)
  const serverSubGenRef = useRef<number>(0)
  const serverSubSeqRef = useRef<number>(0)
  const joinedServersRef = useRef<ServerSummary[]>(joinedServers)
  const ownPubkeysRef = useRef<Set<string>>(ownPubkeys)
  const blockedSetRef = useRef<Set<string>>(blockedSet)
  const trustedSetRef = useRef<Set<string>>(trustedSet)
  const strictWhitelistRef = useRef<boolean>(settings.strictWhitelistMode)
  const activeViewRef = useRef<ActiveView>(activeView)
  const lightningAddressRef = useRef<string | null>(lightningAddress ?? null)
  const onIngestEventTagsRef = useRef(onIngestEventTags)
  const onNotifyPushPokeRef = useRef(onNotifyPushPoke)
  const membersRef = useRef<{ serverId: string; members: Nip29Member[] }>({
    serverId: '',
    members: [],
  })
  const bgSeenIdsRef = useRef<Set<string>>(new Set())
  const serverUnreadItemsRef = useRef<Map<string, ServerUnreadItem[]>>(new Map())
  const serverSendQueueRef = useRef<KeyedFifoQueue>(new KeyedFifoQueue())
  const inFlightSendCountRef = useRef<number>(0)
  const optimisticSeqRef = useRef<number>(0)
  const replyingToRef = useRef<ServerMessage | null>(replyingTo)

  const adjustInFlightSend = useCallback((delta: number) => {
    inFlightSendCountRef.current = Math.max(0, inFlightSendCountRef.current + delta)
    setSending(inFlightSendCountRef.current > 0)
  }, [])

  useLayoutEffect(() => {
    replyingToRef.current = replyingTo
  }, [replyingTo])

  useLayoutEffect(() => {
    onNotifyPushPokeRef.current = onNotifyPushPoke
  }, [onNotifyPushPoke])

  useLayoutEffect(() => {
    activeServerChanKeyRef.current = activeServerChanKey
    rawMessagesRef.current = rawMessages
    rawMessagesKeyRef.current = activeServerChanKey
  }, [activeServerChanKey, rawMessages])

  useEffect(() => {
    joinedServersRef.current = joinedServers
    saveJoinedServers(joinedServers)
  }, [joinedServers])

  useLayoutEffect(() => {
    ownPubkeysRef.current = ownPubkeys
  }, [ownPubkeys])

  const prevBlockedSetRef = useRef<Set<string>>(blockedSet)
  useLayoutEffect(() => {
    blockedSetRef.current = blockedSet
  }, [blockedSet])

  useEffect(() => {
    const prev = prevBlockedSetRef.current
    prevBlockedSetRef.current = blockedSet

    // Scrub newly-blocked pubkeys out of all persisted server buckets immediately
    for (const pk of blockedSet) {
      if (!prev.has(pk)) {
        scrubBlockedPubkeyFromServerStorage(pk)
      }
    }

    // In-memory active server channel: strip newly-blocked messages into zero-content placeholders,
    // and remove placeholders for unblocked pubkeys.
    setServerMessagesState((state) => {
      let changed = false
      const nextItems: ServerMessage[] = []
      for (const m of state.items) {
        if (m.isSystem) {
          nextItems.push(m)
          continue
        }
        const pk = m.pubkey.toLowerCase()
        if (m.isBlockedPlaceholder) {
          if (blockedSet.has(pk)) {
            nextItems.push(m)
          } else {
            changed = true
          }
          continue
        }
        if (blockedSet.has(pk)) {
          changed = true
          nextItems.push({
            id: m.id,
            serverId: m.serverId,
            channelId: m.channelId,
            pubkey: pk,
            nickname: m.nickname,
            displayHandle: m.displayHandle,
            content: '',
            createdAt: m.createdAt,
            tags: [],
            isOwn: false,
            isBlockedPlaceholder: true,
            encrypted: m.encrypted,
            powBits: 0,
            reactions: [],
            mentions: [],
          })
          continue
        }
        nextItems.push(m)
      }
      return changed ? { ...state, items: nextItems } : state
    })
  }, [blockedSet])

  useLayoutEffect(() => {
    trustedSetRef.current = trustedSet
  }, [trustedSet])

  useLayoutEffect(() => {
    strictWhitelistRef.current = settings.strictWhitelistMode
  }, [settings.strictWhitelistMode])

  useLayoutEffect(() => {
    activeViewRef.current = activeView
  }, [activeView])

  useLayoutEffect(() => {
    lightningAddressRef.current = lightningAddress ?? null
  }, [lightningAddress])

  useLayoutEffect(() => {
    onIngestEventTagsRef.current = onIngestEventTags
  }, [onIngestEventTags])

  /**
   * Channel-safe state + storage mutator for servers:
   * - Never mixes messages from another server/channel into live state or localStorage.
   * - If the user switched away while an async send/upload/reaction/delete was in flight
   *   and `allowBackgroundPersist` is true, updates ONLY the origin channel's storage bucket.
   */
  const updateServerChannelMessages = useCallback(
    (
      serverId: string,
      chanId: string,
      updater: (prevItems: ServerMessage[]) => ServerMessage[] | null,
      opts?: { persist?: boolean; allowBackgroundPersist?: boolean }
    ) => {
      const targetKey = makeServerChanKey(serverId, chanId)
      const shouldPersist = opts?.persist !== false
      const allowBg = opts?.allowBackgroundPersist === true
      const keepForTarget = (list: ServerMessage[]): ServerMessage[] =>
        list.filter((m) => m.isSystem || (m.serverId === serverId && m.channelId === chanId))

      if (activeServerChanKeyRef.current !== targetKey) {
        if (allowBg && shouldPersist) {
          const cached = loadServerChannelMessages(serverId, chanId)
          const updated = updater(cached)
          if (updated && updated !== cached) {
            saveServerChannelMessages(serverId, chanId, keepForTarget(updated))
          }
        }
        return
      }

      setServerMessagesState((prev) => {
        if (activeServerChanKeyRef.current !== targetKey) {
          if (allowBg && shouldPersist) {
            const cached = loadServerChannelMessages(serverId, chanId)
            const updated = updater(cached)
            if (updated && updated !== cached) {
              saveServerChannelMessages(serverId, chanId, keepForTarget(updated))
            }
          }
          return prev
        }

        const baseItems =
          prev.key === targetKey
            ? prev.items
            : backfillServerReplies(
                loadServerChannelMessages(serverId, chanId).filter(
                  (m) => m.isSystem || !blockedSetRef.current.has(m.pubkey.toLowerCase())
                )
              )
        const updated = updater(baseItems)
        if (!updated || updated === baseItems) {
          return prev.key === targetKey ? prev : { key: targetKey, items: baseItems }
        }
        const safeItems = keepForTarget(updated)
        if (shouldPersist) {
          saveServerChannelMessages(serverId, chanId, safeItems)
        }
        return { key: targetKey, items: safeItems }
      })
    },
    []
  )

  const recomputeServerUnreads = useCallback(() => {
    const blocked = blockedSetRef.current
    const trusted = trustedSetRef.current
    const own = ownPubkeysRef.current
    const strict = strictWhitelistRef.current

    // Scrub permanently blocked senders from unread ledger
    for (const [key, items] of Array.from(serverUnreadItemsRef.current.entries())) {
      const unblocked = items.filter((item) => !blocked.has(item.pubkey))
      if (unblocked.length === 0) {
        serverUnreadItemsRef.current.delete(key)
      } else if (unblocked.length !== items.length) {
        serverUnreadItemsRef.current.set(key, unblocked)
      }
    }

    setJoinedServers((prev) => {
      let anyChanged = false
      const next = prev.map((s) => {
        const banned = new Set(s.bannedPubkeys.map((p) => p.toLowerCase()))
        let serverChanged = false
        const nextChannels = s.channels.map((c) => {
          const key = makeServerChanKey(s.id, c.id)
          const rawItems = serverUnreadItemsRef.current.get(key)
          let unread = 0
          let mentions = 0
          if (rawItems && rawItems.length > 0) {
            const cleaned = rawItems.filter((item) => !banned.has(item.pubkey))
            if (cleaned.length !== rawItems.length) {
              if (cleaned.length === 0) serverUnreadItemsRef.current.delete(key)
              else serverUnreadItemsRef.current.set(key, cleaned)
            }
            for (const item of cleaned) {
              if (blocked.has(item.pubkey)) continue
              if (strict && !own.has(item.pubkey) && !trusted.has(item.pubkey)) continue
              unread += 1
              if (item.isDirectPing) mentions += 1
            }
          }
          if ((c.unreadCount ?? 0) === unread && (c.mentionCount ?? 0) === mentions) {
            return c
          }
          serverChanged = true
          return { ...c, unreadCount: unread, mentionCount: mentions }
        })

        const totalUnread = nextChannels.reduce((acc, c) => acc + (c.unreadCount ?? 0), 0)
        const totalMentions = nextChannels.reduce((acc, c) => acc + (c.mentionCount ?? 0), 0)
        if (!serverChanged && s.unreadCount === totalUnread && s.mentionCount === totalMentions) {
          return s
        }
        anyChanged = true
        return {
          ...s,
          channels: nextChannels,
          unreadCount: totalUnread,
          mentionCount: totalMentions,
        }
      })
      return anyChanged ? next : prev
    })
  }, [])

  const incrementServerChannelUnread = useCallback(
    (
      serverId: string,
      channelId: string,
      isDirectPing: boolean,
      meta?: { id: string; pubkey: string }
    ) => {
      const pk = meta?.pubkey.toLowerCase() ?? ''
      if (pk) {
        if (blockedSetRef.current.has(pk) || ownPubkeysRef.current.has(pk)) return
        if (strictWhitelistRef.current && !trustedSetRef.current.has(pk)) return
        const srv = joinedServersRef.current.find((s) => s.id === serverId)
        if (srv?.bannedPubkeys.some((b) => b.toLowerCase() === pk)) return
      }

      const key = makeServerChanKey(serverId, channelId)
      const itemId = meta?.id ?? `srv-unread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const list = serverUnreadItemsRef.current.get(key) ?? []
      if (list.some((item) => item.id === itemId)) return
      list.push({ id: itemId, pubkey: pk, isDirectPing })
      if (list.length > 400) {
        list.splice(0, list.length - 400)
      }
      serverUnreadItemsRef.current.set(key, list)
      recomputeServerUnreads()
    },
    [recomputeServerUnreads]
  )

  const clearServerChannelUnread = useCallback(
    (serverId: string, channelId: string) => {
      serverUnreadItemsRef.current.delete(makeServerChanKey(serverId, channelId))
      recomputeServerUnreads()
    },
    [recomputeServerUnreads]
  )

  // Immediately recompute server & channel unread/mention counts when mute/block or whitelist changes
  useEffect(() => {
    recomputeServerUnreads()
  }, [blockedSet, trustedSet, ownPubkeys, settings.strictWhitelistMode, recomputeServerUnreads])

  // Watch window.location.hash for `#invite=...` deep links (never silently auto-join!)
  useEffect(() => {
    const onHash = () => {
      const invite = extractInviteFromHash(window.location.hash || '')
      if (invite) setPendingInvite(invite)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const clearPendingInvite = useCallback(() => {
    setPendingInvite(null)
    try {
      if ((window.location.hash || '').toLowerCase().startsWith('#invite=')) {
        window.history.replaceState(window.history.state, '', formatBitchatChannelHash(activeGeohash))
      }
    } catch {
      // Ignore
    }
  }, [activeGeohash])

  const activeServerRelays = useMemo(() => {
    const set = new Set<string>()
    if (activeServer) {
      for (const u of activeServer.relays) set.add(u)
      if (activeServer.relayUrl) set.add(activeServer.relayUrl)
    }
    for (const s of joinedServers) {
      for (const u of s.relays) set.add(u)
      if (s.relayUrl) set.add(s.relayUrl)
    }
    if (exploringRelay && exploredRelayUrl) {
      set.add(exploredRelayUrl)
    }
    return Array.from(set).slice(0, 14)
  }, [activeServer, joinedServers, exploringRelay, exploredRelayUrl])

  // Live metadata sync for active server (Virtual kind 30078 OR NIP-29 kinds 39000/39001/39002)
  const activeServerKey = activeServer
    ? `${activeServer.id}|${activeServer.kind}|${activeServer.relayUrl ?? ''}|${activeServer.groupId ?? ''}|${activeServer.founderPubkey}`
    : ''

  useEffect(() => {
    if (!pool || !activeServer) return
    let cancelled = false

    if (activeServer.kind === 'virtual') {
      const targetRelays = activeServer.relays.length > 0 ? activeServer.relays : [...CORE_DM_RELAYS]
      const filter = activeServer.founderPubkey
        ? { kinds: [KIND_VIRTUAL_MANIFEST], authors: [activeServer.founderPubkey], '#d': [manifestDTag(activeServer.id)], limit: 5 }
        : { kinds: [KIND_VIRTUAL_MANIFEST], '#d': [manifestDTag(activeServer.id)], limit: 5 }

      const unsub = pool.subscribe(
        `agnostr-srv-meta-${++serverSubSeqRef.current}`,
        targetRelays,
        [filter],
        {
          onEvent: (ev) => {
            if (cancelled) return
            if (!verifyEventCached(ev)) return
            if (cancelled) return
            const manifest = parseVirtualManifestEvent(
              ev,
              activeServer.id,
              activeServer.founderPubkey || undefined
            )
            if (!manifest) return

            setJoinedServers((prev) =>
              prev.map((s) => {
                if (s.id !== activeServer.id) return s
                if (manifest.rev < s.rev) return s
                const existingById = new Map(s.channels.map((c) => [c.id, c]))
                const mergedChannels = manifest.channels.map((c) => {
                  const prevChan = existingById.get(c.id)
                  return {
                    ...c,
                    unreadCount: prevChan?.unreadCount ?? 0,
                    mentionCount: prevChan?.mentionCount ?? 0,
                  }
                })
                return {
                  ...s,
                  name: manifest.name,
                  description: manifest.description,
                  icon: manifest.icon,
                  accentColor: manifest.accentColor,
                  founderPubkey: manifest.founderPubkey,
                  channels: mergedChannels,
                  moderators: manifest.moderators,
                  bannedPubkeys: manifest.bannedPubkeys,
                  relays: manifest.relays,
                  rev: manifest.rev,
                  unreadCount: mergedChannels.reduce((acc, c) => acc + (c.unreadCount ?? 0), 0),
                  mentionCount: mergedChannels.reduce((acc, c) => acc + (c.mentionCount ?? 0), 0),
                }
              })
            )
          },
        }
      )
      return () => {
        cancelled = true
        unsub()
      }
    }

    if (activeServer.kind === 'nip29' && activeServer.relayUrl && activeServer.groupId) {
      const relayUrl = activeServer.relayUrl
      const groupId = activeServer.groupId
      const serverId = activeServer.id

      const unsub = pool.subscribe(
        `agnostr-nip29-state-${++serverSubSeqRef.current}`,
        [relayUrl],
        [
          {
            kinds: [KIND_NIP29_GROUP_META, KIND_NIP29_GROUP_ADMINS, KIND_NIP29_GROUP_MEMBERS],
            '#d': [groupId],
            limit: 10,
          },
        ],
        {
          onEvent: (ev) => {
            if (cancelled) return
            if (!verifyEventCached(ev)) return
            if (cancelled) return
            if (ev.kind === KIND_NIP29_GROUP_META) {
              const meta = parseNip29GroupMeta(ev, relayUrl)
              if (!meta) return
              setJoinedServers((prev) =>
                prev.map((s) =>
                  s.id === serverId
                    ? {
                        ...s,
                        name: meta.name,
                        description: meta.about,
                        picture: meta.picture,
                        isPrivate: meta.isPrivate,
                        isClosed: meta.isClosed,
                        isRestricted: meta.isRestricted,
                        channels: [
                          {
                            id: groupId,
                            name: meta.name.toLowerCase().replace(/\s+/g, '-').slice(0, 24) || groupId,
                            topic: meta.about,
                            unreadCount: s.channels[0]?.unreadCount ?? s.unreadCount,
                            mentionCount: s.channels[0]?.mentionCount ?? s.mentionCount,
                          },
                        ],
                      }
                    : s
                )
              )
            } else if (ev.kind === KIND_NIP29_GROUP_ADMINS) {
              const admins = parseNip29AdminsEvent(ev)
              setJoinedServers((prev) =>
                prev.map((s) => (s.id === serverId ? { ...s, admins } : s))
              )
            } else if (ev.kind === KIND_NIP29_GROUP_MEMBERS) {
              const membersList = parseNip29MembersEvent(ev)
              setJoinedServers((prev) =>
                prev.map((s) => {
                  if (s.id !== serverId) return s
                  const joined = membersList.some((pk) => ownPubkeysRef.current.has(pk))
                  return {
                    ...s,
                    members: membersList,
                    isJoinedMember: joined || s.isJoinedMember,
                  }
                })
              )
            }
          },
        }
      )
      return () => {
        cancelled = true
        unsub()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, activeServerKey])

  // Live channel messages & reactions subscription for active server + channel
  const activeChannelId = activeChannel?.id ?? ''
  const activeEncKey = activeServer?.encryptionKeyB64 ?? ''
  const activeBannedKey = (activeServer?.bannedPubkeys ?? []).join(',')

  useEffect(() => {
    let cancelled = false
    const myGen = ++serverSubGenRef.current

    if (!activeServer || !activeChannelId) {
      setServerMessagesState({ key: '', items: [] })
      setReplyingTo(null)
      return
    }

    const serverSnapshot = activeServer
    const chanId = activeChannelId
    const targetKey = makeServerChanKey(serverSnapshot.id, chanId)
    const bannedSet = new Set(serverSnapshot.bannedPubkeys.map((p) => p.toLowerCase()))

    const cached = backfillServerReplies(
      loadServerChannelMessages(serverSnapshot.id, chanId).filter(
        (m) =>
          m.isSystem ||
          (!blockedSetRef.current.has(m.pubkey.toLowerCase()) &&
            !bannedSet.has(m.pubkey.toLowerCase()))
      )
    )
    setServerMessagesState((prev) => {
      if (prev.key === targetKey && prev.items.length > 0) {
        const filtered = prev.items.filter((m) => {
          if (m.isSystem) return true
          const pk = m.pubkey.toLowerCase()
          if (bannedSet.has(pk)) return false
          if (m.isBlockedPlaceholder) return blockedSetRef.current.has(pk)
          return !blockedSetRef.current.has(pk)
        })
        return filtered.length === prev.items.length ? prev : { key: targetKey, items: filtered }
      }
      return { key: targetKey, items: cached }
    })
    setReplyingTo(null)

    if (!pool) return

    const seenIds = new Set<string>(cached.map((m) => m.id))
    const pendingReactions = new Map<string, PendingServerReaction[]>()
    const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60

    const isVirtual = serverSnapshot.kind === 'virtual'
    const chanTag = isVirtual ? getVirtualChannelTag(serverSnapshot, chanId) : ''
    const groupId = serverSnapshot.groupId || chanId
    const targetRelays = isVirtual
      ? serverSnapshot.relays.length > 0
        ? serverSnapshot.relays
        : [...CORE_DM_RELAYS]
      : serverSnapshot.relayUrl
        ? [serverSnapshot.relayUrl]
        : []

    if (targetRelays.length === 0) return

    const filters = isVirtual
      ? [
          {
            kinds: [KIND_VIRTUAL_CHAT, KIND_EPHEMERAL_REACTION],
            '#t': [chanTag],
            since,
            limit: 250,
          },
        ]
      : [
          {
            kinds: [KIND_NIP29_CHAT, KIND_EPHEMERAL_REACTION, KIND_NIP29_DELETE_EVENT],
            '#h': [groupId],
            since,
            limit: 250,
          },
        ]

    const wipeGen = identityManager.getWipeGeneration()
    const subId = `agnostr-srv-chat-${++serverSubSeqRef.current}`
    const subStartSec = Math.floor(Date.now() / 1000)
    let backfillDone = false
    const eoseFallback = window.setTimeout(() => {
      if (cancelled) return
      backfillDone = true
    }, 2500)

    const isStale = () =>
      cancelled ||
      serverSubGenRef.current !== myGen ||
      activeServerChanKeyRef.current !== targetKey

    const matchesChannelTag = (tags: string[][]): boolean =>
      isVirtual
        ? tags.some((t) => t[0] === 't' && t[1] === chanTag)
        : getTagValue(tags, 'h') === groupId

    const unsub = pool.subscribe(subId, targetRelays, filters, {
      onEose: () => {
        if (isStale()) return
        backfillDone = true
        window.clearTimeout(eoseFallback)
      },
      onEvent: (ev) => {
        if (isStale()) return
        if (seenIds.has(ev.id)) return
        if (!verifyEventCached(ev)) return
        if (isStale()) return
        seenIds.add(ev.id)
        const alreadyCountedUnread = bgSeenIdsRef.current.has(ev.id)
        bgSeenIdsRef.current.add(ev.id)
        if (bgSeenIdsRef.current.size > 1200) {
          const first = bgSeenIdsRef.current.values().next().value
          if (first) bgSeenIdsRef.current.delete(first)
        }
        const isHistoryReplay = !backfillDone || ev.created_at < subStartSec - 2

        const pk = ev.pubkey.toLowerCase()

        // Relay-enforced NIP-29 deletion event (kind 9005 ONLY) — verify group tag ownership
        if (!isVirtual && ev.kind === KIND_NIP29_DELETE_EVENT) {
          if (!matchesChannelTag(ev.tags)) return
          const targetId = getTagValue(ev.tags, 'e')
          if (!targetId) return
          const isMod =
            pk === serverSnapshot.founderPubkey ||
            serverSnapshot.moderators.includes(pk) ||
            Boolean(serverSnapshot.admins?.some((a) => a.pubkey === pk))
          updateServerChannelMessages(serverSnapshot.id, chanId, (prev) => {
            const target = prev.find((m) => m.id === targetId)
            if (!target) return null
            if (target.pubkey !== pk && !isMod) return null
            return prev.filter((m) => m.id !== targetId)
          })
          return
        }

        if (bannedSet.has(pk)) return

        // Blocked sender: discard content (never decrypt!), never store, never notify —
        // append minimal in-memory-only placeholder for chat messages only.
        if (blockedSetRef.current.has(pk)) {
          if (ev.kind === KIND_VIRTUAL_CHAT && !ownPubkeysRef.current.has(pk)) {
            if (!matchesChannelTag(ev.tags)) return
            const rawNick = getTagValue(ev.tags, 'n') || presenceTracker.getNickname(pk) || ''
            const cleanNick = rawNick.trim().slice(0, 32) || `anon${pk.slice(-4)}`
            const placeholder: ServerMessage = {
              id: ev.id,
              serverId: serverSnapshot.id,
              channelId: chanId,
              pubkey: pk,
              nickname: cleanNick,
              displayHandle: formatDisplayHandle(cleanNick, pk),
              content: '',
              createdAt: ev.created_at,
              tags: [],
              isOwn: false,
              isBlockedPlaceholder: true,
              encrypted: Boolean(serverSnapshot.encrypted),
              powBits: 0,
              reactions: [],
              mentions: [],
            }
            updateServerChannelMessages(
              serverSnapshot.id,
              chanId,
              (prev) => {
                if (prev.some((m) => m.id === placeholder.id)) return null
                return sortChannelMessagesWithPending([...prev, placeholder], 'pending-srv-').slice(
                  -350
                )
              },
              { persist: false }
            )
          }
          return
        }

        // Ephemeral reaction (kind 20007) — verify channel tag ownership
        if (ev.kind === KIND_EPHEMERAL_REACTION) {
          if (!matchesChannelTag(ev.tags)) return
          const targetEventId = getTagValue(ev.tags, 'e')
          const emoji = (ev.content ?? '').trim()
          if (!targetEventId || !emoji || emoji.length > 16) return
          const parsedReaction: PendingServerReaction = { id: ev.id, targetEventId, pubkey: pk, emoji }
          updateServerChannelMessages(serverSnapshot.id, chanId, (prev) => {
            let found = false
            let changed = false
            const next = prev.map((m) => {
              if (m.id !== targetEventId) return m
              found = true
              const updated = applyReaction(m, parsedReaction, ownPubkeysRef.current)
              if (updated !== m) changed = true
              return updated
            })
            if (!found) {
              const queue = pendingReactions.get(targetEventId) ?? []
              if (!queue.some((q) => q.id === ev.id)) {
                queue.push(parsedReaction)
                pendingReactions.set(targetEventId, queue)
              }
              return null
            }
            return changed ? next : null
          })
          return
        }

        // Chat message (kind 9)
        if (ev.kind === KIND_VIRTUAL_CHAT) {
          if (!matchesChannelTag(ev.tags)) return
          const ingest = (parsed: ServerMessage | null) => {
            if (!parsed || isStale()) return
            if (identityManager.getWipeGeneration() !== wipeGen) return
            if (parsed.serverId !== serverSnapshot.id || parsed.channelId !== chanId) return
            if (blockedSetRef.current.has(pk) || bannedSet.has(pk)) return
            onIngestEventTagsRef.current?.(pk, ev.tags)

            updateServerChannelMessages(serverSnapshot.id, chanId, (prev) => {
              if (prev.some((m) => m.id === parsed.id)) return null

              let hydrated: ServerMessage = parsed
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

              const queued = pendingReactions.get(hydrated.id)
              if (queued && queued.length > 0) {
                pendingReactions.delete(hydrated.id)
                for (const qr of queued) {
                  hydrated = applyReaction(hydrated, qr, ownPubkeysRef.current)
                }
              }

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

              return sortChannelMessagesWithPending(
                [...backfilledPrev, hydrated],
                'pending-srv-'
              ).slice(-350)
            })

            if (!isHistoryReplay && !alreadyCountedUnread && !parsed.isOwn && !parsed.isSystem) {
              const view = activeViewRef.current
              const isViewingThisChan =
                view.type === 'server' &&
                view.serverId === serverSnapshot.id &&
                view.channelId === chanId
              if (
                !isViewingThisChan &&
                !blockedSetRef.current.has(pk) &&
                (!strictWhitelistRef.current || trustedSetRef.current.has(pk))
              ) {
                const masterPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
                const mentionedMe = doesContentMentionUser(
                  parsed.content,
                  parsed.mentions,
                  identityManager.getNickname(),
                  masterPk
                )
                const repliedToMe = Boolean(
                  parsed.replyTo &&
                    ((parsed.replyTo.pubkey &&
                      ownPubkeysRef.current.has(parsed.replyTo.pubkey.toLowerCase())) ||
                      (rawMessagesKeyRef.current === targetKey &&
                        rawMessagesRef.current.some(
                          (m) =>
                            m.id === parsed.replyTo?.id &&
                            (m.isOwn || ownPubkeysRef.current.has(m.pubkey.toLowerCase()))
                        )))
                )
                incrementServerChannelUnread(
                  serverSnapshot.id,
                  chanId,
                  mentionedMe || repliedToMe,
                  { id: parsed.id, pubkey: pk }
                )
              }
            }
          }

          const findParent = (id: string) =>
            rawMessagesKeyRef.current === targetKey
              ? rawMessagesRef.current.find((m) => m.id === id)
              : undefined

          if (isVirtual) {
            void parseVirtualChatEvent(ev, serverSnapshot, chanId, ownPubkeysRef.current, findParent).then(ingest)
          } else {
            ingest(
              parseNip29ChatEvent(
                ev,
                serverSnapshot.id,
                groupId,
                ownPubkeysRef.current,
                findParent,
                (p) => presenceTracker.getNickname(p)
              )
            )
          }
        }
      },
    })

    return () => {
      cancelled = true
      window.clearTimeout(eoseFallback)
      unsub()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, activeServerKey, activeChannelId, activeEncKey, activeBannedKey, identityManager, presenceTracker, updateServerChannelMessages, incrementServerChannelUnread])

  // Clear active server channel unread & mention badges whenever user focuses that channel
  useEffect(() => {
    if (activeView.type !== 'server') return
    clearServerChannelUnread(activeView.serverId, activeView.channelId)
  }, [activeView, clearServerChannelUnread])

  // Background live post-EOSE unread & direct-ping watcher across ALL joined servers & channels
  const bgWatchKey = useMemo(
    () =>
      joinedServers
        .map((s) => {
          const chans = s.channels.map((c) => c.id).sort().join(',')
          return `${s.id}:${s.kind}:${s.encrypted ? '1' : '0'}:${s.groupId ?? ''}:${s.relayUrl ?? ''}:${chans}`
        })
        .sort()
        .join('|'),
    [joinedServers]
  )

  useEffect(() => {
    if (!pool || !bgWatchKey) return
    const currentServers = joinedServersRef.current
    if (currentServers.length === 0) return

    let cancelled = false
    const unsubs: Array<() => void> = []
    const timers: number[] = []
    const wipeGen = identityManager.getWipeGeneration()
    const since = Math.floor(Date.now() / 1000)

    const handleBackgroundServerMessage = (
      srv: ServerSummary,
      chanId: string,
      parsed: ServerMessage | null
    ) => {
      if (cancelled || !parsed || parsed.isOwn || parsed.isSystem) return
      if (identityManager.getWipeGeneration() !== wipeGen) return

      const pk = parsed.pubkey.toLowerCase()
      if (ownPubkeysRef.current.has(pk) || blockedSetRef.current.has(pk)) return
      if (srv.bannedPubkeys.some((b) => b.toLowerCase() === pk)) return
      if (strictWhitelistRef.current && !trustedSetRef.current.has(pk)) return

      const view = activeViewRef.current
      if (
        view.type === 'server' &&
        view.serverId === srv.id &&
        view.channelId === chanId
      ) {
        return
      }

      const masterPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const mentionedMe = doesContentMentionUser(
        parsed.content,
        parsed.mentions,
        identityManager.getNickname(),
        masterPk
      )
      let repliedToMe = Boolean(
        parsed.replyTo?.pubkey &&
          ownPubkeysRef.current.has(parsed.replyTo.pubkey.toLowerCase())
      )
      if (!repliedToMe && parsed.replyTo?.id) {
        const cachedMsgs = loadServerChannelMessages(srv.id, chanId)
        repliedToMe = cachedMsgs.some(
          (m) =>
            m.id === parsed.replyTo?.id &&
            (m.isOwn || ownPubkeysRef.current.has(m.pubkey.toLowerCase()))
        )
      }

      incrementServerChannelUnread(srv.id, chanId, mentionedMe || repliedToMe, {
        id: parsed.id,
        pubkey: pk,
      })
    }

    // 1. Virtual servers (public + E2EE)
    const tagToTarget = new Map<string, { server: ServerSummary; channelId: string }>()
    const virtualTags: string[] = []
    const virtualRelaySet = new Set<string>()
    for (const srv of currentServers) {
      if (srv.kind !== 'virtual') continue
      const srvRelays = srv.relays.length > 0 ? srv.relays : [...CORE_DM_RELAYS]
      for (const r of srvRelays) virtualRelaySet.add(r)
      for (const ch of srv.channels) {
        const tag = getVirtualChannelTag(srv, ch.id)
        tagToTarget.set(tag, { server: srv, channelId: ch.id })
        virtualTags.push(tag)
      }
    }

    if (virtualTags.length > 0 && virtualRelaySet.size > 0) {
      let virtualBackfillDone = false
      const virtualEoseTimer = window.setTimeout(() => {
        if (cancelled) return
        virtualBackfillDone = true
      }, 2500)
      timers.push(virtualEoseTimer)

      const unsubVirtual = pool.subscribe(
        `agnostr-srv-bg-v-${++serverSubSeqRef.current}`,
        Array.from(virtualRelaySet).slice(0, 8),
        [{ kinds: [KIND_VIRTUAL_CHAT], '#t': virtualTags, since }],
        {
          onEose: () => {
            if (cancelled) return
            virtualBackfillDone = true
            window.clearTimeout(virtualEoseTimer)
          },
          onEvent: (ev) => {
            if (cancelled) return
            if (ev.kind !== KIND_VIRTUAL_CHAT) return
            if (!virtualBackfillDone && ev.created_at < since - 2) return
            if (bgSeenIdsRef.current.has(ev.id)) return
            const pk = ev.pubkey.toLowerCase()
            if (blockedSetRef.current.has(pk) || ownPubkeysRef.current.has(pk)) return
            if (!verifyEventCached(ev)) return
            if (cancelled) return

            let matched: { server: ServerSummary; channelId: string } | null = null
            for (const tag of ev.tags) {
              if (tag[0] === 't' && tag[1]) {
                const found = tagToTarget.get(tag[1])
                if (found) {
                  matched = found
                  break
                }
              }
            }
            if (!matched) return

            // Skip active channel (handled by active subscription above)
            const view = activeViewRef.current
            if (
              view.type === 'server' &&
              view.serverId === matched.server.id &&
              view.channelId === matched.channelId
            ) {
              return
            }

            bgSeenIdsRef.current.add(ev.id)
            if (bgSeenIdsRef.current.size > 1200) {
              const first = bgSeenIdsRef.current.values().next().value
              if (first) bgSeenIdsRef.current.delete(first)
            }

            const latestSrv =
              joinedServersRef.current.find((s) => s.id === matched.server.id) ?? matched.server
            const targetChanId = matched.channelId
            void parseVirtualChatEvent(ev, latestSrv, targetChanId, ownPubkeysRef.current).then(
              (parsed) => handleBackgroundServerMessage(latestSrv, targetChanId, parsed)
            )
          },
        }
      )
      unsubs.push(unsubVirtual)
    }

    // 2. NIP-29 relay-hosted communities (grouped per relayUrl)
    const nip29ByRelay = new Map<string, ServerSummary[]>()
    for (const srv of currentServers) {
      if (srv.kind !== 'nip29' || !srv.relayUrl || !srv.groupId) continue
      const list = nip29ByRelay.get(srv.relayUrl) ?? []
      list.push(srv)
      nip29ByRelay.set(srv.relayUrl, list)
    }

    for (const [relayUrl, srvList] of nip29ByRelay.entries()) {
      const groupToSrv = new Map<string, ServerSummary>()
      const groupIds: string[] = []
      for (const srv of srvList) {
        if (!srv.groupId) continue
        groupToSrv.set(srv.groupId, srv)
        groupIds.push(srv.groupId)
      }
      if (groupIds.length === 0) continue

      let nip29BackfillDone = false
      const nip29EoseTimer = window.setTimeout(() => {
        if (cancelled) return
        nip29BackfillDone = true
      }, 2500)
      timers.push(nip29EoseTimer)

      const unsubNip29 = pool.subscribe(
        `agnostr-srv-bg-n-${++serverSubSeqRef.current}`,
        [relayUrl],
        [{ kinds: [KIND_NIP29_CHAT], '#h': groupIds, since }],
        {
          onEose: () => {
            if (cancelled) return
            nip29BackfillDone = true
            window.clearTimeout(nip29EoseTimer)
          },
          onEvent: (ev) => {
            if (cancelled) return
            if (ev.kind !== KIND_NIP29_CHAT) return
            if (!nip29BackfillDone && ev.created_at < since - 2) return
            if (bgSeenIdsRef.current.has(ev.id)) return
            const pk = ev.pubkey.toLowerCase()
            if (blockedSetRef.current.has(pk) || ownPubkeysRef.current.has(pk)) return
            if (!verifyEventCached(ev)) return
            if (cancelled) return

            const gid = getTagValue(ev.tags, 'h')
            if (!gid) return
            const matchedSrv = groupToSrv.get(gid)
            if (!matchedSrv) return

            const view = activeViewRef.current
            if (
              view.type === 'server' &&
              view.serverId === matchedSrv.id &&
              view.channelId === gid
            ) {
              return
            }

            bgSeenIdsRef.current.add(ev.id)
            if (bgSeenIdsRef.current.size > 1200) {
              const first = bgSeenIdsRef.current.values().next().value
              if (first) bgSeenIdsRef.current.delete(first)
            }

            const latestSrv =
              joinedServersRef.current.find((s) => s.id === matchedSrv.id) ?? matchedSrv
            const parsed = parseNip29ChatEvent(
              ev,
              latestSrv.id,
              gid,
              ownPubkeysRef.current,
              undefined,
              (p) => presenceTracker.getNickname(p)
            )
            handleBackgroundServerMessage(latestSrv, gid, parsed)
          },
        }
      )
      unsubs.push(unsubNip29)
    }

    return () => {
      cancelled = true
      for (const t of timers) window.clearTimeout(t)
      for (const u of unsubs) u()
    }
  }, [pool, bgWatchKey, identityManager, presenceTracker, incrementServerChannelUnread])

  // Apply ban list + blocked list + Trusted Peers Only mode to visible server messages
  const { visibleMessages, hiddenByTrustCount } = useMemo(() => {
    const bannedSet = new Set((activeServer?.bannedPubkeys ?? []).map((p) => p.toLowerCase()))
    const clean = rawMessages.filter((m) => {
      if (m.isSystem) return true
      const pk = m.pubkey.toLowerCase()
      if (bannedSet.has(pk)) return false
      if (m.isBlockedPlaceholder) return blockedSet.has(pk)
      return !blockedSet.has(pk)
    })
    if (!settings.strictWhitelistMode) {
      return { visibleMessages: clean, hiddenByTrustCount: 0 }
    }
    let hidden = 0
    const filtered = clean.filter((m) => {
      if (m.isSystem || m.isBlockedPlaceholder || m.isOwn) return true
      const pk = m.pubkey.toLowerCase()
      if (ownPubkeys.has(pk) || trustedSet.has(pk)) return true
      hidden += 1
      return false
    })
    return {
      visibleMessages: filtered,
      hiddenByTrustCount: hidden,
    }
  }, [rawMessages, activeServer?.bannedPubkeys, blockedSet, settings.strictWhitelistMode, ownPubkeys, trustedSet])

  // Role & member roster computation
  const { myRole, canModerate, members } = useMemo(() => {
    if (!activeServer) {
      return { myRole: 'member' as ServerRole, canModerate: false, members: [] as Nip29Member[] }
    }
    const myPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
    const isFounder = Boolean(activeServer.founderPubkey && activeServer.founderPubkey === myPk)
    const isAdmin = Boolean(activeServer.admins?.some((a) => a.pubkey === myPk))
    const isMod = activeServer.moderators.includes(myPk)

    const role: ServerRole = isFounder ? 'founder' : isAdmin ? 'admin' : isMod ? 'mod' : 'member'
    const modPower = isFounder || isAdmin || isMod

    const memberMap = new Map<string, Nip29Member>()
    const upsert = (pkRaw: string, patch?: Partial<Nip29Member>) => {
      const pk = pkRaw.toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pk)) return
      const existing = memberMap.get(pk)
      const knownNick =
        patch?.nickname ||
        existing?.nickname ||
        presenceTracker.getNickname(pk) ||
        (ownPubkeys.has(pk) ? identityManager.getNickname() : `anon${pk.slice(-4)}`)
      const roles = Array.from(new Set([...(existing?.roles ?? []), ...(patch?.roles ?? [])]))
      memberMap.set(pk, {
        pubkey: pk,
        npub: encodeNpubSafe(pk),
        nickname: knownNick,
        displayHandle: formatDisplayHandle(knownNick, pk),
        roles,
        isAdmin: Boolean(existing?.isAdmin || patch?.isAdmin),
        isFounder: Boolean(existing?.isFounder || patch?.isFounder),
        isBanned: Boolean(existing?.isBanned || patch?.isBanned),
        isSelf: ownPubkeys.has(pk),
        isTrusted: ownPubkeys.has(pk) || trustedSet.has(pk),
      })
    }

    if (activeServer.founderPubkey) {
      upsert(activeServer.founderPubkey, { roles: ['founder'], isFounder: true, isAdmin: true })
    }
    for (const modPk of activeServer.moderators) {
      upsert(modPk, { roles: ['mod'], isAdmin: true })
    }
    for (const admin of activeServer.admins ?? []) {
      upsert(admin.pubkey, { roles: admin.roles, isAdmin: true })
    }
    for (const mPk of activeServer.members ?? []) {
      upsert(mPk, { roles: ['member'] })
    }
    for (const m of rawMessages) {
      if (!m.isSystem && !m.isBlockedPlaceholder) {
        upsert(m.pubkey, { nickname: m.nickname, roles: ['member'] })
      }
    }
    for (const bannedPk of activeServer.bannedPubkeys) {
      upsert(bannedPk, { isBanned: true })
    }
    // Always include self in roster
    upsert(myPk, { nickname: identityManager.getNickname(), roles: [role] })

    const list = Array.from(memberMap.values()).sort((a, b) => {
      if (a.isBanned !== b.isBanned) return a.isBanned ? 1 : -1
      if (a.isFounder !== b.isFounder) return a.isFounder ? -1 : 1
      if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
      return a.nickname.localeCompare(b.nickname)
    })

    return { myRole: role, canModerate: modPower, members: list }
  }, [activeServer, rawMessages, ownPubkeys, trustedSet, identityManager, presenceTracker])

  useLayoutEffect(() => {
    membersRef.current = {
      serverId: activeServer?.id ?? '',
      members,
    }
  }, [activeServer?.id, members])

  // Navigation
  const selectServer = useCallback(
    (serverId: string, channelId?: string) => {
      const target = joinedServersRef.current.find((s) => s.id === serverId)
      if (!target) return

      let nextChan: string
      if (channelId && target.channels.some((c) => c.id === channelId)) {
        nextChan = channelId
      } else if (
        target.lastActiveChannelId &&
        target.channels.some((c) => c.id === target.lastActiveChannelId)
      ) {
        nextChan = target.lastActiveChannelId
      } else if (target.channels.length > 0) {
        // Pick the channel with the highest unread count or latest message activity
        let bestChannelId = target.channels[0].id
        let bestUnread = -1
        let bestMentions = -1
        let bestLatestTs = -1
        for (const ch of target.channels) {
          const unread = ch.unreadCount ?? 0
          const mentions = ch.mentionCount ?? 0
          const msgs = loadServerChannelMessages(serverId, ch.id)
          const latestTs = msgs.length > 0 ? (msgs[msgs.length - 1]?.createdAt ?? 0) : 0
          const isBetter =
            unread > bestUnread ||
            (unread === bestUnread && mentions > bestMentions) ||
            (unread === bestUnread && mentions === bestMentions && latestTs > bestLatestTs)
          if (isBetter) {
            bestChannelId = ch.id
            bestUnread = unread
            bestMentions = mentions
            bestLatestTs = latestTs
          }
        }
        nextChan = bestChannelId
      } else {
        nextChan = target.groupId || 'general'
      }

      activeServerChanKeyRef.current = makeServerChanKey(serverId, nextChan)
      serverUnreadItemsRef.current.delete(makeServerChanKey(serverId, nextChan))

      setJoinedServers((prev) => {
        let shouldPersist = false
        const next = prev.map((s) => {
          if (s.id !== serverId) return s
          if (s.lastActiveChannelId !== nextChan) {
            shouldPersist = true
          }
          const nextChannels = s.channels.map((c) =>
            c.id === nextChan ? { ...c, unreadCount: 0, mentionCount: 0 } : c
          )
          return {
            ...s,
            lastActiveChannelId: nextChan,
            channels: nextChannels,
            unreadCount: nextChannels.reduce((acc, c) => acc + (c.unreadCount ?? 0), 0),
            mentionCount: nextChannels.reduce((acc, c) => acc + (c.mentionCount ?? 0), 0),
          }
        })
        if (shouldPersist) {
          joinedServersRef.current = next
          saveJoinedServers(next)
        }
        return next
      })
      setActiveView({ type: 'server', serverId, channelId: nextChan })
    },
    [setActiveView]
  )

  const selectChannel = useCallback(
    (serverId: string, channelId: string) => {
      selectServer(serverId, channelId)
    },
    [selectServer]
  )

  // NIP-29 Relay Explorer
  const exploreNip29Relay = useCallback(
    async (rawRelayUrl: string): Promise<void> => {
      const url = normalizeRelayUrl(rawRelayUrl)
      if (!url) {
        setExploreError('Enter a valid wss:// NIP-29 relay URL.')
        return
      }
      exploreUnsubRef.current?.()
      exploreUnsubRef.current = null

      setExploredRelayUrl(url)
      setExploredGroups([])
      setExploreError(null)
      setExploringRelay(true)

      if (!pool) {
        setExploringRelay(false)
        setExploreError('Relay pool not initialized.')
        return
      }

      // Non-blocking NIP-11 check (informational; some proxies block HTTP NIP-11 while WS works)
      void fetchNip11Info(url)

      const foundMap = new Map<string, Nip29GroupMeta>()
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        setExploringRelay(false)
        if (foundMap.size === 0) {
          setExploreError('No public NIP-29 groups returned by this relay.')
        }
      }

      const timeout = window.setTimeout(() => {
        exploreUnsubRef.current?.()
        exploreUnsubRef.current = null
        finish()
      }, 6500)

      const unsub = pool.subscribe(
        `agnostr-nip29-explore-${Date.now()}`,
        [url],
        [{ kinds: [KIND_NIP29_GROUP_META], limit: 60 }],
        {
          onEvent: (ev) => {
            if (!verifyEventCached(ev)) return
            const meta = parseNip29GroupMeta(ev, url)
            if (!meta) return
            const prev = foundMap.get(meta.groupId)
            if (!prev || meta.updatedAt >= prev.updatedAt) {
              foundMap.set(meta.groupId, meta)
              setExploredGroups(
                Array.from(foundMap.values()).sort((a, b) => a.name.localeCompare(b.name))
              )
            }
          },
          onEose: () => {
            window.clearTimeout(timeout)
            finish()
          },
        }
      )

      exploreUnsubRef.current = () => {
        window.clearTimeout(timeout)
        unsub()
      }
    },
    [pool]
  )

  useEffect(() => {
    return () => {
      exploreUnsubRef.current?.()
    }
  }, [])

  // Helper to publish updated Virtual Server manifest
  const publishVirtualManifest = useCallback(
    async (server: ServerSummary): Promise<boolean> => {
      if (!pool || server.kind !== 'virtual') return false
      const nowSec = Math.floor(Date.now() / 1000)
      const manifest: VirtualServerManifest = {
        v: 1,
        id: server.id,
        name: server.name,
        description: server.description,
        icon: server.icon,
        accentColor: server.accentColor,
        founderPubkey: server.founderPubkey,
        encrypted: server.encrypted,
        channels: server.channels.map((c) => ({ id: c.id, name: c.name, topic: c.topic })),
        moderators: server.moderators,
        bannedPubkeys: server.bannedPubkeys,
        relays: server.relays.length > 0 ? server.relays : [...CORE_DM_RELAYS],
        rev: server.rev,
        createdAt: Math.floor(server.joinedAt / 1000),
        updatedAt: nowSec,
      }
      const tmpl = buildVirtualManifestTemplate(manifest)
      const signed = await identityManager.signEvent(tmpl)
      const res = await pool.publish(manifest.relays, signed)
      return res.acceptedRelays.length > 0
    },
    [pool, identityManager]
  )

  // Create Instant Virtual Server (Public or E2EE Private)
  const createVirtualServer = useCallback(
    async (input: CreateVirtualServerInput): Promise<ServerSummary | null> => {
      const name = input.name.trim().slice(0, 48)
      if (!name || !pool) {
        pushToast('warning', 'Group name required', 'Enter a name for your new group.')
        return null
      }

      setCreating(true)
      try {
        const masterPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
        const serverId = generateServerId()
        const rawChannels = (input.channels && input.channels.length > 0 ? input.channels : ['general', 'random'])
          .map((c) => slugifyChannelName(c))
          .filter(Boolean)
        const uniqueSlugs = Array.from(new Set(rawChannels.length > 0 ? rawChannels : ['general']))
        const channels: ServerChannel[] = uniqueSlugs.map((slug) => ({ id: slug, name: slug }))

        const server: ServerSummary = {
          id: serverId,
          kind: 'virtual',
          name,
          description: input.description?.trim().slice(0, 200) ?? '',
          icon: input.icon?.trim().slice(0, 4) || defaultMonogram(name),
          accentColor: input.accentColor || SERVER_ACCENT_SWATCHES[0],
          encrypted: Boolean(input.encrypted),
          encryptionKeyB64: input.encrypted ? generateServerKeyB64() : undefined,
          founderPubkey: masterPk,
          relays: [...CORE_DM_RELAYS],
          channels,
          moderators: [],
          bannedPubkeys: [],
          rev: 1,
          joinedAt: Date.now(),
          lastActiveChannelId: channels[0].id,
          unreadCount: 0,
          mentionCount: 0,
        }

        const ok = await publishVirtualManifest(server)
        setJoinedServers((prev) => [server, ...prev.filter((s) => s.id !== server.id)])
        setActiveView({ type: 'server', serverId: server.id, channelId: channels[0].id })

        pushToast(
          ok ? 'success' : 'warning',
          `${server.encrypted ? 'E2EE ' : ''}Group "${server.name}" created`,
          ok
            ? `Manifest published across core relays. Share your invite link to add members.`
            : 'Saved locally; manifest will sync when relays reconnect.'
        )
        return server
      } catch (err) {
        pushToast('error', 'Failed to create group', err instanceof Error ? err.message : 'Signing error')
        return null
      } finally {
        setCreating(false)
      }
    },
    [pool, identityManager, publishVirtualManifest, setActiveView, pushToast]
  )

  // Create real NIP-29 relay-moderated group (kind 9007 -> kind 9002)
  const createNip29Group = useCallback(
    async (input: CreateNip29GroupInput): Promise<ServerSummary | null> => {
      const relayUrl = normalizeRelayUrl(input.relayUrl)
      const name = input.name.trim().slice(0, 48)
      if (!relayUrl || !name || !pool) {
        pushToast('warning', 'Missing fields', 'Enter a valid NIP-29 relay URL and group name.')
        return null
      }

      setCreating(true)
      try {
        const groupId = generateNip29GroupId(name)
        const createTmpl = buildNip29CreateGroupTemplate(groupId)
        const signedCreate = await identityManager.signEvent(createTmpl)
        const createRes = await pool.publish([relayUrl], signedCreate, 6000)

        if (createRes.acceptedRelays.length === 0) {
          const reason = createRes.rejectedRelays[0]?.reason || 'Relay rejected group creation.'
          pushToast('error', 'NIP-29 group creation failed', reason)
          return null
        }

        // Immediately publish metadata (kind 9002)
        const metaTmpl = buildNip29EditMetadataTemplate({
          groupId,
          name,
          about: input.about?.trim() ?? '',
          isPrivate: Boolean(input.isPrivate),
          isClosed: Boolean(input.isClosed),
        })
        const signedMeta = await identityManager.signEvent(metaTmpl)
        await pool.publish([relayUrl], signedMeta, 5000)

        const masterPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
        const serverId = nip29ServerId(relayUrl, groupId)
        const server: ServerSummary = {
          id: serverId,
          kind: 'nip29',
          name,
          description: input.about?.trim() ?? '',
          icon: input.icon?.trim().slice(0, 4) || defaultMonogram(name),
          accentColor: input.accentColor || SERVER_ACCENT_SWATCHES[1],
          encrypted: false,
          founderPubkey: masterPk,
          relayUrl,
          groupId,
          isPrivate: Boolean(input.isPrivate),
          isClosed: Boolean(input.isClosed),
          relays: [relayUrl],
          channels: [{ id: groupId, name: slugifyChannelName(name) || groupId, topic: input.about?.trim() }],
          moderators: [],
          bannedPubkeys: [],
          admins: [{ pubkey: masterPk, roles: ['admin'] }],
          members: [masterPk],
          isJoinedMember: true,
          rev: 1,
          joinedAt: Date.now(),
          lastActiveChannelId: groupId,
          unreadCount: 0,
          mentionCount: 0,
        }

        setJoinedServers((prev) => [server, ...prev.filter((s) => s.id !== server.id)])
        setActiveView({ type: 'server', serverId: server.id, channelId: groupId })
        pushToast('success', `NIP-29 Group "${name}" created`, `Hosted on ${new URL(relayUrl).host}`)
        return server
      } catch (err) {
        pushToast('error', 'NIP-29 creation error', err instanceof Error ? err.message : 'Unable to create group')
        return null
      } finally {
        setCreating(false)
      }
    },
    [pool, identityManager, setActiveView, pushToast]
  )

  // Join NIP-29 Community (kind 9021 + add to joinedServers)
  const joinNip29Group = useCallback(
    async (
      rawRelayUrl: string,
      groupId: string,
      metaHint?: Nip29GroupMeta,
      inviteCode?: string
    ): Promise<ServerSummary | null> => {
      const relayUrl = normalizeRelayUrl(rawRelayUrl)
      if (!relayUrl || !groupId.trim() || !pool) {
        pushToast('warning', 'Invalid NIP-29 target', 'Check relay URL and group ID.')
        return null
      }
      const cleanGid = groupId.trim()
      const serverId = nip29ServerId(relayUrl, cleanGid)
      const existing = joinedServersRef.current.find((s) => s.id === serverId)

      let joinedOk = Boolean(existing?.isJoinedMember)
      try {
        const joinTmpl = buildNip29JoinTemplate(cleanGid, inviteCode)
        const signedJoin = await identityManager.signEvent(joinTmpl)
        const res = await pool.publish([relayUrl], signedJoin, 5000)
        const reason = res.rejectedRelays[0]?.reason ?? ''
        if (res.acceptedRelays.length > 0 || reason.toLowerCase().includes('duplicate') || reason.toLowerCase().includes('already')) {
          joinedOk = true
        } else if (reason) {
          pushToast('info', 'Joined in read mode', `Relay note: ${reason}`)
        }
      } catch {
        // Still allow browsing open groups
      }

      const displayName = metaHint?.name || existing?.name || cleanGid
      const server: ServerSummary = existing
        ? {
            ...existing,
            name: displayName,
            description: metaHint?.about ?? existing.description,
            picture: metaHint?.picture ?? existing.picture,
            isPrivate: metaHint?.isPrivate ?? existing.isPrivate,
            isClosed: metaHint?.isClosed ?? existing.isClosed,
            isJoinedMember: joinedOk,
          }
        : {
            id: serverId,
            kind: 'nip29',
            name: displayName,
            description: metaHint?.about ?? '',
            icon: defaultMonogram(displayName),
            picture: metaHint?.picture,
            accentColor: SERVER_ACCENT_SWATCHES[1],
            encrypted: false,
            founderPubkey: '',
            relayUrl,
            groupId: cleanGid,
            isPrivate: metaHint?.isPrivate,
            isClosed: metaHint?.isClosed,
            isRestricted: metaHint?.isRestricted,
            relays: [relayUrl],
            channels: [{ id: cleanGid, name: slugifyChannelName(displayName) || cleanGid, topic: metaHint?.about }],
            moderators: [],
            bannedPubkeys: [],
            isJoinedMember: joinedOk,
            rev: 1,
            joinedAt: Date.now(),
            lastActiveChannelId: cleanGid,
            unreadCount: 0,
            mentionCount: 0,
          }

      setJoinedServers((prev) => [server, ...prev.filter((s) => s.id !== server.id)])
      setActiveView({ type: 'server', serverId: server.id, channelId: cleanGid })
      if (joinedOk && !existing) {
        pushToast('success', `Joined ${displayName}`, `Connected to ${new URL(relayUrl).host}`)
      }
      return server
    },
    [pool, identityManager, setActiveView, pushToast]
  )

  const parseInviteInput = useCallback((raw: string) => parseServerInvite(raw), [])

  const buildInviteLink = useCallback((serverId: string) => {
    const server = joinedServersRef.current.find((s) => s.id === serverId)
    if (!server) return null
    const myPk = identityManager.getMasterKeyMaterial().pubkey
    return encodeServerInvite(server, myPk)
  }, [identityManager])

  const joinFromInvite = useCallback(
    async (invite: ServerInvite): Promise<ServerSummary | null> => {
      if (invite.kind === 'nip29') {
        if (!invite.relayUrl) {
          pushToast('warning', 'Invalid NIP-29 invite', 'Missing relay URL.')
          return null
        }
        const joined = await joinNip29Group(
          invite.relayUrl,
          invite.id,
          {
            relayUrl: invite.relayUrl,
            groupId: invite.id,
            name: invite.name,
            about: invite.description ?? '',
            isPrivate: false,
            isClosed: false,
            isRestricted: false,
            isHidden: false,
            updatedAt: Math.floor(Date.now() / 1000),
          },
          invite.inviteCode
        )
        clearPendingInvite()
        return joined
      }

      // Virtual Server join
      if (invite.encrypted && !invite.key) {
        pushToast('warning', 'Missing E2EE key', 'This private group invite is missing its encryption key.')
        return null
      }

      const existing = joinedServersRef.current.find((s) => s.id === invite.id)
      const channels: ServerChannel[] =
        invite.channels && invite.channels.length > 0
          ? invite.channels.map((c) => ({ id: slugifyChannelName(c.id || c.name), name: slugifyChannelName(c.name) }))
          : [{ id: 'general', name: 'general' }]

      const server: ServerSummary = existing
        ? {
            ...existing,
            encryptionKeyB64: invite.key ?? existing.encryptionKeyB64,
            relays: invite.relays && invite.relays.length > 0 ? invite.relays : existing.relays,
          }
        : {
            id: invite.id,
            kind: 'virtual',
            name: invite.name,
            description: invite.description ?? '',
            icon: invite.icon || defaultMonogram(invite.name),
            accentColor: invite.accentColor || SERVER_ACCENT_SWATCHES[0],
            encrypted: Boolean(invite.encrypted),
            encryptionKeyB64: invite.key,
            founderPubkey: invite.founderPubkey ?? '',
            relays: invite.relays && invite.relays.length > 0 ? invite.relays : [...CORE_DM_RELAYS],
            channels,
            moderators: [],
            bannedPubkeys: [],
            rev: 0,
            joinedAt: Date.now(),
            lastActiveChannelId: channels[0].id,
            unreadCount: 0,
            mentionCount: 0,
          }

      setJoinedServers((prev) => [server, ...prev.filter((s) => s.id !== server.id)])
      setActiveView({ type: 'server', serverId: server.id, channelId: server.lastActiveChannelId })
      clearPendingInvite()
      pushToast(
        'success',
        `Joined ${server.encrypted ? 'E2EE ' : ''}group "${server.name}"`,
        server.encrypted ? 'End-to-end AES-256-GCM key imported locally.' : 'Syncing group channels & history.'
      )
      return server
    },
    [joinNip29Group, setActiveView, clearPendingInvite, pushToast]
  )

  const sendInviteViaDm = useCallback(
    async (serverId: string, recipientPubkey: string): Promise<boolean> => {
      const server = joinedServersRef.current.find((s) => s.id === serverId)
      const link = buildInviteLink(serverId)
      if (!server || !link) return false
      const msg = `You're invited to join ${server.encrypted ? 'E2EE private ' : ''}group "${server.name}" on Agnostr:\n${link.url}`
      const ok = await sendDirectMessage(recipientPubkey, msg)
      if (ok) {
        pushToast('success', 'Invite sent via Encrypted DM', `Delivered invite for "${server.name}".`)
      }
      return ok
    },
    [buildInviteLink, sendDirectMessage, pushToast]
  )

  const leaveServer = useCallback(
    async (serverId: string): Promise<void> => {
      const target = joinedServersRef.current.find((s) => s.id === serverId)
      if (!target) return

      if (target.kind === 'nip29' && target.relayUrl && target.groupId && pool) {
        try {
          const leaveTmpl = buildNip29LeaveTemplate(target.groupId)
          const signed = await identityManager.signEvent(leaveTmpl)
          await pool.publish([target.relayUrl], signed, 3500)
        } catch {
          // Proceed with local removal
        }
      }

      for (const ch of target.channels) {
        clearServerChannelMessagesStorage(target.id, ch.id)
        serverUnreadItemsRef.current.delete(makeServerChanKey(target.id, ch.id))
      }

      setJoinedServers((prev) => prev.filter((s) => s.id !== serverId))
      if (activeView.type === 'server' && activeView.serverId === serverId) {
        setActiveView({ type: 'channel', geohash: activeGeohash })
      }
      pushToast('info', `Left "${target.name}"`, 'Removed from your groups rail.')
    },
    [pool, identityManager, activeView, setActiveView, activeGeohash, pushToast]
  )

  // Messaging (text + voice + image + reactions + delete)
  // Internal non-enqueuing publish step executed strictly inside `serverSendQueueRef`
  const publishServerMessageDirect = useCallback(
    async (params: {
      server: ServerSummary
      channel: ServerChannel
      tempId?: string
      body: string
      replyTarget: ServerMessage | null
      voiceAttachment?: VoiceMemoAttachment
      imageAttachment?: ImageAttachment
      onPublishedId?: (id: string) => void
      wipeGen: number
      nick: string
      masterPk: string
      powEnabled: boolean
      powTargetBits: number
      lightningAddr: string | null
    }): Promise<boolean> => {
      const {
        server,
        channel,
        tempId,
        body,
        replyTarget,
        voiceAttachment,
        imageAttachment,
        onPublishedId,
        wipeGen,
        nick,
        masterPk,
        powEnabled,
        powTargetBits,
        lightningAddr,
      } = params
      if (!pool) return false
      if (identityManager.getWipeGeneration() !== wipeGen) return false

      const chanId = channel.id
      const targetKey = makeServerChanKey(server.id, chanId)
      const isVirtual = server.kind === 'virtual'
      const targetRelays = isVirtual
        ? server.relays.length > 0
          ? server.relays
          : [...CORE_DM_RELAYS]
        : server.relayUrl
          ? [server.relayUrl]
          : []
      if (targetRelays.length === 0) return false

      let activeMsgId: string | null = tempId ?? null
      try {
        const previousIds =
          rawMessagesKeyRef.current === targetKey
            ? rawMessagesRef.current
                .filter((m) => !m.isSystem && !m.id.startsWith('pending-srv-'))
                .map((m) => m.id)
            : loadServerChannelMessages(server.id, chanId)
                .filter((m) => !m.isSystem && !m.id.startsWith('pending-srv-'))
                .map((m) => m.id)

        const tmpl = isVirtual
          ? await buildVirtualChatTemplate({
              server,
              channelId: chanId,
              content: body,
              nickname: nick,
              replyTo: replyTarget,
              voiceMemo: voiceAttachment,
              imageAttachment,
              lightningAddress: lightningAddr,
            })
          : buildNip29ChatTemplate({
              groupId: server.groupId || chanId,
              content: body,
              nickname: nick,
              previousIds,
              replyTo: replyTarget,
              voiceMemo: voiceAttachment,
              imageAttachment,
              lightningAddress: lightningAddr,
            })

        if (isVirtual && powEnabled && powTargetBits > 0 && masterPk) {
          const nonceTag = await mineNip13NonceTag(tmpl, masterPk, powTargetBits, 450)
          if (nonceTag) tmpl.tags = [...tmpl.tags, nonceTag]
        }

        if (identityManager.getWipeGeneration() !== wipeGen) return false
        const signed = await identityManager.signEvent(tmpl)
        if (identityManager.getWipeGeneration() !== wipeGen) return false

        activeMsgId = signed.id
        onPublishedId?.(signed.id)

        // Atomically promote tempId -> signed.id into confirmed messages BEFORE publishing,
        // keeping any remaining queued pending-srv-* placeholders pinned at the tail.
        const signedPk = signed.pubkey.toLowerCase()
        const signedCreatedAt = clampTimestamp(signed.created_at)
        const signedMsg: ServerMessage = {
          id: signed.id,
          serverId: server.id,
          channelId: chanId,
          pubkey: signedPk,
          nickname: nick,
          displayHandle: formatDisplayHandle(nick, signedPk),
          content: body,
          createdAt: signedCreatedAt,
          tags: signed.tags,
          isOwn: true,
          encrypted: server.encrypted,
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
          mentions: extractMentions(body),
          voiceMemo: voiceAttachment,
          imageAttachment,
          deliveryStatus: 'sending',
        }
        updateServerChannelMessages(
          server.id,
          chanId,
          (prev) => {
            if (tempId) {
              return swapPendingWithSigned(prev, tempId, signedMsg, 'pending-srv-')
            }
            if (prev.some((m) => m.id === signedMsg.id)) return null
            return sortChannelMessagesWithPending(
              [...prev, signedMsg],
              'pending-srv-'
            ).slice(-350)
          },
          { allowBackgroundPersist: true }
        )

        const res = await pool.publish(targetRelays, signed)
        if (identityManager.getWipeGeneration() !== wipeGen) return false
        const ok = res.acceptedRelays.length > 0

        updateServerChannelMessages(
          server.id,
          chanId,
          (prev) => {
            let changed = false
            const next = prev.map((m) => {
              if (m.id !== signed.id) return m
              changed = true
              return {
                ...m,
                deliveryStatus: (ok ? 'sent' : 'failed') as ServerMessage['deliveryStatus'],
                relayCount: res.acceptedRelays.length,
              }
            })
            return changed ? next : null
          },
          { allowBackgroundPersist: true }
        )

        if (ok) {
          const pingPokeSet = new Set<string>()
          const broadcastPokeSet = new Set<string>()
          const isValidRecipient = (raw?: string | null): string | null => {
            if (!raw) return null
            const pk = raw.trim().toLowerCase()
            if (!/^[0-9a-f]{64}$/.test(pk)) return null
            if (pk === masterPk || ownPubkeysRef.current.has(pk)) return null
            return pk
          }

          // 1. Replied-to author pubkey (ping / mention)
          if (replyTarget && !replyTarget.isSystem) {
            const rpk = isValidRecipient(replyTarget.pubkey)
            if (rpk) pingPokeSet.add(rpk)
          }

          // 2. Mentioned group members resolved from roster (ping / mention)
          const roster =
            membersRef.current.serverId === server.id ? membersRef.current.members : []
          const contentMentions = extractMentions(body)
          if (contentMentions.length > 0) {
            for (const member of roster) {
              if (member.isSelf || member.isBanned) continue
              const mpk = isValidRecipient(member.pubkey)
              if (!mpk) continue
              if (doesContentMentionUser(body, contentMentions, member.nickname, mpk)) {
                pingPokeSet.add(mpk)
              }
            }
          }

          // 3. Up to 10 other known non-self, non-banned group members NOT already pinged
          const addBroadcastMember = (raw?: string | null) => {
            if (broadcastPokeSet.size >= 10) return
            const pk = isValidRecipient(raw)
            if (!pk || pingPokeSet.has(pk) || broadcastPokeSet.has(pk)) return
            broadcastPokeSet.add(pk)
          }
          for (const member of roster) {
            if (member.isSelf || member.isBanned) continue
            addBroadcastMember(member.pubkey)
          }
          addBroadcastMember(server.founderPubkey)
          for (const modPk of server.moderators) addBroadcastMember(modPk)
          for (const admin of server.admins ?? []) addBroadcastMember(admin.pubkey)
          for (const mPk of server.members ?? []) addBroadcastMember(mPk)

          if (pingPokeSet.size > 0 || broadcastPokeSet.size > 0) {
            let cleanPreview: string | undefined
            if (!server.encrypted) {
              let stripped = body.trim()
              if (voiceAttachment?.url) {
                stripped = stripped.split(voiceAttachment.url).join('').trim()
              }
              if (imageAttachment?.url) {
                stripped = stripped.split(imageAttachment.url).join('').trim()
              }
              if (stripped) {
                cleanPreview = stripped.slice(0, 110)
              } else if (voiceAttachment) {
                cleanPreview = 'Voice memo'
              } else if (imageAttachment) {
                cleanPreview = 'Photo'
              }
            }
            if (pingPokeSet.size > 0) {
              onNotifyPushPokeRef.current?.({
                recipientPubkeys: Array.from(pingPokeSet),
                category: 'server-message',
                isMention: true,
                eventId: signed.id,
                serverId: server.id,
                channelId: chanId,
                senderName: nick,
                preview: cleanPreview,
              })
            }
            if (broadcastPokeSet.size > 0) {
              onNotifyPushPokeRef.current?.({
                recipientPubkeys: Array.from(broadcastPokeSet),
                category: 'server-message',
                isMention: false,
                eventId: signed.id,
                serverId: server.id,
                channelId: chanId,
                senderName: nick,
                preview: cleanPreview,
              })
            }
          }
        } else {
          const reason =
            res.rejectedRelays[0]?.reason || 'No connected group relay accepted the message.'
          pushToast('error', 'Message failed to send', reason)
        }
        return ok
      } catch (err) {
        if (identityManager.getWipeGeneration() === wipeGen) {
          if (activeMsgId || tempId) {
            updateServerChannelMessages(
              server.id,
              chanId,
              (prev) => {
                let changed = false
                const next = prev.map((m) => {
                  if (
                    (activeMsgId && m.id === activeMsgId) ||
                    (tempId && m.id === tempId)
                  ) {
                    changed = true
                    return {
                      ...m,
                      deliveryStatus: 'failed' as ServerMessage['deliveryStatus'],
                    }
                  }
                  return m
                })
                return changed ? next : null
              },
              { allowBackgroundPersist: true }
            )
          }
          pushToast(
            'error',
            'Failed to send message',
            err instanceof Error ? err.message : 'Signing error'
          )
        }
        return false
      }
    },
    [pool, identityManager, updateServerChannelMessages, pushToast]
  )

  const sendMessage = useCallback(
    async (
      rawText: string,
      options?: { onPublishedId?: (id: string) => void }
    ): Promise<boolean> => {
      const text = rawText.trim()
      const server = activeServer
      const channel = activeChannel
      if (!server || !channel || !pool || !text) return false

      const chanId = channel.id
      const targetKey = makeServerChanKey(server.id, chanId)
      const isVirtual = server.kind === 'virtual'
      const targetRelays = isVirtual
        ? server.relays.length > 0
          ? server.relays
          : [...CORE_DM_RELAYS]
        : server.relayUrl
          ? [server.relayUrl]
          : []
      if (targetRelays.length === 0) return false

      // Synchronously capture channel, reply target, signer metadata & append optimistic message
      // BEFORE awaiting the per-channel FIFO queue so rapid sends appear in exact 1 -> 2 -> 3 order.
      const replyTarget = replyingToRef.current
      replyingToRef.current = null
      if (activeServerChanKeyRef.current === targetKey) {
        setReplyingTo(null)
      }

      const nick = identityManager.getNickname()
      const masterPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const wipeGen = identityManager.getWipeGeneration()
      const powEnabled = settings.powEnabled
      const powTargetBits = settings.powTargetBits
      const lightningAddr = lightningAddressRef.current

      const tempId = `pending-srv-${Date.now()}-${++optimisticSeqRef.current}`
      const nowSec = clampTimestamp(Math.floor(Date.now() / 1000))
      const optimistic: ServerMessage = {
        id: tempId,
        serverId: server.id,
        channelId: chanId,
        pubkey: masterPk,
        nickname: nick,
        displayHandle: formatDisplayHandle(nick, masterPk),
        content: text,
        createdAt: nowSec,
        tags: [],
        isOwn: true,
        encrypted: server.encrypted,
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
        mentions: extractMentions(text),
        deliveryStatus: 'sending',
      }

      options?.onPublishedId?.(tempId)
      updateServerChannelMessages(
        server.id,
        chanId,
        (prev) => {
          const lastSec = prev.length > 0 ? prev[prev.length - 1].createdAt : 0
          const placed: ServerMessage = {
            ...optimistic,
            createdAt: Math.max(nowSec, lastSec),
          }
          return [...prev, placed]
        },
        { allowBackgroundPersist: true }
      )

      adjustInFlightSend(1)
      try {
        return await serverSendQueueRef.current.enqueue(
          `srv:${server.id}:${chanId}`,
          () =>
            publishServerMessageDirect({
              server,
              channel,
              tempId,
              body: text,
              replyTarget,
              onPublishedId: options?.onPublishedId,
              wipeGen,
              nick,
              masterPk,
              powEnabled,
              powTargetBits,
              lightningAddr,
            }),
          () => false
        )
      } finally {
        adjustInFlightSend(-1)
      }
    },
    [
      activeServer,
      activeChannel,
      pool,
      identityManager,
      settings.powEnabled,
      settings.powTargetBits,
      updateServerChannelMessages,
      adjustInFlightSend,
      publishServerMessageDirect,
    ]
  )

  const sendVoiceMemo = useCallback(
    async (recorded: RecordedVoiceMemo, caption?: string): Promise<boolean> => {
      if (!activeServer || !activeChannel || !pool) return false
      if (recorded.size <= 0) return false

      const server = activeServer
      const channel = activeChannel
      const chanId = channel.id
      const targetKey = makeServerChanKey(server.id, chanId)
      const replyTarget = replyingToRef.current
      replyingToRef.current = null
      if (activeServerChanKeyRef.current === targetKey) {
        setReplyingTo(null)
      }

      const cleanMime = cleanMimeType(recorded.mime)
      const cleanCaption = caption?.trim() ?? ''
      const nick = identityManager.getNickname()
      const masterPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const wipeGen = identityManager.getWipeGeneration()
      const powEnabled = settings.powEnabled
      const powTargetBits = settings.powTargetBits
      const lightningAddr = lightningAddressRef.current
      const uploadServers = [...blossomServers]

      adjustInFlightSend(1)
      try {
        return await serverSendQueueRef.current.enqueue(
          `srv:${server.id}:${chanId}`,
          async () => {
            if (identityManager.getWipeGeneration() !== wipeGen) return false
            try {
              const rawBytes = new Uint8Array(await recorded.blob.arrayBuffer())
              let attachment: VoiceMemoAttachment

              if (server.kind === 'virtual' && server.encrypted) {
                setVoiceSendPhase('encrypting')
                const { ciphertext, encryption } = await encryptVoiceBytesAesGcm(rawBytes)
                setVoiceSendPhase('uploading')
                const upload = await uploadBlobToBlossom({
                  bytes: ciphertext,
                  mime: 'application/octet-stream',
                  servers: uploadServers,
                  signAuthEvent: (tmpl) => identityManager.signEvent(tmpl),
                })
                attachment = {
                  url: upload.url,
                  mime: cleanMime,
                  size: recorded.size,
                  durationSec: recorded.durationSec,
                  waveform: recorded.waveform,
                  sha256: upload.sha256,
                  encryption,
                  server: upload.server,
                }
              } else {
                setVoiceSendPhase('uploading')
                const upload = await uploadBlobToBlossom({
                  bytes: rawBytes,
                  mime: cleanMime,
                  servers: uploadServers,
                  signAuthEvent: (tmpl) => identityManager.signEvent(tmpl),
                })
                attachment = {
                  url: upload.url,
                  mime: cleanMime,
                  size: upload.size,
                  durationSec: recorded.durationSec,
                  waveform: recorded.waveform,
                  sha256: upload.sha256,
                  server: upload.server,
                }
              }

              if (attachment.sha256 && recorded.previewTranscript?.trim()) {
                onSeedMemoTranscript?.(
                  attachment.sha256,
                  recorded.previewTranscript,
                  recorded.previewTranscriptModel
                )
              }

              setVoiceSendPhase('publishing')
              const body = server.encrypted
                ? cleanCaption
                : cleanCaption
                  ? `${cleanCaption}\n${attachment.url}`
                  : attachment.url

              const ok = await publishServerMessageDirect({
                server,
                channel,
                body,
                replyTarget,
                voiceAttachment: attachment,
                wipeGen,
                nick,
                masterPk,
                powEnabled,
                powTargetBits,
                lightningAddr,
              })
              return ok
            } catch (err) {
              if (identityManager.getWipeGeneration() === wipeGen) {
                pushToast(
                  'error',
                  'Group voice memo failed',
                  err instanceof Error ? err.message : 'Upload error'
                )
              }
              return false
            } finally {
              revokeVoicePreviewUrl(recorded)
              setVoiceSendPhase('idle')
            }
          },
          () => {
            revokeVoicePreviewUrl(recorded)
            return false
          }
        )
      } finally {
        adjustInFlightSend(-1)
      }
    },
    [
      activeServer,
      activeChannel,
      pool,
      blossomServers,
      identityManager,
      settings.powEnabled,
      settings.powTargetBits,
      setVoiceSendPhase,
      onSeedMemoTranscript,
      adjustInFlightSend,
      publishServerMessageDirect,
      pushToast,
    ]
  )

  const sendImageAttachment = useCallback(
    async (image: PreparedImage, caption?: string): Promise<boolean> => {
      if (!activeServer || !activeChannel || !pool) return false
      if (image.size <= 0) return false

      const server = activeServer
      const channel = activeChannel
      const chanId = channel.id
      const targetKey = makeServerChanKey(server.id, chanId)
      const replyTarget = replyingToRef.current
      replyingToRef.current = null
      if (activeServerChanKeyRef.current === targetKey) {
        setReplyingTo(null)
      }

      const cleanMime = cleanMimeType(image.mime, 'image/webp')
      const cleanCaption = caption?.trim() ?? ''
      const nick = identityManager.getNickname()
      const masterPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const wipeGen = identityManager.getWipeGeneration()
      const powEnabled = settings.powEnabled
      const powTargetBits = settings.powTargetBits
      const lightningAddr = lightningAddressRef.current
      const uploadServers = [...blossomServers]

      adjustInFlightSend(1)
      try {
        return await serverSendQueueRef.current.enqueue(
          `srv:${server.id}:${chanId}`,
          async () => {
            if (identityManager.getWipeGeneration() !== wipeGen) {
              revokeImagePreviewUrl(image)
              return false
            }
            try {
              const rawBytes = new Uint8Array(await image.blob.arrayBuffer())
              let attachment: ImageAttachment

              if (server.kind === 'virtual' && server.encrypted) {
                setVoiceSendPhase('encrypting')
                const { ciphertext, encryption } = await encryptMediaBytesAesGcm(rawBytes)
                setVoiceSendPhase('uploading')
                const upload = await uploadBlobToBlossom({
                  bytes: ciphertext,
                  mime: 'application/octet-stream',
                  servers: uploadServers,
                  signAuthEvent: (tmpl) => identityManager.signEvent(tmpl),
                })
                attachment = {
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
              } else {
                setVoiceSendPhase('uploading')
                const upload = await uploadBlobToBlossom({
                  bytes: rawBytes,
                  mime: cleanMime,
                  servers: uploadServers,
                  signAuthEvent: (tmpl) => identityManager.signEvent(tmpl),
                })
                attachment = {
                  url: upload.url,
                  mime: cleanMime,
                  sha256: upload.sha256,
                  size: upload.size,
                  width: image.width,
                  height: image.height,
                  alt: image.fileName,
                  server: upload.server,
                }
              }

              setVoiceSendPhase('publishing')
              const body = server.encrypted
                ? cleanCaption
                : cleanCaption
                  ? `${cleanCaption}\n${attachment.url}`
                  : attachment.url

              return await publishServerMessageDirect({
                server,
                channel,
                body,
                replyTarget,
                imageAttachment: attachment,
                wipeGen,
                nick,
                masterPk,
                powEnabled,
                powTargetBits,
                lightningAddr,
              })
            } catch (err) {
              if (identityManager.getWipeGeneration() === wipeGen) {
                pushToast(
                  'error',
                  'Group image upload failed',
                  err instanceof Error ? err.message : 'Upload error'
                )
              }
              return false
            } finally {
              revokeImagePreviewUrl(image)
              setVoiceSendPhase('idle')
            }
          },
          () => {
            revokeImagePreviewUrl(image)
            return false
          }
        )
      } finally {
        adjustInFlightSend(-1)
      }
    },
    [
      activeServer,
      activeChannel,
      pool,
      blossomServers,
      identityManager,
      settings.powEnabled,
      settings.powTargetBits,
      setVoiceSendPhase,
      adjustInFlightSend,
      publishServerMessageDirect,
      pushToast,
    ]
  )

  const sendReaction = useCallback(
    async (message: ServerMessage, emoji: string): Promise<void> => {
      if (!pool || message.isSystem) return
      const cleanEmoji = emoji.trim()
      if (!cleanEmoji) return

      const server =
        joinedServersRef.current.find((s) => s.id === message.serverId) ?? activeServer
      const chanId = message.channelId || activeChannel?.id
      if (!server || !chanId) return

      const isVirtual = server.kind === 'virtual'
      const targetRelays = isVirtual
        ? server.relays.length > 0
          ? server.relays
          : [...CORE_DM_RELAYS]
        : server.relayUrl
          ? [server.relayUrl]
          : []
      if (targetRelays.length === 0) return

      const tmpl = isVirtual
        ? buildVirtualReactionTemplate({
            server,
            channelId: chanId,
            targetEventId: message.id,
            targetPubkey: message.pubkey,
            emoji: cleanEmoji,
          })
        : buildNip29ReactionTemplate({
            groupId: server.groupId || chanId,
            targetEventId: message.id,
            targetPubkey: message.pubkey,
            emoji: cleanEmoji,
          })

      try {
        const signed = await identityManager.signEvent(tmpl)
        const myPk = signed.pubkey.toLowerCase()
        updateServerChannelMessages(
          server.id,
          chanId,
          (prev) => {
            let changed = false
            const next = prev.map((m) => {
              if (m.id !== message.id) return m
              const updated = applyReaction(
                m,
                { id: signed.id, targetEventId: message.id, pubkey: myPk, emoji: cleanEmoji },
                ownPubkeysRef.current
              )
              if (updated !== m) changed = true
              return updated
            })
            return changed ? next : null
          },
          { allowBackgroundPersist: true }
        )
        await pool.publish(targetRelays, signed, 3500)
      } catch (err) {
        pushToast('error', 'Reaction failed', err instanceof Error ? err.message : 'Unable to react')
      }
    },
    [activeServer, activeChannel, pool, identityManager, updateServerChannelMessages, pushToast]
  )

  const canDeleteMessages = Boolean(
    activeServer && activeServer.kind === 'nip29' && canModerate && activeServer.relayUrl
  )

  const deleteMessage = useCallback(
    async (message: ServerMessage): Promise<boolean> => {
      if (!pool) return false
      const server =
        joinedServersRef.current.find((s) => s.id === message.serverId) ?? activeServer
      const chanId = message.channelId || activeChannel?.id
      if (!server || !chanId) return false
      if (server.kind !== 'nip29' || !canModerate || !server.relayUrl) {
        return false
      }

      try {
        const tmpl = buildNip29DeleteEventTemplate(server.groupId || chanId, message.id)
        const signed = await identityManager.signEvent(tmpl)
        const res = await pool.publish([server.relayUrl], signed, 4000)
        if (res.acceptedRelays.length === 0) {
          pushToast('error', 'Relay did not delete message')
          return false
        }
        updateServerChannelMessages(
          server.id,
          chanId,
          (prev) => {
            const next = prev.filter((m) => m.id !== message.id)
            return next.length === prev.length ? null : next
          },
          { allowBackgroundPersist: true }
        )
        return true
      } catch {
        pushToast('error', 'Relay did not delete message')
        return false
      }
    },
    [
      activeServer,
      activeChannel,
      pool,
      canModerate,
      identityManager,
      updateServerChannelMessages,
      pushToast,
    ]
  )

  const clearChannelCache = useCallback(() => {
    if (!activeServer || !activeChannel) return
    const key = makeServerChanKey(activeServer.id, activeChannel.id)
    setServerMessagesState({ key, items: [] })
    clearServerChannelMessagesStorage(activeServer.id, activeChannel.id)
  }, [activeServer, activeChannel])

  // Moderation & admin actions
  const mutateVirtualServer = useCallback(
    async (
      serverId: string,
      updater: (s: ServerSummary) => ServerSummary,
      successMsg: string
    ): Promise<boolean> => {
      const target = joinedServersRef.current.find((s) => s.id === serverId)
      if (!target || target.kind !== 'virtual') return false
      const updated = updater({ ...target, rev: target.rev + 1 })
      setJoinedServers((prev) => prev.map((s) => (s.id === serverId ? updated : s)))
      try {
        const ok = await publishVirtualManifest(updated)
        if (ok) pushToast('success', successMsg)
        return ok
      } catch (err) {
        pushToast('error', 'Failed to update group manifest', err instanceof Error ? err.message : 'Signing error')
        return false
      }
    },
    [publishVirtualManifest, pushToast]
  )

  const updateServerMetadata = useCallback(
    async (
      serverId: string,
      patch: { name?: string; description?: string; icon?: string; accentColor?: string }
    ): Promise<boolean> => {
      const target = joinedServersRef.current.find((s) => s.id === serverId)
      if (!target) return false

      if (target.kind === 'virtual') {
        return await mutateVirtualServer(
          serverId,
          (s) => ({
            ...s,
            name: patch.name?.trim().slice(0, 48) || s.name,
            description: patch.description !== undefined ? patch.description.trim().slice(0, 200) : s.description,
            icon: patch.icon?.trim().slice(0, 4) || s.icon,
            accentColor: patch.accentColor || s.accentColor,
          }),
          'Group details updated'
        )
      }

      if (target.relayUrl && target.groupId && pool) {
        try {
          const tmpl = buildNip29EditMetadataTemplate({
            groupId: target.groupId,
            name: patch.name ?? target.name,
            about: patch.description ?? target.description,
          })
          const signed = await identityManager.signEvent(tmpl)
          const res = await pool.publish([target.relayUrl], signed, 5000)
          const ok = res.acceptedRelays.length > 0
          setJoinedServers((prev) =>
            prev.map((s) =>
              s.id === serverId
                ? {
                    ...s,
                    name: patch.name?.trim() || s.name,
                    description: patch.description !== undefined ? patch.description.trim() : s.description,
                    icon: patch.icon?.trim().slice(0, 4) || s.icon,
                    accentColor: patch.accentColor || s.accentColor,
                  }
                : s
            )
          )
          if (ok) pushToast('success', 'NIP-29 group metadata updated')
          else pushToast('warning', 'Relay rejected metadata edit', res.rejectedRelays[0]?.reason || 'Admin rights required')
          return ok
        } catch {
          return false
        }
      }
      return false
    },
    [mutateVirtualServer, pool, identityManager, pushToast]
  )

  const addChannel = useCallback(
    async (serverId: string, name: string, topic?: string): Promise<boolean> => {
      const slug = slugifyChannelName(name)
      const target = joinedServersRef.current.find((s) => s.id === serverId)
      if (!target || target.kind !== 'virtual') return false
      if (target.channels.some((c) => c.id === slug)) {
        pushToast('warning', `#${slug} already exists`)
        return false
      }
      return await mutateVirtualServer(
        serverId,
        (s) => ({
          ...s,
          channels: [...s.channels, { id: slug, name: slug, topic: topic?.trim() || undefined }],
        }),
        `Channel #${slug} created`
      )
    },
    [mutateVirtualServer, pushToast]
  )

  const removeChannel = useCallback(
    async (serverId: string, channelId: string): Promise<boolean> => {
      const target = joinedServersRef.current.find((s) => s.id === serverId)
      if (!target || target.kind !== 'virtual') return false
      if (target.channels.length <= 1) {
        pushToast('warning', 'Cannot delete last channel', 'A group must keep at least one channel.')
        return false
      }
      const nextChannels = target.channels.filter((c) => c.id !== channelId)
      clearServerChannelMessagesStorage(serverId, channelId)
      serverUnreadItemsRef.current.delete(makeServerChanKey(serverId, channelId))
      if (activeView.type === 'server' && activeView.serverId === serverId && activeView.channelId === channelId) {
        setActiveView({ type: 'server', serverId, channelId: nextChannels[0].id })
      }
      return await mutateVirtualServer(
        serverId,
        (s) => ({
          ...s,
          channels: nextChannels,
          lastActiveChannelId: s.lastActiveChannelId === channelId ? nextChannels[0].id : s.lastActiveChannelId,
        }),
        `Channel #${channelId} deleted`
      )
    },
    [mutateVirtualServer, activeView, setActiveView, pushToast]
  )

  const addModerator = useCallback(
    async (serverId: string, pubkeyOrNpub: string): Promise<boolean> => {
      const pk = decodePubkeyInput(pubkeyOrNpub)
      if (!pk) {
        pushToast('warning', 'Invalid pubkey', 'Expected npub1… or 64-character hex pubkey.')
        return false
      }
      const target = joinedServersRef.current.find((s) => s.id === serverId)
      if (!target) return false

      if (target.kind === 'virtual') {
        return await mutateVirtualServer(
          serverId,
          (s) => ({
            ...s,
            moderators: Array.from(new Set([...s.moderators, pk])),
          }),
          `Added moderator #${pk.slice(-6)}`
        )
      }

      if (target.relayUrl && target.groupId && pool) {
        const tmpl = buildNip29PutUserTemplate(target.groupId, pk, ['admin'])
        const signed = await identityManager.signEvent(tmpl)
        const res = await pool.publish([target.relayUrl], signed, 5000)
        const ok = res.acceptedRelays.length > 0
        if (ok) pushToast('success', 'Promoted admin on NIP-29 relay')
        else pushToast('error', 'Relay rejected admin promotion', res.rejectedRelays[0]?.reason)
        return ok
      }
      return false
    },
    [mutateVirtualServer, pool, identityManager, pushToast]
  )

  const removeModerator = useCallback(
    async (serverId: string, pubkey: string): Promise<boolean> => {
      const pk = pubkey.toLowerCase()
      const target = joinedServersRef.current.find((s) => s.id === serverId)
      if (!target) return false

      if (target.kind === 'virtual') {
        return await mutateVirtualServer(
          serverId,
          (s) => ({
            ...s,
            moderators: s.moderators.filter((m) => m !== pk),
          }),
          `Removed moderator #${pk.slice(-6)}`
        )
      }

      if (target.relayUrl && target.groupId && pool) {
        const tmpl = buildNip29PutUserTemplate(target.groupId, pk, [])
        const signed = await identityManager.signEvent(tmpl)
        const res = await pool.publish([target.relayUrl], signed, 5000)
        const ok = res.acceptedRelays.length > 0
        if (ok) pushToast('info', 'Demoted NIP-29 admin')
        return ok
      }
      return false
    },
    [mutateVirtualServer, pool, identityManager, pushToast]
  )

  const banMember = useCallback(
    async (serverId: string, pubkeyOrNpub: string, reason = ''): Promise<boolean> => {
      const pk = decodePubkeyInput(pubkeyOrNpub)
      if (!pk) {
        pushToast('warning', 'Invalid pubkey', 'Expected npub1… or 64-character hex pubkey.')
        return false
      }
      const target = joinedServersRef.current.find((s) => s.id === serverId)
      if (!target) return false

      if (target.kind === 'virtual') {
        setServerMessagesState((curr) => {
          if (!curr.key.startsWith(`${serverId}:`)) return curr
          const filtered = curr.items.filter((m) => m.isSystem || m.pubkey.toLowerCase() !== pk)
          if (filtered.length === curr.items.length) return curr
          const chanId = curr.key.slice(serverId.length + 1)
          if (chanId) saveServerChannelMessages(serverId, chanId, filtered)
          return { key: curr.key, items: filtered }
        })
        const ok = await mutateVirtualServer(
          serverId,
          (s) => ({
            ...s,
            moderators: s.moderators.filter((m) => m !== pk),
            bannedPubkeys: Array.from(new Set([...s.bannedPubkeys, pk])),
          }),
          `Banned #${pk.slice(-6)} from group`
        )
        recomputeServerUnreads()
        return ok
      }

      if (target.relayUrl && target.groupId && pool) {
        const tmpl = buildNip29RemoveUserTemplate(target.groupId, pk, reason)
        const signed = await identityManager.signEvent(tmpl)
        const res = await pool.publish([target.relayUrl], signed, 5000)
        const ok = res.acceptedRelays.length > 0
        if (ok) pushToast('info', `Removed #${pk.slice(-6)} from NIP-29 group`)
        else pushToast('error', 'Relay rejected remove-user', res.rejectedRelays[0]?.reason)
        return ok
      }
      return false
    },
    [mutateVirtualServer, recomputeServerUnreads, pool, identityManager, pushToast]
  )

  const unbanMember = useCallback(
    async (serverId: string, pubkey: string): Promise<boolean> => {
      const pk = pubkey.toLowerCase()
      const target = joinedServersRef.current.find((s) => s.id === serverId)
      if (!target) return false

      if (target.kind === 'virtual') {
        return await mutateVirtualServer(
          serverId,
          (s) => ({
            ...s,
            bannedPubkeys: s.bannedPubkeys.filter((b) => b !== pk),
          }),
          `Unbanned #${pk.slice(-6)}`
        )
      }

      if (target.relayUrl && target.groupId && pool) {
        const tmpl = buildNip29PutUserTemplate(target.groupId, pk, [])
        const signed = await identityManager.signEvent(tmpl)
        const res = await pool.publish([target.relayUrl], signed, 5000)
        return res.acceptedRelays.length > 0
      }
      return false
    },
    [mutateVirtualServer, pool, identityManager]
  )

  const reorderJoinedServers = useCallback((fromIndex: number, toIndex: number) => {
    setJoinedServers((prev) => {
      if (
        !Number.isInteger(fromIndex) ||
        !Number.isInteger(toIndex) ||
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
      next.splice(toIndex, 0, moved)
      joinedServersRef.current = next
      saveJoinedServers(next)
      return next
    })
  }, [])

  const applySyncedJoinedServers = useCallback(
    (incomingServers: ServerSummary[]) => {
      const prevMap = new Map<string, ServerSummary>()
      for (const s of joinedServersRef.current) {
        prevMap.set(s.id, s)
      }
      const nextIds = new Set(incomingServers.map((s) => s.id))

      // Clean up cached messages & unread items for servers left on another device
      for (const prevServer of joinedServersRef.current) {
        if (!nextIds.has(prevServer.id)) {
          for (const ch of prevServer.channels) {
            clearServerChannelMessagesStorage(prevServer.id, ch.id)
            serverUnreadItemsRef.current.delete(makeServerChanKey(prevServer.id, ch.id))
          }
        }
      }

      const merged = incomingServers.map((incoming) => {
        const existing = prevMap.get(incoming.id)
        if (!existing) {
          return {
            ...incoming,
            unreadCount: 0,
            mentionCount: 0,
          }
        }
        const existingChanMap = new Map(existing.channels.map((c) => [c.id, c]))
        const channels = incoming.channels.map((ch) => {
          const prevCh = existingChanMap.get(ch.id)
          return {
            ...ch,
            unreadCount: prevCh?.unreadCount ?? 0,
            mentionCount: prevCh?.mentionCount ?? 0,
          }
        })
        const lastActive = channels.some((c) => c.id === existing.lastActiveChannelId)
          ? existing.lastActiveChannelId
          : channels[0]?.id ?? incoming.lastActiveChannelId
        return {
          ...incoming,
          channels,
          lastActiveChannelId: lastActive,
          unreadCount: existing.unreadCount,
          mentionCount: existing.mentionCount,
        }
      })

      joinedServersRef.current = merged
      setJoinedServers(merged)
      saveJoinedServers(merged)

      if (
        activeViewRef.current.type === 'server' &&
        !nextIds.has(activeViewRef.current.serverId)
      ) {
        setActiveView({ type: 'channel', geohash: activeGeohash })
      }
    },
    [activeGeohash, setActiveView]
  )

  const mergeSyncedServerMessages = useCallback(
    (serverId: string, channelId: string, incoming: ServerMessage[]): number => {
      if (!serverId || !channelId || incoming.length === 0) return 0
      const targetServer = joinedServersRef.current.find((s) => s.id === serverId)
      if (!targetServer) return 0
      const bannedSet = new Set(targetServer.bannedPubkeys.map((p) => p.toLowerCase()))

      const validIncoming: ServerMessage[] = []
      for (const raw of incoming) {
        if (
          !raw ||
          raw.isSystem ||
          typeof raw.id !== 'string' ||
          !raw.id ||
          raw.serverId !== serverId ||
          raw.channelId !== channelId ||
          typeof raw.createdAt !== 'number'
        ) {
          continue
        }
        if (isStuckMediaPlaceholder(raw) || isEphemeralPendingMessage(raw)) continue
        const pk = (raw.pubkey || '').toLowerCase()
        if (!/^[0-9a-f]{64}$/.test(pk)) continue
        if (blockedSetRef.current.has(pk) || bannedSet.has(pk)) continue
        validIncoming.push({
          ...raw,
          pubkey: pk,
          isOwn: ownPubkeysRef.current.has(pk),
        })
      }
      if (validIncoming.length === 0) return 0

      let addedCount = 0
      updateServerChannelMessages(
        serverId,
        channelId,
        (prev) => {
          const seen = new Set(prev.map((m) => m.id))
          const toAdd = validIncoming.filter((m) => !seen.has(m.id))
          if (toAdd.length === 0) return null
          addedCount = toAdd.length
          return backfillServerReplies(
            sortChannelMessagesWithPending([...prev, ...toAdd], 'pending-srv-')
          )
        },
        { persist: true, allowBackgroundPersist: true }
      )
      return addedCount
    },
    [updateServerChannelMessages]
  )

  const resetAllServers = useCallback(() => {
    serverSendQueueRef.current.clearAll()
    inFlightSendCountRef.current = 0
    setSending(false)
    replyingToRef.current = null
    exploreUnsubRef.current?.()
    exploreUnsubRef.current = null
    bgSeenIdsRef.current.clear()
    serverUnreadItemsRef.current.clear()
    serverSubGenRef.current += 1
    activeServerChanKeyRef.current = ''
    setJoinedServers([])
    setServerMessagesState({ key: '', items: [] })
    setReplyingTo(null)
    setPendingInvite(null)
    setExploredGroups([])
    setExploringRelay(false)
    setExploreError(null)
  }, [])

  const totalServerUnread = useMemo(
    () => joinedServers.reduce((sum, s) => sum + s.unreadCount, 0),
    [joinedServers]
  )

  const totalServerMentions = useMemo(
    () => joinedServers.reduce((sum, s) => sum + s.mentionCount, 0),
    [joinedServers]
  )

  const getServerUnreadCount = useCallback(
    (serverId: string): number =>
      joinedServers.find((s) => s.id === serverId)?.unreadCount ?? 0,
    [joinedServers]
  )

  const getServerMentionCount = useCallback(
    (serverId: string): number =>
      joinedServers.find((s) => s.id === serverId)?.mentionCount ?? 0,
    [joinedServers]
  )

  const engine: ServersEngine = useMemo(
    () => ({
      joinedServers,
      activeServer,
      activeChannel,
      messages: visibleMessages,
      hiddenByTrustCount,
      members,
      myRole,
      canModerate,
      canDeleteMessages,
      sending,
      creating,
      replyingTo,
      setReplyingTo,
      totalServerUnread,
      totalServerMentions,
      getServerUnreadCount,
      getServerMentionCount,
      pendingInvite,
      clearPendingInvite,
      nip29Presets: [...DEFAULT_NIP29_RELAYS],
      exploredRelayUrl,
      exploredGroups,
      exploringRelay,
      exploreError,
      exploreNip29Relay,
      selectServer,
      selectChannel,
      createVirtualServer,
      createNip29Group,
      parseInviteInput,
      buildInviteLink,
      joinFromInvite,
      joinNip29Group,
      sendInviteViaDm,
      leaveServer,
      reorderJoinedServers,
      sendMessage,
      sendVoiceMemo,
      sendImageAttachment,
      sendReaction,
      deleteMessage,
      clearChannelCache,
      updateServerMetadata,
      addChannel,
      removeChannel,
      addModerator,
      removeModerator,
      banMember,
      unbanMember,
    }),
    [
      joinedServers,
      activeServer,
      activeChannel,
      visibleMessages,
      hiddenByTrustCount,
      members,
      myRole,
      canModerate,
      canDeleteMessages,
      sending,
      creating,
      replyingTo,
      totalServerUnread,
      totalServerMentions,
      getServerUnreadCount,
      getServerMentionCount,
      pendingInvite,
      clearPendingInvite,
      exploredRelayUrl,
      exploredGroups,
      exploringRelay,
      exploreError,
      exploreNip29Relay,
      selectServer,
      selectChannel,
      createVirtualServer,
      createNip29Group,
      parseInviteInput,
      buildInviteLink,
      joinFromInvite,
      joinNip29Group,
      sendInviteViaDm,
      leaveServer,
      reorderJoinedServers,
      sendMessage,
      sendVoiceMemo,
      sendImageAttachment,
      sendReaction,
      deleteMessage,
      clearChannelCache,
      updateServerMetadata,
      addChannel,
      removeChannel,
      addModerator,
      removeModerator,
      banMember,
      unbanMember,
    ]
  )

  return {
    engine,
    activeServerRelays,
    applySyncedJoinedServers,
    mergeSyncedServerMessages,
    resetAllServers,
  }
}
