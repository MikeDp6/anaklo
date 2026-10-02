-- Messaging (phase-1 plan 1.5, contract docs/plans/contracts/1.5-messaging.md §2, §5.1; SPEC §12):
-- the reminder time rules (private.reminder_at, around the DST change of 2026-10-25), planner v2
-- (confirmations, reminders, notices with notify, push recipients, import, walk-in, phone < 2 h),
-- the claim (both modes: leases, switches, caps, budget, suppression, deadlines, re-addressing, new
-- token per message, push checks and items), record_send_result (retries, unknown), delivery
-- reports, record_dispatch_run, the nudge through pg_net, request_test_push, the sweep, the purge
-- and the cron jobs. Written from the plan and the contract only (independent author).
--   · Planner integration fixtures are relative to now() (the planner has no clock argument): they
--     start at a fixed LOCAL time of a future LOCAL date (pg_temp.lt), so the reminder time is known.
--   · reminder_at, the claim/record/sweep/purge _impls and request_test_push_impl get fixed clocks.
--     Rows those sections need are written directly with instants in 2001–2006: the due claim and
--     the sweep look at the whole table, and nothing else in the database is due that early.
--   · Vault (upsert) and EVERY platform_settings column are set inside this transaction; the nudge
--     goes to a sentinel URL (http://127.0.0.1:9/pgtap-nudge) and never leaves the rolled-back
--     transaction (pg_net sends only after commit).
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
-- Fixtures are written by the system. Staff steps clear the actor (a declared 'system' would
-- outrank the JWT); client steps declare 'client'; every helper resets it to 'system' afterwards.
select set_config('anaklo.actor_type', 'system', true);
select plan(173);

-- ---------------------------------------------------------------------------------------------
-- Helpers (pg_temp). Results of calls are kept in transaction-local settings 't.<name>'.
-- ---------------------------------------------------------------------------------------------
create temporary table lbl (id uuid primary key, label text not null unique);

-- A statement whose value is kept in a setting prints nothing (a bare 'ok' line would be read as
-- a TAP result by pg_prove).
create function pg_temp.quiet(a_value text)
returns void
language plpgsql
as $fn$
begin
  null;
end;
$fn$;

-- A planner call outside an assertion must succeed (raises otherwise, so the file fails loudly).
create function pg_temp.must_ok(a_value text)
returns void
language plpgsql
as $fn$
begin
  if a_value is distinct from 'ok' then
    raise exception 'expected ok, got %', a_value;
  end if;
end;
$fn$;

create function pg_temp.r(a_name text)
returns jsonb
language sql
stable
as $fn$
  -- claim/due answers live under 'tj.' (a caller may store the label string under 't.<same name>')
  select coalesce(nullif(current_setting('tj.' || a_name, true), ''),
                  nullif(current_setting('t.' || a_name, true), ''))::jsonb;
$fn$;

create function pg_temp.id(a_label text)
returns uuid
language sql
stable
as $fn$
  select x.id from pg_temp.lbl x where x.label = a_label;
$fn$;

create function pg_temp.l(a_id uuid)
returns text
language sql
stable
as $fn$
  select case when a_id is null then '-'
              else coalesce((select x.label from pg_temp.lbl x where x.id = a_id), a_id::text) end;
$fn$;

create function pg_temp.err(a_state text, a_message text)
returns text
language sql
immutable
as $fn$
  select case when a_state = 'P0001' then 'P0001 ' || a_message else a_state end;
$fn$;

create function pg_temp.jwt(a_user uuid, a_aal text default 'aal1')
returns text
language sql
immutable
as $fn$
  select json_build_object('sub', a_user, 'role', 'authenticated', 'aal', a_aal)::text;
$fn$;

-- Runs one statement as an API role (optionally with JWT claims) and returns its single value,
-- '<null>', or the error.
create function pg_temp.as_role(a_role text, a_sql text, a_claims text default '')
returns text
language plpgsql
as $fn$
declare
  v text;
begin
  begin
    perform set_config('request.jwt.claims', a_claims, true);
    execute format('set local role %I', a_role);
    execute a_sql into v;
    v := coalesce(v, '<null>');
  exception when others then
    v := pg_temp.err(sqlstate, sqlerrm);
  end;
  execute 'set local role postgres';
  perform set_config('request.jwt.claims', '', true);
  return v;
end;
$fn$;

-- A staff RPC as a signed-in member (no declared actor → staff): 'ok' (answer in t.<a_name>) or the error.
create function pg_temp.call(a_name text, a_user uuid, a_sql text)
returns text
language plpgsql
as $fn$
declare
  v text;
begin
  perform set_config('anaklo.actor_type', '', true);
  v := pg_temp.as_role('authenticated', a_sql, pg_temp.jwt(a_user));
  perform set_config('anaklo.actor_type', 'system', true);
  perform set_config('anaklo.notify_client', '', true);
  if left(v, 1) in ('{', '[') then
    perform set_config('t.' || a_name, v, true);
    return 'ok';
  end if;
  return v;
end;
$fn$;

-- The planner called directly, with a declared actor ('' = staff through the JWT of a_user) and
-- the notify setting the 1.4 RPCs hand over. Everything is reset afterwards.
create function pg_temp.plan(a_id uuid, a_change text, a_actor text, a_user uuid default null, a_notify text default null)
returns text
language plpgsql
as $fn$
declare
  v text := 'ok';
begin
  perform set_config('anaklo.actor_type', coalesce(a_actor, ''), true);
  perform set_config('request.jwt.claims', case when a_user is null then '' else pg_temp.jwt(a_user) end, true);
  perform set_config('anaklo.notify_client', coalesce(a_notify, ''), true);
  begin
    perform private.plan_messages_impl(a_id, a_change);
  exception when others then
    v := pg_temp.err(sqlstate, sqlerrm);
  end;
  perform set_config('anaklo.actor_type', 'system', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('anaklo.notify_client', '', true);
  return v;
end;
$fn$;

-- The instant of a LOCAL wall-clock time a_days after today's local date in a_tz.
create function pg_temp.lt(a_days integer, a_time time, a_tz text default 'Europe/Athens')
returns timestamptz
language sql
stable
as $fn$
  select (((now() at time zone a_tz)::date + a_days) + a_time) at time zone a_tz;
$fn$;

-- Independent expectations of the reminder instant (no call into the migration):
--   24h            = the same local wall-clock time on the previous local date (D2);
--   evening_before = 18:00 local of the previous local date.
create function pg_temp.prev_day(a_starts timestamptz, a_tz text default 'Europe/Athens')
returns timestamptz
language sql
stable
as $fn$
  select ((a_starts at time zone a_tz) - interval '1 day') at time zone a_tz;
$fn$;

create function pg_temp.local_at(a_starts timestamptz, a_days_before integer, a_time time, a_tz text default 'Europe/Athens')
returns timestamptz
language sql
stable
as $fn$
  select (((a_starts at time zone a_tz)::date - a_days_before) + a_time) at time zone a_tz;
$fn$;

-- An appointment written directly (as seed.sql and imports do), with one service line (Cut).
create function pg_temp.mk(
  a_label text, a_business uuid, a_client uuid, a_staff uuid, a_starts timestamptz, a_source text,
  a_status text default 'booked'
)
returns uuid
language plpgsql
as $fn$
declare
  v_id uuid := gen_random_uuid();
  v_service uuid;
begin
  select s.id into v_service from public.services s where s.business_id = a_business order by s.sort, s.name limit 1;
  insert into public.appointments (id, business_id, client_id, staff_id, starts_at, ends_at, status, source,
                                   verified_via, total_cents, cancelled_by, cancel_reason)
  values (v_id, a_business, a_client, a_staff, a_starts, a_starts + interval '30 minutes', a_status, a_source,
          case when a_source = 'online' then 'otp' end, 1300,
          case when a_status = 'cancelled' then 'business' end, case when a_status = 'cancelled' then 'other' end);
  insert into public.appointment_services (business_id, appointment_id, position, service_id, price_cents, duration_min)
  values (a_business, v_id, 0, v_service, 1300, 30);
  insert into pg_temp.lbl (id, label) values (v_id, a_label);
  return v_id;
end;
$fn$;

-- A queued message written directly (dedupe 'pgtap12:<label>'); category from the template.
create function pg_temp.msg(
  a_label text, a_business uuid, a_template text, a_appointment uuid, a_client uuid, a_to text, a_user uuid,
  a_scheduled timestamptz, a_created timestamptz default null, a_status text default 'queued', a_cost integer default null
)
returns uuid
language plpgsql
as $fn$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into public.messages_log (id, business_id, client_id, appointment_id, dedupe_key, channel, to_e164,
                                   recipient_user_id, locale, template, category, status, scheduled_for,
                                   cost_cents, created_at, updated_at)
  values (v_id, a_business, a_client, a_appointment, 'pgtap12:' || a_label,
          case when a_template like 'push\_%' then 'push' else 'sms' end, a_to, a_user, 'el', a_template,
          case when a_template = 'reminder' then 'reminder' when a_template like 'push\_%' then 'transactional'
               else 'transactional' end,
          a_status, a_scheduled, a_cost, coalesce(a_created, now()), coalesce(a_created, now()));
  insert into pg_temp.lbl (id, label) values (v_id, a_label);
  return v_id;
end;
$fn$;

-- A queued OTP message with its challenge (the code is irrelevant here).
create function pg_temp.otp(a_label text, a_phone text, a_scheduled timestamptz, a_expires timestamptz,
                            a_status text default 'queued', a_created timestamptz default null)
returns uuid
language plpgsql
as $fn$
declare
  v_challenge uuid := gen_random_uuid();
  v_id uuid := gen_random_uuid();
begin
  insert into public.otp_challenges (id, business_id, phone_hmac, code_hmac, expires_at, created_at)
  values (v_challenge, 'e1100000-0000-4000-8000-00000000000a', repeat('a', 64), repeat('b', 64), a_expires,
          coalesce(a_created, a_scheduled));
  insert into public.messages_log (id, business_id, otp_challenge_id, dedupe_key, channel, to_e164, locale, template,
                                   category, status, scheduled_for, created_at, updated_at)
  values (v_id, 'e1100000-0000-4000-8000-00000000000a', v_challenge, 'otp:' || v_challenge::text, 'sms', a_phone,
          'el', 'otp', 'otp', a_status, a_scheduled, coalesce(a_created, now()), coalesce(a_created, now()));
  insert into pg_temp.lbl (id, label) values (v_id, a_label);
  insert into pg_temp.lbl (id, label) values (v_challenge, a_label || '.challenge');
  return v_id;
end;
$fn$;

-- claim_messages_impl (ids mode) of labelled rows at a clock: the claimed labels, sorted ('-' = none).
create function pg_temp.claim(a_name text, a_labels text[], a_now timestamptz)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.claim_messages_impl(
    (select array_agg(x.id) from pg_temp.lbl x where x.label = any (a_labels)), a_now);
  perform set_config('tj.' || a_name, v::text, true);
  return coalesce((select string_agg(pg_temp.l((i ->> 'id')::uuid), ',' order by pg_temp.l((i ->> 'id')::uuid))
                   from jsonb_array_elements(v) as i), '-');
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- claim_due_messages_impl at a clock: '<claimed labels> more=<more>' or the error.
create function pg_temp.due(a_name text, a_limit integer, a_now timestamptz)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.claim_due_messages_impl(a_limit, a_now);
  perform set_config('tj.' || a_name, v::text, true);
  return coalesce((select string_agg(pg_temp.l((i ->> 'id')::uuid), ',' order by pg_temp.l((i ->> 'id')::uuid))
                   from jsonb_array_elements(v -> 'items') as i), '-')
         || ' more=' || coalesce(v ->> 'more', '<null>');
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- The item of a labelled message in a stored claim answer (array, or {items}).
create function pg_temp.item(a_name text, a_label text)
returns jsonb
language sql
stable
as $fn$
  select i
  from jsonb_array_elements(case when jsonb_typeof(pg_temp.r(a_name)) = 'array' then pg_temp.r(a_name)
                                 else pg_temp.r(a_name) -> 'items' end) as i
  where (i ->> 'id')::uuid = pg_temp.id(a_label);
$fn$;

-- record_send_result_impl with the lease of the stored claim answer.
create function pg_temp.rec(a_claim text, a_label text, a_outcome text, a_now timestamptz,
                            a_provider_id text default null, a_segments integer default null,
                            a_cost integer default null, a_error text default null)
returns text
language plpgsql
as $fn$
begin
  return private.record_send_result_impl(
    pg_temp.id(a_label), (pg_temp.item(a_claim, a_label) ->> 'lease_id')::uuid, a_outcome, 'fake', a_provider_id,
    a_segments, a_cost, a_error, a_now)::text;
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- '<status>[:<error>]' of labelled messages, in the order given.
create function pg_temp.st(variadic a_labels text[])
returns text
language sql
stable
as $fn$
  select string_agg(coalesce(m.status || coalesce(':' || m.error, ''), '<none>'), ' ' order by t.ord)
  from unnest(a_labels) with ordinality as t (label, ord)
  left join public.messages_log m on m.id = pg_temp.id(t.label);
$fn$;

-- SMS rows of an appointment: '<template>:<status>[:<error>]', by template and time.
create function pg_temp.sms(a_label text)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(m.template || ':' || m.status || coalesce(':' || m.error, ''), ' '
                             order by m.template, m.scheduled_for, m.id), '-')
  from public.messages_log m
  where m.appointment_id = pg_temp.id(a_label) and m.channel = 'sms';
$fn$;

-- Recipients of the push rows of an appointment with one template, sorted ('-' = none).
create function pg_temp.push(a_label text, a_template text)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(pg_temp.l(m.recipient_user_id), ',' order by pg_temp.l(m.recipient_user_id)), '-')
  from public.messages_log m
  where m.appointment_id = pg_temp.id(a_label) and m.channel = 'push' and m.template = a_template;
$fn$;

-- Reminder rows of an appointment: '<status>[:<error>]', by time.
create function pg_temp.rems(a_label text)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(m.status || coalesce(':' || m.error, ''), ' ' order by m.scheduled_for, m.id), '-')
  from public.messages_log m
  where m.appointment_id = pg_temp.id(a_label) and m.template = 'reminder';
$fn$;

-- The reminder row of an appointment whose dedupe key names its CURRENT start (§2.7).
create function pg_temp.rem_now(a_label text)
returns uuid
language sql
stable
as $fn$
  select m.id
  from public.messages_log m
  join public.appointments a on a.id = m.appointment_id
  where a.id = pg_temp.id(a_label)
    and m.dedupe_key = 'appt:' || a.id::text || ':reminder:' || extract(epoch from a.starts_at)::bigint::text;
$fn$;

-- The id of the single row of an appointment with one template (errors if there are several).
create function pg_temp.one(a_label text, a_template text)
returns uuid
language sql
stable
as $fn$
  select m.id from public.messages_log m
  where m.appointment_id = pg_temp.id(a_label) and m.template = a_template and m.channel = 'sms';
$fn$;

-- Nudges queued by THIS transaction (the sentinel URL exists only here).
create function pg_temp.nudges()
returns bigint
language sql
stable
as $fn$
  select count(*) from net.http_request_queue q where q.url = 'http://127.0.0.1:9/pgtap-nudge';
$fn$;

-- The last nudge of this transaction: '<secret header ok> <content type ok> <source>'.
create function pg_temp.last_nudge()
returns text
language sql
stable
as $fn$
  select concat_ws(' ',
    q.headers ->> 'x-anaklo-dispatch-secret' = 'pgtap-12-dispatch-secret-not-a-secret-0001',
    q.headers ->> 'Content-Type' = 'application/json',
    convert_from(q.body, 'UTF8')::jsonb ->> 'source')
  from net.http_request_queue q
  where q.url = 'http://127.0.0.1:9/pgtap-nudge'
  order by q.id desc
  limit 1;
$fn$;

-- Vault upsert (update when the name exists, else create); a_new_name renames the secret.
create function pg_temp.set_vault(a_name text, a_value text, a_new_name text default null)
returns void
language plpgsql
as $fn$
declare
  v_id uuid;
begin
  select s.id into v_id from vault.secrets s where s.name = a_name;
  if v_id is null then
    perform vault.create_secret(a_value, coalesce(a_new_name, a_name), 'pgTAP 12_messaging');
  else
    perform vault.update_secret(v_id, a_value, coalesce(a_new_name, a_name), 'pgTAP 12_messaging');
  end if;
end;
$fn$;

-- The job runs written between two clock readings (one call of a job).
create function pg_temp.runs(a_from text, a_to text)
returns text
language sql
stable
as $fn$
  select string_agg(concat_ws(' ', j.job, j.ok::text, coalesce(j.rows_affected::text, '-'), coalesce(j.error, '-')),
                    ', ' order by j.id)
  from private.job_runs j
  where j.started_at >= a_from::timestamptz and j.finished_at <= a_to::timestamptz;
$fn$;

create function pg_temp.keys(a_object jsonb)
returns text[]
language sql
immutable
as $fn$
  select array_agg(k order by k) from jsonb_object_keys(a_object) as k;
$fn$;

grant execute on function pg_temp.lt(integer, time, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Keys, switches and caps of this test (all inside the transaction; the rollback restores them)
-- ---------------------------------------------------------------------------------------------
select pg_temp.set_vault('phone_hmac_key', 'pgtap-12-phone-hmac-key-not-a-secret-001');
select pg_temp.set_vault('dispatch_url', 'http://127.0.0.1:9/pgtap-nudge');
select pg_temp.set_vault('dispatch_secret', 'pgtap-12-dispatch-secret-not-a-secret-0001');

update private.platform_settings
set sms_enabled = true, sms_daily_cap = 100000, otp_per_phone_hour = 3, otp_per_ip_hour = 10,
    otp_per_business_day = 40, otp_resend_seconds = 60, sms_per_phone_day = 1000,
    sms_per_business_day = 100000, sms_otp_reserve_pct = 20, push_enabled = true,
    sms_monthly_cap = 1000000, sms_unit_cost_cents = 5, updated_at = now();

-- ---------------------------------------------------------------------------------------------
-- Fixture (as postgres). Never the seed's rows (db:test:dev has no seed).
--   M 'msg-shop' Europe/Athens, el, quiet 22:00–09:00, reminder 24h, booking on, 15′ grid.
--     UM0 owner (staff SM0) · UM1 staff (SM1) · UM2 staff (SM2, NO device) · UM3 staff (SM3,
--     push_own = false) · UMM manager (defaults: no pushes) · UMP manager (push_all = true) ·
--     UM9 second owner (no staff row). Everyone of M except UM2 has a device; UM0 has two
--     (OneSignal, then VAPID).
--   N 'msg-ny' America/New_York, en: UN0 owner (staff SN0), one device.
--   UX: a device but no membership anywhere.
--   Services: M Κούρεμα 30′ (first) and Γένια 20′; N Haircut 30′. Everyone works 00:00–24:00.
--   Clients of M: C1 Γιώργος Παπαδόπουλος (el) · C2 Anna Smith (en) · C3 landline · C4 no phone ·
--     C5 suppressed phone · C6 erased later · C7 changes phone later. N: CN1 (+1, en).
-- ---------------------------------------------------------------------------------------------
insert into pg_temp.lbl (id, label) values
  ('e1100000-0000-4000-8000-00000000000a', 'M'),
  ('e1100000-0000-4000-8000-00000000000b', 'N'),
  ('e1000000-0000-4000-8000-0000000000a0', 'UM0'),
  ('e1000000-0000-4000-8000-0000000000a1', 'UM1'),
  ('e1000000-0000-4000-8000-0000000000a2', 'UM2'),
  ('e1000000-0000-4000-8000-0000000000a3', 'UM3'),
  ('e1000000-0000-4000-8000-0000000000a4', 'UMM'),
  ('e1000000-0000-4000-8000-0000000000a5', 'UMP'),
  ('e1000000-0000-4000-8000-0000000000a9', 'UM9'),
  ('e1000000-0000-4000-8000-0000000000b0', 'UN0'),
  ('e1000000-0000-4000-8000-0000000000c0', 'UX'),
  ('e1200000-0000-4000-8000-0000000000a0', 'SM0'),
  ('e1200000-0000-4000-8000-0000000000a1', 'SM1'),
  ('e1200000-0000-4000-8000-0000000000a2', 'SM2'),
  ('e1200000-0000-4000-8000-0000000000a3', 'SM3'),
  ('e1200000-0000-4000-8000-0000000000b0', 'SN0'),
  ('e1300000-0000-4000-8000-000000000001', 'C1'),
  ('e1300000-0000-4000-8000-000000000002', 'C2'),
  ('e1300000-0000-4000-8000-000000000003', 'C3'),
  ('e1300000-0000-4000-8000-000000000004', 'C4'),
  ('e1300000-0000-4000-8000-000000000005', 'C5'),
  ('e1300000-0000-4000-8000-000000000006', 'C6'),
  ('e1300000-0000-4000-8000-000000000007', 'C7'),
  ('e1300000-0000-4000-8000-0000000000b1', 'CN1');

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select x.id, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated',
       lower(x.label) || '@messaging.test', '{}'::jsonb, '{}'::jsonb, now(), now()
from pg_temp.lbl x
where x.label like 'U%';

insert into public.businesses (id, slug, name, vertical, timezone, locale, booking_enabled, slot_step_min,
                               min_notice_min, max_advance_days, messaging_enabled, quiet_start, quiet_end,
                               reminder_mode, import_reminders) values
  ('e1100000-0000-4000-8000-00000000000a', 'msg-shop', 'Msg Shop', 'barber', 'Europe/Athens', 'el', true, 15,
   60, 60, true, '22:00', '09:00', '24h', false),
  ('e1100000-0000-4000-8000-00000000000b', 'msg-ny', 'Msg NY', 'barber', 'America/New_York', 'en', true, 15,
   60, 60, true, '22:00', '09:00', '24h', false);

insert into public.staff (id, business_id, display_name, sort) values
  ('e1200000-0000-4000-8000-0000000000a0', 'e1100000-0000-4000-8000-00000000000a', 'SM0', 0),
  ('e1200000-0000-4000-8000-0000000000a1', 'e1100000-0000-4000-8000-00000000000a', 'SM1', 1),
  ('e1200000-0000-4000-8000-0000000000a2', 'e1100000-0000-4000-8000-00000000000a', 'SM2', 2),
  ('e1200000-0000-4000-8000-0000000000a3', 'e1100000-0000-4000-8000-00000000000a', 'SM3', 3),
  ('e1200000-0000-4000-8000-0000000000b0', 'e1100000-0000-4000-8000-00000000000b', 'SN0', 0);

insert into public.business_members (business_id, user_id, role, staff_id) values
  ('e1100000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-0000000000a0', 'owner', 'e1200000-0000-4000-8000-0000000000a0'),
  ('e1100000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-0000000000a1', 'staff', 'e1200000-0000-4000-8000-0000000000a1'),
  ('e1100000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-0000000000a2', 'staff', 'e1200000-0000-4000-8000-0000000000a2'),
  ('e1100000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-0000000000a3', 'staff', 'e1200000-0000-4000-8000-0000000000a3'),
  ('e1100000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-0000000000a4', 'manager', null),
  ('e1100000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-0000000000a5', 'manager', null),
  ('e1100000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-0000000000a9', 'owner', null),
  ('e1100000-0000-4000-8000-00000000000b', 'e1000000-0000-4000-8000-0000000000b0', 'owner', 'e1200000-0000-4000-8000-0000000000b0');

insert into public.member_notification_prefs (business_id, user_id, push_own, push_all) values
  ('e1100000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-0000000000a5', null, true),
  ('e1100000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-0000000000a3', false, null);

insert into public.push_subscriptions (user_id, provider, subscription_id, endpoint, p256dh, auth_secret, created_at) values
  ('e1000000-0000-4000-8000-0000000000a0', 'onesignal', 'e10f0000-0000-4000-8000-0000000000a0', null, null, null, now() - interval '2 hours'),
  ('e1000000-0000-4000-8000-0000000000a0', 'vapid', null, 'https://push.example.test/e1/a0',
   'B' || repeat('m', 86), 'a' || repeat('m', 21), now() - interval '1 hour'),
  ('e1000000-0000-4000-8000-0000000000a1', 'onesignal', 'e10f0000-0000-4000-8000-0000000000a1', null, null, null, now() - interval '1 hour'),
  ('e1000000-0000-4000-8000-0000000000a3', 'onesignal', 'e10f0000-0000-4000-8000-0000000000a3', null, null, null, now() - interval '1 hour'),
  ('e1000000-0000-4000-8000-0000000000a4', 'onesignal', 'e10f0000-0000-4000-8000-0000000000a4', null, null, null, now() - interval '1 hour'),
  ('e1000000-0000-4000-8000-0000000000a5', 'onesignal', 'e10f0000-0000-4000-8000-0000000000a5', null, null, null, now() - interval '1 hour'),
  ('e1000000-0000-4000-8000-0000000000a9', 'onesignal', 'e10f0000-0000-4000-8000-0000000000a9', null, null, null, now() - interval '1 hour'),
  ('e1000000-0000-4000-8000-0000000000b0', 'onesignal', 'e10f0000-0000-4000-8000-0000000000b0', null, null, null, now() - interval '1 hour'),
  ('e1000000-0000-4000-8000-0000000000c0', 'onesignal', 'e10f0000-0000-4000-8000-0000000000c0', null, null, null, now() - interval '1 hour');

insert into public.services (id, business_id, name, duration_min, buffer_after_min, price_cents, sort) values
  ('e1400000-0000-4000-8000-0000000000a1', 'e1100000-0000-4000-8000-00000000000a', 'Κούρεμα', 30, 0, 1300, 0),
  ('e1400000-0000-4000-8000-0000000000a2', 'e1100000-0000-4000-8000-00000000000a', 'Γένια', 20, 0, 800, 1),
  ('e1400000-0000-4000-8000-0000000000b1', 'e1100000-0000-4000-8000-00000000000b', 'Haircut', 30, 0, 3000, 0);

insert into public.staff_services (business_id, staff_id, service_id)
select st.business_id, st.id, sv.id
from public.staff st join public.services sv on sv.business_id = st.business_id
where st.business_id in ('e1100000-0000-4000-8000-00000000000a', 'e1100000-0000-4000-8000-00000000000b');

insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
select st.business_id, st.id, d, time '00:00', time '24:00'
from public.staff st cross join generate_series(0, 6) as d
where st.business_id in ('e1100000-0000-4000-8000-00000000000a', 'e1100000-0000-4000-8000-00000000000b');

insert into public.clients (id, business_id, full_name, phone_e164, locale, source) values
  ('e1300000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-00000000000a', 'Γιώργος Παπαδόπουλος', '+306912300001', 'el', 'online'),
  ('e1300000-0000-4000-8000-000000000002', 'e1100000-0000-4000-8000-00000000000a', 'Anna Smith', '+306912300002', 'en', 'online'),
  ('e1300000-0000-4000-8000-000000000003', 'e1100000-0000-4000-8000-00000000000a', 'Λάμπρος Σταθερός', '+302101234567', 'el', 'staff'),
  ('e1300000-0000-4000-8000-000000000004', 'e1100000-0000-4000-8000-00000000000a', 'Νίκη Χωρίς', null, 'el', 'staff'),
  ('e1300000-0000-4000-8000-000000000005', 'e1100000-0000-4000-8000-00000000000a', 'Σούλα Μπλοκ', '+306912300005', 'el', 'import'),
  ('e1300000-0000-4000-8000-000000000006', 'e1100000-0000-4000-8000-00000000000a', 'Ερασμία Σβήσιμο', '+306912300006', 'el', 'staff'),
  ('e1300000-0000-4000-8000-000000000007', 'e1100000-0000-4000-8000-00000000000a', 'Βασίλειος Αλλαγή', '+306912300070', 'el', 'staff'),
  ('e1300000-0000-4000-8000-0000000000b1', 'e1100000-0000-4000-8000-00000000000b', 'John Doe', '+12125550101', 'en', 'online');

-- C5's number asked not to be messaged by M (the HMAC of this test's key).
insert into public.suppression_list (business_id, phone_hmac, reason)
values ('e1100000-0000-4000-8000-00000000000a', private.phone_hmac('+306912300005'), 'opted_out');

-- ---------------------------------------------------------------------------------------------
-- A. private.reminder_at: the only place of the reminder time rules (§2.6), fixed clocks.
--    Europe/Athens, quiet 22:00–09:00 unless noted. 2026-10-25: 04:00 EEST → 03:00 EET.
-- ---------------------------------------------------------------------------------------------
create function pg_temp.ra(
  a_starts timestamptz, a_mode text, a_now timestamptz, a_tz text default 'Europe/Athens',
  a_qs time default '22:00', a_qe time default '09:00'
)
returns text
language sql
stable
as $fn$
  select coalesce(to_char(private.reminder_at(a_starts, a_tz, a_mode, a_qs, a_qe, a_now) at time zone 'UTC',
                          'YYYY-MM-DD HH24:MI:SS"Z"'), '<null>');
$fn$;

select is(pg_temp.ra('2026-10-25 08:00Z', '24h', '2026-10-01 00:00Z'), '2026-10-24 07:00:00Z',
  'reminder_at #1: Sun 25/10 10:00 EET → Sat 10:00 EEST (25 h earlier across the change)');
select is(pg_temp.ra('2026-10-26 07:30Z', '24h', '2026-10-01 00:00Z'), '2026-10-25 07:30:00Z',
  'reminder_at #2: Mon 26/10 09:30 → Sun 09:30 EET (the day after the change, 24 h)');
select is(pg_temp.ra('2026-10-25 06:30Z', '24h', '2026-10-01 00:00Z'), '2026-10-23 18:00:00Z',
  'reminder_at #3: Sun 08:30 → base Sat 08:30 is quiet → Fri 21:00 EEST (the night it falls in began Friday)');
select is(pg_temp.ra('2026-10-25 21:30Z', '24h', '2026-10-01 00:00Z'), '2026-10-24 18:00:00Z',
  'reminder_at #4: Sun 23:30 → base Sat 23:30 is quiet → Sat 21:00 EEST');
select is(pg_temp.ra('2026-10-26 06:00Z', '24h', '2026-10-01 00:00Z'), '2026-10-24 18:00:00Z',
  'reminder_at #5: Mon 08:00 → base Sun 08:00 (quiet, the DST night) → Sat 21:00 EEST');
select is(pg_temp.ra('2026-10-26 21:00Z', '24h', '2026-10-01 00:00Z'), '2026-10-25 19:00:00Z',
  'reminder_at #6: Mon 23:00 → base Sun 23:00 is quiet → Sun 21:00 EET');
select is(pg_temp.ra('2026-10-25 08:00Z', 'evening_before', '2026-10-01 00:00Z'), '2026-10-24 15:00:00Z',
  'reminder_at #7a (evening_before): Sun 10:00 EET → Sat 18:00 EEST');
select is(pg_temp.ra('2026-10-26 08:00Z', 'evening_before', '2026-10-01 00:00Z'), '2026-10-25 16:00:00Z',
  'reminder_at #7b (evening_before): Mon 10:00 → Sun 18:00 EET');
select is(pg_temp.ra('2026-03-29 07:00Z', '24h', '2026-03-01 00:00Z'), '2026-03-28 08:00:00Z',
  'reminder_at #8: Sun 29/03 10:00 EEST → Sat 10:00 EET (23 h earlier across the spring change)');
select is(pg_temp.ra('2026-11-01 15:00Z', '24h', '2026-10-01 00:00Z', 'America/New_York'), '2026-10-31 14:00:00Z',
  'reminder_at #9 (America/New_York): Sun 01/11 10:00 EST → Sat 10:00 EDT (a second zone)');
select is(pg_temp.ra('2026-10-27 04:00Z', '24h', '2026-10-01 00:00Z', 'Europe/Athens', '00:00', '07:00'), '2026-10-25 21:00:00Z',
  'reminder_at #10 (quiet 00:00–07:00): Tue 06:00 → base Mon 06:00 is quiet → Sun 23:00 EET');

select is(pg_temp.ra('2026-11-12 21:00Z', '24h', '2026-11-01 00:00Z'), '2026-11-11 19:00:00Z',
  'reminder_at, SPEC §12 example: a reminder at 23:00 goes to 21:00 the same day');
select is(pg_temp.ra('2026-11-12 06:00Z', '24h', '2026-11-01 00:00Z'), '2026-11-10 19:00:00Z',
  'reminder_at, SPEC §12 example: a reminder at 08:00 goes to 21:00 the day before');

select is(
  concat_ws(' ',
    pg_temp.ra('2026-11-12 07:00Z', '24h', '2026-11-01 00:00Z'),
    pg_temp.ra('2026-11-12 20:00Z', '24h', '2026-11-01 00:00Z'),
    pg_temp.ra('2026-11-12 19:59Z', '24h', '2026-11-01 00:00Z')),
  '2026-11-11 07:00:00Z 2026-11-11 19:00:00Z 2026-11-11 19:59:00Z',
  'reminder_at: 09:00 (quiet_end) is not quiet, 22:00 (quiet_start) is (→ 21:00), 21:59 stays'
);

select is(
  concat_ws(' ',
    pg_temp.ra('2026-11-12 10:00Z', '24h', '2026-11-11 08:01Z'),
    pg_temp.ra('2026-11-12 10:00Z', '24h', '2026-11-11 08:00Z')),
  '<null> 2026-11-11 10:00:00Z',
  'reminder_at: booked 25 h 59 m before the start → no reminder; booked exactly 26 h before → one'
);

select is(
  concat_ws(' ',
    pg_temp.ra('2026-10-25 06:30Z', '24h', '2026-10-23 16:00Z'),
    pg_temp.ra('2026-10-25 06:30Z', '24h', '2026-10-23 16:00:01Z')),
  '2026-10-23 18:00:00Z <null>',
  'reminder_at: a (shifted) reminder exactly 2 h after planning is kept, one second less is dropped (D3), never moved later'
);

select is(
  pg_temp.ra('2026-10-25 08:00Z', 'evening_before', '2026-10-24 07:00:01Z'),
  '<null>',
  'reminder_at (evening_before): booked less than 26 h before the start → no reminder either'
);

-- The 26 h rule on its own: with a 24 h lead the + 2 h rule (D3) alone already drops a booking made
-- 25 h 59 m before, so these use leads other than 24 h, where the reminder would be ≥ 2 h away.
select is(
  concat_ws(' ',
    pg_temp.ra('2026-03-29 07:00Z', '24h', '2026-03-28 05:01Z'),
    pg_temp.ra('2026-03-29 07:00Z', '24h', '2026-03-28 05:00Z'),
    pg_temp.ra('2026-10-25 08:00Z', 'evening_before', '2026-10-24 06:01Z'),
    pg_temp.ra('2026-10-25 08:00Z', 'evening_before', '2026-10-24 06:00Z')),
  '<null> 2026-03-28 08:00:00Z <null> 2026-10-24 15:00:00Z',
  'reminder_at: booked 25 h 59 m before → none even when the reminder would be 3 h (23 h lead, #8) or 9 h '
  || '(evening_before, #7a) away; exactly 26 h before → one (SPEC §12 «≥ 26ω»)'
);

select is(
  concat_ws(' ',
    private.in_quiet_hours('2026-11-11 20:00Z', 'Europe/Athens', '22:00', '09:00'),
    private.in_quiet_hours('2026-11-11 19:59Z', 'Europe/Athens', '22:00', '09:00'),
    private.in_quiet_hours('2026-11-12 07:00Z', 'Europe/Athens', '22:00', '09:00'),
    private.in_quiet_hours('2026-11-12 06:59Z', 'Europe/Athens', '22:00', '09:00'),
    private.in_quiet_hours('2026-11-11 11:00Z', 'Europe/Athens', '13:00', '15:00'),
    private.in_quiet_hours('2026-11-11 13:00Z', 'Europe/Athens', '13:00', '15:00')),
  't f f t t f',
  'in_quiet_hours: [quiet_start, quiet_end) in local time, across midnight or within one day'
);

select is(
  concat_ws(' ',
    to_char(private.message_deadline('reminder', '2004-01-01 10:00Z', '2004-01-02 10:00Z') at time zone 'UTC', 'HH24:MI'),
    to_char(private.message_deadline('reminder', '2004-01-01 10:00Z', '2004-01-01 10:30Z') at time zone 'UTC', 'HH24:MI'),
    to_char(private.message_deadline('push_booking_created', '2004-01-01 10:00Z', '2004-01-01 10:30Z') at time zone 'UTC', 'HH24:MI'),
    to_char(private.message_deadline('push_booking_moved', '2004-01-01 10:00Z', null) at time zone 'UTC', 'HH24:MI'),
    to_char(private.message_deadline('push_booking_cancelled', '2004-01-01 10:00Z', null) at time zone 'UTC', 'HH24:MI'),
    to_char(private.message_deadline('push_test', '2004-01-01 10:00Z', null) at time zone 'UTC', 'HH24:MI'),
    coalesce(private.message_deadline('booking_confirmed', '2004-01-01 10:00Z', '2004-01-02 10:00Z')::text, 'none'),
    coalesce(private.message_deadline('cancelled_by_business', '2004-01-01 10:00Z', '2004-01-02 10:00Z')::text, 'none'),
    coalesce(private.message_deadline('otp', '2004-01-01 10:00Z', null)::text, 'none')),
  '11:00 10:30 11:00 11:00 11:00 10:10 none none none',
  'message_deadline (D21): reminder 60′ or the start, push 60′, test push 10′, none for confirmations, notices and OTP'
);

-- ---------------------------------------------------------------------------------------------
-- B. Planner v2, 'created' (§2.7), relative to now(). D = today's local date in Athens.
--    A1 online C1/SM1 at now() + 25 h · A2 online C1/SM1 D+3 12:00 · A3 online C2/SM1 D+3 15:00
--    (evening_before) · A4 C1/SM2 D+3 08:00 · A5 C2/SM2 D+3 23:00 · A6 C1/SM3 D+3 22:30 (quiet
--    23:00–08:00) · AN1 online CN1/SN0 D+3 12:00 New York.
-- ---------------------------------------------------------------------------------------------
create function pg_temp.pr(a_business uuid, a_staff uuid[], a_exclude uuid)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(pg_temp.l(u), ',' order by pg_temp.l(u)), '-')
  from private.push_recipients(a_business, a_staff, a_exclude) as u;
$fn$;

select pg_temp.mk('A1', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM1'), now() + interval '25 hours', 'online');
select pg_temp.mk('A2', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM1'), pg_temp.lt(3, '12:00'), 'online');

select is(
  concat_ws(' ', pg_temp.plan(pg_temp.id('A1'), 'created', 'client'), pg_temp.plan(pg_temp.id('A2'), 'created', 'client')),
  'ok ok',
  'planner: two online bookings are planned (actor client)'
);

select is(
  pg_temp.sms('A1'),
  'booking_confirmed:queued',
  'planner: an online booking made 25 h before its start gets its confirmation but no reminder (< 26 h)'
);

select is(
  (select concat_ws(' ', count(*),
            bool_and(m.scheduled_for = private.reminder_at(a.starts_at, 'Europe/Athens', '24h', '22:00', '09:00', now())),
            bool_and(m.scheduled_for = pg_temp.prev_day(a.starts_at)),
            bool_and(m.dedupe_key = 'appt:' || a.id::text || ':reminder:' || extract(epoch from a.starts_at)::bigint::text),
            string_agg(concat_ws(' ', m.category, m.status, m.to_e164, m.locale, pg_temp.l(m.client_id)), ','))
   from public.messages_log m join public.appointments a on a.id = m.appointment_id
   where a.id = pg_temp.id('A2') and m.template = 'reminder'),
  '1 t t t reminder queued +306912300001 el C1',
  'planner: a booking 3 days ahead gets exactly one reminder at reminder_at(…, now()) = the same local time the day before, key appt:<id>:reminder:<epoch>'
);

select is(
  (select concat_ws(' ', count(*), bool_and(m.dedupe_key = 'appt:' || m.appointment_id::text || ':booking_confirmed'),
            string_agg(concat_ws(' ', m.category, m.status, m.to_e164, m.locale, pg_temp.l(m.client_id)), ','),
            bool_and(m.scheduled_for = now()))
   from public.messages_log m
   where m.appointment_id = pg_temp.id('A2') and m.template = 'booking_confirmed'),
  '1 t transactional queued +306912300001 el C1 t',
  'planner: the online confirmation is queued for now, to the client''s phone and language (appt:<id>:booking_confirmed)'
);

select is(
  pg_temp.push('A2', 'push_booking_created'),
  'UM0,UM1,UM9,UMP',
  'planner: push for a new online booking goes to the staff member''s user, every owner and a manager with push_all '
  || '(not to the default manager, not to members without a device)'
);

select is(
  (select concat_ws(' ', count(*), count(*) filter (
            where m.to_e164 is null and m.client_id is null and m.locale = 'el' and m.category = 'transactional'
              and m.status = 'queued' and m.scheduled_for = now()
              and m.dedupe_key = 'appt:' || m.appointment_id::text || ':push_booking_created:' || m.recipient_user_id::text))
   from public.messages_log m
   where m.appointment_id = pg_temp.id('A2') and m.channel = 'push'),
  '4 4',
  'planner: push rows carry no phone and no client, the business language, now, and the key appt:<id>:push_booking_created:<user>'
);

select set_config('t.b7', (select md5(string_agg(to_jsonb(m)::text, ',' order by m.id))
                           from public.messages_log m where m.appointment_id = pg_temp.id('A2')), true);
select pg_temp.quiet(set_config('t.b7p', pg_temp.plan(pg_temp.id('A2'), 'created', 'client'), true));

select is(
  current_setting('t.b7p') || ' ' || ((select md5(string_agg(to_jsonb(m)::text, ',' order by m.id))
                                      from public.messages_log m where m.appointment_id = pg_temp.id('A2'))
                                     = current_setting('t.b7'))::text,
  'ok true',
  'planner: planning the same booking again changes nothing (one row per appointment/template/time)'
);

update public.businesses set reminder_mode = 'evening_before' where id = 'e1100000-0000-4000-8000-00000000000a';
select pg_temp.mk('A3', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C2'), pg_temp.id('SM1'), pg_temp.lt(3, '15:00'), 'online');
select pg_temp.quiet(set_config('t.p3', pg_temp.plan(pg_temp.id('A3'), 'created', 'client'), true));

-- Asserted before the mode is switched back: since 0008 (1.6 D6) that switch re-plans the queued
-- reminders of the business (13_schedule_ops covers the re-plan itself).
select is(
  (select concat_ws(' ', current_setting('t.p3'), count(*), bool_and(m.scheduled_for = pg_temp.local_at(a.starts_at, 1, '18:00')),
            string_agg(m.locale, ','))
   from public.messages_log m join public.appointments a on a.id = m.appointment_id
   where a.id = pg_temp.id('A3') and m.template = 'reminder'),
  'ok 1 t en',
  'planner (evening_before): the reminder is at 18:00 local the day before, in the client''s language'
);

update public.businesses set reminder_mode = '24h' where id = 'e1100000-0000-4000-8000-00000000000a';

select pg_temp.mk('A4', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM2'), pg_temp.lt(3, '08:00'), 'online');
select pg_temp.mk('A5', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C2'), pg_temp.id('SM2'), pg_temp.lt(3, '23:00'), 'online');
select pg_temp.quiet(set_config('t.p45', concat_ws(' ', pg_temp.plan(pg_temp.id('A4'), 'created', 'client'),
                                                   pg_temp.plan(pg_temp.id('A5'), 'created', 'client')), true));

select is(
  concat_ws(' ', current_setting('t.p45'),
    (select m.scheduled_for = pg_temp.local_at(a.starts_at, 2, '21:00')
     from public.messages_log m join public.appointments a on a.id = m.appointment_id
     where a.id = pg_temp.id('A4') and m.template = 'reminder'),
    (select m.scheduled_for = pg_temp.local_at(a.starts_at, 1, '21:00')
     from public.messages_log m join public.appointments a on a.id = m.appointment_id
     where a.id = pg_temp.id('A5') and m.template = 'reminder')),
  'ok ok t t',
  'planner (quiet hours): 08:00 → 21:00 two local days before (the night the base falls in), 23:00 → 21:00 the day before'
);

select set_config('t.a4rem', (select m.scheduled_for::text from public.messages_log m
                              where m.appointment_id = pg_temp.id('A4') and m.template = 'reminder'), true);
update public.businesses set quiet_start = '23:00', quiet_end = '08:00' where id = 'e1100000-0000-4000-8000-00000000000a';
select pg_temp.mk('A6', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM3'), pg_temp.lt(3, '22:30'), 'online');
select pg_temp.quiet(set_config('t.p6', pg_temp.plan(pg_temp.id('A6'), 'created', 'client'), true));

-- 1.5 D8 («a queued reminder keeps its time») was replaced by 1.6 D6 (0008): a change of the quiet
-- hours re-plans the queued reminders, so A4's moves from 21:00 two days before (old quiet hours)
-- to 08:00 the day before (08:00 = the new quiet_end, not quiet). Asserted before the switch back.
select is(
  concat_ws(' ', current_setting('t.p6'),
    (select m.scheduled_for = pg_temp.prev_day(a.starts_at)
     from public.messages_log m join public.appointments a on a.id = m.appointment_id
     where a.id = pg_temp.id('A6') and m.template = 'reminder'),
    (select m.scheduled_for = pg_temp.local_at(a.starts_at, 1, '08:00')
            and m.scheduled_for <> current_setting('t.a4rem')::timestamptz
     from public.messages_log m join public.appointments a on a.id = m.appointment_id
     where a.id = pg_temp.id('A4') and m.template = 'reminder')),
  'ok t t',
  'planner: the business''s own quiet hours (23:00–08:00) are used (22:30 stays); a queued reminder follows the new quiet hours (1.6 D6, replaces 1.5 D8)'
);

update public.businesses set quiet_start = '22:00', quiet_end = '09:00' where id = 'e1100000-0000-4000-8000-00000000000a';

select is(
  pg_temp.push('A4', 'push_booking_created') || ' | ' || pg_temp.push('A6', 'push_booking_created'),
  'UM0,UM9,UMP | UM0,UM9,UMP',
  'planner: no push for a staff member without a device (SM2) or with push_own = false (SM3); owners still get it'
);

select pg_temp.mk('AN1', 'e1100000-0000-4000-8000-00000000000b', pg_temp.id('CN1'), pg_temp.id('SN0'),
                  pg_temp.lt(3, '12:00', 'America/New_York'), 'online');
select pg_temp.quiet(set_config('t.pn1', pg_temp.plan(pg_temp.id('AN1'), 'created', 'client'), true));

select is(
  concat_ws(' ', current_setting('t.pn1'),
    (select m.scheduled_for = pg_temp.prev_day(a.starts_at, 'America/New_York')
     from public.messages_log m join public.appointments a on a.id = m.appointment_id
     where a.id = pg_temp.id('AN1') and m.template = 'reminder'),
    (select m.locale from public.messages_log m where m.appointment_id = pg_temp.id('AN1') and m.template = 'booking_confirmed'),
    pg_temp.push('AN1', 'push_booking_created'),
    (select string_agg(m.locale, ',') from public.messages_log m where m.appointment_id = pg_temp.id('AN1') and m.channel = 'push')),
  'ok t en UN0 en',
  'planner (America/New_York): reminder at the same New York time the day before; push only to that business''s owner, in its language'
);

select is(
  concat_ws(' | ',
    pg_temp.pr('e1100000-0000-4000-8000-00000000000a', array[pg_temp.id('SM1')], null),
    pg_temp.pr('e1100000-0000-4000-8000-00000000000a', array[pg_temp.id('SM1')], pg_temp.id('UM0')),
    pg_temp.pr('e1100000-0000-4000-8000-00000000000a', array[pg_temp.id('SM3')], null),
    pg_temp.pr('e1100000-0000-4000-8000-00000000000a', array[pg_temp.id('SN0')], null),
    pg_temp.pr('e1100000-0000-4000-8000-00000000000b', array[pg_temp.id('SN0')], null)),
  'UM0,UM1,UM9,UMP | UM1,UM9,UMP | UM0,UM9,UMP | UM0,UM9,UMP | UN0',
  'push_recipients: from business_members and member_notification_prefs only; the acting user is excluded; '
  || 'a foreign staff id adds nobody; never a member of another business'
);

select is(
  pg_temp.plan(pg_temp.id('A1'), 'rescheduled', 'system'),
  '22023',
  'planner: an unknown p_change is refused (22023)'
);

-- ---------------------------------------------------------------------------------------------
-- C. A move re-plans, a cancel cancels, a status change supersedes (§2.7 steps 1 and 3)
--    Staff steps go through the 1.4 RPCs as authenticated members (no declared actor → staff).
-- ---------------------------------------------------------------------------------------------
-- Labels a row (nothing when the id is null, so a failed step shows up as a failed assertion).
create function pg_temp.lab(a_label text, a_id uuid)
returns uuid
language sql
as $fn$
  insert into pg_temp.lbl (id, label) select a_id, a_label where a_id is not null returning id;
$fn$;

create function pg_temp.biz(a_label text)
returns uuid
language sql
stable
as $fn$
  select a.business_id from public.appointments a where a.id = pg_temp.id(a_label);
$fn$;

create function pg_temp.q_move(a_label text, a_starts timestamptz, a_notify boolean, a_staff uuid default null)
returns text
language sql
as $fn$
  select format(
    'select public.staff_move_appointment(p_business_id => %L, p_appointment_id => %L, p_idempotency_key => %L, '
    || 'p_new_starts_at => %L, p_notify => %L, p_new_staff_id => %L, p_allow_outside_hours => true, '
    || 'p_allow_buffer_overlap => true)::text',
    pg_temp.biz(a_label), pg_temp.id(a_label), gen_random_uuid(), a_starts, a_notify, a_staff);
$fn$;

create function pg_temp.q_cancel(a_label text, a_from text, a_reason text, a_notify boolean)
returns text
language sql
as $fn$
  select format(
    'select public.cancel_appointment(p_business_id => %L, p_appointment_id => %L, p_from_status => %L, '
    || 'p_reason => %L, p_notify => %L)::text',
    pg_temp.biz(a_label), pg_temp.id(a_label), a_from, a_reason, a_notify);
$fn$;

create function pg_temp.q_status(a_label text, a_from text, a_status text)
returns text
language sql
as $fn$
  select format(
    'select public.set_appointment_status(p_business_id => %L, p_appointment_id => %L, p_from_status => %L, '
    || 'p_status => %L)::text',
    pg_temp.biz(a_label), pg_temp.id(a_label), a_from, a_status);
$fn$;

-- staff_book_appointment in M with the Cut service (off-grid starts allowed for staff).
create function pg_temp.q_book(a_staff text, a_starts timestamptz, a_client text, a_source text)
returns text
language sql
as $fn$
  select format(
    'select public.staff_book_appointment(p_business_id => %L, p_service_ids => array[%L]::uuid[], p_staff_id => %L, '
    || 'p_starts_at => %L, p_client_id => %L, p_source => %L, p_idempotency_key => %L, '
    || 'p_allow_outside_hours => true, p_allow_buffer_overlap => true)::text',
    'e1100000-0000-4000-8000-00000000000a', 'e1400000-0000-4000-8000-0000000000a1', pg_temp.id(a_staff),
    a_starts, pg_temp.id(a_client), a_source, gen_random_uuid());
$fn$;

-- Labels the appointment a stored booking answer created.
create function pg_temp.lab_booked(a_label text, a_name text)
returns uuid
language sql
as $fn$
  select pg_temp.lab(a_label, (pg_temp.r(a_name) ->> 'appointment_id')::uuid);
$fn$;

-- The client moves through the manage link (move_core in public mode declares 'client').
create function pg_temp.cmove(a_label text, a_starts timestamptz)
returns text
language plpgsql
as $fn$
declare
  v text := 'ok';
begin
  begin
    perform private.move_core(pg_temp.biz(a_label), pg_temp.id(a_label), a_starts, null, 'public', false, false, now());
  exception when others then
    v := pg_temp.err(sqlstate, sqlerrm);
  end;
  perform set_config('anaklo.actor_type', 'system', true);
  return v;
end;
$fn$;

-- The client cancels through the manage link (as manage_cancel does: actor client, then the planner).
create function pg_temp.ccancel(a_label text)
returns text
language plpgsql
as $fn$
declare
  v text := 'ok';
begin
  begin
    perform set_config('anaklo.actor_type', 'client', true);
    update public.appointments a
    set status = 'cancelled', cancelled_by = 'client', cancel_reason = 'client_request'
    where a.id = pg_temp.id(a_label);
    perform private.plan_messages_impl(pg_temp.id(a_label), 'cancelled');
  exception when others then
    v := pg_temp.err(sqlstate, sqlerrm);
  end;
  perform set_config('anaklo.actor_type', 'system', true);
  return v;
end;
$fn$;


-- A7 online C1/SM1 D+4 12:00: the owner moves it to D+5 12:00 without notify, back again, then cancels.
select pg_temp.mk('A7', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM1'), pg_temp.lt(4, '12:00'), 'online');
select pg_temp.must_ok(pg_temp.plan(pg_temp.id('A7'), 'created', 'client'));
select pg_temp.lab('A7.rem1', pg_temp.rem_now('A7'));
select pg_temp.lab('A7.conf', pg_temp.one('A7', 'booking_confirmed'));

select is(
  pg_temp.call('mv7a', pg_temp.id('UM0'), pg_temp.q_move('A7', pg_temp.lt(5, '12:00'), false)),
  'ok',
  'move: the owner moves an online booking one day later without notifying the client'
);

select is(
  pg_temp.sms('A7'),
  'booking_confirmed:cancelled:superseded reminder:cancelled:superseded reminder:queued',
  'move without notify: every queued SMS is superseded (the still-queued confirmation too, D7) and a new reminder is queued'
);

select is(
  concat_ws(' ',
    pg_temp.rem_now('A7') <> pg_temp.id('A7.rem1'),
    (select m.scheduled_for = pg_temp.prev_day(a.starts_at) from public.messages_log m
     join public.appointments a on a.id = m.appointment_id where m.id = pg_temp.rem_now('A7')),
    pg_temp.r('mv7a') ->> 'notify', pg_temp.r('mv7a') ->> 'sms_queued',
    (select count(*) from public.messages_log m where m.appointment_id = pg_temp.id('A7') and m.template like 'rescheduled%')),
  't t false false 0',
  'move without notify: the new reminder (new key) is at the new time; no notice to the client; sms_queued false'
);

select is(
  pg_temp.push('A7', 'push_booking_moved'),
  'UM1,UM9,UMP',
  'move: push to the staff member''s user and the owners, never to the owner who moved it'
);

select is(
  pg_temp.call('mv7b', pg_temp.id('UM0'), pg_temp.q_move('A7', pg_temp.lt(4, '12:00'), false)),
  'ok',
  'move: the owner moves it back to the first time'
);

select is(
  concat_ws(' ',
    pg_temp.rem_now('A7') = pg_temp.id('A7.rem1'), pg_temp.st('A7.rem1'),
    (select m.scheduled_for = pg_temp.prev_day(pg_temp.lt(4, '12:00')) from public.messages_log m
     where m.id = pg_temp.id('A7.rem1')),
    pg_temp.rems('A7'), pg_temp.st('A7.conf')),
  't queued t queued cancelled:superseded cancelled:superseded',
  'move back: the first (never sent) reminder is revived (same id, queued), the second superseded; the confirmation stays superseded'
);

select is(
  pg_temp.call('ca7', pg_temp.id('UM0'), pg_temp.q_cancel('A7', 'booked', 'other', false)),
  'ok',
  'cancel: the owner cancels without notify'
);

select is(
  concat_ws(' ', pg_temp.rems('A7'),
    (select count(*) from public.messages_log m where m.appointment_id = pg_temp.id('A7') and m.template like 'cancelled%'),
    pg_temp.r('ca7') ->> 'sms_queued', pg_temp.push('A7', 'push_booking_cancelled')),
  'cancelled:superseded cancelled:superseded 0 false UM1,UM9,UMP',
  'cancel without notify: the reminder is superseded, no notice, sms_queued false, push to staff and owners'
);

-- A8 online C2/SM1 D+6 12:00: the client moves it through the link to D+7 12:00.
select pg_temp.mk('A8', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C2'), pg_temp.id('SM1'), pg_temp.lt(6, '12:00'), 'online');
select pg_temp.must_ok(pg_temp.plan(pg_temp.id('A8'), 'created', 'client'));
select set_config('anaklo.dispatch_nudged', '', true);
select set_config('t.n8', pg_temp.nudges()::text, true);

select is(
  pg_temp.cmove('A8', pg_temp.lt(7, '12:00')),
  'ok',
  'client move: the client moves an online booking through the manage link (move_core, public)'
);

select is(
  concat_ws(' ', pg_temp.sms('A8'),
    (select m.dedupe_key = 'appt:' || m.appointment_id::text || ':rescheduled_by_client:'
                          || (select max(e.id) from public.appointment_events e where e.appointment_id = m.appointment_id)::text
     from public.messages_log m where m.appointment_id = pg_temp.id('A8') and m.template = 'rescheduled_by_client')),
  'booking_confirmed:cancelled:superseded reminder:cancelled:superseded reminder:queued rescheduled_by_client:queued t',
  'client move: queued SMS superseded, reminder re-planned, one rescheduled_by_client keyed appt:<id>:rescheduled_by_client:<event id>'
);

select is(
  concat_ws(' ', pg_temp.push('A8', 'push_booking_moved'),
    (select count(*) from public.messages_log m
     where m.appointment_id = pg_temp.id('A8') and m.template = 'push_booking_moved'
       and m.dedupe_key = 'appt:' || m.appointment_id::text || ':push_booking_moved:'
                          || (select max(e.id) from public.appointment_events e where e.appointment_id = m.appointment_id)::text
                          || ':' || m.recipient_user_id::text),
    pg_temp.nudges()::text = current_setting('t.n8')),
  'UM0,UM1,UM9,UMP 4 t',
  'client move: push to staff and every owner (nobody excluded), key appt:<id>:push_booking_moved:<event id>:<user>; '
  || 'no nudge (the Edge Function sends client flows itself)'
);

select set_config('t.c12', (select count(*)::text from public.messages_log m where m.appointment_id = pg_temp.id('A8')), true);
select pg_temp.quiet(set_config('t.c12p', pg_temp.plan(pg_temp.id('A8'), 'moved', 'client'), true));

select is(
  current_setting('t.c12p') || ' '
  || ((select count(*)::text from public.messages_log m where m.appointment_id = pg_temp.id('A8')) = current_setting('t.c12'))::text
  || ' ' || pg_temp.sms('A8'),
  'ok true booking_confirmed:cancelled:superseded reminder:cancelled:superseded reminder:queued rescheduled_by_client:queued',
  'client move: planning the same move again adds nothing and changes nothing (keys carry the event id; the notice of '
  || 'this move stays queued)'
);

-- A9 phone C1/SM2 in progress with a queued confirmation and a queued push; A10 online D+8;
-- A11 phone C1/SM3 started 1 h ago with a queued confirmation.
select pg_temp.mk('A9', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM2'), now() - interval '10 minutes', 'phone');
select pg_temp.msg('A9.conf', 'e1100000-0000-4000-8000-00000000000a', 'booking_confirmed', pg_temp.id('A9'), pg_temp.id('C1'),
                   '+306912300001', null, now());
select pg_temp.msg('A9.push', 'e1100000-0000-4000-8000-00000000000a', 'push_booking_created', pg_temp.id('A9'), null,
                   null, pg_temp.id('UM0'), now());
select pg_temp.mk('A10', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C2'), pg_temp.id('SM3'), pg_temp.lt(8, '12:00'), 'online');
select pg_temp.must_ok(pg_temp.plan(pg_temp.id('A10'), 'created', 'client'));
select pg_temp.mk('A11', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM3'), now() - interval '1 hour', 'phone');
select pg_temp.msg('A11.conf', 'e1100000-0000-4000-8000-00000000000a', 'booking_confirmed', pg_temp.id('A11'), pg_temp.id('C1'),
                   '+306912300001', null, now());

select is(
  pg_temp.call('st9', pg_temp.id('UM2'), pg_temp.q_status('A9', 'booked', 'completed')),
  'ok',
  'status: the staff member completes their appointment in progress'
);

select is(
  pg_temp.st('A9.conf', 'A9.push'),
  'cancelled:superseded queued',
  'status_changed to completed: the queued SMS is superseded, a push row is never superseded'
);

select is(
  pg_temp.call('st10', pg_temp.id('UM0'), pg_temp.q_status('A10', 'booked', 'confirmed')),
  'ok',
  'status: the owner confirms a future appointment'
);

select is(
  pg_temp.rems('A10'),
  'queued',
  'status_changed to confirmed: the reminder stays queued (still active)'
);

select is(
  pg_temp.call('st11', pg_temp.id('UM0'), pg_temp.q_status('A11', 'booked', 'no_show')),
  'ok',
  'status: the owner marks an appointment that started an hour ago as no-show'
);

select is(
  pg_temp.st('A11.conf'),
  'cancelled:superseded',
  'status_changed to no_show: the queued SMS is superseded'
);

select is(
  pg_temp.call('ca11', pg_temp.id('UM0'), pg_temp.q_cancel('A11', 'no_show', 'other', true)),
  'ok',
  'cancel: the owner corrects the no-show into cancelled (asking to notify)'
);

select is(
  concat_ws(' ', pg_temp.push('A11', 'push_booking_cancelled'), pg_temp.sms('A11'), pg_temp.r('ca11') ->> 'notify'),
  '- booking_confirmed:cancelled:superseded false',
  'cancel of a past, inactive appointment (a correction): no notice and no push'
);

-- ---------------------------------------------------------------------------------------------
-- D. Notify → exactly one rescheduled_by_business / cancelled_by_business (§2.7, D6), reassign
-- ---------------------------------------------------------------------------------------------
select is(
  pg_temp.call('bk12', pg_temp.id('UM1'), pg_temp.q_book('SM1', pg_temp.lt(9, '12:00'), 'C1', 'phone')),
  'ok',
  'staff booking: a staff member books a phone appointment 9 days ahead'
);
select pg_temp.lab_booked('A12', 'bk12');

select is(
  concat_ws(' ', pg_temp.sms('A12'),
    (select count(*) from public.messages_log m where m.appointment_id = pg_temp.id('A12') and m.channel = 'push'),
    array_to_string(pg_temp.keys(pg_temp.r('bk12')), ',')),
  'booking_confirmed:queued reminder:queued 0 appointment_id,ends_at,replayed,staff_id,starts_at,total_cents,warnings',
  'staff phone booking ≥ 2 h ahead: confirmation and reminder, no push (booked in the app); the answer is unchanged (D28)'
);

select is(
  pg_temp.call('mv12', pg_temp.id('UM1'), pg_temp.q_move('A12', pg_temp.lt(9, '14:00'), true)),
  'ok',
  'move: the staff member moves their appointment and asks to notify the client'
);

select is(
  (select concat_ws(' ', pg_temp.r('mv12') ->> 'notify', pg_temp.r('mv12') ->> 'sms_queued', count(*),
            bool_and(m.dedupe_key = 'appt:' || m.appointment_id::text || ':rescheduled_by_business:'
                     || (select max(e.id) from public.appointment_events e where e.appointment_id = m.appointment_id)::text),
            string_agg(concat_ws(' ', m.status, m.to_e164, m.locale), ','), bool_and(m.scheduled_for = now()))
   from public.messages_log m
   where m.appointment_id = pg_temp.id('A12') and m.template = 'rescheduled_by_business'),
  'true true 1 t queued +306912300001 el t',
  'move with notify: exactly one rescheduled_by_business, key appt:<id>:rescheduled_by_business:<event id>, due now; sms_queued true'
);

select is(
  pg_temp.push('A12', 'push_booking_moved'),
  'UM0,UM9,UMP',
  'move with notify: push to the owners, not to the staff member who moved it'
);

select is(
  pg_temp.call('mv12b', pg_temp.id('UM1'), pg_temp.q_move('A12', pg_temp.lt(9, '16:00'), false)),
  'ok',
  'move: the same appointment is moved again, without notify'
);

select is(
  concat_ws(' ',
    (select count(*) from public.messages_log m where m.appointment_id = pg_temp.id('A12') and m.template = 'rescheduled_by_business'),
    pg_temp.r('mv12b') ->> 'sms_queued', pg_temp.r('mv12b') ->> 'notify'),
  '1 false false',
  'move without notify: no second notice (still exactly one rescheduled_by_business), sms_queued false'
);

select is(
  concat_ws(' ',
    pg_temp.call('bk13', pg_temp.id('UM1'), pg_temp.q_book('SM1', pg_temp.lt(10, '12:00'), 'C2', 'phone')),
    pg_temp.call('bk14', pg_temp.id('UM1'), pg_temp.q_book('SM1', pg_temp.lt(10, '15:00'), 'C1', 'phone')),
    pg_temp.call('bk15', pg_temp.id('UM1'), pg_temp.q_book('SM1', pg_temp.lt(11, '12:00'), 'C2', 'phone'))),
  'ok ok ok',
  'staff booking: three more phone appointments'
);
select pg_temp.lab_booked('A13', 'bk13');
select pg_temp.lab_booked('A14', 'bk14');
select pg_temp.lab_booked('A15', 'bk15');

select is(
  concat_ws(' ',
    pg_temp.call('ca13', pg_temp.id('UM1'), pg_temp.q_cancel('A13', 'booked', 'other', true)),
    pg_temp.call('ca14', pg_temp.id('UM1'), pg_temp.q_cancel('A14', 'booked', 'client_request', true)),
    pg_temp.call('ca15', pg_temp.id('UM1'), pg_temp.q_cancel('A15', 'booked', 'shop_closed', false))),
  'ok ok ok',
  'cancel: the staff member cancels three of their appointments (notify / client phoned + notify / no notify)'
);

select is(
  concat_ws(' ',
    (select count(*) from public.messages_log m where m.appointment_id = pg_temp.id('A13') and m.template = 'cancelled_by_business'),
    (select bool_and(m.dedupe_key = 'appt:' || m.appointment_id::text || ':cancelled_by_business' and m.status = 'queued')
     from public.messages_log m where m.appointment_id = pg_temp.id('A13') and m.template = 'cancelled_by_business'),
    pg_temp.r('ca13') ->> 'sms_queued',
    (select count(*) from public.messages_log m where m.appointment_id = pg_temp.id('A13') and m.template = 'cancelled_by_client'),
    pg_temp.rems('A13')),
  '1 t true 0 cancelled:superseded',
  'cancel with notify: exactly one cancelled_by_business (appt:<id>:cancelled_by_business), sms_queued true, reminder superseded'
);

select is(
  concat_ws(' ',
    pg_temp.plan(pg_temp.id('A13'), 'cancelled', '', pg_temp.id('UM1'), 'true'),
    (select string_agg(m.template || ':' || m.status, ',' order by m.template)
     from public.messages_log m where m.appointment_id = pg_temp.id('A13') and m.channel = 'sms' and m.template like 'cancelled\_%')),
  'ok cancelled_by_business:queued',
  'cancel with notify: planning the same cancel again changes nothing (its notice stays queued, no second one)'
);

select is(
  concat_ws(' ',
    (select count(*) from public.messages_log m where m.appointment_id = pg_temp.id('A14') and m.template = 'cancelled_by_client'),
    (select count(*) from public.messages_log m where m.appointment_id = pg_temp.id('A14') and m.template = 'cancelled_by_business'),
    pg_temp.r('ca14') ->> 'sms_queued',
    (select m.to_e164 from public.messages_log m where m.appointment_id = pg_temp.id('A14') and m.template = 'cancelled_by_client')),
  '1 0 true +306912300001',
  'cancel with notify, reason client_request: exactly one cancelled_by_client instead (D6)'
);

select is(
  concat_ws(' ',
    (select count(*) from public.messages_log m where m.appointment_id = pg_temp.id('A15') and m.template like 'cancelled%'),
    pg_temp.r('ca15') ->> 'sms_queued', pg_temp.r('ca15') ->> 'notify'),
  '0 false false',
  'cancel without notify: no notice, sms_queued false'
);

select is(
  pg_temp.push('A13', 'push_booking_cancelled'),
  'UM0,UM9,UMP',
  'cancel: push to the owners, not to the staff member who cancelled'
);

-- Landline (D24): C3's Greek landline cannot receive SMS, so nothing is planned for it (no
-- confirmation, reminder or notice) and a move/cancel with notify answers sms_queued = false (the
-- sheet then says notify.notSent instead of promising an SMS). The staff pushes are unaffected.
select is(
  concat_ws(' ',
    pg_temp.call('bkl1', pg_temp.id('UM1'), pg_temp.q_book('SM1', pg_temp.lt(18, '12:00'), 'C3', 'phone')),
    pg_temp.call('bkl2', pg_temp.id('UM1'), pg_temp.q_book('SM1', pg_temp.lt(18, '15:00'), 'C3', 'phone'))),
  'ok ok',
  'staff booking: two phone appointments 18 days ahead for a client with a landline'
);
select pg_temp.lab_booked('AL1', 'bkl1');
select pg_temp.lab_booked('AL2', 'bkl2');

select is(
  concat_ws(' ', pg_temp.sms('AL1'), pg_temp.sms('AL2')),
  '- -',
  'landline: a phone booking ≥ 2 h ahead plans no confirmation and no reminder'
);

select pg_temp.quiet(set_config('t.l1', concat_ws(' ',
  pg_temp.call('mvl1', pg_temp.id('UM1'), pg_temp.q_move('AL1', pg_temp.lt(19, '12:00'), true)),
  pg_temp.call('cal2', pg_temp.id('UM1'), pg_temp.q_cancel('AL2', 'booked', 'other', true))), true));

select is(
  concat_ws(' ',
    current_setting('t.l1'),
    pg_temp.r('mvl1') ->> 'notify', pg_temp.r('mvl1') ->> 'sms_queued',
    pg_temp.r('cal2') ->> 'notify', pg_temp.r('cal2') ->> 'sms_queued',
    pg_temp.sms('AL1'), pg_temp.sms('AL2'),
    pg_temp.push('AL1', 'push_booking_moved'), pg_temp.push('AL2', 'push_booking_cancelled')),
  'ok ok true false true false - - UM0,UM9,UMP UM0,UM9,UMP',
  'landline: a move and a cancel with notify queue no SMS and answer sms_queued false; the owners still get their push'
);

select is(
  concat_ws(' ', private.sms_reachable('+306912300001'), private.sms_reachable('+302101234567'),
            private.sms_reachable('+12125550101'), private.sms_reachable('+447700900123'), private.sms_reachable(null)),
  't f t t f',
  'sms_reachable: Greek mobiles and non-Greek numbers can receive SMS; a Greek landline and no number cannot'
);

-- A16 online C1/SM1 D+11 15:00: the owner hands it to SM2 at the same time.
select pg_temp.mk('A16', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM1'), pg_temp.lt(11, '15:00'), 'online');
select pg_temp.must_ok(pg_temp.plan(pg_temp.id('A16'), 'created', 'client'));
select pg_temp.lab('A16.rem', pg_temp.rem_now('A16'));

select is(
  pg_temp.call('mv16', pg_temp.id('UM0'), pg_temp.q_move('A16', pg_temp.lt(11, '15:00'), false, pg_temp.id('SM2'))),
  'ok',
  'reassign: the owner gives the appointment to another staff member at the same time'
);

select is(
  concat_ws(' ', pg_temp.push('A16', 'push_booking_moved'),
    (select count(*) from public.messages_log m
     where m.appointment_id = pg_temp.id('A16') and m.template = 'push_booking_moved'
       and m.dedupe_key = 'appt:' || m.appointment_id::text || ':push_booking_moved:'
                          || (select max(e.id) from public.appointment_events e
                              where e.appointment_id = m.appointment_id and e.event = 'reassigned')::text
                          || ':' || m.recipient_user_id::text)),
  'UM1,UM9,UMP 3',
  'reassign: push also to the PREVIOUS staff member''s user (the new one has no device), keyed by the reassigned event'
);

select is(
  concat_ws(' ', pg_temp.rem_now('A16') = pg_temp.id('A16.rem'), pg_temp.rems('A16')),
  't queued',
  'reassign at the same start: the superseded reminder is revived (same key, same row), never duplicated'
);

-- AH1 phone C1/SM1, 21 h from now (a hand-over the day before): its reminder was planned when it
-- was booked days ago (written directly with the planner's key) and is due in 1 h.
select pg_temp.mk('AH1', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM1'),
                  date_trunc('hour', now()) + interval '21 hours', 'phone');
select pg_temp.msg('AH1.rem', 'e1100000-0000-4000-8000-00000000000a', 'reminder', pg_temp.id('AH1'), pg_temp.id('C1'),
                   '+306912300001', null, date_trunc('minute', now()) + interval '1 hour');
update public.messages_log m
set dedupe_key = 'appt:' || a.id::text || ':reminder:' || extract(epoch from a.starts_at)::bigint::text
from public.appointments a
where a.id = pg_temp.id('AH1') and m.id = pg_temp.id('AH1.rem');

select is(
  concat_ws(' ',
    pg_temp.call('mvh1', pg_temp.id('UM0'),
                 pg_temp.q_move('AH1', date_trunc('hour', now()) + interval '21 hours', false, pg_temp.id('SM2'))),
    pg_temp.rem_now('AH1') = pg_temp.id('AH1.rem'),
    pg_temp.rems('AH1'),
    (select m.scheduled_for = date_trunc('minute', now()) + interval '1 hour'
     from public.messages_log m where m.id = pg_temp.id('AH1.rem'))),
  'ok t queued t',
  'reassign at the same start < 26 h ahead: the queued reminder stays as planned (not superseded, not dropped)'
);

-- ---------------------------------------------------------------------------------------------
-- E. Walk-in: nothing. Phone/staff bookings: confirmation only if they start in ≥ 2 h (SPEC §12, D5).
-- ---------------------------------------------------------------------------------------------
select is(
  concat_ws(' ',
    pg_temp.call('bk17', pg_temp.id('UM1'), pg_temp.q_book('SM1', pg_temp.lt(12, '12:00'), 'C1', 'walkin')),
    pg_temp.call('bk18', pg_temp.id('UM1'), pg_temp.q_book('SM1', pg_temp.lt(12, '14:00'), null, 'walkin'))),
  'ok ok',
  'staff booking: a walk-in of a client with a phone, and an anonymous walk-in'
);
select pg_temp.lab_booked('A17', 'bk17');
select pg_temp.lab_booked('A18', 'bk18');

select is(
  concat_ws(' ',
    (select count(*) from public.messages_log m where m.appointment_id = pg_temp.id('A17')),
    (select count(*) from public.messages_log m where m.appointment_id = pg_temp.id('A18'))),
  '0 0',
  'walk-in: no message at all (no confirmation, no reminder, no push), even 12 days ahead with a phone'
);

select is(
  concat_ws(' ',
    pg_temp.call('bk19', pg_temp.id('UM1'), pg_temp.q_book('SM2', now() + interval '1 hour 59 minutes', 'C1', 'phone')),
    pg_temp.call('bk20', pg_temp.id('UM1'), pg_temp.q_book('SM3', now() + interval '2 hours', 'C2', 'phone')),
    pg_temp.call('bk21', pg_temp.id('UM1'), pg_temp.q_book('SM3', now() + interval '1 hour', 'C1', 'staff')),
    pg_temp.call('bk22', pg_temp.id('UM1'), pg_temp.q_book('SM0', now() + interval '3 hours', 'C2', 'staff'))),
  'ok ok ok ok',
  'staff booking: phone at +1 h 59 m and +2 h, in-shop (source staff) at +1 h and +3 h, for colleagues'
);
select pg_temp.lab_booked('A19', 'bk19');
select pg_temp.lab_booked('A20', 'bk20');
select pg_temp.lab_booked('A21', 'bk21');
select pg_temp.lab_booked('A22', 'bk22');

select is(
  concat_ws(' | ', pg_temp.sms('A19'), pg_temp.sms('A20'), pg_temp.sms('A21'), pg_temp.sms('A22'),
    (select count(*) from public.messages_log m
     where m.appointment_id in (pg_temp.id('A19'), pg_temp.id('A20'), pg_temp.id('A21'), pg_temp.id('A22'))
       and m.channel = 'push')),
  '- | booking_confirmed:queued | - | booking_confirmed:queued | 0',
  'phone < 2 h: no confirmation; exactly 2 h: one; source staff follows the same rule; no push for app bookings'
);

select is(
  concat_ws(' ',
    (select count(*) from public.messages_log m
     where m.channel = 'push' and m.business_id in ('e1100000-0000-4000-8000-00000000000a', 'e1100000-0000-4000-8000-00000000000b')
       and not exists (select 1 from public.business_members bm
                       where bm.business_id = m.business_id and bm.user_id = m.recipient_user_id)),
    (select count(*) from public.messages_log m
     where m.channel = 'push' and m.recipient_user_id in (pg_temp.id('UMM'), pg_temp.id('UM2'), pg_temp.id('UX')))),
  '0 0',
  'push recipients are always members of the business (server-derived), never the default manager, a member without a device or a non-member'
);

-- ---------------------------------------------------------------------------------------------
-- F. Imports (SPEC §12, §15, D4): a reminder only for future appointments and only with
--    import_reminders; never a confirmation, never a push. Written directly + planner 'created'
--    as the importer ('import'). A23 (past) is planned with import_reminders ON, so only its time excludes it.
-- ---------------------------------------------------------------------------------------------
select pg_temp.mk('A23', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM0'), now() - interval '2 days', 'import');
select pg_temp.mk('A24', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C2'), pg_temp.id('SM0'), pg_temp.lt(13, '12:00'), 'import');

select is(
  pg_temp.plan(pg_temp.id('A24'), 'created', 'import'),
  'ok',
  'import: a future imported appointment is planned while import_reminders is off'
);

select is(
  (select count(*) from public.messages_log m where m.appointment_id = pg_temp.id('A24')),
  0::bigint,
  'import: nothing for a future imported appointment while import_reminders is off'
);

update public.businesses set import_reminders = true where id = 'e1100000-0000-4000-8000-00000000000a';
select pg_temp.mk('A25', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM0'), pg_temp.lt(13, '15:00'), 'import');
select pg_temp.mk('A26', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C2'), pg_temp.id('SM0'), now() + interval '25 hours', 'import');

select is(
  concat_ws(' ', pg_temp.plan(pg_temp.id('A23'), 'created', 'import'), pg_temp.plan(pg_temp.id('A25'), 'created', 'import'),
            pg_temp.plan(pg_temp.id('A26'), 'created', 'import')),
  'ok ok ok',
  'import: a past and two future imported appointments are planned with import_reminders on'
);

select is(
  concat_ws(' | ',
    (select count(*) from public.messages_log m where m.appointment_id = pg_temp.id('A23')),
    concat_ws(' ', pg_temp.sms('A25'),
      (select m.scheduled_for = pg_temp.prev_day(a.starts_at) from public.messages_log m
       join public.appointments a on a.id = m.appointment_id where a.id = pg_temp.id('A25') and m.template = 'reminder'),
      (select count(*) from public.messages_log m where m.appointment_id = pg_temp.id('A25') and m.channel = 'push')),
    pg_temp.sms('A26')),
  '0 | reminder:queued t 0 | -',
  'import with import_reminders: never anything for a past appointment; exactly one reminder for a future one (never a '
  || 'confirmation or a push); none when the start is < 26 h away'
);

-- ---------------------------------------------------------------------------------------------
-- G. messaging_enabled = false: reminders are still planned (D9) and cancelled at claim;
--    OTP, confirmations and cancellations still go.
-- ---------------------------------------------------------------------------------------------
update public.businesses set messaging_enabled = false where id = 'e1100000-0000-4000-8000-00000000000a';
select pg_temp.mk('A27', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C2'), pg_temp.id('SM0'), pg_temp.lt(14, '12:00'), 'online');
select pg_temp.mk('A28', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM0'), pg_temp.lt(14, '15:00'), 'online');
select pg_temp.otp('O1', '+306912300009', now(), now() + interval '5 minutes');

select pg_temp.quiet(set_config('t.g1a', pg_temp.plan(pg_temp.id('A27'), 'created', 'client'), true));
select pg_temp.quiet(set_config('t.g1b', pg_temp.plan(pg_temp.id('A28'), 'created', 'client'), true));
select pg_temp.quiet(set_config('t.g1c', pg_temp.ccancel('A28'), true));

select is(
  concat_ws(' ', current_setting('t.g1a'), current_setting('t.g1b'), current_setting('t.g1c')),
  'ok ok ok',
  'messaging off: two online bookings are planned and the client cancels one through the link'
);
select pg_temp.lab('A27.conf', pg_temp.one('A27', 'booking_confirmed'));
select pg_temp.lab('A27.rem', pg_temp.rem_now('A27'));
select pg_temp.lab('A28.cbc', pg_temp.one('A28', 'cancelled_by_client'));

select is(
  pg_temp.st('A27.rem', 'A28.cbc'),
  'queued queued',
  'messaging off: the reminder is still planned (D9) and the client''s cancellation is queued'
);

select is(
  pg_temp.claim('g3', array['A27.conf', 'A28.cbc', 'O1'], now() + interval '1 minute'),
  'A27.conf,A28.cbc,O1',
  'messaging off: the confirmation, the cancellation and an OTP are claimed'
);

select set_config('t.g4', pg_temp.claim('g4', array['A27.rem'],
  (select m.scheduled_for + interval '1 minute' from public.messages_log m where m.id = pg_temp.id('A27.rem'))), true);

select is(
  current_setting('t.g4') || ' ' || pg_temp.st('A27.rem'),
  '- cancelled:messaging_disabled',
  'messaging off: the reminder is cancelled at claim (messaging_disabled)'
);

update public.businesses set messaging_enabled = true where id = 'e1100000-0000-4000-8000-00000000000a';

-- ---------------------------------------------------------------------------------------------
-- H. Suppression (§2.8 7c): a suppressed number gets no reminder of an imported appointment, but
--    its own new online booking gets the confirmation and the OTP. import_reminders is checked
--    again at claim (7b).
-- ---------------------------------------------------------------------------------------------
select pg_temp.mk('A29', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C5'), pg_temp.id('SM1'), pg_temp.lt(15, '12:00'), 'import');
select pg_temp.mk('A30', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C5'), pg_temp.id('SM1'), pg_temp.lt(15, '15:00'), 'online');
select pg_temp.otp('O2', '+306912300005', now(), now() + interval '5 minutes');

select is(
  concat_ws(' ', pg_temp.plan(pg_temp.id('A29'), 'created', 'import'), pg_temp.plan(pg_temp.id('A30'), 'created', 'client')),
  'ok ok',
  'suppression: an imported appointment and a new online booking of the suppressed number are planned'
);
select pg_temp.lab('A29.rem', pg_temp.rem_now('A29'));
select pg_temp.lab('A30.conf', pg_temp.one('A30', 'booking_confirmed'));

select is(
  pg_temp.st('A29.rem', 'A30.conf'),
  'queued queued',
  'suppression: the planner queues both (suppression is applied when sending)'
);

select set_config('t.h3', pg_temp.claim('h3', array['A29.rem'],
  (select m.scheduled_for + interval '1 minute' from public.messages_log m where m.id = pg_temp.id('A29.rem'))), true);

select is(
  current_setting('t.h3') || ' ' || pg_temp.st('A29.rem'),
  '- cancelled:suppressed',
  'suppression: the reminder of an imported appointment to a suppressed number is cancelled (suppressed)'
);

select is(
  pg_temp.claim('h4', array['A30.conf', 'O2'], now() + interval '1 minute'),
  'A30.conf,O2',
  'suppression: the same number''s own online booking gets its confirmation and its OTP'
);

update public.businesses set import_reminders = false where id = 'e1100000-0000-4000-8000-00000000000a';
select pg_temp.lab('A25.rem', pg_temp.rem_now('A25'));
select set_config('t.h5', pg_temp.claim('h5', array['A25.rem'],
  (select m.scheduled_for + interval '1 minute' from public.messages_log m where m.id = pg_temp.id('A25.rem'))), true);

select is(
  current_setting('t.h5') || ' ' || pg_temp.st('A25.rem'),
  '- cancelled:import_reminders_off',
  'import: a queued import reminder is cancelled at claim once import_reminders is switched off (import_reminders_off)'
);

-- ---------------------------------------------------------------------------------------------
-- I. A new manage token for every message with a manage link; the row keeps only its id.
-- ---------------------------------------------------------------------------------------------
select pg_temp.lab('A2.conf', pg_temp.one('A2', 'booking_confirmed'));
select pg_temp.lab('A2.rem', pg_temp.rem_now('A2'));
select pg_temp.lab('A8.rbc', pg_temp.one('A8', 'rescheduled_by_client'));
select pg_temp.lab('A13.cbb', pg_temp.one('A13', 'cancelled_by_business'));

select set_config('t.i1a', pg_temp.claim('tk1', array['A2.conf'], now() + interval '1 minute'), true);
select set_config('t.i1b', pg_temp.claim('tk2', array['A2.rem'],
  (select m.scheduled_for + interval '1 minute' from public.messages_log m where m.id = pg_temp.id('A2.rem'))), true);
select set_config('t.i1c', pg_temp.claim('tk3', array['A8.rbc', 'A13.cbb'], now() + interval '1 minute'), true);

select is(
  concat_ws(' ', current_setting('t.i1a'), current_setting('t.i1b'), current_setting('t.i1c')),
  'A2.conf A2.rem A13.cbb,A8.rbc',
  'tokens: the confirmation, the reminder, a client reschedule notice and a business cancel notice are claimed'
);

select is(
  (select concat_ws(' ',
     x.t1 is not null and x.t2 is not null and x.t1 <> x.t2,
     (select count(*) from public.messages_log m join public.booking_tokens b on b.id = m.booking_token_id
      where m.id in (pg_temp.id('A2.conf'), pg_temp.id('A2.rem')) and b.issued_for = 'message'
        and b.appointment_id = pg_temp.id('A2')
        and b.token_hash in (encode(sha256(convert_to(x.t1, 'UTF8')), 'hex'), encode(sha256(convert_to(x.t2, 'UTF8')), 'hex'))),
     (select count(distinct m.booking_token_id) from public.messages_log m
      where m.id in (pg_temp.id('A2.conf'), pg_temp.id('A2.rem'))))
   from (select pg_temp.item('tk1', 'A2.conf') ->> 'manage_token' as t1, pg_temp.item('tk2', 'A2.rem') ->> 'manage_token' as t2) x),
  't 2 2',
  'tokens: two messages of one appointment → two different new tokens (issued_for message), each row holds only its token id'
);

select is(
  concat_ws(' ',
    pg_temp.item('tk3', 'A8.rbc') ->> 'manage_token' is not null,
    (select b.issued_for = 'message' and b.token_hash = encode(sha256(convert_to(pg_temp.item('tk3', 'A8.rbc') ->> 'manage_token', 'UTF8')), 'hex')
     from public.messages_log m join public.booking_tokens b on b.id = m.booking_token_id where m.id = pg_temp.id('A8.rbc')),
    pg_temp.item('tk3', 'A13.cbb') ->> 'manage_token' is null,
    (select m.booking_token_id is null from public.messages_log m where m.id = pg_temp.id('A13.cbb'))),
  't t t t',
  'tokens: rescheduled_by_client gets a manage link; cancelled_by_business (/r/<code>) gets none'
);

select is(
  (select count(*) from public.messages_log m
   cross join unnest(array[pg_temp.item('tk1', 'A2.conf') ->> 'manage_token', pg_temp.item('tk2', 'A2.rem') ->> 'manage_token',
                           pg_temp.item('tk3', 'A8.rbc') ->> 'manage_token']) as tok (token)
   where strpos(to_jsonb(m)::text, tok.token) > 0),
  0::bigint,
  'tokens: no messages_log row contains a raw token (only the claim answer carries it)'
);

-- ---------------------------------------------------------------------------------------------
-- J. Push at claim (§2.8): recipient re-checked (no_recipient, not_a_member, no_subscription),
--    the item (keys always present), push_targets = exactly the recipient's rows, no personal data.
--    Clock TP = 2005-02-08 10:00Z; rows written directly.
-- ---------------------------------------------------------------------------------------------
select pg_temp.mk('AP', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM1'), '2005-02-10 10:00Z', 'online');
insert into public.appointment_services (business_id, appointment_id, position, service_id, price_cents, duration_min)
values ('e1100000-0000-4000-8000-00000000000a', pg_temp.id('AP'), 1, 'e1400000-0000-4000-8000-0000000000a2', 800, 20);

select pg_temp.msg('PP0', 'e1100000-0000-4000-8000-00000000000a', 'push_booking_created', pg_temp.id('AP'), null, null, pg_temp.id('UM0'), '2005-02-08 10:00Z');
select pg_temp.msg('PP1', 'e1100000-0000-4000-8000-00000000000a', 'push_booking_created', pg_temp.id('AP'), null, null, pg_temp.id('UX'), '2005-02-08 10:00Z');
select pg_temp.msg('PP2', 'e1100000-0000-4000-8000-00000000000a', 'push_booking_created', pg_temp.id('AP'), null, null, pg_temp.id('UM2'), '2005-02-08 10:00Z');
select pg_temp.msg('PP3', 'e1100000-0000-4000-8000-00000000000a', 'push_booking_created', pg_temp.id('AP'), null, null, null, '2005-02-08 10:00Z');
select pg_temp.msg('PP4', 'e1100000-0000-4000-8000-00000000000a', 'push_booking_moved', pg_temp.id('AP'), null, null, pg_temp.id('UN0'), '2005-02-08 10:00Z');
select pg_temp.msg('SP1', 'e1100000-0000-4000-8000-00000000000a', 'cancelled_by_business', pg_temp.id('AP'), pg_temp.id('C1'), '+306912300001', null, '2005-02-08 10:00Z');

select is(
  pg_temp.claim('jp', array['PP0', 'PP1', 'PP2', 'PP3', 'PP4', 'SP1'], '2005-02-08 10:01Z'),
  'PP0,SP1',
  'push claim: only the push to a current member with a device is claimed (with the SMS)'
);

select is(
  pg_temp.st('PP1', 'PP2', 'PP3', 'PP4'),
  'cancelled:not_a_member cancelled:no_subscription cancelled:no_recipient cancelled:not_a_member',
  'push claim: a non-member (even with a device), a member without a device, no recipient, a member of another business'
);

select is(
  array_to_string(pg_temp.keys(pg_temp.item('jp', 'PP0')), ',') || ' '
  || (pg_temp.keys(pg_temp.item('jp', 'PP0')) = pg_temp.keys(pg_temp.item('jp', 'SP1')))::text,
  'business_name,category,channel,client_first_name,id,lease_id,locale,manage_token,push_targets,service_name,'
  || 'short_code,staff_name,starts_at,template,timezone,to_e164 true',
  'claim item: the same sixteen keys for push and SMS items (always present)'
);

select is(
  (select concat_ws(' ', i ->> 'channel', i ->> 'template', i ->> 'category', i ->> 'locale', i ->> 'client_first_name',
                    i ->> 'service_name', i ->> 'staff_name', i ->> 'business_name', i ->> 'timezone',
                    (i ->> 'starts_at')::timestamptz = '2005-02-10 10:00Z', (i ->> 'to_e164') is null, (i ->> 'manage_token') is null)
   from pg_temp.item('jp', 'PP0') as i),
  'push push_booking_created transactional el Γιώργος Κούρεμα SM1 Msg Shop Europe/Athens t t t',
  'push item: the client''s FIRST name only, the first service line, the staff name; no phone and no token'
);

select is(
  pg_temp.item('jp', 'PP0') -> 'push_targets',
  jsonb_build_array(
    jsonb_build_object('provider', 'onesignal', 'subscription_id', 'e10f0000-0000-4000-8000-0000000000a0'),
    jsonb_build_object('provider', 'vapid', 'endpoint', 'https://push.example.test/e1/a0',
                       'p256dh', 'B' || repeat('m', 86), 'auth_secret', 'a' || repeat('m', 21))),
  'push item: push_targets = exactly the recipient''s push_subscriptions rows, oldest first (resolved at claim time)'
);

select is(
  concat_ws(' ',
    strpos(pg_temp.item('jp', 'PP0')::text, 'Παπαδόπουλος') = 0, strpos(pg_temp.item('jp', 'PP0')::text, '+30') = 0,
    (pg_temp.item('jp', 'SP1') ->> 'client_first_name') is null, (pg_temp.item('jp', 'SP1') ->> 'service_name') is null,
    (pg_temp.item('jp', 'SP1') ->> 'push_targets') is null, pg_temp.item('jp', 'SP1') ->> 'to_e164'),
  't t t t t +306912300001',
  'claim items: the push item carries neither the surname nor any phone; the SMS item carries no push fields'
);

-- ---------------------------------------------------------------------------------------------
-- K. Deadlines (D21) and the claim-time appointment check. TU = 2004-11-16 10:00Z (12:00 EET).
--    AU1 starts TU + 1 day · AU2 starts TU + 30′ · AU3 cancelled.
-- ---------------------------------------------------------------------------------------------
select pg_temp.mk('AU1', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C2'), pg_temp.id('SM1'), '2004-11-17 10:00Z', 'online');
select pg_temp.mk('AU2', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C2'), pg_temp.id('SM2'), '2004-11-16 10:30Z', 'online');
select pg_temp.mk('AU3', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C2'), pg_temp.id('SM3'), '2004-11-18 10:00Z', 'online', 'cancelled');
select pg_temp.msg('RU1', 'e1100000-0000-4000-8000-00000000000a', 'reminder', pg_temp.id('AU1'), pg_temp.id('C2'), '+306912300002', null, '2004-11-16 10:00Z');
select pg_temp.msg('RU2', 'e1100000-0000-4000-8000-00000000000a', 'reminder', pg_temp.id('AU1'), pg_temp.id('C2'), '+306912300002', null, '2004-11-16 10:00Z');
select pg_temp.msg('RU3', 'e1100000-0000-4000-8000-00000000000a', 'reminder', pg_temp.id('AU2'), pg_temp.id('C2'), '+306912300002', null, '2004-11-16 10:00Z');
select pg_temp.msg('RU4', 'e1100000-0000-4000-8000-00000000000a', 'reminder', pg_temp.id('AU1'), pg_temp.id('C2'), '+306912300002', null, '2004-11-15 19:30Z');
select pg_temp.msg('RU5', 'e1100000-0000-4000-8000-00000000000a', 'reminder', pg_temp.id('AU3'), pg_temp.id('C2'), '+306912300002', null, '2004-11-16 10:00Z');
select pg_temp.msg('PU1', 'e1100000-0000-4000-8000-00000000000a', 'push_booking_created', pg_temp.id('AU1'), null, null, pg_temp.id('UM0'), '2004-11-16 10:00Z');
select pg_temp.msg('PU2', 'e1100000-0000-4000-8000-00000000000a', 'push_booking_created', pg_temp.id('AU1'), null, null, pg_temp.id('UM0'), '2004-11-16 10:00Z');
select pg_temp.msg('PT1', 'e1100000-0000-4000-8000-00000000000a', 'push_test', null, null, null, pg_temp.id('UM0'), '2004-11-16 10:00Z');
select pg_temp.msg('PT2', 'e1100000-0000-4000-8000-00000000000a', 'push_test', null, null, null, pg_temp.id('UM0'), '2004-11-16 10:00Z');
select pg_temp.msg('CU1', 'e1100000-0000-4000-8000-00000000000a', 'booking_confirmed', pg_temp.id('AU1'), pg_temp.id('C2'), '+306912300002', null, '2004-10-17 10:00Z');
select pg_temp.otp('OU1', '+306912300009', '2004-11-15 10:00Z', '2004-11-15 10:05Z');

select is(
  concat_ws(' | ',
    pg_temp.claim('k1a', array['RU1', 'PU1'], '2004-11-16 10:59Z'),
    pg_temp.claim('k1b', array['PT2'], '2004-11-16 10:09:59Z')),
  'PU1,RU1 | PT2',
  'deadlines: a reminder and a push 59′ after their time, a test push 9′59″ after, are still claimed'
);

select set_config('t.k2', concat_ws(' | ',
  pg_temp.claim('k2a', array['RU2', 'PU2'], '2004-11-16 11:00Z'),
  pg_temp.claim('k2b', array['RU3'], '2004-11-16 10:30Z'),
  pg_temp.claim('k2c', array['PT1'], '2004-11-16 10:10Z')), true);

select is(
  current_setting('t.k2') || ' ' || pg_temp.st('RU2', 'PU2', 'RU3', 'PT1'),
  '- | - | - cancelled:expired cancelled:expired cancelled:expired cancelled:expired',
  'deadlines: reminder and push at +60′, a reminder at the start of its appointment, a test push at +10′ → expired'
);

select set_config('t.k3', pg_temp.claim('k3', array['RU4'], '2004-11-15 20:05Z'), true);

select is(
  current_setting('t.k3') || ' ' || pg_temp.st('RU4'),
  '- cancelled:expired',
  'deadlines: a reminder is never sent inside quiet hours, even within its 60′ (21:30 → claimed at 22:05 local: expired)'
);

select set_config('t.k4', pg_temp.claim('k4', array['RU5', 'CU1', 'OU1'], '2004-11-16 10:00Z'), true);

select is(
  current_setting('t.k4') || ' ' || pg_temp.st('RU5'),
  'CU1,OU1 cancelled:superseded',
  'claim: a confirmation 30 days late and an OTP a day late have no deadline (ids mode); a reminder of a cancelled '
  || 'appointment is superseded'
);

-- ---------------------------------------------------------------------------------------------
-- L. Re-addressing at claim (D24) and landlines. TV = 2005-01-11 10:00Z.
-- ---------------------------------------------------------------------------------------------
select pg_temp.mk('AV', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C7'), pg_temp.id('SM0'), '2005-01-12 10:00Z', 'phone');
select pg_temp.msg('V1', 'e1100000-0000-4000-8000-00000000000a', 'cancelled_by_business', pg_temp.id('AV'), pg_temp.id('C7'), '+306912300070', null, '2005-01-11 10:00Z');
select pg_temp.msg('V2', 'e1100000-0000-4000-8000-00000000000a', 'cancelled_by_business', pg_temp.id('AV'), pg_temp.id('C6'), '+306912300006', null, '2005-01-11 10:00Z');
select pg_temp.msg('V3', 'e1100000-0000-4000-8000-00000000000a', 'cancelled_by_business', pg_temp.id('AV'), pg_temp.id('C3'), '+302101234567', null, '2005-01-11 10:00Z');
select pg_temp.msg('V4', 'e1100000-0000-4000-8000-00000000000a', 'cancelled_by_business', pg_temp.id('AV'), pg_temp.id('C4'), '+306912300040', null, '2005-01-11 10:00Z');
select pg_temp.otp('V5', '+306912300009', '2005-01-11 10:00Z', '2005-01-11 10:05Z');
select pg_temp.msg('V6', 'e1100000-0000-4000-8000-00000000000b', 'cancelled_by_business', null, pg_temp.id('CN1'), '+12125550101', null, '2005-01-11 10:00Z');

-- C7 corrected a typo in their number and switched to English; C6 was erased (as 1.8 will do).
update public.clients set phone_e164 = '+306912300077', locale = 'en' where id = pg_temp.id('C7');
update public.clients set full_name = '', phone_e164 = null, email = null, birthday = null, erased_at = now()
where id = pg_temp.id('C6');

select is(
  pg_temp.claim('lv', array['V1', 'V2', 'V3', 'V4', 'V5', 'V6'], '2005-01-11 10:00Z'),
  'V1,V5,V6',
  're-addressing: of six SMS only the corrected number, the OTP and the foreign number are claimed'
);

select is(
  (select concat_ws(' ', pg_temp.item('lv', 'V1') ->> 'to_e164', pg_temp.item('lv', 'V1') ->> 'locale', m.to_e164, m.locale)
   from public.messages_log m where m.id = pg_temp.id('V1')),
  '+306912300077 en +306912300077 en',
  're-addressing: an SMS with a client goes to the client''s CURRENT phone and language, written to the row'
);

select is(
  concat_ws(' ', pg_temp.st('V2', 'V3', 'V4'), pg_temp.item('lv', 'V5') ->> 'to_e164', pg_temp.item('lv', 'V6') ->> 'to_e164'),
  'cancelled:no_recipient cancelled:not_mobile cancelled:no_recipient +306912300009 +12125550101',
  're-addressing: erased client → no_recipient; +30 landline → not_mobile; client without phone → no_recipient; '
  || 'an OTP keeps its number; a non-Greek number is sent'
);

-- ---------------------------------------------------------------------------------------------
-- M. Leases: the claim skips leased rows; the sweep takes expired leases back as 'unknown' (D23);
--    the dead lease's result is refused; 'unknown' is never claimed again. The due claim never
--    takes OTP. TK = 2001-02-06 10:00Z: the earliest clock of this file, so the due claim and the
--    sweep see only these rows.
-- ---------------------------------------------------------------------------------------------
select pg_temp.mk('AK', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C2'), pg_temp.id('SM0'), '2001-02-07 10:00Z', 'phone');
select pg_temp.msg('SK1', 'e1100000-0000-4000-8000-00000000000a', 'cancelled_by_business', pg_temp.id('AK'), pg_temp.id('C2'), '+306912300002', null, '2001-02-06 10:00Z');
select pg_temp.msg('SK2', 'e1100000-0000-4000-8000-00000000000a', 'cancelled_by_business', pg_temp.id('AK'), pg_temp.id('C2'), '+306912300002', null, '2001-02-06 10:00Z');
select pg_temp.msg('PK', 'e1100000-0000-4000-8000-00000000000a', 'push_test', null, null, null, pg_temp.id('UM0'), '2001-02-06 10:00Z');
select pg_temp.otp('OK1', '+306912300009', '2001-02-06 10:00Z', '2001-02-06 10:05Z');

select ok(
  pg_temp.due('dk1', 1, '2001-02-06 10:00:01Z') ~ '^(SK1|SK2|PK) more=true$',
  'claim_due_messages: with p_limit 1 one due row (never the OTP) is claimed and more is true'
);

select set_config('t.dk2', pg_temp.due('dk2', 50, '2001-02-06 10:00:01Z'), true);

select is(
  (select string_agg(pg_temp.l((x.i ->> 'id')::uuid), ',' order by pg_temp.l((x.i ->> 'id')::uuid))
   from (select jsonb_array_elements(pg_temp.r('dk1') -> 'items') union all
         select jsonb_array_elements(pg_temp.r('dk2') -> 'items')) as x (i))
  || ' ' || (pg_temp.r('dk2') ->> 'more') || ' ' || pg_temp.st('OK1'),
  'PK,SK1,SK2 false queued',
  'claim_due_messages: the rest is claimed (SMS and push), more false; a queued OTP is never taken by the due claim'
);

select is(
  concat_ws(' ', pg_temp.due('x', 0, '2001-02-06 10:00Z'), pg_temp.due('x', 51, '2001-02-06 10:00Z'),
            pg_temp.due('x', null, '2001-02-06 10:00Z')),
  '22023 22023 22023',
  'claim_due_messages: p_limit must be 1–50 (22023)'
);

select is(
  concat_ws(' ', pg_temp.claim('m4', array['SK1', 'SK2', 'PK'], '2001-02-06 10:00:30Z'),
            pg_temp.due('dm4', 50, '2001-02-06 10:00:30Z')),
  '- - more=false',
  'claim: rows under a live lease are returned by neither claim'
);

-- Every sweep below starts as a fresh cron transaction: the staff RPCs above have already nudged
-- in this one, and a set flag would let the sweep "nudge" without queueing anything.
select set_config('anaklo.dispatch_nudged', '', true);
select set_config('t.sw1n', pg_temp.nudges()::text, true);
select set_config('t.sw1_from', clock_timestamp()::text, true);
select set_config('t.sw1', coalesce(private.dispatch_sweep_impl('2001-02-06 10:02Z')::text, 'null'), true);
select set_config('t.sw1_to', clock_timestamp()::text, true);

select is(
  concat_ws(' ', current_setting('t.sw1'), pg_temp.st('SK1', 'SK2', 'PK', 'OK1'),
    (select count(*) from public.messages_log m
     where m.id in (pg_temp.id('SK1'), pg_temp.id('SK2'), pg_temp.id('PK')) and m.lease_id is null and m.lease_until is null),
    pg_temp.runs(current_setting('t.sw1_from'), current_setting('t.sw1_to'))),
  '3 unknown:lease_expired unknown:lease_expired unknown:lease_expired queued 3 dispatch_sweep true 3 -',
  'sweep: expired leases become unknown (lease_expired, lease cleared), never re-queued; an OTP whose challenge is '
  || 'still live stays; one job run with rows_affected'
);

select is(
  concat_ws(' ', pg_temp.nudges() - current_setting('t.sw1n')::bigint, pg_temp.last_nudge()),
  '1 t t sweep',
  'sweep: queues exactly one pg_net request to dispatch_url with the secret header (source sweep)'
);

select is(
  concat_ws(' ',
    private.record_send_result_impl(
      pg_temp.id('SK1'), (coalesce(pg_temp.item('dk1', 'SK1'), pg_temp.item('dk2', 'SK1')) ->> 'lease_id')::uuid,
      'sent', 'fake', 'pgtap12-late', 1, null, null, '2001-02-06 10:02:01Z'),
    pg_temp.st('SK1')),
  'f unknown:lease_expired',
  'record_send_result: the late result of a dead lease is refused (false) and changes nothing'
);

select set_config('anaklo.dispatch_nudged', '', true);
select set_config('t.sw2n', pg_temp.nudges()::text, true);
select set_config('t.sw2_from', clock_timestamp()::text, true);
select set_config('t.sw2', coalesce(private.dispatch_sweep_impl('2001-02-06 10:06Z')::text, 'null'), true);
select set_config('t.sw2_to', clock_timestamp()::text, true);

select is(
  concat_ws(' ', current_setting('t.sw2'), pg_temp.st('OK1'), pg_temp.runs(current_setting('t.sw2_from'), current_setting('t.sw2_to')),
    pg_temp.nudges() - current_setting('t.sw2n')::bigint, pg_temp.last_nudge()),
  '1 cancelled:expired dispatch_sweep true 1 - 1 t t sweep',
  'sweep: a queued OTP whose challenge expired is closed (expired); one nudge (source sweep)'
);

-- D25: the sweep nudges dispatch even when it closed nothing (reminders due now, retries and rows
-- whose immediate send was lost are sent by that nudge; dispatch writes its heartbeat).
select set_config('anaklo.dispatch_nudged', '', true);
select set_config('t.sw3n', pg_temp.nudges()::text, true);
select set_config('t.sw3_from', clock_timestamp()::text, true);
select set_config('t.sw3', coalesce(private.dispatch_sweep_impl('2001-02-06 10:07Z')::text, 'null'), true);
select set_config('t.sw3_to', clock_timestamp()::text, true);

select is(
  concat_ws(' ', current_setting('t.sw3'), pg_temp.runs(current_setting('t.sw3_from'), current_setting('t.sw3_to')),
    pg_temp.nudges() - current_setting('t.sw3n')::bigint, pg_temp.last_nudge()),
  '0 dispatch_sweep true 0 - 1 t t sweep',
  'sweep with nothing to close: still exactly one nudge (source sweep) and an ok job run with 0 rows (D25)'
);

-- Without dispatch_url in Vault the sweep cannot nudge: its run says so (1.9's health reads it).
select set_config('anaklo.dispatch_nudged', '', true);
select pg_temp.set_vault('dispatch_url', 'http://127.0.0.1:9/pgtap-nudge', 'pgtap_12_moved_dispatch_url');
select set_config('t.sw4n', pg_temp.nudges()::text, true);
select set_config('t.sw4_from', clock_timestamp()::text, true);
select set_config('t.sw4', coalesce(private.dispatch_sweep_impl('2001-02-06 10:08Z')::text, 'null'), true);
select set_config('t.sw4_to', clock_timestamp()::text, true);
select pg_temp.set_vault('pgtap_12_moved_dispatch_url', 'http://127.0.0.1:9/pgtap-nudge', 'dispatch_url');
select set_config('anaklo.dispatch_nudged', '', true);

select is(
  concat_ws(' ', current_setting('t.sw4'), pg_temp.runs(current_setting('t.sw4_from'), current_setting('t.sw4_to')),
    pg_temp.nudges() - current_setting('t.sw4n')::bigint),
  '0 dispatch_sweep false 0 dispatch_not_configured 0',
  'sweep without dispatch_url in Vault: nothing queued, the job run is not ok (dispatch_not_configured)'
);

select is(
  concat_ws(' ', pg_temp.claim('m8', array['SK1', 'SK2', 'PK'], '2001-02-06 10:10Z'),
            pg_temp.due('dm8', 50, '2001-02-06 10:10Z')),
  '- - more=false',
  'claim: an unknown outcome is never claimed again (at most once, D22/D23)'
);

-- ---------------------------------------------------------------------------------------------
-- N. record_send_result (§2.9): failed → re-queued +5′ × attempts up to 3 attempts (not OTP, not
--    past the deadline); unknown kept; rejected → cancelled; sent. TL = 2002-03-05 10:00Z.
-- ---------------------------------------------------------------------------------------------
create function pg_temp.mst(a_label text)
returns text
language sql
stable
as $fn$
  select concat_ws(' ', m.status, coalesce(m.error, '-'), m.attempts, to_char(m.scheduled_for at time zone 'UTC', 'HH24:MI'))
  from public.messages_log m where m.id = pg_temp.id(a_label);
$fn$;

select pg_temp.mk('AL', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C2'), pg_temp.id('SM0'), '2002-03-06 10:00Z', 'phone');
select pg_temp.msg(x.label, 'e1100000-0000-4000-8000-00000000000a', 'cancelled_by_business', pg_temp.id('AL'), pg_temp.id('C2'),
                   '+306912300002', null, '2002-03-05 10:00Z')
from unnest(array['FL', 'UL', 'UL2', 'RL', 'SL', 'WL', 'DL1', 'DL2', 'DL3']) as x (label);
select pg_temp.otp('OL', '+306912300009', '2002-03-05 10:00Z', '2002-03-05 10:05Z');
select pg_temp.msg('PF', 'e1100000-0000-4000-8000-00000000000a', 'push_test', null, null, null, pg_temp.id('UM0'), '2002-03-05 10:01Z');
select pg_temp.msg('PS', 'e1100000-0000-4000-8000-00000000000a', 'push_test', null, null, null, pg_temp.id('UM0'), '2002-03-05 10:00Z');

select set_config('t.n1a', pg_temp.claim('n1', array['FL'], '2002-03-05 10:00Z'), true);
select set_config('t.n1b', pg_temp.rec('n1', 'FL', 'failed', '2002-03-05 10:00Z', null, null, null, 'http_500'), true);

select is(
  concat_ws(' ', current_setting('t.n1a'), current_setting('t.n1b'), pg_temp.mst('FL')),
  'FL true queued http_500 1 10:05',
  'record failed (1st attempt): re-queued 5′ later, the error kept'
);

select set_config('t.n2a', pg_temp.claim('n2x', array['FL'], '2002-03-05 10:04Z'), true);
select set_config('t.n2b', pg_temp.claim('n2', array['FL'], '2002-03-05 10:05Z'), true);
select set_config('t.n2c', pg_temp.rec('n2', 'FL', 'failed', '2002-03-05 10:05Z', null, null, null, 'http_500'), true);

select is(
  concat_ws(' ', current_setting('t.n2a'), current_setting('t.n2b'), current_setting('t.n2c'), pg_temp.mst('FL')),
  '- FL true queued http_500 2 10:15',
  'record failed (2nd attempt): not claimable before its new time, then re-queued 10′ later'
);

select set_config('t.n3a', pg_temp.claim('n3', array['FL'], '2002-03-05 10:15Z'), true);
select set_config('t.n3b', pg_temp.rec('n3', 'FL', 'failed', '2002-03-05 10:15Z', null, null, null, 'http_500'), true);

select is(
  (select concat_ws(' ', current_setting('t.n3a'), current_setting('t.n3b'), m.status, m.error, m.attempts)
   from public.messages_log m where m.id = pg_temp.id('FL')),
  'FL true failed http_500 3',
  'record failed (3rd attempt): final failed'
);

select set_config('t.n4a', pg_temp.claim('n4', array['OL'], '2002-03-05 10:00Z'), true);
select set_config('t.n4b', pg_temp.rec('n4', 'OL', 'failed', '2002-03-05 10:00Z', null, null, null, 'http_500'), true);

select is(
  (select concat_ws(' ', current_setting('t.n4a'), current_setting('t.n4b'), m.status, m.error, m.attempts)
   from public.messages_log m where m.id = pg_temp.id('OL')),
  'OL true failed http_500 1',
  'record failed: an OTP is never retried'
);

select set_config('t.n5', pg_temp.claim('n5', array['UL', 'UL2', 'RL', 'SL', 'WL'], '2002-03-05 10:00Z'), true);
select set_config('t.n5r', concat_ws(' ',
  pg_temp.rec('n5', 'UL', 'unknown', '2002-03-05 10:01Z', 'pgtap12-unk-1', null, null, 'timeout'),
  pg_temp.rec('n5', 'UL2', 'unknown', '2002-03-05 10:01Z', 'pgtap12-unk-2', null, null, 'timeout'),
  pg_temp.rec('n5', 'RL', 'rejected', '2002-03-05 10:01Z', null, null, null, 'recipient_not_allowed'),
  pg_temp.rec('n5', 'SL', 'sent', '2002-03-05 10:01Z', 'pgtap12-sent-1', 1, 4, null),
  private.record_send_result_impl(pg_temp.id('WL'), gen_random_uuid(), 'sent', 'fake', 'pgtap12-wrong', 1, null, null,
                                  '2002-03-05 10:01Z')::text), true);

select is(
  current_setting('t.n5') || ' ' || current_setting('t.n5r'),
  'RL,SL,UL,UL2,WL true true true true false',
  'record_send_result: unknown, rejected and sent with the current lease → true; a wrong lease → false'
);

select is(
  concat_ws(' ', pg_temp.st('UL', 'RL', 'SL', 'WL'),
    (select concat_ws(' ', m.provider, m.provider_message_id, m.segments, m.cost_cents, m.sent_at = '2002-03-05 10:01Z')
     from public.messages_log m where m.id = pg_temp.id('SL')),
    (select m.provider_message_id from public.messages_log m where m.id = pg_temp.id('UL')),
    (select count(*) from public.messages_log m
     where m.id in (pg_temp.id('UL'), pg_temp.id('RL'), pg_temp.id('SL')) and m.lease_id is null)),
  'unknown:timeout cancelled:recipient_not_allowed sent sending fake pgtap12-sent-1 1 4 t pgtap12-unk-1 3',
  'record_send_result: unknown keeps the provider id; rejected → cancelled with the code; sent records provider, id, '
  || 'segments, cost, time; leases cleared; the wrong lease left its row alone'
);

select is(
  pg_temp.rec('n5', 'WL', 'bogus', '2002-03-05 10:01Z'),
  '22023',
  'record_send_result: an unknown outcome is refused (22023)'
);

select set_config('t.n7', pg_temp.claim('n7', array['UL'], '2002-03-05 11:00Z'), true);

select is(
  current_setting('t.n7') || ' ' || pg_temp.st('UL'),
  '- unknown:timeout',
  'record unknown: never re-claimed'
);

select set_config('t.n8a', pg_temp.claim('n8a', array['PF'], '2002-03-05 10:01Z'), true);
select set_config('t.n8b', pg_temp.rec('n8a', 'PF', 'failed', '2002-03-05 10:02Z', null, null, null, 'http_503'), true);
select set_config('t.n8c', pg_temp.mst('PF'), true);
select set_config('t.n8d', pg_temp.claim('n8d', array['PF'], '2002-03-05 10:07Z'), true);
select set_config('t.n8e', pg_temp.rec('n8d', 'PF', 'failed', '2002-03-05 10:07Z', null, null, null, 'http_503'), true);

select is(
  (select concat_ws(' ', current_setting('t.n8a'), current_setting('t.n8b'), current_setting('t.n8c'),
                    current_setting('t.n8d'), current_setting('t.n8e'), m.status, m.attempts)
   from public.messages_log m where m.id = pg_temp.id('PF')),
  'PF true queued http_503 1 10:07 PF true failed 2',
  'record failed (push): re-queued while the deadline allows it, final failed when the next try would be past it'
);

-- ---------------------------------------------------------------------------------------------
-- O. record_delivery_report (§2.9): as reported by the provider; undelivered is final; unknown is
--    resolved; never re-queues; only SMS rows.
-- ---------------------------------------------------------------------------------------------
create function pg_temp.dlr(a_id text, a_status text, a_segments integer default null, a_cost integer default null,
                            a_error text default null)
returns text
language plpgsql
as $fn$
begin
  return public.record_delivery_report('fake', a_id, a_status, a_segments, a_cost, a_error)::text;
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

create function pg_temp.dst(a_label text)
returns text
language sql
stable
as $fn$
  select concat_ws(' ', m.status, coalesce(m.error, '-'), m.attempts, coalesce(m.segments::text, '-'), coalesce(m.cost_cents::text, '-'))
  from public.messages_log m where m.id = pg_temp.id(a_label);
$fn$;

select set_config('t.o1', pg_temp.claim('o1', array['DL1', 'DL2', 'DL3', 'PS'], '2002-03-05 10:00Z'), true);
select set_config('t.o1r', concat_ws(' ',
  pg_temp.rec('o1', 'DL1', 'sent', '2002-03-05 10:00Z', 'pgtap12-dlr-1', 1, null, null),
  pg_temp.rec('o1', 'DL2', 'sent', '2002-03-05 10:00Z', 'pgtap12-dlr-2', 1, null, null),
  pg_temp.rec('o1', 'DL3', 'sent', '2002-03-05 10:00Z', 'pgtap12-dlr-3', 1, null, null),
  pg_temp.rec('o1', 'PS', 'sent', '2002-03-05 10:00Z', 'fake-push-pgtap12', null, null, null)), true);

select is(
  current_setting('t.o1') || ' ' || current_setting('t.o1r'),
  'DL1,DL2,DL3,PS true true true true',
  'delivery reports: three SMS and a push are sent'
);

select set_config('t.o2', pg_temp.dlr('pgtap12-dlr-1', 'delivered', 2, 7), true);

select is(
  current_setting('t.o2') || ' ' || pg_temp.dst('DL1'),
  'true delivered - 1 2 7',
  'record_delivery_report: delivered, with segments and cost as reported; attempts untouched'
);

select set_config('t.o3', pg_temp.dlr('pgtap12-dlr-1', 'undelivered', null, null, 'E1'), true);

select is(
  current_setting('t.o3') || ' ' || pg_temp.dst('DL1'),
  'false delivered - 1 2 7',
  'record_delivery_report: undelivered after delivered → false, unchanged'
);

select set_config('t.o4', concat_ws(' ', pg_temp.dlr('pgtap12-dlr-2', 'undelivered', null, null, 'E123'),
                                    pg_temp.dlr('pgtap12-dlr-3', 'undelivered')), true);
select set_config('t.o4c', pg_temp.claim('o4c', array['DL2'], '2002-03-05 11:00Z'), true);

select is(
  concat_ws(' ', current_setting('t.o4'), pg_temp.st('DL2', 'DL3'), current_setting('t.o4c')),
  'true true failed:E123 failed:undelivered -',
  'record_delivery_report: undelivered → failed with the code (or ''undelivered''), final: never claimed again'
);

select set_config('t.o5', concat_ws(' ', pg_temp.dlr('pgtap12-unk-1', 'delivered'),
                                    pg_temp.dlr('pgtap12-unk-2', 'undelivered', null, null, 'X9')), true);

select is(
  current_setting('t.o5') || ' ' || pg_temp.st('UL', 'UL2'),
  'true true delivered failed:X9',
  'record_delivery_report: an unknown outcome is resolved by the report (delivered / failed)'
);

select is(
  concat_ws(' ', pg_temp.dlr('pgtap12-none', 'delivered'), pg_temp.dlr('fake-push-pgtap12', 'delivered'), pg_temp.st('PS')),
  'false false sent',
  'record_delivery_report: an unknown provider id → false; a push row is not an SMS → false, unchanged'
);

select is(
  concat_ws(' ', pg_temp.dlr('pgtap12-sent-1', 'delivered', 11), pg_temp.dlr('pgtap12-sent-1', 'delivered', null, -1),
            pg_temp.dlr('pgtap12-sent-1', 'bogus'), pg_temp.st('SL')),
  '22023 22023 22023 sent',
  'record_delivery_report: segments/cost outside the CHECK ranges or an unknown status → 22023, nothing written'
);

-- ---------------------------------------------------------------------------------------------
-- P. Switches, caps and budget stop the claim (§2.8, D20). Each case on its own UTC day/month of
--    2003, so the counters are this test's own (they are set explicitly where it matters).
-- ---------------------------------------------------------------------------------------------
create function pg_temp.set_counter(a_bucket text, a_key text, a_window timestamptz, a_count integer)
returns void
language sql
as $fn$
  insert into public.rate_limits (bucket, key, window_start, count) values (a_bucket, a_key, a_window, a_count)
  on conflict (bucket, key, window_start) do update set count = excluded.count;
$fn$;

create function pg_temp.counter(a_bucket text, a_key text, a_window timestamptz)
returns integer
language sql
stable
as $fn$
  select coalesce(max(l.count), 0) from public.rate_limits l
  where l.bucket = a_bucket and l.key = a_key and l.window_start = a_window;
$fn$;

select pg_temp.mk('AC', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C2'), pg_temp.id('SM0'), '2003-07-01 10:00Z', 'phone');
select pg_temp.msg(x.label, 'e1100000-0000-4000-8000-00000000000a', 'cancelled_by_business', pg_temp.id('AC'), pg_temp.id(x.client),
                   x.phone, null, x.at)
from (values
  ('SN1', 'C2', '+306912300002', timestamptz '2003-04-08 10:00Z'),
  ('SN3', 'C2', '+306912300002', timestamptz '2003-04-09 10:00Z'),
  ('SN4', 'C1', '+306912300001', timestamptz '2003-04-09 10:00Z'),
  ('SN5', 'C2', '+306912300002', timestamptz '2003-05-06 10:00Z'),
  ('SN6', 'C2', '+306912300002', timestamptz '2003-04-10 10:00Z'),
  ('SN7', 'C1', '+306912300001', timestamptz '2003-04-10 10:00Z')
) as x (label, client, phone, at);
select pg_temp.msg(x.label, 'e1100000-0000-4000-8000-00000000000a', 'push_test', null, null, null, pg_temp.id(x.recipient), x.at)
from (values
  ('PN1', 'UM0', timestamptz '2003-04-08 10:00Z'),
  ('PN2', 'UM1', timestamptz '2003-04-08 10:00Z'),
  ('PN3', 'UM0', timestamptz '2003-04-09 10:00Z'),
  ('PN5', 'UM0', timestamptz '2003-05-06 10:00Z')
) as x (label, recipient, at);
select pg_temp.otp('ON1', '+306912300009', '2003-04-09 10:00Z', '2003-04-09 10:05Z');
select pg_temp.otp('ON2', '+306912300009', '2003-05-06 10:00Z', '2003-05-06 10:05Z');
select pg_temp.otp('ON3', '+306912300009', '2003-04-10 10:00Z', '2003-04-10 10:05Z');

update private.platform_settings set sms_enabled = false;
select set_config('t.p1a', pg_temp.claim('p1a', array['SN1', 'PN1'], '2003-04-08 10:01Z'), true);
update private.platform_settings set sms_enabled = true, push_enabled = false;
select set_config('t.p1b', pg_temp.claim('p1b', array['SN1', 'PN2'], '2003-04-08 10:01Z'), true);
update private.platform_settings set push_enabled = true;

select is(
  current_setting('t.p1a') || ' | ' || current_setting('t.p1b') || ' ' || pg_temp.st('PN2'),
  'PN1 | SN1 queued',
  'switches: sms_enabled off keeps SMS queued while push goes; push_enabled off keeps push queued while SMS goes'
);

update private.platform_settings set sms_daily_cap = 50, sms_otp_reserve_pct = 20;
select pg_temp.set_counter('sms_platform_day', 'platform', '2003-04-09 00:00Z', 50);
select set_config('t.p2a', pg_temp.claim('p2a', array['SN3', 'ON1', 'PN3'], '2003-04-09 10:00Z'), true);
select pg_temp.set_counter('sms_platform_day', 'platform', '2003-04-09 00:00Z', 40);
select set_config('t.p2b', pg_temp.claim('p2b', array['SN3', 'ON1'], '2003-04-09 10:00Z'), true);
select pg_temp.set_counter('sms_platform_day', 'platform', '2003-04-09 00:00Z', 30);
select set_config('t.m0', pg_temp.counter('sms_platform_month', 'platform', '2003-04-01 00:00Z')::text, true);
select set_config('t.p2c', pg_temp.claim('p2c', array['SN3', 'SN4'], '2003-04-09 10:00Z'), true);
update private.platform_settings set sms_daily_cap = 100000;

select is(
  concat_ws(' ', current_setting('t.p2a'), current_setting('t.p2b'), current_setting('t.p2c'),
    pg_temp.counter('sms_platform_day', 'platform', '2003-04-09 00:00Z'),
    pg_temp.counter('sms_platform_month', 'platform', '2003-04-01 00:00Z') = current_setting('t.m0')::integer + 2),
  'PN3 ON1 SN3,SN4 32 t',
  'platform daily cap: full → every SMS stays queued (push still goes); in the OTP reserve only OTP; below it both; '
  || 'the day and month counters count the SMS claimed'
);

update private.platform_settings set sms_monthly_cap = 100;
select pg_temp.set_counter('sms_platform_month', 'platform', '2003-05-01 00:00Z', 100);
select set_config('t.p3', pg_temp.claim('p3', array['SN5', 'ON2', 'PN5'], '2003-05-06 10:00Z'), true);
update private.platform_settings set sms_monthly_cap = 1000000;

select is(
  current_setting('t.p3') || ' ' || pg_temp.st('SN5', 'ON2'),
  'PN5 queued queued',
  'platform monthly cap (new): full → every SMS stays queued, OTP included (no reserve); push still goes'
);

update public.businesses set sms_daily_cap = 1 where id = 'e1100000-0000-4000-8000-00000000000a';
select set_config('t.p4a', pg_temp.claim('p4a', array['SN6'], '2003-04-10 10:00Z'), true);
select set_config('t.p4b', pg_temp.claim('p4b', array['SN7', 'ON3'], '2003-04-10 10:00Z'), true);
update public.businesses set sms_daily_cap = null where id = 'e1100000-0000-4000-8000-00000000000a';

select is(
  concat_ws(' ', current_setting('t.p4a'), current_setting('t.p4b'), pg_temp.st('SN7'),
    pg_temp.counter('sms_business_day', 'e1100000-0000-4000-8000-00000000000a', '2003-04-10 00:00Z')),
  'SN6 ON3 cancelled:rate_limited 1',
  'business daily cap (sms_daily_cap = 1): the second SMS is rate_limited (hit taken back); OTP is not counted'
);

update public.businesses set sms_monthly_budget_cents = 5 where id = 'e1100000-0000-4000-8000-00000000000a';
select pg_temp.mk('AB', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM0'), '2003-06-11 10:00Z', 'phone');
select pg_temp.msg('XB', 'e1100000-0000-4000-8000-00000000000a', 'cancelled_by_business', pg_temp.id('AB'), pg_temp.id('C1'),
                   '+306912300001', null, '2003-06-10 09:00Z', '2003-06-10 09:00Z', 'sent', 5);
select pg_temp.msg('RB', 'e1100000-0000-4000-8000-00000000000a', 'reminder', pg_temp.id('AB'), pg_temp.id('C1'),
                   '+306912300001', null, '2003-06-10 10:00Z', '2003-06-10 09:00Z');
select pg_temp.msg('CB', 'e1100000-0000-4000-8000-00000000000a', 'booking_confirmed', pg_temp.id('AB'), pg_temp.id('C1'),
                   '+306912300001', null, '2003-06-10 10:00Z', '2003-06-10 09:00Z');
select set_config('t.p5a', pg_temp.claim('p5a', array['RB', 'CB'], '2003-06-10 10:00Z'), true);
update public.businesses set sms_monthly_budget_cents = null where id = 'e1100000-0000-4000-8000-00000000000a';
select pg_temp.msg('RB2', 'e1100000-0000-4000-8000-00000000000a', 'reminder', pg_temp.id('AB'), pg_temp.id('C1'),
                   '+306912300001', null, '2003-06-10 10:00Z', '2003-06-10 09:00Z');
select set_config('t.p5b', pg_temp.claim('p5b', array['RB2'], '2003-06-10 10:01Z'), true);

select is(
  concat_ws(' ', current_setting('t.p5a'), pg_temp.st('RB'), current_setting('t.p5b')),
  'CB cancelled:budget_exceeded RB2',
  'monthly budget: spent this UTC month + one SMS over the budget → the reminder is budget_exceeded, the confirmation '
  || 'still goes; without a budget the reminder goes'
);

-- ---------------------------------------------------------------------------------------------
-- Q. The nudge (§2.5): after commit, once per transaction, only from non-client flows, never an
--    error. The flag anaklo.dispatch_nudged is reset where a case needs a fresh transaction.
-- ---------------------------------------------------------------------------------------------
select is(
  concat_ws(' ',
    pg_temp.call('bk31', pg_temp.id('UM1'), pg_temp.q_book('SM1', pg_temp.lt(16, '12:00'), 'C1', 'phone')),
    pg_temp.call('bk32', pg_temp.id('UM1'), pg_temp.q_book('SM1', pg_temp.lt(16, '14:00'), 'C2', 'phone'))),
  'ok ok',
  'nudge: two phone appointments of a staff member'
);
select pg_temp.lab_booked('A31', 'bk31');
select pg_temp.lab_booked('A32', 'bk32');

select set_config('anaklo.dispatch_nudged', '', true);
select set_config('t.q0', pg_temp.nudges()::text, true);
select pg_temp.quiet(set_config('t.q1', pg_temp.call('ca31', pg_temp.id('UM1'), pg_temp.q_cancel('A31', 'booked', 'other', true)), true));

select is(
  concat_ws(' ', current_setting('t.q1'), pg_temp.nudges() - current_setting('t.q0')::bigint, pg_temp.last_nudge()),
  'ok 1 t t nudge',
  'nudge: a staff cancel with notify queues exactly one pg_net request to dispatch_url with the secret header (source nudge)'
);

select set_config('t.q2', pg_temp.nudges()::text, true);
select pg_temp.quiet(set_config('t.q3', pg_temp.call('ca32', pg_temp.id('UM1'), pg_temp.q_cancel('A32', 'booked', 'other', true)), true));

select is(
  concat_ws(' ', current_setting('t.q3'), pg_temp.nudges() = current_setting('t.q2')::bigint,
    (select count(*) from public.messages_log m where m.appointment_id = pg_temp.id('A32') and m.template = 'cancelled_by_business')),
  'ok t 1',
  'nudge: a second planner call that queues due rows in the same transaction adds no second request'
);

select set_config('anaklo.dispatch_nudged', '', true);
select set_config('t.q4', pg_temp.nudges()::text, true);
select pg_temp.mk('A33', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C2'), pg_temp.id('SM2'), pg_temp.lt(16, '16:00'), 'online');

select pg_temp.quiet(set_config('t.q4a', pg_temp.plan(pg_temp.id('A33'), 'created', 'client'), true));
select pg_temp.quiet(set_config('t.q4b', pg_temp.ccancel('A33'), true));

select is(
  concat_ws(' ', current_setting('t.q4a'), current_setting('t.q4b'),
    pg_temp.nudges() - current_setting('t.q4')::bigint,
    exists (select 1 from public.messages_log m where m.appointment_id = pg_temp.id('A33')
            and m.template = 'cancelled_by_client' and m.status = 'queued' and m.scheduled_for <= now())),
  'ok ok 0 t',
  'nudge: client flows (booking, cancel) queue due rows but never nudge (their Edge Function sends them)'
);

select set_config('anaklo.dispatch_nudged', '', true);
select pg_temp.set_vault('dispatch_url', 'http://127.0.0.1:9/pgtap-nudge', 'pgtap_12_moved_dispatch_url');
select set_config('t.q5', pg_temp.nudges()::text, true);
select pg_temp.mk('A34', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM1'), pg_temp.lt(17, '12:00'), 'phone');
select pg_temp.quiet(set_config('t.q5c', pg_temp.call('ca34', pg_temp.id('UM1'), pg_temp.q_cancel('A34', 'booked', 'other', true)), true));
select set_config('t.q5n', private.nudge_dispatch('nudge')::text, true);

select is(
  concat_ws(' ', current_setting('t.q5c'), pg_temp.nudges() - current_setting('t.q5')::bigint, current_setting('t.q5n'),
    (select count(*) from public.messages_log m where m.appointment_id = pg_temp.id('A34') and m.template = 'cancelled_by_business')),
  'ok 0 false 1',
  'nudge: without dispatch_url in Vault nothing is queued, nudge_dispatch returns false and the staff action still succeeds'
);

select pg_temp.set_vault('pgtap_12_moved_dispatch_url', 'http://127.0.0.1:9/pgtap-nudge', 'dispatch_url');
select set_config('anaklo.dispatch_nudged', '', true);
select set_config('t.q6', pg_temp.nudges()::text, true);
select set_config('t.q6a', private.nudge_dispatch('test')::text, true);
select set_config('t.q6b', private.nudge_dispatch('test')::text, true);

select is(
  concat_ws(' ', current_setting('t.q6a'), current_setting('t.q6b'), pg_temp.nudges() - current_setting('t.q6')::bigint),
  'true true 1',
  'nudge_dispatch: true and one request; a second call in the same transaction is true without a second request'
);

select set_config('anaklo.dispatch_nudged', '', true);
select set_config('t.q7', pg_temp.nudges()::text, true);
select pg_temp.set_vault('dispatch_secret', 'too-short');
select set_config('t.q7a', private.nudge_dispatch('nudge')::text, true);
select pg_temp.set_vault('dispatch_secret', 'pgtap-12-dispatch-secret-not-a-secret-0001');
select pg_temp.set_vault('dispatch_url', 'ftp://example.test/pgtap-nudge');
select set_config('anaklo.dispatch_nudged', '', true);
select set_config('t.q7b', private.nudge_dispatch('nudge')::text, true);
select pg_temp.set_vault('dispatch_url', 'http://127.0.0.1:9/pgtap-nudge');
select set_config('anaklo.dispatch_nudged', '', true);

select is(
  concat_ws(' ', current_setting('t.q7a'), current_setting('t.q7b'), pg_temp.nudges() - current_setting('t.q7')::bigint,
    (select count(*) from net.http_request_queue q where q.url = 'ftp://example.test/pgtap-nudge')),
  'false false 0 0',
  'nudge_dispatch: a secret shorter than 32 characters or a non-http(s) URL → false, nothing queued'
);

-- ---------------------------------------------------------------------------------------------
-- R. request_test_push (§2.10, D15): a member, to all of their own devices, once per minute.
--    TR = 2006-03-07 10:00:10Z (so +30″ is the same minute and +60″ the next).
-- ---------------------------------------------------------------------------------------------
create function pg_temp.q_tp(a_business uuid, a_now timestamptz)
returns text
language sql
as $fn$
  select format('select private.request_test_push_impl(%L, %L)::text', a_business, a_now);
$fn$;

select pg_temp.quiet(set_config('t.r1', pg_temp.call('tp0', pg_temp.id('UM2'), pg_temp.q_tp('e1100000-0000-4000-8000-00000000000a', '2006-03-07 10:00:10Z')), true));

select is(
  concat_ws(' ', current_setting('t.r1'), coalesce(pg_temp.r('tp0') ->> 'message_id', 'null'), pg_temp.r('tp0') ->> 'queued',
            pg_temp.r('tp0') ->> 'replayed', pg_temp.r('tp0') ->> 'reason'),
  'ok null false false no_subscription',
  'test push: a member without any device gets reason no_subscription and nothing is queued'
);

select set_config('anaklo.dispatch_nudged', '', true);
select set_config('t.rq', pg_temp.nudges()::text, true);
select pg_temp.quiet(set_config('t.r2', pg_temp.call('tp1', pg_temp.id('UM1'), pg_temp.q_tp('e1100000-0000-4000-8000-00000000000a', '2006-03-07 10:00:10Z')), true));

select is(
  (select concat_ws(' ', current_setting('t.r2'), pg_temp.r('tp1') ->> 'queued', pg_temp.r('tp1') ->> 'replayed',
                    m.channel, m.template, pg_temp.l(m.recipient_user_id), m.appointment_id is null, m.client_id is null,
                    m.locale, m.scheduled_for = '2006-03-07 10:00:10Z',
                    m.dedupe_key = 'push_test:' || pg_temp.id('UM1')::text || ':'
                                   || floor(extract(epoch from timestamptz '2006-03-07 10:00:10Z') / 60)::bigint::text,
                    m.status, pg_temp.nudges() - current_setting('t.rq')::bigint, pg_temp.last_nudge())
   from public.messages_log m where m.id = (pg_temp.r('tp1') ->> 'message_id')::uuid),
  'ok true false push push_test UM1 t t el t t queued 1 t t test',
  'test push: one push_test row for the caller only (business language, key push_test:<user>:<minute>) and one nudge (source test)'
);

select pg_temp.quiet(set_config('t.r3', pg_temp.call('tp2', pg_temp.id('UM1'), pg_temp.q_tp('e1100000-0000-4000-8000-00000000000a', '2006-03-07 10:00:40Z')), true));

select is(
  concat_ws(' ', current_setting('t.r3'), pg_temp.r('tp2') ->> 'replayed',
    (pg_temp.r('tp2') ->> 'message_id') = (pg_temp.r('tp1') ->> 'message_id'),
    (select count(*) from public.messages_log m
     where m.template = 'push_test' and m.recipient_user_id = pg_temp.id('UM1')
       and m.scheduled_for >= '2006-03-07 10:00:00Z' and m.scheduled_for < '2006-03-07 10:01:00Z')),
  'ok true t 1',
  'test push: a second request within the same minute replays the first row (at most one per user per minute)'
);

select pg_temp.quiet(set_config('t.r4', pg_temp.call('tp3', pg_temp.id('UM1'), pg_temp.q_tp('e1100000-0000-4000-8000-00000000000a', '2006-03-07 10:01:10Z')), true));

select is(
  concat_ws(' ', current_setting('t.r4'), pg_temp.r('tp3') ->> 'replayed', pg_temp.r('tp3') ->> 'queued',
    (pg_temp.r('tp3') ->> 'message_id') <> (pg_temp.r('tp1') ->> 'message_id')),
  'ok false true t',
  'test push: the next minute queues a new one'
);

select is(
  concat_ws(' ',
    pg_temp.call('x', pg_temp.id('UM1'), pg_temp.q_tp('e1100000-0000-4000-8000-00000000000b', '2006-03-07 10:00:10Z')),
    pg_temp.call('x', pg_temp.id('UX'), pg_temp.q_tp('e1100000-0000-4000-8000-00000000000a', '2006-03-07 10:00:10Z'))),
  '42501 42501',
  'test push: a member of another business and a non-member (who has a device) are refused (42501)'
);

select pg_temp.quiet(set_config('t.r6a', pg_temp.call('tp4', pg_temp.id('UN0'), pg_temp.q_tp('e1100000-0000-4000-8000-00000000000b', '2006-03-07 10:00:10Z')), true));
select pg_temp.quiet(set_config('t.r6b', pg_temp.call('tp5', pg_temp.id('UM1'),
  $$select public.request_test_push('e1100000-0000-4000-8000-00000000000a')::text$$), true));

select is(
  concat_ws(' ', current_setting('t.r6a'),
    (select m.locale || ' ' || pg_temp.l(m.recipient_user_id) from public.messages_log m
     where m.id = (pg_temp.r('tp4') ->> 'message_id')::uuid),
    current_setting('t.r6b'), pg_temp.r('tp5') ->> 'queued'),
  'ok en UN0 ok true',
  'test push: the row speaks the business language (en for New York); the public wrapper works for a member'
);

-- ---------------------------------------------------------------------------------------------
-- S. record_dispatch_run (§2.9): the dispatch heartbeat for 1.9.
-- ---------------------------------------------------------------------------------------------
create function pg_temp.rdr(a_started timestamptz, a_ok boolean, a_rows integer, a_error text)
returns text
language plpgsql
as $fn$
begin
  return public.record_dispatch_run(a_started, a_ok, a_rows, a_error)::text;
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

select set_config('t.s1', pg_temp.rdr(now(), true, 3, null), true);

select is(
  (select concat_ws(' ', j.job, j.ok, j.rows_affected, coalesce(j.error, '-'), j.started_at = now())
   from private.job_runs j where j.id = current_setting('t.s1')::bigint),
  'dispatch t 3 - t',
  'record_dispatch_run: one job_runs row for dispatch with its start and rows'
);

select set_config('t.s2', pg_temp.rdr(now() - interval '1 minute', false, 0, 'claim_failed'), true);

select is(
  (select concat_ws(' ', j.job, j.ok, j.rows_affected, j.error) from private.job_runs j where j.id = current_setting('t.s2')::bigint),
  'dispatch f 0 claim_failed',
  'record_dispatch_run: a failed run is recorded with its error code'
);

select is(
  concat_ws(' ', pg_temp.rdr(null, true, 0, null), pg_temp.rdr(now() - interval '16 minutes', true, 0, null),
            pg_temp.rdr(now() + interval '2 minutes', true, 0, null), pg_temp.rdr(now(), null, 0, null),
            pg_temp.rdr(now(), true, -1, null)),
  '22023 22023 22023 22023 22023',
  'record_dispatch_run: a missing or implausible start (> 15′ ago, > 1′ ahead), a null ok or negative rows → 22023'
);

-- ---------------------------------------------------------------------------------------------
-- T. Nightly purge (§2.11), TPG = 2001-01-20 00:00Z: every retention boundary one second either
--    side (12 months = 2000-01-20 00:00Z, 30 days = 2000-12-21 00:00Z, 2 days = 2001-01-18 00:00Z).
-- ---------------------------------------------------------------------------------------------
select pg_temp.msg('MP1', 'e1100000-0000-4000-8000-00000000000a', 'cancelled_by_business', null, pg_temp.id('C2'), '+306912300002',
                   null, '2000-01-19 23:59:59Z', '2000-01-19 23:59:59Z', 'sent');
select pg_temp.msg('MP2', 'e1100000-0000-4000-8000-00000000000a', 'cancelled_by_business', null, pg_temp.id('C2'), '+306912300002',
                   null, '2000-01-20 00:00:01Z', '2000-01-20 00:00:01Z', 'sent');
-- Created 12 months + 1 s ago, but younger by another instant, or not finished:
--   MP4 a reminder still queued for an appointment booked more than a year ahead (ATQ);
--   MP5 sent 7 months ago (a revived reminder keeps its created_at);
--   MP6 cancelled, scheduled one second inside the 12 months;
--   MP7 cancelled, every instant 12 months + 1 s ago (goes, like MP1);
--   MP8 a confirmation still queued, every instant 12 months + 1 s ago (never sent: not finished).
select pg_temp.mk('ATQ', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C2'), pg_temp.id('SM3'), '2001-02-02 10:00Z', 'phone');
select pg_temp.msg('MP4', 'e1100000-0000-4000-8000-00000000000a', 'reminder', pg_temp.id('ATQ'), pg_temp.id('C2'), '+306912300002',
                   null, '2001-02-01 10:00Z', '2000-01-19 23:59:59Z', 'queued');
select pg_temp.msg('MP5', 'e1100000-0000-4000-8000-00000000000a', 'reminder', pg_temp.id('ATQ'), pg_temp.id('C2'), '+306912300002',
                   null, '2000-01-19 23:59:59Z', '2000-01-19 23:59:59Z', 'sent');
update public.messages_log set sent_at = '2000-06-01 10:00Z' where id = pg_temp.id('MP5');
select pg_temp.msg('MP6', 'e1100000-0000-4000-8000-00000000000a', 'cancelled_by_business', null, pg_temp.id('C2'), '+306912300002',
                   null, '2000-01-20 00:00:01Z', '2000-01-19 23:59:59Z', 'cancelled');
select pg_temp.msg('MP7', 'e1100000-0000-4000-8000-00000000000a', 'cancelled_by_business', null, pg_temp.id('C2'), '+306912300002',
                   null, '2000-01-19 23:59:59Z', '2000-01-19 23:59:59Z', 'cancelled');
select pg_temp.msg('MP8', 'e1100000-0000-4000-8000-00000000000a', 'booking_confirmed', pg_temp.id('ATQ'), pg_temp.id('C2'), '+306912300002',
                   null, '2000-01-19 23:59:59Z', '2000-01-19 23:59:59Z', 'queued');

-- pg_cron's own history: 7 days = 2001-01-13 00:00Z (negative run ids: never a real run's).
insert into cron.job_run_details (jobid, runid, command, status, start_time, end_time) values
  (-12, -12001, 'pgtap 12 purge boundary', 'succeeded', '2001-01-12 23:59:58Z', '2001-01-12 23:59:59Z'),
  (-12, -12002, 'pgtap 12 purge boundary', 'succeeded', '2001-01-13 00:00:00Z', '2001-01-13 00:00:01Z');
select pg_temp.otp('OP1', '+306912300009', '2000-12-20 23:54:59Z', '2000-12-20 23:59:59Z', 'sent', '2000-12-20 23:54:59Z');
select pg_temp.otp('OP2', '+306912300009', '2000-12-20 23:55:01Z', '2000-12-21 00:00:01Z', 'sent', '2000-12-20 23:55:01Z');
insert into public.otp_challenges (id, business_id, phone_hmac, code_hmac, expires_at, verified_at, grant_hash, grant_expires_at, created_at)
values (pg_temp.lab('OP3', gen_random_uuid()), 'e1100000-0000-4000-8000-00000000000a', repeat('a', 64), repeat('b', 64),
        '2000-10-01 10:05Z', '2000-10-01 10:01Z', repeat('c', 64), '2000-12-21 00:00:01Z', '2000-10-01 10:00Z');

insert into public.trusted_devices (id, business_id, phone_hmac, token_hash, created_at, expires_at, revoked_at) values
  (pg_temp.lab('TD1', gen_random_uuid()), 'e1100000-0000-4000-8000-00000000000a', repeat('d', 64),
   md5('pgtap12-td1') || md5('pgtap12-td1x'), '2000-06-01Z', '2000-12-20 23:59:59Z', null),
  (pg_temp.lab('TD2', gen_random_uuid()), 'e1100000-0000-4000-8000-00000000000a', repeat('d', 64),
   md5('pgtap12-td2') || md5('pgtap12-td2x'), '2000-06-01Z', '2001-06-01Z', '2000-12-20 23:59:59Z'),
  (pg_temp.lab('TD3', gen_random_uuid()), 'e1100000-0000-4000-8000-00000000000a', repeat('d', 64),
   md5('pgtap12-td3') || md5('pgtap12-td3x'), '2000-06-01Z', '2000-12-21 00:00:01Z', null);

-- AT ended 2000-10-01 (+30 days long before the boundary); AT2 ends so that its end + 30 days is
-- one second after the boundary.
select pg_temp.mk('AT', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM3'), '2000-10-01 10:00Z', 'phone', 'completed');
select pg_temp.mk('AT2', 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('C1'), pg_temp.id('SM3'), '2000-11-20 23:30:01Z', 'phone', 'completed');
insert into public.booking_tokens (id, business_id, appointment_id, token_hash, issued_for, created_at, expires_at) values
  (pg_temp.lab('BT1', gen_random_uuid()), 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('AT'),
   md5('pgtap12-bt1') || md5('pgtap12-bt1x'), 'message', '2000-09-01Z', '2001-12-01Z'),
  (pg_temp.lab('BT2', gen_random_uuid()), 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('AT2'),
   md5('pgtap12-bt2') || md5('pgtap12-bt2x'), 'booking', '2000-09-01Z', '2001-12-01Z'),
  (pg_temp.lab('BT3', gen_random_uuid()), 'e1100000-0000-4000-8000-00000000000a', pg_temp.id('AT2'),
   md5('pgtap12-bt3') || md5('pgtap12-bt3x'), 'booking', '2000-09-01Z', '2000-12-20 23:59:59Z');
select pg_temp.msg('MP3', 'e1100000-0000-4000-8000-00000000000a', 'booking_confirmed', pg_temp.id('AT'), pg_temp.id('C1'), '+306912300001',
                   null, '2001-01-10 00:00Z', '2001-01-10 00:00Z', 'sent');
update public.messages_log set booking_token_id = pg_temp.id('BT1') where id = pg_temp.id('MP3');

select pg_temp.set_counter(x.bucket, x.key, x.win, 1)
from (values
  ('sms_business_day', 'pgtap12-rl1', timestamptz '2001-01-17 23:59:59Z'),
  ('sms_business_day', 'pgtap12-rl2', timestamptz '2001-01-18 00:00:01Z'),
  ('sms_platform_month', 'pgtap12-m', timestamptz '2000-11-01 00:00Z'),
  ('sms_platform_month', 'pgtap12-m', timestamptz '2000-12-01 00:00Z'),
  ('sms_platform_month', 'pgtap12-m', timestamptz '2001-01-01 00:00Z')
) as x (bucket, key, win);

with x as (
  insert into private.job_runs (job, started_at, finished_at, ok, rows_affected)
  values ('auto_complete', '2000-12-20 23:59:58Z', '2000-12-20 23:59:59Z', true, 0)
  returning id
)
select set_config('t.jr1', (select x.id::text from x), true);

with x as (
  insert into private.job_runs (job, started_at, finished_at, ok, rows_affected)
  values ('auto_complete', '2000-12-21 00:00:00Z', '2000-12-21 00:00:01Z', true, 0)
  returning id
)
select set_config('t.jr2', (select x.id::text from x), true);

insert into private.move_requests (business_id, idempotency_key, appointment_id, request_hash, result, created_at) values
  ('e1100000-0000-4000-8000-00000000000a', pg_temp.lab('MR1', gen_random_uuid()), pg_temp.id('AT'), repeat('e', 64), '{}',
   '2000-12-20 23:59:59Z'),
  ('e1100000-0000-4000-8000-00000000000a', pg_temp.lab('MR2', gen_random_uuid()), pg_temp.id('AT'), repeat('e', 64), '{}',
   '2000-12-21 00:00:01Z');

select set_config('t.pg_from', clock_timestamp()::text, true);
select set_config('t.pg', coalesce(private.purge_impl('2001-01-20 00:00Z')::text, 'null'), true);
select set_config('t.pg_to', clock_timestamp()::text, true);

create function pg_temp.has_row(a_table regclass, a_label text)
returns boolean
language plpgsql
stable
as $fn$
declare
  v boolean;
begin
  execute format('select exists (select 1 from %s x where x.id = $1)', a_table) into v using pg_temp.id(a_label);
  return v;
end;
$fn$;

select is(
  concat_ws(' ', pg_temp.has_row('public.messages_log', 'MP1'), pg_temp.has_row('public.messages_log', 'MP2')),
  'f t',
  'purge: messages_log older than 12 months goes, one second younger stays'
);

select is(
  concat_ws(' ', pg_temp.has_row('public.messages_log', 'MP4'), pg_temp.has_row('public.messages_log', 'MP5'),
            pg_temp.has_row('public.messages_log', 'MP6'), pg_temp.has_row('public.messages_log', 'MP7'),
            pg_temp.has_row('public.messages_log', 'MP8'), pg_temp.st('MP4', 'MP8')),
  't t t f t queued queued',
  'purge: 12 months count from the row''s last instant (scheduled, sent), and a row still queued is never purged '
  || '(a reminder booked more than a year ahead keeps its created_at; an unsent confirmation waits for the operator)'
);

select is(
  concat_ws(' ',
    exists (select 1 from cron.job_run_details d where d.runid = -12001),
    exists (select 1 from cron.job_run_details d where d.runid = -12002)),
  'f t',
  'purge: pg_cron''s job_run_details older than 7 days go; one second younger stays'
);

select is(
  concat_ws(' ', pg_temp.has_row('public.messages_log', 'OP1'), pg_temp.has_row('public.otp_challenges', 'OP1.challenge'),
            pg_temp.has_row('public.messages_log', 'OP2'), pg_temp.has_row('public.otp_challenges', 'OP2.challenge'),
            pg_temp.has_row('public.otp_challenges', 'OP3')),
  'f f t t t',
  'purge: an OTP challenge 30 days after its expiry goes with its message; one second less stays; a later grant expiry counts'
);

select is(
  concat_ws(' ', pg_temp.has_row('public.trusted_devices', 'TD1'), pg_temp.has_row('public.trusted_devices', 'TD2'),
            pg_temp.has_row('public.trusted_devices', 'TD3')),
  'f f t',
  'purge: trusted devices 30 days after expiry or revocation go; one second less stays'
);

select is(
  concat_ws(' ', pg_temp.has_row('public.booking_tokens', 'BT1'), pg_temp.has_row('public.booking_tokens', 'BT3'),
            pg_temp.has_row('public.booking_tokens', 'BT2'), pg_temp.has_row('public.messages_log', 'MP3'),
            (select m.booking_token_id is null from public.messages_log m where m.id = pg_temp.id('MP3'))),
  'f f t t t',
  'purge: tokens 30 days past their effective end (appointment end + 30 days, expiry) go, the message keeps its row '
  || 'without the token id; one second less stays'
);

select is(
  concat_ws(' ',
    pg_temp.counter('sms_business_day', 'pgtap12-rl1', '2001-01-17 23:59:59Z') > 0,
    pg_temp.counter('sms_business_day', 'pgtap12-rl2', '2001-01-18 00:00:01Z') > 0,
    pg_temp.counter('sms_platform_month', 'pgtap12-m', '2000-11-01 00:00Z') > 0,
    pg_temp.counter('sms_platform_month', 'pgtap12-m', '2000-12-01 00:00Z') > 0,
    pg_temp.counter('sms_platform_month', 'pgtap12-m', '2001-01-01 00:00Z') > 0),
  'f t f t t',
  'purge: rate_limits older than 2 days go, except the month counters of this and the previous month'
);

select is(
  concat_ws(' ',
    exists (select 1 from private.job_runs j where j.id = current_setting('t.jr1')::bigint),
    exists (select 1 from private.job_runs j where j.id = current_setting('t.jr2')::bigint),
    exists (select 1 from private.move_requests r where r.idempotency_key = pg_temp.id('MR1')),
    exists (select 1 from private.move_requests r where r.idempotency_key = pg_temp.id('MR2'))),
  'f t f t',
  'purge: job_runs and move_requests older than 30 days go; one second younger stay'
);

select is(
  pg_temp.runs(current_setting('t.pg_from'), current_setting('t.pg_to')),
  'purge true ' || current_setting('t.pg') || ' -',
  'purge: one job run (ok, rows_affected = the returned count)'
);

-- A second purge at the same clock finds only one more old run detail: the deleted cron rows are
-- counted in the answer and in rows_affected.
insert into cron.job_run_details (jobid, runid, command, status, start_time, end_time)
values (-12, -12003, 'pgtap 12 purge boundary', 'succeeded', '2001-01-12 23:59:58Z', '2001-01-12 23:59:59Z');
select set_config('t.pg2_from', clock_timestamp()::text, true);
select set_config('t.pg2', coalesce(private.purge_impl('2001-01-20 00:00Z')::text, 'null'), true);
select set_config('t.pg2_to', clock_timestamp()::text, true);

select is(
  concat_ws(' ', current_setting('t.pg2'), pg_temp.runs(current_setting('t.pg2_from'), current_setting('t.pg2_to')),
            exists (select 1 from cron.job_run_details d where d.runid = -12003)),
  '1 purge true 1 - f',
  'purge: a deleted job_run_details row is counted in the returned total and in rows_affected'
);

-- ---------------------------------------------------------------------------------------------
-- U. The cron jobs (upsert by name, rebuilt on every reset).
-- ---------------------------------------------------------------------------------------------
select is(
  (select string_agg(j.jobname || ' | ' || j.schedule || ' | '
                     || (j.command ~ ('private\.' || case j.jobname when 'dispatch-sweep' then 'dispatch_sweep_impl'
                                                                    else 'purge_impl' end || '\(\)'))::text,
                     ', ' order by j.jobname)
   from cron.job j where j.jobname in ('dispatch-sweep', 'nightly-purge')),
  'dispatch-sweep | */5 * * * * | true, nightly-purge | 17 1 * * * | true',
  'cron: dispatch-sweep every 5 minutes and nightly-purge at 01:17 UTC'
);

-- ---------------------------------------------------------------------------------------------
-- V. The API roles reach none of the sending machinery.
-- ---------------------------------------------------------------------------------------------
select is(
  (select concat_ws(' ', count(distinct n.nspname || '.' || p.proname),
            coalesce(string_agg(distinct r.role_name || ' ' || n.nspname || '.' || p.proname, ', ')
                     filter (where has_function_privilege(r.role_name, p.oid, 'execute')), 'none'))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   cross join unnest(array['anon', 'authenticated']) as r (role_name)
   where (n.nspname, p.proname) in (
     ('private', 'claim_messages_impl'), ('private', 'claim_due_messages_impl'), ('public', 'claim_messages'),
     ('public', 'claim_due_messages'), ('private', 'record_send_result_impl'), ('public', 'record_send_result'),
     ('private', 'record_delivery_report_impl'), ('public', 'record_delivery_report'),
     ('private', 'record_dispatch_run_impl'), ('public', 'record_dispatch_run'), ('private', 'dispatch_sweep_impl'),
     ('private', 'purge_impl'), ('private', 'nudge_dispatch'), ('private', 'claim_core'), ('private', 'plan_messages_impl'),
     ('private', 'reminder_at'), ('private', 'drop_push_subscriptions'), ('private', 'push_recipients'),
     ('private', 'business_members_drop_push'), ('private', 'vault_value_or_null'), ('private', 'sms_reachable'))),
  '21 none',
  'API roles: anon and authenticated may execute none of the claim, record, sweep, purge, nudge, planner or push helpers'
);

select is(
  concat_ws(' ',
    pg_temp.as_role('anon', 'select count(*)::text from public.messages_log'),
    pg_temp.as_role('authenticated', 'select count(*)::text from public.messages_log', pg_temp.jwt(pg_temp.id('UM0'))),
    pg_temp.as_role('service_role', 'select count(*)::text from public.messages_log'),
    pg_temp.as_role('authenticated', 'select count(*)::text from public.suppression_list', pg_temp.jwt(pg_temp.id('UM0'))),
    pg_temp.as_role('authenticated', 'select count(*)::text from public.rate_limits', pg_temp.jwt(pg_temp.id('UM0')))),
  '42501 42501 42501 42501 42501',
  'API roles: the outbox, the suppression list and the counters are not readable by any API role (RPCs only)'
);

select is(
  concat_ws(' ',
    pg_temp.as_role('authenticated', 'select public.claim_due_messages(5)::text', pg_temp.jwt(pg_temp.id('UM0'))),
    pg_temp.as_role('authenticated', 'select public.record_dispatch_run(now(), true, 0, null)::text', pg_temp.jwt(pg_temp.id('UM0'))),
    pg_temp.as_role('authenticated', 'select private.dispatch_sweep_impl()::text', pg_temp.jwt(pg_temp.id('UM0'))),
    pg_temp.as_role('anon', $$select public.record_delivery_report('fake', 'x', 'delivered', null, null, null)::text$$)),
  '42501 42501 42501 42501',
  'API roles: even the owner cannot claim, record a run or sweep; anon cannot report deliveries'
);

select * from finish();
rollback;
