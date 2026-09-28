-- Availability (SPEC §8, ADR-0003, phase-1 plan 1.2): service terms per staff member, daily
-- working windows (exceptions, time off, DST), the local slot grid, buffers, public/staff filters,
-- "any staff", the public catalogue and the exposed wrappers.
-- Every call of the private functions passes a fixed p_now, so results never depend on the clock.
-- Expected slot lists are written as local wall-clock times of the business.
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
-- Fixture appointments are written by the system (appointment writes must declare an actor).
select set_config('anaklo.actor_type', 'system', true);
select plan(87);

-- ---------------------------------------------------------------------------------------------
-- Fixture (as postgres)
--   A  'avail-athens' Europe/Athens, 15′ grid, 60′ notice, 14 days ahead, booking enabled
--   N  'avail-nyc'    America/New_York, 20′ grid, no notice
--   S1 Nikos: Mon 09–11 + 17–18 (split shift), Tue–Fri 09–12      (weekday: 0 = Sunday)
--   S2 Maria: Mon–Fri 10–12, custom Cut (45′, 15.00)
--   S3 Night: every day 00:00–05:00 (night shift), Beard only
--   S4 Former: inactive, Mon 09–12, Cut
--   Cut 30′ + 10′ buffer 13.00 · Beard 15′ 7.00 · Colour 60′ + 15′ 40.00 (staff only)
--   Old cut: inactive
-- All dates from 2026-10-26 on are EET (UTC+2); 2026-03-29 and 2026-10-25 are the DST days.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('80000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'staff-avail@test.local', '{}', '{}', now(), now()),
  ('80000000-0000-4000-8000-0000000000e1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider-avail@test.local', '{}', '{}', now(), now());

insert into public.businesses (id, slug, name, vertical, timezone, slot_step_min, min_notice_min, max_advance_days,
                               booking_enabled, allow_any_staff, phone_e164, theme) values
  ('81000000-0000-4000-8000-00000000000a', 'avail-athens', 'Avail Athens', 'barber', 'Europe/Athens', 15, 60, 14,
   true, true, '+302100000081', '{"primary": "#112233"}'),
  ('81000000-0000-4000-8000-00000000000b', 'avail-nyc', 'Avail NYC', 'barber', 'America/New_York', 20, 0, 60,
   true, true, null, '{}');

insert into public.staff (id, business_id, display_name, sort, active) values
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-00000000000a', 'Nikos', 0, true),
  ('82000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-00000000000a', 'Maria', 1, true),
  ('82000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-00000000000a', 'Night', 2, true),
  ('82000000-0000-4000-8000-000000000004', '81000000-0000-4000-8000-00000000000a', 'Former', 3, false),
  ('82000000-0000-4000-8000-0000000000b1', '81000000-0000-4000-8000-00000000000b', 'Ny One', 0, true);

insert into public.business_members (business_id, user_id, role, staff_id) values
  ('81000000-0000-4000-8000-00000000000a', '80000000-0000-4000-8000-0000000000a1', 'staff', '82000000-0000-4000-8000-000000000001');

insert into public.service_categories (id, business_id, name, sort) values
  ('83000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-00000000000a', 'Hair', 0);

insert into public.services (id, business_id, category_id, name, duration_min, buffer_after_min, price_cents, active, online_bookable, sort) values
  ('84000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-00000000000a', '83000000-0000-4000-8000-000000000001', 'Cut', 30, 10, 1300, true, true, 0),
  ('84000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-00000000000a', '83000000-0000-4000-8000-000000000001', 'Beard', 15, 0, 700, true, true, 1),
  ('84000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-00000000000a', '83000000-0000-4000-8000-000000000001', 'Colour', 60, 15, 4000, true, false, 2),
  ('84000000-0000-4000-8000-000000000004', '81000000-0000-4000-8000-00000000000a', '83000000-0000-4000-8000-000000000001', 'Old cut', 20, 0, 900, false, true, 3),
  ('84000000-0000-4000-8000-0000000000b1', '81000000-0000-4000-8000-00000000000b', null, 'NY cut', 40, 0, 3500, true, true, 0);

insert into public.staff_services (business_id, staff_id, service_id, custom_duration_min, custom_price_cents) values
  ('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001', '84000000-0000-4000-8000-000000000001', null, null),
  ('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001', '84000000-0000-4000-8000-000000000002', null, null),
  ('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001', '84000000-0000-4000-8000-000000000003', null, null),
  ('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001', '84000000-0000-4000-8000-000000000004', null, null),
  ('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000002', '84000000-0000-4000-8000-000000000001', 45, 1500),
  ('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000002', '84000000-0000-4000-8000-000000000002', null, null),
  ('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000003', '84000000-0000-4000-8000-000000000002', null, null),
  ('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000004', '84000000-0000-4000-8000-000000000001', null, null),
  ('81000000-0000-4000-8000-00000000000b', '82000000-0000-4000-8000-0000000000b1', '84000000-0000-4000-8000-0000000000b1', null, null);

-- Weekly hours (local wall-clock times).
insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
select '81000000-0000-4000-8000-00000000000a'::uuid, '82000000-0000-4000-8000-000000000001'::uuid, d, t.s, t.e
from (values (1, '09:00'::time, '11:00'::time), (1, '17:00', '18:00'),
             (2, '09:00', '12:00'), (3, '09:00', '12:00'), (4, '09:00', '12:00'), (5, '09:00', '12:00')) t (d, s, e);

insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
select '81000000-0000-4000-8000-00000000000a'::uuid, '82000000-0000-4000-8000-000000000002'::uuid, d, '10:00', '12:00'
from generate_series(1, 5) d;

insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
select '81000000-0000-4000-8000-00000000000a'::uuid, '82000000-0000-4000-8000-000000000003'::uuid, d, '00:00', '05:00'
from generate_series(0, 6) d;

insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time) values
  ('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000004', 1, '09:00', '12:00'),
  ('81000000-0000-4000-8000-00000000000b', '82000000-0000-4000-8000-0000000000b1', 2, '09:10', '11:00'),
  ('81000000-0000-4000-8000-00000000000b', '82000000-0000-4000-8000-0000000000b1', 2, '20:00', '21:00');

-- Exceptions:
--   Wed 2026-10-28 public holiday: shop closed
--   Tue 2026-11-03 shop closed, but Nikos opens 10:00–11:00 (staff beats shop)
--   Wed 2026-11-04 shortened day: the shop opens only 10:00–11:00
--   Thu 2026-11-05 Maria has the day off
--   Sat 2026-11-14 Nikos (no weekly hours on Saturday) opens 09–10, 10–11 and 15–16
insert into public.schedule_exceptions (business_id, staff_id, local_date, kind, start_time, end_time, note) values
  ('81000000-0000-4000-8000-00000000000a', null, '2026-10-28', 'closed', null, null, 'Holiday'),
  ('81000000-0000-4000-8000-00000000000a', null, '2026-11-03', 'closed', null, null, null),
  ('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001', '2026-11-03', 'open', '10:00', '11:00', null),
  ('81000000-0000-4000-8000-00000000000a', null, '2026-11-04', 'open', '10:00', '11:00', null),
  ('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000002', '2026-11-05', 'closed', null, null, null),
  ('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001', '2026-11-14', 'open', '09:00', '10:00', null),
  ('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001', '2026-11-14', 'open', '10:00', '11:00', null),
  ('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001', '2026-11-14', 'open', '15:00', '16:00', null);

-- Thu 2026-11-05: Nikos is away 10:00–11:00 local.
insert into public.time_off (business_id, staff_id, starts_at, ends_at, reason) values
  ('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001', '2026-11-05 08:00Z', '2026-11-05 09:00Z', 'personal');

-- Fri 2026-11-06, Nikos (local = UTC+2):
--   A1 booked    09:00–09:30 + 10′ buffer (blocks until 09:40)
--   A2 cancelled 10:00–10:30, A3 no_show 10:30–11:00 (never block)
--   A4 confirmed 11:30–11:45, no buffer
insert into public.appointments (id, business_id, staff_id, starts_at, ends_at, buffer_after_min, status, source, cancelled_by, cancel_reason) values
  ('85000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001',
   '2026-11-06 07:00Z', '2026-11-06 07:30Z', 10, 'booked', 'phone', null, null),
  ('85000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001',
   '2026-11-06 08:00Z', '2026-11-06 08:30Z', 10, 'cancelled', 'phone', 'client', 'client_request'),
  ('85000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001',
   '2026-11-06 08:30Z', '2026-11-06 09:00Z', 0, 'no_show', 'phone', null, null),
  ('85000000-0000-4000-8000-000000000004', '81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001',
   '2026-11-06 09:30Z', '2026-11-06 09:45Z', 0, 'confirmed', 'phone', null, null);

-- ---------------------------------------------------------------------------------------------
-- Helpers (pg_temp, vanish with the session). They never raise: an error comes back as a value
-- ('ERROR <sqlstate> <message>'), so one failing call fails one assertion, not the whole file.
-- ---------------------------------------------------------------------------------------------

-- Slots of private.available_slots_impl, ordered by starts_at, as text:
--   'time'  → local time 'HH:MI'            'date' → local date
--   'full'  → 'UTC instant Z local_date HH:MI'
--   'staff' → 'HH:MI=<staff names>'         'bad'  → only rows whose local date/time differ from
--                                                    starts_at in the business time zone
create function pg_temp.slot_list(
  a_business uuid, a_services uuid[], a_staff uuid, a_from date, a_to date, a_mode text,
  a_now timestamptz, a_format text default 'time', a_exclude uuid default null
)
returns text[]
language plpgsql
as $fn$
declare
  v_tz text := (select b.timezone from public.businesses b where b.id = a_business);
  v_list text[];
begin
  select coalesce(array_remove(array_agg(
           case a_format
             when 'time' then left(s.local_time::text, 5)
             when 'date' then s.local_date::text
             when 'full' then to_char(s.starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z '
                              || s.local_date::text || ' ' || left(s.local_time::text, 5)
             when 'staff' then left(s.local_time::text, 5) || '=' || coalesce((
                                 select string_agg(st.display_name, '+' order by st.display_name collate "C")
                                 from unnest(s.staff_ids) as u (id)
                                 join public.staff st on st.id = u.id), '')
             when 'bad' then case
                               when s.local_date is distinct from (s.starts_at at time zone v_tz)::date
                                 or s.local_time is distinct from (s.starts_at at time zone v_tz)::time
                               then to_char(s.starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z -> '
                                    || s.local_date::text || ' ' || s.local_time::text
                             end
           end
           order by s.starts_at), null), '{}')
  into v_list
  from private.available_slots_impl(
    p_business_id => a_business, p_service_ids => a_services, p_staff_id => a_staff,
    p_from => a_from, p_to => a_to, p_mode => a_mode,
    p_exclude_appointment_id => a_exclude, p_now => a_now) as s;
  return v_list;
exception when others then
  return array['ERROR ' || sqlstate || ' ' || sqlerrm];
end;
$fn$;

-- Working windows of private.staff_day_windows as 'YYYY-MM-DD HH:MIZ - YYYY-MM-DD HH:MIZ' (UTC).
create function pg_temp.windows(a_business uuid, a_staff uuid, a_date date)
returns text[]
language plpgsql
as $fn$
declare
  v_list text[];
begin
  select coalesce(array_agg(
           to_char(w.starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z - '
           || to_char(w.ends_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z'
           order by w.starts_at), '{}')
  into v_list
  from private.staff_day_windows(p_business_id => a_business, p_staff_id => a_staff, p_local_date => a_date) as w;
  return v_list;
exception when others then
  return array['ERROR ' || sqlstate || ' ' || sqlerrm];
end;
$fn$;

-- private.service_terms as 'duration/buffer/price line:duration:price,…' (lines by position),
-- or 'none' when it returns no row.
create function pg_temp.terms(a_business uuid, a_staff uuid, a_services uuid[], a_public boolean)
returns text
language plpgsql
as $fn$
declare
  v text;
begin
  select string_agg(
           t.duration_min || '/' || t.buffer_after_min || '/' || t.price_cents || ' ' || coalesce((
             select string_agg(sv.name || ':' || (l.value ->> 'duration_min') || ':' || (l.value ->> 'price_cents'),
                               ',' order by (l.value ->> 'position')::int)
             from jsonb_array_elements(t.lines) as l
             join public.services sv on sv.id = (l.value ->> 'service_id')::uuid), '?'),
           ';')
  into v
  from private.service_terms(p_business_id => a_business, p_staff_id => a_staff,
                             p_service_ids => a_services, p_public => a_public) as t;
  return coalesce(v, 'none');
exception when others then
  return 'ERROR ' || sqlstate || ' ' || sqlerrm;
end;
$fn$;

-- The catalogue fetched as anon (stored in a transaction-local setting).
create function pg_temp.cat()
returns jsonb
language sql
as $fn$
  select nullif(current_setting('t.cat', true), '')::jsonb;
$fn$;

-- ---------------------------------------------------------------------------------------------
-- New business columns: address and an https maps link
-- ---------------------------------------------------------------------------------------------
select lives_ok(
  $$update public.businesses set address = 'Ermou 81, Athina', maps_url = 'https://maps.example/avail-athens'
    where id = '81000000-0000-4000-8000-00000000000a'$$,
  'a business stores an address and an https maps link'
);

select throws_ok(
  $$update public.businesses set maps_url = 'http://maps.example/avail-athens'
    where id = '81000000-0000-4000-8000-00000000000a'$$,
  '23514', null,
  'the maps link must be https'
);

select throws_ok(
  $$update public.businesses set maps_url = 'javascript:alert(1)'
    where id = '81000000-0000-4000-8000-00000000000a'$$,
  '23514', null,
  'the maps link can never be a script URL'
);

select throws_ok(
  $$update public.businesses set maps_url = 'https://' || repeat('a', 493)
    where id = '81000000-0000-4000-8000-00000000000a'$$,
  '23514', null,
  'the maps link is at most 500 characters'
);

select throws_ok(
  $$update public.businesses set address = repeat('a', 201)
    where id = '81000000-0000-4000-8000-00000000000a'$$,
  '23514', null,
  'the address is at most 200 characters'
);

-- ---------------------------------------------------------------------------------------------
-- private.service_terms: per staff member, custom or default; buffer of the LAST service
-- ---------------------------------------------------------------------------------------------
select is(
  pg_temp.terms('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001',
                array['84000000-0000-4000-8000-000000000001']::uuid[], false),
  '30/10/1300 Cut:30:1300',
  'terms: default duration, buffer and price'
);

select is(
  pg_temp.terms('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000002',
                array['84000000-0000-4000-8000-000000000001']::uuid[], false),
  '45/10/1500 Cut:45:1500',
  'terms: custom duration and price of the staff member'
);

select is(
  pg_temp.terms('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000002',
                array['84000000-0000-4000-8000-000000000001', '84000000-0000-4000-8000-000000000002']::uuid[], false),
  '60/0/2200 Cut:45:1500,Beard:15:700',
  'terms: several services add up; the buffer is the last service''s (Beard, none)'
);

select is(
  pg_temp.terms('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000002',
                array['84000000-0000-4000-8000-000000000002', '84000000-0000-4000-8000-000000000001']::uuid[], false),
  '60/10/2200 Beard:15:700,Cut:45:1500',
  'terms: the order of the services decides the buffer (Cut last: 10′) and the line order'
);

select is(
  pg_temp.terms('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000002',
                array['84000000-0000-4000-8000-000000000003']::uuid[], false),
  'none',
  'terms: no row when the staff member does not offer the service'
);

select is(
  pg_temp.terms('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001',
                array['84000000-0000-4000-8000-000000000003']::uuid[], true),
  'none',
  'terms: no row for a staff-only service in public mode'
);

select is(
  pg_temp.terms('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001',
                array['84000000-0000-4000-8000-000000000003']::uuid[], false),
  '60/15/4000 Colour:60:4000',
  'terms: the staff-only service is available in staff mode'
);

select is(
  pg_temp.terms('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001',
                array['84000000-0000-4000-8000-000000000004']::uuid[], false),
  'none',
  'terms: no row for an inactive service, even in staff mode'
);

select is(
  pg_temp.terms('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001',
                array['84000000-0000-4000-8000-0000000000b1']::uuid[], false),
  'none',
  'terms: no row for a service of another business'
);

-- ---------------------------------------------------------------------------------------------
-- private.staff_day_windows: staff exception > shop exception > weekly hours, minus time off,
-- local → UTC once per date
-- ---------------------------------------------------------------------------------------------
select is(
  pg_temp.windows('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001', '2026-11-02'),
  array['2026-11-02 07:00Z - 2026-11-02 09:00Z', '2026-11-02 15:00Z - 2026-11-02 16:00Z'],
  'windows: a split shift gives two windows'
);

select is(
  pg_temp.windows('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001', '2026-11-03'),
  array['2026-11-03 08:00Z - 2026-11-03 09:00Z'],
  'windows: a staff open exception beats a shop closure'
);

select is(
  pg_temp.windows('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000002', '2026-11-03'),
  '{}'::text[],
  'windows: a shop closure closes everyone without an exception of their own'
);

select is(
  pg_temp.windows('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000002', '2026-11-04'),
  array['2026-11-04 08:00Z - 2026-11-04 09:00Z'],
  'windows: a shop open exception replaces the weekly hours (shortened day)'
);

select is(
  pg_temp.windows('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001', '2026-11-05'),
  array['2026-11-05 07:00Z - 2026-11-05 08:00Z', '2026-11-05 09:00Z - 2026-11-05 10:00Z'],
  'windows: partial time off cuts a hole in the day'
);

select is(
  pg_temp.windows('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000002', '2026-11-05'),
  '{}'::text[],
  'windows: a staff closed exception is a day off'
);

select is(
  pg_temp.windows('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001', '2026-11-07'),
  '{}'::text[],
  'windows: no weekly hours on that weekday (Saturday) means no windows'
);

select is(
  pg_temp.windows('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000001', '2026-11-14'),
  array['2026-11-14 07:00Z - 2026-11-14 09:00Z', '2026-11-14 13:00Z - 2026-11-14 14:00Z'],
  'windows: several open intervals of the winning scope are united (09–10 and 10–11 become 09–11)'
);

select is(
  pg_temp.windows('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000003', '2026-03-29'),
  array['2026-03-28 22:00Z - 2026-03-29 02:00Z'],
  'windows: 00:00–05:00 on 2026-03-29 lasts 4 real hours (EET → EEST)'
);

select is(
  pg_temp.windows('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000003', '2026-10-25'),
  array['2026-10-24 21:00Z - 2026-10-25 03:00Z'],
  'windows: 00:00–05:00 on 2026-10-25 lasts 6 real hours (EEST → EET)'
);

select is(
  pg_temp.windows('81000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-000000000003', '2026-10-28'),
  '{}'::text[],
  'windows: the 2026-10-28 holiday closes the night shift too'
);

-- ---------------------------------------------------------------------------------------------
-- The grid. p_now = 2026-10-26 06:00Z (Mon 08:00 local) unless stated.
-- ---------------------------------------------------------------------------------------------
select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                    '82000000-0000-4000-8000-000000000001', '2026-11-02', '2026-11-02', 'staff', '2026-10-26 06:00Z'),
  array['09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '17:00', '17:15'],
  'grid: split shift on the 15′ grid; 30′ + 10′ buffer must fit (10:30 would end the service at 11:00 but not the buffer)'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                    '82000000-0000-4000-8000-000000000001', '2026-11-02', '2026-11-02', 'public', '2026-10-26 06:00Z', 'staff'),
  array['09:00=Nikos', '09:15=Nikos', '09:30=Nikos', '09:45=Nikos', '10:00=Nikos', '10:15=Nikos', '17:00=Nikos', '17:15=Nikos'],
  'grid: public mode gives the same slots when notice and horizon allow, with staff_ids = {that staff member}'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                    '82000000-0000-4000-8000-000000000002', '2026-11-02', '2026-11-02', 'staff', '2026-10-26 06:00Z'),
  array['10:00', '10:15', '10:30', '10:45', '11:00'],
  'grid: the custom duration of the staff member is used (45′ + 10′ within 10–12)'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000003']::uuid[],
                    '82000000-0000-4000-8000-000000000001', '2026-11-02', '2026-11-02', 'staff', '2026-10-26 06:00Z'),
  array['09:00', '09:15', '09:30', '09:45'],
  'grid: a staff-only service in staff mode (75′ do not fit into 17–18)'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000b', array['84000000-0000-4000-8000-0000000000b1']::uuid[],
                    '82000000-0000-4000-8000-0000000000b1', '2026-11-10', '2026-11-10', 'public', '2026-11-02 12:00Z', 'full'),
  array[
    '2026-11-10 14:20Z 2026-11-10 09:20', '2026-11-10 14:40Z 2026-11-10 09:40',
    '2026-11-10 15:00Z 2026-11-10 10:00', '2026-11-10 15:20Z 2026-11-10 10:20',
    '2026-11-11 01:00Z 2026-11-10 20:00', '2026-11-11 01:20Z 2026-11-10 20:20'
  ],
  'second business in America/New_York: 20′ LOCAL grid (a 09:10 window starts at 09:20), and evening slots on the next UTC date keep their local date'
);

-- ---------------------------------------------------------------------------------------------
-- Closures, shortened day, time off, holiday
-- ---------------------------------------------------------------------------------------------
select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                    null, '2026-11-03', '2026-11-03', 'staff', '2026-10-26 06:00Z', 'staff'),
  array['10:00=Nikos', '10:15=Nikos'],
  'closures: shop closed, only the staff member with an open exception has slots'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                    null, '2026-11-04', '2026-11-04', 'staff', '2026-10-26 06:00Z', 'staff'),
  array['10:00=Maria+Nikos', '10:15=Nikos'],
  'closures: a shortened day (shop open 10–11 only)'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                    '82000000-0000-4000-8000-000000000001', '2026-11-05', '2026-11-05', 'staff', '2026-10-26 06:00Z'),
  array['09:00', '09:15', '11:00', '11:15'],
  'closures: no slot overlaps partial time off (10–11)'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                    '82000000-0000-4000-8000-000000000002', '2026-11-05', '2026-11-05', 'staff', '2026-10-26 06:00Z'),
  '{}'::text[],
  'closures: a staff day off gives no slots'
);

select ok(
  (select not ('2026-10-28' = any (l)) and '2026-10-27' = any (l)
   from pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000002']::uuid[],
                          null, '2026-10-27', '2026-10-28', 'public', '2026-10-26 06:00Z', 'date') as l),
  'closures: the 2026-10-28 holiday has no public slot, the day before does'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000002']::uuid[],
                    null, '2026-10-28', '2026-10-28', 'staff', '2026-10-26 06:00Z'),
  '{}'::text[],
  'closures: the holiday is closed in staff mode too (including the night shift)'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                    '82000000-0000-4000-8000-000000000001', '2026-11-14', '2026-11-14', 'staff', '2026-10-26 06:00Z'),
  array['09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '15:00', '15:15'],
  'closures: united open intervals let a service run across 10:00 (09:30, 09:45)'
);

-- ---------------------------------------------------------------------------------------------
-- Appointments and buffers (Fri 2026-11-06, Nikos)
-- ---------------------------------------------------------------------------------------------
select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000002']::uuid[],
                    '82000000-0000-4000-8000-000000000001', '2026-11-06', '2026-11-06', 'staff', '2026-10-26 06:00Z'),
  array['09:45', '10:00', '10:15', '10:30', '10:45', '11:00', '11:15', '11:45'],
  'buffers: the 10′ buffer of A1 closes 09:30; cancelled and no-show never block; back-to-back after a buffer-less booking (11:45)'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                    '82000000-0000-4000-8000-000000000001', '2026-11-06', '2026-11-06', 'staff', '2026-10-26 06:00Z'),
  array['09:45', '10:00', '10:15', '10:30', '10:45'],
  'buffers: the new slot''s own buffer must not run into the next booking (11:00 + 30′ + 10′ > 11:30)'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                    '82000000-0000-4000-8000-000000000001', '2026-11-06', '2026-11-06', 'staff', '2026-10-26 06:00Z',
                    'time', '85000000-0000-4000-8000-000000000001'),
  array['09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45'],
  'buffers: p_exclude_appointment_id ignores that appointment (moving it)'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000002']::uuid[],
                    '82000000-0000-4000-8000-000000000001', '2026-11-06', '2026-11-06', 'public', '2026-10-26 06:00Z'),
  array['09:45', '10:00', '10:15', '10:30', '10:45', '11:00', '11:15', '11:45'],
  'buffers: public mode respects buffers the same way'
);

-- ---------------------------------------------------------------------------------------------
-- Public filters: notice, horizon, online_bookable, active, allow_any_staff, booking_enabled
-- ---------------------------------------------------------------------------------------------
select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                    '82000000-0000-4000-8000-000000000001', '2026-11-02', '2026-11-02', 'public', '2026-11-02 07:15Z'),
  array['10:15', '17:00', '17:15'],
  'min_notice: at 09:15 local with 60′ notice the first public slot is 10:15 (inclusive)'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                    '82000000-0000-4000-8000-000000000001', '2026-11-02', '2026-11-02', 'staff', '2026-11-02 07:15Z'),
  array['09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '17:00', '17:15'],
  'min_notice does not apply in staff mode'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                    '82000000-0000-4000-8000-000000000001', '2026-11-09', '2026-11-10', 'public', '2026-10-26 06:00Z', 'date'),
  array_fill('2026-11-09'::text, array[8]),
  'max_advance: 14 days after 2026-10-26 the last bookable local date is 2026-11-09'
);

select is(
  array_length(array_positions(
    pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                      '82000000-0000-4000-8000-000000000001', '2026-11-09', '2026-11-10', 'staff', '2026-10-26 06:00Z', 'date'),
    '2026-11-10'), 1),
  10,
  'max_advance does not apply in staff mode'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000002']::uuid[],
                    '82000000-0000-4000-8000-000000000003', '2026-11-09', '2026-11-10', 'public', '2026-10-26 06:00Z', 'date'),
  array_fill('2026-11-09'::text, array[20]),
  'max_advance counts LOCAL dates: 00:00–02:59 on 2026-11-10 (still 2026-11-09 in UTC) is beyond the horizon'
);

select matches(
  array_to_string(
    pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000003']::uuid[],
                      '82000000-0000-4000-8000-000000000001', '2026-11-02', '2026-11-02', 'public', '2026-10-26 06:00Z'), ','),
  '^(|ERROR P0001 AN003)$',
  'online_bookable: public mode never offers a staff-only service (no slots or AN003)'
);

select matches(
  array_to_string(
    pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000004']::uuid[],
                      '82000000-0000-4000-8000-000000000001', '2026-11-02', '2026-11-02', 'staff', '2026-10-26 06:00Z'), ','),
  '^(|ERROR P0001 AN003)$',
  'active: an inactive service has no slots, even in staff mode (no slots or AN003)'
);

select matches(
  array_to_string(
    pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                      '82000000-0000-4000-8000-000000000004', '2026-11-02', '2026-11-02', 'staff', '2026-10-26 06:00Z'), ','),
  '^(|ERROR P0001 AN008)$',
  'active: an inactive staff member has no slots, even in staff mode (no slots or AN008)'
);

select matches(
  array_to_string(
    pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                      '82000000-0000-4000-8000-000000000004', '2026-11-02', '2026-11-02', 'public', '2026-10-26 06:00Z'), ','),
  '^(|ERROR P0001 AN008)$',
  'active: an inactive staff member has no public slots (no slots or AN008)'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                    null, '2026-11-02', '2026-11-02', 'staff', '2026-10-26 06:00Z', 'staff'),
  array['09:00=Nikos', '09:15=Nikos', '09:30=Nikos', '09:45=Nikos', '10:00=Maria+Nikos', '10:15=Maria+Nikos',
        '10:30=Maria', '10:45=Maria', '11:00=Maria', '17:00=Nikos', '17:15=Nikos'],
  'any staff: one row per start time with every candidate, no duplicates, inactive staff ignored'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                    null, '2026-11-02', '2026-11-02', 'public', '2026-10-26 06:00Z', 'staff'),
  array['09:00=Nikos', '09:15=Nikos', '09:30=Nikos', '09:45=Nikos', '10:00=Maria+Nikos', '10:15=Maria+Nikos',
        '10:30=Maria', '10:45=Maria', '11:00=Maria', '17:00=Nikos', '17:15=Nikos'],
  'any staff: the same union in public mode'
);

update public.businesses set allow_any_staff = false where id = '81000000-0000-4000-8000-00000000000a';

select throws_ok(
  $$select * from private.available_slots_impl(
      p_business_id => '81000000-0000-4000-8000-00000000000a', p_service_ids => array['84000000-0000-4000-8000-000000000001']::uuid[],
      p_staff_id => null, p_from => '2026-11-02', p_to => '2026-11-02', p_mode => 'public',
      p_exclude_appointment_id => null, p_now => '2026-10-26 06:00Z')$$,
  'P0001', 'AN008',
  'allow_any_staff = false: "any staff" is refused in public mode (AN008)'
);

select is(
  array_length(
    pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                      null, '2026-11-02', '2026-11-02', 'staff', '2026-10-26 06:00Z'), 1),
  11,
  'allow_any_staff = false does not restrict staff mode'
);

select is(
  array_length(
    pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                      '82000000-0000-4000-8000-000000000001', '2026-11-02', '2026-11-02', 'public', '2026-10-26 06:00Z'), 1),
  8,
  'allow_any_staff = false: a named staff member is still bookable online'
);

update public.businesses set allow_any_staff = true, booking_enabled = false where id = '81000000-0000-4000-8000-00000000000a';

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                    '82000000-0000-4000-8000-000000000001', '2026-11-02', '2026-11-02', 'public', '2026-10-26 06:00Z'),
  '{}'::text[],
  'booking_enabled = false: public mode returns nothing (no error)'
);

select is(
  array_length(
    pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                      '82000000-0000-4000-8000-000000000001', '2026-11-02', '2026-11-02', 'staff', '2026-10-26 06:00Z'), 1),
  8,
  'booking_enabled = false does not affect staff mode'
);

select is(
  public.public_booking_catalogue('avail-athens'),
  null::jsonb,
  'booking_enabled = false: the catalogue is null'
);

set local role anon;

select is_empty(
  $$select * from public.available_slots('avail-athens', array['84000000-0000-4000-8000-000000000001']::uuid[],
                                         '82000000-0000-4000-8000-000000000001', '2026-11-02', '2026-11-02')$$,
  'booking_enabled = false: the anon wrapper returns nothing'
);

set local role postgres;

update public.businesses set booking_enabled = true where id = '81000000-0000-4000-8000-00000000000a';

-- ---------------------------------------------------------------------------------------------
-- Time zones: DST days with the 00:00–05:00 night shift, and local 00:00–02:59
-- ---------------------------------------------------------------------------------------------
select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000002']::uuid[],
                    '82000000-0000-4000-8000-000000000003', '2026-03-29', '2026-03-29', 'staff', '2026-03-01 00:00Z'),
  array['00:00', '00:15', '00:30', '00:45', '01:00', '01:15', '01:30', '01:45',
        '02:00', '02:15', '02:30', '02:45', '04:00', '04:15', '04:30', '04:45'],
  'DST 2026-03-29: the lost hour 03:00–03:59 has no slots and nothing is doubled (16 slots in 4 real hours)'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000002']::uuid[],
                    '82000000-0000-4000-8000-000000000003', '2026-10-25', '2026-10-25', 'staff', '2026-10-01 00:00Z'),
  array['00:00', '00:15', '00:30', '00:45', '01:00', '01:15', '01:30', '01:45',
        '02:00', '02:15', '02:30', '02:45', '03:00', '03:15', '03:30', '03:45',
        '04:00', '04:15', '04:30', '04:45'],
  'DST 2026-10-25: the repeated hour 03:00–03:59 is offered once (no duplicate local times)'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000002']::uuid[],
                    '82000000-0000-4000-8000-000000000003', '2026-03-29', '2026-03-29', 'staff', '2026-03-01 00:00Z', 'bad')
  || pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000002']::uuid[],
                       '82000000-0000-4000-8000-000000000003', '2026-10-25', '2026-10-25', 'staff', '2026-10-01 00:00Z', 'bad')
  || pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000002']::uuid[],
                       '82000000-0000-4000-8000-000000000003', '2026-11-12', '2026-11-13', 'staff', '2026-10-26 06:00Z', 'bad')
  || pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000001']::uuid[],
                       null, '2026-11-02', '2026-11-02', 'staff', '2026-10-26 06:00Z', 'bad')
  || pg_temp.slot_list('81000000-0000-4000-8000-00000000000b', array['84000000-0000-4000-8000-0000000000b1']::uuid[],
                       '82000000-0000-4000-8000-0000000000b1', '2026-11-10', '2026-11-10', 'public', '2026-11-02 12:00Z', 'bad'),
  '{}'::text[],
  'local_date and local_time are always starts_at in the business time zone (DST days, night shift, New York)'
);

select is(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000002']::uuid[],
                    '82000000-0000-4000-8000-000000000003', '2026-11-12', '2026-11-13', 'staff', '2026-10-26 06:00Z', 'date'),
  array_fill('2026-11-12'::text, array[20]) || array_fill('2026-11-13'::text, array[20]),
  'local 00:00–04:59 belongs to its local date: 20 night slots per date, none leaking into the neighbour'
);

select ok(
  pg_temp.slot_list('81000000-0000-4000-8000-00000000000a', array['84000000-0000-4000-8000-000000000002']::uuid[],
                    '82000000-0000-4000-8000-000000000003', '2026-11-12', '2026-11-13', 'staff', '2026-10-26 06:00Z', 'full')
  @> array['2026-11-11 22:00Z 2026-11-12 00:00', '2026-11-12 00:45Z 2026-11-12 02:45',
           '2026-11-12 22:00Z 2026-11-13 00:00', '2026-11-13 00:45Z 2026-11-13 02:45'],
  'local 00:00 and 02:45 fall on the previous/same UTC date but carry the right local date'
);

-- ---------------------------------------------------------------------------------------------
-- Range and mode
-- ---------------------------------------------------------------------------------------------
select lives_ok(
  $$select * from private.available_slots_impl(
      p_business_id => '81000000-0000-4000-8000-00000000000a', p_service_ids => array['84000000-0000-4000-8000-000000000001']::uuid[],
      p_staff_id => '82000000-0000-4000-8000-000000000001', p_from => '2026-11-02', p_to => '2026-11-15', p_mode => 'staff',
      p_exclude_appointment_id => null, p_now => '2026-10-26 06:00Z')$$,
  'range: 14 local dates (inclusive) are allowed'
);

select throws_ok(
  $$select * from private.available_slots_impl(
      p_business_id => '81000000-0000-4000-8000-00000000000a', p_service_ids => array['84000000-0000-4000-8000-000000000001']::uuid[],
      p_staff_id => '82000000-0000-4000-8000-000000000001', p_from => '2026-11-02', p_to => '2026-11-16', p_mode => 'staff',
      p_exclude_appointment_id => null, p_now => '2026-10-26 06:00Z')$$,
  'P0001', 'AN002',
  'range: 15 local dates are refused (AN002)'
);

select throws_ok(
  $$select * from private.available_slots_impl(
      p_business_id => '81000000-0000-4000-8000-00000000000a', p_service_ids => array['84000000-0000-4000-8000-000000000001']::uuid[],
      p_staff_id => '82000000-0000-4000-8000-000000000001', p_from => '2026-11-02', p_to => '2026-11-01', p_mode => 'staff',
      p_exclude_appointment_id => null, p_now => '2026-10-26 06:00Z')$$,
  'P0001', 'AN002',
  'range: p_to before p_from is refused (AN002)'
);

select throws_ok(
  $$select * from private.available_slots_impl(
      p_business_id => '81000000-0000-4000-8000-00000000000a', p_service_ids => array['84000000-0000-4000-8000-000000000001']::uuid[],
      p_staff_id => '82000000-0000-4000-8000-000000000001', p_from => '2026-11-02', p_to => '2026-11-02', p_mode => 'admin',
      p_exclude_appointment_id => null, p_now => '2026-10-26 06:00Z')$$,
  null, null,
  'mode: only public and staff exist'
);

-- ---------------------------------------------------------------------------------------------
-- public_booking_catalogue (anon): public fields only, active and online-bookable services only
-- ---------------------------------------------------------------------------------------------
set local role anon;

select lives_ok(
  $$select set_config('t.cat', coalesce(public.public_booking_catalogue('avail-athens')::text, 'null'), true)$$,
  'anon reads the booking catalogue'
);

set local role postgres;

select is(
  (select array_agg(k order by k collate "C") from jsonb_object_keys(pg_temp.cat()) as k),
  array['business', 'categories', 'services', 'staff'],
  'catalogue: only business, categories, services and staff (no clients, no appointments)'
);

select is(
  (select array_agg(k order by k collate "C") from jsonb_object_keys(pg_temp.cat() -> 'business') as k),
  array['address', 'allow_any_staff', 'id', 'locale', 'maps_url', 'max_advance_days', 'min_notice_min', 'name',
        'phone_e164', 'slot_step_min', 'slug', 'theme', 'timezone', 'vertical'],
  'catalogue: exactly the public business fields (no settings, messaging or other policy)'
);

select ok(
  pg_temp.cat() -> 'business' @> jsonb_build_object(
    'id', '81000000-0000-4000-8000-00000000000a', 'slug', 'avail-athens', 'name', 'Avail Athens',
    'vertical', 'barber', 'timezone', 'Europe/Athens', 'locale', 'el', 'theme', jsonb_build_object('primary', '#112233'),
    'address', 'Ermou 81, Athina', 'maps_url', 'https://maps.example/avail-athens', 'phone_e164', '+302100000081',
    'slot_step_min', 15, 'min_notice_min', 60, 'max_advance_days', 14, 'allow_any_staff', true),
  'catalogue: business values'
);

select is(
  (select array_agg((s.value ->> 'name') || ' ' || (s.value ->> 'duration_min') || '/' || (s.value ->> 'price_cents')
                    order by (s.value ->> 'name') collate "C")
   from jsonb_array_elements(pg_temp.cat() -> 'services') as s),
  array['Beard 15/700', 'Cut 30/1300'],
  'catalogue: only active, online-bookable services (no Colour, no Old cut), with default terms'
);

select is(
  (select array_agg(s.value ->> 'display_name' order by (s.value ->> 'display_name') collate "C")
   from jsonb_array_elements(pg_temp.cat() -> 'staff') as s),
  array['Maria', 'Night', 'Nikos'],
  'catalogue: only active staff'
);

select is(
  (select (ss.value ->> 'duration_min') || '/' || (ss.value ->> 'price_cents')
   from jsonb_array_elements(pg_temp.cat() -> 'staff') as st,
        jsonb_array_elements(st.value -> 'services') as ss
   where st.value ->> 'display_name' = 'Maria'
     and ss.value ->> 'service_id' = '84000000-0000-4000-8000-000000000001'),
  '45/1500',
  'catalogue: per-staff terms carry the custom duration and price'
);

select is(
  (select count(*)
   from jsonb_array_elements(pg_temp.cat() -> 'staff') as st,
        jsonb_array_elements(st.value -> 'services') as ss
   where not exists (
     select 1 from jsonb_array_elements(pg_temp.cat() -> 'services') as s
     where s.value ->> 'id' = ss.value ->> 'service_id')),
  0::bigint,
  'catalogue: staff services list only services of the public list (no staff-only or inactive ones)'
);

select is(
  (select array_agg(c.value ->> 'name') from jsonb_array_elements(pg_temp.cat() -> 'categories') as c),
  array['Hair'],
  'catalogue: categories'
);

set local role anon;

select is(
  public.public_booking_catalogue('no-such-shop'),
  null::jsonb,
  'catalogue: null for an unknown slug'
);

-- ---------------------------------------------------------------------------------------------
-- Wrappers
-- ---------------------------------------------------------------------------------------------
select is_empty(
  $$select * from public.available_slots('no-such-shop', array['84000000-0000-4000-8000-000000000001']::uuid[],
                                         null, '2026-11-02', '2026-11-02')$$,
  'available_slots (anon): an unknown slug returns nothing'
);

select isnt_empty(
  $$select * from public.available_slots('avail-athens', array['84000000-0000-4000-8000-000000000002']::uuid[], null,
                                         (now() at time zone 'Europe/Athens')::date + 2,
                                         (now() at time zone 'Europe/Athens')::date + 8)$$,
  'available_slots (anon): the booking page gets slots for the coming week'
);

select throws_ok(
  $$select * from public.staff_available_slots('81000000-0000-4000-8000-00000000000a',
      array['84000000-0000-4000-8000-000000000001']::uuid[], '82000000-0000-4000-8000-000000000001', '2026-11-02', '2026-11-02')$$,
  '42501', null,
  'staff_available_slots: anon cannot call it'
);

set local role postgres;

select is(
  (select array_agg(s::text order by s.starts_at)
   from public.available_slots('avail-athens', array['84000000-0000-4000-8000-000000000002']::uuid[], null,
                               (now() at time zone 'Europe/Athens')::date + 2,
                               (now() at time zone 'Europe/Athens')::date + 8) as s),
  (select array_agg(s::text order by s.starts_at)
   from private.available_slots_impl(
     p_business_id => '81000000-0000-4000-8000-00000000000a', p_service_ids => array['84000000-0000-4000-8000-000000000002']::uuid[],
     p_staff_id => null, p_from => (now() at time zone 'Europe/Athens')::date + 2,
     p_to => (now() at time zone 'Europe/Athens')::date + 8, p_mode => 'public',
     p_exclude_appointment_id => null, p_now => now()) as s),
  'available_slots (anon wrapper) is exactly public mode at the current time'
);

-- A staff member of A (Nikos) looks at a colleague's availability and at his own when moving A1.
select set_config('anaklo.actor_type', '', true);
set local role authenticated;
set local request.jwt.claims to '{"sub": "80000000-0000-4000-8000-0000000000a1", "role": "authenticated", "aal": "aal1"}';

select lives_ok(
  $$select set_config('t.colleague', coalesce((
      select string_agg(left(s.local_time::text, 5), ',' order by s.starts_at)
      from public.staff_available_slots('81000000-0000-4000-8000-00000000000a',
        array['84000000-0000-4000-8000-000000000001']::uuid[], '82000000-0000-4000-8000-000000000002',
        '2026-11-02', '2026-11-02') as s), ''), true)$$,
  'staff_available_slots: a member reads a colleague''s availability'
);

select lives_ok(
  $$select set_config('t.exclude', coalesce((
      select string_agg(left(s.local_time::text, 5), ',' order by s.starts_at)
      from public.staff_available_slots('81000000-0000-4000-8000-00000000000a',
        array['84000000-0000-4000-8000-000000000001']::uuid[], '82000000-0000-4000-8000-000000000001',
        '2026-11-06', '2026-11-06', '85000000-0000-4000-8000-000000000001') as s), ''), true)$$,
  'staff_available_slots: a member reads availability excluding the appointment being moved'
);

set local request.jwt.claims to '{"sub": "80000000-0000-4000-8000-0000000000e1", "role": "authenticated", "aal": "aal1"}';

select throws_ok(
  $$select * from public.staff_available_slots('81000000-0000-4000-8000-00000000000a',
      array['84000000-0000-4000-8000-000000000001']::uuid[], '82000000-0000-4000-8000-000000000001', '2026-11-02', '2026-11-02')$$,
  '42501', null,
  'staff_available_slots: a signed-in non-member gets 42501'
);

set local role postgres;
select set_config('request.jwt.claims', '', true);
select set_config('anaklo.actor_type', 'system', true);

select is(
  current_setting('t.colleague', true),
  '10:00,10:15,10:30,10:45,11:00',
  'staff_available_slots is staff mode (custom terms of the colleague, no notice)'
);

select is(
  current_setting('t.exclude', true),
  '09:00,09:15,09:30,09:45,10:00,10:15,10:30,10:45',
  'staff_available_slots passes p_exclude_appointment_id through'
);

select * from finish();
rollback;
