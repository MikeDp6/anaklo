import { describe, expect, it } from 'vitest'
import type { TimeOff } from './schema'
import {
  TIME_OFF_ERRORS,
  timeOffFormSchema,
  timeOffSpan,
  toTimeOffForm,
  toTimeOffRange,
  type TimeOffFormValues,
} from './timeOffRange'

const ATHENS = 'Europe/Athens'
const STAFF = '00000000-0000-4000-8000-0000000000a1'
const NOW = new Date('2026-10-02T07:00:00Z')

function form(partial: Partial<TimeOffFormValues> = {}): TimeOffFormValues {
  return {
    staffId: STAFF,
    reason: 'vacation',
    allDay: true,
    fromDate: '2026-10-24',
    toDate: '2026-10-25',
    fromTime: '',
    toTime: '',
    ...partial,
  }
}

function errorsOf(values: TimeOffFormValues, isNew = true): Record<string, string> {
  const result = timeOffFormSchema({ timeZone: ATHENS, now: NOW, isNew }).safeParse(values)
  if (result.success) return {}
  return Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message]))
}

describe('toTimeOffRange (contract 1.6 §4.7)', () => {
  it('all day across the 25-hour day (2026-10-25): local midnights at each offset', () => {
    const range = toTimeOffRange(form(), ATHENS)
    expect(range).toEqual({
      startsAt: '2026-10-23T21:00:00.000Z', // 24th 00:00 at UTC+3
      endsAt: '2026-10-25T22:00:00.000Z', // 26th 00:00 at UTC+2
    })
    expect((Date.parse(range.endsAt) - Date.parse(range.startsAt)) / 3_600_000).toBe(49)
  })

  it('part of a day: the local times', () => {
    expect(
      toTimeOffRange(
        form({
          allDay: false,
          fromDate: '2026-10-05',
          toDate: '2026-10-05',
          fromTime: '10:00',
          toTime: '13:30',
        }),
        ATHENS,
      ),
    ).toEqual({ startsAt: '2026-10-05T07:00:00.000Z', endsAt: '2026-10-05T10:30:00.000Z' })
  })

  it('round trip: a stored all-day range reads back as all day with inclusive dates', () => {
    const range = toTimeOffRange(form(), ATHENS)
    const row: TimeOff = { id: 'x', staffId: STAFF, reason: 'vacation', ...range }
    expect(toTimeOffForm(row, ATHENS)).toEqual(form())
    expect(timeOffSpan(row, ATHENS)).toEqual({ kind: 'days', from: '2026-10-24', to: '2026-10-25' })
  })

  it('a part of a day reads back with its times', () => {
    const row: TimeOff = {
      id: 'x',
      staffId: STAFF,
      reason: 'leave',
      startsAt: '2026-10-05T07:00:00Z',
      endsAt: '2026-10-05T10:30:00Z',
    }
    expect(timeOffSpan(row, ATHENS)).toEqual({
      kind: 'times',
      date: '2026-10-05',
      from: '10:00',
      to: '13:30',
    })
  })
})

describe('timeOffFormSchema', () => {
  it('a valid range passes', () => {
    expect(errorsOf(form())).toEqual({})
  })

  it('the end must be after the start', () => {
    expect(errorsOf(form({ fromDate: '2026-10-25', toDate: '2026-10-24' }))).toEqual({
      toDate: TIME_OFF_ERRORS.endBeforeStart,
    })
    expect(
      errorsOf(
        form({
          allDay: false,
          fromDate: '2026-10-05',
          toDate: '2026-10-05',
          fromTime: '12:00',
          toTime: '12:00',
        }),
      ),
    ).toEqual({ toTime: TIME_OFF_ERRORS.endBeforeStart })
  })

  it('at most 366 days (what the conflicts list answers), new or existing', () => {
    // 2026-10-05 … 2027-10-05: 366 local dates, 8784 hours (one autumn, one spring change).
    expect(errorsOf(form({ fromDate: '2026-10-05', toDate: '2027-10-05' }))).toEqual({})
    const tooLong = form({ fromDate: '2026-10-05', toDate: '2027-12-31' })
    expect(errorsOf(tooLong)).toEqual({ toDate: TIME_OFF_ERRORS.tooLong })
    expect(errorsOf(tooLong, false)).toEqual({ toDate: TIME_OFF_ERRORS.tooLong })
    expect(errorsOf(form({ fromDate: '2026-10-05', toDate: '2027-10-06' }))).toEqual({
      toDate: TIME_OFF_ERRORS.tooLong,
    })
    // With times: 366 days and one minute.
    expect(
      errorsOf(
        form({
          allDay: false,
          fromDate: '2026-10-05',
          toDate: '2027-10-06',
          fromTime: '10:00',
          toTime: '10:01',
        }),
      ),
    ).toEqual({ toTime: TIME_OFF_ERRORS.tooLong })
  })

  it('a new time off must end after now; an existing one may be corrected', () => {
    const past = form({ fromDate: '2026-09-01', toDate: '2026-09-02' })
    expect(errorsOf(past)).toEqual({ toDate: TIME_OFF_ERRORS.endPast })
    expect(errorsOf(past, false)).toEqual({})
  })

  it('staff member, dates and (when not all day) times are required', () => {
    expect(errorsOf(form({ staffId: '', fromDate: '', toDate: '' }))).toEqual({
      staffId: TIME_OFF_ERRORS.staffRequired,
      fromDate: TIME_OFF_ERRORS.dateRequired,
      toDate: TIME_OFF_ERRORS.dateRequired,
    })
    expect(errorsOf(form({ allDay: false }))).toEqual({
      fromTime: TIME_OFF_ERRORS.timeRequired,
      toTime: TIME_OFF_ERRORS.timeRequired,
    })
  })
})
