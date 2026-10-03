-- Tenant isolation (SPEC §13): business A never reads or writes business B, and the database
-- rejects cross-tenant references even for roles that bypass RLS.
-- 1.7 (0009, contract 1.7 §7.2): former slugs are per business, and the generic RPC loop also
-- covers the five business-scoped member and identity RPCs (≥ 21 signatures). Review fix: the loop
-- also calls as the owner with an OLD authenticator code and records each error's hint, so a
-- critical RPC that checked the fresh code before the membership would show (a step-up hint for a
-- business the caller does not belong to).
-- 1.8 (0010, contract 1.8 §5.2): the loop also covers client_card, erase_client, merge_clients and
-- set_client_consent (≥ 25 signatures); erase_client, a critical RPC, refuses a foreign business with a
-- bare 42501 for every caller; notes, still direct writes, keep the tenant check of RLS.
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
-- Fixture appointments are written by the system (appointment writes must declare an actor).
select set_config('anaklo.actor_type', 'system', true);
select plan(30);

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

-- 0009: former slugs of each business (written here as postgres; the app never writes them).
insert into public.business_slug_aliases (slug, business_id) values
  ('shop-a-old', 'a1000000-0000-4000-8000-000000000001'),
  ('shop-b-old', 'b1000000-0000-4000-8000-000000000001');

-- 0009: the loop below calls the critical RPCs with a code from the authenticator app that is
-- seconds old; the window is set explicitly (the local seed uses 10 s, a remote database 300 s).
update private.platform_settings set fresh_totp_max_age_seconds = 300 where id;

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

select results_eq(
  'select slug from public.business_slug_aliases order by slug',
  array['shop-a-old'],
  'owner A reads the former slugs of A only, never those of B (0009)'
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

-- 1.6 (0008): the tables the settings screens still write directly (column grants) keep the
-- tenant check of RLS.
select throws_ok(
  $$insert into public.time_off (business_id, staff_id, starts_at, ends_at, reason)
    values ('b1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001',
            '2026-11-12 00:00Z', '2026-11-13 00:00Z', 'leave')$$,
  '42501',
  null,
  'owner A cannot record time off for staff of B'
);

select throws_ok(
  $$insert into public.schedule_exceptions (business_id, local_date, kind)
    values ('b1000000-0000-4000-8000-000000000001', '2026-12-24', 'closed')$$,
  '42501',
  null,
  'owner A cannot close business B'
);

select throws_ok(
  $$insert into public.staff (business_id, display_name)
    values ('b1000000-0000-4000-8000-000000000001', 'Intruder')$$,
  '42501',
  null,
  'owner A cannot add staff to B'
);

-- 1.8 (0010): notes stay direct writes (with a client-generated id); RLS keeps them inside the business.
select throws_ok(
  $$insert into public.client_notes (id, business_id, client_id, author_id, body)
    values ('a5000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001',
            'b3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', 'Intruder note')$$,
  '42501',
  null,
  'owner A cannot add a note to a client of B (1.8)'
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

-- 0008: no UPDATE grant on services any more (contract 1.6 §2.7: tightened, never relaxed).
select throws_ok(
  $$update public.services set price_cents = 0$$,
  '42501',
  null,
  'staff cannot update the catalogue; writes go through save_service'
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
-- by a member of A (the owner at aal2 with a fresh authenticator code, the same owner with a code
-- an hour old, and a staff member at aal1) with the id of B and NULL in every other argument.
-- Membership is checked first, so every call must fail with 42501 WITHOUT a hint, whatever else the
-- arguments or the caller's code would have caused. New RPCs join automatically.
-- ---------------------------------------------------------------------------------------------
create temp table tenant_rpc_calls (proname text, signature text, caller text, outcome text, hint text)
  on commit drop;

-- Signed-in users declare no actor (a declared 'system' would outrank the JWT).
select set_config('anaklo.actor_type', '', true);

do $loop$
declare
  v_caller record;
  v_fn record;
  v_outcome text;
  v_hint text;
begin
  for v_caller in
    select c.label, c.claims
    from (values
      ('owner (aal2)', json_build_object(
          'sub', 'a0000000-0000-4000-8000-00000000000a', 'role', 'authenticated', 'aal', 'aal2',
          'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint))
        )::text),
      ('owner (aal2, old code)', json_build_object(
          'sub', 'a0000000-0000-4000-8000-00000000000a', 'role', 'authenticated', 'aal', 'aal2',
          'amr', json_build_array(json_build_object('method', 'totp',
                                                    'timestamp', extract(epoch from now())::bigint - 3600))
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
      v_hint := null;
      begin
        execute format('select * from %s(%s)', v_fn.qualified, v_fn.args);
        v_outcome := 'no error';
      exception when others then
        get stacked diagnostics v_hint = pg_exception_hint;
        v_outcome := sqlstate;
      end;
      execute 'set local role postgres';
      insert into tenant_rpc_calls values (v_fn.proname, v_fn.signature, v_caller.label, v_outcome, nullif(v_hint, ''));
    end loop;
  end loop;
  perform set_config('request.jwt.claims', '', true);
end
$loop$;

select set_config('anaklo.actor_type', 'system', true);

-- The minimum grows with every step: 1.2 staff_available_slots, staff_book_appointment; 1.4 (0006)
-- busy_calendar, cancel_appointment, search_clients, set_appointment_status, staff_move_appointment,
-- today_summary; 1.5 (0007) request_test_push; 1.6 (0008) mark_absence, reassign_appointment,
-- reassign_candidates, replace_week_hours, save_service, schedule_conflicts, set_staff_order; 1.7 (0009)
-- can_manage_members, change_business_identity, list_members, remove_member, set_member_role; 1.8 (0010)
-- client_card, erase_client, merge_clients, set_client_consent.
-- register_push_subscription and unregister_push_subscription take no p_business_id (contract 1.5
-- D14: subscriptions belong to the user, not to a business); their isolation is tested in
-- 12_push_subscriptions. authorize_factor_change takes none either (phase-1 plan: the only
-- exception, it concerns the caller's own factors); 14_members_identity covers it.
select ok(
  (select count(distinct signature) from tenant_rpc_calls) >= 25,
  'the generic loop found at least 25 business-scoped RPCs'
);

select ok(
  array['busy_calendar', 'can_manage_members', 'cancel_appointment', 'change_business_identity', 'client_card',
        'erase_client', 'list_members', 'mark_absence', 'merge_clients', 'reassign_appointment', 'reassign_candidates',
        'remove_member', 'replace_week_hours', 'request_test_push', 'save_service', 'schedule_conflicts',
        'search_clients', 'set_appointment_status', 'set_client_consent', 'set_member_role', 'set_staff_order',
        'staff_available_slots', 'staff_book_appointment', 'staff_move_appointment', 'today_summary']
    <@ (select array_agg(proname) from tenant_rpc_calls),
  'the loop covers busy_calendar, can_manage_members, cancel_appointment, change_business_identity, client_card, '
  || 'erase_client, list_members, mark_absence, merge_clients, reassign_appointment, reassign_candidates, '
  || 'remove_member, replace_week_hours, request_test_push, save_service, schedule_conflicts, search_clients, '
  || 'set_appointment_status, set_client_consent, set_member_role, set_staff_order, staff_available_slots, '
  || 'staff_book_appointment, staff_move_appointment and today_summary'
);

-- 1.8: erase_client is critical (fresh code inside its _impl); membership comes first, so the owner at aal2
-- with a fresh or an old code and the staff member at aal1 all get the bare 42501 for business B.
select is(
  (select array_agg(caller || ' ' || outcome || ' ' || coalesce(hint, '-') order by caller collate "C")
   from tenant_rpc_calls where proname = 'erase_client'),
  array['owner (aal2) 42501 -', 'owner (aal2, old code) 42501 -', 'staff 42501 -']::text[],
  'erase_client with the id of B: 42501 without hint for the owner of A (fresh or old code) and for staff (1.8)'
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

select is(
  (select array_agg(signature || ' -> ' || outcome order by signature)
   from tenant_rpc_calls where caller = 'owner (aal2, old code)' and outcome <> '42501'),
  null::text[],
  'the owner of A with a code an hour old also gets 42501 from every business-scoped RPC called with the id of B'
);

select is(
  (select array_agg(caller || ': ' || signature || ' -> ' || hint order by caller, signature)
   from tenant_rpc_calls where hint is not null),
  null::text[],
  'no refusal carries a hint, not even from the critical RPCs to a caller at aal1 or with an old code: membership '
  || 'is checked before the fresh code (a step-up hint would open the code sheet for a business the caller is '
  || 'not in)'
);

select * from finish();
rollback;
