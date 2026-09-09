/**
 * MintRadar — NIP-89 Handler Registration
 *
 * Publishes a kind:31990 event declaring MintRadar as a recommended
 * application handler for kind:38172 (Cashu mint announcements, NIP-87).
 *
 * Once published, Nostr clients that support NIP-89 (Amethyst, Damus, etc.)
 * will offer "Open in MintRadar" when a user taps on a kind:38172 event.
 *
 * This script only needs to be run ONCE (or when you want to update the event).
 *
 * Usage:
 *   # With an existing private key (recommended — keep this key stable):
 *   HANDLER_PRIVKEY=nsec1...  node scripts/publish-nip89-handler.js
 *   HANDLER_PRIVKEY=<64-char-hex>  node scripts/publish-nip89-handler.js
 *
 *   # Without a key — generates a throwaway ephemeral key (NOT recommended for
 *   # production; you won't be able to update the event later unless you save the
 *   # printed nsec):
 *   node scripts/publish-nip89-handler.js
 *
 * The script prints the published event ID and the handler pubkey (npub).
 * Save the HANDLER_PRIVKEY / nsec for future updates.
 */

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Load nostr-tools from backend/node_modules — same pattern as test-notification.js
const req = createRequire(import.meta.url)
const BACKEND = resolve(__dirname, '../backend/node_modules')

const { finalizeEvent, generateSecretKey, getPublicKey, nip19 } =
  req(resolve(BACKEND, 'nostr-tools/lib/cjs/index.js'))
const { SimplePool } = req(resolve(BACKEND, 'nostr-tools/lib/cjs/pool.js'))
const WebSocket = req(resolve(BACKEND, 'ws'))

// ── Relays to publish the handler event to ────────────────────────────────────

const PUBLISH_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://purplepag.es',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
]

// ── Key parsing ───────────────────────────────────────────────────────────────

function parsePrivkey(raw) {
  if (raw.startsWith('nsec1')) {
    const decoded = nip19.decode(raw)
    if (decoded.type !== 'nsec') throw new Error('HANDLER_PRIVKEY decoded unexpectedly')
    return decoded.data
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex')
  }
  throw new Error('HANDLER_PRIVKEY must be nsec1... or 64-char hex')
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let privkey
  let isEphemeral = false

  if (process.env['HANDLER_PRIVKEY']) {
    try {
      privkey = parsePrivkey(process.env['HANDLER_PRIVKEY'])
    } catch (err) {
      console.error('[error]', err.message)
      process.exit(1)
    }
  } else {
    privkey = generateSecretKey()
    isEphemeral = true
    console.warn('⚠️  No HANDLER_PRIVKEY set — using ephemeral key.')
    console.warn('   Save the nsec below if you want to update this event later.\n')
  }

  const pubkey = getPublicKey(privkey)
  const nsec = nip19.nsecEncode(privkey)
  const npub = nip19.npubEncode(pubkey)

  console.log(`Handler pubkey : ${npub}`)
  if (isEphemeral) {
    console.log(`Handler nsec   : ${nsec}  ← save this!`)
  }
  console.log()

  // kind:31990 handler information event (NIP-89)
  const event = finalizeEvent({
    kind: 31990,
    created_at: Math.floor(Date.now() / 1000),
    content: JSON.stringify({
      name: 'MintRadar',
      about: 'Real-time Cashu mint monitoring dashboard with Trust Score, NUT compatibility, uptime tracking and community reviews.',
      website: 'https://mintradar.org',
    }),
    tags: [
      ['d', 'mintradar-handler-38172'],
      ['k', '38172'],
      ['web', 'https://mintradar.org/mint/<bech32>', 'naddr'],
    ],
  }, privkey)

  console.log('Event to publish:')
  console.log(JSON.stringify(event, null, 2))
  console.log()

  if (!globalThis.WebSocket) {
    globalThis.WebSocket = WebSocket
  }

  const pool = new SimplePool()
  let published = 0

  console.log(`Publishing to ${PUBLISH_RELAYS.length} relays…`)

  await Promise.allSettled(
    PUBLISH_RELAYS.map(async relay => {
      try {
        await pool.publish([relay], event)
        console.log(`  ✓ ${relay}`)
        published++
      } catch (err) {
        console.log(`  ✗ ${relay} — ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  )

  pool.destroy()

  console.log()
  if (published > 0) {
    console.log(`✓ Published to ${published}/${PUBLISH_RELAYS.length} relays`)
    console.log(`  Event ID : ${event.id}`)
    console.log(`  Handler  : ${npub}`)
    console.log()
    console.log('Next steps:')
    console.log('  1. Note the handler pubkey above — users who follow you will see')
    console.log('     MintRadar as a suggested handler for kind:38172 events.')
    console.log('  2. You (or any user) can publish a kind:31989 recommendation event')
    console.log('     pointing to this handler to boost its visibility.')
    if (isEphemeral) {
      console.log(`  3. Re-run with HANDLER_PRIVKEY=${nsec} to update this event.`)
    }
  } else {
    console.error('✗ Failed to publish to any relay')
    process.exit(1)
  }
}

main().catch(err => {
  console.error('[fatal]', err)
  process.exit(1)
})
