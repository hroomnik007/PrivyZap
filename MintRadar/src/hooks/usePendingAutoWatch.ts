import { useCallback, useEffect, useRef } from 'react'

// How long a "watch this mint once I've logged in" intent stays valid. Long
// enough for the login flow (extension prompt / nsec paste / bunker round-trip),
// short enough that an abandoned intent can't fire on a much-later, unrelated
// login.
const PENDING_TTL_MS = 60_000

/**
 * Manages the "+ Watch while logged out → confirm → log in → auto-add" intent
 * for the mint detail page.
 *
 * The intent is PINNED to the mint URL it was armed for and timestamped, so
 * (2026-09-07 audit, L7):
 *   - a route-param change (React Router reuses the MintDetail component instance
 *     across `/mint/:url` changes) drops the intent — it belonged to the previous
 *     mint, and must not add the new one;
 *   - unmount drops it;
 *   - it only fires on a genuine logged-out → logged-in transition, for the SAME
 *     mint, within the TTL — never on a later unrelated login.
 *
 * `onAutoWatch` should be stable (wrap in useCallback).
 */
export function usePendingAutoWatch(
  url: string,
  isLoggedIn: boolean,
  onAutoWatch: (url: string) => void,
): { arm: () => void; disarm: () => void } {
  const pendingRef = useRef<{ url: string; at: number } | null>(null)
  const wasLoggedInRef = useRef(isLoggedIn)

  useEffect(() => {
    const pending = pendingRef.current
    if (
      !wasLoggedInRef.current && isLoggedIn &&
      pending && pending.url === url && Date.now() - pending.at < PENDING_TTL_MS
    ) {
      pendingRef.current = null
      onAutoWatch(url)
    }
    wasLoggedInRef.current = isLoggedIn
  }, [isLoggedIn, url, onAutoWatch])

  // Route/mint change (a) + unmount (b): drop an intent tied to a mint we've
  // navigated away from.
  useEffect(() => () => { pendingRef.current = null }, [url])

  const arm = useCallback(() => {
    pendingRef.current = { url, at: Date.now() }
  }, [url])

  // Explicit Cancel / Escape / overlay / × (c).
  const disarm = useCallback(() => {
    pendingRef.current = null
  }, [])

  return { arm, disarm }
}
