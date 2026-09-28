-- Security baseline (SPEC §13, ADR-0005): RLS everywhere, anon owns nothing, explicit
-- allow-lists for every function an API role can execute and for every table privilege.
-- When you add a table or RPC, update the expected lists here on purpose.
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
select plan(23);

select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0::bigint,
  'every table in public has row level security enabled'
);

select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'm'),
  0::bigint,
  'no materialized views in the exposed schema (they cannot carry RLS)'
);

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'PUBLIC')),
  0::bigint,
  'anon and PUBLIC hold no table privileges in public'
);

select is(
  (select count(*) from information_schema.column_privileges
   where table_schema = 'public' and grantee in ('anon', 'PUBLIC')),
  0::bigint,
  'anon and PUBLIC hold no column privileges in public'
);

select is(
  (select array_agg(g.table_name || ':' || g.privilege_type order by g.table_name, g.privilege_type)
   from information_schema.role_table_grants g
   where g.table_schema = 'public' and g.grantee = 'authenticated'),
  array[
    'appointment_events:SELECT',
    'appointment_services:SELECT',
    'appointments:SELECT',
    'audit_log:SELECT',
    'business_members:DELETE', 'business_members:INSERT', 'business_members:SELECT', 'business_members:UPDATE',
    'businesses:SELECT',
    'client_consents:SELECT',
    'client_notes:DELETE', 'client_notes:SELECT',
    'clients:SELECT',
    'schedule_exceptions:DELETE', 'schedule_exceptions:INSERT', 'schedule_exceptions:SELECT', 'schedule_exceptions:UPDATE',
    'service_categories:DELETE', 'service_categories:INSERT', 'service_categories:SELECT', 'service_categories:UPDATE',
    'services:DELETE', 'services:INSERT', 'services:SELECT', 'services:UPDATE',
    'staff:DELETE', 'staff:INSERT', 'staff:SELECT', 'staff:UPDATE',
    'staff_services:DELETE', 'staff_services:INSERT', 'staff_services:SELECT', 'staff_services:UPDATE',
    'time_off:DELETE', 'time_off:INSERT', 'time_off:SELECT', 'time_off:UPDATE',
    'working_hours:DELETE', 'working_hours:INSERT', 'working_hours:SELECT', 'working_hours:UPDATE'
  ]::text[],
  'authenticated has exactly the intended table privileges'
);

select is(
  (select array_agg(c.table_name || '.' || c.column_name order by c.table_name, c.column_name)
   from information_schema.column_privileges c
   where c.table_schema = 'public' and c.grantee = 'authenticated' and c.privilege_type = 'UPDATE'
     and c.table_name in ('clients', 'client_consents', 'client_notes')),
  array[
    'client_consents.withdrawn_at',
    'client_notes.body',
    'clients.birthday', 'clients.email', 'clients.full_name', 'clients.locale', 'clients.phone_e164'
  ]::text[],
  'the app may update only these client, consent and note columns'
);

select is(
  (select array_agg(c.column_name::text order by c.column_name)
   from information_schema.column_privileges c
   where c.table_schema = 'public' and c.grantee = 'authenticated' and c.privilege_type = 'UPDATE'
     and c.table_name = 'businesses'),
  array[
    'address', 'allow_any_staff', 'auto_complete_after_min', 'booking_enabled', 'cancel_min_notice_min',
    'correction_window_days', 'locale', 'maps_url', 'max_advance_days', 'messaging_enabled', 'min_notice_min',
    'name', 'phone_e164', 'settings', 'slot_step_min', 'theme'
  ]::text[],
  'the app may update only these business columns (never slug, timezone, currency or vertical)'
);

select is(
  (select array_agg(c.table_name || '.' || c.column_name order by c.table_name, c.column_name)
   from information_schema.column_privileges c
   where c.table_schema = 'public' and c.grantee = 'authenticated' and c.privilege_type = 'INSERT'
     and c.table_name in ('clients', 'client_consents', 'client_notes')),
  array[
    'client_consents.business_id', 'client_consents.client_id', 'client_consents.created_by',
    'client_consents.given_by', 'client_consents.granted', 'client_consents.legal_basis',
    'client_consents.policy_version', 'client_consents.purpose', 'client_consents.source',
    'client_notes.author_id', 'client_notes.body', 'client_notes.business_id', 'client_notes.client_id',
    'clients.birthday', 'clients.business_id', 'clients.email', 'clients.full_name', 'clients.locale',
    'clients.phone_e164', 'clients.source'
  ]::text[],
  'the app may set only these columns when creating clients, consents and notes (no ids, dates or provenance)'
);

-- Appointments are written only through the booking RPCs (0004): the app holds no INSERT or
-- UPDATE on any appointment table, not even on single columns.
select is(
  (select array_agg(c.table_name || '.' || c.column_name || ':' || c.privilege_type
                    order by c.table_name, c.column_name, c.privilege_type)
   from information_schema.column_privileges c
   where c.table_schema = 'public' and c.grantee = 'authenticated'
     and c.table_name in ('appointments', 'appointment_services', 'appointment_events')
     and c.privilege_type in ('INSERT', 'UPDATE')),
  null::text[],
  'authenticated cannot insert or update any column of appointments, their lines or their events'
);

-- service_role (explicit list from 1.2 on): what 0001–0003 granted, and nothing more. Its
-- table-level INSERT/UPDATE on appointments is gone since 0004, because a table-level grant would
-- cover appointments.request_hash (asserted separately below).
select is(
  (select array_agg(g.table_name || ':' || g.privilege_type order by g.table_name, g.privilege_type)
   from information_schema.role_table_grants g
   where g.table_schema = 'public' and g.grantee = 'service_role'),
  array[
    'appointment_events:SELECT',
    'appointment_services:INSERT', 'appointment_services:SELECT', 'appointment_services:UPDATE',
    'appointments:SELECT',
    'audit_log:SELECT',
    'business_members:DELETE', 'business_members:INSERT', 'business_members:SELECT', 'business_members:UPDATE',
    'businesses:INSERT', 'businesses:SELECT', 'businesses:UPDATE',
    'client_consents:INSERT', 'client_consents:SELECT', 'client_consents:UPDATE',
    'client_notes:DELETE', 'client_notes:INSERT', 'client_notes:SELECT', 'client_notes:UPDATE',
    'clients:INSERT', 'clients:SELECT', 'clients:UPDATE',
    'schedule_exceptions:DELETE', 'schedule_exceptions:INSERT', 'schedule_exceptions:SELECT', 'schedule_exceptions:UPDATE',
    'service_categories:INSERT', 'service_categories:SELECT', 'service_categories:UPDATE',
    'services:INSERT', 'services:SELECT', 'services:UPDATE',
    'staff:INSERT', 'staff:SELECT', 'staff:UPDATE',
    'staff_services:DELETE', 'staff_services:INSERT', 'staff_services:SELECT', 'staff_services:UPDATE',
    'time_off:DELETE', 'time_off:INSERT', 'time_off:SELECT', 'time_off:UPDATE',
    'working_hours:DELETE', 'working_hours:INSERT', 'working_hours:SELECT', 'working_hours:UPDATE'
  ]::text[],
  'service_role has exactly the intended table privileges'
);

-- The idempotency fingerprint is written by book_core only: a caller that could set it could
-- make a different booking look like a replay of an earlier one.
select has_column('public', 'appointments', 'request_hash', 'appointments.request_hash exists');

select is(
  (select array_agg(c.grantee || ':' || c.privilege_type order by c.grantee, c.privilege_type)
   from information_schema.column_privileges c
   where c.table_schema = 'public' and c.table_name = 'appointments' and c.column_name = 'request_hash'
     and c.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
     and c.privilege_type in ('INSERT', 'UPDATE')),
  null::text[],
  'no API role can insert or update appointments.request_hash'
);

-- ---------------------------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------------------------
select is(
  (select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute')),
  array[
    'private.available_slots_impl', 'private.public_booking_catalogue_impl', 'private.public_business_profile_impl',
    'public.available_slots', 'public.public_booking_catalogue', 'public.public_business_profile'
  ]::text[],
  'anon may execute only the public booking-page RPCs'
);

select is(
  (select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and has_function_privilege('authenticated', p.oid, 'execute')),
  array[
    'private.available_slots_impl', 'private.has_role', 'private.is_member', 'private.is_reserved_slug',
    'private.is_valid_timezone', 'private.my_business_ids', 'private.my_business_ids_with_role',
    'private.my_staff_id', 'private.my_staff_ids', 'private.public_booking_catalogue_impl',
    'private.public_business_profile_impl', 'private.staff_available_slots_impl',
    'private.staff_book_appointment_impl',
    'public.available_slots', 'public.public_booking_catalogue', 'public.public_business_profile',
    'public.staff_available_slots', 'public.staff_book_appointment'
  ]::text[],
  'authenticated may execute only the membership helpers and granted RPCs'
);

-- service_role: the booking-page RPCs and the helpers that its CHECKs/policies need. The staff
-- RPCs are not on it (they need a signed-in member); book_core, move_core and the availability
-- internals are granted to nobody.
select is(
  (select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and has_function_privilege('service_role', p.oid, 'execute')),
  array[
    'private.available_slots_impl', 'private.has_role', 'private.is_member', 'private.is_reserved_slug',
    'private.is_valid_timezone', 'private.my_business_ids', 'private.my_business_ids_with_role',
    'private.my_staff_id', 'private.my_staff_ids', 'private.public_booking_catalogue_impl',
    'private.public_business_profile_impl',
    'public.available_slots', 'public.public_booking_catalogue', 'public.public_business_profile'
  ]::text[],
  'service_role may execute only the helpers and RPCs granted to it'
);

-- p_now exists only on private _impl functions, for tests. Every exposed wrapper passes now().
select is(
  (select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and 'p_now' = any (coalesce(p.proargnames, '{}'::text[]))),
  null::text[],
  'no function in public takes a p_now parameter (callers cannot move the clock)'
);

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef),
  0::bigint,
  'no SECURITY DEFINER function lives in the exposed schema (definer code lives in private)'
);

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
     and not exists (
       select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%'
     )),
  0::bigint,
  'every function in public/private pins its search_path'
);

select is(
  (select count(*) from pg_namespace where nspname = 'private'
     and has_schema_privilege('anon', oid, 'CREATE')),
  0::bigint,
  'API roles cannot create objects in private'
);

select is(
  (select array_agg(t.table_name::text order by t.table_name)
   from information_schema.table_privileges t
   where t.table_schema = 'public' and t.grantee in ('authenticated', 'service_role')
     and t.table_name in ('appointment_events', 'audit_log')
     and t.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  null::text[],
  'events and the audit log are append-only for every API role (written by triggers/functions)'
);

-- ---------------------------------------------------------------------------------------------
-- Default privileges: whatever postgres creates next (a new migration, the dashboard) starts
-- closed. Probes are created here and vanish with the rollback.
-- ---------------------------------------------------------------------------------------------
create table public.zz_default_acl_probe (id int);
create function public.zz_default_acl_probe() returns int language sql set search_path = '' as $$ select 1 $$;
create function private.zz_default_acl_probe() returns int language sql set search_path = '' as $$ select 1 $$;

select ok(
  not has_table_privilege('anon', 'public.zz_default_acl_probe', 'select')
    and not has_table_privilege('authenticated', 'public.zz_default_acl_probe', 'select')
    and not has_table_privilege('service_role', 'public.zz_default_acl_probe', 'select'),
  'a new table in public is not readable by any API role until granted'
);

select ok(
  not has_function_privilege('anon', 'public.zz_default_acl_probe()', 'execute')
    and not has_function_privilege('authenticated', 'public.zz_default_acl_probe()', 'execute')
    and not has_function_privilege('service_role', 'public.zz_default_acl_probe()', 'execute'),
  'a new function in public is not executable by any API role (nor PUBLIC) until granted'
);

select ok(
  not has_function_privilege('anon', 'private.zz_default_acl_probe()', 'execute')
    and not has_function_privilege('authenticated', 'private.zz_default_acl_probe()', 'execute')
    and not has_function_privilege('service_role', 'private.zz_default_acl_probe()', 'execute'),
  'a new function in private is not executable by the API roles until granted'
);

select * from finish();
rollback;
