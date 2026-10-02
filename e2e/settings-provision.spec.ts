import { readFileSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { formatSummary, type Summary } from '../scripts/lib/provision-apply.mjs'
import { signInAal2 } from './lib/auth'
import { expect, test } from './lib/fixtures'
import { PROVISION_EXAMPLE_FILE, provisionLocal, type E2eShop } from './lib/shops'

// Exit criterion of step 1.6 (contract 1.6 §5.2): «the provisioning JSON and the screens describe
// the same shop». The synthetic example file is provisioned LOCALLY (slug `demo-provision`), the
// screens show its values, a round of edits made and reverted in the screens leaves the script
// with «No changes.», and a change made in a screen is the one change the script then writes
// back. Chromium only (one shop, one sequence). Needs `npm run db:start` + `npm run db:reset`.
// Since 1.7 the shop's owner signs in at `aal2` through the API (`signInAal2`: enrolled on first
// use, contract 1.7 §7.4).

test.describe.configure({ mode: 'serial', timeout: 150_000 })

const EXAMPLE: unknown = JSON.parse(readFileSync(PROVISION_EXAMPLE_FILE, 'utf8'))

let shop: E2eShop

test.beforeAll(async ({ browserName }) => {
  if (browserName !== 'chromium') return
  shop = (await provisionLocal(EXAMPLE)).shop
})

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== 'chromium', 'one shop, one sequence: Chromium only')
})

function idOf(record: Readonly<Record<string, string>>, name: string): string {
  const id = record[name]
  if (!id) throw new Error(`the provisioned shop has no "${name}"`)
  return id
}

async function openPage(page: Page, path: string, title: string): Promise<void> {
  await page.goto(path)
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
}

function serviceRow(page: Page, name: string): Locator {
  // The row's name is «Κούρεμα30′ · …» («Κούρεμα + γένια…» must not match «Κούρεμα»).
  return page
    .getByTestId('service-list')
    .getByRole('button', { name: new RegExp(`^${name}\\s?\\d`) })
}

/** One interval input of the week editor: «Σάββατο, διάστημα 1: από». */
function hoursInput(page: Page, day: string, index: number, end: 'από' | 'έως'): Locator {
  return page.getByLabel(`${day}, διάστημα ${index}: ${end}`, { exact: true })
}

async function saveHours(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Αποθήκευση' }).click()
  await expect(page.getByText('Το ωράριο αποθηκεύτηκε')).toBeVisible()
}

async function setHelperSaturdayEnd(page: Page, end: string): Promise<void> {
  await openPage(page, `/app/settings/hours?staff=${idOf(shop.staff, 'Βοηθός')}`, 'Ωράρια')
  await hoursInput(page, 'Σάββατο', 1, 'έως').fill(end)
  await saveHours(page)
}

async function setPrice(page: Page, service: string, price: string): Promise<void> {
  await openPage(page, '/app/settings/services', 'Υπηρεσίες')
  await serviceRow(page, service).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Τιμή', { exact: true }).fill(price)
  await dialog.getByRole('button', { name: 'Αποθήκευση' }).click()
  await expect(dialog.getByText('Η υπηρεσία αποθηκεύτηκε')).toBeVisible()
  await dialog.getByRole('button', { name: 'Τέλος' }).click()
}

async function setSlotStep(page: Page, step: string): Promise<void> {
  await openPage(page, '/app/settings/booking-policy', 'Πολιτική κρατήσεων')
  await page.getByLabel('Βήμα ωρών').selectOption(step)
  await page.getByRole('button', { name: 'Αποθήκευση' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Αποθηκεύτηκε' })).toBeVisible()
}

test.describe('provisioning JSON ⇄ settings screens', () => {
  test('the screens show every value of the file', async ({ page }) => {
    await signInAal2(page, shop.ownerEmail)

    // Services, in file order, with their terms; «Χρώμα γενιών» only in the shop.
    await openPage(page, '/app/settings/services', 'Υπηρεσίες')
    const rows = page.getByTestId('service-list').getByRole('button')
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(0)).toContainText(/Κούρεμα30′ · 13,00\s€/)
    await expect(rows.nth(1)).toContainText(/Κούρεμα \+ γένια45′ · 18,00\s€/)
    await expect(rows.nth(2)).toContainText(/Γένια15′ · 7,00\s€/)
    await expect(rows.nth(3)).toContainText(/Χρώμα γενιών20′ · 9,00\s€/)
    await expect(rows.nth(3)).toContainText('Μόνο στο κατάστημα')

    await serviceRow(page, 'Κούρεμα').click()
    let dialog = page.getByRole('dialog')
    for (const name of ['Σταύρος', 'Μάριος', 'Βοηθός']) {
      await expect(dialog.getByRole('checkbox', { name, exact: true })).toBeChecked()
    }
    await expect(dialog.getByLabel('Μάριος: δική του διάρκεια (λεπτά)')).toHaveValue('35')
    await dialog.getByRole('button', { name: 'Κλείσιμο' }).click()
    await serviceRow(page, 'Γένια').click()
    dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('checkbox', { name: 'Βοηθός', exact: true })).not.toBeChecked()
    await dialog.getByRole('button', { name: 'Κλείσιμο' }).click()

    // Staff in file order, with their colours.
    await openPage(page, '/app/settings/staff', 'Προσωπικό')
    const staff = page.getByTestId('staff-list').getByRole('button', { name: /^Επεξεργασία: / })
    await expect(staff).toHaveCount(3)
    const colours = [
      ['Σταύρος', '#2F6B5E'],
      ['Μάριος', '#8A5A44'],
      ['Βοηθός', '#4F7CAC'],
    ] as const
    for (const [index, [name, colour]] of colours.entries()) {
      await expect(staff.nth(index)).toHaveAccessibleName(`Επεξεργασία: ${name}`)
      const style = await staff.nth(index).locator('span').first().getAttribute('style')
      expect(style?.toLowerCase()).toContain(colour.toLowerCase())
    }

    // Weekly hours: Σταύρος Tue–Fri split, Mon and Sun closed; Μάριος Sat back to back.
    await openPage(page, `/app/settings/hours?staff=${idOf(shop.staff, 'Σταύρος')}`, 'Ωράρια')
    for (const day of ['Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή']) {
      await expect(hoursInput(page, day, 1, 'από')).toHaveValue('09:00')
      await expect(hoursInput(page, day, 1, 'έως')).toHaveValue('14:00')
      await expect(hoursInput(page, day, 2, 'από')).toHaveValue('17:00')
      await expect(hoursInput(page, day, 2, 'έως')).toHaveValue('21:00')
    }
    for (const day of ['Δευτέρα', 'Κυριακή']) {
      await expect(page.getByRole('region', { name: day })).toContainText('Κλειστό')
    }
    await openPage(page, `/app/settings/hours?staff=${idOf(shop.staff, 'Μάριος')}`, 'Ωράρια')
    await expect(hoursInput(page, 'Σάββατο', 1, 'από')).toHaveValue('09:00')
    await expect(hoursInput(page, 'Σάββατο', 1, 'έως')).toHaveValue('12:00')
    await expect(hoursInput(page, 'Σάββατο', 2, 'από')).toHaveValue('12:00')
    await expect(hoursInput(page, 'Σάββατο', 2, 'έως')).toHaveValue('16:00')

    // The booking policy: every value of the file.
    await openPage(page, '/app/settings/booking-policy', 'Πολιτική κρατήσεων')
    await expect(page.getByRole('switch', { name: /^Online κρατήσεις/ })).toBeChecked()
    await expect(page.getByLabel('Βήμα ωρών')).toHaveValue('15')
    await expect(page.getByLabel('Ελάχιστη προειδοποίηση')).toHaveValue('60')
    await expect(page.getByLabel('Ελάχιστη προειδοποίηση').locator('option:checked')).toHaveText(
      '1 ώρα',
    )
    await expect(page.getByLabel('Μέγιστη απόσταση (μέρες)')).toHaveValue('60')
    await expect(page.getByLabel('Ακύρωση από τον πελάτη έως')).toHaveValue('120')
    await expect(
      page.getByLabel('Ακύρωση από τον πελάτη έως').locator('option:checked'),
    ).toHaveText('2 ώρες')
    await expect(page.getByLabel('Αυτόματη ολοκλήρωση μετά από')).toHaveValue('720')
    await expect(
      page.getByLabel('Αυτόματη ολοκλήρωση μετά από').locator('option:checked'),
    ).toHaveText('12 ώρες')
    await expect(page.getByLabel('Διόρθωση από τον επαγγελματία (μέρες)')).toHaveValue('3')
    await expect(page.getByRole('switch', { name: /^«Οποιοσδήποτε»/ })).toBeChecked()
    await expect(page.getByRole('switch', { name: /^Υπενθυμίσεις με SMS/ })).toBeChecked()
    await expect(page.getByRole('radio', { name: '24 ώρες πριν' })).toBeChecked()
    await expect(page.getByLabel('Από', { exact: true })).toHaveValue('22:00')
    await expect(page.getByLabel('Έως', { exact: true })).toHaveValue('09:00')
  })

  test('edits made and reverted in the screens leave the script with «No changes.»', async ({
    page,
  }) => {
    await signInAal2(page, shop.ownerEmail)
    await setHelperSaturdayEnd(page, '15:00')
    await setHelperSaturdayEnd(page, '14:00')
    await setPrice(page, 'Γένια', '7,50')
    await setPrice(page, 'Γένια', '7,00')
    await setSlotStep(page, '30')
    await setSlotStep(page, '15')

    const summary: Summary = (await provisionLocal(EXAMPLE)).summary
    expect(summary.business).toBe('unchanged')
    for (const [name, count] of Object.entries(summary.counts)) {
      expect({
        name,
        created: count.created,
        updated: count.updated,
        removed: count.removed,
      }).toEqual({
        name,
        created: 0,
        updated: 0,
        removed: 0,
      })
    }
    expect(formatSummary(summary).at(-1)).toBe('No changes.')
  })

  test('a change made in a screen is the one change the script writes back', async ({ page }) => {
    await signInAal2(page, shop.ownerEmail)
    await setHelperSaturdayEnd(page, '15:00')

    const summary: Summary = (await provisionLocal(EXAMPLE)).summary
    expect(summary.business).toBe('unchanged')
    const changed = Object.entries(summary.counts)
      .filter(([, count]) => count.created + count.updated + count.removed > 0)
      .map(([name, { created, updated, removed }]) => ({ name, created, updated, removed }))
    expect(changed).toEqual([{ name: 'working_hours', created: 0, updated: 1, removed: 0 }])

    await page.reload()
    await expect(hoursInput(page, 'Σάββατο', 1, 'έως')).toHaveValue('14:00')
  })
})
