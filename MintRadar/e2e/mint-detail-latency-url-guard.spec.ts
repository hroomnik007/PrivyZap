import { test, expect } from '@playwright/test'
import { installApiMocks, mockRelays } from './fixtures/mocks'

// L6 (2026-09-07 audit): MintDetail's "Show my latency" button fetched the
// /mint/:url route param straight from the visitor's browser. A crafted link
// (/mint/<encoded non-mint URL>) turned one click into a browser-side beacon to
// an attacker host. The button now validates https:// scheme + length first.

test.beforeEach(async ({ page }) => {
  await mockRelays(page)
  await installApiMocks(page)
})

test('"Show my latency" refuses a non-https route-param URL and makes no request to the host', async ({ page }) => {
  const evilHits: string[] = []
  // Match by hostname (not a substring glob — the SPA URL itself contains the
  // encoded string in its path). Records + blocks any real request to the host.
  await page.route(u => {
    try { return new URL(u).hostname === 'evil.example' } catch { return false }
  }, route => {
    evilHits.push(route.request().url())
    return route.abort()
  })

  await page.goto(`/mint/${encodeURIComponent('http://evil.example/track')}`)
  await expect(page.locator('.md-tabs')).toBeVisible()

  await page.locator('.latency-test-btn').click()

  await expect(page.getByText('Invalid mint URL')).toBeVisible()
  expect(evilHits).toEqual([]) // the browser never reached out to the attacker host
})

test('"Show my latency" still works for a normal https mint URL', async ({ page }) => {
  // installApiMocks stubs **/v1/info → 200, so the client fetch resolves fast.
  await page.goto(`/mint/${encodeURIComponent('https://alpha.mint.example')}`)
  await expect(page.locator('.md-tabs')).toBeVisible()

  await page.locator('.latency-test-btn').click()

  await expect(page.getByText(/Your latency: \d+ms|Unreachable/)).toBeVisible({ timeout: 6000 })
  await expect(page.getByText('Invalid mint URL')).toHaveCount(0)
})
