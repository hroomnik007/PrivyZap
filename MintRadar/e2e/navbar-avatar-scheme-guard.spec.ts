import { test, expect } from '@playwright/test'
import { nip19 } from 'nostr-tools'
import { installApiMocks, mockRelays, TEST_PUBKEY_HEX } from './fixtures/mocks'

// Hardening (2026-09-07 audit): the navbar avatar rendered profile.picture as
// <img src> with only an `!== undefined` check — inconsistent with the two
// other profile.picture call sites which require https://. Self-only risk, but
// keep it consistent.

async function loginWithPicture(page: import('@playwright/test').Page, picture: string) {
  const npub = nip19.npubEncode(TEST_PUBKEY_HEX)
  await page.addInitScript(({ pubkey, npub, picture }) => {
    ;(window as unknown as { nostr: unknown }).nostr = {
      getPublicKey: async () => pubkey,
      signEvent: async (e: Record<string, unknown>) => ({ ...e, id: 'f'.repeat(64), pubkey, sig: '0'.repeat(128) }),
      nip04: { encrypt: async (_p: string, t: string) => t, decrypt: async (_p: string, t: string) => t },
      nip44: { encrypt: async (_p: string, t: string) => t, decrypt: async (_p: string, t: string) => t },
    }
    sessionStorage.setItem('mintradar_session', JSON.stringify({
      state: { profile: { pubkey, npub, name: 'Pic User', picture }, method: 'nip07' },
      version: 0,
    }))
  }, { pubkey: TEST_PUBKEY_HEX, npub, picture })
}

test.beforeEach(async ({ page }) => {
  await mockRelays(page)
  await installApiMocks(page)
})

test('navbar renders a real <img> avatar for an https:// picture', async ({ page }) => {
  await loginWithPicture(page, 'https://example.com/me.png')
  await page.goto('/')
  await page.waitForSelector('.navbar-profile')
  await expect(page.locator('.navbar-profile img.navbar-avatar')).toHaveCount(1)
})

test('navbar falls back to the placeholder for a non-https (javascript:) picture', async ({ page }) => {
  await loginWithPicture(page, 'javascript:alert(document.domain)')
  await page.goto('/')
  await page.waitForSelector('.navbar-profile')
  await expect(page.locator('.navbar-profile img')).toHaveCount(0)
  await expect(page.locator('.navbar-avatar--placeholder')).toBeVisible()
})
