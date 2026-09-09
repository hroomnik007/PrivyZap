# Security Policy

## Reporting a Vulnerability

**Preferred:** Nostr DM to the project maintainer — npub is listed on [mintradar.org](https://mintradar.org).

**Alternative:** [GitHub private vulnerability reporting](https://github.com/hroomnik007/MintRadar/security/advisories/new)

Please include in your report:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Affected component (frontend, backend, Docker config, etc.)

Expected response time: best effort, typically within 7 days.

---

## Scope

### In scope

- Frontend private key handling (nsec zeroing, NIP-07 delegation, NIP-46 bunker session)
- Backend API endpoints — SSRF, SQL injection, auth bypass, rate limit bypass
- NIP-44 watchlist encryption implementation
- Docker and Nginx configuration (container isolation, header policies)
- Dependency vulnerabilities with direct exploitability against MintRadar users

### Out of scope

- External Nostr relays (damus.io, nos.lol, etc.)
- audit.8333.space third-party service
- The Cashu protocol itself
- Individual mint operators' infrastructure

---

## Threat Model

| Risk | Mitigation |
|------|-----------|
| nsec in browser memory | Key is used only to derive the public key, then explicitly zeroed (`privkeyBytes.fill(0)`); never stored in localStorage, sessionStorage, or sent to the server |
| NIP-44 encrypted watchlist | Encrypted with the user's own Nostr key; server never sees plaintext; decryption happens entirely in the browser |
| Backend SSRF | All outbound probe URLs validated by `isSafeUrl()` (ipaddr.js + DNS resolution); private IP ranges, loopback, link-local, and CGNAT ranges are blocked |
| XSS | No `dangerouslySetInnerHTML`; all user-controlled URLs validated before rendering; CSP header enforced via Nginx |
| Dependency supply chain | Regular `npm audit`; full dependency scan documented in AUDIT.md |

---

## Known Limitations (by design, not bugs)

- The server sees every mint URL submitted for monitoring — this is necessary for server-side probing
- All probes originate from a single Frankfurt IP — mints can detect and block this IP
- nsec login leaves the derived public key in JS memory for the duration of the session; the raw private key bytes are zeroed immediately after derivation
- Watchlist sync uses NIP-44 single-key encryption — no multi-sig or threshold encryption

---

See [AUDIT.md](MintRadar/AUDIT.md) for the full security and privacy audit.

---

## Automated Security Testing

MintRadar maintains a suite of **275 automated tests**, including **40 dedicated security tests** located in `backend/src/__tests__/security/`.

### Coverage

| Area | What is tested |
|------|---------------|
| SSRF protection | `isSafeUrl()` blocks private IPv4/IPv6 ranges, loopback, link-local, CGNAT, and DNS rebinding attempts |
| SQL injection | All DB queries use parameterized `pg` queries; injection payloads in `url`, `period`, and filter fields are verified safe |
| Rate limiting | Per-IP limits on `/api/mint/submit` (20/hr) and `/api/mints/discover` (10/hr) return 429 on excess |
| CORS allow-list | Only allowed origins receive `Access-Control-Allow-Origin`; arbitrary origins are rejected |
| HTTP security headers | `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy` presence verified |
| Input validation | XSS payloads, null bytes, oversized payloads (>10 kB URL), mass assignment fields, and prototype pollution keys are all rejected |
| Error message leakage | 4xx/5xx responses are verified NOT to expose stack traces, internal paths, or DB schema details |

### CI enforcement

The GitHub Actions `deploy` workflow includes a `test` job that runs all 275 tests. The `deploy` job declares `needs: test` and is blocked if any test fails. Security regressions cannot reach production undetected.

Last security test review: **2026-06-30** — no defects found.
