import { describe, expect, it } from 'vitest'
import type { WeekRow } from './schema'
import {
  copyDayToAll,
  nextInterval,
  toWeekForm,
  toWeekRows,
  WEEK_HOURS_ERRORS,
  WeekHoursFormSchema,
  type WeekForm,
} from './weekHours'

// Test data only. weekday follows extract(dow): 0 = Sunday … 6 = Saturday.
const ROWS: WeekRow[] = [
  { weekday: 0, startTime: '10:00', endTime: '14:00' },
  { weekday: 2, startTime: '09:00', endTime: '14:00' },
  { weekday: 2, startTime: '17:00', endTime: '21:00' },
  { weekday: 6, startTime: '09:00', endTime: '12:00' },
  { weekday: 6, startTime: '12:00', endTime: '16:00' },
]

const CLOSED: WeekForm = {
  days: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
}

function withDay(day: keyof WeekForm['days'], intervals: WeekForm['days']['mon']): WeekForm {
  return { days: { ...CLOSED.days, [day]: intervals } }
}

function issues(form: WeekForm): Record<string, string> {
  const result = WeekHoursFormSchema.safeParse(form)
  if (result.success) return {}
  return Object.fromEntries(
    result.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
  )
}

describe('toWeekForm / toWeekRows (contract 1.6 §4.5)', () => {
  it('round trip, split shifts and back-to-back intervals included', () => {
    expect(toWeekRows(toWeekForm(ROWS))).toEqual(ROWS)
  })

  it('maps weekdays Monday first, each day by start', () => {
    const form = toWeekForm([
      { weekday: 2, startTime: '17:00', endTime: '21:00' },
      { weekday: 2, startTime: '09:00', endTime: '14:00' },
    ])
    expect(form.days.tue).toEqual([
      { start: '09:00', end: '14:00' },
      { start: '17:00', end: '21:00' },
    ])
    expect(Object.keys(form.days)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
    expect(form.days.mon).toEqual([])
  })

  it('rows are sorted by weekday (Sunday = 0 first), then start', () => {
    const form: WeekForm = {
      days: {
        ...CLOSED.days,
        mon: [{ start: '08:00', end: '09:00' }],
        sun: [{ start: '10:00', end: '12:00' }],
      },
    }
    expect(toWeekRows(form).map((row) => row.weekday)).toEqual([0, 1])
    expect(toWeekRows(toWeekForm([...ROWS].reverse()))).toEqual(ROWS)
  })
})

describe('copyDayToAll (D12)', () => {
  it('copies the day to all seven days, closed ones included', () => {
    const form = toWeekForm(ROWS)
    const copied = copyDayToAll(form, 'tue')
    for (const intervals of Object.values(copied.days)) {
      expect(intervals).toEqual([
        { start: '09:00', end: '14:00' },
        { start: '17:00', end: '21:00' },
      ])
    }
    expect(toWeekRows(copied)).toHaveLength(14)
    // A copy, not the same arrays: editing one day later never edits another.
    expect(copied.days.mon).not.toBe(copied.days.tue)
    expect(form.days.mon).toEqual([])
  })

  it('copying a closed day closes the whole week', () => {
    expect(toWeekRows(copyDayToAll(toWeekForm(ROWS), 'mon'))).toEqual([])
  })
})

describe('WeekHoursFormSchema (UI feedback; the database decides)', () => {
  it('accepts split shifts and back-to-back intervals', () => {
    expect(issues(toWeekForm(ROWS))).toEqual({})
    expect(issues(CLOSED)).toEqual({})
  })

  it('end ≤ start is refused on the end field', () => {
    expect(issues(withDay('wed', [{ start: '14:00', end: '14:00' }]))).toEqual({
      'days.wed.0.end': WEEK_HOURS_ERRORS.endBeforeStart,
    })
    expect(issues(withDay('wed', [{ start: '14:00', end: '09:00' }]))).toEqual({
      'days.wed.0.end': WEEK_HOURS_ERRORS.endBeforeStart,
    })
  })

  it('an overlap is reported on the later interval', () => {
    expect(
      issues(
        withDay('fri', [
          { start: '12:00', end: '18:00' },
          { start: '09:00', end: '14:00' },
        ]),
      ),
    ).toEqual({ 'days.fri.0.start': WEEK_HOURS_ERRORS.overlap })
  })

  it('more than 4 intervals a day are refused', () => {
    const five = ['08', '10', '12', '14', '16'].map((hour) => ({
      start: `${hour}:00`,
      end: `${hour}:30`,
    }))
    expect(issues(withDay('thu', five))).toEqual({ 'days.thu': WEEK_HOURS_ERRORS.tooMany })
    expect(issues(withDay('thu', five.slice(0, 4)))).toEqual({})
  })

  it('a time that is not HH:MM is refused', () => {
    expect(issues(withDay('sat', [{ start: '', end: '25:00' }]))).toEqual({
      'days.sat.0.start': WEEK_HOURS_ERRORS.time,
      'days.sat.0.end': WEEK_HOURS_ERRORS.time,
    })
    // '24:00' (the end of a day as stored) is a valid end.
    expect(issues(withDay('sat', [{ start: '18:00', end: '24:00' }]))).toEqual({})
  })
})

describe('nextInterval', () => {
  it('a closed day gets 09:00–17:00; a split shift starts where the last one ends', () => {
    expect(nextInterval([])).toEqual({ start: '09:00', end: '17:00' })
    expect(nextInterval([{ start: '09:00', end: '14:00' }])).toEqual({
      start: '14:00',
      end: '18:00',
    })
    expect(nextInterval([{ start: '18:00', end: '22:00' }])).toEqual({
      start: '22:00',
      end: '23:59',
    })
  })
})
