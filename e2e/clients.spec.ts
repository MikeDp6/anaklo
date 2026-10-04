import { randomInt } from 'node:crypto'
import type { Page, TestInfo } from '@playwright/test'
import { signInAal2, userIdOf } from './lib/auth'
import {
  auditRowsOf,
  clientChildCountsOf,
  clientRowOf,
  closeDb,
  createClientFixture,
  dbNow,
  suppressedFor,
} from './lib/db'
import { expect, test } from './lib/fixtures'
import { signInWithEmailCode } from './lib/login'
import { memberRest, memberRpc } from './lib/memberApi'
import { dayAppointment, PRO_TEXT } from './lib/pro'
import { SEED_USERS } from './lib/seedUsers'
import { clientsShopFile, provisionLocal, type E2eShop } from './lib/shops'
import { answerStepUp, STEP_UP_TEXT, waitUntilCodeIsStale } from './lib/step-up'

// Step 1.8 (plan «Playwright», contract 1.8 §5.4): «Πελάτες» and the client card.
// - On demo-barber, read-only: the greeklish search finds «Γιώργος Π.» (also in capitals, in
//   Greek without accents, by the last digits); the card shows the E18 ring and the counters;
//   with reduced motion nothing moves (the skeletons stay still, the ring is at its final offset
//   at once); loading never shifts the layout (Chromium). The owner tests use the setup's `aal2`
//   session (`member: 'owner'`), which never runs a critical action (contract 1.7 §7.4).
// - A staff member (Άλεξ, email code only) opens a card: no «Ανωνυμοποίηση πελάτη», never the
//   code sheet.
// - On the spec's own shop (`clientsShopFile`, D22), with an API-made `aal2` session of its owner:
//   without a fresh code `erase_client` is refused, also called straight; in the app the code
//   sheet opens and the anonymisation goes through with one retry; the name then appears nowhere
//   (search, day view) and the database keeps only the anonymous visit. `merge_clients` through
//   the wrapper; the merged client's address lands on the client it was merged into.
// Needs `npm run db:start` + `npm run db:reset` and the dev server.

/** src/shared/i18n/el/pro.json `nav.*`, `clients.*`. */
const TEXT = {
  nav: 'Κύρια πλοήγηση',
  tab: 'Πελάτες',
  title: 'Πελάτες',
  search: 'Αναζήτηση πελάτη',
  results: 'Αποτελέσματα αναζήτησης',
  none: 'Δεν βρέθηκε πελάτης.',
  erasedNotice: 'Ο πελάτης ανωνυμοποιήθηκε.',
  ring: /^Ρυθμός επισκέψεων\./,
  visits: 'Επισκέψεις',
  noShows: 'Δεν ήρθε',
  history: 'Ιστορικό',
  note: 'Σημείωση',
  save: 'Αποθήκευση',
  noteSaved: 'Η σημείωση αποθηκεύτηκε.',
  notes: 'Σημειώσεις πελάτη',
  marketing: 'Προσφορές με SMS',
  consentSheet: 'Συναίνεση για προσφορές με SMS',
  consentConfirm: 'Καταγραφή συναίνεσης',
  consentRecorded: 'Η συναίνεση καταγράφηκε.',
  eraseOpen: 'Ανωνυμοποίηση πελάτη',
  eraseTitle: 'Ανωνυμοποίηση πελάτη',
  understand: 'Καταλαβαίνω ότι δεν αναιρείται.',
  eraseConfirm: 'Ανωνυμοποίηση',
} as const

const GIORGOS = /Γιώργος Π\./

function projectOf(testInfo: TestInfo): 'chrome' | 'safari' {
  return testInfo.project.name.includes('safari') ? 'safari' : 'chrome'
}

/**
 * A word nobody else has (10 random Greek letters): the fixture's name and its search. Random,
 * not from the clock: two clock-made words of one run shared their leading letters, and the
 * fuzzy search then also found the other fixture.
 */
function uniqueWord(): string {
  const letters = 'αβγδεζηθικλμνξπρστυφχψω'
  let word = ''
  for (let i = 0; i < 10; i += 1) word += letters[randomInt(letters.length)] ?? 'α'
  return word
}

/** A synthetic mobile outside the seed's +3069000000NN range. */
function syntheticPhone(): string {
  return `+3069000${50_000 + Math.floor(Math.random() * 50_000)}`
}

function results(page: Page) {
  return page.getByRole('list', { name: TEXT.results })
}

/** The server's answer to exactly this query (not a stale one). */
function searchAnswer(page: Page, query: string) {
  return page.waitForResponse((response) => {
    if (!response.url().includes('/rest/v1/rpc/search_clients')) return false
    const sent: unknown = response.request().postDataJSON()
    return typeof sent === 'object' && sent !== null && 'p_query' in sent && sent.p_query === query
  })
}

/** Types a query and waits for the server's answer to exactly that query (not a stale one). */
async function search(page: Page, query: string): Promise<void> {
  const answered = searchAnswer(page, query)
  await page.getByRole('searchbox', { name: TEXT.search }).fill(query)
  await answered
}

/** Every CSS animation or transition running or pending on the page. */
function runningAnimations(page: Page) {
  return page.evaluate(() =>
    document.getAnimations().map((animation) => {
      const target = (animation.effect as KeyframeEffect | null)?.target
      return target instanceof Element ? target.getAttribute('class') : String(target)
    }),
  )
}

/** Holds the answers of one RPC until `release()`: the loading state stays on screen. */
async function holdRpc(page: Page, name: string): Promise<() => void> {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/rest/v1/rpc/${name}`, async (route) => {
    await held
    await route.continue()
  })
  return release
}

test.afterAll(async () => {
  await closeDb()
})

test.describe('«Πελάτες» on demo-barber (read-only)', () => {
  test.describe.configure({ timeout: 90_000 })
  test.use({ member: 'owner' })

  test('greeklish search finds the client; the card shows the ring and the counters', async ({
    page,
  }) => {
    await page.goto('/app')
    await page
      .getByRole('navigation', { name: TEXT.nav })
      .getByRole('link', { name: TEXT.tab })
      .click()
    await expect(page).toHaveURL(/\/app\/clients$/)
    await expect(page.getByRole('heading', { level: 1, name: TEXT.title })).toBeVisible()

    // Typed into the empty box: no earlier answer exists, so the list is this query's.
    await search(page, 'giorgos')
    await expect(results(page).getByRole('link', { name: GIORGOS }).first()).toBeVisible()
    await expect(page).toHaveURL(/\/app\/clients\?q=giorgos$/)

    // Each other query on a fresh page (`?q=`): typed into the same box, the list of the previous
    // query stays on screen until the new answer renders (keepPreviousData) and would satisfy the
    // check on its own.
    for (const query of ['GIORGOS', 'Γιωργος', '001']) {
      const answered = searchAnswer(page, query)
      await page.goto(`/app/clients?${new URLSearchParams({ q: query }).toString()}`)
      await answered
      await expect(page.getByRole('searchbox', { name: TEXT.search })).toHaveValue(query)
      await expect(results(page).getByRole('link', { name: GIORGOS }).first()).toBeVisible()
    }
    await expect(page).toHaveURL(/\/app\/clients\?q=001$/)

    await results(page).getByRole('link', { name: GIORGOS }).first().click()
    await expect(page).toHaveURL(/\/app\/clients\/[0-9a-f-]{36}$/)
    await expect(page.getByRole('heading', { level: 1, name: GIORGOS })).toBeVisible()
    await expect(page.getByRole('img', { name: TEXT.ring })).toBeVisible()
    await expect(page.getByText(TEXT.visits, { exact: true })).toBeVisible()
    await expect(page.getByText(TEXT.noShows, { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: /^Κλήση / })).toBeVisible()

    // «Πίσω» returns to the same search.
    await page.getByRole('link', { name: 'Πίσω στους πελάτες' }).click()
    await expect(page).toHaveURL(/\/app\/clients\?q=001$/)
    await expect(page.getByRole('searchbox', { name: TEXT.search })).toHaveValue('001')
  })

  test('with reduced motion nothing moves: still skeletons, the ring final at once', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const releaseSearch = await holdRpc(page, 'search_clients')
    await page.goto('/app/clients?q=giorgos')
    await expect(page.locator('.skeleton').first()).toBeVisible()
    expect(await runningAnimations(page)).toEqual([])
    releaseSearch()
    await expect(results(page).getByRole('link', { name: GIORGOS }).first()).toBeVisible()
    expect(await runningAnimations(page)).toEqual([])

    const releaseCard = await holdRpc(page, 'client_card')
    await results(page).getByRole('link', { name: GIORGOS }).first().click()
    await expect(page.locator('.skeleton').first()).toBeVisible()
    expect(await runningAnimations(page)).toEqual([])
    releaseCard()
    await expect(page.getByRole('img', { name: TEXT.ring })).toBeVisible()
    expect(await runningAnimations(page)).toEqual([])

    // E18: the progress circle (when the shop has an interval to compare with) is already at
    // its final offset.
    const progress = page.locator('.ring-progress')
    if ((await progress.count()) > 0) {
      const { offset, final } = await progress.evaluate((circle) => ({
        offset: Number.parseFloat(getComputedStyle(circle).strokeDashoffset),
        final: Number.parseFloat((circle as SVGElement).style.getPropertyValue('--ring-to')),
      }))
      expect(Number.isFinite(final)).toBe(true)
      expect(offset).toBeCloseTo(final, 1)
    }
  })

  test('loading the search and the card never shifts the layout', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'layout-shift entries exist only in Chromium')
    await page.addInitScript(() => {
      const shifts: number[] = []
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & {
          value: number
          hadRecentInput: boolean
        })[]) {
          if (!entry.hadRecentInput) shifts.push(entry.value)
        }
      })
      observer.observe({ type: 'layout-shift', buffered: true })
      Object.assign(window, { __shifts: shifts, __shiftObserver: observer })
    })
    /** Sum of the layout shifts of this page load, pending entries included. */
    const cls = () =>
      page.evaluate(() => {
        const state = window as unknown as {
          __shifts: number[]
          __shiftObserver: PerformanceObserver
        }
        for (const entry of state.__shiftObserver.takeRecords() as (PerformanceEntry & {
          value: number
          hadRecentInput: boolean
        })[]) {
          if (!entry.hadRecentInput) state.__shifts.push(entry.value)
        }
        return state.__shifts.reduce((sum, value) => sum + value, 0)
      })

    await page.goto('/app/clients?q=giorgos')
    const first = results(page).getByRole('link', { name: GIORGOS }).first()
    await expect(first).toBeVisible()
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
    expect(await cls()).toBeLessThan(0.02)

    const href = await first.getAttribute('href')
    expect(href).toMatch(/\/clients\/[0-9a-f-]{36}$/)
    await page.goto(`/app${href?.replace(/^\/app/, '') ?? ''}`)
    await expect(page.getByRole('img', { name: TEXT.ring })).toBeVisible()
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
    expect(await cls()).toBeLessThan(0.02)
  })
})

test.describe('a staff member opens a card', () => {
  test.describe.configure({ timeout: 90_000 })

  test('no «Ανωνυμοποίηση πελάτη» and never the code sheet', async ({ page }) => {
    await signInWithEmailCode(page, SEED_USERS.staff.email)
    await page.goto('/app/clients?q=giorgos')
    await results(page).getByRole('link', { name: GIORGOS }).first().click()
    await expect(page.getByRole('heading', { level: 1, name: GIORGOS })).toBeVisible()
    await expect(page.getByRole('img', { name: TEXT.ring })).toBeVisible()
    await expect(page.getByRole('button', { name: TEXT.eraseOpen })).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: STEP_UP_TEXT.title })).toHaveCount(0)
  })
})

test.describe('the spec’s own shop: anonymisation and merge', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 })

  let shop: E2eShop
  let staffId: string
  let since: string
  const word = uniqueWord()
  // Never the name of the pgTAP scan's client (15_client_ops: «Ξενοφών Ζαχαρίας»): a run stopped
  // before the erase leaves this client live, and the scan's needles must stay its own.
  const name = `Θεόκλητος Ευσταθίου ${word}`
  const phone = syntheticPhone()
  let fixture: Awaited<ReturnType<typeof createClientFixture>>

  // eslint-disable-next-line no-empty-pattern
  test.beforeAll(async ({}, testInfo) => {
    // Not covered by the describe's timeout (hooks get Playwright's default 30 s).
    test.setTimeout(120_000)
    shop = (await provisionLocal(clientsShopFile(projectOf(testInfo)))).shop
    const staff = shop.staff['Ε2Ε Πελάτες']
    if (!staff) throw new Error('the clients shop has no «Ε2Ε Πελάτες»')
    staffId = staff
    since = await dbNow()
    fixture = await createClientFixture(shop.businessId, staffId, {
      fullName: name,
      phoneE164: phone,
    })
  })

  test('without a fresh code the server refuses erase_client, also called straight', async ({
    page,
  }) => {
    await signInAal2(page, shop.ownerEmail)
    await waitUntilCodeIsStale(page)
    const { status, body } = await memberRest(page, 'POST', 'rpc/erase_client', {
      p_business_id: shop.businessId,
      p_client_id: fixture.clientId,
    })
    expect({ status, body }).toMatchObject({
      status: 403,
      body: { code: '42501', hint: 'fresh_totp_required' },
    })
    expect(await clientRowOf(fixture.clientId)).toMatchObject({
      full_name: name,
      phone_e164: phone,
      erased_at: null,
    })
    expect(
      await auditRowsOf({ actions: ['client_erased'], since, entityId: fixture.clientId }),
    ).toEqual([])
  })

  test('the owner anonymises a client: confirm → code sheet → done; the name is gone', async ({
    page,
  }) => {
    await signInAal2(page, shop.ownerEmail)
    await page.goto('/app/clients')
    await search(page, word)
    await results(page)
      .getByRole('link', { name: new RegExp(word) })
      .click()
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()

    // A note and a consent first, so the anonymisation has something to delete.
    await page.getByRole('textbox', { name: TEXT.note }).fill('Κοντά στο πλάι.')
    await page.getByRole('button', { name: TEXT.save, exact: true }).click()
    await expect(page.getByText(TEXT.noteSaved)).toBeVisible()
    await expect(page.getByRole('list', { name: TEXT.notes })).toContainText('Κοντά στο πλάι.')
    await page.getByRole('switch', { name: TEXT.marketing }).click()
    const consent = page.getByRole('dialog', { name: TEXT.consentSheet })
    await consent.getByRole('button', { name: TEXT.consentConfirm }).click()
    await expect(page.getByText(TEXT.consentRecorded)).toBeVisible()
    await expect(page.getByRole('switch', { name: TEXT.marketing })).toBeChecked()
    expect(await clientChildCountsOf(fixture.clientId)).toEqual({
      notes: 1,
      consents: 1,
      appointments: 1,
    })

    // Every erase_client the app sends: the plan's exit criterion is «one retry» after the sheet.
    const eraseCalls: { status: number; hint: unknown }[] = []
    page.on('response', (response) => {
      if (!response.url().includes('/rest/v1/rpc/erase_client')) return
      const call = { status: response.status(), hint: null as unknown }
      eraseCalls.push(call)
      void response
        .json()
        .then((body: unknown) => {
          if (typeof body === 'object' && body !== null && 'hint' in body) call.hint = body.hint
        })
        .catch(() => {})
    })

    await page.getByRole('button', { name: TEXT.eraseOpen }).click()
    const dialog = page.getByRole('dialog', { name: TEXT.eraseTitle })
    const confirm = dialog.getByRole('button', { name: TEXT.eraseConfirm, exact: true })
    await expect(confirm).toBeDisabled()
    await dialog.getByRole('checkbox', { name: TEXT.understand }).check()
    await waitUntilCodeIsStale(page)
    await confirm.click()
    await answerStepUp(page, shop.ownerEmail)
    await expect(page).toHaveURL(/\/app\/clients$/)
    await expect(page.getByText(TEXT.erasedNotice)).toBeVisible()
    // The refusal with the step-up hint, then exactly one retry, which succeeded.
    await expect
      .poll(() => eraseCalls.map((call) => `${call.status} ${String(call.hint)}`))
      .toEqual(['403 fresh_totp_required', '200 null'])

    // The database: nothing identifying left, the visit kept without a name.
    const row = await clientRowOf(fixture.clientId)
    expect(row).toMatchObject({
      full_name: '',
      phone_e164: null,
      email: null,
      phone_verified_at: null,
      search_text: '',
      merged_into_id: null,
    })
    expect(row.erased_at).not.toBeNull()
    expect(await clientChildCountsOf(fixture.clientId)).toEqual({
      notes: 0,
      consents: 0,
      appointments: 1,
    })
    expect(await suppressedFor(shop.businessId, phone)).toEqual(['erased'])
    const owner = await userIdOf(shop.ownerEmail)
    const audit = await auditRowsOf({
      actions: ['client_erased'],
      since,
      entityId: fixture.clientId,
    })
    expect(audit.map((entry) => [entry.actor_type, entry.actor_id, entry.reason])).toEqual([
      ['staff', owner, 'clients=1'],
    ])

    // The name appears nowhere: not in the search, not on its day.
    await search(page, word)
    await expect(page.getByText(TEXT.none)).toBeVisible()
    await page.goto(`/app/day?date=${fixture.visitDate}`)
    // A rerun on the same day may have left other anonymous visits at that time: any of them.
    await expect(dayAppointment(page, new RegExp(PRO_TEXT.walkInAnonymous)).first()).toBeVisible()
    await expect(page.getByTestId('day-view')).not.toContainText(word)

    // Its card says only that it was erased.
    await page.goto(`/app/clients/${fixture.clientId}`)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Ανωνυμοποιημένος πελάτης' }),
    ).toBeVisible()
    await expect(page.getByText(word)).toHaveCount(0)
  })

  test('merge_clients through the wrapper; the merged address lands on the target', async ({
    page,
  }) => {
    const mergeWord = uniqueWord()
    const source = await createClientFixture(shop.businessId, staffId, {
      fullName: `Σωτήρης Α ${mergeWord}`,
      phoneE164: syntheticPhone(),
      daysAgo: 12,
    })
    const target = await createClientFixture(shop.businessId, staffId, {
      fullName: `Σωτήρης Β ${mergeWord}`,
      phoneE164: syntheticPhone(),
      daysAgo: 10,
    })
    await signInAal2(page, shop.ownerEmail)
    const result = await memberRpc(page, 'merge_clients', {
      p_business_id: shop.businessId,
      p_source: source.clientId,
      p_target: target.clientId,
    })
    expect(result).toMatchObject({
      source_id: source.clientId,
      target_id: target.clientId,
      merged: true,
      appointments: 1,
    })
    expect(await clientRowOf(source.clientId)).toMatchObject({ merged_into_id: target.clientId })

    await page.goto(`/app/clients/${source.clientId}`)
    await expect(page).toHaveURL(new RegExp(`/app/clients/${target.clientId}$`))
    await expect(
      page.getByRole('heading', { level: 1, name: `Σωτήρης Β ${mergeWord}` }),
    ).toBeVisible()
    await expect(page.getByText(`Επίσης ως: Σωτήρης Α ${mergeWord}`)).toBeVisible()
    await expect(
      page.getByRole('region', { name: TEXT.history }).getByRole('listitem'),
    ).toHaveCount(2)

    const owner = await userIdOf(shop.ownerEmail)
    const audit = await auditRowsOf({
      actions: ['clients_merged'],
      since,
      entityId: target.clientId,
    })
    expect(audit.map((entry) => [entry.actor_type, entry.actor_id, entry.reason])).toEqual([
      ['staff', owner, `source=${source.clientId}`],
    ])
  })
})
