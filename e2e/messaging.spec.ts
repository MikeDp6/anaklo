import type { Page } from '@playwright/test'
import { userIdOf } from './lib/auth'
import { engineOf, setupOwnerEmail } from './lib/authPaths'
import { bookViaApi, freeStartViaApi, STAFF, staffFor } from './lib/booking'
import { appointmentAt, closeDb, messagesOf, waitForMessage } from './lib/db'
import { expect, test } from './lib/fixtures'
import { signInWithEmailCode } from './lib/login'
import { chooseDayWithTimes, chooseTime, openQuickAdd, openToday, PRO_TEXT, sheet } from './lib/pro'
import { SEED_USERS } from './lib/seedUsers'

// Step 1.5, contract 1.5 §5.6: messages and staff push, LOCALLY (fake SMS adapter, fake push
// sender: a "sent" message is a `messages_log` row with `provider 'fake'`, read through the
// `docker exec` psql session of e2e/lib/db.ts). Needs `npm run db:start` + `npm run db:reset`
// (the seed registers synthetic push devices for the owner …a001 and Άλεξ …a003, and the Vault
// URL of `dispatch` that the database reaches through pg_net: http://kong:8000).
// Each browser project works with its own staff member (Chromium → Νίκος = the owner's staff row,
// WebKit → Άλεξ), on days far from the other specs.
// Since 1.7 the pro app's owner is the engine's setup owner at `aal2` (`member: 'owner'`,
// contract 1.7 §7.4): an owner of demo-barber without a staff row and without push devices.

test.describe.configure({ timeout: 120_000 })

test.afterAll(async () => {
  await closeDb()
})

const OWNER = SEED_USERS.owner.id

test.describe('messages of a booking', () => {
  test('the client cancels with the link → SMS rows and a recorded (fake) push', async ({
    page,
    request,
  }, testInfo) => {
    const staff = staffFor(testInfo)
    const startsAt = await freeStartViaApi(request, { staffId: STAFF[staff], fromDays: 45 })
    const { appointmentId, manageToken } = await bookViaApi(request, {
      staffId: STAFF[staff],
      startsAt,
    })

    // Online booking: the confirmation always (ADR-0006), and a push to the staff member's user
    // and to every owner (the owner …a001 in both projects), by the fake sender.
    const confirmed = await waitForMessage(appointmentId, 'booking_confirmed')
    expect(confirmed).toMatchObject({ channel: 'sms', status: 'sent', provider: 'fake' })
    const created = await waitForMessage(appointmentId, 'push_booking_created', {
      recipient: OWNER,
    })
    expect(created).toMatchObject({ channel: 'push', status: 'sent', provider: 'fake' })
    expect(created.provider_message_id).toMatch(/^fake-push-/)

    await page.goto(`/m/${manageToken}`)
    await page.getByRole('button', { name: 'Ακύρωση ραντεβού' }).click()
    await page.getByRole('button', { name: 'Ναι, ακύρωσε' }).click()
    await expect(page.getByRole('heading', { name: 'Το ραντεβού ακυρώθηκε' })).toBeVisible()

    const cancelled = await waitForMessage(appointmentId, 'cancelled_by_client')
    expect(cancelled).toMatchObject({ channel: 'sms', status: 'sent', provider: 'fake' })
    const pushed = await waitForMessage(appointmentId, 'push_booking_cancelled', {
      recipient: OWNER,
    })
    expect(pushed).toMatchObject({ channel: 'push', status: 'sent', provider: 'fake' })
    expect(pushed.provider_message_id).toMatch(/^fake-push-/)

    // Booked ≥ 26 h ahead, so a reminder was planned; the cancel superseded it before its time.
    const reminder = (await messagesOf(appointmentId)).find((row) => row.template === 'reminder')
    if (reminder) expect(reminder).toMatchObject({ status: 'cancelled', error: 'superseded' })
  })

  test.describe('by the owner in the pro app', () => {
    test.use({ member: 'owner' })

    test('staff cancel with SMS reaches the fake adapter through the database (pg_net → dispatch)', async ({
      page,
    }, testInfo) => {
      const staff = staffFor(testInfo)
      await openToday(page)

      // A phone booking for Κώστας Μ. (seed client with a mobile number), far ahead.
      const dialog = await openQuickAdd(page)
      await dialog.getByLabel(PRO_TEXT.search).fill('κωστα')
      await dialog
        .getByRole('button', { name: /^Κώστας Μ\./ })
        .first()
        .click()
      await dialog.getByRole('button', { name: /^Κούρεμα\s*\d/ }).click()
      await dialog.getByRole('button', { name: staff, exact: true }).click()
      const date = await chooseDayWithTimes(dialog, 7)
      const time = await chooseTime(dialog, 'last')
      await dialog.getByRole('button', { name: PRO_TEXT.book }).click()
      await expect(dialog.getByRole('img', { name: PRO_TEXT.booked })).toBeVisible()
      await dialog.getByRole('button', { name: PRO_TEXT.done }).click()
      const appointmentId = await appointmentAt(STAFF[staff], time.startsAt)

      // From here on the pro app talks to PostgREST only: no Edge Function carries the SMS.
      const functionCalls = recordFunctionCalls(page)
      await page.goto(`/app/day?date=${date}`)
      // In this staff member's column: the other project may book Κώστας at the same time label.
      await page
        .getByTestId('day-view')
        .getByRole('list', { name: staff, exact: true })
        .getByRole('button', { name: new RegExp(`^${time.label}.*Κώστας Μ\\.`) })
        .click()
      const cancelSheet = sheet(page)
      await cancelSheet.getByRole('button', { name: PRO_TEXT.cancel, exact: true }).click()
      // Not «Το ζήτησε ο πελάτης» (that one says «ακύρωσες», D6): the business cancels.
      await cancelSheet.getByRole('radio', { name: 'Διπλό ραντεβού' }).check()
      await expect(cancelSheet.getByRole('checkbox', { name: /Ενημέρωση με SMS/ })).toBeChecked()
      await cancelSheet.getByRole('button', { name: PRO_TEXT.cancelSubmit }).click()
      await expect(cancelSheet.getByText(PRO_TEXT.cancelled)).toBeVisible()
      await expect(cancelSheet.getByText('Ο πελάτης θα ενημερωθεί με SMS.')).toBeVisible()

      const notice = await waitForMessage(appointmentId, 'cancelled_by_business')
      expect(notice).toMatchObject({ channel: 'sms', status: 'sent', provider: 'fake' })
      expect(functionCalls).toEqual([])
      // No push to the one who acted (the setup owner). Since 1.7 the actor is no longer Νίκος's
      // own user (…a001), so on Νίκος's column his user gets exactly one push, as staff and owner
      // (contract 1.7 §7.4).
      const actor = await userIdOf(setupOwnerEmail(engineOf(testInfo.project.name)))
      const pushes = (await messagesOf(appointmentId)).filter(
        (row) => row.template === 'push_booking_cancelled',
      )
      expect(pushes.filter((row) => row.recipient_user_id === actor)).toEqual([])
      if (staff === 'Νίκος') {
        expect(pushes.map((row) => row.recipient_user_id)).toEqual([OWNER])
      }
    })
  })
})

test.describe('Ρυθμίσεις → Ειδοποιήσεις', () => {
  test('says push is not available here yet (no OneSignal app id), with no motion', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await signInWithEmailCode(page, SEED_USERS.staff.email)
    await openToday(page)

    await page
      .getByRole('navigation', { name: 'Κύρια πλοήγηση' })
      .getByRole('link', { name: 'Ρυθμίσεις' })
      .click()
    await expect(page.getByRole('heading', { level: 1, name: 'Ρυθμίσεις' })).toBeVisible()
    await page.getByRole('link', { name: /^Ειδοποιήσεις/ }).click()

    await expect(page).toHaveURL(/\/app\/settings\/notifications$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Ειδοποιήσεις' })).toBeVisible()
    await expect(page.getByText('Οι ειδοποιήσεις δεν είναι διαθέσιμες ακόμη.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Ενεργοποίηση ειδοποιήσεων' })).toHaveCount(0)
    await expect(page.locator('script[src*="onesignal"]')).toHaveCount(0)
    expect(await runningAnimations(page)).toEqual([])
  })
})

/** URLs of every Edge Function request the page makes from now on. */
function recordFunctionCalls(page: Page): string[] {
  const calls: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/functions/v1/')) calls.push(request.url())
  })
  return calls
}

/** Every CSS animation or transition running or pending on the page. */
function runningAnimations(page: Page) {
  return page.evaluate(() =>
    document.getAnimations().map((animation) => {
      const target = (animation.effect as KeyframeEffect | null)?.target
      return target instanceof Element ? target.className : String(target)
    }),
  )
}
