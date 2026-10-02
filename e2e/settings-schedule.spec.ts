import type { APIRequestContext, Locator, Page, TestInfo } from '@playwright/test'
import { addLocalDays, toLocalDate, weekdayOf } from '../supabase/functions/_shared/dates.ts'
import { expect, test } from './lib/fixtures'
import { signInWithEmailCode } from './lib/login'
import { memberRest } from './lib/memberApi'
import { provisionLocal, settingsShopFile, type E2eShop } from './lib/shops'

// Step 1.6, contract §6.6: the schedule screens of the pro app (closures, time off, booking
// policy) and the reduced-motion check of every settings screen of UI-B, on a dedicated
// synthetic shop per browser project (`settingsShopFile(project, 'schedule')`: staff «Ε2Ε Α»,
// «Ε2Ε Β»; «Κούρεμα» 30′ by both; Tue–Sat 10:00-18:00), provisioned LOCALLY before the tests.
// Needs `npm run db:start` + `npm run db:reset` and the dev server. Texts:
// src/shared/i18n/el/pro.json.

test.describe.configure({ mode: 'serial', timeout: 120_000 })

const TEXT = {
  settings: 'Ρυθμίσεις',
  closures: 'Κλεισίματα και ειδικές μέρες',
  newClosure: 'Νέο κλείσιμο',
  closuresList: 'Κλεισίματα και ειδικά ωράρια',
  closureSaved: 'Το κλείσιμο αποθηκεύτηκε.',
  timeOff: 'Άδειες',
  newTimeOff: 'Νέα άδεια',
  timeOffList: 'Άδειες',
  timeOffSaved: 'Η άδεια αποθηκεύτηκε.',
  timeOffDeleted: 'Η άδεια διαγράφηκε.',
  policy: 'Πολιτική κρατήσεων',
  absence: 'Έκτακτη απουσία',
  save: 'Αποθήκευση',
  saved: 'Αποθηκεύτηκε',
  done: 'Τέλος',
  delete: 'Διαγραφή',
  deleted: 'Διαγράφηκε.',
} as const

function projectOf(testInfo: TestInfo): string {
  return testInfo.project.name.includes('safari') ? 'safari' : 'chrome'
}

/** The shop's zone, from the file the spec provisioned (never hard-coded). */
function zoneOf(file: unknown): string {
  if (typeof file === 'object' && file !== null && 'business' in file) {
    const business: unknown = file.business
    if (typeof business === 'object' && business !== null && 'timezone' in business) {
      if (typeof business.timezone === 'string') return business.timezone
    }
  }
  throw new Error('the settings shop file has no business.timezone')
}

let shop: E2eShop
let zone: string

// Playwright passes the fixtures first; this hook needs none.
// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, testInfo) => {
  const file = settingsShopFile(projectOf(testInfo), 'schedule')
  zone = zoneOf(file)
  shop = (await provisionLocal(file)).shop
})

function idOf(record: Readonly<Record<string, string>>, name: string): string {
  const id = record[name]
  if (!id) throw new Error(`the e2e shop has no "${name}"`)
  return id
}

/** Every CSS animation or transition running or pending on the page (pro-motion.spec). */
function runningAnimations(page: Page) {
  return page.evaluate(() =>
    document.getAnimations().map((animation) => {
      const target = (animation.effect as KeyframeEffect | null)?.target
      return target instanceof Element ? target.className : String(target)
    }),
  )
}

/**
 * A working date (Tue–Fri, so the next day is a working day too) at least `minDays` after today
 * in the shop's zone: the closure covers it and the next day.
 */
function workingDate(minDays: number): string {
  let date = addLocalDays(toLocalDate(new Date(), zone), minDays)
  while (![2, 3, 4, 5].includes(weekdayOf(date))) date = addLocalDays(date, 1)
  return date
}

/** Free starts of «Κούρεμα» on `[from, to]`, read like the booking page does (/api). */
async function freeStarts(
  request: APIRequestContext,
  options: { from: string; to: string; staffId?: string },
): Promise<string[]> {
  const response = await request.post('/api/rest/v1/rpc/available_slots', {
    data: {
      p_slug: shop.slug,
      p_service_ids: [idOf(shop.services, 'Κούρεμα')],
      p_staff_id: options.staffId ?? null,
      p_from: options.from,
      p_to: options.to,
    },
  })
  expect(response.status(), await response.text()).toBe(200)
  return ((await response.json()) as { starts_at: string }[]).map((slot) => slot.starts_at)
}

async function openPage(page: Page, path: string, title: string): Promise<void> {
  await page.goto(path)
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
}

/** A failed earlier run may have left closures or time off on this shop: start clean. */
async function clearSchedule(page: Page): Promise<void> {
  for (const table of ['schedule_exceptions', 'time_off']) {
    const { status, body } = await memberRest(
      page,
      'DELETE',
      `${table}?business_id=eq.${shop.businessId}`,
    )
    expect(status, JSON.stringify(body)).toBeLessThan(300)
  }
}

function closureItems(page: Page): Locator {
  return page.getByRole('list', { name: TEXT.closuresList }).getByRole('listitem')
}

test.describe('pro app: schedule settings', () => {
  test('the owner adds a shop closure for two days; booking shows no time; deleting it frees them', async ({
    page,
    request,
  }) => {
    const first = workingDate(3)
    const second = addLocalDays(first, 1)

    await signInWithEmailCode(page, shop.ownerEmail)
    await clearSchedule(page)
    expect(await freeStarts(request, { from: first, to: second })).not.toEqual([])
    await page.goto('/app/settings')
    await page.getByRole('link', { name: new RegExp(`^${TEXT.closures}`) }).click()
    await expect(page.getByRole('heading', { level: 1, name: TEXT.closures })).toBeVisible()

    await page.getByRole('button', { name: TEXT.newClosure }).click()
    const dialog = page.getByRole('dialog', { name: TEXT.newClosure })
    await expect(dialog.getByLabel('Για', { exact: true })).toHaveValue('')
    await expect(dialog.getByRole('radio', { name: /^Κλειστό/ })).toBeChecked()
    await dialog.getByLabel('Από', { exact: true }).fill(first)
    await dialog.getByLabel('Έως', { exact: true }).fill(second)
    await dialog.getByLabel('Σημείωση').fill('Αργία')
    await dialog.getByRole('button', { name: TEXT.save }).click()
    await expect(dialog.getByText(TEXT.closureSaved)).toBeVisible()
    await dialog.getByRole('button', { name: TEXT.done }).click()
    await expect(dialog).toHaveCount(0)

    // One grouped item for both dates.
    await expect(closureItems(page)).toHaveCount(1)
    await expect(closureItems(page).first()).toContainText('Αργία')
    await expect(closureItems(page).first()).toContainText('Όλο το κατάστημα · Κλειστό')
    await expect.poll(() => freeStarts(request, { from: first, to: second })).toEqual([])

    await closureItems(page)
      .first()
      .getByRole('button', { name: /^Διαγραφή:/ })
      .click()
    await closureItems(page).first().getByRole('button', { name: TEXT.delete, exact: true }).click()
    await expect(page.getByRole('list', { name: TEXT.closuresList })).toHaveCount(0)
    await expect
      .poll(async () => (await freeStarts(request, { from: first, to: second })).length)
      .toBeGreaterThan(0)
  })

  test('time off for «Ε2Ε Α» empties only their times that day and shows in the list', async ({
    page,
    request,
  }) => {
    const date = workingDate(10)
    const staffA = idOf(shop.staff, 'Ε2Ε Α')
    const staffB = idOf(shop.staff, 'Ε2Ε Β')

    await signInWithEmailCode(page, shop.ownerEmail)
    await clearSchedule(page)
    expect(await freeStarts(request, { from: date, to: date, staffId: staffA })).not.toEqual([])
    await openPage(page, '/app/settings/time-off', TEXT.timeOff)
    await page.getByRole('button', { name: TEXT.newTimeOff }).click()
    const dialog = page.getByRole('dialog', { name: TEXT.newTimeOff })
    await dialog.getByLabel('Επαγγελματίας').selectOption({ label: 'Ε2Ε Α' })
    await expect(dialog.getByRole('radio', { name: 'Διακοπές' })).toBeChecked()
    await expect(dialog.getByRole('switch', { name: 'Όλη μέρα' })).toBeChecked()
    await dialog.getByLabel('Από', { exact: true }).fill(date)
    await dialog.getByLabel('Έως', { exact: true }).fill(date)
    await dialog.getByRole('button', { name: TEXT.save }).click()
    await expect(dialog.getByText(TEXT.timeOffSaved)).toBeVisible()
    await dialog.getByRole('button', { name: TEXT.done }).click()

    const row = page
      .getByRole('list', { name: TEXT.timeOffList })
      .getByRole('button', { name: /^Ε2Ε Α/ })
    await expect(row).toContainText('Διακοπές')
    await expect
      .poll(() => freeStarts(request, { from: date, to: date, staffId: staffA }))
      .toEqual([])
    expect(await freeStarts(request, { from: date, to: date, staffId: staffB })).not.toEqual([])

    // Clean up through the screen: the sheet's «Διαγραφή», once confirmed.
    await row.click()
    const edit = page.getByRole('dialog', { name: 'Άδεια' })
    await edit.getByRole('button', { name: TEXT.delete }).click()
    await edit.getByRole('button', { name: TEXT.delete }).first().click()
    await expect(edit.getByText(TEXT.timeOffDeleted)).toBeVisible()
    await edit.getByRole('button', { name: TEXT.done }).click()
    await expect
      .poll(
        async () => (await freeStarts(request, { from: date, to: date, staffId: staffA })).length,
      )
      .toBeGreaterThan(0)
  })

  test('booking policy: the time step is saved, shown after a reload, and restored', async ({
    page,
  }) => {
    await signInWithEmailCode(page, shop.ownerEmail)
    await openPage(page, '/app/settings/booking-policy', TEXT.policy)
    const step = page.getByLabel('Βήμα ωρών')
    await expect(step).toHaveValue('15')
    await step.selectOption('30')
    await page.getByRole('button', { name: TEXT.save }).click()
    await expect(page.getByRole('status').filter({ hasText: TEXT.saved })).toBeVisible()

    await page.reload()
    await expect(page.getByLabel('Βήμα ωρών')).toHaveValue('30')
    await page.getByLabel('Βήμα ωρών').selectOption('15')
    await page.getByRole('button', { name: TEXT.save }).click()
    await expect(page.getByRole('status').filter({ hasText: TEXT.saved })).toBeVisible()
    await page.reload()
    await expect(page.getByLabel('Βήμα ωρών')).toHaveValue('15')
  })
})

test.describe('settings screens with reduced motion', () => {
  test('the index, closures, time off, policy and absence do not move, nor their skeletons', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await signInWithEmailCode(page, shop.ownerEmail)
    const screens = [
      ['/app/settings', TEXT.settings],
      ['/app/settings/closures', TEXT.closures],
      ['/app/settings/time-off', TEXT.timeOff],
      ['/app/settings/booking-policy', TEXT.policy],
      ['/app/settings/absence', TEXT.absence],
    ] as const
    for (const [path, title] of screens) {
      await openPage(page, path, title)
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
      expect(await runningAnimations(page), path).toEqual([])
    }

    // While a skeleton (E17) shows: a slow list must not shimmer either.
    await page.route('**/rest/v1/schedule_exceptions*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      await route.continue()
    })
    await page.goto('/app/settings/closures')
    await expect(
      page.getByRole('status').filter({ hasText: 'Φόρτωση κλεισιμάτων…' }),
    ).toBeAttached()
    expect(await runningAnimations(page)).toEqual([])
    await page.unroute('**/rest/v1/schedule_exceptions*')

    // Pressing a button starts nothing either (E16 is off with reduced motion).
    await openPage(page, '/app/settings/closures', TEXT.closures)
    await page.getByRole('button', { name: TEXT.newClosure }).click()
    await expect(page.getByRole('dialog', { name: TEXT.newClosure })).toBeVisible()
    expect(await runningAnimations(page)).toEqual([])
  })
})
