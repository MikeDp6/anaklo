import { describe, expect, it } from 'vitest'
import {
  CLOSURE_ERRORS,
  closureFormSchema,
  dateCount,
  MAX_CLOSURE_DATES,
  prefillIntervals,
  toExceptionRows,
  type ClosureFormValues,
} from './closureRows'

const STAFF = '00000000-0000-4000-8000-0000000000a1'
const TODAY = '2026-10-02'

function form(partial: Partial<ClosureFormValues> = {}): ClosureFormValues {
  return {
    scope: '',
    kind: 'closed',
    from: '2026-12-25',
    to: '2026-12-26',
    intervals: [],
    note: '',
    ...partial,
  }
}

function counter() {
  let n = 0
  return () => {
    n += 1
    return `id-${n}`
  }
}

/** The i18n keys the schema reports, by path. */
function errorsOf(values: ClosureFormValues): Record<string, string> {
  const result = closureFormSchema(TODAY).safeParse(values)
  if (result.success) return {}
  return Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message]))
}

describe('toExceptionRows (contract 1.6 §4.6)', () => {
  it('closed: one row per date, with the shop note', () => {
    expect(toExceptionRows(form({ note: ' Αργία ' }), counter())).toEqual([
      {
        id: 'id-1',
        staffId: null,
        localDate: '2026-12-25',
        kind: 'closed',
        startTime: null,
        endTime: null,
        note: 'Αργία',
      },
      {
        id: 'id-2',
        staffId: null,
        localDate: '2026-12-26',
        kind: 'closed',
        startTime: null,
        endTime: null,
        note: 'Αργία',
      },
    ])
  })

  it('special hours: one row per date × interval, intervals in time order', () => {
    const rows = toExceptionRows(
      form({
        scope: STAFF,
        kind: 'open',
        intervals: [
          { start: '17:00', end: '20:00' },
          { start: '10:00', end: '14:00' },
        ],
      }),
      counter(),
    )
    expect(rows.map((r) => [r.localDate, r.startTime, r.endTime, r.staffId])).toEqual([
      ['2026-12-25', '10:00', '14:00', STAFF],
      ['2026-12-25', '17:00', '20:00', STAFF],
      ['2026-12-26', '10:00', '14:00', STAFF],
      ['2026-12-26', '17:00', '20:00', STAFF],
    ])
    expect(new Set(rows.map((r) => r.id)).size).toBe(4)
  })

  it('never a note on a staff member’s row (GDPR art. 9, D4)', () => {
    const rows = toExceptionRows(form({ scope: STAFF, note: 'κάτι' }), counter())
    expect(rows.every((r) => r.note === null)).toBe(true)
  })

  it('an empty note is no note', () => {
    expect(toExceptionRows(form({ note: '   ' }), counter())[0]?.note).toBeNull()
  })

  it('crosses month and year ends by calendar date', () => {
    const rows = toExceptionRows(form({ from: '2026-12-31', to: '2027-01-01' }), counter())
    expect(rows.map((r) => r.localDate)).toEqual(['2026-12-31', '2027-01-01'])
  })
})

describe('closureFormSchema', () => {
  it('a valid closure passes', () => {
    expect(errorsOf(form())).toEqual({})
  })

  it('62 dates at most', () => {
    expect(dateCount('2026-11-01', '2027-01-01')).toBe(MAX_CLOSURE_DATES)
    expect(errorsOf(form({ from: '2026-11-01', to: '2027-01-01' }))).toEqual({})
    expect(errorsOf(form({ from: '2026-11-01', to: '2027-01-02' }))).toEqual({
      to: CLOSURE_ERRORS.tooManyDays,
    })
  })

  it('from today on, and the end not before the start', () => {
    expect(errorsOf(form({ from: '2026-10-01', to: '2026-10-03' }))).toEqual({
      from: CLOSURE_ERRORS.fromPast,
    })
    expect(errorsOf(form({ from: TODAY, to: TODAY }))).toEqual({})
    expect(errorsOf(form({ from: '2026-12-26', to: '2026-12-25' }))).toEqual({
      to: CLOSURE_ERRORS.toBeforeFrom,
    })
    expect(errorsOf(form({ from: '', to: '' }))).toEqual({
      from: CLOSURE_ERRORS.dateRequired,
      to: CLOSURE_ERRORS.dateRequired,
    })
  })

  it('special hours need 1–4 valid, non-overlapping intervals (back to back is fine)', () => {
    expect(errorsOf(form({ kind: 'open' }))).toEqual({
      intervals: CLOSURE_ERRORS.intervalsRequired,
    })
    expect(
      errorsOf(
        form({
          kind: 'open',
          intervals: [
            { start: '10:00', end: '14:00' },
            { start: '14:00', end: '18:00' },
          ],
        }),
      ),
    ).toEqual({})
    expect(
      errorsOf(
        form({
          kind: 'open',
          intervals: [
            { start: '10:00', end: '14:00' },
            { start: '13:00', end: '18:00' },
          ],
        }),
      ),
    ).toEqual({ intervals: CLOSURE_ERRORS.intervalsOverlap })
    expect(errorsOf(form({ kind: 'open', intervals: [{ start: '14:00', end: '10:00' }] }))).toEqual(
      {
        'intervals.0.end': CLOSURE_ERRORS.endBeforeStart,
      },
    )
    expect(
      errorsOf(
        form({
          kind: 'open',
          intervals: ['08', '10', '12', '14', '16'].map((h) => ({
            start: `${h}:00`,
            end: `${h}:30`,
          })),
        }),
      ),
    ).toEqual({ intervals: CLOSURE_ERRORS.intervalsTooMany })
  })

  it('a long note only matters for the shop (a staff row never carries one)', () => {
    const long = 'α'.repeat(201)
    expect(errorsOf(form({ note: long }))).toEqual({ note: CLOSURE_ERRORS.noteTooLong })
    expect(errorsOf(form({ scope: STAFF, note: long }))).toEqual({})
  })
})

describe('prefillIntervals (D11)', () => {
  const week = [
    { weekday: 5, startTime: '17:00', endTime: '21:00' },
    { weekday: 5, startTime: '09:00', endTime: '14:00' },
    { weekday: 6, startTime: '10:00', endTime: '16:00' },
  ]

  it('the staff member’s weekly hours of the first date (2026-10-02 is a Friday)', () => {
    expect(prefillIntervals(week, '2026-10-02')).toEqual([
      { start: '09:00', end: '14:00' },
      { start: '17:00', end: '21:00' },
    ])
  })

  it('a day off, no hours loaded or the shop: 09:00–17:00', () => {
    expect(prefillIntervals(week, '2026-10-04')).toEqual([{ start: '09:00', end: '17:00' }])
    expect(prefillIntervals(null, '2026-10-02')).toEqual([{ start: '09:00', end: '17:00' }])
    expect(prefillIntervals(week, '')).toEqual([{ start: '09:00', end: '17:00' }])
  })
})
