import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod/mini'
import { provisionLocal, type E2eShop } from '../../e2e/lib/shops.ts'
import { adminClient, signInAs, signOut, type Db } from './lib/localStack.ts'

/**
 * Concurrency of the 1.6 schedule writes (0008, contract 1.6 §6.4): real HTTP requests through
 * PostgREST, each in its own transaction, as the pro app sends them.
 *
 *   · two `mark_absence` for the same staff member and window at once → exactly one time off
 *     (the per-staff advisory lock; the second call finds the first one's row and keeps it);
 *   · two `replace_week_hours` with different valid weeks at once → the stored week is exactly
 *     one of the two (the last one wins, never empty, never a mix). Every round starts from a
 *     third week, so BOTH calls differ from what is stored and both write (each answers
 *     `changed: true`): every round is contested, not only the first.
 *
 * On a dedicated synthetic shop (`race-schedule`, provisioned locally with the provisioning
 * script's own code), never on demo-barber: the e2e specs book there and need its hours. The
 * shop's hours are restored by provisioning at the start of every run.
 */
const ROUNDS = 5

const RACE_FILE = {
  business: {
    slug: 'race-schedule',
    name: 'Race Schedule',
    vertical: 'barber',
    timezone: 'Europe/Athens',
    currency: 'EUR',
    locale: 'el',
    booking_enabled: false,
    messaging_enabled: false,
  },
  services: [{ name: 'Κούρεμα', duration_min: 30, price_cents: 1300 }],
  staff: [
    {
      display_name: 'Ρ1',
      services: 'all',
      hours: { mon: ['09:00-17:00'] },
    },
  ],
  members: [{ email: 'owner@race-schedule.test', role: 'owner' }],
} as const

const Absence = z.object({
  time_off_id: z.string(),
  created: z.boolean(),
  extended: z.boolean(),
})

const WeekReply = z.object({
  changed: z.boolean(),
  rows: z.array(z.object({ weekday: z.number(), start_time: z.string(), end_time: z.string() })),
})

type WeekRow = { weekday: number; start_time: string; end_time: string }

let shop: E2eShop
let staffId: string
let owner: Db
let admin: Db

beforeAll(async () => {
  shop = (await provisionLocal(RACE_FILE)).shop
  const id = shop.staff['Ρ1']
  if (!id) throw new Error('the race shop has no staff member Ρ1')
  staffId = id
  admin = adminClient()
  owner = await signInAs(shop.ownerEmail)
  // A previous run's time off goes (the owner may delete time off; 0008 column grants).
  const cleared = await owner.from('time_off').delete().eq('business_id', shop.businessId)
  if (cleared.error) throw cleared.error
})

afterAll(async () => {
  if (owner) {
    await owner.from('time_off').delete().eq('business_id', shop.businessId)
    await signOut(owner)
  }
})

/** Every time off row of the staff member that overlaps [from, to). */
async function timeOffIn(from: string, to: string) {
  const { data, error } = await admin
    .from('time_off')
    .select('id, starts_at, ends_at, reason')
    .eq('business_id', shop.businessId)
    .eq('staff_id', staffId)
    .lt('starts_at', to)
    .gt('ends_at', from)
  if (error) throw error
  return data
}

async function storedWeek(): Promise<string> {
  const { data, error } = await admin
    .from('working_hours')
    .select('weekday, start_time, end_time')
    .eq('business_id', shop.businessId)
    .eq('staff_id', staffId)
  if (error) throw error
  return signature(
    data.map((row) => ({
      weekday: row.weekday,
      start_time: row.start_time.slice(0, 5),
      end_time: row.end_time.slice(0, 5),
    })),
  )
}

function signature(rows: readonly WeekRow[]): string {
  return rows
    .map((row) => `${row.weekday} ${row.start_time}-${row.end_time}`)
    .sort()
    .join('|')
}

describe('mark_absence under concurrency', () => {
  it('two calls for the same staff member and window write exactly one time off', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      // A future window per round (far away from anything else in the database).
      const from = `2093-03-${String(2 + round * 3).padStart(2, '0')}T08:00:00.000Z`
      const to = `2093-03-${String(2 + round * 3).padStart(2, '0')}T20:00:00.000Z`
      const call = () =>
        owner.rpc('mark_absence', {
          p_business_id: shop.businessId,
          p_staff_id: staffId,
          p_from: from,
          p_to: to,
        })
      const replies = await Promise.all([call(), call()])
      for (const reply of replies) expect(reply.error, JSON.stringify(reply.error)).toBeNull()
      const results = replies.map((reply) => Absence.parse(reply.data))
      // One call created the row, the other found it covering the window and kept it.
      expect(results.map((result) => result.created).sort()).toEqual([false, true])
      expect(results.some((result) => result.extended)).toBe(false)
      expect(new Set(results.map((result) => result.time_off_id)).size).toBe(1)

      const rows = await timeOffIn(from, to)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ reason: 'leave' })
    }
  })
})

describe('replace_week_hours under concurrency', () => {
  const weekA: WeekRow[] = [
    { weekday: 1, start_time: '09:00', end_time: '14:00' },
    { weekday: 1, start_time: '17:00', end_time: '21:00' },
    { weekday: 3, start_time: '10:00', end_time: '18:00' },
  ]
  const weekB: WeekRow[] = [
    { weekday: 2, start_time: '08:00', end_time: '12:00' },
    { weekday: 4, start_time: '12:00', end_time: '20:00' },
    { weekday: 6, start_time: '09:00', end_time: '15:00' },
    { weekday: 0, start_time: '10:00', end_time: '13:00' },
  ]

  /** The starting point of every round: neither A nor B. */
  const weekC: WeekRow[] = [{ weekday: 5, start_time: '09:00', end_time: '17:00' }]

  it('two different weeks at once: the stored week is exactly one of them', async () => {
    const outcomes = new Set<string>()
    const replace = (rows: WeekRow[]) =>
      owner.rpc('replace_week_hours', {
        p_business_id: shop.businessId,
        p_staff_id: staffId,
        p_rows: rows,
      })
    for (let round = 0; round < ROUNDS; round++) {
      // Without this reset, from round 1 on one call would find its own week stored, answer
      // `changed: false` and write nothing: only round 0 would be a race.
      const reset = await replace(weekC)
      expect(reset.error, JSON.stringify(reset.error)).toBeNull()
      expect(await storedWeek()).toBe(signature(weekC))

      // Alternate who is sent first, so both orders get exercised.
      const [first, second] = round % 2 === 0 ? [weekA, weekB] : [weekB, weekA]
      const replies = await Promise.all([replace(first), replace(second)])
      for (const reply of replies) expect(reply.error, JSON.stringify(reply.error)).toBeNull()
      // Both found something else stored (C, or the other's week once it committed): both wrote.
      expect(replies.map((reply) => WeekReply.parse(reply.data).changed)).toEqual([true, true])

      const stored = await storedWeek()
      expect([signature(weekA), signature(weekB)]).toContain(stored)
      outcomes.add(stored)
    }
    // Never empty, never a mix (checked per round above); report which weeks won.
    expect(outcomes.size).toBeGreaterThan(0)
  })
})
