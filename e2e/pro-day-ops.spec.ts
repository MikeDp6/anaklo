import type { Page } from '@playwright/test'
import { staffFor } from './lib/booking'
import { expect, test } from './lib/fixtures'
import { signInWithEmailCode } from './lib/login'
import {
  chooseDayWithTimes,
  chooseTime,
  confirmD8IfAsked,
  dayAppointment,
  newDeviceContext,
  openQuickAdd,
  openToday,
  PRO_TEXT,
  quickAddNewClient,
  sheet,
} from './lib/pro'
import { SEED_USERS } from './lib/seedUsers'

// Step 1.4, SPEC §5 flow 3: the barber's day in the pro app (mobile viewports, Chromium + WebKit).
// Needs `npm run db:start` + `npm run db:reset` (seed: demo-barber, owner/manager/staff users) and
// the dev server. Each browser project works on its own staff member and each test on its own
// window of days (see e2e/lib/pro.ts), so the specs run in parallel and again without a reset.

test.describe.configure({ timeout: 120_000 })

function uniqueName(prefix: string, project: string): string {
  return `${prefix} ${project.replace('mobile-', '')} ${Date.now().toString(36)}`
}

test.describe('pro app: bookings of the day', () => {
  test('a phone booking takes less than 10″', async ({ page }, testInfo) => {
    const staff = staffFor(testInfo)
    await signInWithEmailCode(page, SEED_USERS.owner.email)
    await openToday(page)

    const started = Date.now()
    const dialog = await openQuickAdd(page)
    await dialog.getByLabel(PRO_TEXT.search).fill('κωστα')
    await dialog
      .getByRole('button', { name: /^Κώστας Μ\./ })
      .first()
      .click()
    await dialog.getByRole('button', { name: /^Κούρεμα\s*\d/ }).click()
    await dialog.getByRole('button', { name: staff, exact: true }).click()
    await chooseDayWithTimes(dialog, 3)
    await chooseTime(dialog)
    await dialog.getByRole('button', { name: PRO_TEXT.book }).click()
    await expect(dialog.getByRole('img', { name: PRO_TEXT.booked })).toBeVisible()
    expect(Date.now() - started).toBeLessThan(10_000)

    await expect(dialog.getByText(new RegExp(`^Κώστας Μ\\. · .* · ${staff}$`))).toBeVisible()
  })

  test('a booking is moved to a free time of the list', async ({ page }, testInfo) => {
    const staff = staffFor(testInfo)
    const name = uniqueName('Μετακίνηση', testInfo.project.name)
    await signInWithEmailCode(page, SEED_USERS.owner.email)
    await openToday(page)
    const booked = await quickAddNewClient(page, { name, staff, window: 4 })

    await page.goto(`/app/day?date=${booked.date}`)
    const before = dayAppointment(page, new RegExp(name))
    await expect(before).toHaveAccessibleName(new RegExp(`^${booked.label}`))
    await before.click()
    await sheet(page).getByRole('button', { name: PRO_TEXT.move }).click()

    const dialog = sheet(page)
    await expect(dialog.getByRole('button', { name: staff, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const target = await chooseTime(dialog, 'last')
    expect(target.label).not.toBe(booked.label)
    await dialog.getByRole('button', { name: PRO_TEXT.moveHere }).click()
    await expect(dialog.getByRole('img', { name: PRO_TEXT.moved })).toBeVisible()
    await dialog.getByRole('button', { name: PRO_TEXT.done }).click()

    await expect(dayAppointment(page, new RegExp(name))).toHaveAccessibleName(
      new RegExp(`^${target.label}`),
    )
  })

  test('a second device sees the change within 60″ (no Realtime in Phase 1)', async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(180_000)
    const staff = staffFor(testInfo)
    const name = uniqueName('Δεύτερη συσκευή', testInfo.project.name)

    // Device B (the manager) keeps the day open before anything changes.
    const other = await newDeviceContext(browser, testInfo)
    const second = await other.newPage()
    try {
      await signInWithEmailCode(second, SEED_USERS.manager.email)
      // Device A (the owner) books on the first day with free times of window 5.
      await signInWithEmailCode(page, SEED_USERS.owner.email)
      await openToday(page)
      const dialog = await openQuickAdd(page)
      await dialog.getByRole('button', { name: PRO_TEXT.newClient }).click()
      await dialog.getByLabel(PRO_TEXT.fullName).fill(name)
      await dialog.getByRole('button', { name: PRO_TEXT.continue }).click()
      await dialog.getByRole('button', { name: /^Κούρεμα\s*\d/ }).click()
      await dialog.getByRole('button', { name: staff, exact: true }).click()
      const date = await chooseDayWithTimes(dialog, 5)

      await second.goto(`/app/day?date=${date}`)
      await expect(second.getByTestId('day-view')).toBeVisible()
      await expect(dayAppointment(second, new RegExp(name))).toHaveCount(0)

      await chooseTime(dialog)
      await dialog.getByRole('button', { name: PRO_TEXT.book }).click()
      await expect(dialog.getByRole('img', { name: PRO_TEXT.booked })).toBeVisible()

      // The 60″ poll of the open day (or the next focus) brings it in.
      await expect(dayAppointment(second, new RegExp(name))).toBeVisible({ timeout: 70_000 })
    } finally {
      await other.close()
    }
  })
})

test.describe('pro app: sheets and the keyboard', () => {
  test('closing a sheet gives the focus back to the button that opened it', async ({ page }) => {
    await signInWithEmailCode(page, SEED_USERS.owner.email)
    await openToday(page)
    const opener = page.getByRole('button', { name: PRO_TEXT.newAppointment, exact: true })
    const dialog = sheet(page)

    // Esc.
    await opener.focus()
    await page.keyboard.press('Enter')
    await expect(dialog.getByLabel(PRO_TEXT.search)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()

    // The X of the sheet.
    await page.keyboard.press('Enter')
    await expect(dialog.getByLabel(PRO_TEXT.search)).toBeVisible()
    await dialog.getByRole('button', { name: PRO_TEXT.close, exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
  })
})

/**
 * Walk-ins start NOW for the project's staff member, so these two run one after the other; the
 * first ends by cancelling its walk-in, the second marks its own as a no-show, so the staff member
 * is free again for the next run (neither status blocks a time).
 */
test.describe('pro app: walk-in and no-show', () => {
  test.describe.configure({ mode: 'serial' })

  async function walkInNow(page: Page, staff: string, service: RegExp) {
    await openToday(page)
    await page.getByRole('button', { name: `Walk-in: ${staff}` }).click()
    const dialog = sheet(page)
    await dialog.getByRole('button', { name: service }).click()
    await dialog.getByRole('button', { name: PRO_TEXT.walkInStart }).click()
    // Outside the working hours or inside a buffer the server asks first (D8).
    await confirmD8IfAsked(dialog, dialog.getByRole('img', { name: PRO_TEXT.walkInDone }))
    await dialog.getByRole('button', { name: PRO_TEXT.done }).click()
    await expect(dialog).toHaveCount(0)
  }

  /** The walk-in in «Επόμενα» (in progress: «Τώρα»), of this staff member. */
  function nowItem(page: Page, staff: string) {
    return page
      .getByRole('region', { name: 'Επόμενα' })
      .getByRole('button', { name: new RegExp(`^Τώρα\\s*${PRO_TEXT.walkInAnonymous}.*${staff}`) })
  }

  test('a walk-in needs no phone and no name', async ({ page }, testInfo) => {
    const staff = staffFor(testInfo)
    await signInWithEmailCode(page, SEED_USERS.owner.email)
    await walkInNow(page, staff, /^Γένια\s*\d/)

    const item = nowItem(page, staff).first()
    await expect(item).toBeVisible()
    // Clean up: cancel it (reason «Διπλό ραντεβού»), which also frees the time.
    await item.click()
    const dialog = sheet(page)
    await expect(dialog.getByText(PRO_TEXT.walkInAnonymous)).toBeVisible()
    await dialog.getByRole('button', { name: PRO_TEXT.cancel, exact: true }).click()
    await dialog.getByRole('radio', { name: 'Διπλό ραντεβού' }).check()
    // A walk-in has no phone: no SMS option.
    await expect(dialog.getByRole('checkbox', { name: /Ενημέρωση με SMS/ })).toHaveCount(0)
    await dialog.getByRole('button', { name: PRO_TEXT.cancelSubmit }).click()
    await expect(dialog.getByText(PRO_TEXT.cancelled)).toBeVisible()
  })

  test('a started appointment is marked as a no-show', async ({ page }, testInfo) => {
    const staff = staffFor(testInfo)
    await signInWithEmailCode(page, SEED_USERS.owner.email)
    await walkInNow(page, staff, /^Γένια\s*\d/)

    const item = nowItem(page, staff).first()
    await expect(item).toBeVisible()
    const before = await nowItem(page, staff).count()
    await item.click()
    const dialog = sheet(page)
    await dialog.getByRole('button', { name: PRO_TEXT.noShow, exact: true }).click()
    // The sheet closes only once the server answered; the list refetches.
    await expect(dialog).toHaveCount(0)
    await expect(nowItem(page, staff)).toHaveCount(before - 1)
  })
})
