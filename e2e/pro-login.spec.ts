import { expect, test } from './lib/fixtures'
import { LOGIN_TEXT, requestCode, signInWithEmailCode } from './lib/login'
import { countMessagesTo } from './lib/mailpit'
import { SEED_USERS } from './lib/seedUsers'

// Staff sign-in of step 1.1 (ADR-0009 §1–5): 6-digit email code read from the local Mailpit.
// Needs `npm run db:start` + `npm run db:reset` (seed users). In 1.7 the owner ends at the
// code-app step (enroll/challenge) instead of Today.

test.describe('pro app sign-in', () => {
  test.describe.configure({ timeout: 90_000 })

  test('the owner signs in with the emailed code, lands on Today and signs out', async ({
    page,
  }) => {
    await signInWithEmailCode(page, SEED_USERS.owner.email)
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
