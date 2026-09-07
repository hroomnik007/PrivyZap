import dns from 'dns'
import { fetch as undiciFetch } from 'undici'
import pLimit from 'p-limit'
import { pool } from './db.js'
import { checkUrlSafety, safeFetch } from './ssrf.js'
import { computeTrustScore, versionFreshnessScore } from './shared/trustScore.js'
import { notifySubscribers, isNotificationServiceEnabled } from './nostrService.js'
import { getLatestVersionsMap } from './versionCatalog.js'

function isCloudflareIP(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => isNaN(n))) return false
  const a = parts[0]!, b = parts[1]!, c = parts[2]!
  if (a === 172 && b >= 64 && b <= 71) return true          // 172.64.0.0/13
  if (a === 188 && b === 114 && c >= 96 && c <= 111) return true  // 188.114.96.0/20
  if (a === 104 && b >= 16 && b <= 23) return true          // 104.16.0.0/13
  return false
}

async function lookupServerLocation(mintUrl: string): Promise<string | null> {
  try {
    const hostname = new URL(mintUrl).hostname
    console.log(`[geo] looking up: ${hostname}`)
    const { address } = await dns.promises.lookup(hostname)
    console.log(`[geo] ${hostname} resolved to ${address}`)
    const res = await undiciFetch(`https://ipinfo.io/${address}/json`, {
      signal: AbortSignal.timeout(5_000),
    }) as unknown as Response
    if (!res.ok) {
      console.log(`[geo] ipinfo.io returned HTTP ${res.status} for ${hostname}`)
      return null
    }
    const data = await res.json() as Record<string, unknown>
    if (data['bogon'] === true) {
      console.log(`[geo] ${hostname} is bogon — skipping`)
      return null
    }
    const city = typeof data['city'] === 'string' ? data['city'] : null
    const country = typeof data['country'] === 'string' ? data['country'] : null
    if (!city && !country) {
      console.log(`[geo] no city/country in ipinfo response for ${hostname}`)
      return null
    }
    if (city === 'San Francisco' && isCloudflareIP(address)) {
      console.log(`[geo] ${hostname} (${address}) detected as Cloudflare CDN`)
      return 'Cloudflare CDN'
    }
    const location = [city, country].filter(Boolean).join(', ')
    console.log(`[geo] ${hostname} → ${location}`)
    return location
  } catch (err) {
    console.error(`[geo] lookup error for ${mintUrl}:`, err)
    return null
  }
}

export async function backfillServerLocations(): Promise<void> {
  try {
    const res = await pool.query('SELECT url FROM mints WHERE server_location IS NULL')
    const urls = (res.rows as { url: string }[]).map(r => r.url)
    console.log(`[geo] backfill: ${urls.length} mints with NULL server_location`)
    let found = 0
    for (const mintUrl of urls) {
      const location = await lookupServerLocation(mintUrl)
      if (location !== null) {
        await pool.query('UPDATE mints SET server_location = $1 WHERE url = $2', [location, mintUrl])
        found++
      }
      await new Promise<void>(resolve => setTimeout(resolve, 150))
    }
    console.log(`[geo] backfill complete: ${found}/${urls.length} locations populated`)
  } catch (err) {
    console.error('[geo] backfill error:', err)
  }
}

const PROBE_TIMEOUT_MS = 10000
const RETENTION_DAYS = 90

// Trust Score maths now lives in shared/trustScore.ts, shared (via a synced copy)
// with the frontend's Trust Score Breakdown. These re-exports keep prober.ts the
// import site the rest of the backend and its tests already use.
export const serverVersionFreshnessScore = versionFreshnessScore
export const computeServerTrustScore = computeTrustScore

export interface MintMethodEntry {
  method: string
  unit: string
  [key: string]: unknown
}

function isMintMethodArray(val: unknown): val is MintMethodEntry[] {
  return Array.isArray(val) && val.every(
    m => m !== null && typeof m === 'object' &&
      typeof (m as Record<string, unknown>)['method'] === 'string' &&
      typeof (m as Record<string, unknown>)['unit'] === 'string'
  )
}

// Derives units/mint_methods/melt_methods from a mint's `nuts` object (the
// same object already stored verbatim in nuts_limits) — no new network call,
// pure re-parsing of NUT-04 (mint methods) / NUT-05 (melt methods). Some
// mints don't expose method-level detail (older Nutshell versions, custom
// implementations), so each field is null rather than throwing when absent
// or malformed.
export function parseMintMethods(nuts: Record<string, unknown> | null | undefined): {
  units: string[] | null
  mintMethods: MintMethodEntry[] | null
  meltMethods: MintMethodEntry[] | null
} {
  if (nuts === null || nuts === undefined) return { units: null, mintMethods: null, meltMethods: null }

  const nut4 = nuts['4'] as Record<string, unknown> | undefined
  const nut5 = nuts['5'] as Record<string, unknown> | undefined
  const mintMethods = isMintMethodArray(nut4?.['methods']) ? nut4!['methods'] as MintMethodEntry[] : null
  const meltMethods = isMintMethodArray(nut5?.['methods']) ? nut5!['methods'] as MintMethodEntry[] : null

  const unitSet = new Set<string>()
  for (const m of [...(mintMethods ?? []), ...(meltMethods ?? [])]) unitSet.add(m.unit)
  const units = unitSet.size > 0 ? [...unitSet] : null

  return { units, mintMethods, meltMethods }
}

function classifyFetchError(err: unknown): string {
  if (!(err instanceof Error)) return 'Unreachable'
  // undici's fetch wraps connect-level errors (ECONNREFUSED, DNS, TLS,
  // connect timeouts) in a generic `TypeError: fetch failed` — the actual
  // error with its `code` lives in `.cause`, not on the top-level error.
  const effective = err.cause instanceof Error ? err.cause : err
  const code = (effective as { code?: string }).code
  const name = err.name
  const msg = effective.message.toLowerCase()
  if (
    name === 'AbortError' || name === 'TimeoutError' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) return 'Connection timeout'
  if (code === 'ECONNREFUSED') return 'Connection refused'
  if (
    code === 'ENOTFOUND' || code === 'EAI_AGAIN' ||
    msg.includes('getaddrinfo')
  ) return 'DNS resolution failed'
  if (
    code?.startsWith('ERR_TLS') ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    msg.includes('certificate') ||
    msg.includes('ssl')
  ) return 'TLS/SSL error'
  return 'Unreachable'
}

// Lightweight Cashu-content validation with no DB side effects — confirms a
// URL actually serves a valid /v1/info response (an object with a `nuts`
// field) before it's allowed into the mints table. Mirrors the check
// probeMint() (index.ts, POST /api/mint/submit) already performs, so every
// insertion path requires the same proof of being a real Cashu mint rather
// than relying on isObviouslyPrivate()/isSafeUrl() (SSRF/reachability only).
export async function isValidCashuMint(url: string): Promise<boolean> {
  try {
    const res = await safeFetch(`${url}/v1/info`, { timeoutMs: PROBE_TIMEOUT_MS })
    if (!res || !res.ok) return false
    const raw = await res.json() as Record<string, unknown>
    return raw['nuts'] !== null && typeof raw['nuts'] === 'object'
  } catch {
    return false
  }
}

// Second-layer defense alongside isValidCashuMint(): deletes any mint row
// that has NEVER had a successful (online=true) probe recorded in
// mint_history and is older than the TTL below. Covers any insertion path
// that isn't (or stops being) gated by isValidCashuMint() — e.g. a future
// bug or a new discovery source — since there is otherwise no DELETE FROM
// mints anywhere in the app and an unvalidated row would be probed forever.
const UNVALIDATED_CANDIDATE_TTL_HOURS = 24

export async function pruneUnvalidatedMints(): Promise<number> {
  const res = await pool.query(
    `DELETE FROM mints
     WHERE discovered_at < NOW() - INTERVAL '${UNVALIDATED_CANDIDATE_TTL_HOURS} hours'
       AND NOT EXISTS (
         SELECT 1 FROM mint_history h WHERE h.url = mints.url AND h.online = true
       )`
  )
  return res.rowCount ?? 0
}

// ── Recurring revalidation ──────────────────────────────────────────────────
//
// isValidCashuMint() only runs once, at submit/discovery time. The 5-min probe
// re-checks reachability + SSRF ranges every cycle but not Cashu content, and
// pruneUnvalidatedMints() permanently exempts any row with a single past success.
// So a URL that passed the gate once and is then repointed (DNS change, or a
// redirect) to some other host was probed by MintRadar's server forever —
// a confused-deputy: recurring GET /v1/info to an attacker-chosen target.
//
// The SSRF guard (checkUrlSafetyForProtocols + connect-time safeLookup re-check)
// still blocks private/loopback/link-local/CGN ranges and DNS-rebinding, so the
// target is necessarily a PUBLIC host — the residual impact is "recurring
// unauthenticated GET to another public https host", not internal SSRF. This
// bounds that window: a mint found reachable-but-not-a-Cashu-mint for
// REVALIDATION_REAP_DAYS straight is deleted from the probe rotation.

type RevalidationStatus = 'ok' | 'not-a-mint' | 'unreachable'

// Days a mint must serve non-Cashu content CONTINUOUSLY before it is reaped.
// Long enough that a multi-day outage of a genuine mint (which reads as
// 'unreachable', not 'not-a-mint', and never advances the clock anyway) is
// never at risk; short enough to close the attack window.
const REVALIDATION_REAP_DAYS = 7

// Concurrency for the daily sweep — lower than the 5-min probe's (10) since this
// runs once a day and isn't latency-sensitive.
const REVALIDATION_CONCURRENCY = 6

// Stronger than isValidCashuMint(), and used ONLY here (never the lenient
// submit/discovery gate, which must not start rejecting an unusual-but-real
// mint). A functioning Cashu mint serves a non-empty /v1/info `nuts` object
// AND a /v1/keys response carrying at least one keyset. Crucially it separates
// "reachable but not a mint" (repoint target, redirect, a `{"nuts":{}}` stub,
// an HTML page) from "transiently unreachable" (5xx, timeout, DNS failure) —
// only the former advances the reap clock.
async function revalidateMintContent(url: string): Promise<RevalidationStatus> {
  let infoRes: Response | null
  let keysRes: Response | null
  try {
    ;[infoRes, keysRes] = await Promise.all([
      safeFetch(`${url}/v1/info`, { timeoutMs: PROBE_TIMEOUT_MS }),
      safeFetch(`${url}/v1/keys`, { timeoutMs: PROBE_TIMEOUT_MS }),
    ])
  } catch {
    return 'unreachable'
  }

  if (!infoRes) return 'unreachable'
  if (infoRes.status >= 500) return 'unreachable'
  if (!infoRes.ok) return 'not-a-mint' // 4xx — the mint API genuinely isn't here

  try {
    const info = await infoRes.json() as Record<string, unknown>
    const nuts = info['nuts']
    const nutsOk =
      typeof nuts === 'object' && nuts !== null && !Array.isArray(nuts) &&
      Object.keys(nuts as Record<string, unknown>).length > 0
    if (!nutsOk) return 'not-a-mint'

    if (!keysRes) return 'unreachable'
    if (keysRes.status >= 500) return 'unreachable'
    if (!keysRes.ok) return 'not-a-mint'
    const keys = await keysRes.json() as Record<string, unknown>
    const keysets = keys['keysets']
    return Array.isArray(keysets) && keysets.length > 0 ? 'ok' : 'not-a-mint'
  } catch {
    return 'not-a-mint' // a 200 whose body isn't a mint's JSON
  }
}

export async function revalidateMints(): Promise<{ checked: number; invalid: number; reaped: number }> {
  const res = await pool.query('SELECT url FROM mints')
  const urls = (res.rows as { url: string }[]).map(r => r.url)
  const limit = pLimit(REVALIDATION_CONCURRENCY)

  let invalid = 0
  await Promise.allSettled(urls.map(url => limit(async () => {
    const status = await revalidateMintContent(url)
    if (status === 'ok') {
      // Validated — clear any prior reap clock.
      await pool.query('UPDATE mints SET revalidated_at = NOW(), invalid_since = NULL WHERE url = $1', [url])
    } else if (status === 'not-a-mint') {
      invalid++
      // Start (or keep) the reap clock.
      await pool.query('UPDATE mints SET revalidated_at = NOW(), invalid_since = COALESCE(invalid_since, NOW()) WHERE url = $1', [url])
    } else {
      // Transiently unreachable — note the check ran, but do NOT advance the
      // reap clock and do NOT clear it (a repointed host that also goes down
      // shouldn't get a reprieve).
      await pool.query('UPDATE mints SET revalidated_at = NOW() WHERE url = $1', [url])
    }
  })))

  const reap = await pool.query(
    `DELETE FROM mints
     WHERE invalid_since IS NOT NULL
       AND invalid_since < NOW() - INTERVAL '${REVALIDATION_REAP_DAYS} days'`
  )
  const reaped = reap.rowCount ?? 0
  if (reaped > 0) {
    console.log(`[revalidate] reaped ${reaped} mint(s) serving non-Cashu content for ${REVALIDATION_REAP_DAYS}+ days`)
  }
  return { checked: urls.length, invalid, reaped }
}

export async function probeMintToDb(url: string): Promise<void> {
  const urlSafety = await checkUrlSafety(url)
  if (urlSafety === 'blocked') {
    if (process.env['NODE_ENV'] !== 'production') {
      console.warn('[prober] blocked unsafe URL:', url)
    }
    return
  }
  if (urlSafety === 'dns-error') {
    // DNS failure is not an SSRF attempt — record the mint as offline so
    // uptime history and the degraded flag remain accurate.
    await pool.query(
      `INSERT INTO mint_history (url, online, latency_ms, checked_at) VALUES ($1, false, NULL, NOW())`,
      [url]
    )
    await pool.query(
      `UPDATE mints SET last_error = $1 WHERE url = $2`,
      ['DNS resolution failed', url]
    )
    return
  }

  const start = Date.now()
  let online = false
  let latencyMs: number | null = null
  let lastError: string | null = null
  let capturedErr: unknown = null
  let contactCount: number | null = null

  try {
    let res = await safeFetch(`${url}/v1/info`, {
      timeoutMs: PROBE_TIMEOUT_MS,
      onError: (err) => { capturedErr = err },
    })

    // Retry once on network/DNS failure (res === null) — avoids false-positive offline
    if (res === null) {
      await new Promise<void>(r => setTimeout(r, 1000))
      capturedErr = null
      res = await safeFetch(`${url}/v1/info`, {
        timeoutMs: PROBE_TIMEOUT_MS,
        onError: (err) => { capturedErr = err },
      })
    }

    if (res && res.ok) {
      try {
        const raw = await res.json() as Record<string, unknown>
        const nuts = raw['nuts'] !== null && typeof raw['nuts'] === 'object' ? raw['nuts'] as Record<string, unknown> : null
        if (nuts === null) {
          lastError = 'Invalid Cashu response'
        } else {
          online = true
          latencyMs = Date.now() - start
          const iconUrl = typeof raw['icon_url'] === 'string' && raw['icon_url'].startsWith('https://')
            ? raw['icon_url']
            : null
          const version = typeof raw['version'] === 'string' ? raw['version'] : null
          const tosUrl = typeof raw['tos_url'] === 'string' ? raw['tos_url'] : null
          const descriptionLong = typeof raw['description_long'] === 'string' ? raw['description_long'] : null
          const nutCount = Object.keys(nuts).length
          const nameRaw = typeof raw['name'] === 'string' ? raw['name'].trim().slice(0, 100) : null
          const name = nameRaw && nameRaw.length > 0 ? nameRaw : null

          const contactArr = Array.isArray(raw['contact']) ? raw['contact'] as Array<{ method: string }> : []
          contactCount = contactArr.filter(c => c.method === 'email' || c.method === 'twitter' || c.method === 'nostr').length

          const storedVersionRes = await pool.query('SELECT version FROM mints WHERE url = $1', [url])
          const storedVersion = storedVersionRes.rows[0]?.version as string | null

          const { units, mintMethods, meltMethods } = parseMintMethods(nuts)

          await pool.query(
            `UPDATE mints SET
              name             = COALESCE($1, name),
              icon_url         = COALESCE($2, icon_url),
              version          = COALESCE($3, version),
              nut_count        = COALESCE($4, nut_count),
              tos_url          = COALESCE($5, tos_url),
              description_long = COALESCE($6, description_long),
              nuts_limits      = COALESCE($7::jsonb, nuts_limits),
              units            = COALESCE($9::jsonb, units),
              mint_methods     = COALESCE($10::jsonb, mint_methods),
              melt_methods     = COALESCE($11::jsonb, melt_methods),
              -- not COALESCE'd: 0 is a meaningful value here (mint publishes no
              -- contact methods), and this line only runs on a successful probe
              contact_count    = $12
            WHERE url = $8`,
            [
              name, iconUrl, version, nutCount, tosUrl, descriptionLong, JSON.stringify(nuts), url,
              units !== null ? JSON.stringify(units) : null,
              mintMethods !== null ? JSON.stringify(mintMethods) : null,
              meltMethods !== null ? JSON.stringify(meltMethods) : null,
              contactCount,
            ]
          )

          if (version !== null && version !== storedVersion) {
            await pool.query(
              `INSERT INTO mint_version_history (url, version, first_seen_at)
               VALUES ($1, $2, NOW())
               ON CONFLICT (url, version) DO NOTHING`,
              [url, version]
            )
          }

        }
      } catch { lastError = 'Invalid JSON response' }

      // Geo-IP lookup — isolated so errors never affect probe result or lastError
      if (online) {
        try {
          const locRow = await pool.query('SELECT server_location FROM mints WHERE url = $1', [url])
          const currentLoc = locRow.rows[0]?.server_location as string | null | undefined
          if (currentLoc == null) {
            const location = await lookupServerLocation(url)
            if (location !== null) {
              await pool.query('UPDATE mints SET server_location = $1 WHERE url = $2', [location, url])
            }
          }
        } catch (err) {
          console.error('[geo] db error during location update:', err)
        }
      }
    } else if (res && res.status === 429) {
      // Rate-limited — mint is up, just throttling us. Skip this probe cycle
      // entirely rather than recording a false-positive offline.
      return
    } else if (res && [502, 503, 504].includes(res.status)) {
      // Likely a transient server-side blip (restart/deploy) — retry once
      // before concluding the mint is offline.
      await new Promise<void>(r => setTimeout(r, 2000))
      const retryRes = await safeFetch(`${url}/v1/info`, {
        timeoutMs: PROBE_TIMEOUT_MS,
        onError: (err) => { capturedErr = err },
      })
      if (retryRes && retryRes.ok) {
        try {
          const raw = await retryRes.json() as Record<string, unknown>
          const nuts = raw['nuts'] !== null && typeof raw['nuts'] === 'object' ? raw['nuts'] as Record<string, unknown> : null
          if (nuts === null) {
            lastError = 'Invalid Cashu response'
          } else {
            online = true
            latencyMs = Date.now() - start
          }
        } catch { lastError = 'Invalid JSON response' }
      } else if (retryRes && !retryRes.ok) {
        lastError = `HTTP ${retryRes.status}`
      } else {
        lastError = classifyFetchError(capturedErr)
      }
    } else if (res && !res.ok) {
      lastError = `HTTP ${res.status}`
    } else {
      lastError = classifyFetchError(capturedErr)
    }
  } catch {
    lastError = 'Unreachable'
  }

  // Snapshot the previous state before inserting the new row, so a
  // down/up transition can be detected. No prior row (first-ever probe of
  // this mint) means nothing to compare against — skip detection entirely.
  const prevRow = await pool.query(
    'SELECT online FROM mint_history WHERE url = $1 ORDER BY checked_at DESC LIMIT 1',
    [url]
  )
  const previousOnline: boolean | null = prevRow.rows.length > 0 ? (prevRow.rows[0].online as boolean) : null

  const histInsert = await pool.query(
    `INSERT INTO mint_history (url, online, latency_ms, checked_at)
     VALUES ($1, $2, $3, NOW())
     RETURNING id`,
    [url, online, latencyMs]
  )
  const histId: number | undefined = histInsert.rows[0]?.id as number | undefined

  // Maintain `invalid_since` — the marker revalidateMints() reaps on. A probe
  // that REACHES the host but gets something that isn't the Cashu mint API
  // (a 4xx, or a 200 whose body has no `nuts` object) is the signature of a URL
  // repointed to a non-mint host after it first passed validation. Network
  // errors / 5xx / timeouts are transient and must NOT advance the reap clock.
  if (online) {
    await pool.query('UPDATE mints SET invalid_since = NULL WHERE url = $1', [url])
  } else if (
    lastError === 'Invalid Cashu response' ||
    lastError === 'Invalid JSON response' ||
    /^HTTP 4\d\d$/.test(lastError ?? '')
  ) {
    await pool.query('UPDATE mints SET invalid_since = COALESCE(invalid_since, NOW()) WHERE url = $1', [url])
  }

  if (previousOnline !== null && isNotificationServiceEnabled()) {
    let direction: 'down' | 'up' | null = null
    if (previousOnline === true && online === false) direction = 'down'
    else if (previousOnline === false && online === true) direction = 'up'
    if (direction !== null) {
      // Fire-and-forget: notifySubscribers has its own internal try/catch and
      // never throws, so this can't block or serialize with the next probe.
      void notifySubscribers(url, direction, new Date()).catch(err => {
        console.error(`[notify] unhandled notifySubscribers error for ${url}:`, err)
      })
    }
  }

  try {
    const statsRes = await pool.query(
      `SELECT
        m.nut_count, m.version, m.contact_count,
        m.audit_recent_total, m.audit_recent_errors,
        COUNT(h.online) AS total,
        COALESCE(SUM(CASE WHEN h.online THEN 1 ELSE 0 END), 0) AS online_count
       FROM mints m
       LEFT JOIN mint_history h
         ON h.url = m.url AND h.checked_at > NOW() - INTERVAL '24 hours'
       WHERE m.url = $1
       GROUP BY m.nut_count, m.version, m.contact_count, m.audit_recent_total, m.audit_recent_errors`,
      [url]
    )
    const row = statsRes.rows[0]
    if (row) {
      const total = Number(row.total)
      const onlineCount = Number(row.online_count)
      const uptimePct = total === 0
        ? (online ? 100 : 0)
        : Math.round((onlineCount / total) * 100)
      // A failed probe never reaches /v1/info, so it learns nothing about the
      // mint's contact methods (contactCount stays null). Falling back to the
      // stored value keeps a temporarily-unreachable mint from also losing its
      // contact points on top of its uptime points — the metadata didn't change,
      // only our ability to read it did.
      const effectiveContactCount = contactCount ?? Number(row.contact_count ?? 0)
      const latestVersions = await getLatestVersionsMap()
      const trustScore = computeServerTrustScore(
        uptimePct,
        row.nut_count as number | null,
        row.version as string | null,
        effectiveContactCount,
        row.audit_recent_total as number | null,
        row.audit_recent_errors as number | null,
        latestVersions
      )
      await pool.query(
        `UPDATE mints SET last_trust_score = $1, last_error = $2 WHERE url = $3`,
        [trustScore, lastError, url]
      )
      if (histId !== undefined) {
        await pool.query(
          `UPDATE mint_history SET trust_score = $1 WHERE id = $2`,
          [trustScore, histId]
        )
      }
    }
  } catch { /* ignore trust score errors */ }
}

export async function pruneOldHistory(): Promise<void> {
  await pool.query(
    `DELETE FROM mint_history
     WHERE checked_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`
  )
}

export async function getKnownMints(): Promise<string[]> {
  const res = await pool.query('SELECT url FROM mints')
  return res.rows.map(r => r.url as string)
}

export async function upsertMint(url: string, name?: string, isKnown = false): Promise<void> {
  await pool.query(
    `INSERT INTO mints (url, name, is_known)
     VALUES ($1, $2, $3)
     ON CONFLICT (url) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, mints.name),
       is_known = mints.is_known OR EXCLUDED.is_known`,
    [url, name ?? null, isKnown]
  )
}
