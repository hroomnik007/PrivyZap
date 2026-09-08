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

test.describe('Mint Detail — /mint/:url canonicalisation (bare-host collision fix)', () => {
  test.beforeEach(async ({ page }) => {
    await mockRelays(page)
    await installApiMocks(page)
  })

  test('a bare host redirects to the tracked mint (not a hollow stub)', async ({ page }) => {
    await page.goto('/mint/alpha.mint.example')
    // Ends on the canonical encoded URL the rest of the app links to…
    await expect(page).toHaveURL(u => u.pathname === `/mint/${encodeURIComponent(ALPHA)}`)
    // …showing the real tracked mint: full detail, online, real stats.
    await expect(page.locator('.md-tabs')).toBeVisible()
    await expect(page.getByText('Alpha Mint').first()).toBeVisible()
    await expect(page.locator('.md-status-inline')).toContainText('Online')
    await expect(page.locator('.md-summary').locator('.md-sc-value.green')).toHaveText('12')
    await expect(page.locator('.md-not-tracked')).toHaveCount(0)
  })

  test('the canonical encoded URL still works directly', async ({ page }) => {
    await page.goto(`/mint/${encodeURIComponent(ALPHA)}`)
    await expect(page.locator('.md-tabs')).toBeVisible()
    await expect(page.getByText('Alpha Mint').first()).toBeVisible()
  })

  test('two different hosts stay two different pages', async ({ page }) => {
    await page.goto('/mint/alpha.mint.example')
    await expect(page.getByText('Alpha Mint').first()).toBeVisible()
    const alphaUrl = page.url()

    await page.goto('/mint/bravo.mint.example')
    await expect(page.getByText('Bravo Mint').first()).toBeVisible()
    expect(page.url()).not.toBe(alphaUrl)
  })

  test('an unknown host shows the "Not a tracked mint" state, not a 3% ghost', async ({ page }) => {
    await page.goto('/mint/definitely-not-a-real-mint.example')
    await expect(page.locator('.md-not-tracked')).toBeVisible()
    await expect(page.getByText('Not a tracked mint')).toBeVisible()
    // No fake full detail: no tabs, no Trust gauge/score.
    await expect(page.locator('.md-tabs')).toHaveCount(0)
    await expect(page.locator('.md-sc-trust-num')).toHaveCount(0)
    await expect(page.locator('.gauge-num')).toHaveCount(0)
  })
})
