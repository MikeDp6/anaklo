import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod/mini'
import { DEMO_BUSINESS_ID } from '../../e2e/lib/seedUsers.ts'
import { PRIVACY_NOTICE_VERSION } from '../../supabase/functions/_shared/booking-schemas.ts'
import { domainErrorCode } from '../../supabase/functions/_shared/errors.ts'
import { adminClient, serviceRpc, type Db, type ServiceRpcResult } from './lib/localStack.ts'
import { literal, PsqlSession, waitForLockWait } from './lib/psql.ts'

/**
 * Concurrency of the online booking (0005 book_appointment, contract 1.3 decision 9): the calls
 * the `public-booking` Edge Function makes as service_role, many at once over PostgREST.
 *
 * The OTP is started with an explicit code, as the function does for a test number. Online
 * bookings must fall inside the booking horizon, so every run takes the LAST free slot of the
 * horizon (the e2e specs book near the start); `npm run db:reset` clears them. Relies on the local
 * seed's relaxed OTP limits and zero resend cooldown.
 */
const PHONE = '+306900000777' // no client in the seed and not one of the e2e test numbers
const CODE = '424242'
const WINDOW_DAYS = 14 // the most one availability call accepts (AN002 beyond)

const OtpStarted = z.object({ challenge_id: z.string() })
const OtpVerified = z.object({ result: z.literal('verified'), grant: z.string() })
const Booked = z.object({
  appointment_id: z.string(),
  replayed: z.boolean(),
  verified_via: z.string(),
  manage_token: z.string(),
  message_ids: z.array(z.string()),
})
const Slot = z.object({ starts_at: z.string(), staff_ids: z.array(z.string()) })

let admin: Db
let serviceId: string
let horizonDays: number

function outcome(reply: ServiceRpcResult): string {
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

beforeAll(async () => {
  admin = adminClient()
  const business = await admin
    .from('businesses')
    .select('max_advance_days')
    .eq('id', DEMO_BUSINESS_ID)
    .single()
  if (business.error) throw business.error
  horizonDays = business.data.max_advance_days

  const service = await admin
    .from('services')
    .select('id')
    .eq('business_id', DEMO_BUSINESS_ID)
    .eq('active', true)
    .eq('online_bookable', true)
    .order('sort')
    .order('id')
    .limit(1)
    .single()
  if (service.error) throw service.error
  serviceId = service.data.id
})

/** The latest free public slot of the horizon (any staff member), as the server computes it. */
async function lastFreeSlot(): Promise<{ startsAt: string; staffId: string }> {
  const today = new Date().toISOString().slice(0, 10)
  for (let to = addDays(today, horizonDays); to >= today; to = addDays(to, -WINDOW_DAYS)) {
    const reply = await serviceRpc('available_slots', {
      p_slug: 'demo-barber',
      p_service_ids: [serviceId],
      p_staff_id: null, // any staff member
      p_from: addDays(to, -(WINDOW_DAYS - 1)),
      p_to: to,
    })
    expect(outcome(reply)).toBe('ok')
    const slots = z.array(Slot).parse(reply.data)
    const last = slots.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)).at(-1)
    const staffId = last?.staff_ids[0]
    if (last && staffId) return { startsAt: last.starts_at, staffId }
  }
  throw new Error('No free online slot left in the horizon. Run: npm run db:reset')
}

/** A live, unconsumed grant for PHONE, from the SQL side of `start` + `verify`. */
async function grantFor(slot: { startsAt: string; staffId: string }): Promise<string> {
  const started = await serviceRpc('otp_start', {
    p_business_id: DEMO_BUSINESS_ID,
    p_phone: PHONE,
    p_locale: 'el',
    p_service_ids: [serviceId],
    p_staff_id: slot.staffId,
    p_starts_at: slot.startsAt,
    p_ip: '127.0.0.1',
    p_code: CODE,
  })
  expect(outcome(started)).toBe('ok')
  const verified = await serviceRpc('otp_verify', {
    p_business_id: DEMO_BUSINESS_ID,
    p_phone: PHONE,
    p_challenge_id: OtpStarted.parse(started.data).challenge_id,
    p_code: CODE,
  })
  expect(outcome(verified)).toBe('ok')
  return OtpVerified.parse(verified.data).grant
}

/** Opens PostgREST's pool first (see booking-race.test.ts): cold, the race would test nothing. */
async function warmUp(grant: string): Promise<void> {
  const replies = await Promise.all(
    Array.from({ length: 20 }, () =>
      serviceRpc('clients_for_phone', {
        p_business_id: DEMO_BUSINESS_ID,
        p_phone: PHONE,
        p_grant: grant, // clients_for_phone never consumes it
        p_trusted_device_token: null,
      }),
    ),
  )
  for (const reply of replies) expect(outcome(reply)).toBe('ok')
}

function book(
  slot: { startsAt: string; staffId: string },
  grant: string,
  key: string,
  name: string,
): Promise<ServiceRpcResult> {
  return serviceRpc('book_appointment', {
    p_business_id: DEMO_BUSINESS_ID,
    p_idempotency_key: key,
    p_service_ids: [serviceId],
    p_staff_id: slot.staffId,
    p_starts_at: slot.startsAt,
    p_phone: PHONE,
    p_client_id: null,
    p_new_client: { full_name: name, locale: 'el' },
    p_grant: grant,
    p_trusted_device_token: null,
    p_marketing_box: 'unchecked',
    p_policy_version: PRIVACY_NOTICE_VERSION,
  })
}

/**
 * Ids of every appointment (any status) of the slot's staff member starting exactly then, minus
 * `existing`. A slot that an earlier run booked and then cancelled or moved away (the lock-order
 * cases below) is free again and becomes the next run's last free slot, so each case subtracts
 * the rows that were there before it started.
 */
async function appointmentsAt(
  slot: { startsAt: string; staffId: string },
  existing: readonly string[] = [],
): Promise<string[]> {
  const { data, error } = await admin
    .from('appointments')
    .select('id')
    .eq('business_id', DEMO_BUSINESS_ID)
    .eq('staff_id', slot.staffId)
    .eq('starts_at', slot.startsAt)
  if (error) throw error
  return data.map((row) => row.id).filter((id) => !existing.includes(id))
}

describe('online booking race (local stack, service_role over HTTP)', () => {
  it('10 parallel retries of one book (same key, same grant): 1 appointment, 9 replays, 1 confirmation', async () => {
    const slot = await lastFreeSlot()
    const existing = await appointmentsAt(slot)
    const grant = await grantFor(slot)
    const key = randomUUID()
    const name = `Online race ${key.slice(0, 8)}`
    await warmUp(grant)

    const replies = await Promise.all(
      Array.from({ length: 10 }, () => book(slot, grant, key, name)),
    )

    expect(replies.map(outcome)).toEqual(Array<string>(10).fill('ok'))
    const bookings = replies.map((reply) => Booked.parse(reply.data))
    const ids = new Set(bookings.map((booking) => booking.appointment_id))
    expect(ids.size).toBe(1)
    expect(bookings.filter((booking) => !booking.replayed)).toHaveLength(1)
    expect(new Set(bookings.map((booking) => booking.verified_via))).toEqual(new Set(['otp']))
    // Every retry gets its own working manage link.
    expect(new Set(bookings.map((booking) => booking.manage_token)).size).toBe(10)
    // One confirmation SMS (plus the staff pushes, contract 1.5 D27), the same ids returned to
    // every retry (a replay heals a send that never ran).
    expect(new Set(bookings.map((booking) => booking.message_ids.join(','))).size).toBe(1)
    const messages = [...new Set(bookings.flatMap((booking) => booking.message_ids))]
    const reader = new PsqlSession()
    try {
      expect(
        await reader.query(
          `select count(*) filter (where channel = 'sms' and template = 'booking_confirmed') || ' '
                  || count(*) filter (where channel = 'sms' and template <> 'booking_confirmed') || ' '
                  || count(*) filter (where channel = 'push' and template <> 'push_booking_created')
           from public.messages_log where id = any (array[${messages.map(literal).join(', ')}]::uuid[]);`,
        ),
      ).toBe('1 0 0\n')
    } finally {
      await reader.close()
    }
    expect(await appointmentsAt(slot, existing)).toEqual([...ids])

    const clients = await admin
      .from('clients')
      .select('id')
      .eq('business_id', DEMO_BUSINESS_ID)
      .eq('full_name', name)
    if (clients.error) throw clients.error
    expect(clients.data).toHaveLength(1)
  })

  it('10 parallel books with different keys and one grant: the grant books once, 9 × AN014', async () => {
    const slot = await lastFreeSlot()
    const existing = await appointmentsAt(slot)
    const grant = await grantFor(slot)
    await warmUp(grant)

    const replies = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const key = randomUUID()
        return book(slot, grant, key, `Online race ${key.slice(0, 8)} ${i}`)
      }),
    )

    expect(replies.map(outcome).sort()).toEqual([...Array<string>(9).fill('AN014'), 'ok'])
    const winner = Booked.parse(replies.find((reply) => reply.error === null)?.data)
    expect(winner.replayed).toBe(false)
    expect(await appointmentsAt(slot, existing)).toEqual([winner.appointment_id])
  })
})

/**
 * Lock order between the sender's claim / a booking replay and a change through the manage link
 * (0005 claim_messages, manage_cancel, manage_reschedule; 0004 move_core). Each case holds a
 * third transaction open so the change stops exactly between locking the appointment and its
 * next lock, then runs the other side: it must answer while the change still holds the
 * appointment. Before the fix both cases ended in 40P01 (deadlock detected).
 */
describe('lock order: no deadlock between a manage change and a claim or a replay (psql sessions)', () => {
  const sessions: PsqlSession[] = []
  const session = () => {
    const opened = new PsqlSession()
    sessions.push(opened)
    return opened
  }

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((opened) => opened.close()))
  })

  async function bookOnline(): Promise<{
    slot: { startsAt: string; staffId: string }
    grant: string
    key: string
    name: string
    booked: z.infer<typeof Booked>
  }> {
    const slot = await lastFreeSlot()
    const grant = await grantFor(slot)
    const key = randomUUID()
    const name = `Lock order ${key.slice(0, 8)}`
    const reply = await book(slot, grant, key, name)
    expect(outcome(reply)).toBe('ok')
    return { slot, grant, key, name, booked: Booked.parse(reply.data) }
  }

  it('the sender claims the confirmation while the same link cancels: the claim waits for nothing', async () => {
    const { booked } = await bookOnline()
    const token = literal(booked.manage_token)
    const holder = session()
    const cancel = session()
    const claim = session()
    // message_ids also carry the staff pushes (contract 1.5 D27): take the confirmation's id.
    const confirmation = (
      (await claim.query(
        `select id from public.messages_log
         where id = any (array[${booked.message_ids.map(literal).join(', ')}]::uuid[])
           and template = 'booking_confirmed';`,
      )) ?? ''
    ).trim()
    expect(confirmation).toMatch(/^[0-9a-f-]{36}$/)

    // The holder keeps one token row of the appointment: the cancel locks the appointment, then
    // stops at revoking its tokens, before its planner touches the queued confirmation.
    expect(
      await holder.query(
        `begin; select 1 from public.booking_tokens
         where token_hash = encode(sha256(convert_to(${token}, 'UTF8')), 'hex') for update;`,
      ),
    ).toBe('1\n')
    const cancelled = cancel.send(
      `begin; select private.manage_cancel_impl(${token}) ->> 'status';`,
    )
    expect(await waitForLockWait(claim, 'manage_cancel_impl')).toBe(true)

    const claimed = await claim.query(
      `begin; select jsonb_array_length(private.claim_messages_impl(array[${literal(confirmation)}]::uuid[])); commit;`,
      5_000,
    )
    await holder.query('rollback;')
    const cancelOutput = await cancelled.settle()
    await cancel.query('commit;')

    // The claim left the row to the cancel in flight: no send, no live link for a cancelled
    // appointment. (No API role reads these tables: read back as postgres.)
    expect(claimed).toBe('0\n')
    expect(cancelOutput).toBe('cancelled\n')
    const appointment = literal(booked.appointment_id)
    expect(
      await claim.query(
        `select string_agg(template || ':' || status || ':' || coalesce(error, ''), ',' order by template)
         from public.messages_log
         where appointment_id = ${appointment} and channel = 'sms' and template <> 'reminder';
         select count(*) from public.booking_tokens
         where appointment_id = ${appointment} and revoked_at is null;`,
      ),
    ).toBe('booking_confirmed:cancelled:superseded,cancelled_by_client:queued:\n0\n')
  })

  it('a replay of the booking while the same link moves it to an earlier day: the replay waits for nothing', async () => {
    const { slot, grant, key, name, booked } = await bookOnline()
    const day = slot.startsAt.slice(0, 10)
    const earlier = await serviceRpc('manage_slots', {
      p_token: booked.manage_token,
      p_from: addDays(day, -7),
      p_to: addDays(day, -1),
    })
    expect(outcome(earlier)).toBe('ok')
    const target = z
      .array(z.object({ starts_at: z.string(), local_date: z.string() }))
      .parse(earlier.data)[0]
    if (!target) throw new Error('No earlier free slot for the move. Run: npm run db:reset')

    const holder = session()
    const move = session()
    const replay = session()
    // The holder keeps the day lock of the target day (0004 lock_local_days): the move locks the
    // appointment, then waits for that day, the earlier of its two days.
    expect(
      await holder.query(
        `begin; select pg_advisory_xact_lock(hashtextextended(${literal(`${DEMO_BUSINESS_ID}:${target.local_date}`)}, 0));`,
      ),
    ).toBe('\n')
    const moved = move.send(
      `begin; select private.manage_reschedule_impl(${literal(booked.manage_token)}, ${literal(target.starts_at)}) ->> 'appointment_id';`,
    )
    expect(await waitForLockWait(replay, 'manage_reschedule_impl')).toBe(true)

    // The replay takes the ORIGINAL day's lock, then issues a new manage token for the same
    // appointment (its foreign-key check reads the appointment the move holds).
    const newClient = literal(JSON.stringify({ full_name: name, locale: 'el' }))
    const replayed = await replay.query(
      `begin; select private.book_appointment_impl(
         ${literal(DEMO_BUSINESS_ID)}, ${literal(key)}, array[${literal(serviceId)}]::uuid[],
         ${literal(slot.staffId)}, ${literal(slot.startsAt)}, ${literal(PHONE)}, null,
         ${newClient}::jsonb, ${literal(grant)}, null, 'unchecked', ${literal(PRIVACY_NOTICE_VERSION)}
       ) ->> 'replayed'; commit;`,
      5_000,
    )
    await holder.query('rollback;')
    const moveOutput = await moved.settle()
    await move.query('commit;')

    expect(replayed).toBe('true\n')
    expect(moveOutput).toBe(`${booked.appointment_id}\n`)
    const appointment = await admin
      .from('appointments')
      .select('starts_at')
      .eq('id', booked.appointment_id)
      .single()
    if (appointment.error) throw appointment.error
    expect(Date.parse(appointment.data.starts_at)).toBe(Date.parse(target.starts_at))
  })
})
