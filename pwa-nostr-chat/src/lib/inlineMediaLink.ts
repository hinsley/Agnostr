/** Shared link and punctuation handling for explicit public-room media markers. */
export function* findInlineMediaLinks(content: string, marker: RegExp) {
  for (const match of content.matchAll(marker)) {
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
    const end = start + match[1].length - match[2].length + rawUrl.length
    yield { href, url, caption: (content.slice(0, start) + content.slice(end)).trim() }
  }
}
