import { useState, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Info } from 'lucide-react'
import { useKnownMints, type KnownMint } from '@/hooks/useKnownMints'
import { MintFavicon } from '@/components/mint/MintFavicon'
import { IcShield } from '@/components/mint/IcShield'
import { useNow } from '@/hooks/useNow'
import { useTapTooltip } from '@/hooks/useTapTooltip'
import { parseCashuToken, formatTokenAmount, decodeTokenWithMint, checkTokenSpentState, InvalidMintUrlError, type TokenInfo, type TokenSpentCheck } from '@/utils/cashuToken'
import { normalizeMintUrl, trustColor, trustScoreInfo, mintRiskLevel } from '@/utils/mintFormatting'
import { isTestMint } from '@/constants/testMints'
import './Tools.css'

function getHostname(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

// Same hover-on-desktop/tap-on-mobile pattern as Stats.tsx's header ⓘ tooltips
// (useTapTooltip + the shared .audit-tooltip styling) — reused here so the DLEQ
// and NUT-07 explanations don't have to sit in the main view as permanent text.
function InfoTooltip({ text, width = 220 }: { text: string; width?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const tooltip = useTapTooltip(ref)
  return (
    <span
      ref={ref}
      className="token-info-icon"
      onPointerEnter={tooltip.onPointerEnter}
      onPointerLeave={tooltip.onPointerLeave}
      onClick={tooltip.onClick}
    >
      <Info size={12} color="#6b7280" style={{ flexShrink: 0, cursor: 'help' }} />
      {tooltip.open && (
        <div className="audit-tooltip" style={{ width }}>{text}</div>
      )}
    </span>
  )
}

// DLEQ verification's outcome, once it has run. "unreachable" is deliberately distinct
// from "invalid": failing to reach the mint tells us nothing about the token, while
// "invalid" is a positive finding that the signature does not check out.
type VerifyResult =
  | { status: 'valid'; count: number }
  | { status: 'invalid' }
  | { status: 'no-dleq' }
  | { status: 'unreachable' }
  | { status: 'bad-mint-url'; message: string }

// The combined flow runs two phases back to back: a synchronous local parse, then a
// live DLEQ check against the mint. Tracked separately from VerifyResult so the button
// label and loading row can distinguish "reading the token" from "waiting on the
// network" instead of collapsing both into one generic spinner.
type Phase = 'idle' | 'inspecting' | 'verifying'

// The "Check if spent" NUT-07 check is a separate, user-initiated action from
// the Inspect & Verify flow above — it asks the mint a different question
// (has this proof already been redeemed?) and, unlike DLEQ, tells the mint
// operator that someone is looking at this specific token right now. Kept on
// its own state machine so it never fires automatically alongside inspection.
type SpentCheckResult =
  | { status: 'ok'; data: TokenSpentCheck }
  | { status: 'error'; message: string }
  | { status: 'bad-mint-url'; message: string }

function TokenInspector({ knownMints }: { knownMints: KnownMint[] }) {
  const navigate = useNavigate()
  const now = useNow()
  const [input, setInput] = useState('')
  const [result, setResult] = useState<TokenInfo | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [inspected, setInspected] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [verify, setVerify] = useState<VerifyResult | null>(null)
  const [checkingSpent, setCheckingSpent] = useState(false)
  const [spentResult, setSpentResult] = useState<SpentCheckResult | null>(null)

  const knownMap = useMemo(() => {
    const m = new Map<string, KnownMint>()
    for (const mint of knownMints) m.set(mint.url, mint)
    return m
  }, [knownMints])

  const mintInfo = useMemo(() => {
    if (!result) return null
    const normalized = normalizeMintUrl(result.mint)
    return knownMap.get(normalized) ?? knownMap.get(result.mint) ?? null
  }, [result, knownMap])

  const riskInfo = mintRiskLevel(mintInfo ? { online: mintInfo.online, degraded: mintInfo.degraded, trustScore: mintInfo.trustScore } : null)

  const handleInspectAndVerify = async () => {
    const token = input.trim()
    if (!token) return
    setInspected(true)
    setVerify(null)
    setSpentResult(null)
    setPhase('inspecting')

    // The local parse below is synchronous and effectively instant, so without a
    // deliberate minimum display time "Inspecting…" would never be perceptible — it'd
    // be replaced by "Verifying…" before a human eye could register it. This holds the
    // first phase on screen long enough to actually read, not just technically paint.
    await new Promise<void>(resolve => setTimeout(resolve, 300))

    const { info, error } = parseCashuToken(token)
    if (!info) {
      setParseError(error ?? 'Could not decode this token.')
      setResult(null)
      setPhase('idle')
      return
    }
    setParseError(null)
    setResult(info)

    // DLEQ needs the mint reachable, so a malformed token above never reaches this —
    // no wasted network call for input that was never going to verify anyway.
    setPhase('verifying')
    try {
      const decoded = await decodeTokenWithMint(token)
      if (decoded.proofsWithDleq === 0) {
        // The mint issued these proofs without DLEQ data, so there is simply nothing
        // to check — not a pass, not a failure.
        setVerify({ status: 'no-dleq' })
      } else if (decoded.allDleqValid) {
        setVerify({ status: 'valid', count: decoded.proofs.length })
      } else {
        setVerify({ status: 'invalid' })
      }
    } catch (err) {
      if (err instanceof InvalidMintUrlError) {
        // The token names a mint URL we refuse to contact (not https://, or a
        // non-public host) — a positive finding about the token, not a transport
        // problem. No network request was made.
        setVerify({ status: 'bad-mint-url', message: err.message })
      } else {
        // Any other throw is a transport/mint problem (loadMint failed, timeout,
        // keyset missing) — never evidence that the token itself is bad. The
        // parse result set above stays on screen regardless.
        setVerify({ status: 'unreachable' })
      }
    }
    setPhase('idle')
  }

  const handleCheckSpent = async () => {
    const token = input.trim()
    if (!token || checkingSpent) return
    setCheckingSpent(true)
    setSpentResult(null)
    const startedAt = Date.now()

    let outcome: SpentCheckResult
    try {
      const data = await checkTokenSpentState(token)
      outcome = { status: 'ok', data }
    } catch (err) {
      if (err instanceof InvalidMintUrlError) {
        // No network request was made — the token names a mint URL we refuse to
        // contact. This IS a finding about the token.
        outcome = { status: 'bad-mint-url', message: err.message }
      } else {
        // Mint offline/unreachable, or the token itself couldn't be resolved —
        // either way this must not take down the rest of the inspector UI.
        const detail = err instanceof Error && err.message ? err.message : 'Could not reach the mint.'
        outcome = { status: 'error', message: detail }
      }
    }

    // A local/cached mint response can resolve in well under 100ms, which made the
    // "Checking with mint…" label flash and vanish — read as a glitch rather than a
    // deliberate loading state. Holding the button on screen for at least 300ms total
    // (same floor used by the Inspect & Verify flow above) makes it read as an actual
    // network round trip regardless of how fast the real one was.
    const elapsed = Date.now() - startedAt
    if (elapsed < 300) await new Promise<void>(resolve => setTimeout(resolve, 300 - elapsed))

    setSpentResult(outcome)
    setCheckingSpent(false)
  }

  return (
    <div className="tool-card">
      <div className="tool-header">
        <div className="tool-title">Token Inspector</div>
        <div className="tool-subtitle">Paste a Cashu token (v3 or v4) to inspect its mint, amount, and trust status before redeeming</div>
      </div>

      <textarea
        className="token-input"
        placeholder="cashuB… (v4) or cashuA… (v3)"
        value={input}
        onChange={e => { setInput(e.target.value); setInspected(false); setResult(null); setParseError(null); setVerify(null); setPhase('idle'); setSpentResult(null); setCheckingSpent(false) }}
        rows={3}
        spellCheck={false}
      />

      <button
        type="button"
        className="tool-btn-primary inspect-token-btn"
        onClick={() => void handleInspectAndVerify()}
        disabled={!input.trim() || phase !== 'idle'}
      >
        {phase === 'inspecting' ? '🔎 Inspecting…' : phase === 'verifying' ? '🔐 Verifying with mint…' : 'Inspect & Verify Token'}
      </button>

      {parseError && inspected && (
        <div className="token-error">{parseError}</div>
      )}

      {result && (
        <>
          <div className="token-result-grid">
            <div className="token-result-cell">
              <div className="trc-label">Mint</div>
              <div className="trc-value">{mintInfo?.name ?? getHostname(result.mint)}</div>
              <div className="trc-sub">{getHostname(result.mint)}</div>
              <span
                className="token-risk-badge"
                style={{ color: riskInfo.color, background: riskInfo.bg, border: `1px solid ${riskInfo.border}` }}
              >
                <IcShield size={11} /><span>{riskInfo.label}</span>
              </span>
            </div>
            <div className="token-result-cell">
              <div className="trc-label">Amount</div>
              <div className="trc-value trc-accent">{formatTokenAmount(result.amount, result.unit)}</div>
              <div className="trc-sub">{result.unit}</div>
            </div>
            <div className="token-result-cell">
              <div className="trc-label">Mint Status</div>
              {mintInfo ? (
                <>
                  <div className="trc-value" style={{ color: mintInfo.online === true ? '#17E87F' : '#E24B4A' }}>
                    {mintInfo.online === true ? '● Online' : mintInfo.online === false ? '● Offline' : '○ Unknown'}
                  </div>
                  {mintInfo.lastCheckedAt && (
                    <div className="trc-sub">
                      checked {Math.round((now - new Date(mintInfo.lastCheckedAt).getTime()) / 60000)}m ago
                    </div>
                  )}
                </>
              ) : (
                <div className="trc-value trc-muted">Not in database</div>
              )}
            </div>
            <div className="token-result-cell">
              <div className="trc-label">Trust Score</div>
              {mintInfo?.trustScore != null ? (
                <>
                  <div className="trc-value" style={{ color: trustColor(mintInfo.trustScore) }}>{mintInfo.trustScore}%</div>
                  <div className="trc-sub" style={{ color: trustColor(mintInfo.trustScore) }}>
                    {trustScoreInfo(mintInfo.trustScore).label}
                  </div>
                </>
              ) : (
                <div className="trc-value trc-muted">—</div>
              )}
            </div>
          </div>

          <div className="token-details-row">
            <span className="tdr-item"><span className="tdr-label">Version</span>{result.version}</span>
            <span className="tdr-sep">·</span>
            {result.proofsCount !== null && (<>
              <span className="tdr-item"><span className="tdr-label">Proofs</span>{result.proofsCount}</span>
              <span className="tdr-sep">·</span>
            </>)}
            <span className="tdr-item"><span className="tdr-label">Unit</span>{result.unit}</span>
          </div>

          {result.memo && (
            <div className="token-memo-row"><span className="tdr-label">Memo</span> {result.memo}</div>
          )}

          <div className="token-verify">
            <div className="token-section-label">
              <span>Signature check</span>
              <InfoTooltip text="This confirms the token is real and genuinely came from this mint — a cryptographic check, separate from the mint's reputation shown above." />
            </div>
            {phase === 'verifying' && (
              <div className="token-verify-result tv-loading">
                🔐 Verifying with mint… checking this token's signatures against its NUT-12 DLEQ proof.
              </div>
            )}
            {verify?.status === 'valid' && (
              <div className="token-verify-result tv-ok">
                ✅ Cryptographically verified — all {verify.count} proof{verify.count === 1 ? '' : 's'} carry a
                valid mint signature (NUT-12 DLEQ).
              </div>
            )}
            {verify?.status === 'invalid' && (
              <div className="token-verify-result tv-bad">
                ❌ Invalid signature — do not trust this token. At least one proof failed its DLEQ check.
              </div>
            )}
            {verify?.status === 'no-dleq' && (
              <div className="token-verify-result tv-unknown">
                ➖ Nothing to verify — this token carries no DLEQ data, so its signatures can't be checked
                offline. That is a property of the issuing mint, not a sign the token is bad.
              </div>
            )}
            {verify?.status === 'unreachable' && (
              <div className="token-verify-result tv-unknown">
                ⚠️ Could not reach mint to verify (try again later). This says nothing about the token itself.
              </div>
            )}
            {verify?.status === 'bad-mint-url' && (
              <div className="token-verify-result tv-bad">
                ❌ {verify.message} A legitimate Cashu token points at a public https:// mint.
              </div>
            )}
          </div>

          <div className="token-spent">
            <div className="token-spent-row">
              <button
                type="button"
                className="token-action-btn"
                onClick={() => void handleCheckSpent()}
                disabled={checkingSpent}
              >
                {checkingSpent ? '🔍 Checking with mint…' : '🔍 Check if spent'}
              </button>
              <InfoTooltip text="This asks the mint directly whether the token has already been used. Doing so lets the mint know someone is checking it right now." />
            </div>

            {spentResult?.status === 'ok' && (() => {
              const { total, unspent, spent, pending } = spentResult.data
              if (spent === total) {
                return (
                  <div className="token-verify-result tv-bad">
                    ❌ All {total} proof{total === 1 ? '' : 's'} already spent — this token has already been redeemed elsewhere.
                  </div>
                )
              }
              if (unspent === total) {
                return (
                  <div className="token-verify-result tv-ok">
                    ✅ All {total} proof{total === 1 ? '' : 's'} unspent — this token has not been redeemed yet.
                  </div>
                )
              }
              return (
                <div className="token-verify-result tv-unknown">
                  ⚠️ {unspent}/{total} proofs unspent, {spent} already spent{pending > 0 ? `, ${pending} pending` : ''} — this token is only partially usable.
                </div>
              )
            })()}
            {spentResult?.status === 'error' && (
              <div className="token-verify-result tv-unknown">
                ⚠️ Could not check spent status — {spentResult.message} This says nothing about the token itself.
              </div>
            )}
            {spentResult?.status === 'bad-mint-url' && (
              <div className="token-verify-result tv-bad">
                ❌ {spentResult.message} A legitimate Cashu token points at a public https:// mint.
              </div>
            )}
          </div>

          <div className="token-actions">
            {mintInfo && (
              <button type="button" className="token-action-btn" onClick={() => navigate(`/mint/${encodeURIComponent(result.mint)}`)}>
                → View Mint Detail
              </button>
            )}
            {/* Both deep links were verified against the tools' own sources, not guessed:
                wallet.cashu.me reads `?token=` in WalletPage.vue's created() hook
                (cashubtc/cashu.me @ b51fee3), and redeem.cashu.me reads the same `?token=`
                param in its client bundle. rel="noreferrer" keeps the token out of the
                Referer header on the way there. */}
            <a
              className="token-action-btn"
              href={`https://wallet.cashu.me/?token=${encodeURIComponent(input.trim())}`}
              target="_blank"
              rel="noreferrer"
            >
              ↗ Open in wallet
            </a>
            <a
              className="token-action-btn"
              href={`https://redeem.cashu.me/?token=${encodeURIComponent(input.trim())}`}
              target="_blank"
              rel="noreferrer"
            >
              ⚡ Redeem to Lightning
            </a>
          </div>
        </>
      )}
    </div>
  )
}

type Preference = 'speed' | 'trust' | 'features'
type BackupPref = 'yes' | 'no' | 'unsure'
type SizeOption = 'small' | 'medium' | 'large'

interface UnitLimits { min: number | null; max: number | null }
interface WizardRec {
  url: string
  mint: KnownMint
  score: number
  latencyMs: number | null
  mintLimits: UnitLimits | null
  meltLimits: UnitLimits | null
}

// Collapses a mint's NUT-04/NUT-05 method entries for one unit into a single
// min/max range — a mint can advertise several methods (bolt11, bolt12, …) per
// unit, each with its own limits, so the widest usable range is what the user
// actually faces.
function limitsForUnit(methods: KnownMint['mintMethods'], unit: string): UnitLimits | null {
  const forUnit = (methods ?? []).filter(m => m.unit === unit)
  if (forUnit.length === 0) return null
  const mins: number[] = []
  const maxs: number[] = []
  for (const m of forUnit) {
    const min = m['min_amount']
    const max = m['max_amount']
    if (typeof min === 'number') mins.push(min)
    if (typeof max === 'number') maxs.push(max)
  }
  if (mins.length === 0 && maxs.length === 0) return null
  return {
    min: mins.length > 0 ? Math.min(...mins) : null,
    max: maxs.length > 0 ? Math.max(...maxs) : null,
  }
}

function formatLimits(limits: UnitLimits | null, unit: string): string | null {
  if (!limits) return null
  const min = limits.min !== null ? limits.min.toLocaleString() : '—'
  const max = limits.max !== null ? limits.max.toLocaleString() : '∞'
  return `${min}–${max} ${unit}`
}

const BASE_WEIGHTS: Record<Preference, { latency: number; trust: number; nuts: number }> = {
  speed:    { latency: 0.6, trust: 0.3, nuts: 0.1 },
  trust:    { latency: 0.2, trust: 0.7, nuts: 0.1 },
  features: { latency: 0.2, trust: 0.3, nuts: 0.5 },
}

// Larger stored balances carry more risk if the mint turns out unreliable, so
// shift weight toward trust — proportionally reducing latency/nuts so the
// three weights still sum to 1.
const LARGE_TRUST_BOOST = 0.15

function weightsFor(preference: Preference, size: SizeOption): { latency: number; trust: number; nuts: number } {
  const base = BASE_WEIGHTS[preference]
  if (size !== 'large') return base
  const scale = (1 - base.trust - LARGE_TRUST_BOOST) / (1 - base.trust)
  return { latency: base.latency * scale, trust: base.trust + LARGE_TRUST_BOOST, nuts: base.nuts * scale }
}

function BestMintWizard({ knownMints }: { knownMints: KnownMint[] }) {
  const navigate = useNavigate()
  const [step, setStep] = useState(1)
  const [unit, setUnit] = useState<string | null>(null)
  const [size, setSize] = useState<SizeOption | null>(null)
  const [preference, setPreference] = useState<Preference | null>(null)
  const [backupPref, setBackupPref] = useState<BackupPref | null>(null)
  const [finding, setFinding] = useState(false)
  const [recs, setRecs] = useState<WizardRec[] | null>(null)
  const [recsUnit, setRecsUnit] = useState<string | null>(null)

  // Built from the distinct units the online mints actually advertise, never a
  // hardcoded sat/usd/eur list — a mint offering a new unit shows up here on its
  // own. 'sat' is pinned first because it is the ecosystem default.
  const availableUnits = useMemo(() => {
    const set = new Set<string>()
    for (const m of knownMints) {
      if (m.online !== true) continue
      for (const u of m.units ?? []) set.add(u)
    }
    return [...set].sort((a, b) => a === 'sat' ? -1 : b === 'sat' ? 1 : a.localeCompare(b))
  }, [knownMints])

  const selectedUnit = unit ?? availableUnits[0] ?? null

  const ready = selectedUnit !== null && size !== null && preference !== null && backupPref !== null

  const handleFind = async () => {
    if (!preference || !size || !selectedUnit) return
    setFinding(true)
    setRecs(null)

    const candidates = knownMints
      .filter(m => m.online === true && m.trustScore != null)
      // Dev/test-only mints (fake sats, "do not use as default", etc.) are
      // real and findable via Dashboard/Watchlist/Search, but the wizard is
      // an active recommendation — never suggest one as someone's mint.
      .filter(m => !isTestMint(m.url))
      // A mint that doesn't issue this unit can't serve the user at all, so it
      // is dropped before scoring rather than ranked and then explained away.
      .filter(m => (m.units ?? []).includes(selectedUnit))
      .filter(m => {
        if (backupPref !== 'yes') return true
        // NUT-9 (restore signatures) is the mint-side capability that actually
        // gates seed-phrase backup/restore — see the note in MintDetail.tsx.
        return m.nutsLimits?.['9'] != null
      })
      .sort((a, b) => (b.trustScore ?? 0) - (a.trustScore ?? 0))
      .slice(0, 20)

    const w = weightsFor(preference, size)

    const latencyResults = await Promise.allSettled(
      candidates.map(async m => {
        const start = Date.now()
        try {
          const r = await fetch(`${m.url}/v1/info`, { signal: AbortSignal.timeout(5000) })
          if (!r.ok) return { url: m.url, latencyMs: null }
          return { url: m.url, latencyMs: Date.now() - start }
        } catch { return { url: m.url, latencyMs: null } }
      })
    )

    const latencyMap = new Map<string, number | null>()
    for (const r of latencyResults) {
      if (r.status === 'fulfilled') latencyMap.set(r.value.url, r.value.latencyMs)
    }

    const maxLatency = Math.max(...[...latencyMap.values()].filter((v): v is number => v !== null), 1)
    const maxNuts = Math.max(...candidates.map(m => m.nutCount ?? 0), 1)

    const scored: WizardRec[] = candidates.map(m => {
      const latMs = latencyMap.get(m.url) ?? null
      const latScore = latMs !== null ? 1 - latMs / maxLatency : 0
      const trustScore = (m.trustScore ?? 0) / 100
      const nutsScore = (m.nutCount ?? 0) / maxNuts
      return {
        url: m.url,
        mint: m,
        score: w.latency * latScore + w.trust * trustScore + w.nuts * nutsScore,
        latencyMs: latMs,
        mintLimits: limitsForUnit(m.mintMethods ?? null, selectedUnit),
        meltLimits: limitsForUnit(m.meltMethods ?? null, selectedUnit),
      }
    }).sort((a, b) => b.score - a.score).slice(0, 3)

    setRecs(scored)
    setRecsUnit(selectedUnit)
    setFinding(false)
  }

  const scoreColor = (s: number) => s >= 70 ? '#4ade80' : s >= 40 ? '#f59e0b' : '#E24B4A'

  return (
    <div className="tool-card">
      <div className="tool-header">
        <div className="tool-title">Best Mint for Me</div>
        <div className="tool-subtitle">Answer a few quick questions and we'll recommend the best mints for your needs · latency measured from your browser</div>
      </div>

      <div className="wizard-steps">
        {[1, 2, 3].map(n => (
          <div key={n} className={`wizard-step-dot${step >= n ? ' active' : ''}${step > n ? ' done' : ''}`}>
            {step > n ? '✓' : n}
          </div>
        ))}
        <div className="wizard-step-line" />
      </div>

      {step === 1 && (
        <div className="wizard-step-body">
          <div className="wizard-q">Which currency do you want to hold?</div>
          {availableUnits.length === 0 ? (
            <div className="wizard-no-results">No unit data available yet — mints report their units on the next probe cycle.</div>
          ) : (
            <select
              className="wizard-unit-select"
              value={selectedUnit ?? ''}
              onChange={e => { setUnit(e.target.value); setRecs(null) }}
              aria-label="Currency unit"
            >
              {availableUnits.map(u => (
                <option key={u} value={u}>{u.toUpperCase()}</option>
              ))}
            </select>
          )}

          <div className="wizard-q">How much do you plan to store?</div>
          <div className="wizard-options">
            {[
              { id: 'small' as SizeOption, label: 'Small', sub: '< 10k sats' },
              { id: 'medium' as SizeOption, label: 'Medium', sub: '10k–100k sats' },
              { id: 'large' as SizeOption, label: 'Large', sub: '> 100k sats' },
            ].map(opt => (
              <button key={opt.id} type="button" className={`wizard-opt${size === opt.id ? ' active' : ''}`}
                onClick={() => { setSize(opt.id); setStep(2) }}>
                <div className="wizard-opt-label">{opt.label}</div>
                <div className="wizard-opt-sub">{opt.sub}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="wizard-step-body">
          <div className="wizard-q">What matters most to you?</div>
          <div className="wizard-options">
            {[
              { id: 'speed' as Preference, label: '⚡ Speed', sub: 'I want the fastest mint from my location' },
              { id: 'trust' as Preference, label: '🛡 Trust', sub: 'I want the most reliable and audited mint' },
              { id: 'features' as Preference, label: '🧩 Features', sub: 'I have specific security/backup needs' },
            ].map(opt => (
              <button key={opt.id} type="button" className={`wizard-opt${preference === opt.id ? ' active' : ''}`}
                onClick={() => { setPreference(opt.id); setStep(3) }}>
                <div className="wizard-opt-label">{opt.label}</div>
                <div className="wizard-opt-sub">{opt.sub}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="wizard-step-body">
          <div className="wizard-q">Do you want to be able to restore your wallet from a backup phrase if you lose your device?</div>
          <div className="wizard-options wizard-options-row">
            {[
              { id: 'yes' as BackupPref, label: 'Yes' },
              { id: 'no' as BackupPref, label: 'No' },
              { id: 'unsure' as BackupPref, label: 'Not sure' },
            ].map(opt => (
              <button key={opt.id} type="button" className={`wizard-opt${backupPref === opt.id ? ' active' : ''}`}
                onClick={() => setBackupPref(opt.id)}>
                <div className="wizard-opt-label">{opt.label}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 3 && (
        <button type="button" className="tool-btn-primary" disabled={!ready || finding} onClick={() => void handleFind()}>
          {finding ? 'Measuring latency…' : 'Find my mints →'}
        </button>
      )}

      {step > 1 && !recs && (
        <button type="button" className="wizard-back-btn" onClick={() => { setStep(s => s - 1); setRecs(null) }}>
          ← Back
        </button>
      )}

      {recs !== null && (
        <div className="wizard-results">
          {recs.length === 0 ? (
            <div className="wizard-no-results">No online mint supports {recsUnit} with the options you picked. Try another currency or change your answers.</div>
          ) : (
            recs.map((rec, idx) => {
              const hostname = getHostname(rec.url)
              const score = rec.mint.trustScore ?? 0
              const unitLabel = recsUnit ?? ''
              const mintRange = formatLimits(rec.mintLimits, unitLabel)
              const meltRange = formatLimits(rec.meltLimits, unitLabel)
              return (
                <div key={rec.url} className="wizard-rec-row" onClick={() => navigate(`/mint/${encodeURIComponent(rec.url)}`)}>
                  <span className="wizard-rank">#{idx + 1}</span>
                  <MintFavicon url={rec.url} iconUrl={rec.mint.iconUrl ?? null} size={28} radius={6} />
                  <div className="wizard-rec-info">
                    <div className="wizard-rec-name">{rec.mint.name ?? hostname}</div>
                    <div className="wizard-rec-meta">
                      {rec.latencyMs != null && <span>{rec.latencyMs}ms from your location</span>}
                      {rec.mint.uptimePct24h != null && <span>· {rec.mint.uptimePct24h}% uptime</span>}
                      {rec.mint.nutCount != null && <span>· {rec.mint.nutCount} NUTs</span>}
                    </div>
                    <div className="wizard-rec-limits">
                      {(mintRange ?? meltRange) !== null ? (
                        <>
                          {mintRange && <span>Mint {mintRange}</span>}
                          {mintRange && meltRange && <span> · </span>}
                          {meltRange && <span>Melt {meltRange}</span>}
                        </>
                      ) : (
                        <span>No {unitLabel} limits published by this mint</span>
                      )}
                    </div>
                  </div>
                  <span className="wizard-rec-score" style={{ color: scoreColor(score) }}>{score}%</span>
                  <span className="wizard-rec-view">View →</span>
                </div>
              )
            })
          )}
          {recs.length > 0 && (
            <div className="wizard-rec-note">
              Trust Score reflects the whole mint, not this specific currency — uptime, NUT support and
              version freshness are measured per mint. Only the limits above are {recsUnit}-specific.
            </div>
          )}
          <button type="button" className="wizard-back-btn" style={{ marginTop: 8 }}
            onClick={() => { setStep(1); setSize(null); setPreference(null); setBackupPref(null); setRecs(null); setRecsUnit(null) }}>
            ← Start over
          </button>
        </div>
      )}
    </div>
  )
}

export default function Tools() {
  const { data: knownMintsData } = useKnownMints()
  const mints = knownMintsData ?? []

  return (
    <div className="tools-page">
      <div className="tools-grid">
        <TokenInspector knownMints={mints} />
        <BestMintWizard knownMints={mints} />
      </div>
    </div>
  )
}
