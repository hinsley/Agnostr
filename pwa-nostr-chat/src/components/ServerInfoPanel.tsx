import { useState } from 'react'
import type { CSSProperties } from 'react'
import {
  Ban,
  Check,
  Copy,
  Database,
  Hash,
  Lock,
  LogOut,
  Radio,
  Send,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Users,
} from 'lucide-react'
import type { AgnostrEngine, PeerInfo } from '../types/protocol.ts'
import type { Nip29Member, ServersEngine } from '../types/servers.ts'
import type { SoundCue } from '../utils/sound.ts'
import { identiconDataUrl, pubkeyToColor } from '../utils/identicon.ts'
import type { ServerSettingsTab } from './ServerSettingsModal.tsx'

export interface ServerInfoPanelProps {
  engine: AgnostrEngine
  servers: ServersEngine
  onInspectPeer?: (peer: PeerInfo) => void
  onStartDm: (pubkey: string, nickname?: string) => void
  onOpenSettings: (serverId: string, initialTab?: ServerSettingsTab) => void
  onLeftServer?: () => void
  onPlaySound?: (cue: SoundCue) => void
}

function stripWs(url: string): string {
  return url.replace(/^wss?:\/\//i, '').replace(/\/+$/, '')
}

function getMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'SV'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase()
}

export function ServerInfoPanel({
  engine,
  servers,
  onInspectPeer,
  onStartDm,
  onOpenSettings,
  onLeftServer,
  onPlaySound,
}: ServerInfoPanelProps) {
  const { activeServer, activeChannel, members, myRole, canModerate } = servers
  const [copiedInvite, setCopiedInvite] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)

  if (!activeServer) {
    return (
      <div className="ag-panel">
        <div className="ag-empty-panel">
          <Server size={20} className="ag-empty-icon" />
          <p className="ag-empty-title">No server selected</p>
          <p className="ag-empty-sub">Pick a server from the left rail to inspect details.</p>
        </div>
      </div>
    )
  }

  const accentStyle = {
    '--srv-accent': activeServer.accentColor || 'var(--accent)',
  } as CSSProperties

  const handleCopyInvite = async () => {
    const built = servers.buildInviteLink(activeServer.id)
    if (!built) {
      engine.pushToast('warning', 'Invite unavailable for this server')
      return
    }
    try {
      await navigator.clipboard.writeText(built.url)
      setCopiedInvite(true)
      onPlaySound?.('click')
      engine.pushToast(
        'success',
        'Copied server invite link',
        activeServer.encrypted ? 'Contains AES-256-GCM key — share carefully' : undefined,
      )
      window.setTimeout(() => setCopiedInvite(false), 1800)
    } catch {
      engine.pushToast('error', 'Failed to copy invite link')
    }
  }

  const handleLeave = async () => {
    if (!confirmLeave) {
      setConfirmLeave(true)
      window.setTimeout(() => setConfirmLeave(false), 3500)
      return
    }
    setConfirmLeave(false)
    onPlaySound?.('click')
    await servers.leaveServer(activeServer.id)
    onLeftServer?.()
  }

  const handleInspectMember = (m: Nip29Member) => {
    if (!onInspectPeer) return
    const existing = engine.getPeerByPubkey(m.pubkey)
    if (existing) {
      onInspectPeer(existing)
      return
    }
    onInspectPeer({
      pubkey: m.pubkey,
      npub: m.npub,
      nickname: m.nickname,
      displayHandle: m.displayHandle,
      lastSeenAt: Math.floor(Date.now() / 1000),
      isOnline: true,
      isSelf: m.isSelf,
      isTeleported: false,
      isMeshBridge: false,
      isBlocked: engine.isPeerBlocked(m.pubkey),
      isTrusted: m.isTrusted,
      messageCount: 0,
      channels: [],
    })
  }

  const backingRelayUrls =
    activeServer.kind === 'nip29' && activeServer.relayUrl
      ? [activeServer.relayUrl]
      : activeServer.relays

  const relayStatusByUrl = new Map(engine.relays.map((r) => [r.url, r]))

  return (
    <div className="ag-panel ag-srv-info-panel" style={accentStyle}>
      {/* Server Hero Card */}
      <section className="ag-panel-card">
        <div className="ag-srv-info-hero">
          <div className="ag-srv-info-avatar">
            {activeServer.picture && /^https?:\/\//i.test(activeServer.picture) ? (
              <img src={activeServer.picture} alt="" referrerPolicy="no-referrer" />
            ) : activeServer.icon ? (
              <span>{activeServer.icon}</span>
            ) : (
              <span className="mono">{getMonogram(activeServer.name)}</span>
            )}
          </div>

          <div className="ag-srv-info-meta">
            <h3 className="ag-srv-info-name truncate" title={activeServer.name}>
              {activeServer.name}
            </h3>
            <div className="ag-srv-info-badges">
              {activeServer.kind === 'nip29' ? (
                <span className="ag-badge ag-badge-mesh">
                  <Server size={9} />
                  <span>NIP-29</span>
                </span>
              ) : activeServer.encrypted ? (
                <span className="ag-badge ag-badge-dm">
                  <Lock size={9} />
                  <span>E2EE</span>
                </span>
              ) : (
                <span className="ag-badge ag-badge-accent">PUBLIC</span>
              )}
              <span
                className="ag-badge ag-srv-saved-badge"
                title="Persistent history stored on relays — not ephemeral"
              >
                <Database size={9} />
                <span>SAVED</span>
              </span>
              <span className="ag-badge ag-badge-muted">{myRole.toUpperCase()}</span>
            </div>
          </div>
        </div>

        {activeServer.description && (
          <p className="ag-field-hint">{activeServer.description}</p>
        )}

        {activeChannel && (
          <div className="ag-srv-active-chan mono">
            <Hash size={12} />
            <span className="truncate">{activeChannel.name}</span>
            {activeChannel.topic && (
              <>
                <span className="ag-radar-hud-sep">·</span>
                <span className="truncate ag-tone-muted">{activeChannel.topic}</span>
              </>
            )}
          </div>
        )}

        <div className="ag-srv-info-actions">
          <button
            type="button"
            className="ag-btn ag-btn-primary ag-btn-sm"
            onClick={() => void handleCopyInvite()}
          >
            {copiedInvite ? <Check size={13} /> : <Copy size={13} />}
            <span>{copiedInvite ? 'Copied Link' : 'Copy Invite'}</span>
          </button>
          <button
            type="button"
            className="ag-btn ag-btn-dm ag-btn-sm"
            onClick={() => {
              onPlaySound?.('click')
              onOpenSettings(activeServer.id, 'overview')
            }}
          >
            <Send size={13} />
            <span>DM Invite</span>
          </button>
          <button
            type="button"
            className="ag-btn ag-btn-secondary ag-btn-sm"
            onClick={() => {
              onPlaySound?.('click')
              onOpenSettings(activeServer.id, 'overview')
            }}
          >
            <Settings size={13} />
            <span>Settings</span>
          </button>
          <button
            type="button"
            className="ag-btn ag-btn-danger-outline ag-btn-sm"
            onClick={() => void handleLeave()}
          >
            <LogOut size={13} />
            <span>{confirmLeave ? 'Confirm Leave' : 'Leave'}</span>
          </button>
        </div>
      </section>

      {/* Encryption & Media Trust Safety */}
      <section className="ag-panel-card">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <ShieldCheck size={13} />
            <span>SECURITY &amp; PRIVACY</span>
          </div>
        </div>

        {activeServer.encrypted ? (
          <div className="ag-blossom-e2ee-note">
            <Lock size={13} />
            <span>
              <strong>End-to-End Encrypted (AES-256-GCM)</strong> — messages, blinded channel tags,
              and Blossom voice memos are encrypted locally with this server&apos;s shared key.
            </span>
          </div>
        ) : activeServer.kind === 'nip29' ? (
          <div className="ag-srv-security-note">
            <Server size={13} />
            <span>
              <strong>Relay-Moderated (NIP-29)</strong> — membership and moderation are enforced by{' '}
              <code className="mono">{stripWs(activeServer.relayUrl || '')}</code>.
            </span>
          </div>
        ) : (
          <div className="ag-srv-security-note">
            <Radio size={13} />
            <span>
              <strong>Public Virtual Server</strong> — signed <code className="mono">kind: 30078</code>{' '}
              manifest &amp; <code className="mono">kind: 9</code> channels stored across Nostr relays.
            </span>
          </div>
        )}

        <div className="ag-srv-history-row">
          <Database size={12} />
          <span className="ag-srv-history-label mono">HISTORY</span>
          <span className="ag-srv-history-val">
            {activeServer.encrypted
              ? 'Encrypted & saved on relays · Not ephemeral'
              : 'Saved on relays · Not ephemeral'}
          </span>
        </div>

        <div className="ag-safety-notice">
          <ShieldAlert size={13} />
          <span>
            Voice memos &amp; media always require <strong>trusting the sender</strong> — zero bytes
            fetched from untrusted peers.
          </span>
        </div>
      </section>

      {/* Member & Moderator Roster */}
      <section className="ag-panel-card">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <Users size={13} />
            <span>ROSTER &amp; ROLES</span>
          </div>
          <span className="ag-chip ag-chip-mono">{members.length}</span>
        </div>

        {members.length === 0 ? (
          <p className="ag-field-hint">
            Active participants and server admins will appear here as they connect or speak.
          </p>
        ) : (
          <div className="ag-srv-member-list" role="list">
            {members.slice(0, 24).map((member) => {
              const isTrusted = !member.isSelf && engine.isExplicitlyTrusted(member.pubkey)
              return (
                <div key={member.pubkey} role="listitem" className="ag-peer-row">
                  <button
                    type="button"
                    className="ag-peer-main"
                    onClick={() => handleInspectMember(member)}
                  >
                    <img
                      src={identiconDataUrl(member.pubkey)}
                      alt=""
                      className="ag-whitelist-avatar"
                      width={26}
                      height={26}
                    />
                    <div className="ag-peer-info">
                      <div className="ag-peer-name-row">
                        <span
                          className="ag-peer-nick truncate"
                          style={{ color: pubkeyToColor(member.pubkey) }}
                        >
                          {member.displayHandle}
                        </span>
                        {member.isSelf && <span className="ag-badge ag-badge-accent">YOU</span>}
                      </div>
                      <div className="ag-peer-badges-row">
                        {member.isFounder && (
                          <span className="ag-badge ag-badge-warn">FOUNDER</span>
                        )}
                        {!member.isFounder && member.isAdmin && (
                          <span className="ag-badge ag-badge-mesh">ADMIN</span>
                        )}
                        {!member.isFounder &&
                          !member.isAdmin &&
                          member.roles.includes('mod') && (
                            <span className="ag-badge ag-badge-mesh">MOD</span>
                          )}
                        {isTrusted && (
                          <span className="ag-badge ag-badge-ok">
                            <ShieldCheck size={9} />
                            <span>TRUSTED</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </button>

                  {!member.isSelf && (
                    <div className="ag-peer-quick-actions">
                      <button
                        type="button"
                        className={`ag-icon-btn-xs ag-icon-btn-trust ${isTrusted ? 'trusted' : ''}`}
                        onClick={() => {
                          if (isTrusted) {
                            engine.untrustPubkey(member.pubkey)
                          } else {
                            engine.trustPubkey(member.pubkey, member.nickname)
                          }
                          onPlaySound?.('click')
                        }}
                        aria-pressed={isTrusted}
                        title={
                          isTrusted
                            ? `Untrust ${member.displayHandle}`
                            : `Trust ${member.displayHandle}`
                        }
                        aria-label={
                          isTrusted
                            ? `Untrust ${member.displayHandle}`
                            : `Trust ${member.displayHandle}`
                        }
                      >
                        {isTrusted ? <ShieldCheck size={12} /> : <Shield size={12} />}
                      </button>
                      <button
                        type="button"
                        className="ag-icon-btn-xs ag-icon-btn-dm"
                        onClick={() => onStartDm(member.pubkey, member.nickname)}
                        title={`Encrypted DM with ${member.displayHandle}`}
                        aria-label={`Encrypted DM with ${member.displayHandle}`}
                      >
                        <Lock size={12} />
                      </button>
                      {canModerate && !member.isFounder && (
                        <button
                          type="button"
                          className="ag-icon-btn-xs ag-icon-btn-danger"
                          onClick={() => {
                            void servers.banMember(activeServer.id, member.pubkey)
                            onPlaySound?.('click')
                          }}
                          title={`Ban ${member.displayHandle} from server`}
                          aria-label={`Ban ${member.displayHandle}`}
                        >
                          <Ban size={12} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Backing Relays */}
      {backingRelayUrls.length > 0 && (
        <section className="ag-panel-card">
          <div className="ag-panel-card-head">
            <div className="ag-panel-card-title">
              <Server size={13} />
              <span>BACKING RELAYS</span>
            </div>
            <span className="ag-panel-card-sub mono">{backingRelayUrls.length}</span>
          </div>

          <div className="ag-blossom-list">
            {backingRelayUrls.map((url) => {
              const tel = relayStatusByUrl.get(url)
              const ledClass =
                tel?.status === 'connected'
                  ? 'ag-led-ok'
                  : tel?.status === 'connecting' || tel?.status === 'degraded'
                    ? 'ag-led-warn'
                    : tel?.status === 'error'
                      ? 'ag-led-danger'
                      : 'ag-led-muted'
              return (
                <div key={url} className="ag-blossom-row">
                  <div className="ag-blossom-host-wrap">
                    <span className={`ag-led ${ledClass}`} />
                    <span className="ag-blossom-host mono truncate" title={url}>
                      {stripWs(url)}
                    </span>
                  </div>
                  {tel?.rttMs !== null && tel?.rttMs !== undefined && (
                    <span className="ag-panel-card-sub mono">{Math.round(tel.rttMs)}ms</span>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}

export default ServerInfoPanel
