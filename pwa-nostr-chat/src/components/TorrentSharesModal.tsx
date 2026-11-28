import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  Download,
  File as FileIcon,
  FileUp,
  Lock,
  RotateCcw,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type { TorrentEngine, TorrentShareRecord } from '../types/torrent.ts'
import { formatTorrentBytes, getTorrentFileExtension } from '../lib/torrentProtocol.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'

export interface TorrentSharesModalProps {
  open: boolean
  torrents: TorrentEngine
  onClose: () => void
}

function formatShareDate(tsMs: number): string {
  try {
    return new Date(tsMs).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

function sortShareGroup(items: readonly TorrentShareRecord[]): TorrentShareRecord[] {
  return [...items].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1
    return b.createdAt - a.createdAt
  })
}

export function TorrentSharesModal({ open, torrents, onClose }: TorrentSharesModalProps) {
  useBackHandler(open, onClose)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  const { ownShares, peerSeeds } = useMemo(() => {
    const own: TorrentShareRecord[] = []
    const peer: TorrentShareRecord[] = []
    for (const s of torrents.shares) {
      if (s.isReSeed) {
        peer.push(s)
      } else {
        own.push(s)
      }
    }
    return {
      ownShares: sortShareGroup(own),
      peerSeeds: sortShareGroup(peer),
    }
  }, [torrents.shares])

  if (!open || typeof document === 'undefined') return null

  const hasBothGroups = ownShares.length > 0 && peerSeeds.length > 0

  const renderShareItem = (share: TorrentShareRecord) => {
    const swarmId = share.swarmId.toLowerCase()
    const isPeerSeed = Boolean(share.isReSeed)
    const closedByOriginalSender = isPeerSeed && Boolean(torrents.closedBySender[swarmId])
    const isActive = share.status === 'active' && !closedByOriginalSender
    const ext = getTorrentFileExtension(share.fileName)

    return (
      <div
        key={swarmId}
        className={`ag-torrent-shares-item${isActive ? '' : ' is-closed'}`}
      >
        <div className="ag-torrent-shares-item-top">
          <span className="ag-torrent-shares-item-icon" aria-hidden="true">
            <FileIcon size={15} />
          </span>
          <div className="ag-torrent-shares-item-copy">
            <div className="ag-torrent-shares-item-name-row">
              <span className="ag-torrent-shares-item-name truncate" title={share.fileName}>
                {share.fileName}
              </span>
              {ext && <span className="ag-torrent-ext-pill mono">.{ext}</span>}
              <span className={`ag-torrent-role-pill${isPeerSeed ? ' is-peer' : ' is-own'}`}>
                {isPeerSeed ? 'Seeding Peer File' : 'Your Share'}
              </span>
              {isPeerSeed ? (
                closedByOriginalSender ? (
                  <span className="ag-torrent-status-pill is-closed">
                    <Lock size={10} aria-hidden="true" />
                    <span>Closed by sender</span>
                  </span>
                ) : isActive ? (
                  <span className="ag-torrent-status-pill is-seeding">
                    <span className="ag-torrent-live-dot" aria-hidden="true" />
                    <span>Seeding</span>
                  </span>
                ) : (
                  <span className="ag-torrent-status-pill is-muted">Not seeding</span>
                )
              ) : isActive ? (
                <span className="ag-torrent-status-pill is-seeding">No expiry</span>
              ) : (
                <span className="ag-torrent-status-pill is-closed">
                  <Lock size={10} aria-hidden="true" />
                  <span>Closed</span>
                </span>
              )}
            </div>
            <div className="ag-torrent-shares-item-meta mono tabular">
              <span>{formatTorrentBytes(share.size)}</span>
              <span>·</span>
              <span className="truncate">{share.targetLabel}</span>
              <span>·</span>
              <span>{formatShareDate(share.createdAt)}</span>
            </div>
            {(share.activePeerCount > 0 ||
              share.completedDownloads > 0 ||
              share.bytesUploaded > 0) && (
              <div className="ag-torrent-shares-item-stats mono tabular">
                <span>
                  {share.activePeerCount} {share.activePeerCount === 1 ? 'peer' : 'peers'}
                </span>
                <span>·</span>
                <span>
                  {share.completedDownloads}{' '}
                  {share.completedDownloads === 1 ? 'download' : 'downloads'}
                </span>
                <span>·</span>
                <span>{formatTorrentBytes(share.bytesUploaded)} uploaded</span>
              </div>
            )}
          </div>
        </div>

        <div className="ag-torrent-shares-item-actions">
          {isPeerSeed ? (
            <>
              {!closedByOriginalSender &&
                (isActive ? (
                  <button
                    type="button"
                    className="ag-torrent-btn"
                    onClick={() => torrents.stopReSeeding(swarmId)}
                    title="Stop seeding to other peers while keeping your local copy"
                  >
                    <Square size={11} aria-hidden="true" />
                    <span>Stop Seeding</span>
                  </button>
                ) : (
                  share.hasLocalData && (
                    <button
                      type="button"
                      className="ag-torrent-btn primary"
                      onClick={() => void torrents.resumeReSeeding(swarmId)}
                      title="Resume seeding this verified file to trusted peers"
                    >
                      <Upload size={12} aria-hidden="true" />
                      <span>Seed to Swarm</span>
                    </button>
                  )
                ))}

              {share.hasLocalData && (
                <button
                  type="button"
                  className="ag-torrent-btn"
                  onClick={() => void torrents.saveLocalFile(swarmId)}
                >
                  <Download size={12} aria-hidden="true" />
                  <span>Save</span>
                </button>
              )}

              <button
                type="button"
                className="ag-torrent-btn danger-ghost"
                onClick={() => void torrents.removeDownloadedSeed(swarmId)}
                title="Stop seeding and delete local downloaded seed pieces"
              >
                <Trash2 size={12} aria-hidden="true" />
                <span>Remove</span>
              </button>
            </>
          ) : (
            <>
              {isActive ? (
                <button
                  type="button"
                  className="ag-torrent-btn danger-ghost"
                  onClick={() => void torrents.closeShareDownloads(swarmId)}
                >
                  <Lock size={12} aria-hidden="true" />
                  <span>Close Downloads</span>
                </button>
              ) : (
                share.hasLocalData && (
                  <button
                    type="button"
                    className="ag-torrent-btn"
                    onClick={() => void torrents.reopenShareDownloads(swarmId)}
                  >
                    <RotateCcw size={12} aria-hidden="true" />
                    <span>Reopen</span>
                  </button>
                )
              )}

              {share.hasLocalData && (
                <button
                  type="button"
                  className="ag-torrent-btn"
                  onClick={() => void torrents.saveLocalFile(swarmId)}
                >
                  <Download size={12} aria-hidden="true" />
                  <span>Save</span>
                </button>
              )}

              <button
                type="button"
                className="ag-torrent-btn danger-ghost"
                onClick={() => void torrents.deleteShareLocalData(swarmId)}
              >
                <Trash2 size={12} aria-hidden="true" />
                <span>Delete local copy</span>
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  return createPortal(
    <div className="ag-torrent-shares-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="ag-torrent-shares-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-torrent-shares-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ag-torrent-shares-modal-head">
          <div className="ag-torrent-shares-modal-head-left">
            <span className="ag-torrent-shares-modal-icon" aria-hidden="true">
              <FileUp size={17} />
            </span>
            <div className="ag-torrent-shares-modal-copy">
              <div className="ag-torrent-shares-modal-title-row">
                <h2 id="ag-torrent-shares-title" className="ag-torrent-shares-modal-title">
                  P2P File Shares &amp; Seeds
                </h2>
                <span className="ag-badge ag-badge-muted mono tabular">
                  {torrents.activeShareCount} seeding
                </span>
              </div>
              <p className="ag-torrent-shares-modal-sub">
                Your shares have no expiry · Downloaded peer files can also seed to trusted peers
              </p>
            </div>
          </div>

          <button
            type="button"
            className="ag-torrent-shares-modal-close"
            onClick={onClose}
            aria-label="Close P2P shares manager"
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </header>

        <div className="ag-torrent-shares-modal-body">
          {ownShares.length === 0 && peerSeeds.length === 0 ? (
            <div className="ag-torrent-shares-empty">
              <p className="ag-torrent-shares-empty-title">No files currently shared or seeded</p>
              <p className="ag-torrent-shares-empty-copy">
                Attach any file from a chat composer to share via E2EE P2P, or download a trusted
                peer&apos;s file to help seed the swarm.
              </p>
            </div>
          ) : (
            <div className="ag-torrent-shares-list">
              {ownShares.length > 0 && (
                <>
                  {hasBothGroups && (
                    <div className="ag-torrent-shares-group-title">
                      Your Shares ({ownShares.length})
                    </div>
                  )}
                  {ownShares.map(renderShareItem)}
                </>
              )}

              {peerSeeds.length > 0 && (
                <>
                  {hasBothGroups && (
                    <div className="ag-torrent-shares-group-title">
                      Seeding Peer Files ({peerSeeds.length})
                    </div>
                  )}
                  {peerSeeds.map(renderShareItem)}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default TorrentSharesModal
