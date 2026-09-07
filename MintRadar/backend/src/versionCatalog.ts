// Keeps the software_versions DB cache (see db.ts) up to date with each tracked
// mint implementation's latest upstream release, so versionFreshnessScore
// (shared/trustScore.ts) can score freshness against the real current version
// instead of a hand-maintained static list.
import { pool } from './db.js'
import { safeFetch } from './ssrf.js'
import { parseMajorMinorPatch } from './shared/trustScore.js'

interface UpstreamRepo {
  software: string
  apiUrl: string
}

// URLs are hardcoded (not user-supplied), but the fetch still goes through
// safeFetch — connect-time DNS pinning + redirect-hop revalidation against
// private/loopback ranges — as defence-in-depth, matching discovery.ts.
const UPSTREAM_REPOS: UpstreamRepo[] = [
  { software: 'nutshell', apiUrl: 'https://api.github.com/repos/cashubtc/nutshell/releases/latest' },
  { software: 'cdk', apiUrl: 'https://api.github.com/repos/cashubtc/cdk/releases/latest' },
]

// Grace period for version-freshness scoring: a mint isn't penalized for running the
// previous version until this long after the new version's GitHub release. Without
// this, a mint could drop score points the same day a new minor version ships, before
// any operator realistically had a chance to upgrade. 14 days mirrors the kind of
// notice period most self-hosted software projects give users before "outdated"
// warnings kick in — long enough to be fair to operators who upgrade on a normal
// cadence, short enough that a genuinely neglected mint still gets penalized well
// before the next release ships on top of it.
export const VERSION_GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000

interface SoftwareVersionRow {
  software: string
  latest_version: string | null
  previous_version: string | null
  released_at: string | Date | null
}

// Pure decision function — no DB/network access, so it's directly unit-testable.
// For each software row: if the current `latest_version` was released (per GitHub's
// own `published_at`, stored as `released_at`) less than VERSION_GRACE_PERIOD_MS ago,
// AND a `previous_version` exists to fall back to, score mints against that previous
// version instead — i.e. the new release doesn't start affecting anyone's Trust Score
// until the grace period has elapsed. `released_at` null (row predates this migration,
// or was seeded at deploy with no known release date) or no `previous_version` (first
// version ever recorded for that software) both skip the grace period and use
// `latest_version` directly, since there's nothing safe to fall back to.
export function effectiveLatestVersions(
  rows: SoftwareVersionRow[],
  now: Date = new Date()
): Record<string, { major: number; minor: number }> {
  const map: Record<string, { major: number; minor: number }> = {}
  for (const row of rows) {
    if (!row.latest_version) continue
    const withinGrace = row.released_at != null
      && row.previous_version != null
      && now.getTime() - new Date(row.released_at).getTime() < VERSION_GRACE_PERIOD_MS
    const effective = withinGrace ? row.previous_version! : row.latest_version
    const parsed = parseMajorMinorPatch(effective)
    if (parsed) map[row.software] = { major: parsed.major, minor: parsed.minor }
  }
  return map
}

// Fetches each tracked software's latest GitHub release and writes it to
// software_versions. Never throws — a failure for one repo (network error,
// unparseable tag_name) is logged and the DB cache simply keeps its last known
// value; the other repo is still attempted.
export async function fetchLatestUpstreamVersions(): Promise<void> {
  for (const repo of UPSTREAM_REPOS) {
    try {
      const res = await safeFetch(repo.apiUrl, {
        timeoutMs: 10_000,
        headers: { Accept: 'application/vnd.github+json' },
      })
      if (!res || !res.ok) {
        console.error(`[versionCatalog] GitHub API fetch failed${res ? ` (HTTP ${res.status})` : ''} for ${repo.software}`)
        continue
      }
      const data = await res.json() as Record<string, unknown>
      // /releases/latest already excludes prereleases/drafts — verify anyway.
      if (data['prerelease'] === true || data['draft'] === true) {
        console.error(`[versionCatalog] ${repo.software} latest release is prerelease/draft, skipping`)
        continue
      }
      const tagName = data['tag_name']
      if (typeof tagName !== 'string' || !tagName || !parseMajorMinorPatch(tagName)) {
        console.error(`[versionCatalog] ${repo.software} release has an unparseable tag_name:`, tagName)
        continue
      }
      // published_at is GitHub's own release timestamp — used as the grace period's
      // start, so it doesn't matter if this cron run is late or missed a day.
      const publishedAt = data['published_at']
      const releasedAt = typeof publishedAt === 'string' && !Number.isNaN(Date.parse(publishedAt))
        ? publishedAt
        : null
      // previous_version only advances when the tag actually changed since the last
      // fetch — an unchanged latest_version (the common case, most days) must not
      // reset released_at or clobber previous_version, or the grace period would
      // never expire.
      await pool.query(
        `INSERT INTO software_versions (software, latest_version, released_at, previous_version, fetched_at, source_url)
         VALUES ($1, $2, $3, NULL, NOW(), $4)
         ON CONFLICT (software) DO UPDATE
           SET previous_version = CASE
                 WHEN software_versions.latest_version IS DISTINCT FROM EXCLUDED.latest_version
                 THEN software_versions.latest_version
                 ELSE software_versions.previous_version
               END,
               latest_version = EXCLUDED.latest_version,
               released_at = CASE
                 WHEN software_versions.latest_version IS DISTINCT FROM EXCLUDED.latest_version
                 THEN EXCLUDED.released_at
                 ELSE software_versions.released_at
               END,
               fetched_at = EXCLUDED.fetched_at,
               source_url = EXCLUDED.source_url`,
        [repo.software, tagName, releasedAt, repo.apiUrl]
      )
      console.log(`[versionCatalog] updated ${repo.software} latest version -> ${tagName}`)
    } catch (err) {
      console.error(`[versionCatalog] failed to fetch latest version for ${repo.software}:`, err)
    }
  }
}

// Reads the software_versions cache and applies the grace period into the
// { major, minor } map that versionFreshnessScore/computeServerTrustScore expect.
// Never throws — a DB hiccup here just means the caller falls back to the static
// ladders (versionFreshnessScore's own fallback when a software key is missing).
export async function getLatestVersionsMap(): Promise<Record<string, { major: number; minor: number }>> {
  try {
    const res = await pool.query<SoftwareVersionRow>(
      'SELECT software, latest_version, previous_version, released_at FROM software_versions'
    )
    return effectiveLatestVersions(res.rows)
  } catch (err) {
    console.error('[versionCatalog] failed to read software_versions cache:', err)
    return {}
  }
}
