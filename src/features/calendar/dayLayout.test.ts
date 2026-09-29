import { describe, expect, it } from 'vitest'
import { localDateTimeToInstant } from '@/shared/lib/dates'
import {
  dayLengthMinutes,
  hourMarks,
  layoutColumn,
  minutesBetween,
  nowOffset,
  visibleRange,
  type DayRange,
  type TimedItem,
} from './dayLayout'

// Test data: the demo shop's zone. In 2026 Greece moves to summer time on Sunday 29 March
// (03:00 → 04:00) and back on Sunday 25 October (04:00 → 03:00).
const ZONE = 'Europe/Athens'

function day(date: string, next: string) {
  return {
    dayStart: localDateTimeToInstant(date, '00:00', ZONE),
    dayEnd: localDateTimeToInstant(next, '00:00', ZONE),
  }
}

function at(date: string, time: string): string {
  return localDateTimeToInstant(date, time, ZONE).toISOString()
}

function item(id: string, date: string, from: string, to: string): TimedItem {
  return { id, startsAt: at(date, from), endsAt: at(date, to) }
}

describe('dayLayout: time → position in real elapsed minutes', () => {
  it('an ordinary day has 24 hours and positions equal the wall clock', () => {
    const { dayStart, dayEnd } = day('2026-09-29', '2026-09-30')
    expect(dayLengthMinutes(dayStart, dayEnd)).toBe(1440)
    expect(minutesBetween(dayStart, at('2026-09-29', '10:00'))).toBe(600)
  })

  it('the spring-forward day has 23 hours and no 03:00', () => {
    const { dayStart, dayEnd } = day('2026-03-29', '2026-03-30')
    expect(dayStart.toISOString()).toBe('2026-03-28T22:00:00.000Z')
    expect(dayLengthMinutes(dayStart, dayEnd)).toBe(1380)

    const labels = hourMarks(dayStart, ZONE, { fromMin: 0, toMin: 1380 }).map((m) => m.label)
    expect(labels.slice(0, 5)).toEqual(['00:00', '01:00', '02:00', '04:00', '05:00'])
    expect(labels).not.toContain('03:00')
    expect(labels).toHaveLength(24)
    expect(labels.at(-1)).toBe('00:00')

    // 10:00 local is only 9 real hours after midnight: drawn one hour higher than on other days.
    expect(minutesBetween(dayStart, at('2026-03-29', '10:00'))).toBe(540)
  })

  it('the fall-back day has 25 hours and shows 03:00 twice', () => {
    const { dayStart, dayEnd } = day('2026-10-25', '2026-10-26')
    expect(dayStart.toISOString()).toBe('2026-10-24T21:00:00.000Z')
    expect(dayLengthMinutes(dayStart, dayEnd)).toBe(1500)

    const labels = hourMarks(dayStart, ZONE, { fromMin: 0, toMin: 1500 }).map((m) => m.label)
    expect(labels.slice(0, 6)).toEqual(['00:00', '01:00', '02:00', '03:00', '03:00', '04:00'])
    expect(labels).toHaveLength(26)

    // 10:00 local is 11 real hours after midnight.
    expect(minutesBetween(dayStart, at('2026-10-25', '10:00'))).toBe(660)
    // An ambiguous 03:30 resolves to standard time (like PostgreSQL): the second one.
    expect(minutesBetween(dayStart, at('2026-10-25', '03:30'))).toBe(270)
  })

  it('an appointment on a 25-hour day is placed and sized in real minutes', () => {
    const { dayStart } = day('2026-10-25', '2026-10-26')
    const range: DayRange = { fromMin: 600, toMin: 1500 }
    const [placed] = layoutColumn([item('a', '2026-10-25', '10:00', '10:30')], dayStart, range)
    expect(placed).toMatchObject({ top: 60, height: 30, lane: 0, lanes: 1 })
  })
})

describe('visibleRange', () => {
  const { dayStart, dayEnd } = day('2026-09-29', '2026-09-30')
  const base = { localDate: '2026-09-29', timeZone: ZONE, dayStart, dayEnd }

  it('covers every instant, in whole hours', () => {
    const range = visibleRange({
      ...base,
      instants: [
        at('2026-09-29', '09:00'),
        at('2026-09-29', '14:00'),
        at('2026-09-29', '17:00'),
        at('2026-09-29', '21:10'),
      ],
    })
    expect(range).toEqual({ fromMin: 540, toMin: 1320 })
  })

  it('a closed day falls back to 08:00–20:00 local', () => {
    expect(visibleRange({ ...base, instants: [] })).toEqual({ fromMin: 480, toMin: 1200 })
  })

  it('never leaves the day, also for an appointment from the evening before', () => {
    const range = visibleRange({
      ...base,
      instants: [at('2026-09-28', '23:00'), at('2026-09-29', '01:00')],
    })
    expect(range).toEqual({ fromMin: 0, toMin: 60 })
  })

  it('on the 23-hour day ends at its real length', () => {
    const spring = day('2026-03-29', '2026-03-30')
    const range = visibleRange({
      localDate: '2026-03-29',
      timeZone: ZONE,
      ...spring,
      instants: [at('2026-03-29', '22:00'), at('2026-03-30', '00:00')],
    })
    // 22:00 local is 21 real hours after midnight; the day ends 2 hours later, at 1380.
    expect(range).toEqual({ fromMin: 1260, toMin: 1380 })
  })
})

describe('layoutColumn: overlapping appointments get lanes', () => {
  const { dayStart } = day('2026-09-29', '2026-09-30')
  const range: DayRange = { fromMin: 540, toMin: 1260 }

  it('a chain of overlaps shares two lanes; touching items do not overlap', () => {
    const placed = layoutColumn(
      [
        item('c', '2026-09-29', '10:30', '11:00'),
        item('a', '2026-09-29', '10:00', '10:30'),
        item('b', '2026-09-29', '10:15', '10:45'),
        item('d', '2026-09-29', '12:00', '12:30'),
        item('e', '2026-09-29', '12:30', '13:00'),
      ],
      dayStart,
      range,
    )
    const byId = Object.fromEntries(placed.map((p) => [p.item.id, p]))
    expect(byId.a).toMatchObject({ top: 60, height: 30, lane: 0, lanes: 2 })
    expect(byId.b).toMatchObject({ top: 75, lane: 1, lanes: 2 })
    expect(byId.c).toMatchObject({ top: 90, lane: 0, lanes: 2 })
    expect(byId.d).toMatchObject({ top: 180, lane: 0, lanes: 1 })
    expect(byId.e).toMatchObject({ top: 210, lane: 0, lanes: 1 })
  })

  it('three at the same time get three lanes', () => {
    const placed = layoutColumn(
      [
        item('x', '2026-09-29', '10:00', '11:00'),
        item('y', '2026-09-29', '10:00', '10:30'),
        item('z', '2026-09-29', '10:10', '10:40'),
      ],
      dayStart,
      range,
    )
    expect(placed.map((p) => [p.item.id, p.lane, p.lanes])).toEqual([
      ['x', 0, 3],
      ['y', 1, 3],
      ['z', 2, 3],
    ])
  })

  it('a very short item is drawn at the minimum height, and that height counts as overlap', () => {
    const placed = layoutColumn(
      [item('short', '2026-09-29', '10:00', '10:05'), item('next', '2026-09-29', '10:05', '10:35')],
      dayStart,
      range,
      15,
    )
    expect(placed.map((p) => [p.item.id, p.height, p.lane, p.lanes])).toEqual([
      ['short', 15, 0, 2],
      ['next', 30, 1, 2],
    ])
  })

  it('clips items at the edges and drops those outside', () => {
    const placed = layoutColumn(
      [
        item('before', '2026-09-29', '08:00', '09:00'),
        item('across', '2026-09-29', '08:30', '09:30'),
        item('after', '2026-09-29', '21:00', '21:30'),
      ],
      dayStart,
      range,
    )
    expect(placed.map((p) => [p.item.id, p.top, p.height])).toEqual([['across', 0, 30]])
  })
})

describe('nowOffset', () => {
  it('places «now» inside the range, or nowhere', () => {
    const { dayStart } = day('2026-09-29', '2026-09-30')
    const range: DayRange = { fromMin: 540, toMin: 1260 }
    expect(nowOffset(new Date(at('2026-09-29', '10:15')), dayStart, range)).toBe(75)
    expect(nowOffset(new Date(at('2026-09-29', '07:00')), dayStart, range)).toBeNull()
  })
})
