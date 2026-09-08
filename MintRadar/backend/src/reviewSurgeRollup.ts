import { pool } from './db.js'

// Advances the rolling review-count baseline (mints.review_count_7d_ago /
// review_count_7d_ago_at) that hasRecentReviewSurge() compares against — see
// reviewSurge.ts. Runs once a day (cron.ts).
//
// Approach (b) from the sybil-rating analysis: a single sliding snapshot column,
// not a full mint_review_count_history table. The flag only needs to answer
// "did the count jump sharply in roughly the last week", not reconstruct a time
// series — one integer comparison does that. It also mirrors the existing
// trust_score_7d_ago rollup exactly (same "N-days-ago snapshot on mints" shape,
// same daily cron slot, refreshTrustMoversRollup), so there's no new table,
// retention/pruning logic, or extra cost on the hot /api/mints/known path — just
// one more column already loaded by that query.
//
// A snapshot is (re)taken only when it's missing or already ≥7 days old, so the
// baseline is always a genuine ~1-week-ago figure that rolls forward once a
// week. Mints whose review_count is still NULL (the 6h reviews sync hasn't run
// for them yet) are skipped, so the first real sync never looks like a surge.

let running = false

export function isReviewSurgeRollupRunning(): boolean {
  return running
}

// Single-flight; never throws — a failed run just leaves the previous snapshot
// in place, and the flag reads false-safe on a stale (>14d) snapshot anyway.
export async function refreshReviewSurgeBaseline(): Promise<void> {
  if (running) {
    console.warn('[review-surge-rollup] already running — skipping overlapping run')
    return
  }
  running = true
  const started = Date.now()
  try {
    const result = await pool.query(`
      UPDATE mints
         SET review_count_7d_ago = review_count,
             review_count_7d_ago_at = NOW()
       WHERE review_count IS NOT NULL
         AND (review_count_7d_ago_at IS NULL
              OR review_count_7d_ago_at <= NOW() - INTERVAL '7 days')
    `)
    console.log(
      `[review-surge-rollup] advanced baseline for ${result.rowCount ?? 0} mint(s) in ${Date.now() - started}ms`,
    )
  } catch (err) {
    console.error('[review-surge-rollup] failed:', err instanceof Error ? err.message : err)
  } finally {
    running = false
  }
}
