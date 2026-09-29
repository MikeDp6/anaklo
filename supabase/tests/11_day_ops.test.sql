-- Day operations of the pro app (phase-1 plan 1.4, contract docs/plans/contracts/1.4-day-ops.md §2):
-- busy_calendar, today_summary, set_appointment_status, cancel_appointment, staff_move_appointment,
-- search_clients, planner v1.1 ('status_changed'), AN021–AN023, auto-complete with its job runs and
-- the pg_cron job. Written from the plan and the contract only (independent author).
--   · Business R ('day-ops-read'): the read RPCs on a fixed, far-future local date (2030-11-19, no
--     interference from the real clock); today_summary_impl gets an explicit p_now.
--   · Business K ('day-ops-shop'): the mutations. They and the 0003 guard trigger read now(), so
--     K's fixtures are relative to now(); auto_complete_impl gets a p_now relative to now() too.
--   · Business L ('day-ops-other'): foreign ids, another auto-complete delay, a foreign client.
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
-- Fixtures are written by the system. Staff steps clear the actor (a declared 'system' would
-- outrank the JWT); auto_complete_impl declares 'system' itself and the setting outlives the call.
select set_config('anaklo.actor_type', 'system', true);
select plan(138);

-- ---------------------------------------------------------------------------------------------
-- Helpers (pg_temp). Results of calls are kept in transaction-local settings 't.<name>'.
-- ---------------------------------------------------------------------------------------------
create temporary table lbl (id uuid primary key, label text not null);

create function pg_temp.r(a_name text)
returns jsonb
language sql
stable
as $fn$
  select nullif(current_setting('t.' || a_name, true), '')::jsonb;
$fn$;

-- Readable name of a fixture id ('-' for null, the uuid itself when unknown).
create function pg_temp.l(a_id uuid)
returns text
language sql
stable
as $fn$
  select case when a_id is null then '-'
              else coalesce((select x.label from pg_temp.lbl x where x.id = a_id), a_id::text) end;
$fn$;

-- Local wall clock (day of month + time) of an instant, in the zone of every fixture business.
create function pg_temp.lt(a_value text)
returns text
language sql
stable
as $fn$
  select to_char(a_value::timestamptz at time zone 'Europe/Athens', 'DD HH24:MI');
$fn$;

-- Business R: the instant of a local time on 2030-11-19 + a_days.
create function pg_temp.rd(a_days integer, a_time time)
returns timestamptz
language sql
stable
as $fn$
  select ((date '2030-11-19' + a_days) + a_time) at time zone 'Europe/Athens';
$fn$;

-- Business K: instants relative to the transaction clock (hour and minute precision).
create function pg_temp.k(a_offset interval)
returns timestamptz
language sql
stable
as $fn$
  select date_trunc('hour', now()) + a_offset;
$fn$;

create function pg_temp.m(a_offset interval)
returns timestamptz
language sql
stable
as $fn$
  select date_trunc('minute', now()) + a_offset;
$fn$;

create function pg_temp.keys(a_object jsonb)
returns text[]
language sql
immutable
as $fn$
  select array_agg(k order by k) from jsonb_object_keys(a_object) as k;
$fn$;

-- '<sqlstate> <message> <hint>' of a domain error.
create function pg_temp.hint(a_code text)
returns text
language plpgsql
as $fn$
declare
  v_hint text;
begin
  perform private.raise_domain_error(a_code);
  return 'no error';
exception when others then
  get stacked diagnostics v_hint = pg_exception_hint;
  return sqlstate || ' ' || sqlerrm || ' ' || coalesce(v_hint, '-');
end;
$fn$;

-- The job runs written between two clock readings (one call of the job).
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

grant execute on function pg_temp.rd(integer, time) to authenticated;
grant execute on function pg_temp.k(interval) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Fixture (as postgres)
--   K 'day-ops-shop' Europe/Athens, auto-complete after 30′, corrections 3 days.
--     SK0 (owner UK0) · SK1 (staff UK1) · SK2 (staff UK2) · UKX staff without a staff row.
--     Everyone works 00:00–24:00 every day (no D8 flags needed); Cut 30′ 13.00, Beard 20′ 8.00.
--   L 'day-ops-other': SL0 (owner UL0), auto-complete after 600′.
--   R 'day-ops-read': R0 (owner UR0) · R1 (staff UR1) · R2 (no member) · R9 inactive · URM manager.
--     2030-11-19: shop exception open 09:00–17:00; R2 time off 10:00–12:00. No weekly hours.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select u.id, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', u.email, '{}'::jsonb, '{}'::jsonb,
       now(), now()
from (values
  ('d0000000-0000-4000-8000-0000000000a0'::uuid, 'owner-k@dayops.test'),
  ('d0000000-0000-4000-8000-0000000000a1'::uuid, 'staff1-k@dayops.test'),
  ('d0000000-0000-4000-8000-0000000000a2'::uuid, 'staff2-k@dayops.test'),
  ('d0000000-0000-4000-8000-0000000000a9'::uuid, 'nostaff-k@dayops.test'),
  ('d0000000-0000-4000-8000-0000000000b0'::uuid, 'owner-l@dayops.test'),
  ('d0000000-0000-4000-8000-0000000000c0'::uuid, 'owner-r@dayops.test'),
  ('d0000000-0000-4000-8000-0000000000c1'::uuid, 'staff1-r@dayops.test'),
  ('d0000000-0000-4000-8000-0000000000c3'::uuid, 'manager-r@dayops.test')
) as u (id, email);

insert into public.businesses (id, slug, name, vertical, timezone, slot_step_min, auto_complete_after_min, correction_window_days) values
  ('d1000000-0000-4000-8000-00000000000a', 'day-ops-shop', 'Day Ops Shop', 'barber', 'Europe/Athens', 15, 30, 3),
  ('d1000000-0000-4000-8000-00000000000b', 'day-ops-other', 'Day Ops Other', 'barber', 'Europe/Athens', 15, 600, 3),
  ('d1000000-0000-4000-8000-00000000000c', 'day-ops-read', 'Day Ops Read', 'barber', 'Europe/Athens', 15, 720, 3);

insert into public.staff (id, business_id, display_name, sort, active) values
  ('d2000000-0000-4000-8000-0000000000a0', 'd1000000-0000-4000-8000-00000000000a', 'SK0', 0, true),
  ('d2000000-0000-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-00000000000a', 'SK1', 1, true),
  ('d2000000-0000-4000-8000-0000000000a2', 'd1000000-0000-4000-8000-00000000000a', 'SK2', 2, true),
  ('d2000000-0000-4000-8000-0000000000b0', 'd1000000-0000-4000-8000-00000000000b', 'SL0', 0, true),
  ('d2000000-0000-4000-8000-0000000000c0', 'd1000000-0000-4000-8000-00000000000c', 'R0', 0, true),
  ('d2000000-0000-4000-8000-0000000000c1', 'd1000000-0000-4000-8000-00000000000c', 'R1', 1, true),
  ('d2000000-0000-4000-8000-0000000000c2', 'd1000000-0000-4000-8000-00000000000c', 'R2', 2, true),
  ('d2000000-0000-4000-8000-0000000000c9', 'd1000000-0000-4000-8000-00000000000c', 'R9', 3, false);

insert into public.business_members (business_id, user_id, role, staff_id) values
  ('d1000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-0000000000a0', 'owner', 'd2000000-0000-4000-8000-0000000000a0'),
  ('d1000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-0000000000a1', 'staff', 'd2000000-0000-4000-8000-0000000000a1'),
  ('d1000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-0000000000a2', 'staff', 'd2000000-0000-4000-8000-0000000000a2'),
  ('d1000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-0000000000a9', 'staff', null),
  ('d1000000-0000-4000-8000-00000000000b', 'd0000000-0000-4000-8000-0000000000b0', 'owner', 'd2000000-0000-4000-8000-0000000000b0'),
  ('d1000000-0000-4000-8000-00000000000c', 'd0000000-0000-4000-8000-0000000000c0', 'owner', 'd2000000-0000-4000-8000-0000000000c0'),
  ('d1000000-0000-4000-8000-00000000000c', 'd0000000-0000-4000-8000-0000000000c1', 'staff', 'd2000000-0000-4000-8000-0000000000c1'),
  ('d1000000-0000-4000-8000-00000000000c', 'd0000000-0000-4000-8000-0000000000c3', 'manager', null);

insert into public.services (id, business_id, name, duration_min, buffer_after_min, price_cents) values
  ('d4000000-0000-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-00000000000a', 'Cut', 30, 0, 1300),
  ('d4000000-0000-4000-8000-0000000000a2', 'd1000000-0000-4000-8000-00000000000a', 'Beard', 20, 0, 800),
  ('d4000000-0000-4000-8000-0000000000b1', 'd1000000-0000-4000-8000-00000000000b', 'Cut', 30, 0, 1200),
  ('d4000000-0000-4000-8000-0000000000c1', 'd1000000-0000-4000-8000-00000000000c', 'Cut', 30, 0, 1300),
  ('d4000000-0000-4000-8000-0000000000c2', 'd1000000-0000-4000-8000-00000000000c', 'Beard', 20, 0, 800);

insert into public.staff_services (business_id, staff_id, service_id)
select st.business_id, st.id, sv.id
from public.staff st
join public.services sv on sv.business_id = st.business_id
where st.business_id in ('d1000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-00000000000b',
                         'd1000000-0000-4000-8000-00000000000c')
  and (st.id <> 'd2000000-0000-4000-8000-0000000000c9' or sv.name = 'Cut');

insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
select st.business_id, st.id, d, time '00:00', time '24:00'
from public.staff st cross join generate_series(0, 6) as d
where st.business_id in ('d1000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-00000000000b');

insert into public.schedule_exceptions (business_id, staff_id, local_date, kind, start_time, end_time) values
  ('d1000000-0000-4000-8000-00000000000c', null, date '2030-11-19', 'open', time '09:00', time '17:00');

insert into public.time_off (business_id, staff_id, starts_at, ends_at, reason) values
  ('d1000000-0000-4000-8000-00000000000c', 'd2000000-0000-4000-8000-0000000000c2',
   pg_temp.rd(0, '10:00'), pg_temp.rd(0, '12:00'), 'personal');

-- Clients. c3 is merged into c1 and keeps the same last four digits (5678); c4 is erased and keeps a
-- stale search_text that would match 'Γιώργος' (only the erased filter can exclude it); cL is of L.
insert into public.clients (id, business_id, full_name, phone_e164, source) values
  ('d3000000-0000-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-00000000000a', 'Γιώργος Παπαδόπουλος', '+306912345678', 'staff'),
  ('d3000000-0000-4000-8000-0000000000a2', 'd1000000-0000-4000-8000-00000000000a', 'Giorgos Latinos', '+306955500011', 'staff'),
  ('d3000000-0000-4000-8000-0000000000a6', 'd1000000-0000-4000-8000-00000000000a', 'Μαρία Νικολάου', '+306956781234', 'staff'),
  ('d3000000-0000-4000-8000-0000000000a7', 'd1000000-0000-4000-8000-00000000000a', 'Τάσος Δοκιμής', '+306900007001', 'staff'),
  ('d3000000-0000-4000-8000-0000000000b1', 'd1000000-0000-4000-8000-00000000000b', 'Γιώργος Άλλος', '+306900009999', 'staff'),
  ('d3000000-0000-4000-8000-0000000000c1', 'd1000000-0000-4000-8000-00000000000c', 'Άννα Λ.', '+306900008001', 'staff'),
  ('d3000000-0000-4000-8000-0000000000c2', 'd1000000-0000-4000-8000-00000000000c', 'Βασίλης Κ.', '+306900008002', 'staff');

insert into public.clients (id, business_id, full_name, phone_e164, source, merged_into_id) values
  ('d3000000-0000-4000-8000-0000000000a3', 'd1000000-0000-4000-8000-00000000000a', 'Γιώργος Διπλός', '+306900005678', 'staff',
   'd3000000-0000-4000-8000-0000000000a1');

insert into public.clients (id, business_id, full_name, phone_e164, source, erased_at) values
  ('d3000000-0000-4000-8000-0000000000a4', 'd1000000-0000-4000-8000-00000000000a', '', null, 'staff', now()),
  ('d3000000-0000-4000-8000-0000000000ce', 'd1000000-0000-4000-8000-00000000000c', '', null, 'staff', now());

update public.clients
set search_text = private.client_search_text('Γιώργος Σβησμένος', '+306900015678')
where id = 'd3000000-0000-4000-8000-0000000000a4';

-- 25 namesakes for the limit of 20 (no phone).
insert into public.clients (business_id, full_name, source)
select 'd1000000-0000-4000-8000-00000000000a', 'Κώστας Σειρά ' || lpad(i::text, 2, '0'), 'staff'
from generate_series(1, 25) as i;

-- Appointments of K (relative to now()):
--   status: st1 SK1 +1d · st2 SK2 in progress · st3 SK1 in progress · st4 SK1 completed 5 days ago
--           (outside the 3-day window) · st5 SK1 cancelled 1 day ago · stL of L
--   cancel: ca1 SK1 +2d (3 manage tokens) · ca2 SK1 ended 2h ago · ca3 SK2 +2d · ca4 SK1 completed
--           6 days ago · ca5 SK1 confirmed +2d 2h
--   move:   mv1 SK1 +3d · mv2 SK2 +3d 2h · mv3 SK1 +4d · mvb SK1 +4d 1h (in the way) · mvc cancelled
--   auto-complete (E = now to the minute − 2h): ac1 SK2 booked ends E · ac2 SK2 confirmed ends E−1h
--           (poisoned in the failing run) · ac3 cancelled · ac4 no_show · ac5 completed (charged
--           9.99) · acp SK0 booked ends E−6h (the first row a run completes) · acL of L ends E
--   visits of c1: v1 completed 10 days ago (SK2) · v2 cancelled 3 days ago · v3 no_show 7 days ago
insert into public.appointments (id, business_id, client_id, staff_id, starts_at, ends_at, buffer_after_min, status,
                                 source, total_cents, charged_cents, cancelled_by, cancel_reason) values
  ('d5000000-0000-4000-8000-000000000101', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a1',
   pg_temp.k('1 day'), pg_temp.k('1 day 30 minutes'), 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000102', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a2',
   now() - interval '10 minutes', now() + interval '20 minutes', 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000103', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a1',
   now() - interval '10 minutes', now() + interval '20 minutes', 0, 'booked', 'walkin', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000104', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a1',
   now() - interval '5 days 30 minutes', now() - interval '5 days', 0, 'completed', 'phone', 1300, 1500, null, null),
  ('d5000000-0000-4000-8000-000000000105', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a1',
   now() - interval '1 day 30 minutes', now() - interval '1 day', 0, 'cancelled', 'phone', 1300, null, 'business', 'other'),
  ('d5000000-0000-4000-8000-000000000109', 'd1000000-0000-4000-8000-00000000000b', null, 'd2000000-0000-4000-8000-0000000000b0',
   pg_temp.k('1 day'), pg_temp.k('1 day 30 minutes'), 0, 'booked', 'walkin', 1200, null, null, null),

  ('d5000000-0000-4000-8000-000000000201', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a1',
   pg_temp.k('2 days'), pg_temp.k('2 days 30 minutes'), 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000202', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a1',
   now() - interval '2 hours 30 minutes', now() - interval '2 hours', 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000203', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a2',
   pg_temp.k('2 days'), pg_temp.k('2 days 30 minutes'), 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000204', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a1',
   now() - interval '6 days 30 minutes', now() - interval '6 days', 0, 'completed', 'phone', 1300, 1300, null, null),
  ('d5000000-0000-4000-8000-000000000205', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a1',
   pg_temp.k('2 days 2 hours'), pg_temp.k('2 days 2 hours 30 minutes'), 0, 'confirmed', 'phone', 1300, null, null, null),

  ('d5000000-0000-4000-8000-000000000301', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a1',
   pg_temp.k('3 days'), pg_temp.k('3 days 30 minutes'), 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000302', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a2',
   pg_temp.k('3 days 2 hours'), pg_temp.k('3 days 2 hours 30 minutes'), 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000303', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a1',
   pg_temp.k('4 days'), pg_temp.k('4 days 30 minutes'), 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000304', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a1',
   pg_temp.k('4 days 1 hour'), pg_temp.k('4 days 1 hour 30 minutes'), 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000305', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a1',
   pg_temp.k('5 days'), pg_temp.k('5 days 30 minutes'), 0, 'cancelled', 'phone', 1300, null, 'business', 'other'),

  ('d5000000-0000-4000-8000-000000000401', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a2',
   pg_temp.m('-150 minutes'), pg_temp.m('-120 minutes'), 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000402', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a2',
   pg_temp.m('-210 minutes'), pg_temp.m('-180 minutes'), 0, 'confirmed', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000403', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a2',
   pg_temp.m('-330 minutes'), pg_temp.m('-300 minutes'), 0, 'cancelled', 'phone', 1300, null, 'client', 'client_request'),
  ('d5000000-0000-4000-8000-000000000404', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a2',
   pg_temp.m('-390 minutes'), pg_temp.m('-360 minutes'), 0, 'no_show', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000405', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a2',
   pg_temp.m('-450 minutes'), pg_temp.m('-420 minutes'), 0, 'completed', 'phone', 1300, 999, null, null),
  ('d5000000-0000-4000-8000-000000000406', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a7', 'd2000000-0000-4000-8000-0000000000a0',
   pg_temp.m('-510 minutes'), pg_temp.m('-480 minutes'), 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000409', 'd1000000-0000-4000-8000-00000000000b', null, 'd2000000-0000-4000-8000-0000000000b0',
   pg_temp.m('-150 minutes'), pg_temp.m('-120 minutes'), 0, 'booked', 'walkin', 1200, null, null, null),

  ('d5000000-0000-4000-8000-000000000501', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a1', 'd2000000-0000-4000-8000-0000000000a2',
   now() - interval '10 days 30 minutes', now() - interval '10 days', 0, 'completed', 'phone', 1300, 1300, null, null),
  ('d5000000-0000-4000-8000-000000000502', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a1', 'd2000000-0000-4000-8000-0000000000a0',
   now() - interval '3 days 30 minutes', now() - interval '3 days', 0, 'cancelled', 'phone', 1300, null, 'client', 'client_request'),
  ('d5000000-0000-4000-8000-000000000503', 'd1000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a1', 'd2000000-0000-4000-8000-0000000000a0',
   now() - interval '7 days 30 minutes', now() - interval '7 days', 0, 'no_show', 'phone', 1300, null, null, null);

insert into public.appointment_services (business_id, appointment_id, position, service_id, price_cents, duration_min)
select a.business_id, a.id, 0,
       case when a.business_id = 'd1000000-0000-4000-8000-00000000000a' then 'd4000000-0000-4000-8000-0000000000a1'::uuid
            else 'd4000000-0000-4000-8000-0000000000b1'::uuid end,
       a.total_cents, 30
from public.appointments a
where a.business_id in ('d1000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-00000000000b');

-- Manage tokens: three of ca1 (tk3 revoked a day ago), one of ca5.
insert into public.booking_tokens (id, business_id, appointment_id, token_hash, issued_for, created_at, expires_at, revoked_at) values
  ('d6000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-00000000000a', 'd5000000-0000-4000-8000-000000000201',
   encode(sha256(convert_to('dayops-token-1', 'UTF8')), 'hex'), 'booking', now() - interval '2 days', now() + interval '400 days', null),
  ('d6000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-00000000000a', 'd5000000-0000-4000-8000-000000000201',
   encode(sha256(convert_to('dayops-token-2', 'UTF8')), 'hex'), 'message', now() - interval '2 days', now() + interval '400 days', null),
  ('d6000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-00000000000a', 'd5000000-0000-4000-8000-000000000201',
   encode(sha256(convert_to('dayops-token-3', 'UTF8')), 'hex'), 'booking', now() - interval '2 days', now() + interval '400 days',
   now() - interval '1 day'),
  ('d6000000-0000-4000-8000-000000000004', 'd1000000-0000-4000-8000-00000000000a', 'd5000000-0000-4000-8000-000000000205',
   encode(sha256(convert_to('dayops-token-4', 'UTF8')), 'hex'), 'booking', now() - interval '2 days', now() + interval '400 days', null);

-- Appointments of R, local times on 2030-11-19 (D) unless noted; p_now of the summary = D 10:05.
--   R0: r02 completed 09:00 · r01 booked 10:00 (in progress) · r03 booked 15:00 · rprev0 completed
--       D−1 23:30–24:00 (ends exactly at the day start) · rlate booked D+1 00:00 (starts at the day end)
--   R1: r17 no_show 08:30 · r11 completed 09:00 (charged 15.00) · r15 booked 09:30–10:00 (to mark) ·
--       r12 booked 11:00 · r13 confirmed walk-in 13:00–13:20 + 10′ buffer · r14 cancelled 15:00 ·
--       r16 booked D−2 12:00 (to mark, another day)
--   R2: rprev booked D−1 23:30–23:50 + 15′ buffer (reaches into D) · r21 booked 12:30 (erased client) ·
--       r23 confirmed 13:15–13:35 · r22 cancelled 14:00
insert into public.appointments (id, business_id, client_id, staff_id, starts_at, ends_at, buffer_after_min, status,
                                 source, total_cents, charged_cents, cancelled_by, cancel_reason) values
  ('d5000000-0000-4000-8000-000000000c01', 'd1000000-0000-4000-8000-00000000000c', 'd3000000-0000-4000-8000-0000000000c1', 'd2000000-0000-4000-8000-0000000000c0',
   pg_temp.rd(0, '10:00'), pg_temp.rd(0, '10:30'), 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000c02', 'd1000000-0000-4000-8000-00000000000c', 'd3000000-0000-4000-8000-0000000000c2', 'd2000000-0000-4000-8000-0000000000c0',
   pg_temp.rd(0, '09:00'), pg_temp.rd(0, '09:30'), 0, 'completed', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000c03', 'd1000000-0000-4000-8000-00000000000c', 'd3000000-0000-4000-8000-0000000000c1', 'd2000000-0000-4000-8000-0000000000c0',
   pg_temp.rd(0, '15:00'), pg_temp.rd(0, '15:30'), 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000c0a', 'd1000000-0000-4000-8000-00000000000c', 'd3000000-0000-4000-8000-0000000000c1', 'd2000000-0000-4000-8000-0000000000c0',
   pg_temp.rd(-1, '23:30'), pg_temp.rd(0, '00:00'), 0, 'completed', 'phone', 1300, 1300, null, null),
  ('d5000000-0000-4000-8000-000000000c0b', 'd1000000-0000-4000-8000-00000000000c', 'd3000000-0000-4000-8000-0000000000c1', 'd2000000-0000-4000-8000-0000000000c0',
   pg_temp.rd(1, '00:00'), pg_temp.rd(1, '00:30'), 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000c11', 'd1000000-0000-4000-8000-00000000000c', 'd3000000-0000-4000-8000-0000000000c2', 'd2000000-0000-4000-8000-0000000000c1',
   pg_temp.rd(0, '09:00'), pg_temp.rd(0, '09:30'), 0, 'completed', 'phone', 1300, 1500, null, null),
  ('d5000000-0000-4000-8000-000000000c12', 'd1000000-0000-4000-8000-00000000000c', 'd3000000-0000-4000-8000-0000000000c2', 'd2000000-0000-4000-8000-0000000000c1',
   pg_temp.rd(0, '11:00'), pg_temp.rd(0, '11:30'), 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000c13', 'd1000000-0000-4000-8000-00000000000c', null, 'd2000000-0000-4000-8000-0000000000c1',
   pg_temp.rd(0, '13:00'), pg_temp.rd(0, '13:20'), 10, 'confirmed', 'walkin', 800, null, null, null),
  ('d5000000-0000-4000-8000-000000000c14', 'd1000000-0000-4000-8000-00000000000c', 'd3000000-0000-4000-8000-0000000000c2', 'd2000000-0000-4000-8000-0000000000c1',
   pg_temp.rd(0, '15:00'), pg_temp.rd(0, '15:30'), 0, 'cancelled', 'phone', 1300, null, 'business', 'other'),
  ('d5000000-0000-4000-8000-000000000c15', 'd1000000-0000-4000-8000-00000000000c', 'd3000000-0000-4000-8000-0000000000c1', 'd2000000-0000-4000-8000-0000000000c1',
   pg_temp.rd(0, '09:30'), pg_temp.rd(0, '10:00'), 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000c16', 'd1000000-0000-4000-8000-00000000000c', 'd3000000-0000-4000-8000-0000000000c1', 'd2000000-0000-4000-8000-0000000000c1',
   pg_temp.rd(-2, '12:00'), pg_temp.rd(-2, '12:30'), 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000c17', 'd1000000-0000-4000-8000-00000000000c', 'd3000000-0000-4000-8000-0000000000c2', 'd2000000-0000-4000-8000-0000000000c1',
   pg_temp.rd(0, '08:30'), pg_temp.rd(0, '09:00'), 0, 'no_show', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000c21', 'd1000000-0000-4000-8000-00000000000c', 'd3000000-0000-4000-8000-0000000000ce', 'd2000000-0000-4000-8000-0000000000c2',
   pg_temp.rd(0, '12:30'), pg_temp.rd(0, '13:00'), 0, 'booked', 'phone', 1300, null, null, null),
  ('d5000000-0000-4000-8000-000000000c22', 'd1000000-0000-4000-8000-00000000000c', 'd3000000-0000-4000-8000-0000000000c1', 'd2000000-0000-4000-8000-0000000000c2',
   pg_temp.rd(0, '14:00'), pg_temp.rd(0, '14:30'), 0, 'cancelled', 'phone', 1300, null, 'client', 'client_request'),
  ('d5000000-0000-4000-8000-000000000c23', 'd1000000-0000-4000-8000-00000000000c', 'd3000000-0000-4000-8000-0000000000c1', 'd2000000-0000-4000-8000-0000000000c2',
   pg_temp.rd(0, '13:15'), pg_temp.rd(0, '13:35'), 0, 'confirmed', 'phone', 800, null, null, null),
  ('d5000000-0000-4000-8000-000000000c2a', 'd1000000-0000-4000-8000-00000000000c', 'd3000000-0000-4000-8000-0000000000c1', 'd2000000-0000-4000-8000-0000000000c2',
   pg_temp.rd(-1, '23:30'), pg_temp.rd(-1, '23:50'), 15, 'booked', 'phone', 800, null, null, null);

insert into public.appointment_services (business_id, appointment_id, position, service_id, price_cents, duration_min)
select a.business_id, a.id, 0,
       case when a.total_cents = 800 then 'd4000000-0000-4000-8000-0000000000c2'::uuid
            else 'd4000000-0000-4000-8000-0000000000c1'::uuid end,
       a.total_cents,
       case when a.total_cents = 800 then 20 else 30 end
from public.appointments a
where a.business_id = 'd1000000-0000-4000-8000-00000000000c';

insert into pg_temp.lbl (id, label) values
  ('d0000000-0000-4000-8000-0000000000a0', 'UK0'), ('d0000000-0000-4000-8000-0000000000a1', 'UK1'),
  ('d0000000-0000-4000-8000-0000000000a2', 'UK2'), ('d0000000-0000-4000-8000-0000000000a9', 'UKX'),
  ('d0000000-0000-4000-8000-0000000000b0', 'UL0'), ('d0000000-0000-4000-8000-0000000000c0', 'UR0'),
  ('d0000000-0000-4000-8000-0000000000c1', 'UR1'), ('d0000000-0000-4000-8000-0000000000c3', 'URM'),
  ('d2000000-0000-4000-8000-0000000000a0', 'SK0'), ('d2000000-0000-4000-8000-0000000000a1', 'SK1'),
  ('d2000000-0000-4000-8000-0000000000a2', 'SK2'), ('d2000000-0000-4000-8000-0000000000b0', 'SL0'),
  ('d2000000-0000-4000-8000-0000000000c0', 'R0'), ('d2000000-0000-4000-8000-0000000000c1', 'R1'),
  ('d2000000-0000-4000-8000-0000000000c2', 'R2'), ('d2000000-0000-4000-8000-0000000000c9', 'R9'),
  ('d4000000-0000-4000-8000-0000000000a1', 'Cut'), ('d4000000-0000-4000-8000-0000000000a2', 'Beard'),
  ('d4000000-0000-4000-8000-0000000000c1', 'Cut'), ('d4000000-0000-4000-8000-0000000000c2', 'Beard'),
  ('d3000000-0000-4000-8000-0000000000a1', 'c1'), ('d3000000-0000-4000-8000-0000000000a7', 'cT'),
  ('d3000000-0000-4000-8000-0000000000c1', 'cR1'), ('d3000000-0000-4000-8000-0000000000c2', 'cR2'),
  ('d3000000-0000-4000-8000-0000000000ce', 'cRE'),
  ('d5000000-0000-4000-8000-000000000101', 'st1'), ('d5000000-0000-4000-8000-000000000102', 'st2'),
  ('d5000000-0000-4000-8000-000000000103', 'st3'), ('d5000000-0000-4000-8000-000000000104', 'st4'),
  ('d5000000-0000-4000-8000-000000000105', 'st5'), ('d5000000-0000-4000-8000-000000000109', 'stL'),
  ('d5000000-0000-4000-8000-000000000201', 'ca1'), ('d5000000-0000-4000-8000-000000000202', 'ca2'),
  ('d5000000-0000-4000-8000-000000000203', 'ca3'), ('d5000000-0000-4000-8000-000000000204', 'ca4'),
  ('d5000000-0000-4000-8000-000000000205', 'ca5'),
  ('d5000000-0000-4000-8000-000000000301', 'mv1'), ('d5000000-0000-4000-8000-000000000302', 'mv2'),
  ('d5000000-0000-4000-8000-000000000303', 'mv3'), ('d5000000-0000-4000-8000-000000000304', 'mvb'),
  ('d5000000-0000-4000-8000-000000000305', 'mvc'),
  ('d5000000-0000-4000-8000-000000000401', 'ac1'), ('d5000000-0000-4000-8000-000000000402', 'ac2'),
  ('d5000000-0000-4000-8000-000000000403', 'ac3'), ('d5000000-0000-4000-8000-000000000404', 'ac4'),
  ('d5000000-0000-4000-8000-000000000405', 'ac5'), ('d5000000-0000-4000-8000-000000000406', 'acp'),
  ('d5000000-0000-4000-8000-000000000409', 'acL'),
  ('d5000000-0000-4000-8000-000000000c01', 'r01'), ('d5000000-0000-4000-8000-000000000c02', 'r02'),
  ('d5000000-0000-4000-8000-000000000c03', 'r03'), ('d5000000-0000-4000-8000-000000000c0a', 'rprev0'),
  ('d5000000-0000-4000-8000-000000000c0b', 'rlate'), ('d5000000-0000-4000-8000-000000000c11', 'r11'),
  ('d5000000-0000-4000-8000-000000000c12', 'r12'), ('d5000000-0000-4000-8000-000000000c13', 'r13'),
  ('d5000000-0000-4000-8000-000000000c14', 'r14'), ('d5000000-0000-4000-8000-000000000c15', 'r15'),
  ('d5000000-0000-4000-8000-000000000c16', 'r16'), ('d5000000-0000-4000-8000-000000000c17', 'r17'),
  ('d5000000-0000-4000-8000-000000000c21', 'r21'), ('d5000000-0000-4000-8000-000000000c22', 'r22'),
  ('d5000000-0000-4000-8000-000000000c23', 'r23'), ('d5000000-0000-4000-8000-000000000c2a', 'rprev'),
  ('d6000000-0000-4000-8000-000000000001', 'tk1'), ('d6000000-0000-4000-8000-000000000002', 'tk2'),
  ('d6000000-0000-4000-8000-000000000003', 'tk3'), ('d6000000-0000-4000-8000-000000000004', 'tk4');

-- ---------------------------------------------------------------------------------------------
-- Shape: signatures, volatility, definer/invoker (§2.6, §2.4, §2.7); domain errors (§2.2)
-- ---------------------------------------------------------------------------------------------
select is(
  (select array_agg(p.oid::regprocedure::text || ' ' || p.provolatile::text
                    || case when p.prosecdef then ' definer' else ' invoker' end
                    order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('busy_calendar', 'today_summary', 'set_appointment_status', 'cancel_appointment',
                       'staff_move_appointment', 'search_clients')),
  array[
    'busy_calendar(uuid,date) s invoker',
    'cancel_appointment(uuid,uuid,text,text,boolean) v invoker',
    'search_clients(uuid,text) s invoker',
    'set_appointment_status(uuid,uuid,text,text) v invoker',
    'staff_move_appointment(uuid,uuid,uuid,timestamp with time zone,boolean,uuid,boolean,boolean) v invoker',
    'today_summary(uuid) s invoker'
  ]::text[],
  'the six day-ops wrappers exist once each, with the contract signatures, as invoker (stable reads, volatile writes)'
);

select is(
  (select array_agg(p.oid::regprocedure::text || ' ' || p.provolatile::text
                    || case when p.prosecdef then ' definer' else ' invoker' end
                    order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
     and p.proname in ('busy_calendar_impl', 'today_summary_impl', 'set_appointment_status_impl',
                       'cancel_appointment_impl', 'staff_move_appointment_impl', 'search_clients_impl')),
  array[
    'private.busy_calendar_impl(uuid,date) s definer',
    'private.cancel_appointment_impl(uuid,uuid,text,text,boolean) v definer',
    'private.search_clients_impl(uuid,text) s definer',
    'private.set_appointment_status_impl(uuid,uuid,text,text) v definer',
    'private.staff_move_appointment_impl(uuid,uuid,uuid,timestamp with time zone,boolean,uuid,boolean,boolean) v definer',
    'private.today_summary_impl(uuid,timestamp with time zone) s definer'
  ]::text[],
  'the six _impl functions are SECURITY DEFINER; only today_summary_impl takes p_now'
);

select is(
  (select array_agg(p.oid::regprocedure::text || ' ' || p.provolatile::text
                    || case when p.prosecdef then ' definer ' else ' invoker ' end
                    || format_type(p.prorettype, null)
                    order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname in ('auto_complete_impl', 'record_job_run')),
  array[
    'private.auto_complete_impl(timestamp with time zone) v definer integer',
    'private.record_job_run(text,timestamp with time zone,boolean,integer,text) v invoker bigint'
  ]::text[],
  'auto_complete_impl(p_now) is a definer returning integer; record_job_run is an invoker returning the new id'
);

select is(
  array[pg_temp.hint('AN020'), pg_temp.hint('AN021'), pg_temp.hint('AN022'), pg_temp.hint('AN023')],
  array['P0001 AN020 not_modifiable', 'P0001 AN021 appointment_changed', 'P0001 AN022 correction_closed',
        'P0001 AN023 not_started'],
  'domain errors AN021–AN023 join the list (message = code, hint = name); AN020 is unchanged'
);

-- ---------------------------------------------------------------------------------------------
-- busy_calendar and today_summary (business R, 2030-11-19)
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', '', true);
set local role authenticated;

-- Staff member R1.
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-4000-8000-0000000000c1", "role": "authenticated", "aal": "aal1"}', true);

select lives_ok(
  $$select set_config('t.bc_staff', coalesce(public.busy_calendar(
      p_business_id => 'd1000000-0000-4000-8000-00000000000c', p_local_date => date '2030-11-19')::text, 'null'), true)$$,
  'busy_calendar: a staff member reads the day frame'
);

select throws_ok(
  $$select public.busy_calendar(p_business_id => 'd1000000-0000-4000-8000-00000000000c', p_local_date => null)$$,
  '22023', null,
  'busy_calendar: a null local date is refused (22023)'
);

select lives_ok(
  $$select set_config('t.ts_staff', coalesce(private.today_summary_impl(
      'd1000000-0000-4000-8000-00000000000c', pg_temp.rd(0, '10:05'))::text, 'null'), true)$$,
  'today_summary_impl: a staff member reads the summary at a fixed p_now'
);

select lives_ok(
  $$select set_config('t.tsw_staff', coalesce(public.today_summary(
      p_business_id => 'd1000000-0000-4000-8000-00000000000c')::text, 'null'), true)$$,
  'today_summary: a staff member reads the summary through the wrapper'
);

-- Owner (staff row R0).
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-4000-8000-0000000000c0", "role": "authenticated", "aal": "aal1"}', true);

select lives_ok(
  $$select set_config('t.bc_owner', coalesce(public.busy_calendar(
      p_business_id => 'd1000000-0000-4000-8000-00000000000c', p_local_date => date '2030-11-19')::text, 'null'), true)$$,
  'busy_calendar: the owner reads the day frame'
);

select lives_ok(
  $$select set_config('t.ts_owner', coalesce(private.today_summary_impl(
      'd1000000-0000-4000-8000-00000000000c', pg_temp.rd(0, '10:05'))::text, 'null'), true)$$,
  'today_summary_impl: the owner reads the summary at a fixed p_now'
);

select lives_ok(
  $$select set_config('t.tsw_owner', coalesce(public.today_summary(
      p_business_id => 'd1000000-0000-4000-8000-00000000000c')::text, 'null'), true)$$,
  'today_summary: the owner reads the summary through the wrapper'
);

-- Manager (no staff row).
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-4000-8000-0000000000c3", "role": "authenticated", "aal": "aal1"}', true);

select lives_ok(
  $$select set_config('t.bc_mgr', coalesce(public.busy_calendar(
      p_business_id => 'd1000000-0000-4000-8000-00000000000c', p_local_date => date '2030-11-19')::text, 'null'), true)$$,
  'busy_calendar: the manager reads the day frame'
);

select lives_ok(
  $$select set_config('t.ts_mgr', coalesce(private.today_summary_impl(
      'd1000000-0000-4000-8000-00000000000c', pg_temp.rd(0, '10:05'))::text, 'null'), true)$$,
  'today_summary_impl: the manager reads the summary at a fixed p_now'
);

set local role postgres;
select set_config('request.jwt.claims', '', true);

-- busy_calendar
select is(
  pg_temp.keys(pg_temp.r('bc_staff')),
  array['blocks', 'day_end', 'day_start', 'local_date', 'timezone', 'windows'],
  'busy_calendar: one object with local_date, timezone, day_start, day_end, windows and blocks'
);

select is(
  (select concat_ws(' | ', r ->> 'local_date', r ->> 'timezone',
                    ((r ->> 'day_start')::timestamptz = pg_temp.rd(0, '00:00'))::text,
                    ((r ->> 'day_end')::timestamptz = pg_temp.rd(1, '00:00'))::text)
   from pg_temp.r('bc_staff') as r),
  '2030-11-19 | Europe/Athens | true | true',
  'busy_calendar: the local date, the business zone and the local midnights as instants'
);

select is(
  (select string_agg(pg_temp.l((w ->> 'staff_id')::uuid) || ' ' || pg_temp.lt(w ->> 'starts_at') || '-' || pg_temp.lt(w ->> 'ends_at'),
                     ', ' order by x.o)
   from jsonb_array_elements(pg_temp.r('bc_staff') -> 'windows') with ordinality as x (w, o)),
  'R0 19 09:00-19 17:00, R1 19 09:00-19 17:00, R2 19 09:00-19 10:00, R2 19 12:00-19 17:00',
  'busy_calendar: working windows of every ACTIVE staff member (shop exception, a colleague''s time off; not R9), by staff sort'
);

select ok(
  (select bool_and(pg_temp.keys(w) = array['ends_at', 'staff_id', 'starts_at'])
   from jsonb_array_elements(pg_temp.r('bc_staff') -> 'windows') as w),
  'busy_calendar: a window carries only staff_id, starts_at and ends_at'
);

select ok(
  (select count(*) > 0 and bool_and(pg_temp.keys(b) = array['appointment_id', 'buffer_after_min', 'ends_at', 'staff_id', 'starts_at'])
   from jsonb_array_elements(pg_temp.r('bc_staff') -> 'blocks') as b),
  'busy_calendar: a block carries EXACTLY appointment_id, staff_id, starts_at, ends_at, buffer_after_min (no client, price, status or source)'
);

select is(
  (select string_agg(pg_temp.l((b ->> 'appointment_id')::uuid) || ' ' || pg_temp.l((b ->> 'staff_id')::uuid) || ' '
                     || pg_temp.lt(b ->> 'starts_at') || '-' || pg_temp.lt(b ->> 'ends_at') || ' +' || (b ->> 'buffer_after_min'),
                     ', ' order by x.o)
   from jsonb_array_elements(pg_temp.r('bc_staff') -> 'blocks') with ordinality as x (b, o)),
  'r02 R0 19 09:00-19 09:30 +0, r01 R0 19 10:00-19 10:30 +0, r03 R0 19 15:00-19 15:30 +0, '
  || 'rprev R2 18 23:30-18 23:50 +15, r21 R2 19 12:30-19 13:00 +0, r23 R2 19 13:15-19 13:35 +0',
  'busy_calendar: staff see the colleagues'' non-cancelled appointments touching the day (buffer included), by staff and start'
);

select is(
  concat_ws(' | ', (pg_temp.r('bc_owner') -> 'blocks')::text, (pg_temp.r('bc_mgr') -> 'blocks')::text),
  '[] | []',
  'busy_calendar: owner and manager get no blocks (they read every appointment through RLS)'
);

select ok(
  pg_temp.r('bc_owner') -> 'windows' = pg_temp.r('bc_staff') -> 'windows'
    and pg_temp.r('bc_mgr') -> 'windows' = pg_temp.r('bc_staff') -> 'windows',
  'busy_calendar: owner and manager get the same working windows as staff'
);

-- today_summary as staff R1
select is(
  pg_temp.keys(pg_temp.r('ts_staff')) || pg_temp.keys(pg_temp.r('ts_staff') -> 'counts'),
  array['counts', 'currency', 'expected_revenue_cents', 'gaps', 'local_date', 'next', 'scope', 'timezone', 'to_mark',
        'remaining', 'to_mark', 'total'],
  'today_summary: the contract keys, expected_revenue_cents always present, counts = total/remaining/to_mark'
);

select is(
  (select concat_ws(' | ', r ->> 'local_date', r ->> 'timezone', r ->> 'currency', r ->> 'scope',
                    (r ? 'expected_revenue_cents')::text, jsonb_typeof(r -> 'expected_revenue_cents'))
   from pg_temp.r('ts_staff') as r),
  '2030-11-19 | Europe/Athens | EUR | own | true | null',
  'today_summary_impl as staff: scope own and expected_revenue_cents is JSON null (decided inside the _impl)'
);

select is(
  (select concat_ws(' | ', r -> 'counts' ->> 'total', r -> 'counts' ->> 'remaining', r -> 'counts' ->> 'to_mark')
   from pg_temp.r('ts_staff') as r),
  '5 | 2 | 2',
  'today_summary_impl as staff: own rows only (5 not cancelled today, 2 still to come, 2 to mark of any date)'
);

select is(
  (select string_agg(concat_ws('|', pg_temp.l((i ->> 'appointment_id')::uuid), pg_temp.l((i ->> 'staff_id')::uuid),
                               i ->> 'status', pg_temp.l((i ->> 'client_id')::uuid), coalesce(i ->> 'client_name', '-'),
                               (select string_agg(pg_temp.l(s::uuid), '+' order by y.p)
                                from jsonb_array_elements_text(i -> 'service_ids') with ordinality as y (s, p))),
                     '; ' order by x.o)
   from jsonb_array_elements(pg_temp.r('ts_staff') -> 'next') with ordinality as x (i, o)),
  'r12|R1|booked|cR2|Βασίλης Κ.|Cut; r13|R1|confirmed|-|-|Beard',
  'today_summary_impl as staff: next = own booked/confirmed of today not yet ended, by start; a walk-in has no client name'
);

select is(
  (select string_agg(concat_ws('|', pg_temp.l((i ->> 'appointment_id')::uuid), pg_temp.l((i ->> 'staff_id')::uuid),
                               i ->> 'status', pg_temp.lt(i ->> 'starts_at') || '-' || pg_temp.lt(i ->> 'ends_at')),
                     '; ' order by x.o)
   from jsonb_array_elements(pg_temp.r('ts_staff') -> 'to_mark') with ordinality as x (i, o)),
  'r15|R1|booked|19 09:30-19 10:00; r16|R1|booked|17 12:00-17 12:30',
  'today_summary_impl as staff: to_mark = own booked/confirmed that already ended, any date, latest end first'
);

select is(
  (select string_agg(pg_temp.l((g ->> 'staff_id')::uuid) || ' ' || pg_temp.lt(g ->> 'starts_at') || '-' || pg_temp.lt(g ->> 'ends_at')
                     || ' ' || (g ->> 'minutes'), ', ' order by x.o)
   from jsonb_array_elements(pg_temp.r('ts_staff') -> 'gaps') with ordinality as x (g, o)),
  'R1 19 10:15-19 11:00 45, R1 19 11:30-19 13:00 90, R1 19 13:30-19 17:00 210',
  'today_summary_impl as staff: own gaps from the next grid step after p_now, around booked/confirmed blocks with buffers'
);

-- today_summary as owner and manager
select is(
  (select concat_ws(' | ', r ->> 'scope', r ->> 'expected_revenue_cents') from pg_temp.r('ts_owner') as r),
  'business | 10900',
  'today_summary_impl as owner: the whole business and the expected revenue (charged amount when completed)'
);

select is(
  (select concat_ws(' | ', r ->> 'scope', r ->> 'expected_revenue_cents') from pg_temp.r('ts_mgr') as r),
  'business | 10900',
  'today_summary_impl as manager: the manager sees the expected revenue too (SPEC §5)'
);

select is(
  (select concat_ws(' | ', r -> 'counts' ->> 'total', r -> 'counts' ->> 'remaining', r -> 'counts' ->> 'to_mark')
   from pg_temp.r('ts_owner') as r),
  '10 | 6 | 3',
  'today_summary_impl as owner: counts over the whole business'
);

select is(
  (select string_agg(concat_ws('|', pg_temp.l((i ->> 'appointment_id')::uuid), pg_temp.l((i ->> 'staff_id')::uuid),
                               i ->> 'status', pg_temp.l((i ->> 'client_id')::uuid), coalesce(i ->> 'client_name', '-'),
                               (select string_agg(pg_temp.l(s::uuid), '+' order by y.p)
                                from jsonb_array_elements_text(i -> 'service_ids') with ordinality as y (s, p))),
                     '; ' order by x.o)
   from jsonb_array_elements(pg_temp.r('ts_owner') -> 'next') with ordinality as x (i, o)),
  'r01|R0|booked|cR1|Άννα Λ.|Cut; r12|R1|booked|cR2|Βασίλης Κ.|Cut; r21|R2|booked|cRE|-|Cut; '
  || 'r13|R1|confirmed|-|-|Beard; r23|R2|confirmed|cR1|Άννα Λ.|Beard',
  'today_summary_impl as owner: at most 5 next (in progress included), an erased client has no name'
);

select ok(
  (select count(*) > 0 and bool_and(pg_temp.keys(i) = array['appointment_id', 'client_id', 'client_name', 'ends_at',
                                                               'service_ids', 'staff_id', 'starts_at', 'status'])
   from (select jsonb_array_elements(pg_temp.r('ts_owner') -> 'next') as i
         union all
         select jsonb_array_elements(pg_temp.r('ts_owner') -> 'to_mark')) as q),
  'today_summary: next and to_mark items carry exactly the eight contract keys (no prices)'
);

select is(
  (select string_agg(concat_ws('|', pg_temp.l((i ->> 'appointment_id')::uuid), pg_temp.l((i ->> 'staff_id')::uuid),
                               i ->> 'status', pg_temp.lt(i ->> 'starts_at') || '-' || pg_temp.lt(i ->> 'ends_at')),
                     '; ' order by x.o)
   from jsonb_array_elements(pg_temp.r('ts_owner') -> 'to_mark') with ordinality as x (i, o)),
  'r15|R1|booked|19 09:30-19 10:00; rprev|R2|booked|18 23:30-18 23:50; r16|R1|booked|17 12:00-17 12:30',
  'today_summary_impl as owner: to_mark over the business, latest end first'
);

select is(
  (select string_agg(pg_temp.l((g ->> 'staff_id')::uuid) || ' ' || pg_temp.lt(g ->> 'starts_at') || '-' || pg_temp.lt(g ->> 'ends_at')
                     || ' ' || (g ->> 'minutes'), ', ' order by x.o)
   from jsonb_array_elements(pg_temp.r('ts_owner') -> 'gaps') with ordinality as x (g, o)),
  'R1 19 10:15-19 11:00 45, R0 19 10:30-19 15:00 270, R1 19 11:30-19 13:00 90, R2 19 12:00-19 12:30 30, '
  || 'R1 19 13:30-19 17:00 210, R2 19 13:35-19 17:00 205, R0 19 15:30-19 17:00 90',
  'today_summary_impl as owner: gaps of every active staff member by start (time off respected, a 15′ hole < 20′ skipped)'
);

select ok(
  (select count(*) > 0 and bool_and(pg_temp.keys(g) = array['ends_at', 'minutes', 'staff_id', 'starts_at'])
   from jsonb_array_elements(pg_temp.r('ts_owner') -> 'gaps') as g),
  'today_summary: a gap carries staff_id, starts_at, ends_at and minutes'
);

select is(
  (select concat_ws(' | ', r ->> 'scope', (r ? 'expected_revenue_cents')::text, jsonb_typeof(r -> 'expected_revenue_cents'))
   from pg_temp.r('tsw_staff') as r),
  'own | true | null',
  'today_summary (wrapper) as staff: expected_revenue_cents is null'
);

select is(
  (select concat_ws(' | ', r ->> 'scope', jsonb_typeof(r -> 'expected_revenue_cents')) from pg_temp.r('tsw_owner') as r),
  'business | number',
  'today_summary (wrapper) as owner: expected_revenue_cents is a number'
);

-- ---------------------------------------------------------------------------------------------
-- set_appointment_status (business K)
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', '', true);
set local role authenticated;

-- A staff member without a staff row acts on nothing, and sees nothing of their own.
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-4000-8000-0000000000a9", "role": "authenticated", "aal": "aal1"}', true);

select throws_ok(
  $$select public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000101', p_from_status => 'booked', p_status => 'confirmed')$$,
  '42501', null,
  'status: a staff member without a staff row cannot change any appointment (42501)'
);

select lives_ok(
  $$select set_config('t.ts_nostaff', coalesce(private.today_summary_impl(
      'd1000000-0000-4000-8000-00000000000a', now())::text, 'null'), true)$$,
  'today_summary_impl: a staff member without a staff row gets a summary'
);

-- Staff member SK1.
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-4000-8000-0000000000a1", "role": "authenticated", "aal": "aal1"}', true);

select lives_ok(
  $$select set_config('t.s1', coalesce(public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000101', p_from_status => 'booked', p_status => 'confirmed')::text, 'null'), true)$$,
  'status: staff confirm their own booked appointment'
);

select lives_ok(
  $$select set_config('t.s1b', coalesce(public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000101', p_from_status => 'booked', p_status => 'confirmed')::text, 'null'), true)$$,
  'status: the same call again (a retry) succeeds'
);

select throws_ok(
  $$select public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000101', p_from_status => 'confirmed', p_status => 'completed')$$,
  'P0001', 'AN023',
  'status: completed before the start is refused (AN023)'
);

select throws_ok(
  $$select public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000101', p_from_status => 'booked', p_status => 'no_show')$$,
  'P0001', 'AN021',
  'status: a stale p_from_status (another device changed it) is refused (AN021), not overwritten'
);

select throws_ok(
  $$select public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000101', p_from_status => 'confirmed', p_status => 'cancelled')$$,
  '22023', null,
  'status: cancelled is not a target of set_appointment_status (cancel_appointment does it) (22023)'
);

select throws_ok(
  $$select public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000101', p_from_status => 'bogus', p_status => 'no_show')$$,
  '22023', null,
  'status: an unknown p_from_status is refused (22023)'
);

select throws_ok(
  $$select public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000102', p_from_status => 'booked', p_status => 'no_show')$$,
  '42501', null,
  'status: staff cannot mark a colleague''s appointment (42501)'
);

select throws_ok(
  $$select public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000109', p_from_status => 'booked', p_status => 'confirmed')$$,
  '42501', null,
  'status: an appointment of another business is refused (42501)'
);

select throws_ok(
  $$select public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => null, p_from_status => 'booked', p_status => 'confirmed')$$,
  '42501', null,
  'status: a null appointment id is refused (42501)'
);

select lives_ok(
  $$select public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000103', p_from_status => 'booked', p_status => 'completed')$$,
  'status: staff complete their own appointment once it has started'
);

select lives_ok(
  $$select public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000103', p_from_status => 'completed', p_status => 'no_show')$$,
  'status: staff correct completed -> no_show inside the correction window'
);

select throws_ok(
  $$select public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000103', p_from_status => 'no_show', p_status => 'confirmed')$$,
  'P0001', 'AN020',
  'status: only a booked appointment can be confirmed (AN020)'
);

select throws_ok(
  $$select public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000104', p_from_status => 'completed', p_status => 'no_show')$$,
  'P0001', 'AN022',
  'status: a staff correction after correction_window_days is refused (AN022)'
);

select lives_ok(
  $$select public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000105', p_from_status => 'cancelled', p_status => 'completed')$$,
  'status: staff correct cancelled -> completed inside the window'
);

-- Owner of K.
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-4000-8000-0000000000a0", "role": "authenticated", "aal": "aal1"}', true);

select lives_ok(
  $$select public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000102', p_from_status => 'booked', p_status => 'completed')$$,
  'status: the owner marks a staff member''s appointment'
);

select lives_ok(
  $$select public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000104', p_from_status => 'completed', p_status => 'no_show')$$,
  'status: the owner corrects after the window (no window for owner/manager)'
);

set local role postgres;
select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.keys(pg_temp.r('s1')),
  array['appointment_id', 'changed', 'from_status', 'status'],
  'status: the answer carries appointment_id, status, from_status and changed'
);

select is(
  concat_ws(' || ',
    (select concat_ws(' ', pg_temp.l((r ->> 'appointment_id')::uuid), r ->> 'status', r ->> 'from_status', r ->> 'changed')
     from pg_temp.r('s1') as r),
    (select concat_ws(' ', pg_temp.l((r ->> 'appointment_id')::uuid), r ->> 'status', r ->> 'from_status', r ->> 'changed')
     from pg_temp.r('s1b') as r)),
  'st1 confirmed booked true || st1 confirmed confirmed false',
  'status: the first call changes booked -> confirmed; the retry answers changed = false'
);

select is(
  (select string_agg(e.event || ' ' || e.from_status || '>' || e.to_status || ' ' || e.actor_type || ' ' || pg_temp.l(e.actor_id),
                     ', ' order by e.id)
   from public.appointment_events e
   where e.appointment_id = 'd5000000-0000-4000-8000-000000000101' and e.event <> 'created'),
  'status_changed booked>confirmed staff UK1',
  'status: one event only, by the staff member (the retry wrote nothing)'
);

select is(
  (select string_agg(pg_temp.l(a.id) || ' ' || a.status || ' ' || coalesce(a.charged_cents::text, '-') || ' '
                     || coalesce(a.cancelled_by, '-') || ' ' || coalesce(a.cancel_reason, '-'), ', ' order by a.id)
   from public.appointments a
   where a.id in ('d5000000-0000-4000-8000-000000000101', 'd5000000-0000-4000-8000-000000000102',
                  'd5000000-0000-4000-8000-000000000103', 'd5000000-0000-4000-8000-000000000104',
                  'd5000000-0000-4000-8000-000000000105')),
  'st1 confirmed - - -, st2 completed - - -, st3 no_show - - -, st4 no_show - - -, st5 completed - - -',
  'status: final states; leaving completed clears charged_cents, leaving cancelled clears cancelled_by/cancel_reason'
);

select is(
  (select string_agg(pg_temp.l(e.appointment_id) || ' ' || e.from_status || '>' || e.to_status || ' ' || e.actor_type
                     || ' ' || pg_temp.l(e.actor_id), ', ' order by e.id)
   from public.appointment_events e
   where e.appointment_id in ('d5000000-0000-4000-8000-000000000102', 'd5000000-0000-4000-8000-000000000103',
                              'd5000000-0000-4000-8000-000000000104', 'd5000000-0000-4000-8000-000000000105')
     and e.event = 'status_changed'),
  'st3 booked>completed staff UK1, st3 completed>no_show staff UK1, st5 cancelled>completed staff UK1, '
  || 'st2 booked>completed staff UK0, st4 completed>no_show staff UK0',
  'status: every change is one status_changed event with actor staff and the caller''s id'
);

select is(
  (select concat_ws(' | ', r ->> 'scope', r -> 'counts' ->> 'total', r -> 'counts' ->> 'remaining', r -> 'counts' ->> 'to_mark',
                    jsonb_typeof(r -> 'expected_revenue_cents'), jsonb_array_length(r -> 'next'),
                    jsonb_array_length(r -> 'gaps'), jsonb_array_length(r -> 'to_mark'))
   from pg_temp.r('ts_nostaff') as r),
  'own | 0 | 0 | 0 | null | 0 | 0 | 0',
  'today_summary_impl: a staff member without a staff row sees nothing and no revenue'
);

-- ---------------------------------------------------------------------------------------------
-- cancel_appointment (business K)
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', '', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-4000-8000-0000000000a1", "role": "authenticated", "aal": "aal1"}', true);

select lives_ok(
  $$select set_config('t.c1', coalesce(public.cancel_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000201', p_from_status => 'booked', p_reason => 'client_request',
      p_notify => true)::text, 'null'), true)$$,
  'cancel: staff cancel their own future appointment because the client phoned'
);

select is(
  current_setting('anaklo.notify_client', true),
  'true',
  'cancel: notify on a future appointment is handed to the planner as anaklo.notify_client = true'
);

select lives_ok(
  $$select set_config('t.c1b', coalesce(public.cancel_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000201', p_from_status => 'booked', p_reason => 'other',
      p_notify => true)::text, 'null'), true)$$,
  'cancel: a retry (even with another reason) succeeds'
);

-- A value left by an earlier call in the same transaction must never leak into the next one.
select set_config('anaklo.notify_client', 'true', true);

select lives_ok(
  $$select set_config('t.c2', coalesce(public.cancel_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000202', p_from_status => 'booked', p_reason => 'other',
      p_notify => true)::text, 'null'), true)$$,
  'cancel: staff cancel their own appointment that already ended (no notice rule for the business)'
);

select is(
  current_setting('anaklo.notify_client', true),
  'false',
  'cancel: notify on a past appointment is not effective (anaklo.notify_client = false, set explicitly)'
);

select throws_ok(
  $$select public.cancel_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000203', p_from_status => 'booked', p_reason => 'other', p_notify => false)$$,
  '42501', null,
  'cancel: staff cannot cancel a colleague''s appointment (42501)'
);

select throws_ok(
  $$select public.cancel_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000204', p_from_status => 'completed', p_reason => 'other', p_notify => false)$$,
  'P0001', 'AN022',
  'cancel: a staff correction completed -> cancelled after the window is refused (AN022)'
);

select throws_ok(
  $$select public.cancel_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000205', p_from_status => 'booked', p_reason => 'other', p_notify => false)$$,
  'P0001', 'AN021',
  'cancel: a stale p_from_status is refused (AN021)'
);

select throws_ok(
  $$select public.cancel_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000205', p_from_status => 'confirmed', p_reason => 'because', p_notify => false)$$,
  '22023', null,
  'cancel: a reason outside the six codes is refused (22023)'
);

select throws_ok(
  $$select public.cancel_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000205', p_from_status => 'confirmed', p_reason => 'other', p_notify => null)$$,
  '22023', null,
  'cancel: a null p_notify is refused (22023)'
);

select set_config('request.jwt.claims', '{"sub": "d0000000-0000-4000-8000-0000000000a0", "role": "authenticated", "aal": "aal1"}', true);

select lives_ok(
  $$select public.cancel_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000203', p_from_status => 'booked', p_reason => 'shop_closed', p_notify => false)$$,
  'cancel: the owner cancels a staff member''s appointment'
);

select lives_ok(
  $$select public.cancel_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000204', p_from_status => 'completed', p_reason => 'duplicate', p_notify => false)$$,
  'cancel: the owner corrects an old completed appointment into cancelled'
);

set local role postgres;
select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.keys(pg_temp.r('c1')),
  array['appointment_id', 'cancel_reason', 'cancelled_by', 'changed', 'from_status', 'notify', 'sms_queued', 'status'],
  'cancel: the answer carries the eight contract keys'
);

select is(
  (select concat_ws(' ', pg_temp.l((r ->> 'appointment_id')::uuid), r ->> 'status', r ->> 'from_status', r ->> 'changed',
                    r ->> 'cancelled_by', r ->> 'cancel_reason', r ->> 'notify', r ->> 'sms_queued')
   from pg_temp.r('c1') as r),
  'ca1 cancelled booked true client client_request true false',
  'cancel: client_request records the client as the canceller; notify is effective; no SMS is queued before 1.5'
);

select is(
  (select concat_ws(' ', pg_temp.l((r ->> 'appointment_id')::uuid), r ->> 'status', r ->> 'from_status', r ->> 'changed',
                    r ->> 'cancelled_by', r ->> 'cancel_reason', r ->> 'notify', r ->> 'sms_queued')
   from pg_temp.r('c1b') as r),
  'ca1 cancelled cancelled false client client_request false false',
  'cancel: the retry answers changed = false with the stored canceller and reason (the new reason is ignored)'
);

select is(
  (select concat_ws(' ', pg_temp.l((r ->> 'appointment_id')::uuid), r ->> 'changed', r ->> 'cancelled_by', r ->> 'cancel_reason',
                    r ->> 'notify', r ->> 'sms_queued')
   from pg_temp.r('c2') as r),
  'ca2 true business other false false',
  'cancel: any other reason records the business; notify is not effective for a past appointment'
);

select is(
  (select string_agg(pg_temp.l(a.id) || ' ' || a.status || ' ' || coalesce(a.charged_cents::text, '-') || ' '
                     || coalesce(a.cancelled_by, '-') || ' ' || coalesce(a.cancel_reason, '-'), ', ' order by a.id)
   from public.appointments a
   where a.id in ('d5000000-0000-4000-8000-000000000201', 'd5000000-0000-4000-8000-000000000202',
                  'd5000000-0000-4000-8000-000000000203', 'd5000000-0000-4000-8000-000000000204',
                  'd5000000-0000-4000-8000-000000000205')),
  'ca1 cancelled - client client_request, ca2 cancelled - business other, ca3 cancelled - business shop_closed, '
  || 'ca4 cancelled - business duplicate, ca5 confirmed - - -',
  'cancel: stored canceller and reason; a corrected completed loses charged_cents; failed calls changed nothing'
);

select is(
  (select string_agg(pg_temp.l(e.appointment_id) || ' ' || e.from_status || '>' || e.to_status || ' ' || e.actor_type
                     || ' ' || pg_temp.l(e.actor_id), ', ' order by e.id)
   from public.appointment_events e
   where e.appointment_id in ('d5000000-0000-4000-8000-000000000201', 'd5000000-0000-4000-8000-000000000202',
                              'd5000000-0000-4000-8000-000000000203', 'd5000000-0000-4000-8000-000000000204',
                              'd5000000-0000-4000-8000-000000000205')
     and e.event <> 'created'),
  'ca1 booked>cancelled staff UK1, ca2 booked>cancelled staff UK1, ca3 booked>cancelled staff UK0, '
  || 'ca4 completed>cancelled staff UK0',
  'cancel: one status_changed event per real change (the retry wrote none), actor staff'
);

select is(
  (select string_agg(pg_temp.l(t.id) || ' ' || case when t.revoked_at is null then 'live'
                                                    when t.revoked_at = now() then 'revoked-now'
                                                    else 'revoked-before' end, ', ' order by t.id)
   from public.booking_tokens t
   where t.business_id = 'd1000000-0000-4000-8000-00000000000a'),
  'tk1 revoked-now, tk2 revoked-now, tk3 revoked-before, tk4 live',
  'cancel: every live manage token of the appointment is revoked; an old revocation and other appointments are untouched'
);

-- ---------------------------------------------------------------------------------------------
-- staff_move_appointment (business K)
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', '', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-4000-8000-0000000000a1", "role": "authenticated", "aal": "aal1"}', true);

select lives_ok(
  $$select set_config('t.m1', coalesce(public.staff_move_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000301', p_idempotency_key => 'd7000000-0000-4000-8000-000000000001',
      p_new_starts_at => pg_temp.k('3 days 1 hour'), p_notify => true)::text, 'null'), true)$$,
  'move: staff move their own appointment one hour later'
);

select is(
  current_setting('anaklo.notify_client', true),
  'true',
  'move: notify for a future start is handed to the planner as anaklo.notify_client = true'
);

select lives_ok(
  $$select set_config('t.m1b', coalesce(public.staff_move_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000301', p_idempotency_key => 'd7000000-0000-4000-8000-000000000001',
      p_new_starts_at => pg_temp.k('3 days 1 hour'), p_notify => true)::text, 'null'), true)$$,
  'move: a retry with the same key and payload succeeds'
);

select throws_ok(
  $$select public.staff_move_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000301', p_idempotency_key => 'd7000000-0000-4000-8000-000000000001',
      p_new_starts_at => pg_temp.k('3 days 2 hours'), p_notify => true)$$,
  'P0001', 'AN004',
  'move: the same key with another payload is refused (AN004)'
);

select lives_ok(
  $$select set_config('t.m2', coalesce(public.staff_move_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000301', p_idempotency_key => 'd7000000-0000-4000-8000-000000000002',
      p_new_starts_at => pg_temp.k('3 days 1 hour'), p_notify => false,
      p_new_staff_id => 'd2000000-0000-4000-8000-0000000000a2')::text, 'null'), true)$$,
  'move: staff hand their own appointment to a colleague'
);

select lives_ok(
  $$select set_config('t.m2b', coalesce(public.staff_move_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000301', p_idempotency_key => 'd7000000-0000-4000-8000-000000000002',
      p_new_starts_at => pg_temp.k('3 days 1 hour'), p_notify => false,
      p_new_staff_id => 'd2000000-0000-4000-8000-0000000000a2')::text, 'null'), true)$$,
  'move: a retry of the hand-over replays although the appointment is now the colleague''s'
);

select throws_ok(
  $$select public.staff_move_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000301', p_idempotency_key => 'd7000000-0000-4000-8000-000000000003',
      p_new_starts_at => pg_temp.k('3 days 5 hours'), p_notify => false)$$,
  '42501', null,
  'move: after the hand-over a new attempt on it is a colleague''s appointment (42501)'
);

select throws_ok(
  $$select public.staff_move_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000302', p_idempotency_key => 'd7000000-0000-4000-8000-000000000007',
      p_new_starts_at => pg_temp.k('3 days 5 hours'), p_notify => false)$$,
  '42501', null,
  'move: staff cannot move a colleague''s appointment (42501)'
);

select throws_ok(
  $$select public.staff_move_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000303', p_idempotency_key => 'd7000000-0000-4000-8000-000000000005',
      p_new_starts_at => pg_temp.k('4 days 1 hour 10 minutes'), p_notify => false)$$,
  'P0001', 'AN001',
  'move: into a taken time fails (AN001)'
);

select throws_ok(
  $$select public.staff_move_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000305', p_idempotency_key => 'd7000000-0000-4000-8000-000000000006',
      p_new_starts_at => pg_temp.k('5 days 1 hour'), p_notify => false)$$,
  'P0001', 'AN020',
  'move: a cancelled appointment cannot be moved (AN020)'
);

select throws_ok(
  $$select public.staff_move_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000303', p_idempotency_key => null,
      p_new_starts_at => pg_temp.k('4 days 3 hours'), p_notify => false)$$,
  '22023', null,
  'move: a null idempotency key is refused (22023)'
);

-- Staff member SK2 reuses the key of SK1.
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-4000-8000-0000000000a2", "role": "authenticated", "aal": "aal1"}', true);

select throws_ok(
  $$select public.staff_move_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000301', p_idempotency_key => 'd7000000-0000-4000-8000-000000000002',
      p_new_starts_at => pg_temp.k('3 days 1 hour'), p_notify => false,
      p_new_staff_id => 'd2000000-0000-4000-8000-0000000000a2')$$,
  '42501', null,
  'move: another user cannot replay someone else''s move key (42501)'
);

-- Owner of K.
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-4000-8000-0000000000a0", "role": "authenticated", "aal": "aal1"}', true);

select lives_ok(
  $$select public.staff_move_appointment(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000302', p_idempotency_key => 'd7000000-0000-4000-8000-000000000004',
      p_new_starts_at => pg_temp.k('3 days 4 hours'), p_notify => false)$$,
  'move: the owner moves a staff member''s appointment'
);

set local role postgres;
select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.keys(pg_temp.r('m1')),
  array['appointment_id', 'ends_at', 'from_staff_id', 'from_starts_at', 'notify', 'replayed', 'sms_queued', 'staff_id',
        'starts_at', 'warnings'],
  'move: the answer carries the ten contract keys'
);

select is(
  (select concat_ws(' | ', pg_temp.l((r ->> 'appointment_id')::uuid), pg_temp.l((r ->> 'staff_id')::uuid),
                    ((r ->> 'starts_at')::timestamptz = pg_temp.k('3 days 1 hour'))::text,
                    ((r ->> 'ends_at')::timestamptz = pg_temp.k('3 days 1 hour 30 minutes'))::text,
                    pg_temp.l((r ->> 'from_staff_id')::uuid),
                    ((r ->> 'from_starts_at')::timestamptz = pg_temp.k('3 days'))::text,
                    r ->> 'replayed', r ->> 'notify', r ->> 'sms_queued', (r -> 'warnings')::text)
   from pg_temp.r('m1') as r),
  'mv1 | SK1 | true | true | SK1 | true | false | true | false | []',
  'move: new start and end, the values before the move, not replayed, notify effective, no SMS queued before 1.5'
);

select ok(
  pg_temp.r('m1b') ->> 'replayed' = 'true' and (pg_temp.r('m1b') - 'replayed') = (pg_temp.r('m1') - 'replayed'),
  'move: the retry returns the stored result with replayed = true'
);

select is(
  (select concat_ws(' | ', pg_temp.l((r ->> 'staff_id')::uuid), pg_temp.l((r ->> 'from_staff_id')::uuid),
                    ((r ->> 'starts_at')::timestamptz = pg_temp.k('3 days 1 hour'))::text,
                    ((r ->> 'from_starts_at')::timestamptz = pg_temp.k('3 days 1 hour'))::text,
                    r ->> 'replayed', r ->> 'notify')
   from pg_temp.r('m2') as r),
  'SK2 | SK1 | true | true | false | false',
  'move: the hand-over answers the new and the previous staff member at the same time'
);

select ok(
  pg_temp.r('m2b') ->> 'replayed' = 'true' and (pg_temp.r('m2b') - 'replayed') = (pg_temp.r('m2') - 'replayed'),
  'move: the hand-over retry replays the stored result'
);

select is(
  (select string_agg(e.event || ' ' || e.actor_type || ' ' || pg_temp.l(e.actor_id) || ' '
                     || case e.event
                          when 'rescheduled' then (e.old_starts_at = pg_temp.k('3 days'))::text || '/'
                                                  || (e.new_starts_at = pg_temp.k('3 days 1 hour'))::text
                          else pg_temp.l(e.old_staff_id) || '>' || pg_temp.l(e.new_staff_id) end,
                     ', ' order by e.id)
   from public.appointment_events e
   where e.appointment_id = 'd5000000-0000-4000-8000-000000000301' and e.event <> 'created'),
  'rescheduled staff UK1 true/true, reassigned staff UK1 SK1>SK2',
  'move: one rescheduled and one reassigned event, by the staff member; the replays wrote nothing'
);

select is(
  (select concat_ws(' | ', pg_temp.l(a.staff_id), (a.starts_at = pg_temp.k('3 days 1 hour'))::text, a.status)
   from public.appointments a where a.id = 'd5000000-0000-4000-8000-000000000301'),
  'SK2 | true | booked',
  'move: the appointment is at the new time with the colleague'
);

select is(
  (select concat_ws(' | ', count(*)::text, string_agg(pg_temp.l(q.appointment_id), ','), string_agg(pg_temp.l(q.created_by), ','),
                    bool_and(q.request_hash ~ '^[0-9a-f]{64}$')::text)
   from private.move_requests q
   where q.business_id = 'd1000000-0000-4000-8000-00000000000a' and q.idempotency_key = 'd7000000-0000-4000-8000-000000000001'),
  '1 | mv1 | UK1 | true',
  'move: one move request stored per key, with its appointment, its author and a sha256 fingerprint'
);

select is(
  (select count(*) from private.move_requests q
   where q.business_id = 'd1000000-0000-4000-8000-00000000000a'
     and q.idempotency_key in ('d7000000-0000-4000-8000-000000000003', 'd7000000-0000-4000-8000-000000000005',
                               'd7000000-0000-4000-8000-000000000006', 'd7000000-0000-4000-8000-000000000007')),
  0::bigint,
  'move: a failed attempt stores nothing (the same key may run again)'
);

select is(
  (select string_agg(pg_temp.l(a.id) || ' ' || pg_temp.l(a.staff_id) || ' '
                     || (a.starts_at = case pg_temp.l(a.id) when 'mv2' then pg_temp.k('3 days 4 hours')
                                                            else pg_temp.k('4 days') end)::text, ', ' order by a.id)
   from public.appointments a
   where a.id in ('d5000000-0000-4000-8000-000000000302', 'd5000000-0000-4000-8000-000000000303')),
  'mv2 SK2 true, mv3 SK1 true',
  'move: the owner''s move is applied; the refused move changed nothing'
);

select is(
  (select string_agg(e.event || ' ' || e.actor_type || ' ' || pg_temp.l(e.actor_id), ', ' order by e.id)
   from public.appointment_events e
   where e.appointment_id = 'd5000000-0000-4000-8000-000000000302' and e.event <> 'created'),
  'rescheduled staff UK0',
  'move: the owner''s move writes a rescheduled event'
);

-- ---------------------------------------------------------------------------------------------
-- search_clients (business K, as staff SK1)
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-4000-8000-0000000000a1", "role": "authenticated", "aal": "aal1"}', true);

select is(
  (select string_agg(s.full_name, ', ' order by s.o)
   from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => 'ΓΙΩΡΓΟΣ')
        with ordinality as s (id, full_name, phone_e164, last_visit_at, o)),
  'Γιώργος Παπαδόπουλος, Giorgos Latinos',
  'search: ΓΙΩΡΓΟΣ finds the Greek and the Latin-stored name, not the merged, erased or foreign ones; last visit first'
);

select is(
  (select string_agg(s.full_name, ', ' order by s.o)
   from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => 'Γιώργος')
        with ordinality as s (id, full_name, phone_e164, last_visit_at, o)),
  'Γιώργος Παπαδόπουλος, Giorgos Latinos',
  'search: Γιώργος (accents) finds the same clients'
);

select is(
  (select string_agg(s.full_name, ', ' order by s.o)
   from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => 'giorgos')
        with ordinality as s (id, full_name, phone_e164, last_visit_at, o)),
  'Γιώργος Παπαδόπουλος, Giorgos Latinos',
  'search: giorgos (greeklish) finds the same clients'
);

select is(
  (select string_agg(s.full_name, ', ' order by s.o)
   from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => 'Giorgos')
        with ordinality as s (id, full_name, phone_e164, last_visit_at, o)),
  'Γιώργος Παπαδόπουλος, Giorgos Latinos',
  'search: Giorgos (capitalised greeklish) finds the same clients'
);

select is(
  (select string_agg(s.full_name, ', ' order by s.o)
   from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => 'Λατίνος')
        with ordinality as s (id, full_name, phone_e164, last_visit_at, o)),
  'Giorgos Latinos',
  'search: a Greek query finds a name stored in Latin letters'
);

select is(
  (select string_agg(s.full_name, ', ' order by s.o)
   from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => 'giorgos papa')
        with ordinality as s (id, full_name, phone_e164, last_visit_at, o)),
  'Γιώργος Παπαδόπουλος',
  'search: every word of the query must match'
);

select is(
  (select string_agg(s.full_name || ' ' || s.phone_e164, ', ' order by s.o)
   from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => '5678')
        with ordinality as s (id, full_name, phone_e164, last_visit_at, o)),
  'Γιώργος Παπαδόπουλος +306912345678, Μαρία Νικολάου +306956781234',
  'search: the last 4 digits find the phone ending with them first, then one containing them; never the merged client'
);

select is(
  (select string_agg(s.full_name || ' ' || coalesce((s.last_visit_at = now() - interval '10 days 30 minutes')::text, 'none'),
                     ', ' order by s.o)
   from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => 'giorgos')
        with ordinality as s (id, full_name, phone_e164, last_visit_at, o)),
  'Γιώργος Παπαδόπουλος true, Giorgos Latinos none',
  'search: last_visit_at = the latest completed visit with any staff member (not the later cancelled or no-show)'
);

select is(
  (select string_agg(s.full_name, ', ' order by s.o)
   from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => 'Papadopoylos')
        with ordinality as s (id, full_name, phone_e164, last_visit_at, o)),
  'Γιώργος Παπαδόπουλος',
  'search: a misspelling with no exact match falls back to the fuzzy pass'
);

-- The fuzzy pass is its own query: it must leave out the merged (c3 Γιώργος Διπλός) and the
-- erased client (c4, stale search_text 'Γιώργος Σβησμένος') too, although both are its best hits.
select is(
  (select coalesce(string_agg(s.full_name, ', ' order by s.o), '-')
   from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => 'Diplws')
        with ordinality as s (id, full_name, phone_e164, last_visit_at, o)),
  '-',
  'search (fuzzy): a misspelling of the merged client''s name finds nothing'
);

select is(
  (select coalesce(string_agg(s.full_name, ', ' order by s.o), '-')
   from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => 'Γιωργος Δυπλος')
        with ordinality as s (id, full_name, phone_e164, last_visit_at, o)),
  'Γιώργος Παπαδόπουλος, Giorgos Latinos',
  'search (fuzzy): a misspelt full name of the merged client finds only live clients'
);

select is(
  (select coalesce(string_agg(s.full_name, ', ' order by s.o), '-')
   from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => 'Σβισμενος Γιωργος')
        with ordinality as s (id, full_name, phone_e164, last_visit_at, o)),
  'Giorgos Latinos',
  'search (fuzzy): a misspelt name of the erased client finds only live clients'
);

select is(
  (select string_agg(right(s.full_name, 2), ',' order by s.o)
   from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => 'Κώστας')
        with ordinality as s (id, full_name, phone_e164, last_visit_at, o)),
  (select string_agg(lpad(i::text, 2, '0'), ',' order by i) from generate_series(1, 20) as i),
  'search: at most 20 results, in a fixed order (rank, last visit, name)'
);

select is(
  concat_ws(' ',
    (select count(*) from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => 'Γ')),
    (select count(*) from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => '12')),
    (select count(*) from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => null))),
  '0 0 0',
  'search: one letter, two digits or no query return nothing'
);

select throws_ok(
  $$select * from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000a', p_query => repeat('α', 101))$$,
  '22023', null,
  'search: a query longer than 100 characters is refused (22023)'
);

set local role postgres;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------------------------
-- Planner v1.1 (§2.5): 'status_changed' is accepted and does nothing yet
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', 'system', true);

select lives_ok(
  $$select private.plan_messages_impl('d5000000-0000-4000-8000-000000000101', 'status_changed')$$,
  'planner: p_change = status_changed is accepted'
);

select throws_ok(
  $$select private.plan_messages_impl('d5000000-0000-4000-8000-000000000101', 'rescheduled')$$,
  '22023', null,
  'planner: any other new p_change is still refused (22023)'
);

-- ---------------------------------------------------------------------------------------------
-- Auto-complete (§2.7). E = now to the minute − 2h; K completes after 30′, L after 600′.
-- Boundary P = E + 30′: ac1 (ends E) completes at P, not at P − 1′.
-- Every call runs with no declared actor and no JWT: the job must declare 'system' itself.
-- ---------------------------------------------------------------------------------------------
select is(
  (select string_agg(j.jobname || ' | ' || j.schedule || ' | ' || (j.command ~ 'private\.auto_complete_impl\(\)')::text, ', ')
   from cron.job j where j.jobname = 'auto-complete'),
  'auto-complete | */10 * * * * | true',
  'cron: one job auto-complete every 10 minutes calling private.auto_complete_impl()'
);

-- A failing run: a trigger (created and dropped inside this transaction) poisons ac2. The run
-- takes the rows by ends_at, so it completes acp first and then fails on ac2: acp shows whether
-- the work done BEFORE the failure is rolled back too.
create function private.zz_day_ops_poison()
returns trigger
language plpgsql
as $fn$
begin
  raise exception 'poisoned by 11_day_ops' using errcode = 'P0077';
end;
$fn$;

create trigger zz_day_ops_poison
  before update on public.appointments
  for each row when (old.id = 'd5000000-0000-4000-8000-000000000402')
  execute function private.zz_day_ops_poison();

select set_config('anaklo.actor_type', '', true);
select set_config('t.w0_from', clock_timestamp()::text, true);

select lives_ok(
  $$select set_config('t.ac0', coalesce(private.auto_complete_impl(pg_temp.m('-91 minutes'))::text, 'null'), true)$$,
  'auto-complete: a failing run does not raise (the job catches its own error)'
);

select set_config('t.w0_to', clock_timestamp()::text, true);

drop trigger zz_day_ops_poison on public.appointments;
drop function private.zz_day_ops_poison();

select is(
  pg_temp.r('ac0'),
  'null'::jsonb,
  'auto-complete: a failing run returns null'
);

select is(
  pg_temp.runs(current_setting('t.w0_from'), current_setting('t.w0_to')),
  'auto_complete false - P0077',
  'auto-complete: a failing run writes one job run with ok = false and the SQLSTATE'
);

select is(
  concat_ws(' | ',
    (select string_agg(pg_temp.l(a.id) || ' ' || a.status, ', ' order by a.id)
     from public.appointments a
     where a.id in ('d5000000-0000-4000-8000-000000000402', 'd5000000-0000-4000-8000-000000000406')),
    (select count(*)::text
     from public.appointment_events e
     where e.appointment_id in ('d5000000-0000-4000-8000-000000000402', 'd5000000-0000-4000-8000-000000000406')
       and e.event = 'status_changed')),
  'ac2 confirmed, acp booked | 0',
  'auto-complete: a failing run is rolled back whole, also acp that it completed before failing on ac2 (no status_changed event)'
);

-- Run 1 at P − 1′.
select set_config('anaklo.actor_type', '', true);
select set_config('t.w1_from', clock_timestamp()::text, true);

select lives_ok(
  $$select set_config('t.ac1', coalesce(private.auto_complete_impl(pg_temp.m('-91 minutes'))::text, 'null'), true)$$,
  'auto-complete: a run at one minute before the boundary'
);

select set_config('t.w1_to', clock_timestamp()::text, true);

select is(
  current_setting('anaklo.actor_type', true),
  'system',
  'auto-complete: the job declares the system actor itself (the setting outlives the call)'
);

select ok(
  (pg_temp.r('ac1') #>> '{}')::integer >= 2,
  'auto-complete: the run reports the rows it completed (at least ac2 and acp)'
);

select is(
  pg_temp.runs(current_setting('t.w1_from'), current_setting('t.w1_to')),
  'auto_complete true ' || (pg_temp.r('ac1') #>> '{}') || ' -',
  'auto-complete: one job run per call, ok, rows_affected = the returned count'
);

select is(
  (select string_agg(pg_temp.l(a.id) || ' ' || a.status || coalesce(' ' || a.charged_cents::text, ''), ', ' order by a.id)
   from public.appointments a
   where a.id in ('d5000000-0000-4000-8000-000000000401', 'd5000000-0000-4000-8000-000000000402',
                  'd5000000-0000-4000-8000-000000000403', 'd5000000-0000-4000-8000-000000000404',
                  'd5000000-0000-4000-8000-000000000405', 'd5000000-0000-4000-8000-000000000406',
                  'd5000000-0000-4000-8000-000000000409')),
  'ac1 booked, ac2 completed, ac3 cancelled, ac4 no_show, ac5 completed 999, acp completed, acL booked',
  'auto-complete: booked/confirmed past the delay complete; not ac1 (one minute early), never cancelled/no-show/completed, L keeps its own delay'
);

select is(
  (select string_agg(e.event || ' ' || e.from_status || '>' || e.to_status || ' ' || e.actor_type || ' ' || pg_temp.l(e.actor_id),
                     ', ' order by e.id)
   from public.appointment_events e
   where e.appointment_id = 'd5000000-0000-4000-8000-000000000402' and e.event <> 'created'),
  'status_changed confirmed>completed system -',
  'auto-complete: the change is a status_changed event by the system, without a user'
);

-- Run 2 at P.
select set_config('anaklo.actor_type', '', true);
select set_config('t.w2_from', clock_timestamp()::text, true);

select lives_ok(
  $$select set_config('t.ac2', coalesce(private.auto_complete_impl(pg_temp.m('-90 minutes'))::text, 'null'), true)$$,
  'auto-complete: a run exactly at the boundary'
);

select set_config('t.w2_to', clock_timestamp()::text, true);

select is(
  concat_ws(' | ',
    (select a.status from public.appointments a where a.id = 'd5000000-0000-4000-8000-000000000401'),
    (select a.status from public.appointments a where a.id = 'd5000000-0000-4000-8000-000000000409'),
    pg_temp.runs(current_setting('t.w2_from'), current_setting('t.w2_to'))),
  'completed | booked | auto_complete true ' || (pg_temp.r('ac2') #>> '{}') || ' -',
  'auto-complete: ends_at + delay = p_now completes; L''s appointment still waits; a job run again'
);

-- The staff member corrects the auto-completed appointment inside the window (actor reset first).
select set_config('anaklo.actor_type', '', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-4000-8000-0000000000a2", "role": "authenticated", "aal": "aal1"}', true);

select lives_ok(
  $$select set_config('t.fix', coalesce(public.set_appointment_status(p_business_id => 'd1000000-0000-4000-8000-00000000000a',
      p_appointment_id => 'd5000000-0000-4000-8000-000000000401', p_from_status => 'completed', p_status => 'no_show')::text, 'null'), true)$$,
  'auto-complete: the staff member corrects an auto-completed appointment to no_show'
);

set local role postgres;
select set_config('request.jwt.claims', '', true);

select is(
  concat_ws(' | ',
    (select concat_ws(' ', r ->> 'status', r ->> 'from_status', r ->> 'changed') from pg_temp.r('fix') as r),
    (select a.status from public.appointments a where a.id = 'd5000000-0000-4000-8000-000000000401'),
    (select e.from_status || '>' || e.to_status || ' ' || e.actor_type || ' ' || pg_temp.l(e.actor_id)
     from public.appointment_events e
     where e.appointment_id = 'd5000000-0000-4000-8000-000000000401' and e.event = 'status_changed'
     order by e.id desc limit 1)),
  'no_show completed true | no_show | completed>no_show staff UK2',
  'auto-complete: the correction is stored and logged as the staff member, not as the system'
);

-- ---------------------------------------------------------------------------------------------
-- search_clients cost: business L gets 3000 synthetic clients; its owner UL0 searches. The quick
-- add searches on every debounced keystroke, so the spellings of the query must be computed once
-- per call, never once per client and word (that cost ~0.2 ms per client per word: over 2 s for
-- these four searches). Now they take a few tens of ms; the bound leaves room for slower hosts.
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', 'system', true);

insert into public.clients (business_id, full_name, source)
select 'd1000000-0000-4000-8000-00000000000b',
       (array['Γιώργος', 'Νίκος', 'Μαρία', 'Ελένη', 'Κώστας', 'Δημήτρης'])[1 + i % 6] || ' '
         || (array['Παπαδόπουλος', 'Ιωάννου', 'Γεωργίου', 'Νικολάου', 'Αλεξίου'])[1 + (i / 6) % 5]
         || ' ' || i,
       'staff'
from generate_series(1, 3000) as i;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-4000-8000-0000000000b0", "role": "authenticated", "aal": "aal1"}', true);
select set_config('t.perf_from', clock_timestamp()::text, true);

select set_config('t.perf_rows', concat_ws(' ',
  (select count(*) from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000b', p_query => 'γι')),
  (select count(*) from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000b', p_query => 'Γιώργος Παπαδόπουλος')),
  (select count(*) from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000b', p_query => 'nikos ioannou 1')),
  (select count(*) from public.search_clients(p_business_id => 'd1000000-0000-4000-8000-00000000000b', p_query => 'zzzzqqq'))), true);

select set_config('t.perf_ms',
  (extract(epoch from clock_timestamp() - current_setting('t.perf_from')::timestamptz) * 1000)::integer::text, true);

set local role postgres;
select set_config('request.jwt.claims', '', true);

select is(
  current_setting('t.perf_rows'),
  '20 20 20 0',
  'search at 3000 clients: a prefix, a full name, greeklish words and a miss (with the fuzzy pass)'
);

select cmp_ok(
  current_setting('t.perf_ms')::integer, '<', 500,
  'search at 3000 clients: the four searches take < 500 ms together (spellings computed once per call)'
);

select * from finish();
rollback;
