import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  AlertTriangle,
  Check,
  Copy,
  Cpu,
  Download,
  Eye,
  EyeOff,
  FileJson,
  FileText,
  Fingerprint,
  Flame,
  Key,
  Loader2,
  Lock,
  Palette,
  PhoneCall,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import type { AgnostrEngine, SignMode, ThemeId } from '../types/protocol.ts'
import type { PwaState } from '../hooks/usePwa.ts'
import { radioAudio, type SoundCue } from '../utils/sound.ts'
import { identiconDataUrl, pubkeyToColor, shortPubkey } from '../utils/identicon.ts'

export interface IdentitySettingsPanelProps {
  engine: AgnostrEngine
  pwa?: PwaState
  onOpenInstall?: () => void
  onPlaySound?: (cue: SoundCue) => void
}

interface ThemeOption {
  id: ThemeId
  name: string
  tagline: string
  bg: string
  surface: string
  accent: string
  secondary: string
}

const THEME_OPTIONS: readonly ThemeOption[] = [
  {
    id: 'phosphor',
    name: 'Phosphor',
    tagline: 'Emerald Pine',
    bg: '#080B09',
    surface: '#141D18',
    accent: '#22E584',
    secondary: '#38BDF8',
  },
  {
    id: 'amber',
    name: 'Shortwave',
    tagline: 'Field Amber',
    bg: '#0C0906',
    surface: '#1E1610',
    accent: '#F5A623',
    secondary: '#FB7185',
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    tagline: 'Cobalt Night',
    bg: '#08090E',
    surface: '#171926',
    accent: '#818CF8',
    secondary: '#2DD4BF',
  },
  {
    id: 'daylight',
    name: 'Daylight',
    tagline: 'Topo Field',
    bg: '#F3F5F1',
    surface: '#FFFFFF',
    accent: '#0D8A52',
    secondary: '#0284C7',
  },
]

const SIGN_MODES: readonly { id: SignMode; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'local', label: 'Local nsec' },
  { id: 'extension', label: 'NIP-07' },
]

const PANIC_HOLD_MS = 1500

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function stripHttpScheme(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

export function IdentitySettingsPanel({
  engine,
  pwa,
  onOpenInstall,
  onPlaySound,
}: IdentitySettingsPanelProps) {
  const {
    identity,
    settings,
    activeGeohash,
    trustedPubkeys,
    strictWhitelistMode,
    hiddenByWhitelistCount,
    blossomServers,
  } = engine

  const [nickDraft, setNickDraft] = useState(identity.nickname)
  const [localSecretDraft, setLocalSecretDraft] = useState('')
  const [secretFeedback, setSecretFeedback] = useState<{ ok: boolean; msg: string } | null>(null)
  const [revealNsec, setRevealNsec] = useState(false)
  const [copiedField, setCopiedField] = useState<'npub' | 'nsec' | null>(null)
  const [updateCheckNote, setUpdateCheckNote] = useState<string | null>(null)

  // Whitelist, Blossom & TURN form state
  const [trustKeyDraft, setTrustKeyDraft] = useState('')
  const [trustLabelDraft, setTrustLabelDraft] = useState('')
  const [trustFeedback, setTrustFeedback] = useState<{ ok: boolean; msg: string } | null>(null)
  const [blossomDraft, setBlossomDraft] = useState('')
  const [blossomError, setBlossomError] = useState<string | null>(null)
  const [turnUrlDraft, setTurnUrlDraft] = useState(() => engine.calls.turnConfig?.url ?? '')
  const [turnUserDraft, setTurnUserDraft] = useState(() => engine.calls.turnConfig?.username ?? '')
  const [turnCredDraft, setTurnCredDraft] = useState(
    () => engine.calls.turnConfig?.credential ?? '',
  )
  const [turnFeedback, setTurnFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  // Hold-to-confirm Panic Wipe state
  const [panicProgress, setPanicProgress] = useState(0)
  const [panicHolding, setPanicHolding] = useState(false)
  const [justWiped, setJustWiped] = useState(false)
  const rafRef = useRef<number | null>(null)
  const holdStartRef = useRef<number>(0)
  const wipeCompletedRef = useRef(false)

  useEffect(() => {
    setNickDraft(identity.nickname)
  }, [identity.nickname])

  useEffect(() => {
    setTurnUrlDraft(engine.calls.turnConfig?.url ?? '')
    setTurnUserDraft(engine.calls.turnConfig?.username ?? '')
    setTurnCredDraft(engine.calls.turnConfig?.credential ?? '')
  }, [engine.calls.turnConfig])

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

  const startPanicHold = () => {
    if (panicHolding) return
    wipeCompletedRef.current = false
    setJustWiped(false)
    setPanicHolding(true)
    holdStartRef.current = performance.now()

    const tick = (now: number) => {
      const elapsed = now - holdStartRef.current
      const pct = Math.min(100, (elapsed / PANIC_HOLD_MS) * 100)
      setPanicProgress(pct)

      if (pct >= 100) {
        wipeCompletedRef.current = true
        rafRef.current = null
        setPanicHolding(false)
        setPanicProgress(0)
        setRevealNsec(false)
        setLocalSecretDraft('')
        setTrustKeyDraft('')
        setTrustLabelDraft('')
        setTrustFeedback(null)
        setBlossomDraft('')
        setBlossomError(null)
        setTurnUrlDraft('')
        setTurnUserDraft('')
        setTurnCredDraft('')
        setTurnFeedback(null)
        onPlaySound?.('wipe')
        engine.panicWipe()
        setJustWiped(true)
        window.setTimeout(() => setJustWiped(false), 2400)
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

  const handleNickSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = nickDraft.trim()
    if (!trimmed || trimmed === identity.nickname) return
    engine.setNickname(trimmed)
    onPlaySound?.('click')
  }

  const handleCopy = async (field: 'npub' | 'nsec', value: string) => {
    const ok = await copyToClipboard(value)
    if (ok) {
      setCopiedField(field)
      onPlaySound?.('click')
      engine.pushToast('success', field === 'npub' ? 'Copied npub' : 'Copied secret key (nsec)')
      window.setTimeout(() => {
        setCopiedField((prev) => (prev === field ? null : prev))
      }, 1800)
    }
  }

  const handleSignModeChange = (mode: SignMode) => {
    if (mode === identity.signMode) return
    engine.setSignMode(mode)
    setSecretFeedback(null)
    onPlaySound?.('click')
  }

  const handleImportSecret = (e: FormEvent) => {
    e.preventDefault()
    const raw = localSecretDraft.trim()
    if (!raw) return
    const ok = engine.setLocalSecret(raw)
    if (ok) {
      setLocalSecretDraft('')
      setSecretFeedback({ ok: true, msg: 'Local key applied' })
      onPlaySound?.('tune')
    } else {
      setSecretFeedback({ ok: false, msg: 'Invalid nsec1… or 64-char hex key' })
    }
  }

  const handleRotate = () => {
    setRevealNsec(false)
    engine.rotateIdentity()
    onPlaySound?.('tune')
  }

  const handleToggleSfx = () => {
    const next = !settings.soundEnabled
    engine.updateSettings({ soundEnabled: next })
    radioAudio.setEnabled(next)
    if (next) {
      radioAudio.play('tune', true)
    }
  }

  const handleExport = (format: 'markdown' | 'json') => {
    const { filename, content, mimeType } = engine.exportTranscript(format)
    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    onPlaySound?.('click')
    engine.pushToast('success', `Exported ${filename}`)
  }

  const handleToggleStrictWhitelist = () => {
    engine.setStrictWhitelistMode(!strictWhitelistMode)
    onPlaySound?.('click')
  }

  const handleAddTrustedPeer = (e: FormEvent) => {
    e.preventDefault()
    const key = trustKeyDraft.trim()
    if (!key) return
    const label = trustLabelDraft.trim() || undefined
    const ok = engine.trustPubkey(key, label)
    if (ok) {
      setTrustKeyDraft('')
      setTrustLabelDraft('')
      setTrustFeedback({ ok: true, msg: 'Added to trusted peers' })
      onPlaySound?.('click')
    } else {
      setTrustFeedback({ ok: false, msg: 'Enter a valid npub1… or 64-char hex pubkey' })
    }
  }

  const handleAddBlossomServer = (e: FormEvent) => {
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
      setBlossomError('Enter a valid https:// Blossom server URL')
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

  const handleColor = pubkeyToColor(identity.activePubkey)
  const isDerivedPersona =
    identity.perGeohashIdentity && identity.activePubkey !== identity.masterPubkey

  return (
    <div className="ag-panel ag-identity-panel">
      {/* Identity Card */}
      <section className="ag-panel-card">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <Fingerprint size={13} />
            <span>OPERATOR IDENTITY</span>
          </div>
          <div className="ag-id-badges">
            <span className="ag-badge ag-badge-accent">{identity.signMode.toUpperCase()}</span>
            {isDerivedPersona && (
              <span className="ag-badge ag-badge-mesh" title={`Derived unlinkable key for #${activeGeohash}`}>
                #{activeGeohash}
              </span>
            )}
          </div>
        </div>

        <div className="ag-id-hero">
          <img
            src={identiconDataUrl(identity.activePubkey)}
            alt=""
            className="ag-id-avatar"
            width={44}
            height={44}
          />
          <div className="ag-id-hero-meta">
            <div className="ag-id-handle truncate" style={{ color: handleColor }}>
              {identity.activeDisplayHandle}
            </div>
            <div className="ag-id-sub mono truncate">
              {shortPubkey(identity.activeNpub, 10, 6)}
            </div>
          </div>
          <button
            type="button"
            className="ag-btn ag-btn-secondary ag-btn-xs"
            onClick={handleRotate}
            disabled={identity.signMode === 'extension'}
            title={
              identity.signMode === 'extension'
                ? 'Switch to Auto or Local signer to rotate keys'
                : 'Generate a fresh cryptographic identity immediately'
            }
          >
            <RefreshCw size={12} />
            <span>Rotate</span>
          </button>
        </div>

        {/* Nickname Editor */}
        <form className="ag-nick-form" onSubmit={handleNickSubmit}>
          <label className="ag-field-label" htmlFor="ag-nick-input">
            Callsign / Nickname
          </label>
          <div className="ag-jump-form">
            <input
              id="ag-nick-input"
              type="text"
              maxLength={24}
              className="ag-input"
              value={nickDraft}
              onChange={(e) => setNickDraft(e.target.value)}
              placeholder="anon"
            />
            <button
              type="submit"
              className="ag-btn ag-btn-secondary"
              disabled={!nickDraft.trim() || nickDraft.trim() === identity.nickname}
            >
              Save
            </button>
          </div>
        </form>

        {/* Key Copy & Reveal Rows */}
        <div className="ag-key-rows">
          <div className="ag-key-row">
            <div className="ag-key-meta">
              <span className="ag-key-label">
                {isDerivedPersona ? `NPUB (#${activeGeohash})` : 'PUBLIC KEY (NPUB)'}
              </span>
              <span className="ag-key-value mono truncate" title={identity.activeNpub}>
                {identity.activeNpub}
              </span>
            </div>
            <button
              type="button"
              className="ag-icon-btn-xs"
              onClick={() => void handleCopy('npub', identity.activeNpub)}
              title="Copy npub"
              aria-label="Copy public key npub"
            >
              {copiedField === 'npub' ? <Check size={13} className="ag-tone-ok" /> : <Copy size={13} />}
            </button>
          </div>

          {identity.maskedNsec && (
            <div className="ag-key-row">
              <div className="ag-key-meta">
                <span className="ag-key-label">SECRET KEY (NSEC)</span>
                <span className="ag-key-value mono truncate">
                  {revealNsec && identity.exportableNsec
                    ? identity.exportableNsec
                    : identity.maskedNsec}
                </span>
              </div>
              <div className="ag-key-actions">
                {identity.exportableNsec && (
                  <>
                    <button
                      type="button"
                      className="ag-icon-btn-xs"
                      onClick={() => setRevealNsec((v) => !v)}
                      title={revealNsec ? 'Hide secret key' : 'Reveal secret key'}
                      aria-label={revealNsec ? 'Hide secret key' : 'Reveal secret key'}
                    >
                      {revealNsec ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                    <button
                      type="button"
                      className="ag-icon-btn-xs"
                      onClick={() => void handleCopy('nsec', identity.exportableNsec!)}
                      title="Copy secret key (keep private!)"
                      aria-label="Copy secret key nsec"
                    >
                      {copiedField === 'nsec' ? (
                        <Check size={13} className="ag-tone-ok" />
                      ) : (
                        <Copy size={13} />
                      )}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Trusted Peers & Media Safety */}
      <section className="ag-panel-card ag-safety-card" aria-label="Trusted peers and media safety">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <ShieldCheck size={13} />
            <span>TRUSTED PEERS &amp; MEDIA SAFETY</span>
          </div>
          <span className="ag-chip ag-chip-mono">
            {trustedPubkeys.length} trusted
          </span>
        </div>

        <div className="ag-safety-notice">
          <ShieldAlert size={13} />
          <span>
            Voice memos &amp; media <strong>always require trusting the sender</strong> — zero
            network fetches for untrusted peers.
          </span>
        </div>

        <label className="ag-toggle-row">
          <div className="ag-toggle-copy">
            <span className="ag-toggle-title">
              <Shield size={13} />
              Trusted Peers Only (Text)
            </span>
            <span className="ag-toggle-desc">
              Also hide text messages from untrusted peers (your own messages stay visible).
            </span>
          </div>
          <input
            type="checkbox"
            className="ag-switch"
            checked={strictWhitelistMode}
            onChange={handleToggleStrictWhitelist}
          />
        </label>

        {strictWhitelistMode && hiddenByWhitelistCount > 0 && (
          <div className="ag-strict-stat mono">
            Hiding {hiddenByWhitelistCount} untrusted{' '}
            {hiddenByWhitelistCount === 1 ? 'message' : 'messages'} in #{activeGeohash}
          </div>
        )}

        <div className="ag-subsection-head">
          <span className="ag-section-label">TRUSTED PEERS</span>
          {trustedPubkeys.length > 0 && (
            <button
              type="button"
              className="ag-btn ag-btn-ghost ag-btn-xs"
              onClick={() => {
                engine.clearTrustedPubkeys()
                onPlaySound?.('click')
              }}
              title="Revoke trust for all peers"
            >
              <Trash2 size={11} />
              <span>Clear All</span>
            </button>
          )}
        </div>

        {trustedPubkeys.length === 0 ? (
          <p className="ag-field-hint ag-whitelist-empty">
            No trusted peers yet. Trust someone from a voice shield card, peer roster, or paste
            their key below.
          </p>
        ) : (
          <div className="ag-whitelist-list" role="list" aria-label="Trusted peers">
            {trustedPubkeys.map((entry) => (
              <div key={entry.pubkey} role="listitem" className="ag-whitelist-row">
                <img
                  src={identiconDataUrl(entry.pubkey)}
                  alt=""
                  className="ag-whitelist-avatar"
                  width={26}
                  height={26}
                />
                <div className="ag-whitelist-meta">
                  <span
                    className="ag-whitelist-name truncate"
                    style={{ color: pubkeyToColor(entry.pubkey) }}
                  >
                    {entry.label ? `@${entry.label}` : shortPubkey(entry.pubkey, 8, 6)}
                  </span>
                  <span className="ag-whitelist-npub mono truncate" title={entry.npub}>
                    {shortPubkey(entry.npub, 11, 6)}
                  </span>
                </div>
                <button
                  type="button"
                  className="ag-icon-btn-xs ag-icon-btn-danger"
                  onClick={() => {
                    engine.untrustPubkey(entry.pubkey)
                    onPlaySound?.('click')
                  }}
                  title={`Untrust ${entry.label || shortPubkey(entry.npub, 8, 4)}`}
                  aria-label={`Untrust ${entry.label || entry.npub}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <form className="ag-whitelist-form" onSubmit={handleAddTrustedPeer}>
          <label className="ag-field-label" htmlFor="ag-trust-key-input">
            Add trusted npub or hex pubkey
          </label>
          <input
            id="ag-trust-key-input"
            type="text"
            className="ag-input mono"
            placeholder="npub1… or 64-char hex pubkey"
            value={trustKeyDraft}
            onChange={(e) => {
              setTrustKeyDraft(e.target.value)
              if (trustFeedback) setTrustFeedback(null)
            }}
          />
          <div className="ag-jump-form">
            <input
              type="text"
              maxLength={28}
              className="ag-input"
              placeholder="Label (optional)"
              value={trustLabelDraft}
              onChange={(e) => setTrustLabelDraft(e.target.value)}
              aria-label="Optional nickname label for trusted peer"
            />
            <button
              type="submit"
              className="ag-btn ag-btn-primary"
              disabled={!trustKeyDraft.trim()}
            >
              <Plus size={13} />
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
      </section>

      {/* Blossom Media Servers */}
      <section className="ag-panel-card" aria-label="Blossom media servers">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <Server size={13} />
            <span>BLOSSOM MEDIA SERVERS</span>
          </div>
          <button
            type="button"
            className="ag-btn ag-btn-ghost ag-btn-xs"
            onClick={() => {
              engine.resetBlossomServers()
              setBlossomError(null)
              onPlaySound?.('click')
            }}
            title="Restore default live-verified Blossom servers"
          >
            <RotateCcw size={11} />
            <span>Reset</span>
          </button>
        </div>

        <div className="ag-blossom-e2ee-note">
          <Lock size={12} />
          <span>
            Encrypted DM voice memos are <strong>AES-256-GCM</strong> encrypted client-side before
            upload — Blossom servers never see plaintext DM audio.
          </span>
        </div>

        {blossomServers.length === 0 ? (
          <p className="ag-field-hint ag-field-hint-warn">
            No Blossom servers configured. Click Reset to restore default servers or add one below.
          </p>
        ) : (
          <div className="ag-blossom-list" role="list" aria-label="Configured Blossom servers">
            {blossomServers.map((url, index) => (
              <div key={url} role="listitem" className="ag-blossom-row">
                <div className="ag-blossom-host-wrap">
                  <span className="ag-blossom-host mono truncate" title={url}>
                    {stripHttpScheme(url)}
                  </span>
                  {index === 0 && <span className="ag-badge ag-badge-accent">PRIMARY</span>}
                </div>
                <button
                  type="button"
                  className="ag-icon-btn-xs ag-icon-btn-danger"
                  onClick={() => {
                    engine.removeBlossomServer(url)
                    onPlaySound?.('click')
                  }}
                  title={`Remove Blossom server ${url}`}
                  aria-label={`Remove ${url}`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <form className="ag-jump-form" onSubmit={handleAddBlossomServer}>
          <input
            type="text"
            className="ag-input mono"
            placeholder="https://blossom.example.com"
            value={blossomDraft}
            onChange={(e) => {
              setBlossomDraft(e.target.value)
              if (blossomError) setBlossomError(null)
            }}
            aria-label="Add custom https Blossom server URL"
          />
          <button
            type="submit"
            className="ag-btn ag-btn-secondary"
            disabled={!blossomDraft.trim()}
            aria-label="Add Blossom server"
          >
            <Plus size={14} />
          </button>
        </form>
        {blossomError && <p className="ag-field-hint ag-field-hint-danger">{blossomError}</p>}
      </section>

      {/* Voice & Video (TURN / ICE) */}
      <section className="ag-panel-card" aria-label="Voice and video TURN ICE settings">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <PhoneCall size={13} />
            <span>VOICE &amp; VIDEO (TURN / ICE)</span>
          </div>
          <span
            className={`ag-badge ${engine.calls.turnConfig ? 'ag-badge-ok' : 'ag-badge-muted'}`}
          >
            {engine.calls.turnConfig ? 'CUSTOM TURN' : 'STUN ONLY'}
          </span>
        </div>

        <p className="ag-turn-note">
          Calls connect peer-to-peer (WebRTC) and share your IP with call peers. Add a TURN server
          for strict firewalls.
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
              <span>Save TURN</span>
            </button>
            {engine.calls.turnConfig && (
              <button
                type="button"
                className="ag-btn ag-btn-secondary ag-btn-sm"
                onClick={handleClearTurn}
              >
                <Trash2 size={12} />
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
      </section>

      {/* Signer Mode Switcher */}
      <section className="ag-panel-card">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <Key size={13} />
            <span>SIGNER ENGINE</span>
          </div>
          {identity.hasNip07 && <span className="ag-badge ag-badge-ok">NIP-07 READY</span>}
        </div>

        <div className="ag-segmented" role="tablist" aria-label="Nostr signing mode">
          {SIGN_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={identity.signMode === m.id}
              className={identity.signMode === m.id ? 'active' : ''}
              onClick={() => handleSignModeChange(m.id)}
              disabled={m.id === 'extension' && !identity.hasNip07}
              title={
                m.id === 'extension' && !identity.hasNip07
                  ? 'No browser NIP-07 signer extension detected'
                  : undefined
              }
            >
              {m.label}
            </button>
          ))}
        </div>

        {identity.signMode === 'local' && (
          <form className="ag-secret-import" onSubmit={handleImportSecret}>
            <label className="ag-field-label" htmlFor="ag-nsec-import">
              Import Secret Key (nsec1… or 64-char hex)
            </label>
            <div className="ag-jump-form">
              <input
                id="ag-nsec-import"
                type="password"
                autoComplete="off"
                className="ag-input mono"
                placeholder="nsec1…"
                value={localSecretDraft}
                onChange={(e) => {
                  setLocalSecretDraft(e.target.value)
                  if (secretFeedback) setSecretFeedback(null)
                }}
              />
              <button
                type="submit"
                className="ag-btn ag-btn-secondary"
                disabled={!localSecretDraft.trim()}
              >
                Set
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

        {identity.signMode === 'extension' && (
          <p className="ag-field-hint">
            Signing via browser NIP-07 extension
            {identity.hasNip07Nip44 ? ' (NIP-44 encrypted DMs supported).' : ' (NIP-44 unavailable — DMs use local fallback).'}
          </p>
        )}

        {identity.signMode === 'auto' && !identity.hasNip07 && (
          <p className="ag-field-hint">
            Using local ephemeral keypair stored in this browser. Install Alby or nos2x for NIP-07 hardware/extension signing.
          </p>
        )}
      </section>

      {/* Privacy, Protocol & Audio Toggles */}
      <section className="ag-panel-card">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <Shield size={13} />
            <span>PROTOCOL &amp; PRIVACY</span>
          </div>
        </div>

        <div className="ag-toggle-list">
          <label className="ag-toggle-row">
            <div className="ag-toggle-copy">
              <span className="ag-toggle-title">
                <Fingerprint size={13} />
                Per-Geohash Persona
              </span>
              <span className="ag-toggle-desc">
                Derive a separate unlinkable keypair for every #geohash room.
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

          <label className="ag-toggle-row">
            <div className="ag-toggle-copy">
              <span className="ag-toggle-title">
                <Cpu size={13} />
                NIP-13 PoW ({settings.powTargetBits}-bit)
              </span>
              <span className="ag-toggle-desc">
                Fast async nonce mining to bypass relay spam throttling.
              </span>
            </div>
            <input
              type="checkbox"
              className="ag-switch"
              checked={settings.powEnabled}
              onChange={() => {
                engine.updateSettings({ powEnabled: !settings.powEnabled })
                onPlaySound?.('click')
              }}
            />
          </label>

          <label className="ag-toggle-row">
            <div className="ag-toggle-copy">
              <span className="ag-toggle-title">
                <Radio size={13} />
                Presence Heartbeat
              </span>
              <span className="ag-toggle-desc">
                Broadcast anonymous kind:20001 beacons at precision ≤5.
              </span>
            </div>
            <input
              type="checkbox"
              className="ag-switch"
              checked={settings.presenceEnabled}
              onChange={() => {
                engine.updateSettings({ presenceEnabled: !settings.presenceEnabled })
                onPlaySound?.('click')
              }}
            />
          </label>

          <label className="ag-toggle-row">
            <div className="ag-toggle-copy">
              <span className="ag-toggle-title">
                {settings.soundEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
                Web Audio Radio SFX
              </span>
              <span className="ag-toggle-desc">
                Synthesized squelch, sonar pings, and encrypted DM chimes.
              </span>
            </div>
            <input
              type="checkbox"
              className="ag-switch"
              checked={settings.soundEnabled}
              onChange={handleToggleSfx}
            />
          </label>
        </div>
      </section>

      {/* Theme Selector */}
      <section className="ag-panel-card">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <Palette size={13} />
            <span>INTERFACE THEME</span>
          </div>
          <span className="ag-panel-card-sub mono">{settings.theme}</span>
        </div>

        <div className="ag-theme-grid" role="radiogroup" aria-label="Choose color theme">
          {THEME_OPTIONS.map((t) => {
            const active = settings.theme === t.id
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={`ag-theme-swatch ${active ? 'active' : ''}`}
                onClick={() => {
                  engine.setTheme(t.id)
                  onPlaySound?.('click')
                }}
              >
                <div className="ag-theme-preview" style={{ backgroundColor: t.bg }}>
                  <span className="ag-theme-bar" style={{ backgroundColor: t.surface }} />
                  <span className="ag-theme-dot" style={{ backgroundColor: t.accent }} />
                  <span className="ag-theme-dot" style={{ backgroundColor: t.secondary }} />
                </div>
                <div className="ag-theme-meta">
                  <span className="ag-theme-name">{t.name}</span>
                  <span className="ag-theme-tag">{t.tagline}</span>
                </div>
                {active && <Check size={13} className="ag-theme-check" />}
              </button>
            )
          })}
        </div>
      </section>

      {/* App & PWA */}
      {pwa && (
        <section className="ag-panel-card" aria-label="App and PWA settings">
          <div className="ag-panel-card-head">
            <div className="ag-panel-card-title">
              <Smartphone size={13} />
              <span>APP &amp; PWA</span>
            </div>
            <span
              className={`ag-badge ${
                pwa.isInstalled
                  ? 'ag-badge-ok'
                  : pwa.canPromptInstall
                    ? 'ag-badge-accent'
                    : 'ag-badge-muted'
              }`}
            >
              {pwa.isInstalled ? 'INSTALLED' : pwa.canPromptInstall ? 'INSTALLABLE' : 'BROWSER'}
            </span>
          </div>

          <div className="ag-pwa-card-status">
            <span className="ag-pwa-status-item mono">
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
                    ? 'Offline Ready'
                    : 'Caching app…'}
              </span>
            </span>
            {updateCheckNote && (
              <span className="ag-pwa-check-note mono">{updateCheckNote}</span>
            )}
          </div>

          <div className="ag-pwa-card-actions">
            {!pwa.isInstalled && (
              <button
                type="button"
                className="ag-btn ag-btn-primary ag-btn-sm"
                onClick={() => {
                  onPlaySound?.('click')
                  if (onOpenInstall) {
                    onOpenInstall()
                  } else if (pwa.canPromptInstall) {
                    void pwa.promptInstall()
                  }
                }}
              >
                <Download size={13} />
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
                <RefreshCw size={13} />
                <span>Update Ready · Reload</span>
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
                  <>
                    <Loader2 size={13} className="ag-spin" />
                    <span>Checking…</span>
                  </>
                ) : (
                  <>
                    <RefreshCw size={13} />
                    <span>Check for Updates</span>
                  </>
                )}
              </button>
            )}
          </div>
        </section>
      )}

      {/* Transcript Export */}
      <section className="ag-panel-card">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <Download size={13} />
            <span>TRANSCRIPT EXPORT</span>
          </div>
          <span className="ag-panel-card-sub mono">#{activeGeohash}</span>
        </div>

        <div className="ag-export-row">
          <button
            type="button"
            className="ag-btn ag-btn-secondary"
            onClick={() => handleExport('markdown')}
          >
            <FileText size={13} />
            <span>Markdown (.md)</span>
          </button>
          <button
            type="button"
            className="ag-btn ag-btn-secondary"
            onClick={() => handleExport('json')}
          >
            <FileJson size={13} />
            <span>JSON (.json)</span>
          </button>
        </div>
      </section>

      {/* Red Hold-to-Confirm Bitchat Panic Wipe */}
      <section className="ag-panel-card ag-danger-card">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title ag-tone-danger">
            <AlertTriangle size={13} />
            <span>EMERGENCY PANIC WIPE</span>
          </div>
        </div>

        <p className="ag-field-hint">
          Hold for 1.5s to purge all local keys, messages, DMs, trusted peers, cached voice memos,
          pins, and caches and immediately rotate to a fresh ephemeral identity.
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
          aria-label="Hold to confirm Bitchat Panic Wipe"
        >
          <span
            className="ag-panic-fill"
            style={{ transform: `scaleX(${panicProgress / 100})` }}
            aria-hidden="true"
          />
          <span className="ag-panic-label">
            <Flame size={14} />
            <span>
              {justWiped
                ? 'WIPED & ROTATED'
                : panicHolding
                  ? `HOLD TO PURGE… ${Math.round(panicProgress)}%`
                  : 'HOLD TO PANIC WIPE'}
            </span>
          </span>
        </button>
      </section>
    </div>
  )
}
