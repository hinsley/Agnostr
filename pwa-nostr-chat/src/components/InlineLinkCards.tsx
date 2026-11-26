import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Link2 } from 'lucide-react'
import './InlineLinkCards.css'

export type LinkPreviewMode = 'automatic' | 'manual'
type Card = { title: string; description: string }
const endpoint = String(import.meta.env.VITE_LINK_PREVIEW_URL || '')
const cache = new Map<string, { value: Card | null; expires: number }>()
const inFlight = new Map<string, { job: Promise<Card | null>; interested: (() => boolean)[] }>()
const MAX_ACTIVE = 4
const waiting: (() => void)[] = []
let active = 0

function fetchCard(url: string, isCurrent: () => boolean): Promise<Card | null> {
  const cached = cache.get(url)
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value)
  const pending = inFlight.get(url)
  if (pending) {
    pending.interested.push(isCurrent)
    return pending.job
  }
  // Bound background work during rapid scrolling and never retain a long queue of URLs.
  if (waiting.length >= 16) return Promise.resolve(null)
  const interested = [isCurrent]
  const abort = new AbortController()
  const job = new Promise<Card | null>((resolve) => {
    const run = () => {
      if (!interested.some((fn) => fn())) {
        resolve(null)
        queueMicrotask(() => { if (active < MAX_ACTIVE) waiting.shift()?.() })
        return
      }
      const timeLimit = setTimeout(() => abort.abort(), 6000)
      active++
      void (async () => {
        let card: Card | null = null
        try {
          const res = await fetch(endpoint, {
            method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer',
            redirect: 'error', headers: { 'Content-Type': 'application/json' },
            signal: abort.signal, body: JSON.stringify({ url }),
          })
          if (res.ok && res.status === 200) {
            const value: unknown = await res.json()
            if (typeof value === 'object' && value !== null && 'title' in value &&
                typeof value.title === 'string' && value.title.trim().length) {
              card = {
                title: value.title.slice(0, 180),
                description: 'description' in value && typeof value.description === 'string' ? value.description.slice(0, 280) : '',
              }
            }
          }
        } catch { /* The original link always remains usable. */ }
        finally {
          clearTimeout(timeLimit)
          cache.delete(url)
          if (cache.size >= 150) cache.delete(cache.keys().next().value!)
          cache.set(url, { value: card, expires: Date.now() + (card ? 3600000 : 60000) })
          resolve(card)
          active--
          waiting.shift()?.()
        }
      })()
    }
    if (active < MAX_ACTIVE) run()
    else waiting.push(run)
  }).finally(() => inFlight.delete(url))
  inFlight.set(url, { job, interested })
  return job
}

function LinkCard({ url, href, mode }: { url: string; href: string; mode: LinkPreviewMode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [requested, setRequested] = useState(false)
  const [card, setCard] = useState<Card | null>(null)
  const [finished, setFinished] = useState(false)
  useEffect(() => {
    if (mode === 'manual' && !requested) return
    let current = true
    let observer: IntersectionObserver | undefined
    const get = () => void fetchCard(url, () => current).then((value) => {
      if (!current) return
      setCard(value)
      setFinished(true)
    })
    if (requested || typeof IntersectionObserver === 'undefined' || !ref.current) get()
    else {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer?.disconnect()
          get()
        }
      }, { rootMargin: '120px' })
      observer.observe(ref.current)
    }
    return () => {
      current = false
      observer?.disconnect()
    }
  }, [url, mode, requested])

  return <div className="ag-link-card-slot" ref={ref}>
    {card ? (
      <a className="ag-link-card" href={href} target="_blank" rel="noopener noreferrer"
        onClick={(event) => event.stopPropagation()}>
        <div className="ag-link-card-copy">
          <span className="ag-link-card-domain">{new URL(url).hostname}</span>
          <strong className="ag-link-card-title">{card.title}</strong>
          {card.description && <span className="ag-link-card-description">{card.description}</span>}
        </div>
        <ArrowUpRight size={15} aria-hidden="true" />
      </a>
    ) : mode === 'manual' && (
      finished ? <span className="ag-link-card-state" role="status">Preview unavailable</span> :
      <button className="ag-link-card-load" type="button" disabled={requested}
        title="Send this URL to Agnostr’s preview service" onClick={(event) => {
          event.stopPropagation()
          setRequested(true)
        }}>
        <Link2 size={13} aria-hidden="true" />
        {requested ? 'Loading preview…' : 'Load link preview'}
      </button>
    )}
  </div>
}

export function InlineLinkCards({ links, mode }: { links: Iterable<readonly [string, string]>; mode?: LinkPreviewMode }) {
  if (!mode || !endpoint) return null
  return <>{Array.from(links, ([url, href]) => (
    <LinkCard key={mode + ':' + url} url={url} href={href} mode={mode} />
  ))}</>
}
