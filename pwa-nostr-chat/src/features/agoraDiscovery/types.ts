import type { AgoraArticle, AgoraNote } from '../../types/agora.ts'

export type WotReachMode = 'strict' | 'network' | 'wide'

export type AntiSlopMode = 'strict' | 'balanced' | 'off'

export type DiscoveryLens = 'people' | 'trending' | 'packs' | 'graph'

export type DiscoveryTopicId =
  | 'all'
  | 'nostr'
  | 'bitcoin'
  | 'privacy'
  | 'dev'
  | 'art'
  | 'writing'

export interface WotGraphNode {
  pubkey: string
  role: 'self' | 'trusted' | 'following' | 'local' | 'candidate'
  hop: 0 | 1 | 2
  score: number
  signalScore: number
  endorserCount: number
  trustedEndorserCount: number
  followCount?: number
  isVerifiedNip05?: boolean
  isLongFormWriter?: boolean
  isDismissed?: boolean
}

export interface WotGraphEdge {
  source: string
  target: string
  weight: number
  kind: 'trust' | 'follow' | 'zap' | 'repost' | 'local'
}

export interface SlopAssessment {
  isSlop: boolean
  slopPenalty: number
  qualityScore: number
  flags: string[]
}

export interface DiscoveredAccount {
  pubkey: string
  signalScore: number
  wotScore: number
  qualityScore: number
  endorsers: string[]
  trustedEndorsers: string[]
  zapperCount: number
  repostEndorserCount: number
  mutedByCount: number
  isLongFormWriter: boolean
  isVerifiedNip05: boolean
  reasons: string[]
  badges: string[]
  topics: DiscoveryTopicId[]
  sampleNotes: AgoraNote[]
  sampleArticle?: AgoraArticle
}

export interface DiscoveredNote {
  note: AgoraNote
  signalScore: number
  wotZappers: number
  wotReposters: number
  replyCount: number
  reasons: string[]
  slop: SlopAssessment
}

export interface FollowPack {
  id: string
  dTag: string
  pubkey: string
  title: string
  description?: string
  image?: string
  memberPubkeys: string[]
  wotOverlapCount: number
  createdAt: number
  isStarterFallback?: boolean
}

export interface DiscoveryProgress {
  loading: boolean
  phase: 'idle' | 'seeds' | 'graph' | 'signals' | 'samples' | 'ready'
  seedsProcessed: number
  seedsTotal: number
  lastUpdatedAt: number | null
}

export interface DiscoveryPrefs {
  reach: WotReachMode
  antiSlop: AntiSlopMode
  topic: DiscoveryTopicId
}

export interface AgoraDiscoveryController {
  progress: DiscoveryProgress
  isColdStart: boolean
  seedCount: number
  lens: DiscoveryLens
  setLens: (l: DiscoveryLens) => void
  prefs: DiscoveryPrefs
  setReach: (r: WotReachMode) => void
  setAntiSlop: (m: AntiSlopMode) => void
  setTopic: (t: DiscoveryTopicId) => void
  similarToPubkey: string | null
  setSimilarToPubkey: (pk: string | null) => void
  accounts: DiscoveredAccount[]
  similarAccounts: DiscoveredAccount[]
  highSignalNotes: DiscoveredNote[]
  filteredSlopCount: number
  followPacks: FollowPack[]
  graphNodes: WotGraphNode[]
  graphEdges: WotGraphEdge[]
  dismissedCount: number
  dismissAccount: (pubkey: string) => void
  clearDismissed: () => void
  refreshGraph: () => void
  followMultiple: (pubkeys: string[]) => Promise<number>
  savePackAsCustomList: (pack: FollowPack, selectedPubkeys?: string[]) => Promise<boolean>
}
