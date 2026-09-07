import { test, expect } from '@playwright/test'
import { installApiMocks, mockRelays, MOCK_KNOWN_MINTS } from './fixtures/mocks'

// Audit finding (2026-09-07): a mint-controlled icon_url was rendered as
// <img src={iconUrl}> directly, letting a hostile operator harvest every
// viewer's IP / User-Agent. The favicon now always loads via the backend's
// SSRF-guarded proxy (/api/mint/icon?url=<mint url>).

// 1x1 transparent PNG
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test.beforeEach(async ({ page }) => {
  await mockRelays(page)
  await installApiMocks(page)
  // Give one mint an icon (fixture default is iconUrl: null) — a deliberately
  // hostile-looking icon_url that must never actually be requested. Registered
  // AFTER installApiMocks so this handler wins.
  const withIcon = MOCK_KNOWN_MINTS.map(m =>
    m.url === 'https://alpha.mint.example'
      ? { ...m, iconUrl: 'https://tracker.evil.example/beacon.png?u=victim' }
      : m,
  )
  await page.route('**/api/mints/known', route => route.fulfill({ json: withIcon }))
})

test('mint favicons load through /api/mint/icon, never from the mint-supplied host', async ({ page }) => {
  const beaconHits: string[] = []
  await page.route('**tracker.evil.example**', route => {
    beaconHits.push(route.request().url())
    return route.abort()
  })

  let proxyRequestedUrl: string | null = null
  await page.route('**/api/mint/icon**', route => {
    proxyRequestedUrl = new URL(route.request().url()).searchParams.get('url')
    return route.fulfill({ contentType: 'image/png', body: PNG_1PX })
  })

  await page.goto('/')
  const alphaCard = page.locator('.mint-card', {
    has: page.locator('.card-name', { hasText: 'Alpha Mint' }),
  })
  const favicon = alphaCard.locator('img').first()
  await expect(favicon).toHaveAttribute('src', '/api/mint/icon?url=https%3A%2F%2Falpha.mint.example')
  await expect(favicon).toBeVisible()

  // The proxy was asked for the MINT url, and the attacker host was never hit.
  expect(proxyRequestedUrl).toBe('https://alpha.mint.example')
  expect(beaconHits).toEqual([])
})

test('falls back to the placeholder icon when the proxy has nothing to serve (404)', async ({ page }) => {
  await page.route('**/api/mint/icon**', route => route.fulfill({ status: 404, body: '' }))

  await page.goto('/')
  const alphaCard = page.locator('.mint-card', {
    has: page.locator('.card-name', { hasText: 'Alpha Mint' }),
  })
  // onError swaps the <img> out for the SVG placeholder.
  await expect(alphaCard.locator('img')).toHaveCount(0)
  await expect(alphaCard.locator('svg[aria-label*="mint icon placeholder"]')).toBeVisible()
})
