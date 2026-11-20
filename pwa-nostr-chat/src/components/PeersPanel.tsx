import { useMemo, useState } from 'react'
import {
  AtSign,
  Ban,
  HelpCircle,
  Lock,
  Radio,
  Search,
  ShieldOff,
  Users,
  X,
} from 'lucide-react'
import type { AgnostrEngine, PeerInfo } from '../types/protocol.ts'
import { formatHandle, identiconDataUrl, pubkeyToColor } from '../utils/identicon.ts'

export interface PeersPanelProps {
  engine: AgnostrEngine
  onInspectPeer: (peer: PeerInfo) => void
  onStartDm: (pubkey: string, nickname?: string) => void
  onMentionPeer: (handle: string) => void
}

type PeerFilterMode = 'all' | 'online' | 'blocked'

function formatRelativeSeconds(unixSec: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSec)
  if (diff < 30) return 'now'
  if (diff < 60) return `${diff}s ago`
  const mins = Math.floor(diff / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export function PeersPanel({
  engine,
  onInspectPeer,
  onStartDm,
  onMentionPeer,
}: PeersPanelProps) {
  const { peers, presence, activeGeohash, cell, blockedPubkeys } = engine
  const [query, setQuery] = useState('')
  const [filterMode, setFilterMode] = useState<PeerFilterMode>('all')

  const filteredPeers = useMemo(() => {
    const q = query.trim().toLowerCase()
    return peers
      .filter((peer) => {
        if (filterMode === 'online' && !peer.isOnline) return false
        if (filterMode === 'blocked' && !peer.isBlocked) return false
        if (!q) return true
        return (
          peer.nickname.toLowerCase().includes(q) ||
          peer.displayHandle.toLowerCase().includes(q) ||
          peer.pubkey.toLowerCase().includes(q) ||
          peer.npub.toLowerCase().includes(q)
        )
      })
      .sort((a, b) => {
        if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
        if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1
        return b.lastSeenAt - a.lastSeenAt
      })
  }, [peers, query, filterMode])

  const blockedInChannelCount = useMemo(
    () => peers.filter((p) => p.isBlocked).length,
    [peers],
  )

  return (
    <div className="ag-panel ag-peers-panel">
      {/* Presence Summary Header */}
      <section className="ag-panel-card ag-peers-summary">
        <div className="ag-panel-card-head">
          <div className="ag-panel-card-title">
            <Users size={13} />
            <span>#{activeGeohash} ROSTER</span>
          </div>
          <div className="ag-peers-count-pill mono">
            {presence.isUncertainCount ? (
              <span
                className="ag-uncertain-badge"
                title="Presence heartbeats are suppressed at precision ≥6 for location privacy. Peers appear once they transmit."
              >
                <HelpCircle size={12} />
                <span>? online</span>
              </span>
            ) : (
              <span className="ag-online-count">
                <span className={`ag-led ${presence.onlineCount > 0 ? 'ag-led-ok ag-led-pulse' : 'ag-led-muted'}`} />
                {presence.onlineCount} online
              </span>
            )}
          </div>
        </div>

        <div className="ag-peers-meta-row">
          <span className="mono">{presence.totalSeenCount} seen</span>
          {presence.isBroadcastingPresence ? (
            <span className="ag-badge ag-badge-ok">
              <Radio size={10} />
              <span>BEACON ON</span>
            </span>
          ) : !cell.allowsPresence ? (
            <span
              className="ag-badge ag-badge-warn"
              title="High-precision rooms (≥6 chars) suppress kind:20001 presence broadcasts to protect your exact location"
            >
              <ShieldOff size={10} />
              <span>PRECISION ≥6</span>
            </span>
          ) : (
            <span className="ag-badge ag-badge-muted">SILENT MODE</span>
          )}
        </div>

        {presence.isUncertainCount && (
          <p className="ag-field-hint">
            Presence heartbeats are disabled at <strong>{cell.label}</strong> precision to protect
            exact coordinates. Active peers appear as soon as they speak.
          </p>
        )}
      </section>

      {/* Search & Filter */}
      <div className="ag-peers-controls">
        <div className="ag-search-field">
          <Search size={13} className="ag-search-icon" />
          <input
            type="text"
            className="ag-input ag-search-input"
            placeholder="Filter peers, @nick, npub…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter active channel peers"
          />
          {query && (
            <button
              type="button"
              className="ag-search-clear"
              onClick={() => setQuery('')}
              aria-label="Clear peer filter"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="ag-segmented-sm" role="tablist" aria-label="Filter peers by status">
          <button
            type="button"
            role="tab"
            aria-selected={filterMode === 'all'}
            className={filterMode === 'all' ? 'active' : ''}
            onClick={() => setFilterMode('all')}
          >
            All ({peers.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filterMode === 'online'}
            className={filterMode === 'online' ? 'active' : ''}
            onClick={() => setFilterMode('online')}
          >
            Online ({presence.onlineCount})
          </button>
          {(blockedInChannelCount > 0 || blockedPubkeys.length > 0) && (
            <button
              type="button"
              role="tab"
              aria-selected={filterMode === 'blocked'}
              className={filterMode === 'blocked' ? 'active' : ''}
              onClick={() => setFilterMode('blocked')}
            >
              Muted ({blockedInChannelCount})
            </button>
          )}
        </div>
      </div>

      {/* Peer List */}
      <div className="ag-peer-list" role="list">
        {filteredPeers.length === 0 ? (
          <div className="ag-empty-panel">
            <Users size={20} className="ag-empty-icon" />
            <p className="ag-empty-title">
              {query
                ? 'No matching peers'
                : presence.isUncertainCount
                  ? 'Presence uncertain (?)'
                  : 'Quiet frequency'}
            </p>
            <p className="ag-empty-sub">
              {query
                ? 'Try clearing the search filter.'
                : presence.isUncertainCount
                  ? 'Peers at this precision appear once they send a message.'
                  : 'Peers tuning into this geohash will appear here automatically.'}
            </p>
          </div>
        ) : (
          filteredPeers.map((peer) => {
            const handle = formatHandle(peer.nickname, peer.pubkey)
            const handleColor = pubkeyToColor(peer.pubkey)
            return (
              <div
                key={peer.pubkey}
                role="listitem"
                className={`ag-peer-row ${peer.isBlocked ? 'blocked' : ''}`}
              >
                <button
                  type="button"
                  className="ag-peer-main"
                  onClick={() => onInspectPeer(peer)}
                >
                  <div className="ag-peer-avatar-wrap">
                    <img
                      src={identiconDataUrl(peer.pubkey)}
                      alt=""
                      className="ag-peer-avatar"
                      width={32}
                      height={32}
                    />
                    <span
                      className={`ag-peer-dot ${peer.isOnline ? 'online' : 'offline'}`}
                      aria-label={peer.isOnline ? 'Online' : 'Recently seen'}
                    />
                  </div>

                  <div className="ag-peer-info">
                    <div className="ag-peer-name-row">
                      <span className="ag-peer-nick truncate" style={{ color: handleColor }}>
                        @{handle.base}
                      </span>
                      <span className="ag-peer-suffix mono">#{handle.suffix}</span>
                      {peer.isSelf && <span className="ag-badge ag-badge-accent">YOU</span>}
                    </div>

                    <div className="ag-peer-badges-row">
                      {peer.isTeleported && (
                        <span className="ag-badge ag-badge-warn">TELEPORT</span>
                      )}
                      {peer.isMeshBridge && (
                        <span className="ag-badge ag-badge-mesh">MESH BRIDGE</span>
                      )}
                      {peer.isBlocked && (
                        <span className="ag-badge ag-badge-danger">
                          <Ban size={9} />
                          MUTED
                        </span>
                      )}
                      <span className="ag-peer-sub mono">
                        {formatRelativeSeconds(peer.lastSeenAt)} · {peer.messageCount}{' '}
                        {peer.messageCount === 1 ? 'msg' : 'msgs'}
                      </span>
                    </div>
                  </div>
                </button>

                <div className="ag-peer-quick-actions">
                  <button
                    type="button"
                    className="ag-icon-btn-xs"
                    onClick={() => onMentionPeer(peer.displayHandle)}
                    title={`Mention ${peer.displayHandle}`}
                    aria-label={`Mention ${peer.displayHandle}`}
                  >
                    <AtSign size={13} />
                  </button>
                  {!peer.isSelf && (
                    <button
                      type="button"
                      className="ag-icon-btn-xs ag-icon-btn-dm"
                      onClick={() => onStartDm(peer.pubkey, peer.nickname)}
                      title={`Encrypted DM with ${peer.displayHandle}`}
                      aria-label={`Start encrypted DM with ${peer.displayHandle}`}
                    >
                      <Lock size={13} />
                    </button>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
