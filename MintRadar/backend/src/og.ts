import { pool } from './db.js'
import { computeDegraded } from './degraded.js'

// Minimal HTML fragment served ONLY to social-media crawlers (see nginx
// user-agent map, deploy/nginx.conf) that hit /mint/:url — they don't run JS,
// so they never see the SPA's client-rendered OG tags. Regular browsers never
// reach this route; they get the normal SPA `index.html` via try_files.

export interface OgMintData {
  name: string | null
  trustScore: number | null
  online: boolean | null
  degraded: boolean
}

// Escapes text for safe interpolation into both HTML body text and
// double-quoted HTML attribute values. Mint `name` originates from the
// mint's own untrusted /v1/info response, so this is a real trust boundary,
// not defensive-for-its-own-sake.
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function mintStatusLabel(mint: Pick<OgMintData, 'online' | 'degraded'>): string {
  if (mint.degraded) return 'Degraded'
  if (mint.online === true) return 'Online'
  return 'Offline'
}

const SITE_URL = 'https://mintradar.org'
const OG_IMAGE_URL = `${SITE_URL}/og-image.png`

// Renders the standalone OG HTML fragment for one mint. `mint` is null when
// the URL isn't a known mint — crawlers still get a valid, generic MintRadar
// page rather than a 404/500 with no preview at all.
export function renderMintOgHtml(mint: OgMintData | null, mintUrl: string): string {
  const pageUrl = mintUrl.length > 0 ? `${SITE_URL}/mint/${encodeURIComponent(mintUrl)}` : SITE_URL

  if (mint === null) {
    const title = 'MintRadar - Cashu Mint Monitor'
    const description = 'Real-time Trust Score, latency & NUT monitoring for Cashu mints. Open source & privacy first.'
    return renderHtml(title, description, pageUrl)
  }

  const displayName = mint.name && mint.name.trim().length > 0 ? mint.name.trim() : mintUrl
  const title = `${displayName} — MintRadar`
  const trustScoreText = mint.trustScore !== null ? `${mint.trustScore}%` : 'N/A'
  const description = `Trust Score: ${trustScoreText} · ${mintStatusLabel(mint)}`

  return renderHtml(title, description, pageUrl)
}

function renderHtml(title: string, description: string, pageUrl: string): string {
  const safeTitle = escapeHtml(title)
  const safeDescription = escapeHtml(description)
  const safePageUrl = escapeHtml(pageUrl)

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${safeTitle}</title>
    <meta name="description" content="${safeDescription}" />
    <meta property="og:title" content="${safeTitle}" />
    <meta property="og:description" content="${safeDescription}" />
    <meta property="og:url" content="${safePageUrl}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="MintRadar" />
    <meta property="og:image" content="${OG_IMAGE_URL}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${safeTitle}" />
    <meta name="twitter:description" content="${safeDescription}" />
    <meta name="twitter:image" content="${OG_IMAGE_URL}" />
  </head>
  <body></body>
</html>
`
}

// Scoped, single-mint version of the /api/mints/known aggregate query —
// reuses the same shape (24h window join + LATERAL latest probe) so
// computeDegraded() behaves identically, without pulling in the full
// known-mints payload (icon/NUTs/audit/etc.) that this fragment doesn't need.
export async function fetchOgMintData(url: string): Promise<OgMintData | null> {
  const result = await pool.query(
    `SELECT m.name, m.last_trust_score,
        COUNT(h.online) AS total,
        COALESCE(SUM(CASE WHEN h.online THEN 1 ELSE 0 END), 0) AS online_count,
        latest.online AS latest_online,
        latest.checked_at AS latest_checked_at
      FROM mints m
      LEFT JOIN mint_history h ON h.url = m.url AND h.checked_at > NOW() - INTERVAL '24 hours'
      LEFT JOIN LATERAL (
        SELECT online, checked_at FROM mint_history
        WHERE url = m.url ORDER BY checked_at DESC, id DESC LIMIT 1
      ) latest ON true
      WHERE m.url = $1
      GROUP BY m.name, m.last_trust_score, latest.online, latest.checked_at`,
    [url]
  )

  if (result.rows.length === 0) return null

  const row = result.rows[0] as Record<string, unknown>
  const total = Number(row['total'])
  const onlineCount = Number(row['online_count'])
  const latestOnline = row['latest_online'] as boolean | null
  const latestCheckedAt = row['latest_checked_at'] as string | null

  return {
    name: row['name'] as string | null,
    trustScore: (row['last_trust_score'] as number | null) ?? null,
    online: latestOnline,
    degraded: computeDegraded(total, onlineCount, latestOnline, latestCheckedAt),
  }
}
