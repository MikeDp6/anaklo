import { randomUUID } from 'node:crypto'
import type { Page, TestInfo } from '@playwright/test'
import {
  addLocalDays,
  localDateTimeToInstant,
  toLocalDate,
  toLocalTime,
} from '../supabase/functions/_shared/dates.ts'
import { signInAal2 } from './lib/auth'
import { appointmentState, closeDb, messagesOf, timeOffOverlapping, waitForMessage } from './lib/db'
import { expect, test } from './lib/fixtures'
import { memberRest, memberRpc } from './lib/memberApi'
import { absenceShopFile, provisionLocal, type E2eShop } from './lib/shops'

// Step 1.6, flow 6 of SPEC §5 (contract 1.6 §6.6): a staff member is out today → one of their
// appointments goes to a free colleague at the same time, the other is cancelled with exactly
// one SMS (fake adapter: a `messages_log` row reaching `sent`, read through e2e/lib/db.ts).
// A dedicated synthetic shop per browser project (`absenceShopFile`: «Απών», «Βασίλης»,
// «Γιάννης»; «Κούρεμα» 30′ by all; every day 00:00-23:59; in Athens, or in New York late in the
// Athens evening, so the flow always has ≥ 2 h of its day left), provisioned LOCALLY. Needs
// `npm run db:start` + `npm run db:reset` and the dev server.
// Since 1.7 the shop's owner signs in at `aal2` through the API (`signInAal2`: enrolled on first
// use, contract 1.7 §7.4).

test.describe.configure({ mode: 'serial', timeout: 150_000 })

const MINUTE = 60_000
const TEXT = {
  entry: /^Έκτακτη απουσία/,
  title: 'Έκτακτη απουσία',
  who: 'Ποιος λείπει',
  submit: 'Καταχώρηση απουσίας',
  recorded: 'Η απουσία καταχωρήθηκε.',
  list: 'Ραντεβού που χρειάζονται αλλαγή',
  cancelWithSms: 'Ακύρωση με SMS',
  cancelled: 'Ακυρώθηκε',
  smsQueued: 'Ο πελάτης θα ενημερωθεί με SMS.',
  allDone: 'Όλα τα ραντεβού τακτοποιήθηκαν.',
} as const

function projectOf(testInfo: TestInfo): 'chrome' | 'safari' {
  return testInfo.project.name.includes('safari') ? 'safari' : 'chrome'
}

function zoneOf(file: unknown): string {
  if (typeof file === 'object' && file !== null && 'business' in file) {
    const business: unknown = file.business
    if (typeof business === 'object' && business !== null && 'timezone' in business) {
      if (typeof business.timezone === 'string') return business.timezone
    }
  }
  throw new Error('the absence shop file has no business.timezone')
}

function idOf(record: Readonly<Record<string, string>>, name: string): string {
  const id = record[name]
  if (!id) throw new Error(`the e2e shop has no "${name}"`)
  return id
}

let shop: E2eShop
let zone: string

// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, testInfo) => {
  const file = absenceShopFile(projectOf(testInfo))
  zone = zoneOf(file)
  shop = (await provisionLocal(file)).shop
})

test.afterAll(async () => {
  await closeDb()
})

/** The first start on the local 30′ grid at or after `instant`, or null past today. */
function gridStart(instant: Date, today: string): Date | null {
  const [hours = 0, minutes = 0] = toLocalTime(instant, zone).split(':').map(Number)
  const rounded = Math.ceil((hours * 60 + minutes) / 30) * 30
  if (toLocalDate(instant, zone) !== today || rounded >= 24 * 60) return null
  const hm = `${String(Math.floor(rounded / 60)).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`
  return localDateTimeToInstant(today, hm, zone)
}

/** Today's bounds in the shop's zone. */
function todayBounds(now: Date) {
  const today = toLocalDate(now, zone)
  return {
    today,
    from: localDateTimeToInstant(today, '00:00', zone),
    to: localDateTimeToInstant(addLocalDays(today, 1), '00:00', zone),
  }
}

/** The shop's time off goes, and every booked appointment of today is cancelled (no SMS). */
async function cleanUp(page: Page, now: Date): Promise<void> {
  const deleted = await memberRest(page, 'DELETE', `time_off?business_id=eq.${shop.businessId}`)
  expect(deleted.status, JSON.stringify(deleted.body)).toBeLessThan(300)
  const { from, to } = todayBounds(now)
  const { body } = await memberRest(
    page,
    'GET',
    `appointments?business_id=eq.${shop.businessId}&status=in.(booked,confirmed)` +
      `&starts_at=gte.${from.toISOString()}&starts_at=lt.${to.toISOString()}&select=id,status`,
  )
  for (const row of Array.isArray(body) ? (body as { id: string; status: string }[]) : []) {
    // Best effort: a leftover that cannot be cancelled any more does not block today's times.
    await memberRest(page, 'POST', 'rpc/cancel_appointment', {
      p_business_id: shop.businessId,
      p_appointment_id: row.id,
      p_from_status: row.status,
      p_reason: 'other',
      p_notify: false,
    })
  }
}

/** A phone booking by the owner for a new client with a Greek mobile; returns its id. */
async function book(page: Page, staff: string, startsAt: Date, client: string, phone: string) {
  const result = await memberRpc(page, 'staff_book_appointment', {
    p_business_id: shop.businessId,
    p_service_ids: [idOf(shop.services, 'Κούρεμα')],
    p_staff_id: idOf(shop.staff, staff),
    p_starts_at: startsAt.toISOString(),
    p_source: 'phone',
    p_idempotency_key: randomUUID(),
    p_allow_outside_hours: false,
    p_allow_buffer_overlap: false,
    p_new_client: { full_name: client, phone_e164: phone, locale: 'el' },
  })
  if (typeof result !== 'object' || result === null || !('appointment_id' in result)) {
    throw new Error(`booking failed: ${JSON.stringify(result)}`)
  }
  return String(result.appointment_id)
}

test('flow 6: one appointment to a free colleague, one cancelled with exactly one SMS', async ({
  page,
}, testInfo) => {
  const now = new Date()
  const { today, to: midnight } = todayBounds(now)
  // Never true in practice: absenceShopFile picks a zone with ≥ 3 h left (D19).
  test.skip(midnight.getTime() - now.getTime() < 120 * MINUTE, 'less than 2 h left today (D19)')
  // T1 ≥ now + 20′ on the 30′ grid, T2 = T1 + 60′; both end within today's 00:00–23:59 hours.
  const t1 = gridStart(new Date(now.getTime() + 20 * MINUTE), today)
  const t2 = t1 && new Date(t1.getTime() + 60 * MINUTE)
  const lastEnd = localDateTimeToInstant(today, '23:59', zone)
  test.skip(
    !t1 || !t2 || t2.getTime() + 30 * MINUTE > lastEnd.getTime(),
    'T2 would end after the shop’s day (D19)',
  )
  if (!t1 || !t2) return
  const project = projectOf(testInfo)
  const phone = (n: number) =>
    `+3069000${project === 'chrome' ? '11' : '12'}${String(n).padStart(3, '0')}`
  const absent = idOf(shop.staff, 'Απών')
  const vasilis = idOf(shop.staff, 'Βασίλης')

  await signInAal2(page, shop.ownerEmail)
  await cleanUp(page, now)
  const first = await book(page, 'Απών', t1, `Ε2Ε Πρώτος ${project}`, phone(1))
  const second = await book(page, 'Απών', t2, `Ε2Ε Δεύτερος ${project}`, phone(2))
  await book(page, 'Βασίλης', t2, `Ε2Ε Τρίτος ${project}`, phone(3))
  await book(page, 'Γιάννης', t2, `Ε2Ε Τέταρτος ${project}`, phone(4))

  // Ρυθμίσεις → «Έκτακτη απουσία» → «Απών» → «Καταχώρηση απουσίας».
  await page.goto('/app/settings')
  await page.getByRole('link', { name: TEXT.entry }).click()
  await expect(page.getByRole('heading', { level: 1, name: TEXT.title })).toBeVisible()
  await page.getByLabel(TEXT.who).selectOption({ label: 'Απών' })
  await page.getByRole('button', { name: TEXT.submit }).click()
  await expect(page.getByText(TEXT.recorded)).toBeVisible()
  const rows = page.getByRole('list', { name: TEXT.list }).getByRole('article')
  await expect(rows).toHaveCount(2)

  // T1: a colleague is free at the same time; the SMS toggle stays off (D10).
  const t1Label = toLocalTime(t1, zone)
  const t1Row = page.getByRole('article', { name: new RegExp(`^${t1Label} `) })
  const reassign = t1Row.getByRole('group', { name: 'Ανάθεση σε συνάδελφο' })
  await expect(reassign.getByRole('checkbox', { name: /Ενημέρωση με SMS/ })).not.toBeChecked()
  await reassign.getByRole('button', { name: 'Ανάθεση: Βασίλης' }).click()
  await expect(t1Row.getByText('Ανατέθηκε: Βασίλης')).toBeVisible()

  // T2: both colleagues are booked; only the cancellation with SMS remains.
  const t2Label = toLocalTime(t2, zone)
  const t2Row = page.getByRole('article', { name: new RegExp(`^${t2Label} `) })
  await expect(
    t2Row.getByText(`Κανένας συνάδελφος δεν είναι ελεύθερος στις ${t2Label}.`),
  ).toBeVisible()
  await t2Row.getByRole('button', { name: TEXT.cancelWithSms }).click()
  await expect(t2Row.getByText(TEXT.cancelled, { exact: true })).toBeVisible()
  await expect(t2Row.getByText(TEXT.smsQueued)).toBeVisible()
  await expect(page.getByText(TEXT.allDone)).toBeVisible()

  // The database (read-only): the move kept the time, the cancel has the neutral reason, and
  // exactly one SMS went out for the two appointments.
  const moved = await appointmentState(first)
  expect(moved).toMatchObject({ status: 'booked', staff_id: vasilis })
  expect(Date.parse(moved.starts_at)).toBe(t1.getTime())
  expect(await appointmentState(second)).toMatchObject({
    status: 'cancelled',
    cancel_reason: 'staff_unavailable',
  })
  const sent = await waitForMessage(second, 'cancelled_by_business')
  expect(sent).toMatchObject({ channel: 'sms', status: 'sent', provider: 'fake' })
  const sms = [...(await messagesOf(first)), ...(await messagesOf(second))].filter(
    (row) => row.channel === 'sms',
  )
  expect(sms.map((row) => row.template)).toEqual(['cancelled_by_business'])
  const { from, to } = todayBounds(now)
  const timeOff = await timeOffOverlapping(absent, from.toISOString(), to.toISOString())
  expect(timeOff).toHaveLength(1)
  expect(timeOff[0]).toMatchObject({ reason: 'leave' })

  await cleanUp(page, now)
})
