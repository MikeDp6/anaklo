import { describe, expect, it } from 'vitest'
import { canMove, d8FlagOf, NO_D8_FLAGS, statusTargets, withD8Flag } from './rules'
import { testAppointment } from './testFixtures'

describe('statusTargets (which buttons the sheet shows; the server decides)', () => {
  it('before the start: only confirm, and only a booked appointment', () => {
    expect(statusTargets(testAppointment({ status: 'booked' }), false)).toEqual(['confirmed'])
    expect(statusTargets(testAppointment({ status: 'confirmed' }), false)).toEqual([])
  })

  it('once started: «Ήρθε» / «Δεν ήρθε»', () => {
    expect(statusTargets(testAppointment({ status: 'booked' }), true)).toEqual([
      'completed',
      'no_show',
    ])
    expect(statusTargets(testAppointment({ status: 'confirmed' }), true)).toEqual([
      'completed',
      'no_show',
    ])
  })

  it('corrections between completed and no-show; nothing for cancelled', () => {
    expect(statusTargets(testAppointment({ status: 'completed' }), true)).toEqual(['no_show'])
    expect(statusTargets(testAppointment({ status: 'no_show' }), true)).toEqual(['completed'])
    expect(statusTargets(testAppointment({ status: 'cancelled' }), true)).toEqual([])
  })

  it('only booked and confirmed appointments move', () => {
    expect(canMove(testAppointment({ status: 'booked' }))).toBe(true)
    expect(canMove(testAppointment({ status: 'confirmed' }))).toBe(true)
    expect(canMove(testAppointment({ status: 'completed' }))).toBe(false)
  })
})

describe('D8 confirmations', () => {
  it('maps AN005/AN006 to the flag of the next attempt', () => {
    expect(d8FlagOf('AN005')).toBe('outside_hours')
    expect(d8FlagOf('AN006')).toBe('buffer_overlap')
    expect(d8FlagOf('AN001')).toBeNull()
    expect(withD8Flag(NO_D8_FLAGS, 'outside_hours')).toEqual({
      allowOutsideHours: true,
      allowBufferOverlap: false,
    })
    expect(withD8Flag(withD8Flag(NO_D8_FLAGS, 'outside_hours'), 'buffer_overlap')).toEqual({
      allowOutsideHours: true,
      allowBufferOverlap: true,
    })
  })
})
