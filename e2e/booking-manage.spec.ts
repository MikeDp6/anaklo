import { expect, test } from './lib/fixtures'
import {
  bookOnce,
  chooseDay,
  chooseService,
  chooseStaff,
  openShop,
  PHONES,
  staffFor,
  times,
} from './lib/booking'

// The manage link /m/<token> of a booking (step 1.3): cancel frees the time and kills every
// link of the appointment; reschedule keeps the staff member and moves the appointment.

test.describe('manage link', () => {
  test.describe.configure({ timeout: 90_000 })

  test('cancelling from the link frees the time and the link stops working', async ({
    page,
  }, testInfo) => {
    const staff = staffFor(testInfo)
    await openShop(page)
    const booked = await bookOnce(page, {
      staff,
      day: 5,
      name: 'Ελένη Ακυρώνει',
      phone: PHONES.fresh,
    })

    await page.getByRole('link', { name: 'Αλλαγή ή ακύρωση' }).click()
    await expect(page).toHaveURL(booked.manageHref)
    await expect(page.getByRole('heading', { level: 1, name: 'Demo Barber' })).toBeVisible()
    await expect(page.getByText(booked.label, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Ακύρωση ραντεβού' }).click()
    await page.getByRole('button', { name: 'Ναι, ακύρωσε' }).click()
    await expect(page.getByRole('heading', { name: 'Το ραντεβού ακυρώθηκε' })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Ο σύνδεσμος δεν ισχύει πια.' })).toBeVisible()

    await openShop(page)
    await chooseService(page)
    await chooseStaff(page, staff)
    await chooseDay(page, 5)
    await expect(
      times(page).and(page.locator(`[data-starts-at="${booked.startsAt}"]`)),
    ).toBeVisible()
  })

  test('rescheduling from the link moves the appointment to another free time', async ({
    page,
  }, testInfo) => {
    await openShop(page)
    const booked = await bookOnce(page, {
      staff: staffFor(testInfo),
      day: 6,
      name: 'Ελένη Μετακινεί',
      phone: PHONES.fresh,
    })
    await page.goto(booked.manageHref)
    await page.getByRole('button', { name: 'Αλλαγή ώρας' }).click()
    const strip = page.getByRole('group', { name: 'Ημερομηνίες' })
    await strip.locator(`button[data-date="${booked.date}"]`).click()
    const choices = times(page)
    await expect(choices.first()).toBeVisible()
    await expect(page.locator(`[data-starts-at="${booked.startsAt}"]`)).toHaveCount(0)
    const next = (await choices.first().textContent()) ?? ''
    await choices.first().click()
    // The button names the day too (a time belongs to the day it was chosen on).
    await page.getByRole('button', { name: new RegExp(`^Μετακίνηση: .+, ${next}$`) }).click()

    await expect(
      page.getByRole('status').filter({ hasText: 'Το ραντεβού μετακινήθηκε' }),
    ).toBeVisible()
    await page.reload()
    await expect(page.getByText(next, { exact: true })).toBeVisible()
    await expect(page.getByText(booked.label, { exact: true })).toHaveCount(0)
  })
})
