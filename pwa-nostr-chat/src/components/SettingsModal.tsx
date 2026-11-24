import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Bell,
  BellOff,
  BellRing,
  Captions,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  Fingerprint,
  Flame,
  Globe,
  Image as ImageIcon,
  Languages,
  Link2,
  Loader2,
  Lock,
  Palette,
  PhoneCall,
  Plus,
  QrCode,
  Radio,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Trash2,
  User,
  Volume2,
  VolumeX,
  Wallet,
  X,
  Zap,
} from 'lucide-react'
import type { AgnostrEngine, SignMode, ThemeId } from '../types/protocol.ts'
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
import { buildDmShareUrl } from '../lib/shareLinks.ts'
import { radioAudio, type SoundCue } from '../utils/sound.ts'
import { identiconDataUrl, pubkeyToColor, shortPubkey } from '../utils/identicon.ts'
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
  onClose: () => void
  onOpenInstall: () => void
  onOpenWallet?: () => void
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
    id: 'obsidian',
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
  { id: 'mentions', label: 'Mentions' },
  { id: 'off', label: 'Off' },
]

const MEDIA_SCOPE_OPTIONS: readonly { id: ContentFilterMediaScope; label: string }[] = [
  { id: 'untrusted', label: 'Untrusted' },
  { id: 'all', label: 'All' },
  { id: 'off', label: 'Off' },
]

const CALL_VIDEO_MODE_OPTIONS: readonly { id: ContentFilterCallVideoMode; label: string }[] = [
  { id: 'trusted-only', label: 'Trusted Only' },
  { id: 'screen-untrusted', label: 'Screen Untrusted' },
  { id: 'screen-all', label: 'Screen All' },
]

type PendingCfDisableKind = 'master' | 'media-off' | 'nsfw' | 'illegal'

const CF_DISABLE_CONFIRM_COPY: Record<
  PendingCfDisableKind,
  {
    title: string
    warning: string
    detail: string
    patch: Partial<ContentFilterSettings>
  }
> = {
  master: {
    title: 'Turn off image safety filter?',
    warning:
      'Turning off protection exposes your device to unscreened NSFW, extreme gore/NSFL, and potentially illegal imagery from untrusted strangers on public relays.',
    detail:
      'Public Nostr relays are unmoderated. We strongly recommend keeping the on-device image safety filter enabled at all times.',
    patch: { enabled: false },
  },
  'media-off': {
    title: 'Stop screening incoming images?',
    warning:
      'Setting incoming media screening to Off exposes your device to unscreened NSFW, extreme gore/NSFL, and potentially illegal imagery from untrusted strangers on public relays.',
    detail:
      'Without image screening, untrusted media is no longer checked locally before display. Keep this on Untrusted or All for safety.',
    patch: { mediaScope: 'off' },
  },
  nsfw: {
    title: 'Disable NSFW / explicit filter?',
    warning:
      'Turning off NSFW filtering exposes your device to unscreened sexually explicit images, nudity, and graphic adult media from untrusted strangers on public relays.',
    detail:
      'Public relays carry unmoderated media. Keeping NSFW protection enabled prevents surprise explicit imagery.',
    patch: { filterNsfw: false },
  },
  illegal: {
    title: 'Disable illegal & gore (NSFL) filter?',
    warning:
      'Turning off illegal & gore filtering disables permanent blocking of extreme gore, severe violence, and potentially illegal imagery from untrusted strangers on public relays.',
    detail:
      'This is your strongest on-device safeguard against severe harm on unmoderated relays. Strongly recommended to keep enabled.',
    patch: { filterIllegal: false },
  },
}

const NAV_ITEMS: readonly {
  id: SettingsTab
  label: string
  subtitle: string
}[] = [
  { id: 'profile', label: 'Profile', subtitle: 'Name, keys & Lightning' },
  { id: 'notifications', label: 'Notifications', subtitle: 'Push alerts & call ringing' },
  { id: 'privacy', label: 'Privacy & Trust', subtitle: 'Trusted peers & blocks' },
  { id: 'content-filter', label: 'Content Filter', subtitle: 'On-device image & video safety' },
  { id: 'translator', label: 'Translator', subtitle: 'On-device neural translation' },
  { id: 'appearance', label: 'Appearance', subtitle: 'Theme & sound effects' },
  { id: 'calls', label: 'Calls & Recording', subtitle: 'Quality, captions & TURN' },
  { id: 'network', label: 'Network & App', subtitle: 'Relays, Blossom & PWA' },
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

export function SettingsModal({
  open,
  engine,
  pwa,
  initialTab,
  onClose,
  onOpenInstall,
  onOpenWallet,
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

  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'profile')
  const [mobileScreen, setMobileScreen] = useState<'menu' | 'detail'>(
    initialTab ? 'detail' : 'menu',
  )

  // Profile drafts
  const [nickDraft, setNickDraft] = useState(identity.nickname)
  const [lud16Draft, setLud16Draft] = useState(() => engine.zaps.lightningAddress ?? '')
  const [lud16Saving, setLud16Saving] = useState(false)
  const [lud16Feedback, setLud16Feedback] = useState<{ ok: boolean; msg: string } | null>(null)

  useEffect(() => {
    setLud16Draft(engine.zaps.lightningAddress ?? '')
  }, [engine.zaps.lightningAddress])
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

  // Notifications & optional Web Push bridge drafts
  const [requestingNotifPerm, setRequestingNotifPerm] = useState(false)
  const [testingNotif, setTestingNotif] = useState(false)
  const [notifTestFeedback, setNotifTestFeedback] = useState<{ ok: boolean; msg: string } | null>(
    null,
  )
  const [bridgeOpen, setBridgeOpen] = useState(() =>
    Boolean(
      engine.notifications.settings.pushBridgeUrl ||
        engine.notifications.pushStatus === 'connected',
    ),
  )
  const [bridgeUrlDraft, setBridgeUrlDraft] = useState(
    () => engine.notifications.settings.pushBridgeUrl,
  )
  const [vapidKeyDraft, setVapidKeyDraft] = useState(
    () => engine.notifications.settings.vapidPublicKey,
  )
  const [bridgeFeedback, setBridgeFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

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
    if (initialTab) {
      setActiveTab(initialTab)
      setMobileScreen('detail')
    } else {
      setMobileScreen('menu')
    }
  }, [open, initialTab])

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

  // Android / PWA Back button cancels image-filter disable warning dialog
  useBackHandler(Boolean(pendingCfDisable), cancelCfDisable)

  // Clear pending disable warning when Settings closes; default focus to Keep Protection On
  useEffect(() => {
    if (!open) {
      setPendingCfDisable(null)
    }
  }, [open])

  useEffect(() => {
    if (!pendingCfDisable) return
    const rafId = window.requestAnimationFrame(() => {
      keepProtectionBtnRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [pendingCfDisable])

  // Escape dismissal
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (pendingCfDisable) {
          setPendingCfDisable(null)
          return
        }
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, pendingCfDisable, onClose])

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
        setBridgeOpen(false)
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
        return <User size={17} />
      case 'notifications':
        return <Bell size={17} />
      case 'privacy':
        return <ShieldCheck size={17} />
      case 'content-filter':
        return <ShieldAlert size={17} />
      case 'translator':
        return <Languages size={17} />
      case 'appearance':
        return <Palette size={17} />
      case 'calls':
        return <PhoneCall size={17} />
      case 'network':
        return <Globe size={17} />
    }
  }

  const activeNavMeta = NAV_ITEMS.find((n) => n.id === activeTab) ?? NAV_ITEMS[0]

  const renderProfileTab = () => (
    <div className="ag-set-pane-stack">
      <div className="ag-set-profile-hero">
        <img
          src={identiconDataUrl(identity.activePubkey)}
          alt=""
          width={56}
          height={56}
          className="ag-set-avatar-lg"
        />
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
        <button
          type="button"
          className="ag-btn ag-btn-secondary ag-btn-sm"
          disabled={identity.signMode === 'extension'}
          onClick={() => {
            setRevealNsec(false)
            engine.rotateIdentity()
            onPlaySound?.('tune')
          }}
          title={
            identity.signMode === 'extension'
              ? 'Switch to Auto or Local key to rotate identity'
              : 'Generate a fresh keypair'
          }
        >
          <RefreshCw size={13} />
          <span>Rotate</span>
        </button>
      </div>

      {/* Shareable Direct Message Link & QR Code */}
      <div className="ag-set-dm-share-row">
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
          <span>{copiedField === 'dm-link' ? 'Copied DM Link' : 'Copy DM Link'}</span>
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
            <span>Show DM QR</span>
          </button>
        )}
      </div>

      {/* Cashu Ecash Wallet Shortcut */}
      {onOpenWallet && (
        <button
          type="button"
          className="ag-set-wallet-shortcut"
          onClick={() => {
            onPlaySound?.('click')
            onClose()
            onOpenWallet()
          }}
        >
          <span className="ag-set-wallet-shortcut-left">
            <span className="ag-set-wallet-shortcut-icon" aria-hidden="true">
              <Wallet size={15} />
            </span>
            <span className="ag-set-wallet-shortcut-copy">
              <span className="ag-set-wallet-shortcut-title">Open Agwallet</span>
              <span className="ag-set-wallet-shortcut-sub">
                Ecash tokens, Lightning &amp; on-chain swaps
              </span>
            </span>
          </span>
          <span className="ag-set-wallet-shortcut-right">
            <span className="ag-set-wallet-bal mono">
              <Zap size={11} />
              <span>{engine.wallet.totalBalanceSats.toLocaleString()} sats</span>
            </span>
            <ChevronRight size={15} />
          </span>
        </button>
      )}

      {/* Nickname */}
      <form className="ag-set-group" onSubmit={handleNickSubmit}>
        <label className="ag-set-label" htmlFor="ag-set-nick">
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
            placeholder="anon"
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

      {/* Lightning Address (for Zaps) */}
      <form className="ag-set-group" onSubmit={(e) => void handleSaveLightningAddress(e)}>
        <div className="ag-set-label-row">
          <label className="ag-set-label" htmlFor="ag-set-lud16">
            Lightning Address (for Zaps)
          </label>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
            {engine.zaps.zapMode === 'custom' && (
              <button
                type="button"
                className="ag-btn ag-btn-ghost ag-btn-sm"
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
              lud16Saving ||
              lud16Draft.trim() === (engine.zaps.lightningAddress ?? '')
            }
          >
            {lud16Saving ? <Loader2 size={14} className="ag-spin" /> : 'Save'}
          </button>
        </div>
        <p className="ag-set-helper">
          {engine.zaps.zapMode === 'builtin'
            ? 'Built-in Zaps sweep straight into Agwallet. Enter a custom address to override.'
            : 'Using a custom Lightning address. Clear or click Use built-in to sweep into Agwallet.'}
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

      {/* Multi-Device Background Sync */}
      <div className="ag-set-group">
        <div className="ag-set-label-row">
          <span className="ag-set-label">Multi-Device Sync</span>
          <span
            className={`ag-badge ${
              engine.deviceSync.onlineSiblingCount > 0 ? 'ag-badge-accent' : 'ag-badge-muted'
            }`}
          >
            {engine.deviceSync.onlineSiblingCount > 0
              ? `${engine.deviceSync.onlineSiblingCount} linked online`
              : 'Solo device'}
          </span>
        </div>

        <div className="ag-set-sync-card">
          <label className="ag-set-sync-toggle-row">
            <div className="ag-set-toggle-copy">
              <span className="ag-set-toggle-title">
                <Smartphone size={15} />
                <span>Silent Background Sync</span>
              </span>
              <span className="ag-set-toggle-desc">
                Encrypted sync for servers, friends, notes, pins, Agmail, and messages.
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

          <div className="ag-set-sync-this-row">
            <span className="ag-set-sync-key">This Device</span>
            <span className="ag-set-sync-val truncate">{engine.deviceSync.deviceLabel}</span>
          </div>

          <div className="ag-set-sync-devices">
            <span className="ag-set-sync-subhead">
              Linked Devices ({engine.deviceSync.linkedDevices.length})
            </span>
            {engine.deviceSync.linkedDevices.length === 0 ? (
              <p className="ag-set-sync-empty">
                No other devices detected on this key yet.
              </p>
            ) : (
              <div className="ag-set-sync-device-list" role="list">
                {engine.deviceSync.linkedDevices.map((dev) => (
                  <div key={dev.deviceId} role="listitem" className="ag-set-sync-device-row">
                    <span
                      className={`ag-set-sync-dot ${dev.online ? 'online' : ''}`}
                      aria-hidden="true"
                    />
                    <span className="ag-set-sync-device-label truncate">{dev.label}</span>
                    <span className="ag-set-sync-device-meta mono">
                      {dev.online ? 'Online' : formatSyncAge(dev.lastSeenAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="ag-set-sync-footer">
            <span className="ag-set-sync-meta mono">
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
      </div>

      {/* Public & Secret Keys */}
      <div className="ag-set-group">
        <span className="ag-set-label">Keys</span>
        <div className="ag-set-card-list">
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
                <span className="ag-set-row-sub">Secret key (nsec)</span>
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
      </div>

      {/* Signer Mode */}
      <div className="ag-set-group">
        <div className="ag-set-label-row">
          <span className="ag-set-label">Signer</span>
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
                placeholder="Import nsec1… or 64-char hex"
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

      {/* Per-Room Privacy Keys */}
      <label className="ag-set-toggle-card">
        <div className="ag-set-toggle-copy">
          <span className="ag-set-toggle-title">
            <Fingerprint size={16} />
            <span>Per-Room Privacy Keys</span>
          </span>
          <span className="ag-set-toggle-desc">
            Derive a separate unlinkable keypair for every geohash room.
          </span>
        </div>
        <input
          type="checkbox"
          className="ag-switch"
          checked={settings.perGeohashIdentity}
          disabled={identity.signMode === 'extension'}
          onChange={() => {
            engine.updateSettings({ perGeohashIdentity: !settings.perGeohashIdentity })
            onPlaySound?.('click')
          }}
        />
      </label>
    </div>
  )

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
              ? { cls: 'ag-badge-muted', label: 'Unavailable' }
              : { cls: 'ag-badge-muted', label: 'Optional' }

    const handleEnableNotificationsClick = () => {
      if (requestingNotifPerm) return
      setRequestingNotifPerm(true)
      setNotifTestFeedback(null)
      // Synchronously invoke inside user gesture for iOS Safari / Chrome PWA compatibility
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

    const handleTestRingtoneClick = () => {
      notif.testRingtone()
      setNotifTestFeedback({ ok: true, msg: 'Playing 3s incoming call ringtone preview…' })
    }

    return (
      <div className="ag-set-pane-stack">
        {/* Permission & Master Status Banner */}
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
                        ? 'Blocked in browser'
                        : bannerState === 'unsupported'
                          ? 'Browser notifications unavailable'
                          : bannerState === 'granted'
                            ? 'Push Notifications'
                            : 'Enable Push Notifications'}
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
                        ? 'Enabled'
                        : 'Paused'
                      : bannerState === 'denied'
                        ? 'Blocked'
                        : bannerState === 'ios-install'
                          ? 'iOS PWA'
                          : bannerState === 'unsupported'
                            ? 'Unsupported'
                            : 'Off'}
                  </span>
                </div>
                <p className="ag-set-notif-banner-desc">
                  {bannerState === 'ios-install'
                    ? 'Add Agnostr to your Home Screen via Share → Add to Home Screen to enable iPhone/iPad push notifications.'
                    : bannerState === 'denied'
                      ? 'Notifications are blocked for this site. Allow notifications in your browser site settings and reload.'
                      : bannerState === 'unsupported'
                        ? 'This browser does not support Web Notifications. In-app chimes and incoming call ringing still work while open.'
                        : bannerState === 'granted'
                          ? 'Receive system notifications for direct messages, mentions, and incoming calls while backgrounded.'
                          : 'Stay notified for DMs, incoming calls, mentions, and group lounges even when this tab is in the background.'}
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
                  onPlaySound?.('click')
                }}
              />
            )}
          </div>

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

        {/* Category Controls */}
        <div className={`ag-set-group ${!ns.enabled ? 'ag-set-dimmed' : ''}`}>
          <span className="ag-set-label">Categories</span>
          <div className="ag-set-card-list">
            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Direct Messages</span>
                <span className="ag-set-notif-row-desc">
                  Encrypted 1-on-1 messages
                </span>
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
                <span className="ag-set-notif-row-title">
                  Direct pings (@mentions &amp; replies)
                </span>
                <span className="ag-set-notif-row-desc">
                  Always notify when someone @mentions you or replies to your message
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
                <span className="ag-set-notif-row-title">Incoming DM Call Ringing</span>
                <span className="ag-set-notif-row-desc">
                  Full-screen ringer, chime, and vibration
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
                <span className="ag-set-notif-row-title">Server Messages</span>
                <span className="ag-set-notif-row-desc">
                  Messages across your joined servers and channels
                </span>
              </div>
              <div
                className="ag-segmented ag-set-notif-seg"
                role="radiogroup"
                aria-label="Server message notifications"
              >
                {NOTIF_FILTER_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    role="radio"
                    aria-checked={ns.serverMessages === mode.id}
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
                <span className="ag-set-notif-row-title">Room &amp; Community Calls</span>
                <span className="ag-set-notif-row-desc">
                  Alert when peers start a group call in a Server channel or Geo Radio room
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
                <span className="ag-set-notif-row-title">Geo Radio</span>
                <span className="ag-set-notif-row-desc">
                  Messages in your tuned geohash radio channel
                </span>
              </div>
              <div
                className="ag-segmented ag-set-notif-seg"
                role="radiogroup"
                aria-label="Geo radio notifications"
              >
                {NOTIF_FILTER_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    role="radio"
                    aria-checked={ns.geoMessages === mode.id}
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
          </div>
        </div>

        {/* Sound, Ringtone & Privacy */}
        <div className="ag-set-group">
          <span className="ag-set-label">Sound, Ringtone &amp; Privacy</span>
          <div className="ag-set-card-list">
            <label className="ag-set-notif-row">
              <div className="ag-set-notif-row-copy">
                <span className="ag-set-notif-row-title">Message chimes</span>
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
                <span className="ag-set-notif-row-title">Call ringtone &amp; vibration</span>
                <span className="ag-set-notif-row-desc">
                  Looping synth ringtone and haptic vibration on incoming DM calls
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
                <span className="ag-set-notif-row-title">Show message previews</span>
                <span className="ag-set-notif-row-desc">
                  Hide message content on lock screens when turned off
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
        </div>

        {/* Test Actions */}
        <div className="ag-set-group">
          <span className="ag-set-label">Test Alerts</span>
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
              <span>Send Test Notification</span>
            </button>

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

        {/* Collapsible Optional Background Web Push Server */}
        <div className="ag-set-bridge-card">
          <button
            type="button"
            className="ag-set-bridge-toggle"
            aria-expanded={bridgeOpen}
            onClick={() => {
              setBridgeOpen((v) => !v)
              onPlaySound?.('click')
            }}
          >
            <span className="ag-set-bridge-toggle-left">
              <Server size={15} className="ag-set-bridge-icon" />
              <span className="ag-set-bridge-title">
                Background Web Push Server (Optional)
              </span>
            </span>
            <span className="ag-set-bridge-toggle-right">
              <span className={`ag-badge ${pushStatusBadge.cls}`}>{pushStatusBadge.label}</span>
              <ChevronDown
                size={15}
                className={`ag-set-bridge-chevron ${bridgeOpen ? 'open' : ''}`}
              />
            </span>
          </button>

          {bridgeOpen && (
            <div className="ag-set-bridge-body">
              <p className="ag-set-helper">
                Connect a self-hosted push bridge to wake a closed or locked phone.
              </p>

              <form className="ag-set-subform" onSubmit={(e) => void handleConnectPushBridge(e)}>
                <input
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="ag-input mono"
                  placeholder="https://push.example.com"
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
          )}
        </div>
      </div>
    )
  }

  const renderPrivacyTab = () => (
    <div className="ag-set-pane-stack">
      <label className="ag-set-toggle-card">
        <div className="ag-set-toggle-copy">
          <span className="ag-set-toggle-title">
            <ShieldCheck size={16} />
            <span>Trusted Peers Only (Text)</span>
          </span>
          <span className="ag-set-toggle-desc">
            Hide text from untrusted senders. Media and calls always require trust.
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

      <label className="ag-set-toggle-card">
        <div className="ag-set-toggle-copy">
          <span className="ag-set-toggle-title">
            <Radio size={16} />
            <span>Broadcast Agnostr client</span>
          </span>
          <span className="ag-set-toggle-desc">
            Show a blue avatar border and Agnostr in your profile. Turn off for a wider anonymity set.
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

      {/* Trusted Peers List */}
      <div className="ag-set-group">
        <div className="ag-set-label-row">
          <span className="ag-set-label">Trusted Peers ({trustedPubkeys.length})</span>
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

        {trustedPubkeys.length === 0 ? (
          <p className="ag-set-empty">
            No trusted peers yet. Trust someone from a chat, media shield card, or add their key
            below.
          </p>
        ) : (
          <div className="ag-set-card-list" role="list">
            {trustedPubkeys.map((entry) => (
              <div key={entry.pubkey} role="listitem" className="ag-set-peer-row">
                <img
                  src={identiconDataUrl(entry.pubkey)}
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
                  className="ag-icon-btn-sm ag-icon-btn-danger"
                  onClick={() => {
                    engine.untrustPubkey(entry.pubkey)
                    onPlaySound?.('click')
                  }}
                  aria-label={`Remove trust for ${entry.label || entry.npub}`}
                  title="Remove trust"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <form className="ag-set-subform" onSubmit={handleAddTrusted}>
          <input
            type="text"
            className="ag-input mono"
            placeholder="Add npub1… or 64-char hex pubkey"
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
      </div>

      {/* Blocked Users */}
      <div className="ag-set-group">
        <span className="ag-set-label">Blocked Users ({blockedPubkeys.length})</span>
        {blockedPubkeys.length === 0 ? (
          <p className="ag-set-empty">No blocked users.</p>
        ) : (
          <div className="ag-set-card-list" role="list">
            {blockedPubkeys.map((pk) => {
              const known = engine.getPeerByPubkey(pk)
              const label = known?.displayHandle ?? shortPubkey(pk, 10, 6)
              return (
                <div key={pk} role="listitem" className="ag-set-peer-row">
                  <img
                    src={identiconDataUrl(pk)}
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
      </div>
    </div>
  )

  const renderContentFilterTab = () => {
    const cf = engine.contentFilter
    const cfs = cf.settings
    const isDownloading = cf.modelStatus === 'downloading'
    const canReloadModel = cf.modelStatus === 'idle' || cf.modelStatus === 'error'
    const pct = Math.max(0, Math.min(100, Math.round(cf.downloadProgress)))

    const isMasterOff = !cfs.enabled
    const isMediaOff = cfs.mediaScope === 'off'
    const isNsfwOff = !cfs.filterNsfw
    const isIllegalOff = !cfs.filterIllegal
    const isProtectionWeakened = isMasterOff || isMediaOff || isNsfwOff || isIllegalOff

    const weakenedTitle =
      isMasterOff || isMediaOff
        ? 'Image safety protection is off'
        : isIllegalOff && isNsfwOff
          ? 'All image safety filters are off'
          : isIllegalOff
            ? 'Illegal & gore (NSFL) protection is off'
            : 'NSFW / explicit protection is off'

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
        ? 'Untrusted peers stay blocked (zero WebRTC media) until you trust them.'
        : cfs.callVideoMode === 'screen-untrusted'
          ? 'Untrusted call video stays veiled until cleared by the on-device safety filter.'
          : 'All remote call video stays veiled until cleared by the safety filter, re-veiling if flagged.'

    const handleRestoreFullProtection = () => {
      cf.updateSettings({
        enabled: true,
        filterNsfw: true,
        filterIllegal: true,
        mediaScope: cfs.mediaScope === 'off' ? 'untrusted' : cfs.mediaScope,
      })
      onPlaySound?.('click')
    }

    return (
      <div className="ag-set-pane-stack">
        {/* Danger Banner whenever image protection is disabled or weakened */}
        {isProtectionWeakened && (
          <div className="ag-set-cf-danger-banner" role="alert">
            <span className="ag-set-cf-danger-icon" aria-hidden="true">
              <ShieldAlert size={18} />
            </span>
            <div className="ag-set-cf-danger-body">
              <span className="ag-set-cf-danger-title">{weakenedTitle}</span>
              <span className="ag-set-cf-danger-desc">
                Your device may display unscreened NSFW, extreme gore/NSFL, or illegal imagery from
                untrusted strangers on public relays. Strongly recommended to keep image filtering
                on.
              </span>
              <div className="ag-set-cf-danger-actions">
                <button
                  type="button"
                  className="ag-btn ag-btn-primary ag-btn-sm"
                  onClick={handleRestoreFullProtection}
                >
                  <ShieldCheck size={13} />
                  <span>Turn Back On</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Content Filter Model Card */}
        <div className="ag-set-ai-card">
          <div className="ag-set-ai-head">
            <div className="ag-set-ai-title-wrap">
              <span className="ag-set-ai-emblem" aria-hidden="true">
                <Sparkles size={15} />
              </span>
              <div className="ag-set-ai-title-copy">
                <span className="ag-set-ai-title">{cf.modelLabel}</span>
                <span className="ag-set-ai-sub mono truncate">{cf.modelId}</span>
              </div>
            </div>
            <span className={`ag-badge ${statusBadge.cls}`}>{statusBadge.text}</span>
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

          <p className="ag-set-helper">
            Loads automatically on startup and screens images 100% locally via{' '}
            {cf.webGpuSupported ? 'WebGPU / WASM' : 'WASM'}.
          </p>

          <div className="ag-set-ai-actions">
            {canReloadModel && (
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
        </div>

        {/* Master Toggle */}
        <label className="ag-set-toggle-card">
          <div className="ag-set-toggle-copy">
            <span className="ag-set-toggle-title">
              <ShieldAlert size={16} />
              <span>Image Safety Filter</span>
            </span>
            <span className="ag-set-toggle-desc">
              Screen incoming images locally before display.
            </span>
          </div>
          <input
            type="checkbox"
            className="ag-switch"
            checked={cfs.enabled}
            onChange={() => {
              onPlaySound?.('click')
              if (cfs.enabled) {
                setPendingCfDisable('master')
              } else {
                cf.updateSettings({ enabled: true })
              }
            }}
          />
        </label>

        {/* Categories */}
        <div className={`ag-set-group ${!cfs.enabled ? 'ag-set-dimmed' : ''}`}>
          <span className="ag-set-label">Categories</span>

          <div className="ag-set-stack-sm">
            <label className="ag-set-toggle-card">
              <div className="ag-set-toggle-copy">
                <span className="ag-set-toggle-title">
                  <span>NSFW / Explicit</span>
                </span>
                <span className="ag-set-toggle-desc">
                  Block sexually explicit images, nudity, and graphic adult media.
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                disabled={!cfs.enabled}
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

            <label className="ag-set-toggle-card">
              <div className="ag-set-toggle-copy">
                <span className="ag-set-toggle-title">
                  <span>Illegal &amp; Gore (NSFL)</span>
                </span>
                <span className="ag-set-toggle-desc">
                  Permanently block illegal imagery, extreme gore, and severe violence (no reveal
                  override).
                </span>
              </div>
              <input
                type="checkbox"
                className="ag-switch"
                disabled={!cfs.enabled}
                checked={cfs.filterIllegal}
                onChange={() => {
                  onPlaySound?.('click')
                  if (cfs.filterIllegal) {
                    setPendingCfDisable('illegal')
                  } else {
                    cf.updateSettings({ filterIllegal: true })
                  }
                }}
              />
            </label>
          </div>
        </div>

        {/* Scope */}
        <div className={`ag-set-group ${!cfs.enabled ? 'ag-set-dimmed' : ''}`}>
          <span className="ag-set-label">Scope</span>

          <div className="ag-set-scope-list">
            <div className="ag-set-scope-item">
              <div className="ag-set-label-row">
                <span className="ag-set-scope-title">Incoming Images &amp; Media</span>
                <span className="ag-set-scope-default">Default: Untrusted</span>
              </div>
              <div
                className="ag-segmented"
                role="radiogroup"
                aria-label="Incoming images and media filter scope"
              >
                {MEDIA_SCOPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    disabled={!cfs.enabled}
                    aria-checked={cfs.mediaScope === opt.id}
                    className={cfs.mediaScope === opt.id ? 'active' : ''}
                    onClick={() => {
                      onPlaySound?.('click')
                      if (opt.id === 'off' && cfs.mediaScope !== 'off') {
                        setPendingCfDisable('media-off')
                        return
                      }
                      cf.updateSettings({ mediaScope: opt.id })
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="ag-set-scope-item">
              <div className="ag-set-label-row">
                <span className="ag-set-scope-title">Call Video Feeds</span>
                <span className="ag-set-scope-default">Default: Trusted Only</span>
              </div>
              <div
                className="ag-segmented"
                role="radiogroup"
                aria-label="Call video feed screening mode"
              >
                {CALL_VIDEO_MODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    disabled={!cfs.enabled}
                    aria-checked={cfs.callVideoMode === opt.id}
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
        </div>

        {/* Quick Test Box */}
        <div className="ag-set-group">
          <span className="ag-set-label">Quick Test</span>
          <div className="ag-set-test-box">
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
              <span className="ag-set-helper">Evaluated locally using your active categories.</span>
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
        </div>
      </div>
    )
  }

  const renderTranslatorTab = () => {
    const tr = engine.translator
    const trs = tr.settings
    const isDownloading = tr.modelStatus === 'downloading'
    const pct = Math.max(0, Math.min(100, Math.round(tr.downloadProgress)))

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

    const activeModelMeta = TRANSLATOR_MODELS[trs.model] ?? TRANSLATOR_MODELS.m2m100
    const modelOptions: readonly TranslatorModelKey[] = ['m2m100', 'nllb200']

    return (
      <div className="ag-set-pane-stack">
        {/* Translator Model Card */}
        <div className="ag-set-ai-card">
          <div className="ag-set-ai-head">
            <div className="ag-set-ai-title-wrap">
              <span className="ag-set-ai-emblem" aria-hidden="true">
                <Languages size={15} />
              </span>
              <div className="ag-set-ai-title-copy">
                <span className="ag-set-ai-title">{tr.modelLabel}</span>
                <span className="ag-set-ai-sub mono truncate">{tr.modelId}</span>
              </div>
            </div>
            <span className={`ag-badge ${statusBadge.cls}`}>{statusBadge.text}</span>
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

          <p className="ag-set-helper">
            On-device translation ({tr.modelSizeHint}) — messages stay on your device.
          </p>

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
                    : 'Preload Model'}
              </span>
            </button>

            <button
              type="button"
              className="ag-btn ag-btn-secondary ag-btn-sm"
              disabled={isDownloading || trClearingCache}
              onClick={() => void handleClearTranslatorModelCache()}
            >
              <Trash2 size={13} />
              <span>{trClearingCache ? 'Clearing…' : 'Clear Model Cache'}</span>
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
        </div>

        {/* Translation Model Selector */}
        <div className="ag-set-scope-item">
          <div className="ag-set-label-row">
            <span className="ag-set-scope-title">Translation Model</span>
            <span className="ag-set-scope-default">Default: M2M-100</span>
          </div>
          <div
            className="ag-segmented"
            role="radiogroup"
            aria-label="Translation model"
          >
            {modelOptions.map((key) => {
              const opt = TRANSLATOR_MODELS[key]
              const active = trs.model === key
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  disabled={isDownloading}
                  aria-checked={active}
                  className={active ? 'active' : ''}
                  onClick={() => {
                    if (active) return
                    setTrFeedback(null)
                    tr.updateSettings({ model: key })
                    onPlaySound?.('click')
                  }}
                >
                  {key === 'm2m100'
                    ? `${opt.shortLabel} · ~603 MB`
                    : `${opt.shortLabel} · ~853 MB`}
                </button>
              )
            })}
          </div>
          <p className="ag-set-helper">{activeModelMeta.description}</p>
        </div>

        {/* Double-Column Translator Mode Toggle */}
        <label className="ag-set-toggle-card">
          <div className="ag-set-toggle-copy">
            <span className="ag-set-toggle-title">
              <Languages size={16} />
              <span>Double-Column Translator Mode</span>
            </span>
            <span className="ag-set-toggle-desc">
              Read translated messages beside the original chat column.
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

        {/* Chat Source & Reading Languages */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: '12px',
          }}
        >
          <div className="ag-set-group">
            <label className="ag-set-label" htmlFor="ag-set-src-lang">
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

          <div className="ag-set-group">
            <label className="ag-set-label" htmlFor="ag-set-my-lang">
              My Language (Incoming)
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
                placeholder="Enter any language (e.g. Swedish, Swahili, Latin)"
                aria-label="Custom reading language"
              />
            )}
          </div>
        </div>

        {/* Outgoing Translation */}
        <div className="ag-set-group">
          <label className="ag-set-toggle-card">
            <div className="ag-set-toggle-copy">
              <span className="ag-set-toggle-title">
                <span>Translate Outgoing Messages</span>
              </span>
              <span className="ag-set-toggle-desc">
                Translate your messages automatically before sending.
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
              <label className="ag-set-label" htmlFor="ag-set-out-lang">
                Outgoing Chat Language
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
    )
  }

  const renderAppearanceTab = () => (
    <div className="ag-set-pane-stack">
      <div className="ag-set-group">
        <span className="ag-set-label">Theme</span>
        <div className="ag-set-theme-grid" role="radiogroup" aria-label="Choose color theme">
          {THEME_CARDS.map((t) => {
            const active = settings.theme === t.id
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={active}
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
                    <span className="ag-set-swatch-row short" style={{ backgroundColor: t.elevated }} />
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
      </div>

      <label className="ag-set-toggle-card">
        <div className="ag-set-toggle-copy">
          <span className="ag-set-toggle-title">
            {settings.soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
            <span>Sound Effects</span>
          </span>
          <span className="ag-set-toggle-desc">
            Subtle chimes for incoming messages, calls, and channel switches.
          </span>
        </div>
        <input
          type="checkbox"
          className="ag-switch"
          checked={settings.soundEnabled}
          onChange={() => {
            const next = !settings.soundEnabled
            engine.updateSettings({ soundEnabled: next })
            radioAudio.setEnabled(next)
            if (next) {
              radioAudio.play('tune', true)
            }
          }}
        />
      </label>
    </div>
  )

  const renderCallsTab = () => {
    const recSpec = getRecordingQualitySpec(engine.calls.recordingQuality)
    const { transcription } = engine
    const isDownloadingModel = transcription.modelStatus === 'downloading'
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
        {/* Recording Quality */}
        <div className="ag-set-group">
          <div className="ag-set-label-row">
            <span className="ag-set-label">Recording Quality</span>
            <span className="ag-badge ag-badge-accent mono">{recSpec.shortLabel}</span>
          </div>

          <div
            className="ag-segmented ag-rec-quality-seg"
            role="radiogroup"
            aria-label="Call recording quality preset"
          >
            {RECORDING_QUALITY_PRESETS.map((preset) => {
              const active = engine.calls.recordingQuality === preset.id
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
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

        {/* On-Device Transcription (Multi-Model) */}
        <div className="ag-set-group">
          <div className="ag-set-label-row">
            <span className="ag-set-label">On-Device Transcription</span>
            <span className={`ag-badge ${statusBadge.cls}`}>{statusBadge.text}</span>
          </div>

          <p className="ag-set-helper">
            100% local in your browser — audio never leaves your device.
          </p>

          <label className="ag-set-toggle-card">
            <div className="ag-set-toggle-copy">
              <span className="ag-set-toggle-title">
                <Captions size={16} />
                <span>Automatic transcription</span>
              </span>
              <span className="ag-set-toggle-desc">
                Auto-transcribe trusted voice memos and turn on live call captions (CC).
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

          <div
            className="ag-set-model-list"
            role="radiogroup"
            aria-label="Local speech transcription model"
          >
            {transcription.models.map((model) => {
              const selected = model.id === transcription.activeModelId
              const isDefault = model.id === DEFAULT_TRANSCRIPTION_MODEL_ID
              const isParakeet = model.engine === 'parakeet'
              return (
                <div
                  key={model.id}
                  className={`ag-set-model-row ${selected ? 'active' : ''}`}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className="ag-set-model-main"
                    onClick={() => {
                      transcription.setActiveModelId(model.id)
                      setModelFeedback(null)
                      onPlaySound?.('click')
                    }}
                  >
                    <span className={`ag-set-model-radio ${selected ? 'checked' : ''}`}>
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
            <div className="ag-set-progress-wrap" role="progressbar" aria-valuenow={Math.round(transcription.downloadProgress)} aria-valuemin={0} aria-valuemax={100}>
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
                  style={{ width: `${Math.max(4, Math.min(100, transcription.downloadProgress))}%` }}
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
              <span>
                {transcription.cachedTranscriptCount > 0
                  ? `Clear Transcript Cache (${transcription.cachedTranscriptCount})`
                  : 'Clear Transcript Cache (0)'}
              </span>
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
              <span>{showAddModel ? 'Cancel' : 'Add Model'}</span>
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
        </div>

        {/* Custom TURN Server */}
        <div className="ag-set-group">
          <div className="ag-set-label-row">
            <span className="ag-set-label">Custom TURN Server</span>
            <span
              className={`ag-badge ${engine.calls.turnConfig ? 'ag-badge-ok' : 'ag-badge-muted'}`}
            >
              {engine.calls.turnConfig ? 'Custom TURN' : 'Default STUN'}
            </span>
          </div>
          <p className="ag-set-helper">
            Calls connect directly and share your IP with call participants. Add a relay server only
            behind strict firewalls.
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
        </div>
      </div>
    )
  }

  const renderNetworkTab = () => (
    <div className="ag-set-pane-stack">
      {/* Relays */}
      <div className="ag-set-group">
        <div className="ag-set-label-row">
          <span className="ag-set-label">
            Relays ({connectedRelayCount}/{totalRelayCount} connected)
          </span>
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
        </div>

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
          </button>
        </form>
        {relayError && <p className="ag-field-hint ag-field-hint-danger">{relayError}</p>}
      </div>

      {/* Blossom Media Servers */}
      <div className="ag-set-group">
        <div className="ag-set-label-row">
          <span className="ag-set-label">Blossom Media Servers</span>
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
        </div>

        <p className="ag-set-helper">
          <Lock size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          DM and private server media are encrypted before upload.
        </p>

        {blossomServers.length > 0 && (
          <div className="ag-set-card-list" role="list">
            {blossomServers.map((url, idx) => (
              <div key={url} role="listitem" className="ag-set-simple-row">
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
          </button>
        </form>
        {blossomError && <p className="ag-field-hint ag-field-hint-danger">{blossomError}</p>}
      </div>

      {/* App & PWA */}
      <div className="ag-set-group">
        <div className="ag-set-label-row">
          <span className="ag-set-label">App &amp; Offline</span>
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
        </div>

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
                <span>{pwa.checkingUpdate ? 'Checking…' : 'Check Updates'}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Emergency Panic Wipe */}
      <div className="ag-set-danger-box">
        <div className="ag-set-danger-head">
          <AlertTriangle size={15} />
          <span>Emergency Panic Wipe</span>
        </div>
        <p className="ag-set-helper">
          Hold 1.5s to erase all local data and generate a fresh identity.
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
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mobile Header */}
        <header className="ag-set-mobile-bar">
          {mobileScreen === 'detail' ? (
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

          {mobileScreen === 'detail' && (
            <span className="ag-set-mobile-section">{activeNavMeta.label}</span>
          )}

          <button
            type="button"
            className="ag-sheet-close-btn"
            onClick={onClose}
            aria-label="Close Settings"
          >
            <X size={18} />
          </button>
        </header>

        <div className="ag-set-layout">
          {/* Left Navigation Column (Desktop Rail / Mobile Menu List) */}
          <nav className="ag-set-nav" aria-label="Settings sections">
            <div className="ag-set-nav-head">
              <span className="ag-set-nav-title">Settings</span>
            </div>

            <div className="ag-set-nav-list">
              {NAV_ITEMS.map((item) => {
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
          </nav>

          {/* Right Detail Pane */}
          <div className="ag-set-detail">
            <div className="ag-set-detail-head">
              <h2 className="ag-set-detail-title">{activeNavMeta.label}</h2>
              <button
                type="button"
                className="ag-sheet-close-btn"
                onClick={onClose}
                aria-label="Close Settings"
                title="Close (Esc)"
              >
                <X size={18} />
              </button>
            </div>

            <div className="ag-set-detail-body">
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
    </div>
  )
}

export default SettingsModal
