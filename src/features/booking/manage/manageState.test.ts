import { describe, expect, it } from 'vitest'
import { testManageView } from '../testFixtures'
import { manageState } from './manageState'

const BEFORE = Date.parse('2026-09-30T12:00:00Z') // the appointment is on 1 Oct, 06:00–06:30Z
const AFTER = Date.parse('2026-10-08T12:00:00Z') // a week later (the link still works)

describe('manageState (what /m/<token> offers)', () => {
  it('online change until change_until, then «call the shop» while it is still ahead', () => {
    expect(manageState(testManageView(), BEFORE)).toBe('changeable')
    const late = { ...testManageView(), can_cancel: false, can_reschedule: false }
    expect(manageState(late, Date.parse('2026-10-01T05:00:00Z'))).toBe('call')
  })

  it('a completed or no-show appointment, or one already over, is closed: nobody to call', () => {
    const closed = { can_cancel: false, can_reschedule: false }
    expect(manageState({ ...testManageView({ status: 'completed' }), ...closed }, AFTER)).toBe(
      'closed',
    )
    expect(manageState({ ...testManageView({ status: 'no_show' }), ...closed }, BEFORE)).toBe(
      'closed',
    )
    expect(manageState({ ...testManageView(), ...closed }, AFTER)).toBe('closed')
  })

  it('a cancelled appointment is cancelled', () => {
    expect(manageState(testManageView({ status: 'cancelled' }), BEFORE)).toBe('cancelled')
  })
})
