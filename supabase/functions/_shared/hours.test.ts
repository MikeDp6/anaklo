import { describe, expect, it } from 'vitest'
import {
  findOverlaps,
  HOUR_MINUTE,
  minutesOf,
  parseInterval,
  toHm,
  WEEKDAY_KEYS,
  WEEKDAYS,
} from './hours.ts'

const iv = (text: string) => parseInterval(text)

describe('WEEKDAYS', () => {
  it('maps to extract(dow): Sunday is 0, Monday 1', () => {
    expect(WEEKDAYS.sun).toBe(0)
    expect(WEEKDAYS.mon).toBe(1)
    expect(WEEKDAYS.sat).toBe(6)
    expect(new Set(Object.values(WEEKDAYS))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]))
  })

  it('lists the week Monday first, every key once', () => {
    expect(WEEKDAY_KEYS).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
    expect([...WEEKDAY_KEYS].sort()).toEqual(Object.keys(WEEKDAYS).sort())
  })
})

describe('HOUR_MINUTE', () => {
  it.each(['00:00', '09:05', '19:59', '23:59'])('accepts %s', (hm) => {
    expect(HOUR_MINUTE.test(hm)).toBe(true)
  })

  it.each(['24:00', '9:00', '09:60', '25:00', '09:00:00', '0900', ' 09:00', ''])(
    'rejects %j',
    (hm) => {
      expect(HOUR_MINUTE.test(hm)).toBe(false)
    },
  )
})

describe('minutesOf', () => {
  it('counts minutes since midnight', () => {
    expect(minutesOf('00:00')).toBe(0)
    expect(minutesOf('09:30')).toBe(570)
    expect(minutesOf('23:59')).toBe(1439)
    expect(minutesOf('24:00')).toBe(1440)
  })

  it('accepts database times with seconds', () => {
    expect(minutesOf('09:30:00')).toBe(570)
  })

  it.each(['24:01', '9:30', 'x', ''])('throws on %j', (hm) => {
    expect(() => minutesOf(hm)).toThrow(TypeError)
  })
})

describe('toHm', () => {
  it('drops the seconds of a Postgres time', () => {
    expect(toHm('09:00:00')).toBe('09:00')
    expect(toHm('22:00:00')).toBe('22:00')
    expect(toHm('24:00:00')).toBe('24:00')
    expect(toHm('07:15:00.000')).toBe('07:15')
  })

  it('keeps an HH:MM value', () => {
    expect(toHm('17:45')).toBe('17:45')
  })

  it.each(['25:00:00', '9:00:00', 'noon', ''])('throws on %j', (value) => {
    expect(() => toHm(value)).toThrow(TypeError)
  })
})

describe('parseInterval', () => {
  it('splits "HH:MM-HH:MM"', () => {
    expect(parseInterval('09:00-14:00')).toEqual({ start: '09:00', end: '14:00' })
  })
})

describe('findOverlaps', () => {
  it('back-to-back intervals do not overlap (as the database, [))', () => {
    expect(findOverlaps([iv('09:00-14:00'), iv('14:00-18:00')])).toEqual([])
  })

  it('reports [earlier, later] by index, whatever the input order', () => {
    expect(findOverlaps([iv('17:00-21:00'), iv('09:00-14:00'), iv('13:59-15:00')])).toEqual([
      [1, 2],
    ])
  })

  it('compares with the interval that ends latest so far', () => {
    expect(findOverlaps([iv('09:00-20:00'), iv('10:00-11:00'), iv('12:00-13:00')])).toEqual([
      [0, 1],
      [0, 2],
    ])
  })

  it('identical intervals overlap', () => {
    expect(findOverlaps([iv('09:00-12:00'), iv('09:00-12:00')])).toEqual([[0, 1]])
  })

  it('handles an end of 24:00 and an empty or single list', () => {
    expect(findOverlaps([{ start: '20:00', end: '24:00' }, iv('23:00-23:30')])).toEqual([[0, 1]])
    expect(findOverlaps([])).toEqual([])
    expect(findOverlaps([iv('09:00-10:00')])).toEqual([])
  })
})
