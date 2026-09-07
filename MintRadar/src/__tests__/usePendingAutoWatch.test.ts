import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePendingAutoWatch } from '@/hooks/usePendingAutoWatch'

// L7 (2026-09-07 audit): an armed "watch this mint after login" intent must
// only ever add the mint it was armed for, only on a genuine logged-out →
// logged-in transition, and only within the TTL — never the wrong mint after a
// route-param change, never a stale mint after a much-later unrelated login.

let onAutoWatch: ReturnType<typeof vi.fn<(url: string) => void>>

function setup(initial: { url: string; isLoggedIn: boolean }) {
  onAutoWatch = vi.fn<(url: string) => void>()
  return renderHook(
    ({ url, isLoggedIn }: { url: string; isLoggedIn: boolean }) =>
      usePendingAutoWatch(url, isLoggedIn, onAutoWatch),
    { initialProps: initial },
  )
}

beforeEach(() => { vi.useRealTimers() })
afterEach(() => { vi.useRealTimers() })

describe('usePendingAutoWatch', () => {
  it('adds the mint on the logged-out → logged-in transition after arm()', () => {
    const { result, rerender } = setup({ url: 'https://a.mint', isLoggedIn: false })
    act(() => result.current.arm())
    rerender({ url: 'https://a.mint', isLoggedIn: true })
    expect(onAutoWatch).toHaveBeenCalledExactlyOnceWith('https://a.mint')
  })

  it('does nothing if the intent was never armed', () => {
    const { rerender } = setup({ url: 'https://a.mint', isLoggedIn: false })
    rerender({ url: 'https://a.mint', isLoggedIn: true })
    expect(onAutoWatch).not.toHaveBeenCalled()
  })

  it('does NOT add the wrong mint after a route-param change (arm on A, navigate to B, then log in)', () => {
    const { result, rerender } = setup({ url: 'https://a.mint', isLoggedIn: false })
    act(() => result.current.arm())          // armed for A
    rerender({ url: 'https://b.mint', isLoggedIn: false }) // navigated to B (still logged out)
    rerender({ url: 'https://b.mint', isLoggedIn: true })  // now log in
    expect(onAutoWatch).not.toHaveBeenCalled()
  })

  it('does NOT fire on a much-later unrelated login (intent past its TTL)', () => {
    vi.useFakeTimers()
    const { result, rerender } = setup({ url: 'https://a.mint', isLoggedIn: false })
    act(() => result.current.arm())
    vi.advanceTimersByTime(61_000) // > PENDING_TTL_MS
    rerender({ url: 'https://a.mint', isLoggedIn: true })
    expect(onAutoWatch).not.toHaveBeenCalled()
  })

  it('disarm() cancels a pending intent (explicit Cancel / Escape / overlay)', () => {
    const { result, rerender } = setup({ url: 'https://a.mint', isLoggedIn: false })
    act(() => result.current.arm())
    act(() => result.current.disarm())
    rerender({ url: 'https://a.mint', isLoggedIn: true })
    expect(onAutoWatch).not.toHaveBeenCalled()
  })

  it('does not re-fire on a later logout → login cycle (consumed exactly once)', () => {
    const { result, rerender } = setup({ url: 'https://a.mint', isLoggedIn: false })
    act(() => result.current.arm())
    rerender({ url: 'https://a.mint', isLoggedIn: true })   // fires
    rerender({ url: 'https://a.mint', isLoggedIn: false })  // log out
    rerender({ url: 'https://a.mint', isLoggedIn: true })   // log back in
    expect(onAutoWatch).toHaveBeenCalledTimes(1)
  })

  it('unmount drops the intent', () => {
    const { result, rerender, unmount } = setup({ url: 'https://a.mint', isLoggedIn: false })
    act(() => result.current.arm())
    unmount()
    // Re-mount and log in — nothing should carry over (fresh ref).
    const fresh = setup({ url: 'https://a.mint', isLoggedIn: false })
    fresh.rerender({ url: 'https://a.mint', isLoggedIn: true })
    expect(onAutoWatch).not.toHaveBeenCalled()
    void rerender
  })
})
