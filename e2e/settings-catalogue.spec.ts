import type { Locator, Page, TestInfo } from '@playwright/test'
import { addLocalDays, toLocalDate, weekdayOf } from '../supabase/functions/_shared/dates.ts'
import { expect, test } from './lib/fixtures'
import { signInWithEmailCode } from './lib/login'
import { memberRpc } from './lib/memberApi'
import { provisionLocal, settingsShopFile, type E2eShop } from './lib/shops'

// Step 1.6, contract §6.6: the catalogue screens of the pro app (services, staff, week hours) on
// a dedicated synthetic shop per browser project (`settingsShopFile(project, 'catalogue')`:
// staff «Ε2Ε Α», «Ε2Ε Β»; «Κούρεμα» 30′ / 13,00 € by both; Tue–Sat 10:00-18:00), provisioned
// LOCALLY before the tests (idempotent: a re-run resets hours and order to the file). Needs
// `npm run db:start` + `npm run db:reset` and the dev server. Texts: src/shared/i18n/el/pro.json.

test.describe.configure({ mode: 'serial', timeout: 120_000 })

const TEXT = {
  services: 'Υπηρεσίες',
  newService: 'Νέα υπηρεσία',
  staffTitle: 'Προσωπικό',
  hoursTitle: 'Ωράρια',
  save: 'Αποθήκευση',
  done: 'Τέλος',
  serviceSaved: 'Η υπηρεσία αποθηκεύτηκε',
  hoursSaved: 'Το ωράριο αποθηκεύτηκε',
  servicesLoading: 'Φόρτωση υπηρεσιών…',
  staffLoading: 'Φόρτωση προσωπικού…',
  hoursLoading: 'Φόρτωση ωραρίου…',
  inactiveGroup: 'Ανενεργές',
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
  const file = settingsShopFile(projectOf(testInfo), 'catalogue')
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

/** Names of the staff rows in their order on screen. */
async function staffOrder(page: Page): Promise<string[]> {
  const rows = page.getByTestId('staff-list').getByRole('button', { name: /^Επεξεργασία: / })
  return (
    await rows.evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')))
  ).map((label) => (label ?? '').replace('Επεξεργασία: ', ''))
}

/** The next Tuesday after today, in the shop's zone. */
function nextTuesday(): string {
  const today = toLocalDate(new Date(), zone)
  const ahead = (2 - weekdayOf(today) + 7) % 7 || 7
  return addLocalDays(today, ahead)
}

async function openPage(page: Page, path: string, title: string): Promise<void> {
  await page.goto(path)
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
}

function serviceRow(page: Page, name: string): Locator {
  return page.getByTestId('service-list').getByRole('button', { name: new RegExp(`^${name}`) })
}

test.describe('pro app: catalogue settings', () => {
  test('the owner adds a service with a staff member’s own terms; the booking page offers it', async ({
    page,
    request,
  }) => {
    const name = `Ε2Ε Ξύρισμα ${Date.now().toString(36)}`
    await signInWithEmailCode(page, shop.ownerEmail)
    await openPage(page, '/app/settings/services', TEXT.services)
    await page.getByRole('button', { name: TEXT.newService }).click()

    const dialog = page.getByRole('dialog', { name: TEXT.newService })
    await dialog.getByLabel('Όνομα', { exact: true }).fill(name)
    await dialog.getByLabel('Διάρκεια (λεπτά)', { exact: true }).fill('25')
    await dialog.getByLabel('Τιμή', { exact: true }).fill('11,00')
    // A new service is offered by every active staff member.
    await expect(dialog.getByRole('checkbox', { name: 'Ε2Ε Α' })).toBeChecked()
    await expect(dialog.getByRole('checkbox', { name: 'Ε2Ε Β' })).toBeChecked()
    await dialog.getByLabel('Ε2Ε Β: δική του διάρκεια (λεπτά)').fill('30')
    await dialog.getByLabel('Ε2Ε Β: δική του τιμή').fill('12,00')
    await dialog.getByRole('button', { name: TEXT.save }).click()
    await expect(dialog.getByText(TEXT.serviceSaved)).toBeVisible()
    await dialog.getByRole('button', { name: TEXT.done }).click()
    await expect(serviceRow(page, name)).toContainText(/25′ · 11,00\s€/)

    // The booking page (anon, through /api) offers it with each staff member's terms.
    const response = await request.post('/api/rest/v1/rpc/public_booking_catalogue', {
      data: { p_slug: shop.slug },
    })
    expect(response.status(), await response.text()).toBe(200)
    const catalogue = (await response.json()) as {
      services: { id: string; name: string; duration_min: number; price_cents: number }[]
      staff: {
        id: string
        services: { service_id: string; duration_min: number; price_cents: number }[]
      }[]
    }
    const added = catalogue.services.find((service) => service.name === name)
    expect(added).toMatchObject({ duration_min: 25, price_cents: 1100 })
    const termsOf = (staffName: string) =>
      catalogue.staff
        .find((member) => member.id === idOf(shop.staff, staffName))
        ?.services.find((terms) => terms.service_id === added?.id)
    expect(termsOf('Ε2Ε Α')).toMatchObject({ duration_min: 25, price_cents: 1100 })
    expect(termsOf('Ε2Ε Β')).toMatchObject({ duration_min: 30, price_cents: 1200 })

    // Clean-up through the same sheet: deactivated, it leaves the booking page.
    await serviceRow(page, name).click()
    const edit = page.getByRole('dialog', { name: 'Επεξεργασία υπηρεσίας' })
    await edit.getByRole('switch', { name: 'Ενεργή' }).click()
    await edit.getByRole('button', { name: TEXT.save }).click()
    await expect(edit.getByText(TEXT.serviceSaved)).toBeVisible()
    await edit.getByRole('button', { name: TEXT.done }).click()
    await expect(
      page.getByRole('region', { name: TEXT.inactiveGroup }).getByRole('button', {
        name: new RegExp(`^${name}`),
      }),
    ).toBeVisible()
  })

  test('a split shift: Tuesday 09:00–14:00 + 17:00–21:00, and the free times follow', async ({
    page,
  }) => {
    const staffId = idOf(shop.staff, 'Ε2Ε Α')
    await signInWithEmailCode(page, shop.ownerEmail)
    await openPage(page, `/app/settings/hours?staff=${staffId}`, TEXT.hoursTitle)
    await expect(page.getByRole('button', { name: 'Ε2Ε Α', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await page.getByLabel('Τρίτη, διάστημα 1: από').fill('09:00')
    await page.getByLabel('Τρίτη, διάστημα 1: έως').fill('14:00')
    await page.getByRole('button', { name: 'Προσθήκη διαστήματος: Τρίτη' }).click()
    await page.getByLabel('Τρίτη, διάστημα 2: από').fill('17:00')
    await page.getByLabel('Τρίτη, διάστημα 2: έως').fill('21:00')
    await page.getByRole('button', { name: TEXT.save, exact: true }).click()
    await expect(page.getByText(TEXT.hoursSaved)).toBeVisible()

    const tuesday = nextTuesday()
    const slots = (await memberRpc(page, 'staff_available_slots', {
      p_business_id: shop.businessId,
      p_service_ids: [idOf(shop.services, 'Κούρεμα')],
      p_staff_id: staffId,
      p_from: tuesday,
      p_to: tuesday,
    })) as { local_time: string }[]
    const times = slots.map((slot) => slot.local_time.slice(0, 5))
    expect(times).toContain('09:00')
    expect(times).toContain('17:00')
    expect(times.filter((time) => time >= '14:00' && time < '17:00')).toEqual([])

    // After a reload the editor shows what the server stored.
    await page.reload()
    await expect(page.getByLabel('Τρίτη, διάστημα 2: από')).toHaveValue('17:00')
  })

  test('reorder: «Ε2Ε Β» first after ▲, also after a reload', async ({ page }) => {
    await signInWithEmailCode(page, shop.ownerEmail)
    await openPage(page, '/app/settings/staff', TEXT.staffTitle)
    await expect.poll(() => staffOrder(page)).toEqual(['Ε2Ε Α', 'Ε2Ε Β'])
    await page.getByRole('button', { name: 'Μετακίνηση πάνω: Ε2Ε Β' }).click()
    await expect.poll(() => staffOrder(page)).toEqual(['Ε2Ε Β', 'Ε2Ε Α'])
    await page.reload()
    await expect.poll(() => staffOrder(page)).toEqual(['Ε2Ε Β', 'Ε2Ε Α'])
  })
})

test.describe('catalogue settings with reduced motion', () => {
  test('nothing moves on Services, Staff and Hours: not while loading, not after a press', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await signInWithEmailCode(page, shop.ownerEmail)

    const screens = [
      {
        path: '/app/settings/services',
        api: /\/rest\/v1\/services\?/,
        loading: TEXT.servicesLoading,
      },
      { path: '/app/settings/staff', api: /\/rest\/v1\/staff\?/, loading: TEXT.staffLoading },
      {
        path: `/app/settings/hours?staff=${idOf(shop.staff, 'Ε2Ε Α')}`,
        api: /\/rest\/v1\/working_hours\?/,
        loading: TEXT.hoursLoading,
      },
    ] as const
    for (const screen of screens) {
      // Hold the screen's read so its E17 skeleton shows.
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      await page.route(screen.api, async (route) => {
        await held
        await route.continue()
      })
      await page.goto(screen.path)
      await expect(page.getByText(screen.loading)).toBeAttached()
      expect(await runningAnimations(page), `${screen.path} while loading`).toEqual([])
      release()
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
      await page.unroute(screen.api)
      expect(await runningAnimations(page), screen.path).toEqual([])
    }

    // A press (E16) does not animate either: the hours page's «Αποθήκευση».
    await page.getByRole('button', { name: TEXT.save, exact: true }).click()
    await expect(page.getByText(TEXT.hoursSaved)).toBeVisible()
    expect(await runningAnimations(page)).toEqual([])
  })

  test('loading the services never shifts the layout', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'layout-shift entries exist only in Chromium')
    await page.addInitScript(() => {
      const shifts: number[] = []
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & {
          value: number
          hadRecentInput: boolean
        })[]) {
          if (!entry.hadRecentInput) shifts.push(entry.value)
        }
      })
      observer.observe({ type: 'layout-shift', buffered: true })
      Object.assign(window, { __shifts: shifts })
    })
    await signInWithEmailCode(page, shop.ownerEmail)
    await openPage(page, '/app/settings/services', TEXT.services)
    await expect(page.getByTestId('service-list')).toBeVisible()
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
    const cls = await page.evaluate(() =>
      (window as unknown as { __shifts: number[] }).__shifts.reduce((sum, v) => sum + v, 0),
    )
    expect(cls).toBeLessThan(0.02)
  })
})
