/* ==========================================================================
   Deterministic Geometric SVG Identicons & Perceptual Pubkey Handle Colors
   Shared across main message stream, sidebar, peers panel, and modals.
   ========================================================================== */

export const MAX_IDENTICON_CACHE = 256

const dataUrlCache = new Map<string, string>()

/**
 * Simple fast 32-bit FNV-1a hash over a string (pubkey hex).
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Deterministic perceptual hue (0–359) for a pubkey.
 */
export function pubkeyToHue(pubkey: string): number {
  const clean = (pubkey || 'agnon').toLowerCase()
  const h = fnv1a(clean)
  return h % 360
}

/**
 * Theme-adaptive CSS color string for a peer's handle (`@nick#xxxx`).
 * Uses CSS custom properties `--handle-s` and `--handle-l` from `tokens.css`
 * so colors automatically maintain high contrast across dark and paper themes.
 */
export function pubkeyToColor(pubkey: string): string {
  const hue = pubkeyToHue(pubkey)
  return `hsl(${hue} var(--handle-s, 78%) var(--handle-l, 68%))`
}

export interface IdenticonData {
  grid: boolean[][]
  hue: number
  secondaryHue: number
  accentColor: string
  secondaryColor: string
  bgColor: string
  borderColor: string
}

/**
 * Generates a deterministic vertically-symmetric 5×5 geometric sigil from a pubkey.
 */
export function getIdenticonData(pubkey: string): IdenticonData {
  const clean = (pubkey || '0000000000000000').toLowerCase()
  const h1 = fnv1a(clean)
  const h2 = fnv1a(clean + ':sigil')

  const hue = h1 % 360
  const secondaryHue = (hue + 42 + (h2 % 48)) % 360

  // Fill 5 rows × 3 columns (cols 0,1,2) and mirror to cols 4,3
  const grid: boolean[][] = []
  let filledCount = 0

  for (let r = 0; r < 5; r++) {
    const row: boolean[] = [false, false, false, false, false]
    for (let c = 0; c < 3; c++) {
      const bitIndex = r * 3 + c
      const source = bitIndex < 16 ? h1 : h2
      const bit = ((source >>> (bitIndex % 16)) & 1) === 1
      row[c] = bit
      row[4 - c] = bit
      if (bit) filledCount += c === 2 ? 1 : 2
    }
    grid.push(row)
  }

  // Guarantee at least a crisp core sigil if hash happened to be sparse
  if (filledCount < 6) {
    grid[1][2] = true
    grid[2][1] = true
    grid[2][2] = true
    grid[2][3] = true
    grid[3][2] = true
  }

  return {
    grid,
    hue,
    secondaryHue,
    accentColor: `hsl(${hue} 78% 60%)`,
    secondaryColor: `hsl(${secondaryHue} 76% 64%)`,
    bgColor: `hsl(${hue} 32% var(--identicon-bg-l, 15%))`,
    borderColor: `hsla(${hue}, 70%, 58%, 0.34)`,
  }
}

/**
 * Returns a memoized `data:image/svg+xml` URI for crisp, zero-DOM-overhead rendering
 * inside `<img>` tags across message rows, peer rosters, and modals.
 */
export function identiconDataUrl(pubkey: string): string {
  const key = (pubkey || 'agnon').toLowerCase()
  const cached = dataUrlCache.get(key)
  if (cached) {
    // Refresh LRU recency on hit
    dataUrlCache.delete(key)
    dataUrlCache.set(key, cached)
    return cached
  }

  const { grid, hue, secondaryHue } = getIdenticonData(key)

  const cellSize = 6
  const pad = 5
  const rects: string[] = []

  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if (!grid[r][c]) continue
      const x = pad + c * cellSize
      const y = pad + r * cellSize
      const fill = (r + c) % 3 === 0
        ? `hsl(${secondaryHue},82%,66%)`
        : `hsl(${hue},82%,60%)`
      rects.push(
        `<rect x="${x}" y="${y}" width="${cellSize - 0.8}" height="${cellSize - 0.8}" rx="1.4" fill="${fill}"/>`
      )
    }
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">`,
    `<rect width="40" height="40" rx="10" fill="hsl(${hue},30%,14%)"/>`,
    `<rect x="0.75" y="0.75" width="38.5" height="38.5" rx="9.25" fill="none" stroke="hsla(${hue},75%,60%,0.32)" stroke-width="1.2"/>`,
    rects.join(''),
    `</svg>`,
  ].join('')

  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  while (dataUrlCache.size >= MAX_IDENTICON_CACHE) {
    const oldest = dataUrlCache.keys().next().value
    if (oldest === undefined) break
    dataUrlCache.delete(oldest)
  }
  dataUrlCache.set(key, url)
  return url
}

/**
 * Formats a compact pubkey display (`a3f1…9c02`).
 */
export function shortPubkey(pubkey: string, head = 6, tail = 4): string {
  if (!pubkey) return '????'
  if (pubkey.length <= head + tail + 1) return pubkey
  return `${pubkey.slice(0, head)}…${pubkey.slice(-tail)}`
}

/**
 * Formats a Bitchat handle (`@nick#a3f1`).
 */
export function formatHandle(nickname: string | undefined, pubkey: string): {
  base: string
  suffix: string
  full: string
} {
  const suffix = (pubkey || '0000').slice(-4).toLowerCase()
  const base = (nickname && nickname.trim()) || `agnon${suffix}`
  return { base, suffix, full: `@${base}#${suffix}` }
}
