import { useEffect, useState } from 'react'
import {
  AtSign,
  Ban,
  Check,
  Copy,
  Hash,
  Lock,
  Shield,
  ShieldCheck,
  ShieldOff,
  X,
  Zap,
} from 'lucide-react'
import type { AgnostrEngine, PeerInfo } from '../types/protocol.ts'
import type { ZapTarget } from '../types/wallet.ts'
import { formatHandle, identiconDataUrl, pubkeyToColor } from '../utils/identicon.ts'

export interface PeerInspectorModalProps {
  peer: PeerInfo | null
  engine: AgnostrEngine
  onClose: () => void
  onStartDm: (pubkey: string, nickname?: string) => void
  onMentionPeer: (handle: string) => void
  onOpenZap?: (target: ZapTarget) => void
}

function formatLastSeen(unixSec: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSec)
  if (diff < 30) return 'Just now'
  if (diff < 60) return `${diff}s ago`
  const mins = Math.floor(diff / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function PeerInspectorModal({
  peer,
  engine,
  onClose,
  onStartDm,
  onMentionPeer,
  onOpenZap,
}: PeerInspectorModalProps) {
  const [copiedKey, setCopiedKey] = useState<'npub' | 'hex' | 'lud16' | null>(null)
  const peerPubkey = peer?.pubkey ?? null

  useEffect(() => {
    if (!peerPubkey) return
    void engine.zaps.lookupPeerLightningAddress(peerPubkey)
  }, [peerPubkey, engine.zaps])

  useEffect(() => {
    if (!peer) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [peer, onClose])

  if (!peer) return null

  const livePeer = engine.getPeerByPubkey(peer.pubkey) ?? peer
  const isBlocked = engine.isPeerBlocked(livePeer.pubkey)
  const isTrustedPeer = !livePeer.isSelf && engine.isExplicitlyTrusted(livePeer.pubkey)
  const peerLud16 = engine.zaps.getPeerLightningAddress(livePeer.pubkey)
  const handle = formatHandle(livePeer.nickname, livePeer.pubkey)
  const handleColor = pubkeyToColor(livePeer.pubkey)

  const handleCopy = async (kind: 'npub' | 'hex' | 'lud16', value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedKey(kind)
      engine.pushToast(
        'success',
        kind === 'npub'
          ? 'Copied peer npub'
          : kind === 'lud16'
            ? 'Copied Lightning Address'
            : 'Copied hex pubkey',
      )
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === kind ? null : prev))
      }, 1800)
    } catch {
      engine.pushToast('error', 'Clipboard copy failed')
    }
  }

  const handleTune = (gh: string) => {
    engine.tuneGeohash(gh)
    onClose()
  }

  const handleDm = () => {
    onStartDm(livePeer.pubkey, livePeer.nickname)
    onClose()
  }

  const handleMention = () => {
    onMentionPeer(livePeer.displayHandle)
    onClose()
  }

  const handleToggleBlock = () => {
    engine.toggleBlockPeer(livePeer.pubkey, livePeer.displayHandle)
  }

  const handleToggleTrust = () => {
    if (isTrustedPeer) {
      engine.untrustPubkey(livePeer.pubkey)
    } else {
      engine.trustPubkey(livePeer.pubkey, livePeer.nickname)
    }
  }

  return (
    <div
      className="ag-modal-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="ag-peer-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-peer-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="ag-peer-modal-head">
          <div className="ag-peer-modal-hero">
            <div className="ag-peer-modal-avatar-wrap">
              <img
                src={identiconDataUrl(livePeer.pubkey)}
                alt=""
                className="ag-peer-modal-avatar"
                width={52}
                height={52}
              />
              <span
                className={`ag-peer-dot ag-peer-dot-lg ${livePeer.isOnline ? 'online' : 'offline'}`}
              />
            </div>

            <div className="ag-peer-modal-title-wrap">
              <h2
                id="ag-peer-modal-title"
                className="ag-peer-modal-name truncate"
                style={{ color: handleColor }}
              >
                @{handle.base}
                <span className="ag-peer-modal-suffix mono">#{handle.suffix}</span>
              </h2>
              <div className="ag-peer-modal-badges">
                <span className={`ag-badge ${livePeer.isOnline ? 'ag-badge-ok' : 'ag-badge-muted'}`}>
                  {livePeer.isOnline ? 'ONLINE' : 'AWAY'}
                </span>
                {livePeer.isSelf && <span className="ag-badge ag-badge-accent">YOU</span>}
                {isTrustedPeer && (
                  <span
                    className="ag-badge ag-badge-ok"
                    title="Trusted peer — voice memos & media unlocked, text visible in Trusted-Only mode"
                  >
                    <ShieldCheck size={9} />
                    <span>TRUSTED</span>
                  </span>
                )}
                {livePeer.isTeleported && <span className="ag-badge ag-badge-warn">TELEPORT</span>}
                {livePeer.isMeshBridge && <span className="ag-badge ag-badge-mesh">MESH BRIDGE</span>}
                {isBlocked && <span className="ag-badge ag-badge-danger">MUTED</span>}
              </div>
            </div>
          </div>

          <button
            type="button"
            className="ag-icon-btn-sm"
            onClick={onClose}
            aria-label="Close peer inspector"
          >
            <X size={15} />
          </button>
        </div>

        {/* Telemetry Stats */}
        <div className="ag-peer-stats-grid">
          <div className="ag-kpi-cell">
            <span className="ag-kpi-label">MESSAGES</span>
            <span className="ag-kpi-value mono">{livePeer.messageCount}</span>
          </div>
          <div className="ag-kpi-cell">
            <span className="ag-kpi-label">LAST SEEN</span>
            <span
              className="ag-kpi-value mono"
              title={new Date(livePeer.lastSeenAt * 1000).toLocaleString()}
            >
              {formatLastSeen(livePeer.lastSeenAt)}
            </span>
          </div>
          <div className="ag-kpi-cell">
            <span className="ag-kpi-label">CHANNELS</span>
            <span className="ag-kpi-value mono">{livePeer.channels.length}</span>
          </div>
        </div>

        {/* Active Channels */}
        {livePeer.channels.length > 0 && (
          <div className="ag-peer-modal-section">
            <span className="ag-section-label">SEEN ON FREQUENCIES</span>
            <div className="ag-channel-chips">
              {livePeer.channels.map((gh) => (
                <button
                  key={gh}
                  type="button"
                  className={`ag-channel-chip mono ${gh === engine.activeGeohash ? 'active' : ''}`}
                  onClick={() => handleTune(gh)}
                >
                  <Hash size={10} />
                  <span>{gh}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Cryptographic Keys */}
        <div className="ag-peer-modal-section">
          <span className="ag-section-label">CRYPTOGRAPHIC IDENTITY</span>
          <div className="ag-key-rows">
            <div className="ag-key-row">
              <div className="ag-key-meta">
                <span className="ag-key-label">NPUB</span>
                <span className="ag-key-value mono ag-key-break">{livePeer.npub}</span>
              </div>
              <button
                type="button"
                className="ag-icon-btn-xs"
                onClick={() => void handleCopy('npub', livePeer.npub)}
                title="Copy full npub"
                aria-label="Copy peer npub"
              >
                {copiedKey === 'npub' ? <Check size={13} className="ag-tone-ok" /> : <Copy size={13} />}
              </button>
            </div>

            <div className="ag-key-row">
              <div className="ag-key-meta">
                <span className="ag-key-label">HEX PUBKEY</span>
                <span className="ag-key-value mono ag-key-break">{livePeer.pubkey}</span>
              </div>
              <button
                type="button"
                className="ag-icon-btn-xs"
                onClick={() => void handleCopy('hex', livePeer.pubkey)}
                title="Copy full hex pubkey"
                aria-label="Copy peer hex pubkey"
              >
                {copiedKey === 'hex' ? <Check size={13} className="ag-tone-ok" /> : <Copy size={13} />}
              </button>
            </div>

            {peerLud16 && (
              <div className="ag-key-row ag-key-row-zap">
                <div className="ag-key-meta">
                  <span className="ag-key-label ag-key-label-zap">
                    <Zap size={10} />
                    <span>LIGHTNING ADDRESS</span>
                  </span>
                  <span className="ag-key-value mono truncate">{peerLud16}</span>
                </div>
                <button
                  type="button"
                  className="ag-icon-btn-xs"
                  onClick={() => void handleCopy('lud16', peerLud16)}
                  title={`Copy ${peerLud16}`}
                  aria-label="Copy Lightning Address"
                >
                  {copiedKey === 'lud16' ? (
                    <Check size={13} className="ag-tone-accent" />
                  ) : (
                    <Copy size={13} />
                  )}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Trust Info */}
        {!livePeer.isSelf && (
          <div className={`ag-trust-callout ${isTrustedPeer ? 'trusted' : ''}`}>
            {isTrustedPeer ? <ShieldCheck size={14} /> : <Shield size={14} />}
            <span>
              {isTrustedPeer
                ? 'Trusted peer — voice memos & media unlock automatically and their text stays visible in Trusted-Only mode.'
                : 'Untrusted — voice memos & media stay protected until cleared by Liquid d1-2B or until you trust this peer.'}
            </span>
          </div>
        )}

        {/* Actions */}
        <div className={`ag-peer-modal-actions ${!livePeer.isSelf ? 'ag-peer-modal-actions-grid' : ''}`}>
          {!livePeer.isSelf && peerLud16 && onOpenZap && (
            <button
              type="button"
              className="ag-btn ag-btn-zap"
              onClick={() => {
                onClose()
                onOpenZap({
                  pubkey: livePeer.pubkey,
                  nickname: livePeer.nickname,
                  lud16: peerLud16,
                })
              }}
              title={`Zap ${livePeer.displayHandle} (${peerLud16})`}
            >
              <Zap size={14} />
              <span>Zap</span>
            </button>
          )}
          {!livePeer.isSelf && (
            <button
              type="button"
              className={`ag-btn ${isTrustedPeer ? 'ag-btn-trust-active' : 'ag-btn-trust'}`}
              onClick={handleToggleTrust}
              aria-pressed={isTrustedPeer}
            >
              {isTrustedPeer ? <ShieldCheck size={14} /> : <Shield size={14} />}
              <span>{isTrustedPeer ? 'Trusted' : 'Trust'}</span>
            </button>
          )}
          {!livePeer.isSelf && (
            <button type="button" className="ag-btn ag-btn-dm" onClick={handleDm}>
              <Lock size={14} />
              <span>Encrypted DM</span>
            </button>
          )}
          <button type="button" className="ag-btn ag-btn-secondary" onClick={handleMention}>
            <AtSign size={14} />
            <span>Mention</span>
          </button>
          {!livePeer.isSelf && (
            <button
              type="button"
              className={`ag-btn ${isBlocked ? 'ag-btn-ok-outline' : 'ag-btn-danger-outline'}`}
              onClick={handleToggleBlock}
            >
              {isBlocked ? <ShieldOff size={14} /> : <Ban size={14} />}
              <span>{isBlocked ? 'Unblock' : 'Mute / Block'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default PeerInspectorModal
