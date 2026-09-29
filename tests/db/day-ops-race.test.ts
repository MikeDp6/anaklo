import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod/mini'
import { DEMO_BUSINESS_ID, SEED_USERS } from '../../e2e/lib/seedUsers.ts'
import { domainErrorCode } from '../../supabase/functions/_shared/errors.ts'
import { adminClient, signInAs, signOut, type Db } from './lib/localStack.ts'

/**
 * Concurrency of the pro app's move (0006 staff_move_appointment on top of 0004 move_core,
 * contract 1.4 §2.9): real HTTP requests through PostgREST, each in its own transaction, as the
 * pro app sends them.
 *
 *   · a staff member moves their own appointment into a free time while the owner books a
 *     walk-in into the same time: exactly one of the two wins, the other gets AN001;
 *   · the same race when the move hands the appointment to a colleague (the new staff member's
 *     day, not the mover's, is the contested one);
 *   · the same move sent many times at once with one idempotency key: one move, the rest replay.
 *
 * Nothing is deleted afterwards (no API role has DELETE on appointments): every run books the
 * first FREE slots of a far-future range that only this file uses (booking-race uses 2090), so
 * reruns stay green; `npm run db:reset` clears them.
 */
const RACE_RANGE_FROM = '2092-01-06'
const WINDOW_DAYS = 14 // the most one availability call accepts (AN002 beyond)
const MAX_WINDOWS = 26
const ROUNDS = 5 // move-vs-book pairs, each on its own free time
const SAME_KEY_CALLS = 10

/** Reply of staff_book_appointment (private.booking_result). */
const Booking = z.object({
  appointment_id: z.string(),
  staff_id: z.string(),
  starts_at: z.string(),
})

/** Reply of staff_move_appointment (contract 1.4 §2.6.6). */
const Move = z.object({
  appointment_id: z.string(),
  staff_id: z.string(),
  starts_at: z.string(),
  ends_at: z.string(),
  warnings: z.array(z.string()),
  from_staff_id: z.string(),
  from_starts_at: z.string(),
  replayed: z.boolean(),
  notify: z.boolean(),
  sms_queued: z.boolean(),
})

type RpcReply = { error: { code?: unknown; message?: unknown } | null }

/** 'ok', the domain code (AN001…), or the raw error, so a failed expectation shows the cause. */
function outcome(reply: RpcReply): string {
  if (reply.error === null) return 'ok'
  return (
    domainErrorCode(reply.error) ?? `${String(reply.error.code)}: ${String(reply.error.message)}`
  )
}

function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() + days)
  return day.toISOString().slice(0, 10)
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

let owner: Db
let staff: Db
let admin: Db
let staffId: string
let colleagueId: string
let serviceId: string

beforeAll(async () => {
  admin = adminClient()
  owner = await signInAs(SEED_USERS.owner.email)
  staff = await signInAs(SEED_USERS.staff.email)

  // The staff member moves their OWN appointment (staff may act only on their own staff row).
  const member = await admin
    .from('business_members')
    .select('staff_id')
    .eq('business_id', DEMO_BUSINESS_ID)
    .eq('user_id', SEED_USERS.staff.id)
    .single()
  if (member.error) throw member.error
  if (!member.data.staff_id) throw new Error('the seed staff member has no staff row')
  staffId = member.data.staff_id

  // The owner's own staff row: the colleague the staff member hands an appointment to.
  const colleague = await admin
    .from('business_members')
    .select('staff_id')
    .eq('business_id', DEMO_BUSINESS_ID)
    .eq('user_id', SEED_USERS.owner.id)
    .single()
  if (colleague.error) throw colleague.error
  if (!colleague.data.staff_id || colleague.data.staff_id === staffId) {
    throw new Error('the seed owner has no staff row of their own')
  }
  colleagueId = colleague.data.staff_id

  const offered = await admin
    .from('staff_services')
    .select('service_id')
    .eq('business_id', DEMO_BUSINESS_ID)
    .eq('staff_id', staffId)
  if (offered.error) throw offered.error
  const service = await admin
    .from('services')
    .select('id')
    .eq('business_id', DEMO_BUSINESS_ID)
    .eq('active', true)
    .in(
      'id',
      offered.data.map((row) => row.service_id),
    )
    .order('sort')
    .order('id')
    .limit(1)
    .single()
  if (service.error) throw service.error
  serviceId = service.data.id
})

afterAll(async () => {
  if (owner) await signOut(owner)
  if (staff) await signOut(staff)
})

/** The earliest free start of a staff member (default: the staff member) at or after `notBefore`. */
async function firstFreeSlot(notBefore = 0, ofStaffId = staffId): Promise<string> {
  for (let window = 0; window < MAX_WINDOWS; window++) {
    const from = addDays(RACE_RANGE_FROM, window * WINDOW_DAYS)
    const { data, error } = await staff.rpc('staff_available_slots', {
      p_business_id: DEMO_BUSINESS_ID,
      p_service_ids: [serviceId],
      p_staff_id: ofStaffId,
      p_from: from,
      p_to: addDays(from, WINDOW_DAYS - 1),
    })
    if (error) throw error
    const starts = data
      .map((slot) => slot.starts_at)
      .filter((start) => Date.parse(start) >= notBefore)
      .sort((a, b) => Date.parse(a) - Date.parse(b))
    if (starts[0]) return starts[0]
  }
  throw new Error('No free slot left in the race-test range. Run: npm run db:reset')
}

/** A walk-in (no client row) of the staff member, booked by the staff member. */
async function bookWalkIn(startsAt: string): Promise<string> {
  const { data, error } = await staff.rpc('staff_book_appointment', {
    p_business_id: DEMO_BUSINESS_ID,
    p_service_ids: [serviceId],
    p_staff_id: staffId,
    p_starts_at: startsAt,
    p_source: 'walkin',
  })
  if (error) throw error
  return Booking.parse(data).appointment_id
}

/**
 * Opens PostgREST's pool connections and gets both sessions' JWTs validated BEFORE the race
 * (see booking-race.test.ts: cold, the first requests reach Postgres one after another).
 */
async function warmUp(): Promise<void> {
  const replies = await Promise.all(
    [owner, staff].flatMap((client) =>
      Array.from({ length: 10 }, () =>
        client.rpc('staff_available_slots', {
          p_business_id: DEMO_BUSINESS_ID,
          p_service_ids: [serviceId],
          p_staff_id: staffId,
          p_from: RACE_RANGE_FROM,
          p_to: RACE_RANGE_FROM,
        }),
      ),
    ),
  )
  for (const reply of replies) if (reply.error) throw reply.error
}

/** Ids of the ACTIVE (booked/confirmed) appointments of a staff member starting exactly then. */
async function activeAt(startsAt: string, ofStaffId = staffId): Promise<string[]> {
  const { data, error } = await admin
    .from('appointments')
    .select('id')
    .eq('business_id', DEMO_BUSINESS_ID)
    .eq('staff_id', ofStaffId)
    .eq('starts_at', startsAt)
    .in('status', ['booked', 'confirmed'])
  if (error) throw error
  return data.map((row) => row.id)
}

async function eventsOf(appointmentId: string): Promise<string[]> {
  const { data, error } = await admin
    .from('appointment_events')
    .select('event')
    .eq('business_id', DEMO_BUSINESS_ID)
    .eq('appointment_id', appointmentId)
    .order('id')
  if (error) throw error
  return data.map((row) => row.event)
}

describe('day operations race (local stack, supabase-js over HTTP)', () => {
  it(`move vs booking into the same free time, ${String(ROUNDS)} rounds: exactly one wins, the other AN001`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const current = await firstFreeSlot()
      const appointmentId = await bookWalkIn(current)
      // Far enough from the appointment's own block that only the two racers compete.
      const target = await firstFreeSlot(Date.parse(current) + TWO_HOURS_MS)
      expect(await activeAt(target)).toEqual([])

      await warmUp()
      const [moved, booked] = await Promise.all([
        staff.rpc('staff_move_appointment', {
          p_business_id: DEMO_BUSINESS_ID,
          p_appointment_id: appointmentId,
          p_idempotency_key: randomUUID(),
          p_new_starts_at: target,
          p_notify: false,
        }),
        owner.rpc('staff_book_appointment', {
          p_business_id: DEMO_BUSINESS_ID,
          p_service_ids: [serviceId],
          p_staff_id: staffId,
          p_starts_at: target,
          p_source: 'walkin',
        }),
      ])

      expect([outcome(moved), outcome(booked)].sort()).toEqual(['AN001', 'ok'])
      const winner =
        moved.error === null
          ? Move.parse(moved.data).appointment_id
          : Booking.parse(booked.data).appointment_id
      expect(await activeAt(target)).toEqual([winner])
      // The loser changed nothing: a lost move leaves the appointment where it was.
      expect(await activeAt(current)).toEqual(moved.error === null ? [] : [appointmentId])
      expect(await eventsOf(appointmentId)).toEqual(
        moved.error === null ? ['created', 'rescheduled'] : ['created'],
      )
    }
  })

  it(`hand-over to a colleague vs booking the colleague at the same time, ${String(ROUNDS)} rounds: exactly one wins`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const current = await firstFreeSlot()
      const appointmentId = await bookWalkIn(current)
      // A time that is free for the colleague and differs from the appointment's own start.
      const target = await firstFreeSlot(Date.parse(current) + TWO_HOURS_MS, colleagueId)
      expect(await activeAt(target, colleagueId)).toEqual([])

      await warmUp()
      const [moved, booked] = await Promise.all([
        staff.rpc('staff_move_appointment', {
          p_business_id: DEMO_BUSINESS_ID,
          p_appointment_id: appointmentId,
          p_idempotency_key: randomUUID(),
          p_new_starts_at: target,
          p_new_staff_id: colleagueId,
          p_notify: false,
        }),
        owner.rpc('staff_book_appointment', {
          p_business_id: DEMO_BUSINESS_ID,
          p_service_ids: [serviceId],
          p_staff_id: colleagueId,
          p_starts_at: target,
          p_source: 'walkin',
        }),
      ])

      expect([outcome(moved), outcome(booked)].sort()).toEqual(['AN001', 'ok'])
      const winner =
        moved.error === null
          ? Move.parse(moved.data).appointment_id
          : Booking.parse(booked.data).appointment_id
      expect(await activeAt(target, colleagueId)).toEqual([winner])
      // A lost hand-over leaves the appointment with the staff member, at its old time.
      expect(await activeAt(current)).toEqual(moved.error === null ? [] : [appointmentId])
      expect(await eventsOf(appointmentId)).toEqual(
        moved.error === null ? ['created', 'rescheduled', 'reassigned'] : ['created'],
      )
    }
  })

  it(`${String(SAME_KEY_CALLS)} parallel moves with one idempotency key: one move, the rest replay it`, async () => {
    const current = await firstFreeSlot()
    const appointmentId = await bookWalkIn(current)
    const target = await firstFreeSlot(Date.parse(current) + TWO_HOURS_MS)
    const key = randomUUID()

    const move = () =>
      staff.rpc('staff_move_appointment', {
        p_business_id: DEMO_BUSINESS_ID,
        p_appointment_id: appointmentId,
        p_idempotency_key: key,
        p_new_starts_at: target,
        p_notify: false,
      })
    await warmUp()
    const replies = await Promise.all(Array.from({ length: SAME_KEY_CALLS }, move))

    expect(replies.map(outcome)).toEqual(Array<string>(SAME_KEY_CALLS).fill('ok'))
    const moves = replies.map((reply) => Move.parse(reply.data))
    expect(moves.filter((result) => !result.replayed)).toHaveLength(1)
    for (const result of moves) {
      expect(result.appointment_id).toBe(appointmentId)
      expect(Date.parse(result.starts_at)).toBe(Date.parse(target))
      expect(Date.parse(result.from_starts_at)).toBe(Date.parse(current))
    }
    expect(await activeAt(target)).toEqual([appointmentId])
    expect(await eventsOf(appointmentId)).toEqual(['created', 'rescheduled'])
  })
})
