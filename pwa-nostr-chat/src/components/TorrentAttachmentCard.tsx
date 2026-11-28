import { useEffect } from 'react'
import {
  AlertCircle,
  Ban,
  Bluetooth,
  CheckCircle2,
  Download,
  File as FileIcon,
  FileWarning,
  HardDrive,
  Loader2,
  Lock,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  User,
  X,
} from 'lucide-react'
import type { TorrentAttachment, TorrentEngine, TorrentTransferPhase } from '../types/torrent.ts'
import {
  formatTorrentBytes,
  formatTorrentSpeed,
  getTorrentFileExtension,
  isRiskyExecutableExtension,
} from '../lib/torrentProtocol.ts'

export interface TorrentAttachmentCardProps {
  torrent: TorrentAttachment
  senderPubkey: string
  senderNickname: string
  senderDisplayHandle: string
  isTrusted: boolean
  isOwn?: boolean
  isDmMode?: boolean
  torrents: TorrentEngine
  onTrustSender: (pubkey: string, nickname: string) => void
  onInspectSender: (pubkey: string, nickname: string) => void
  onBlockSender: (pubkey: string, displayHandle: string) => void
}

function isTransferInFlight(phase: TorrentTransferPhase | undefined): boolean {
  return (
    phase === 'checking' ||
    phase === 'waiting' ||
    phase === 'connecting' ||
    phase === 'downloading' ||
    phase === 'verifying'
  )
}

function phaseStatusText(phase: TorrentTransferPhase, isBleMesh = false): string {
  switch (phase) {
    case 'checking':
      return 'Checking share availability…'
    case 'waiting':
      return isBleMesh
        ? 'Waiting for peer over BLE Mesh…'
        : 'Waiting for sender to come online…'
    case 'connecting':
      return isBleMesh ? 'Bridging via BLE Mesh…' : 'Connecting to trusted peers…'
    case 'downloading':
      return isBleMesh ? 'Downloading via BLE Mesh…' : 'Downloading via E2EE P2P…'
    case 'verifying':
      return 'Verifying SHA-256 integrity…'
    case 'completed':
      return 'Verified & Downloaded'
    case 'seeding':
      return 'Seeding to trusted peers'
    case 'closed':
      return 'Downloads closed by sender'
    case 'error':
      return 'Transfer interrupted'
    default:
      return 'Ready for P2P download'
  }
}

/* --------------------------------------------------------------------------
   INERT SHIELDED TORRENT CARD — Mounted EXCLUSIVELY when !isOwn && !isTrusted.
   Receives ZERO TorrentEngine reference: ZERO network requests, ZERO status
   probes, ZERO download buttons, ZERO RTCPeerConnection creation.
   -------------------------------------------------------------------------- */
interface ShieldedTorrentCardProps {
  torrent: TorrentAttachment
  senderPubkey: string
  senderNickname: string
  senderDisplayHandle: string
  isDmMode?: boolean
  onTrustSender: (pubkey: string, nickname: string) => void
  onInspectSender: (pubkey: string, nickname: string) => void
  onBlockSender: (pubkey: string, displayHandle: string) => void
}

function ShieldedTorrentCard({
  torrent,
  senderPubkey,
  senderNickname,
  senderDisplayHandle,
  isDmMode = false,
  onTrustSender,
  onInspectSender,
  onBlockSender,
}: ShieldedTorrentCardProps) {
  const sizeLabel = formatTorrentBytes(torrent.size)

  return (
    <div
      className={`ag-torrent-shield-card${isDmMode ? ' dm' : ''}`}
      role="region"
      aria-label={`Blocked P2P file from untrusted sender ${senderDisplayHandle}`}
    >
      <div className="ag-torrent-shield-top">
        <div className="ag-torrent-shield-title-wrap">
          <span className="ag-torrent-shield-emblem" aria-hidden="true">
            <ShieldAlert size={15} />
          </span>
          <span className="ag-torrent-shield-title">P2P File · Untrusted Sender</span>
        </div>
        <div className="ag-torrent-shield-badges">
          <span className="ag-badge muted tabular">{sizeLabel}</span>
          <span className="ag-badge dm" title="End-to-end encrypted P2P torrent">
            <Lock size={9} />
            <span>E2EE P2P</span>
          </span>
        </div>
      </div>

      <p className="ag-torrent-shield-note">
        Blocked until you trust <strong>{senderDisplayHandle}</strong> (zero P2P connections made)
      </p>

      <div className="ag-torrent-shield-actions">
        <button
          type="button"
          className="ag-torrent-shield-btn trust"
          onClick={() => onTrustSender(senderPubkey, senderNickname)}
          title={`Trust ${senderDisplayHandle}`}
        >
          <ShieldCheck size={13} />
          <span>Trust {senderDisplayHandle}</span>
        </button>

        <button
          type="button"
          className="ag-torrent-shield-btn"
          onClick={() => onInspectSender(senderPubkey, senderNickname)}
          title={`Inspect ${senderDisplayHandle}`}
        >
          <User size={13} />
          <span>Inspect</span>
        </button>

        <button
          type="button"
          className="ag-torrent-shield-btn danger"
          onClick={() => onBlockSender(senderPubkey, senderDisplayHandle)}
          title={`Block ${senderDisplayHandle}`}
        >
          <Ban size={13} />
          <span>Block</span>
        </button>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------------
   TRUSTED TORRENT CARD — Mounted ONLY when isOwn || isTrusted.
   All non-own downloads ALWAYS route through torrents.requestDownload(...)
   so the mandatory disclaimer popup is never bypassed.
   -------------------------------------------------------------------------- */
interface TrustedTorrentCardProps {
  torrent: TorrentAttachment
  senderPubkey: string
  senderNickname: string
  senderDisplayHandle: string
  isOwn: boolean
  isDmMode: boolean
  torrents: TorrentEngine
}

function TrustedTorrentCard({
  torrent,
  senderPubkey,
  senderNickname,
  senderDisplayHandle,
  isOwn,
  isDmMode,
  torrents,
}: TrustedTorrentCardProps) {
  const { checkRemoteStatus } = torrents

  useEffect(() => {
    if (isOwn) return
    void checkRemoteStatus(torrent, senderPubkey)
  }, [isOwn, torrent, senderPubkey, checkRemoteStatus])

  const share = torrents.getShare(torrent.infoHash)
  const peerSeed = !isOwn && share?.isReSeed ? share : undefined
  const transfer = torrents.transfers[torrent.infoHash]
  const closedAt = torrents.closedBySender[torrent.infoHash]
  const ext = getTorrentFileExtension(torrent.fileName)
  const isRisky = isRiskyExecutableExtension(torrent.fileName)

  const isClosedByOriginalSender = isOwn
    ? share
      ? share.status === 'closed'
      : Boolean(closedAt)
    : Boolean(closedAt) || (!peerSeed && transfer?.phase === 'closed')

  const inFlight = !isOwn && isTransferInFlight(transfer?.phase)
  const isCompleted =
    !isOwn &&
    Boolean(
      transfer?.completedAvailable ||
        transfer?.phase === 'completed' ||
        transfer?.phase === 'seeding' ||
        peerSeed?.hasLocalData,
    )
  const isActivelyReSeeding =
    !isOwn &&
    !isClosedByOriginalSender &&
    Boolean(transfer?.isReSeeding || (peerSeed && peerSeed.status === 'active' && peerSeed.hasLocalData))
  const isClosed = isClosedByOriginalSender
  const isBleMeshTransport = transfer?.transport === 'ble-mesh'

  const pct =
    transfer && transfer.totalBytes > 0
      ? Math.max(0, Math.min(100, Math.round((transfer.bytesTransferred / transfer.totalBytes) * 100)))
      : transfer && transfer.pieceCount > 0
        ? Math.max(0, Math.min(100, Math.round((transfer.piecesCompleted / transfer.pieceCount) * 100)))
        : 0

  return (
    <div
      className={`ag-torrent-card${isDmMode ? ' dm' : ''}${isClosed ? ' is-closed' : ''}${
        isCompleted ? ' is-completed' : ''
      }`}
      role="region"
      aria-label={`P2P file ${torrent.fileName} (${formatTorrentBytes(torrent.size)})`}
    >
      {/* File Header */}
      <div className="ag-torrent-card-head">
        <span className={`ag-torrent-card-icon${isRisky ? ' is-risky' : ''}`} aria-hidden="true">
          {isRisky ? <FileWarning size={17} /> : <FileIcon size={17} />}
        </span>

        <div className="ag-torrent-card-copy">
          <div className="ag-torrent-card-name-row">
            <span className="ag-torrent-card-name truncate" title={torrent.fileName}>
              {torrent.fileName}
            </span>
            {ext && (
              <span className={`ag-torrent-ext-pill mono${isRisky ? ' is-risky' : ''}`}>
                .{ext}
              </span>
            )}
          </div>
          <div className="ag-torrent-card-meta mono tabular">
            <span>{formatTorrentBytes(torrent.size)}</span>
            <span>·</span>
            <span>
              {torrent.pieceCount} {torrent.pieceCount === 1 ? 'piece' : 'pieces'}
            </span>
            <span className="ag-torrent-e2ee-tag">
              <Lock size={9} aria-hidden="true" />
              <span>E2EE P2P</span>
            </span>
            {isBleMeshTransport && (
              <span
                className="ag-torrent-mesh-tag"
                title="Transferred over E2EE Bluetooth Mesh bridge"
              >
                <Bluetooth size={9} aria-hidden="true" />
                <span>BLE Mesh</span>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Sender (Own) Controls */}
      {isOwn ? (
        <div className="ag-torrent-card-footer">
          <div className="ag-torrent-status-row">
            {isClosed ? (
              <span className="ag-torrent-status-pill is-closed">
                <Lock size={11} aria-hidden="true" />
                <span>Downloads closed</span>
              </span>
            ) : share && !share.hasLocalData ? (
              <span className="ag-torrent-status-pill is-muted">
                <HardDrive size={11} aria-hidden="true" />
                <span>Local copy removed</span>
              </span>
            ) : (
              <span className="ag-torrent-status-pill is-seeding">
                <span className="ag-torrent-live-dot" aria-hidden="true" />
                <span>Seeding · No expiry</span>
              </span>
            )}

            {share &&
              (share.activePeerCount > 0 ||
                share.completedDownloads > 0 ||
                share.bytesUploaded > 0) && (
                <span className="ag-torrent-stats mono tabular">
                  {share.activePeerCount > 0
                    ? `${share.activePeerCount} ${share.activePeerCount === 1 ? 'peer' : 'peers'}`
                    : null}
                  {share.activePeerCount > 0 &&
                  (share.completedDownloads > 0 || share.bytesUploaded > 0)
                    ? ' · '
                    : null}
                  {share.completedDownloads > 0
                    ? `${share.completedDownloads} ${share.completedDownloads === 1 ? 'dl' : 'dls'}`
                    : null}
                  {share.completedDownloads > 0 && share.bytesUploaded > 0 ? ' · ' : null}
                  {share.bytesUploaded > 0 ? `${formatTorrentBytes(share.bytesUploaded)} sent` : null}
                </span>
              )}
          </div>

          <div className="ag-torrent-actions">
            {!isClosed ? (
              <button
                type="button"
                className="ag-torrent-btn danger-ghost"
                onClick={() => void torrents.closeShareDownloads(torrent.infoHash)}
                title="Immediately disconnect peers and prevent future downloads"
              >
                <Lock size={12} aria-hidden="true" />
                <span>Close Downloads</span>
              </button>
            ) : (
              <>
                {share?.hasLocalData && (
                  <button
                    type="button"
                    className="ag-torrent-btn"
                    onClick={() => void torrents.reopenShareDownloads(torrent.infoHash)}
                    title="Resume seeding this file to trusted peers"
                  >
                    <RotateCcw size={12} aria-hidden="true" />
                    <span>Reopen</span>
                  </button>
                )}
                {share && (
                  <button
                    type="button"
                    className="ag-torrent-btn danger-ghost"
                    onClick={() => void torrents.deleteShareLocalData(torrent.infoHash)}
                    title="Delete local encrypted pieces from this device"
                  >
                    <Trash2 size={12} aria-hidden="true" />
                    <span>Delete local copy</span>
                  </button>
                )}
              </>
            )}

            {share?.hasLocalData && (
              <button
                type="button"
                className="ag-torrent-btn"
                onClick={() => void torrents.saveLocalFile(torrent.infoHash)}
                title="Save a local copy of this file"
              >
                <Download size={12} aria-hidden="true" />
                <span>Save copy</span>
              </button>
            )}
          </div>
        </div>
      ) : inFlight && transfer ? (
        /* Receiver Active Transfer Progress */
        <div className="ag-torrent-progress-wrap" aria-live="polite">
          <div className="ag-torrent-progress-head">
            <span className="ag-torrent-progress-label">
              <Loader2 size={12} className="ag-spin" aria-hidden="true" />
              <span>{phaseStatusText(transfer.phase, isBleMeshTransport)}</span>
            </span>
            <span className="ag-torrent-progress-pct mono tabular">{pct}%</span>
          </div>

          <div
            className="ag-torrent-progress-track"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span
              className={`ag-torrent-progress-fill${
                transfer.phase === 'waiting' || transfer.phase === 'checking'
                  ? ' is-indeterminate'
                  : ''
              }`}
              style={{ width: `${Math.max(4, pct)}%` }}
            />
          </div>

          <div className="ag-torrent-progress-footer">
            <span className="ag-torrent-stats mono tabular">
              {formatTorrentBytes(transfer.bytesTransferred)} /{' '}
              {formatTorrentBytes(transfer.totalBytes || torrent.size)} · {transfer.piecesCompleted}/
              {transfer.pieceCount || torrent.pieceCount} pcs
              {transfer.speedBytesPerSec > 0
                ? ` · ${formatTorrentSpeed(transfer.speedBytesPerSec)}`
                : ''}
              {transfer.connectedPeers > 0
                ? ` · ${transfer.connectedPeers} ${transfer.connectedPeers === 1 ? 'peer' : 'peers'}`
                : ''}
            </span>
            <button
              type="button"
              className="ag-torrent-btn"
              onClick={() => torrents.cancelDownload(torrent.infoHash)}
            >
              <X size={12} aria-hidden="true" />
              <span>Cancel</span>
            </button>
          </div>
        </div>
      ) : isCompleted ? (
        /* Receiver Verified & Downloaded (with persistent peer swarm seeding controls) */
        <div className="ag-torrent-card-footer">
          <div className="ag-torrent-status-row">
            {isClosedByOriginalSender ? (
              <>
                <span className="ag-torrent-status-pill is-closed">
                  <Lock size={11} aria-hidden="true" />
                  <span>Downloads closed by sender</span>
                </span>
                <span className="ag-torrent-stats">Seeding halted</span>
              </>
            ) : isActivelyReSeeding ? (
              <>
                <span className="ag-torrent-status-pill is-seeding">
                  <span className="ag-torrent-live-dot" aria-hidden="true" />
                  <span>Seeding to swarm</span>
                </span>
                {peerSeed &&
                  (peerSeed.activePeerCount > 0 ||
                    peerSeed.bytesUploaded > 0 ||
                    peerSeed.completedDownloads > 0) && (
                    <span className="ag-torrent-stats mono tabular">
                      {peerSeed.activePeerCount > 0
                        ? `${peerSeed.activePeerCount} ${peerSeed.activePeerCount === 1 ? 'peer' : 'peers'}`
                        : null}
                      {peerSeed.activePeerCount > 0 &&
                      (peerSeed.completedDownloads > 0 || peerSeed.bytesUploaded > 0)
                        ? ' · '
                        : null}
                      {peerSeed.completedDownloads > 0
                        ? `${peerSeed.completedDownloads} ${peerSeed.completedDownloads === 1 ? 'dl' : 'dls'}`
                        : null}
                      {peerSeed.completedDownloads > 0 && peerSeed.bytesUploaded > 0 ? ' · ' : null}
                      {peerSeed.bytesUploaded > 0
                        ? `${formatTorrentBytes(peerSeed.bytesUploaded)} sent`
                        : null}
                    </span>
                  )}
              </>
            ) : (
              <span className="ag-torrent-status-pill is-muted">
                <CheckCircle2 size={12} aria-hidden="true" />
                <span>Downloaded · Not seeding</span>
              </span>
            )}
          </div>

          <div className="ag-torrent-actions">
            {!isClosedByOriginalSender && !isActivelyReSeeding && (
              <button
                type="button"
                className="ag-torrent-btn primary"
                onClick={() => void torrents.resumeReSeeding(torrent.infoHash)}
                title="Resume seeding this verified file to trusted peers"
              >
                <Upload size={12} aria-hidden="true" />
                <span>Seed to Swarm</span>
              </button>
            )}

            <button
              type="button"
              className={`ag-torrent-btn${isClosedByOriginalSender || isActivelyReSeeding ? ' primary' : ''}`}
              onClick={() => void torrents.saveLocalFile(torrent.infoHash)}
            >
              <Download size={12} aria-hidden="true" />
              <span>Save File</span>
            </button>

            {isActivelyReSeeding && (
              <button
                type="button"
                className="ag-torrent-btn"
                onClick={() => torrents.stopReSeeding(torrent.infoHash)}
                title="Stop seeding to other peers while keeping your local copy"
              >
                <Square size={11} aria-hidden="true" />
                <span>Stop Seeding</span>
              </button>
            )}

            <button
              type="button"
              className="ag-torrent-btn danger-ghost"
              onClick={() => void torrents.removeDownloadedSeed(torrent.infoHash)}
              title="Stop seeding and delete the local encrypted copy from this device"
            >
              <Trash2 size={12} aria-hidden="true" />
              <span>{isActivelyReSeeding ? 'Remove local seed' : 'Remove local copy'}</span>
            </button>
          </div>
        </div>
      ) : isClosed ? (
        /* Receiver Closed By Sender */
        <div className="ag-torrent-card-footer">
          <div className="ag-torrent-status-row">
            <span className="ag-torrent-status-pill is-closed">
              <Lock size={11} aria-hidden="true" />
              <span>Downloads closed by sender</span>
            </span>
          </div>
          <div className="ag-torrent-actions">
            <button type="button" className="ag-torrent-btn" disabled>
              <Download size={12} aria-hidden="true" />
              <span>Download via P2P</span>
            </button>
          </div>
        </div>
      ) : (
        /* Receiver Idle / Error — ALWAYS invokes requestDownload (never bypasses disclaimer!) */
        <div className="ag-torrent-card-footer">
          {transfer?.phase === 'error' && transfer.error && (
            <div className="ag-torrent-error-row" role="alert">
              <AlertCircle size={12} aria-hidden="true" />
              <span className="truncate" title={transfer.error}>
                {transfer.error}
              </span>
            </div>
          )}
          <div className="ag-torrent-actions">
            <button
              type="button"
              className="ag-torrent-btn primary"
              onClick={() =>
                torrents.requestDownload(
                  torrent,
                  senderPubkey,
                  senderNickname,
                  senderDisplayHandle,
                )
              }
            >
              <Download size={12} aria-hidden="true" />
              <span>Download via P2P</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function TorrentAttachmentCard({
  torrent,
  senderPubkey,
  senderNickname,
  senderDisplayHandle,
  isTrusted,
  isOwn = false,
  isDmMode = false,
  torrents,
  onTrustSender,
  onInspectSender,
  onBlockSender,
}: TorrentAttachmentCardProps) {
  if (!isOwn && !isTrusted) {
    return (
      <ShieldedTorrentCard
        torrent={torrent}
        senderPubkey={senderPubkey}
        senderNickname={senderNickname}
        senderDisplayHandle={senderDisplayHandle}
        isDmMode={isDmMode}
        onTrustSender={onTrustSender}
        onInspectSender={onInspectSender}
        onBlockSender={onBlockSender}
      />
    )
  }

  return (
    <TrustedTorrentCard
      torrent={torrent}
      senderPubkey={senderPubkey}
      senderNickname={senderNickname}
      senderDisplayHandle={senderDisplayHandle}
      isOwn={isOwn}
      isDmMode={isDmMode}
      torrents={torrents}
    />
  )
}

export default TorrentAttachmentCard
