import { describe, expect, it } from 'vitest'
import {
  aheadOf,
  CONFLICT_HORIZON_MS,
  conflictsPath,
  conflictWindow,
  isPastWindow,
  readConflictParams,
  spanOfDates,
} from './conflictWindow'

const ATHENS = 'Europe/Athens'
const STAFF = '00000000-0000-4000-8000-0000000000b1'
const NOW = new Date('2026-10-02T07:17:00Z') // 10:17 in Athens

describe('conflictWindow (contract 1.6 §4.9)', () => {
  it('no dates: the server defaults (from now, 366 days)', () => {
    expect(conflictWindow({ staff: null, from: null, to: null }, NOW, ATHENS)).toEqual({
      staffId: null,
      from: null,
      to: null,
    })
  })

  it('a future range: from its first local midnight to the midnight after its last day', () => {
    expect(
      conflictWindow({ staff: STAFF, from: '2026-10-10', to: '2026-10-11' }, NOW, ATHENS),
    ).toEqual({
      staffId: STAFF,
      from: '2026-10-09T21:00:00.000Z',
      to: '2026-10-11T21:00:00.000Z',
    })
  })

  it('a range that starts today begins now, not at midnight', () => {
    expect(
      conflictWindow({ staff: null, from: '2026-10-02', to: '2026-10-02' }, NOW, ATHENS),
    ).toEqual({ staffId: null, from: NOW.toISOString(), to: '2026-10-02T21:00:00.000Z' })
  })

  it('across the 25-hour day the end is the next local midnight at the new offset', () => {
    expect(
      conflictWindow({ staff: null, from: '2026-10-25', to: '2026-10-25' }, NOW, ATHENS),
    ).toEqual({ staffId: null, from: '2026-10-24T21:00:00.000Z', to: '2026-10-25T22:00:00.000Z' })
  })

  it('only `to`: from now (server) to the midnight after it', () => {
    expect(conflictWindow({ staff: null, from: null, to: '2026-10-05' }, NOW, ATHENS)).toEqual({
      staffId: null,
      from: null,
      to: '2026-10-05T21:00:00.000Z',
    })
  })

  it('a range longer than the server answers (366 days) is cut to 366 days from its start', () => {
    // A leave from 2026-10-05 to 2027-12-31 (a hand-written or old link): AN002 if sent whole.
    expect(
      conflictWindow({ staff: STAFF, from: '2026-10-05', to: '2027-12-31' }, NOW, ATHENS),
    ).toEqual({
      staffId: STAFF,
      from: '2026-10-04T21:00:00.000Z',
      to: '2027-10-05T21:00:00.000Z',
    })
    // Only `to`, beyond the horizon: from now, sent explicitly (the server's own «now» is later).
    expect(conflictWindow({ staff: null, from: null, to: '2028-01-01' }, NOW, ATHENS)).toEqual({
      staffId: null,
      from: NOW.toISOString(),
      to: '2027-10-03T07:17:00.000Z',
    })
    // Exactly 366 days stays as it is.
    const year = conflictWindow({ staff: null, from: '2026-10-05', to: '2027-10-05' }, NOW, ATHENS)
    expect(year).toEqual({
      staffId: null,
      from: '2026-10-04T21:00:00.000Z',
      to: '2027-10-05T21:00:00.000Z',
    })
    expect(Date.parse(year.to ?? '') - Date.parse(year.from ?? '')).toBe(CONFLICT_HORIZON_MS)
  })

  it('a past range is over: nothing to ask', () => {
    const past = conflictWindow({ staff: null, from: '2026-09-01', to: '2026-09-02' }, NOW, ATHENS)
    expect(isPastWindow(past, NOW)).toBe(true)
    expect(
      isPastWindow(conflictWindow({ staff: null, from: null, to: null }, NOW, ATHENS), NOW),
    ).toBe(false)
  })
})

describe('the query string', () => {
  it('reads staff and dates, ignoring malformed values', () => {
    expect(
      readConflictParams(new URLSearchParams(`staff=${STAFF}&from=2026-10-10&to=2026-13-01`)),
    ).toEqual({ staff: STAFF, from: '2026-10-10', to: null })
    expect(readConflictParams(new URLSearchParams('staff=nobody'))).toEqual({
      staff: null,
      from: null,
      to: null,
    })
  })

  it('builds the link with only what is set', () => {
    expect(conflictsPath({ staff: STAFF })).toBe(`/settings/conflicts?staff=${STAFF}`)
    expect(conflictsPath({ staff: null, from: '2026-10-10', to: '2026-10-11' })).toBe(
      '/settings/conflicts?from=2026-10-10&to=2026-10-11',
    )
    expect(conflictsPath({})).toBe('/settings/conflicts')
  })
})

describe('the span of a saved closure or time off', () => {
  it('whole local dates, across the 25-hour day', () => {
    expect(spanOfDates(STAFF, '2026-10-25', '2026-10-25', ATHENS)).toEqual({
      staffId: STAFF,
      from: '2026-10-24T21:00:00.000Z',
      to: '2026-10-25T22:00:00.000Z',
    })
  })

  it('a span longer than 366 days asks for its first 366 days (never AN002)', () => {
    expect(
      aheadOf(
        { staffId: STAFF, from: '2026-10-04T21:00:00.000Z', to: '2027-12-31T22:00:00.000Z' },
        NOW.getTime(),
      ),
    ).toEqual({ staffId: STAFF, from: '2026-10-04T21:00:00.000Z', to: '2027-10-05T21:00:00.000Z' })
    // Started already: from now, 366 days on.
    expect(
      aheadOf(
        { staffId: STAFF, from: '2026-09-01T00:00:00.000Z', to: '2028-01-01T00:00:00.000Z' },
        NOW.getTime(),
      ),
    ).toEqual({ staffId: STAFF, from: NOW.toISOString(), to: '2027-10-03T07:17:00.000Z' })
  })

  it('only the part still ahead is asked; a span that is over asks nothing', () => {
    const span = { staffId: null, from: '2026-10-02T05:00:00.000Z', to: '2026-10-02T09:00:00.000Z' }
    expect(aheadOf(span, NOW.getTime())).toEqual({
      staffId: null,
      from: NOW.toISOString(),
      to: '2026-10-02T09:00:00.000Z',
    })
    expect(aheadOf({ ...span, to: '2026-10-02T07:17:00.000Z' }, NOW.getTime())).toBeNull()
    expect(
      aheadOf(
        { ...span, from: '2026-10-03T05:00:00.000Z', to: '2026-10-03T09:00:00.000Z' },
        NOW.getTime(),
      ),
    ).toEqual({ staffId: null, from: '2026-10-03T05:00:00.000Z', to: '2026-10-03T09:00:00.000Z' })
  })
})
