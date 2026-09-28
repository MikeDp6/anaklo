import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  addLocalDays,
  formatInstant,
  formatInZone,
  formatLocalDate,
  isValidTimeZone,
  localDateTimeToInstant,
  toLocalDate,
  toLocalTime,
  weekdayOf,
} from './dates.ts'

// Zones are test data here, not application constants.
const ATHENS = 'Europe/Athens'
const NEW_YORK = 'America/New_York'

describe('test environment', () => {
  it('runs in UTC so machine-zone leaks fail (the dev machine is in Athens)', () => {
    expect(new Date(0).getTimezoneOffset()).toBe(0)
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC')
  })
})

describe('local date of an instant', () => {
  it('uses the business zone, not UTC: 22:30Z on 3 Nov is already 4 Nov in Athens', () => {
    expect(toLocalDate(new Date('2026-11-03T22:30:00Z'), ATHENS)).toBe('2026-11-04')
    expect(toLocalTime(new Date('2026-11-03T22:30:00Z'), ATHENS)).toBe('00:30')
  })

  it('local 00:00–02:59 in Athens belongs to the previous UTC date', () => {
    const instant = localDateTimeToInstant('2026-11-04', '01:15', ATHENS)
    expect(instant.toISOString()).toBe('2026-11-03T23:15:00.000Z')
  })
})

describe('DST in Athens (2026: 29 Mar forward, 25 Oct back)', () => {
  it('uses EET (+02) before and EEST (+03) after spring forward', () => {
    expect(localDateTimeToInstant('2026-03-28', '10:00', ATHENS).toISOString()).toBe(
      '2026-03-28T08:00:00.000Z',
    )
    expect(localDateTimeToInstant('2026-03-29', '10:00', ATHENS).toISOString()).toBe(
      '2026-03-29T07:00:00.000Z',
    )
  })

  it('moves a non-existent local time (03:30 on 29 Mar) forward by the gap', () => {
    const instant = localDateTimeToInstant('2026-03-29', '03:30', ATHENS)
    expect(instant.toISOString()).toBe('2026-03-29T01:30:00.000Z')
    expect(toLocalTime(instant, ATHENS)).toBe('04:30')
  })

  it('resolves an ambiguous local time (03:30 on 25 Oct) to standard time', () => {
    expect(localDateTimeToInstant('2026-10-25', '03:30', ATHENS).toISOString()).toBe(
      '2026-10-25T01:30:00.000Z',
    )
  })

  it('a 10:00 appointment stays at 10:00 local across the change', () => {
    const before = localDateTimeToInstant('2026-10-24', '10:00', ATHENS)
    const after = localDateTimeToInstant('2026-10-26', '10:00', ATHENS)
    expect((after.getTime() - before.getTime()) / 3_600_000).toBe(49)
    expect(toLocalTime(after, ATHENS)).toBe('10:00')
  })
})

describe('another business in another zone', () => {
  it('does not assume Athens (New York changes clocks on other dates)', () => {
    expect(localDateTimeToInstant('2026-03-29', '10:00', NEW_YORK).toISOString()).toBe(
      '2026-03-29T14:00:00.000Z',
    )
    expect(toLocalDate(new Date('2026-11-04T03:00:00Z'), NEW_YORK)).toBe('2026-11-03')
  })
})

// The same answers must come out whatever time zone the DEVICE is in: a barber's phone in Athens,
// an Edge Function in UTC, a laptop abroad. Each case switches the process zone and restores it.
describe.each(['UTC', ATHENS, NEW_YORK, 'Pacific/Auckland'])(
  'on a device set to %s',
  (hostZone) => {
    function onHost<T>(run: () => T): T {
      const previous = process.env.TZ
      process.env.TZ = hostZone
      try {
        return run()
      } finally {
        process.env.TZ = previous
      }
    }

    it.each([
      ['2026-03-29', '03:30', ATHENS, '2026-03-29T01:30:00.000Z'], // gap → moved forward
      ['2026-03-29', '02:59', ATHENS, '2026-03-29T00:59:00.000Z'], // just before the gap
      ['2026-03-29', '04:00', ATHENS, '2026-03-29T01:00:00.000Z'], // just after the gap
      ['2026-10-25', '03:30', ATHENS, '2026-10-25T01:30:00.000Z'], // ambiguous → standard time
      ['2026-10-24', '23:00', ATHENS, '2026-10-24T20:00:00.000Z'], // the evening before
      ['2026-11-01', '01:30', NEW_YORK, '2026-11-01T06:30:00.000Z'], // NY fall back → EST
      ['2026-03-08', '02:30', NEW_YORK, '2026-03-08T07:30:00.000Z'], // NY gap → moved forward
    ])('%s %s in %s is %s', (date, time, zone, iso) => {
      expect(onHost(() => localDateTimeToInstant(date, time, zone).toISOString())).toBe(iso)
    })

    it('reads the local date and time of an instant the same way', () => {
      expect(onHost(() => toLocalDate(new Date('2026-11-03T22:30:00Z'), ATHENS))).toBe('2026-11-04')
      expect(onHost(() => toLocalTime(new Date('2026-03-29T01:30:00Z'), ATHENS))).toBe('04:30')
    })
  },
)

describe('calendar arithmetic', () => {
  it('adds calendar days across DST and month ends', () => {
    expect(addLocalDays('2026-03-28', 1)).toBe('2026-03-29')
    expect(addLocalDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addLocalDays('2026-12-31', 28)).toBe('2027-01-28')
    expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('numbers weekdays like the database (0 = Sunday)', () => {
    expect(weekdayOf('2026-09-27')).toBe(0)
    expect(weekdayOf('2026-09-29')).toBe(2)
  })
})

describe('validation and formatting', () => {
  it('rejects unknown zones and malformed values', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
    expect(() => toLocalDate(new Date(), 'Mars/Olympus')).toThrow(RangeError)
    expect(() => localDateTimeToInstant('2026-13-01', '10:00', ATHENS)).toThrow(RangeError)
    expect(() => localDateTimeToInstant('2026-02-30', '10:00', ATHENS)).toThrow(RangeError)
    expect(() => addLocalDays('2026-02-29', 1)).toThrow(RangeError)
    expect(() => localDateTimeToInstant('2026-11-01', '24:00', ATHENS)).toThrow(RangeError)
  })

  it('formats in the business zone and app locale', () => {
    const instant = new Date('2026-11-03T15:30:00Z')
    expect(formatInZone(instant, ATHENS, 'EEEE d MMMM, HH:mm', 'el')).toBe(
      'Τρίτη 3 Νοεμβρίου, 17:30',
    )
    expect(formatInZone(instant, ATHENS, 'EEEE d MMMM, HH:mm', 'en')).toBe(
      'Tuesday 3 November, 17:30',
    )
  })
})

describe('Intl formatting (the booking page: no date-fns)', () => {
  it('formats a calendar date without shifting it, on any device zone', () => {
    const previous = process.env.TZ
    for (const hostZone of ['Pacific/Auckland', 'America/New_York']) {
      process.env.TZ = hostZone
      expect(formatLocalDate('2026-10-01', 'el', { weekday: 'long', day: 'numeric' })).toBe(
        'Πέμπτη 1',
      )
    }
    process.env.TZ = previous
    expect(formatLocalDate('2026-10-01', 'en', { weekday: 'short' })).toBe('Thu')
    expect(() => formatLocalDate('2026-02-30', 'el', { day: 'numeric' })).toThrow(RangeError)
  })

  it('formats an instant in the business zone, 24h', () => {
    const instant = new Date('2026-10-25T00:30:00Z') // 03:30 EEST (before the change back)
    const time = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const
    expect(formatInstant(instant, ATHENS, 'el', time)).toBe('03:30')
    expect(formatInstant(instant, NEW_YORK, 'en', time)).toBe('20:30')
    expect(formatInstant(new Date('2026-11-03T22:30:00Z'), ATHENS, 'el', { day: 'numeric' })).toBe(
      '4',
    )
    expect(() => formatInstant(instant, 'Mars/Olympus', 'el', time)).toThrow(RangeError)
  })

  it('reads midnight as 00, never 24', () => {
    expect(toLocalTime(new Date('2026-10-31T22:00:00Z'), ATHENS)).toBe('00:00')
    expect(toLocalDate(new Date('2026-10-31T22:00:00Z'), ATHENS)).toBe('2026-11-01')
  })
})

describe('local-dates.ts (what the booking page imports)', () => {
  it('uses Intl only: no date-fns and no @date-fns/tz (module side effects, size budget)', () => {
    const source = readFileSync(
      join(process.cwd(), 'supabase/functions/_shared/local-dates.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/from\s+['"](date-fns|@date-fns)/)
  })
})
