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
  Palette,
  Radio,
  RefreshCw,
  Shield,
  Volume2,
  VolumeX,
} from 'lucide-react'
import type { AgnostrEngine, SignMode, ThemeId } from '../types/protocol.ts'
import { radioAudio, type SoundCue } from '../utils/sound.ts'
import { identiconDataUrl, pubkeyToColor, shortPubkey } from '../utils/identicon.ts'

export interface IdentitySettingsPanelProps {
  engine: AgnostrEngine
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

export function IdentitySettingsPanel({ engine, onPlaySound }: IdentitySettingsPanelProps) {
  const { identity, settings, activeGeohash } = engine

  const [nickDraft, setNickDraft] = useState(identity.nickname)
  const [localSecretDraft, setLocalSecretDraft] = useState('')
  const [secretFeedback, setSecretFeedback] = useState<{ ok: boolean; msg: string } | null>(null)
  const [revealNsec, setRevealNsec] = useState(false)
  const [copiedField, setCopiedField] = useState<'npub' | 'nsec' | null>(null)

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
          Hold for 1.5s to purge all local keys, messages, DMs, pins, and caches and immediately rotate to a fresh ephemeral identity.
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
