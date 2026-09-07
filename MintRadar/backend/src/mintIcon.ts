import { pool } from './db.js'
import { safeFetch } from './ssrf.js'
import { normalizeUrl } from './discovery.js'

// SSRF-safe mint favicon proxy.
//
// The frontend must never fetch a mint-controlled `icon_url` directly: that URL
// comes from the mint's own /v1/info response, so a hostile operator could point
// it at an attacker server and harvest the IP + User-Agent of every visitor who
// loads a page showing that mint — a deanonymisation beacon across the whole
// user base (2026-09-07 security audit). Instead the client points every <img>
// at GET /api/mint/icon?url=<mint url>, which:
//   1. resolves `icon_url` from the DB for a KNOWN mint only (never proxies an
//      arbitrary caller-supplied URL — the stored value was already validated by
//      the prober to be https://),
//   2. fetches it through safeFetch (private-range block + connect-time DNS
//      pinning + redirect re-validation — same guard the mint prober uses),
//   3. re-serves the bytes from our own origin, cached in-process.
// Anything that isn't a small raster image → the client falls back to the
// bundled SVG placeholder.

const CACHE_TTL_MS = 6 * 60 * 60 * 1000   // 6h for a resolved icon
const NEGATIVE_TTL_MS = 30 * 60 * 1000    // 30min for "no icon / unfetchable" — self-heals
const MAX_ICON_BYTES = 256 * 1024         // 256 KB
const MAX_CACHE_ENTRIES = 500

// SVG is deliberately excluded. An <img> never runs an SVG's scripts, but a
// direct navigation to /api/mint/icon?url=… would render it as a document on
// mintradar's own origin — stored XSS. Raster + ico only.
const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
])

export interface MintIcon {
  body: Buffer
  contentType: string
}

interface CacheEntry {
  icon: MintIcon | null
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

/** Test hook — clears the in-process icon cache. */
export function _resetMintIconCache(): void {
  cache.clear()
}

async function fetchMintIcon(mintUrl: string): Promise<MintIcon | null> {
  const result = await pool.query('SELECT icon_url FROM mints WHERE url = $1', [mintUrl])
  if (result.rows.length === 0) return null // not a known mint — refuse to proxy

  const iconUrl = result.rows[0]?.['icon_url'] as string | null | undefined
  if (typeof iconUrl !== 'string' || !iconUrl.startsWith('https://')) return null

  const res = await safeFetch(iconUrl, { timeoutMs: 5_000 })
  if (!res || !res.ok) return null

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) return null

  const declaredLen = Number(res.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLen) && declaredLen > MAX_ICON_BYTES) return null

  const body = Buffer.from(await res.arrayBuffer())
  if (body.byteLength === 0 || body.byteLength > MAX_ICON_BYTES) return null

  return { body, contentType }
}

/**
 * Returns the proxied favicon for a mint, or null when there is nothing safe to
 * serve (unknown mint, no icon_url, non-image, oversized, unreachable, blocked).
 * Never throws. Results (including nulls) are cached in-process so upstream is
 * hit at most once per mint per TTL regardless of request volume.
 */
export async function getMintIcon(rawMintUrl: string): Promise<MintIcon | null> {
  const mintUrl = normalizeUrl(rawMintUrl)
  const now = Date.now()

  const cached = cache.get(mintUrl)
  if (cached && cached.expiresAt > now) return cached.icon

  let icon: MintIcon | null
  try {
    icon = await fetchMintIcon(mintUrl)
  } catch {
    icon = null
  }

  cache.set(mintUrl, { icon, expiresAt: now + (icon ? CACHE_TTL_MS : NEGATIVE_TTL_MS) })

  // Safety valve — there are ~100 mints, so this effectively never trips.
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }

  return icon
}
