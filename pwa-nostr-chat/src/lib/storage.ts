import type { RecordingQualityPreset, TurnServerConfig } from '../types/calls.ts'
import {
  DEFAULT_CONTENT_FILTER_SETTINGS,
  type ContentFilterCallVideoMode,
  type ContentFilterCategory,
  type ContentFilterMediaScope,
  type ContentFilterSettings,
  type ContentFilterVerdict,
} from '../types/contentFilter.ts'
import type {
  DeviceSyncCrdtState,
  LinkedDeviceInfo,
  PersistedDeviceSyncState,
  SyncedDeviceRecord,
  SyncedDmPeerNameRecord,
  SyncedPeerNoteRecord,
  SyncedServerOrderState,
} from '../types/deviceSync.ts'
import type {
  NotificationFilterMode,
  NotificationSettings,
} from '../types/notifications.ts'
import type {
  AppSettings,
  DmMessage,
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
import { DEFAULT_GEOHASH, normalizeGeohash } from './geohash.ts'
import { encodeNpubSafe } from './identity.ts'
import { isGlobalProfileVaultKey } from './profileVault.ts'
import {
  formatBitchatChannelLabel,
  getTopicSlug,
  isTopicChannel,
  isValidBitchatChannelKey,
  normalizeBitchatChannelKey,
} from './bitchatChannel.ts'
import {
  DEFAULT_AUTO_TRANSCRIBE,
  DEFAULT_TRANSCRIPTION_MODEL_ID,
  mergeTranscriptionModels,
  resolveActiveTranscriptionModel,
} from './transcriptionModels.ts'
import { formatVoiceDuration } from './voiceRecorder.ts'

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
  blockedPeerNames: `${PREFIX}blocked_peer_names`,
  trusted: `${PREFIX}trusted`,
  peerNotes: `${PREFIX}peer_notes`,
  blossomServers: `${PREFIX}blossom_servers`,
  iceServers: `${PREFIX}ice_servers`,
  recordingQuality: `${PREFIX}recording_quality`,
  transcription: `${PREFIX}transcription`,
  memoTranscripts: `${PREFIX}memo_transcripts`,
  contentFilterSettings: `${PREFIX}content_filter_settings`,
  filterVerdicts: `${PREFIX}filter_verdicts`,
  notifications: `${PREFIX}notifications`,
  servers: `${PREFIX}servers`,
  serverMsgChannel: (serverId: string, channelId: string) => `${PREFIX}smsgs:${serverId}:${channelId}`,
  customRelays: `${PREFIX}custom_relays`,
  dmThreads: `${PREFIX}dm_threads`,
  dmClearedAt: `${PREFIX}dm_cleared_at`,
  deviceSeed: `${PREFIX}device_seed`,
  deviceId: `${PREFIX}device_id`,
  deviceLabel: `${PREFIX}device_label`,
  deviceSyncState: `${PREFIX}device_sync_state`,
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
  showBridgeBadges: true,
  broadcastClientTag: true,
  strictWhitelistMode: false,
  allowUntrustedVoiceMemos: true,
  allowUntrustedLinks: false,
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
      parsed.theme === 'indigo' ||
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
    showBridgeBadges:
      typeof parsed.showBridgeBadges === 'boolean' ? parsed.showBridgeBadges : DEFAULT_SETTINGS.showBridgeBadges,
    broadcastClientTag:
      typeof parsed.broadcastClientTag === 'boolean'
        ? parsed.broadcastClientTag
        : DEFAULT_SETTINGS.broadcastClientTag,
    strictWhitelistMode:
      typeof parsed.strictWhitelistMode === 'boolean'
        ? parsed.strictWhitelistMode
        : DEFAULT_SETTINGS.strictWhitelistMode,
    allowUntrustedVoiceMemos:
      typeof parsed.allowUntrustedVoiceMemos === 'boolean'
        ? parsed.allowUntrustedVoiceMemos
        : DEFAULT_SETTINGS.allowUntrustedVoiceMemos,
    allowUntrustedLinks:
      typeof parsed.allowUntrustedLinks === 'boolean'
        ? parsed.allowUntrustedLinks
        : DEFAULT_SETTINGS.allowUntrustedLinks,
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
  const normalized = normalizeBitchatChannelKey(saved)
  if (normalized) return normalized
  return DEFAULT_GEOHASH
}

export function saveActiveGeohash(geohash: string): void {
  const normalized = normalizeBitchatChannelKey(geohash) ?? normalizeGeohash(geohash)
  safeSet(KEYS.activeGeohash, normalized)
}

export function loadPinnedChannels(): PinnedChannel[] {
  const parsed = safeJsonParse<PinnedChannel[]>(safeGet(KEYS.pinnedChannels), [])
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((p) => p && typeof p.geohash === 'string' && isValidBitchatChannelKey(p.geohash))
    .map((p) => ({
      geohash: normalizeBitchatChannelKey(p.geohash) ?? normalizeGeohash(p.geohash),
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
  const seen = new Set<string>()
  const out: string[] = []
  for (const g of parsed) {
    if (typeof g !== 'string') continue
    const normalized = normalizeBitchatChannelKey(g)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
    if (out.length >= 12) break
  }
  return out
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

const MAX_BLOCKED_PEER_NAME_CHARS = 64
const MAX_BLOCKED_PEER_NAMES = 500

export function loadBlockedPeerNames(): Record<string, string> {
  const parsed = safeJsonParse<Record<string, unknown>>(safeGet(KEYS.blockedPeerNames), {})
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  let count = 0
  for (const [rawKey, rawVal] of Object.entries(parsed)) {
    const pk = rawKey.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pk) || typeof rawVal !== 'string') continue
    const clean = rawVal.trim().slice(0, MAX_BLOCKED_PEER_NAME_CHARS)
    if (!clean) continue
    out[pk] = clean
    count += 1
    if (count >= MAX_BLOCKED_PEER_NAMES) break
  }
  return out
}

export function saveBlockedPeerNames(map: Record<string, string>): void {
  const out: Record<string, string> = {}
  let count = 0
  for (const [rawKey, rawVal] of Object.entries(map)) {
    const pk = rawKey.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pk) || typeof rawVal !== 'string') continue
    const clean = rawVal.trim().slice(0, MAX_BLOCKED_PEER_NAME_CHARS)
    if (!clean) continue
    out[pk] = clean
    count += 1
    if (count >= MAX_BLOCKED_PEER_NAMES) break
  }
  safeSet(KEYS.blockedPeerNames, JSON.stringify(out))
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

const MAX_PEER_NOTE_CHARS = 400
const MAX_PEER_NOTES = 500

export function loadPeerNotes(): Record<string, string> {
  const parsed = safeJsonParse<Record<string, unknown>>(safeGet(KEYS.peerNotes), {})
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  let count = 0
  for (const [rawKey, rawVal] of Object.entries(parsed)) {
    if (count >= MAX_PEER_NOTES) break
    const pk = rawKey.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pk) || typeof rawVal !== 'string') continue
    const clean = rawVal.trim().slice(0, MAX_PEER_NOTE_CHARS)
    if (!clean) continue
    out[pk] = clean
    count += 1
  }
  return out
}

export function savePeerNotes(notes: Record<string, string>): void {
  const out: Record<string, string> = {}
  let count = 0
  for (const [rawKey, rawVal] of Object.entries(notes)) {
    if (count >= MAX_PEER_NOTES) break
    const pk = rawKey.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pk) || typeof rawVal !== 'string') continue
    const clean = rawVal.trim().slice(0, MAX_PEER_NOTE_CHARS)
    if (!clean) continue
    out[pk] = clean
    count += 1
  }
  safeSet(KEYS.peerNotes, JSON.stringify(out))
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

export const DEFAULT_PUSH_BRIDGE_URL =
  'https://agnostr-push.carterhinsley.workers.dev'
export const DEFAULT_VAPID_PUBLIC_KEY =
  'BE9QkU-IRUe-sR41iijQzlEVp9XISMeBLcCyH5dEyaUtlNkxzUNtfnra_5ALcTxHuRDIdbPerGC06VjSgOjtjHE'
export const NOTIFICATION_PREFS_VERSION = 2

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: false,
  dms: true,
  agmail: true,
  agmailCcBcc: true,
  directPings: true,
  dmCallRinging: true,
  serverMessages: 'mentions',
  serverCalls: true,
  geoMessages: 'mentions',
  agoraRepliesMentions: true,
  agoraReactionsReposts: true,
  agoraZaps: true,
  agoraFollows: true,
  soundEnabled: true,
  ringtoneEnabled: true,
  vibrationEnabled: true,
  showPreviews: true,
  pushBridgeUrl: DEFAULT_PUSH_BRIDGE_URL,
  vapidPublicKey: DEFAULT_VAPID_PUBLIC_KEY,
  prefsVersion: NOTIFICATION_PREFS_VERSION,
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
  const persistedBridgeUrl =
    typeof parsed.pushBridgeUrl === 'string'
      ? parsed.pushBridgeUrl.trim().slice(0, 256)
      : ''
  const resolvedBridgeUrl = persistedBridgeUrl || DEFAULT_PUSH_BRIDGE_URL
  const persistedVapidKey =
    typeof parsed.vapidPublicKey === 'string'
      ? parsed.vapidPublicKey.trim().slice(0, 256)
      : ''
  const normalizedBridgeUrl = resolvedBridgeUrl.replace(/\/+$/, '')
  const resolvedVapidKey =
    persistedVapidKey ||
    (normalizedBridgeUrl === DEFAULT_PUSH_BRIDGE_URL
      ? DEFAULT_VAPID_PUBLIC_KEY
      : '')

  // Migrate untouched pre-v2 defaults (both serverMessages & geoMessages === 'all') to 'mentions' (Pings only).
  // Once saved with prefsVersion: 2, any explicit 'all' choice persists faithfully.
  const storedVersion =
    typeof parsed.prefsVersion === 'number' && Number.isFinite(parsed.prefsVersion)
      ? parsed.prefsVersion
      : 0
  const migrateUntouchedAllDefault =
    storedVersion < NOTIFICATION_PREFS_VERSION &&
    parsed.serverMessages === 'all' &&
    parsed.geoMessages === 'all'

  const serverMessages: NotificationFilterMode = migrateUntouchedAllDefault
    ? 'mentions'
    : parseFilterMode(
        parsed.serverMessages,
        DEFAULT_NOTIFICATION_SETTINGS.serverMessages
      )
  const geoMessages: NotificationFilterMode = migrateUntouchedAllDefault
    ? 'mentions'
    : parseFilterMode(
        parsed.geoMessages,
        DEFAULT_NOTIFICATION_SETTINGS.geoMessages
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
    agmail:
      typeof parsed.agmail === 'boolean'
        ? parsed.agmail
        : DEFAULT_NOTIFICATION_SETTINGS.agmail,
    agmailCcBcc:
      typeof parsed.agmailCcBcc === 'boolean'
        ? parsed.agmailCcBcc
        : DEFAULT_NOTIFICATION_SETTINGS.agmailCcBcc,
    directPings:
      typeof parsed.directPings === 'boolean'
        ? parsed.directPings
        : DEFAULT_NOTIFICATION_SETTINGS.directPings,
    dmCallRinging:
      typeof parsed.dmCallRinging === 'boolean'
        ? parsed.dmCallRinging
        : DEFAULT_NOTIFICATION_SETTINGS.dmCallRinging,
    serverMessages,
    serverCalls:
      typeof parsed.serverCalls === 'boolean'
        ? parsed.serverCalls
        : DEFAULT_NOTIFICATION_SETTINGS.serverCalls,
    geoMessages,
    agoraRepliesMentions:
      typeof parsed.agoraRepliesMentions === 'boolean'
        ? parsed.agoraRepliesMentions
        : DEFAULT_NOTIFICATION_SETTINGS.agoraRepliesMentions,
    agoraReactionsReposts:
      typeof parsed.agoraReactionsReposts === 'boolean'
        ? parsed.agoraReactionsReposts
        : DEFAULT_NOTIFICATION_SETTINGS.agoraReactionsReposts,
    agoraZaps:
      typeof parsed.agoraZaps === 'boolean'
        ? parsed.agoraZaps
        : DEFAULT_NOTIFICATION_SETTINGS.agoraZaps,
    agoraFollows:
      typeof parsed.agoraFollows === 'boolean'
        ? parsed.agoraFollows
        : DEFAULT_NOTIFICATION_SETTINGS.agoraFollows,
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
    pushBridgeUrl: resolvedBridgeUrl,
    vapidPublicKey: resolvedVapidKey,
    prefsVersion: NOTIFICATION_PREFS_VERSION,
  }
}

export function saveNotificationSettings(settings: NotificationSettings): void {
  safeSet(
    KEYS.notifications,
    JSON.stringify({
      ...settings,
      prefsVersion: NOTIFICATION_PREFS_VERSION,
    })
  )
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
      channels: (
        Array.isArray(s.channels) && s.channels.length > 0
          ? s.channels
          : [{ id: s.groupId || 'general', name: s.groupId || 'general' }]
      ).map((c) => ({ ...c, unreadCount: 0, mentionCount: 0 })),
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
    channels: s.channels.map((c) => ({
      id: c.id,
      name: c.name,
      topic: c.topic,
    })),
    unreadCount: 0,
    mentionCount: 0,
  }))
  safeSet(KEYS.servers, JSON.stringify(clean))
}

const STUCK_MEDIA_PLACEHOLDER_RE = /^sending\s+(voice\s+memo|image|photo)(\.{3}|…)?$/i

export function isStuckMediaPlaceholder(msg: {
  id?: unknown
  content?: unknown
  voiceMemo?: unknown
  imageAttachment?: unknown
  deliveryStatus?: unknown
}): boolean {
  if (msg.voiceMemo || msg.imageAttachment) return false
  if (typeof msg.content !== 'string') return false
  return STUCK_MEDIA_PLACEHOLDER_RE.test(msg.content.trim())
}

export const isStuckVoiceMemoPlaceholder = isStuckMediaPlaceholder

export function isEphemeralPendingMessage(msg: {
  id?: unknown
  deliveryStatus?: unknown
}): boolean {
  if (
    typeof msg.id === 'string' &&
    (msg.id.startsWith('pending-bitchat-') || msg.id.startsWith('pending-srv-'))
  ) {
    return true
  }
  return msg.deliveryStatus === 'sending'
}

function formatDmPreviewForStorage(msg: DmMessage): string {
  if (msg.voiceMemo) {
    return msg.content
      ? `🎤 ${msg.content}`.slice(0, 96)
      : `🎤 Voice memo (${formatVoiceDuration(msg.voiceMemo.durationSec)})`
  }
  if (msg.imageAttachment) {
    return msg.content
      ? `🖼️ ${msg.content}`.slice(0, 96)
      : msg.imageAttachment.width > 0 && msg.imageAttachment.height > 0
        ? `🖼️ Image (${msg.imageAttachment.width}×${msg.imageAttachment.height})`
        : '🖼️ Image'
  }
  return msg.content.slice(0, 96)
}

export function loadServerChannelMessages(serverId: string, channelId: string): ServerMessage[] {
  const parsed = safeJsonParse<ServerMessage[]>(safeGet(KEYS.serverMsgChannel(serverId, channelId)), [])
  if (!Array.isArray(parsed)) return []
  const clean: ServerMessage[] = []
  let needsRewrite = false
  for (const m of parsed) {
    if (!m || typeof m.id !== 'string' || typeof m.content !== 'string') continue
    if (m.isBlockedPlaceholder || isStuckMediaPlaceholder(m) || isEphemeralPendingMessage(m)) {
      needsRewrite = true
      continue
    }
    if (!m.isSystem && (m.serverId !== serverId || m.channelId !== channelId)) {
      needsRewrite = true
      continue
    }
    clean.push(m)
  }
  if (needsRewrite) {
    safeSet(KEYS.serverMsgChannel(serverId, channelId), JSON.stringify(clean.slice(-MAX_MESSAGES_PER_CHANNEL)))
  }
  return clean
}

export function saveServerChannelMessages(
  serverId: string,
  channelId: string,
  messages: ServerMessage[]
): void {
  const trimmed = messages
    .filter(
      (m) =>
        !m.isSystem &&
        !m.isBlockedPlaceholder &&
        m.serverId === serverId &&
        m.channelId === channelId &&
        !isStuckMediaPlaceholder(m) &&
        !isEphemeralPendingMessage(m)
    )
    .slice(-MAX_MESSAGES_PER_CHANNEL)
  safeSet(KEYS.serverMsgChannel(serverId, channelId), JSON.stringify(trimmed))
}

export function clearServerChannelMessagesStorage(serverId: string, channelId: string): void {
  safeRemove(KEYS.serverMsgChannel(serverId, channelId))
}

export function scrubBlockedPubkeyFromServerStorage(pubkey: string): number {
  const pk = pubkey.trim().toLowerCase()
  if (!pk || typeof localStorage === 'undefined') return 0
  let removed = 0
  try {
    const serverPrefix = `${PREFIX}smsgs:`
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i)
      if (k && k.startsWith(serverPrefix)) keys.push(k)
    }
    for (const key of keys) {
      const parsed = safeJsonParse<ServerMessage[]>(safeGet(key), [])
      if (!Array.isArray(parsed) || parsed.length === 0) continue
      const surviving = parsed.filter(
        (m) =>
          m &&
          !m.isBlockedPlaceholder &&
          typeof m.pubkey === 'string' &&
          m.pubkey.toLowerCase() !== pk
      )
      if (surviving.length !== parsed.length) {
        removed += parsed.length - surviving.length
        safeSet(key, JSON.stringify(surviving.slice(-MAX_MESSAGES_PER_CHANNEL)))
      }
    }
  } catch {
    // Ignore storage access errors
  }
  return removed
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
  const gh = normalizeBitchatChannelKey(geohash) ?? normalizeGeohash(geohash)
  const parsed = safeJsonParse<GeoMessage[]>(safeGet(KEYS.msgChannel(gh)), [])
  if (!Array.isArray(parsed)) return []
  const clean: GeoMessage[] = []
  let needsRewrite = false
  for (const m of parsed) {
    if (!m || typeof m.id !== 'string' || typeof m.content !== 'string') continue
    if (m.isBlockedPlaceholder || isStuckMediaPlaceholder(m) || isEphemeralPendingMessage(m)) {
      needsRewrite = true
      continue
    }
    if (!m.isSystem) {
      const msgKey = normalizeBitchatChannelKey(m.geohash) ?? normalizeGeohash(m.geohash)
      if (msgKey !== gh) {
        needsRewrite = true
        continue
      }
    }
    clean.push(m)
  }
  if (needsRewrite) {
    safeSet(KEYS.msgChannel(gh), JSON.stringify(clean.slice(-MAX_MESSAGES_PER_CHANNEL)))
  }
  return clean
}

export function saveChannelMessages(geohash: string, messages: GeoMessage[]): void {
  const gh = normalizeBitchatChannelKey(geohash) ?? normalizeGeohash(geohash)
  const trimmed = messages
    .filter((m) => {
      if (m.isSystem || m.isBlockedPlaceholder) return false
      if (isStuckMediaPlaceholder(m) || isEphemeralPendingMessage(m)) return false
      const msgKey = normalizeBitchatChannelKey(m.geohash) ?? normalizeGeohash(m.geohash)
      return msgKey === gh
    })
    .slice(-MAX_MESSAGES_PER_CHANNEL)
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
  const gh = normalizeBitchatChannelKey(geohash) ?? normalizeGeohash(geohash)
  safeRemove(KEYS.msgChannel(gh))
}

export function scrubBlockedPubkeyFromChannelStorage(pubkey: string): number {
  const pk = pubkey.trim().toLowerCase()
  if (!pk || typeof localStorage === 'undefined') return 0
  let removed = 0
  try {
    const bitchatPrefix = `${PREFIX}msgs:`
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i)
      if (k && k.startsWith(bitchatPrefix)) keys.push(k)
    }
    for (const key of keys) {
      const parsed = safeJsonParse<GeoMessage[]>(safeGet(key), [])
      if (!Array.isArray(parsed) || parsed.length === 0) continue
      const surviving = parsed.filter(
        (m) =>
          m &&
          !m.isBlockedPlaceholder &&
          typeof m.pubkey === 'string' &&
          m.pubkey.toLowerCase() !== pk
      )
      if (surviving.length !== parsed.length) {
        removed += parsed.length - surviving.length
        safeSet(key, JSON.stringify(surviving.slice(-MAX_MESSAGES_PER_CHANNEL)))
      }
    }
  } catch {
    // Ignore storage access errors
  }
  return removed
}

export function loadDmThreads(): DmThread[] {
  const parsed = safeJsonParse<DmThread[]>(safeGet(KEYS.dmThreads), [])
  if (!Array.isArray(parsed)) return []
  let needsRewrite = false
  const cleaned = parsed
    .filter((t) => t && typeof t.peerPubkey === 'string' && Array.isArray(t.messages))
    .map((t) => {
      let threadScrubbed = false
      const validMessages: DmMessage[] = []
      for (const m of t.messages) {
        if (!m || typeof m.id !== 'string' || typeof m.createdAt !== 'number') continue
        if (isStuckMediaPlaceholder(m) || isEphemeralPendingMessage(m)) {
          threadScrubbed = true
          needsRewrite = true
          continue
        }
        validMessages.push({
          ...m,
          orderMs:
            typeof m.orderMs === 'number' && Number.isFinite(m.orderMs) ? m.orderMs : undefined,
        })
      }
      const previewWasStuck = isStuckMediaPlaceholder({ content: t.lastPreview })
      if (previewWasStuck) {
        needsRewrite = true
      }
      if (threadScrubbed || previewWasStuck) {
        const tail = validMessages[validMessages.length - 1]
        return {
          ...t,
          messages: validMessages,
          lastPreview: tail ? formatDmPreviewForStorage(tail) : '',
          lastMessageAt: tail ? tail.createdAt : t.lastMessageAt,
        }
      }
      return {
        ...t,
        messages: validMessages,
      }
    })
  if (needsRewrite) {
    saveDmThreads(cleaned)
  }
  return cleaned
}

export function saveDmThreads(threads: DmThread[]): void {
  const capped = threads.slice(0, 30).map((t) => {
    const persistedMsgs = t.messages
      .filter((m) => !isStuckMediaPlaceholder(m) && !isEphemeralPendingMessage(m))
      .slice(-150)
    const stripped = persistedMsgs.length !== t.messages.length
    const previewWasStuck = isStuckMediaPlaceholder({ content: t.lastPreview })
    if (stripped || previewWasStuck) {
      const tail = persistedMsgs[persistedMsgs.length - 1]
      return {
        ...t,
        messages: persistedMsgs,
        lastPreview: tail ? formatDmPreviewForStorage(tail) : '',
        lastMessageAt: tail ? tail.createdAt : t.lastMessageAt,
      }
    }
    return {
      ...t,
      messages: persistedMsgs,
    }
  })
  safeSet(KEYS.dmThreads, JSON.stringify(capped))
}

/**
 * Cold-boot sweep across EVERY persisted Bitchat, Server, and DM message bucket in
 * localStorage (including unopened rooms/servers/threads) so legacy stuck
 * media placeholders and orphaned `pending-*` / `deliveryStatus: 'sending'`
 * zombies are eradicated immediately.
 */
export function scrubAllPersistedStuckPlaceholders(): number {
  if (typeof localStorage === 'undefined') return 0
  let totalRemoved = 0
  try {
    const allKeys: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key) allKeys.push(key)
    }

    const bitchatPrefix = `${PREFIX}msgs:`
    const serverPrefix = `${PREFIX}smsgs:`

    for (const key of allKeys) {
      if (key.startsWith(bitchatPrefix) || key.startsWith(serverPrefix)) {
        const parsed = safeJsonParse<Array<Record<string, unknown>>>(safeGet(key), [])
        if (!Array.isArray(parsed) || parsed.length === 0) continue
        let removedInBucket = 0
        const clean: Array<Record<string, unknown>> = []
        for (const item of parsed) {
          if (!item || typeof item !== 'object') {
            removedInBucket += 1
            continue
          }
          if (
            Boolean(item.isBlockedPlaceholder) ||
            isStuckMediaPlaceholder(item) ||
            isEphemeralPendingMessage(item)
          ) {
            removedInBucket += 1
            continue
          }
          clean.push(item)
        }
        if (removedInBucket > 0) {
          totalRemoved += removedInBucket
          safeSet(key, JSON.stringify(clean.slice(-MAX_MESSAGES_PER_CHANNEL)))
        }
      }
    }

    // Sweep DM threads bucket (including unopened threads & stale lastPreview)
    const rawThreads = safeJsonParse<DmThread[]>(safeGet(KEYS.dmThreads), [])
    if (Array.isArray(rawThreads) && rawThreads.length > 0) {
      let dmChanged = false
      const cleanedThreads = rawThreads
        .filter((t) => t && typeof t.peerPubkey === 'string' && Array.isArray(t.messages))
        .map((t) => {
          let removedHere = 0
          const surviving: DmMessage[] = []
          for (const m of t.messages) {
            if (!m || typeof m.id !== 'string' || typeof m.createdAt !== 'number') {
              removedHere += 1
              continue
            }
            if (isStuckMediaPlaceholder(m) || isEphemeralPendingMessage(m)) {
              removedHere += 1
              continue
            }
            surviving.push(m)
          }
          const previewWasStuck = isStuckMediaPlaceholder({ content: t.lastPreview })
          if (removedHere > 0 || previewWasStuck) {
            dmChanged = true
            totalRemoved += removedHere + (removedHere === 0 && previewWasStuck ? 1 : 0)
            const tail = surviving[surviving.length - 1]
            return {
              ...t,
              messages: surviving,
              lastPreview: tail ? formatDmPreviewForStorage(tail) : '',
              lastMessageAt: tail ? tail.createdAt : t.lastMessageAt,
            }
          }
          return t
        })
      if (dmChanged) {
        saveDmThreads(cleanedThreads)
      }
    }
  } catch {
    // Ignore restricted storage contexts
  }
  return totalRemoved
}

const MAX_DM_CLEARED_ENTRIES = 500

export function loadDmClearedAt(): Record<string, number> {
  const parsed = safeJsonParse<Record<string, unknown>>(safeGet(KEYS.dmClearedAt), {})
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, number> = {}
  for (const [key, val] of Object.entries(parsed)) {
    const pk = key.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pk)) continue
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      out[pk] = Math.floor(val)
    }
  }
  return out
}

export function saveDmClearedAt(map: Record<string, number>): void {
  const entries = Object.entries(map)
    .filter(([k, v]) => /^[0-9a-f]{64}$/.test(k) && typeof v === 'number' && Number.isFinite(v) && v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DM_CLEARED_ENTRIES)
  safeSet(KEYS.dmClearedAt, JSON.stringify(Object.fromEntries(entries)))
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

const MAX_FILTER_VERDICTS = 400

function isValidMediaScope(v: unknown): v is ContentFilterMediaScope {
  return v === 'untrusted' || v === 'all'
}

function isValidCallVideoMode(v: unknown): v is ContentFilterCallVideoMode {
  return v === 'trusted-only' || v === 'screen-untrusted' || v === 'screen-all'
}

function sanitizeContentFilterSettings(
  raw: Partial<ContentFilterSettings> | null | undefined
): ContentFilterSettings {
  const parsed = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: true,
    filterNsfw:
      typeof parsed.filterNsfw === 'boolean'
        ? parsed.filterNsfw
        : DEFAULT_CONTENT_FILTER_SETTINGS.filterNsfw,
    filterIllegal: true,
    mediaScope: isValidMediaScope(parsed.mediaScope)
      ? parsed.mediaScope
      : DEFAULT_CONTENT_FILTER_SETTINGS.mediaScope,
    callVideoMode: isValidCallVideoMode(parsed.callVideoMode)
      ? parsed.callVideoMode
      : DEFAULT_CONTENT_FILTER_SETTINGS.callVideoMode,
  }
}

export function loadContentFilterSettings(): ContentFilterSettings {
  const parsed = safeJsonParse<Partial<ContentFilterSettings>>(
    safeGet(KEYS.contentFilterSettings),
    {}
  )
  return sanitizeContentFilterSettings(parsed)
}

export function saveContentFilterSettings(settings: ContentFilterSettings): void {
  const sanitized = sanitizeContentFilterSettings(settings)
  safeSet(KEYS.contentFilterSettings, JSON.stringify(sanitized))
}

interface PersistedFilterVerdictsPayload {
  rulesFingerprint: string
  entries: Record<string, ContentFilterVerdict>
}

export function loadFilterVerdicts(expectedFingerprint: string): Record<string, ContentFilterVerdict> {
  const parsed = safeJsonParse<PersistedFilterVerdictsPayload | null>(
    safeGet(KEYS.filterVerdicts),
    null
  )
  if (!parsed || typeof parsed !== 'object' || parsed.rulesFingerprint !== expectedFingerprint) {
    return {}
  }
  if (!parsed.entries || typeof parsed.entries !== 'object') return {}
  const out: Record<string, ContentFilterVerdict> = {}
  for (const [key, val] of Object.entries(parsed.entries)) {
    if (!val || typeof val !== 'object') continue
    if (val.status !== 'safe' && val.status !== 'flagged') continue
    const categories = Array.isArray(val.categories)
      ? val.categories.filter(
          (c): c is ContentFilterCategory => c === 'nsfw' || c === 'illegal'
        )
      : []
    out[key] = {
      status: val.status,
      safe: val.status === 'safe' && Boolean(val.safe),
      flagged: val.status === 'flagged' && Boolean(val.flagged),
      categories,
      reason: typeof val.reason === 'string' ? val.reason : undefined,
      scores: val.scores && typeof val.scores === 'object' ? val.scores : undefined,
      checkedAt: typeof val.checkedAt === 'number' && Number.isFinite(val.checkedAt) ? val.checkedAt : Date.now(),
    }
  }
  return out
}

export function saveFilterVerdicts(
  rulesFingerprint: string,
  verdicts: Record<string, ContentFilterVerdict>
): void {
  const settled = Object.entries(verdicts)
    .filter(([, v]) => v.status === 'safe' || v.status === 'flagged')
    .sort((a, b) => b[1].checkedAt - a[1].checkedAt)
    .slice(0, MAX_FILTER_VERDICTS)
  const payload: PersistedFilterVerdictsPayload = {
    rulesFingerprint,
    entries: Object.fromEntries(settled),
  }
  safeSet(KEYS.filterVerdicts, JSON.stringify(payload))
}

export function clearFilterVerdictsStorage(): void {
  safeRemove(KEYS.filterVerdicts)
}

function generateRandomDeviceId(): string {
  try {
    const bytes = new Uint8Array(12)
    crypto.getRandomValues(bytes)
    let hex = ''
    for (let i = 0; i < bytes.length; i += 1) {
      hex += bytes[i].toString(16).padStart(2, '0')
    }
    return `dev_${hex}`
  } catch {
    return `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
  }
}

export function loadOrCreateDeviceId(): string {
  const existing = safeGet(KEYS.deviceId)?.trim()
  if (existing && /^[a-zA-Z0-9_-]{8,64}$/.test(existing)) {
    return existing
  }
  const fresh = generateRandomDeviceId()
  safeSet(KEYS.deviceId, fresh)
  return fresh
}

export function resetDeviceId(): string {
  const fresh = generateRandomDeviceId()
  safeSet(KEYS.deviceId, fresh)
  return fresh
}

export function loadCustomDeviceLabel(): string | null {
  const raw = safeGet(KEYS.deviceLabel)
  if (!raw) return null
  const clean = raw.trim().slice(0, 48)
  return clean.length > 0 ? clean : null
}

export function saveCustomDeviceLabel(label: string | null): void {
  const clean = (label ?? '').trim().slice(0, 48)
  if (!clean) {
    safeRemove(KEYS.deviceLabel)
  } else {
    safeSet(KEYS.deviceLabel, clean)
  }
}

const MAX_PERSISTED_SYNCED_DEVICES = 16

function sanitizePersistedDevicesMap(raw: unknown): Record<string, SyncedDeviceRecord> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const entries: SyncedDeviceRecord[] = []
  const seen = new Set<string>()
  for (const [rawKey, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const rec = entry as Partial<SyncedDeviceRecord>
    const keyId = rawKey.trim()
    const fieldId = typeof rec.deviceId === 'string' ? rec.deviceId.trim() : ''
    const deviceId = keyId || fieldId
    if (!deviceId || deviceId.length > 64 || seen.has(deviceId)) continue
    seen.add(deviceId)
    const rawLabel = typeof rec.label === 'string' ? rec.label.trim().slice(0, 48) : ''
    const label = rawLabel || 'Agnostr Device'
    const lastSyncedAt =
      typeof rec.lastSyncedAt === 'number' && Number.isFinite(rec.lastSyncedAt) && rec.lastSyncedAt > 0
        ? Math.floor(rec.lastSyncedAt)
        : 0
    const updatedAt =
      typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) && rec.updatedAt > 0
        ? Math.floor(rec.updatedAt)
        : 0
    const removedAt =
      typeof rec.removedAt === 'number' && Number.isFinite(rec.removedAt) && rec.removedAt > 0
        ? Math.floor(rec.removedAt)
        : undefined
    entries.push({
      deviceId,
      label,
      lastSyncedAt,
      updatedAt,
      ...(removedAt !== undefined ? { removedAt } : {}),
    })
  }
  entries.sort((a, b) => {
    const recencyA = Math.max(a.updatedAt, a.lastSyncedAt, a.removedAt ?? 0)
    const recencyB = Math.max(b.updatedAt, b.lastSyncedAt, b.removedAt ?? 0)
    return recencyB - recencyA || a.deviceId.localeCompare(b.deviceId)
  })
  const out: Record<string, SyncedDeviceRecord> = {}
  for (const rec of entries.slice(0, MAX_PERSISTED_SYNCED_DEVICES)) {
    out[rec.deviceId] = rec
  }
  return out
}

const MAX_PERSISTED_SYNCED_DM_PEER_NAMES = 60

function isGenericAnonNickname(nick: string | null | undefined): boolean {
  const clean = (nick ?? '').trim()
  return !clean || /^a(?:gn|n)on(?:[0-9a-f]{4})?$/i.test(clean)
}

function sanitizeDmPeerNamesMap(raw: unknown): Record<string, SyncedDmPeerNameRecord> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const seen = new Map<string, SyncedDmPeerNameRecord>()
  for (const [rawPk, entry] of Object.entries(raw as Record<string, unknown>)) {
    const pk = rawPk.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pk) || !entry || typeof entry !== 'object') continue
    const rec = entry as Partial<SyncedDmPeerNameRecord>
    const name = typeof rec.name === 'string' ? rec.name.trim().slice(0, 32) : ''
    if (isGenericAnonNickname(name)) continue
    const updatedAt =
      typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) && rec.updatedAt > 0
        ? Math.floor(rec.updatedAt)
        : 1
    const prev = seen.get(pk)
    if (!prev || updatedAt > prev.updatedAt || (updatedAt === prev.updatedAt && name > prev.name)) {
      seen.set(pk, { name, updatedAt })
    }
  }
  const entries = Array.from(seen.entries())
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt || a[0].localeCompare(b[0]))
  const out: Record<string, SyncedDmPeerNameRecord> = {}
  for (const [pk, rec] of entries.slice(0, MAX_PERSISTED_SYNCED_DM_PEER_NAMES)) {
    out[pk] = rec
  }
  return out
}

function sanitizeServerOrderState(raw: unknown): SyncedServerOrderState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { updatedAt: 0, ids: [] }
  }
  const obj = raw as Partial<SyncedServerOrderState>
  const updatedAt =
    typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) && obj.updatedAt > 0
      ? Math.floor(obj.updatedAt)
      : 0
  const ids: string[] = []
  if (Array.isArray(obj.ids)) {
    const seen = new Set<string>()
    for (const item of obj.ids) {
      if (typeof item !== 'string') continue
      const clean = item.trim().slice(0, 160)
      if (!clean || seen.has(clean)) continue
      seen.add(clean)
      ids.push(clean)
      if (ids.length >= 128) break
    }
  }
  return { updatedAt, ids }
}

export function loadDeviceSyncState(): PersistedDeviceSyncState | null {
  const parsed = safeJsonParse<Partial<PersistedDeviceSyncState> | null>(
    safeGet(KEYS.deviceSyncState),
    null
  )
  if (!parsed || typeof parsed !== 'object' || !parsed.crdt || typeof parsed.crdt !== 'object') {
    return null
  }
  const rawCrdt = parsed.crdt as Partial<DeviceSyncCrdtState>
  const crdt: DeviceSyncCrdtState = {
    v: 1,
    servers:
      rawCrdt.servers && typeof rawCrdt.servers === 'object' && !Array.isArray(rawCrdt.servers)
        ? rawCrdt.servers
        : {},
    serverOrder: sanitizeServerOrderState(rawCrdt.serverOrder),
    trusted:
      rawCrdt.trusted && typeof rawCrdt.trusted === 'object' && !Array.isArray(rawCrdt.trusted)
        ? rawCrdt.trusted
        : {},
    blocked:
      rawCrdt.blocked && typeof rawCrdt.blocked === 'object' && !Array.isArray(rawCrdt.blocked)
        ? (() => {
            const cleaned: DeviceSyncCrdtState['blocked'] = {}
            for (const [rawPk, entry] of Object.entries(rawCrdt.blocked)) {
              const pk = rawPk.trim().toLowerCase()
              if (!/^[0-9a-f]{64}$/.test(pk) || !entry || typeof entry !== 'object') continue
              const addedAt =
                typeof entry.addedAt === 'number' && Number.isFinite(entry.addedAt)
                  ? entry.addedAt
                  : 0
              const removedAt =
                typeof entry.removedAt === 'number' && Number.isFinite(entry.removedAt)
                  ? entry.removedAt
                  : 0
              const label =
                typeof entry.label === 'string' && entry.label.trim()
                  ? entry.label.trim().slice(0, MAX_BLOCKED_PEER_NAME_CHARS)
                  : undefined
              cleaned[pk] = {
                pubkey: pk,
                ...(label ? { label } : {}),
                addedAt,
                removedAt,
              }
            }
            return cleaned
          })()
        : {},
    pinned:
      rawCrdt.pinned &&
      typeof rawCrdt.pinned === 'object' &&
      Array.isArray(rawCrdt.pinned.items)
        ? {
            updatedAt:
              typeof rawCrdt.pinned.updatedAt === 'number' && Number.isFinite(rawCrdt.pinned.updatedAt)
                ? rawCrdt.pinned.updatedAt
                : 0,
            items: rawCrdt.pinned.items,
          }
        : { updatedAt: 0, items: [] },
    dmClearedAt:
      rawCrdt.dmClearedAt &&
      typeof rawCrdt.dmClearedAt === 'object' &&
      !Array.isArray(rawCrdt.dmClearedAt)
        ? rawCrdt.dmClearedAt
        : {},
    lud16:
      rawCrdt.lud16 && typeof rawCrdt.lud16 === 'object'
        ? {
            value: typeof rawCrdt.lud16.value === 'string' ? rawCrdt.lud16.value : null,
            updatedAt:
              typeof rawCrdt.lud16.updatedAt === 'number' && Number.isFinite(rawCrdt.lud16.updatedAt)
                ? rawCrdt.lud16.updatedAt
                : 0,
          }
        : { value: null, updatedAt: 0 },
    nickname:
      rawCrdt.nickname && typeof rawCrdt.nickname === 'object'
        ? {
            value: typeof rawCrdt.nickname.value === 'string' ? rawCrdt.nickname.value : '',
            updatedAt:
              typeof rawCrdt.nickname.updatedAt === 'number' &&
              Number.isFinite(rawCrdt.nickname.updatedAt)
                ? rawCrdt.nickname.updatedAt
                : 0,
          }
        : { value: '', updatedAt: 0 },
    peerNotes:
      rawCrdt.peerNotes &&
      typeof rawCrdt.peerNotes === 'object' &&
      !Array.isArray(rawCrdt.peerNotes)
        ? (() => {
            const cleaned: Record<string, SyncedPeerNoteRecord> = {}
            for (const [rawPk, entry] of Object.entries(rawCrdt.peerNotes)) {
              const pk = rawPk.trim().toLowerCase()
              if (!/^[0-9a-f]{64}$/.test(pk) || !entry || typeof entry !== 'object') continue
              const text =
                typeof entry.text === 'string' ? entry.text.trim().slice(0, MAX_PEER_NOTE_CHARS) : ''
              const updatedAt =
                typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
                  ? entry.updatedAt
                  : 0
              cleaned[pk] = { text, updatedAt }
            }
            return cleaned
          })()
        : {},
    dmPeerNames: sanitizeDmPeerNamesMap(rawCrdt.dmPeerNames),
    devices: sanitizePersistedDevicesMap(rawCrdt.devices),
  }

  const linkedDevices: LinkedDeviceInfo[] = Array.isArray(parsed.linkedDevices)
    ? parsed.linkedDevices
        .filter(
          (d): d is LinkedDeviceInfo =>
            Boolean(d) &&
            typeof d.deviceId === 'string' &&
            d.deviceId.trim().length > 0 &&
            typeof d.label === 'string' &&
            typeof d.lastSeenAt === 'number' &&
            Number.isFinite(d.lastSeenAt)
        )
        .slice(0, MAX_PERSISTED_SYNCED_DEVICES)
        .map((d) => ({
          deviceId: d.deviceId.trim().slice(0, 64),
          label: d.label.trim().slice(0, 48) || 'Sibling Device',
          nickname: typeof d.nickname === 'string' ? d.nickname.slice(0, 32) : '',
          lastSeenAt: d.lastSeenAt,
          ...(typeof d.lastSyncedAt === 'number' &&
          Number.isFinite(d.lastSyncedAt) &&
          d.lastSyncedAt > 0
            ? { lastSyncedAt: Math.floor(d.lastSyncedAt) }
            : {}),
          online: false,
        }))
    : []

  return {
    enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
    ownerPubkey:
      typeof parsed.ownerPubkey === 'string' && /^[0-9a-f]{64}$/i.test(parsed.ownerPubkey)
        ? parsed.ownerPubkey.toLowerCase()
        : null,
    stateRevision:
      typeof parsed.stateRevision === 'number' && Number.isFinite(parsed.stateRevision)
        ? Math.max(0, Math.floor(parsed.stateRevision))
        : 0,
    lastSyncedAt:
      typeof parsed.lastSyncedAt === 'number' && Number.isFinite(parsed.lastSyncedAt)
        ? parsed.lastSyncedAt
        : null,
    crdt,
    linkedDevices,
  }
}

export function saveDeviceSyncState(state: PersistedDeviceSyncState): void {
  const sanitized: PersistedDeviceSyncState = {
    enabled: state.enabled,
    ownerPubkey: state.ownerPubkey,
    stateRevision: state.stateRevision,
    lastSyncedAt: state.lastSyncedAt,
    crdt: {
      v: 1,
      servers: state.crdt.servers,
      serverOrder: sanitizeServerOrderState(state.crdt.serverOrder),
      trusted: state.crdt.trusted,
      blocked: state.crdt.blocked,
      pinned: state.crdt.pinned,
      dmClearedAt: state.crdt.dmClearedAt,
      lud16: state.crdt.lud16,
      nickname: state.crdt.nickname,
      peerNotes: state.crdt.peerNotes ?? {},
      dmPeerNames: sanitizeDmPeerNamesMap(state.crdt.dmPeerNames),
      devices: sanitizePersistedDevicesMap(state.crdt.devices),
    },
    linkedDevices: state.linkedDevices.slice(0, MAX_PERSISTED_SYNCED_DEVICES).map((d) => ({
      deviceId: d.deviceId.trim().slice(0, 64),
      label: d.label.trim().slice(0, 48) || 'Sibling Device',
      nickname: typeof d.nickname === 'string' ? d.nickname.slice(0, 32) : '',
      lastSeenAt: Number.isFinite(d.lastSeenAt) ? d.lastSeenAt : 0,
      ...(typeof d.lastSyncedAt === 'number' &&
      Number.isFinite(d.lastSyncedAt) &&
      d.lastSyncedAt > 0
        ? { lastSyncedAt: Math.floor(d.lastSyncedAt) }
        : {}),
      online: Boolean(d.online),
    })),
  }
  safeSet(KEYS.deviceSyncState, JSON.stringify(sanitized))
}

export function clearDeviceSyncState(): void {
  safeRemove(KEYS.deviceSyncState)
}

export function panicWipeStorage(): void {
  try {
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (
        k &&
        !isGlobalProfileVaultKey(k) &&
        (k.startsWith('agnostr:') || k.startsWith('agnostr_') || k === 'ephemeral_sk')
      ) {
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
  messages: GeoMessage[],
  channelKey?: string
): { filename: string; content: string; mimeType: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const resolvedKey = channelKey ? (normalizeBitchatChannelKey(channelKey) ?? cell.geohash) : cell.geohash
  const isTopic = isTopicChannel(resolvedKey)
  const topicSlug = getTopicSlug(resolvedKey)
  const displayChannel = formatBitchatChannelLabel(resolvedKey)
  const fileSlug = isTopic && topicSlug ? `topic-${topicSlug}` : cell.geohash

  if (format === 'json') {
    return {
      filename: `agnostr-${fileSlug}-${stamp}.json`,
      mimeType: 'application/json',
      content: JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          channel: displayChannel,
          channelType: isTopic ? 'topic' : 'geohash',
          ...(isTopic
            ? { topicSlug }
            : {
                precision: cell.precision,
                level: cell.label,
                center: cell.center,
                nearestCity: cell.nearestCity,
              }),
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
    `# Agnostr Transcript — ${displayChannel}`,
    '',
    `- **Exported**: ${new Date().toISOString()}`,
    ...(isTopic
      ? [`- **Scope**: Named Topic Bitchat (global)`]
      : [
          `- **Scope**: ${cell.label} (${cell.approxSizeLabel})${cell.nearestCity ? ` · ${cell.nearestCity}` : ''}`,
          `- **Coordinates**: ${cell.center.lat.toFixed(4)}, ${cell.center.lon.toFixed(4)}`,
        ]),
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
    filename: `agnostr-${fileSlug}-${stamp}.md`,
    mimeType: 'text/markdown;charset=utf-8',
    content: lines.join('\n'),
  }
}
