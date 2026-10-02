import type { Page } from '@playwright/test'
import { staffFor } from './lib/booking'
import { expect, test } from './lib/fixtures'
import { LOGIN_TEXT, signInWithEmailCode } from './lib/login'
import {
  bookTodayViaApi,
  cancelTodayBooking,
  chooseDayWithTimes,
  chooseTime,
  dayAppointment,
  openQuickAdd,
  openToday,
  PRO_TEXT,
  sheet,
} from './lib/pro'
import { SEED_USERS } from './lib/seedUsers'

// Definition of Done of the motion (MOTION.md §6) in the pro app, minimal level (step 1.4): with
// reduced motion nothing moves, «Σήμερα» shows its final numbers at once (E6 is skipped even on
// the first load of the day), the quick-add steps (E14) appear in their final place, and the day
// calendar, the appointment sheet and E15 are final at once; loading never shifts the layout; a
// touch screen gets no hover effect. Since 1.7 the owner's tests start from the setup project's
// `aal2` session (`member: 'owner'`, contract 1.7 §7.4).

/** Every CSS animation or transition running or pending on the page. */
function runningAnimations(page: Page) {
  return page.evaluate(() =>
    document.getAnimations().map((animation) => {
      const target = (animation.effect as KeyframeEffect | null)?.target
      return target instanceof Element ? target.className : String(target)
    }),
  )
}

/** E15: how much of the check is still undrawn ('0px' = complete). */
function confirmCheckOffset(page: Page) {
  return page.evaluate(() => {
    const path = document.querySelector('.confirm-check')
    return path ? getComputedStyle(path).strokeDashoffset : null
  })
}

/** Opacity and transform of the elements that would animate in. */
function entranceStates(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.step-enter, .step-enter-back, .confirm-pop')].map((element) => {
      const style = getComputedStyle(element)
      return { opacity: style.opacity, transform: style.transform, animation: style.animationName }
    }),
  )
}

test.describe('pro app with reduced motion', () => {
  test.describe.configure({ timeout: 90_000 })

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
  })

  test('the sign-in screen does not move', async ({ page }) => {
    await page.goto('/app/login')
    await expect(page.getByLabel(LOGIN_TEXT.emailLabel)).toBeVisible()
    expect(await runningAnimations(page)).toEqual([])
  })

  test('«Χωρίς πρόσβαση» does not move', async ({ page }) => {
    await signInWithEmailCode(page, SEED_USERS.noMember.email)
    await expect(page.getByRole('heading', { level: 1, name: 'Χωρίς πρόσβαση' })).toBeVisible()
    expect(await runningAnimations(page)).toEqual([])
  })

  test.describe('outside the installed app', () => {
    // Opt out of the installed-app pretence of the mobile-safari project (see pro-login.spec).
    test.use({ standalone: false })

    test('the install screen does not move', async ({ page, browserName }) => {
      test.skip(browserName !== 'webkit', 'the install screen is iOS only')
      await page.goto('/app')
      await expect(
        page.getByRole('heading', { level: 1, name: 'Πρόσθεσε πρώτα στην αρχική οθόνη' }),
      ).toBeVisible()
      expect(await runningAnimations(page)).toEqual([])
    })
  })

  test.describe('signed in as the owner', () => {
    test.use({ member: 'owner' })

    test('«Σήμερα» shows the final numbers at once, also on the first load of the day', async ({
      page,
    }, testInfo) => {
      // The session is in the page once the app opened.
      await openToday(page)
      // A priced appointment today, so both numbers are above 0: at 0 the check proves nothing
      // (a count from 0 to 0 shows 0 at every frame, with or without reduced motion).
      const booked = await bookTodayViaApi(page, staffFor(testInfo))
      try {
        // Forget that today was already shown on this device: E6 would count up now with motion on.
        await page.evaluate(() => {
          for (const key of Object.keys(localStorage)) {
            if (key.startsWith('anaklo:pro:today-count-up:')) localStorage.removeItem(key)
          }
        })
        await openToday(page)

        for (const id of ['today-total', 'today-revenue']) {
          const number = page.getByTestId(id)
          await expect(number).toBeVisible()
          // The number on screen (aria-hidden) is the final one (the screen-reader copy) at once.
          const [shown, final] = await number.evaluate((element) => [
            element.firstElementChild?.textContent ?? '',
            element.lastElementChild?.textContent ?? '',
          ])
          expect(final, `${id}: a non-zero final value`).toMatch(/[1-9]/)
          expect(shown, id).toBe(final)
        }
        expect(await runningAnimations(page)).toEqual([])
      } finally {
        await cancelTodayBooking(page, booked)
      }
    })

    test('the quick-add steps appear in their final place', async ({ page }) => {
      await openToday(page)
      const dialog = await openQuickAdd(page)
      await dialog.getByRole('button', { name: 'Νέος πελάτης' }).click()
      await dialog.getByLabel('Ονοματεπώνυμο').fill('Χωρίς Κίνηση')
      await dialog.getByRole('button', { name: 'Συνέχεια' }).click()
      await expect(dialog.getByRole('button', { name: /^Κούρεμα\s*\d/ })).toBeVisible()

      const states = await entranceStates(page)
      expect(states.length).toBeGreaterThan(0)
      for (const state of states) {
        expect(state).toMatchObject({ opacity: '1', transform: 'none', animation: 'none' })
      }
      expect(await runningAnimations(page)).toEqual([])
    })
  })
})

test.describe('pro app with reduced motion: calendar, sheets, E15', () => {
  test.describe.configure({ timeout: 120_000 })
  test.use({ member: 'owner' })

  test('a booking, its day and its sheet show at once, E15 already drawn', async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const staff = staffFor(testInfo)
    const name = `Χωρίς κίνηση ${testInfo.project.name.replace('mobile-', '')} ${Date.now().toString(36)}`
    await openToday(page)

    // Its own window of days (pro-day-ops uses 3–5), so parallel runs never share a time.
    const dialog = await openQuickAdd(page)
    await dialog.getByRole('button', { name: PRO_TEXT.newClient }).click()
    await dialog.getByLabel(PRO_TEXT.fullName).fill(name)
    await dialog.getByRole('button', { name: PRO_TEXT.continue }).click()
    await dialog.getByRole('button', { name: /^Κούρεμα\s*\d/ }).click()
    await dialog.getByRole('button', { name: staff, exact: true }).click()
    const date = await chooseDayWithTimes(dialog, 6)
    const time = await chooseTime(dialog)
    await dialog.getByRole('button', { name: PRO_TEXT.book }).click()
    await expect(dialog.getByRole('img', { name: PRO_TEXT.booked })).toBeVisible()
    expect(await confirmCheckOffset(page)).toBe('0px')
    expect(await runningAnimations(page)).toEqual([])
    await dialog.getByRole('button', { name: PRO_TEXT.done }).click()
    await expect(dialog).toHaveCount(0)

    await page.goto(`/app/day?date=${date}`)
    const booked = dayAppointment(page, new RegExp(name))
    await expect(booked).toHaveAccessibleName(new RegExp(`^${time.label}`))
    expect(await runningAnimations(page)).toEqual([])
    await booked.click()
    await expect(sheet(page).getByRole('button', { name: PRO_TEXT.move })).toBeVisible()
    expect(await runningAnimations(page)).toEqual([])
  })
})

test.describe('pro app layout and touch', () => {
  test.describe.configure({ timeout: 90_000 })
  test.use({ member: 'owner' })

  test('loading «Σήμερα» and the day calendar never shifts the layout', async ({
    page,
    browserName,
  }) => {
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
    /** Sum of the layout shifts so far, pending entries included. */
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

    // Fresh page loads: the skeletons give way to the data without an input in between.
    await openToday(page)
    await expect(page.getByTestId('today-total')).toBeVisible()
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
    expect(await cls()).toBeLessThan(0.02)

    await page.goto('/app/day')
    await expect(page.getByTestId('day-view')).toBeVisible()
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
    expect(await cls()).toBeLessThan(0.02)
  })

  test('touch screens get no hover effect: no text roll, nothing starts', async ({ page }) => {
    await openToday(page)
    expect(
      await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches),
    ).toBe(false)
    const cta = page.getByRole('button', { name: PRO_TEXT.newAppointment, exact: true })
    const rollCopy = () =>
      cta.evaluate(
        (button) => getComputedStyle(button.querySelector('.roll > span + span') ?? button).display,
      )
    expect(await rollCopy()).toBe('none')
    await cta.hover()
    // A hover effect would start a transition or an animation on the button now.
    expect(
      await cta.evaluate((button) =>
        button.getAnimations({ subtree: true }).map((animation) => animation.constructor.name),
      ),
    ).toEqual([])
    expect(await rollCopy()).toBe('none')
  })
})
