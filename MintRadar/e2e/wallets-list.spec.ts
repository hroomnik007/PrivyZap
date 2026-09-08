import { test, expect } from '@playwright/test'
import { installApiMocks, mockRelays } from './fixtures/mocks'

// The Wallets page is a plain list rendered from src/constants/wallets.ts.
// eNuts was removed (enuts.cash was down, so the card linked nowhere).
test('Wallets page lists wallets and no longer includes eNuts', async ({ page }) => {
  await mockRelays(page)
  await installApiMocks(page)
  await page.goto('/wallets')
  await page.waitForSelector('.wallet-card')

  await expect(page.getByText('eNuts', { exact: true })).toHaveCount(0)
  await expect(page.locator('.wallet-card', { hasText: 'Macadamia' })).toHaveCount(1)
  await expect(page.locator('.wallet-card', { hasText: 'Agicash' })).toHaveCount(1)
})

test('Nutshell lives in a "Run your own mint" subsection, not the main wallet grid', async ({ page }) => {
  await mockRelays(page)
  await installApiMocks(page)
  await page.goto('/wallets')
  await page.waitForSelector('.wallet-card')

  // Main grid: 8 consumer wallets, no Nutshell.
  const mainGrid = page.locator('.wallets-grid').first()
  await expect(mainGrid.locator('.wallet-card')).toHaveCount(8)
  await expect(mainGrid.locator('.wallet-card', { hasText: 'Nutshell' })).toHaveCount(0)

  // Self-host section below the grid carries Nutshell (same card style).
  const selfHost = page.locator('.wallets-selfhost')
  await expect(selfHost.getByText('Run your own mint')).toBeVisible()
  await expect(selfHost.locator('.wallet-card', { hasText: 'Nutshell' })).toHaveCount(1)
})

test('platform label is not duplicated (icon on the left, chips on the right only)', async ({ page }) => {
  await mockRelays(page)
  await installApiMocks(page)
  await page.goto('/wallets')
  await page.waitForSelector('.wallet-card')

  // The old standalone caps label next to the icon is gone.
  await expect(page.locator('.wallet-platform-label')).toHaveCount(0)

  // Minibits (Android only) shows "Android" exactly once on its card.
  const card = page.locator('.wallet-card', { hasText: 'Minibits' })
  const androidCount = await card.getByText('Android', { exact: true }).count()
  expect(androidCount).toBe(1)
  await expect(card.locator('.wallet-platform-tag', { hasText: 'Android' })).toHaveCount(1)
})
