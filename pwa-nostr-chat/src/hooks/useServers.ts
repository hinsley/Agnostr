import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  extractMentions,
  getTagValue,
  KIND_EPHEMERAL_REACTION,
  mineNip13NonceTag,
  verifyEventCached,
} from '../lib/bitchatProtocol.ts'
import { CORE_DM_RELAYS, normalizeRelayUrl } from '../lib/geoRelays.ts'
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
  clearServerChannelMessagesStorage,
  loadJoinedServers,
  loadServerChannelMessages,
  saveJoinedServers,
  saveServerChannelMessages,
} from '../lib/storage.ts'
import {
  buildEventDeleteTemplate,
  buildVirtualChatTemplate,
  buildVirtualManifestTemplate,
  buildVirtualReactionTemplate,
  defaultMonogram,
  encodeServerInvite,
  extractInviteFromHash,
  generateServerId,
  generateServerKeyB64,
  getVirtualChannelTag,
  KIND_EVENT_DELETE,
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
  sendDirectMessage: (peerPubkey: string, content: string) => Promise<boolean>
  pushToast: (level: ToastLevel, title: string, detail?: string) => void
}

export interface UseServersResult {
  engine: ServersEngine
  activeServerRelays: string[]
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
    sendDirectMessage,
    pushToast,
  } = opts

  const [joinedServers, setJoinedServers] = useState<ServerSummary[]>(() => loadJoinedServers())
  const [rawMessages, setRawMessages] = useState<ServerMessage[]>([])
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

  const rawMessagesRef = useRef<ServerMessage[]>(rawMessages)
  const joinedServersRef = useRef<ServerSummary[]>(joinedServers)
  const ownPubkeysRef = useRef<Set<string>>(ownPubkeys)
  const blockedSetRef = useRef<Set<string>>(blockedSet)

  useEffect(() => {
    rawMessagesRef.current = rawMessages
  }, [rawMessages])

  useEffect(() => {
    joinedServersRef.current = joinedServers
    saveJoinedServers(joinedServers)
  }, [joinedServers])

  useEffect(() => {
    ownPubkeysRef.current = ownPubkeys
  }, [ownPubkeys])

  useEffect(() => {
    blockedSetRef.current = blockedSet
  }, [blockedSet])

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
        window.history.replaceState(null, '', `#${activeGeohash}`)
      }
    } catch {
      // Ignore
    }
  }, [activeGeohash])

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

  const activeServerRelays = useMemo(() => {
    const set = new Set<string>()
    if (activeServer) {
      for (const u of activeServer.relays) set.add(u)
      if (activeServer.relayUrl) set.add(activeServer.relayUrl)
    }
    if (exploringRelay && exploredRelayUrl) {
      set.add(exploredRelayUrl)
    }
    return Array.from(set)
  }, [activeServer, exploringRelay, exploredRelayUrl])

  // Live metadata sync for active server (Virtual kind 30078 OR NIP-29 kinds 39000/39001/39002)
  const activeServerKey = activeServer
    ? `${activeServer.id}|${activeServer.kind}|${activeServer.relayUrl ?? ''}|${activeServer.groupId ?? ''}|${activeServer.founderPubkey}`
    : ''

  useEffect(() => {
    if (!pool || !activeServer) return

    if (activeServer.kind === 'virtual') {
      const targetRelays = activeServer.relays.length > 0 ? activeServer.relays : [...CORE_DM_RELAYS]
      const filter = activeServer.founderPubkey
        ? { kinds: [KIND_VIRTUAL_MANIFEST], authors: [activeServer.founderPubkey], '#d': [manifestDTag(activeServer.id)], limit: 5 }
        : { kinds: [KIND_VIRTUAL_MANIFEST], '#d': [manifestDTag(activeServer.id)], limit: 5 }

      return pool.subscribe(`agnostr-srv-meta-${activeServer.id}`, targetRelays, [filter], {
        onEvent: (ev) => {
          if (!verifyEventCached(ev)) return
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
              return {
                ...s,
                name: manifest.name,
                description: manifest.description,
                icon: manifest.icon,
                accentColor: manifest.accentColor,
                founderPubkey: manifest.founderPubkey,
                channels: manifest.channels,
                moderators: manifest.moderators,
                bannedPubkeys: manifest.bannedPubkeys,
                relays: manifest.relays,
                rev: manifest.rev,
              }
            })
          )
        },
      })
    }

    if (activeServer.kind === 'nip29' && activeServer.relayUrl && activeServer.groupId) {
      const relayUrl = activeServer.relayUrl
      const groupId = activeServer.groupId
      const serverId = activeServer.id

      return pool.subscribe(
        `agnostr-nip29-state-${groupId}`,
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
            if (!verifyEventCached(ev)) return
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
                        channels: [{ id: groupId, name: meta.name.toLowerCase().replace(/\s+/g, '-').slice(0, 24) || groupId, topic: meta.about }],
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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, activeServerKey])

  // Live channel messages & reactions subscription for active server + channel
  const activeChannelId = activeChannel?.id ?? ''
  const activeEncKey = activeServer?.encryptionKeyB64 ?? ''
  const activeBannedKey = (activeServer?.bannedPubkeys ?? []).join(',')

  useEffect(() => {
    if (!activeServer || !activeChannelId) {
      setRawMessages([])
      setReplyingTo(null)
      return
    }

    const serverSnapshot = activeServer
    const chanId = activeChannelId
    const bannedSet = new Set(serverSnapshot.bannedPubkeys.map((p) => p.toLowerCase()))

    const cached = backfillServerReplies(
      loadServerChannelMessages(serverSnapshot.id, chanId).filter(
        (m) => !blockedSetRef.current.has(m.pubkey.toLowerCase()) && !bannedSet.has(m.pubkey.toLowerCase())
      )
    )
    setRawMessages(cached)
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
            kinds: [KIND_VIRTUAL_CHAT, KIND_EPHEMERAL_REACTION, KIND_EVENT_DELETE],
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
    const subId = `agnostr-srv-chat-${serverSnapshot.id.slice(0, 14)}-${chanId.slice(0, 12)}`

    return pool.subscribe(subId, targetRelays, filters, {
      onEvent: (ev) => {
        if (seenIds.has(ev.id)) return
        if (!verifyEventCached(ev)) return
        seenIds.add(ev.id)

        const pk = ev.pubkey.toLowerCase()

        // Deletion event (NIP-09 kind 5 or NIP-29 kind 9005)
        if (ev.kind === KIND_EVENT_DELETE || ev.kind === KIND_NIP29_DELETE_EVENT) {
          const targetId = getTagValue(ev.tags, 'e')
          if (!targetId) return
          const isMod =
            pk === serverSnapshot.founderPubkey ||
            serverSnapshot.moderators.includes(pk) ||
            Boolean(serverSnapshot.admins?.some((a) => a.pubkey === pk))
          setRawMessages((prev) => {
            const target = prev.find((m) => m.id === targetId)
            if (!target) return prev
            if (target.pubkey !== pk && !isMod) return prev
            const next = prev.filter((m) => m.id !== targetId)
            saveServerChannelMessages(serverSnapshot.id, chanId, next)
            return next
          })
          return
        }

        if (blockedSetRef.current.has(pk) || bannedSet.has(pk)) return

        // Ephemeral reaction (kind 20007)
        if (ev.kind === KIND_EPHEMERAL_REACTION) {
          const targetEventId = getTagValue(ev.tags, 'e')
          const emoji = (ev.content ?? '').trim()
          if (!targetEventId || !emoji || emoji.length > 16) return
          const parsedReaction: PendingServerReaction = { id: ev.id, targetEventId, pubkey: pk, emoji }
          setRawMessages((prev) => {
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
              return prev
            }
            if (changed) saveServerChannelMessages(serverSnapshot.id, chanId, next)
            return changed ? next : prev
          })
          return
        }

        // Chat message (kind 9)
        if (ev.kind === KIND_VIRTUAL_CHAT) {
          const ingest = (parsed: ServerMessage | null) => {
            if (!parsed) return
            if (identityManager.getWipeGeneration() !== wipeGen) return

            setRawMessages((prev) => {
              if (prev.some((m) => m.id === parsed.id)) return prev

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

              const next = [...backfilledPrev, hydrated]
                .sort((a, b) => a.createdAt - b.createdAt)
                .slice(-350)
              saveServerChannelMessages(serverSnapshot.id, chanId, next)
              return next
            })
          }

          if (isVirtual) {
            void parseVirtualChatEvent(ev, serverSnapshot, chanId, ownPubkeysRef.current, (id) =>
              rawMessagesRef.current.find((m) => m.id === id)
            ).then(ingest)
          } else {
            ingest(
              parseNip29ChatEvent(
                ev,
                serverSnapshot.id,
                groupId,
                ownPubkeysRef.current,
                (id) => rawMessagesRef.current.find((m) => m.id === id),
                (p) => presenceTracker.getNickname(p)
              )
            )
          }
        }
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, activeServerKey, activeChannelId, activeEncKey, activeBannedKey, identityManager, presenceTracker])

  // Apply ban list + blocked list + Trusted Peers Only mode to visible server messages
  const { visibleMessages, hiddenByTrustCount } = useMemo(() => {
    const bannedSet = new Set((activeServer?.bannedPubkeys ?? []).map((p) => p.toLowerCase()))
    const clean = rawMessages.filter(
      (m) => m.isSystem || (!blockedSet.has(m.pubkey.toLowerCase()) && !bannedSet.has(m.pubkey.toLowerCase()))
    )
    if (!settings.strictWhitelistMode) {
      return { visibleMessages: clean, hiddenByTrustCount: 0 }
    }
    const filtered = clean.filter(
      (m) =>
        m.isSystem ||
        m.isOwn ||
        ownPubkeys.has(m.pubkey.toLowerCase()) ||
        trustedSet.has(m.pubkey.toLowerCase())
    )
    return {
      visibleMessages: filtered,
      hiddenByTrustCount: Math.max(0, clean.length - filtered.length),
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
      if (!m.isSystem) {
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

  // Navigation
  const selectServer = useCallback(
    (serverId: string, channelId?: string) => {
      const target = joinedServersRef.current.find((s) => s.id === serverId)
      if (!target) return
      const nextChan =
        channelId && target.channels.some((c) => c.id === channelId)
          ? channelId
          : target.lastActiveChannelId || target.channels[0]?.id || target.groupId || 'general'

      setJoinedServers((prev) =>
        prev.map((s) =>
          s.id === serverId
            ? { ...s, lastActiveChannelId: nextChan, unreadCount: 0, mentionCount: 0 }
            : s
        )
      )
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
          setExploreError('No public NIP-29 communities returned by this relay.')
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
        pushToast('warning', 'Server name required', 'Enter a name for your new server.')
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
          `${server.encrypted ? 'E2EE ' : ''}Server "${server.name}" created`,
          ok
            ? `Manifest published across core relays. Share your invite link to add members.`
            : 'Saved locally; manifest will sync when relays reconnect.'
        )
        return server
      } catch (err) {
        pushToast('error', 'Failed to create server', err instanceof Error ? err.message : 'Signing error')
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
          const reason = createRes.rejectedRelays[0]?.reason || 'Relay rejected kind 9007 group creation.'
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
        pushToast('success', `NIP-29 Community "${name}" created`, `Hosted on ${new URL(relayUrl).host}`)
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
        pushToast('warning', 'Missing E2EE key', 'This private server invite is missing its encryption key.')
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
        `Joined ${server.encrypted ? 'E2EE ' : ''}server "${server.name}"`,
        server.encrypted ? 'End-to-end AES-256-GCM key imported locally.' : 'Syncing server channels & history.'
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
      const msg = `You're invited to join ${server.encrypted ? 'E2EE private ' : ''}server "${server.name}" on Agnostr:\n${link.url}`
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
      }

      setJoinedServers((prev) => prev.filter((s) => s.id !== serverId))
      if (activeView.type === 'server' && activeView.serverId === serverId) {
        setActiveView({ type: 'channel', geohash: activeGeohash })
      }
      pushToast('info', `Left "${target.name}"`, 'Removed from your server rail.')
    },
    [pool, identityManager, activeView, setActiveView, activeGeohash, pushToast]
  )

  // Messaging (text + voice + image + reactions + delete)
  const sendMessage = useCallback(
    async (
      rawText: string,
      voiceAttachment?: VoiceMemoAttachment,
      imageAttachment?: ImageAttachment
    ): Promise<boolean> => {
      const text = rawText.trim()
      if (!activeServer || !activeChannel || !pool) return false
      if (!text && !voiceAttachment && !imageAttachment) return false

      const server = activeServer
      const chanId = activeChannel.id
      const isVirtual = server.kind === 'virtual'
      const targetRelays = isVirtual
        ? server.relays.length > 0
          ? server.relays
          : [...CORE_DM_RELAYS]
        : server.relayUrl
          ? [server.relayUrl]
          : []
      if (targetRelays.length === 0) return false

      setSending(true)
      try {
        const nick = identityManager.getNickname()
        const masterPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()

        const tmpl = isVirtual
          ? await buildVirtualChatTemplate({
              server,
              channelId: chanId,
              content: text,
              nickname: nick,
              replyTo: replyingTo,
              voiceMemo: voiceAttachment,
              imageAttachment,
            })
          : buildNip29ChatTemplate({
              groupId: server.groupId || chanId,
              content: text,
              nickname: nick,
              previousIds: rawMessagesRef.current.filter((m) => !m.isSystem).map((m) => m.id),
              replyTo: replyingTo,
              voiceMemo: voiceAttachment,
              imageAttachment,
            })

        if (isVirtual && settings.powEnabled && settings.powTargetBits > 0 && masterPk) {
          const nonceTag = await mineNip13NonceTag(tmpl, masterPk, settings.powTargetBits, 450)
          if (nonceTag) tmpl.tags = [...tmpl.tags, nonceTag]
        }

        const signed = await identityManager.signEvent(tmpl)

        const optimistic: ServerMessage = {
          id: signed.id,
          serverId: server.id,
          channelId: chanId,
          pubkey: signed.pubkey.toLowerCase(),
          nickname: nick,
          displayHandle: formatDisplayHandle(nick, signed.pubkey.toLowerCase()),
          content: text,
          createdAt: clampTimestamp(signed.created_at),
          tags: signed.tags,
          isOwn: true,
          encrypted: server.encrypted,
          powBits: 0,
          replyTo:
            replyingTo && !replyingTo.isSystem
              ? {
                  id: replyingTo.id,
                  pubkey: replyingTo.pubkey,
                  nickname: replyingTo.nickname,
                  preview: replyingTo.content.slice(0, 120),
                }
              : undefined,
          reactions: [],
          mentions: extractMentions(text),
          voiceMemo: voiceAttachment,
          imageAttachment,
          deliveryStatus: 'sending',
        }

        setRawMessages((prev) => {
          if (prev.some((m) => m.id === optimistic.id)) return prev
          const next = [...prev, optimistic].sort((a, b) => a.createdAt - b.createdAt)
          saveServerChannelMessages(server.id, chanId, next)
          return next
        })
        setReplyingTo(null)

        const res = await pool.publish(targetRelays, signed)
        const ok = res.acceptedRelays.length > 0

        setRawMessages((prev) => {
          const next = prev.map((m) =>
            m.id === signed.id
              ? {
                  ...m,
                  deliveryStatus: (ok ? 'sent' : 'failed') as ServerMessage['deliveryStatus'],
                  relayCount: res.acceptedRelays.length,
                }
              : m
          )
          saveServerChannelMessages(server.id, chanId, next)
          return next
        })

        if (!ok) {
          const reason = res.rejectedRelays[0]?.reason || 'No connected server relay accepted the message.'
          pushToast('error', 'Message failed to send', reason)
        }
        return ok
      } catch (err) {
        pushToast('error', 'Failed to send message', err instanceof Error ? err.message : 'Signing error')
        return false
      } finally {
        setSending(false)
      }
    },
    [
      activeServer,
      activeChannel,
      pool,
      identityManager,
      replyingTo,
      settings.powEnabled,
      settings.powTargetBits,
      pushToast,
    ]
  )

  const sendVoiceMemo = useCallback(
    async (recorded: RecordedVoiceMemo, caption?: string): Promise<boolean> => {
      if (!activeServer || !activeChannel || !pool) return false
      if (recorded.size <= 0) return false

      const server = activeServer
      const cleanMime = cleanMimeType(recorded.mime)
      const cleanCaption = caption?.trim() ?? ''

      setSending(true)
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
            servers: blossomServers,
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
            servers: blossomServers,
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

        setVoiceSendPhase('publishing')
        const body =
          server.encrypted
            ? cleanCaption
            : cleanCaption
              ? `${cleanCaption}\n${attachment.url}`
              : attachment.url

        const ok = await sendMessage(body, attachment)
        if (ok) {
          revokeVoicePreviewUrl(recorded)
        }
        return ok
      } catch (err) {
        pushToast('error', 'Server voice memo failed', err instanceof Error ? err.message : 'Upload error')
        return false
      } finally {
        setVoiceSendPhase('idle')
        setSending(false)
      }
    },
    [activeServer, activeChannel, pool, blossomServers, identityManager, setVoiceSendPhase, sendMessage, pushToast]
  )

  const sendImageAttachment = useCallback(
    async (image: PreparedImage, caption?: string): Promise<boolean> => {
      if (!activeServer || !activeChannel || !pool) return false
      if (image.size <= 0) return false

      const server = activeServer
      const cleanMime = cleanMimeType(image.mime, 'image/webp')
      const cleanCaption = caption?.trim() ?? ''

      setSending(true)
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
            servers: blossomServers,
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
            servers: blossomServers,
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

        const ok = await sendMessage(body, undefined, attachment)
        if (ok) {
          revokeImagePreviewUrl(image)
        }
        return ok
      } catch (err) {
        pushToast('error', 'Server image upload failed', err instanceof Error ? err.message : 'Upload error')
        return false
      } finally {
        setVoiceSendPhase('idle')
        setSending(false)
      }
    },
    [activeServer, activeChannel, pool, blossomServers, identityManager, setVoiceSendPhase, sendMessage, pushToast]
  )

  const sendReaction = useCallback(
    async (message: ServerMessage, emoji: string): Promise<void> => {
      if (!activeServer || !activeChannel || !pool || message.isSystem) return
      const cleanEmoji = emoji.trim()
      if (!cleanEmoji) return

      const isVirtual = activeServer.kind === 'virtual'
      const targetRelays = isVirtual
        ? activeServer.relays.length > 0
          ? activeServer.relays
          : [...CORE_DM_RELAYS]
        : activeServer.relayUrl
          ? [activeServer.relayUrl]
          : []
      if (targetRelays.length === 0) return

      const tmpl = isVirtual
        ? buildVirtualReactionTemplate({
            server: activeServer,
            channelId: activeChannel.id,
            targetEventId: message.id,
            targetPubkey: message.pubkey,
            emoji: cleanEmoji,
          })
        : buildNip29ReactionTemplate({
            groupId: activeServer.groupId || activeChannel.id,
            targetEventId: message.id,
            targetPubkey: message.pubkey,
            emoji: cleanEmoji,
          })

      try {
        const signed = await identityManager.signEvent(tmpl)
        const myPk = signed.pubkey.toLowerCase()
        setRawMessages((prev) => {
          const next = prev.map((m) =>
            m.id === message.id
              ? applyReaction(m, { id: signed.id, targetEventId: message.id, pubkey: myPk, emoji: cleanEmoji }, ownPubkeysRef.current)
              : m
          )
          saveServerChannelMessages(activeServer.id, activeChannel.id, next)
          return next
        })
        await pool.publish(targetRelays, signed, 3500)
      } catch (err) {
        pushToast('error', 'Reaction failed', err instanceof Error ? err.message : 'Unable to react')
      }
    },
    [activeServer, activeChannel, pool, identityManager, pushToast]
  )

  const deleteMessage = useCallback(
    async (message: ServerMessage): Promise<boolean> => {
      if (!activeServer || !activeChannel || !pool) return false
      const isVirtual = activeServer.kind === 'virtual'
      const targetRelays = isVirtual
        ? activeServer.relays.length > 0
          ? activeServer.relays
          : [...CORE_DM_RELAYS]
        : activeServer.relayUrl
          ? [activeServer.relayUrl]
          : []
      if (targetRelays.length === 0) return false

      try {
        const tmpl =
          !isVirtual && canModerate
            ? buildNip29DeleteEventTemplate(activeServer.groupId || activeChannel.id, message.id)
            : buildEventDeleteTemplate(message.id)
        if (isVirtual) {
          tmpl.tags.push(['t', getVirtualChannelTag(activeServer, activeChannel.id)])
        }
        const signed = await identityManager.signEvent(tmpl)
        const res = await pool.publish(targetRelays, signed, 4000)
        setRawMessages((prev) => {
          const next = prev.filter((m) => m.id !== message.id)
          saveServerChannelMessages(activeServer.id, activeChannel.id, next)
          return next
        })
        return res.acceptedRelays.length > 0
      } catch {
        return false
      }
    },
    [activeServer, activeChannel, pool, canModerate, identityManager]
  )

  const clearChannelCache = useCallback(() => {
    if (!activeServer || !activeChannel) return
    setRawMessages([])
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
        pushToast('error', 'Failed to update server manifest', err instanceof Error ? err.message : 'Signing error')
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
          'Server details updated'
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
        pushToast('warning', 'Cannot delete last channel', 'A server must keep at least one channel.')
        return false
      }
      const nextChannels = target.channels.filter((c) => c.id !== channelId)
      clearServerChannelMessagesStorage(serverId, channelId)
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
        setRawMessages((prev) => prev.filter((m) => m.pubkey.toLowerCase() !== pk))
        return await mutateVirtualServer(
          serverId,
          (s) => ({
            ...s,
            moderators: s.moderators.filter((m) => m !== pk),
            bannedPubkeys: Array.from(new Set([...s.bannedPubkeys, pk])),
          }),
          `Banned #${pk.slice(-6)} from server`
        )
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
    [mutateVirtualServer, pool, identityManager, pushToast]
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

  const resetAllServers = useCallback(() => {
    exploreUnsubRef.current?.()
    exploreUnsubRef.current = null
    setJoinedServers([])
    setRawMessages([])
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
      sending,
      creating,
      replyingTo,
      setReplyingTo,
      totalServerUnread,
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
      sendMessage: (rawText) => sendMessage(rawText),
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
      sending,
      creating,
      replyingTo,
      totalServerUnread,
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

  return { engine, activeServerRelays, resetAllServers }
}
