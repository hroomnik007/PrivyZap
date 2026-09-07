import { useEffect, useRef } from 'react'
import { useAuthStore } from '@/stores/auth.store'
import { useWatchlistStore } from '@/stores/watchlist.store'
import { fetchRemoteWatchlist, publishWatchlist } from '@/core/nostr/watchlistSync'
import { useUserRelays } from '@/hooks/useUserRelays'
import { refreshAllSubscriptions } from '@/core/nostr/notificationSubscription'
import { db } from '@/db'

const WATCHLIST_OWNER_KEY = 'watchlistOwner'

export function useWatchlistSync() {
  const profile = useAuthStore(s => s.profile)
  const mints = useWatchlistStore(s => s.mints)
  const loadFromDb = useWatchlistStore(s => s.loadFromDb)
  const setSyncStatus = useWatchlistStore(s => s.setSyncStatus)
  const { read: userReadRelays, write: userWriteRelays } = useUserRelays()
  // Ref so Phase 1/2 always use the current relay list without re-triggering on relay changes.
  // Written in an effect (not during render) — this effect is declared first, so it runs
  // before Phase 1/2 effects within the same commit.
  const userWriteRelaysRef = useRef<string[] | null>(null)
  useEffect(() => {
    userWriteRelaysRef.current = userWriteRelays
  }, [userWriteRelays])
  // Same pattern, for the notification-subscription refresh below (needs
  // read relays — where the user's client actually listens for DMs).
  const userReadRelaysRef = useRef<string[] | null>(null)
  useEffect(() => {
    userReadRelaysRef.current = userReadRelays
  }, [userReadRelays])

  const syncedForPubkey = useRef<string | null>(null)
  const isSyncing = useRef(false)

  // Reset ALL sync state on logout so the next login triggers a fresh sync
  useEffect(() => {
    if (!profile?.pubkey) {
      console.log('sync: logout detected — resetting all sync state')
      syncedForPubkey.current = null
      isSyncing.current = false
      setSyncStatus('pending')
    }
  }, [profile?.pubkey, setSyncStatus])

  // Phase 1: on login, fetch remote → replace Dexie → load into store
  useEffect(() => {
    const pubkey = profile?.pubkey
    if (!pubkey || syncedForPubkey.current === pubkey) return

    // Set isSyncing IMMEDIATELY (synchronously) before any async work
    // so Phase 2 is blocked from the moment this effect fires
    isSyncing.current = true
    setSyncStatus('pending')
    console.log('sync: starting for pubkey', pubkey.slice(0, 8))

    const doSync = async () => {
      // M4 (2026-09-07 security audit): `pubkey` is captured when this effect
      // fired. Every await below yields the event loop, and the user can log out
      // and a DIFFERENT user log in on the same device before it resumes. Writing
      // user A's remote watchlist into Dexie / the store — or letting Phase 2
      // re-publish it — while user B is now the active identity leaks A's private
      // list and republishes it as B's own kind:10003. Re-check the live auth
      // identity after every await and discard the result untouched if it changed.
      const isStale = () => useAuthStore.getState().profile?.pubkey !== pubkey

      try {
        // Check if the Dexie data belongs to the current pubkey.
        // If a different user was previously logged in on this device, their Dexie
        // data must be cleared before loading — otherwise they'd see another user's mints.
        let dexieOwner: string | undefined
        try {
          const ownerEntry = await db.meta.get(WATCHLIST_OWNER_KEY)
          dexieOwner = ownerEntry?.value
        } catch { /* meta table not yet available on first run */ }

        if (isStale()) { console.warn('sync: pubkey changed mid-sync — aborting before any Dexie write'); return }

        if (dexieOwner !== pubkey) {
          console.log('sync: different owner in Dexie — clearing before load')
          await db.watchlist.clear()
        }

        console.log('sync: fetching kind:10003 from relays')
        const { urls: remote, failed: remoteFetchFailed } = await fetchRemoteWatchlist(pubkey, userWriteRelaysRef.current)

        if (isStale()) {
          console.warn('sync: pubkey changed during fetchRemoteWatchlist — discarding result, no write/publish')
          return
        }
        if (import.meta.env.DEV) { console.log(`sync: decrypted ${remote.length} mints`, remote) }

        if (remote.length > 0) {
          // Remote is authoritative for WHICH urls are watched, but notifyOnDown/
          // notifyOnUp (and addedAt) are local-only data never synced to Nostr —
          // preserve them for urls that already exist locally instead of resetting
          // to defaults on every successful sync. New urls (not previously in
          // Dexie) default to on/on, matching addMint()'s default.
          const existing = await db.watchlist.toArray()
          const existingByUrl = new Map(existing.map(e => [e.url, e]))
          await db.watchlist.clear()
          await Promise.all(
            remote.map(url => {
              const prior = existingByUrl.get(url)
              return db.watchlist.put({
                url,
                addedAt: prior?.addedAt ?? new Date(),
                notifyOnDown: prior?.notifyOnDown ?? true,
                notifyOnUp: prior?.notifyOnUp ?? true,
              })
            })
          )
          console.log('sync: written to Dexie')
        } else {
          console.log('sync: no remote data — using existing Dexie state for this pubkey')
        }

        // Record ownership so a different pubkey on next login clears Dexie
        await db.meta.put({ key: WATCHLIST_OWNER_KEY, value: pubkey })

        await loadFromDb()

        if (isStale()) { console.warn('sync: pubkey changed before commit — not marking synced / not publishing'); return }

        syncedForPubkey.current = pubkey
        setSyncStatus(remoteFetchFailed ? 'error' : 'done')
        console.log('sync: complete —', useWatchlistStore.getState().mints.length, 'mints in store')

        // Best-effort: refresh server-side notification_subscriptions rows
        // (resets their 30-day retention clock) for every entry with a
        // notify toggle on. Non-blocking — failures are logged and
        // swallowed inside refreshAllSubscriptions itself.
        void refreshAllSubscriptions(userReadRelaysRef.current)
      } catch (err) {
        if (isStale()) { console.warn('sync: error after pubkey change — ignoring', err); return }
        console.warn('sync: error during Phase 1:', err)
        // Mark complete even on error to avoid getting stuck; Phase 2 can resume
        syncedForPubkey.current = pubkey
        setSyncStatus('error')
      } finally {
        // Only release the sync guard if this run still owns the active identity.
        // A newer login for a different pubkey has already synchronously set its
        // own isSyncing=true in the Phase 1 effect and manages its own lifecycle;
        // clearing it here (this run started for the OLD pubkey) would let that
        // newer run's Phase 2 publish race an incomplete sync.
        if (useAuthStore.getState().profile?.pubkey === pubkey) {
          isSyncing.current = false
        }
      }
    }

    void doSync()
  }, [profile?.pubkey, loadFromDb, setSyncStatus])

  // Phase 2: publish current state to relays on any mint change,
  // but ONLY after sync has completed and is not currently running.
  // userWriteRelays is read from ref (not in deps) so NIP-65 relay list
  // resolving does not trigger an extra publish when mints haven't changed.
  useEffect(() => {
    const pubkey = profile?.pubkey
    if (!pubkey) return
    if (syncedForPubkey.current !== pubkey) return
    if (isSyncing.current) return
    if (import.meta.env.DEV) { console.log('sync: Phase 2 publishing', mints.length, 'mints to relays') }
    void publishWatchlist(pubkey, mints, userWriteRelaysRef.current)
  }, [mints, profile?.pubkey])
}
