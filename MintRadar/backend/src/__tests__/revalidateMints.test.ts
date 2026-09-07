import { describe, it, expect, vi, beforeEach } from 'vitest'

// revalidateMints() runs once a day: it does a STRONG /v1/info + /v1/keys check
// per mint, maintains `mints.invalid_since` (the reap clock), and deletes any
// mint that has served non-Cashu content continuously for REVALIDATION_REAP_DAYS
// (7). This is the fix for the "validate once, then repoint anywhere" finding —
// a URL DNS-repointed to a non-mint host after passing the submit/discovery gate
// used to be probed by MintRadar's server forever.
//
// Mock only the external boundaries (same approach as prober-transitions.test.ts).

vi.mock('../db.js', () => ({ pool: { query: vi.fn() } }))
vi.mock('../ssrf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ssrf.js')>()
  return { ...actual, safeFetch: vi.fn() }
})
vi.mock('../nostrService.js', () => ({
  notifySubscribers: vi.fn().mockResolvedValue(undefined),
  isNotificationServiceEnabled: vi.fn().mockReturnValue(false),
}))
vi.mock('../versionCatalog.js', () => ({ getLatestVersionsMap: vi.fn().mockResolvedValue({}) }))

let query: ReturnType<typeof vi.fn>
let safeFetch: ReturnType<typeof vi.fn>
let revalidateMints: typeof import('../prober.js')['revalidateMints']

const VALID_INFO = { name: 'Real Mint', nuts: { '4': {}, '5': {} } }
const VALID_KEYS = { keysets: [{ id: '009a1f293253e41e', unit: 'sat', active: true }] }

/** A fake undici Response as revalidateMintContent consumes it. */
function res(opts: { ok?: boolean; status?: number; json?: unknown }) {
  const ok = opts.ok ?? true
  return {
    ok,
    status: opts.status ?? (ok ? 200 : 404),
    json: async () => {
      if (opts.json instanceof Error) throw opts.json
      return opts.json
    },
  }
}

/** Configure safeFetch(`${url}/v1/info`) / (`${url}/v1/keys`) responses. */
function serve(map: Record<string, { info?: unknown; keys?: unknown }>) {
  safeFetch.mockImplementation(async (u: string) => {
    for (const [mint, r] of Object.entries(map)) {
      if (u === `${mint}/v1/info`) return r.info ?? null
      if (u === `${mint}/v1/keys`) return r.keys ?? null
    }
    return null
  })
}

// Records every SQL statement + params the run dispatches.
let calls: Array<{ sql: string; params: unknown[] }>
let deleteRowCount = 0

beforeEach(async () => {
  vi.resetModules()
  const db = await import('../db.js')
  const ssrf = await import('../ssrf.js')
  query = db.pool.query as unknown as ReturnType<typeof vi.fn>
  safeFetch = ssrf.safeFetch as unknown as ReturnType<typeof vi.fn>
  query.mockReset()
  safeFetch.mockReset()
  calls = []
  deleteRowCount = 0

  query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    if (/SELECT url FROM mints\s*$/.test(sql.trim())) return { rows: mintRows }
    if (/^DELETE FROM mints/.test(sql.trim())) return { rowCount: deleteRowCount }
    return { rowCount: 1 }
  })

  ;({ revalidateMints } = await import('../prober.js'))
})

let mintRows: { url: string }[] = []

function updatesFor(url: string) {
  return calls.filter(c => /^UPDATE mints SET/.test(c.sql.trim()) && c.params[0] === url).map(c => c.sql.replace(/\s+/g, ' ').trim())
}

describe('revalidateMints', () => {
  it('clears invalid_since for a mint that still serves valid Cashu content', async () => {
    mintRows = [{ url: 'https://good.mint' }]
    serve({ 'https://good.mint': { info: res({ json: VALID_INFO }), keys: res({ json: VALID_KEYS }) } })

    const out = await revalidateMints()

    expect(out).toEqual({ checked: 1, invalid: 0, reaped: 0 })
    expect(updatesFor('https://good.mint')).toEqual([
      'UPDATE mints SET revalidated_at = NOW(), invalid_since = NULL WHERE url = $1',
    ])
  })

  it('starts the reap clock when a mint is repointed to a host that is not a Cashu mint (HTML / redirect target)', async () => {
    mintRows = [{ url: 'https://was-a-mint.example' }]
    // /v1/info now returns a 200 whose body is not JSON (an HTML landing page).
    serve({
      'https://was-a-mint.example': {
        info: res({ json: new Error('Unexpected token < in JSON') }),
        keys: res({ ok: false, status: 404 }),
      },
    })

    const out = await revalidateMints()

    expect(out.invalid).toBe(1)
    expect(updatesFor('https://was-a-mint.example')).toEqual([
      'UPDATE mints SET revalidated_at = NOW(), invalid_since = COALESCE(invalid_since, NOW()) WHERE url = $1',
    ])
  })

  it('treats an empty {"nuts":{}} stub as not-a-mint', async () => {
    mintRows = [{ url: 'https://stub.example' }]
    serve({ 'https://stub.example': { info: res({ json: { nuts: {} } }), keys: res({ json: VALID_KEYS }) } })

    const out = await revalidateMints()
    expect(out.invalid).toBe(1)
    expect(updatesFor('https://stub.example')[0]).toContain('invalid_since = COALESCE(invalid_since, NOW())')
  })

  it('treats valid /v1/info but a missing /v1/keys as not-a-mint', async () => {
    mintRows = [{ url: 'https://halfmint.example' }]
    serve({ 'https://halfmint.example': { info: res({ json: VALID_INFO }), keys: res({ ok: false, status: 404 }) } })

    const out = await revalidateMints()
    expect(out.invalid).toBe(1)
  })

  it('does NOT advance the reap clock for a transiently unreachable mint (network error)', async () => {
    mintRows = [{ url: 'https://down.example' }]
    serve({ 'https://down.example': { info: null, keys: null } }) // safeFetch → null

    const out = await revalidateMints()

    expect(out.invalid).toBe(0)
    // Only records that the check ran — never touches invalid_since.
    expect(updatesFor('https://down.example')).toEqual([
      'UPDATE mints SET revalidated_at = NOW() WHERE url = $1',
    ])
  })

  it('does NOT advance the reap clock on a 5xx (transient server error)', async () => {
    mintRows = [{ url: 'https://5xx.example' }]
    serve({ 'https://5xx.example': { info: res({ ok: false, status: 503 }), keys: res({ ok: false, status: 503 }) } })

    const out = await revalidateMints()
    expect(out.invalid).toBe(0)
    expect(updatesFor('https://5xx.example')).toEqual(['UPDATE mints SET revalidated_at = NOW() WHERE url = $1'])
  })

  it('reaps mints whose invalid_since is older than the 7-day window', async () => {
    mintRows = [{ url: 'https://a.example' }, { url: 'https://b.example' }]
    serve({
      'https://a.example': { info: res({ json: VALID_INFO }), keys: res({ json: VALID_KEYS }) },
      'https://b.example': { info: res({ json: VALID_INFO }), keys: res({ json: VALID_KEYS }) },
    })
    deleteRowCount = 2

    const out = await revalidateMints()

    expect(out.reaped).toBe(2)
    const del = calls.find(c => /^DELETE FROM mints/.test(c.sql.trim()))!
    expect(del.sql.replace(/\s+/g, ' ')).toContain("invalid_since < NOW() - INTERVAL '7 days'")
    expect(del.sql).toContain('invalid_since IS NOT NULL')
  })

  it('SCENARIO: a mint DNS-repointed to another public host after validation is caught at the next revalidation, then reaped — not ignored forever', async () => {
    const REPOINTED = 'https://mint.attacker.example'
    mintRows = [{ url: REPOINTED }]

    // Day N: the URL passed the submit gate long ago; the operator has now
    // repointed DNS to a plain web server. /v1/info answers 200 with HTML.
    serve({ [REPOINTED]: { info: res({ json: new Error('not json') }), keys: res({ ok: false, status: 404 }) } })
    deleteRowCount = 0
    let out = await revalidateMints()
    expect(out.invalid).toBe(1)
    expect(out.reaped).toBe(0) // clock just started
    expect(updatesFor(REPOINTED)[0]).toContain('invalid_since = COALESCE(invalid_since, NOW())')

    // ...several daily runs later, invalid_since is now >7 days old → the DELETE
    // condition matches and the row is removed from the probe rotation.
    calls = []
    deleteRowCount = 1
    out = await revalidateMints()
    expect(out.reaped).toBe(1)
  })

  it('counts every mint it checked', async () => {
    mintRows = [{ url: 'https://a' }, { url: 'https://b' }, { url: 'https://c' }]
    serve({
      'https://a': { info: res({ json: VALID_INFO }), keys: res({ json: VALID_KEYS }) },
      'https://b': { info: res({ json: VALID_INFO }), keys: res({ json: VALID_KEYS }) },
      'https://c': { info: res({ json: VALID_INFO }), keys: res({ json: VALID_KEYS }) },
    })
    const out = await revalidateMints()
    expect(out.checked).toBe(3)
  })
})
