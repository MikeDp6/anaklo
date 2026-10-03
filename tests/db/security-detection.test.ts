import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod/mini'
import { msUntilNextStep, totp, totpCounter } from '../../e2e/lib/totp.ts'
import { adminClient, signInAs, type Db } from './lib/localStack.ts'
import { literal, PsqlSession } from './lib/psql.ts'

/**
 * The detection drill of step 1.9 (contract 1.9 §5.4, D19; plan §1.9 «Χειροκίνητα τοπικά»): an
 * authenticator device added and one removed STRAIGHT AT GoTrue with an `aal2` session, never
 * through the app, are found by the detector (0011 `detect_factor_changes_impl`) and handled by
 * the REAL `dispatch` (pg_net nudge → Edge Function → fake email and push senders):
 *
 *   · an enrolment through the app's path (`authorize_factor_change('add')` first) → no event;
 *   · review fixes (contract 1.9 §8): a device enrolled and verified straight at GoTrue gives that
 *     session a fresh code that no critical RPC accepts (`authorize_factor_change` → 42501
 *     `fresh_totp_required`, also with the token kept after the device is unenrolled), and the device,
 *     unenrolled before the next run, is still found (GoTrue's audit log): sessions revoked, the
 *     member and the owner notified;
 *   · a second device enrolled without a grant → the device is deleted, every session of the
 *     member is revoked, the member and the owner get an email, the owner's push is sent;
 *     the next run does not flag the deletion (the `system` grant of the claim matched it);
 *   · the first device removed with `mfa.unenroll` → sessions revoked, the same notifications,
 *     nothing deleted.
 *
 * By default the detector is called through psql (the drill takes seconds). With
 * SECURITY_DRILL_CRON=1 it waits for the real `detect-factor-changes` job (every 5′) instead and
 * prints how long each step took: the manual check of plan §1.9 (contract §5.5-A).
 *
 * Its own business (`e2e-security-drill`, created once and reused; never demo-barber), its own
 * owner (created once, one synthetic OneSignal device) and a NEW manager per run (deleted at the
 * end). TOTP secrets stay in memory and are never printed. Local stack only (localStack.ts and
 * psql.ts refuse anything else); needs the stack started with EMAIL_PROVIDER and SUPPORT_EMAIL
 * (.env.example), else dispatch answers 500 not_configured and the events stay pending.
 */
const RUN = randomUUID().slice(0, 8)
const SLUG = 'e2e-security-drill'
const BUSINESS_NAME = 'Security Drill'
const OWNER_EMAIL = 'owner@e2e-security-drill.test'
const MANAGER_EMAIL = `manager-${RUN}@e2e-security-drill.test`
/** The owner's synthetic OneSignal subscription id (a UUID no OneSignal app has). */
const OWNER_DEVICE = '0e2e5ec0-d000-4000-8000-00000000d001'
const CRON = process.env.SECURITY_DRILL_CRON === '1'
/** The real dispatch after the detector's nudge: seconds (the 5′ sweep is the fallback). */
const HANDLED_WITHIN_MS = CRON ? 7 * 60_000 : 20_000
/** One cron period of the detector and a margin. */
const CRON_WAIT_MS = 6 * 60_000
const TEST_TIMEOUT_MS = CRON ? 40 * 60_000 : 240_000

const EventRow = z.object({
  id: z.string(),
  status: z.string(),
  result: z.nullable(z.string()),
  attempts: z.number(),
  emails_sent: z.nullable(z.number()),
  emails_failed: z.nullable(z.number()),
  push_queued: z.nullable(z.number()),
  error: z.nullable(z.string()),
  detected_at: z.string(),
  contained_at: z.nullable(z.string()),
  handled_at: z.nullable(z.string()),
})
type EventRow = z.infer<typeof EventRow>

let psql: PsqlSession
let businessId = ''
let ownerId = ''
let managerId: string | undefined
/** How long each step took (printed at the end; the record of the manual check). */
const timings: Record<string, number> = {}

/** Runs statements and returns what they printed; fails on an error or a timeout. */
async function run(sql: string, ms = 30_000): Promise<string> {
  const out = await psql.query(sql, ms)
  if (out === null) throw new Error(`psql timed out: ${sql.slice(0, 120)}`)
  if (out.includes('ERROR:')) throw new Error(`psql: ${out}`)
  return out.trim()
}

async function count(sql: string): Promise<number> {
  return Number.parseInt(await run(sql), 10)
}

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`${what}: ${error.message}`)
}

/** The business, the owner and its device: created once, reused by every run. */
async function ensureFixtures(): Promise<void> {
  await run(
    `insert into public.businesses (slug, name, vertical, timezone, locale)
     values (${literal(SLUG)}, ${literal(BUSINESS_NAME)}, 'barber', 'Europe/Athens', 'el')
     on conflict (slug) do nothing;`,
  )
  businessId = await run(`select b.id from public.businesses b where b.slug = ${literal(SLUG)};`)
  let owner = await run(`select id from auth.users where email = ${literal(OWNER_EMAIL)};`)
  if (owner === '') {
    const created = await adminClient().auth.admin.createUser({
      email: OWNER_EMAIL,
      email_confirm: true,
    })
    fail('create the drill owner', created.error)
    owner = created.data.user?.id ?? ''
  }
  ownerId = owner
  await run(
    `insert into public.business_members (business_id, user_id, role)
     values (${literal(businessId)}, ${literal(ownerId)}, 'owner')
     on conflict (business_id, user_id) do nothing;
     insert into public.push_subscriptions (user_id, provider, subscription_id)
     values (${literal(ownerId)}, 'onesignal', ${literal(OWNER_DEVICE)})
     on conflict (subscription_id) do nothing;`,
  )
}

/** A new manager of the drill business (Auth admin; the membership as postgres). */
async function createManager(): Promise<string> {
  const created = await adminClient().auth.admin.createUser({
    email: MANAGER_EMAIL,
    email_confirm: true,
  })
  fail('create the drill manager', created.error)
  const id = created.data.user?.id
  if (!id) throw new Error('create the drill manager: no id')
  managerId = id
  await run(
    `insert into public.business_members (business_id, user_id, role)
     values (${literal(businessId)}, ${literal(id)}, 'manager');`,
  )
  return id
}

type Enrolled = { factorId: string; secret: string; counter: number }

/** A new challenge and its verify with the current code (one retry of a 5xx challenge). */
async function challengeAndVerify(client: Db, factor: Enrolled): Promise<Enrolled> {
  // Never the same code twice for one factor (GoTrue refuses a reused code).
  if (totpCounter(Date.now()) <= factor.counter) await delay(msUntilNextStep() + 1_000)
  let challenge = await client.auth.mfa.challenge({ factorId: factor.factorId })
  if ((challenge.error?.status ?? 0) >= 500) {
    challenge = await client.auth.mfa.challenge({ factorId: factor.factorId })
  }
  fail('challenge', challenge.error)
  if (!challenge.data) throw new Error('challenge: no challenge')
  const at = Date.now()
  const verified = await client.auth.mfa.verify({
    factorId: factor.factorId,
    challengeId: challenge.data.id,
    code: totp(factor.secret, { at }),
  })
  fail('verify', verified.error)
  return { ...factor, counter: totpCounter(at) }
}

/** Enrols and verifies a TOTP device straight at GoTrue (no grant asked here). */
async function enrol(client: Db, name: string): Promise<Enrolled> {
  const enrolled = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: name })
  fail(`enrol ${name}`, enrolled.error)
  if (!enrolled.data) throw new Error(`enrol ${name}: no factor`)
  return challengeAndVerify(client, {
    factorId: enrolled.data.id,
    secret: enrolled.data.totp.secret,
    counter: -1,
  })
}

/**
 * One detector run: through psql by default; with SECURITY_DRILL_CRON=1 the next successful run
 * of the real job that STARTED after this call.
 */
async function detect(step: string): Promise<void> {
  const from = Date.now()
  if (!CRON) {
    const out = await run('select private.detect_factor_changes_impl();')
    // null = a failed run (recorded in job_runs with its SQLSTATE).
    expect(out, 'detect_factor_changes_impl failed: see private.job_runs').toMatch(/^\d+$/)
    return
  }
  const since = await run('select now();')
  const deadline = Date.now() + CRON_WAIT_MS
  for (;;) {
    const done = await count(
      `select count(*) from private.job_runs r
       where r.job = 'detect_factor_changes' and r.ok and r.started_at > ${literal(since)}::timestamptz;`,
    )
    if (done > 0) break
    if (Date.now() > deadline) throw new Error('detect-factor-changes did not run within 6 minutes')
    await delay(2_000)
  }
  timings[`${step}: wait for the detector (s)`] = Math.round((Date.now() - from) / 1000)
}

const HeldClaims = z.object({
  aal: z.string(),
  amr: z.array(z.object({ method: z.string(), timestamp: z.number() })),
})

/** The aal and amr of the access token a client holds (read, not verified: the stack signed it). */
async function heldClaims(client: Db): Promise<z.infer<typeof HeldClaims>> {
  const { data, error } = await client.auth.getSession()
  fail('getSession', error)
  const payload = data.session?.access_token.split('.')[1]
  if (!payload) throw new Error('no access token')
  return HeldClaims.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
}

/** authorize_factor_change as the client: `<code>/<hint>` of its error, or `ok`. */
async function authorize(client: Db, action: 'add' | 'remove', factorId?: string): Promise<string> {
  const args =
    factorId === undefined ? { p_action: action } : { p_action: action, p_factor_id: factorId }
  const { error } = await client.rpc('authorize_factor_change', args)
  return error === null ? 'ok' : `${error.code}/${error.hint ?? ''}`
}

async function eventsOf(userId: string, kind: string, factorId?: string): Promise<EventRow[]> {
  const out = await run(
    `select coalesce(json_agg(json_build_object(
       'id', e.id, 'status', e.status, 'result', e.result, 'attempts', e.attempts,
       'emails_sent', e.emails_sent, 'emails_failed', e.emails_failed,
       'push_queued', e.push_queued, 'error', e.error, 'detected_at', e.detected_at,
       'contained_at', e.contained_at, 'handled_at', e.handled_at) order by e.detected_at), '[]')
     from private.security_events e
     where e.user_id = ${literal(userId)} and e.kind = ${literal(kind)}
       ${factorId === undefined ? '' : `and e.factor_id = ${literal(factorId)}`};`,
  )
  return z.array(EventRow).parse(JSON.parse(out))
}

/** Waits until the one event of this factor is done (dispatch contained and notified it). */
async function handled(userId: string, kind: string, factorId: string): Promise<EventRow> {
  const deadline = Date.now() + HANDLED_WITHIN_MS
  for (;;) {
    const last = await eventsOf(userId, kind, factorId)
    const [only] = last
    if (last.length === 1 && only?.status === 'done') return only
    if (Date.now() > deadline) {
      throw new Error(
        `the ${kind} event was not handled in ${HANDLED_WITHIN_MS / 1000} s: ${JSON.stringify(last)}` +
          ' (is dispatch configured? EMAIL_PROVIDER/SUPPORT_EMAIL in .env.local, then db:stop/db:start)',
      )
    }
    await delay(500)
  }
}

function seconds(from: string, to: string | null): number {
  return to === null ? Number.NaN : Math.round((Date.parse(to) - Date.parse(from)) / 100) / 10
}

async function sessionsOf(userId: string): Promise<number> {
  return count(`select count(*) from auth.sessions where user_id = ${literal(userId)};`)
}

async function factorExists(factorId: string): Promise<boolean> {
  return (await count(`select count(*) from auth.mfa_factors where id = ${literal(factorId)};`)) > 0
}

/** The owner's push of this event: sent by the fake push sender. */
async function ownerPush(eventId: string): Promise<{ status: string; provider: string | null }> {
  const deadline = Date.now() + HANDLED_WITHIN_MS
  for (;;) {
    const out = await run(
      `select coalesce(json_agg(json_build_object('status', m.status, 'provider', m.provider)), '[]')
       from public.messages_log m
       where m.template = 'push_security_alert' and m.recipient_user_id = ${literal(ownerId)}
         and m.dedupe_key like ${literal(`security:${eventId}:%`)};`,
    )
    const rows = z
      .array(z.object({ status: z.string(), provider: z.nullable(z.string()) }))
      .parse(JSON.parse(out))
    const [only] = rows
    if (rows.length === 1 && only !== undefined && !['queued', 'sending'].includes(only.status)) {
      return only
    }
    if (Date.now() > deadline) throw new Error(`the owner's push was not sent: ${out}`)
    await delay(500)
  }
}

beforeAll(async () => {
  psql = new PsqlSession()
  await ensureFixtures()
})

afterAll(async () => {
  try {
    if (managerId !== undefined) {
      // The D1 trigger revokes and drops the remaining devices (with demotion grants); deleting
      // the user removes its snapshot rows, grants and events (cascade).
      await run(`delete from public.business_members where user_id = ${literal(managerId)};`)
      const { error } = await adminClient().auth.admin.deleteUser(managerId)
      fail('delete the drill manager', error)
    }
  } finally {
    await psql.close()
    if (Object.keys(timings).length > 0) {
      console.info(`[security-detection] ${JSON.stringify({ cron: CRON, ...timings })}`)
    }
  }
})

describe('detection of authenticator-device changes (contract 1.9 §5.4)', () => {
  it(
    'an app enrolment passes; a GoTrue device gives no fresh code and is found even when removed before the run; ' +
      'a direct add is deleted and notified; a direct removal is notified',
    async () => {
      const manager = await createManager()

      // 1. Through the app's path: the grant first (first device: no fresh code), then enrol.
      const client = await signInAs(MANAGER_EMAIL)
      const grant = await client.rpc('authorize_factor_change', { p_action: 'add' })
      fail('authorize_factor_change(add)', grant.error)
      let first = await enrol(client, 'drill-first')
      await detect('app enrolment')
      expect(await eventsOf(manager, 'factor_added_unauthorized')).toEqual([])
      expect(
        await count(
          `select count(*) from private.factor_change_grants g
           where g.user_id = ${literal(manager)} and g.action = 'add' and g.matched_at is not null;`,
        ),
        'the add grant was consumed',
      ).toBe(1)

      // 1b. Review fixes. Straight at GoTrue with the aal2 session, no grant: a device X0 whose verify
      //     makes the session's code fresh. No critical RPC accepts that code (the session's factor
      //     is not vetted): no grant to add, none to remove the member's own device.
      const transient = await enrol(client, 'drill-transient')
      const fresh = await heldClaims(client)
      expect(fresh.aal).toBe('aal2')
      expect(fresh.amr.some((entry) => entry.method === 'totp')).toBe(true)
      expect(await authorize(client, 'add'), 'a code from a device enrolled at GoTrue').toBe(
        '42501/fresh_totp_required',
      )
      expect(await authorize(client, 'remove', first.factorId)).toBe('42501/fresh_totp_required')
      //     X0 unenrolled before the next run: GoTrue drops the session to aal1, the token the
      //     client keeps still says aal2 with a fresh code, and it is refused all the same.
      const dropped = await client.auth.mfa.unenroll({ factorId: transient.factorId })
      fail('unenroll the transient device', dropped.error)
      expect((await heldClaims(client)).aal, 'the client still holds the aal2 token').toBe('aal2')
      expect(await authorize(client, 'add'), 'the token kept after the unenrol').toBe(
        '42501/fresh_totp_required',
      )
      expect(await factorExists(transient.factorId)).toBe(false)
      const transientAt = new Date().toISOString()
      await detect('transient device')
      const caught = await handled(manager, 'factor_added_unauthorized', transient.factorId)
      expect(caught).toMatchObject({ result: 'notified', emails_sent: 2, emails_failed: 0 })
      expect(caught.push_queued).toBe(1)
      expect(await sessionsOf(manager), 'every session of the member revoked').toBe(0)
      expect((await client.auth.refreshSession()).error, 'the revoked session').not.toBeNull()
      expect(await ownerPush(caught.id)).toEqual({ status: 'sent', provider: 'fake' })
      expect(await factorExists(first.factorId), 'the approved device stays').toBe(true)
      timings['transient device → detected (s)'] = seconds(transientAt, caught.detected_at)
      timings['transient detected → notified (s)'] = seconds(caught.detected_at, caught.handled_at)

      // 2. Signed in again (email code + the approved device), then straight at GoTrue with that
      //    aal2 session, no grant: a second device X.
      const resumed = await signInAs(MANAGER_EMAIL)
      first = await challengeAndVerify(resumed, first)
      expect(await sessionsOf(manager)).toBeGreaterThan(0)
      const added = await enrol(resumed, 'drill-unapproved')
      const addedAt = new Date().toISOString()
      await detect('direct add')
      const event = await handled(manager, 'factor_added_unauthorized', added.factorId)
      expect(event).toMatchObject({ result: 'notified', emails_sent: 2, emails_failed: 0 })
      expect(event.push_queued).toBe(1)
      expect(await factorExists(added.factorId), 'the unapproved device is deleted').toBe(false)
      expect(await factorExists(first.factorId), 'the approved device stays').toBe(true)
      expect(await sessionsOf(manager), 'every session of the member revoked').toBe(0)
      const refreshed = await resumed.auth.refreshSession()
      expect(refreshed.error, 'the revoked session cannot be refreshed').not.toBeNull()
      expect(await ownerPush(event.id)).toEqual({ status: 'sent', provider: 'fake' })
      timings['direct add → detected (s)'] = seconds(addedAt, event.detected_at)
      timings['detected → contained (s)'] = seconds(event.detected_at, event.contained_at)
      timings['detected → notified (s)'] = seconds(event.detected_at, event.handled_at)

      // The next run does not flag the deletion: the claim's system grant matched it.
      await detect('after the deletion')
      expect(await eventsOf(manager, 'factor_removed_unauthorized', added.factorId)).toEqual([])
      expect(
        await count(
          `select count(*) from private.factor_change_grants g
           where g.factor_id = ${literal(added.factorId)} and g.source = 'system'
             and g.matched_at is not null;`,
        ),
      ).toBe(1)

      // 3. The member signs in again (email code + the first device) and removes that device
      //    straight at GoTrue.
      const again = await signInAs(MANAGER_EMAIL)
      first = await challengeAndVerify(again, first)
      const removedAt = new Date().toISOString()
      const unenrolled = await again.auth.mfa.unenroll({ factorId: first.factorId })
      fail('unenroll', unenrolled.error)
      expect(await factorExists(first.factorId)).toBe(false)
      await detect('direct removal')
      const removal = await handled(manager, 'factor_removed_unauthorized', first.factorId)
      expect(removal).toMatchObject({ result: 'notified', emails_sent: 2, emails_failed: 0 })
      expect(await sessionsOf(manager), 'every session of the member revoked').toBe(0)
      expect((await again.auth.refreshSession()).error).not.toBeNull()
      expect(await ownerPush(removal.id)).toEqual({ status: 'sent', provider: 'fake' })
      // Never a second event for the same change, never one for the owner.
      expect(await eventsOf(manager, 'factor_removed_unauthorized')).toHaveLength(1)
      expect(await eventsOf(ownerId, 'factor_added_unauthorized')).toEqual([])
      timings['direct removal → detected (s)'] = seconds(removedAt, removal.detected_at)
      timings['removal detected → notified (s)'] = seconds(removal.detected_at, removal.handled_at)
    },
    TEST_TIMEOUT_MS,
  )
})
