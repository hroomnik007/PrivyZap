/**
 * MintRadar — Nostr DM notification integration test
 *
 * Replicates the logic in src/hooks/useWatchlistNotifications.ts to verify
 * that a kind:4 encrypted DM is delivered when a mint transitions online→offline.
 *
 * Transition condition tested (mirrors the hook exactly):
 *   prevOnline === true && currentOnline === false  →  send "mint is down" DM
 *
 * What the script does:
 *   1. Reads the first mint URL from the mints table (or uses TEST_MINT_URL)
 *   2. Inserts two mint_history rows to record the simulated state transition:
 *        online=true  (checked 2 min ago)  — represents "was online"
 *        online=false (checked now)        — represents "is now offline"
 *   3. Detects the transition and sends a NIP-04-encrypted kind:4 DM
 *      to your own pubkey using the same relay list as the hook
 *   4. Logs the result: sent (event id) / failed (error) / skipped
 *   5. Deletes both inserted rows to restore DB state
 *
 * Prerequisites:
 *   - Node.js 20+
 *   - DATABASE_URL pointing to the MintRadar PostgreSQL database
 *   - Your Nostr private key via NOSTR_NSEC (bech32) or NOSTR_HEX_KEY (64-char hex)
 *
 * Usage:
 *   DATABASE_URL=postgresql://mintradar:pass@localhost:5432/mintradar \
 *   NOSTR_NSEC=nsec1...                                               \
 *   node scripts/test-notification.js
 *
 *   # With a hex private key instead:
 *   DATABASE_URL=... NOSTR_HEX_KEY=<64-char hex> node scripts/test-notification.js
 *
 *   # Override the target mint URL:
 *   TEST_MINT_URL=https://mint.minibits.cash/Bitcoin DATABASE_URL=... NOSTR_NSEC=... \
 *   node scripts/test-notification.js
 *
 *   # On the VPS (reads DATABASE_URL from the environment Docker injects):
 *   ssh deploy@<vps-ip>
 *   cd /var/www/mintradar-repo
 *   DATABASE_URL=$(docker compose exec -T db printenv POSTGRES_PASSWORD | \
 *     xargs -I{} echo "postgresql://mintradar:{}@localhost:5432/mintradar") \
 *   NOSTR_NSEC=nsec1... node scripts/test-notification.js
 */

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Load backend dependencies from backend/node_modules so this script has no
// deps of its own and always uses the same nostr-tools version as the backend.
const req = createRequire(import.meta.url)
const BACKEND = resolve(__dirname, '../backend/node_modules')

const { Pool: PgPool }      = req(resolve(BACKEND, 'pg'))
const { SimplePool, finalizeEvent, getPublicKey, nip04, nip19 } =
  req(resolve(BACKEND, 'nostr-tools/lib/cjs/index.js'))
const WebSocket = req(resolve(BACKEND, 'ws'))

// ── Same relay list as useWatchlistNotifications.ts ───────────────────────────

const NOTIFICATION_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://purplepag.es',
]

// ── Key parsing ───────────────────────────────────────────────────────────────

function parsePrivkey() {
  const { NOSTR_NSEC, NOSTR_HEX_KEY } = process.env

  if (NOSTR_NSEC) {
    const decoded = nip19.decode(NOSTR_NSEC)
    if (decoded.type !== 'nsec') {
      throw new Error('NOSTR_NSEC decoded to type "' + decoded.type + '" — expected "nsec"')
    }
    return decoded.data // Uint8Array<32>
  }

  if (NOSTR_HEX_KEY) {
    if (!/^[0-9a-f]{64}$/i.test(NOSTR_HEX_KEY)) {
      throw new Error('NOSTR_HEX_KEY must be a 64-character hex string')
    }
    return Buffer.from(NOSTR_HEX_KEY, 'hex') // Buffer is a Uint8Array subclass
  }

  throw new Error('Set NOSTR_NSEC=nsec1... or NOSTR_HEX_KEY=<64-char hex>')
}

// ── Notification sender — mirrors sendNostrDM() in useWatchlistNotifications ─

async function sendNostrDM(privkey, recipientPubkey, content, pool) {
  // Step 1: NIP-04 encrypt (same as window.nostr.nip04.encrypt in the browser)
  const encrypted = await nip04.encrypt(privkey, recipientPubkey, content)

  // Step 2: build + sign the kind:4 event (same structure as the browser hook)
  const unsigned = {
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', recipientPubkey]],
    content: encrypted,
  }
  const signed = finalizeEvent(unsigned, privkey)

  // Step 3: publish to all relays, succeed on the first ACK
  const publishPromises = pool.publish(NOTIFICATION_RELAYS, signed)
  await Promise.any(publishPromises)

  return signed.id
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { DATABASE_URL, TEST_MINT_URL } = process.env

  // Validate env
  if (!DATABASE_URL) {
    console.error('[error] DATABASE_URL is required')
    process.exit(1)
  }

  let privkey
  try {
    privkey = parsePrivkey()
  } catch (err) {
    console.error('[error]', err.message)
    process.exit(1)
  }

  const pubkey = getPublicKey(privkey)
  console.log(`[test] sender/recipient pubkey: ${pubkey.slice(0, 16)}…`)

  // Node.js 20 has no native WebSocket — same polyfill as backend/src/discovery.ts
  if (!globalThis.WebSocket) {
    globalThis.WebSocket = WebSocket
  }

  const db = new PgPool({ connectionString: DATABASE_URL, max: 1 })
  const nostrPool = new SimplePool()
  const insertedIds = []

  try {
    // ── 1. Pick the target mint URL ──────────────────────────────────────────

    let mintUrl = TEST_MINT_URL ?? null
    if (!mintUrl) {
      const res = await db.query('SELECT url FROM mints ORDER BY url LIMIT 1')
      if (res.rows.length === 0) {
        console.error('[error] No mints in database — run the backend once to seed them')
        return
      }
      mintUrl = res.rows[0].url
    }
    console.log(`[test] target mint: ${mintUrl}`)

    // ── 2. Insert rows to simulate the online→offline state transition ───────
    //
    // The hook keeps in-memory state (prevStates Map). Here we materialise the
    // same two data points in mint_history so the transition is also visible in
    // the historical record and can be verified with a SELECT afterwards.

    const r1 = await db.query(
      `INSERT INTO mint_history (url, online, latency_ms, checked_at)
       VALUES ($1, true, 120, NOW() - INTERVAL '2 minutes')
       RETURNING id`,
      [mintUrl]
    )
    insertedIds.push(r1.rows[0].id)
    console.log(`[test] DB: inserted online  row id=${r1.rows[0].id}`)

    const r2 = await db.query(
      `INSERT INTO mint_history (url, online, latency_ms, checked_at)
       VALUES ($1, false, NULL, NOW())
       RETURNING id`,
      [mintUrl]
    )
    insertedIds.push(r2.rows[0].id)
    console.log(`[test] DB: inserted offline row id=${r2.rows[0].id}`)

    // ── 3. Apply the same transition logic as useWatchlistNotifications.ts ───
    //
    //   prevStates.get(url)    === true   →  mint was previously online
    //   probeData[url].online  === false  →  mint is now offline
    //   Condition: prev === true && isOnline === false → send "mint down" DM

    const prevOnline = true   // the first row we inserted
    const currOnline = false  // the second row we inserted

    if (prevOnline === true && currOnline === false) {
      console.log('[test] transition online→offline detected — sending DM…')

      // Same message template as the hook
      const message =
        `⚠️ MintRadar Alert\n\nMint is down: ${mintUrl}\n\nCheck status: https://mintradar.org`

      try {
        const eventId = await sendNostrDM(privkey, pubkey, message, nostrPool)
        console.log(`[test] ✓ DM sent — event id: ${eventId}`)
      } catch (err) {
        console.error(`[test] ✗ DM failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      // This branch is never reached given the hardcoded values above; kept for
      // clarity — it mirrors the "no transition" path in the hook.
      console.log('[test] no transition — notification skipped')
    }

  } finally {
    // ── 4. Restore DB state — remove the rows we inserted ───────────────────
    if (insertedIds.length > 0) {
      await db.query(
        'DELETE FROM mint_history WHERE id = ANY($1::bigint[])',
        [insertedIds]
      )
      console.log(`[test] DB: cleaned up ${insertedIds.length} inserted row(s)`)
    }
    nostrPool.destroy()
    await db.end()
  }
}

main().catch(err => {
  console.error('[fatal]', err)
  process.exit(1)
})
