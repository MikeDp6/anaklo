-- Push subscriptions of staff (phase-1 plan 1.5, contract docs/plans/contracts/1.5-messaging.md
-- §2.4, §2.10, §5.2; ADR-0010 §2 and §7): register_push_subscription / unregister_push_subscription,
-- RLS of push_subscriptions and member_notification_prefs, and the DB-level guarantee that a user's
-- devices go away whenever a membership row of that user is deleted or its role changes.
-- Written from the plan and the contract only (independent author).
--   · A row is written only for auth.uid(): no argument names a user.
--   · The same device registered by another member moves to the caller (moved: true, same id).
--   · The deletion paths are exercised as postgres (DELETE of the membership row, UPDATE of its role)
--     and, since 0009 (1.7) took the table grant away, through remove_member_impl as an owner with a
--     fresh code; the direct API delete is now refused (42501). 14_members_identity repeats the
--     push-deletion checks through set_member_role and remove_member.
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
-- No appointment is written here; the actor is declared anyway, as in every file.
select set_config('anaklo.actor_type', 'system', true);
select plan(42);

-- ---------------------------------------------------------------------------------------------
-- Helpers (pg_temp). Results of calls are kept in transaction-local settings 't.<name>'.
-- ---------------------------------------------------------------------------------------------
create temporary table lbl (id uuid primary key, label text not null);

create function pg_temp.l(a_id uuid)
returns text
language sql
stable
as $fn$
  select case when a_id is null then '-'
              else coalesce((select x.label from pg_temp.lbl x where x.id = a_id), a_id::text) end;
$fn$;

create function pg_temp.r(a_name text)
returns jsonb
language sql
stable
as $fn$
  select nullif(current_setting('t.' || a_name, true), '')::jsonb;
$fn$;

create function pg_temp.jwt(a_user uuid, a_aal text default 'aal1')
returns text
language sql
immutable
as $fn$
  select json_build_object('sub', a_user, 'role', 'authenticated', 'aal', a_aal)::text;
$fn$;

-- Runs one statement as an API role (optionally with JWT claims) and returns its single value,
-- '<null>', or the SQLSTATE of the error.
create function pg_temp.as_role(a_role text, a_sql text, a_claims text default '')
returns text
language plpgsql
as $fn$
declare
  v text;
begin
  begin
    perform set_config('request.jwt.claims', a_claims, true);
    execute format('set local role %I', a_role);
    execute a_sql into v;
    v := coalesce(v, '<null>');
  exception when others then
    v := sqlstate;
  end;
  execute 'set local role postgres';
  perform set_config('request.jwt.claims', '', true);
  return v;
end;
$fn$;

-- register_push_subscription as a_user: 'ok' (answer kept in t.<a_name>) or the SQLSTATE.
create function pg_temp.reg(
  a_name text, a_user uuid, a_provider text, a_sub text,
  a_endpoint text default null, a_p256dh text default null, a_auth text default null
)
returns text
language plpgsql
as $fn$
declare
  v text;
begin
  v := pg_temp.as_role('authenticated', format(
    'select public.register_push_subscription(p_provider => %L, p_subscription_id => %L, p_endpoint => %L, '
    || 'p_p256dh => %L, p_auth => %L)::text',
    a_provider, a_sub, a_endpoint, a_p256dh, a_auth), pg_temp.jwt(a_user));
  if left(v, 1) = '{' then
    perform set_config('t.' || a_name, v, true);
    return 'ok';
  end if;
  return v;
end;
$fn$;

-- unregister_push_subscription as a_user: the number of rows deleted, or the SQLSTATE.
create function pg_temp.unreg(a_user uuid, a_sub text, a_endpoint text default null, a_all boolean default false)
returns text
language sql
as $fn$
  select pg_temp.as_role('authenticated', format(
    'select public.unregister_push_subscription(p_subscription_id => %L, p_endpoint => %L, p_all => %L)::text',
    a_sub, a_endpoint, a_all), pg_temp.jwt(a_user));
$fn$;

-- The devices (OneSignal id or VAPID endpoint) of a user, sorted; '-' for none.
create function pg_temp.rows_of(a_user uuid)
returns text
language sql
as $fn$
  select coalesce(string_agg(coalesce(s.subscription_id, s.endpoint), ',' order by coalesce(s.subscription_id, s.endpoint)), '-')
  from public.push_subscriptions s
  where s.user_id = a_user;
$fn$;

-- Fingerprint of every row that does NOT belong to a_user (seed rows included).
create function pg_temp.others(a_user uuid)
returns text
language sql
as $fn$
  select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by s.id), ''))
  from public.push_subscriptions s
  where s.user_id is distinct from a_user;
$fn$;

-- VAPID keys of the right shape (p256dh 87 base64url characters, auth 22).
create function pg_temp.p256(a_char text)
returns text
language sql
immutable
as $fn$
  select 'B' || repeat(a_char, 86);
$fn$;

create function pg_temp.auth(a_char text)
returns text
language sql
immutable
as $fn$
  select 'a' || repeat(a_char, 21);
$fn$;

-- ---------------------------------------------------------------------------------------------
-- Fixture (as postgres)
--   P 'push-subs-shop': U1 owner (SP1) · U2 staff (SP2) · U3 manager (no staff row) · U6 staff (SP6)
--     · U7 staff (SP7)
--   Q 'push-subs-other': U4 owner (SQ4) · U6 staff (SQ6)   (U6 belongs to both)
--   U5 belongs to no business.
--   Devices written directly (as a device registered earlier would be): U3 c703 · U4 c704 ·
--   U5 c705 (left over from a past membership) · U6 c706 + VAPID ep/c706 · U7 c707.
-- ---------------------------------------------------------------------------------------------
insert into pg_temp.lbl (id, label) values
  ('c7000000-0000-4000-8000-000000000001', 'U1'),
  ('c7000000-0000-4000-8000-000000000002', 'U2'),
  ('c7000000-0000-4000-8000-000000000003', 'U3'),
  ('c7000000-0000-4000-8000-000000000004', 'U4'),
  ('c7000000-0000-4000-8000-000000000005', 'U5'),
  ('c7000000-0000-4000-8000-000000000006', 'U6'),
  ('c7000000-0000-4000-8000-000000000007', 'U7'),
  ('c7100000-0000-4000-8000-000000000001', 'P'),
  ('c7100000-0000-4000-8000-000000000002', 'Q');

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select x.id, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated',
       lower(x.label) || '@push-subs.test', '{}'::jsonb, '{}'::jsonb, now(), now()
from pg_temp.lbl x
where x.label like 'U%';

insert into public.businesses (id, slug, name, vertical, timezone) values
  ('c7100000-0000-4000-8000-000000000001', 'push-subs-shop', 'Push Subs Shop', 'barber', 'Europe/Athens'),
  ('c7100000-0000-4000-8000-000000000002', 'push-subs-other', 'Push Subs Other', 'barber', 'Europe/Athens');

insert into public.staff (id, business_id, display_name) values
  ('c7200000-0000-4000-8000-000000000001', 'c7100000-0000-4000-8000-000000000001', 'SP1'),
  ('c7200000-0000-4000-8000-000000000002', 'c7100000-0000-4000-8000-000000000001', 'SP2'),
  ('c7200000-0000-4000-8000-000000000006', 'c7100000-0000-4000-8000-000000000001', 'SP6'),
  ('c7200000-0000-4000-8000-000000000007', 'c7100000-0000-4000-8000-000000000001', 'SP7'),
  ('c7200000-0000-4000-8000-000000000014', 'c7100000-0000-4000-8000-000000000002', 'SQ4'),
  ('c7200000-0000-4000-8000-000000000016', 'c7100000-0000-4000-8000-000000000002', 'SQ6');

insert into public.business_members (business_id, user_id, role, staff_id) values
  ('c7100000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 'owner', 'c7200000-0000-4000-8000-000000000001'),
  ('c7100000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000002', 'staff', 'c7200000-0000-4000-8000-000000000002'),
  ('c7100000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000003', 'manager', null),
  ('c7100000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000006', 'staff', 'c7200000-0000-4000-8000-000000000006'),
  ('c7100000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000007', 'staff', 'c7200000-0000-4000-8000-000000000007'),
  ('c7100000-0000-4000-8000-000000000002', 'c7000000-0000-4000-8000-000000000004', 'owner', 'c7200000-0000-4000-8000-000000000014'),
  ('c7100000-0000-4000-8000-000000000002', 'c7000000-0000-4000-8000-000000000006', 'staff', 'c7200000-0000-4000-8000-000000000016');

insert into public.member_notification_prefs (business_id, user_id, push_own, push_all) values
  ('c7100000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', null, false),
  ('c7100000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000002', true, null),
  ('c7100000-0000-4000-8000-000000000002', 'c7000000-0000-4000-8000-000000000004', null, null),
  ('c7100000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000006', false, null),
  ('c7100000-0000-4000-8000-000000000002', 'c7000000-0000-4000-8000-000000000006', null, true);

insert into public.push_subscriptions (user_id, provider, subscription_id, endpoint, p256dh, auth_secret, created_at) values
  ('c7000000-0000-4000-8000-000000000003', 'onesignal', '0a000000-0000-4000-8000-00000000c703', null, null, null, now() - interval '1 hour'),
  ('c7000000-0000-4000-8000-000000000004', 'onesignal', '0a000000-0000-4000-8000-00000000c704', null, null, null, now() - interval '1 hour'),
  ('c7000000-0000-4000-8000-000000000005', 'onesignal', '0a000000-0000-4000-8000-00000000c705', null, null, null, now() - interval '1 hour'),
  ('c7000000-0000-4000-8000-000000000006', 'onesignal', '0a000000-0000-4000-8000-00000000c706', null, null, null, now() - interval '1 hour'),
  ('c7000000-0000-4000-8000-000000000006', 'vapid', null, 'https://push.example.test/ep/c706', pg_temp.p256('c'), pg_temp.auth('c'), now() - interval '1 hour'),
  ('c7000000-0000-4000-8000-000000000007', 'onesignal', '0a000000-0000-4000-8000-00000000c707', null, null, null, now() - interval '1 hour');

-- ---------------------------------------------------------------------------------------------
-- register_push_subscription: the row belongs to auth.uid(); the device moves to the caller
-- ---------------------------------------------------------------------------------------------
select is(
  pg_temp.reg('r1', 'c7000000-0000-4000-8000-000000000001', 'onesignal', '0A000000-0000-4000-8000-00000000C701'),
  'ok',
  'register: a member registers a OneSignal subscription (upper-case id)'
);

select is(
  (select concat_ws(' ', pg_temp.r('r1') ->> 'moved', pg_temp.l(s.user_id), s.provider, s.subscription_id,
                    coalesce(s.endpoint, '-'))
   from public.push_subscriptions s where s.id = (pg_temp.r('r1') ->> 'id')::uuid),
  'false U1 onesignal 0a000000-0000-4000-8000-00000000c701 -',
  'register: the row is written for the caller (auth.uid()), the id is stored in lower case, moved false'
);

select is(
  pg_temp.reg('r1b', 'c7000000-0000-4000-8000-000000000001', 'onesignal', '0a000000-0000-4000-8000-00000000c701'),
  'ok',
  'register: the same user registers the same subscription again'
);

select is(
  concat_ws(' ', pg_temp.r('r1b') ->> 'moved', (pg_temp.r('r1b') ->> 'id') = (pg_temp.r('r1') ->> 'id'),
            (select count(*) from public.push_subscriptions s where s.subscription_id = '0a000000-0000-4000-8000-00000000c701'),
            pg_temp.rows_of('c7000000-0000-4000-8000-000000000001')),
  'false t 1 0a000000-0000-4000-8000-00000000c701',
  'register: the same user again → moved false, the same id, still one row'
);

select is(
  pg_temp.reg('r2', 'c7000000-0000-4000-8000-000000000002', 'onesignal', '0a000000-0000-4000-8000-00000000c701'),
  'ok',
  'register: another member registers the same device (a shared phone)'
);

select is(
  concat_ws(' ', pg_temp.r('r2') ->> 'moved', (pg_temp.r('r2') ->> 'id') = (pg_temp.r('r1') ->> 'id'),
            (select pg_temp.l(s.user_id) from public.push_subscriptions s where s.id = (pg_temp.r('r2') ->> 'id')::uuid),
            (select count(*) from public.push_subscriptions s where s.subscription_id = '0a000000-0000-4000-8000-00000000c701'),
            pg_temp.rows_of('c7000000-0000-4000-8000-000000000001')),
  'true t U2 1 -',
  'register: the device moves to the caller (moved true, same id, user U2) and the previous user keeps nothing'
);

select is(
  (select array_agg(p.proname || ':' || p.pronargs || ':'
                    || (not exists (select 1 from unnest(coalesce(p.proargnames, '{}'::text[])) a where a ~* 'user|uid'))::text
                    order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname, p.proname) in (('public', 'register_push_subscription'), ('private', 'register_push_subscription_impl'))),
  array['register_push_subscription:5:true', 'register_push_subscription_impl:5:true'],
  'register: neither the wrapper nor the _impl takes a user argument (the owner is always auth.uid())'
);

select is(
  pg_temp.reg('v1', 'c7000000-0000-4000-8000-000000000001', 'vapid', null,
              'https://push.example.test/ep/c701', pg_temp.p256('x'), pg_temp.auth('x')),
  'ok',
  'register: a member registers a VAPID subscription'
);

select is(
  (select concat_ws(' ', pg_temp.r('v1') ->> 'moved', pg_temp.l(s.user_id), s.provider, coalesce(s.subscription_id, '-'),
                    s.p256dh = pg_temp.p256('x'), s.auth_secret = pg_temp.auth('x'))
   from public.push_subscriptions s where s.id = (pg_temp.r('v1') ->> 'id')::uuid),
  'false U1 vapid - t t',
  'register: the VAPID row stores endpoint and keys for the caller'
);

select is(
  pg_temp.reg('v1b', 'c7000000-0000-4000-8000-000000000001', 'vapid', null,
              'https://push.example.test/ep/c701', pg_temp.p256('y'), pg_temp.auth('y')),
  'ok',
  'register: the same VAPID endpoint again with new keys'
);

select is(
  (select concat_ws(' ', pg_temp.r('v1b') ->> 'moved', s.id = (pg_temp.r('v1') ->> 'id')::uuid,
                    s.p256dh = pg_temp.p256('y'), s.auth_secret = pg_temp.auth('y'),
                    (select count(*) from public.push_subscriptions x where x.endpoint = 'https://push.example.test/ep/c701'))
   from public.push_subscriptions s where s.id = (pg_temp.r('v1b') ->> 'id')::uuid),
  'false t t t 1',
  'register: re-registering a VAPID endpoint keeps the row and replaces its keys'
);

select is(
  pg_temp.reg('v3', 'c7000000-0000-4000-8000-000000000003', 'vapid', null,
              'https://push.example.test/ep/c701', pg_temp.p256('z'), pg_temp.auth('z')),
  'ok',
  'register: another member (the manager) registers the same VAPID endpoint'
);

select is(
  (select concat_ws(' ', pg_temp.r('v3') ->> 'moved', s.id = (pg_temp.r('v1') ->> 'id')::uuid, pg_temp.l(s.user_id),
                    s.p256dh = pg_temp.p256('z'))
   from public.push_subscriptions s where s.id = (pg_temp.r('v3') ->> 'id')::uuid),
  'true t U3 t',
  'register: the VAPID endpoint moves to the caller (moved true, same id, keys replaced)'
);

select is(
  concat_ws(' ',
    pg_temp.reg('x1', 'c7000000-0000-4000-8000-000000000001', 'apns', '0a000000-0000-4000-8000-00000000c7e1'),
    pg_temp.reg('x2', 'c7000000-0000-4000-8000-000000000001', 'onesignal', 'not-a-uuid'),
    pg_temp.reg('x3', 'c7000000-0000-4000-8000-000000000001', 'onesignal', null),
    pg_temp.reg('x4', 'c7000000-0000-4000-8000-000000000001', 'onesignal', '0a000000-0000-4000-8000-00000000c7e4',
                'https://push.example.test/ep/c7e4'),
    pg_temp.reg('x5', 'c7000000-0000-4000-8000-000000000001', 'vapid', null,
                'http://push.example.test/ep/c7e5', pg_temp.p256('x'), pg_temp.auth('x')),
    pg_temp.reg('x6', 'c7000000-0000-4000-8000-000000000001', 'vapid', null,
                'https://push.example.test/ep/c7e6', 'short', pg_temp.auth('x')),
    pg_temp.reg('x7', 'c7000000-0000-4000-8000-000000000001', 'vapid', null,
                'https://push.example.test/ep/c7e7', pg_temp.p256('x'), null),
    pg_temp.reg('x8', 'c7000000-0000-4000-8000-000000000001', 'vapid', '0a000000-0000-4000-8000-00000000c7e8',
                'https://push.example.test/ep/c7e8', pg_temp.p256('x'), pg_temp.auth('x'))),
  '22023 22023 22023 22023 22023 22023 22023 22023',
  'register: an unknown provider or a shape violation (bad/missing id, id + endpoint, http endpoint, short key, '
  || 'missing auth, vapid with an id) is refused with 22023'
);

select is(
  pg_temp.reg('x9', 'c7000000-0000-4000-8000-000000000005', 'onesignal', '0a000000-0000-4000-8000-00000000c7e9'),
  '42501',
  'register: a user without any membership is refused (42501)'
);

select is(
  concat_ws(' ',
    pg_temp.as_role('authenticated',
      $$select public.register_push_subscription(p_provider => 'onesignal', p_subscription_id => '0a000000-0000-4000-8000-00000000c7ea')::text$$,
      '{"role": "authenticated"}'),
    pg_temp.as_role('authenticated',
      $$select public.unregister_push_subscription(p_all => true)::text$$,
      '{"role": "authenticated"}')),
  '42501 42501',
  'register and unregister without a session (no auth.uid()) are refused (42501)'
);

select is(
  concat_ws(' ',
    pg_temp.as_role('anon',
      $$select public.register_push_subscription(p_provider => 'onesignal', p_subscription_id => '0a000000-0000-4000-8000-00000000c7eb')::text$$),
    pg_temp.as_role('anon', $$select public.unregister_push_subscription(p_all => true)::text$$),
    pg_temp.as_role('anon', $$select public.request_test_push('c7100000-0000-4000-8000-000000000001')::text$$)),
  '42501 42501 42501',
  'anon cannot execute register_push_subscription, unregister_push_subscription or request_test_push'
);

select is(
  pg_temp.reg('u1b', 'c7000000-0000-4000-8000-000000000001', 'onesignal', '0a000000-0000-4000-8000-00000000c711'),
  'ok',
  'register: U1 registers a second phone'
);

select is(
  pg_temp.reg('u1c', 'c7000000-0000-4000-8000-000000000001', 'vapid', null,
              'https://push.example.test/ep/c712', pg_temp.p256('w'), pg_temp.auth('w')),
  'ok',
  'register: U1 registers a VAPID browser'
);

-- ---------------------------------------------------------------------------------------------
-- RLS: a user sees only their own devices and their own preferences; nobody writes directly
-- ---------------------------------------------------------------------------------------------
select is(
  pg_temp.as_role('authenticated',
    $$select string_agg(coalesce(s.subscription_id, s.endpoint), ',' order by coalesce(s.subscription_id, s.endpoint))
      from public.push_subscriptions s$$,
    pg_temp.jwt('c7000000-0000-4000-8000-000000000001')),
  '0a000000-0000-4000-8000-00000000c711,https://push.example.test/ep/c712',
  'RLS: U1 sees exactly their own two devices'
);

select is(
  pg_temp.as_role('authenticated',
    $$select count(*)::text from public.push_subscriptions s
      where s.user_id <> 'c7000000-0000-4000-8000-000000000001'
         or s.subscription_id = '0a000000-0000-4000-8000-00000000c701'$$,
    pg_temp.jwt('c7000000-0000-4000-8000-000000000001')),
  '0',
  'RLS: U1 sees no row of another user, not even the device that moved away from them'
);

select is(
  pg_temp.as_role('authenticated',
    $$select string_agg(coalesce(s.subscription_id, s.endpoint), ',' order by coalesce(s.subscription_id, s.endpoint))
      from public.push_subscriptions s$$,
    pg_temp.jwt('c7000000-0000-4000-8000-000000000003')),
  '0a000000-0000-4000-8000-00000000c703,https://push.example.test/ep/c701',
  'RLS: the manager sees their own devices, including the endpoint that moved to them'
);

select is(
  concat_ws(' ',
    pg_temp.as_role('authenticated',
      $$insert into public.push_subscriptions (user_id, provider, subscription_id)
        values ('c7000000-0000-4000-8000-000000000001', 'onesignal', '0a000000-0000-4000-8000-00000000c7f1')
        returning id::text$$,
      pg_temp.jwt('c7000000-0000-4000-8000-000000000001')),
    pg_temp.as_role('authenticated',
      $$update public.push_subscriptions set user_id = 'c7000000-0000-4000-8000-000000000001'
        where subscription_id = '0a000000-0000-4000-8000-00000000c711' returning id::text$$,
      pg_temp.jwt('c7000000-0000-4000-8000-000000000001')),
    pg_temp.as_role('authenticated',
      $$delete from public.push_subscriptions where subscription_id = '0a000000-0000-4000-8000-00000000c711'
        returning id::text$$,
      pg_temp.jwt('c7000000-0000-4000-8000-000000000001'))),
  '42501 42501 42501',
  'RLS: a user cannot INSERT, UPDATE or DELETE push_subscriptions directly, not even their own rows (RPCs only)'
);

select is(
  concat_ws(' ',
    pg_temp.as_role('anon', 'select count(*)::text from public.push_subscriptions'),
    pg_temp.as_role('service_role', 'select count(*)::text from public.push_subscriptions')),
  '42501 42501',
  'anon and service_role cannot read push_subscriptions'
);

select is(
  pg_temp.as_role('authenticated',
    $$select string_agg(p.business_id::text || ':' || p.user_id::text, ',' order by p.business_id, p.user_id)
      from public.member_notification_prefs p$$,
    pg_temp.jwt('c7000000-0000-4000-8000-000000000001')),
  'c7100000-0000-4000-8000-000000000001:c7000000-0000-4000-8000-000000000001',
  'RLS: U1 reads only their own notification preferences (not those of colleagues)'
);

select is(
  pg_temp.as_role('authenticated',
    $$select string_agg(p.business_id::text || ':' || p.user_id::text, ',' order by p.business_id, p.user_id)
      from public.member_notification_prefs p$$,
    pg_temp.jwt('c7000000-0000-4000-8000-000000000006')),
  'c7100000-0000-4000-8000-000000000001:c7000000-0000-4000-8000-000000000006,'
  || 'c7100000-0000-4000-8000-000000000002:c7000000-0000-4000-8000-000000000006',
  'RLS: a member of two businesses reads their own preferences in both, nobody else''s'
);

select is(
  concat_ws(' ',
    pg_temp.as_role('authenticated',
      $$insert into public.member_notification_prefs (business_id, user_id, push_all)
        values ('c7100000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000003', true)
        returning user_id::text$$,
      pg_temp.jwt('c7000000-0000-4000-8000-000000000003')),
    pg_temp.as_role('authenticated',
      $$update public.member_notification_prefs set push_all = true
        where user_id = 'c7000000-0000-4000-8000-000000000001' returning user_id::text$$,
      pg_temp.jwt('c7000000-0000-4000-8000-000000000001')),
    pg_temp.as_role('authenticated',
      $$delete from public.member_notification_prefs
        where user_id = 'c7000000-0000-4000-8000-000000000001' returning user_id::text$$,
      pg_temp.jwt('c7000000-0000-4000-8000-000000000001'))),
  '42501 42501 42501',
  'member_notification_prefs: no INSERT, UPDATE or DELETE through the API in 1.5 (no UI yet)'
);

-- ---------------------------------------------------------------------------------------------
-- unregister_push_subscription: only the caller's own rows; p_all = every own row
-- ---------------------------------------------------------------------------------------------
select set_config('t.un1', concat_ws(' ',
  pg_temp.unreg('c7000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-00000000c701'),
  pg_temp.unreg('c7000000-0000-4000-8000-000000000001', null, 'https://push.example.test/ep/c701')), true);

select is(
  concat_ws(' ', current_setting('t.un1'),
            pg_temp.rows_of('c7000000-0000-4000-8000-000000000002'),
            pg_temp.rows_of('c7000000-0000-4000-8000-000000000003')),
  '0 0 0a000000-0000-4000-8000-00000000c701 0a000000-0000-4000-8000-00000000c703,https://push.example.test/ep/c701',
  'unregister: another user''s device (by OneSignal id or by endpoint) is not deleted (0 rows)'
);

select is(
  concat_ws(' ',
    pg_temp.unreg('c7000000-0000-4000-8000-000000000001', null, null, false),
    pg_temp.unreg('c7000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-00000000c711',
                  'https://push.example.test/ep/c712', false)),
  '22023 22023',
  'unregister: without p_all exactly one of the two keys is required (22023)'
);

select is(
  pg_temp.unreg('c7000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-00000000c7ff'),
  '0',
  'unregister: an unknown device is not an error (0 rows)'
);

select set_config('t.un2', pg_temp.unreg('c7000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-00000000c711'), true);

select is(
  current_setting('t.un2') || ' ' || pg_temp.rows_of('c7000000-0000-4000-8000-000000000001'),
  '1 https://push.example.test/ep/c712',
  'unregister: the caller''s own device is deleted (1 row) and their other device stays'
);

select set_config('t.un3', pg_temp.unreg('c7000000-0000-4000-8000-000000000005', '0a000000-0000-4000-8000-00000000c705'), true);

select is(
  current_setting('t.un3') || ' ' || pg_temp.rows_of('c7000000-0000-4000-8000-000000000005'),
  '1 -',
  'unregister: needs a session only, no membership (a former member can still clean up their device)'
);

-- ---------------------------------------------------------------------------------------------
-- Deletion on membership changes (D13): a trigger on business_members drops ALL devices of the
-- user on every delete of one of their memberships and on every change of role. Until 1.7 the
-- changes are made as postgres and, while 0001 allows it, by an owner in aal2 through the API.
-- 1.7: remove_member / set_member_role write the same table and inherit the trigger;
-- revoke_user_sessions_impl calls private.drop_push_subscriptions.
-- ---------------------------------------------------------------------------------------------
select has_trigger('public', 'business_members', 'business_members_drop_push',
  'business_members has the trigger business_members_drop_push');

select set_config('t.o2', pg_temp.others('c7000000-0000-4000-8000-000000000002'), true);

delete from public.business_members
where business_id = 'c7100000-0000-4000-8000-000000000001' and user_id = 'c7000000-0000-4000-8000-000000000002';

select is(
  concat_ws(' ', pg_temp.rows_of('c7000000-0000-4000-8000-000000000002'),
            pg_temp.others('c7000000-0000-4000-8000-000000000002') = current_setting('t.o2')),
  '- t',
  'deletion: removing a user from their last business deletes every device of that user and no one else''s'
);

select set_config('t.o3', pg_temp.others('c7000000-0000-4000-8000-000000000003'), true);

update public.business_members set role = 'staff'
where business_id = 'c7100000-0000-4000-8000-000000000001' and user_id = 'c7000000-0000-4000-8000-000000000003';

select is(
  concat_ws(' ', pg_temp.rows_of('c7000000-0000-4000-8000-000000000003'),
            pg_temp.others('c7000000-0000-4000-8000-000000000003') = current_setting('t.o3')),
  '- t',
  'deletion: a change of role (manager → staff) deletes both devices of that user and no one else''s'
);

select set_config('t.o6', pg_temp.others('c7000000-0000-4000-8000-000000000006'), true);

delete from public.business_members
where business_id = 'c7100000-0000-4000-8000-000000000002' and user_id = 'c7000000-0000-4000-8000-000000000006';

select is(
  concat_ws(' ', pg_temp.rows_of('c7000000-0000-4000-8000-000000000006'),
            pg_temp.others('c7000000-0000-4000-8000-000000000006') = current_setting('t.o6'),
            exists (select 1 from public.business_members m
                    where m.user_id = 'c7000000-0000-4000-8000-000000000006'
                      and m.business_id = 'c7100000-0000-4000-8000-000000000001')),
  '- t t',
  'deletion: leaving one of two businesses also deletes every device of the user (D13), who stays a member of the other'
);

update public.business_members set staff_id = null
where business_id = 'c7100000-0000-4000-8000-000000000001' and user_id = 'c7000000-0000-4000-8000-000000000001';
update public.business_members set role = role
where business_id = 'c7100000-0000-4000-8000-000000000001' and user_id = 'c7000000-0000-4000-8000-000000000001';

select is(
  pg_temp.rows_of('c7000000-0000-4000-8000-000000000001'),
  'https://push.example.test/ep/c712',
  'deletion: a change of staff_id, or an UPDATE that leaves the role as it was, keeps the devices'
);

select set_config('t.o7', pg_temp.others('c7000000-0000-4000-8000-000000000007'), true);

select is(
  pg_temp.as_role('authenticated',
    $$delete from public.business_members
      where business_id = 'c7100000-0000-4000-8000-000000000001' and user_id = 'c7000000-0000-4000-8000-000000000007'
      returning user_id::text$$,
    pg_temp.jwt('c7000000-0000-4000-8000-000000000001', 'aal2')),
  '42501',
  'deletion: not even the owner (aal2) deletes a membership through the table API since 0009 (members change through RPCs)'
);

-- The removal goes through remove_member_impl as that owner with a fresh code (the window is set
-- explicitly; the seed's 10 s must not decide this file). U1 has no factor row, so D2 of 1.7 does
-- not hide the membership.
update private.platform_settings set fresh_totp_max_age_seconds = 300 where id;

select set_config('t.rm7', pg_temp.as_role('authenticated',
    $$select (private.remove_member_impl(p_business_id => 'c7100000-0000-4000-8000-000000000001',
                                         p_user_id => 'c7000000-0000-4000-8000-000000000007')->>'removed')$$,
    json_build_object('sub', 'c7000000-0000-4000-8000-000000000001', 'role', 'authenticated', 'aal', 'aal2',
                      'amr', json_build_array(
                        json_build_object('method', 'otp', 'timestamp', floor(extract(epoch from now()))::bigint - 120),
                        json_build_object('method', 'totp', 'timestamp', floor(extract(epoch from now()))::bigint - 60)))::text),
  true);

select is(
  concat_ws(' ', current_setting('t.rm7'), pg_temp.rows_of('c7000000-0000-4000-8000-000000000007'),
            pg_temp.others('c7000000-0000-4000-8000-000000000007') = current_setting('t.o7')),
  'true - t',
  'deletion: remove_member (owner with a fresh code) deletes the removed user''s devices too, nobody else''s (DB-level guarantee)'
);

select set_config('t.o4', pg_temp.others('c7000000-0000-4000-8000-000000000004'), true);
select set_config('t.d4', private.drop_push_subscriptions('c7000000-0000-4000-8000-000000000004')::text, true);

select is(
  concat_ws(' ', current_setting('t.d4'), pg_temp.rows_of('c7000000-0000-4000-8000-000000000004'),
            pg_temp.others('c7000000-0000-4000-8000-000000000004') = current_setting('t.o4')),
  '1 - t',
  'private.drop_push_subscriptions (for 1.7''s revoke_user_sessions_impl) returns the count and deletes only that user''s rows'
);

select is(
  pg_temp.reg('u1d', 'c7000000-0000-4000-8000-000000000001', 'onesignal', '0a000000-0000-4000-8000-00000000c713'),
  'ok',
  'register: U1 registers one more phone'
);

select set_config('t.o1', pg_temp.others('c7000000-0000-4000-8000-000000000001'), true);
select set_config('t.un4', pg_temp.unreg('c7000000-0000-4000-8000-000000000001', null, null, true), true);

select is(
  concat_ws(' ', current_setting('t.un4'), pg_temp.rows_of('c7000000-0000-4000-8000-000000000001'),
            pg_temp.others('c7000000-0000-4000-8000-000000000001') = current_setting('t.o1')),
  '2 - t',
  'unregister p_all («sign out of all devices», 1.7): every device of the caller goes, nobody else''s'
);

select * from finish();
rollback;
