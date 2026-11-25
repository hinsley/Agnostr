import type { ImageAttachment } from '../types/protocol.ts'

const RASTER_EXT = /\.(?:png|jpe?g|webp|gif|avif|bmp)$/i
const BLOB_PATH = /\/[a-f0-9]{64}$/i
const MARKER = /(?:^|[\t \r\n])(\[image\][\t \r\n]+((?:https:\/\/|image\.nostr\.build\/)[^\s<>"'`]+))/gi

interface InlineChatImage {
  image: ImageAttachment
  caption: string
}

/** Glub and compatible clients can send public-room images as plain text.
 * Require an explicit marker and a raster extension or content-address-shaped
 * path. Never derive an attachment merely from an ordinary URL. */
export function parseInlineChatImage(content: string, tags: string[][] = []): InlineChatImage | undefined {
  if (!content.toLowerCase().includes('[image]')) return undefined
  for (const match of content.matchAll(MARKER)) {
    const start = (match.index ?? 0) + match[0].length - match[1].length
    const before = content.slice(0, start)
    // A literal example in a fenced/inline code span isn't an attachment.
    if ((before.match(/```/g)?.length ?? 0) % 2 ||
        (before.slice(before.lastIndexOf('\n') + 1).match(/`/g)?.length ?? 0) % 2) continue
    const rawUrl = match[2].replace(/[),.!?;:\]]+$/, '')
    if (!rawUrl || rawUrl.length > 2048) continue
    const href = /^https:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`
    let url: URL
    try {
      url = new URL(href)
    } catch {
      continue
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/i.test(url.hostname) ||
        /\.(?:localhost|local|internal|test|invalid)$/i.test(url.hostname)) continue
    if (!RASTER_EXT.test(url.pathname) && !BLOB_PATH.test(url.pathname)) continue
    // Keep typed video/audio intact: the Glub marker is also used for video.
    if (tags.some((tag) => tag[0] === 'imeta' &&
        tag.some((value) => value === `url ${href}` || value === `url ${url.href}`) &&
        tag.some((value) => /^m (?:video\/|audio\/|image\/svg\+xml)/i.test(value)))) continue

    const end = start + match[1].length - match[2].length + rawUrl.length
    return {
      image: {
        url: url.href, mime: 'image/webp', sha256: '', size: 0, width: 0, height: 0,
        server: url.origin, inlineMarker: true,
      },
      caption: (content.slice(0, start) + content.slice(end)).trim(),
    }
  }
  return undefined
}

/** Infer the Blob type from the bytes rather than accepting HTML, SVG, or
 * video masquerading behind an extensionless image link. */
export function inferInlineRasterMime(bytes: Uint8Array): string | undefined {
  const at = (offset: number, signature: string) =>
    bytes.length >= offset + signature.length &&
    [...signature].every((c, i) => bytes[offset + i] === c.charCodeAt(0))
  if (bytes.length >= 8 && at(0, '\x89PNG\r\n\x1a\n')) return 'image/png'
  if (at(0, '\xff\xd8\xff')) return 'image/jpeg'
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'image/gif'
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp'
  if (at(0, 'BM') && bytes.length >= 14) return 'image/bmp'
  if (at(4, 'ftyp') && (at(8, 'avif') || at(8, 'avis'))) return 'image/avif'
  return undefined
}
