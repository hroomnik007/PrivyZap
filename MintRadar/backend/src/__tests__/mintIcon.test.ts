import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
const safeFetch = vi.fn()
vi.mock('../db.js', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }))
vi.mock('../ssrf.js', () => ({ safeFetch: (...a: unknown[]) => safeFetch(...a) }))
vi.mock('../discovery.js', () => ({ normalizeUrl: (u: string) => u.trim() }))

import { getMintIcon, _resetMintIconCache } from '../mintIcon.js'

const MINT = 'https://mint.example'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function fakeRes(opts: { ok?: boolean; contentType?: string; contentLength?: string; body?: Buffer }) {
  const headers = new Map<string, string>()
  if (opts.contentType !== undefined) headers.set('content-type', opts.contentType)
  if (opts.contentLength !== undefined) headers.set('content-length', opts.contentLength)
  const body = opts.body ?? Buffer.alloc(0)
  return {
    ok: opts.ok ?? true,
    status: (opts.ok ?? true) ? 200 : 502,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  }
}

beforeEach(() => {
  query.mockReset()
  safeFetch.mockReset()
  _resetMintIconCache()
})

describe('getMintIcon — SSRF-safe favicon proxy (audit finding: icon_url tracking beacon)', () => {
  it('refuses to proxy an unknown mint (never fetches an arbitrary URL)', async () => {
    query.mockResolvedValue({ rows: [] })
    expect(await getMintIcon(MINT)).toBeNull()
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('returns null when the mint has no icon_url', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: null }] })
    expect(await getMintIcon(MINT)).toBeNull()
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('returns null for a non-https icon_url (defence in depth over the prober check)', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'http://mint.example/icon.png' }] })
    expect(await getMintIcon(MINT)).toBeNull()
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('returns null when safeFetch blocks the request (SSRF guard / unreachable)', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://evil.example/track.png' }] })
    safeFetch.mockResolvedValue(null)
    expect(await getMintIcon(MINT)).toBeNull()
    expect(safeFetch).toHaveBeenCalledWith('https://evil.example/track.png', expect.objectContaining({ timeoutMs: 5000 }))
  })

  it('returns null on a non-2xx upstream response', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/icon.png' }] })
    safeFetch.mockResolvedValue(fakeRes({ ok: false }))
    expect(await getMintIcon(MINT)).toBeNull()
  })

  it('rejects a non-image content-type (e.g. an HTML tracker endpoint)', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/icon.png' }] })
    safeFetch.mockResolvedValue(fakeRes({ contentType: 'text/html', body: Buffer.from('<h1>hi</h1>') }))
    expect(await getMintIcon(MINT)).toBeNull()
  })

  it('rejects SVG (would be script-executing XSS on a direct navigation)', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/icon.svg' }] })
    safeFetch.mockResolvedValue(fakeRes({ contentType: 'image/svg+xml', body: Buffer.from('<svg onload="alert(1)"/>') }))
    expect(await getMintIcon(MINT)).toBeNull()
  })

  it('rejects an oversized icon via the Content-Length header', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/icon.png' }] })
    safeFetch.mockResolvedValue(fakeRes({ contentType: 'image/png', contentLength: String(300 * 1024), body: PNG }))
    expect(await getMintIcon(MINT)).toBeNull()
  })

  it('rejects an oversized icon body even when Content-Length is absent/lying', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/icon.png' }] })
    safeFetch.mockResolvedValue(fakeRes({ contentType: 'image/png', body: Buffer.alloc(300 * 1024, 1) }))
    expect(await getMintIcon(MINT)).toBeNull()
  })

  it('returns the bytes + normalised content-type for a valid raster icon', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/icon.png' }] })
    safeFetch.mockResolvedValue(fakeRes({ contentType: 'image/png; charset=binary', body: PNG }))
    const icon = await getMintIcon(MINT)
    expect(icon).not.toBeNull()
    expect(icon!.contentType).toBe('image/png')
    expect(Buffer.compare(icon!.body, PNG)).toBe(0)
  })

  it('accepts .ico favicons', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/favicon.ico' }] })
    safeFetch.mockResolvedValue(fakeRes({ contentType: 'image/vnd.microsoft.icon', body: PNG }))
    const icon = await getMintIcon(MINT)
    expect(icon?.contentType).toBe('image/vnd.microsoft.icon')
  })

  it('caches a resolved icon — a second call hits neither the DB nor the network', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/icon.png' }] })
    safeFetch.mockResolvedValue(fakeRes({ contentType: 'image/png', body: PNG }))
    await getMintIcon(MINT)
    await getMintIcon(MINT)
    expect(query).toHaveBeenCalledTimes(1)
    expect(safeFetch).toHaveBeenCalledTimes(1)
  })

  it('caches a negative result too (no retry storm on a broken/hostile icon_url)', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://evil.example/track.png' }] })
    safeFetch.mockResolvedValue(null)
    await getMintIcon(MINT)
    await getMintIcon(MINT)
    expect(query).toHaveBeenCalledTimes(1)
    expect(safeFetch).toHaveBeenCalledTimes(1)
  })

  it('never throws — a DB error resolves to null', async () => {
    query.mockRejectedValue(new Error('db down'))
    await expect(getMintIcon(MINT)).resolves.toBeNull()
  })
})
