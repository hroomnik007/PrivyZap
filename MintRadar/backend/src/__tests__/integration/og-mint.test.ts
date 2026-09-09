import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'

// GET /api/og/mint — bot-only OG HTML fragment for /mint/:url (see
// deploy/nginx.conf's user-agent map). Same mocking approach as
// mints-known.test.ts: mock the pg-backed pool at the db.js boundary so the
// real route handler + fetchOgMintData() query run end-to-end without a
// database, exercising exactly what nginx would send a crawler.

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

function sampleRow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Example Mint',
    last_trust_score: 87,
    total: 12,
    online_count: 12,
    latest_online: true,
    latest_checked_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('GET /api/og/mint', () => {
  it('returns a 200 HTML fragment with the mint name, trust score and status for a known mint', async () => {
    query.mockResolvedValueOnce({ rows: [sampleRow()] })

    const res = await request(app).get('/api/og/mint').query({ url: 'https://mint.example.com' })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.text).toContain('<title>Example Mint — MintRadar</title>')
    expect(res.text).toContain('Trust Score: 87% · Online')
    expect(res.text).toContain('og:url" content="https://mintradar.org/mint/https%3A%2F%2Fmint.example.com"')
  })

  it('sets a Cache-Control max-age header', async () => {
    query.mockResolvedValueOnce({ rows: [sampleRow()] })
    const res = await request(app).get('/api/og/mint').query({ url: 'https://mint.example.com' })
    expect(res.headers['cache-control']).toMatch(/max-age=\d+/)
  })

  it('returns a valid 200 fallback fragment (never 404) when the mint is not in the DB', async () => {
    query.mockResolvedValueOnce({ rows: [] })

    const res = await request(app).get('/api/og/mint').query({ url: 'https://unknown-mint.example.com' })

    expect(res.status).toBe(200)
    expect(res.text).toContain('<title>MintRadar - Cashu Mint Monitor</title>')
    expect(res.text).toContain('<!doctype html>')
  })

  it('returns a valid 200 fallback fragment (never 500) when the DB query throws', async () => {
    query.mockRejectedValueOnce(new Error('connection refused'))

    const res = await request(app).get('/api/og/mint').query({ url: 'https://mint.example.com' })

    expect(res.status).toBe(200)
    expect(res.text).toContain('<title>MintRadar - Cashu Mint Monitor</title>')
  })

  it('returns a valid 200 fallback fragment when the url query param is missing', async () => {
    const res = await request(app).get('/api/og/mint')

    expect(res.status).toBe(200)
    expect(res.text).toContain('<title>MintRadar - Cashu Mint Monitor</title>')
    expect(query).not.toHaveBeenCalled()
  })

  it('escapes a mint name containing HTML instead of injecting it raw', async () => {
    query.mockResolvedValueOnce({ rows: [sampleRow({ name: '<script>alert(1)</script>' })] })

    const res = await request(app).get('/api/og/mint').query({ url: 'https://mint.example.com' })

    expect(res.text).not.toContain('<script>alert(1)</script>')
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})
