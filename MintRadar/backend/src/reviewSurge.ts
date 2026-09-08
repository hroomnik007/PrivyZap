// "Recent review surge" — a forgery-resistant sybil signal for the Community
// Rating.
//
// Unlike anything derived from the Nostr events themselves (created_at, author
// count, …), which an attacker fully controls, this is based purely on what
// MintRadar's own backend observed: the mint's stored review_count now vs. a
// rolling ~1-week-old snapshot the daily rollup takes (mints.review_count_7d_ago
// / review_count_7d_ago_at — see reviewSurgeRollup.ts). An attacker can flood a
// mint with fake reviews, but they cannot hide the fact that the count jumped.
//
// This flag is INFORMATIONAL ONLY. It never feeds computeTrustScore() or the
// weighted Rating sort — same footing as the Audit disclaimer and the other
// transparency cues. The frontend shows a quiet ⚠ next to the rating.

const DAY_MS = 86_400_000

// Flag when, vs. the ~1-week-ago count, the mint has EITHER gained a large
// absolute number of reviews OR more than doubled from a non-trivial base.
// Tuned so ordinary organic growth (a mint earning a few reviews a week) never
// trips it, only an unusually steep jump.
export const SURGE_ABSOLUTE_GAIN = 10
export const SURGE_RATIO = 2
// The "more than doubled" rule only applies once there's a real prior base —
// 4→9 shouldn't flag, 20→41 should. Below this, only the absolute rule counts.
export const SURGE_RATIO_MIN_BASELINE = 5
// If the snapshot is older than this the daily rollup has been down for a
// week+; treat the comparison as unreliable rather than flag a slow multi-week
// climb as "recent".
export const SURGE_BASELINE_MAX_AGE_MS = 14 * DAY_MS

export interface ReviewSurgeFields {
  reviewCount: number | null
  reviewCount7dAgo: number | null
  reviewCount7dAgoAt: Date | string | null
}

export function hasRecentReviewSurge(m: ReviewSurgeFields, now: Date = new Date()): boolean {
  const { reviewCount, reviewCount7dAgo, reviewCount7dAgoAt } = m
  if (reviewCount == null || reviewCount7dAgo == null || reviewCount7dAgoAt == null) return false

  const at = reviewCount7dAgoAt instanceof Date ? reviewCount7dAgoAt : new Date(reviewCount7dAgoAt)
  if (Number.isNaN(at.getTime())) return false
  if (now.getTime() - at.getTime() > SURGE_BASELINE_MAX_AGE_MS) return false

  const gain = reviewCount - reviewCount7dAgo
  if (gain <= 0) return false
  if (gain >= SURGE_ABSOLUTE_GAIN) return true
  return reviewCount7dAgo >= SURGE_RATIO_MIN_BASELINE && reviewCount >= reviewCount7dAgo * SURGE_RATIO
}
