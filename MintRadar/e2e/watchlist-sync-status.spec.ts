import { test, expect, type Page } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { installApiMocks, loginAs } from './fixtures/mocks'

// Regression coverage for the "false empty flash" bug: the Watchlist page
// used to gate its empty state on an unrelated query (useKnownMints'
// isLoading), so a real watchlist sync still in flight (relay fetch, up to
// 3s on a cold device) would briefly render "No mints watched yet" before
// the actual data arrived. It also silently swallowed a fully failed relay
// fetch instead of telling the user their data might be stale.
//
// See useWatchlistSync.ts (syncStatus) / watchlistSync.ts (failed flag) /
// Watchlist.tsx (~line 307) for the fix.

const WATCHLIST_KIND = 10003

/**
 * Logs in with a real generated Nostr keypair (rather than the shared
 * fixture's fixed dummy pubkey) so a fabricated kind:10003 event can be
 * signed for the same author the app queries relays with — the client-side
 * `matchFilters` check in nostr-tools' SimplePool drops any event whose
 * pubkey doesn't match the subscription's `authors` filter, dummy pubkey or
 * not, so a real keypair is required to test the "relay actually returns
 * data" path end to end.
 */
async function loginWithRealKey(page: Page, sk: Uint8Array): Promise<{ pubkey: string }> {
  const pubkey = getPublicKey(sk)
  const npub = nip19.npubEncode(pubkey)
  await page.addInitScript(
    ({ pubkey, npub, name }) => {
      ;(window as unknown as { nostr: unknown }).nostr = {
        getPublicKey: async () => pubkey,
        signEvent: async (event: Record<string, unknown>) => ({
          ...event,
          id: 'f'.repeat(64),
          pubkey,
          sig: '0'.repeat(128),
        }),
        nip04: {
          encrypt: async (_pk: string, text: string) => text,
          decrypt: async (_pk: string, text: string) => text,
        },
        nip44: {
          encrypt: async (_pk: string, text: string) => text,
          decrypt: async (_pk: string, text: string) => text,
        },
      }
      sessionStorage.setItem(
        'mintradar_session',
        JSON.stringify({ state: { profile: { pubkey, npub, name }, method: 'nip07' }, version: 0 }),
      )
    },
    { pubkey, npub, name: 'E2E Tester' },
  )
  return { pubkey }
}

function buildWatchlistEvent(sk: Uint8Array, urls: string[], createdAt = Math.floor(Date.now() / 1000)) {
  // Content is NIP-44 "encrypted" — the login mock's nip44 is an identity
  // function (encrypt/decrypt both return the text unchanged), so a plain
  // JSON string round-trips exactly like the real encrypted payload would.
  const template: EventTemplate = {
    kind: WATCHLIST_KIND,
    created_at: createdAt,
    tags: [],
    content: JSON.stringify(urls),
  }
  return finalizeEvent(template, sk)
}

/**
 * kind:10003 relay mock where two named relays disagree: `staleRelayHost`
 * answers FIRST (small delay) with an older revision, `freshRelayHost` answers
 * slightly later with the newer one. Every other relay + every non-watchlist
 * subscription gets an immediate EOSE. Used to prove fetchRemoteWatchlist picks
 * the highest `created_at`, not the first responder (audit finding M5).
 */
async function mockDisagreeingWatchlistRelays(
  page: Page,
  opts: {
    staleRelayHost: string
    freshRelayHost: string
    staleEvent: ReturnType<typeof buildWatchlistEvent>
    freshEvent: ReturnType<typeof buildWatchlistEvent>
    staleDelayMs?: number
    freshDelayMs?: number
  },
): Promise<void> {
  await page.routeWebSocket(/^wss:\/\//, ws => {
    const host = (() => { try { return new URL(ws.url()).host } catch { return '' } })()
    ws.onMessage(message => {
      const data = typeof message === 'string' ? message : message.toString()
      let parsed: unknown
      try { parsed = JSON.parse(data) } catch { return }
      if (!Array.isArray(parsed)) return
      const [verb] = parsed as [string, ...unknown[]]

      if (verb === 'EVENT') {
        const id = (parsed[1] as { id?: string } | undefined)?.id ?? ''
        ws.send(JSON.stringify(['OK', id, true, '']))
        return
      }
      if (verb !== 'REQ') return
      const [, subId, filter] = parsed as [string, string, { kinds?: number[] } | undefined]
      const isWatchlistReq = filter?.kinds?.includes(WATCHLIST_KIND) ?? false
      if (!isWatchlistReq) { ws.send(JSON.stringify(['EOSE', subId])); return }

      if (host === opts.staleRelayHost) {
        setTimeout(() => {
          ws.send(JSON.stringify(['EVENT', subId, opts.staleEvent]))
          ws.send(JSON.stringify(['EOSE', subId]))
        }, opts.staleDelayMs ?? 30)
      } else if (host === opts.freshRelayHost) {
        setTimeout(() => {
          ws.send(JSON.stringify(['EVENT', subId, opts.freshEvent]))
          ws.send(JSON.stringify(['EOSE', subId]))
        }, opts.freshDelayMs ?? 250)
      } else {
        ws.send(JSON.stringify(['EOSE', subId]))
      }
    })
  })
}

/**
 * Relay mock where the kind:10003 (watchlist) subscription is deliberately
 * held back — every other subscription (profile bootstrap, notifications,
 * etc.) is answered immediately with EOSE so login itself isn't slowed down.
 *
 * `watchlistBehavior`:
 *  - 'slow-with-data' → after `delayMs`, sends the given event then EOSE
 *                        (simulates a real but slow/cold relay round-trip
 *                        that DOES find remote data).
 *  - 'slow-empty'      → after `delayMs`, sends only EOSE, no event
 *                        (simulates a slow relay confirming the list is
 *                        genuinely empty — not a failure).
 *  - 'never'           → never responds at all (simulates every relay
 *                        being unreachable — triggers fetchRemoteWatchlist's
 *                        3s timeout, a real failure).
 */
async function mockWatchlistRelays(
  page: Page,
  opts: { watchlistBehavior: 'slow-with-data' | 'slow-empty' | 'never'; delayMs?: number; event?: ReturnType<typeof buildWatchlistEvent> },
): Promise<void> {
  await page.routeWebSocket(/^wss:\/\//, ws => {
    ws.onMessage(message => {
      const data = typeof message === 'string' ? message : message.toString()
      let parsed: unknown
      try { parsed = JSON.parse(data) } catch { return }
      if (!Array.isArray(parsed)) return
      const [verb] = parsed as [string, ...unknown[]]

      if (verb === 'EVENT') {
        const id = (parsed[1] as { id?: string } | undefined)?.id ?? ''
        ws.send(JSON.stringify(['OK', id, true, '']))
        return
      }
      if (verb !== 'REQ') return

      const [, subId, filter] = parsed as [string, string, { kinds?: number[] } | undefined]
      const isWatchlistReq = filter?.kinds?.includes(WATCHLIST_KIND) ?? false
      if (!isWatchlistReq) {
        ws.send(JSON.stringify(['EOSE', subId]))
        return
      }

      if (opts.watchlistBehavior === 'never') return // simulate an unresponsive/unreachable relay

      setTimeout(() => {
        if (opts.watchlistBehavior === 'slow-with-data' && opts.event) {
          ws.send(JSON.stringify(['EVENT', subId, opts.event]))
        }
        ws.send(JSON.stringify(['EOSE', subId]))
      }, opts.delayMs ?? 1500)
    })
  })
}

test.describe('Watchlist sync status', () => {
  test('does not flash the empty state while a slow-but-successful relay fetch is in flight', async ({ page }) => {
    const sk = generateSecretKey()
    const event = buildWatchlistEvent(sk, ['https://alpha.mint.example'])
    await mockWatchlistRelays(page, { watchlistBehavior: 'slow-with-data', delayMs: 1500, event })
    await installApiMocks(page)
    await loginWithRealKey(page, sk)

    await page.goto('/watchlist')

    // While the sync is still pending, the empty-state copy must never
    // appear — only the skeleton (or nothing) is allowed.
    await expect(page.getByText('No mints watched yet')).not.toBeVisible()
    await expect(page.locator('.skeleton-card').first()).toBeVisible()

    // Once the (slow) relay fetch resolves, the real data replaces the
    // skeleton — still no empty-state flash at any point.
    await expect(page.locator('.wl-grid .card-name', { hasText: 'Alpha Mint' })).toBeVisible({ timeout: 4000 })
    await expect(page.getByText('No mints watched yet')).not.toBeVisible()
    await expect(page.locator('.wl-sync-error-banner')).toHaveCount(0)
  })

  test('does not flash the empty state while a slow-but-genuinely-empty relay fetch is in flight', async ({ page }) => {
    await mockWatchlistRelays(page, { watchlistBehavior: 'slow-empty', delayMs: 1500 })
    await installApiMocks(page)
    await loginAs(page)

    await page.goto('/watchlist')

    await expect(page.getByText('No mints watched yet')).not.toBeVisible()
    await expect(page.locator('.skeleton-card').first()).toBeVisible()

    // Sync concludes as genuinely empty (no error) — the empty state is now
    // legitimate, and no error banner should appear alongside it.
    await expect(page.getByText('No mints watched yet')).toBeVisible({ timeout: 4000 })
    await expect(page.locator('.wl-sync-error-banner')).toHaveCount(0)
  })

  test('picks the newest kind:10003 across relays, not the first responder (audit finding M5)', async ({ page }) => {
    const sk = generateSecretKey()
    const now = Math.floor(Date.now() / 1000)
    // relay.damus.io answers first with a STALE revision (Bravo only); nos.lol
    // answers ~250ms later with the current one (Alpha + Delta). The old
    // first-responder logic would have rolled the list back to just Bravo.
    const staleEvent = buildWatchlistEvent(sk, ['https://bravo.mint.example'], now - 3600)
    const freshEvent = buildWatchlistEvent(sk, ['https://alpha.mint.example', 'https://delta.mint.example'], now)
    await mockDisagreeingWatchlistRelays(page, {
      staleRelayHost: 'relay.damus.io',
      freshRelayHost: 'nos.lol',
      staleEvent,
      freshEvent,
    })
    await installApiMocks(page)
    await loginWithRealKey(page, sk)

    await page.goto('/watchlist')

    // The newer revision's mints render...
    await expect(page.locator('.wl-grid .card-name', { hasText: 'Alpha Mint' })).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.wl-grid .card-name', { hasText: 'Delta Mint' })).toBeVisible()
    // ...and the stale revision's mint does NOT.
    await expect(page.locator('.wl-grid .card-name', { hasText: 'Bravo Mint' })).toHaveCount(0)
    await expect(page.locator('.wl-sync-error-banner')).toHaveCount(0)
  })

  test('shows a quiet error banner (not a silent empty watchlist) when every relay fetch fails', async ({ page }) => {
    await mockWatchlistRelays(page, { watchlistBehavior: 'never' })
    await installApiMocks(page)
    await loginAs(page)

    await page.goto('/watchlist')

    // Still pending — no empty state yet, no banner yet (sync hasn't
    // concluded, so we don't know yet whether it will fail).
    await expect(page.getByText('No mints watched yet')).not.toBeVisible()
    await expect(page.locator('.wl-sync-error-banner')).toHaveCount(0)

    // After the 3s relay timeout elapses, the sync concludes as failed.
    // Local (Dexie) data is empty on this fresh device, so the empty state
    // is legitimate now — but it must be paired with an explicit banner,
    // not shown as if the user simply has nothing watched.
    await expect(page.locator('.wl-sync-error-banner')).toBeVisible({ timeout: 4500 })
    await expect(page.locator('.wl-sync-error-banner')).toContainText("Couldn't sync with Nostr relays")
    await expect(page.getByText('No mints watched yet')).toBeVisible()
  })
})
