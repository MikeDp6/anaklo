-- Schedules: working hours and schedule exceptions never overlap within their scope, and time
-- off reasons stay free of health data.
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
select plan(12);

insert into public.businesses (id, slug, name, vertical, timezone)
values ('71000000-0000-4000-8000-000000000001', 'shop-g', 'Shop G', 'barber', 'Europe/Athens');
insert into public.staff (id, business_id, display_name) values
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'G One'),
  ('72000000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000001', 'G Two');

-- Tuesday 09:00–14:00 for G One.
insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
values ('71000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', 2, '09:00', '14:00');

-- ---------------------------------------------------------------------------------------------
-- Working hours
-- ---------------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
    values ('71000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', 2, '13:00', '18:00')$$,
  '23P01', null,
  'overlapping working hours for the same staff member and day are rejected'
);

select lives_ok(
  $$insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
    values ('71000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', 2, '14:00', '21:00')$$,
  'a split shift that starts when the first part ends is allowed'
);

select lives_ok(
  $$insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
    values ('71000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', 3, '09:00', '14:00')$$,
  'the same hours on another day are allowed'
);

select lives_ok(
  $$insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
    values ('71000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000002', 2, '09:00', '14:00')$$,
  'the same hours for another staff member are allowed'
);

-- ---------------------------------------------------------------------------------------------
-- Schedule exceptions: per scope (shop / staff member) and date
-- ---------------------------------------------------------------------------------------------
insert into public.schedule_exceptions (business_id, staff_id, local_date, kind)
values ('71000000-0000-4000-8000-000000000001', null, '2026-12-24', 'closed');

select throws_ok(
  $$insert into public.schedule_exceptions (business_id, staff_id, local_date, kind, start_time, end_time)
    values ('71000000-0000-4000-8000-000000000001', null, '2026-12-24', 'open', '10:00', '14:00')$$,
  '23P01', null,
  'the shop cannot be both closed and open on the same date'
);

select throws_ok(
  $$insert into public.schedule_exceptions (business_id, staff_id, local_date, kind)
    values ('71000000-0000-4000-8000-000000000001', null, '2026-12-24', 'closed')$$,
  '23P01', null,
  'a date cannot be closed twice for the same scope'
);

select lives_ok(
  $$insert into public.schedule_exceptions (business_id, staff_id, local_date, kind, start_time, end_time)
    values ('71000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', '2026-12-24', 'open', '10:00', '14:00')$$,
  'a staff exception may coexist with a shop exception on the same date (staff takes precedence)'
);

select throws_ok(
  $$insert into public.schedule_exceptions (business_id, staff_id, local_date, kind, start_time, end_time)
    values ('71000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', '2026-12-24', 'open', '13:00', '16:00')$$,
  '23P01', null,
  'overlapping open intervals for the same staff member and date are rejected'
);

select lives_ok(
  $$insert into public.schedule_exceptions (business_id, staff_id, local_date, kind, start_time, end_time)
    values ('71000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', '2026-12-24', 'open', '17:00', '20:00')$$,
  'a second, separate open interval on the same date is allowed (split shift)'
);

select lives_ok(
  $$insert into public.schedule_exceptions (business_id, staff_id, local_date, kind)
    values ('71000000-0000-4000-8000-000000000001', null, '2026-12-25', 'closed')$$,
  'closing the next date is allowed'
);

-- ---------------------------------------------------------------------------------------------
-- Time off: neutral reasons only (no health data, GDPR art. 9)
-- ---------------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.time_off (business_id, staff_id, starts_at, ends_at, reason)
    values ('71000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001',
            '2026-11-10 00:00Z', '2026-11-11 00:00Z', 'sick')$$,
  '23514', null,
  'a time off reason can never say "sick"'
);

select lives_ok(
  $$insert into public.time_off (business_id, staff_id, starts_at, ends_at, reason)
    values ('71000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001',
            '2026-11-10 00:00Z', '2026-11-11 00:00Z', 'leave')$$,
  'a neutral "leave" covers any absence'
);

select * from finish();
rollback;
