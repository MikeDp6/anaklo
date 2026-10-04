import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod/mini'
import { adminClient, signInAs } from './lib/localStack.ts'
import { literal, PsqlSession, waitForLockWait } from './lib/psql.ts'

/**
 * Review fix of contract 1.9b (§8 «Review fixes», finding 1): the Nous reset must never let a
 * session opened while the account was blocked see the block lifted. Whoever holds the member's
 * mailbox can sign in with the email code and wait on «Επικοινώνησε με τη Nous»; the moment the
 * reset lifts the block, that session (no device, no block) would get the first-enrolment `add`
 * grant without any code and enrol a device the detector then counts as approved.
 *
 *   · 0012 `record_support_action_impl('mfa_reset')` ends every session of the user (and its push
 *     devices) in the transaction that lifts the block;
 *   · 0012 `authorize_factor_change_impl` checks the session again once it holds the user's
 *     `factors:<uid>` lock, so a call already waiting for that lock when the reset commits is
 *     refused too (its first check ran before the commit).
 *
 * Lock order, with real GoTrue sessions over PostgREST: psql opens a transaction and records the
 * reset (it holds `factors:<uid>`; the block row and the sessions are deleted, not yet committed)
 * → the blocked member's live `aal1` session calls `authorize_factor_change('add')`, which passes
 * the first session check and waits for the lock → commit → the call answers 42501 without hint
 * and writes nothing. A NEW sign-in after the reset (the real member, on the phone with Nous)
 * gets the grant.
 *
 * Its own business (`e2e-reset-race`, created once and reused) and a NEW manager per run (Auth
 * admin; deleted at the end). The block row is written as postgres, as the detector would (the
 * drill `security-detection` covers how the detector writes it). Local stack only.
 */
const RUN = randomUUID().slice(0, 8)
const SLUG = 'e2e-reset-race'
/** Every business keeps an owner (0009): created once, reused by every run. */
const OWNER_EMAIL = 'owner@e2e-reset-race.test'
const MANAGER_EMAIL = `manager-${RUN}@e2e-reset-race.test`

const sessions: PsqlSession[] = []
let psql: PsqlSession
let businessId = ''
let managerId: string | undefined

function session(): PsqlSession {
  const opened = new PsqlSession()
  sessions.push(opened)
  return opened
}

/** Runs statements as postgres and returns what they printed; fails on an error or a timeout. */
async function run(sql: string, ms = 30_000): Promise<string> {
  const out = await psql.query(sql, ms)
  if (out === null) throw new Error(`psql timed out: ${sql.slice(0, 120)}`)
  if (out.includes('ERROR:')) throw new Error(`psql: ${out}`)
  return out.trim()
}

async function count(sql: string): Promise<number> {
  return Number.parseInt(await run(sql), 10)
}

beforeAll(async () => {
  psql = session()
  await run(
    `insert into public.businesses (slug, name, vertical, timezone, locale)
     values (${literal(SLUG)}, 'Reset Race', 'barber', 'Europe/Athens', 'el')
     on conflict (slug) do nothing;`,
  )
  businessId = await run(`select b.id from public.businesses b where b.slug = ${literal(SLUG)};`)
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
     values (${literal(businessId)}, ${literal(owner)}, 'owner')
     on conflict (business_id, user_id) do nothing;`,
  )
})

afterAll(async () => {
  try {
    if (managerId !== undefined) {
      // The D1 trigger revokes the sessions; deleting the user removes its grants and block row.
      await run(`delete from public.business_members where user_id = ${literal(managerId)};`)
      const { error } = await adminClient().auth.admin.deleteUser(managerId)
      if (error) throw error
    }
  } finally {
    // An open transaction (a failed step) is rolled back by the server.
    await Promise.all(sessions.splice(0).map((opened) => opened.close()))
  }
})

describe('the Nous reset and a session opened while blocked (contract 1.9b review fix)', () => {
  it('a call waiting for the factors lock when the reset commits is refused; a new sign-in enrols', async () => {
    const created = await adminClient().auth.admin.createUser({
      email: MANAGER_EMAIL,
      email_confirm: true,
    })
    if (created.error) throw created.error
    const manager = created.data.user.id
    managerId = manager
    const user = literal(manager)
    await run(
      `insert into public.business_members (business_id, user_id, role)
       values (${literal(businessId)}, ${user}, 'manager');
       insert into private.factor_enrolment_blocks (user_id, event_id, blocked_at)
       values (${user}, null, now());`,
    )

    // The session opened while blocked (email code, aal1): blocked, add → AN034.
    const blocked = await signInAs(MANAGER_EMAIL)
    const flag = await blocked.rpc('factor_enrolment_blocked')
    expect(flag.error).toBeNull()
    expect(z.boolean().parse(flag.data)).toBe(true)
    const refused = await blocked.rpc('authorize_factor_change', { p_action: 'add' })
    expect(refused.error).toMatchObject({ code: 'P0001', message: 'AN034' })

    // The reset in an open transaction: it holds factors:<uid> until the commit.
    const holder = session()
    expect(
      await holder.query(
        `begin; select private.record_support_action_impl(p_action => 'mfa_reset',
           p_reason => 'race: identity checked by call-back', p_ticket => 'RACE-1',
           p_user_id => ${user}) ->> 'enrolment_unblocked';`,
      ),
    ).toBe('true\n')

    // The blocked session asks for the grant meanwhile: it waits for the lock.
    const waiting = Promise.resolve(blocked.rpc('authorize_factor_change', { p_action: 'add' }))
    expect(await waitForLockWait(session(), 'authorize_factor_change')).toBe(true)
    const committed = await holder.query('commit;')
    expect(committed, 'the reset commits').not.toBeNull()
    expect(committed).not.toContain('ERROR')

    const answer = await waiting
    expect(answer.data, 'no grant for the session that saw the block').toBeNull()
    expect(answer.error).toMatchObject({ code: '42501', hint: null })
    expect(
      await count(
        `select count(*) from private.factor_change_grants g
         where g.user_id = ${user} and g.action = 'add';`,
      ),
      'no add grant written',
    ).toBe(0)
    expect(
      await count(`select count(*) from auth.sessions s where s.user_id = ${user};`),
      'every session ended with the reset',
    ).toBe(0)
    expect(
      await count(
        `select count(*) from private.factor_enrolment_blocks b where b.user_id = ${user};`,
      ),
    ).toBe(0)
    const afterwards = await blocked.rpc('factor_enrolment_blocked')
    expect(afterwards.error).toMatchObject({ code: '42501', hint: null })

    // The member signs in again (on the phone with Nous): not blocked, the grant is given.
    const member = await signInAs(MANAGER_EMAIL)
    const unblocked = await member.rpc('factor_enrolment_blocked')
    expect(unblocked.error).toBeNull()
    expect(z.boolean().parse(unblocked.data)).toBe(false)
    const grant = await member.rpc('authorize_factor_change', { p_action: 'add' })
    expect(grant.error).toBeNull()
    expect(
      await count(
        `select count(*) from private.factor_change_grants g
         where g.user_id = ${user} and g.action = 'add' and g.source = 'user';`,
      ),
    ).toBe(1)
  })
})
