import type { NostrEvent } from 'nostr-tools'
import { verifyEvent } from 'nostr-tools'
import { sharedPool } from '@/core/nostr/pool'
import { detectLoginMethod } from '@/core/nostr/client'

export const WATCHLIST_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.band',
  'wss://nostr.bitcoiner.social',
  'wss://nostr.mom',
  'wss://nostr.oxtr.dev',
  'wss://relay.mostr.pub',
  'wss://relay.noswhere.com',
  'wss://pyramid.fiatjaf.com',
  'wss://nostr.lopp.social',
  'wss://nostr.cypherpunk.today',
]

const WATCHLIST_KIND = 10003

export interface RemoteWatchlistResult {
  urls: string[]
  /**
   * true when the fetch could not be completed (relay timeout, decrypt/parse
   * failure, or every relay rejecting for a reason other than "no matching
   * event") — as opposed to a genuinely empty remote list. Lets the caller
   * show an error fallback instead of silently treating "couldn't sync" the
   * same as "user has nothing watched".
   */
  failed: boolean
}

// Overall ceiling for the remote fetch (unchanged from the old Promise.race
// timeout). Once the first valid event lands we only wait GRACE_AFTER_FIRST_MS
// more for a possibly-newer revision from a slower relay, so the common case
// stays well under the hard cap.
const MAX_WAIT_MS = 3000
const GRACE_AFTER_FIRST_MS = 1200

export async function fetchRemoteWatchlist(pubkey: string, userWriteRelays?: string[] | null): Promise<RemoteWatchlistResult> {
  const pk = pubkey.slice(0, 8)
  const method = detectLoginMethod()

  if (!window.nostr?.nip44) {
    console.warn(`[watchlist-sync] no nip44 support on signer, skipping remote fetch (pubkey=${pk}, method=${method})`)
    return { urls: [], failed: false }
  }

  const relays = userWriteRelays && userWriteRelays.length > 0
    ? [...new Set([...WATCHLIST_RELAYS, ...userWriteRelays])]
    : WATCHLIST_RELAYS

  const total = relays.length
  let responded = 0
  const errors: unknown[] = []
  const events: NostrEvent[] = []

  // kind:10003 is a replaceable event: the authoritative copy is the one with the
  // highest created_at. A lagging or malicious relay can still hold an OLDER
  // revision, and the old code took whichever relay answered first — so a stale
  // relay silently rolled the watchlist back, which Phase 2 then re-published as
  // the newest state, wiping recently-added mints for good (2026-09-07 security
  // audit, finding M5). Fix: COLLECT events across relays within the wait window
  // and keep the newest, instead of racing for the first responder. (Same
  // "validate then keep the right one" shape as subscribeFirstEvent's pubkey
  // pinning in client.ts.)
  let sawFirstEvent = false
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let resolveWait: (() => void) | undefined
  const noteEvent = () => {
    if (sawFirstEvent) return
    sawFirstEvent = true
    // Got at least one revision — only wait a short grace period for a possibly
    // newer one from a slower relay, rather than the full MAX_WAIT_MS.
    graceTimer = setTimeout(() => resolveWait?.(), GRACE_AFTER_FIRST_MS)
  }

  const relayQueries = relays.map(relay =>
    sharedPool.querySync([relay], { kinds: [WATCHLIST_KIND], authors: [pubkey], limit: 1 })
      .then(evs => {
        // verifyEvent: signature self-consistent. pubkey === pubkey: the relay did
        // not swap in someone else's event (it can ignore the authors filter).
        const valid = evs.filter(e => verifyEvent(e) && e.pubkey === pubkey && !!e.content)
        if (valid.length === 0) return
        events.push(valid.reduce((a, b) => (b.created_at > a.created_at ? b : a)))
        noteEvent()
      })
      .catch(err => { errors.push(err) })
      .finally(() => { responded++ })
  )

  let hardCap: ReturnType<typeof setTimeout> | undefined
  await new Promise<void>(resolve => {
    resolveWait = resolve
    hardCap = setTimeout(resolve, MAX_WAIT_MS)
    void Promise.allSettled(relayQueries).then(() => resolve())
  }).finally(() => {
    if (graceTimer) clearTimeout(graceTimer)
    if (hardCap) clearTimeout(hardCap)
  })

  if (events.length === 0) {
    if (responded < total) {
      console.warn(`[watchlist-sync] relay timeout after ${MAX_WAIT_MS}ms, ${responded}/${total} relays responded (pubkey=${pk}, method=${method})`)
      return { urls: [], failed: true }
    }
    if (errors.length > 0) {
      // At least one relay could not actually be queried (connection/protocol
      // error) — surface that as a failure rather than "nothing to sync".
      console.warn(`[watchlist-sync] relay fetch failed (pubkey=${pk}, method=${method}, ${responded}/${total} relays responded)`, errors[0])
      return { urls: [], failed: true }
    }
    // Every relay was reached and none held a matching event — genuinely empty.
    console.warn(`[watchlist-sync] remote list genuinely empty (kind:10003 not found or empty content) — no relay returned a valid event (pubkey=${pk}, method=${method}, ${responded}/${total} relays responded)`)
    return { urls: [], failed: false }
  }

  const newest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a))

  let decrypted: string
  try {
    decrypted = await window.nostr.nip44.decrypt(pubkey, newest.content)
  } catch (decryptErr) {
    console.warn(`[watchlist-sync] decryption failed for event ${newest.id} (pubkey=${pk}, method=${method})`, decryptErr)
    return { urls: [], failed: true }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(decrypted)
  } catch (parseErr) {
    console.warn(`[watchlist-sync] decryption failed for event ${newest.id} (pubkey=${pk}, method=${method}) — malformed JSON payload`, parseErr)
    return { urls: [], failed: true }
  }

  if (!Array.isArray(parsed)) {
    console.warn(`[watchlist-sync] remote list genuinely empty (kind:10003 not found or empty content) (pubkey=${pk}, method=${method})`)
    return { urls: [], failed: false }
  }
  const urls = parsed.filter((u): u is string => typeof u === 'string')
  if (urls.length === 0) {
    console.warn(`[watchlist-sync] remote list genuinely empty (kind:10003 not found or empty content) (pubkey=${pk}, method=${method})`)
  }
  return { urls, failed: false }
}

export async function publishWatchlist(pubkey: string, mints: string[], userWriteRelays?: string[] | null): Promise<void> {
  if (!window.nostr?.nip44) return
  const relays = userWriteRelays && userWriteRelays.length > 0
    ? [...new Set([...WATCHLIST_RELAYS, ...userWriteRelays])]
    : WATCHLIST_RELAYS
  try {
    const encrypted = await window.nostr.nip44.encrypt(pubkey, JSON.stringify(mints))
    const event = {
      kind: WATCHLIST_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [] as string[][],
      content: encrypted,
    }
    const signed = await window.nostr.signEvent(event) as NostrEvent
    const publishPromises = sharedPool.publish(relays, signed)
    publishPromises.forEach(p => p.catch(() => {}))
    await Promise.any(publishPromises).catch((err: unknown) => {
      console.warn('[watchlistSync] all relays rejected publish:', err)
    })
  } catch (err) {
    console.warn('[watchlistSync] publish failed:', err)
  }
}
