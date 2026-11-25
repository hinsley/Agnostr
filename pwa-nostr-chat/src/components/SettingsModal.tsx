import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChangeEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Bell,
  BellOff,
  BellRing,
  Camera,
  Captions,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  Flame,
  Globe,
  Image as ImageIcon,
  KeyRound,
  Languages,
  Link2,
  Loader2,
  Lock,
  Mic,
  Palette,
  Pencil,
  PhoneCall,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Trash2,
  User,
  Volume2,
  VolumeX,
  X,
  Zap,
} from 'lucide-react'
import type {
  AgnostrEngine,
  ProfileAccountRecord,
  SignMode,
  ThemeId,
} from '../types/protocol.ts'
import type { LinkedDeviceInfo } from '../types/deviceSync.ts'
import type {
  ContentFilterCallVideoMode,
  ContentFilterMediaScope,
  ContentFilterSettings,
  ContentFilterVerdict,
} from '../types/contentFilter.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import type { NotificationFilterMode } from '../types/notifications.ts'
import {
  SUPPORTED_TRANSLATION_LANGUAGES,
  TRANSLATION_LANGUAGE_OPTIONS,
  TRANSLATOR_MODELS,
  type TranslatorModelKey,
} from '../types/translator.ts'
import type { PwaState } from '../hooks/usePwa.ts'
import {
  RECORDING_QUALITY_PRESETS,
  getRecordingQualitySpec,
} from '../lib/callRecorder.ts'
import { DEFAULT_TRANSCRIPTION_MODEL_ID } from '../lib/transcriptionModels.ts'
import { DEFAULT_PUSH_BRIDGE_URL, DEFAULT_VAPID_PUBLIC_KEY } from '../lib/storage.ts'
import { buildDmShareUrl } from '../lib/shareLinks.ts'
import { bitchatAudio, type SoundCue } from '../utils/sound.ts'
import { pubkeyToColor, shortPubkey } from '../utils/identicon.ts'
import { AvatarImg } from './AvatarImg.tsx'
import { DeleteProfileConfirmModal } from './DeleteProfileConfirmModal.tsx'
import type { QrShareTarget } from './QrShareModal.tsx'

export type SettingsTab =
  | 'profile'
  | 'notifications'
  | 'privacy'
  | 'content-filter'
  | 'translator'
  | 'appearance'
  | 'calls'
  | 'network'

export interface SettingsModalProps {
  open: boolean
  engine: AgnostrEngine
  pwa: PwaState
  initialTab?: SettingsTab
  notificationsOnly?: boolean
  onClose: () => void
  onOpenInstall: () => void
  onPlaySound?: (cue: SoundCue) => void
  onShowQr?: (target: QrShareTarget) => void
  onOpenScanner?: () => void
  /** When true on mobile, renders anchored inside .ag-shell-body above the always-present bottom navbar. */
  inShell?: boolean
}

interface ThemeCardOption {
  id: ThemeId
  name: string
  tagline: string
  bg: string
  surface: string
  elevated: string
  accent: string
}

const THEME_CARDS: readonly ThemeCardOption[] = [
  {
    id: 'phosphor',
    name: 'Carbon',
    tagline: 'Neutral graphite & electric blue',
    bg: '#0B0C0F',
    surface: '#111318',
    elevated: '#1F232C',
    accent: '#3B82F6',
  },
  {
    id: 'indigo',
    name: 'Indigo',
    tagline: 'Deep ink & modern indigo',
    bg: '#090A10',
    surface: '#10121C',
    elevated: '#202438',
    accent: '#6366F1',
  },
  {
    id: 'amber',
    name: 'Stone',
    tagline: 'Warm charcoal & amber',
    bg: '#100F0E',
    surface: '#171514',
    elevated: '#2B2724',
    accent: '#F59E0B',
  },
  {
    id: 'daylight',
    name: 'Light',
    tagline: 'Clean white & cobalt blue',
    bg: '#FFFFFF',
    surface: '#F6F7F9',
    elevated: '#E3E7EE',
    accent: '#2563EB',
  },
]

const SIGN_MODES: readonly { id: SignMode; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'local', label: 'Local key' },
  { id: 'extension', label: 'Extension' },
]

const NOTIF_FILTER_MODES: readonly { id: NotificationFilterMode; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mentions', label: 'Pings' },
  { id: 'off', label: 'Off' },
]

const MEDIA_SCOPE_OPTIONS: readonly { id: ContentFilterMediaScope; label: string }[] = [
  { id: 'untrusted', label: 'Untrusted Only' },
  { id: 'all', label: 'Everyone' },
]

const CALL_VIDEO_MODE_OPTIONS: readonly { id: ContentFilterCallVideoMode; label: string }[] = [
  { id: 'trusted-only', label: 'Trusted Only' },
  { id: 'screen-untrusted', label: 'Screen Untrusted' },
  { id: 'screen-all', label: 'Screen All' },
]

type PendingCfDisableKind = 'nsfw'

const CF_DISABLE_CONFIRM_COPY: Record<
  PendingCfDisableKind,
  {
    title: string
    warning: string
    detail: string
    patch: Partial<ContentFilterSettings>
  }
> = {
  nsfw: {
    title: 'Disable NSFW / explicit filter?',
    warning:
      'Turning off NSFW filtering exposes your device to unscreened sexually explicit images, nudity, and graphic adult media from untrusted strangers on public relays.',
    detail:
      'Illegal & gore (NSFL) protection always remains on, but public relays carry unmoderated adult media. Keeping NSFW protection enabled prevents surprise explicit imagery.',
    patch: { filterNsfw: false },
  },
}

interface SettingsNavItem {
  id: SettingsTab
  category: 'Account' | 'Communication' | 'Privacy & Safety' | 'System'
  label: string
  subtitle: string
  description: string
  keywords: string
}

const NAV_CATEGORIES: readonly SettingsNavItem['category'][] = [
  'Account',
  'Communication',
  'Privacy & Safety',
  'System',
]

const NAV_ITEMS: readonly SettingsNavItem[] = [
  {
    id: 'profile',
    category: 'Account',
    label: 'Profile & Keys',
    subtitle: 'Name, photo, profiles & keys',
    description: 'Manage your display name, photo, zaps, saved profiles, synced devices, and Nostr keys.',
    keywords:
      'profile identity display name avatar photo picture zap lightning address lud16 qr dm link profiles switch create import delete device sync linked npub nsec key keys signer extension rotate nip07 backup',
  },
  {
    id: 'appearance',
    category: 'Account',
    label: 'Appearance',
    subtitle: 'Color theme & sound effects',
    description: 'Choose your workspace color theme and control interface sound effects.',
    keywords:
      'appearance color theme carbon indigo stone light dark daylight mode palette sound audio effects chimes mute',
  },
  {
    id: 'notifications',
    category: 'Communication',
    label: 'Notifications',
    subtitle: 'Alerts, ringtones & Agora',
    description: 'Control system alerts, ringtones, lock screen previews, and background push.',
    keywords:
      'notifications alerts push bridge vapid ringtone vibration chimes lock screen preview direct messages dm mentions replies pings group calls bitchat agmail cc bcc agora likes reposts zaps followers test ios pwa',
  },
  {
    id: 'calls',
    category: 'Communication',
    label: 'Calls & Voice',
    subtitle: 'Recording, captions & relay',
    description: 'Adjust recording quality, local voice transcription, live captions, and TURN relays.',
    keywords:
      'calls voice video recording quality resolution fps captions transcription auto transcribe whisper parakeet speech model cache onnx huggingface turn stun custom call relay firewall',
  },
  {
    id: 'translator',
    category: 'Communication',
    label: 'Translator',
    subtitle: 'Language & auto-translation',
    description: 'Translate incoming and outgoing messages privately on your device.',
    keywords:
      'translator translate translation language source incoming outgoing double column opus m2m100 nllb200 neural on-device model cache webgpu wasm',
  },
  {
    id: 'privacy',
    category: 'Privacy & Safety',
    label: 'Privacy & Trust',
    subtitle: 'Message rules, trusted & blocked',
    description: 'Decide who can reach you, manage trusted peers, and review blocked users.',
    keywords:
      'privacy trust whitelist trusted peers only voice memos untrusted links warning confirm agnostr client tag anonymity blocked users unblock mute add peer npub',
  },
  {
    id: 'content-filter',
    category: 'Privacy & Safety',
    label: 'Content Filter',
    subtitle: 'On-device media safety',
    description: 'Screen incoming images and call video locally on your device before display.',
    keywords:
      'content filter safety moderation nsfw explicit nudity illegal gore nsfl always on lock images media video calls agora screening model cache webgpu wasm test image file',
  },
  {
    id: 'network',
    category: 'System',
    label: 'Network & App',
    subtitle: 'Updates, relays & emergency wipe',
    description: 'Manage app updates, Nostr relays, Blossom media storage, and local data reset.',
    keywords:
      'network app updates pwa install offline cache nostr relays reconnect reset custom wss blossom media servers upload encrypted danger zone emergency panic wipe erase reset identity',
  },
]

const PANIC_HOLD_MS = 1500

function formatSyncAge(ts: number | null): string {
  if (!ts) return 'Never'
  const ms = ts < 1e12 ? ts * 1000 : ts
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (diffSec < 15) return 'Just now'
  if (diffSec < 60) return `${diffSec}s ago`
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function formatSyncAgeLower(ts: number | null): string {
  const age = formatSyncAge(ts)
  return age === 'Just now' ? 'just now' : age
}

function shortDeviceTag(deviceId: string): string {
  const clean = deviceId.replace(/[^a-zA-Z0-9]/g, '')
  if (!clean) return '#0000'
  return `#${clean.slice(-4).toLowerCase()}`
}

function formatDeviceSyncStatus(dev: LinkedDeviceInfo): { text: string; title: string } {
  const syncedMs =
    typeof dev.lastSyncedAt === 'number' && Number.isFinite(dev.lastSyncedAt) && dev.lastSyncedAt > 0
      ? dev.lastSyncedAt < 1e12
        ? dev.lastSyncedAt * 1000
        : dev.lastSyncedAt
      : null
  const seenMs =
    typeof dev.lastSeenAt === 'number' && Number.isFinite(dev.lastSeenAt) && dev.lastSeenAt > 0
      ? dev.lastSeenAt < 1e12
        ? dev.lastSeenAt * 1000
        : dev.lastSeenAt
      : null

  let text: string
  if (dev.online) {
    text = syncedMs ? `Online · Synced ${formatSyncAgeLower(syncedMs)}` : 'Online'
  } else if (syncedMs) {
    text = `Synced ${formatSyncAgeLower(syncedMs)}`
  } else if (seenMs) {
    text = `Last seen ${formatSyncAgeLower(seenMs)}`
  } else {
    text = 'Synced'
  }

  const tooltipParts: string[] = []
  if (syncedMs) {
    tooltipParts.push(`Last synced: ${new Date(syncedMs).toLocaleString()}`)
  }
  if (seenMs) {
    tooltipParts.push(`Last seen live: ${new Date(seenMs).toLocaleString()}`)
  }
  return {
    text,
    title: tooltipParts.length > 0 ? tooltipParts.join(' · ') : `Device ID: ${dev.deviceId}`,
  }
}

function stripScheme(url: string): string {
  return url.replace(/^(wss?|https?):\/\//i, '').replace(/\/+$/, '')
}

async function copyClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

interface SettingsSectionProps {
  title: string
  description?: string
  badge?: ReactNode
  action?: ReactNode
  dimmed?: boolean
  children: ReactNode
}

function SettingsSection({
  title,
  description,
  badge,
  action,
  dimmed = false,
  children,
}: SettingsSectionProps) {
  return (
    <section className={`ag-set-section${dimmed ? ' ag-set-dimmed' : ''}`}>
      <div className="ag-set-section-head">
        <div className="ag-set-section-copy">
          <div className="ag-set-section-title-row">
            <h3 className="ag-set-section-title">{title}</h3>
            {badge}
          </div>
          {description && <p className="ag-set-section-desc">{description}</p>}
        </div>
        {action && <div className="ag-set-section-actions">{action}</div>}
      </div>
      {children}
    </section>
  )
}

interface SettingsDisclosureProps {
  icon: ReactNode
  title: string
  description: string
  badge?: ReactNode
  open: boolean
  onToggle: () => void
  children: ReactNode
}

function SettingsDisclosure({
  icon,
  title,
  description,
  badge,
  open,
  onToggle,
  children,
}: SettingsDisclosureProps) {
  return (
    <div className={`ag-set-disclosure${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="ag-set-disclosure-trigger"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="ag-set-disclosure-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="ag-set-disclosure-copy">
          <span className="ag-set-disclosure-title">{title}</span>
          <span className="ag-set-disclosure-desc">{description}</span>
        </span>
        <span className="ag-set-disclosure-right">
          {badge}
          <ChevronDown
            size={16}
            className={`ag-set-disclosure-chevron${open ? ' open' : ''}`}
            aria-hidden="true"
          />
        </span>
      </button>
      {open && <div className="ag-set-disclosure-body">{children}</div>}
    </div>
  )
}

export function SettingsModal({
  open,
  engine,
  pwa,
  initialTab,
  notificationsOnly = false,
  onClose,
  onOpenInstall,
  onPlaySound,
  onShowQr,
  inShell = false,
}: SettingsModalProps) {
  const {
    identity,
    settings,
    trustedPubkeys,
    blockedPubkeys,
    strictWhitelistMode,
    broadcastClientTag,
    relays,
    customRelays,
    connectedRelayCount,
    totalRelayCount,
    blossomServers,
  } = engine

  const [activeTab, setActiveTab] = useState<SettingsTab>(
    notificationsOnly ? 'notifications' : (initialTab ?? 'profile'),
  )
  const modalRef = useRef<HTMLDivElement>(null)
  const [mobileScreen, setMobileScreen] = useState<'menu' | 'detail'>(
    initialTab || notificationsOnly ? 'detail' : 'menu',
  )
  const [searchQuery, setSearchQuery] = useState('')

  // Progressive disclosure states (`null` = follow auto-expand status, boolean = user override)
  const [keysDisclosureOpen, setKeysDisclosureOpen] = useState(false)
  const [notifAdvancedOpen, setNotifAdvancedOpen] = useState<boolean | null>(null)
  const [speechModelsOpen, setSpeechModelsOpen] = useState<boolean | null>(null)
  const [turnDisclosureOpen, setTurnDisclosureOpen] = useState(false)
  const [translatorModelOpen, setTranslatorModelOpen] = useState<boolean | null>(null)
  const [cfModelOpen, setCfModelOpen] = useState<boolean | null>(null)
  const [addTrustedOpen, setAddTrustedOpen] = useState(false)

  // Profile drafts
  const [nickDraft, setNickDraft] = useState(identity.nickname)
  const [lud16Draft, setLud16Draft] = useState(() => engine.zaps.lightningAddress ?? '')
  const [lud16Saving, setLud16Saving] = useState(false)
  const [lud16Feedback, setLud16Feedback] = useState<{ ok: boolean; msg: string } | null>(null)
  const [profilePicBusy, setProfilePicBusy] = useState(false)
  const [heroAvatarMenuOpen, setHeroAvatarMenuOpen] = useState(false)
  const profilePicInputRef = useRef<HTMLInputElement | null>(null)
  const heroAvatarMenuRef = useRef<HTMLDivElement | null>(null)

  // Rotate Keys Confirmation Dialog
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false)
  const [rotateConfirmAck, setRotateConfirmAck] = useState(false)
  const rotateCancelBtnRef = useRef<HTMLButtonElement | null>(null)

  // Multi-Profile Manager state
  const [profileFormMode, setProfileFormMode] = useState<'none' | 'create' | 'import'>('none')
  const [newProfileNickDraft, setNewProfileNickDraft] = useState('')
  const [importKeyDraft, setImportKeyDraft] = useState('')
  const [importNickDraft, setImportNickDraft] = useState('')
  const [profileFormError, setProfileFormError] = useState<string | null>(null)
  const [profileFormBusy, setProfileFormBusy] = useState(false)
  const [pendingDeleteProfile, setPendingDeleteProfile] = useState<ProfileAccountRecord | null>(
    null,
  )
  const [removingProfilePubkey, setRemovingProfilePubkey] = useState<string | null>(null)

  const myProfilePicture = engine.getProfilePicture(identity.masterPubkey)
  const ensureProfilePictures = engine.ensureProfilePictures

  useEffect(() => {
    if (!heroAvatarMenuOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (heroAvatarMenuRef.current && target && !heroAvatarMenuRef.current.contains(target)) {
        setHeroAvatarMenuOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [heroAvatarMenuOpen])

  useEffect(() => {
    if (!open) return
    const pks = new Set<string>([identity.masterPubkey, identity.activePubkey])
    for (const prof of engine.profiles.profiles) {
      if (prof.pubkey) pks.add(prof.pubkey)
    }
    if (activeTab === 'privacy') {
      for (const entry of trustedPubkeys) pks.add(entry.pubkey)
      for (const pk of blockedPubkeys) pks.add(pk)
    }
    ensureProfilePictures(Array.from(pks))
  }, [
    open,
    activeTab,
    identity.masterPubkey,
    identity.activePubkey,
    engine.profiles.profiles,
    trustedPubkeys,
    blockedPubkeys,
    ensureProfilePictures,
  ])

  const resetProfileForm = useCallback(() => {
    setProfileFormMode('none')
    setNewProfileNickDraft('')
    setImportKeyDraft('')
    setImportNickDraft('')
    setProfileFormError(null)
  }, [])

  const handleCreateProfileSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (profileFormBusy || engine.profiles.switching) return
    setProfileFormBusy(true)
    setProfileFormError(null)
    try {
      const created = await engine.profiles.createProfile({
        nickname: newProfileNickDraft.trim() || undefined,
      })
      if (!created) {
        setProfileFormError('Unable to create a new profile right now.')
      } else {
        onPlaySound?.('send')
        resetProfileForm()
      }
    } catch (err) {
      setProfileFormError(err instanceof Error ? err.message : 'Unable to create profile.')
    } finally {
      setProfileFormBusy(false)
    }
  }

  const handleImportProfileSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const rawKey = importKeyDraft.trim()
    if (!rawKey || profileFormBusy || engine.profiles.switching) return
    setProfileFormBusy(true)
    setProfileFormError(null)
    try {
      const res = await engine.profiles.importProfile(rawKey, {
        nickname: importNickDraft.trim() || undefined,
      })
      if (!res.ok) {
        setProfileFormError(res.error || 'Enter a valid nsec1… or 64-character hex private key.')
      } else {
        onPlaySound?.('send')
        resetProfileForm()
      }
    } catch (err) {
      setProfileFormError(err instanceof Error ? err.message : 'Unable to import private key.')
    } finally {
      setProfileFormBusy(false)
    }
  }

  const handleConfirmDeleteProfile = async (targetPubkey: string) => {
    if (removingProfilePubkey || engine.profiles.switching) return
    setRemovingProfilePubkey(targetPubkey)
    try {
      const deleted = await engine.profiles.deleteProfile(targetPubkey)
      if (deleted) {
        onPlaySound?.('click')
        engine.pushToast('info', 'Profile removed from this device')
      } else {
        engine.pushToast('error', 'Unable to remove profile')
      }
    } catch (err) {
      engine.pushToast(
        'error',
        'Unable to remove profile',
        err instanceof Error ? err.message : undefined,
      )
    } finally {
      setPendingDeleteProfile(null)
      setRemovingProfilePubkey(null)
    }
  }

  const handleProfilePictureSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || profilePicBusy) return
    setProfilePicBusy(true)
    try {
      const res = await engine.updateMyProfilePicture(file)
      if (res.ok) {
        onPlaySound?.('send')
        engine.pushToast('success', 'Profile picture updated')
      } else {
        engine.pushToast('error', 'Profile picture update failed', res.error)
      }
    } catch (err) {
      engine.pushToast(
        'error',
        'Profile picture update failed',
        err instanceof Error ? err.message : 'Unable to upload image.',
      )
    } finally {
      setProfilePicBusy(false)
    }
  }

  const handleRemoveProfilePicture = async () => {
    if (profilePicBusy) return
    setProfilePicBusy(true)
    try {
      const res = await engine.updateMyProfilePicture(null)
      if (res.ok) {
        onPlaySound?.('click')
        engine.pushToast('success', 'Profile picture removed')
      } else {
        engine.pushToast('error', 'Unable to remove picture', res.error)
      }
    } catch (err) {
      engine.pushToast(
        'error',
        'Unable to remove picture',
        err instanceof Error ? err.message : 'Failed to clear profile picture.',
      )
    } finally {
      setProfilePicBusy(false)
    }
  }

  useEffect(() => {
    setLud16Draft(engine.zaps.lightningAddress ?? '')
  }, [engine.zaps.lightningAddress])

  const [editingDeviceLabel, setEditingDeviceLabel] = useState(false)
  const [deviceLabelDraft, setDeviceLabelDraft] = useState(() => engine.deviceSync.deviceLabel)
  const [, setSyncAgeTick] = useState(0)

  useEffect(() => {
    if (!editingDeviceLabel) {
      setDeviceLabelDraft(engine.deviceSync.deviceLabel)
    }
  }, [engine.deviceSync.deviceLabel, editingDeviceLabel])

  useEffect(() => {
    if (!open) {
      setEditingDeviceLabel(false)
      setSearchQuery('')
    }
  }, [open])

  useEffect(() => {
    if (!open || activeTab !== 'profile') return
    const timer = window.setInterval(() => {
      setSyncAgeTick((t) => t + 1)
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [open, activeTab])

  const [secretDraft, setSecretDraft] = useState('')
  const [secretFeedback, setSecretFeedback] = useState<{ ok: boolean; msg: string } | null>(null)
  const [revealNsec, setRevealNsec] = useState(false)
  const [copiedField, setCopiedField] = useState<'npub' | 'nsec' | 'dm-link' | null>(null)

  // Content Filter quick test & disable confirmation state
  const [cfTesting, setCfTesting] = useState(false)
  const [cfTestLabel, setCfTestLabel] = useState<string | null>(null)
  const [cfTestResult, setCfTestResult] = useState<ContentFilterVerdict | null>(null)
  const [cfClearingCache, setCfClearingCache] = useState(false)
  const [cfFeedback, setCfFeedback] = useState<{ ok: boolean; msg: string } | null>(null)
  const [pendingCfDisable, setPendingCfDisable] = useState<PendingCfDisableKind | null>(null)
  const cfFileInputRef = useRef<HTMLInputElement | null>(null)
  const keepProtectionBtnRef = useRef<HTMLButtonElement | null>(null)

  // Translator drafts
  const [trClearingCache, setTrClearingCache] = useState(false)
  const [trFeedback, setTrFeedback] = useState<{ ok: boolean; msg: string } | null>(null)
  const [customMyLangMode, setCustomMyLangMode] = useState(
    () => !SUPPORTED_TRANSLATION_LANGUAGES.includes(engine.translator.settings.myLanguage),
  )
  const [customOutLangMode, setCustomOutLangMode] = useState(
    () => !SUPPORTED_TRANSLATION_LANGUAGES.includes(engine.translator.settings.outgoingLanguage),
  )

  // Privacy drafts
  const [trustKeyDraft, setTrustKeyDraft] = useState('')
  const [trustLabelDraft, setTrustLabelDraft] = useState('')
  const [trustFeedback, setTrustFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  // Notifications & Web Push bridge drafts
  const [requestingNotifPerm, setRequestingNotifPerm] = useState(false)
  const [testingNotif, setTestingNotif] = useState(false)
  const [testingBgPush, setTestingBgPush] = useState(false)
  const [bgPushFeedback, setBgPushFeedback] = useState<{ ok: boolean; msg: string } | null>(null)
  const [notifTestFeedback, setNotifTestFeedback] = useState<{ ok: boolean; msg: string } | null>(
    null,
  )
  const [bridgeUrlDraft, setBridgeUrlDraft] = useState(
    () => engine.notifications.settings.pushBridgeUrl,
  )
  const [vapidKeyDraft, setVapidKeyDraft] = useState(
    () => engine.notifications.settings.vapidPublicKey,
  )
  const [bridgeFeedback, setBridgeFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  useEffect(() => {
    setBridgeUrlDraft(engine.notifications.settings.pushBridgeUrl)
  }, [engine.notifications.settings.pushBridgeUrl])

  useEffect(() => {
    setVapidKeyDraft(engine.notifications.settings.vapidPublicKey)
  }, [engine.notifications.settings.vapidPublicKey])

  // Calls TURN & Transcription drafts
  const [turnUrlDraft, setTurnUrlDraft] = useState(() => engine.calls.turnConfig?.url ?? '')
  const [turnUserDraft, setTurnUserDraft] = useState(() => engine.calls.turnConfig?.username ?? '')
  const [turnCredDraft, setTurnCredDraft] = useState(
    () => engine.calls.turnConfig?.credential ?? '',
  )
  const [turnFeedback, setTurnFeedback] = useState<{ ok: boolean; msg: string } | null>(null)
  const [showAddModel, setShowAddModel] = useState(false)
  const [modelIdDraft, setModelIdDraft] = useState('')
  const [modelLabelDraft, setModelLabelDraft] = useState('')
  const [modelFeedback, setModelFeedback] = useState<{ ok: boolean; msg: string } | null>(null)
  const [clearingModelCache, setClearingModelCache] = useState(false)

  // Network drafts
  const [relayDraft, setRelayDraft] = useState('')
  const [relayError, setRelayError] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [blossomDraft, setBlossomDraft] = useState('')
  const [blossomError, setBlossomError] = useState<string | null>(null)
  const [updateCheckNote, setUpdateCheckNote] = useState<string | null>(null)

  // Hold-to-confirm Panic Wipe
  const [panicProgress, setPanicProgress] = useState(0)
  const [panicHolding, setPanicHolding] = useState(false)
  const [justWiped, setJustWiped] = useState(false)
  const rafRef = useRef<number | null>(null)
  const holdStartRef = useRef(0)
  const wipeCompletedRef = useRef(false)

  // Sync open / initialTab changes
  useEffect(() => {
    if (!open) return
    if (notificationsOnly || initialTab) {
      setActiveTab(notificationsOnly ? 'notifications' : (initialTab ?? 'profile'))
      setMobileScreen('detail')
    } else {
      setMobileScreen('menu')
    }
  }, [open, initialTab, notificationsOnly])

  useEffect(() => {
    if (!open || !notificationsOnly) return
    const dialog = modalRef.current
    const trigger = document.activeElement
    const firstClose = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('[data-notification-close]') ?? [],
    ).find((el) => el.getClientRects().length > 0)
    firstClose?.focus()
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
  }, [open, notificationsOnly])

  useEffect(() => {
    setNickDraft(identity.nickname)
  }, [identity.nickname])

  useEffect(() => {
    setLud16Draft(engine.zaps.lightningAddress ?? '')
  }, [engine.zaps.lightningAddress])

  useEffect(() => {
    setTurnUrlDraft(engine.calls.turnConfig?.url ?? '')
    setTurnUserDraft(engine.calls.turnConfig?.username ?? '')
    setTurnCredDraft(engine.calls.turnConfig?.credential ?? '')
  }, [engine.calls.turnConfig])

  useEffect(() => {
    setBridgeUrlDraft(engine.notifications.settings.pushBridgeUrl)
    setVapidKeyDraft(engine.notifications.settings.vapidPublicKey)
  }, [
    engine.notifications.settings.pushBridgeUrl,
    engine.notifications.settings.vapidPublicKey,
  ])

  const cancelCfDisable = useCallback(() => {
    setPendingCfDisable(null)
  }, [])

  const cancelRotateConfirm = useCallback(() => {
    setRotateConfirmOpen(false)
    setRotateConfirmAck(false)
  }, [])

  // Android / PWA Back button cancels nested confirmation dialogs before closing Settings
  useBackHandler(Boolean(pendingCfDisable), cancelCfDisable)
  useBackHandler(rotateConfirmOpen, cancelRotateConfirm)

  // Clear nested dialogs/menus when Settings closes
  useEffect(() => {
    if (!open) {
      setPendingCfDisable(null)
      setRotateConfirmOpen(false)
      setRotateConfirmAck(false)
      setHeroAvatarMenuOpen(false)
      setProfileFormMode('none')
      setNewProfileNickDraft('')
      setImportKeyDraft('')
      setImportNickDraft('')
      setProfileFormError(null)
      setPendingDeleteProfile(null)
      setAddTrustedOpen(false)
      setNotifAdvancedOpen(null)
      setSpeechModelsOpen(null)
      setTranslatorModelOpen(null)
      setCfModelOpen(null)
    }
  }, [open])

  useEffect(() => {
    if (!pendingCfDisable) return
    const rafId = window.requestAnimationFrame(() => {
      keepProtectionBtnRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [pendingCfDisable])

  useEffect(() => {
    if (!rotateConfirmOpen) return
    const rafId = window.requestAnimationFrame(() => {
      rotateCancelBtnRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [rotateConfirmOpen])

  // Escape dismissal
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pendingDeleteProfile || document.querySelector('[data-profile-delete-modal="true"]')) {
          return
        }
        e.preventDefault()
        if (pendingCfDisable) {
          setPendingCfDisable(null)
          return
        }
        if (rotateConfirmOpen) {
          cancelRotateConfirm()
          return
        }
        if (heroAvatarMenuOpen) {
          setHeroAvatarMenuOpen(false)
          return
        }
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    open,
    pendingDeleteProfile,
    pendingCfDisable,
    rotateConfirmOpen,
    heroAvatarMenuOpen,
    cancelRotateConfirm,
    onClose,
  ])

  const cancelPanicHold = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    setPanicHolding(false)
    if (!wipeCompletedRef.current) {
      setPanicProgress(0)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
      }
    }
  }, [])

  const customRelaySet = useMemo(() => new Set(customRelays), [customRelays])

  const sortedRelays = useMemo(() => {
    const order: Record<string, number> = {
      connected: 0,
      connecting: 1,
      degraded: 2,
      disconnected: 3,
      error: 4,
    }
    return [...relays].sort((a, b) => {
      const diff = (order[a.status] ?? 5) - (order[b.status] ?? 5)
      if (diff !== 0) return diff
      return a.url.localeCompare(b.url)
    })
  }, [relays])

  const filteredNavItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return NAV_ITEMS
    const terms = q.split(/\s+/).filter(Boolean)
    return NAV_ITEMS.filter((item) => {
      const haystack =
        `${item.category} ${item.label} ${item.subtitle} ${item.description} ${item.keywords}`.toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }, [searchQuery])

  const groupedNavSections = useMemo(() => {
    return NAV_CATEGORIES.map((category) => ({
      category,
      items: filteredNavItems.filter((item) => item.category === category),
    })).filter((group) => group.items.length > 0)
  }, [filteredNavItems])

  if (!open) return null

  const startPanicHold = () => {
    if (panicHolding) return
    wipeCompletedRef.current = false
    setJustWiped(false)
    setPanicHolding(true)
    holdStartRef.current = performance.now()

    const tick = (now: number) => {
      const pct = Math.min(100, ((now - holdStartRef.current) / PANIC_HOLD_MS) * 100)
      setPanicProgress(pct)
      if (pct >= 100) {
        wipeCompletedRef.current = true
        rafRef.current = null
        setPanicHolding(false)
        setPanicProgress(0)
        setRevealNsec(false)
        setSecretDraft('')
        setSecretFeedback(null)
        setTrustKeyDraft('')
        setTrustLabelDraft('')
        setTrustFeedback(null)
        setNotifTestFeedback(null)
        setBridgeUrlDraft('')
        setVapidKeyDraft('')
        setBridgeFeedback(null)
        setNotifAdvancedOpen(false)
        setTurnUrlDraft('')
        setTurnUserDraft('')
        setTurnCredDraft('')
        setTurnFeedback(null)
        setShowAddModel(false)
        setModelIdDraft('')
        setModelLabelDraft('')
        setModelFeedback(null)
        setRelayDraft('')
        setRelayError(null)
        setBlossomDraft('')
        setBlossomError(null)
        onPlaySound?.('wipe')
        engine.panicWipe()
        setJustWiped(true)
        window.setTimeout(() => setJustWiped(false), 2200)
        return
      }
      rafRef.current = window.requestAnimationFrame(tick)
    }
    rafRef.current = window.requestAnimationFrame(tick)
  }

  const handlePanicKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault()
      startPanicHold()
    }
  }

  const handlePanicKeyUp = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      cancelPanicHold()
    }
  }

  const handleCopyKey = async (field: 'npub' | 'nsec' | 'dm-link', value: string) => {
    const ok = await copyClipboard(value)
    if (ok) {
      setCopiedField(field)
      onPlaySound?.('click')
      engine.pushToast(
        'success',
        field === 'npub'
          ? 'Copied public key'
          : field === 'nsec'
            ? 'Copied secret key'
            : 'Copied DM link',
      )
      window.setTimeout(() => setCopiedField((prev) => (prev === field ? null : prev)), 1800)
    }
  }

  const handleNickSubmit = (e: FormEvent) => {
    e.preventDefault()
    const clean = nickDraft.trim()
    if (!clean || clean === identity.nickname) return
    engine.setNickname(clean)
    onPlaySound?.('click')
  }

  const handleImportSecret = (e: FormEvent) => {
    e.preventDefault()
    const raw = secretDraft.trim()
    if (!raw) return
    const ok = engine.setLocalSecret(raw)
    if (ok) {
      setSecretDraft('')
      setSecretFeedback({ ok: true, msg: 'Secret key applied' })
      onPlaySound?.('tune')
    } else {
      setSecretFeedback({ ok: false, msg: 'Enter a valid nsec1… or 64-char hex key' })
    }
  }

  const handleAddTrusted = (e: FormEvent) => {
    e.preventDefault()
    const key = trustKeyDraft.trim()
    if (!key) return
    const ok = engine.trustPubkey(key, trustLabelDraft.trim() || undefined)
    if (ok) {
      setTrustKeyDraft('')
      setTrustLabelDraft('')
      setTrustFeedback({ ok: true, msg: 'Added to trusted peers' })
      onPlaySound?.('click')
    } else {
      setTrustFeedback({ ok: false, msg: 'Enter a valid npub1… or 64-char hex key' })
    }
  }

  const handleSaveTurn = (e: FormEvent) => {
    e.preventDefault()
    const url = turnUrlDraft.trim()
    if (!url) return
    const ok = engine.calls.saveTurnConfig({
      url,
      username: turnUserDraft.trim() || undefined,
      credential: turnCredDraft.trim() || undefined,
    })
    if (ok) {
      setTurnFeedback({ ok: true, msg: 'Custom TURN server saved' })
      onPlaySound?.('click')
    } else {
      setTurnFeedback({ ok: false, msg: 'Enter a valid turn: or turns: server URL' })
    }
  }

  const handleClearTurn = () => {
    engine.calls.clearTurnConfig()
    setTurnUrlDraft('')
    setTurnUserDraft('')
    setTurnCredDraft('')
    setTurnFeedback({ ok: true, msg: 'Reverted to default STUN' })
    onPlaySound?.('click')
  }

  const handleAddTranscriptionModel = (e: FormEvent) => {
    e.preventDefault()
    const hfId = modelIdDraft.trim()
    if (!hfId) return
    const ok = engine.transcription.addCustomModel(hfId, modelLabelDraft.trim() || undefined)
    if (ok) {
      setModelIdDraft('')
      setModelLabelDraft('')
      setShowAddModel(false)
      setModelFeedback({ ok: true, msg: 'Added custom Hugging Face ONNX model' })
      onPlaySound?.('click')
    } else {
      setModelFeedback({
        ok: false,
        msg: 'Enter a valid org/model-name Hugging Face repo ID',
      })
    }
  }

  const handleClearModelCache = async () => {
    if (clearingModelCache) return
    setClearingModelCache(true)
    onPlaySound?.('click')
    try {
      await engine.transcription.clearModelCache()
      setModelFeedback({ ok: true, msg: 'Cleared cached model weights' })
    } finally {
      setClearingModelCache(false)
    }
  }

  const handleAddRelay = (e: FormEvent) => {
    e.preventDefault()
    const raw = relayDraft.trim()
    if (!raw) return
    const normalized = /^wss?:\/\//i.test(raw) ? raw : `wss://${raw}`
    const ok = engine.addCustomRelay(normalized)
    if (ok) {
      setRelayDraft('')
      setRelayError(null)
      onPlaySound?.('click')
    } else {
      setRelayError('Enter a valid wss:// relay URL')
    }
  }

  const handleAddBlossom = (e: FormEvent) => {
    e.preventDefault()
    const raw = blossomDraft.trim()
    if (!raw) return
    const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    const ok = engine.addBlossomServer(normalized)
    if (ok) {
      setBlossomDraft('')
      setBlossomError(null)
      onPlaySound?.('click')
    } else {
      setBlossomError('Enter a valid https:// Blossom URL')
    }
  }

  const handleConnectPushBridge = async (e: FormEvent) => {
    e.preventDefault()
    const rawUrl = bridgeUrlDraft.trim()
    if (!rawUrl || engine.notifications.pushStatus === 'connecting') return
    const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`
    setBridgeFeedback(null)
    onPlaySound?.('click')
    const ok = await engine.notifications.connectPushBridge(
      normalizedUrl,
      vapidKeyDraft.trim() || undefined,
    )
    if (ok) {
      setBridgeUrlDraft(normalizedUrl)
      setBridgeFeedback({ ok: true, msg: 'Device subscribed to background push bridge' })
      onPlaySound?.('tune')
    } else if (!engine.notifications.pushError) {
      setBridgeFeedback({ ok: false, msg: 'Could not connect to push bridge' })
    }
  }

  const handleDisconnectPushBridge = async () => {
    setBridgeFeedback(null)
    onPlaySound?.('click')
    await engine.notifications.disconnectPushBridge()
    setBridgeFeedback({ ok: true, msg: 'Disconnected background push device' })
  }

  const handleUseBuiltinPushBridge = async () => {
    if (engine.notifications.pushStatus === 'connecting') return
    setBridgeFeedback(null)
    onPlaySound?.('click')
    setBridgeUrlDraft(DEFAULT_PUSH_BRIDGE_URL)
    setVapidKeyDraft(DEFAULT_VAPID_PUBLIC_KEY)
    engine.notifications.updateSettings({
      pushBridgeUrl: DEFAULT_PUSH_BRIDGE_URL,
      vapidPublicKey: DEFAULT_VAPID_PUBLIC_KEY,
    })
    if (engine.notifications.permission === 'granted' && engine.notifications.isPushSupported) {
      const ok = await engine.notifications.connectPushBridge(
        DEFAULT_PUSH_BRIDGE_URL,
        DEFAULT_VAPID_PUBLIC_KEY,
      )
      if (ok) {
        setBridgeFeedback({ ok: true, msg: 'Connected to built-in push bridge' })
        onPlaySound?.('tune')
      }
    } else {
      setBridgeFeedback({ ok: true, msg: 'Switched to built-in push bridge' })
    }
  }

  const handleSaveLightningAddress = async (e: FormEvent) => {
    e.preventDefault()
    if (lud16Saving) return
    setLud16Saving(true)
    setLud16Feedback(null)
    try {
      const cleaned = lud16Draft.trim()
      const useBuiltin =
        !cleaned ||
        cleaned.toLowerCase() === engine.zaps.builtinLightningAddress.toLowerCase()
      const res = useBuiltin
        ? await engine.zaps.setZapAddressMode('builtin')
        : await engine.zaps.setZapAddressMode('custom', cleaned)
      if (res.ok) {
        onPlaySound?.('click')
        setLud16Draft(res.normalized ?? engine.zaps.builtinLightningAddress)
        setLud16Feedback({
          ok: true,
          msg: useBuiltin
            ? res.publishedRelays > 0
              ? `Using built-in Agwallet Zap address (published to ${res.publishedRelays} ${res.publishedRelays === 1 ? 'relay' : 'relays'})`
              : 'Using built-in Agwallet Zap address'
            : res.publishedRelays > 0
              ? `Saved & published to ${res.publishedRelays} ${res.publishedRelays === 1 ? 'relay' : 'relays'}`
              : 'Saved custom Lightning Address locally',
        })
      } else {
        setLud16Feedback({
          ok: false,
          msg: res.error || 'Enter a valid Lightning Address (e.g. you@domain.com)',
        })
      }
    } finally {
      setLud16Saving(false)
    }
  }

  const handleUseBuiltinZapAddress = async () => {
    if (lud16Saving) return
    setLud16Saving(true)
    setLud16Feedback(null)
    try {
      const res = await engine.zaps.setZapAddressMode('builtin')
      if (res.ok) {
        onPlaySound?.('click')
        setLud16Draft(res.normalized ?? engine.zaps.builtinLightningAddress)
        setLud16Feedback({
          ok: true,
          msg:
            res.publishedRelays > 0
              ? `Switched to built-in Agwallet Zap address (${res.publishedRelays} ${res.publishedRelays === 1 ? 'relay' : 'relays'})`
              : 'Switched to built-in Agwallet Zap address',
        })
      } else {
        setLud16Feedback({
          ok: false,
          msg: res.error || 'Could not switch to built-in Zap address',
        })
      }
    } finally {
      setLud16Saving(false)
    }
  }

  const handleCfTestImageFile = async (file: File | null) => {
    if (!file || cfTesting) return
    setCfTesting(true)
    setCfTestLabel(file.name)
    setCfTestResult(null)
    onPlaySound?.('click')
    try {
      const verdict = await engine.contentFilter.screenImageBlob(
        `settings-test-img:${Date.now()}`,
        file,
        { skipCache: true },
      )
      setCfTestResult(verdict)
    } finally {
      setCfTesting(false)
      if (cfFileInputRef.current) {
        cfFileInputRef.current.value = ''
      }
    }
  }

  const handleClearContentFilterCache = async () => {
    if (cfClearingCache) return
    setCfClearingCache(true)
    setCfFeedback(null)
    onPlaySound?.('click')
    try {
      await engine.contentFilter.clearModelCache()
      engine.contentFilter.clearVerdictCache()
      setCfTestResult(null)
      setCfFeedback({ ok: true, msg: 'Cleared Content Filter model & verdict cache' })
    } catch (err) {
      setCfFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : 'Unable to clear filter cache',
      })
    } finally {
      setCfClearingCache(false)
    }
  }

  const handleClearTranslatorModelCache = async () => {
    if (trClearingCache) return
    setTrClearingCache(true)
    setTrFeedback(null)
    onPlaySound?.('click')
    try {
      await engine.translator.clearModelCache()
      setTrFeedback({ ok: true, msg: 'Cleared translator model cache' })
    } catch (err) {
      setTrFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : 'Unable to clear model cache',
      })
    } finally {
      setTrClearingCache(false)
    }
  }

  const renderTabIcon = (id: SettingsTab) => {
    switch (id) {
      case 'profile':
        return <User size={16} />
      case 'notifications':
        return <Bell size={16} />
      case 'privacy':
        return <ShieldCheck size={16} />
      case 'content-filter':
        return <ShieldAlert size={16} />
      case 'translator':
        return <Languages size={16} />
      case 'appearance':
        return <Palette size={16} />
      case 'calls':
        return <PhoneCall size={16} />
      case 'network':
        return <Globe size={16} />
    }
  }

  const activeNavMeta = NAV_ITEMS.find((n) => n.id === activeTab) ?? NAV_ITEMS[0]

  const renderProfileTab = () => {
    const signModeBadgeLabel =
      SIGN_MODES.find((m) => m.id === identity.signMode)?.label ?? 'Auto'

    return (
      <div className="ag-set-pane-stack">
        {/* 1. Identity Card */}
        <SettingsSection
          title="Identity"
          description="Your public handle, profile photo, and Lightning address."
        >
          <div className="ag-set-card-list">
            {/* Hero Avatar + Handle + Share Actions */}
            <div className="ag-set-identity-hero-row">
              <div className="ag-set-identity-hero-left">
                <div className="ag-set-hero-avatar-wrap" ref={heroAvatarMenuRef}>
                  <input
                    ref={profilePicInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => void handleProfilePictureSelect(e)}
                  />
                  <button
                    type="button"
                    className="ag-set-hero-avatar-btn"
                    disabled={profilePicBusy}
                    onClick={() => {
                      if (myProfilePicture) {
                        setHeroAvatarMenuOpen((v) => !v)
                      } else {
                        profilePicInputRef.current?.click()
                      }
                    }}
                    aria-haspopup={myProfilePicture ? 'menu' : undefined}
                    aria-expanded={myProfilePicture ? heroAvatarMenuOpen : undefined}
                    aria-label={
                      myProfilePicture ? 'Change or remove profile photo' : 'Upload profile photo'
                    }
                    title={myProfilePicture ? 'Change or remove photo' : 'Upload profile photo'}
                  >
                    <AvatarImg
                      pubkey={identity.masterPubkey}
                      pictureUrl={myProfilePicture}
                      alt=""
                      width={56}
                      height={56}
                      className="ag-set-avatar-lg"
                    />
                    <span
                      className={`ag-set-hero-avatar-overlay${profilePicBusy ? ' is-busy' : ''}`}
                      aria-hidden="true"
                    >
                      {profilePicBusy ? (
                        <Loader2 size={16} className="ag-spin" />
                      ) : (
                        <Camera size={16} />
                      )}
                    </span>
                  </button>

                  {heroAvatarMenuOpen && myProfilePicture && (
                    <div
                      className="ag-avatar-photo-menu"
                      role="menu"
                      aria-label="Profile photo options"
                    >
                      <button
                        type="button"
                        className="ag-avatar-photo-menu-item"
                        role="menuitem"
                        onClick={() => {
                          setHeroAvatarMenuOpen(false)
                          profilePicInputRef.current?.click()
                        }}
                      >
                        <Camera size={14} />
                        <span>Change photo</span>
                      </button>
                      <button
                        type="button"
                        className="ag-avatar-photo-menu-item danger"
                        role="menuitem"
                        onClick={() => {
                          setHeroAvatarMenuOpen(false)
                          void handleRemoveProfilePicture()
                        }}
                      >
                        <Trash2 size={14} />
                        <span>Remove photo</span>
                      </button>
                    </div>
                  )}
                </div>

                <div className="ag-set-profile-meta">
                  <div
                    className="ag-set-profile-handle truncate"
                    style={{ color: pubkeyToColor(identity.activePubkey) }}
                  >
                    {identity.activeDisplayHandle}
                  </div>
                  <div className="ag-set-profile-sub mono truncate">
                    {shortPubkey(identity.activeNpub, 12, 6)}
                  </div>
                </div>
              </div>

              <div className="ag-set-identity-share-actions">
                <button
                  type="button"
                  className="ag-btn ag-btn-secondary ag-btn-sm"
                  onClick={() =>
                    void handleCopyKey(
                      'dm-link',
                      buildDmShareUrl(identity.masterPubkey, identity.nickname),
                    )
                  }
                >
                  {copiedField === 'dm-link' ? <Check size={14} /> : <Link2 size={14} />}
                  <span>{copiedField === 'dm-link' ? 'Copied' : 'Share DM Link'}</span>
                </button>

                {onShowQr && (
                  <button
                    type="button"
                    className="ag-btn ag-btn-primary ag-btn-sm"
                    onClick={() => {
                      onPlaySound?.('click')
                      onShowQr({
                        kind: 'dm',
                        title: 'My DM QR Code',
                        subtitle: identity.activeDisplayHandle,
                        url: buildDmShareUrl(identity.masterPubkey, identity.nickname),
                        codeLabel: 'Public key (npub)',
                        codeValue: identity.masterNpub,
                      })
                    }}
                  >
                    <QrCode size={14} />
                    <span>QR Code</span>
                  </button>
                )}
              </div>
            </div>

            {/* Display Name */}
            <form className="ag-set-card-field" onSubmit={handleNickSubmit}>
              <label className="ag-set-field-label" htmlFor="ag-set-nick">
                Display Name
              </label>
              <div className="ag-set-inline-row">
                <input
                  id="ag-set-nick"
                  type="text"
                  maxLength={24}
                  className="ag-input"
                  value={nickDraft}
                  onChange={(e) => setNickDraft(e.target.value)}
                  placeholder="agnon"
                />
                <button
                  type="submit"
                  className="ag-btn ag-btn-primary"
                  disabled={!nickDraft.trim() || nickDraft.trim() === identity.nickname}
                >
                  Save
                </button>
              </div>
            </form>

            {/* Lightning Address */}
            <form
              className="ag-set-card-field"
              onSubmit={(e) => void handleSaveLightningAddress(e)}
            >
              <div className="ag-set-label-row">
                <label className="ag-set-field-label" htmlFor="ag-set-lud16">
                  Lightning Address
                </label>
                <div className="ag-set-inline-actions">
                  {engine.zaps.zapMode === 'custom' && (
                    <button
                      type="button"
                      className="ag-btn ag-btn-ghost ag-btn-xs"
                      disabled={lud16Saving}
                      onClick={() => void handleUseBuiltinZapAddress()}
                    >
                      Use built-in
                    </button>
                  )}
                  {engine.zaps.lightningAddress && (
                    <span className="ag-badge ag-badge-zap mono">
                      <Zap size={10} />
                      <span>{engine.zaps.zapMode === 'builtin' ? 'Built-in' : 'Custom'}</span>
                    </span>
                  )}
                </div>
              </div>
              <div className="ag-set-inline-row">
                <input
                  id="ag-set-lud16"
                  type="text"
                  inputMode="email"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={120}
                  className="ag-input mono"
                  value={lud16Draft}
                  onChange={(e) => {
                    setLud16Draft(e.target.value)
                    if (lud16Feedback) setLud16Feedback(null)
                  }}
                  placeholder={engine.zaps.builtinLightningAddress || 'you@domain.com'}
                />
                <button
                  type="submit"
                  className="ag-btn ag-btn-primary"
                  disabled={
                    lud16Saving || lud16Draft.trim() === (engine.zaps.lightningAddress ?? '')
                  }
                >
                  {lud16Saving ? <Loader2 size={14} className="ag-spin" /> : 'Save'}
                </button>
              </div>
              <p className="ag-set-helper">
                Receive tips and zaps at this address.{' '}
                {engine.zaps.zapMode === 'builtin'
                  ? 'Built-in zaps sweep straight into Agwallet.'
                  : 'Clear or click Use built-in to sweep into Agwallet.'}
              </p>
              {lud16Feedback && (
                <p
                  className={`ag-field-hint ${
                    lud16Feedback.ok ? 'ag-field-hint-accent' : 'ag-field-hint-danger'
                  }`}
                  role="status"
                >
                  {lud16Feedback.msg}
                </p>
              )}
            </form>
          </div>
        </SettingsSection>

        {/* 2. Profiles Card */}
        <SettingsSection
          title="Profiles"
          description="Each profile has its own keys, chats, groups, Agmail, wallet, and settings."
          badge={
            <div className="ag-set-profiles-title-wrap">
              <span className="ag-badge ag-badge-muted mono">
                {engine.profiles.profiles.length}
              </span>
              {engine.profiles.otherProfilesUnreadCount > 0 && (
                <span
                  className="ag-set-profile-notif-badge tabular"
                  aria-label={`${engine.profiles.otherProfilesUnreadCount} unread notification${engine.profiles.otherProfilesUnreadCount === 1 ? '' : 's'} on other profiles`}
                >
                  {engine.profiles.otherProfilesUnreadCount > 99
                    ? '99+'
                    : engine.profiles.otherProfilesUnreadCount}{' '}
                  new
                </span>
              )}
            </div>
          }
          action={
            <div className="ag-set-profiles-head-actions">
              <button
                type="button"
                className={`ag-btn ag-btn-sm ${
                  profileFormMode === 'create' ? 'ag-btn-primary' : 'ag-btn-secondary'
                }`}
                disabled={engine.profiles.switching}
                onClick={() => {
                  onPlaySound?.('click')
                  setPendingDeleteProfile(null)
                  setProfileFormError(null)
                  setProfileFormMode((m) => (m === 'create' ? 'none' : 'create'))
                }}
              >
                <Plus size={13} />
                <span>New</span>
              </button>
              <button
                type="button"
                className={`ag-btn ag-btn-sm ${
                  profileFormMode === 'import' ? 'ag-btn-primary' : 'ag-btn-secondary'
                }`}
                disabled={engine.profiles.switching}
                onClick={() => {
                  onPlaySound?.('click')
                  setPendingDeleteProfile(null)
                  setProfileFormError(null)
                  setProfileFormMode((m) => (m === 'import' ? 'none' : 'import'))
                }}
              >
                <KeyRound size={13} />
                <span>Import</span>
              </button>
            </div>
          }
        >
          <div className="ag-set-profiles-card">
            {profileFormMode === 'create' && (
              <form
                className="ag-set-profile-subform"
                onSubmit={(e) => void handleCreateProfileSubmit(e)}
              >
                <input
                  type="text"
                  maxLength={24}
                  className="ag-input"
                  value={newProfileNickDraft}
                  onChange={(e) => {
                    setNewProfileNickDraft(e.target.value)
                    if (profileFormError) setProfileFormError(null)
                  }}
                  placeholder="Display name (optional)"
                  aria-label="New profile display name"
                />
                {profileFormError && (
                  <p className="ag-field-hint ag-field-hint-danger" role="alert">
                    {profileFormError}
                  </p>
                )}
                <div className="ag-set-profile-subform-actions">
                  <button
                    type="button"
                    className="ag-btn ag-btn-secondary ag-btn-sm"
                    disabled={profileFormBusy}
                    onClick={resetProfileForm}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="ag-btn ag-btn-primary ag-btn-sm"
                    disabled={profileFormBusy || engine.profiles.switching}
                  >
                    {profileFormBusy ? (
                      <Loader2 size={13} className="ag-spin" />
                    ) : (
                      <Plus size={13} />
                    )}
                    <span>{profileFormBusy ? 'Creating…' : 'Create'}</span>
                  </button>
                </div>
              </form>
            )}

            {profileFormMode === 'import' && (
              <form
                className="ag-set-profile-subform"
                onSubmit={(e) => void handleImportProfileSubmit(e)}
              >
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className="ag-input mono"
                  value={importKeyDraft}
                  onChange={(e) => {
                    setImportKeyDraft(e.target.value)
                    if (profileFormError) setProfileFormError(null)
                  }}
                  placeholder="nsec1… or 64-char hex private key"
                  aria-label="Private key to import"
                />
                <input
                  type="text"
                  maxLength={24}
                  className="ag-input"
                  value={importNickDraft}
                  onChange={(e) => setImportNickDraft(e.target.value)}
                  placeholder="Display name (optional)"
                  aria-label="Optional display name for imported profile"
                />
                {profileFormError && (
                  <p className="ag-field-hint ag-field-hint-danger" role="alert">
                    {profileFormError}
                  </p>
                )}
                <div className="ag-set-profile-subform-actions">
                  <button
                    type="button"
                    className="ag-btn ag-btn-secondary ag-btn-sm"
                    disabled={profileFormBusy}
                    onClick={resetProfileForm}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="ag-btn ag-btn-primary ag-btn-sm"
                    disabled={
                      !importKeyDraft.trim() || profileFormBusy || engine.profiles.switching
                    }
                  >
                    {profileFormBusy ? (
                      <Loader2 size={13} className="ag-spin" />
                    ) : (
                      <KeyRound size={13} />
                    )}
                    <span>{profileFormBusy ? 'Importing…' : 'Import & Switch'}</span>
                  </button>
                </div>
              </form>
            )}

            <div className="ag-set-profiles-list" role="list" aria-label="Saved profiles">
              {engine.profiles.profiles.map((prof) => {
                const isActive =
                  prof.id === engine.profiles.activeProfileId ||
                  prof.pubkey.toLowerCase() === identity.masterPubkey.toLowerCase()
                const displayNick = isActive ? identity.nickname : prof.nickname
                const avatarUrl = isActive
                  ? myProfilePicture
                  : (engine.getProfilePicture(prof.pubkey) ?? prof.picture)
                const profNotif = !isActive
                  ? (engine.profiles.notificationsByProfile[prof.id] ??
                    engine.profiles.notificationsByProfile[prof.pubkey.toLowerCase()])
                  : undefined
                const unreadCount = profNotif?.unreadCount ?? 0

                return (
                  <div
                    key={prof.id}
                    role="listitem"
                    className={`ag-set-profile-item-wrap${isActive ? ' is-active' : ''}${
                      unreadCount > 0 ? ' has-notifs' : ''
                    }`}
                  >
                    <div className="ag-set-profile-item">
                      <AvatarImg
                        pubkey={prof.pubkey}
                        pictureUrl={avatarUrl}
                        alt=""
                        width={34}
                        height={34}
                        className="ag-set-profile-item-avatar"
                      />
                      <div className="ag-set-profile-item-copy">
                        <div className="ag-set-profile-item-name-row">
                          <span
                            className="ag-set-profile-item-name truncate"
                            style={{ color: pubkeyToColor(prof.pubkey) }}
                          >
                            {displayNick}
                          </span>
                          {isActive && <span className="ag-badge ag-badge-accent">Active</span>}
                          {!isActive && unreadCount > 0 && (
                            <span
                              className="ag-set-profile-notif-badge tabular"
                              aria-label={`${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`}
                            >
                              {unreadCount > 99 ? '99+' : unreadCount} new
                            </span>
                          )}
                        </div>
                        <span className="ag-set-row-sub mono truncate">
                          {shortPubkey(prof.npub, 10, 6)}
                        </span>
                        {!isActive && unreadCount > 0 && profNotif?.lastSummary && (
                          <span
                            className="ag-set-profile-notif-summary truncate"
                            title={profNotif.lastSummary}
                          >
                            {profNotif.lastSummary}
                          </span>
                        )}
                      </div>

                      {!isActive && (
                        <div className="ag-set-profile-item-actions">
                          <button
                            type="button"
                            className="ag-btn ag-btn-secondary ag-btn-xs"
                            disabled={engine.profiles.switching || removingProfilePubkey !== null}
                            onClick={() => {
                              onPlaySound?.('click')
                              void engine.profiles.switchProfile(prof.pubkey)
                            }}
                          >
                            Switch
                          </button>
                          <button
                            type="button"
                            className="ag-icon-btn-sm ag-icon-btn-danger"
                            disabled={engine.profiles.switching || removingProfilePubkey !== null}
                            onClick={() => {
                              onPlaySound?.('click')
                              setPendingDeleteProfile(prof)
                            }}
                            aria-label={`Remove profile ${displayNick}`}
                            title="Remove profile"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </SettingsSection>

        {/* 3. Device Sync Card */}
        <SettingsSection
          title="Device Sync"
          description="Keep your profiles and settings synced across your own devices."
          badge={
            <span
              className={`ag-badge ${
                engine.deviceSync.onlineSiblingCount > 0 ? 'ag-badge-accent' : 'ag-badge-muted'
              }`}
            >
              {engine.deviceSync.onlineSiblingCount > 0
                ? `${engine.deviceSync.onlineSiblingCount} online`
                : engine.deviceSync.linkedDevices.length > 0
                  ? `${engine.deviceSync.linkedDevices.length} linked`
                  : 'Solo device'}
            </span>
          }
        >
          <div className="ag-set-sync-card">
            <label className="ag-set-sync-toggle-row">
              <div className="ag-set-toggle-copy">
                <span className="ag-set-toggle-title">
                  <Smartphone size={15} />
                  <span>Encrypted Background Sync</span>
                </span>
                <span className="ag-set-toggle-desc">
                  Sync groups, friends, notes, pins, Agmail, and messages automatically. Agwallet stays on this device; use its backup tools to move it.
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={engine.deviceSync.enabled}
                onChange={() => {
                  engine.deviceSync.setEnabled(!engine.deviceSync.enabled)
                  onPlaySound?.('click')
                }}
              />
            </label>

            {editingDeviceLabel ? (
              <form
                className="ag-set-sync-this-row ag-set-sync-this-edit"
                onSubmit={(e) => {
                  e.preventDefault()
                  engine.deviceSync.setDeviceLabel(deviceLabelDraft)
                  setEditingDeviceLabel(false)
                  onPlaySound?.('click')
                }}
              >
                <input
                  type="text"
                  className="ag-input ag-set-sync-rename-input"
                  value={deviceLabelDraft}
                  onChange={(e) => setDeviceLabelDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      setEditingDeviceLabel(false)
                      setDeviceLabelDraft(engine.deviceSync.deviceLabel)
                    }
                  }}
                  maxLength={48}
                  placeholder="e.g. MacBook Pro, Pixel 8"
                  aria-label="Friendly name for this device"
                  autoFocus
                />
                <div className="ag-set-sync-rename-actions">
                  <button type="submit" className="ag-btn ag-btn-primary ag-btn-xs">
                    Save
                  </button>
                  <button
                    type="button"
                    className="ag-btn ag-btn-ghost ag-btn-xs"
                    onClick={() => {
                      setEditingDeviceLabel(false)
                      setDeviceLabelDraft(engine.deviceSync.deviceLabel)
                    }}
                    aria-label="Cancel device rename"
                    title="Cancel"
                  >
                    <X size={13} />
                  </button>
                </div>
              </form>
            ) : (
              <div className="ag-set-sync-this-row">
                <span className="ag-set-sync-key">This Device</span>
                <div className="ag-set-sync-this-main">
                  <span className="ag-set-sync-val truncate" title={engine.deviceSync.deviceLabel}>
                    {engine.deviceSync.deviceLabel}
                  </span>
                  <span
                    className="ag-set-sync-id mono"
                    title={`Device ID: ${engine.deviceSync.deviceId}`}
                  >
                    {shortDeviceTag(engine.deviceSync.deviceId)}
                  </span>
                  <button
                    type="button"
                    className="ag-set-sync-rename-btn"
                    onClick={() => {
                      setDeviceLabelDraft(engine.deviceSync.deviceLabel)
                      setEditingDeviceLabel(true)
                      onPlaySound?.('click')
                    }}
                    aria-label="Rename this device"
                    title="Rename this device"
                  >
                    <Pencil size={12} />
                  </button>
                </div>
              </div>
            )}

            <div className="ag-set-sync-devices">
              <span className="ag-set-sync-subhead">
                Linked Devices ({engine.deviceSync.linkedDevices.length})
              </span>
              {engine.deviceSync.linkedDevices.length === 0 ? (
                <p className="ag-set-sync-empty">
                  Sign in with the same key on another device to sync automatically.
                </p>
              ) : (
                <div className="ag-set-sync-device-list" role="list">
                  {engine.deviceSync.linkedDevices.map((dev) => {
                    const status = formatDeviceSyncStatus(dev)
                    const tag = shortDeviceTag(dev.deviceId)
                    return (
                      <div key={dev.deviceId} role="listitem" className="ag-set-sync-device-row">
                        <span
                          className={`ag-set-sync-dot ${dev.online ? 'online' : ''}`}
                          aria-hidden="true"
                        />
                        <div className="ag-set-sync-device-info">
                          <div className="ag-set-sync-device-title-row">
                            <span className="ag-set-sync-device-label truncate" title={dev.label}>
                              {dev.label}
                            </span>
                            <span
                              className="ag-set-sync-id mono"
                              title={`Device ID: ${dev.deviceId}`}
                            >
                              {tag}
                            </span>
                          </div>
                          <span className="ag-set-sync-device-meta mono" title={status.title}>
                            {status.text}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="ag-set-sync-forget-btn"
                          onClick={() => {
                            onPlaySound?.('click')
                            engine.deviceSync.removeLinkedDevice(dev.deviceId)
                          }}
                          aria-label={`Forget ${dev.label} (${tag})`}
                          title={`Forget ${dev.label}`}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="ag-set-sync-footer">
              <span
                className="ag-set-sync-meta mono"
                title={
                  engine.deviceSync.lastSyncedAt
                    ? new Date(engine.deviceSync.lastSyncedAt).toLocaleString()
                    : undefined
                }
              >
                Last synced: {formatSyncAge(engine.deviceSync.lastSyncedAt)}
                {engine.deviceSync.syncedItemsCount > 0
                  ? ` · ${engine.deviceSync.syncedItemsCount} items`
                  : ''}
              </span>
              <button
                type="button"
                className="ag-btn ag-btn-secondary ag-btn-xs"
                disabled={!engine.deviceSync.enabled || engine.deviceSync.isSyncing}
                onClick={() => {
                  onPlaySound?.('click')
                  void engine.deviceSync.syncNow()
                }}
              >
                <RefreshCw size={12} className={engine.deviceSync.isSyncing ? 'ag-spin' : ''} />
                <span>{engine.deviceSync.isSyncing ? 'Syncing…' : 'Sync Now'}</span>
              </button>
            </div>
          </div>
        </SettingsSection>

        {/* 4. Collapsible Keys & Signer */}
        <SettingsDisclosure
          icon={<KeyRound size={15} />}
          title="Keys & Signer"
          description="View or back up your Nostr keys, choose a signer, or rotate keys."
          badge={<span className="ag-badge ag-badge-muted">{signModeBadgeLabel}</span>}
          open={keysDisclosureOpen}
          onToggle={() => {
            setKeysDisclosureOpen((v) => !v)
            onPlaySound?.('click')
          }}
        >
          <div className="ag-set-card-list ag-set-card-inset">
            <div className="ag-set-key-row">
              <div className="ag-set-key-copy">
                <span className="ag-set-row-sub">Public key (npub)</span>
                <span className="ag-set-key-val mono truncate" title={identity.activeNpub}>
                  {identity.activeNpub}
                </span>
              </div>
              <button
                type="button"
                className="ag-icon-btn-sm"
                onClick={() => void handleCopyKey('npub', identity.activeNpub)}
                aria-label="Copy public key"
                title="Copy public key"
              >
                {copiedField === 'npub' ? (
                  <Check size={15} className="ag-tone-ok" />
                ) : (
                  <Copy size={15} />
                )}
              </button>
            </div>

            {identity.maskedNsec && (
              <div className="ag-set-key-row">
                <div className="ag-set-key-copy">
                  <span className="ag-set-row-sub">Private key (nsec)</span>
                  <span className="ag-set-key-val mono truncate">
                    {revealNsec && identity.exportableNsec
                      ? identity.exportableNsec
                      : identity.maskedNsec}
                  </span>
                </div>
                {identity.exportableNsec && (
                  <div className="ag-set-key-btns">
                    <button
                      type="button"
                      className="ag-icon-btn-sm"
                      onClick={() => setRevealNsec((v) => !v)}
                      aria-label={revealNsec ? 'Hide secret key' : 'Reveal secret key'}
                      title={revealNsec ? 'Hide secret key' : 'Reveal secret key'}
                    >
                      {revealNsec ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                    <button
                      type="button"
                      className="ag-icon-btn-sm"
                      onClick={() => void handleCopyKey('nsec', identity.exportableNsec!)}
                      aria-label="Copy secret key"
                      title="Copy secret key"
                    >
                      {copiedField === 'nsec' ? (
                        <Check size={15} className="ag-tone-ok" />
                      ) : (
                        <Copy size={15} />
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {identity.maskedNsec && (
            <p className="ag-set-caution">
              <AlertTriangle size={13} aria-hidden="true" />
              <span>
                Back up your private key (<span className="mono">nsec</span>) somewhere safe and
                never share it with anyone.
              </span>
            </p>
          )}

          <div className="ag-set-disclosure-group">
            <div className="ag-set-label-row">
              <span className="ag-set-field-label">Signing Method</span>
              {identity.hasNip07 && <span className="ag-badge ag-badge-ok">Extension detected</span>}
            </div>
            <div className="ag-segmented" role="tablist" aria-label="Nostr signing mode">
              {SIGN_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  aria-selected={identity.signMode === m.id}
                  className={identity.signMode === m.id ? 'active' : ''}
                  disabled={m.id === 'extension' && !identity.hasNip07}
                  onClick={() => {
                    if (m.id === identity.signMode) return
                    engine.setSignMode(m.id)
                    setSecretFeedback(null)
                    onPlaySound?.('click')
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {identity.signMode === 'local' && (
              <form className="ag-set-subform" onSubmit={handleImportSecret}>
                <div className="ag-set-inline-row">
                  <input
                    type="password"
                    autoComplete="off"
                    className="ag-input mono"
                    placeholder="Replace with nsec1… or 64-char hex"
                    value={secretDraft}
                    onChange={(e) => {
                      setSecretDraft(e.target.value)
                      if (secretFeedback) setSecretFeedback(null)
                    }}
                    aria-label="Import secret key"
                  />
                  <button
                    type="submit"
                    className="ag-btn ag-btn-secondary"
                    disabled={!secretDraft.trim()}
                  >
                    Import
                  </button>
                </div>
                {secretFeedback && (
                  <p
                    className={`ag-field-hint ${
                      secretFeedback.ok ? 'ag-field-hint-ok' : 'ag-field-hint-danger'
                    }`}
                  >
                    {secretFeedback.msg}
                  </p>
                )}
              </form>
            )}
          </div>

          <div className="ag-set-key-danger-row">
            <div className="ag-set-toggle-copy">
              <span className="ag-set-notif-row-title">Rotate Nostr Keys</span>
              <span className="ag-set-notif-row-desc">
                Replace this profile&apos;s keypair with a brand-new Nostr identity.
              </span>
            </div>
            <button
              type="button"
              className="ag-btn ag-btn-danger-outline ag-btn-sm ag-set-rotate-btn"
              disabled={identity.signMode === 'extension'}
              onClick={() => {
                setHeroAvatarMenuOpen(false)
                setRotateConfirmAck(false)
                setRotateConfirmOpen(true)
                onPlaySound?.('click')
              }}
              title={
                identity.signMode === 'extension'
                  ? 'Switch to Auto or Local key to rotate keys'
                  : 'Generate a fresh Nostr keypair (requires confirmation)'
              }
            >
              <RefreshCw size={13} />
              <span>Rotate Nostr Keys</span>
            </button>
          </div>
        </SettingsDisclosure>
      </div>
    )
  }

  const renderNotificationsTab = () => {
    const notif = engine.notifications
    const ns = notif.settings
    const ringtoneAndVibe = ns.ringtoneEnabled || ns.vibrationEnabled

    const bannerState = notif.isIosRequiresInstall
      ? 'ios-install'
      : !notif.isSupported || notif.permission === 'unsupported'
        ? 'unsupported'
        : notif.permission === 'denied'
          ? 'denied'
          : notif.permission === 'granted'
            ? 'granted'
            : 'default'

    const pushStatusBadge =
      notif.pushStatus === 'connected'
        ? { cls: 'ag-badge-accent', label: 'Connected' }
        : notif.pushStatus === 'connecting'
          ? { cls: 'ag-badge-warn', label: 'Connecting…' }
          : notif.pushStatus === 'error'
            ? { cls: 'ag-badge-danger', label: 'Error' }
            : notif.pushStatus === 'unsupported'
              ? { cls: 'ag-badge-muted', label: 'Off' }
              : notif.isUsingDefaultBridge
                ? { cls: 'ag-badge-muted', label: 'Built-in' }
                : { cls: 'ag-badge-muted', label: 'Off' }

    const isAdvancedOpen = notifAdvancedOpen ?? notif.pushStatus === 'error'

    const handleEnableNotificationsClick = () => {
      if (requestingNotifPerm) return
      setRequestingNotifPerm(true)
      setNotifTestFeedback(null)
      const permPromise = notif.requestPermission()
      void permPromise
        .then((res) => {
          if (res === 'granted') {
            onPlaySound?.('tune')
            setNotifTestFeedback({ ok: true, msg: 'Notifications enabled for this device' })
          } else if (res === 'denied') {
            setNotifTestFeedback({
              ok: false,
              msg: 'Permission blocked — enable alerts in browser site settings',
            })
          }
        })
        .finally(() => setRequestingNotifPerm(false))
    }

    const handleTestNotificationClick = () => {
      if (testingNotif) return
      setTestingNotif(true)
      setNotifTestFeedback(null)
      const testPromise = notif.sendTestNotification()
      void testPromise
        .then((ok) => {
          if (ok) {
            onPlaySound?.('click')
            setNotifTestFeedback({ ok: true, msg: 'Test notification sent' })
          } else {
            setNotifTestFeedback({
              ok: false,
              msg:
                notif.permission === 'denied'
                  ? 'Notifications are blocked in browser settings'
                  : 'Enable browser notifications first to preview OS alerts',
            })
          }
        })
        .finally(() => setTestingNotif(false))
    }

    const handleQuickConnectBackgroundPush = () => {
      if (notif.pushStatus === 'connecting') return
      const rawUrl = bridgeUrlDraft.trim() || ns.pushBridgeUrl.trim() || DEFAULT_PUSH_BRIDGE_URL
      const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`
      const rawVapid =
        vapidKeyDraft.trim() ||
        ns.vapidPublicKey.trim() ||
        (normalizedUrl.replace(/\/+$/, '') === DEFAULT_PUSH_BRIDGE_URL
          ? DEFAULT_VAPID_PUBLIC_KEY
          : '')
      setBridgeFeedback(null)
      setBgPushFeedback(null)
      setNotifTestFeedback(null)
      onPlaySound?.('click')
      void notif.connectPushBridge(normalizedUrl, rawVapid || undefined).then((ok) => {
        if (ok) {
          setBridgeUrlDraft(normalizedUrl)
          setBgPushFeedback({ ok: true, msg: 'Device connected to background push bridge' })
          onPlaySound?.('tune')
        }
      })
    }

    const handleTestBackgroundPushClick = (fromTopBanner = false) => {
      if (testingBgPush) return
      setTestingBgPush(true)
      if (fromTopBanner) {
        setBgPushFeedback(null)
      } else {
        setNotifTestFeedback(null)
      }
      void notif
        .sendTestPush()
        .then((res) => {
          const feedback = res.ok
            ? { ok: true, msg: res.detail || 'Test background push sent' }
            : { ok: false, msg: res.detail || 'Could not send background push' }
          if (res.ok) onPlaySound?.('tune')
          if (fromTopBanner) {
            setBgPushFeedback(feedback)
          } else {
            setNotifTestFeedback(feedback)
          }
        })
        .finally(() => setTestingBgPush(false))
    }

    const handleTestRingtoneClick = () => {
      notif.testRingtone()
      setNotifTestFeedback({ ok: true, msg: 'Playing 3s incoming call ringtone preview…' })
    }

    return (
      <div className="ag-set-pane-stack">
        {/* 1. Notification Status Banner */}
        <div className={`ag-set-notif-banner state-${bannerState}`}>
          <div className="ag-set-notif-banner-head">
            <div className="ag-set-notif-banner-title-wrap">
              <span className="ag-set-notif-banner-icon" aria-hidden="true">
                {bannerState === 'ios-install' ? (
                  <Smartphone size={17} />
                ) : bannerState === 'denied' || bannerState === 'unsupported' ? (
                  <BellOff size={17} />
                ) : (
                  <BellRing size={17} />
                )}
              </span>
              <div className="ag-set-notif-banner-copy">
                <div className="ag-set-notif-banner-title-row">
                  <span className="ag-set-notif-banner-title">
                    {bannerState === 'ios-install'
                      ? 'Add to Home Screen for iOS Push'
                      : bannerState === 'denied'
                        ? 'Notifications Blocked'
                        : bannerState === 'unsupported'
                          ? 'Browser Alerts Unavailable'
                          : bannerState === 'granted'
                            ? 'Notifications Active'
                            : 'Enable Notifications'}
                  </span>
                  <span
                    className={`ag-badge ${
                      bannerState === 'granted'
                        ? ns.enabled
                          ? 'ag-badge-accent'
                          : 'ag-badge-muted'
                        : bannerState === 'denied'
                          ? 'ag-badge-danger'
                          : bannerState === 'ios-install'
                            ? 'ag-badge-warn'
                            : 'ag-badge-muted'
                    }`}
                  >
                    {bannerState === 'granted'
                      ? ns.enabled
                        ? 'Active'
                        : 'Paused'
                      : bannerState === 'denied'
                        ? 'Blocked'
                        : bannerState === 'ios-install'
                          ? 'iOS PWA'
                          : bannerState === 'unsupported'
                            ? 'Unsupported'
                            : 'Off'}
                  </span>
                  {bannerState === 'granted' && notif.pushStatus === 'connected' && (
                    <span className="ag-badge ag-badge-ok">Background Push</span>
                  )}
                </div>
                <p className="ag-set-notif-banner-desc">
                  {bannerState === 'ios-install'
                    ? 'Add Agnostr to your Home Screen via Share → Add to Home Screen to enable iPhone/iPad push notifications.'
                    : bannerState === 'denied'
                      ? 'Allow notifications for this site in your browser settings, then reload.'
                      : bannerState === 'unsupported'
                        ? 'This browser does not support OS alerts. In-app chimes and call ringing still work while open.'
                        : bannerState === 'granted'
                          ? 'Receive alerts for direct messages, mentions, mail, and incoming calls.'
                          : 'Get alerted for DMs, calls, mentions, and Agora activity even when backgrounded.'}
                </p>
              </div>
            </div>

            {bannerState === 'granted' && (
              <input
                type="checkbox"
                className="ag-switch"
                checked={ns.enabled}
                aria-label="Enable notifications"
                onChange={() => {
                  notif.updateSettings({ enabled: !ns.enabled })
                  if (ns.enabled) void notif.disconnectPushBridge({ keepAutomaticRegistration: true })
                  onPlaySound?.('click')
                }}
              />
            )}
          </div>

          {bannerState === 'granted' && notif.isPushSupported && notif.pushStatus !== 'connected' && (
            <>
              <div className="ag-set-notif-banner-actions">
                <button
                  type="button"
                  className="ag-btn ag-btn-primary ag-btn-sm"
                  disabled={notif.pushStatus === 'connecting'}
                  onClick={handleQuickConnectBackgroundPush}
                >
                  {notif.pushStatus === 'connecting' ? (
                    <Loader2 size={14} className="ag-spin" />
                  ) : (
                    <Server size={14} />
                  )}
                  <span>
                    {notif.pushStatus === 'connecting'
                      ? 'Connecting…'
                      : 'Connect Background Push'}
                  </span>
                </button>
              </div>

              {notif.pushError && (
                <p className="ag-field-hint ag-field-hint-danger" role="alert">
                  {notif.pushError}
                </p>
              )}
            </>
          )}

          {bgPushFeedback && notif.pushStatus === 'connected' && (
            <p
              className={`ag-field-hint ${
                bgPushFeedback.ok ? 'ag-field-hint-accent' : 'ag-field-hint-danger'
              }`}
              role="status"
            >
              {bgPushFeedback.msg}
            </p>
          )}

          {bannerState === 'default' && (
            <div className="ag-set-notif-banner-actions">
              <button
                type="button"
                className="ag-btn ag-btn-primary ag-btn-sm"
                disabled={requestingNotifPerm}
                onClick={handleEnableNotificationsClick}
              >
                {requestingNotifPerm ? (
                  <Loader2 size={14} className="ag-spin" />
                ) : (
                  <Bell size={14} />
                )}
                <span>{requestingNotifPerm ? 'Requesting…' : 'Enable Notifications'}</span>
              </button>
            </div>
          )}

          {bannerState === 'ios-install' && (
            <div className="ag-set-notif-banner-actions">
              <button
                type="button"
                className="ag-btn ag-btn-primary ag-btn-sm"
                onClick={() => {
                  onPlaySound?.('click')
                  onClose()
                  onOpenInstall()
                }}
              >
                <Download size={14} />
                <span>Install Guide</span>
              </button>
            </div>
          )}
        </div>

        {/* 2. Messages, Mail & Calls */}
        <SettingsSection
          title="Messages, Mail & Calls"
          description="Choose which conversations and calls trigger alerts."
          dimmed={!ns.enabled}
        >
          <div className="ag-set-card-list">
            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Direct Messages</span>
                <span className="ag-set-notif-row-desc">Encrypted 1-on-1 chats</span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={ns.dms}
                onChange={() => {
                  notif.updateSettings({ dms: !ns.dms })
                  onPlaySound?.('click')
                }}
              />
            </label>

            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Mentions &amp; Replies</span>
                <span className="ag-set-notif-row-desc">
                  Always notify when someone @mentions you or replies directly
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={ns.directPings}
                onChange={() => {
                  notif.updateSettings({ directPings: !ns.directPings })
                  onPlaySound?.('click')
                }}
              />
            </label>

            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Incoming DM Calls</span>
                <span className="ag-set-notif-row-desc">
                  Full-screen call ringer, chime, and vibration
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={ns.dmCallRinging}
                onChange={() => {
                  notif.updateSettings({ dmCallRinging: !ns.dmCallRinging })
                  onPlaySound?.('click')
                }}
              />
            </label>

            <div className="ag-set-notif-seg-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Group Messages</span>
                <span className="ag-set-notif-row-desc">Messages across your joined groups</span>
              </div>
              <div
                className="ag-segmented ag-set-notif-seg"
                role="group"
                aria-label="Group message notifications"
              >
                {NOTIF_FILTER_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    aria-pressed={ns.serverMessages === mode.id}
                    className={ns.serverMessages === mode.id ? 'active' : ''}
                    onClick={() => {
                      notif.updateSettings({ serverMessages: mode.id })
                      onPlaySound?.('click')
                    }}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Group &amp; Room Calls</span>
                <span className="ag-set-notif-row-desc">
                  Notify when peers start a call in a group or Bitchat room
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={ns.serverCalls}
                onChange={() => {
                  notif.updateSettings({ serverCalls: !ns.serverCalls })
                  onPlaySound?.('click')
                }}
              />
            </label>

            <div className="ag-set-notif-seg-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Bitchat</span>
                <span className="ag-set-notif-row-desc">
                  Activity in your tuned location or topic channel
                </span>
              </div>
              <div
                className="ag-segmented ag-set-notif-seg"
                role="group"
                aria-label="Bitchat notifications"
              >
                {NOTIF_FILTER_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    aria-pressed={ns.geoMessages === mode.id}
                    className={ns.geoMessages === mode.id ? 'active' : ''}
                    onClick={() => {
                      notif.updateSettings({ geoMessages: mode.id })
                      onPlaySound?.('click')
                    }}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Agmail Direct</span>
                <span className="ag-set-notif-row-desc">
                  Encrypted mail sent directly to you (To)
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={ns.agmail}
                onChange={() => {
                  notif.updateSettings({ agmail: !ns.agmail })
                  onPlaySound?.('click')
                }}
              />
            </label>

            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Agmail CC &amp; BCC</span>
                <span className="ag-set-notif-row-desc">
                  Encrypted mail where you are copied (CC / BCC)
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={ns.agmailCcBcc}
                onChange={() => {
                  notif.updateSettings({ agmailCcBcc: !ns.agmailCcBcc })
                  onPlaySound?.('click')
                }}
              />
            </label>
          </div>
        </SettingsSection>

        {/* 3. Agora */}
        <SettingsSection
          title="Agora"
          description="Alerts for interactions on your public posts and profile."
          dimmed={!ns.enabled}
        >
          <div className="ag-set-card-list">
            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Replies &amp; Mentions</span>
                <span className="ag-set-notif-row-desc">
                  Replies, quotes, and @mentions on your posts
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={ns.agoraRepliesMentions}
                onChange={() => {
                  notif.updateSettings({ agoraRepliesMentions: !ns.agoraRepliesMentions })
                  onPlaySound?.('click')
                }}
              />
            </label>

            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Likes &amp; Reposts</span>
                <span className="ag-set-notif-row-desc">Reactions and reposts on your posts</span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={ns.agoraReactionsReposts}
                onChange={() => {
                  notif.updateSettings({ agoraReactionsReposts: !ns.agoraReactionsReposts })
                  onPlaySound?.('click')
                }}
              />
            </label>

            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Zaps</span>
                <span className="ag-set-notif-row-desc">
                  Lightning and Cashu tips received on your posts
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={ns.agoraZaps}
                onChange={() => {
                  notif.updateSettings({ agoraZaps: !ns.agoraZaps })
                  onPlaySound?.('click')
                }}
              />
            </label>

            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">New Followers</span>
                <span className="ag-set-notif-row-desc">
                  Alerts when someone follows your Agora profile
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={ns.agoraFollows}
                onChange={() => {
                  notif.updateSettings({ agoraFollows: !ns.agoraFollows })
                  onPlaySound?.('click')
                }}
              />
            </label>
          </div>
        </SettingsSection>

        {/* 4. Sounds & Lock Screen */}
        <SettingsSection
          title="Sounds & Lock Screen"
          description="Control chimes, incoming call ringing, and preview visibility."
        >
          <div className="ag-set-card-list">
            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Message Chimes</span>
                <span className="ag-set-notif-row-desc">
                  Play a subtle chime when new messages arrive
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={ns.soundEnabled}
                onChange={() => {
                  notif.updateSettings({ soundEnabled: !ns.soundEnabled })
                  onPlaySound?.('click')
                }}
              />
            </label>

            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Call Ringtone &amp; Vibration</span>
                <span className="ag-set-notif-row-desc">
                  Looping ringtone and vibration on incoming DM calls
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={ringtoneAndVibe}
                onChange={() => {
                  const next = !ringtoneAndVibe
                  notif.updateSettings({ ringtoneEnabled: next, vibrationEnabled: next })
                  onPlaySound?.('click')
                }}
              />
            </label>

            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Show Message Previews</span>
                <span className="ag-set-notif-row-desc">
                  Turn off to hide message text on lock screens and banners
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={ns.showPreviews}
                onChange={() => {
                  notif.updateSettings({ showPreviews: !ns.showPreviews })
                  onPlaySound?.('click')
                }}
              />
            </label>
          </div>
        </SettingsSection>

        {/* 5. Collapsible Testing & Background Push */}
        <SettingsDisclosure
          icon={<Server size={15} />}
          title="Testing & Background Push"
          description="Preview alerts and configure the background push server."
          badge={<span className={`ag-badge ${pushStatusBadge.cls}`}>{pushStatusBadge.label}</span>}
          open={isAdvancedOpen}
          onToggle={() => {
            setNotifAdvancedOpen(!isAdvancedOpen)
            onPlaySound?.('click')
          }}
        >
          <div className="ag-set-disclosure-group">
            <span className="ag-set-field-label">Test Alerts</span>
            <div className="ag-set-notif-test-row">
              <button
                type="button"
                className="ag-btn ag-btn-secondary ag-btn-sm"
                disabled={
                  testingNotif ||
                  !notif.isSupported ||
                  notif.permission === 'denied' ||
                  notif.isIosRequiresInstall
                }
                onClick={handleTestNotificationClick}
              >
                {testingNotif ? <Loader2 size={14} className="ag-spin" /> : <Bell size={14} />}
                <span>Test Notification</span>
              </button>

              {notif.isPushSupported && (
                <button
                  type="button"
                  className="ag-btn ag-btn-secondary ag-btn-sm"
                  disabled={
                    testingBgPush ||
                    notif.pushStatus === 'connecting' ||
                    !notif.isSupported ||
                    notif.permission === 'denied' ||
                    notif.isIosRequiresInstall
                  }
                  onClick={() => handleTestBackgroundPushClick(false)}
                >
                  {testingBgPush ? (
                    <Loader2 size={14} className="ag-spin" />
                  ) : (
                    <BellRing size={14} />
                  )}
                  <span>Test Background Push</span>
                </button>
              )}

              <button
                type="button"
                className="ag-btn ag-btn-secondary ag-btn-sm"
                onClick={handleTestRingtoneClick}
              >
                <PhoneCall size={14} />
                <span>Test Call Ringtone</span>
              </button>
            </div>
            {notifTestFeedback && (
              <p
                className={`ag-field-hint ${
                  notifTestFeedback.ok ? 'ag-field-hint-accent' : 'ag-field-hint-danger'
                }`}
                role="status"
              >
                {notifTestFeedback.msg}
              </p>
            )}
          </div>

          <div className="ag-set-disclosure-divider" />

          <div className="ag-set-disclosure-group">
            <span className="ag-set-field-label">Background Push Bridge</span>
            <p className="ag-set-helper">
              Agnostr&apos;s built-in push bridge wakes this device while closed. Enter a custom
              server below only if you self-host your own bridge.
            </p>

            {notif.usesExternalPushSigner && (
              <label className="ag-set-notif-row">
                <div className="ag-set-notif-row-copy">
                  <span className="ag-set-notif-row-title">Sign Direct Push Requests</span>
                  <span className="ag-set-notif-row-desc">
                    Let your signer authorize background delivery hints when you send. It
                    may ask you to sign a separate request per message. The bridge receives
                    the signed delivery metadata. Reconnect this device manually if its
                    incoming push subscription changes.
                  </span>
                </div>
                <input
                  type="checkbox"
                  className="ag-switch"
                  checked={ns.extensionPushPokes}
                  onChange={() => notif.updateSettings({ extensionPushPokes: !ns.extensionPushPokes })}
                />
              </label>
            )}

            {!notif.usesExternalPushSigner && (
              <label className="ag-set-notif-row">
                <div className="ag-set-notif-row-copy">
                  <span className="ag-set-notif-row-title">Background Alerts for Pinned Public Bitchat Rooms</span>
                  <span className="ag-set-notif-row-desc">
                    Let the bridge monitor up to 12 pinned public Bitchat rooms for new messages.
                    Requires Bitchat alerts set to All, with no blocked peers or strict allowlist.
                    Private rooms and filter lists are not shared. Reopen Agnostr at least every
                    12 hours to keep this optional fallback active.
                  </span>
                </div>
                <input
                  type="checkbox"
                  className="ag-switch"
                  checked={ns.publicPinnedRoomFallback}
                  disabled={!notif.publicPinnedRoomFallbackAvailable && !ns.publicPinnedRoomFallback}
                  onChange={() =>
                    notif.updateSettings({ publicPinnedRoomFallback: !ns.publicPinnedRoomFallback })
                  }
                />
              </label>
            )}

            <form className="ag-set-subform" onSubmit={(e) => void handleConnectPushBridge(e)}>
              <input
                type="text"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                className="ag-input mono"
                placeholder={DEFAULT_PUSH_BRIDGE_URL}
                value={bridgeUrlDraft}
                onChange={(e) => {
                  setBridgeUrlDraft(e.target.value)
                  if (bridgeFeedback) setBridgeFeedback(null)
                }}
                aria-label="Push bridge URL"
              />
              <input
                type="text"
                autoComplete="off"
                className="ag-input mono"
                placeholder="Server public key (optional)"
                value={vapidKeyDraft}
                onChange={(e) => {
                  setVapidKeyDraft(e.target.value)
                  if (bridgeFeedback) setBridgeFeedback(null)
                }}
                aria-label="Push server public key"
              />
              <div className="ag-set-bridge-actions">
                <button
                  type="submit"
                  className="ag-btn ag-btn-primary ag-btn-sm"
                  disabled={
                    !bridgeUrlDraft.trim() ||
                    notif.pushStatus === 'connecting' ||
                    !notif.isPushSupported
                  }
                >
                  {notif.pushStatus === 'connecting' && (
                    <Loader2 size={13} className="ag-spin" />
                  )}
                  <span>
                    {notif.pushStatus === 'connecting'
                      ? 'Connecting…'
                      : notif.pushStatus === 'connected'
                        ? 'Reconnect Device'
                        : 'Connect Device'}
                  </span>
                </button>

                {(!notif.isUsingDefaultBridge ||
                  bridgeUrlDraft.trim().replace(/\/+$/, '') !== DEFAULT_PUSH_BRIDGE_URL) && (
                  <button
                    type="button"
                    className="ag-btn ag-btn-secondary ag-btn-sm"
                    disabled={notif.pushStatus === 'connecting'}
                    onClick={() => void handleUseBuiltinPushBridge()}
                  >
                    Use Built-in Bridge
                  </button>
                )}

                {(notif.pushStatus === 'connected' || notif.pushEndpoint) && (
                  <button
                    type="button"
                    className="ag-btn ag-btn-secondary ag-btn-sm"
                    onClick={() => void handleDisconnectPushBridge()}
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </form>

            {!notif.isPushSupported && (
              <p className="ag-field-hint ag-field-hint-warn">
                Web Push (PushManager) is unavailable in this browser context.
              </p>
            )}

            {notif.pushEndpoint && notif.pushStatus === 'connected' && (
              <p className="ag-set-bridge-endpoint mono truncate" title={notif.pushEndpoint}>
                Endpoint · {stripScheme(notif.pushEndpoint)}
              </p>
            )}

            {notif.pushError && (
              <p className="ag-field-hint ag-field-hint-danger">{notif.pushError}</p>
            )}

            {bridgeFeedback && !notif.pushError && (
              <p
                className={`ag-field-hint ${
                  bridgeFeedback.ok ? 'ag-field-hint-accent' : 'ag-field-hint-danger'
                }`}
              >
                {bridgeFeedback.msg}
              </p>
            )}
          </div>
        </SettingsDisclosure>
      </div>
    )
  }

  const renderPrivacyTab = () => (
    <div className="ag-set-pane-stack">
      {/* 1. Message & Link Protection */}
      <SettingsSection
        title="Message & Link Protection"
        description="Set default safety rules for messages, voice memos, and links."
      >
        <div className="ag-set-card-list">
          <label className="ag-set-notif-row">
            <div className="ag-set-notif-row-copy">
              <span className="ag-set-toggle-title">
                <ShieldCheck size={15} />
                <span>Trusted Peers Only</span>
              </span>
              <span className="ag-set-notif-row-desc">
                Hide text and voice memos from untrusted strangers. Images and calls always require
                trust.
              </span>
            </div>
            <input
              type="checkbox"
              className="ag-switch"
              checked={strictWhitelistMode}
              onChange={() => {
                engine.setStrictWhitelistMode(!strictWhitelistMode)
                onPlaySound?.('click')
              }}
            />
          </label>

          <label
            className={`ag-set-notif-row${strictWhitelistMode ? ' ag-set-dimmed' : ''}`}
          >
            <div className="ag-set-notif-row-copy">
              <span className="ag-set-toggle-title">
                <Mic size={15} />
                <span>Untrusted Voice Memos</span>
              </span>
              <span className="ag-set-notif-row-desc">
                Allow voice memos from anyone who isn&apos;t blocked. Turn off to require trust.
              </span>
            </div>
            <input
              type="checkbox"
              className="ag-switch"
              checked={engine.settings.allowUntrustedVoiceMemos && !strictWhitelistMode}
              disabled={strictWhitelistMode}
              onChange={() => {
                engine.setAllowUntrustedVoiceMemos(!engine.settings.allowUntrustedVoiceMemos)
                onPlaySound?.('click')
              }}
            />
          </label>

          <label className="ag-set-notif-row">
            <div className="ag-set-notif-row-copy">
              <span className="ag-set-toggle-title">
                <Link2 size={15} />
                <span>Warn Before Untrusted Links</span>
              </span>
              <span className="ag-set-notif-row-desc">
                Ask for confirmation before opening links sent by people you haven&apos;t trusted.
              </span>
            </div>
            <input
              type="checkbox"
              className="ag-switch"
              checked={!engine.settings.allowUntrustedLinks}
              onChange={() => {
                engine.updateSettings({ allowUntrustedLinks: !engine.settings.allowUntrustedLinks })
                onPlaySound?.('click')
              }}
            />
          </label>

          <label className="ag-set-notif-row">
            <div className="ag-set-notif-row-copy">
              <span className="ag-set-toggle-title">
                <Globe size={15} />
                <span>Share Agnostr Client Tag</span>
              </span>
              <span className="ag-set-notif-row-desc">
                Show an Agnostr ring on your avatar for peers. Turn off to blend in with other Nostr
                clients.
              </span>
            </div>
            <input
              type="checkbox"
              className="ag-switch"
              checked={broadcastClientTag}
              onChange={() => {
                engine.setBroadcastClientTag(!broadcastClientTag)
                onPlaySound?.('click')
              }}
            />
          </label>
        </div>
      </SettingsSection>

      {/* 2. Trusted Peers */}
      <SettingsSection
        title="Trusted Peers"
        description="People you trust can send you media, links, and calls directly."
        badge={<span className="ag-badge ag-badge-muted mono">{trustedPubkeys.length}</span>}
        action={
          <div className="ag-set-inline-actions">
            <button
              type="button"
              className={`ag-btn ag-btn-sm ${
                addTrustedOpen ? 'ag-btn-primary' : 'ag-btn-secondary'
              }`}
              onClick={() => {
                setAddTrustedOpen((v) => !v)
                setTrustFeedback(null)
                onPlaySound?.('click')
              }}
            >
              {addTrustedOpen ? <X size={13} /> : <Plus size={13} />}
              <span>{addTrustedOpen ? 'Cancel' : 'Add Peer'}</span>
            </button>
            {trustedPubkeys.length > 0 && (
              <button
                type="button"
                className="ag-btn ag-btn-ghost ag-btn-xs"
                onClick={() => {
                  engine.clearTrustedPubkeys()
                  onPlaySound?.('click')
                }}
              >
                <Trash2 size={12} />
                <span>Clear all</span>
              </button>
            )}
          </div>
        }
      >
        {addTrustedOpen && (
          <form className="ag-set-inline-card-form" onSubmit={handleAddTrusted}>
            <input
              type="text"
              className="ag-input mono"
              placeholder="Paste npub1… or 64-char hex pubkey"
              value={trustKeyDraft}
              onChange={(e) => {
                setTrustKeyDraft(e.target.value)
                if (trustFeedback) setTrustFeedback(null)
              }}
              aria-label="Trusted peer npub or hex key"
            />
            <div className="ag-set-inline-row">
              <input
                type="text"
                maxLength={28}
                className="ag-input"
                placeholder="Label (optional)"
                value={trustLabelDraft}
                onChange={(e) => setTrustLabelDraft(e.target.value)}
                aria-label="Optional label for trusted peer"
              />
              <button
                type="submit"
                className="ag-btn ag-btn-primary"
                disabled={!trustKeyDraft.trim()}
              >
                <Plus size={14} />
                <span>Trust</span>
              </button>
            </div>
            {trustFeedback && (
              <p
                className={`ag-field-hint ${
                  trustFeedback.ok ? 'ag-field-hint-ok' : 'ag-field-hint-danger'
                }`}
              >
                {trustFeedback.msg}
              </p>
            )}
          </form>
        )}

        {trustedPubkeys.length === 0 ? (
          <p className="ag-set-empty">
            No trusted peers yet. Trust someone from any chat or click Add Peer above.
          </p>
        ) : (
          <div className="ag-set-card-list" role="list">
            {trustedPubkeys.map((entry) => (
              <div key={entry.pubkey} role="listitem" className="ag-set-peer-row">
                <AvatarImg
                  pubkey={entry.pubkey}
                  pictureUrl={engine.getProfilePicture(entry.pubkey)}
                  alt=""
                  width={32}
                  height={32}
                  className="ag-set-avatar-sm"
                />
                <div className="ag-set-peer-copy">
                  <span
                    className="ag-set-peer-name truncate"
                    style={{ color: pubkeyToColor(entry.pubkey) }}
                  >
                    {entry.label ? `@${entry.label}` : shortPubkey(entry.pubkey, 8, 6)}
                  </span>
                  <span className="ag-set-row-sub mono truncate">
                    {shortPubkey(entry.npub, 12, 6)}
                  </span>
                </div>
                <button
                  type="button"
                  className="ag-btn ag-btn-secondary ag-btn-xs"
                  onClick={() => {
                    engine.untrustPubkey(entry.pubkey)
                    onPlaySound?.('click')
                  }}
                  aria-label={`Remove trust for ${entry.label || entry.npub}`}
                >
                  <X size={12} />
                  <span>Remove</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      {/* 3. Blocked Users */}
      <SettingsSection
        title="Blocked Users"
        description="Blocked accounts are hidden everywhere across chats, mail, calls, and Agora."
        badge={<span className="ag-badge ag-badge-muted mono">{blockedPubkeys.length}</span>}
      >
        {blockedPubkeys.length === 0 ? (
          <p className="ag-set-empty">No blocked users.</p>
        ) : (
          <div className="ag-set-card-list" role="list">
            {blockedPubkeys.map((pk) => {
              const pkLower = pk.toLowerCase()
              const savedName =
                engine.blockedPeerNames[pkLower]?.trim() ||
                engine.blockedPeerNames[pk]?.trim() ||
                ''
              const known = engine.getPeerByPubkey(pk)
              const knownHandle = known?.displayHandle?.trim() || ''
              const isGenericHandle =
                !knownHandle ||
                /^@?anon[0-9a-f]{4}(?:#[0-9a-f]{4})?$/i.test(knownHandle) ||
                /^[0-9a-f]{8,}$/i.test(knownHandle)
              const agoraProfile =
                engine.agora.getProfile(pkLower) ?? engine.agora.profilesByPubkey[pkLower]
              const agoraName =
                agoraProfile?.displayName?.trim() || agoraProfile?.name?.trim() || ''
              const label =
                savedName ||
                (!isGenericHandle ? knownHandle : '') ||
                agoraName ||
                knownHandle ||
                shortPubkey(pk, 10, 6)
              return (
                <div key={pk} role="listitem" className="ag-set-peer-row">
                  <AvatarImg
                    pubkey={pk}
                    pictureUrl={engine.getProfilePicture(pk)}
                    alt=""
                    width={32}
                    height={32}
                    className="ag-set-avatar-sm"
                  />
                  <div className="ag-set-peer-copy">
                    <span className="ag-set-peer-name truncate">{label}</span>
                    <span className="ag-set-row-sub mono truncate">{shortPubkey(pk, 10, 6)}</span>
                  </div>
                  <button
                    type="button"
                    className="ag-btn ag-btn-secondary ag-btn-xs"
                    onClick={() => {
                      engine.toggleBlockPeer(pk, label)
                      onPlaySound?.('click')
                    }}
                  >
                    <Ban size={12} />
                    <span>Unblock</span>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </SettingsSection>
    </div>
  )

  const renderContentFilterTab = () => {
    const cf = engine.contentFilter
    const cfs = cf.settings
    const isDownloading = cf.modelStatus === 'downloading'
    const canReloadModel = cf.modelStatus === 'idle' || cf.modelStatus === 'error'
    const pct = Math.max(0, Math.min(100, Math.round(cf.downloadProgress)))
    const isNsfwOff = !cfs.filterNsfw
    const isCfModelOpen = cfModelOpen ?? (isDownloading || cf.modelStatus === 'error')

    const statusBadge =
      cf.modelStatus === 'ready'
        ? {
            cls: 'ag-badge-accent',
            text:
              cf.runtimeDevice === 'webgpu'
                ? 'Ready · WebGPU'
                : cf.runtimeDevice === 'wasm'
                  ? 'Ready · WASM'
                  : 'Ready',
          }
        : isDownloading
          ? { cls: 'ag-badge-warn', text: pct > 0 ? `Loading ${pct}%` : 'Loading…' }
          : cf.modelStatus === 'error'
            ? { cls: 'ag-badge-danger', text: 'Error' }
            : { cls: 'ag-badge-muted', text: 'Not loaded' }

    const callVideoHint =
      cfs.callVideoMode === 'trusted-only'
        ? 'Untrusted peers stay blocked (zero call video) until you trust them.'
        : cfs.callVideoMode === 'screen-untrusted'
          ? 'Untrusted call video stays veiled until cleared by the on-device safety filter.'
          : 'All remote call video stays veiled until cleared, re-veiling automatically if flagged.'

    const handleRestoreNsfwProtection = () => {
      cf.updateSettings({ filterNsfw: true })
      onPlaySound?.('click')
    }

    return (
      <div className="ag-set-pane-stack">
        {/* Warning Callout ONLY when NSFW filter is turned off */}
        {isNsfwOff && (
          <div className="ag-set-cf-danger-banner" role="alert">
            <span className="ag-set-cf-danger-icon" aria-hidden="true">
              <ShieldAlert size={18} />
            </span>
            <div className="ag-set-cf-danger-body">
              <span className="ag-set-cf-danger-title">NSFW / explicit filter is off</span>
              <span className="ag-set-cf-danger-desc">
                Your device may show unscreened explicit images from public relays. Illegal &amp;
                gore (NSFL) protection always stays on.
              </span>
              <div className="ag-set-cf-danger-actions">
                <button
                  type="button"
                  className="ag-btn ag-btn-primary ag-btn-sm"
                  onClick={handleRestoreNsfwProtection}
                >
                  <ShieldCheck size={13} />
                  <span>Turn Back On</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 1. What's Filtered (FIRST) */}
        <SettingsSection
          title="What's Filtered"
          description="Screening runs 100% locally on your device — images are never sent to moderation servers."
        >
          <div className="ag-set-card-list">
            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">NSFW / Explicit Content</span>
                <span className="ag-set-notif-row-desc">
                  Veil sexually explicit images, nudity, and graphic adult media.
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={cfs.filterNsfw}
                onChange={() => {
                  onPlaySound?.('click')
                  if (cfs.filterNsfw) {
                    setPendingCfDisable('nsfw')
                  } else {
                    cf.updateSettings({ filterNsfw: true })
                  }
                }}
              />
            </label>

            <div className="ag-set-notif-row ag-set-row-locked">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Illegal &amp; Gore (NSFL)</span>
                <span className="ag-set-notif-row-desc">
                  Permanently blocks illegal imagery, extreme gore, and severe violence. Cannot be
                  disabled or revealed.
                </span>
              </div>
              <span
                className="ag-badge ag-badge-accent ag-set-locked-pill"
                aria-label="Illegal and gore protection is always on"
              >
                <Lock size={11} aria-hidden="true" />
                <span>Always on</span>
              </span>
            </div>
          </div>
        </SettingsSection>

        {/* 2. Where It Applies */}
        <SettingsSection
          title="Where It Applies"
          description="Choose how broadly to screen media in chats and video calls."
        >
          <div className="ag-set-card-list">
            <div className="ag-set-card-field">
              <div className="ag-set-label-row">
                <span className="ag-set-field-label">Chat Images &amp; Media</span>
                <span className="ag-set-scope-default">Default: Untrusted Only</span>
              </div>
              <div
                className="ag-segmented"
                role="group"
                aria-label="Chat images and media filter scope"
              >
                {MEDIA_SCOPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    aria-pressed={cfs.mediaScope === opt.id}
                    className={cfs.mediaScope === opt.id ? 'active' : ''}
                    onClick={() => {
                      onPlaySound?.('click')
                      cf.updateSettings({ mediaScope: opt.id })
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="ag-set-helper">
                Agora feeds always screen all images automatically.
              </p>
            </div>

            <div className="ag-set-card-field">
              <div className="ag-set-label-row">
                <span className="ag-set-field-label">Video Calls</span>
                <span className="ag-set-scope-default">Default: Trusted Only</span>
              </div>
              <div
                className="ag-segmented"
                role="group"
                aria-label="Video call screening mode"
              >
                {CALL_VIDEO_MODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    aria-pressed={cfs.callVideoMode === opt.id}
                    className={cfs.callVideoMode === opt.id ? 'active' : ''}
                    onClick={() => {
                      cf.updateSettings({ callVideoMode: opt.id })
                      onPlaySound?.('click')
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="ag-set-helper">{callVideoHint}</p>
            </div>
          </div>
        </SettingsSection>

        {/* 3. Collapsible On-Device Model & Test Tool */}
        <SettingsDisclosure
          icon={<Sparkles size={15} />}
          title="On-Device Model & Test Tool"
          description="Inspect the local classifier, clear cached verdicts, or test an image file."
          badge={<span className={`ag-badge ${statusBadge.cls}`}>{statusBadge.text}</span>}
          open={isCfModelOpen}
          onToggle={() => {
            setCfModelOpen(!isCfModelOpen)
            onPlaySound?.('click')
          }}
        >
          <div className="ag-set-ai-head">
            <div className="ag-set-ai-title-copy">
              <span className="ag-set-ai-title">{cf.modelLabel}</span>
              <span className="ag-set-ai-sub mono truncate">{cf.modelId}</span>
            </div>
            <span className="ag-set-row-sub">
              {cf.webGpuSupported ? 'WebGPU / WASM' : 'WASM'}
            </span>
          </div>

          {isDownloading && (
            <div className="ag-set-progress-wrap">
              <div className="ag-set-progress-track" aria-hidden="true">
                <span className="ag-set-progress-fill" style={{ width: `${pct}%` }} />
              </div>
              {cf.downloadFile && (
                <span className="ag-set-progress-file mono truncate">
                  {cf.downloadFile} · {pct}%
                </span>
              )}
            </div>
          )}

          {cf.modelError && (
            <p className="ag-field-hint ag-field-hint-danger" role="alert">
              {cf.modelError}
            </p>
          )}

          <div className="ag-set-ai-actions">
            {isDownloading ? (
              <>
                <button type="button" className="ag-btn ag-btn-primary ag-btn-sm" disabled>
                  <Loader2 size={13} className="ag-spin" />
                  <span>{pct > 0 ? `Loading ${pct}%` : 'Loading…'}</span>
                </button>

                <button
                  type="button"
                  className="ag-btn ag-btn-secondary ag-btn-sm"
                  onClick={() => {
                    setCfFeedback(null)
                    onPlaySound?.('click')
                    cf.cancelDownload()
                  }}
                  aria-label="Cancel content filter download"
                >
                  <X size={13} />
                  <span>Cancel</span>
                </button>
              </>
            ) : (
              canReloadModel && (
                <button
                  type="button"
                  className="ag-btn ag-btn-primary ag-btn-sm"
                  onClick={() => {
                    setCfFeedback(null)
                    onPlaySound?.('click')
                    void cf.preloadModel().then((ok) => {
                      if (ok) {
                        setCfFeedback({ ok: true, msg: `${cf.modelLabel} is ready locally` })
                      }
                    })
                  }}
                >
                  <RefreshCw size={13} />
                  <span>Reload Model</span>
                </button>
              )
            )}

            <button
              type="button"
              className="ag-btn ag-btn-secondary ag-btn-sm"
              disabled={isDownloading || cfClearingCache}
              onClick={() => void handleClearContentFilterCache()}
            >
              <Trash2 size={13} />
              <span>
                {cfClearingCache
                  ? 'Clearing…'
                  : cf.cachedVerdictCount > 0
                    ? `Clear Cache (${cf.cachedVerdictCount})`
                    : 'Clear Cache'}
              </span>
            </button>
          </div>

          {cfFeedback && (
            <p
              className={`ag-field-hint ${
                cfFeedback.ok ? 'ag-field-hint-accent' : 'ag-field-hint-danger'
              }`}
              role="status"
            >
              {cfFeedback.msg}
            </p>
          )}

          <div className="ag-set-disclosure-divider" />

          <div className="ag-set-disclosure-group">
            <span className="ag-set-field-label">Quick Test Image</span>
            <div className="ag-set-test-img-row">
              <input
                ref={cfFileInputRef}
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => void handleCfTestImageFile(e.target.files?.[0] ?? null)}
              />
              <button
                type="button"
                className="ag-btn ag-btn-secondary ag-btn-sm"
                disabled={cfTesting}
                onClick={() => cfFileInputRef.current?.click()}
              >
                {cfTesting ? <Loader2 size={13} className="ag-spin" /> : <ImageIcon size={13} />}
                <span>{cfTesting ? 'Screening…' : 'Test Image File…'}</span>
              </button>
              <span className="ag-set-helper">
                Evaluated locally using your active filter rules.
              </span>
            </div>

            {cfTestResult && (
              <div
                className={`ag-set-verdict-box ${
                  cfTestResult.status === 'flagged'
                    ? 'flagged'
                    : cfTestResult.status === 'error'
                      ? 'error'
                      : 'safe'
                }`}
                role="status"
              >
                <span className="ag-set-verdict-head">
                  {cfTestResult.status === 'flagged' ? (
                    <ShieldAlert size={14} />
                  ) : cfTestResult.status === 'error' ? (
                    <AlertTriangle size={14} />
                  ) : (
                    <ShieldCheck size={14} />
                  )}
                  <strong>
                    {cfTestResult.status === 'flagged'
                      ? `Flagged (${cfTestResult.categories
                          .map((c) => (c === 'nsfw' ? 'NSFW' : 'Illegal / Gore'))
                          .join(', ') || 'policy'})`
                      : cfTestResult.status === 'error'
                        ? 'Error'
                        : 'Safe'}
                  </strong>
                  {cfTestLabel && (
                    <span className="ag-set-verdict-label truncate">· {cfTestLabel}</span>
                  )}
                </span>
                {(cfTestResult.reason || cfTestResult.error) && (
                  <span className="ag-set-verdict-detail">
                    {cfTestResult.error || cfTestResult.reason}
                  </span>
                )}
              </div>
            )}
          </div>
        </SettingsDisclosure>
      </div>
    )
  }

  const renderTranslatorTab = () => {
    const tr = engine.translator
    const trs = tr.settings
    const isDownloading = tr.modelStatus === 'downloading'
    const pct = Math.max(0, Math.min(100, Math.round(tr.downloadProgress)))
    const cachedMb =
      tr.cachedModelBytes > 0 ? Math.max(1, Math.round(tr.cachedModelBytes / (1024 * 1024))) : 0
    const isModelOpen = translatorModelOpen ?? (isDownloading || tr.modelStatus === 'error')

    const statusBadge =
      tr.modelStatus === 'ready'
        ? {
            cls: 'ag-badge-accent',
            text:
              tr.runtimeDevice === 'webgpu'
                ? 'Ready · WebGPU'
                : tr.runtimeDevice === 'wasm'
                  ? 'Ready · WASM'
                  : 'Ready',
          }
        : isDownloading
          ? { cls: 'ag-badge-warn', text: `Loading ${pct}%` }
          : tr.modelStatus === 'error'
            ? { cls: 'ag-badge-danger', text: 'Error' }
            : tr.isModelCached
              ? { cls: 'ag-badge-accent', text: 'Cached' }
              : { cls: 'ag-badge-muted', text: 'On-demand' }

    const srcSelectVal =
      !trs.sourceLanguage || trs.sourceLanguage.toLowerCase() === 'auto'
        ? 'Auto'
        : SUPPORTED_TRANSLATION_LANGUAGES.includes(trs.sourceLanguage)
          ? trs.sourceLanguage
          : 'Auto'
    const mySelectVal =
      customMyLangMode || !SUPPORTED_TRANSLATION_LANGUAGES.includes(trs.myLanguage)
        ? '__custom__'
        : trs.myLanguage
    const outSelectVal =
      customOutLangMode || !SUPPORTED_TRANSLATION_LANGUAGES.includes(trs.outgoingLanguage)
        ? '__custom__'
        : trs.outgoingLanguage

    const activeModelMeta = TRANSLATOR_MODELS[trs.model] ?? TRANSLATOR_MODELS.opus
    const modelOptions: readonly TranslatorModelKey[] = ['opus', 'm2m100', 'nllb200']
    const modelSizeLabels: Record<TranslatorModelKey, string> = {
      opus: '~107 MB',
      m2m100: '~603 MB',
      nllb200: '~853 MB',
    }

    return (
      <div className="ag-set-pane-stack">
        {/* 1. Translation & Languages (FIRST) */}
        <SettingsSection
          title="Translation & Languages"
          description="Translate chat messages privately on your device."
        >
          <div className="ag-set-card-list">
            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-toggle-title">
                  <Languages size={15} />
                  <span>Translator Mode</span>
                </span>
                <span className="ag-set-notif-row-desc">
                  Display translated messages alongside the original chat column.
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={trs.enabled}
                onChange={() => {
                  tr.updateSettings({ enabled: !trs.enabled })
                  onPlaySound?.('click')
                }}
              />
            </label>

            <div className="ag-set-card-field">
              <div className="ag-set-two-col">
                <div className="ag-set-field-col">
                  <label className="ag-set-field-label" htmlFor="ag-set-src-lang">
                    Chat Source Language
                  </label>
                  <select
                    id="ag-set-src-lang"
                    className="ag-input ag-select"
                    value={srcSelectVal}
                    onChange={(e) => {
                      onPlaySound?.('click')
                      tr.updateSettings({ sourceLanguage: e.target.value })
                    }}
                  >
                    <option value="Auto">Auto-detect</option>
                    {TRANSLATION_LANGUAGE_OPTIONS.map((opt) => (
                      <option key={opt.code} value={opt.name}>
                        {opt.name} ({opt.nativeName})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="ag-set-field-col">
                  <label className="ag-set-field-label" htmlFor="ag-set-my-lang">
                    My Language
                  </label>
                  <select
                    id="ag-set-my-lang"
                    className="ag-input ag-select"
                    value={mySelectVal}
                    onChange={(e) => {
                      const v = e.target.value
                      onPlaySound?.('click')
                      if (v === '__custom__') {
                        setCustomMyLangMode(true)
                      } else {
                        setCustomMyLangMode(false)
                        tr.updateSettings({ myLanguage: v })
                      }
                    }}
                  >
                    {TRANSLATION_LANGUAGE_OPTIONS.map((opt) => (
                      <option key={opt.code} value={opt.name}>
                        {opt.name} ({opt.nativeName})
                      </option>
                    ))}
                    <option value="__custom__">Custom language…</option>
                  </select>

                  {mySelectVal === '__custom__' && (
                    <input
                      type="text"
                      maxLength={40}
                      className="ag-input"
                      value={trs.myLanguage}
                      onChange={(e) => tr.updateSettings({ myLanguage: e.target.value })}
                      placeholder="e.g. Swedish, Swahili, Latin"
                      aria-label="Custom reading language"
                    />
                  )}
                </div>
              </div>
            </div>

            <div className="ag-set-card-field">
              <label className="ag-set-inline-toggle">
                <div className="ag-set-notif-row-copy">
                  <span className="ag-set-notif-row-title">Translate Outgoing Messages</span>
                  <span className="ag-set-notif-row-desc">
                    Automatically translate messages you compose before sending.
                  </span>
                </div>
                <input
                  type="checkbox"
                  className="ag-switch"
                  checked={trs.outgoingEnabled}
                  onChange={() => {
                    tr.updateSettings({ outgoingEnabled: !trs.outgoingEnabled })
                    onPlaySound?.('click')
                  }}
                />
              </label>

              {trs.outgoingEnabled && (
                <div className="ag-set-sub-field">
                  <label className="ag-set-field-label" htmlFor="ag-set-out-lang">
                    Outgoing Language
                  </label>
                  <select
                    id="ag-set-out-lang"
                    className="ag-input ag-select"
                    value={outSelectVal}
                    onChange={(e) => {
                      const v = e.target.value
                      onPlaySound?.('click')
                      if (v === '__custom__') {
                        setCustomOutLangMode(true)
                      } else {
                        setCustomOutLangMode(false)
                        tr.updateSettings({ outgoingLanguage: v })
                      }
                    }}
                  >
                    {TRANSLATION_LANGUAGE_OPTIONS.map((opt) => (
                      <option key={opt.code} value={opt.name}>
                        {opt.name} ({opt.nativeName})
                      </option>
                    ))}
                    <option value="__custom__">Custom language…</option>
                  </select>

                  {outSelectVal === '__custom__' && (
                    <input
                      type="text"
                      maxLength={40}
                      className="ag-input"
                      value={trs.outgoingLanguage}
                      onChange={(e) => tr.updateSettings({ outgoingLanguage: e.target.value })}
                      placeholder="Enter target outgoing language"
                      aria-label="Custom outgoing language"
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </SettingsSection>

        {/* 2. Collapsible On-Device Model & Cache */}
        <SettingsDisclosure
          icon={<Sparkles size={15} />}
          title="On-Device Model & Cache"
          description="Choose a translation engine, preload weights, or clear cached data."
          badge={<span className={`ag-badge ${statusBadge.cls}`}>{statusBadge.text}</span>}
          open={isModelOpen}
          onToggle={() => {
            setTranslatorModelOpen(!isModelOpen)
            onPlaySound?.('click')
          }}
        >
          <div className="ag-set-disclosure-group">
            <div className="ag-set-label-row">
              <span className="ag-set-field-label">Translation Model</span>
              <span className="ag-set-scope-default">Default: Opus-MT</span>
            </div>
            <div
              className="ag-segmented ag-set-tri-seg"
              role="group"
              aria-label="Translation model"
            >
              {modelOptions.map((key) => {
                const opt = TRANSLATOR_MODELS[key]
                const active = trs.model === key
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={isDownloading}
                    aria-pressed={active}
                    className={active ? 'active' : ''}
                    onClick={() => {
                      if (active) return
                      setTrFeedback(null)
                      tr.updateSettings({ model: key })
                      onPlaySound?.('click')
                    }}
                  >
                    <span>{opt.shortLabel}</span>
                    <span className="ag-set-seg-sub">{modelSizeLabels[key]}</span>
                  </button>
                )
              })}
            </div>
            <p className="ag-set-helper">{activeModelMeta.description}</p>
          </div>

          <div className="ag-set-disclosure-divider" />

          <div className="ag-set-ai-head">
            <div className="ag-set-ai-title-copy">
              <span className="ag-set-ai-title">{tr.modelLabel}</span>
              <span className="ag-set-ai-sub mono truncate">{tr.modelId}</span>
            </div>
            {(cachedMb > 0 || tr.storagePersisted) && (
              <span className="ag-set-row-sub">
                {[
                  cachedMb > 0 ? `${cachedMb} MB saved` : null,
                  tr.storagePersisted ? 'Persistent' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
          </div>

          {isDownloading && (
            <div className="ag-set-progress-wrap">
              <div className="ag-set-progress-track" aria-hidden="true">
                <span className="ag-set-progress-fill" style={{ width: `${pct}%` }} />
              </div>
              {tr.downloadFile && (
                <span className="ag-set-progress-file mono truncate">
                  {tr.downloadFile} · {pct}%
                </span>
              )}
            </div>
          )}

          {tr.modelError && (
            <p className="ag-field-hint ag-field-hint-danger" role="alert">
              {tr.modelError}
            </p>
          )}

          <div className="ag-set-ai-actions">
            <button
              type="button"
              className="ag-btn ag-btn-primary ag-btn-sm"
              disabled={isDownloading}
              onClick={() => {
                setTrFeedback(null)
                onPlaySound?.('click')
                void tr.preloadModel().then((ok) => {
                  if (ok) {
                    setTrFeedback({ ok: true, msg: `${tr.modelLabel} is ready locally` })
                  }
                })
              }}
            >
              {isDownloading ? (
                <Loader2 size={13} className="ag-spin" />
              ) : tr.modelStatus === 'ready' ? (
                <Check size={13} />
              ) : (
                <Download size={13} />
              )}
              <span>
                {isDownloading
                  ? `Loading ${pct}%`
                  : tr.modelStatus === 'ready'
                    ? 'Model Ready'
                    : tr.isModelCached && tr.modelStatus === 'idle'
                      ? 'Load Cached Model'
                      : 'Preload Model'}
              </span>
            </button>

            {isDownloading && (
              <button
                type="button"
                className="ag-btn ag-btn-secondary ag-btn-sm"
                onClick={() => {
                  setTrFeedback(null)
                  onPlaySound?.('click')
                  tr.cancelDownload()
                }}
                aria-label="Cancel translation model download"
              >
                <X size={13} />
                <span>Cancel</span>
              </button>
            )}

            <button
              type="button"
              className="ag-btn ag-btn-secondary ag-btn-sm"
              disabled={isDownloading || trClearingCache}
              onClick={() => void handleClearTranslatorModelCache()}
            >
              <Trash2 size={13} />
              <span>
                {trClearingCache
                  ? 'Clearing…'
                  : cachedMb > 0
                    ? `Clear Model Cache (${cachedMb} MB)`
                    : 'Clear Model Cache'}
              </span>
            </button>

            <button
              type="button"
              className="ag-btn ag-btn-secondary ag-btn-sm"
              disabled={tr.cachedTranslationCount === 0}
              onClick={() => {
                tr.clearTranslationCache()
                onPlaySound?.('click')
                setTrFeedback({ ok: true, msg: 'Cleared cached message translations' })
              }}
            >
              <Trash2 size={13} />
              <span>Clear Translations ({tr.cachedTranslationCount})</span>
            </button>
          </div>

          {trFeedback && (
            <p
              className={`ag-field-hint ${
                trFeedback.ok ? 'ag-field-hint-accent' : 'ag-field-hint-danger'
              }`}
              role="status"
            >
              {trFeedback.msg}
            </p>
          )}
        </SettingsDisclosure>
      </div>
    )
  }

  const renderAppearanceTab = () => (
    <div className="ag-set-pane-stack">
      {/* 1. Color Theme */}
      <SettingsSection
        title="Color Theme"
        description="Choose a dark or light palette across all apps."
      >
        <div className="ag-set-theme-grid" role="group" aria-label="Choose color theme">
          {THEME_CARDS.map((t) => {
            const active = settings.theme === t.id
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={active}
                className={`ag-set-theme-card ${active ? 'active' : ''}`}
                onClick={() => {
                  engine.setTheme(t.id)
                  onPlaySound?.('click')
                }}
              >
                <div className="ag-set-theme-swatch" style={{ backgroundColor: t.bg }}>
                  <span className="ag-set-swatch-rail" style={{ backgroundColor: t.surface }}>
                    <span className="ag-set-swatch-pill" style={{ backgroundColor: t.accent }} />
                    <span className="ag-set-swatch-line" style={{ backgroundColor: t.elevated }} />
                  </span>
                  <span className="ag-set-swatch-stream">
                    <span className="ag-set-swatch-row" style={{ backgroundColor: t.elevated }} />
                    <span
                      className="ag-set-swatch-row short"
                      style={{ backgroundColor: t.elevated }}
                    />
                  </span>
                </div>
                <div className="ag-set-theme-info">
                  <span className="ag-set-theme-name">{t.name}</span>
                  <span className="ag-set-theme-tag">{t.tagline}</span>
                </div>
                {active && (
                  <span className="ag-set-theme-check" aria-hidden="true">
                    <Check size={14} />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </SettingsSection>

      {/* 2. Audio */}
      <SettingsSection
        title="Audio"
        description="Tactile feedback cues as you navigate and chat."
      >
        <div className="ag-set-card-list">
          <label className="ag-set-notif-row">
            <div className="ag-set-notif-row-copy">
              <span className="ag-set-toggle-title">
                {settings.soundEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
                <span>Sound Effects</span>
              </span>
              <span className="ag-set-notif-row-desc">
                Play subtle chimes for incoming messages, calls, and switching channels.
              </span>
            </div>
            <input
              type="checkbox"
              className="ag-switch"
              checked={settings.soundEnabled}
              onChange={() => {
                const next = !settings.soundEnabled
                engine.updateSettings({ soundEnabled: next })
                bitchatAudio.setEnabled(next)
                if (next) {
                  bitchatAudio.play('tune', true)
                }
              }}
            />
          </label>
        </div>
      </SettingsSection>
    </div>
  )

  const renderCallsTab = () => {
    const recSpec = getRecordingQualitySpec(engine.calls.recordingQuality)
    const { transcription } = engine
    const isDownloadingModel = transcription.modelStatus === 'downloading'
    const isSpeechModelsOpen =
      speechModelsOpen ?? (isDownloadingModel || transcription.modelStatus === 'error')

    const statusBadge =
      transcription.modelStatus === 'ready'
        ? {
            cls: 'ag-badge-accent',
            text:
              transcription.runtimeDevice === 'webgpu'
                ? 'Ready · WebGPU'
                : transcription.runtimeDevice === 'wasm'
                  ? 'Ready · WASM'
                  : 'Ready',
          }
        : transcription.modelStatus === 'downloading'
          ? {
              cls: 'ag-badge-warn',
              text: `Loading ${Math.round(transcription.downloadProgress)}%`,
            }
          : transcription.modelStatus === 'error'
            ? { cls: 'ag-badge-danger', text: 'Error' }
            : { cls: 'ag-badge-muted', text: 'On-demand' }

    return (
      <div className="ag-set-pane-stack">
        {/* 1. Recording & Captions (FIRST) */}
        <SettingsSection
          title="Recording & Captions"
          description="Set call recording quality and automatic on-device speech captions."
        >
          <div className="ag-set-card-list">
            <div className="ag-set-card-field">
              <div className="ag-set-label-row">
                <span className="ag-set-field-label">Recording Quality</span>
                <span className="ag-badge ag-badge-accent mono">{recSpec.shortLabel}</span>
              </div>

              <div
                className="ag-segmented ag-rec-quality-seg"
                role="group"
                aria-label="Call recording quality preset"
              >
                {RECORDING_QUALITY_PRESETS.map((preset) => {
                  const active = engine.calls.recordingQuality === preset.id
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      aria-pressed={active}
                      className={active ? 'active' : ''}
                      onClick={() => {
                        engine.calls.setRecordingQuality(preset.id)
                        onPlaySound?.('click')
                      }}
                    >
                      {preset.label}
                    </button>
                  )
                })}
              </div>

              <p className="ag-rec-quality-spec mono">
                {recSpec.width}×{recSpec.height} · {recSpec.fps}fps · {recSpec.approxMbPerMin}
                {engine.calls.activeCall?.localRecording ? ' · applies to next recording' : ''}
              </p>
            </div>

            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <div className="ag-set-inline-title-badge">
                  <span className="ag-set-toggle-title">
                    <Captions size={15} />
                    <span>Automatic Transcription &amp; Live Captions</span>
                  </span>
                  <span className={`ag-badge ${statusBadge.cls}`}>{statusBadge.text}</span>
                </div>
                <span className="ag-set-notif-row-desc">
                  Auto-transcribe voice memos and enable live captions (CC) 100% locally in your
                  browser.
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                checked={transcription.autoTranscribe}
                onChange={() => {
                  transcription.setAutoTranscribe(!transcription.autoTranscribe)
                  onPlaySound?.('click')
                }}
              />
            </label>
          </div>
        </SettingsSection>

        {/* 2. Collapsible Speech Models & Cache */}
        <SettingsDisclosure
          icon={<Mic size={15} />}
          title="Speech Models & Cache"
          description="Pick Whisper or Parakeet models, preload weights, or clear caches."
          badge={<span className={`ag-badge ${statusBadge.cls}`}>{statusBadge.text}</span>}
          open={isSpeechModelsOpen}
          onToggle={() => {
            setSpeechModelsOpen(!isSpeechModelsOpen)
            onPlaySound?.('click')
          }}
        >
          <div
            className="ag-set-model-list"
            role="group"
            aria-label="Local speech transcription model"
          >
            {transcription.models.map((model) => {
              const selected = model.id === transcription.activeModelId
              const isDefault = model.id === DEFAULT_TRANSCRIPTION_MODEL_ID
              const isParakeet = model.engine === 'parakeet'
              return (
                <div key={model.id} className={`ag-set-model-row ${selected ? 'active' : ''}`}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    className="ag-set-model-main"
                    onClick={() => {
                      transcription.setActiveModelId(model.id)
                      setModelFeedback(null)
                      onPlaySound?.('click')
                    }}
                  >
                    <span className={`ag-set-model-choice ${selected ? 'checked' : ''}`}>
                      {selected && <Check size={11} />}
                    </span>
                    <span className="ag-set-model-copy">
                      <span className="ag-set-model-title-row">
                        <span className="ag-set-model-name-wrap">
                          <span className="ag-set-model-name truncate">{model.label}</span>
                          {isDefault && <span className="ag-badge ag-badge-accent">Default</span>}
                          {isParakeet && (
                            <span className="ag-badge ag-badge-muted">Desktop WebGPU</span>
                          )}
                        </span>
                        <span className="ag-set-model-meta mono">
                          {model.sizeHint} · {model.languages}
                        </span>
                      </span>
                      {model.description && (
                        <span className="ag-set-model-desc">{model.description}</span>
                      )}
                      <span className="ag-set-model-repo mono truncate" title={model.hfModelId}>
                        {model.hfModelId}
                      </span>
                    </span>
                  </button>

                  {!model.isBuiltIn && (
                    <button
                      type="button"
                      className="ag-icon-btn-xs ag-icon-btn-danger"
                      onClick={() => {
                        transcription.removeCustomModel(model.id)
                        onPlaySound?.('click')
                      }}
                      title={`Remove ${model.label}`}
                      aria-label={`Remove ${model.label}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {isDownloadingModel && (
            <div
              className="ag-set-progress-wrap"
              role="progressbar"
              aria-valuenow={Math.round(transcription.downloadProgress)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="ag-set-progress-head mono">
                <span className="truncate">
                  {transcription.downloadFile
                    ? `Downloading ${transcription.downloadFile}`
                    : `Loading ${transcription.activeModel.label}…`}
                </span>
                <span>{Math.round(transcription.downloadProgress)}%</span>
              </div>
              <div className="ag-set-progress-track">
                <span
                  className="ag-set-progress-fill"
                  style={{
                    width: `${Math.max(4, Math.min(100, transcription.downloadProgress))}%`,
                  }}
                />
              </div>
            </div>
          )}

          {transcription.modelStatus === 'error' && transcription.modelError && (
            <p className="ag-field-hint ag-field-hint-danger">{transcription.modelError}</p>
          )}

          <div className="ag-set-model-actions">
            <button
              type="button"
              className="ag-btn ag-btn-primary ag-btn-sm"
              disabled={isDownloadingModel}
              onClick={() => {
                onPlaySound?.('click')
                setModelFeedback(null)
                void transcription.preloadModel()
              }}
            >
              {isDownloadingModel ? (
                <Loader2 size={13} className="ag-spin" />
              ) : (
                <Download size={13} />
              )}
              <span>
                {isDownloadingModel
                  ? `Loading ${Math.round(transcription.downloadProgress)}%`
                  : transcription.modelStatus === 'ready'
                    ? 'Model Ready'
                    : 'Preload Model'}
              </span>
            </button>

            {isDownloadingModel && (
              <button
                type="button"
                className="ag-btn ag-btn-secondary ag-btn-sm"
                onClick={() => {
                  setModelFeedback(null)
                  onPlaySound?.('click')
                  transcription.cancelDownload()
                }}
                aria-label="Cancel transcription model download"
              >
                <X size={13} />
                <span>Cancel</span>
              </button>
            )}

            <button
              type="button"
              className="ag-btn ag-btn-secondary ag-btn-sm"
              disabled={isDownloadingModel || clearingModelCache}
              onClick={() => void handleClearModelCache()}
            >
              <Trash2 size={13} />
              <span>{clearingModelCache ? 'Clearing…' : 'Clear Model Cache'}</span>
            </button>

            <button
              type="button"
              className="ag-btn ag-btn-secondary ag-btn-sm"
              disabled={transcription.cachedTranscriptCount === 0}
              onClick={() => {
                transcription.clearTranscriptCache()
                onPlaySound?.('click')
                setModelFeedback({
                  ok: true,
                  msg: 'Cleared cached voice memo transcripts',
                })
              }}
              title="Clear locally cached voice memo transcripts"
            >
              <Trash2 size={13} />
              <span>Clear Transcript Cache ({transcription.cachedTranscriptCount})</span>
            </button>

            <button
              type="button"
              className="ag-btn ag-btn-ghost ag-btn-sm"
              onClick={() => {
                setShowAddModel((v) => !v)
                setModelFeedback(null)
              }}
            >
              {showAddModel ? <X size={13} /> : <Plus size={13} />}
              <span>{showAddModel ? 'Cancel' : 'Add Custom Model'}</span>
            </button>
          </div>

          {showAddModel && (
            <form className="ag-set-subform" onSubmit={handleAddTranscriptionModel}>
              <input
                type="text"
                className="ag-input mono"
                placeholder="Hugging Face ONNX repo (e.g. onnx-community/whisper-tiny.en)"
                value={modelIdDraft}
                onChange={(e) => {
                  setModelIdDraft(e.target.value)
                  if (modelFeedback) setModelFeedback(null)
                }}
                aria-label="Hugging Face ONNX model ID"
              />
              <div className="ag-set-inline-row">
                <input
                  type="text"
                  maxLength={32}
                  className="ag-input"
                  placeholder="Display label (optional)"
                  value={modelLabelDraft}
                  onChange={(e) => setModelLabelDraft(e.target.value)}
                  aria-label="Custom model display label"
                />
                <button
                  type="submit"
                  className="ag-btn ag-btn-primary ag-btn-sm"
                  disabled={!modelIdDraft.trim()}
                >
                  Add
                </button>
              </div>
            </form>
          )}

          {modelFeedback && (
            <p
              className={`ag-field-hint ${
                modelFeedback.ok ? 'ag-field-hint-ok' : 'ag-field-hint-danger'
              }`}
            >
              {modelFeedback.msg}
            </p>
          )}
        </SettingsDisclosure>

        {/* 3. Collapsible Custom Call Relay (TURN) */}
        <SettingsDisclosure
          icon={<Server size={15} />}
          title="Custom Call Relay (TURN)"
          description="Only needed behind strict corporate or mobile firewalls."
          badge={
            <span
              className={`ag-badge ${engine.calls.turnConfig ? 'ag-badge-ok' : 'ag-badge-muted'}`}
            >
              {engine.calls.turnConfig ? 'Custom TURN' : 'Default STUN'}
            </span>
          }
          open={turnDisclosureOpen}
          onToggle={() => {
            setTurnDisclosureOpen((v) => !v)
            onPlaySound?.('click')
          }}
        >
          <p className="ag-set-helper">
            Calls connect directly peer-to-peer by default and share your IP with call participants.
            Add a custom TURN server only if your firewall blocks direct connections.
          </p>

          <form className="ag-turn-form" onSubmit={handleSaveTurn}>
            <input
              type="text"
              className="ag-input mono"
              placeholder="turns:turn.example.com:5349"
              value={turnUrlDraft}
              onChange={(e) => {
                setTurnUrlDraft(e.target.value)
                if (turnFeedback) setTurnFeedback(null)
              }}
              aria-label="TURN server URL"
            />
            <div className="ag-turn-cred-row">
              <input
                type="text"
                autoComplete="off"
                className="ag-input"
                placeholder="Username (optional)"
                value={turnUserDraft}
                onChange={(e) => {
                  setTurnUserDraft(e.target.value)
                  if (turnFeedback) setTurnFeedback(null)
                }}
                aria-label="TURN username"
              />
              <input
                type="password"
                autoComplete="new-password"
                className="ag-input"
                placeholder="Credential (optional)"
                value={turnCredDraft}
                onChange={(e) => {
                  setTurnCredDraft(e.target.value)
                  if (turnFeedback) setTurnFeedback(null)
                }}
                aria-label="TURN credential"
              />
            </div>
            <div className="ag-turn-actions">
              <button
                type="submit"
                className="ag-btn ag-btn-primary ag-btn-sm"
                disabled={!turnUrlDraft.trim()}
              >
                Save TURN
              </button>
              {engine.calls.turnConfig && (
                <button
                  type="button"
                  className="ag-btn ag-btn-secondary ag-btn-sm"
                  onClick={handleClearTurn}
                >
                  <Trash2 size={13} />
                  <span>Clear</span>
                </button>
              )}
            </div>
            {turnFeedback && (
              <p
                className={`ag-field-hint ${
                  turnFeedback.ok ? 'ag-field-hint-ok' : 'ag-field-hint-danger'
                }`}
              >
                {turnFeedback.msg}
              </p>
            )}
          </form>
        </SettingsDisclosure>
      </div>
    )
  }

  const renderNetworkTab = () => (
    <div className="ag-set-pane-stack">
      {/* 1. App & Updates (FIRST) */}
      <SettingsSection
        title="App & Updates"
        description="Install as a standalone app and keep offline support up to date."
        badge={
          <span
            className={`ag-badge ${
              pwa.isInstalled
                ? 'ag-badge-ok'
                : pwa.canPromptInstall
                  ? 'ag-badge-accent'
                  : 'ag-badge-muted'
            }`}
          >
            {pwa.isInstalled ? 'Installed' : pwa.canPromptInstall ? 'Installable' : 'Web App'}
          </span>
        }
      >
        <div className="ag-set-pwa-box">
          <div className="ag-set-pwa-status">
            <span
              className={`ag-led ${
                pwa.isOffline
                  ? 'ag-led-warn'
                  : pwa.offlineReady || pwa.swReady
                    ? 'ag-led-ok'
                    : 'ag-led-muted'
              }`}
            />
            <span>
              {pwa.isOffline
                ? 'Offline · Cached'
                : pwa.offlineReady || pwa.swReady
                  ? 'Offline ready'
                  : 'Preparing offline cache…'}
            </span>
            {updateCheckNote && <span className="ag-set-row-sub">· {updateCheckNote}</span>}
          </div>

          <div className="ag-set-pwa-actions">
            {!pwa.isInstalled && (
              <button
                type="button"
                className="ag-btn ag-btn-primary ag-btn-sm"
                onClick={() => {
                  onPlaySound?.('click')
                  onClose()
                  onOpenInstall()
                }}
              >
                <Download size={14} />
                <span>Install App</span>
              </button>
            )}

            {pwa.updateAvailable ? (
              <button
                type="button"
                className="ag-btn ag-btn-primary ag-btn-sm"
                onClick={() => {
                  onPlaySound?.('tune')
                  void pwa.applyUpdate()
                }}
              >
                <RefreshCw size={14} />
                <span>Update &amp; Reload</span>
              </button>
            ) : (
              <button
                type="button"
                className="ag-btn ag-btn-secondary ag-btn-sm"
                disabled={pwa.checkingUpdate || pwa.isOffline}
                onClick={async () => {
                  onPlaySound?.('click')
                  setUpdateCheckNote(null)
                  const found = await pwa.checkForUpdates()
                  setUpdateCheckNote(found ? 'Update ready' : 'Up to date')
                  window.setTimeout(() => setUpdateCheckNote(null), 3000)
                }}
              >
                {pwa.checkingUpdate ? (
                  <Loader2 size={14} className="ag-spin" />
                ) : (
                  <RefreshCw size={14} />
                )}
                <span>{pwa.checkingUpdate ? 'Checking…' : 'Check for Updates'}</span>
              </button>
            )}
          </div>
        </div>
      </SettingsSection>

      {/* 2. Nostr Relays */}
      <SettingsSection
        title="Nostr Relays"
        description="Servers that carry your messages, mail, and Agora feed."
        badge={
          <span className="ag-badge ag-badge-muted mono">
            {connectedRelayCount}/{totalRelayCount}
          </span>
        }
        action={
          <div className="ag-set-inline-actions">
            <button
              type="button"
              className="ag-btn ag-btn-ghost ag-btn-xs"
              onClick={() => {
                setReconnecting(true)
                onPlaySound?.('tune')
                engine.reconnectRelays()
                window.setTimeout(() => setReconnecting(false), 750)
              }}
            >
              <RefreshCw size={12} className={reconnecting ? 'ag-spin' : ''} />
              <span>Reconnect</span>
            </button>
            {customRelays.length > 0 && (
              <button
                type="button"
                className="ag-btn ag-btn-ghost ag-btn-xs"
                onClick={() => {
                  engine.resetCustomRelays()
                  onPlaySound?.('click')
                }}
              >
                <RotateCcw size={12} />
                <span>Reset</span>
              </button>
            )}
          </div>
        }
      >
        <div className="ag-set-card-list ag-set-scroll-list" role="list">
          {sortedRelays.map((r) => {
            const isCustom = r.roles.includes('custom') || customRelaySet.has(r.url)
            const dotClass =
              r.status === 'connected'
                ? 'ag-led-ok'
                : r.status === 'connecting' || r.status === 'degraded'
                  ? 'ag-led-warn'
                  : 'ag-led-muted'
            return (
              <div key={r.url} role="listitem" className="ag-set-simple-row">
                <span className={`ag-led ${dotClass}`} />
                <span className="ag-set-host mono truncate" title={r.url}>
                  {stripScheme(r.url)}
                </span>
                {isCustom && (
                  <button
                    type="button"
                    className="ag-icon-btn-xs ag-icon-btn-danger"
                    onClick={() => {
                      engine.removeCustomRelay(r.url)
                      onPlaySound?.('click')
                    }}
                    aria-label={`Remove ${r.url}`}
                    title="Remove custom relay"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            )
          })}
        </div>

        <form className="ag-set-inline-row" onSubmit={handleAddRelay}>
          <input
            type="text"
            className="ag-input mono"
            placeholder="wss://relay.example.com"
            value={relayDraft}
            onChange={(e) => {
              setRelayDraft(e.target.value)
              if (relayError) setRelayError(null)
            }}
            aria-label="Add custom relay URL"
          />
          <button
            type="submit"
            className="ag-btn ag-btn-secondary"
            disabled={!relayDraft.trim()}
            aria-label="Add relay"
          >
            <Plus size={15} />
            <span>Add</span>
          </button>
        </form>
        {relayError && <p className="ag-field-hint ag-field-hint-danger">{relayError}</p>}
      </SettingsSection>

      {/* 3. Media Storage (Blossom) */}
      <SettingsSection
        title="Media Storage (Blossom)"
        description="DM and private group media are encrypted on your device before upload."
        action={
          <button
            type="button"
            className="ag-btn ag-btn-ghost ag-btn-xs"
            onClick={() => {
              engine.resetBlossomServers()
              setBlossomError(null)
              onPlaySound?.('click')
            }}
          >
            <RotateCcw size={12} />
            <span>Reset</span>
          </button>
        }
      >
        {blossomServers.length > 0 && (
          <div className="ag-set-card-list" role="list">
            {blossomServers.map((url, idx) => (
              <div key={url} role="listitem" className="ag-set-simple-row">
                <Lock size={12} className="ag-set-row-icon-muted" aria-hidden="true" />
                <span className="ag-set-host mono truncate" title={url}>
                  {stripScheme(url)}
                </span>
                {idx === 0 && <span className="ag-badge ag-badge-accent">Primary</span>}
                <button
                  type="button"
                  className="ag-icon-btn-xs ag-icon-btn-danger"
                  onClick={() => {
                    engine.removeBlossomServer(url)
                    onPlaySound?.('click')
                  }}
                  aria-label={`Remove ${url}`}
                  title="Remove Blossom server"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <form className="ag-set-inline-row" onSubmit={handleAddBlossom}>
          <input
            type="text"
            className="ag-input mono"
            placeholder="https://blossom.example.com"
            value={blossomDraft}
            onChange={(e) => {
              setBlossomDraft(e.target.value)
              if (blossomError) setBlossomError(null)
            }}
            aria-label="Add custom Blossom server URL"
          />
          <button
            type="submit"
            className="ag-btn ag-btn-secondary"
            disabled={!blossomDraft.trim()}
            aria-label="Add Blossom server"
          >
            <Plus size={15} />
            <span>Add</span>
          </button>
        </form>
        {blossomError && <p className="ag-field-hint ag-field-hint-danger">{blossomError}</p>}
      </SettingsSection>

      {/* 4. Danger Zone */}
      <SettingsSection title="Danger Zone">
        <div className="ag-set-danger-box">
          <div className="ag-set-danger-head">
            <AlertTriangle size={15} />
            <span>Emergency Panic Wipe</span>
          </div>
          <p className="ag-set-helper">
            Hold for 1.5 seconds to erase all local data on this device and generate a fresh
            identity.
          </p>
          <button
            type="button"
            className={`ag-panic-btn ${panicHolding ? 'holding' : ''} ${justWiped ? 'wiped' : ''}`}
            onPointerDown={startPanicHold}
            onPointerUp={cancelPanicHold}
            onPointerLeave={cancelPanicHold}
            onPointerCancel={cancelPanicHold}
            onKeyDown={handlePanicKeyDown}
            onKeyUp={handlePanicKeyUp}
            onBlur={cancelPanicHold}
            aria-label="Hold to confirm Panic Wipe"
          >
            <span
              className="ag-panic-fill"
              style={{ transform: `scaleX(${panicProgress / 100})` }}
              aria-hidden="true"
            />
            <span className="ag-panic-label">
              <Flame size={15} />
              <span>
                {justWiped
                  ? 'Wiped & rotated'
                  : panicHolding
                    ? `Hold to erase… ${Math.round(panicProgress)}%`
                    : 'Hold to Panic Wipe'}
              </span>
            </span>
          </button>
        </div>
      </SettingsSection>
    </div>
  )

  return (
    <div
      className={`ag-modal-backdrop ag-set-backdrop ${inShell ? 'in-shell' : ''}`}
      onClick={onClose}
      role="presentation"
      data-no-swipe="true"
    >
      <div
        className={`ag-settings-modal ${mobileScreen === 'detail' ? 'mobile-detail' : 'mobile-menu'}`}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={notificationsOnly ? 'Notifications' : 'Settings'}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mobile Header */}
        <header className="ag-set-mobile-bar">
          {notificationsOnly ? (
            <span className="ag-set-mobile-title">Notifications</span>
          ) : mobileScreen === 'detail' ? (
            <button
              type="button"
              className="ag-sheet-back-btn"
              onClick={() => {
                onPlaySound?.('click')
                setMobileScreen('menu')
              }}
            >
              <ArrowLeft size={18} />
              <span>Settings</span>
            </button>
          ) : (
            <span className="ag-set-mobile-title">Settings</span>
          )}

          {!notificationsOnly && mobileScreen === 'detail' && (
            <span className="ag-set-mobile-section truncate">{activeNavMeta.label}</span>
          )}

          <button
            type="button"
            className="ag-sheet-close-btn"
            onClick={onClose}
            aria-label={notificationsOnly ? 'Close Notifications' : 'Close Settings'}
            data-notification-close={notificationsOnly ? true : undefined}
          >
            <X size={18} />
          </button>
        </header>

        <div className={notificationsOnly ? 'ag-set-layout notifications-only' : 'ag-set-layout'}>
          {/* Left Navigation Column (Desktop Sidebar / Mobile Root Menu) */}
          {!notificationsOnly && (
            <nav className="ag-set-nav" aria-label="Settings sections">
              <div className="ag-set-nav-head">
                <span className="ag-set-nav-title">Settings</span>
              </div>

              {/* Instant Settings Search */}
              <div className="ag-set-search-wrap">
                <div className="ag-set-search">
                  <Search size={14} className="ag-set-search-icon" aria-hidden="true" />
                  <input
                    type="search"
                    className="ag-set-search-input"
                    placeholder="Search settings…"
                    aria-label="Search settings"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && filteredNavItems.length > 0) {
                        e.preventDefault()
                        onPlaySound?.('click')
                        setActiveTab(filteredNavItems[0].id)
                        setMobileScreen('detail')
                      } else if (e.key === 'Escape' && searchQuery) {
                        e.preventDefault()
                        e.stopPropagation()
                        setSearchQuery('')
                      }
                    }}
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      className="ag-set-search-clear"
                      onClick={() => setSearchQuery('')}
                      aria-label="Clear settings search"
                      title="Clear search"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              </div>

              <div className="ag-set-nav-list">
                {groupedNavSections.length === 0 ? (
                  <div className="ag-set-nav-empty">
                    <p>No settings match &ldquo;{searchQuery.trim()}&rdquo;</p>
                    <button
                      type="button"
                      className="ag-btn ag-btn-secondary ag-btn-xs"
                      onClick={() => setSearchQuery('')}
                    >
                      Clear search
                    </button>
                  </div>
                ) : (
                  groupedNavSections.map((group) => (
                    <div key={group.category} className="ag-set-nav-group">
                      <span className="ag-set-nav-group-label">{group.category}</span>
                      <div className="ag-set-nav-group-items">
                        {group.items.map((item) => {
                          const active = activeTab === item.id
                          return (
                            <button
                              key={item.id}
                              type="button"
                              className={`ag-set-nav-item ${active ? 'active' : ''}`}
                              aria-current={active ? 'page' : undefined}
                              onClick={() => {
                                onPlaySound?.('click')
                                setActiveTab(item.id)
                                setMobileScreen('detail')
                              }}
                            >
                              <span className="ag-set-nav-icon">{renderTabIcon(item.id)}</span>
                              <span className="ag-set-nav-text">
                                <span className="ag-set-nav-label">{item.label}</span>
                                <span className="ag-set-nav-sub">{item.subtitle}</span>
                              </span>
                              <ChevronRight size={16} className="ag-set-nav-chevron" />
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </nav>
          )}

          {/* Right Detail Pane */}
          <div className="ag-set-detail">
            <div className="ag-set-detail-head">
              <div className="ag-set-detail-head-copy">
                <h2 className="ag-set-detail-title">{activeNavMeta.label}</h2>
                <p className="ag-set-detail-desc">{activeNavMeta.description}</p>
              </div>
              <button
                type="button"
                className="ag-sheet-close-btn"
                onClick={onClose}
                aria-label={notificationsOnly ? 'Close Notifications' : 'Close Settings'}
                data-notification-close={notificationsOnly ? true : undefined}
                title="Close (Esc)"
              >
                <X size={18} />
              </button>
            </div>

            <div className="ag-set-detail-body">
              <p className="ag-set-mobile-desc">{activeNavMeta.description}</p>
              {activeTab === 'profile' && renderProfileTab()}
              {activeTab === 'notifications' && renderNotificationsTab()}
              {activeTab === 'privacy' && renderPrivacyTab()}
              {activeTab === 'content-filter' && renderContentFilterTab()}
              {activeTab === 'translator' && renderTranslatorTab()}
              {activeTab === 'appearance' && renderAppearanceTab()}
              {activeTab === 'calls' && renderCallsTab()}
              {activeTab === 'network' && renderNetworkTab()}
            </div>
          </div>
        </div>
      </div>

      {pendingCfDisable &&
        createPortal(
          <div
            className="ag-cf-confirm-backdrop"
            role="presentation"
            onClick={cancelCfDisable}
          >
            <div
              className="ag-cf-confirm-modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="ag-cf-confirm-title"
              aria-describedby="ag-cf-confirm-desc"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="ag-cf-confirm-head">
                <span className="ag-cf-confirm-badge" aria-hidden="true">
                  <ShieldAlert size={22} />
                </span>
                <div className="ag-cf-confirm-title-wrap">
                  <h2 id="ag-cf-confirm-title" className="ag-cf-confirm-title">
                    {CF_DISABLE_CONFIRM_COPY[pendingCfDisable].title}
                  </h2>
                  <p className="ag-cf-confirm-subtitle">Not recommended · Unscreened media risk</p>
                </div>
                <button
                  type="button"
                  className="ag-cf-confirm-close"
                  onClick={cancelCfDisable}
                  aria-label="Keep protection on"
                  title="Keep protection on (Esc)"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="ag-cf-confirm-callout">
                <AlertTriangle size={16} className="ag-cf-confirm-callout-icon" aria-hidden="true" />
                <p id="ag-cf-confirm-desc" className="ag-cf-confirm-callout-text">
                  {CF_DISABLE_CONFIRM_COPY[pendingCfDisable].warning}
                </p>
              </div>

              <p className="ag-cf-confirm-note">
                {CF_DISABLE_CONFIRM_COPY[pendingCfDisable].detail}
              </p>

              <div className="ag-cf-confirm-actions">
                <button
                  type="button"
                  className="ag-cf-confirm-disable-btn"
                  onClick={() => {
                    const patch = CF_DISABLE_CONFIRM_COPY[pendingCfDisable].patch
                    engine.contentFilter.updateSettings(patch)
                    setPendingCfDisable(null)
                    onPlaySound?.('click')
                  }}
                >
                  <span>Turn Off Anyway</span>
                </button>
                <button
                  ref={keepProtectionBtnRef}
                  type="button"
                  className="ag-cf-confirm-keep-btn"
                  onClick={() => {
                    setPendingCfDisable(null)
                    onPlaySound?.('click')
                  }}
                >
                  <ShieldCheck size={15} />
                  <span>Keep Protection On</span>
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {rotateConfirmOpen &&
        createPortal(
          <div
            className="ag-cf-confirm-backdrop"
            role="presentation"
            onClick={cancelRotateConfirm}
          >
            <div
              className="ag-cf-confirm-modal ag-rotate-confirm-modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="ag-rotate-confirm-title"
              aria-describedby="ag-rotate-confirm-desc"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="ag-cf-confirm-head">
                <span className="ag-cf-confirm-badge" aria-hidden="true">
                  <AlertTriangle size={22} />
                </span>
                <div className="ag-cf-confirm-title-wrap">
                  <h2 id="ag-rotate-confirm-title" className="ag-cf-confirm-title">
                    Rotate Nostr Keys?
                  </h2>
                  <p className="ag-cf-confirm-subtitle">
                    Destructive action · Replaces your current identity
                  </p>
                </div>
                <button
                  type="button"
                  className="ag-cf-confirm-close"
                  onClick={cancelRotateConfirm}
                  aria-label="Cancel key rotation"
                  title="Cancel (Esc)"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="ag-cf-confirm-callout">
                <AlertTriangle size={16} className="ag-cf-confirm-callout-icon" aria-hidden="true" />
                <p id="ag-rotate-confirm-desc" className="ag-cf-confirm-callout-text">
                  Rotating keys generates a brand-new Nostr private &amp; public keypair (
                  <span className="mono">nsec</span> / <span className="mono">npub</span>) on this
                  device and replaces your current identity.
                </p>
              </div>

              <ul className="ag-rotate-confirm-list">
                <li>
                  <strong>Permanent loss without backup:</strong> Unless you have backed up your
                  current private key (<span className="mono">nsec</span>), you will permanently
                  lose access to this identity, your Agora profile, DMs, group admin/member roles,
                  Agmail, and any unbacked-up Agwallet funds.
                </li>
                <li>
                  <strong>New identity to others:</strong> Contacts, followers, and trusted peers
                  will no longer recognize you as the same <span className="mono">npub</span>.
                </li>
                <li>
                  <strong>Device sync reset:</strong> Other devices synced to your current key will
                  stop syncing with this device until re-linked.
                </li>
              </ul>

              {identity.exportableNsec && (
                <div className="ag-rotate-confirm-backup-row">
                  <button
                    type="button"
                    className="ag-btn ag-btn-secondary ag-btn-sm"
                    onClick={() => void handleCopyKey('nsec', identity.exportableNsec!)}
                  >
                    {copiedField === 'nsec' ? <Check size={13} /> : <Copy size={13} />}
                    <span>
                      {copiedField === 'nsec'
                        ? 'Copied current nsec'
                        : 'Copy current nsec backup'}
                    </span>
                  </button>
                </div>
              )}

              <label className="ag-rotate-confirm-check">
                <input
                  type="checkbox"
                  checked={rotateConfirmAck}
                  onChange={(e) => setRotateConfirmAck(e.target.checked)}
                />
                <span>
                  I understand and have backed up my current private key (
                  <span className="mono">nsec</span>) if I want to keep it
                </span>
              </label>

              <div className="ag-cf-confirm-actions">
                <button
                  ref={rotateCancelBtnRef}
                  type="button"
                  className="ag-btn ag-btn-secondary ag-rotate-confirm-cancel-btn"
                  onClick={() => {
                    cancelRotateConfirm()
                    onPlaySound?.('click')
                  }}
                >
                  <span>Cancel</span>
                </button>
                <button
                  type="button"
                  className="ag-rotate-confirm-danger-btn"
                  disabled={!rotateConfirmAck}
                  onClick={() => {
                    setRevealNsec(false)
                    engine.rotateIdentity()
                    onPlaySound?.('tune')
                    cancelRotateConfirm()
                  }}
                >
                  <RefreshCw size={14} />
                  <span>Rotate Keys Permanently</span>
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <DeleteProfileConfirmModal
        profile={pendingDeleteProfile}
        avatarUrl={
          pendingDeleteProfile
            ? (engine.getProfilePicture(pendingDeleteProfile.pubkey) ??
              pendingDeleteProfile.picture)
            : undefined
        }
        busy={removingProfilePubkey !== null}
        onCancel={() => {
          if (removingProfilePubkey === null) {
            onPlaySound?.('click')
            setPendingDeleteProfile(null)
          }
        }}
        onConfirm={handleConfirmDeleteProfile}
      />
    </div>
  )
}

export default SettingsModal
