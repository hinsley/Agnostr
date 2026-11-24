import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Event as NostrEvent, EventTemplate, Filter } from 'nostr-tools'
import type {
  AgoraActionResult,
  AgoraEngine,
  AgoraFeedItem,
  AgoraFeedTab,
  AgoraNip65RelayList,
  AgoraNote,
  AgoraNoteStats,
  AgoraNotification,
  AgoraProfile,
  AgoraProfileDraft,
  AgoraProfileTab,
  AgoraProfileViewState,
  AgoraPublishNoteOptions,
  AgoraThreadState,
  AgoraTrendingHashtag,
  AgoraUploadedMedia,
} from '../types/agora.ts'
import type { ToastLevel } from '../types/protocol.ts'
import {
  AGORA_PROFILE_RELAYS,
  AGORA_SEARCH_RELAYS,
  AGORA_SOCIAL_RELAYS,
  EMPTY_NOTE_STATS,
  KIND_AGORA_BOOKMARK_LIST,
  KIND_AGORA_FOLLOW_LIST,
  KIND_AGORA_NOTE,
  KIND_AGORA_PROFILE,
  KIND_AGORA_REACTION,
  KIND_AGORA_RELAY_LIST,
  KIND_AGORA_REPOST,
  KIND_AGORA_ZAP_RECEIPT,
  buildAgoraNoteTemplate,
  buildBookmarkListTemplate,
  buildDeletionTemplate,
  buildFollowListTemplate,
  buildProfileMetadataTemplate,
  buildReactionLikeTemplate,
  buildRepostTemplate,
  isHex64,
  normalizeHashtag,
  parseAgoraJumpTarget,
  parseAgoraNote,
  parseAgoraProfile,
  parseAgoraRepost,
  parseBookmarkList,
  parseFollowList,
  parseNip65RelayList,
  parseZapReceipt,
  sanitizeHttpUrl,
} from '../lib/agoraProtocol.ts'
import {
  cleanMimeType,
  DEFAULT_BLOSSOM_SERVERS,
  MAX_MEDIA_BLOB_BYTES,
  uploadBlobToBlossom,
} from '../lib/blossom.ts'
import { normalizeRelayUrl } from '../lib/geoRelays.ts'
import { encodeNpubSafe, type IdentityManager } from '../lib/identity.ts'
import type { RelayPool } from '../lib/relayPool.ts'

export const AGORA_PROFILES_STORAGE_KEY = 'agnostr:v2:agora_profiles'
export const AGORA_BOOKMARKS_STORAGE_KEY = 'agnostr:v2:agora_bookmarks'
export const AGORA_NOTIF_READ_AT_STORAGE_KEY = 'agnostr:v2:agora_notif_read_at'

const MAX_CACHED_PROFILES = 250
const MAX_CACHED_BOOKMARKS = 500
const MAX_FEED_ITEMS = 260
const MAX_NOTIFICATIONS = 150
const NEGATIVE_CACHE_TTL_MS = 3 * 60 * 1000
const STATS_FRESH_TTL_MS = 60 * 1000
const LIVE_BUFFER_GRACE_MS = 2200

export interface UseAgoraOptions {
  relayPool: RelayPool
  identityManager: IdentityManager
  masterPubkey: string
  blockedSet: Set<string>
  customRelays: readonly string[]
  blossomServers: readonly string[]
  pushToast?: (level: ToastLevel, title: string, detail?: string) => void
  onDiscoverProfileLud16?: (pubkey: string, lud16: string) => void
  onProfileNameSaved?: (name: string) => void
}

interface StoredProfileEntry {
  pubkey: string
  name?: string
  displayName?: string
  about?: string
  picture?: string
  banner?: string
  nip05?: string
  lud16?: string
  website?: string
  updatedAt: number
  cachedAt: number
}

interface NoteStatsBucket {
  likers: Set<string>
  reposters: Set<string>
  replyIds: Set<string>
  zapReceipts: Map<string, { sats: number; byMe: boolean }>
  optimisticZapSats: number
  optimisticZapCount: number
  optimisticZappedByMe: boolean
  myLikeEventId?: string
  myUnliked: boolean
}

function createStatsBucket(): NoteStatsBucket {
  return {
    likers: new Set(),
    reposters: new Set(),
    replyIds: new Set(),
    zapReceipts: new Map(),
    optimisticZapSats: 0,
    optimisticZapCount: 0,
    optimisticZappedByMe: false,
    myUnliked: false,
  }
}

function bucketToStats(bucket: NoteStatsBucket, myPubkey: string): AgoraNoteStats {
  let receiptSats = 0
  let myReceiptSats = 0
  let myReceiptCount = 0
  for (const r of bucket.zapReceipts.values()) {
    receiptSats += r.sats
    if (r.byMe) {
      myReceiptSats += r.sats
      myReceiptCount += 1
    }
  }
  const extraZapSats = Math.max(0, bucket.optimisticZapSats - myReceiptSats)
  const extraZapCount = Math.max(0, bucket.optimisticZapCount - myReceiptCount)

  return {
    likes: bucket.likers.size,
    likedByMe: !bucket.myUnliked && bucket.likers.has(myPubkey),
    reposts: bucket.reposters.size,
    repostedByMe: bucket.reposters.has(myPubkey),
    replies: bucket.replyIds.size,
    zapSats: receiptSats + extraZapSats,
    zapCount: bucket.zapReceipts.size + extraZapCount,
    zappedByMe: myReceiptCount > 0 || bucket.optimisticZappedByMe,
  }
}

function loadCachedProfiles(): Record<string, AgoraProfile> {
  try {
    const raw = localStorage.getItem(AGORA_PROFILES_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return {}
    const out: Record<string, AgoraProfile> = {}
    for (const item of parsed.slice(0, MAX_CACHED_PROFILES)) {
      if (!item || typeof item !== 'object') continue
      const entry = item as Partial<StoredProfileEntry>
      if (typeof entry.pubkey !== 'string' || !isHex64(entry.pubkey)) continue
      const pk = entry.pubkey.toLowerCase()
      out[pk] = {
        pubkey: pk,
        npub: encodeNpubSafe(pk),
        name: typeof entry.name === 'string' ? entry.name.slice(0, 80) : undefined,
        displayName:
          typeof entry.displayName === 'string' ? entry.displayName.slice(0, 80) : undefined,
        about: typeof entry.about === 'string' ? entry.about.slice(0, 1200) : undefined,
        picture: sanitizeHttpUrl(entry.picture),
        banner: sanitizeHttpUrl(entry.banner),
        nip05: typeof entry.nip05 === 'string' ? entry.nip05.slice(0, 160) : undefined,
        lud16: typeof entry.lud16 === 'string' ? entry.lud16.slice(0, 160) : undefined,
        website: sanitizeHttpUrl(entry.website, true),
        updatedAt:
          typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
            ? entry.updatedAt
            : 0,
      }
    }
    return out
  } catch {
    return {}
  }
}

function saveCachedProfiles(
  profiles: Record<string, AgoraProfile>,
  touchedAt: Map<string, number>
): void {
  try {
    const entries: StoredProfileEntry[] = Object.values(profiles)
      .map((p) => ({
        pubkey: p.pubkey,
        name: p.name,
        displayName: p.displayName,
        about: p.about,
        picture: p.picture,
        banner: p.banner,
        nip05: p.nip05,
        lud16: p.lud16,
        website: p.website,
        updatedAt: p.updatedAt,
        cachedAt: touchedAt.get(p.pubkey) ?? p.updatedAt * 1000,
      }))
      .sort((a, b) => b.cachedAt - a.cachedAt)
      .slice(0, MAX_CACHED_PROFILES)
    localStorage.setItem(AGORA_PROFILES_STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Ignore storage quota errors
  }
}

function loadCachedBookmarks(): string[] {
  try {
    const raw = localStorage.getItem(AGORA_BOOKMARKS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const item of parsed) {
      if (typeof item === 'string' && isHex64(item)) {
        const id = item.toLowerCase()
        if (!seen.has(id)) {
          seen.add(id)
          out.push(id)
          if (out.length >= MAX_CACHED_BOOKMARKS) break
        }
      }
    }
    return out
  } catch {
    return []
  }
}

function saveCachedBookmarks(ids: readonly string[]): void {
  try {
    localStorage.setItem(
      AGORA_BOOKMARKS_STORAGE_KEY,
      JSON.stringify(ids.slice(0, MAX_CACHED_BOOKMARKS))
    )
  } catch {
    // Ignore storage errors
  }
}

function loadNotifReadAt(): number {
  try {
    const raw = localStorage.getItem(AGORA_NOTIF_READ_AT_STORAGE_KEY)
    const parsed = raw ? Number.parseInt(raw, 10) : 0
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  } catch {
    return 0
  }
}

function saveNotifReadAt(tsSec: number): void {
  try {
    localStorage.setItem(AGORA_NOTIF_READ_AT_STORAGE_KEY, String(Math.floor(tsSec)))
  } catch {
    // Ignore storage errors
  }
}

function mergeFeedItems(
  existing: readonly AgoraFeedItem[],
  incoming: readonly AgoraFeedItem[],
  blocked: Set<string>,
  maxLen = MAX_FEED_ITEMS
): AgoraFeedItem[] {
  const byKey = new Map<string, AgoraFeedItem>()
  for (const item of existing) {
    if (blocked.has(item.note.pubkey)) continue
    if (item.repostedBy && blocked.has(item.repostedBy)) continue
    byKey.set(item.key, item)
  }
  for (const item of incoming) {
    if (blocked.has(item.note.pubkey)) continue
    if (item.repostedBy && blocked.has(item.repostedBy)) continue
    const prev = byKey.get(item.key)
    if (!prev || item.sortAt > prev.sortAt) {
      byKey.set(item.key, item)
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.sortAt - a.sortAt || b.note.createdAt - a.note.createdAt)
    .slice(0, maxLen)
}

function computeTrendingScore(note: AgoraNote, stats: AgoraNoteStats | undefined, nowSec: number): number {
  const ageHours = Math.max(0, (nowSec - note.createdAt) / 3600)
  const likes = stats?.likes ?? 0
  const reposts = stats?.reposts ?? 0
  const replies = stats?.replies ?? 0
  const zapSats = Math.min(stats?.zapSats ?? 0, 50_000)
  const engagement = likes * 2 + reposts * 4 + replies * 3 + zapSats * 0.05
  // Give rich media/text notes a slight tie-break boost when engagement is still warming up
  const base = 0.5 + (note.media.length > 0 ? 0.35 : 0)
  return (engagement + base) / Math.pow(ageHours + 2, 1.35)
}

async function detectImageDimensions(blob: Blob): Promise<string | undefined> {
  if (typeof window === 'undefined') return undefined
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob)
      const dim = bmp.width > 0 && bmp.height > 0 ? `${bmp.width}x${bmp.height}` : undefined
      bmp.close()
      return dim
    } catch {
      // Fallback below
    }
  }
  try {
    const objectUrl = URL.createObjectURL(blob)
    try {
      const dim = await new Promise<string | undefined>((resolve) => {
        const img = new Image()
        img.onload = () => {
          resolve(
            img.naturalWidth > 0 && img.naturalHeight > 0
              ? `${img.naturalWidth}x${img.naturalHeight}`
              : undefined
          )
        }
        img.onerror = () => resolve(undefined)
        img.src = objectUrl
      })
      return dim
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  } catch {
    return undefined
  }
}

export function useAgora(options: UseAgoraOptions): AgoraEngine {
  const {
    relayPool,
    identityManager,
    masterPubkey,
    blockedSet,
    customRelays,
    blossomServers,
  } = options

  const myPubkey = useMemo(
    () => (masterPubkey || identityManager.getMasterKeyMaterial().pubkey).toLowerCase(),
    [identityManager, masterPubkey]
  )
  const myPubkeyRef = useRef<string>(myPubkey)
  myPubkeyRef.current = myPubkey

  const blockedSetRef = useRef<Set<string>>(blockedSet)
  blockedSetRef.current = blockedSet

  const pushToastRef = useRef(options.pushToast)
  pushToastRef.current = options.pushToast

  const onDiscoverLud16Ref = useRef(options.onDiscoverProfileLud16)
  onDiscoverLud16Ref.current = options.onDiscoverProfileLud16

  const onProfileNameSavedRef = useRef(options.onProfileNameSaved)
  onProfileNameSavedRef.current = options.onProfileNameSaved

  const blossomServersRef = useRef<readonly string[]>(blossomServers)
  blossomServersRef.current = blossomServers

  // Lazy activation — zero relay subscriptions until user opens Agora
  const [active, setActive] = useState(false)
  const activeRef = useRef(false)
  activeRef.current = active

  // Primary tabs & refresh
  const [activeTab, setActiveTabState] = useState<AgoraFeedTab>('following')
  const activeTabRef = useRef<AgoraFeedTab>(activeTab)
  activeTabRef.current = activeTab

  const [refreshNonce, setRefreshNonce] = useState(0)
  const [loadingFeed, setLoadingFeed] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMoreByTab, setHasMoreByTab] = useState<Record<string, boolean>>({
    following: true,
    global: true,
    trending: false,
    bookmarks: false,
    notifications: false,
  })

  // Feed item stores
  const [followingItems, setFollowingItems] = useState<AgoraFeedItem[]>([])
  const [globalItems, setGlobalItems] = useState<AgoraFeedItem[]>([])
  const [trendingCandidates, setTrendingCandidates] = useState<AgoraNote[]>([])
  const [pendingNewCount, setPendingNewCount] = useState(0)

  // Normalized caches
  const [profilesByPubkey, setProfilesByPubkey] = useState<Record<string, AgoraProfile>>(() =>
    loadCachedProfiles()
  )
  const profilesRef = useRef<Record<string, AgoraProfile>>(profilesByPubkey)
  profilesRef.current = profilesByPubkey

  const [notesById, setNotesById] = useState<Record<string, AgoraNote>>({})
  const notesRef = useRef<Record<string, AgoraNote>>(notesById)
  notesRef.current = notesById

  const [statsByNoteId, setStatsByNoteId] = useState<Record<string, AgoraNoteStats>>({})
  const statsBucketsRef = useRef<Map<string, NoteStatsBucket>>(new Map())

  // Social graph & lists
  const [followingPubkeys, setFollowingPubkeys] = useState<string[]>([])
  const followingRef = useRef<string[]>(followingPubkeys)
  followingRef.current = followingPubkeys
  const followingSet = useMemo(() => new Set(followingPubkeys), [followingPubkeys])

  const [bookmarkedIds, setBookmarkedIds] = useState<string[]>(() => loadCachedBookmarks())
  const bookmarkedRef = useRef<string[]>(bookmarkedIds)
  bookmarkedRef.current = bookmarkedIds
  const bookmarkedSet = useMemo(() => new Set(bookmarkedIds), [bookmarkedIds])

  const [myNip65Relays, setMyNip65Relays] = useState<AgoraNip65RelayList | null>(null)
  const myFollowEventRef = useRef<NostrEvent | null>(null)
  const myBookmarkEventRef = useRef<NostrEvent | null>(null)

  // Notifications
  const [notifications, setNotifications] = useState<AgoraNotification[]>([])
  const [lastNotifReadAt, setLastNotifReadAt] = useState<number>(() => loadNotifReadAt())
  const notifByIdRef = useRef<Map<string, AgoraNotification>>(new Map())

  // Thread & Profile overlays
  const [thread, setThread] = useState<AgoraThreadState | null>(null)
  const threadRef = useRef<AgoraThreadState | null>(thread)
  threadRef.current = thread

  const [profileView, setProfileView] = useState<AgoraProfileViewState | null>(null)
  const profileViewRef = useRef<AgoraProfileViewState | null>(profileView)
  profileViewRef.current = profileView

  // Search & Hashtags
  const [searchQuery, setSearchQuery] = useState('')
  const [activeHashtag, setActiveHashtag] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<AgoraNote[]>([])
  const [searchProfiles, setSearchProfiles] = useState<AgoraProfile[]>([])
  const [searchLoading, setSearchLoading] = useState(false)

  // Publishing flags
  const [publishing, setPublishing] = useState(false)
  const [uploadingMedia, setUploadingMedia] = useState(false)

  // Internal batching, dedup, cancellation refs
  const subSeqRef = useRef(0)
  const activeCancelsRef = useRef<Set<() => void>>(new Set())
  const pendingItemsRef = useRef<Map<string, AgoraFeedItem>>(new Map())
  const profileTouchedAtRef = useRef<Map<string, number>>(new Map())
  const profilePersistTimerRef = useRef<number | null>(null)

  const profileQueueRef = useRef<Set<string>>(new Set())
  const profileInFlightRef = useRef<Set<string>>(new Set())
  const profileNegativeRef = useRef<Map<string, number>>(new Map())
  const profileFlushTimerRef = useRef<number | null>(null)

  const noteQueueRef = useRef<Set<string>>(new Set())
  const noteInFlightRef = useRef<Set<string>>(new Set())
  const noteNegativeRef = useRef<Map<string, number>>(new Map())
  const noteFlushTimerRef = useRef<number | null>(null)
  const pendingRepostsByTargetRef = useRef<
    Map<string, Array<{ repostedBy: string; repostedAt: number }>>
  >(new Map())

  const statsQueueRef = useRef<Set<string>>(new Set())
  const statsFetchedAtRef = useRef<Map<string, number>>(new Map())
  const statsFetchTimerRef = useRef<number | null>(null)
  const statsStateFlushTimerRef = useRef<number | null>(null)
  const dirtyStatsIdsRef = useRef<Set<string>>(new Set())

  const threadGenRef = useRef(0)
  const profileViewGenRef = useRef(0)
  const searchGenRef = useRef(0)
  const discoveryWarmedRef = useRef(false)

  // Resolved read & write relay lists
  const socialRelays = useMemo(() => {
    const out = new Set<string>()
    if (myNip65Relays) {
      for (const r of myNip65Relays.read.slice(0, 4)) out.add(r)
    }
    for (const r of AGORA_SOCIAL_RELAYS) out.add(r)
    for (const raw of customRelays) {
      const clean = normalizeRelayUrl(raw)
      if (clean) out.add(clean)
    }
    return Array.from(out).slice(0, 8)
  }, [myNip65Relays, customRelays])
  const socialRelaysRef = useRef<string[]>(socialRelays)
  socialRelaysRef.current = socialRelays

  const writeRelays = useMemo(() => {
    const out = new Set<string>()
    if (myNip65Relays) {
      for (const r of myNip65Relays.write.slice(0, 6)) out.add(r)
    }
    for (const r of AGORA_SOCIAL_RELAYS) out.add(r)
    for (const raw of customRelays) {
      const clean = normalizeRelayUrl(raw)
      if (clean) out.add(clean)
    }
    return Array.from(out).slice(0, 8)
  }, [myNip65Relays, customRelays])
  const writeRelaysRef = useRef<string[]>(writeRelays)
  writeRelaysRef.current = writeRelays

  const profileRelays = useMemo(() => {
    const out = new Set<string>(AGORA_PROFILE_RELAYS)
    for (const r of socialRelays.slice(0, 3)) out.add(r)
    return Array.from(out).slice(0, 6)
  }, [socialRelays])
  const profileRelaysRef = useRef<string[]>(profileRelays)
  profileRelaysRef.current = profileRelays

  // Master-key-only signer (NEVER uses per-geohash Bitchat alias keys)
  const signMasterEvent = useCallback(
    async (template: EventTemplate) => {
      const material = identityManager.getMasterKeyMaterial()
      return await identityManager.signEventWithMaterial(template, material)
    },
    [identityManager]
  )

  const queryOneShot = useCallback(
    (
      prefix: string,
      relays: readonly string[],
      filters: Filter[],
      opts: {
        onEvent: (event: NostrEvent, relayUrl: string) => void
        timeoutMs?: number
        targetEose?: number
      }
    ): { promise: Promise<void>; cancel: () => void } => {
      const uniqueRelays = Array.from(new Set(relays)).filter((r) => r.startsWith('ws'))
      if (uniqueRelays.length === 0 || filters.length === 0) {
        return { promise: Promise.resolve(), cancel: () => {} }
      }

      const subId = `ag-${prefix}-${++subSeqRef.current}`
      const timeoutMs = opts.timeoutMs ?? 4200
      const targetEose = opts.targetEose ?? Math.max(1, Math.min(3, uniqueRelays.length))

      let settled = false
      let eoseCount = 0
      let unsub: (() => void) | null = null
      let timer: number | null = null
      let graceTimer: number | null = null
      let resolveFn: (() => void) | null = null

      const finish = () => {
        if (settled) return
        settled = true
        if (timer !== null) {
          window.clearTimeout(timer)
          timer = null
        }
        if (graceTimer !== null) {
          window.clearTimeout(graceTimer)
          graceTimer = null
        }
        if (unsub) {
          unsub()
          unsub = null
        }
        activeCancelsRef.current.delete(finish)
        resolveFn?.()
      }

      const promise = new Promise<void>((resolve) => {
        resolveFn = resolve
        activeCancelsRef.current.add(finish)
        timer = window.setTimeout(finish, timeoutMs)

        unsub = relayPool.subscribe(subId, uniqueRelays, filters, {
          onEvent: (ev, relayUrl) => {
            if (settled) return
            opts.onEvent(ev, relayUrl)
          },
          onEose: () => {
            if (settled) return
            eoseCount += 1
            if (eoseCount >= uniqueRelays.length) {
              finish()
            } else if (eoseCount >= targetEose && graceTimer === null) {
              graceTimer = window.setTimeout(finish, 240)
            }
          },
        })
      })

      return { promise, cancel: finish }
    },
    [relayPool]
  )

  // Schedule debounced localStorage persistence for profile cache
  const schedulePersistProfiles = useCallback(() => {
    if (profilePersistTimerRef.current !== null) return
    profilePersistTimerRef.current = window.setTimeout(() => {
      profilePersistTimerRef.current = null
      saveCachedProfiles(profilesRef.current, profileTouchedAtRef.current)
    }, 800)
  }, [])

  const ingestProfilesBatch = useCallback(
    (incoming: readonly AgoraProfile[]) => {
      if (incoming.length === 0) return
      const nowMs = Date.now()
      const updates: Record<string, AgoraProfile> = {}
      let changed = false

      for (const profile of incoming) {
        const existing = profilesRef.current[profile.pubkey]
        if (existing && existing.updatedAt > profile.updatedAt) continue
        if (
          existing &&
          existing.updatedAt === profile.updatedAt &&
          existing.name === profile.name &&
          existing.displayName === profile.displayName &&
          existing.picture === profile.picture &&
          existing.about === profile.about &&
          existing.lud16 === profile.lud16 &&
          Boolean(existing.rawJson) >= Boolean(profile.rawJson)
        ) {
          continue
        }
        updates[profile.pubkey] = profile
        profileTouchedAtRef.current.set(profile.pubkey, nowMs)
        profileNegativeRef.current.delete(profile.pubkey)
        if (profile.lud16) {
          onDiscoverLud16Ref.current?.(profile.pubkey, profile.lud16)
        }
        changed = true
      }

      if (!changed) return
      const next = { ...profilesRef.current, ...updates }
      profilesRef.current = next
      setProfilesByPubkey(next)
      schedulePersistProfiles()
    },
    [schedulePersistProfiles]
  )

  const ingestNotesBatch = useCallback((incoming: readonly AgoraNote[]) => {
    if (incoming.length === 0) return
    const updates: Record<string, AgoraNote> = {}
    let changed = false
    for (const note of incoming) {
      if (notesRef.current[note.id]) continue
      updates[note.id] = note
      noteNegativeRef.current.delete(note.id)
      changed = true
    }
    if (!changed) return
    const next = { ...notesRef.current, ...updates }
    notesRef.current = next
    setNotesById(next)
  }, [])

  const flushDirtyStats = useCallback(() => {
    if (statsStateFlushTimerRef.current !== null) {
      window.clearTimeout(statsStateFlushTimerRef.current)
      statsStateFlushTimerRef.current = null
    }
    if (dirtyStatsIdsRef.current.size === 0) return
    const ids = Array.from(dirtyStatsIdsRef.current)
    dirtyStatsIdsRef.current.clear()
    const pk = myPubkeyRef.current
    setStatsByNoteId((prev) => {
      let changed = false
      const next = { ...prev }
      for (const id of ids) {
        const bucket = statsBucketsRef.current.get(id)
        if (!bucket) continue
        const computed = bucketToStats(bucket, pk)
        const old = prev[id]
        if (
          !old ||
          old.likes !== computed.likes ||
          old.likedByMe !== computed.likedByMe ||
          old.reposts !== computed.reposts ||
          old.repostedByMe !== computed.repostedByMe ||
          old.replies !== computed.replies ||
          old.zapSats !== computed.zapSats ||
          old.zapCount !== computed.zapCount ||
          old.zappedByMe !== computed.zappedByMe
        ) {
          next[id] = computed
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const scheduleStatsStateFlush = useCallback(() => {
    if (statsStateFlushTimerRef.current !== null) return
    statsStateFlushTimerRef.current = window.setTimeout(flushDirtyStats, 140)
  }, [flushDirtyStats])

  const getOrCreateBucket = useCallback((noteId: string): NoteStatsBucket => {
    let bucket = statsBucketsRef.current.get(noteId)
    if (!bucket) {
      bucket = createStatsBucket()
      statsBucketsRef.current.set(noteId, bucket)
    }
    return bucket
  }, [])

  // Batched profile loader (`ensureProfiles`)
  const flushProfileQueue = useCallback(() => {
    profileFlushTimerRef.current = null
    const batch = Array.from(profileQueueRef.current)
    profileQueueRef.current.clear()
    if (batch.length === 0) return

    const relays = profileRelaysRef.current
    for (let i = 0; i < batch.length; i += 80) {
      const chunk = batch.slice(i, i + 80)
      for (const pk of chunk) profileInFlightRef.current.add(pk)

      const foundByPk = new Map<string, AgoraProfile>()
      const { promise } = queryOneShot(
        'prof',
        relays,
        [{ kinds: [KIND_AGORA_PROFILE], authors: chunk, limit: chunk.length * 2 }],
        {
          timeoutMs: 3600,
          targetEose: Math.min(2, relays.length),
          onEvent: (ev) => {
            const parsed = parseAgoraProfile(ev)
            if (!parsed) return
            const prev = foundByPk.get(parsed.pubkey)
            if (!prev || parsed.updatedAt > prev.updatedAt) {
              foundByPk.set(parsed.pubkey, parsed)
            }
          },
        }
      )

      void promise.then(() => {
        const nowMs = Date.now()
        if (foundByPk.size > 0) {
          ingestProfilesBatch(Array.from(foundByPk.values()))
        }
        for (const pk of chunk) {
          profileInFlightRef.current.delete(pk)
          if (!foundByPk.has(pk) && !profilesRef.current[pk]) {
            profileNegativeRef.current.set(pk, nowMs)
          }
        }
      })
    }
  }, [ingestProfilesBatch, queryOneShot])

  const ensureProfiles = useCallback(
    (pubkeys: readonly string[], force = false) => {
      const nowMs = Date.now()
      let added = false
      for (const raw of pubkeys) {
        if (!isHex64(raw)) continue
        const pk = raw.toLowerCase()
        if (!force) {
          if (profilesRef.current[pk]) continue
          const negAt = profileNegativeRef.current.get(pk)
          if (negAt && nowMs - negAt < NEGATIVE_CACHE_TTL_MS) continue
        }
        if (profileInFlightRef.current.has(pk)) continue
        profileQueueRef.current.add(pk)
        added = true
      }
      if (added && profileFlushTimerRef.current === null) {
        profileFlushTimerRef.current = window.setTimeout(flushProfileQueue, 60)
      }
    },
    [flushProfileQueue]
  )

  // Batched on-demand note loader (`ensureNotes`)
  const flushNoteQueue = useCallback(() => {
    noteFlushTimerRef.current = null
    const batch = Array.from(noteQueueRef.current)
    noteQueueRef.current.clear()
    if (batch.length === 0) return

    const relays = socialRelaysRef.current
    for (let i = 0; i < batch.length; i += 50) {
      const chunk = batch.slice(i, i + 50)
      for (const id of chunk) noteInFlightRef.current.add(id)

      const found: AgoraNote[] = []
      const foundIds = new Set<string>()
      const { promise } = queryOneShot('notes', relays, [{ ids: chunk }], {
        timeoutMs: 3800,
        targetEose: Math.min(2, relays.length),
        onEvent: (ev) => {
          const parsed = parseAgoraNote(ev)
          if (!parsed || foundIds.has(parsed.id)) return
          foundIds.add(parsed.id)
          found.push(parsed)
        },
      })

      void promise.then(() => {
        const nowMs = Date.now()
        if (found.length > 0) {
          ingestNotesBatch(found)
          const authors = found.map((n) => n.pubkey)
          ensureProfiles(authors)

          // Materialize any NIP-18 empty-content reposts that were waiting on these notes
          const resolvedRepostItems: AgoraFeedItem[] = []
          for (const note of found) {
            const waiting = pendingRepostsByTargetRef.current.get(note.id)
            if (!waiting || waiting.length === 0) continue
            pendingRepostsByTargetRef.current.delete(note.id)
            if (blockedSetRef.current.has(note.pubkey)) continue
            for (const entry of waiting) {
              if (blockedSetRef.current.has(entry.repostedBy)) continue
              resolvedRepostItems.push({
                key: `repost:${entry.repostedBy}:${note.id}`,
                kind: 'repost',
                note,
                repostedBy: entry.repostedBy,
                repostedAt: entry.repostedAt,
                sortAt: entry.repostedAt,
              })
            }
          }
          if (resolvedRepostItems.length > 0) {
            setFollowingItems((prev) =>
              mergeFeedItems(prev, resolvedRepostItems, blockedSetRef.current)
            )
          }
        }
        for (const id of chunk) {
          noteInFlightRef.current.delete(id)
          if (!foundIds.has(id) && !notesRef.current[id]) {
            noteNegativeRef.current.set(id, nowMs)
          }
        }
      })
    }
  }, [ensureProfiles, ingestNotesBatch, queryOneShot])

  const ensureNotes = useCallback(
    (ids: readonly string[]) => {
      const nowMs = Date.now()
      let added = false
      for (const raw of ids) {
        if (!isHex64(raw)) continue
        const id = raw.toLowerCase()
        if (notesRef.current[id]) continue
        if (noteInFlightRef.current.has(id)) continue
        const negAt = noteNegativeRef.current.get(id)
        if (negAt && nowMs - negAt < NEGATIVE_CACHE_TTL_MS) continue
        noteQueueRef.current.add(id)
        added = true
      }
      if (added && noteFlushTimerRef.current === null) {
        noteFlushTimerRef.current = window.setTimeout(flushNoteQueue, 60)
      }
    },
    [flushNoteQueue]
  )

  // Batched engagement fetcher (`kind: 7`, `kind: 6`, `kind: 1` `#e`, `kind: 9735`)
  const flushStatsQueue = useCallback(() => {
    statsFetchTimerRef.current = null
    const batch = Array.from(statsQueueRef.current)
    statsQueueRef.current.clear()
    if (batch.length === 0) return

    const relays = socialRelaysRef.current
    const nowMs = Date.now()
    for (const id of batch) {
      statsFetchedAtRef.current.set(id, nowMs)
    }

    for (let i = 0; i < batch.length; i += 35) {
      const chunk = batch.slice(i, i + 35)
      const chunkSet = new Set(chunk)

      queryOneShot(
        'stats',
        relays,
        [
          {
            kinds: [KIND_AGORA_REACTION, KIND_AGORA_REPOST, KIND_AGORA_ZAP_RECEIPT],
            '#e': chunk,
            limit: 400,
          },
          {
            kinds: [KIND_AGORA_NOTE],
            '#e': chunk,
            limit: 200,
          },
        ],
        {
          timeoutMs: 4200,
          targetEose: Math.min(2, relays.length),
          onEvent: (ev) => {
            const pk = ev.pubkey.toLowerCase()
            if (ev.kind !== KIND_AGORA_ZAP_RECEIPT && blockedSetRef.current.has(pk)) return

            if (ev.kind === KIND_AGORA_REACTION) {
              if (ev.content.trim() === '-') return
              // Target event is the last 'e' tag per NIP-25
              let targetId: string | null = null
              for (let t = ev.tags.length - 1; t >= 0; t -= 1) {
                const tag = ev.tags[t]
                if (tag?.[0] === 'e' && isHex64(tag[1]) && chunkSet.has(tag[1].toLowerCase())) {
                  targetId = tag[1].toLowerCase()
                  break
                }
              }
              if (!targetId) return
              const bucket = getOrCreateBucket(targetId)
              if (pk === myPubkeyRef.current) {
                if (!bucket.myUnliked) {
                  bucket.likers.add(pk)
                  bucket.myLikeEventId = ev.id.toLowerCase()
                }
              } else {
                bucket.likers.add(pk)
              }
              dirtyStatsIdsRef.current.add(targetId)
              scheduleStatsStateFlush()
              return
            }

            if (ev.kind === KIND_AGORA_REPOST) {
              let targetId: string | null = null
              for (const tag of ev.tags) {
                if (tag?.[0] === 'e' && isHex64(tag[1]) && chunkSet.has(tag[1].toLowerCase())) {
                  targetId = tag[1].toLowerCase()
                  break
                }
              }
              if (!targetId) return
              const bucket = getOrCreateBucket(targetId)
              bucket.reposters.add(pk)
              dirtyStatsIdsRef.current.add(targetId)
              scheduleStatsStateFlush()
              return
            }

            if (ev.kind === KIND_AGORA_NOTE) {
              const parsed = parseAgoraNote(ev)
              if (!parsed || !parsed.isReply) return
              const targetId =
                parsed.replyToId && chunkSet.has(parsed.replyToId)
                  ? parsed.replyToId
                  : parsed.rootId && chunkSet.has(parsed.rootId)
                    ? parsed.rootId
                    : null
              if (!targetId) return
              const bucket = getOrCreateBucket(targetId)
              bucket.replyIds.add(parsed.id)
              dirtyStatsIdsRef.current.add(targetId)
              scheduleStatsStateFlush()
              return
            }

            if (ev.kind === KIND_AGORA_ZAP_RECEIPT) {
              const zap = parseZapReceipt(ev)
              if (!zap || !zap.targetEventId || !chunkSet.has(zap.targetEventId)) return
              if (zap.senderPubkey && blockedSetRef.current.has(zap.senderPubkey)) return
              const bucket = getOrCreateBucket(zap.targetEventId)
              if (bucket.zapReceipts.has(zap.id)) return
              bucket.zapReceipts.set(zap.id, {
                sats: zap.amountSats,
                byMe: zap.senderPubkey === myPubkeyRef.current,
              })
              dirtyStatsIdsRef.current.add(zap.targetEventId)
              scheduleStatsStateFlush()
            }
          },
        }
      )
    }
  }, [getOrCreateBucket, queryOneShot, scheduleStatsStateFlush])

  const ensureStatsForNotes = useCallback(
    (noteIds: readonly string[], force = false) => {
      const nowMs = Date.now()
      let added = false
      for (const rawId of noteIds) {
        if (!isHex64(rawId)) continue
        const id = rawId.toLowerCase()
        if (!force) {
          const lastAt = statsFetchedAtRef.current.get(id)
          if (lastAt && nowMs - lastAt < STATS_FRESH_TTL_MS) continue
        }
        statsQueueRef.current.add(id)
        added = true
      }
      if (added && statsFetchTimerRef.current === null) {
        statsFetchTimerRef.current = window.setTimeout(flushStatsQueue, 120)
      }
    },
    [flushStatsQueue]
  )

  const warmDependenciesForNotes = useCallback(
    (notes: readonly AgoraNote[], extraPubkeys?: readonly string[]) => {
      const pks: string[] = extraPubkeys ? [...extraPubkeys] : []
      const quoteIds: string[] = []
      const ids: string[] = []
      for (const n of notes) {
        ids.push(n.id)
        pks.push(n.pubkey)
        for (const mp of n.mentionedPubkeys) pks.push(mp)
        for (const qid of n.quoteIds) quoteIds.push(qid)
      }
      if (pks.length > 0) ensureProfiles(pks)
      if (quoteIds.length > 0) ensureNotes(quoteIds)
      if (ids.length > 0) ensureStatsForNotes(ids)
    },
    [ensureNotes, ensureProfiles, ensureStatsForNotes]
  )

  // Activate lazily when Agora is visited
  const activate = useCallback(() => {
    setActive(true)
  }, [])

  // Reset per-identity state when master pubkey rotates or switches
  useEffect(() => {
    myFollowEventRef.current = null
    myBookmarkEventRef.current = null
    setFollowingPubkeys([])
    setMyNip65Relays(null)
    notifByIdRef.current.clear()
    setNotifications([])
    pendingItemsRef.current.clear()
    setPendingNewCount(0)
    discoveryWarmedRef.current = false
  }, [myPubkey])

  // 1. Bootstrap my own profile, follow list (kind:3), NIP-65 relays (kind:10002), bookmarks (kind:10003)
  useEffect(() => {
    if (!active || !isHex64(myPubkey)) return

    const relays = Array.from(new Set([...AGORA_PROFILE_RELAYS, ...AGORA_SOCIAL_RELAYS]))
    let bestProfile: AgoraProfile | null = null
    let bestFollow: NostrEvent | null = null
    let bestNip65: AgoraNip65RelayList | null = null
    let bestBookmark: NostrEvent | null = null

    const { promise, cancel } = queryOneShot(
      'boot',
      relays,
      [
        {
          kinds: [
            KIND_AGORA_PROFILE,
            KIND_AGORA_FOLLOW_LIST,
            KIND_AGORA_RELAY_LIST,
            KIND_AGORA_BOOKMARK_LIST,
          ],
          authors: [myPubkey],
          limit: 20,
        },
      ],
      {
        timeoutMs: 4500,
        targetEose: Math.min(3, relays.length),
        onEvent: (ev) => {
          if (ev.pubkey.toLowerCase() !== myPubkey) return
          if (ev.kind === KIND_AGORA_PROFILE) {
            const p = parseAgoraProfile(ev)
            if (p && (!bestProfile || p.updatedAt > bestProfile.updatedAt)) {
              bestProfile = p
            }
          } else if (ev.kind === KIND_AGORA_FOLLOW_LIST) {
            if (!bestFollow || ev.created_at > bestFollow.created_at) {
              bestFollow = ev
            }
          } else if (ev.kind === KIND_AGORA_RELAY_LIST) {
            const parsed = parseNip65RelayList(ev)
            if (parsed && (!bestNip65 || parsed.updatedAt > bestNip65.updatedAt)) {
              bestNip65 = parsed
            }
          } else if (ev.kind === KIND_AGORA_BOOKMARK_LIST) {
            if (!bestBookmark || ev.created_at > bestBookmark.created_at) {
              bestBookmark = ev
            }
          }
        },
      }
    )

    let cancelled = false
    void promise.then(() => {
      if (cancelled) return
      if (bestProfile) {
        ingestProfilesBatch([bestProfile])
      }
      if (bestFollow) {
        myFollowEventRef.current = bestFollow
        const parsed = parseFollowList(bestFollow)
        if (parsed) {
          setFollowingPubkeys(parsed.pubkeys)
          ensureProfiles(parsed.pubkeys.slice(0, 60))
        }
      }
      if (bestNip65) {
        setMyNip65Relays(bestNip65)
      }
      if (bestBookmark) {
        myBookmarkEventRef.current = bestBookmark
        const parsed = parseBookmarkList(bestBookmark)
        if (parsed) {
          const merged = Array.from(new Set([...parsed.noteIds, ...bookmarkedRef.current])).slice(
            0,
            MAX_CACHED_BOOKMARKS
          )
          setBookmarkedIds(merged)
          saveCachedBookmarks(merged)
        }
      }
    })

    return () => {
      cancelled = true
      cancel()
    }
  }, [active, myPubkey, queryOneShot, ingestProfilesBatch, ensureProfiles])

  // 2. Live notifications subscription while Agora is active
  useEffect(() => {
    if (!active || !isHex64(myPubkey)) return
    const relays = socialRelaysRef.current
    const sinceSec = Math.floor(Date.now() / 1000) - 7 * 86400
    let flushTimer: number | null = null

    const flushNotifications = () => {
      flushTimer = null
      const blocked = blockedSetRef.current
      const list = Array.from(notifByIdRef.current.values())
        .filter((n) => !blocked.has(n.actorPubkey))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_NOTIFICATIONS)
      setNotifications(list)
    }

    const scheduleFlush = () => {
      if (flushTimer !== null) return
      flushTimer = window.setTimeout(flushNotifications, 150)
    }

    const unsub = relayPool.subscribe(
      `ag-notifs-${myPubkey.slice(0, 10)}`,
      relays,
      [
        {
          kinds: [
            KIND_AGORA_NOTE,
            KIND_AGORA_REPOST,
            KIND_AGORA_REACTION,
            KIND_AGORA_ZAP_RECEIPT,
          ],
          '#p': [myPubkey],
          since: sinceSec,
          limit: 90,
        },
      ],
      {
        onEvent: (ev) => {
          const evId = ev.id.toLowerCase()
          if (notifByIdRef.current.has(evId)) return

          if (ev.kind === KIND_AGORA_ZAP_RECEIPT) {
            const zap = parseZapReceipt(ev)
            if (!zap || zap.recipientPubkey !== myPubkey) return
            const actor = zap.senderPubkey ?? ev.pubkey.toLowerCase()
            if (actor === myPubkey || blockedSetRef.current.has(actor)) return
            notifByIdRef.current.set(evId, {
              id: evId,
              kind: 'zap',
              actorPubkey: actor,
              createdAt: zap.createdAt,
              targetNoteId: zap.targetEventId,
              content: zap.comment,
              zapSats: zap.amountSats,
            })
            ensureProfiles([actor])
            if (zap.targetEventId) ensureNotes([zap.targetEventId])
            scheduleFlush()
            return
          }

          const actor = ev.pubkey.toLowerCase()
          if (actor === myPubkey || blockedSetRef.current.has(actor)) return

          if (ev.kind === KIND_AGORA_NOTE) {
            const note = parseAgoraNote(ev)
            if (!note) return
            ingestNotesBatch([note])
            const targetId = note.replyToId ?? note.rootId
            notifByIdRef.current.set(evId, {
              id: evId,
              kind: note.isReply ? 'reply' : 'mention',
              actorPubkey: actor,
              createdAt: note.createdAt,
              noteId: note.id,
              targetNoteId: targetId,
              content: note.content.slice(0, 220),
            })
            ensureProfiles([actor])
            if (targetId) ensureNotes([targetId])
            scheduleFlush()
            return
          }

          if (ev.kind === KIND_AGORA_REPOST) {
            const repost = parseAgoraRepost(ev)
            if (!repost) return
            if (repost.embeddedNote) ingestNotesBatch([repost.embeddedNote])
            notifByIdRef.current.set(evId, {
              id: evId,
              kind: 'repost',
              actorPubkey: actor,
              createdAt: repost.repostedAt,
              targetNoteId: repost.targetNoteId,
            })
            ensureProfiles([actor])
            ensureNotes([repost.targetNoteId])
            scheduleFlush()
            return
          }

          if (ev.kind === KIND_AGORA_REACTION) {
            if (ev.content.trim() === '-') return
            let targetId: string | undefined
            for (let i = ev.tags.length - 1; i >= 0; i -= 1) {
              if (ev.tags[i]?.[0] === 'e' && isHex64(ev.tags[i][1])) {
                targetId = ev.tags[i][1].toLowerCase()
                break
              }
            }
            notifByIdRef.current.set(evId, {
              id: evId,
              kind: 'like',
              actorPubkey: actor,
              createdAt: ev.created_at,
              targetNoteId: targetId,
              content: ev.content.trim().slice(0, 16) || '+',
            })
            ensureProfiles([actor])
            if (targetId) ensureNotes([targetId])
            scheduleFlush()
          }
        },
      }
    )

    return () => {
      unsub()
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer)
      }
    }
  }, [active, myPubkey, relayPool, ensureProfiles, ensureNotes, ingestNotesBatch])

  // 3. Active feed subscription (`following`, `global`, `trending`, `bookmarks`)
  const followingKey = useMemo(
    () => followingPubkeys.slice(0, 250).join(','),
    [followingPubkeys]
  )

  useEffect(() => {
    if (!active) return

    pendingItemsRef.current.clear()
    setPendingNewCount(0)

    if (activeTab === 'notifications') {
      setLoadingFeed(false)
      return
    }

    if (activeTab === 'bookmarks') {
      setLoadingFeed(false)
      if (bookmarkedRef.current.length > 0) {
        ensureNotes(bookmarkedRef.current)
        ensureStatsForNotes(bookmarkedRef.current)
      }
      return
    }

    const relays = socialRelaysRef.current

    if (activeTab === 'trending') {
      setLoadingFeed(true)
      const sinceSec = Math.floor(Date.now() / 1000) - 24 * 3600
      const collected = new Map<string, AgoraNote>()
      const { promise, cancel } = queryOneShot(
        'trending',
        relays,
        [{ kinds: [KIND_AGORA_NOTE], since: sinceSec, limit: 100 }],
        {
          timeoutMs: 4200,
          targetEose: Math.min(3, relays.length),
          onEvent: (ev) => {
            const note = parseAgoraNote(ev)
            if (!note || note.isReply) return
            if (blockedSetRef.current.has(note.pubkey)) return
            if (!collected.has(note.id)) {
              collected.set(note.id, note)
            }
          },
        }
      )

      let cancelled = false
      void promise.then(() => {
        if (cancelled) return
        const notes = Array.from(collected.values())
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 120)
        ingestNotesBatch(notes)
        setTrendingCandidates(notes)
        warmDependenciesForNotes(notes)
        setLoadingFeed(false)
      })

      return () => {
        cancelled = true
        cancel()
      }
    }

    // `following` or `global` live calm feed
    if (activeTab === 'following' && followingRef.current.length === 0) {
      setLoadingFeed(false)
      // Background discovery warmup so Trending Hashtags & Suggested Voices populate for new users
      if (!discoveryWarmedRef.current) {
        discoveryWarmedRef.current = true
        const found: AgoraNote[] = []
        const seen = new Set<string>()
        const { promise } = queryOneShot(
          'discover-warm',
          relays,
          [{ kinds: [KIND_AGORA_NOTE], limit: 45 }],
          {
            timeoutMs: 3600,
            targetEose: Math.min(2, relays.length),
            onEvent: (ev) => {
              const note = parseAgoraNote(ev)
              if (!note || note.isReply || seen.has(note.id)) return
              if (blockedSetRef.current.has(note.pubkey)) return
              seen.add(note.id)
              found.push(note)
            },
          }
        )
        void promise.then(() => {
          if (found.length > 0) {
            ingestNotesBatch(found)
            warmDependenciesForNotes(found)
          }
        })
      }
      return
    }

    setLoadingFeed(true)
    setHasMoreByTab((prev) => ({ ...prev, [activeTab]: true }))

    const authors =
      activeTab === 'following'
        ? Array.from(new Set([...followingRef.current.slice(0, 240), myPubkeyRef.current]))
        : undefined

    const filters: Filter[] =
      activeTab === 'following'
        ? [{ kinds: [KIND_AGORA_NOTE, KIND_AGORA_REPOST], authors, limit: 70 }]
        : [{ kinds: [KIND_AGORA_NOTE], limit: 70 }]

    let initialHydrated = false
    let eoseCount = 0
    const targetEose = Math.max(1, Math.min(2, relays.length))
    const backfillBuffer: AgoraFeedItem[] = []
    let backfillFlushTimer: number | null = null
    let topSortAt = 0

    const flushBackfill = () => {
      backfillFlushTimer = null
      if (backfillBuffer.length === 0) return
      const chunk = backfillBuffer.splice(0, backfillBuffer.length)
      const notes = chunk.map((i) => i.note)
      const extraPks = chunk
        .map((i) => i.repostedBy)
        .filter((pk): pk is string => Boolean(pk))
      ingestNotesBatch(notes)
      warmDependenciesForNotes(notes, extraPks)

      for (const item of chunk) {
        if (item.sortAt > topSortAt) topSortAt = item.sortAt
      }

      const setter = activeTab === 'following' ? setFollowingItems : setGlobalItems
      setter((prev) => mergeFeedItems(prev, chunk, blockedSetRef.current))
    }

    const markHydrated = () => {
      if (initialHydrated) return
      initialHydrated = true
      flushBackfill()
      setLoadingFeed(false)
    }

    const graceTimer = window.setTimeout(markHydrated, LIVE_BUFFER_GRACE_MS)

    const handleFeedItem = (item: AgoraFeedItem) => {
      if (blockedSetRef.current.has(item.note.pubkey)) return
      if (item.repostedBy && blockedSetRef.current.has(item.repostedBy)) return

      const isOwnPost =
        item.note.pubkey === myPubkeyRef.current || item.repostedBy === myPubkeyRef.current

      if (!initialHydrated || isOwnPost) {
        backfillBuffer.push(item)
        if (backfillFlushTimer === null) {
          backfillFlushTimer = window.setTimeout(flushBackfill, 110)
        }
        return
      }

      // Calm feed: buffer live arrivals newer than the top item so reading never jumps
      if (item.sortAt >= topSortAt - 5) {
        ingestNotesBatch([item.note])
        if (!pendingItemsRef.current.has(item.key)) {
          pendingItemsRef.current.set(item.key, item)
          setPendingNewCount(pendingItemsRef.current.size)
        }
      } else {
        backfillBuffer.push(item)
        if (backfillFlushTimer === null) {
          backfillFlushTimer = window.setTimeout(flushBackfill, 200)
        }
      }
    }

    const unsub = relayPool.subscribe(`ag-feed-${activeTab}`, relays, filters, {
      onEvent: (ev) => {
        if (ev.kind === KIND_AGORA_NOTE) {
          const note = parseAgoraNote(ev)
          if (!note) return
          if (note.isReply) return
          handleFeedItem({
            key: `note:${note.id}`,
            kind: 'note',
            note,
            sortAt: note.createdAt,
          })
        } else if (ev.kind === KIND_AGORA_REPOST) {
          const repost = parseAgoraRepost(ev)
          if (!repost) return
          if (blockedSetRef.current.has(repost.repostedBy)) return
          const targetNote = repost.embeddedNote ?? notesRef.current[repost.targetNoteId]
          if (targetNote) {
            handleFeedItem({
              key: `repost:${repost.repostedBy}:${targetNote.id}`,
              kind: 'repost',
              note: targetNote,
              repostedBy: repost.repostedBy,
              repostedAt: repost.repostedAt,
              sortAt: repost.repostedAt,
            })
          } else {
            const existingList = pendingRepostsByTargetRef.current.get(repost.targetNoteId) ?? []
            if (!existingList.some((e) => e.repostedBy === repost.repostedBy)) {
              existingList.push({
                repostedBy: repost.repostedBy,
                repostedAt: repost.repostedAt,
              })
              pendingRepostsByTargetRef.current.set(repost.targetNoteId, existingList.slice(0, 6))
            }
            ensureNotes([repost.targetNoteId])
          }
        }
      },
      onEose: () => {
        eoseCount += 1
        if (eoseCount >= targetEose) {
          markHydrated()
        }
      },
    })

    return () => {
      window.clearTimeout(graceTimer)
      if (backfillFlushTimer !== null) window.clearTimeout(backfillFlushTimer)
      unsub()
    }
  }, [
    active,
    activeTab,
    followingKey,
    refreshNonce,
    relayPool,
    queryOneShot,
    ingestNotesBatch,
    warmDependenciesForNotes,
    ensureNotes,
    ensureStatsForNotes,
  ])

  const setActiveTab = useCallback((tab: AgoraFeedTab) => {
    setActiveTabState(tab)
    pendingItemsRef.current.clear()
    setPendingNewCount(0)
  }, [])

  const flushPendingNotes = useCallback(() => {
    if (pendingItemsRef.current.size === 0) return
    const items = Array.from(pendingItemsRef.current.values())
    pendingItemsRef.current.clear()
    setPendingNewCount(0)

    const notes = items.map((i) => i.note)
    const extraPks = items.map((i) => i.repostedBy).filter((pk): pk is string => Boolean(pk))
    ingestNotesBatch(notes)
    warmDependenciesForNotes(notes, extraPks)

    const tab = activeTabRef.current
    if (tab === 'following') {
      setFollowingItems((prev) => mergeFeedItems(prev, items, blockedSetRef.current))
    } else if (tab === 'global') {
      setGlobalItems((prev) => mergeFeedItems(prev, items, blockedSetRef.current))
    }
  }, [ingestNotesBatch, warmDependenciesForNotes])

  const refresh = useCallback(() => {
    pendingItemsRef.current.clear()
    setPendingNewCount(0)
    setRefreshNonce((n) => n + 1)
  }, [])

  // Computed visible feedItems per active tab (always filtering blockedPubkeys)
  const feedItems = useMemo<AgoraFeedItem[]>(() => {
    if (activeTab === 'following') {
      return followingItems.filter(
        (item) =>
          !blockedSet.has(item.note.pubkey) &&
          (!item.repostedBy || !blockedSet.has(item.repostedBy))
      )
    }
    if (activeTab === 'global') {
      return globalItems.filter((item) => !blockedSet.has(item.note.pubkey))
    }
    if (activeTab === 'trending') {
      const nowSec = Math.floor(Date.now() / 1000)
      return trendingCandidates
        .filter((note) => !blockedSet.has(note.pubkey))
        .map((note) => ({
          note,
          score: computeTrendingScore(note, statsByNoteId[note.id], nowSec),
        }))
        .sort((a, b) => b.score - a.score || b.note.createdAt - a.note.createdAt)
        .map(({ note }) => ({
          key: `note:${note.id}`,
          kind: 'note' as const,
          note,
          sortAt: note.createdAt,
        }))
    }
    if (activeTab === 'bookmarks') {
      const items: AgoraFeedItem[] = []
      for (const id of bookmarkedIds) {
        const note = notesById[id]
        if (!note || blockedSet.has(note.pubkey)) continue
        items.push({
          key: `note:${note.id}`,
          kind: 'note',
          note,
          sortAt: note.createdAt,
        })
      }
      return items
    }
    return []
  }, [
    activeTab,
    followingItems,
    globalItems,
    trendingCandidates,
    statsByNoteId,
    bookmarkedIds,
    notesById,
    blockedSet,
  ])

  const hasMore = Boolean(hasMoreByTab[activeTab])

  const loadMore = useCallback(async () => {
    const tab = activeTabRef.current
    if (tab !== 'following' && tab !== 'global') return
    const current = tab === 'following' ? followingItems : globalItems
    if (current.length === 0 || loadingMore) return

    let oldestSortAt = current[0].sortAt
    for (const item of current) {
      if (item.sortAt < oldestSortAt) oldestSortAt = item.sortAt
    }
    if (oldestSortAt <= 1) {
      setHasMoreByTab((prev) => ({ ...prev, [tab]: false }))
      return
    }

    setLoadingMore(true)
    const relays = socialRelaysRef.current
    const until = oldestSortAt - 1
    const filters: Filter[] =
      tab === 'following'
        ? [
            {
              kinds: [KIND_AGORA_NOTE, KIND_AGORA_REPOST],
              authors: Array.from(
                new Set([...followingRef.current.slice(0, 240), myPubkeyRef.current])
              ),
              until,
              limit: 45,
            },
          ]
        : [{ kinds: [KIND_AGORA_NOTE], until, limit: 45 }]

    const existingKeys = new Set(current.map((i) => i.key))
    const fetched: AgoraFeedItem[] = []
    const fetchedKeys = new Set<string>()

    const { promise } = queryOneShot('more', relays, filters, {
      timeoutMs: 4200,
      targetEose: Math.min(2, relays.length),
      onEvent: (ev) => {
        if (ev.kind === KIND_AGORA_NOTE) {
          const note = parseAgoraNote(ev)
          if (!note || note.isReply || blockedSetRef.current.has(note.pubkey)) return
          const key = `note:${note.id}`
          if (existingKeys.has(key) || fetchedKeys.has(key)) return
          fetchedKeys.add(key)
          fetched.push({ key, kind: 'note', note, sortAt: note.createdAt })
        } else if (ev.kind === KIND_AGORA_REPOST) {
          const repost = parseAgoraRepost(ev)
          if (!repost || blockedSetRef.current.has(repost.repostedBy)) return
          const target = repost.embeddedNote ?? notesRef.current[repost.targetNoteId]
          if (!target || blockedSetRef.current.has(target.pubkey)) return
          const key = `repost:${repost.repostedBy}:${target.id}`
          if (existingKeys.has(key) || fetchedKeys.has(key)) return
          fetchedKeys.add(key)
          fetched.push({
            key,
            kind: 'repost',
            note: target,
            repostedBy: repost.repostedBy,
            repostedAt: repost.repostedAt,
            sortAt: repost.repostedAt,
          })
        }
      },
    })

    try {
      await promise
      if (fetched.length === 0) {
        setHasMoreByTab((prev) => ({ ...prev, [tab]: false }))
      } else {
        const notes = fetched.map((i) => i.note)
        const extraPks = fetched
          .map((i) => i.repostedBy)
          .filter((pk): pk is string => Boolean(pk))
        ingestNotesBatch(notes)
        warmDependenciesForNotes(notes, extraPks)
        const setter = tab === 'following' ? setFollowingItems : setGlobalItems
        setter((prev) =>
          mergeFeedItems(prev, fetched, blockedSetRef.current, Math.max(MAX_FEED_ITEMS, prev.length + 50))
        )
      }
    } finally {
      setLoadingMore(false)
    }
  }, [followingItems, globalItems, loadingMore, queryOneShot, ingestNotesBatch, warmDependenciesForNotes])

  // Lookups
  const getProfile = useCallback((pubkey: string): AgoraProfile | null => {
    if (!pubkey) return null
    return profilesRef.current[pubkey.toLowerCase()] ?? null
  }, [])

  const getNote = useCallback((noteId: string): AgoraNote | null => {
    if (!noteId) return null
    return notesRef.current[noteId.toLowerCase()] ?? null
  }, [])

  const getNoteStats = useCallback(
    (noteId: string): AgoraNoteStats => {
      if (!noteId) return EMPTY_NOTE_STATS
      return statsByNoteId[noteId.toLowerCase()] ?? EMPTY_NOTE_STATS
    },
    [statsByNoteId]
  )

  const isFollowing = useCallback(
    (pubkey: string): boolean => followingSet.has(pubkey.toLowerCase()),
    [followingSet]
  )

  const isBookmarked = useCallback(
    (noteId: string): boolean => bookmarkedSet.has(noteId.toLowerCase()),
    [bookmarkedSet]
  )

  // Filtered notifications & unread counter
  const visibleNotifications = useMemo(
    () => notifications.filter((n) => !blockedSet.has(n.actorPubkey)),
    [notifications, blockedSet]
  )

  const unreadNotificationCount = useMemo(() => {
    let count = 0
    for (const n of visibleNotifications) {
      if (n.createdAt > lastNotifReadAt) count += 1
    }
    return count
  }, [visibleNotifications, lastNotifReadAt])

  const markNotificationsRead = useCallback(() => {
    const nowSec = Math.floor(Date.now() / 1000)
    const newest = visibleNotifications[0]?.createdAt ?? 0
    const nextReadAt = Math.max(nowSec, newest)
    setLastNotifReadAt(nextReadAt)
    saveNotifReadAt(nextReadAt)
  }, [visibleNotifications])

  // Publishing & social mutations
  const publishNoteInternal = useCallback(
    async (
      content: string,
      opts?: AgoraPublishNoteOptions & { replyTo?: AgoraNote | null; quoteNote?: AgoraNote | null }
    ): Promise<AgoraActionResult> => {
      const hasMedia = Boolean(opts?.media && opts.media.length > 0)
      if (!content.trim() && !hasMedia && !opts?.quoteNote) {
        return { ok: false, publishedRelays: 0, error: 'Write a message or attach media first.' }
      }
      setPublishing(true)
      try {
        const relays = writeRelaysRef.current
        const template = buildAgoraNoteTemplate({
          content,
          replyTo: opts?.replyTo,
          quoteNote: opts?.quoteNote,
          media: opts?.media,
          contentWarning: opts?.contentWarning,
          hashtags: opts?.hashtags,
          relayHint: relays[0],
        })
        const signed = await signMasterEvent(template)
        const res = await relayPool.publish(relays, signed)
        const parsed = parseAgoraNote(signed)
        if (parsed) {
          ingestNotesBatch([parsed])
          if (!parsed.isReply) {
            const feedItem: AgoraFeedItem = {
              key: `note:${parsed.id}`,
              kind: 'note',
              note: parsed,
              sortAt: parsed.createdAt,
            }
            setFollowingItems((prev) => mergeFeedItems([feedItem], prev, blockedSetRef.current))
            setGlobalItems((prev) => mergeFeedItems([feedItem], prev, blockedSetRef.current))
            setProfileView((prev) => {
              if (!prev || prev.pubkey !== parsed.pubkey) return prev
              if (prev.posts.some((n) => n.id === parsed.id)) return prev
              return { ...prev, posts: [parsed, ...prev.posts] }
            })
          } else if (opts?.replyTo) {
            const bucket = getOrCreateBucket(opts.replyTo.id)
            bucket.replyIds.add(parsed.id)
            dirtyStatsIdsRef.current.add(opts.replyTo.id)
            flushDirtyStats()

            setThread((prev) => {
              if (!prev) return prev
              const matchesThread =
                prev.focusedNoteId === opts.replyTo!.id ||
                prev.rootNoteId === opts.replyTo!.id ||
                prev.rootNoteId === parsed.rootId
              if (!matchesThread) return prev
              if (prev.replies.some((r) => r.id === parsed.id)) return prev
              return {
                ...prev,
                replies: [...prev.replies, parsed].sort((a, b) => a.createdAt - b.createdAt),
              }
            })
            setProfileView((prev) => {
              if (!prev || prev.pubkey !== parsed.pubkey) return prev
              if (prev.replies.some((n) => n.id === parsed.id)) return prev
              return { ...prev, replies: [parsed, ...prev.replies] }
            })
          }
        }
        return {
          ok: res.acceptedRelays.length > 0 || res.sentCount > 0,
          eventId: signed.id,
          note: parsed ?? undefined,
          publishedRelays: res.acceptedRelays.length,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to publish note.'
        pushToastRef.current?.('error', 'Failed to publish note', msg)
        return { ok: false, publishedRelays: 0, error: msg }
      } finally {
        setPublishing(false)
      }
    },
    [flushDirtyStats, getOrCreateBucket, ingestNotesBatch, relayPool, signMasterEvent]
  )

  const publishNote = useCallback(
    async (content: string, opts?: AgoraPublishNoteOptions): Promise<AgoraActionResult> =>
      await publishNoteInternal(content, opts),
    [publishNoteInternal]
  )

  const replyToNote = useCallback(
    async (
      parentNote: AgoraNote,
      content: string,
      opts?: AgoraPublishNoteOptions
    ): Promise<AgoraActionResult> =>
      await publishNoteInternal(content, { ...opts, replyTo: parentNote }),
    [publishNoteInternal]
  )

  const quoteNote = useCallback(
    async (
      quotedNote: AgoraNote,
      content: string,
      opts?: AgoraPublishNoteOptions
    ): Promise<AgoraActionResult> =>
      await publishNoteInternal(content, { ...opts, quoteNote: quotedNote }),
    [publishNoteInternal]
  )

  const repostNote = useCallback(
    async (note: AgoraNote): Promise<AgoraActionResult> => {
      try {
        const relays = writeRelaysRef.current
        const bucket = getOrCreateBucket(note.id)
        bucket.reposters.add(myPubkeyRef.current)
        dirtyStatsIdsRef.current.add(note.id)
        flushDirtyStats()

        const template = buildRepostTemplate(note, relays[0])
        const signed = await signMasterEvent(template)
        const res = await relayPool.publish(relays, signed)
        return {
          ok: res.acceptedRelays.length > 0 || res.sentCount > 0,
          eventId: signed.id,
          publishedRelays: res.acceptedRelays.length,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to repost note.'
        pushToastRef.current?.('error', 'Repost failed', msg)
        return { ok: false, publishedRelays: 0, error: msg }
      }
    },
    [flushDirtyStats, getOrCreateBucket, relayPool, signMasterEvent]
  )

  const toggleLike = useCallback(
    async (note: AgoraNote): Promise<boolean> => {
      const pk = myPubkeyRef.current
      const bucket = getOrCreateBucket(note.id)
      const currentlyLiked = !bucket.myUnliked && bucket.likers.has(pk)

      if (currentlyLiked) {
        bucket.likers.delete(pk)
        bucket.myUnliked = true
        dirtyStatsIdsRef.current.add(note.id)
        flushDirtyStats()

        const likeEvId = bucket.myLikeEventId
        bucket.myLikeEventId = undefined
        if (likeEvId) {
          try {
            const del = await signMasterEvent(buildDeletionTemplate(likeEvId, KIND_AGORA_REACTION))
            await relayPool.publish(writeRelaysRef.current, del)
          } catch {
            // Keep optimistic unlike even if relay ignores deletion
          }
        }
        return false
      }

      bucket.likers.add(pk)
      bucket.myUnliked = false
      dirtyStatsIdsRef.current.add(note.id)
      flushDirtyStats()

      try {
        const signed = await signMasterEvent(buildReactionLikeTemplate(note))
        bucket.myLikeEventId = signed.id.toLowerCase()
        await relayPool.publish(writeRelaysRef.current, signed)
        return true
      } catch (err) {
        bucket.likers.delete(pk)
        dirtyStatsIdsRef.current.add(note.id)
        flushDirtyStats()
        const msg = err instanceof Error ? err.message : 'Could not sign reaction.'
        pushToastRef.current?.('error', 'Like failed', msg)
        return false
      }
    },
    [flushDirtyStats, getOrCreateBucket, relayPool, signMasterEvent]
  )

  const toggleBookmark = useCallback(
    async (noteId: string): Promise<boolean> => {
      if (!isHex64(noteId)) return false
      const id = noteId.toLowerCase()
      const prev = bookmarkedRef.current
      const exists = prev.includes(id)
      const next = exists
        ? prev.filter((item) => item !== id)
        : [id, ...prev].slice(0, MAX_CACHED_BOOKMARKS)

      bookmarkedRef.current = next
      setBookmarkedIds(next)
      saveCachedBookmarks(next)

      try {
        const template = buildBookmarkListTemplate(next, myBookmarkEventRef.current)
        const signed = await signMasterEvent(template)
        myBookmarkEventRef.current = signed
        await relayPool.publish(writeRelaysRef.current, signed)
        return !exists
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Bookmark saved locally; relay publish failed.'
        pushToastRef.current?.('warning', 'Bookmark saved locally', msg)
        return !exists
      }
    },
    [relayPool, signMasterEvent]
  )

  const toggleFollow = useCallback(
    async (pubkey: string): Promise<boolean> => {
      if (!isHex64(pubkey)) return false
      const pk = pubkey.toLowerCase()
      if (pk === myPubkeyRef.current) return false

      const prev = followingRef.current
      const exists = prev.includes(pk)
      const next = exists ? prev.filter((item) => item !== pk) : [pk, ...prev]

      followingRef.current = next
      setFollowingPubkeys(next)

      try {
        const template = buildFollowListTemplate(next, myFollowEventRef.current)
        const signed = await signMasterEvent(template)
        myFollowEventRef.current = signed
        await relayPool.publish(writeRelaysRef.current, signed)
        return !exists
      } catch (err) {
        followingRef.current = prev
        setFollowingPubkeys(prev)
        const msg = err instanceof Error ? err.message : 'Could not update follow list.'
        pushToastRef.current?.('error', 'Follow update failed', msg)
        return exists
      }
    },
    [relayPool, signMasterEvent]
  )

  const updateMyProfile = useCallback(
    async (draft: AgoraProfileDraft): Promise<AgoraActionResult> => {
      setPublishing(true)
      try {
        const existing = profilesRef.current[myPubkeyRef.current]
        const template = buildProfileMetadataTemplate(draft, existing?.rawJson)
        const signed = await signMasterEvent(template)
        const relays = Array.from(new Set([...writeRelaysRef.current, ...AGORA_PROFILE_RELAYS]))
        const res = await relayPool.publish(relays, signed)
        const parsed = parseAgoraProfile(signed)
        if (parsed) {
          ingestProfilesBatch([parsed])
        }
        const ok = res.acceptedRelays.length > 0 || res.sentCount > 0
        if (ok) {
          const savedName = (draft.displayName?.trim() || draft.name?.trim() || '').slice(0, 32)
          if (savedName) {
            onProfileNameSavedRef.current?.(savedName)
          }
        }
        return {
          ok,
          eventId: signed.id,
          publishedRelays: res.acceptedRelays.length,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to update profile.'
        pushToastRef.current?.('error', 'Profile update failed', msg)
        return { ok: false, publishedRelays: 0, error: msg }
      } finally {
        setPublishing(false)
      }
    },
    [ingestProfilesBatch, relayPool, signMasterEvent]
  )

  const recordOptimisticZap = useCallback(
    (noteId: string, amountSats: number) => {
      if (!isHex64(noteId) || !Number.isFinite(amountSats) || amountSats <= 0) return
      const id = noteId.toLowerCase()
      const bucket = getOrCreateBucket(id)
      bucket.optimisticZapSats += Math.round(amountSats)
      bucket.optimisticZapCount += 1
      bucket.optimisticZappedByMe = true
      dirtyStatsIdsRef.current.add(id)
      flushDirtyStats()
    },
    [flushDirtyStats, getOrCreateBucket]
  )

  const uploadMedia = useCallback(
    async (
      file: File | Blob,
      opts?: { alt?: string; mime?: string }
    ): Promise<AgoraUploadedMedia> => {
      if (file.size <= 0) {
        throw new Error('Selected media file is empty.')
      }
      if (file.size > MAX_MEDIA_BLOB_BYTES) {
        throw new Error('Media attachment exceeds the 15 MiB limit.')
      }
      const mime = cleanMimeType(opts?.mime || file.type || 'image/jpeg')
      const kind: 'image' | 'video' | null = mime.startsWith('image/')
        ? 'image'
        : mime.startsWith('video/')
          ? 'video'
          : null
      if (!kind) {
        throw new Error('Only image and video uploads are supported on Agora.')
      }

      setUploadingMedia(true)
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const dim = kind === 'image' ? await detectImageDimensions(file) : undefined
        const servers =
          blossomServersRef.current.length > 0
            ? blossomServersRef.current
            : DEFAULT_BLOSSOM_SERVERS

        const uploaded = await uploadBlobToBlossom({
          bytes,
          mime,
          servers,
          signAuthEvent: signMasterEvent,
        })

        return {
          url: uploaded.url,
          kind,
          mime: uploaded.mime,
          sha256: uploaded.sha256,
          size: uploaded.size,
          alt: opts?.alt?.trim() ? opts.alt.trim().slice(0, 280) : undefined,
          dim,
        }
      } finally {
        setUploadingMedia(false)
      }
    },
    [signMasterEvent]
  )

  // Thread Viewer (`openThread`, `closeThread`)
  const openThread = useCallback(
    (noteId: string) => {
      if (!isHex64(noteId)) return
      const id = noteId.toLowerCase()
      const gen = ++threadGenRef.current
      const cached = notesRef.current[id] ?? null
      const initialRootId = cached?.rootId ?? id

      setThread({
        rootNoteId: initialRootId,
        focusedNoteId: id,
        ancestors: [],
        focusedNote: cached,
        replies: [],
        loading: true,
      })

      void (async () => {
        const relays = socialRelaysRef.current
        let focused = cached

        if (!focused) {
          const { promise } = queryOneShot('thread-focus', relays, [{ ids: [id] }], {
            timeoutMs: 3800,
            targetEose: Math.min(2, relays.length),
            onEvent: (ev) => {
              const parsed = parseAgoraNote(ev)
              if (parsed && parsed.id === id) {
                focused = parsed
              }
            },
          })
          await promise
          if (threadGenRef.current !== gen) return
          if (focused) {
            ingestNotesBatch([focused])
          }
        }

        const rootId = focused?.rootId ?? id
        const fetchIds = new Set<string>([rootId])
        if (focused?.replyToId) fetchIds.add(focused.replyToId)
        for (const existingId of Array.from(fetchIds)) {
          if (notesRef.current[existingId]) fetchIds.delete(existingId)
        }

        const replyTargets = Array.from(new Set([rootId, id]))
        const threadFilters: Filter[] = [
          { kinds: [KIND_AGORA_NOTE], '#e': replyTargets, limit: 140 },
        ]
        if (fetchIds.size > 0) {
          threadFilters.push({ ids: Array.from(fetchIds) })
        }

        const foundMap = new Map<string, AgoraNote>()
        if (focused) foundMap.set(focused.id, focused)
        for (const existing of Object.values(notesRef.current)) {
          if (
            existing.id === rootId ||
            existing.id === focused?.replyToId ||
            existing.replyToId === id ||
            existing.rootId === rootId
          ) {
            foundMap.set(existing.id, existing)
          }
        }

        const { promise } = queryOneShot('thread-tree', relays, threadFilters, {
          timeoutMs: 4200,
          targetEose: Math.min(2, relays.length),
          onEvent: (ev) => {
            const parsed = parseAgoraNote(ev)
            if (!parsed) return
            if (blockedSetRef.current.has(parsed.pubkey)) return
            foundMap.set(parsed.id, parsed)
          },
        })
        await promise
        if (threadGenRef.current !== gen) return

        const allFound = Array.from(foundMap.values())
        ingestNotesBatch(allFound)

        // Fetch any intermediate missing ancestor links (up to 1 extra hop)
        const extraMissing = new Set<string>()
        let probe = focused
        const walkGuard = new Set<string>()
        while (probe?.replyToId && !walkGuard.has(probe.replyToId) && walkGuard.size < 12) {
          walkGuard.add(probe.replyToId)
          const parent = foundMap.get(probe.replyToId) ?? notesRef.current[probe.replyToId]
          if (!parent) {
            extraMissing.add(probe.replyToId)
            break
          }
          probe = parent
        }
        if (extraMissing.size > 0) {
          const { promise: ancPromise } = queryOneShot(
            'thread-anc',
            relays,
            [{ ids: Array.from(extraMissing) }],
            {
              timeoutMs: 2800,
              targetEose: 1,
              onEvent: (ev) => {
                const parsed = parseAgoraNote(ev)
                if (parsed && !blockedSetRef.current.has(parsed.pubkey)) {
                  foundMap.set(parsed.id, parsed)
                }
              },
            }
          )
          await ancPromise
          if (threadGenRef.current !== gen) return
          ingestNotesBatch(Array.from(foundMap.values()))
        }

        // Assemble ordered ancestor chain (root -> ... -> direct parent)
        const ancestors: AgoraNote[] = []
        const seenAnc = new Set<string>([id])
        let cursor = focused?.replyToId
        while (cursor && !seenAnc.has(cursor) && ancestors.length < 16) {
          seenAnc.add(cursor)
          const parent = foundMap.get(cursor) ?? notesRef.current[cursor]
          if (!parent) break
          if (!blockedSetRef.current.has(parent.pubkey)) {
            ancestors.unshift(parent)
          }
          cursor = parent.replyToId
        }
        if (
          rootId !== id &&
          !seenAnc.has(rootId) &&
          (foundMap.has(rootId) || notesRef.current[rootId])
        ) {
          const rootNote = foundMap.get(rootId) ?? notesRef.current[rootId]
          if (rootNote && !blockedSetRef.current.has(rootNote.pubkey)) {
            ancestors.unshift(rootNote)
            seenAnc.add(rootId)
          }
        }

        const replies = Array.from(foundMap.values())
          .filter((n) => {
            if (n.id === id || seenAnc.has(n.id)) return false
            if (blockedSetRef.current.has(n.pubkey)) return false
            return n.replyToId === id || (rootId === id && n.rootId === id)
          })
          .sort((a, b) => a.createdAt - b.createdAt)

        warmDependenciesForNotes([...ancestors, ...(focused ? [focused] : []), ...replies])

        setThread({
          rootNoteId: rootId,
          focusedNoteId: id,
          ancestors,
          focusedNote: focused,
          replies,
          loading: false,
        })
      })()
    },
    [ingestNotesBatch, queryOneShot, warmDependenciesForNotes]
  )

  const closeThread = useCallback(() => {
    threadGenRef.current += 1
    setThread(null)
  }, [])

  // Profile Viewer (`openProfile`, `setProfileTab`, `closeProfile`)
  const openProfile = useCallback(
    (pubkey: string) => {
      if (!isHex64(pubkey)) return
      const pk = pubkey.toLowerCase()
      const gen = ++profileViewGenRef.current

      // Seed immediately from cached notes for instant paint
      const cachedAuthorNotes = Object.values(notesRef.current)
        .filter((n) => n.pubkey === pk)
        .sort((a, b) => b.createdAt - a.createdAt)

      setProfileView({
        pubkey: pk,
        tab: 'posts',
        posts: cachedAuthorNotes.filter((n) => !n.isReply),
        replies: cachedAuthorNotes.filter((n) => n.isReply),
        likes: [],
        followingPubkeys: pk === myPubkeyRef.current ? followingRef.current : [],
        loading: true,
      })

      ensureProfiles([pk], true)

      void (async () => {
        const relays = socialRelaysRef.current
        const noteMap = new Map<string, AgoraNote>()
        for (const n of cachedAuthorNotes) noteMap.set(n.id, n)

        let bestFollowEv: NostrEvent | null = null
        const likedOrder: string[] = []
        const likedSet = new Set<string>()

        const { promise } = queryOneShot(
          'prof-view',
          relays,
          [
            { kinds: [KIND_AGORA_NOTE], authors: [pk], limit: 80 },
            { kinds: [KIND_AGORA_FOLLOW_LIST], authors: [pk], limit: 2 },
            { kinds: [KIND_AGORA_REACTION], authors: [pk], limit: 40 },
          ],
          {
            timeoutMs: 4200,
            targetEose: Math.min(2, relays.length),
            onEvent: (ev) => {
              if (ev.pubkey.toLowerCase() !== pk) return
              if (ev.kind === KIND_AGORA_NOTE) {
                const parsed = parseAgoraNote(ev)
                if (parsed) noteMap.set(parsed.id, parsed)
              } else if (ev.kind === KIND_AGORA_FOLLOW_LIST) {
                if (!bestFollowEv || ev.created_at > bestFollowEv.created_at) {
                  bestFollowEv = ev
                }
              } else if (ev.kind === KIND_AGORA_REACTION) {
                if (ev.content.trim() === '-') return
                for (let i = ev.tags.length - 1; i >= 0; i -= 1) {
                  if (ev.tags[i]?.[0] === 'e' && isHex64(ev.tags[i][1])) {
                    const id = ev.tags[i][1].toLowerCase()
                    if (!likedSet.has(id)) {
                      likedSet.add(id)
                      likedOrder.push(id)
                    }
                    break
                  }
                }
              }
            },
          }
        )

        await promise
        if (profileViewGenRef.current !== gen) return

        const allNotes = Array.from(noteMap.values()).sort((a, b) => b.createdAt - a.createdAt)
        ingestNotesBatch(allNotes)
        warmDependenciesForNotes(allNotes)

        const parsedFollows = bestFollowEv ? parseFollowList(bestFollowEv)?.pubkeys ?? [] : []
        const posts = allNotes.filter((n) => !n.isReply)
        const replies = allNotes.filter((n) => n.isReply)

        // Fetch any missing liked notes (top 30)
        const targetLikeIds = likedOrder.slice(0, 30)
        const missingLikeIds = targetLikeIds.filter((id) => !notesRef.current[id])
        if (missingLikeIds.length > 0) {
          const likedFound: AgoraNote[] = []
          const { promise: likesPromise } = queryOneShot(
            'prof-likes',
            relays,
            [{ ids: missingLikeIds }],
            {
              timeoutMs: 3200,
              targetEose: Math.min(2, relays.length),
              onEvent: (ev) => {
                const parsed = parseAgoraNote(ev)
                if (parsed && !blockedSetRef.current.has(parsed.pubkey)) {
                  likedFound.push(parsed)
                }
              },
            }
          )
          await likesPromise
          if (profileViewGenRef.current !== gen) return
          if (likedFound.length > 0) {
            ingestNotesBatch(likedFound)
            warmDependenciesForNotes(likedFound)
          }
        }

        const likes: AgoraNote[] = []
        for (const id of targetLikeIds) {
          const n = notesRef.current[id]
          if (n && !blockedSetRef.current.has(n.pubkey)) {
            likes.push(n)
          }
        }

        setProfileView((prev) => {
          if (!prev || prev.pubkey !== pk) return prev
          return {
            ...prev,
            posts,
            replies,
            likes,
            followingPubkeys:
              parsedFollows.length > 0
                ? parsedFollows
                : pk === myPubkeyRef.current
                  ? followingRef.current
                  : prev.followingPubkeys,
            loading: false,
          }
        })
      })()
    },
    [ensureProfiles, ingestNotesBatch, queryOneShot, warmDependenciesForNotes]
  )

  const setProfileTab = useCallback((tab: AgoraProfileTab) => {
    setProfileView((prev) => (prev ? { ...prev, tab } : null))
  }, [])

  const closeProfile = useCallback(() => {
    profileViewGenRef.current += 1
    setProfileView(null)
  }, [])

  // Search & Hashtag explorer
  const clearSearch = useCallback(() => {
    searchGenRef.current += 1
    setSearchQuery('')
    setActiveHashtag(null)
    setSearchResults([])
    setSearchProfiles([])
    setSearchLoading(false)
  }, [])

  const selectHashtag = useCallback(
    (rawTag: string) => {
      const clean = normalizeHashtag(rawTag)
      if (!clean) return
      const gen = ++searchGenRef.current
      setSearchQuery('')
      setActiveHashtag(clean)
      setSearchProfiles([])
      setSearchLoading(true)

      // Immediate local matches for instant response
      const localMatches = Object.values(notesRef.current)
        .filter((n) => !blockedSetRef.current.has(n.pubkey) && n.hashtags.includes(clean))
        .sort((a, b) => b.createdAt - a.createdAt)
      setSearchResults(localMatches)

      const relays = socialRelaysRef.current
      const byId = new Map<string, AgoraNote>()
      for (const n of localMatches) byId.set(n.id, n)

      const { promise } = queryOneShot(
        'hashtag',
        relays,
        [{ kinds: [KIND_AGORA_NOTE], '#t': [clean], limit: 60 }],
        {
          timeoutMs: 4200,
          targetEose: Math.min(2, relays.length),
          onEvent: (ev) => {
            const note = parseAgoraNote(ev)
            if (!note || blockedSetRef.current.has(note.pubkey)) return
            byId.set(note.id, note)
          },
        }
      )

      void promise.then(() => {
        if (searchGenRef.current !== gen) return
        const sorted = Array.from(byId.values())
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 100)
        ingestNotesBatch(sorted)
        warmDependenciesForNotes(sorted)
        setSearchResults(sorted)
        setSearchLoading(false)
      })
    },
    [ingestNotesBatch, queryOneShot, warmDependenciesForNotes]
  )

  const runSearch = useCallback(
    async (rawQuery: string): Promise<void> => {
      const trimmed = rawQuery.trim()
      if (!trimmed) {
        clearSearch()
        return
      }

      // Direct NIP-19 / hashtag / 64-hex jump handling
      const target = parseAgoraJumpTarget(trimmed)
      if (target) {
        if (target.kind === 'hashtag') {
          selectHashtag(target.tag)
          return
        }
        if (target.kind === 'note') {
          openThread(target.eventId)
          return
        }
        if (target.kind === 'profile') {
          if (isHex64(trimmed)) {
            // Raw 64-hex could be either a note ID or a pubkey — check cache & relays cleanly
            const lowerHex = trimmed.toLowerCase()
            if (notesRef.current[lowerHex]) {
              openThread(lowerHex)
              return
            }
            if (profilesRef.current[lowerHex]) {
              openProfile(lowerHex)
              return
            }
            let matchedNote: AgoraNote | null = null
            const { promise } = queryOneShot(
              'hex-probe',
              socialRelaysRef.current,
              [{ ids: [lowerHex], limit: 1 }],
              {
                timeoutMs: 2200,
                targetEose: 1,
                onEvent: (ev) => {
                  const parsed = parseAgoraNote(ev)
                  if (parsed) matchedNote = parsed
                },
              }
            )
            await promise
            if (matchedNote) {
              ingestNotesBatch([matchedNote])
              openThread(lowerHex)
            } else {
              openProfile(lowerHex)
            }
            return
          }
          openProfile(target.pubkey)
          return
        }
      }

      const gen = ++searchGenRef.current
      const qLower = trimmed.toLowerCase()
      setActiveHashtag(null)
      setSearchQuery(trimmed)
      setSearchLoading(true)

      // Immediate local matches while NIP-50 search relays stream in
      const localNotes = Object.values(notesRef.current)
        .filter(
          (n) =>
            !blockedSetRef.current.has(n.pubkey) &&
            (n.content.toLowerCase().includes(qLower) ||
              n.hashtags.some((h) => h.includes(qLower)))
        )
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 60)

      const localProfs = Object.values(profilesRef.current)
        .filter(
          (p) =>
            !blockedSetRef.current.has(p.pubkey) &&
            ((p.name && p.name.toLowerCase().includes(qLower)) ||
              (p.displayName && p.displayName.toLowerCase().includes(qLower)) ||
              (p.nip05 && p.nip05.toLowerCase().includes(qLower)) ||
              (p.about && p.about.toLowerCase().includes(qLower)))
        )
        .slice(0, 20)

      setSearchResults(localNotes)
      setSearchProfiles(localProfs)

      const noteMap = new Map<string, AgoraNote>()
      for (const n of localNotes) noteMap.set(n.id, n)
      const profMap = new Map<string, AgoraProfile>()
      for (const p of localProfs) profMap.set(p.pubkey, p)

      const { promise } = queryOneShot(
        'search',
        AGORA_SEARCH_RELAYS,
        [
          { kinds: [KIND_AGORA_NOTE], search: trimmed, limit: 45 },
          { kinds: [KIND_AGORA_PROFILE], search: trimmed, limit: 20 },
        ],
        {
          timeoutMs: 4500,
          targetEose: Math.min(2, AGORA_SEARCH_RELAYS.length),
          onEvent: (ev) => {
            if (blockedSetRef.current.has(ev.pubkey.toLowerCase())) return
            if (ev.kind === KIND_AGORA_NOTE) {
              const parsed = parseAgoraNote(ev)
              if (parsed) noteMap.set(parsed.id, parsed)
            } else if (ev.kind === KIND_AGORA_PROFILE) {
              const parsed = parseAgoraProfile(ev)
              if (parsed) {
                const prev = profMap.get(parsed.pubkey)
                if (!prev || parsed.updatedAt > prev.updatedAt) {
                  profMap.set(parsed.pubkey, parsed)
                }
              }
            }
          },
        }
      )

      await promise
      if (searchGenRef.current !== gen) return

      const finalNotes = Array.from(noteMap.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 80)
      const finalProfs = Array.from(profMap.values()).slice(0, 24)

      ingestNotesBatch(finalNotes)
      ingestProfilesBatch(finalProfs)
      warmDependenciesForNotes(finalNotes)
      setSearchResults(finalNotes)
      setSearchProfiles(finalProfs)
      setSearchLoading(false)
    },
    [
      clearSearch,
      ingestNotesBatch,
      ingestProfilesBatch,
      openProfile,
      openThread,
      queryOneShot,
      selectHashtag,
      warmDependenciesForNotes,
    ]
  )

  // Live computed Trending Hashtags (top 10)
  const trendingHashtags = useMemo<AgoraTrendingHashtag[]>(() => {
    const counts = new Map<string, number>()
    for (const note of Object.values(notesById)) {
      if (blockedSet.has(note.pubkey)) continue
      for (const tag of note.hashtags) {
        if (tag.length < 2 || tag.length > 32 || /^\d+$/.test(tag)) continue
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 10)
  }, [notesById, blockedSet])

  // Live computed Suggested Voices (active unfollowed authors with rich profiles)
  const suggestedProfiles = useMemo<AgoraProfile[]>(() => {
    const activityScore = new Map<string, number>()
    for (const note of Object.values(notesById)) {
      if (
        note.pubkey === myPubkey ||
        blockedSet.has(note.pubkey) ||
        followingSet.has(note.pubkey)
      ) {
        continue
      }
      const stats = statsByNoteId[note.id]
      const boost = 1 + (stats ? Math.min(20, stats.likes + stats.reposts * 2) * 0.25 : 0)
      activityScore.set(note.pubkey, (activityScore.get(note.pubkey) ?? 0) + boost)
    }

    const candidates: Array<{ profile: AgoraProfile; score: number }> = []
    for (const profile of Object.values(profilesByPubkey)) {
      if (
        profile.pubkey === myPubkey ||
        blockedSet.has(profile.pubkey) ||
        followingSet.has(profile.pubkey)
      ) {
        continue
      }
      const hasName = Boolean(profile.displayName || profile.name)
      const hasRichMeta = Boolean(profile.picture || profile.about || profile.nip05)
      if (!hasName || !hasRichMeta) continue
      const score =
        (activityScore.get(profile.pubkey) ?? 0) +
        (profile.picture ? 2 : 0) +
        (profile.about ? 1.5 : 0) +
        (profile.nip05 ? 1 : 0) +
        (profile.lud16 ? 0.5 : 0)
      candidates.push({ profile, score })
    }

    return candidates
      .sort((a, b) => b.score - a.score || b.profile.updatedAt - a.profile.updatedAt)
      .slice(0, 12)
      .map((c) => c.profile)
  }, [notesById, profilesByPubkey, statsByNoteId, myPubkey, blockedSet, followingSet])

  // Panic Wipe / complete reset
  const resetAll = useCallback(() => {
    for (const cancel of Array.from(activeCancelsRef.current)) {
      cancel()
    }
    activeCancelsRef.current.clear()

    if (profilePersistTimerRef.current !== null) {
      window.clearTimeout(profilePersistTimerRef.current)
      profilePersistTimerRef.current = null
    }
    if (profileFlushTimerRef.current !== null) {
      window.clearTimeout(profileFlushTimerRef.current)
      profileFlushTimerRef.current = null
    }
    if (noteFlushTimerRef.current !== null) {
      window.clearTimeout(noteFlushTimerRef.current)
      noteFlushTimerRef.current = null
    }
    if (statsFetchTimerRef.current !== null) {
      window.clearTimeout(statsFetchTimerRef.current)
      statsFetchTimerRef.current = null
    }
    if (statsStateFlushTimerRef.current !== null) {
      window.clearTimeout(statsStateFlushTimerRef.current)
      statsStateFlushTimerRef.current = null
    }

    pendingItemsRef.current.clear()
    profileTouchedAtRef.current.clear()
    profileQueueRef.current.clear()
    profileInFlightRef.current.clear()
    profileNegativeRef.current.clear()
    noteQueueRef.current.clear()
    noteInFlightRef.current.clear()
    noteNegativeRef.current.clear()
    pendingRepostsByTargetRef.current.clear()
    statsQueueRef.current.clear()
    statsFetchedAtRef.current.clear()
    statsBucketsRef.current.clear()
    dirtyStatsIdsRef.current.clear()
    notifByIdRef.current.clear()
    myFollowEventRef.current = null
    myBookmarkEventRef.current = null
    discoveryWarmedRef.current = false
    threadGenRef.current += 1
    profileViewGenRef.current += 1
    searchGenRef.current += 1

    try {
      localStorage.removeItem(AGORA_PROFILES_STORAGE_KEY)
      localStorage.removeItem(AGORA_BOOKMARKS_STORAGE_KEY)
      localStorage.removeItem(AGORA_NOTIF_READ_AT_STORAGE_KEY)
    } catch {
      // Ignore storage errors
    }

    setActive(false)
    setActiveTabState('following')
    setLoadingFeed(false)
    setLoadingMore(false)
    setFollowingItems([])
    setGlobalItems([])
    setTrendingCandidates([])
    setPendingNewCount(0)
    setProfilesByPubkey({})
    setNotesById({})
    setStatsByNoteId({})
    setFollowingPubkeys([])
    setBookmarkedIds([])
    setMyNip65Relays(null)
    setNotifications([])
    setLastNotifReadAt(0)
    setThread(null)
    setProfileView(null)
    setSearchQuery('')
    setActiveHashtag(null)
    setSearchResults([])
    setSearchProfiles([])
    setSearchLoading(false)
  }, [])

  // Unmount cleanup (timers & in-flight one-shot subs; preserves localStorage cache)
  useEffect(() => {
    const cancels = activeCancelsRef.current
    return () => {
      for (const cancel of Array.from(cancels)) {
        cancel()
      }
      cancels.clear()
      if (profilePersistTimerRef.current !== null) window.clearTimeout(profilePersistTimerRef.current)
      if (profileFlushTimerRef.current !== null) window.clearTimeout(profileFlushTimerRef.current)
      if (noteFlushTimerRef.current !== null) window.clearTimeout(noteFlushTimerRef.current)
      if (statsFetchTimerRef.current !== null) window.clearTimeout(statsFetchTimerRef.current)
      if (statsStateFlushTimerRef.current !== null) window.clearTimeout(statsStateFlushTimerRef.current)
    }
  }, [])

  const visibleThread = useMemo<AgoraThreadState | null>(() => {
    if (!thread) return null
    return {
      ...thread,
      ancestors: thread.ancestors.filter((n) => !blockedSet.has(n.pubkey)),
      focusedNote:
        thread.focusedNote && !blockedSet.has(thread.focusedNote.pubkey)
          ? thread.focusedNote
          : null,
      replies: thread.replies.filter((n) => !blockedSet.has(n.pubkey)),
    }
  }, [thread, blockedSet])

  const visibleProfileView = useMemo<AgoraProfileViewState | null>(() => {
    if (!profileView) return null
    if (blockedSet.has(profileView.pubkey)) {
      return {
        ...profileView,
        posts: [],
        replies: [],
        likes: [],
      }
    }
    return {
      ...profileView,
      likes: profileView.likes.filter((n) => !blockedSet.has(n.pubkey)),
    }
  }, [profileView, blockedSet])

  const visibleSearchResults = useMemo(
    () => searchResults.filter((n) => !blockedSet.has(n.pubkey)),
    [searchResults, blockedSet]
  )

  const visibleSearchProfiles = useMemo(
    () => searchProfiles.filter((p) => !blockedSet.has(p.pubkey)),
    [searchProfiles, blockedSet]
  )

  const myProfile = profilesByPubkey[myPubkey] ?? null

  return useMemo<AgoraEngine>(
    () => ({
      active,
      activate,
      resetAll,
      myPubkey,
      myProfile,
      socialRelays,
      myNip65Relays,

      activeTab,
      setActiveTab,
      feedItems,
      loadingFeed,
      loadingMore,
      hasMore,
      pendingNewCount,
      flushPendingNotes,
      refresh,
      loadMore,

      profilesByPubkey,
      notesById,
      statsByNoteId,
      getProfile,
      getNote,
      getNoteStats,
      ensureProfiles,
      ensureNotes,

      followingPubkeys,
      isFollowing,
      bookmarkedIds,
      isBookmarked,

      notifications: visibleNotifications,
      unreadNotificationCount,
      markNotificationsRead,

      thread: visibleThread,
      openThread,
      closeThread,

      profileView: visibleProfileView,
      openProfile,
      setProfileTab,
      closeProfile,

      searchQuery,
      activeHashtag,
      searchResults: visibleSearchResults,
      searchProfiles: visibleSearchProfiles,
      searchLoading,
      runSearch,
      selectHashtag,
      clearSearch,
      trendingHashtags,
      suggestedProfiles,

      publishing,
      uploadingMedia,
      publishNote,
      replyToNote,
      quoteNote,
      repostNote,
      toggleLike,
      toggleBookmark,
      toggleFollow,
      updateMyProfile,
      recordOptimisticZap,
      uploadMedia,
    }),
    [
      active,
      activate,
      resetAll,
      myPubkey,
      myProfile,
      socialRelays,
      myNip65Relays,
      activeTab,
      setActiveTab,
      feedItems,
      loadingFeed,
      loadingMore,
      hasMore,
      pendingNewCount,
      flushPendingNotes,
      refresh,
      loadMore,
      profilesByPubkey,
      notesById,
      statsByNoteId,
      getProfile,
      getNote,
      getNoteStats,
      ensureProfiles,
      ensureNotes,
      followingPubkeys,
      isFollowing,
      bookmarkedIds,
      isBookmarked,
      visibleNotifications,
      unreadNotificationCount,
      markNotificationsRead,
      visibleThread,
      openThread,
      closeThread,
      visibleProfileView,
      openProfile,
      setProfileTab,
      closeProfile,
      searchQuery,
      activeHashtag,
      visibleSearchResults,
      visibleSearchProfiles,
      searchLoading,
      runSearch,
      selectHashtag,
      clearSearch,
      trendingHashtags,
      suggestedProfiles,
      publishing,
      uploadingMedia,
      publishNote,
      replyToNote,
      quoteNote,
      repostNote,
      toggleLike,
      toggleBookmark,
      toggleFollow,
      updateMyProfile,
      recordOptimisticZap,
      uploadMedia,
    ]
  )
}
