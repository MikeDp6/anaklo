import { describe, expect, it, vi } from 'vitest'
import {
  decideTodayCountUp,
  readTodayCountUp,
  TODAY_COUNT_UP_KEY_PREFIX,
  writeTodayCountUp,
} from './todayCountUp'

// Test data: real zones (the business's `timezone`), never the machine's (tests run in UTC).
const ATHENS = 'Europe/Athens'
const NEW_YORK = 'America/New_York'
const BUSINESS = '00000000-0000-4000-8000-000000000001'

describe('decideTodayCountUp (E6 only on the first load of the business-local day)', () => {
  const now = new Date('2026-09-29T08:00:00Z') // 11:00 in Athens

  it('counts up when nothing was shown yet', () => {
    expect(decideTodayCountUp({ now, timeZone: ATHENS, lastShown: null })).toEqual({
      localDate: '2026-09-29',
      countUp: true,
    })
  })

  it('does not count again on the same local date', () => {
    expect(decideTodayCountUp({ now, timeZone: ATHENS, lastShown: '2026-09-29' }).countUp).toBe(
      false,
    )
  })

  it('counts again on the next local date', () => {
    expect(decideTodayCountUp({ now, timeZone: ATHENS, lastShown: '2026-09-28' }).countUp).toBe(
      true,
    )
  })

  it('treats any other stored value as "not shown"', () => {
    for (const garbage of ['', 'yes', '29/09/2026', '{"date":"2026-09-29"}']) {
      expect(decideTodayCountUp({ now, timeZone: ATHENS, lastShown: garbage }).countUp).toBe(true)
    }
  })

  it('uses the business zone: the same instant is a different local date elsewhere', () => {
    const lateEvening = new Date('2026-09-29T21:30:00Z') // 00:30 on the 30th in Athens
    expect(
      decideTodayCountUp({ now: lateEvening, timeZone: ATHENS, lastShown: null }).localDate,
    ).toBe('2026-09-30')
    expect(
      decideTodayCountUp({ now: lateEvening, timeZone: NEW_YORK, lastShown: null }).localDate,
    ).toBe('2026-09-29')
    // Shown on the 29th: New York is still on that day, Athens already on the next one.
    expect(
      decideTodayCountUp({ now: lateEvening, timeZone: NEW_YORK, lastShown: '2026-09-29' }).countUp,
    ).toBe(false)
    expect(
      decideTodayCountUp({ now: lateEvening, timeZone: ATHENS, lastShown: '2026-09-29' }).countUp,
    ).toBe(true)
  })

  it('follows the local date across DST days', () => {
    // 2026-03-29 has 23 hours in Athens: 21:30 UTC is already 00:30 on the 30th.
    expect(
      decideTodayCountUp({
        now: new Date('2026-03-29T21:30:00Z'),
        timeZone: ATHENS,
        lastShown: '2026-03-29',
      }),
    ).toEqual({ localDate: '2026-03-30', countUp: true })
    // 2026-10-25 has 25 hours: 21:30 UTC is still 23:30 on the 25th.
    expect(
      decideTodayCountUp({
        now: new Date('2026-10-25T21:30:00Z'),
        timeZone: ATHENS,
        lastShown: '2026-10-25',
      }),
    ).toEqual({ localDate: '2026-10-25', countUp: false })
  })
})

describe('localStorage adapters', () => {
  it('store the local date per business', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    }
    expect(readTodayCountUp(storage, BUSINESS)).toBeNull()
    writeTodayCountUp(storage, BUSINESS, '2026-09-29')
    expect(values.get(TODAY_COUNT_UP_KEY_PREFIX + BUSINESS)).toBe('2026-09-29')
    expect(readTodayCountUp(storage, BUSINESS)).toBe('2026-09-29')
    expect(readTodayCountUp(storage, 'another-business')).toBeNull()
  })

  it('a throwing or missing storage reads null and never throws on write', () => {
    const throwing = {
      getItem: vi.fn(() => {
        throw new DOMException('denied', 'SecurityError')
      }),
      setItem: vi.fn(() => {
        throw new DOMException('full', 'QuotaExceededError')
      }),
    }
    expect(readTodayCountUp(throwing, BUSINESS)).toBeNull()
    expect(() => writeTodayCountUp(throwing, BUSINESS, '2026-09-29')).not.toThrow()
    expect(readTodayCountUp(undefined, BUSINESS)).toBeNull()
    expect(() => writeTodayCountUp(undefined, BUSINESS, '2026-09-29')).not.toThrow()
  })
})
