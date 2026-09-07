import { nip19, nip44, generateSecretKey, getPublicKey as nostrGetPublicKey, verifyEvent, finalizeEvent } from 'nostr-tools'
import { BunkerSigner, parseBunkerInput, createNostrConnectURI, toBunkerURL } from 'nostr-tools/nip46'
import { SimplePool } from 'nostr-tools/pool'
import type { EventTemplate, Filter, NostrEvent } from 'nostr-tools'
import * as secp from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { sharedPool } from '@/core/nostr/pool'
import { useAuthStore } from '@/stores/auth.store'

export interface NostrProfile {
  pubkey: string
  npub: string
  name?: string
  picture?: string
}

// Small, fast relay set for the post-login bootstrap (kind:0 profile + kind:10002
// relay list). purplepag.es specifically indexes exactly these two replaceable
// kinds; primal/damus/nos.lol give broad coverage and all connect + EOSE well
// under ~600ms (same fast-path rationale as REVIEW_READ_RELAYS in relays.ts).
// Deliberately NOT the project-wide relay set — the slow / often-unreachable
// relays that used to live here (nostr.cypherpunk.today, nostr.bitcoiner.social,
// nostr-pub.wellorder.net, offchain.pub, relay.snort.social) each cost up to
// ~3s of dead wait on the login path for no extra yield.
const META_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
]

const USER_BOOTSTRAP_TIMEOUT_MS = 6000

type SubHandle = { close: (reason?: string) => void }

// Resolve as soon as the first event that passes verifyEvent() AND is signed by
// `expectedPubkey` arrives, then tear the subscription down — never block on the
// slower relays reaching EOSE (that per-relay ceiling was ~4.4s and dominated the
// old querySync path). Resolves null on all-relays-EOSE-with-nothing or the timeout.
//
// `expectedPubkey` binding (2026-09-07 security audit, finding M6): a relay can
// ignore the `authors` filter and serve a validly-signed event for a DIFFERENT
// key. verifyEvent() only proves the signature is self-consistent, not that the
// event belongs to the user we asked about — so callers that act on the result
// (profile name/avatar, NIP-65 relay list) must pin the author explicitly.
function subscribeFirstEvent(relays: string[], filter: Filter, timeoutMs: number, expectedPubkey?: string): Promise<NostrEvent | null> {
  return new Promise(resolve => {
    const held: { sub?: SubHandle } = {}
    let done = false
    const finish = (ev: NostrEvent | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { held.sub?.close() } catch { /* already closed */ }
      resolve(ev)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    held.sub = sharedPool.subscribeMany(relays, filter, {
      onevent: (ev: NostrEvent) => {
        if (!verifyEvent(ev)) return
        if (expectedPubkey !== undefined && ev.pubkey !== expectedPubkey) return
        finish(ev)
      },
      oneose: () => finish(null),
      onclose: () => finish(null),
    })
  })
}

function parseProfileMeta(content: string): { name?: string; picture?: string } {
  try {
    const meta = JSON.parse(content) as { display_name?: string; name?: string; picture?: string }
    const result: { name?: string; picture?: string } = {}
    const nameVal = meta.display_name ?? meta.name
    if (nameVal !== undefined) result.name = nameVal
    if (meta.picture !== undefined) result.picture = meta.picture
    return result
  } catch { return {} }
}

// NIP-65: unmarked r-tags = both read+write, t[2]==='read'/'write' = one side only.
function parseNip65Tags(tags: string[][]): { read: string[]; write: string[] } {
  const pick = (side: 'read' | 'write') => tags
    .filter(t => t[0] === 'r' && (!t[2] || t[2] === side))
    .map(t => t[1])
    .filter((r): r is string => Boolean(r))
  return { read: pick('read'), write: pick('write') }
}

export async function fetchNostrProfile(pubkey: string, extraRelays?: string[]): Promise<{ name?: string; picture?: string }> {
  const relays = extraRelays && extraRelays.length > 0
    ? [...new Set([...META_RELAYS, ...extraRelays])]
    : META_RELAYS
  const event = await subscribeFirstEvent(relays, { kinds: [0], authors: [pubkey], limit: 1 }, USER_BOOTSTRAP_TIMEOUT_MS, pubkey)
  return event ? parseProfileMeta(event.content) : {}
}

// Module-level guard so the two triggers for a bootstrap (the login call path
// and useUserRelays mounting) never open two parallel subscriptions.
let bootstrapInFlight: string | null = null

// One subscription for BOTH the kind:0 profile and the kind:10002 relay list,
// instead of the old two separate waves (loginWith* profile fetch + a distinct
// useUserRelays kind:10002 fetch). Fills name/avatar via updateProfileMeta() and
// the relay list via setNip65Relays() as each arrives; closes on first-of-each,
// all-EOSE, or timeout. Returns a disposer for the effect cleanup.
export function bootstrapUserData(pubkey: string): () => void {
  const noop = () => {}
  if (bootstrapInFlight === pubkey) return noop
  const auth = useAuthStore.getState()
  if (auth.nip65Relays !== null && auth.profile?.pubkey === pubkey) return noop
  bootstrapInFlight = pubkey

  const held: { sub?: SubHandle } = {}
  let gotProfile = false
  let gotRelays = false
  let closed = false

  const finish = () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    try { held.sub?.close() } catch { /* already closed */ }
    if (bootstrapInFlight === pubkey) bootstrapInFlight = null
  }
  const timer = setTimeout(finish, USER_BOOTSTRAP_TIMEOUT_MS)
  const stillCurrent = () => useAuthStore.getState().profile?.pubkey === pubkey

  held.sub = sharedPool.subscribeMany(META_RELAYS, { kinds: [0, 10002], authors: [pubkey] }, {
    onevent: (ev: NostrEvent) => {
      if (!verifyEvent(ev)) return
      // M6 (2026-09-07 security audit): a hostile relay in META_RELAYS can ignore
      // the `authors` filter and return a validly-signed kind:0 / kind:10002 for a
      // DIFFERENT pubkey. verifyEvent() does not bind the event to `pubkey`. Acting
      // on such an event would let the relay set the victim's displayed name/avatar
      // and — the real damage — swap in an attacker-controlled NIP-65 relay list,
      // redirecting the victim's outbound watchlist/DM traffic. Drop it.
      if (ev.pubkey !== pubkey) return
      if (!stillCurrent()) { finish(); return }
      if (ev.kind === 0 && !gotProfile) {
        gotProfile = true
        const meta = parseProfileMeta(ev.content)
        if (meta.name !== undefined || meta.picture !== undefined) {
          useAuthStore.getState().updateProfileMeta(pubkey, meta)
        }
      } else if (ev.kind === 10002 && !gotRelays) {
        gotRelays = true
        const { read, write } = parseNip65Tags(ev.tags)
        if (read.length > 0 || write.length > 0) {
          useAuthStore.getState().setNip65Relays({ read, write })
          // Rare fallback: profile absent from the shared relays but the user
          // just told us their own — one more non-blocking look there.
          if (!gotProfile && read.length > 0) {
            void fetchNostrProfile(pubkey, read).then(m => {
              if (stillCurrent() && (m.name !== undefined || m.picture !== undefined)) {
                useAuthStore.getState().updateProfileMeta(pubkey, m)
              }
            })
          }
        }
      }
      if (gotProfile && gotRelays) finish()
    },
    oneose: () => finish(),
    onclose: () => finish(),
  })

  return finish
}

export function isNip07Available(): boolean {
  return typeof window !== 'undefined' && window.nostr !== undefined
}

// Best-effort classification of the active signer, for diagnostic logging only.
// Bunker AND nsec both install a window.nostr shim too, so both must be
// checked before falling back to "a real nip-07 extension is present".
export function detectLoginMethod(): 'bunker' | 'nip-07' | 'nsec' {
  if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(BUNKER_PUBKEY_KEY)) return 'bunker'
  if (activeNsecPrivkey !== null) return 'nsec'
  if (typeof window !== 'undefined' && window.nostr !== undefined) return 'nip-07'
  return 'nsec'
}

export async function loginWithNip07(): Promise<NostrProfile> {
  if (!isNip07Available()) {
    throw new Error('NIP-07 extension not available')
  }
  const pubkey = await window.nostr!.getPublicKey()
  const npub = nip19.npubEncode(pubkey)
  // Return the moment we have the pubkey — the navbar shows the logged-in state
  // immediately (short npub as the name fallback). Name, avatar and the NIP-65
  // relay list are filled in afterwards by bootstrapUserData(), triggered from
  // useUserRelays once the auth store holds this pubkey.
  return { pubkey, npub }
}

export async function loginWithNsec(input: string): Promise<NostrProfile> {
  let privkeyBytes: Uint8Array
  if (input.startsWith('nsec1')) {
    const decoded = nip19.decode(input)
    if (decoded.type !== 'nsec') throw new Error('Invalid nsec key')
    privkeyBytes = decoded.data as Uint8Array
  } else if (/^[0-9a-f]{64}$/i.test(input)) {
    privkeyBytes = hexToBytes(input)
  } else {
    throw new Error('Enter a valid nsec1... key or 64-char hex private key')
  }
  const pubkeyHex = bytesToHex(secp.getPublicKey(privkeyBytes, true).slice(1))
  installNsecShim(privkeyBytes, pubkeyHex)
  const npub = nip19.npubEncode(pubkeyHex)
  return { pubkey: pubkeyHex, npub }
}

// ── nsec session (in-memory signing) ────────────────────────────

// The derived private key is held in memory for the session so this app can
// sign events on the user's behalf (notifications, watchlist sync, reviews).
// Module-scope only — NEVER written to sessionStorage/localStorage/IndexedDB —
// so it does not survive a page reload, and is explicitly zeroed on logout via
// removeNsecShim(). installNsecShim() holds the exact same Uint8Array instance
// passed in (no copy), so zeroing it here invalidates every closure that
// captured it, without needing to track/duplicate the key material elsewhere.
let activeNsecPrivkey: Uint8Array | null = null
// Saved NIP-07 extension reference so it can be restored on logout (same
// distinction installBunkerShim/removeBunkerShim make below).
let originalNostrForNsec: Window['nostr'] | undefined = undefined

function installNsecShim(privkeyBytes: Uint8Array, pubkeyHex: string): void {
  if (typeof window === 'undefined') return
  if (window.nostr !== undefined) {
    if (window.nostr.__mintradarShim) {
      forceTeardownExistingShim()
    } else {
      originalNostrForNsec = window.nostr
    }
  }
  activeNsecPrivkey = privkeyBytes
  window.nostr = {
    __mintradarShim: true,
    getPublicKey: async () => pubkeyHex,
    signEvent: async (event: object) => finalizeEvent(event as EventTemplate, privkeyBytes),
    nip44: {
      encrypt: async (pubkey: string, plaintext: string) => {
        const conversationKey = nip44.getConversationKey(privkeyBytes, pubkey)
        return nip44.encrypt(plaintext, conversationKey)
      },
      decrypt: async (pubkey: string, ciphertext: string) => {
        const conversationKey = nip44.getConversationKey(privkeyBytes, pubkey)
        return nip44.decrypt(ciphertext, conversationKey)
      },
    },
    nip04: {
      encrypt: async () => { throw new Error('NIP-04 not supported for nsec login') },
      decrypt: async () => { throw new Error('NIP-04 not supported for nsec login') },
    },
  }
}

export function removeNsecShim(): void {
  if (activeNsecPrivkey === null) return
  activeNsecPrivkey.fill(0)
  activeNsecPrivkey = null
  if (typeof window !== 'undefined') {
    if (originalNostrForNsec !== undefined) {
      window.nostr = originalNostrForNsec
      originalNostrForNsec = undefined
    } else {
      delete window.nostr
    }
  }
}

// ── NIP-46 bunker session ──────────────────────────────────────

// Ephemeral client key for the NIP-46 session — NOT the user's identity key.
// Lives only in sessionStorage; cleared on logout or tab close.
let activeBunkerSigner: BunkerSigner | null = null
// The QR pairing flow runs on its own disposable SimplePool (not the app's
// sharedPool, which must never be destroyed). Once a pairing succeeds the pool
// is handed to the live signer and kept here so logout can close its sockets.
let activeBunkerPool: SimplePool | null = null
// Saved NIP-07 extension reference so it can be restored on logout
let originalNostr: Window['nostr'] | undefined = undefined

const BUNKER_URI_KEY = 'bunkerURI'
const BUNKER_SECRET_KEY = 'bunkerClientSecretKey'
const BUNKER_PUBKEY_KEY = 'bunkerPubkey'

const NIP46_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.snort.social', 'wss://nostr.bitcoiner.social', 'wss://nostr.cypherpunk.today']

// bunker:// paste is a pure relay round-trip → 30s. The QR flow additionally
// waits for a human to pick up their phone, open the signer app, scan and
// approve, so it gets a longer budget.
const BUNKER_CONNECT_TIMEOUT_MS = 30_000
const QR_PAIRING_TIMEOUT_MS = 120_000

// NIP-46 `onauth`: the remote signer sends an approval URL and nostr-tools hands
// it straight through — no validation. A malicious or compromised bunker could
// return a phishing URL, a `javascript:`/`data:` URL, or (without noopener) one
// that reverse-tabnabs the MintRadar tab via window.opener. So: only ever open
// an https:// URL, and always with noopener,noreferrer. (2026-09-07 audit, L3.)
// Exported for unit testing.
export function openRemoteSignerAuthUrl(url: unknown): void {
  if (typeof url === 'string' && /^https:\/\//i.test(url)) {
    window.open(url, '_blank', 'noopener,noreferrer')
  } else {
    console.warn('[nip46] ignoring non-https auth URL from remote signer')
  }
}

function installBunkerShim(signer: BunkerSigner, pubkeyHex: string): void {
  if (typeof window === 'undefined') return
  if (window.nostr !== undefined) {
    if (window.nostr.__mintradarShim) {
      forceTeardownExistingShim()
    } else {
      originalNostr = window.nostr
    }
  }
  activeBunkerSigner = signer
  window.nostr = {
    __mintradarShim: true,
    getPublicKey: async () => pubkeyHex,
    signEvent: (event: object) =>
      signer.signEvent(event as EventTemplate) as Promise<object>,
    nip44: {
      encrypt: (pubkey: string, plaintext: string) => signer.nip44Encrypt(pubkey, plaintext),
      decrypt: (pubkey: string, ciphertext: string) => signer.nip44Decrypt(pubkey, ciphertext),
    },
    nip04: {
      encrypt: async () => { throw new Error('NIP-04 not supported by remote signer') },
      decrypt: async () => { throw new Error('NIP-04 not supported by remote signer') },
    },
  }
}

export function removeBunkerShim(): void {
  if (activeBunkerSigner === null) return
  if (typeof window !== 'undefined') {
    if (originalNostr !== undefined) {
      window.nostr = originalNostr
      originalNostr = undefined
    } else {
      delete window.nostr
    }
  }
  activeBunkerSigner.close().catch(() => {})
  activeBunkerSigner = null
  activeBunkerPool?.destroy()
  activeBunkerPool = null
  sessionStorage.removeItem(BUNKER_URI_KEY)
  sessionStorage.removeItem(BUNKER_SECRET_KEY)
  sessionStorage.removeItem(BUNKER_PUBKEY_KEY)
}

// Called by installNsecShim/installBunkerShim when window.nostr is already a
// still-live MintRadar shim (marked __mintradarShim) from a different,
// incomplete login flow — e.g. a bunker/QR pairing still in flight when an
// nsec login is submitted. Actively tears down whichever shim is live
// instead of capturing it as `original`, so it can never be resurrected via
// removeNsecShim()/removeBunkerShim() restoring it after logout.
function forceTeardownExistingShim(): void {
  if (activeNsecPrivkey !== null) {
    activeNsecPrivkey.fill(0)
    activeNsecPrivkey = null
    originalNostrForNsec = undefined
  }
  if (activeBunkerSigner !== null) {
    activeBunkerSigner.close().catch(() => {})
    activeBunkerSigner = null
    activeBunkerPool?.destroy()
    activeBunkerPool = null
    originalNostr = undefined
    sessionStorage.removeItem(BUNKER_URI_KEY)
    sessionStorage.removeItem(BUNKER_SECRET_KEY)
    sessionStorage.removeItem(BUNKER_PUBKEY_KEY)
  }
  if (typeof window !== 'undefined') delete window.nostr
}

export async function loginWithBunker(bunkerInput: string): Promise<NostrProfile> {
  const clientSecretKey = generateSecretKey()
  const bp = await parseBunkerInput(bunkerInput)
  if (!bp) throw new Error('Invalid bunker URI or NIP-05 identifier')
  const signer = BunkerSigner.fromBunker(clientSecretKey, bp, {
    onauth: openRemoteSignerAuthUrl,
  })
  await Promise.race([
    signer.connect(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Connection timeout — bunker relay did not respond within 30 seconds')), BUNKER_CONNECT_TIMEOUT_MS)),
  ])
  const pubkeyHex = await signer.getPublicKey()
  installBunkerShim(signer, pubkeyHex)
  // Store canonical bunker:// URL so restore never needs a network lookup
  sessionStorage.setItem(BUNKER_URI_KEY, toBunkerURL(bp))
  sessionStorage.setItem(BUNKER_SECRET_KEY, bytesToHex(clientSecretKey))
  sessionStorage.setItem(BUNKER_PUBKEY_KEY, pubkeyHex)
  const npub = nip19.npubEncode(pubkeyHex)
  return { pubkey: pubkeyHex, npub }
}

// Builds a fresh client-initiated nostrconnect:// URI plus its ephemeral client
// key. Exported so the URI-shape invariants (secret entropy, relay set, name)
// can be unit-tested without touching the network.
export function buildNostrConnectURI(): { uri: string; clientSecretKey: Uint8Array } {
  const clientSecretKey = generateSecretKey()
  const clientPubkey = nostrGetPublicKey(clientSecretKey)
  // Full 32-byte random secret (NIP-46 puts no length cap on it; BunkerSigner
  // only does an exact string compare against the signer's ack).
  const secret = bytesToHex(generateSecretKey())
  const uri = createNostrConnectURI({ clientPubkey, relays: NIP46_RELAYS, secret, name: 'MintRadar' })
  return { uri, clientSecretKey }
}

// Initiates a client-initiated nostrconnect:// pairing flow (QR scanned by a
// mobile signer app). Returns the URI to display as QR and a promise that
// resolves once the signer connects back.
export function initBunkerQR(): {
  uri: string
  loginPromise: Promise<NostrProfile>
  cancel: () => void
} {
  const { uri, clientSecretKey } = buildNostrConnectURI()
  const abortCtrl = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  // Dedicated pool for this attempt so cancel()/timeout can close every socket
  // it opened. On success the live signer takes ownership (see `handedOff`).
  const pairingPool = new SimplePool()
  let handedOff = false
  const disposePool = () => { if (!handedOff) pairingPool.destroy() }

  const rawSigner = BunkerSigner.fromURI(
    clientSecretKey,
    uri,
    { onauth: openRemoteSignerAuthUrl, pool: pairingPool },
    abortCtrl.signal
  )
  // If the timeout wins the race below, fromURI still rejects on abort — keep
  // that from surfacing as an unhandled rejection.
  rawSigner.catch(() => {})

  const loginPromise = Promise.race([
    rawSigner,
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        abortCtrl.abort()
        reject(new Error('Pairing timed out — no signer connected within 2 minutes. Refresh the QR and try again.'))
      }, QR_PAIRING_TIMEOUT_MS)
    }),
  ]).then(async signer => {
    handedOff = true
    activeBunkerPool = pairingPool
    const pubkeyHex = await signer.getPublicKey()
    installBunkerShim(signer, pubkeyHex)
    // Derive canonical bunker:// from signer.bp so restore doesn't reuse a one-time URI
    sessionStorage.setItem(BUNKER_URI_KEY, toBunkerURL(signer.bp))
    sessionStorage.setItem(BUNKER_SECRET_KEY, bytesToHex(clientSecretKey))
    sessionStorage.setItem(BUNKER_PUBKEY_KEY, pubkeyHex)
    const npub = nip19.npubEncode(pubkeyHex)
    return { pubkey: pubkeyHex, npub }
  }).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    disposePool()
  })

  return {
    uri,
    loginPromise,
    cancel: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      abortCtrl.abort()
      disposePool()
    },
  }
}

// Restores a bunker session after a page refresh.
// Installs the window.nostr shim synchronously with the stored pubkey,
// then re-establishes the relay subscription in the background.
export async function restoreBunkerSession(): Promise<void> {
  const storedUri = sessionStorage.getItem(BUNKER_URI_KEY)
  const secretHex = sessionStorage.getItem(BUNKER_SECRET_KEY)
  const storedPubkey = sessionStorage.getItem(BUNKER_PUBKEY_KEY)
  if (!storedUri || !secretHex || !storedPubkey) return
  try {
    const clientSecretKey = hexToBytes(secretHex)
    const bp = await parseBunkerInput(storedUri)
    if (!bp) throw new Error('Invalid stored bunker URI')
    const signer = BunkerSigner.fromBunker(clientSecretKey, bp, {
      onauth: openRemoteSignerAuthUrl,
    })
    // Optimistic restore: shim installed before connect() resolves to allow
    // synchronous window.nostr access on page refresh. If connect() fails,
    // M-1 fix ensures auth store is cleared and user is logged out cleanly.
    installBunkerShim(signer, storedPubkey)
    // Reconnect relay subscription in background; clear session and log out if it fails
    void signer.connect().catch(() => {
      removeBunkerShim()
      useAuthStore.getState().logout()
    })
  } catch {
    sessionStorage.removeItem(BUNKER_URI_KEY)
    sessionStorage.removeItem(BUNKER_SECRET_KEY)
    sessionStorage.removeItem(BUNKER_PUBKEY_KEY)
  }
}
