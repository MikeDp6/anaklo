import { describe, expect, it } from 'vitest'
import {
  nextStaffSort,
  StaffFormSchema,
  toStaffForm,
  toStaffInput,
  toWeekHoursResult,
  toWeekRowArgs,
  toWeekRowList,
  WeekHoursResponse,
  type StaffFormValues,
} from './schema'

// Test data only (synthetic ids).
const ID = '00000000-0000-4000-8000-000000000101'

function issues(values: StaffFormValues): Record<string, string> {
  const result = StaffFormSchema.safeParse(values)
  if (result.success) return {}
  return Object.fromEntries(
    result.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
  )
}

describe('StaffFormSchema (contract 1.6 §4.4; CHECKs of 0001)', () => {
  it('name 1–60 characters after trimming', () => {
    expect(issues({ displayName: ' Σταύρος ', color: '', active: true })).toEqual({})
    expect(issues({ displayName: '   ', color: '', active: true })).toEqual({
      displayName: 'staffSettings.errors.name',
    })
    expect(issues({ displayName: 'Α'.repeat(61), color: '', active: true })).toEqual({
      displayName: 'staffSettings.errors.name',
    })
    expect(issues({ displayName: 'Α'.repeat(60), color: '', active: true })).toEqual({})
  })

  it('colour: none or #RRGGBB', () => {
    expect(issues({ displayName: 'Α', color: '#2F6B5E', active: true })).toEqual({})
    expect(issues({ displayName: 'Α', color: 'green', active: true })).toEqual({
      color: 'errors.invalid',
    })
  })
})

describe('form ↔ input', () => {
  it('trims the name; no colour = null; the sort is kept for a create', () => {
    expect(toStaffInput({ displayName: ' Μάριος ', color: '', active: false }, ID, 3)).toEqual({
      id: ID,
      displayName: 'Μάριος',
      color: null,
      active: false,
      sort: 3,
    })
  })

  it('a new staff member is active with the suggested colour; an existing one keeps hers', () => {
    expect(toStaffForm(null, '#2F6B5E')).toEqual({
      displayName: '',
      color: '#2F6B5E',
      active: true,
    })
    expect(
      toStaffForm({ id: ID, displayName: 'Α', color: null, sort: 0, active: false }, '#2F6B5E'),
    ).toEqual({ displayName: 'Α', color: '', active: false })
  })

  it('a new staff member goes last', () => {
    expect(nextStaffSort([])).toBe(0)
    expect(
      nextStaffSort([
        { id: ID, displayName: 'Α', color: null, sort: 4, active: true },
        { id: ID, displayName: 'Β', color: null, sort: 1, active: false },
      ]),
    ).toBe(5)
  })
})

describe('week hours rows', () => {
  it('database times become HH:MM; the RPC rows are exactly weekday, start_time, end_time', () => {
    const rows = toWeekRowList([{ weekday: 2, start_time: '09:00:00', end_time: '24:00:00' }])
    expect(rows).toEqual([{ weekday: 2, startTime: '09:00', endTime: '24:00' }])
    expect(toWeekRowArgs(rows)).toEqual([{ weekday: 2, start_time: '09:00', end_time: '24:00' }])
    expect(Object.keys(toWeekRowArgs(rows)[0] ?? {}).sort()).toEqual([
      'end_time',
      'start_time',
      'weekday',
    ])
  })

  it('parses the replace_week_hours answer', () => {
    const answer = WeekHoursResponse.parse({
      staff_id: ID,
      changed: true,
      rows: [{ weekday: 6, start_time: '10:00', end_time: '14:00' }],
      conflict_count: 2,
    })
    expect(toWeekHoursResult(answer)).toEqual({
      staffId: ID,
      changed: true,
      rows: [{ weekday: 6, startTime: '10:00', endTime: '14:00' }],
      conflictCount: 2,
    })
  })
})
