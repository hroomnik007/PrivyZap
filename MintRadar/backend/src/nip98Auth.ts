import type { Request } from 'express'
import { nip98 } from 'nostr-tools'

export interface Nip98AuthOk {
  ok: true
  pubkey: string
}

export interface Nip98AuthFail {
  ok: false
  status: number
  error: string
}

export type Nip98AuthResult = Nip98AuthOk | Nip98AuthFail

const IS_DEV = process.env['NODE_ENV'] !== 'production'

// --- Single-use nonce cache (replay protection) -----------------------------
//
// nip98.validateToken already rejects a token whose `created_at` is outside a
// ~60s window, but within that window the *same* signed event can be replayed
// verbatim. The NIP-98 `payload` (body-hash) tag is optional and our client
// doesn't send it, so nothing binds a captured token to the specific request
// body it was signed alongside — an attacker who captures one subscribe token
// could, within ~60s, resend it with a swapped body to overwrite that user's
// own subscription. Impact is low (a user can only clobber their own row), so
// this is defence-in-depth, but it's cheap: remember every accepted event id
// for longer than the validity window and reject the second sighting.
//
// Same shape as the in-memory IP rate limiter in index.ts: a plain Map with a
// periodic sweep. Process-local — good enough for a single-instance backend;
// a horizontal scale-out would need this in Redis alongside the rate limiter.
const NONCE_TTL_MS = 120_000
const seenEventIds = new Map<string, number>()

function sweepNonces(now: number): void {
  for (const [id, expiresAt] of seenEventIds) {
    if (now >= expiresAt) seenEventIds.delete(id)
  }
}

const nonceSweepTimer = setInterval(() => sweepNonces(Date.now()), NONCE_TTL_MS)
nonceSweepTimer.unref?.()

// Test hook — lets a test start from a clean cache without reaching into module
// internals.
export function _resetNip98NonceCache(): void {
  seenEventIds.clear()
}

// Reconstructs the absolute URL the client must have signed into its NIP-98
// event's `u` tag.
//
// GOTCHA: nginx's `location /api/` block (deploy/nginx.conf) does NOT set
// X-Forwarded-Proto — only Host, X-Real-IP, X-Forwarded-For. `trust proxy`
// (index.ts) makes Express fall back to the *actual* connection scheme when
// that header is absent, which between nginx and this process is always
// plain HTTP, even for requests the public client made over HTTPS. Trusting
// req.protocol here would make every production NIP-98 token fail url-tag
// validation (client signs https://…, server checks against http://…) —
// confirmed against the live server, see notification-subscribe deploy
// verification. So: honor X-Forwarded-Proto if a proxy ever does set it,
// otherwise assume the scheme this service is actually reachable on
// (https in production, http for local dev) — the same default-scheme
// convention DEFAULT_ORIGINS already uses in index.ts.
function getRequestUrl(req: Request): string {
  const forwardedProto = req.headers['x-forwarded-proto']
  const proto = typeof forwardedProto === 'string' && forwardedProto.length > 0
    ? forwardedProto.split(',')[0]!.trim()
    : (IS_DEV ? 'http' : 'https')
  return `${proto}://${req.get('host') ?? ''}${req.originalUrl}`
}

// Verifies the NIP-98 "Authorization: Nostr <base64-event>" header via
// nostr-tools' own validateToken (signature, kind, timestamp window, url and
// method tags) — never hand-rolled. Returns the authenticated pubkey on
// success, or a 401 with a generic reason on any failure.
export async function authenticateNip98(req: Request): Promise<Nip98AuthResult> {
  const header = req.headers['authorization']

  if (typeof header !== 'string' || header.length === 0) {
    return { ok: false, status: 401, error: 'Missing Authorization header' }
  }

  const url = getRequestUrl(req)

  try {
    const valid = await nip98.validateToken(header, url, req.method)
    if (!valid) {
      return { ok: false, status: 401, error: 'Invalid NIP-98 authorization' }
    }
    const event = await nip98.unpackEventFromToken(header)
    if (typeof event.pubkey !== 'string' || event.pubkey.length !== 64) {
      return { ok: false, status: 401, error: 'Invalid NIP-98 authorization' }
    }

    // Replay guard — only reached once the token is otherwise fully valid, so a
    // stream of bad tokens can't fill the cache. `event.id` is the signed event
    // hash: a second request bearing the same id (a replay, body swapped or not)
    // is rejected until the id ages out past the validity window.
    const now = Date.now()
    sweepNonces(now)
    if (typeof event.id === 'string' && event.id.length > 0) {
      const seenExpiry = seenEventIds.get(event.id)
      if (seenExpiry !== undefined && now < seenExpiry) {
        return { ok: false, status: 401, error: 'NIP-98 token already used' }
      }
      seenEventIds.set(event.id, now + NONCE_TTL_MS)
    }

    return { ok: true, pubkey: event.pubkey }
  } catch {
    // validateToken/unpackEventFromToken throw on any invalid case (missing
    // token, bad signature, wrong kind, expired timestamp, url/method
    // mismatch) — all collapse to a generic 401, no internal detail leaked.
    return { ok: false, status: 401, error: 'Invalid NIP-98 authorization' }
  }
}
