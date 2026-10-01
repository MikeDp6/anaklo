import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod/mini'
import { localSupabase } from '../../scripts/lib/cli.mjs'
import { DEMO_BUSINESS_ID, SEED_USERS } from '../../e2e/lib/seedUsers.ts'
import { DISPATCH_SECRET_HEADER } from '../../supabase/functions/_shared/dispatch-handler.ts'
import { literal, PsqlSession } from './lib/psql.ts'

/**
 * At most once (contract 1.5 §5.4, the exit criterion of step 1.5): the dispatcher's claim
 * (0007 claim_due_messages, FOR UPDATE SKIP LOCKED with a 60 s lease) and the sweep.
 *
 *   · two dispatchers at once, as two psql sessions that claim and record in a loop: the claimed
 *     sets are disjoint and cover every row, each row is sent once (attempts = 1);
 *   · the same over HTTP: two concurrent POST /functions/v1/dispatch (the real Edge Function
 *     with the fake push sender) → every row sent once;
 *   · a dispatcher killed mid-batch: its claimed rows are never claimed again (not even after
 *     the lease ran out), the sweep closes them as `unknown` and the dead lease's late results
 *     are refused: nothing is sent twice.
 *
 * The rows are `push_test` rows for the seed owner (who has a synthetic device in the seed).
 * The psql parts claim with a fixed `p_now` in the year 2000 and put their rows there: nothing
 * else in the database is due that early, so the loops never take (and "send") a real row, and
 * the sweep there only ever touches these rows. A real dispatcher (the 5′ pg_cron sweep, or the
 * nudge of a staff action) claims with the real now(), for which these rows are long expired:
 * it would cancel them. So those parts wait for a quiet minute first (`quietDispatcher`).
 * Needs `npm run db:start` + `npm run db:reset` (seed: Vault dispatch_url/secret, devices) and
 * the stack started with PUSH_PROVIDER and DISPATCH_SECRET (.env.example). Not with `npm run e2e`.
 */
const KEY_PREFIX = 'dispatch-race:'
const RUN = randomUUID().slice(0, 8)
const OWNER = SEED_USERS.owner.id

/** Two dispatchers (psql): rows scheduled here, claimed one minute later. */
const TWO_AT = '2000-01-03T10:00:00Z'
/** Killed mid-batch (psql). */
const KILLED_AT = '2000-01-03T11:00:00Z'
const TWO_ROWS = 40
const HTTP_ROWS = 20
const KILLED_ROWS = 8
/** quietDispatcher may wait up to ~2 minutes for a quiet window. */
const QUIET_TEST_TIMEOUT_MS = 300_000

const ClaimDue = z.object({
  items: z.array(z.object({ id: z.string(), lease_id: z.string(), channel: z.string() })),
  more: z.boolean(),
})
type ClaimDue = z.infer<typeof ClaimDue>

const DispatchAnswer = z.object({
  rounds: z.number(),
  claimed: z.number(),
  sent: z.number(),
  failed: z.number(),
  rejected: z.number(),
  unknown: z.number(),
})

const Row = z.object({
  id: z.string(),
  status: z.string(),
  attempts: z.number(),
  provider: z.nullable(z.string()),
  provider_message_id: z.nullable(z.string()),
  error: z.nullable(z.string()),
})
type Row = z.infer<typeof Row>

const sessions: PsqlSession[] = []
function session(): PsqlSession {
  const opened = new PsqlSession()
  sessions.push(opened)
  return opened
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((opened) => opened.close()))
})

/** Runs statements and returns what they printed; fails on an error or a timeout. */
async function run(on: PsqlSession, sql: string, ms = 15_000): Promise<string> {
  const out = await on.query(sql, ms)
  if (out === null) throw new Error(`psql timed out: ${sql.slice(0, 120)}`)
  if (out.includes('ERROR:')) throw new Error(`psql: ${out}`)
  return out.trim()
}

function plusSeconds(instant: string, seconds: number): string {
  return new Date(Date.parse(instant) + seconds * 1000).toISOString()
}

/** Inserts `count` queued push_test rows for the seed owner; returns their ids. */
async function insertRows(on: PsqlSession, tag: string, count: number, at: string | null) {
  const scheduled = at === null ? 'now()' : `${literal(at)}::timestamptz`
  const out = await run(
    on,
    `with inserted as (
       insert into public.messages_log
         (business_id, channel, template, category, locale, recipient_user_id, scheduled_for, dedupe_key)
       select ${literal(DEMO_BUSINESS_ID)}, 'push', 'push_test', 'transactional', 'el',
              ${literal(OWNER)}, ${scheduled}, ${literal(`${KEY_PREFIX}${tag}:${RUN}:`)} || g
       from generate_series(1, ${count}) g
       returning id
     )
     select string_agg(id::text, ',' order by id) from inserted;`,
  )
  const ids = out.split(',').filter((id) => id !== '')
  expect(ids).toHaveLength(count)
  return ids
}

async function rowsOf(on: PsqlSession, ids: readonly string[]): Promise<Row[]> {
  const out = await run(
    on,
    `select coalesce(json_agg(json_build_object(
       'id', m.id, 'status', m.status, 'attempts', m.attempts, 'provider', m.provider,
       'provider_message_id', m.provider_message_id, 'error', m.error) order by m.id), '[]')
     from public.messages_log m
     where m.id = any (${literal(`{${ids.join(',')}}`)}::uuid[]);`,
  )
  return z.array(Row).parse(JSON.parse(out))
}

async function claimDue(on: PsqlSession, now: string, limit = 5): Promise<ClaimDue> {
  const out = await run(
    on,
    `select private.claim_due_messages_impl(${limit}, ${literal(now)}::timestamptz);`,
  )
  return ClaimDue.parse(JSON.parse(out))
}

/** record_send_result_impl for each item; returns what each call answered ('t' / 'f'). */
async function record(
  on: PsqlSession,
  items: ReadonlyArray<{ id: string; lease_id: string }>,
  now: string,
): Promise<string[]> {
  if (items.length === 0) return []
  const out = await run(
    on,
    items
      .map(
        (item) =>
          `select private.record_send_result_impl(${literal(item.id)}::uuid, ${literal(item.lease_id)}::uuid,
             'sent', 'race', ${literal(`race-${item.id}`)}, null, null, null, ${literal(now)}::timestamptz);`,
      )
      .join('\n'),
  )
  return out.split('\n').map((line) => line.trim())
}

/**
 * One dispatcher: claims batches of 5 and records each as sent, until a claim finds nothing
 * (rows another session holds are skipped, never waited on). Returns every id it claimed.
 */
async function dispatcher(on: PsqlSession, now: string): Promise<string[]> {
  const claimed: string[] = []
  for (let round = 0; round < 100; round++) {
    const batch = await claimDue(on, now)
    if (batch.items.length === 0) return claimed
    expect(await record(on, batch.items, now)).toEqual(batch.items.map(() => 't'))
    claimed.push(...batch.items.map((item) => item.id))
  }
  throw new Error('the dispatcher loop did not end')
}

/**
 * Waits until no real dispatcher will run for a while: the pg_cron sweep fires every 5 minutes
 * of the DB clock and nudges `dispatch`; a staff action or a test push nudges it too. Returns
 * at least 40 s after a sweep, at least 60 s before the next, with no nudge queued and no
 * dispatch run finished in the last 10 s.
 */
async function quietDispatcher(probe: PsqlSession): Promise<void> {
  const deadline = Date.now() + 240_000
  for (;;) {
    const [second, queued, sinceRun] = (
      await run(
        probe,
        `select extract(epoch from now())::bigint % 300,
                (select count(*) from net.http_request_queue),
                coalesce(extract(epoch from now() - (
                  select max(r.finished_at) from private.job_runs r where r.job = 'dispatch'
                ))::bigint, 9999);`,
      )
    )
      .split('|')
      .map(Number)
    if (second !== undefined && second >= 40 && second <= 240 && queued === 0) {
      if (sinceRun !== undefined && sinceRun >= 10) return
    }
    if (Date.now() > deadline) throw new Error('the local dispatcher never went quiet')
    await delay(1000)
  }
}

let probe: PsqlSession

beforeAll(async () => {
  probe = new PsqlSession()
  // Rows of earlier runs that were left queued or leased (a crash) must not join this run.
  await run(
    probe,
    `delete from public.messages_log where dedupe_key like ${literal(`${KEY_PREFIX}%`)}
       and created_at < now() - interval '1 hour';
     update public.messages_log
        set status = 'cancelled', error = 'race_test_cleanup', lease_id = null, lease_until = null,
            updated_at = now()
      where dedupe_key like ${literal(`${KEY_PREFIX}%`)} and status in ('queued', 'sending');`,
  )
  // The claim needs the recipient's device (seed.sql, 0007 §2.12).
  const devices = await run(
    probe,
    `select count(*) from public.push_subscriptions where user_id = ${literal(OWNER)};`,
  )
  if (devices === '0') throw new Error('The seed owner has no push device. Run: npm run db:reset')
  return async () => {
    await probe.close()
  }
})

describe('dispatch: at most once (contract 1.5 §5.4)', () => {
  it(
    `two dispatchers at once (psql): disjoint claims cover all ${TWO_ROWS} rows, each sent once`,
    async () => {
      await quietDispatcher(probe)
      const ids = await insertRows(probe, 'two', TWO_ROWS, TWO_AT)
      const now = plusSeconds(TWO_AT, 60)

      const [first, second] = await Promise.all([
        dispatcher(session(), now),
        dispatcher(session(), now),
      ])

      const all = [...first, ...second]
      expect(new Set(all).size).toBe(all.length) // no row claimed by both
      expect(first.filter((id) => second.includes(id))).toEqual([])
      for (const id of ids) expect(all).toContain(id)
      const rows = await rowsOf(probe, ids)
      expect(rows.map((row) => `${row.status}:${row.attempts}:${row.provider ?? ''}`)).toEqual(
        rows.map(() => 'sent:1:race'),
      )
    },
    QUIET_TEST_TIMEOUT_MS,
  )

  it(`two dispatchers at once (HTTP, the Edge Function): all ${HTTP_ROWS} rows sent once`, async () => {
    const { apiUrl } = localSupabase()
    const secret = await run(
      probe,
      `select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_secret';`,
    )
    expect(secret.length).toBeGreaterThanOrEqual(32)
    const ids = await insertRows(probe, 'http', HTTP_ROWS, null)

    const post = () =>
      fetch(`${apiUrl}/functions/v1/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [DISPATCH_SECRET_HEADER]: secret },
        body: JSON.stringify({ source: 'test' }),
      })
    const answers = await Promise.all([post(), post()])
    for (const answer of answers) {
      const text = await answer.text()
      expect(answer.status, `${text} (is the stack started with DISPATCH_SECRET?)`).toBe(200)
      DispatchAnswer.parse(JSON.parse(text))
    }

    // Both answered after their last round; the cron dispatcher may have joined meanwhile.
    let rows: Row[] = []
    for (let wait = 0; wait < 30; wait++) {
      rows = await rowsOf(probe, ids)
      if (rows.every((row) => row.status !== 'queued' && row.status !== 'sending')) break
      await delay(500)
    }
    for (const row of rows) {
      expect(row, row.id).toMatchObject({ status: 'sent', attempts: 1, provider: 'fake' })
      expect(row.provider_message_id).toMatch(/^fake-push-[0-9a-f-]{36}$/)
    }
    expect(rows).toHaveLength(HTTP_ROWS)
  })

  it(
    'a dispatcher killed mid-batch: its rows are never claimed again, the sweep closes them as unknown',
    async () => {
      await quietDispatcher(probe)
      const ids = await insertRows(probe, 'killed', KILLED_ROWS, KILLED_AT)
      const now = plusSeconds(KILLED_AT, 60)

      // A claims a batch and dies before recording anything (the claim has committed).
      const killed = session()
      const batch = await claimDue(killed, now)
      expect(batch.items).toHaveLength(5)
      const dead = batch.items.map((item) => item.id)
      for (const id of dead) expect(ids).toContain(id)
      await killed.close()

      // B, 30 s later (A's lease still running), takes only the rest and sends it.
      const other = session()
      const rest = await claimDue(other, plusSeconds(now, 30))
      expect(rest.items.map((item) => item.id).filter((id) => dead.includes(id))).toEqual([])
      expect(rest.items.map((item) => item.id).sort()).toEqual(
        ids.filter((id) => !dead.includes(id)).sort(),
      )
      expect(await record(other, rest.items, plusSeconds(now, 30))).toEqual(['t', 't', 't'])

      // After A's lease ran out, before any sweep: still never claimed again (never re-sent).
      expect((await claimDue(other, plusSeconds(now, 90))).items).toEqual([])

      // The sweep closes A's rows as unknown (only rows leased before its p_now: these five).
      expect(
        await run(
          other,
          `select private.dispatch_sweep_impl(${literal(plusSeconds(now, 120))}::timestamptz);`,
        ),
      ).toBe('5')
      // A's late results are refused: its lease is gone.
      expect(await record(other, batch.items, plusSeconds(now, 180))).toEqual([
        'f',
        'f',
        'f',
        'f',
        'f',
      ])

      const rows = await rowsOf(probe, ids)
      const byId = new Map(rows.map((row) => [row.id, row]))
      for (const id of ids) {
        const row = byId.get(id)
        expect(row?.attempts, id).toBe(1)
        expect(row && `${row.status}:${row.error ?? ''}`, id).toBe(
          dead.includes(id) ? 'unknown:lease_expired' : 'sent:',
        )
      }
    },
    QUIET_TEST_TIMEOUT_MS,
  )
})
