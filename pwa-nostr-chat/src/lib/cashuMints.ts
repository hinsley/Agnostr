import type { CashuMintCatalogEntry, CashuMintInfoSummary } from '../types/wallet.ts'

/**
 * Live-audited public Cashu mainnet mints verified against:
 *   - HTTP 200 on `/v1/info` and `/v1/keysets`
 *   - Active `sat` unit keyset
 *   - Browser CORS (`Access-Control-Allow-Origin: *` on GET + OPTIONS preflight)
 *
 * Users can also add any custom HTTPS Cashu mint URL at runtime.
 */
export const DEFAULT_CASHU_MINTS: readonly CashuMintCatalogEntry[] = [
  {
    url: 'https://mint.minibits.cash/Bitcoin',
    name: 'Minibits Mint',
    description: 'Popular CDK mainnet mint with zero input fees (0 ppk).',
    feePpk: 0,
    version: 'cdk-mintd/0.18.3',
    verifiedNuts: [4, 5, 7, 8, 9, 10, 11, 12, 14, 15, 17, 19, 20, 29],
    verifiedAt: '2026-11-23',
  },
  {
    url: 'https://mint.coinos.io',
    name: 'Coinos Mint',
    description: 'High-liquidity Lightning & Cashu community mint.',
    feePpk: 100,
    version: 'Nutshell/0.22.1',
    verifiedNuts: [4, 5, 7, 8, 9, 10, 11, 12, 14, 15, 17, 19, 20, 29],
    verifiedAt: '2026-11-23',
  },
  {
    url: 'https://mint.macadamia.cash',
    name: 'Macadamia Mint',
    description: 'CDK mainnet mint powering the Macadamia wallet.',
    feePpk: 150,
    version: 'cdk-mintd/0.18.1',
    verifiedNuts: [4, 5, 7, 8, 9, 10, 11, 12, 14, 15, 17, 19, 20, 29],
    verifiedAt: '2026-11-23',
  },
  {
    url: 'https://mint.cubabitcoin.org',
    name: 'Mint Cuba Bitcoin',
    description: 'Community-operated Nutshell Cashu mint by Cuba Bitcoin.',
    feePpk: 100,
    version: 'Nutshell/0.22.1',
    verifiedNuts: [4, 5, 7, 8, 9, 10, 11, 12, 14, 15, 17, 19, 20, 29],
    verifiedAt: '2026-11-23',
  },
  {
    url: 'https://mint.lnvoltz.com',
    name: 'Voltz Mint',
    description: 'Reliable public Nutshell mint hosted by lnvoltz.xyz.',
    feePpk: 100,
    version: 'Nutshell/0.20.3',
    verifiedNuts: [4, 5, 7, 8, 9, 10, 11, 12, 14, 17, 19, 20, 29],
    verifiedAt: '2026-11-23',
  },
  {
    url: 'https://mint.chorus.community',
    name: 'Chorus Mint',
    description: 'Public community Cashu mint operated by Chorus.',
    feePpk: 100,
    version: 'Nutshell/0.20.3.1',
    verifiedNuts: [4, 5, 7, 8, 9, 10, 11, 12, 14, 15, 17, 20, 29],
    verifiedAt: '2026-11-23',
  },
  {
    url: 'https://mint.mountainlake.io',
    name: 'Mountainlake M5',
    description: 'Independent Nutshell mint for bitcoiners, friends, and family.',
    feePpk: 250,
    version: 'Nutshell/0.22.1',
    verifiedNuts: [4, 5, 7, 8, 9, 10, 11, 12, 14, 15, 17, 19, 20, 29],
    verifiedAt: '2026-11-23',
  },
  {
    url: 'https://mint.westernbtc.com',
    name: 'WesternBTC Mint',
    description: 'Self-hosted bare-metal CDK Cashu mint (no cloud providers).',
    feePpk: 100,
    version: 'cdk-mintd/0.17.6',
    verifiedNuts: [4, 5, 7, 8, 9, 10, 11, 12, 14, 15, 17, 19, 20, 29],
    verifiedAt: '2026-11-23',
  },
] as const

export const DEFAULT_ACTIVE_MINT_URL = DEFAULT_CASHU_MINTS[0].url

/**
 * Normalizes a Cashu mint URL:
 * - Requires https:// (or http:// for localhost / 127.0.0.1 dev mints)
 * - Strips trailing slashes, query strings, and fragments
 */
export function normalizeMintUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(withProto)
    const isLocal =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname.endsWith('.local')
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
      return null
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.origin}${cleanPath}`
  } catch {
    return null
  }
}

export function formatMintHost(mintUrl: string): string {
  try {
    const u = new URL(mintUrl)
    const path = u.pathname.replace(/\/+$/, '')
    return path && path !== '/' ? `${u.host}${path}` : u.host
  } catch {
    return mintUrl
  }
}

export function findCatalogMint(mintUrl: string): CashuMintCatalogEntry | null {
  const norm = normalizeMintUrl(mintUrl)
  if (!norm) return null
  return DEFAULT_CASHU_MINTS.find((m) => normalizeMintUrl(m.url) === norm) ?? null
}

interface RawMintInfo {
  name?: string
  description?: string
  description_long?: string
  version?: string
  motd?: string
  pubkey?: string
  nuts?: Record<string, unknown>
}

interface RawKeysetEntry {
  id: string
  unit: string
  active: boolean
  input_fee_ppk?: number
}

/**
 * Probes `/v1/info` and `/v1/keysets` directly from the browser to verify mint
 * availability, active `sat` keysets, input fee rate (`input_fee_ppk`), and supported NUTs.
 */
export async function probeCashuMint(
  mintUrl: string,
  timeoutMs = 10_000
): Promise<CashuMintInfoSummary> {
  const normalized = normalizeMintUrl(mintUrl)
  if (!normalized) {
    throw new Error('Enter a valid HTTPS Cashu mint URL.')
  }

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    const [infoRes, keysetsRes] = await Promise.all([
      fetch(`${normalized}/v1/info`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }),
      fetch(`${normalized}/v1/keysets`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }),
    ])

    if (!infoRes.ok) {
      throw new Error(`Mint /v1/info returned HTTP ${infoRes.status}.`)
    }
    if (!keysetsRes.ok) {
      throw new Error(`Mint /v1/keysets returned HTTP ${keysetsRes.status}.`)
    }

    const info = (await infoRes.json()) as RawMintInfo
    const ksBody = (await keysetsRes.json()) as { keysets?: RawKeysetEntry[] }
    const keysets = Array.isArray(ksBody.keysets) ? ksBody.keysets : []
    const activeSatKeysets = keysets
      .filter((k) => k && k.active && k.unit === 'sat')
      .sort((a, b) => (a.input_fee_ppk ?? 0) - (b.input_fee_ppk ?? 0))

    if (activeSatKeysets.length === 0) {
      throw new Error('Mint has no active satoshi (sat) keysets.')
    }

    const nuts = info.nuts
      ? Object.keys(info.nuts)
          .map((n) => Number.parseInt(n, 10))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b)
      : []

    const cheapest = activeSatKeysets[0]
    const catalog = findCatalogMint(normalized)

    return {
      url: normalized,
      name: (info.name || catalog?.name || formatMintHost(normalized)).trim(),
      description: (info.description || info.description_long || catalog?.description || '').trim() || undefined,
      version: typeof info.version === 'string' ? info.version : undefined,
      motd: typeof info.motd === 'string' && info.motd.trim() ? info.motd.trim() : undefined,
      pubkey: typeof info.pubkey === 'string' ? info.pubkey : undefined,
      nuts,
      feePpk: typeof cheapest.input_fee_ppk === 'number' ? cheapest.input_fee_ppk : 0,
      activeSatKeysetId: cheapest.id,
      online: true,
      lastCheckedAt: Date.now(),
    }
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? 'Mint timed out while responding.'
          : err.message
        : 'Unable to reach Cashu mint.'
    return {
      url: normalized,
      name: findCatalogMint(normalized)?.name || formatMintHost(normalized),
      nuts: [],
      feePpk: null,
      activeSatKeysetId: null,
      online: false,
      lastCheckedAt: Date.now(),
      error: message,
    }
  } finally {
    window.clearTimeout(timer)
  }
}
