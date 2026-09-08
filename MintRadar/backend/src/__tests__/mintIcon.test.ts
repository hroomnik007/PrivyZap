import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
const safeFetch = vi.fn()
vi.mock('../db.js', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }))
vi.mock('../ssrf.js', () => ({ safeFetch: (...a: unknown[]) => safeFetch(...a) }))
vi.mock('../discovery.js', () => ({ normalizeUrl: (u: string) => u.trim() }))

import { getMintIcon, _resetMintIconCache, sniffRasterImageType } from '../mintIcon.js'

const MINT = 'https://mint.example'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4])
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'latin1'),
  Buffer.from([1, 2, 3, 4]),
])
const OVERSIZE = 600 * 1024 // over the 512 KB cap

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
    safeFetch.mockResolvedValue(fakeRes({ contentType: 'image/png', contentLength: String(OVERSIZE), body: PNG }))
    expect(await getMintIcon(MINT)).toBeNull()
  })

  it('rejects an oversized icon body even when Content-Length is absent/lying', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/icon.png' }] })
    safeFetch.mockResolvedValue(fakeRes({ contentType: 'image/png', body: Buffer.alloc(OVERSIZE, 1) }))
    expect(await getMintIcon(MINT)).toBeNull()
  })

  it('accepts an icon between the old 256 KB and new 512 KB limit', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/icon.png' }] })
    const body = Buffer.concat([PNG, Buffer.alloc(400 * 1024, 1)])
    safeFetch.mockResolvedValue(fakeRes({ contentType: 'image/png', body }))
    const icon = await getMintIcon(MINT)
    expect(icon?.contentType).toBe('image/png')
    expect(icon!.body.byteLength).toBe(body.byteLength)
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

  // ── Magic-bytes fallback (2026-09-08) ──────────────────────────────
  // A mint serving a real raster image under a wrong/generic Content-Type
  // (application/octet-stream) — e.g. cashu.cz (.webp) / mint.chorus.community
  // (.jpg) in the diagnostic run — should still be accepted via a signature
  // check, but SVG / corrupt payloads must still be rejected.

  it('accepts a real PNG served as application/octet-stream (magic-bytes fallback)', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/icon.png' }] })
    safeFetch.mockResolvedValue(fakeRes({ contentType: 'application/octet-stream', body: PNG }))
    const icon = await getMintIcon(MINT)
    expect(icon?.contentType).toBe('image/png')
    expect(Buffer.compare(icon!.body, PNG)).toBe(0)
  })

  it('accepts a real WebP served with no Content-Type header at all', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/icon.webp' }] })
    safeFetch.mockResolvedValue(fakeRes({ body: WEBP }))
    const icon = await getMintIcon(MINT)
    expect(icon?.contentType).toBe('image/webp')
  })

  it('still rejects SVG even when served as application/octet-stream', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/icon.svg' }] })
    safeFetch.mockResolvedValue(
      fakeRes({ contentType: 'application/octet-stream', body: Buffer.from('<svg onload="alert(1)"/>') }),
    )
    expect(await getMintIcon(MINT)).toBeNull()
  })

  it('still rejects SVG with a leading XML declaration served as octet-stream', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/icon.svg' }] })
    safeFetch.mockResolvedValue(
      fakeRes({
        contentType: 'application/octet-stream',
        body: Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'),
      }),
    )
    expect(await getMintIcon(MINT)).toBeNull()
  })

  it('rejects a corrupt/undetectable payload served as application/octet-stream', async () => {
    query.mockResolvedValue({ rows: [{ icon_url: 'https://mint.example/icon.png' }] })
    safeFetch.mockResolvedValue(
      fakeRes({ contentType: 'application/octet-stream', body: Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]) }),
    )
    expect(await getMintIcon(MINT)).toBeNull()
  })
})

describe('sniffRasterImageType', () => {
  it('detects PNG', () => {
    expect(sniffRasterImageType(PNG)).toBe('image/png')
  })
  it('detects JPEG', () => {
    expect(sniffRasterImageType(JPEG)).toBe('image/jpeg')
  })
  it('detects GIF (GIF8 prefix)', () => {
    expect(sniffRasterImageType(GIF)).toBe('image/gif')
  })
  it('detects WebP (RIFF....WEBP)', () => {
    expect(sniffRasterImageType(WEBP)).toBe('image/webp')
  })
  it('returns null for an SVG payload', () => {
    expect(sniffRasterImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull()
  })
  it('returns null for an XML-declared SVG payload', () => {
    expect(sniffRasterImageType(Buffer.from('  <?xml version="1.0"?><svg/>'))).toBeNull()
  })
  it('returns null for HTML', () => {
    expect(sniffRasterImageType(Buffer.from('<!doctype html><html></html>'))).toBeNull()
  })
  it('returns null for random bytes', () => {
    expect(sniffRasterImageType(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11]))).toBeNull()
  })
  it('returns null for a too-short buffer', () => {
    expect(sniffRasterImageType(Buffer.from([0x89, 0x50]))).toBeNull()
  })
})
