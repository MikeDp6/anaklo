-- Appointments: double-booking constraint, status transitions and corrections, event history.
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

-- ---------------------------------------------------------------------------------------------
-- Fixture (as postgres): one business, an owner, two staff members with logins, one client.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('c0000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-c@test.local', '{}', '{}', now(), now()),
  ('c0000000-0000-4000-8000-0000000000c1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'staff-c1@test.local', '{}', '{}', now(), now()),
  ('c0000000-0000-4000-8000-0000000000c2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'staff-c2@test.local', '{}', '{}', now(), now());

insert into public.businesses (id, slug, name, vertical, timezone)
values ('c1000000-0000-4000-8000-000000000001', 'shop-c', 'Shop C', 'barber', 'Europe/Athens');
insert into public.staff (id, business_id, display_name) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'C One'),
  ('c2000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'C Two');
insert into public.business_members (business_id, user_id, role, staff_id) values
  ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 'owner', null),
  ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000c1', 'staff', 'c2000000-0000-4000-8000-000000000001'),
  ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000c2', 'staff', 'c2000000-0000-4000-8000-000000000002');
insert into public.clients (id, business_id, full_name, source)
values ('c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'Client C', 'staff');

insert into public.appointments (id, business_id, client_id, staff_id, starts_at, ends_at, source)
values ('c4000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001',
        'c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
        '2026-11-03 08:00Z', '2026-11-03 08:30Z', 'phone');

-- ---------------------------------------------------------------------------------------------
-- Double booking
-- ---------------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.appointments (business_id, staff_id, starts_at, ends_at, source)
    values ('c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
            '2026-11-03 08:15Z', '2026-11-03 08:45Z', 'walkin')$$,
  '23P01',
  null,
  'an overlapping booking for the same staff member is rejected'
);

select lives_ok(
  $$insert into public.appointments (business_id, staff_id, starts_at, ends_at, source)
    values ('c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
            '2026-11-03 08:30Z', '2026-11-03 09:00Z', 'walkin')$$,
  'back-to-back appointments are allowed ([) bounds)'
);

select lives_ok(
  $$insert into public.appointments (business_id, staff_id, starts_at, ends_at, source)
    values ('c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002',
            '2026-11-03 08:15Z', '2026-11-03 08:45Z', 'walkin')$$,
  'the same time with another staff member is allowed'
);

select lives_ok(
  $$insert into public.appointments (business_id, staff_id, starts_at, ends_at, source, status, cancelled_by)
    values ('c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
            '2026-11-03 08:10Z', '2026-11-03 08:40Z', 'online', 'cancelled', 'client')$$,
  'cancelled appointments do not block the slot'
);

select throws_ok(
  $$insert into public.appointments (business_id, staff_id, starts_at, ends_at, source)
    values ('c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
            '2026-11-08 09:00Z', '2026-11-08 09:00Z', 'online')$$,
  '23514',
  null,
  'a zero-length appointment is rejected (it would slip past the overlap check)'
);

-- ---------------------------------------------------------------------------------------------
-- Events on insert and status change
-- ---------------------------------------------------------------------------------------------
select results_eq(
  $$select event, to_status, actor_type from public.appointment_events
    where appointment_id = 'c4000000-0000-4000-8000-000000000001'$$,
  $$values ('created'::text, 'booked'::text, 'system'::text)$$,
  'creating an appointment writes a created event'
);

update public.appointments set status = 'completed', charged_cents = 1300
where id = 'c4000000-0000-4000-8000-000000000001';

select results_eq(
  $$select from_status, to_status from public.appointment_events
    where appointment_id = 'c4000000-0000-4000-8000-000000000001' and event = 'status_changed'$$,
  $$values ('booked'::text, 'completed'::text)$$,
  'a status change writes from/to'
);

select throws_ok(
  $$update public.appointments set status = 'booked', charged_cents = null
    where id = 'c4000000-0000-4000-8000-000000000001'$$,
  '23514',
  null,
  'a finished appointment never goes back to booked'
);

select throws_ok(
  $$insert into public.appointments (business_id, staff_id, starts_at, ends_at, source, status)
    values ('c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002',
            '2026-11-05 08:00Z', '2026-11-05 08:30Z', 'online', 'cancelled')$$,
  '23514',
  null,
  'a cancelled appointment must say who cancelled it'
);

select throws_ok(
  $$insert into public.appointments (business_id, staff_id, starts_at, ends_at, source, charged_cents)
    values ('c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002',
            '2026-11-05 09:00Z', '2026-11-05 09:30Z', 'online', 1300)$$,
  '23514',
  null,
  'a charged amount exists only on completed appointments'
);

-- ---------------------------------------------------------------------------------------------
-- Corrections of the outcome (completed / no_show / cancelled)
-- Recent: ended 2 hours ago (inside the default 3-day window). Old: ended 10 days ago.
-- ---------------------------------------------------------------------------------------------
insert into public.appointments (id, business_id, staff_id, starts_at, ends_at, source) values
  ('c4000000-0000-4000-8000-0000000000a1', 'c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
   now() - interval '150 minutes', now() - interval '120 minutes', 'phone'),
  ('c4000000-0000-4000-8000-0000000000a2', 'c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
   now() - interval '10 days 30 minutes', now() - interval '10 days', 'phone');
update public.appointments set status = 'completed'
where id in ('c4000000-0000-4000-8000-0000000000a1', 'c4000000-0000-4000-8000-0000000000a2');

select lives_ok(
  $$update public.appointments set status = 'no_show', charged_cents = null
    where id = 'c4000000-0000-4000-8000-000000000001'$$,
  'the system may correct completed -> no_show at any time'
);

select set_config('request.jwt.claims', '{"sub": "c0000000-0000-4000-8000-0000000000c1"}', true);

select lives_ok(
  $$update public.appointments set status = 'no_show'
    where id = 'c4000000-0000-4000-8000-0000000000a1'$$,
  'staff may mark their own auto-completed appointment as no-show within the window'
);

select lives_ok(
  $$update public.appointments set status = 'cancelled', cancelled_by = 'client', cancel_reason = 'client_request'
    where id = 'c4000000-0000-4000-8000-0000000000a1'$$,
  'staff may record a forgotten cancellation on their own appointment within the window'
);

select throws_ok(
  $$update public.appointments set status = 'no_show'
    where id = 'c4000000-0000-4000-8000-0000000000a2'$$,
  '42501',
  null,
  'staff cannot correct their own appointment after the window'
);

select set_config('request.jwt.claims', '{"sub": "c0000000-0000-4000-8000-0000000000c2"}', true);

select throws_ok(
  $$update public.appointments set status = 'completed', cancelled_by = null, cancel_reason = null
    where id = 'c4000000-0000-4000-8000-0000000000a1'$$,
  '42501',
  null,
  'staff cannot correct a colleague''s appointment'
);

select set_config('request.jwt.claims', '{"sub": "c0000000-0000-4000-8000-00000000000a"}', true);

select lives_ok(
  $$update public.appointments set status = 'no_show'
    where id = 'c4000000-0000-4000-8000-0000000000a2'$$,
  'the owner may correct an old appointment'
);

select set_config('request.jwt.claims', '{"sub": "00000000-0000-4000-8000-00000000dead"}', true);

select throws_ok(
  $$update public.appointments set status = 'completed'
    where id = 'c4000000-0000-4000-8000-0000000000a2'$$,
  '42501',
  null,
  'a signed-in stranger cannot correct anything'
);

select set_config('request.jwt.claims', '', true);

-- A client-facing RPC (actor type 'client', no signed-in user) cannot rewrite an outcome.
select set_config('anaklo.actor_type', 'client', true);

select throws_ok(
  $$update public.appointments set status = 'cancelled', cancelled_by = 'client', cancel_reason = 'client_request'
    where id = 'c4000000-0000-4000-8000-0000000000a2'$$,
  '42501',
  null,
  'a client cannot turn a past no-show into a cancellation'
);

select set_config('anaklo.actor_type', '', true);

select results_eq(
  $$select from_status, to_status, actor_type from public.appointment_events
    where appointment_id = 'c4000000-0000-4000-8000-0000000000a1' and event = 'status_changed'
    order by id$$,
  $$values ('booked'::text, 'completed'::text, 'system'::text),
           ('completed', 'no_show', 'staff'),
           ('no_show', 'cancelled', 'staff')$$,
  'every correction is kept in the history with who made it'
);

-- ---------------------------------------------------------------------------------------------
-- Reschedule, reassign, actor type
-- ---------------------------------------------------------------------------------------------
insert into public.appointments (id, business_id, staff_id, starts_at, ends_at, source)
values ('c4000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001',
        'c2000000-0000-4000-8000-000000000002', '2026-11-06 08:00Z', '2026-11-06 08:30Z', 'online');

select set_config('anaklo.actor_type', 'client', true);
update public.appointments set starts_at = '2026-11-06 10:00Z', ends_at = '2026-11-06 10:30Z'
where id = 'c4000000-0000-4000-8000-000000000002';
select set_config('anaklo.actor_type', '', true);

select results_eq(
  $$select old_starts_at, new_starts_at, actor_type from public.appointment_events
    where appointment_id = 'c4000000-0000-4000-8000-000000000002' and event = 'rescheduled'$$,
  $$values ('2026-11-06 08:00Z'::timestamptz, '2026-11-06 10:00Z'::timestamptz, 'client'::text)$$,
  'a time change writes a rescheduled event with the acting party'
);

update public.appointments set staff_id = 'c2000000-0000-4000-8000-000000000001'
where id = 'c4000000-0000-4000-8000-000000000002';

select results_eq(
  $$select old_staff_id, new_staff_id from public.appointment_events
    where appointment_id = 'c4000000-0000-4000-8000-000000000002' and event = 'reassigned'$$,
  $$values ('c2000000-0000-4000-8000-000000000002'::uuid, 'c2000000-0000-4000-8000-000000000001'::uuid)$$,
  'a staff change writes a reassigned event'
);

select is(
  (select count(*) from public.appointment_events
   where appointment_id = 'c4000000-0000-4000-8000-000000000002'),
  3::bigint,
  'each change writes exactly one event (created, rescheduled, reassigned)'
);

-- ---------------------------------------------------------------------------------------------
-- Imports and idempotency
-- ---------------------------------------------------------------------------------------------
insert into public.appointments (id, business_id, client_id, staff_id, starts_at, ends_at, source, external_ref)
values ('c4000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000001',
        'c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002',
        '2025-06-01 08:00Z', '2025-06-01 08:30Z', 'import', 'ext-1');

select results_eq(
  $$select event, actor_type from public.appointment_events
    where appointment_id = 'c4000000-0000-4000-8000-000000000003'$$,
  $$values ('imported'::text, 'import'::text)$$,
  'imported appointments write an imported event'
);

select throws_ok(
  $$insert into public.appointments (business_id, staff_id, starts_at, ends_at, source, external_ref)
    values ('c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002',
            '2025-06-02 08:00Z', '2025-06-02 08:30Z', 'import', 'ext-1')$$,
  '23505',
  null,
  're-importing the same external reference is rejected (idempotent imports)'
);

insert into public.appointments (business_id, staff_id, starts_at, ends_at, source, idempotency_key)
values ('c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002',
        '2026-11-07 08:00Z', '2026-11-07 08:30Z', 'online', 'c5000000-0000-4000-8000-000000000001');

select throws_ok(
  $$insert into public.appointments (business_id, staff_id, starts_at, ends_at, source, idempotency_key)
    values ('c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
            '2026-11-07 09:00Z', '2026-11-07 09:30Z', 'online', 'c5000000-0000-4000-8000-000000000001')$$,
  '23505',
  null,
  'the same idempotency key cannot create a second booking'
);

select throws_ok(
  $$insert into public.appointments (business_id, staff_id, starts_at, ends_at, source)
    values ('c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
            '2026-11-08 09:00Z', '2026-11-08 08:30Z', 'online')$$,
  '23514',
  null,
  'an appointment must end after it starts'
);

select throws_ok(
  $$insert into public.appointments (business_id, staff_id, starts_at, ends_at, source, status, cancelled_by, cancel_reason)
    values ('c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
            '2026-11-09 09:00Z', '2026-11-09 09:30Z', 'online', 'cancelled', 'client', 'Γιώργος was sick')$$,
  '23514',
  null,
  'the cancellation reason is a code, never free text'
);

select * from finish();
rollback;
