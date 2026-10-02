import { describe, expect, it } from 'vitest'
import { groupExceptions } from './exceptionGroups'
import type { ScheduleException } from './schema'

const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000b1'

let next = 0
function row(partial: Partial<ScheduleException> & Pick<ScheduleException, 'localDate'>) {
  next += 1
  return {
    id: `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`,
    staffId: null,
    kind: 'closed',
    startTime: null,
    endTime: null,
    note: null,
    ...partial,
  } satisfies ScheduleException
}

describe('groupExceptions (contract 1.6 §4.6)', () => {
  it('consecutive shop closures with the same note form one item with every id', () => {
    const rows = [
      row({ localDate: '2026-12-25', note: 'Αργία' }),
      row({ localDate: '2026-12-26', note: 'Αργία' }),
    ]
    const groups = groupExceptions(rows)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      staffId: null,
      kind: 'closed',
      from: '2026-12-25',
      to: '2026-12-26',
      intervals: [],
      note: 'Αργία',
      ids: rows.map((r) => r.id),
    })
  })

  it('a gap of a day, another note, another kind or another scope splits the items', () => {
    const groups = groupExceptions([
      row({ localDate: '2026-12-24' }),
      row({ localDate: '2026-12-26' }), // gap
      row({ localDate: '2026-12-27', note: 'Αργία' }), // other note
      row({ localDate: '2026-12-28', note: 'Αργία', staffId: A }), // other scope
      row({ localDate: '2026-12-29', kind: 'open', startTime: '10:00', endTime: '14:00' }),
    ])
    expect(groups.map((g) => [g.from, g.to, g.staffId, g.kind])).toEqual([
      ['2026-12-24', '2026-12-24', null, 'closed'],
      ['2026-12-26', '2026-12-26', null, 'closed'],
      ['2026-12-27', '2026-12-27', null, 'closed'],
      ['2026-12-28', '2026-12-28', A, 'closed'],
      ['2026-12-29', '2026-12-29', null, 'open'],
    ])
  })

  it('special hours: the intervals of a date are one day; equal days in a row group', () => {
    const rows = [
      row({
        localDate: '2026-11-02',
        staffId: B,
        kind: 'open',
        startTime: '17:00',
        endTime: '20:00',
      }),
      row({
        localDate: '2026-11-02',
        staffId: B,
        kind: 'open',
        startTime: '10:00',
        endTime: '14:00',
      }),
      row({
        localDate: '2026-11-03',
        staffId: B,
        kind: 'open',
        startTime: '10:00',
        endTime: '14:00',
      }),
      row({
        localDate: '2026-11-03',
        staffId: B,
        kind: 'open',
        startTime: '17:00',
        endTime: '20:00',
      }),
      row({
        localDate: '2026-11-04',
        staffId: B,
        kind: 'open',
        startTime: '10:00',
        endTime: '13:00',
      }),
    ]
    const groups = groupExceptions(rows)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({
      from: '2026-11-02',
      to: '2026-11-03',
      intervals: [
        { start: '10:00', end: '14:00' },
        { start: '17:00', end: '20:00' },
      ],
    })
    expect(groups[0]?.ids).toHaveLength(4)
    expect(groups[1]).toMatchObject({ from: '2026-11-04', to: '2026-11-04' })
  })

  it('orders by first date, the shop before a staff member on the same date', () => {
    const groups = groupExceptions([
      row({ localDate: '2026-10-10', staffId: A }),
      row({ localDate: '2026-10-09', staffId: B }),
      row({ localDate: '2026-10-10' }),
    ])
    expect(groups.map((g) => [g.from, g.staffId])).toEqual([
      ['2026-10-09', B],
      ['2026-10-10', null],
      ['2026-10-10', A],
    ])
  })

  it('month and year boundaries are consecutive dates', () => {
    const groups = groupExceptions([
      row({ localDate: '2026-12-31' }),
      row({ localDate: '2027-01-01' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ from: '2026-12-31', to: '2027-01-01' })
  })

  it('nothing in, nothing out', () => {
    expect(groupExceptions([])).toEqual([])
  })
})
