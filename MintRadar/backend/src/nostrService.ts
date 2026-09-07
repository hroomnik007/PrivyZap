import { nip19, nip17, getPublicKey, finalizeEvent } from 'nostr-tools'
// SimplePool and useWebSocketImplementation are deliberately both imported from
// the 'nostr-tools/pool' subpath rather than the root 'nostr-tools' package.
// The two entry points are separate compiled bundles with their own
// module-scoped `_WebSocket` variable — the root package's SimplePool has no
// wiring to the useWebSocketImplementation() exported by 'nostr-tools/pool'
// (and vice versa), so calling useWebSocketImplementation() while importing
// SimplePool from the other entry point would silently have no effect on the
// pool actually used below. Verified against node_modules/nostr-tools's
// compiled output (lib/cjs/index.js's SimplePool captures its own _WebSocket2
// at module-load time and exposes no setter; lib/cjs/pool.js's SimplePool
// reads the _WebSocket useWebSocketImplementation() mutates).
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
import type { Event as NostrEvent } from 'nostr-tools'
import WebSocket from 'ws'
import type { ClientRequestArgs } from 'http'
import { pool } from './db.js'
import { safeLookup } from './ssrf.js'

// Node.js 20 has no native WebSocket — inject ws polyfill for nostr-tools
// (same pattern as discovery.ts / index.ts's nostr-reviews endpoint).
if (!globalThis.WebSocket) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).WebSocket = WebSocket
}

// DNS-rebinding TOCTOU fix: relay URLs stored on subscribe are SSRF-checked
// once (checkWsUrlSafety in index.ts), but nostr-tools' SimplePool otherwise
// opens `new WebSocket(url)` at publish time with no re-validation — a
// low-TTL domain could repoint to an internal address between subscribe and
// the next notification. `ws` forwards unrecognized constructor options
// straight through to the underlying `http`/`https`/`net`/`tls` connect
// (see initAsClient in ws/lib/websocket.js), which accepts the same `lookup`
// option undici's Agent uses in ssrf.ts — so pinning DNS resolution at
// connect time works here exactly like it does for HTTPS probing. This is
// installed as the nostr-tools-wide WebSocket implementation (there is no
// per-relay hook on SimplePool), so it applies to every relay connection the
// backend makes, closing the gap for good rather than just narrowing it.
class DnsPinnedWebSocket extends WebSocket {
  constructor(address: string | URL, protocols?: string | string[]) {
    super(address, protocols, { lookup: safeLookup } as ClientRequestArgs)
  }
}
// Not a React hook — the react-hooks plugin flags this purely because of the "use" name
// prefix nostr-tools chose for this function.
// eslint-disable-next-line react-hooks/rules-of-hooks
useWebSocketImplementation(DnsPinnedWebSocket)

// Mirrors the frontend's META_RELAYS (src/core/nostr/client.ts) — the two
// packages can't share a module directly (no workspace set up), so keep
// these two arrays in sync manually when editing either one.
const META_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://purplepag.es',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://nostr-pub.wellorder.net',
  'wss://nostr.bitcoiner.social',
  'wss://nostr.cypherpunk.today',
]

// Mirrors the frontend's NOTIFICATION_RELAYS (src/hooks/useWatchlistNotifications.ts)
// — same no-workspace caveat as above. Used as the fallback/redundancy set unioned
// with each subscriber's own stored relays when delivering a DM.
const NOTIFICATION_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://purplepag.es',
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

const RELAY_PUBLISH_TIMEOUT_MS = 5_000
// Per-direction cooldown: at most one down-alert and one up-alert per subscriber
// per mint per hour. Enforced atomically in SQL (see notifySubscribers) — a
// constant so the interval literal in the query stays in one place.
const COOLDOWN_MINUTES = 60

let serviceSecretKey: Uint8Array | null = null

const rawNsec = process.env['NOTIFICATION_SERVICE_NSEC']
if (!rawNsec) {
  console.warn('[notify-service] NOTIFICATION_SERVICE_NSEC not set — notification sending disabled')
} else {
  try {
    const decoded = nip19.decode(rawNsec)
    if (decoded.type !== 'nsec') {
      console.warn('[notify-service] NOTIFICATION_SERVICE_NSEC is not a valid nsec — notification sending disabled')
    } else {
      serviceSecretKey = decoded.data
      const servicePubkeyHex = getPublicKey(serviceSecretKey)
      console.log(`[notify-service] service identity loaded (pubkey ${servicePubkeyHex.slice(0, 8)}…)`)
    }
  } catch {
    console.warn('[notify-service] NOTIFICATION_SERVICE_NSEC failed to decode — notification sending disabled')
  }
}

export function isNotificationServiceEnabled(): boolean {
  return serviceSecretKey !== null
}

// Short-lived SimplePool: create → publish → allSettled with a per-relay
// timeout → destroy. Matches the existing backend pattern (discovery.ts),
// not the frontend's long-lived backoff-patched singleton (pool.ts), which
// solves a different problem.
async function publishToRelays(relays: string[], event: NostrEvent): Promise<{ succeeded: number; failed: number }> {
  const nostrPool = new SimplePool()
  try {
    const pubs = nostrPool.publish(relays, event)
    const results = await Promise.allSettled(
      pubs.map(p =>
        Promise.race([
          p,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), RELAY_PUBLISH_TIMEOUT_MS)),
        ])
      )
    )
    const succeeded = results.filter(r => r.status === 'fulfilled').length
    return { succeeded, failed: results.length - succeeded }
  } finally {
    nostrPool.destroy()
  }
}

// Publishes the "MintRadar Alerts" kind:0 profile. Called once at startup
// and re-published daily (cron.ts) since it's a cheap, idempotent
// replaceable event — keeps it fresh on relays with short retention.
export async function publishServiceProfile(): Promise<void> {
  if (!serviceSecretKey) return
  try {
    const event = finalizeEvent(
      {
        kind: 0,
        content: JSON.stringify({
          name: 'MintRadar Alerts',
          about: 'Automated Cashu mint status notifications from mintradar.pedani.eu. Replies are not monitored — manage your subscriptions in the app.',
          website: 'https://mintradar.pedani.eu',
          picture: 'https://mintradar.pedani.eu/icons/icon-512x512.png',
        }),
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      serviceSecretKey
    )
    const { succeeded, failed } = await publishToRelays(META_RELAYS, event)
    console.log(`[notify-service] published kind:0 profile (${succeeded} succeeded, ${failed} failed)`)
  } catch (err) {
    console.error('[notify-service] kind:0 publish error:', err)
  }
}

// Publishes a NIP-23 long-form article (kind:30023). `identifier` is the
// event's `d` tag — publishing again with the same identifier replaces the
// previous version on relays that honor replaceable events, so this is safe
// to re-run for edits. Same relay set and short-lived-pool publish pattern
// as publishServiceProfile.
export async function publishLongFormArticle(params: {
  identifier: string
  title: string
  content: string
  summary?: string
}): Promise<{ succeeded: number; failed: number }> {
  if (!serviceSecretKey) throw new Error('NOTIFICATION_SERVICE_NSEC not configured — cannot publish')

  const tags: string[][] = [
    ['d', params.identifier],
    ['title', params.title],
    ['published_at', String(Math.floor(Date.now() / 1000))],
  ]
  if (params.summary) tags.push(['summary', params.summary])

  const event = finalizeEvent(
    {
      kind: 30023,
      content: params.content,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    serviceSecretKey
  )
  const { succeeded, failed } = await publishToRelays(META_RELAYS, event)
  console.log(`[nostr-service] published kind:30023 "${params.identifier}" (${succeeded} succeeded, ${failed} failed)`)
  return { succeeded, failed }
}

interface ClaimedRow {
  pubkey: string
  relays: string[]
  claimed_at: Date
}

// Fires the DM for a down/up transition to every subscriber with a matching
// notify flag, respecting a per-direction hourly cooldown. Never throws — every
// failure (query, per-subscriber send) is caught and logged so a notification
// failure can never affect the probe loop that triggered it.
//
// The cooldown is enforced ATOMICALLY in SQL: a single conditional UPDATE claims
// the cooldown slot (sets the timestamp to now() only where the cooldown has
// actually elapsed) and RETURNs exactly the rows it claimed. Two overlapping
// probe cycles racing on the same up/down transition can't both claim the same
// subscriber — the loser's UPDATE matches zero rows — so at most one DM is sent.
// (Replaces a race-prone SELECT-check → send → UPDATE sequence.)
export async function notifySubscribers(mintUrl: string, direction: 'down' | 'up', checkedAt: Date): Promise<void> {
  if (!serviceSecretKey) return
  const secretKey = serviceSecretKey

  try {
    const notifyColumn = direction === 'down' ? 'notify_on_down' : 'notify_on_up'
    const cooldownColumn = direction === 'down' ? 'last_notified_down_at' : 'last_notified_up_at'

    const claimed = await pool.query(
      `UPDATE notification_subscriptions
          SET ${cooldownColumn} = now()
        WHERE mint_url = $1
          AND ${notifyColumn} = true
          AND (${cooldownColumn} IS NULL OR ${cooldownColumn} < now() - INTERVAL '${COOLDOWN_MINUTES} minutes')
       RETURNING pubkey, relays, ${cooldownColumn} AS claimed_at`,
      [mintUrl]
    )
    const rows = claimed.rows as ClaimedRow[]
    if (rows.length === 0) return

    const hostname = new URL(mintUrl).hostname
    const detailUrl = `https://mintradar.pedani.eu/mint/${encodeURIComponent(mintUrl)}`
    const message = direction === 'down'
      ? `⚠️ ${hostname} just went offline.\nView details: ${detailUrl}`
      : `✅ ${hostname} is back online.\nView details: ${detailUrl}`

    // Release a claim whose DM never went out, so the next probe cycle can
    // retry that subscriber. Guarded on the exact timestamp we set, so a
    // concurrent successful claim is never clobbered. Reverting to NULL is
    // safe — the claim query only matched rows whose cooldown had elapsed.
    const releaseClaim = (pubkey: string, claimedAt: Date) =>
      pool.query(
        `UPDATE notification_subscriptions SET ${cooldownColumn} = NULL
         WHERE pubkey = $1 AND mint_url = $2 AND ${cooldownColumn} = $3`,
        [pubkey, mintUrl, claimedAt]
      ).catch(err => console.error(`[notify] failed to release claim for ${pubkey.slice(0, 8)}…:`, err))

    let sent = 0
    let failed = 0

    for (const row of rows) {
      try {
        const giftWrap = nip17.wrapEvent(secretKey, { publicKey: row.pubkey }, message)
        const targetRelays = [...new Set([...row.relays, ...NOTIFICATION_RELAYS])]
        const { succeeded } = await publishToRelays(targetRelays, giftWrap)

        if (succeeded > 0) {
          sent++
        } else {
          failed++
          await releaseClaim(row.pubkey, row.claimed_at)
        }
      } catch (err) {
        failed++
        console.error(`[notify] send error for mint=${mintUrl} pubkey=${row.pubkey.slice(0, 8)}…:`, err)
        await releaseClaim(row.pubkey, row.claimed_at)
      }
    }

    console.log(
      `[notify] ${direction}-alert (checked ${checkedAt.toISOString()}) for ${mintUrl}: ` +
      `claimed ${rows.length}, ${sent} sent, ${failed} failed (claim released)`
    )
  } catch (err) {
    console.error(`[notify] notifySubscribers error for mint=${mintUrl}:`, err)
  }
}
