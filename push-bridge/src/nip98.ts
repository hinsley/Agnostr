import { verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure'
import { sha256Hex } from './webpush.ts'

export const KIND_NIP98_HTTP_AUTH = 27235
const MAX_CLOCK_SKEW_SEC = 120

export type Nip98AuthResult =
  | {
      ok: true
      pubkey: string
      event: NostrEvent
    }
  | {
      ok: false
      status: number
      error: string
    }

function decodeBase64ToUtf8(raw: string): string {
  const clean = raw.trim().replace(/-/g, '+').replace(/_/g, '/')
  const pad = '='.repeat((4 - (clean.length % 4)) % 4)
  const binary = atob(clean + pad)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder().decode(bytes)
}

function getTagValue(tags: string[][], key: string): string | null {
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === key && typeof tag[1] === 'string') {
      return tag[1]
    }
  }
  return null
}

function normalizeUrlNoTrailingSlash(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/**
 * Verifies a NIP-98 (`kind: 27235`) HTTP Authorization header (`Authorization: Nostr <base64>`),
 * including timestamp freshness (<=120s), URL & method matching, SHA-256 body payload hash,
 * and Schnorr signature verification via `nostr-tools/pure`.
 */
export async function verifyNip98Request(
  request: Request,
  rawBody: string
): Promise<Nip98AuthResult> {
  const authHeader = request.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Nostr ')) {
    return { ok: false, status: 401, error: 'Missing Nostr NIP-98 Authorization header.' }
  }

  const encoded = authHeader.slice('Nostr '.length).trim()
  if (!encoded) {
    return { ok: false, status: 401, error: 'Empty Nostr NIP-98 Authorization token.' }
  }

  let ev: NostrEvent
  try {
    const json = decodeBase64ToUtf8(encoded)
    ev = JSON.parse(json) as NostrEvent
  } catch {
    return { ok: false, status: 401, error: 'Malformed NIP-98 Authorization event.' }
  }

  if (
    !ev ||
    typeof ev !== 'object' ||
    ev.kind !== KIND_NIP98_HTTP_AUTH ||
    typeof ev.pubkey !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(ev.pubkey) ||
    typeof ev.created_at !== 'number' ||
    !Array.isArray(ev.tags)
  ) {
    return { ok: false, status: 401, error: 'Invalid NIP-98 event structure or kind.' }
  }

  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - ev.created_at) > MAX_CLOCK_SKEW_SEC) {
    return { ok: false, status: 401, error: 'NIP-98 auth event timestamp expired.' }
  }

  const methodTag = getTagValue(ev.tags, 'method')?.toUpperCase()
  if (!methodTag || methodTag !== request.method.toUpperCase()) {
    return { ok: false, status: 401, error: 'NIP-98 method tag mismatch.' }
  }

  const uTag = getTagValue(ev.tags, 'u')
  if (!uTag) {
    return { ok: false, status: 401, error: 'Missing NIP-98 u tag.' }
  }
  const parsedReqUrl = new URL(request.url)
  const expectedFull = normalizeUrlNoTrailingSlash(request.url)
  const expectedOriginPath = normalizeUrlNoTrailingSlash(
    `${parsedReqUrl.origin}${parsedReqUrl.pathname}`
  )
  const gotUrl = normalizeUrlNoTrailingSlash(uTag)
  if (gotUrl !== expectedFull && gotUrl !== expectedOriginPath) {
    return { ok: false, status: 401, error: 'NIP-98 URL tag mismatch.' }
  }

  if (rawBody.length > 0) {
    const payloadTag = getTagValue(ev.tags, 'payload')?.toLowerCase()
    if (!payloadTag) {
      return { ok: false, status: 401, error: 'Missing NIP-98 payload hash tag.' }
    }
    const actualHash = await sha256Hex(rawBody)
    if (payloadTag !== actualHash) {
      return { ok: false, status: 401, error: 'NIP-98 payload SHA-256 mismatch.' }
    }
  }

  let validSig = false
  try {
    validSig = verifyEvent(ev)
  } catch {
    validSig = false
  }
  if (!validSig) {
    return { ok: false, status: 401, error: 'Invalid NIP-98 Schnorr signature.' }
  }

  return {
    ok: true,
    pubkey: ev.pubkey.toLowerCase(),
    event: ev,
  }
}
