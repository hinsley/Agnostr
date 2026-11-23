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

export type ParsedShareTarget =
  | ParsedDmShareTarget
  | ParsedServerInviteShareTarget
  | ParsedCashuShareTarget
  | ParsedLightningShareTarget

const FALLBACK_BASE_HREF = 'https://agnostr.com/'

function getAppBaseHref(): string {
  if (typeof window !== 'undefined' && window.location) {
    return `${window.location.origin}${window.location.pathname}`
  }
  return FALLBACK_BASE_HREF
}

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

/**
 * Builds a shareable Agnostr DM deep link:
 * `${origin}${pathname}#dm=<npub1...>(&name=<encodedNickname>)`
 */
export function buildDmShareUrl(pubkey: string, nickname?: string): string {
  const hex = decodeDmIdentifier(pubkey)
  const npub = hex ? nip19.npubEncode(hex) : encodeNpubSafe(pubkey.trim())
  const cleanNick = sanitizeNickname(nickname)
  const suffix = cleanNick ? `&name=${encodeURIComponent(cleanNick)}` : ''
  return `${getAppBaseHref()}#dm=${npub}${suffix}`
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
  return `${getAppBaseHref()}#invite=${encodeURIComponent(code)}`
}

/**
 * Parses any Agnostr DM link, bare Nostr identifier (`npub1...`, `nprofile1...`, `nostr:...`,
 * 64-char hex), or Agnostr community invite link/code (`#invite=...`, `?invite=...`, `ag1...`,
 * `naddr1...`, or NIP-29 `<relay>'<groupId>`).
 */
export function parseShareTarget(rawInput: string): ParsedShareTarget | null {
  const trimmed = rawInput.trim()
  if (!trimmed) return null

  // 1. Full URL with #dm=, ?dm=, #invite=, or ?invite=
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      if (url.hash) {
        const dmFromHash = parseDmParams(url.hash)
        if (dmFromHash) return dmFromHash
        const invFromHash = parseInviteParams(url.hash)
        if (invFromHash) return invFromHash
      }
      if (url.search) {
        const dmFromSearch = parseDmParams(url.search)
        if (dmFromSearch) return dmFromSearch
        const invFromSearch = parseInviteParams(url.search)
        if (invFromSearch) return invFromSearch
      }
    } catch {
      // Fall through to fragment/code parsing
    }
  }

  // 2. Hash or query fragment (`#dm=...`, `?dm=...`, `dm=...`, `#invite=...`, `?invite=...`)
  const lower = trimmed.toLowerCase()
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

  // 5. Bare Nostr DM identifier (`npub1...`, `nostr:npub1...`, `nprofile1...`, `nostr:nprofile1...`, hex)
  const pubkey = decodeDmIdentifier(trimmed)
  if (pubkey) {
    return {
      kind: 'dm',
      pubkey,
      npub: encodeNpubSafe(pubkey),
    }
  }

  // 6. Lightning invoice / address / LNURL (`lightning:...`, `lnbc...`, `user@domain`, `lnurl1...`)
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
