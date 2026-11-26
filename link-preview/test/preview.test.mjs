import test from 'node:test'
import assert from 'node:assert/strict'
import { previewUrl, collectPreviewLink } from '../src/url.ts'
import { handlePreview } from '../src/index.ts'

const origin = 'https://agnostr.com'
const allowed = 'https://newspaper.com/story'
const allow = { async limit() { return { success: true } } }
const deny = { async limit() { return { success: false } } }
const requests = []
const fetcher = async (target, init) => {
  const headers = new Headers(init.headers)
  assert.equal(headers.has('cookie'), false)
  assert.equal(headers.has('authorization'), false)
  assert.equal(init.redirect, 'manual')
  const url = new URL(target)
  assert.equal(url.origin, 'https://newspaper.com')
  assert.equal(url.search + url.hash, '')
  requests.push(target)
  if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1' } })
  if (url.pathname === '/okredirect') return new Response(null, { status: 302, headers: { Location: '/fallback' } })
  if (url.pathname === '/other') return new Response(null, { status: 302, headers: { Location: '/story?token=secret' } })
  if (url.pathname === '/nohtml') return new Response('not html', { headers: { 'Content-Type': 'image/png' } })
  const html = url.pathname === '/fallback'
    ? '<html><head><title>Page title</title></head><body><meta property="og:title" content="ignore after head"></body></html>'
    : '<html><head><meta name="twitter:title" content="Twitter card"><meta property="og:title" content="Open &amp; Graph"><meta name="twitter:description" content="A description"><meta property="og:image" content="https://tracker.com/a"></head><body>not exported</body></html>'
  return new Response(html, { headers: { 'Content-Type': 'text/html' } })
}
function post(url, from = origin, limited = false) {
  return handlePreview(new Request('https://preview.service/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: from, Cookie: 'sid=example', Authorization: 'Bearer fixture' },
    body: JSON.stringify({ url }),
  }), { ALLOWED_ORIGINS: origin, REQUEST_LIMITER: limited ? deny : allow, LOCATION_LIMITER: allow }, fetcher)
}

test('only public HTTPS; removes trackers and fragments but refuses unknown queries', () => {
  for (const url of ['https://localhost', 'https://host.local/', 'https://172.16.0.1/', 'https://0x7f000001/', 'https://[::1]/', 'https://good.com@127.0.0.1/', 'http://good.com/', 'https://good.com:8443/', 'https://good.com?token=secret', 'https://good.com/%6cogin', 'https://good.com/nude.jpg', 'https://agnostr-push.carterhinsley.workers.dev/', 'https:good.com']) {
    assert.equal(previewUrl(url), null, url)
  }
  assert.equal(previewUrl(allowed + '?utm_source=test#section'), allowed)
  assert.equal(previewUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  assert.equal(previewUrl('https://x.com/name/status/123?s=20&t=ignored'), 'https://x.com/name/status/123')
  const cards = new Map()
  for (const url of [allowed, allowed + '#same', 'https://newspaper.com/2', 'https://newspaper.com/3']) collectPreviewLink(cards, url)
  assert.deepEqual([...cards.keys()], [allowed, 'https://newspaper.com/2'])
})
test('serves sanitized metadata from a credential-free request, not page HTML or imagery', async () => {
  const res = await post(allowed + '?utm_source=test#section')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), origin)
  assert.deepEqual(await res.json(), { title: 'Open & Graph', description: 'A description' })
  assert.equal(requests.at(-1), allowed)
  const fallback = await post('https://newspaper.com/okredirect')
  assert.deepEqual(await fallback.json(), { title: 'Page title', description: '' })
})
test('unapproved origins, private redirects, secret queries and non-HTML never become previews', async () => {
  assert.equal((await post(allowed, 'https://bad-origin.com')).status, 403)
  assert.equal((await post(allowed + '?token=secret')).status, 400)
  const before = requests.length
  for (const p of ['/redirect', '/other', '/nohtml']) assert.equal((await post('https://newspaper.com' + p)).status, 204)
  assert.equal((await post(allowed, origin, true)).status, 429)
  assert.equal(requests.length, before + 3)
})
