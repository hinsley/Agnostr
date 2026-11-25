import assert from 'node:assert/strict'
import test from 'node:test'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
import {
  KIND_GEOHASH_CHAT, KIND_NAMED_BITCHAT_CHAT, parseGeohashChatEvent, parseNamedBitchatChatEvent,
} from '../src/lib/bitchatProtocol.ts'
import { inferInlineVoiceMime, parseInlineChatVoice } from '../src/lib/inlineChatVoice.ts'
import { downloadAndVerifyMediaBlob, MAX_VOICE_BLOB_BYTES } from '../src/lib/blossom.ts'

const hash = '3e11fab7'.padEnd(64, '0')
const url = 'https://video.nostr.build/' + hash
const content = 'Before\n[voice] ' + url + '\nAfter https://example.org/page'
const key = generateSecretKey()
const box = (id, ...payload) => {
  const body = Buffer.concat(payload)
  const header = Buffer.alloc(8)
  header.writeUInt32BE(body.length + 8)
  header.write(id, 4, 'ascii')
  return Buffer.concat([header, body])
}
const track = (handler) => box('trak', box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from(handler))))
const mp4 = (...tracks) => Buffer.concat([
  box('ftyp', Buffer.from('isom')), box('mdat', Buffer.from([1])), box('moov', ...tracks.map(track)),
])
const ebml = (id, ...payload) => {
  const body = Buffer.concat(payload)
  return Buffer.concat([Buffer.from(id, 'hex'), Buffer.from([0x80 | body.length]), body])
}
const ogg = (head, serial = 0, first = true) => {
  const page = Buffer.alloc(28)
  page.write('OggS')
  page[5] = first ? 2 : 0
  page.writeUInt32LE(serial, 14)
  page[26] = 1
  page[27] = head.length
  return Buffer.concat([page, Buffer.from(head, 'latin1')])
}
const webmEntry = (type, codec) => ebml('ae', ebml('83', Buffer.from([type])), ebml('86', Buffer.from(codec)))
const webm = (...entries) => Buffer.concat([
  ebml('1a45dfa3', ebml('4282', Buffer.from('webm'))),
  ebml('18538067', ebml('1654ae6b', ...entries), ebml('1f43b675', Buffer.from([0]))),
])

test('Glub public geo/topic memo and bare displayed URL parse while preserving original message and caption', () => {
  const geo = finalizeEvent({ kind: KIND_GEOHASH_CHAT, created_at: 1700000000, tags: [['g', '9q8']], content }, key)
  const topic = finalizeEvent({ kind: KIND_NAMED_BITCHAT_CHAT, created_at: 1700000000, tags: [['d', 'sample']], content }, key)
  for (const msg of [parseGeohashChatEvent(geo, '9q8', new Set()), parseNamedBitchatChatEvent(topic, 'sample', new Set())]) {
    assert.equal(msg.content, content)
    assert.equal(msg.voiceMemo.url, url)
    assert.equal(msg.voiceMemo.inlineVoiceMarker, true)
    assert.equal(msg.voiceMemo.sha256, '')
  }
  assert.equal(parseInlineChatVoice(content).caption.replace(/\s+/g, ' '), 'Before After https://example.org/page')
  assert.equal(parseInlineChatVoice('[voice] ' + url.slice(8)).memo.url, url)
  for (const ext of ['m4a', 'mp4', 'webm', 'ogg', 'wav', 'mp3']) {
    assert.equal(parseInlineChatVoice(`[voice] https://video.nostr.build/${hash}.${ext}`).memo.inlineVoiceMarker, true)
  }
})

test('ordinary links, fenced/inline code and restricted URLs remain text; valid imeta is unchanged', () => {
  for (const text of [url, '[voice] here ' + url, '`[voice] ' + url + '`', '```text\n[voice] ' + url + '\n```',
    '[voice] http://example.org/a.mp4', '[voice] https://x:pass@example.org/a.mp4',
    '[voice] https://example.org:567/a.mp4', '[voice] https://test.local/a.mp4', '[voice] https://example.org/a.svg',
    '[voice] https://example.org/page']) assert.equal(parseInlineChatVoice(text), undefined)
  assert.equal(parseInlineChatVoice(content, [['imeta', 'url ' + url, 'm video/mp4']]), undefined)
  const tagged = 'https://example.org/memo.webm'
  const event = finalizeEvent({ kind: KIND_GEOHASH_CHAT, created_at: 1700000000,
    tags: [['g', '9q8'], ['imeta', 'url ' + tagged, 'm audio/webm', 'duration 1.5', 'x ' + hash]], content }, key)
  const parsed = parseGeohashChatEvent(event, '9q8', new Set())
  assert.equal(parsed.voiceMemo.url, tagged)
  assert.equal(parsed.voiceMemo.durationSec, 1.5)
  assert.equal(parsed.voiceMemo.sha256, hash)
  assert.equal(parsed.voiceMemo.inlineVoiceMarker, undefined)
})

test('shared audio/video containers must declare only audio tracks', () => {
  assert.equal(inferInlineVoiceMime(mp4('soun')), 'audio/mp4')
  assert.equal(inferInlineVoiceMime(mp4('vide')), undefined)
  assert.equal(inferInlineVoiceMime(mp4('soun', 'vide')), undefined)
  assert.equal(inferInlineVoiceMime(mp4('soun').subarray(0, -2)), undefined)
  assert.equal(inferInlineVoiceMime(webm(webmEntry(2, 'A_OPUS'))), 'audio/webm')
  assert.equal(inferInlineVoiceMime(webm(webmEntry(1, 'V_VP9'))), undefined)
  assert.equal(inferInlineVoiceMime(webm(webmEntry(2, 'A_OPUS'), webmEntry(1, 'V_VP9'))), undefined)
  assert.equal(inferInlineVoiceMime(Buffer.from('<script>alert(1)</script>')), undefined)
  assert.equal(inferInlineVoiceMime(ogg('OpusHead')), 'audio/ogg')
  assert.equal(inferInlineVoiceMime(ogg('\x01vorbis')), 'audio/ogg')
  assert.equal(inferInlineVoiceMime(ogg('\x7fFLAC')), 'audio/ogg')
  assert.equal(inferInlineVoiceMime(Buffer.concat([ogg('OpusHead'), ogg('theora', 1)])), undefined)
  assert.equal(inferInlineVoiceMime(Buffer.from('ID3')), undefined)
})

test('download is gated, anonymous, byte-bounded, and returns a typed local audio blob', async () => {
  const memo = parseInlineChatVoice(content).memo
  const original = globalThis.fetch
  let requests = 0, reply = mp4('soun')
  globalThis.fetch = async (actual, options) => {
    assert.equal(actual, url)
    assert.equal(options.credentials, 'omit')
    assert.equal(options.referrerPolicy, 'no-referrer')
    assert.equal(options.redirect, 'error')
    requests += 1
    return new Response(reply, { headers: { 'Content-Type': 'video/mp4' } })
  }
  try {
    await assert.rejects(downloadAndVerifyMediaBlob(memo, () => { throw Error('untrusted') }), /untrusted/)
    assert.equal(requests, 0)
    assert.equal((await downloadAndVerifyMediaBlob(memo, () => {})).type, 'audio/mp4')
    reply = mp4('soun', 'vide')
    await assert.rejects(downloadAndVerifyMediaBlob(memo, () => {}), /supported audio/)
    reply = new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(MAX_VOICE_BLOB_BYTES + 1))
      controller.close()
    } })
    await assert.rejects(downloadAndVerifyMediaBlob(memo, () => {}), /maximum allowed/)
  } finally {
    globalThis.fetch = original
  }
})
