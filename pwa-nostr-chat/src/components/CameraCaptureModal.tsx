import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Camera,
  CameraOff,
  Check,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  RotateCcw,
  SwitchCamera,
  X,
} from 'lucide-react'

export interface CameraCaptureModalProps {
  open: boolean
  onClose: () => void
  onCapture: (file: File) => void
  onFallbackChooseFile?: () => void
}

type FacingMode = 'user' | 'environment'

interface CapturedPhoto {
  file: File
  previewUrl: string
  width: number
  height: number
}

function describeCameraError(err: unknown): string {
  const name =
    err && typeof err === 'object' && 'name' in err
      ? String((err as { name?: unknown }).name ?? '')
      : ''

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow camera access in your browser settings and try again.'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera was detected on this device.'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Your camera is currently in use by another app or tab.'
    case 'OverconstrainedError':
      return 'Your camera did not support the requested video settings.'
    default:
      return 'Could not start the camera. Check permissions or choose an existing photo instead.'
  }
}

function CameraCaptureModalInner({
  onClose,
  onCapture,
  onFallbackChooseFile,
}: Omit<CameraCaptureModalProps, 'open'>) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const previewUrlRef = useRef<string | null>(null)

  const [facingMode, setFacingMode] = useState<FacingMode>('user')
  const [resolvedFacing, setResolvedFacing] = useState<FacingMode>('user')
  const [attemptId, setAttemptId] = useState(0)
  const [status, setStatus] = useState<'loading' | 'live' | 'error'>('loading')
  const [videoReady, setVideoReady] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [hasMultipleCameras, setHasMultipleCameras] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [captured, setCaptured] = useState<CapturedPhoto | null>(null)

  const stopStream = useCallback(() => {
    const active = streamRef.current
    if (active) {
      for (const track of active.getTracks()) {
        try {
          track.stop()
        } catch {
          // Ignore track stop errors on already-ended tracks
        }
      }
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [])

  const revokePreview = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
  }, [])

  const handleClose = useCallback(() => {
    stopStream()
    revokePreview()
    onClose()
  }, [stopStream, revokePreview, onClose])

  // Escape dismissal
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

  // Cleanup any preview object URL on unmount
  useEffect(() => {
    return () => {
      revokePreview()
    }
  }, [revokePreview])

  // Acquire camera stream whenever facingMode or retry attempt changes
  useEffect(() => {
    let cancelled = false

    const startCamera = async () => {
      stopStream()
      setStatus('loading')
      setVideoReady(false)
      setErrorMessage(null)

      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== 'function'
      ) {
        if (!cancelled) {
          setStatus('error')
          setErrorMessage('Camera access is not available in this browser.')
        }
        return
      }

      let stream: MediaStream | null = null
      try {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: facingMode },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
            audio: false,
          })
        } catch (primaryErr) {
          const errName =
            primaryErr && typeof primaryErr === 'object' && 'name' in primaryErr
              ? String((primaryErr as { name?: unknown }).name ?? '')
              : ''
          // Do not double-prompt if user explicitly denied permission
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
          setStatus('error')
          setErrorMessage(describeCameraError(err))
        }
        return
      }

      // Immediately release camera hardware if modal closed while awaiting permission
      if (cancelled) {
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
      if (actualFacing === 'environment') {
        setResolvedFacing('environment')
      } else if (actualFacing === 'user') {
        setResolvedFacing('user')
      } else {
        setResolvedFacing(facingMode)
      }

      const el = videoRef.current
      if (el) {
        el.muted = true
        el.playsInline = true
        el.srcObject = stream
        el.play().catch(() => {
          // Ignore autoplay interruption; user opened modal via click
        })
      }

      setStatus('live')

      // Check for multiple video inputs after permission grant so device labels/list populate
      if (typeof navigator.mediaDevices.enumerateDevices === 'function') {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices()
          if (!cancelled) {
            const videoInputs = devices.filter((d) => d.kind === 'videoinput')
            setHasMultipleCameras(videoInputs.length > 1)
          }
        } catch {
          // Ignore enumerateDevices errors
        }
      }
    }

    void startCamera()

    return () => {
      cancelled = true
      stopStream()
    }
  }, [facingMode, attemptId, stopStream])

  const handleCaptureFrame = useCallback(() => {
    const video = videoRef.current
    if (!video || capturing || status !== 'live') return

    const width = video.videoWidth || 1280
    const height = video.videoHeight || 720
    if (width <= 0 || height <= 0) return

    setCapturing(true)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setCapturing(false)
      setErrorMessage('Unable to capture frame from camera preview.')
      setStatus('error')
      return
    }

    // Draw true un-mirrored camera frame so text and signs remain readable
    ctx.drawImage(video, 0, 0, width, height)

    canvas.toBlob(
      (blob) => {
        setCapturing(false)
        if (!blob) {
          setErrorMessage('Failed to encode captured photo. Please try again.')
          return
        }
        revokePreview()
        const file = new File([blob], `photo-${Date.now()}.jpg`, {
          type: 'image/jpeg',
        })
        const previewUrl = URL.createObjectURL(blob)
        previewUrlRef.current = previewUrl
        video.pause()
        setCaptured({ file, previewUrl, width, height })
      },
      'image/jpeg',
      0.92,
    )
  }, [capturing, status, revokePreview])

  const handleRetake = useCallback(() => {
    revokePreview()
    setCaptured(null)
    const video = videoRef.current
    if (video && streamRef.current) {
      video.play().catch(() => {
        // Fallback: re-acquire camera if track paused/ended
        setAttemptId((n) => n + 1)
      })
    } else {
      setAttemptId((n) => n + 1)
    }
  }, [revokePreview])

  const handleUsePhoto = useCallback(() => {
    if (!captured) return
    const file = captured.file
    // Always stop every camera track immediately on capture confirm
    stopStream()
    revokePreview()
    onCapture(file)
    onClose()
  }, [captured, stopStream, revokePreview, onCapture, onClose])

  const handleFlipCamera = useCallback(() => {
    if (captured) return
    setFacingMode((prev) => (prev === 'user' ? 'environment' : 'user'))
  }, [captured])

  const handleFallbackFile = useCallback(() => {
    stopStream()
    revokePreview()
    onClose()
    onFallbackChooseFile?.()
  }, [stopStream, revokePreview, onClose, onFallbackChooseFile])

  const isMirroredPreview = resolvedFacing === 'user'

  return (
    <div
      className="ag-modal-backdrop ag-camera-modal-backdrop"
      onClick={handleClose}
      role="presentation"
      data-no-swipe="true"
    >
      <div
        className="ag-camera-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Take a photo"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ag-camera-modal-head">
          <div className="ag-camera-modal-title-wrap">
            <Camera size={17} className="ag-camera-modal-icon" />
            <h2 className="ag-camera-modal-title">
              {captured ? 'Review Photo' : 'Take Photo'}
            </h2>
          </div>
          <button
            type="button"
            className="ag-sheet-close-btn ag-camera-close-btn"
            onClick={handleClose}
            aria-label="Close camera"
            title="Close (Esc)"
          >
            <X size={18} />
          </button>
        </header>

        <div className="ag-camera-viewport">
          {/* Keep live video mounted while reviewing so Retake is instant */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            onLoadedMetadata={() => setVideoReady(true)}
            onCanPlay={() => setVideoReady(true)}
            className={`ag-camera-video ${isMirroredPreview ? 'mirrored' : ''} ${
              captured || status !== 'live' ? 'hidden' : ''
            }`}
          />

          {captured && (
            <img
              src={captured.previewUrl}
              alt="Captured photo preview"
              className="ag-camera-preview-img"
            />
          )}

          {!captured && status === 'loading' && (
            <div className="ag-camera-overlay-state" role="status">
              <Loader2 size={24} className="ag-spin ag-camera-state-icon" />
              <p className="ag-camera-state-text">Starting camera…</p>
            </div>
          )}

          {!captured && status === 'error' && (
            <div className="ag-camera-overlay-state error" role="alert">
              <span className="ag-camera-error-badge" aria-hidden="true">
                <CameraOff size={22} />
              </span>
              <p className="ag-camera-error-msg">{errorMessage}</p>
              <div className="ag-camera-error-actions">
                <button
                  type="button"
                  className="ag-btn ag-btn-secondary ag-camera-action-btn"
                  onClick={() => setAttemptId((n) => n + 1)}
                >
                  <RefreshCw size={15} />
                  <span>Retry</span>
                </button>
                {onFallbackChooseFile && (
                  <button
                    type="button"
                    className="ag-btn ag-btn-primary ag-camera-action-btn"
                    onClick={handleFallbackFile}
                  >
                    <ImageIcon size={15} />
                    <span>Choose Photo Instead</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <footer className="ag-camera-controls">
          {captured ? (
            <div className="ag-camera-review-actions">
              <button
                type="button"
                className="ag-btn ag-btn-secondary ag-camera-action-btn"
                onClick={handleRetake}
              >
                <RotateCcw size={16} />
                <span>Retake</span>
              </button>
              <button
                type="button"
                className="ag-btn ag-btn-primary ag-camera-action-btn"
                onClick={handleUsePhoto}
              >
                <Check size={16} />
                <span>Use Photo</span>
              </button>
            </div>
          ) : (
            <div className="ag-camera-shutter-bar">
              <div className="ag-camera-side-slot">
                {onFallbackChooseFile && (
                  <button
                    type="button"
                    className="ag-camera-util-btn"
                    onClick={handleFallbackFile}
                    title="Choose an existing photo"
                    aria-label="Choose an existing photo"
                  >
                    <ImageIcon size={18} />
                  </button>
                )}
              </div>

              <button
                type="button"
                className="ag-camera-shutter-btn"
                disabled={status !== 'live' || !videoReady || capturing}
                onClick={handleCaptureFrame}
                aria-label="Capture photo"
                title="Capture photo"
              >
                <span className="ag-camera-shutter-core" aria-hidden="true" />
              </button>

              <div className="ag-camera-side-slot end">
                {hasMultipleCameras && status === 'live' && (
                  <button
                    type="button"
                    className="ag-camera-util-btn"
                    onClick={handleFlipCamera}
                    title="Flip camera"
                    aria-label="Flip camera"
                  >
                    <SwitchCamera size={18} />
                  </button>
                )}
              </div>
            </div>
          )}
        </footer>
      </div>
    </div>
  )
}

export function CameraCaptureModal({
  open,
  onClose,
  onCapture,
  onFallbackChooseFile,
}: CameraCaptureModalProps) {
  if (!open) return null
  if (typeof document === 'undefined') return null

  return createPortal(
    <CameraCaptureModalInner
      onClose={onClose}
      onCapture={onCapture}
      onFallbackChooseFile={onFallbackChooseFile}
    />,
    document.body,
  )
}

export default CameraCaptureModal
