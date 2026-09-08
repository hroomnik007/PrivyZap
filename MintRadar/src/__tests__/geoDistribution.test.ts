import { describe, it, expect } from 'vitest'
import { computeGeoDistribution, normalizeGeoLoc, CDN_BUCKET, type GeoDistMintInput } from '../utils/geoDistribution'

function onlineMints(locations: (string | null)[]): GeoDistMintInput[] {
  return locations.map(loc => ({ online: true, serverLocation: loc }))
}

describe('computeGeoDistribution', () => {
  it('shows no "+N more" row when there are fewer than 8 locations', () => {
    const result = computeGeoDistribution(onlineMints(['A', 'A', 'B', 'C']))
    expect(result.top).toHaveLength(3)
    expect(result.moreCount).toBe(0)
    expect(result.moreLocations).toBe(0)
    expect(result.unknownCount).toBe(0)
  })

  it('shows no "+N more" row when there are exactly 8 locations', () => {
    const locs = Array.from({ length: 8 }, (_, i) => `Loc${i}`)
    const result = computeGeoDistribution(onlineMints(locs))
    expect(result.top).toHaveLength(8)
    expect(result.moreCount).toBe(0)
    expect(result.moreLocations).toBe(0)
  })

  it('splits out a "+N more" row for locations beyond the top 8 (no Unknown bucket)', () => {
    // 10 distinct locations, top 8 by count get 2 mints each, the remaining 2 get 1 each.
    const locs: (string | null)[] = []
    for (let i = 0; i < 8; i++) locs.push(`Loc${i}`, `Loc${i}`)
    locs.push('Loc8', 'Loc9')
    const result = computeGeoDistribution(onlineMints(locs))

    expect(result.top).toHaveLength(8)
    expect(result.moreCount).toBe(2)
    expect(result.moreLocations).toBe(2)
    expect(result.unknownCount).toBe(0)
    expect(result.unknownShownInTop).toBe(false)
    // `more` is what the "+N more" modal renders — must list the actual overflow
    // locations (never just the aggregate counts), excluding the Unknown bucket.
    expect(result.more).toEqual([
      { loc: 'Loc8', count: 1, pct: expect.any(Number) },
      { loc: 'Loc9', count: 1, pct: expect.any(Number) },
    ])
  })

  it('reports mints with no serverLocation as a distinct "Unknown" bucket when it falls outside the top 8', () => {
    const locs: (string | null)[] = []
    // 8 locations with 3 mints each — outranks both Loc8 and the Unknown bucket below,
    // so they fill the top 8 and push everything else out.
    for (let i = 0; i < 8; i++) locs.push(`Loc${i}`, `Loc${i}`, `Loc${i}`)
    locs.push('Loc8', 'Loc8') // a 9th location, smaller than the top 8 — goes to "+N more"
    locs.push(null) // 1 mint with a failed/missing geolocation — tracked separately

    const result = computeGeoDistribution(onlineMints(locs))

    expect(result.top).toHaveLength(8)
    expect(result.unknownShownInTop).toBe(false)
    expect(result.unknownCount).toBe(1)
    expect(result.moreCount).toBe(2)
    expect(result.moreLocations).toBe(1)
  })

  it('flags the Unknown bucket as already visible when it is large enough to land in the top 8', () => {
    const locs: (string | null)[] = ['A', 'A', 'A', 'B', 'B', null, null, null, null]
    const result = computeGeoDistribution(onlineMints(locs))

    expect(result.top.some(e => e.loc === 'Unknown')).toBe(true)
    expect(result.unknownShownInTop).toBe(true)
    // Already visible in `top`, so it must not also be reported as a separate "Unknown" count.
    expect(result.unknownCount).toBe(0)
  })

  it('offline mints are excluded from every bucket', () => {
    const mints: GeoDistMintInput[] = [
      { online: true, serverLocation: 'A' },
      { online: false, serverLocation: 'A' },
      { online: null, serverLocation: 'A' },
    ]
    const result = computeGeoDistribution(mints)
    expect(result.total).toBe(1)
    expect(result.top).toEqual([{ loc: 'A', count: 1, pct: 100 }])
  })

  // Sanity check for the bug this fixes: the sum of everything the panel renders
  // (top-8 bars + "+N more" + the separate "Geolocation unavailable" count) must
  // always reconcile exactly with the total number of online mints the distribution
  // was built from — nothing may silently disappear behind the top-8 cutoff.
  it('top + moreCount + unknownCount always reconciles with the online mint total', () => {
    const scenarios: (string | null)[][] = [
      ['A', 'B', 'C'],
      Array.from({ length: 8 }, (_, i) => `Loc${i}`),
      [...Array.from({ length: 8 }, (_, i) => `Loc${i}`), 'Extra1', 'Extra2'],
      [...Array.from({ length: 8 }, (_, i) => `Loc${i}${i}`), null, null, null],
      ['A', 'A', 'A', 'B', 'B', null, null, null, null],
    ]

    for (const locs of scenarios) {
      const result = computeGeoDistribution(onlineMints(locs))
      const topSum = result.top.reduce((sum, e) => sum + e.count, 0)
      const reconciled = topSum + result.moreCount + (result.unknownShownInTop ? 0 : result.unknownCount)
      expect(reconciled).toBe(result.total)
      expect(result.total).toBe(locs.length)
    }
  })
})

describe('normalizeGeoLoc — CDN / anycast bucketing', () => {
  it('collapses provider / CDN / anycast labels into one bucket', () => {
    for (const loc of ['Cloudflare CDN', 'AWS us-east-1', 'Amazon, US', 'anycast', 'Fastly edge', 'Akamai', 'Google Cloud, US', 'Azure East US', 'CloudFront']) {
      expect(normalizeGeoLoc(loc)).toBe(CDN_BUCKET)
    }
  })

  it('leaves a real city untouched', () => {
    expect(normalizeGeoLoc('Frankfurt, DE')).toBe('Frankfurt, DE')
    expect(normalizeGeoLoc('Helsinki, FI')).toBe('Helsinki, FI')
  })

  it('maps null / undefined / "Unknown" to "Unknown"', () => {
    expect(normalizeGeoLoc(null)).toBe('Unknown')
    expect(normalizeGeoLoc(undefined)).toBe('Unknown')
    expect(normalizeGeoLoc('Unknown')).toBe('Unknown')
  })

  it('computeGeoDistribution merges several CDN labels into a single row', () => {
    const result = computeGeoDistribution(
      onlineMints(['Cloudflare CDN', 'AWS eu-west-1', 'anycast', 'Frankfurt, DE', 'Frankfurt, DE']),
    )
    const cdnRow = result.top.find(r => r.loc === CDN_BUCKET)
    expect(cdnRow?.count).toBe(3)
    expect(result.top.filter(r => r.loc === CDN_BUCKET)).toHaveLength(1)
  })
})
