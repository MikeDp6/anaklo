-- Tenant isolation (SPEC §13): business A never reads or writes business B, and the database
-- rejects cross-tenant references even for roles that bypass RLS.
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

-- ---------------------------------------------------------------------------------------------
-- Fixture (as postgres)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@test.local', '{}', '{}', now(), now()),
  ('a0000000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'staff-a@test.local', '{}', '{}', now(), now()),
  ('b0000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@test.local', '{}', '{}', now(), now());

insert into public.businesses (id, slug, name, vertical, timezone) values
  ('a1000000-0000-4000-8000-000000000001', 'shop-a', 'Shop A', 'barber', 'Europe/Athens'),
  ('b1000000-0000-4000-8000-000000000001', 'shop-b', 'Shop B', 'barber', 'Europe/Athens');

insert into public.staff (id, business_id, display_name) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'A One'),
  ('a2000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'A Two'),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'B One');

insert into public.business_members (business_id, user_id, role, staff_id) values
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', 'owner', 'a2000000-0000-4000-8000-000000000001'),
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a2', 'staff', 'a2000000-0000-4000-8000-000000000002'),
  ('b1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b', 'owner', 'b2000000-0000-4000-8000-000000000001');

insert into public.clients (id, business_id, full_name, phone_e164, source) values
  ('a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Client A', '+306900000901', 'staff'),
  ('b3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'Client B', '+306900000902', 'staff');

insert into public.appointments (business_id, client_id, staff_id, starts_at, ends_at, source) values
  ('a1000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', '2026-11-03 08:00Z', '2026-11-03 08:30Z', 'phone'),
  ('a1000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002', '2026-11-03 09:00Z', '2026-11-03 09:30Z', 'phone'),
  ('b1000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', '2026-11-03 08:00Z', '2026-11-03 08:30Z', 'phone');

insert into public.services (id, business_id, name, duration_min, price_cents) values
  ('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'A Cut', 30, 1300),
  ('b4000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'B Cut', 30, 1500);

insert into public.time_off (business_id, staff_id, starts_at, ends_at, reason) values
  ('a1000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', '2026-11-10 00:00Z', '2026-11-11 00:00Z', 'sick');

-- ---------------------------------------------------------------------------------------------
-- Owner of A
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-00000000000a", "role": "authenticated"}';

select results_eq(
  'select slug from public.businesses order by slug',
  array['shop-a'],
  'owner A sees only business A'
);

select is(
  (select count(*) from public.clients where business_id = 'b1000000-0000-4000-8000-000000000001'),
  0::bigint,
  'owner A cannot read clients of B'
);

select is(
  (select count(*) from public.appointments),
  2::bigint,
  'owner A sees all appointments of A and none of B'
);

-- RLS hides B's rows, so the update silently touches nothing; checked after reset role below.
select lives_ok(
  $$update public.clients set full_name = 'hacked' where id = 'b3000000-0000-4000-8000-000000000001'$$,
  'owner A may run an update aimed at B (it matches no visible rows)'
);

select throws_ok(
  $$insert into public.clients (business_id, full_name, source)
    values ('b1000000-0000-4000-8000-000000000001', 'Intruder', 'staff')$$,
  '42501',
  null,
  'owner A cannot create a client in B'
);

select throws_ok(
  $$insert into public.appointments (business_id, staff_id, starts_at, ends_at, source)
    values ('a1000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001',
            '2026-11-04 08:00Z', '2026-11-04 08:30Z', 'staff')$$,
  '42501',
  null,
  'the app cannot insert appointments directly (RPC only)'
);

select throws_ok(
  $$update public.clients set source = 'import' where id = 'a3000000-0000-4000-8000-000000000001'$$,
  '42501',
  null,
  'provenance columns are not updatable through the API'
);

select throws_ok(
  $$delete from public.appointment_events$$,
  '42501',
  null,
  'events cannot be deleted through the API'
);

reset role;

-- ---------------------------------------------------------------------------------------------
-- Staff member of A (not owner)
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000a2", "role": "authenticated"}';

select results_eq(
  'select staff_id from public.appointments',
  array['a2000000-0000-4000-8000-000000000002'::uuid],
  'staff sees only their own appointments'
);

select is(
  (select count(*) from public.time_off),
  0::bigint,
  'staff cannot read a colleague''s time off (and its reason)'
);

select lives_ok(
  $$update public.services set price_cents = 0$$,
  'staff may run a catalogue update (RLS makes it a no-op; checked below)'
);

select is(
  (select count(*) from public.clients),
  1::bigint,
  'staff can find the clients of their own business (quick-add)'
);

reset role;

select is(
  (select full_name from public.clients where id = 'b3000000-0000-4000-8000-000000000001'),
  'Client B',
  'owner A did not change the client of B'
);

select is(
  (select price_cents from public.services where id = 'a4000000-0000-4000-8000-000000000001'),
  1300,
  'staff did not change the price of their own business'
);

-- ---------------------------------------------------------------------------------------------
-- Anonymous
-- ---------------------------------------------------------------------------------------------
set local role anon;

select throws_ok(
  $$select * from public.clients$$,
  '42501',
  null,
  'anon cannot read clients'
);

reset role;

-- ---------------------------------------------------------------------------------------------
-- Cross-tenant references are impossible even when RLS is bypassed
-- ---------------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.appointments (business_id, client_id, staff_id, starts_at, ends_at, source)
    values ('a1000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001',
            'a2000000-0000-4000-8000-000000000001', '2026-11-05 08:00Z', '2026-11-05 08:30Z', 'staff')$$,
  '23503',
  null,
  'postgres: an appointment of A cannot point to a client of B'
);

set local role service_role;

select throws_ok(
  $$insert into public.appointments (business_id, client_id, staff_id, starts_at, ends_at, source)
    values ('a1000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001',
            'b2000000-0000-4000-8000-000000000001', '2026-11-05 08:00Z', '2026-11-05 08:30Z', 'staff')$$,
  '23503',
  null,
  'service_role: an appointment of A cannot point to staff of B'
);

select throws_ok(
  $$insert into public.staff_services (business_id, staff_id, service_id)
    values ('a1000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001',
            'b4000000-0000-4000-8000-000000000001')$$,
  '23503',
  null,
  'service_role: staff of A cannot be linked to a service of B'
);

reset role;

select * from finish();
rollback;
