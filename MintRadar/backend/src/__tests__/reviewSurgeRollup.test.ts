import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))

vi.mock('../db.js', () => ({
  pool: { query: queryMock },
  initDb: vi.fn(),
}))

import { refreshReviewSurgeBaseline, isReviewSurgeRollupRunning } from '../reviewSurgeRollup.js'

beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rowCount: 5 })
})

describe('refreshReviewSurgeBaseline', () => {
  it('issues one UPDATE that snapshots review_count into review_count_7d_ago', async () => {
    await refreshReviewSurgeBaseline()
    expect(queryMock).toHaveBeenCalledTimes(1)
    const sql = queryMock.mock.calls[0][0] as string
    expect(sql).toMatch(/UPDATE mints/i)
    expect(sql).toMatch(/review_count_7d_ago\s*=\s*review_count/)
    expect(sql).toMatch(/review_count_7d_ago_at\s*=\s*NOW\(\)/i)
  })

  it('only advances a snapshot that is missing or already ≥7 days old', async () => {
    await refreshReviewSurgeBaseline()
    const sql = queryMock.mock.calls[0][0] as string
    expect(sql).toMatch(/review_count_7d_ago_at IS NULL/)
    expect(sql).toMatch(/review_count_7d_ago_at\s*<=\s*NOW\(\)\s*-\s*INTERVAL '7 days'/)
  })

  it('skips mints whose review_count has never been synced (still NULL)', async () => {
    await refreshReviewSurgeBaseline()
    const sql = queryMock.mock.calls[0][0] as string
    expect(sql).toMatch(/review_count IS NOT NULL/)
  })

  it('never throws when the query fails — leaves the previous snapshot in place', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection refused'))
    await expect(refreshReviewSurgeBaseline()).resolves.toBeUndefined()
  })

  it('is single-flight: an overlapping call while one is in progress is a no-op', async () => {
    let release!: () => void
    queryMock.mockImplementationOnce(
      () => new Promise(resolve => { release = () => resolve({ rowCount: 1 }) }),
    )
    const first = refreshReviewSurgeBaseline()
    expect(isReviewSurgeRollupRunning()).toBe(true)
    await refreshReviewSurgeBaseline() // no-op
    expect(queryMock).toHaveBeenCalledTimes(1)
    release()
    await first
    expect(isReviewSurgeRollupRunning()).toBe(false)
  })
})
