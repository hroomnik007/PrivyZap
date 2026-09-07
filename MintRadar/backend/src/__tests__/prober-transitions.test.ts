import { describe, it, expect, vi, beforeEach } from 'vitest'

// probeMintToDb() detects online/offline transitions immediately before
// writing the new mint_history row and fires notifySubscribers() for a real
// transition. We mock the external boundaries only:
//   - db.js pool          → no database (SQL dispatched by pattern match)
//   - dns/promises lookup → deterministic SSRF-guard resolution
//   - ssrf.js safeFetch   → no outbound network
//   - nostrService.js     → no real notification sending
// checkUrlSafety()/isSafeUrl() run for real (partial ssrf mock keeps them).

vi.mock('../db.js', () => ({
  pool: { query: vi.fn() },
}))
vi.mock('dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('../ssrf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ssrf.js')>()
  return { ...actual, safeFetch: vi.fn() }
})
vi.mock('../nostrService.js', () => ({
  notifySubscribers: vi.fn().mockResolvedValue(undefined),
  isNotificationServiceEnabled: vi.fn(),
}))

const MINT = 'https://mint.example.com'

let query: ReturnType<typeof vi.fn>
let lookup: ReturnType<typeof vi.fn>
let safeFetch: ReturnType<typeof vi.fn>
let notifySubscribers: ReturnType<typeof vi.fn>
let isNotificationServiceEnabled: ReturnType<typeof vi.fn>
let probeMintToDb: typeof import('../prober.js')['probeMintToDb']

beforeEach(async () => {
  vi.resetModules()
  const db = await import('../db.js')
  query = db.pool.query as unknown as ReturnType<typeof vi.fn>
  query.mockReset()

  const dns = await import('dns/promises')
  lookup = dns.lookup as unknown as ReturnType<typeof vi.fn>
  lookup.mockReset()
  lookup.mockResolvedValue([{ address: '1.2.3.4', family: 4 }])

  const ssrf = await import('../ssrf.js')
  safeFetch = ssrf.safeFetch as unknown as ReturnType<typeof vi.fn>
  safeFetch.mockReset()

  const notify = await import('../nostrService.js')
  notifySubscribers = notify.notifySubscribers as unknown as ReturnType<typeof vi.fn>
  notifySubscribers.mockReset().mockResolvedValue(undefined)
  isNotificationServiceEnabled = notify.isNotificationServiceEnabled as unknown as ReturnType<typeof vi.fn>
  isNotificationServiceEnabled.mockReset().mockReturnValue(true)

  ;({ probeMintToDb } = await import('../prober.js'))

  // Generic SQL dispatcher — matches by pattern so call order/count doesn't
  // need to be hardcoded (probeMintToDb runs a different query sequence for
  // online vs. offline probes).
  query.mockImplementation(async (sql: string) => {
    if (/SELECT online FROM mint_history WHERE url = \$1/.test(sql)) {
      return { rows: previousRows }
    }
    if (/INSERT INTO mint_history/.test(sql)) {
      return { rows: [{ id: 1 }] }
    }
    if (/SELECT version FROM mints WHERE url = \$1/.test(sql)) {
      return { rows: [{ version: '1.0.0' }] }
    }
    if (/UPDATE mints SET\n\s*name/.test(sql)) {
      return { rowCount: 1 }
    }
    if (/INSERT INTO mint_version_history/.test(sql)) {
      return { rowCount: 1 }
    }
    if (/SELECT server_location FROM mints WHERE url = \$1/.test(sql)) {
      return { rows: [{ server_location: 'Existing, Location' }] }
    }
    if (/FROM mints m\s*\n\s*LEFT JOIN mint_history h/.test(sql)) {
      return { rows: [{ nut_count: 1, version: '1.0.0', audit_recent_total: null, audit_recent_errors: null, total: '4', online_count: '2' }] }
    }
    if (/UPDATE mints SET last_trust_score/.test(sql)) {
      return { rowCount: 1 }
    }
    if (/UPDATE mint_history SET trust_score/.test(sql)) {
      return { rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
})

// Set by each test before calling probeMintToDb — controls what the
// "previous state" query returns.
let previousRows: { online: boolean }[] = []

function mintOffline(): void {
  // safeFetch is called up to twice (initial + one retry on null) for an
  // offline probe.
  safeFetch.mockResolvedValue(null)
}

function mintOnline(): void {
  safeFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/v1/info')) {
      return { ok: true, json: async () => ({ name: 'Test Mint', version: '1.0.0', nuts: { '4': {} } }) }
    }
    return null
  })
}

describe('probeMintToDb — transition detection', () => {
  it('down transition: previously online, now offline → notifies', async () => {
    previousRows = [{ online: true }]
    mintOffline()

    await probeMintToDb(MINT)

    expect(notifySubscribers).toHaveBeenCalledTimes(1)
    expect(notifySubscribers).toHaveBeenCalledWith(MINT, 'down', expect.any(Date))
  })

  it('up transition: previously offline, now online → notifies', async () => {
    previousRows = [{ online: false }]
    mintOnline()

    await probeMintToDb(MINT)

    expect(notifySubscribers).toHaveBeenCalledTimes(1)
    expect(notifySubscribers).toHaveBeenCalledWith(MINT, 'up', expect.any(Date))
  })

  it('online → online: no transition, does not notify', async () => {
    previousRows = [{ online: true }]
    mintOnline()

    await probeMintToDb(MINT)

    expect(notifySubscribers).not.toHaveBeenCalled()
  })

  it('offline → offline: no transition, does not notify', async () => {
    previousRows = [{ online: false }]
    mintOffline()

    await probeMintToDb(MINT)

    expect(notifySubscribers).not.toHaveBeenCalled()
  })

  it('first-ever probe (no prior row): skips detection entirely, does not notify', async () => {
    previousRows = []
    mintOffline()

    await probeMintToDb(MINT)

    expect(notifySubscribers).not.toHaveBeenCalled()
  })

  it('does not notify when the notification service is disabled, even on a real transition', async () => {
    previousRows = [{ online: true }]
    isNotificationServiceEnabled.mockReturnValue(false)
    mintOffline()

    await probeMintToDb(MINT)

    expect(notifySubscribers).not.toHaveBeenCalled()
  })

  it('a notifySubscribers rejection cannot escape probeMintToDb (fire-and-forget safety net)', async () => {
    previousRows = [{ online: true }]
    notifySubscribers.mockRejectedValue(new Error('relay publish exploded'))
    mintOffline()

    await expect(probeMintToDb(MINT)).resolves.toBeUndefined()
  })
})

// ── invalid_since maintenance (feeds revalidateMints()'s reap) ────────────────
//
// A probe that REACHES the host but gets something that isn't a Cashu mint API
// (4xx, or a 200 with no `nuts` object) is the signature of a URL repointed to a
// non-mint host after it first passed validation. probeMintToDb must start the
// reap clock (`invalid_since = COALESCE(invalid_since, NOW())`) in that case,
// clear it on a healthy probe, and leave it alone for transient failures.

describe('probeMintToDb — invalid_since reap-clock maintenance', () => {
  const invalidSinceUpdates = () =>
    query.mock.calls
      .map(c => String(c[0]).replace(/\s+/g, ' ').trim())
      .filter(sql => /^UPDATE mints SET invalid_since/.test(sql))

  it('clears invalid_since on a healthy (online) probe', async () => {
    previousRows = []
    mintOnline()

    await probeMintToDb(MINT)

    expect(invalidSinceUpdates()).toEqual(['UPDATE mints SET invalid_since = NULL WHERE url = $1'])
  })

  it('starts the reap clock when the host answers 404 (mint API no longer there)', async () => {
    previousRows = []
    safeFetch.mockResolvedValue({ ok: false, status: 404 })

    await probeMintToDb(MINT)

    expect(invalidSinceUpdates()).toEqual([
      'UPDATE mints SET invalid_since = COALESCE(invalid_since, NOW()) WHERE url = $1',
    ])
  })

  it('starts the reap clock when the host answers 200 with no `nuts` object', async () => {
    previousRows = []
    safeFetch.mockResolvedValue({ ok: true, json: async () => ({ name: 'Not a mint' }) })

    await probeMintToDb(MINT)

    expect(invalidSinceUpdates()).toEqual([
      'UPDATE mints SET invalid_since = COALESCE(invalid_since, NOW()) WHERE url = $1',
    ])
  })

  it('does NOT touch invalid_since for a transient failure (network error / timeout)', async () => {
    previousRows = []
    mintOffline() // safeFetch → null

    await probeMintToDb(MINT)

    expect(invalidSinceUpdates()).toEqual([])
  })

  it('does NOT touch invalid_since on a 5xx (transient server error, retried then recorded offline)', async () => {
    previousRows = []
    safeFetch.mockResolvedValue({ ok: false, status: 503 })

    await probeMintToDb(MINT)

    expect(invalidSinceUpdates()).toEqual([])
  })
})
