import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import type { TodaySummary } from '../schema'
import { TODAY_COUNT_UP_KEY_PREFIX } from '../todayCountUp'
import { TodayStats } from './TodayStats'

// Test data only: the demo shop.
const BUSINESS = '00000000-0000-4000-8000-000000000001'

const SUMMARY: TodaySummary = {
  localDate: '2026-09-29',
  timeZone: 'Europe/Athens',
  currency: 'EUR',
  scope: 'business',
  counts: { total: 12, remaining: 5, toMark: 0 },
  expectedRevenueCents: 15_600,
  next: [],
  gaps: [],
  toMark: [],
}

function reducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: reduce,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  )
}

/** requestAnimationFrame by hand: `frame(ms)` runs what is queued at time `ms`. */
function frames() {
  let queue: FrameRequestCallback[] = []
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => queue.push(callback)),
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  return {
    frame(time: number) {
      const due = queue
      queue = []
      act(() => {
        for (const callback of due) callback(time)
      })
    },
  }
}

function show(summary: TodaySummary = SUMMARY) {
  return render(
    <MemoryRouter>
      <TodayStats key={summary.localDate} businessId={BUSINESS} summary={summary} />
    </MemoryRouter>,
  )
}

const shownTotal = () => screen.getByTestId('today-total').firstElementChild?.textContent
const shownRevenue = () => screen.getByTestId('today-revenue').firstElementChild?.textContent

beforeAll(async () => {
  await initI18n(proCatalogues)
})

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-29T08:00:00Z') })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('TodayStats (E6 on «Σήμερα»)', () => {
  it('with reduced motion shows the final numbers at once, also on the first load', () => {
    reducedMotion(true)
    show()
    expect(shownTotal()).toBe('12')
    expect(shownRevenue()).toMatch(/156,00/)
    // The count still counts as shown for today.
    expect(localStorage.getItem(TODAY_COUNT_UP_KEY_PREFIX + BUSINESS)).toBe('2026-09-29')
  })

  it('counts up on the first load of the local day, then never again that day', () => {
    reducedMotion(false)
    const clock = frames()
    const first = show()
    expect(shownTotal()).toBe('0')
    clock.frame(0)
    clock.frame(2000)
    expect(shownTotal()).toBe('12')
    expect(localStorage.getItem(TODAY_COUNT_UP_KEY_PREFIX + BUSINESS)).toBe('2026-09-29')

    // A 60″ refetch with new numbers: shown directly.
    first.rerender(
      <MemoryRouter>
        <TodayStats
          key={SUMMARY.localDate}
          businessId={BUSINESS}
          summary={{ ...SUMMARY, counts: { ...SUMMARY.counts, total: 13 } }}
        />
      </MemoryRouter>,
    )
    expect(shownTotal()).toBe('13')
    first.unmount()

    // Opening «Σήμερα» again the same day: final numbers at once.
    show()
    expect(shownTotal()).toBe('12')
  })

  it('staff see no revenue (null from the server)', () => {
    reducedMotion(true)
    show({ ...SUMMARY, scope: 'own', expectedRevenueCents: null })
    expect(screen.queryByTestId('today-revenue')).toBeNull()
    expect(screen.getByText('Τα ραντεβού σου σήμερα')).toBeInTheDocument()
  })

  it('each number has its action', () => {
    reducedMotion(true)
    show()
    expect(screen.getByRole('button', { name: 'Δες το ημερολόγιο' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Δες τα ραντεβού' })).toBeInTheDocument()
  })
})
