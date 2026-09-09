import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'

// CORS is configured in index.ts with an origin allow-list (ALLOWED_ORIGINS).
// The test env sets ALLOWED_ORIGINS to:
//   https://mintradar.org, http://localhost:5173
// (see vitest.config.ts). The middleware reflects an allowed Origin back in
// Access-Control-Allow-Origin and rejects everything else. Same-origin / no-Origin
// requests (curl, server-to-server) are always permitted.

vi.mock('../../db.js', () => ({
  pool: { query: vi.fn() },
  initDb: vi.fn(),
}))

const ALLOWED = 'https://mintradar.org'
const ALLOWED_DEV = 'http://localhost:5173'
const DISALLOWED = 'https://evil.attacker.example'

let app: Express
let query: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.resetModules()
  const db = await import('../../db.js')
  query = db.pool.query as unknown as ReturnType<typeof vi.fn>
  query.mockReset()
  ;({ app } = await import('../../index.js'))
})

describe('CORS allow-list', () => {
  it('reflects an allowed production origin in Access-Control-Allow-Origin', async () => {
    query.mockResolvedValueOnce({ rows: [] })

    const res = await request(app).get('/api/mints/known').set('Origin', ALLOWED)

    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED)
  })

  it('allows the configured dev origin', async () => {
    query.mockResolvedValueOnce({ rows: [] })

    const res = await request(app).get('/api/mints/known').set('Origin', ALLOWED_DEV)

    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_DEV)
  })

  it('does NOT grant Access-Control-Allow-Origin to a disallowed origin', async () => {
    const res = await request(app).get('/api/mints/known').set('Origin', DISALLOWED)

    // The browser-enforced security guarantee: no ACAO header echoing the
    // attacker origin (and certainly not a wildcard), so the response is not
    // readable cross-origin.
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(res.headers['access-control-allow-origin']).not.toBe(DISALLOWED)
    expect(res.headers['access-control-allow-origin']).not.toBe('*')
  })

  it('rejects a CORS preflight (OPTIONS) from a disallowed origin', async () => {
    const res = await request(app)
      .options('/api/mint/submit')
      .set('Origin', DISALLOWED)
      .set('Access-Control-Request-Method', 'POST')

    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('answers a preflight from an allowed origin with the permitted methods', async () => {
    const res = await request(app)
      .options('/api/mint/submit')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')

    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED)
    // Only GET and POST are configured as allowed methods.
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/)
    expect(res.headers['access-control-allow-methods']).not.toMatch(/DELETE|PUT|PATCH/)
  })

  it('permits requests with no Origin header (same-origin / curl / server-to-server)', async () => {
    query.mockResolvedValueOnce({ rows: [] })

    const res = await request(app).get('/api/mints/known')

    expect(res.status).toBe(200)
  })
})
