import type { Page } from '@playwright/test'
import { resetFactors, userIdOf } from './lib/auth'
import { APP_ORIGIN, engineOf } from './lib/authPaths'
import { auditRowsOf, closeDb, dbNow, factorsOf, grantsOf } from './lib/db'
import { confirmNewDevice, ENROLL_TEXT, readScanStep, stepOf } from './lib/enrollScreens'
import { expect, test } from './lib/fixtures'
import { signInWithEmailCode } from './lib/login'
import { DEMO_BUSINESS_ID, enrollOwnerEmail } from './lib/seedUsers'
import { answerStepUp, waitUntilCodeIsStale } from './lib/step-up'
import { factorNamed, nextCode } from './lib/totpStore'

// Step 1.7 (plan «Playwright», contract 1.7 §7.4): an owner's sign-in with an authenticator app,
// through the screens, on a seed owner of its own per engine (`owner-enroll-<engine>`, no device
// in the seed; every run starts by deleting the devices of the run before, the way the Nous reset
// does). In order: the blocking first enrolment → «Πρόσθεσε δεύτερη συσκευή» («Αργότερα» only
// with the confirmation); a new sign-in → email code → 6-digit code → the reminder; «Χάσατε τη
// συσκευή σας;» from the code screen; «Προσθήκη τώρα» (the code sheet: a new device needs a fresh
// code) → a second device with another name; the next sign-in with the second device's code, no
// reminder. Codes come from e2e/lib/totpStore.ts (the key read from the screen, checked against
// the one Auth stored). Needs `npm run db:start` + `npm run db:reset` and the dev server.

test.describe.configure({ mode: 'serial', timeout: 180_000 })

/** src/shared/i18n/el/pro.json `mfa.*`. */
const TEXT = {
  enrollTitle: 'Προστασία λογαριασμού',
  copy: 'Αντιγραφή κλειδιού',
  copied: 'Αντιγράφηκε',
  copyFailed: 'Η αντιγραφή δεν έγινε. Γράψε το κλειδί με το χέρι.',
  secondTitle: 'Πρόσθεσε δεύτερη συσκευή',
  addNow: 'Προσθήκη τώρα',
  later: 'Αργότερα',
  understand: 'Καταλαβαίνω ότι αν χάσω αυτή τη συσκευή θα χρειαστώ τη Nous',
  challengeTitle: 'Κωδικός από την εφαρμογή κωδικών',
  challengeSubmit: 'Συνέχεια',
  device: 'Συσκευή',
  lost: 'Χάσατε τη συσκευή σας;',
  secondDeviceLink: 'Κωδικός από τη δεύτερη συσκευή',
  contact:
    'Αλλιώς επικοινώνησε με τη Nous. Θα επιβεβαιώσουμε ότι είσαι εσύ: θα σου στείλουμε κωδικό στο email σου και θα σε καλέσουμε στο τηλέφωνο του καταστήματος.',
  noBypass: 'Η εφαρμογή δεν έχει άλλο τρόπο εισόδου χωρίς τη συσκευή.',
  backToCode: 'Πίσω στον κωδικό',
  today: 'Σήμερα',
  signOut: 'Αποσύνδεση',
} as const

/** The app's default names: «Συσκευή {{n}}», n = verified devices + 1 (contract 1.7 D20). */
const FIRST = 'Συσκευή 1'
const SECOND = 'Συσκευή 2'

/** Nous's contact the dev server was started with (playwright.config.ts, D19). */
const SUPPORT_EMAIL = process.env.VITE_SUPPORT_EMAIL ?? 'support@example.com'
const SUPPORT_PHONE = process.env.VITE_SUPPORT_PHONE ?? '+302100000000'

let email: string
let userId: string
/** The database's clock when the spec started: grants and audit rows of this run only. */
let since: string

// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, testInfo) => {
  email = enrollOwnerEmail(engineOf(testInfo.project.name))
  await resetFactors(email)
  userId = await userIdOf(email)
  since = await dbNow()
})

test.afterAll(async () => {
  await closeDb()
})

async function expectToday(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/app\/?$/)
  await expect(page.getByRole('heading', { level: 1, name: TEXT.today })).toBeVisible()
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

/** E14 entrances (if any were set) stand in their final place. */
async function expectNoEntrance(page: Page): Promise<void> {
  const states = await page.evaluate(() =>
    [...document.querySelectorAll('.step-enter, .step-enter-back')].map((element) => {
      const style = getComputedStyle(element)
      return { opacity: style.opacity, transform: style.transform, animation: style.animationName }
    }),
  )
  for (const state of states) {
    expect(state).toMatchObject({ opacity: '1', transform: 'none', animation: 'none' })
  }
  expect(await runningAnimations(page)).toEqual([])
}

/** The code screen after the email code, answered with the code of `device`. */
async function passChallenge(page: Page, device: string): Promise<void> {
  await expect(page).toHaveURL(/\/app\/mfa\/challenge$/)
  await expect(page.getByRole('heading', { level: 1, name: TEXT.challengeTitle })).toBeVisible()
  const factor = await factorNamed(email, device)
  await page.getByLabel(ENROLL_TEXT.codeLabel).fill(await nextCode(email, factor.factorId))
  await page.getByRole('button', { name: TEXT.challengeSubmit, exact: true }).click()
}

/** «Αργότερα» stays disabled until the box is checked; then → «Σήμερα». */
async function laterWithConfirmation(page: Page): Promise<void> {
  const later = page.getByRole('button', { name: TEXT.later, exact: true })
  await expect(later).toBeDisabled()
  await page.getByRole('checkbox', { name: TEXT.understand }).check()
  await expect(later).toBeEnabled()
  await later.click()
  await expectToday(page)
}

test.describe('an owner’s authenticator app', () => {
  test('first sign-in: the enrolment blocks the app, then «Πρόσθεσε δεύτερη συσκευή»', async ({
    page,
    context,
    browserName,
  }) => {
    await signInWithEmailCode(page, email)
    await expect(page).toHaveURL(/\/app\/mfa\/enroll$/)
    await expect(page.getByRole('heading', { level: 1, name: TEXT.enrollTitle })).toBeVisible()
    // No way into the app before a device is verified.
    await page.goto('/app/settings')
    await expect(page).toHaveURL(/\/app\/mfa\/enroll$/)

    await expect(stepOf(page, 1)).toBeVisible()
    await expect(page.getByLabel(ENROLL_TEXT.deviceName)).toHaveValue(FIRST)
    await page.getByRole('button', { name: ENROLL_TEXT.haveIt }).click()
    const factorId = await readScanStep(page, { email, userId }, FIRST)

    // «Αντιγραφή κλειδιού»: Chromium grants the clipboard to the page; WebKit may refuse it,
    // and then the screen says so (the key stays on screen to type by hand).
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN })
    }
    await page.getByRole('button', { name: TEXT.copy }).click()
    if (browserName === 'chromium') {
      await expect(page.getByText(TEXT.copied, { exact: true })).toBeVisible()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        await page.getByTestId('enroll-key').textContent(),
      )
    } else {
      await expect(
        page.getByText(TEXT.copied, { exact: true }).or(page.getByText(TEXT.copyFailed)),
      ).toBeVisible()
    }

    await confirmNewDevice(page, email, factorId)
    await expect(page).toHaveURL(/\/app\/mfa\/second-device$/)
    await expect(page.getByRole('heading', { level: 1, name: TEXT.secondTitle })).toBeVisible()
    await laterWithConfirmation(page)

    // The device is the user's only verified factor; its permission came first (0009).
    expect(await factorsOf(userId)).toEqual([
      { id: factorId, friendly_name: FIRST, status: 'verified' },
    ])
    expect((await grantsOf(userId, since)).filter((grant) => grant.action === 'add')).toEqual([
      { action: 'add', factor_id: null, source: 'user', minutes: 10 },
    ])
    const audit = await auditRowsOf({ actions: ['factor_add_authorized'], since, actorId: userId })
    expect(audit).toEqual([
      expect.objectContaining({
        business_id: DEMO_BUSINESS_ID,
        actor_type: 'staff',
        entity: 'auth_factor',
        entity_id: null,
      }),
    ])
  })

  test('a new sign-in: email code → 6-digit code → the reminder, with no motion', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await signInWithEmailCode(page, email)
    await expect(page.getByRole('heading', { level: 1, name: TEXT.challengeTitle })).toBeVisible()
    // One device: nothing to choose.
    await expect(page.getByRole('radio')).toHaveCount(0)
    await passChallenge(page, FIRST)

    await expect(page).toHaveURL(/\/app\/mfa\/second-device$/)
    await expect(page.getByRole('heading', { level: 1, name: TEXT.secondTitle })).toBeVisible()
    await expectNoEntrance(page)
    await laterWithConfirmation(page)
  })

  test('«Χάσατε τη συσκευή σας;» gives Nous’s contact and no way around the code', async ({
    page,
  }) => {
    await signInWithEmailCode(page, email)
    await expect(page).toHaveURL(/\/app\/mfa\/challenge$/)
    await page.getByRole('link', { name: TEXT.lost }).click()

    await expect(page).toHaveURL(/\/app\/mfa\/lost-device$/)
    await expect(page.getByRole('heading', { level: 1, name: TEXT.lost })).toBeVisible()
    await expect(page.getByText(TEXT.contact)).toBeVisible()
    await expect(
      page.getByRole('link', { name: `Email στη Nous: ${SUPPORT_EMAIL}` }),
      'VITE_SUPPORT_EMAIL of the dev server (playwright.config.ts or .env.local)',
    ).toHaveAttribute('href', `mailto:${SUPPORT_EMAIL}`)
    await expect(page.getByRole('link', { name: /^Κλήση στη Nous: / })).toHaveAttribute(
      'href',
      `tel:${SUPPORT_PHONE}`,
    )
    await expect(page.getByText(TEXT.noBypass)).toBeVisible()
    // One device: no «second device» way; the only button signs out, the only other link goes
    // back to the code.
    await expect(page.getByRole('link', { name: TEXT.secondDeviceLink })).toHaveCount(0)
    await expect(page.getByRole('button')).toHaveCount(1)
    await expect(page.getByRole('button')).toHaveAccessibleName(TEXT.signOut)
    await expect(page.getByRole('link', { name: TEXT.backToCode })).toBeVisible()

    // The app stays closed.
    await page.goto('/app')
    await expect(page).toHaveURL(/\/app\/mfa\/challenge(\?.*)?$/)
    await page.getByRole('button', { name: TEXT.signOut }).click()
    await expect(page).toHaveURL(/\/app\/login$/)
  })

  test('«Προσθήκη τώρα» adds a second device with another name (code sheet first), no motion', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await signInWithEmailCode(page, email)
    await passChallenge(page, FIRST)
    await expect(page).toHaveURL(/\/app\/mfa\/second-device$/)

    await page.getByRole('button', { name: TEXT.addNow }).click()
    await expect(stepOf(page, 1)).toBeVisible()
    await expect(page.getByLabel(ENROLL_TEXT.deviceName)).toHaveValue(SECOND)
    await expectNoEntrance(page)
    // The code of this sign-in is still fresh: let it age past the seed's 10″, so the server asks
    // for a new one before it allows a new device.
    await waitUntilCodeIsStale(page)
    await page.getByRole('button', { name: ENROLL_TEXT.haveIt }).click()
    await answerStepUp(page, email)

    const factorId = await readScanStep(page, { email, userId }, SECOND)
    await expectNoEntrance(page)
    await confirmNewDevice(page, email, factorId)
    await expectToday(page)

    expect(
      (await factorsOf(userId)).map((factor) => [factor.friendly_name, factor.status]),
    ).toEqual([
      [FIRST, 'verified'],
      [SECOND, 'verified'],
    ])
    const adds = (await grantsOf(userId, since)).filter((grant) => grant.action === 'add')
    expect(adds).toEqual([
      { action: 'add', factor_id: null, source: 'user', minutes: 10 },
      { action: 'add', factor_id: null, source: 'user', minutes: 10 },
    ])
    expect(
      await auditRowsOf({ actions: ['factor_add_authorized'], since, actorId: userId }),
    ).toHaveLength(2)
  })

  test('the next sign-in offers both devices and passes with the second’s code, no reminder', async ({
    page,
  }) => {
    await signInWithEmailCode(page, email)
    await expect(page).toHaveURL(/\/app\/mfa\/challenge$/)
    const devices = page.getByRole('group', { name: TEXT.device })
    await expect(devices.getByRole('radio')).toHaveCount(2)
    await expect(devices.getByRole('radio', { name: FIRST, exact: true })).toBeChecked()
    await devices.getByRole('radio', { name: SECOND, exact: true }).check()
    await passChallenge(page, SECOND)

    await expectToday(page)
    await expect(page.getByRole('heading', { name: TEXT.secondTitle })).toHaveCount(0)
  })
})
