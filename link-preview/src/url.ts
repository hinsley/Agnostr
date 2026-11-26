// Shared by the client and the isolated, strictly-public preview Worker.
const WEB_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i
const PRIVATE_SUFFIX = /\.(?:localhost|local|internal|home|lan|test|invalid|onion|arpa|alt|corp|intranet|example)$/i
const ATTACHMENT = /\.(?:avif|webp|gif|png|jpe?g|svg|bmp|ico|heic|mp[34]|m4[av]|webm|opus|ogg|wav|mov|pdf|zip|gz|bin|exe)$/i
const SENSITIVE_SEGMENT = /^(?:log-?in|log-?out|sign-?in|sign-?out|unsubscribe|verify|auth|oauth|callback|reset(?:-password)?|activate|magic-?link|invite|token|session|account|download)$/i
const TRACKING = /^(?:utm_[a-z_]+|fbclid|gclid|dclid|mc_cid|mc_eid|igshid|ref_src)$/i
const VIDEO_HOSTS = new Set(['youtube.com','www.youtube.com','m.youtube.com'])
const X_HOSTS = new Set(['x.com','www.x.com','twitter.com','www.twitter.com','mobile.twitter.com'])

export function previewUrl(raw: string): string | null {
  if (!/^https:\/\//i.test(raw) || raw.length > 1024 || /[\\\u0000-\u0020\u007f]/.test(raw)) return null
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
  const host = url.hostname
  if (!WEB_HOST.test(host) || PRIVATE_SUFFIX.test(host) ||
      /(^|\.)(?:localhost|local|internal|intranet)(\.|$)/i.test(host) ||
      host === 'agnostr.com' || host.endsWith('.agnostr.com') ||
      host.endsWith('.workers.dev')) return null
  try {
    const path = decodeURIComponent(url.pathname)
    if (ATTACHMENT.test(path) || /[\\\u0000-\u001f\u007f?#]/.test(path) ||
        path.split('/').some((part) => SENSITIVE_SEGMENT.test(part) || /^[a-z0-9_+=-]{48,}$/i.test(part))) return null
  } catch { return null }

  const params = [...url.searchParams]
  url.search = ''
  url.hash = ''
  for (const [key, value] of params) {
    if (TRACKING.test(key)) continue
    if (VIDEO_HOSTS.has(host) && url.pathname === '/watch' && key === 'v' && /^[\w-]{11}$/.test(value) && !url.search) {
      url.searchParams.set('v', value)
      continue
    }
    if (X_HOSTS.has(host) && /^\/[A-Za-z0-9_]+\/status\/\d+\/?$/.test(url.pathname) && ['s','t'].includes(key)) continue
    // Do not hand unknown query values to a preview service (e.g. signed URLs).
    return null
  }
  return url.href
}

export function collectPreviewLink(
  items: Map<string, string>,
  href: string,
) {
  if (items.size >= 2) return
  const url = previewUrl(href)
  if (url && !items.has(url)) items.set(url, href)
}
