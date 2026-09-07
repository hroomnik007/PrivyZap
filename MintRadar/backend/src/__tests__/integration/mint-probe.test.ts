import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'

// GET /api/mint/probe — unauthenticated, SSRF-guarded on-demand probe. It
// reflects the fetched /v1/info body so Mint Detail can show live data and the
// Dashboard submit form can preview a mint. To stop it doubling as a general
// "fetch and echo the JSON body of arbitrary public host X" oracle (2026-09-07
// audit, L5), the full body is returned only for a mint already in `mints`;
// any other URL gets just online/latency + a stripped info (name/version/nut keys).

vi.mock('../../db.js', () => ({ pool: { query: vi.fn() }, initDb: vi.fn() }))
vi.mock('../../ssrf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ssrf.js')>()
  return { ...actual, safeFetch: vi.fn() }
})

let app: Express
let query: ReturnType<typeof vi.fn>
let safeFetch: ReturnType<typeof vi.fn>

function res(json: unknown, ok = true) {
  return { ok, status: ok ? 200 : 502, json: async () => json }
}

const FULL_INFO = {
  name: 'Example Mint',
  version: 'Nutshell/0.16.0',
  nuts: { '4': { methods: [] }, '5': { methods: [] }, '7': {} },
  contact: [{ method: 'email', info: 'admin@example.com' }],
  motd: 'secret internal message',
  description: 'a description',
  pubkey: 'abc',
  tos_url: 'https://example.com/tos',
}
const KEYSETS = { keysets: [{ id: '009a1f293253e41e', unit: 'sat', active: true }] }

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

function serveMint(info: unknown, keysets: unknown = KEYSETS) {
  safeFetch.mockImplementation(async (u: string) => {
    if (u.endsWith('/v1/info')) return info === null ? res({}, false) : res(info)
    if (u.endsWith('/v1/keysets')) return res(keysets)
    return null
  })
}

describe('GET /api/mint/probe', () => {
  it('400s a non-https / missing url (unchanged)', async () => {
    await request(app).get('/api/mint/probe').expect(400)
    await request(app).get('/api/mint/probe?url=http://mint.example').expect(400)
  })

  it('returns the FULL live /v1/info for a KNOWN mint', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ '?column?': 1 }] }) // mint lookup hit
    serveMint(FULL_INFO)

    const r = await request(app).get('/api/mint/probe?url=https://mint.example').expect(200)

    expect(r.body.online).toBe(true)
    expect(r.body.info.name).toBe('Example Mint')
    expect(r.body.info.contact).toEqual([{ method: 'email', info: 'admin@example.com' }])
    expect(r.body.info.motd).toBe('secret internal message')
    expect(r.body.info.description).toBe('a description')
    expect(r.body.keysets).toEqual(KEYSETS.keysets)
  })

  it('returns only online/latency + a STRIPPED info for an UNKNOWN url (not a general fetch oracle)', async () => {
    query.mockResolvedValue({ rowCount: 0, rows: [] }) // not a known mint
    serveMint(FULL_INFO)

    const r = await request(app).get('/api/mint/probe?url=https://attacker-chosen-host.example').expect(200)

    expect(r.body.online).toBe(true)
    expect(typeof r.body.latencyMs === 'number' || r.body.latencyMs === null).toBe(true)
    // info is reduced to exactly what the submit preview renders.
    expect(Object.keys(r.body.info).sort()).toEqual(['name', 'nuts', 'version'])
    expect(r.body.info.name).toBe('Example Mint')
    expect(r.body.info.version).toBe('Nutshell/0.16.0')
    expect(Object.keys(r.body.info.nuts).sort()).toEqual(['4', '5', '7']) // count preserved
    expect(r.body.info.nuts['4']).toEqual({}) // per-NUT config NOT reflected
    // Nothing the audit flagged as leak-worthy:
    expect(r.body.info.contact).toBeUndefined()
    expect(r.body.info.motd).toBeUndefined()
    expect(r.body.info.description).toBeUndefined()
    expect(r.body.info.pubkey).toBeUndefined()
    expect(r.body.keysets).toBeNull()
  })

  it('reflects nothing but online:false for an unknown host that is not a Cashu mint', async () => {
    query.mockResolvedValue({ rowCount: 0, rows: [] })
    serveMint({ notAMint: true }) // 200, but no `nuts` key → probeMint leaves info null

    const r = await request(app).get('/api/mint/probe?url=https://some-random-site.example').expect(200)

    expect(r.body.online).toBe(false)
    expect(r.body.info).toBeNull()
    expect(r.body.keysets).toBeNull()
  })
})
