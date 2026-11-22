import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  Ban,
  Loader2,
  Lock,
  Maximize2,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  User,
} from 'lucide-react'
import type { ImageAttachment } from '../types/protocol.ts'
import { formatImageBytes } from '../lib/imageProcessor.ts'
import type { LightboxImagePayload } from './ImageLightboxModal.tsx'

export type { LightboxImagePayload }

export interface ImageAttachmentCardProps {
  image: ImageAttachment
  senderPubkey: string
  senderNickname: string
  senderDisplayHandle: string
  isTrusted: boolean
  isDmMode?: boolean
  caption?: string
  fetchImageAttachmentBlob: (image: ImageAttachment, senderPubkey: string) => Promise<string>
  onTrustSender: (pubkey: string, nickname: string) => void
  onInspectSender: (pubkey: string, nickname: string) => void
  onBlockSender: (pubkey: string, displayHandle: string) => void
  onOpenLightbox: (payload: LightboxImagePayload) => void
}

function formatImageMeta(image: ImageAttachment): string {
  const dim = image.width > 0 && image.height > 0 ? `${image.width}×${image.height}` : ''
  const size = image.size > 0 ? formatImageBytes(image.size) : ''
  return [dim, size].filter(Boolean).join(' · ')
}

function computeAspectRatio(image: ImageAttachment): number {
  if (image.width > 0 && image.height > 0) {
    const raw = image.width / image.height
    return Math.max(0.68, Math.min(2.2, raw))
  }
  return 4 / 3
}

/* --------------------------------------------------------------------------
   INERT SHIELDED CARD — Mounted ONLY for untrusted senders.
   Contains ZERO <img> elements and ZERO fetchImageAttachmentBlob references.
   -------------------------------------------------------------------------- */
interface ShieldedImageCardProps {
  image: ImageAttachment
  senderPubkey: string
  senderNickname: string
  senderDisplayHandle: string
  isDmMode?: boolean
  onTrustSender: (pubkey: string, nickname: string) => void
  onInspectSender: (pubkey: string, nickname: string) => void
  onBlockSender: (pubkey: string, displayHandle: string) => void
}

function ShieldedImageCard({
  image,
  senderPubkey,
  senderNickname,
  senderDisplayHandle,
  isDmMode = false,
  onTrustSender,
  onInspectSender,
  onBlockSender,
}: ShieldedImageCardProps) {
  const isE2ee = Boolean(image.encryption)
  const metaSummary = formatImageMeta(image)

  return (
    <div
      className={`ag-img-shield-card ${isDmMode || isE2ee ? 'dm' : ''}`}
      role="region"
      aria-label={`Blocked image from untrusted sender ${senderDisplayHandle}`}
    >
      <div className="ag-img-shield-top">
        <div className="ag-img-shield-title-wrap">
          <span className="ag-img-shield-emblem" aria-hidden="true">
            {isE2ee ? <Lock size={14} /> : <ShieldAlert size={15} />}
          </span>
          <span className="ag-img-shield-title">Image · Untrusted Sender</span>
        </div>

        <div className="ag-img-shield-badges">
          {metaSummary && <span className="ag-badge muted tabular">{metaSummary}</span>}
          {isE2ee && (
            <span className="ag-badge dm" title="End-to-end encrypted image blob">
              <Lock size={9} />
              <span>E2EE</span>
            </span>
          )}
        </div>
      </div>

      <p className="ag-img-shield-note">
        Blocked until you trust <strong>{senderDisplayHandle}</strong> (zero bytes fetched)
      </p>

      <div className="ag-img-shield-actions">
        <button
          type="button"
          className="ag-img-shield-btn trust"
          onClick={() => onTrustSender(senderPubkey, senderNickname)}
          title={`Trust ${senderDisplayHandle} to unlock their images and voice memos`}
        >
          <ShieldCheck size={13} />
          <span>Trust {senderDisplayHandle}</span>
        </button>

        <button
          type="button"
          className="ag-img-shield-btn"
          onClick={() => onInspectSender(senderPubkey, senderNickname)}
          title={`Inspect ${senderDisplayHandle}`}
        >
          <User size={13} />
          <span>Inspect</span>
        </button>

        <button
          type="button"
          className="ag-img-shield-btn danger"
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
   TRUSTED IMAGE VIEW — Fetches, SHA-256 verifies & decrypts E2EE blobs.
   Mounted ONLY for own messages or explicitly Trusted Peers.
   -------------------------------------------------------------------------- */
interface TrustedImageViewProps {
  image: ImageAttachment
  senderPubkey: string
  senderDisplayHandle: string
  isDmMode?: boolean
  caption?: string
  fetchImageAttachmentBlob: (image: ImageAttachment, senderPubkey: string) => Promise<string>
  onOpenLightbox: (payload: LightboxImagePayload) => void
}

function TrustedImageView({
  image,
  senderPubkey,
  senderDisplayHandle,
  isDmMode = false,
  caption,
  fetchImageAttachmentBlob,
  onOpenLightbox,
}: TrustedImageViewProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)

  const isE2ee = Boolean(image.encryption)
  const isViolet = isDmMode || isE2ee
  const metaSummary = formatImageMeta(image)
  const aspectRatio = computeAspectRatio(image)

  const { url, mime, sha256, size, width, height, alt, server } = image
  const encAlg = image.encryption?.alg
  const encKeyB64 = image.encryption?.keyB64
  const encIvB64 = image.encryption?.ivB64
  const encPlainSha256 = image.encryption?.plaintextSha256

  const stableImage = useMemo<ImageAttachment>(
    () => ({
      url,
      mime,
      sha256,
      size,
      width,
      height,
      alt,
      server,
      encryption:
        encAlg && encKeyB64 && encIvB64 && encPlainSha256
          ? {
              alg: encAlg,
              keyB64: encKeyB64,
              ivB64: encIvB64,
              plaintextSha256: encPlainSha256,
            }
          : undefined,
    }),
    [url, mime, sha256, size, width, height, alt, server, encAlg, encKeyB64, encIvB64, encPlainSha256],
  )

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setBlobUrl(null)
    setErrorMsg(null)

    fetchImageAttachmentBlob(stableImage, senderPubkey)
      .then((resolvedUrl) => {
        if (cancelled) return
        setBlobUrl(resolvedUrl)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : 'Unable to fetch verified image'
        setErrorMsg(msg)
        setStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [stableImage, senderPubkey, fetchImageAttachmentBlob, retryNonce])

  if (status === 'error') {
    return (
      <div
        className={`ag-img-error-card ${isViolet ? 'dm' : ''}`}
        role="region"
        aria-label="Failed image attachment"
      >
        <div className="ag-img-error-msg">
          <AlertCircle size={15} />
          <span className="truncate" title={errorMsg ?? 'Failed to load image'}>
            {errorMsg || 'Failed to load image'}
          </span>
        </div>
        <button
          type="button"
          className="ag-img-retry-btn"
          onClick={() => setRetryNonce((n) => n + 1)}
        >
          <RotateCw size={12} />
          <span>Retry</span>
        </button>
      </div>
    )
  }

  if (status === 'loading' || !blobUrl) {
    return (
      <div
        className={`ag-img-card loading ${isViolet ? 'dm' : ''}`}
        style={{ aspectRatio: String(aspectRatio) }}
        aria-busy="true"
        aria-label={isE2ee ? 'Decrypting encrypted image' : 'Loading verified image'}
      >
        <div className="ag-img-skeleton">
          <div className="ag-img-skeleton-inner">
            <Loader2 size={18} className="ag-spin" />
            <span className="mono">{isE2ee ? 'Decrypting…' : 'Verifying…'}</span>
          </div>
          {metaSummary && (
            <span className="ag-img-chip mono ag-img-skeleton-meta">{metaSummary}</span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={`ag-img-card ready ${isViolet ? 'dm' : ''}`}>
      <button
        type="button"
        className="ag-img-frame-btn"
        onClick={() =>
          onOpenLightbox({
            blobUrl,
            image,
            senderDisplayHandle,
            caption,
          })
        }
        title="Click to inspect full resolution"
        aria-label={`Inspect image from ${senderDisplayHandle}${metaSummary ? ` (${metaSummary})` : ''}`}
      >
        <img
          src={blobUrl}
          alt={image.alt || caption || `Image from ${senderDisplayHandle}`}
          className="ag-img-media"
          loading="lazy"
        />

        <span className="ag-img-overlay" aria-hidden="true">
          <span className="ag-img-overlay-top">
            {isE2ee ? (
              <span className="ag-img-chip ag-img-chip-e2ee mono">
                <Lock size={9} />
                <span>E2EE</span>
              </span>
            ) : (
              <span />
            )}
            <span className="ag-img-expand-pill">
              <Maximize2 size={13} />
            </span>
          </span>

          {metaSummary && (
            <span className="ag-img-overlay-bottom">
              <span className="ag-img-chip mono">{metaSummary}</span>
            </span>
          )}
        </span>
      </button>
    </div>
  )
}

export function ImageAttachmentCard({
  image,
  senderPubkey,
  senderNickname,
  senderDisplayHandle,
  isTrusted,
  isDmMode = false,
  caption,
  fetchImageAttachmentBlob,
  onTrustSender,
  onInspectSender,
  onBlockSender,
  onOpenLightbox,
}: ImageAttachmentCardProps) {
  if (!isTrusted) {
    return (
      <ShieldedImageCard
        image={image}
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
    <TrustedImageView
      image={image}
      senderPubkey={senderPubkey}
      senderDisplayHandle={senderDisplayHandle}
      isDmMode={isDmMode}
      caption={caption}
      fetchImageAttachmentBlob={fetchImageAttachmentBlob}
      onOpenLightbox={onOpenLightbox}
    />
  )
}

export default ImageAttachmentCard
