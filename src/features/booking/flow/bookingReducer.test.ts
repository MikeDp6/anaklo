import { describe, expect, it } from 'vitest'
import type { BookResponse } from '@fn-shared/booking-schemas.ts'
import type { Slot } from '../schema'
import {
  bookingReducer,
  canGoBack,
  canResumeChallenge,
  defaultPick,
  initialBookingState,
  progressOf,
  type Attempt,
  type BookingEvent,
  type BookingState,
  type Challenge,
  type Details,
  type Proof,
} from './bookingReducer'

const SLOT: Slot = {
  starts_at: '2026-10-01T06:00:00+00:00',
  local_date: '2026-10-01',
  local_time: '09:00:00',
  staff_ids: ['00000000-0000-4000-8000-000000000101'],
}
const OTHER_SLOT: Slot = { ...SLOT, starts_at: '2026-10-01T06:15:00+00:00', local_time: '09:15:00' }
const DETAILS: Details = {
  fullName: 'Γιώργος Παπάς',
  phone: '+306900000001',
  marketingRefused: false,
}
const PROOF: Proof = {
  phone: '+306900000001',
  grant: 'g'.repeat(43),
  via: 'otp',
  clients: [
    { id: '00000000-0000-4000-8000-00000000c001', first_name: 'Γιώργος' },
    { id: '00000000-0000-4000-8000-00000000c002', first_name: 'Μάριος' },
  ],
}
/** A `book` sent for a new client «Γιώργος Παπάς» on DETAILS' phone. */
const ATTEMPT: Attempt = {
  key: 'k1',
  signature: 's',
  phone: DETAILS.phone,
  pick: { kind: 'new' },
}
const BOOKED: BookResponse = {
  appointment: {
    id: '00000000-0000-4000-8000-00000000a001',
    staff_id: '00000000-0000-4000-8000-000000000101',
    starts_at: SLOT.starts_at,
    ends_at: '2026-10-01T06:30:00+00:00',
    total_cents: 1300,
  },
  manage_token: 'h578eKkJfn9LdGNVKSzsuw',
  replayed: false,
  verified_via: 'otp',
  next_visit_hint: { key: 'nextVisit.vertical', weeks: 4 },
}

function run(...events: BookingEvent[]): BookingState {
  return events.reduce(bookingReducer, initialBookingState())
}

const toDetails: BookingEvent[] = [
  { type: 'service', serviceId: 's1', staffStep: true, staffId: null },
  { type: 'staff', staffId: 'st1' },
  { type: 'slot', slot: SLOT },
]

describe('bookingReducer: steps', () => {
  it('shows the staff step only when the service has a choice', () => {
    const withChoice = run({ type: 'service', serviceId: 's1', staffStep: true, staffId: null })
    expect(withChoice).toMatchObject({ step: 'staff', direction: 'forward', staffStep: true })
    const single = run({ type: 'service', serviceId: 's1', staffStep: false, staffId: 'st1' })
    expect(single).toMatchObject({ step: 'slot', staffId: 'st1', staffStep: false })
  })

  it('walks service → staff → slot → details and back again', () => {
    let state = run(...toDetails)
    expect(state).toMatchObject({ step: 'details', slot: SLOT, date: '2026-10-01' })
    state = bookingReducer(state, { type: 'back' })
    expect(state).toMatchObject({ step: 'slot', direction: 'back' })
    state = bookingReducer(state, { type: 'back' })
    expect(state.step).toBe('staff')
    state = bookingReducer(state, { type: 'back' })
    expect(state.step).toBe('service')
    expect(canGoBack(state)).toBe(false)
  })

  it('goes back from the slot to the service when there was no staff step', () => {
    const state = run({ type: 'service', serviceId: 's1', staffStep: false, staffId: 'st1' })
    expect(bookingReducer(state, { type: 'back' }).step).toBe('service')
  })

  it('a new staff choice forgets the chosen day and time', () => {
    const state = run(
      ...toDetails,
      { type: 'back' },
      { type: 'back' },
      { type: 'staff', staffId: null },
    )
    expect(state).toMatchObject({ step: 'slot', staffId: null, slot: null, date: null, window: 0 })
  })

  it('never goes back while a request runs', () => {
    const state = run(...toDetails, { type: 'pending', pending: 'start' })
    expect(canGoBack(state)).toBe(false)
    expect(bookingReducer(state, { type: 'back' })).toBe(state)
  })
})

describe('bookingReducer: proof and client choice', () => {
  it('asks for the OTP when the server sent a code; a resend stays on the step', () => {
    const challenge = { id: 'c1', phone: DETAILS.phone, expiresAt: 'x', resendAt: 'y' }
    let state = run(
      ...toDetails,
      { type: 'details', details: DETAILS },
      { type: 'challenge', challenge },
    )
    expect(state).toMatchObject({ step: 'otp', direction: 'forward', challenge })
    state = bookingReducer(state, { type: 'challenge', challenge: { ...challenge, id: 'c2' } })
    expect(state).toMatchObject({ step: 'otp', direction: 'none' })
    expect(bookingReducer(state, { type: 'back' }).step).toBe('details')
  })

  it('back on the details with the same phone, the code already sent comes back (no new SMS)', () => {
    const challenge: Challenge = {
      id: 'c1',
      phone: DETAILS.phone,
      expiresAt: '2026-10-01T06:05:00Z',
      resendAt: '2026-10-01T06:01:00Z',
    }
    const now = Date.parse('2026-10-01T06:01:30Z')
    expect(canResumeChallenge(challenge, DETAILS.phone, now)).toBe(true)
    expect(canResumeChallenge(challenge, '+306900000999', now)).toBe(false)
    expect(canResumeChallenge(challenge, DETAILS.phone, Date.parse('2026-10-01T06:04:45Z'))).toBe(
      false, // less than 30″ left to type it
    )
    expect(canResumeChallenge(null, DETAILS.phone, now)).toBe(false)

    const fixed = { ...DETAILS, fullName: 'Γιώργος Παππάς' }
    const state = run(
      ...toDetails,
      { type: 'details', details: DETAILS },
      { type: 'challenge', challenge },
      { type: 'back' },
      { type: 'details', details: fixed },
      { type: 'resumeChallenge' },
    )
    expect(state).toMatchObject({ step: 'otp', direction: 'forward', challenge, details: fixed })
  })

  it('a code answered with AN011/AN012 is spent and never resumed', () => {
    const challenge: Challenge = {
      id: 'c1',
      phone: DETAILS.phone,
      expiresAt: '2026-10-01T06:05:00Z',
      resendAt: '2026-10-01T06:01:00Z',
    }
    const state = run(
      ...toDetails,
      { type: 'details', details: DETAILS },
      { type: 'challenge', challenge },
      { type: 'failed', code: 'AN012' },
    )
    expect(state.challenge).toMatchObject({ id: 'c1', spent: true })
    expect(
      canResumeChallenge(state.challenge, DETAILS.phone, Date.parse('2026-10-01T06:01Z')),
    ).toBe(false)
  })

  it('after the proof offers the client whose first name was typed (accents and case aside)', () => {
    const state = run(
      ...toDetails,
      { type: 'details', details: { ...DETAILS, fullName: 'ΓΙΩΡΓΟΣ Π.' } },
      { type: 'proven', proof: PROOF },
    )
    expect(state).toMatchObject({ step: 'client', challenge: null, proof: PROOF })
    expect(state.pick).toEqual({ kind: 'existing', clientId: PROOF.clients[0]?.id })
  })

  it('offers a new client when no first name matches (never matched by phone alone)', () => {
    expect(defaultPick(PROOF.clients, 'Ελένη Κ.')).toEqual({ kind: 'new' })
    expect(defaultPick([], 'Γιώργος')).toEqual({ kind: 'new' })
  })

  it('keeps the proof for the same phone and drops it for another one', () => {
    const proven = run(
      ...toDetails,
      { type: 'details', details: DETAILS },
      { type: 'proven', proof: PROOF },
    )
    const back = bookingReducer(proven, { type: 'back' })
    const same = bookingReducer(back, { type: 'details', details: DETAILS })
    expect(same).toMatchObject({ step: 'client', proof: PROOF })
    const other = bookingReducer(back, {
      type: 'details',
      details: { ...DETAILS, phone: '+306900000999' },
    })
    expect(other).toMatchObject({ step: 'details', proof: null, pick: null })
  })

  it('a lost proof (AN014) sends the visitor back to the details with the error', () => {
    const state = run(
      ...toDetails,
      { type: 'details', details: DETAILS },
      { type: 'proven', proof: PROOF },
      { type: 'proofLost', code: 'AN014' },
    )
    expect(state).toMatchObject({ step: 'details', error: 'AN014', proof: null, direction: 'back' })
  })
})

describe('bookingReducer: booking', () => {
  const ready = [
    ...toDetails,
    { type: 'details', details: DETAILS },
    { type: 'proven', proof: PROOF },
  ] as BookingEvent[]

  it('a taken slot keeps the step and offers alternatives; one of them replaces it', () => {
    let state = run(
      ...ready,
      { type: 'attempt', attempt: ATTEMPT },
      { type: 'pending', pending: 'book' },
      { type: 'slotTaken' },
    )
    expect(state).toMatchObject({ step: 'client', error: 'AN001', takenSlot: SLOT, attempt: null })
    state = bookingReducer(state, { type: 'alternative', slot: OTHER_SLOT })
    expect(state).toMatchObject({ step: 'client', slot: OTHER_SLOT, takenSlot: null, error: null })
    expect(bookingReducer(state, { type: 'slots' })).toMatchObject({
      step: 'slot',
      direction: 'back',
    })
  })

  it('shows the confirmation only with the server answer and forgets the used grant', () => {
    const state = run(...ready, { type: 'booked', booking: BOOKED })
    expect(state).toMatchObject({ step: 'done', booking: BOOKED, pending: null })
    expect(state.proof?.grant).toBeNull()
    expect(canGoBack(state)).toBe(false)
  })

  it('«back» after the confirmation starts a new booking with the typed details kept', () => {
    const state = bookingReducer(run(...ready, { type: 'booked', booking: BOOKED }), {
      type: 'back',
    })
    expect(state).toMatchObject({ step: 'service', details: DETAILS, proof: null, booking: null })
  })

  it('a failed request keeps everything for a retry of the same attempt', () => {
    const state = run(
      ...ready,
      { type: 'attempt', attempt: ATTEMPT },
      { type: 'pending', pending: 'book' },
      { type: 'failed', code: 'network' },
    )
    expect(state).toMatchObject({
      step: 'client',
      error: 'network',
      pending: null,
      attempt: ATTEMPT,
    })
  })

  it('a lost proof keeps the attempt, and the new proof brings its client choice back', () => {
    // The first `book` committed (a new client) but its answer was lost; the retry after the
    // grant expired answered AN014. The client it created is listed after the new OTP.
    const created = { id: '00000000-0000-4000-8000-00000000c009', first_name: 'Γιώργος' }
    const lost = run(
      ...ready,
      { type: 'attempt', attempt: ATTEMPT },
      { type: 'pending', pending: 'book' },
      { type: 'failed', code: 'network' },
      { type: 'pending', pending: 'book' },
      { type: 'proofLost', code: 'AN014' },
    )
    expect(lost).toMatchObject({ step: 'details', proof: null, attempt: ATTEMPT })
    const again = bookingReducer(bookingReducer(lost, { type: 'details', details: DETAILS }), {
      type: 'proven',
      proof: { ...PROOF, clients: [created] },
    })
    // Not the listed «Γιώργος»: the same request (same key) replays the first booking.
    expect(again).toMatchObject({ step: 'client', pick: { kind: 'new' }, attempt: ATTEMPT })
  })

  it('an attempt of another phone does not choose the client after a new proof', () => {
    const state = run(
      ...toDetails,
      { type: 'attempt', attempt: { ...ATTEMPT, phone: '+306900000999' } },
      { type: 'details', details: DETAILS },
      { type: 'proven', proof: PROOF },
    )
    expect(state.pick).toEqual({ kind: 'existing', clientId: PROOF.clients[0]?.id })
  })
})

describe('progressOf (E19)', () => {
  it('counts the phases of this flow and is full when done', () => {
    expect(
      progressOf(run({ type: 'service', serviceId: 's', staffStep: true, staffId: null })),
    ).toEqual({ value: 1, max: 4 })
    expect(
      progressOf(run({ type: 'service', serviceId: 's', staffStep: false, staffId: 'x' })),
    ).toEqual({ value: 1, max: 3 })
    expect(
      progressOf(
        run(...toDetails, { type: 'details', details: DETAILS }, { type: 'proven', proof: PROOF }),
      ),
    ).toEqual({ value: 3, max: 4 })
    expect(progressOf(run(...toDetails, { type: 'booked', booking: BOOKED }))).toEqual({
      value: 4,
      max: 4,
    })
  })
})
