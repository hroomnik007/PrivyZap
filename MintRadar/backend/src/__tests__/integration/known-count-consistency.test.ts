import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'

// Invariant: the number the Dashboard shows as "All Known" / the grid footer's
// "of N" (from GET /api/mints/known) MUST equal Stats' "Mints Tracked" /
// "Online Now" denominator (GET /api/stats `totalMints`). Both endpoints read
// the same unfiltered `SELECT ... FROM mints` — this test locks that so a
// future `WHERE is_known` / `.filter()` added to one and not the other can't
// silently reintroduce the "94 vs 102" mismatch.

vi.mock('../../db.js', () => ({
  pool: { query: vi.fn() },
  initDb: vi.fn(),
}))

let app: Express
let query: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.resetModules()
  const db = await import('../../db.js')
  query = db.pool.query as unknown as ReturnType<typeof vi.fn>
  query.mockReset()
  ;({ app } = await import('../../index.js'))
})

// A heterogeneous set: online, offline, never-probed, null-name — nothing here
// may be dropped by either endpoint's counting.
const MINT_URLS = [
  { url: 'https://a.example', online: true, name: 'A' },
  { url: 'https://b.example', online: true, name: 'B' },
  { url: 'https://c.example', online: false, name: 'C' },
  { url: 'https://d.example', online: null, name: null },
  { url: 'https://e.example', online: false, name: null },
  { url: 'https://f.example', online: true, name: 'F' },
  { url: 'https://g.example', online: null, name: 'G' },
]

function knownRow(m: { url: string; online: boolean | null; name: string | null }) {
  return {
    url: m.url, name: m.name, icon_url: null, version: null, nut_count: null,
    tos_url: null, description_long: null, nuts_limits: null,
    units: null, mint_methods: null, melt_methods: null,
    audit_n_mints: null, audit_n_melts: null, audit_n_errors: null, audit_checked_at: null,
    audit_synced_at: null, audit_recent_total: null, audit_recent_errors: null,
    discovered_at: '2026-01-01T00:00:00.000Z', last_trust_score: m.online ? 70 : null, last_error: null,
    server_location: null, review_count: null, review_avg_rating: null,
    review_count_7d_ago: null, review_count_7d_ago_at: null,
    total: 0, online_count: 0,
    latest_online: m.online, latest_latency_ms: null, latest_checked_at: null,
  }
}

function statsRow(m: { url: string; online: boolean | null }) {
  return { url: m.url, name: null, last_trust_score: m.online ? 70 : null, nuts_limits: null, online: m.online, latency_ms: null }
}

describe('Dashboard known total === Stats mints-tracked', () => {
  it('GET /api/mints/known length equals GET /api/stats totalMints for the same mint set', async () => {
    query.mockResolvedValueOnce({ rows: MINT_URLS.map(knownRow) })
    const known = await request(app).get('/api/mints/known')
    expect(known.status).toBe(200)

    query.mockReset()
    query
      .mockResolvedValueOnce({ rows: MINT_URLS.map(statsRow) }) // mints + latest status
      .mockResolvedValueOnce({ rows: [{ avg_latency: 100 }] })  // median latency
    const stats = await request(app).get('/api/stats')
    expect(stats.status).toBe(200)

    expect(known.body).toHaveLength(MINT_URLS.length)
    expect(stats.body.totalMints).toBe(MINT_URLS.length)
    expect(stats.body.totalMints).toBe(known.body.length)
  })

  it('neither endpoint drops offline / never-probed / null-name mints from the total', async () => {
    query.mockResolvedValueOnce({ rows: MINT_URLS.map(knownRow) })
    const known = await request(app).get('/api/mints/known')

    query.mockReset()
    query
      .mockResolvedValueOnce({ rows: MINT_URLS.map(statsRow) })
      .mockResolvedValueOnce({ rows: [{ avg_latency: null }] })
    const stats = await request(app).get('/api/stats')

    // 3 online, 2 offline, 2 never-probed → 7 total on both surfaces.
    expect(known.body.length).toBe(7)
    expect(stats.body.totalMints).toBe(7)
    expect(stats.body.onlineMints).toBe(3)
    expect(stats.body.offlineMints).toBe(2)
  })
})
