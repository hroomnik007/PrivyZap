import { test, expect } from '@playwright/test'
import { installApiMocks, mockRelays, MOCK_KNOWN_MINTS } from './fixtures/mocks'

type Page = import('@playwright/test').Page

const card = (page: Page, name: string) => page.locator('.mint-card', { hasText: name })

// Fixture discoveredAt: Alpha 400d, Bravo 10d, Charlie 120d, Delta 200d.
test.describe('MintCard — copy & reduced badge set', () => {
  test.beforeEach(async ({ page }) => {
    await mockRelays(page)
    await installApiMocks(page)
  })

  test('"New" badge shows only for a mint discovered < 30 days ago', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.mint-card')).toHaveCount(4)
    await expect(card(page, 'Bravo Mint').getByText('New', { exact: true })).toBeVisible()
    await expect(card(page, 'Alpha Mint').getByText('New', { exact: true })).toHaveCount(0)
    await expect(card(page, 'Delta Mint').getByText('New', { exact: true })).toHaveCount(0)
  })

  test('Established / Veteran / OG badges are gone from cards', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.mint-card')).toHaveCount(4)
    for (const label of ['Established', 'Veteran', 'OG']) {
      await expect(page.locator('.mint-card').getByText(label, { exact: true })).toHaveCount(0)
    }
  })

  test('Trust badge is always "Trust <n>" — word + number, never a bare %', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, 'Alpha Mint').locator('.card-pill', { hasText: 'Trust 92' })).toBeVisible()
    // Offline mint with a null score still shows the badge, as "Trust n/a".
    await expect(card(page, 'Charlie Mint').locator('.card-pill', { hasText: 'Trust n/a' })).toBeVisible()
  })

  test('uptime chip reads "<n>% up 24h"', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, 'Alpha Mint').locator('.card-pill', { hasText: '99% up 24h' })).toBeVisible()
  })

  test('latency row is never blank — sampled / timeout / n/a', async ({ page }) => {
    const rows = MOCK_KNOWN_MINTS.map(m => {
      if (m.name === 'Bravo Mint') return { ...m, online: false, latencyMs: null, lastError: 'Connection timeout' }
      if (m.name === 'Charlie Mint') return { ...m, online: false, latencyMs: null, lastError: null }
      return m
    })
    await page.route('**/api/mints/known', route => route.fulfill({ json: rows }))
    await page.goto('/')
    await expect(page.locator('.mint-card')).toHaveCount(4)

    await expect(card(page, 'Alpha Mint').locator('.latency-value')).toHaveText('50ms')
    await expect(card(page, 'Bravo Mint').locator('.latency-value')).toHaveText('timeout')
    await expect(card(page, 'Charlie Mint').locator('.latency-value')).toHaveText('n/a')
  })

  test('dashboard tiles carry the new labels + subtitles', async ({ page }) => {
    await page.goto('/')
    const bar = page.locator('.stats-bar')
    await expect(bar.getByText('Online Mints')).toBeVisible()
    await expect(bar.getByText('of 4 listed')).toBeVisible()          // 4 non-degraded mock mints
    await expect(bar.getByText('All Known')).toBeVisible()
    await expect(bar.getByText('incl. offline')).toBeVisible()
    await expect(bar.getByText('from Frankfurt')).toBeVisible()

    // Tapping a count tile reveals the Listed/Known explainer.
    await expect(page.locator('.stat-count-note')).toHaveCount(0)
    await bar.getByText('All Known').click()
    await expect(page.locator('.stat-count-note')).toContainText(/Listed.*in the grid.*Known.*every mint we indexed/s)
  })

  test('grid carries the Trust-vs-Stars explainer sentence once, above the cards', async ({ page }) => {
    await page.goto('/')
    const explainer = page.locator('.grid-score-explainer')
    await expect(explainer).toHaveCount(1)
    await expect(explainer).toContainText(
      /Trust is our operational score.*Stars are community reviews — read both/,
    )
  })
})
