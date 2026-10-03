import { randomUUID } from 'node:crypto'
import { expect } from '@playwright/test'
import { z } from 'zod/mini'
import { literal, PsqlSession } from '../../tests/db/lib/psql'

/**
 * Reads of the LOCAL database for the messaging e2e (contract 1.5 §5.6): the `docker exec` psql
 * session of tests/db/lib/psql.ts (the stack's own container, never a network address), as
 * postgres, read-only, one statement at a time (autocommit: every read sees the latest commit).
 * What the fake SMS adapter and the fake push sender "sent" is visible only here: a row of
 * `messages_log` with `status 'sent'` and `provider 'fake'`.
 */

const MessageRow = z.object({
  id: z.string(),
  channel: z.enum(['sms', 'push']),
  template: z.string(),
  status: z.string(),
  provider: z.nullable(z.string()),
  provider_message_id: z.nullable(z.string()),
  recipient_user_id: z.nullable(z.string()),
  error: z.nullable(z.string()),
})
export type MessageRow = z.infer<typeof MessageRow>

let session: PsqlSession | null = null

function db(): PsqlSession {
  session ??= new PsqlSession()
  return session
}

/** Ends this worker's psql session (call it from `test.afterAll`). */
export async function closeDb(): Promise<void> {
  const open = session
  session = null
  await open?.close()
}

/** One JSON value selected by `sql` (a single row, single column). */
async function selectJson(sql: string): Promise<unknown> {
  const printed = await db().query(sql, 10_000)
  if (printed === null) throw new Error('psql did not answer within 10″')
  if (printed.includes('ERROR:')) throw new Error(`psql: ${printed}`)
  const line = printed
    .split('\n')
    .map((text) => text.trim())
    .find((text) => /^[[{"]/.test(text) || text === 'null')
  if (line === undefined) throw new Error(`psql printed no JSON: ${printed}`)
  return JSON.parse(line) as unknown
}

/** Every `messages_log` row of an appointment, oldest first. */
export async function messagesOf(appointmentId: string): Promise<MessageRow[]> {
  const rows = await selectJson(
    `select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at, m.id), '[]'::jsonb)
       from (select id, channel, template, status, provider, provider_message_id,
                    recipient_user_id, error, created_at
               from public.messages_log
              where appointment_id = ${literal(appointmentId)}::uuid) m;`,
  )
  return z.array(MessageRow).parse(rows)
}

/**
 * Polls (≤ 15″) until the appointment has a row of `template` that satisfies `done` (by default:
 * `sent`), then returns it; for push, `recipient` picks the row of that user.
 */
export async function waitForMessage(
  appointmentId: string,
  template: string,
  options: { recipient?: string; done?: (row: MessageRow) => boolean; ms?: number } = {},
): Promise<MessageRow> {
  const done = options.done ?? ((row: MessageRow) => row.status === 'sent')
  let found: MessageRow | undefined
  await expect
    .poll(
      async () => {
        const rows = await messagesOf(appointmentId)
        found = rows.find(
          (row) =>
            row.template === template &&
            (options.recipient === undefined || row.recipient_user_id === options.recipient),
        )
        return found ? { template: found.template, status: found.status, done: done(found) } : null
      },
      { timeout: options.ms ?? 15_000, message: `${template} of ${appointmentId}` },
    )
    .toMatchObject({ done: true })
  if (!found) throw new Error(`no ${template} row`)
  return found
}

/** The active appointment of a staff member at an instant (set up through the pro UI). */
export async function appointmentAt(staffId: string, startsAt: string): Promise<string> {
  const id = await selectJson(
    `select coalesce((select to_json(a.id) from public.appointments a
                       where a.staff_id = ${literal(staffId)}::uuid
                         and a.starts_at = ${literal(startsAt)}::timestamptz
                         and a.status in ('booked', 'confirmed')
                       limit 1), 'null'::json);`,
  )
  if (typeof id !== 'string') throw new Error(`no active appointment at ${startsAt}`)
  return id
}

// ---------------------------------------------------------------------------------------------
// Step 1.6 (absence flow, contract 1.6 §6.6): the appointment after a reassignment or a
// cancellation, and the time off the flow wrote. Read-only, as above.
// ---------------------------------------------------------------------------------------------

const AppointmentState = z.object({
  status: z.string(),
  staff_id: z.string(),
  starts_at: z.string(),
  cancel_reason: z.nullable(z.string()),
})
export type AppointmentState = z.infer<typeof AppointmentState>

/** Status, staff member, start (ISO, UTC) and cancel reason of one appointment. */
export async function appointmentState(appointmentId: string): Promise<AppointmentState> {
  const row = await selectJson(
    `select coalesce((select jsonb_build_object(
               'status', a.status, 'staff_id', a.staff_id,
               'starts_at', to_char(a.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'cancel_reason', a.cancel_reason)
             from public.appointments a where a.id = ${literal(appointmentId)}::uuid),
             'null'::jsonb);`,
  )
  return AppointmentState.parse(row)
}

const TimeOffRow = z.object({ id: z.string(), reason: z.string() })

/** The time off rows of a staff member that overlap `[from, to)`. */
export async function timeOffOverlapping(
  staffId: string,
  from: string,
  to: string,
): Promise<z.infer<typeof TimeOffRow>[]> {
  const rows = await selectJson(
    `select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'reason', t.reason)
                               order by t.starts_at), '[]'::jsonb)
       from public.time_off t
      where t.staff_id = ${literal(staffId)}::uuid
        and tstzrange(t.starts_at, t.ends_at) && tstzrange(${literal(from)}::timestamptz,
                                                          ${literal(to)}::timestamptz);`,
  )
  return z.array(TimeOffRow).parse(rows)
}

// ---------------------------------------------------------------------------------------------
// Step 1.7 (contract 1.7 §7.4): what the security flows leave in the database. Read-only, as
// above, except `deleteMembership` (the members spec's clean-up of an earlier run). Authenticator
// secrets are read only for the synthetic e2e users (the enrolment spec compares the key on the
// screen with the stored one).
// ---------------------------------------------------------------------------------------------

/** The database's clock: rows written from now on have `created_at`/`at` ≥ it. */
export async function dbNow(): Promise<string> {
  const now = await selectJson(`select to_json(now());`)
  if (typeof now !== 'string') throw new Error('no now() from psql')
  return now
}

const FactorRow = z.object({
  id: z.string(),
  friendly_name: z.nullable(z.string()),
  status: z.string(),
})

/** The user's authenticator factors (any status), oldest first. */
export async function factorsOf(userId: string): Promise<z.infer<typeof FactorRow>[]> {
  const rows = await selectJson(
    `select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'friendly_name', f.friendly_name,
                                                  'status', f.status)
                               order by f.created_at, f.id), '[]'::jsonb)
       from auth.mfa_factors f where f.user_id = ${literal(userId)}::uuid;`,
  )
  return z.array(FactorRow).parse(rows)
}

/** The base32 secret Auth stored for a factor of a SYNTHETIC e2e user (null when none). */
export async function factorSecretOf(factorId: string): Promise<string | null> {
  const secret = await selectJson(
    `select coalesce((select to_json(f.secret) from auth.mfa_factors f
                       where f.id = ${literal(factorId)}::uuid), 'null'::json);`,
  )
  return z.nullable(z.string()).parse(secret)
}

/** How many Auth sessions the user has. */
export async function sessionCountOf(userId: string): Promise<number> {
  const row = await selectJson(
    `select json_build_object('count', count(*))
       from auth.sessions s where s.user_id = ${literal(userId)}::uuid;`,
  )
  return z.object({ count: z.number() }).parse(row).count
}

const GrantRow = z.object({
  action: z.string(),
  factor_id: z.nullable(z.string()),
  source: z.string(),
  minutes: z.number(),
})

/** The user's factor-change grants written at or after `since` (`minutes` = expires − created). */
export async function grantsOf(userId: string, since: string): Promise<z.infer<typeof GrantRow>[]> {
  const rows = await selectJson(
    `select coalesce(jsonb_agg(jsonb_build_object(
               'action', g.action, 'factor_id', g.factor_id, 'source', g.source,
               'minutes', extract(epoch from g.expires_at - g.created_at) / 60)
             order by g.created_at, g.id), '[]'::jsonb)
       from private.factor_change_grants g
      where g.user_id = ${literal(userId)}::uuid and g.created_at >= ${literal(since)}::timestamptz;`,
  )
  return z.array(GrantRow).parse(rows)
}

const AuditRow = z.object({
  business_id: z.string(),
  actor_type: z.string(),
  actor_id: z.nullable(z.string()),
  action: z.string(),
  entity: z.string(),
  entity_id: z.nullable(z.string()),
  reason: z.nullable(z.string()),
})
export type AuditRow = z.infer<typeof AuditRow>

/**
 * `audit_log` rows of these actions at or after `since`, narrowed to one business, one entity
 * and/or one actor (always narrow: the other browser project writes the same actions at the same
 * time in its own business).
 */
export async function auditRowsOf(filter: {
  actions: readonly string[]
  since: string
  businessId?: string
  entityId?: string
  actorId?: string
}): Promise<AuditRow[]> {
  const conditions = [
    `a.action in (${filter.actions.map(literal).join(', ')})`,
    `a.at >= ${literal(filter.since)}::timestamptz`,
    ...(filter.businessId ? [`a.business_id = ${literal(filter.businessId)}::uuid`] : []),
    ...(filter.entityId ? [`a.entity_id = ${literal(filter.entityId)}::uuid`] : []),
    ...(filter.actorId ? [`a.actor_id = ${literal(filter.actorId)}::uuid`] : []),
  ]
  const rows = await selectJson(
    `select coalesce(jsonb_agg(jsonb_build_object(
               'business_id', a.business_id, 'actor_type', a.actor_type, 'actor_id', a.actor_id,
               'action', a.action, 'entity', a.entity, 'entity_id', a.entity_id,
               'reason', a.reason) order by a.at, a.id), '[]'::jsonb)
       from public.audit_log a where ${conditions.join(' and ')};`,
  )
  return z.array(AuditRow).parse(rows)
}

/** The former slugs (aliases) of a business. */
export async function aliasesOf(businessId: string): Promise<string[]> {
  const rows = await selectJson(
    `select coalesce(jsonb_agg(a.slug order by a.slug), '[]'::jsonb)
       from public.business_slug_aliases a where a.business_id = ${literal(businessId)}::uuid;`,
  )
  return z.array(z.string()).parse(rows)
}

/** The business whose current slug this is (null when none). */
export async function businessIdForSlug(slug: string): Promise<string | null> {
  const id = await selectJson(
    `select coalesce((select to_json(b.id) from public.businesses b
                       where b.slug = ${literal(slug)}), 'null'::json);`,
  )
  return z.nullable(z.string()).parse(id)
}

/**
 * Clean-up of an earlier run, as postgres (the provisioning path): deletes one membership; the
 * 0009 trigger revokes the user's sessions in the same transaction. Returns the rows deleted.
 */
export async function deleteMembership(businessId: string, userId: string): Promise<number> {
  const result = await selectJson(
    `with d as (delete from public.business_members m
                 where m.business_id = ${literal(businessId)}::uuid
                   and m.user_id = ${literal(userId)}::uuid returning 1)
     select json_build_object('deleted', count(*)) from d;`,
  )
  return z.object({ deleted: z.number() }).parse(result).deleted
}

// ---------------------------------------------------------------------------------------------
// Step 1.8 (contract 1.8 §5.4): synthetic clients of the clients spec's own shop, and what an
// anonymisation leaves of them. `createClientFixture` is the second writing helper (after
// `deleteMembership`): LOCAL, as postgres, with the actor `system` declared inside its own
// transaction like seed.sql, never through PostgREST tables. Synthetic `+3069000…` numbers only.
// ---------------------------------------------------------------------------------------------

export interface ClientFixture {
  readonly clientId: string
  readonly appointmentId: string
  /** The business-local date (yyyy-MM-dd) of the completed visit. */
  readonly visitDate: string
}

/**
 * A client of the business with one `completed` «Κούρεμα» by `staffId`, `daysAgo` local days ago
 * at 10:00 in the business zone (a completed row never meets the double-booking constraint), and
 * a verified phone (as after an online booking). Ids are made here.
 */
export async function createClientFixture(
  businessId: string,
  staffId: string,
  client: { fullName: string; phoneE164: string; daysAgo?: number },
): Promise<ClientFixture> {
  if (!/^\+3069000\d{5}$/.test(client.phoneE164)) {
    throw new Error(`fixture phones are synthetic +3069000… numbers, not ${client.phoneE164}`)
  }
  const clientId = randomUUID()
  const appointmentId = randomUUID()
  const daysAgo = client.daysAgo ?? 10
  const result = await selectJson(
    `do $$
     declare
       v_tz text;
       v_day date;
       v_service uuid;
     begin
       perform set_config('anaklo.actor_type', 'system', true);
       select b.timezone into strict v_tz from public.businesses b
        where b.id = ${literal(businessId)}::uuid;
       v_day := (now() at time zone v_tz)::date - ${daysAgo};
       select s.id into strict v_service from public.services s
        where s.business_id = ${literal(businessId)}::uuid and s.name = 'Κούρεμα';
       insert into public.clients (id, business_id, full_name, phone_e164, phone_verified_at, source)
       values (${literal(clientId)}::uuid, ${literal(businessId)}::uuid,
               ${literal(client.fullName)}, ${literal(client.phoneE164)}, now(), 'online');
       insert into public.appointments (id, business_id, client_id, staff_id, starts_at, ends_at,
                                        status, source, total_cents, charged_cents)
       values (${literal(appointmentId)}::uuid, ${literal(businessId)}::uuid,
               ${literal(clientId)}::uuid, ${literal(staffId)}::uuid,
               (v_day + time '10:00') at time zone v_tz, (v_day + time '10:30') at time zone v_tz,
               'completed', 'phone', 1300, 1300);
       insert into public.appointment_services (business_id, appointment_id, position, service_id,
                                                price_cents, duration_min)
       values (${literal(businessId)}::uuid, ${literal(appointmentId)}::uuid, 0, v_service, 1300, 30);
     end;
     $$;
     select json_build_object(
       'visit_date', to_char((now() at time zone b.timezone)::date - ${daysAgo}, 'YYYY-MM-DD'))
       from public.businesses b where b.id = ${literal(businessId)}::uuid;`,
  )
  const { visit_date } = z.object({ visit_date: z.string() }).parse(result)
  return { clientId, appointmentId, visitDate: visit_date }
}

const ClientRow = z.object({
  full_name: z.string(),
  phone_e164: z.nullable(z.string()),
  email: z.nullable(z.string()),
  phone_verified_at: z.nullable(z.string()),
  erased_at: z.nullable(z.string()),
  merged_into_id: z.nullable(z.string()),
  search_text: z.string(),
})
export type ClientRow = z.infer<typeof ClientRow>

/** One client row (the identifying columns and the erase/merge markers). */
export async function clientRowOf(clientId: string): Promise<ClientRow> {
  const row = await selectJson(
    `select coalesce((select jsonb_build_object(
               'full_name', c.full_name, 'phone_e164', c.phone_e164, 'email', c.email,
               'phone_verified_at', c.phone_verified_at, 'erased_at', c.erased_at,
               'merged_into_id', c.merged_into_id, 'search_text', c.search_text)
             from public.clients c where c.id = ${literal(clientId)}::uuid), 'null'::jsonb);`,
  )
  return ClientRow.parse(row)
}

const ChildCounts = z.object({ notes: z.number(), consents: z.number(), appointments: z.number() })

/** How many notes, consent records and appointments point at the client. */
export async function clientChildCountsOf(clientId: string): Promise<z.infer<typeof ChildCounts>> {
  const row = await selectJson(
    `select json_build_object(
       'notes', (select count(*) from public.client_notes n where n.client_id = ${literal(clientId)}::uuid),
       'consents', (select count(*) from public.client_consents cc
                     where cc.client_id = ${literal(clientId)}::uuid),
       'appointments', (select count(*) from public.appointments a
                         where a.client_id = ${literal(clientId)}::uuid));`,
  )
  return ChildCounts.parse(row)
}

/**
 * The `suppression_list` reasons of a phone in a business, looked up by the HMAC the database
 * computes with its Vault key (`private.phone_hmac`): the number itself is never stored there.
 */
export async function suppressedFor(businessId: string, phoneE164: string): Promise<string[]> {
  const rows = await selectJson(
    `select coalesce(jsonb_agg(s.reason order by s.reason), '[]'::jsonb)
       from public.suppression_list s
      where s.business_id = ${literal(businessId)}::uuid
        and s.phone_hmac = private.phone_hmac(${literal(phoneE164)});`,
  )
  return z.array(z.string()).parse(rows)
}
