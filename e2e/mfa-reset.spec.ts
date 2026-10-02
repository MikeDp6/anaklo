import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { REPO_ROOT } from '../scripts/lib/cli.mjs'
import { aal2State, ensureEnrolled } from './lib/auth'
import { SHOP } from './lib/booking'
import { auditRowsOf, closeDb, dbNow, factorsOf, grantsOf, sessionCountOf } from './lib/db'
import { confirmNewDevice, ENROLL_TEXT, readScanStep, stepOf } from './lib/enrollScreens'
import { expect, test } from './lib/fixtures'
import { signInWithEmailCode } from './lib/login'
import { DEMO_BUSINESS_ID, RESET_MANAGER } from './lib/seedUsers'
import { provisionLocal, resetShopFile, type E2eShop } from './lib/shops'
import { forgetFactors } from './lib/totpStore'

// Step 1.7 exit criterion (plan, contract 1.7 §5.1, §7.4): the Nous reset rehearsed by the
// runbook on the LOCAL stack — `node scripts/mfa-reset.mjs --local …` (never without --local: the
// script's default target is the remote dev project). The seed's `manager-reset@` is manager of
// demo-barber and owner of a second shop (`e2e-reset`, provisioned here), with a device and a
// session. Without --yes nothing is written; with it every device and session goes, each device
// with its `nous_support` permission, one `mfa_reset` audit row per business; the next sign-in
// enrols and then offers «Πρόσθεσε δεύτερη συσκευή». Chromium only (one user, one sequence).

test.describe.configure({ mode: 'serial', timeout: 180_000 })

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'mfa-reset.mjs')
const EMAIL = RESET_MANAGER.email
const USER = RESET_MANAGER.id
const RUNBOOK_ARGS = ['--email', EMAIL, '--reason', 'e2e runbook', '--ticket', 'E2E-1']

/** The script as an operator runs it, always with --local. */
function mfaReset(...args: string[]) {
  const run = spawnSync(process.execPath, [SCRIPT, '--local', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

let shop: E2eShop

test.beforeAll(async ({ browserName }) => {
  if (browserName !== 'chromium') return
  // The describe's timeout does not reach this hook (Playwright's default 30 s applies): the
  // provisioning, the enrolment and a second verify, which waits for a new 30″ step (never the
  // same code twice in a step), can take longer than that.
  test.setTimeout(120_000)
  shop = (await provisionLocal(resetShopFile(EMAIL))).shop
  // A device whose secret the spec knows, and a live session to be revoked.
  await ensureEnrolled(EMAIL)
  await aal2State(EMAIL, { fresh: true })
})

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== 'chromium', 'one user, one sequence: Chromium only')
})

test.afterAll(async () => {
  await closeDb()
})

test.describe('the Nous reset (scripts/mfa-reset.mjs --local)', () => {
  test('an unknown option stops it before anything (exit 2)', () => {
    const run = mfaReset(...RUNBOOK_ARGS, '--no-such-option')
    expect(run.status, run.stderr).toBe(2)
  })

  test('without --yes it only reads: a dry run that writes nothing', async () => {
    const factors = await factorsOf(USER)
    const sessions = await sessionCountOf(USER)
    expect(factors.length).toBeGreaterThan(0)
    expect(sessions).toBeGreaterThan(0)
    const since = await dbNow()

    const run = mfaReset(...RUNBOOK_ARGS)
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(run.stdout).toContain('Dry run: nothing was written.')

    expect(await factorsOf(USER)).toEqual(factors)
    expect(await sessionCountOf(USER)).toBe(sessions)
    expect(await grantsOf(USER, since)).toEqual([])
    expect(await auditRowsOf({ actions: ['mfa_reset'], since, entityId: USER })).toEqual([])
  })

  test('with --yes: devices and sessions gone, permissions and audit first; then enrolment', async ({
    page,
  }) => {
    const factorIds = (await factorsOf(USER)).map((factor) => factor.id)
    expect(factorIds.length).toBeGreaterThan(0)
    const since = await dbNow()

    const run = mfaReset(...RUNBOOK_ARGS, '--yes')
    expect(run.status, run.stdout + run.stderr).toBe(0)
    // The emails of the runbook, filled in: the user's (el, en) and, for a manager, the owner's.
    expect(run.stdout).toContain(`----- Email to ${EMAIL} (el) -----`)
    expect(run.stdout).toContain(`----- Email to ${EMAIL} (en) -----`)
    expect(run.stdout).toContain(`----- Email to the owner(s) of ${SHOP.name}:`)
    expect(run.stdout).not.toMatch(/\{\{.*\}\}/)

    expect(await factorsOf(USER)).toEqual([])
    expect(await sessionCountOf(USER)).toBe(0)
    expect(await grantsOf(USER, since)).toEqual(
      factorIds.map((id) => ({
        action: 'remove',
        factor_id: id,
        source: 'nous_support',
        minutes: 10,
      })),
    )
    const audit = await auditRowsOf({ actions: ['mfa_reset'], since, entityId: USER })
    expect(audit.map((row) => row.business_id).sort()).toEqual(
      [DEMO_BUSINESS_ID, shop.businessId].sort(),
    )
    for (const row of audit) {
      expect(row).toMatchObject({
        actor_type: 'nous_support',
        actor_id: null,
        entity: 'auth_user',
        reason: '[E2E-1] e2e runbook',
      })
    }
    await forgetFactors(EMAIL)

    // The next sign-in: the email code, then a new enrolment, then the second-device screen.
    await signInWithEmailCode(page, EMAIL)
    await expect(page).toHaveURL(/\/app\/mfa\/enroll$/)
    await expect(stepOf(page, 1)).toBeVisible()
    await expect(page.getByLabel(ENROLL_TEXT.deviceName)).toHaveValue('Συσκευή 1')
    await page.getByRole('button', { name: ENROLL_TEXT.haveIt }).click()
    const factorId = await readScanStep(page, { email: EMAIL, userId: USER }, 'Συσκευή 1')
    await confirmNewDevice(page, EMAIL, factorId)
    await expect(page).toHaveURL(/\/app\/mfa\/second-device$/)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Πρόσθεσε δεύτερη συσκευή' }),
    ).toBeVisible()
  })
})
