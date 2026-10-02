-- Security baseline (SPEC §13, ADR-0005): RLS everywhere, anon owns nothing, explicit
-- allow-lists for every function an API role can execute and for every table privilege.
-- When you add a table or RPC, update the expected lists here on purpose.
-- 1.7 (0009, contract docs/plans/contracts/1.7-security-members.md §2.2, §2.10, §7.2): business_members
-- is SELECT-only for authenticated, the alias and grant tables, the twelve authenticated and eight
-- service_role functions, and the eight internal functions nobody executes.
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
select plan(59);

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
    'business_members:SELECT',
    'business_slug_aliases:SELECT',
    'businesses:SELECT',
    'client_consents:SELECT',
    'client_notes:DELETE', 'client_notes:SELECT',
    'clients:SELECT',
    'member_notification_prefs:SELECT',
    'push_subscriptions:SELECT',
    'schedule_exceptions:DELETE', 'schedule_exceptions:SELECT',
    'service_categories:SELECT',
    'services:SELECT',
    'staff:SELECT',
    'staff_services:SELECT',
    'time_off:DELETE', 'time_off:SELECT',
    'working_hours:SELECT'
  ]::text[],
  'authenticated has exactly the intended table privileges (0007: SELECT only on member_notification_prefs and '
  || 'push_subscriptions; 0008: catalogue and weekly hours read-only, staff/exceptions/time off writes per column, '
  || 'no DELETE on staff; 0009: business_members SELECT only, business_slug_aliases SELECT)'
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
    'name', 'phone_e164', 'quiet_end', 'quiet_start', 'reminder_mode', 'settings', 'slot_step_min'
  ]::text[],
  'the app may update only these business columns (never slug, timezone, currency, vertical, short_code, '
  || 'sms_sender_id, sms_daily_cap, sms_monthly_budget_cents, import_reminders or, since 0008, theme)'
);

-- 0008: the theme changes only by script (phase-1 plan 1.6); it exists, so its absence from the
-- list above is not vacuous.
select has_column('public', 'businesses', 'theme', 'businesses.theme exists');

-- 0008 (contract 1.6 §2.3): the catalogue and the weekly hours are written only by RPCs
-- (save_service, set_staff_order, replace_week_hours) or provisioning; staff, exceptions and time
-- off are written per column, with client-generated ids. staff.sort only through set_staff_order,
-- photo_url never; exceptions are added and deleted, never edited.
select is(
  (select array_agg(c.table_name || '.' || c.column_name || ':' || c.privilege_type
                    order by c.table_name, c.column_name, c.privilege_type)
   from information_schema.column_privileges c
   where c.table_schema = 'public' and c.grantee = 'authenticated'
     and c.table_name in ('schedule_exceptions', 'service_categories', 'services', 'staff', 'staff_services',
                          'time_off', 'working_hours')
     and c.privilege_type in ('INSERT', 'UPDATE')),
  array[
    'schedule_exceptions.business_id:INSERT', 'schedule_exceptions.end_time:INSERT', 'schedule_exceptions.id:INSERT',
    'schedule_exceptions.kind:INSERT', 'schedule_exceptions.local_date:INSERT', 'schedule_exceptions.note:INSERT',
    'schedule_exceptions.staff_id:INSERT', 'schedule_exceptions.start_time:INSERT',
    'staff.active:INSERT', 'staff.active:UPDATE', 'staff.business_id:INSERT', 'staff.color:INSERT',
    'staff.color:UPDATE', 'staff.display_name:INSERT', 'staff.display_name:UPDATE', 'staff.id:INSERT',
    'staff.sort:INSERT',
    'time_off.business_id:INSERT', 'time_off.ends_at:INSERT', 'time_off.ends_at:UPDATE', 'time_off.id:INSERT',
    'time_off.reason:INSERT', 'time_off.reason:UPDATE', 'time_off.staff_id:INSERT', 'time_off.starts_at:INSERT',
    'time_off.starts_at:UPDATE'
  ]::text[],
  'authenticated may insert/update only these columns of the catalogue and schedule tables (none of '
  || 'service_categories, services, staff_services, working_hours)'
);

select is(
  (select array_agg(p.tablename || ':' || p.cmd order by p.tablename, p.cmd)
   from pg_policies p
   where p.schemaname = 'public'
     and p.tablename in ('schedule_exceptions', 'service_categories', 'services', 'staff', 'staff_services',
                         'time_off', 'working_hours')),
  array[
    'schedule_exceptions:ALL', 'schedule_exceptions:SELECT', 'service_categories:SELECT', 'services:SELECT',
    'staff:ALL', 'staff:SELECT', 'staff_services:SELECT', 'time_off:ALL', 'time_off:SELECT', 'working_hours:SELECT'
  ]::text[],
  'catalogue and schedule policies after 0008: no write policy on the RPC-only tables'
);

-- The /r/<code> link (0005): generated by the database, never updatable through the API, so the
-- column list above must not change (a column that does not exist would pass it vacuously).
select has_column('public', 'businesses', 'short_code', 'businesses.short_code exists');

-- 0007: sender id, caps, budget and the import-reminder switch are provisioning decisions (contract
-- 1.5 §2.3); they exist, so their absence from the list above is not vacuous.
select is(
  (select array_agg(c.column_name::text order by c.column_name)
   from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'businesses'
     and c.column_name in ('import_reminders', 'sms_daily_cap', 'sms_monthly_budget_cents', 'sms_sender_id')),
  array['import_reminders', 'sms_daily_cap', 'sms_monthly_budget_cents', 'sms_sender_id']::text[],
  'businesses has the four provisioning-only messaging columns (0007)'
);

-- Verification, tokens, outbox, counters and suppressions (0005) are reachable only through the
-- definer RPCs: RLS on, no policy, and no privilege of any kind for any API role or PUBLIC.
select is(
  (select count(*) from pg_class c
   where c.oid = any (array[
     'public.otp_challenges', 'public.trusted_devices', 'public.booking_tokens', 'public.messages_log',
     'public.rate_limits', 'public.suppression_list', 'private.platform_settings', 'private.vertical_defaults'
   ]::regclass[]) and c.relrowsecurity),
  8::bigint,
  'the 0005 tables (6 in public, 2 in private) have row level security enabled'
);

select is(
  (select count(*) from pg_policies p
   where (p.schemaname, p.tablename) in (
     ('public', 'otp_challenges'), ('public', 'trusted_devices'), ('public', 'booking_tokens'),
     ('public', 'messages_log'), ('public', 'rate_limits'), ('public', 'suppression_list'),
     ('private', 'platform_settings'), ('private', 'vertical_defaults'))),
  0::bigint,
  'the 0005 tables have no RLS policy (no API role reads them directly)'
);

select is(
  (select array_agg(r.role_name || ' ' || t.table_name order by r.role_name, t.table_name)
   from unnest(array[
     'public.otp_challenges', 'public.trusted_devices', 'public.booking_tokens', 'public.messages_log',
     'public.rate_limits', 'public.suppression_list', 'private.platform_settings', 'private.vertical_defaults'
   ]) as t (table_name)
   cross join unnest(array['anon', 'authenticated', 'service_role', 'public']) as r (role_name)
   where has_table_privilege(r.role_name, t.table_name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(r.role_name, t.table_name, 'SELECT,INSERT,UPDATE,REFERENCES')),
  null::text[],
  'no API role and not PUBLIC holds any table or column privilege on the 0005 tables'
);

-- Job heartbeats and move idempotency (0006) are private bookkeeping: RLS on, no policy, and no
-- privilege of any kind for any API role or PUBLIC. Only the definer RPCs and the cron job write.
select is(
  (select count(*) from pg_class c
   where c.oid = any (array['private.job_runs', 'private.move_requests']::regclass[]) and c.relrowsecurity),
  2::bigint,
  'the 0006 tables (private.job_runs, private.move_requests) have row level security enabled'
);

select is(
  (select count(*) from pg_policies p
   where (p.schemaname, p.tablename) in (('private', 'job_runs'), ('private', 'move_requests'))),
  0::bigint,
  'the 0006 tables have no RLS policy (no API role reads them directly)'
);

select is(
  (select array_agg(r.role_name || ' ' || t.table_name order by r.role_name, t.table_name)
   from unnest(array['private.job_runs', 'private.move_requests']) as t (table_name)
   cross join unnest(array['anon', 'authenticated', 'service_role', 'public']) as r (role_name)
   where has_table_privilege(r.role_name, t.table_name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(r.role_name, t.table_name, 'SELECT,INSERT,UPDATE,REFERENCES')),
  null::text[],
  'no API role and not PUBLIC holds any table or column privilege on the 0006 tables'
);

-- Push subscriptions and notification preferences (0007): RLS on, exactly one policy each (SELECT
-- for authenticated, own rows), no write of any kind for any API role (only the definer RPCs write),
-- and nothing at all for anon, service_role or PUBLIC.
select is(
  (select count(*) from pg_class c
   where c.oid = any (array['public.push_subscriptions', 'public.member_notification_prefs']::regclass[])
     and c.relrowsecurity),
  2::bigint,
  'the 0007 tables (push_subscriptions, member_notification_prefs) have row level security enabled'
);

select is(
  (select array_agg(p.tablename || ':' || p.cmd || ':' || array_to_string(p.roles, ',') || ':' || p.permissive
                    order by p.tablename, p.policyname)
   from pg_policies p
   where p.schemaname = 'public' and p.tablename in ('member_notification_prefs', 'push_subscriptions')),
  array[
    'member_notification_prefs:SELECT:authenticated:PERMISSIVE',
    'push_subscriptions:SELECT:authenticated:PERMISSIVE'
  ]::text[],
  'the 0007 tables have exactly one policy each: SELECT for authenticated'
);

select is(
  (select array_agg(r.role_name || ' ' || t.table_name || ' ' || x.priv order by r.role_name, t.table_name, x.priv)
   from unnest(array['public.member_notification_prefs', 'public.push_subscriptions']) as t (table_name)
   cross join unnest(array['anon', 'authenticated', 'service_role', 'public']) as r (role_name)
   cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as x (priv)
   where has_table_privilege(r.role_name, t.table_name, x.priv)
      or (x.priv in ('INSERT', 'UPDATE', 'REFERENCES') and has_any_column_privilege(r.role_name, t.table_name, x.priv))),
  null::text[],
  'no API role and not PUBLIC can write the 0007 tables, not even single columns (RPCs only)'
);

select is(
  (select array_agg(r.role_name || ' ' || t.table_name order by r.role_name, t.table_name)
   from unnest(array['public.member_notification_prefs', 'public.push_subscriptions']) as t (table_name)
   cross join unnest(array['anon', 'service_role', 'public']) as r (role_name)
   where has_table_privilege(r.role_name, t.table_name, 'SELECT')
      or has_any_column_privilege(r.role_name, t.table_name, 'SELECT')),
  null::text[],
  'anon, service_role and PUBLIC cannot even read the 0007 tables'
);

-- 0009 (contract 1.7 §2.2): business_members changes only through the member RPCs. authenticated
-- keeps SELECT only (not even a column-level write); the 0001 write policies, permissive and
-- restrictive aal2, stay as the second line of defence.
select is(
  (select array_agg(x.priv order by x.priv)
   from unnest(array['DELETE', 'INSERT', 'TRUNCATE', 'UPDATE']) as x (priv)
   where has_table_privilege('authenticated', 'public.business_members', x.priv)
      or (x.priv in ('INSERT', 'UPDATE') and has_any_column_privilege('authenticated', 'public.business_members', x.priv))),
  null::text[],
  'authenticated cannot write business_members at all, not even single columns (0009: RPCs only)'
);

select is(
  (select array_agg(p.policyname || ':' || p.cmd || ':' || p.permissive order by p.policyname)
   from pg_policies p
   where p.schemaname = 'public' and p.tablename = 'business_members'),
  array[
    'business_members_delete:DELETE:PERMISSIVE', 'business_members_delete_mfa:DELETE:RESTRICTIVE',
    'business_members_insert:INSERT:PERMISSIVE', 'business_members_insert_mfa:INSERT:RESTRICTIVE',
    'business_members_select:SELECT:PERMISSIVE',
    'business_members_update:UPDATE:PERMISSIVE', 'business_members_update_mfa:UPDATE:RESTRICTIVE'
  ]::text[],
  'business_members keeps its select policy and the 0001 write policies, the restrictive aal2 ones included'
);

-- Former slugs (0009): RLS on, exactly one policy (SELECT for authenticated), written only by
-- change_business_identity_impl (definer): no write of any kind for any API role or PUBLIC.
select ok(
  (select c.relrowsecurity from pg_class c where c.oid = 'public.business_slug_aliases'::regclass),
  'business_slug_aliases has row level security enabled'
);

select is(
  (select array_agg(p.tablename || ':' || p.cmd || ':' || array_to_string(p.roles, ',') || ':' || p.permissive
                    order by p.policyname)
   from pg_policies p
   where p.schemaname = 'public' and p.tablename = 'business_slug_aliases'),
  array['business_slug_aliases:SELECT:authenticated:PERMISSIVE']::text[],
  'business_slug_aliases has exactly one policy: SELECT for authenticated'
);

select is(
  (select array_agg(r.role_name || ' ' || x.priv order by r.role_name, x.priv)
   from unnest(array['anon', 'authenticated', 'service_role', 'public']) as r (role_name)
   cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as x (priv)
   where has_table_privilege(r.role_name, 'public.business_slug_aliases', x.priv)
      or (x.priv in ('INSERT', 'UPDATE', 'REFERENCES')
          and has_any_column_privilege(r.role_name, 'public.business_slug_aliases', x.priv))),
  null::text[],
  'no API role and not PUBLIC can write business_slug_aliases, not even single columns'
);

-- Factor change grants (0009, read by 1.9): RLS on, no policy, no privilege of any kind for any
-- API role or PUBLIC. Written only by private.write_factor_grant.
select ok(
  (select c.relrowsecurity from pg_class c where c.oid = 'private.factor_change_grants'::regclass),
  'private.factor_change_grants has row level security enabled'
);

select is(
  (select count(*) from pg_policies p where p.schemaname = 'private' and p.tablename = 'factor_change_grants'),
  0::bigint,
  'private.factor_change_grants has no RLS policy'
);

select is(
  (select array_agg(r.role_name order by r.role_name)
   from unnest(array['anon', 'authenticated', 'service_role', 'public']) as r (role_name)
   where has_table_privilege(r.role_name, 'private.factor_change_grants', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(r.role_name, 'private.factor_change_grants', 'SELECT,INSERT,UPDATE,REFERENCES')),
  null::text[],
  'no API role and not PUBLIC holds any table or column privilege on private.factor_change_grants'
);

-- The freshness window (C6) lives in the private settings singleton (0009); 14_members_identity
-- checks its CHECK and default.
select has_column('private', 'platform_settings', 'fresh_totp_max_age_seconds',
  'private.platform_settings.fresh_totp_max_age_seconds exists');

-- pg_cron (0006) keeps its objects in schema cron; the API roles cannot even look into it (a grant
-- to PUBLIC would show up here as well).
select is(
  (select array_agg(r.role_name order by r.role_name)
   from unnest(array['anon', 'authenticated', 'service_role']) as r (role_name)
   where has_schema_privilege(r.role_name, 'cron', 'USAGE')),
  null::text[],
  'no API role has USAGE on schema cron'
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
    'business_slug_aliases:SELECT',
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
  'service_role has exactly the intended table privileges (0009: SELECT on business_slug_aliases; its '
  || 'business_members grants stay for provisioning)'
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
    'private.public_slug_for_code_impl',
    'public.available_slots', 'public.public_booking_catalogue', 'public.public_business_profile',
    'public.public_slug_for_code'
  ]::text[],
  'anon may execute only the public booking-page RPCs'
);

select is(
  (select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and has_function_privilege('authenticated', p.oid, 'execute')),
  array[
    'private.authorize_factor_change_impl',
    'private.available_slots_impl', 'private.busy_calendar_impl', 'private.can_manage_members_impl',
    'private.cancel_appointment_impl', 'private.change_business_identity_impl',
    'private.has_role', 'private.is_member', 'private.is_reserved_slug',
    'private.is_valid_timezone', 'private.list_members_impl', 'private.mark_absence_impl', 'private.my_business_ids',
    'private.my_business_ids_with_role', 'private.my_staff_id', 'private.my_staff_ids',
    'private.public_booking_catalogue_impl', 'private.public_business_profile_impl',
    'private.public_slug_for_code_impl', 'private.reassign_appointment_impl', 'private.reassign_candidates_impl',
    'private.register_push_subscription_impl', 'private.remove_member_impl', 'private.replace_week_hours_impl',
    'private.request_test_push_impl',
    'private.save_service_impl', 'private.schedule_conflicts_impl', 'private.search_clients_impl',
    'private.set_appointment_status_impl', 'private.set_member_role_impl', 'private.set_staff_order_impl',
    'private.staff_available_slots_impl',
    'private.staff_book_appointment_impl', 'private.staff_move_appointment_impl', 'private.today_summary_impl',
    'private.unregister_push_subscription_impl',
    'public.authorize_factor_change',
    'public.available_slots', 'public.busy_calendar', 'public.can_manage_members', 'public.cancel_appointment',
    'public.change_business_identity', 'public.list_members', 'public.mark_absence',
    'public.public_booking_catalogue', 'public.public_business_profile', 'public.public_slug_for_code',
    'public.reassign_appointment', 'public.reassign_candidates', 'public.register_push_subscription',
    'public.remove_member', 'public.replace_week_hours',
    'public.request_test_push', 'public.save_service', 'public.schedule_conflicts', 'public.search_clients',
    'public.set_appointment_status', 'public.set_member_role', 'public.set_staff_order', 'public.staff_available_slots',
    'public.staff_book_appointment', 'public.staff_move_appointment', 'public.today_summary',
    'public.unregister_push_subscription'
  ]::text[],
  'authenticated may execute only the membership helpers and granted RPCs (0006: the six day-ops RPCs; '
  || '0007: register/unregister_push_subscription, request_test_push; 0008: mark_absence, reassign_appointment, '
  || 'reassign_candidates, replace_week_hours, save_service, schedule_conflicts, set_staff_order; 0009: '
  || 'authorize_factor_change, can_manage_members, change_business_identity, list_members, remove_member, '
  || 'set_member_role; each with its _impl)'
);

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and has_function_privilege('authenticated', p.oid, 'execute')),
  64::bigint,
  'authenticated may execute exactly 64 functions in public/private (52 until 0008, twelve more in 0009)'
);

-- 1.7 (0009): the freshness rule, the D2 session check, the grant writer, the privilege test, the
-- factor clean-up and the two trigger functions are granted to nobody (only definer _impl code and
-- triggers call them). All of them must exist, so the check is not vacuous.
select is(
  (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname = any (array[
     'has_fresh_totp', 'require_fresh_totp', 'session_mfa_ok', 'write_factor_grant', 'is_privileged_anywhere',
     'drop_factors_if_unprivileged', 'business_members_access_changed', 'businesses_slug_guard'])),
  8::bigint,
  'the 0009 internal functions exist (has_fresh_totp, require_fresh_totp, session_mfa_ok, write_factor_grant, '
  || 'is_privileged_anywhere, drop_factors_if_unprivileged, business_members_access_changed, businesses_slug_guard)'
);

select is(
  (select array_agg(r.role_name || ' ' || p.proname order by r.role_name, p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   cross join unnest(array['anon', 'authenticated', 'service_role']) as r (role_name)
   where n.nspname = 'private' and p.proname = any (array[
     'has_fresh_totp', 'require_fresh_totp', 'session_mfa_ok', 'write_factor_grant', 'is_privileged_anywhere',
     'drop_factors_if_unprivileged', 'business_members_access_changed', 'businesses_slug_guard'])
     and has_function_privilege(r.role_name, p.oid, 'execute')),
  null::text[],
  'no API role may execute the 0009 internal functions (the freshness rule is reachable only through the _impls)'
);

-- 1.6 (0008): the precedence helper, the conflict core, the old day windows, the re-plan and its
-- trigger function are granted to nobody. All of them must exist, so the check is not vacuous.
select is(
  (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname = any (array[
     'staff_day_opening', 'staff_day_windows', 'schedule_conflicts_core', 'replan_reminders_impl',
     'businesses_replan_reminders'])),
  5::bigint,
  'the 0008 internal functions exist (staff_day_opening, staff_day_windows, schedule_conflicts_core, '
  || 'replan_reminders_impl, businesses_replan_reminders)'
);

select is(
  (select array_agg(r.role_name || ' ' || p.proname order by r.role_name, p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   cross join unnest(array['anon', 'authenticated', 'service_role']) as r (role_name)
   where n.nspname = 'private' and p.proname = any (array[
     'staff_day_opening', 'staff_day_windows', 'schedule_conflicts_core', 'replan_reminders_impl',
     'businesses_replan_reminders'])
     and has_function_privilege(r.role_name, p.oid, 'execute')),
  null::text[],
  'no API role may execute the 0008 internal functions'
);

-- 1.5 (0007): the planner, the claim core, the time rules, the nudge, the jobs, the push helpers and
-- the trigger function are granted to nobody (pg_cron runs the jobs as postgres). All of them must
-- exist, so the check is not vacuous.
select is(
  (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname = any (array[
     'plan_messages_impl', 'claim_core', 'reminder_at', 'nudge_dispatch', 'vault_value_or_null',
     'drop_push_subscriptions', 'push_recipients', 'in_quiet_hours', 'message_deadline', 'queued_sms_ids',
     'sms_newly_queued', 'dispatch_sweep_impl', 'purge_impl', 'business_members_drop_push',
     'sms_reachable'])),
  15::bigint,
  'the 0007 internal functions exist (planner, claim core, time rules, nudge, jobs, push helpers, trigger)'
);

select is(
  (select array_agg(r.role_name || ' ' || p.proname order by r.role_name, p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   cross join unnest(array['anon', 'authenticated', 'service_role']) as r (role_name)
   where n.nspname = 'private' and p.proname = any (array[
     'plan_messages_impl', 'claim_core', 'reminder_at', 'nudge_dispatch', 'vault_value_or_null',
     'drop_push_subscriptions', 'push_recipients', 'in_quiet_hours', 'message_deadline', 'queued_sms_ids',
     'sms_newly_queued', 'dispatch_sweep_impl', 'purge_impl', 'business_members_drop_push',
     'sms_reachable'])
     and has_function_privilege(r.role_name, p.oid, 'execute')),
  null::text[],
  'no API role may execute the 0007 internal functions'
);

-- service_role: the booking-page RPCs, the helpers that its CHECKs/policies need and (0005) the
-- online-booking and manage-link RPCs of the Edge Functions. The staff RPCs are not on it (they
-- need a signed-in member); book_core, move_core, the planner, next_visit_hint, the crypto/Vault
-- helpers, trigger functions and the availability internals are granted to nobody.
select is(
  (select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and has_function_privilege('service_role', p.oid, 'execute')),
  array[
    'private.add_member_impl',
    'private.available_slots_impl', 'private.book_appointment_impl', 'private.claim_due_messages_impl',
    'private.claim_messages_impl',
    'private.clients_for_phone_impl', 'private.has_role', 'private.is_member', 'private.is_reserved_slug',
    'private.is_valid_timezone', 'private.manage_cancel_impl', 'private.manage_reschedule_impl',
    'private.manage_slots_impl', 'private.manage_view_impl', 'private.my_business_ids',
    'private.my_business_ids_with_role', 'private.my_staff_id', 'private.my_staff_ids', 'private.otp_start_impl',
    'private.otp_verify_impl', 'private.public_booking_catalogue_impl', 'private.public_business_profile_impl',
    'private.public_slug_for_code_impl', 'private.record_delivery_report_impl', 'private.record_dispatch_run_impl',
    'private.record_send_result_impl', 'private.record_support_action_impl', 'private.revoke_user_sessions_impl',
    'private.trusted_device_revoke_impl', 'private.user_id_for_email_impl',
    'public.add_member',
    'public.available_slots', 'public.book_appointment', 'public.claim_due_messages', 'public.claim_messages',
    'public.clients_for_phone',
    'public.manage_cancel', 'public.manage_reschedule', 'public.manage_slots', 'public.manage_view',
    'public.otp_start', 'public.otp_verify', 'public.public_booking_catalogue', 'public.public_business_profile',
    'public.public_slug_for_code', 'public.record_delivery_report', 'public.record_dispatch_run',
    'public.record_send_result', 'public.record_support_action', 'public.revoke_user_sessions',
    'public.trusted_device_revoke', 'public.user_id_for_email'
  ]::text[],
  'service_role may execute only the helpers and RPCs granted to it (0007: claim_due_messages, '
  || 'record_delivery_report, record_dispatch_run and their _impl; none of the push subscription RPCs; 0009: '
  || 'add_member, record_support_action, revoke_user_sessions, user_id_for_email and their _impl, none of the '
  || 'member RPCs of authenticated)'
);

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and has_function_privilege('service_role', p.oid, 'execute')),
  52::bigint,
  'service_role may execute exactly 52 functions in public/private (44 until 0008, eight more in 0009)'
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
-- 0009: no member write through the table, not even by an owner at aal2 with a code from the
-- authenticator app that is seconds old (the window is set here, as every file that relies on it
-- does). The privilege is gone, so PostgreSQL refuses before RLS is even consulted.
-- ---------------------------------------------------------------------------------------------
update private.platform_settings set fresh_totp_max_age_seconds = 300 where id;

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('d0100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-sec@test.local', '{}', '{}', now(), now()),
  ('d0100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'staff-sec@test.local', '{}', '{}', now(), now()),
  ('d0100000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'new-sec@test.local', '{}', '{}', now(), now());

insert into public.businesses (id, slug, name, vertical, timezone)
values ('d0110000-0000-4000-8000-000000000001', 'shop-sec', 'Shop Sec', 'barber', 'Europe/Athens');

insert into public.business_members (business_id, user_id, role) values
  ('d0110000-0000-4000-8000-000000000001', 'd0100000-0000-4000-8000-000000000001', 'owner'),
  ('d0110000-0000-4000-8000-000000000001', 'd0100000-0000-4000-8000-000000000002', 'staff');

select set_config('request.jwt.claims', json_build_object(
  'sub', 'd0100000-0000-4000-8000-000000000001', 'role', 'authenticated', 'aal', 'aal2',
  'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint))
)::text, true);
set local role authenticated;

select throws_ok(
  $$insert into public.business_members (business_id, user_id, role)
    values ('d0110000-0000-4000-8000-000000000001', 'd0100000-0000-4000-8000-000000000003', 'owner')$$,
  '42501', null,
  'an owner at aal2 with a fresh code cannot INSERT into business_members (add_member through invite-member only)'
);

select throws_ok(
  $$update public.business_members set role = 'manager'
    where business_id = 'd0110000-0000-4000-8000-000000000001' and user_id = 'd0100000-0000-4000-8000-000000000002'$$,
  '42501', null,
  'an owner at aal2 with a fresh code cannot UPDATE business_members (set_member_role only)'
);

select throws_ok(
  $$delete from public.business_members
    where business_id = 'd0110000-0000-4000-8000-000000000001' and user_id = 'd0100000-0000-4000-8000-000000000002'$$,
  '42501', null,
  'an owner at aal2 with a fresh code cannot DELETE from business_members (remove_member only)'
);

set local role postgres;
select set_config('request.jwt.claims', '', true);

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
