import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  CameraOff,
  Image as ImageIcon,
  Loader2,
  QrCode,
  RefreshCw,
  SwitchCamera,
  X,
} from 'lucide-react'
import { decodeQrFromImageFile, decodeQrFromVideoFrame } from '../lib/qrCode.ts'
import { parseShareTarget, type ParsedShareTarget } from '../lib/shareLinks.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'

export interface QrScannerModalProps {
  open: boolean
  onClose: () => void
  onResolved: (target: ParsedShareTarget) => void
}

type FacingMode = 'environment' | 'user'

function describeScannerCameraError(err: unknown): string {
  const name =
    err && typeof err === 'object' && 'name' in err
      ? String((err as { name?: unknown }).name ?? '')
      : ''

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Camera permission was denied. You can scan from a photo or paste a link below.'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera was detected. Scan a QR screenshot or paste a link below.'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Your camera is in use by another app. Close it or scan from a photo below.'
    default:
      return 'Could not start the camera. Try again, scan from a photo, or paste a link below.'
  }
}

function QrScannerModalInner({
  onClose,
  onResolved,
}: Omit<QrScannerModalProps, 'open'>) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const resolvedRef = useRef(false)
  const invalidNoticeTimerRef = useRef<number | null>(null)

  const [facingMode, setFacingMode] = useState<FacingMode>('environment')
  const [resolvedFacing, setResolvedFacing] = useState<FacingMode>('environment')
  const [attemptId, setAttemptId] = useState(0)
  const [cameraStatus, setCameraStatus] = useState<'loading' | 'live' | 'error'>('loading')
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [hasMultipleCameras, setHasMultipleCameras] = useState(false)
  const [scanNotice, setScanNotice] = useState<string | null>(null)
  const [scanningPhoto, setScanningPhoto] = useState(false)
  const [pasteDraft, setPasteDraft] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)

  const stopStream = useCallback(() => {
    const active = streamRef.current
    if (active) {
      for (const track of active.getTracks()) {
        try {
          track.stop()
        } catch {
          // ignore
        }
      }
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [])

  const clearInvalidNoticeTimer = useCallback(() => {
    if (invalidNoticeTimerRef.current !== null) {
      window.clearTimeout(invalidNoticeTimerRef.current)
      invalidNoticeTimerRef.current = null
    }
  }, [])

  const showTransientNotice = useCallback(
    (msg: string) => {
      setScanNotice(msg)
      clearInvalidNoticeTimer()
      invalidNoticeTimerRef.current = window.setTimeout(() => {
        setScanNotice(null)
        invalidNoticeTimerRef.current = null
      }, 2600)
    },
    [clearInvalidNoticeTimer],
  )

  const handleClose = useCallback(() => {
    stopStream()
    clearInvalidNoticeTimer()
    onClose()
  }, [stopStream, clearInvalidNoticeTimer, onClose])

  const completeResolution = useCallback(
    (parsed: ParsedShareTarget) => {
      if (resolvedRef.current) return
      resolvedRef.current = true
      stopStream()
      clearInvalidNoticeTimer()
      onClose()
      onResolved(parsed)
    },
    [stopStream, clearInvalidNoticeTimer, onClose, onResolved],
  )

  // Android / PWA Back button & Escape dismissal
  useBackHandler(true, handleClose)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleClose])

  useEffect(() => {
    return () => {
      clearInvalidNoticeTimer()
    }
  }, [clearInvalidNoticeTimer])

  // Acquire rear camera stream & run ~150ms non-overlapping QR decode loop
  useEffect(() => {
    let cancelled = false
    let scanTimer: number | null = null

    const scheduleNextScan = () => {
      if (cancelled || resolvedRef.current) return
      scanTimer = window.setTimeout(() => {
        void runScanTick()
      }, 150)
    }

    const runScanTick = async () => {
      if (cancelled || resolvedRef.current) return
      const video = videoRef.current
      if (!video || video.readyState < 2 || video.videoWidth <= 0) {
        scheduleNextScan()
        return
      }

      try {
        if (!scratchCanvasRef.current) {
          scratchCanvasRef.current = document.createElement('canvas')
        }
        const decoded = await decodeQrFromVideoFrame(video, scratchCanvasRef.current)
        if (cancelled || resolvedRef.current) return

        if (decoded && decoded.trim()) {
          const parsed = parseShareTarget(decoded)
          if (parsed) {
            completeResolution(parsed)
            return
          }
          showTransientNotice('Not an Agnostr DM link or community invite')
        }
      } catch {
        // Ignore transient decode frame errors and continue scanning
      }

      scheduleNextScan()
    }

    const startScanner = async () => {
      stopStream()
      setCameraStatus('loading')
      setCameraError(null)

      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== 'function'
      ) {
        if (!cancelled) {
          setCameraStatus('error')
          setCameraError('Camera scanning is unavailable in this browser. Scan from a photo or paste a link below.')
        }
        return
      }

      let stream: MediaStream | null = null
      try {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: facingMode },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          })
        } catch (primaryErr) {
          const errName =
            primaryErr && typeof primaryErr === 'object' && 'name' in primaryErr
              ? String((primaryErr as { name?: unknown }).name ?? '')
              : ''
          if (
            errName === 'NotAllowedError' ||
            errName === 'PermissionDeniedError' ||
            errName === 'SecurityError'
          ) {
            throw primaryErr
          }
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          })
        }
      } catch (err) {
        if (!cancelled) {
          setCameraStatus('error')
          setCameraError(describeScannerCameraError(err))
        }
        return
      }

      if (cancelled || resolvedRef.current) {
        for (const track of stream.getTracks()) {
          try {
            track.stop()
          } catch {
            // ignore
          }
        }
        return
      }

      streamRef.current = stream

      const primaryTrack = stream.getVideoTracks()[0]
      const actualFacing = primaryTrack?.getSettings?.().facingMode
      if (actualFacing === 'user') {
        setResolvedFacing('user')
      } else if (actualFacing === 'environment') {
        setResolvedFacing('environment')
      } else {
        setResolvedFacing(facingMode)
      }

      const el = videoRef.current
      if (el) {
        el.muted = true
        el.playsInline = true
        el.srcObject = stream
        el.play().catch(() => {
          // Ignore autoplay interruption
        })
      }

      setCameraStatus('live')
      scheduleNextScan()

      if (typeof navigator.mediaDevices.enumerateDevices === 'function') {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices()
          if (!cancelled) {
            const videoInputs = devices.filter((d) => d.kind === 'videoinput')
            setHasMultipleCameras(videoInputs.length > 1)
          }
        } catch {
          // ignore
        }
      }
    }

    void startScanner()

    return () => {
      cancelled = true
      if (scanTimer !== null) {
        window.clearTimeout(scanTimer)
      }
      stopStream()
    }
  }, [facingMode, attemptId, stopStream, completeResolution, showTransientNotice])

  const handlePhotoFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setScanningPhoto(true)
    setPasteError(null)
    try {
      const decoded = await decodeQrFromImageFile(file)
      if (!decoded || !decoded.trim()) {
        showTransientNotice('No QR code found in that image')
        return
      }
      const parsed = parseShareTarget(decoded)
      if (!parsed) {
        showTransientNotice('Not an Agnostr DM link or community invite')
        return
      }
      completeResolution(parsed)
    } catch {
      showTransientNotice('Could not read QR code from that image')
    } finally {
      setScanningPhoto(false)
    }
  }

  const handlePasteSubmit = (e: FormEvent) => {
    e.preventDefault()
    const raw = pasteDraft.trim()
    if (!raw) return
    const parsed = parseShareTarget(raw)
    if (!parsed) {
      setPasteError('Not a valid Agnostr DM link, npub, or community invite')
      return
    }
    setPasteError(null)
    completeResolution(parsed)
  }

  const handleFlipCamera = () => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'))
  }

  return (
    <div
      className="ag-modal-backdrop ag-qr-modal-backdrop ag-qr-scanner-backdrop"
      onClick={handleClose}
      role="presentation"
      data-no-swipe="true"
    >
      <div
        className="ag-qr-scanner-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-qr-scanner-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ag-qr-modal-head">
          <div className="ag-qr-modal-title-group">
            <span className="ag-qr-modal-badge-icon" aria-hidden="true">
              <QrCode size={16} />
            </span>
            <div className="ag-qr-modal-title-copy">
              <h2 id="ag-qr-scanner-title" className="ag-qr-modal-title">
                Scan QR Code
              </h2>
              <p className="ag-qr-modal-sub">DM link or community invite</p>
            </div>
          </div>

          <div className="ag-qr-head-actions">
            {hasMultipleCameras && cameraStatus === 'live' && (
              <button
                type="button"
                className="ag-sheet-close-btn ag-qr-close-btn"
                onClick={handleFlipCamera}
                aria-label="Flip camera"
                title="Flip camera"
              >
                <SwitchCamera size={17} />
              </button>
            )}
            <button
              type="button"
              className="ag-sheet-close-btn ag-qr-close-btn"
              onClick={handleClose}
              aria-label="Close scanner"
              title="Close (Esc)"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {/* Live Camera Viewfinder */}
        <div className="ag-qr-scanner-stage">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`ag-qr-scanner-video ${resolvedFacing === 'user' ? 'mirrored' : ''} ${
              cameraStatus !== 'live' ? 'hidden' : ''
            }`}
          />

          {cameraStatus === 'live' && (
            <div className="ag-qr-reticle-layer" aria-hidden="true">
              <div className="ag-qr-reticle">
                <span className="ag-qr-corner tl" />
                <span className="ag-qr-corner tr" />
                <span className="ag-qr-corner bl" />
                <span className="ag-qr-corner br" />
                <span className="ag-qr-scanline" />
              </div>
            </div>
          )}

          {cameraStatus === 'loading' && (
            <div className="ag-qr-scanner-state" role="status">
              <Loader2 size={24} className="ag-spin ag-camera-state-icon" />
              <p className="ag-camera-state-text">Starting camera…</p>
            </div>
          )}

          {cameraStatus === 'error' && (
            <div className="ag-qr-scanner-state" role="status">
              <span className="ag-camera-error-badge" aria-hidden="true">
                <CameraOff size={20} />
              </span>
              <p className="ag-qr-scanner-err-msg">{cameraError}</p>
              <button
                type="button"
                className="ag-btn ag-btn-secondary ag-btn-sm"
                onClick={() => setAttemptId((n) => n + 1)}
              >
                <RefreshCw size={14} />
                <span>Retry Camera</span>
              </button>
            </div>
          )}

          {scanNotice && (
            <div className="ag-qr-scanner-toast" role="alert">
              <AlertCircle size={14} />
              <span>{scanNotice}</span>
            </div>
          )}
        </div>

        {/* Photo Fallback & Manual Paste Footer */}
        <div className="ag-qr-scanner-footer">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => void handlePhotoFileChange(e)}
            tabIndex={-1}
          />

          <button
            type="button"
            className="ag-btn ag-btn-secondary ag-btn-block ag-qr-photo-btn"
            disabled={scanningPhoto}
            onClick={() => fileInputRef.current?.click()}
          >
            {scanningPhoto ? (
              <Loader2 size={16} className="ag-spin" />
            ) : (
              <ImageIcon size={16} />
            )}
            <span>{scanningPhoto ? 'Scanning photo…' : 'Scan from Photo'}</span>
          </button>

          <form className="ag-qr-paste-form" onSubmit={handlePasteSubmit}>
            <input
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              className="ag-input mono ag-qr-paste-input"
              placeholder="Or paste DM link, npub, or invite code"
              value={pasteDraft}
              onChange={(e) => {
                setPasteDraft(e.target.value)
                if (pasteError) setPasteError(null)
              }}
              aria-label="Paste DM link, npub, or invite code"
            />
            <button
              type="submit"
              className="ag-btn ag-btn-primary ag-qr-open-btn"
              disabled={!pasteDraft.trim()}
            >
              Open
            </button>
          </form>

          {pasteError && (
            <p className="ag-field-hint ag-field-hint-danger" role="alert">
              {pasteError}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export function QrScannerModal({ open, onClose, onResolved }: QrScannerModalProps) {
  if (!open) return null
  if (typeof document === 'undefined') return null

  return createPortal(
    <QrScannerModalInner onClose={onClose} onResolved={onResolved} />,
    document.body,
  )
}

export default QrScannerModal
