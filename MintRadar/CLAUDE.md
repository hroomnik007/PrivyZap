# MintRadar — Claude Code Context

## Project
Privacy-first Cashu mint monitoring PWA.
Live: https://mintradar.org
GitHub: https://github.com/hroomnik007/MintRadar

## Server
Sensitive values are in CLAUDE.local.md (gitignored) — ask the developer

- VPS: $VPS_HOST, user: $VPS_USER
- Frontend: $VPS_DIST_PATH (served by Nginx)
- Repo: $VPS_REPO_PATH
- Backend: Node/Express, port $BACKEND_PORT, Docker
- DB: PostgreSQL in Docker ($DB_NAME, user: $DB_USER)

## Stack
- Frontend: React 19 + TypeScript + Vite 8 + TanStack Query v5 + Zustand + Dexie (IndexedDB) + Recharts + vite-plugin-pwa
- Backend: Node.js 22 + Express 5 + TypeScript + pg (PostgreSQL 17) + nostr-tools
- Auth: Nostr NIP-07 (nos2x-fox, Alby) + nsec manual entry (key held in memory for the session to enable signing, zeroed on logout — see Nostr Login below) + NIP-46 bunker (implemented, nostr-tools/nip46 BunkerSigner)
- Fonts: DM Sans (self-hosted variable, weights 100–900), JetBrains Mono (self-hosted; Regular 400, Medium 500, Bold 700)
- CSS: CSS variables — "patina/copper" palette as of 2026-07-24 (var(--bg) #10201c, var(--surface)/var(--surface-2)/var(--surface-3), var(--green)/var(--green-bright) #45ad8c/#5cc9a3, var(--copper) #c98058, var(--amber), var(--red), var(--text)/var(--text-dim)/var(--text-faint)); see "Visual Redesign" section below for details

## Architecture
- Personal watchlist → IndexedDB (never on server); logout calls resetInMemory() — Dexie NOT wiped on logout; see Watchlist Persistence below
- Public mint history → PostgreSQL (mint_history table)
- Mint discovery → NIP-87 kind:38172 server cron every 6h + client-side after Nostr login
- Backend proxy → /api/* proxied by Nginx to localhost:3002
- Cron every 5min → probes all mints via /v1/info → writes to mint_history
- Online status: mint is ONLINE only if /v1/info returns HTTP 200 with valid JSON containing `nuts` field
- Nostr DM notifications → browser-side via NIP-07 when watchlist mint goes down/up
- Reviews → NIP-87 kind:38000 events, read/write directly from browser via Nostr relays

## DB Tables

### mints
```
url TEXT PRIMARY KEY
name TEXT
discovered_at TIMESTAMPTZ DEFAULT NOW()
is_known BOOLEAN DEFAULT FALSE
icon_url TEXT
version TEXT
nut_count INTEGER
tos_url TEXT
description_long TEXT
nuts_limits JSONB
audit_n_mints INTEGER
audit_n_melts INTEGER
audit_n_errors INTEGER
audit_checked_at TIMESTAMPTZ    -- audit.8333.space's own `updated_at` for this mint
audit_synced_at TIMESTAMPTZ     -- when OUR 6h discovery cron last wrote the audit_* cols (drives Audit tab "Last checked X ago")
last_trust_score INTEGER
last_error TEXT
trust_score_7d_ago INTEGER      -- Trust Score Movers rollup (see Cron jobs)
trust_score_30d_ago INTEGER
trust_movers_checked_at TIMESTAMPTZ
```

### mint_history
```
id BIGSERIAL PRIMARY KEY
url TEXT REFERENCES mints(url) ON DELETE CASCADE
online BOOLEAN NOT NULL
latency_ms INTEGER
checked_at TIMESTAMPTZ DEFAULT NOW()
```
Index: (url, checked_at DESC)

### mint_version_history
```
id BIGSERIAL PRIMARY KEY
url TEXT REFERENCES mints(url) ON DELETE CASCADE
version TEXT NOT NULL
first_seen_at TIMESTAMPTZ DEFAULT NOW()
UNIQUE (url, version)
```

### mint_reviews (added 2026-08-30 — review-load perf work)
```
url TEXT REFERENCES mints(url) ON DELETE CASCADE
pubkey TEXT NOT NULL
event_id TEXT NOT NULL
rating INTEGER            -- null for rating-less endorsement events
comment TEXT NOT NULL DEFAULT ''   -- capped at 2000 chars on write
created_at BIGINT NOT NULL         -- nostr event created_at (unix seconds)
PRIMARY KEY (url, pubkey)          -- one row per author per mint, newest wins
```
Index: (url, created_at DESC). Populated by the 6h reviews sync (`backend/src/reviewsSync.ts`).
Rollup columns on `mints`: `review_count INTEGER`, `review_avg_rating REAL`, `reviews_checked_at TIMESTAMPTZ`.
`review_count_7d_ago INTEGER` + `review_count_7d_ago_at TIMESTAMPTZ` — rolling ~1-week-ago `review_count` snapshot, advanced once a day (`reviewSurgeRollup.ts`); feeds the informational "recent review surge" sybil flag (see Reviews Feature below).

## Backend API
- GET /health — health check
- GET /api/mints/known — all mints with online status, latency, trust score, degraded flag (TTL cached 60s)
- GET /api/mints/history?url=&period={24h|7d|30d|90d} — bucketed uptime/latency segments + prev period trend
- GET /api/mints/version-history?url= — per-mint software version timeline + latest global version
- GET /api/mints/daily-uptime?url= — daily uptime counts for last 30 days
- GET /api/stats — network-wide stats: totalMints, onlineMints, offlineMints, avgTrustScore, avgLatency24h, trustDistribution, nutAdoption, top5ByTrustScore
- GET /api/stats/trust-movers?period={7d|30d} — Trust Score risers/fallers (Stats page). As of 2026-09-01 a plain read of `mints` (`last_trust_score` + `trust_score_{7,30}d_ago` rollup columns), NOT the old two `DISTINCT ON` passes over all of `mint_history` (~2.5s cold — the "old" CTE had no time bound and `trust_score IS NOT NULL` was unindexed). Rollup is refreshed by `refreshTrustMoversRollup()` (`backend/src/trustMoversRollup.ts`) on the 5-min probe cron + ~15s after boot; partial index `idx_mint_history_score_checked ON mint_history(url, checked_at DESC) WHERE trust_score IS NOT NULL` backs its point-in-time lookups. In-memory cache TTL 10min (own `TRUST_MOVERS_CACHE_TTL`, not `KNOWN_MINTS_CACHE_TTL`). +/-3 threshold + top-3 ranking in `trustMovers.ts` (`computeTrustMovers`). Frontend panel (`src/components/stats/TrustMoversPanel.tsx`) takes `loading`/`refreshing` props — skeleton while pending, `keepPreviousData` across the 7d/30d toggle; "No data yet" shows only for a settled-but-empty result.
- GET /api/mint/probe?url= — on-demand probe of a single mint URL (unauthenticated, SSRF-guarded). **Response scope (2026-09-07 audit L5):** for a mint already in `mints` the full live `/v1/info` + keysets are returned (Mint Detail needs it; the cron already probes those hosts continuously). For any OTHER url only `online` / `latencyMs` / `checkedAt` + a stripped `info` (`name`, `version`, `nuts` with keys only — enough for the Dashboard submit preview) are returned, and `keysets: null` — so it can't be used as a general "fetch and echo the JSON body of arbitrary public host X" oracle.
- GET /api/mint/icon?url= — SSRF-safe favicon proxy (`backend/src/mintIcon.ts`). `MintFavicon` points every mint `<img>` here instead of fetching the mint-supplied `icon_url` directly — a hostile `icon_url` in a mint's `/v1/info` would otherwise turn every page view into an IP/User-Agent tracking beacon to a host the operator picks (2026-09-07 security audit). Resolves `icon_url` from the DB for a **known mint only** (never proxies an arbitrary caller URL), fetches it via `safeFetch` (SSRF guard + DNS pinning), re-serves the bytes from our origin. Raster + `.ico` only, `Content-Type` allow-list, in-process cache (6h positive / 30min negative — upstream hit ≤ once/mint/TTL). Anything unsafe/unfetchable → 404 + the client shows its bundled SVG placeholder. `Cache-Control: public, max-age=86400`; `CSP: default-src 'none'; sandbox` + `Cross-Origin-Resource-Policy: same-origin` on the response. Exempt from the per-IP rate limit.
  - **2026-09-08 (commit `23fd95e`), driven by a temporary diagnostic-logging run** (65/94 favicons were 404-ing → frontend monogram; 54 = NULL `icon_url` in DB, 5 = a 1–2 MB logo, 2 = a real image served as `application/octet-stream`, rest = upstream 429/404):
    - **Magic-bytes fallback** — `sniffRasterImageType(buf)` (exported): when the declared `Content-Type` is **not** in `ALLOWED_CONTENT_TYPES`, sniff the leading bytes for PNG (`89 50 4E 47 0D 0A 1A 0A`), JPEG (`FF D8 FF`), GIF (`GIF8`), WebP (`RIFF…WEBP`) and accept with the sniffed type. **SVG stays explicitly rejected on this path** — an `<?xml` / `<svg` guard runs before the signature checks (the M1 stored-XSS decision: a direct nav to the proxy would render SVG as a document on our origin).
    - **`MAX_ICON_BYTES` 256 KB → 512 KB.** The 1–2 MB outliers still fall back to the monogram; no native image dependency (`sharp`) was added.
  - Verified live: `cashu.cz` → 200 `image/webp`, `mint.chorus.community` → 200 `image/jpeg`. Tests in `backend/src/__tests__/mintIcon.test.ts`.
- POST /api/mint/submit — submit new mint URL { url: string }, rate limited 20/IP/hr
- POST /api/mints/discover — batch insert discovered URLs { urls: string[] }, rate limited 10/IP/hr
- GET /api/og/mint?url= — bot-only OG HTML fragment for /mint/:url, routed here by nginx UA-sniffing (see "OG tags for /mint/:url" under Security & Infrastructure Gotchas); always 200, never 404/500
- GET /api/mints/nostr-reviews?url= — **DB read from `mint_reviews`** (as of 2026-08-30; previously a live per-request kind:38000 relay query, ~3s — the biggest Mint Detail load cost). Serves the rows the 6h reviews sync populates; `Cache-Control: max-age=120`. Still the secondary source alongside the frontend's own live fetch — see "Reviews Feature" below.
- `/api/mints/known` also now carries `reviewCount` / `reviewAvgRating` (from the `mints` rollup columns) so Mint Detail's Community-rating tile renders immediately without waiting on any relay.
- POST /api/notifications/subscribe — NIP-98-authed. Body `{ mintUrl, notifyOnDown, notifyOnUp, relays: string[1..10] }`. All writes hard-scoped to the signature-verified `event.pubkey` (no IDOR). Rate limit **30/hr/pubkey**. **Per-pubkey caps** (`index.ts`, added 2026-09-07): `MAX_SUBSCRIPTIONS_PER_PUBKEY = 50` (new mint rows past this → **409** with an actionable message; updating an existing row is always allowed) and `MAX_DISTINCT_RELAYS_PER_PUBKEY = 25` (union of stored `relays` across all the pubkey's rows; over → **400**). Both are far above legit use (a user watches single-/low-double-digit mints and reuses one relay list) and exist because `notifySubscribers` fans a gift-wrap signed by `NOTIFICATION_SERVICE_NSEC` out to `row.relays ∪ NOTIFICATION_RELAYS` on every mint transition — without a total cap one free pubkey could turn a flapping mint into amplified traffic and get the service key relay-banned. Residual (not closed by per-pubkey caps): a **sybil-key** attacker (N free pubkeys, one flapping mint) — needs per-mint subscriber caps or per-IP creation accounting; tracked, not yet done. **Log-injection (2026-09-07 audit L1, commit `ac7c174`):** every relay URL from `relays[]` interpolated into `validateRelays()`'s `console.warn` lines is now run through `sanitizeLogValue()` (control chars → U+FFFD, length-capped) — run-1 #5 had fixed only the `/unsubscribe` path.
- POST /api/notifications/unsubscribe — NIP-98-authed. Body `{ mintUrl }`, normalised via `new URL()` + `normalizeUrl()` before the DELETE + log line. 30/hr/pubkey.
- **NIP-98 replay guard (`nip98Auth.ts`, 2026-09-07 audit defence-in-depth):** `authenticateNip98` keeps an in-process `Map` of accepted event ids (TTL 120s, > NIP-98's ±60s `created_at` window) and rejects the second sighting of an id with **401 `NIP-98 token already used`**. Closes the "capture a token, resend within 60s with a swapped body to overwrite the victim's own subscription" window (the `payload` body-hash tag is optional and the client doesn't send it, so nothing else binds a token to its request body). Same shape as the IP rate limiter's Map+sweep; process-local, so a multi-instance backend would need this in Redis. A token id is the hash of `[pubkey, created_at, kind, tags, content]` (signature-independent), so a genuine client sending N requests/second must vary `created_at` — real clients mint a fresh token per request anyway. `_resetNip98NonceCache()` test hook.
- **`NOTIFICATION_SERVICE_NSEC` IS set and active in production** (verified 2026-09-07: container env has it, backend logs `[notify-service] service identity loaded (pubkey d03c080f…)` + publishes the "MintRadar Alerts" kind:0). So server-side DM notifications (`notifySubscribers` in `nostrService.ts`, fired on up/down transitions from `probeMintToDb`, 60-min per-direction cooldown) are LIVE, not dormant. **Atomic cooldown (2026-09-07 audit, commit `dc4d993`):** the old SELECT-check → send DM → UPDATE `last_notified` sequence let two overlapping probe cycles both pass the check and both send a duplicate DM. Replaced with a single conditional `UPDATE notification_subscriptions SET last_notified_<dir>_at = now() WHERE mint_url = $1 AND notify_on_<dir> = true AND (last_notified_<dir>_at IS NULL OR last_notified_<dir>_at < now() - INTERVAL '<COOLDOWN_MINUTES> minutes') RETURNING pubkey, relays, …` that **claims** the slot in the DB — DMs go only to the rows it returns, the loser of a race gets zero rows. A claim whose DM never goes out (all relays failed / `wrapEvent` threw) is released (`last_notified_<dir>_at` → NULL, guarded on the exact timestamp set so a concurrent successful claim is never clobbered) so the next cycle retries. `COOLDOWN_MS` (JS) → `COOLDOWN_MINUTES` (one source, used in the SQL interval).

## /api/stats calculation rules
- totalMints: **every row in `mints`** — the handler's query 1 is a plain `SELECT … FROM mints m` with **no `WHERE`**, and `totalMints = rows.length`. This is the same full set `/api/mints/known` returns (also unfiltered), so **`/api/stats.totalMints === /api/mints/known.length`** by construction. Integration test `backend/src/__tests__/integration/known-count-consistency.test.ts` locks that invariant (added 2026-09-08 — see "Dashboard Mint Count Distinction" below). Do NOT add a `WHERE is_known` / `.filter()` to one endpoint's count without the other.
- onlineMints: mints where latest online = true
- offlineMints: mints where latest online = false (NOT `total - online` — never-probed `online = null` rows count toward neither)
- avgTrustScore: average of (last_trust_score ?? 0) for online mints only
- trustDistribution: low/moderate/high counts from online mints only (same filter as avgTrustScore)
- top5ByTrustScore: excludes `isTestMint()` URLs (backend copy in `backend/src/testMints.ts`)

## Trust Score calculation (server-side, in prober.ts)
- Uptime 45%: uptimePct * 0.45 (from 24h mint_history)
- NUT Support 30%: min(nutCount/25, 1) * 30 — 25 is the number of NUTs actually tracked (`TRACKED_NUTS` in `src/constants/nuts.ts`, mirrored as `TRACKED_NUT_COUNT` in `backend/src/shared/trustScore.ts`); the "/26" written here previously was never what the code did
- Version freshness 15%: software-aware version recency (fixed 2026-08-19 — previously every mint was compared against `NUTSHELL_VERSIONS` regardless of software, so a current `cdk-mintd` mint was penalized as a stale Nutshell, and unrecognized software with a higher major version — e.g. `LekMint/1.1.1` — got an automatic full score with zero verification). `versionFreshnessScore()` (`backend/src/shared/trustScore.ts`, mirrored in `src/utils/trustScore.ts`) first splits the raw `"Software/X.Y.Z"` version string (`splitVersionString()`) and identifies the software (`canonicalSoftwareName()` — case-insensitive, exact match only, so `Nutshell-CF` does NOT match `nutshell`). Recognized software (`nutshell`, `cdk`/`cdk-mintd`) is scored against its own version ladder; software with no ladder at all scores a neutral **2.5** (same neutral default as audit reliability's "Unknown" state — not 0, not 10). `normalizeVersionNumber()` strips a leading `v` (GitHub tag convention) and any `-rc.N`/prerelease suffix before comparing (patch number is extracted but not yet used by the scoring granularity). The version ladder itself prefers the `software_versions` DB table (`software`, `latest_version`, `fetched_at`, `source_url` — updated daily from the GitHub Releases API by `fetchLatestUpstreamVersions()` in `backend/src/versionCatalog.ts`, read via `getLatestVersionsMap()` and passed into `computeServerTrustScore()` in `prober.ts`) and falls back to the static `NUTSHELL_VERSIONS`/`CDK_VERSIONS` lists in `trustScore.ts` when the DB has no row yet for that software (fresh deploy, before the first cron run — `db.ts`'s `initDb()` seeds both rows so this never actually happens in practice). The frontend copy has no DB access and always uses the static fallback.
- Audit reliability 5%: based on error rate from a **rolling window of the mint's last ~100 swaps** (`audit_recent_errors`/`audit_recent_total`, fetched per-mint from `GET /swaps/mint/{id}` on audit.8333.space — see Discovery pipeline below), not audit.8333.space's cumulative lifetime counters — bucket logic (0%→5, <1%→4, <5%→3, <15%→2, ≥15%→1, null or <3 samples ("Unknown")→2.5) lives in `backend/src/shared/auditScore.ts` (`auditReliabilityScore()`/`isAuditUnknown()`), the source of truth shared with the frontend's Trust Score Breakdown. `src/utils/auditScore.ts` is a manually-synced copy (the two packages have no workspace set up between them) — edit both if the logic ever changes. `audit_n_mints`/`audit_n_melts`/`audit_n_errors` (cumulative lifetime counts) are kept separately for the Audit tab's all-time context — they no longer feed the score. **Audit tab layout (2026-09-03):** the tab leads with a compact **`.audit-summary-strip`** — a 4-cell 5-second overview: **Mints** (`auditNMints`) · **Melts** (`auditNMelts`) · **Recent errors** (`formatAuditErrorRatio(auditRecentTotal, auditRecentErrors)` → `"<errors> / <total>"`, coloured by `auditReliabilityColor()` so it can't disagree at a glance with the sidebar Trust Score Breakdown; sub-line is `"<n>% ok"` / `"too few to score"` (via `isAuditUnknown()`) / `"no recent swaps"`) · **Last checked** (`formatTimeAgo(auditSyncedAt)` — **our** cron's write time, NOT `auditCheckedAt`). The strip sits *outside* the mobile collapse (always visible). Below it, inside the collapse, a single **`.audit-alltime-line`** carries the lifetime totals + `%` and the "Recent errors feeds Trust Score" note, plus a short explainer sentence (added 2026-09-04) clarifying that the recent-errors figure — not the all-time one — drives the Trust Score. This **replaced** the old 3-card all-time `.audit-stats-grid` + separate green "Recent reliability" `.audit-recent-card` band (both duplicated the same numbers). `formatTimeAgo`/`formatAuditErrorRatio` live in `src/utils/mintFormatting.ts` (unit-tested); e2e in `e2e/mint-detail-audit-summary-strip.spec.ts`. Window size = `AUDIT_SWAPS_WINDOW` (100) in `backend/src/discovery.ts`.
  - **`auditReliabilityColor()` (`src/utils/mintFormatting.ts`, 2026-09-04) is a separate, UI-only coloring function — deliberately NOT the same thresholds as `auditReliabilityScore()`'s 1-5 scoring buckets above**, and it does not feed the Trust Score number. It colors directly off the raw error rate: `var(--fast)` (green) at ≤5% errors, `var(--med)` (amber) at ≤25%, `var(--slow)` (red) above that — `< 3` samples renders muted (`var(--t3)`). The 1-5 score buckets are much stricter (e.g. a 5% error rate already scores 3/5, two tiers down), which read as misleadingly alarming at a glance for what's actually a 95%-success mint; the amber cutoff was widened from an initial 15% to 25% the same day after review. Used by both the Audit summary strip's "Recent errors" cell and the Trust Score Breakdown's "Audit reliability" row.
- Stored in mints.last_trust_score after each probe
- **The whole computation lives in `backend/src/shared/trustScore.ts`** (`computeTrustScore()` plus the per-component `uptimeComponent`/`nutComponent`/`versionComponent`/`contactComponent` helpers). `prober.ts` re-exports it as `computeServerTrustScore`/`serverVersionFreshnessScore` for its existing call sites and tests. `src/utils/trustScore.ts` is the manually-synced frontend copy (same no-workspace caveat as `auditScore.ts`) — edit both if the logic changes. The frontend used to carry a second, silently divergent implementation in `MintDetail.tsx` (its own `NUTSHELL_VERSIONS` list topped out at 0.21 vs. the backend's 0.16, so the Trust Score Breakdown's Version row could disagree with the total it was breaking down); that duplicate is gone.
- The stored server-side score is authoritative. `MintDetail.tsx` computes a score itself only as a fallback — when `knownMint.trustScore` is missing, or for a historical chart bucket with no stored `trust_score`.
- Rounding: each component rounds individually, then the total gets exactly one outer `Math.round` before the cap — `Math.min(100, Math.round(sum))`. Both copies must keep this ordering or a mint's breakdown rows won't add up to its stored total.
- Contact component: `mints.contact_count` stores the last successfully observed count. A probe that can't reach `/v1/info` learns nothing about contacts, so it falls back to the stored value instead of scoring the mint as having none (previously a failed probe silently zeroed this component). `contactComponent()` clamps the count to **3** before scoring (`Math.min(contactCount, 3) / 3 * 5`) — 3+ contacts award the full 5 points and never more. This clamp is an explicit anti-inflation guard: `contact_count` is the raw length of the mint's own `/v1/info` `contact` array (untrusted operator input), and without it a mint advertising e.g. 60 contact entries scored 100 on this component alone, saturating its whole Trust Score (2026-09-07 security audit, finding H1). The frontend's `contactCountOf()` already passes at most 3 (it only looks at email/twitter/nostr fields); the clamp closes the backend path.

## Trust Score donut arc — shared geometry helper (2026-09-04)

`trustDonutArc(pct)` in `src/utils/mintFormatting.ts` is the single source of truth for the
Trust Score gauge's SVG stroke-dasharray geometry, used by both the Mint Detail donut
(`MintDetail.tsx`) and the Stats page's Network Health Index gauge (`Stats.tsx`). It clamps
the input to 0-100, computes `filled = (pct/100) * TRUST_DONUT_CIRCUMFERENCE` against the
gauge's `r=27` SVG circle (circumference ≈ 169.646), and returns `{ dashArray: "filled gap",
dashOffset: 0, filled }`. **Fixed bug:** both call sites previously also applied a spurious,
independently-computed `strokeDashoffset` (42.4-ish) on top of the dasharray split — the two
values fought each other and visibly under-filled the arc relative to the percentage shown as
text next to it. `dashOffset` is now hardcoded to `0` inside the shared helper (the SVG's own
`transform="rotate(-90 36 36)"` already handles the 12-o'clock start point), so there is
nothing left for a caller to double-apply. Unit-tested in `src/__tests__/mintFormatting.test.ts`.

## Trust Score vs Community Rating — visual separation

Trust Score (server-computed, 0-100) and Community Rating (crowd-sourced NIP-87 average, 1-5★)
are deliberately distinguished by icon, not just by label, everywhere they appear side by side
(`MintCard.tsx`, `ComparisonModal.tsx`, `MintDetail.tsx`): Trust Score carries a shield icon,
Community Rating a green star. The shield is `IcShield` (`src/components/mint/IcShield.tsx`) —
a small shared SVG component (`size` prop, default 13px, `currentColor` stroke) — also reused
by the Token Inspector's mint risk badge (`Tools.tsx`, see "Token Inspector" below) and
`LearnIcons.tsx`. Do not duplicate this shield inline in a new component; import `IcShield`.

## Shared mint-formatting helpers (`src/utils/mintFormatting.ts`)

Pure, side-effect-free, unit-tested (`src/__tests__/mintFormatting.test.ts`). Import from here
instead of re-inlining — several of these exist specifically because the same logic had drifted
across components.

- **`mintHostname(url)`** — `new URL(url).hostname`, or the raw string if unparsable.
- **`displayName({ name, url })`** — the title shown on cards, in the Name sort, the Compare
  picker, and (as of `f2b25ff`) on the Stats page (Most Reliable, Trust Score Movers, software
  drilldown, geo modal, NUT-support modal). Steps: trim → strip **one** pair of wrapping
  `"`/`'` quotes → if the result is empty or in `GENERIC_NAME_DENYLIST` (`cashu`, `cashu mint`,
  `mint`, case-insensitive) return the hostname → **suffix-collision guard (2026-09-08):** if
  the resolved name is a parent-domain suffix of the host (`host === name` or
  `host.endsWith('.' + name)`) return the full hostname. That last step fixes
  `bitcoin.aleafnd.org` vs `btc.aleafnd.org` both titling as `aleafnd.org`. `"Cashu test mint"`
  is deliberately NOT denylisted (real known test mint, kept verbatim).
- **`mintFaviconInitials(url)`** — 2-letter monogram fallback for a mint with no icon. Strips a
  leading `www.` and/or `mint.` (case-insensitive, both if stacked — `6987e27`) before taking
  the first two hostname chars, so `mint.example.com` and `example.com` don't both render `MI`.
- **`cardTrustLabel(score)`** → `"Trust <n>"` (word + number, never a bare `NN%`), `"Trust n/a"`
  for null/undefined. Rendered on the card as `IcShield` + this label, colored by band
  (`--green-bright` ≥ 70 / `--amber` ≥ 40 / `--red` else / `--t3` when null). Same formatting is
  reused by the Best Mint wizard result rows (2026-09-08).
- **`cardLatencyLabel({ latencyMs, lastError })`** → `"<n> ms"` when a sample exists, `"timeout"`
  when the probe timed out with no sample, `"n/a"` otherwise. The card's latency row is **always
  rendered** — never a blank or `"—"`. The uptime chip reads `"<n>% up 24h"`.
- **`cardLightningLabel({ mintMethods, meltMethods })`** (2026-09-08, commit `b796eff`) →
  `'LN' | 'LN in' | 'LN out' | null`. Lightning = a method entry whose `method` is `bolt11` or
  `bolt12` (case-insensitive); `onchain`/`venmo`/`paypal`/etc. ignored. Both sides → `'LN'`,
  mint-only → `'LN in'`, melt-only → `'LN out'`, methods `null`/`[]` on both sides → `null`
  (never inferred from `nutCount`/`nutsLimits`). Reads the existing `mintMethods`/`meltMethods`
  fields on `KnownMint` (from `/api/mints/known` — no backend change). Centralizes the
  `.some(e => method === 'bolt11'|'bolt12')` check that was duplicated in `MintDetail.tsx` /
  `Tools.tsx`. Card chip: lucide `<Zap size={10}>` in `currentColor` (no gold emoji) + label,
  class `card-pill card-ln`, **no `title`/hover text**. ~30 mints have `null` methods
  (mostly offline / older Nutshell) → they render no chip.
- **`isNewMint(discoveredAt)` / `NEW_MINT_MAX_DAYS` (30)** — the card/header **"New"** badge.
  Replaced the Fresh/Established/Veteran/OG age badges on the card (see "Card badges" below).
- **`firstSeenLabel(discoveredAt)`** → `"First seen <Mon YYYY>"` (UTC), or `null`. Mint Detail
  header only.
- **`resolveMintDetailUrl(slug, known)`** (2026-09-08, commit `bbf3eab`) — canonicalizes the
  `/mint/:url` route param. See "Mint Detail route param canonicalization" below.
- Also here (own sections / mentions elsewhere): `trustDonutArc`, `auditReliabilityColor`,
  `formatAuditErrorRatio`, `formatTimeAgo`, `mintRiskLevel`, `normalizeMintUrl`,
  `trustScoreColor`/`trustScoreInfo`/`trustColor`, `uptimeColor`/`latencyColor`,
  `MIN_MEANINGFUL_REVIEWS`.

## Cron jobs
- Every 5min: probe all mints in DB → write to mint_history, update mints metadata + last_trust_score, **then `refreshTrustMoversRollup()`** (`backend/src/trustMoversRollup.ts`): one `UPDATE mints` recomputing `trust_score_{7,30}d_ago` from `mint_history` (index-backed per-mint `LIMIT 1` lookups). Single-flight, never throws. Also primed ~15s after boot. Feeds `GET /api/stats/trust-movers`.
- Every 6h: NIP-87 discovery from 7 relays + audit.8333.space API → INSERT new mints, **then `refreshAllMintReviews()`** (`backend/src/reviewsSync.ts`): per-mint kind:38000 fetch (broad `REVIEW_SYNC_RELAYS`, 8s timeout, concurrency 3) → atomic per-mint replace of `mint_reviews` + `mints.review_count`/`review_avg_rating` rollup inside one transaction (READ COMMITTED: readers see old-complete or new-complete, never partial). Single-flight (`isReviewSyncRunning`).
- Daily 3:15am: `pruneUnvalidatedMints()` — deletes rows discovered >24h ago that NEVER had a successful probe (covers any insert path that skips `isValidCashuMint()`).
- Daily 3:45am: refresh `software_versions` cache from the GitHub Releases API (`cashubtc/nutshell`, `cashubtc/cdk`) — see Trust Score calculation above
- Daily 4:45am: `refreshReviewSurgeBaseline()` (`backend/src/reviewSurgeRollup.ts`) — advances the rolling `review_count_7d_ago` snapshot for any mint whose snapshot is missing or ≥7 days old (skips mints whose `review_count` is still NULL, so the first reviews-sync never looks like a surge). Also primed 60s after boot. Single-flight, never throws. Feeds the `reviewSurge` field on `/api/mints/known`.
- Daily 4:15am: `revalidateMints()` (`backend/src/prober.ts`) — **recurring Cashu-content revalidation** (fix for the "validate once at submit, then DNS/redirect-repoint anywhere" confused-deputy finding). Per mint, a STRONGER check than the 5-min probe: `/v1/info` must have a **non-empty** `nuts` object AND `/v1/keys` must return ≥1 keyset. Tri-state result — `ok` / `not-a-mint` / `unreachable`. `not-a-mint` (a repoint target: HTML page, redirect, `{"nuts":{}}` stub, 4xx) sets `mints.invalid_since = COALESCE(invalid_since, NOW())`; `ok` clears it; `unreachable` (5xx / timeout / DNS) leaves it untouched so a genuine multi-day outage never counts. The 5-min probe (`probeMintToDb`) also maintains `invalid_since` for the reachable-but-not-a-mint case (`lastError` ∈ {`Invalid Cashu response`, `Invalid JSON response`, `HTTP 4xx`}). Any mint with `invalid_since` older than **`REVALIDATION_REAP_DAYS` (7)** is `DELETE`d — removed from the probe rotation entirely, bounding the confused-deputy window from "forever" to ≤7 days. The 5-min probe already flips such a mint offline within minutes (dropping it from recommendations / marking it degraded); this job is what eventually removes it. **The lenient `isValidCashuMint()` submit/discovery gate is deliberately NOT tightened** — only this new sweep uses the stronger criteria, so an unusual-but-real mint is never rejected at submit time.

## Discovery pipeline

`discoverMintsFromNostr()` in `backend/src/discovery.ts` runs 3 sources in parallel via `Promise.allSettled`:
- **kind:38172** — NIP-87 mint announcements (direct `u` tag)
- **kind:38000** — reviews; `#u` tag mining extracts reviewed mint URLs
- **audit.8333.space** — external audit API. `discoverMintsFromApi()` does 2 passes over the ~65 mints audit.8333.space knows about: (1) one paginated `GET /mints/` call (100/page) for discovery + cumulative lifetime counts (`audit_n_mints`/`audit_n_melts`/`audit_n_errors`, display-only, feeds the Audit tab's all-time line) and each mint's audit refresh time (`audit_synced_at = NOW()`) and to capture each mint's audit.8333.space `id` (stored as `audit_id`); (2) a sequential per-mint `GET /swaps/mint/{id}?limit=100` pass (~65 extra requests, 150ms apart) for the rolling-window reliability score (`audit_recent_total`/`audit_recent_errors`, feeds Trust Score — see above). Runs once per 6h discovery cycle, so ~65 extra requests/6h — not throttled further, well within reasonable API use.

**`safeFetch` for outbound API calls (2026-09-07 audit, commit `11c30f1`):** `discovery.ts` (audit.8333.space `/mints/` + `/swaps/mint/{id}`) and `versionCatalog.ts` (`api.github.com/.../releases/latest`) used plain `fetch()` — no connect-time DNS pinning, and undici auto-follows up to 20 redirect hops. Both now call `safeFetch()` (`isSafeUrl()` pre-check + `safeAgent` DNS pinning rejecting private/loopback/link-local/CGNAT at connect + manual redirect following, max 3, each hop re-validated + `credentials: 'omit'`). `SafeFetchOptions` gained an optional `headers` (GitHub Accept header). `safeFetch` returns `Response | null` and never throws, so the "keep last known value" behaviour is preserved. Defence-in-depth — the hostnames are hardcoded constants. **Note:** the root `nostr-tools` `SimplePool` used by `discovery.ts` / `reviewsSync.ts` is NOT the DNS-pinned pool `nostrService.ts` uses — it is only safe because its relay lists are hardcoded; a future dynamic relay list must switch to `DnsPinnedWebSocket` or it becomes SSRF (commented at both sites, `3c8867f`).

Approximate yields (as of 2026-06-29): kind:38172 ~33 mints, kind:38000 ~37 mints, audit.8333.space ~61 mints. Total DB: ~97 mints.

**URL normalization:** `normalizeUrl()` lowercases the hostname before every INSERT. Applied in 4 places: `discoverMintsFromNostr`, `discoverMintsFromApi`, `POST /api/mint/submit`, `POST /api/mints/discover`. Prevents duplicates like `https://Mint.coinos.io` vs `https://mint.coinos.io` (the capital-M variant was a seed bug and was manually deleted).

## Test mint detection (2026-09-04)

`src/constants/testMints.ts` (frontend) + `backend/src/testMints.ts` (manually-synced mirror,
same no-workspace caveat as `auditScore.ts`/`trustScore.ts`) hold `TEST_MINT_URLS` — a
**manually curated set of 6 known dev/test-only mint URLs** (`8333.space:3338`,
`testnut.cashu.space`, `nofee.testnut.cashu.space`, `rugs.cashu.exchange`,
`rugs01.cashu.exchange`, `cashu.centurymetadata.org`) — and `isTestMint(url)`.

A pure keyword match on `/v1/info`'s `description`/`description_long` was deliberately
rejected as the runtime mechanism: wording isn't consistent across mints, generic risk
disclaimers on real production mints (Minibits, Sovran: "use at your own risk", "still in
development") would false-positive, and at least one mint's warning text changed to
something benign between probes — none of that should silently change what gets hidden from
recommendations. The short `description` field (where this warning text actually lives) also
isn't persisted to the DB today.

These mints are **not hidden from the app** — they still appear in `/api/mints/known`, are
still probed/tracked normally, and get a "Test mint" badge (`MintCard.tsx`, `MintDetail.tsx`,
always rendered last among a card's badges). They ARE excluded from anything that implies a
recommendation: the Best Mint Wizard (`Tools.tsx`), "Recommended by Follows"
(`useFollowRecommendations.ts`), and the backend's `top5ByTrustScore` (`backend/src/index.ts`,
`GET /api/stats`). Update `TEST_MINT_URLS` manually (both copies) if a new dev/test mint
surfaces — grep fresh `/v1/info` responses for phrases like "for testing and development
purposes" or "fakewallet", but confirm it isn't a real mint with a mere risk disclaimer first.

## Discovery relays (backend + frontend) — unified 2026-07-24
Frontend source of truth: `src/core/nostr/relays.ts` (`DISCOVERY_RELAYS`), imported by
`src/core/nostr/mintDiscovery.ts` and `src/hooks/useNostrDiscovery.ts`. Backend can't import
this (separate npm package, no workspace set up) — `backend/src/discovery.ts` keeps its own
`DISCOVERY_RELAYS` constant manually in sync; mirror any change to both.

wss://relay.damus.io, wss://nos.lol, wss://purplepag.es, wss://relay.snort.social,
wss://relay.primal.net, wss://relay.cashumints.space, wss://relay.azzamo.net,
wss://eden.nostr.land, wss://nostr.wine, wss://nostr-pub.wellorder.net,
wss://offchain.pub, wss://relay.8333.space, wss://nostr.oxtr.dev, wss://relay.nostr.net,
wss://nostr21.com, wss://nostr.bitcoiner.social, wss://nostr.cypherpunk.today

**2026-08-16 — `nostr.bitcoiner.social` and `nostr.cypherpunk.today` added**, alongside
`relay.snort.social` filling in wherever it was still missing. Verified reachable (TCP:443
connect) before adding. Requested to go into every relay list in the project, not just the
unified discovery set above — also added to `REVIEW_PUBLISH_RELAYS`/`PROFILE_RELAYS`
(`src/core/nostr/relays.ts`), `META_RELAYS`/`NOTIFICATION_RELAYS` (backend `nostrService.ts`
+ frontend `client.ts`/`useWatchlistNotifications.ts`), `NIP46_RELAYS` (`client.ts`),
`BOOTSTRAP_RELAYS` (`useUserRelays.ts`), `FOLLOW_RELAYS` (`useFollowRecommendations.ts`), and
`WATCHLIST_RELAYS` (`watchlistSync.ts`) — i.e. every relay array in the codebase, not just
the 4 "unified" discovery/review locations this section otherwise tracks. `REVIEW_PUBLISH_RELAYS`'s
own explicit `nostr.bitcoiner.social` entry was removed since it's now inherited via
`DISCOVERY_RELAYS` (same dedup pattern as the `nostr.oxtr.dev` case below).

`wss://relay.8333.space` was added to every discovery/review relay list in the project —
same operator as `audit.8333.space`, likely higher density of Cashu-specific NIP-87 events.

**2026-09-02 — `META_RELAYS` (`client.ts`) is now a deliberate exception to the
"every relay array" rule above.** It is the post-login bootstrap set (kind:0 profile +
kind:10002 relay list, fetched in one `subscribeMany` by `bootstrapUserData()`) and was
cut to a 4-relay fast path — `purplepag.es`, `relay.primal.net`, `relay.damus.io`,
`nos.lol` — for login latency (name/avatar was taking ~4s; the slow/unreachable relays
each cost up to ~3s of dead wait on that path for no extra yield). Do NOT re-add the
broad set here. `useUserRelays.ts`'s old `BOOTSTRAP_RELAYS` array is gone — that fetch is
now the same `bootstrapUserData()` call. `useFollowRecommendations` is no longer
prefetched from `AppShell` on login (it loads lazily from the Watchlist page only).
`nip65Relays` is persisted in `auth.store` `partialize` so a reload skips the fetch.

**Immediate logged-in state + `subscribeFirstEvent()` (`client.ts`):** `loginWithNip07()`
returns `{ pubkey, npub }` the instant `window.nostr.getPublicKey()` resolves — the navbar
renders logged-in (short npub as the name fallback) before any relay round-trip. Name/avatar
and the NIP-65 relay list are then filled in by `bootstrapUserData()`, triggered from
`useUserRelays` once the auth store holds a pubkey. Both `fetchNostrProfile()` (single kind:0)
and `bootstrapUserData()` (kind:0 + kind:10002 together) resolve via `subscribeFirstEvent()` —
a helper that finishes as soon as the first `verifyEvent()`-passing event arrives on ANY
relay in the set, instead of `SimplePool.querySync()`'s old behavior of waiting for every
listed relay to EOSE (a ~4.4s per-relay ceiling that dominated login latency). Falls back to
`null` on all-EOSE-empty or a 6s timeout (`USER_BOOTSTRAP_TIMEOUT_MS`).

**2026-08-15 — `relay.nostr.band` replaced, 3 relays added (all 4 relay-list locations):**
User noticed devtools showing `relay.nostr.band` (`NS_ERROR_UNKNOWN_HOST`/timeout) and
`relay.8333.space` (`NS_ERROR_CONNECTION_REFUSED`) failing, plus `relay.damus.io`
returning occasional 503s. Investigated each:
- `relay.nostr.band` — genuinely down (TCP handshake to `95.216.33.150:443` hangs/times
  out; confirmed not a general network issue since other Hetzner-hosted relays, e.g.
  `nos.lol`, connect fine). **Replaced** with `eden.nostr.land` everywhere it appeared.
- `relay.8333.space` — also down right now (`EHOSTUNREACH`), but **kept** in the list (its
  Cashu-specific NIP-87 density is worth it once it recovers — same operator as
  `audit.8333.space`, which is up).
- `relay.damus.io` 503s — NOT a bug, confirmed by hammering it with 10 sequential
  WebSocket connects: ~20% hit HTTP 503 (Cloudflare load-shedding), ~80% open in
  ~200-400ms. `sharedPool` already races all relays in a list simultaneously
  (`querySync`/`subscribeMany`), so this doesn't cause user-visible failures — it was
  flagged in devtools but the login flow succeeded regardless. No fix needed.
- **Added** `nostr.oxtr.dev` (99ms connect — already trusted, was previously only in
  `REVIEW_PUBLISH_RELAYS`'s own extra list; that duplicate entry was removed since it's
  now inherited via `DISCOVERY_RELAYS`), `relay.nostr.net` (284ms), and `nostr21.com`
  (483ms) — all verified reachable via a direct `ws` handshake test before adding.
  `relay.current.fyi` (DNS doesn't resolve) and `relay.nostrati.com`/`relayable.org`
  (502/timeout) were also tried as candidates and rejected as unreliable.
- All 4 relay-list locations kept in sync: frontend `DISCOVERY_RELAYS` + `PROFILE_RELAYS`
  (`src/core/nostr/relays.ts`), backend `DISCOVERY_RELAYS` (`discovery.ts`), backend
  `NOSTR_REVIEWS_RELAYS` (`index.ts`).

**Streaming vs. batch discovery:** considered and deliberately rejected. Discovery runs in
the background with no live UI to update, so a streaming subscription (incremental
per-event handling) wouldn't produce any visible benefit over the current EOSE/timeout
batch pattern (`querySync` + race against a timeout, or `subscribeMany` resolved on
`oneose`). Do not "improve" this to streaming without a concrete reason.

## Compare feature — shared picker + mobile layout

- **`MintComparePicker`** (`src/components/MintComparePicker.tsx` + its own `.css`) is the
  shared "Compare with..." mint-selection UI, opened from both Dashboard's per-card ⇄ Compare
  button and MintDetail's header Compare button, ahead of `ComparisonModal`. **History:** it
  used to borrow CSS classes from `MintDetail.css`, which isn't loaded on the Dashboard route
  — the picker rendered unstyled there until it was extracted into this standalone
  component+stylesheet pair (2026-09-02/03, PRs #78/#79). Filters candidates to online mints
  and closes on Escape. Callers pass a pre-filtered `candidates` pool and get back the
  selected URLs via `onConfirm`.
- **Mobile stacked/tabbed layout (≤768px, 2026-09-04):** `ComparisonModal`'s desktop
  side-by-side table is replaced on mobile (gated by `useIsMobile()`, same 768px breakpoint)
  with `.cmp-mobile-tabs` (one tab per compared mint, horizontally scrollable) +
  `.cmp-mobile-stack` (that mint's rows shown one at a time, `.cmp-mobile-row` /
  `.cmp-mobile-row-wrap` for rows needing to wrap to a second line). The CSS for all of this
  lives in `Dashboard.css`, not `Watchlist.css` — this is the file to check when a compare-modal
  style looks unstyled on either page.
- **Version History rows** are two-line (`.cmp-mobile-vh` / the desktop `.cmp-vh-scroll`
  variant) rather than the original single-line `nowrap` layout, so a long version string no
  longer clips or forces horizontal scroll.
- `ComparisonModal` also renders a Community Rating row (★ badge, "—" fallback when no reviews)
  and a shield-badge Trust Score (see "Trust Score vs Community Rating" above) — added 2026-09-03.

## Key features
- Dashboard: compact/expanded card view, filter panel (**Status + Min. Trust Score only** — the "Mint age" Fresh/Established/Veteran/OG block was removed 2026-09-08, see "Card badges" below; `requiredNuts` state still exists but URL-only, no panel UI), search, sort ("Most reviewed" before Rating; see "Dashboard controls row" below), mint comparison tool (up to 4, see "Compare feature" above), stats bar, submit form (single + bulk). One-line explainer above the grid (`.grid-score-explainer`): **"We score how it runs. They score how it went. You pick."** (13.5px / `--t2`).
- Mint Detail: MOTD, NUT compatibility grid with modal, NUT limits (NUT-04/05), historical charts (24h/7d/30d/90d, Latency/Uptime/Trust), Mint History panel, version history, Trust Score gauge with breakdown, Audit stats, Add to Wallet + QR, NIP-87 reviews, backup checker (NUT-13). Header carries an inline **Online/Offline** pill next to the name, a **New** badge (< 30d), **First seen `<Mon YYYY>`** on the URL row (`firstSeenLabel()`), and a **`Tor`** label prefixing any `.onion` URL. Route param is canonicalized — see "Mint Detail route param canonicalization" below.
- Stats page: totalMints/onlineMints/offlineMints/avgTrustScore/avgLatency cards, NUT adoption horizontal bars, Trust Score donut chart, Most Reliable / Top Trust widget, Trust Score Movers, Network Health Index, Geographic Distribution, Software in Use. See "Stats widgets (2026-09-08)" below for the recent changes (test-mint exclusion, CDN bucket, software copy, subtitle omission).
- Watchlist: IndexedDB only, Nostr login required, export JSON/CSV, DM notifications (NIP-07)
- Wallets: curated list, `src/constants/wallets.ts`. Main grid = 8 end-user wallets (Minibits, Nutstash, Macadamia, Sovran, Cashu.me, Agicash, Coinos, Zeus). **Nutshell** carries `selfHost: true` and renders in a separate **"Run your own mint"** subsection below the grid (2026-09-08 — it's the reference implementation, not a consumer wallet). Card head: platform icon on the left + `.wallet-platform-tag` chips on the right only (the duplicate standalone platform word was removed). `Agicash` was renamed from `Boardwalk Cash`; `eNuts` was removed. No documented inclusion criteria beyond maintainer judgment.
- Nostr: NIP-07 login, profile fetch (kind:0), reviews (kind:38000), DM notifications (kind:4), watchlist sync (NIP-44 kind:10003)
- Learn: educational modules under `src/pages/learn/` (`LearnModule.tsx` router, `LEARN_MODULES` metadata). Slugs: `cashu-basics`, `understanding-the-risks`, `how-to-choose-a-mint`, `getting-started-with-a-wallet`, `safe-habits`. **`/learn/1`…`/learn/5` `<Navigate replace>` to the slug** (matched by `.order`); any other number or unknown slug → "Module not found". Footer nav: `← Previous`, `Next: {title}` for middle modules, **"Browse mints" → `/`** on the last module; "← Back to Learn" kept. Module 4/5 also carry their own in-content CTA `Link` (Module 4 → `/wallets`, Module 5 → `/watchlist`).

## Deploy workflow (ALWAYS do all steps)
See CLAUDE.local.md for $VPS_HOST, $VPS_USER, $VPS_REPO_PATH, $VPS_DIST_PATH values.

Backend (only if backend changed):
1. Commit + push local changes: git add -A && git commit -m "..." && git push origin main
2. On server pull + build: ssh $VPS_USER@$VPS_HOST "cd $VPS_REPO_PATH && git pull origin main && cd backend && npm run build"
3. Rebuild + restart Docker image: ssh $VPS_USER@$VPS_HOST "cd $VPS_REPO_PATH && docker compose build backend && docker compose up -d backend"
   NOTE: `docker compose restart` does NOT pick up code changes — always use `build` + `up -d`

Frontend:
4. Build frontend: npm run typecheck && npm run build
5. Deploy: rsync -avz --delete dist/ $VPS_USER@$VPS_HOST:$VPS_DIST_PATH/
6. Reload nginx: ssh $VPS_USER@$VPS_HOST "sudo systemctl reload nginx"
7. Commit: git add -A && git commit -m "type: description" && git push origin main

## Deploy Pipeline Notes

- The ONLY active GitHub Actions workflow is `/.github/workflows/deploy.yml` at the **repo root**. A dead duplicate previously existed at `MintRadar/.github/workflows/deploy.yml` inside the project subdirectory — GitHub Actions never ran it, but it caused confusion during debugging. It has been deleted. When editing CI/CD config, always confirm you're editing the root-level file.
- The deploy sequence runs `sudo rm -rf /var/www/mintradar/dist/assets/*` before copying the new build. This is intentional: `rsync --delete` was silently failing to remove old `root:root`-owned asset files left over from a prior deploy mechanism while still reporting success, causing stale content-hashed files to accumulate alongside new ones.
- The GH Actions workflow SSHes into the VPS, pulls latest code, builds on the server (`npm ci && npm run build`), then copies dist to the nginx root. The `rsync dist/` step documented in the deploy workflow above reflects the original mechanism — the active workflow in `.github/workflows/deploy.yml` is authoritative.
- **GOTCHA — Dependabot PRs:** Never merge multiple Dependabot PRs in rapid succession. Each merge triggers a GH Actions deploy that runs `rm -rf node_modules && npm ci` on the VPS. Concurrent runs race on the same node_modules directory, corrupting TypeScript's lib files and causing `Cannot find global type 'Boolean'` / `lib.es2022.d.ts not found` errors. Merge one, wait for the run to complete, then merge the next.
  - **Two layers of automated protection now in place (2026-08-15, following the lucide-react/stray-node_modules incident below):** (1) `.github/workflows/deploy.yml` has a workflow-level `concurrency: group: deploy-${{ github.ref }}, cancel-in-progress: false` guard — overlapping pushes to `main` now queue and run sequentially instead of racing on the VPS path (`cancel-in-progress: false` deliberately, since the deploy does `git reset --hard origin/main`+`npm ci` and a cancelled mid-deploy could leave the VPS in a worse state than a queued one). (2) `.github/dependabot.yml` now groups all npm updates per directory into a single PR (`groups: all-dependencies: patterns: ["*"]`) instead of one PR per bump, so a Dependabot run produces one merge/one deploy instead of ~10. The manual "merge one, wait for the run to complete" discipline below is now a backstop, not the only defense — but still follow it for any PRs that arrive outside Dependabot's own grouping (e.g. manually opened PRs, or if grouping is ever reverted).
  - Confirmed working (2026-07-24, commit 9abda76 session): 10/10 open Dependabot PRs (patch/minor bumps + one ESLint 9→10 major) merged sequentially, each followed by `gh run watch` on the deploy workflow before starting the next. Zero failures, zero VPS races.
  - **ESLint major-version bumps:** before writing/changing any `eslint.config.js`, check whether the package actually has its own config file. `MintRadar/backend` has none — its `npm run lint` resolves ESLint's flat config by walking up to `MintRadar/eslint.config.js` (this works because ESM imports inside that config file resolve relative to the config file's own path, not the invoking CWD). Verify this kind of resolution still works after a major bump with `eslint src/ --debug 2>&1 | grep -i "config"` (look for `Using config file ... and base path ...` plus a nonzero linted-file count) *before* assuming a config rewrite is needed.
  - **`npm install`/`npm ci` working directory:** this is a monorepo with THREE `package.json` locations if you're not careful — `MintRadar/` (frontend), `MintRadar/backend/`, and (accidentally, if you run `npm install` from the repo root) a stray root-level one. Always run `pwd` immediately before `npm install`/`npm ci` here. A 2026-07-24 session created a stray root `package.json`/`package-lock.json`/`node_modules` this way mid-Dependabot-batch (caught via `git status` before committing, deleted, redone in the right directory) — the same class of mistake previously happened in the separate Finvu project too.
    - **This stray root `node_modules` can outlive the session that created it and cause real prod failures much later.** On 2026-08-15, a stray `/var/www/mintradar-repo/node_modules` (no `package.json` alongside it — pure orphaned directory, dated back to that 2026-07-24 incident and never cleaned up on the VPS itself, only fixed locally/in git) sat there for three weeks. Two deploys fired ~11s apart (two rapid-succession `main` pushes), racing on `MintRadar/node_modules` during `npm ci`; while `MintRadar/node_modules` was transiently incomplete, Node's module resolution walked up the directory tree and resolved `vite`/`rollup` from that ancient orphaned root `node_modules` (`vite@5.4.21`, no `lucide-react` at all) instead of the correct `MintRadar/node_modules` (`vite@8.1.0`), producing a red herring error — `[vite-plugin-pwa:build] Failed to resolve entry for package "lucide-react". The package may have incorrect main/module/exports specified in its package.json` — that looked exactly like a bad Dependabot version bump but had nothing to do with lucide-react's actual version (unchanged since 2026-07-24) or any PR merged that day. **Diagnostic tell:** the build log's stack trace paths (`file:///var/www/mintradar-repo/node_modules/...` vs `.../MintRadar/node_modules/...`) reveal which `node_modules` actually got used — check this before suspecting a dependency itself. **Fix:** `rm -rf /var/www/mintradar-repo/node_modules` (verify no `package.json` sits next to it first — if one exists, investigate before deleting) in addition to the normal `rm -rf MintRadar/node_modules && npm ci` clean-reinstall. Consider checking for this stray directory as a periodic VPS health check, not just after an incident.
  - **Batch 3 (2026-08-15, first grouped PRs #67/#68 after the grouping fix above):** Dependabot's grouping produced exactly 2 PRs (backend 9 updates, frontend 23 updates) instead of ~30 individual ones — grouping confirmed working. Both PRs bundled `typescript` 6.0.3/5.9.3 → **7.0.2**, the same version that broke `npm ci` earlier that day (still incompatible — `@typescript-eslint/eslint-plugin`'s peer range is `<6.1.0` even at its own latest 8.67.0). Fixed by checking out each PR branch locally, reverting just the `typescript` line in `package.json`, regenerating the lockfile (`npm install typescript@<pinned> --save-dev`), verifying `npm ci`+`tsc --noEmit`+tests+build, then pushing that commit onto the PR branch before merging — grouping means you can't cherry-pick individual bumps out of the GitHub UI, so this local-branch-surgery pattern is the way to exclude one bad bump from an otherwise-good group.
    - The frontend PR (#68) also bundled `immer` 10.2.0→11.1.16 (previously held back, see `immer` entry below) and `@noble/hashes` 1.8.0→2.3.0 — both excluded the same way pending separate verification (done shortly after, see below), plus a genuine mistake caught mid-fix: `npm install <pkg> --save-dev` moved `immer` from `dependencies` into `devDependencies` even though only `typescript` needed `--save-dev` — always install multiple packages with different target sections in separate commands, or fix the section placement manually afterward and verify against `main`'s existing placement.
    - **Follow-up same-day: `immer` 11.1.16 and `@noble/hashes` 2.3.0 verified and applied** (commit `06357dd`). `@noble/hashes` v2's only breaking change is its `exports` map requiring explicit `.js` subpath extensions — fixed the one import site (`src/core/nostr/client.ts`: `'@noble/hashes/utils'` → `'@noble/hashes/utils.js'`), verified `bytesToHex`/`hexToBytes` round-trip at runtime. `immer` v11 needed no source changes; since `watchlist.store.ts` (the one real usage of the `zustand/middleware/immer` integration) has no dedicated unit tests and `vitest.config.ts` has no path-alias resolution (unlike `vite.config.ts` — the two configs are NOT merged, so any `@/...`-importing module can't be tested without a temporary local alias addition to `vitest.config.ts`), a throwaway smoke-test file was written against the store directly (mocking `@/db`) to confirm draft mutations (`push`/`filter`) and state-reference immutability still work, then deleted after confirming — this pattern (temporary vitest.config.ts alias + throwaway test file, both discarded) is worth reusing for verifying any other `@/`-importing module in isolation. Bonus: `vendor-immer` bundle shrank 26.6kB→9.16kB gzip on the v11 upgrade.
  - **Batch 2 (2026-08-01, PRs #32-#41):** 10/10 merged sequentially, same one-at-a-time + `gh run watch` discipline as batch 1. Zero failures.
    - Patch/minor: `@types/supertest`, `@vitest/coverage-v8`, `@tanstack/react-query`, `ws` (frontend only — backend still declares `ws@^8.21.0`; Dependabot hasn't opened a matching backend PR yet), `eslint` (backend, 10.6.0→10.8.0), `tsx`, `@playwright/test`, `nostr-tools` (backend, 2.23.5→2.24.1).
    - Major bumps (extra scrutiny, both verified safe with no source changes needed):
      - `react-router-dom` 6→7 — the app has no loaders/actions/fetchers/`json()`/`defer()`, so v7's main breaking surface (the data APIs) doesn't apply. Side effect: `react-router` no longer lands in the `vendor-react` chunk (+~9 kB gzip in the initial payload) — documented, not addressed; revisit only as part of a dedicated chunking pass.
      - `@noble/secp256k1` 2→3 — the app calls it in exactly one place (`getPublicKey` for nsec login) and never signs with it, so v3's breaking surface (the signing API) doesn't apply. Verified byte-identical output against an independent oracle, confirmed the `privkeyBytes.fill(0)` zeroing guarantee still holds, and manually exercised all three login flows (nsec/NIP-07/NIP-46) in a real browser.
    - `nostr-tools` and `@noble/secp256k1` are completely independent — `nostr-tools` depends on `@noble/curves`, not the standalone `@noble/secp256k1` package, which is physically absent from the backend's dependency tree.
    - PRs #22-31 from batch 1 closed themselves in the meantime (Dependabot detected the bumps were already applied directly to `main` and auto-closed the stale PRs) — no manual cleanup needed; expect the same on future batches.
  - **VPS maintenance (2026-08-07):** `docker builder prune -f` freed 10.81 GB of build cache, taking free disk from 17GB to 28GB — worth running periodically if disk pressure shows up again. A one-off deploy race ("removal of container is already in progress") was caused by two deploys firing back-to-back and colliding on `node_modules` during the backend `tsc` build — not a recurring problem, no fix needed unless it repeats. If it does repeat, consider adding `docker compose down --timeout 10` before `up` in the deploy script (not yet implemented).
  - **Batch 4 (2026-08-29, PRs #71/#72):** Same `typescript` landmine as Batch 3 recurred — the backend PR (#71) bundled `typescript` 6.0.3→**7.0.2** again (still outside `@typescript-eslint/eslint-plugin@8.67.0`'s `<6.1.0` peer range, confirmed live via `npm view @typescript-eslint/eslint-plugin@8.67.0 peerDependencies`). Fixed with the exact Batch 3 pattern: checked out the PR branch, reverted just the `typescript` line to `^6.0.3`, ran `npm install typescript@6.0.3 --save-dev` to regenerate the lockfile (this pulled in a large `package-lock.json` diff — installing TS 7 apparently drags in extra transitive packages that get removed on revert, not a red flag), verified `npm ci` + `tsc --noEmit` + `npm run lint` + `npm test` (285/285) + `npm run build` all clean, then pushed that fix commit onto the PR branch before merging. The frontend PR (#72, 7 patch/minor bumps — immer/lucide-react/nostr-tools/@vitejs/plugin-react/@vitest/coverage-v8/vite/vitest) did NOT touch `typescript` (frontend pins `^5.9.3`, outside this landmine) and merged directly with no fix needed. Both merges followed the one-at-a-time + `gh run watch` discipline; zero deploy failures. **This is now a recurring pattern, not a one-off** — expect Dependabot to keep proposing `typescript` 7.x for the backend until `@typescript-eslint/eslint-plugin` ships support for it; check the peer range with `npm view` before merging any future backend Dependabot PR that touches `typescript`.

## Nostr Login

Login modal (`src/components/layout/AppShell.tsx`) supports three methods selectable via radio cards:
- **NIP-07** — calls `window.nostr.getPublicKey()`; all signing stays in the extension
- **nsec** — decoded in `src/core/nostr/client.ts:loginWithNsec`, then held in a module-scoped variable (`activeNsecPrivkey`) for the session via `installNsecShim()` so the app can sign on the user's behalf (notifications, watchlist sync, reviews) — mirrors `installBunkerShim()`'s pattern. **Never written to any storage API** (sessionStorage/localStorage/IndexedDB) — in-memory only, so it does not survive a page reload. Zeroed via `.fill(0)` and cleared on logout by `removeNsecShim()` (called from `useAuthStore.logout()`, alongside `removeBunkerShim()`). The login modal explicitly discloses this to the user (nsec security notice box + footer line in `AppShell.tsx`).
- **Amber / NIP-46 bunker** — fully implemented via `nostr-tools/nip46` `BunkerSigner`; accepts `bunker://` URI or NIP-05 identifier; QR pairing flow for mobile Amber; session persisted in `sessionStorage` (`bunkerURI`, `bunkerClientSecretKey`, `bunkerPubkey`); 30s connection timeout; client keypair is ephemeral (NOT the user's identity key)
  - **`openRemoteSignerAuthUrl()` (2026-09-07 audit L3, commit `ac7c174`)** — NIP-46 `onauth` used to open the remote-signer-supplied URL with a bare `window.open(url, '_blank')`; a malicious bunker could return a phishing / `javascript:` / `data:` URL or reverse-tabnab via `window.opener`. The helper opens only `https://` URLs, always with `noopener,noreferrer`; non-string / other schemes are ignored with a warning. Wired into all 3 onauth sites (`loginWithBunker`, `initBunkerQR`, `restoreBunkerSession`).
  - **`initBunkerQR` cancel race (2026-09-07 audit L2, commit `0a0cdd0`)** — its `Promise.race([rawSigner, timeout]).then(...)` success path installed the `window.nostr` shim + wrote the bunker credentials with no check that the pairing was still wanted, so a Cancel/close landing in the same tick the connect-ack resolved left a live signer that silently re-logged the user in on the next load. The `.then` now bails on `abortCtrl.signal.aborted` (re-checked after each await): `signer.close()`, pool disposed, reject with `AbortError`, **no** state committed.

`sessionStorage` (Zustand persist) stores only the public `NostrProfile` `{ pubkey, npub, name, picture }` — no private key material is ever written to any storage API. For nsec logins the raw key is held in JS memory only (see above), which is a deliberate trade-off (enables signing) — do not add any persistence for it without re-confirming with the maintainer, since that would defeat the "in-memory only, lost on reload" guarantee.

## Watchlist Persistence

**Rule:** Logout MUST call `resetInMemory()`, NOT `clearWatchlist()`. Dexie must survive logout.

**Why:** `fetchRemoteWatchlist()` returns `[]` when `window.nostr?.nip44` is unavailable (nsec login, older extensions, relay timeout). If Dexie was cleared on logout and the relay returns empty, the watchlist is permanently lost.

**Implementation:**
- Dexie `meta` table (version 2): stores `{ key: 'watchlistOwner', value: pubkeyHex }` after every successful sync
- `useWatchlistSync` Phase 1: reads `watchlistOwner` before fetching remote
  - Same pubkey → Dexie preserved as fallback if remote returns `[]`
  - Different pubkey → Dexie cleared (different user on same device), then load from remote
- `handleLogout` in `AppShell.tsx` calls `resetInMemory()` (in-memory Zustand reset only)

## Watchlist changes (2026-09-04/05)

- **Filters + sort row removed entirely.** Watchlist previously had its own local
  filter/sort UI (duplicating the Dashboard's NUT/status/trust filter panel); that logic was
  local-only (no relay/DB dependency) and was deleted outright, not hidden — `Watchlist.tsx`
  no longer imports `NUT_FILTER_KEYS` or renders a filter panel. Dashboard's own filter/sort
  is unaffected.
- **Logged-out and empty-state copy rewritten.** Logged-out gate (`profile === null`):
  "Log in with Nostr to sync your watchlist across devices and get a message when a mint
  goes offline or comes back online." Empty watchlist (logged in, zero mints): "No mints
  watched yet" / "Add mints from the Dashboard with + Watch. Your list syncs over Nostr -
  you'll get alerts if status changes." with a "Go to Dashboard" CTA.
- **`+Watch` without being logged in (`MintDetail.tsx`)** now shows a confirm modal
  (`showWatchLoginModal` state, `rv-modal-overlay`) — "Login via Nostr" / "Cancel", closable
  via Escape — instead of the watch action silently no-op-ing or the button being hidden.
- **Empty-state gate uses `syncStatus`, not `knownLoading` (2026-09-05).** The watchlist
  page's skeleton-vs-empty decision is `knownLoading || syncStatus === 'pending'` — pulling
  the `WatchlistSyncStatus` (`'pending' | 'done' | 'error'`) from `useWatchlistStore` — so the
  "No mints watched yet" empty state can no longer flash before the Nostr sync has actually
  finished (previously gated on `knownLoading` alone, which settles as soon as `/api/mints/known`
  responds, well before `useWatchlistSync` resolves the user's real list). `syncStatus === 'error'`
  additionally renders a `.wl-sync-error-banner` ("Couldn't sync with Nostr relays...").

## Security & Infrastructure Gotchas

### nginx CSP: `wss:` must be explicit in connect-src

**GOTCHA — do not regress this.** `connect-src 'self' https:` does NOT cover `wss://` connections in practice. This was a real production incident: Nostr relay WebSocket connections (`wss://relay.damus.io/`, `wss://nos.lol/`, etc.) were blocked by the browser until `wss:` was added explicitly.

Current correct value: `connect-src 'self' https: wss:;`

### nginx CSP: `script-src 'self'` — no `'unsafe-inline'`

**GOTCHA — do not re-add `'unsafe-inline'` to `script-src`.** Removed 2026-09-08 (security
audit run-2 hardening). The Vite 8 (rolldown) production build emits **only external
content-hashed `<script src>` files** — the app entry plus `vite-plugin-pwa`'s injected
`<script src="/registerSW.js">`. There are no inline `<script>` blocks in `dist/index.html`,
no `eval`/`new Function`/`document.write` in the bundle, and `registerSW.js` is a standalone
file. So `'unsafe-inline'` covered nothing. If a future change needs an inline bootstrap
script (e.g. flipping `vite-plugin-pwa`'s `injectRegister` to `'inline'`, or an inline theme
probe), externalise it or move to a nonce/hash — do **not** bring `'unsafe-inline'` back.
`style-src 'unsafe-inline'` stays (React `style={{}}` + Recharts inject inline styles).
Full CSP value: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https: wss:;` — repeated in all 5 spots (server + 4 locations, per the non-inheritance rule below).

### nginx add_header non-inheritance

**GOTCHA.** When a `location {}` block defines ANY `add_header` directive, it does NOT inherit the parent `server {}` block's `add_header` directives. Security headers (CSP, HSTS, X-Frame-Options, etc.) MUST be repeated verbatim in every `location` block that defines its own `add_header`.

Affected blocks in `deploy/nginx.conf`: `location ~* \.(js|css|png|svg|ico|woff2|webmanifest)$` and `location = /sw.js`.

### deploy/nginx.conf is reference/documentation only

The file `deploy/nginx.conf` in the repo documents the intended production config but is NOT automatically deployed. The app is served from `/etc/nginx/sites-available/mintradar.org.conf` on the VPS (since the 2026-09-09 domain migration; `deploy/nginx.conf` mirrors that file). The legacy `mintradar.pedani.eu.conf` is now a redirect-only stub (301 → `https://mintradar.org$request_uri`) and is not drift-checked. The `.conf` suffix is real; `deploy/setup-server.sh` was previously missing it in its own `NGINX_CONF` variable and has been corrected to match, see below. Keep `deploy/nginx.conf` manually in sync with the live `mintradar.org.conf`. After updating `deploy/nginx.conf`, copy the relevant changes to the VPS manually and run `sudo systemctl reload nginx`.

**`deploy/setup-server.sh` cleanup (2026-08-29):** the script had leftover references to an earlier, unrelated project — `DOMAIN="privyzap.pedani.eu"`, `WEB_ROOT="/var/www/privyzap"`, plus matching comments — despite being the MintRadar server-bootstrap script. All steps in the script (mkdir web root, install nginx config, `nginx -t`, reload, certbot) were already generic and correct; only the variable values were wrong. Fixed to `DOMAIN="mintradar.pedani.eu"`, `WEB_ROOT="/var/www/mintradar/dist"` (matches `root` in `deploy/nginx.conf`), and `NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}.conf"` (the missing `.conf` suffix bug above). `grep -ri privyzap` across the repo is now clean except for a historical note in `AUDIT.md` documenting a past, already-fixed `nginx.conf` domain bug — that's a legitimate audit log entry, not a leftover.

### Nginx config drift check (CI, 2026-08-29)

`.github/workflows/nginx-config-drift-check.yml` — a separate, read-only, informational workflow (no `needs:` link to `deploy.yml`, so it can never block or slow down deploys) that runs daily at 06:00 UTC (`cron: '0 6 * * *'`, plus `workflow_dispatch` for manual runs). It SSHes in (reusing the same `HETZNER_HOST`/`HETZNER_USER`/`HETZNER_SSH_KEY` secrets as `deploy.yml`, via `appleboy/ssh-action` with `capture_stdout: true`), `sudo cat`s the live `/etc/nginx/sites-available/mintradar.org.conf` (never writes anything to the server — no `nginx -t`, no reload), diffs it against the checked-out `deploy/nginx.conf`, and writes the result (match or full diff) to the GitHub Actions Job Summary. It always exits 0 — drift is surfaced for a human to notice, never treated as a CI failure. Exists specifically because `deploy/nginx.conf` is manual-deploy-only (see above) and had already drifted silently once before (the `setup-server.sh` privyzap issue was found the same way — a targeted investigation, not this automated check, since the check didn't exist yet at the time).

### OG tags for /mint/:url — bot-only fragment (2026-08-29)

Social crawlers (Twitterbot, Discordbot, TelegramBot, facebookexternalhit, Slackbot, WhatsApp) don't run JS, so they never see the SPA's client-rendered `<title>`/OG meta tags on `/mint/:url` — they'd only ever see the generic homepage preview from `index.html`. Fixed via **User-Agent sniffing at the nginx layer** (chosen over an SSR rewrite or a prerendering service — MVP scope): regular browsers are completely unaffected and still get the normal SPA.

- **Backend:** `backend/src/og.ts` — pure, unit-tested HTML fragment renderer (`renderMintOgHtml()`, `escapeHtml()`, `mintStatusLabel()`) plus `fetchOgMintData()`, a single-mint-scoped version of the `/api/mints/known` aggregate query (same `mint_history` 24h-window join + `computeDegraded()` reuse, just filtered to one `url` instead of pulling the full known-mints payload). Wired up as `GET /api/og/mint?url=` in `index.ts`. **Always returns HTTP 200 with a valid HTML fragment** — unknown mint, missing `url` param, or a DB error all fall back to a generic MintRadar-branded fragment rather than a 404/500, since a crawler getting no body means no link preview at all. `Cache-Control: max-age=60`, matching `KNOWN_MINTS_CACHE_TTL`. Mint `name` is escaped before interpolation (`escapeHtml()`) — it originates from the mint's own untrusted `/v1/info` response.
- **Nginx (`deploy/nginx.conf`):** a `map $http_user_agent $is_social_bot` block (the 6 crawler UAs above) and a `map $request_uri $mint_og_lookup_url` block extract the mint URL path segment. **Deliberately sourced from `$request_uri` (the raw, client-sent request line) and never `$uri`** (nginx's internally-normalized URI variable, which decodes `%XX` escapes before location matching) — the frontend links to mint pages via `/mint/${encodeURIComponent(mint.url)}`, so the path segment is fully percent-encoded (e.g. `https%3A%2F%2Ftestnut.cashu.space`); reading it from `$request_uri` keeps those escapes intact all the way to Express, which decodes them exactly once via its own query-string parser. A `location /mint/ { if ($is_social_bot) { rewrite ^ /api/og/mint?url=$mint_og_lookup_url last; } try_files $uri $uri/ /index.html; }` block does the routing — the `if`+`rewrite ... last` combination is one of the two documented safe uses of `if` inside an nginx `location` (per the "if is evil" wiki page).
- **Verified live in production (2026-08-29)** via `curl -A "Twitterbot" "https://mintradar.pedani.eu/mint/https%3A%2F%2Ftestnut.cashu.space"` — correctly returned `Testnut mint — MintRadar` / `Trust Score: 80% · Online`, confirming the `%2F`/`%3A` round-trip through `$request_uri` works exactly as designed (this was the one part of the implementation that couldn't be verified locally, no nginx binary available in the dev sandbox). A literal, non-percent-encoded test URL (`/mint/testnut.cashu.space`, i.e. not what the frontend actually generates) correctly falls through to the generic fallback fragment rather than erroring — expected behavior for an unknown-URL lookup, not a bug.
- Tests: `backend/src/__tests__/og.test.ts` (14 unit tests — escaping, status label, title/description formatting, all fallback branches) + `backend/src/__tests__/integration/og-mint.test.ts` (6 tests, `supertest` against the real Express `app` with a mocked `pg` pool — known mint, unknown mint, DB-throws, missing `url` param, Cache-Control header, XSS-in-name escaping). Same mocking pattern as `integration/mints-known.test.ts`.

### Service Worker / PWA auto-update

`vite-plugin-pwa` (`registerType: 'autoUpdate'`) only reliably delivers deploys to users when ALL THREE of the following are correct simultaneously:

1. **`public/registerSW.js` listens for `controllerchange` and calls `window.location.reload()` exactly once** — guarded by `let refreshing = false` to prevent reload loops. This file intentionally overrides the library-generated registration script.
2. **`register()` uses `updateViaCache: 'none'`** — without it, the browser may HTTP-cache the workbox chunk (`workbox-xxxxx.js`) that `sw.js` imports, causing update detection to silently fail even though `sw.js` itself is fetched fresh via nginx `no-store`.
3. **nginx serves `sw.js`, `registerSW.js`, and `manifest.webmanifest` with `no-store`** — these files must NOT be caught by the long-lived `immutable` caching rule for content-hashed assets. The explicit `location = /sw.js` and `location = /registerSW.js` blocks in `deploy/nginx.conf` take priority over the wildcard `location ~*` block; do not remove them.

`setInterval(() => registration.update(), 3600000)` in `public/registerSW.js` ensures long-open tabs detect new deploys without requiring a navigation event.

**One-time bootstrap issue:** A user with a very old SW (from before the `controllerchange` listener existed) must manually unregister once via DevTools → Application → Service Workers → Unregister. All subsequent deploys auto-update from that point forward.

### Debugging stale-looking deploys

When a deployed change doesn't appear to users, verify in this order before assuming a code bug:

1. Commit is pushed to `origin/main` and the GH Actions run completed successfully
2. `curl` the exact asset filename referenced by the live `index.html` — confirm the response body contains the expected change (don't trust local build state or git log alone)
3. Only then suspect the service worker / browser cache as the culprit

**Color can mask font-weight:** If a computed property looks "correct" in DevTools but still LOOKS wrong visually, inspect all related computed properties. Example: `font-weight:700` on `var(--text2)` (`#8B90A0`, muted gray) looks visually weaker than non-bold `var(--text)` (`#F0F2F7`, near-white) — this led to a false diagnosis of "bold not working" when the real issue was a color override. Always check the full computed style.

**Synthetic (faux) bold:** JetBrains Mono (`var(--font-mono)`) was only self-hosted at weights 400 and 500. Using `font-weight:700` on any mono element triggered browser-synthesized bold, which renders very weakly. `public/fonts/JetBrainsMono-Bold.woff2` was added with a matching `@font-face` at weight 700 to fix this.

### vault.ts removed (dead code)

`src/core/crypto/vault.ts` was deleted. It had zero imports across the codebase and contained a broken nsec bech32 decode (`.slice(5)` instead of `nip19.decode`). The entire `src/core/crypto/` directory no longer exists — do not recreate it.

### MintCard.tsx — history (was dead code, now the real shared component)

An earlier `src/components/mint/MintCard.tsx`/`.css` was deleted (zero imports at the time). For a while Dashboard and Watchlist each had their own separate inline card renderer instead of a shared one.

**This is no longer true as of the "Post-redesign fixes round 2" session (commit f98694a) below.** `src/components/mint/MintCard.tsx` was recreated and is now the real, actively-imported shared card component used by both `src/pages/Dashboard.tsx` and `src/pages/Watchlist.tsx`. Any task targeting "the mint card" or "the watch button" should edit this file — not Dashboard.tsx/Watchlist.tsx directly — unless the change is genuinely page-specific.

### Card badges — reduced set + header slot (2026-09-08, commits `c02bdac` / `c9fdaf7`)

The `.card-pills` row (lower body of `MintCard.tsx`) no longer carries age or identity badges:

- **Established / Veteran / OG are gone entirely.** The only age signal on a card is now the
  **"New"** badge (`isNewMint()`, `discovered_at` < `NEW_MINT_MAX_DAYS` = 30). `mintAgeBadge()`
  still exists and is still used by `ComparisonModal.tsx`, `Stats.tsx` (its own local copy) and
  the Dashboard **list-view "Age" column** — just not the card or any filter.
- **"New" and "Test mint" both live in the card header slot** (top-right of `.card-name-row`,
  next to the online status dot) via a `.card-hdr-badges` wrapper — classes `.card-hdr-new`,
  `.card-hdr-test-mint`, `.card-hdr-badge`. When a mint is both fresh and a known test mint the
  two render side by side. Neither is in `.card-pills` anymore. (`isTestMint()` detection and
  the Stats "Most Reliable" / Best Mint wizard exclusions are unchanged.)
- **Trust pill** stays in `.card-pills`: `IcShield` + `cardTrustLabel()` ("Trust N" / "Trust
  n/a"), colored by band. Unified across desktop/mobile.
- **Community Rating ★ badge** stays, but its `.card-rating-info` **(i) caveat tooltip was
  removed** 2026-09-08 (the caveat now lives only in the Reviews-tab `.reviews-disclaimer`).
  The `reviewSurge` **⚠** flag (`.card-review-surge-flag`) is unchanged.
- **LN chip** (`.card-ln`) — optional, right after the unit chip. See `cardLightningLabel()` above.
- Mint Detail header equivalent: an inline **Online/Offline** pill next to the name, **First
  seen `<Mon YYYY>`** moved onto the URL row (was colliding with the status pill), and a **`Tor`**
  label (`.md-url-tor`) prefixing any `.onion` URL.

### Mint Detail route param canonicalization (2026-09-08, commit `bbf3eab`)

`resolveMintDetailUrl(slug, known)` in `mintFormatting.ts`, called by the `MintDetail` default
export **before** rendering `MintDetailContent`. Fixes the "ghost mint" bug where
`/mint/21mint.me` (a bare host pasted by a user) never matched the tracked row
`https://21mint.me` and fell through to a hollow live-probe stub (0 NUTs, ~3% Trust,
"Discovered NIP-87", offline) — making 21Mint look dead.

- **exact tracked match** → render as-is (`{kind:'ok'}`).
- else canonicalize a bare host → `https://{host}` (path kept, **no invented trailing slash**)
  and resolve **by hostname**. `pickDashboardRow()` picks among same-host rows: a **probed** row
  (`online != null`) always beats a never-probed NIP-87-only stub, then bare-root `https://host`,
  then higher `trustScore`, then shorter URL → `<Navigate replace>` to the canonical encoded URL.
- **nothing tracked on that host** → a short **`<MintNotTracked>`** state (`.md-not-tracked`,
  "Not a tracked mint" + a "Did you mean `<host>`?" link via `closestKnownHostUrl`) — never a
  fabricated full detail.
- Distinct hosts stay distinct (`bitcoin.aleafnd.org` ≠ `btc.aleafnd.org`). `MintDetailContent`
  now only ever receives a URL that is in `known`, so `knownMint` is always non-null there.
- The in-code "Show my latency" SSRF guard stays as defense-in-depth, but an attacker route
  param now hits the not-tracked state first (no probe-driven detail, no latency button).

### Mint Detail hover-prefetch (2026-08-30)

`useMintHoverPrefetch()` (`src/hooks/useMintHoverPrefetch.ts`) → `prefetchMintDetail()` (`src/core/mint/prefetch.ts`). `MintCard` and Dashboard's compact list row wire `onPointerEnter`/`onPointerLeave` to it. After a **150ms hover-intent delay** (so a fast grid sweep doesn't fire anything) it `queryClient.prefetchQuery`s the exact queryKeys Mint Detail's own `useQuery` calls use — `['mint','probe',url]` (via the shared `mintProbeQueryOptions` exported from `useMintProbe.ts`), `['mint','chart-history',url,'7d']`, `['mint','history-api',url,'24h']`, `['mint','version-history',url]`, `['mint','nostr-reviews',url]`. Navigation then reuses the primed cache with **zero refetch** (verified). Prefetches that lead to a click are net-neutral on request count; only hover-without-click adds load, which the intent delay minimises. Keys MUST stay in sync with MintDetail.tsx or the prefetch silently primes a dead slot.

### Security audit

Original report in `AUDIT.md` at the repo root (2026-06-20). Covers: telemetry, key
handling, dependencies, XSS, backend API, secrets, Docker, HTTP headers. As of 2026-09-07
`npm audit` is **0 vulnerabilities in both trees** (the Vite 5→8 upgrade shipped and closed
the old 6 dev-server-only frontend findings — the "Frontend has 6 remaining" line in older
notes / AUDIT.md's body is stale, see its UPDATE banner).

#### Prior audit history

- **Run-1 (2026-08-16, `security-audit` skill).** 5 findings, all verified remediated in
  code by run-2: WebSocket connect-time DNS pinning (harness-verified), login-shim
  `__mintradarShim` marker, the `/api/notifications/unsubscribe` log-injection fix (run-2
  L1 found the sibling `/subscribe` endpoint was missed — now fixed too), and the
  `isValidCashuMint` submit/discovery gate (run-2 MEDIUM #2 showed it is bypassable — see
  the daily `revalidateMints()` sweep under Cron jobs).
- **Run-2 (2026-09-07, full 8-agent `security-audit` skill run).** Output in
  `~/security-audit-skill/MintRadar/run-2/` (REPORT.md, FINDINGS-DETAIL.md, findings.json —
  validator PASS). **1 HIGH + 6 MEDIUM + 7 LOW — all remediated + deployed by 2026-09-08.**
  - **HIGH H1** — a malicious mint self-inflated its Trust Score to 100 (→ #1 "Most
    Reliable" / Best Mint Wizard) via 60 fake `/v1/info` `contact` entries.
    `contactComponent()` now clamps `Math.min(contactCount, 3)` before the ratio — commit
    `e599749`, see "Trust Score calculation → Contact component" above.
  - **MEDIUM** — M1 `icon_url` favicon deanonymization beacon → SSRF-guarded
    `GET /api/mint/icon` proxy (`b0c3dd8`, see Backend API). M2 "validate once, then
    DNS/redirect-repoint anywhere" confused-deputy → daily `revalidateMints()` +
    `mints.invalid_since` + 7-day reap (`0f53f15`, see Cron jobs). M3 notification fan-out
    amplifier signed by the service key → per-pubkey subscription/relay caps (`aed8159`,
    see `POST /api/notifications/subscribe`); residual sybil-key vector tracked, not closed.
    M4/M5/M6 client-side pubkey-race / hostile-relay trust issues → `5ff2b8d`, see
    "Watchlist sync + relay bootstrap hardening" below.
  - **LOW** — L1 log injection via `relays[]` in `/subscribe` (`sanitizeLogValue()`,
    `ac7c174`). L2 `initBunkerQR` cancelled-QR race → orphaned signer + silent re-login,
    now abort-checked (`0a0cdd0`). L3 NIP-46 `onauth` `window.open` unvalidated →
    `openRemoteSignerAuthUrl()` (https-only, `noopener,noreferrer`) at all 3 onauth sites
    (`ac7c174`). L4 client-side SSRF via a pasted token's `mint` URL →
    `assertProbeableMintUrl()` guard in `cashuToken.ts` (`07a8eac`, see Token Inspector).
    L5 `/api/mint/probe` fetch-oracle → response shrunk for non-known URLs (`ac7c174`, see
    Backend API). L6 "Show my latency" unvalidated route-param fetch → https/length guard +
    `credentials: 'omit'` (`ac7c174`). L7 stale `pendingAutoWatchRef` auto-watch →
    `usePendingAutoWatch(url, isLoggedIn, onAutoWatch)` hook (URL-pinned, timestamped, 60s
    TTL, dropped on route change / Cancel) (`ac7c174`).
  - **Hardening follow-ups** — atomic notification cooldown (`dc4d993`, see
    `notifySubscribers` below); NIP-98 single-use nonce cache (`da7c46d`, see Backend API);
    `script-src` drops `'unsafe-inline'` (`32abfa9`, see the nginx CSP gotcha);
    `discovery.ts` + `versionCatalog.ts` routed through `safeFetch` (`11c30f1`, see
    Discovery pipeline); 4 low-risk items in `3c8867f` (navbar avatar `https://` scheme
    guard; `deploy/nginx.conf` OG map regex `[^/?]+` → `[^/?&#]+`; comment that
    discovery/reviews `SimplePool` is NOT DNS-pinned and only safe because its relay lists
    are hardcoded constants). Community Rating sybil mitigation (disclaimer + `InfoTooltip`
    + `reviewSurge` flag) — see "Reviews Feature" (`a07404b`, `e2b04be`).
  - **User Qs cleared:** NUT-07 checkstate is button-only and leaks no proof secret
    (cashu-ts `NullLogger`, `/v1/checkstate` sends only `hashToCurve(secret)`); a mint
    can't appear "watched" before real auth; nsec never persisted/logged; SQL fully
    parameterized; OG fragment XSS-safe.

#### Watchlist sync + relay bootstrap hardening (2026-09-07, audit M4/M5/M6, commit `5ff2b8d`)

- **M4 — `useWatchlistSync.doSync()`** captured `pubkey` at effect time and never re-checked
  it after `await fetchRemoteWatchlist()`; a logout+login of a different user on the same
  device mid-fetch let user A's remote list be written to Dexie and re-published as user B's
  own kind:10003. Now re-reads `useAuthStore.getState().profile?.pubkey` after every `await`
  and discards the result untouched if it changed; the `isSyncing` guard is only released by
  the run that still owns the active identity.
- **M5 — `fetchRemoteWatchlist()`** took the first relay to answer (`Promise.any`) with no
  `created_at` comparison, so a lagging/stale relay silently rolled the watchlist back and
  Phase 2 re-published the older revision. Now **collects** events across relays within the
  wait window (all-settled, or a short grace after the first event, capped at the existing
  3s) and keeps the highest `created_at`; also drops events whose `pubkey` != the user (a
  relay ignoring the `authors` filter).
- **M6 — `bootstrapUserData()` / `subscribeFirstEvent()`** acted on the first kind:0 /
  kind:10002 a relay returned, checking only `verifyEvent()` (signature self-consistency,
  not ownership). A hostile relay in `META_RELAYS` could set the victim's displayed
  name/avatar and swap in an attacker-controlled NIP-65 relay list, redirecting outbound
  watchlist/DM traffic. Now pins `ev.pubkey === expectedPubkey` before use.
- Tests: `src/__tests__/{watchlistSync,bootstrapUserData,useWatchlistSync}.test.ts` +
  an e2e case in `watchlist-sync-status.spec.ts`.

## Dependency versions (as of 2026-06-29)

### Frontend
- eslint: 10.6.0 (upgraded from 9.x)
- eslint-plugin-react-hooks: 7.1.1 (upgraded from 5.2.0 — v7 adds ESLint v10 support)
- lucide-react: 1.22.0
- globals: 17.7.0
- @types/node: 26.0.1
- immer: 11.1.16 (upgraded 2026-08-15 — was held at v10 pending verification with Zustand, now confirmed compatible, see the "GOTCHA — Dependabot PRs" Batch 3 note above)
- @noble/hashes: 2.3.0 (upgraded 2026-08-15 — v2's `exports` map requires explicit `.js` subpath extensions; see Batch 3 note above)

### Backend
- undici: 8.5.0 (security fix — 8 CVE patched)
- pg: 8.22.0
- node-cron: 4.5.0
- @typescript-eslint/eslint-plugin: 8.62.0
- @types/node: 26.0.1

## Stats Page Layout (as of 2026-06-29)

3-column grid (`.stats-cards-grid`) with `align-items: start` — cards shrink to content height:
- **Row 1, col 1:** Software in Use (accordion — click SW row to expand versions)
- **Row 1, col 2:** Geographic Distribution
- **Col 3, rows 1–2:** `.stats-right-col` with `grid-row: span 2` (desktop only; resets at ≤1100px) — contains Most Reliable (Top 5) + Trust Score Trend stacked
- **Row 2, col 1–2:** NUT Coverage with `gridColumn: 'span 2'` and `column-gap: 48px` between the two NUT columns

At ≤1100px: `stats-right-col` gets `grid-row: auto`. At ≤700px: single column.

### Network Health Index — final layout (commit 92c28d8, several iterations)

Went through multiple repositioning attempts before landing on the final placement:
- **Final:** own panel in the right column (`.stats-right-col`), stacked between "Most Reliable" and "Trust Score Trend" — not merged with either.
- **Rejected earlier attempt:** living inside the left 3-column block alongside Software in Use + Geographic Distribution. Reverted — the left block is back to its original 2 columns (Software in Use + Geographic Distribution only).
- **NUT Coverage Across the Network** was never touched during any of these iterations — its CSS/position is exactly as in the original "Stats Page Layout" section above.
- Card format: horizontal — 60px ring on the left, badge on the right. `align-items: start` on the outer grid so panels don't stretch/merge into each other.

**Lesson learned:** when a layout "looks different" or "looks empty" mid-iteration, ask immediately for a `getComputedStyle`/pixel probe instead of judging from a screenshot — visual estimation on this task burned several unnecessary rounds before the probe was requested.

### Stats widgets — 2026-09-08 changes (commits `f2b25ff` / `781617d`)

- **`displayName()` everywhere** (`f2b25ff`) — Most Reliable, Trust Score Movers, software
  drilldown, geo modal and NUT-support modal now render mint titles via the shared
  `displayName()` denylist fallback instead of raw `info.name`, so `"Cashu mint"` etc. fall
  back to the hostname (matches the Dashboard cards).
- **Header tile subtitles** (`f2b25ff`) — "Mints Tracked"/"Online Now" get "all known"/"of all
  known"; median latency notes "from Frankfurt". Avg mint uptime subtitle: `f2b25ff` set it to
  "across all known (offline pulls it down)"; `781617d` trimmed the parenthetical → **"across
  all known"**.
- **NHI "Online mints" row tooltip** (`f2b25ff`) — now explicitly says `"<n>/30 are NHI points
  (this row is 30% of the index), not <n> mints online. Dashboard listed/online counts are a
  different set."` so it can't be confused with the Dashboard's online headcount. The
  panel-level ⓘ makes the same point.
- **Most Reliable list excludes `isTestMint()`** (`781617d`) — `top5ByUptime` filters them out;
  the **Trust tab (`top5ByTrust`) is deliberately untouched** and still shows a 🧪 Test badge.
  (An earlier pass, `f2b25ff`, only *badged* them here; `781617d` actually excludes them from
  the Reliable list.)
- **Geographic Distribution — "CDN / anycast" bucket** (`781617d`) — `normalizeGeoLoc()` +
  `CDN_BUCKET` in `src/utils/geoDistribution.ts`: a `serverLocation` matching
  `cloudflare|cdn|aws|amazon|anycast|akamai|fastly|gcp|google cloud|azure|edgecast|bunny|stackpath|cloudfront`
  (case-insensitive) collapses to one **"CDN / anycast"** row (counts merged in
  `computeGeoDistribution`; `Stats.geoLabel` + the `cityMints` modal filter also normalize).
  **The GeoIP lookup / backend is unchanged** — this is display/aggregation only.
- **Movers + Most Reliable rows** (`781617d`) — the hostname subtitle `<div>` is omitted when
  `displayName === hostname` (same rule as the mint cards).
- **Software in Use panel** (`781617d`) — "Running outdated or older versions" →
  **"Behind current release"** + a `.stats-sw-behind-info` (i): "we compare the version each
  mint reports to the latest known release for that implementation — not a CVE or security
  score." **The 75% `swFreshnessSummary.pct` formula is unchanged.**
- Tests: `e2e/stats-widgets.spec.ts`, `e2e/stats-nhi-gauge.spec.ts`,
  `src/__tests__/geoDistribution.test.ts` (`normalizeGeoLoc`).

## Dashboard Mint Count Distinction (deliberate product decision — 2026-06-20)

The Dashboard stat bar intentionally shows TWO different denominators that represent TWO different concepts:

- **"ONLINE MINTS X/Y" denominator** — "active" mints only (excludes mints that have been offline for 24h+, which are hidden from the grid by default behind a "N mints hidden (offline 24h+) — Show" toggle). Matches what's visible in the grid.
- **"KNOWN MINTS"** — absolute total mint count across the whole system (same source as Stats page "MINTS TRACKED", same as `rows.length` from `/api/stats`). Includes long-offline mints.

These are intentionally different numbers (e.g. "ONLINE MINTS 50/69" vs "ALL KNOWN 88"). "Online X/Y" (Y = non-degraded) and "All Known" (the full set) are still a deliberate distinction — do NOT "fix" that.

The grid's default behavior of hiding 24h+ offline mints is intentional decluttering. The footer shows: "Showing X of N" (`.grid-showing-note`) + a separate "N mints hidden (offline 24h+) — Show" note.

**Single source of truth for the total (2026-09-08, commit `03f1aeb`):** the Dashboard used to
merge `useNostrMints()` — a *live client-side* kind:38172 discovery query — into `allMints` and
the footer total, which produced a real mismatch (**footer "of 102" vs "All Known" tile / Stats
"94"**). Those extra URLs were raw Nostr announcements the backend had **rejected** via
`isValidCashuMint()` in `/api/mints/discover` — not tracked mints. `useNostrMints` was removed
from Dashboard entirely (`useNostrDiscovery()`, which POSTs new URLs to `/api/mints/discover`
for backend validation, stays). Now **`knownTotal = knownMintsData?.length ?? 0`** is the one
number behind the "All Known" tile *and* the grid footer's "of N" — and it already equals
`/api/stats.totalMints` server-side (both are an unfiltered `SELECT … FROM mints`, locked by
`integration/known-count-consistency.test.ts`). The footer now always reads "Showing `<shown>`
of `<knownTotal>`" regardless of filters/hiding. `useNostrMints.ts` / `mintDiscovery.ts` are now
a dead chain (left in place, not deleted).

## Typography & Design System Notes

Self-hosted font weights (unchanged by the 2026-07-24 color redesign — see "Visual Redesign" section below):
- **DM Sans** — variable, weights 100–900; `--font-body`, `--font-display`, `--sans`
- **JetBrains Mono** — 400 Regular, 500 Medium, 700 Bold; `--font-mono` (non-numeric mono text: pubkeys, URLs, version strings). Bold was added in `public/fonts/JetBrainsMono-Bold.woff2` + `@font-face` because weight 700 previously triggered faux bold.
- **`--font-mono-data`** (new, 2026-07-24) — system `ui-monospace` stack (no webfont), used exclusively for numeric/data values (latency, %, NUT counts). See "Visual Redesign" section.

**Stat box padding** — Desktop: Dashboard `.stat-card` and Stats `.stats-metric-card` both use `14px 20px`. MintDetail `.md-sc` uses `12px 16px` intentionally (tighter layout, product decision — do not "unify" without confirmation). Mobile: Dashboard reduces to `10px 14px` at `≤600px`; Stats reduces to `10px 14px` at `≤700px`.

**Mint Info value rows** (MintDetail) — all value `<span>` elements use `.md-info-value` class only, with no inline color/weight/family overrides. Inline `color: var(--text2)` previously made bold text look dim. Full description keeps `style={{textAlign:'left', maxWidth:'none', lineHeight:1.5}}` for layout only.

**Text colors (as of 2026-07-24 redesign)** — `--text` (`#f2f7f4`) for primary/bold values, `--text2`/`--text-dim` (`#b7c8c0`) for secondary/muted, `--text3`/`--t3`/`--text-faint` (`#9aada4`) for tertiary labels. These replace the old DM Sans v2 values (`#F0F2F7`/`#8B90A0`/`#AAB4C7`). **2026-09-04:** `--t3` was `#86988f`, which measured only **4.03:1** on `--surface-card` (`#223a2f`, the mint-card background) — below the WCAG 2.1 AA 4.5:1 threshold for normal text, and `.card-host` / `.latency-label` / `.latency-value.muted` on every Dashboard/Watchlist mint card use it. Bumped to `#9aada4`: now 5.18:1 on `--surface-card`, 7.14:1 on `--bg`, 6.73:1 on `--surface`, 6.26:1 on `--elevated` — AA-clean on every real background. Still clearly the muted tier (L\* 0.39 vs `--t2` 0.55 / `--t1` 0.92).

## Visual Redesign — "Patina/Copper" Palette (2026-07-24)

**Why:** the original palette (pure `#000` background + full neon green) had low contrast on
secondary text and a "punk"/cheap look on buttons (solid color fill, large pill radius with
no subtlety). The new palette fixes both.

**Source of truth:** the design system now lives directly in code, not in a separate
mockup file. Colors/tokens are defined in `src/index.css` (see the CSS custom properties
listed below); component patterns are established by existing shared components (e.g.
`src/components/mint/MintCard.tsx`, `src/components/learn/KeyTakeaway.tsx`). Check those
before changing colors or introducing new component patterns.
(`mintradar_redesign_mockup.html`, previously kept at the repo root as a reference mockup
for this redesign, was deleted once the palette/components below landed in code — do not
recreate it or reference it as if it still exists.)

**New design tokens (`src/index.css`):**
- `--bg` / `--surface` / `--surface-2` / `--surface-3` — dark "verdigris/patina" green-gray instead of pure black (`--bg: #10201c`)
- `--text` / `--text-dim` / `--text-faint` — see Typography section above for exact values and contrast verification
- `--green` / `--green-bright` — muted "patina" green instead of neon (reference: patina on coins)
- `--copper` — new secondary accent (reference: coin minting); alternates with green on the Stats page's Software-in-Use and Geographic-Distribution bars
- `--amber`, `--red` — semantic colors (fresh/warning, offline/error)
- every color has a `-soft` and `-soft-strong` variant, used for tonal backgrounds/borders instead of solid fills
- `--font-mono-data` — system `ui-monospace` stack for numeric values only (see Typography section)
- `--radius-m` (10px) — smaller radius for buttons, replacing the old large pill shape
- fonts remain 100% system/self-hosted — no Google Fonts, no external CDN, zero tracking

**Component changes:**
- Buttons (`Login via Nostr`, `Connect`, `+Submit mint`, `+Watch`, `Compare`) — solid neon fill → tonal outline style
- Dashboard mint cards — removed the per-status colored border/gradient (previously every card had a green-tinted border/background regardless of online/offline state); now a neutral border, with color reserved for the status dot and the trust-score chip only
- Login modal — option cards (Nostr extension/nsec/Amber) get a green tonal border+background only when selected; the nsec security notice box changed from yellow to copper
- Trust Score ring (Mint Detail) — fixed `--green-bright` ring color (no longer colored by score band), track `--surface-3` — the ring is now purely visual, the score band ("High/Moderate/Low Trust") is still conveyed by the badge text below it
- `mintAgeBadge()` (`src/utils/mintFormatting.ts`) — Established badge → new tonal green, Fresh badge → copper/amber (was blue); Veteran/OG badges intentionally unchanged (out of scope). **Superseded 2026-09-08: the card no longer shows these badges at all — see "Card badges" below.**
- Stats page — progress bars alternate green/copper by row index instead of one fixed color for all

**Audit reliability score:** see the shared-module note under "Trust Score calculation" above.

**Audit data source (resolved 2026-08-06):** `audit.8333.space`'s `GET /mints/` API (paginated,
100/page) returns cumulative lifetime counts for `n_mints`/`n_melts`/`n_errors` — these are kept
(as `audit_n_*`) purely for the display-only all-time line on the Audit tab. The Trust Score's audit
component now matches the reference `pablof7z/cashu-mint-audit` project's approach: it uses a
rolling window of each mint's last ~100 swaps, fetched per-mint from `GET /swaps/mint/{id}`
(`audit_recent_total`/`audit_recent_errors`) — see "Discovery pipeline" above. A mint with fewer
than 3 recent swaps scores as "Unknown" (2.5, same neutral default as no audit data at all)
instead of a misleadingly precise error rate from a tiny sample.

**Manually added mint:** `mint.hanbitkorea.org` was found via an `audit.8333.space` cross-check
and was missing from the DB; added manually.

### Post-redesign fixes (commit 3af7e6f)

Follow-up fix commit addressing regressions/missed spots from the original redesign above:
- Nav bar (`AppShell.css`) — background changed from hardcoded `rgba(15,17,21,.92)` to `var(--bg)`, removing a visible "seam" against the page body
- Stats — Software in Use expand panel (`Stats.css`, `.sw-ver-panel`) — hardcoded `#0d1117` → `var(--surface-2)`
- Stats — Geographic Distribution modal (`Stats.tsx`, `CityMintsModal`) — rebuilt to match the Trust Score/NUT modal pattern (flag+name+count chip+close header, status dot/name/badge/trust % rows, footer summary); status dot and trust colors moved to the new tokens, percentage uses `--font-mono-data`; functionality (click-through to detail, sorting) unchanged
- Mint Detail — "Show QR code" and "Copy" buttons (`MintDetail.tsx`) — solid neon fill → tonal outline, matching "Compare"/"+ Watch"
- Watchlist — Login button (`Watchlist.tsx`) — added ⚡ icon, now identical to the nav button

A before/after reference mockup for all 5 items (tab "Opravy") was included in this commit as `mintradar_redesign_mockup.html`; the file has since been deleted (design system fully landed in code — see "Visual Redesign" above), so this is historical context only, not a file that still exists in the repo.

Verified: typecheck, ESLint, 70/70 unit tests, production build all pass; visually confirmed via Playwright.

### Post-redesign fixes round 2 (commit f98694a)

- New shared component `src/components/mint/MintCard.tsx` — used by both Dashboard and Watchlist (Watchlist previously had its own, non-redesigned copy of the mint card). If the card style changes again, change only this file.
- Shared utilities moved into `mintFormatting.ts`: `mintAgeBadge`, `uptimeColor`, `formatTimeAgo` — Watchlist no longer has its own duplicate version.
- New design token `--surface-card` (slightly lighter than `--surface`) + `inset` top highlight on `.mint-card` — visually distinguishes mint cards from other panels.
- Watchlist CTA (empty state) — `.wl-add-btn` is a solid primary button (`var(--green)` fill), deliberately distinct from the smaller outline nav button (secondary vs. primary action).
- Offline/degraded mint cards — opacity 0.7, "Offline 24h+" badge, "Last seen" (from `lastCheckedAt`) instead of latency.
- Mint Detail mobile header — compact version on the mobile breakpoint only (icon back button, online pill on the same row, Watch/Compare 50/50); desktop layout unchanged.
- "Show my latency" button unified with the others (tonal outline).
- "NIP-87" badge on Watchlist: purple → copper (`--copper`).

A before/after reference mockup for all items (tabs "Watchlist prihlásený", "Mint Detail mobil header", "Latency btn / Offline / Card elevation") was included in this commit as `mintradar_redesign_mockup.html`; the file has since been deleted (see "Visual Redesign" above), so this is historical context only, not a file that still exists in the repo.

Verified: typecheck, ESLint, 70/70 unit tests, production build all pass; visually confirmed via Playwright with mocked API (7 screenshots).

### Card elevation contrast fix (commit 9abda76)

The `--surface-card` token introduced in round 2 above was visually too subtle — on an actual screenshot it was nearly indistinguishable from `--bg`. Strengthened:
- `--surface-card`: `#1c2b25` → `#223a2f`
- `.mint-card` border: now `var(--border-strong)` directly (not just on `:hover`)
- Inset top highlight: opacity `.05` → `.07`

Applied automatically everywhere via the shared `MintCard.tsx` component (Dashboard and Watchlist both pick it up with no per-page changes needed) — see "MintCard.tsx — history" above for why that component being shared matters here.

### QR modal design fix + Mint Detail mobile header v2 (retry)

- QR "Add to wallet" modal — container hardcoded `#161b22`/`#30363d` → `var(--surface-2)`/`var(--border-strong)`; header icon replaced with `MintFavicon` directly; URL input → `var(--surface-3)`/`var(--border)`
- Mint Detail mobile header — finally implemented (it was prepared in an earlier prompt round but never actually shipped by mistake): back arrow (30px circle) on the same row as avatar/name/URL, status dot instead of a separate "Online" pill, age badge on the right. Desktop layout unchanged (new elements hidden outside `@media (max-width: 768px)`)
- Mobile stat tiles (Latency/Uptime/Version/NUTs) — at ≤768px the large icon is hidden, padding narrowed, value 15px/600 on `--font-mono-data`

### Dashboard filter bugs (fixed)

- **Reset button (↻):** previously only did `queryClient.invalidateQueries` (refetched data) without resetting search/sort/filters/`showDegraded`. Fixed — now resets everything to default (search cleared, sort `name`/`asc`, `activeFilters`/`pendingFilters` → `DEFAULT_FILTERS`, `showDegraded=false`, closes filter panel) and only then refetches.
- **Status=Offline filter returning empty results:** root cause — `allMints` was computed by hiding degraded mints via `showDegraded` *before* `applyFilters()` ran, so Status=Offline and the default `showDegraded=false` behaved like an AND and cancelled each other out. Fix: `effectiveShowDegraded = showDegraded || activeFilters.status === 'offline'` — explicitly picking the Offline filter now overrides the default hiding. The "N mints hidden" message only shows when the Status filter isn't "Offline" (otherwise it would be misleading).
- File: `Dashboard.tsx`

Verified: typecheck ✅, build ✅, 70/70 unit tests ✅, Playwright confirmed both scenarios (Status=Offline shows offline mints including 24h+; Reset restores default state).

### Dashboard controls row (2026-09-05)

- **"Most reviewed" sort** — a 5th sort button (`sortBy: 'reviewCount'`), placed before
  Rating, ordering mints by `reviewCount` descending; mints with `reviewCount` 0 or `null`
  always sort last regardless of direction toggle. Same `reviewCount ?? 0`-last convention
  used for tie-breaking as the weighted-rating sort (see "Rating sort uses a weighted/Bayesian
  rating" above). e2e coverage in `e2e/dashboard.spec.ts`.
- **Floating controls row** — the single shared border+background box that used to wrap
  search/Filters/sort/view-toggle/Submit-mint as one bar was removed. Each control group now
  floats independently with its own border/background (`.search-input`, `.filter-btn`,
  `.sort-segment`, `.view-toggle`, `.submit-btn`, `.refresh-btn`), matching the `.stat-card`
  row's visual pattern above it — `.dashboard-controls` itself carries no border/background
  anymore.
- **New `900px` breakpoint** (separate from the general `768px` one) — adding the 5th sort
  button meant the row no longer fit on one line as far up as ~900px; above 768px the
  search+Filters pairing is still desktop-style, so this breakpoint only wraps the row and
  shrinks the sort buttons rather than restructuring search/Filters like the 768px block does.

### Dashboard filter panel — Mint age removed (2026-09-08, commit `c02bdac`)

The **"Mint age" (Fresh/Established/Veteran/OG) filter block is gone** — the whole state chain
was removed: `FilterState.mintAges`, `AGE_LABELS`, the `applyFilters` branch,
`countActiveFilters` term, the `?age=` URL param + its filter-tag chip, and the panel group.
The panel is now just **Status** + **Min. Trust Score**. Rationale: those four labels stopped
being a product concept once the card badge set shrank (see "Card badges" above). No
replacement third filter was added (no LN filter, no unit filter). On mobile the two remaining
groups sit side by side (`.filter-row` → `row / nowrap`) so the sheet is shorter.
`requiredNuts` filter state is left in place but is URL-only (`?nuts=`), no panel UI.

### Tools page layout — iterations and final state

Two desktop-layout attempts for the Tools page (`Tools.css`/`Tools.tsx`) were tried and reverted before landing on the final, minimal fix:
- **Attempt 1 (rejected):** `max-width: 420px` on individual elements (`.token-input`, `.tool-btn-primary`, a `.wizard-options-compact` modifier on the Small/Medium/Large option rows). Created dead space inside the panels on wide screens.
- **Attempt 2 (rejected):** `max-width` on the whole content grid via a centered container. Created empty margins on very wide monitors (32"+).
- **Final state:** layout reverted to full width everywhere — panels, the token textarea, and the Small/Medium/Large option rows are all 100% width again, matching the pre-iteration baseline. The only surviving change is the "Inspect Token" button: it got its own `inspect-token-btn` class (kept separate from the shared `.tool-btn-primary` specifically so the wizard's "Find my mints" button, which also uses `.tool-btn-primary`, is unaffected), with `max-width: 280px` and centered, desktop-only.
- Mobile layout was never touched across any of these iterations — confirmed correct throughout.
- The "Tools desktop fix" and "Tools v2" tabs documenting the two rejected attempts lived in `mintradar_redesign_mockup.html`, which has since been deleted (see "Visual Redesign" above) — this list is now the only record of what was tried and why it didn't work.

### Best Mint Wizard (`Tools.tsx` `BestMintWizard`) — 2026-09-08 (commit `781617d`)

- **Disclaimer** — `.wizard-disclaimer` under the "Best Mint for Me" title reads exactly
  **"Suggestions from our measurements, not an endorsement."**
- **Test mints excluded** — `candidates` already filters `!isTestMint(m.url)` (line ~473);
  unchanged, but now explicitly a requirement.
- **Result rows** — use `displayName(rec.mint)` for the name, and the **card formatting** for
  the score: `IcShield` + `cardTrustLabel()` colored by band (`.wizard-rec-trust`) plus a
  `cardLightningLabel()` `<Zap>` chip (`.wizard-rec-ln`) — replacing the old bare `NN%`
  `.wizard-rec-score`. Per-unit NUT-04/05 limits and the whole-mint caveat note are unchanged.
- Token Inspector is untouched by this pass.

### Token Inspector (2026-09-05, `Tools.tsx` + `src/utils/cashuToken.ts`)

- **Memo display** — a decoded token's `memo` field (when present) renders as its own row
  (`.token-memo-row`) in the inspection result.
- **Mint risk badge** — `mintRiskLevel()` (`src/utils/mintFormatting.ts`) classifies the
  token's mint as high/medium/low/unknown risk from its known-mints data (`online`,
  `degraded`, `trustScore`): offline or degraded → high, `trustScore < 40` → medium,
  otherwise low, `null` mint → unknown. Rendered with the shared `IcShield` icon (see "Trust
  Score vs Community Rating" above).
- **"Check if spent" (NUT-07)** — `checkTokenSpentState()` (`src/utils/cashuToken.ts`) asks
  the token's own mint directly whether its proofs have already been redeemed, returning a
  `TokenSpentCheck`. A button in the inspector result triggers this on demand (not automatic
  — doing so tells the mint someone is checking that specific token right now, which the UI
  discloses via a tooltip).
- **`assertProbeableMintUrl()` (`src/utils/cashuToken.ts`, 2026-09-07 audit L4)** — both
  `decodeTokenWithMint()` and `checkTokenSpentState()` call it before `new Wallet(mint)`.
  `info.mint` comes from a fully attacker-controlled pasted token and was handed straight to
  cashu-ts (no host/scheme allowlist), so a crafted token could make the victim's browser
  hit `http://localhost:9200`, `javascript:`, or an internal IP. The guard requires
  `https://`, length ≤ 500, and a public host (rejects loopback / RFC1918 / link-local /
  CGNAT / IPv6 loopback+ULA+link-local) — same policy as `core/mint/api.ts`'s `validateUrl()`
  and the MintDetail "Test latency" guard. Throws a typed `InvalidMintUrlError`; `Tools.tsx`
  renders it as a distinct `"bad-mint-url"` result and makes **no** network request.
- **`InfoTooltip`** (`src/components/InfoTooltip.tsx` + co-located `.css`) — the shared ⓘ
  hover-on-desktop / tap-on-mobile tooltip (`text` / `width` / `iconSize` / `className` /
  `tone` / `label` props; wraps `useTapTooltip`; popup is `role="tooltip"` with its own
  `.info-tooltip-pop` styling so it renders identically regardless of which page stylesheet is
  loaded). Promoted out of `Tools.tsx` (2026-09-08). **Current uses:** DLEQ / NUT-07 in Tools,
  and the `reviewSurge` **⚠** flag (`tone="warn"`) on the Community Rating tile
  (`.review-surge-flag`) + mint card ★ badge (`.card-review-surge-flag`). **The plain caveat
  (i) on `.community-rating-info` / `.card-rating-info` was REMOVED 2026-09-08** — the
  self-published-reviews caveat now lives only in the Reviews-tab `.reviews-disclaimer`.
  Don't re-add a page-local copy of the component.
- **`normalizeMintUrl()` moved to `src/utils/mintFormatting.ts`** (was previously local to
  `Tools.tsx`) — lowercases the hostname, forces `https:`, strips a trailing `/` on a bare
  root path. Import it from there if another page needs the same normalization.

## NUT list — single source of truth (2026-08-19)

`src/constants/nuts.ts` is the only place the tracked-NUT list and its display metadata
live: `TRACKED_NUTS` (25 entries, ascending), `TRACKED_NUT_KEYS` (the unpadded `'4'`/`'5'`…
form used by `/v1/info`'s `nuts` object and the `nuts_limits` column), `NUT_META`
(short label / description / `specNum`) and `nutSpecUrl()`.

It replaced four drifting copies: `MintDetail.tsx`'s `ALL_NUTS`, `Stats.tsx`'s `NUT_ORDER`
(plus its own near-identical `NUT_META`), `ComparisonModal.tsx`'s `NUT_FILTER_KEYS`, and
`NutExplorer.tsx`'s `NUT_META`. `src/__tests__/nuts.test.ts` pins the invariants, including
`TRACKED_NUTS.length === TRACKED_NUT_COUNT` (the Trust Score's NUT divisor).

**Deliberately NOT folded in** — these are different lists, not copies:
- `NUT_FILTER_KEYS` in `Dashboard.tsx` — filter chips that intentionally include `'13'`,
  which `TRACKED_NUTS` excludes. Merging them would silently drop a filter. (Watchlist no
  longer has a filter panel at all as of 2026-09-04 — see "Watchlist changes" below.)
- `NUT_DESCRIPTIONS` in `MintDetail.tsx` — a richer structure (`features`, `useCase`) that
  also covers the mandatory NUTs 00-03/06 for the NUT detail modal.

## Nostr pool singleton

`src/core/nostr/pool.ts` exports `sharedPool` — a single `SimplePool` instance patched with exponential backoff (1s base, doubles per attempt, 5-min cap, ±20% jitter). All frontend Nostr reads/writes must use `sharedPool`. Never call `sharedPool.destroy()`.

## Backup cron

Runs every 6h: `0 */6 * * *` → `scripts/backup-db.sh`
- Output: `/var/backups/mintradar/mintradar_YYYYMMDD_HHMMSS.sql.gz` (rotates to 7 days)
- Log: `/var/log/mintradar-backup.log`
- Format: `pg_dump | gzip` — plain SQL, suitable for `zcat | psql` restore
- NOTE: `/var/backups/mintradar/` and `/var/log/mintradar-backup.log` must be owned by `deploy` user (created with `sudo`, `mkdir -p` in script cannot create them itself)

## Reviews Feature (Mint Detail)

All review-related relay lists live in `src/core/nostr/relays.ts`:
- **REVIEW_READ_RELAYS** (added 2026-08-30) — curated 7-relay fast-path used by `src/hooks/useMintReviews.ts` for the client-side read. `querySync` resolves only once EVERY listed relay EOSEs or times out, so this is deliberately small and only relays measured to connect+EOSE <600ms. Excludes `relay.8333.space` (EHOSTUNREACH), `relay.snort.social` (503 on anon REQ), `nostr.wine` (403), and the slower long-tail. Paired with `{ maxWait: 2000 }` on the querySync call (without it, nostr-tools falls back to a 4400ms per-relay EOSE ceiling — that was the bulk of the old client-side review-load delay).
- **REVIEW_RELAYS** (= DISCOVERY_RELAYS + `relay.minibits.cash`) — no longer used for the read path; kept only as the base for REVIEW_PUBLISH_RELAYS.
- **REVIEW_PUBLISH_RELAYS** (= REVIEW_RELAYS + 7 extra relays: bitcoiner.social, nostr.mom, oxtr.dev, mostr.pub, noswhere.com, pyramid.fiatjaf.com, lopp.social) — wider net used only by `src/hooks/useSubmitReview.ts` when publishing, for propagation reach
- **PROFILE_RELAYS** — unchanged, used for kind:0 profile lookups only

Backend `REVIEW_SYNC_RELAYS` (`backend/src/reviewsSync.ts`, re-exported from `index.ts` as `NOSTR_REVIEWS_RELAYS`) is the broad list used by the 6h background sync — it has a generous time budget so it favours coverage over latency (opposite trade-off from REVIEW_READ_RELAYS). It's a manual mirror of the old REVIEW_RELAYS; `backend/src/__tests__/nostrReviewsRelays.test.ts` pins the exact array as a drift tripwire. The frontend fast-path list is deliberately NOT mirrored.

**Two independent review-fetch mechanisms, by design (documented 2026-08-29; reworked 2026-08-30 for load perf):**
- **Primary — `useMintReviews.ts`**: live, client-side, no cache, fetched fresh on every Mint Detail visit via REVIEW_READ_RELAYS + maxWait 2000ms. Still what lets a user see their own review immediately after posting one (`useSubmitReview.ts`). It's now the *background refresh*, not the gate for first paint.
- **Secondary — `GET /api/mints/nostr-reviews`**: as of 2026-08-30 this is a **DB read from `mint_reviews`** (was a live per-request relay query, ~3s — the single biggest Mint Detail load cost). The rows come from the 6h `refreshAllMintReviews()` sync. `MintDetail.tsx`'s `mergedReviews` still only adds reviews the primary fetch didn't find — never shown twice.
- **Community-rating stat tile** reads `knownMint.reviewCount` / `reviewAvgRating` (the `mints` rollup, in `/api/mints/known`) while the live fetch is still running — `tileReviewCount` / `tileAvgRating` in `MintDetail.tsx`. This replaced a ~4s window where the empty live array made the tile flash a wrong "No reviews yet". `null` on both the rollup and the live side renders a "…" skeleton (same idea as the existing "Loading live mint data" placeholder).
- Do not remove either mechanism without re-confirming with the maintainer — see the review-fetch investigation report for the full reasoning.

**Rating sort uses a weighted/Bayesian rating, not the raw average (2026-09-03).**
`/api/mints/known` also returns `reviewWeightedRating` per mint — the IMDB formula
`WR = (v/(v+m))·R + (m/(v+m))·C` (`backend/src/weightedRating.ts`): `R` = `reviewAvgRating`,
`v` = `reviewCount`, `m = 8` (≈ p75 / mean of review counts among the 51 rated mints — median 3,
mean 8.73, max 102; a mint must reach the top quartile of review volume before its own average
outweighs the crowd), `C` = mean `reviewAvgRating` over all mints with ≥1 review and a non-null
average. `C` is computed in the `/api/mints/known` handler (which already loads every mint in one
query) — NOT in `reviewsSync`'s per-mint rollup, which would need a full-table scan per mint to
get `C`. **Display is unchanged** — the Community Rating badge still shows `reviewAvgRating` /
`reviewCount`. Frontend Rating sort (`Dashboard.tsx` ×2, `Watchlist.tsx`) orders by
`reviewWeightedRating ?? reviewAvgRating ?? -1`. Tests: `backend/src/__tests__/weightedRating.test.ts`
+ a case in `integration/mints-known.test.ts` (1×5.0 review ranks below 99×4.7).

Key implementation details:
- Rating parsed from `content` via regex `/\[(\d)\/5\]/` — the `rating` tag does not exist in practice
- **REQ `limit` is 500** (`useMintReviews.ts` + backend `/api/mints/nostr-reviews`), raised from 50 on 2026-08-30 — with limit 50 the dominant relays all returned the same newest 50 events, so the pool union barely exceeded 50 and undercounted mints like `mint.minibits.cash/Bitcoin` (~85 real reviews, cashumints.space shows 82) by ~40%.
- Rating-less / comment-less kind:38000 events are **kept and counted** as reviews (a bare event pointing at a mint is still an endorsement — matches how cashumints.space counts). `sortReviewsByNewest()` in `reviewUtils.ts` no longer filters them (was `filterAndSortReviews`). The **average-★ calculation excludes them** (`MintDetail.tsx` `ratedReviews = mergedReviews.filter(r => r.rating !== null)`) so they never dilute the score; the UI list renders them with no stars.
- The header count ("X reviews · via NIP-87") reflects `mergedReviews.length` — the exact array rendered in the list — not the primary browser fetch alone.
- Author Nostr profiles (name + avatar) are fetched inline inside `useMintReviews.ts` via **PROFILE_RELAYS** — a separate `useNostrProfiles` hook was removed due to a React state sync bug
- Author Nostr profiles (name + avatar) are fetched inline inside `useMintReviews.ts` via **PROFILE_RELAYS** — a separate `useNostrProfiles` hook was removed due to a React state sync bug
- Security: `profile.picture` is rendered only if it starts with `https://`

**Reviews tab filter chips + Hide anon (2026-09-04, `MintDetail.tsx`):** the Reviews tab has
an All/5★/Critical filter chip group (`reviews-filter-chip`, one active at a time,
`reviewFilterState` keyed by mint `url`) plus an independent "Hide anon" toggle chip
(`reviewHideAnonState`) applied on top. Critical = `rating !== null && rating <= 2`
(explicitly excludes rating-less endorsement events, not just "≤2 or null"). **Chip counts
follow the Hide anon toggle, not the full review corpus** — `reviewCountBase` is
`mergedReviews` filtered to named authors when Hide anon is on, else the full list; every
chip count (`All`, `5★`, `Critical`) derives from `reviewCountBase` so the numbers on the
chips always match what's actually visible. The "Hide anon" chip's own count is always the
full anonymous-review count (`reviewFilterAnonCount`), independent of its own on/off state.
A `.reviews-disclaimer` line sits above the chip row, unconditionally. As of 2026-09-08
(sybil Community Rating mitigation, step 1) it reads: "Reviews are self-published Nostr
events (NIP-87). Anyone can create a new key, so a rating can be artificially inflated —
treat it as a directional signal, not proof. Counts may also differ from other sites."
(The `InfoTooltip` (i) that briefly also carried this caveat on the Community Rating tile
`.community-rating-info` and the mint card ★ badge `.card-rating-info` was **removed
2026-09-08** — the Reviews-tab disclaimer is now the only place it lives; the `.review-surge-flag`
⚠ on those two surfaces is unchanged.) Separately, a Community Rating average
backed by fewer than `MIN_MEANINGFUL_REVIEWS` (3, in `mintFormatting.ts`) is de-emphasised
(`opacity: 0.6` on the badge/value, "· too few to be reliable" on the tile sub-line) — this
is display-only; the Rating *sort* handles thin samples via the m=8 Bayesian weighting in
`backend/src/weightedRating.ts`. e2e: `e2e/community-rating-caveat.spec.ts`.

**Recent review surge flag (2026-09-08, sybil Community Rating mitigation step 2 — "option D"):**
`/api/mints/known` carries a `reviewSurge: boolean` per mint. It is **forgery-resistant** — it
is NOT derived from the Nostr events (an attacker controls `created_at`, author keys, etc.),
only from what MintRadar's own backend observed: the stored `review_count` now vs. a rolling
~1-week-ago snapshot (`review_count_7d_ago` / `_at`, advanced daily — see Cron jobs). Logic in
`backend/src/reviewSurge.ts` (`hasRecentReviewSurge`, unit-tested): flag when the count gained
≥ `SURGE_ABSOLUTE_GAIN` (10) OR at least doubled from a base of ≥ `SURGE_RATIO_MIN_BASELINE`
(5); false-safe on null / >14-day-stale snapshot. Tuned so ordinary organic growth (a few
reviews a week) never trips it, only a sharp jump (e.g. 3→28 between sync cycles). Approach
(b) from the analysis — one sliding snapshot column, not a history table — mirroring the
`trust_score_7d_ago` rollup; rationale in `reviewSurgeRollup.ts`. **Informational only —
never feeds Trust Score or `reviewWeightedRating`.** Frontend: `InfoTooltip` gained a
`tone="warn"` variant (quiet amber ⚠ instead of ⓘ); rendered next to the Community Rating on
the Mint Detail tile (`.review-surge-flag`) and mint card ★ badge (`.card-review-surge-flag`)
with the text "This mint's review count grew unusually fast recently — worth a closer look
before trusting the rating." 7-day warm-up after deploy (baselines seed to current count on
the first rollup, can't flag until they've aged). e2e in the same spec above.

## Mint Probe — Degraded/Offline Detection

**isSafeUrl** returns `'safe' | 'blocked' | 'dns-error'` — DNS failures are now written to `mint_history` as `online: false` instead of being silently skipped.

**Degraded logic** (in `backend/src/index.ts`):
```
degraded = (total24h >= 4 && onlineCount === 0) || isStaleOffline
isStaleOffline = last known state is offline AND older than 24h
```

Frontend hides degraded mints by default (`showDegraded=false`); footer shows "N mints hidden (offline 24h+) — Show".

**Known edge case:** After the first DNS-failure write, a mint may briefly show `degraded=false` for ~20 min until 4 probe records accumulate. Self-correcting, no intervention needed.

## Mobile Responsive Fixes (as of 2026-06-30)

- **Filter panel (Dashboard only as of 2026-09-04 — see "Watchlist changes" below):** NUT SUPPORT — 7 chips per row via `grid-template-columns: repeat(7, 1fr)`; STATUS + MIN TRUST SCORE side by side (50/50) using `filter-group-row-top` wrapper with `display: contents` on desktop (transparent to flex layout) and `display: flex; flex-direction: row` at ≤768px
- **Stats page:** Sections stack vertically on mobile; NUT Coverage bars don't overflow (`overflow: hidden`, shorter progress bar max-width)
- **Mint Detail:** Public key truncated on mobile (first+last 8 chars), full hex on desktop

### White focus ring on chart tap (2026-08-07) — the element is the `<g>`, not the `<svg>`

**GOTCHA — two earlier fixes targeted the wrong element and shipped without effect.**

Tapping any Recharts chart on mobile painted a white, rounded rectangle around the
chart's plot area. Root cause: Recharts 3.x renders its internal z-index layers as
`<g tabindex="-1">` inside the chart `<svg>` (`recharts/zIndex/ZIndexPortal.js` —
`.recharts-zIndex-layer_100` for Area, `_400` for Line, and so on; the tooltip wrapper
in `component/TooltipBoundingBox.js` is the same). `tabindex="-1"` is not
keyboard-reachable, but Chrome **does** focus such an element when it is tapped, and
then paints its default two-tone focus ring (`outline: auto` — white outer ring, dark
`rgb(16,16,16)` inner ring, rounded corners) around that `<g>`'s box.

Why the earlier attempts missed it:
- `.recharts-surface:focus { outline: none }` — `.recharts-surface` is the `<svg>`. The
  innermost focusable element under the finger is the `<g>` inside it, so the `<svg>`
  only ever gets focus when the tap lands on the chart's blank outer margin.
- `-webkit-tap-highlight-color` — that controls the Android tap *flash*, a different
  mechanism entirely from a focus ring.

Fix (`src/index.css`): `.recharts-wrapper [tabindex="-1"]:focus{,-visible}` → `outline: none`.
Matching on the attribute rather than the generated class name survives recharts
renaming its layers. Zero a11y cost — `tabindex="-1"` can never be reached by keyboard,
and the keyboard ring on the `<svg>` (`tabIndex={0}`) is deliberately kept.

**Diagnostic method that found it** (use it again for any "mystery visual state on tap"):
`page.touchscreen.tap()` on an emulated mobile device, then walk the full ancestor chain
from `document.elementFromPoint(x,y)` to `<html>` and diff `getComputedStyle()` before vs.
immediately after the tap — never assume which element is involved. Automated assertions
alone were what let the two bad fixes pass; a clipped screenshot before/after at
production contrast is what actually proved the ring's position and shape.

Regression test: `e2e/chart-tap-focus.spec.ts` (Pixel 7 emulation). It asserts that *no*
element in the chain under the tap point has a non-`none` `outline-style`, so it stays
correct even if recharts moves the focus to a different node. Verified the test actually
fails without the CSS rule (not just that it passes with it) before landing.

**Verified on Chromium/Android only** (Playwright + Pixel 7 emulation). iOS Safari/WebKit
has NOT been verified — WebKit handles focus on `tabindex="-1"` differently from Chrome,
so if the white ring reappears on iOS this needs its own targeted diagnostic pass, not an
assumption that the same fix covers it.

## Tooltip positioning in scrollable/small containers

**Pattern:** in a small or scrollable container (e.g. the Network Health Index Breakdown
modal), a tooltip that always pops in one fixed direction (e.g. always upward) gets
clipped for rows near the edge that don't have room in that direction.

**Fix applied in `NetworkHealthModal` (`Stats.tsx`):** direction is chosen dynamically by
position in the list — the last 2 rows pop downward, the rest pop upward (rather than
one fixed direction for every row).

Same fix pattern as the existing precedent in `MintDetail.tsx:616` — when a similar
tooltip-clipping issue shows up in a small container elsewhere in the app, check this
pattern first before inventing a new one.

**Established visual rule:** info icons attached to a badge (e.g. "Backup supported", the
error badge) must be a separate sibling element placed next to the badge — never nested
inside the same pill-shaped container as the badge. This convention is used consistently
across the app.

## Testing Infrastructure

### Test counts (as of 2026-09-08): ~966 total

| Suite | Count | Tool | Location |
|-------|-------|------|----------|
| Backend unit | ~306 | Vitest | `backend/src/__tests__/` (excl. subdirs) |
| Frontend unit | 313 | Vitest | `MintRadar/src/__tests__/` |
| API integration | 115 | Vitest | `backend/src/__tests__/integration/` |
| Security | 40 | Vitest | `backend/src/__tests__/security/` |
| E2E | 192 | Playwright | `MintRadar/e2e/` (39 spec files) |

`cd backend && npm test` runs all backend suites together and reports **461**
(306 unit + 115 integration + 40 security). Counts drift often — treat as approximate.

### Key tested modules

- **Backend:** `normalizeUrl`, Trust Score calculation (prober.ts), degraded/offline detection logic, review parsing (kind:38000 regex), SSRF guard (`backend/src/ssrf.ts`) — DNS rebinding, private ranges, link-local
- **Frontend:** `mintFormatting` and `reviewUtils` (extracted from components into `src/utils/` for testability), Trust Score display helpers. `mintFormatting.test.ts`'s `mintAgeBadge` Fresh/Established color assertions were updated 2026-07-24 to the new redesign hex values (`#d3a446`/`#5cc9a3`) — see "Visual Redesign" section.

### Run commands

```bash
# Backend (unit + integration + security)
cd backend && npm test

# Frontend unit
cd MintRadar && npm test

# E2E
cd MintRadar && npm run test:e2e
```

### E2E mocking strategy

- **HTTP:** `page.route('**/api/**', …)` with deterministic fixtures in `e2e/fixtures/mocks.ts`
- **Nostr relays (wss):** `page.routeWebSocket(/^wss:\/\//)` stub — replies `["EOSE", subId]` to every `REQ`, `["OK", id, true, ""]` to every `EVENT`. Required because `SimplePool.querySync()` hangs until EOSE; simply closing the socket is not sufficient.
- **NIP-07 login:** `page.addInitScript()` injects `window.nostr` mock (getPublicKey/signEvent/nip04/nip44) and pre-seeds Zustand persist key `mintradar_session` in `sessionStorage`

### Notable finding (not a bug)

The `+ Watch` button on Dashboard mint cards only renders when `isLoggedIn === true` (intentional — watchlist is identity-bound). E2E tests for the add-to-watchlist flow therefore require a mocked NIP-07 session.

### CI

`test` job in `.github/workflows/deploy.yml` runs the full suite (backend + frontend unit; e2e is separate). `deploy` job declares `needs: test` — a failing test blocks deployment.

## NUT tracking expansion (2026-07-02)

- Tracking 26 NUTs now (was 14) — added: 13, 16, 18, 21, 22, 23, 24, 25, 26, 27, 28, 30
- Mandatory NUTs (00-03, 06) are deliberately never tracked — implicitly 100% supported, zero information value
- Trust Score NUT divisor changed from /14 to /26 in `prober.ts` — existing mints get a lower/more accurate score at their next probe cycle
  - **Correction (2026-08-19):** the divisor that actually shipped is **/25**, not /26, and NUT-13 is not tracked — it is a wallet-side spec a mint never advertises, so the list above ("added: 13, 16, …") overcounts by one. The live list is `TRACKED_NUTS` in `src/constants/nuts.ts` (25 entries); the divisor is `TRACKED_NUT_COUNT` in `backend/src/shared/trustScore.ts`.
- NUT-24 (HTTP 402) has 0% adoption across the ecosystem — expected, no implementation exists yet anywhere

## Probe fixes — HTTP status handling

- HTTP 429 → probe cycle is skipped entirely (nothing written to `mint_history`); mint stays at its last known state instead of a false-positive offline
- HTTP 502/503/504 → one retry after 2s before recording offline (handles transient server-side blips like restarts/deploys)
- "Show my latency" (client-side test in MintDetail) fixed — previously used `mode: 'no-cors'` which hid the HTTP error status, so `fetch` resolved "successfully" even on a 502 and showed a fake latency. Now uses standard cors mode, reads `res.ok`/`res.status`, and shows `Unreachable (HTTP XXX)` instead of a bogus number
- Tooltip on the HTTP error badge (Mint Detail header) — maps 429/502/503/504 to an explanatory message for less technical users

## Mint Age Badge — known data limitation

- **`mintAgeBadge()` no longer drives the mint card or any Dashboard filter (2026-09-08).** The
  card's age signal is now the binary **"New"** badge (`isNewMint()`, < 30d); Established /
  Veteran / OG were dropped and the "Mint age" filter block was removed (see "Card badges" and
  "Dashboard filter panel — Mint age removed" above). `mintAgeBadge()` (shared helper + local
  copies in `ComparisonModal.tsx` and `Stats.tsx`) is **still used** by the Compare modal, the
  Stats geo/NUT modals + software-freshness count, and the Dashboard **list-view "Age" column**.
- `mintAgeBadge()` thresholds are in **months**: `< 1` Fresh, `< 6` Established, `< 12` Veteran,
  `≥ 12` OG.
- Input is `mints.discovered_at` — when MintRadar discovered/inserted the mint, NOT the mint's
  true birth. Bulk-seeded mints all share a mid-2026 `discovered_at`, so the badge only starts
  differentiating as the data naturally ages — not a bug.

## Grok external review (2026-07-02)

- An external AI analysis of the project identified that not all official NUTs were tracked — led to the NUT tracking expansion above.
- Other recommendations were either already implemented, or knowingly rejected (see decisions below).
- Rejected: reserve audit verification (no standardized NUT for it), dark/light mode toggle, watchlist share link (conflicts with privacy-first design), historical NUT snapshots, comparison tool for more than 4 mints, search by operator pubkey (no data linkage exists), multi-region probe infrastructure.
- NUT security warning badge (NUT-09/11/12) — verified against live data: currently 0 of 55 online mints are missing these NUTs, so the badge would be dead code. Rejected.
- Multi-unit criterion in Best Mint Wizard — **IMPLEMENTED (2026-08-19)**. The original 2026-07-02 note here said units were "never persisted... requires parsing `/v1/keysets`" — that has been obsolete since the `units`/`mint_methods`/`melt_methods` columns landed. Units are parsed by `parseMintMethods()` in `prober.ts` from the NUT-04/NUT-05 `methods` arrays of `/v1/info` (no `/v1/keysets` call is involved), persisted on every probe cycle, and served by `/api/mints/known` on the `KnownMint` type. The wizard now has a unit dropdown built from the distinct units of online mints, filters candidates to mints advertising that unit, and shows the per-unit NUT-04/05 min/max limits on each recommendation. Trust Score / latency / nutCount remain whole-mint metrics — the results panel says so explicitly.

## ESLint zero-errors cleanup (2026-07-05)

The codebase is at **0 ESLint errors** (frontend + backend). Keep it that way — `eslint-plugin-react-hooks` v7 enforces compiler-grade rules (`purity`, `set-state-in-effect`, `refs`). Patterns established during the cleanup; reuse them instead of re-introducing effects:

- **`useNow()`** (`src/hooks/useNow.ts`) — ticking clock store via `useSyncExternalStore` (30 s interval, shared across subscribers). Use it for ANY "current time" read during render ("checked Xm ago", age thresholds, chart bucket alignment). Never call `Date.now()` in render/useMemo — the purity rule blocks it. Used by: ComparisonModal, MintDetail (chart slots), Tools (Token Inspector).
- **Keyed/derived state instead of setState-in-effect** — async results are stored keyed by the input they were produced for; `loading` is derived (`key !== currentInput`), never set synchronously in an effect. Applied in:
  - `useMintReviews` — reviews keyed by mint URL (also fixed a stale-data race when switching mints)
  - Dashboard submit form — `probe` keyed by `submitUrl`, `nostrLookup` keyed by trimmed input
  - Watchlist pagination — `extraVisible` keyed by `listKey` (sort + filtered list content); side effect: pagination no longer resets on every 60 s data refetch
- **AppShell login modal** — single `closeLoginModal()` callback resets all modal state and is wired into every close path (overlay, X, Cancel, Escape, successful login incl. QR flow). Do NOT re-add "close on profile change" / "reset on close" effects. In the QR success path `qrCancelRef` is nulled BEFORE close so the live BunkerSigner is not aborted.
- **`useWatchlistSync`** — `userWriteRelaysRef` is written in an effect (declared before Phase 1/2 effects, so it's current within the same commit); Phase 1 reads relays from the ref.
- **`pool.ts`** — `PatchableRelay` is a standalone type, NOT an intersection with `AbstractRelay` (its private `reconnectAttempts` collapses intersections to `never`). GOTCHA: `npm run typecheck` (`tsc --noEmit`) missed this; only `tsc -b` (used by `npm run build`) caught it — build is the authoritative type gate.

## Code splitting & bundle layout (2026-07-05)

- `/stats` and `/mint/:url` routes are `React.lazy` + `Suspense` in `App.tsx` — the only Recharts consumers. Initial load dropped ~1124 → ~671 kB raw (~130 kB gzip saved); `vendor-charts` (350 kB) loads on first chart-page visit.
- **GOTCHA — `manualChunks` is dead in Vite 8 (rolldown):** the compat layer silently ignores group changes (builds byte-identical output). Chunking lives in `rollupOptions.output.advancedChunks.groups` — first matching group wins, order matters.
- **`vendor-immer` group must stay:** immer is shared by the watchlist store (eager, via zustand middleware) and recharts (lazy, via @reduxjs/toolkit — a second nested copy exists). Without its own group it lands inside `vendor-charts` and drags the whole chart bundle back into the initial modulepreload set. If a new eager module ever shares a dep with recharts, give that dep its own group too — verify with: `grep vendor-charts dist/index.html` (must NOT appear in modulepreload).
- **GOTCHA — `vite.config.js` is a compiled artifact:** `tsc -b` emits it from `vite.config.ts` (tsconfig.node.json has no `noEmit`), and Vite resolves `.js` BEFORE `.ts`. Always edit `vite.config.ts`, then run `npm run build` to regenerate the `.js` — editing only the `.ts` without a build means Vite still uses the stale `.js`.

## Key rules
- **Before starting ANY new task, check `git branch --show-current`.** If it isn't `main`, find out why (an in-progress PR still awaiting merge vs. a forgotten checkout left over from a prior session) before committing anything. A 2026-08-05 session left a feature branch checked out after its PR had already merged; two unrelated follow-up fixes got committed there instead of on `main` and had to be recovered via a second PR (#54).
- NEVER modify anything not explicitly requested
- ALWAYS run typecheck before build
- ALWAYS rsync dist after build
- ALWAYS commit and push after deploy: `git push origin main && git push gitea main` (both remotes required)
- Conventional commits: feat:, fix:, refactor:, docs:, chore:
- Security: always audit new code for SSRF, rate limits, XSS
- Security: `verifyEvent()` from nostr-tools must be called on all inbound Nostr events (frontend hooks and backend discovery)
