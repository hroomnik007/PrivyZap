import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Amount, getEncodedToken, CheckStateEnum, Wallet } from '@cashu/cashu-ts'
import {
  parseCashuToken, formatTokenAmount, checkTokenSpentState, decodeTokenWithMint,
  assertProbeableMintUrl, InvalidMintUrlError,
} from '../utils/cashuToken'

// checkTokenSpentState() needs a live mint (Wallet.loadMint/checkProofsStates), so the
// mint-reachability half is mocked here — same approach the DLEQ code path would need,
// but that one is exercised via e2e (Playwright network routing) instead. Only `Wallet`
// is faked; everything else (getTokenMetadata, CheckStateEnum, …) stays real.
const mockLoadMint = vi.fn()
const mockDecodeToken = vi.fn()
const mockCheckProofsStates = vi.fn()
vi.mock('@cashu/cashu-ts', async importOriginal => {
  const actual = await importOriginal<typeof import('@cashu/cashu-ts')>()
  return {
    ...actual,
    Wallet: vi.fn().mockImplementation(function MockWallet(this: Record<string, unknown>) {
      this.loadMint = mockLoadMint
      this.decodeToken = mockDecodeToken
      this.checkProofsStates = mockCheckProofsStates
    }),
  }
})

const MINT = 'https://testnut.cashu.space'
const PROOFS = [
  { id: '009a1f293253e41e', amount: Amount.from(2), secret: '407915bc212be61a77e3e6d2aeb4c727980bda51cd06a6afc29e2861768a7837', C: '02bc9097997d81afb2cc7346b5e4345a9346bd2a506eb7958598a72f0cf85163ea' },
  { id: '009a1f293253e41e', amount: Amount.from(8), secret: 'fe15109314e61d7756b0f8ee0f23a624acaa3f4e042f61433c728c7057b931be', C: '029e8e5050b890a7d6c0968db16bc1d5d5fa040ea1de284f6ec69d61299f671059' },
]

const V4_TOKEN = getEncodedToken({ mint: MINT, unit: 'sat', proofs: PROOFS })

// v3 is the legacy base64url-JSON encoding; cashu-ts only *emits* v4, so the
// v3 fixture is built by hand the way an old wallet would have encoded it.
const V3_TOKEN = 'cashuA' + Buffer.from(JSON.stringify({
  token: [{ mint: MINT, proofs: PROOFS.map(p => ({ ...p, amount: p.amount.toNumber() })) }],
  unit: 'usd',
  memo: 'lunch',
})).toString('base64url')

describe('parseCashuToken', () => {
  it('decodes a v4 (cashuB) token', () => {
    const { info, error } = parseCashuToken(V4_TOKEN)
    expect(error).toBeNull()
    expect(info).toMatchObject({ mint: MINT, unit: 'sat', amount: 10, proofsCount: 2, version: 'v4 (cashuB)' })
  })

  it('decodes a v3 (cashuA) token, including unit and memo', () => {
    const { info, error } = parseCashuToken(V3_TOKEN)
    expect(error).toBeNull()
    expect(info).toMatchObject({ mint: MINT, unit: 'usd', amount: 10, proofsCount: 2, version: 'v3 (cashuA)', memo: 'lunch' })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseCashuToken(`  ${V4_TOKEN}\n`).info?.mint).toBe(MINT)
  })

  it('rejects an empty input without throwing', () => {
    const { info, error } = parseCashuToken('   ')
    expect(info).toBeNull()
    expect(error).toBeTruthy()
  })

  it('rejects a non-Cashu string without throwing', () => {
    const { info, error } = parseCashuToken('lnbc1invoice')
    expect(info).toBeNull()
    expect(error).toContain('cashuA')
  })

  it('reports a truncated token as undecodable instead of throwing', () => {
    const { info, error } = parseCashuToken(V4_TOKEN.slice(0, V4_TOKEN.length - 20))
    expect(info).toBeNull()
    expect(error).toBeTruthy()
  })

  it('reports garbage after a valid prefix as undecodable', () => {
    const { info, error } = parseCashuToken('cashuBnot-a-real-token')
    expect(info).toBeNull()
    expect(error).toBeTruthy()
  })
})

// NUT-01 denominates ISO 4217 units in the currency's Minor Unit, so the raw integer in
// the token is cents for usd/eur but whole yen for jpy.
describe('formatTokenAmount', () => {
  it('renders sat as a plain integer', () => {
    expect(formatTokenAmount(21, 'sat')).toBe('21')
    expect(formatTokenAmount(2100000, 'sat')).toBe('2,100,000')
  })

  it('renders usd in cents with a currency symbol', () => {
    expect(formatTokenAmount(20, 'usd')).toBe('$0.20')
    expect(formatTokenAmount(5, 'usd')).toBe('$0.05')
    expect(formatTokenAmount(1234, 'usd')).toBe('$12.34')
    expect(formatTokenAmount(100000, 'usd')).toBe('$1,000.00')
  })

  it('renders eur in cents with a euro symbol', () => {
    expect(formatTokenAmount(20, 'eur')).toBe('€0.20')
    expect(formatTokenAmount(999, 'eur')).toBe('€9.99')
  })

  it('honours a zero-exponent currency instead of assuming /100', () => {
    expect(formatTokenAmount(500, 'jpy')).toBe('¥500')
  })

  it('honours a three-exponent currency', () => {
    expect(formatTokenAmount(1234, 'bhd')).toBe('1.234')
  })

  it('is case-insensitive about the unit', () => {
    expect(formatTokenAmount(20, 'USD')).toBe('$0.20')
  })

  it('falls back to the raw amount for an unknown or future unit', () => {
    expect(formatTokenAmount(42, 'xyz')).toBe('42')
    expect(formatTokenAmount(1000, 'msat')).toBe('1,000')
  })

  it('handles zero without producing a malformed fraction', () => {
    expect(formatTokenAmount(0, 'usd')).toBe('$0.00')
  })
})

describe('checkTokenSpentState', () => {
  beforeEach(() => {
    mockLoadMint.mockReset().mockResolvedValue(undefined)
    mockDecodeToken.mockReset().mockReturnValue({ proofs: PROOFS })
    mockCheckProofsStates.mockReset()
  })

  it('reports all proofs unspent', async () => {
    mockCheckProofsStates.mockResolvedValue(PROOFS.map(() => ({ state: CheckStateEnum.UNSPENT })))
    const result = await checkTokenSpentState(V4_TOKEN)
    expect(result).toEqual({ total: 2, unspent: 2, spent: 0, pending: 0 })
  })

  it('reports all proofs spent', async () => {
    mockCheckProofsStates.mockResolvedValue(PROOFS.map(() => ({ state: CheckStateEnum.SPENT })))
    const result = await checkTokenSpentState(V4_TOKEN)
    expect(result).toEqual({ total: 2, unspent: 0, spent: 2, pending: 0 })
  })

  it('reports a mix of spent and unspent proofs', async () => {
    mockCheckProofsStates.mockResolvedValue([
      { state: CheckStateEnum.UNSPENT },
      { state: CheckStateEnum.SPENT },
    ])
    const result = await checkTokenSpentState(V4_TOKEN)
    expect(result).toEqual({ total: 2, unspent: 1, spent: 1, pending: 0 })
  })

  it('counts a pending proof separately from spent/unspent', async () => {
    mockCheckProofsStates.mockResolvedValue([
      { state: CheckStateEnum.PENDING },
      { state: CheckStateEnum.UNSPENT },
    ])
    const result = await checkTokenSpentState(V4_TOKEN)
    expect(result).toEqual({ total: 2, unspent: 1, spent: 0, pending: 1 })
  })

  it('throws for an undecodable token without ever reaching the mint', async () => {
    await expect(checkTokenSpentState('not-a-cashu-token')).rejects.toThrow()
    expect(mockLoadMint).not.toHaveBeenCalled()
  })

  it('propagates a mint-unreachable error to the caller', async () => {
    mockLoadMint.mockRejectedValue(new Error('fetch failed'))
    await expect(checkTokenSpentState(V4_TOKEN)).rejects.toThrow('fetch failed')
  })
})

// L4 (2026-09-07 audit): the mint URL comes from a fully user-controlled pasted
// token. A crafted token could point it at an internal port/service, making the
// victim's browser fire a request there on "Inspect & Verify" / "Check if spent".
// assertProbeableMintUrl() gates every network path on a public https:// URL.

// Hand-built v3 token (base64url JSON) so the mint field can be arbitrary —
// cashu-ts's getEncodedToken only emits v4 and would sanitise the URL.
function v3TokenWithMint(mint: string): string {
  return 'cashuA' + Buffer.from(JSON.stringify({
    token: [{ mint, proofs: PROOFS.map(p => ({ ...p, amount: p.amount.toNumber() })) }],
    unit: 'sat',
  })).toString('base64url')
}

describe('assertProbeableMintUrl', () => {
  it('accepts a normal public https:// mint URL', () => {
    expect(() => assertProbeableMintUrl('https://testnut.cashu.space')).not.toThrow()
    expect(() => assertProbeableMintUrl('https://mint.minibits.cash/Bitcoin')).not.toThrow()
  })

  it.each([
    ['http:// (plaintext)',        'http://mint.example.com'],
    ['javascript: scheme',         'javascript:fetch("//evil")'],
    ['data: scheme',               'data:text/html,<script>1</script>'],
    ['file: scheme',               'file:///etc/passwd'],
    ['localhost',                  'https://localhost:3338'],
    ['*.localhost',                'https://foo.localhost'],
    ['loopback IPv4',              'https://127.0.0.1:9200'],
    ['loopback IPv4 (whole /8)',   'https://127.5.5.5'],
    ['private 10/8',               'https://10.0.0.5/v1/info'],
    ['private 192.168/16',         'https://192.168.1.1'],
    ['private 172.16/12',          'https://172.20.10.1'],
    ['link-local 169.254/16',      'https://169.254.169.254'],
    ['CGNAT 100.64/10',            'https://100.100.0.1'],
    ['unspecified 0.0.0.0',        'https://0.0.0.0'],
    ['IPv6 loopback',              'https://[::1]:8080'],
    ['IPv6 ULA',                   'https://[fd12:3456::1]'],
    ['IPv6 link-local',            'https://[fe80::1]'],
    ['empty string',              ''],
    ['not a URL',                  'this is not a url'],
    ['over-long URL',              'https://mint.example.com/' + 'a'.repeat(600)],
  ])('rejects %s', (_label, url) => {
    expect(() => assertProbeableMintUrl(url)).toThrow(InvalidMintUrlError)
  })

  it('the rejection message is user-facing and names the problem', () => {
    expect(() => assertProbeableMintUrl('http://mint.example')).toThrow(/not https/i)
    expect(() => assertProbeableMintUrl('https://127.0.0.1')).toThrow(/non-public host/i)
  })
})

describe('token network paths refuse an unsafe mint URL (audit finding L4)', () => {
  beforeEach(() => {
    vi.mocked(Wallet).mockClear()
    mockLoadMint.mockReset().mockResolvedValue(undefined)
    mockDecodeToken.mockReset().mockReturnValue({ proofs: PROOFS })
    mockCheckProofsStates.mockReset().mockResolvedValue(PROOFS.map(() => ({ state: CheckStateEnum.UNSPENT })))
  })

  it.each([
    ['checkTokenSpentState', (t: string) => checkTokenSpentState(t)],
    ['decodeTokenWithMint',  (t: string) => decodeTokenWithMint(t)],
  ])('%s rejects a token whose mint is http://localhost and makes NO network call', async (_name, run) => {
    await expect(run(v3TokenWithMint('http://localhost:9200'))).rejects.toBeInstanceOf(InvalidMintUrlError)
    expect(vi.mocked(Wallet)).not.toHaveBeenCalled()
    expect(mockLoadMint).not.toHaveBeenCalled()
    expect(mockCheckProofsStates).not.toHaveBeenCalled()
  })

  it.each([
    'https://127.0.0.1:3338',
    'https://192.168.0.10',
    'http://mint.example.com',
  ])('checkTokenSpentState rejects mint=%s before contacting it', async (mint) => {
    await expect(checkTokenSpentState(v3TokenWithMint(mint))).rejects.toBeInstanceOf(InvalidMintUrlError)
    expect(mockLoadMint).not.toHaveBeenCalled()
  })

  it('a normal https:// token still reaches the mint (positive control)', async () => {
    const res = await checkTokenSpentState(v3TokenWithMint('https://testnut.cashu.space'))
    expect(mockLoadMint).toHaveBeenCalledTimes(1)
    expect(res.total).toBe(2)
  })
})
