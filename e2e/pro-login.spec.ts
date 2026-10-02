import { expect, test } from './lib/fixtures'
import { LOGIN_TEXT, requestCode, signInWithEmailCode } from './lib/login'
import { countMessagesTo } from './lib/mailpit'
import { SEED_USERS } from './lib/seedUsers'

// Staff sign-in of step 1.1 (ADR-0009 §1–5): 6-digit email code read from the local Mailpit.
// Needs `npm run db:start` + `npm run db:reset` (seed users). Since 1.7 (contract 1.7 §6.2) an
// owner goes on to the authenticator step after the email code: the enrolment while they have no
// device (the seed gives the demo owner none, D16), the code screen once they have one. A staff
// member goes straight to Today.

/** The enrolment or the code screen: never Today before the second step. */
const OWNER_SECOND_STEP = /\/app\/mfa\/(enroll|challenge)(\?.*)?$/

test.describe('pro app sign-in', () => {
  test.describe.configure({ timeout: 90_000 })

  test('the owner signs in with the emailed code, lands on the authenticator step and signs out', async ({
    page,
  }) => {
    await signInWithEmailCode(page, SEED_USERS.owner.email)
    await expect(page).toHaveURL(OWNER_SECOND_STEP)
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: /^(Προστασία λογαριασμού|Κωδικός από την εφαρμογή κωδικών)$/,
      }),
    ).toBeVisible()
    // The signed-in area sends them back to that step.
    await page.goto('/app')
    await expect(page).toHaveURL(OWNER_SECOND_STEP)
    await expect(page.getByRole('heading', { level: 1, name: 'Σήμερα' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Αποσύνδεση' }).click()
    await expect(page).toHaveURL(/\/app\/login$/)
    await page.goto('/app')
    await expect(page).toHaveURL(/\/app\/login$/)
  })

  test('a staff member signs in with the emailed code straight to Today and signs out', async ({
    page,
  }) => {
    await signInWithEmailCode(page, SEED_USERS.staff.email)
    await expect(page).toHaveURL(/\/app\/?$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Σήμερα' })).toBeVisible()

    await page.getByRole('button', { name: 'Αποσύνδεση' }).click()
    await expect(page).toHaveURL(/\/app\/login$/)
    await page.goto('/app')
    await expect(page).toHaveURL(/\/app\/login$/)
  })

  test('a user without a membership sees «χωρίς πρόσβαση»', async ({ page }) => {
    await signInWithEmailCode(page, SEED_USERS.noMember.email)
    await expect(page).toHaveURL(/\/app\/no-access$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Χωρίς πρόσβαση' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Αποσύνδεση' })).toBeVisible()
  })

  test('an unknown email gets the same neutral message and the same code step', async ({
    page,
  }, testInfo) => {
    const email = `unknown-${testInfo.project.name}-${Date.now()}@demo-barber.test`
    await requestCode(page, email)
    await expect(page.getByLabel(LOGIN_TEXT.codeLabel)).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(await countMessagesTo(email)).toBe(0)
  })

  test('the signed-in area sends a signed-out visitor to the login screen', async ({ page }) => {
    await page.goto('/app')
    await expect(page).toHaveURL(/\/app\/login$/)
    await expect(page.getByLabel(LOGIN_TEXT.emailLabel)).toBeVisible()
  })
})

test.describe('iOS install screen', () => {
  // Opt out of the installed-app pretence the mobile-safari project applies to every page.
  test.use({ standalone: false })

  test('iOS Safari outside the installed app asks to add it to the Home Screen first', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'webkit', 'the install screen is iOS only')
    await page.goto('/app')
    await expect(
      page.getByRole('heading', { level: 1, name: 'Πρόσθεσε πρώτα στην αρχική οθόνη' }),
    ).toBeVisible()
    await expect(page.getByLabel(LOGIN_TEXT.emailLabel)).toHaveCount(0)
  })
})
