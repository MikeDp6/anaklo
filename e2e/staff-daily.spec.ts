import type { Page, Response, TestInfo } from '@playwright/test'
import { expect, test } from './lib/fixtures'
import { signInWithEmailCode } from './lib/login'
import { dayAppointment, PRO_TEXT, quickAddNewClient, sheet, chooseTime } from './lib/pro'
import { SEED_USERS } from './lib/seedUsers'
import { STEP_UP_HINTS, STEP_UP_TEXT, stepUpSheet } from './lib/step-up'

// Step 1.7 (plan «Playwright», exit criteria): a staff member has no authenticator app and never
// needs one: Άλεξ (`alex@demo-barber.test`) signs in with the email code straight to Today, and
// the daily actions on his own appointments (book, move, cancel) never open the code sheet and
// never get a step-up answer from the server. Each project books on its own window of days
// (Chromium 10, WebKit 11: after every other pro spec), both for Άλεξ. Needs `npm run db:start` +
// `npm run db:reset` and the dev server.

test.describe.configure({ timeout: 150_000 })

function windowOf(testInfo: TestInfo): number {
  return testInfo.project.name.includes('safari') ? 11 : 10
}

/**
 * Remembers, across the page's navigations (sessionStorage), whether a dialog titled «Επιβεβαίωση
 * με κωδικό» ever entered the page.
 */
async function watchForStepUpSheet(page: Page): Promise<void> {
  await page.addInitScript((title) => {
    const check = () => {
      for (const dialog of document.querySelectorAll('dialog')) {
        if (dialog.querySelector('h2')?.textContent?.trim() === title) {
          sessionStorage.setItem('e2e.stepUpSeen', '1')
        }
      }
    }
    new MutationObserver(check).observe(document, { childList: true, subtree: true })
  }, STEP_UP_TEXT.title)
}

async function stepUpSheetSeen(page: Page): Promise<boolean> {
  return page.evaluate(() => sessionStorage.getItem('e2e.stepUpSeen') === '1')
}

/** Every answer of the server that carries a step-up hint (there must be none). */
function recordStepUpAnswers(page: Page): string[] {
  const seen: string[] = []
  page.on('response', (response: Response) => {
    if (response.status() !== 401 && response.status() !== 403) return
    void response.text().then(
      (text) => {
        if (STEP_UP_HINTS.some((hint) => text.includes(hint))) seen.push(response.url())
      },
      () => undefined,
    )
  })
  return seen
}

test('a staff member books, moves and cancels without ever being asked for a code', async ({
  page,
}, testInfo) => {
  await watchForStepUpSheet(page)
  const stepUps = recordStepUpAnswers(page)
  const name = `Ε2Ε Προσωπικό ${testInfo.project.name.replace('mobile-', '')} ${Date.now().toString(36)}`

  // The email code only: no enrolment, no code screen.
  await signInWithEmailCode(page, SEED_USERS.staff.email)
  await expect(page).toHaveURL(/\/app\/?$/)
  await expect(page.getByRole('heading', { level: 1, name: PRO_TEXT.todayTitle })).toBeVisible()

  // Book.
  const booked = await quickAddNewClient(page, { name, staff: 'Άλεξ', window: windowOf(testInfo) })

  // Move it to the last free time of the day.
  await page.goto(`/app/day?date=${booked.date}`)
  await dayAppointment(page, new RegExp(name)).click()
  await sheet(page).getByRole('button', { name: PRO_TEXT.move }).click()
  const target = await chooseTime(sheet(page), 'last')
  expect(target.label).not.toBe(booked.label)
  await sheet(page).getByRole('button', { name: PRO_TEXT.moveHere }).click()
  await expect(sheet(page).getByRole('img', { name: PRO_TEXT.moved })).toBeVisible()
  await sheet(page).getByRole('button', { name: PRO_TEXT.done }).click()
  await expect(dayAppointment(page, new RegExp(name))).toHaveAccessibleName(
    new RegExp(`^${target.label}`),
  )

  // Cancel it.
  await dayAppointment(page, new RegExp(name)).click()
  await sheet(page).getByRole('button', { name: PRO_TEXT.cancel, exact: true }).click()
  await sheet(page).getByRole('radio', { name: 'Διπλό ραντεβού' }).check()
  await sheet(page).getByRole('button', { name: PRO_TEXT.cancelSubmit }).click()
  await expect(sheet(page).getByText(PRO_TEXT.cancelled)).toBeVisible()

  // Never the sheet, never a step-up answer.
  await expect(stepUpSheet(page)).toHaveCount(0)
  expect(await stepUpSheetSeen(page)).toBe(false)
  expect(stepUps).toEqual([])
})
