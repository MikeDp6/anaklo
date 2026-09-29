-- Tenant isolation (SPEC §13): business A never reads or writes business B, and the database
-- rejects cross-tenant references even for roles that bypass RLS.
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
-- Fixture appointments are written by the system (appointment writes must declare an actor).
select set_config('anaklo.actor_type', 'system', true);
select plan(22);

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
  ('a1000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', '2026-11-10 00:00Z', '2026-11-11 00:00Z', 'leave');

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

set local role postgres;

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

set local role postgres;

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

set local role postgres;

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

set local role postgres;

-- ---------------------------------------------------------------------------------------------
-- Generic loop over every business-scoped RPC (phase-1 plan, «Απομόνωση επιχειρήσεων στις RPCs»):
-- each function in public that authenticated may execute and that takes p_business_id is called
-- by a member of A (the owner at aal2 with a fresh authenticator code, and a staff member) with
-- the id of B and NULL in every other argument. Membership is checked first, so every call must
-- fail with 42501, whatever else the arguments would have caused. New RPCs join automatically.
-- ---------------------------------------------------------------------------------------------
create temp table tenant_rpc_calls (proname text, signature text, caller text, outcome text) on commit drop;

-- Signed-in users declare no actor (a declared 'system' would outrank the JWT).
select set_config('anaklo.actor_type', '', true);

do $loop$
declare
  v_caller record;
  v_fn record;
  v_outcome text;
begin
  for v_caller in
    select c.label, c.claims
    from (values
      ('owner (aal2)', json_build_object(
          'sub', 'a0000000-0000-4000-8000-00000000000a', 'role', 'authenticated', 'aal', 'aal2',
          'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint))
        )::text),
      ('staff', json_build_object(
          'sub', 'a0000000-0000-4000-8000-0000000000a2', 'role', 'authenticated', 'aal', 'aal1',
          'amr', json_build_array(json_build_object('method', 'otp', 'timestamp', extract(epoch from now())::bigint))
        )::text)
    ) c (label, claims)
  loop
    for v_fn in
      select
        p.proname::text as proname,
        p.oid::regprocedure::text as signature,
        format('%I.%I', n.nspname, p.proname) as qualified,
        (select coalesce(string_agg(
                  case when a.mode = 'v' then 'variadic ' else '' end
                  || case when a.name = 'p_business_id'
                          then quote_literal('b1000000-0000-4000-8000-000000000001') || '::uuid'
                          else 'null::' || format_type(a.typ, null) end,
                  ', ' order by a.ord), '')
         from unnest(
                coalesce(p.proallargtypes, p.proargtypes::oid[]),
                p.proargnames,
                coalesce(p.proargmodes, array_fill('i'::"char", array[p.pronargs::int]))
              ) with ordinality as a (typ, name, mode, ord)
         where a.mode in ('i', 'b', 'v')) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and has_function_privilege('authenticated', p.oid, 'execute')
        and 'p_business_id' = any (coalesce(p.proargnames, '{}'::text[]))
      order by 2
    loop
      perform set_config('request.jwt.claims', v_caller.claims, true);
      execute 'set local role authenticated';
      begin
        execute format('select * from %s(%s)', v_fn.qualified, v_fn.args);
        v_outcome := 'no error';
      exception when others then
        v_outcome := sqlstate;
      end;
      execute 'set local role postgres';
      insert into tenant_rpc_calls values (v_fn.proname, v_fn.signature, v_caller.label, v_outcome);
    end loop;
  end loop;
  perform set_config('request.jwt.claims', '', true);
end
$loop$;

select set_config('anaklo.actor_type', 'system', true);

-- The minimum grows with every step: 1.2 staff_available_slots, staff_book_appointment; 1.4 (0006)
-- busy_calendar, cancel_appointment, search_clients, set_appointment_status, staff_move_appointment,
-- today_summary.
select ok(
  (select count(distinct signature) from tenant_rpc_calls) >= 8,
  'the generic loop found at least 8 business-scoped RPCs'
);

select ok(
  array['busy_calendar', 'cancel_appointment', 'search_clients', 'set_appointment_status', 'staff_available_slots',
        'staff_book_appointment', 'staff_move_appointment', 'today_summary']
    <@ (select array_agg(proname) from tenant_rpc_calls),
  'the loop covers busy_calendar, cancel_appointment, search_clients, set_appointment_status, staff_available_slots, '
  || 'staff_book_appointment, staff_move_appointment and today_summary'
);

select is(
  (select array_agg(signature || ' -> ' || outcome order by signature)
   from tenant_rpc_calls where caller = 'owner (aal2)' and outcome <> '42501'),
  null::text[],
  'the owner of A (aal2, fresh code) gets 42501 from every business-scoped RPC called with the id of B'
);

select is(
  (select array_agg(signature || ' -> ' || outcome order by signature)
   from tenant_rpc_calls where caller = 'staff' and outcome <> '42501'),
  null::text[],
  'a staff member of A gets 42501 from every business-scoped RPC called with the id of B'
);

select * from finish();
rollback;
