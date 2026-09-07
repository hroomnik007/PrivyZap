import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Request } from 'express'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools'

// Regression coverage for a real bug found while deploying the notification
// subscribe/unsubscribe endpoints: the live nginx `location /api/` block
// (deploy/nginx.conf) sets Host, X-Real-IP and X-Forwarded-For, but NOT
// X-Forwarded-Proto. `authenticateNip98` reconstructs the URL the client
// must have signed into its NIP-98 event; naively trusting Express's
// `req.protocol` (which falls back to the raw nginx→node connection scheme,
// always plain HTTP here) made every production request fail url-tag
// validation, because the client always signs the public https:// URL.
// Confirmed against the live server, then fixed to default the scheme from
// NODE_ENV instead of an absent header. These tests exercise
// authenticateNip98 directly against a minimal fake Request, independent of
// the full app/supertest/HTTP stack, so they isolate exactly this logic.

function fakeRequest(opts: {
  authorization?: string
  host: string
  originalUrl: string
  method: string
  forwardedProto?: string
}): Request {
  const headers: Record<string, string> = {}
  if (opts.authorization !== undefined) headers['authorization'] = opts.authorization
  if (opts.forwardedProto !== undefined) headers['x-forwarded-proto'] = opts.forwardedProto
  return {
    headers,
    method: opts.method,
    originalUrl: opts.originalUrl,
    get(name: string) {
      return name.toLowerCase() === 'host' ? opts.host : undefined
    },
  } as unknown as Request
}

async function signedToken(url: string, method: string, sk: Uint8Array = generateSecretKey()) {
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.round(Date.now() / 1000),
      tags: [['u', url], ['method', method]],
      content: '',
    },
    sk
  )
  return {
    token: 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64'),
    pubkey: getPublicKey(sk),
  }
}

const ORIGINAL_NODE_ENV = process.env['NODE_ENV']

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = ORIGINAL_NODE_ENV
  vi.resetModules()
})

describe('authenticateNip98 — request URL reconstruction behind nginx', () => {
  it('regression: production + no X-Forwarded-Proto (the live nginx /api/ config) still validates an https-signed token', async () => {
    process.env['NODE_ENV'] = 'production'
    vi.resetModules()
    const { authenticateNip98 } = await import('../nip98Auth.js')

    const { token, pubkey } = await signedToken(
      'https://mintradar.pedani.eu/api/notifications/subscribe',
      'POST'
    )
    const req = fakeRequest({
      authorization: token,
      host: 'mintradar.pedani.eu',
      originalUrl: '/api/notifications/subscribe',
      method: 'POST',
      // no forwardedProto — reproduces the actual live nginx config
    })

    expect(await authenticateNip98(req)).toEqual({ ok: true, pubkey })
  })

  it('dev (NODE_ENV != production) with no X-Forwarded-Proto defaults to http', async () => {
    process.env['NODE_ENV'] = 'development'
    vi.resetModules()
    const { authenticateNip98 } = await import('../nip98Auth.js')

    const { token, pubkey } = await signedToken('http://localhost:3002/api/notifications/subscribe', 'POST')
    const req = fakeRequest({
      authorization: token,
      host: 'localhost:3002',
      originalUrl: '/api/notifications/subscribe',
      method: 'POST',
    })

    expect(await authenticateNip98(req)).toEqual({ ok: true, pubkey })
  })

  it('honors X-Forwarded-Proto when a proxy does set it, even in production', async () => {
    process.env['NODE_ENV'] = 'production'
    vi.resetModules()
    const { authenticateNip98 } = await import('../nip98Auth.js')

    const { token, pubkey } = await signedToken('https://mintradar.pedani.eu/api/notifications/subscribe', 'POST')
    const req = fakeRequest({
      authorization: token,
      host: 'mintradar.pedani.eu',
      originalUrl: '/api/notifications/subscribe',
      method: 'POST',
      forwardedProto: 'https',
    })

    expect(await authenticateNip98(req)).toEqual({ ok: true, pubkey })
  })

  it('rejects a token signed for the wrong scheme (proves the check is real, not a no-op)', async () => {
    process.env['NODE_ENV'] = 'production'
    vi.resetModules()
    const { authenticateNip98 } = await import('../nip98Auth.js')

    // Signed for http while the reconstructed URL (prod, no header) is https.
    const { token } = await signedToken('http://mintradar.pedani.eu/api/notifications/subscribe', 'POST')
    const req = fakeRequest({
      authorization: token,
      host: 'mintradar.pedani.eu',
      originalUrl: '/api/notifications/subscribe',
      method: 'POST',
    })

    const result = await authenticateNip98(req)
    expect(result.ok).toBe(false)
  })
})

describe('authenticateNip98 — replay / nonce cache', () => {
  const URL = 'https://mintradar.pedani.eu/api/notifications/subscribe'

  it('rejects the second use of the same token id within the validity window (body-swap replay)', async () => {
    process.env['NODE_ENV'] = 'production'
    vi.resetModules()
    const { authenticateNip98 } = await import('../nip98Auth.js')

    const { token, pubkey } = await signedToken(URL, 'POST')
    const mkReq = () => fakeRequest({
      authorization: token,
      host: 'mintradar.pedani.eu',
      originalUrl: '/api/notifications/subscribe',
      method: 'POST',
    })

    // First request with this token — accepted.
    expect(await authenticateNip98(mkReq())).toEqual({ ok: true, pubkey })
    // Same signed event replayed (the request body it rides on is irrelevant —
    // authenticateNip98 never sees it) — rejected.
    expect(await authenticateNip98(mkReq())).toEqual({
      ok: false, status: 401, error: 'NIP-98 token already used',
    })
  })

  it('two independently-signed tokens from the same pubkey are both accepted', async () => {
    process.env['NODE_ENV'] = 'production'
    vi.resetModules()
    const { authenticateNip98 } = await import('../nip98Auth.js')

    const sk = generateSecretKey()
    const a = await signedToken(URL, 'POST', sk)
    // finalizeEvent stamps created_at in whole seconds; a second signing in the
    // same second yields a different id anyway (schnorr nonce), but nudge time
    // so the assertion is unambiguous.
    await new Promise(r => setTimeout(r, 1100))
    const b = await signedToken(URL, 'POST', sk)

    expect(a.token).not.toBe(b.token)
    expect((await authenticateNip98(fakeRequest({
      authorization: a.token, host: 'mintradar.pedani.eu',
      originalUrl: '/api/notifications/subscribe', method: 'POST',
    })).then(r => r.ok))).toBe(true)
    expect((await authenticateNip98(fakeRequest({
      authorization: b.token, host: 'mintradar.pedani.eu',
      originalUrl: '/api/notifications/subscribe', method: 'POST',
    })).then(r => r.ok))).toBe(true)
  })

  it('_resetNip98NonceCache clears the cache so a token id can be seen fresh again', async () => {
    process.env['NODE_ENV'] = 'production'
    vi.resetModules()
    const { authenticateNip98, _resetNip98NonceCache } = await import('../nip98Auth.js')

    const { token } = await signedToken(URL, 'POST')
    const mkReq = () => fakeRequest({
      authorization: token, host: 'mintradar.pedani.eu',
      originalUrl: '/api/notifications/subscribe', method: 'POST',
    })

    expect((await authenticateNip98(mkReq())).ok).toBe(true)
    expect((await authenticateNip98(mkReq())).ok).toBe(false)
    _resetNip98NonceCache()
    expect((await authenticateNip98(mkReq())).ok).toBe(true)
  })
})
