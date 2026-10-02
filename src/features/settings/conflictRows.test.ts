import { describe, expect, it } from 'vitest'
import { allResolved, withResolved } from './conflictRows'
import { SETTINGS_IDS as IDS, testConflict } from './testFixtures'

const FIRST = testConflict()
const SECOND = testConflict({
  appointmentId: IDS.second,
  startsAt: '2026-10-02T08:00:00+00:00',
  endsAt: '2026-10-02T08:30:00+00:00',
})
const SAME_TIME = testConflict({ appointmentId: '00000000-0000-4000-8000-00000000d003' })

describe('withResolved (contract 1.6 §4.9: a result stays on screen)', () => {
  it('a row resolved here stays after the refetch dropped it, in time order', () => {
    const resolved = new Map([[FIRST.appointmentId, FIRST]])
    expect(withResolved([SECOND], resolved)).toEqual([FIRST, SECOND])
  })

  it('a row that vanished without a result here is gone', () => {
    expect(withResolved([SECOND], new Map())).toEqual([SECOND])
  })

  it('a resolved row the server still lists is shown once; same start keeps the server order', () => {
    const resolved = new Map([[FIRST.appointmentId, FIRST]])
    expect(withResolved([SAME_TIME, FIRST], resolved)).toEqual([SAME_TIME, FIRST])
  })
})

describe('allResolved', () => {
  it('needs a result on every listed row, and at least one row', () => {
    const resolved = new Map([[FIRST.appointmentId, FIRST]])
    expect(allResolved([FIRST], resolved)).toBe(true)
    expect(allResolved([FIRST, SECOND], resolved)).toBe(false)
    expect(allResolved([], resolved)).toBe(false)
  })
})
