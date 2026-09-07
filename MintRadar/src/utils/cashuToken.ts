// Cashu token decoding, backed by the official @cashu/cashu-ts library.
//
// getTokenMetadata() is the primary path: it decodes both v3 (cashuA…, base64
// JSON) and v4 (cashuB…, CBOR) purely locally — no network request, no keysets
// needed — which is exactly what the Token Inspector wants for a paste-and-look
// tool. The heavier full decode (proofs + DLEQ) lives in decodeTokenWithMint()
// below and needs the mint online.
import { CheckStateEnum, getTokenMetadata, hasValidDleq, Wallet, type Proof } from '@cashu/cashu-ts'

export interface TokenInfo {
  mint: string
  amount: number
  unit: string
  /** Number of proofs in the token, or null when the encoding doesn't expose them. */
  proofsCount: number | null
  /** Human-readable encoding version, e.g. "v4 (cashuB)". */
  version: string
  memo: string | null
}

function tokenVersionLabel(token: string): string {
  if (token.startsWith('cashuB')) return 'v4 (cashuB)'
  if (token.startsWith('cashuA')) return 'v3 (cashuA)'
  return 'unknown'
}

export interface TokenParseResult {
  info: TokenInfo | null
  error: string | null
}

// NUT-01: "For Bitcoin, ISO 4217 currencies (and stablecoins pegged to those
// currencies), Keyset amount values MUST represent an amount in the Minor Unit of that
// currency." So a `usd` token carrying amount 20 is 20 cents ($0.20), not $20.
//
// The exponent is per-currency, NOT a blanket 2 — the spec's own examples are usd → 2
// (1 = 1 cent), jpy → 0 (1 = 1 JPY) and bhd → 3 (1 = 1 fils). A hardcoded /100 would
// silently inflate jpy by 100x and deflate bhd by 10x, so the exponent is looked up.
//
// `sat` is itself Bitcoin's minor unit (and `msat`/`auth` are plain counts), so they are
// deliberately absent here and render as whole numbers.
const MINOR_UNIT_EXPONENT: Record<string, number> = {
  usd: 2, eur: 2, gbp: 2, chf: 2, cad: 2, aud: 2, nzd: 2, cny: 2, hkd: 2,
  sek: 2, nok: 2, dkk: 2, pln: 2, czk: 2, brl: 2, mxn: 2, zar: 2, inr: 2, try: 2,
  jpy: 0, krw: 0, isk: 0, huf: 0, clp: 0, vnd: 0,
  bhd: 3, kwd: 3, omr: 3, jod: 3, tnd: 3,
  // Stablecoins inherit the minor unit of the currency they are pegged to.
  usdt: 2, usdc: 2, dai: 2, eurc: 2, gyen: 0,
}

const CURRENCY_SYMBOL: Record<string, string> = {
  usd: '$', usdt: '$', usdc: '$', dai: '$',
  eur: '€', eurc: '€',
  gbp: '£',
  jpy: '¥', gyen: '¥',
  cny: '¥',
  inr: '₹',
  krw: '₩',
  brl: 'R$',
}

/**
 * Render a token's raw amount the way a human reads it, honouring the unit's NUT-01
 * minor-unit exponent. An unrecognised or future unit falls back to the raw integer
 * rather than guessing an exponent — better a plain number than a wrong one.
 */
export function formatTokenAmount(amount: number, unit: string): string {
  const key = unit.trim().toLowerCase()
  const exponent = MINOR_UNIT_EXPONENT[key]
  if (exponent === undefined) return amount.toLocaleString()

  // Integer math throughout — dividing by 100 in floating point would round amounts
  // like 1234567890 incorrectly, and this is money.
  const negative = amount < 0
  const abs = Math.abs(Math.trunc(amount))
  const divisor = 10 ** exponent
  const whole = Math.floor(abs / divisor)
  const frac = abs % divisor

  const wholeText = whole.toLocaleString()
  const body = exponent === 0 ? wholeText : `${wholeText}.${String(frac).padStart(exponent, '0')}`
  const symbol = CURRENCY_SYMBOL[key] ?? ''
  return `${negative ? '-' : ''}${symbol}${body}`
}

/**
 * Decode a Cashu token to its metadata. Never throws — an undecodable token
 * comes back as `{ info: null, error }` so the caller can render a message
 * instead of crashing.
 */
export function parseCashuToken(raw: string): TokenParseResult {
  const token = raw.trim()
  if (!token) return { info: null, error: 'Paste a Cashu token first.' }
  if (!token.startsWith('cashuA') && !token.startsWith('cashuB')) {
    return { info: null, error: 'Not a Cashu token — expected a string starting with cashuA (v3) or cashuB (v4).' }
  }

  try {
    const meta = getTokenMetadata(token)
    const amount = Number(meta.amount.toString())
    return {
      info: {
        mint: meta.mint,
        amount: Number.isFinite(amount) ? amount : 0,
        unit: meta.unit,
        proofsCount: meta.proofAmounts.length > 0 ? meta.proofAmounts.length : null,
        version: tokenVersionLabel(token),
        memo: meta.memo ?? null,
      },
      error: null,
    }
  } catch (err) {
    const detail = err instanceof Error && err.message ? ` (${err.message})` : ''
    return { info: null, error: `Could not decode this token — it looks malformed or truncated${detail}.` }
  }
}

const MAX_MINT_URL_LENGTH = 500

/** Thrown when a pasted token's `mint` field is not a safe, public https URL. */
export class InvalidMintUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidMintUrlError'
  }
}

// Loopback / private / link-local / ULA / unspecified / CGNAT host patterns,
// plus `localhost`. Not a full IP parser — enough to stop the obvious "point
// the token's mint at an internal service" case.
function isNonPublicHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '' || h === '0.0.0.0' || h === '::' || h === '::1') return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number)
    if (a === 0 || a === 127 || a === 10) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b! >= 16 && b! <= 31) return true
    if (a === 100 && b! >= 64 && b! <= 127) return true // CGNAT 100.64/10
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true   // ULA fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true   // link-local fe80::/10
  return false
}

/**
 * Guard the mint URL extracted from a *pasted* (fully user-controlled) Cashu
 * token before ANY code path uses it for a network request. Anyone can craft a
 * token whose `mint` field points at an attacker-chosen host — including an
 * internal port/service on the victim's network — so require an https:// URL
 * with a public host and a sane length, consistent with core/mint/api.ts's
 * validateUrl() and the MintDetail "Test latency" guard (2026-09-07 audit, L4).
 * Throws InvalidMintUrlError with a user-facing message.
 */
export function assertProbeableMintUrl(mint: string): void {
  if (typeof mint !== 'string' || mint.length === 0) {
    throw new InvalidMintUrlError("This token doesn't name a mint URL.")
  }
  if (mint.length > MAX_MINT_URL_LENGTH) {
    throw new InvalidMintUrlError('The mint URL in this token is unreasonably long — not contacting it.')
  }
  let url: URL
  try {
    url = new URL(mint)
  } catch {
    throw new InvalidMintUrlError(`The token's mint URL is malformed — not contacting it.`)
  }
  if (url.protocol !== 'https:') {
    throw new InvalidMintUrlError(`The token's mint URL is not https:// — refusing to contact it.`)
  }
  if (isNonPublicHost(url.hostname)) {
    throw new InvalidMintUrlError(`The token's mint URL points at a non-public host (${url.hostname}) — refusing to contact it.`)
  }
}

export interface DecodedProof {
  proof: Proof
  /** Whether this proof actually carries a NUT-12 DLEQ payload at all. */
  hasDleq: boolean
  /** null when the keyset for this proof couldn't be resolved from the mint. */
  dleqValid: boolean | null
}

export interface FullTokenDecode {
  info: TokenInfo
  proofs: DecodedProof[]
  /** How many proofs carried a DLEQ payload that could be checked. */
  proofsWithDleq: number
  /** True only when every proof carries a DLEQ proof AND all of them verify. */
  allDleqValid: boolean
}

/**
 * Full decode: resolves the token's proofs against the live mint and verifies
 * each proof's NUT-12 DLEQ signature.
 *
 * Unlike parseCashuToken() this needs the mint to be reachable (Wallet.loadMint
 * fetches /v1/info + /v1/keysets + /v1/keys). Not wired into the UI yet — it is
 * the groundwork for showing DLEQ validity in the Token Inspector.
 *
 * @throws if the mint is unreachable or the token can't be resolved.
 */
export async function decodeTokenWithMint(raw: string): Promise<FullTokenDecode> {
  const token = raw.trim()
  const { info, error } = parseCashuToken(token)
  if (!info) throw new Error(error ?? 'Invalid token')
  assertProbeableMintUrl(info.mint)

  const wallet = new Wallet(info.mint, { unit: info.unit })
  await wallet.loadMint()

  const decoded = wallet.decodeToken(token)
  const proofs: DecodedProof[] = decoded.proofs.map(proof => {
    const hasDleq = proof.dleq != null
    let dleqValid: boolean | null
    try {
      // require:false — NUT-12 mandates "verify if present", so a proof with no
      // DLEQ payload is not itself a failure. Note this also means it returns true
      // for a proof carrying no DLEQ at all, which is why `hasDleq` is tracked
      // separately: "nothing to check" must never be reported as "verified".
      dleqValid = hasValidDleq(proof, wallet.getKeyset(proof.id), { require: false })
    } catch {
      dleqValid = null
    }
    return { proof, hasDleq, dleqValid }
  })

  const proofsWithDleq = proofs.filter(p => p.hasDleq).length

  return {
    info: { ...info, proofsCount: proofs.length },
    proofs,
    proofsWithDleq,
    allDleqValid: proofs.length > 0 && proofs.every(p => p.hasDleq && p.dleqValid === true),
  }
}

export interface TokenSpentCheck {
  total: number
  unspent: number
  spent: number
  pending: number
}

/**
 * NUT-07 live spent-state check: asks the token's own mint whether each proof
 * has already been redeemed. Same mint-reachability requirement (and the same
 * decoded proofs) as decodeTokenWithMint() above — this is a second, separate
 * question about the same proofs, not a replacement for the DLEQ check.
 *
 * Deliberately user-initiated only (never called automatically on paste): a
 * checkstate request tells the mint that someone is looking at this specific
 * token right now, which is a privacy leak to the mint operator even though
 * no third party is involved.
 *
 * @throws if the mint is unreachable or the token can't be resolved.
 */
export async function checkTokenSpentState(raw: string): Promise<TokenSpentCheck> {
  const token = raw.trim()
  const { info, error } = parseCashuToken(token)
  if (!info) throw new Error(error ?? 'Invalid token')
  assertProbeableMintUrl(info.mint)

  const wallet = new Wallet(info.mint, { unit: info.unit })
  await wallet.loadMint()

  const decoded = wallet.decodeToken(token)
  const states = await wallet.checkProofsStates(decoded.proofs)

  let unspent = 0
  let spent = 0
  let pending = 0
  for (const s of states) {
    if (s.state === CheckStateEnum.SPENT) spent++
    else if (s.state === CheckStateEnum.PENDING) pending++
    else unspent++
  }
  return { total: states.length, unspent, spent, pending }
}
