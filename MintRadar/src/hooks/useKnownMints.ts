import { useQuery } from '@tanstack/react-query'

export interface KnownMint {
  url: string
  name: string | null
  iconUrl: string | null
  degraded: boolean
  online: boolean | null
  latencyMs: number | null
  version: string | null
  nutCount: number | null
  tosUrl: string | null
  descriptionLong: string | null
  nutsLimits: Record<string, unknown> | null
  units?: string[] | null
  mintMethods?: { method: string; unit: string; [key: string]: unknown }[] | null
  meltMethods?: { method: string; unit: string; [key: string]: unknown }[] | null
  auditNMints?: number | null
  auditNMelts?: number | null
  auditNErrors?: number | null
  // audit.8333.space's own `updated_at` for this mint's audit record.
  auditCheckedAt?: string | null
  // When OUR 6h discovery cron last refreshed the audit_* columns — the honest
  // "Last checked X ago" value for the Audit tab (auditCheckedAt is the auditor's
  // clock, not ours). Null until that cron has run since the column was added.
  auditSyncedAt?: string | null
  auditRecentTotal?: number | null
  auditRecentErrors?: number | null
  discoveredAt?: string | null
  trustScore?: number | null
  lastError?: string | null
  uptimePct24h?: number | null
  serverLocation?: string | null
  lastCheckedAt?: string | null
  // NIP-87 review rollup, refreshed by the backend's 6h reviews sync
  // (backend/src/reviewsSync.ts). Null until that sync has run for the mint.
  reviewCount?: number | null
  reviewAvgRating?: number | null
  // Forgery-resistant sybil signal: the backend saw this mint's review_count
  // jump sharply vs. its own ~1-week-ago snapshot (backend/src/reviewSurge.ts).
  // Informational only — never affects Trust Score or the Rating sort; the UI
  // shows a quiet ⚠ next to the Community Rating.
  reviewSurge?: boolean
  // IMDB-style weighted/Bayesian rating computed by the backend
  // (backend/src/weightedRating.ts). Used ONLY for the Rating sort so a mint
  // with one 5.0 review doesn't outrank a mint with many reviews at 4.7 — never
  // shown in the UI (the Community Rating badge uses reviewAvgRating/reviewCount).
  reviewWeightedRating?: number | null
}

async function fetchKnownMints(): Promise<KnownMint[]> {
  const res = await fetch('/api/mints/known')
  if (!res.ok) throw new Error('Failed to fetch known mints')
  const data = await res.json() as KnownMint[]
  return data
}

export function useKnownMints() {
  return useQuery({
    queryKey: ['mints-known'],
    queryFn: fetchKnownMints,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: 2,
  })
}
