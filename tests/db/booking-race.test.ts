import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod/mini'
import { DEMO_BUSINESS_ID, SEED_USERS } from '../../e2e/lib/seedUsers.ts'
import { domainErrorCode } from '../../supabase/functions/_shared/errors.ts'
import { adminClient, signInAs, signOut, type Db } from './lib/localStack.ts'

/**
 * Concurrency of the booking path (0004 private.book_core, Phase 1 plan step 1.2): many HTTP
 * requests at once through PostgREST, each in its own transaction, as the staff app sends them.
 *
 * Nothing is deleted afterwards: appointments are never deleted and no API role has DELETE.
 * Instead every run books the first FREE slot of a far-future range that only these tests use,
 * so reruns stay green; `npm run db:reset` clears them.
 */
const RACE_RANGE_FROM = '2090-01-02'
const WINDOW_DAYS = 14 // the most one availability call accepts (AN002 beyond)
const MAX_WINDOWS = 26

/** Reply of staff_book_appointment (private.booking_result). */
const Booking = z.object({
  appointment_id: z.string(),
  staff_id: z.string(),
  starts_at: z.string(),
  ends_at: z.string(),
  total_cents: z.number(),
  replayed: z.boolean(),
  warnings: z.array(z.string()),
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

let owner: Db
let admin: Db
let staffId: string
let serviceId: string

beforeAll(async () => {
  admin = adminClient()
  owner = await signInAs(SEED_USERS.owner.email)

  // The owner books for their own staff row (any member could, also for a colleague).
  const member = await admin
    .from('business_members')
    .select('staff_id')
    .eq('business_id', DEMO_BUSINESS_ID)
    .eq('user_id', SEED_USERS.owner.id)
    .single()
  if (member.error) throw member.error
  if (!member.data.staff_id) throw new Error('the seed owner has no staff row')
  staffId = member.data.staff_id

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
})

/** The earliest free start of the staff member in the race range, as the server computes it. */
async function firstFreeSlot(): Promise<string> {
  for (let window = 0; window < MAX_WINDOWS; window++) {
    const from = addDays(RACE_RANGE_FROM, window * WINDOW_DAYS)
    const { data, error } = await owner.rpc('staff_available_slots', {
      p_business_id: DEMO_BUSINESS_ID,
      p_service_ids: [serviceId],
      p_staff_id: staffId,
      p_from: from,
      p_to: addDays(from, WINDOW_DAYS - 1),
    })
    if (error) throw error
    const starts = data.map((slot) => slot.starts_at).sort((a, b) => Date.parse(a) - Date.parse(b))
    if (starts[0]) return starts[0]
  }
  throw new Error('No free slot left in the race-test range. Run: npm run db:reset')
}

/**
 * Opens PostgREST's pool connections and gets this session's JWT validated BEFORE the race.
 * Cold, the first requests of a new session reach Postgres one after another and the race tests
 * nothing: measured on the local stack with the day lock AND the exclusion constraint both
 * removed, 20 cold requests still left 1 row, 20 warmed-up ones left 10 (PostgREST's pool size).
 */
async function warmUp(): Promise<void> {
  const replies = await Promise.all(
    Array.from({ length: 20 }, () =>
      owner.rpc('staff_available_slots', {
        p_business_id: DEMO_BUSINESS_ID,
        p_service_ids: [serviceId],
        p_staff_id: staffId,
        p_from: RACE_RANGE_FROM,
        p_to: RACE_RANGE_FROM,
      }),
    ),
  )
  for (const reply of replies) if (reply.error) throw reply.error
}

/** Ids of every appointment (any status) of the staff member starting exactly then. */
async function appointmentsAt(startsAt: string): Promise<string[]> {
  const { data, error } = await admin
    .from('appointments')
    .select('id')
    .eq('business_id', DEMO_BUSINESS_ID)
    .eq('staff_id', staffId)
    .eq('starts_at', startsAt)
  if (error) throw error
  return data.map((row) => row.id)
}

async function eventsOf(appointmentId: string): Promise<string[]> {
  const { data, error } = await admin
    .from('appointment_events')
    .select('event')
    .eq('business_id', DEMO_BUSINESS_ID)
    .eq('appointment_id', appointmentId)
  if (error) throw error
  return data.map((row) => row.event)
}

describe('booking race (local stack, supabase-js over HTTP)', () => {
  it('20 parallel bookings of one slot: exactly 1 row, 19 × AN001 slot_taken', async () => {
    const startsAt = await firstFreeSlot()
    expect(await appointmentsAt(startsAt)).toEqual([])

    const book = () =>
      owner.rpc('staff_book_appointment', {
        p_business_id: DEMO_BUSINESS_ID,
        p_service_ids: [serviceId],
        p_staff_id: staffId,
        p_starts_at: startsAt,
        p_source: 'walkin', // anonymous walk-in: no client row to leave behind
      })
    await warmUp()
    // Every request starts before any is awaited.
    const replies = await Promise.all(Array.from({ length: 20 }, book))

    const outcomes = replies.map(outcome).sort()
    expect(outcomes).toEqual([...Array<string>(19).fill('AN001'), 'ok'])

    const winner = Booking.parse(replies.find((reply) => reply.error === null)?.data)
    expect(winner.replayed).toBe(false)
    expect(winner.staff_id).toBe(staffId)
    expect(Date.parse(winner.starts_at)).toBe(Date.parse(startsAt))
    expect(await appointmentsAt(startsAt)).toEqual([winner.appointment_id])
    expect(await eventsOf(winner.appointment_id)).toEqual(['created'])
  })

  it('10 parallel bookings with one idempotency key: exactly 1 row, the other 9 replay it', async () => {
    const startsAt = await firstFreeSlot()
    expect(await appointmentsAt(startsAt)).toEqual([])
    const key = randomUUID()
    // A new client inline: a replay must not create a second client either.
    const clientName = `Race test ${key.slice(0, 8)}`

    const book = () =>
      owner.rpc('staff_book_appointment', {
        p_business_id: DEMO_BUSINESS_ID,
        p_service_ids: [serviceId],
        p_staff_id: staffId,
        p_starts_at: startsAt,
        p_new_client: { full_name: clientName },
        p_source: 'staff',
        p_idempotency_key: key,
      })
    await warmUp()
    const replies = await Promise.all(Array.from({ length: 10 }, book))

    expect(replies.map(outcome)).toEqual(Array<string>(10).fill('ok'))
    const bookings = replies.map((reply) => Booking.parse(reply.data))
    const [first] = bookings
    expect(new Set(bookings.map((booking) => booking.appointment_id))).toEqual(
      new Set([first?.appointment_id]),
    )
    expect(bookings.filter((booking) => !booking.replayed)).toHaveLength(1)

    const rows = await admin
      .from('appointments')
      .select('id, client_id')
      .eq('business_id', DEMO_BUSINESS_ID)
      .eq('idempotency_key', key)
    if (rows.error) throw rows.error
    expect(rows.data.map((row) => row.id)).toEqual([first?.appointment_id])
    expect(await appointmentsAt(startsAt)).toEqual([first?.appointment_id])
    expect(await eventsOf(first?.appointment_id ?? '')).toEqual(['created'])

    const clients = await admin
      .from('clients')
      .select('id')
      .eq('business_id', DEMO_BUSINESS_ID)
      .eq('full_name', clientName)
    if (clients.error) throw clients.error
    expect(clients.data.map((client) => client.id)).toEqual([rows.data[0]?.client_id])
  })
})
