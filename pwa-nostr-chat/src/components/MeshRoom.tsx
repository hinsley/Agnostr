import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowUp, Bluetooth, Globe, Hash, Users, X } from 'lucide-react'
import { isNativeAndroidBuild } from '../lib/appPlatform.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import type { NearbyController } from '../hooks/useNearbyRuntime.ts'
import type { NearbyPeer } from '../lib/nearby/nearbyRuntime.ts'
import { formatBitchatChannelLabel } from '../lib/bitchatChannel.ts'
import { isGatewayGeohash } from '../lib/nearby/gatewayPolicy.ts'
import { cleanNickname, encodeText, MAX_TEXT_BYTES } from '../lib/nearby/meshWire.ts'
import { AvatarImg } from './AvatarImg'
import { MessageItem } from './MessageItem'
import './mesh-room.css'

const noop = () => {}
const noBlob = async () => ''
const peerAvatar = (id: string) => id.repeat(4)

export default function MeshRoom({ nearby, nickname, geohash, onGeo, onGlobe, onOpenChannels, onOpenSettings, mobile }: {
  nearby: NearbyController
  nickname: string
  geohash: string
  onGeo: () => void
  onGlobe: () => void
  onOpenChannels?: () => void
  onOpenSettings: () => void
  mobile: boolean
}) {
  const { state, api } = nearby
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [userList, setUserList] = useState(!mobile)
  const [roster, setRoster] = useState<NearbyPeer[]>([])
  const latest = useRef(state.peers)
  latest.current = state.peers
  const list = useRef<HTMLDivElement>(null)
  const bottom = useRef(true)
  const [actions, setActions] = useState<string | null>(null)
  const [confirmingShare, setConfirmingShare] = useState(false)

  useBackHandler(mobile && userList, () => setUserList(false))
  useEffect(() => {
    if (!state.active) {
      setRoster([])
      return
    }
    setRoster(prior => {
      const adds = state.peers.filter(next => !prior.some(peer => peer.id === next.id))
      return adds.length ? [...prior, ...adds] : prior
    })
  }, [state.active, state.peers])
  useEffect(() => {
    const timer = window.setInterval(() => setRoster(latest.current), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const last = state.messages.at(-1)?.id
  useEffect(() => {
    if (list.current && (bottom.current || state.messages.at(-1)?.local)) list.current.scrollTop = list.current.scrollHeight
    // Length and contents are unchanged when only radio metadata updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last])

  const ready = state.active && state.links > 0 && !sending && !!draft.trim() && encodeText(draft).length <= MAX_TEXT_BYTES
  async function send(event?: FormEvent) {
    event?.preventDefault()
    if (!ready) return
    setError('')
    setSending(true)
    const sent = await api()?.sendMesh(draft)
    setSending(false)
    if (sent) setDraft('')
    else setError('No Bluetooth link accepted the message. Your draft is still here.')
  }

  return <>
    <main className="ag-main ag-mesh-main">
      <header className="ag-header">
        <div className="ag-header-top">
          <div className="ag-header-left">
            <button className="ag-circle-btn ag-mobile-only" onClick={onGlobe}
              aria-label="Back to Globe"><ArrowLeft size={19} /></button>
            <button className="ag-header-globe-back-btn ag-desktop-only" onClick={onGlobe} aria-label="Back to Globe">
              <ArrowLeft size={15} /><Globe size={15} /><span>Globe</span>
            </button>
            <div className="ag-header-identity">
              {onOpenChannels ? (
                <button type="button" className="ag-header-avatar bitchat ag-mesh-drawer-button" onClick={onOpenChannels} aria-label="Open Bitchat channels"><Hash size={17} /></button>
              ) : <div className="ag-header-avatar bitchat">{isNativeAndroidBuild ? <Hash size={17} /> : <Bluetooth size={17} />}</div>}
              <div className="ag-header-text">
                <div className="ag-header-title-row"><span className="ag-header-title">Mesh</span></div>
                <div className="ag-header-sub">{state.active ? 'Nearby Bluetooth · Public' : 'Nearby Bluetooth is off'}</div>
              </div>
            </div>
          </div>
          <div className="ag-header-actions">
            <button className="ag-circle-btn" onClick={onGeo} aria-label="Return to geohash chat" title="Return to geohash chat"><Globe size={16} /></button>
            <button className={'ag-circle-btn' + (userList ? ' active' : '')} onClick={() => setUserList(!userList)}
              aria-label="User list" aria-expanded={userList}><Users size={16} /></button>
          </div>
        </div>
      </header>
      {!isNativeAndroidBuild && <div className="ag-mesh-control">
        <button className="ag-btn ag-btn-secondary" disabled={!state.supported || state.working} onClick={() => {
          setError('')
          setConfirmingShare(false)
          if (state.active) void api()?.stop()
          else void api()?.start(nickname)
        }}>
          {state.working ? 'Starting…' : state.active ? 'Stop Bluetooth' : 'Start Bluetooth'}
        </button>
        <span className="ag-mesh-profile">Broadcasting as <strong>{cleanNickname(nickname)}</strong> when on</span>
        {state.active && (
          <button className={'ag-btn ' + (state.sharing ? 'ag-btn-primary' : 'ag-btn-secondary')}
            aria-pressed={state.sharing} onClick={() => {
              setError('')
              if (state.sharing) api()?.share(false)
              else setConfirmingShare(!confirmingShare)
            }}>
            {state.sharing ? 'Stop sharing internet' : 'Share internet with mesh'}
          </button>
        )}
        {state.active && state.peers.some(peer => peer.gateway) && isGatewayGeohash(geohash) && (
          <button className="ag-btn ag-btn-secondary" onClick={onGeo}>Open {formatBitchatChannelLabel(geohash)} via gateway</button>
        )}
      </div>}
      {!isNativeAndroidBuild && confirmingShare && state.active && !state.sharing && (
        <div className="ag-mesh-notice">
          Nearby devices can send signed public geohash messages to Nostr through you. Live replies from the geohash room you’re viewing can travel back. Messages in this Mesh room stay on Bluetooth.
          <button className="ag-btn ag-btn-primary" onClick={() => { api()?.share(true); setConfirmingShare(false) }}>Share this session</button>
          <button className="ag-btn ag-btn-secondary" onClick={() => setConfirmingShare(false)}>Cancel</button>
        </div>
      )}
      {!isNativeAndroidBuild && state.active && state.sharing && (
        <p className="ag-mesh-notice" role="status">{isGatewayGeohash(geohash)
          ? `Sharing this session · Return channel: ${formatBitchatChannelLabel(geohash)}`
          : 'Sharing this session · Open an Earth geohash room to carry its replies back.'}</p>
      )}
      {state.error || error ? <p className="ag-mesh-notice" role="alert">{state.error || error}</p> : null}
      <div className="ag-chat-content">
        <div className="ag-stream-wrap">
          <div className="ag-stream-scroll" ref={list} role="log" aria-live="polite" onScroll={() => {
            if (list.current) bottom.current = list.current.scrollHeight - list.current.scrollTop - list.current.clientHeight < 72
          }}>
            <div className="ag-stream-inner">
              {!state.messages.length && <div className="ag-empty-stage">
                {isNativeAndroidBuild ? <Hash size={29} /> : <Bluetooth size={29} />}<h2>Mesh</h2>
                <p>{state.active ? 'Messages shared over nearby Bluetooth appear here.'
                  : isNativeAndroidBuild
                    ? nearby.enabled ? 'Waiting for Bluetooth to come online.' : 'Turn on Bluetooth Mesh in Settings to chat with nearby peers.'
                    : 'Start Bluetooth to talk to Bitchat peers without internet.'}</p>
                {isNativeAndroidBuild && !state.active && (
                  <button type="button" className="ag-btn ag-btn-secondary" onClick={onOpenSettings}>Open Settings</button>
                )}
              </div>}
              {state.messages.map((m, idx) => (
                <MessageItem key={m.id}
                  message={{
                    id: m.id, geohash: '', pubkey: peerAvatar(m.sender), nickname: m.name, displayHandle: m.name,
                    content: m.body, createdAt: Math.floor(m.when / 1000), tags: [], isOwn: !!m.local,
                    isTeleported: false, isMeshBridge: false, powBits: 0, reactions: [], mentions: [],
                  }}
                  grouped={!!state.messages[idx - 1] && state.messages[idx - 1].sender === m.sender}
                  isLive isMentioned={false} isSearchActive={false} actionsRevealed={actions === m.id}
                  showBridgeBadges={false} allowUntrustedLinks={false} localRadio
                  isSenderTrusted={!!m.local} isSenderExplicitlyTrusted={false}
                  fetchVoiceMemoBlob={noBlob} fetchImageAttachmentBlob={noBlob}
                  onOpenLightbox={noop} onToggleActions={setActions} onTrustSender={noop} onBlockSender={noop}
                  onCopyText={text => void navigator.clipboard?.writeText(text).catch(() => {})}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
      <form className="ag-composer-dock" onSubmit={send}>
        <div className="ag-composer-inner"><div className="ag-composer-bar">
          <textarea className="ag-composer-input" rows={1} maxLength={MAX_TEXT_BYTES} value={draft}
            placeholder="Message Mesh" aria-label="Message Mesh" enterKeyHint="send"
            onChange={event => setDraft(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }} />
          <div className="ag-composer-right">
            <button type="submit" className={'ag-composer-send-btn' + (ready ? ' ready' : '')} disabled={!ready} aria-label="Send Bluetooth message"><ArrowUp size={17} /></button>
          </div>
        </div></div>
      </form>
    </main>
    {userList && <>
      {mobile && <div className="ag-right-drawer-scrim ag-mesh-roster-scrim active" onClick={() => setUserList(false)} aria-hidden="true" />}
      <div className={'ag-users-col ag-mesh-roster-col' + (mobile ? ' open' : '')}>
        <aside className="ag-users-pane" aria-label="Mesh user list">
          <header className="ag-users-header">
            <div className="ag-users-header-left"><Users size={15} /><span className="ag-users-title">Nearby</span>
              <span className="ag-users-count tabular">{roster.length}</span></div>
            {mobile && <button className="ag-circle-btn" onClick={() => setUserList(false)} aria-label="Close user list"><X size={15} /></button>}
          </header>
          <div className="ag-users-scroll">
            {!roster.length && <p className="ag-users-empty">No nearby users detected yet.</p>}
            {roster.map(peer => <div className="ag-users-row" key={peer.id}>
              <div className="ag-users-avatar-wrap"><AvatarImg pubkey={peerAvatar(peer.id)} width={30} height={30} alt="" className="ag-users-avatar" /><span className="ag-users-online-dot" /></div>
              <div className="ag-users-copy"><div className="ag-users-name-row"><span className="ag-users-name truncate">{peer.name}</span>
                {peer.gateway && <span className="ag-users-role">Gateway</span>}</div></div>
            </div>)}
          </div>
        </aside>
      </div>
    </>}
  </>
}
