import { test, expect } from '@playwright/test'
import { installApiMocks, mockRelays, MOCK_MINTS, MOCK_KNOWN_MINTS } from './fixtures/mocks'

type Page = import('@playwright/test').Page

// Alpha Mint's URL is swapped for a real TEST_MINT_URLS entry (see
// src/constants/testMints.ts) so isTestMint() fires and the 🧪 Test mint
// badge renders. Other fields are overridden per-scenario to exercise
// different combinations of the remaining badges.
const TEST_MINT_URL = 'https://testnut.cashu.space'

async function gotoWithAlphaAsTestMint(page: Page, overrides: Record<string, unknown>) {
  await mockRelays(page)
  await installApiMocks(page)
  const rows = MOCK_KNOWN_MINTS.map((m, i) => (i === 0 ? { ...m, url: TEST_MINT_URL, ...overrides } : m))
  await page.route('**/api/mints/known', route => route.fulfill({ json: rows }))
  await page.goto('/')
}

// The 🧪 Test mint badge lives in the card header slot (top-right, next to the
// online dot) — NOT in the lower chip row.
async function expectTestMintBadgeInHeader(page: Page) {
  const card = page.locator('.mint-card', { hasText: 'Alpha Mint' })
  await expect(card).toBeVisible()

  // In the header badge slot…
  const headerBadge = card.locator('.card-name-row .card-hdr-test-mint')
  await expect(headerBadge).toBeVisible()
  await expect(headerBadge).toContainText('Test mint')

  // …and NOT among the lower chip row.
  await expect(card.locator('.card-pills .card-pill', { hasText: 'Test mint' })).toHaveCount(0)
}

test.describe('MintCard — Test mint badge lives in the header slot', () => {
  test('with all other badges present (version, NUTs, unit, uptime, trust, rating)', async ({ page }) => {
    await gotoWithAlphaAsTestMint(page, {
      version: 'Nutshell/0.16.0',
      nutCount: 12,
      units: ['sat'],
      uptimePct24h: 99,
      trustScore: 92,
      reviewCount: 12,
      reviewAvgRating: 4.2,
    })
    await expectTestMintBadgeInHeader(page)
  })

  test('without Community Rating badge', async ({ page }) => {
    await gotoWithAlphaAsTestMint(page, {
      version: 'Nutshell/0.16.0',
      nutCount: 12,
      units: ['sat'],
      uptimePct24h: 99,
      trustScore: 92,
      reviewCount: 0,
      reviewAvgRating: null,
    })
    await expectTestMintBadgeInHeader(page)
  })

  test('with only version and NUT count badges', async ({ page }) => {
    await gotoWithAlphaAsTestMint(page, {
      version: 'Nutshell/0.16.0',
      nutCount: 12,
      units: null,
      uptimePct24h: null,
      trustScore: null,
      reviewCount: 0,
      reviewAvgRating: null,
    })
    await expectTestMintBadgeInHeader(page)
  })
})

test('New + Test mint sit side by side in the header slot when both apply', async ({ page }) => {
  await mockRelays(page)
  await installApiMocks(page)
  // Alpha: test-mint URL + freshly discovered → both header badges.
  const rows = MOCK_KNOWN_MINTS.map((m, i) =>
    i === 0 ? { ...m, url: TEST_MINT_URL, discoveredAt: new Date().toISOString() } : m,
  )
  await page.route('**/api/mints/known', route => route.fulfill({ json: rows }))
  await page.goto('/')

  const slot = page.locator('.mint-card', { hasText: 'Alpha Mint' }).locator('.card-name-row .card-hdr-badges')
  await expect(slot).toBeVisible()
  await expect(slot.locator('.card-hdr-new')).toHaveText('New')
  await expect(slot.locator('.card-hdr-test-mint')).toContainText('Test mint')
})

test('non-test mints never show the Test mint badge', async ({ page }) => {
  await mockRelays(page)
  await installApiMocks(page)
  await page.goto('/')
  const card = page.locator('.mint-card', { hasText: MOCK_MINTS[0]!.name })
  await expect(card.getByText('Test mint')).toHaveCount(0)
})
