import type { VoiceMemoAttachment } from '../types/protocol.ts'
import { findInlineMediaLinks } from './inlineMediaLink.ts'

const MARKER = /(?:^|[\t \r\n])(\[voice\][\t \r\n]+((?:https:\/\/|video\.nostr\.build\/)[^\s<>"'`]+))/gi
const VOICE_PATH = /(?:\.(?:m4a|mp4|webm|weba|ogg|oga|opus|mp3|aac|wav|flac)|\/[a-f0-9]{64})$/i

export function parseInlineChatVoice(content: string, tags: string[][] = []):
  { memo: VoiceMemoAttachment; caption: string } | undefined {
  for (const { href, url, caption } of findInlineMediaLinks(content, MARKER)) {
    if (!VOICE_PATH.test(url.pathname)) continue
    // If this URL has typed attachment metadata, leave its handling to imeta.
    if (tags.some((tag) => tag[0] === 'imeta' &&
      tag.some((value) => value === `url ${href}` || value === `url ${url.href}`))) continue
    return {
      memo: {
        url: url.href, mime: '', sha256: '', size: 0, durationSec: 0, waveform: [],
        server: url.origin, inlineVoiceMarker: true,
      },
      caption,
    }
  }
  return undefined
}

const matchAt = (bytes: Uint8Array, pos: number, word: string) =>
  pos >= 0 && pos + word.length <= bytes.length &&
  [...word].every((ch, i) => bytes[pos + i] === ch.charCodeAt(0))

function mp4IsAudioOnly(bytes: Uint8Array): boolean {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let budget = 2048
  function boxes(start: number, end: number): { tag: number; start: number; end: number }[] | undefined {
    const found = []
    for (let i = start; i < end;) {
      if (--budget < 0 || end - i < 8) return
      let length = dv.getUint32(i)
      let header = 8
      if (length === 1) {
        if (end - i < 16 || dv.getUint32(i + 8) !== 0) return
        length = dv.getUint32(i + 12)
        header = 16
      } else if (!length) length = end - i
      if (length < header || length > end - i) return
      found.push({ tag: i + 4, start: i + header, end: i + length })
      i += length
    }
    return found
  }
  const root = boxes(0, bytes.length)
  const movies = root?.filter((box) => matchAt(bytes, box.tag, 'moov'))
  if (!root || movies?.length !== 1 ||
      !root.some((box) => matchAt(bytes, box.tag, 'mdat') && box.start < box.end)) return false
  const { start, end } = movies[0]
  const tracks = boxes(start, end)?.filter((box) => matchAt(bytes, box.tag, 'trak'))
  return Boolean(tracks?.length && tracks.every((track) => {
    const media = boxes(track.start, track.end)?.filter((box) => matchAt(bytes, box.tag, 'mdia'))
    if (media?.length !== 1) return false
    const handlers = boxes(media[0].start, media[0].end)?.filter((box) => matchAt(bytes, box.tag, 'hdlr'))
    return handlers?.length === 1 && handlers[0].end - handlers[0].start >= 12 &&
      matchAt(bytes, handlers[0].start + 8, 'soun')
  }))
}

function webmIsAudioOnly(bytes: Uint8Array): boolean {
  let budget = 4096
  function vint(start: number, end: number, isId = false) {
    if (start >= end || !bytes[start]) return
    const width = Math.clz32(bytes[start]) - 23
    if (width > (isId ? 4 : 8) || start + width > end) return
    let value = isId ? bytes[start] : bytes[start] & (0xff >> width)
    let unknown = !isId && value === (0xff >> width)
    for (let i = 1; i < width; ++i) {
      unknown &&= bytes[start + i] === 255
      value = value * 256 + bytes[start + i]
    }
    if (!unknown && !Number.isSafeInteger(value)) return
    return { value, end: start + width, unknown }
  }
  function* elements(start: number, end: number) {
    for (let i = start; i < end;) {
      if (--budget < 0) throw new Error('Too many elements')
      const id = vint(i, end, true)
      const size = id && vint(id.end, end)
      if (!id || !size || (size.unknown && id.value !== 0x18538067 && id.value !== 0x1f43b675)) throw new Error('Invalid element')
      const next = size.unknown ? end : size.end + size.value
      if (next > end) throw new Error('Truncated element')
      yield { id: id.value, start: size.end, end: next }
      i = next
    }
  }
  try {
    const root = [...elements(0, bytes.length)]
    const headers = root.filter((item) => item.id === 0x1a45dfa3)
    const segments = root.filter((item) => item.id === 0x18538067)
    if (headers.length !== 1 || segments.length !== 1 ||
        ![...elements(headers[0].start, headers[0].end)].some((item) =>
          item.id === 0x4282 && item.end - item.start === 4 && matchAt(bytes, item.start, 'webm'))) return false
    const segment = [...elements(segments[0].start, segments[0].end)]
    const tracks = segment.filter((item) => item.id === 0x1654ae6b)
    if (tracks.length !== 1 || !segment.some((item) => item.id === 0x1f43b675)) return false
    const entries = [...elements(tracks[0].start, tracks[0].end)].filter((item) => item.id === 0xae)
    return entries.length > 0 && entries.every((entry) => {
      const data = [...elements(entry.start, entry.end)]
      const types = data.filter((item) => item.id === 0x83)
      return types.length === 1 && types[0].end - types[0].start === 1 && bytes[types[0].start] === 2 &&
        data.some((item) => item.id === 0x86 &&
          ['A_OPUS', 'A_VORBIS'].some((codec) => item.end - item.start === codec.length && matchAt(bytes, item.start, codec)))
    })
  } catch {
    return false
  }
}

function oggIsAudio(bytes: Uint8Array): boolean {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 28 || !(bytes[5] & 2)) return false
  const serial = dv.getUint32(14)
  let count = 0
  for (let i = 0; i < bytes.length;) {
    if (++count > 8192 || !matchAt(bytes, i, 'OggS') || bytes.length - i < 27 ||
        bytes[i + 4] !== 0 || dv.getUint32(i + 14) !== serial || (i !== 0 && bytes[i + 5] & 2)) return false
    const start = i + 27 + bytes[i + 26]
    if (start > bytes.length) return false
    let payload = 0
    for (let k = i + 27; k < start; ++k) payload += bytes[k]
    if (i === 0 && !((payload >= 8 && matchAt(bytes, start, 'OpusHead')) ||
                     (payload >= 7 && matchAt(bytes, start, '\x01vorbis')) ||
                     (payload >= 5 && matchAt(bytes, start, '\x7fFLAC')))) return false
    i = start + payload
    if (i > bytes.length) return false
  }
  return true
}

/** Check the bounded download before mounting a local blob. For containers
 * shared with video, require audio tracks (and no video tracks), not an
 * extension, claimed Content-Type, or the sender's marker alone. */
export function inferInlineVoiceMime(bytes: Uint8Array): string | undefined {
  if (matchAt(bytes, 4, 'ftyp')) return mp4IsAudioOnly(bytes) ? 'audio/mp4' : undefined
  if (matchAt(bytes, 0, '\x1a\x45\xdf\xa3')) return webmIsAudioOnly(bytes) ? 'audio/webm' : undefined
  if (matchAt(bytes, 0, 'OggS')) return oggIsAudio(bytes) ? 'audio/ogg' : undefined
  if (matchAt(bytes, 0, 'RIFF') && matchAt(bytes, 8, 'WAVE')) return 'audio/wav'
  if (matchAt(bytes, 0, 'fLaC')) return 'audio/flac'
  let offset = 0
  if (bytes.length >= 10 && matchAt(bytes, 0, 'ID3') &&
      [6, 7, 8, 9].every((idx) => bytes[idx] < 128)) {
    offset = 10 + (bytes[6] << 21) + (bytes[7] << 14) + (bytes[8] << 7) + bytes[9]
    if (bytes[3] === 4 && (bytes[5] & 0x10)) offset += 10
  }
  if (offset + 7 <= bytes.length && bytes[offset] === 255) {
    const flag = bytes[offset + 1]
    const rate = bytes[offset + 2]
    if ((flag & 0xf6) === 0xf0 && ((rate >> 2) & 15) < 13) return 'audio/aac'
    if ((flag & 0xe0) === 0xe0 && (flag & 0x18) !== 8 && (flag & 6) !== 0 &&
        (rate >> 4) !== 0 && (rate >> 4) !== 15 && ((rate >> 2) & 3) !== 3) return 'audio/mpeg'
  }
  return undefined
}
