import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))

vi.mock('../db.js', () => ({
  pool: { query: queryMock },
  initDb: vi.fn(),
}))
// fetchLatestUpstreamVersions() now goes through safeFetch (SSRF guard + DNS
// pinning), not the global fetch — mock it at the ssrf.js boundary.
vi.mock('../ssrf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ssrf.js')>()
  return { ...actual, safeFetch: vi.fn() }
})

import {
  effectiveLatestVersions,
  fetchLatestUpstreamVersions,
  getLatestVersionsMap,
  VERSION_GRACE_PERIOD_MS,
} from '../versionCatalog.js'
import { safeFetch } from '../ssrf.js'

const safeFetchMock = vi.mocked(safeFetch)

const NOW = new Date('2026-09-06T00:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString()
}

describe('effectiveLatestVersions — grace period', () => {
  it('a version released 5 days ago is NOT yet "latest" — scored against the previous rung', () => {
    const map = effectiveLatestVersions(
      [{ software: 'cdk', latest_version: '0.17.5', previous_version: '0.16.2', released_at: daysAgo(5) }],
      NOW
    )
    expect(map['cdk']).toEqual({ major: 0, minor: 16 })
  })

  it('a version released 20 days ago is past the grace period — scored normally', () => {
    const map = effectiveLatestVersions(
      [{ software: 'cdk', latest_version: '0.17.5', previous_version: '0.16.2', released_at: daysAgo(20) }],
      NOW
    )
    expect(map['cdk']).toEqual({ major: 0, minor: 17 })
  })

  it('grace period boundary: exactly 14 days old no longer counts as within grace', () => {
    const exactlyAtBoundary = new Date(NOW.getTime() - VERSION_GRACE_PERIOD_MS).toISOString()
    const map = effectiveLatestVersions(
      [{ software: 'cdk', latest_version: '0.17.5', previous_version: '0.16.2', released_at: exactlyAtBoundary }],
      NOW
    )
    expect(map['cdk']).toEqual({ major: 0, minor: 17 })
  })

  it('grace period boundary: one millisecond short of 14 days still counts as within grace', () => {
    const justInsideGrace = new Date(NOW.getTime() - VERSION_GRACE_PERIOD_MS + 1).toISOString()
    const map = effectiveLatestVersions(
      [{ software: 'cdk', latest_version: '0.17.5', previous_version: '0.16.2', released_at: justInsideGrace }],
      NOW
    )
    expect(map['cdk']).toEqual({ major: 0, minor: 16 })
  })

  it('no released_at (legacy/seeded row) skips the grace period — uses latest_version directly', () => {
    const map = effectiveLatestVersions(
      [{ software: 'nutshell', latest_version: '0.20.3', previous_version: '0.19.1', released_at: null }],
      NOW
    )
    expect(map['nutshell']).toEqual({ major: 0, minor: 20 })
  })

  it('no previous_version (first version ever recorded) skips the grace period — nothing to fall back to', () => {
    const map = effectiveLatestVersions(
      [{ software: 'nutshell', latest_version: '0.20.3', previous_version: null, released_at: daysAgo(1) }],
      NOW
    )
    expect(map['nutshell']).toEqual({ major: 0, minor: 20 })
  })

  it('handles multiple software rows independently', () => {
    const map = effectiveLatestVersions(
      [
        { software: 'nutshell', latest_version: '0.20.3', previous_version: '0.19.1', released_at: daysAgo(3) },
        { software: 'cdk', latest_version: '0.17.5', previous_version: '0.16.2', released_at: daysAgo(30) },
      ],
      NOW
    )
    expect(map['nutshell']).toEqual({ major: 0, minor: 19 })
    expect(map['cdk']).toEqual({ major: 0, minor: 17 })
  })

  it('skips a row with null latest_version', () => {
    const map = effectiveLatestVersions(
      [{ software: 'cdk', latest_version: null, previous_version: null, released_at: null }],
      NOW
    )
    expect(map['cdk']).toBeUndefined()
  })

  it('skips a row whose effective version string is unparseable', () => {
    const map = effectiveLatestVersions(
      [{ software: 'cdk', latest_version: 'not-a-version', previous_version: null, released_at: null }],
      NOW
    )
    expect(map['cdk']).toBeUndefined()
  })

  it('defaults `now` to the real current time when omitted', () => {
    const map = effectiveLatestVersions([
      { software: 'cdk', latest_version: '0.17.5', previous_version: '0.16.2', released_at: new Date().toISOString() },
    ])
    expect(map['cdk']).toEqual({ major: 0, minor: 16 })
  })
})

describe('getLatestVersionsMap', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('reads software_versions and applies the grace period to the returned map', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { software: 'cdk', latest_version: '0.17.5', previous_version: '0.16.2', released_at: daysAgo(5) },
        { software: 'nutshell', latest_version: '0.20.3', previous_version: '0.19.1', released_at: daysAgo(30) },
      ],
    })
    const map = await getLatestVersionsMap()
    expect(map['cdk']).toEqual({ major: 0, minor: 16 }) // still within grace
    expect(map['nutshell']).toEqual({ major: 0, minor: 20 }) // past grace
    const sql = queryMock.mock.calls[0]?.[0] as string
    expect(sql).toMatch(/previous_version/)
    expect(sql).toMatch(/released_at/)
  })

  it('never throws — returns an empty map on a DB error', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection refused'))
    await expect(getLatestVersionsMap()).resolves.toEqual({})
  })
})

describe('fetchLatestUpstreamVersions', () => {
  beforeEach(() => {
    queryMock.mockReset()
    queryMock.mockResolvedValue({ rows: [] })
    safeFetchMock.mockReset()
  })

  function mockGithubResponse(overrides: Record<string, unknown> = {}) {
    return {
      ok: true,
      json: () => Promise.resolve({
        tag_name: '0.18.0',
        published_at: '2026-09-01T00:00:00Z',
        prerelease: false,
        draft: false,
        ...overrides,
      }),
    }
  }

  it('upserts latest_version/released_at and rotates previous_version only when the tag actually changed', async () => {
    safeFetchMock.mockResolvedValue(mockGithubResponse() as never)

    await fetchLatestUpstreamVersions()

    expect(queryMock).toHaveBeenCalled()
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/INSERT INTO software_versions/)
    expect(sql).toMatch(/IS DISTINCT FROM/)
    expect(params).toEqual(['nutshell', '0.18.0', '2026-09-01T00:00:00Z', 'https://api.github.com/repos/cashubtc/nutshell/releases/latest'])
  })

  it('passes null released_at when GitHub omits/malforms published_at', async () => {
    safeFetchMock.mockResolvedValue(mockGithubResponse({ published_at: 'not-a-date' }) as never)

    await fetchLatestUpstreamVersions()

    const [, params] = queryMock.mock.calls[0] as [string, unknown[]]
    expect(params[2]).toBeNull()
  })

  it('skips a repo whose latest release is a prerelease/draft — no query issued for it', async () => {
    safeFetchMock.mockResolvedValue(mockGithubResponse({ prerelease: true }) as never)

    await fetchLatestUpstreamVersions()

    // Only the second repo (cdk) should have queried — nutshell was skipped.
    const softwareArgs = queryMock.mock.calls.map(call => (call[1] as unknown[])[0])
    expect(softwareArgs).not.toContain('nutshell')
  })

  it('never throws when the GitHub fetch fails for a repo (safeFetch returns null)', async () => {
    safeFetchMock.mockResolvedValue(null)
    await expect(fetchLatestUpstreamVersions()).resolves.toBeUndefined()
    // No upsert issued for either repo.
    expect(queryMock).not.toHaveBeenCalled()
  })
})
