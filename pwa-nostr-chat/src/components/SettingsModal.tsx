import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Check,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  Fingerprint,
  Flame,
  Globe,
  Loader2,
  Lock,
  Palette,
  PhoneCall,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  User,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import type { AgnostrEngine, SignMode, ThemeId } from '../types/protocol.ts'
import type { PwaState } from '../hooks/usePwa.ts'
import {
  RECORDING_QUALITY_PRESETS,
  getRecordingQualitySpec,
} from '../lib/callRecorder.ts'
import { radioAudio, type SoundCue } from '../utils/sound.ts'
import { identiconDataUrl, pubkeyToColor, shortPubkey } from '../utils/identicon.ts'

export type SettingsTab = 'profile' | 'privacy' | 'appearance' | 'calls' | 'network'

export interface SettingsModalProps {
  open: boolean
  engine: AgnostrEngine
  pwa: PwaState
  initialTab?: SettingsTab
  onClose: () => void
  onOpenInstall: () => void
  onPlaySound?: (cue: SoundCue) => void
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

const NAV_ITEMS: readonly {
  id: SettingsTab
  label: string
  subtitle: string
}[] = [
  { id: 'profile', label: 'Profile', subtitle: 'Name, keys & signer' },
  { id: 'privacy', label: 'Privacy & Trust', subtitle: 'Trusted peers & blocks' },
  { id: 'appearance', label: 'Appearance', subtitle: 'Theme & sound effects' },
  { id: 'calls', label: 'Calls & Recording', subtitle: 'Quality & TURN server' },
  { id: 'network', label: 'Network & App', subtitle: 'Relays, Blossom & PWA' },
]

const PANIC_HOLD_MS = 1500

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
  onPlaySound,
}: SettingsModalProps) {
  const {
    identity,
    settings,
    trustedPubkeys,
    blockedPubkeys,
    strictWhitelistMode,
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
  const [secretDraft, setSecretDraft] = useState('')
  const [secretFeedback, setSecretFeedback] = useState<{ ok: boolean; msg: string } | null>(null)
  const [revealNsec, setRevealNsec] = useState(false)
  const [copiedField, setCopiedField] = useState<'npub' | 'nsec' | null>(null)

  // Privacy drafts
  const [trustKeyDraft, setTrustKeyDraft] = useState('')
  const [trustLabelDraft, setTrustLabelDraft] = useState('')
  const [trustFeedback, setTrustFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  // Calls TURN drafts
  const [turnUrlDraft, setTurnUrlDraft] = useState(() => engine.calls.turnConfig?.url ?? '')
  const [turnUserDraft, setTurnUserDraft] = useState(() => engine.calls.turnConfig?.username ?? '')
  const [turnCredDraft, setTurnCredDraft] = useState(
    () => engine.calls.turnConfig?.credential ?? '',
  )
  const [turnFeedback, setTurnFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

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
    setTurnUrlDraft(engine.calls.turnConfig?.url ?? '')
    setTurnUserDraft(engine.calls.turnConfig?.username ?? '')
    setTurnCredDraft(engine.calls.turnConfig?.credential ?? '')
  }, [engine.calls.turnConfig])

  // Escape dismissal
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

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
        setTurnUrlDraft('')
        setTurnUserDraft('')
        setTurnCredDraft('')
        setTurnFeedback(null)
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

  const handleCopyKey = async (field: 'npub' | 'nsec', value: string) => {
    const ok = await copyClipboard(value)
    if (ok) {
      setCopiedField(field)
      onPlaySound?.('click')
      engine.pushToast('success', field === 'npub' ? 'Copied public key' : 'Copied secret key')
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

  const renderTabIcon = (id: SettingsTab) => {
    switch (id) {
      case 'profile':
        return <User size={17} />
      case 'privacy':
        return <ShieldCheck size={17} />
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
          {identity.hasNip07 && <span className="ag-badge ag-badge-ok">NIP-07 detected</span>}
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

  const renderPrivacyTab = () => (
    <div className="ag-set-pane-stack">
      <label className="ag-set-toggle-card">
        <div className="ag-set-toggle-copy">
          <span className="ag-set-toggle-title">
            <ShieldCheck size={16} />
            <span>Trusted Peers Only (Text)</span>
          </span>
          <span className="ag-set-toggle-desc">
            Hide text messages from untrusted senders. Images, voice memos, and DM calls always
            require trusting the sender.
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
            Calls connect peer-to-peer (WebRTC) and share your IP with call peers. Add a TURN
            server only if you are behind a strict firewall.
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
          DM &amp; private server media are AES-256-GCM encrypted before upload.
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
          Hold for 1.5s to erase all local keys, messages, DMs, trusted peers, and caches, and
          rotate to a fresh identity.
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
    <div className="ag-modal-backdrop ag-set-backdrop" onClick={onClose} role="presentation">
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
              {activeTab === 'privacy' && renderPrivacyTab()}
              {activeTab === 'appearance' && renderAppearanceTab()}
              {activeTab === 'calls' && renderCallsTab()}
              {activeTab === 'network' && renderNetworkTab()}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default SettingsModal
