import type { Event as NostrEvent, Filter } from 'nostr-tools'
import type {
  AgoraArticle,
  AgoraEngine,
  AgoraNip05Status,
  AgoraNote,
  AgoraNoteStats,
  AgoraProfile,
} from '../../types/agora.ts'
import {
  AGORA_SOCIAL_RELAYS,
  KIND_AGORA_FOLLOW_LIST,
  KIND_AGORA_NOTE,
  KIND_AGORA_REPOST,
  KIND_AGORA_ZAP_RECEIPT,
  isHex64,
  parseAgoraNote,
  parseAgoraRepost,
  parseFollowList,
  parseZapReceipt,
  sanitizeHttpUrl,
} from '../../lib/agoraProtocol.ts'
import {
  KIND_AGORA_ARTICLE,
  KIND_AGORA_MUTE_LIST,
  KIND_AGORA_PEOPLE_LIST,
  parseAgoraArticle,
  parseMuteList,
} from '../../lib/agoraExtras.ts'
import { verifyEventCached } from '../../lib/bitchatProtocol.ts'
import {
  assessAccountQuality,
  assessNoteSlop,
  inferTopicsFromText,
} from './antiSlopScorer.ts'
import type {
  DiscoveredAccount,
  DiscoveredNote,
  DiscoveryPrefs,
  DiscoveryProgress,
  DiscoveryTopicId,
  FollowPack,
  WotGraphEdge,
  WotGraphNode,
} from './types.ts'

export const KIND_FOLLOW_PACK = 39089

export const AGORA_WOT_CACHE_KEY = 'agnostr:v1:agora_wot_cache'
export const AGORA_WOT_DISMISSED_KEY = 'agnostr:v1:agora_wot_dismissed'
export const AGORA_WOT_PREFS_KEY = 'agnostr:v1:agora_wot_prefs'

export const WOT_CACHE_TTL_MS = 12 * 3600 * 1000
const MAX_SEEDS = 60
const MAX_SAMPLE_CANDIDATES = 25
const MAX_DISCOVERED_ACCOUNTS = 48
const MAX_HIGH_SIGNAL_NOTES = 40
const MAX_GRAPH_HOP1 = 16
const MAX_GRAPH_HOP2 = 20

export const DEFAULT_DISCOVERY_PREFS: DiscoveryPrefs = {
  reach: 'network',
  antiSlop: 'balanced',
  topic: 'all',
}

export interface WotSeedEntry {
  pubkey: string
  role: 'trusted' | 'following' | 'local'
  weight: number
}

export interface WotRepostSignal {
  seedPubkey: string
  noteId: string
  authorPubkey: string
  createdAt: number
}

export interface WotZapSignal {
  id: string
  senderPubkey?: string
  recipientPubkey: string
  targetEventId?: string
  amountSats: number
  createdAt: number
}

export interface WotRawSnapshot {
  myPubkey: string
  fetchedAt: number
  seeds: WotSeedEntry[]
  followsBySeed: Record<string, string[]>
  mutesBySeed: Record<string, string[]>
  reposts: WotRepostSignal[]
  zaps: WotZapSignal[]
  articles: AgoraArticle[]
  followPacks: FollowPack[]
  candidateNotesByPubkey: Record<string, AgoraNote[]>
  poolNotes: AgoraNote[]
}

interface StoredWotCachePayload {
  version: 1
  myPubkey: string
  fetchedAt: number
  seeds: WotSeedEntry[]
  followsBySeed: Record<string, string[]>
  mutesBySeed: Record<string, string[]>
  reposts: WotRepostSignal[]
  zaps: WotZapSignal[]
  articleEvents: NostrEvent[]
  followPacks: FollowPack[]
  candidateNoteEvents: NostrEvent[]
  poolNoteEvents: NostrEvent[]
}

function safeGetStorage(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetStorage(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  } catch {
    // Ignore quota or storage restriction errors
  }
}

function safeRemoveStorage(key: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(key)
  } catch {
    // Ignore
  }
}

export function clearWotDiscoveryStorage(): void {
  safeRemoveStorage(AGORA_WOT_CACHE_KEY)
  safeRemoveStorage(AGORA_WOT_DISMISSED_KEY)
  safeRemoveStorage(AGORA_WOT_PREFS_KEY)
}

export function loadDiscoveryPrefs(): DiscoveryPrefs {
  const raw = safeGetStorage(AGORA_WOT_PREFS_KEY)
  if (!raw) return DEFAULT_DISCOVERY_PREFS
  try {
    const parsed = JSON.parse(raw) as Partial<DiscoveryPrefs>
    const reach =
      parsed.reach === 'strict' || parsed.reach === 'network' || parsed.reach === 'wide'
        ? parsed.reach
        : DEFAULT_DISCOVERY_PREFS.reach
    const antiSlop =
      parsed.antiSlop === 'strict' || parsed.antiSlop === 'balanced' || parsed.antiSlop === 'off'
        ? parsed.antiSlop
        : DEFAULT_DISCOVERY_PREFS.antiSlop
    const validTopics: ReadonlySet<string> = new Set([
      'all',
      'nostr',
      'bitcoin',
      'privacy',
      'dev',
      'art',
      'writing',
    ])
    const topic =
      typeof parsed.topic === 'string' && validTopics.has(parsed.topic)
        ? (parsed.topic as DiscoveryTopicId)
        : DEFAULT_DISCOVERY_PREFS.topic
    return { reach, antiSlop, topic }
  } catch {
    return DEFAULT_DISCOVERY_PREFS
  }
}

export function saveDiscoveryPrefs(prefs: DiscoveryPrefs): void {
  safeSetStorage(AGORA_WOT_PREFS_KEY, JSON.stringify(prefs))
}

export function loadDismissedPubkeys(): string[] {
  const raw = safeGetStorage(AGORA_WOT_DISMISSED_KEY)
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of arr) {
      if (typeof item === 'string' && isHex64(item)) {
        const lower = item.toLowerCase()
        if (!seen.has(lower)) {
          seen.add(lower)
          out.push(lower)
        }
      }
      if (out.length >= 400) break
    }
    return out
  } catch {
    return []
  }
}

export function saveDismissedPubkeys(pubkeys: readonly string[]): void {
  const clean = Array.from(
    new Set(pubkeys.filter((pk) => isHex64(pk)).map((pk) => pk.toLowerCase()))
  ).slice(0, 400)
  safeSetStorage(AGORA_WOT_DISMISSED_KEY, JSON.stringify(clean))
}

export function loadCachedWotSnapshot(myPubkey: string): WotRawSnapshot | null {
  const raw = safeGetStorage(AGORA_WOT_CACHE_KEY)
  if (!raw || !isHex64(myPubkey)) return null
  const lowerMe = myPubkey.toLowerCase()
  try {
    const parsed = JSON.parse(raw) as Partial<StoredWotCachePayload>
    if (
      parsed.version !== 1 ||
      parsed.myPubkey !== lowerMe ||
      typeof parsed.fetchedAt !== 'number' ||
      Date.now() - parsed.fetchedAt > WOT_CACHE_TTL_MS
    ) {
      return null
    }
    const articles: AgoraArticle[] = []
    if (Array.isArray(parsed.articleEvents)) {
      for (const ev of parsed.articleEvents) {
        const art = parseAgoraArticle(ev)
        if (art) articles.push(art)
      }
    }
    const candidateNotesByPubkey: Record<string, AgoraNote[]> = {}
    if (Array.isArray(parsed.candidateNoteEvents)) {
      for (const ev of parsed.candidateNoteEvents) {
        const note = parseAgoraNote(ev)
        if (!note) continue
        const bucket = candidateNotesByPubkey[note.pubkey]
        if (bucket) bucket.push(note)
        else candidateNotesByPubkey[note.pubkey] = [note]
      }
    }
    const poolNotes: AgoraNote[] = []
    if (Array.isArray(parsed.poolNoteEvents)) {
      for (const ev of parsed.poolNoteEvents) {
        const note = parseAgoraNote(ev)
        if (note) poolNotes.push(note)
      }
    }
    return {
      myPubkey: lowerMe,
      fetchedAt: parsed.fetchedAt,
      seeds: Array.isArray(parsed.seeds) ? parsed.seeds : [],
      followsBySeed:
        parsed.followsBySeed && typeof parsed.followsBySeed === 'object'
          ? parsed.followsBySeed
          : {},
      mutesBySeed:
        parsed.mutesBySeed && typeof parsed.mutesBySeed === 'object' ? parsed.mutesBySeed : {},
      reposts: Array.isArray(parsed.reposts) ? parsed.reposts : [],
      zaps: Array.isArray(parsed.zaps) ? parsed.zaps : [],
      articles,
      followPacks: Array.isArray(parsed.followPacks) ? parsed.followPacks : [],
      candidateNotesByPubkey,
      poolNotes,
    }
  } catch {
    return null
  }
}

export function saveCachedWotSnapshot(snapshot: WotRawSnapshot): void {
  const candidateNoteEvents: NostrEvent[] = []
  const seenIds = new Set<string>()
  for (const notes of Object.values(snapshot.candidateNotesByPubkey)) {
    for (const n of notes.slice(0, 3)) {
      if (seenIds.has(n.id)) continue
      seenIds.add(n.id)
      candidateNoteEvents.push(n.rawEvent)
      if (candidateNoteEvents.length >= 90) break
    }
    if (candidateNoteEvents.length >= 90) break
  }

  const poolNoteEvents: NostrEvent[] = []
  for (const n of snapshot.poolNotes.slice(0, 60)) {
    if (seenIds.has(n.id)) continue
    seenIds.add(n.id)
    poolNoteEvents.push(n.rawEvent)
  }

  const compactFollows: Record<string, string[]> = {}
  for (const [seedPk, list] of Object.entries(snapshot.followsBySeed)) {
    compactFollows[seedPk] = list.slice(0, 350)
  }

  const payload: StoredWotCachePayload = {
    version: 1,
    myPubkey: snapshot.myPubkey,
    fetchedAt: snapshot.fetchedAt,
    seeds: snapshot.seeds.slice(0, MAX_SEEDS),
    followsBySeed: compactFollows,
    mutesBySeed: snapshot.mutesBySeed,
    reposts: snapshot.reposts.slice(0, 120),
    zaps: snapshot.zaps.slice(0, 140),
    articleEvents: snapshot.articles.slice(0, 25).map((a) => a.rawEvent),
    followPacks: snapshot.followPacks.slice(0, 20),
    candidateNoteEvents,
    poolNoteEvents,
  }
  safeSetStorage(AGORA_WOT_CACHE_KEY, JSON.stringify(payload))
}

/**
 * Builds the weighted 1-hop seed list:
 * - Trusted peers: 3.0×
 * - Followed accounts: 1.0×
 * - Local Bitchat / DM peers: 0.5×
 */
export function buildSeedGraph(params: {
  myPubkey: string
  trustedPubkeys: readonly string[]
  followingPubkeys: readonly string[]
  localPeerPubkeys: readonly string[]
  blockedSet: ReadonlySet<string>
}): { seeds: WotSeedEntry[]; isColdStart: boolean } {
  const me = params.myPubkey.toLowerCase()
  const byPk = new Map<string, WotSeedEntry>()

  const upsert = (raw: string, role: WotSeedEntry['role'], weight: number) => {
    if (!isHex64(raw)) return
    const pk = raw.toLowerCase()
    if (pk === me || params.blockedSet.has(pk)) return
    const existing = byPk.get(pk)
    if (!existing || weight > existing.weight) {
      byPk.set(pk, { pubkey: pk, role, weight })
    }
  }

  for (const pk of params.trustedPubkeys) upsert(pk, 'trusted', 3.0)
  for (const pk of params.followingPubkeys) upsert(pk, 'following', 1.0)
  for (const pk of params.localPeerPubkeys) upsert(pk, 'local', 0.5)

  const strongSeedCount = Array.from(byPk.values()).filter(
    (s) => s.role === 'trusted' || s.role === 'following'
  ).length

  const seeds = Array.from(byPk.values())
    .sort((a, b) => b.weight - a.weight || a.pubkey.localeCompare(b.pubkey))
    .slice(0, MAX_SEEDS)

  return {
    seeds,
    isColdStart: strongSeedCount < 3,
  }
}

/**
 * Inverse-log normalized endorsement weight:
 * a discerning peer following 50 people carries far higher per-endorsement weight
 * than a bot or follow-farm following 5,000 accounts.
 */
export function computeSeedEndorsementWeight(seedWeight: number, seedFollowCount: number): number {
  const safeCount = Number.isFinite(seedFollowCount) && seedFollowCount > 0 ? seedFollowCount : 0
  return seedWeight / Math.log2(safeCount + 2)
}

/**
 * Parses NIP-51 Follow Packs (`kind: 39089`) and public People Lists (`kind: 30000`)
 * with >= 2 valid member pubkeys (strictly HTTPS cover images).
 */
export function parseFollowPack(
  event: NostrEvent,
  seedSet: ReadonlySet<string>
): FollowPack | null {
  if (
    !event ||
    (event.kind !== KIND_FOLLOW_PACK && event.kind !== KIND_AGORA_PEOPLE_LIST) ||
    !isHex64(event.id) ||
    !isHex64(event.pubkey) ||
    !Array.isArray(event.tags)
  ) {
    return null
  }

  let dTag = ''
  let title = ''
  let description: string | undefined
  let image: string | undefined
  const memberPubkeys: string[] = []
  const seenMembers = new Set<string>()

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length < 2) continue
    const [name, val] = tag
    if (typeof val !== 'string') continue
    if (name === 'd' && !dTag) {
      dTag = val.trim().slice(0, 120)
    } else if ((name === 'title' || name === 'name') && !title) {
      title = val.trim().slice(0, 90)
    } else if (name === 'description' && !description) {
      const cleanDesc = val.trim().slice(0, 260)
      if (cleanDesc) description = cleanDesc
    } else if (name === 'image' && !image) {
      const cleanImg = sanitizeHttpUrl(val)
      if (cleanImg && cleanImg.startsWith('https://')) {
        image = cleanImg
      }
    } else if (name === 'p' && isHex64(val)) {
      const pk = val.toLowerCase()
      if (!seenMembers.has(pk)) {
        seenMembers.add(pk)
        memberPubkeys.push(pk)
      }
    }
  }

  const minMembers = event.kind === KIND_FOLLOW_PACK ? 2 : 3
  if (!dTag || memberPubkeys.length < minMembers) return null
  const finalTitle = title || dTag.replace(/[-_]+/g, ' ').trim()
  if (!finalTitle) return null

  const authorPk = event.pubkey.toLowerCase()
  let wotOverlapCount = seedSet.has(authorPk) ? 1 : 0
  for (const pk of memberPubkeys) {
    if (seedSet.has(pk)) wotOverlapCount += 1
  }

  return {
    id: event.id.toLowerCase(),
    dTag,
    pubkey: authorPk,
    title: finalTitle,
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    memberPubkeys: memberPubkeys.slice(0, 120),
    wotOverlapCount,
    createdAt: Number.isFinite(event.created_at) ? event.created_at : 0,
  }
}

function formatShortActor(pubkey: string, profilesByPubkey: Record<string, AgoraProfile>): string {
  const prof = profilesByPubkey[pubkey.toLowerCase()]
  const label = prof?.displayName?.trim() || prof?.name?.trim()
  if (label) return `@${label.slice(0, 24)}`
  return `@${pubkey.slice(0, 8)}`
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

export interface ScoredWotResult {
  accounts: DiscoveredAccount[]
  highSignalNotes: DiscoveredNote[]
  filteredSlopCount: number
  followPacks: FollowPack[]
  graphNodes: WotGraphNode[]
  graphEdges: WotGraphEdge[]
  mutedByCountMap: Record<string, number>
}

export interface ScoreWotGraphContext {
  snapshot: WotRawSnapshot
  myPubkey: string
  followingSet: ReadonlySet<string>
  trustedSet: ReadonlySet<string>
  blockedSet: ReadonlySet<string>
  dismissedSet: ReadonlySet<string>
  profilesByPubkey: Record<string, AgoraProfile>
  nip05StatusByPubkey: Record<string, AgoraNip05Status>
  statsByNoteId: Record<string, AgoraNoteStats>
  extraNotesById?: Record<string, AgoraNote>
  extraArticlesById?: Record<string, AgoraArticle>
  prefs: DiscoveryPrefs
  isColdStart: boolean
}

/**
 * Pure, deterministic WoT graph ranker + anti-slop filter + 2-hop graph builder.
 * Changing Reach, Anti-Slop, Topic, Follows, or Dismissals re-scores cleanly in memory.
 */
export function scoreWotGraphSnapshot(ctx: ScoreWotGraphContext): ScoredWotResult {
  const {
    snapshot,
    followingSet,
    trustedSet,
    blockedSet,
    dismissedSet,
    profilesByPubkey,
    nip05StatusByPubkey,
    statsByNoteId,
    prefs,
    isColdStart,
  } = ctx
  const me = ctx.myPubkey.toLowerCase()

  const seedByPk = new Map<string, WotSeedEntry>()
  for (const s of snapshot.seeds) {
    if (blockedSet.has(s.pubkey) || s.pubkey === me) continue
    seedByPk.set(s.pubkey, s)
  }

  // Merge articles from snapshot + Agora cache
  const articlesByPubkey = new Map<string, AgoraArticle>()
  const allArticles: AgoraArticle[] = [
    ...snapshot.articles,
    ...(ctx.extraArticlesById ? Object.values(ctx.extraArticlesById) : []),
  ]
  for (const art of allArticles) {
    if (blockedSet.has(art.pubkey)) continue
    const prev = articlesByPubkey.get(art.pubkey)
    if (!prev || art.publishedAt > prev.publishedAt) {
      articlesByPubkey.set(art.pubkey, art)
    }
  }

  // Merge notes from snapshot + Agora cache
  const noteById = new Map<string, AgoraNote>()
  const notesByAuthor = new Map<string, AgoraNote[]>()
  const pushNote = (note: AgoraNote) => {
    if (blockedSet.has(note.pubkey)) return
    if (noteById.has(note.id)) return
    noteById.set(note.id, note)
    if (!note.isReply) {
      const list = notesByAuthor.get(note.pubkey)
      if (list) list.push(note)
      else notesByAuthor.set(note.pubkey, [note])
    }
  }
  for (const list of Object.values(snapshot.candidateNotesByPubkey)) {
    for (const n of list) pushNote(n)
  }
  for (const n of snapshot.poolNotes) pushNote(n)
  if (ctx.extraNotesById) {
    for (const n of Object.values(ctx.extraNotesById)) pushNote(n)
  }

  // 1. Accumulate 2-hop endorsements, negative WoT mutes, costly zap/repost signals & pack membership
  interface CandidateAccum {
    pubkey: string
    endorsers: Map<string, { weight: number; seed: WotSeedEntry }>
    zappers: Set<string>
    wotZappers: Set<string>
    reposters: Set<string>
    wotReposters: Set<string>
    mutedBy: Set<string>
    packCount: number
  }
  const accumByPk = new Map<string, CandidateAccum>()
  const getOrCreate = (pk: string): CandidateAccum | null => {
    if (!isHex64(pk)) return null
    const lower = pk.toLowerCase()
    if (lower === me || blockedSet.has(lower)) return null
    let acc = accumByPk.get(lower)
    if (!acc) {
      acc = {
        pubkey: lower,
        endorsers: new Map(),
        zappers: new Set(),
        wotZappers: new Set(),
        reposters: new Set(),
        wotReposters: new Set(),
        mutedBy: new Set(),
        packCount: 0,
      }
      accumByPk.set(lower, acc)
    }
    return acc
  }

  // 2-hop follow endorsements with inverse-log normalization
  for (const [seedPk, follows] of Object.entries(snapshot.followsBySeed)) {
    const seed = seedByPk.get(seedPk)
    if (!seed || !Array.isArray(follows) || follows.length === 0) continue
    const edgeWeight = computeSeedEndorsementWeight(seed.weight, follows.length)
    for (const targetPk of follows) {
      const acc = getOrCreate(targetPk)
      if (!acc) continue
      const prev = acc.endorsers.get(seedPk)
      if (!prev || edgeWeight > prev.weight) {
        acc.endorsers.set(seedPk, { weight: edgeWeight, seed })
      }
    }
  }

  // Negative WoT: seed mute lists (kind: 10000)
  const mutedByCountMap: Record<string, number> = {}
  for (const [seedPk, mutedPks] of Object.entries(snapshot.mutesBySeed)) {
    if (!seedByPk.has(seedPk) || !Array.isArray(mutedPks)) continue
    for (const mutedPk of mutedPks) {
      if (!isHex64(mutedPk)) continue
      const lower = mutedPk.toLowerCase()
      const acc = getOrCreate(lower)
      if (acc) {
        acc.mutedBy.add(seedPk)
        mutedByCountMap[lower] = acc.mutedBy.size
      }
    }
  }

  // Costly signal: reposts (kind: 6)
  const repostersByNoteId = new Map<string, Set<string>>()
  for (const rp of snapshot.reposts) {
    if (blockedSet.has(rp.seedPubkey) || blockedSet.has(rp.authorPubkey)) continue
    let noteSet = repostersByNoteId.get(rp.noteId)
    if (!noteSet) {
      noteSet = new Set()
      repostersByNoteId.set(rp.noteId, noteSet)
    }
    if (seedByPk.has(rp.seedPubkey) || rp.seedPubkey === me) {
      noteSet.add(rp.seedPubkey)
    }
    const acc = getOrCreate(rp.authorPubkey)
    if (acc) {
      acc.reposters.add(rp.seedPubkey)
      if (seedByPk.has(rp.seedPubkey)) acc.wotReposters.add(rp.seedPubkey)
    }
  }

  // Costly signal: zap receipts (kind: 9735) — unique zapper diversity
  const zappersByNoteId = new Map<string, Set<string>>()
  for (const zap of snapshot.zaps) {
    if (zap.senderPubkey && blockedSet.has(zap.senderPubkey)) continue
    if (blockedSet.has(zap.recipientPubkey)) continue
    const senderKey = zap.senderPubkey ?? `anon:${zap.id}`
    if (zap.targetEventId) {
      let noteZappers = zappersByNoteId.get(zap.targetEventId)
      if (!noteZappers) {
        noteZappers = new Set()
        zappersByNoteId.set(zap.targetEventId, noteZappers)
      }
      noteZappers.add(senderKey)
    }
    const acc = getOrCreate(zap.recipientPubkey)
    if (acc) {
      acc.zappers.add(senderKey)
      if (zap.senderPubkey && seedByPk.has(zap.senderPubkey)) {
        acc.wotZappers.add(zap.senderPubkey)
      }
    }
  }

  // Long-form writers (kind: 30023)
  for (const art of articlesByPubkey.values()) {
    getOrCreate(art.pubkey)
  }

  // Follow Pack members (kind: 39089 / 30000)
  const activeSeedIds = new Set<string>([...seedByPk.keys(), ...followingSet, ...trustedSet])
  const validPacks: FollowPack[] = []
  const seenPackCoord = new Set<string>()
  for (const pack of snapshot.followPacks) {
    if (blockedSet.has(pack.pubkey)) continue
    const coord = `${pack.pubkey}:${pack.dTag}`
    if (seenPackCoord.has(coord)) continue
    seenPackCoord.add(coord)

    const cleanMembers = pack.memberPubkeys.filter((pk) => pk !== me && !blockedSet.has(pk))
    if (cleanMembers.length < 2) continue
    let overlap = activeSeedIds.has(pack.pubkey) ? 1 : 0
    for (const pk of cleanMembers) {
      if (activeSeedIds.has(pk)) overlap += 1
      const acc = getOrCreate(pk)
      if (acc) acc.packCount += 1
    }
    validPacks.push({
      ...pack,
      memberPubkeys: cleanMembers,
      wotOverlapCount: overlap,
    })
  }
  validPacks.sort((a, b) => b.wotOverlapCount - a.wotOverlapCount || b.createdAt - a.createdAt)

  // Cold-start fallback: also consider recent pool note authors
  if (isColdStart || prefs.reach === 'wide') {
    for (const pk of notesByAuthor.keys()) {
      getOrCreate(pk)
    }
  }

  // 2. Score & filter candidate accounts
  let filteredSlopCount = 0
  const scoredAccounts: DiscoveredAccount[] = []

  for (const acc of accumByPk.values()) {
    if (followingSet.has(acc.pubkey) || dismissedSet.has(acc.pubkey)) continue

    const orderedEndorsers = Array.from(acc.endorsers.values()).sort(
      (a, b) => b.seed.weight - a.seed.weight || b.weight - a.weight
    )
    const endorsers = orderedEndorsers.map((e) => e.seed.pubkey)
    const trustedEndorsers = orderedEndorsers
      .filter((e) => e.seed.role === 'trusted' || trustedSet.has(e.seed.pubkey))
      .map((e) => e.seed.pubkey)

    const mutedByCount = acc.mutedBy.size
    const zapperCount = Math.max(acc.wotZappers.size, acc.zappers.size)
    const repostEndorserCount = acc.wotReposters.size > 0 ? acc.wotReposters.size : acc.reposters.size
    const sampleArticle = articlesByPubkey.get(acc.pubkey)
    const isLongFormWriter = Boolean(sampleArticle)
    const isVerifiedNip05 = nip05StatusByPubkey[acc.pubkey] === 'verified'
    const profile = profilesByPubkey[acc.pubkey] ?? null

    // Reach mode gating
    const hasNetworkEndorsement =
      endorsers.length > 0 || acc.wotZappers.size > 0 || acc.wotReposters.size > 0
    if (prefs.reach === 'strict') {
      if (!isColdStart) {
        if (trustedEndorsers.length === 0 && endorsers.length < 2) continue
      } else {
        if (!isLongFormWriter && acc.packCount === 0 && zapperCount === 0 && endorsers.length === 0) {
          continue
        }
      }
    } else if (prefs.reach === 'network') {
      if (!isColdStart) {
        if (!hasNetworkEndorsement && !isLongFormWriter && acc.packCount === 0) continue
      } else {
        if (
          !hasNetworkEndorsement &&
          !isLongFormWriter &&
          acc.packCount === 0 &&
          zapperCount === 0 &&
          (notesByAuthor.get(acc.pubkey)?.length ?? 0) === 0
        ) {
          continue
        }
      }
    }

    // Gather & rank sample notes (picking 1-2 crisp non-slop notes!)
    const authorNotes = (notesByAuthor.get(acc.pubkey) ?? [])
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
    const quality = assessAccountQuality({
      notes: authorNotes,
      profile,
      nip05Verified: isVerifiedNip05,
      hasArticles: isLongFormWriter,
      statsByNoteId,
      mutedByCount,
    })

    // Anti-slop mode gating
    if (prefs.antiSlop === 'strict') {
      if (
        quality.isSlopAccount ||
        quality.qualityScore < 45 ||
        (authorNotes.length >= 2 && quality.slopRate > 0.45) ||
        mutedByCount >= 1
      ) {
        filteredSlopCount += 1
        continue
      }
    } else if (prefs.antiSlop === 'balanced') {
      if (quality.isSlopAccount || mutedByCount >= 2) {
        filteredSlopCount += 1
        continue
      }
    }

    // Select 1-2 highest-craft non-slop sample notes
    const evaluatedNotes = authorNotes.map((note) => ({
      note,
      slop: assessNoteSlop(note, statsByNoteId[note.id]),
    }))
    const sampleNotes = (
      prefs.antiSlop === 'off'
        ? evaluatedNotes
        : evaluatedNotes.filter((item) => !item.slop.isSlop)
    )
      .sort((a, b) => b.slop.qualityScore - a.slop.qualityScore || b.note.createdAt - a.note.createdAt)
      .slice(0, 2)
      .map((item) => item.note)

    // Topic inference & topic filter
    const combinedText = [
      profile?.about ?? '',
      ...sampleNotes.map((n) => n.content),
      sampleArticle ? `${sampleArticle.title} ${sampleArticle.summary ?? ''}` : '',
    ].join('\n')
    const combinedTags = [
      ...sampleNotes.flatMap((n) => n.hashtags),
      ...(sampleArticle?.hashtags ?? []),
    ]
    const topics = inferTopicsFromText(combinedText, combinedTags)
    if (isLongFormWriter && !topics.includes('writing')) {
      topics.push('writing')
    }
    if (prefs.topic !== 'all' && !topics.includes(prefs.topic)) {
      continue
    }

    // Composite WoT score (inverse-log follow sum + costly signal diversity - negative WoT mutes)
    let rawWotScore = 0
    for (const entry of orderedEndorsers) {
      rawWotScore += entry.weight
    }
    rawWotScore += acc.wotZappers.size * 0.45 + Math.min(4, acc.zappers.size) * 0.15
    rawWotScore += acc.wotReposters.size * 0.28 + Math.min(3, acc.reposters.size) * 0.08
    if (isLongFormWriter) rawWotScore += 0.35
    if (acc.packCount > 0) rawWotScore += Math.min(0.45, acc.packCount * 0.2)
    if (mutedByCount > 0) rawWotScore = Math.max(0, rawWotScore - mutedByCount * 1.15)

    // Normalize into clean 0..100 signalScore (62% WoT + 38% Content Quality)
    const wotComponent = 62 * (1 - Math.exp(-rawWotScore * 1.15))
    const qualityComponent = quality.qualityScore * 0.38
    const signalScore = clamp(Math.round(wotComponent + qualityComponent), 1, 99)

    // Build transparent explainability reasons & badges
    const reasons: string[] = []
    if (trustedEndorsers.length > 0) {
      const first = formatShortActor(trustedEndorsers[0], profilesByPubkey)
      const rest = endorsers.length - 1
      reasons.push(
        rest > 0
          ? `Trusted by ${first} + ${rest} ${rest === 1 ? 'other' : 'others'} in your graph`
          : `Followed by trusted peer ${first}`
      )
    } else if (endorsers.length > 0) {
      const topNames = endorsers
        .slice(0, 2)
        .map((pk) => formatShortActor(pk, profilesByPubkey))
      const extra = endorsers.length - topNames.length
      reasons.push(
        extra > 0
          ? `Followed by ${topNames.join(', ')} + ${extra} ${extra === 1 ? 'other' : 'others'}`
          : `Followed by ${topNames.join(' & ')}`
      )
    }
    if (zapperCount > 0) {
      reasons.push(
        `Zapped by ${zapperCount} unique ${zapperCount === 1 ? 'peer' : 'peers'}`
      )
    }
    if (repostEndorserCount > 0) {
      reasons.push(
        `Reposted by ${repostEndorserCount} ${repostEndorserCount === 1 ? 'peer' : 'peers'}`
      )
    }
    if (isLongFormWriter) {
      reasons.push('Publishes NIP-23 long-form articles')
    }
    if (reasons.length === 0 && acc.packCount > 0) {
      reasons.push(
        `Featured in ${acc.packCount} curated Follow ${acc.packCount === 1 ? 'Pack' : 'Packs'}`
      )
    }
    if (reasons.length === 0) {
      reasons.push('High-craft original writing on your relays')
    }

    const badges = [...quality.badges]
    if (trustedEndorsers.length > 0 && !badges.includes('Trusted Overlap')) {
      badges.unshift('Trusted Overlap')
    }
    if (zapperCount >= 2 && !badges.includes(`Zapped by ${zapperCount}`)) {
      badges.push(`Zapped by ${zapperCount}`)
    }

    scoredAccounts.push({
      pubkey: acc.pubkey,
      signalScore,
      wotScore: Number(rawWotScore.toFixed(3)),
      qualityScore: quality.qualityScore,
      endorsers,
      trustedEndorsers,
      zapperCount,
      repostEndorserCount,
      mutedByCount,
      isLongFormWriter,
      isVerifiedNip05,
      reasons: reasons.slice(0, 3),
      badges: badges.slice(0, 4),
      topics,
      sampleNotes,
      ...(sampleArticle ? { sampleArticle } : {}),
    })
  }

  scoredAccounts.sort(
    (a, b) =>
      b.signalScore - a.signalScore ||
      b.trustedEndorsers.length - a.trustedEndorsers.length ||
      b.endorsers.length - a.endorsers.length ||
      b.qualityScore - a.qualityScore
  )
  const topAccounts = scoredAccounts.slice(0, MAX_DISCOVERED_ACCOUNTS)
  const accountByPk = new Map<string, DiscoveredAccount>()
  for (const a of topAccounts) accountByPk.set(a.pubkey, a)

  // 3. Score top-craft notes lens (slop-shielded)
  const highSignalNotes: DiscoveredNote[] = []
  const nowSec = Math.floor(Date.now() / 1000)

  for (const note of noteById.values()) {
    if (note.isReply || blockedSet.has(note.pubkey)) continue
    if (dismissedSet.has(note.pubkey)) continue
    if (nowSec - note.createdAt > 45 * 86400) continue

    const authorAcc = accumByPk.get(note.pubkey)
    const authorMutedCount = authorAcc?.mutedBy.size ?? 0
    if (prefs.antiSlop !== 'off' && authorMutedCount >= 2) {
      filteredSlopCount += 1
      continue
    }

    const stats = statsByNoteId[note.id]
    const slop = assessNoteSlop(note, stats)

    if (prefs.antiSlop === 'strict') {
      if (slop.isSlop || slop.qualityScore < 52) {
        filteredSlopCount += 1
        continue
      }
    } else if (prefs.antiSlop === 'balanced') {
      if (slop.isSlop) {
        filteredSlopCount += 1
        continue
      }
    }

    const zapSet = zappersByNoteId.get(note.id)
    const statZappers = stats?.zapBreakdown?.length ?? (stats?.zapCount ? 1 : 0)
    const wotZappers = Math.max(zapSet?.size ?? 0, statZappers)
    const wotReposters = Math.max(repostersByNoteId.get(note.id)?.size ?? 0, 0)
    const replyCount = stats?.replies ?? 0

    const isSeedAuthor = seedByPk.has(note.pubkey) || followingSet.has(note.pubkey)
    const hasTrustedPath =
      trustedSet.has(note.pubkey) ||
      (accountByPk.get(note.pubkey)?.trustedEndorsers.length ?? 0) > 0
    const isInWot = isSeedAuthor || (authorAcc?.endorsers.size ?? 0) > 0

    if (prefs.reach === 'strict') {
      if (!isColdStart) {
        if (!hasTrustedPath && !isSeedAuthor && wotZappers === 0 && wotReposters === 0) continue
      }
    } else if (prefs.reach === 'network') {
      if (!isColdStart) {
        if (!isInWot && wotZappers === 0 && wotReposters === 0) continue
      }
    }

    if (prefs.topic !== 'all') {
      const noteTopics = inferTopicsFromText(note.content, note.hashtags)
      if (!noteTopics.includes(prefs.topic)) continue
    }

    const ageHours = Math.max(0.5, (nowSec - note.createdAt) / 3600)
    const recencyFactor = 1 / Math.pow(1 + ageHours / 48, 0.35)
    const socialBoost =
      Math.min(28, wotZappers * 9) +
      Math.min(20, wotReposters * 6) +
      Math.min(14, replyCount * 4) +
      (hasTrustedPath ? 8 : isInWot ? 4 : 0)
    const noteSignal = clamp(
      Math.round((slop.qualityScore * 0.52 + socialBoost) * (0.72 + 0.28 * recencyFactor)),
      1,
      99
    )

    const reasons: string[] = []
    if (wotZappers > 0) {
      reasons.push(`Zapped by ${wotZappers} ${wotZappers === 1 ? 'peer' : 'peers'}`)
    }
    if (wotReposters > 0) {
      reasons.push(`Reposted by ${wotReposters} WoT ${wotReposters === 1 ? 'peer' : 'peers'}`)
    }
    if (replyCount > 0) {
      reasons.push(`${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`)
    }
    if (hasTrustedPath) {
      reasons.push('Trusted WoT path')
    } else if (isInWot) {
      reasons.push('2-Hop WoT')
    }
    if (reasons.length === 0) {
      reasons.push('High-craft original post')
    }

    highSignalNotes.push({
      note,
      signalScore: noteSignal,
      wotZappers,
      wotReposters,
      replyCount,
      reasons: reasons.slice(0, 3),
      slop,
    })
  }

  highSignalNotes.sort(
    (a, b) => b.signalScore - a.signalScore || b.note.createdAt - a.note.createdAt
  )

  // 4. Follow Packs (with dynamic real-relay fallback starter packs if relays returned none)
  let followPacks = validPacks.slice(0, 20)
  if (followPacks.length === 0 && topAccounts.length >= 2) {
    const starterMembers = topAccounts.slice(0, 12).map((a) => a.pubkey)
    const fallbackPacks: FollowPack[] = [
      {
        id: `starter:high-signal:${me.slice(0, 8)}`,
        dTag: 'agnostr-high-signal-voices',
        pubkey: me,
        title: 'Curated Relay Voices',
        description:
          'Dynamically assembled from real non-slop accounts active across your connected relays.',
        memberPubkeys: starterMembers,
        wotOverlapCount: topAccounts.filter((a) => a.endorsers.length > 0).length,
        createdAt: nowSec,
        isStarterFallback: true,
      },
    ]
    const writers = topAccounts.filter((a) => a.isLongFormWriter).map((a) => a.pubkey)
    if (writers.length >= 2) {
      fallbackPacks.push({
        id: `starter:writers:${me.slice(0, 8)}`,
        dTag: 'agnostr-longform-writers',
        pubkey: me,
        title: 'Long-Form Nostr Writers',
        description: 'Authors actively publishing NIP-23 long-form essays and guides.',
        memberPubkeys: writers.slice(0, 12),
        wotOverlapCount: topAccounts.filter((a) => a.isLongFormWriter && a.endorsers.length > 0)
          .length,
        createdAt: nowSec,
        isStarterFallback: true,
      })
    }
    followPacks = fallbackPacks
  }

  // 5. Build interactive 2-Hop SVG Graph (`graphNodes` & `graphEdges`)
  const graphCandidates = topAccounts.slice(0, MAX_GRAPH_HOP2)

  // Rank 1-hop seeds by how many top graph candidates they endorse + their own seed weight
  const seedInfluence = new Map<string, number>()
  for (const s of seedByPk.values()) {
    seedInfluence.set(s.pubkey, s.weight * 0.6)
  }
  for (const cand of graphCandidates) {
    for (const endorserPk of cand.endorsers) {
      if (!seedByPk.has(endorserPk)) continue
      seedInfluence.set(endorserPk, (seedInfluence.get(endorserPk) ?? 0) + 1.5)
    }
  }
  const hop1Seeds = Array.from(seedByPk.values())
    .sort(
      (a, b) =>
        (seedInfluence.get(b.pubkey) ?? 0) - (seedInfluence.get(a.pubkey) ?? 0) ||
        b.weight - a.weight
    )
    .slice(0, MAX_GRAPH_HOP1)
  const hop1Set = new Set(hop1Seeds.map((s) => s.pubkey))

  const graphNodes: WotGraphNode[] = [
    {
      pubkey: me,
      role: 'self',
      hop: 0,
      score: 1,
      signalScore: 100,
      endorserCount: 0,
      trustedEndorserCount: 0,
      followCount: followingSet.size,
      isVerifiedNip05: nip05StatusByPubkey[me] === 'verified',
    },
  ]

  const graphEdges: WotGraphEdge[] = []

  for (const seed of hop1Seeds) {
    const followsCount = snapshot.followsBySeed[seed.pubkey]?.length ?? 0
    graphNodes.push({
      pubkey: seed.pubkey,
      role: seed.role,
      hop: 1,
      score: Number((seedInfluence.get(seed.pubkey) ?? seed.weight).toFixed(2)),
      signalScore: seed.role === 'trusted' ? 95 : seed.role === 'following' ? 78 : 62,
      endorserCount: 1,
      trustedEndorserCount: seed.role === 'trusted' ? 1 : 0,
      followCount: followsCount,
      isVerifiedNip05: nip05StatusByPubkey[seed.pubkey] === 'verified',
      isLongFormWriter: articlesByPubkey.has(seed.pubkey),
    })
    graphEdges.push({
      source: me,
      target: seed.pubkey,
      weight: seed.weight,
      kind: seed.role === 'trusted' ? 'trust' : seed.role === 'local' ? 'local' : 'follow',
    })
  }

  for (const cand of graphCandidates) {
    graphNodes.push({
      pubkey: cand.pubkey,
      role: 'candidate',
      hop: 2,
      score: cand.wotScore,
      signalScore: cand.signalScore,
      endorserCount: cand.endorsers.length,
      trustedEndorserCount: cand.trustedEndorsers.length,
      isVerifiedNip05: cand.isVerifiedNip05,
      isLongFormWriter: cand.isLongFormWriter,
      isDismissed: false,
    })

    const candAcc = accumByPk.get(cand.pubkey)
    let addedEdgeCount = 0
    for (const endorserPk of cand.endorsers) {
      if (!hop1Set.has(endorserPk)) continue
      const seed = seedByPk.get(endorserPk)
      if (!seed) continue
      const kind: WotGraphEdge['kind'] =
        seed.role === 'trusted'
          ? 'trust'
          : candAcc?.wotZappers.has(endorserPk)
            ? 'zap'
            : candAcc?.wotReposters.has(endorserPk)
              ? 'repost'
              : 'follow'
      graphEdges.push({
        source: endorserPk,
        target: cand.pubkey,
        weight: computeSeedEndorsementWeight(
          seed.weight,
          snapshot.followsBySeed[endorserPk]?.length ?? 20
        ),
        kind,
      })
      addedEdgeCount += 1
      if (addedEdgeCount >= 6) break
    }
  }

  return {
    accounts: topAccounts,
    highSignalNotes: highSignalNotes.slice(0, MAX_HIGH_SIGNAL_NOTES),
    filteredSlopCount,
    followPacks,
    graphNodes,
    graphEdges,
    mutedByCountMap,
  }
}

export interface ComputeSimilarVoicesParams {
  targetPubkey: string
  targetFollows: readonly string[]
  targetInteractedPubkeys?: readonly string[]
  followsBySeed: Record<string, string[]>
  candidateAccounts: readonly DiscoveredAccount[]
  myPubkey: string
  blockedSet: ReadonlySet<string>
  dismissedSet: ReadonlySet<string>
  trustedSet: ReadonlySet<string>
  profilesByPubkey: Record<string, AgoraProfile>
  nip05StatusByPubkey: Record<string, AgoraNip05Status>
  candidateNotesByPubkey: Record<string, AgoraNote[]>
  articlesByPubkey: Record<string, AgoraArticle>
  statsByNoteId: Record<string, AgoraNoteStats>
  mutedByCountMap: Record<string, number>
}

/**
 * Finds accounts most similar to `targetPubkey` via co-endorser Jaccard overlap
 * plus direct follow/interaction graph affinity.
 */
export function computeSimilarVoices(params: ComputeSimilarVoicesParams): DiscoveredAccount[] {
  const target = params.targetPubkey.toLowerCase()
  const me = params.myPubkey.toLowerCase()
  if (!isHex64(target)) return []

  const targetFollowSet = new Set(
    params.targetFollows.filter((pk) => isHex64(pk)).map((pk) => pk.toLowerCase())
  )
  const targetInteractedSet = new Set(
    (params.targetInteractedPubkeys ?? []).filter((pk) => isHex64(pk)).map((pk) => pk.toLowerCase())
  )

  // Reverse index: candidate pubkey -> set of seeds that follow them
  const endorsersByPk = new Map<string, Set<string>>()
  for (const [seedPk, follows] of Object.entries(params.followsBySeed)) {
    for (const f of follows) {
      const lower = f.toLowerCase()
      let set = endorsersByPk.get(lower)
      if (!set) {
        set = new Set()
        endorsersByPk.set(lower, set)
      }
      set.add(seedPk)
    }
  }

  const targetEndorsers = endorsersByPk.get(target) ?? new Set<string>()
  const existingByPk = new Map<string, DiscoveredAccount>()
  for (const acc of params.candidateAccounts) existingByPk.set(acc.pubkey, acc)

  const pool = new Set<string>([
    ...targetFollowSet,
    ...targetInteractedSet,
    ...endorsersByPk.keys(),
    ...existingByPk.keys(),
  ])

  const targetLabel = formatShortActor(target, params.profilesByPubkey)
  const ranked: Array<{ account: DiscoveredAccount; similarity: number }> = []

  for (const pk of pool) {
    if (pk === target || pk === me || params.blockedSet.has(pk) || params.dismissedSet.has(pk)) {
      continue
    }

    const candEndorsers = endorsersByPk.get(pk) ?? new Set<string>()
    let sharedEndorsers = 0
    if (targetEndorsers.size > 0 && candEndorsers.size > 0) {
      for (const e of targetEndorsers) {
        if (candEndorsers.has(e)) sharedEndorsers += 1
      }
    }
    const unionEndorsers = targetEndorsers.size + candEndorsers.size - sharedEndorsers
    const coEndorserJaccard = unionEndorsers > 0 ? sharedEndorsers / unionEndorsers : 0

    // Follow-list Jaccard if we also know candidate's own follows
    const candFollows = params.followsBySeed[pk]
    let followJaccard = 0
    if (candFollows && candFollows.length > 0 && targetFollowSet.size > 0) {
      let sharedF = 0
      for (const f of candFollows) {
        if (targetFollowSet.has(f)) sharedF += 1
      }
      const unionF = targetFollowSet.size + candFollows.length - sharedF
      followJaccard = unionF > 0 ? sharedF / unionF : 0
    }

    const followedByTarget = targetFollowSet.has(pk)
    const interactedByTarget = targetInteractedSet.has(pk)

    const similarity =
      coEndorserJaccard * 0.55 +
      followJaccard * 0.35 +
      (followedByTarget ? 0.32 : 0) +
      (interactedByTarget ? 0.25 : 0)

    if (similarity <= 0.05) continue

    const existing = existingByPk.get(pk)
    const mutedByCount = params.mutedByCountMap[pk] ?? existing?.mutedByCount ?? 0
    if (mutedByCount >= 2) continue

    const authorNotes = (params.candidateNotesByPubkey[pk] ?? [])
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
    const sampleArticle = params.articlesByPubkey[pk] ?? existing?.sampleArticle
    const isVerifiedNip05 =
      params.nip05StatusByPubkey[pk] === 'verified' || Boolean(existing?.isVerifiedNip05)
    const profile = params.profilesByPubkey[pk] ?? null

    const quality = assessAccountQuality({
      notes: authorNotes,
      profile,
      nip05Verified: isVerifiedNip05,
      hasArticles: Boolean(sampleArticle),
      statsByNoteId: params.statsByNoteId,
      mutedByCount,
    })
    if (quality.isSlopAccount) continue

    const reasons: string[] = []
    if (sharedEndorsers > 0) {
      const pct = Math.round(coEndorserJaccard * 100)
      reasons.push(
        `Shares ${sharedEndorsers} common ${sharedEndorsers === 1 ? 'endorser' : 'endorsers'} with ${targetLabel}${pct >= 15 ? ` (${pct}% overlap)` : ''}`
      )
    }
    if (followedByTarget) {
      reasons.push(`Followed by ${targetLabel}`)
    }
    if (interactedByTarget) {
      reasons.push(`Reposted or mentioned by ${targetLabel}`)
    }
    if (followJaccard >= 0.1) {
      reasons.push(`${Math.round(followJaccard * 100)}% shared follow graph with ${targetLabel}`)
    }

    const endorsersList = existing?.endorsers ?? Array.from(candEndorsers)
    const trustedEndorsers = endorsersList.filter((e) => params.trustedSet.has(e))
    const sampleNotes =
      existing?.sampleNotes.length
        ? existing.sampleNotes
        : authorNotes
            .filter((n) => !assessNoteSlop(n, params.statsByNoteId[n.id]).isSlop)
            .slice(0, 2)

    const topics =
      existing?.topics.length
        ? existing.topics
        : inferTopicsFromText(
            [profile?.about ?? '', ...sampleNotes.map((n) => n.content)].join('\n'),
            sampleNotes.flatMap((n) => n.hashtags)
          )

    const signalScore = clamp(
      Math.round(Math.min(68, similarity * 88) + quality.qualityScore * 0.32),
      1,
      99
    )

    ranked.push({
      similarity,
      account: {
        pubkey: pk,
        signalScore,
        wotScore: Number(similarity.toFixed(3)),
        qualityScore: quality.qualityScore,
        endorsers: endorsersList,
        trustedEndorsers,
        zapperCount: existing?.zapperCount ?? 0,
        repostEndorserCount: existing?.repostEndorserCount ?? 0,
        mutedByCount,
        isLongFormWriter: Boolean(sampleArticle),
        isVerifiedNip05,
        reasons: reasons.slice(0, 3),
        badges: Array.from(new Set(['Similar Voice', ...quality.badges])).slice(0, 4),
        topics,
        sampleNotes,
        ...(sampleArticle ? { sampleArticle } : {}),
      },
    })
  }

  return ranked
    .sort((a, b) => b.similarity - a.similarity || b.account.signalScore - a.account.signalScore)
    .slice(0, 20)
    .map((r) => r.account)
}

export interface CrawlWotDiscoveryParams {
  agora: AgoraEngine
  myPubkey: string
  trustedPubkeys: readonly string[]
  followingPubkeys: readonly string[]
  localPeerPubkeys: readonly string[]
  blockedSet: ReadonlySet<string>
  onProgress?: (progress: DiscoveryProgress) => void
  isCancelled: () => boolean
}

/**
 * Progressive 4-phase Nostr relay crawl using `agora.queryRelaysOneShot`:
 * 1. Seeds -> 2. 2-hop follows & mutes -> 3. Costly signals (reposts, zaps, NIP-23, Follow Packs) -> 4. Sample notes for top 25 candidates.
 */
export async function crawlWotDiscoveryGraph(
  params: CrawlWotDiscoveryParams
): Promise<WotRawSnapshot | null> {
  const { agora, myPubkey, blockedSet, onProgress, isCancelled } = params
  const me = myPubkey.toLowerCase()
  const relays = Array.from(new Set([...agora.socialRelays, ...AGORA_SOCIAL_RELAYS])).slice(0, 8)

  const { seeds, isColdStart } = buildSeedGraph({
    myPubkey: me,
    trustedPubkeys: params.trustedPubkeys,
    followingPubkeys: params.followingPubkeys,
    localPeerPubkeys: params.localPeerPubkeys,
    blockedSet,
  })
  const seedPubkeys = seeds.map((s) => s.pubkey)
  const seedSet = new Set(seedPubkeys)

  onProgress?.({
    loading: true,
    phase: 'seeds',
    seedsProcessed: 0,
    seedsTotal: seedPubkeys.length,
    lastUpdatedAt: null,
  })

  if (isCancelled()) return null

  const followsBySeed: Record<string, string[]> = {}
  const mutesBySeed: Record<string, string[]> = {}

  // Phase 2: Crawl 1-hop follow lists (kind: 3) + negative-WoT mute lists (kind: 10000)
  if (seedPubkeys.length > 0) {
    onProgress?.({
      loading: true,
      phase: 'graph',
      seedsProcessed: 0,
      seedsTotal: seedPubkeys.length,
      lastUpdatedAt: null,
    })

    const bestFollowEvByPk = new Map<string, NostrEvent>()
    const bestMuteEvByPk = new Map<string, NostrEvent>()
    const chunkSize = 30
    let processed = 0

    for (let i = 0; i < seedPubkeys.length; i += chunkSize) {
      if (isCancelled()) return null
      const chunk = seedPubkeys.slice(i, i + chunkSize)
      const { promise } = agora.queryRelaysOneShot(
        'wot-graph',
        relays,
        [
          {
            kinds: [KIND_AGORA_FOLLOW_LIST, KIND_AGORA_MUTE_LIST],
            authors: chunk,
            limit: chunk.length * 3,
          },
        ],
        {
          timeoutMs: 3600,
          targetEose: Math.min(2, relays.length),
          onEvent: (ev) => {
            if (!verifyEventCached(ev)) return
            const pk = ev.pubkey.toLowerCase()
            if (!seedSet.has(pk)) return
            if (ev.kind === KIND_AGORA_FOLLOW_LIST) {
              const prev = bestFollowEvByPk.get(pk)
              if (!prev || ev.created_at > prev.created_at) {
                bestFollowEvByPk.set(pk, ev)
              }
            } else if (ev.kind === KIND_AGORA_MUTE_LIST) {
              const prev = bestMuteEvByPk.get(pk)
              if (!prev || ev.created_at > prev.created_at) {
                bestMuteEvByPk.set(pk, ev)
              }
            }
          },
        }
      )
      await promise
      if (isCancelled()) return null
      processed = Math.min(seedPubkeys.length, i + chunk.length)
      onProgress?.({
        loading: true,
        phase: 'graph',
        seedsProcessed: processed,
        seedsTotal: seedPubkeys.length,
        lastUpdatedAt: null,
      })
    }

    for (const [pk, ev] of bestFollowEvByPk.entries()) {
      const parsed = parseFollowList(ev)
      if (parsed) {
        followsBySeed[pk] = parsed.pubkeys.filter((p) => !blockedSet.has(p))
      }
    }
    for (const [pk, ev] of bestMuteEvByPk.entries()) {
      const parsed = parseMuteList(ev)
      if (parsed && parsed.pubkeys.length > 0) {
        mutesBySeed[pk] = parsed.pubkeys
      }
    }
  }

  if (isCancelled()) return null

  // Phase 3: Costly signals (reposts, zap receipts, NIP-23 articles, Follow Packs & pool notes)
  onProgress?.({
    loading: true,
    phase: 'signals',
    seedsProcessed: seedPubkeys.length,
    seedsTotal: seedPubkeys.length,
    lastUpdatedAt: null,
  })

  const sinceSec = Math.floor(Date.now() / 1000) - 14 * 86400
  const reposts: WotRepostSignal[] = []
  const seenRepostKey = new Set<string>()
  const zaps: WotZapSignal[] = []
  const seenZapId = new Set<string>()
  const articlesByCoord = new Map<string, AgoraArticle>()
  const packsByCoord = new Map<string, FollowPack>()
  const poolNoteById = new Map<string, AgoraNote>()

  const signalFilters: Filter[] = [
    { kinds: [KIND_AGORA_ARTICLE], limit: 30 },
    { kinds: [KIND_FOLLOW_PACK], limit: 25 },
    { kinds: [KIND_AGORA_PEOPLE_LIST], limit: 25 },
    { kinds: [KIND_AGORA_ZAP_RECEIPT], since: sinceSec, limit: 120 },
  ]
  if (!isColdStart && seedPubkeys.length > 0) {
    const activeAuthors = seedPubkeys.slice(0, 60)
    signalFilters.push({
      kinds: [KIND_AGORA_REPOST],
      authors: activeAuthors,
      since: sinceSec,
      limit: 100,
    })
    signalFilters.push({
      kinds: [KIND_AGORA_NOTE],
      authors: activeAuthors,
      since: sinceSec,
      limit: 70,
    })
  } else {
    signalFilters.push({ kinds: [KIND_AGORA_REPOST], since: sinceSec, limit: 70 })
    signalFilters.push({ kinds: [KIND_AGORA_NOTE], since: sinceSec, limit: 70 })
  }

  const { promise: signalsPromise } = agora.queryRelaysOneShot('wot-signals', relays, signalFilters, {
    timeoutMs: 4200,
    targetEose: Math.min(2, relays.length),
    onEvent: (ev) => {
      if (!verifyEventCached(ev)) return
      const author = ev.pubkey.toLowerCase()
      if (ev.kind !== KIND_AGORA_ZAP_RECEIPT && blockedSet.has(author)) return

      if (ev.kind === KIND_AGORA_NOTE) {
        const note = parseAgoraNote(ev)
        if (note && !note.isReply && !poolNoteById.has(note.id)) {
          poolNoteById.set(note.id, note)
        }
        return
      }

      if (ev.kind === KIND_AGORA_REPOST) {
        const rp = parseAgoraRepost(ev)
        if (!rp) return
        const targetAuthor = rp.embeddedNote?.pubkey ?? rp.targetAuthorPubkey
        if (rp.embeddedNote && !blockedSet.has(rp.embeddedNote.pubkey)) {
          poolNoteById.set(rp.embeddedNote.id, rp.embeddedNote)
        }
        if (targetAuthor && !blockedSet.has(targetAuthor)) {
          const rKey = `${rp.repostedBy}:${rp.targetNoteId}`
          if (!seenRepostKey.has(rKey)) {
            seenRepostKey.add(rKey)
            reposts.push({
              seedPubkey: rp.repostedBy,
              noteId: rp.targetNoteId,
              authorPubkey: targetAuthor,
              createdAt: rp.repostedAt,
            })
          }
        }
        return
      }

      if (ev.kind === KIND_AGORA_ZAP_RECEIPT) {
        const zap = parseZapReceipt(ev)
        if (!zap || seenZapId.has(zap.id) || blockedSet.has(zap.recipientPubkey)) return
        if (zap.senderPubkey && blockedSet.has(zap.senderPubkey)) return
        seenZapId.add(zap.id)
        zaps.push({
          id: zap.id,
          senderPubkey: zap.senderPubkey,
          recipientPubkey: zap.recipientPubkey,
          targetEventId: zap.targetEventId,
          amountSats: zap.amountSats,
          createdAt: zap.createdAt,
        })
        return
      }

      if (ev.kind === KIND_AGORA_ARTICLE) {
        const art = parseAgoraArticle(ev)
        if (!art) return
        const coord = `${art.pubkey}:${art.dTag}`
        const prev = articlesByCoord.get(coord)
        if (!prev || art.createdAt > prev.createdAt) {
          articlesByCoord.set(coord, art)
        }
        return
      }

      if (ev.kind === KIND_FOLLOW_PACK || ev.kind === KIND_AGORA_PEOPLE_LIST) {
        const pack = parseFollowPack(ev, seedSet)
        if (!pack) return
        const coord = `${pack.pubkey}:${pack.dTag}`
        const prev = packsByCoord.get(coord)
        if (!prev || pack.createdAt > prev.createdAt) {
          packsByCoord.set(coord, pack)
        }
      }
    },
  })
  await signalsPromise
  if (isCancelled()) return null

  // Phase 4: Sample-before-you-follow `kind: 1` notes for top 25 unfollowed candidates
  onProgress?.({
    loading: true,
    phase: 'samples',
    seedsProcessed: seedPubkeys.length,
    seedsTotal: seedPubkeys.length,
    lastUpdatedAt: null,
  })

  const prelimScore = new Map<string, number>()
  const followSet = new Set(params.followingPubkeys.map((pk) => pk.toLowerCase()))
  const seedMap = new Map(seeds.map((s) => [s.pubkey, s]))

  const bump = (pk: string, delta: number) => {
    const lower = pk.toLowerCase()
    if (lower === me || blockedSet.has(lower) || followSet.has(lower)) return
    prelimScore.set(lower, (prelimScore.get(lower) ?? 0) + delta)
  }

  for (const [seedPk, list] of Object.entries(followsBySeed)) {
    const seed = seedMap.get(seedPk)
    if (!seed) continue
    const w = computeSeedEndorsementWeight(seed.weight, list.length)
    for (const targetPk of list) bump(targetPk, w)
  }
  for (const zap of zaps) bump(zap.recipientPubkey, 0.35)
  for (const rp of reposts) bump(rp.authorPubkey, 0.25)
  for (const art of articlesByCoord.values()) bump(art.pubkey, 0.4)
  for (const pack of packsByCoord.values()) {
    for (const pk of pack.memberPubkeys.slice(0, 15)) bump(pk, 0.15)
  }

  const topCandidatePks = Array.from(prelimScore.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SAMPLE_CANDIDATES)
    .map(([pk]) => pk)

  const candidateNotesByPubkey: Record<string, AgoraNote[]> = {}
  const sampleSeenByAuthor = new Map<string, Set<string>>()

  if (topCandidatePks.length > 0) {
    const { promise: samplesPromise } = agora.queryRelaysOneShot(
      'wot-samples',
      relays,
      [
        {
          kinds: [KIND_AGORA_NOTE],
          authors: topCandidatePks,
          limit: topCandidatePks.length * 4,
        },
      ],
      {
        timeoutMs: 3800,
        targetEose: Math.min(2, relays.length),
        onEvent: (ev) => {
          if (!verifyEventCached(ev)) return
          const note = parseAgoraNote(ev)
          if (!note || note.isReply || blockedSet.has(note.pubkey)) return
          let seen = sampleSeenByAuthor.get(note.pubkey)
          if (!seen) {
            seen = new Set()
            sampleSeenByAuthor.set(note.pubkey, seen)
          }
          if (seen.has(note.id)) return
          seen.add(note.id)
          const arr = candidateNotesByPubkey[note.pubkey]
          if (arr) arr.push(note)
          else candidateNotesByPubkey[note.pubkey] = [note]
        },
      }
    )
    await samplesPromise
    if (isCancelled()) return null
  }

  for (const pk of Object.keys(candidateNotesByPubkey)) {
    candidateNotesByPubkey[pk] = candidateNotesByPubkey[pk]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 6)
  }

  const fetchedAt = Date.now()
  const snapshot: WotRawSnapshot = {
    myPubkey: me,
    fetchedAt,
    seeds,
    followsBySeed,
    mutesBySeed,
    reposts,
    zaps,
    articles: Array.from(articlesByCoord.values()),
    followPacks: Array.from(packsByCoord.values()),
    candidateNotesByPubkey,
    poolNotes: Array.from(poolNoteById.values()),
  }

  saveCachedWotSnapshot(snapshot)

  onProgress?.({
    loading: false,
    phase: 'ready',
    seedsProcessed: seedPubkeys.length,
    seedsTotal: seedPubkeys.length,
    lastUpdatedAt: fetchedAt,
  })

  return snapshot
}
