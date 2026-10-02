import type { Page, TestInfo } from '@playwright/test'
import { freshRpc, signInAal2, userIdOf } from './lib/auth'
import { APP_ORIGIN } from './lib/authPaths'
import { aliasesOf, auditRowsOf, businessIdForSlug, closeDb, dbNow } from './lib/db'
import { expect, test } from './lib/fixtures'
import { memberRest } from './lib/memberApi'
import { newDeviceContext } from './lib/pro'
import { identityShopFile, provisionLocal, type E2eShop } from './lib/shops'
import { answerStepUp, waitUntilCodeIsStale } from './lib/step-up'

// Step 1.7 (plan «Playwright», contract 1.7 §6.9, D7): Ρυθμίσεις → Ταυτότητα επιχείρησης on a
// synthetic shop per browser project (`identityShopFile`: slug `e2e-identity-<project>`),
// provisioned LOCALLY. The address change is critical: without a fresh code the server refuses
// it (also called straight); in the app the code sheet opens and the change goes through. The old
// address stays the business's alias: GET /<old> answers 301 to /<new> (never cached, query
// kept) and a visitor lands on the shop. The spec ends by taking the old address back through the
// same screen (a business may reclaim its own former slug). A run that failed half-way left the
// shop on the new address: the set-up puts it back first. Needs `npm run db:start` +
// `npm run db:reset` and the dev server.

test.describe.configure({ mode: 'serial', timeout: 180_000 })

/** src/shared/i18n/el/pro.json `identity.*`, `settings.*`. */
const TEXT = {
  entry: /^Ταυτότητα επιχείρησης/,
  title: 'Ταυτότητα επιχείρησης',
  slug: 'Διεύθυνση σελίδας',
  timezone: 'Ζώνη ώρας',
  currency: 'Νόμισμα',
  continue: 'Συνέχεια',
  confirmTitle: 'Έλεγξε τις αλλαγές',
  slugConsequence:
    'Τα links που έχουν ήδη σταλεί θα συνεχίσουν να δουλεύουν και θα οδηγούν στη νέα διεύθυνση. Η παλιά διεύθυνση δεν θα δοθεί ποτέ σε άλλη επιχείρηση.',
  confirm: 'Επιβεβαίωση αλλαγών',
  saved: 'Αποθηκεύτηκε.',
  aliases: 'Παλιές διευθύνσεις που οδηγούν εδώ',
} as const

function projectOf(testInfo: TestInfo): 'chrome' | 'safari' {
  return testInfo.project.name.includes('safari') ? 'safari' : 'chrome'
}

let shop: E2eShop
let slugA: string
let slugB: string
let since: string

// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, testInfo) => {
  // Not covered by the describe's timeout (Playwright's default 30 s applies to hooks): the
  // restore below verifies a new code, which may wait for the next 30″ step, then provisions.
  test.setTimeout(120_000)
  const project = projectOf(testInfo)
  slugA = `e2e-identity-${project}`
  slugB = `${slugA}-b`
  const moved = await businessIdForSlug(slugB)
  if (moved) {
    await freshRpc(`owner@${slugA}.test`, 'change_business_identity', {
      p_business_id: moved,
      p_slug: slugA,
    })
  }
  shop = (await provisionLocal(identityShopFile(project))).shop
  since = await dbNow()
})

test.afterAll(async () => {
  await closeDb()
})

async function openIdentity(page: Page): Promise<void> {
  await page.goto('/app/settings')
  await page.getByRole('link', { name: TEXT.entry }).click()
  await expect(page).toHaveURL(/\/app\/settings\/identity$/)
  await expect(page.getByRole('heading', { level: 1, name: TEXT.title })).toBeVisible()
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
}

/** Types a new address, «Συνέχεια», checks the one change listed, then confirms it with a code. */
async function changeSlug(page: Page, from: string, to: string): Promise<void> {
  const field = page.getByLabel(TEXT.slug)
  await expect(field).toHaveValue(from)
  await field.fill(to)
  await page.getByRole('button', { name: TEXT.continue, exact: true }).click()

  await expect(page.getByRole('heading', { level: 2, name: TEXT.confirmTitle })).toBeVisible()
  // The changed fields only («from → to»; the former addresses below are another list).
  const changes = page.getByRole('listitem').filter({ hasText: '→' })
  await expect(changes).toHaveCount(1)
  await expect(changes).toContainText(TEXT.slug)
  await expect(changes).toContainText(`${from} → ${to}`)
  await expect(changes).toContainText(TEXT.slugConsequence)
  await expect(changes.filter({ hasText: TEXT.timezone })).toHaveCount(0)
  await expect(changes.filter({ hasText: TEXT.currency })).toHaveCount(0)

  await waitUntilCodeIsStale(page)
  await page.getByRole('button', { name: TEXT.confirm }).click()
  await answerStepUp(page, shop.ownerEmail)
  await expect(page.getByText(TEXT.saved, { exact: true })).toBeVisible()
  await expect(field).toHaveValue(to)
  await expect(page.getByRole('region', { name: TEXT.aliases })).toContainText(
    `${APP_ORIGIN}/${from}`,
  )
}

test.describe('Ρυθμίσεις → Ταυτότητα επιχείρησης', () => {
  test('without a fresh code the server refuses the change, also called straight', async ({
    page,
  }) => {
    await signInAal2(page, shop.ownerEmail)
    await waitUntilCodeIsStale(page)
    const { status, body } = await memberRest(page, 'POST', 'rpc/change_business_identity', {
      p_business_id: shop.businessId,
      p_slug: slugB,
    })
    expect({ status, body }).toMatchObject({
      status: 403,
      body: { code: '42501', hint: 'fresh_totp_required' },
    })
    expect(await businessIdForSlug(slugA)).toBe(shop.businessId)
    expect(
      await auditRowsOf({
        actions: ['business_identity_changed'],
        since,
        entityId: shop.businessId,
      }),
    ).toEqual([])
  })

  test('a new address (code sheet → success): the old link redirects, and it can come back', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await signInAal2(page, shop.ownerEmail)
    await openIdentity(page)
    await changeSlug(page, slugA, slugB)
    expect(await aliasesOf(shop.businessId)).toEqual([slugA])

    // The old link: 301 to the new address, with the query, never cached (D7).
    const answer = await request.get(`/${slugA}?from=e2e`, { maxRedirects: 0 })
    expect(answer.status()).toBe(301)
    expect(answer.headers()['location']).toBe(`/${slugB}?from=e2e`)
    expect(answer.headers()['cache-control']).toContain('no-store')

    // A visitor with the old link lands on the shop at its new address.
    const visitor = await newDeviceContext(browser, testInfo)
    try {
      const phone = await visitor.newPage()
      await phone.goto(`/${slugA}`)
      await expect(phone).toHaveURL(new RegExp(`/${slugB}$`))
      await expect(
        phone.getByRole('heading', { level: 1, name: `E2E Identity ${projectOf(testInfo)}` }),
      ).toBeVisible()
    } finally {
      await visitor.close()
    }

    // Back to the first address, through the same screen: its own former slug.
    await changeSlug(page, slugB, slugA)
    expect(await aliasesOf(shop.businessId)).toEqual([slugB])

    const owner = await userIdOf(shop.ownerEmail)
    const audit = await auditRowsOf({
      actions: ['business_identity_changed'],
      since,
      entityId: shop.businessId,
    })
    expect(audit.map((row) => [row.actor_type, row.actor_id, row.entity, row.reason])).toEqual([
      ['staff', owner, 'business', `slug=${slugA}>${slugB}`],
      ['staff', owner, 'business', `slug=${slugB}>${slugA}`],
    ])
  })
})
