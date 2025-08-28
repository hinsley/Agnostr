import { useEffect, useMemo, useRef, useState } from 'react'
import { SimplePool, type EventTemplate, finalizeEvent, getPublicKey, nip19, generateSecretKey } from 'nostr-tools'
import './chat.css'

type ChatMessage = {
  id: string
  content: string
  pubkey: string
  created_at: number
  tags: string[][]
}

const DEFAULT_RELAYS: string[] = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://offchain.pub',
  'wss://nostr.2b9t.xyz',
  'wss://nostr-relay.zimage.com',
  'wss://articles.layer3.news',
  'wss://relay-testnet.k8s.layer3.news',
  'wss://nostr21.com',
]

function formatPubkey(pubkey: string): string {
  if (pubkey.length <= 12) return pubkey
  return pubkey.slice(0, 8) + '…' + pubkey.slice(-4)
}

function formatTime(ts: number): string {
  const date = new Date(ts * 1000)
  const now = Date.now()
  const diffMs = Math.max(0, now - date.getTime())
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return minutes + 'm'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + 'h'
  const days = Math.floor(hours / 24)
  return days + 'd'
}

export default function Chat() {
  const [relays, setRelays] = useState<string[]>(DEFAULT_RELAYS)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [group, setGroup] = useState('global')
  const [sending, setSending] = useState(false)
  const [signMode, setSignMode] = useState<'extension' | 'local' | 'auto'>(() =>
    typeof (window as any).nostr !== 'undefined' ? 'extension' : 'auto'
  )
  const [secretInput, setSecretInput] = useState('')
  const [localPubkey, setLocalPubkey] = useState<string | null>(null)
  const [ephemeralSkHex, setEphemeralSkHex] = useState<string | null>(null)
  const [autoPubkey, setAutoPubkey] = useState<string | null>(null)
  const [nickname, setNickname] = useState('')
  const poolRef = useRef<SimplePool | null>(null)
  const subRef = useRef<{ close: (reason?: string) => void } | null>(null)

  const isNip07 = useMemo(() => typeof (window as any).nostr !== 'undefined', [])

  useEffect(() => {
    poolRef.current = new SimplePool()
    return () => {
      try {
        poolRef.current?.close(relays)
      } catch {}
      poolRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!poolRef.current) return
    if (subRef.current) {
      try { subRef.current.close() } catch {}
    }
    const normalized = group.replace(/^#/, '').toLowerCase()
    setMessages([])
    const since = Math.floor(Date.now() / 1000) - 60 * 60 * 24 // 24h
    const filters = [
      { kinds: [20000], "g": [normalized], "t": ['teleport'], since, limit: 500 },
    ] as any
    const sub = poolRef.current.subscribeMany(
      relays,
      filters,
      {
        onevent: (ev: any) => {
          setMessages((prev) => {
            if (prev.some((m) => m.id === ev.id)) return prev
            const next = [
              ...prev,
              {
                id: ev.id,
                content: ev.content,
                pubkey: ev.pubkey,
                created_at: ev.created_at,
                tags: ev.tags as string[][],
              },
            ]
            next.sort((a, b) => a.created_at - b.created_at)
            return next
          })
        },
        oneose: () => {
          // no-op
        },
      }
    )
    subRef.current = sub
    return () => {
      try { sub.close() } catch {}
    }
  }, [relays, group])

  // Initialize group from URL hash and keep in sync with hash changes
  useEffect(() => {
    const applyHashGroup = () => {
      try {
        const hash = (window.location.hash || '').replace(/^#/, '').trim()
        if (hash) setGroup(hash)
      } catch {}
    }
    applyHashGroup()
    window.addEventListener('hashchange', applyHashGroup)
    return () => window.removeEventListener('hashchange', applyHashGroup)
  }, [])

  // Reflect current group in the URL hash
  useEffect(() => {
    try {
      const current = (window.location.hash || '').replace(/^#/, '')
      if (group !== current) {
        const newHash = '#' + group
        history.replaceState(null, '', newHash)
      }
    } catch {}
  }, [group])

  // Initialize/load ephemeral key for Auto mode
  useEffect(() => {
    try {
      const saved = localStorage.getItem('ephemeral_sk')
      if (saved && /^[0-9a-fA-F]{64}$/.test(saved)) {
        setEphemeralSkHex(saved)
        try { setAutoPubkey(getPublicKey(hexToBytes(saved))) } catch {}
      }
    } catch {}
  }, [])

  // Ensure an ephemeral key exists when switching to Auto
  useEffect(() => {
    if (signMode !== 'auto') return
    if (ephemeralSkHex && /^[0-9a-fA-F]{64}$/.test(ephemeralSkHex)) return
    try {
      const sk = generateSecretKey()
      const hex = bytesToHex(sk)
      setEphemeralSkHex(hex)
      try { setAutoPubkey(getPublicKey(sk)) } catch {}
      try { localStorage.setItem('ephemeral_sk', hex) } catch {}
    } catch {}
  }, [signMode])

  // Derive local pubkey when secret changes
  useEffect(() => {
    if (!secretInput.trim()) {
      setLocalPubkey(null)
      return
    }
    const sk = parseSecretKey(secretInput.trim())
    if (!sk) {
      setLocalPubkey(null)
      return
    }
    try {
      const pk = getPublicKey(sk)
      setLocalPubkey(pk)
    } catch {
      setLocalPubkey(null)
    }
  }, [secretInput])

  function parseSecretKey(text: string): Uint8Array | null {
    try {
      const t = text.trim()
      if (!t) return null
      if (t.startsWith('nsec')) {
        const decoded = nip19.decode(t)
        if (decoded.type === 'nsec' && decoded.data) {
          return decoded.data as Uint8Array
        }
        return null
      }
      // hex fallback
      const hex = t.startsWith('0x') ? t.slice(2) : t
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null
      const out = new Uint8Array(32)
      for (let i = 0; i < 32; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
      }
      return out
    } catch {
      return null
    }
  }

  function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  function hexToBytes(hex: string): Uint8Array {
    const clean = hex.toLowerCase()
    const out = new Uint8Array(clean.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i*2, i*2+2), 16)
    return out
  }

  async function handleSend() {
    if (!input.trim()) return
    if (!poolRef.current) return
    setSending(true)
    try {
      const normalized = group.replace(/^#/, '')
      const tags: string[][] = [
        ['g', normalized],
        ['t', 'teleport'],
      ]
      if (nickname.trim()) tags.push(['n', nickname.trim()])
      const unsigned: EventTemplate = {
        kind: 20000,
        created_at: Math.floor(Date.now() / 1000),
        content: input.trim(),
        tags,
      }
      let signed: any
      if (signMode === 'extension') {
        if (!isNip07) {
          alert('NIP-07 signer not available. Install a Nostr extension or use Local key.')
          return
        }
        const nostr = (window as any).nostr
        signed = await nostr.signEvent(unsigned)
      } else if (signMode === 'local') {
        const sk = parseSecretKey(secretInput)
        if (!sk) {
          alert('Enter a valid secret key (nsec… or 64-hex)')
          return
        }
        signed = finalizeEvent(unsigned, sk)
      } else {
        // auto
        if (!ephemeralSkHex || !/^[0-9a-fA-F]{64}$/.test(ephemeralSkHex)) {
          alert('Auto key unavailable. Try switching mode or reloading.')
          return
        }
        const sk = hexToBytes(ephemeralSkHex)
        signed = finalizeEvent(unsigned, sk)
      }
      const pubs: Promise<string>[] = poolRef.current.publish(relays, signed)
      await Promise.any(pubs)
      setInput('')
      // optimistic add
      setMessages((prev) => {
        const ev = signed as any
        const next = [
          ...prev,
          {
            id: ev.id,
            content: ev.content,
            pubkey: ev.pubkey,
            created_at: ev.created_at,
            tags: ev.tags as string[][],
          },
        ]
        next.sort((a, b) => a.created_at - b.created_at)
        return next
      })
    } catch (e) {
      console.error(e)
      alert('Failed to send event')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="chat-root">
      <header className="chat-header">
        <div className="title">Agnostr</div>
        <div className="status">
          {signMode === 'extension' && (isNip07 ? 'NIP-07' : 'NIP-07 missing')}
          {signMode === 'local' && (localPubkey ? 'local: ' + formatPubkey(localPubkey) : 'local key')}
          {signMode === 'auto' && (autoPubkey ? 'auto: ' + formatPubkey(autoPubkey) : 'auto key')}
        </div>
      </header>
      <div className="chat-controls">
        <input
          className="group-select"
          type="text"
          value={group}
          onChange={(e) => setGroup(e.target.value.replace(/^#/, '').trim())}
          placeholder="group (e.g., 9q)"
        />
        <input
          className="relay-input"
          type="text"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="Nickname (optional)"
        />
        <select
          className="relay-input"
          value={signMode}
          onChange={(e) => setSignMode(e.target.value as 'extension' | 'local' | 'auto')}
        >
          <option value="extension">Extension</option>
          <option value="local">Local key</option>
          <option value="auto">Auto (ephemeral)</option>
        </select>
        {signMode === 'local' && (
          <input
            className="relay-input"
            type="password"
            value={secretInput}
            onChange={(e) => setSecretInput(e.target.value)}
            placeholder="nsec1… or 64-hex secret"
          />
        )}
        <input
          className="relay-input"
          type="text"
          value={relays.join(',')}
          onChange={(e) =>
            setRelays(
              e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            )
          }
          placeholder="Comma-separated relay URLs"
        />
      </div>
      <ul className="messages">
        {messages.map((m) => (
          <li key={m.id} className="message">
            <div className="meta">
              <span className="pk">{formatPubkey(m.pubkey)}</span>
              <span className="time">{formatTime(m.created_at)}</span>
            </div>
            <div className="content">{m.content}</div>
          </li>
        ))}
      </ul>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          handleSend()
        }}
      >
        <input
          className="text"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            signMode === 'extension'
              ? (isNip07 ? 'Write a message…' : 'Install a Nostr extension or switch to Auto/Local')
              : signMode === 'local'
                ? (localPubkey ? 'Write a message…' : 'Enter your nsec to enable sending')
                : (autoPubkey ? 'Write a message…' : 'Generating ephemeral key…')
          }
          disabled={(signMode === 'extension' && !isNip07) || (signMode === 'local' && !localPubkey) || (signMode === 'auto' && !autoPubkey) || sending}
        />
        <button className="send" type="submit" disabled={(signMode === 'extension' && !isNip07) || (signMode === 'local' && !localPubkey) || (signMode === 'auto' && !autoPubkey) || sending}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  )
}

