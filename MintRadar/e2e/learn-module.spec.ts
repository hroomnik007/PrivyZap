import { test, expect } from '@playwright/test'
import { installApiMocks, mockRelays } from './fixtures/mocks'

test.beforeEach(async ({ page }) => {
  await mockRelays(page)
  await installApiMocks(page)
})

const SLUGS = [
  'cashu-basics',
  'understanding-the-risks',
  'how-to-choose-a-mint',
  'getting-started-with-a-wallet',
  'safe-habits',
]

test('numeric deep links /learn/1 … /learn/5 redirect to the slug', async ({ page }) => {
  for (let i = 1; i <= 5; i++) {
    await page.goto(`/learn/${i}`)
    await expect(page).toHaveURL(new RegExp(`/learn/${SLUGS[i - 1]}$`))
    await expect(page.locator('.learn-content h1')).toBeVisible()
  }
})

test('unknown numeric or unknown slug still shows "Module not found"', async ({ page }) => {
  for (const bad of ['0', '6', '99', 'not-a-real-module']) {
    await page.goto(`/learn/${bad}`)
    await expect(page.getByText('Module not found.')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to Learn' })).toBeVisible()
  }
})

test('a middle module footer links "Next:" to the following module', async ({ page }) => {
  await page.goto('/learn/cashu-basics')
  await expect(page.locator('.learn-back-link')).toBeVisible()
  const next = page.locator('.learn-nav-next')
  await expect(next).toContainText('Next:')
  await expect(next).toContainText('Understanding the Risks')
  await next.click()
  await expect(page).toHaveURL(/\/learn\/understanding-the-risks$/)
})

test('the last module footer is "Browse mints" → Dashboard', async ({ page }) => {
  await page.goto('/learn/safe-habits')
  const next = page.locator('.learn-nav-next')
  await expect(next).toContainText('Browse mints')
  await next.click()
  await expect(page).toHaveURL(/\/$/)
})
