import { expect, test } from './lib/fixtures'
import {
  bookOnce,
  chooseDay,
  chooseService,
  chooseStaff,
  chooseTime,
  enterCode,
  finishBooking,
  openShop,
  PHONES,
  SHOP,
  staffFor,
  submitDetails,
  TEXT,
} from './lib/booking'

// Online booking end-to-end (step 1.3) on the local stack: the /api proxy of Vite, the Edge
// Functions with the fake SMS adapter and the dev test numbers (OTP_TEST_CODE). Every test
// books with the staff member of its browser project, on its own day (e2e/lib/booking.ts).

test.describe('online booking', () => {
  test.describe.configure({ timeout: 90_000 })

  test('a new device verifies the mobile by SMS code, books and gets the confirmation', async ({
    page,
  }, testInfo) => {
    await openShop(page)
    await chooseService(page)
    await chooseStaff(page, staffFor(testInfo))
    const date = await chooseDay(page, 0)
    const time = await chooseTime(page)
    await page.getByLabel('Ονοματεπώνυμο', { exact: true }).fill('Ελένη Νέα')
    await page.getByLabel('Κινητό', { exact: true }).fill(PHONES.fresh)
    await submitDetails(page)

    await expect(
      page.getByText('Στείλαμε 6ψήφιο κωδικό με SMS στο +30 690 000 0999.'),
    ).toBeVisible()
    await expect(page.getByLabel(TEXT.codeLabel, { exact: true })).toHaveAttribute(
      'autocomplete',
      'one-time-code',
    )
    await expect(page.getByLabel(TEXT.codeLabel, { exact: true })).toHaveAttribute(
      'inputmode',
      'numeric',
    )
    await enterCode(page)
    await finishBooking(page)

    await expect(page.getByRole('img', { name: TEXT.bookedTitle })).toBeVisible()
    await expect(page.getByText(time.label, { exact: true })).toBeVisible()
    await expect(page.getByText(/ξανάρχονται σε 4 εβδομάδες/)).toBeVisible()
    await expect(page.getByRole('link', { name: 'Google Calendar' })).toHaveAttribute(
      'href',
      /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/,
    )
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Στο ημερολόγιο (.ics)' }).click()
    expect((await download).suggestedFilename()).toBe(
      `${SHOP.slug}-${time.startsAt.slice(0, 10)}.ics`,
    )
    expect(date > '').toBe(true)
  })

  test('the same device books again without an SMS code', async ({ page }, testInfo) => {
    const staff = staffFor(testInfo)
    await openShop(page)
    await bookOnce(page, { staff, day: 1, name: 'Ελένη Έμπιστη', phone: PHONES.fresh })

    await page.getByRole('button', { name: 'Κλείσε κι άλλο ραντεβού' }).click()
    await chooseService(page)
    await chooseStaff(page, staff)
    await chooseDay(page, 1)
    await chooseTime(page)
    // Name and mobile are kept from the first booking (memory only).
    await expect(page.getByLabel('Κινητό', { exact: true })).toHaveValue('+30 690 000 0999')
    await submitDetails(page)
    await expect(
      page
        .getByRole('heading', { name: TEXT.bookedTitle })
        .or(page.getByRole('heading', { name: TEXT.bookAs })),
    ).toBeVisible()
    await expect(page.getByLabel(TEXT.codeLabel, { exact: true })).toHaveCount(0)
    await finishBooking(page)
  })

  test('with cookies blocked the booking completes with the one-time grant', async ({
    page,
    context,
  }, testInfo) => {
    // The trusted-device cookie never reaches the browser: the proxy's Set-Cookie is dropped.
    await page.route('**/api/functions/v1/public-booking', async (route) => {
      const request = route.request()
      const upstream = await fetch(request.url(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-anaklo-business': request.headers()['x-anaklo-business'] ?? '',
        },
        body: request.postData() ?? '',
      })
      const headers: Record<string, string> = {}
      upstream.headers.forEach((value, name) => {
        if (!['set-cookie', 'content-encoding', 'content-length'].includes(name))
          headers[name] = value
      })
      await route.fulfill({
        status: upstream.status,
        headers,
        body: Buffer.from(await upstream.arrayBuffer()),
      })
    })
    const staff = staffFor(testInfo)
    await openShop(page)
    await bookOnce(page, { staff, day: 2, name: 'Ελένη Χωρίς Cookies', phone: PHONES.fresh })
    expect((await context.cookies()).filter((cookie) => cookie.name.startsWith('td_'))).toEqual([])

    // Without the cookie the next booking needs a code again.
    await page.getByRole('button', { name: 'Κλείσε κι άλλο ραντεβού' }).click()
    await chooseService(page)
    await chooseStaff(page, staff)
    await chooseDay(page, 2)
    await chooseTime(page)
    await submitDetails(page)
    await expect(page.getByLabel(TEXT.codeLabel, { exact: true })).toBeVisible()
  })

  test('a shared family mobile offers first names only and books for the one chosen', async ({
    page,
  }, testInfo) => {
    await openShop(page)
    await chooseService(page)
    await chooseStaff(page, staffFor(testInfo))
    await chooseDay(page, 3)
    await chooseTime(page)
    await page.getByLabel('Ονοματεπώνυμο', { exact: true }).fill('Μάριος Παπαδόπουλος')
    await page.getByLabel('Κινητό', { exact: true }).fill(PHONES.family)
    await submitDetails(page)
    await enterCode(page)

    await expect(page.getByRole('heading', { name: TEXT.bookAs })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Γιώργος', exact: true })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Μάριος', exact: true })).toBeChecked()
    await expect(page.getByRole('radio', { name: /Π\./ })).toHaveCount(0)
    await expect(
      page.getByRole('radio', { name: 'Άλλο άτομο · Μάριος Παπαδόπουλος' }),
    ).toBeVisible()
    await page.getByRole('button', { name: TEXT.bookCta }).click()
    await expect(page.getByRole('heading', { name: TEXT.bookedTitle })).toBeVisible()
  })

  test('the SMS short link /r/<code> opens the booking page', async ({ page }) => {
    await page.goto('/r/demo01')
    await expect(page).toHaveURL(`/${SHOP.slug}`)
    await expect(page.getByRole('heading', { level: 1, name: SHOP.name })).toBeVisible()
  })
})
