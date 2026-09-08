export interface GeoDistEntry {
  loc: string
  count: number
  pct: number
}

export interface GeoDistribution {
  top: GeoDistEntry[]
  more: GeoDistEntry[]
  moreCount: number
  moreLocations: number
  unknownCount: number
  unknownShownInTop: boolean
  total: number
}

export interface GeoDistMintInput {
  online: boolean | null
  serverLocation?: string | null
}

// A GeoIP hit that resolves to a CDN / cloud provider / anycast edge tells us
// nothing about where the mint actually runs — and several such labels
// ("Cloudflare CDN", an AWS region, "anycast", …) would otherwise each get
// their own tiny row. Collapse them into one "CDN / anycast" bucket at
// display/aggregation time. (The GeoIP lookup itself is unchanged.)
export const CDN_BUCKET = 'CDN / anycast'
const CDN_RE = /cloudflare|\bcdn\b|\baws\b|amazon|\banycast\b|akamai|fastly|\bgcp\b|google cloud|azure|edgecast|bunny|stackpath|cloudfront/i

export function normalizeGeoLoc(loc: string | null | undefined): string {
  const l = loc ?? 'Unknown'
  return CDN_RE.test(l) ? CDN_BUCKET : l
}

// Buckets online mints by serverLocation, sorted by count descending, and
// splits the result into the top N (for the panel's bars) plus everything
// that didn't make the cut. The "Unknown" bucket (mints with no
// serverLocation — a failed/pending geo-IP lookup, not a mint property) is
// tracked separately from other small locations so a caller can label it
// distinctly ("Geolocation unavailable") instead of folding it into a
// generic "+N more" count.
export function computeGeoDistribution(mints: GeoDistMintInput[], topN = 8): GeoDistribution {
  const counts = new Map<string, number>()
  for (const m of mints) {
    if (m.online !== true) continue
    const loc = normalizeGeoLoc(m.serverLocation)
    counts.set(loc, (counts.get(loc) ?? 0) + 1)
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const topEntries = sorted.slice(0, topN)
  const restEntries = sorted.slice(topN)

  const top = topEntries.map(([loc, count]) => ({ loc, count, pct: total > 0 ? Math.round(count / total * 100) : 0 }))
  const unknownShownInTop = topEntries.some(([loc]) => loc === 'Unknown')
  const unknownRestEntry = restEntries.find(([loc]) => loc === 'Unknown')
  const unknownCount = unknownRestEntry ? unknownRestEntry[1] : 0
  const otherRestEntries = restEntries.filter(([loc]) => loc !== 'Unknown')
  const more = otherRestEntries.map(([loc, count]) => ({ loc, count, pct: total > 0 ? Math.round(count / total * 100) : 0 }))
  const moreCount = otherRestEntries.reduce((sum, [, count]) => sum + count, 0)
  const moreLocations = otherRestEntries.length

  return { top, more, moreCount, moreLocations, unknownCount, unknownShownInTop, total }
}
