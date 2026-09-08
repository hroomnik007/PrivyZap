import { nip19 } from 'nostr-tools'
import { useParams, useNavigate } from 'react-router-dom'
import { useEffect, useState, useMemo, useRef, useCallback, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MintFavicon } from '@/components/mint/MintFavicon'
import {
  XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, LineChart, Line,
} from 'recharts'
import { useMintProbe } from '@/hooks/useMintProbe'
import { useMintHistory } from '@/hooks/useMintHistory'
import { useKnownMints } from '@/hooks/useKnownMints'
import { useMintReviews } from '@/hooks/useMintReviews'
import { usePendingAutoWatch } from '@/hooks/usePendingAutoWatch'
import { submitMintReview } from '@/hooks/useSubmitReview'
import { useWatchlistStore } from '@/stores/watchlist.store'
import { useAuthStore } from '@/stores/auth.store'
import { ComparisonModal } from '@/components/ComparisonModal'
import { MintComparePicker } from '@/components/MintComparePicker'
import { InfoTooltip } from '@/components/InfoTooltip'
import { mintAgeBadge, trustScoreColor, trustScoreInfo, formatTimeAgo, formatAuditErrorRatio, trustDonutArc, auditReliabilityColor, MIN_MEANINGFUL_REVIEWS } from '@/utils/mintFormatting'
import { TRACKED_NUTS } from '@/constants/nuts'
import { isTestMint } from '@/constants/testMints'
import { auditReliabilityScore, isAuditUnknown } from '@/utils/auditScore'
import { groupNutLimits, formatNutLimitRange } from '@/utils/nutLimits'
import {
  computeTrustScore as sharedComputeTrustScore,
  uptimeComponent, nutComponent, versionComponent, contactComponent,
} from '@/utils/trustScore'
import { useNow } from '@/hooks/useNow'
import { useTapTooltip } from '@/hooks/useTapTooltip'
import './MintDetail.css'
import {
  Copy, Check, Info, ShieldCheck, ShieldOff, ChevronDown, ChevronUp, AlertTriangle,
  Coins, Flame, SlidersHorizontal, RefreshCw, Lock, Key, Shield,
  Clock, GitBranch, Plug, Database, Award, Layers, Zap, Plus, X, QrCode,
  Receipt, UserCheck, EyeOff, CreditCard, Send, Code, Cloud,
  Fingerprint, Bitcoin, Star, Mail, AtSign,
} from 'lucide-react'

const REVIEW_AVATAR_COLORS = ['#17E87F','#8b5cf6','#F5A623','#3b82f6','#ef4444','#ec4899']
function reviewAvatarColor(pubkey: string): string {
  return REVIEW_AVATAR_COLORS[parseInt(pubkey.slice(0, 8), 16) % REVIEW_AVATAR_COLORS.length] ?? '#17E87F'
}
function shortNpub(npub: string): string {
  return npub.slice(0, 10) + '...' + npub.slice(-4)
}
// Short label for the "Signing with" row — mirrors AppShell's navbar profile
// METHOD_BADGE so the two read identically (Extension / nsec / Remote signer).
const METHOD_BADGE: Record<'nip07' | 'nsec' | 'remote-signer', string> = {
  nip07: 'Extension',
  nsec: 'nsec',
  'remote-signer': 'Remote signer',
}
// One-word gloss for each star value, shown next to the chosen rating ("5: works great").
const RATING_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'steer clear',
  2: 'rough',
  3: 'does the job',
  4: 'solid',
  5: 'works great',
}
function formatReviewDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}
/** A five-character ★/☆ string for a rating, rounded to whole stars. */
function starString(rating: number): string {
  const full = Math.max(0, Math.min(5, Math.round(rating)))
  return '★'.repeat(full) + '☆'.repeat(5 - full)
}
/** Page numbers to show in a pager, collapsing long runs to '…'. */
function reviewPageList(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const out: (number | '…')[] = [1]
  const start = Math.max(2, current - 1)
  const end = Math.min(total - 1, current + 1)
  if (start > 2) out.push('…')
  for (let i = start; i <= end; i++) out.push(i)
  if (end < total - 1) out.push('…')
  out.push(total)
  return out
}

// ⓘ next to the "Audit stats" heading — same hover/tap tooltip pattern as the
// per-metric icons (useTapTooltip + .audit-tooltip). Local component so its
// tooltip state doesn't leak into MintDetail, and so the identical icon can be
// dropped into both the desktop header and the mobile collapse toggle. Opens
// downward (top: 100%+6px) since the heading sits at the panel's top edge.
function AuditSourceInfoIcon({ align = 'left' }: { align?: 'left' | 'right' }) {
  const ref = useRef<HTMLSpanElement>(null)
  const tip = useTapTooltip(ref)
  // `align` decides which way the (downward) tooltip extends so it doesn't clip:
  // 'left' for the desktop heading (icon near the panel's left edge), 'right'
  // for the mobile collapse toggle (icon sits near the right edge).
  const anchor = align === 'right'
    ? { right: 0, left: 'auto' as const }
    : { left: 0, right: 'auto' as const }
  return (
    <span
      ref={ref}
      className="md-audit-info"
      style={{ position: 'relative', display: 'inline-flex' }}
      onPointerEnter={tip.onPointerEnter}
      onPointerLeave={tip.onPointerLeave}
      onClick={tip.onClick}
    >
      <Info size={11} color="#6b7280" style={{ cursor: 'help' }} />
      {tip.open && (
        <div
          className="audit-tooltip"
          style={{ width: 230, maxWidth: 'calc(100vw - 40px)', transform: 'none', bottom: 'auto', top: 'calc(100% + 6px)', ...anchor }}
        >
          These stats come from audit.8333.space, an independent service that repeatedly mints and melts real ecash through this mint — how many operations it ran, how many failed, and when it last checked.
        </div>
      )}
    </span>
  )
}

interface NutMethod {
  method: string
  unit: string
  min_amount?: number
  max_amount?: number
}

interface NutConfig {
  disabled?: boolean
  methods?: NutMethod[]
}

const NUT_DESCRIPTIONS: Record<string, { short: string; desc: string; features: string[]; useCase: string }> = {
  'NUT-00': { short: 'Notation & crypto', desc: 'Cryptographic notation and the blind Diffie-Hellman key exchange (BDHKE) scheme underlying every Cashu operation.', features: ['Blind signatures (BDHKE)', 'Protocol notation', 'hash_to_curve mapping'], useCase: 'Defines the cryptographic foundation every other NUT builds on.' },
  'NUT-01': { short: 'Mint keys', desc: 'Retrieving public keys from the mint for each amount.', features: ['Amount-specific keypairs', 'Key retrieval API', 'Key validation'], useCase: 'Clients use mint keys to verify token signatures.' },
  'NUT-02': { short: 'Keysets & fees', desc: 'Keysets (grouped mint public keys with rotation) and the per-input fee charged when spending a proof from them.', features: ['Keyset IDs', 'Active/inactive rotation', 'Per-input fees (input_fee_ppk)'], useCase: 'Allows mints to rotate keys, support multiple currencies, and charge spending fees.' },
  'NUT-03': { short: 'Swap', desc: 'Swapping proofs for new ones of equal value.', features: ['Proof exchange', 'Change splitting', 'Privacy improvement'], useCase: 'Core operation for splitting and combining tokens.' },
  'NUT-04': { short: 'Mint tokens', desc: 'Minting new Cashu tokens against a Lightning invoice.', features: ['Lightning invoice creation', 'Token issuance', 'Amount verification'], useCase: 'Entry point for getting Cashu tokens from Lightning.' },
  'NUT-05': { short: 'Melt tokens', desc: 'Melting Cashu tokens to pay a Lightning invoice.', features: ['Invoice payment', 'Fee estimation', 'Change return'], useCase: 'Exit point for spending Cashu tokens via Lightning.' },
  'NUT-06': { short: 'Mint info', desc: 'Retrieving mint metadata, capabilities and contact info.', features: ['Version info', 'Supported NUTs', 'Contact details', 'MOTD'], useCase: 'Clients discover mint capabilities before interacting.' },
  'NUT-07': { short: 'Token state', desc: 'Checking whether a proof has been spent or is still valid.', features: ['Spent proof detection', 'Pending state', 'Batch checking'], useCase: 'Verify token validity without redeeming it.' },
  'NUT-08': { short: 'Overpay melt', desc: 'Overpaying melt fees and receiving change back.', features: ['Fee overpayment', 'Change tokens', 'Fee estimation'], useCase: 'Handle variable Lightning routing fees gracefully.' },
  'NUT-09': { short: 'Restore', desc: 'Restoring blinded signatures from mint backup data.', features: ['Signature restoration', 'Backup validation', 'Deterministic secrets'], useCase: 'Recover tokens from backup without double-spend risk.' },
  'NUT-10': { short: 'Spending cond.', desc: 'Spending conditions that must be met to use a proof.', features: ['Conditional spending', 'Script conditions', 'Extensible'], useCase: 'Base for advanced features like P2PK and HTLCs.' },
  'NUT-11': { short: 'Pay-to-PK', desc: 'Lock tokens to a specific public key for secure transfers.', features: ['Public key locking', 'Signature verification', 'Selective unlock'], useCase: 'Send tokens that only a specific recipient can spend.' },
  'NUT-12': { short: 'DLEQ proofs', desc: 'Discrete Log Equality proofs for verifiable blind signatures.', features: ['Cryptographic proofs', 'Signature verification', 'Privacy preserving'], useCase: 'Clients verify mint honesty without revealing token data.' },
  'NUT-14': { short: 'HTLCs', desc: 'Hash Time Locked Contracts for atomic swaps.', features: ['Hash preimage', 'Timelock expiry', 'Atomic swaps'], useCase: 'Enable trustless cross-mint or cross-chain swaps.' },
  'NUT-15': { short: 'Multi-mint MPP', desc: 'Split a single Lightning payment across multiple mints simultaneously, so wallets can pay one invoice using balances from several mints at once.', features: ['Multi-mint payments', 'Amount splitting', 'Atomic all-or-nothing'], useCase: 'Pay a large invoice by combining balances from multiple mints in one atomic payment.' },
  'NUT-16': { short: 'Animated QR', desc: 'Animated QR codes for transferring large tokens between devices.', features: ['Chunked QR frames', 'Large token transfer', 'Offline transfer'], useCase: 'Move big tokens between devices when no network is available.' },
  'NUT-17': { short: 'WebSocket', desc: 'Real-time mint updates via WebSocket subscription.', features: ['Live updates', 'Event subscription', 'Low latency'], useCase: 'Receive instant confirmation without polling.' },
  'NUT-18': { short: 'Payment req.', desc: 'Structured payment requests so wallets can pay a requested amount.', features: ['Structured requests', 'Amount + mint hints', 'Wallet interop'], useCase: 'Let a payee encode exactly what they want to be paid.' },
  'NUT-19': { short: 'Cached responses', desc: 'Mints cache successful responses for critical operations so wallets can replay after a network error.', features: ['Response caching', 'Network recovery', 'Idempotent replay'], useCase: 'Prevents loss of funds when a network interruption occurs during mint/swap/melt.' },
  'NUT-20': { short: 'Mint quote sig', desc: 'Mint signs quote requests for authenticity.', features: ['Quote signatures', 'Request authentication', 'Replay protection'], useCase: 'Prevent quote tampering between client and mint.' },
  'NUT-21': { short: 'Clear auth', desc: 'Clear-text (OAuth/OpenID) authentication for protected mint endpoints.', features: ['OAuth / OpenID', 'Access tokens', 'Protected endpoints'], useCase: 'Restrict mint access to authenticated users.' },
  'NUT-22': { short: 'Blind auth', desc: 'Blind authentication tokens for privacy-preserving mint access.', features: ['Blind auth tokens', 'Unlinkable access', 'Rate limiting'], useCase: 'Authenticate to a mint without revealing your identity.' },
  'NUT-23': { short: 'BOLT11', desc: 'BOLT11 Lightning invoices as a payment method for mint and melt.', features: ['Lightning invoices', 'Mint & melt method', 'Standard payments'], useCase: 'Fund and spend tokens via ordinary Lightning invoices.' },
  'NUT-24': { short: 'HTTP 402', desc: 'HTTP 402 Payment Required flow for paywalled resources using Cashu.', features: ['402 paywall flow', 'Machine payments', 'Resource access'], useCase: 'Pay for web resources programmatically with Cashu tokens.' },
  'NUT-25': { short: 'BOLT12', desc: 'BOLT12 offers as a payment method for mint and melt.', features: ['BOLT12 offers', 'Reusable payment codes', 'Mint & melt method'], useCase: 'Use reusable Lightning offers instead of single-use invoices.' },
  'NUT-26': { short: 'Bech32m req.', desc: 'Bech32m encoding for Cashu payment requests.', features: ['Bech32m encoding', 'Compact requests', 'Error detection'], useCase: 'Share payment requests as short, typo-resistant strings.' },
  'NUT-27': { short: 'Nostr backup', desc: 'Backing up wallet state to Nostr relays for cross-device recovery.', features: ['Nostr relay backup', 'Cross-device sync', 'Encrypted state'], useCase: 'Restore a wallet from Nostr on a new device.' },
  'NUT-28': { short: 'Pay-to-BK', desc: 'Lock tokens to a blinded public key for enhanced recipient privacy.', features: ['Blinded key lock', 'Recipient privacy', 'Selective unlock'], useCase: 'Send tokens to a recipient without exposing their public key.' },
  'NUT-29': { short: 'Batched minting', desc: 'Wallets can mint tokens for multiple quotes in a single atomic request.', features: ['Multi-quote batch', 'Atomic operation', 'Efficiency'], useCase: 'Reduces round-trips when minting from multiple paid invoices at once.' },
  'NUT-30': { short: 'Onchain', desc: 'On-chain Bitcoin as a payment method for mint and melt.', features: ['On-chain Bitcoin', 'Mint & melt method', 'Chain settlement'], useCase: 'Fund or redeem tokens directly with on-chain Bitcoin.' },
}

const NUT_ICONS: Record<string, JSX.Element> = {
  'NUT-04': <Coins size={13} />,
  'NUT-05': <Flame size={13} />,
  'NUT-07': <Info size={13} />,
  'NUT-08': <SlidersHorizontal size={13} />,
  'NUT-09': <RefreshCw size={13} />,
  'NUT-10': <Lock size={13} />,
  'NUT-11': <Key size={13} />,
  'NUT-12': <Shield size={13} />,
  'NUT-14': <Clock size={13} />,
  'NUT-15': <GitBranch size={13} />,
  'NUT-16': <QrCode size={13} />,
  'NUT-17': <Plug size={13} />,
  'NUT-18': <Receipt size={13} />,
  'NUT-19': <Database size={13} />,
  'NUT-20': <Award size={13} />,
  'NUT-21': <UserCheck size={13} />,
  'NUT-22': <EyeOff size={13} />,
  'NUT-23': <Zap size={13} />,
  'NUT-24': <CreditCard size={13} />,
  'NUT-25': <Send size={13} />,
  'NUT-26': <Code size={13} />,
  'NUT-27': <Cloud size={13} />,
  'NUT-28': <Fingerprint size={13} />,
  'NUT-29': <Layers size={13} />,
  'NUT-30': <Bitcoin size={13} />,
}

function uptimeColor(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return 'var(--text3)'
  if (pct >= 80) return '#4ade80'
  if (pct >= 50) return '#ffa500'
  return '#ff4d4d'
}


function parseMinorVer(v: string | null | undefined): number {
  if (!v) return 0
  const m = v.match(/\d+\.(\d+)/)
  return m ? parseInt(m[1] ?? '0', 10) : 0
}

function contactCountOf(email?: string, twitter?: string, nostr?: string): number {
  return [email, twitter, nostr].filter(Boolean).length
}

// Thin adapter over the shared computation so the call sites can keep passing the
// three contact fields they already have. Only ever used as a fallback — the
// server-side score in KnownMint.trustScore wins whenever it exists.
function computeTrustScore(
  uptimePct: number,
  nutCount: number,
  versionStr: string | null | undefined,
  email?: string,
  twitter?: string,
  nostr?: string,
  auditRecentTotal?: number | null,
  auditRecentErrors?: number | null,
): number {
  return sharedComputeTrustScore(
    uptimePct,
    nutCount,
    versionStr ?? null,
    contactCountOf(email, twitter, nostr),
    auditRecentTotal ?? null,
    auditRecentErrors ?? null,
  )
}

// Must match backend/src/index.ts's NOSTR_REVIEWS_CACHE_TTL — that endpoint's
// cache is only as fresh as this value lets the frontend re-ask for it, so a
// staleTime longer than the backend TTL silently defeats a backend-side
// shortening (this happened once already: backend TTL was cut from 10min to
// 2min while this stayed at 10min, so nothing changed for users). No shared
// workspace between the two packages (same caveat as NOSTR_REVIEWS_RELAYS in
// CLAUDE.md's "Reviews Feature" section) — keep both in sync by hand.
const NOSTR_REVIEWS_STALE_TIME_MS = 2 * 60 * 1000 // 2 minutes

const WARNING_KEYWORDS = ['rug', 'shutdown', 'warning', 'beware', 'risk', 'danger', 'caution', 'maintenance']
function isWarningMotd(text: string): boolean {
  const lower = text.toLowerCase()
  return WARNING_KEYWORDS.some(kw => lower.includes(kw))
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

const HTTP_ERROR_EXPLANATIONS: Record<string, string> = {
  '400': "The mint's info endpoint rejected the request as malformed — likely a misconfiguration on the mint's side",
  '401': "The mint's info endpoint unexpectedly requires authentication — likely a misconfiguration, NUT-06 should be public",
  '403': "The mint's info endpoint is blocking this request — may be a firewall/WAF rule or IP block",
  '404': "Mint's info endpoint returned 404 — it may not implement NUT-06, or the URL has changed",
  '429': 'The mint is rate-limiting requests',
  '500': "The mint's server hit an internal error while handling the request",
  '502': "The mint's server is unreachable — the application behind the proxy may have crashed or restarted",
  '503': "The mint's server is temporarily unavailable — likely under maintenance or overloaded",
  '504': "The mint's server took too long to respond — likely overloaded or misconfigured",
}

const NON_HTTP_ERROR_EXPLANATIONS: Record<string, string> = {
  'Invalid JSON response': "The mint returned a response that isn't valid JSON — its info endpoint may be misconfigured",
  'Invalid Cashu response': "The mint's info endpoint responded, but the body is missing the expected `nuts` field — it may not be a valid Cashu mint",
  'DNS resolution failed': "The mint's domain name could not be resolved — it may no longer exist or its DNS is misconfigured",
  'Connection timeout': "The mint didn't respond in time — its server may be overloaded or unreachable",
  'Connection refused': "The mint's server actively refused the connection — it may be down or blocking this request",
  'TLS/SSL error': "The mint's HTTPS certificate could not be verified — it may be expired, invalid, or misconfigured",
  'Unreachable': 'The mint could not be reached — the server may be down or the network path is blocked',
}

function httpErrorTooltip(lastError: string): string | undefined {
  const m = lastError.match(/^HTTP (\d+)$/)
  if (m && m[1]) return HTTP_ERROR_EXPLANATIONS[m[1]] ?? `The mint returned HTTP ${m[1]} — an unexpected error status`
  return NON_HTTP_ERROR_EXPLANATIONS[lastError]
}

function MintDetailContent({ url }: { url: string }) {
  const navigate = useNavigate()
  const now = useNow()
  const { data, isLoading } = useMintProbe(url)
  useMintHistory(url)
  const { data: knownMintsData } = useKnownMints()
  const knownMint = knownMintsData?.find(m => m.url === url) ?? null
  const [chartInterval, setChartInterval] = useState<'24h' | '7d' | '30d' | '90d'>('7d')
  const [chartMetric, setChartMetric] = useState<'latency' | 'uptime' | 'trust'>('latency')
  const { data: chartHistoryData } = useQuery({
    queryKey: ['mint', 'chart-history', url, chartInterval],
    queryFn: async () => {
      const res = await fetch(`/api/mints/history?url=${encodeURIComponent(url)}&period=${chartInterval}`)
      if (!res.ok) throw new Error('Failed to fetch chart history')
      return res.json() as Promise<{
        period: string
        segments: Array<{ bucket: string; online: boolean; latencyMs: number | null; total: number; onlineCount: number; uptimePct: number | null; trustScore: number | null }>
        uptimePct: number | null
        avgLatencyMs: number | null
        prevUptimePct: number | null
        prevAvgLatencyMs: number | null
        earliestCheckedAt: string | null
        daysOfDataAvailable: number
        periodDays: number
        prevPeriodInsufficientHistory: boolean
      }>
    },
    staleTime: 5 * 60 * 1000,
  })
  // Dedicated 24h query for the header — shares TanStack cache with historyData when historyPeriod='24h'
  const { data: uptime24hData } = useQuery({
    queryKey: ['mint', 'history-api', url, '24h'],
    queryFn: async () => {
      const res = await fetch(`/api/mints/history?url=${encodeURIComponent(url)}&period=24h`)
      if (!res.ok) throw new Error('Failed to fetch history')
      return res.json() as Promise<{
        period: string
        segments: Array<{ bucket: string; online: boolean; latencyMs: number | null; total: number; onlineCount: number; uptimePct: number | null; trustScore: number | null }>
        uptimePct: number | null
        avgLatencyMs: number | null
        prevUptimePct: number | null
        prevAvgLatencyMs: number | null
        history: Array<{ online: boolean; latencyMs: number | null; checkedAt: string }>
      }>
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  })
  const { data: versionHistoryData } = useQuery({
    queryKey: ['mint', 'version-history', url],
    queryFn: async () => {
      const res = await fetch(`/api/mints/version-history?url=${encodeURIComponent(url)}`)
      if (!res.ok) throw new Error('Failed to fetch version history')
      return await res.json() as { history: Array<{ version: string; firstSeenAt: string }>; latestGlobalVersion: string | null }
    },
    staleTime: 10 * 60 * 1000,
  })
  const versionHistory = versionHistoryData?.history
  const latestGlobalVersion = versionHistoryData?.latestGlobalVersion ?? null
  const watchlistMints = useWatchlistStore(state => state.mints)
  const addMint = useWatchlistStore(state => state.addMint)
  const removeMint = useWatchlistStore(state => state.removeMint)
  const loadFromDb = useWatchlistStore(state => state.loadFromDb)
  const profile = useAuthStore(state => state.profile)
  const authMethod = useAuthStore(state => state.method)
  const isLoggedIn = profile !== null

  // "+ Watch" while logged out opens a modal instead of a silent no-op/redirect.
  // The pending "auto-add after login" intent lives in usePendingAutoWatch, which
  // pins it to this mint URL + time so a route-param change, an unmount, or a
  // much-later unrelated login can't make it add the wrong mint (2026-09-07 audit, L7).
  const [showWatchLoginModal, setShowWatchLoginModal] = useState(false)
  const autoWatch = useCallback((u: string) => {
    if (!useWatchlistStore.getState().mints.includes(u)) void addMint(u)
  }, [addMint])
  const { arm: armAutoWatch, disarm: disarmAutoWatch } = usePendingAutoWatch(url, isLoggedIn, autoWatch)
  const closeWatchLoginModal = useCallback(() => {
    setShowWatchLoginModal(false)
    disarmAutoWatch() // (c) explicit Cancel / Escape / overlay / × — the user backed out.
  }, [setShowWatchLoginModal, disarmAutoWatch])
  const confirmWatchLogin = useCallback(() => {
    armAutoWatch()
    setShowWatchLoginModal(false)
    window.dispatchEvent(new CustomEvent('mintradar:open-login'))
  }, [armAutoWatch])
  useEffect(() => {
    if (!showWatchLoginModal) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeWatchLoginModal() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [showWatchLoginModal, closeWatchLoginModal])

  const { reviews, loading: reviewsLoading } = useMintReviews(url)
  const { data: nostrReviewsData } = useQuery({
    queryKey: ['mint', 'nostr-reviews', url],
    queryFn: async () => {
      try {
        const res = await fetch(`/api/mints/nostr-reviews?url=${encodeURIComponent(url)}`)
        if (!res.ok) return []
        return res.json() as Promise<Array<{ id: string; pubkey: string; content: string; rating: number | null; createdAt: number; source: 'nostr' }>>
      } catch {
        return []
      }
    },
    staleTime: NOSTR_REVIEWS_STALE_TIME_MS,
    retry: false,
  })
  // Deliberate two-mechanism review fetch, not redundant duplication: `reviews`
  // (useMintReviews, live client-side via sharedPool) is the PRIMARY source — it's
  // what lets a user see their own review immediately after submitting one (see
  // useSubmitReview.ts), since it re-fetches on every visit with no cache.
  // `nostrReviewsData` (GET /api/mints/nostr-reviews, backend-cached) is a
  // fallback/secondary source: a second, independent network vantage point (the
  // server may reach relays the user's own connection can't, or vice versa).
  // Only reviews the live fetch missed are added in (`nostrOnly` below) — never
  // shown twice. Do not remove either side without re-confirming with the
  // maintainer first.
  const mergedReviews = useMemo(() => {
    const mintradarIds = new Set(reviews.map(r => r.id))
    const nostrOnly = (nostrReviewsData ?? [])
      .filter(r => !mintradarIds.has(r.id))
    const all: Array<{ id: string; pubkey: string; rating: number | null; comment: string; createdAt: number; source: 'mintradar' | 'nostr'; profile?: { name?: string; picture?: string } }> = [
      ...reviews.map(r => ({ ...r, source: 'mintradar' as const })),
      ...nostrOnly.map(r => ({ id: r.id, pubkey: r.pubkey, rating: r.rating, comment: r.content, createdAt: r.createdAt, source: 'nostr' as const })),
    ]
    return all.sort((a, b) => b.createdAt - a.createdAt)
  }, [reviews, nostrReviewsData])
  const [selectedNut, setSelectedNut] = useState<string | null>(null)
  const [copiedContact, setCopiedContact] = useState<string | null>(null)
  const [copiedUrl, setCopiedUrl] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const [showTrustBreakdown, setShowTrustBreakdown] = useState(false)
  const [showReviewModal, setShowReviewModal] = useState(false)
  const [reviewsPageState, setReviewsPageState] = useState<{ key: string; page: number }>({ key: '', page: 1 })
  const [reviewFilterState, setReviewFilterState] = useState<{ key: string; type: 'all' | '5star' | 'critical' }>({ key: '', type: 'all' })
  const [reviewHideAnonState, setReviewHideAnonState] = useState<{ key: string; on: boolean }>({ key: '', on: false })
  // 0 = phase 1 (rating not chosen yet); 1-5 = phase 2 (form revealed).
  const [reviewRating, setReviewRating] = useState(0)
  const [reviewHoverRating, setReviewHoverRating] = useState(0)
  const [reviewComment, setReviewComment] = useState('')
  const [reviewSubmitting, setReviewSubmitting] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewSuccess, setReviewSuccess] = useState(false)
  const [clientLatency, setClientLatency] = useState<number | string | null>(null)
  const [testingLatency, setTestingLatency] = useState(false)
  const errorBadgeRef = useRef<HTMLSpanElement>(null)
  const errorBadgeTooltip = useTapTooltip(errorBadgeRef)
  const backupBadgeRef = useRef<HTMLSpanElement>(null)
  const backupBadgeTooltip = useTapTooltip(backupBadgeRef)
  const latencyInfoRef = useRef<HTMLSpanElement>(null)
  const latencyInfoTooltip = useTapTooltip(latencyInfoRef)
  const clientLatencyInfoRef = useRef<HTMLSpanElement>(null)
  const clientLatencyInfoTooltip = useTapTooltip(clientLatencyInfoRef)
  const auditMintsRef = useRef<HTMLSpanElement>(null)
  const auditMintsTooltip = useTapTooltip(auditMintsRef)
  const auditMeltsRef = useRef<HTMLSpanElement>(null)
  const auditMeltsTooltip = useTapTooltip(auditMeltsRef)
  const auditErrorsRef = useRef<HTMLSpanElement>(null)
  const auditErrorsTooltip = useTapTooltip(auditErrorsRef)
  const auditRecentRef = useRef<HTMLSpanElement>(null)
  const auditRecentTooltip = useTapTooltip(auditRecentRef)
  const breakdownUptimeRef = useRef<HTMLSpanElement>(null)
  const breakdownUptimeTooltip = useTapTooltip(breakdownUptimeRef)
  const breakdownNutRef = useRef<HTMLSpanElement>(null)
  const breakdownNutTooltip = useTapTooltip(breakdownNutRef)
  const breakdownVersionRef = useRef<HTMLSpanElement>(null)
  const breakdownVersionTooltip = useTapTooltip(breakdownVersionRef)
  const breakdownContactRef = useRef<HTMLSpanElement>(null)
  const breakdownContactTooltip = useTapTooltip(breakdownContactRef)
  const breakdownAuditRef = useRef<HTMLSpanElement>(null)
  const breakdownAuditTooltip = useTapTooltip(breakdownAuditRef)
  const [activeTab, setActiveTab] = useState<'overview' | 'history' | 'nuts' | 'audit' | 'reviews'>('overview')
  const [auditExpanded, setAuditExpanded] = useState(true)
  const [showComparePicker, setShowComparePicker] = useState(false)
  const [compareSelectedUrls, setCompareSelectedUrls] = useState<Set<string>>(new Set())
  const [showComparisonModal, setShowComparisonModal] = useState(false)

  async function testClientLatency() {
    // `url` is the /mint/:url route param (decodeURIComponent'd) — not
    // guaranteed to be a real mint. Validate before firing a request straight
    // from the visitor's browser, the same way core/mint/api.ts validates a
    // probe URL (https:// scheme + length cap). (2026-09-07 audit, L6.)
    if (!url.startsWith('https://') || url.length > 500) {
      setClientLatency('Invalid mint URL')
      return
    }
    setTestingLatency(true)
    setClientLatency(null)
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), 5000)
    const t0 = performance.now()
    try {
      const res = await fetch(url.replace(/\/$/, '') + '/v1/info', { cache: 'no-store', credentials: 'omit', signal: ctrl.signal })
      clearTimeout(timeout)
      if (res.ok) {
        setClientLatency(Math.round(performance.now() - t0))
      } else {
        setClientLatency(`Unreachable (HTTP ${res.status})`)
      }
    } catch {
      clearTimeout(timeout)
      setClientLatency('Unreachable from your location')
    } finally {
      setTestingLatency(false)
    }
  }

  useEffect(() => { void loadFromDb() }, [loadFromDb])

  useEffect(() => {
    if (!selectedNut) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedNut(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedNut])

  // Single close path (overlay / × / Cancel / Escape / post-success) — resets
  // every field so the modal always reopens in phase 1. Same pattern as
  // AppShell's closeLoginModal; deliberately NOT an effect.
  const closeReviewModal = useCallback(() => {
    setShowReviewModal(false)
    setReviewRating(0)
    setReviewHoverRating(0)
    setReviewComment('')
    setReviewError(null)
    setReviewSuccess(false)
  }, [])

  useEffect(() => {
    if (!showReviewModal) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeReviewModal() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [showReviewModal, closeReviewModal])

  useEffect(() => {
    if (!showQr) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowQr(false) }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [showQr])

  useEffect(() => {
    if (!showTrustBreakdown) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowTrustBreakdown(false) }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [showTrustBreakdown])

  useEffect(() => {
    if (!showComparePicker) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowComparePicker(false) }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [showComparePicker])

  const histLineData = useMemo(() => {
    const segs = chartHistoryData?.segments ?? []
    const nutCount = knownMint?.nutCount ?? 0
    const versionStr = knownMint?.version ?? data?.info?.version ?? null
    const auditRecentTotal = knownMint?.auditRecentTotal ?? null
    const auditRecentErrors = knownMint?.auditRecentErrors ?? null
    const emailVal = data?.info?.contact?.find((c: { method: string }) => c.method === 'email')?.info
    const twitterVal = data?.info?.contact?.find((c: { method: string }) => c.method === 'twitter')?.info
    const nostrVal = data?.info?.contact?.find((c: { method: string }) => c.method === 'nostr')?.info
    function bucketLabel(bucket: string): string {
      const d = new Date(bucket)
      if (chartInterval === '24h') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
    }
    function makePoint(seg: typeof segs[0] | null, label: string) {
      if (!seg) return { label, latency: null as number | null, uptime: null as number | null, trust: null as number | null }
      const trustVal = seg.trustScore !== null && seg.trustScore !== undefined
        ? seg.trustScore
        : seg.uptimePct !== null
          ? computeTrustScore(seg.uptimePct, nutCount, versionStr, emailVal, twitterVal, nostrVal, auditRecentTotal, auditRecentErrors)
          : null
      return { label, latency: seg.latencyMs, uptime: seg.uptimePct, trust: trustVal }
    }
    // For empty data or 90d (weekly buckets), use segments as-is
    if (segs.length === 0 || chartInterval === '90d') {
      return segs.map(seg => makePoint(seg, bucketLabel(seg.bucket)))
    }
    // Generate full expected time slots so sparse data maps to correct X positions
    const isHourly = chartInterval === '24h'
    const slotCount = chartInterval === '24h' ? 24 : chartInterval === '7d' ? 7 : 30
    const bucketMs = isHourly ? 3_600_000 : 86_400_000
    const currentBucketMs = Math.floor(now / bucketMs) * bucketMs
    const keyLen = isHourly ? 13 : 10
    const segMap = new Map(segs.map(s => [s.bucket.slice(0, keyLen), s]))
    return Array.from({ length: slotCount }, (_, i) => {
      const slotMs = currentBucketMs - (slotCount - 1 - i) * bucketMs
      const iso = new Date(slotMs).toISOString()
      return makePoint(segMap.get(iso.slice(0, keyLen)) ?? null, bucketLabel(iso))
    })
  }, [chartHistoryData?.segments, chartInterval, knownMint, data?.info?.version, data?.info?.contact, now])

  // Render as soon as EITHER source is ready: the cached mints-known list
  // (near-instant — already fetched by Dashboard in the common flow) or the
  // live probe. Previously this blocked on the live probe alone, so an
  // offline/unresponsive mint showed nothing but the Back button for as
  // long as the probe took to time out (up to ~10-20s+). Header/stat
  // tiles/Overview now render from `knownMint` immediately; fields that
  // only the live probe has (MOTD, description, pubkey, contact, alt URLs)
  // appear once `data` resolves, with `probeLoading` available to show a
  // loading state for just those pieces.
  if (knownMintsData === undefined && data === undefined) {
    return (
      <div className="mint-detail">
        <div className="md-header">
          <button className="md-back" onClick={() => navigate(-1)}>← Back</button>
        </div>
      </div>
    )
  }

  const probeLoading = isLoading || data === undefined

  const hostname = (() => { try { return new URL(url).hostname } catch { return url } })()
  const displayName = data?.info?.name ?? knownMint?.name ?? hostname
  const isOnline = data?.online ?? knownMint?.online ?? false
  const latency = knownMint?.latencyMs ?? null
  const version = data?.info?.version ?? knownMint?.version ?? undefined
  const nutCount = data?.info ? Object.keys(data.info.nuts).length : (knownMint?.nutCount ?? 0)
  const motd = data?.info?.motd
  const description = data?.info?.description
  const pubkey = data?.info?.pubkey
  const name = data?.info?.name

  const tosUrl = data?.info?.tos_url ?? knownMint?.tosUrl ?? undefined
  const descriptionLong = data?.info?.description_long ?? knownMint?.descriptionLong ?? undefined
  const mintTime = data?.info?.time

  const email = data?.info?.contact?.find(c => c.method === 'email')?.info
  const twitter = data?.info?.contact?.find(c => c.method === 'twitter')?.info
  const nostr = data?.info?.contact?.find(c => c.method === 'nostr')?.info
  const urls = data?.info?.urls

  const uptimePct = uptime24hData?.uptimePct ?? 0

  // Header "Uptime 24H" — always sourced from server API (same 24h window as Mint History panel)
  const headerUptimePct = uptime24hData?.uptimePct ?? null
  const headerOnlineChecks = (uptime24hData?.segments ?? []).reduce((s, r) => s + r.onlineCount, 0)
  const headerTotalChecks = (uptime24hData?.segments ?? []).reduce((s, r) => s + r.total, 0)

  // NUT-04 (minting) and NUT-05 (melting) disabled detection
  const nut4Disabled = (() => {
    const raw = data?.info?.nuts?.['4'] ?? knownMint?.nutsLimits?.['4']
    return raw !== null && raw !== undefined && typeof raw === 'object' && (raw as NutConfig).disabled === true
  })()
  const nut5Disabled = (() => {
    const raw = data?.info?.nuts?.['5'] ?? knownMint?.nutsLimits?.['5']
    return raw !== null && raw !== undefined && typeof raw === 'object' && (raw as NutConfig).disabled === true
  })()

  const discoveredAt = knownMint?.discoveredAt ?? null

  const isWatching = watchlistMints.includes(url)
  const toggleWatch = () => { void (isWatching ? removeMint(url) : addMint(url)) }

  const supportedNutNumbers = new Set(
    data?.info ? Object.keys(data.info.nuts) : Object.keys(knownMint?.nutsLimits ?? {})
  )
  const supportedNuts = TRACKED_NUTS.filter(nut =>
    supportedNutNumbers.has(String(parseInt(nut.slice(4), 10)))
  )
  // NUT-13 (deterministic secrets) is wallet-side only — mints never advertise
  // it in /v1/info (confirmed against live Nutshell mints and the cashubtc/nuts
  // spec, which lists no mint implementations for NUT-13 at all). The mint-side
  // capability that actually gates seed-phrase backup/restore is NUT-09
  // (restore signatures) — check that instead.
  const supportsBackupRestore = supportedNutNumbers.has('9')

  const trustScore = knownMint?.trustScore ?? computeTrustScore(uptimePct, supportedNuts.length, version, email, twitter, nostr, knownMint?.auditRecentTotal ?? null, knownMint?.auditRecentErrors ?? null)
  const tsInfo = trustScoreInfo(trustScore)
  const trustDonut = trustDonutArc(trustScore)

  // Trust Score Breakdown modal rows — hoisted out of the modal's JSX (was a
  // nested IIFE) because the react-compiler ESLint rules disallow reading a
  // ref from inside a hand-rolled nested function during render.
  const breakdownUScore = uptimeComponent(uptimePct)
  const breakdownNScore = nutComponent(supportedNuts.length)
  const breakdownVScore = versionComponent(version)
  const breakdownContactFields = [email, twitter, nostr].filter(Boolean)
  const breakdownCScore = contactComponent(breakdownContactFields.length)
  const breakdownContactDisplay = breakdownContactFields.length === 0 ? 'None' : (email ? 'Email' : '') + (twitter ? (email ? ' + Twitter' : 'Twitter') : '') + (nostr ? ((email || twitter) ? ' + Nostr' : 'Nostr') : '')
  const breakdownAuditRecentTotal = knownMint?.auditRecentTotal ?? null
  const breakdownAuditRecentErrors = knownMint?.auditRecentErrors ?? null
  const breakdownAScore = auditReliabilityScore(breakdownAuditRecentTotal, breakdownAuditRecentErrors)
  const breakdownAuditDisplay = breakdownAuditRecentTotal === null
    ? '—'
    : isAuditUnknown(breakdownAuditRecentTotal)
      ? 'Unknown'
      : `${((breakdownAuditRecentErrors ?? 0) / breakdownAuditRecentTotal * 100).toFixed(1)}% err`
  // Audit summary strip's "Recent errors" cell — same rolling window
  // (audit_recent_total / audit_recent_errors, up to AUDIT_SWAPS_WINDOW = 100
  // swaps) that feeds the Trust Score's Audit reliability component. Reuses the
  // exact values above (breakdownAuditRecent*). Colour comes from
  // auditReliabilityColor() (error-rate based: <=5% green/25% amber/else red) —
  // NOT from breakdownAScore's 1-5 scoring buckets, which are stricter than
  // what reads as "OK" at a glance (see mintFormatting.ts). This only changes
  // the displayed colour; the Trust Score's numeric Audit component
  // (breakdownAScore) is unaffected.
  const recentReliabilityErrors = breakdownAuditRecentErrors ?? 0
  const recentReliabilityColor = auditReliabilityColor(breakdownAuditRecentTotal, breakdownAuditRecentErrors)
  const trustBreakdownRows = [
    { label: 'Uptime (45%)', display: `${uptimePct}%`, score: breakdownUScore, max: 45, color: uptimeColor(uptimePct), tooltip: 'Percentage of successful checks over the last 24h. 100% uptime = full points.', tooltipRef: breakdownUptimeRef, tooltipHook: breakdownUptimeTooltip },
    { label: 'NUT Support (30%)', display: `${supportedNuts.length} / ${TRACKED_NUTS.length} NUTs`, score: breakdownNScore, max: 30, color: supportedNuts.length >= 12 ? '#4ade80' : supportedNuts.length >= 8 ? '#ffa500' : '#ff4d4d', tooltip: 'Number of NUT specifications (cashu protocol features) this mint supports out of all tracked NUTs.', tooltipRef: breakdownNutRef, tooltipHook: breakdownNutTooltip },
    { label: 'Version (15%)', display: version ?? 'Unknown', score: breakdownVScore, max: 15, color: breakdownVScore >= 12 ? '#4ade80' : breakdownVScore >= 6 ? '#ffa500' : '#ff4d4d', tooltip: "How recent the mint's software version is compared to the latest known Nutshell releases. Newer = higher score.", tooltipRef: breakdownVersionRef, tooltipHook: breakdownVersionTooltip },
    { label: 'Contact (5%)', display: breakdownContactDisplay, score: breakdownCScore, max: 5, color: breakdownCScore >= 4 ? '#4ade80' : breakdownCScore >= 2 ? '#ffa500' : '#ff4d4d', tooltip: 'Number of contact methods provided (email, Twitter, Nostr). More contact options = higher score.', tooltipRef: breakdownContactRef, tooltipHook: breakdownContactTooltip },
    { label: 'Audit reliability (5%)', display: breakdownAuditDisplay, score: breakdownAScore, max: 5, color: recentReliabilityColor, tooltip: "Based on error rate from audit.8333.space — the percentage of failed swaps out of the mint's last ~100 tested operations. Lower error rate = higher score. Shows \"Unknown\" when fewer than 3 recent swaps are available.", tooltipRef: breakdownAuditRef, tooltipHook: breakdownAuditTooltip },
  ]
  const ageBadge = mintAgeBadge(discoveredAt)
  const isOutdated = version !== null && latestGlobalVersion !== null
    && (parseMinorVer(latestGlobalVersion) - parseMinorVer(version)) > 2

  // audit.8333.space lifetime counters (display-only "Audit stats" panel) — the
  // rolling-window figures that feed Trust Score are auditRecent* / breakdownAudit* above.
  const auditNMints = knownMint?.auditNMints ?? 0
  const auditNMelts = knownMint?.auditNMelts ?? 0
  const auditNErrors = knownMint?.auditNErrors ?? 0
  const auditTotalOps = auditNMints + auditNMelts + auditNErrors
  const auditErrorPct = auditTotalOps > 0 ? (auditNErrors / auditTotalOps) * 100 : null

  // ── Audit summary strip (top of the Audit tab) — a 5-second overview.
  // Mints / Melts are audit.8333.space lifetime counters; Recent errors is the
  // rolling ~100-swap window (same numbers as the Recent reliability card and the
  // Trust Score's Audit component); Last checked is OUR 6h cron's write time
  // (auditSyncedAt), NOT auditCheckedAt (that's the auditor's own clock).
  const auditSyncedAt = knownMint?.auditSyncedAt ?? null
  const auditLastCheckedDisplay = formatTimeAgo(auditSyncedAt ? new Date(auditSyncedAt) : null)
  const stripRecentErrorsDisplay = formatAuditErrorRatio(breakdownAuditRecentTotal, breakdownAuditRecentErrors)
  const stripRecentErrorsSub = breakdownAuditRecentTotal === null
    ? 'no recent swaps'
    : isAuditUnknown(breakdownAuditRecentTotal)
      ? 'too few to score'
      : `${Math.round((1 - recentReliabilityErrors / breakdownAuditRecentTotal) * 100)}% ok`

  // Average rating is computed only over events that actually carry a numeric
  // rating — rating-less endorsement events are counted in the review total but
  // never contribute to (or dilute) the star average.
  const ratedReviews = mergedReviews.filter(r => r.rating !== null)
  const avgRating = ratedReviews.length > 0
    ? Math.round(ratedReviews.reduce((s, r) => s + (r.rating as number), 0) / ratedReviews.length * 10) / 10
    : null

  // Community-rating stat tile: while the live client-side review fetch
  // (useMintReviews) is still running, show the server-side rollup instead
  // (knownMint.reviewCount / reviewAvgRating, kept fresh by the backend's 6h
  // reviews sync) — that's real data available immediately, rather than the
  // wrong "No reviews yet" the empty live array used to flash for ~4s. Once the
  // live fetch resolves its count/rating take over (they'd include a review the
  // user just published, which the rollup wouldn't have yet). `null` on both
  // sides (rollup not yet computed AND live fetch pending) renders a skeleton.
  const tileReviewCount = reviewsLoading ? (knownMint?.reviewCount ?? null) : mergedReviews.length
  const tileAvgRating = reviewsLoading ? (knownMint?.reviewAvgRating ?? null) : avgRating

  // Reviews-tab filter chips. "all" / "5star" / "critical" are mutually exclusive
  // (one active at a time); "hideAnon" is an independent toggle combined on top of
  // whichever exclusive filter is active. Both are keyed by mint URL, same pattern
  // as reviewsPageState, so switching mints resets them without a reset effect.
  const activeReviewFilter = reviewFilterState.key === url ? reviewFilterState.type : 'all'
  const hideAnonActive = reviewHideAnonState.key === url && reviewHideAnonState.on
  // The All/5★/Critical chip counts must match what "Hide anon" actually leaves in
  // the list below — when it's on, count from the anon-filtered set, not the full
  // mergedReviews, or the chip numbers would disagree with what the user sees.
  const reviewCountBase = hideAnonActive ? mergedReviews.filter(r => !!r.profile?.name) : mergedReviews
  const reviewFilterFiveStarCount = reviewCountBase.filter(r => r.rating === 5).length
  // Critical excludes rating === null explicitly — a rating-less endorsement event
  // is not a bad review, and JS's `null <= 2` (coerces null to 0) would otherwise
  // wrongly include it here.
  const reviewFilterCriticalCount = reviewCountBase.filter(r => r.rating !== null && r.rating <= 2).length
  const reviewFilterAnonCount = mergedReviews.filter(r => !r.profile?.name).length
  let filteredReviews = mergedReviews
  if (activeReviewFilter === '5star') filteredReviews = filteredReviews.filter(r => r.rating === 5)
  else if (activeReviewFilter === 'critical') filteredReviews = filteredReviews.filter(r => r.rating !== null && r.rating <= 2)
  if (hideAnonActive) filteredReviews = filteredReviews.filter(r => !!r.profile?.name)
  const setReviewFilter = (type: 'all' | '5star' | 'critical') => {
    setReviewFilterState({ key: url, type })
    setReviewsPageState({ key: url, page: 1 })
  }
  const toggleReviewHideAnon = () => {
    setReviewHideAnonState({ key: url, on: !hideAnonActive })
    setReviewsPageState({ key: url, page: 1 })
  }

  // Numbered pagination for the Reviews tab, applied to the filtered list. Page is
  // keyed by mint URL so it resets to 1 when navigating to a different mint (no
  // reset effect needed); changing a filter above also resets it to 1.
  const REVIEWS_PER_PAGE = 5
  const reviewsTotalPages = Math.max(1, Math.ceil(filteredReviews.length / REVIEWS_PER_PAGE))
  const reviewsPage = Math.min(
    reviewsPageState.key === url ? reviewsPageState.page : 1,
    reviewsTotalPages,
  )
  const pagedReviews = filteredReviews.slice((reviewsPage - 1) * REVIEWS_PER_PAGE, reviewsPage * REVIEWS_PER_PAGE)
  const goToReviewsPage = (p: number) => setReviewsPageState({ key: url, page: Math.max(1, Math.min(p, reviewsTotalPages)) })

  const chartAvgLatency = chartHistoryData?.avgLatencyMs ?? null
  const chartPrevLatency = chartHistoryData?.prevAvgLatencyMs ?? null
  const chartAvgUptime = chartHistoryData?.uptimePct ?? null
  const chartPrevUptime = chartHistoryData?.prevUptimePct ?? null
  const chartPrevInsufficientHistory = chartHistoryData?.prevPeriodInsufficientHistory ?? false
  const chartCoverage = chartHistoryData && chartHistoryData.daysOfDataAvailable < chartHistoryData.periodDays
    ? `Showing ${chartHistoryData.daysOfDataAvailable} of ${chartHistoryData.periodDays} days of data (history retention started recently)`
    : null

  function deltaStr(curr: number | null, prev: number | null, unit = '', insufficientHistory = false): string | null {
    if (prev === null) return (curr !== null && insufficientHistory) ? 'Not enough history yet' : null
    if (curr === null) return null
    const diff = curr - prev
    return `${diff >= 0 ? '+' : ''}${diff.toFixed(0)}${unit} vs prev period`
  }

  return (
    <div className="mint-detail">
      <div className="md-header">
        <div className="md-hdr-left">
          <button className="md-back" onClick={() => navigate(-1)}><span className="md-back-arrow">←</span><span className="md-back-label">Back</span></button>
          <div className="md-avatar-id">
            <MintFavicon url={url} iconUrl={data?.info?.icon_url ?? null} size={52} radius={12} className="md-hdr-favicon" />
            <div className="md-namebox">
              <div className="md-name" style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                <span>{displayName}</span>
                <span className={`md-status-inline ${isOnline ? '' : 'offline'}`}>
                  <span className={`status-dot ${isOnline ? '' : 'offline'}`} />
                  <span>{isOnline ? 'Online' : 'Offline'}</span>
                </span>
                {ageBadge && (
                  <span className="md-age-badge-inline" style={{fontSize:12,fontFamily:'var(--font-mono)',fontWeight:600,color:ageBadge.color,background:ageBadge.bg,border:`0.5px solid ${ageBadge.border}`,borderRadius:5,padding:'3px 9px',flexShrink:0}}>{ageBadge.label}</span>
                )}
                {isTestMint(url) && (
                  <span style={{fontSize:12,fontFamily:'var(--font-mono)',fontWeight:600,color:'var(--amber)',background:'var(--amber-soft)',border:'0.5px solid var(--amber-soft-strong)',borderRadius:5,padding:'3px 9px',flexShrink:0}} title="Not for real funds — for testing and development only">
                    🧪 Test mint
                  </span>
                )}
              </div>
              <button
                type="button"
                className={`md-url md-url-copy ${copiedLink ? 'copied' : ''}`}
                onClick={() => {
                  void navigator.clipboard.writeText(window.location.href)
                  setCopiedLink(true)
                  setTimeout(() => setCopiedLink(false), 2000)
                }}
                title="Copy a direct link to this mint"
              >
                <span>{url}</span>
                {copiedLink ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </div>
          </div>
        </div>
        <div className="md-hdr-center">
          {!isOnline && knownMint?.lastError && (
            <span className="md-hdr-error" style={{display:'inline-flex',alignItems:'center',gap:4}}>
              <span
                className="md-error-badge"
                style={{fontSize:11,color:'#ff4d4d',fontFamily:'var(--font-mono)',background:'rgba(255,77,77,0.08)',border:'0.5px solid rgba(255,77,77,0.25)',borderRadius:5,padding:'2px 7px',whiteSpace:'nowrap'}}
              >
                {knownMint.lastError}
              </span>
              <span
                ref={errorBadgeRef}
                style={{position:'relative',display:'inline-flex'}}
                onPointerEnter={errorBadgeTooltip.onPointerEnter}
                onPointerLeave={errorBadgeTooltip.onPointerLeave}
                onClick={errorBadgeTooltip.onClick}
              >
                <Info size={11} color="#6b7280" style={{cursor:'help'}} />
                {errorBadgeTooltip.open && httpErrorTooltip(knownMint.lastError) && (
                  <div className="audit-tooltip" style={{width:200,left:'50%',transform:'translateX(-50%)',bottom:'auto',top:'calc(100% + 6px)'}}>
                    {httpErrorTooltip(knownMint.lastError)}
                  </div>
                )}
              </span>
            </span>
          )}
          <button className="md-quick-btn" onClick={() => setShowQr(true)}>
            <QrCode size={12} /> Mint QR
          </button>
          <a
            className="md-quick-btn"
            href={`https://wallet.cashu.me/?mint=${encodeURIComponent(url)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span aria-hidden="true">↗</span>
            <span className="md-qb-full">Open in Cashu.me</span>
            <span className="md-qb-short">Cashu.me</span>
          </a>
        </div>
        <div className="md-hdr-right">
          {isLoggedIn
            ? (
              <button className={`md-watch-btn ${isWatching ? 'watching' : ''}`} onClick={toggleWatch}>
                {isWatching ? <><X size={12} /><span>Unwatch</span></> : <><Plus size={11} /><span>Watch</span></>}
              </button>
            ) : (
              <button
                className="md-watch-btn"
                onClick={() => setShowWatchLoginModal(true)}
                title="Login with Nostr to add to watchlist"
              >
                <Plus size={11} /><span>Watch</span>
              </button>
            )
          }
          <button
            className="md-compare-btn"
            onClick={() => setShowComparePicker(true)}
          >
            ⇆ Compare
          </button>
        </div>
      </div>

      <div className="md-summary">
        <div className="md-sc">
          <div className="md-sc-icon orange"><Clock size={14} /></div>
          <div style={{flex:1}}>
            <div className="md-sc-label" style={{display:'flex',alignItems:'center',gap:4}}>
              Latency
              <span
                ref={latencyInfoRef}
                style={{position:'relative',display:'inline-flex'}}
                onPointerEnter={latencyInfoTooltip.onPointerEnter}
                onPointerLeave={latencyInfoTooltip.onPointerLeave}
                onClick={latencyInfoTooltip.onClick}
              >
                <Info size={11} color="#6b7280" style={{cursor:'help'}} />
                {latencyInfoTooltip.open && (
                  <div className="audit-tooltip" style={{width:200}}>
                    Measured from our server in Frankfurt, DE. Click &quot;Test&quot; for your local latency.
                  </div>
                )}
              </span>
            </div>
            <div className="md-sc-value">{latency !== null ? `${latency} ms` : '—'}</div>
            <div className="md-sc-sub">
              <span>server · Frankfurt</span>
              <span style={{display:'inline-flex',alignItems:'center',gap:4}}>
                <button
                  onClick={() => { void testClientLatency() }}
                  disabled={testingLatency}
                  className="latency-test-btn"
                >
                  {testingLatency && <span className="latency-spinner" />}
                  Show my latency
                </button>
                <span
                  ref={clientLatencyInfoRef}
                  style={{position:'relative',display:'inline-flex'}}
                  onPointerEnter={clientLatencyInfoTooltip.onPointerEnter}
                  onPointerLeave={clientLatencyInfoTooltip.onPointerLeave}
                  onClick={clientLatencyInfoTooltip.onClick}
                >
                  <Info size={11} color="#6b7280" style={{cursor:'help'}} />
                  {clientLatencyInfoTooltip.open && (
                    <div className="audit-tooltip" style={{width:200}}>
                      Your latency from this browser to the mint (client-side measurement).
                    </div>
                  )}
                </span>
              </span>
            </div>
            {clientLatency !== null && (
              <div style={{fontSize:10,marginTop:4,fontFamily:'var(--font-mono)',color: typeof clientLatency === 'number' ? 'var(--text)' : 'var(--text3)'}}>
                {typeof clientLatency === 'number' ? `Your latency: ${clientLatency}ms` : clientLatency}
              </div>
            )}
          </div>
        </div>
        <div className="md-sc">
          <div className="md-sc-icon orange"><Shield size={14} /></div>
          <div style={{flex:1}}>
            <div className="md-sc-label">Uptime 24h</div>
            <div className="md-sc-value" style={{color: uptimeColor(headerUptimePct)}}>{headerUptimePct !== null ? `${headerUptimePct}%` : '—'}</div>
            <div className="md-sc-sub">{headerTotalChecks === 1 ? `${headerOnlineChecks} check` : `${headerOnlineChecks} / ${headerTotalChecks} checks`}</div>
          </div>
        </div>
        <div className="md-sc">
          <div className="md-sc-icon gray"><GitBranch size={14} /></div>
          <div style={{flex:1}}>
            <div className="md-sc-label">Version</div>
            <div className="md-sc-value sm" style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
              <span>{version ?? '—'}</span>
              {isOutdated && (
                <span style={{fontSize:9,fontFamily:'var(--font-mono)',fontWeight:600,color:'#ff4d4d',background:'rgba(255,77,77,0.1)',border:'0.5px solid rgba(255,77,77,0.3)',borderRadius:4,padding:'1px 5px'}}>Outdated</span>
              )}
            </div>
            <div className="md-sc-sub">software</div>
          </div>
        </div>
        <div className="md-sc">
          <div className="md-sc-icon green"><Layers size={14} /></div>
          <div style={{flex:1}}>
            <div className="md-sc-label">NUTs</div>
            <div className="md-sc-value green">{nutCount}</div>
            <div className="md-sc-sub">supported</div>
          </div>
        </div>
        <div className="md-sc">
          <div className="md-sc-icon orange"><Star size={14} /></div>
          <div style={{flex:1}}>
            <div className="md-sc-label" style={{display:'flex',alignItems:'center',gap:4}}>
              Community rating
              <InfoTooltip
                className="community-rating-info"
                width={210}
                iconSize={11}
                text="Ratings come from self-published Nostr reviews (NIP-87). Anyone can create a new key, so a score can be artificially inflated — treat it as a directional signal, not proof."
              />
              {knownMint?.reviewSurge && (
                <InfoTooltip
                  className="review-surge-flag"
                  tone="warn"
                  width={210}
                  iconSize={11}
                  label="Recent review surge"
                  text="This mint's review count grew unusually fast recently — worth a closer look before trusting the rating."
                />
              )}
            </div>
            {tileReviewCount === null ? (
              <div className="md-sc-value sm" style={{color:'var(--text-faint)'}} aria-label="Loading reviews">…</div>
            ) : tileReviewCount === 0 ? (
              <div className="md-sc-value sm" style={{color:'var(--text-faint)'}}>No reviews yet</div>
            ) : (
              <>
                {tileAvgRating !== null ? (
                  <div
                    className="md-sc-value"
                    style={{display:'flex',alignItems:'baseline',gap:6,opacity: tileReviewCount < MIN_MEANINGFUL_REVIEWS ? 0.6 : 1}}
                  >
                    <span className="md-sc-stars" aria-label={`${tileAvgRating} out of 5`}>{starString(tileAvgRating)}</span>
                    <span style={{color:'var(--text2)'}}>{tileAvgRating}</span>
                  </div>
                ) : (
                  <div className="md-sc-value sm" style={{color:'var(--text-faint)'}}>Unrated</div>
                )}
                <div className="md-sc-sub">
                  {tileReviewCount} review{tileReviewCount !== 1 ? 's' : ''}
                  {tileReviewCount < MIN_MEANINGFUL_REVIEWS ? ' · too few to be reliable' : ''}
                </div>
              </>
            )}
          </div>
        </div>
        {/* Compact Trust Score — mobile only (≤640px). Fills the empty cell next
            to Community rating; the full breakdown card in .md-right is hidden
            on mobile since its Uptime/NUTs/Latency rows duplicate the tiles
            above. Same target as the full card's "Details ›". */}
        <div
          className="md-sc md-sc-trust"
          role="button"
          tabIndex={0}
          onClick={() => setShowTrustBreakdown(true)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowTrustBreakdown(true) } }}
        >
          <div className="md-sc-trust-donut">
            <svg viewBox="0 0 72 72" aria-hidden="true">
              <circle cx="36" cy="36" r="27" fill="none" stroke="var(--bg4)" strokeWidth="8" />
              <circle cx="36" cy="36" r="27" fill="none" stroke="var(--green-bright)" strokeWidth="8"
                strokeDasharray={trustDonut.dashArray}
                strokeDashoffset={trustDonut.dashOffset}
                strokeLinecap="round"
                transform="rotate(-90 36 36)" />
            </svg>
            <span className="md-sc-trust-num">{trustScore}%</span>
          </div>
          <div className="md-sc-trust-meta">
            <div className="md-sc-label">Trust Score</div>
            <span
              className="md-sc-trust-badge"
              style={{ color: tsInfo.color, background: tsInfo.bg, border: `0.5px solid ${tsInfo.border}` }}
            >
              {tsInfo.label}
            </span>
            <span className="md-sc-trust-link">Details ›</span>
          </div>
        </div>
      </div>

      <div className="md-tabs">
        {(['overview', 'history', 'nuts', 'audit', 'reviews'] as const).map(tab => (
          <button
            key={tab}
            className={`md-tab${activeTab === tab ? ' active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {{ overview: 'Overview', history: 'History', nuts: 'NUTs', audit: 'Audit', reviews: 'Reviews' }[tab]}
          </button>
        ))}
      </div>

      <div className="md-body">
        <div className="md-left">

          {activeTab === 'overview' && (<>
            {(motd || description || descriptionLong) && (
              <div className="md-panel">
                <div className="md-panel-title">About</div>
                {motd && (
                  <div className={`md-motd${isWarningMotd(motd) ? ' warning' : ''}`}>
                    <div className="md-motd-label">Message of the Day</div>
                    <div className="md-motd-text">{motd}</div>
                  </div>
                )}
                {description && (
                  <div className="md-info-row md-desc-row">
                    <span className="md-info-label">Description</span>
                    <span className="md-info-value">{description}</span>
                  </div>
                )}
                {descriptionLong && (
                  <div className="md-info-row md-desc-row">
                    <span className="md-info-label">Full description</span>
                    <span className="md-info-value">
                      {descriptionLong}
                    </span>
                  </div>
                )}
              </div>
            )}
            <div className="md-panel">
              <div className="md-panel-title">Mint info</div>
            {probeLoading && (
              <div style={{fontSize:11,color:'var(--text3)',fontFamily:'var(--font-mono)',marginBottom:12}}>
                Loading live mint data (MOTD, description, contact)…
              </div>
            )}
            {(nut4Disabled || nut5Disabled) && (
              <div className="md-mint-alert">
                <AlertTriangle size={16} className="md-mint-alert-icon" />
                <div className="md-mint-alert-body">
                  {nut4Disabled && (
                    <>
                      <div className="md-mint-alert-title">This mint has stopped issuing new ecash</div>
                      <div className="md-mint-alert-text">
                        You can no longer deposit here, but any ecash you already hold can still
                        be melted or withdrawn. A mint turning off minting usually means the
                        operator is winding it down — if you have a balance on this mint,
                        withdraw it while you still can.
                      </div>
                    </>
                  )}
                  {nut5Disabled && (
                    <>
                      <div className="md-mint-alert-title">This mint has disabled withdrawals</div>
                      <div className="md-mint-alert-text">
                        Melting ecash back to Lightning is switched off right now. Funds already
                        held on this mint can&apos;t be moved out until the operator re-enables it —
                        avoid depositing more here in the meantime.
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
            <div className="md-info-grid">
              <div className="md-info-row">
                <span className="md-info-label">Name</span>
                <span className="md-info-value green">{name ?? '—'}</span>
              </div>
              <div className="md-info-row">
                <span className="md-info-label">Version</span>
                <span className="md-info-value">{version ?? '—'}</span>
              </div>
              <div className="md-info-row">
                <span className="md-info-label">Discovered</span>
                <span className="md-info-value">NIP-87</span>
              </div>
              {mintTime && (
                <div className="md-info-row">
                  <span className="md-info-label">Server time</span>
                  <span className="md-info-value">{formatTime(new Date(mintTime * 1000))}</span>
                </div>
              )}
              {pubkey && (
                <div className="md-info-row" style={{alignItems: 'center'}}>
                  <span className="md-info-label">Public key</span>
                  <div style={{display: 'flex', alignItems: 'center', gap: 4}}>
                    <span style={{fontSize: 14, color: 'var(--text)', fontFamily: 'var(--font-mono)'}}>{pubkey.slice(0, 8)}…{pubkey.slice(-8)}</span>
                    <button
                      onClick={() => {
                        void navigator.clipboard.writeText(pubkey)
                        setCopiedContact('pubkey')
                        setTimeout(() => setCopiedContact(null), 2000)
                      }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: copiedContact === 'pubkey' ? 'var(--accent)' : 'var(--text3)',
                        padding: '2px 4px', flexShrink: 0, display: 'flex',
                      }}
                      title="Copy full public key"
                    >
                      {copiedContact === 'pubkey' ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                </div>
              )}
              {tosUrl && (tosUrl.startsWith('https://') || tosUrl.startsWith('http://')) && (
                <div className="md-info-row">
                  <span className="md-info-label">Terms of Service</span>
                  <a
                    href={tosUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="md-info-value"
                    style={{color:'var(--accent)', textDecoration:'none'}}
                    onClick={e => e.stopPropagation()}
                  >
                    View ToS ↗
                  </a>
                </div>
              )}
            </div>
            {urls && urls.length > 1 && (
              <div className="md-info-row" style={{flexDirection:'column', alignItems:'flex-start', gap:4}}>
                <span className="md-info-label">URLs</span>
                <div style={{display:'flex', flexDirection:'column', gap:3, width:'100%'}}>
                  {urls.map((u: string) => {
                    const isActive = u === url
                    return (
                      <div key={u} style={{display:'flex', alignItems:'center', gap:6, justifyContent:'space-between'}}>
                        <span style={{
                          fontSize:12, color: isActive ? 'var(--accent)' : 'var(--text3)',
                          fontFamily:'var(--font-mono)', wordBreak:'break-all', flex:1
                        }}>
                          {isActive ? '● ' : '○ '}{u}
                        </span>
                        <button
                          onClick={() => {
                            void navigator.clipboard.writeText(u)
                            setCopiedUrl(true)
                            setTimeout(() => setCopiedUrl(false), 2000)
                          }}
                          style={{
                            background:'none', border:'none', cursor:'pointer',
                            color:'var(--text3)', padding:'2px 4px',
                            flexShrink:0, display:'flex',
                          }}
                          title="Copy URL"
                        >
                          <Copy size={12} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {(email || twitter || nostr) && (
            <div className="md-panel">
              <div className="md-panel-title">Get in Touch</div>
              <div className="md-contact-grid">
                {email && (
                  <div className="md-contact-card">
                    <div className="md-contact-icon"><Mail size={14} /></div>
                    <div style={{minWidth:0}}>
                      <div className="md-contact-type">Email</div>
                      <div className="md-contact-val">{email}</div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void navigator.clipboard.writeText(email)
                        setCopiedContact('email')
                        setTimeout(() => setCopiedContact(null), 2000)
                      }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: copiedContact === 'email' ? 'var(--accent)' : 'var(--text3)',
                        padding: '2px 4px', marginLeft: 'auto',
                        flexShrink: 0, display: 'flex',
                      }}
                      title="Copy"
                    >
                      {copiedContact === 'email' ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                )}
                {twitter && (
                  <div className="md-contact-card">
                    <div className="md-contact-icon"><AtSign size={14} /></div>
                    <div style={{minWidth:0}}>
                      <div className="md-contact-type">Twitter</div>
                      <div className="md-contact-val">{twitter}</div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void navigator.clipboard.writeText(twitter)
                        setCopiedContact('twitter')
                        setTimeout(() => setCopiedContact(null), 2000)
                      }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: copiedContact === 'twitter' ? 'var(--accent)' : 'var(--text3)',
                        padding: '2px 4px', marginLeft: 'auto',
                        flexShrink: 0, display: 'flex',
                      }}
                      title="Copy"
                    >
                      {copiedContact === 'twitter' ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                )}
                {nostr && (
                  <div className="md-contact-card">
                    <div className="md-contact-icon"><Zap size={14} /></div>
                    <div style={{minWidth:0}}>
                      <div className="md-contact-type">Nostr</div>
                      <div className="md-contact-val" style={{wordBreak:'break-all'}}>{nostr}</div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void navigator.clipboard.writeText(nostr)
                        setCopiedContact('nostr')
                        setTimeout(() => setCopiedContact(null), 2000)
                      }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: copiedContact === 'nostr' ? 'var(--accent)' : 'var(--text3)',
                        padding: '2px 4px', marginLeft: 'auto',
                        flexShrink: 0, display: 'flex',
                      }}
                      title="Copy"
                    >
                      {copiedContact === 'nostr' ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
          </>)}

          {activeTab === 'nuts' && (<>
          {(() => {
            const nut4 = (data?.info?.nuts?.['4'] ?? knownMint?.nutsLimits?.['4']) as NutConfig | null | undefined
            const nut5 = (data?.info?.nuts?.['5'] ?? knownMint?.nutsLimits?.['5']) as NutConfig | null | undefined
            const hasAnyLimits =
              nut4?.methods?.some(m => m.min_amount != null || m.max_amount != null) ||
              nut5?.methods?.some(m => m.min_amount != null || m.max_amount != null)
            // Still render the grid when a method is disabled, so the "disabled by
            // operator" state is shown instead of a silent omission.
            const showLimitsGrid = hasAnyLimits || nut4Disabled || nut5Disabled
            // Ranges shared by several payment methods collapse into one entry
            // labelled with those methods — see groupNutLimits() for why this
            // groups rather than plainly deduplicating.
            const renderLimits = (cfg: NutConfig | null | undefined) => {
              const groups = groupNutLimits(cfg?.methods)
              if (!groups.length) return <span style={{fontSize:13,color:'var(--text3)',fontFamily:'var(--font-mono)'}}>—</span>
              return groups.map((g, i) => (
                <span key={i} style={{fontSize:13,color:'var(--text)',fontFamily:'var(--font-mono)'}}>
                  {formatNutLimitRange(g)}
                  {g.methods.length > 0 && (
                    <span style={{color:'var(--text3)'}}> ({g.methods.join(', ')})</span>
                  )}
                  {i < groups.length - 1 ? ', ' : ''}
                </span>
              ))
            }
            return (
              <div className="md-panel">
                <div className="md-panel-title">NUT Limits</div>
                {!showLimitsGrid ? (
                  <div style={{fontSize:13,color:'var(--text3)',fontFamily:'var(--font-mono)'}}>Limits not specified by this mint.</div>
                ) : (
                  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))',gap:12}}>
                    {[{ key: 'NUT-04 (Minting)', cfg: nut4, disabled: nut4Disabled }, { key: 'NUT-05 (Melting)', cfg: nut5, disabled: nut5Disabled }].map(({ key, cfg, disabled }) => (
                      <div key={key} style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',display:'flex',flexDirection:'column',gap:5,opacity: disabled ? 0.75 : 1}}>
                        <span style={{fontSize:13,fontWeight:600,color:'var(--text2)',fontFamily:'var(--font-mono)',whiteSpace:'nowrap',textDecoration: disabled ? 'line-through' : 'none'}}>{key}</span>
                        {disabled ? (
                          <span className="md-limit-off"><AlertTriangle size={11} /> Disabled by operator</span>
                        ) : (
                          <>
                            <span style={{fontSize:11,color:'var(--text3)',fontFamily:'var(--font-mono)',textTransform:'uppercase',letterSpacing:'0.08em'}}>Min – Max</span>
                            <div>{renderLimits(cfg)}</div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}
            <div className="md-panel">
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:11}}>
                <div className="md-panel-title" style={{marginBottom:0}}>NUT Compatibility</div>
              {supportsBackupRestore ? (
                <span style={{display:'inline-flex',alignItems:'center',gap:4}}>
                  <span style={{display:'inline-flex',alignItems:'center',gap:4,fontSize:10,fontFamily:'var(--font-mono)',fontWeight:600,color:'#4ade80',background:'rgba(74,222,128,0.1)',border:'0.5px solid rgba(74,222,128,0.3)',borderRadius:5,padding:'2px 7px'}}>
                    <ShieldCheck size={11} /> Backup supported
                  </span>
                  <span
                    ref={backupBadgeRef}
                    style={{position:'relative',display:'inline-flex'}}
                    onPointerEnter={backupBadgeTooltip.onPointerEnter}
                    onPointerLeave={backupBadgeTooltip.onPointerLeave}
                    onClick={backupBadgeTooltip.onClick}
                  >
                    <Info size={11} color="#6b7280" style={{cursor:'help'}} />
                    {backupBadgeTooltip.open && (
                      <div className="audit-tooltip" style={{width:220,left:'50%',transform:'translateX(-50%)'}}>
                        This mint supports restoring blind signatures (NUT-09), which lets a wallet recover its ecash from a seed phrase after losing its device.
                      </div>
                    )}
                  </span>
                </span>
              ) : (
                <span style={{display:'inline-flex',alignItems:'center',gap:4}}>
                  <span style={{display:'inline-flex',alignItems:'center',gap:4,fontSize:10,fontFamily:'var(--font-mono)',fontWeight:600,color:'var(--text3)',background:'var(--bg3)',border:'0.5px solid var(--border)',borderRadius:5,padding:'2px 7px'}}>
                    <ShieldOff size={11} /> No backup
                  </span>
                  <span
                    ref={backupBadgeRef}
                    style={{position:'relative',display:'inline-flex'}}
                    onPointerEnter={backupBadgeTooltip.onPointerEnter}
                    onPointerLeave={backupBadgeTooltip.onPointerLeave}
                    onClick={backupBadgeTooltip.onClick}
                  >
                    <Info size={11} color="#6b7280" style={{cursor:'help'}} />
                    {backupBadgeTooltip.open && (
                      <div className="audit-tooltip" style={{width:220,left:'50%',transform:'translateX(-50%)'}}>
                        This mint doesn't support wallet backup restore (NUT-09) — losing your device may mean losing funds stored here.
                      </div>
                    )}
                  </span>
                </span>
              )}
            </div>
            <div className="nut-summary-line">
              <strong>{supportedNuts.length}</strong> of {TRACKED_NUTS.length} known NUTs supported
            </div>
            <div className="nut-grid">
              {TRACKED_NUTS.map(nut => {
                const supported = supportedNuts.includes(nut)
                const meta = NUT_DESCRIPTIONS[nut]
                const nutKey = parseInt(nut.slice(4), 10).toString()
                const rawConfig = data?.info?.nuts?.[nutKey]
                const nutConfig = (rawConfig !== null && rawConfig !== undefined && typeof rawConfig === 'object') ? rawConfig as NutConfig : null
                const isDisabled = supported && nutConfig?.disabled === true
                return (
                  <div key={nut} className={`nut-card ${isDisabled ? 'nut-disabled' : supported ? 'supported' : 'unsupported'}`} onClick={() => setSelectedNut(nut)}>
                    <div className={`nut-icon ${isDisabled ? 'nut-disabled' : supported ? 'supported' : 'unsupported'}`}>
                      {NUT_ICONS[nut] ?? (isDisabled ? '!' : supported ? '●' : '○')}
                    </div>
                    <div className="nut-info">
                      <div className="nut-name">{nut}</div>
                      <div className="nut-desc">{isDisabled ? 'Disabled by operator' : meta?.short ?? ''}</div>
                    </div>
                    <span className="nut-check" style={{ color: isDisabled ? '#ffa500' : supported ? 'var(--accent)' : 'var(--text3)' }}>
                      {isDisabled ? '!' : supported ? '✓' : '–'}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
          </>)}

          {activeTab === 'history' && (<>
            <div className="md-panel">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div className="md-panel-title" style={{ marginBottom: 0 }}>Historical data</div>
              <div style={{ display: 'flex', background: 'var(--bg3)', borderRadius: 6, padding: 2, gap: 1 }}>
                {(['24h', '7d', '30d', '90d'] as const).map(iv => (
                  <button
                    key={iv}
                    onClick={() => setChartInterval(iv)}
                    style={{
                      background: chartInterval === iv ? 'var(--accent)' : 'transparent',
                      color: chartInterval === iv ? 'var(--bg)' : 'var(--text2)',
                      border: 'none', borderRadius: 4, padding: '3px 10px',
                      fontSize: 12, fontFamily: 'var(--font-mono)',
                      cursor: 'pointer', fontWeight: chartInterval === iv ? 700 : 400,
                    }}
                  >{iv}</button>
                ))}
              </div>
            </div>

            {/* Summary metric cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 14 }}>
              {[
                { label: 'Avg Latency', value: chartAvgLatency !== null ? `${chartAvgLatency}ms` : '—', delta: deltaStr(chartAvgLatency, chartPrevLatency, 'ms', chartPrevInsufficientHistory), color: 'var(--text)' },
                { label: 'Avg Uptime', value: chartAvgUptime !== null ? `${chartAvgUptime}%` : '—', delta: deltaStr(chartAvgUptime, chartPrevUptime, '%', chartPrevInsufficientHistory), color: '#4ade80' },
                { label: 'Avg Trust', value: `${trustScore}%`, delta: null, color: tsInfo.color },
              ].map(({ label, value, delta, color }) => (
                <div key={label} style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 11px' }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, fontFamily: 'var(--font-mono)' }}>{label}</div>
                  <div style={{ fontSize: 19, fontWeight: 700, color, fontFamily: 'var(--font-mono)', lineHeight: 1 }}>{value}</div>
                  {delta && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>{delta}</div>}
                </div>
              ))}
            </div>

            {/* Tab switcher */}
            <div style={{ display: 'flex', gap: 2, marginBottom: 10, background: 'var(--bg3)', borderRadius: 6, padding: 2, width: 'fit-content' }}>
              {([['latency', 'Latency'], ['uptime', 'Uptime'], ['trust', 'Trust Score']] as const).map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => setChartMetric(m)}
                  style={{
                    background: chartMetric === m ? 'var(--bg2)' : 'transparent',
                    border: chartMetric === m ? '1px solid var(--border2)' : '1px solid transparent',
                    borderRadius: 5, padding: '4px 12px',
                    fontSize: 12, fontFamily: 'var(--font-mono)',
                    color: chartMetric === m ? 'var(--text)' : 'var(--text3)',
                    cursor: 'pointer',
                  }}
                >{label}</button>
              ))}
            </div>

            {/* Line chart */}
            {histLineData.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>No historical data for this period.</p>
            ) : histLineData.filter(d => d[chartMetric] !== null).length < 2 ? (
              <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>Not enough data for this period</p>
            ) : (
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={histLineData} margin={{ top: 4, right: 4, left: 10, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 9, fill: 'var(--text3)' }}
                    axisLine={false} tickLine={false}
                    interval={chartInterval === '24h' ? 3 : histLineData.length <= 7 ? 0 : Math.ceil(histLineData.length / 7) - 1}
                  />
                  <YAxis
                    tick={{ fontSize: 9, fill: 'var(--text3)' }}
                    axisLine={false} tickLine={false}
                    width={60}
                    domain={chartMetric === 'latency'
                      ? [(dataMin: number) => dataMin * 0.9, (dataMax: number) => dataMax * 1.1]
                      : [0, 100]}
                    tickFormatter={(v: number) => chartMetric === 'latency' ? `${Math.round(v / 100) * 100}ms` : `${Math.round(v)}%`}
                  />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, fontFamily: 'var(--font-mono)', fontSize: 11 }}
                    formatter={(value) => [chartMetric === 'latency' ? `${String(value)}ms` : `${String(value)}%`, chartMetric === 'latency' ? 'Latency' : chartMetric === 'uptime' ? 'Uptime' : 'Trust Score']}
                  />
                  <Line
                    type="monotone"
                    dataKey={chartMetric}
                    stroke={chartMetric === 'latency' ? '#B4B2A9' : chartMetric === 'uptime' ? '#4ade80' : '#ffa500'}
                    dot={false}
                    strokeWidth={2}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
            {chartCoverage && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>{chartCoverage}</div>
            )}
          </div>

          <div className="md-panel">
            <div className="md-panel-title">Version history</div>
            {!versionHistory || versionHistory.length === 0 ? (
              <div style={{fontSize:13,color:'var(--text3)',fontFamily:'var(--font-mono)'}}>No version history available.</div>
            ) : (
              <div>
                <div style={{display:'grid',gridTemplateColumns:'auto 1fr 1fr',gap:'0 16px',marginBottom:4}}>
                  <span style={{fontSize:11,color:'var(--text3)',fontFamily:'var(--font-mono)',textTransform:'uppercase',letterSpacing:'0.08em'}}>Date</span>
                  <span style={{fontSize:11,color:'var(--text3)',fontFamily:'var(--font-mono)',textTransform:'uppercase',letterSpacing:'0.08em'}}>From</span>
                  <span style={{fontSize:11,color:'var(--text3)',fontFamily:'var(--font-mono)',textTransform:'uppercase',letterSpacing:'0.08em'}}>To</span>
                </div>
                {versionHistory.map((vh, i) => (
                  <div key={i} style={{
                    display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: '0 16px',
                    padding: '5px 0',
                    borderBottom: i < versionHistory.length - 1 ? '0.5px solid var(--border)' : 'none',
                    alignItems: 'center',
                  }}>
                    <span style={{fontSize:12,color:'var(--text3)',fontFamily:'var(--font-mono)',whiteSpace:'nowrap'}}>
                      {new Date(vh.firstSeenAt).toLocaleDateString()}
                    </span>
                    <span style={{fontSize:13,color:'var(--text2)',fontFamily:'var(--font-mono)'}}>
                      {versionHistory[i + 1]?.version ?? '—'}
                    </span>
                    <span style={{fontSize:13,color:'var(--text)',fontFamily:'var(--font-mono)',fontWeight:500}}>
                      {vh.version}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          </>)}

          {activeTab === 'audit' && (
            knownMint !== null && knownMint.auditNMints !== null ? (
              <div className="md-panel md-audit-collapsible" style={{background:'var(--bg)'}}>
                {/* Desktop heading (the mobile collapse toggle below is display:none here). */}
                <div className="md-audit-header md-audit-header-main">
                  <span className="md-panel-title" style={{marginBottom:0}}>Audit stats</span>
                  <span className="md-audit-via">· via audit.8333.space</span>
                  <AuditSourceInfoIcon />
                </div>
                <button
                  className="md-audit-toggle"
                  onClick={() => setAuditExpanded(v => !v)}
                  aria-expanded={auditExpanded}
                >
                  <div style={{display:'flex',alignItems:'baseline',gap:6}}>
                    <span className="md-panel-title" style={{marginBottom:0}}>Audit stats</span>
                    <span style={{fontSize:12,color:'var(--text3)',fontFamily:'var(--font-mono)'}}>· via audit.8333.space</span>
                    <AuditSourceInfoIcon align="right" />
                  </div>
                  <span className="md-audit-chevron">
                    {auditExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </span>
                </button>

                <div className="audit-tab-explainer">
                  Independent payment probes — successful and failed mint/melt ops, plus how recent the sample is. Not a proof of reserves.
                </div>

                {/* 5-second overview — always visible, never inside the mobile
                    collapse. Mints/Melts are audit.8333.space lifetime counts;
                    Recent errors is the rolling ~100-swap window; Last checked is
                    OUR 6h cron's write time (auditSyncedAt). */}
                <div className="audit-summary-strip">
                  <div className="audit-summary-cell">
                    <div className="audit-summary-value" style={{color:'#4ade80'}}>{auditNMints.toLocaleString()}</div>
                    <div className="audit-summary-label">
                      Mints
                      <span
                        ref={auditMintsRef}
                        style={{position:'relative',display:'inline-flex',marginLeft:3}}
                        onPointerEnter={auditMintsTooltip.onPointerEnter}
                        onPointerLeave={auditMintsTooltip.onPointerLeave}
                        onClick={auditMintsTooltip.onClick}
                      >
                        <Info size={11} color="#6b7280" style={{cursor:'help'}} />
                        {auditMintsTooltip.open && (
                          <div className="audit-tooltip" style={{left:'50%',transform:'translateX(-50%)'}}>
                            All-time successful ecash minting operations the auditor has run against this mint.
                          </div>
                        )}
                      </span>
                    </div>
                  </div>
                  <div className="audit-summary-cell">
                    <div className="audit-summary-value" style={{color:'#4ade80'}}>{auditNMelts.toLocaleString()}</div>
                    <div className="audit-summary-label">
                      Melts
                      <span
                        ref={auditMeltsRef}
                        style={{position:'relative',display:'inline-flex',marginLeft:3}}
                        onPointerEnter={auditMeltsTooltip.onPointerEnter}
                        onPointerLeave={auditMeltsTooltip.onPointerLeave}
                        onClick={auditMeltsTooltip.onClick}
                      >
                        <Info size={11} color="#6b7280" style={{cursor:'help'}} />
                        {auditMeltsTooltip.open && (
                          <div className="audit-tooltip" style={{left:'50%',transform:'translateX(-50%)'}}>
                            All-time successful ecash melting operations (redeeming ecash back to Lightning).
                          </div>
                        )}
                      </span>
                    </div>
                  </div>
                  <div className="audit-summary-cell">
                    <div className="audit-summary-value" style={{color: recentReliabilityColor}}>
                      {stripRecentErrorsDisplay !== '—' && (
                        <>
                          <span className="audit-summary-main">{stripRecentErrorsDisplay}</span>
                          <span className="audit-summary-dot">·</span>
                        </>
                      )}
                      <span className="audit-summary-sub">{stripRecentErrorsSub}</span>
                    </div>
                    <div className="audit-summary-label">
                      Recent errors
                      <span
                        ref={auditErrorsRef}
                        style={{position:'relative',display:'inline-flex',marginLeft:3}}
                        onPointerEnter={auditErrorsTooltip.onPointerEnter}
                        onPointerLeave={auditErrorsTooltip.onPointerLeave}
                        onClick={auditErrorsTooltip.onClick}
                      >
                        <Info size={11} color="#6b7280" style={{cursor:'help'}} />
                        {auditErrorsTooltip.open && (
                          <div className="audit-tooltip" style={{left:'50%',transform:'translateX(-50%)'}}>
                            Failed swaps out of the mint's last ~100 audited operations — the same rolling window the Trust Score's Audit component scores on. Shows "too few to score" below 3 recent swaps.
                          </div>
                        )}
                      </span>
                    </div>
                  </div>
                  <div className="audit-summary-cell">
                    <div className="audit-summary-value" style={{fontSize:15}}>{auditLastCheckedDisplay}</div>
                    <div className="audit-summary-label">
                      Last checked
                      <span
                        ref={auditRecentRef}
                        style={{position:'relative',display:'inline-flex',marginLeft:3}}
                        onPointerEnter={auditRecentTooltip.onPointerEnter}
                        onPointerLeave={auditRecentTooltip.onPointerLeave}
                        onClick={auditRecentTooltip.onClick}
                      >
                        <Info size={11} color="#6b7280" style={{cursor:'help'}} />
                        {auditRecentTooltip.open && (
                          <div className="audit-tooltip" style={{left:'50%',transform:'translateX(-50%)'}}>
                            When MintRadar's own 6-hour discovery job last refreshed this mint's audit figures.
                          </div>
                        )}
                      </span>
                    </div>
                  </div>
                </div>

                <div className={`md-audit-content${auditExpanded ? ' expanded' : ''}`}>
                  <div className="audit-alltime-line">
                    All-time via audit.8333.space: {auditNMints.toLocaleString()} mints · {auditNMelts.toLocaleString()} melts · {auditNErrors.toLocaleString()} errors
                    {auditErrorPct !== null ? ` (${auditErrorPct.toFixed(1)}% of ops)` : ''}.
                    {' '}<strong style={{color:'var(--text2)',fontWeight:500}}>Recent errors</strong> is the rolling ~100-swap window that feeds the Trust Score's Audit reliability component
                    {isAuditUnknown(breakdownAuditRecentTotal) ? ' (shown as "too few to score" below 3 swaps)' : ''}.
                    {!auditSyncedAt && knownMint.auditCheckedAt
                      ? ` Auditor's own last update: ${new Date(knownMint.auditCheckedAt).toLocaleDateString()}.`
                      : ''}
                  </div>
                </div>
              </div>
            ) : (
              <div className="md-panel">
                <div className="md-audit-header">
                  <span className="md-panel-title" style={{marginBottom:0}}>Audit stats</span>
                  <span className="md-audit-via">· via audit.8333.space</span>
                  <AuditSourceInfoIcon />
                </div>
                <div style={{fontSize:13,color:'var(--text3)',fontFamily:'var(--font-mono)'}}>No audit data available for this mint.</div>
              </div>
            )
          )}

          {activeTab === 'reviews' && (
            <div className="md-panel">
              <div className="reviews-header">
                <div className="md-panel-title" style={{marginBottom:0}}>Reviews</div>
                {isLoggedIn && (
                  <button className="reviews-write-btn" onClick={() => setShowReviewModal(true)}>
                    Write a review
                  </button>
                )}
              </div>
              <p className="reviews-disclaimer">Reviews are self-published Nostr events (NIP-87). Anyone can create a new key, so a rating can be artificially inflated — treat it as a directional signal, not proof. Counts may also differ from other sites.</p>
              {reviewsLoading ? (
                <div style={{fontSize:13,color:'var(--text3)',marginTop:8}}>Loading reviews...</div>
              ) : mergedReviews.length === 0 ? (
                <div style={{fontSize:13,color:'var(--text3)',marginTop:8}}>No Nostr reviews found for this mint yet.</div>
              ) : (
                <div style={{marginTop:10,display:'flex',flexDirection:'column',gap:8}}>
                  <div className="reviews-filter-row">
                    <div className="reviews-filter-group" role="group" aria-label="Filter reviews by rating">
                      <button
                        type="button"
                        className={`reviews-filter-chip${activeReviewFilter === 'all' ? ' active' : ''}`}
                        aria-pressed={activeReviewFilter === 'all'}
                        onClick={() => setReviewFilter('all')}
                      >All · {reviewCountBase.length}</button>
                      <button
                        type="button"
                        className={`reviews-filter-chip${activeReviewFilter === '5star' ? ' active' : ''}`}
                        aria-pressed={activeReviewFilter === '5star'}
                        onClick={() => setReviewFilter('5star')}
                      >5★ · {reviewFilterFiveStarCount}</button>
                      <button
                        type="button"
                        className={`reviews-filter-chip${activeReviewFilter === 'critical' ? ' active' : ''}`}
                        aria-pressed={activeReviewFilter === 'critical'}
                        onClick={() => setReviewFilter('critical')}
                      >Critical · {reviewFilterCriticalCount}</button>
                    </div>
                    <button
                      type="button"
                      className={`reviews-filter-chip toggle${hideAnonActive ? ' active' : ''}`}
                      aria-pressed={hideAnonActive}
                      onClick={toggleReviewHideAnon}
                    >Hide anon · {reviewFilterAnonCount}</button>
                  </div>
                  {filteredReviews.length === 0 ? (
                    <div style={{fontSize:13,color:'var(--text3)'}}>No reviews match this filter.</div>
                  ) : (
                    <>
                  {pagedReviews.map(r => {
                    const npub = nip19.npubEncode(r.pubkey)
                    const profile = r.profile
                    const displayName = profile?.name ?? shortNpub(npub)
                    const initial = (profile?.name ?? npub).slice(0, 1).toUpperCase()
                    return (
                      <div key={r.id} className="review-card">
                        <div className="review-card-header">
                          <div className="review-avatar">
                            {profile?.picture?.startsWith('https://')
                              ? <img src={profile.picture} alt="" className="review-avatar-img" />
                              : <div className="review-avatar-fallback" style={{background: reviewAvatarColor(r.pubkey)}}>{initial}</div>
                            }
                          </div>
                          <div className="review-author">
                            <span className="review-author-name">{displayName}</span>
                            <span className="review-author-npub">{shortNpub(npub)}</span>
                          </div>
                          <div className="review-meta">
                            {r.rating !== null && (
                              <span className="review-stars">{starString(r.rating)}</span>
                            )}
                            <span className="review-date">{formatReviewDate(r.createdAt)}</span>
                          </div>
                        </div>
                        {r.comment && <p className="review-comment">{r.comment}</p>}
                      </div>
                    )
                  })}
                  {reviewsTotalPages > 1 && (
                    <nav className="reviews-pagination" aria-label="Reviews pages">
                      <button
                        className="reviews-page-btn"
                        disabled={reviewsPage === 1}
                        onClick={() => goToReviewsPage(reviewsPage - 1)}
                        aria-label="Previous page"
                      >‹</button>
                      {reviewPageList(reviewsPage, reviewsTotalPages).map((p, i) =>
                        p === '…'
                          ? <span key={`gap-${i}`} className="reviews-page-ellipsis">…</span>
                          : (
                            <button
                              key={p}
                              className={`reviews-page-btn${p === reviewsPage ? ' active' : ''}`}
                              aria-current={p === reviewsPage ? 'page' : undefined}
                              onClick={() => goToReviewsPage(p)}
                            >{p}</button>
                          ),
                      )}
                      <button
                        className="reviews-page-btn"
                        disabled={reviewsPage === reviewsTotalPages}
                        onClick={() => goToReviewsPage(reviewsPage + 1)}
                        aria-label="Next page"
                      >›</button>
                    </nav>
                  )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

        </div>

        <div className="md-right">

          <div className="md-panel md-trust-panel">
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:11}}>
              <div className="md-panel-title" style={{marginBottom:0}}>Trust Score</div>
              <button onClick={() => setShowTrustBreakdown(true)} style={{background:'none',border:'none',color:'var(--accent)',fontSize:10,cursor:'pointer',fontFamily:'var(--font-mono)',padding:0}}>Details ›</button>
            </div>
            <div className="trust-wrap" style={{cursor:'pointer'}} onClick={() => setShowTrustBreakdown(true)}>
              <div className="gauge-wrap">
                <svg viewBox="0 0 72 72">
                  <circle cx="36" cy="36" r="27" fill="none" stroke="var(--bg4)" strokeWidth="7" />
                  <circle cx="36" cy="36" r="27" fill="none" stroke="var(--green-bright)" strokeWidth="7"
                    strokeDasharray={trustDonut.dashArray}
                    strokeDashoffset={trustDonut.dashOffset}
                    strokeLinecap="round"
                    transform="rotate(-90 36 36)" />
                </svg>
                <div className="gauge-num" style={{ color: 'var(--green-bright)', fontFamily: 'var(--font-mono-data)' }}>{trustScore}%</div>
              </div>
              <span style={{fontSize:9,fontFamily:'var(--font-mono)',fontWeight:600,color:tsInfo.color,background:tsInfo.bg,border:`0.5px solid ${tsInfo.border}`,borderRadius:4,padding:'1px 6px',textAlign:'center'}}>{tsInfo.label}</span>
              <div className="trust-info">
                <div className="trust-row">
                  <span className="trust-label">Uptime</span>
                  <span className="trust-value" style={{ color: uptimeColor(uptimePct) }}>{uptimePct}%</span>
                </div>
                <div className="trust-row">
                  <span className="trust-label">NUTs</span>
                  <span className="trust-value">{supportedNuts.length}/{TRACKED_NUTS.length}</span>
                </div>
                <div className="trust-row">
                  <span className="trust-label">Latency</span>
                  <span className="trust-value" style={{color: 'var(--text)'}}>
                    {latency !== null ? `${latency} ms` : '—'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {knownMint?.units && knownMint.units.length > 0 && (
            <div className="md-panel">
              <div className="md-panel-title">Units & Methods</div>
              {knownMint.units.map(unit => {
                const mintChips = (knownMint.mintMethods ?? []).filter(m => m.unit === unit)
                const meltChips = (knownMint.meltMethods ?? []).filter(m => m.unit === unit)
                return (
                  <div className="unit-block" key={unit}>
                    <div className="unit-header"><span className="unit-badge">{unit.toUpperCase()}</span></div>
                    <div className="method-rows">
                      {(mintChips.length > 0 || nut4Disabled) && (
                        <div className={`method-row${nut4Disabled ? ' method-row-off' : ''}`}>
                          <span className="method-label">Mint</span>
                          <div className="method-chips">
                            {mintChips.map((m, i) => (
                              <span className="method-chip mint" key={i}>{m.method}</span>
                            ))}
                            {nut4Disabled && <span className="method-chip-off"><AlertTriangle size={10} /> disabled</span>}
                          </div>
                        </div>
                      )}
                      {(meltChips.length > 0 || nut5Disabled) && (
                        <div className={`method-row${nut5Disabled ? ' method-row-off' : ''}`}>
                          <span className="method-label">Melt</span>
                          <div className="method-chips">
                            {meltChips.map((m, i) => (
                              <span className="method-chip melt" key={i}>{m.method}</span>
                            ))}
                            {nut5Disabled && <span className="method-chip-off"><AlertTriangle size={10} /> disabled</span>}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

        </div>
      </div>

      {showQr && (
        <div className="qr-modal-overlay" onClick={() => setShowQr(false)}>
          <div className="qr-modal" onClick={e => e.stopPropagation()}>
            <div className="qr-modal-header">
              <MintFavicon url={url} iconUrl={data?.info?.icon_url ?? null} size={38} radius={9} />
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:14,fontWeight:700,color:'var(--text)',lineHeight:1.25,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>Add {displayName} to wallet</div>
                <div style={{fontSize:11,color:'var(--text-faint)',marginTop:2}}>Scan with any Cashu wallet app</div>
              </div>
              <button onClick={() => setShowQr(false)} style={{background:'none',border:'none',color:'var(--text-faint)',fontSize:20,cursor:'pointer',lineHeight:1,padding:'2px 6px',flexShrink:0}}>×</button>
            </div>
            <div style={{display:'flex',justifyContent:'center',margin:'16px 0'}}>
              <div style={{background:'#ffffff',borderRadius:12,padding:12,border:'2px solid rgba(23,232,127,0.35)'}}>
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=184x184&data=${encodeURIComponent(url)}&bgcolor=ffffff&color=000000&qzone=1`}
                  alt="QR Code"
                  style={{display:'block',width:184,height:184}}
                />
              </div>
            </div>
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              <input
                readOnly
                value={url}
                style={{flex:1,background:'var(--surface-3)',border:'1px solid var(--border)',borderRadius:8,padding:'8px 10px',color:'var(--text-dim)',fontSize:11,fontFamily:'var(--font-mono)',outline:'none'}}
              />
              <button
                onClick={() => { void navigator.clipboard.writeText(url); setCopiedUrl(true); setTimeout(() => setCopiedUrl(false), 2000) }}
                style={{background: 'var(--green-soft)', color: 'var(--green-bright)', border: '1px solid var(--green-soft-strong)', borderRadius: 'var(--radius-m)', padding:'8px 16px',fontSize:12,fontWeight:700,cursor:'pointer',fontFamily:'var(--font-body)',whiteSpace:'nowrap',flexShrink:0}}
              >
                {copiedUrl ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showWatchLoginModal && (
        <div className="rv-modal-overlay" onClick={closeWatchLoginModal}>
          <div className="rv-modal" onClick={e => e.stopPropagation()}>
            <div className="rv-modal-head">
              <div className="rv-modal-heading">
                <div className="rv-modal-title">Watch this mint</div>
                <div className="rv-modal-sub">
                  Log in with Nostr to add it to your watchlist. Your list syncs over Nostr and you&apos;ll get a message if this mint goes offline or comes back online.
                </div>
              </div>
              <button type="button" className="rv-modal-close" onClick={closeWatchLoginModal} aria-label="Close">×</button>
            </div>
            <div className="rv-actions">
              <button type="button" className="rv-btn-cancel" onClick={closeWatchLoginModal}>Cancel</button>
              <button type="button" className="rv-btn-submit" onClick={confirmWatchLogin}>⚡ Login via Nostr</button>
            </div>
          </div>
        </div>
      )}

      {showTrustBreakdown && (
        <div style={{position:'fixed',inset:0,zIndex:100,background:'rgba(0,0,0,0.7)',backdropFilter:'blur(4px)',display:'flex',alignItems:'center',justifyContent:'center',padding:'20px'}}
          onClick={() => setShowTrustBreakdown(false)}>
          <div style={{background:'var(--bg2)',border:'0.5px solid var(--border2)',borderRadius:14,padding:'24px',maxWidth:380,width:'100%'}}
            onClick={e => e.stopPropagation()}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
              <div style={{fontSize:16,fontWeight:600,color:'var(--text)'}}>Trust Score Breakdown</div>
              <button onClick={() => setShowTrustBreakdown(false)} style={{background:'none',border:'none',color:'var(--text3)',fontSize:18,cursor:'pointer'}}>×</button>
            </div>
            <div style={{textAlign:'center',marginBottom:20}}>
              <div style={{fontSize:48,fontWeight:700,color:trustScoreColor(trustScore),lineHeight:1}}>{trustScore}%</div>
              <div style={{marginTop:8,display:'flex',justifyContent:'center'}}>
                <span style={{fontSize:11,fontFamily:'var(--font-mono)',fontWeight:600,color:tsInfo.color,background:tsInfo.bg,border:`0.5px solid ${tsInfo.border}`,borderRadius:5,padding:'2px 8px'}}>{tsInfo.label}</span>
              </div>
            </div>
            {trustBreakdownRows.map(row => (
                <div key={row.label} style={{marginBottom:14}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                    <span style={{fontSize:12,color:'var(--text2)',display:'flex',alignItems:'center',gap:4}}>
                      {row.label}
                      <span
                        ref={row.tooltipRef}
                        style={{position:'relative',display:'inline-flex'}}
                        onPointerEnter={row.tooltipHook.onPointerEnter}
                        onPointerLeave={row.tooltipHook.onPointerLeave}
                        onClick={row.tooltipHook.onClick}
                      >
                        <Info size={11} color="#6b7280" style={{flexShrink:0,cursor:'help'}} />
                        {row.tooltipHook.open && (
                          <div className="audit-tooltip" style={{width:220,left:'50%',transform:'translateX(-50%)'}}>{row.tooltip}</div>
                        )}
                      </span>
                    </span>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <span style={{fontSize:11,color:'var(--text3)',fontFamily:'var(--font-mono)',maxWidth:140,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{row.display}</span>
                      <span style={{fontSize:13,fontWeight:600,color:row.color}}>{row.score}/{row.max}</span>
                    </div>
                  </div>
                  <div style={{height:4,background:'var(--bg3)',borderRadius:2,overflow:'hidden'}}>
                    <div style={{height:'100%',width:`${(row.score/row.max)*100}%`,background:row.color,borderRadius:2,transition:'width 0.3s ease'}}/>
                  </div>
                </div>
              ))}
            <div style={{borderTop:'0.5px solid var(--border)',paddingTop:12,marginTop:4,fontSize:10,color:'var(--text3)',lineHeight:1.6}}>
              Score = Uptime×45% + NUT support×30% + Version×15% + Contact×5% + Audit×5%
            </div>
          </div>
        </div>
      )}

      {showReviewModal && (
        <div className="rv-modal-overlay" onClick={closeReviewModal}>
          <div className="rv-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Write a review">
            <div className="rv-modal-head">
              <div className="rv-modal-heading">
                <div className="rv-modal-title">Write a review for {displayName}</div>
                {reviewRating > 0 && (
                  <div className="rv-modal-sub">Share your experience with this mint.</div>
                )}
              </div>
              <button className="rv-modal-close" onClick={closeReviewModal} aria-label="Close">×</button>
            </div>

            {/* Phase 1 + 2 share the star row. Hover/focus previews up to the
                pointer; once a star is clicked the form below unfolds. */}
            <div className="rv-rate">
              <div className="rv-stars" onMouseLeave={() => setReviewHoverRating(0)}>
                {[1, 2, 3, 4, 5].map(star => (
                  <button
                    key={star}
                    type="button"
                    className="rv-star"
                    data-filled={star <= (reviewHoverRating || reviewRating)}
                    aria-label={`${star} star${star > 1 ? 's' : ''}${RATING_LABELS[star as 1 | 2 | 3 | 4 | 5] ? ` — ${RATING_LABELS[star as 1 | 2 | 3 | 4 | 5]}` : ''}`}
                    aria-pressed={reviewRating === star}
                    onMouseEnter={() => setReviewHoverRating(star)}
                    onFocus={() => setReviewHoverRating(star)}
                    onBlur={() => setReviewHoverRating(0)}
                    onClick={() => setReviewRating(star)}
                  >
                    ★
                  </button>
                ))}
              </div>
              <span className="rv-rate-label" data-chosen={reviewRating > 0}>
                {reviewRating > 0
                  ? `${reviewRating}: ${RATING_LABELS[reviewRating as 1 | 2 | 3 | 4 | 5]}`
                  : 'Choose a rating'}
              </span>
            </div>

            {reviewRating > 0 && (
              <>
                <div className="rv-signer">
                  {profile?.picture?.startsWith('https://')
                    ? <img src={profile.picture} alt="" className="rv-signer-avatar" onError={e => { e.currentTarget.style.display = 'none' }} />
                    : <div className="rv-signer-avatar rv-signer-avatar-fallback" style={{ background: reviewAvatarColor(profile?.pubkey ?? '0') }}>
                        {(profile?.name ?? profile?.npub ?? '?').slice(0, 1).toUpperCase()}
                      </div>}
                  <div className="rv-signer-text">
                    <span className="rv-signer-label">Signing with</span>
                    <span className="rv-signer-id">
                      <span className="rv-signer-name">{profile?.name ?? (profile ? shortNpub(profile.npub) : 'Nostr account')}</span>
                    </span>
                  </div>
                  {authMethod !== null && <span className="rv-signer-badge">{METHOD_BADGE[authMethod]}</span>}
                </div>

                <div className="rv-field">
                  <textarea
                    className="rv-textarea"
                    value={reviewComment}
                    onChange={e => setReviewComment(e.target.value)}
                    placeholder="What should other people know?"
                    maxLength={500}
                    rows={3}
                  />
                  <div className="rv-charcount">{reviewComment.length} / 500 characters</div>
                </div>

                {reviewError !== null && <div className="rv-msg rv-msg-error">{reviewError}</div>}
                {reviewSuccess && <div className="rv-msg rv-msg-success">✓ Review published!</div>}

                <div className="rv-actions">
                  <button type="button" className="rv-btn-cancel" onClick={closeReviewModal}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rv-btn-submit"
                    disabled={reviewSubmitting}
                    onClick={() => {
                      void (async () => {
                        setReviewSubmitting(true)
                        setReviewError(null)
                        try {
                          await submitMintReview(url, reviewRating, reviewComment)
                          setReviewSuccess(true)
                          setTimeout(() => { closeReviewModal() }, 1500)
                        } catch (err) {
                          setReviewError(err instanceof Error ? err.message : 'Failed to publish review')
                        } finally {
                          setReviewSubmitting(false)
                        }
                      })()
                    }}
                  >
                    {reviewSubmitting ? 'Publishing...' : 'Sign and publish'}
                  </button>
                </div>
                <p className="rv-permanence-note">Published permanently to public Nostr relays.</p>
              </>
            )}
          </div>
        </div>
      )}

      {selectedNut && (() => {
        const meta = NUT_DESCRIPTIONS[selectedNut]
        const supported = supportedNuts.includes(selectedNut)
        const nutKey = parseInt(selectedNut.slice(4), 10).toString()
        const rawNutConfig = data?.info?.nuts?.[nutKey] ?? knownMint?.nutsLimits?.[nutKey]
        const nutConfig = (rawNutConfig !== null && typeof rawNutConfig === 'object') ? rawNutConfig as NutConfig : null
        const isNutDisabled = supported && nutConfig?.disabled === true
        return (
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 100,
              background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '20px',
            }}
            onClick={() => setSelectedNut(null)}
          >
            <div
              style={{
                background: 'var(--bg2)', border: '0.5px solid var(--border2)',
                borderRadius: 14, padding: '24px', maxWidth: 420, width: '100%',
                boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
              }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 16}}>
                <div>
                  <div style={{fontSize: 18, fontWeight: 600, color: supported ? 'var(--accent)' : 'var(--text2)'}}>
                    {meta?.short ?? selectedNut}
                  </div>
                  <div style={{fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--font-mono)', marginTop: 2}}>
                    {selectedNut}
                  </div>
                </div>
                <div style={{display:'flex', alignItems:'center', gap: 8}}>
                  <span style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 6,
                    background: isNutDisabled ? 'rgba(255,165,0,0.1)' : supported ? '#0d2018' : 'var(--bg3)',
                    color: isNutDisabled ? '#ffa500' : supported ? 'var(--accent)' : 'var(--text3)',
                    border: `0.5px solid ${isNutDisabled ? 'rgba(255,165,0,0.3)' : supported ? '#1a3a28' : 'var(--border)'}`,
                    fontFamily: 'var(--font-mono)',
                  }}>
                    {isNutDisabled ? '⊘ Disabled by operator' : supported ? '✓ Supported' : '– Not supported'}
                  </span>
                  <button
                    onClick={() => setSelectedNut(null)}
                    style={{background:'none', border:'none', color:'var(--text3)', fontSize:18, cursor:'pointer', lineHeight:1}}
                  >×</button>
                </div>
              </div>

              <p style={{fontSize: 13, color: 'var(--text2)', marginBottom: 14, lineHeight: 1.6}}>
                {meta?.desc}
              </p>

              {meta?.features && (
                <div style={{marginBottom: 14}}>
                  <div style={{fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8}}>Features</div>
                  <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
                    {meta.features.map(f => (
                      <span key={f} style={{
                        fontSize: 11, padding: '3px 9px', borderRadius: 6,
                        background: 'var(--bg3)', border: '0.5px solid var(--border)',
                        color: 'var(--text2)',
                      }}>
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {meta?.useCase && (
                <div style={{
                  borderTop: '0.5px solid var(--border)', paddingTop: 12, marginTop: 4,
                }}>
                  <div style={{fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6}}>Use case</div>
                  <p style={{fontSize: 12, color: 'var(--text3)', lineHeight: 1.5}}>{meta.useCase}</p>
                </div>
              )}

              {nutConfig?.methods && nutConfig.methods.length > 0 && (
                <div style={{borderTop: '0.5px solid var(--border)', paddingTop: 12, marginTop: 4}}>
                  <div style={{fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8}}>Limits</div>
                  {nutConfig.methods.map((m, i) => (
                    <div key={i} style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:5}}>
                      <span style={{fontSize:11, color:'var(--text2)', fontFamily:'var(--font-mono)'}}>
                        {m.method} / {m.unit}
                      </span>
                      <span style={{fontSize:11, color:'var(--text3)', fontFamily:'var(--font-mono)'}}>
                        {m.min_amount != null ? m.min_amount.toLocaleString() : '—'}
                        {' – '}
                        {m.max_amount != null ? m.max_amount.toLocaleString() : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <a
                href={`https://github.com/cashubtc/nuts/blob/main/${parseInt(selectedNut.replace('NUT-', ''), 10).toString().padStart(2, '0')}.md`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  marginTop: 16, fontSize: 11, color: 'var(--accent)',
                  textDecoration: 'none',
                }}
              >
                ↗ View NUT spec on GitHub
              </a>
            </div>
          </div>
        )
      })()}

      {showComparePicker && (() => {
        const baseMint = knownMintsData?.find(m => m.url === url)
        const candidates = (knownMintsData ?? []).filter(m => m.url !== url && m.online === true)
        return (
          <MintComparePicker
            candidates={candidates}
            baseLabel={baseMint?.name ?? url}
            onClose={() => setShowComparePicker(false)}
            onConfirm={urls => {
              setCompareSelectedUrls(new Set(urls))
              setShowComparePicker(false)
              setShowComparisonModal(true)
            }}
          />
        )
      })()}

      {showComparisonModal && (() => {
        const comparedMints = [
          ...(knownMintsData?.filter(m => m.url === url) ?? []),
          ...(knownMintsData?.filter(m => compareSelectedUrls.has(m.url)) ?? []),
        ]
        return comparedMints.length >= 2
          ? <ComparisonModal mints={comparedMints} onClose={() => setShowComparisonModal(false)} />
          : null
      })()}
    </div>
  )
}

export default function MintDetail() {
  const params = useParams<{ url: string }>()
  const rawUrl = params['url']
  const navigate = useNavigate()

  if (rawUrl === undefined) {
    return (
      <div className="mint-detail">
        <div className="md-header">
          <button className="md-back" onClick={() => navigate(-1)}>← Back</button>
        </div>
        <p style={{ color: 'var(--red)', padding: '24px', fontSize: '14px' }}>Invalid mint URL.</p>
      </div>
    )
  }

  return <MintDetailContent url={decodeURIComponent(rawUrl)} />
}
