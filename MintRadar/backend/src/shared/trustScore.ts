// Trust Score computation — the single definition of how a mint's 0-100 score
// is built out of its five weighted components.
//
// This is the shared source of truth for both the server-side computation
// (prober.ts, run on every probe cycle and stored in mints.last_trust_score) and
// the frontend's client-side fallback + Trust Score Breakdown display
// (MintDetail.tsx). The stored server-side value is authoritative: the frontend
// only computes a score itself when `knownMint.trustScore` is missing (a mint
// not yet probed, or a historical chart bucket with no stored score).
//
// The frontend cannot import this file directly (separate npm package, no
// workspace set up between backend/ and the frontend), so src/utils/trustScore.ts
// is a manually-synced copy — if you change the logic here, mirror it there too.
// The same arrangement exists for shared/auditScore.ts.
import { auditReliabilityScore } from './auditScore.js'

/**
 * Number of NUTs the app tracks, i.e. the denominator of the NUT-support
 * component. Must stay equal to the length of the frontend's TRACKED_NUTS
 * list (src/constants/nuts.ts) — a test asserts this.
 */
export const TRACKED_NUT_COUNT = 25

// [major, minor] descending — newest first.
export const NUTSHELL_VERSIONS: [number, number][] = [
  [0, 20], [0, 19], [0, 18], [0, 17], [0, 16], [0, 15], [0, 14], [0, 13], [0, 12], [0, 11],
]

// Same shape as NUTSHELL_VERSIONS, for cdk-mintd. Used as the last-resort fallback
// when the software_versions DB cache has no row yet (see versionFreshnessScore below
// and versionCatalog.ts's fetchLatestUpstreamVersions).
export const CDK_VERSIONS: [number, number][] = [
  [0, 17], [0, 16], [0, 15], [0, 14], [0, 13], [0, 12], [0, 11], [0, 10], [0, 9], [0, 8],
]

// ── Version string parsing ──────────────────────────────────────────────────
// Mint /v1/info reports its version as "SoftwareName/X.Y.Z" (e.g. "Nutshell/0.20.3",
// "cdk-mintd/0.17.0-rc.3") per NUT-06. This split is also done independently on the
// frontend for display only (Stats.tsx's Software-in-Use breakdown) — that copy is
// display-only grouping and intentionally untouched; this is the version used for
// scoring.

/** Splits a raw mint version string into its software name and version number. */
export function splitVersionString(v: string): { software: string; versionNumber: string } {
  const slashIdx = v.indexOf('/')
  return slashIdx >= 0
    ? { software: v.slice(0, slashIdx), versionNumber: v.slice(slashIdx + 1) }
    : { software: v, versionNumber: '' }
}

/**
 * Normalizes a version number for comparison: strips a leading "v" (GitHub tag
 * convention, e.g. cdk's "v0.17.5") and any "-rc.N"/prerelease suffix
 * (e.g. "0.17.0-rc.3" → "0.17.0").
 */
export function normalizeVersionNumber(v: string): string {
  return v.replace(/^v/i, '').replace(/-.*$/, '')
}

/**
 * Parses a normalized version number into major/minor/patch. Patch is extracted
 * but not currently used by the scoring granularity below — kept so normalization
 * is ready for it if the scoring is ever made more precise.
 */
export function parseMajorMinorPatch(
  versionNumber: string
): { major: number; minor: number; patch: number } | null {
  const norm = normalizeVersionNumber(versionNumber)
  const m = norm.match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m || !m[1] || !m[2]) return null
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: m[3] ? parseInt(m[3], 10) : 0 }
}

// ── Software recognition ────────────────────────────────────────────────────
// Reported software names are matched case-insensitively but NOT by prefix —
// "Nutshell-CF" must not match "nutshell". Anything not listed here (including
// future/unknown software) has no version leaderboard and scores neutrally.
const SOFTWARE_ALIASES: Record<string, string> = {
  nutshell: 'nutshell',
  cdk: 'cdk',
  'cdk-mintd': 'cdk',
}

export function canonicalSoftwareName(software: string): string | null {
  return SOFTWARE_ALIASES[software.trim().toLowerCase()] ?? null
}

// Static fallback "latest known version" per canonical software — the last-resort
// safety net used when the software_versions DB cache (populated daily by
// versionCatalog.ts's fetchLatestUpstreamVersions cron job) has no row yet, e.g. a
// fresh deploy before the first cron run. Mirrors the top entry of NUTSHELL_VERSIONS
// / CDK_VERSIONS above.
export const STATIC_LATEST_VERSIONS: Record<string, { major: number; minor: number }> = {
  nutshell: { major: NUTSHELL_VERSIONS[0]![0], minor: NUTSHELL_VERSIONS[0]![1] },
  cdk: { major: CDK_VERSIONS[0]![0], minor: CDK_VERSIONS[0]![1] },
}

const STATIC_LADDERS: Record<string, [number, number][]> = {
  nutshell: NUTSHELL_VERSIONS,
  cdk: CDK_VERSIONS,
}

// Builds a ranked ladder (newest first, 10 steps) counting down by minor version
// from a single "latest known version" — the same shape as NUTSHELL_VERSIONS/
// CDK_VERSIONS, used when the latest version comes from the DB cache instead of
// a hardcoded list.
function versionLadder(latest: { major: number; minor: number }, steps = 10): [number, number][] {
  const ladder: [number, number][] = []
  for (let i = 0; i < steps; i++) {
    const minor = latest.minor - i
    if (minor < 0) break
    ladder.push([latest.major, minor])
  }
  return ladder
}

/**
 * Version recency on a 0-10 scale (scaled to the 15-point component below).
 *
 * `latestVersions` (canonical software name → latest {major, minor}) comes from the
 * software_versions DB cache — only the backend can supply it (prober.ts). When
 * omitted (always the case on the frontend, and on the backend before the cache has
 * a row for this software) each recognized software falls back to its static ladder
 * (NUTSHELL_VERSIONS / CDK_VERSIONS).
 *
 * Software the app doesn't recognize (no leaderboard at all — a different mint
 * implementation, a future one, or malformed data) scores a neutral 2.5, the same
 * neutral default auditReliabilityScore() uses for "Unknown" — NOT 0 (which would
 * wrongly treat it as maximally stale) and NOT 10 (which would wrongly treat any
 * higher major/minor number as automatically freshest).
 */
export function versionFreshnessScore(
  v: string | null | undefined,
  latestVersions?: Record<string, { major: number; minor: number }>
): number {
  if (!v) return 0
  const { software, versionNumber } = splitVersionString(v)
  const canonical = canonicalSoftwareName(software)
  if (!canonical) return 2.5
  const parsed = parseMajorMinorPatch(versionNumber)
  if (!parsed) return 3
  const latest = latestVersions?.[canonical] ?? STATIC_LATEST_VERSIONS[canonical]
  if (!latest) return 2.5
  const ladder = latestVersions?.[canonical] ? versionLadder(latest) : STATIC_LADDERS[canonical]!
  const idx = ladder.findIndex(
    ([mj, mn]) => parsed.major > mj || (parsed.major === mj && parsed.minor >= mn)
  )
  if (idx === -1) return 0
  return Math.max(0, 10 - idx * 2)
}

// ── Individual components ────────────────────────────────────────────────────
// Exported separately so the Trust Score Breakdown UI shows exactly the numbers
// that went into the total, rather than re-deriving them.

/** Uptime over the last 24h — 45 points. */
export function uptimeComponent(uptimePct: number): number {
  return Math.round(uptimePct * 0.45)
}

/** NUT support — 30 points, capped at TRACKED_NUT_COUNT NUTs. */
export function nutComponent(nutCount: number | null | undefined): number {
  return Math.round(Math.min((nutCount ?? 0) / TRACKED_NUT_COUNT, 1) * 30)
}

/** Software version freshness — 15 points. */
export function versionComponent(
  version: string | null | undefined,
  latestVersions?: Record<string, { major: number; minor: number }>
): number {
  return Math.round(versionFreshnessScore(version, latestVersions) / 10 * 15)
}

/**
 * Published contact methods (email / twitter / nostr) — 5 points, capped.
 *
 * `contactCount` is clamped to 3 (the number of recognised channels) BEFORE the
 * ratio, so 3-or-more contacts award the full 5 points and never more. This cap
 * is an explicit anti-abuse control, not cosmetic: `contactCount` is derived
 * from the mint's own `/v1/info` `contact` array (backend/src/prober.ts), which
 * is untrusted mint-operator input (see the audit "Trust model" — the mint
 * operator is Untrusted). Without the clamp a mint advertising e.g. 60 contact
 * entries scored 100 on this component alone, saturating its entire Trust Score
 * regardless of uptime / NUT support / version — the self-attestation inflation
 * reported as finding H1 in the 2026-09-07 security audit. The clamp is applied
 * here, the single call site every caller shares (backend probe, backend
 * breakdown, frontend fallback, frontend breakdown), and it clamps the combined
 * count across all channel types — it cannot be bypassed per-type.
 */
export function contactComponent(contactCount: number): number {
  return Math.round((Math.min(contactCount, 3) / 3) * 5)
}

/**
 * Total Trust Score, 0-100.
 *
 * Rounding: the components above round individually, and the total gets exactly
 * one outer Math.round before the 100 cap — `Math.min(100, Math.round(sum))`.
 * Keep this ordering; the frontend copy must produce bit-identical results for
 * the same inputs, otherwise a mint's displayed breakdown won't add up to the
 * stored score.
 */
export function computeTrustScore(
  uptimePct: number,
  nutCount: number | null,
  version: string | null,
  contactCount: number,
  auditRecentTotal: number | null,
  auditRecentErrors: number | null,
  latestVersions?: Record<string, { major: number; minor: number }>
): number {
  const uScore = uptimeComponent(uptimePct)
  const nScore = nutComponent(nutCount)
  const vScore = versionComponent(version, latestVersions)
  const cScore = contactComponent(contactCount)
  const aScore = auditReliabilityScore(auditRecentTotal, auditRecentErrors)
  return Math.min(100, Math.round(uScore + nScore + vScore + cScore + aScore))
}
