import { useState, useMemo, useEffect, useRef } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Info } from 'lucide-react'
import { TrustMoversPanel } from '@/components/stats/TrustMoversPanel'
import { MintFavicon } from '@/components/mint/MintFavicon'
import { useKnownMints, type KnownMint } from '@/hooks/useKnownMints'
import { TRACKED_NUTS, NUT_META } from '@/constants/nuts'
import { trustColor, trustScoreInfo, trustDonutArc, displayName } from '@/utils/mintFormatting'
import { isTestMint } from '@/constants/testMints'
import { computeGeoDistribution } from '@/utils/geoDistribution'
import { useTapTooltip } from '@/hooks/useTapTooltip'
import { useIsMobile } from '@/hooks/useIsMobile'
import './Stats.css'

interface StatsData {
  totalMints: number
  onlineMints: number
  offlineMints: number
  avgTrustScore: number | null
  avgLatency24h: number | null
  trustDistribution: { low: number; moderate: number; high: number }
  nutAdoption: Array<{ nut: string; count: number; percent: number }>
  top5ByTrustScore: Array<{ url: string; name: string | null; trustScore: number }>
}

function uptimeColor(pct: number): string {
  if (pct >= 80) return '#17E87F'
  if (pct >= 50) return '#f59e0b'
  return '#E24B4A'
}

function getHostname(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}


// "Advanced" features: security/privacy capabilities that go beyond the
// baseline mint/melt/state-check/restore lifecycle every mint needs just to
// function (NUT-04/05/07/08/09/10). Used by the Network Health Index's
// feature-adoption component.
const ADVANCED_NUT_KEYS = ['11', '12', '14', '17', '21', '22', '25', '27', '28', '30']

function countryFlag(cc: string): string {
  if (cc.length !== 2) return ''
  const base = 0x1F1E6 - 65
  return String.fromCodePoint(base + cc.toUpperCase().charCodeAt(0), base + cc.toUpperCase().charCodeAt(1))
}

const CITY_SHORT: Record<string, string> = {
  'Frankfurt am Main': 'Frankfurt',
  'Saint Petersburg': 'St. Petersburg',
}

function shortenCity(city: string): string {
  return CITY_SHORT[city] ?? (city.length > 12 ? city.slice(0, 11) + '…' : city)
}

function geoLabel(loc: string): { display: string; flag: string; color?: string } {
  if (loc === 'Cloudflare CDN') return { display: 'Cloudflare CDN', flag: '🌐', color: '#f59e0b' }
  if (loc === 'Unknown') return { display: 'Geolocation unavailable', flag: '' }
  const commaIdx = loc.lastIndexOf(', ')
  if (commaIdx === -1) return { display: shortenCity(loc), flag: '' }
  const cc = loc.slice(commaIdx + 2)
  const city = loc.slice(0, commaIdx)
  return { display: shortenCity(city), flag: cc.length === 2 ? countryFlag(cc) : '' }
}

function NutMintsModal({ nutId, nutMeta, mints, onClose }: {
  nutId: string
  nutMeta: { short: string; desc: string; specNum: string }
  mints: KnownMint[]
  onClose: () => void
}) {
  const [search, setSearch] = useState('')

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const filtered = useMemo(() => {
    if (!search.trim()) return mints
    const q = search.toLowerCase()
    return mints.filter(m => {
      const name = displayName(m).toLowerCase()
      return name.includes(q) || m.url.toLowerCase().includes(q)
    })
  }, [mints, search])

  const total = mints.length
  const online = mints.filter(m => m.online === true).length
  const offline = mints.filter(m => m.online === false).length

  return (
    <div className="nut-modal-overlay" onClick={onClose}>
      <div className="nut-modal" onClick={e => e.stopPropagation()}>
        <button type="button" className="nut-modal-close" onClick={onClose}>✕</button>
        <div className="nut-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span className="snc-nut-tag">{nutId}</span>
            <span className="nut-modal-title">{nutMeta.short}</span>
          </div>
          <div className="nut-modal-subtitle">{total} mint{total !== 1 ? 's' : ''} support this NUT</div>
        </div>
        <input
          className="nut-modal-search"
          type="text"
          placeholder="Filter by mint name or URL…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
        />
        <div className="nut-modal-list">
          {filtered.map(m => (
            <div key={m.url} className="nut-modal-row">
              <MintFavicon url={m.url} iconUrl={m.iconUrl} size={22} />
              <div className="nut-modal-row-info">
                <span className="nut-modal-row-name">{displayName(m)}</span>
                <span className="nut-modal-row-url">{getHostname(m.url)}</span>
              </div>
              <span
                className="nut-modal-row-dot"
                style={{ background: m.online === true ? '#17E87F' : '#E24B4A' }}
              />
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="nut-modal-empty">No mints match</div>
          )}
        </div>
        <div className="nut-modal-footer">
          {total} total · {online} online · {offline} offline
        </div>
      </div>
    </div>
  )
}

function mintAgeBadge(discoveredAt: string | null | undefined): { label: string; color: string; bg: string; border: string } | null {
  if (!discoveredAt) return null
  const months = (Date.now() - new Date(discoveredAt).getTime()) / (1000 * 60 * 60 * 24 * 30.44)
  if (months < 1) return { label: 'Fresh', color: '#60a5fa', bg: 'rgba(96,165,250,0.1)', border: 'rgba(96,165,250,0.25)' }
  if (months < 6) return { label: 'Established', color: '#4ade80', bg: 'rgba(74,222,128,0.1)', border: 'rgba(74,222,128,0.25)' }
  if (months < 12) return { label: 'Veteran', color: '#ffa500', bg: 'rgba(255,165,0,0.1)', border: 'rgba(255,165,0,0.25)' }
  return { label: 'OG', color: '#a78bfa', bg: 'rgba(167,139,250,0.1)', border: 'rgba(167,139,250,0.25)' }
}

interface SoftwareVersionEntry {
  ver: string
  count: number
  fullVersion: string
  badge: string
  badgeColor: string
}

// Mint-list drill-down level of SoftwareModal — this is the body the
// standalone per-version modal used to render, unchanged (rows, Trust Score,
// age badge, "Show all", "X online · Y offline", "Sorted by Trust Score").
// Kept as its own component so the call site can `key` it by version, which
// resets `showAll` when the user backs out and drills into a different one.
function VersionMintsView({ sw, ver, mints, onBack, onClose }: {
  sw: string
  ver: string
  mints: KnownMint[]
  onBack: () => void
  onClose: () => void
}) {
  const navigate = useNavigate()
  const [showAll, setShowAll] = useState(false)

  const sorted = useMemo(() =>
    [...mints].sort((a, b) => (b.trustScore ?? 0) - (a.trustScore ?? 0))
  , [mints])

  const title = ver ? `${sw} ${ver}` : sw
  const displayed = showAll ? sorted : sorted.slice(0, 10)
  const onlineCount = mints.filter(m => m.online === true).length
  const offlineCount = mints.filter(m => m.online === false).length

  return (
    <>
      <div className="nut-modal-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <button type="button" className="nut-modal-back" onClick={onBack} aria-label={`Back to ${sw} versions`}>‹</button>
          <span className="nut-modal-title">{title}</span>
          <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text3)', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 5, padding: '2px 7px' }}>{mints.length} mint{mints.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
      <div className="nut-modal-list">
        {displayed.map(m => {
            const score = m.trustScore ?? null
            const scoreColor = score != null ? (score >= 70 ? '#4ade80' : score >= 40 ? '#ffa500' : '#ff4d4d') : 'var(--text3)'
            const badge = mintAgeBadge(m.discoveredAt ?? null)
            return (
              <div
                key={m.url}
                className="nut-modal-row"
                style={{ cursor: 'pointer' }}
                onClick={() => { onClose(); navigate(`/mint/${encodeURIComponent(m.url)}`) }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.online === true ? '#17E87F' : '#E24B4A', display: 'inline-block', flexShrink: 0 }} />
                <div className="nut-modal-row-info" style={{ flex: 1 }}>
                  <span className="nut-modal-row-name" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>{displayName(m)}</span>
                  {badge && (
                    <span className="nut-modal-row-badge" style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: badge.color, background: badge.bg, border: `1px solid ${badge.border}`, borderRadius: 4, padding: '1px 5px', marginLeft: 6 }}>{badge.label}</span>
                  )}
                </div>
                <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 700, color: scoreColor, flexShrink: 0 }}>
                  {score != null ? `${score}%` : '—'}
                </span>
              </div>
            )
          })}
        {!showAll && sorted.length > 10 && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); setShowAll(true) }}
            style={{ width: '100%', background: 'none', border: 'none', color: 'var(--accent)', fontSize: 12, fontFamily: 'var(--font-mono)', cursor: 'pointer', padding: '8px 0' }}
          >
            Show all {sorted.length} mints
          </button>
        )}
        {sorted.length === 0 && <div className="nut-modal-empty">No mints</div>}
      </div>
      <div className="nut-modal-footer" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>{onlineCount} online · {offlineCount} offline</span>
        <span>Sorted by Trust Score</span>
      </div>
    </>
  )
}

// Version-list level of SoftwareModal. Replaces the inline accordion that used
// to expand inside the Software in Use panel (which stretched the panel and
// left the neighbouring fixed-height panels with dead space). Same data the
// accordion showed — version, mint count, latest/outdated/old badge — restyled
// onto the .nut-modal-row/.sw-badge vocabulary the mint-list level already uses.
function SoftwareVersionsView({ sw, versions, total, accentColor, onSelectVersion }: {
  sw: string
  versions: SoftwareVersionEntry[]
  total: number
  accentColor: string
  onSelectVersion: (v: SoftwareVersionEntry) => void
}) {
  return (
    <>
      <div className="nut-modal-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span className="nut-modal-title">{sw}</span>
          <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text3)', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 5, padding: '2px 7px' }}>{versions.length} version{versions.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
      <div className="nut-modal-list">
        {versions.map(v => {
          const vPct = total > 0 ? Math.round(v.count / total * 100) : 0
          return (
            <div
              key={v.ver}
              className="nut-modal-row"
              style={{ cursor: 'pointer' }}
              onClick={() => onSelectVersion(v)}
            >
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text2)', flexShrink: 0, minWidth: 90 }}>{v.ver || '—'}</span>
              <div className="dist-track" style={{ flex: 1, height: 3 }}>
                <div className="dist-fill" style={{ width: `${vPct}%`, background: accentColor, opacity: 0.55 }} />
              </div>
              <span style={{ fontSize: 11, fontFamily: 'var(--font-mono-data)', color: 'var(--text2)', flexShrink: 0 }}>{v.count}</span>
              <span className="sw-badge" style={{ color: v.badgeColor, borderColor: v.badgeColor + '44', background: v.badgeColor + '11' }}>{v.badge}</span>
            </div>
          )
        })}
        {versions.length === 0 && <div className="nut-modal-empty">No versions</div>}
      </div>
      <div className="nut-modal-footer" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>{total} mint{total !== 1 ? 's' : ''} running {sw}</span>
        <span>Newest version first</span>
      </div>
    </>
  )
}

// Two-level drill-down modal: version list → mint list, sharing one overlay
// and one close button. Close (✕ / overlay click / Escape) always tears down
// the whole modal regardless of the level; only the mint-list level's "‹"
// steps back up, and it never closes the modal.
function SoftwareModal({ sw, versions, total, accentColor, allMints, onClose }: {
  sw: string
  versions: SoftwareVersionEntry[]
  total: number
  accentColor: string
  allMints: KnownMint[]
  onClose: () => void
}) {
  const [drilled, setDrilled] = useState<SoftwareVersionEntry | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const drilledMints = useMemo(
    () => drilled ? allMints.filter(m => m.version === drilled.fullVersion) : [],
    [drilled, allMints]
  )

  return (
    <div className="nut-modal-overlay" onClick={onClose}>
      <div className="nut-modal" onClick={e => e.stopPropagation()}>
        <button type="button" className="nut-modal-close" onClick={onClose}>✕</button>
        {drilled ? (
          <VersionMintsView
            key={drilled.fullVersion}
            sw={sw}
            ver={drilled.ver}
            mints={drilledMints}
            onBack={() => setDrilled(null)}
            onClose={onClose}
          />
        ) : (
          <SoftwareVersionsView
            sw={sw}
            versions={versions}
            total={total}
            accentColor={accentColor}
            onSelectVersion={setDrilled}
          />
        )}
      </div>
    </div>
  )
}

function CityMintsModal({ loc, mints, onClose }: {
  loc: string
  mints: KnownMint[]
  onClose: () => void
}) {
  const navigate = useNavigate()
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const sorted = useMemo(() =>
    [...mints].sort((a, b) => (b.trustScore ?? 0) - (a.trustScore ?? 0))
  , [mints])

  const { display, flag } = geoLabel(loc)
  const displayed = showAll ? sorted : sorted.slice(0, 10)
  const onlineCount = mints.filter(m => m.online === true).length
  const offlineCount = mints.filter(m => m.online === false).length

  return (
    <div className="nut-modal-overlay" onClick={onClose}>
      <div className="nut-modal" onClick={e => e.stopPropagation()}>
        <button type="button" className="nut-modal-close" onClick={onClose}>✕</button>
        <div className="nut-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            {flag && <span style={{ fontSize: 20 }}>{flag}</span>}
            <span className="nut-modal-title">{display}</span>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text3)', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 5, padding: '2px 7px' }}>{mints.length} mints</span>
          </div>
        </div>
        <div className="nut-modal-list">
          {displayed.map(m => {
            const score = m.trustScore ?? null
            const scoreColor = score != null ? (score >= 70 ? 'var(--green-bright)' : score >= 40 ? 'var(--amber)' : 'var(--red)') : 'var(--text3)'
            const badge = mintAgeBadge(m.discoveredAt ?? null)
            return (
              <div
                key={m.url}
                className="nut-modal-row"
                style={{ cursor: 'pointer' }}
                onClick={() => { onClose(); navigate(`/mint/${encodeURIComponent(m.url)}`) }}
              >
                <span
                  style={{ width: 8, height: 8, borderRadius: '50%', background: m.online === true ? 'var(--green-bright)' : 'var(--red)', display: 'inline-block', flexShrink: 0 }}
                />
                <div className="nut-modal-row-info" style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <span className="nut-modal-row-name">{displayName(m)}</span>
                  {badge && (
                    <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: badge.color, background: badge.bg, border: `1px solid ${badge.border}`, borderRadius: 4, padding: '1px 5px' }}>{badge.label}</span>
                  )}
                </div>
                <span style={{ fontSize: 12, fontFamily: 'var(--font-mono-data)', fontWeight: 700, color: scoreColor, flexShrink: 0 }}>
                  {score != null ? `${score}%` : '—'}
                </span>
              </div>
            )
          })}
          {!showAll && sorted.length > 10 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              style={{ width: '100%', background: 'none', border: 'none', color: 'var(--accent)', fontSize: 12, fontFamily: 'var(--font-mono)', cursor: 'pointer', padding: '8px 0' }}
            >
              Show all {sorted.length} mints
            </button>
          )}
          {sorted.length === 0 && <div className="nut-modal-empty">No mints</div>}
        </div>
        <div className="nut-modal-footer" style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>{onlineCount} online · {offlineCount} offline</span>
          <span>Sorted by Trust Score</span>
        </div>
      </div>
    </div>
  )
}

function MoreLocationsModal({ locations, onClose, onSelectLocation }: {
  locations: { loc: string; count: number; pct: number }[]
  onClose: () => void
  onSelectLocation: (loc: string) => void
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const total = locations.reduce((sum, l) => sum + l.count, 0)

  return (
    <div className="nut-modal-overlay" onClick={onClose}>
      <div className="nut-modal" onClick={e => e.stopPropagation()}>
        <button type="button" className="nut-modal-close" onClick={onClose}>✕</button>
        <div className="nut-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span className="nut-modal-title">Other locations</span>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text3)', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 5, padding: '2px 7px' }}>{locations.length} locations</span>
          </div>
        </div>
        <div className="nut-modal-list">
          {locations.map(({ loc, count }) => {
            const { display, flag, color: geoColor } = geoLabel(loc)
            return (
              <div
                key={loc}
                className="nut-modal-row"
                style={{ cursor: 'pointer' }}
                onClick={() => onSelectLocation(loc)}
              >
                <div className="nut-modal-row-info" style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <span className="nut-modal-row-name" style={geoColor ? { color: geoColor } : undefined}>
                    {flag ? `${flag} ${display}` : display}
                  </span>
                </div>
                <span style={{ fontSize: 12, fontFamily: 'var(--font-mono-data)', fontWeight: 700, color: 'var(--text2)', flexShrink: 0 }}>
                  {count}
                </span>
              </div>
            )
          })}
          {locations.length === 0 && <div className="nut-modal-empty">No locations</div>}
        </div>
        <div className="nut-modal-footer">
          <span>{total} mints across {locations.length} location{locations.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  )
}

interface NetworkHealthComponent { label: string; value: number; weight: number; tooltip: string }

// Single source of truth for rendering one Network Health Index breakdown row
// — used identically by NetworkHealthModal (mobile, in a floating overlay)
// and the inline desktop breakdown in Stats() below, so the two can never
// silently drift apart. `compact` shrinks spacing/type for the narrower
// desktop panel (span-1 grid column) without changing the modal's sizing.
function NetworkHealthComponentRow({ component: c, index, total, compact }: {
  component: NetworkHealthComponent
  index: number
  total: number
  compact?: boolean
}) {
  const tooltipRef = useRef<HTMLSpanElement>(null)
  const tooltip = useTapTooltip(tooltipRef)
  const points = Math.round(c.value * c.weight / 100)
  const color = trustColor(c.value)

  return (
    <div style={{ marginBottom: compact ? 8 : 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: compact ? 10.5 : 12, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
          <span style={{ color: 'var(--text3)', flexShrink: 0 }}>({c.weight}%)</span>
          <span
            ref={tooltipRef}
            style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}
            onPointerEnter={tooltip.onPointerEnter}
            onPointerLeave={tooltip.onPointerLeave}
            onClick={tooltip.onClick}
          >
            <Info size={compact ? 10 : 11} color="#6b7280" style={{ flexShrink: 0, cursor: 'help' }} />
            {tooltip.open && (
              <div
                className="audit-tooltip"
                style={index >= total - 2
                  ? { width: 220, left: '50%', transform: 'translateX(-50%)', top: 'auto', bottom: 'calc(100% + 6px)' }
                  : { width: 220, left: '50%', transform: 'translateX(-50%)', bottom: 'auto', top: 'calc(100% + 6px)' }}
              >{c.tooltip}</div>
            )}
          </span>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: compact ? 5 : 8, flexShrink: 0 }}>
          <span style={{ fontSize: compact ? 10 : 11, color: 'var(--text3)', fontFamily: 'var(--font-mono-data)' }}>{Math.round(c.value)}%</span>
          <span style={{ fontSize: compact ? 11.5 : 13, fontWeight: 600, color }}>{points}/{c.weight}</span>
        </div>
      </div>
      <div style={{ height: compact ? 3 : 4, background: 'var(--bg3)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, c.value))}%`, background: color, borderRadius: 2, transition: 'width 0.3s ease' }} />
      </div>
    </div>
  )
}

// Single source of truth for the formula explanation text — used by the
// modal's footer (NetworkHealthFormulaNote, unchanged) and appended to the
// desktop header's ⓘ tooltip (Stats() below, replacing the old always-visible
// inline footer under the desktop breakdown).
const NETWORK_HEALTH_FORMULA_TEXT =
  'Score = Online%×30 + Trust×25 + SW Diversity×15 + Advanced NUTs×15 + Stability×15. ' +
  'Network Stability (share of mints tracked 1 month+) stands in for churn rate — churn ' +
  'isn\'t reliably measurable yet, since mints are never marked "removed" in the database.'

// Shared formula/explanation footer — modal only now (desktop inline
// breakdown no longer renders this; see NETWORK_HEALTH_FORMULA_TEXT above).
function NetworkHealthFormulaNote({ compact }: { compact?: boolean }) {
  return (
    <div style={{ borderTop: '0.5px solid var(--border)', paddingTop: compact ? 8 : 10, marginTop: 2, fontSize: compact ? 9 : 10, color: 'var(--text3)', lineHeight: 1.5 }}>
      {NETWORK_HEALTH_FORMULA_TEXT}
    </div>
  )
}

function NetworkHealthModal({ score, components, onClose }: {
  score: number
  components: NetworkHealthComponent[]
  onClose: () => void
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const info = trustScoreInfo(score)
  const label = score >= 70 ? 'Healthy' : score >= 40 ? 'Moderate' : 'At Risk'

  return (
    <div className="nut-modal-overlay" onClick={onClose}>
      <div className="nut-modal" onClick={e => e.stopPropagation()} style={{ width: 420 }}>
        <button type="button" className="nut-modal-close" onClick={onClose}>✕</button>
        <div className="nut-modal-header">
          <span className="nut-modal-title">Network Health Index Breakdown</span>
        </div>
        <div style={{ textAlign: 'center', marginBottom: 4 }}>
          <div style={{ fontSize: 42, fontWeight: 700, color: info.color, lineHeight: 1, fontFamily: 'var(--font-mono-data)' }}>{score}</div>
          <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600, color: info.color, background: info.bg, border: `0.5px solid ${info.border}`, borderRadius: 5, padding: '2px 8px', display: 'inline-block', marginTop: 6 }}>
            {label}
          </span>
        </div>
        <div style={{ overflowY: 'auto' }}>
          {components.map((c, i) => (
            <NetworkHealthComponentRow key={c.label} component={c} index={i} total={components.length} />
          ))}
        </div>
        <NetworkHealthFormulaNote />
      </div>
    </div>
  )
}

function semverCmp(a: string, b: string): number {
  const parse = (s: string) => s.split('.').map(n => parseInt(n) || 0)
  const pa = parse(a), pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export default function Stats() {
  const navigate = useNavigate()
  const [modalNut, setModalNut] = useState<string | null>(null)
  const [cityModal, setCityModal] = useState<string | null>(null)
  const [showMoreLocations, setShowMoreLocations] = useState(false)
  const [softwareModal, setSoftwareModal] = useState<string | null>(null)
  const [reliableTab, setReliableTab] = useState<'reliable' | 'trust'>('reliable')
  const [moversPeriod, setMoversPeriod] = useState<'7d' | '30d'>('7d')
  const [trendDays, setTrendDays] = useState<30 | 90>(30)
  const [showHealthBreakdown, setShowHealthBreakdown] = useState(false)
  const nhiInfoRef = useRef<HTMLSpanElement>(null)
  const nhiInfoTooltip = useTapTooltip(nhiInfoRef)
  const uptimeInfoRef = useRef<HTMLSpanElement>(null)
  const uptimeInfoTooltip = useTapTooltip(uptimeInfoRef)
  // Same 768px breakpoint as the rest of the app's mobile/desktop split (see
  // useIsMobile.ts). Desktop shows the breakdown inline in the panel itself
  // (no reason to click through to a modal that would show the exact same
  // rows again); mobile keeps today's compact panel + tap-to-open modal.
  const isMobile = useIsMobile()

  const { data, isLoading, error } = useQuery({
    queryKey: ['stats'],
    queryFn: async (): Promise<StatsData> => {
      const res = await fetch('/api/stats')
      if (!res.ok) throw new Error('Failed to fetch stats')
      return res.json() as Promise<StatsData>
    },
    staleTime: 2 * 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
  })

  const { data: knownMintsData } = useKnownMints()

  const nutSupportingMints = useMemo(() => {
    if (!knownMintsData) return {} as Record<string, KnownMint[]>
    const NUT_KEYS = ['4','5','7','8','9','10','11','12','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29','30']
    const result: Record<string, KnownMint[]> = {}
    for (const key of NUT_KEYS) {
      const nutId = `NUT-${key.padStart(2, '0')}`
      result[nutId] = knownMintsData.filter(m => m.nutsLimits?.[key] != null)
    }
    return result
  }, [knownMintsData])

  const avgUptime24h = useMemo(() => {
    if (!knownMintsData || knownMintsData.length === 0) return null
    const total = knownMintsData.length
    const sum = knownMintsData.reduce((acc, m) => acc + (m.uptimePct24h ?? 0), 0)
    return Math.round(sum / total)
  }, [knownMintsData])

  // Back to top 5 (was briefly top 4, matching row-1 siblings before those
  // siblings got their own height fixes — see the row-1 height
  // investigation) — top 5 now lands close to Network Health Index's 319px.
  const top5ByUptime = useMemo(() => {
    if (!knownMintsData) return []
    return [...knownMintsData]
      .filter(m => m.online === true && m.uptimePct24h != null)
      .sort((a, b) => (b.uptimePct24h ?? 0) - (a.uptimePct24h ?? 0))
      .slice(0, 5)
  }, [knownMintsData])

  const top5ByTrust = useMemo(() => {
    if (!knownMintsData) return []
    return [...knownMintsData]
      .filter(m => m.online === true && m.trustScore != null)
      .sort((a, b) => (b.trustScore ?? 0) - (a.trustScore ?? 0))
      .slice(0, 5)
  }, [knownMintsData])

  // topN=10 (not the util's own default of 8) — closes most of the height
  // gap to Network Health Index (319px) in row 1 using real distinct
  // locations rather than an artificial cutoff; see the row-1 height
  // investigation. computeGeoDistribution's own default stays 8 for other
  // callers/tests — only this page's usage needs the taller panel.
  const geoDist = useMemo(() => computeGeoDistribution(knownMintsData ?? [], 10), [knownMintsData])

  const cityMints = useMemo(() => {
    if (!cityModal || !knownMintsData) return []
    return knownMintsData.filter(m => (m.serverLocation ?? 'Unknown') === cityModal)
  }, [cityModal, knownMintsData])

  interface TrustTrendResponse {
    trend: Array<{ date: string; avgTrust: number }>
    periodDays: number
    earliestCheckedAt: string | null
    daysOfDataAvailable: number
  }

  const { data: trendResponse } = useQuery({
    queryKey: ['stats-trust-trend', trendDays],
    queryFn: async (): Promise<TrustTrendResponse> => {
      const res = await fetch(`/api/stats/trust-trend?days=${trendDays}`)
      if (!res.ok) throw new Error('trust-trend fetch failed')
      return res.json() as Promise<TrustTrendResponse>
    },
    staleTime: 10 * 60 * 1000,
  })

  const trendData = trendResponse?.trend
  const trendCoverage = trendResponse && trendResponse.daysOfDataAvailable < trendResponse.periodDays
    ? `Showing ${trendResponse.daysOfDataAvailable} of ${trendResponse.periodDays} days of data (history retention started recently)`
    : null

  const trendSummary = useMemo(() => {
    if (!trendData || trendData.length === 0) return null
    const vals = trendData.map(d => d.avgTrust)
    const current = vals[vals.length - 1] ?? null
    const high90 = Math.max(...vals)
    const low90 = Math.min(...vals)
    return { current, high: high90, low: low90 }
  }, [trendData])

  interface TrustMover { url: string; name: string | null; delta: number }
  interface TrustMoversResponse { period: '7d' | '30d'; risers: TrustMover[]; fallers: TrustMover[] }

  const { data: moversData, isPending: moversPending, isFetching: moversFetching } = useQuery({
    queryKey: ['stats-trust-movers', moversPeriod],
    queryFn: async (): Promise<TrustMoversResponse> => {
      const res = await fetch(`/api/stats/trust-movers?period=${moversPeriod}`)
      if (!res.ok) throw new Error('trust-movers fetch failed')
      return res.json() as Promise<TrustMoversResponse>
    },
    staleTime: 60 * 1000,
    // Keep the previous period's rows on screen while the other period loads, so
    // toggling 7d↔30d dims the existing data instead of flashing a skeleton.
    placeholderData: keepPreviousData,
  })
  // isPending is true only with no data at all (first load); once keepPreviousData
  // has something to show it flips false and isFetching carries the refresh state.
  const moversLoading = moversPending
  const moversRefreshing = moversFetching && !moversPending

  const versionDist = useMemo(() => {
    if (!knownMintsData) return []
    const swMap = new Map<string, Map<string, number>>()
    for (const m of knownMintsData) {
      if (m.online !== true || !m.version) continue
      const slashIdx = m.version.indexOf('/')
      const sw = slashIdx >= 0 ? m.version.slice(0, slashIdx) : m.version
      const ver = slashIdx >= 0 ? m.version.slice(slashIdx + 1) : ''
      if (!swMap.has(sw)) swMap.set(sw, new Map())
      const vmap = swMap.get(sw)!
      vmap.set(ver, (vmap.get(ver) ?? 0) + 1)
    }
    return [...swMap.entries()]
      .sort((a, b) => {
        const sumA = [...a[1].values()].reduce((s, n) => s + n, 0)
        const sumB = [...b[1].values()].reduce((s, n) => s + n, 0)
        return sumB - sumA
      })
      .map(([sw, vmap], swIdx) => {
        const versions = [...vmap.entries()]
          .sort((a, b) => semverCmp(a[0], b[0]))
          .map(([ver, count], idx) => ({
            ver,
            count,
            fullVersion: ver ? `${sw}/${ver}` : sw,
            badge: idx === 0 ? 'latest' : idx === 1 ? 'outdated' : 'old',
            badgeColor: idx === 0 ? '#17E87F' : idx === 1 ? '#f59e0b' : '#E24B4A',
          }))
        const total = versions.reduce((s, v) => s + v.count, 0)
        const accentColor = swIdx % 2 === 0 ? 'var(--green)' : 'var(--copper)'
        return { sw, total, versions, accentColor }
      })
  }, [knownMintsData])

  const swFreshnessSummary = useMemo(() => {
    let total = 0
    let outdatedOrOld = 0
    for (const { versions } of versionDist) {
      for (const v of versions) {
        total += v.count
        if (v.badge !== 'latest') outdatedOrOld += v.count
      }
    }
    return { total, pct: total > 0 ? Math.round(outdatedOrOld / total * 100) : 0 }
  }, [versionDist])

  // Cashu Network Health Index: composite 0-100 score across 5 weighted
  // components. All inputs are already fetched by this page (no new backend
  // calls). "Network stability" (mint-age composition) stands in for churn
  // rate — see the commit message / task writeup for why churn rate itself
  // isn't reliably computable from current data.
  const networkHealth = useMemo(() => {
    if (!data || !knownMintsData || knownMintsData.length === 0) return null

    const onlinePct = data.totalMints > 0 ? data.onlineMints / data.totalMints * 100 : 0
    const avgTrust = data.avgTrustScore ?? 0

    const swTotal = versionDist.reduce((s, d) => s + d.total, 0)
    const hhi = swTotal > 0 ? versionDist.reduce((s, d) => s + (d.total / swTotal) ** 2, 0) : 1
    const diversity = swTotal > 0 ? (1 - hhi) * 100 : 0

    const advPercents = ADVANCED_NUT_KEYS.map(key =>
      data.nutAdoption.find(n => n.nut === `NUT-${key.padStart(2, '0')}`)?.percent ?? 0
    )
    const advancedAdoption = advPercents.reduce((s, p) => s + p, 0) / advPercents.length

    const notFresh = knownMintsData.filter(m => mintAgeBadge(m.discoveredAt)?.label !== 'Fresh').length
    const stability = notFresh / knownMintsData.length * 100

    const score = Math.round(
      onlinePct * 0.30 + avgTrust * 0.25 + diversity * 0.15 + advancedAdoption * 0.15 + stability * 0.15
    )

    // Matches NetworkHealthComponentRow's own points formula so the tooltip's
    // numbers can never drift from what the row actually displays.
    const onlinePts = Math.round(onlinePct * 30 / 100)

    return {
      score,
      components: [
        {
          label: 'Online mints',
          value: onlinePct,
          weight: 30,
          tooltip: `${onlinePts}/30 are NHI points (this row is 30% of the index), not ${onlinePts} mints online. Dashboard listed/online counts are a different set.`,
        },
        { label: 'Avg. Trust Score', value: avgTrust, weight: 25, tooltip: 'Average Trust Score across all currently online mints.' },
        { label: 'Software diversity', value: diversity, weight: 15, tooltip: 'How spread out mint software versions are across the network (Herfindahl-Hirschman based) — a network dominated by one version scores lower.' },
        { label: 'Advanced feature adoption', value: advancedAdoption, weight: 15, tooltip: 'Average adoption rate of optional, security/privacy-oriented NUTs (P2PK, DLEQ, HTLCs, WebSocket, auth, BOLT12, Nostr backup, Pay-to-BK, on-chain) beyond the baseline mint/melt/state-check/restore lifecycle.' },
        { label: 'Network stability', value: stability, weight: 15, tooltip: 'Share of mints that have been tracked for 1 month or more. Used as a stand-in for churn rate, since mints are never marked "removed" in the database so actual churn isn\'t reliably measurable yet.' },
      ],
    }
  }, [data, knownMintsData, versionDist])

  const healthLabel = (score: number): string => {
    if (score >= 70) return 'Healthy'
    if (score >= 40) return 'Moderate'
    return 'At Risk'
  }

  if (isLoading) return (
    <div className="stats-page">
      <div className="stats-header">
        <div className="stats-title">Statistics</div>
      </div>
      <div className="stats-loading">Loading…</div>
    </div>
  )

  if (error !== null && error !== undefined || !data) return (
    <div className="stats-page">
      <div className="stats-header">
        <div className="stats-title">Statistics</div>
      </div>
      <div className="stats-loading">Failed to load statistics</div>
    </div>
  )

  const nutAdoptionMap = Object.fromEntries(data.nutAdoption.map(n => [n.nut, n]))

  const modalNutMints = modalNut ? (nutSupportingMints[modalNut] ?? []) : []
  const modalNutMeta = modalNut ? NUT_META[modalNut] : null

  return (
    <div className="stats-page">
      {/* ── 5 flat stat boxes ── */}
      <div className="stats-metrics">
        <div className="stats-metric-card">
          <div className="smc-icon smc-gray">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1"/><rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1"/><rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1"/><rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1"/></svg>
          </div>
          <div>
            <div className="smc-label">Mints Tracked</div>
            <div className="smc-value">{data.totalMints}</div>
            <div className="smc-sub">all known</div>
          </div>
        </div>
        <div className="stats-metric-card">
          <div className="smc-icon smc-green">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1 11C3 8 5 7 8 7s5 1 7-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><path d="M3 14C5 11.5 6.5 10 8 10s3 1.5 5-1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><circle cx="8" cy="4" r="2" stroke="currentColor" strokeWidth="1.2"/></svg>
          </div>
          <div>
            <div className="smc-label">Online Now</div>
            <div className="smc-value">{data.onlineMints} / {data.totalMints}</div>
            <div className="smc-sub">of all known</div>
          </div>
        </div>
        <div className="stats-metric-card">
          <div className="smc-icon smc-orange">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3v5l3 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/><circle cx="8" cy="9" r="6" stroke="currentColor" strokeWidth="1.2"/><path d="M6 1.5h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
          </div>
          <div>
            <div className="smc-label smc-label-info">
              Avg mint uptime · 24h
              <span
                ref={uptimeInfoRef}
                style={{ position: 'relative', display: 'inline-flex' }}
                onPointerEnter={uptimeInfoTooltip.onPointerEnter}
                onPointerLeave={uptimeInfoTooltip.onPointerLeave}
                onClick={uptimeInfoTooltip.onClick}
              >
                <Info size={11} color="#6b7280" style={{ flexShrink: 0, cursor: 'help' }} />
                {uptimeInfoTooltip.open && (
                  <div className="audit-tooltip audit-tooltip-down" style={{ width: isMobile ? 200 : 240, left: 0 }}>
                    Average 24-hour uptime across all tracked mints (probed every 5 min). Mints offline 24h+ count as 0%.
                  </div>
                )}
              </span>
            </div>
            <div className="smc-value" style={{color: avgUptime24h != null ? uptimeColor(avgUptime24h) : undefined}}>
              {avgUptime24h != null ? `${avgUptime24h}%` : '—'}
            </div>
            <div className="smc-sub">across all known</div>
          </div>
        </div>
        <div className="stats-metric-card">
          <div className="smc-icon smc-orange">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.1"/><path d="M8 6v3.5l2 1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/><path d="M5.5 1h5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
          </div>
          <div>
            <div className="smc-label">Median Latency</div>
            <div className="smc-value">{data.avgLatency24h != null ? `${data.avgLatency24h} ms` : '—'}</div>
            <div className="smc-sub">from Frankfurt</div>
          </div>
        </div>
        <div className="stats-metric-card">
          <div className="smc-icon smc-green">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="10" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.1"/><rect x="2" y="6" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.1"/><rect x="2" y="2" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.1"/></svg>
          </div>
          <div>
            <div className="smc-label">NUTs in Spec</div>
            <div className="smc-value">{TRACKED_NUTS.length}</div>
          </div>
        </div>
      </div>

      {/* ── 3-column card grid ── */}
      <div className="stats-cards-grid">

        {/* Left block (cols 1-2): Software in Use + Geographic Distribution */}
        <div className="stats-left-col">

          {/* Card 1: Software in Use — the only row-1 panel with no natural
              way to grow closer to Network Health Index's 319px (only 4
              distinct software implementations actually exist among online
              mints today, no artificial cutoff to lift; see the row-1
              height investigation). Stretched via align-self:stretch +
              flex-fill, same mechanism as .stats-nhi-panel: the freshness
              bar + version list sit in a "top group" at the top, and the
              existing footnote is pinned to the panel's bottom edge by
              .stats-sw-fill's justify-content:space-between, filling
              whatever extra height align-self:stretch grants this panel
              instead of leaving it as dead space below the footnote. */}
          <div className="stats-panel stats-sw-panel">
            <div className="stats-panel-title">Software in Use</div>
            <div className="stats-sw-fill">
              <div>
                {swFreshnessSummary.total > 0 && (
                  <div>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:4}}>
                      <span style={{fontSize:12,color:'var(--text2)'}}>Running outdated or older versions</span>
                      <span style={{fontSize:13,fontWeight:swFreshnessSummary.pct >= 50 ? 700 : 600,color:'var(--amber)',fontFamily:'var(--font-mono-data)'}}>{swFreshnessSummary.pct}%</span>
                    </div>
                    <div className="dist-track"><div className="dist-fill" style={{width:`${swFreshnessSummary.pct}%`,background:'var(--amber)',opacity:swFreshnessSummary.pct >= 50 ? 0.9 : 0.6}} /></div>
                  </div>
                )}
                <div style={{marginTop:swFreshnessSummary.total > 0 ? 10 : 0,display:'flex',flexDirection:'column',gap:'var(--stats-row-gap)'}}>
                  {versionDist.length === 0 ? (
                    <div style={{color:'var(--text3)',fontSize:12,fontFamily:'var(--font-mono)'}}>No data</div>
                  ) : versionDist.map(({sw, total, accentColor}) => {
                    const totalOnline = versionDist.reduce((s, d) => s + d.total, 0)
                    const pct = totalOnline > 0 ? Math.round(total / totalOnline * 100) : 0
                    return (
                      <div
                        key={sw}
                        className="sw-row"
                        onClick={() => setSoftwareModal(sw)}
                      >
                        <span className="dist-label" style={{fontWeight:600,color:'var(--text)',fontSize:13}}>{sw}</span>
                        <div className="dist-track"><div className="dist-fill" style={{width:`${pct}%`,background:accentColor}} /></div>
                        <span className="dist-count" style={{color:'var(--text2)'}}>{total}</span>
                        <span className="sw-chevron" style={{color:'var(--text3)'}}>›</span>
                      </div>
                    )
                  })}
                </div>
              </div>
              {versionDist.length > 0 && (
                <div style={{fontSize:10,color:'var(--text3)',fontFamily:'var(--font-mono)',marginTop:8,lineHeight:1.5}}>
                  Implementation reported by each mint's info document.
                </div>
              )}
            </div>
          </div>

          {/* Card 2: Geographic Distribution */}
          <div className="stats-panel">
            <div className="stats-panel-title">Geographic Distribution</div>
            <div style={{marginTop:10,display:'flex',flexDirection:'column',gap:'var(--stats-row-gap)'}}>
              {geoDist.top.length === 0 ? (
                <div style={{color:'var(--text3)',fontSize:12,fontFamily:'var(--font-mono)'}}>No data</div>
              ) : geoDist.top.map(({loc, count, pct}, idx) => {
                const {display, flag, color: geoColor} = geoLabel(loc)
                const barColor = geoColor ?? (idx % 2 === 0 ? 'var(--green)' : 'var(--copper)')
                return (
                  <div key={loc} className="dist-row dist-row-clickable" onClick={() => setCityModal(loc)}>
                    <span className="dist-label dist-label-city" style={geoColor ? {color:geoColor} : undefined}>
                      {flag ? `${flag} ${display}` : display}
                    </span>
                    <div className="dist-track"><div className="dist-fill" style={{width:`${pct}%`,background:barColor}} /></div>
                    <span className="dist-count">{count}</span>
                  </div>
                )
              })}
            </div>
            {(geoDist.moreCount > 0 || (geoDist.unknownCount > 0 && !geoDist.unknownShownInTop)) && (
              <div style={{fontSize:10,color:'var(--text3)',fontFamily:'var(--font-mono)',marginTop:8,lineHeight:1.5}}>
                {geoDist.moreCount > 0 && (
                  <div className="dist-more-row" onClick={() => setShowMoreLocations(true)}>
                    View others →
                  </div>
                )}
                {geoDist.unknownCount > 0 && !geoDist.unknownShownInTop && (
                  <div className="dist-more-row" onClick={() => setCityModal('Unknown')}>
                    Geolocation unavailable: {geoDist.unknownCount} mint{geoDist.unknownCount === 1 ? '' : 's'} →
                  </div>
                )}
              </div>
            )}
          </div>

        </div>{/* /stats-left-col */}

        {/* Row 1, 3rd panel: Most Reliable — standalone now (used to be the
            first panel of a stacked .stats-right-col along with NHI/Trend;
            those two moved down into rows 2-3, see below). */}
        <div className="stats-panel">
          <div className="stats-card-header">
            <div className="stats-panel-title" style={{marginBottom:0}}>
              {reliableTab === 'reliable' ? 'Most Reliable · 24H' : 'Top Trust Score'}
            </div>
            <div className="stats-tab-toggle">
              <button type="button" className={`stats-tab-btn${reliableTab === 'reliable' ? ' active' : ''}`} onClick={() => setReliableTab('reliable')}>Reliable</button>
              <button type="button" className={`stats-tab-btn${reliableTab === 'trust' ? ' active' : ''}`} onClick={() => setReliableTab('trust')}>Trust</button>
            </div>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:'var(--stats-row-gap)',marginTop:10}}>
            {reliableTab === 'reliable' ? (
              top5ByUptime.length === 0 ? (
                <div style={{color:'var(--text3)',fontSize:12,fontFamily:'var(--font-mono)'}}>No data yet</div>
              ) : top5ByUptime.map((mint, idx) => {
                const uptime = mint.uptimePct24h ?? 0
                const color = uptimeColor(uptime)
                const hostname = getHostname(mint.url)
                return (
                  <div key={mint.url} onClick={() => navigate(`/mint/${encodeURIComponent(mint.url)}`)} className="stats-top5-row">
                    <span className="stats-top5-rank">#{idx+1}</span>
                    <MintFavicon url={mint.url} iconUrl={mint.iconUrl} size={22} />
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:500,color:'var(--text)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{displayName(mint)}</div>
                      <div style={{fontSize:10,color:'var(--text3)',fontFamily:'var(--font-mono)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{hostname}</div>
                    </div>
                    {isTestMint(mint.url) && (
                      <span style={{fontSize:9,fontFamily:'var(--font-mono)',color:'var(--amber)',background:'var(--amber-soft)',border:'1px solid var(--amber-soft-strong)',borderRadius:4,padding:'1px 5px',flexShrink:0}} title="Not for real funds — for testing and development only">🧪 Test</span>
                    )}
                    <span style={{fontSize:12,fontFamily:'var(--font-mono)',fontWeight:700,color,flexShrink:0}}>{uptime}%</span>
                  </div>
                )
              })
            ) : (
              top5ByTrust.length === 0 ? (
                <div style={{color:'var(--text3)',fontSize:12,fontFamily:'var(--font-mono)'}}>No data yet</div>
              ) : top5ByTrust.map((mint, idx) => {
                const score = mint.trustScore ?? 0
                const color = score >= 70 ? '#4ade80' : score >= 40 ? '#ffa500' : '#ff4d4d'
                const hostname = getHostname(mint.url)
                return (
                  <div key={mint.url} onClick={() => navigate(`/mint/${encodeURIComponent(mint.url)}`)} className="stats-top5-row">
                    <span className="stats-top5-rank">#{idx+1}</span>
                    <MintFavicon url={mint.url} iconUrl={mint.iconUrl} size={22} />
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:500,color:'var(--text)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{displayName(mint)}</div>
                      <div style={{fontSize:10,color:'var(--text3)',fontFamily:'var(--font-mono)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{hostname}</div>
                    </div>
                    {isTestMint(mint.url) && (
                      <span style={{fontSize:9,fontFamily:'var(--font-mono)',color:'var(--amber)',background:'var(--amber-soft)',border:'1px solid var(--amber-soft-strong)',borderRadius:4,padding:'1px 5px',flexShrink:0}} title="Not for real funds — for testing and development only">🧪 Test</span>
                    )}
                    <span style={{fontSize:12,fontFamily:'var(--font-mono)',fontWeight:700,color,flexShrink:0}}>{score}%</span>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Row 1, 4th panel: Network Health Index. Moved here from row 2 (was
            paired with NUT Coverage) — Trust Score Movers, which used to sit
            here, has a variable row count (2-6+, depending on how many
            mints moved this period) that stood out against this row's other
            three panels' comparatively stable heights. NHI's height is far
            more consistent (fixed gauge + fixed 5-row breakdown), a better
            fit for 4 equal-width columns. Swapped with Trust Score Movers
            below — see the comment on that panel's new spot in row 2. */}
        {networkHealth && (() => {
          const info = trustScoreInfo(networkHealth.score)
          const gaugeArc = trustDonutArc(networkHealth.score)
          return (
            <div className="stats-panel stats-nhi-panel">
              <div className="stats-card-header">
                <div className="stats-panel-title nhi-title-row" style={{ marginBottom: 0 }}>
                  Network Health Index
                  <span
                    ref={nhiInfoRef}
                    style={{ position: 'relative', display: 'inline-flex' }}
                    onPointerEnter={nhiInfoTooltip.onPointerEnter}
                    onPointerLeave={nhiInfoTooltip.onPointerLeave}
                    onClick={nhiInfoTooltip.onClick}
                  >
                    <Info size={11} color="#6b7280" style={{ flexShrink: 0, cursor: 'help' }} />
                    {nhiInfoTooltip.open && (
                      <div className="audit-tooltip" style={isMobile ? { width: 220, left: 0 } : { width: 260, right: 0 }}>
                        Composite 0-100 score across uptime, average Trust Score, software diversity, advanced feature adoption &amp; network stability. Each row below shows index points, not a mint count.{isMobile ? ' Tap the gauge for the full breakdown.' : ` ${NETWORK_HEALTH_FORMULA_TEXT}`}
                      </div>
                    )}
                  </span>
                </div>
                {isMobile && (
                  <button onClick={() => setShowHealthBreakdown(true)} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 10, cursor: 'pointer', fontFamily: 'var(--font-mono)', padding: 0 }}>Details ›</button>
                )}
              </div>
              {/* .nhi-fill is the flex:1 region below the header — at ≥1300px
                  this panel shares its grid row with three other panels
                  (Software in Use, Geographic Distribution, Most Reliable)
                  and stretches to match whichever is tallest (align-self:
                  stretch on .stats-nhi-panel, opting out of the grid's own
                  align-items:start just for this one panel), so there can be
                  real surplus height here to distribute. justify-content:
                  space-between pins the gauge/badge to the top and the
                  breakdown block to the bottom edge, putting any extra space
                  between them instead of leaving it all as dead space below
                  the breakdown. On mobile (no breakdown block, and nothing
                  stretches this panel taller than its own content) this is a
                  no-op — the gauge just sits at its natural position. */}
              <div className="nhi-fill">
                <div className="nhi-wrap" onClick={isMobile ? () => setShowHealthBreakdown(true) : undefined} style={isMobile ? undefined : { cursor: 'default' }}>
                  <div className="nhi-gauge-wrap" style={isMobile ? undefined : { width: 84, height: 84 }}>
                    <svg viewBox="0 0 72 72" style={isMobile ? undefined : { width: 84, height: 84 }}>
                      <circle cx="36" cy="36" r="27" fill="none" stroke="var(--bg4)" strokeWidth="7" />
                      <circle cx="36" cy="36" r="27" fill="none" stroke={info.color} strokeWidth="7"
                        strokeDasharray={gaugeArc.dashArray}
                        strokeDashoffset={gaugeArc.dashOffset}
                        strokeLinecap="round"
                        transform="rotate(-90 36 36)" />
                    </svg>
                    <div className="nhi-gauge-num" style={{ color: info.color, ...(isMobile ? {} : { fontSize: 20 }) }}>{networkHealth.score}</div>
                  </div>
                  <span className="nhi-badge" style={{ color: info.color, background: info.bg, border: `0.5px solid ${info.border}` }}>
                    {healthLabel(networkHealth.score)}
                  </span>
                </div>
                {/* Desktop only: same breakdown the mobile modal shows, inline
                    instead of behind a click. The formula footer is NOT
                    repeated here (moved to the header ⓘ tooltip, see
                    NETWORK_HEALTH_FORMULA_TEXT above) — the space it freed up
                    went to enlarging the gauge instead. */}
                {!isMobile && (
                  <div style={{ marginTop: 14 }}>
                    {networkHealth.components.map((c, i) => (
                      <NetworkHealthComponentRow key={c.label} component={c} index={i} total={networkHealth.components.length} compact />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })()}

        {/* Row 2, cols 1-3: NUT Coverage — span 3 so its 25 rows split into 3
            inner columns instead of 2 (shorter, less vertical scrolling) now
            that Trust Score Movers shares this row as a standalone
            1-column panel. DOM order matters here: this must come before
            Trust Score Movers below so CSS Grid's auto-placement fills row 2
            left-to-right (NUT Coverage cols 1-3, then Movers falls into the
            remaining col 4) instead of Movers grabbing col 1 first. */}
        <div className="stats-panel stats-nut-panel">
          <div className="stats-panel-title">NUT Coverage Across the Network</div>
          <div className="stats-section-sublabel" style={{marginBottom:10}}>Protocol adoption across {data.onlineMints} online mints · click any NUT to see supporting mints</div>
          <div className="stats-nut-rows-grid">
            {TRACKED_NUTS.map(nut => {
              const adoption = nutAdoptionMap[nut] ?? { count: 0, percent: 0 }
              const { count, percent } = adoption
              const meta = NUT_META[nut]
              if (!meta) return null
              const barColor = percent >= 80 ? '#17E87F' : percent >= 40 ? '#f59e0b' : '#E24B4A'
              return (
                <div key={nut} className="stats-nut-row" onClick={() => setModalNut(nut)}>
                  <span className="snr-nut-tag">{nut}</span>
                  <span className="snr-nut-name">{meta.short}</span>
                  <div className="snr-bar-track">
                    <div className="snr-bar-fill" style={{width:`${percent}%`,background:barColor}} />
                  </div>
                  <span className="snr-nut-count" style={{color:barColor}}>{count}/{data.onlineMints}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Row 2, col 4: Trust Score Movers. Moved here from row 1 (was the
            4th equal column alongside Software in Use/Geographic
            Distribution/Most Reliable) — its row count varies with how many
            mints actually moved this period (2 empty-state lines up to
            6+ rows across risers+fallers), which stood out against that
            row's other panels' comparatively stable heights. Here, next to
            the naturally taller NUT Coverage panel, a shorter/variable
            height reads as normal rather than as a mismatch — nothing else
            in row 2 is uniform height either (NUT Coverage's 25 rows vs. a
            single narrow column). Swapped with Network Health Index, which
            took this panel's old spot in row 1. */}
        <TrustMoversPanel
          period={moversPeriod}
          onPeriodChange={setMoversPeriod}
          data={moversData}
          loading={moversLoading}
          refreshing={moversRefreshing}
          onMintClick={url => navigate(`/mint/${encodeURIComponent(url)}`)}
          getDisplayName={m => displayName(m)}
          getIconUrl={m => knownMintsData?.find(km => km.url === m.url)?.iconUrl ?? null}
        />

        {/* Row 3, full width: Trust Score Trend. Chart height is unchanged
            (height:120 below, same as before) — only the panel's width grows,
            so the x-axis can fit more date labels instead of skipping most of
            them (interval="preserveStartEnd" already reacts to available
            width; it was never hardcoded to a fixed tick count). */}
        <div className="stats-panel stats-trend-panel">
          <div className="stats-card-header">
            <div className="stats-panel-title" style={{marginBottom:0}}>Trust Score Trend</div>
            <div className="stats-tab-toggle">
              <button type="button" className={`stats-tab-btn${trendDays === 30 ? ' active' : ''}`} onClick={() => setTrendDays(30)}>30d</button>
              <button type="button" className={`stats-tab-btn${trendDays === 90 ? ' active' : ''}`} onClick={() => setTrendDays(90)}>90d</button>
            </div>
          </div>
          <div style={{marginTop:'var(--stats-header-gap)',height:120}}>
            {(!trendData || trendData.length === 0) ? (
              <div style={{color:'var(--text3)',fontSize:12,fontFamily:'var(--font-mono)',paddingTop:30,textAlign:'center'}}>No data yet</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData} margin={{top:4,right:4,left:-28,bottom:0}}>
                  <defs>
                    <linearGradient id="trustGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#17E87F" stopOpacity={0.25}/>
                      <stop offset="95%" stopColor="#17E87F" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{fontSize:9,fill:'var(--text3)',fontFamily:'var(--font-mono)'}} tickFormatter={d => d.slice(5)} interval="preserveStartEnd" axisLine={false} tickLine={false} />
                  <YAxis domain={[0,100]} tick={{fontSize:9,fill:'var(--text3)',fontFamily:'var(--font-mono)'}} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:6,fontSize:11,fontFamily:'var(--font-mono)'}}
                    labelStyle={{color:'var(--text3)'}}
                    formatter={(v) => [`${v ?? '—'}%`, 'Avg Trust']}
                  />
                  <Area type="monotone" dataKey="avgTrust" stroke="#17E87F" strokeWidth={1.5} fill="url(#trustGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
          {trendSummary && (
            <div className="trend-summary-row">
              <span className="trend-summary-item"><span className="trend-summary-label">Current</span><span style={{color:'#17E87F',fontWeight:700}}>{trendSummary.current}%</span></span>
              <span className="trend-summary-sep">·</span>
              <span className="trend-summary-item"><span className="trend-summary-label">{trendDays}d High</span><span style={{color:'#4ade80'}}>{trendSummary.high}%</span></span>
              <span className="trend-summary-sep">·</span>
              <span className="trend-summary-item"><span className="trend-summary-label">{trendDays}d Low</span><span style={{color:'var(--text2)'}}>{trendSummary.low}%</span></span>
            </div>
          )}
          {trendCoverage && (
            <div style={{marginTop:6,fontSize:10,color:'var(--text3)',fontFamily:'var(--font-mono)'}}>{trendCoverage}</div>
          )}
        </div>
      </div>

      {modalNut !== null && modalNutMeta !== null && modalNutMeta !== undefined && (
        <NutMintsModal
          nutId={modalNut}
          nutMeta={modalNutMeta}
          mints={modalNutMints}
          onClose={() => setModalNut(null)}
        />
      )}
      {cityModal !== null && (
        <CityMintsModal
          loc={cityModal}
          mints={cityMints}
          onClose={() => setCityModal(null)}
        />
      )}
      {showMoreLocations && (
        <MoreLocationsModal
          locations={geoDist.more}
          onClose={() => setShowMoreLocations(false)}
          onSelectLocation={loc => { setShowMoreLocations(false); setCityModal(loc) }}
        />
      )}
      {softwareModal !== null && (() => {
        const entry = versionDist.find(d => d.sw === softwareModal)
        if (!entry) return null
        return (
          <SoftwareModal
            sw={entry.sw}
            versions={entry.versions}
            total={entry.total}
            accentColor={entry.accentColor}
            allMints={knownMintsData ?? []}
            onClose={() => setSoftwareModal(null)}
          />
        )
      })()}
      {showHealthBreakdown && networkHealth && (
        <NetworkHealthModal
          score={networkHealth.score}
          components={networkHealth.components}
          onClose={() => setShowHealthBreakdown(false)}
        />
      )}
    </div>
  )
}
