import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// ── Fake stores (real zustand, so selector subscriptions / getState / setState
//    all behave; only the persist middleware and I/O deps are replaced). Built
//    in vi.hoisted so the hoisted vi.mock factories below can reference them. ──
const stores = vi.hoisted(async () => {
  const { create } = await import('zustand')
  const { vi } = await import('vitest')
  const setSyncStatus = vi.fn()
  const loadFromDb = vi.fn(async () => {})
  const useAuthStore = create(() => ({ profile: null as { pubkey: string } | null }))
  const useWatchlistStore = create(() => ({ mints: [] as string[], loadFromDb, setSyncStatus }))
  return { useAuthStore, useWatchlistStore, setSyncStatus, loadFromDb }
})

vi.mock('@/stores/auth.store', async () => ({ useAuthStore: (await stores).useAuthStore }))
vi.mock('@/stores/watchlist.store', async () => ({ useWatchlistStore: (await stores).useWatchlistStore }))

// ── Mocked I/O ───────────────────────────────────────────────────────────────
const io = vi.hoisted(() => ({
  fetchRemoteWatchlist: vi.fn<(pk: string, relays: unknown) => Promise<{ urls: string[]; failed: boolean }>>(),
  publishWatchlist: vi.fn<(pk: string, mints: string[], relays: unknown) => Promise<void>>(async () => {}),
  refreshAllSubscriptions: vi.fn(async () => {}),
  dbMetaGet: vi.fn(async () => undefined as { value?: string } | undefined),
  dbMetaPut: vi.fn<(e: { key: string; value: string }) => Promise<void>>(async () => {}),
  dbWatchlistClear: vi.fn(async () => {}),
  dbWatchlistToArray: vi.fn(async () => [] as unknown[]),
  dbWatchlistPut: vi.fn<(e: { url: string }) => Promise<void>>(async () => {}),
}))

vi.mock('@/core/nostr/watchlistSync', () => ({
  fetchRemoteWatchlist: io.fetchRemoteWatchlist,
  publishWatchlist: io.publishWatchlist,
}))
vi.mock('@/hooks/useUserRelays', () => {
  const stable = { read: [] as string[], write: [] as string[] }
  return { useUserRelays: () => stable }
})
vi.mock('@/core/nostr/notificationSubscription', () => ({ refreshAllSubscriptions: io.refreshAllSubscriptions }))
vi.mock('@/db', () => ({
  db: {
    meta: { get: io.dbMetaGet, put: io.dbMetaPut },
    watchlist: { clear: io.dbWatchlistClear, toArray: io.dbWatchlistToArray, put: io.dbWatchlistPut },
  },
}))

import { useWatchlistSync } from '@/hooks/useWatchlistSync'

const { useAuthStore, useWatchlistStore, setSyncStatus } = await stores
const { fetchRemoteWatchlist, publishWatchlist, dbMetaPut, dbWatchlistPut } = io

const PK_A = 'a'.repeat(64)
const PK_B = 'b'.repeat(64)

beforeEach(() => {
  vi.clearAllMocks()
  fetchRemoteWatchlist.mockReset()
  useAuthStore.setState({ profile: null })
  useWatchlistStore.setState({ mints: [] })
})

describe('useWatchlistSync — pubkey re-check after await (audit finding M4)', () => {
  it("discards user A's remote watchlist when a different user logs in during the fetch", async () => {
    // A per-pubkey deferred so we can control exactly when each fetch resolves.
    type WlResult = { urls: string[]; failed: boolean }
    const deferredByPk = new Map<string, (v: WlResult) => void>()
    fetchRemoteWatchlist.mockImplementation((pk: string) => new Promise<WlResult>(resolve => {
      deferredByPk.set(pk, resolve)
    }))

    useAuthStore.setState({ profile: { pubkey: PK_A } })
    const { unmount } = renderHook(() => useWatchlistSync())

    // doSync(A) is now parked on `await fetchRemoteWatchlist(A)`.
    await waitFor(() => expect(fetchRemoteWatchlist).toHaveBeenCalledWith(PK_A, expect.anything()))

    // User B logs in on the same device, mid-flight.
    act(() => { useAuthStore.setState({ profile: { pubkey: PK_B } }) })
    await waitFor(() => expect(fetchRemoteWatchlist).toHaveBeenCalledWith(PK_B, expect.anything()))

    // A's relay fetch finally lands, carrying A's PRIVATE list. B's lands empty.
    await act(async () => {
      deferredByPk.get(PK_A)!({ urls: ['https://a-private.mint'], failed: false })
      deferredByPk.get(PK_B)!({ urls: [], failed: false })
      await Promise.resolve()
    })
    await waitFor(() => expect(setSyncStatus).toHaveBeenCalledWith('done'))

    // A's list was never written to Dexie...
    expect(dbWatchlistPut).not.toHaveBeenCalledWith(expect.objectContaining({ url: 'https://a-private.mint' }))
    // ...and never re-published under any identity.
    for (const call of publishWatchlist.mock.calls) {
      expect(call[1]).not.toEqual(expect.arrayContaining(['https://a-private.mint']))
    }
    // The stale run for A must not have marked itself as the completed sync.
    expect(dbMetaPut).not.toHaveBeenCalledWith(expect.objectContaining({ value: PK_A }))

    unmount()
  })

  it('syncs and persists normally when the pubkey does not change (positive control)', async () => {
    fetchRemoteWatchlist.mockResolvedValue({ urls: ['https://kept.mint'], failed: false })

    useAuthStore.setState({ profile: { pubkey: PK_A } })
    const { unmount } = renderHook(() => useWatchlistSync())

    await waitFor(() =>
      expect(dbWatchlistPut).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://kept.mint' })),
    )
    await waitFor(() => expect(dbMetaPut).toHaveBeenCalledWith(expect.objectContaining({ value: PK_A })))
    await waitFor(() => expect(setSyncStatus).toHaveBeenCalledWith('done'))

    unmount()
  })
})
