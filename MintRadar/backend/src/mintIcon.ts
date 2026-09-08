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
// 512 KB. Raised from 256 KB (2026-09-08): a diagnostic run showed 5 of 65
// favicon failures were legitimate operator logos rejected purely for size.
// 512 KB comfortably covers a high-res PNG logo while still bounding worst-case
// memory (MAX_CACHE_ENTRIES * 512 KB). The handful of mints shipping a 1–2 MB
// image as their favicon still fall back to the monogram — re-encoding them
// server-side would mean a native image dependency (sharp), which is not worth
// it for that few mints with an unreasonably large asset.
const MAX_ICON_BYTES = 512 * 1024
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

/**
 * Magic-bytes fallback for when a mint serves a real raster image under a
 * wrong or generic Content-Type (the diagnostic run found several mints, e.g.
 * cashu.cz and mint.chorus.community, sending `application/octet-stream` for a
 * genuine .webp / .jpg). Returns the sniffed content type for a *supported*
 * raster format, or null.
 *
 * SVG is explicitly rejected here too — even though it has no binary signature
 * to match, an XML/SVG payload must never pass this path (M1: a direct
 * navigation to the proxy would render it as a document on our own origin).
 */
export function sniffRasterImageType(buf: Buffer): string | null {
  if (buf.length < 4) return null

  // Reject anything that looks like XML/SVG before the signature checks.
  const head = buf.toString('latin1', 0, 256).trimStart().toLowerCase()
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.includes('<svg')) {
    return null
  }

  // PNG — 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png'
  }

  // JPEG — FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg'
  }

  // GIF — "GIF8" (47 49 46 38), i.e. GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return 'image/gif'
  }

  // WebP — "RIFF" .... "WEBP"
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }

  return null
}

async function fetchMintIcon(mintUrl: string): Promise<MintIcon | null> {
  const result = await pool.query('SELECT icon_url FROM mints WHERE url = $1', [mintUrl])
  if (result.rows.length === 0) return null // not a known mint — refuse to proxy

  const iconUrl = result.rows[0]?.['icon_url'] as string | null | undefined
  if (typeof iconUrl !== 'string' || !iconUrl.startsWith('https://')) return null

  const res = await safeFetch(iconUrl, { timeoutMs: 5_000 })
  if (!res || !res.ok) return null

  const declaredType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()

  const declaredLen = Number(res.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLen) && declaredLen > MAX_ICON_BYTES) return null

  const body = Buffer.from(await res.arrayBuffer())
  if (body.byteLength === 0 || body.byteLength > MAX_ICON_BYTES) return null

  // Trust an allow-listed declared type; otherwise fall back to sniffing the
  // leading bytes (a mint serving a real image under application/octet-stream).
  let contentType: string | null
  if (ALLOWED_CONTENT_TYPES.has(declaredType)) {
    contentType = declaredType
  } else {
    contentType = sniffRasterImageType(body)
  }
  if (!contentType) return null

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
