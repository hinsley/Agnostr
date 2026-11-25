import assert from 'node:assert/strict'
import test from 'node:test'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
import {
  KIND_GEOHASH_CHAT, KIND_NAMED_BITCHAT_CHAT,
  parseGeohashChatEvent, parseNamedBitchatChatEvent,
} from '../src/lib/bitchatProtocol.ts'
import { inferInlineRasterMime, parseInlineChatImage } from '../src/lib/inlineChatImage.ts'
import { downloadAndVerifyMediaBlob } from '../src/lib/blossom.ts'

const hashShape = 'dc90df7be968e5cac5afa78695f'.padEnd(64, '0')
const url = 'https://image.nostr.build/' + hashShape
const content = 'Before\n[image] ' + url + '\nAfter https://example.org/page'
const secret = generateSecretKey()

test('parses an extensionless Glub wire URL in public geo/topic chat and leaves the message intact', () => {
  const geochat = finalizeEvent({ kind: KIND_GEOHASH_CHAT, created_at: 1700000000, tags: [['g', '9q8']], content }, secret)
  const topicchat = finalizeEvent({ kind: KIND_NAMED_BITCHAT_CHAT, created_at: 1700000000, tags: [['d', 'example']], content }, secret)
  for (const msg of [parseGeohashChatEvent(geochat, '9q8', new Set()), parseNamedBitchatChatEvent(topicchat, 'example', new Set())]) {
    assert.equal(msg.content, content)
    assert.equal(msg.imageAttachment.url, url)
    assert.equal(msg.imageAttachment.inlineMarker, true)
    assert.equal(msg.imageAttachment.sha256, '')
  }
  const inline = parseInlineChatImage(content)
  assert.equal(inline.caption.replace(/\s+/g, ' '), 'Before After https://example.org/page')
  assert.equal(parseInlineChatImage('[image] ' + url.slice(8)).image.url, url)
  assert.equal(parseInlineChatImage('[image] https://example.org/photo.png').image.inlineMarker, true)
})

test('ordinary links, code, unsupported URLs, and Glub video markers stay plain text', () => {
  for (const text of [
    url, 'ordinary https://example.org/photo.png', '[image] here ' + url,
    '[image] javascript:alert(1)', '[image] https://example.org/script.svg',
    '[image] https://example.org/video.mp4', '[image] https://example.org/page',
    '[image] https://localhost/example.png', '[image] https://foo:bar@example.org/abc.png',
    '[image] https://example.org:3333/preview.jpg',
    '`[image] ' + url + '`', '```text\n[image] ' + url + '\n```',
  ]) assert.equal(parseInlineChatImage(text), undefined, text)
  assert.equal(parseInlineChatImage('[image] ' + url, [['imeta', 'url ' + url, 'm video/mp4']]), undefined)
})

test('explicit imeta metadata takes priority', () => {
  const tagged = 'https://assets.example.org/original.png'
  const ev = finalizeEvent({ kind: KIND_GEOHASH_CHAT, created_at: 1700000000,
    tags: [['g', '9q8'], ['imeta', 'url ' + tagged, 'm image/png', 'dim 124x91']], content }, secret)
  const msg = parseGeohashChatEvent(ev, '9q8', new Set())
  assert.equal(msg.imageAttachment.url, tagged)
  assert.equal(msg.imageAttachment.width, 124)
  assert.equal(msg.imageAttachment.inlineMarker, undefined)
})

test('bounded attachment loader authorizes before I/O and accepts only raster bytes for a marker', async () => {
  const image = parseInlineChatImage('[image] ' + url).image
  let requests = 0, reply
  const real = globalThis.fetch
  globalThis.window = { setTimeout, clearTimeout }
  globalThis.fetch = async (actual, options) => {
    assert.equal(actual, url)
    assert.equal(options.credentials, 'omit')
    assert.equal(options.referrerPolicy, 'no-referrer')
    requests += 1
    return new Response(reply)
  }
  try {
    await assert.rejects(downloadAndVerifyMediaBlob(image, () => { throw Error('untrusted') }), /untrusted/)
    assert.equal(requests, 0)
    reply = '<svg xmlns="http://www.w3.org/2000/svg"><script>test</script></svg>'
    await assert.rejects(downloadAndVerifyMediaBlob(image, () => {}), /supported image/)
    reply = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])
    await assert.rejects(downloadAndVerifyMediaBlob(image, () => {}), /supported image/)
    reply = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/X2sAAAAASUVORK5CYII=', 'base64'))
    assert.equal(inferInlineRasterMime(reply), 'image/png')
    const blob = await downloadAndVerifyMediaBlob(image, () => {})
    assert.equal(blob.type, 'image/png')
  } finally {
    globalThis.fetch = real
    delete globalThis.window
  }
})
