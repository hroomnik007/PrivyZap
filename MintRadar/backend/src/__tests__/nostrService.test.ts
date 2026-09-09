import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateSecretKey, nip17, nip19, verifyEvent, getPublicKey } from 'nostr-tools'
import type { Event as NostrEvent } from 'nostr-tools'

// nostrService.ts holds the "MintRadar Alerts" service identity and sends
// Nostr DM notifications. We mock the external boundaries only:
//   - db.js pool     → no database
//   - nostr-tools's SimplePool → no real relay connections
// finalizeEvent/verifyEvent/nip19/nip17 run for real, so signature and event
// shape are genuinely verified, not assumed.
//
// nostrService.ts deliberately imports SimplePool from the 'nostr-tools/pool'
// subpath rather than the root 'nostr-tools' package (see the comment at the
// top of nostrService.ts) — root and subpath are separate compiled bundles
// with independent state, so the mock must target the same subpath the
// source file actually imports from, or this mock silently stops applying.

const publishMock = vi.fn()

vi.mock('nostr-tools/pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nostr-tools/pool')>()
  return {
    ...actual,
    SimplePool: vi.fn().mockImplementation(function SimplePoolMock() {
      return { publish: publishMock, destroy: vi.fn() }
    }),
  }
})

vi.mock('../db.js', () => ({
  pool: { query: vi.fn() },
}))

let query: ReturnType<typeof vi.fn>

const ORIGINAL_NSEC = process.env['NOTIFICATION_SERVICE_NSEC']

function allSucceed(relays: string[]) {
  return relays.map(() => Promise.resolve('ok'))
}

beforeEach(() => {
  publishMock.mockReset()
  publishMock.mockImplementation(allSucceed)
})

afterEach(() => {
  if (ORIGINAL_NSEC === undefined) delete process.env['NOTIFICATION_SERVICE_NSEC']
  else process.env['NOTIFICATION_SERVICE_NSEC'] = ORIGINAL_NSEC
})

async function loadWithNsec(nsec: string | undefined) {
  vi.resetModules()
  if (nsec === undefined) delete process.env['NOTIFICATION_SERVICE_NSEC']
  else process.env['NOTIFICATION_SERVICE_NSEC'] = nsec
  const db = await import('../db.js')
  query = db.pool.query as unknown as ReturnType<typeof vi.fn>
  query.mockReset()
  return import('../nostrService.js')
}

describe('service identity loading', () => {
  it('disables notification sending when NOTIFICATION_SERVICE_NSEC is unset', async () => {
    const svc = await loadWithNsec(undefined)
    expect(svc.isNotificationServiceEnabled()).toBe(false)
  })

  it('disables notification sending when NOTIFICATION_SERVICE_NSEC is malformed', async () => {
    const svc = await loadWithNsec('not-a-valid-nsec')
    expect(svc.isNotificationServiceEnabled()).toBe(false)
  })

  it('disables notification sending when NOTIFICATION_SERVICE_NSEC is a valid-shape bech32 but the wrong type (npub)', async () => {
    const sk = generateSecretKey()
    const npub = nip19.npubEncode(getPublicKey(sk))
    const svc = await loadWithNsec(npub)
    expect(svc.isNotificationServiceEnabled()).toBe(false)
  })

  it('loads the service identity from a valid nsec', async () => {
    const sk = generateSecretKey()
    const svc = await loadWithNsec(nip19.nsecEncode(sk))
    expect(svc.isNotificationServiceEnabled()).toBe(true)
  })
})

describe('missing service key — graceful no-op (rest of the app unaffected)', () => {
  it('publishServiceProfile no-ops without publishing', async () => {
    const svc = await loadWithNsec(undefined)
    await svc.publishServiceProfile()
    expect(publishMock).not.toHaveBeenCalled()
  })

  it('notifySubscribers no-ops without querying the DB', async () => {
    const svc = await loadWithNsec(undefined)
    await svc.notifySubscribers('https://mint.example.com', 'down', new Date())
    expect(query).not.toHaveBeenCalled()
  })
})

describe('publishServiceProfile', () => {
  it('publishes a well-formed, correctly-signed kind:0 event', async () => {
    const sk = generateSecretKey()
    const expectedPubkey = getPublicKey(sk)
    const svc = await loadWithNsec(nip19.nsecEncode(sk))

    await svc.publishServiceProfile()

    expect(publishMock).toHaveBeenCalledTimes(1)
    const [, event] = publishMock.mock.calls[0] as [string[], NostrEvent]
    expect(event.kind).toBe(0)
    expect(event.pubkey).toBe(expectedPubkey)
    expect(verifyEvent(event)).toBe(true)
    const content: unknown = JSON.parse(event.content)
    expect(content).toEqual({
      name: 'MintRadar Alerts',
      about: expect.stringContaining('mintradar.org') as unknown,
      website: 'https://mintradar.org',
      picture: 'https://mintradar.org/icons/icon-512x512.png',
    })
  })
})

describe('notifySubscribers', () => {
  const MINT = 'https://mint.example.com'
  const CLAIMED_AT = new Date('2026-09-07T12:00:00.000Z')

  function claimedRow(pubkey: string, relays: string[] | null = ['wss://relay.example.com']) {
    return { pubkey, relays, claimed_at: CLAIMED_AT }
  }

  it('claims via a conditional UPDATE keyed on notify_on_down / last_notified_down_at for a down transition', async () => {
    const svc = await loadWithNsec(nip19.nsecEncode(generateSecretKey()))
    query.mockResolvedValueOnce({ rows: [] })

    await svc.notifySubscribers(MINT, 'down', new Date())

    const [sql, params] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/UPDATE notification_subscriptions/)
    expect(sql).toContain('notify_on_down = true')
    expect(sql).toContain('last_notified_down_at = now()')
    expect(sql).toMatch(/last_notified_down_at IS NULL OR last_notified_down_at < now\(\) - INTERVAL '60 minutes'/)
    expect(sql).toContain('RETURNING pubkey, relays, last_notified_down_at AS claimed_at')
    expect(params).toEqual([MINT])
  })

  it('uses the notify_on_up / last_notified_up_at columns for an up transition', async () => {
    const svc = await loadWithNsec(nip19.nsecEncode(generateSecretKey()))
    query.mockResolvedValueOnce({ rows: [] })

    await svc.notifySubscribers(MINT, 'up', new Date())

    const [sql] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('notify_on_up = true')
    expect(sql).toContain('last_notified_up_at = now()')
  })

  it('sends exactly one DM per claimed subscriber and issues no follow-up query on success', async () => {
    const svc = await loadWithNsec(nip19.nsecEncode(generateSecretKey()))
    const pubkey = getPublicKey(generateSecretKey())
    query.mockResolvedValueOnce({ rows: [claimedRow(pubkey)] })

    await svc.notifySubscribers(MINT, 'down', new Date())

    expect(publishMock).toHaveBeenCalledTimes(1)
    // Only the claiming UPDATE — no separate cooldown write, no release.
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('sends nothing when the claim matches no rows (cooldown still active / no subscribers)', async () => {
    const svc = await loadWithNsec(nip19.nsecEncode(generateSecretKey()))
    query.mockResolvedValueOnce({ rows: [] })

    await svc.notifySubscribers(MINT, 'down', new Date())

    expect(publishMock).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('RACE: two concurrent notifySubscribers for the same transition send only ONE DM', async () => {
    const svc = await loadWithNsec(nip19.nsecEncode(generateSecretKey()))
    const pubkey = getPublicKey(generateSecretKey())
    // The DB is the arbiter: the first conditional UPDATE claims the row; the
    // second's WHERE no longer matches (cooldown just set) → zero rows.
    query
      .mockResolvedValueOnce({ rows: [claimedRow(pubkey)] })
      .mockResolvedValueOnce({ rows: [] })

    await Promise.all([
      svc.notifySubscribers(MINT, 'down', new Date()),
      svc.notifySubscribers(MINT, 'down', new Date()),
    ])

    expect(publishMock).toHaveBeenCalledTimes(1)
  })

  it('down and up directions claim independent cooldown columns', async () => {
    const svc = await loadWithNsec(nip19.nsecEncode(generateSecretKey()))
    const pubkey = getPublicKey(generateSecretKey())

    query.mockResolvedValueOnce({ rows: [claimedRow(pubkey)] })
    await svc.notifySubscribers(MINT, 'down', new Date())
    expect(publishMock).toHaveBeenCalledTimes(1)

    // up transition — its own column, so it still claims even seconds later
    query.mockResolvedValueOnce({ rows: [claimedRow(pubkey)] })
    await svc.notifySubscribers(MINT, 'up', new Date())
    expect(publishMock).toHaveBeenCalledTimes(2)

    const upSql = query.mock.calls[1]![0] as string
    expect(upSql).toContain('last_notified_up_at')
  })

  it('unions the subscriber relays with the NOTIFICATION_RELAYS fallback set', async () => {
    const svc = await loadWithNsec(nip19.nsecEncode(generateSecretKey()))
    const pubkey = getPublicKey(generateSecretKey())
    query.mockResolvedValueOnce({ rows: [claimedRow(pubkey, ['wss://custom-relay.example.com'])] })

    await svc.notifySubscribers(MINT, 'down', new Date())

    const [relays] = publishMock.mock.calls[0] as [string[], NostrEvent]
    expect(relays).toContain('wss://custom-relay.example.com')
    expect(relays).toContain('wss://relay.damus.io')
  })

  it('RELEASES the claim (cooldown → NULL, guarded on the claimed timestamp) when every relay publish fails', async () => {
    publishMock.mockImplementation((relays: string[]) => relays.map(() => Promise.reject(new Error('fail'))))
    const svc = await loadWithNsec(nip19.nsecEncode(generateSecretKey()))
    const pubkey = getPublicKey(generateSecretKey())
    query
      .mockResolvedValueOnce({ rows: [claimedRow(pubkey)] })
      .mockResolvedValueOnce({ rowCount: 1 }) // the release

    await svc.notifySubscribers(MINT, 'down', new Date())

    expect(query).toHaveBeenCalledTimes(2)
    const [releaseSql, releaseParams] = query.mock.calls[1] as [string, unknown[]]
    expect(releaseSql).toContain('SET last_notified_down_at = NULL')
    expect(releaseSql).toContain('last_notified_down_at = $3')
    expect(releaseParams).toEqual([pubkey, MINT, CLAIMED_AT])
  })

  it('one subscriber failing (malformed relays) does not stop the rest, and releases only the failed one', async () => {
    const svc = await loadWithNsec(nip19.nsecEncode(generateSecretKey()))
    const badPubkey = getPublicKey(generateSecretKey())
    const goodPubkey = getPublicKey(generateSecretKey())
    query
      .mockResolvedValueOnce({ rows: [claimedRow(badPubkey, null), claimedRow(goodPubkey)] })
      .mockResolvedValueOnce({ rowCount: 1 }) // release for the bad one

    await svc.notifySubscribers(MINT, 'down', new Date())

    expect(publishMock).toHaveBeenCalledTimes(1) // the good subscriber still got theirs
    const [releaseSql, releaseParams] = query.mock.calls[1] as [string, unknown[]]
    expect(releaseSql).toContain('= NULL')
    expect(releaseParams).toEqual([badPubkey, MINT, CLAIMED_AT])
  })

  it('down message uses the plain hostname (no scheme) plus a URL-encoded MintRadar deep link', async () => {
    const recipientSecretKey = generateSecretKey()
    const pubkey = getPublicKey(recipientSecretKey)
    const svc = await loadWithNsec(nip19.nsecEncode(generateSecretKey()))
    query.mockResolvedValueOnce({ rows: [claimedRow(pubkey)] })

    await svc.notifySubscribers(MINT, 'down', new Date())

    const [, giftWrap] = publishMock.mock.calls[0] as [string[], NostrEvent]
    const rumor = nip17.unwrapEvent(giftWrap, recipientSecretKey)
    const expectedUrl = `https://mintradar.org/mint/${encodeURIComponent(MINT)}`
    expect(rumor.content).toBe(`⚠️ mint.example.com just went offline.\nView details: ${expectedUrl}`)
  })

  it('up message uses the plain hostname (no scheme) plus a URL-encoded MintRadar deep link', async () => {
    const recipientSecretKey = generateSecretKey()
    const pubkey = getPublicKey(recipientSecretKey)
    const svc = await loadWithNsec(nip19.nsecEncode(generateSecretKey()))
    query.mockResolvedValueOnce({ rows: [claimedRow(pubkey)] })

    await svc.notifySubscribers(MINT, 'up', new Date())

    const [, giftWrap] = publishMock.mock.calls[0] as [string[], NostrEvent]
    const rumor = nip17.unwrapEvent(giftWrap, recipientSecretKey)
    const expectedUrl = `https://mintradar.org/mint/${encodeURIComponent(MINT)}`
    expect(rumor.content).toBe(`✅ mint.example.com is back online.\nView details: ${expectedUrl}`)
  })

  it('never throws even if the claiming query rejects', async () => {
    const svc = await loadWithNsec(nip19.nsecEncode(generateSecretKey()))
    query.mockRejectedValueOnce(new Error('db down'))

    await expect(svc.notifySubscribers(MINT, 'down', new Date())).resolves.toBeUndefined()
  })
})
