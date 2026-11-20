import type {
  AppSettings,
  DmThread,
  GeohashCell,
  GeoMessage,
  PinnedChannel,
  SignMode,
} from '../types/protocol.ts'
import type { GeoRelayEntry } from './geoRelays.ts'
import { DEFAULT_GEOHASH, isValidGeohash, normalizeGeohash } from './geohash.ts'

const PREFIX = 'agnostr:v2:'
const MAX_MESSAGES_PER_CHANNEL = 250
const MAX_CACHED_CHANNELS = 20
const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000

const KEYS = {
  settings: `${PREFIX}settings`,
  nickname: `${PREFIX}nickname`,
  activeGeohash: `${PREFIX}active_geohash`,
  pinnedChannels: `${PREFIX}pinned_channels`,
  recentChannels: `${PREFIX}recent_channels`,
  blockedPubkeys: `${PREFIX}blocked_pubkeys`,
  customRelays: `${PREFIX}custom_relays`,
  dmThreads: `${PREFIX}dm_threads`,
  deviceSeed: `${PREFIX}device_seed`,
  signMode: `${PREFIX}sign_mode`,
  localSecret: `${PREFIX}local_secret`,
  geoDirectory: `${PREFIX}geo_directory`,
  msgIndex: `${PREFIX}msg_index`,
  msgChannel: (gh: string) => `${PREFIX}msgs:${gh}`,
} as const

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'phosphor',
  soundEnabled: true,
  powEnabled: true,
  powTargetBits: 8,
  presenceEnabled: true,
  perGeohashIdentity: false,
  showBridgeBadges: true,
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Ignore storage quota errors
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore
  }
}

function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function loadSettings(): AppSettings {
  const parsed = safeJsonParse<Partial<AppSettings>>(safeGet(KEYS.settings), {})
  return {
    theme:
      parsed.theme === 'phosphor' ||
      parsed.theme === 'amber' ||
      parsed.theme === 'obsidian' ||
      parsed.theme === 'daylight'
        ? parsed.theme
        : DEFAULT_SETTINGS.theme,
    soundEnabled: typeof parsed.soundEnabled === 'boolean' ? parsed.soundEnabled : DEFAULT_SETTINGS.soundEnabled,
    powEnabled: typeof parsed.powEnabled === 'boolean' ? parsed.powEnabled : DEFAULT_SETTINGS.powEnabled,
    powTargetBits:
      typeof parsed.powTargetBits === 'number' && parsed.powTargetBits >= 0 && parsed.powTargetBits <= 16
        ? parsed.powTargetBits
        : DEFAULT_SETTINGS.powTargetBits,
    presenceEnabled:
      typeof parsed.presenceEnabled === 'boolean' ? parsed.presenceEnabled : DEFAULT_SETTINGS.presenceEnabled,
    perGeohashIdentity:
      typeof parsed.perGeohashIdentity === 'boolean'
        ? parsed.perGeohashIdentity
        : DEFAULT_SETTINGS.perGeohashIdentity,
    showBridgeBadges:
      typeof parsed.showBridgeBadges === 'boolean' ? parsed.showBridgeBadges : DEFAULT_SETTINGS.showBridgeBadges,
  }
}

export function saveSettings(settings: AppSettings): void {
  safeSet(KEYS.settings, JSON.stringify(settings))
}

export function loadNickname(): string | null {
  const raw = safeGet(KEYS.nickname)
  return raw && raw.trim().length > 0 ? raw.trim().slice(0, 32) : null
}

export function saveNickname(nickname: string): void {
  safeSet(KEYS.nickname, nickname.trim().slice(0, 32))
}

export function loadActiveGeohash(): string {
  const saved = safeGet(KEYS.activeGeohash)
  if (saved && isValidGeohash(saved)) return normalizeGeohash(saved)
  return DEFAULT_GEOHASH
}

export function saveActiveGeohash(geohash: string): void {
  safeSet(KEYS.activeGeohash, normalizeGeohash(geohash))
}

export function loadPinnedChannels(): PinnedChannel[] {
  const parsed = safeJsonParse<PinnedChannel[]>(safeGet(KEYS.pinnedChannels), [])
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((p) => p && typeof p.geohash === 'string' && isValidGeohash(p.geohash))
    .map((p) => ({
      geohash: normalizeGeohash(p.geohash),
      label: typeof p.label === 'string' ? p.label : undefined,
      pinnedAt: typeof p.pinnedAt === 'number' ? p.pinnedAt : Date.now(),
      unreadCount: 0,
      mentionCount: 0,
    }))
}

export function savePinnedChannels(channels: PinnedChannel[]): void {
  const clean = channels.map((c) => ({
    geohash: c.geohash,
    label: c.label,
    pinnedAt: c.pinnedAt,
    unreadCount: 0,
    mentionCount: 0,
  }))
  safeSet(KEYS.pinnedChannels, JSON.stringify(clean))
}

export function loadRecentChannels(): string[] {
  const parsed = safeJsonParse<string[]>(safeGet(KEYS.recentChannels), [])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((g) => typeof g === 'string' && isValidGeohash(g)).slice(0, 12)
}

export function saveRecentChannels(channels: string[]): void {
  safeSet(KEYS.recentChannels, JSON.stringify(channels.slice(0, 12)))
}

export function loadBlockedPubkeys(): string[] {
  const parsed = safeJsonParse<string[]>(safeGet(KEYS.blockedPubkeys), [])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((p) => typeof p === 'string' && /^[0-9a-f]{64}$/i.test(p)).map((p) => p.toLowerCase())
}

export function saveBlockedPubkeys(pubkeys: string[]): void {
  safeSet(KEYS.blockedPubkeys, JSON.stringify(Array.from(new Set(pubkeys.map((p) => p.toLowerCase())))))
}

export function loadCustomRelays(): string[] {
  const parsed = safeJsonParse<string[]>(safeGet(KEYS.customRelays), [])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((u) => typeof u === 'string' && u.startsWith('ws'))
}

export function saveCustomRelays(relays: string[]): void {
  safeSet(KEYS.customRelays, JSON.stringify(relays))
}

export function loadDeviceSeedHex(): string | null {
  const v2 = safeGet(KEYS.deviceSeed)
  if (v2 && /^[0-9a-fA-F]{64}$/.test(v2)) return v2.toLowerCase()
  // Migrate legacy ephemeral_sk seamlessly if present
  const legacy = safeGet('ephemeral_sk')
  if (legacy && /^[0-9a-fA-F]{64}$/.test(legacy)) {
    safeSet(KEYS.deviceSeed, legacy.toLowerCase())
    return legacy.toLowerCase()
  }
  return null
}

export function saveDeviceSeedHex(hex: string): void {
  safeSet(KEYS.deviceSeed, hex.toLowerCase())
}

export function loadSignMode(hasNip07: boolean): SignMode {
  const raw = safeGet(KEYS.signMode)
  if (raw === 'auto' || raw === 'local' || raw === 'extension') {
    if (raw === 'extension' && !hasNip07) return 'auto'
    return raw
  }
  return 'auto'
}

export function saveSignMode(mode: SignMode): void {
  safeSet(KEYS.signMode, mode)
}

export function loadLocalSecret(): string {
  return safeGet(KEYS.localSecret) ?? ''
}

export function saveLocalSecret(secret: string): void {
  if (!secret.trim()) {
    safeRemove(KEYS.localSecret)
  } else {
    safeSet(KEYS.localSecret, secret.trim())
  }
}

export function loadChannelMessages(geohash: string): GeoMessage[] {
  const gh = normalizeGeohash(geohash)
  const parsed = safeJsonParse<GeoMessage[]>(safeGet(KEYS.msgChannel(gh)), [])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((m) => m && typeof m.id === 'string' && typeof m.content === 'string')
}

export function saveChannelMessages(geohash: string, messages: GeoMessage[]): void {
  const gh = normalizeGeohash(geohash)
  const trimmed = messages.filter((m) => !m.isSystem).slice(-MAX_MESSAGES_PER_CHANNEL)
  safeSet(KEYS.msgChannel(gh), JSON.stringify(trimmed))

  const index = safeJsonParse<string[]>(safeGet(KEYS.msgIndex), []).filter((g) => g !== gh)
  index.unshift(gh)
  while (index.length > MAX_CACHED_CHANNELS) {
    const evicted = index.pop()
    if (evicted) safeRemove(KEYS.msgChannel(evicted))
  }
  safeSet(KEYS.msgIndex, JSON.stringify(index))
}

export function clearChannelMessagesStorage(geohash: string): void {
  safeRemove(KEYS.msgChannel(normalizeGeohash(geohash)))
}

export function loadDmThreads(): DmThread[] {
  const parsed = safeJsonParse<DmThread[]>(safeGet(KEYS.dmThreads), [])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((t) => t && typeof t.peerPubkey === 'string' && Array.isArray(t.messages))
}

export function saveDmThreads(threads: DmThread[]): void {
  const capped = threads.slice(0, 30).map((t) => ({
    ...t,
    messages: t.messages.slice(-150),
  }))
  safeSet(KEYS.dmThreads, JSON.stringify(capped))
}

interface GeoDirectoryCache {
  fetchedAt: number
  entries: GeoRelayEntry[]
}

export function loadGeoDirectoryCache(): GeoRelayEntry[] | null {
  const parsed = safeJsonParse<GeoDirectoryCache | null>(safeGet(KEYS.geoDirectory), null)
  if (!parsed || !Array.isArray(parsed.entries) || typeof parsed.fetchedAt !== 'number') {
    return null
  }
  if (Date.now() - parsed.fetchedAt > GEO_CACHE_TTL_MS) {
    return null
  }
  return parsed.entries
}

export function saveGeoDirectoryCache(entries: GeoRelayEntry[]): void {
  const payload: GeoDirectoryCache = { fetchedAt: Date.now(), entries }
  safeSet(KEYS.geoDirectory, JSON.stringify(payload))
}

export function panicWipeStorage(): void {
  try {
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && (k.startsWith('agnostr:') || k.startsWith('agnostr_') || k === 'ephemeral_sk')) {
        toRemove.push(k)
      }
    }
    for (const k of toRemove) localStorage.removeItem(k)
  } catch {
    // Ignore
  }
  try {
    const toRemove: string[] = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k && (k.startsWith('agnostr:') || k.startsWith('agnostr_') || k === 'ephemeral_sk')) {
        toRemove.push(k)
      }
    }
    for (const k of toRemove) sessionStorage.removeItem(k)
  } catch {
    // Ignore
  }
}

export function formatTranscriptExport(
  format: 'markdown' | 'json',
  cell: GeohashCell,
  messages: GeoMessage[]
): { filename: string; content: string; mimeType: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  if (format === 'json') {
    return {
      filename: `agnostr-${cell.geohash}-${stamp}.json`,
      mimeType: 'application/json',
      content: JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          channel: `#${cell.geohash}`,
          precision: cell.precision,
          level: cell.label,
          center: cell.center,
          nearestCity: cell.nearestCity,
          messageCount: messages.length,
          messages: messages.map((m) => ({
            id: m.id,
            createdAt: new Date(m.createdAt * 1000).toISOString(),
            pubkey: m.pubkey,
            handle: m.displayHandle,
            content: m.content,
            isTeleported: m.isTeleported,
            isMeshBridge: m.isMeshBridge,
            powBits: m.powBits,
            replyToId: m.replyTo?.id ?? null,
            reactions: m.reactions.map((r) => ({ emoji: r.emoji, count: r.count })),
          })),
        },
        null,
        2
      ),
    }
  }

  const lines: string[] = [
    `# Agnostr Transcript — #${cell.geohash}`,
    '',
    `- **Exported**: ${new Date().toISOString()}`,
    `- **Scope**: ${cell.label} (${cell.approxSizeLabel})${cell.nearestCity ? ` · ${cell.nearestCity}` : ''}`,
    `- **Coordinates**: ${cell.center.lat.toFixed(4)}, ${cell.center.lon.toFixed(4)}`,
    `- **Messages**: ${messages.length}`,
    '',
    '---',
    '',
  ]

  for (const m of messages) {
    const iso = new Date(m.createdAt * 1000).toISOString().replace('T', ' ').slice(0, 19)
    const badges: string[] = []
    if (m.isTeleported) badges.push('TELEPORT')
    if (m.isMeshBridge) badges.push('MESH')
    if (m.powBits > 0) badges.push(`PoW:${m.powBits}`)
    const badgeStr = badges.length > 0 ? ` [${badges.join(', ')}]` : ''
    if (m.isSystem) {
      lines.push(`*${iso} — ${m.content}*`)
    } else {
      lines.push(`**[${iso}] ${m.displayHandle}**${badgeStr}: ${m.content}`)
      if (m.reactions.length > 0) {
        lines.push(`  > Reactions: ${m.reactions.map((r) => `${r.emoji} ${r.count}`).join('  ')}`)
      }
    }
  }

  return {
    filename: `agnostr-${cell.geohash}-${stamp}.md`,
    mimeType: 'text/markdown;charset=utf-8',
    content: lines.join('\n'),
  }
}
