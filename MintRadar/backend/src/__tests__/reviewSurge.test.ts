import { describe, it, expect } from 'vitest'
import {
  hasRecentReviewSurge,
  SURGE_ABSOLUTE_GAIN,
  SURGE_RATIO_MIN_BASELINE,
} from '../reviewSurge.js'

const NOW = new Date('2026-09-08T12:00:00.000Z')
const DAY = 86_400_000
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)

// baseline snapshot ~4 days old (a normal position in the weekly roll)
const fresh = daysAgo(4)

describe('hasRecentReviewSurge — threshold', () => {
  it('flags the sybil example: 3 → 28 reviews between snapshots', () => {
    expect(hasRecentReviewSurge(
      { reviewCount: 28, reviewCount7dAgo: 3, reviewCount7dAgoAt: fresh }, NOW,
    )).toBe(true)
  })

  it('does NOT flag slow organic growth (+1–2 per week)', () => {
    expect(hasRecentReviewSurge(
      { reviewCount: 22, reviewCount7dAgo: 20, reviewCount7dAgoAt: fresh }, NOW,
    )).toBe(false)
    expect(hasRecentReviewSurge(
      { reviewCount: 6, reviewCount7dAgo: 5, reviewCount7dAgoAt: fresh }, NOW,
    )).toBe(false)
  })

  it('flags a large absolute gain even without doubling (50 → 61)', () => {
    expect(hasRecentReviewSurge(
      { reviewCount: 61, reviewCount7dAgo: 50, reviewCount7dAgoAt: fresh }, NOW,
    )).toBe(true)
  })

  it(`absolute rule boundary: +${SURGE_ABSOLUTE_GAIN} flags, +${SURGE_ABSOLUTE_GAIN - 1} does not`, () => {
    expect(hasRecentReviewSurge(
      { reviewCount: 40 + SURGE_ABSOLUTE_GAIN, reviewCount7dAgo: 40, reviewCount7dAgoAt: fresh }, NOW,
    )).toBe(true)
    expect(hasRecentReviewSurge(
      { reviewCount: 40 + SURGE_ABSOLUTE_GAIN - 1, reviewCount7dAgo: 40, reviewCount7dAgoAt: fresh }, NOW,
    )).toBe(false)
  })

  it('flags "more than doubled" from a real base (8 → 17)', () => {
    expect(hasRecentReviewSurge(
      { reviewCount: 17, reviewCount7dAgo: 8, reviewCount7dAgoAt: fresh }, NOW,
    )).toBe(true)
  })

  it('exactly doubling counts as "more than doubled" for this rule (7 → 14)', () => {
    expect(hasRecentReviewSurge(
      { reviewCount: 14, reviewCount7dAgo: 7, reviewCount7dAgoAt: fresh }, NOW,
    )).toBe(true)
  })

  it(`the ratio rule ignores tiny bases (< ${SURGE_RATIO_MIN_BASELINE}): 3 → 7 does not flag`, () => {
    expect(hasRecentReviewSurge(
      { reviewCount: 7, reviewCount7dAgo: 3, reviewCount7dAgoAt: fresh }, NOW,
    )).toBe(false)
  })

  it('does not flag a decrease or a no-change', () => {
    expect(hasRecentReviewSurge(
      { reviewCount: 10, reviewCount7dAgo: 25, reviewCount7dAgoAt: fresh }, NOW,
    )).toBe(false)
    expect(hasRecentReviewSurge(
      { reviewCount: 25, reviewCount7dAgo: 25, reviewCount7dAgoAt: fresh }, NOW,
    )).toBe(false)
  })
})

describe('hasRecentReviewSurge — missing / stale data is false-safe', () => {
  it('returns false when any of the three fields is null', () => {
    expect(hasRecentReviewSurge({ reviewCount: null, reviewCount7dAgo: 3, reviewCount7dAgoAt: fresh }, NOW)).toBe(false)
    expect(hasRecentReviewSurge({ reviewCount: 28, reviewCount7dAgo: null, reviewCount7dAgoAt: fresh }, NOW)).toBe(false)
    expect(hasRecentReviewSurge({ reviewCount: 28, reviewCount7dAgo: 3, reviewCount7dAgoAt: null }, NOW)).toBe(false)
  })

  it('returns false when the snapshot is older than 14 days (rollup has been down)', () => {
    expect(hasRecentReviewSurge(
      { reviewCount: 28, reviewCount7dAgo: 3, reviewCount7dAgoAt: daysAgo(15) }, NOW,
    )).toBe(false)
  })

  it('still flags with a snapshot right at the weekly-roll boundary (7 days old)', () => {
    expect(hasRecentReviewSurge(
      { reviewCount: 28, reviewCount7dAgo: 3, reviewCount7dAgoAt: daysAgo(7) }, NOW,
    )).toBe(true)
  })

  it('accepts an ISO string timestamp (the shape the API row carries)', () => {
    expect(hasRecentReviewSurge(
      { reviewCount: 28, reviewCount7dAgo: 3, reviewCount7dAgoAt: fresh.toISOString() }, NOW,
    )).toBe(true)
  })

  it('returns false for an unparseable timestamp', () => {
    expect(hasRecentReviewSurge(
      { reviewCount: 28, reviewCount7dAgo: 3, reviewCount7dAgoAt: 'not-a-date' }, NOW,
    )).toBe(false)
  })
})
