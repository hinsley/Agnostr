import type { RecordingQualityPreset, TurnServerConfig } from '../types/calls.ts'
import type {
  NotificationFilterMode,
  NotificationSettings,
} from '../types/notifications.ts'
import type {
  AppSettings,
  DmThread,
  GeohashCell,
  GeoMessage,
  PinnedChannel,
  SignMode,
  TrustedPeerEntry,
} from '../types/protocol.ts'
import type { ServerMessage, ServerSummary } from '../types/servers.ts'
import type { PersistedTranscriptionConfig, TranscriptionModelSpec } from '../types/transcription.ts'
import { DEFAULT_BLOSSOM_SERVERS, normalizeBlossomServerUrl } from './blossom.ts'
import { DEFAULT_RECORDING_QUALITY, isValidRecordingQuality } from './callRecorder.ts'
import type { GeoRelayEntry } from './geoRelays.ts'
import { DEFAULT_GEOHASH, isValidGeohash, normalizeGeohash } from './geohash.ts'
import { encodeNpubSafe } from './identity.ts'
import {
  DEFAULT_AUTO_TRANSCRIBE,
  DEFAULT_TRANSCRIPTION_MODEL_ID,
  mergeTranscriptionModels,
  resolveActiveTranscriptionModel,
} from './transcriptionModels.ts'

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
  trusted: `${PREFIX}trusted`,
  blossomServers: `${PREFIX}blossom_servers`,
  iceServers: `${PREFIX}ice_servers`,
  recordingQuality: `${PREFIX}recording_quality`,
  transcription: `${PREFIX}transcription`,
  memoTranscripts: `${PREFIX}memo_transcripts`,
  notifications: `${PREFIX}notifications`,
  servers: `${PREFIX}servers`,
  serverMsgChannel: (serverId: string, channelId: string) => `${PREFIX}smsgs:${serverId}:${channelId}`,
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
  strictWhitelistMode: false,
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
    strictWhitelistMode:
      typeof parsed.strictWhitelistMode === 'boolean'
        ? parsed.strictWhitelistMode
        : DEFAULT_SETTINGS.strictWhitelistMode,
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

export function loadTrustedPubkeys(): TrustedPeerEntry[] {
  const parsed = safeJsonParse<TrustedPeerEntry[]>(safeGet(KEYS.trusted), [])
  if (!Array.isArray(parsed)) return []
  const seen = new Set<string>()
  const out: TrustedPeerEntry[] = []
  for (const item of parsed) {
    if (!item || typeof item.pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(item.pubkey)) continue
    const pk = item.pubkey.toLowerCase()
    if (seen.has(pk)) continue
    seen.add(pk)
    out.push({
      pubkey: pk,
      npub: typeof item.npub === 'string' && item.npub.startsWith('npub1') ? item.npub : encodeNpubSafe(pk),
      label: typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 48) : undefined,
      addedAt: typeof item.addedAt === 'number' ? item.addedAt : Date.now(),
    })
  }
  return out
}

export function saveTrustedPubkeys(entries: TrustedPeerEntry[]): void {
  safeSet(KEYS.trusted, JSON.stringify(entries))
}

export function loadBlossomServers(): string[] {
  const raw = safeGet(KEYS.blossomServers)
  if (!raw) return [...DEFAULT_BLOSSOM_SERVERS]
  const parsed = safeJsonParse<string[]>(raw, [])
  if (!Array.isArray(parsed)) return [...DEFAULT_BLOSSOM_SERVERS]
  const valid = parsed
    .filter((u): u is string => typeof u === 'string')
    .map((u) => normalizeBlossomServerUrl(u))
    .filter((u): u is string => u !== null)
  return valid.length > 0 ? Array.from(new Set(valid)) : [...DEFAULT_BLOSSOM_SERVERS]
}

export function saveBlossomServers(servers: string[]): void {
  safeSet(KEYS.blossomServers, JSON.stringify(servers))
}

export function normalizeTurnUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  if (!/^(turns?|stuns?):[^\s]+$/i.test(trimmed)) return null
  return trimmed
}

export function loadTurnConfig(): TurnServerConfig | null {
  const parsed = safeJsonParse<Partial<TurnServerConfig> | null>(safeGet(KEYS.iceServers), null)
  if (!parsed || typeof parsed.url !== 'string') return null
  const url = normalizeTurnUrl(parsed.url)
  if (!url) return null
  return {
    url,
    username: typeof parsed.username === 'string' && parsed.username.trim() ? parsed.username.trim() : undefined,
    credential:
      typeof parsed.credential === 'string' && parsed.credential.trim() ? parsed.credential.trim() : undefined,
  }
}

export function saveTurnConfig(config: TurnServerConfig | null): void {
  if (!config) {
    safeRemove(KEYS.iceServers)
    return
  }
  const url = normalizeTurnUrl(config.url)
  if (!url) {
    safeRemove(KEYS.iceServers)
    return
  }
  safeSet(
    KEYS.iceServers,
    JSON.stringify({
      url,
      username: config.username?.trim() || undefined,
      credential: config.credential?.trim() || undefined,
    })
  )
}

export function loadRecordingQuality(): RecordingQualityPreset {
  const raw = safeGet(KEYS.recordingQuality)
  return isValidRecordingQuality(raw) ? raw : DEFAULT_RECORDING_QUALITY
}

export function saveRecordingQuality(quality: RecordingQualityPreset): void {
  if (!isValidRecordingQuality(quality)) return
  safeSet(KEYS.recordingQuality, quality)
}

export function loadTranscriptionConfig(): PersistedTranscriptionConfig {
  const parsed = safeJsonParse<Partial<PersistedTranscriptionConfig> | null>(
    safeGet(KEYS.transcription),
    null
  )
  const rawCustom = Array.isArray(parsed?.customModels)
    ? (parsed.customModels as TranscriptionModelSpec[])
    : []
  const merged = mergeTranscriptionModels(rawCustom)
  const customModels = merged.filter((m) => !m.isBuiltIn)
  const requestedId =
    typeof parsed?.activeModelId === 'string' && parsed.activeModelId.trim()
      ? parsed.activeModelId.trim()
      : DEFAULT_TRANSCRIPTION_MODEL_ID
  const active = resolveActiveTranscriptionModel(merged, requestedId)
  const autoTranscribe =
    typeof parsed?.autoTranscribe === 'boolean'
      ? parsed.autoTranscribe
      : DEFAULT_AUTO_TRANSCRIBE
  return {
    activeModelId: active.id,
    autoTranscribe,
    customModels,
  }
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: false,
  dms: true,
  directPings: true,
  dmCallRinging: true,
  serverMessages: 'all',
  serverCalls: true,
  geoMessages: 'all',
  soundEnabled: true,
  ringtoneEnabled: true,
  vibrationEnabled: true,
  showPreviews: true,
  pushBridgeUrl: '',
  vapidPublicKey: '',
}

function parseFilterMode(
  raw: unknown,
  fallback: NotificationFilterMode
): NotificationFilterMode {
  if (raw === 'all' || raw === 'mentions' || raw === 'off') return raw
  return fallback
}

export function loadNotificationSettings(): NotificationSettings {
  const parsed = safeJsonParse<Partial<NotificationSettings>>(
    safeGet(KEYS.notifications),
    {}
  )
  return {
    enabled:
      typeof parsed.enabled === 'boolean'
        ? parsed.enabled
        : DEFAULT_NOTIFICATION_SETTINGS.enabled,
    dms:
      typeof parsed.dms === 'boolean'
        ? parsed.dms
        : DEFAULT_NOTIFICATION_SETTINGS.dms,
    directPings:
      typeof parsed.directPings === 'boolean'
        ? parsed.directPings
        : DEFAULT_NOTIFICATION_SETTINGS.directPings,
    dmCallRinging:
      typeof parsed.dmCallRinging === 'boolean'
        ? parsed.dmCallRinging
        : DEFAULT_NOTIFICATION_SETTINGS.dmCallRinging,
    serverMessages: parseFilterMode(
      parsed.serverMessages,
      DEFAULT_NOTIFICATION_SETTINGS.serverMessages
    ),
    serverCalls:
      typeof parsed.serverCalls === 'boolean'
        ? parsed.serverCalls
        : DEFAULT_NOTIFICATION_SETTINGS.serverCalls,
    geoMessages: parseFilterMode(
      parsed.geoMessages,
      DEFAULT_NOTIFICATION_SETTINGS.geoMessages
    ),
    soundEnabled:
      typeof parsed.soundEnabled === 'boolean'
        ? parsed.soundEnabled
        : DEFAULT_NOTIFICATION_SETTINGS.soundEnabled,
    ringtoneEnabled:
      typeof parsed.ringtoneEnabled === 'boolean'
        ? parsed.ringtoneEnabled
        : DEFAULT_NOTIFICATION_SETTINGS.ringtoneEnabled,
    vibrationEnabled:
      typeof parsed.vibrationEnabled === 'boolean'
        ? parsed.vibrationEnabled
        : DEFAULT_NOTIFICATION_SETTINGS.vibrationEnabled,
    showPreviews:
      typeof parsed.showPreviews === 'boolean'
        ? parsed.showPreviews
        : DEFAULT_NOTIFICATION_SETTINGS.showPreviews,
    pushBridgeUrl:
      typeof parsed.pushBridgeUrl === 'string'
        ? parsed.pushBridgeUrl.trim().slice(0, 256)
        : '',
    vapidPublicKey:
      typeof parsed.vapidPublicKey === 'string'
        ? parsed.vapidPublicKey.trim().slice(0, 256)
        : '',
  }
}

export function saveNotificationSettings(settings: NotificationSettings): void {
  safeSet(KEYS.notifications, JSON.stringify(settings))
}

export function saveTranscriptionConfig(config: PersistedTranscriptionConfig): void {
  const customOnly = config.customModels.filter((m) => !m.isBuiltIn).slice(0, 12)
  safeSet(
    KEYS.transcription,
    JSON.stringify({
      activeModelId: config.activeModelId,
      autoTranscribe: config.autoTranscribe,
      customModels: customOnly,
    })
  )
}

export interface PersistedMemoTranscriptEntry {
  text: string
  modelLabel?: string
  updatedAt: number
}

const MAX_CACHED_MEMO_TRANSCRIPTS = 400

function trimMemoTranscriptCache(
  cache: Record<string, PersistedMemoTranscriptEntry>,
  maxEntries: number
): Record<string, PersistedMemoTranscriptEntry> {
  const entries = Object.entries(cache).filter(
    ([k, v]) =>
      k.trim().length > 0 &&
      v &&
      typeof v.text === 'string' &&
      v.text.trim().length > 0
  )
  if (entries.length <= maxEntries) {
    return Object.fromEntries(entries)
  }
  entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
  return Object.fromEntries(entries.slice(0, maxEntries))
}

export function loadMemoTranscriptCache(): Record<string, PersistedMemoTranscriptEntry> {
  const parsed = safeJsonParse<Record<string, Partial<PersistedMemoTranscriptEntry>>>(
    safeGet(KEYS.memoTranscripts),
    {}
  )
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, PersistedMemoTranscriptEntry> = {}
  for (const [key, val] of Object.entries(parsed)) {
    if (!key.trim() || !val || typeof val.text !== 'string' || !val.text.trim()) continue
    out[key] = {
      text: val.text.trim(),
      modelLabel:
        typeof val.modelLabel === 'string' && val.modelLabel.trim()
          ? val.modelLabel.trim().slice(0, 64)
          : undefined,
      updatedAt:
        typeof val.updatedAt === 'number' && Number.isFinite(val.updatedAt)
          ? val.updatedAt
          : Date.now(),
    }
  }
  return trimMemoTranscriptCache(out, MAX_CACHED_MEMO_TRANSCRIPTS)
}

export function saveMemoTranscriptCache(
  cache: Record<string, PersistedMemoTranscriptEntry>
): Record<string, PersistedMemoTranscriptEntry> {
  let pruned = trimMemoTranscriptCache(cache, MAX_CACHED_MEMO_TRANSCRIPTS)
  try {
    localStorage.setItem(KEYS.memoTranscripts, JSON.stringify(pruned))
    return pruned
  } catch {
    // QuotaExceededError or storage full — evict oldest half and retry once
    const halfCap = Math.max(20, Math.floor(Object.keys(pruned).length / 2))
    pruned = trimMemoTranscriptCache(pruned, halfCap)
    try {
      localStorage.setItem(KEYS.memoTranscripts, JSON.stringify(pruned))
    } catch {
      // Ignore persistent storage restriction
    }
    return pruned
  }
}

export function clearMemoTranscriptCache(): void {
  safeRemove(KEYS.memoTranscripts)
}

export function loadJoinedServers(): ServerSummary[] {
  const parsed = safeJsonParse<ServerSummary[]>(safeGet(KEYS.servers), [])
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((s) => s && typeof s.id === 'string' && (s.kind === 'virtual' || s.kind === 'nip29') && typeof s.name === 'string')
    .map((s) => ({
      ...s,
      channels: Array.isArray(s.channels) && s.channels.length > 0 ? s.channels : [{ id: s.groupId || 'general', name: s.groupId || 'general' }],
      moderators: Array.isArray(s.moderators) ? s.moderators : [],
      bannedPubkeys: Array.isArray(s.bannedPubkeys) ? s.bannedPubkeys : [],
      relays: Array.isArray(s.relays) ? s.relays : [],
      unreadCount: 0,
      mentionCount: 0,
    }))
}

export function saveJoinedServers(servers: ServerSummary[]): void {
  const clean = servers.slice(0, 40).map((s) => ({
    ...s,
    unreadCount: 0,
    mentionCount: 0,
  }))
  safeSet(KEYS.servers, JSON.stringify(clean))
}

export function loadServerChannelMessages(serverId: string, channelId: string): ServerMessage[] {
  const parsed = safeJsonParse<ServerMessage[]>(safeGet(KEYS.serverMsgChannel(serverId, channelId)), [])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((m) => m && typeof m.id === 'string' && typeof m.content === 'string')
}

export function saveServerChannelMessages(
  serverId: string,
  channelId: string,
  messages: ServerMessage[]
): void {
  const trimmed = messages.filter((m) => !m.isSystem).slice(-MAX_MESSAGES_PER_CHANNEL)
  safeSet(KEYS.serverMsgChannel(serverId, channelId), JSON.stringify(trimmed))
}

export function clearServerChannelMessagesStorage(serverId: string, channelId: string): void {
  safeRemove(KEYS.serverMsgChannel(serverId, channelId))
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
  return parsed
    .filter((t) => t && typeof t.peerPubkey === 'string' && Array.isArray(t.messages))
    .map((t) => ({
      ...t,
      messages: t.messages
        .filter((m) => m && typeof m.id === 'string' && typeof m.createdAt === 'number')
        .map((m) => ({
          ...m,
          orderMs:
            typeof m.orderMs === 'number' && Number.isFinite(m.orderMs) ? m.orderMs : undefined,
        })),
    }))
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
            voiceMemo: m.voiceMemo ?? null,
            imageAttachment: m.imageAttachment ?? null,
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
      const voiceSuffix = m.voiceMemo ? ` [Voice memo ${Math.round(m.voiceMemo.durationSec)}s]` : ''
      const imageSuffix = m.imageAttachment
        ? ` [Image ${m.imageAttachment.width > 0 ? `${m.imageAttachment.width}x${m.imageAttachment.height}` : m.imageAttachment.mime}]`
        : ''
      lines.push(`**[${iso}] ${m.displayHandle}**${badgeStr}${voiceSuffix}${imageSuffix}: ${m.content}`)
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
