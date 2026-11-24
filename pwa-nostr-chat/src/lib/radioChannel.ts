import { isValidGeohash, normalizeGeohash, resolveGeohashOrCity } from './geohash.ts'

export const TOPIC_CHANNEL_PREFIX = 'topic:'
export const MAX_TOPIC_SLUG_LEN = 48

const TOPIC_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/

export interface PopularTopicChannel {
  slug: string
  label: string
  description: string
}

export const POPULAR_TOPIC_CHANNELS: readonly PopularTopicChannel[] = [
  { slug: 'general', label: '#general', description: 'Open global radio' },
  { slug: 'nostr', label: '#nostr', description: 'Nostr protocol & clients' },
  { slug: 'bitcoin', label: '#bitcoin', description: 'Bitcoin & Lightning' },
  { slug: 'agnostr', label: '#agnostr', description: 'Agnostr radio lounge' },
  { slug: 'mesh', label: '#mesh', description: 'Off-grid & mesh radio' },
  { slug: 'dev', label: '#dev', description: 'Builders & code' },
]

/**
 * Normalizes a raw topic name (with optional leading `#`, `/`, or `topic:`) into a
 * canonical lowercase ephemeral `kind: 23333` `d`-tag slug, or returns null if invalid.
 */
export function normalizeTopicSlug(raw: string): string | null {
  if (typeof raw !== 'string') return null
  let cleaned = raw.trim().toLowerCase()
  let prev = ''
  while (cleaned !== prev) {
    prev = cleaned
    if (cleaned.startsWith(TOPIC_CHANNEL_PREFIX)) {
      cleaned = cleaned.slice(TOPIC_CHANNEL_PREFIX.length).trim()
    } else if (cleaned.startsWith('#') || cleaned.startsWith('/')) {
      cleaned = cleaned.slice(1).trim()
    }
  }
  if (!cleaned || cleaned.length > MAX_TOPIC_SLUG_LEN) return null
  return TOPIC_SLUG_RE.test(cleaned) ? cleaned : null
}

/**
 * Builds a canonical `'topic:<slug>'` channel key from raw user input or slug.
 */
export function makeTopicChannelKey(raw: string): string | null {
  const slug = normalizeTopicSlug(raw)
  return slug ? `${TOPIC_CHANNEL_PREFIX}${slug}` : null
}

/**
 * Extracts the validated topic slug from a canonical `'topic:<slug>'` channel key.
 * Returns null for geohash keys or invalid strings.
 */
export function getTopicSlug(key: string | null | undefined): string | null {
  if (typeof key !== 'string') return null
  const trimmed = key.trim().toLowerCase()
  if (!trimmed.startsWith(TOPIC_CHANNEL_PREFIX)) return null
  const rest = trimmed.slice(TOPIC_CHANNEL_PREFIX.length)
  if (!rest || rest.length > MAX_TOPIC_SLUG_LEN) return null
  return TOPIC_SLUG_RE.test(rest) ? rest : null
}

/**
 * Returns true if `key` is a canonical named topic channel key (`'topic:<slug>'`).
 */
export function isTopicChannel(key: string | null | undefined): boolean {
  return getTopicSlug(key) !== null
}

/**
 * Returns true if `raw` is either a valid base32 geohash or a valid `'topic:<slug>'` key.
 */
export function isValidRadioChannelKey(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string') return false
  return isTopicChannel(raw) || isValidGeohash(raw)
}

/**
 * Canonicalizes a radio channel key (either `'topic:<slug>'` or lowercase base32 geohash).
 */
export function normalizeRadioChannelKey(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const slug = getTopicSlug(raw)
  if (slug) return `${TOPIC_CHANNEL_PREFIX}${slug}`
  const gh = normalizeGeohash(raw)
  return isValidGeohash(gh) ? gh : null
}

/**
 * Formats a channel key for display: `'topic:bitcoin'` -> `'#bitcoin'`, `'9q8y'` -> `'#9q8y'`.
 */
export function formatRadioChannelLabel(key: string): string {
  const slug = getTopicSlug(key)
  if (slug) return `#${slug}`
  const gh = normalizeGeohash(key)
  return gh ? `#${gh}` : '#'
}

/**
 * Formats a canonical URL hash fragment for a radio channel key:
 * - topic channel: `#topic=<slug>`
 * - geohash channel: `#<geohash>`
 */
export function formatRadioChannelHash(key: string): string {
  const slug = getTopicSlug(key)
  if (slug) return `#topic=${encodeURIComponent(slug)}`
  return `#${normalizeGeohash(key)}`
}

/**
 * Parses a URL hash fragment into a canonical radio channel key (`'topic:<slug>'` or geohash),
 * or returns null if the hash belongs to another deep link (e.g. `#dm=`, `#notify=`, `#invite=`).
 */
export function parseRadioChannelHash(rawHash: string): string | null {
  const trimmed = rawHash.trim().replace(/^#/, '')
  if (!trimmed) return null

  const topicEqMatch = /^topic=([^&]+)$/i.exec(trimmed)
  if (topicEqMatch) {
    try {
      const decoded = decodeURIComponent(topicEqMatch[1])
      return makeTopicChannelKey(decoded)
    } catch {
      return null
    }
  }

  if (trimmed.toLowerCase().startsWith(TOPIC_CHANNEL_PREFIX)) {
    return makeTopicChannelKey(trimmed)
  }

  // Ignore other structured deep-link hashes (#dm=..., #notify=..., #server=..., #invite=...)
  if (trimmed.includes('=') || trimmed.includes('/')) return null

  const gh = normalizeGeohash(trimmed)
  return isValidGeohash(gh) ? gh : null
}

/**
 * Builds a shareable URL for a radio channel key (`#topic=<slug>` or `#<geohash>`).
 */
export function buildRadioChannelShareUrl(key: string): string {
  const hash = formatRadioChannelHash(key)
  if (typeof window === 'undefined') return hash
  return `${window.location.origin}${window.location.pathname}${hash}`
}

export interface QuickTuneResolution {
  key: string
  kind: 'geohash' | 'topic'
}

/**
 * Resolves quick-tune user input into either a geohash channel or a `kind: 23333` topic channel:
 * - Explicit `topic:<name>` or `/<name>` prefix ALWAYS resolves as a topic channel.
 * - `preferredMode === 'topic'` ALWAYS resolves as a topic channel.
 * - `preferredMode === 'geo'` checks geohash / city / coordinates first, then falls back to a topic slug.
 */
export function parseQuickTuneInput(
  raw: string,
  preferredMode: 'geo' | 'topic' = 'geo'
): QuickTuneResolution | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (/^#?topic:/i.test(trimmed) || trimmed.startsWith('/')) {
    const topicKey = makeTopicChannelKey(trimmed)
    return topicKey ? { key: topicKey, kind: 'topic' } : null
  }

  if (preferredMode === 'topic') {
    const topicKey = makeTopicChannelKey(trimmed)
    return topicKey ? { key: topicKey, kind: 'topic' } : null
  }

  const resolvedGeo = resolveGeohashOrCity(trimmed)
  if (resolvedGeo) {
    return { key: resolvedGeo, kind: 'geohash' }
  }

  const fallbackTopic = makeTopicChannelKey(trimmed)
  return fallbackTopic ? { key: fallbackTopic, kind: 'topic' } : null
}
