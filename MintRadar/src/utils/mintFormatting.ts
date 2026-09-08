// Pure formatting helpers used across Dashboard and MintDetail.
// All functions are side-effect free and accept an optional `now` timestamp
// for deterministic testing.

// Below this many NIP-87 reviews a Community Rating average is too thin to lean
// on — the displayed number is de-emphasised (the Rating *sort* already handles
// this separately via the m=8 Bayesian weighting in backend/src/weightedRating.ts).
// 3 mirrors the audit-reliability "too few samples to score" floor.
export const MIN_MEANINGFUL_REVIEWS = 3

// ── Mint age badge ─────────────────────────────────────────────
// Thresholds: < 1 month → Fresh, < 6 months → Established,
//             < 12 months → Veteran, ≥ 12 months → OG
export interface AgeBadge {
  label: 'Fresh' | 'Established' | 'Veteran' | 'OG'
  color: string
  bg: string
  border: string
}

export function mintAgeBadge(
  discoveredAt: string | null | undefined,
  now: number = Date.now()
): AgeBadge | null {
  if (!discoveredAt) return null
  const months = (now - new Date(discoveredAt).getTime()) / (1000 * 60 * 60 * 24 * 30.44)
  if (months < 1)  return { label: 'Fresh',       color: '#d3a446', bg: 'rgba(211,164,70,.14)',  border: 'rgba(211,164,70,.3)'  }
  if (months < 6)  return { label: 'Established', color: '#5cc9a3', bg: 'rgba(69,173,140,.14)',  border: 'rgba(69,173,140,.28)'  }
  if (months < 12) return { label: 'Veteran',     color: '#ffa500', bg: 'rgba(255,165,0,0.1)',   border: 'rgba(255,165,0,0.25)'   }
  return              { label: 'OG',          color: '#a78bfa', bg: 'rgba(167,139,250,0.1)', border: 'rgba(167,139,250,0.25)' }
}

// ── Mint URL normalization ──────────────────────────────────────
// Mirrors the backend's normalizeUrl() (backend/src/discovery.ts) so a mint
// URL parsed off of a Cashu token (arbitrary case/trailing-slash) matches the
// same key the backend used when it inserted the mint into /api/mints/known.
// The two copies can't share code (separate npm packages, no workspace), so
// keep them in sync if the normalization logic ever changes.
export function normalizeMintUrl(raw: string): string {
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

// ── Trust score (MintDetail gauge/badge) ───────────────────────
// trustScoreColor: raw colour for the score number
export function trustScoreColor(score: number): string {
  if (score >= 75) return '#4ade80'
  if (score >= 50) return '#ffa500'
  return '#ff4d4d'
}

export interface TrustScoreInfo {
  label: 'High Trust' | 'Moderate Trust' | 'Low Trust'
  color: string
  bg: string
  border: string
}

// trustScoreInfo: full badge object for the MintDetail panel
export function trustScoreInfo(score: number): TrustScoreInfo {
  if (score >= 70) return { label: 'High Trust',     color: '#4ade80', bg: 'rgba(74,222,128,0.1)',  border: 'rgba(74,222,128,0.25)'  }
  if (score >= 40) return { label: 'Moderate Trust', color: '#ffa500', bg: 'rgba(255,165,0,0.1)',   border: 'rgba(255,165,0,0.25)'   }
  return                  { label: 'Low Trust',      color: '#ff4d4d', bg: 'rgba(255,77,77,0.1)',   border: 'rgba(255,77,77,0.25)'   }
}

// trustColor: used in Dashboard list view (same thresholds as trustScoreInfo)
export function trustColor(score: number): string {
  if (score >= 70) return '#4ade80'
  if (score >= 40) return '#ffa500'
  return '#ff4d4d'
}

// ── Mint risk level (Token Inspector) ───────────────────────────
// Risk for a SINGLE mint a token is bound to — not a multi-mint aggregation.
// Reuses the exact same 70/40 trust-score thresholds as trustScoreInfo() above
// so "Low Trust" and "risk: medium" never disagree about the same score.
export interface MintRiskInfo {
  label: 'High risk' | 'Medium risk' | 'Low risk' | 'Unknown'
  color: string
  bg: string
  border: string
}

const RISK_HIGH: MintRiskInfo = { label: 'High risk',   color: '#ff4d4d', bg: 'rgba(255,77,77,0.1)',  border: 'rgba(255,77,77,0.25)' }
const RISK_MEDIUM: MintRiskInfo = { label: 'Medium risk', color: '#ffa500', bg: 'rgba(255,165,0,0.1)',  border: 'rgba(255,165,0,0.25)' }
const RISK_LOW: MintRiskInfo = { label: 'Low risk',    color: '#4ade80', bg: 'rgba(74,222,128,0.1)', border: 'rgba(74,222,128,0.25)' }
const RISK_UNKNOWN: MintRiskInfo = { label: 'Unknown',    color: 'var(--t3)', bg: 'var(--bg3)',          border: 'var(--border)' }

/**
 * `mint` is null when the token's mint URL doesn't match any row in
 * /api/mints/known — deliberately its own "Unknown" state rather than a
 * silent fallback into one of the three known-mint tiers, since "not tracked"
 * and "tracked but risky" are different findings.
 */
export function mintRiskLevel(mint: { online: boolean | null; degraded: boolean; trustScore: number | null | undefined } | null): MintRiskInfo {
  if (!mint) return RISK_UNKNOWN
  if (mint.online === false || mint.degraded === true) return RISK_HIGH
  if ((mint.trustScore ?? 0) < 40) return RISK_MEDIUM
  return RISK_LOW
}

// ── Trust Score donut geometry ────────────────────────────────
// The Mint Detail / Stats gauges draw the arc as a stroke-dasharray on an
// r=27 SVG <circle>, so the drawable circumference is 2·π·27 ≈ 169.646.
// The SVG is rotated with transform="rotate(-90 36 36)" so the circle's
// native 3-o'clock start point moves to 12 o'clock, and the native path
// direction is clockwise — so a plain two-value dasharray "filled gap"
// with NO dash offset already gives a single contiguous arc that starts at
// 12 o'clock and fills exactly `pct`% of the ring clockwise.
//
// (The old code also set strokeDashoffset to a quarter-circle, which split
// the arc in two around the 9-o'clock mark and made e.g. 80% look like ~55%.)
export const TRUST_DONUT_RADIUS = 27
export const TRUST_DONUT_CIRCUMFERENCE = 2 * Math.PI * TRUST_DONUT_RADIUS

export interface DonutArc {
  /** value for strokeDasharray: "<filled> <gap>" */
  dashArray: string
  /** value for strokeDashoffset — always 0, arc starts at 12 o'clock via rotate(-90) */
  dashOffset: number
  /** filled arc length in user units (exposed for tests / debugging) */
  filled: number
}

export function trustDonutArc(pct: number): DonutArc {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))
  const filled = (clamped / 100) * TRUST_DONUT_CIRCUMFERENCE
  const gap = TRUST_DONUT_CIRCUMFERENCE - filled
  return {
    dashArray: `${filled.toFixed(2)} ${gap.toFixed(2)}`,
    dashOffset: 0,
    filled,
  }
}

// ── Latency colour (Dashboard card + list) ─────────────────────
// null / 0 / negative → muted; < 500 ms → fast; < 2000 ms → medium; ≥ 2000 ms → slow
export function latencyColor(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return 'var(--t3)'
  if (ms < 500)  return 'var(--fast)'
  if (ms < 2000) return 'var(--med)'
  return 'var(--slow)'
}

// ── Uptime colour (Dashboard/Watchlist card pill) ──────────────
export function uptimeColor(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return 'var(--t3)'
  if (pct >= 95) return 'var(--fast)'
  if (pct >= 80) return 'var(--med)'
  return 'var(--slow)'
}

// ── Audit reliability colour (Audit summary strip + Trust Score Breakdown
// "Audit reliability" row) ──────────────────────────────────────
// UI-only presentation of the rolling-window error rate — deliberately NOT the
// same thresholds as auditReliabilityScore()'s 1-5 scoring buckets in
// auditScore.ts (that function feeds the actual Trust Score number and must
// not change). Those buckets are stricter than what reads as "OK" at a
// glance — e.g. a 5% error rate (95% success) already drops two tiers below
// the top and painted red. This colours directly off the error rate instead,
// so a mint succeeding ~95%+ of the time reads as green regardless of which
// scoring bucket it happens to fall into.
export function auditReliabilityColor(
  recentTotal: number | null | undefined,
  recentErrors: number | null | undefined,
): string {
  if (recentTotal === null || recentTotal === undefined || recentTotal < 3) return 'var(--t3)'
  const errorRate = (recentErrors ?? 0) / recentTotal
  if (errorRate <= 0.05) return 'var(--fast)'
  if (errorRate <= 0.25) return 'var(--med)'
  return 'var(--slow)'
}

// ── Relative time (e.g. "3 min ago", "2d ago") ─────────────────
// "<errors> / <total>" for the Audit summary strip's Recent errors cell.
// `total === null` (mint audited but no rolling-window swap sample yet) renders
// as an em dash; a null error count is treated as zero. Sample-size adequacy
// ("too few to score") is a separate concern — see isAuditUnknown().
export function formatAuditErrorRatio(
  recentTotal: number | null | undefined,
  recentErrors: number | null | undefined,
): string {
  if (recentTotal === null || recentTotal === undefined) return '—'
  return `${recentErrors ?? 0} / ${recentTotal}`
}

export function formatTimeAgo(date: Date | null, now: number = Date.now()): string {
  if (!date) return '—'
  const seconds = Math.floor((now - date.getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
