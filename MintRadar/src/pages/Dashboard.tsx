import { useState, useMemo, useEffect, useRef, lazy, Suspense } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import { nip19 } from 'nostr-tools'
import type { NostrEvent } from 'nostr-tools'
import { sharedPool } from '@/core/nostr/pool'
import { useNostrDiscovery } from '@/hooks/useNostrDiscovery'
import { useWatchlistNotifications } from '@/hooks/useWatchlistNotifications'
import { useUserRelays } from '@/hooks/useUserRelays'
import { MintFavicon } from '@/components/mint/MintFavicon'
import { useKnownMints, type KnownMint } from '@/hooks/useKnownMints'

import type { MintStatus } from '@core/mint/api'
import { MintCard } from '@/components/mint/MintCard'
import { MintComparePicker } from '@/components/MintComparePicker'
import { useMintHoverPrefetch } from '@/hooks/useMintHoverPrefetch'
import { mintAgeBadge, latencyColor, trustColor, uptimeColor, displayName as mintDisplayName } from '@/utils/mintFormatting'
import './Dashboard.css'

// Historical trend charts pull in Recharts (~380 kB chunk) — lazy-load so
// that chunk only loads when a user actually opens Compare, not on every
// Dashboard visit. Matches the Stats/MintDetail lazy-loading pattern in App.tsx.
const ComparisonModal = lazy(() => import('@/components/ComparisonModal').then(m => ({ default: m.ComparisonModal })))

// ── SVG Icons ──────────────────────────────────────────────────

const IcSignal = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="6.8" stroke="currentColor" strokeWidth="1.1"/>
    <circle cx="8" cy="8" r="4" stroke="currentColor" strokeWidth="1" strokeDasharray="2 1.5" opacity="0.6"/>
    <circle cx="8" cy="8" r="1.2" fill="currentColor"/>
  </svg>
)

const IcGrid = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="2" y="2" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.1"/>
    <rect x="8.5" y="2" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.1"/>
    <rect x="2" y="8.5" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.1"/>
    <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.1"/>
  </svg>
)
const IcSuccess = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="6.8" stroke="currentColor" strokeWidth="1.1"/>
    <polyline points="5,8 7,10 11,6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
const IcSearch = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
    <circle cx="5.8" cy="5.8" r="4.3" stroke="currentColor" strokeWidth="1.3"/>
    <line x1="9.2" y1="9.2" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
  </svg>
)
const IcPlus = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
    <line x1="6" y1="1.5" x2="6" y2="10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    <line x1="1.5" y1="6" x2="10.5" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
)
const IcRefresh = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
    <path d="M2 7a5 5 0 1 1 1.4 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    <polyline points="2,4.5 2,7 4.5,7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
const IcTimer = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="9.5" r="5" stroke="currentColor" strokeWidth="1.1"/>
    <path d="M8 7v2.5l1.5 1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M6 1.5h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
  </svg>
)
const IcFilter = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
    <line x1="1.5" y1="3" x2="11.5" y2="3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    <line x1="3" y1="6.5" x2="10" y2="6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    <line x1="4.5" y1="10" x2="8.5" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
  </svg>
)
const IcClose = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
  </svg>
)
const IcList = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <line x1="5" y1="4" x2="14" y2="4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
    <line x1="5" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
    <line x1="5" y1="12" x2="14" y2="12" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
    <circle cx="2.5" cy="4" r="1" fill="currentColor"/>
    <circle cx="2.5" cy="8" r="1" fill="currentColor"/>
    <circle cx="2.5" cy="12" r="1" fill="currentColor"/>
  </svg>
)

// ── Helpers ────────────────────────────────────────────────────

function listTrustScore(mint: KnownMint): number {
  if (mint.online !== true) return 0
  return mint.trustScore ?? 0
}

function getHostname(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

function formatTimeAgo(date: Date | null): string {
  if (!date) return '—'
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}


const NOSTR_LOOKUP_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://nostr-pub.wellorder.net',
]
const DEFAULT_SORT_DIRS: Record<'name' | 'latency' | 'rating' | 'trust' | 'reviewCount', 'asc' | 'desc'> = { rating: 'desc', latency: 'asc', trust: 'desc', name: 'asc', reviewCount: 'desc' }

const NUT_FILTER_KEYS = ['4','5','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29','30']

interface FilterState {
  status: 'all' | 'online' | 'offline'
  minTrustScore: number
  requiredNuts: string[]
}
const DEFAULT_FILTERS: FilterState = { status: 'all', minTrustScore: 0, requiredNuts: [] }

function applyFilters(mints: KnownMint[], filters: FilterState): KnownMint[] {
  return mints.filter(mint => {
    if (filters.status === 'online' && mint.online !== true) return false
    if (filters.status === 'offline' && mint.online !== false) return false
    if (listTrustScore(mint) < filters.minTrustScore) return false
    if (filters.requiredNuts.length > 0) {
      const nuts = mint.nutsLimits as Record<string, unknown> | null
      if (!nuts) return false
      if (!filters.requiredNuts.every(nut => nuts[nut] != null)) return false
    }
    return true
  })
}

function countActiveFilters(f: FilterState): number {
  return [f.status !== 'all' ? 1 : 0, f.minTrustScore > 0 ? 1 : 0, f.requiredNuts.length > 0 ? 1 : 0].reduce((a, b) => a + b, 0)
}

// ── URL persistence (search/sort/filters) ────────────────────────
// Committed Dashboard state (not the in-progress filter-panel draft) is
// encoded into the URL query string so it survives refresh and is
// navigable via browser back/forward. Keys are omitted when at their
// default value, keeping the URL clean (e.g. "/" for the default view).

type SortByValue = 'name' | 'latency' | 'rating' | 'trust' | 'reviewCount'
const SORT_KEYS: readonly SortByValue[] = ['name', 'latency', 'rating', 'trust', 'reviewCount']

function parseFilterParams(params: URLSearchParams): {
  search: string
  sortBy: SortByValue
  sortDir: 'asc' | 'desc'
  filters: FilterState
} {
  const sortByRaw = params.get('sort')
  const sortBy: SortByValue = (SORT_KEYS as readonly string[]).includes(sortByRaw ?? '') ? (sortByRaw as SortByValue) : 'name'
  const dirRaw = params.get('dir')
  const sortDir: 'asc' | 'desc' = dirRaw === 'asc' || dirRaw === 'desc' ? dirRaw : DEFAULT_SORT_DIRS[sortBy]
  const statusRaw = params.get('status')
  const status: FilterState['status'] = statusRaw === 'online' || statusRaw === 'offline' ? statusRaw : 'all'
  const trustRaw = params.get('trust')
  const trustParsed = trustRaw !== null ? Number(trustRaw) : 0
  const minTrustScore = Number.isFinite(trustParsed) ? Math.min(100, Math.max(0, trustParsed)) : 0
  const nutsRaw = params.get('nuts')
  const requiredNuts = nutsRaw ? nutsRaw.split(',').filter(n => NUT_FILTER_KEYS.includes(n)) : []
  return {
    search: params.get('q') ?? '',
    sortBy,
    sortDir,
    filters: { status, minTrustScore, requiredNuts },
  }
}

function buildFilterParams(search: string, sortBy: SortByValue, sortDir: 'asc' | 'desc', filters: FilterState): URLSearchParams {
  const params = new URLSearchParams()
  if (search) params.set('q', search)
  if (sortBy !== 'name') params.set('sort', sortBy)
  if (sortDir !== DEFAULT_SORT_DIRS[sortBy]) params.set('dir', sortDir)
  if (filters.status !== 'all') params.set('status', filters.status)
  if (filters.minTrustScore > 0) params.set('trust', String(filters.minTrustScore))
  if (filters.requiredNuts.length > 0) params.set('nuts', filters.requiredNuts.join(','))
  return params
}

// ── Skeleton Card ─────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="skeleton-card">
      <div className="sk-row">
        <div className="sk-avatar" />
        <div className="sk-lines">
          <div className="sk-line" style={{ width: '58%' }} />
          <div className="sk-line" style={{ width: '38%', marginTop: 6 }} />
        </div>
        <div className="sk-dot" />
      </div>
      <div className="sk-pills">
        <div className="sk-pill" style={{ width: 48 }} />
        <div className="sk-pill" style={{ width: 54 }} />
        <div className="sk-pill" style={{ width: 42 }} />
      </div>
      <div className="sk-bottom">
        <div className="sk-latency" />
        <div className="sk-btn" />
      </div>
    </div>
  )
}

function MintListView({
  mints,
  search,
  sortBy,
  sortDir,
  totalAll,
}: {
  mints: KnownMint[]
  search: string
  sortBy: 'name' | 'latency' | 'rating' | 'trust' | 'reviewCount'
  sortDir: 'asc' | 'desc'
  totalAll?: number
}) {
  const navigate = useNavigate()
  const { onMintPointerEnter, onMintPointerLeave } = useMintHoverPrefetch()
  const sortedFiltered = useMemo(() => {
    const q = search.toLowerCase()
    const filtered = mints.filter(mint => {
      if (!q) return true
      const name = (mint.name ?? getHostname(mint.url)).toLowerCase()
      return getHostname(mint.url).toLowerCase().includes(q) || name.includes(q)
    })
    return [...filtered].sort((a, b) => {
      let result: number
      if (sortBy === 'rating') {
        // Sort by the backend's weighted/Bayesian rating (falls back to the raw
        // average if the backend hasn't sent one), NOT the displayed average —
        // see KnownMint.reviewWeightedRating.
        const ra = a.reviewWeightedRating ?? a.reviewAvgRating ?? -1
        const rb = b.reviewWeightedRating ?? b.reviewAvgRating ?? -1
        result = rb - ra
      } else if (sortBy === 'latency') {
        const la = a.online === true && a.latencyMs != null ? a.latencyMs : Infinity
        const lb = b.online === true && b.latencyMs != null ? b.latencyMs : Infinity
        result = la - lb
      } else if (sortBy === 'trust') {
        result = listTrustScore(b) - listTrustScore(a)
      } else if (sortBy === 'reviewCount') {
        // Mints with reviewCount === 0 or null sort to the end, regardless of direction toggle.
        const ca = a.reviewCount && a.reviewCount > 0 ? a.reviewCount : -1
        const cb = b.reviewCount && b.reviewCount > 0 ? b.reviewCount : -1
        result = cb - ca
      } else {
        result = mintDisplayName(a).localeCompare(mintDisplayName(b))
      }
      return sortDir === DEFAULT_SORT_DIRS[sortBy] ? result : -result
    })
  }, [mints, search, sortBy, sortDir])

  return (
    <>
      <div className="mint-list-table-wrap">
        <table className="mint-list-table">
          <thead>
            <tr>
              <th>Mint</th>
              <th>Status</th>
              <th>Uptime 24h</th>
              <th className="col-hide-mobile">Latency</th>
              <th className="col-hide-mobile">Trust</th>
              <th className="col-hide-mobile">NUTs</th>
              <th className="col-hide-mobile">Age</th>
            </tr>
          </thead>
          <tbody>
            {sortedFiltered.map(mint => {
              const isOnline = mint.online === true
              const displayName = mintDisplayName(mint)
              const ageBadge = mintAgeBadge(mint.discoveredAt ?? null)
              const score = mint.trustScore ?? null
              return (
                <tr key={mint.url} className="mint-list-row" onClick={() => navigate(`/mint/${encodeURIComponent(mint.url)}`)} onPointerEnter={() => onMintPointerEnter(mint.url)} onPointerLeave={onMintPointerLeave}>
                  <td className="mint-list-td-name">
                    <MintFavicon url={mint.url} iconUrl={mint.iconUrl ?? null} size={24} radius={5} />
                    <div style={{ minWidth: 0 }}>
                      <div className="mint-list-name">{displayName}</div>
                      {displayName !== getHostname(mint.url) && <div className="mint-list-url">{getHostname(mint.url)}</div>}
                    </div>
                  </td>
                  <td>
                    <span style={{ fontSize: 10, color: isOnline ? '#17E87F' : '#E24B4A' }}>
                      ●<span className="status-text-mobile-hide">{isOnline ? ' Online' : ' Offline'}</span>
                    </span>
                  </td>
                  <td style={{ color: uptimeColor(mint.uptimePct24h), fontFamily: 'var(--font-mono-data)', fontSize: 12 }}>
                    {mint.uptimePct24h != null ? `${mint.uptimePct24h}%` : '—'}
                  </td>
                  <td className="col-hide-mobile" style={{ color: latencyColor(mint.latencyMs), fontFamily: 'var(--font-mono-data)', fontSize: 12 }}>
                    {isOnline && mint.latencyMs != null ? `${mint.latencyMs}ms` : '—'}
                  </td>
                  <td className="trust-col col-hide-mobile" style={{ color: score != null ? trustColor(score) : 'var(--text3)', fontFamily: 'var(--font-mono-data)', fontSize: 12, fontWeight: 600 }}>
                    {score != null ? `${score}%` : '—'}
                  </td>
                  <td className="col-hide-mobile" style={{ fontFamily: 'var(--font-mono-data)', fontSize: 12, color: 'var(--text2)' }}>
                    {mint.nutCount != null ? `${mint.nutCount}/14` : '—'}
                  </td>
                  <td className="col-hide-mobile">
                    {ageBadge && (
                      <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: ageBadge.color, background: ageBadge.bg, border: `1px solid ${ageBadge.border}`, borderRadius: 5, padding: '2px 6px', whiteSpace: 'nowrap' }}>
                        {ageBadge.label}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="grid-showing-note" style={{ fontSize: 13, color: 'var(--text3)', textAlign: 'center', marginTop: 16, fontFamily: 'var(--font-mono)' }}>
        Showing {sortedFiltered.length} of {totalAll || sortedFiltered.length}
      </div>
    </>
  )
}

function MintGrid({
  mints,
  search,
  sortBy,
  sortDir,
  onCompare,
  totalAll,
}: {
  mints: KnownMint[]
  search: string
  sortBy: 'name' | 'latency' | 'rating' | 'trust' | 'reviewCount'
  sortDir: 'asc' | 'desc'
  onCompare?: (url: string) => void
  totalAll?: number
}) {
  const sortedFiltered = useMemo(() => {
    const q = search.toLowerCase()
    const filtered = mints.filter(mint => {
      if (!q) return true
      const name = (mint.name ?? getHostname(mint.url)).toLowerCase()
      return getHostname(mint.url).toLowerCase().includes(q) || name.includes(q)
    })

    return [...filtered].sort((a, b) => {
      let result: number
      if (sortBy === 'rating') {
        // Sort by the backend's weighted/Bayesian rating (falls back to the raw
        // average if the backend hasn't sent one), NOT the displayed average —
        // see KnownMint.reviewWeightedRating.
        const ra = a.reviewWeightedRating ?? a.reviewAvgRating ?? -1
        const rb = b.reviewWeightedRating ?? b.reviewAvgRating ?? -1
        result = rb - ra
      } else if (sortBy === 'latency') {
        const la = a.online === true && a.latencyMs != null ? a.latencyMs : Infinity
        const lb = b.online === true && b.latencyMs != null ? b.latencyMs : Infinity
        result = la - lb
      } else if (sortBy === 'trust') {
        result = listTrustScore(b) - listTrustScore(a)
      } else if (sortBy === 'reviewCount') {
        // Mints with reviewCount === 0 or null sort to the end, regardless of direction toggle.
        const ca = a.reviewCount && a.reviewCount > 0 ? a.reviewCount : -1
        const cb = b.reviewCount && b.reviewCount > 0 ? b.reviewCount : -1
        result = cb - ca
      } else {
        result = mintDisplayName(a).localeCompare(mintDisplayName(b))
      }
      return sortDir === DEFAULT_SORT_DIRS[sortBy] ? result : -result
    })
  }, [mints, search, sortBy, sortDir])

  return (
    <>
      <div className="mint-grid">
        {sortedFiltered.map(mint => (
          <MintCard
            key={mint.url}
            mint={mint}
            {...(onCompare ? { onCompare } : {})}
          />
        ))}
      </div>
      <div className="grid-showing-note" style={{fontSize:13,color:'var(--text3)',textAlign:'center',marginTop:16,fontFamily:'var(--font-mono)'}}>
        Showing {sortedFiltered.length} of {totalAll || sortedFiltered.length}
      </div>
    </>
  )
}

// ── Dashboard ──────────────────────────────────────────────────

export default function Dashboard() {
  // Search/sort/filters are persisted in the URL query string (not plain
  // useState) so they survive a refresh and are navigable via browser
  // back/forward — see parseFilterParams/buildFilterParams above.
  const [searchParams, setSearchParams] = useSearchParams()
  const { search, sortBy, sortDir, filters: activeFilters } = useMemo(
    () => parseFilterParams(searchParams),
    [searchParams]
  )

  function commitFilters(
    next: { search?: string; sortBy?: SortByValue; sortDir?: 'asc' | 'desc'; filters?: FilterState },
    opts?: { replace?: boolean }
  ) {
    const merged = {
      search: next.search ?? search,
      sortBy: next.sortBy ?? sortBy,
      sortDir: next.sortDir ?? sortDir,
      filters: next.filters ?? activeFilters,
    }
    setSearchParams(buildFilterParams(merged.search, merged.sortBy, merged.sortDir, merged.filters), opts)
  }

  const [viewMode, setViewMode] = useState<'cards' | 'list'>(() => {
    const saved = localStorage.getItem('mintRadar_viewMode')
    return saved === 'list' ? 'list' : 'cards'
  })

  // Filter panel draft state — only committed to the URL (activeFilters) via
  // "Apply filter". Re-synced from activeFilters whenever the panel opens
  // (see the "Filters" button below) so it can't go stale after a
  // browser back/forward navigation changed activeFilters while closed.
  const [showFilters, setShowFilters] = useState(false)
  const [pendingFilters, setPendingFilters] = useState<FilterState>(DEFAULT_FILTERS)

  // Comparison state
  const [compareBaseUrl, setCompareBaseUrl] = useState<string | null>(null)
  const [showComparePicker, setShowComparePicker] = useState(false)
  const [showComparisonModal, setShowComparisonModal] = useState(false)
  const [compareSelectedUrls, setCompareSelectedUrls] = useState<Set<string>>(new Set())

  function openComparePicker(url: string) {
    setCompareBaseUrl(url)
    setShowComparePicker(true)
  }

  const [, setTick] = useState(0)
  const [showCountNote, setShowCountNote] = useState(false)
  const [showDegraded, setShowDegraded] = useState(false)
  const [showSubmit, setShowSubmit] = useState(false)
  const [submitTab, setSubmitTab] = useState<'single' | 'bulk'>('single')
  const [submitInput, setSubmitInput] = useState('')
  const [submitUrl, setSubmitUrl] = useState('')
  const [submitState, setSubmitState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [submitMsg, setSubmitMsg] = useState('')
  // Probe/lookup results are keyed by the input they were produced for —
  // 'loading' and 'idle' are derived below instead of set synchronously in effects.
  const [probe, setProbe] = useState<{ url: string; state: 'success' | 'error'; result: { name: string | null; version: string | null; nutCount: number; latencyMs: number | null } | null }>({ url: '', state: 'error', result: null })
  const [nostrLookup, setNostrLookup] = useState<{ input: string; state: 'idle' | 'error'; msg: string }>({ input: '', state: 'idle', msg: '' })
  const [searchFocused, setSearchFocused] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const submitTrimmed = submitInput.trim()
  const submitIsNostrKey = submitTrimmed.startsWith('npub1') || /^[0-9a-f]{64}$/i.test(submitTrimmed)
  const nostrLookupState: 'idle' | 'loading' | 'error' =
    !submitIsNostrKey ? 'idle'
    : nostrLookup.input === submitTrimmed ? nostrLookup.state
    : 'loading'
  const nostrLookupMsg = submitIsNostrKey && nostrLookup.input === submitTrimmed ? nostrLookup.msg : ''
  const probeState: 'idle' | 'loading' | 'success' | 'error' =
    !submitUrl.startsWith('https://') ? 'idle'
    : probe.url === submitUrl ? probe.state
    : 'loading'
  const probeResult = probe.url === submitUrl && probeState === 'success' ? probe.result : null

  // Bulk submit state
  const [bulkInput, setBulkInput] = useState('')
  const [bulkProgress, setBulkProgress] = useState<Array<{ url: string; status: 'pending' | 'probing' | 'added' | 'duplicate' | 'failed'; error?: string }>>([])
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkDone, setBulkDone] = useState(false)

  const queryClient = useQueryClient()
  // Client-side NIP-87 discovery POSTs newly-announced mint URLs to
  // /api/mints/discover, where the backend validates + probes them before they
  // enter the `mints` table. We deliberately do NOT merge raw, unvalidated Nostr
  // announcements into the grid or the counts — the single source of truth for
  // "how many mints we track" is /api/mints/known, which is exactly what
  // /api/stats counts too (both are an unfiltered `SELECT ... FROM mints`).
  useNostrDiscovery()
  const { data: knownMintsData, isLoading: knownLoading, error: knownError } = useKnownMints()

  const statusRecord = useMemo(() => {
    if (!knownMintsData) return {}
    return Object.fromEntries(
      knownMintsData
        .filter(m => m.online != null)
        .map(m => [m.url, { online: m.online as boolean, latencyMs: m.latencyMs ?? null }])
    )
  }, [knownMintsData])

  const trustScoreRecord = useMemo(() => {
    if (!knownMintsData) return {}
    return Object.fromEntries(knownMintsData.map(m => [m.url, m.trustScore ?? null]))
  }, [knownMintsData])

  const { read: userReadRelays } = useUserRelays()
  useWatchlistNotifications(statusRecord, trustScoreRecord, userReadRelays)

  // Explicit "Offline" status filter must surface degraded (offline 24h+) mints
  // even when the default hidden-mints toggle is off — otherwise the filter
  // would AND against the hidden set and return nothing.
  const effectiveShowDegraded = showDegraded || activeFilters.status === 'offline'

  // The full set of mints we track — matches the "All Known" tile and
  // /api/stats `totalMints` (all three read the same unfiltered mints table).
  const knownTotal = knownMintsData?.length ?? 0

  const { degradedCount, allMints } = useMemo(() => {
    const degradedUrls = knownMintsData?.filter(m => m.degraded).map(m => m.url) ?? []
    return {
      degradedCount: degradedUrls.length,
      allMints: (knownMintsData?.filter(m => effectiveShowDegraded ? true : !m.degraded) ?? []) as KnownMint[],
    }
  }, [knownMintsData, effectiveShowDegraded])

  const filteredMints = useMemo(() => {
    return applyFilters(allMints, activeFilters)
  }, [allMints, activeFilters])
  const activeFilterCount = countActiveFilters(activeFilters)

  const { data: statsData } = useQuery({
    queryKey: ['stats'],
    queryFn: async () => {
      const res = await fetch('/api/stats')
      if (!res.ok) throw new Error('stats fetch failed')
      return res.json() as Promise<{ avgLatency24h: number | null }>
    },
    staleTime: 2 * 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
  })
  const avgLatency24h = statsData?.avgLatency24h ?? null

  const totalCount = allMints.length
  const onlineCount = allMints.filter(m => m.online === true).length

  const comparedMints = useMemo(() => {
    if (!compareBaseUrl) return []
    const base = allMints.find(m => m.url === compareBaseUrl)
    if (!base) return []
    return [base, ...allMints.filter(m => compareSelectedUrls.has(m.url))]
  }, [allMints, compareBaseUrl, compareSelectedUrls])

  const lastCheckTime = useMemo(() => {
    if (!knownMintsData) return null
    let latest: Date | null = null
    for (const mint of knownMintsData) {
      if (mint.lastCheckedAt) {
        const t = new Date(mint.lastCheckedAt)
        if (!latest || t > latest) latest = t
      }
    }
    return latest
  }, [knownMintsData])

  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30_000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!showSubmit) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowSubmit(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showSubmit])

  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent).type === 'mintradar:escape') {
        setShowFilters(false)
        setShowComparePicker(false)
        setShowComparisonModal(false)
        setShowSubmit(false)
      }
    }
    window.addEventListener('mintradar:escape', handler)
    return () => window.removeEventListener('mintradar:escape', handler)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== '/') return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return
      e.preventDefault()
      searchInputRef.current?.focus()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    if (submitState !== 'success') return
    const timer = setTimeout(() => setShowSubmit(false), 3000)
    return () => clearTimeout(timer)
  }, [submitState])

  function handleViewMode(mode: 'cards' | 'list') {
    setViewMode(mode)
    localStorage.setItem('mintRadar_viewMode', mode)
  }

  function handleSortClick(s: typeof sortBy) {
    if (s === sortBy) {
      commitFilters({ sortDir: sortDir === 'asc' ? 'desc' : 'asc' })
    } else {
      commitFilters({ sortBy: s, sortDir: DEFAULT_SORT_DIRS[s] })
    }
  }

  function handleSubmitInputChange(value: string) {
    setSubmitInput(value)
    const trimmed = value.trim()
    if (trimmed.startsWith('https://')) {
      setSubmitUrl(trimmed)
    } else {
      setSubmitUrl('')
    }
  }

  useEffect(() => {
    if (!showSubmit) return
    const input = submitInput.trim()
    const isNpub = input.startsWith('npub1')
    const isHex = /^[0-9a-f]{64}$/i.test(input)
    if (!isNpub && !isHex) return
    const timer = setTimeout(() => {
      void (async () => {
        try {
          let pubkey = input
          if (isNpub) {
            const decoded = nip19.decode(input)
            if (decoded.type !== 'npub') {
              setNostrLookup({ input, state: 'error', msg: 'Invalid npub format' })
              return
            }
            pubkey = decoded.data as string
          }
          const events = await Promise.race([
            sharedPool.querySync(NOSTR_LOOKUP_RELAYS, { kinds: [38172], authors: [pubkey], limit: 5 }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
          ]) as NostrEvent[]
          const mintUrl = events
            .flatMap(e => e.tags)
            .find(t => t[0] === 'u' && t[1])?.[1]
          if (!mintUrl) {
            setNostrLookup({ input, state: 'error', msg: 'No mint announcement found for this Nostr key' })
            return
          }
          setNostrLookup({ input, state: 'idle', msg: '' })
          setSubmitUrl(mintUrl)
        } catch {
          setNostrLookup({ input, state: 'error', msg: 'Failed to reach Nostr relays. Try again.' })
        }
      })()
    }, 600)
    return () => clearTimeout(timer)
  }, [submitInput, showSubmit])

  useEffect(() => {
    if (!showSubmit) return
    if (!submitUrl.startsWith('https://')) return
    const timer = setTimeout(() => {
      fetch(`/api/mint/probe?url=${encodeURIComponent(submitUrl)}`)
        .then(res => { if (!res.ok) throw new Error(); return res.json() as Promise<MintStatus> })
        .then(data => {
          if (data.online && data.info) {
            setProbe({
              url: submitUrl,
              state: 'success',
              result: {
                name: data.info.name ?? null,
                version: data.info.version ?? null,
                nutCount: Object.keys(data.info.nuts).length,
                latencyMs: data.latencyMs,
              },
            })
          } else {
            setProbe({ url: submitUrl, state: 'error', result: null })
          }
        })
        .catch(() => {
          setProbe({ url: submitUrl, state: 'error', result: null })
        })
    }, 600)
    return () => clearTimeout(timer)
  }, [submitUrl, showSubmit])

  function handleSubmitMint() {
    if (!submitUrl.startsWith('https://')) {
      setSubmitState('error')
      setSubmitMsg('URL must start with https://')
      return
    }
    setSubmitState('loading')
    fetch('/api/mint/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: submitUrl }),
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }: { ok: boolean; data: { success?: boolean; isNew?: boolean; error?: string; name?: string | null } }) => {
        if (!ok) {
          setSubmitState('error')
          setSubmitMsg((data.error) ?? 'Submission failed')
        } else {
          setSubmitState('success')
          setSubmitMsg(
            data.isNew === false
              ? 'Already tracked — this mint is already known to MintRadar.'
              : 'Mint submitted! It will appear on the dashboard after the next probe cycle (~5 min).'
          )
          void queryClient.invalidateQueries({ queryKey: ['mints-known'] })
        }
      })
      .catch(() => {
        setSubmitState('error')
        setSubmitMsg('Network error. Please try again.')
      })
  }

  async function handleBulkSubmit() {
    const lines = bulkInput.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    const initial = lines.map(url => ({ url, status: 'pending' as const }))
    setBulkProgress(initial)
    setBulkRunning(true)
    setBulkDone(false)

    const validIndices: number[] = []
    const validUrls: string[] = []
    lines.forEach((url, i) => {
      if (url.startsWith('https://')) {
        validIndices.push(i)
        validUrls.push(url)
      } else {
        setBulkProgress(prev => prev.map((p, j) => j === i ? { ...p, status: 'failed', error: 'Must start with https://' } : p))
      }
    })

    if (validUrls.length > 0) {
      setBulkProgress(prev => prev.map((p, j) => validIndices.includes(j) ? { ...p, status: 'probing' } : p))
      try {
        const res = await fetch('/api/mints/discover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: validUrls }),
        })
        const data = await res.json() as {
          error?: string
          results?: Array<{ url: string; success: boolean; isNew: boolean; error?: string }>
        }
        if (res.ok && data.results) {
          const results = data.results
          setBulkProgress(prev => prev.map((p, j) => {
            const k = validIndices.indexOf(j)
            if (k === -1) return p
            const r = results[k]
            if (!r || !r.success) return { ...p, status: 'failed', error: r?.error ?? 'Failed' }
            return { ...p, status: r.isNew ? 'added' : 'duplicate' }
          }))
        } else {
          const err = data.error ?? 'Failed'
          setBulkProgress(prev => prev.map((p, j) => validIndices.includes(j) ? { ...p, status: 'failed', error: err } : p))
        }
      } catch {
        setBulkProgress(prev => prev.map((p, j) => validIndices.includes(j) ? { ...p, status: 'failed', error: 'Network error' } : p))
      }
    }

    setBulkRunning(false)
    setBulkDone(true)
    void queryClient.invalidateQueries({ queryKey: ['mints-known'] })
  }

  const bulkAdded = bulkProgress.filter(p => p.status === 'added').length
  const bulkDuplicate = bulkProgress.filter(p => p.status === 'duplicate').length
  const bulkFailed = bulkProgress.filter(p => p.status === 'failed').length

  return (
    <div className="dashboard">
      <div className="stats-bar">
        <button type="button" className="stat-card stat-card-btn" onClick={() => setShowCountNote(v => !v)} aria-expanded={showCountNote}>
          <div className="stat-icon green"><IcSignal /></div>
          <div>
            <div className="stat-label">Online Mints</div>
            <div className="stat-value green">{onlineCount} / {totalCount}</div>
          </div>
        </button>
        <div className="stat-card">
          <div className="stat-icon orange"><IcTimer /></div>
          <div>
            <div className="stat-label">Median Latency</div>
            <div className="stat-value">
              {avgLatency24h !== null ? `${avgLatency24h} ms` : '—'}
            </div>
            <div className="stat-sub">from Frankfurt</div>
          </div>
        </div>
        <button type="button" className="stat-card stat-card-btn" onClick={() => setShowCountNote(v => !v)} aria-expanded={showCountNote}>
          <div className="stat-icon gray"><IcGrid /></div>
          <div>
            <div className="stat-label">All Known</div>
            <div className="stat-value">{knownTotal}</div>
            <div className="stat-sub">incl. offline</div>
          </div>
        </button>
        <div className="stat-card">
          <div className="stat-icon gray"><IcSuccess /></div>
          <div>
            <div className="stat-label">Last Check</div>
            <div className="stat-value muted">{formatTimeAgo(lastCheckTime)}</div>
          </div>
        </div>
      </div>
      {showCountNote && (
        <p className="stat-count-note">
          <strong>Listed</strong> = in the grid (not hidden after 24h offline).{' '}
          <strong>Known</strong> = every mint we indexed.
        </p>
      )}

      <div className="dashboard-controls">
        {/* Wrapper is `display: contents` on desktop (transparent to the flex
            row) and a real flex row on mobile, where the Filters button sits
            beside the search input instead of wrapping to its own line. */}
        <div className="controls-search-line">
          <div className="search-wrap">
            <span className="search-icon"><IcSearch /></span>
            <input
              ref={searchInputRef}
              className="search-input"
              type="text"
              placeholder="Search mints"
              value={search}
              onChange={e => commitFilters({ search: e.target.value }, { replace: true })}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              data-search-input
            />
            {!searchFocused && search === '' && (
              <span className="search-shortcut">/</span>
            )}
          </div>
          <button
            type="button"
            className={`filter-btn${showFilters ? ' active' : ''}`}
            onClick={() => { if (!showFilters) setPendingFilters(activeFilters); setShowFilters(v => !v) }}
          >
            <IcFilter />
            Filters
            {activeFilterCount > 0 && <span className="filter-badge">{activeFilterCount}</span>}
          </button>
        </div>
        <div className="sort-segment">
          {(['reviewCount', 'rating', 'latency', 'name', 'trust'] as const).map(s => (
            <button
              key={s}
              type="button"
              className={`sort-btn${sortBy === s ? ' active' : ''}`}
              onClick={() => handleSortClick(s)}
            >
              {s === 'trust' ? 'Trust Score' : s === 'reviewCount' ? 'Most reviewed' : s.charAt(0).toUpperCase() + s.slice(1)}
              {sortBy === s && <span style={{marginLeft: 3, fontSize: 10, opacity: 0.7}}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
            </button>
          ))}
        </div>
        <div className="view-toggle">
          <button type="button" className={`view-toggle-btn${viewMode === 'cards' ? ' active' : ''}`} onClick={() => handleViewMode('cards')} title="Card view">
            <IcGrid />
          </button>
          <button type="button" className={`view-toggle-btn${viewMode === 'list' ? ' active' : ''}`} onClick={() => handleViewMode('list')} title="List view">
            <IcList />
          </button>
        </div>
        <button
          type="button"
          className="refresh-btn"
          title="Reset filters & refresh"
          onClick={() => {
            commitFilters({ search: '', sortBy: 'name', sortDir: 'asc', filters: DEFAULT_FILTERS })
            setPendingFilters(DEFAULT_FILTERS)
            setShowFilters(false)
            setShowDegraded(false)
            void queryClient.invalidateQueries({ queryKey: ['mints-known'] })
          }}
        >
          <IcRefresh />
        </button>
        <button type="button" className="submit-btn" onClick={() => { setShowSubmit(true); setSubmitTab('single'); setSubmitState('idle'); setSubmitInput(''); setSubmitUrl(''); setProbe({ url: '', state: 'error', result: null }); setNostrLookup({ input: '', state: 'idle', msg: '' }); setBulkInput(''); setBulkProgress([]); setBulkRunning(false); setBulkDone(false) }}>
          <IcPlus /> Submit mint
        </button>
      </div>

      <p className="grid-score-explainer">
        We score how it runs. They score how it went. You pick.
      </p>

      {showFilters && (
        <div className="filter-panel">
          {/* Active filter tags */}
          {activeFilterCount > 0 && (
            <div className="filter-active-tags">
              {activeFilters.status !== 'all' && (
                <span className="filter-tag">
                  {activeFilters.status === 'online' ? 'Online' : 'Offline'}
                  <button type="button" onClick={() => { const f = { ...activeFilters, status: 'all' as const }; commitFilters({ filters: f }); setPendingFilters(f) }}><IcClose /></button>
                </span>
              )}
              {activeFilters.minTrustScore > 0 && (
                <span className="filter-tag">
                  Trust ≥ {activeFilters.minTrustScore}%
                  <button type="button" onClick={() => { const f = { ...activeFilters, minTrustScore: 0 }; commitFilters({ filters: f }); setPendingFilters(f) }}><IcClose /></button>
                </span>
              )}
              {activeFilters.requiredNuts.map(nut => (
                <span key={nut} className="filter-tag">
                  NUT-{nut.padStart(2, '0')}
                  <button type="button" onClick={() => { const f = { ...activeFilters, requiredNuts: activeFilters.requiredNuts.filter(n => n !== nut) }; commitFilters({ filters: f }); setPendingFilters(f) }}><IcClose /></button>
                </span>
              ))}
            </div>
          )}

          <div className="filter-row">
            <div className="filter-group filter-box">
              <div className="filter-group-label">Status</div>
              <div className="filter-radio-group">
                {(['all', 'online', 'offline'] as const).map(s => (
                  <label key={s} className="filter-radio">
                    <input type="radio" name="filter-status" checked={pendingFilters.status === s} onChange={() => setPendingFilters(p => ({ ...p, status: s }))} />
                    {s === 'all' ? 'All' : s === 'online' ? 'Online' : 'Offline'}
                  </label>
                ))}
              </div>
            </div>

            <div className="filter-group filter-box">
              <div className="filter-group-label">Min. Trust Score: <strong>{pendingFilters.minTrustScore}%</strong></div>
              <input
                type="range" min={0} max={100} step={5}
                value={pendingFilters.minTrustScore}
                onChange={e => setPendingFilters(p => ({ ...p, minTrustScore: parseInt(e.target.value) }))}
                className="filter-slider"
              />
            </div>
          </div>

          <div className="filter-footer">
            <div className="filter-count">Showing <strong>{filteredMints.length}</strong> of <strong>{totalCount}</strong> mints</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="filter-reset-btn" onClick={() => { setPendingFilters(DEFAULT_FILTERS); commitFilters({ filters: DEFAULT_FILTERS }) }}>Reset filters</button>
              <button type="button" className="filter-apply-btn" onClick={() => { commitFilters({ filters: pendingFilters }); setShowFilters(false); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Apply filter</button>
            </div>
          </div>
        </div>
      )}

      {knownError ? (
        <p className="error-msg">Failed to load mints</p>
      ) : knownLoading ? (
        <div className="mint-grid">
          {Array.from({ length: 9 }, (_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : (
        <>
          {viewMode === 'list' ? (
            <MintListView
              mints={filteredMints}
              search={search}
              sortBy={sortBy}
              sortDir={sortDir}
              totalAll={knownTotal}
            />
          ) : (
            <MintGrid
              mints={filteredMints}
              search={search}
              sortBy={sortBy}
              sortDir={sortDir}
              onCompare={openComparePicker}
              totalAll={knownTotal}
            />
          )}
          {degradedCount > 0 && activeFilters.status !== 'offline' && (
            <p className="degraded-note">
              {!showDegraded && <>{degradedCount} mints hidden (offline 24h+){' '}</>}
              <button onClick={() => setShowDegraded(v => !v)}
                style={{background:'none',border:'none',color:'var(--green-bright)',fontSize:11,fontWeight:600,cursor:'pointer'}}>
                {showDegraded ? 'Hide' : 'Show'}
              </button>
            </p>
          )}
        </>
      )}

      {/* Compare picker */}
      {showComparePicker && compareBaseUrl && (() => {
        const baseMint = allMints.find(m => m.url === compareBaseUrl)
        const candidates = allMints.filter(m => m.url !== compareBaseUrl && m.online === true)
        return (
          <MintComparePicker
            candidates={candidates}
            baseLabel={baseMint ? mintDisplayName(baseMint) : compareBaseUrl}
            onClose={() => setShowComparePicker(false)}
            onConfirm={urls => {
              setCompareSelectedUrls(new Set(urls))
              setShowComparePicker(false)
              setShowComparisonModal(true)
            }}
          />
        )
      })()}

      {/* Comparison modal */}
      {showComparisonModal && comparedMints.length >= 2 && (
        <Suspense fallback={null}>
          <ComparisonModal mints={comparedMints} onClose={() => setShowComparisonModal(false)} />
        </Suspense>
      )}

      {showSubmit && (
        <div className="submit-modal-overlay" onClick={() => setShowSubmit(false)}>
          <div className="submit-modal" onClick={e => e.stopPropagation()}>
            <div className="submit-modal-title">Submit a Mint</div>
            <div className="submit-tabs">
              <button type="button" className={`submit-tab-btn${submitTab === 'single' ? ' active' : ''}`} onClick={() => setSubmitTab('single')}>Single</button>
              <button type="button" className={`submit-tab-btn${submitTab === 'bulk' ? ' active' : ''}`} onClick={() => setSubmitTab('bulk')}>Bulk</button>
            </div>

            {submitTab === 'single' && (
              <>
                <div className="submit-modal-desc">
                  Submit a Cashu mint URL to be listed. The mint must be reachable and respond to <code>/v1/info</code>.
                </div>
                {submitState !== 'success' && (
                  <>
                    <input
                      className="submit-modal-input"
                      type="text"
                      placeholder="https://yourmint.cash or npub1..."
                      value={submitInput}
                      onChange={e => handleSubmitInputChange(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && probeState === 'success') handleSubmitMint() }}
                      autoFocus
                    />
                    <div className="submit-input-hint">Enter a mint URL or the mint operator's Nostr public key</div>
                    {nostrLookupState === 'loading' && <div className="submit-probe-loading">Looking up mint on Nostr…</div>}
                    {nostrLookupState === 'error' && <div className="submit-probe-error">{nostrLookupMsg}</div>}
                    {probeState === 'loading' && submitUrl.startsWith('https://') && <div className="submit-probe-loading">Checking mint…</div>}
                    {probeState === 'success' && probeResult !== null && (
                      <div className="submit-probe-preview">
                        <div className="submit-probe-name">{probeResult.name ?? 'Unknown mint'}</div>
                        <div className="submit-probe-meta">
                          <span>v{probeResult.version ?? '?'}</span>
                          <span>·</span>
                          <span>{probeResult.nutCount} NUTs</span>
                          {probeResult.latencyMs !== null && (<><span>·</span><span style={{ color: latencyColor(probeResult.latencyMs) }}>{probeResult.latencyMs} ms</span></>)}
                        </div>
                      </div>
                    )}
                    {probeState === 'error' && submitUrl.startsWith('https://') && nostrLookupState === 'idle' && <div className="submit-probe-error">Mint unreachable or invalid</div>}
                    {submitState === 'error' && <div className="submit-result error">{submitMsg}</div>}
                    <div className="submit-modal-actions">
                      <button className="submit-cancel-btn" onClick={() => setShowSubmit(false)}>Cancel</button>
                      <button className="submit-ok-btn" onClick={handleSubmitMint} disabled={probeState !== 'success' || submitState === 'loading'}>
                        {submitState === 'loading' ? 'Submitting…' : 'Submit'}
                      </button>
                    </div>
                    <div className="submit-no-account">No account required.</div>
                  </>
                )}
                {submitState === 'success' && (
                  <>
                    <div className="submit-result success">{submitMsg}</div>
                    <div className="submit-modal-actions">
                      <button className="submit-ok-btn" onClick={() => setShowSubmit(false)}>Close</button>
                    </div>
                  </>
                )}
              </>
            )}

            {submitTab === 'bulk' && (
              <>
                <div className="submit-modal-desc">
                  Paste one mint URL per line. Each must start with <code>https://</code>.
                </div>
                {!bulkRunning && !bulkDone && (
                  <>
                    <textarea
                      className="bulk-textarea"
                      placeholder={'https://mint1.example.com\nhttps://mint2.example.com'}
                      value={bulkInput}
                      onChange={e => setBulkInput(e.target.value)}
                      rows={6}
                      autoFocus
                    />
                    <div className="submit-modal-actions">
                      <button className="submit-cancel-btn" onClick={() => setShowSubmit(false)}>Cancel</button>
                      <button
                        className="submit-ok-btn"
                        onClick={() => { void handleBulkSubmit() }}
                        disabled={bulkInput.trim().length === 0}
                      >Submit All</button>
                    </div>
                  </>
                )}
                {(bulkRunning || bulkProgress.length > 0) && (
                  <div className="bulk-progress">
                    {bulkProgress.map((p, i) => (
                      <div key={i} className={`bulk-row status-${p.status}`}>
                        <span className="bulk-url">{getHostname(p.url)}</span>
                        <span className="bulk-status">
                          {p.status === 'pending' && '…'}
                          {p.status === 'probing' && '⟳ probing'}
                          {p.status === 'added' && '✓ Added'}
                          {p.status === 'duplicate' && '• Already tracked'}
                          {p.status === 'failed' && `✗ ${p.error ?? 'Failed'}`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {bulkDone && (
                  <div style={{ marginTop: 10 }}>
                    <div className={`submit-result ${bulkFailed === 0 ? 'success' : 'error'}`}>
                      {bulkAdded} added, {bulkDuplicate} already tracked, {bulkFailed} failed
                    </div>
                    <div className="submit-modal-actions">
                      <button className="submit-ok-btn" onClick={() => setShowSubmit(false)}>Close</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
