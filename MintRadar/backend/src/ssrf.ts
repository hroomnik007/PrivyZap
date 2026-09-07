import { parse, IPv4, IPv6 } from 'ipaddr.js'
import { lookup } from 'dns/promises'
import { lookup as dnsLookupCb } from 'dns'
import type { LookupAddress } from 'dns'
import type { LookupFunction } from 'net'
import { Agent, fetch as undiciFetch } from 'undici'

const BLOCKED_RANGES = [
  'loopback', 'private', 'linkLocal', 'uniqueLocal',
  'unspecified', 'reserved', 'carrierGradeNat', 'broadcast'
] as const

// Extracts an embedded IPv4 address from an IPv6 address that uses one of
// the well-known IPv4-in-IPv6 embedding schemes, so it can be re-checked
// against BLOCKED_RANGES. Returns null if the range isn't one we know how
// to unwrap.
function extractEmbeddedIPv4(addr: IPv6): IPv4 | null {
  const range = addr.range()
  const bytes = addr.toByteArray()

  if (range === 'ipv4Mapped') {
    return addr.toIPv4Address()
  }

  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052) — embedded IPv4 is the
  // last 4 bytes, unmodified.
  if (range === 'rfc6052') {
    return new IPv4(bytes.slice(12, 16))
  }

  // 6to4 2002::/16 (RFC 3056) — embedded IPv4 is bytes 2-5.
  if (range === '6to4') {
    return new IPv4(bytes.slice(2, 6))
  }

  // Teredo 2001::/32 (RFC 4380) — the client IPv4 occupies the last 4
  // bytes, XOR-obfuscated with 0xFFFFFFFF.
  if (range === 'teredo') {
    return new IPv4(bytes.slice(12, 16).map(b => b ^ 0xff))
  }

  return null
}

function isBlockedAddress(addr: IPv4 | IPv6): boolean {
  const range = addr.range()
  if ((BLOCKED_RANGES as readonly string[]).includes(range)) return true

  // Handle IPv4 addresses embedded in IPv6 (::ffff:x.x.x.x, NAT64, 6to4,
  // Teredo) — unwrap and re-check the embedded address against the same
  // blocklist, since routing/translation may deliver traffic to it.
  if (addr.kind() === 'ipv6') {
    const v4 = extractEmbeddedIPv4(addr as IPv6)
    if (v4 && (BLOCKED_RANGES as readonly string[]).includes(v4.range())) return true
  }

  return false
}

function isBlockedIpString(ip: string): boolean {
  try {
    return isBlockedAddress(parse(ip))
  } catch {
    // Not parseable as an IP — fail closed
    return true
  }
}

// 'safe'      — proceed with fetch
// 'blocked'   — SSRF-blocked (private IP, bad protocol, etc.) — do not probe, do not write history
// 'dns-error' — DNS lookup failed, mint is unreachable — write offline history entry
export type UrlSafetyResult = 'safe' | 'blocked' | 'dns-error'

// Shared by checkUrlSafety (https:) and checkWsUrlSafety (ws:/wss:) — only the
// allowed protocol set differs; hostname/DNS/private-range checks are identical.
async function checkUrlSafetyForProtocols(
  rawUrl: string,
  allowedProtocols: readonly string[]
): Promise<UrlSafetyResult> {
  try {
    const url = new URL(rawUrl)
    if (!allowedProtocols.includes(url.protocol)) return 'blocked'
    if (rawUrl.length > 500) return 'blocked'

    const hostname = url.hostname

    // Block if hostname is already a private/blocked IP address
    try {
      const addr = parse(hostname)
      if (isBlockedAddress(addr)) return 'blocked'
    } catch {
      // Not a raw IP — continue to DNS lookup
    }

    // Resolve DNS — failure here is a network error, not an SSRF attempt
    let addresses: LookupAddress[]
    try {
      addresses = await lookup(hostname, { all: true })
    } catch {
      return 'dns-error'
    }

    if (addresses.length === 0) return 'dns-error'

    for (const addr of addresses) {
      try {
        const parsed = parse(addr.address)
        if (isBlockedAddress(parsed)) return 'blocked'
      } catch {
        return 'blocked'
      }
    }

    return 'safe'
  } catch {
    return 'blocked'
  }
}

export async function checkUrlSafety(rawUrl: string): Promise<UrlSafetyResult> {
  return checkUrlSafetyForProtocols(rawUrl, ['https:'])
}

export async function isSafeUrl(rawUrl: string): Promise<boolean> {
  const result = await checkUrlSafety(rawUrl)
  return result === 'safe'
}

// Same guard as checkUrlSafety, but for Nostr relay URLs (ws:/wss:) instead of
// mint URLs (https:) — used to validate user-supplied relay lists before they
// are stored, so they can't be used to make the server probe/connect to
// internal infrastructure later.
export async function checkWsUrlSafety(rawUrl: string): Promise<UrlSafetyResult> {
  return checkUrlSafetyForProtocols(rawUrl, ['ws:', 'wss:'])
}

export async function isSafeWsUrl(rawUrl: string): Promise<boolean> {
  const result = await checkWsUrlSafety(rawUrl)
  return result === 'safe'
}

// ── SSRF-safe fetch ────────────────────────────────────────────
//
// Defends against three classes of SSRF:
//  1. Direct internal targets — isSafeUrl() validates before connecting.
//  2. Redirect-based SSRF — redirects are followed manually and each hop
//     is re-validated with isSafeUrl().
//  3. DNS rebinding (TOCTOU) — a custom lookup re-checks the resolved IP
//     at connect time, inside the same resolution the socket uses, so a
//     low-TTL domain cannot rebind to an internal IP between check and fetch.

// Custom DNS lookup that rejects any resolved address in a blocked range.
// undici uses this for the actual TCP connect, closing the TOCTOU window
// while preserving the original hostname for SNI and the Host header.
export const safeLookup: LookupFunction = (hostname, options, callback): void => {
  dnsLookupCb(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) { callback(err, '', 0); return }
    const list = addresses as unknown as LookupAddress[]
    if (!Array.isArray(list) || list.length === 0) {
      callback(new Error('No addresses resolved'), '', 0)
      return
    }
    for (const a of list) {
      if (isBlockedIpString(a.address)) {
        callback(new Error('Blocked address (SSRF protection)'), '', 0)
        return
      }
    }
    callback(null, list, list[0]!.family)
  })
}

const safeAgent = new Agent({
  connect: { lookup: safeLookup },
})

const MAX_REDIRECTS = 3

export interface SafeFetchOptions {
  timeoutMs?: number
  onError?: (err: unknown) => void
  /** Extra request headers (e.g. an Accept header for a JSON API). */
  headers?: Record<string, string>
}

/**
 * Performs an SSRF-safe HTTPS fetch. Validates the URL (and every redirect
 * hop) with isSafeUrl(), pins DNS resolution to a blocked-range check at
 * connect time, follows redirects manually, and never sends credentials.
 * Returns null if the URL is unsafe or the request fails.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {}
): Promise<Response | null> {
  const timeoutMs = options.timeoutMs ?? 10_000
  // One deadline for the whole call, not per hop — a signal fresh per redirect
  // hop let a mint that redirects a couple of times before hanging block for
  // up to (MAX_REDIRECTS + 1) * timeoutMs instead of timeoutMs total.
  const deadline = AbortSignal.timeout(timeoutMs)
  let currentUrl = rawUrl

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isSafeUrl(currentUrl))) return null

    let res: Response
    try {
      res = await undiciFetch(currentUrl, {
        signal: deadline,
        credentials: 'omit',
        redirect: 'manual',
        dispatcher: safeAgent,
        ...(options.headers ? { headers: options.headers } : {}),
      }) as unknown as Response
    } catch (err) {
      options.onError?.(err)
      return null
    }

    // Manually follow redirects, re-validating each Location.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return null
      try {
        // Resolve relative redirects against the current URL.
        currentUrl = new URL(location, currentUrl).toString()
      } catch {
        return null
      }
      continue
    }

    return res
  }

  // Too many redirects.
  return null
}
