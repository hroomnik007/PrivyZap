import { describe, it, expect, vi, beforeEach } from 'vitest'

// client.ts drags in nip46 / SimplePool / @noble / the auth store — stub them;
// openRemoteSignerAuthUrl only touches window.open + console.warn.
vi.mock('nostr-tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('nostr-tools')>()
  return { ...real, verifyEvent: vi.fn(() => true) }
})
vi.mock('nostr-tools/nip46', () => ({
  BunkerSigner: class {}, parseBunkerInput: vi.fn(), createNostrConnectURI: vi.fn(), toBunkerURL: vi.fn(),
}))
vi.mock('nostr-tools/pool', () => ({ SimplePool: class {} }))
vi.mock('@noble/secp256k1', () => ({ getPublicKey: vi.fn() }))
vi.mock('@noble/hashes/utils.js', () => ({ bytesToHex: vi.fn(), hexToBytes: vi.fn() }))
vi.mock('@/core/nostr/pool', () => ({ sharedPool: { subscribeMany: vi.fn() } }))
vi.mock('@/stores/auth.store', () => ({ useAuthStore: { getState: vi.fn(() => ({})) } }))

import { openRemoteSignerAuthUrl } from '@/core/nostr/client'

let openSpy: ReturnType<typeof vi.fn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  openSpy = vi.fn()
  ;(window as unknown as { open: unknown }).open = openSpy
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('openRemoteSignerAuthUrl — NIP-46 onauth URL guard (audit finding L3)', () => {
  it('opens an https:// URL with noopener,noreferrer', () => {
    openRemoteSignerAuthUrl('https://signer.example/approve?req=abc')
    expect(openSpy).toHaveBeenCalledWith('https://signer.example/approve?req=abc', '_blank', 'noopener,noreferrer')
  })

  it('refuses a javascript: URL', () => {
    openRemoteSignerAuthUrl('javascript:alert(document.cookie)')
    expect(openSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('refuses a data: URL', () => {
    openRemoteSignerAuthUrl('data:text/html,<script>alert(1)</script>')
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('refuses a plain http:// URL (no TLS)', () => {
    openRemoteSignerAuthUrl('http://phish.example/approve')
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('refuses a non-string value from a malformed signer response', () => {
    openRemoteSignerAuthUrl(undefined)
    openRemoteSignerAuthUrl({ toString: () => 'https://sneaky.example' })
    openRemoteSignerAuthUrl(null)
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('is case-insensitive on the scheme but still requires https', () => {
    openRemoteSignerAuthUrl('HTTPS://signer.example/x')
    expect(openSpy).toHaveBeenCalledTimes(1)
    openSpy.mockClear()
    openRemoteSignerAuthUrl('HtTp://signer.example/x')
    expect(openSpy).not.toHaveBeenCalled()
  })
})
