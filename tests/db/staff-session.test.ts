import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, signInAs, signOutEverywhereKeepingToken, type Db } from './lib/localStack.ts'
import { literal, PsqlSession } from './lib/psql.ts'

/**
 * Contract 1.9b §7 item 2, the alternative Michalis approved on 2026-10-04 (ADR-0009 residual risk
 * (ii)): a STAFF membership counts only while the session of the JWT still exists (0012: the six
 * membership helpers need `private.session_alive()` for every role), checked here with REAL GoTrue
 * access tokens, which always carry `session_id` (pgTAP `17` uses synthetic claims):
 *
 *   · «Αποσύνδεση από όλες τις συσκευές» (GoTrue logout, scope global): the token the staff member
 *     keeps reads nothing and `today_summary` answers 42501 without hint at once (before: for up to
 *     1 h, until the token expired);
 *   · a removal from one of two businesses, written as provisioning would: the D1 trigger revokes
 *     every session of the user in the same transaction, and the kept token reads nothing, not even
 *     the business where the user is still staff;
 *   · a demotion (manager without a factor → staff): the same, through the same trigger;
 *   · a new sign-in reads again (the rule is per session, never per user).
 *
 * Its own two businesses (`e2e-staff-session-a`, `-b`, created once and reused; never demo-barber),
 * one owner of both (created once: every business keeps an owner) and a NEW user per run (Auth admin;
 * deleted at the end). Local stack only (localStack.ts and psql.ts refuse anything else).
 */
const RUN = randomUUID().slice(0, 8)
const SLUG_A = 'e2e-staff-session-a'
const SLUG_B = 'e2e-staff-session-b'
const OWNER_EMAIL = 'owner@e2e-staff-session.test'
const STAFF_EMAIL = `staff-${RUN}@e2e-staff-session.test`

let psql: PsqlSession
let businessA = ''
let businessB = ''
let staffId: string | undefined

/** Runs statements as postgres and returns what they printed; fails on an error or a timeout. */
async function run(sql: string, ms = 30_000): Promise<string> {
  const out = await psql.query(sql, ms)
  if (out === null) throw new Error(`psql timed out: ${sql.slice(0, 120)}`)
  if (out.includes('ERROR:')) throw new Error(`psql: ${out}`)
  return out.trim()
}

async function sessionsOf(userId: string): Promise<number> {
  return Number.parseInt(
    await run(`select count(*) from auth.sessions s where s.user_id = ${literal(userId)};`),
    10,
  )
}

/** The ids of the businesses the client's token reads (RLS, as PostgREST applies it), sorted. */
async function businessesSeen(client: Db): Promise<string[]> {
  const { data, error } = await client.from('businesses').select('id')
  if (error) throw new Error(`read businesses: ${error.message}`)
  return (data ?? []).map((row) => row.id).sort()
}

/** today_summary of business A as the client: `ok` or `<code>/<hint>` of its error. */
async function todaySummary(client: Db): Promise<string> {
  const { error } = await client.rpc('today_summary', { p_business_id: businessA })
  return error === null ? 'ok' : `${error.code}/${error.hint ?? ''}`
}

async function ensureBusiness(slug: string, name: string): Promise<string> {
  await run(
    `insert into public.businesses (slug, name, vertical, timezone, locale)
     values (${literal(slug)}, ${literal(name)}, 'barber', 'Europe/Athens', 'el')
     on conflict (slug) do nothing;`,
  )
  return run(`select b.id from public.businesses b where b.slug = ${literal(slug)};`)
}

beforeAll(async () => {
  psql = new PsqlSession()
  businessA = await ensureBusiness(SLUG_A, 'Staff Session A')
  businessB = await ensureBusiness(SLUG_B, 'Staff Session B')
  let owner = await run(`select id from auth.users where email = ${literal(OWNER_EMAIL)};`)
  if (owner === '') {
    const created = await adminClient().auth.admin.createUser({
      email: OWNER_EMAIL,
      email_confirm: true,
    })
    if (created.error) throw created.error
    owner = created.data.user.id
  }
  await run(
    `insert into public.business_members (business_id, user_id, role)
     values (${literal(businessA)}, ${literal(owner)}, 'owner'),
            (${literal(businessB)}, ${literal(owner)}, 'owner')
     on conflict (business_id, user_id) do nothing;`,
  )
})

afterAll(async () => {
  try {
    if (staffId !== undefined) {
      await run(`delete from public.business_members where user_id = ${literal(staffId)};`)
      const { error } = await adminClient().auth.admin.deleteUser(staffId)
      if (error) throw error
    }
  } finally {
    await psql.close()
  }
})

describe('a staff token stops with its session (contract 1.9b §7 item 2, approved)', () => {
  it('after «all devices», a removal and a demotion the kept token reads nothing; a new sign-in reads', async () => {
    const created = await adminClient().auth.admin.createUser({
      email: STAFF_EMAIL,
      email_confirm: true,
    })
    if (created.error) throw created.error
    const user = created.data.user.id
    staffId = user
    await run(
      `insert into public.business_members (business_id, user_id, role)
       values (${literal(businessA)}, ${literal(user)}, 'staff'),
              (${literal(businessB)}, ${literal(user)}, 'staff');`,
    )
    const both = [businessA, businessB].sort()

    // 1. «Αποσύνδεση από όλες τις συσκευές»: GoTrue ends every session; the client keeps its token.
    const first = await signInAs(STAFF_EMAIL)
    expect(await businessesSeen(first), 'the live session').toEqual(both)
    expect(await todaySummary(first)).toBe('ok')
    expect(await signOutEverywhereKeepingToken(first)).toBe(204)
    expect(await sessionsOf(user)).toBe(0)
    expect(await businessesSeen(first), 'the kept token after «all devices»').toEqual([])
    expect(await todaySummary(first), 'the kept token after «all devices»').toBe('42501/')

    // 2. Removed from B (as provisioning would write it): the D1 trigger ends every session.
    const second = await signInAs(STAFF_EMAIL)
    expect(await businessesSeen(second), 'a new sign-in reads again').toEqual(both)
    await run(
      `delete from public.business_members
       where business_id = ${literal(businessB)} and user_id = ${literal(user)};`,
    )
    expect(await sessionsOf(user)).toBe(0)
    expect(await businessesSeen(second), 'the kept token after the removal from B').toEqual([])
    expect(await todaySummary(second), 'the kept token after the removal from B').toBe('42501/')

    // 3. Promoted to manager of A (no factor yet: it reads at aal1), then demoted back to staff.
    await run(
      `update public.business_members set role = 'manager'
       where business_id = ${literal(businessA)} and user_id = ${literal(user)};`,
    )
    const third = await signInAs(STAFF_EMAIL)
    expect(await businessesSeen(third), 'the manager without a factor at aal1').toEqual([businessA])
    await run(
      `update public.business_members set role = 'staff'
       where business_id = ${literal(businessA)} and user_id = ${literal(user)};`,
    )
    expect(await sessionsOf(user)).toBe(0)
    expect(await businessesSeen(third), 'the kept token after the demotion').toEqual([])
    expect(await todaySummary(third), 'the kept token after the demotion').toBe('42501/')

    // 4. A new sign-in as staff of A reads A.
    const fourth = await signInAs(STAFF_EMAIL)
    expect(await businessesSeen(fourth)).toEqual([businessA])
    expect(await todaySummary(fourth)).toBe('ok')
  })
})
