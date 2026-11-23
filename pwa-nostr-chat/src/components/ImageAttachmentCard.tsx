import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Ban,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Maximize2,
  RotateCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  User,
} from 'lucide-react'
import type { ImageAttachment } from '../types/protocol.ts'
import type { ContentFilterCategory, ContentFilterEngine } from '../types/contentFilter.ts'
import { formatImageBytes } from '../lib/imageProcessor.ts'
import type { LightboxImagePayload } from './ImageLightboxModal.tsx'

export type { LightboxImagePayload }

export interface ImageAttachmentCardProps {
  image: ImageAttachment
  senderPubkey: string
  senderNickname: string
  senderDisplayHandle: string
  isTrusted: boolean
  isOwn?: boolean
  isDmMode?: boolean
  caption?: string
  contentFilter?: ContentFilterEngine
  fetchImageAttachmentBlob: (image: ImageAttachment, senderPubkey: string) => Promise<string>
  onTrustSender: (pubkey: string, nickname: string) => void
  onInspectSender: (pubkey: string, nickname: string) => void
  onBlockSender: (pubkey: string, displayHandle: string) => void
  onOpenLightbox: (payload: LightboxImagePayload) => void
}

function formatFilterCategories(categories: readonly ContentFilterCategory[]): string {
  if (categories.length === 0) return 'Policy'
  return categories
    .map((c) => (c === 'nsfw' ? 'NSFW' : c === 'illegal' ? 'Illegal / Severe Harm' : 'Custom Rule'))
    .join(', ')
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

/* --------------------------------------------------------------------------
   AI-INTERCEPTED IMAGE CARD — Screens image bytes in-memory via Liquid d1-2B
   BEFORE any <img> element is ever mounted in the DOM.
   -------------------------------------------------------------------------- */
interface ScreenedImageCardProps {
  image: ImageAttachment
  senderPubkey: string
  senderNickname: string
  senderDisplayHandle: string
  isTrusted: boolean
  isDmMode?: boolean
  caption?: string
  contentFilter: ContentFilterEngine
  onTrustSender: (pubkey: string, nickname: string) => void
  onInspectSender: (pubkey: string, nickname: string) => void
  onBlockSender: (pubkey: string, displayHandle: string) => void
  onOpenLightbox: (payload: LightboxImagePayload) => void
}

function ScreenedImageCard({
  image,
  senderPubkey,
  senderNickname,
  senderDisplayHandle,
  isTrusted,
  isDmMode = false,
  caption,
  contentFilter,
  onTrustSender,
  onInspectSender,
  onBlockSender,
  onOpenLightbox,
}: ScreenedImageCardProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const autoRequestedKeyRef = useRef<string | null>(null)
  const [inView, setInView] = useState(false)
  const [scanningLocal, setScanningLocal] = useState(false)
  const [revealedUrl, setRevealedUrl] = useState<string | null>(null)

  const isE2ee = Boolean(image.encryption)
  const isViolet = isDmMode || isE2ee
  const metaSummary = formatImageMeta(image)
  const cacheKey = image.sha256 || image.url

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

  const verdict = contentFilter.getVerdict(cacheKey)
  const safeUrl = verdict?.status === 'safe' ? contentFilter.getSafeImageObjectUrl(cacheKey) : null
  const isIllegal = Boolean(verdict?.categories.includes('illegal'))

  useEffect(() => {
    setRevealedUrl(null)
    autoRequestedKeyRef.current = null
  }, [cacheKey])

  // Track viewport visibility so ready models auto-screen lazily without scanning offscreen history
  useEffect(() => {
    const el = hostRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true)
          io.disconnect()
        }
      },
      { rootMargin: '140px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [cacheKey])

  const triggerScan = useCallback(() => {
    if (scanningLocal) return
    setScanningLocal(true)
    void contentFilter
      .screenImageAttachment(cacheKey, stableImage, senderPubkey, { caption })
      .finally(() => {
        setScanningLocal(false)
      })
  }, [scanningLocal, contentFilter, cacheKey, stableImage, senderPubkey, caption])

  // Auto-screen when model is already ready in memory, or rehydrate blob URL for a persisted 'safe' verdict
  useEffect(() => {
    if (!inView || scanningLocal) return
    const needsAutoScreen =
      contentFilter.modelStatus === 'ready' && (!verdict || verdict.status === 'idle')
    const needsSafeRehydrate = verdict?.status === 'safe' && !safeUrl
    if (!needsAutoScreen && !needsSafeRehydrate) return
    if (autoRequestedKeyRef.current === cacheKey) return
    autoRequestedKeyRef.current = cacheKey
    triggerScan()
  }, [inView, scanningLocal, contentFilter.modelStatus, verdict, safeUrl, cacheKey, triggerScan])

  // 1. Cleared SAFE & verified in-memory object URL ready -> render crisp image with Screened · Safe pill
  if (verdict?.status === 'safe' && safeUrl) {
    return (
      <div className={`ag-img-card ready screened ${isViolet ? 'dm' : ''}`}>
        <button
          type="button"
          className="ag-img-frame-btn"
          onClick={() =>
            onOpenLightbox({
              blobUrl: safeUrl,
              image,
              senderDisplayHandle,
              caption,
            })
          }
          title="Screened safe by Liquid d1-2B — click to inspect full resolution"
          aria-label={`Inspect screened image from ${senderDisplayHandle}${metaSummary ? ` (${metaSummary})` : ''}`}
        >
          <img
            src={safeUrl}
            alt={image.alt || caption || `Image from ${senderDisplayHandle}`}
            className="ag-img-media"
            loading="lazy"
          />

          <span className="ag-img-screened-badge mono" title="Cleared safe on-device by Liquid AI d1-2B">
            <ShieldCheck size={10} />
            <span>Screened · Safe</span>
          </span>

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

  // 2. FLAGGED by Liquid d1-2B
  if (verdict?.status === 'flagged') {
    const categoryLabel = formatFilterCategories(verdict.categories)

    if (!isIllegal && revealedUrl) {
      return (
        <div className={`ag-img-card ready revealed-flagged ${isViolet ? 'dm' : ''}`}>
          <button
            type="button"
            className="ag-img-frame-btn"
            onClick={() =>
              onOpenLightbox({
                blobUrl: revealedUrl,
                image,
                senderDisplayHandle,
                caption,
              })
            }
            title="Revealed flagged image — click to inspect"
            aria-label={`Inspect revealed flagged image from ${senderDisplayHandle}`}
          >
            <img
              src={revealedUrl}
              alt={image.alt || caption || `Image from ${senderDisplayHandle}`}
              className="ag-img-media"
              loading="lazy"
            />
          </button>

          <span className="ag-img-flagged-pill mono">
            <ShieldAlert size={10} />
            <span>Flagged: {categoryLabel}</span>
          </span>

          <button
            type="button"
            className="ag-img-hide-btn"
            onClick={() => setRevealedUrl(null)}
            title="Hide flagged image"
            aria-label="Hide flagged image"
          >
            <EyeOff size={12} />
            <span>Hide</span>
          </button>
        </div>
      )
    }

    return (
      <div
        ref={hostRef}
        className={`ag-img-shield-card flagged ${isViolet ? 'dm' : ''}`}
        role="region"
        aria-label={`Image blocked by Liquid d1-2B (${categoryLabel})`}
      >
        <div className="ag-img-shield-top">
          <div className="ag-img-shield-title-wrap">
            <span className="ag-img-shield-emblem flagged" aria-hidden="true">
              <ShieldAlert size={15} />
            </span>
            <span className="ag-img-shield-title">Blocked by Liquid d1-2B</span>
          </div>

          <div className="ag-img-shield-badges">
            <span className="ag-badge ag-badge-danger">{categoryLabel}</span>
            {metaSummary && <span className="ag-badge muted tabular">{metaSummary}</span>}
          </div>
        </div>

        <p className="ag-img-shield-note">
          Flagged: <strong>{categoryLabel}</strong>
          {verdict.reason ? ` — ${verdict.reason}` : '.'}
          {isIllegal ? ' Hidden permanently for safety.' : ' Kept hidden before display.'}
        </p>

        <div className="ag-img-shield-actions">
          {!isIllegal && (
            <button
              type="button"
              className="ag-img-shield-btn"
              onClick={() => {
                const url = contentFilter.revealFlaggedImage(cacheKey)
                if (url) setRevealedUrl(url)
              }}
              title="Reveal this flagged image anyway"
            >
              <Eye size={13} />
              <span>Reveal anyway</span>
            </button>
          )}

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

  // 3. DOWNLOADING or SCANNING
  const isDownloading =
    verdict?.status === 'downloading' ||
    (scanningLocal && contentFilter.modelStatus === 'downloading')
  const isScanning = scanningLocal || verdict?.status === 'scanning' || isDownloading

  if (isScanning) {
    const pct = Math.max(0, Math.min(100, Math.round(contentFilter.downloadProgress)))
    return (
      <div
        ref={hostRef}
        className={`ag-img-shield-card ai-intercept ${isViolet ? 'dm' : ''}`}
        role="status"
        aria-busy="true"
        aria-label={isDownloading ? `Downloading Liquid d1-2B (${pct}%)` : 'Screening image with Liquid d1-2B'}
      >
        <div className="ag-img-shield-top">
          <div className="ag-img-shield-title-wrap">
            <span className="ag-img-shield-emblem ai" aria-hidden="true">
              <Loader2 size={14} className="ag-spin" />
            </span>
            <span className="ag-img-shield-title">
              {isDownloading
                ? `Downloading Liquid d1-2B · ${pct}%`
                : 'Screening with Liquid d1-2B…'}
            </span>
          </div>
          {metaSummary && <span className="ag-badge muted tabular">{metaSummary}</span>}
        </div>

        {isDownloading && (
          <div className="ag-img-progress-track" aria-hidden="true">
            <span className="ag-img-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        )}

        <p className="ag-img-shield-note">
          Checking media locally on your device before showing it.
        </p>

        {!isTrusted && (
          <div className="ag-img-shield-actions">
            <button
              type="button"
              className="ag-img-shield-btn"
              onClick={() => onTrustSender(senderPubkey, senderNickname)}
            >
              <ShieldCheck size={13} />
              <span>Trust {senderDisplayHandle}</span>
            </button>
            <button
              type="button"
              className="ag-img-shield-btn danger"
              onClick={() => onBlockSender(senderPubkey, senderDisplayHandle)}
            >
              <Ban size={13} />
              <span>Block</span>
            </button>
          </div>
        )}
      </div>
    )
  }

  // 4. IDLE / ERROR -> Intercept card with 1-click Scan & View (Liquid d1-2B)
  const isError = verdict?.status === 'error'
  return (
    <div
      ref={hostRef}
      className={`ag-img-shield-card ai-intercept ${isViolet ? 'dm' : ''}`}
      role="region"
      aria-label={`Intercepted image from ${senderDisplayHandle}`}
    >
      <div className="ag-img-shield-top">
        <div className="ag-img-shield-title-wrap">
          <span className="ag-img-shield-emblem ai" aria-hidden="true">
            {isError ? <AlertCircle size={14} /> : <Shield size={14} />}
          </span>
          <span className="ag-img-shield-title">
            {isTrusted ? 'Image · AI Safety Screen' : 'Image · Untrusted Sender'}
          </span>
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
        {isError ? (
          <>
            Screening failed: <strong>{verdict.error || 'Unable to verify image'}</strong>. Retry
            scan or trust sender.
          </>
        ) : (
          <>
            Hidden until screened locally with <strong>Liquid d1-2B</strong> (no image shown until
            cleared safe).
          </>
        )}
      </p>

      <div className="ag-img-shield-actions">
        <button
          type="button"
          className="ag-img-shield-btn trust"
          onClick={() => {
            autoRequestedKeyRef.current = cacheKey
            triggerScan()
          }}
          title="Download/run Liquid d1-2B locally and show image only if safe"
        >
          {isError ? <RotateCw size={13} /> : <Sparkles size={13} />}
          <span>{isError ? 'Retry Scan (Liquid d1-2B)' : 'Scan & View (Liquid d1-2B)'}</span>
        </button>

        {!isTrusted && (
          <button
            type="button"
            className="ag-img-shield-btn"
            onClick={() => onTrustSender(senderPubkey, senderNickname)}
            title={`Trust ${senderDisplayHandle}`}
          >
            <ShieldCheck size={13} />
            <span>Trust Peer</span>
          </button>
        )}

        <button
          type="button"
          className="ag-img-shield-btn"
          onClick={() => onInspectSender(senderPubkey, senderNickname)}
          title={`Inspect ${senderDisplayHandle}`}
        >
          <User size={13} />
          <span>Inspect</span>
        </button>

        {!isTrusted && (
          <button
            type="button"
            className="ag-img-shield-btn danger"
            onClick={() => onBlockSender(senderPubkey, senderDisplayHandle)}
            title={`Block ${senderDisplayHandle}`}
          >
            <Ban size={13} />
            <span>Block</span>
          </button>
        )}
      </div>
    </div>
  )
}

export function ImageAttachmentCard({
  image,
  senderPubkey,
  senderNickname,
  senderDisplayHandle,
  isTrusted,
  isOwn = false,
  isDmMode = false,
  caption,
  contentFilter,
  fetchImageAttachmentBlob,
  onTrustSender,
  onInspectSender,
  onBlockSender,
  onOpenLightbox,
}: ImageAttachmentCardProps) {
  const shouldScreen = Boolean(
    contentFilter && contentFilter.shouldScreenMedia(senderPubkey, isOwn),
  )

  if (shouldScreen && contentFilter) {
    return (
      <ScreenedImageCard
        image={image}
        senderPubkey={senderPubkey}
        senderNickname={senderNickname}
        senderDisplayHandle={senderDisplayHandle}
        isTrusted={isTrusted}
        isDmMode={isDmMode}
        caption={caption}
        contentFilter={contentFilter}
        onTrustSender={onTrustSender}
        onInspectSender={onInspectSender}
        onBlockSender={onBlockSender}
        onOpenLightbox={onOpenLightbox}
      />
    )
  }

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
