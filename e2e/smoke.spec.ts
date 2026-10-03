import type { Page } from '@playwright/test'
import { expect, test } from './lib/fixtures'

// Walking skeleton: booking page → /api proxy → Supabase RPC → seeded demo business (the
// catalogue is injected into the page by the Vite dev server, as by the Worker).
// `test` comes from the fixtures because one spec opens /app (installed-app pretence on WebKit).

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

test('the booking page of the demo business loads from the database', async ({ page }) => {
  await page.goto('/demo-barber')
  await expect(page.getByRole('heading', { level: 1, name: 'Demo Barber' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Τι θα κάνουμε;' })).toBeVisible()
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
  // Signed out, the pro app sends the visitor to its sign-in screen (step 1.1, ADR-0009).
  await page.goto('/app')
  await expect(page).toHaveURL(/\/app\/login$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Σύνδεση' })).toBeVisible()
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

// Exit criterion of step 1.1 (ADR-0008 §3): the Edge Functions answer only through the proxy,
// which adds the shared secret. In CI this also proves PROXY_SECRET reached the edge runtime.
// Since 1.9 (contract §3.1, §5.5-C): the six checks of public.health(), none stale (the jobs ran
// or are still within their threshold since the migration started watching them).
test('health answers through /api and refuses direct calls', async ({ request }) => {
  const viaProxy = await request.get('/api/functions/v1/health')
  const body = (await viaProxy.json()) as {
    ok: boolean
    checks: Array<{ name: string; age_seconds: number | null; stale: boolean }>
  }
  expect(viaProxy.status(), JSON.stringify(body)).toBe(200)
  expect(viaProxy.headers()['cache-control']).toBe('no-store')
  expect(body.ok).toBe(true)
  expect(body.checks.map((check) => check.name)).toEqual([
    'auto_complete',
    'detect_factor_changes',
    'dispatch',
    'dispatch_sweep',
    'purge',
    'security_events',
  ])
  expect(body.checks.filter((check) => check.stale)).toEqual([])
  for (const check of body.checks) {
    expect(Object.keys(check).sort()).toEqual(['age_seconds', 'max_age_seconds', 'name', 'stale'])
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:54321'
  const direct = await request.get(`${supabaseUrl}/functions/v1/health`)
  expect(direct.status()).toBe(403)
})
