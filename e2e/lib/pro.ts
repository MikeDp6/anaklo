import {
  expect,
  type Browser,
  type BrowserContextOptions,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { localSupabase } from '../../scripts/lib/cli.mjs'
import { localDateTimeToInstant, toLocalDate } from '../../supabase/functions/_shared/dates.ts'
import { SHOP, STAFF, type StaffName } from './booking'
import type { DeviceOptions } from './fixtures'

/**
 * Helpers of the pro-app e2e (step 1.4). Texts are those of src/shared/i18n/el/pro.json; the data
 * is the seed (demo-barber, Νίκος/Άλεξ, «Κούρεμα», «Γένια», the client «Κώστας Μ.»).
 *
 * Parallel runs never fight over a time: each browser project works with its own staff member
 * (`staffFor` of ./booking: Chromium → Νίκος, WebKit → Άλεξ) and each spec books in its own
 * window of days (`window` = how many 5-day steps after today), far from the booking-page specs.
 */
export const PRO_TEXT = {
  todayTitle: 'Σήμερα',
  dayTitle: 'Ημερολόγιο',
  newAppointment: 'Νέο ραντεβού',
  search: 'Αναζήτηση πελάτη',
  newClient: 'Νέος πελάτης',
  fullName: 'Ονοματεπώνυμο',
  phone: 'Κινητό',
  continue: 'Συνέχεια',
  book: 'Κλείσε το ραντεβού',
  booked: 'Το ραντεβού κλείστηκε',
  done: 'Τέλος',
  close: 'Κλείσιμο',
  dates: 'Ημερομηνίες',
  laterDays: 'Επόμενες ημέρες',
  noTimes: 'Καμία ελεύθερη ώρα αυτή τη μέρα. Διάλεξε άλλη μέρα.',
  move: 'Μετακίνηση',
  moveHere: 'Μετακίνηση εδώ',
  moved: 'Το ραντεβού μετακινήθηκε',
  noShow: 'Δεν ήρθε',
  cancel: 'Ακύρωση',
  cancelSubmit: 'Ακύρωση ραντεβού',
  cancelled: 'Το ραντεβού ακυρώθηκε',
  walkInStart: 'Ξεκίνα τώρα',
  walkInDone: 'Το walk-in καταχωρήθηκε',
  walkInAnonymous: 'Walk-in χωρίς όνομα',
  d8Outside: 'Ναι, εκτός ωραρίου',
  d8Buffer: 'Ναι, στρίμωξέ το',
} as const

export function freeTimes(page: Page): Locator {
  return page.getByRole('group', { name: /^Ελεύθερες ώρες/ }).getByRole('button')
}

/** The sheet (native <dialog>) that is open now. */
export function sheet(page: Page): Locator {
  return page.getByRole('dialog')
}

export async function openToday(page: Page): Promise<void> {
  await page.goto('/app')
  await expect(page.getByRole('heading', { level: 1, name: PRO_TEXT.todayTitle })).toBeVisible()
}

export async function openQuickAdd(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: PRO_TEXT.newAppointment, exact: true }).click()
  const dialog = sheet(page)
  await expect(dialog.getByLabel(PRO_TEXT.search)).toBeVisible()
  return dialog
}

/**
 * In the slot picker: moves `window` five-day steps ahead, then takes the first day of that window
 * that has free times (closed days show «Καμία ελεύθερη ώρα»). Returns the chosen date.
 */
export async function chooseDayWithTimes(scope: Locator, window: number): Promise<string> {
  const strip = scope.getByRole('group', { name: PRO_TEXT.dates })
  for (let step = 0; step < window; step += 1) {
    await strip.getByRole('button', { name: PRO_TEXT.laterDays }).click()
  }
  const days = strip.locator('button[data-date]')
  const count = await days.count()
  for (let index = 0; index < count; index += 1) {
    const day = days.nth(index)
    await day.click()
    await expect(day).toHaveAttribute('aria-pressed', 'true')
    const times = scope.getByRole('group', { name: /^Ελεύθερες ώρες/ }).getByRole('button')
    const none = scope.getByText(PRO_TEXT.noTimes)
    await expect(times.first().or(none)).toBeVisible()
    if (await times.first().isVisible()) return (await day.getAttribute('data-date')) ?? ''
  }
  throw new Error(`no day with free times in window ${window}`)
}

/** Taps a free time (first or last) of the chosen day; returns its label and instant. */
export async function chooseTime(scope: Locator, which: 'first' | 'last' = 'first') {
  const times = scope.getByRole('group', { name: /^Ελεύθερες ώρες/ }).getByRole('button')
  const button = which === 'first' ? times.first() : times.last()
  const label = ((await button.textContent()) ?? '').trim()
  const startsAt = (await button.getAttribute('data-starts-at')) ?? ''
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  return { label, startsAt }
}

/** Quick add with a NEW client (unique name, no phone) for `staff`, in day window `window`. */
export async function quickAddNewClient(
  page: Page,
  options: { name: string; staff: StaffName; window: number; service?: RegExp },
) {
  const dialog = await openQuickAdd(page)
  await dialog.getByRole('button', { name: PRO_TEXT.newClient }).click()
  await dialog.getByLabel(PRO_TEXT.fullName).fill(options.name)
  await dialog.getByRole('button', { name: PRO_TEXT.continue }).click()
  await dialog.getByRole('button', { name: options.service ?? /^Κούρεμα\s*\d/ }).click()
  await dialog.getByRole('button', { name: options.staff, exact: true }).click()
  const date = await chooseDayWithTimes(dialog, options.window)
  const time = await chooseTime(dialog)
  await dialog.getByRole('button', { name: PRO_TEXT.book }).click()
  await expect(dialog.getByRole('img', { name: PRO_TEXT.booked })).toBeVisible()
  await dialog.getByRole('button', { name: PRO_TEXT.done }).click()
  await expect(dialog).toHaveCount(0)
  return { date, ...time }
}

/** The appointment button of the day view whose label contains `text`. */
export function dayAppointment(page: Page, text: string | RegExp): Locator {
  return page.getByTestId('day-view').getByRole('button', { name: text })
}

/** Confirms the D8 question (outside the hours / in a buffer) if the server asked it. */
export async function confirmD8IfAsked(scope: Locator, success: Locator): Promise<void> {
  const outside = scope.getByRole('button', { name: PRO_TEXT.d8Outside })
  const buffer = scope.getByRole('button', { name: PRO_TEXT.d8Buffer })
  await expect(success.or(outside).or(buffer)).toBeVisible()
  if (await outside.isVisible()) await outside.click()
  await expect(success.or(buffer)).toBeVisible()
  if (await buffer.isVisible()) await buffer.click()
  await expect(success).toBeVisible()
}

/**
 * A second browser context with the same device as the test's project (viewport, touch, user
 * agent, locale, zone, base URL) and, for the WebKit project, the installed-app pretence of
 * ./fixtures (`navigator.standalone`), so /app does not stop at the iOS install screen.
 */
export async function newDeviceContext(browser: Browser, testInfo: TestInfo) {
  const use = testInfo.project.use as DeviceOptions & BrowserContextOptions
  const context = await browser.newContext({
    baseURL: use.baseURL,
    locale: use.locale,
    timezoneId: use.timezoneId,
    viewport: use.viewport,
    userAgent: use.userAgent,
    deviceScaleFactor: use.deviceScaleFactor,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
  })
  if (use.standalone) {
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'standalone', {
        configurable: true,
        get: () => true,
      })
    })
  }
  return context
}

// ---------------------------------------------------------------------------------------------
// Straight calls to the LOCAL stack as the member signed in on a page (for set-ups the UI cannot
// make, e.g. an appointment earlier today). `localSupabase()` reads `supabase status` and refuses
// any non-local API URL; the access token is the pro app's own session in the page, so the calls
// go through RLS and the RPC role checks like the app's.
// ---------------------------------------------------------------------------------------------

let stack: ReturnType<typeof localSupabase> | undefined

async function memberRequest(page: Page, path: string, data?: unknown) {
  stack ??= localSupabase()
  const token = await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (!/^sb-.+-auth-token$/.test(key)) continue
      const session: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
      if (typeof session === 'object' && session !== null && 'access_token' in session) {
        return typeof session.access_token === 'string' ? session.access_token : null
      }
    }
    return null
  })
  if (!token) throw new Error('no pro-app session in the page: sign in first')
  const headers = { apikey: stack.publishableKey, authorization: `Bearer ${token}` }
  const url = `${stack.apiUrl}/rest/v1/${path}`
  const response =
    data === undefined
      ? await page.request.get(url, { headers })
      : await page.request.post(url, { headers, data })
  return { status: response.status(), body: (await response.json()) as unknown }
}

/**
 * A priced appointment («Κούρεμα») TODAY for `staff`, booked by the signed-in owner/manager as an
 * anonymous walk-in at a time at least 2h away from now (outside the hours: no other e2e books
 * today there; the walk-in specs book NOW). Returns its id; `cancelTodayBooking` frees it.
 */
export async function bookTodayViaApi(page: Page, staff: StaffName): Promise<string> {
  const zone = 'Europe/Athens' // the demo shop's zone (seed), as in ./booking
  const now = new Date()
  const today = toLocalDate(now, zone)
  const candidates = (['23:30', '23:00', '22:30', '00:00', '00:30', '01:00'] as const)
    .map((time) => localDateTimeToInstant(today, time, zone))
    .filter((instant) => Math.abs(instant.getTime() - now.getTime()) >= 2 * 60 * 60 * 1000)
  for (const startsAt of candidates) {
    const { status, body } = await memberRequest(page, 'rpc/staff_book_appointment', {
      p_business_id: SHOP.id,
      p_service_ids: [SHOP.cutId],
      p_staff_id: STAFF[staff],
      p_starts_at: startsAt.toISOString(),
      p_source: 'walkin',
      p_idempotency_key: randomUUID(),
      p_allow_outside_hours: true,
      p_allow_buffer_overlap: true,
    })
    if (status === 200 && typeof body === 'object' && body !== null && 'appointment_id' in body) {
      return String(body.appointment_id)
    }
    // AN001: that time is taken (an earlier run that did not clean up): the next one.
    if (!JSON.stringify(body).includes('AN001')) {
      throw new Error(`booking for today failed (${status}): ${JSON.stringify(body)}`)
    }
  }
  throw new Error('no free time today for the set-up booking')
}

/** Cancels it from whatever status it has now (auto-complete may have completed it). */
export async function cancelTodayBooking(page: Page, appointmentId: string): Promise<void> {
  const { body } = await memberRequest(page, `appointments?id=eq.${appointmentId}&select=status`)
  const status = Array.isArray(body) ? (body[0] as { status?: unknown } | undefined)?.status : null
  if (typeof status !== 'string' || status === 'cancelled') return
  const cancel = await memberRequest(page, 'rpc/cancel_appointment', {
    p_business_id: SHOP.id,
    p_appointment_id: appointmentId,
    p_from_status: status,
    p_reason: 'other',
    p_notify: false,
  })
  expect(cancel.status, JSON.stringify(cancel.body)).toBe(200)
}
