import { expect, test } from './lib/fixtures'
import {
  bookViaApi,
  chooseDay,
  chooseService,
  chooseStaff,
  chooseTime,
  enterCode,
  fillDetails,
  finishBooking,
  openShop,
  PHONES,
  SHOP,
  STAFF,
  staffFor,
  submitDetails,
  TEXT,
  times,
} from './lib/booking'

// When things go wrong (step 1.3): a time taken meanwhile, an SMS code that fails. See
// e2e/lib/booking.ts for how parallel tests keep to their own staff member and day.

test.describe('online booking, when things go wrong', () => {
  test.describe.configure({ timeout: 90_000 })

  test('a time taken meanwhile offers nearby free times, and one of them books', async ({
    page,
    request,
  }, testInfo) => {
    const staff = staffFor(testInfo)
    await openShop(page)
    await chooseService(page)
    await chooseStaff(page, staff)
    await chooseDay(page, 4)
    const taken = await chooseTime(page)
    // Another visitor books the same time first.
    await bookViaApi(request, { staffId: STAFF[staff], startsAt: taken.startsAt })

    await fillDetails(page, 'Ελένη Αργή', PHONES.fresh)
    await expect(page.getByText(`Η ώρα ${taken.label} μόλις κλείστηκε`)).toBeVisible()
    const nearby = page
      .getByRole('alert')
      .getByRole('group', { name: /^Ελεύθερες ώρες/ })
      .getByRole('button')
    await expect(nearby.first()).toBeVisible()
    await expect(nearby.filter({ hasText: taken.label })).toHaveCount(0)
    const other = (await nearby.first().textContent()) ?? ''
    await nearby.first().click()
    await expect(page.getByText(`Η ώρα ${taken.label} μόλις κλείστηκε`)).toHaveCount(0)

    await submitDetails(page)
    await enterCode(page)
    await finishBooking(page)
    await expect(page.getByText(other, { exact: true })).toBeVisible()
  })

  test('five wrong codes lock the check and offer the shop phone', async ({ page }, testInfo) => {
    await openShop(page)
    await chooseService(page)
    await chooseStaff(page, staffFor(testInfo))
    await chooseDay(page, 0)
    await expect(times(page).last()).toBeVisible()
    await chooseTime(page, 'last')
    await fillDetails(page, 'Ελένη Λάθος', PHONES.fresh)

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await enterCode(page, '000000')
      await expect(page.getByRole('alert')).toHaveText('Λάθος κωδικός. Δοκίμασε ξανά.')
      await expect(page.getByLabel(TEXT.codeLabel, { exact: true })).toHaveValue('')
    }
    await enterCode(page, '000000')
    await expect(page.getByRole('alert')).toContainText('Πολλές λάθος προσπάθειες')
    await expect(
      page.getByRole('link', { name: 'Τηλεφώνησε στο +30 261 000 0000' }),
    ).toHaveAttribute('href', SHOP.phoneHref)
  })

  test('when no SMS can be sent the page offers the shop phone', async ({ page }, testInfo) => {
    await page.route('**/api/functions/v1/public-booking', async (route) => {
      const body = route.request().postDataJSON() as { action?: string }
      if (body.action !== 'start') return route.continue()
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'AN017', message: 'sms_unavailable' } }),
      })
    })
    await openShop(page)
    await chooseService(page)
    await chooseStaff(page, staffFor(testInfo))
    await chooseDay(page, 0)
    await chooseTime(page, 'last')
    await fillDetails(page, 'Ελένη Χωρίς SMS', PHONES.fresh)
    await expect(page.getByRole('alert')).toContainText('Δεν μπορούμε να στείλουμε κωδικό τώρα.')
    await expect(
      page.getByRole('link', { name: 'Τηλεφώνησε στο +30 261 000 0000' }),
    ).toHaveAttribute('href', SHOP.phoneHref)
  })
})
