import { Pool } from 'pg'

export const pool = new Pool({
  connectionString: process.env['DATABASE_URL'],
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
})

export async function initDb(): Promise<void> {
  // Core tables — single batch (ordered by dependency)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mints (
      url TEXT PRIMARY KEY,
      name TEXT,
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_known BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS mint_history (
      id BIGSERIAL PRIMARY KEY,
      url TEXT NOT NULL REFERENCES mints(url) ON DELETE CASCADE,
      online BOOLEAN NOT NULL,
      latency_ms INTEGER,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_mint_history_url_checked
      ON mint_history(url, checked_at DESC);

    CREATE TABLE IF NOT EXISTS mint_version_history (
      id BIGSERIAL PRIMARY KEY,
      url TEXT NOT NULL REFERENCES mints(url) ON DELETE CASCADE,
      version TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mint_version_history_url_version
      ON mint_version_history(url, version);

    CREATE INDEX IF NOT EXISTS idx_mint_version_history_url_date
      ON mint_version_history(url, first_seen_at DESC);

    CREATE INDEX IF NOT EXISTS idx_mints_trust_score
      ON mints(last_trust_score DESC NULLS LAST);

    CREATE TABLE IF NOT EXISTS software_versions (
      software TEXT PRIMARY KEY,
      latest_version TEXT,
      fetched_at TIMESTAMPTZ,
      source_url TEXT
    );

    CREATE TABLE IF NOT EXISTS notification_subscriptions (
      pubkey TEXT NOT NULL,
      mint_url TEXT NOT NULL REFERENCES mints(url) ON DELETE CASCADE,
      notify_on_down BOOLEAN NOT NULL DEFAULT true,
      notify_on_up BOOLEAN NOT NULL DEFAULT true,
      relays TEXT[] NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (pubkey, mint_url)
    );

    CREATE INDEX IF NOT EXISTS idx_notification_subs_updated_at
      ON notification_subscriptions(updated_at);

    CREATE TABLE IF NOT EXISTS mint_reviews (
      url TEXT NOT NULL REFERENCES mints(url) ON DELETE CASCADE,
      pubkey TEXT NOT NULL,
      event_id TEXT NOT NULL,
      rating INTEGER,
      comment TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL,
      PRIMARY KEY (url, pubkey)
    );

    CREATE INDEX IF NOT EXISTS idx_mint_reviews_url_created
      ON mint_reviews(url, created_at DESC);
  `)

  // Column migrations — each in its own query so a failure in one doesn't block others
  const migrations = [
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS icon_url TEXT',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS version TEXT',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS nut_count INTEGER',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS tos_url TEXT',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS description_long TEXT',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS nuts_limits JSONB',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS audit_n_mints INTEGER',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS audit_n_melts INTEGER',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS audit_n_errors INTEGER',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS audit_checked_at TIMESTAMPTZ',
    // audit_checked_at mirrors audit.8333.space's own `updated_at`; audit_synced_at
    // is when OUR 6h discovery cron last wrote these columns, so the Mint Detail
    // "Last checked X ago" strip can be truthful about our refresh cadence.
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS audit_synced_at TIMESTAMPTZ',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS audit_id INTEGER',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS audit_recent_total INTEGER',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS audit_recent_errors INTEGER',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS last_trust_score INTEGER',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS last_error TEXT',
    // Recurring-revalidation markers (prober.ts revalidateMints()): `invalid_since`
    // is set the first time a mint is found REACHABLE-but-not-a-Cashu-mint (a URL
    // repointed via DNS/redirect after it first passed the submit/discovery gate)
    // and cleared whenever it validates again; a mint whose `invalid_since` is
    // older than REVALIDATION_REAP_DAYS is deleted so the 5-min probe stops
    // hammering an attacker-chosen host forever. `revalidated_at` is the last time
    // the daily strong (/v1/info + /v1/keys) check ran for this mint.
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS invalid_since TIMESTAMPTZ',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS revalidated_at TIMESTAMPTZ',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS server_location TEXT',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS units JSONB',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS mint_methods JSONB',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS melt_methods JSONB',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS contact_count INTEGER',
    'ALTER TABLE mint_history ADD COLUMN IF NOT EXISTS trust_score INTEGER',
    // Trust Score Movers rollup — mints.last_trust_score already holds the "latest"
    // snapshot (written by every probe); these two hold the point-in-time score
    // 7d / 30d ago, refreshed by refreshTrustMoversRollup() on the probe cron so
    // GET /api/stats/trust-movers is a plain read of `mints` instead of two
    // DISTINCT ON passes over all of mint_history. Same pattern as review_count.
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS trust_score_7d_ago INTEGER',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS trust_score_30d_ago INTEGER',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS trust_movers_checked_at TIMESTAMPTZ',
    // Partial index covering the `trust_score IS NOT NULL` filter that the rollup's
    // per-mint "score at-or-before cutoff" lookups use — without it those lookups
    // fall back to scanning idx_mint_history_url_checked + heap-fetching every row.
    `CREATE INDEX IF NOT EXISTS idx_mint_history_score_checked
       ON mint_history(url, checked_at DESC) WHERE trust_score IS NOT NULL`,
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS review_count INTEGER',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS review_avg_rating REAL',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS reviews_checked_at TIMESTAMPTZ',
    // Rolling ~1-week-ago review_count snapshot — feeds the "recent review surge"
    // sybil flag (reviewSurge.ts / reviewSurgeRollup.ts). Advanced once a day.
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS review_count_7d_ago INTEGER',
    'ALTER TABLE mints ADD COLUMN IF NOT EXISTS review_count_7d_ago_at TIMESTAMPTZ',
    'ALTER TABLE notification_subscriptions ADD COLUMN IF NOT EXISTS last_notified_down_at TIMESTAMPTZ',
    'ALTER TABLE notification_subscriptions ADD COLUMN IF NOT EXISTS last_notified_up_at TIMESTAMPTZ',
    // Version freshness grace period (see versionCatalog.ts's effectiveLatestVersions()):
    // released_at is GitHub's own published_at for latest_version, so grace periods are
    // measured from the real upstream release date, not from whenever our daily cron
    // happened to notice it. previous_version is the latest_version this row held right
    // before the current one — the rung a mint compares against while still in grace.
    'ALTER TABLE software_versions ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ',
    'ALTER TABLE software_versions ADD COLUMN IF NOT EXISTS previous_version TEXT',
  ]

  for (const sql of migrations) {
    await pool.query(sql)
  }

  // Seed software_versions so scoring works identically right after deploy, even
  // before fetchLatestUpstreamVersions' daily cron job has run for the first time.
  // Values mirror STATIC_LATEST_VERSIONS in shared/trustScore.ts (major.minor must
  // stay in sync — the exact patch here doesn't affect scoring). ON CONFLICT DO
  // NOTHING makes this a no-op after the first run, once the cron job owns the row.
  await pool.query(`
    INSERT INTO software_versions (software, latest_version, fetched_at, source_url)
    VALUES
      ('nutshell', '0.20.3', NOW(), NULL),
      ('cdk', '0.17.5', NOW(), NULL)
    ON CONFLICT (software) DO NOTHING
  `)
}

// 30-day retention: a subscription not touched (created/updated) in 30 days
// is dropped. Returns the deleted row count for cron logging.
export async function pruneOldNotificationSubscriptions(): Promise<number> {
  const result = await pool.query(
    `DELETE FROM notification_subscriptions WHERE updated_at < now() - interval '30 days'`
  )
  return result.rowCount ?? 0
}
