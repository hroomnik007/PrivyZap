import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'

// GET /api/mint/icon — SSRF-safe favicon proxy (see backend/src/mintIcon.ts).
// The frontend routes every mint <img> here instead of fetching a mint-supplied
// icon_url directly, closing the IP/User-Agent tracking-beacon leak from the
// 2026-09-07 audit. We mock the db.js pool and ssrf.js safeFetch at their
// boundaries so the real route + mintIcon.getMintIcon run end-to-end with no DB
// and no outbound network.

vi.mock('../../db.js', () => ({ pool: { query: vi.fn() }, initDb: vi.fn() }))
vi.mock('../../ssrf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ssrf.js')>()
  return { ...actual, safeFetch: vi.fn() }
})

let app: Express
let query: ReturnType<typeof vi.fn>
let safeFetch: ReturnType<typeof vi.fn>

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function fakeRes(opts: { ok?: boolean; contentType?: string; body?: Buffer }) {
  const headers = new Map<string, string>()
  if (opts.contentType) headers.set('content-type', opts.contentType)
  const body = opts.body ?? Buffer.alloc(0)
  return {
    ok: opts.ok ?? true,
    status: (opts.ok ?? true) ? 200 : 502,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  }
}

beforeEach(async () => {
  vi.resetModules()
  const db = await import('../../db.js')
  const ssrf = await import('../../ssrf.js')
  query = db.pool.query as unknown as ReturnType<typeof vi.fn>
  safeFetch = ssrf.safeFetch as unknown as ReturnType<typeof vi.fn>
  query.mockReset()
  safeFetch.mockReset()
  ;({ app } = await import('../../index.js'))
})

describe('GET /api/mint/icon', () => {
  it('400s a missing / malformed url param', async () => {
    await request(app).get('/api/mint/icon').expect(400)
    await request(app).get('/api/mint/icon?url=').expect(400)
    await request(app).get(`/api/mint/icon?url=${'x'.repeat(600)}`).expect(400)
  })

  it('proxies a valid raster favicon from our own origin with a long cache + hardening headers', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/icon.png' }] })
    safeFetch.mockResolvedValue(fakeRes({ contentType: 'image/png', body: PNG }))

    const res = await request(app).get('/api/mint/icon?url=https://mint.example').expect(200)

    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['cache-control']).toContain('max-age=86400')
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0)
    // safeFetch (SSRF guard) is what actually reached out — never the browser.
    expect(safeFetch).toHaveBeenCalledWith('https://mint.example/icon.png', expect.objectContaining({ timeoutMs: 5000 }))
  })

  it('404s an unknown mint without any outbound fetch', async () => {
    query.mockResolvedValue({ rows: [] })
    await request(app).get('/api/mint/icon?url=https://unknown.example').expect(404)
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('404s when the mint\'s icon_url points somewhere unsafe / non-image', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://tracker.evil.example/px.png' }] })
    safeFetch.mockResolvedValue(fakeRes({ contentType: 'text/html', body: Buffer.from('<img>') }))
    const res = await request(app).get('/api/mint/icon?url=https://mint.example').expect(404)
    expect(res.headers['cache-control']).toContain('max-age=1800')
  })

  it('is exempt from the per-IP rate limit (favicons burst on a dashboard load)', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/icon.png' }] })
    safeFetch.mockResolvedValue(fakeRes({ contentType: 'image/png', body: PNG }))
    // Far more than RATE_LIMIT_MAX (60) — all succeed, none 429.
    for (let i = 0; i < 70; i++) {
      await request(app).get(`/api/mint/icon?url=https://mint.example?i=${i}`).expect(res => {
        expect(res.status).not.toBe(429)
      })
    }
  })
})
