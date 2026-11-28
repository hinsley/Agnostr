import type { Event as NostrEvent, Filter } from 'nostr-tools'

export type AgoraFeedTab =
  | 'following'
  | 'global'
  | 'trending'
  | 'bookmarks'
  | 'notifications'
  | 'articles'
  | 'discover'

export type AgoraFeedFilter = 'all' | 'no-reposts' | 'media' | 'trusted'

export type AgoraNotificationFilter = 'all' | 'replies' | 'zaps' | 'reactions'

export type AgoraDensity = 'comfortable' | 'compact'

export type AgoraNip05Status = 'verified' | 'invalid' | 'checking' | 'unverified'

export type AgoraProfileTab = 'posts' | 'replies' | 'media' | 'likes'

export interface AgoraProfile {
  pubkey: string
  npub: string
  name?: string
  displayName?: string
  about?: string
  picture?: string
  banner?: string
  nip05?: string
  lud16?: string
  website?: string
  /** Unix timestamp in seconds from the kind:0 event */
  updatedAt: number
  /** Original parsed JSON object preserved so profile edits never clobber unknown keys */
  rawJson?: Record<string, unknown>
}

export interface AgoraProfileDraft {
  name?: string
  displayName?: string
  about?: string
  picture?: string
  banner?: string
  nip05?: string
  lud16?: string
  website?: string
}

export interface AgoraMediaItem {
  url: string
  kind: 'image' | 'video'
  mime?: string
  alt?: string
  dim?: string
  thumb?: string
}

export interface AgoraUploadedMedia {
  url: string
  kind: 'image' | 'video'
  mime: string
  sha256: string
  size: number
  alt?: string
  dim?: string
}

export interface AgoraNote {
  id: string
  pubkey: string
  /** Unix timestamp in seconds */
  createdAt: number
  content: string
  tags: string[][]
  rootId?: string
  replyToId?: string
  replyToPubkey?: string
  mentionedPubkeys: string[]
  hashtags: string[]
  quoteIds: string[]
  media: AgoraMediaItem[]
  contentWarning?: string
  isReply: boolean
  rawEvent: NostrEvent
}

export interface AgoraFeedItem {
  key: string
  kind: 'note' | 'repost'
  note: AgoraNote
  repostedBy?: string
  repostedByList?: string[]
  repostedAt?: number
  /** Unix timestamp in seconds used for chronological ordering */
  sortAt: number
}

export interface AgoraZapperSummary {
  pubkey: string
  sats: number
  byMe?: boolean
}

export interface AgoraNoteStats {
  likes: number
  likedByMe: boolean
  reposts: number
  repostedByMe: boolean
  replies: number
  zapSats: number
  zapCount: number
  zappedByMe: boolean
  zapBreakdown?: AgoraZapperSummary[]
}

export type AgoraContentToken =
  | { type: 'text'; text: string }
  | { type: 'hashtag'; tag: string; raw: string }
  | { type: 'mention'; pubkey: string; raw: string; relays?: string[] }
  | { type: 'quote'; eventId: string; raw: string; authorPubkey?: string; relays?: string[] }
  | { type: 'link'; url: string; display: string }

export interface AgoraNotification {
  id: string
  kind: 'reply' | 'mention' | 'like' | 'repost' | 'zap'
  actorPubkey: string
  /** Unix timestamp in seconds */
  createdAt: number
  noteId?: string
  targetNoteId?: string
  content?: string
  zapSats?: number
}

export interface AgoraThreadState {
  rootNoteId: string
  focusedNoteId: string
  ancestors: AgoraNote[]
  focusedNote: AgoraNote | null
  replies: AgoraNote[]
  loading: boolean
}

export interface AgoraProfileViewState {
  pubkey: string
  tab: AgoraProfileTab
  posts: AgoraNote[]
  replies: AgoraNote[]
  likes: AgoraNote[]
  followingPubkeys: string[]
  followerPubkeys: string[]
  followsMe: boolean
  loading: boolean
}

export interface AgoraMuteList {
  words: string[]
  hashtags: string[]
  threads: string[]
  pubkeys: string[]
  updatedAt: number
}

export interface AgoraCustomList {
  id: string
  dTag: string
  title: string
  description?: string
  pubkeys: string[]
  updatedAt: number
}

export interface AgoraArticle {
  id: string
  dTag: string
  pubkey: string
  title: string
  summary?: string
  image?: string
  publishedAt: number
  createdAt: number
  content: string
  hashtags: string[]
  naddr: string
  rawEvent: NostrEvent
}

export interface AgoraPollOption {
  id: string
  label: string
}

export interface AgoraPoll {
  id: string
  pubkey: string
  question: string
  options: AgoraPollOption[]
  endsAt?: number
  createdAt: number
  rawEvent: NostrEvent
}

export interface AgoraPollResults {
  totalVotes: number
  countsByOption: Record<string, number>
  myOptionId?: string
}

export interface AgoraReplyTreeNode {
  note: AgoraNote
  depth: number
  children: AgoraReplyTreeNode[]
}

export interface AgoraGroupedNotification {
  key: string
  kind: AgoraNotification['kind']
  actors: string[]
  count: number
  createdAt: number
  noteId?: string
  targetNoteId?: string
  content?: string
  totalZapSats?: number
  items: AgoraNotification[]
}

export interface AgoraDraftPayload {
  text: string
  uploads: AgoraUploadedMedia[]
  cwEnabled: boolean
  cwReason: string
  threadParts?: string[]
  updatedAt: number
}

export type AgoraContentBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'blockquote'; text: string }
  | { type: 'code'; lang?: string; code: string }

export type AgoraJumpTarget =
  | { kind: 'profile'; pubkey: string; relays?: string[] }
  | { kind: 'note'; eventId: string; authorPubkey?: string; relays?: string[] }
  | { kind: 'hashtag'; tag: string }

export interface AgoraTrendingHashtag {
  tag: string
  count: number
}

export interface AgoraNip65RelayList {
  read: string[]
  write: string[]
  all: string[]
  updatedAt: number
}

export interface AgoraZapReceipt {
  id: string
  senderPubkey?: string
  recipientPubkey: string
  targetEventId?: string
  amountSats: number
  comment?: string
  createdAt: number
}

export interface AgoraPublishNoteOptions {
  media?: AgoraUploadedMedia[]
  contentWarning?: string
  hashtags?: string[]
}

export interface AgoraActionResult {
  ok: boolean
  eventId?: string
  note?: AgoraNote
  publishedRelays: number
  error?: string
}

export interface AgoraEngine {
  // Activation & identity
  active: boolean
  activate: () => void
  resetAll: () => void
  myPubkey: string
  myProfile: AgoraProfile | null
  socialRelays: string[]
  myNip65Relays: AgoraNip65RelayList | null
  queryRelaysOneShot: (
    prefix: string,
    relays: readonly string[],
    filters: Filter[],
    opts: {
      onEvent: (event: NostrEvent, relayUrl: string) => void
      timeoutMs?: number
      targetEose?: number
    }
  ) => { promise: Promise<void>; cancel: () => void }

  // Active feed & calm live buffer
  activeTab: AgoraFeedTab
  setActiveTab: (tab: AgoraFeedTab) => void
  feedFilter: AgoraFeedFilter
  setFeedFilter: (f: AgoraFeedFilter) => void
  activeListId: string | null
  setActiveListId: (id: string | null) => void
  density: AgoraDensity
  setDensity: (d: AgoraDensity) => void
  feedItems: AgoraFeedItem[]
  loadingFeed: boolean
  loadingMore: boolean
  hasMore: boolean
  pendingNewCount: number
  flushPendingNotes: () => void
  refresh: () => void
  loadMore: () => Promise<void>

  // Navigation history
  canNavigateBack: boolean
  navigateBack: () => void

  // Normalized caches & batch loaders
  profilesByPubkey: Record<string, AgoraProfile>
  notesById: Record<string, AgoraNote>
  statsByNoteId: Record<string, AgoraNoteStats>
  authorRelaysByPubkey: Record<string, AgoraNip65RelayList>
  nip05StatusByPubkey: Record<string, AgoraNip05Status>
  ensureNip05Verified: (pubkey: string, nip05?: string) => void
  getProfile: (pubkey: string) => AgoraProfile | null
  getNote: (noteId: string) => AgoraNote | null
  getNoteStats: (noteId: string) => AgoraNoteStats
  ensureProfiles: (pubkeys: readonly string[]) => void
  ensureNotes: (ids: readonly string[]) => void

  // Social graph, bookmarks, mutes & custom lists (NIP-51)
  followingPubkeys: string[]
  isFollowing: (pubkey: string) => boolean
  bookmarkedIds: string[]
  isBookmarked: (noteId: string) => boolean
  muteList: AgoraMuteList
  addMutedWord: (word: string) => Promise<boolean>
  removeMutedWord: (word: string) => Promise<boolean>
  muteThread: (rootId: string) => Promise<boolean>
  unmuteThread: (rootId: string) => Promise<boolean>
  isThreadMuted: (rootId: string) => boolean
  customLists: AgoraCustomList[]
  createCustomList: (
    title: string,
    pubkeys?: string[],
    description?: string
  ) => Promise<AgoraCustomList | null>
  updateCustomList: (
    dTag: string,
    patch: { title?: string; description?: string; pubkeys?: string[] }
  ) => Promise<boolean>
  deleteCustomList: (dTag: string) => Promise<boolean>

  // Long-form articles (NIP-23) & native polls (NIP-88)
  articles: AgoraArticle[]
  articlesById: Record<string, AgoraArticle>
  activeArticle: AgoraArticle | null
  openArticle: (articleId: string) => void
  closeArticle: () => void
  polls: AgoraPoll[]
  pollsById: Record<string, AgoraPoll>
  pollResultsById: Record<string, AgoraPollResults>
  publishPoll: (
    question: string,
    options: string[],
    durationSec?: number
  ) => Promise<AgoraActionResult>
  votePoll: (poll: AgoraPoll, optionId: string) => Promise<boolean>

  // Notifications
  notifications: AgoraNotification[]
  unreadNotificationCount: number
  markNotificationsRead: () => void

  // Thread viewer
  thread: AgoraThreadState | null
  openThread: (noteId: string) => void
  openThreadById: (noteId: string, relayHints?: readonly string[]) => Promise<void>
  closeThread: () => void

  // Profile viewer
  profileView: AgoraProfileViewState | null
  openProfile: (pubkey: string) => void
  setProfileTab: (tab: AgoraProfileTab) => void
  closeProfile: () => void

  // Search, hashtags & discovery
  searchQuery: string
  activeHashtag: string | null
  searchResults: AgoraNote[]
  searchProfiles: AgoraProfile[]
  searchLoading: boolean
  runSearch: (query: string) => Promise<void>
  selectHashtag: (tag: string) => void
  clearSearch: () => void
  trendingHashtags: AgoraTrendingHashtag[]
  hiddenTrendingTopics: string[]
  hideTrendingTopic: (tag: string) => void
  unhideTrendingTopic: (tag: string) => void
  clearHiddenTrendingTopics: () => void
  suggestedProfiles: AgoraProfile[]

  // Publishing, engagement & Blossom media uploads
  publishing: boolean
  uploadingMedia: boolean
  publishNote: (content: string, opts?: AgoraPublishNoteOptions) => Promise<AgoraActionResult>
  publishThread: (
    parts: Array<{ content: string; opts?: AgoraPublishNoteOptions }>
  ) => Promise<AgoraActionResult>
  deleteNote: (noteId: string) => Promise<AgoraActionResult>
  replyToNote: (
    parentNote: AgoraNote,
    content: string,
    opts?: AgoraPublishNoteOptions
  ) => Promise<AgoraActionResult>
  quoteNote: (
    quotedNote: AgoraNote,
    content: string,
    opts?: AgoraPublishNoteOptions
  ) => Promise<AgoraActionResult>
  repostNote: (note: AgoraNote) => Promise<AgoraActionResult>
  toggleLike: (note: AgoraNote) => Promise<boolean>
  toggleBookmark: (noteId: string) => Promise<boolean>
  toggleFollow: (pubkey: string) => Promise<boolean>
  updateMyProfile: (draft: AgoraProfileDraft) => Promise<AgoraActionResult>
  recordOptimisticZap: (noteId: string, amountSats: number) => void
  uploadMedia: (
    file: File | Blob,
    opts?: { alt?: string; mime?: string }
  ) => Promise<AgoraUploadedMedia>
}
