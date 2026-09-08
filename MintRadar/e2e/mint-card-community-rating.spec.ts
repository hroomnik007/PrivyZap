import { test, expect } from '@playwright/test'
import { installApiMocks, mockRelays, loginAs } from './fixtures/mocks'

// Mock review rollup (see e2e/fixtures/mocks.ts):
//   Alpha   → 12 reviews @ 4.2   Bravo   → 0 reviews (no badge)
//   Charlie → 4 reviews @ 3.0    Delta   → 3 reviews @ 4.8
// Charlie is offline: it has no Trust Score badge but still shows a
// Community Rating badge.

test.describe('MintCard — Community Rating badge', () => {
  test.beforeEach(async ({ page }) => {
    await mockRelays(page)
    await installApiMocks(page)
  })

  const card = (page: import('@playwright/test').Page, name: string) =>
    page.locator('.mint-card', { hasText: name })

  test('Community Rating badge shows only when the mint has reviews', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.mint-card')).toHaveCount(4)

    await expect(card(page, 'Alpha Mint').locator('.card-pill', { hasText: '4.2 (12)' })).toBeVisible()
    await expect(card(page, 'Delta Mint').locator('.card-pill', { hasText: '4.8 (3)' })).toBeVisible()
    // Offline mint — Trust Score badge absent, Community Rating badge still shown.
    await expect(card(page, 'Charlie Mint').locator('.card-pill', { hasText: '3.0 (4)' })).toBeVisible()
    // 0 reviews → no badge at all.
    await expect(card(page, 'Bravo Mint').locator('.card-pill', { hasText: /\(\d+\)/ })).toHaveCount(0)
  })

  test('Trust Score badge uses a shield icon, not a star', async ({ page }) => {
    await page.goto('/')
    const trustPill = card(page, 'Alpha Mint').locator('.card-pill', { hasText: 'Trust 92' })
    await expect(trustPill).toBeVisible()
    await expect(trustPill.locator('svg')).toHaveCount(1)
    await expect(trustPill).not.toContainText('★')
    await expect(trustPill).not.toContainText('%')
  })

  test('badge is shared with the Watchlist card', async ({ page }) => {
    await loginAs(page)
    await page.goto('/')
    await card(page, 'Alpha Mint').getByRole('button', { name: 'Watch', exact: true }).click()
    await page.getByRole('link', { name: 'Watchlist' }).click()

    await expect(page.locator('.wl-grid .mint-card')).toHaveCount(1)
    await expect(
      page.locator('.wl-grid .mint-card').locator('.card-pill', { hasText: '4.2 (12)' })
    ).toBeVisible()
  })
})
