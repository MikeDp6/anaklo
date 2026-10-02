-- Schedule operations (phase-1 plan 1.6, contract docs/plans/contracts/1.6-settings-absence.md §2 and
-- §6.2): replace_week_hours, schedule_conflicts, mark_absence, reassign_candidates,
-- reassign_appointment (review fix: the hand-over only while the appointment is where it was seen),
-- save_service, set_staff_order, private.staff_day_opening, the 0008 grants, the cancel/move SMS of the absence
-- flow (SPEC §5 flow 6) and the re-plan of queued reminders (D6). Written from the plan and the
-- contract only (independent author).
--   · Fixed instants (far-future local dates, explicit p_from/p_to) wherever the code takes its range
--     from the arguments; fixtures relative to now() where it reads now() (conflict_count of
--     replace_week_hours, the default range of schedule_conflicts, notify of cancel/move, the re-plan
--     trigger). replan_reminders_impl is called with a fixed p_now.
--   · Every member step goes through pg_temp.as_role: no declared actor ('' → staff from the JWT),
--     then back to 'system' with the claims cleared. Values are passed to the RPCs as literals, so
--     no pg_temp function runs as an API role.
--   Businesses (Europe/Athens unless noted):
--     H 'sched-ops-hours'        replace_week_hours: HS0 (owner UH0, no hours), HS1 (staff UH1), manager UHM
--     C 'sched-ops-conflicts'    staff_day_opening, schedule_conflicts, mark_absence: CA, CB (staff UCB),
--                                CI inactive; owner UC0, manager UCM
--     N 'sched-ops-newyork'      America/New_York, its DST day 2026-11-01: N1, owner UN0
--     A 'sched-ops-absence'      flow 6 against now(): AA (absent), AB, AC; owner UA0
--     K 'sched-ops-reassign'     reassign_candidates, reassign_appointment: KA (staff UKA) … KF, KI
--                                inactive; owner UK0,
--                                manager UKM, staff UKB (KB)
--     V 'sched-ops-catalogue'    save_service, set_staff_order, grants: V1 (owner UV0), V2 (staff UV1),
--                                V3, V4 inactive; manager UVM; categories VC1, VC2
--     P 'sched-ops-replan'       the re-plan trigger against now(): owner UP0
--     Q 'sched-ops-replan-fixed' replan_reminders_impl at a fixed p_now; quiet hours 12:00–18:00
--     X 'sched-ops-other'        foreign ids; a queued reminder that must never move: owner UX0
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
-- Fixtures are written by the system. Member steps clear the actor (a declared 'system' would
-- outrank the JWT) and every helper resets it to 'system' afterwards.
select set_config('anaklo.actor_type', 'system', true);
select plan(154);

-- ---------------------------------------------------------------------------------------------
-- Helpers (pg_temp). Answers of calls are kept in transaction-local settings 't.<name>'.
-- ---------------------------------------------------------------------------------------------
create temporary table lbl (id uuid primary key, label text not null unique);

create function pg_temp.l(a_id uuid)
returns text
language sql
stable
as $fn$
  select case when a_id is null then '-'
              else coalesce((select x.label from pg_temp.lbl x where x.id = a_id), a_id::text) end;
$fn$;

create function pg_temp.r(a_name text)
returns jsonb
language sql
stable
as $fn$
  select nullif(current_setting('t.' || a_name, true), '')::jsonb;
$fn$;

create function pg_temp.keys(a_object jsonb)
returns text[]
language sql
immutable
as $fn$
  select array_agg(k order by k collate "C") from jsonb_object_keys(a_object) as k;
$fn$;

create function pg_temp.err(a_state text, a_message text)
returns text
language sql
immutable
as $fn$
  select case when a_state = 'P0001' then 'P0001 ' || a_message else a_state end;
$fn$;

create function pg_temp.jwt(a_user uuid)
returns text
language sql
immutable
as $fn$
  select json_build_object('sub', a_user, 'role', 'authenticated', 'aal', 'aal1')::text;
$fn$;

-- One statement as an API role (a_user null = no claims): its single value as text, '<null>', or
-- the error ('<sqlstate>', or 'P0001 <code>' for a domain error). No declared actor while it runs.
create function pg_temp.as_role(a_role text, a_user uuid, a_sql text)
returns text
language plpgsql
as $fn$
declare
  v text;
begin
  perform set_config('anaklo.actor_type', '', true);
  begin
    perform set_config('request.jwt.claims', case when a_user is null then '' else pg_temp.jwt(a_user) end, true);
    execute format('set local role %I', a_role);
    execute a_sql into v;
    v := coalesce(v, '<null>');
  exception when others then
    v := pg_temp.err(sqlstate, sqlerrm);
  end;
  execute 'set local role postgres';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('anaklo.actor_type', 'system', true);
  perform set_config('anaklo.notify_client', '', true);
  return v;
end;
$fn$;

-- Keeps a value in t.<a_name> and prints nothing (a bare 'ok' line would be read as a TAP result).
-- A write and the read of its effect must be separate statements: a query does not see what a
-- volatile function it called wrote (its snapshot is older).
create function pg_temp.keep(a_name text, a_value text)
returns void
language plpgsql
as $fn$
begin
  perform set_config('t.' || a_name, coalesce(a_value, '<null>'), true);
end;
$fn$;

-- A member's RPC whose JSON answer is kept in t.<a_name>: 'ok' or the error.
create function pg_temp.call(a_name text, a_user uuid, a_sql text)
returns text
language plpgsql
as $fn$
declare
  v text := pg_temp.as_role('authenticated', a_user, a_sql);
begin
  if left(v, 1) in ('{', '[') then
    perform set_config('t.' || a_name, v, true);
    return 'ok';
  end if;
  return v;
end;
$fn$;

-- SQL literals.
create function pg_temp.qu(a uuid)
returns text
language sql
immutable
as $fn$
  select coalesce(quote_literal(a::text) || '::uuid', 'null::uuid');
$fn$;

create function pg_temp.qt(a timestamptz)
returns text
language sql
stable
as $fn$
  select coalesce(quote_literal(a::text) || '::timestamptz', 'null::timestamptz');
$fn$;

create function pg_temp.qj(a jsonb)
returns text
language sql
immutable
as $fn$
  select coalesce(quote_literal(a::text) || '::jsonb', 'null::jsonb');
$fn$;

-- A table-returning RPC as one JSON array, in the order the function returns its rows.
create function pg_temp.tab(a_call text)
returns text
language sql
immutable
as $fn$
  select format('select coalesce(jsonb_agg(to_jsonb(t) - %L order by t.ordinality), %L::jsonb)::text from %s with ordinality as t',
                'ordinality', '[]', a_call);
$fn$;

-- Instants: a fixed local wall-clock time, or one a_days after today's local date.
create function pg_temp.ft(a_date date, a_time time, a_tz text default 'Europe/Athens')
returns timestamptz
language sql
stable
as $fn$
  select (a_date + a_time) at time zone a_tz;
$fn$;

create function pg_temp.lt(a_days integer, a_time time, a_tz text default 'Europe/Athens')
returns timestamptz
language sql
stable
as $fn$
  select (((now() at time zone a_tz)::date + a_days) + a_time) at time zone a_tz;
$fn$;

-- 'MM-DD HH24:MI' local.
create function pg_temp.lh(a_at timestamptz, a_tz text default 'Europe/Athens')
returns text
language sql
stable
as $fn$
  select to_char(a_at at time zone a_tz, 'MM-DD HH24:MI');
$fn$;

-- Conflict rows (a JSON array of §2.5.2 objects): '<appointment> <reasons>' in the returned order.
create function pg_temp.conf(a_rows jsonb)
returns text
language sql
stable
as $fn$
  select case when a_rows is null then '<no answer>' else coalesce((
    select string_agg(
             pg_temp.l((c ->> 'appointment_id')::uuid) || ' '
             || coalesce((select string_agg(x.v, ',' order by x.o)
                          from jsonb_array_elements_text(c -> 'reasons') with ordinality as x (v, o)), '-'),
             ', ' order by e.n)
    from jsonb_array_elements(a_rows) with ordinality as e (c, n)), '-') end;
$fn$;

-- Candidate rows (§2.5.4): '<staff> <free> <blocker>' in the returned order.
create function pg_temp.cand(a_rows jsonb)
returns text
language sql
stable
as $fn$
  select case when a_rows is null then '<no answer>' else coalesce((
    select string_agg(pg_temp.l((c ->> 'staff_id')::uuid) || ' ' || coalesce(c ->> 'free', '<null>') || ' '
                      || coalesce(c ->> 'blocker', '-'), ', ' order by e.n)
    from jsonb_array_elements(a_rows) with ordinality as e (c, n)), '-') end;
$fn$;

-- replace_week_hours' rows: '<weekday> HH:MM-HH:MM' in the returned order.
create function pg_temp.wrows(a_rows jsonb)
returns text
language sql
stable
as $fn$
  select case when a_rows is null then '<no answer>' else coalesce((
    select string_agg((w ->> 'weekday') || ' ' || (w ->> 'start_time') || '-' || (w ->> 'end_time'), ', ' order by e.n)
    from jsonb_array_elements(a_rows) with ordinality as e (w, n)), '-') end;
$fn$;

-- Stored weekly hours of a staff member, and the ids of those rows.
create function pg_temp.wh(a_staff uuid)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(w.weekday || ' ' || left(w.start_time::text, 5) || '-' || left(w.end_time::text, 5),
                             ', ' order by w.weekday, w.start_time), '-')
  from public.working_hours w where w.staff_id = a_staff;
$fn$;

create function pg_temp.whl(a_staff uuid)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(pg_temp.l(w.id), ', ' order by w.weekday, w.start_time), '-')
  from public.working_hours w where w.staff_id = a_staff;
$fn$;

-- Stored time off of a staff member overlapping [a_from, a_to).
create function pg_temp.toff(a_staff uuid, a_from timestamptz, a_to timestamptz)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(pg_temp.l(t.id) || ' ' || t.reason || ' ' || pg_temp.lh(t.starts_at) || '-' || pg_temp.lh(t.ends_at),
                             ', ' order by t.starts_at, t.id), '-')
  from public.time_off t where t.staff_id = a_staff and t.starts_at < a_to and t.ends_at > a_from;
$fn$;

-- Offers: of an answer (a JSON array) and as stored; '<staff> <custom duration> <custom price>'.
create function pg_temp.offers(a_rows jsonb)
returns text
language sql
stable
as $fn$
  select case when a_rows is null then '<no answer>' else coalesce((
    select string_agg(pg_temp.l((o ->> 'staff_id')::uuid) || ' ' || coalesce(o ->> 'custom_duration_min', '-') || ' '
                      || coalesce(o ->> 'custom_price_cents', '-'), ', ' order by e.n)
    from jsonb_array_elements(a_rows) with ordinality as e (o, n)), '-') end;
$fn$;

create function pg_temp.offers_of(a_service uuid)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(pg_temp.l(ss.staff_id) || ' ' || coalesce(ss.custom_duration_min::text, '-') || ' '
                             || coalesce(ss.custom_price_cents::text, '-'), ', ' order by st.sort, st.id), '-')
  from public.staff_services ss
  join public.staff st on st.business_id = ss.business_id and st.id = ss.staff_id
  where ss.service_id = a_service;
$fn$;

-- Staff order: of an answer and as stored; '<staff> <sort>'.
create function pg_temp.order_rows(a_rows jsonb)
returns text
language sql
stable
as $fn$
  select case when a_rows is null then '<no answer>' else coalesce((
    select string_agg(pg_temp.l((o ->> 'id')::uuid) || ' ' || (o ->> 'sort'), ', ' order by e.n)
    from jsonb_array_elements(a_rows) with ordinality as e (o, n)), '-') end;
$fn$;

create function pg_temp.sorts(a_business uuid)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(pg_temp.l(s.id) || ' ' || s.sort, ', ' order by s.sort, s.id), '-')
  from public.staff s where s.business_id = a_business;
$fn$;

-- SMS rows of an appointment: '<template> <status> <to>' by creation.
create function pg_temp.sms(a_appointment uuid)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(m.template || ' ' || m.status || ' ' || coalesce(m.to_e164, '-'), ', ' order by m.created_at, m.id), '-')
  from public.messages_log m where m.appointment_id = a_appointment and m.channel = 'sms';
$fn$;

-- Appointments by label: '<label> <status> <staff>'.
create function pg_temp.appts(a_ids uuid[])
returns text
language sql
stable
as $fn$
  select string_agg(pg_temp.l(a.id) || ' ' || a.status || ' ' || pg_temp.l(a.staff_id), ', ' order by pg_temp.l(a.id) collate "C")
  from public.appointments a where a.id = any (a_ids);
$fn$;

-- private.staff_day_opening(a_business, a_staff, a_date): '<rows> <scope> <closed> <windows = a_expected>'
-- (booleans as concat_ws prints them: t/f), or the error.
create function pg_temp.opening(a_business uuid, a_staff uuid, a_date date, a_expected tstzmultirange)
returns text
language plpgsql
as $fn$
declare
  v text;
begin
  select concat_ws(' ', count(*), min(o.scope), bool_and(o.closed), bool_and(o.windows = a_expected))
    into v
  from private.staff_day_opening(a_business, a_staff, a_date) as o;
  return v;
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- private.replan_reminders_impl at a fixed clock: the count, or the error.
create function pg_temp.replan(a_business uuid, a_now timestamptz)
returns text
language plpgsql
as $fn$
begin
  return private.replan_reminders_impl(a_business, a_now)::text;
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- The 1.6 RPCs as a member ('ok' with the answer in t.<a_name>, or the error).
create function pg_temp.rwh(a_name text, a_user uuid, a_business uuid, a_staff uuid, a_rows_sql text)
returns text
language sql
as $fn$
  select pg_temp.call(a_name, a_user, format('select public.replace_week_hours(%s, %s, %s)::text',
                                             pg_temp.qu(a_business), pg_temp.qu(a_staff), a_rows_sql));
$fn$;

create function pg_temp.mab(a_name text, a_user uuid, a_business uuid, a_staff uuid, a_from timestamptz, a_to timestamptz)
returns text
language sql
as $fn$
  select pg_temp.call(a_name, a_user, format('select public.mark_absence(%s, %s, %s, %s)::text',
                                             pg_temp.qu(a_business), pg_temp.qu(a_staff), pg_temp.qt(a_from), pg_temp.qt(a_to)));
$fn$;

-- schedule_conflicts: the conflict summary, or the error.
create function pg_temp.scf(a_name text, a_user uuid, a_business uuid, a_staff uuid, a_from timestamptz, a_to timestamptz)
returns text
language plpgsql
as $fn$
declare
  v text;
begin
  v := pg_temp.call(a_name, a_user, pg_temp.tab(format('public.schedule_conflicts(%s, %s, %s, %s)',
                                                       pg_temp.qu(a_business), pg_temp.qu(a_staff),
                                                       pg_temp.qt(a_from), pg_temp.qt(a_to))));
  if v = 'ok' then
    return pg_temp.conf(pg_temp.r(a_name));
  end if;
  return v;
end;
$fn$;

-- reassign_candidates: the candidate summary, or the error.
create function pg_temp.rca(a_name text, a_user uuid, a_business uuid, a_appointment uuid)
returns text
language plpgsql
as $fn$
declare
  v text;
begin
  v := pg_temp.call(a_name, a_user, pg_temp.tab(format('public.reassign_candidates(%s, %s)',
                                                       pg_temp.qu(a_business), pg_temp.qu(a_appointment))));
  if v = 'ok' then
    return pg_temp.cand(pg_temp.r(a_name));
  end if;
  return v;
end;
$fn$;

-- save_service on business V.
create function pg_temp.sav(a_name text, a_user uuid, a_id uuid, a_service jsonb, a_offers jsonb)
returns text
language sql
as $fn$
  select pg_temp.call(a_name, a_user, format('select public.save_service(%s, %s, %s, %s)::text',
                                             pg_temp.qu('13b00000-0000-4000-8000-000000000006'), pg_temp.qu(a_id),
                                             pg_temp.qj(a_service), pg_temp.qj(a_offers)));
$fn$;

-- A valid p_service of business V («Ξύρισμα» 25′ + 5′, 11.00, category VC1), with overrides and
-- one key removed.
create function pg_temp.svc(a_override jsonb default '{}', a_remove text default null)
returns jsonb
language sql
immutable
as $fn$
  select (jsonb_build_object('name', 'Ξύρισμα', 'category_id', '13f00000-0000-4000-8000-000000000060',
                             'duration_min', 25, 'buffer_after_min', 5, 'price_cents', 1100,
                             'online_bookable', true, 'active', true) || a_override)
         - coalesce(a_remove, '');
$fn$;

-- set_staff_order on business V.
create function pg_temp.sso(a_name text, a_user uuid, a_ids uuid[])
returns text
language sql
as $fn$
  select pg_temp.call(a_name, a_user, format('select public.set_staff_order(%s, %s)::text',
                                             pg_temp.qu('13b00000-0000-4000-8000-000000000006'),
                                             coalesce(quote_literal(a_ids::text) || '::uuid[]', 'null::uuid[]')));
$fn$;

-- staff_move_appointment (fresh attempt key) and cancel_appointment (from booked, staff_unavailable).
create function pg_temp.mv(a_name text, a_user uuid, a_business uuid, a_appointment uuid, a_starts timestamptz,
                           a_notify boolean, a_staff uuid)
returns text
language sql
as $fn$
  select pg_temp.call(a_name, a_user, format(
    'select public.staff_move_appointment(p_business_id => %s, p_appointment_id => %s, p_idempotency_key => gen_random_uuid(), '
    || 'p_new_starts_at => %s, p_notify => %s, p_new_staff_id => %s)::text',
    pg_temp.qu(a_business), pg_temp.qu(a_appointment), pg_temp.qt(a_starts), a_notify::text, pg_temp.qu(a_staff)));
$fn$;

-- reassign_appointment on business K with a fixed idempotency key.
create function pg_temp.rea(a_name text, a_user uuid, a_appointment uuid, a_key uuid, a_expected_staff uuid,
                            a_expected_starts timestamptz, a_new_staff uuid, a_notify boolean)
returns text
language sql
as $fn$
  select pg_temp.call(a_name, a_user, format(
    'select public.reassign_appointment(%s, %s, %s, %s, %s, %s, %s)::text',
    pg_temp.qu('13b00000-0000-4000-8000-000000000005'), pg_temp.qu(a_appointment), pg_temp.qu(a_key),
    pg_temp.qu(a_expected_staff), pg_temp.qt(a_expected_starts), pg_temp.qu(a_new_staff),
    coalesce(a_notify::text, 'null')));
$fn$;

create function pg_temp.cn(a_name text, a_user uuid, a_business uuid, a_appointment uuid, a_notify boolean)
returns text
language sql
as $fn$
  select pg_temp.call(a_name, a_user, format('select public.cancel_appointment(%s, %s, %L, %L, %s)::text',
                                             pg_temp.qu(a_business), pg_temp.qu(a_appointment), 'booked',
                                             'staff_unavailable', a_notify::text));
$fn$;

-- One direct write as an API role: '<rows affected>' or the error.
create function pg_temp.dml(a_role text, a_user uuid, a_statement text)
returns text
language sql
as $fn$
  select pg_temp.as_role(a_role, a_user, format('with x as (%s returning 1) select count(*)::text from x', a_statement));
$fn$;

-- An appointment written directly (as seed.sql does), with one service line.
create function pg_temp.mk(
  a_label text, a_id uuid, a_business uuid, a_staff uuid, a_client uuid, a_service uuid, a_starts timestamptz,
  a_minutes integer, a_status text default 'booked', a_buffer integer default 0, a_source text default 'phone'
)
returns void
language plpgsql
as $fn$
begin
  insert into public.appointments (id, business_id, client_id, staff_id, starts_at, ends_at, buffer_after_min, status,
                                   source, total_cents, cancelled_by, cancel_reason)
  values (a_id, a_business, a_client, a_staff, a_starts, a_starts + make_interval(mins => a_minutes), a_buffer, a_status,
          a_source, 1300, case when a_status = 'cancelled' then 'business' end,
          case when a_status = 'cancelled' then 'other' end);
  insert into public.appointment_services (business_id, appointment_id, position, service_id, price_cents, duration_min)
  values (a_business, a_id, 0, a_service, 1300, a_minutes);
  insert into pg_temp.lbl (id, label) values (a_id, a_label);
end;
$fn$;

-- An SMS row written directly (dedupe 'pgtap13:<label>'); updated_at = created_at.
create function pg_temp.msg(
  a_label text, a_id uuid, a_business uuid, a_appointment uuid, a_client uuid, a_to text, a_template text,
  a_status text, a_attempts integer, a_scheduled timestamptz, a_created timestamptz
)
returns void
language plpgsql
as $fn$
begin
  insert into public.messages_log (id, business_id, client_id, appointment_id, dedupe_key, channel, to_e164, locale,
                                   template, category, status, attempts, scheduled_for, created_at, updated_at)
  values (a_id, a_business, a_client, a_appointment, 'pgtap13:' || a_label, 'sms', a_to, 'el', a_template,
          case when a_template = 'reminder' then 'reminder' else 'transactional' end,
          a_status, a_attempts, a_scheduled, a_created, a_created);
  insert into pg_temp.lbl (id, label) values (a_id, a_label);
end;
$fn$;

-- ---------------------------------------------------------------------------------------------
-- Fixture (as postgres, actor 'system')
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select u.id, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', u.email, '{}'::jsonb,
       '{}'::jsonb, now(), now()
from (values
  ('13a00000-0000-4000-8000-000000000010'::uuid, 'owner-h@schedops.test'),
  ('13a00000-0000-4000-8000-000000000011'::uuid, 'manager-h@schedops.test'),
  ('13a00000-0000-4000-8000-000000000012'::uuid, 'staff-h@schedops.test'),
  ('13a00000-0000-4000-8000-000000000020'::uuid, 'owner-c@schedops.test'),
  ('13a00000-0000-4000-8000-000000000021'::uuid, 'manager-c@schedops.test'),
  ('13a00000-0000-4000-8000-000000000022'::uuid, 'staff-c@schedops.test'),
  ('13a00000-0000-4000-8000-000000000030'::uuid, 'owner-n@schedops.test'),
  ('13a00000-0000-4000-8000-000000000040'::uuid, 'owner-a@schedops.test'),
  ('13a00000-0000-4000-8000-000000000050'::uuid, 'owner-k@schedops.test'),
  ('13a00000-0000-4000-8000-000000000051'::uuid, 'manager-k@schedops.test'),
  ('13a00000-0000-4000-8000-000000000052'::uuid, 'staff-ka@schedops.test'),
  ('13a00000-0000-4000-8000-000000000053'::uuid, 'staff-kb@schedops.test'),
  ('13a00000-0000-4000-8000-000000000060'::uuid, 'owner-v@schedops.test'),
  ('13a00000-0000-4000-8000-000000000061'::uuid, 'manager-v@schedops.test'),
  ('13a00000-0000-4000-8000-000000000062'::uuid, 'staff-v@schedops.test'),
  ('13a00000-0000-4000-8000-000000000070'::uuid, 'owner-p@schedops.test'),
  ('13a00000-0000-4000-8000-000000000080'::uuid, 'owner-q@schedops.test'),
  ('13a00000-0000-4000-8000-000000000090'::uuid, 'owner-x@schedops.test')
) as u (id, email);

insert into public.businesses (id, slug, name, vertical, timezone, slot_step_min, reminder_mode, quiet_start, quiet_end) values
  ('13b00000-0000-4000-8000-000000000001', 'sched-ops-hours', 'Sched Ops Hours', 'barber', 'Europe/Athens', 15, '24h', '22:00', '09:00'),
  ('13b00000-0000-4000-8000-000000000002', 'sched-ops-conflicts', 'Sched Ops Conflicts', 'barber', 'Europe/Athens', 15, '24h', '22:00', '09:00'),
  ('13b00000-0000-4000-8000-000000000003', 'sched-ops-newyork', 'Sched Ops New York', 'barber', 'America/New_York', 15, '24h', '22:00', '09:00'),
  ('13b00000-0000-4000-8000-000000000004', 'sched-ops-absence', 'Sched Ops Absence', 'barber', 'Europe/Athens', 15, '24h', '22:00', '09:00'),
  ('13b00000-0000-4000-8000-000000000005', 'sched-ops-reassign', 'Sched Ops Reassign', 'barber', 'Europe/Athens', 15, '24h', '22:00', '09:00'),
  ('13b00000-0000-4000-8000-000000000006', 'sched-ops-catalogue', 'Sched Ops Catalogue', 'barber', 'Europe/Athens', 15, '24h', '22:00', '09:00'),
  ('13b00000-0000-4000-8000-000000000007', 'sched-ops-replan', 'Sched Ops Replan', 'barber', 'Europe/Athens', 15, '24h', '22:00', '09:00'),
  ('13b00000-0000-4000-8000-000000000008', 'sched-ops-replan-fixed', 'Sched Ops Replan Fixed', 'barber', 'Europe/Athens', 15, '24h', '12:00', '18:00'),
  ('13b00000-0000-4000-8000-000000000009', 'sched-ops-other', 'Sched Ops Other', 'barber', 'Europe/Athens', 15, 'evening_before', '22:00', '09:00');

insert into public.staff (id, business_id, display_name, sort, active) values
  ('13c00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001', 'HS0', 0, true),
  ('13c00000-0000-4000-8000-000000000011', '13b00000-0000-4000-8000-000000000001', 'HS1', 1, true),
  ('13c00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002', 'CA', 0, true),
  ('13c00000-0000-4000-8000-000000000021', '13b00000-0000-4000-8000-000000000002', 'CB', 1, true),
  ('13c00000-0000-4000-8000-000000000029', '13b00000-0000-4000-8000-000000000002', 'CI', 2, false),
  ('13c00000-0000-4000-8000-000000000030', '13b00000-0000-4000-8000-000000000003', 'N1', 0, true),
  ('13c00000-0000-4000-8000-000000000040', '13b00000-0000-4000-8000-000000000004', 'AA', 0, true),
  ('13c00000-0000-4000-8000-000000000041', '13b00000-0000-4000-8000-000000000004', 'AB', 1, true),
  ('13c00000-0000-4000-8000-000000000042', '13b00000-0000-4000-8000-000000000004', 'AC', 2, true),
  ('13c00000-0000-4000-8000-000000000050', '13b00000-0000-4000-8000-000000000005', 'KA', 0, true),
  ('13c00000-0000-4000-8000-000000000051', '13b00000-0000-4000-8000-000000000005', 'KB', 1, true),
  ('13c00000-0000-4000-8000-000000000052', '13b00000-0000-4000-8000-000000000005', 'KC', 2, true),
  ('13c00000-0000-4000-8000-000000000053', '13b00000-0000-4000-8000-000000000005', 'KD', 3, true),
  ('13c00000-0000-4000-8000-000000000054', '13b00000-0000-4000-8000-000000000005', 'KE', 4, true),
  ('13c00000-0000-4000-8000-000000000055', '13b00000-0000-4000-8000-000000000005', 'KF', 5, true),
  ('13c00000-0000-4000-8000-000000000059', '13b00000-0000-4000-8000-000000000005', 'KI', 6, false),
  ('13c00000-0000-4000-8000-000000000060', '13b00000-0000-4000-8000-000000000006', 'V1', 0, true),
  ('13c00000-0000-4000-8000-000000000061', '13b00000-0000-4000-8000-000000000006', 'V2', 1, true),
  ('13c00000-0000-4000-8000-000000000062', '13b00000-0000-4000-8000-000000000006', 'V3', 2, true),
  ('13c00000-0000-4000-8000-000000000063', '13b00000-0000-4000-8000-000000000006', 'V4', 3, false),
  ('13c00000-0000-4000-8000-000000000070', '13b00000-0000-4000-8000-000000000007', 'P1', 0, true),
  ('13c00000-0000-4000-8000-000000000080', '13b00000-0000-4000-8000-000000000008', 'Q1', 0, true),
  ('13c00000-0000-4000-8000-000000000090', '13b00000-0000-4000-8000-000000000009', 'X1', 0, true);

insert into public.business_members (business_id, user_id, role, staff_id) values
  ('13b00000-0000-4000-8000-000000000001', '13a00000-0000-4000-8000-000000000010', 'owner', '13c00000-0000-4000-8000-000000000010'),
  ('13b00000-0000-4000-8000-000000000001', '13a00000-0000-4000-8000-000000000011', 'manager', null),
  ('13b00000-0000-4000-8000-000000000001', '13a00000-0000-4000-8000-000000000012', 'staff', '13c00000-0000-4000-8000-000000000011'),
  ('13b00000-0000-4000-8000-000000000002', '13a00000-0000-4000-8000-000000000020', 'owner', null),
  ('13b00000-0000-4000-8000-000000000002', '13a00000-0000-4000-8000-000000000021', 'manager', null),
  ('13b00000-0000-4000-8000-000000000002', '13a00000-0000-4000-8000-000000000022', 'staff', '13c00000-0000-4000-8000-000000000021'),
  ('13b00000-0000-4000-8000-000000000003', '13a00000-0000-4000-8000-000000000030', 'owner', null),
  ('13b00000-0000-4000-8000-000000000004', '13a00000-0000-4000-8000-000000000040', 'owner', null),
  ('13b00000-0000-4000-8000-000000000005', '13a00000-0000-4000-8000-000000000050', 'owner', null),
  ('13b00000-0000-4000-8000-000000000005', '13a00000-0000-4000-8000-000000000051', 'manager', null),
  ('13b00000-0000-4000-8000-000000000005', '13a00000-0000-4000-8000-000000000052', 'staff', '13c00000-0000-4000-8000-000000000050'),
  ('13b00000-0000-4000-8000-000000000005', '13a00000-0000-4000-8000-000000000053', 'staff', '13c00000-0000-4000-8000-000000000051'),
  ('13b00000-0000-4000-8000-000000000006', '13a00000-0000-4000-8000-000000000060', 'owner', '13c00000-0000-4000-8000-000000000060'),
  ('13b00000-0000-4000-8000-000000000006', '13a00000-0000-4000-8000-000000000061', 'manager', null),
  ('13b00000-0000-4000-8000-000000000006', '13a00000-0000-4000-8000-000000000062', 'staff', '13c00000-0000-4000-8000-000000000061'),
  ('13b00000-0000-4000-8000-000000000007', '13a00000-0000-4000-8000-000000000070', 'owner', null),
  ('13b00000-0000-4000-8000-000000000008', '13a00000-0000-4000-8000-000000000080', 'owner', null),
  ('13b00000-0000-4000-8000-000000000009', '13a00000-0000-4000-8000-000000000090', 'owner', '13c00000-0000-4000-8000-000000000090');

insert into public.service_categories (id, business_id, name, sort) values
  ('13f00000-0000-4000-8000-000000000060', '13b00000-0000-4000-8000-000000000006', 'Κούρεμα', 0),
  ('13f00000-0000-4000-8000-000000000061', '13b00000-0000-4000-8000-000000000006', 'Περιποίηση', 1),
  ('13f00000-0000-4000-8000-000000000090', '13b00000-0000-4000-8000-000000000009', 'Other', 0);

insert into public.services (id, business_id, category_id, name, duration_min, buffer_after_min, price_cents, sort) values
  ('13e00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001', null, 'Cut', 30, 0, 1300, 0),
  ('13e00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002', null, 'Cut', 30, 0, 1300, 0),
  ('13e00000-0000-4000-8000-000000000030', '13b00000-0000-4000-8000-000000000003', null, 'Cut', 30, 0, 1300, 0),
  ('13e00000-0000-4000-8000-000000000040', '13b00000-0000-4000-8000-000000000004', null, 'Cut', 30, 0, 1300, 0),
  ('13e00000-0000-4000-8000-000000000050', '13b00000-0000-4000-8000-000000000005', null, 'Cut', 30, 0, 1300, 0),
  ('13e00000-0000-4000-8000-000000000051', '13b00000-0000-4000-8000-000000000005', null, 'Beard', 20, 10, 800, 1),
  ('13e00000-0000-4000-8000-000000000060', '13b00000-0000-4000-8000-000000000006', '13f00000-0000-4000-8000-000000000060', 'Κούρεμα', 30, 0, 1300, 0),
  ('13e00000-0000-4000-8000-000000000061', '13b00000-0000-4000-8000-000000000006', null, 'Γένια', 20, 0, 750, 3),
  ('13e00000-0000-4000-8000-000000000070', '13b00000-0000-4000-8000-000000000007', null, 'Cut', 30, 0, 1300, 0),
  ('13e00000-0000-4000-8000-000000000080', '13b00000-0000-4000-8000-000000000008', null, 'Cut', 30, 0, 1300, 0),
  ('13e00000-0000-4000-8000-000000000090', '13b00000-0000-4000-8000-000000000009', '13f00000-0000-4000-8000-000000000090', 'Other cut', 30, 0, 1200, 0);

-- Everyone offers every service of their business, except KD (no Beard) and V (VS1 by V1 and V2 only).
insert into public.staff_services (business_id, staff_id, service_id)
select st.business_id, st.id, sv.id
from public.staff st
join public.services sv on sv.business_id = st.business_id
where st.business_id in ('13b00000-0000-4000-8000-000000000001', '13b00000-0000-4000-8000-000000000002',
                         '13b00000-0000-4000-8000-000000000003', '13b00000-0000-4000-8000-000000000004',
                         '13b00000-0000-4000-8000-000000000005', '13b00000-0000-4000-8000-000000000007',
                         '13b00000-0000-4000-8000-000000000008', '13b00000-0000-4000-8000-000000000009')
  and not (st.id = '13c00000-0000-4000-8000-000000000053' and sv.id = '13e00000-0000-4000-8000-000000000051');

insert into public.staff_services (business_id, staff_id, service_id) values
  ('13b00000-0000-4000-8000-000000000006', '13c00000-0000-4000-8000-000000000060', '13e00000-0000-4000-8000-000000000060'),
  ('13b00000-0000-4000-8000-000000000006', '13c00000-0000-4000-8000-000000000061', '13e00000-0000-4000-8000-000000000060');

-- Weekly hours. HS1: Tue 09:00–14:00 + 17:00–21:00, Wed 10:00–18:00 (fixed ids); HS0 none.
-- C and N: every day 09:00–17:00 (local); A: every day 00:00–24:00; K: every day 09:00–18:00.
insert into public.working_hours (id, business_id, staff_id, weekday, start_time, end_time) values
  ('13ee0000-0000-4000-8000-000000000001', '13b00000-0000-4000-8000-000000000001', '13c00000-0000-4000-8000-000000000011', 2, '09:00', '14:00'),
  ('13ee0000-0000-4000-8000-000000000002', '13b00000-0000-4000-8000-000000000001', '13c00000-0000-4000-8000-000000000011', 2, '17:00', '21:00'),
  ('13ee0000-0000-4000-8000-000000000003', '13b00000-0000-4000-8000-000000000001', '13c00000-0000-4000-8000-000000000011', 3, '10:00', '18:00');

insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
select st.business_id, st.id, d,
       case when st.business_id = '13b00000-0000-4000-8000-000000000004' then time '00:00' else time '09:00' end,
       case st.business_id when '13b00000-0000-4000-8000-000000000004' then time '24:00'
                           when '13b00000-0000-4000-8000-000000000005' then time '18:00'
                           else time '17:00' end
from public.staff st cross join generate_series(0, 6) as d
where st.business_id in ('13b00000-0000-4000-8000-000000000002', '13b00000-0000-4000-8000-000000000003',
                         '13b00000-0000-4000-8000-000000000004', '13b00000-0000-4000-8000-000000000005');

-- Exceptions of C: shop closed Thu 2030-11-21 («Αργία»), CB closed Fri 11-22, CA open Sat 11-23
-- 10:00–12:00, shop open Sun 11-24 11:00–13:00.
insert into public.schedule_exceptions (id, business_id, staff_id, local_date, kind, start_time, end_time, note) values
  ('13cc0000-0000-4000-8000-000000000001', '13b00000-0000-4000-8000-000000000002', null, '2030-11-21', 'closed', null, null, 'Αργία'),
  ('13cc0000-0000-4000-8000-000000000002', '13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000021', '2030-11-22', 'closed', null, null, null),
  ('13cc0000-0000-4000-8000-000000000003', '13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000020', '2030-11-23', 'open', '10:00', '12:00', null),
  ('13cc0000-0000-4000-8000-000000000004', '13b00000-0000-4000-8000-000000000002', null, '2030-11-24', 'open', '11:00', '13:00', null);

-- Time off (local times). C, 2030-11-19: CA vacation 10–12, CB personal 13–14, CI leave 15–16.
-- C, December 2030 (mark_absence): CA vacation 12-04 00:00 → 12-06 00:00; CB personal 12-09 08–13;
-- CA 12-11: other 07–08, vacation 09–11, other 13–15; CB other 12-16 08–12. K: KE vacation 11-19 09–12.
insert into public.time_off (id, business_id, staff_id, starts_at, ends_at, reason)
select x.id, x.business_id, x.staff_id, pg_temp.ft(x.d1, x.t1), pg_temp.ft(x.d2, x.t2), x.reason
from (values
  ('13bb0000-0000-4000-8000-000000000001'::uuid, '13b00000-0000-4000-8000-000000000002'::uuid, '13c00000-0000-4000-8000-000000000020'::uuid, date '2030-11-19', time '10:00', date '2030-11-19', time '12:00', 'vacation'),
  ('13bb0000-0000-4000-8000-000000000002', '13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000021', '2030-11-19', '13:00', '2030-11-19', '14:00', 'personal'),
  ('13bb0000-0000-4000-8000-000000000003', '13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000029', '2030-11-19', '15:00', '2030-11-19', '16:00', 'leave'),
  ('13bb0000-0000-4000-8000-000000000004', '13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000020', '2030-12-04', '00:00', '2030-12-06', '00:00', 'vacation'),
  ('13bb0000-0000-4000-8000-000000000005', '13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000021', '2030-12-09', '08:00', '2030-12-09', '13:00', 'personal'),
  ('13bb0000-0000-4000-8000-000000000006', '13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000020', '2030-12-11', '09:00', '2030-12-11', '11:00', 'vacation'),
  ('13bb0000-0000-4000-8000-000000000007', '13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000020', '2030-12-11', '13:00', '2030-12-11', '15:00', 'other'),
  ('13bb0000-0000-4000-8000-000000000008', '13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000020', '2030-12-11', '07:00', '2030-12-11', '08:00', 'other'),
  ('13bb0000-0000-4000-8000-000000000009', '13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000021', '2030-12-16', '08:00', '2030-12-16', '12:00', 'other'),
  ('13bb0000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000005', '13c00000-0000-4000-8000-000000000054', '2030-11-19', '09:00', '2030-11-19', '12:00', 'vacation')
) as x (id, business_id, staff_id, d1, t1, d2, t2, reason);

insert into public.clients (id, business_id, full_name, phone_e164, source) values
  ('13d00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001', 'Πελάτης Ωραρίου', '+306900130010', 'staff'),
  ('13d00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002', 'Αλέξης Δοκιμαστικός', '+306900130020', 'staff'),
  ('13d00000-0000-4000-8000-000000000030', '13b00000-0000-4000-8000-000000000003', 'Nick Test', '+12025550130', 'staff'),
  ('13d00000-0000-4000-8000-000000000041', '13b00000-0000-4000-8000-000000000004', 'Άννα Ένα', '+306900130041', 'staff'),
  ('13d00000-0000-4000-8000-000000000042', '13b00000-0000-4000-8000-000000000004', 'Βασίλης Δύο', '+306900130042', 'staff'),
  ('13d00000-0000-4000-8000-000000000043', '13b00000-0000-4000-8000-000000000004', 'Γιώργος Τρία', '+306900130043', 'staff'),
  ('13d00000-0000-4000-8000-000000000049', '13b00000-0000-4000-8000-000000000004', 'Δήμητρα Εννιά', '+306900130049', 'staff'),
  ('13d00000-0000-4000-8000-000000000050', '13b00000-0000-4000-8000-000000000005', 'Κώστας Κ.', '+306900130050', 'staff'),
  ('13d00000-0000-4000-8000-000000000070', '13b00000-0000-4000-8000-000000000007', 'Πέτρος Π.', '+306900130070', 'staff'),
  ('13d00000-0000-4000-8000-000000000080', '13b00000-0000-4000-8000-000000000008', 'Κική Κ.', '+306900130080', 'staff'),
  ('13d00000-0000-4000-8000-000000000090', '13b00000-0000-4000-8000-000000000009', 'Χάρης Χ.', '+306900130090', 'staff');

insert into pg_temp.lbl (id, label) values
  ('13a00000-0000-4000-8000-000000000010', 'UH0'), ('13a00000-0000-4000-8000-000000000011', 'UHM'),
  ('13a00000-0000-4000-8000-000000000012', 'UH1'), ('13a00000-0000-4000-8000-000000000020', 'UC0'),
  ('13a00000-0000-4000-8000-000000000021', 'UCM'), ('13a00000-0000-4000-8000-000000000022', 'UCB'),
  ('13a00000-0000-4000-8000-000000000030', 'UN0'), ('13a00000-0000-4000-8000-000000000040', 'UA0'),
  ('13a00000-0000-4000-8000-000000000050', 'UK0'), ('13a00000-0000-4000-8000-000000000051', 'UKM'),
  ('13a00000-0000-4000-8000-000000000052', 'UKA'), ('13a00000-0000-4000-8000-000000000053', 'UKB'),
  ('13a00000-0000-4000-8000-000000000060', 'UV0'), ('13a00000-0000-4000-8000-000000000061', 'UVM'),
  ('13a00000-0000-4000-8000-000000000062', 'UV1'), ('13a00000-0000-4000-8000-000000000070', 'UP0'),
  ('13a00000-0000-4000-8000-000000000080', 'UQ0'), ('13a00000-0000-4000-8000-000000000090', 'UX0'),
  ('13c00000-0000-4000-8000-000000000010', 'HS0'), ('13c00000-0000-4000-8000-000000000011', 'HS1'),
  ('13c00000-0000-4000-8000-000000000020', 'CA'), ('13c00000-0000-4000-8000-000000000021', 'CB'),
  ('13c00000-0000-4000-8000-000000000029', 'CI'), ('13c00000-0000-4000-8000-000000000030', 'N1'),
  ('13c00000-0000-4000-8000-000000000040', 'AA'), ('13c00000-0000-4000-8000-000000000041', 'AB'),
  ('13c00000-0000-4000-8000-000000000042', 'AC'), ('13c00000-0000-4000-8000-000000000050', 'KA'),
  ('13c00000-0000-4000-8000-000000000051', 'KB'), ('13c00000-0000-4000-8000-000000000052', 'KC'),
  ('13c00000-0000-4000-8000-000000000053', 'KD'), ('13c00000-0000-4000-8000-000000000054', 'KE'),
  ('13c00000-0000-4000-8000-000000000055', 'KF'), ('13c00000-0000-4000-8000-000000000059', 'KI'),
  ('13c00000-0000-4000-8000-000000000060', 'V1'), ('13c00000-0000-4000-8000-000000000061', 'V2'),
  ('13c00000-0000-4000-8000-000000000062', 'V3'), ('13c00000-0000-4000-8000-000000000063', 'V4'),
  ('13c00000-0000-4000-8000-000000000064', 'V5'), ('13c00000-0000-4000-8000-000000000070', 'P1'),
  ('13c00000-0000-4000-8000-000000000080', 'Q1'), ('13c00000-0000-4000-8000-000000000090', 'X1'),
  ('13d00000-0000-4000-8000-000000000010', 'cH'), ('13d00000-0000-4000-8000-000000000020', 'cC1'),
  ('13d00000-0000-4000-8000-000000000030', 'cN'), ('13d00000-0000-4000-8000-000000000041', 'cA1'),
  ('13d00000-0000-4000-8000-000000000042', 'cA2'), ('13d00000-0000-4000-8000-000000000043', 'cA3'),
  ('13d00000-0000-4000-8000-000000000049', 'cA9'), ('13d00000-0000-4000-8000-000000000050', 'cK'),
  ('13d00000-0000-4000-8000-000000000070', 'cP'), ('13d00000-0000-4000-8000-000000000080', 'cQ'),
  ('13d00000-0000-4000-8000-000000000090', 'cX'),
  ('13e00000-0000-4000-8000-000000000010', 'HSV'), ('13e00000-0000-4000-8000-000000000020', 'CS'),
  ('13e00000-0000-4000-8000-000000000030', 'NS'), ('13e00000-0000-4000-8000-000000000040', 'AS'),
  ('13e00000-0000-4000-8000-000000000050', 'KCut'), ('13e00000-0000-4000-8000-000000000051', 'KBeard'),
  ('13e00000-0000-4000-8000-000000000060', 'VS1'), ('13e00000-0000-4000-8000-000000000061', 'VS2'),
  ('13e00000-0000-4000-8000-000000000070', 'PS'), ('13e00000-0000-4000-8000-000000000080', 'QS'),
  ('13e00000-0000-4000-8000-000000000090', 'XS'),
  ('13ff0000-0000-4000-8000-000000000001', 'NEW1'), ('13ff0000-0000-4000-8000-000000000002', 'NEW2'),
  ('13ff0000-0000-4000-8000-000000000003', 'NEW3'), ('13ff0000-0000-4000-8000-000000000009', 'NEW9'),
  ('13f00000-0000-4000-8000-000000000060', 'VC1'), ('13f00000-0000-4000-8000-000000000061', 'VC2'),
  ('13f00000-0000-4000-8000-000000000090', 'XC'),
  ('13ee0000-0000-4000-8000-000000000001', 'WH1'), ('13ee0000-0000-4000-8000-000000000002', 'WH2'),
  ('13ee0000-0000-4000-8000-000000000003', 'WH3'),
  ('13cc0000-0000-4000-8000-000000000001', 'EX1'), ('13cc0000-0000-4000-8000-000000000002', 'EX2'),
  ('13cc0000-0000-4000-8000-000000000003', 'EX3'), ('13cc0000-0000-4000-8000-000000000004', 'EX4'),
  ('13bb0000-0000-4000-8000-000000000001', 'CAvac'), ('13bb0000-0000-4000-8000-000000000002', 'CBper'),
  ('13bb0000-0000-4000-8000-000000000003', 'CIlv'), ('13bb0000-0000-4000-8000-000000000004', 'CAdec'),
  ('13bb0000-0000-4000-8000-000000000005', 'CBp9'), ('13bb0000-0000-4000-8000-000000000006', 'CAv1'),
  ('13bb0000-0000-4000-8000-000000000007', 'CAo2'), ('13bb0000-0000-4000-8000-000000000008', 'CAo0'),
  ('13bb0000-0000-4000-8000-000000000009', 'CBb2b'), ('13bb0000-0000-4000-8000-000000000010', 'KEvac');

-- Appointments.
--   H (relative to today, local): HB1 HS1 +7d 16:00 · HC1 cancelled +7d 17:00 · HB2 +7d 10:00
--   C (2030-11, local): time off C01 CA 10:30 · C02 CA 11:00 confirmed · C03 cancelled, C04 completed,
--     C05 no_show inside it · C06 CB 13:00 (CB's personal time off) · C07 CB 16:30 + 15′ buffer past
--     closing · C08 CI (inactive) walk-in 10:00 · C09 CB 09:00 · 11-20: C10 CA 16:00, C11 CA 12:00 ·
--     11-21 (shop closed) C12 CB · 11-22 (CB closed) C13 CB · 11-23 (CA special 10–12) C14 12:30,
--     C15 10:30 · 11-24 (shop special 11–13) C16 CB 09:30 · 2026-10-25 (DST) C17 CB 16:30, C18 CB 08:30
--   C (2030-12-02, mark_absence): M01 CB 10:00 · M02 CB 15:00 · M03 CB 16:00 cancelled
--   N (2026-11-01, New York local): N01 16:30 · N02 08:30
--   A (T0 = the next full hour + 2 h): AX1 AA T0 · AX2 AA T0+1h · AX3 AA T0+2h · AY2 AB T0+1h ·
--     AY3 AC T0+1h
--   K (2030-11, local): R1 KA 11-19 10:00 Beard (20′ + 10′) · RC KC 10:00 · RF KF 09:30 + 15′ buffer ·
--     R2 KA 11-20 10:40 (off the 15′ grid) · R3 cancelled · R4 completed · reassign_appointment: R5 KA
--     11-26 10:00, R6 KA 11-27 10:00, R7 KA 11-28 10:00
--   P (relative): PA1..PA4 P1 +5d 12:00..15:00 · Q (2030-11, local): Z1..Z9 · X: XA1
do $fx$
declare
  b_h uuid := '13b00000-0000-4000-8000-000000000001';
  b_c uuid := '13b00000-0000-4000-8000-000000000002';
  b_n uuid := '13b00000-0000-4000-8000-000000000003';
  b_a uuid := '13b00000-0000-4000-8000-000000000004';
  b_k uuid := '13b00000-0000-4000-8000-000000000005';
  b_p uuid := '13b00000-0000-4000-8000-000000000007';
  b_q uuid := '13b00000-0000-4000-8000-000000000008';
  b_x uuid := '13b00000-0000-4000-8000-000000000009';
  hs1 uuid := '13c00000-0000-4000-8000-000000000011';
  ca uuid := '13c00000-0000-4000-8000-000000000020';
  cb uuid := '13c00000-0000-4000-8000-000000000021';
  ci uuid := '13c00000-0000-4000-8000-000000000029';
  ch uuid := '13d00000-0000-4000-8000-000000000010';
  cc uuid := '13d00000-0000-4000-8000-000000000020';
  cs uuid := '13e00000-0000-4000-8000-000000000020';
  ka uuid := '13c00000-0000-4000-8000-000000000050';
  kc uuid := '13c00000-0000-4000-8000-000000000052';
  kf uuid := '13c00000-0000-4000-8000-000000000055';
  ck uuid := '13d00000-0000-4000-8000-000000000050';
  kcut uuid := '13e00000-0000-4000-8000-000000000050';
  kbeard uuid := '13e00000-0000-4000-8000-000000000051';
  p1 uuid := '13c00000-0000-4000-8000-000000000070';
  cp uuid := '13d00000-0000-4000-8000-000000000070';
  ps uuid := '13e00000-0000-4000-8000-000000000070';
  q1 uuid := '13c00000-0000-4000-8000-000000000080';
  cq uuid := '13d00000-0000-4000-8000-000000000080';
  qs uuid := '13e00000-0000-4000-8000-000000000080';
  t0 timestamptz := date_trunc('hour', now()) + interval '3 hours';
begin
  perform pg_temp.mk('HB1', '13aa0000-0000-4000-8000-000000000101', b_h, hs1, ch, '13e00000-0000-4000-8000-000000000010', pg_temp.lt(7, '16:00'), 30);
  perform pg_temp.mk('HC1', '13aa0000-0000-4000-8000-000000000102', b_h, hs1, ch, '13e00000-0000-4000-8000-000000000010', pg_temp.lt(7, '17:00'), 30, 'cancelled');
  perform pg_temp.mk('HB2', '13aa0000-0000-4000-8000-000000000103', b_h, hs1, ch, '13e00000-0000-4000-8000-000000000010', pg_temp.lt(7, '10:00'), 30);

  perform pg_temp.mk('C01', '13aa0000-0000-4000-8000-000000000201', b_c, ca, cc, cs, pg_temp.ft('2030-11-19', '10:30'), 30);
  perform pg_temp.mk('C02', '13aa0000-0000-4000-8000-000000000202', b_c, ca, cc, cs, pg_temp.ft('2030-11-19', '11:00'), 30, 'confirmed');
  perform pg_temp.mk('C03', '13aa0000-0000-4000-8000-000000000203', b_c, ca, cc, cs, pg_temp.ft('2030-11-19', '10:00'), 30, 'cancelled');
  perform pg_temp.mk('C04', '13aa0000-0000-4000-8000-000000000204', b_c, ca, cc, cs, pg_temp.ft('2030-11-19', '11:30'), 30, 'completed');
  perform pg_temp.mk('C05', '13aa0000-0000-4000-8000-000000000205', b_c, ca, cc, cs, pg_temp.ft('2030-11-19', '11:30'), 30, 'no_show');
  perform pg_temp.mk('C06', '13aa0000-0000-4000-8000-000000000206', b_c, cb, cc, cs, pg_temp.ft('2030-11-19', '13:00'), 30);
  perform pg_temp.mk('C07', '13aa0000-0000-4000-8000-000000000207', b_c, cb, cc, cs, pg_temp.ft('2030-11-19', '16:30'), 30, 'booked', 15);
  perform pg_temp.mk('C08', '13aa0000-0000-4000-8000-000000000208', b_c, ci, null, cs, pg_temp.ft('2030-11-19', '10:00'), 30, 'booked', 0, 'walkin');
  perform pg_temp.mk('C09', '13aa0000-0000-4000-8000-000000000209', b_c, cb, cc, cs, pg_temp.ft('2030-11-19', '09:00'), 30);
  perform pg_temp.mk('C10', '13aa0000-0000-4000-8000-000000000210', b_c, ca, cc, cs, pg_temp.ft('2030-11-20', '16:00'), 30);
  perform pg_temp.mk('C11', '13aa0000-0000-4000-8000-000000000211', b_c, ca, cc, cs, pg_temp.ft('2030-11-20', '12:00'), 30);
  perform pg_temp.mk('C12', '13aa0000-0000-4000-8000-000000000212', b_c, cb, cc, cs, pg_temp.ft('2030-11-21', '10:00'), 30);
  perform pg_temp.mk('C13', '13aa0000-0000-4000-8000-000000000213', b_c, cb, cc, cs, pg_temp.ft('2030-11-22', '10:00'), 30);
  perform pg_temp.mk('C14', '13aa0000-0000-4000-8000-000000000214', b_c, ca, cc, cs, pg_temp.ft('2030-11-23', '12:30'), 30);
  perform pg_temp.mk('C15', '13aa0000-0000-4000-8000-000000000215', b_c, ca, cc, cs, pg_temp.ft('2030-11-23', '10:30'), 30);
  perform pg_temp.mk('C16', '13aa0000-0000-4000-8000-000000000216', b_c, cb, cc, cs, pg_temp.ft('2030-11-24', '09:30'), 30);
  perform pg_temp.mk('C17', '13aa0000-0000-4000-8000-000000000217', b_c, cb, cc, cs, pg_temp.ft('2026-10-25', '16:30'), 30);
  perform pg_temp.mk('C18', '13aa0000-0000-4000-8000-000000000218', b_c, cb, cc, cs, pg_temp.ft('2026-10-25', '08:30'), 30);
  perform pg_temp.mk('M01', '13aa0000-0000-4000-8000-000000000221', b_c, cb, cc, cs, pg_temp.ft('2030-12-02', '10:00'), 30);
  perform pg_temp.mk('M02', '13aa0000-0000-4000-8000-000000000222', b_c, cb, cc, cs, pg_temp.ft('2030-12-02', '15:00'), 30);
  perform pg_temp.mk('M03', '13aa0000-0000-4000-8000-000000000223', b_c, cb, cc, cs, pg_temp.ft('2030-12-02', '16:00'), 30, 'cancelled');

  perform pg_temp.mk('N01', '13aa0000-0000-4000-8000-000000000301', b_n, '13c00000-0000-4000-8000-000000000030',
                     '13d00000-0000-4000-8000-000000000030', '13e00000-0000-4000-8000-000000000030',
                     pg_temp.ft('2026-11-01', '16:30', 'America/New_York'), 30);
  perform pg_temp.mk('N02', '13aa0000-0000-4000-8000-000000000302', b_n, '13c00000-0000-4000-8000-000000000030',
                     '13d00000-0000-4000-8000-000000000030', '13e00000-0000-4000-8000-000000000030',
                     pg_temp.ft('2026-11-01', '08:30', 'America/New_York'), 30);

  perform pg_temp.mk('AX1', '13aa0000-0000-4000-8000-000000000401', b_a, '13c00000-0000-4000-8000-000000000040',
                     '13d00000-0000-4000-8000-000000000041', '13e00000-0000-4000-8000-000000000040', t0, 30);
  perform pg_temp.mk('AX2', '13aa0000-0000-4000-8000-000000000402', b_a, '13c00000-0000-4000-8000-000000000040',
                     '13d00000-0000-4000-8000-000000000042', '13e00000-0000-4000-8000-000000000040', t0 + interval '1 hour', 30);
  perform pg_temp.mk('AX3', '13aa0000-0000-4000-8000-000000000403', b_a, '13c00000-0000-4000-8000-000000000040',
                     '13d00000-0000-4000-8000-000000000043', '13e00000-0000-4000-8000-000000000040', t0 + interval '2 hours', 30);
  perform pg_temp.mk('AY2', '13aa0000-0000-4000-8000-000000000404', b_a, '13c00000-0000-4000-8000-000000000041',
                     '13d00000-0000-4000-8000-000000000049', '13e00000-0000-4000-8000-000000000040', t0 + interval '1 hour', 30);
  perform pg_temp.mk('AY3', '13aa0000-0000-4000-8000-000000000405', b_a, '13c00000-0000-4000-8000-000000000042',
                     '13d00000-0000-4000-8000-000000000049', '13e00000-0000-4000-8000-000000000040', t0 + interval '1 hour', 30);

  perform pg_temp.mk('R1', '13aa0000-0000-4000-8000-000000000501', b_k, ka, ck, kbeard, pg_temp.ft('2030-11-19', '10:00'), 20, 'booked', 10);
  perform pg_temp.mk('RC', '13aa0000-0000-4000-8000-000000000502', b_k, kc, ck, kcut, pg_temp.ft('2030-11-19', '10:00'), 30);
  perform pg_temp.mk('RF', '13aa0000-0000-4000-8000-000000000503', b_k, kf, ck, kcut, pg_temp.ft('2030-11-19', '09:30'), 30, 'booked', 15);
  perform pg_temp.mk('R2', '13aa0000-0000-4000-8000-000000000504', b_k, ka, ck, kcut, pg_temp.ft('2030-11-20', '10:40'), 30);
  perform pg_temp.mk('R3', '13aa0000-0000-4000-8000-000000000505', b_k, ka, ck, kcut, pg_temp.ft('2030-11-21', '10:00'), 30, 'cancelled');
  perform pg_temp.mk('R4', '13aa0000-0000-4000-8000-000000000506', b_k, ka, ck, kcut, pg_temp.ft('2030-11-21', '11:00'), 30, 'completed');
  perform pg_temp.mk('R5', '13aa0000-0000-4000-8000-000000000507', b_k, ka, ck, kcut, pg_temp.ft('2030-11-26', '10:00'), 30);
  perform pg_temp.mk('R6', '13aa0000-0000-4000-8000-000000000508', b_k, ka, ck, kcut, pg_temp.ft('2030-11-27', '10:00'), 30);
  perform pg_temp.mk('R7', '13aa0000-0000-4000-8000-000000000509', b_k, ka, ck, kcut, pg_temp.ft('2030-11-28', '10:00'), 30);

  perform pg_temp.mk('PA1', '13aa0000-0000-4000-8000-000000000701', b_p, p1, cp, ps, pg_temp.lt(5, '12:00'), 30);
  perform pg_temp.mk('PA2', '13aa0000-0000-4000-8000-000000000702', b_p, p1, cp, ps, pg_temp.lt(5, '13:00'), 30);
  perform pg_temp.mk('PA3', '13aa0000-0000-4000-8000-000000000703', b_p, p1, cp, ps, pg_temp.lt(5, '14:00'), 30);
  perform pg_temp.mk('PA4', '13aa0000-0000-4000-8000-000000000704', b_p, p1, cp, ps, pg_temp.lt(5, '15:00'), 30);

  perform pg_temp.mk('Z1', '13aa0000-0000-4000-8000-000000000801', b_q, q1, cq, qs, pg_temp.ft('2030-11-20', '14:00'), 30);
  perform pg_temp.mk('Z2', '13aa0000-0000-4000-8000-000000000802', b_q, q1, cq, qs, pg_temp.ft('2030-11-21', '20:00'), 30);
  perform pg_temp.mk('Z3', '13aa0000-0000-4000-8000-000000000803', b_q, q1, cq, qs, pg_temp.ft('2030-11-21', '10:00'), 30);
  perform pg_temp.mk('Z4', '13aa0000-0000-4000-8000-000000000804', b_q, q1, cq, qs, pg_temp.ft('2030-11-22', '14:00'), 30);
  perform pg_temp.mk('Z5', '13aa0000-0000-4000-8000-000000000805', b_q, q1, cq, qs, pg_temp.ft('2030-11-22', '15:00'), 30);
  perform pg_temp.mk('Z6', '13aa0000-0000-4000-8000-000000000806', b_q, q1, cq, qs, pg_temp.ft('2030-11-23', '14:00'), 30);
  perform pg_temp.mk('Z7', '13aa0000-0000-4000-8000-000000000807', b_q, q1, cq, qs, pg_temp.ft('2030-11-23', '15:00'), 30, 'cancelled');
  perform pg_temp.mk('Z9', '13aa0000-0000-4000-8000-000000000809', b_q, q1, cq, qs, pg_temp.ft('2030-11-20', '11:00'), 30);

  perform pg_temp.mk('XA1', '13aa0000-0000-4000-8000-000000000901', b_x, '13c00000-0000-4000-8000-000000000090',
                     '13d00000-0000-4000-8000-000000000090', '13e00000-0000-4000-8000-000000000090',
                     pg_temp.ft('2030-11-20', '14:00'), 30);
end
$fx$;

-- Queued SMS rows (planned under earlier settings) for the re-plan.
--   Q, quiet hours 12:00–18:00, mode 24h, p_now = 2030-11-19 12:00 local; planned 2030-11-01 unless noted:
--     r1 Z1 (11-20 14:00) at 11-19 14:00: the new time 11:00 (quiet) is already past → superseded
--     r2 Z2 (11-21 20:00) at 11-20 19:00 (stale) → 11-20 20:00
--     r3 Z3 (11-21 10:00) at 11-20 10:00 = the new time → untouched
--     r4 retry (attempts 1) · r5 due (11-19 11:30) · r6 sent · r7 of a cancelled appointment ·
--     r8 a booking_confirmed row → all untouched
--     r9 Z9 (11-20 11:00) at 11-19 13:00, planned 11-19 10:00 (25 h before) → no reminder → superseded
--   X (mode evening_before): rX XA1 at 11-19 14:00 → would move to 18:00 if X were re-planned
--   P (mode 24h, quiet 22:00–09:00, planned 2026-01-01): m1 PA1 at +4d 12:00 · m2 retry · m3 due · m4 sent
do $fx$
declare
  b_p uuid := '13b00000-0000-4000-8000-000000000007';
  b_q uuid := '13b00000-0000-4000-8000-000000000008';
  cq uuid := '13d00000-0000-4000-8000-000000000080';
  cp uuid := '13d00000-0000-4000-8000-000000000070';
  q_planned timestamptz := '2030-11-01 00:00Z';
  p_planned timestamptz := '2026-01-01 00:00Z';
begin
  perform pg_temp.msg('r1', '13dd0000-0000-4000-8000-000000000001', b_q, '13aa0000-0000-4000-8000-000000000801', cq, '+306900130080',
                      'reminder', 'queued', 0, pg_temp.ft('2030-11-19', '14:00'), q_planned);
  perform pg_temp.msg('r2', '13dd0000-0000-4000-8000-000000000002', b_q, '13aa0000-0000-4000-8000-000000000802', cq, '+306900130080',
                      'reminder', 'queued', 0, pg_temp.ft('2030-11-20', '19:00'), q_planned);
  perform pg_temp.msg('r3', '13dd0000-0000-4000-8000-000000000003', b_q, '13aa0000-0000-4000-8000-000000000803', cq, '+306900130080',
                      'reminder', 'queued', 0, pg_temp.ft('2030-11-20', '10:00'), q_planned);
  perform pg_temp.msg('r4', '13dd0000-0000-4000-8000-000000000004', b_q, '13aa0000-0000-4000-8000-000000000804', cq, '+306900130080',
                      'reminder', 'queued', 1, pg_temp.ft('2030-11-21', '14:00'), q_planned);
  perform pg_temp.msg('r5', '13dd0000-0000-4000-8000-000000000005', b_q, '13aa0000-0000-4000-8000-000000000805', cq, '+306900130080',
                      'reminder', 'queued', 0, pg_temp.ft('2030-11-19', '11:30'), q_planned);
  perform pg_temp.msg('r6', '13dd0000-0000-4000-8000-000000000006', b_q, '13aa0000-0000-4000-8000-000000000806', cq, '+306900130080',
                      'reminder', 'sent', 1, pg_temp.ft('2030-11-22', '14:00'), q_planned);
  perform pg_temp.msg('r7', '13dd0000-0000-4000-8000-000000000007', b_q, '13aa0000-0000-4000-8000-000000000807', cq, '+306900130080',
                      'reminder', 'queued', 0, pg_temp.ft('2030-11-22', '15:00'), q_planned);
  perform pg_temp.msg('r8', '13dd0000-0000-4000-8000-000000000008', b_q, '13aa0000-0000-4000-8000-000000000802', cq, '+306900130080',
                      'booking_confirmed', 'queued', 0, pg_temp.ft('2030-11-20', '15:00'), q_planned);
  perform pg_temp.msg('r9', '13dd0000-0000-4000-8000-000000000009', b_q, '13aa0000-0000-4000-8000-000000000809', cq, '+306900130080',
                      'reminder', 'queued', 0, pg_temp.ft('2030-11-19', '13:00'), pg_temp.ft('2030-11-19', '10:00'));
  perform pg_temp.msg('rX', '13dd0000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000009',
                      '13aa0000-0000-4000-8000-000000000901', '13d00000-0000-4000-8000-000000000090', '+306900130090',
                      'reminder', 'queued', 0, pg_temp.ft('2030-11-19', '14:00'), q_planned);

  perform pg_temp.msg('m1', '13dd0000-0000-4000-8000-000000000011', b_p, '13aa0000-0000-4000-8000-000000000701', cp, '+306900130070',
                      'reminder', 'queued', 0, pg_temp.lt(4, '12:00'), p_planned);
  perform pg_temp.msg('m2', '13dd0000-0000-4000-8000-000000000012', b_p, '13aa0000-0000-4000-8000-000000000702', cp, '+306900130070',
                      'reminder', 'queued', 1, pg_temp.lt(4, '13:00'), p_planned);
  perform pg_temp.msg('m3', '13dd0000-0000-4000-8000-000000000013', b_p, '13aa0000-0000-4000-8000-000000000703', cp, '+306900130070',
                      'reminder', 'queued', 0, now() - interval '1 minute', p_planned);
  perform pg_temp.msg('m4', '13dd0000-0000-4000-8000-000000000014', b_p, '13aa0000-0000-4000-8000-000000000704', cp, '+306900130070',
                      'reminder', 'sent', 1, pg_temp.lt(4, '15:00'), p_planned);
end
$fx$;

-- ---------------------------------------------------------------------------------------------
-- Shape (§2.4, §2.5, §2.6): signatures, volatility, definer/invoker, result types, the trigger
-- ---------------------------------------------------------------------------------------------
select is(
  (select array_agg(p.oid::regprocedure::text || ' ' || p.provolatile::text
                    || case when p.prosecdef then ' definer' else ' invoker' end
                    order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('replace_week_hours', 'schedule_conflicts', 'mark_absence', 'reassign_candidates',
                       'save_service', 'set_staff_order')),
  array[
    'mark_absence(uuid,uuid,timestamp with time zone,timestamp with time zone) v invoker',
    'reassign_candidates(uuid,uuid) s invoker',
    'replace_week_hours(uuid,uuid,jsonb) v invoker',
    'save_service(uuid,uuid,jsonb,jsonb) v invoker',
    'schedule_conflicts(uuid,uuid,timestamp with time zone,timestamp with time zone) s invoker',
    'set_staff_order(uuid,uuid[]) v invoker'
  ]::text[],
  'the six 1.6 wrappers exist once each with the contract parameters, as invoker (stable reads, volatile writes)'
);

select is(
  (select array_agg(p.oid::regprocedure::text || ' ' || p.provolatile::text
                    || case when p.prosecdef then ' definer' else ' invoker' end
                    order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
     and p.proname in ('replace_week_hours_impl', 'schedule_conflicts_impl', 'mark_absence_impl',
                       'reassign_candidates_impl', 'save_service_impl', 'set_staff_order_impl')),
  array[
    'private.mark_absence_impl(uuid,uuid,timestamp with time zone,timestamp with time zone) v definer',
    'private.reassign_candidates_impl(uuid,uuid) s definer',
    'private.replace_week_hours_impl(uuid,uuid,jsonb) v definer',
    'private.save_service_impl(uuid,uuid,jsonb,jsonb) v definer',
    'private.schedule_conflicts_impl(uuid,uuid,timestamp with time zone,timestamp with time zone) s definer',
    'private.set_staff_order_impl(uuid,uuid[]) v definer'
  ]::text[],
  'the six _impl functions are SECURITY DEFINER with the same parameters and volatility as their wrappers'
);

select is(
  (select array_agg(p.proname || ' ' || pg_get_function_result(p.oid) order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname = 'public' and p.proname in ('replace_week_hours', 'schedule_conflicts', 'mark_absence',
                                                 'reassign_candidates', 'save_service', 'set_staff_order'))
      or (n.nspname = 'private' and p.proname = 'staff_day_opening')),
  array[
    'mark_absence jsonb',
    'reassign_candidates TABLE(staff_id uuid, free boolean, blocker text)',
    'replace_week_hours jsonb',
    'save_service jsonb',
    'schedule_conflicts TABLE(appointment_id uuid, staff_id uuid, starts_at timestamp with time zone, '
      || 'ends_at timestamp with time zone, status text, source text, client_id uuid, client_name text, '
      || 'client_phone_e164 text, service_ids uuid[], reasons text[])',
    'set_staff_order jsonb',
    'staff_day_opening TABLE(scope text, closed boolean, windows tstzmultirange)'
  ]::text[],
  'result types: jsonb for the writes; conflicts with exactly the eleven columns of §2.5.2 (no time off reason, '
  || 'no note); candidates (staff_id, free, blocker); staff_day_opening (scope, closed, windows)'
);

select is(
  (select p.pronargdefaults from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'schedule_conflicts'),
  3::smallint,
  'schedule_conflicts: staff, from and to default to null (every staff member, now, 366 days)'
);

select is(
  (select array_agg(p.oid::regprocedure::text || ' ' || p.provolatile::text order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname in ('staff_day_opening', 'staff_day_windows', 'schedule_conflicts_core')),
  array[
    'private.schedule_conflicts_core(uuid,uuid,timestamp with time zone,timestamp with time zone) s',
    'private.staff_day_opening(uuid,uuid,date) s',
    'private.staff_day_windows(uuid,uuid,date) s'
  ]::text[],
  'helpers: schedule_conflicts_core and staff_day_opening are stable; staff_day_windows keeps its 0004 signature'
);

select is(
  (select array_agg(p.oid::regprocedure::text || case when p.prosecdef then ' definer ' else ' invoker ' end
                    || format_type(p.prorettype, null) order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname in ('replan_reminders_impl', 'businesses_replan_reminders')),
  array[
    'private.businesses_replan_reminders() definer trigger',
    'private.replan_reminders_impl(uuid,timestamp with time zone) definer integer'
  ]::text[],
  're-plan: replan_reminders_impl(p_business_id, p_now) returns the count; the trigger function is a definer'
);

select has_trigger('public', 'businesses', 'businesses_replan_reminders',
                   'businesses has the re-plan trigger (provisioning and the app both fire it)');

-- ---------------------------------------------------------------------------------------------
-- Tenant isolation: a member of another business (owner of X) gets 42501 from every 1.6 RPC with
-- the ids of C, H, K and V (02's loop covers the null arguments).
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', 'system', true);

select is(
  concat_ws(' | ',
    pg_temp.scf('i_cf', '13a00000-0000-4000-8000-000000000090', '13b00000-0000-4000-8000-000000000002', null, null, null),
    pg_temp.mab('i_ma', '13a00000-0000-4000-8000-000000000090', '13b00000-0000-4000-8000-000000000002',
                '13c00000-0000-4000-8000-000000000020', pg_temp.ft('2031-02-01', '10:00'), pg_temp.ft('2031-02-01', '12:00')),
    pg_temp.rwh('i_rw', '13a00000-0000-4000-8000-000000000090', '13b00000-0000-4000-8000-000000000001',
                '13c00000-0000-4000-8000-000000000011', $q$'[]'::jsonb$q$),
    pg_temp.rca('i_rc', '13a00000-0000-4000-8000-000000000090', '13b00000-0000-4000-8000-000000000005',
                '13aa0000-0000-4000-8000-000000000501'),
    pg_temp.sav('i_sv', '13a00000-0000-4000-8000-000000000090', '13ff0000-0000-4000-8000-000000000009', pg_temp.svc(), '[]'),
    pg_temp.sso('i_so', '13a00000-0000-4000-8000-000000000090',
                array['13c00000-0000-4000-8000-000000000060', '13c00000-0000-4000-8000-000000000061',
                      '13c00000-0000-4000-8000-000000000062', '13c00000-0000-4000-8000-000000000063']::uuid[])),
  '42501 | 42501 | 42501 | 42501 | 42501 | 42501',
  'a non-member gets 42501 from schedule_conflicts, mark_absence, replace_week_hours, reassign_candidates, '
  || 'save_service and set_staff_order'
);

-- ---------------------------------------------------------------------------------------------
-- private.staff_day_opening: exactly one row; staff exception > shop exception > weekly hours
-- (business C; the windows are the opening only, time off is not subtracted)
-- ---------------------------------------------------------------------------------------------
select is(
  pg_temp.opening('13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000020', '2030-11-23',
                  tstzmultirange(tstzrange(pg_temp.ft('2030-11-23', '10:00'), pg_temp.ft('2030-11-23', '12:00')))),
  '1 staff f t',
  'staff_day_opening: a staff open exception wins over the weekly hours (scope staff, its interval only)'
);

select is(
  pg_temp.opening('13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000021', '2030-11-21',
                  '{}'::tstzmultirange),
  '1 shop t t',
  'staff_day_opening: a shop closure applies to a staff member without an own exception (scope shop, closed, no windows)'
);

select is(
  pg_temp.opening('13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000021', '2030-11-19',
                  tstzmultirange(tstzrange(pg_temp.ft('2030-11-19', '09:00'), pg_temp.ft('2030-11-19', '17:00')))),
  '1 weekly f t',
  'staff_day_opening: no exception → the weekly hours, not reduced by the time off of that day'
);

select is(
  pg_temp.opening('13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000021', '2030-11-22',
                  '{}'::tstzmultirange),
  '1 staff t t',
  'staff_day_opening: a staff closure wins over the weekly hours'
);

select is(
  pg_temp.opening('13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000020', '2030-11-24',
                  tstzmultirange(tstzrange(pg_temp.ft('2030-11-24', '11:00'), pg_temp.ft('2030-11-24', '13:00')))),
  '1 shop f t',
  'staff_day_opening: a shop special-hours day replaces the weekly hours of every staff member without an own exception'
);

select is(
  pg_temp.opening('13b00000-0000-4000-8000-000000000001', '13c00000-0000-4000-8000-000000000010', '2030-11-19',
                  '{}'::tstzmultirange),
  '1 weekly f t',
  'staff_day_opening: no hours at all → one weekly row, not closed, empty windows'
);

select is(
  pg_temp.opening('13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000021', '2026-10-25',
                  tstzmultirange(tstzrange(pg_temp.ft('2026-10-25', '09:00'), pg_temp.ft('2026-10-25', '17:00')))),
  '1 weekly f t',
  'staff_day_opening: local hours on the DST day 2026-10-25 map to the right instants'
);

select is(
  (select string_agg(to_char(w.starts_at at time zone 'Europe/Athens', 'HH24:MI') || '-'
                     || to_char(w.ends_at at time zone 'Europe/Athens', 'HH24:MI'), ', ' order by w.starts_at)
   from private.staff_day_windows('13b00000-0000-4000-8000-000000000002', '13c00000-0000-4000-8000-000000000020',
                                  '2030-11-19') as w),
  '09:00-10:00, 12:00-17:00',
  'staff_day_windows (new body over staff_day_opening): the opening minus the time off, same rows as 0004'
);

-- ---------------------------------------------------------------------------------------------
-- schedule_conflicts (business C, explicit ranges; owner UC0 unless noted)
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', 'system', true);

select is(
  pg_temp.scf('cf_all', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002', null,
              pg_temp.ft('2030-11-19', '00:00'), pg_temp.ft('2030-11-25', '00:00')),
  'C08 staff_inactive, C01 time_off, C02 time_off, C06 time_off, C12 shop_closed, C13 staff_closed, '
  || 'C14 special_hours, C16 special_hours',
  'conflicts: time off (own and a colleague''s), shop closed, staff closed, outside special hours (staff and shop '
  || 'scope), inactive staff; never cancelled/completed/no_show, never a buffer past closing, by start'
);

select ok(
  (select bool_and(pg_temp.keys(c) = array['appointment_id', 'client_id', 'client_name', 'client_phone_e164', 'ends_at',
                                           'reasons', 'service_ids', 'source', 'staff_id', 'starts_at', 'status'])
          and count(*) = 8
   from jsonb_array_elements(pg_temp.r('cf_all')) as c),
  'conflicts: every row has exactly the eleven columns of §2.5.2'
);

select ok(
  (select jsonb_array_length(r) = 8 and r::text !~* '(vacation|personal|leave)' from pg_temp.r('cf_all') as r),
  'conflicts: no row carries a time off reason (vacation, personal, leave), the own or a colleague''s'
);

select is(
  (select concat_ws(' | ', c ->> 'status', c ->> 'source', pg_temp.l((c ->> 'staff_id')::uuid),
                    pg_temp.l((c ->> 'client_id')::uuid), c ->> 'client_name', c ->> 'client_phone_e164',
                    (select string_agg(pg_temp.l(s::uuid), '+') from jsonb_array_elements_text(c -> 'service_ids') as s),
                    pg_temp.lh((c ->> 'starts_at')::timestamptz) || '-' || pg_temp.lh((c ->> 'ends_at')::timestamptz))
   from jsonb_array_elements(pg_temp.r('cf_all')) as c
   where c ->> 'appointment_id' = '13aa0000-0000-4000-8000-000000000201'),
  'booked | phone | CA | cC1 | Αλέξης Δοκιμαστικός | +306900130020 | CS | 11-19 10:30-11-19 11:00',
  'conflicts: a row carries status, source, staff, client id, name and phone, services and the service time'
);

select is(
  (select concat_ws(' | ', c ->> 'status', c ->> 'source', pg_temp.l((c ->> 'staff_id')::uuid),
                    coalesce(c ->> 'client_id', '<null>'), coalesce(c ->> 'client_name', '<null>'),
                    coalesce(c ->> 'client_phone_e164', '<null>'))
   from jsonb_array_elements(pg_temp.r('cf_all')) as c
   where c ->> 'appointment_id' = '13aa0000-0000-4000-8000-000000000208'),
  'booked | walkin | CI | <null> | <null> | <null>',
  'conflicts: a walk-in without client has null client id, name and phone'
);

select is(
  pg_temp.scf('cf_cb', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
              '13c00000-0000-4000-8000-000000000021', pg_temp.ft('2030-11-19', '00:00'), pg_temp.ft('2030-11-25', '00:00')),
  'C06 time_off, C12 shop_closed, C13 staff_closed, C16 special_hours',
  'conflicts: p_staff_id limits the rows to that staff member'
);

select is(
  pg_temp.scf('cf_win', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002', null,
              pg_temp.ft('2030-11-19', '10:45'), pg_temp.ft('2030-11-19', '13:00')),
  'C01 time_off, C02 time_off',
  'conflicts: only appointments whose service time overlaps [from, to)'
);

select is(
  pg_temp.scf('cf_wed1', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
              '13c00000-0000-4000-8000-000000000020', pg_temp.ft('2030-11-20', '00:00'), pg_temp.ft('2030-11-21', '00:00')),
  '-',
  'conflicts: CA''s Wednesday appointments (12:00, 16:00) are inside 09:00–17:00'
);

select is(
  pg_temp.rwh('cf_short', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
              '13c00000-0000-4000-8000-000000000020',
              $q$(select jsonb_agg(jsonb_build_object('weekday', d, 'start_time', '09:00', 'end_time', '14:00') order by d)
                  from generate_series(0, 6) as d)$q$),
  'ok',
  'replace_week_hours: the owner shortens CA''s hours to 09:00–14:00 every day'
);

select is(
  pg_temp.scf('cf_wed2', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
              '13c00000-0000-4000-8000-000000000020', pg_temp.ft('2030-11-20', '00:00'), pg_temp.ft('2030-11-21', '00:00')),
  'C10 outside_hours',
  'conflicts: after shorter hours the 16:00 appointment is outside_hours, the 12:00 one is not'
);

select is(
  pg_temp.scf('cf_dst', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
              '13c00000-0000-4000-8000-000000000021', pg_temp.ft('2026-10-25', '00:00'), pg_temp.ft('2026-10-26', '00:00')),
  'C18 outside_hours',
  'conflicts on the DST day 2026-10-25: 16:30–17:00 is inside 09:00–17:00, 08:30 is outside'
);

select is(
  pg_temp.scf('cf_ny', '13a00000-0000-4000-8000-000000000030', '13b00000-0000-4000-8000-000000000003', null,
              pg_temp.ft('2026-11-01', '00:00', 'America/New_York'), pg_temp.ft('2026-11-02', '00:00', 'America/New_York')),
  'N02 outside_hours',
  'conflicts in the zone of the business (New York, its DST day): 16:30 local is inside, 08:30 local is outside'
);

select is(
  concat_ws(' | ',
    pg_temp.scf('cf_e1', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002', null,
                pg_temp.ft('2032-01-01', '10:00'), pg_temp.ft('2032-01-01', '10:00')),
    pg_temp.scf('cf_e2', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002', null,
                pg_temp.ft('2032-01-02', '00:00'), pg_temp.ft('2032-01-01', '00:00')),
    pg_temp.scf('cf_e3', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002', null,
                pg_temp.ft('2032-01-01', '00:00'), pg_temp.ft('2033-01-02', '00:00')),
    pg_temp.scf('cf_e4', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002', null,
                pg_temp.ft('2032-01-01', '00:00'), pg_temp.ft('2033-01-01', '00:00'))),
  '22023 | 22023 | P0001 AN002 | -',
  'conflicts: to = from and to < from → 22023; 367 days → AN002; exactly 366 days is allowed'
);

select is(
  concat_ws(' | ',
    pg_temp.scf('cf_s', '13a00000-0000-4000-8000-000000000022', '13b00000-0000-4000-8000-000000000002', null,
                pg_temp.ft('2030-11-19', '00:00'), pg_temp.ft('2030-11-20', '00:00')),
    pg_temp.scf('cf_m', '13a00000-0000-4000-8000-000000000021', '13b00000-0000-4000-8000-000000000002', null,
                pg_temp.ft('2030-11-19', '00:00'), pg_temp.ft('2030-11-20', '00:00')),
    pg_temp.scf('cf_f', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
                '13c00000-0000-4000-8000-000000000090', pg_temp.ft('2030-11-19', '00:00'), pg_temp.ft('2030-11-20', '00:00')),
    pg_temp.call('cf_d', '13a00000-0000-4000-8000-000000000020',
                 pg_temp.tab($q$public.schedule_conflicts(p_business_id => '13b00000-0000-4000-8000-000000000002')$q$))),
  '42501 | C08 staff_inactive, C01 time_off, C02 time_off, C06 time_off | 42501 | ok',
  'conflicts: a staff caller → 42501; the manager reads them; a staff id of another business → 42501; '
  || 'the defaults (now, 366 days) answer'
);

-- ---------------------------------------------------------------------------------------------
-- replace_week_hours (business H; HB1/HC1/HB2 a week from today)
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', 'system', true);

select is(
  pg_temp.rwh('rw1', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001',
              '13c00000-0000-4000-8000-000000000011',
              $q$'[{"weekday": 3, "start_time": "10:00", "end_time": "18:00"},
                   {"weekday": 2, "start_time": "17:00", "end_time": "21:00"},
                   {"weekday": 2, "start_time": "09:00", "end_time": "14:00"}]'::jsonb$q$),
  'ok',
  'replace_week_hours: the owner sends the stored set again (another order)'
);

select is(
  (select concat_ws(' | ', r ->> 'changed', pg_temp.l((r ->> 'staff_id')::uuid), pg_temp.wrows(r -> 'rows'),
                    jsonb_typeof(r -> 'conflict_count'))
   from pg_temp.r('rw1') as r),
  'false | HS1 | 2 09:00-14:00, 2 17:00-21:00, 3 10:00-18:00 | number',
  'replace_week_hours: the same set → changed false; rows HH:MM by weekday and start; a numeric conflict_count'
);

select is(
  pg_temp.keys(pg_temp.r('rw1')),
  array['changed', 'conflict_count', 'rows', 'staff_id'],
  'replace_week_hours: the answer has exactly staff_id, changed, rows and conflict_count'
);

select is(
  pg_temp.whl('13c00000-0000-4000-8000-000000000011'),
  'WH1, WH2, WH3',
  'replace_week_hours: the same set writes nothing (the stored rows keep their ids)'
);

select is(
  pg_temp.rwh('rw2', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001',
              '13c00000-0000-4000-8000-000000000011',
              $q$'[{"weekday": 2, "start_time": "09:00", "end_time": "14:00"},
                   {"weekday": 2, "start_time": "13:00", "end_time": "15:00"}]'::jsonb$q$),
  '23P01',
  'replace_week_hours: two overlapping rows → 23P01'
);

select is(
  concat_ws(' | ', pg_temp.whl('13c00000-0000-4000-8000-000000000011'), pg_temp.wh('13c00000-0000-4000-8000-000000000011')),
  'WH1, WH2, WH3 | 2 09:00-14:00, 2 17:00-21:00, 3 10:00-18:00',
  'replace_week_hours is atomic: after the 23P01 the previous week is still there (same ids, same values)'
);

select is(
  concat_ws(' | ',
    pg_temp.rwh('rw3a', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001', '13c00000-0000-4000-8000-000000000011',
                $q$'[{"weekday": 1, "start_time": "09:00", "end_time": "14:00", "note": "x"}]'::jsonb$q$),
    pg_temp.rwh('rw3b', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001', '13c00000-0000-4000-8000-000000000011',
                $q$'[{"weekday": 1, "start_time": "09:00"}]'::jsonb$q$),
    pg_temp.rwh('rw3c', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001', '13c00000-0000-4000-8000-000000000011',
                $q$'[{"weekday": 7, "start_time": "09:00", "end_time": "14:00"}]'::jsonb$q$),
    pg_temp.rwh('rw3d', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001', '13c00000-0000-4000-8000-000000000011',
                $q$'[{"weekday": 1, "start_time": "09:00", "end_time": "25:00"}]'::jsonb$q$),
    pg_temp.rwh('rw3e', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001', '13c00000-0000-4000-8000-000000000011',
                $q$'[{"weekday": 1, "start_time": "10:00", "end_time": "10:00"}]'::jsonb$q$),
    pg_temp.rwh('rw3f', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001', '13c00000-0000-4000-8000-000000000011',
                $q$'[{"weekday": 1, "start_time": "14:00", "end_time": "09:00"}]'::jsonb$q$),
    pg_temp.rwh('rw3g', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001', '13c00000-0000-4000-8000-000000000011',
                $q$'{"weekday": 1, "start_time": "09:00", "end_time": "14:00"}'::jsonb$q$),
    pg_temp.rwh('rw3h', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001', '13c00000-0000-4000-8000-000000000011',
                $q$(select jsonb_agg(jsonb_build_object('weekday', 1, 'start_time', '09:00', 'end_time', '10:00'))
                    from generate_series(1, 71))$q$),
    pg_temp.rwh('rw3i', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001', '13c00000-0000-4000-8000-000000000011',
                'null::jsonb')),
  '22023 | 22023 | 22023 | 22023 | 22023 | 22023 | 22023 | 22023 | 22023',
  'replace_week_hours shape → 22023: an extra key, a missing key, weekday 7, 25:00, end = start, end < start, '
  || 'an object instead of an array, 71 rows, null'
);

select is(
  pg_temp.whl('13c00000-0000-4000-8000-000000000011'),
  'WH1, WH2, WH3',
  'replace_week_hours: a refused shape changes nothing'
);

select is(
  concat_ws(' | ',
    pg_temp.rwh('rw4a', '13a00000-0000-4000-8000-000000000012', '13b00000-0000-4000-8000-000000000001',
                '13c00000-0000-4000-8000-000000000011', $q$'[]'::jsonb$q$),
    pg_temp.rwh('rw4b', '13a00000-0000-4000-8000-000000000012', '13b00000-0000-4000-8000-000000000001',
                '13c00000-0000-4000-8000-000000000010', $q$'[]'::jsonb$q$)),
  '42501 | 42501',
  'replace_week_hours: a staff member changes neither their own hours nor a colleague''s (42501)'
);

select is(
  concat_ws(' | ', pg_temp.whl('13c00000-0000-4000-8000-000000000011'), pg_temp.wh('13c00000-0000-4000-8000-000000000011')),
  'WH1, WH2, WH3 | 2 09:00-14:00, 2 17:00-21:00, 3 10:00-18:00',
  'replace_week_hours: the staff calls changed nothing'
);

select is(
  concat_ws(' | ',
    pg_temp.rwh('rw5a', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001',
                '13c00000-0000-4000-8000-000000000090', $q$'[]'::jsonb$q$),
    pg_temp.rwh('rw5b', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001',
                null, $q$'[]'::jsonb$q$)),
  '42501 | 42501',
  'replace_week_hours: a staff id of another business or null → 42501'
);

select is(
  pg_temp.rwh('rw6', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001',
              '13c00000-0000-4000-8000-000000000011',
              $q$(select jsonb_agg(jsonb_build_object('weekday', d, 'start_time', '09:00', 'end_time', '14:00') order by d desc)
                  from generate_series(0, 6) as d)$q$),
  'ok',
  'replace_week_hours: the owner sets 09:00–14:00 on every day'
);

select is(
  (select concat_ws(' | ', r ->> 'changed', pg_temp.l((r ->> 'staff_id')::uuid), pg_temp.wrows(r -> 'rows'), r ->> 'conflict_count')
   from pg_temp.r('rw6') as r),
  'true | HS1 | 0 09:00-14:00, 1 09:00-14:00, 2 09:00-14:00, 3 09:00-14:00, 4 09:00-14:00, 5 09:00-14:00, '
  || '6 09:00-14:00 | 1',
  'replace_week_hours: changed true, the new rows by weekday, conflict_count counts the booked 16:00 appointment '
  || '(not the cancelled 17:00 one, not the 10:00 one inside the hours)'
);

select is(
  concat_ws(' | ', pg_temp.wh('13c00000-0000-4000-8000-000000000011'),
            (not exists (select 1 from public.working_hours w where w.id in (
               '13ee0000-0000-4000-8000-000000000001', '13ee0000-0000-4000-8000-000000000002',
               '13ee0000-0000-4000-8000-000000000003')))::text),
  '0 09:00-14:00, 1 09:00-14:00, 2 09:00-14:00, 3 09:00-14:00, 4 09:00-14:00, 5 09:00-14:00, 6 09:00-14:00 | true',
  'replace_week_hours: the stored week is exactly the new set; the old rows are gone'
);

select is(
  pg_temp.appts(array['13aa0000-0000-4000-8000-000000000101', '13aa0000-0000-4000-8000-000000000102',
                      '13aa0000-0000-4000-8000-000000000103']::uuid[]),
  'HB1 booked HS1, HB2 booked HS1, HC1 cancelled HS1',
  'replace_week_hours: appointments outside the new hours stay as they are (reported, never touched)'
);

select is(
  pg_temp.scf('cf_h', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001',
              '13c00000-0000-4000-8000-000000000011', null, null),
  'HB1 outside_hours',
  'schedule_conflicts with the default range (from now, 366 days) lists the appointment conflict_count counted'
);

select is(
  pg_temp.rwh('rw7', '13a00000-0000-4000-8000-000000000011', '13b00000-0000-4000-8000-000000000001',
              '13c00000-0000-4000-8000-000000000011',
              $q$'[{"weekday": 1, "start_time": "13:00", "end_time": "24:00"},
                   {"weekday": 1, "start_time": "09:00", "end_time": "13:00"}]'::jsonb$q$),
  'ok',
  'replace_week_hours: the manager may replace the week (a back-to-back split shift up to 24:00)'
);

select is(
  (select concat_ws(' | ', r ->> 'changed', pg_temp.wrows(r -> 'rows')) from pg_temp.r('rw7') as r),
  'true | 1 09:00-13:00, 1 13:00-24:00',
  'replace_week_hours: back-to-back intervals are not an overlap; 24:00 is answered as 24:00'
);

select is(
  pg_temp.wh('13c00000-0000-4000-8000-000000000011'),
  '1 09:00-13:00, 1 13:00-24:00',
  'replace_week_hours: the whole week is replaced (the other days are now closed)'
);

select is(
  pg_temp.rwh('rw8', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001',
              '13c00000-0000-4000-8000-000000000011', $q$'[]'::jsonb$q$),
  'ok',
  'replace_week_hours: [] is valid (no hours at all)'
);

select is(
  (select concat_ws(' | ', r ->> 'changed', pg_temp.wrows(r -> 'rows'), r ->> 'conflict_count') from pg_temp.r('rw8') as r),
  'true | - | 2',
  'replace_week_hours: [] clears the week; both booked appointments now conflict, the cancelled one does not'
);

select is(
  pg_temp.wh('13c00000-0000-4000-8000-000000000011'),
  '-',
  'replace_week_hours: no weekly row left'
);

select is(
  pg_temp.rwh('rw8b', '13a00000-0000-4000-8000-000000000010', '13b00000-0000-4000-8000-000000000001',
              '13c00000-0000-4000-8000-000000000011', $q$'[]'::jsonb$q$),
  'ok',
  'replace_week_hours: [] again answers'
);

select is(
  pg_temp.r('rw8b') ->> 'changed',
  'false',
  'replace_week_hours: [] over an empty week → changed false'
);

select is(
  concat_ws(' | ',
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000010',
      $q$insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
         values ('13b00000-0000-4000-8000-000000000001', '13c00000-0000-4000-8000-000000000011', 1, '09:00', '14:00')$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000010',
      $q$update public.working_hours set start_time = '08:00' where business_id = '13b00000-0000-4000-8000-000000000001'$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000010',
      $q$delete from public.working_hours where business_id = '13b00000-0000-4000-8000-000000000001'$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000012',
      $q$insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
         values ('13b00000-0000-4000-8000-000000000001', '13c00000-0000-4000-8000-000000000011', 1, '09:00', '14:00')$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000012',
      $q$delete from public.working_hours where business_id = '13b00000-0000-4000-8000-000000000001'$q$)),
  '42501 | 42501 | 42501 | 42501 | 42501',
  'working_hours: no direct insert, update or delete for the owner or a staff member (replace_week_hours only)'
);

select is(
  pg_temp.wh('13c00000-0000-4000-8000-000000000011'),
  '-',
  'working_hours: the refused direct writes left nothing'
);

-- ---------------------------------------------------------------------------------------------
-- mark_absence (business C, December 2030; owner UC0 unless noted)
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', 'system', true);

select is(
  pg_temp.mab('ma1', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
              '13c00000-0000-4000-8000-000000000021', pg_temp.ft('2030-12-02', '12:00'), pg_temp.ft('2030-12-03', '00:00')),
  'ok',
  'mark_absence: the owner marks CB absent from 12:00 to the end of the day'
);

insert into pg_temp.lbl (id, label)
select (pg_temp.r('ma1') ->> 'time_off_id')::uuid, 'TN1'
where pg_temp.r('ma1') ->> 'time_off_id' is not null
on conflict do nothing;

select is(
  (select concat_ws(' | ', r ->> 'created', r ->> 'extended', r ->> 'reason', pg_temp.l((r ->> 'staff_id')::uuid),
                    ((r ->> 'starts_at')::timestamptz = pg_temp.ft('2030-12-02', '12:00'))::text,
                    ((r ->> 'ends_at')::timestamptz = pg_temp.ft('2030-12-03', '00:00'))::text)
   from pg_temp.r('ma1') as r),
  'true | false | leave | CB | true | true',
  'mark_absence without time off: a new leave over exactly the window, created true'
);

select is(
  pg_temp.keys(pg_temp.r('ma1')),
  array['conflicts', 'created', 'ends_at', 'extended', 'reason', 'staff_id', 'starts_at', 'time_off_id'],
  'mark_absence: the answer has exactly the keys of §2.5.3'
);

select is(
  (select concat_ws(' | ', pg_temp.conf(r -> 'conflicts'),
                    (select bool_and(pg_temp.keys(c) = array['appointment_id', 'client_id', 'client_name', 'client_phone_e164',
                                                             'ends_at', 'reasons', 'service_ids', 'source', 'staff_id',
                                                             'starts_at', 'status'])
                     from jsonb_array_elements(r -> 'conflicts') as c)::text)
   from pg_temp.r('ma1') as r),
  'M02 time_off | true',
  'mark_absence: the conflicts of the window only (not the 10:00 one before it, not the cancelled one), as §2.5.2 rows'
);

select is(
  pg_temp.toff('13c00000-0000-4000-8000-000000000021', pg_temp.ft('2030-12-02', '00:00'), pg_temp.ft('2030-12-03', '00:00')),
  'TN1 leave 12-02 12:00-12-03 00:00',
  'mark_absence: exactly one stored row, the one answered'
);

select is(
  pg_temp.mab('ma1b', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
              '13c00000-0000-4000-8000-000000000021', pg_temp.ft('2030-12-02', '12:00'), pg_temp.ft('2030-12-03', '00:00')),
  'ok',
  'mark_absence: the same call again does not fail'
);

select is(
  (select concat_ws(' | ', pg_temp.l((r ->> 'time_off_id')::uuid), r ->> 'created', r ->> 'extended',
                    pg_temp.toff('13c00000-0000-4000-8000-000000000021', pg_temp.ft('2030-12-02', '00:00'),
                                 pg_temp.ft('2030-12-03', '00:00')))
   from pg_temp.r('ma1b') as r),
  'TN1 | false | false | TN1 leave 12-02 12:00-12-03 00:00',
  'mark_absence again: the same row, created false, extended false, still one row'
);

select is(
  pg_temp.appts(array['13aa0000-0000-4000-8000-000000000221', '13aa0000-0000-4000-8000-000000000222',
                      '13aa0000-0000-4000-8000-000000000223']::uuid[]),
  'M01 booked CB, M02 booked CB, M03 cancelled CB',
  'mark_absence never touches appointments'
);

select is(
  pg_temp.mab('ma2', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
              '13c00000-0000-4000-8000-000000000020', pg_temp.ft('2030-12-04', '12:00'), pg_temp.ft('2030-12-05', '00:00')),
  'ok',
  'mark_absence over a vacation that covers the window does not fail'
);

select is(
  (select concat_ws(' | ', pg_temp.l((r ->> 'time_off_id')::uuid), r ->> 'created', r ->> 'extended', r ->> 'reason',
                    pg_temp.lh((r ->> 'starts_at')::timestamptz), pg_temp.lh((r ->> 'ends_at')::timestamptz))
   from pg_temp.r('ma2') as r),
  'CAdec | false | false | vacation | 12-04 00:00 | 12-06 00:00',
  'mark_absence: the covering vacation is answered as it is (its reason too); nothing created or extended'
);

select is(
  pg_temp.toff('13c00000-0000-4000-8000-000000000020', pg_temp.ft('2030-12-04', '00:00'), pg_temp.ft('2030-12-06', '00:00')),
  'CAdec vacation 12-04 00:00-12-06 00:00',
  'mark_absence: still one row over that vacation, unchanged'
);

select is(
  pg_temp.mab('ma3', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
              '13c00000-0000-4000-8000-000000000021', pg_temp.ft('2030-12-09', '12:00'), pg_temp.ft('2030-12-10', '00:00')),
  'ok',
  'mark_absence over a partly overlapping time off does not fail'
);

select is(
  (select concat_ws(' | ', pg_temp.l((r ->> 'time_off_id')::uuid), r ->> 'created', r ->> 'extended', r ->> 'reason',
                    pg_temp.lh((r ->> 'starts_at')::timestamptz), pg_temp.lh((r ->> 'ends_at')::timestamptz))
   from pg_temp.r('ma3') as r),
  'CBp9 | false | true | personal | 12-09 08:00 | 12-10 00:00',
  'mark_absence: the overlapping row is extended to the union, its reason kept, extended true'
);

select is(
  pg_temp.toff('13c00000-0000-4000-8000-000000000021', pg_temp.ft('2030-12-09', '00:00'), pg_temp.ft('2030-12-10', '00:00')),
  'CBp9 personal 12-09 08:00-12-10 00:00',
  'mark_absence: no second row was written'
);

select is(
  pg_temp.mab('ma4', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
              '13c00000-0000-4000-8000-000000000020', pg_temp.ft('2030-12-11', '10:00'), pg_temp.ft('2030-12-12', '00:00')),
  'ok',
  'mark_absence over two overlapping time off rows does not fail'
);

select is(
  (select concat_ws(' | ', pg_temp.l((r ->> 'time_off_id')::uuid), r ->> 'created', r ->> 'extended', r ->> 'reason',
                    pg_temp.lh((r ->> 'starts_at')::timestamptz), pg_temp.lh((r ->> 'ends_at')::timestamptz))
   from pg_temp.r('ma4') as r),
  'CAv1 | false | true | vacation | 12-11 09:00 | 12-12 00:00',
  'mark_absence: several overlapping rows are merged into the earliest one (its reason kept)'
);

select is(
  pg_temp.toff('13c00000-0000-4000-8000-000000000020', pg_temp.ft('2030-12-11', '00:00'), pg_temp.ft('2030-12-12', '00:00')),
  'CAo0 other 12-11 07:00-12-11 08:00, CAv1 vacation 12-11 09:00-12-12 00:00',
  'mark_absence: the later overlapping row is gone; a row that does not overlap the window is untouched'
);

select is(
  pg_temp.mab('ma5', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
              '13c00000-0000-4000-8000-000000000021', pg_temp.ft('2030-12-16', '12:00'), pg_temp.ft('2030-12-17', '00:00')),
  'ok',
  'mark_absence right after a time off that ends at its start does not fail'
);

select is(
  (select concat_ws(' | ', r ->> 'created', r ->> 'extended',
                    (select count(*) from public.time_off t
                     where t.staff_id = '13c00000-0000-4000-8000-000000000021'
                       and t.starts_at < pg_temp.ft('2030-12-17', '00:00') and t.ends_at > pg_temp.ft('2030-12-16', '00:00')),
                    (select pg_temp.lh(t.ends_at) from public.time_off t where t.id = '13bb0000-0000-4000-8000-000000000009'))
   from pg_temp.r('ma5') as r),
  'true | false | 2 | 12-16 12:00',
  'mark_absence: a back-to-back time off is not an overlap (a new row; the earlier one keeps its end)'
);

select is(
  concat_ws(' | ',
    pg_temp.mab('ma_e1', '13a00000-0000-4000-8000-000000000022', '13b00000-0000-4000-8000-000000000002',
                '13c00000-0000-4000-8000-000000000021', pg_temp.ft('2031-01-05', '10:00'), pg_temp.ft('2031-01-05', '12:00')),
    pg_temp.mab('ma_e2', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
                '13c00000-0000-4000-8000-000000000029', pg_temp.ft('2031-01-05', '10:00'), pg_temp.ft('2031-01-05', '12:00')),
    pg_temp.mab('ma_e3', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
                '13c00000-0000-4000-8000-000000000021', pg_temp.ft('2031-01-05', '10:00'), pg_temp.ft('2031-01-05', '10:00')),
    pg_temp.mab('ma_e4', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
                '13c00000-0000-4000-8000-000000000021', pg_temp.ft('2031-01-05', '12:00'), pg_temp.ft('2031-01-05', '10:00')),
    pg_temp.mab('ma_e5', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
                '13c00000-0000-4000-8000-000000000021', null, pg_temp.ft('2031-01-05', '12:00')),
    pg_temp.mab('ma_e6', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
                '13c00000-0000-4000-8000-000000000021', pg_temp.ft('2031-01-05', '10:00'), pg_temp.ft('2031-02-06', '10:00')),
    pg_temp.mab('ma_e7', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
                '13c00000-0000-4000-8000-000000000090', pg_temp.ft('2031-01-05', '10:00'), pg_temp.ft('2031-01-05', '12:00')),
    pg_temp.mab('ma_e8', '13a00000-0000-4000-8000-000000000020', '13b00000-0000-4000-8000-000000000002',
                null, pg_temp.ft('2031-01-05', '10:00'), pg_temp.ft('2031-01-05', '12:00'))),
  '42501 | P0001 AN008 | 22023 | 22023 | 22023 | 22023 | 42501 | 42501',
  'mark_absence: a staff caller → 42501; inactive staff → AN008; to = from, to < from, a null bound or more than '
  || '31 days → 22023; a staff id of another business or null → 42501'
);

select is(
  concat_ws(' | ',
    (select count(*) from public.time_off t where t.staff_id = '13c00000-0000-4000-8000-000000000029'),
    (select count(*) from public.time_off t
     where t.business_id = '13b00000-0000-4000-8000-000000000002'
       and t.starts_at < pg_temp.ft('2031-03-01', '00:00') and t.ends_at > pg_temp.ft('2031-01-01', '00:00'))),
  '1 | 0',
  'mark_absence: the refused calls wrote no time off'
);

select is(
  pg_temp.mab('ma6', '13a00000-0000-4000-8000-000000000021', '13b00000-0000-4000-8000-000000000002',
              '13c00000-0000-4000-8000-000000000020', pg_temp.ft('2030-12-18', '12:00'), pg_temp.ft('2030-12-19', '00:00')),
  'ok',
  'mark_absence: the manager may mark an absence'
);

select is(
  pg_temp.r('ma6') ->> 'created',
  'true',
  'mark_absence by the manager writes the leave'
);

-- ---------------------------------------------------------------------------------------------
-- Flow 6 (business A, against now()): AA is absent from now on; AX1 goes to a free colleague
-- without SMS, AX2 (nobody free) is cancelled with SMS, AX3 is handed over with notify.
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', 'system', true);

select is(
  pg_temp.mab('ab1', '13a00000-0000-4000-8000-000000000040', '13b00000-0000-4000-8000-000000000004',
              '13c00000-0000-4000-8000-000000000040', date_trunc('minute', now()), date_trunc('minute', now()) + interval '12 hours'),
  'ok',
  'flow 6: the owner marks AA absent from now on'
);

select is(
  (select concat_ws(' | ', r ->> 'created', r ->> 'reason', pg_temp.conf(r -> 'conflicts')) from pg_temp.r('ab1') as r),
  'true | leave | AX1 time_off, AX2 time_off, AX3 time_off',
  'flow 6: mark_absence writes a leave and returns AA''s three appointments of the window (none of the colleagues'')'
);

select is(
  pg_temp.rca('rcx1', '13a00000-0000-4000-8000-000000000040', '13b00000-0000-4000-8000-000000000004',
              '13aa0000-0000-4000-8000-000000000401'),
  'AB true -, AC true -',
  'flow 6: both colleagues are free at AX1''s time'
);

select is(
  pg_temp.rca('rcx2', '13a00000-0000-4000-8000-000000000040', '13b00000-0000-4000-8000-000000000004',
              '13aa0000-0000-4000-8000-000000000402'),
  'AB false busy, AC false busy',
  'flow 6: nobody is free at AX2''s time'
);

select is(
  pg_temp.mv('mvx1', '13a00000-0000-4000-8000-000000000040', '13b00000-0000-4000-8000-000000000004',
             '13aa0000-0000-4000-8000-000000000401', date_trunc('hour', now()) + interval '3 hours', false,
             '13c00000-0000-4000-8000-000000000041'),
  'ok',
  'flow 6: AX1 is handed over to AB at the same time, notify off'
);

select is(
  (select concat_ws(' | ', pg_temp.l((r ->> 'staff_id')::uuid),
                    ((r ->> 'starts_at')::timestamptz = date_trunc('hour', now()) + interval '3 hours')::text,
                    r ->> 'notify', r ->> 'sms_queued')
   from pg_temp.r('mvx1') as r),
  'AB | true | false | false',
  'flow 6: the hand-over keeps the time; notify false, no SMS queued'
);

select is(
  concat_ws(' | ',
    (select count(*) from public.messages_log m
     where m.appointment_id = '13aa0000-0000-4000-8000-000000000401' and m.channel = 'sms'),
    (select count(*) from public.messages_log m
     where m.appointment_id = '13aa0000-0000-4000-8000-000000000401' and m.template = 'rescheduled_by_business')),
  '0 | 0',
  'flow 6: a hand-over without notify writes no rescheduled_by_business (no SMS at all)'
);

select is(
  pg_temp.cn('cnx2', '13a00000-0000-4000-8000-000000000040', '13b00000-0000-4000-8000-000000000004',
             '13aa0000-0000-4000-8000-000000000402', true),
  'ok',
  'flow 6: AX2 is cancelled with notify (staff_unavailable)'
);

select is(
  (select concat_ws(' | ', r ->> 'changed', r ->> 'notify', r ->> 'sms_queued', r ->> 'cancelled_by', r ->> 'cancel_reason')
   from pg_temp.r('cnx2') as r),
  'true | true | true | business | staff_unavailable',
  'flow 6: the cancel answers sms_queued true'
);

select is(
  pg_temp.sms('13aa0000-0000-4000-8000-000000000402'),
  'cancelled_by_business queued +306900130042',
  'flow 6: cancel with notify → exactly one SMS row, cancelled_by_business, to the client''s mobile'
);

select is(
  pg_temp.cn('cnx2b', '13a00000-0000-4000-8000-000000000040', '13b00000-0000-4000-8000-000000000004',
             '13aa0000-0000-4000-8000-000000000402', true),
  'ok',
  'flow 6: the same cancel again answers'
);

select is(
  concat_ws(' | ', pg_temp.r('cnx2b') ->> 'changed',
            (select count(*) from public.messages_log m
             where m.appointment_id = '13aa0000-0000-4000-8000-000000000402' and m.channel = 'sms')),
  'false | 1',
  'flow 6: the repeated cancel changes nothing and still one SMS'
);

select is(
  pg_temp.mv('mvx3', '13a00000-0000-4000-8000-000000000040', '13b00000-0000-4000-8000-000000000004',
             '13aa0000-0000-4000-8000-000000000403', date_trunc('hour', now()) + interval '5 hours', true,
             '13c00000-0000-4000-8000-000000000041'),
  'ok',
  'flow 6: AX3 is handed over to AB with notify'
);

select is(
  (select concat_ws(' | ', pg_temp.l((r ->> 'staff_id')::uuid), r ->> 'sms_queued') from pg_temp.r('mvx3') as r),
  'AB | true',
  'flow 6: the hand-over with notify answers sms_queued true'
);

select is(
  concat_ws(' | ',
    (select count(*) from public.messages_log m
     where m.appointment_id = '13aa0000-0000-4000-8000-000000000403' and m.channel = 'sms'),
    (select count(*) from public.messages_log m
     where m.appointment_id = '13aa0000-0000-4000-8000-000000000403' and m.template = 'rescheduled_by_business')),
  '1 | 1',
  'flow 6: a hand-over with notify → exactly one SMS, rescheduled_by_business'
);

select is(
  pg_temp.appts(array['13aa0000-0000-4000-8000-000000000401', '13aa0000-0000-4000-8000-000000000402',
                      '13aa0000-0000-4000-8000-000000000403']::uuid[]),
  'AX1 booked AB, AX2 cancelled AA, AX3 booked AB',
  'flow 6: AX1 and AX3 are AB''s, AX2 is cancelled'
);

select is(
  pg_temp.mab('ab2', '13a00000-0000-4000-8000-000000000040', '13b00000-0000-4000-8000-000000000004',
              '13c00000-0000-4000-8000-000000000040', date_trunc('minute', now()), date_trunc('minute', now()) + interval '12 hours'),
  'ok',
  'flow 6: running the absence again does not fail'
);

select is(
  (select concat_ws(' | ', r ->> 'created', r ->> 'extended', pg_temp.conf(r -> 'conflicts'),
                    (select count(*) from public.time_off t where t.staff_id = '13c00000-0000-4000-8000-000000000040'))
   from pg_temp.r('ab2') as r),
  'false | false | - | 1',
  'flow 6 again: nothing new is written, one leave, and nothing is left to resolve'
);

-- ---------------------------------------------------------------------------------------------
-- reassign_candidates (business K, 2030-11; owner UK0 unless noted)
--   R1 KA 11-19 10:00 Beard (20′ + 10′): KB free · KC busy (10:00) · KD does not offer Beard ·
--   KE on vacation 09–12 · KF's 09:30 appointment + 15′ buffer reaches 10:15 · KI inactive
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', 'system', true);

select is(
  pg_temp.rca('rc1', '13a00000-0000-4000-8000-000000000050', '13b00000-0000-4000-8000-000000000005',
              '13aa0000-0000-4000-8000-000000000501'),
  'KB true -, KC false busy, KD false not_offered, KE false off, KF false tight',
  'reassign_candidates: every active colleague by sort with free/busy/not_offered/off/tight; not the appointment''s '
  || 'own staff member, not the inactive one'
);

select ok(
  (select bool_and(pg_temp.keys(c) = array['blocker', 'free', 'staff_id']) and count(*) = 5
   from jsonb_array_elements(pg_temp.r('rc1')) as c),
  'reassign_candidates: a row has exactly staff_id, free and blocker'
);

select is(
  pg_temp.rca('rc2', '13a00000-0000-4000-8000-000000000050', '13b00000-0000-4000-8000-000000000005',
              '13aa0000-0000-4000-8000-000000000504'),
  'KB true -, KC true -, KD true -, KE true -, KF true -',
  'reassign_candidates: an appointment off the 15′ grid (10:40) still finds the free colleagues'
);

select is(
  pg_temp.mv('mvr2', '13a00000-0000-4000-8000-000000000050', '13b00000-0000-4000-8000-000000000005',
             '13aa0000-0000-4000-8000-000000000504', pg_temp.ft('2030-11-20', '10:40'), false,
             '13c00000-0000-4000-8000-000000000051'),
  'ok',
  'reassign_candidates: a free answer off the grid is a move staff_move_appointment accepts'
);

select is(
  (select concat_ws(' | ', pg_temp.l(a.staff_id), pg_temp.lh(a.starts_at), a.status)
   from public.appointments a where a.id = '13aa0000-0000-4000-8000-000000000504'),
  'KB | 11-20 10:40 | booked',
  'reassign_candidates: the off-grid appointment is now KB''s, at the same time'
);

select is(
  concat_ws(' | ',
    pg_temp.call('rc_s1', '13a00000-0000-4000-8000-000000000053',
                 pg_temp.tab($q$public.reassign_candidates('13b00000-0000-4000-8000-000000000005', '13aa0000-0000-4000-8000-000000000501')$q$)),
    pg_temp.call('rc_s2', '13a00000-0000-4000-8000-000000000052',
                 pg_temp.tab($q$public.reassign_candidates('13b00000-0000-4000-8000-000000000005', '13aa0000-0000-4000-8000-000000000501')$q$)),
    pg_temp.call('rc_m', '13a00000-0000-4000-8000-000000000051',
                 pg_temp.tab($q$public.reassign_candidates('13b00000-0000-4000-8000-000000000005', '13aa0000-0000-4000-8000-000000000501')$q$))),
  '42501 | ok | ok',
  'reassign_candidates: a staff member on a colleague''s appointment → 42501; on their own and the manager → rows'
);

select is(
  concat_ws(' | ',
    pg_temp.rca('rc_e1', '13a00000-0000-4000-8000-000000000050', '13b00000-0000-4000-8000-000000000005',
                '13aa0000-0000-4000-8000-000000000505'),
    pg_temp.rca('rc_e2', '13a00000-0000-4000-8000-000000000050', '13b00000-0000-4000-8000-000000000005',
                '13aa0000-0000-4000-8000-000000000506'),
    pg_temp.rca('rc_e3', '13a00000-0000-4000-8000-000000000050', '13b00000-0000-4000-8000-000000000005',
                '13aa0000-0000-4000-8000-000000000901'),
    pg_temp.rca('rc_e4', '13a00000-0000-4000-8000-000000000050', '13b00000-0000-4000-8000-000000000005', null)),
  'P0001 AN020 | P0001 AN020 | 42501 | 42501',
  'reassign_candidates: cancelled or completed → AN020; an appointment of another business or null → 42501'
);

-- ---------------------------------------------------------------------------------------------
-- reassign_appointment (business K; owner UK0 unless noted). The conflict row the owner sees can
-- be stale: another device (the manager UKM) moves R5 to 15:00 and hands R6 to KC; the owner's
-- «Ανάθεση: KB» from the old row must not move them back (AN021, nothing changes). R7 is where it
-- was seen.
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', 'system', true);

select is(
  concat_ws(' | ',
    pg_temp.mv('rea_m5', '13a00000-0000-4000-8000-000000000051', '13b00000-0000-4000-8000-000000000005',
               '13aa0000-0000-4000-8000-000000000507', pg_temp.ft('2030-11-26', '15:00'), false,
               '13c00000-0000-4000-8000-000000000050'),
    pg_temp.rea('rea5', '13a00000-0000-4000-8000-000000000050', '13aa0000-0000-4000-8000-000000000507',
                '13fe0000-0000-4000-8000-000000000005', '13c00000-0000-4000-8000-000000000050',
                pg_temp.ft('2030-11-26', '10:00'), '13c00000-0000-4000-8000-000000000051', false)),
  'ok | P0001 AN021',
  'reassign_appointment: the appointment was moved to another time meanwhile → AN021'
);

select is(
  (select concat_ws(' | ', pg_temp.l(a.staff_id), pg_temp.lh(a.starts_at), a.status)
   from public.appointments a where a.id = '13aa0000-0000-4000-8000-000000000507'),
  'KA | 11-26 15:00 | booked',
  'reassign_appointment: after AN021 the appointment stays where the other device put it (not back at 10:00)'
);

select is(
  concat_ws(' | ',
    pg_temp.mv('rea_m6', '13a00000-0000-4000-8000-000000000051', '13b00000-0000-4000-8000-000000000005',
               '13aa0000-0000-4000-8000-000000000508', pg_temp.ft('2030-11-27', '10:00'), false,
               '13c00000-0000-4000-8000-000000000052'),
    pg_temp.rea('rea6', '13a00000-0000-4000-8000-000000000050', '13aa0000-0000-4000-8000-000000000508',
                '13fe0000-0000-4000-8000-000000000006', '13c00000-0000-4000-8000-000000000050',
                pg_temp.ft('2030-11-27', '10:00'), '13c00000-0000-4000-8000-000000000051', false)),
  'ok | P0001 AN021',
  'reassign_appointment: handed to another colleague meanwhile → AN021'
);

select is(
  (select concat_ws(' | ', pg_temp.l(a.staff_id), pg_temp.lh(a.starts_at), a.status)
   from public.appointments a where a.id = '13aa0000-0000-4000-8000-000000000508'),
  'KC | 11-27 10:00 | booked',
  'reassign_appointment: after AN021 the appointment stays KC''s'
);

select is(
  pg_temp.rea('rea7', '13a00000-0000-4000-8000-000000000050', '13aa0000-0000-4000-8000-000000000509',
              '13fe0000-0000-4000-8000-000000000007', '13c00000-0000-4000-8000-000000000050',
              pg_temp.ft('2030-11-28', '10:00'), '13c00000-0000-4000-8000-000000000051', false),
  'ok',
  'reassign_appointment: where it was seen → handed over'
);

select is(
  (select concat_ws(' | ', pg_temp.l((r ->> 'staff_id')::uuid), pg_temp.lh((r ->> 'starts_at')::timestamptz),
                    pg_temp.l((r ->> 'from_staff_id')::uuid), r ->> 'replayed', r ->> 'notify',
                    (select concat_ws(' ', pg_temp.l(a.staff_id), pg_temp.lh(a.starts_at), a.status)
                     from public.appointments a where a.id = '13aa0000-0000-4000-8000-000000000509'))
   from pg_temp.r('rea7') as r),
  'KB | 11-28 10:00 | KA | false | false | KB 11-28 10:00 booked',
  'reassign_appointment: the staff_move_appointment answer; KB at the same time'
);

select is(
  concat_ws(' | ',
    pg_temp.rea('rea7b', '13a00000-0000-4000-8000-000000000050', '13aa0000-0000-4000-8000-000000000509',
                '13fe0000-0000-4000-8000-000000000007', '13c00000-0000-4000-8000-000000000050',
                pg_temp.ft('2030-11-28', '10:00'), '13c00000-0000-4000-8000-000000000051', false),
    pg_temp.r('rea7b') ->> 'replayed',
    pg_temp.rea('rea7c', '13a00000-0000-4000-8000-000000000050', '13aa0000-0000-4000-8000-000000000509',
                '13fe0000-0000-4000-8000-000000000077', '13c00000-0000-4000-8000-000000000050',
                pg_temp.ft('2030-11-28', '10:00'), '13c00000-0000-4000-8000-000000000051', false),
    pg_temp.rea('rea_s', '13a00000-0000-4000-8000-000000000053', '13aa0000-0000-4000-8000-000000000507',
                '13fe0000-0000-4000-8000-000000000010', '13c00000-0000-4000-8000-000000000050',
                pg_temp.ft('2030-11-26', '15:00'), '13c00000-0000-4000-8000-000000000051', false),
    pg_temp.rea('rea_n', '13a00000-0000-4000-8000-000000000050', '13aa0000-0000-4000-8000-000000000507',
                '13fe0000-0000-4000-8000-000000000011', '13c00000-0000-4000-8000-000000000050',
                pg_temp.ft('2030-11-26', '15:00'), null, false),
    pg_temp.rea('rea_c', '13a00000-0000-4000-8000-000000000050', '13aa0000-0000-4000-8000-000000000505',
                '13fe0000-0000-4000-8000-000000000012', '13c00000-0000-4000-8000-000000000050',
                pg_temp.ft('2030-11-21', '10:00'), '13c00000-0000-4000-8000-000000000051', false),
    pg_temp.rea('rea_f', '13a00000-0000-4000-8000-000000000050', '13aa0000-0000-4000-8000-000000000901',
                '13fe0000-0000-4000-8000-000000000013', '13c00000-0000-4000-8000-000000000050',
                pg_temp.ft('2030-11-26', '15:00'), '13c00000-0000-4000-8000-000000000051', false)),
  'ok | true | P0001 AN021 | 42501 | 22023 | P0001 AN020 | 42501',
  'reassign_appointment: the retry with the same key replays the committed answer; a new key with the old row → '
  || 'AN021; staff on a colleague''s appointment → 42501; no colleague → 22023; cancelled → AN020; another '
  || 'business''s appointment → 42501'
);

-- ---------------------------------------------------------------------------------------------
-- save_service (business V; owner UV0 unless noted). VS1 sort 0, VS2 sort 3.
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', 'system', true);

select is(
  pg_temp.sav('sv1', '13a00000-0000-4000-8000-000000000060', '13ff0000-0000-4000-8000-000000000001',
              pg_temp.svc('{"name": "  Ξύρισμα  "}'),
              '[{"staff_id": "13c00000-0000-4000-8000-000000000061", "custom_duration_min": 30, "custom_price_cents": 1200},
                {"staff_id": "13c00000-0000-4000-8000-000000000060", "custom_duration_min": null, "custom_price_cents": null}]'),
  'ok',
  'save_service: the owner creates a service with a client-generated id and two staff members'
);

select is(
  (select concat_ws(' | ', r ->> 'created', r ->> 'name', pg_temp.l((r ->> 'category_id')::uuid), r ->> 'duration_min',
                    r ->> 'buffer_after_min', r ->> 'price_cents', r ->> 'online_bookable', r ->> 'active', r ->> 'sort')
   from pg_temp.r('sv1') as r),
  'true | Ξύρισμα | VC1 | 25 | 5 | 1100 | true | true | 4',
  'save_service: created true, the name trimmed, sort = max + 1 of the business'
);

select is(
  pg_temp.keys(pg_temp.r('sv1')),
  array['active', 'buffer_after_min', 'category_id', 'created', 'duration_min', 'id', 'name', 'offers',
        'online_bookable', 'price_cents', 'sort'],
  'save_service: the answer has exactly the keys of §2.5.5'
);

select is(
  pg_temp.offers(pg_temp.r('sv1') -> 'offers'),
  'V1 - -, V2 30 1200',
  'save_service: the offers by staff sort, custom values as sent (null = the service default)'
);

select is(
  (select concat_ws(' | ', s.name, s.sort, pg_temp.offers_of(s.id))
   from public.services s where s.id = '13ff0000-0000-4000-8000-000000000001'),
  'Ξύρισμα | 4 | V1 - -, V2 30 1200',
  'save_service: the service row and its complete staff list are stored'
);

select is(
  pg_temp.sav('sv1b', '13a00000-0000-4000-8000-000000000060', '13ff0000-0000-4000-8000-000000000001',
              pg_temp.svc('{"name": "  Ξύρισμα  "}'),
              '[{"staff_id": "13c00000-0000-4000-8000-000000000061", "custom_duration_min": 30, "custom_price_cents": 1200},
                {"staff_id": "13c00000-0000-4000-8000-000000000060", "custom_duration_min": null, "custom_price_cents": null}]'),
  'ok',
  'save_service: a replay of the same payload answers'
);

select is(
  concat_ws(' | ', pg_temp.r('sv1b') ->> 'created',
            (select count(*) from public.services s where s.id = '13ff0000-0000-4000-8000-000000000001'),
            (select count(*) from public.staff_services ss where ss.service_id = '13ff0000-0000-4000-8000-000000000001'),
            (select s.sort from public.services s where s.id = '13ff0000-0000-4000-8000-000000000001')),
  'false | 1 | 2 | 4',
  'save_service replay: created false, one service, the same two offers, sort unchanged'
);

select is(
  pg_temp.sav('sv2', '13a00000-0000-4000-8000-000000000060', '13ff0000-0000-4000-8000-000000000001',
              pg_temp.svc('{"price_cents": 1150, "category_id": null}'),
              '[{"staff_id": "13c00000-0000-4000-8000-000000000062", "custom_duration_min": 20, "custom_price_cents": null},
                {"staff_id": "13c00000-0000-4000-8000-000000000061", "custom_duration_min": null, "custom_price_cents": 1250}]'),
  'ok',
  'save_service: the owner updates price, category and the staff list'
);

select is(
  (select concat_ws(' | ', r ->> 'created', r ->> 'sort', r ->> 'price_cents', coalesce(r ->> 'category_id', '-'),
                    pg_temp.offers(r -> 'offers'))
   from pg_temp.r('sv2') as r),
  'false | 4 | 1150 | - | V2 - 1250, V3 20 -',
  'save_service update: created false, sort unchanged, no category, the offers exactly as sent'
);

select is(
  (select concat_ws(' | ', s.price_cents, coalesce(s.category_id::text, '-'), pg_temp.offers_of(s.id))
   from public.services s where s.id = '13ff0000-0000-4000-8000-000000000001'),
  '1150 | - | V2 - 1250, V3 20 -',
  'save_service update: the staff list is replaced (V1 removed, V2 changed, V3 added)'
);

select is(
  concat_ws(' | ',
    pg_temp.sav('sv_e1', '13a00000-0000-4000-8000-000000000060', '13ff0000-0000-4000-8000-000000000002',
                pg_temp.svc('{"category_id": "13f00000-0000-4000-8000-000000000090"}'), '[]'),
    pg_temp.sav('sv_e2', '13a00000-0000-4000-8000-000000000060', '13ff0000-0000-4000-8000-000000000002', pg_temp.svc(),
                '[{"staff_id": "13c00000-0000-4000-8000-000000000090", "custom_duration_min": null, "custom_price_cents": null}]'),
    pg_temp.sav('sv_e3', '13a00000-0000-4000-8000-000000000060', '13e00000-0000-4000-8000-000000000090', pg_temp.svc(), '[]'),
    pg_temp.sav('sv_e4', '13a00000-0000-4000-8000-000000000060', '13ff0000-0000-4000-8000-000000000002', pg_temp.svc(),
                '[{"staff_id": "13c00000-0000-4000-8000-000000000060", "custom_duration_min": null, "custom_price_cents": null},
                  {"staff_id": "13c00000-0000-4000-8000-000000000060", "custom_duration_min": null, "custom_price_cents": null}]'),
    pg_temp.sav('sv_e5', '13a00000-0000-4000-8000-000000000060', '13ff0000-0000-4000-8000-000000000002',
                pg_temp.svc('{"color": "#000000"}'), '[]'),
    pg_temp.sav('sv_e6', '13a00000-0000-4000-8000-000000000060', '13ff0000-0000-4000-8000-000000000002',
                pg_temp.svc('{}', 'active'), '[]'),
    pg_temp.sav('sv_e7', '13a00000-0000-4000-8000-000000000060', '13ff0000-0000-4000-8000-000000000002', pg_temp.svc(), '{}'),
    pg_temp.sav('sv_e8', '13a00000-0000-4000-8000-000000000060', '13ff0000-0000-4000-8000-000000000002', pg_temp.svc(),
                '[{"staff_id": "13c00000-0000-4000-8000-000000000060", "custom_duration_min": null, "custom_price_cents": null, "sort": 1}]'),
    pg_temp.sav('sv_e9', '13a00000-0000-4000-8000-000000000060', null, pg_temp.svc(), '[]'),
    pg_temp.sav('sv_e10', '13a00000-0000-4000-8000-000000000060', '13ff0000-0000-4000-8000-000000000002',
                pg_temp.svc('{"price_cents": -1}'), '[]'),
    pg_temp.sav('sv_e11', '13a00000-0000-4000-8000-000000000060', '13ff0000-0000-4000-8000-000000000002',
                pg_temp.svc('{"duration_min": 4}'), '[]')),
  '42501 | 42501 | 42501 | 22023 | 22023 | 22023 | 22023 | 22023 | 22023 | 23514 | 23514',
  'save_service: a category, a staff member or a service of another business → 42501; the same staff twice, an '
  || 'extra or missing key, offers not an array, an extra offer key, a null id → 22023; price −1 or 4′ → 23514'
);

select is(
  concat_ws(' | ',
    (select count(*) from public.services s where s.business_id = '13b00000-0000-4000-8000-000000000006'),
    (exists (select 1 from public.services s where s.id = '13ff0000-0000-4000-8000-000000000002'))::text,
    (select s.name from public.services s where s.id = '13e00000-0000-4000-8000-000000000090')),
  '3 | false | Other cut',
  'save_service: the refused calls created and changed nothing'
);

select is(
  pg_temp.sav('sv_s', '13a00000-0000-4000-8000-000000000062', '13ff0000-0000-4000-8000-000000000003',
              pg_temp.svc('{"name": "Περιποίηση", "category_id": "13f00000-0000-4000-8000-000000000061"}'), '[]'),
  '42501',
  'save_service: a staff member cannot change the catalogue (42501)'
);

select is(
  pg_temp.sav('sv_m', '13a00000-0000-4000-8000-000000000061', '13ff0000-0000-4000-8000-000000000003',
              pg_temp.svc('{"name": "Περιποίηση", "category_id": "13f00000-0000-4000-8000-000000000061"}'), '[]'),
  'ok',
  'save_service: the manager may create a service (without staff)'
);

select is(
  concat_ws(' | ', pg_temp.r('sv_m') ->> 'created', pg_temp.r('sv_m') ->> 'sort',
            (select count(*) from public.staff_services ss where ss.service_id = '13ff0000-0000-4000-8000-000000000003')),
  'true | 5 | 0',
  'save_service by the manager: created, sort = max + 1, an empty staff list'
);

-- ---------------------------------------------------------------------------------------------
-- set_staff_order (business V: V1 0, V2 1, V3 2, V4 inactive 3)
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', 'system', true);

select is(
  pg_temp.sso('so1', '13a00000-0000-4000-8000-000000000060',
              array['13c00000-0000-4000-8000-000000000062', '13c00000-0000-4000-8000-000000000060',
                    '13c00000-0000-4000-8000-000000000063', '13c00000-0000-4000-8000-000000000061']::uuid[]),
  'ok',
  'set_staff_order: the owner sends a new order of all staff (inactive included)'
);

select is(
  pg_temp.order_rows(pg_temp.r('so1')),
  'V3 0, V1 1, V4 2, V2 3',
  'set_staff_order: the answer is [{id, sort}] in the new order, sort = position − 1'
);

select is(
  pg_temp.sorts('13b00000-0000-4000-8000-000000000006'),
  'V3 0, V1 1, V4 2, V2 3',
  'set_staff_order: the stored sorts follow'
);

select is(
  pg_temp.sso('so1b', '13a00000-0000-4000-8000-000000000060',
              array['13c00000-0000-4000-8000-000000000062', '13c00000-0000-4000-8000-000000000060',
                    '13c00000-0000-4000-8000-000000000063', '13c00000-0000-4000-8000-000000000061']::uuid[]),
  'ok',
  'set_staff_order: the same list again answers'
);

select is(
  (pg_temp.r('so1b') = pg_temp.r('so1'))::text,
  'true',
  'set_staff_order: the same list gives the same result'
);

select is(
  concat_ws(' | ',
    pg_temp.sso('so_e1', '13a00000-0000-4000-8000-000000000060',
                array['13c00000-0000-4000-8000-000000000062', '13c00000-0000-4000-8000-000000000060',
                      '13c00000-0000-4000-8000-000000000063']::uuid[]),
    pg_temp.sso('so_e2', '13a00000-0000-4000-8000-000000000060',
                array['13c00000-0000-4000-8000-000000000062', '13c00000-0000-4000-8000-000000000060',
                      '13c00000-0000-4000-8000-000000000063', '13c00000-0000-4000-8000-000000000061',
                      '13c00000-0000-4000-8000-000000000061']::uuid[]),
    pg_temp.sso('so_e3', '13a00000-0000-4000-8000-000000000060', null),
    pg_temp.sso('so_e4', '13a00000-0000-4000-8000-000000000060',
                array['13c00000-0000-4000-8000-000000000062', '13c00000-0000-4000-8000-000000000060',
                      '13c00000-0000-4000-8000-000000000063', '13c00000-0000-4000-8000-000000000090']::uuid[]),
    pg_temp.sso('so_e5', '13a00000-0000-4000-8000-000000000062',
                array['13c00000-0000-4000-8000-000000000060', '13c00000-0000-4000-8000-000000000061',
                      '13c00000-0000-4000-8000-000000000062', '13c00000-0000-4000-8000-000000000063']::uuid[])),
  '22023 | 22023 | 22023 | 42501 | 42501',
  'set_staff_order: a missing id, a duplicate or a null list → 22023; a staff id of another business → 42501; '
  || 'a staff caller → 42501'
);

select is(
  pg_temp.sorts('13b00000-0000-4000-8000-000000000006'),
  'V3 0, V1 1, V4 2, V2 3',
  'set_staff_order: the refused calls changed no sort'
);

select is(
  pg_temp.sso('so2', '13a00000-0000-4000-8000-000000000061',
              array['13c00000-0000-4000-8000-000000000060', '13c00000-0000-4000-8000-000000000061',
                    '13c00000-0000-4000-8000-000000000062', '13c00000-0000-4000-8000-000000000063']::uuid[]),
  'ok',
  'set_staff_order: the manager may reorder'
);

select is(
  pg_temp.sorts('13b00000-0000-4000-8000-000000000006'),
  'V1 0, V2 1, V3 2, V4 3',
  'set_staff_order by the manager: stored'
);

-- ---------------------------------------------------------------------------------------------
-- Grants after 0008 (§2.3), as the owner UV0 and the staff member UV1 of V
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', 'system', true);

select is(
  pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
    $q$insert into public.staff (id, business_id, display_name, color, sort, active)
       values ('13c00000-0000-4000-8000-000000000064', '13b00000-0000-4000-8000-000000000006', 'V5', '#336699', 4, true)$q$),
  '1',
  'staff: the owner inserts a staff member with id, business_id, display_name, color, sort, active'
);

select is(
  pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
    $q$update public.staff set display_name = 'V5b', color = '#123456', active = false
       where id = '13c00000-0000-4000-8000-000000000064'$q$),
  '1',
  'staff: the owner updates display_name, color and active'
);

select is(
  concat_ws(' | ',
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$update public.staff set sort = 9 where id = '13c00000-0000-4000-8000-000000000064'$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$update public.staff set photo_url = 'https://example.test/p.png' where id = '13c00000-0000-4000-8000-000000000064'$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$delete from public.staff where id = '13c00000-0000-4000-8000-000000000064'$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$insert into public.staff (business_id, display_name, photo_url)
         values ('13b00000-0000-4000-8000-000000000006', 'V6', 'https://example.test/p.png')$q$)),
  '42501 | 42501 | 42501 | 42501',
  'staff: no direct update of sort (set_staff_order) or photo_url, no delete (deactivate instead), no photo_url on insert'
);

select is(
  concat_ws(' | ',
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$insert into public.services (business_id, name, duration_min, price_cents)
         values ('13b00000-0000-4000-8000-000000000006', 'Direct', 30, 1000)$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$update public.services set price_cents = 0 where id = '13e00000-0000-4000-8000-000000000060'$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$delete from public.services where id = '13e00000-0000-4000-8000-000000000061'$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$insert into public.staff_services (business_id, staff_id, service_id)
         values ('13b00000-0000-4000-8000-000000000006', '13c00000-0000-4000-8000-000000000062', '13e00000-0000-4000-8000-000000000060')$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$delete from public.staff_services where service_id = '13e00000-0000-4000-8000-000000000060'$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$insert into public.service_categories (business_id, name) values ('13b00000-0000-4000-8000-000000000006', 'Direct')$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$update public.service_categories set name = 'Renamed' where id = '13f00000-0000-4000-8000-000000000060'$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$delete from public.service_categories where id = '13f00000-0000-4000-8000-000000000061'$q$)),
  '42501 | 42501 | 42501 | 42501 | 42501 | 42501 | 42501 | 42501',
  'catalogue: the owner has no direct insert/update/delete on services, staff_services or service_categories'
);

select is(
  concat_ws(' | ',
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$insert into public.schedule_exceptions (id, business_id, staff_id, local_date, kind, start_time, end_time, note)
         values ('13cc0000-0000-4000-8000-000000000060', '13b00000-0000-4000-8000-000000000006', null, '2030-12-25',
                 'closed', null, null, 'Χριστούγεννα')$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$update public.schedule_exceptions set note = 'Αργία' where id = '13cc0000-0000-4000-8000-000000000060'$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$delete from public.schedule_exceptions where id = '13cc0000-0000-4000-8000-000000000060'$q$)),
  '1 | 42501 | 1',
  'schedule_exceptions: the owner inserts (with a client id) and deletes, never updates'
);

select is(
  concat_ws(' | ',
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$insert into public.time_off (id, business_id, staff_id, starts_at, ends_at, reason)
         values ('13bb0000-0000-4000-8000-000000000060', '13b00000-0000-4000-8000-000000000006',
                 '13c00000-0000-4000-8000-000000000062', '2030-12-01 00:00Z', '2030-12-02 00:00Z', 'vacation')$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$update public.time_off set starts_at = '2030-12-01 06:00Z', ends_at = '2030-12-03 00:00Z', reason = 'personal'
         where id = '13bb0000-0000-4000-8000-000000000060'$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$update public.time_off set created_at = now() where id = '13bb0000-0000-4000-8000-000000000060'$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000062',
      $q$insert into public.time_off (business_id, staff_id, starts_at, ends_at, reason)
         values ('13b00000-0000-4000-8000-000000000006', '13c00000-0000-4000-8000-000000000061',
                 '2030-12-10 00:00Z', '2030-12-11 00:00Z', 'vacation')$q$)),
  '1 | 1 | 42501 | 42501',
  'time_off: the owner inserts and updates starts_at, ends_at and reason, not created_at; a staff member cannot '
  || 'record time off, not even their own'
);

select is(
  concat_ws(' | ',
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$update public.businesses set theme = '{"brand": "#000000"}' where id = '13b00000-0000-4000-8000-000000000006'$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000060',
      $q$update public.businesses set name = 'Sched Ops Catalogue 2' where id = '13b00000-0000-4000-8000-000000000006'$q$)),
  '42501 | 1',
  'businesses: the owner can no longer update the theme (script only) but still the name'
);

select is(
  concat_ws(' | ',
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000062',
      $q$insert into public.staff (business_id, display_name) values ('13b00000-0000-4000-8000-000000000006', 'Intruder')$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000062',
      $q$update public.staff set display_name = 'Me' where id = '13c00000-0000-4000-8000-000000000061'$q$),
    pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000062',
      $q$update public.businesses set slot_step_min = 30 where id = '13b00000-0000-4000-8000-000000000006'$q$)),
  '42501 | 0 | 0',
  'a staff member cannot add staff, and their staff-row and booking-policy updates reach no row'
);

select is(
  concat_ws(' | ',
    (select s.sort || ' ' || s.display_name || ' ' || s.active::text from public.staff s where s.id = '13c00000-0000-4000-8000-000000000064'),
    (select b.slot_step_min || ' ' || b.theme::text from public.businesses b where b.id = '13b00000-0000-4000-8000-000000000006'),
    (select s.display_name from public.staff s where s.id = '13c00000-0000-4000-8000-000000000061')),
  '4 V5b false | 15 {} | V2',
  'grants: the refused writes left sort, policy, theme and the staff row as they were'
);

-- ---------------------------------------------------------------------------------------------
-- Re-plan of queued reminders (D6)
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', 'system', true);

select is(
  pg_temp.replan('13b00000-0000-4000-8000-000000000008', pg_temp.ft('2030-11-19', '12:00')),
  '3',
  'replan_reminders_impl: returns the number of rows it changed (r1, r2, r9)'
);

select is(
  (select string_agg(pg_temp.l(m.id) || ' ' || m.status || ' ' || coalesce(m.error, '-') || ' ' || pg_temp.lh(m.scheduled_for),
                     ', ' order by pg_temp.l(m.id) collate "C")
   from public.messages_log m
   where m.business_id in ('13b00000-0000-4000-8000-000000000008', '13b00000-0000-4000-8000-000000000009')),
  'r1 cancelled superseded 11-19 14:00, r2 queued - 11-20 20:00, r3 queued - 11-20 10:00, r4 queued - 11-21 14:00, '
  || 'r5 queued - 11-19 11:30, r6 sent - 11-22 14:00, r7 queued - 11-22 15:00, r8 queued - 11-20 15:00, '
  || 'r9 cancelled superseded 11-19 13:00, rX queued - 11-19 14:00',
  'replan: a new time already past (quiet hours) or none at all (planned < 26 h before) → cancelled superseded, '
  || 'never sent late; a stale time moves; retries, due, sent, non-reminder rows, cancelled appointments and '
  || 'another business are untouched'
);

select is(
  (select string_agg(pg_temp.l(m.id), ', ' order by pg_temp.l(m.id) collate "C")
   from public.messages_log m
   where m.business_id in ('13b00000-0000-4000-8000-000000000008', '13b00000-0000-4000-8000-000000000009')
     and m.updated_at = pg_temp.ft('2030-11-19', '12:00')),
  'r1, r2, r9',
  'replan: updated_at = p_now on the changed rows only'
);

select is(
  pg_temp.replan('13b00000-0000-4000-8000-000000000008', pg_temp.ft('2030-11-19', '12:00')),
  '0',
  'replan: a second run changes nothing'
);

-- The trigger (business P, against now()). m1 is first made stale, so a run of the re-plan shows.
-- Every write is its own statement (pg_temp.keep); the assertion after it reads the effect.
update public.messages_log set scheduled_for = pg_temp.lt(4, '11:00') where id = '13dd0000-0000-4000-8000-000000000011';

select pg_temp.keep('tr1', pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000070',
  $q$update public.businesses set name = 'Sched Ops Replan 2' where id = '13b00000-0000-4000-8000-000000000007'$q$));

select is(
  concat_ws(' | ', current_setting('t.tr1'),
            ((select m.scheduled_for from public.messages_log m where m.id = '13dd0000-0000-4000-8000-000000000011')
               = pg_temp.lt(4, '11:00'))::text),
  '1 | true',
  'trigger: a change of another column (name) does not re-plan'
);

select pg_temp.keep('tr2', pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000070',
  $q$update public.businesses set reminder_mode = 'evening_before' where id = '13b00000-0000-4000-8000-000000000007'$q$));

select is(
  concat_ws(' | ', current_setting('t.tr2'),
            (select (m.scheduled_for = pg_temp.lt(4, '18:00'))::text
                    || ' | ' || (m.scheduled_for = private.reminder_at(a.starts_at, 'Europe/Athens', 'evening_before',
                                                                        time '22:00', time '09:00', m.created_at))::text
                    || ' | ' || (m.updated_at = now())::text
             from public.messages_log m join public.appointments a on a.id = m.appointment_id
             where m.id = '13dd0000-0000-4000-8000-000000000011')),
  '1 | true | true | true',
  'trigger: the owner switches to evening_before → the queued reminder moves to 18:00 of the day before '
  || '(= reminder_at with its planning instant), updated_at = now()'
);

select is(
  (select string_agg(concat_ws(' ', pg_temp.l(m.id),
                               m.updated_at = m.created_at and m.status = x.status and m.scheduled_for = x.at),
                     ', ' order by x.n)
   from (values
     (1, '13dd0000-0000-4000-8000-000000000012'::uuid, 'queued'::text, pg_temp.lt(4, '13:00')),
     (2, '13dd0000-0000-4000-8000-000000000013'::uuid, 'queued'::text, now() - interval '1 minute'),
     (3, '13dd0000-0000-4000-8000-000000000014'::uuid, 'sent'::text, pg_temp.lt(4, '15:00')),
     (4, '13dd0000-0000-4000-8000-000000000010'::uuid, 'queued'::text, pg_temp.ft('2030-11-19', '14:00'))
   ) as x (n, id, status, at)
   join public.messages_log m on m.id = x.id),
  'm2 t, m3 t, m4 t, rX t',
  'trigger: a retry, a due row, a sent row and another business''s reminder are untouched'
);

update public.messages_log set scheduled_for = pg_temp.lt(4, '11:00') where id = '13dd0000-0000-4000-8000-000000000011';

select pg_temp.keep('tr3', pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000070',
  $q$update public.businesses set reminder_mode = 'evening_before' where id = '13b00000-0000-4000-8000-000000000007'$q$));

select is(
  concat_ws(' | ', current_setting('t.tr3'),
            ((select m.scheduled_for from public.messages_log m where m.id = '13dd0000-0000-4000-8000-000000000011')
               = pg_temp.lt(4, '11:00'))::text),
  '1 | true',
  'trigger: writing the same reminder_mode again does not re-plan'
);

select pg_temp.keep('tr4', pg_temp.dml('authenticated', '13a00000-0000-4000-8000-000000000070',
  $q$update public.businesses set quiet_start = '21:00' where id = '13b00000-0000-4000-8000-000000000007'$q$));

select is(
  concat_ws(' | ', current_setting('t.tr4'),
            ((select m.scheduled_for from public.messages_log m where m.id = '13dd0000-0000-4000-8000-000000000011')
               = pg_temp.lt(4, '18:00'))::text),
  '1 | true',
  'trigger: the owner may set quiet_start, and it re-plans'
);

update public.messages_log set scheduled_for = pg_temp.lt(4, '11:00') where id = '13dd0000-0000-4000-8000-000000000011';

select pg_temp.keep('tr5', pg_temp.dml('service_role', null,
  $q$update public.businesses set quiet_end = '08:00' where id = '13b00000-0000-4000-8000-000000000007'$q$));

select is(
  concat_ws(' | ', current_setting('t.tr5'),
            ((select m.scheduled_for from public.messages_log m where m.id = '13dd0000-0000-4000-8000-000000000011')
               = pg_temp.lt(4, '18:00'))::text),
  '1 | true',
  'trigger: a quiet_end change by provisioning (service_role) re-plans too'
);

select * from finish();
rollback;
