import { TrendingUp, TrendingDown } from 'lucide-react'
import { MintFavicon } from '../mint/MintFavicon'

export interface TrustMover {
  url: string
  name: string | null
  delta: number
}

export interface TrustMoversData {
  risers: TrustMover[]
  fallers: TrustMover[]
}

interface TrustMoversPanelProps {
  period: '7d' | '30d'
  onPeriodChange: (period: '7d' | '30d') => void
  data: TrustMoversData | undefined
  // True only on the very first load, when there is no data (not even stale
  // previous-period data) to show — renders a skeleton, never "No data yet".
  loading: boolean
  // True when data IS shown but a fresh fetch is in flight (background refresh,
  // or the 7d↔30d switch while keepPreviousData holds the old rows) — dims the
  // existing rows slightly instead of blanking them.
  refreshing?: boolean
  onMintClick: (url: string) => void
  getDisplayName: (mover: TrustMover) => string
  getIconUrl: (mover: TrustMover) => string | null
}

function SkeletonRows() {
  return (
    <div className="stats-movers-skeleton" aria-hidden="true">
      {[0, 1, 2].map(i => (
        <div key={i} className="stats-movers-sk-row">
          <div className="stats-movers-sk-avatar" />
          <div className="stats-movers-sk-lines">
            <div className="stats-movers-sk-line" style={{ width: '58%' }} />
            <div className="stats-movers-sk-line" style={{ width: '38%' }} />
          </div>
          <div className="stats-movers-sk-badge" />
        </div>
      ))}
    </div>
  )
}

function getHostname(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

// Extracted from Stats.tsx (rather than kept inline like its sibling modals)
// specifically so the toggle/empty-state/color-differentiation behavior can
// be unit-tested without mounting the whole Stats page — see
// TrustMoversPanel.test.tsx. No `@/...`-aliased imports: vitest.config.ts has
// no path-alias resolution (unlike vite.config.ts), so this component takes
// all data via props instead of reaching into hooks/utils itself, and imports
// MintFavicon by relative path.
export function TrustMoversPanel({ period, onPeriodChange, data, loading, refreshing = false, onMintClick, getDisplayName, getIconUrl }: TrustMoversPanelProps) {
  // Row markup mirrors .stats-top5-row (Most Reliable, in Stats.tsx) — favicon,
  // name on top with its hostname underneath, value flush right — so the two
  // panels in the same grid row read as one visual family. Only the right-hand
  // value differs: a colored delta badge instead of a plain percentage.
  const renderRows = (movers: TrustMover[], direction: 'up' | 'down') => {
    if (!data) {
      // Skeleton while the request is still in flight; "No data yet" only once
      // the query has settled without ever producing data (e.g. a failed fetch).
      if (loading) return <SkeletonRows />
      return <div style={{ color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>No data yet</div>
    }
    if (movers.length === 0) {
      return <div className="stats-movers-empty">No significant changes this period</div>
    }
    return movers.map(m => {
      const hostname = getHostname(m.url)
      const name = getDisplayName(m)
      return (
        <div key={m.url} className="stats-top5-row" onClick={() => onMintClick(m.url)}>
          <MintFavicon url={m.url} iconUrl={getIconUrl(m)} size={22} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
            {name !== hostname && (
              <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hostname}</div>
            )}
          </div>
          <span className={`stats-movers-delta ${direction}`}>{direction === 'up' ? '+' : ''}{m.delta}%</span>
        </div>
      )
    })
  }

  return (
    <div className="stats-panel stats-movers-panel">
      <div className="stats-card-header">
        <div className="stats-panel-title" style={{ marginBottom: 0 }}>Trust Score Movers</div>
        <div className="stats-tab-toggle">
          <button type="button" className={`stats-tab-btn${period === '7d' ? ' active' : ''}`} onClick={() => onPeriodChange('7d')}>7d</button>
          <button type="button" className={`stats-tab-btn${period === '30d' ? ' active' : ''}`} onClick={() => onPeriodChange('30d')}>30d</button>
        </div>
      </div>
      <div
        style={{ marginTop: 10, opacity: refreshing ? 0.5 : 1, transition: 'opacity 0.15s ease' }}
        aria-busy={refreshing || loading}
      >
        <div className="stats-movers-section-label"><TrendingUp size={11} /> Risers</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--stats-row-gap)' }}>
          {renderRows(data?.risers ?? [], 'up')}
        </div>

        <div className="stats-movers-section-label"><TrendingDown size={11} /> Fallers</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--stats-row-gap)' }}>
          {renderRows(data?.fallers ?? [], 'down')}
        </div>
      </div>
    </div>
  )
}
