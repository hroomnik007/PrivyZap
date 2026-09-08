import { test, expect } from '@playwright/test'
import { installApiMocks, mockRelays, MOCK_MINTS, MOCK_KNOWN_MINTS } from './fixtures/mocks'

type Route = import('@playwright/test').Route

// Step 1 of the sybil-inflatable Community Rating mitigation (2026-09-08 security
// audit run-2 follow-up): a caveat on every surface that shows the crowd rating —
// a strengthened Reviews-tab disclaimer plus an ⓘ tooltip on the rating tile
// (Mint Detail) and the ★ badge (mint card). Anyone can mint a fresh Nostr key,
// so the number is a directional signal, not proof.

const ALPHA = MOCK_MINTS[0]!.url
const detailPath = `/mint/${encodeURIComponent(ALPHA)}`
const CAVEAT_RE = /create a new key/i

type Page = import('@playwright/test').Page

async function setup(page: Page) {
  await mockRelays(page)
  await installApiMocks(page)
}

test.describe('Community Rating caveat — mint card ★ badge', () => {
  test('desktop: hovering the ⓘ in the rating pill reveals the caveat', async ({ page }) => {
    await setup(page)
    await page.goto('/')

    const ratingPill = page.locator('.mint-card', { hasText: 'Alpha Mint' })
      .locator('.card-pill', { hasText: '4.2 (12)' })
    await expect(ratingPill).toBeVisible()

    const info = ratingPill.locator('.card-rating-info')
    await expect(info).toBeVisible()
    await expect(page.getByRole('tooltip')).toHaveCount(0)

    await info.hover()
    await expect(page.getByRole('tooltip')).toContainText(CAVEAT_RE)
  })

  test.describe('mobile', () => {
    test.use({ viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true })

    test('tapping the ⓘ opens the caveat and does NOT navigate into the card', async ({ page }) => {
      await setup(page)
      await page.goto('/')

      const info = page.locator('.mint-card', { hasText: 'Alpha Mint' })
        .locator('.card-pill', { hasText: '4.2 (12)' })
        .locator('.card-rating-info')
      await expect(info).toBeVisible()

      await info.tap()
      await expect(page.getByRole('tooltip')).toContainText(CAVEAT_RE)
      // useTapTooltip.onClick calls stopPropagation → the card's navigate handler never fires.
      await expect(page).toHaveURL(/\/$/)
    })
  })
})

test.describe('Community Rating caveat — Mint Detail rating tile', () => {
  test('desktop: hovering the ⓘ next to "Community rating" reveals the caveat', async ({ page }) => {
    await setup(page)
    await page.goto(detailPath)

    const label = page.locator('.md-sc-label', { hasText: 'Community rating' })
    await expect(label).toBeVisible()

    const info = label.locator('.community-rating-info')
    await info.hover()
    await expect(page.getByRole('tooltip')).toContainText(/self-published Nostr reviews \(NIP-87\)/i)
  })

  test.describe('mobile', () => {
    test.use({ viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true })

    test('tapping the ⓘ opens the caveat', async ({ page }) => {
      await setup(page)
      await page.goto(detailPath)

      const info = page.locator('.md-sc-label', { hasText: 'Community rating' })
        .locator('.community-rating-info')
      await expect(info).toBeVisible()

      await info.tap()
      await expect(page.getByRole('tooltip')).toContainText(CAVEAT_RE)
    })
  })
})

test.describe('Community Rating — thin-sample de-emphasis (reviewCount < 3)', () => {
  test('a mint with 2 reviews shows a de-emphasised card badge', async ({ page }) => {
    await mockRelays(page)
    await installApiMocks(page)
    // Override: give Alpha only 2 reviews. Registered after installApiMocks so it wins.
    const thin = MOCK_KNOWN_MINTS.map(m =>
      m.url === ALPHA ? { ...m, reviewCount: 2, reviewAvgRating: 4.9 } : m,
    )
    await page.route('**/api/mints/known', route => route.fulfill({ json: thin }))
    await page.goto('/')

    const pill = page.locator('.mint-card', { hasText: 'Alpha Mint' })
      .locator('.card-pill', { hasText: '4.9 (2)' })
    await expect(pill).toBeVisible()
    // opacity is dropped to 0.6 for a thin sample.
    await expect(pill).toHaveCSS('opacity', '0.6')
  })

  test('Delta (exactly 3 reviews) is NOT de-emphasised', async ({ page }) => {
    await setup(page)
    await page.goto('/')
    const pill = page.locator('.mint-card', { hasText: 'Delta Mint' })
      .locator('.card-pill', { hasText: '4.8 (3)' })
    await expect(pill).toHaveCSS('opacity', '1')
  })
})

// ── "Recent review surge" flag (forgery-resistant sybil signal) ──────────────
// The backend computes `reviewSurge` from its own observed review_count vs a
// ~1-week-ago snapshot (backend/src/reviewSurge.ts, unit-tested there). These
// specs only check the quiet ⚠ badge appears iff the API says so.

const SURGE_RE = /grew unusually fast recently/i

async function setupWithSurge(page: Page) {
  await mockRelays(page)
  await installApiMocks(page)
  // Alpha: sudden jump → flagged. Delta: organic growth → not flagged.
  const withSurge = MOCK_KNOWN_MINTS.map(m => {
    if (m.url === MOCK_MINTS[0]!.url) return { ...m, reviewCount: 28, reviewAvgRating: 4.9, reviewSurge: true }
    return { ...m, reviewSurge: false }
  })
  await page.route('**/api/mints/known', (r: Route) => r.fulfill({ json: withSurge }))
}

test.describe('Recent review surge — mint card', () => {
  test('the ⚠ badge shows only for the flagged mint and its tooltip explains why', async ({ page }) => {
    await setupWithSurge(page)
    await page.goto('/')

    const alpha = page.locator('.mint-card', { hasText: 'Alpha Mint' })
    const delta = page.locator('.mint-card', { hasText: 'Delta Mint' })

    await expect(alpha.locator('.card-review-surge-flag')).toBeVisible()
    // Delta grew organically → no surge flag (but still has the normal rating caveat ⓘ).
    await expect(delta.locator('.card-review-surge-flag')).toHaveCount(0)
    await expect(delta.locator('.card-rating-info')).toBeVisible()

    await alpha.locator('.card-review-surge-flag').hover()
    await expect(page.getByRole('tooltip')).toContainText(SURGE_RE)
  })

  test.describe('mobile', () => {
    test.use({ viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true })

    test('tapping the ⚠ opens the explanation without navigating into the card', async ({ page }) => {
      await setupWithSurge(page)
      await page.goto('/')

      const flag = page.locator('.mint-card', { hasText: 'Alpha Mint' }).locator('.card-review-surge-flag')
      await expect(flag).toBeVisible()
      await flag.tap()
      await expect(page.getByRole('tooltip')).toContainText(SURGE_RE)
      await expect(page).toHaveURL(/\/$/)
    })
  })
})

test.describe('Recent review surge — Mint Detail rating tile', () => {
  test('desktop: the ⚠ sits next to "Community rating" only when flagged', async ({ page }) => {
    await setupWithSurge(page)
    await page.goto(detailPath)

    const label = page.locator('.md-sc-label', { hasText: 'Community rating' })
    await expect(label.locator('.review-surge-flag')).toBeVisible()
    await label.locator('.review-surge-flag').hover()
    await expect(page.getByRole('tooltip')).toContainText(SURGE_RE)
  })

  test('no ⚠ when the mint is not flagged', async ({ page }) => {
    await setup(page) // plain mocks — MOCK_KNOWN_MINTS all default reviewSurge:false
    await page.goto(detailPath)
    const label = page.locator('.md-sc-label', { hasText: 'Community rating' })
    await expect(label).toBeVisible()
    await expect(label.locator('.review-surge-flag')).toHaveCount(0)
  })

  test.describe('mobile', () => {
    test.use({ viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true })

    test('tapping the ⚠ opens the explanation', async ({ page }) => {
      await setupWithSurge(page)
      await page.goto(detailPath)
      const flag = page.locator('.md-sc-label', { hasText: 'Community rating' }).locator('.review-surge-flag')
      await expect(flag).toBeVisible()
      await flag.tap()
      await expect(page.getByRole('tooltip')).toContainText(SURGE_RE)
    })
  })
})
