import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────
// client.ts drags in nip46 / SimplePool / @noble and the (circular) auth store.
// Stub everything except the pieces bootstrapUserData / subscribeFirstEvent
// actually exercise: verifyEvent, sharedPool.subscribeMany, useAuthStore.getState.

interface RelayHandlers {
  onevent: (ev: unknown) => void
  oneose: () => void
  onclose: () => void
}
let capturedHandlers: RelayHandlers | null = null
const { subscribeMany } = vi.hoisted(() => ({ subscribeMany: vi.fn() }))

vi.mock('nostr-tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('nostr-tools')>()
  return { ...real, verifyEvent: vi.fn(() => true) }
})
vi.mock('nostr-tools/nip46', () => ({
  BunkerSigner: class {},
  parseBunkerInput: vi.fn(),
  createNostrConnectURI: vi.fn(),
  toBunkerURL: vi.fn(),
}))
vi.mock('nostr-tools/pool', () => ({ SimplePool: class {} }))
vi.mock('@noble/secp256k1', () => ({ getPublicKey: vi.fn() }))
vi.mock('@noble/hashes/utils.js', () => ({ bytesToHex: vi.fn(), hexToBytes: vi.fn() }))
vi.mock('@/core/nostr/pool', () => ({ sharedPool: { subscribeMany } }))
vi.mock('@/stores/auth.store', () => ({ useAuthStore: { getState: vi.fn() } }))

import { bootstrapUserData, fetchNostrProfile } from '@/core/nostr/client'
import { useAuthStore } from '@/stores/auth.store'

const PK = 'a'.repeat(64)
const OTHER_PK = 'b'.repeat(64)

const updateProfileMeta = vi.fn()
const setNip65Relays = vi.fn()

function baseEvent(over: Record<string, unknown>) {
  return { id: 'x'.repeat(64), created_at: 1_700_000_000, tags: [] as string[][], sig: '0'.repeat(128), content: '', ...over }
}

beforeEach(() => {
  capturedHandlers = null
  subscribeMany.mockReset()
  subscribeMany.mockImplementation((_relays: string[], _filter: unknown, handlers: RelayHandlers) => {
    capturedHandlers = handlers
    return { close: vi.fn() }
  })
  updateProfileMeta.mockClear()
  setNip65Relays.mockClear()
  ;(useAuthStore.getState as Mock).mockReturnValue({
    profile: { pubkey: PK },
    nip65Relays: null,
    updateProfileMeta,
    setNip65Relays,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('bootstrapUserData — pubkey binding (audit finding M6)', () => {
  it('drops a kind:0 profile event signed by a DIFFERENT pubkey', () => {
    const dispose = bootstrapUserData(PK)
    capturedHandlers!.onevent(baseEvent({
      kind: 0, pubkey: OTHER_PK,
      content: JSON.stringify({ name: 'MintRadar Official ✓', picture: 'https://track.evil/x.png' }),
    }))
    expect(updateProfileMeta).not.toHaveBeenCalled()
    dispose()
  })

  it('applies a kind:0 profile event signed by the user', () => {
    const dispose = bootstrapUserData(PK)
    capturedHandlers!.onevent(baseEvent({
      kind: 0, pubkey: PK,
      content: JSON.stringify({ name: 'Real Name', picture: 'https://real.example/p.png' }),
    }))
    expect(updateProfileMeta).toHaveBeenCalledWith(PK, { name: 'Real Name', picture: 'https://real.example/p.png' })
    dispose()
  })

  it('drops a kind:10002 NIP-65 relay list signed by a DIFFERENT pubkey', () => {
    const dispose = bootstrapUserData(PK)
    capturedHandlers!.onevent(baseEvent({
      kind: 10002, pubkey: OTHER_PK,
      tags: [['r', 'wss://relay.attacker.example']],
    }))
    expect(setNip65Relays).not.toHaveBeenCalled()
    dispose()
  })

  it('applies a kind:10002 NIP-65 relay list signed by the user', () => {
    const dispose = bootstrapUserData(PK)
    capturedHandlers!.onevent(baseEvent({
      kind: 10002, pubkey: PK,
      tags: [['r', 'wss://relay.user.example']],
    }))
    expect(setNip65Relays).toHaveBeenCalledWith({
      read: ['wss://relay.user.example'],
      write: ['wss://relay.user.example'],
    })
    dispose()
  })

  it('a forged event does not consume the slot — the real event that follows still applies', () => {
    const dispose = bootstrapUserData(PK)
    capturedHandlers!.onevent(baseEvent({ kind: 0, pubkey: OTHER_PK, content: JSON.stringify({ name: 'Evil' }) }))
    capturedHandlers!.onevent(baseEvent({ kind: 0, pubkey: PK, content: JSON.stringify({ name: 'Real' }) }))
    expect(updateProfileMeta).toHaveBeenCalledTimes(1)
    expect(updateProfileMeta).toHaveBeenCalledWith(PK, { name: 'Real' })
    dispose()
  })
})

describe('subscribeFirstEvent (via fetchNostrProfile) — pubkey binding (audit finding M6)', () => {
  it('ignores an event from the wrong pubkey and resolves empty on timeout', async () => {
    vi.useFakeTimers()
    const promise = fetchNostrProfile(PK)
    capturedHandlers!.onevent(baseEvent({ kind: 0, pubkey: OTHER_PK, content: JSON.stringify({ name: 'Evil', picture: 'https://evil/p' }) }))
    await vi.advanceTimersByTimeAsync(6100) // past USER_BOOTSTRAP_TIMEOUT_MS
    await expect(promise).resolves.toEqual({})
  })

  it('resolves with the profile when the pubkey matches', async () => {
    const promise = fetchNostrProfile(PK)
    capturedHandlers!.onevent(baseEvent({ kind: 0, pubkey: PK, content: JSON.stringify({ name: 'Real', picture: 'https://real/p' }) }))
    await expect(promise).resolves.toEqual({ name: 'Real', picture: 'https://real/p' })
  })
})
