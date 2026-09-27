import { expect, test, type Page } from '@playwright/test'

// Phase 0 walking skeleton: booking page → /api proxy → Supabase RPC → seeded demo business.

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

test('the booking page of the demo business loads from the database', async ({ page }) => {
  await page.goto('/demo-barber')
  await expect(page.getByRole('heading', { level: 1, name: 'Demo Barber' })).toBeVisible()
  await expect(page.getByText('Η online κράτηση ανοίγει σύντομα.')).toBeVisible()
  await expect(page).toHaveTitle('Demo Barber')
  await expectNoHorizontalScroll(page)
})

test('an unknown business shows a clear not-found message', async ({ page }) => {
  await page.goto('/no-such-shop')
  await expect(page.getByRole('heading', { name: 'Δεν βρέθηκε η σελίδα κράτησης' })).toBeVisible()
})

test('the landing page opens at /', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Anaklo' })).toBeVisible()
})

test('the pro app opens under /app with its own manifest', async ({ page }) => {
  await page.goto('/app')
  await expect(page.getByRole('heading', { level: 1, name: 'Σήμερα' })).toBeVisible()
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/app/manifest.webmanifest',
  )
  await expectNoHorizontalScroll(page)
})

test('the booking page does not offer the pro app manifest', async ({ page }) => {
  await page.goto('/demo-barber')
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0)
})
