import type { Page, Request } from '@playwright/test'
import { ensureEnrolled, FIRST_DEVICE, resetFactors, signInAal2 } from './lib/auth'
import { engineOf } from './lib/authPaths'
import { auditRowsOf, closeDb, dbNow, factorsOf, grantsOf, sessionCountOf } from './lib/db'
import { confirmNewDevice, ENROLL_TEXT, readScanStep } from './lib/enrollScreens'
import { expect, test } from './lib/fixtures'
import { newDeviceContext } from './lib/pro'
import { DEMO_BUSINESS_ID, devicesOwnerEmail } from './lib/seedUsers'
import { answerStepUp, waitUntilCodeIsStale } from './lib/step-up'
import { factorNamed, forgetFactors } from './lib/totpStore'

// Step 1.7 (plan «Playwright», contract 1.7 §7.4): Ρυθμίσεις → Ασφάλεια of an owner
// (`owner-devices-<engine>`, one device enrolled through the API at the start of every run):
// a device is added (the code sheet first: the server wants a fresh code) and one is removed
// (sheet again, then `manage-factors`), each with its permission in
// `private.factor_change_grants` and its `audit_log` row; the last device cannot be removed. Then
// the sessions: «Αποσύνδεση» ends this device only, «Αποσύνδεση από όλες τις συσκευές» every
// session of the user (after unregistering every push device: Auth's `others`, then this device's
// `local`; when Auth does not confirm `others`, the page says so and this device stays signed in,
// review fix of contract 1.7 §10). Needs `npm run db:start` + `npm run db:reset` and the dev server.

test.describe.configure({ mode: 'serial', timeout: 240_000 })

/** src/shared/i18n/el/pro.json `security.*`, `settings.*`. */
const TEXT = {
  title: 'Ασφάλεια',
  entry: /^Ασφάλεια/,
  devices: 'Συσκευές κωδικών',
  add: 'Προσθήκη συσκευής',
  added: 'Η συσκευή προστέθηκε.',
  remove: 'Αφαίρεση',
  removeConfirm: (name: string) => `Να αφαιρεθεί η συσκευή «${name}»;`,
  removed: 'Η συσκευή αφαιρέθηκε.',
  lastDevice: 'Πρόσθεσε πρώτα άλλη συσκευή για να αφαιρέσεις αυτή.',
  singleBanner: 'Έχεις μόνο μία συσκευή κωδικών. Αν τη χάσεις, θα χρειαστείς τη Nous.',
  signOut: 'Αποσύνδεση',
  signOutAll: 'Αποσύνδεση από όλες τις συσκευές',
  signOutAllConfirm: 'Θα χρειαστεί νέα σύνδεση σε κάθε συσκευή, και σε αυτή.',
  signOutAllSubmit: 'Αποσύνδεση παντού',
  signOutAllFailed: 'Δεν επιβεβαιώθηκε η αποσύνδεση από τις άλλες συσκευές.',
  cancel: 'Άκυρο',
  today: 'Σήμερα',
} as const

const SECOND = 'Συσκευή 2'

let email: string
let userId: string
let since: string

// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, testInfo) => {
  email = devicesOwnerEmail(engineOf(testInfo.project.name))
  await resetFactors(email)
  userId = await ensureEnrolled(email, FIRST_DEVICE)
  since = await dbNow()
})

test.afterAll(async () => {
  await closeDb()
})

async function openSecurity(page: Page): Promise<void> {
  await page.goto('/app/settings')
  await page.getByRole('link', { name: TEXT.entry }).click()
  await expect(page).toHaveURL(/\/app\/settings\/security$/)
  await expect(page.getByRole('heading', { level: 1, name: TEXT.title })).toBeVisible()
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
}

function devicesOf(page: Page) {
  return page.getByRole('region', { name: TEXT.devices })
}

function removeButton(page: Page, name: string) {
  return devicesOf(page).getByRole('button', { name: `${TEXT.remove}: ${name}` })
}

/** One device left: its «Αφαίρεση» is disabled with the reason, and the banner is on top. */
async function expectSingleDevice(page: Page, name: string): Promise<void> {
  const devices = devicesOf(page)
  await expect(devices.getByRole('listitem')).toHaveCount(1)
  await expect(devices.getByRole('listitem')).toContainText(name)
  await expect(removeButton(page, name)).toBeDisabled()
  await expect(devices.getByText(TEXT.lastDevice)).toBeVisible()
  await expect(devices.getByText(TEXT.singleBanner)).toBeVisible()
}

/**
 * No sideways overflow: an E14 step entering from the right (28px) must not widen the mobile
 * layout viewport (the page would pan sideways and the tab bar would cover the wizard's buttons).
 */
async function expectNoSidewaysOverflow(page: Page): Promise<void> {
  const width = page.viewportSize()?.width
  expect(await page.evaluate(() => window.innerWidth)).toBe(width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
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

test.describe('Ρυθμίσεις → Ασφάλεια', () => {
  test('a device is added and one removed, each after the code sheet; the last stays', async ({
    page,
  }) => {
    await signInAal2(page, email, { fresh: true })
    await openSecurity(page)
    await expectSingleDevice(page, FIRST_DEVICE)

    // Add: the banner's «Προσθήκη συσκευής» → the wizard. The session's code is fresh from the
    // sign-in: wait until it is older than the seed's 10″, so the server asks for a new one.
    await devicesOf(page).getByRole('button', { name: TEXT.add }).click()
    await expect(page).toHaveURL(/\/app\/settings\/security\/add-device$/)
    await expect(page.getByLabel(ENROLL_TEXT.deviceName)).toHaveValue(SECOND)
    await waitUntilCodeIsStale(page)
    await page.getByRole('button', { name: ENROLL_TEXT.haveIt }).click()
    await answerStepUp(page, email)
    const added = await readScanStep(page, { email, userId }, SECOND)
    await expectNoSidewaysOverflow(page)
    await confirmNewDevice(page, email, added)
    await expect(page).toHaveURL(/\/app\/settings\/security$/)
    await expect(page.getByText(TEXT.added)).toBeVisible()
    await expect(devicesOf(page).getByRole('listitem')).toHaveCount(2)
    await expect(devicesOf(page).getByText(TEXT.singleBanner)).toHaveCount(0)

    // Remove the first one: one confirmation, then the sheet (answered with the second device),
    // then the result from the server's answer only.
    const first = await factorNamed(email, FIRST_DEVICE)
    await removeButton(page, FIRST_DEVICE).click()
    await expect(devicesOf(page).getByText(TEXT.removeConfirm(FIRST_DEVICE))).toBeVisible()
    await waitUntilCodeIsStale(page)
    await devicesOf(page).getByRole('button', { name: TEXT.remove, exact: true }).click()
    await answerStepUp(page, email, SECOND)
    await expect(devicesOf(page).getByText(TEXT.removed)).toBeVisible()
    await forgetFactors(email, first.factorId)
    await expectSingleDevice(page, SECOND)

    // The database: the second device is the only factor; both changes had their permission
    // (source `user`, 10′) and their audit row in the owner's business.
    expect(await factorsOf(userId)).toEqual([
      { id: added, friendly_name: SECOND, status: 'verified' },
    ])
    expect(await grantsOf(userId, since)).toEqual([
      { action: 'add', factor_id: null, source: 'user', minutes: 10 },
      { action: 'remove', factor_id: first.factorId, source: 'user', minutes: 10 },
    ])
    const audit = await auditRowsOf({
      actions: ['factor_add_authorized', 'factor_remove_authorized'],
      since,
      actorId: userId,
    })
    expect(audit.map((row) => [row.action, row.entity_id, row.business_id])).toEqual([
      ['factor_add_authorized', null, DEMO_BUSINESS_ID],
      ['factor_remove_authorized', first.factorId, DEMO_BUSINESS_ID],
    ])
  })

  test('nothing moves on Ασφάλεια with reduced motion, not after a press either', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await signInAal2(page, email)
    await openSecurity(page)
    expect(await runningAnimations(page)).toEqual([])
    await page.getByRole('button', { name: TEXT.signOutAll }).click()
    await expect(page.getByText(TEXT.signOutAllConfirm)).toBeVisible()
    expect(await runningAnimations(page)).toEqual([])
    await page.getByRole('button', { name: TEXT.cancel, exact: true }).click()
    await expect(page.getByRole('button', { name: TEXT.signOutAll })).toBeVisible()
    expect(await runningAnimations(page)).toEqual([])
  })

  test('«Αποσύνδεση» ends this device only; «Αποσύνδεση από όλες τις συσκευές» ends both', async ({
    page,
    browser,
  }, testInfo) => {
    const other = await newDeviceContext(browser, testInfo)
    const second = await other.newPage()
    try {
      // Two phones, two sessions of the same owner.
      await signInAal2(page, email, { fresh: true })
      await signInAal2(second, email, { fresh: true })

      await page.getByRole('button', { name: TEXT.signOut, exact: true }).click()
      await expect(page).toHaveURL(/\/app\/login$/)
      await second.reload()
      await expect(second.getByRole('heading', { level: 1, name: TEXT.today })).toBeVisible()

      // Signed in again on the first phone: every device, from Ασφάλεια.
      await signInAal2(page, email, { fresh: true })
      const calls: string[] = []
      const record = (request: Request) => {
        const url = new URL(request.url())
        if (url.pathname.endsWith('/rest/v1/rpc/unregister_push_subscription')) {
          calls.push(`unregister ${request.postData() ?? ''}`)
        } else if (url.pathname.endsWith('/auth/v1/logout')) {
          calls.push(`logout ${url.searchParams.get('scope') ?? ''}`)
        }
      }
      page.on('request', record)
      await openSecurity(page)
      await page.getByRole('button', { name: TEXT.signOutAll }).click()
      await expect(page.getByText(TEXT.signOutAllConfirm)).toBeVisible()

      // Auth unreachable for the other sessions: no silent success. The page says so, this phone
      // stays signed in on Ασφάλεια, and the other phone is still signed in too.
      const sessionsBefore = await sessionCountOf(userId)
      await page.route('**/auth/v1/logout*', (route) => route.abort('internetdisconnected'))
      await page.getByRole('button', { name: TEXT.signOutAllSubmit }).click()
      await expect(page.getByRole('alert').filter({ hasText: TEXT.signOutAllFailed })).toBeVisible()
      await expect(page).toHaveURL(/\/app\/settings\/security$/)
      await page.unroute('**/auth/v1/logout*')
      await second.reload()
      await expect(second.getByRole('heading', { level: 1, name: TEXT.today })).toBeVisible()
      expect(await sessionCountOf(userId)).toBe(sessionsBefore)

      // Again, with Auth reachable: every session ends.
      calls.length = 0
      await page.getByRole('button', { name: TEXT.signOutAllSubmit }).click()
      await expect(page).toHaveURL(/\/app\/login$/)
      page.off('request', record)

      // Every push device of the user is unregistered BEFORE Auth ends the other sessions; this
      // device's own session ends last.
      const unregisterAll = calls.findIndex((call) => /^unregister .*"p_all":\s*true/.test(call))
      const others = calls.indexOf('logout others')
      const local = calls.indexOf('logout local')
      expect(unregisterAll, calls.join(' | ')).toBeGreaterThanOrEqual(0)
      expect(others, calls.join(' | ')).toBeGreaterThan(unregisterAll)
      expect(local, calls.join(' | ')).toBeGreaterThan(others)
      expect(calls, calls.join(' | ')).not.toContain('logout global')

      // The other phone finds out on its next check (getUser on every navigation, D21).
      await second.reload()
      await expect(second).toHaveURL(/\/app\/login$/)
      expect(await sessionCountOf(userId)).toBe(0)
    } finally {
      await other.close()
    }
  })
})
