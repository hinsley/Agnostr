import { isValidGeohash, normalizeGeohash, resolveGeohashOrCity } from './geohash.ts'
import { getBodyDef, isGeohashableBodyId, type GeohashableBodyId } from './solarSystem.ts'

export const TOPIC_CHANNEL_PREFIX = 'topic:'
export const MAX_TOPIC_SLUG_LEN = 48

const TOPIC_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/

export interface ParsedCelestialChannelKey {
  bodyId: GeohashableBodyId
  geohash: string
}

/**
 * Builds a canonical celestial geohash channel key:
 * - `'earth'` -> bare normalized base32 geohash (e.g. `'9q8y'`)
 * - non-Earth planet/moon -> `'<bodyId>:<geohash>'` (e.g. `'mars:s000'`, `'moon:u4pr'`)
 * Returns `null` if `bodyId` or `geohash` is invalid.
 */
export function makeCelestialChannelKey(
  bodyId: GeohashableBodyId,
  geohash: string
): string | null {
  if (!isGeohashableBodyId(bodyId) || typeof geohash !== 'string') return null
  const normalized = normalizeGeohash(geohash)
  if (!isValidGeohash(normalized)) return null
  if (bodyId === 'earth') return normalized
  return `${bodyId}:${normalized}`
}

/**
 * Parses a Bitchat channel key into its celestial body and raw base32 geohash:
 * - Bare valid geohash (`'9q8y'` or `'#9q8y'`) -> `{ bodyId: 'earth', geohash: '9q8y' }`
 * - Non-Earth celestial key (`'mars:s000'` or `'#mars:s000'`) -> `{ bodyId: 'mars', geohash: 's000' }`
 * - `topic:*`, `'earth:*'`, `'sun:*'`, or invalid strings -> `null`
 */
export function parseCelestialChannelKey(
  key: string | null | undefined
): ParsedCelestialChannelKey | null {
  if (typeof key !== 'string') return null
  const trimmed = key.trim().replace(/^#+/, '').toLowerCase()
  if (!trimmed || trimmed.startsWith(TOPIC_CHANNEL_PREFIX)) return null

  const colonIdx = trimmed.indexOf(':')
  if (colonIdx === -1) {
    const norm = normalizeGeohash(trimmed)
    return norm === trimmed && isValidGeohash(norm)
      ? { bodyId: 'earth', geohash: norm }
      : null
  }

  // Reject multiple colons
  if (trimmed.indexOf(':', colonIdx + 1) !== -1) return null

  const rawBody = trimmed.slice(0, colonIdx)
  const rawGeohash = trimmed.slice(colonIdx + 1)
  if (!isGeohashableBodyId(rawBody) || rawBody === 'earth') return null
  if (!rawGeohash || rawGeohash.startsWith('#')) return null

  const normGeohash = normalizeGeohash(rawGeohash)
  if (normGeohash !== rawGeohash || !isValidGeohash(normGeohash)) return null

  return { bodyId: rawBody, geohash: normGeohash }
}

/**
 * Returns the celestial body id for a geohash channel key (`'earth'` for bare geohashes,
 * `'mars'` for `'mars:s000'`, `null` for `topic:*` or invalid keys).
 */
export function getChannelBodyId(key: string | null | undefined): GeohashableBodyId | null {
  return parseCelestialChannelKey(key)?.bodyId ?? null
}

/**
 * Returns the human-readable body name (e.g. `'Earth'`, `'Mars'`, `'Europa'`) for a
 * geohash channel key, or `null` for topic/invalid keys.
 */
export function getChannelBodyName(key: string | null | undefined): string | null {
  const bodyId = getChannelBodyId(key)
  return bodyId ? getBodyDef(bodyId).name : null
}

/**
 * Extracts the raw base32 geohash from either an Earth or non-Earth celestial channel key:
 * `'mars:9q8y'` -> `'9q8y'`, `'9q8y'` -> `'9q8y'`, `'topic:nostr'` -> `null`.
 */
export function getChannelRawGeohash(key: string | null | undefined): string | null {
  return parseCelestialChannelKey(key)?.geohash ?? null
}

/**
 * Returns true if `key` is a valid celestial geohash channel on a body other than Earth.
 */
export function isCelestialNonEarthChannel(key: string | null | undefined): boolean {
  const parsed = parseCelestialChannelKey(key)
  return parsed !== null && parsed.bodyId !== 'earth'
}

export interface PopularTopicChannel {
  slug: string
  label: string
  description: string
}

export const POPULAR_TOPIC_CHANNELS: readonly PopularTopicChannel[] = [
  { slug: 'general', label: '#general', description: 'Open global Bitchat' },
  { slug: 'nostr', label: '#nostr', description: 'Nostr protocol & clients' },
  { slug: 'bitcoin', label: '#bitcoin', description: 'Bitcoin & Lightning' },
  { slug: 'agnostr', label: '#agnostr', description: 'Agnostr Bitchat lounge' },
  { slug: 'mesh', label: '#mesh', description: 'Off-grid & mesh Bitchat' },
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
 * Returns true if `raw` is a valid Earth geohash, a valid non-Earth celestial `<bodyId>:<geohash>`,
 * or a valid `'topic:<slug>'` key.
 */
export function isValidBitchatChannelKey(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string') return false
  return isTopicChannel(raw) || parseCelestialChannelKey(raw) !== null
}

/**
 * Canonicalizes a Bitchat channel key (`'topic:<slug>'`, Earth lowercase base32 geohash,
 * or non-Earth `'<bodyId>:<geohash>'`).
 */
export function normalizeBitchatChannelKey(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const slug = getTopicSlug(raw)
  if (slug) return `${TOPIC_CHANNEL_PREFIX}${slug}`
  const celestial = parseCelestialChannelKey(raw)
  if (celestial) return makeCelestialChannelKey(celestial.bodyId, celestial.geohash)
  return null
}

/**
 * Formats a channel key for display:
 * - `'topic:bitcoin'` -> `'#bitcoin'`
 * - `'9q8y'` -> `'#9q8y'`
 * - `'mars:s000'` -> `'#mars:s000'`
 */
export function formatBitchatChannelLabel(key: string): string {
  const slug = getTopicSlug(key)
  if (slug) return `#${slug}`
  const celestial = parseCelestialChannelKey(key)
  if (celestial) {
    const canonical = makeCelestialChannelKey(celestial.bodyId, celestial.geohash)
    if (canonical) return `#${canonical}`
  }
  const gh = normalizeGeohash(key)
  return gh ? `#${gh}` : '#'
}

/**
 * Formats a canonical URL hash fragment for a Bitchat channel key:
 * - topic channel: `#topic=<slug>`
 * - Earth geohash channel: `#<geohash>`
 * - non-Earth celestial geohash channel: `#<bodyId>:<geohash>`
 */
export function formatBitchatChannelHash(key: string): string {
  const slug = getTopicSlug(key)
  if (slug) return `#topic=${encodeURIComponent(slug)}`
  const celestial = parseCelestialChannelKey(key)
  if (celestial) {
    const canonical = makeCelestialChannelKey(celestial.bodyId, celestial.geohash)
    if (canonical) return `#${canonical}`
  }
  return `#${normalizeGeohash(key)}`
}

/**
 * Parses a URL hash fragment into a canonical Bitchat channel key (`'topic:<slug>'`,
 * Earth geohash, or non-Earth `'<bodyId>:<geohash>'`), or returns null if the hash
 * belongs to another deep link (e.g. `#dm=`, `#notify=`, `#invite=`, `#agora=`).
 */
export function parseBitchatChannelHash(rawHash: string): string | null {
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

  // Ignore other structured deep-link hashes (#dm=..., #notify=..., #server=..., #invite=..., #agora=...)
  if (trimmed.includes('=') || trimmed.includes('/')) return null

  let candidate = trimmed
  if (candidate.includes('%')) {
    try {
      candidate = decodeURIComponent(candidate)
    } catch {
      return null
    }
  }

  const celestial = parseCelestialChannelKey(candidate)
  return celestial ? makeCelestialChannelKey(celestial.bodyId, celestial.geohash) : null
}

/**
 * Builds a shareable URL for a Bitchat channel key (`#topic=<slug>`, `#<geohash>`, or `#<bodyId>:<geohash>`).
 */
export function buildBitchatChannelShareUrl(key: string): string {
  const hash = formatBitchatChannelHash(key)
  if (typeof window === 'undefined') return hash
  return `${window.location.origin}${window.location.pathname}${hash}`
}

export interface QuickTuneResolution {
  key: string
  kind: 'geohash' | 'topic'
}

/**
 * Resolves quick-tune user input into either a geohash channel (Earth or celestial `<bodyId>:<geohash>`)
 * or a `kind: 23333` topic channel:
 * - Explicit `topic:<name>` or `/<name>` prefix ALWAYS resolves as a topic channel.
 * - `preferredMode === 'topic'` ALWAYS resolves as a topic channel.
 * - `preferredMode === 'geo'` checks explicit celestial `<bodyId>:<geohash>`, then Earth
 *   geohash / city / coordinates, then falls back to a topic slug.
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

  const celestial = parseCelestialChannelKey(trimmed)
  if (celestial && celestial.bodyId !== 'earth') {
    const key = makeCelestialChannelKey(celestial.bodyId, celestial.geohash)
    if (key) return { key, kind: 'geohash' }
  }

  const resolvedGeo = resolveGeohashOrCity(trimmed)
  if (resolvedGeo) {
    return { key: resolvedGeo, kind: 'geohash' }
  }

  const fallbackTopic = makeTopicChannelKey(trimmed)
  return fallbackTopic ? { key: fallbackTopic, kind: 'topic' } : null
}
