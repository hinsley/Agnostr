import type { AgoraNote, AgoraNoteStats, AgoraProfile } from '../../types/agora.ts'
import type { DiscoveryTopicId, SlopAssessment } from './types.ts'

const URL_REGEX = /https?:\/\/[^\s<>()]+/gi
const NOSTR_URI_REGEX = /\bnostr:(?:npub|nprofile|note|nevent|naddr)1[0-9a-z]+\b/gi
const INLINE_HASHTAG_REGEX = /(?:^|[\s(])#([a-z0-9_]{2,40})\b/gi

const GM_TEMPLATE_REGEX =
  /^(?:gm|gn|pv|good\s+morning|good\s+night|pura\s+vida|wagmi|lfg|wen|bullish|to\s+the\s+moon|happy\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day|have\s+a\s+great\s+(?:day|week|weekend))\b/i

const ENGAGEMENT_BAIT_REGEX =
  /(?:follow\s*(?:for|4)\s*follow|\bf4f\b|follow\s*back|followback|follow\s*(?:&|and|\+)\s*(?:repost|boost|like)|repost\s+to\s+win|zap\s+to\s+(?:enter|win)|zap\s+me\s+(?:please|pls|sats)|free\s+sats\s+giveaway|claim\s+your\s+airdrop|airdrop\s+(?:is\s+)?live|\bgiveaway\b|100x\s+gem|1000x|pump\s+incoming|join\s+my\s+vip|dm\s+(?:me\s+)?for\s+promo|guaranteed\s+(?:profit|returns)|passive\s+income\s+daily|double\s+your\s+(?:btc|bitcoin|sats))/i

const HYPE_EMOJI_REGEX =
  /(?:🚀|🔥|💰|💎|👇|🧵|🚨|💯|🤑|📈|⚡|🎉|🎁|💸|🙌|✨|👀|🤯|🔔|📣)/gu

const REPEATED_WORD_REGEX = /\b([a-z0-9]{2,20})(?:\s+\1){3,}\b/i

const TOPIC_LEXICON: ReadonlyArray<{ id: Exclude<DiscoveryTopicId, 'all'>; keywords: readonly string[] }> = [
  {
    id: 'nostr',
    keywords: [
      'nostr',
      'nip',
      'nip05',
      'nip17',
      'nip23',
      'nip51',
      'nip65',
      'nip88',
      'relay',
      'relays',
      'zap',
      'zaps',
      'zapping',
      'npub',
      'nevent',
      'naddr',
      'blossom',
      'agora',
      'bitchat',
      'outbox',
      'wot',
      'web-of-trust',
      'weboftrust',
    ],
  },
  {
    id: 'bitcoin',
    keywords: [
      'bitcoin',
      'btc',
      'sats',
      'satoshi',
      'lightning',
      'lnurl',
      'bolt11',
      'cashu',
      'ecash',
      'mint',
      'boltz',
      'mempool',
      'utxo',
      'halving',
      'self-custody',
      'multisig',
      'fedimint',
      'taproot',
      'bitcoiner',
      'node',
      'mining',
    ],
  },
  {
    id: 'privacy',
    keywords: [
      'privacy',
      'private',
      'encryption',
      'encrypted',
      'e2ee',
      'cypherpunk',
      'opsec',
      'tor',
      'onion',
      'pgp',
      'gpg',
      'mesh',
      'meshnet',
      'sovereign',
      'sovereignty',
      'self-hosted',
      'selfhosted',
      'censorship',
      'anonymity',
      'anonymous',
      'freedomtech',
      'zeroknowledge',
      'monero',
      'decentralized',
    ],
  },
  {
    id: 'dev',
    keywords: [
      'rust',
      'typescript',
      'javascript',
      'golang',
      'python',
      'linux',
      'kernel',
      'github',
      'opensource',
      'open-source',
      'foss',
      'protocol',
      'compiler',
      'wasm',
      'webgpu',
      'cryptography',
      'crypto-primitives',
      'docker',
      'nix',
      'nixos',
      'programming',
      'coding',
      'codebase',
      'developer',
      'dev',
      'software',
      'engineering',
      'sdk',
      'api',
      'cli',
      'git',
      'android',
      'ios',
    ],
  },
  {
    id: 'art',
    keywords: [
      'art',
      'artist',
      'artwork',
      'photography',
      'photo',
      'photos',
      'photographer',
      'music',
      'musician',
      'design',
      'designer',
      'illustration',
      'illustrator',
      'cinema',
      'film',
      'sketch',
      'painting',
      'architecture',
      'aesthetic',
      'visual',
      'creative',
      'drawing',
      'pixelart',
      'synth',
      'gallery',
    ],
  },
  {
    id: 'writing',
    keywords: [
      'essay',
      'essays',
      'writing',
      'writer',
      'article',
      'articles',
      'longform',
      'long-form',
      'book',
      'books',
      'literature',
      'journal',
      'philosophy',
      'history',
      'reading',
      'poetry',
      'newsletter',
      'research',
      'science',
      'economics',
      'politics',
      'culture',
      'blog',
    ],
  },
]

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function extractInlineHashtags(text: string): string[] {
  const out: string[] = []
  INLINE_HASHTAG_REGEX.lastIndex = 0
  let match: RegExpExecArray | null = INLINE_HASHTAG_REGEX.exec(text)
  while (match !== null) {
    out.push(match[1].toLowerCase())
    match = INLINE_HASHTAG_REGEX.exec(text)
  }
  return out
}

function countEmojiMatches(text: string, regex: RegExp): number {
  const matches = text.match(regex)
  return matches ? matches.length : 0
}

/**
 * Deterministic, pure content-quality and anti-slop heuristic for a single Agora note.
 * Zero network calls, zero AI dependency, transparent flags for user inspection.
 */
export function assessNoteSlop(note: AgoraNote, stats?: AgoraNoteStats): SlopAssessment {
  const raw = note.content ?? ''
  const trimmed = raw.trim()

  const hasHttpUrl = URL_REGEX.test(trimmed)
  URL_REGEX.lastIndex = 0

  const inlineHashtags = extractInlineHashtags(trimmed)
  const hashtagCount = Math.max(note.hashtags.length, inlineHashtags.length)

  const strippedUrls = trimmed
    .replace(URL_REGEX, ' ')
    .replace(NOSTR_URI_REGEX, ' ')
    .trim()
  const nonTagText = strippedUrls.replace(/(?:^|\s)#[a-z0-9_]+/gi, ' ').replace(/\s+/g, ' ').trim()
  const tokens = strippedUrls.split(/\s+/).filter(Boolean)
  const wordTokens = nonTagText
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

  let slopPenalty = 0
  let boosts = 0
  const flags: string[] = []

  // 1. Hashtag stuffing
  if (hashtagCount >= 5) {
    slopPenalty += 38
    flags.push('hashtag-stuffing')
  } else if (tokens.length >= 3 && hashtagCount / tokens.length > 0.35) {
    slopPenalty += 32
    flags.push('hashtag-ratio')
  }

  // 2. Engagement-bait / giveaway / airdrop / zap-begging templates
  if (ENGAGEMENT_BAIT_REGEX.test(trimmed)) {
    slopPenalty += 55
    flags.push('engagement-bait')
  }

  // 3. Pure GM / GN / PV low-signal greeting templates
  const alphaOnly = nonTagText.replace(/[^\p{L}\s]/gu, '').replace(/\s+/g, ' ').trim()
  if (alphaOnly.length > 0 && alphaOnly.length <= 28 && GM_TEMPLATE_REGEX.test(alphaOnly)) {
    if (note.media.length === 0 || alphaOnly.length <= 12) {
      slopPenalty += 42
      flags.push('gm-template')
    }
  }

  // 4. Excessive hype emoji spam & listicles
  const hypeEmojis = countEmojiMatches(trimmed, HYPE_EMOJI_REGEX)
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (hypeEmojis >= 6) {
    slopPenalty += 36
    flags.push('hype-emojis')
  } else if (hypeEmojis >= 4 && lines.length >= 4) {
    const bulletLike = lines.filter((l) => /^(?:[-*•\d.)]|🚀|🔥|💰|💎|👇|⚡|✨|✅)/.test(l)).length
    if (bulletLike >= 3) {
      slopPenalty += 28
      flags.push('listicle-slop')
    }
  }

  // 5. Bare URL link-dumps with almost no human commentary
  if (hasHttpUrl && note.media.length === 0 && nonTagText.length < 12) {
    slopPenalty += 36
    flags.push('bare-link-dump')
  }

  // 6. Repeated spam lines or copy-paste word loops
  if (lines.length >= 3) {
    const normalizedLines = lines.map((l) => l.toLowerCase().replace(/\s+/g, ' '))
    const uniqueLines = new Set(normalizedLines)
    if (uniqueLines.size < normalizedLines.length * 0.6) {
      slopPenalty += 40
      flags.push('repeated-lines')
    }
  }
  if (REPEATED_WORD_REGEX.test(nonTagText)) {
    slopPenalty += 30
    flags.push('repeated-words')
  }

  // 7. Ultra-short zero-context noise (no media, no quote)
  if (
    nonTagText.length < 18 &&
    note.media.length === 0 &&
    note.quoteIds.length === 0 &&
    !flags.includes('gm-template') &&
    !flags.includes('bare-link-dump')
  ) {
    slopPenalty += 32
    flags.push('ultra-short-noise')
  }

  // 8. All-caps shouting
  const letters = nonTagText.replace(/[^\p{L}]/gu, '')
  if (letters.length >= 24) {
    const upperCount = (letters.match(/\p{Lu}/gu) ?? []).length
    if (upperCount / letters.length > 0.78) {
      slopPenalty += 22
      flags.push('all-caps')
    }
  }

  // Positive craft & engagement boosts
  if (nonTagText.length >= 80 && nonTagText.length <= 1200 && wordTokens.length >= 14) {
    boosts += 18
  } else if (nonTagText.length >= 40 && wordTokens.length >= 7) {
    boosts += 9
  } else if (nonTagText.length > 1200 && !flags.includes('repeated-lines')) {
    boosts += 14
  }

  // Structured writing: fenced code, blockquotes, or multi-paragraph composition
  if (/```[\s\S]+?```/.test(trimmed) || /^>\s+\S/m.test(trimmed) || trimmed.includes('\n\n')) {
    boosts += 10
  }

  // Original top-level note bonus
  if (!note.isReply) {
    boosts += 6
  }

  // Substantive engagement boosts (reply conversation + unique zapper diversity)
  if (stats) {
    if (stats.replies > 0) {
      boosts += Math.min(14, stats.replies * 4)
    }
    const breakdownLen = stats.zapBreakdown?.length ?? 0
    const uniqueZappers =
      breakdownLen > 0 ? breakdownLen : stats.zapCount > 0 ? 1 : 0
    if (uniqueZappers > 0) {
      boosts += Math.min(18, uniqueZappers * 5)
    }
  }

  const clampedPenalty = clamp(Math.round(slopPenalty), 0, 100)
  const qualityScore = clamp(Math.round(50 + boosts - clampedPenalty), 0, 100)
  const isSlop = clampedPenalty >= 35 || qualityScore < 32

  return {
    isSlop,
    slopPenalty: clampedPenalty,
    qualityScore,
    flags,
  }
}

export interface AccountQualityAssessment {
  qualityScore: number
  slopRate: number
  isSlopAccount: boolean
  badges: string[]
}

/**
 * Evaluates an account's overall craft & anti-slop signal from its sample notes,
 * profile completeness, verified NIP-05, long-form articles, bot/RSS cadence, and WoT mutes.
 */
export function assessAccountQuality(params: {
  notes: AgoraNote[]
  profile: AgoraProfile | null
  nip05Verified: boolean
  hasArticles: boolean
  statsByNoteId: Record<string, AgoraNoteStats>
  mutedByCount: number
}): AccountQualityAssessment {
  const { notes, profile, nip05Verified, hasArticles, statsByNoteId, mutedByCount } = params

  const assessments = notes.map((n) => assessNoteSlop(n, statsByNoteId[n.id]))
  const slopCount = assessments.filter((a) => a.isSlop).length
  const slopRate = assessments.length > 0 ? slopCount / assessments.length : 0

  const avgNoteQuality =
    assessments.length > 0
      ? assessments.reduce((sum, a) => sum + a.qualityScore, 0) / assessments.length
      : 54

  let totalReplies = 0
  let bareLinkCount = 0
  for (let i = 0; i < notes.length; i += 1) {
    const st = statsByNoteId[notes[i].id]
    if (st) totalReplies += st.replies
    if (assessments[i].flags.includes('bare-link-dump')) bareLinkCount += 1
  }

  // Detect high-frequency RSS/bot mirror cadence
  let cadencePenalty = 0
  if (notes.length >= 6) {
    let minTs = notes[0].createdAt
    let maxTs = notes[0].createdAt
    for (const n of notes) {
      if (n.createdAt < minTs) minTs = n.createdAt
      if (n.createdAt > maxTs) maxTs = n.createdAt
    }
    const spanDays = Math.max(0.25, (maxTs - minTs) / 86400)
    const postsPerDay = notes.length / spanDays
    if (postsPerDay >= 18 && totalReplies === 0 && avgNoteQuality < 55) {
      cadencePenalty += 28
    }
  }
  if (notes.length >= 4 && bareLinkCount / notes.length >= 0.75) {
    cadencePenalty += 26
  }

  // Profile & authorship craft boosts
  let profileBoost = 0
  if (profile?.about && profile.about.trim().length >= 20) profileBoost += 6
  if (profile?.picture && (profile.displayName || profile.name)) profileBoost += 4
  if (nip05Verified) profileBoost += 8
  if (hasArticles) profileBoost += 14

  // Negative Web-of-Trust mute penalty
  let mutePenalty = 0
  if (mutedByCount === 1) {
    mutePenalty = 14
  } else if (mutedByCount >= 2) {
    mutePenalty = 26 + (mutedByCount - 1) * 16
  }

  const qualityScore = clamp(
    Math.round(avgNoteQuality + profileBoost - cadencePenalty - mutePenalty),
    0,
    100
  )

  const isSlopAccount =
    (assessments.length >= 2 && slopRate > 0.75) ||
    mutedByCount >= 2 ||
    cadencePenalty >= 26 ||
    qualityScore < 28

  const badges: string[] = []
  if (hasArticles) badges.push('Long-Form Writer')
  if (nip05Verified) badges.push('Verified NIP-05')
  if (!isSlopAccount && assessments.length >= 2 && qualityScore >= 76) {
    badges.push('High Craft')
  }
  if (notes.length >= 2 && totalReplies / notes.length >= 1.5) {
    badges.push('Conversation Starter')
  }

  return {
    qualityScore,
    slopRate,
    isSlopAccount,
    badges,
  }
}

/**
 * Maps text and hashtags into clean Agnostr discovery topic slugs.
 */
export function inferTopicsFromText(text: string, hashtags: string[]): DiscoveryTopicId[] {
  const lowerTags = new Set(
    hashtags.map((h) => h.trim().replace(/^#+/, '').toLowerCase()).filter(Boolean)
  )
  const lowerText = text.toLowerCase()
  const tokens = new Set(
    lowerText
      .replace(URL_REGEX, ' ')
      .replace(/[^a-z0-9-]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2)
  )

  const matched: DiscoveryTopicId[] = []
  for (const bucket of TOPIC_LEXICON) {
    let hit = false
    for (const kw of bucket.keywords) {
      if (lowerTags.has(kw) || tokens.has(kw)) {
        hit = true
        break
      }
      if (kw.includes('-') && lowerText.includes(kw)) {
        hit = true
        break
      }
    }
    if (hit) {
      matched.push(bucket.id)
    }
  }

  return matched
}
