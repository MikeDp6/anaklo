import type { Page } from '@playwright/test'
import { expect, test } from './lib/fixtures'
import {
  chooseDay,
  chooseService,
  chooseStaff,
  chooseTime,
  enterCode,
  fillDetails,
  openShop,
  PHONES,
  SHOP,
  staffFor,
  TEXT,
  times,
} from './lib/booking'

// Definition of Done of the motion (MOTION.md §6, phase 1 «Σχεδιασμός και κίνηση») on the booking
// page: with reduced motion everything is visible at once and in its final place; the entrances
// never move the layout (transform and opacity only).

/** Opacity and transform of every element that animates in, right now. */
function motionState(page: Page) {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '.reveal, .split-word, .step-enter, .step-enter-back, .confirm-pop',
      ),
    ].map((element) => {
      const style = getComputedStyle(element)
      return {
        className: element.className,
        opacity: style.opacity,
        transform: style.transform,
        animation: style.animationName,
      }
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

async function expectFinal(page: Page) {
  const states = await motionState(page)
  expect(states.length).toBeGreaterThan(0)
  for (const state of states) {
    expect(state, state.className).toMatchObject({
      opacity: '1',
      transform: 'none',
      animation: 'none',
    })
  }
}

test.describe('booking page motion', () => {
  test.describe.configure({ timeout: 90_000 })

  test('with reduced motion every step and the manage link show at once, in their final place', async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openShop(page)
    // E5: the name is one heading for screen readers, its words already in place.
    await expect(page.getByRole('heading', { level: 1, name: SHOP.name })).toHaveAttribute(
      'aria-label',
      SHOP.name,
    )
    await expectFinal(page)
    const frame = await page.evaluate(() => {
      const framed = document.querySelector('.framed')
      return framed ? getComputedStyle(framed, '::after').transform : null
    })
    expect(frame).toBe('matrix(1, 0, 0, 1, 10, 10)') // G5 frame already offset

    await chooseService(page)
    await expectFinal(page)
    await chooseStaff(page, staffFor(testInfo))
    await chooseDay(page, 7)
    await expectFinal(page)
    await chooseTime(page)
    await expectFinal(page)
    // The family phone of the seed: a new browser gets the OTP step, and the phone's clients
    // always bring the client step (Γιώργος preselected, so no new client on re-runs).
    await fillDetails(page, 'Γιώργος Π.', PHONES.family)
    await expect(page.getByLabel(TEXT.codeLabel, { exact: true })).toBeVisible()
    await expectFinal(page)
    await enterCode(page)
    await expect(page.getByRole('heading', { name: TEXT.bookAs })).toBeVisible()
    await expectFinal(page)
    await page.getByRole('button', { name: TEXT.bookCta }).click()
    // E15 only after the server answered, and without motion already complete.
    await expect(page.getByRole('img', { name: TEXT.bookedTitle })).toBeVisible()
    await expectFinal(page)
    expect(await confirmCheckOffset(page)).toBe('0px')

    // The manage link (its own chunk): E3/E5 already in place; E15 after a move, complete.
    const manageHref = await page.getByRole('link', { name: TEXT.manage }).getAttribute('href')
    await page.goto(manageHref ?? '')
    await expect(page.getByRole('heading', { level: 1, name: SHOP.name })).toBeVisible()
    await expectFinal(page)
    await page.getByRole('button', { name: 'Αλλαγή ώρας' }).click()
    await expect(times(page).first()).toBeVisible()
    await times(page).first().click()
    await page.getByRole('button', { name: /^Μετακίνηση: / }).click()
    await expect(page.getByRole('img', { name: 'Το ραντεβού μετακινήθηκε' })).toBeVisible()
    await expectFinal(page)
    expect(await confirmCheckOffset(page)).toBe('0px')
  })

  test('the entrances never shift the layout', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'layout-shift entries exist only in Chromium')
    await page.addInitScript(() => {
      const shifts: number[] = []
      Object.assign(window, { __shifts: shifts })
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & {
          value: number
          hadRecentInput: boolean
        })[]) {
          if (!entry.hadRecentInput) shifts.push(entry.value)
        }
      }).observe({ type: 'layout-shift', buffered: true })
    })
    await openShop(page)
    await page.waitForTimeout(1500) // every entrance of the first screen has run
    await chooseService(page)
    await page.waitForTimeout(800)
    const cls = await page.evaluate(() =>
      ((window as unknown as { __shifts: number[] }).__shifts ?? []).reduce(
        (sum, value) => sum + value,
        0,
      ),
    )
    expect(cls).toBeLessThan(0.02)
  })

  test('touch screens get no hover effects: no liquid fill, no text roll', async ({
    page,
  }, testInfo) => {
    await openShop(page)
    expect(
      await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches),
    ).toBe(false)
    await chooseService(page)
    await chooseStaff(page, staffFor(testInfo))
    await chooseDay(page, 0)
    await chooseTime(page, 'last')
    const cta = page.getByRole('button', { name: 'Συνέχεια' })
    const fill = () =>
      cta.evaluate((button) => ({
        fill: getComputedStyle(button, '::before').transform,
        copy: getComputedStyle(button.querySelector('.roll > span + span') ?? button).display,
      }))
    const before = await fill()
    await cta.hover()
    await page.waitForTimeout(700) // longer than the E1 fill (600ms)
    expect(await fill()).toEqual(before)
    expect(before.copy).toBe('none')
  })
})
