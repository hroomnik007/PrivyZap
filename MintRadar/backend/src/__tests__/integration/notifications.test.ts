import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools'

// POST /api/notifications/{subscribe,unsubscribe} require real NIP-98 auth
// (signature, kind, timestamp window, url/method tags — all verified by
// nostr-tools itself, not hand-rolled) plus a per-pubkey rate limit and (for
// subscribe) an SSRF-safe ws(s) relay list. We mock only the external
// boundaries:
//   - db.js pool          → no database
//   - dns/promises lookup → deterministic SSRF-guard resolution for relays
// NIP-98 verification and the SSRF guard run for real.

vi.mock('../../db.js', () => ({
  pool: { query: vi.fn() },
  initDb: vi.fn(),
}))
vi.mock('dns/promises', () => ({ lookup: vi.fn() }))

const TEST_ORIGIN = 'https://mintradar.test'
const SUBSCRIBE_PATH = '/api/notifications/subscribe'
const UNSUBSCRIBE_PATH = '/api/notifications/unsubscribe'

let app: Express
let query: ReturnType<typeof vi.fn>
let lookup: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.resetModules()
  const db = await import('../../db.js')
  query = db.pool.query as unknown as ReturnType<typeof vi.fn>
  query.mockReset()
  const dns = await import('dns/promises')
  lookup = dns.lookup as unknown as ReturnType<typeof vi.fn>
  lookup.mockReset()
  ;({ app } = await import('../../index.js'))
})

function resolvesTo(...addrs: { address: string; family: number }[]): void {
  lookup.mockResolvedValue(addrs as never)
}

// Builds a real, validly-signed NIP-98 (kind 27235) auth header for `path`.
async function nip98Header(
  path: string,
  method: string,
  opts: {
    sk?: Uint8Array
    createdAt?: number
    urlOverride?: string
    methodOverride?: string
    tamperSig?: boolean
  } = {}
): Promise<{ header: string; pubkey: string; sk: Uint8Array }> {
  const sk = opts.sk ?? generateSecretKey()
  const pubkey = getPublicKey(sk)
  const url = opts.urlOverride ?? `${TEST_ORIGIN}${path}`
  const tags: string[][] = [
    ['u', url],
    ['method', opts.methodOverride ?? method],
  ]
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: opts.createdAt ?? Math.round(Date.now() / 1000),
      tags,
      content: '',
    },
    sk
  )
  if (opts.tamperSig) {
    event.sig = event.sig.slice(0, -2) + (event.sig.endsWith('00') ? '11' : '00')
  }
  const header = 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64')
  return { header, pubkey, sk }
}

function post(path: string, body: unknown, authHeader?: string) {
  const req = request(app)
    .post(path)
    .set('Host', 'mintradar.test')
    .set('X-Forwarded-Proto', 'https')
  if (authHeader) req.set('Authorization', authHeader)
  return req.send(body)
}

describe('NIP-98 authentication', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await post(SUBSCRIBE_PATH, { mintUrl: 'https://mint.example.com' })
    expect(res.status).toBe(401)
  })

  it('rejects a request with an empty Authorization header', async () => {
    const res = await post(SUBSCRIBE_PATH, {}, '')
    expect(res.status).toBe(401)
  })

  it('rejects a token with an invalid signature', async () => {
    const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST', { tamperSig: true })
    const res = await post(SUBSCRIBE_PATH, { mintUrl: 'https://mint.example.com' }, header)
    expect(res.status).toBe(401)
  })

  it('rejects a token whose signed url does not match the request url', async () => {
    const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST', {
      urlOverride: 'https://mintradar.test/api/notifications/unsubscribe',
    })
    const res = await post(SUBSCRIBE_PATH, { mintUrl: 'https://mint.example.com' }, header)
    expect(res.status).toBe(401)
  })

  it('rejects a token whose signed method does not match the request method', async () => {
    const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST', { methodOverride: 'GET' })
    const res = await post(SUBSCRIBE_PATH, { mintUrl: 'https://mint.example.com' }, header)
    expect(res.status).toBe(401)
  })

  it('rejects an expired token (created_at more than 60s in the past)', async () => {
    const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST', {
      createdAt: Math.round(Date.now() / 1000) - 120,
    })
    const res = await post(SUBSCRIBE_PATH, { mintUrl: 'https://mint.example.com' }, header)
    expect(res.status).toBe(401)
  })

  it('rejects a wrong-kind event (not 27235)', async () => {
    const sk = generateSecretKey()
    const event = finalizeEvent(
      {
        kind: 1,
        created_at: Math.round(Date.now() / 1000),
        tags: [['u', `${TEST_ORIGIN}${SUBSCRIBE_PATH}`], ['method', 'POST']],
        content: '',
      },
      sk
    )
    const header = 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64')
    const res = await post(SUBSCRIBE_PATH, { mintUrl: 'https://mint.example.com' }, header)
    expect(res.status).toBe(401)
  })

  it('accepts a validly-signed, matching token (proceeds past auth to body validation)', async () => {
    const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST')
    // No mintUrl in body → should get past auth and fail on validation, not auth.
    const res = await post(SUBSCRIBE_PATH, {}, header)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/mintUrl/)
  })
})

describe('POST /api/notifications/subscribe', () => {
  it('rejects an unknown mint', async () => {
    const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST')
    resolvesTo({ address: '1.2.3.4', family: 4 })
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] }) // mint lookup miss

    const res = await post(
      SUBSCRIBE_PATH,
      {
        mintUrl: 'https://unknown-mint.example.com',
        notifyOnDown: true,
        notifyOnUp: true,
        relays: ['wss://relay.example.com'],
      },
      header
    )

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Unknown mint' })
  })

  it('accepts a valid subscription and upserts it, keyed on the authenticated pubkey', async () => {
    const { header, pubkey } = await nip98Header(SUBSCRIBE_PATH, 'POST')
    resolvesTo({ address: '1.2.3.4', family: 4 })
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // mint lookup hit
    query.mockResolvedValueOnce({ rows: [{ total: 0, this_mint: 0, other_relays: [] }] }) // per-pubkey caps
    query.mockResolvedValueOnce({ rowCount: 1 }) // upsert

    const res = await post(
      SUBSCRIBE_PATH,
      {
        mintUrl: 'https://mint.example.com',
        notifyOnDown: true,
        notifyOnUp: false,
        relays: ['wss://relay.example.com', 'ws://relay2.example.com'],
      },
      header
    )

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
    const [sql, params] = query.mock.calls[2]
    expect(sql).toContain('INSERT INTO notification_subscriptions')
    expect(sql).toContain('ON CONFLICT (pubkey, mint_url)')
    expect(params).toEqual([
      pubkey,
      'https://mint.example.com',
      true,
      false,
      ['wss://relay.example.com', 'ws://relay2.example.com'],
    ])
  })

  it('rejects relays that is not an array', async () => {
    const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST')
    const res = await post(
      SUBSCRIBE_PATH,
      { mintUrl: 'https://mint.example.com', notifyOnDown: true, notifyOnUp: true, relays: 'wss://x' },
      header
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/relays must be/)
  })

  it('rejects an empty relays array', async () => {
    const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST')
    const res = await post(
      SUBSCRIBE_PATH,
      { mintUrl: 'https://mint.example.com', notifyOnDown: true, notifyOnUp: true, relays: [] },
      header
    )
    expect(res.status).toBe(400)
  })

  it('rejects more than 10 relays', async () => {
    const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST')
    const relays = Array.from({ length: 11 }, (_, i) => `wss://relay${i}.example.com`)
    const res = await post(
      SUBSCRIBE_PATH,
      { mintUrl: 'https://mint.example.com', notifyOnDown: true, notifyOnUp: true, relays },
      header
    )
    expect(res.status).toBe(400)
  })

  it('rejects a non-ws(s) relay scheme', async () => {
    const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST')
    const res = await post(
      SUBSCRIBE_PATH,
      { mintUrl: 'https://mint.example.com', notifyOnDown: true, notifyOnUp: true, relays: ['https://relay.example.com'] },
      header
    )
    expect(res.status).toBe(400)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('sanitizes control characters out of a rejected relay URL before it is logged (audit finding L1)', async () => {
    const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // wss://10.0.0.1 → SSRF-blocked (private IP, no DNS needed); the CRLF +
    // fake log line would forge a second entry if logged raw.
    const evilRelay = 'wss://10.0.0.1/\r\n[notifications/subscribe] pubkey=deadbeef mint=https://legit.example ADMIN OK\r\nwss://x/'

    const res = await post(
      SUBSCRIBE_PATH,
      { mintUrl: 'https://mint.example.com', notifyOnDown: true, notifyOnUp: true, relays: [evilRelay] },
      header,
    )

    expect(res.status).toBe(400)
    const logged = warnSpy.mock.calls.map(c => c.join(' ')).join(' || ')
    // The relay string WAS logged (for diagnosability) but with control chars
    // replaced — no raw CR/LF/ANSI that could split or forge a log line.
    expect(logged).toContain('10.0.0.1')
    // eslint-disable-next-line no-control-regex
    expect(logged).not.toMatch(/[\u0000-\u001f]/)
    expect(logged).toContain('�')
    warnSpy.mockRestore()
  })

  describe('relay SSRF guard', () => {
    it.each([
      ['ws://127.0.0.1', 'loopback literal'],
      ['ws://10.0.0.5', 'private literal'],
      ['ws://169.254.169.254', 'link-local (cloud metadata) literal'],
    ])('rejects %s (%s) without a DNS lookup', async (relayUrl) => {
      const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST')
      const res = await post(
        SUBSCRIBE_PATH,
        { mintUrl: 'https://mint.example.com', notifyOnDown: true, notifyOnUp: true, relays: [relayUrl] },
        header
      )
      expect(res.status).toBe(400)
      expect(lookup).not.toHaveBeenCalled()
      expect(query).not.toHaveBeenCalled()
    })

    it('rejects a relay hostname that resolves to a private IP (DNS-rebinding style)', async () => {
      const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST')
      resolvesTo({ address: '192.168.1.10', family: 4 })
      const res = await post(
        SUBSCRIBE_PATH,
        { mintUrl: 'https://mint.example.com', notifyOnDown: true, notifyOnUp: true, relays: ['wss://rebind.example.com'] },
        header
      )
      expect(res.status).toBe(400)
      expect(query).not.toHaveBeenCalled()
    })

    // Regression test for a real production bug: a subscribe request with
    // exactly 10 valid wss:// relays was rejected with a generic 400 because
    // ONE relay (relay.nostr.bg) has no DNS records at all (confirmed via
    // `dig` — a genuinely dead hostname, not a sandbox/network artifact).
    // isSafeWsUrl collapsed 'dns-error' and 'blocked' into the same `false`,
    // so a single unresolvable relay failed the entire otherwise-valid batch.
    // A DNS failure isn't an SSRF signal (checkWsUrlSafety already models it
    // as a distinct third state for exactly this reason) — it should not be
    // treated the same as a relay that actually resolves to a private IP.
    it('regression: accepts a 10-relay batch where exactly one relay has no DNS records', async () => {
      const { header, pubkey } = await nip98Header(SUBSCRIBE_PATH, 'POST')
      const relays = [
        'wss://relay.primal.net', 'wss://nos.lol', 'wss://nostr.wine',
        'wss://nostr.bitcoiner.social', 'wss://nostr.mom', 'wss://relay.damus.io',
        'wss://nostr.oxtr.dev', 'wss://relay.mostr.pub', 'wss://relay.nostr.bg',
        'wss://relay.noswhere.com',
      ]
      const deadHost = 'relay.nostr.bg'
      lookup.mockImplementation(async (hostname: unknown) => {
        if (hostname === deadHost) {
          throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${deadHost}`), { code: 'ENOTFOUND' })
        }
        return [{ address: '1.2.3.4', family: 4 }]
      })
      query.mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // mint lookup hit
      query.mockResolvedValueOnce({ rows: [{ total: 0, this_mint: 0, other_relays: [] }] }) // per-pubkey caps
      query.mockResolvedValueOnce({ rowCount: 1 }) // upsert

      const res = await post(
        SUBSCRIBE_PATH,
        { mintUrl: 'https://mint.example.com', notifyOnDown: true, notifyOnUp: true, relays },
        header
      )

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true })
      // The unresolvable relay is still stored exactly as submitted.
      const [, params] = query.mock.calls[2]
      expect(params).toEqual([pubkey, 'https://mint.example.com', true, true, relays])
    })

    it('still rejects the whole batch when a relay is genuinely SSRF-blocked, even alongside an unresolvable one', async () => {
      const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST')
      lookup.mockImplementation(async (hostname: unknown) => {
        if (hostname === 'dead.example.com') {
          throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' })
        }
        if (hostname === 'internal.example.com') {
          return [{ address: '10.0.0.5', family: 4 }]
        }
        return [{ address: '1.2.3.4', family: 4 }]
      })

      const res = await post(
        SUBSCRIBE_PATH,
        {
          mintUrl: 'https://mint.example.com',
          notifyOnDown: true,
          notifyOnUp: true,
          relays: ['wss://good.example.com', 'wss://dead.example.com', 'wss://internal.example.com'],
        },
        header
      )

      expect(res.status).toBe(400)
      expect(query).not.toHaveBeenCalled()
    })

    it('logs server-side which relay was blocked and why, without exposing it in the client response', async () => {
      const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST')
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      resolvesTo({ address: '10.0.0.5', family: 4 })

      const res = await post(
        SUBSCRIBE_PATH,
        { mintUrl: 'https://mint.example.com', notifyOnDown: true, notifyOnUp: true, relays: ['wss://internal.example.com'] },
        header
      )

      expect(res.status).toBe(400)
      expect(res.body.error).not.toContain('internal.example.com')
      const logged = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
      expect(logged).toContain('internal.example.com')
      expect(logged.toLowerCase()).toContain('blocked')
      warnSpy.mockRestore()
    })
  })

  it('rate-limits a single pubkey after 30 requests/hour (31st → 429)', async () => {
    const sk = generateSecretKey()
    // Reuse one signed token across the whole loop — the auth layer permits
    // it (NIP-98 has no built-in single-use nonce), so this isolates the
    // rate limiter itself as the thing under test.
    const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST', { sk })

    for (let i = 0; i < 30; i++) {
      // Empty body still consumes a rate-limit slot (checked before body validation).
      const r = await post(SUBSCRIBE_PATH, {}, header)
      expect(r.status).toBe(400)
    }
    const limited = await post(SUBSCRIBE_PATH, {}, header)
    expect(limited.status).toBe(429)
  })

  it('does not let one pubkey exhausting its limit affect a different pubkey', async () => {
    const { header: headerA } = await nip98Header(SUBSCRIBE_PATH, 'POST')
    const { header: headerB } = await nip98Header(SUBSCRIBE_PATH, 'POST')

    for (let i = 0; i < 30; i++) {
      expect((await post(SUBSCRIBE_PATH, {}, headerA)).status).toBe(400)
    }
    expect((await post(SUBSCRIBE_PATH, {}, headerA)).status).toBe(429)
    expect((await post(SUBSCRIBE_PATH, {}, headerB)).status).toBe(400)
  })

  it('does not log relays or notify flags (only truncated pubkey + mint)', async () => {
    const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST')
    resolvesTo({ address: '1.2.3.4', family: 4 })
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
    query.mockResolvedValueOnce({ rows: [{ total: 0, this_mint: 0, other_relays: [] }] })
    query.mockResolvedValueOnce({ rowCount: 1 })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await post(
      SUBSCRIBE_PATH,
      {
        mintUrl: 'https://mint.example.com',
        notifyOnDown: true,
        notifyOnUp: true,
        relays: ['wss://secret-relay.example.com'],
      },
      header
    )

    const loggedLines = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(loggedLines).not.toContain('secret-relay')
    logSpy.mockRestore()
  })

  // Per-pubkey caps — bound the notification-subscription store so one free
  // pubkey can't accumulate a row (with up to 10 attacker-chosen relay URLs)
  // for every mint and turn a flapping mint into amplified fan-out signed by
  // NOTIFICATION_SERVICE_NSEC. The 30/hr rate limit only bounds the write rate.
  describe('per-pubkey caps', () => {
    // Mocks: [0] mint lookup, [1] caps query, [2] upsert (if reached).
    function mockCaps(opts: { total?: number; thisMint?: number; otherRelays?: string[] }) {
      query.mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // mint lookup hit
      query.mockResolvedValueOnce({
        rows: [{ total: opts.total ?? 0, this_mint: opts.thisMint ?? 0, other_relays: opts.otherRelays ?? [] }],
      })
      query.mockResolvedValueOnce({ rowCount: 1 }) // upsert (only consumed if the caps pass)
    }

    it('rejects the 51st distinct mint subscription with 409 and an actionable message', async () => {
      const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST')
      resolvesTo({ address: '1.2.3.4', family: 4 })
      mockCaps({ total: 50, thisMint: 0 })

      const res = await post(
        SUBSCRIBE_PATH,
        { mintUrl: 'https://mint.example.com', notifyOnDown: true, notifyOnUp: true, relays: ['wss://relay.example.com'] },
        header,
      )

      expect(res.status).toBe(409)
      expect(res.body.error).toMatch(/50 mint notification subscriptions/)
      expect(res.body.error).toMatch(/[Uu]nsubscribe/)
      // The upsert must NOT have run.
      expect(query.mock.calls.some(c => String(c[0]).includes('INSERT INTO notification_subscriptions'))).toBe(false)
    })

    it('still allows UPDATING an existing subscription when already at the row cap', async () => {
      const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST')
      resolvesTo({ address: '1.2.3.4', family: 4 })
      mockCaps({ total: 50, thisMint: 1 }) // this mint already has a row

      const res = await post(
        SUBSCRIBE_PATH,
        { mintUrl: 'https://mint.example.com', notifyOnDown: false, notifyOnUp: true, relays: ['wss://relay.example.com'] },
        header,
      )

      expect(res.status).toBe(200)
      expect(query.mock.calls.some(c => String(c[0]).includes('INSERT INTO notification_subscriptions'))).toBe(true)
    })

    it('rejects a request that would push the pubkey past the distinct-relay cap with 400 and a clear message', async () => {
      const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST')
      resolvesTo({ address: '1.2.3.4', family: 4 })
      const existing = Array.from({ length: 20 }, (_, i) => `wss://existing-${i}.example.com`)
      const fresh = Array.from({ length: 10 }, (_, i) => `wss://fresh-${i}.example.com`) // 20 + 10 = 30 distinct
      mockCaps({ total: 5, thisMint: 0, otherRelays: existing })

      const res = await post(
        SUBSCRIBE_PATH,
        { mintUrl: 'https://mint.example.com', notifyOnDown: true, notifyOnUp: true, relays: fresh },
        header,
      )

      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/30 distinct relays/)
      expect(res.body.error).toMatch(/maximum is 25/)
      expect(query.mock.calls.some(c => String(c[0]).includes('INSERT INTO notification_subscriptions'))).toBe(false)
    })

    it('accepts a request that reuses relays already stored for the pubkey (union stays under the cap)', async () => {
      const { header } = await nip98Header(SUBSCRIBE_PATH, 'POST')
      resolvesTo({ address: '1.2.3.4', family: 4 })
      const existing = Array.from({ length: 25 }, (_, i) => `wss://existing-${i}.example.com`)
      mockCaps({ total: 5, thisMint: 0, otherRelays: existing })

      const res = await post(
        SUBSCRIBE_PATH,
        { mintUrl: 'https://mint.example.com', notifyOnDown: true, notifyOnUp: true, relays: existing.slice(0, 5) },
        header,
      )

      expect(res.status).toBe(200)
    })

    it('scopes the cap query to the authenticated pubkey', async () => {
      const { header, pubkey } = await nip98Header(SUBSCRIBE_PATH, 'POST')
      resolvesTo({ address: '1.2.3.4', family: 4 })
      mockCaps({ total: 0, thisMint: 0 })

      await post(
        SUBSCRIBE_PATH,
        { mintUrl: 'https://mint.example.com', notifyOnDown: true, notifyOnUp: true, relays: ['wss://relay.example.com'] },
        header,
      )

      const capCall = query.mock.calls.find(c => String(c[0]).includes('other_relays'))
      expect(capCall).toBeDefined()
      expect(capCall![1]).toEqual([pubkey, 'https://mint.example.com'])
    })
  })
})

describe('POST /api/notifications/unsubscribe', () => {
  it('requires NIP-98 auth', async () => {
    const res = await post(UNSUBSCRIBE_PATH, { mintUrl: 'https://mint.example.com' })
    expect(res.status).toBe(401)
  })

  it('deletes the subscription for the authenticated pubkey + mint', async () => {
    const { header, pubkey } = await nip98Header(UNSUBSCRIBE_PATH, 'POST')
    query.mockResolvedValueOnce({ rowCount: 1 })

    const res = await post(UNSUBSCRIBE_PATH, { mintUrl: 'https://mint.example.com' }, header)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('DELETE FROM notification_subscriptions')
    expect(params).toEqual([pubkey, 'https://mint.example.com'])
  })

  it('has its own independent 30/hour/pubkey budget from subscribe', async () => {
    const sk = generateSecretKey()
    const { header: subHeader } = await nip98Header(SUBSCRIBE_PATH, 'POST', { sk })
    const { header: unsubHeader } = await nip98Header(UNSUBSCRIBE_PATH, 'POST', { sk })

    // Exhaust subscribe's budget for this pubkey.
    for (let i = 0; i < 30; i++) {
      expect((await post(SUBSCRIBE_PATH, {}, subHeader)).status).toBe(400)
    }
    expect((await post(SUBSCRIBE_PATH, {}, subHeader)).status).toBe(429)

    // unsubscribe for the same pubkey is unaffected.
    query.mockResolvedValueOnce({ rowCount: 1 })
    const res = await post(UNSUBSCRIBE_PATH, { mintUrl: 'https://mint.example.com' }, unsubHeader)
    expect(res.status).toBe(200)
  })
})
