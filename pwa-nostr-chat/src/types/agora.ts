import type { Event as NostrEvent } from 'nostr-tools'

export type AgoraFeedTab =
  | 'following'
  | 'global'
  | 'trending'
  | 'bookmarks'
  | 'notifications'

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
  loading: boolean
}

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

  // Active feed & calm live buffer
  activeTab: AgoraFeedTab
  setActiveTab: (tab: AgoraFeedTab) => void
  feedItems: AgoraFeedItem[]
  loadingFeed: boolean
  loadingMore: boolean
  hasMore: boolean
  pendingNewCount: number
  flushPendingNotes: () => void
  refresh: () => void
  loadMore: () => Promise<void>

  // Normalized caches & batch loaders
  profilesByPubkey: Record<string, AgoraProfile>
  notesById: Record<string, AgoraNote>
  statsByNoteId: Record<string, AgoraNoteStats>
  getProfile: (pubkey: string) => AgoraProfile | null
  getNote: (noteId: string) => AgoraNote | null
  getNoteStats: (noteId: string) => AgoraNoteStats
  ensureProfiles: (pubkeys: readonly string[]) => void
  ensureNotes: (ids: readonly string[]) => void

  // Social graph & bookmarks
  followingPubkeys: string[]
  isFollowing: (pubkey: string) => boolean
  bookmarkedIds: string[]
  isBookmarked: (noteId: string) => boolean

  // Notifications
  notifications: AgoraNotification[]
  unreadNotificationCount: number
  markNotificationsRead: () => void

  // Thread viewer
  thread: AgoraThreadState | null
  openThread: (noteId: string) => void
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
  suggestedProfiles: AgoraProfile[]

  // Publishing, engagement & Blossom media uploads
  publishing: boolean
  uploadingMedia: boolean
  publishNote: (content: string, opts?: AgoraPublishNoteOptions) => Promise<AgoraActionResult>
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
