import { Lock, Phone, PhoneOff, Video } from 'lucide-react'
import type { IncomingCallOffer } from '../types/calls.ts'
import { identiconDataUrl, pubkeyToColor } from '../utils/identicon.ts'

export interface IncomingCallBannerProps {
  incoming: IncomingCallOffer
  onAcceptAudio: () => void
  onAcceptVideo: () => void
  onDecline: () => void
}

export function IncomingCallBanner({
  incoming,
  onAcceptAudio,
  onAcceptVideo,
  onDecline,
}: IncomingCallBannerProps) {
  const callerColor = pubkeyToColor(incoming.callerPubkey)
  const isVideo = incoming.mediaType === 'video'

  return (
    <div
      className="ag-incoming-call"
      role="alertdialog"
      aria-live="assertive"
      aria-labelledby="ag-incoming-caller"
    >
      <div className="ag-incoming-top">
        <div className="ag-incoming-avatar-wrap">
          <span className="ag-incoming-ring" aria-hidden="true" />
          <img
            src={identiconDataUrl(incoming.callerPubkey)}
            alt=""
            width={42}
            height={42}
            className="ag-incoming-avatar"
          />
        </div>

        <div className="ag-incoming-info">
          <div
            id="ag-incoming-caller"
            className="ag-incoming-handle truncate"
            style={{ color: callerColor }}
          >
            {incoming.callerDisplayHandle}
          </div>
          <div className="ag-incoming-badges">
            <span className="ag-badge ag-badge-ok">
              {isVideo ? <Video size={9} /> : <Phone size={9} />}
              <span>{isVideo ? 'VIDEO CALL' : 'VOICE CALL'}</span>
            </span>
            <span className="ag-badge ag-badge-dm">
              <Lock size={9} />
              <span>E2EE P2P</span>
            </span>
          </div>
        </div>
      </div>

      <div className="ag-incoming-actions">
        <button
          type="button"
          className="ag-btn ag-btn-primary ag-incoming-accept"
          onClick={onAcceptAudio}
        >
          <Phone size={14} />
          <span>Accept</span>
        </button>

        {isVideo && (
          <button
            type="button"
            className="ag-btn ag-btn-dm ag-incoming-video"
            onClick={onAcceptVideo}
          >
            <Video size={14} />
            <span>Video</span>
          </button>
        )}

        <button
          type="button"
          className="ag-btn ag-btn-danger-outline ag-incoming-decline"
          onClick={onDecline}
        >
          <PhoneOff size={14} />
          <span>Decline</span>
        </button>
      </div>
    </div>
  )
}

export default IncomingCallBanner
