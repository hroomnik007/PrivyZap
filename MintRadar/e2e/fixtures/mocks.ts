import type { Page } from '@playwright/test'
import { nip19 } from 'nostr-tools'
import { Amount, getEncodedToken } from '@cashu/cashu-ts'

// ── Mock mint data ─────────────────────────────────────────────
// Deterministic fixtures used by every E2E test so flows never depend on the
// real backend, the live database, or Nostr relays. Shapes mirror the API
// contracts the frontend consumes (see src/hooks/useKnownMints.ts and the
// /api/* endpoints documented in CLAUDE.md).

export interface MockMint {
  url: string
  name: string
  online: boolean
  latencyMs: number | null
  trustScore: number | null
  version: string | null
  nutCount: number
  uptimePct24h: number | null
  discoveredAt: string
  /** Units this mint issues, as persisted by prober.ts's parseMintMethods(). */
  units: string[] | null
  /** NIP-87 review rollup (backend 6h reviews sync). */
  reviewCount?: number | null
  reviewAvgRating?: number | null
  /** "Recent review surge" sybil flag (backend/src/reviewSurge.ts). */
  reviewSurge?: boolean
}

// Mirror of backend/src/weightedRating.ts for the Rating-sort fixture payload.
const RATING_SORT_M = 8
function mockGlobalMeanRating(mints: MockMint[]): number | null {
  const rated = mints.filter(m => (m.reviewCount ?? 0) >= 1 && m.reviewAvgRating != null)
  if (rated.length === 0) return null
  return rated.reduce((s, m) => s + (m.reviewAvgRating as number), 0) / rated.length
}
function mockWeightedRating(m: MockMint, globalMean: number | null): number | null {
  if (m.reviewAvgRating == null || globalMean == null) return null
  const v = Math.max(0, m.reviewCount ?? 0)
  return (v / (v + RATING_SORT_M)) * m.reviewAvgRating + (RATING_SORT_M / (v + RATING_SORT_M)) * globalMean
}

const now = Date.now()
const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString()

// Ordering matters for the sort assertions:
//   name asc   → Alpha, Bravo, Charlie, Delta
//   latency ↑  → Alpha(50), Delta(120), Bravo(300), Charlie(offline)
//   trust  ↓   → Alpha(92), Delta(78), Bravo(55), Charlie(0)
export const MOCK_MINTS: MockMint[] = [
  { url: 'https://alpha.mint.example',   name: 'Alpha Mint',   online: true,  latencyMs: 50,   trustScore: 92, version: 'Nutshell/0.16.0', nutCount: 12, uptimePct24h: 99, discoveredAt: daysAgo(400), units: ['sat'], reviewCount: 12, reviewAvgRating: 4.2 },
  { url: 'https://bravo.mint.example',   name: 'Bravo Mint',   online: true,  latencyMs: 300,  trustScore: 55, version: 'Nutshell/0.15.0', nutCount: 8,  uptimePct24h: 80, discoveredAt: daysAgo(10),  units: ['sat', 'usd'], reviewCount: 0, reviewAvgRating: null },
  { url: 'https://charlie.mint.example', name: 'Charlie Mint', online: false, latencyMs: null, trustScore: null, version: null,            nutCount: 0,  uptimePct24h: 12, discoveredAt: daysAgo(120), units: null, reviewCount: 4, reviewAvgRating: 3 },
  { url: 'https://delta.mint.example',   name: 'Delta Mint',   online: true,  latencyMs: 120,  trustScore: 78, version: 'Nutshell/0.20.0', nutCount: 14, uptimePct24h: 95, discoveredAt: daysAgo(200), units: ['sat'], reviewCount: 3, reviewAvgRating: 4.8 },
]

const NUT_POOL = ['4', '5', '7', '8', '9', '10', '11', '12', '13', '14', '15', '17', '19', '20']

function buildNuts(count: number): Record<string, unknown> {
  const nuts: Record<string, unknown> = {}
  for (let i = 0; i < count && i < NUT_POOL.length; i++) {
    nuts[NUT_POOL[i]!] = { methods: [] }
  }
  return nuts
}

// NUT-04/NUT-05 method entries, one per unit — the shape prober.ts persists into
// mint_methods/melt_methods and the Best Mint Wizard reads per-unit limits from.
function buildMethods(units: string[] | null, min: number, max: number) {
  if (!units) return null
  return units.map(unit => ({ method: 'bolt11', unit, min_amount: min, max_amount: max }))
}

const MOCK_GLOBAL_MEAN_RATING = mockGlobalMeanRating(MOCK_MINTS)

function knownMintPayload(m: MockMint) {
  return {
    url: m.url,
    name: m.name,
    iconUrl: null,
    degraded: false,
    online: m.online,
    latencyMs: m.latencyMs,
    version: m.version,
    nutCount: m.nutCount || null,
    tosUrl: null,
    descriptionLong: null,
    nutsLimits: buildNuts(m.nutCount),
    units: m.units,
    mintMethods: buildMethods(m.units, 1, 1_000_000),
    meltMethods: buildMethods(m.units, 1, 500_000),
    auditNMints: 100,
    auditNMelts: 50,
    auditNErrors: 0,
    auditCheckedAt: daysAgo(1),
    // Our own 6h discovery cron's last write time (drives "Last checked X ago").
    auditSyncedAt: new Date(now - 3 * 3_600_000).toISOString(),
    // Rolling ~100-swap window (audit.8333.space /swaps/mint/{id}); individual
    // specs override this for the <3-sample and no-audit cases.
    auditRecentTotal: 100,
    auditRecentErrors: 0,
    discoveredAt: m.discoveredAt,
    trustScore: m.trustScore,
    lastError: null,
    uptimePct24h: m.uptimePct24h,
    serverLocation: 'Germany',
    lastCheckedAt: new Date(now - 60_000).toISOString(),
    reviewCount: m.reviewCount ?? null,
    reviewAvgRating: m.reviewAvgRating ?? null,
    reviewWeightedRating: mockWeightedRating(m, MOCK_GLOBAL_MEAN_RATING),
    reviewSurge: m.reviewSurge ?? false,
  }
}

export const MOCK_KNOWN_MINTS = MOCK_MINTS.map(knownMintPayload)

export const MOCK_STATS = {
  totalMints: MOCK_MINTS.length,
  onlineMints: MOCK_MINTS.filter(m => m.online).length,
  offlineMints: MOCK_MINTS.filter(m => !m.online).length,
  avgTrustScore: 75,
  avgLatency24h: 110,
  trustDistribution: { low: 1, moderate: 1, high: 2 },
  nutAdoption: NUT_POOL.map((nut, i) => ({ nut: `NUT-${nut.padStart(2, '0')}`, count: 4 - (i % 3), percent: 80 - i * 3 })),
  top5ByTrustScore: MOCK_MINTS.filter(m => m.online && m.trustScore != null)
    .sort((a, b) => (b.trustScore ?? 0) - (a.trustScore ?? 0))
    .map(m => ({ url: m.url, name: m.name, trustScore: m.trustScore as number })),
}

export const MOCK_TRUST_MOVERS = {
  risers: [
    { url: 'https://alpha.mint.example', name: 'Alpha Mint', delta: 12 },
    { url: 'https://echo.mint.example', name: 'Echo Mint', delta: 7 },
  ],
  fallers: [
    { url: 'https://bravo.mint.example', name: 'Bravo Mint', delta: -9 },
  ],
}

function probePayload(url: string) {
  const m = MOCK_MINTS.find(x => x.url === url)
  const name = m?.name ?? 'Unknown Mint'
  const version = m?.version ?? 'Nutshell/0.16.0'
  const nutCount = m?.nutCount && m.nutCount > 0 ? m.nutCount : 12
  return {
    url,
    online: m ? m.online : true,
    latencyMs: m?.latencyMs ?? 90,
    info: {
      name,
      version,
      description: `${name} — a test mint`,
      motd: 'Welcome to the test mint',
      pubkey: '02' + 'ab'.repeat(32),
      nuts: buildNuts(nutCount),
      contact: [{ method: 'email', info: 'admin@example.com' }],
    },
    keysets: [{ id: '00ad268c4d1f5826', unit: 'sat', active: true }],
    checkedAt: new Date().toISOString(),
  }
}

function historyPayload() {
  const bucket = new Date(now - 3_600_000).toISOString()
  return {
    period: '24h',
    segments: [
      { bucket, online: true, latencyMs: 50, total: 12, onlineCount: 12, uptimePct: 100, trustScore: 92 },
    ],
    uptimePct: 99,
    avgLatencyMs: 55,
    prevUptimePct: 98,
    prevAvgLatencyMs: 60,
    earliestCheckedAt: daysAgo(30),
    daysOfDataAvailable: 1,
    periodDays: 1,
    prevPeriodInsufficientHistory: false,
    history: [{ online: true, latencyMs: 50, checkedAt: bucket }],
  }
}

// ── Test helpers ───────────────────────────────────────────────

/**
 * Intercept every backend API call with deterministic fixtures so tests never
 * touch the real backend, DB, or production data.
 */
export async function installApiMocks(page: Page): Promise<void> {
  await page.route('**/api/mints/known', route =>
    route.fulfill({ json: MOCK_KNOWN_MINTS }),
  )
  await page.route('**/api/stats', route => route.fulfill({ json: MOCK_STATS }))
  await page.route('**/api/stats/trust-trend**', route => route.fulfill({ json: { trend: [], periodDays: 30, earliestCheckedAt: null, daysOfDataAvailable: 0 } }))
  await page.route('**/api/stats/trust-movers**', route => {
    const u = new URL(route.request().url())
    const period = u.searchParams.get('period') === '30d' ? '30d' : '7d'
    route.fulfill({ json: { period, ...MOCK_TRUST_MOVERS } })
  })
  await page.route('**/api/mints/history**', route => route.fulfill({ json: historyPayload() }))
  await page.route('**/api/mints/version-history**', route =>
    route.fulfill({ json: { history: [{ version: 'Nutshell/0.16.0', firstSeenAt: daysAgo(30) }], latestGlobalVersion: 'Nutshell/0.16.0' } }),
  )
  await page.route('**/api/mints/daily-uptime**', route => route.fulfill({ json: [] }))
  await page.route('**/api/mints/nostr-reviews**', route => route.fulfill({ json: [] }))
  await page.route('**/api/mint/probe**', route => {
    const u = new URL(route.request().url())
    const target = u.searchParams.get('url') ?? ''
    route.fulfill({ json: probePayload(target) })
  })
  await page.route('**/api/mint/submit', route =>
    route.fulfill({ json: { success: true, name: 'Submitted Mint' } }),
  )
  // Direct mint reachability checks (Best Mint Wizard latency probe, client-side
  // latency button) hit the mint's own /v1/info — stub them so they resolve fast
  // instead of waiting on real DNS/network.
  await page.route('**/v1/info', route => route.fulfill({ json: { name: 'Mint', nuts: {} } }))
}

/**
 * Stub every outbound Nostr relay WebSocket (wss://) with an empty in-memory
 * relay: it answers each REQ subscription with an immediate EOSE (end of stored
 * events) and ACKs any published EVENT. This makes all relay reads (reviews,
 * profiles, discovery, watchlist sync) resolve to empty deterministically and
 * fast, with no real network. Vite's HMR socket (ws://) is left untouched.
 */
export async function mockRelays(page: Page): Promise<void> {
  await page.routeWebSocket(/^wss:\/\//, ws => {
    ws.onMessage(message => {
      const data = typeof message === 'string' ? message : message.toString()
      let parsed: unknown
      try { parsed = JSON.parse(data) } catch { return }
      if (!Array.isArray(parsed)) return
      const [verb, arg] = parsed as [string, unknown]
      if (verb === 'REQ') {
        ws.send(JSON.stringify(['EOSE', arg]))
      } else if (verb === 'EVENT') {
        const id = (arg as { id?: string } | undefined)?.id ?? ''
        ws.send(JSON.stringify(['OK', id, true, '']))
      }
    })
  })
}

export const TEST_PUBKEY_HEX = '1'.repeat(64)

/**
 * Simulate a logged-in Nostr (NIP-07) session.
 *
 * Two things are injected before any app code runs:
 *  1. A `window.nostr` NIP-07 mock (so feature-detection + any signing stubs
 *     succeed without a real browser extension or private key).
 *  2. The persisted auth-store session in sessionStorage, so the app boots
 *     already authenticated without driving the modal/relay login flow.
 */
export async function loginAs(
  page: Page,
  name = 'E2E Tester',
  method: 'nip07' | 'nsec' | 'remote-signer' = 'nip07',
): Promise<void> {
  const npub = nip19.npubEncode(TEST_PUBKEY_HEX)
  await page.addInitScript(
    ({ pubkey, npub, name, method }) => {
      // 1) NIP-07 extension mock
      ;(window as unknown as { nostr: unknown }).nostr = {
        getPublicKey: async () => pubkey,
        signEvent: async (event: Record<string, unknown>) => ({
          ...event,
          id: 'f'.repeat(64),
          pubkey,
          sig: '0'.repeat(128),
        }),
        nip04: {
          encrypt: async (_pk: string, text: string) => text,
          decrypt: async (_pk: string, text: string) => text,
        },
        nip44: {
          encrypt: async (_pk: string, text: string) => text,
          decrypt: async (_pk: string, text: string) => text,
        },
      }
      // 2) Persisted auth session (zustand persist → sessionStorage)
      sessionStorage.setItem(
        'mintradar_session',
        JSON.stringify({ state: { profile: { pubkey, npub, name }, method }, version: 0 }),
      )
    },
    { pubkey: TEST_PUBKEY_HEX, npub, name, method },
  )
}

/**
 * Build a valid cashuA (v3) token string for the given mint + amounts.
 * Mirrors the decoder in src/pages/Tools.tsx (base64url, no padding).
 */
/**
 * v4 (cashuB, CBOR) token — encoded with the same library the app decodes with,
 * so the fixture can't drift from the real wire format.
 */
export function makeCashuTokenV4(mint: string, amounts: number[], unit = 'sat'): string {
  return getEncodedToken({
    mint,
    unit,
    proofs: amounts.map(amount => ({
      id: '009a1f293253e41e',
      amount: Amount.from(amount),
      secret: `secret-${amount}`,
      C: '02bc9097997d81afb2cc7346b5e4345a9346bd2a506eb7958598a72f0cf85163ea',
    })),
  })
}

/** v3 (cashuA, base64url JSON) token — the legacy encoding, built by hand. */
export function makeCashuToken(mint: string, amounts: number[], unit = 'sat', memo?: string): string {
  const payload = {
    token: [{ mint, proofs: amounts.map(amount => ({ amount, secret: 'x', C: '02abc' })) }],
    unit,
    ...(memo ? { memo } : {}),
  }
  const base64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64')
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return 'cashuA' + base64url
}
