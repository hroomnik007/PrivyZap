import { test, expect } from '@playwright/test'
import { installApiMocks, mockRelays, MOCK_MINTS } from './fixtures/mocks'

const ALPHA = MOCK_MINTS[0]!.url // https://alpha.mint.example
const detailPath = `/mint/${encodeURIComponent(ALPHA)}`

test.beforeEach(async ({ page }) => {
  await mockRelays(page)
  await installApiMocks(page)
  await page.goto(detailPath)
  await expect(page.locator('.md-tabs')).toBeVisible()
})

test.describe('Mint Detail', () => {
  test('shows the mint summary (latency, uptime, version, NUTs)', async ({ page }) => {
    // Header name from the probe info.
    await expect(page.getByText('Alpha Mint').first()).toBeVisible()

    const summary = page.locator('.md-summary')
    await expect(summary).toContainText('50 ms')            // latency from known-mints
    await expect(summary).toContainText('99%')              // uptime 24h from history
    await expect(summary).toContainText('Nutshell/0.16.0')  // version
    // NUTs count = number of keys in the probe info.nuts (12 for Alpha).
    await expect(summary.locator('.md-sc-value.green')).toHaveText('12')
  })

  test('tab navigation switches panels', async ({ page }) => {
    const tab = (name: string) => page.locator('.md-tab', { hasText: name })

    // Overview is active by default.
    await expect(tab('Overview')).toHaveClass(/active/)

    await tab('History').click()
    await expect(tab('History')).toHaveClass(/active/)

    await tab('NUTs').click()
    await expect(tab('NUTs')).toHaveClass(/active/)

    await tab('Audit').click()
    await expect(tab('Audit')).toHaveClass(/active/)

    await tab('Reviews').click()
    await expect(tab('Reviews')).toHaveClass(/active/)
  })

  test('reviews tab shows an empty state when there are no reviews', async ({ page }) => {
    await page.locator('.md-tab', { hasText: 'Reviews' }).click()
    // Relays are stubbed empty and /api/mints/nostr-reviews returns [] → empty state.
    await expect(page.getByText('No Nostr reviews found for this mint yet.')).toBeVisible({ timeout: 15_000 })
    // The disclaimer is shown even with zero reviews (it sits above the loading/empty branch).
    await expect(page.locator('.reviews-disclaimer')).toContainText(
      /self-published Nostr events \(NIP-87\).*artificially inflated.*directional signal, not proof/i
    )
    // No filter chips when there is nothing to filter.
    await expect(page.locator('.reviews-filter-chip')).toHaveCount(0)
  })

  test('Trust Score details modal opens', async ({ page }) => {
    await page.getByRole('button', { name: /Details/ }).click()
    await expect(page.getByText('Trust Score Breakdown')).toBeVisible()
  })

  for (const viewport of [
    { label: 'desktop', size: { width: 1280, height: 900 } },
    { label: 'mobile', size: { width: 390, height: 844 } },
  ]) {
    test(`clicking the mint URL copies the deep link and shows feedback (${viewport.label})`, async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      await page.setViewportSize(viewport.size)

      const urlBtn = page.locator('button.md-url-copy')
      await expect(urlBtn).toBeVisible()
      await expect(urlBtn).toContainText(ALPHA)
      await expect(urlBtn).not.toHaveClass(/copied/)

      await urlBtn.click()

      // Visual feedback: .copied class + checkmark icon flip for ~2s.
      await expect(urlBtn).toHaveClass(/copied/)

      // Clipboard holds the current mint deep link (window.location.href).
      const clip = await page.evaluate(() => navigator.clipboard.readText())
      expect(clip).toContain(encodeURIComponent(ALPHA))
      expect(clip).toBe(page.url())

      // Feedback reverts.
      await expect(urlBtn).not.toHaveClass(/copied/, { timeout: 4000 })
    })
  }
})
