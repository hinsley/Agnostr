import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Filter, VerifiedEvent } from 'nostr-tools'
import type { ActiveView, DmThread, TypingPeer } from '../types/protocol.ts'
import type { Nip29Member, ServerSummary } from '../types/servers.ts'
import {
  getTopicSlug,
  isTopicChannel,
  normalizeBitchatChannelKey,
  normalizeTopicSlug,
} from '../lib/bitchatChannel.ts'
import { isAutoAnonNickname } from '../lib/deviceSync.ts'
import { normalizeGeohash } from '../lib/geohash.ts'
import { formatDisplayHandle, type IdentityManager, type SigningKeyMaterial } from '../lib/identity.ts'
import type { PresenceTracker } from '../lib/presenceService.ts'
import type { RelayPool } from '../lib/relayPool.ts'
import {
  buildDmTypingEvent,
  buildGeoTypingEvent,
  buildServerTypingEvent,
  DM_TYPING_TAG,
  getServerTypingScopeTag,
  KIND_TYPING_INDICATOR,
  MAX_TYPING_EVENT_AGE_SEC,
  parseDmTypingEvent,
  parseGeoTypingEvent,
  parseServerTypingEvent,
  TYPING_BROADCAST_THROTTLE_MS,
  TYPING_PEER_TTL_MS,
  TYPING_STOP_IDLE_MS,
  TYPING_TAG,
  type TypingSignalState,
} from '../lib/typingSignaling.ts'

export interface UseTypingIndicatorsOptions {
  pool: RelayPool | null
  identityManager: IdentityManager
  presenceTracker: PresenceTracker
  activeView: ActiveView
  activeServer: ServerSummary | null
  activeServerMembers: readonly Nip29Member[]
  activeDmThread: DmThread | null
  channelRelays: readonly string[]
  dmRelays: readonly string[]
  ownPubkeys: Set<string>
  blockedSet: Set<string>
  trustedSet: Set<string>
  strictWhitelistMode: boolean
  enabled: boolean
  identityVersion: number
}

export interface UseTypingIndicatorsResult {
  typingPeers: TypingPeer[]
  notifyTypingInput: (hasDraft: boolean) => void
  notifyTypingStopped: () => void
  clearPeerTyping: (pubkey: string) => void
}

interface OutgoingScopeSnapshot {
  scopeKey: string
  view: ActiveView
  server: ServerSummary | null
  relays: string[]
}

const MAX_VISIBLE_TYPING_PEERS = 16
const MAX_SEEN_TYPING_EVENT_IDS = 200

function pickBestTypingNickname(
  pubkey: string,
  ...candidates: Array<string | null | undefined>
): string {
  for (const raw of candidates) {
    const clean = (raw ?? '').trim().slice(0, 32)
    if (clean && !isAutoAnonNickname(clean)) {
      return clean
    }
  }
  for (const raw of candidates) {
    const clean = (raw ?? '').trim().slice(0, 32)
    if (clean) return clean
  }
  return `anon${pubkey.toLowerCase().slice(-4)}`
}

function computeScopeKey(view: ActiveView): string {
  if (view.type === 'channel') {
    const key = normalizeBitchatChannelKey(view.geohash) ?? normalizeGeohash(view.geohash)
    return `geo:${key}`
  }
  if (view.type === 'server') {
    return `server:${view.serverId}:${view.channelId}`
  }
  return `dm:${view.peerPubkey.trim().toLowerCase()}`
}

export function useTypingIndicators(
  options: UseTypingIndicatorsOptions
): UseTypingIndicatorsResult {
  const {
    pool,
    identityManager,
    presenceTracker,
    activeView,
    activeServer,
    activeServerMembers,
    activeDmThread,
    channelRelays,
    dmRelays,
    ownPubkeys,
    blockedSet,
    trustedSet,
    strictWhitelistMode,
    enabled,
    identityVersion,
  } = options

  const [typingPeers, setTypingPeers] = useState<TypingPeer[]>([])

  const scopeKey = useMemo(() => computeScopeKey(activeView), [activeView])

  const activeRelays = useMemo<string[]>(() => {
    if (activeView.type === 'channel') return Array.from(new Set(channelRelays))
    if (activeView.type === 'server') {
      if (!activeServer || activeServer.id !== activeView.serverId) return []
      const scopedRelays =
        activeServer.kind === 'nip29'
          ? activeServer.relayUrl
            ? [activeServer.relayUrl]
            : activeServer.relays
          : activeServer.relays.length > 0
            ? activeServer.relays
            : dmRelays
      return Array.from(
        new Set(scopedRelays.filter((r) => typeof r === 'string' && r.trim().length > 0))
      )
    }
    return Array.from(new Set(dmRelays))
  }, [activeView, activeServer, channelRelays, dmRelays])

  const activeRelaysKey = useMemo(() => activeRelays.join(','), [activeRelays])

  const poolRef = useRef<RelayPool | null>(pool)
  const activeViewRef = useRef<ActiveView>(activeView)
  const activeServerRef = useRef<ServerSummary | null>(activeServer)
  const activeServerMembersRef = useRef<readonly Nip29Member[]>(activeServerMembers)
  const activeDmThreadRef = useRef<DmThread | null>(activeDmThread)
  const activeRelaysRef = useRef<string[]>(activeRelays)
  const ownPubkeysRef = useRef<Set<string>>(ownPubkeys)
  const blockedSetRef = useRef<Set<string>>(blockedSet)
  const trustedSetRef = useRef<Set<string>>(trustedSet)
  const strictWhitelistRef = useRef<boolean>(strictWhitelistMode)
  const enabledRef = useRef<boolean>(enabled)

  const subSeqRef = useRef<number>(0)
  const sentTypingInScopeRef = useRef<boolean>(false)
  const lastTypingSentAtRef = useRef<number>(0)
  const idleStopTimerRef = useRef<number | null>(null)
  const currentScopeSnapshotRef = useRef<OutgoingScopeSnapshot>({
    scopeKey,
    view: activeView,
    server: activeServer,
    relays: activeRelays,
  })

  useLayoutEffect(() => {
    poolRef.current = pool
    activeViewRef.current = activeView
    activeServerRef.current = activeServer
    activeServerMembersRef.current = activeServerMembers
    activeDmThreadRef.current = activeDmThread
    activeRelaysRef.current = activeRelays
    ownPubkeysRef.current = ownPubkeys
    blockedSetRef.current = blockedSet
    trustedSetRef.current = trustedSet
    strictWhitelistRef.current = strictWhitelistMode
    enabledRef.current = enabled
    currentScopeSnapshotRef.current = {
      scopeKey,
      view: activeView,
      server: activeServer,
      relays: activeRelays,
    }
  }, [
    pool,
    scopeKey,
    activeView,
    activeServer,
    activeServerMembers,
    activeDmThread,
    activeRelays,
    ownPubkeys,
    blockedSet,
    trustedSet,
    strictWhitelistMode,
    enabled,
  ])

  const clearIdleStopTimer = useCallback(() => {
    if (idleStopTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(idleStopTimerRef.current)
      idleStopTimerRef.current = null
    }
  }, [])

  const clearPeerTyping = useCallback((pubkey: string) => {
    const pk = pubkey.trim().toLowerCase()
    if (!pk) return
    setTypingPeers((prev) => {
      if (!prev.some((p) => p.pubkey === pk)) return prev
      return prev.filter((p) => p.pubkey !== pk)
    })
  }, [])

  const resolvePeerIdentity = useCallback(
    (pubkey: string, eventNickname?: string): { nickname: string; displayHandle: string } => {
      const pk = pubkey.toLowerCase()
      const view = activeViewRef.current
      const dmNick =
        view.type === 'dm' && activeDmThreadRef.current?.peerPubkey.toLowerCase() === pk
          ? activeDmThreadRef.current.peerNickname
          : undefined
      const memberNick =
        view.type === 'server'
          ? activeServerMembersRef.current.find((m) => m.pubkey.toLowerCase() === pk)?.nickname
          : undefined
      const presenceNick = presenceTracker.getNickname(pk)
      const nickname = pickBestTypingNickname(pk, dmNick, memberNick, presenceNick, eventNickname)
      return {
        nickname,
        displayHandle: formatDisplayHandle(nickname, pk),
      }
    },
    [presenceTracker]
  )

  const upsertTypingPeer = useCallback(
    (pubkey: string, eventNickname?: string) => {
      const pk = pubkey.trim().toLowerCase()
      if (!pk) return
      if (ownPubkeysRef.current.has(pk)) return
      if (blockedSetRef.current.has(pk)) return
      if (strictWhitelistRef.current && !trustedSetRef.current.has(pk)) return

      const { nickname, displayHandle } = resolvePeerIdentity(pk, eventNickname)
      const expiresAt = Date.now() + TYPING_PEER_TTL_MS

      setTypingPeers((prev) => {
        const idx = prev.findIndex((p) => p.pubkey === pk)
        if (idx !== -1) {
          const next = [...prev]
          next[idx] = { pubkey: pk, nickname, displayHandle, expiresAt }
          return next
        }
        const appended = [...prev, { pubkey: pk, nickname, displayHandle, expiresAt }]
        return appended.length > MAX_VISIBLE_TYPING_PEERS
          ? appended.slice(-MAX_VISIBLE_TYPING_PEERS)
          : appended
      })
    },
    [resolvePeerIdentity]
  )

  const publishTypingForScope = useCallback(
    async (state: TypingSignalState, scopeOverride?: OutgoingScopeSnapshot): Promise<void> => {
      const currentPool = poolRef.current
      if (!currentPool) return
      if (state === 'typing' && !enabledRef.current) return

      const scope = scopeOverride ?? currentScopeSnapshotRef.current
      const relays = scope.relays
      if (relays.length === 0) return

      const view = scope.view
      const signer: SigningKeyMaterial =
        view.type === 'channel'
          ? identityManager.getKeyMaterialForGeohash(view.geohash)
          : identityManager.getMasterKeyMaterial()
      if (signer.mode === 'extension' || !signer.secretKey) return

      const nickname = identityManager.getNickname()
      let signedEvent: VerifiedEvent | null = null

      try {
        if (view.type === 'channel') {
          signedEvent = buildGeoTypingEvent({
            channelKey: view.geohash,
            signer,
            nickname,
            state,
          })
        } else if (view.type === 'server') {
          const srv = scope.server
          if (!srv || srv.id !== view.serverId) return
          signedEvent = await buildServerTypingEvent({
            server: srv,
            channelId: view.channelId,
            signer,
            nickname,
            state,
          })
        } else {
          signedEvent = buildDmTypingEvent({
            peerPubkey: view.peerPubkey,
            signer,
            nickname,
            state,
          })
        }
      } catch {
        return
      }

      if (!signedEvent) return
      void currentPool.publish([...relays], signedEvent).catch(() => {})
    },
    [identityManager]
  )

  const notifyTypingStopped = useCallback(() => {
    clearIdleStopTimer()
    if (!sentTypingInScopeRef.current) return
    sentTypingInScopeRef.current = false
    lastTypingSentAtRef.current = 0
    void publishTypingForScope('stop')
  }, [clearIdleStopTimer, publishTypingForScope])

  const notifyTypingInput = useCallback(
    (hasDraft: boolean) => {
      if (!hasDraft) {
        notifyTypingStopped()
        return
      }
      if (!enabledRef.current) return

      clearIdleStopTimer()
      if (typeof window !== 'undefined') {
        idleStopTimerRef.current = window.setTimeout(() => {
          idleStopTimerRef.current = null
          if (!sentTypingInScopeRef.current) return
          sentTypingInScopeRef.current = false
          lastTypingSentAtRef.current = 0
          void publishTypingForScope('stop')
        }, TYPING_STOP_IDLE_MS)
      }

      const now = Date.now()
      if (
        !sentTypingInScopeRef.current ||
        now - lastTypingSentAtRef.current >= TYPING_BROADCAST_THROTTLE_MS
      ) {
        sentTypingInScopeRef.current = true
        lastTypingSentAtRef.current = now
        void publishTypingForScope('typing')
      }
    },
    [clearIdleStopTimer, notifyTypingStopped, publishTypingForScope]
  )

  // If user disables typing indicators while mid-draft, immediately broadcast stop and cancel idle timer
  useEffect(() => {
    if (!enabled) {
      notifyTypingStopped()
    }
  }, [enabled, notifyTypingStopped])

  // Immediately filter visible typing peers when block/trust/whitelist/own pubkeys change
  useEffect(() => {
    setTypingPeers((prev) => {
      if (prev.length === 0) return prev
      const filtered = prev.filter(
        (p) =>
          !ownPubkeys.has(p.pubkey) &&
          !blockedSet.has(p.pubkey) &&
          (!strictWhitelistMode || trustedSet.has(p.pubkey))
      )
      return filtered.length === prev.length ? prev : filtered
    })
  }, [ownPubkeys, blockedSet, trustedSet, strictWhitelistMode])

  // Lightweight TTL prune interval — runs ONLY while at least one peer is visibly typing
  const hasTypingPeers = typingPeers.length > 0
  useEffect(() => {
    if (!hasTypingPeers || typeof window === 'undefined') return
    const timer = window.setInterval(() => {
      const now = Date.now()
      setTypingPeers((prev) => {
        const alive = prev.filter((p) => p.expiresAt > now)
        return alive.length === prev.length ? prev : alive
      })
    }, 1_000)
    return () => {
      window.clearInterval(timer)
    }
  }, [hasTypingPeers])

  // Active-view-only ephemeral typing subscription
  const activeServerId = activeServer?.id ?? ''
  const activeServerKind = activeServer?.kind ?? ''
  const activeServerGroupId = activeServer?.groupId ?? ''
  const activeServerEncrypted = Boolean(activeServer?.encrypted)
  const activeServerKeyB64 = activeServer?.encryptionKeyB64 ?? ''

  useEffect(() => {
    // Immediately clear visible typing peers on view/channel/peer/identity switch
    setTypingPeers([])
    clearIdleStopTimer()
    sentTypingInScopeRef.current = false
    lastTypingSentAtRef.current = 0

    const scopeAtMount: OutgoingScopeSnapshot = {
      scopeKey,
      view: activeViewRef.current,
      server: activeServerRef.current,
      relays: activeRelaysRef.current,
    }

    const sendStopOnCleanup = () => {
      clearIdleStopTimer()
      if (!sentTypingInScopeRef.current) return
      sentTypingInScopeRef.current = false
      lastTypingSentAtRef.current = 0
      void publishTypingForScope('stop', scopeAtMount)
    }

    if (!pool || activeRelaysRef.current.length === 0) {
      return sendStopOnCleanup
    }

    const view = activeViewRef.current
    const relays = [...activeRelaysRef.current]
    const since = Math.floor(Date.now() / 1000) - MAX_TYPING_EVENT_AGE_SEC
    const filters: Filter[] = []

    const recipientByPubkey = new Map<string, SigningKeyMaterial>()

    if (view.type === 'channel') {
      const normalized = normalizeBitchatChannelKey(view.geohash) ?? normalizeGeohash(view.geohash)
      if (!normalized) return sendStopOnCleanup
      if (isTopicChannel(normalized)) {
        const slug = getTopicSlug(normalized) ?? normalizeTopicSlug(normalized)
        if (!slug) return sendStopOnCleanup
        filters.push({
          kinds: [KIND_TYPING_INDICATOR],
          '#d': [slug],
          '#t': [TYPING_TAG],
          since,
          limit: 20,
        })
      } else {
        filters.push({
          kinds: [KIND_TYPING_INDICATOR],
          '#g': [normalized],
          '#t': [TYPING_TAG],
          since,
          limit: 20,
        })
      }
    } else if (view.type === 'server') {
      const srv = activeServerRef.current
      if (!srv || srv.id !== view.serverId) return sendStopOnCleanup
      const scopeTag = getServerTypingScopeTag(srv)
      if (!scopeTag) return sendStopOnCleanup
      filters.push({
        kinds: [KIND_TYPING_INDICATOR],
        '#h': [scopeTag],
        '#t': [TYPING_TAG],
        since,
        limit: 20,
      })
    } else {
      const masterMat = identityManager.getMasterKeyMaterial()
      if (masterMat.mode === 'extension' || !masterMat.secretKey) {
        return sendStopOnCleanup
      }
      recipientByPubkey.set(masterMat.pubkey.toLowerCase(), masterMat)
      const pTags = Array.from(recipientByPubkey.keys())
      filters.push({
        kinds: [KIND_TYPING_INDICATOR],
        '#p': pTags,
        '#t': [DM_TYPING_TAG],
        since,
        limit: 20,
      })
    }

    let cancelled = false
    const seenEventIds = new Set<string>()
    const serverSnapshot = activeServerRef.current

    const unsub = pool.subscribe(
      `agnostr-typing-${++subSeqRef.current}`,
      relays,
      filters,
      {
        onEvent: (ev) => {
          if (cancelled || !ev || ev.kind !== KIND_TYPING_INDICATOR || typeof ev.id !== 'string') {
            return
          }
          const evId = ev.id.toLowerCase()
          if (seenEventIds.has(evId)) return
          seenEventIds.add(evId)
          if (seenEventIds.size > MAX_SEEN_TYPING_EVENT_IDS) {
            const oldest = seenEventIds.values().next().value
            if (oldest) seenEventIds.delete(oldest)
          }

          if (view.type === 'channel') {
            const parsed = parseGeoTypingEvent(ev, view.geohash)
            if (!parsed) return
            if (parsed.state === 'stop') {
              clearPeerTyping(parsed.pubkey)
            } else {
              upsertTypingPeer(parsed.pubkey, parsed.nickname)
            }
            return
          }

          if (view.type === 'server') {
            if (!serverSnapshot || serverSnapshot.id !== view.serverId) return
            void parseServerTypingEvent(ev, serverSnapshot, view.channelId).then((parsed) => {
              if (cancelled || !parsed) return
              if (parsed.state === 'stop') {
                clearPeerTyping(parsed.pubkey)
              } else {
                upsertTypingPeer(parsed.pubkey, parsed.nickname)
              }
            })
            return
          }

          const targetTag = ev.tags
            .find((t) => Array.isArray(t) && t[0] === 'p' && typeof t[1] === 'string')?.[1]
            ?.trim()
            .toLowerCase()
          if (!targetTag) return
          const recipient = recipientByPubkey.get(targetTag)
          if (!recipient) return
          const parsed = parseDmTypingEvent(ev, recipient, view.peerPubkey)
          if (!parsed) return
          if (parsed.state === 'stop') {
            clearPeerTyping(parsed.pubkey)
          } else {
            upsertTypingPeer(parsed.pubkey, parsed.nickname)
          }
        },
      }
    )

    return () => {
      cancelled = true
      unsub()
      sendStopOnCleanup()
    }
  }, [
    pool,
    scopeKey,
    activeRelaysKey,
    identityVersion,
    activeServerId,
    activeServerKind,
    activeServerGroupId,
    activeServerEncrypted,
    activeServerKeyB64,
    identityManager,
    clearIdleStopTimer,
    publishTypingForScope,
    clearPeerTyping,
    upsertTypingPeer,
  ])

  return {
    typingPeers,
    notifyTypingInput,
    notifyTypingStopped,
    clearPeerTyping,
  }
}
