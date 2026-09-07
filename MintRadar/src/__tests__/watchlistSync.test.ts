import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────
// watchlistSync.ts pulls in the real nostr pool (patches a live SimplePool) and
// the real client module (nip46 / @noble). Stub both — this test only cares
// about how fetchRemoteWatchlist SELECTS an event across relay responses.

const { querySync } = vi.hoisted(() => ({ querySync: vi.fn() }))
vi.mock('@/core/nostr/pool', () => ({ sharedPool: { querySync } }))
vi.mock('@/core/nostr/client', () => ({ detectLoginMethod: () => 'nsec' }))
vi.mock('nostr-tools', () => ({ verifyEvent: vi.fn(() => true) }))

import { fetchRemoteWatchlist } from '@/core/nostr/watchlistSync'

const PK = 'a'.repeat(64)
const OTHER_PK = 'b'.repeat(64)

interface FakeEvt { id: string; pubkey: string; kind: number; created_at: number; tags: string[][]; sig: string; content: string }

function evt(createdAt: number, urls: string[], pubkey = PK): FakeEvt {
  return {
    id: `evt-${createdAt}`,
    pubkey,
    kind: 10003,
    created_at: createdAt,
    tags: [],
    sig: '0'.repeat(128),
    // The nip44 mock below is an identity function, so the "encrypted" content
    // is just the JSON payload verbatim — same round-trip as the real cipher.
    content: JSON.stringify(urls),
  }
}

/**
 * Configure `sharedPool.querySync([relay], filter)` per relay URL.
 *  - value is a FakeEvt[]        → resolves with those events
 *  - value is Error              → rejects (connection/protocol failure)
 *  - value is 'never'            → never settles (unreachable relay)
 *  - relay not in the map        → resolves []  (relay reached, nothing stored)
 * `delayMs` optionally defers the resolution.
 */
function configureRelays(map: Record<string, FakeEvt[] | Error | 'never'>, delayMs = 0) {
  querySync.mockImplementation((relays: string[]) => {
    const relay = relays[0]!
    const outcome = map[relay]
    if (outcome === 'never') return new Promise(() => {})
    const settle = () => {
      if (outcome instanceof Error) return Promise.reject(outcome)
      return Promise.resolve(outcome ?? [])
    }
    if (delayMs === 0) return settle()
    return new Promise((resolve, reject) => {
      setTimeout(() => { settle().then(resolve, reject) }, delayMs)
    })
  })
}

beforeEach(() => {
  querySync.mockReset()
  ;(globalThis as unknown as { window: { nostr: unknown } }).window ??= {} as never
  ;(window as unknown as { nostr: unknown }).nostr = {
    nip44: {
      decrypt: vi.fn(async (_pk: string, content: string) => content),
    },
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('fetchRemoteWatchlist — newest-wins across relays (audit finding M5)', () => {
  it('returns the list from the event with the HIGHEST created_at, not the first relay to answer', async () => {
    // relay.damus.io answers first with a STALE revision; nos.lol answers with
    // the newer one. The old code took damus (first) and silently rolled back.
    configureRelays({
      'wss://relay.damus.io': [evt(1000, ['https://old-only.mint'])],
      'wss://nos.lol': [evt(2000, ['https://kept-a.mint', 'https://kept-b.mint'])],
    })

    const res = await fetchRemoteWatchlist(PK)

    expect(res.failed).toBe(false)
    expect(res.urls).toEqual(['https://kept-a.mint', 'https://kept-b.mint'])
  })

  it('still picks the newest even when the newer event arrives LATER (within the grace window)', async () => {
    vi.useFakeTimers()
    // stale relay resolves at 10ms, fresh relay at 300ms — both well inside
    // GRACE_AFTER_FIRST_MS (1200ms), so the collector must still be listening
    // when the newer revision lands.
    querySync.mockImplementation((relays: string[]) => {
      const relay = relays[0]!
      if (relay === 'wss://relay.damus.io') {
        return new Promise(r => setTimeout(() => r([evt(1000, ['https://stale.mint'])]), 10))
      }
      if (relay === 'wss://nos.lol') {
        return new Promise(r => setTimeout(() => r([evt(5000, ['https://fresh.mint'])]), 300))
      }
      return Promise.resolve([])
    })

    const p = fetchRemoteWatchlist(PK)
    await vi.advanceTimersByTimeAsync(1500)
    const res = await p

    expect(res.failed).toBe(false)
    expect(res.urls).toEqual(['https://fresh.mint'])
  })

  it('ignores an event whose pubkey is not the user (a relay ignoring the authors filter)', async () => {
    configureRelays({
      'wss://relay.damus.io': [evt(9999, ['https://attacker-injected.mint'], OTHER_PK)],
    })

    const res = await fetchRemoteWatchlist(PK)

    // The only "event" was forged for another key → treated as no data at all.
    expect(res.urls).toEqual([])
    expect(res.failed).toBe(false)
  })

  it('treats "every relay reached, none had an event" as genuinely empty (failed: false)', async () => {
    configureRelays({}) // all relays resolve []
    const res = await fetchRemoteWatchlist(PK)
    expect(res).toEqual({ urls: [], failed: false })
  })

  it('surfaces a connection error (failed: true) when a relay errors and none returned data', async () => {
    configureRelays({ 'wss://relay.damus.io': new Error('ECONNREFUSED') })
    const res = await fetchRemoteWatchlist(PK)
    expect(res).toEqual({ urls: [], failed: true })
  })

  it('times out to failed: true when a relay never responds and no event arrived', async () => {
    vi.useFakeTimers()
    configureRelays({ 'wss://relay.damus.io': 'never' })
    const p = fetchRemoteWatchlist(PK)
    await vi.advanceTimersByTimeAsync(3100) // past MAX_WAIT_MS
    const res = await p
    expect(res).toEqual({ urls: [], failed: true })
  })

  it('returns failed: true when the newest event cannot be decrypted', async () => {
    configureRelays({ 'wss://nos.lol': [evt(2000, ['https://x.mint'])] })
    ;(window as unknown as { nostr: { nip44: { decrypt: unknown } } }).nostr.nip44.decrypt =
      vi.fn(async () => { throw new Error('bad ciphertext') })

    const res = await fetchRemoteWatchlist(PK)
    expect(res).toEqual({ urls: [], failed: true })
  })
})
