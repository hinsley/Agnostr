import { useEffect, useState } from 'react'
import {
  Bell,
  CheckCircle2,
  Download,
  HardDrive,
  Loader2,
  Maximize2,
  PhoneCall,
  PlusSquare,
  Share,
  Smartphone,
  X,
} from 'lucide-react'
import type { PwaState } from '../hooks/usePwa.ts'
import type { SoundCue } from '../utils/sound.ts'

export interface PwaInstallModalProps {
  open: boolean
  pwa: PwaState
  onClose: () => void
  onPlaySound?: (cue: SoundCue) => void
}

export function PwaInstallModal({
  open,
  pwa,
  onClose,
  onPlaySound,
}: PwaInstallModalProps) {
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const handleInstallClick = async () => {
    if (installing) return
    setInstalling(true)
    onPlaySound?.('click')
    try {
      const outcome = await pwa.promptInstall()
      if (outcome === 'accepted') {
        onPlaySound?.('tune')
        onClose()
      }
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="ag-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="ag-pwa-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-pwa-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ag-pwa-modal-head">
          <div className="ag-pwa-hero">
            <img
              src="./icon.svg"
              alt="Agnostr"
              className="ag-pwa-app-icon"
              width={48}
              height={48}
            />
            <div className="ag-pwa-hero-text">
              <h2 id="ag-pwa-modal-title" className="ag-pwa-title">
                Install Agnostr
              </h2>
              <p className="ag-pwa-sub">
                Push alerts, DM call ringing &amp; standalone full-screen messaging.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="ag-icon-btn-sm"
            onClick={onClose}
            aria-label="Close install dialog"
          >
            <X size={15} />
          </button>
        </div>

        {/* Highlight Chips — Push Notifications & DM Call Ringing */}
        <div className="ag-pwa-chips" aria-label="App highlights">
          <span className="ag-pwa-chip">
            <Bell size={12} />
            <span>Push notifications</span>
          </span>
          <span className="ag-pwa-chip">
            <PhoneCall size={12} />
            <span>DM call ringing</span>
          </span>
          <span className="ag-pwa-chip">
            <Maximize2 size={12} />
            <span>Full-screen</span>
          </span>
          <span className="ag-pwa-chip">
            <HardDrive size={12} />
            <span>Offline cache</span>
          </span>
        </div>

        {/* Install Flow */}
        {pwa.isInstalled ? (
          <div className="ag-pwa-installed-box">
            <CheckCircle2 size={16} />
            <span>Agnostr is installed on this device — push alerts &amp; call ringing are ready.</span>
          </div>
        ) : pwa.canPromptInstall ? (
          <>
            <button
              type="button"
              className="ag-btn ag-btn-primary ag-btn-block ag-pwa-cta"
              onClick={() => void handleInstallClick()}
              disabled={installing}
            >
              {installing ? (
                <>
                  <Loader2 size={15} className="ag-spin" />
                  <span>Installing…</span>
                </>
              ) : (
                <>
                  <Download size={15} />
                  <span>Install Agnostr</span>
                </>
              )}
            </button>
            <p className="ag-pwa-push-note">
              Install to your dock or Home Screen for background notifications, unread badges, and
              incoming DM call ringing.
            </p>
          </>
        ) : pwa.isIosSafari ? (
          <>
            <div className="ag-pwa-steps" role="list" aria-label="iOS install steps">
              <div className="ag-pwa-step" role="listitem">
                <span className="ag-pwa-step-num mono">1</span>
                <Share size={15} className="ag-pwa-step-icon" />
                <span>
                  Tap <strong>Share</strong> in Safari
                </span>
              </div>
              <div className="ag-pwa-step" role="listitem">
                <span className="ag-pwa-step-num mono">2</span>
                <PlusSquare size={15} className="ag-pwa-step-icon" />
                <span>
                  Tap <strong>Add to Home Screen</strong>
                </span>
              </div>
              <div className="ag-pwa-step" role="listitem">
                <span className="ag-pwa-step-num mono">3</span>
                <Bell size={15} className="ag-pwa-step-icon" />
                <span>
                  Open from Home Screen to enable <strong>Push &amp; Call Ringing</strong>
                </span>
              </div>
            </div>
            <p className="ag-pwa-push-note">
              iOS Safari requires Home Screen installation to unlock Web Push notifications and
              incoming DM call alerts.
            </p>
          </>
        ) : (
          <div className="ag-pwa-tip">
            <Smartphone size={15} />
            <span>
              Use your browser&apos;s menu → <strong>Install App</strong> /{' '}
              <strong>Add to Home Screen</strong> to enable standalone push alerts and incoming DM
              call ringing.
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

export default PwaInstallModal
