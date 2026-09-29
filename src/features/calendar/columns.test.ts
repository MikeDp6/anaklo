import { describe, expect, it } from 'vitest'
import { canReadAppointmentDetails, seesBusinessAmounts } from './access'
import { defaultColumns, parseDateParam, toggleColumn } from './columns'

// Test data only.
const NIKOS = 'staff-nikos'
const ALEX = 'staff-alex'
const MARIA = 'staff-maria'

describe('canReadAppointmentDetails (contract 1.4 §3.2)', () => {
  it('owner and manager read every column; staff only their own', () => {
    expect(canReadAppointmentDetails({ role: 'owner', staffId: NIKOS }, ALEX)).toBe(true)
    expect(canReadAppointmentDetails({ role: 'manager', staffId: null }, ALEX)).toBe(true)
    expect(canReadAppointmentDetails({ role: 'staff', staffId: ALEX }, ALEX)).toBe(true)
    expect(canReadAppointmentDetails({ role: 'staff', staffId: ALEX }, NIKOS)).toBe(false)
    expect(canReadAppointmentDetails({ role: 'staff', staffId: null }, NIKOS)).toBe(false)
  })

  it('amounts of the whole business: owner and manager (SPEC §5)', () => {
    expect(seesBusinessAmounts({ role: 'owner' })).toBe(true)
    expect(seesBusinessAmounts({ role: 'manager' })).toBe(true)
    expect(seesBusinessAmounts({ role: 'staff' })).toBe(false)
  })
})

describe('day columns (1–2 on a phone)', () => {
  it('starts with the member’s own column, then the next staff member', () => {
    expect(defaultColumns([NIKOS, ALEX, MARIA], ALEX)).toEqual([ALEX, NIKOS])
    expect(defaultColumns([NIKOS, ALEX, MARIA], null)).toEqual([NIKOS, ALEX])
    expect(defaultColumns([NIKOS], 'inactive-or-other')).toEqual([NIKOS])
  })

  it('a tap hides a shown column (never the last) or adds one, dropping the oldest', () => {
    expect(toggleColumn([ALEX, NIKOS], NIKOS)).toEqual([ALEX])
    expect(toggleColumn([ALEX], ALEX)).toEqual([ALEX])
    expect(toggleColumn([ALEX], NIKOS)).toEqual([ALEX, NIKOS])
    expect(toggleColumn([ALEX, NIKOS], MARIA)).toEqual([NIKOS, MARIA])
  })

  it('accepts only a calendar date as ?date=', () => {
    expect(parseDateParam('2026-09-29')).toBe('2026-09-29')
    expect(parseDateParam('2026-02-30')).toBeNull()
    expect(parseDateParam('tomorrow')).toBeNull()
    expect(parseDateParam(null)).toBeNull()
  })
})
