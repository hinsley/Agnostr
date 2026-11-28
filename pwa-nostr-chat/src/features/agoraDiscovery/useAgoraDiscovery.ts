import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Event as NostrEvent } from 'nostr-tools'
import type { AgoraArticle } from '../../types/agora.ts'
import type { AgnostrEngine } from '../../types/protocol.ts'
import {
  AGORA_SOCIAL_RELAYS,
  KIND_AGORA_FOLLOW_LIST,
  KIND_AGORA_NOTE,
  KIND_AGORA_REPOST,
  isHex64,
  parseAgoraNote,
  parseAgoraRepost,
  parseFollowList,
} from '../../lib/agoraProtocol.ts'
import { verifyEventCached } from '../../lib/bitchatProtocol.ts'
import type {
  AgoraDiscoveryController,
  AntiSlopMode,
  DiscoveryLens,
  DiscoveryPrefs,
  DiscoveryProgress,
  DiscoveryTopicId,
  FollowPack,
  WotReachMode,
} from './types.ts'
import {
  buildSeedGraph,
  computeSimilarVoices,
  crawlWotDiscoveryGraph,
  loadCachedWotSnapshot,
  loadDiscoveryPrefs,
  loadDismissedPubkeys,
  saveDiscoveryPrefs,
  saveDismissedPubkeys,
  scoreWotGraphSnapshot,
  type WotRawSnapshot,
} from './wotGraphEngine.ts'

export interface UseAgoraDiscoveryOptions {
  engine: AgnostrEngine
  initialSimilarPubkey?: string | null
}

interface SimilarTargetMetadata {
  follows: string[]
  interacted: string[]
}

const INITIAL_PROGRESS: DiscoveryProgress = {
  loading: false,
  phase: 'idle',
  seedsProcessed: 0,
  seedsTotal: 0,
  lastUpdatedAt: null,
}

export function useAgoraDiscovery(options: UseAgoraDiscoveryOptions): AgoraDiscoveryController {
  const { engine, initialSimilarPubkey } = options
  const { agora } = engine
  const myPubkey = agora.myPubkey.toLowerCase()

  const [lens, setLens] = useState<DiscoveryLens>(() =>
    initialSimilarPubkey && isHex64(initialSimilarPubkey) ? 'graph' : 'people'
  )
  const [prefs, setPrefs] = useState<DiscoveryPrefs>(() => loadDiscoveryPrefs())
  const [dismissedPubkeys, setDismissedPubkeys] = useState<string[]>(() => loadDismissedPubkeys())
  const [similarToPubkey, setSimilarToPubkeyState] = useState<string | null>(() =>
    initialSimilarPubkey && isHex64(initialSimilarPubkey)
      ? initialSimilarPubkey.toLowerCase()
      : null
  )
  const [snapshot, setSnapshot] = useState<WotRawSnapshot | null>(() =>
    loadCachedWotSnapshot(myPubkey)
  )
  const [progress, setProgress] = useState<DiscoveryProgress>(() => {
    const cached = loadCachedWotSnapshot(myPubkey)
    if (cached) {
      return {
        loading: false,
        phase: 'ready',
        seedsProcessed: cached.seeds.length,
        seedsTotal: cached.seeds.length,
        lastUpdatedAt: cached.fetchedAt,
      }
    }
    return INITIAL_PROGRESS
  })
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [similarMetaByPk, setSimilarMetaByPk] = useState<Record<string, SimilarTargetMetadata>>({})

  const crawlGenRef = useRef(0)
  const similarInFlightRef = useRef<Set<string>>(new Set())
  const nip05RequestedRef = useRef<Set<string>>(new Set())
  const lastAutoCrawlSeedCountRef = useRef<number>(-1)

  // Sync external initialSimilarPubkey handoff (e.g. clicking "Similar" on a Profile)
  useEffect(() => {
    if (initialSimilarPubkey && isHex64(initialSimilarPubkey)) {
      const lower = initialSimilarPubkey.toLowerCase()
      setSimilarToPubkeyState(lower)
      setLens('graph')
    }
  }, [initialSimilarPubkey])

  // Reload cache if active identity switches
  useEffect(() => {
    const cached = loadCachedWotSnapshot(myPubkey)
    setSnapshot(cached)
    setDismissedPubkeys(loadDismissedPubkeys())
    setPrefs(loadDiscoveryPrefs())
    setSimilarMetaByPk({})
    similarInFlightRef.current.clear()
    nip05RequestedRef.current.clear()
    lastAutoCrawlSeedCountRef.current = -1
    if (cached) {
      setProgress({
        loading: false,
        phase: 'ready',
        seedsProcessed: cached.seeds.length,
        seedsTotal: cached.seeds.length,
        lastUpdatedAt: cached.fetchedAt,
      })
    } else {
      setProgress(INITIAL_PROGRESS)
    }
  }, [myPubkey])

  // Derive normalized trust, follow, local-peer, blocked & dismissed sets
  const blockedSet = useMemo(
    () => new Set(engine.blockedPubkeys.map((pk) => pk.toLowerCase())),
    [engine.blockedPubkeys]
  )
  const trustedPubkeys = useMemo(
    () => engine.trustedPubkeys.map((entry) => entry.pubkey.toLowerCase()),
    [engine.trustedPubkeys]
  )
  const trustedSet = useMemo(() => new Set(trustedPubkeys), [trustedPubkeys])
  const followingSet = useMemo(
    () => new Set(agora.followingPubkeys.map((pk) => pk.toLowerCase())),
    [agora.followingPubkeys]
  )
  const dismissedSet = useMemo(() => new Set(dismissedPubkeys), [dismissedPubkeys])

  const localPeerPubkeys = useMemo(() => {
    const out = new Set<string>()
    for (const thread of engine.dmThreads) {
      if (isHex64(thread.peerPubkey)) out.add(thread.peerPubkey.toLowerCase())
    }
    for (const peer of engine.peers) {
      if (isHex64(peer.pubkey)) out.add(peer.pubkey.toLowerCase())
    }
    return Array.from(out)
  }, [engine.dmThreads, engine.peers])

  const seedSummary = useMemo(
    () =>
      buildSeedGraph({
        myPubkey,
        trustedPubkeys,
        followingPubkeys: agora.followingPubkeys,
        localPeerPubkeys,
        blockedSet,
      }),
    [myPubkey, trustedPubkeys, agora.followingPubkeys, localPeerPubkeys, blockedSet]
  )

  const seedCount = seedSummary.seeds.length
  const isColdStart = seedSummary.isColdStart

  // Stable refs for live crawl inputs so crawl effect never churns unnecessarily
  const agoraRef = useRef(agora)
  agoraRef.current = agora
  const trustedRef = useRef(trustedPubkeys)
  trustedRef.current = trustedPubkeys
  const followingRef = useRef(agora.followingPubkeys)
  followingRef.current = agora.followingPubkeys
  const localPeersRef = useRef(localPeerPubkeys)
  localPeersRef.current = localPeerPubkeys
  const blockedSetRef = useRef(blockedSet)
  blockedSetRef.current = blockedSet
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  // Lazy progressive crawl on mount (when cache missing/stale, seeds arrived post-bootstrap, or manual refresh)
  useEffect(() => {
    if (!isHex64(myPubkey)) return

    const currentSnap = snapshotRef.current
    const isManualRefresh = refreshNonce > 0
    const cacheHasSeedsMismatch =
      Boolean(currentSnap) &&
      currentSnap !== null &&
      currentSnap.seeds.length === 0 &&
      seedCount > 0 &&
      lastAutoCrawlSeedCountRef.current !== seedCount

    if (!isManualRefresh && currentSnap && !cacheHasSeedsMismatch) {
      return
    }

    lastAutoCrawlSeedCountRef.current = seedCount
    const gen = ++crawlGenRef.current
    let cancelled = false

    void crawlWotDiscoveryGraph({
      agora: agoraRef.current,
      myPubkey,
      trustedPubkeys: trustedRef.current,
      followingPubkeys: followingRef.current,
      localPeerPubkeys: localPeersRef.current,
      blockedSet: blockedSetRef.current,
      onProgress: (nextProgress) => {
        if (!cancelled && crawlGenRef.current === gen) {
          setProgress(nextProgress)
        }
      },
      isCancelled: () => cancelled || crawlGenRef.current !== gen,
    }).then((result) => {
      if (cancelled || crawlGenRef.current !== gen) return
      if (result) {
        setSnapshot(result)
      } else {
        setProgress((prev) => ({ ...prev, loading: false, phase: 'ready' }))
      }
    })

    return () => {
      cancelled = true
    }
  }, [myPubkey, refreshNonce, seedCount])

  // Targeted fetch for "Find Similar Voices" target when not already in our crawled follows map
  useEffect(() => {
    if (!similarToPubkey || !isHex64(similarToPubkey)) return
    const target = similarToPubkey.toLowerCase()
    if (snapshot?.followsBySeed[target] && snapshot.followsBySeed[target].length > 0) return
    if (similarMetaByPk[target]) return
    const inFlight = similarInFlightRef.current
    if (inFlight.has(target)) return

    inFlight.add(target)
    const relays = Array.from(new Set([...agoraRef.current.socialRelays, ...AGORA_SOCIAL_RELAYS])).slice(
      0,
      8
    )

    let bestFollowEv: NostrEvent | null = null
    const interacted = new Set<string>()
    let cancelled = false

    const { promise, cancel } = agoraRef.current.queryRelaysOneShot(
      'wot-similar',
      relays,
      [
        { kinds: [KIND_AGORA_FOLLOW_LIST], authors: [target], limit: 2 },
        { kinds: [KIND_AGORA_REPOST, KIND_AGORA_NOTE], authors: [target], limit: 35 },
      ],
      {
        timeoutMs: 3600,
        targetEose: Math.min(2, relays.length),
        onEvent: (ev) => {
          if (!verifyEventCached(ev)) return
          if (ev.pubkey.toLowerCase() !== target) return
          if (ev.kind === KIND_AGORA_FOLLOW_LIST) {
            if (!bestFollowEv || ev.created_at > bestFollowEv.created_at) {
              bestFollowEv = ev
            }
          } else if (ev.kind === KIND_AGORA_REPOST) {
            const rp = parseAgoraRepost(ev)
            const targetAuthor = rp?.embeddedNote?.pubkey ?? rp?.targetAuthorPubkey
            if (targetAuthor && isHex64(targetAuthor)) interacted.add(targetAuthor.toLowerCase())
          } else if (ev.kind === KIND_AGORA_NOTE) {
            const note = parseAgoraNote(ev)
            if (note) {
              for (const mp of note.mentionedPubkeys) {
                if (isHex64(mp)) interacted.add(mp.toLowerCase())
              }
            }
          }
        },
      }
    )

    void promise.then(() => {
      inFlight.delete(target)
      if (cancelled) return
      const follows = bestFollowEv ? parseFollowList(bestFollowEv)?.pubkeys ?? [] : []
      setSimilarMetaByPk((prev) => ({
        ...prev,
        [target]: {
          follows,
          interacted: Array.from(interacted),
        },
      }))
    })

    return () => {
      cancelled = true
      cancel()
      inFlight.delete(target)
    }
  }, [similarToPubkey, snapshot, similarMetaByPk])

  // Synthesize a baseline empty snapshot from live Agora cache if crawl hasn't finished yet
  const effectiveSnapshot = useMemo<WotRawSnapshot>(() => {
    if (snapshot) return snapshot
    return {
      myPubkey,
      fetchedAt: 0,
      seeds: seedSummary.seeds,
      followsBySeed: {},
      mutesBySeed: {},
      reposts: [],
      zaps: [],
      articles: Object.values(agora.articlesById),
      followPacks: [],
      candidateNotesByPubkey: {},
      poolNotes: Object.values(agora.notesById).filter((n) => !n.isReply).slice(0, 60),
    }
  }, [snapshot, myPubkey, seedSummary.seeds, agora.articlesById, agora.notesById])

  // Pure in-memory WoT scoring & anti-slop evaluation
  const scored = useMemo(
    () =>
      scoreWotGraphSnapshot({
        snapshot: effectiveSnapshot,
        myPubkey,
        followingSet,
        trustedSet,
        blockedSet,
        dismissedSet,
        profilesByPubkey: agora.profilesByPubkey,
        nip05StatusByPubkey: agora.nip05StatusByPubkey,
        statsByNoteId: agora.statsByNoteId,
        extraNotesById: agora.notesById,
        extraArticlesById: agora.articlesById,
        prefs,
        isColdStart,
      }),
    [
      effectiveSnapshot,
      myPubkey,
      followingSet,
      trustedSet,
      blockedSet,
      dismissedSet,
      agora.profilesByPubkey,
      agora.nip05StatusByPubkey,
      agora.statsByNoteId,
      agora.notesById,
      agora.articlesById,
      prefs,
      isColdStart,
    ]
  )

  // Compute Similar Voices whenever `similarToPubkey` is active
  const similarAccounts = useMemo(() => {
    if (!similarToPubkey || !isHex64(similarToPubkey)) return []
    const target = similarToPubkey.toLowerCase()
    const fetchedMeta = similarMetaByPk[target]
    const targetFollows =
      effectiveSnapshot.followsBySeed[target] ??
      fetchedMeta?.follows ??
      (target === myPubkey ? agora.followingPubkeys : [])
    const targetInteracted = fetchedMeta?.interacted ?? []

    const articlesByPubkey: Record<string, AgoraArticle> = {}
    for (const art of [...effectiveSnapshot.articles, ...Object.values(agora.articlesById)]) {
      const prev = articlesByPubkey[art.pubkey]
      if (!prev || art.publishedAt > prev.publishedAt) {
        articlesByPubkey[art.pubkey] = art
      }
    }

    return computeSimilarVoices({
      targetPubkey: target,
      targetFollows,
      targetInteractedPubkeys: targetInteracted,
      followsBySeed: effectiveSnapshot.followsBySeed,
      candidateAccounts: scored.accounts,
      myPubkey,
      blockedSet,
      dismissedSet,
      trustedSet,
      profilesByPubkey: agora.profilesByPubkey,
      nip05StatusByPubkey: agora.nip05StatusByPubkey,
      candidateNotesByPubkey: effectiveSnapshot.candidateNotesByPubkey,
      articlesByPubkey,
      statsByNoteId: agora.statsByNoteId,
      mutedByCountMap: scored.mutedByCountMap,
    })
  }, [
    similarToPubkey,
    similarMetaByPk,
    effectiveSnapshot,
    myPubkey,
    agora.followingPubkeys,
    agora.articlesById,
    agora.profilesByPubkey,
    agora.nip05StatusByPubkey,
    agora.statsByNoteId,
    scored.accounts,
    scored.mutedByCountMap,
    blockedSet,
    dismissedSet,
    trustedSet,
  ])

  // Proactively resolve profiles & verify NIP-05 badges for visible discovered accounts, endorsers, packs & notes
  useEffect(() => {
    const pks = new Set<string>()
    for (const acc of scored.accounts.slice(0, 36)) {
      pks.add(acc.pubkey)
      for (const e of acc.endorsers.slice(0, 4)) pks.add(e)
    }
    for (const sim of similarAccounts.slice(0, 20)) {
      pks.add(sim.pubkey)
      for (const e of sim.endorsers.slice(0, 3)) pks.add(e)
    }
    for (const note of scored.highSignalNotes.slice(0, 30)) {
      pks.add(note.note.pubkey)
    }
    for (const pack of scored.followPacks.slice(0, 12)) {
      pks.add(pack.pubkey)
      for (const m of pack.memberPubkeys.slice(0, 12)) pks.add(m)
    }
    for (const node of scored.graphNodes) {
      pks.add(node.pubkey)
    }
    if (similarToPubkey && isHex64(similarToPubkey)) {
      pks.add(similarToPubkey.toLowerCase())
    }

    if (pks.size > 0) {
      agoraRef.current.ensureProfiles(Array.from(pks))
    }

    // Trigger real NIP-05 verification for discovered profiles that advertise a NIP-05 handle
    for (const pk of pks) {
      const prof = agoraRef.current.profilesByPubkey[pk]
      if (!prof?.nip05) continue
      const key = `${pk}:${prof.nip05.trim().toLowerCase()}`
      if (nip05RequestedRef.current.has(key)) continue
      nip05RequestedRef.current.add(key)
      agoraRef.current.ensureNip05Verified(pk, prof.nip05)
    }
  }, [
    scored.accounts,
    scored.highSignalNotes,
    scored.followPacks,
    scored.graphNodes,
    similarAccounts,
    similarToPubkey,
    agora.profilesByPubkey,
  ])

  // User preference setters (persisted immediately)
  const setReach = useCallback((reach: WotReachMode) => {
    setPrefs((prev) => {
      if (prev.reach === reach) return prev
      const next: DiscoveryPrefs = { ...prev, reach }
      saveDiscoveryPrefs(next)
      return next
    })
  }, [])

  const setAntiSlop = useCallback((antiSlop: AntiSlopMode) => {
    setPrefs((prev) => {
      if (prev.antiSlop === antiSlop) return prev
      const next: DiscoveryPrefs = { ...prev, antiSlop }
      saveDiscoveryPrefs(next)
      return next
    })
  }, [])

  const setTopic = useCallback((topic: DiscoveryTopicId) => {
    setPrefs((prev) => {
      if (prev.topic === topic) return prev
      const next: DiscoveryPrefs = { ...prev, topic }
      saveDiscoveryPrefs(next)
      return next
    })
  }, [])

  const setSimilarToPubkey = useCallback((pk: string | null) => {
    if (!pk || !isHex64(pk)) {
      setSimilarToPubkeyState(null)
      return
    }
    setSimilarToPubkeyState(pk.toLowerCase())
  }, [])

  const dismissAccount = useCallback((pubkey: string) => {
    if (!isHex64(pubkey)) return
    const lower = pubkey.toLowerCase()
    setDismissedPubkeys((prev) => {
      if (prev.includes(lower)) return prev
      const next = [lower, ...prev].slice(0, 400)
      saveDismissedPubkeys(next)
      return next
    })
  }, [])

  const clearDismissed = useCallback(() => {
    setDismissedPubkeys((prev) => {
      if (prev.length === 0) return prev
      saveDismissedPubkeys([])
      return []
    })
  }, [])

  const refreshGraph = useCallback(() => {
    setRefreshNonce((n) => n + 1)
  }, [])

  const followMultiple = useCallback(
    async (pubkeys: string[]): Promise<number> => {
      const targets = Array.from(
        new Set(
          pubkeys
            .filter((pk) => isHex64(pk))
            .map((pk) => pk.toLowerCase())
            .filter(
              (pk) =>
                pk !== myPubkey &&
                !blockedSetRef.current.has(pk) &&
                !agoraRef.current.isFollowing(pk)
            )
        )
      ).slice(0, 25)

      let followed = 0
      for (const pk of targets) {
        const ok = await agoraRef.current.toggleFollow(pk)
        if (ok) followed += 1
      }
      return followed
    },
    [myPubkey]
  )

  const savePackAsCustomList = useCallback(
    async (pack: FollowPack, selectedPubkeys?: string[]): Promise<boolean> => {
      const members =
        selectedPubkeys && selectedPubkeys.length > 0 ? selectedPubkeys : pack.memberPubkeys
      const cleanMembers = Array.from(
        new Set(members.filter((pk) => isHex64(pk)).map((pk) => pk.toLowerCase()))
      )
      if (cleanMembers.length === 0) return false
      const created = await agoraRef.current.createCustomList(
        pack.title,
        cleanMembers,
        pack.description
      )
      return Boolean(created)
    },
    []
  )

  return useMemo<AgoraDiscoveryController>(
    () => ({
      progress,
      isColdStart,
      seedCount,
      lens,
      setLens,
      prefs,
      setReach,
      setAntiSlop,
      setTopic,
      similarToPubkey,
      setSimilarToPubkey,
      accounts: scored.accounts,
      similarAccounts,
      highSignalNotes: scored.highSignalNotes,
      filteredSlopCount: scored.filteredSlopCount,
      followPacks: scored.followPacks,
      graphNodes: scored.graphNodes,
      graphEdges: scored.graphEdges,
      dismissedCount: dismissedPubkeys.length,
      dismissAccount,
      clearDismissed,
      refreshGraph,
      followMultiple,
      savePackAsCustomList,
    }),
    [
      progress,
      isColdStart,
      seedCount,
      lens,
      prefs,
      setReach,
      setAntiSlop,
      setTopic,
      similarToPubkey,
      setSimilarToPubkey,
      scored.accounts,
      similarAccounts,
      scored.highSignalNotes,
      scored.filteredSlopCount,
      scored.followPacks,
      scored.graphNodes,
      scored.graphEdges,
      dismissedPubkeys.length,
      dismissAccount,
      clearDismissed,
      refreshGraph,
      followMultiple,
      savePackAsCustomList,
    ]
  )
}
