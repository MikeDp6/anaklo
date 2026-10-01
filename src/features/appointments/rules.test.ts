import { describe, expect, it } from 'vitest'
import {
  canMove,
  canNotifyClient,
  d8FlagOf,
  NO_D8_FLAGS,
  smsNoteKey,
  statusTargets,
  withD8Flag,
} from './rules'
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

describe('smsNoteKey (contract 1.5 §4.5: the note after «Ενημέρωση με SMS»)', () => {
  it.each([
    [{ notify: true, smsQueued: true }, 'notify.queued'],
    [{ notify: true, smsQueued: false }, 'notify.notSent'],
    [{ notify: false, smsQueued: false }, null],
    [{ notify: false, smsQueued: true }, null],
  ] as const)('%o → %s', (result, expected) => {
    expect(smsNoteKey(result)).toBe(expected)
  })
})

describe('canNotifyClient (whether «Ενημέρωση με SMS» is offered; the server decides)', () => {
  // testAppointment starts 2026-09-29 07:00Z.
  const before = new Date('2026-09-29T06:00:00Z')
  const client = (phoneE164: string | null) => ({ id: 'c', fullName: 'Γιώργος Π.', phoneE164 })

  it('a future appointment of a client with a Greek mobile or a foreign number', () => {
    expect(canNotifyClient(testAppointment({ client: client('+306900000001') }), before)).toBe(true)
    expect(canNotifyClient(testAppointment({ client: client('+12125550101') }), before)).toBe(true)
  })

  it('never for a Greek landline (no SMS can reach it), a client without phone or no client', () => {
    expect(canNotifyClient(testAppointment({ client: client('+302101234567') }), before)).toBe(
      false,
    )
    expect(canNotifyClient(testAppointment({ client: client(null) }), before)).toBe(false)
    expect(canNotifyClient(testAppointment({ client: null, clientId: null }), before)).toBe(false)
  })

  it('never once the appointment has started', () => {
    const started = new Date('2026-09-29T07:00:00Z')
    expect(canNotifyClient(testAppointment({ client: client('+306900000001') }), started)).toBe(
      false,
    )
  })
})
