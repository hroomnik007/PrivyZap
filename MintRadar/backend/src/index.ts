import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import { pool, initDb } from './db.js'
import { isSafeUrl, checkWsUrlSafety, safeFetch } from './ssrf.js'
import { upsertMint, probeMintToDb, isValidCashuMint, parseMintMethods, type MintMethodEntry } from './prober.js'
import { getLatestVersionsMap } from './versionCatalog.js'
import { splitVersionString, canonicalSoftwareName } from './shared/trustScore.js'
import { seedKnownMints, startCron } from './cron.js'
import { publishServiceProfile } from './nostrService.js'
import { normalizeUrl } from './discovery.js'
import { computeDegraded } from './degraded.js'
import { authenticateNip98 } from './nip98Auth.js'
import { fetchOgMintData, renderMintOgHtml } from './og.js'
import { getMintIcon } from './mintIcon.js'
import { computeTrustMovers, type MintScoreSnapshot } from './trustMovers.js'
import { globalMeanRating, weightedRating } from './weightedRating.js'
import { isTestMint } from './testMints.js'

let knownMintsCache: { data: unknown; expiresAt: number } | null = null
const KNOWN_MINTS_CACHE_TTL = 60_000 // 60 seconds

const trustMoversCache = new Map<string, { data: unknown; expiresAt: number }>()
// Longer than KNOWN_MINTS_CACHE_TTL: the underlying snapshots only move once per
// probe cycle (5 min, refreshTrustMoversRollup on the probe cron), and a 7d/30d
// delta barely shifts between cycles — no reason to recompute per-minute.
const TRUST_MOVERS_CACHE_TTL = 10 * 60_000 // 10 minutes

// Re-exported for backend/src/__tests__/nostrReviewsRelays.test.ts (a drift
// tripwire that pins the exact array). The list itself now lives in
// reviewsSync.ts, which owns the only remaining server-side relay fetch of
// kind:38000 reviews (the 6h background sync). GET /api/mints/nostr-reviews no
// longer touches a relay — it serves the DB rows that sync populates.
export { REVIEW_SYNC_RELAYS as NOSTR_REVIEWS_RELAYS } from './reviewsSync.js'

const REQUIRED_ENV_VARS = ['DATABASE_URL', 'ALLOWED_ORIGINS'] as const
const missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v])
if (missingVars.length > 0) {
  for (const v of missingVars) console.error(`ERROR: Missing required environment variable: ${v}`)
  process.exit(1)
}
console.log('ENV OK')

const PORT = parseInt(process.env['PORT'] ?? '3002', 10)
const IS_DEV = process.env['NODE_ENV'] !== 'production'

// In production the fallback never includes localhost — only the live origin.
// Dev fallback includes the Vite dev server. Override via ALLOWED_ORIGINS env.
const DEFAULT_ORIGINS = IS_DEV
  ? 'https://mintradar.pedani.eu,http://localhost:5173'
  : 'https://mintradar.pedani.eu'

const ALLOWED_ORIGINS = (
  process.env['ALLOWED_ORIGINS'] ?? DEFAULT_ORIGINS
).split(',').map(o => o.trim())

const MAX_URL_LENGTH = 500
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 60

// ── Types ──────────────────────────────────────────────────────

interface RateLimitEntry {
  count: number
  resetAt: number
}

interface MintInfo {
  name: string
  version?: string
  description?: string
  description_long?: string
  tos_url?: string
  nuts: Record<string, unknown>
}

interface MintKeyset {
  id: string
  unit: string
  active: boolean
}

interface MintStatus {
  url: string
  online: boolean
  latencyMs: number | null
  info: MintInfo | null
  keysets: MintKeyset[] | null
  checkedAt: string
  error?: string
  units: string[] | null
  mintMethods: MintMethodEntry[] | null
  meltMethods: MintMethodEntry[] | null
}

// ── Rate limiter ───────────────────────────────────────────────

const rateLimitStore = new Map<string, RateLimitEntry>()

function checkRateLimit(ip: string): { allowed: boolean; remaining: number; limit: number } {
  const now = Date.now()
  const entry = rateLimitStore.get(ip)

  if (entry === undefined || now >= entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, limit: RATE_LIMIT_MAX }
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, limit: RATE_LIMIT_MAX }
  }

  entry.count++
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count, limit: RATE_LIMIT_MAX }
}

// Prevent unbounded memory growth
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateLimitStore) {
    if (now >= entry.resetAt) rateLimitStore.delete(ip)
  }
}, RATE_LIMIT_WINDOW_MS)

// ── Mint probe ─────────────────────────────────────────────────

// On-demand single-mint probe (GET /api/mint/probe) — matches the cron
// prober's PROBE_TIMEOUT_MS (prober.ts) so a hanging mint fails at the same
// ceiling everywhere, and stays comfortably under the frontend's own
// AbortSignal.timeout(15000) around this endpoint (src/core/mint/api.ts).
const ON_DEMAND_PROBE_TIMEOUT_MS = 10_000

async function probeMint(url: string): Promise<MintStatus> {
  const start = Date.now()

  // safeFetch validates the URL and every redirect hop against isSafeUrl()
  // and pins DNS at connect time (SSRF + rebinding protection).
  const [infoRes, keysetsRes] = await Promise.all([
    safeFetch(`${url}/v1/info`, { timeoutMs: ON_DEMAND_PROBE_TIMEOUT_MS }),
    safeFetch(`${url}/v1/keysets`, { timeoutMs: ON_DEMAND_PROBE_TIMEOUT_MS }),
  ])

  const latencyMs = Date.now() - start

  let info: MintInfo | null = null
  let online = false

  if (infoRes && infoRes.ok) {
    try {
      const raw: unknown = await infoRes.json()
      if (typeof raw === 'object' && raw !== null && 'nuts' in raw) {
        info = raw as MintInfo
        online = true
      }
    } catch { /* invalid JSON — treat as offline */ }
  } else if (IS_DEV) {
    console.error('[probeMint] info fetch failed or blocked:', url)
  }

  let keysets: MintKeyset[] | null = null

  if (keysetsRes && keysetsRes.ok) {
    try {
      const raw: unknown = await keysetsRes.json()
      if (
        typeof raw === 'object' &&
        raw !== null &&
        'keysets' in raw &&
        Array.isArray((raw as { keysets: unknown }).keysets)
      ) {
        keysets = (raw as { keysets: MintKeyset[] }).keysets
      }
    } catch { /* invalid JSON — skip keysets */ }
  }

  const { units, mintMethods, meltMethods } = parseMintMethods(info?.nuts ?? null)

  const status: MintStatus = {
    url,
    online,
    latencyMs: online ? latencyMs : null,
    info,
    keysets,
    checkedAt: new Date().toISOString(),
    units,
    mintMethods,
    meltMethods,
  }

  if (!online) {
    status.error = 'Mint unreachable'
  }

  return status
}

// ── App ────────────────────────────────────────────────────────

export const app = express()

app.set('trust proxy', 1)

// Security headers
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-XSS-Protection', '0')
  next()
})

// CORS
app.use(cors({
  origin: (origin, callback) => {
    if (origin === undefined || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  methods: ['GET', 'POST'],
}))

app.use(express.json())

// Rate limiting — exempt public read-only endpoints that sit behind Cache-Control
const RATE_LIMIT_EXEMPT = new Set(['/health', '/api/mints/known', '/api/stats', '/api/mint/icon'])

// Stricter limiters for write endpoints that trigger outbound fetches /
// DNS resolution. Each submit performs 2+ outbound probes; each discovered
// URL performs a DNS lookup — so these are kept deliberately low to prevent
// the server being abused as an SSRF/DNS-amplification proxy.
const HOUR_MS = 60 * 60 * 1000

// Submit: 20 req/IP/hour (each triggers probeMint + probeMintToDb).
const submitRateLimitStore = new Map<string, RateLimitEntry>()
const SUBMIT_RATE_LIMIT_MAX = 20

// Discover: 10 req/IP/hour (each accepts a batch of up to MAX_DISCOVER_BATCH).
const discoverRateLimitStore = new Map<string, RateLimitEntry>()
const DISCOVER_RATE_LIMIT_MAX = 10

// Notifications subscribe/unsubscribe: 30 req/pubkey/hour each. Keyed on the
// NIP-98-authenticated pubkey rather than IP — these routes require auth, so
// the pubkey is the meaningful identity to throttle (an IP-based limit would
// let one attacker-controlled IP exhaust the budget of many pubkeys, or one
// pubkey rotate through many IPs to bypass it).
const notifySubscribeRateLimitStore = new Map<string, RateLimitEntry>()
const notifyUnsubscribeRateLimitStore = new Map<string, RateLimitEntry>()
const NOTIFY_RATE_LIMIT_MAX = 30

function checkWindowedLimit(store: Map<string, RateLimitEntry>, max: number, key: string): boolean {
  const now = Date.now()
  const entry = store.get(key)
  if (entry === undefined || now >= entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + HOUR_MS })
    return true
  }
  if (entry.count >= max) return false
  entry.count++
  return true
}

function checkSubmitRateLimit(ip: string): boolean {
  return checkWindowedLimit(submitRateLimitStore, SUBMIT_RATE_LIMIT_MAX, ip)
}

function checkDiscoverRateLimit(ip: string): boolean {
  return checkWindowedLimit(discoverRateLimitStore, DISCOVER_RATE_LIMIT_MAX, ip)
}

function checkNotifySubscribeRateLimit(pubkey: string): boolean {
  return checkWindowedLimit(notifySubscribeRateLimitStore, NOTIFY_RATE_LIMIT_MAX, pubkey)
}

function checkNotifyUnsubscribeRateLimit(pubkey: string): boolean {
  return checkWindowedLimit(notifyUnsubscribeRateLimitStore, NOTIFY_RATE_LIMIT_MAX, pubkey)
}

setInterval(() => {
  const now = Date.now()
  for (const store of [submitRateLimitStore, discoverRateLimitStore, notifySubscribeRateLimitStore, notifyUnsubscribeRateLimitStore]) {
    for (const [key, entry] of store) {
      if (now >= entry.resetAt) store.delete(key)
    }
  }
}, HOUR_MS)

app.use((req: Request, res: Response, next: NextFunction) => {
  if (RATE_LIMIT_EXEMPT.has(req.path)) {
    next()
    return
  }
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
  const { allowed, remaining, limit } = checkRateLimit(ip)
  res.setHeader('X-RateLimit-Limit', String(limit))
  res.setHeader('X-RateLimit-Remaining', String(remaining))
  if (!allowed) {
    res.status(429).json({ error: 'Too many requests' })
    return
  }
  next()
})

// ── Routes ─────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.get('/api/mint/probe', (req: Request, res: Response): void => {
  const url = req.query['url']

  if (typeof url !== 'string' || url.length === 0) {
    res.status(400).json({ error: 'Missing required query parameter: url' })
    return
  }

  if (!url.startsWith('https://')) {
    res.status(400).json({ error: 'url must start with https://' })
    return
  }

  if (url.length > MAX_URL_LENGTH) {
    res.status(400).json({ error: `url exceeds maximum length of ${MAX_URL_LENGTH} characters` })
    return
  }

  probeMint(url)
    .then(status => { res.json(status) })
    .catch((err: unknown) => {
      if (IS_DEV) console.error('[/api/mint/probe] unexpected error:', err)
      res.json({
        url,
        online: false,
        latencyMs: null,
        info: null,
        keysets: null,
        checkedAt: new Date().toISOString(),
        error: 'Mint unreachable',
      })
    })
})

// ── Routes: mint history & known ──────────────────────────────

app.get('/api/mints/history', (req: Request, res: Response): void => {
  const url = req.query['url']

  if (typeof url !== 'string' || url.length === 0) {
    res.status(400).json({ error: 'Missing required query parameter: url' })
    return
  }

  if (!url.startsWith('https://')) {
    res.status(400).json({ error: 'url must start with https://' })
    return
  }

  if (url.length > MAX_URL_LENGTH) {
    res.status(400).json({ error: `url exceeds maximum length of ${MAX_URL_LENGTH} characters` })
    return
  }

  const periodParam = req.query['period']
  // Support legacy `days` param for backward compat
  const daysParam = req.query['days']
  let period: '24h' | '7d' | '30d' | '90d'
  if (periodParam === '7d') period = '7d'
  else if (periodParam === '30d') period = '30d'
  else if (periodParam === '90d') period = '90d'
  else if (daysParam === '7') period = '7d'
  else period = '24h'

  const PERIOD_DAYS: Record<typeof period, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }
  // Matches each branch's prevQuery window start below (24h→48h ago, 7d→14d ago, 30d→60d ago, 90d→180d ago).
  const PREV_WINDOW_START_HOURS: Record<typeof period, number> = { '24h': 48, '7d': 336, '30d': 1440, '90d': 4320 }

  isSafeUrl(url)
    .then(safe => {
      if (!safe) {
        res.status(400).json({ error: 'Invalid url' })
        return
      }

      // Each period returns N segments + prev period uptime for trend.
      // 24h → 24 hourly buckets, prev 24h for trend
      // 7d  → 7 daily buckets, prev 7d for trend
      // 30d → 30 daily buckets, prev 30d for trend
      let segmentsQuery: string
      let prevQuery: string

      if (period === '24h') {
        segmentsQuery = `
          SELECT
            (DATE_TRUNC('hour', checked_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS bucket,
            BOOL_OR(online) AS online,
            ROUND(AVG(CASE WHEN online THEN latency_ms END))::int AS latency_ms,
            COUNT(*) AS total,
            SUM(CASE WHEN online THEN 1 ELSE 0 END) AS online_count,
            ROUND(AVG(trust_score))::int AS trust_score
          FROM mint_history
          WHERE url = $1
            AND checked_at >= NOW() - INTERVAL '24 hours'
            AND checked_at < NOW()
          GROUP BY DATE_TRUNC('hour', checked_at AT TIME ZONE 'UTC')
          ORDER BY DATE_TRUNC('hour', checked_at AT TIME ZONE 'UTC') ASC`
        prevQuery = `
          SELECT
            SUM(CASE WHEN online THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) AS uptime_ratio,
            ROUND(AVG(CASE WHEN online THEN latency_ms END))::int AS avg_latency_ms
          FROM mint_history
          WHERE url = $1
            AND checked_at >= NOW() - INTERVAL '48 hours'
            AND checked_at < NOW() - INTERVAL '24 hours'`
      } else if (period === '7d') {
        segmentsQuery = `
          SELECT
            (DATE_TRUNC('day', checked_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS bucket,
            BOOL_OR(online) AS online,
            ROUND(AVG(CASE WHEN online THEN latency_ms END))::int AS latency_ms,
            COUNT(*) AS total,
            SUM(CASE WHEN online THEN 1 ELSE 0 END) AS online_count,
            ROUND(AVG(trust_score))::int AS trust_score
          FROM mint_history
          WHERE url = $1
            AND checked_at >= NOW() - INTERVAL '7 days'
            AND checked_at < NOW()
          GROUP BY DATE_TRUNC('day', checked_at AT TIME ZONE 'UTC')
          ORDER BY DATE_TRUNC('day', checked_at AT TIME ZONE 'UTC') ASC`
        prevQuery = `
          SELECT
            SUM(CASE WHEN online THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) AS uptime_ratio,
            ROUND(AVG(CASE WHEN online THEN latency_ms END))::int AS avg_latency_ms
          FROM mint_history
          WHERE url = $1
            AND checked_at >= NOW() - INTERVAL '14 days'
            AND checked_at < NOW() - INTERVAL '7 days'`
      } else if (period === '30d') {
        segmentsQuery = `
          SELECT
            (DATE_TRUNC('day', checked_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS bucket,
            BOOL_OR(online) AS online,
            ROUND(AVG(CASE WHEN online THEN latency_ms END))::int AS latency_ms,
            COUNT(*) AS total,
            SUM(CASE WHEN online THEN 1 ELSE 0 END) AS online_count,
            ROUND(AVG(trust_score))::int AS trust_score
          FROM mint_history
          WHERE url = $1
            AND checked_at >= NOW() - INTERVAL '30 days'
            AND checked_at < NOW()
          GROUP BY DATE_TRUNC('day', checked_at AT TIME ZONE 'UTC')
          ORDER BY DATE_TRUNC('day', checked_at AT TIME ZONE 'UTC') ASC`
        prevQuery = `
          SELECT
            SUM(CASE WHEN online THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) AS uptime_ratio,
            ROUND(AVG(CASE WHEN online THEN latency_ms END))::int AS avg_latency_ms
          FROM mint_history
          WHERE url = $1
            AND checked_at >= NOW() - INTERVAL '60 days'
            AND checked_at < NOW() - INTERVAL '30 days'`
      } else {
        // 90d — weekly buckets
        segmentsQuery = `
          SELECT
            (DATE_TRUNC('week', checked_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS bucket,
            BOOL_OR(online) AS online,
            ROUND(AVG(CASE WHEN online THEN latency_ms END))::int AS latency_ms,
            COUNT(*) AS total,
            SUM(CASE WHEN online THEN 1 ELSE 0 END) AS online_count,
            ROUND(AVG(trust_score))::int AS trust_score
          FROM mint_history
          WHERE url = $1
            AND checked_at >= NOW() - INTERVAL '90 days'
            AND checked_at < NOW()
          GROUP BY DATE_TRUNC('week', checked_at AT TIME ZONE 'UTC')
          ORDER BY DATE_TRUNC('week', checked_at AT TIME ZONE 'UTC') ASC`
        prevQuery = `
          SELECT
            SUM(CASE WHEN online THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) AS uptime_ratio,
            ROUND(AVG(CASE WHEN online THEN latency_ms END))::int AS avg_latency_ms
          FROM mint_history
          WHERE url = $1
            AND checked_at >= NOW() - INTERVAL '180 days'
            AND checked_at < NOW() - INTERVAL '90 days'`
      }

      return Promise.all([
        pool.query(segmentsQuery, [url]),
        pool.query(prevQuery, [url]),
        pool.query('SELECT MIN(checked_at) AS earliest FROM mint_history WHERE url = $1', [url]),
      ]).then(([segResult, prevResult, earliestResult]) => {
        const segments = segResult.rows.map(r => ({
          bucket: (r.bucket as Date).toISOString(),
          online: r.online as boolean,
          latencyMs: r.latency_ms as number | null,
          total: Number(r.total),
          onlineCount: Number(r.online_count),
          uptimePct: Number(r.total) === 0 ? null
            : Math.round(Number(r.online_count) / Number(r.total) * 100),
          trustScore: r.trust_score != null ? Number(r.trust_score) : null,
        }))
        const prevRow = prevResult.rows[0]
        const prevUptimePct = prevRow?.uptime_ratio != null
          ? Math.round(Number(prevRow.uptime_ratio) * 100)
          : null
        const prevAvgLatencyMs = prevRow?.avg_latency_ms != null
          ? Number(prevRow.avg_latency_ms)
          : null

        const earliestRaw = earliestResult.rows[0]?.earliest as Date | null
        const earliestCheckedAt = earliestRaw ? earliestRaw.toISOString() : null
        const periodDays = PERIOD_DAYS[period]
        const daysOfDataAvailable = earliestRaw
          ? Math.min(periodDays, Math.max(0, Math.floor((Date.now() - earliestRaw.getTime()) / 86_400_000)))
          : 0
        const prevPeriodInsufficientHistory = earliestRaw === null
          || earliestRaw.getTime() > (Date.now() - PREV_WINDOW_START_HOURS[period] * 3_600_000)

        // Compute overall stats for the period
        const totalChecks = segments.reduce((s, r) => s + r.total, 0)
        const totalOnline = segments.reduce((s, r) => s + r.onlineCount, 0)
        const uptimePct = totalChecks === 0 ? null : Math.round(totalOnline / totalChecks * 100)
        const latencies = segments.filter(r => r.latencyMs !== null).map(r => r.latencyMs as number)
        const avgLatencyMs = latencies.length === 0 ? null
          : Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)

        res.json({
          url,
          period,
          segments,
          uptimePct,
          avgLatencyMs,
          prevUptimePct,
          prevAvgLatencyMs,
          earliestCheckedAt,
          daysOfDataAvailable,
          periodDays,
          prevPeriodInsufficientHistory,
          // Legacy field for backward compat
          history: segResult.rows.map(r => ({
            online: r.online as boolean,
            latencyMs: r.latency_ms as number | null,
            checkedAt: (r.bucket as Date).toISOString(),
          })),
        })
      })
    })
    .catch((err: unknown) => {
      if (IS_DEV) console.error('[/api/mints/history]', err)
      res.status(500).json({ error: 'Internal server error' })
    })
})

app.get('/api/mints/version-history', (req: Request, res: Response): void => {
  const url = req.query['url']

  if (typeof url !== 'string' || url.length === 0) {
    res.status(400).json({ error: 'Missing required query parameter: url' })
    return
  }

  if (!url.startsWith('https://')) {
    res.status(400).json({ error: 'url must start with https://' })
    return
  }

  if (url.length > MAX_URL_LENGTH) {
    res.status(400).json({ error: `url exceeds maximum length of ${MAX_URL_LENGTH} characters` })
    return
  }

  isSafeUrl(url)
    .then(safe => {
      if (!safe) {
        res.status(400).json({ error: 'Invalid url' })
        return
      }
      // latestGlobalVersion must be scoped to THIS mint's own software family —
      // comparing a cdk-mintd mint's version against, say, Nutshell's highest
      // known version (previously a plain `SELECT DISTINCT version FROM
      // mint_version_history` + versionGt() across every software in the DB)
      // is meaningless, since the two projects have independent numbering.
      // The GitHub-backed software_versions cache (versionCatalog.ts, also
      // the source for the Trust Score's version component) is used here
      // instead of scanning mint_version_history for the network-wide max:
      // it reflects the real current upstream release rather than "the
      // highest version any tracked mint happens to have already adopted"
      // (which can only ever lag behind, understating how outdated a mint
      // really is), and it comes with the same 14-day grace period already
      // applied — so this badge and the Trust Score version component never
      // disagree about what counts as "latest" for a given software.
      return Promise.all([
        pool.query(
          `SELECT version, first_seen_at FROM mint_version_history
           WHERE url = $1 ORDER BY first_seen_at DESC LIMIT 50`,
          [url]
        ),
        pool.query<{ version: string | null }>('SELECT version FROM mints WHERE url = $1', [url]),
        getLatestVersionsMap(),
      ]).then(([result, mintResult, latestVersions]) => {
        const mintVersion = mintResult.rows[0]?.version ?? null
        const canonical = mintVersion != null ? canonicalSoftwareName(splitVersionString(mintVersion).software) : null
        const latest = canonical != null ? latestVersions[canonical] : undefined
        const latestGlobalVersion = latest ? `${canonical}/${latest.major}.${latest.minor}` : null
        res.json({
          url,
          history: result.rows.map(r => ({
            version: r.version as string,
            firstSeenAt: (r.first_seen_at as Date).toISOString(),
          })),
          latestGlobalVersion,
        })
      })
    })
    .catch((err: unknown) => {
      if (IS_DEV) console.error('[/api/mints/version-history]', err)
      res.status(500).json({ error: 'Internal server error' })
    })
})

app.get('/api/nuts', (_req: Request, res: Response): void => {
  pool.query(`
    SELECT m.url, m.name, m.nuts_limits
    FROM mints m
    JOIN LATERAL (
      SELECT online FROM mint_history
      WHERE url = m.url ORDER BY checked_at DESC, id DESC LIMIT 1
    ) latest ON true
    WHERE latest.online = true AND m.nuts_limits IS NOT NULL
  `)
    .then(result => {
      type Row = { url: string; name: string | null; nuts_limits: Record<string, unknown> }
      const rows = result.rows as Row[]
      const NUT_KEYS = ['4','5','7','8','9','10','11','12','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29','30']
      const total = rows.length
      const nuts = NUT_KEYS.map(key => ({
        nut: `NUT-${key.padStart(2, '0')}`,
        percent: total > 0
          ? Math.round(rows.filter(r => r.nuts_limits[key] != null).length / total * 100)
          : 0,
        mints: rows.filter(r => r.nuts_limits[key] != null).map(r => r.url),
      }))
      res.json(nuts)
    })
    .catch((err: unknown) => {
      if (IS_DEV) console.error('[/api/nuts]', err)
      res.status(500).json({ error: 'Internal server error' })
    })
})

app.get('/api/stats', (_req: Request, res: Response): void => {
  Promise.all([
    pool.query(`
      SELECT m.url, m.name, m.last_trust_score, m.nuts_limits,
        latest.online AS online, latest.latency_ms
      FROM mints m
      LEFT JOIN LATERAL (
        SELECT online, latency_ms FROM mint_history
        WHERE url = m.url ORDER BY checked_at DESC, id DESC LIMIT 1
      ) latest ON true
    `),
    pool.query(`
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms)::int AS avg_latency
      FROM mint_history
      WHERE online = true
        AND checked_at > NOW() - INTERVAL '24 hours'
        AND latency_ms IS NOT NULL
        AND latency_ms > 0
        AND latency_ms < 10000
    `),
  ])
    .then(([mintsResult, latencyResult]) => {
      type MintRow = { url: string; name: string | null; last_trust_score: number | null; nuts_limits: Record<string, unknown> | null; online: boolean | null; latency_ms: number | null }
      const rows = mintsResult.rows as MintRow[]
      const online = rows.filter(r => r.online === true)
      const offline = rows.filter(r => r.online === false)
      const onlineTrustScores = online.map(r => r.last_trust_score ?? 0)
      const avgTrustScore = onlineTrustScores.length > 0
        ? Math.round(onlineTrustScores.reduce((a, b) => a + b) / onlineTrustScores.length)
        : null
      const avgLatency24h = latencyResult.rows[0]?.avg_latency as number | null ?? null
      const low = onlineTrustScores.filter(s => s < 40).length
      const moderate = onlineTrustScores.filter(s => s >= 40 && s < 70).length
      const high = onlineTrustScores.filter(s => s >= 70).length
      // Matches ALL_NUTS in MintDetail — mandatory baseline NUTs (1,2,3,6) are never
      // returned in /v1/info nuts object, so they cannot be tracked here.
      const NUT_KEYS = ['4','5','7','8','9','10','11','12','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29','30']
      const onlineWithNuts = online.filter(r => r.nuts_limits != null)
      const totalForAdoption = onlineWithNuts.length
      const nutAdoption = NUT_KEYS.map(key => ({
        nut: `NUT-${key.padStart(2, '0')}`,
        count: onlineWithNuts.filter(r => r.nuts_limits && r.nuts_limits[key] != null).length,
        percent: totalForAdoption > 0
          ? Math.round(onlineWithNuts.filter(r => r.nuts_limits && r.nuts_limits[key] != null).length / totalForAdoption * 100)
          : 0,
      }))
      const top5 = [...rows]
        .filter(r => r.last_trust_score != null)
        // Known dev/test-only mints are excluded from this "best of" list —
        // still fully visible/probed elsewhere, just not proactively recommended.
        .filter(r => !isTestMint(r.url as string))
        .sort((a, b) => (b.last_trust_score as number) - (a.last_trust_score as number))
        .slice(0, 5)
        .map(r => ({ url: r.url, name: r.name, trustScore: r.last_trust_score as number }))
      res.json({ totalMints: rows.length, onlineMints: online.length, offlineMints: offline.length, avgTrustScore, avgLatency24h, trustDistribution: { low, moderate, high }, nutAdoption, top5ByTrustScore: top5 })
    })
    .catch((err: unknown) => {
      if (IS_DEV) console.error('[/api/stats]', err)
      res.status(500).json({ error: 'Internal server error' })
    })
})

app.get('/api/stats/trust-trend', (req: Request, res: Response): void => {
  const daysParam = parseInt(String(req.query['days'] ?? '30'), 10)
  const days = [30, 90].includes(daysParam) ? daysParam : 30
  Promise.all([
    pool.query(
      `SELECT
         (DATE_TRUNC('day', checked_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date AS date,
         ROUND(AVG(trust_score))::int AS avg_trust
       FROM mint_history
       WHERE trust_score IS NOT NULL
         AND online = true
         AND checked_at > NOW() - INTERVAL '1 day' * $1
       GROUP BY DATE_TRUNC('day', checked_at AT TIME ZONE 'UTC')
       ORDER BY 1 ASC`,
      [days]
    ),
    // Network-wide oldest probe, unbounded — used to tell the frontend when
    // the selected window (e.g. 90d) exceeds what's actually been collected.
    pool.query('SELECT MIN(checked_at) AS earliest FROM mint_history'),
  ])
    .then(([result, earliestResult]) => {
      const earliestRaw = earliestResult.rows[0]?.earliest as Date | null
      const earliestCheckedAt = earliestRaw ? earliestRaw.toISOString() : null
      const daysOfDataAvailable = earliestRaw
        ? Math.min(days, Math.max(0, Math.floor((Date.now() - earliestRaw.getTime()) / 86_400_000)))
        : 0
      res.json({
        trend: result.rows.map(r => ({
          date: (r.date as Date).toISOString().slice(0, 10),
          avgTrust: r.avg_trust as number,
        })),
        periodDays: days,
        earliestCheckedAt,
        daysOfDataAvailable,
      })
    })
    .catch((err: unknown) => {
      if (IS_DEV) console.error('[/api/stats/trust-trend]', err)
      res.status(500).json({ error: 'Internal server error' })
    })
})

// Trust Score risers/fallers over the last 7 or 30 days. Reads entirely from
// `mints`: last_trust_score is the "latest" snapshot (written by every probe),
// and trust_score_{7,30}d_ago are the point-in-time snapshots rolled up by
// refreshTrustMoversRollup() (trustMoversRollup.ts) on the probe cron — this
// used to be two DISTINCT ON passes over all of mint_history (~2.5s cold) run
// on every cache miss. A mint with no old-enough scored history has a NULL
// snapshot and is filtered out here (same effect as the old INNER JOIN). The
// +/-3 threshold and top-3 ranking live in trustMovers.ts (computeTrustMovers),
// unit-tested independently of this query.
app.get('/api/stats/trust-movers', (req: Request, res: Response): void => {
  const period: '7d' | '30d' = req.query['period'] === '30d' ? '30d' : '7d'
  const days = period === '30d' ? 30 : 7

  const cached = trustMoversCache.get(period)
  if (cached && Date.now() < cached.expiresAt) {
    res.setHeader('Cache-Control', `max-age=${Math.floor(TRUST_MOVERS_CACHE_TTL / 1000)}`)
    res.json(cached.data)
    return
  }

  pool.query(
    `SELECT url, name,
       last_trust_score AS latest_score,
       CASE WHEN $1 = 30 THEN trust_score_30d_ago ELSE trust_score_7d_ago END AS old_score
     FROM mints
     WHERE last_trust_score IS NOT NULL
       AND CASE WHEN $1 = 30 THEN trust_score_30d_ago ELSE trust_score_7d_ago END IS NOT NULL`,
    [days]
  )
    .then(result => {
      const snapshots: MintScoreSnapshot[] = result.rows.map(r => ({
        url: r.url as string,
        name: r.name as string | null,
        latestScore: Number(r.latest_score),
        oldScore: Number(r.old_score),
      }))
      const data = { period, ...computeTrustMovers(snapshots) }
      trustMoversCache.set(period, { data, expiresAt: Date.now() + TRUST_MOVERS_CACHE_TTL })
      res.setHeader('Cache-Control', `max-age=${Math.floor(TRUST_MOVERS_CACHE_TTL / 1000)}`)
      res.json(data)
    })
    .catch((err: unknown) => {
      if (IS_DEV) console.error('[/api/stats/trust-movers]', err)
      res.status(500).json({ error: 'Internal server error' })
    })
})

app.get('/api/mints/known', (_req: Request, res: Response): void => {
  if (knownMintsCache && Date.now() < knownMintsCache.expiresAt) {
    res.json(knownMintsCache.data)
    return
  }
  pool
    .query(`
      SELECT m.url, m.name, m.icon_url, m.version, m.nut_count,
        m.tos_url, m.description_long, m.nuts_limits,
        m.units, m.mint_methods, m.melt_methods,
        m.audit_n_mints, m.audit_n_melts, m.audit_n_errors, m.audit_checked_at,
        m.audit_synced_at, m.audit_recent_total, m.audit_recent_errors,
        m.discovered_at, m.last_trust_score, m.last_error, m.server_location,
        m.review_count, m.review_avg_rating,
        COUNT(h.online) AS total,
        COALESCE(SUM(CASE WHEN h.online THEN 1 ELSE 0 END), 0) AS online_count,
        latest.online AS latest_online,
        latest.latency_ms AS latest_latency_ms,
        latest.checked_at AS latest_checked_at
      FROM mints m
      LEFT JOIN mint_history h ON h.url = m.url AND h.checked_at > NOW() - INTERVAL '24 hours'
      LEFT JOIN LATERAL (
        SELECT online, latency_ms, checked_at FROM mint_history
        WHERE url = m.url ORDER BY checked_at DESC, id DESC LIMIT 1
      ) latest ON true
      GROUP BY m.url, m.name, m.icon_url, m.version, m.nut_count,
        m.tos_url, m.description_long, m.nuts_limits,
        m.units, m.mint_methods, m.melt_methods,
        m.audit_n_mints, m.audit_n_melts, m.audit_n_errors, m.audit_checked_at,
        m.audit_synced_at, m.audit_recent_total, m.audit_recent_errors,
        m.discovered_at, m.last_trust_score, m.last_error, m.server_location,
        m.review_count, m.review_avg_rating,
        latest.online, latest.latency_ms, latest.checked_at
    `)
    .then(result => {
      // C for the IMDB-style weighted Rating sort (see below) — computed from
      // the raw rollup columns before the row map so each mint's WR can be set
      // inline in the literal.
      const globalMean = globalMeanRating(
        result.rows.map(r => ({
          reviewCount: (r.review_count as number | null) ?? null,
          reviewAvgRating: r.review_avg_rating != null ? Number(r.review_avg_rating) : null,
        })),
      )
      const data = result.rows.map(r => {
        const total = Number(r.total)
        const onlineCount = Number(r.online_count)
        const latestOnline = r.latest_online as boolean | null
        const latestCheckedAt = r.latest_checked_at as string | null
        return {
          url: r.url as string,
          name: r.name as string | null,
          iconUrl: (r.icon_url as string | null) ?? null,
          degraded: computeDegraded(total, onlineCount, latestOnline, latestCheckedAt),
          online: r.latest_online as boolean | null,
          latencyMs: r.latest_latency_ms as number | null,
          version: r.version as string | null,
          nutCount: r.nut_count as number | null,
          tosUrl: (r.tos_url as string | null) ?? null,
          descriptionLong: (r.description_long as string | null) ?? null,
          nutsLimits: (r.nuts_limits as Record<string, unknown> | null) ?? null,
          units: (r.units as string[] | null) ?? null,
          mintMethods: (r.mint_methods as Record<string, unknown>[] | null) ?? null,
          meltMethods: (r.melt_methods as Record<string, unknown>[] | null) ?? null,
          auditNMints: (r.audit_n_mints as number | null) ?? null,
          auditNMelts: (r.audit_n_melts as number | null) ?? null,
          auditNErrors: (r.audit_n_errors as number | null) ?? null,
          auditCheckedAt: (r.audit_checked_at as string | null) ?? null,
          auditSyncedAt: (r.audit_synced_at as string | null) ?? null,
          auditRecentTotal: (r.audit_recent_total as number | null) ?? null,
          auditRecentErrors: (r.audit_recent_errors as number | null) ?? null,
          discoveredAt: (r.discovered_at as string | null) ?? null,
          trustScore: (r.last_trust_score as number | null) ?? null,
          lastError: (r.last_error as string | null) ?? null,
          uptimePct24h: total === 0 ? null : Math.round(onlineCount / total * 100),
          serverLocation: (r.server_location as string | null) ?? null,
          lastCheckedAt: (r.latest_checked_at as string | null) ?? null,
          reviewCount: (r.review_count as number | null) ?? null,
          reviewAvgRating: r.review_avg_rating != null ? Number(r.review_avg_rating) : null,
          // IMDB-style weighted rating — used ONLY to order the Rating sort,
          // never displayed (the card badge keeps showing reviewAvgRating /
          // reviewCount). Kept out of reviewsSync's per-mint rollup because C is
          // a global mean over all mints; this endpoint already loads them all.
          reviewWeightedRating: weightedRating(
            (r.review_count as number | null) ?? null,
            r.review_avg_rating != null ? Number(r.review_avg_rating) : null,
            globalMean,
          ),
        }
      })
      knownMintsCache = { data, expiresAt: Date.now() + KNOWN_MINTS_CACHE_TTL }
      res.setHeader('Cache-Control', 'max-age=300')
      res.json(data)
    })
    .catch((err: unknown) => {
      if (IS_DEV) console.error('[/api/mints/known]', err)
      res.status(500).json({ error: 'Internal server error' })
    })
})

// Bot-only OG tag fragment for /mint/:url — nginx routes social-crawler user
// agents here (see deploy/nginx.conf); regular browsers never hit this route
// and get the normal client-rendered SPA instead. Always responds 200 with a
// valid HTML fragment (generic fallback if the mint/url isn't found or the DB
// lookup fails) since a crawler getting a 404/500 means no preview at all.
// SSRF-safe favicon proxy — see backend/src/mintIcon.ts for the full rationale.
// The frontend points every mint <img> here instead of fetching a mint-controlled
// icon_url directly, so a hostile icon_url can't turn a page view into an IP /
// User-Agent tracking beacon (2026-09-07 security audit). Known mints only;
// bytes are fetched through safeFetch and re-served from our origin, cached
// in-process. Anything unsafe/unfetchable → 404 and the client shows its SVG
// placeholder. Exempt from the per-IP rate limit (read-only, cacheable, and the
// in-process cache means upstream is hit at most once per mint per TTL anyway).
app.get('/api/mint/icon', (req: Request, res: Response): void => {
  const rawUrl = req.query['url']
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
    res.status(400).end()
    return
  }

  getMintIcon(rawUrl)
    .then(icon => {
      if (!icon) {
        res.setHeader('Cache-Control', 'public, max-age=1800')
        res.status(404).end()
        return
      }
      res.setHeader('Content-Type', icon.contentType)
      // Belt-and-suspenders against a mint serving something script-y that slipped
      // the content-type allow-list: no active content, no framing, treat as an
      // opaque same-origin resource.
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.end(icon.body)
    })
    .catch((err: unknown) => {
      if (IS_DEV) console.error('[/api/mint/icon]', err)
      res.status(404).end()
    })
})

app.get('/api/og/mint', (req: Request, res: Response): void => {
  const rawUrl = req.query['url']
  const hasValidUrl = typeof rawUrl === 'string' && rawUrl.length > 0 && rawUrl.length <= MAX_URL_LENGTH

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', `max-age=${Math.floor(KNOWN_MINTS_CACHE_TTL / 1000)}`)

  if (!hasValidUrl) {
    res.send(renderMintOgHtml(null, ''))
    return
  }

  const normalized = normalizeUrl(rawUrl)
  fetchOgMintData(normalized)
    .then(mint => {
      res.send(renderMintOgHtml(mint, normalized))
    })
    .catch((err: unknown) => {
      if (IS_DEV) console.error('[/api/og/mint]', err)
      res.send(renderMintOgHtml(null, normalized))
    })
})

app.get('/api/mints/daily-uptime', (req: Request, res: Response): void => {
  const url = req.query['url']

  if (typeof url !== 'string' || url.length === 0) {
    res.status(400).json({ error: 'Missing required query parameter: url' })
    return
  }

  if (!url.startsWith('https://')) {
    res.status(400).json({ error: 'url must start with https://' })
    return
  }

  if (url.length > MAX_URL_LENGTH) {
    res.status(400).json({ error: `url exceeds maximum length of ${MAX_URL_LENGTH} characters` })
    return
  }

  isSafeUrl(url)
    .then(safe => {
      if (!safe) {
        res.status(400).json({ error: 'Invalid url' })
        return
      }
      return pool
        .query(
          `SELECT
            (DATE_TRUNC('day', checked_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS day,
            SUM(CASE WHEN online THEN 1 ELSE 0 END)::int AS online_count,
            COUNT(*)::int AS total_count
           FROM mint_history
           WHERE url = $1 AND checked_at > NOW() - INTERVAL '30 days'
           GROUP BY DATE_TRUNC('day', checked_at AT TIME ZONE 'UTC')
           ORDER BY DATE_TRUNC('day', checked_at AT TIME ZONE 'UTC') ASC`,
          [url]
        )
        .then(result => {
          res.json({
            url,
            days: result.rows.map(r => ({
              day: (r.day as Date).toISOString().slice(0, 10),
              onlineCount: r.online_count as number,
              totalCount: r.total_count as number,
            })),
          })
        })
    })
    .catch((err: unknown) => {
      if (IS_DEV) console.error('[/api/mints/daily-uptime]', err)
      res.status(500).json({ error: 'Internal server error' })
    })
})

app.post('/api/mint/submit', (req: Request, res: Response): void => {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
  if (!checkSubmitRateLimit(ip)) {
    res.status(429).json({ error: 'Too many requests. Try again later.' })
    return
  }

  const body = req.body as { url?: unknown }
  const url = body.url

  if (typeof url !== 'string' || url.length === 0) {
    res.status(400).json({ error: 'Missing required field: url' })
    return
  }

  if (!url.startsWith('https://')) {
    res.status(400).json({ error: 'url must start with https://' })
    return
  }

  if (url.length > MAX_URL_LENGTH) {
    res.status(400).json({ error: `url exceeds maximum length of ${MAX_URL_LENGTH} characters` })
    return
  }

  const normalized = normalizeUrl(url)

  isSafeUrl(normalized)
    .then(safe => {
      if (!safe) {
        res.status(400).json({ error: 'Invalid url' })
        return
      }
      return probeMint(normalized).then(async status => {
        if (!status.online) {
          res.status(400).json({ error: 'URL does not appear to be a valid Cashu mint' })
          return
        }
        const result = await pool.query(
          'INSERT INTO mints (url, is_known) VALUES ($1, true) ON CONFLICT (url) DO NOTHING',
          [normalized]
        )
        const isNew = (result.rowCount ?? 0) > 0
        try {
          await probeMintToDb(normalized)
        } catch (probeErr) {
          if (IS_DEV) console.error('[submit] post-insert probe failed:', probeErr)
        }
        knownMintsCache = null
        res.json({ success: true, isNew, name: status.info?.name ?? null })
      })
    })
    .catch((err: unknown) => {
      if (IS_DEV) console.error('[/api/mint/submit]', err)
      res.status(500).json({ error: 'Internal server error' })
    })
})

const MAX_DISCOVER_BATCH = 100

app.post('/api/mints/discover', async (req: Request, res: Response): Promise<void> => {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
  if (!checkDiscoverRateLimit(ip)) {
    res.status(429).json({ error: 'Too many requests. Try again later.' })
    return
  }

  const body = req.body as { urls?: unknown }
  if (!Array.isArray(body.urls)) {
    res.status(400).json({ error: 'urls must be array' })
    return
  }

  if (body.urls.length > MAX_DISCOVER_BATCH) {
    res.status(400).json({ error: `urls exceeds maximum batch size of ${MAX_DISCOVER_BATCH}` })
    return
  }

  let added = 0
  const results: Array<{ url: string; success: boolean; isNew: boolean; error?: string }> = []
  for (const url of body.urls) {
    if (typeof url !== 'string') continue
    if (url.length > MAX_URL_LENGTH) {
      results.push({ url, success: false, isNew: false, error: `url exceeds maximum length of ${MAX_URL_LENGTH} characters` })
      continue
    }
    if (!url.startsWith('https://')) {
      results.push({ url, success: false, isNew: false, error: 'url must start with https://' })
      continue
    }
    const normalized = normalizeUrl(url)
    try {
      if (!(await isSafeUrl(normalized))) {
        results.push({ url: normalized, success: false, isNew: false, error: 'Invalid url' })
        continue
      }
      if (!(await isValidCashuMint(normalized))) {
        results.push({ url: normalized, success: false, isNew: false, error: 'URL does not appear to be a valid Cashu mint' })
        continue
      }
      const result = await pool.query(
        'INSERT INTO mints (url, is_known) VALUES ($1, true) ON CONFLICT (url) DO NOTHING',
        [normalized]
      )
      const isNew = result.rowCount !== null && result.rowCount > 0
      if (isNew) added++
      results.push({ url: normalized, success: true, isNew })
    } catch {
      results.push({ url: normalized, success: false, isNew: false, error: 'Internal error' })
    }
  }

  if (added > 0) knownMintsCache = null
  res.json({ added, total: body.urls.length, results })
})

// Secondary review source in a two-mechanism pattern. The frontend's
// useMintReviews.ts fetches live from Nostr relays client-side on every Mint
// Detail view (PRIMARY — the only path guaranteed to surface a user's own
// just-published review immediately, see useSubmitReview.ts). This endpoint
// serves the `mint_reviews` rows that the 6h background sync (reviewsSync.ts)
// populates — an independent server-side vantage point that can reach relays a
// user's connection can't. It used to do its OWN live relay query on every
// request (~3s, the single biggest contributor to slow Mint Detail loads); now
// it's a fast DB read. MintDetail.tsx merges both sources and only adds rows
// the live fetch missed (see the dedup comment there). Do not collapse the two
// mechanisms without re-confirming with the maintainer.
app.get('/api/mints/nostr-reviews', (req: Request, res: Response): void => {
  const url = req.query['url']

  if (typeof url !== 'string' || url.length === 0) {
    res.status(400).json({ error: 'Missing required query parameter: url' })
    return
  }

  if (!url.startsWith('https://')) {
    res.status(400).json({ error: 'url must start with https://' })
    return
  }

  if (url.length > MAX_URL_LENGTH) {
    res.status(400).json({ error: `url exceeds maximum length of ${MAX_URL_LENGTH} characters` })
    return
  }

  pool
    .query(
      `SELECT event_id, pubkey, rating, comment, created_at
       FROM mint_reviews WHERE url = $1
       ORDER BY created_at DESC`,
      [url],
    )
    .then(result => {
      const reviews = result.rows.map(r => ({
        id: r.event_id as string,
        pubkey: r.pubkey as string,
        content: (r.comment as string | null) ?? '',
        rating: r.rating as number | null,
        createdAt: Number(r.created_at),
        source: 'nostr' as const,
      }))
      res.setHeader('Cache-Control', 'max-age=120')
      res.json(reviews)
    })
    .catch((err: unknown) => {
      if (IS_DEV) console.error('[/api/mints/nostr-reviews]', err)
      res.json([])
    })
})

// ── Routes: notification subscriptions ────────────────────────
//
// Phase 1: storage only — no sending. A subscription records that `pubkey`
// wants a DM (over `relays`) when `mintUrl` transitions online/offline.
// Both routes require NIP-98 auth (RFC 27235 "Nostr" HTTP Auth) so a
// subscription can only be created/removed by the key that owns it.

const MIN_RELAYS = 1
const MAX_RELAYS = 10

// Validates the relay list shape and, for each entry, that it's a ws:/wss:
// URL that passes the same SSRF guard used for mint probing (adapted for the
// ws(s) scheme in ssrf.ts) — prevents a subscription from later being used to
// make the (future, phase-2) DM-sending code connect to internal
// infrastructure via an attacker-supplied "relay".
//
// `logContext` (a truncated pubkey — never full request data) is included in
// every rejection log line so a rejected batch is diagnosable server-side
// without needing to expose which specific relay/reason failed to the client.
async function validateRelays(relays: unknown, logContext: string): Promise<string[] | null> {
  if (!Array.isArray(relays)) {
    console.warn(`[notifications] relay validation rejected (${logContext}): relays is not an array`)
    return null
  }
  if (relays.length < MIN_RELAYS || relays.length > MAX_RELAYS) {
    console.warn(`[notifications] relay validation rejected (${logContext}): ${relays.length} relays, expected ${MIN_RELAYS}-${MAX_RELAYS}`)
    return null
  }
  for (const r of relays) {
    if (typeof r !== 'string' || r.length === 0 || r.length > MAX_URL_LENGTH) {
      console.warn(`[notifications] relay validation rejected (${logContext}): malformed relay entry (not a string, empty, or over ${MAX_URL_LENGTH} chars)`)
      return null
    }
  }
  const typedRelays = relays as string[]
  const checks = await Promise.all(
    typedRelays.map(async url => ({ url, result: await checkWsUrlSafety(url) }))
  )

  // A DNS failure is not an SSRF signal — mirrors checkWsUrlSafety's own
  // three-state contract (ssrf.ts), where 'dns-error' means "currently
  // unreachable", not "malicious" (only 'blocked' does: bad scheme, or
  // resolves to a private/internal address). Treating 'dns-error' the same
  // as 'blocked' was the actual bug: a single relay with a dead/unresolvable
  // hostname (e.g. relay.nostr.bg — confirmed via `dig`, no DNS records at
  // all) rejected the ENTIRE subscribe request, even with 9 other perfectly
  // valid relays in the same batch. A relay list naturally includes relays
  // that are temporarily or permanently down; that's not something the
  // request as a whole should fail on. Only a genuinely 'blocked' relay
  // invalidates the batch — 'dns-error' relays are still stored as given.
  const blocked = checks.filter(c => c.result === 'blocked')
  if (blocked.length > 0) {
    console.warn(
      `[notifications] relay validation rejected (${logContext}): blocked — ` +
      blocked.map(c => c.url).join(', ')
    )
    return null
  }

  const dnsErrors = checks.filter(c => c.result === 'dns-error')
  if (dnsErrors.length > 0) {
    console.warn(
      `[notifications] relay(s) unresolvable but accepted (${logContext}): ` +
      dnsErrors.map(c => c.url).join(', ')
    )
  }

  return typedRelays
}

app.post('/api/notifications/subscribe', (req: Request, res: Response): void => {
  authenticateNip98(req)
    .then(auth => {
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error })
        return
      }
      const { pubkey } = auth

      if (!checkNotifySubscribeRateLimit(pubkey)) {
        res.status(429).json({ error: 'Too many requests. Try again later.' })
        return
      }

      const body = req.body as {
        mintUrl?: unknown
        notifyOnDown?: unknown
        notifyOnUp?: unknown
        relays?: unknown
      }

      const mintUrl = body.mintUrl
      if (typeof mintUrl !== 'string' || mintUrl.length === 0) {
        res.status(400).json({ error: 'Missing required field: mintUrl' })
        return
      }
      if (mintUrl.length > MAX_URL_LENGTH) {
        res.status(400).json({ error: `mintUrl exceeds maximum length of ${MAX_URL_LENGTH} characters` })
        return
      }

      const { notifyOnDown, notifyOnUp } = body
      if (typeof notifyOnDown !== 'boolean' || typeof notifyOnUp !== 'boolean') {
        res.status(400).json({ error: 'notifyOnDown and notifyOnUp must be boolean' })
        return
      }

      return validateRelays(body.relays, pubkey.slice(0, 8)).then(relays => {
        if (relays === null) {
          res.status(400).json({
            error: `relays must be an array of ${MIN_RELAYS}-${MAX_RELAYS} valid ws:// or wss:// URLs`,
          })
          return
        }

        return pool.query('SELECT 1 FROM mints WHERE url = $1', [mintUrl]).then(mintResult => {
          if ((mintResult.rowCount ?? 0) === 0) {
            res.status(400).json({ error: 'Unknown mint' })
            return
          }

          return pool.query(
            `INSERT INTO notification_subscriptions (pubkey, mint_url, notify_on_down, notify_on_up, relays, updated_at)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (pubkey, mint_url) DO UPDATE SET
               notify_on_down = EXCLUDED.notify_on_down,
               notify_on_up = EXCLUDED.notify_on_up,
               relays = EXCLUDED.relays,
               updated_at = now()`,
            [pubkey, mintUrl, notifyOnDown, notifyOnUp, relays]
          ).then(() => {
            // Audit trail: truncated pubkey + mint only — never relays/notify
            // flags, which is the rest of the request body.
            console.log(`[notifications/subscribe] pubkey=${pubkey.slice(0, 8)}… mint=${mintUrl}`)
            res.json({ success: true })
          })
        })
      })
    })
    .catch((err: unknown) => {
      if (IS_DEV) console.error('[/api/notifications/subscribe]', err)
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
    })
})

app.post('/api/notifications/unsubscribe', (req: Request, res: Response): void => {
  authenticateNip98(req)
    .then(auth => {
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error })
        return
      }
      const { pubkey } = auth

      if (!checkNotifyUnsubscribeRateLimit(pubkey)) {
        res.status(429).json({ error: 'Too many requests. Try again later.' })
        return
      }

      const body = req.body as { mintUrl?: unknown }
      const mintUrl = body.mintUrl
      if (typeof mintUrl !== 'string' || mintUrl.length === 0) {
        res.status(400).json({ error: 'Missing required field: mintUrl' })
        return
      }
      if (mintUrl.length > MAX_URL_LENGTH) {
        res.status(400).json({ error: `mintUrl exceeds maximum length of ${MAX_URL_LENGTH} characters` })
        return
      }

      // Normalize the same way every other mint-URL entry point does before
      // using it anywhere — including in the log line below, where a raw
      // client-supplied string with an embedded newline could otherwise
      // forge a second, fabricated log entry.
      try {
        new URL(mintUrl.trim())
      } catch {
        res.status(400).json({ error: 'Invalid mintUrl' })
        return
      }
      const normalizedMintUrl = normalizeUrl(mintUrl)

      return pool.query(
        'DELETE FROM notification_subscriptions WHERE pubkey = $1 AND mint_url = $2',
        [pubkey, normalizedMintUrl]
      ).then(() => {
        console.log(`[notifications/unsubscribe] pubkey=${pubkey.slice(0, 8)}… mint=${normalizedMintUrl}`)
        res.json({ success: true })
      })
    })
    .catch((err: unknown) => {
      if (IS_DEV) console.error('[/api/notifications/unsubscribe]', err)
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
    })
})

// ── Start ──────────────────────────────────────────────────────

// Only bind the port and run startup side effects when not under test.
// Integration tests import `app` directly and drive it via supertest, so the
// real server, DB init, seeding and cron must not run on import.
if (process.env['NODE_ENV'] !== 'test') {
  const server = app.listen(PORT, () => {
    console.log(`MintRadar backend listening on port ${PORT}`)
    initDb()
      .then(() => seedKnownMints(upsertMint))
      .then(() => {
        startCron()
        void publishServiceProfile()
      })
      .catch((err: unknown) => {
        console.error('[startup] DB init failed — exiting:', err)
        process.exit(1)
      })
  })

  process.on('SIGTERM', () => {
    server.close(() => { process.exit(0) })
  })

  process.on('SIGINT', () => {
    server.close(() => { process.exit(0) })
  })
}
