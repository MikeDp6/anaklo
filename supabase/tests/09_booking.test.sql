-- Booking (SPEC §7–§8, ADR-0003, phase-1 plan 1.2, D8, D10): book_core in public and staff mode,
-- the staff wrapper, idempotency, recheck under the advisory lock, server-side prices, clients
-- (never merged by phone), verification, declared actors, "any staff" tie-break and move_core.
-- Public-mode calls go straight to private.book_core (its public wrapper arrives in 1.3) with a
-- fixed p_now; staff-mode calls go through public.staff_book_appointment as a signed-in member.
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
-- Fixtures are written by the system. Public-mode book_core declares 'client' itself and the
-- setting outlives the call, so it is reset to 'system' after each successful public booking;
-- staff steps clear it (a declared 'system' would outrank the JWT).
select set_config('anaklo.actor_type', 'system', true);
select plan(89);

-- ---------------------------------------------------------------------------------------------
-- Fixture (as postgres). K 'book-shop' Europe/Athens (15′ grid, 60′ notice, 60 days, booking on);
-- L 'book-other'. All dates are in November 2026, EET (UTC+2); p_now = 2026-11-02 06:00Z.
--   K1 Kostas sort 2 · K2 Lena sort 2 (custom Cut 45′ 15.00) · K3 Petros sort 1 · K4 Gone sort 0, INACTIVE
--   Mon–Sat 09:00–18:00 for everyone.
--   Trim 30′ 10.00 · Cut 30′ + 15′ buffer 13.00 · Colour 60′ 40.00 (staff only)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('90000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-book@test.local', '{}', '{}', now(), now()),
  ('90000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'kostas-book@test.local', '{}', '{}', now(), now()),
  ('90000000-0000-4000-8000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'staff-other@test.local', '{}', '{}', now(), now());

insert into public.businesses (id, slug, name, vertical, timezone, slot_step_min, min_notice_min, max_advance_days,
                               booking_enabled, allow_any_staff) values
  ('91000000-0000-4000-8000-00000000000a', 'book-shop', 'Book Shop', 'barber', 'Europe/Athens', 15, 60, 60, true, true),
  ('91000000-0000-4000-8000-00000000000b', 'book-other', 'Book Other', 'barber', 'Europe/Athens', 15, 60, 60, true, true);

insert into public.staff (id, business_id, display_name, sort, active) values
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-00000000000a', 'Kostas', 2, true),
  ('92000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-00000000000a', 'Lena', 2, true),
  ('92000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-00000000000a', 'Petros', 1, true),
  ('92000000-0000-4000-8000-000000000004', '91000000-0000-4000-8000-00000000000a', 'Gone', 0, false),
  ('92000000-0000-4000-8000-0000000000b1', '91000000-0000-4000-8000-00000000000b', 'Other One', 0, true);

insert into public.business_members (business_id, user_id, role, staff_id) values
  ('91000000-0000-4000-8000-00000000000a', '90000000-0000-4000-8000-00000000000a', 'owner', null),
  ('91000000-0000-4000-8000-00000000000a', '90000000-0000-4000-8000-0000000000a1', 'staff', '92000000-0000-4000-8000-000000000001'),
  ('91000000-0000-4000-8000-00000000000b', '90000000-0000-4000-8000-0000000000b1', 'staff', '92000000-0000-4000-8000-0000000000b1');

insert into public.services (id, business_id, name, duration_min, buffer_after_min, price_cents, online_bookable) values
  ('94000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-00000000000a', 'Trim', 30, 0, 1000, true),
  ('94000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-00000000000a', 'Cut', 30, 15, 1300, true),
  ('94000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-00000000000a', 'Colour', 60, 0, 4000, false),
  ('94000000-0000-4000-8000-0000000000b1', '91000000-0000-4000-8000-00000000000b', 'Other cut', 30, 0, 1200, true);

insert into public.staff_services (business_id, staff_id, service_id, custom_duration_min, custom_price_cents) values
  ('91000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', null, null),
  ('91000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000002', null, null),
  ('91000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000003', null, null),
  ('91000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-000000000002', '94000000-0000-4000-8000-000000000001', null, null),
  ('91000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-000000000002', '94000000-0000-4000-8000-000000000002', 45, 1500),
  ('91000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-000000000003', '94000000-0000-4000-8000-000000000001', null, null),
  ('91000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-000000000004', '94000000-0000-4000-8000-000000000001', null, null),
  ('91000000-0000-4000-8000-00000000000b', '92000000-0000-4000-8000-0000000000b1', '94000000-0000-4000-8000-0000000000b1', null, null);

insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
select s.business_id, s.id, d, '09:00', '18:00'
from public.staff s cross join generate_series(1, 6) d
where s.business_id in ('91000000-0000-4000-8000-00000000000a', '91000000-0000-4000-8000-00000000000b');

insert into public.clients (id, business_id, full_name, phone_e164, source, erased_at) values
  ('93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-00000000000a', 'Eleni', '+306900000101', 'staff', null),
  ('93000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-00000000000a', '', null, 'staff', now()),
  ('93000000-0000-4000-8000-000000000004', '91000000-0000-4000-8000-00000000000a', 'Giorgos', '+306900000555', 'staff', null),
  ('93000000-0000-4000-8000-0000000000b1', '91000000-0000-4000-8000-00000000000b', 'Other', '+306900000909', 'staff', null);
-- The merged duplicate keeps a phone of its own, so the public AN007 test below can only come
-- from the merged filter (a missing or different phone would refuse it anyway).
insert into public.clients (id, business_id, full_name, phone_e164, source, merged_into_id) values
  ('93000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-00000000000a', 'Eleni again', '+306900000103', 'staff', '93000000-0000-4000-8000-000000000001');

-- Existing appointments (system):
--   F1 Petros Wed 11-04 16:00–16:30 local: 30 booked minutes on the tie-break day
--   F2 Kostas 2026-11-04 22:30Z = Thu 11-05 00:30 local: same UTC date, NOT the same local day
--   M1 Kostas Mon 11-09 10:00 Cut (+15′ buffer), to be moved · M2 Lena Tue 11-10 12:00 · M3 cancelled
insert into public.appointments (id, business_id, client_id, staff_id, starts_at, ends_at, buffer_after_min, total_cents,
                                 status, source, cancelled_by, cancel_reason) values
  ('95000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-00000000000a', null, '92000000-0000-4000-8000-000000000003',
   '2026-11-04 14:00Z', '2026-11-04 14:30Z', 0, 1000, 'booked', 'phone', null, null),
  ('95000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-00000000000a', null, '92000000-0000-4000-8000-000000000001',
   '2026-11-04 22:30Z', '2026-11-04 23:00Z', 0, 1000, 'booked', 'phone', null, null),
  ('95000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-00000000000a', '93000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001',
   '2026-11-09 08:00Z', '2026-11-09 08:30Z', 15, 1300, 'booked', 'phone', null, null),
  ('95000000-0000-4000-8000-000000000004', '91000000-0000-4000-8000-00000000000a', null, '92000000-0000-4000-8000-000000000002',
   '2026-11-10 10:00Z', '2026-11-10 10:30Z', 0, 1000, 'booked', 'phone', null, null),
  ('95000000-0000-4000-8000-000000000005', '91000000-0000-4000-8000-00000000000a', null, '92000000-0000-4000-8000-000000000001',
   '2026-11-12 08:00Z', '2026-11-12 08:30Z', 0, 1000, 'cancelled', 'phone', 'business', 'staff_unavailable');

insert into public.appointment_services (business_id, appointment_id, position, service_id, price_cents, duration_min) values
  ('91000000-0000-4000-8000-00000000000a', '95000000-0000-4000-8000-000000000001', 0, '94000000-0000-4000-8000-000000000001', 1000, 30),
  ('91000000-0000-4000-8000-00000000000a', '95000000-0000-4000-8000-000000000002', 0, '94000000-0000-4000-8000-000000000001', 1000, 30),
  ('91000000-0000-4000-8000-00000000000a', '95000000-0000-4000-8000-000000000003', 0, '94000000-0000-4000-8000-000000000002', 1300, 30),
  ('91000000-0000-4000-8000-00000000000a', '95000000-0000-4000-8000-000000000004', 0, '94000000-0000-4000-8000-000000000001', 1000, 30),
  ('91000000-0000-4000-8000-00000000000a', '95000000-0000-4000-8000-000000000005', 0, '94000000-0000-4000-8000-000000000001', 1000, 30);

-- ---------------------------------------------------------------------------------------------
-- Helpers (pg_temp). Results of successful calls are kept in transaction-local settings 't.<name>'.
-- ---------------------------------------------------------------------------------------------

-- An online booking through book_core (public mode, p_now fixed).
create function pg_temp.book_public(
  a_services uuid[], a_staff uuid, a_starts timestamptz, a_client uuid, a_new_client jsonb,
  a_verified_via text, a_verified_phone text, a_key uuid,
  a_business uuid default '91000000-0000-4000-8000-00000000000a'
)
returns jsonb
language plpgsql
as $fn$
begin
  return private.book_core(
    p_business_id => a_business, p_mode => 'public', p_service_ids => a_services, p_staff_id => a_staff,
    p_starts_at => a_starts, p_client_id => a_client, p_new_client => a_new_client, p_source => 'online',
    p_verified_via => a_verified_via, p_verified_phone => a_verified_phone, p_idempotency_key => a_key,
    p_allow_outside_hours => false, p_allow_buffer_overlap => false, p_created_by => null,
    p_now => '2026-11-02 06:00Z');
end;
$fn$;

-- A staff-mode booking straight through book_core (for arguments the staff wrapper does not take).
create function pg_temp.book_staff_core(
  a_services uuid[], a_staff uuid, a_starts timestamptz, a_client uuid, a_source text,
  a_verified_via text, a_outside boolean, a_created_by uuid
)
returns jsonb
language plpgsql
as $fn$
begin
  return private.book_core(
    p_business_id => '91000000-0000-4000-8000-00000000000a', p_mode => 'staff', p_service_ids => a_services,
    p_staff_id => a_staff, p_starts_at => a_starts, p_client_id => a_client, p_new_client => null,
    p_source => a_source, p_verified_via => a_verified_via, p_verified_phone => null, p_idempotency_key => null,
    p_allow_outside_hours => a_outside, p_allow_buffer_overlap => false, p_created_by => a_created_by,
    p_now => '2026-11-02 06:00Z');
end;
$fn$;

create function pg_temp.move(a_appointment uuid, a_starts timestamptz, a_staff uuid, a_mode text default 'staff')
returns jsonb
language plpgsql
as $fn$
begin
  return private.move_core(
    p_business_id => '91000000-0000-4000-8000-00000000000a', p_appointment_id => a_appointment,
    p_new_starts_at => a_starts, p_new_staff_id => a_staff, p_mode => a_mode,
    p_allow_outside_hours => false, p_allow_buffer_overlap => false, p_now => '2026-11-02 06:00Z');
end;
$fn$;

-- 'ok', or '<sqlstate> <message>' of the error the statement raised.
create function pg_temp.outcome(a_sql text)
returns text
language plpgsql
as $fn$
begin
  execute a_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$fn$;
grant execute on function pg_temp.outcome(text) to authenticated;

create function pg_temp.r(a_name text)
returns jsonb
language sql
as $fn$
  select nullif(current_setting('t.' || a_name, true), '')::jsonb;
$fn$;

-- Whether this transaction holds book_core's advisory lock for (business, LOCAL date).
create function pg_temp.day_locked(a_business uuid, a_day date)
returns boolean
language sql
as $fn$
  select exists (
    select 1 from pg_catalog.pg_locks l
    where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.objsubid = 1
      and l.classid::text = ((hashtextextended(a_business::text || ':' || a_day::text, 0) >> 32) & 4294967295)::text
      and l.objid::text = (hashtextextended(a_business::text || ':' || a_day::text, 0) & 4294967295)::text
  );
$fn$;

-- ---------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------
select has_function('private', 'plan_messages_impl', array['uuid', 'text'],
  'the message planner exists with its stable signature (p_appointment_id, p_change)');

select function_returns('private', 'plan_messages_impl', array['uuid', 'text'], 'void',
  'the message planner returns void');

select is(
  (select array_agg(x order by x)
   from (select n.nspname || '.' || p.proname || '(' || a.name || ')' as x
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral unnest(p.proargnames) as a (name)
         where (n.nspname, p.proname) in (('private', 'book_core'), ('private', 'move_core'),
                                          ('public', 'staff_book_appointment'), ('private', 'staff_book_appointment_impl'))
           and a.name ~ '(price|cents|total|duration|ends)') as q),
  null::text[],
  'no booking entry point accepts a price, duration or end time from the caller (the server computes them)'
);

-- ---------------------------------------------------------------------------------------------
-- Online booking (public mode): new client, OTP, idempotency key
-- ---------------------------------------------------------------------------------------------
select lives_ok(
  $$select set_config('t.p1', coalesce(pg_temp.book_public(
      array['94000000-0000-4000-8000-000000000002']::uuid[], '92000000-0000-4000-8000-000000000001', '2026-11-03 08:00Z',
      null, '{"full_name": "Nefeli", "phone_e164": "+306900000201", "locale": "el"}', 'otp', '+306900000201',
      'a9000000-0000-4000-8000-000000000001')::text, 'null'), true)$$,
  'public: an online booking with a new client succeeds'
);
select set_config('anaklo.actor_type', 'system', true);

select is(
  (select concat_ws(' | ', r ->> 'staff_id',
                    to_char((r ->> 'starts_at')::timestamptz at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
                    to_char((r ->> 'ends_at')::timestamptz at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
                    r ->> 'total_cents', r ->> 'replayed',
                    coalesce(nullif(r -> 'warnings', 'null'::jsonb), '[]'::jsonb)::text)
   from pg_temp.r('p1') as r),
  '92000000-0000-4000-8000-000000000001 | 2026-11-03 08:00 | 2026-11-03 08:30 | 1300 | false | []',
  'public: the answer carries staff, start, end, the server price, replayed = false and no warnings'
);

select is(
  (select concat_ws(' | ', a.source, a.verified_via, a.status, a.buffer_after_min::text, a.total_cents::text,
                    (a.created_by is null)::text, ((to_jsonb(a) ->> 'request_hash') ~ '^[0-9a-f]{64}$')::text,
                    (a.idempotency_key = 'a9000000-0000-4000-8000-000000000001')::text)
   from public.appointments a where a.id = (pg_temp.r('p1') ->> 'appointment_id')::uuid),
  'online | otp | booked | 15 | 1300 | true | true | true',
  'public: source online, verified_via otp, buffer and total from the service, a sha256 request fingerprint, no creator'
);

select is(
  (select string_agg(sv.name || ':' || l.duration_min || ':' || l.price_cents, ',' order by l.position)
   from public.appointment_services l join public.services sv on sv.id = l.service_id
   where l.appointment_id = (pg_temp.r('p1') ->> 'appointment_id')::uuid),
  'Cut:30:1300',
  'public: the service line copies duration and price at booking time'
);

select is(
  (select concat_ws(' | ', c.full_name, c.phone_e164, c.source)
   from public.clients c join public.appointments a on a.client_id = c.id and a.business_id = c.business_id
   where a.id = (pg_temp.r('p1') ->> 'appointment_id')::uuid),
  'Nefeli | +306900000201 | online',
  'public: the new client is created with source online'
);

select is(
  (select string_agg(e.event || ':' || e.actor_type, ',' order by e.id)
   from public.appointment_events e where e.appointment_id = (pg_temp.r('p1') ->> 'appointment_id')::uuid),
  'created:client',
  'public: one created event, actor client'
);

select ok(
  pg_temp.day_locked('91000000-0000-4000-8000-00000000000a', '2026-11-03'),
  'book_core holds the advisory lock of (business, local date) until the end of the transaction'
);

-- Idempotency
select lives_ok(
  $$select set_config('t.p1r', coalesce(pg_temp.book_public(
      array['94000000-0000-4000-8000-000000000002']::uuid[], '92000000-0000-4000-8000-000000000001', '2026-11-03 08:00Z',
      null, '{"full_name": "Nefeli", "phone_e164": "+306900000201", "locale": "el"}', 'otp', '+306900000201',
      'a9000000-0000-4000-8000-000000000001')::text, 'null'), true)$$,
  'idempotency: repeating the same request with the same key succeeds'
);
select set_config('anaklo.actor_type', 'system', true);

select is(
  concat_ws(' | ', ((pg_temp.r('p1r') ->> 'appointment_id') = (pg_temp.r('p1') ->> 'appointment_id'))::text,
            pg_temp.r('p1r') ->> 'replayed'),
  'true | true',
  'idempotency: the same appointment comes back with replayed = true'
);

select is(
  array[
    (select count(*) from public.appointments
     where business_id = '91000000-0000-4000-8000-00000000000a' and idempotency_key = 'a9000000-0000-4000-8000-000000000001'),
    (select count(*) from public.appointment_events e
     where e.appointment_id = (pg_temp.r('p1') ->> 'appointment_id')::uuid),
    (select count(*) from public.clients
     where business_id = '91000000-0000-4000-8000-00000000000a' and phone_e164 = '+306900000201')
  ],
  array[1, 1, 1]::bigint[],
  'idempotency: one appointment, one event and no second client'
);

select throws_ok(
  $$select pg_temp.book_public(
      array['94000000-0000-4000-8000-000000000002']::uuid[], '92000000-0000-4000-8000-000000000001', '2026-11-03 08:30Z',
      null, '{"full_name": "Nefeli", "phone_e164": "+306900000201", "locale": "el"}', 'otp', '+306900000201',
      'a9000000-0000-4000-8000-000000000001')$$,
  'P0001', 'AN004',
  'idempotency: the same key with a different payload is refused (AN004)'
);

-- ---------------------------------------------------------------------------------------------
-- Clients and prices (public)
-- ---------------------------------------------------------------------------------------------
select lives_ok(
  $$select set_config('t.eleni', coalesce(pg_temp.book_public(
      array['94000000-0000-4000-8000-000000000002']::uuid[], '92000000-0000-4000-8000-000000000001', '2026-11-03 12:00Z',
      '93000000-0000-4000-8000-000000000001', null, 'trusted_device', '+306900000101', null)::text, 'null'), true)$$,
  'public: an existing client whose phone was verified books from a trusted device'
);
select set_config('anaklo.actor_type', 'system', true);

select is(
  (select concat_ws(' | ', (a.client_id = '93000000-0000-4000-8000-000000000001')::text, a.verified_via,
                    (select count(*) from public.clients c
                     where c.business_id = a.business_id and c.phone_e164 = '+306900000101')::text)
   from public.appointments a where a.id = (pg_temp.r('eleni') ->> 'appointment_id')::uuid),
  'true | trusted_device | 1',
  'public: the existing client is used as is (verified_via trusted_device, no new client)'
);

select lives_ok(
  $$select set_config('t.junior', coalesce(pg_temp.book_public(
      array['94000000-0000-4000-8000-000000000002']::uuid[], '92000000-0000-4000-8000-000000000002', '2026-11-03 14:00Z',
      null, '{"full_name": "Eleni junior", "phone_e164": "+306900000101"}', 'otp', '+306900000101', null)::text, 'null'), true)$$,
  'public: a new person on a phone that already belongs to a client books'
);
select set_config('anaklo.actor_type', 'system', true);

select is(
  (select concat_ws(' | ', (a.client_id <> '93000000-0000-4000-8000-000000000001')::text, c.full_name, c.source,
                    (select count(*) from public.clients x
                     where x.business_id = a.business_id and x.phone_e164 = '+306900000101')::text)
   from public.appointments a join public.clients c on c.id = a.client_id
   where a.id = (pg_temp.r('junior') ->> 'appointment_id')::uuid),
  'true | Eleni junior | online | 2',
  'public: never merged by phone: a second client with the same phone is created'
);

select is(
  (select concat_ws(' | ', a.total_cents::text, to_char(a.ends_at at time zone 'UTC', 'HH24:MI'), a.buffer_after_min::text,
                    (select string_agg(sv.name || ':' || l.duration_min || ':' || l.price_cents, ',' order by l.position)
                     from public.appointment_services l join public.services sv on sv.id = l.service_id
                     where l.appointment_id = a.id))
   from public.appointments a where a.id = (pg_temp.r('junior') ->> 'appointment_id')::uuid),
  '1500 | 14:45 | 15 | Cut:45:1500',
  'public: price and duration come from the chosen staff member''s terms (custom 45′ / 15.00)'
);

select throws_ok(
  $$select pg_temp.book_public(array['94000000-0000-4000-8000-000000000002']::uuid[], '92000000-0000-4000-8000-000000000001',
      '2026-11-03 13:00Z', '93000000-0000-4000-8000-000000000001', null, 'otp', '+306900000999', null)$$,
  'P0001', 'AN007',
  'public: an existing client whose phone is not the verified one is refused (AN007)'
);

select throws_ok(
  $$select pg_temp.book_public(array['94000000-0000-4000-8000-000000000002']::uuid[], '92000000-0000-4000-8000-000000000001',
      '2026-11-03 13:00Z', '93000000-0000-4000-8000-0000000000b1', null, 'otp', '+306900000909', null)$$,
  'P0001', 'AN007',
  'public: a client of another business is refused (AN007)'
);

select throws_ok(
  $$select pg_temp.book_public(array['94000000-0000-4000-8000-000000000002']::uuid[], '92000000-0000-4000-8000-000000000001',
      '2026-11-03 13:00Z', '93000000-0000-4000-8000-000000000002', null, 'otp', '+306900000101', null)$$,
  'P0001', 'AN007',
  'public: an erased client is refused (AN007)'
);

select throws_ok(
  $$select pg_temp.book_public(array['94000000-0000-4000-8000-000000000002']::uuid[], '92000000-0000-4000-8000-000000000001',
      '2026-11-03 13:00Z', '93000000-0000-4000-8000-000000000003', null, 'otp', '+306900000103', null)$$,
  'P0001', 'AN007',
  'public: a merged client is refused (AN007), even with its own phone verified'
);

-- ---------------------------------------------------------------------------------------------
-- Validation: services, staff, business
-- ---------------------------------------------------------------------------------------------
select throws_ok(
  $$select pg_temp.book_public('{}'::uuid[], '92000000-0000-4000-8000-000000000001',
      '2026-11-03 13:00Z', '93000000-0000-4000-8000-000000000001', null, 'otp', '+306900000101', null)$$,
  'P0001', 'AN003',
  'services: an empty list is refused (AN003)'
);

select throws_ok(
  $$select pg_temp.book_public(array['94000000-0000-4000-8000-000000000003']::uuid[], '92000000-0000-4000-8000-000000000001',
      '2026-11-03 13:00Z', '93000000-0000-4000-8000-000000000001', null, 'otp', '+306900000101', null)$$,
  'P0001', 'AN003',
  'services: a staff-only service cannot be booked online (AN003)'
);

select throws_ok(
  $$select pg_temp.book_public(array['94000000-0000-4000-8000-0000000000b1']::uuid[], '92000000-0000-4000-8000-000000000001',
      '2026-11-03 13:00Z', '93000000-0000-4000-8000-000000000001', null, 'otp', '+306900000101', null)$$,
  'P0001', 'AN003',
  'services: a service of another business is refused (AN003)'
);

select throws_ok(
  $$select pg_temp.book_public(array['94000000-0000-4000-8000-000000000002']::uuid[], '92000000-0000-4000-8000-000000000003',
      '2026-11-03 13:00Z', '93000000-0000-4000-8000-000000000001', null, 'otp', '+306900000101', null)$$,
  'P0001', 'AN003',
  'services: a service the staff member does not offer is refused (AN003)'
);

select throws_ok(
  $$select pg_temp.book_public(array['94000000-0000-4000-8000-000000000001']::uuid[], '92000000-0000-4000-8000-000000000004',
      '2026-11-03 13:00Z', '93000000-0000-4000-8000-000000000001', null, 'otp', '+306900000101', null)$$,
  'P0001', 'AN008',
  'staff: an inactive staff member is refused (AN008)'
);

select matches(
  pg_temp.outcome($$select pg_temp.book_public(array['94000000-0000-4000-8000-000000000001']::uuid[],
      '92000000-0000-4000-8000-0000000000b1', '2026-11-03 13:00Z', '93000000-0000-4000-8000-000000000001', null,
      'otp', '+306900000101', null)$$),
  '^P0001 AN00[38]$',
  'staff: a staff member of another business is refused (AN008, or AN003 when the services are checked first)'
);
select set_config('anaklo.actor_type', 'system', true);

update public.businesses set allow_any_staff = false where id = '91000000-0000-4000-8000-00000000000a';

select throws_ok(
  $$select pg_temp.book_public(array['94000000-0000-4000-8000-000000000001']::uuid[], null,
      '2026-11-03 13:00Z', '93000000-0000-4000-8000-000000000001', null, 'otp', '+306900000101', null)$$,
  'P0001', 'AN008',
  'staff: "any staff" online is refused when allow_any_staff = false (AN008)'
);

update public.businesses set allow_any_staff = true, booking_enabled = false where id = '91000000-0000-4000-8000-00000000000a';

select throws_ok(
  $$select pg_temp.book_public(array['94000000-0000-4000-8000-000000000001']::uuid[], '92000000-0000-4000-8000-000000000001',
      '2026-11-03 13:00Z', '93000000-0000-4000-8000-000000000001', null, 'otp', '+306900000101', null)$$,
  'P0001', 'AN009',
  'business: no online booking while booking_enabled = false (AN009)'
);

update public.businesses set booking_enabled = true where id = '91000000-0000-4000-8000-00000000000a';

select throws_ok(
  $$select pg_temp.book_public(array['94000000-0000-4000-8000-000000000001']::uuid[], '92000000-0000-4000-8000-000000000001',
      '2026-11-03 13:00Z', '93000000-0000-4000-8000-000000000001', null, 'otp', '+306900000101', null,
      a_business => '91000000-0000-4000-8000-0000000000ff')$$,
  'P0001', 'AN009',
  'business: an unknown business is refused (AN009)'
);

-- ---------------------------------------------------------------------------------------------
-- Recheck: taken time, buffers (D8). Nefeli holds Kostas 11-03 08:00–08:30Z + 15′ buffer.
-- ---------------------------------------------------------------------------------------------
select throws_ok(
  $$select pg_temp.book_public(array['94000000-0000-4000-8000-000000000002']::uuid[], '92000000-0000-4000-8000-000000000001',
      '2026-11-03 08:00Z', '93000000-0000-4000-8000-000000000001', null, 'otp', '+306900000101', null)$$,
  'P0001', 'AN001',
  'recheck: a taken time is refused (AN001)'
);

select throws_ok(
  $$select pg_temp.book_public(array['94000000-0000-4000-8000-000000000002']::uuid[], '92000000-0000-4000-8000-000000000001',
      '2026-11-03 08:30Z', '93000000-0000-4000-8000-000000000001', null, 'otp', '+306900000101', null)$$,
  'P0001', 'AN001',
  'recheck: online booking never lands in another appointment''s buffer (AN001)'
);

select matches(
  pg_temp.outcome($$select pg_temp.book_public(array['94000000-0000-4000-8000-000000000002']::uuid[],
      '92000000-0000-4000-8000-000000000001', '2026-11-05 18:00Z', '93000000-0000-4000-8000-000000000001', null,
      'otp', '+306900000101', null)$$),
  '^P0001 AN00[15]$',
  'recheck: online booking is never outside working hours'
);
select set_config('anaklo.actor_type', 'system', true);

-- ---------------------------------------------------------------------------------------------
-- Staff mode through the wrapper, as Kostas (staff of K). No declared actor → 'staff'.
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', '', true);
set local role authenticated;
set local request.jwt.claims to '{"sub": "90000000-0000-4000-8000-0000000000a1", "role": "authenticated", "aal": "aal1"}';

select throws_ok(
  $$select public.staff_book_appointment(
      p_business_id => '91000000-0000-4000-8000-00000000000a', p_service_ids => array['94000000-0000-4000-8000-000000000002']::uuid[],
      p_staff_id => '92000000-0000-4000-8000-000000000001', p_starts_at => '2026-11-03 08:30Z',
      p_client_id => '93000000-0000-4000-8000-000000000001')$$,
  'P0001', 'AN006',
  'staff: overlapping only another appointment''s buffer needs the flag (AN006)'
);

select throws_ok(
  $$select public.staff_book_appointment(
      p_business_id => '91000000-0000-4000-8000-00000000000a', p_service_ids => array['94000000-0000-4000-8000-000000000002']::uuid[],
      p_staff_id => '92000000-0000-4000-8000-000000000001', p_starts_at => '2026-11-03 08:15Z',
      p_client_id => '93000000-0000-4000-8000-000000000001',
      p_allow_outside_hours => true, p_allow_buffer_overlap => true)$$,
  'P0001', 'AN001',
  'staff: overlapping another appointment''s service time is never allowed, whatever the flags (AN001)'
);

select lives_ok(
  $$select set_config('t.squeeze', coalesce(public.staff_book_appointment(
      p_business_id => '91000000-0000-4000-8000-00000000000a', p_service_ids => array['94000000-0000-4000-8000-000000000002']::uuid[],
      p_staff_id => '92000000-0000-4000-8000-000000000001', p_starts_at => '2026-11-03 08:30Z',
      p_client_id => '93000000-0000-4000-8000-000000000001', p_allow_buffer_overlap => true)::text, 'null'), true)$$,
  'staff: with the flag an appointment is squeezed into the buffer where online booking failed'
);

select throws_ok(
  $$select public.staff_book_appointment(
      p_business_id => '91000000-0000-4000-8000-00000000000a', p_service_ids => array['94000000-0000-4000-8000-000000000002']::uuid[],
      p_staff_id => '92000000-0000-4000-8000-000000000001', p_starts_at => '2026-11-05 17:00Z',
      p_client_id => '93000000-0000-4000-8000-000000000001')$$,
  'P0001', 'AN005',
  'staff: outside working hours needs the flag (AN005)'
);

select lives_ok(
  $$select set_config('t.outside', coalesce(public.staff_book_appointment(
      p_business_id => '91000000-0000-4000-8000-00000000000a', p_service_ids => array['94000000-0000-4000-8000-000000000002']::uuid[],
      p_staff_id => '92000000-0000-4000-8000-000000000001', p_starts_at => '2026-11-05 17:00Z',
      p_client_id => '93000000-0000-4000-8000-000000000001', p_allow_outside_hours => true)::text, 'null'), true)$$,
  'staff: with the flag an appointment is booked outside working hours'
);

select lives_ok(
  $$select set_config('t.walkin', coalesce(public.staff_book_appointment(
      p_business_id => '91000000-0000-4000-8000-00000000000a', p_service_ids => array['94000000-0000-4000-8000-000000000001']::uuid[],
      p_staff_id => '92000000-0000-4000-8000-000000000001', p_starts_at => '2026-11-06 07:00Z',
      p_source => 'walkin')::text, 'null'), true)$$,
  'staff: a walk-in needs no client'
);

select isnt(
  pg_temp.outcome($$select public.staff_book_appointment(
      p_business_id => '91000000-0000-4000-8000-00000000000a', p_service_ids => array['94000000-0000-4000-8000-000000000001']::uuid[],
      p_staff_id => '92000000-0000-4000-8000-000000000001', p_starts_at => '2026-11-06 15:00Z',
      p_source => 'staff')$$),
  'ok',
  'staff: without a client only a walk-in is accepted'
);

select lives_ok(
  $$select set_config('t.g1', coalesce(public.staff_book_appointment(
      p_business_id => '91000000-0000-4000-8000-00000000000a', p_service_ids => array['94000000-0000-4000-8000-000000000001']::uuid[],
      p_staff_id => '92000000-0000-4000-8000-000000000001', p_starts_at => '2026-11-06 08:00Z',
      p_new_client => '{"full_name": "Giorgos junior", "phone_e164": "+306900000555"}', p_source => 'phone')::text, 'null'), true)$$,
  'staff: a phone booking creates a new client inline'
);

select lives_ok(
  $$select set_config('t.g2', coalesce(public.staff_book_appointment(
      p_business_id => '91000000-0000-4000-8000-00000000000a', p_service_ids => array['94000000-0000-4000-8000-000000000001']::uuid[],
      p_staff_id => '92000000-0000-4000-8000-000000000001', p_starts_at => '2026-11-06 09:00Z',
      p_new_client => '{"full_name": "Giorgos senior", "phone_e164": "+306900000555"}')::text, 'null'), true)$$,
  'staff: another new client with the same phone is created too'
);

select lives_ok(
  $$select set_config('t.colleague', coalesce(public.staff_book_appointment(
      p_business_id => '91000000-0000-4000-8000-00000000000a', p_service_ids => array['94000000-0000-4000-8000-000000000001']::uuid[],
      p_staff_id => '92000000-0000-4000-8000-000000000002', p_starts_at => '2026-11-06 08:00Z',
      p_client_id => '93000000-0000-4000-8000-000000000001', p_source => 'phone')::text, 'null'), true)$$,
  'staff: any member books for a colleague (shared shop phone)'
);

select lives_ok(
  $$select set_config('t.colour', coalesce(public.staff_book_appointment(
      p_business_id => '91000000-0000-4000-8000-00000000000a', p_service_ids => array['94000000-0000-4000-8000-000000000003']::uuid[],
      p_staff_id => '92000000-0000-4000-8000-000000000001', p_starts_at => '2026-11-06 12:00Z',
      p_client_id => '93000000-0000-4000-8000-000000000001')::text, 'null'), true)$$,
  'staff: a staff-only service is bookable in staff mode'
);

select matches(
  pg_temp.outcome($$select public.staff_book_appointment(
      p_business_id => '91000000-0000-4000-8000-00000000000a', p_service_ids => array['94000000-0000-4000-8000-000000000001']::uuid[],
      p_staff_id => '92000000-0000-4000-8000-000000000001', p_starts_at => '2026-11-06 13:30Z',
      p_client_id => '93000000-0000-4000-8000-0000000000b1')$$),
  '^(42501 |P0001 AN007$)',
  'staff: a client of another business is refused'
);

select throws_ok(
  $$select public.staff_book_appointment(
      p_business_id => '91000000-0000-4000-8000-00000000000a', p_service_ids => array['94000000-0000-4000-8000-000000000001']::uuid[],
      p_staff_id => '92000000-0000-4000-8000-000000000001', p_starts_at => '2026-11-06 14:00Z',
      p_client_id => '93000000-0000-4000-8000-000000000002')$$,
  'P0001', 'AN007',
  'staff: an erased client cannot be booked (AN007)'
);

-- No phone check in staff mode: only the merged filter stands between this call and a booking.
select throws_ok(
  $$select public.staff_book_appointment(
      p_business_id => '91000000-0000-4000-8000-00000000000a', p_service_ids => array['94000000-0000-4000-8000-000000000001']::uuid[],
      p_staff_id => '92000000-0000-4000-8000-000000000001', p_starts_at => '2026-11-06 14:30Z',
      p_client_id => '93000000-0000-4000-8000-000000000003')$$,
  'P0001', 'AN007',
  'staff: a merged client cannot be booked (AN007): the surviving client is booked instead'
);

-- Staff of business L tries to book in K.
set local request.jwt.claims to '{"sub": "90000000-0000-4000-8000-0000000000b1", "role": "authenticated", "aal": "aal1"}';

select throws_ok(
  $$select public.staff_book_appointment(
      p_business_id => '91000000-0000-4000-8000-00000000000a', p_service_ids => array['94000000-0000-4000-8000-000000000001']::uuid[],
      p_staff_id => '92000000-0000-4000-8000-000000000001', p_starts_at => '2026-11-06 14:30Z',
      p_client_id => '93000000-0000-4000-8000-000000000001')$$,
  '42501', null,
  'tenant: staff of another business cannot book here (42501)'
);

set local role postgres;
select set_config('request.jwt.claims', '', true);
select set_config('anaklo.actor_type', 'system', true);

select ok(
  (pg_temp.r('squeeze') -> 'warnings') ? 'buffer_overlap',
  'staff: the squeezed booking carries the buffer_overlap warning'
);

select ok(
  (pg_temp.r('outside') -> 'warnings') ? 'outside_hours',
  'staff: the out-of-hours booking carries the outside_hours warning'
);

select is(
  (select concat_ws(' | ', coalesce(a.client_id::text, 'no client'), a.source, coalesce(a.verified_via, 'null'),
                    (a.created_by = '90000000-0000-4000-8000-0000000000a1')::text,
                    (select string_agg(e.event || ':' || e.actor_type || ':'
                                       || coalesce((e.actor_id = '90000000-0000-4000-8000-0000000000a1')::text, 'null'), ',')
                     from public.appointment_events e where e.appointment_id = a.id))
   from public.appointments a where a.id = (pg_temp.r('walkin') ->> 'appointment_id')::uuid),
  'no client | walkin | null | true | created:staff:true',
  'staff: walk-in without client, no verification, created_by and event actor are the signed-in member'
);

select is(
  (select string_agg(c.full_name || ':' || c.source, ',' order by c.full_name collate "C")
   from public.clients c
   where c.business_id = '91000000-0000-4000-8000-00000000000a' and c.phone_e164 = '+306900000555'),
  'Giorgos:staff,Giorgos junior:staff,Giorgos senior:staff',
  'staff: never merged by phone: three clients share one phone'
);

select is(
  (select count(distinct a.client_id) from public.appointments a
   where a.id in ((pg_temp.r('g1') ->> 'appointment_id')::uuid, (pg_temp.r('g2') ->> 'appointment_id')::uuid)
     and a.client_id <> '93000000-0000-4000-8000-000000000004'),
  2::bigint,
  'staff: each inline new client gets its own appointment, none lands on the existing Giorgos'
);

select is(
  (select concat_ws(' | ', a.staff_id::text, (a.created_by = '90000000-0000-4000-8000-0000000000a1')::text, a.total_cents::text)
   from public.appointments a where a.id = (pg_temp.r('colleague') ->> 'appointment_id')::uuid),
  '92000000-0000-4000-8000-000000000002 | true | 1000',
  'staff: the colleague''s appointment records who booked it'
);

select is(
  (select a.total_cents from public.appointments a where a.id = (pg_temp.r('colour') ->> 'appointment_id')::uuid),
  4000,
  'staff: the staff-only service is priced by the server'
);

select is(
  (select array_agg(distinct a.source || ':' || coalesce(a.verified_via, 'null')
                    order by a.source || ':' || coalesce(a.verified_via, 'null'))
   from public.appointments a
   where a.business_id = '91000000-0000-4000-8000-00000000000a' and a.created_by = '90000000-0000-4000-8000-0000000000a1'),
  array['phone:null', 'staff:null', 'walkin:null'],
  'verified_via: NULL for staff, phone and walk-in bookings'
);

select is(
  (select array_agg(distinct a.source || ':' || e.actor_type order by a.source || ':' || e.actor_type)
   from public.appointments a
   join public.appointment_events e on e.business_id = a.business_id and e.appointment_id = a.id and e.event = 'created'
   where a.business_id = '91000000-0000-4000-8000-00000000000a'
     and (a.source = 'online' or a.created_by = '90000000-0000-4000-8000-0000000000a1')),
  array['online:client', 'phone:staff', 'staff:staff', 'walkin:staff'],
  'actor: online bookings are written by the client, app bookings by staff'
);

-- ---------------------------------------------------------------------------------------------
-- "Any staff" (public, Wed 11-04): fewest booked minutes of the LOCAL day, then sort, then id.
-- Before: Kostas 0 (his 22:30Z booking is Thursday locally), Lena 0, Petros 30; Gone is inactive
-- (sort 0, would win every tie).
-- ---------------------------------------------------------------------------------------------
select lives_ok(
  $$select set_config('t.b1', coalesce(pg_temp.book_public(array['94000000-0000-4000-8000-000000000001']::uuid[], null,
      '2026-11-04 07:00Z', '93000000-0000-4000-8000-000000000001', null, 'otp', '+306900000101', null)::text, 'null'), true)$$,
  'any staff: first booking'
);

select lives_ok(
  $$select set_config('t.b2', coalesce(pg_temp.book_public(array['94000000-0000-4000-8000-000000000001']::uuid[], null,
      '2026-11-04 08:00Z', '93000000-0000-4000-8000-000000000001', null, 'otp', '+306900000101', null)::text, 'null'), true)$$,
  'any staff: second booking'
);

select lives_ok(
  $$select set_config('t.b3', coalesce(pg_temp.book_public(array['94000000-0000-4000-8000-000000000001']::uuid[], null,
      '2026-11-04 09:00Z', '93000000-0000-4000-8000-000000000001', null, 'otp', '+306900000101', null)::text, 'null'), true)$$,
  'any staff: third booking'
);
select set_config('anaklo.actor_type', 'system', true);

select is(
  array[pg_temp.r('b1') ->> 'staff_id', pg_temp.r('b2') ->> 'staff_id', pg_temp.r('b3') ->> 'staff_id'],
  array['92000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000003'],
  'any staff: Kostas (0′, same sort as Lena, lower id), then Lena (0′), then Petros (all 30′, lowest sort)'
);

select is(
  (select coalesce(to_jsonb(a) ->> 'request_hash', 'none')
   from public.appointments a where a.id = (pg_temp.r('b1') ->> 'appointment_id')::uuid),
  'none',
  'idempotency: no request fingerprint without an idempotency key'
);

-- ---------------------------------------------------------------------------------------------
-- book_core in staff mode as the owner: local-date lock, verification columns
-- ---------------------------------------------------------------------------------------------
select set_config('anaklo.actor_type', '', true);
select set_config('request.jwt.claims', '{"sub": "90000000-0000-4000-8000-00000000000a", "role": "authenticated", "aal": "aal1"}', true);

select lives_ok(
  $$select set_config('t.night', coalesce(pg_temp.book_staff_core(array['94000000-0000-4000-8000-000000000001']::uuid[],
      '92000000-0000-4000-8000-000000000001', '2026-11-16 22:30Z', null, 'walkin', null, true,
      '90000000-0000-4000-8000-00000000000a')::text, 'null'), true)$$,
  'staff core: a walk-in at 00:30 local (outside hours, with the flag)'
);

select ok(
  pg_temp.day_locked('91000000-0000-4000-8000-00000000000a', '2026-11-17')
  and not pg_temp.day_locked('91000000-0000-4000-8000-00000000000a', '2026-11-16'),
  'the lock is taken on the LOCAL date (00:30 on 2026-11-17 is still 2026-11-16 in UTC)'
);

select throws_ok(
  $$select pg_temp.book_staff_core(array['94000000-0000-4000-8000-000000000001']::uuid[],
      '92000000-0000-4000-8000-000000000001', '2026-11-07 08:00Z', '93000000-0000-4000-8000-000000000001', 'phone',
      'otp', false, '90000000-0000-4000-8000-00000000000a')$$,
  '23514', null,
  'verified_via: a staff booking that claims a verification fails on appointments_online_verified'
);

select throws_ok(
  $$select pg_temp.book_public(array['94000000-0000-4000-8000-000000000001']::uuid[], '92000000-0000-4000-8000-000000000001',
      '2026-11-07 09:00Z', '93000000-0000-4000-8000-000000000001', null, null, '+306900000101', null)$$,
  '23514', null,
  'verified_via: an online booking without a verification fails'
);

-- ---------------------------------------------------------------------------------------------
-- move_core (staff mode, as the owner): M1 Kostas Mon 11-09 08:00Z → Tue 11-10
-- ---------------------------------------------------------------------------------------------
select ok(
  not pg_temp.day_locked('91000000-0000-4000-8000-00000000000a', '2026-11-09')
  and not pg_temp.day_locked('91000000-0000-4000-8000-00000000000a', '2026-11-10'),
  'move: neither date is locked before the move'
);

select lives_ok(
  $$select set_config('t.m1', coalesce(pg_temp.move('95000000-0000-4000-8000-000000000003', '2026-11-10 08:00Z',
      '92000000-0000-4000-8000-000000000001')::text, 'null'), true)$$,
  'move: to another day, same staff member'
);

select ok(
  pg_temp.day_locked('91000000-0000-4000-8000-00000000000a', '2026-11-09')
  and pg_temp.day_locked('91000000-0000-4000-8000-00000000000a', '2026-11-10'),
  'move: both local dates (old and new) are locked'
);

select is(
  (select concat_ws(' | ', a.staff_id::text, to_char(a.starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
                    to_char(a.ends_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), a.total_cents::text, a.status)
   from public.appointments a where a.id = '95000000-0000-4000-8000-000000000003'),
  '92000000-0000-4000-8000-000000000001 | 2026-11-10 08:00 | 2026-11-10 08:30 | 1300 | booked',
  'move: updated in place, same duration and price with the same staff member'
);

select is(
  (select concat_ws(' | ', to_char(e.old_starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
                    to_char(e.new_starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), e.actor_type)
   from public.appointment_events e
   where e.appointment_id = '95000000-0000-4000-8000-000000000003' and e.event = 'rescheduled'
   order by e.id limit 1),
  '2026-11-09 08:00 | 2026-11-10 08:00 | staff',
  'move: a rescheduled event from the existing trigger, actor staff'
);

select lives_ok(
  $$select pg_temp.move('95000000-0000-4000-8000-000000000003', '2026-11-10 08:15Z', '92000000-0000-4000-8000-000000000001')$$,
  'move: the recheck ignores the appointment itself (15′ later overlaps its own current time)'
);

select lives_ok(
  $$select pg_temp.move('95000000-0000-4000-8000-000000000003', '2026-11-10 08:15Z', '92000000-0000-4000-8000-000000000002')$$,
  'move: to a colleague at the same time'
);

select is(
  (select concat_ws(' | ', a.staff_id::text, to_char(a.starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
                    to_char(a.ends_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), a.total_cents::text,
                    (select sum(l.price_cents) from public.appointment_services l
                     where l.business_id = a.business_id and l.appointment_id = a.id)::text)
   from public.appointments a where a.id = '95000000-0000-4000-8000-000000000003'),
  '92000000-0000-4000-8000-000000000002 | 2026-11-10 08:15 | 2026-11-10 09:00 | 1500 | 1500',
  'move: a new staff member brings their own terms (45′ / 15.00), lines included'
);

select is(
  (select concat_ws(' | ', e.old_staff_id::text, e.new_staff_id::text, e.actor_type)
   from public.appointment_events e
   where e.appointment_id = '95000000-0000-4000-8000-000000000003' and e.event = 'reassigned'),
  '92000000-0000-4000-8000-000000000001 | 92000000-0000-4000-8000-000000000002 | staff',
  'move: a reassigned event from the existing trigger'
);

select throws_ok(
  $$select pg_temp.move('95000000-0000-4000-8000-000000000003', '2026-11-10 10:00Z', '92000000-0000-4000-8000-000000000002')$$,
  'P0001', 'AN001',
  'move: onto another appointment''s time is refused (AN001)'
);

select throws_ok(
  $$select pg_temp.move('95000000-0000-4000-8000-000000000005', '2026-11-12 09:00Z', '92000000-0000-4000-8000-000000000001')$$,
  '23514', null,
  'move: only booked/confirmed appointments move'
);

select set_config('request.jwt.claims', '', true);
select set_config('anaklo.actor_type', 'system', true);

-- ---------------------------------------------------------------------------------------------
-- move_core in public mode (the client's reschedule link, 1.3). A move keeps the duration,
-- buffer and price copied at booking time (SPEC §7), so the public recheck must test THAT block:
-- a catalogue change after the booking may neither let a client move into a buffer or past
-- closing time (D8, SPEC §8.8) nor refuse a move that fits.
--   Beard 60′ + 15′ 20.00 (Kostas only), booked online Wed 11-18 08:00Z; X Kostas 11-18
--   12:00–12:30Z; then the shop shortens Beard to 30′ + 0′.
-- ---------------------------------------------------------------------------------------------
insert into public.services (id, business_id, name, duration_min, buffer_after_min, price_cents, online_bookable) values
  ('94000000-0000-4000-8000-000000000004', '91000000-0000-4000-8000-00000000000a', 'Beard', 60, 15, 2000, true);
insert into public.staff_services (business_id, staff_id, service_id) values
  ('91000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000004');
insert into public.appointments (id, business_id, client_id, staff_id, starts_at, ends_at, buffer_after_min, total_cents,
                                 status, source) values
  ('95000000-0000-4000-8000-000000000006', '91000000-0000-4000-8000-00000000000a', null, '92000000-0000-4000-8000-000000000001',
   '2026-11-18 12:00Z', '2026-11-18 12:30Z', 0, 1000, 'booked', 'phone'),
  ('95000000-0000-4000-8000-000000000007', '91000000-0000-4000-8000-00000000000a', null, '92000000-0000-4000-8000-000000000001',
   '2026-11-19 10:00Z', '2026-11-19 10:30Z', 0, 1000, 'booked', 'phone');

select lives_ok(
  $$select set_config('t.beard', coalesce(pg_temp.book_public(
      array['94000000-0000-4000-8000-000000000004']::uuid[], '92000000-0000-4000-8000-000000000001', '2026-11-18 08:00Z',
      '93000000-0000-4000-8000-000000000001', null, 'otp', '+306900000101', null)::text, 'null'), true)$$,
  'public move: Beard 60′ + 15′ is booked online'
);
select set_config('anaklo.actor_type', 'system', true);

update public.services set duration_min = 30, buffer_after_min = 0 where id = '94000000-0000-4000-8000-000000000004';

select throws_ok(
  $$select pg_temp.move((pg_temp.r('beard') ->> 'appointment_id')::uuid, '2026-11-18 11:00Z', null, 'public')$$,
  'P0001', 'AN001',
  'public move: the booked 15′ buffer may not land on the next appointment (today''s 30′ + 0′ would fit)'
);

select throws_ok(
  $$select pg_temp.move((pg_temp.r('beard') ->> 'appointment_id')::uuid, '2026-11-18 15:30Z', null, 'public')$$,
  'P0001', 'AN001',
  'public move: the booked 60′ + 15′ may not run past closing time from 17:30 local (today''s 30′ would fit)'
);

select throws_ok(
  $$select pg_temp.move((pg_temp.r('beard') ->> 'appointment_id')::uuid, '2026-11-18 14:40Z', null, 'public')$$,
  'P0001', 'AN001',
  'public move: only starts on the local grid'
);

select lives_ok(
  $$select pg_temp.move((pg_temp.r('beard') ->> 'appointment_id')::uuid, '2026-11-18 14:45Z', null, 'public')$$,
  'public move: the last start where the booked block still fits (16:45 local + 75′ = closing time)'
);
select set_config('anaklo.actor_type', 'system', true);

select is(
  (select concat_ws(' | ', to_char(a.starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
                    to_char(a.ends_at at time zone 'UTC', 'HH24:MI'), a.buffer_after_min::text, a.total_cents::text,
                    (select string_agg(l.duration_min || ':' || l.price_cents, ',' order by l.position)
                     from public.appointment_services l
                     where l.business_id = a.business_id and l.appointment_id = a.id),
                    (select string_agg(e.event || ':' || e.actor_type, ',' order by e.id)
                     from public.appointment_events e where e.appointment_id = a.id))
   from public.appointments a where a.id = (pg_temp.r('beard') ->> 'appointment_id')::uuid),
  '2026-11-18 14:45 | 15:45 | 15 | 2000 | 60:2000 | created:client,rescheduled:client',
  'public move: the booked duration, buffer and price are kept; rescheduled by the client'
);

-- The reverse: Beard (now 30′ + 0′) booked online Thu 11-19 08:00Z; Y Kostas 11-19 10:00–10:30Z;
-- then the shop lengthens Beard back to 60′ + 15′.
select lives_ok(
  $$select set_config('t.beard2', coalesce(pg_temp.book_public(
      array['94000000-0000-4000-8000-000000000004']::uuid[], '92000000-0000-4000-8000-000000000001', '2026-11-19 08:00Z',
      '93000000-0000-4000-8000-000000000001', null, 'otp', '+306900000101', null)::text, 'null'), true)$$,
  'public move: Beard is booked online while it lasts 30′ + 0′'
);
select set_config('anaklo.actor_type', 'system', true);

update public.services set duration_min = 60, buffer_after_min = 15 where id = '94000000-0000-4000-8000-000000000004';

select lives_ok(
  $$select pg_temp.move((pg_temp.r('beard2') ->> 'appointment_id')::uuid, '2026-11-19 09:30Z', null, 'public')$$,
  'public move: a start where the booked 30′ fits is accepted although today''s 60′ + 15′ would not fit'
);
select set_config('anaklo.actor_type', 'system', true);

select is(
  (select concat_ws(' | ', to_char(a.starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
                    to_char(a.ends_at at time zone 'UTC', 'HH24:MI'), a.buffer_after_min::text, a.total_cents::text)
   from public.appointments a where a.id = (pg_temp.r('beard2') ->> 'appointment_id')::uuid),
  '2026-11-19 09:30 | 10:00 | 0 | 2000',
  'public move: the booked 30′ + 0′ block is written, back to back with the next appointment'
);

-- The block override of the slot search is for one staff member (a move), never for "any staff".
select throws_ok(
  $$select * from private.available_slots_core(
      '91000000-0000-4000-8000-00000000000a', array['94000000-0000-4000-8000-000000000004']::uuid[], null,
      '2026-11-18', '2026-11-18', 'public', null, '2026-11-02 06:00Z', interval '30 minutes')$$,
  '22023', null,
  'slots: a block override needs a staff member'
);

select * from finish();
rollback;
