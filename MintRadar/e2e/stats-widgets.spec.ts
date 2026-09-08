import { test, expect } from '@playwright/test'
import { installApiMocks, mockRelays, MOCK_KNOWN_MINTS } from './fixtures/mocks'

type Json = Record<string, unknown>

async function knownMints(page: import('@playwright/test').Page, rows: Json[]) {
  await page.route('**/api/mints/known', r => r.fulfill({ json: rows }))
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1600 })
  await mockRelays(page)
  await installApiMocks(page)
})

test('Most Reliable list excludes test mints; Trust tab is untouched', async ({ page }) => {
  const base = MOCK_KNOWN_MINTS[0]!
  const rows: Json[] = [
    { ...base, url: 'https://testnut.cashu.space', name: 'Testnut', online: true, uptimePct24h: 100, trustScore: 99 },
    { ...MOCK_KNOWN_MINTS[1], online: true, uptimePct24h: 97, trustScore: 70 },
    { ...MOCK_KNOWN_MINTS[3], online: true, uptimePct24h: 95, trustScore: 78 },
  ]
  await knownMints(page, rows)
  await page.goto('/stats')

  // The Reliable/Trust widget (its title changes with the tab, so locate it by
  // the toggle instead).
  const widget = page.locator('.stats-panel').filter({ has: page.getByRole('button', { name: 'Reliable', exact: true }) })
  await expect(widget.locator('.stats-top5-row').first()).toBeVisible()
  // Reliable tab: the 100%-uptime test mint is filtered out.
  await expect(widget.locator('.stats-top5-row', { hasText: 'Testnut' })).toHaveCount(0)

  // Trust tab still shows it (with the 🧪 Test badge) — unchanged behaviour.
  await widget.getByRole('button', { name: 'Trust', exact: true }).click()
  await expect(widget.locator('.stats-top5-row', { hasText: 'Testnut' })).toHaveCount(1)
})

test('Most Reliable / Movers rows omit the hostname subtitle when it equals the name', async ({ page }) => {
  const base = MOCK_KNOWN_MINTS[0]!
  await knownMints(page, [
    { ...base, url: 'https://plainmint.example', name: 'plainmint.example', online: true, uptimePct24h: 98, trustScore: 80 },
  ])
  await page.goto('/stats')

  const row = page.locator('.stats-panel').filter({ has: page.getByRole('button', { name: 'Reliable', exact: true }) }).locator('.stats-top5-row').first()
  await expect(row).toBeVisible()
  const text = (await row.textContent()) ?? ''
  // "plainmint.example" appears once (the name), not twice (name + subtitle).
  expect(text.match(/plainmint\.example/g)?.length).toBe(1)
})

test('Geographic Distribution buckets CDN / cloud / anycast labels into one row', async ({ page }) => {
  const base = MOCK_KNOWN_MINTS[0]!
  await knownMints(page, [
    { ...base, url: 'https://a.example', name: 'A', online: true, serverLocation: 'Cloudflare CDN' },
    { ...base, url: 'https://b.example', name: 'B', online: true, serverLocation: 'AWS us-east-1' },
    { ...base, url: 'https://c.example', name: 'C', online: true, serverLocation: 'anycast' },
    { ...base, url: 'https://d.example', name: 'D', online: true, serverLocation: 'Frankfurt, DE' },
    { ...base, url: 'https://e.example', name: 'E', online: true, serverLocation: 'Frankfurt, DE' },
  ])
  await page.goto('/stats')

  const geo = page.locator('.stats-panel', { hasText: 'Geographic Distribution' })
  const cdnRow = geo.locator('.dist-row', { hasText: 'CDN / anycast' })
  await expect(cdnRow).toHaveCount(1)
  await expect(cdnRow.locator('.dist-count')).toHaveText('3')
  await expect(geo.locator('.dist-row', { hasText: 'Cloudflare' })).toHaveCount(0)
})

test('Software panel: "Behind current release" + explanatory (i)', async ({ page }) => {
  await knownMints(page, [
    { ...MOCK_KNOWN_MINTS[0], online: true, version: 'Nutshell/0.14.0' },
    { ...MOCK_KNOWN_MINTS[1], online: true, version: 'Nutshell/0.16.0' },
  ])
  await page.goto('/stats')

  const sw = page.locator('.stats-sw-panel')
  await expect(sw.getByText('Behind current release')).toBeVisible()
  await expect(sw.getByText('Running outdated or older versions')).toHaveCount(0)

  await sw.locator('.stats-sw-behind-info').hover()
  await expect(page.locator('.audit-tooltip', { hasText: /latest known release/i })).toBeVisible()
})
