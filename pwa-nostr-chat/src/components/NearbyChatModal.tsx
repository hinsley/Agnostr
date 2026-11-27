import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Bluetooth, Send, X } from 'lucide-react'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import {
  MAX_TEXT_BYTES, cleanNickname, createMeshIdentity, encodeText, proofId,
} from '../lib/nearby/meshWire.ts'
import { createMeshSession, type NearbyMessage } from '../lib/nearby/meshSession.ts'
import { Nearby, sendOnLink, unpackNearbyFrame, type NearbyState } from '../lib/nearby/nativeNearby.ts'
import './nearby-chat.css'

type Running = {
  identity: ReturnType<typeof createMeshIdentity>
  session: ReturnType<typeof createMeshSession>
  name: string
}
const inactive: NearbyState = { active: false, links: [] }
const timeLabel = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

export default function NearbyChatModal({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const stream = useRef<HTMLDivElement>(null)
  const run = useRef<Running | null>(null)
  const latest = useRef<NearbyState>(inactive)
  const alive = useRef(false)
  const [supported, setSupported] = useState<boolean | null>(null)
  const [state, setState] = useState<NearbyState>(inactive)
  const [starting, setStarting] = useState(false)
  const [sending, setSending] = useState(false)
  const [name, setName] = useState('Agnostr')
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [messages, setMessages] = useState<NearbyMessage[]>([])
  const [peerCount, setPeerCount] = useState(0)

  useBackHandler(true, onClose)
  const last = messages.at(-1)?.id
  useEffect(() => { if (stream.current) stream.current.scrollTop = stream.current.scrollHeight }, [last])

  useEffect(() => {
    const pane = dialog.current
    if (pane && !pane.open) pane.showModal()
    alive.current = true
    let cancelled = false
    const listeners = Promise.all([
      Nearby.addListener('state', incoming => {
        if (cancelled) return
        const previous = latest.current
        latest.current = incoming
        setState(incoming)
        if (!incoming.active) {
          run.current?.identity.erase()
          run.current?.session.clear()
          run.current = null
          setPeerCount(0)
          return
        }
        const session = run.current
        if (!session) return
        const added = incoming.links.filter(link => !previous.links.some(prior => prior.id === link.id))
        if (added.length) {
          const announce = session.identity.announce()
          for (const link of added) void sendOnLink(link, announce)
        }
      }),
      Nearby.addListener('frame', incoming => {
        if (cancelled || !latest.current.active || !run.current) return
        const frame = unpackNearbyFrame(incoming.wire)
        if (!frame) return
        const observations = run.current.session.receive(frame, incoming.link)
        if (!observations.length) return
        const batch = observations.flatMap(x => x.message ? [x.message] : [])
        if (batch.length) setMessages(previous => [...previous, ...batch].slice(-160))
        setPeerCount(run.current.session.peerCount())
        for (const { relay, ingress } of observations) {
          if (relay.ttl < 2) continue
          const next = { ...relay, ttl: relay.ttl - 1 }
          for (const link of latest.current.links) if (link.id !== ingress) void sendOnLink(link, next)
        }
      }),
    ])
    void listeners.then(() => Nearby.capabilities()).then(result => {
      if (!cancelled) setSupported(result.supported)
    }).catch(() => { if (!cancelled) setSupported(false) })
    const heartbeat = window.setInterval(() => {
      const current = run.current
      if (!current || !latest.current.active) return
      setPeerCount(current.session.peerCount())
      if (latest.current.links.length) {
        const announcement = current.identity.announce()
        for (const link of latest.current.links) void sendOnLink(link, announcement)
      }
    }, 15_000)
    return () => {
      cancelled = true
      alive.current = false
      window.clearInterval(heartbeat)
      void listeners.then(handles => Promise.all(handles.map(handle => handle.remove()))).catch(() => {})
      void Nearby.stop().catch(() => {})
      run.current?.identity.erase()
      run.current?.session.clear()
      run.current = null
      pane?.close()
    }
  }, [])

  async function start() {
    if (starting || state.active || !supported) return
    setStarting(true)
    setNotice('')
    setMessages([])
    setPeerCount(0)
    const nickname = cleanNickname(name)
    const identity = createMeshIdentity(nickname)
    run.current = { name: nickname, identity, session: createMeshSession(identity.id) }
    try {
      await Nearby.start()
      if (!alive.current) await Nearby.stop()
    } catch (error) {
      identity.erase()
      run.current = null
      if (alive.current) setNotice(error instanceof Error ? error.message : 'Bluetooth chat could not start.')
    } finally { if (alive.current) setStarting(false) }
  }

  async function stop() {
    setNotice('')
    try { await Nearby.stop() } catch { setNotice('Couldn’t stop Bluetooth chat.') }
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    const body = draft.trim()
    const current = run.current
    const links = latest.current.links
    if (sending || !current || !latest.current.active || !links.length || !body || encodeText(body).length > MAX_TEXT_BYTES) return
    setSending(true)
    setNotice('')
    const announcement = current.identity.announce()
    const packet = current.identity.text(body)
    try {
      const accepted = await Promise.all(links.map(link => sendOnLink(link, announcement, packet)))
      if (!alive.current) return
      if (accepted.some(Boolean)) {
        setDraft('')
        setMessages(previous => [...previous, {
          id: proofId(packet), name: current.name, sender: current.identity.id, local: true,
          when: packet.when, body, status: 'queued' as const,
        }].slice(-160))
      } else setNotice('Nothing was sent. Wait for a nearby link, then try again.')
    } finally { if (alive.current) setSending(false) }
  }

  const length = encodeText(draft).length
  return createPortal(
    <dialog ref={dialog} className="ag-nearby" aria-labelledby="ag-nearby-heading"
      onCancel={event => { event.preventDefault(); onClose() }}>
      <header className="ag-nearby-heading">
        <Bluetooth size={20} aria-hidden="true" />
        <div><h2 id="ag-nearby-heading">Nearby Bluetooth</h2><p>Public mesh · No internet required</p></div>
        <button type="button" className="ag-btn ag-btn-ghost" aria-label="Close nearby chat" onClick={onClose}><X size={19} /></button>
      </header>
      <div className="ag-nearby-control">
        {!state.active && <label>Nearby name<input value={name} autoComplete="off" maxLength={36} onChange={event => setName(event.currentTarget.value)} /></label>}
        <button type="button" className="ag-btn ag-btn-secondary" disabled={supported !== true || starting}
          onClick={() => void (state.active ? stop() : start())}>
          {starting ? 'Starting…' : state.active ? 'Stop Bluetooth' : 'Start Bluetooth'}
        </button>
        <span role="status" className="ag-nearby-status">
          {supported === false ? 'Bluetooth LE is unavailable on this device.' :
            supported === null ? 'Checking Bluetooth…' :
              state.active ? (state.links.length ? `${state.links.length} radio ${state.links.length === 1 ? 'link' : 'links'} · ${peerCount} nearby ${peerCount === 1 ? 'identity' : 'identities'}` : 'Looking for nearby Bitchat peers…') : 'Bluetooth chat is off.'}
        </span>
      </div>
      <p className="ag-nearby-note">Anyone on the nearby mesh can read these messages. This session is separate from Nostr, and closing this view stops the radio.</p>
      {state.error || notice ? <p className="ag-nearby-notice" role="alert">{notice || state.error}</p> : null}
      <div ref={stream} className="ag-nearby-stream" role="log" aria-live="polite" aria-label="Nearby messages">
        {!messages.length && <p className="ag-nearby-empty">Messages shared nearby will appear here.</p>}
        {messages.map(message => (
          <article key={message.id} data-own={message.local ? 'true' : undefined}>
            <div><strong>{message.name}{message.local ? ' (you)' : ''}</strong>
              <span>{timeLabel.format(message.when)}{message.status ? ' · Queued' : ''}</span></div>
            <p dir="auto">{message.body}</p>
          </article>
        ))}
      </div>
      <form className="ag-nearby-compose" onSubmit={event => void send(event)}>
        <textarea value={draft} rows={2} maxLength={MAX_TEXT_BYTES} aria-label="Public nearby message"
          placeholder="Message nearby peers" onChange={event => setDraft(event.currentTarget.value)} />
        <button className="ag-btn ag-btn-primary" type="submit" aria-label="Send nearby message"
          disabled={sending || !state.active || !state.links.length || !draft.trim() || length > MAX_TEXT_BYTES}><Send size={18} /></button>
        <small>{length} / {MAX_TEXT_BYTES} bytes</small>
      </form>
    </dialog>,
    document.body
  )
}
