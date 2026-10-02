import type { Page, TestInfo } from '@playwright/test'
import { deleteAuthUser, findUserId, signInAal2, userIdOf } from './lib/auth'
import { APP_ORIGIN } from './lib/authPaths'
import { auditRowsOf, closeDb, dbNow, deleteMembership, sessionCountOf } from './lib/db'
import { expect, test } from './lib/fixtures'
import { signInWithEmailCode } from './lib/login'
import { memberFunction, memberRest } from './lib/memberApi'
import { newDeviceContext } from './lib/pro'
import { SEED_USERS } from './lib/seedUsers'
import { membersShopFile, provisionLocal, type E2eShop } from './lib/shops'
import { answerStepUp, waitUntilCodeIsStale } from './lib/step-up'

// Step 1.7 (plan «Playwright», contract 1.7 §7.4): Ρυθμίσεις → Μέλη on a synthetic shop per
// browser project (`membersShopFile`: owner `owner@e2e-members-<project>.test`, a staff row
// «Ε2Ε Μέλος» without a login), provisioned LOCALLY. Every member change is critical: the server
// refuses it without a fresh code, also when called straight (PostgREST, `invite-member`), and
// the app answers that with the code sheet and one retry. The owner invites
// `member@e2e-members-<project>.test` as staff linked to «Ε2Ε Μέλος», who signs in with the email
// code only; then promotes them (their sessions end with it) and removes them. An earlier run's
// membership of the invitee is deleted first. An account of another business (the seed's Άλεξ of
// demo-barber) is never attached by an invitation (AN031, review fix of contract 1.7 §10). Needs
// `npm run db:start` + `npm run db:reset`.

test.describe.configure({ mode: 'serial', timeout: 180_000 })

/** src/shared/i18n/el/pro.json `members.*`, `settings.*`, `sheet.*`. */
const TEXT = {
  entry: /^Μέλη/,
  title: 'Μέλη',
  invite: 'Πρόσκληση μέλους',
  email: 'Email',
  staff: 'Επαγγελματίας στο ημερολόγιο',
  submit: 'Πρόσκληση',
  added: (email: string) => `${email} προστέθηκε.`,
  staffRole: 'Προσωπικό',
  managerRole: 'Διαχειριστής',
  linked: 'Στο ημερολόγιο: Ε2Ε Μέλος',
  neverSignedIn: 'Δεν έχει συνδεθεί ακόμη',
  signOut: 'Θα αποσυνδεθεί από όλες τις συσκευές του.',
  enroll: 'Στην επόμενη σύνδεση θα ορίσει εφαρμογή κωδικών.',
  save: 'Αποθήκευση',
  roleChanged: 'Ο ρόλος άλλαξε.',
  remove: 'Αφαίρεση από την επιχείρηση',
  removeConfirm: 'Να αφαιρεθεί από την επιχείρηση;',
  removeYes: 'Αφαίρεση',
  removed: 'Αφαιρέθηκε από την επιχείρηση.',
  /** src/shared/i18n/el/common.json `errors.AN031`. */
  elsewhere: 'Αυτό το email δεν μπορεί να προστεθεί από εδώ. Επικοινώνησε με τη Nous.',
  done: 'Τέλος',
  today: 'Σήμερα',
} as const

function projectOf(testInfo: TestInfo): 'chrome' | 'safari' {
  return testInfo.project.name.includes('safari') ? 'safari' : 'chrome'
}

let shop: E2eShop
let invitee: string
let since: string

// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, testInfo) => {
  const project = projectOf(testInfo)
  shop = (await provisionLocal(membersShopFile(project))).shop
  invitee = `member@e2e-members-${project}.test`
  // An earlier run left the invitee behind: a failed one in the shop (provisioning keeps members
  // that are not in its file; as postgres, the 0009 trigger also ends their sessions), and every
  // one as an Auth account that has signed in. Both go, so the invitation meets a new person.
  const left = await findUserId(invitee)
  if (left) {
    await deleteMembership(shop.businessId, left)
    await deleteAuthUser(invitee)
  }
  since = await dbNow()
})

test.afterAll(async () => {
  await closeDb()
})

async function openMembers(page: Page): Promise<void> {
  await page.goto('/app/settings')
  await page.getByRole('link', { name: TEXT.entry }).click()
  await expect(page).toHaveURL(/\/app\/settings\/members$/)
  await expect(page.getByRole('heading', { level: 1, name: TEXT.title })).toBeVisible()
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
}

/** A member's row: a button named by their email (the caller's own row is not a button). */
function memberRow(page: Page, email: string) {
  return page
    .getByRole('list', { name: 'Μέλη της επιχείρησης' })
    .getByRole('button', { name: new RegExp(`^${email.replace(/[.]/g, '\\.')}`) })
}

const MEMBER_AUDIT = ['member_added', 'member_role_changed', 'member_removed'] as const

test.describe('Ρυθμίσεις → Μέλη', () => {
  test('without a fresh code the server refuses every member change, also called straight', async ({
    page,
  }) => {
    await signInAal2(page, shop.ownerEmail)
    await waitUntilCodeIsStale(page)
    const owner = await userIdOf(shop.ownerEmail)
    const rpcs = [
      ['can_manage_members', { p_business_id: shop.businessId }],
      ['set_member_role', { p_business_id: shop.businessId, p_user_id: owner, p_role: 'owner' }],
      ['remove_member', { p_business_id: shop.businessId, p_user_id: owner }],
    ] as const
    for (const [name, args] of rpcs) {
      const { status, body } = await memberRest(page, 'POST', `rpc/${name}`, args)
      expect({ name, status, body }).toMatchObject({
        name,
        status: 403,
        body: { code: '42501', hint: 'fresh_totp_required' },
      })
    }
    const invited = await memberFunction(page, 'invite-member', {
      business_id: shop.businessId,
      email: invitee,
      role: 'staff',
      staff_id: null,
    })
    expect(invited).toMatchObject({
      status: 403,
      body: { code: '42501', hint: 'fresh_totp_required' },
    })
    expect(
      await auditRowsOf({ actions: MEMBER_AUDIT, since, businessId: shop.businessId }),
    ).toEqual([])
  })

  test('the owner invites a staff member (code sheet → success), who signs in straight to Today', async ({
    page,
    browser,
  }, testInfo) => {
    await signInAal2(page, shop.ownerEmail)
    await openMembers(page)
    await page.getByRole('button', { name: TEXT.invite }).click()
    const sheet = page.getByRole('dialog', { name: TEXT.invite })
    await sheet.getByLabel(TEXT.email).fill(invitee)
    await expect(sheet.getByRole('radio', { name: TEXT.staffRole })).toBeChecked()
    await sheet.getByLabel(TEXT.staff).selectOption({ label: 'Ε2Ε Μέλος' })
    await waitUntilCodeIsStale(page)
    await sheet.getByRole('button', { name: TEXT.submit, exact: true }).click()
    await answerStepUp(page, shop.ownerEmail)

    // Only after the server's answer: the confirmation and the text to send.
    await expect(sheet.getByText(TEXT.added(invitee))).toBeVisible()
    await expect(
      sheet.getByText(`Σε πρόσθεσα στο E2E Members ${projectOf(testInfo)} στο Anaklo.`),
    ).toContainText(`${APP_ORIGIN}/app/`)
    await expect(sheet.getByText(/^Σε πρόσθεσα/)).toContainText(invitee)
    await sheet.getByRole('button', { name: TEXT.done }).click()
    const row = memberRow(page, invitee)
    await expect(row).toContainText(TEXT.staffRole)
    await expect(row).toContainText(TEXT.linked)
    await expect(row).toContainText(TEXT.neverSignedIn)

    const inviteeId = await userIdOf(invitee)
    const audit = await auditRowsOf({ actions: MEMBER_AUDIT, since, entityId: inviteeId })
    expect(audit).toEqual([
      expect.objectContaining({
        business_id: shop.businessId,
        actor_type: 'staff',
        actor_id: await userIdOf(shop.ownerEmail),
        action: 'member_added',
        entity: 'business_member',
        reason: 'staff',
      }),
    ])

    // The invitee: the email code only (staff never need an authenticator app).
    const other = await newDeviceContext(browser, testInfo)
    try {
      const phone = await other.newPage()
      await signInWithEmailCode(phone, invitee)
      await expect(phone).toHaveURL(/\/app\/?$/)
      await expect(phone.getByRole('heading', { level: 1, name: TEXT.today })).toBeVisible()
    } finally {
      await other.close()
    }
  })

  test('a role change and the removal each need the sheet; the change ends their sessions', async ({
    page,
    browser,
  }, testInfo) => {
    const inviteeId = await userIdOf(invitee)
    const other = await newDeviceContext(browser, testInfo)
    try {
      // The invitee is signed in on their phone.
      const phone = await other.newPage()
      await signInWithEmailCode(phone, invitee)
      await expect(phone.getByRole('heading', { level: 1, name: TEXT.today })).toBeVisible()

      // Staff → manager: what it does is written before «Αποθήκευση».
      await signInAal2(page, shop.ownerEmail)
      await openMembers(page)
      await memberRow(page, invitee).click()
      let sheet = page.getByRole('dialog', { name: invitee })
      await sheet.getByRole('radio', { name: TEXT.managerRole }).check()
      await expect(sheet.getByText(TEXT.signOut)).toBeVisible()
      await expect(sheet.getByText(TEXT.enroll)).toBeVisible()
      await waitUntilCodeIsStale(page)
      await sheet.getByRole('button', { name: TEXT.save, exact: true }).click()
      await answerStepUp(page, shop.ownerEmail)
      await expect(sheet.getByText(TEXT.roleChanged)).toBeVisible()
      await sheet.getByRole('button', { name: TEXT.done }).click()
      await expect(memberRow(page, invitee)).toContainText(TEXT.managerRole)

      // Their sessions ended with the change (0009 trigger): the next navigation → login.
      expect(await sessionCountOf(inviteeId)).toBe(0)
      await phone.reload()
      await expect(phone).toHaveURL(/\/app\/login$/)

      // Removal: one confirmation, then the sheet again.
      await memberRow(page, invitee).click()
      sheet = page.getByRole('dialog', { name: invitee })
      await sheet.getByRole('button', { name: TEXT.remove }).click()
      await expect(sheet.getByText(TEXT.removeConfirm)).toBeVisible()
      await expect(sheet.getByText(TEXT.signOut)).toBeVisible()
      await waitUntilCodeIsStale(page)
      await sheet.getByRole('button', { name: TEXT.removeYes, exact: true }).click()
      await answerStepUp(page, shop.ownerEmail)
      await expect(sheet.getByText(TEXT.removed)).toBeVisible()
      await sheet.getByRole('button', { name: TEXT.done }).click()
      await expect(memberRow(page, invitee)).toHaveCount(0)

      const audit = await auditRowsOf({ actions: MEMBER_AUDIT, since, entityId: inviteeId })
      expect(audit.map((row) => [row.action, row.reason, row.actor_type])).toEqual([
        ['member_added', 'staff', 'staff'],
        ['member_role_changed', 'staff:manager', 'staff'],
        ['member_removed', 'manager', 'staff'],
      ])
    } finally {
      await other.close()
    }
  })

  test('an account of another business is never attached by an invitation (AN031)', async ({
    page,
  }) => {
    // No acceptance step exists, and a later removal or role change here would end that user's
    // sessions and push devices in every business: only Nous attaches such an account.
    const outsider = SEED_USERS.staff.email
    await signInAal2(page, shop.ownerEmail)
    await openMembers(page)
    await page.getByRole('button', { name: TEXT.invite }).click()
    const sheet = page.getByRole('dialog', { name: TEXT.invite })
    await sheet.getByLabel(TEXT.email).fill(outsider)
    await waitUntilCodeIsStale(page)
    await sheet.getByRole('button', { name: TEXT.submit, exact: true }).click()
    await answerStepUp(page, shop.ownerEmail)
    await expect(sheet.getByText(TEXT.elsewhere)).toBeVisible()

    expect(
      await auditRowsOf({ actions: MEMBER_AUDIT, since, entityId: SEED_USERS.staff.id }),
    ).toEqual([])
    await openMembers(page)
    await expect(memberRow(page, outsider)).toHaveCount(0)
  })
})
