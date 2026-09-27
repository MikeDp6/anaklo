-- Security baseline (SPEC §13, ADR-0005): RLS everywhere, anon owns nothing, explicit
-- allow-lists for every function an API role can execute and for every table privilege.
-- When you add a table or RPC, update the expected lists here on purpose.
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

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
    'businesses:SELECT', 'businesses:UPDATE',
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

-- ---------------------------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------------------------
select is(
  (select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute')),
  array['private.public_business_profile_impl', 'public.public_business_profile']::text[],
  'anon may execute only the public booking-page RPCs'
);

select is(
  (select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and has_function_privilege('authenticated', p.oid, 'execute')),
  array[
    'private.has_role', 'private.is_member', 'private.is_reserved_slug', 'private.is_valid_timezone',
    'private.my_business_ids', 'private.my_business_ids_with_role', 'private.my_staff_id',
    'private.my_staff_ids', 'private.public_business_profile_impl', 'public.public_business_profile'
  ]::text[],
  'authenticated may execute only the membership helpers and granted RPCs'
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

select * from finish();
rollback;
