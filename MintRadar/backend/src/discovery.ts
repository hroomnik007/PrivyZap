import { SimplePool, verifyEvent } from 'nostr-tools'
import { normalizeURL as normalizeRelayUrl } from 'nostr-tools/utils'
import type { Filter } from 'nostr-tools'
import WebSocket from 'ws'
import { pool } from './db.js'
import { probeMintToDb, isValidCashuMint } from './prober.js'

// Fast string-based pre-filter. isSafeUrl() in probeMintToDb is the authoritative SSRF
// gate (ipaddr.js + full DNS resolution). This just avoids inserting obvious junk into DB.
function isObviouslyPrivate(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0') return true
  // loopback, private, link-local (169.254/16), CGNAT (100.64/10)
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.)/u.test(hostname)
}

// Normalizes a mint URL: enforces https, lowercases hostname, strips trailing slash.
// Handles cases that would otherwise create duplicate DB rows:
//   uppercase hostname (https://Mint.coinos.io → https://mint.coinos.io)
//   trailing slash    (https://mint.example.com/ → https://mint.example.com)
//   http scheme       (http://mint.example.com  → https://mint.example.com)
// NOTE: pathname = '' is ignored by WHATWG URL parser (normalizes back to '/'),
// so trailing slash removal is done via string replace on the final output.
export function normalizeUrl(raw: string): string {
  try {
    const parsed = new URL(raw.trim())
    parsed.protocol = 'https:'
    parsed.hostname = parsed.hostname.toLowerCase()
    let result = parsed.toString()
    if (parsed.pathname === '/') {
      result = result.replace(/\/$/, '')
    }
    return result
  } catch {
    return raw.trim()
  }
}

// Mirrors the frontend's DISCOVERY_RELAYS (src/core/nostr/relays.ts) — the two packages
// can't share a module directly (separate npm packages, no workspace set up), so keep
// these two arrays in sync manually when editing either one.
const DISCOVERY_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://purplepag.es',
  'wss://relay.snort.social',
  'wss://relay.primal.net',
  'wss://relay.cashumints.space',
  'wss://relay.azzamo.net',
  'wss://eden.nostr.land',
  'wss://nostr.wine',
  'wss://nostr-pub.wellorder.net',
  'wss://offchain.pub',
  'wss://relay.8333.space',
  'wss://nostr.oxtr.dev',
  'wss://relay.nostr.net',
  'wss://nostr21.com',
  'wss://nostr.bitcoiner.social',
  'wss://nostr.cypherpunk.today',
]

const DISCOVERY_TIMEOUT_MS = 15_000

// Renders "relay.damus.io=12, nos.lol=8" for a discovery pass, busiest relay first.
// Counts come from SimplePool's `seenOn` map (event id → relays that served it), so a
// single event fetched from five relays is counted once per relay — these are per-relay
// delivery counts, not a partition of the total.
function formatRelayBreakdown<R extends { url: string }>(
  events: { id: string }[],
  seenOn: Map<string, Set<R>>,
): string {
  const counts = new Map<string, number>()
  for (const event of events) {
    for (const relay of seenOn.get(event.id) ?? []) {
      counts.set(relay.url, (counts.get(relay.url) ?? 0) + 1)
    }
  }
  if (counts.size === 0) return 'no per-relay attribution available'
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url, n]) => `${url.replace(/^wss:\/\//, '').replace(/\/$/, '')}=${n}`)
    .join(', ')
}

// Same `seenOn` attribution formatRelayBreakdown() uses above, but reduced to just the set
// of relay URLs that delivered at least one event — the source of truth for "did this relay
// respond this cycle" (see computeSilentRelays() below). URLs here are in nostr-tools'
// normalized form (relay.url is set via normalizeURL() internally), matching seenOn's keys.
export function relayUrlsThatResponded<R extends { url: string }>(
  events: { id: string }[],
  seenOn: Map<string, Set<R>>,
): Set<string> {
  const urls = new Set<string>()
  for (const event of events) {
    for (const relay of seenOn.get(event.id) ?? []) {
      urls.add(relay.url)
    }
  }
  return urls
}

// A relay is "silent" if it never failed to connect AND its normalized URL never showed up
// among the relays that actually delivered an event (either kind) this cycle. Both sides are
// run through nostr-tools' own normalizeURL() before comparing — `discoveryRelays` entries
// have no trailing slash, while `respondedRelays` URLs (from relay.url, via seenOn) always
// do, so comparing the raw strings directly would never match and would misreport every
// non-failed relay as silent regardless of what it actually returned.
export function computeSilentRelays(
  discoveryRelays: string[],
  failedRelays: ReadonlySet<string>,
  respondedRelays: ReadonlySet<string>,
): string[] {
  return discoveryRelays.filter(
    url => !failedRelays.has(url) && !respondedRelays.has(normalizeRelayUrl(url))
  )
}

export async function discoverMintsFromNostr(): Promise<number> {
  // Node.js 20 has no native WebSocket — inject ws polyfill for nostr-tools
  if (!globalThis.WebSocket) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).WebSocket = WebSocket
  }
  // NOTE: this SimplePool is the ROOT nostr-tools one — it connects via the
  // plain `globalThis.WebSocket` above, NOT the connect-time DNS-pinned
  // `DnsPinnedWebSocket` that nostrService.ts installs for the notification
  // relay path. That's fine ONLY because DISCOVERY_RELAYS is a hardcoded
  // constant — there is no attacker-controlled relay host here. If a dynamic /
  // user-supplied relay list is ever added to discovery, switch this to the
  // pinned pool (import SimplePool + useWebSocketImplementation from
  // 'nostr-tools/pool' and register DnsPinnedWebSocket) — otherwise it becomes
  // an SSRF vector. Same caveat applies to reviewsSync.ts.
  const nostrPool = new SimplePool()
  // Opt into per-event relay attribution so the logs below can show which relay actually
  // served what. Off by default in nostr-tools; it only costs a Map of event id → relays
  // for the lifetime of this pool, which is destroyed at the end of the cycle.
  nostrPool.trackRelays = true

  // Relays that never got far enough to answer. `onRelayConnectionFailure` is a public
  // field rather than a SimplePool constructor option, so it is assigned here.
  const failedRelays = new Set<string>()
  nostrPool.onRelayConnectionFailure = (url: string) => { failedRelays.add(url) }

  const discovered38172: Set<string> = new Set()
  const discovered38000: Set<string> = new Set()
  // Relay URLs (normalized) that delivered at least one event this cycle, across either
  // kind — fed by relayUrlsThatResponded() below, feeds computeSilentRelays() in `finally`.
  const respondedRelays = new Set<string>()

  try {
    const [res38172, res38000] = await Promise.allSettled([
      Promise.race([
        nostrPool.querySync(DISCOVERY_RELAYS, { kinds: [38172], limit: 1000 } as Filter),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), DISCOVERY_TIMEOUT_MS)
        ),
      ]),
      Promise.race([
        nostrPool.querySync(DISCOVERY_RELAYS, { kinds: [38000], limit: 2000 } as Filter),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), DISCOVERY_TIMEOUT_MS)
        ),
      ]),
    ])

    if (res38172.status === 'fulfilled') {
      console.log(
        `[discovery] kind:38172 per-relay: ${formatRelayBreakdown(res38172.value, nostrPool.seenOn)} ` +
        `(${res38172.value.length} events total)`
      )
      for (const url of relayUrlsThatResponded(res38172.value, nostrPool.seenOn)) respondedRelays.add(url)
      for (const event of res38172.value.filter(e => verifyEvent(e))) {
        const uTag = event.tags.find((t: string[]) => t[0] === 'u')
        if (!uTag || !uTag[1]) continue
        const raw = uTag[1].trim()
        if (!raw.startsWith('https://')) continue
        try {
          const parsed = new URL(raw)
          const h = parsed.hostname.toLowerCase().replace(/\.$/, '')
          if (isObviouslyPrivate(h)) continue
          discovered38172.add(normalizeUrl(raw))
        } catch { continue }
      }
    } else {
      console.error('[discovery] NIP-87 fetch error:', res38172.reason)
    }

    if (res38000.status === 'fulfilled') {
      console.log(
        `[discovery] kind:38000 per-relay: ${formatRelayBreakdown(res38000.value, nostrPool.seenOn)} ` +
        `(${res38000.value.length} events total)`
      )
      for (const url of relayUrlsThatResponded(res38000.value, nostrPool.seenOn)) respondedRelays.add(url)
      for (const event of res38000.value.filter(e => verifyEvent(e))) {
        for (const tag of event.tags as string[][]) {
          if (tag[0] !== 'u' || typeof tag[1] !== 'string' || !tag[1].startsWith('https://')) continue
          const raw = tag[1].trim()
          try {
            const parsed = new URL(raw)
            const h = parsed.hostname.toLowerCase().replace(/\.$/, '')
            if (isObviouslyPrivate(h)) continue
            discovered38000.add(normalizeUrl(raw))
          } catch { continue }
        }
      }
    } else {
      console.error('[discovery] kind:38000 fetch error:', res38000.reason)
    }
  } finally {
    // Two different failure modes, logged separately because they mean different things:
    // a relay that never connected at all, vs. one that connected but delivered zero events
    // to either kind this cycle (which can be legitimate — it may simply hold no NIP-87
    // events). "Silent" is decided from the same seenOn attribution the per-relay breakdown
    // logs above use (via respondedRelays/computeSilentRelays), NOT from a live WebSocket
    // connection check — a relay's connection state at the end of the cycle says nothing
    // about whether it actually returned data, and comparing DISCOVERY_RELAYS' un-normalized
    // URLs against listConnectionStatus()'s normalized (trailing-slash) keys meant this used
    // to misreport every connected relay as silent every cycle, regardless of reality.
    if (failedRelays.size > 0) {
      console.warn(
        `[discovery] relay(s) unreachable this cycle (${failedRelays.size}/${DISCOVERY_RELAYS.length}): ` +
        [...failedRelays].join(', ')
      )
    }
    const silent = computeSilentRelays(DISCOVERY_RELAYS, failedRelays, respondedRelays)
    if (silent.length > 0) {
      console.warn(
        `[discovery] relay(s) connected but returned nothing (${silent.length}/${DISCOVERY_RELAYS.length}): ` +
        silent.join(', ')
      )
    }
    nostrPool.destroy()
  }

  let added38172 = 0
  for (const url of discovered38172) {
    if (!(await isValidCashuMint(url))) continue
    const r = await pool.query(
      'INSERT INTO mints (url, is_known) VALUES ($1, true) ON CONFLICT (url) DO NOTHING',
      [url]
    )
    if ((r.rowCount ?? 0) > 0) added38172++
  }
  console.log(`[discovery] kind:38172 found ${discovered38172.size} mints, added ${added38172} new`)

  let added38000 = 0
  for (const url of discovered38000) {
    if (!(await isValidCashuMint(url))) continue
    const r = await pool.query(
      'INSERT INTO mints (url, is_known) VALUES ($1, true) ON CONFLICT (url) DO NOTHING',
      [url]
    )
    if ((r.rowCount ?? 0) > 0) added38000++
  }
  console.log(`[discovery] kind:38000 found ${discovered38000.size} mints, added ${added38000} new`)

  return added38172 + added38000
}

const AUDIT_API_BASE = 'https://api.audit.8333.space/mints/'
const AUDIT_PAGE_SIZE = 100
const AUDIT_MAX_RECORDS = 10_000
const AUDIT_SWAPS_BASE = 'https://api.audit.8333.space/swaps/mint/'
// Rolling-window sample size for the reliability score — matches the reference
// pablof7z/cashu-mint-audit project ("last ~100 swaps") instead of audit.8333.space's
// cumulative lifetime counters. See auditReliabilityScore() in shared/auditScore.ts.
const AUDIT_SWAPS_WINDOW = 100
// Small delay between per-mint swap-history requests so a ~65-mint discovery cycle doesn't
// hammer audit.8333.space with a burst of back-to-back requests.
const AUDIT_SWAPS_DELAY_MS = 150

interface AuditRecord {
  id: number
  url: string
  n_mints?: number | null
  n_melts?: number | null
  n_errors?: number | null
  updated_at?: string | null
}

interface RecentSwapStats {
  total: number
  errors: number
}

// Fetches the mint's last ~100 swaps (as either source or destination) from
// audit.8333.space and counts how many failed, for the rolling-window reliability score.
async function fetchRecentSwapStats(auditId: number): Promise<RecentSwapStats | null> {
  try {
    const url = `${AUDIT_SWAPS_BASE}${auditId}?limit=${AUDIT_SWAPS_WINDOW}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const data: unknown = await res.json()
    if (!Array.isArray(data)) return null
    let errors = 0
    for (const item of data) {
      if (typeof item !== 'object' || item === null) continue
      if ((item as Record<string, unknown>)['state'] !== 'OK') errors++
    }
    return { total: data.length, errors }
  } catch (err) {
    console.error(`[discovery] audit.8333.space swaps fetch error (mint ${auditId}):`, err)
    return null
  }
}

export async function discoverMintsFromApi(): Promise<number> {
  const records: AuditRecord[] = []

  for (let skip = 0; skip < AUDIT_MAX_RECORDS; skip += AUDIT_PAGE_SIZE) {
    try {
      const url = `${AUDIT_API_BASE}?skip=${skip}&limit=${AUDIT_PAGE_SIZE}`
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) break
      const data: unknown = await res.json()
      if (!Array.isArray(data) || data.length === 0) break
      for (const record of data) {
        if (typeof record !== 'object' || record === null) continue
        const r = record as Record<string, unknown>
        const rawUrl = r['url']
        if (typeof rawUrl !== 'string') continue
        if (typeof r['id'] !== 'number') continue
        const trimmed = rawUrl.trim()
        if (!trimmed.startsWith('https://')) continue
        try {
          const parsed = new URL(trimmed)
          const h = parsed.hostname.toLowerCase().replace(/\.$/, '')
          if (isObviouslyPrivate(h)) continue
          records.push({
            id: r['id'],
            url: normalizeUrl(trimmed),
            n_mints: typeof r['n_mints'] === 'number' ? r['n_mints'] : null,
            n_melts: typeof r['n_melts'] === 'number' ? r['n_melts'] : null,
            n_errors: typeof r['n_errors'] === 'number' ? r['n_errors'] : null,
            updated_at: typeof r['updated_at'] === 'string' ? r['updated_at'] : null,
          })
        } catch { continue }
      }
      if (data.length < AUDIT_PAGE_SIZE) break
    } catch (err) {
      console.error('[discovery] audit.8333.space fetch error:', err)
      break
    }
  }

  if (records.length === 0) return 0

  let added = 0
  const toProbe: string[] = []

  for (const rec of records) {
    // Insert if new, then update audit stats for all records
    const insertResult = await pool.query(
      'INSERT INTO mints (url, is_known) VALUES ($1, true) ON CONFLICT (url) DO NOTHING',
      [rec.url]
    )
    if ((insertResult.rowCount ?? 0) > 0) {
      added++
      toProbe.push(rec.url)
    }
    await pool.query(
      `UPDATE mints SET
        audit_id = $1,
        audit_n_mints = $2,
        audit_n_melts = $3,
        audit_n_errors = $4,
        audit_checked_at = $5,
        audit_synced_at = NOW()
       WHERE url = $6`,
      [rec.id, rec.n_mints, rec.n_melts, rec.n_errors, rec.updated_at, rec.url]
    )
  }

  if (toProbe.length > 0) {
    await Promise.allSettled(toProbe.map(url => probeMintToDb(url)))
  }

  console.log(`[discovery] audit.8333.space found ${records.length} mints, added ${added} new`)

  // Rolling-window reliability data — one extra request per mint (~65 today), run as its own
  // sequential pass (rate-limited via AUDIT_SWAPS_DELAY_MS) so it doesn't block the discovery/
  // insert work above.
  let swapsUpdated = 0
  for (const rec of records) {
    const stats = await fetchRecentSwapStats(rec.id)
    if (stats) {
      await pool.query(
        `UPDATE mints SET audit_recent_total = $1, audit_recent_errors = $2 WHERE url = $3`,
        [stats.total, stats.errors, rec.url]
      )
      swapsUpdated++
    }
    await new Promise<void>(resolve => setTimeout(resolve, AUDIT_SWAPS_DELAY_MS))
  }
  console.log(`[discovery] audit.8333.space rolling-window swaps updated for ${swapsUpdated}/${records.length} mints`)

  return added
}
