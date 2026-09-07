import { describe, it, expect } from 'vitest'
import { computeServerTrustScore, serverVersionFreshnessScore } from '../prober.js'

// computeServerTrustScore weighting:
//   uptime 45% | NUT support 30% | version freshness 15% | contact 5% | audit 5%
// Signature: (uptimePct, nutCount, version, contactCount, auditRecentTotal, auditRecentErrors)
// auditRecentTotal/auditRecentErrors are counts over a rolling window of the mint's last
// ~100 swaps (see discovery.ts's fetchRecentSwapStats), not audit.8333.space's cumulative
// lifetime counters.
describe('computeServerTrustScore', () => {
  it('returns ~100 for a perfect mint (100% on every component)', () => {
    // uptime 100→45, nutCount 25→30, version 0.20→15, contact 3→5, audit errRate 0→5
    expect(computeServerTrustScore(100, 25, 'Nutshell/0.20', 3, 100, 0)).toBe(100)
  })

  it('a mint maxed on every component scores exactly 100', () => {
    // uptime 45 + NUT 30 (28 nuts → cap 30) + version 15 + contact 5 (6 → clamp 3 → 5)
    // + audit 5 = 100. Every component is individually capped at its weight now, so
    // Math.min(100, …) is belt-and-suspenders rather than load-bearing.
    expect(computeServerTrustScore(100, 28, 'Nutshell/0.20', 6, 100, 0)).toBe(100)
  })

  it('returns a low, finite score for a mint with no data (no crash, no NaN)', () => {
    // all zero/null → only audit default (auditRecentTotal null → 2.5) contributes; round(2.5)=3
    const score = computeServerTrustScore(0, null, null, 0, null, null)
    expect(score).toBe(3)
    expect(Number.isFinite(score)).toBe(true)
    expect(Number.isNaN(score)).toBe(false)
  })

  it('computes from remaining components when audit data is missing', () => {
    // 45 + 30 + 15 + 5 + (audit null →2.5) = 97.5 → round 98
    expect(computeServerTrustScore(100, 25, 'Nutshell/0.20', 3, null, null)).toBe(98)
  })

  describe('uptime component (45%)', () => {
    it('contributes 0 at 0% uptime', () => {
      // baseline: everything else zero, audit null → 2.5 → 3
      expect(computeServerTrustScore(0, null, null, 0, null, null)).toBe(3)
    })
    it('contributes 45 at 100% uptime', () => {
      // 45 + audit(null→2.5) = 47.5 → 48
      expect(computeServerTrustScore(100, null, null, 0, null, null)).toBe(48)
    })
  })

  describe('NUT support component (30%)', () => {
    it('contributes 0 with 0 nuts', () => {
      expect(computeServerTrustScore(0, 0, null, 0, null, null)).toBe(3) // 0 + 2.5
    })
    it('contributes 30 at 25 nuts', () => {
      // 0 + 30 + 2.5 = 32.5 → 33
      expect(computeServerTrustScore(0, 25, null, 0, null, null)).toBe(33)
    })
    it('caps NUT support at 25 nuts (50 nuts gives the same score)', () => {
      expect(computeServerTrustScore(0, 50, null, 0, null, null)).toBe(33)
    })
  })

  describe('contact component (5%) — clamped at 3 contacts (audit finding H1 regression)', () => {
    it('contributes 0 with no contacts', () => {
      expect(computeServerTrustScore(0, null, null, 0, null, null)).toBe(3)
    })
    it('contributes 5 with 3 contacts', () => {
      // 0 + 5 + 2.5 = 7.5 → 8
      expect(computeServerTrustScore(0, null, null, 3, null, null)).toBe(8)
    })
    it('3, 6 and 60 contacts all score identically — the component never exceeds its 5-point weight', () => {
      // `contactCount` comes from the mint's own /v1/info `contact` array (untrusted).
      // A mint could list arbitrarily many entries; the clamp to 3 means every count
      // ≥ 3 yields the same 0 + 5 + (audit null → 2.5) = 7.5 → 8.
      const at3 = computeServerTrustScore(0, null, null, 3, null, null)
      const at6 = computeServerTrustScore(0, null, null, 6, null, null)
      const at60 = computeServerTrustScore(0, null, null, 60, null, null)
      expect(at3).toBe(8)
      expect(at6).toBe(8)
      expect(at60).toBe(8)
    })
    it('a mint cannot inflate its whole Trust Score via contact count (audit finding H1)', () => {
      // Before the fix: contactCount 60 → cScore round(60/3*5) = 100 → the total
      // saturated at 100 regardless of uptime / NUT support / version. After the fix
      // the score reflects the real signal: 0 uptime, no NUTs, no version, 60 contacts
      // → 0 + 0 + 0 + 5 + (audit null → 2.5) = 7.5 → 8, nowhere near 100.
      const score = computeServerTrustScore(0, null, null, 60, null, null)
      expect(score).toBe(8)
      expect(score).toBeLessThan(100)
    })
  })

  describe('audit reliability component (5%) — rolling window of last ~100 swaps', () => {
    const base = (total: number | null, errors: number) =>
      computeServerTrustScore(0, null, null, 0, total, errors)
    it('gives 2.5 (→ rounds with baseline to 3) when auditRecentTotal is null (no audit data)', () => {
      expect(base(null, 0)).toBe(3)
    })
    it('gives 2.5 (→ 3) when auditRecentTotal is below the minimum sample size (Unknown)', () => {
      expect(base(1, 0)).toBe(3)
      expect(base(2, 1)).toBe(3)
    })
    it('gives 5 for a zero error rate at the minimum sample size', () => {
      expect(base(3, 0)).toBe(5)
    })
    it('gives 5 for a zero error rate', () => {
      expect(base(150, 0)).toBe(5) // errRate 0 → aScore 5
    })
    it('gives 4 for error rate < 0.01', () => {
      expect(base(1000, 5)).toBe(4) // 5/1000 = 0.005
    })
    it('gives 3 for error rate < 0.05', () => {
      expect(base(100, 3)).toBe(3) // 3/100 = 0.03
    })
    it('gives 2 for error rate < 0.15', () => {
      expect(base(100, 10)).toBe(2) // 10/100 = 0.10
    })
    it('gives 1 for error rate >= 0.15', () => {
      expect(base(20, 10)).toBe(1) // 10/20 = 0.5
    })
    it('an old mint with historical errors is not penalized once its recent swaps are clean', () => {
      // Represents the scenario this rolling window exists to fix: a mint with a rocky
      // past (reflected in audit.8333.space's cumulative lifetime counters) but a clean
      // last ~100 swaps scores full marks, unlike the old cumulative-count calculation.
      expect(base(100, 0)).toBe(5)
    })
  })

  describe('negative / null inputs never crash or return NaN', () => {
    it('handles negative uptime without NaN', () => {
      const score = computeServerTrustScore(-50, null, null, 0, null, null)
      expect(Number.isFinite(score)).toBe(true)
      expect(Number.isNaN(score)).toBe(false)
    })
    it('handles negative nutCount without NaN', () => {
      const score = computeServerTrustScore(0, -5, null, 0, null, null)
      expect(Number.isFinite(score)).toBe(true)
      expect(Number.isNaN(score)).toBe(false)
    })
    it('handles all-null inputs without NaN', () => {
      const score = computeServerTrustScore(0, null, null, 0, null, null)
      expect(Number.isNaN(score)).toBe(false)
    })
  })
})

describe('serverVersionFreshnessScore', () => {
  it('returns 0 for null / undefined / empty', () => {
    expect(serverVersionFreshnessScore(null)).toBe(0)
    expect(serverVersionFreshnessScore(undefined)).toBe(0)
    expect(serverVersionFreshnessScore('')).toBe(0)
  })

  it('returns 2.5 for a string with no recognizable software name (no "/", same neutral default as Unknown audit reliability)', () => {
    expect(serverVersionFreshnessScore('garbage')).toBe(2.5)
    expect(serverVersionFreshnessScore('12')).toBe(2.5)
    expect(serverVersionFreshnessScore('0.20')).toBe(2.5)
  })

  it('returns 3 for a recognized software with an unparseable version number', () => {
    expect(serverVersionFreshnessScore('Nutshell/garbage')).toBe(3)
    expect(serverVersionFreshnessScore('Nutshell/12')).toBe(3) // no dot
  })

  it('scores the newest known Nutshell version highest', () => {
    expect(serverVersionFreshnessScore('Nutshell/0.20')).toBe(10)
  })

  it('decreases by 2 per version step, floored at 0 five steps back', () => {
    expect(serverVersionFreshnessScore('Nutshell/0.19')).toBe(8)
    expect(serverVersionFreshnessScore('Nutshell/0.18')).toBe(6)
    expect(serverVersionFreshnessScore('Nutshell/0.17')).toBe(4)
    expect(serverVersionFreshnessScore('Nutshell/0.16')).toBe(2)
    expect(serverVersionFreshnessScore('Nutshell/0.15')).toBe(0)
    expect(serverVersionFreshnessScore('Nutshell/0.11')).toBe(0)
  })

  it('returns 0 for a version older than the known list', () => {
    expect(serverVersionFreshnessScore('Nutshell/0.10')).toBe(0)
  })

  it('treats a future/newer Nutshell version as freshest', () => {
    expect(serverVersionFreshnessScore('Nutshell/1.0')).toBe(10)
    expect(serverVersionFreshnessScore('Nutshell/0.21')).toBe(10)
  })

  it('matches the first major.minor inside a longer version string', () => {
    expect(serverVersionFreshnessScore('Nutshell/0.20.3')).toBe(10)
    expect(serverVersionFreshnessScore('Nutshell/0.19.1')).toBe(8)
  })

  it('recognizes cdk-mintd against its own (not Nutshell\'s) leaderboard', () => {
    expect(serverVersionFreshnessScore('cdk-mintd/0.17.5')).toBe(10) // current version — was wrongly scored as a stale Nutshell before
    expect(serverVersionFreshnessScore('cdk-mintd/0.16.0')).toBe(8)
    expect(serverVersionFreshnessScore('cdk-mintd/0.9.0')).toBe(0)
  })

  it('strips a leading "v" and a "-rc.N" prerelease suffix before comparing', () => {
    expect(serverVersionFreshnessScore('cdk-mintd/v0.17.5')).toBe(10)
    expect(serverVersionFreshnessScore('cdk-mintd/0.17.0-rc.3')).toBe(10) // 0.17 still matches the top rung
  })

  it('scores unrecognized software neutrally instead of 0 or an automatic 10 (the bug this fixes)', () => {
    // A higher major version on unknown software no longer auto-wins full marks.
    expect(serverVersionFreshnessScore('LekMint/1.1.1')).toBe(2.5)
    // Similarly-named but distinct software must not prefix-match "nutshell".
    expect(serverVersionFreshnessScore('Nutshell-CF/1.0.0')).toBe(2.5)
  })

  it('prefers the latestVersions cache over the static fallback ladder when supplied', () => {
    const latest = { cdk: { major: 0, minor: 18 } }
    // 0.17.5 is now one step behind the (hypothetical) cached latest of 0.18.
    expect(serverVersionFreshnessScore('cdk-mintd/0.17.5', latest)).toBe(8)
    expect(serverVersionFreshnessScore('cdk-mintd/0.18.0', latest)).toBe(10)
  })
})
