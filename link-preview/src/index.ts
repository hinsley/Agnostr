import { Parser } from 'htmlparser2'
import { previewUrl } from './url.ts'

interface Limiter { limit(input: { key: string }): Promise<{ success: boolean }> }
interface Env {
  ALLOWED_ORIGINS: string
  REQUEST_LIMITER: Limiter
  LOCATION_LIMITER: Limiter
}

const BODY_LIMIT = 2048
const HTML_LIMIT = 96 * 1024
const REDIRECT_LIMIT = 2

async function readBounded(stream: ReadableStream<Uint8Array> | null, limit: number, truncate = false): Promise<string | null> {
  if (!stream) return null
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = '', bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      if (bytes + value.length >= limit) {
        void reader.cancel().catch(() => {})
        return truncate ? text + decoder.decode(value.subarray(0, limit - bytes)) : null
      }
      bytes += value.length
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

export function plainText(value: string, max: number): string {
  return value.slice(0, max * 8)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max)
}

function parseHead(html: string) {
  const meta = new Map<string, string>()
  let pageTitle = '', inTitle = false
  const tags = new Set(['og:title', 'twitter:title', 'og:description', 'twitter:description', 'description'])
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === 'body') parser.pause()
      if (name === 'title') inTitle = true
      if (name !== 'meta') return
      const key = (attrs.property || attrs.name || '').toLowerCase().trim()
      const value = attrs.content
      if (value && tags.has(key) && !meta.has(key)) meta.set(key, value)
    },
    onclosetag(name) {
      if (name === 'head') parser.pause()
      if (name === 'title') inTitle = false
    },
    ontext(chunk) {
      if (inTitle && pageTitle.length < 1200) pageTitle += chunk.slice(0, 1200)
    },
  })
  parser.end(html)
  const title = plainText(meta.get('og:title') || meta.get('twitter:title') || pageTitle, 180)
  if (!title) return null
  return {
    title,
    description: plainText(meta.get('og:description') || meta.get('twitter:description') || meta.get('description') || '', 280),
  }
}

export async function loadCard(start: string, fetcher = fetch, signal = AbortSignal.timeout(4500)) {
  let target = previewUrl(start)
  if (!target) return null
  for (let hop = 0; hop <= REDIRECT_LIMIT; hop++) {
    const response = await fetcher(target, {
      method: 'GET', redirect: 'manual', signal,
      headers: { Accept: 'text/html, application/xhtml+xml;q=0.9' },
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {})
      const next = response.headers.get('Location')
      if (!next) return null
      target = previewUrl(new URL(next, target).href)
      if (!target) return null
      continue
    }
    if (!response.ok || !/^\s*(?:text\/html|application\/xhtml\+xml)\s*(?:;|$)/i.test(response.headers.get('Content-Type') || '')) {
      void response.body?.cancel().catch(() => {})
      return null
    }
    const html = await readBounded(response.body, HTML_LIMIT, true)
    return html ? parseHead(html) : null
  }
  return null
}

export async function handlePreview(request: Request, env: Env, fetcher = fetch): Promise<Response> {
    const origin = request.headers.get('Origin')
    if (!origin || !env.ALLOWED_ORIGINS.split(',').includes(origin)) return new Response(null, { status: 403 })
    if (new URL(request.url).pathname !== '/preview') return new Response(null, { status: 404 })
    const headers = {
      'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600',
      Vary: 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
      return new Response(null, { status: 405, headers })
    }
    try {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
      if (!(await env.REQUEST_LIMITER.limit({ key: ip })).success ||
          !(await env.LOCATION_LIMITER.limit({ key: 'preview' })).success) {
        return new Response(null, { status: 429, headers })
      }
      const raw = await readBounded(request.body, BODY_LIMIT)
      if (!raw) return new Response(null, { status: 400, headers })
      const body = JSON.parse(raw)
      if (typeof body?.url !== 'string' || !previewUrl(body.url)) return new Response(null, { status: 400, headers })
      const card = await loadCard(body.url, fetcher)
      return card ? Response.json(card, { headers }) : new Response(null, { status: 204, headers })
    } catch {
      return new Response(null, { status: 204, headers })
    }
}

export default { fetch: (request: Request, env: Env) => handlePreview(request, env) }
