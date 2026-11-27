import { getShareBaseHref } from './appPlatform.ts'
import { nip19 } from 'nostr-tools'
import { extractCashuTokenString } from './cashuWallet.ts'
import { decodePubkeyInput, encodeNpubSafe } from './identity.ts'
import { parseServerInvite } from './virtualServers.ts'
import { parseLightningPayload } from './zaps.ts'

export interface ParsedDmShareTarget {
  kind: 'dm'
  pubkey: string
  npub: string
  nickname?: string
}

export interface ParsedServerInviteShareTarget {
  kind: 'server-invite'
  inviteCode: string
}

export interface ParsedCashuShareTarget {
  kind: 'cashu'
  token: string
}

export interface ParsedLightningShareTarget {
  kind: 'lightning'
  payload: string
  lightningKind: 'bolt11' | 'lud16' | 'lnurl'
}

export interface ParsedAgoraNoteShareTarget {
  kind: 'agora-note'
  noteId: string
  nevent: string
  authorPubkey?: string
  relays?: string[]
}

export interface ParsedAgoraProfileShareTarget {
  kind: 'agora-profile'
  pubkey: string
  npub: string
}

export type ParsedShareTarget =
  | ParsedDmShareTarget
  | ParsedServerInviteShareTarget
  | ParsedCashuShareTarget
  | ParsedLightningShareTarget
  | ParsedAgoraNoteShareTarget
  | ParsedAgoraProfileShareTarget

function sanitizeNickname(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  const clean = raw.trim().replace(/\s+/g, ' ').slice(0, 32)
  return clean || undefined
}

/**
 * Decodes a Nostr public identifier (`npub1...`, `nostr:npub1...`, `nprofile1...`,
 * `nostr:nprofile1...`, or 64-char hex pubkey) into a lowercase 64-char hex pubkey.
 */
function decodeDmIdentifier(raw: string): string | null {
  const cleaned = raw.trim().replace(/^nostr:/i, '').trim()
  if (!cleaned) return null

  const direct = decodePubkeyInput(cleaned)
  if (direct) return direct

  if (cleaned.toLowerCase().startsWith('nprofile1')) {
    try {
      const decoded = nip19.decode(cleaned)
      if (
        decoded.type === 'nprofile' &&
        typeof decoded.data.pubkey === 'string' &&
        /^[0-9a-f]{64}$/i.test(decoded.data.pubkey)
      ) {
        return decoded.data.pubkey.toLowerCase()
      }
    } catch {
      return null
    }
  }

  return null
}

function parseDmParams(paramString: string): ParsedDmShareTarget | null {
  const clean = paramString.replace(/^[#?]+/, '').trim()
  if (!clean) return null
  let params: URLSearchParams
  try {
    params = new URLSearchParams(clean)
  } catch {
    return null
  }
  const dmRaw = params.get('dm')
  if (!dmRaw) return null
  const pubkey = decodeDmIdentifier(dmRaw)
  if (!pubkey) return null
  const npub = encodeNpubSafe(pubkey)
  const nickname = sanitizeNickname(params.get('name') ?? params.get('nick'))
  return nickname ? { kind: 'dm', pubkey, npub, nickname } : { kind: 'dm', pubkey, npub }
}

function parseInviteParams(paramString: string): ParsedServerInviteShareTarget | null {
  const clean = paramString.replace(/^[#?]+/, '').trim()
  if (!clean) return null
  let params: URLSearchParams
  try {
    params = new URLSearchParams(clean)
  } catch {
    return null
  }
  const inviteRaw = params.get('invite')
  if (!inviteRaw) return null
  const parsed = parseServerInvite(inviteRaw)
  if (!parsed) return null
  return { kind: 'server-invite', inviteCode: parsed.rawCode }
}

function normalizeHex64(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null
}

function sanitizeAgoraRelayHints(relays?: readonly string[]): string[] | undefined {
  if (!relays || relays.length === 0) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of relays) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!/^wss?:\/\/\S+$/i.test(trimmed)) continue
    try {
      const parsed = new URL(trimmed)
      if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') continue
      const normalized = parsed.toString().replace(/\/+$/, '')
      if (!seen.has(normalized)) {
        seen.add(normalized)
        out.push(normalized)
        if (out.length >= 6) break
      }
    } catch {
      // Ignore malformed relay hint
    }
  }
  return out.length > 0 ? out : undefined
}

function stripNostrProtocolPrefix(raw: string): string {
  let cleaned = raw.trim()
  if (!cleaned) return ''
  // Protocol handlers like web+nostr:%s may percent-encode the full URI inside #agora=%s
  if (/%[0-9a-f]{2}/i.test(cleaned)) {
    try {
      cleaned = decodeURIComponent(cleaned).trim()
    } catch {
      // Keep original string if percent-encoding is malformed
    }
  }
  cleaned = cleaned.replace(/^web\+nostr:(?:\/\/)?/i, '')
  cleaned = cleaned.replace(/^nostr:(?:\/\/)?/i, '')
  cleaned = cleaned.replace(/\/+$/, '').trim()
  return cleaned
}

function decodeAgoraNoteOnly(rawToken: string): ParsedAgoraNoteShareTarget | null {
  const cleaned = stripNostrProtocolPrefix(rawToken)
  if (!cleaned) return null
  const lower = cleaned.toLowerCase()

  if (lower.startsWith('nevent1')) {
    try {
      const decoded = nip19.decode(cleaned)
      if (decoded.type === 'nevent') {
        const noteId = normalizeHex64(decoded.data.id)
        if (!noteId) return null
        const authorPubkey = normalizeHex64(decoded.data.author) ?? undefined
        const relays = sanitizeAgoraRelayHints(decoded.data.relays)
        const nevent = nip19.neventEncode({
          id: noteId,
          ...(authorPubkey ? { author: authorPubkey } : {}),
          ...(relays ? { relays: relays.slice(0, 3) } : {}),
        })
        return {
          kind: 'agora-note',
          noteId,
          nevent,
          ...(authorPubkey ? { authorPubkey } : {}),
          ...(relays ? { relays } : {}),
        }
      }
    } catch {
      return null
    }
    return null
  }

  if (lower.startsWith('note1')) {
    try {
      const decoded = nip19.decode(cleaned)
      if (decoded.type === 'note') {
        const noteId = normalizeHex64(decoded.data)
        if (!noteId) return null
        return {
          kind: 'agora-note',
          noteId,
          nevent: nip19.neventEncode({ id: noteId }),
        }
      }
    } catch {
      return null
    }
    return null
  }

  return null
}

function decodeAgoraToken(
  rawToken: string
): ParsedAgoraNoteShareTarget | ParsedAgoraProfileShareTarget | null {
  const noteTarget = decodeAgoraNoteOnly(rawToken)
  if (noteTarget) return noteTarget

  const cleaned = stripNostrProtocolPrefix(rawToken)
  if (!cleaned) return null
  const lower = cleaned.toLowerCase()

  if (lower.startsWith('npub1') || lower.startsWith('nprofile1')) {
    const pubkey = decodeDmIdentifier(cleaned)
    if (!pubkey) return null
    return {
      kind: 'agora-profile',
      pubkey,
      npub: encodeNpubSafe(pubkey),
    }
  }

  const hex = normalizeHex64(cleaned)
  if (hex) {
    return {
      kind: 'agora-note',
      noteId: hex,
      nevent: nip19.neventEncode({ id: hex }),
    }
  }

  return null
}

function parseAgoraParams(
  paramString: string
): ParsedAgoraNoteShareTarget | ParsedAgoraProfileShareTarget | null {
  const clean = paramString.replace(/^[#?]+/, '').trim()
  if (!clean) return null
  let params: URLSearchParams
  try {
    params = new URLSearchParams(clean)
  } catch {
    return null
  }
  const agoraRaw = params.get('agora') ?? params.get('post')
  if (!agoraRaw) return null
  return decodeAgoraToken(agoraRaw)
}

function isAgnostrOriginUrl(url: URL): boolean {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'agnostr.com' || host === 'www.agnostr.com') return true
  if (typeof window !== 'undefined' && window.location && url.origin === window.location.origin) {
    return true
  }
  return false
}

/**
 * Builds a shareable Agnostr Agora note/reply deep link:
 * `${origin}${pathname}#agora=<nevent1...>`
 */
export function buildAgoraNoteShareUrl(
  noteId: string,
  authorPubkey?: string,
  relays?: readonly string[]
): string {
  const decodedExisting = decodeAgoraNoteOnly(noteId)
  const cleanId = decodedExisting?.noteId ?? normalizeHex64(noteId)
  if (!cleanId) {
    return `${getShareBaseHref()}#agora=${encodeURIComponent(noteId.trim())}`
  }
  const cleanAuthor =
    (authorPubkey ? decodeDmIdentifier(authorPubkey) : null) ??
    decodedExisting?.authorPubkey ??
    undefined
  const cleanRelays = sanitizeAgoraRelayHints(relays ?? decodedExisting?.relays)?.slice(0, 3)
  const nevent = nip19.neventEncode({
    id: cleanId,
    ...(cleanAuthor ? { author: cleanAuthor } : {}),
    ...(cleanRelays && cleanRelays.length > 0 ? { relays: cleanRelays } : {}),
  })
  return `${getShareBaseHref()}#agora=${nevent}`
}

/**
 * Builds a shareable Agnostr Agora profile deep link:
 * `${origin}${pathname}#agora=<npub1...>`
 */
export function buildAgoraProfileShareUrl(pubkey: string): string {
  const hex = decodeDmIdentifier(pubkey)
  const npub = hex ? nip19.npubEncode(hex) : encodeNpubSafe(pubkey.trim())
  return `${getShareBaseHref()}#agora=${npub}`
}

/**
 * Parses an Agnostr Agora share URL (`#agora=...`, `?agora=...`, `#post=...`, or `web+nostr:...`)
 * on same-origin or `agnostr.com` URLs.
 */
export function parseAgoraShareUrl(
  rawUrl: string
): ParsedAgoraNoteShareTarget | ParsedAgoraProfileShareTarget | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  if (/^web\+nostr:/i.test(trimmed)) {
    return decodeAgoraToken(trimmed)
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      if (!isAgnostrOriginUrl(url)) return null
      if (url.hash) {
        const fromHash = parseAgoraParams(url.hash)
        if (fromHash) return fromHash
      }
      if (url.search) {
        const fromSearch = parseAgoraParams(url.search)
        if (fromSearch) return fromSearch
      }
      return null
    } catch {
      return null
    }
  }

  // Relative same-origin fragments/paths (`/#agora=...`, `/?agora=...`, `#agora=...`, `#post=...`)
  const relCleaned = trimmed.replace(/^\/+/, '')
  const lower = relCleaned.toLowerCase()
  if (
    lower.startsWith('#agora=') ||
    lower.startsWith('?agora=') ||
    lower.startsWith('#post=') ||
    lower.startsWith('?post=')
  ) {
    return parseAgoraParams(relCleaned)
  }

  return null
}

/**
 * Builds a shareable Agnostr DM deep link:
 * `${origin}${pathname}#dm=<npub1...>(&name=<encodedNickname>)`
 */
export function buildDmShareUrl(pubkey: string, nickname?: string): string {
  const hex = decodeDmIdentifier(pubkey)
  const npub = hex ? nip19.npubEncode(hex) : encodeNpubSafe(pubkey.trim())
  const cleanNick = sanitizeNickname(nickname)
  const suffix = cleanNick ? `&name=${encodeURIComponent(cleanNick)}` : ''
  return `${getShareBaseHref()}#dm=${npub}${suffix}`
}

/**
 * Builds a shareable Agnostr community invite link:
 * `${origin}${pathname}#invite=<encodedInviteCode>`
 */
export function buildServerInviteShareUrl(inviteCode: string): string {
  const trimmed = inviteCode.trim()
  let code = trimmed
  const hashIdx = trimmed.toLowerCase().indexOf('#invite=')
  if (hashIdx >= 0) {
    try {
      code = decodeURIComponent(trimmed.slice(hashIdx + '#invite='.length).split('&')[0] || trimmed)
    } catch {
      code = trimmed.slice(hashIdx + '#invite='.length).split('&')[0] || trimmed
    }
  }
  return `${getShareBaseHref()}#invite=${encodeURIComponent(code)}`
}

/**
 * Parses any Agnostr DM link, Agora post/profile link (`#agora=...`, `?agora=...`, `#post=...`,
 * `web+nostr:...`), bare Nostr identifier (`npub1...`, `nprofile1...`, `nevent1...`, `note1...`,
 * `nostr:...`, 64-char hex), or Agnostr community invite link/code (`#invite=...`, `?invite=...`,
 * `ag1...`, `naddr1...`, or NIP-29 `<relay>'<groupId>`).
 */
export function parseShareTarget(rawInput: string): ParsedShareTarget | null {
  const trimmed = rawInput.trim()
  if (!trimmed) return null

  // 0. web+nostr:... protocol handler URI
  if (/^web\+nostr:/i.test(trimmed)) {
    const agoraFromProto = decodeAgoraToken(trimmed)
    if (agoraFromProto) return agoraFromProto
  }

  // 1. Full URL with #agora=, ?agora=, #post=, #dm=, ?dm=, #invite=, or ?invite=
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      if (url.hash) {
        const agoraFromHash = parseAgoraParams(url.hash)
        if (agoraFromHash) return agoraFromHash
        const dmFromHash = parseDmParams(url.hash)
        if (dmFromHash) return dmFromHash
        const invFromHash = parseInviteParams(url.hash)
        if (invFromHash) return invFromHash
      }
      if (url.search) {
        const agoraFromSearch = parseAgoraParams(url.search)
        if (agoraFromSearch) return agoraFromSearch
        const dmFromSearch = parseDmParams(url.search)
        if (dmFromSearch) return dmFromSearch
        const invFromSearch = parseInviteParams(url.search)
        if (invFromSearch) return invFromSearch
      }
    } catch {
      // Fall through to fragment/code parsing
    }
  }

  // 2. Hash or query fragment (`#agora=...`, `?agora=...`, `#post=...`, `#dm=...`, `#invite=...`)
  const lower = trimmed.toLowerCase()
  if (
    lower.startsWith('#agora=') ||
    lower.startsWith('?agora=') ||
    lower.startsWith('agora=') ||
    lower.startsWith('#post=') ||
    lower.startsWith('?post=') ||
    lower.startsWith('post=') ||
    lower.startsWith('/#agora=') ||
    lower.startsWith('/?agora=') ||
    lower.startsWith('/#post=')
  ) {
    const agora = parseAgoraParams(trimmed.replace(/^\/+/, ''))
    if (agora) return agora
  }
  if (lower.startsWith('#dm=') || lower.startsWith('?dm=') || lower.startsWith('dm=')) {
    const dm = parseDmParams(trimmed)
    if (dm) return dm
  }
  if (lower.startsWith('#invite=') || lower.startsWith('?invite=') || lower.startsWith('invite=')) {
    const inv = parseInviteParams(trimmed)
    if (inv) return inv
  }

  // 3. Cashu Ecash token (`cashuA...`, `cashuB...`, `cashu:...`)
  const cashuToken = extractCashuTokenString(trimmed)
  if (cashuToken) {
    return { kind: 'cashu', token: cashuToken }
  }

  // 4. Community invite code (ag1..., naddr1..., or NIP-29 relay'groupId)
  const serverInvite = parseServerInvite(trimmed)
  if (serverInvite) {
    return { kind: 'server-invite', inviteCode: serverInvite.rawCode }
  }

  // 5. Bare Nostr note/event identifier (`nevent1...`, `nostr:nevent1...`, `note1...`, `nostr:note1...`)
  const agoraNote = decodeAgoraNoteOnly(trimmed)
  if (agoraNote) {
    return agoraNote
  }

  // 6. Bare Nostr DM identifier (`npub1...`, `nostr:npub1...`, `nprofile1...`, `nostr:nprofile1...`, hex)
  const pubkey = decodeDmIdentifier(trimmed)
  if (pubkey) {
    return {
      kind: 'dm',
      pubkey,
      npub: encodeNpubSafe(pubkey),
    }
  }

  // 7. Lightning invoice / address / LNURL (`lightning:...`, `lnbc...`, `user@domain`, `lnurl1...`)
  const lightning = parseLightningPayload(trimmed)
  if (lightning) {
    return {
      kind: 'lightning',
      payload:
        lightning.kind === 'bolt11'
          ? lightning.invoice
          : lightning.kind === 'lud16'
            ? lightning.address
            : lightning.lnurl,
      lightningKind: lightning.kind,
    }
  }

  return null
}

/**
 * Extracts a pending `#agora=...` / `#post=...` (or `?agora=...` / `?post=...`)
 * deep link from `window.location`.
 */
export function extractPendingAgoraFromLocation():
  | ParsedAgoraNoteShareTarget
  | ParsedAgoraProfileShareTarget
  | null {
  if (typeof window === 'undefined' || !window.location) return null
  const fromHash = window.location.hash ? parseAgoraParams(window.location.hash) : null
  if (fromHash) return fromHash
  const fromSearch = window.location.search ? parseAgoraParams(window.location.search) : null
  if (fromSearch) return fromSearch
  return null
}

/**
 * Clears `#agora=...` / `#post=...` (and `?agora=` / `?post=`) from the URL bar while
 * preserving `window.history.state` so back-button interception stays intact.
 */
export function clearLocationAgoraHash(): void {
  if (typeof window === 'undefined' || !window.location) return
  try {
    const url = new URL(window.location.href)
    let changed = false

    const hashClean = url.hash.replace(/^#/, '').toLowerCase()
    if (hashClean.startsWith('agora=') || hashClean.startsWith('post=')) {
      url.hash = '#agora'
      changed = true
    }
    if (url.searchParams.has('agora')) {
      url.searchParams.delete('agora')
      changed = true
    }
    if (url.searchParams.has('post')) {
      url.searchParams.delete('post')
      changed = true
    }

    if (changed) {
      const nextUrl = `${url.pathname}${url.search}${url.hash}`
      window.history.replaceState(window.history.state, '', nextUrl)
    }
  } catch {
    // Ignore restricted History API environments
  }
}

/**
 * Extracts a pending `#dm=...` (or `?dm=...`) deep link from `window.location`.
 */
export function extractPendingDmFromLocation(): {
  pubkey: string
  npub: string
  nickname?: string
} | null {
  if (typeof window === 'undefined' || !window.location) return null
  const fromHash = window.location.hash ? parseDmParams(window.location.hash) : null
  if (fromHash) {
    return fromHash.nickname
      ? { pubkey: fromHash.pubkey, npub: fromHash.npub, nickname: fromHash.nickname }
      : { pubkey: fromHash.pubkey, npub: fromHash.npub }
  }
  const fromSearch = window.location.search ? parseDmParams(window.location.search) : null
  if (fromSearch) {
    return fromSearch.nickname
      ? { pubkey: fromSearch.pubkey, npub: fromSearch.npub, nickname: fromSearch.nickname }
      : { pubkey: fromSearch.pubkey, npub: fromSearch.npub }
  }
  return null
}

/**
 * Clears `#dm=...` (and `?dm=` / `?name=`) from the URL bar while preserving
 * `window.history.state` so Android back-button interception (`__agnostrBack`) stays intact.
 */
export function clearLocationDmHash(fallbackGeohash?: string): void {
  if (typeof window === 'undefined' || !window.location) return
  try {
    const url = new URL(window.location.href)
    let changed = false

    if (url.hash.replace(/^#/, '').toLowerCase().startsWith('dm=')) {
      url.hash = fallbackGeohash ? `#${fallbackGeohash}` : ''
      changed = true
    }
    if (url.searchParams.has('dm')) {
      url.searchParams.delete('dm')
      url.searchParams.delete('name')
      url.searchParams.delete('nick')
      changed = true
    }

    if (changed) {
      const nextUrl = `${url.pathname}${url.search}${url.hash}`
      window.history.replaceState(window.history.state, '', nextUrl)
    }
  } catch {
    // Ignore restricted History API environments
  }
}
