import { randomUUID } from 'node:crypto'
import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { DEMO_BUSINESS_ID } from './seedUsers'

/**
 * Helpers of the booking e2e (step 1.3). The seed (supabase/seed.sql) and the local Edge
 * Function env (.env.example: ANAKLO_ENV=local, fake SMS adapter, OTP_TEST_NUMBERS with
 * OTP_TEST_CODE) are the contract; the texts are those of src/shared/i18n/el/booking.json.
 *
 * Parallel runs never fight over a time: each browser project books with its own staff member
 * (Chromium → Νίκος, WebKit → Άλεξ) and each test on its own day (`day` = the n-th bookable day
 * after today). Re-runs without `db:reset` take the next free time of that day.
 */
export const SHOP = {
  slug: 'demo-barber',
  name: 'Demo Barber',
  id: DEMO_BUSINESS_ID,
  phoneHref: 'tel:+302610000000',
  cutId: '00000000-0000-4000-8000-000000000301',
} as const

export const STAFF = {
  Νίκος: '00000000-0000-4000-8000-000000000101',
  Άλεξ: '00000000-0000-4000-8000-000000000102',
} as const
export type StaffName = keyof typeof STAFF

/** OTP_TEST_NUMBERS of .env.example, as a visitor types them. */
export const PHONES = {
  /** Γιώργος Π. and Μάριος Π. of the seed share it (family phone). */
  family: '6900000001',
  /** Κώστας Μ. of the seed. */
  kostas: '6900000002',
  /** No seed client (tests may have added one on earlier runs). */
  fresh: '6900000999',
} as const
export const OTP_TEST_CODE = '424242'

export const TEXT = {
  codeLabel: 'Κωδικός από το SMS',
  bookedTitle: 'Το ραντεβού κλείστηκε',
  bookAs: 'Κλείνεις ως',
  bookCta: 'Κλείσε το ραντεβού',
  manage: 'Αλλαγή ή ακύρωση',
} as const

export function staffFor(testInfo: TestInfo): StaffName {
  return testInfo.project.name.includes('safari') ? 'Άλεξ' : 'Νίκος'
}

export async function openShop(page: Page): Promise<void> {
  await page.goto(`/${SHOP.slug}`)
  await expect(page.getByRole('heading', { level: 1, name: SHOP.name })).toBeVisible()
}

/** «Κούρεμα 30′ · 13,00 €», not «Κούρεμα + γένια». */
export async function chooseService(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Κούρεμα\s*\d/ }).click()
}

export async function chooseStaff(page: Page, staff: StaffName): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${staff}`) }).click()
}

function todayInAthens(): string {
  // Playwright runs the pages in Europe/Athens (playwright.config.ts); so does the demo shop.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens' }).format(new Date())
}

/** Picks the `index`-th bookable day after today (today is skipped: minimum notice). */
export async function chooseDay(page: Page, index: number): Promise<string> {
  const today = todayInAthens()
  const strip = page.getByRole('group', { name: 'Ημερομηνίες' })
  let skipped = 0
  for (let window = 0; window < 5; window += 1) {
    await expect(page.getByRole('group', { name: /^Ελεύθερες ώρες/ })).toBeVisible()
    const days = strip.locator('button[data-date]:not([disabled])')
    const dates = (
      await days.evaluateAll((buttons) =>
        buttons.map((button) => (button as HTMLElement).dataset.date ?? ''),
      )
    ).filter((date) => date > today)
    if (index - skipped < dates.length) {
      const date = dates[index - skipped] ?? ''
      await strip.locator(`button[data-date="${date}"]`).click()
      await expect(strip.locator(`button[data-date="${date}"]`)).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      return date
    }
    skipped += dates.length
    await strip.getByRole('button', { name: 'Επόμενες ημέρες' }).click()
  }
  throw new Error(`no bookable day #${index}`)
}

export function times(page: Page) {
  return page.getByRole('group', { name: /^Ελεύθερες ώρες/ }).getByRole('button')
}

/** Taps a free time (the first by default); returns its label and instant. */
export async function chooseTime(page: Page, which: 'first' | 'last' = 'first') {
  const all = times(page)
  const button = which === 'first' ? all.first() : all.last()
  const label = (await button.textContent()) ?? ''
  const startsAt = (await button.getAttribute('data-starts-at')) ?? ''
  await button.click()
  await expect(
    page.getByRole('heading', { name: 'Σε ποιο κινητό να έρθει η επιβεβαίωση;' }),
  ).toBeVisible()
  return { label, startsAt }
}

export async function fillDetails(page: Page, name: string, phone: string): Promise<void> {
  await page.getByLabel('Ονοματεπώνυμο', { exact: true }).fill(name)
  await page.getByLabel('Κινητό', { exact: true }).fill(phone)
  await submitDetails(page)
}

/**
 * «Συνέχεια» on the details step; waits for the `start` answer. Parallel tests share the three
 * test numbers: the local seed sets the resend cooldown to 0, which 0005 treats as no cooldown
 * (also for a `start` that waited on the phone lock of another one).
 */
export async function submitDetails(page: Page): Promise<void> {
  await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith('/api/functions/v1/public-booking') &&
        candidate.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Συνέχεια' }).click(),
  ])
}

export async function enterCode(page: Page, code = OTP_TEST_CODE): Promise<void> {
  await page.getByLabel(TEXT.codeLabel, { exact: true }).fill(code)
}

/**
 * After the proof: books at once when the phone has no clients, otherwise the visitor confirms
 * the preselected choice (the first name typed). Ends on the confirmation.
 */
export async function finishBooking(page: Page): Promise<void> {
  const confirmed = page.getByRole('heading', { name: TEXT.bookedTitle })
  const choice = page.getByRole('heading', { name: TEXT.bookAs })
  await expect(confirmed.or(choice)).toBeVisible()
  if (await choice.isVisible()) await page.getByRole('button', { name: TEXT.bookCta }).click()
  await expect(confirmed).toBeVisible()
}

/** The whole flow up to the confirmation; returns the booked time and the manage link. */
export async function bookOnce(
  page: Page,
  options: { staff: StaffName; day: number; name: string; phone: string; code?: boolean },
) {
  await chooseService(page)
  await chooseStaff(page, options.staff)
  const date = await chooseDay(page, options.day)
  const time = await chooseTime(page)
  await fillDetails(page, options.name, options.phone)
  if (options.code !== false) await enterCode(page)
  await finishBooking(page)
  const manageHref =
    (await page.getByRole('link', { name: TEXT.manage }).getAttribute('href')) ?? ''
  expect(manageHref).toMatch(/^\/m\/[A-Za-z0-9_-]{22}$/)
  return { date, ...time, manageHref }
}

/** Books a time straight through /api (another visitor), as Κώστας with the test number. */
export async function bookViaApi(
  request: APIRequestContext,
  options: { staffId: string; startsAt: string },
): Promise<void> {
  const headers = { 'x-anaklo-business': SHOP.id }
  const base = { business_id: SHOP.id, phone: `+30${PHONES.kostas}` }
  const url = '/api/functions/v1/public-booking'
  const slot = { service_ids: [SHOP.cutId], staff_id: options.staffId, starts_at: options.startsAt }
  const start = await request.post(url, {
    headers,
    data: { action: 'start', ...base, locale: 'el', ...slot },
  })
  expect(start.status(), await start.text()).toBe(200)
  const { challenge_id } = (await start.json()) as { challenge_id: string }
  const verify = await request.post(url, {
    headers,
    data: { action: 'verify', ...base, challenge_id, code: OTP_TEST_CODE },
  })
  expect(verify.status(), await verify.text()).toBe(200)
  const { grant, clients } = (await verify.json()) as { grant: string; clients: { id: string }[] }
  const client = clients[0]
    ? { kind: 'existing', client_id: clients[0].id }
    : { kind: 'new', full_name: 'Κώστας' }
  const book = await request.post(url, {
    headers,
    data: {
      action: 'book',
      ...base,
      ...slot,
      idempotency_key: randomUUID(),
      locale: 'el',
      grant,
      client,
      marketing_box: 'not_shown',
    },
  })
  expect(book.status(), await book.text()).toBe(200)
}
