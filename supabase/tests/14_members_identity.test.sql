-- Security and members (phase-1 plan 1.7 «Tests», contract docs/plans/contracts/1.7-security-members.md
-- §2 and §7.1; ADR-0009; C6). Written from the plan and the contract only (independent author).
--   1. the window setting and the freshness parser (private.has_fresh_totp / require_fresh_totp)
--   2. the fresh-code matrix of every critical _impl (and each wrapper once)
--   3. change_business_identity: roles, slug → alias resolved by the catalogue, aliases never move,
--      time zone / currency refused while an appointment is ahead or in progress
--   4. authorize_factor_change: staff never, first enrolment without a code, freshness, the last
--      factor (pending removals count), grants of 10′ and audit rows per business
--   5. the service_role-only RPCs: record_support_action, user_id_for_email, revoke_user_sessions,
--      add_member
--   6. list_members
--   7. can_manage_members, set_member_role, remove_member: roles, freshness, last owner, promotion and
--      removal of owners, sessions, refresh tokens and push devices of the target (1.5 carried)
--   8. factors on a demotion or removal (D1: one trigger, also for a direct delete as postgres)
--   9. D2: an owner/manager with a verified factor counts as a member only at aal2
--  10. private.factor_change_grants is closed to every API role
-- Review fixes (contract 1.7 §10): the order membership → role → fresh code is pinned with callers
-- whose code is old, missing or aal1 (section 2); a booking holds KEY SHARE on the business row
-- before it validates under the zone (section 3); add_member never attaches a member of another
-- business (AN031, section 5); list_members reports a sign-in only since joining (section 6); D2
-- also covers the push devices (section 9).
-- Conventions:
--   · Claims are built relative to now() of the transaction (pg_temp.claims); the window is set
--     explicitly to 300 s (the local seed has 10 s, a remote database 300 s).
--   · Every call goes through pg_temp.q: role and claims are set for that one statement and reset
--     afterwards; the declared actor is '' during the call and 'system' otherwise (fixtures).
--   · Outcomes: the value, '<null>', the SQLSTATE, '42501/<hint>' when a 42501 carries a hint, or
--     'P0001/<AN code>' for a domain error. A stored result is never read in the statement that
--     writes it. concat_ws prints booleans as t/f.
--   · Factors, sessions (one refresh token each) and push devices are synthetic rows written as
--     postgres; no real secret is read anywhere.
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
-- Fixture appointments are written by the system; pg_temp.q declares '' around every member call.
select set_config('anaklo.actor_type', 'system', true);
select plan(119);

-- The window of C6, explicitly (section 2 moves it to 0 and back).
update private.platform_settings set fresh_totp_max_age_seconds = 300 where id;

-- ---------------------------------------------------------------------------------------------
-- Labels
-- ---------------------------------------------------------------------------------------------
create temporary table lbl (id uuid primary key, label text not null unique);

insert into pg_temp.lbl (id, label) values
  -- users
  ('e1400000-0000-4000-8000-000000000001', 'O'),
  ('e1400000-0000-4000-8000-000000000002', 'O2'),
  ('e1400000-0000-4000-8000-000000000003', 'M'),
  ('e1400000-0000-4000-8000-000000000004', 'S'),
  ('e1400000-0000-4000-8000-000000000005', 'X'),
  ('e1400000-0000-4000-8000-000000000006', 'MM'),
  ('e1400000-0000-4000-8000-000000000007', 'MS'),
  ('e1400000-0000-4000-8000-000000000008', 'MR'),
  ('e1400000-0000-4000-8000-000000000009', 'MK'),
  ('e1400000-0000-4000-8000-00000000000a', 'PD'),
  ('e1400000-0000-4000-8000-00000000000b', 'F'),
  ('e1400000-0000-4000-8000-00000000000c', 'K'),
  ('e1400000-0000-4000-8000-00000000000d', 'TA'),
  ('e1400000-0000-4000-8000-00000000000e', 'TB'),
  ('e1400000-0000-4000-8000-00000000000f', 'R1'),
  ('e1400000-0000-4000-8000-000000000010', 'R2'),
  ('e1400000-0000-4000-8000-000000000011', 'N1'),
  ('e1400000-0000-4000-8000-000000000012', 'N2'),
  ('e1400000-0000-4000-8000-0000000000ff', 'NOBODY'),   -- never inserted: an unknown user / factor id
  -- businesses
  ('e1410000-0000-4000-8000-000000000001', 'B1'),
  ('e1410000-0000-4000-8000-000000000002', 'B2'),
  ('e1410000-0000-4000-8000-000000000003', 'B3'),       -- section 3 only: a business with no child rows
  ('e1410000-0000-4000-8000-0000000000ff', 'NOSHOP'),   -- never inserted
  -- staff rows
  ('e1420000-0000-4000-8000-000000000001', 'SS'),
  ('e1420000-0000-4000-8000-000000000002', 'SN'),
  ('e1420000-0000-4000-8000-000000000003', 'SX'),
  -- factors (.v verified, .u unverified)
  ('e1430000-0000-4000-8000-000000000001', 'M.v'),
  ('e1430000-0000-4000-8000-000000000002', 'M.u'),
  ('e1430000-0000-4000-8000-000000000003', 'MM.v'),
  ('e1430000-0000-4000-8000-000000000004', 'MM.u'),
  ('e1430000-0000-4000-8000-000000000005', 'MS.v'),
  ('e1430000-0000-4000-8000-000000000006', 'MR.v'),
  ('e1430000-0000-4000-8000-000000000007', 'MK.v'),
  ('e1430000-0000-4000-8000-000000000008', 'PD.v'),
  ('e1430000-0000-4000-8000-000000000009', 'F.v'),
  ('e1430000-0000-4000-8000-00000000000a', 'F.u'),
  ('e1430000-0000-4000-8000-00000000000b', 'K.v1'),
  ('e1430000-0000-4000-8000-00000000000c', 'K.v2'),
  ('e1430000-0000-4000-8000-00000000000d', 'O.u'),
  ('e1430000-0000-4000-8000-00000000000e', 'O.v'),
  -- appointments
  ('e1450000-0000-4000-8000-000000000001', 'E1'),
  ('e1450000-0000-4000-8000-000000000002', 'E2'),
  ('e1450000-0000-4000-8000-000000000003', 'E3');

-- ---------------------------------------------------------------------------------------------
-- Helpers (pg_temp)
-- ---------------------------------------------------------------------------------------------
create function pg_temp.id(a_label text)
returns uuid
language sql
stable
as $fn$
  select x.id from pg_temp.lbl x where x.label = a_label;
$fn$;

create function pg_temp.l(a_id uuid)
returns text
language sql
stable
as $fn$
  select case when a_id is null then '-'
              else coalesce((select x.label from pg_temp.lbl x where x.id = a_id), a_id::text) end;
$fn$;

-- The label of an id given as text (answers of RPCs), the text itself otherwise.
create function pg_temp.lt(a_text text)
returns text
language sql
stable
as $fn$
  select case when a_text is null then '<null>'
              else coalesce((select x.label from pg_temp.lbl x where x.id::text = lower(a_text)), a_text) end;
$fn$;

-- Replaces {LABEL} in a statement with the quoted uuid of that label.
create function pg_temp.fill(a_template text)
returns text
language plpgsql
stable
as $fn$
declare
  v text := a_template;
  x record;
begin
  for x in select y.id, y.label from pg_temp.lbl y loop
    v := replace(v, '{' || x.label || '}', quote_literal(x.id::text) || '::uuid');
  end loop;
  return v;
end;
$fn$;

-- Whole epoch seconds a_seconds before now() of the transaction (negative = ahead).
create function pg_temp.ago(a_seconds integer)
returns bigint
language sql
stable
as $fn$
  select floor(extract(epoch from now()))::bigint - a_seconds;
$fn$;

-- amr after the email code only (aal1, or aal2 without an authenticator code)
create function pg_temp.amr_otp()
returns jsonb
language sql
stable
as $fn$
  select jsonb_build_array(jsonb_build_object('method', 'otp', 'timestamp', pg_temp.ago(0)));
$fn$;

-- amr after an authenticator code a_age seconds ago (totp first, as after a second verify)
create function pg_temp.amr_totp(a_age integer)
returns jsonb
language sql
stable
as $fn$
  select jsonb_build_array(
    jsonb_build_object('method', 'totp', 'timestamp', pg_temp.ago(a_age)),
    jsonb_build_object('method', 'otp', 'timestamp', pg_temp.ago(3600)));
$fn$;

-- JWT claims of a labelled user; a null aal or amr leaves the key out.
create function pg_temp.claims(a_user text, a_aal text, a_amr jsonb)
returns text
language sql
stable
as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    'sub', pg_temp.id(a_user), 'role', 'authenticated', 'aal', a_aal, 'amr', a_amr))::text;
$fn$;

create function pg_temp.aal1(a_user text) returns text language sql stable as $fn$
  select pg_temp.claims(a_user, 'aal1', pg_temp.amr_otp());
$fn$;

-- aal2 with an authenticator code 1 minute old (fresh under a 300 s window)
create function pg_temp.fresh(a_user text) returns text language sql stable as $fn$
  select pg_temp.claims(a_user, 'aal2', pg_temp.amr_totp(60));
$fn$;

-- aal2 with an authenticator code 6 minutes old
create function pg_temp.stale(a_user text) returns text language sql stable as $fn$
  select pg_temp.claims(a_user, 'aal2', pg_temp.amr_totp(360));
$fn$;

-- aal2 whose amr holds only the email code
create function pg_temp.otp2(a_user text) returns text language sql stable as $fn$
  select pg_temp.claims(a_user, 'aal2', pg_temp.amr_otp());
$fn$;

-- Runs one statement ({LABEL}s filled in) as a_role with a_claims; returns its single value,
-- '<null>', or the error (see the header). Role, claims and actor are reset afterwards. Without
-- claims, anon and service_role get the claims PostgREST would give them (a role, no sub).
create function pg_temp.q(a_sql text, a_claims text default '', a_role text default 'authenticated')
returns text
language plpgsql
as $fn$
declare
  v_sql text := pg_temp.fill(a_sql);
  v_claims text := case when coalesce(a_claims, '') = '' and a_role in ('anon', 'service_role')
                        then json_build_object('role', a_role)::text
                        else coalesce(a_claims, '') end;
  v text;
  v_state text;
  v_msg text;
  v_hint text;
begin
  perform set_config('anaklo.actor_type', '', true);
  begin
    perform set_config('request.jwt.claims', v_claims, true);
    execute format('set local role %I', a_role);
    execute v_sql into v;
    v := coalesce(v, '<null>');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    -- A missing table privilege carries the server's own advice ("Grant the required privileges
    -- to the current role with: GRANT …", Supabase's Postgres 17); that is not a hint of ours and is
    -- reported as the bare code. Every other 42501 hint is reported, so a stray hint still fails.
    v := case
      when v_state = 'P0001' then 'P0001/' || v_msg
      when v_state = '42501' and coalesce(v_hint, '') <> ''
           and v_hint not like 'Grant the required privileges to the current role with: GRANT %'
        then '42501/' || v_hint
      else v_state
    end;
  end;
  execute 'set local role postgres';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('anaklo.actor_type', 'system', true);
  return v;
end;
$fn$;

-- Keeps a JSON answer in t.<a_key> and returns 'ok'; any other outcome is returned as is.
create function pg_temp.keep(a_key text, a_outcome text)
returns text
language plpgsql
as $fn$
begin
  if left(a_outcome, 1) in ('{', '[') then
    perform set_config('t.' || a_key, a_outcome, true);
    return 'ok';
  end if;
  perform set_config('t.' || a_key, '', true);
  return a_outcome;
end;
$fn$;

create function pg_temp.r(a_key text)
returns jsonb
language sql
stable
as $fn$
  select nullif(current_setting('t.' || a_key, true), '')::jsonb;
$fn$;

-- The refusal matrix of a critical _impl (plan 1.7 «Tests»): a_user at aal1, with a 6-minute-old
-- code, with the email code only, with a current code under window 0, then a staff member with a
-- current code. The window is 300 before and after.
create function pg_temp.refusals(a_sql text, a_user text, a_staff text)
returns text
language plpgsql
as $fn$
declare
  v text[] := array[]::text[];
begin
  v := v || pg_temp.q(a_sql, pg_temp.aal1(a_user));
  v := v || pg_temp.q(a_sql, pg_temp.stale(a_user));
  v := v || pg_temp.q(a_sql, pg_temp.otp2(a_user));
  update private.platform_settings set fresh_totp_max_age_seconds = 0 where id;
  v := v || pg_temp.q(a_sql, pg_temp.claims(a_user, 'aal2', pg_temp.amr_totp(0)));
  update private.platform_settings set fresh_totp_max_age_seconds = 300 where id;
  v := v || pg_temp.q(a_sql, pg_temp.fresh(a_staff));
  return array_to_string(v, ' ');
end;
$fn$;

-- Callers who may not act, whatever the state of their code: staff of B1 at aal1, M (manager of B1,
-- verified factor) with an old code and with the email code only at aal2, X (owner of B2, no factor)
-- with an old code and at aal1. Membership and role are checked before the fresh code, so each gets
-- the bare 42501, never a step-up hint (plan 1.7: «42501 χωρίς hint»; the PWA must not open the
-- code sheet for an action the user may not do).
create function pg_temp.not_allowed(a_sql text)
returns text
language plpgsql
as $fn$
begin
  return concat_ws(' ',
    pg_temp.q(a_sql, pg_temp.aal1('S')),
    pg_temp.q(a_sql, pg_temp.stale('M')),
    pg_temp.q(a_sql, pg_temp.otp2('M')),
    pg_temp.q(a_sql, pg_temp.stale('X')),
    pg_temp.q(a_sql, pg_temp.aal1('X')));
end;
$fn$;

-- Wrappers by label (null label → NULL argument).
create function pg_temp.cmm(a_business text, a_claims text)
returns text language sql as $fn$
  select pg_temp.q(format('select public.can_manage_members(p_business_id => %L::uuid)::text',
                          pg_temp.id(a_business)), a_claims);
$fn$;

create function pg_temp.smr(a_business text, a_user text, a_role text, a_claims text)
returns text language sql as $fn$
  select pg_temp.q(format(
    'select public.set_member_role(p_business_id => %L::uuid, p_user_id => %L::uuid, p_role => %L)::text',
    pg_temp.id(a_business), pg_temp.id(a_user), a_role), a_claims);
$fn$;

create function pg_temp.rmm(a_business text, a_user text, a_claims text)
returns text language sql as $fn$
  select pg_temp.q(format(
    'select public.remove_member(p_business_id => %L::uuid, p_user_id => %L::uuid)::text',
    pg_temp.id(a_business), pg_temp.id(a_user)), a_claims);
$fn$;

create function pg_temp.cbi(a_business text, a_slug text, a_timezone text, a_currency text, a_claims text)
returns text language sql as $fn$
  select pg_temp.q(format(
    'select public.change_business_identity(p_business_id => %L::uuid, p_slug => %L, p_timezone => %L, '
    || 'p_currency => %L)::text',
    pg_temp.id(a_business), a_slug, a_timezone, a_currency), a_claims);
$fn$;

create function pg_temp.afc(a_action text, a_factor text, a_claims text)
returns text language sql as $fn$
  select pg_temp.q(format(
    'select public.authorize_factor_change(p_action => %L, p_factor_id => %L::uuid)::text',
    a_action, pg_temp.id(a_factor)), a_claims);
$fn$;

create function pg_temp.support(a_action text, a_reason text, a_ticket text, a_user text, a_business text)
returns text language sql as $fn$
  select pg_temp.q(format(
    'select public.record_support_action(p_action => %L, p_reason => %L, p_ticket => %L, p_user_id => %L::uuid, '
    || 'p_business_id => %L::uuid)::text',
    a_action, a_reason, a_ticket, pg_temp.id(a_user), pg_temp.id(a_business)), '', 'service_role');
$fn$;

create function pg_temp.add_m(a_business text, a_user text, a_role text, a_staff text, a_actor text)
returns text language sql as $fn$
  select pg_temp.q(format(
    'select public.add_member(p_business_id => %L::uuid, p_user_id => %L::uuid, p_role => %L, '
    || 'p_staff_id => %L::uuid, p_actor_id => %L::uuid)::text',
    pg_temp.id(a_business), pg_temp.id(a_user), a_role, pg_temp.id(a_staff), pg_temp.id(a_actor)), '', 'service_role');
$fn$;

-- Fingerprint of everything a refused call must leave alone.
create function pg_temp.state()
returns text
language sql
as $fn$
  select md5(concat_ws('|',
    (select string_agg(concat_ws(':', m.business_id, m.user_id, m.role, m.staff_id), ',' order by m.business_id, m.user_id)
     from public.business_members m),
    (select string_agg(concat_ws(':', b.id, b.slug, b.timezone, b.currency, b.vertical), ',' order by b.id)
     from public.businesses b),
    (select count(*) from public.business_slug_aliases),
    (select count(*) from public.audit_log),
    (select count(*) from private.factor_change_grants),
    (select count(*) from auth.sessions),
    (select count(*) from auth.refresh_tokens),
    (select count(*) from auth.mfa_factors),
    (select count(*) from public.push_subscriptions)));
$fn$;

-- Fingerprint of the sessions, refresh tokens, push devices and factors of everyone except a_user.
create function pg_temp.others_fp(a_user text)
returns text
language sql
as $fn$
  select md5(concat_ws('|',
    (select string_agg(s.id::text, ',' order by s.id) from auth.sessions s where s.user_id <> pg_temp.id(a_user)),
    (select string_agg(t.id::text, ',' order by t.id) from auth.refresh_tokens t
     where t.user_id is distinct from pg_temp.id(a_user)::text),
    (select string_agg(p.id::text, ',' order by p.id) from public.push_subscriptions p where p.user_id <> pg_temp.id(a_user)),
    (select string_agg(f.id::text, ',' order by f.id) from auth.mfa_factors f where f.user_id <> pg_temp.id(a_user))));
$fn$;

create function pg_temp.role_in(a_business text, a_user text)
returns text language sql as $fn$
  select coalesce((select m.role from public.business_members m
                   where m.business_id = pg_temp.id(a_business) and m.user_id = pg_temp.id(a_user)), '-');
$fn$;

create function pg_temp.sessions_of(a_user text)
returns bigint language sql as $fn$
  select count(*) from auth.sessions s where s.user_id = pg_temp.id(a_user);
$fn$;

create function pg_temp.tokens_of(a_user text)
returns bigint language sql as $fn$
  select count(*) from auth.refresh_tokens t where t.user_id = pg_temp.id(a_user)::text;
$fn$;

create function pg_temp.push_of(a_user text)
returns bigint language sql as $fn$
  select count(*) from public.push_subscriptions p where p.user_id = pg_temp.id(a_user);
$fn$;

create function pg_temp.factors_of(a_user text)
returns bigint language sql as $fn$
  select count(*) from auth.mfa_factors f where f.user_id = pg_temp.id(a_user);
$fn$;

-- The grants of a user from one source: 'action:factor' sorted; '-' for none.
create function pg_temp.grants_of(a_user text, a_source text)
returns text language sql as $fn$
  select coalesce(string_agg(g.action || ':' || pg_temp.l(g.factor_id), ',' order by g.action, pg_temp.l(g.factor_id)), '-')
  from private.factor_change_grants g
  where g.user_id = pg_temp.id(a_user) and g.source = a_source;
$fn$;

-- Every grant of that user and source was written now, expires 10′ later and is unmatched.
create function pg_temp.grants_ok(a_user text, a_source text)
returns boolean language sql as $fn$
  select coalesce(bool_and(g.created_at = now() and g.expires_at = g.created_at + interval '10 minutes'
                           and g.matched_at is null), false)
  from private.factor_change_grants g
  where g.user_id = pg_temp.id(a_user) and g.source = a_source;
$fn$;

-- Audit rows of one action (optionally of one entity and/or actor):
-- 'business:actor_type:actor:entity:entity_id:reason', by business then id; '-' for none.
create function pg_temp.audit(a_action text, a_entity text default null, a_actor text default null)
returns text language sql as $fn$
  select coalesce(string_agg(concat_ws(':', pg_temp.l(a.business_id), a.actor_type, pg_temp.l(a.actor_id), a.entity,
                                       pg_temp.l(a.entity_id), coalesce(a.reason, '-')),
                             ',' order by pg_temp.l(a.business_id), a.id), '-')
  from public.audit_log a
  where a.action = a_action
    and (a_entity is null or a.entity_id = pg_temp.id(a_entity))
    and (a_actor is null or a.actor_id = pg_temp.id(a_actor));
$fn$;

create function pg_temp.aliases_of(a_business text)
returns text language sql as $fn$
  select coalesce(string_agg(a.slug, ',' order by a.slug), '-')
  from public.business_slug_aliases a where a.business_id = pg_temp.id(a_business);
$fn$;

create function pg_temp.slug_of(a_business text)
returns text language sql as $fn$
  select b.slug from public.businesses b where b.id = pg_temp.id(a_business);
$fn$;

-- ---------------------------------------------------------------------------------------------
-- Fixture (as postgres)
--   B1 'members14-a' (Europe/Athens, EUR, booking on):
--     O owner (no factor) · O2 staff · M manager (M.v, M.u) · S staff (staff row SS) · MM manager
--     · MS manager · MR manager · MK manager · K manager (K.v1, K.v2) · TA, TB staff (matrix targets)
--     · R1, R2 staff (targets with two sessions each)
--   B2 'members14-x' (booking off): X owner · MM owner (MM.v, MM.u) · MS staff (MS.v) · MK manager (MK.v)
--     · PD manager (PD.v) · F manager (F.v, F.u)
--   N1, N2: users without membership (add_member). Staff rows SS, SN (B1, SN unlinked), SX (B2).
--   Sessions (one refresh token each): O 1 · S 1 · X 2 · M 1 · R1 2 · R2 2 · PD 1 · MM 1 · MK 1 · N1 1.
--   Push devices: O 1 · S 1 · X 1 · R1 2 · R2 1.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select x.id, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated',
       lower(x.label) || '@members14.test', '{}'::jsonb, '{}'::jsonb, now(), now()
from pg_temp.lbl x
where x.id::text like 'e1400000-%' and x.label <> 'NOBODY';

insert into public.businesses (id, slug, name, vertical, timezone, booking_enabled) values
  (pg_temp.id('B1'), 'members14-a', 'Members 14 A', 'barber', 'Europe/Athens', true),
  (pg_temp.id('B2'), 'members14-x', 'Members 14 X', 'barber', 'Europe/Athens', false);

insert into public.staff (id, business_id, display_name) values
  (pg_temp.id('SS'), pg_temp.id('B1'), 'Staff S'),
  (pg_temp.id('SN'), pg_temp.id('B1'), 'Staff N'),
  (pg_temp.id('SX'), pg_temp.id('B2'), 'Staff X');

insert into public.business_members (business_id, user_id, role, staff_id)
select pg_temp.id(m.b), pg_temp.id(m.u), m.role, pg_temp.id(m.s)
from (values
  ('B1', 'O', 'owner', null), ('B1', 'O2', 'staff', null), ('B1', 'M', 'manager', null),
  ('B1', 'S', 'staff', 'SS'), ('B1', 'MM', 'manager', null), ('B1', 'MS', 'manager', null),
  ('B1', 'MR', 'manager', null), ('B1', 'MK', 'manager', null), ('B1', 'K', 'manager', null),
  ('B1', 'TA', 'staff', null), ('B1', 'TB', 'staff', null), ('B1', 'R1', 'staff', null),
  ('B1', 'R2', 'staff', null),
  ('B2', 'X', 'owner', null), ('B2', 'MM', 'owner', null), ('B2', 'MS', 'staff', null),
  ('B2', 'MK', 'manager', null), ('B2', 'PD', 'manager', null), ('B2', 'F', 'manager', null)
) as m (b, u, role, s);

insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
  (pg_temp.id('M.v'), pg_temp.id('M'), 'M phone', 'totp', 'verified', now() - interval '3 days', now() - interval '3 days', 'PGTAPSYNTHETICSECRETM1'),
  (pg_temp.id('M.u'), pg_temp.id('M'), 'M tablet', 'totp', 'unverified', now() - interval '1 day', now() - interval '1 day', 'PGTAPSYNTHETICSECRETM2'),
  (pg_temp.id('MM.v'), pg_temp.id('MM'), 'MM phone', 'totp', 'verified', now() - interval '3 days', now() - interval '3 days', 'PGTAPSYNTHETICSECRETMM1'),
  (pg_temp.id('MM.u'), pg_temp.id('MM'), 'MM tablet', 'totp', 'unverified', now() - interval '1 day', now() - interval '1 day', 'PGTAPSYNTHETICSECRETMM2'),
  (pg_temp.id('MS.v'), pg_temp.id('MS'), 'MS phone', 'totp', 'verified', now() - interval '3 days', now() - interval '3 days', 'PGTAPSYNTHETICSECRETMS1'),
  (pg_temp.id('MR.v'), pg_temp.id('MR'), 'MR phone', 'totp', 'verified', now() - interval '3 days', now() - interval '3 days', 'PGTAPSYNTHETICSECRETMR1'),
  (pg_temp.id('MK.v'), pg_temp.id('MK'), 'MK phone', 'totp', 'verified', now() - interval '3 days', now() - interval '3 days', 'PGTAPSYNTHETICSECRETMK1'),
  (pg_temp.id('PD.v'), pg_temp.id('PD'), 'PD phone', 'totp', 'verified', now() - interval '3 days', now() - interval '3 days', 'PGTAPSYNTHETICSECRETPD1'),
  (pg_temp.id('F.v'), pg_temp.id('F'), 'F phone', 'totp', 'verified', now() - interval '3 days', now() - interval '3 days', 'PGTAPSYNTHETICSECRETF1'),
  (pg_temp.id('F.u'), pg_temp.id('F'), 'F tablet', 'totp', 'unverified', now() - interval '1 day', now() - interval '1 day', 'PGTAPSYNTHETICSECRETF2'),
  (pg_temp.id('K.v1'), pg_temp.id('K'), 'K phone', 'totp', 'verified', now() - interval '3 days', now() - interval '3 days', 'PGTAPSYNTHETICSECRETK1'),
  (pg_temp.id('K.v2'), pg_temp.id('K'), 'K tablet', 'totp', 'verified', now() - interval '2 days', now() - interval '2 days', 'PGTAPSYNTHETICSECRETK2');

insert into auth.sessions (id, user_id, created_at, updated_at) values
  ('e1440000-0000-4000-8000-000000000001', pg_temp.id('O'), now() - interval '1 hour', now() - interval '1 hour'),
  ('e1440000-0000-4000-8000-000000000002', pg_temp.id('S'), now() - interval '1 hour', now() - interval '1 hour'),
  ('e1440000-0000-4000-8000-000000000003', pg_temp.id('X'), now() - interval '1 hour', now() - interval '1 hour'),
  ('e1440000-0000-4000-8000-000000000004', pg_temp.id('X'), now() - interval '2 hours', now() - interval '2 hours'),
  ('e1440000-0000-4000-8000-000000000005', pg_temp.id('M'), now() - interval '1 hour', now() - interval '1 hour'),
  ('e1440000-0000-4000-8000-000000000006', pg_temp.id('R1'), now() - interval '1 hour', now() - interval '1 hour'),
  ('e1440000-0000-4000-8000-000000000007', pg_temp.id('R1'), now() - interval '2 hours', now() - interval '2 hours'),
  ('e1440000-0000-4000-8000-000000000008', pg_temp.id('R2'), now() - interval '1 hour', now() - interval '1 hour'),
  ('e1440000-0000-4000-8000-000000000009', pg_temp.id('R2'), now() - interval '2 hours', now() - interval '2 hours'),
  ('e1440000-0000-4000-8000-00000000000a', pg_temp.id('PD'), now() - interval '1 hour', now() - interval '1 hour'),
  ('e1440000-0000-4000-8000-00000000000b', pg_temp.id('MM'), now() - interval '1 hour', now() - interval '1 hour'),
  ('e1440000-0000-4000-8000-00000000000c', pg_temp.id('MK'), now() - interval '1 hour', now() - interval '1 hour'),
  ('e1440000-0000-4000-8000-00000000000d', pg_temp.id('N1'), now() - interval '1 hour', now() - interval '1 hour');

-- Explicit ids: the fixture never draws from the sequence of auth.refresh_tokens.
insert into auth.refresh_tokens (id, instance_id, token, user_id, revoked, created_at, updated_at, session_id)
select 9140000000 + row_number() over (order by s.id), '00000000-0000-0000-0000-000000000000'::uuid,
       'members14-rt-' || right(s.id::text, 2), s.user_id::text, false, s.created_at, s.created_at, s.id
from auth.sessions s
where s.id::text like 'e1440000-%';

insert into public.push_subscriptions (user_id, provider, subscription_id, created_at) values
  (pg_temp.id('O'), 'onesignal', '0e140000-0000-4000-8000-000000000001', now() - interval '1 hour'),
  (pg_temp.id('S'), 'onesignal', '0e140000-0000-4000-8000-000000000002', now() - interval '1 hour'),
  (pg_temp.id('X'), 'onesignal', '0e140000-0000-4000-8000-000000000003', now() - interval '1 hour'),
  (pg_temp.id('R1'), 'onesignal', '0e140000-0000-4000-8000-000000000004', now() - interval '1 hour'),
  (pg_temp.id('R1'), 'onesignal', '0e140000-0000-4000-8000-000000000005', now() - interval '1 hour'),
  (pg_temp.id('R2'), 'onesignal', '0e140000-0000-4000-8000-000000000006', now() - interval '1 hour');

-- =============================================================================================
-- 1. The window and the parser (as postgres: no API role may execute these two functions)
-- =============================================================================================
select is(
  concat_ws(' ',
    pg_temp.q('update private.platform_settings set fresh_totp_max_age_seconds = 301 where id '
              || 'returning fresh_totp_max_age_seconds::text', '', 'postgres'),
    pg_temp.q('update private.platform_settings set fresh_totp_max_age_seconds = -1 where id '
              || 'returning fresh_totp_max_age_seconds::text', '', 'postgres'),
    pg_temp.q('update private.platform_settings set fresh_totp_max_age_seconds = 0 where id '
              || 'returning fresh_totp_max_age_seconds::text', '', 'postgres'),
    pg_temp.q('update private.platform_settings set fresh_totp_max_age_seconds = 300 where id '
              || 'returning fresh_totp_max_age_seconds::text', '', 'postgres')),
  '23514 23514 0 300',
  'fresh_totp_max_age_seconds: the CHECK refuses 301 and -1 and accepts 0 and 300 (the setting can only make '
  || 'the rule stricter)'
);

update private.platform_settings set fresh_totp_max_age_seconds = 300 where id;

select is(
  (select concat_ws(' ', c.column_default, c.is_nullable, c.data_type)
   from information_schema.columns c
   where c.table_schema = 'private' and c.table_name = 'platform_settings'
     and c.column_name = 'fresh_totp_max_age_seconds'),
  '300 NO integer',
  'fresh_totp_max_age_seconds is a not-null integer whose default (a fresh row) is 300 seconds'
);

select is(
  concat_ws(' ',
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.claims('O', 'aal2', jsonb_build_array(
      jsonb_build_object('method', 'otp', 'timestamp', pg_temp.ago(3600)),
      jsonb_build_object('method', 'totp', 'timestamp', pg_temp.ago(60)))), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.claims('O', 'aal2', jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', pg_temp.ago(400)),
      jsonb_build_object('method', 'totp', 'timestamp', pg_temp.ago(30)))), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.claims('O', 'aal2', jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', pg_temp.ago(-5)))), 'postgres')),
  'true true true',
  'has_fresh_totp: the totp entry is found by method (otp first, totp second), the newest totp timestamp counts, '
  || 'and one a few seconds ahead of the transaction clock is still fresh (no upper bound)'
);

select is(
  concat_ws(' ',
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.claims('O', 'aal2', jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', pg_temp.ago(0)::text))), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.claims('O', 'aal2', null), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.claims('O', 'aal2',
      jsonb_build_object('method', 'totp', 'timestamp', pg_temp.ago(0))), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.claims('O', 'aal2', '["totp", "otp"]'::jsonb), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.claims('O', null, pg_temp.amr_totp(0)), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.claims('O', 'aal1', pg_temp.amr_totp(0)), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', '', 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.otp2('O'), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.stale('O'), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.claims('O', 'aal2', jsonb_build_array(
      jsonb_build_object('method', 'totp'))), 'postgres')),
  'false false false false false false false false false false',
  'has_fresh_totp is false for: a string timestamp, no amr, an amr that is not an array, string entries, no aal, '
  || 'aal1, no claims at all, an email code only, a code 6 minutes old, a totp entry without timestamp'
);

select is(
  concat_ws(' ',
    pg_temp.q('select ''passed''::text from private.require_fresh_totp()', '', 'postgres'),
    pg_temp.q('select ''passed''::text from private.require_fresh_totp()', pg_temp.aal1('O'), 'postgres'),
    pg_temp.q('select ''passed''::text from private.require_fresh_totp()', pg_temp.otp2('O'), 'postgres'),
    pg_temp.q('select ''passed''::text from private.require_fresh_totp()', pg_temp.stale('O'), 'postgres'),
    pg_temp.q('select ''passed''::text from private.require_fresh_totp()', pg_temp.fresh('O'), 'postgres')),
  '42501/aal2_required 42501/aal2_required 42501/fresh_totp_required 42501/fresh_totp_required passed',
  'require_fresh_totp: no claims or aal1 → 42501 aal2_required; aal2 with an email code only or a 6-minute-old '
  || 'code → 42501 fresh_totp_required; a code 1 minute old passes'
);

-- =============================================================================================
-- 2. The fresh-code matrix of every critical _impl (C6). O has no factor row, so D2 does not hide
--    the membership and the hints come from require_fresh_totp; F (manager of B2) has a verified
--    factor, so its 'add' needs a fresh code. S is staff of B1 only.
-- =============================================================================================
do $do$ begin perform set_config('t.state0', pg_temp.state(), true); end $do$;

select is(
  pg_temp.refusals($$select private.can_manage_members_impl(p_business_id => {B1})::text$$, 'O', 'S'),
  '42501/aal2_required 42501/fresh_totp_required 42501/fresh_totp_required 42501/fresh_totp_required 42501',
  'can_manage_members_impl: aal1 → aal2_required; a 6-minute-old code, an email code only and window 0 → '
  || 'fresh_totp_required; staff with a current code → 42501 without hint'
);

select is(
  pg_temp.refusals($$select private.set_member_role_impl(p_business_id => {B1}, p_user_id => {TA},
                                                         p_role => 'manager')::text$$, 'O', 'S'),
  '42501/aal2_required 42501/fresh_totp_required 42501/fresh_totp_required 42501/fresh_totp_required 42501',
  'set_member_role_impl: the same matrix (aal1, 6-minute-old code, email code only, window 0, staff)'
);

select is(
  pg_temp.refusals($$select private.remove_member_impl(p_business_id => {B1}, p_user_id => {TB})::text$$, 'O', 'S'),
  '42501/aal2_required 42501/fresh_totp_required 42501/fresh_totp_required 42501/fresh_totp_required 42501',
  'remove_member_impl: the same matrix'
);

select is(
  pg_temp.refusals($$select private.change_business_identity_impl(p_business_id => {B1}, p_slug => null,
                                                                  p_timezone => null, p_currency => 'USD')::text$$, 'O', 'S'),
  '42501/aal2_required 42501/fresh_totp_required 42501/fresh_totp_required 42501/fresh_totp_required 42501',
  'change_business_identity_impl: the same matrix'
);

select is(
  pg_temp.refusals($$select private.authorize_factor_change_impl(p_action => 'add', p_factor_id => null)::text$$, 'F', 'S'),
  '42501/aal2_required 42501/fresh_totp_required 42501/fresh_totp_required 42501/fresh_totp_required 42501',
  'authorize_factor_change_impl (add, user with a verified factor): the same matrix; a staff-only user → 42501 '
  || 'without hint'
);

select is(
  concat_ws(' ',
    pg_temp.cmm('B1', pg_temp.aal1('O')),
    pg_temp.smr('B1', 'TA', 'manager', pg_temp.stale('O')),
    pg_temp.rmm('B1', 'TB', pg_temp.otp2('O')),
    pg_temp.cbi('B1', null, null, 'USD', pg_temp.aal1('O')),
    pg_temp.afc('add', null, pg_temp.stale('F'))),
  '42501/aal2_required 42501/fresh_totp_required 42501/fresh_totp_required 42501/aal2_required 42501/fresh_totp_required',
  'each public wrapper, called as authenticated, passes the refusal and its hint through unchanged'
);

select is(
  concat_ws(' | ',
    pg_temp.not_allowed($$select private.can_manage_members_impl(p_business_id => {B1})::text$$),
    pg_temp.not_allowed($$select private.set_member_role_impl(p_business_id => {B1}, p_user_id => {TA},
                                                              p_role => 'manager')::text$$),
    pg_temp.not_allowed($$select private.remove_member_impl(p_business_id => {B1}, p_user_id => {TB})::text$$),
    pg_temp.not_allowed($$select private.change_business_identity_impl(p_business_id => {B1}, p_slug => null,
                                                                       p_timezone => null, p_currency => 'USD')::text$$)),
  '42501 42501 42501 42501 42501 | 42501 42501 42501 42501 42501 | 42501 42501 42501 42501 42501 | '
  || '42501 42501 42501 42501 42501',
  'membership and role come before the fresh code: staff at aal1, a manager with an old code or an email code '
  || 'only, the owner of another business with an old code or at aal1 → 42501 without hint from every critical '
  || '_impl (never a step-up hint for an action the caller may not do)'
);

select is(
  concat_ws(' ',
    pg_temp.afc('add', null, pg_temp.aal1('S')),
    pg_temp.afc('remove', 'F.v', pg_temp.aal1('S')),
    pg_temp.afc('remove', 'F.v', pg_temp.stale('K')),
    pg_temp.afc('remove', 'NOBODY', pg_temp.stale('K')),
    pg_temp.afc('remove', 'F.u', pg_temp.stale('F')),
    pg_temp.afc('remove', 'F.u', pg_temp.aal1('F'))),
  '42501 42501 42501 42501 42501 42501',
  'authorize_factor_change checks before the fresh code: a staff-only user at aal1 (add, remove), another '
  || 'user''s factor or an unknown id with an old code, an own unverified factor with an old code or at aal1 → '
  || '42501 without hint'
);

select is(
  pg_temp.state(),
  current_setting('t.state0'),
  'no refusal of the matrix wrote anything (members, businesses, aliases, audit, grants, sessions, tokens, factors, devices)'
);

select is(
  concat_ws(' ',
    pg_temp.q($$select private.can_manage_members_impl(p_business_id => {B1})::text$$, pg_temp.fresh('O')),
    pg_temp.keep('p_role', pg_temp.q($$select private.set_member_role_impl(p_business_id => {B1}, p_user_id => {TA},
                                                                         p_role => 'manager')::text$$, pg_temp.fresh('O'))),
    pg_temp.keep('p_remove', pg_temp.q($$select private.remove_member_impl(p_business_id => {B1},
                                                                         p_user_id => {TB})::text$$, pg_temp.fresh('O'))),
    pg_temp.keep('p_ident', pg_temp.q($$select private.change_business_identity_impl(p_business_id => {B1}, p_slug => null,
                                         p_timezone => null, p_currency => 'USD')::text$$, pg_temp.fresh('O'))),
    pg_temp.keep('p_grant', pg_temp.q($$select private.authorize_factor_change_impl(p_action => 'add',
                                                                                    p_factor_id => null)::text$$, pg_temp.fresh('F')))),
  'true ok ok ok ok',
  'with a code 1 minute old every critical _impl passes: can_manage_members true, set_member_role, remove_member, '
  || 'change_business_identity and authorize_factor_change answer'
);

select is(
  concat_ws(' ',
    pg_temp.r('p_role') ->> 'role', pg_temp.r('p_role') ->> 'previous_role', pg_temp.r('p_role') ->> 'changed',
    pg_temp.role_in('B1', 'TA'),
    pg_temp.r('p_remove') ->> 'removed', pg_temp.r('p_remove') ->> 'previous_role', pg_temp.role_in('B1', 'TB'),
    pg_temp.r('p_ident') -> 'changed_fields', (select b.currency from public.businesses b where b.id = pg_temp.id('B1')),
    pg_temp.r('p_grant') ->> 'action', coalesce(pg_temp.r('p_grant') ->> 'factor_id', '-'),
    pg_temp.lt(pg_temp.r('p_grant') ->> 'user_id'), pg_temp.grants_of('F', 'user')),
  'manager staff true manager true staff - ["currency"] USD add - F add:-',
  'the effects happened: TA is manager, TB is no member, B1 is in USD, F holds one add grant (source user)'
);

select is(
  concat_ws(' | ',
    pg_temp.audit('member_role_changed', 'TA'),
    pg_temp.audit('member_removed', 'TB'),
    pg_temp.audit('business_identity_changed', 'B1'),
    pg_temp.audit('factor_add_authorized', null, 'F')),
  'B1:staff:O:business_member:TA:staff:manager | B1:staff:O:business_member:TB:staff | '
  || 'B1:staff:O:business:B1:currency=EUR>USD | B2:staff:F:auth_factor:-:-',
  'one audit row each: member_role_changed (staff:manager), member_removed (staff), business_identity_changed '
  || '(currency=EUR>USD), factor_add_authorized in the one business where F is manager'
);

-- =============================================================================================
-- 3. change_business_identity: roles, slug → alias, aliases never move, zone and currency
-- =============================================================================================
select has_trigger('public', 'businesses', 'businesses_slug_guard',
  'businesses has the trigger businesses_slug_guard');

select is(
  concat_ws(' ',
    pg_temp.cbi('B1', 'members14-b', null, null, pg_temp.fresh('S')),
    pg_temp.cbi('B1', 'members14-b', null, null, pg_temp.fresh('M')),
    pg_temp.cbi('B1', 'members14-b', null, null, pg_temp.stale('O')),
    pg_temp.cbi('B1', 'members14-b', null, null, pg_temp.fresh('X')),
    pg_temp.slug_of('B1')),
  '42501 42501 42501/fresh_totp_required 42501 members14-a',
  'identity: staff and manager are refused (42501 even with a fresh code), the owner without a fresh code gets '
  || 'the hint, the owner of another business 42501; the slug is unchanged'
);

select is(
  pg_temp.keep('slug1', pg_temp.cbi('B1', '  Members14-B ', null, null, pg_temp.fresh('O'))),
  'ok',
  'identity: the owner with a fresh code changes the slug (given with spaces and capitals)'
);

select is(
  concat_ws(' ',
    pg_temp.lt(pg_temp.r('slug1') ->> 'business_id'), pg_temp.r('slug1') ->> 'slug', pg_temp.r('slug1') ->> 'timezone',
    pg_temp.r('slug1') ->> 'currency', pg_temp.r('slug1') ->> 'changed', pg_temp.r('slug1') -> 'changed_fields',
    pg_temp.r('slug1') ->> 'replanned', pg_temp.slug_of('B1'), pg_temp.aliases_of('B1')),
  'B1 members14-b Europe/Athens USD true ["slug"] 0 members14-b members14-a',
  'identity: the slug is stored trimmed and lower-cased, the answer lists only the slug as changed, and the old '
  || 'slug became an alias of B1'
);

select is(
  pg_temp.audit('business_identity_changed', 'B1'),
  'B1:staff:O:business:B1:currency=EUR>USD,B1:staff:O:business:B1:slug=members14-a>members14-b',
  'identity: one audit row business_identity_changed with slug=members14-a>members14-b'
);

select is(
  concat_ws(' ',
    pg_temp.q($$select concat_ws(':', c -> 'business' ->> 'slug', (c -> 'business' ->> 'id') = {B1}::text)
               from public.public_booking_catalogue(p_slug => 'members14-a') c$$, '', 'anon'),
    pg_temp.q($$select concat_ws(':', c -> 'business' ->> 'slug', (c -> 'business' ->> 'id') = {B1}::text)
               from public.public_booking_catalogue(p_slug => 'MEMBERS14-A') c$$, '', 'anon'),
    pg_temp.q($$select concat_ws(':', c -> 'business' ->> 'slug', (c -> 'business' ->> 'id') = {B1}::text)
               from public.public_booking_catalogue(p_slug => 'members14-b') c$$, '', 'anon')),
  'members14-b:t members14-b:t members14-b:t',
  'catalogue (anon): the former slug (any case) answers with B1 and its current slug, as does the new slug'
);

update public.businesses set booking_enabled = false where id = pg_temp.id('B1');

select is(
  concat_ws(' ',
    pg_temp.q($$select public.public_booking_catalogue(p_slug => 'members14-a')::text$$, '', 'anon'),
    pg_temp.q($$select public.public_booking_catalogue(p_slug => 'members14-b')::text$$, '', 'anon')),
  '<null> <null>',
  'catalogue: with online booking off, neither the former nor the current slug answers'
);

update public.businesses set booking_enabled = true where id = pg_temp.id('B1');

select is(
  pg_temp.keep('slug2', pg_temp.cbi('B1', 'members14-b', null, null, pg_temp.fresh('O'))),
  'ok',
  'identity: the same slug again answers'
);

select is(
  concat_ws(' ',
    pg_temp.r('slug2') ->> 'changed', pg_temp.r('slug2') -> 'changed_fields', pg_temp.r('slug2') ->> 'slug',
    (select count(*) from public.audit_log a
     where a.action = 'business_identity_changed' and a.entity_id = pg_temp.id('B1')),
    pg_temp.aliases_of('B1')),
  'false [] members14-b 2 members14-a',
  'identity: repeating the current values changes nothing (changed false, no audit row, no alias)'
);

select is(
  concat_ws(' ',
    pg_temp.cbi('B2', 'members14-a', null, null, pg_temp.fresh('X')),
    pg_temp.cbi('B2', 'members14-b', null, null, pg_temp.fresh('X')),
    pg_temp.cbi('B2', 'admin', null, null, pg_temp.fresh('X')),
    pg_temp.cbi('B2', ' Bad Slug ', null, null, pg_temp.fresh('X')),
    pg_temp.cbi('B2', 'ab', null, null, pg_temp.fresh('X'))),
  'P0001/AN024 P0001/AN024 P0001/AN024 22023 22023',
  'aliases never move: another owner cannot take a former slug of B1 nor its current slug nor a reserved one '
  || '(AN024); a malformed slug is 22023'
);

select is(
  concat_ws(' ',
    pg_temp.q($$insert into public.businesses (slug, name, vertical, timezone)
               values ('members14-a', 'Intruder', 'barber', 'Europe/Athens') returning id::text$$, '', 'service_role'),
    pg_temp.q($$update public.businesses set slug = 'members14-a' where id = {B2} returning slug$$, '', 'postgres')),
  '23505 23505',
  'aliases never move, below the RPC too: a new business (service_role) or an update (postgres) with a former '
  || 'slug of another business → 23505 (businesses_slug_guard)'
);

select is(
  concat_ws(' ',
    pg_temp.slug_of('B2'), pg_temp.aliases_of('B2'), pg_temp.slug_of('B1'), pg_temp.aliases_of('B1'),
    (select count(*) from public.businesses b where b.name = 'Intruder')),
  'members14-x - members14-b members14-a 0',
  'nothing moved: B2 keeps its slug and has no alias, B1 keeps both, no intruder business exists'
);

select is(
  pg_temp.keep('slug3', pg_temp.cbi('B1', 'members14-a', null, null, pg_temp.fresh('O'))),
  'ok',
  'identity: a business may take back its own former slug'
);

select is(
  concat_ws(' ',
    pg_temp.r('slug3') ->> 'slug', pg_temp.r('slug3') -> 'changed_fields', pg_temp.slug_of('B1'),
    pg_temp.aliases_of('B1'),
    (select a.reason from public.audit_log a
     where a.action = 'business_identity_changed' and a.entity_id = pg_temp.id('B1') order by a.id desc limit 1)),
  'members14-a ["slug"] members14-a members14-b slug=members14-b>members14-a',
  'identity: taking back the former slug removes that alias and keeps the slug it leaves as an alias'
);

select is(
  concat_ws(' ',
    pg_temp.cbi('B2', 'members14-b', null, null, pg_temp.fresh('X')),
    pg_temp.q($$select public.public_booking_catalogue(p_slug => 'members14-b') -> 'business' ->> 'slug'$$, '', 'anon')),
  'P0001/AN024 members14-a',
  'the slug B1 left is now its alias: another business cannot take it, and the catalogue leads to members14-a'
);

-- A past booked appointment (it does not block) and a future booked one (it does).
insert into public.appointments (id, business_id, staff_id, starts_at, ends_at, status, source) values
  (pg_temp.id('E1'), pg_temp.id('B1'), pg_temp.id('SS'), now() - interval '1 day 30 minutes', now() - interval '1 day', 'booked', 'phone'),
  (pg_temp.id('E2'), pg_temp.id('B1'), pg_temp.id('SS'), now() + interval '1 day', now() + interval '1 day 30 minutes', 'booked', 'phone');

select is(
  concat_ws(' ',
    pg_temp.cbi('B1', null, 'Europe/Berlin', null, pg_temp.fresh('O')),
    pg_temp.cbi('B1', null, null, 'EUR', pg_temp.fresh('O')),
    pg_temp.cbi('B1', null, 'Europe/Berlin', 'EUR', pg_temp.fresh('O'))),
  'P0001/AN025 P0001/AN025 P0001/AN025',
  'zone and currency: refused (AN025) while a booked appointment lies ahead, alone or together'
);

select is(
  concat_ws(' ',
    (select concat_ws(' ', b.timezone, b.currency) from public.businesses b where b.id = pg_temp.id('B1')),
    (select count(*) from public.audit_log a
     where a.action = 'business_identity_changed' and a.entity_id = pg_temp.id('B1'))),
  'Europe/Athens USD 3',
  'zone and currency: nothing changed and no audit row was written'
);

update public.appointments set status = 'cancelled', cancelled_by = 'business' where id = pg_temp.id('E2');
insert into public.appointments (id, business_id, staff_id, starts_at, ends_at, status, source) values
  (pg_temp.id('E3'), pg_temp.id('B1'), pg_temp.id('SS'), now() - interval '10 minutes', now() + interval '20 minutes', 'confirmed', 'phone');

select is(
  concat_ws(' ',
    pg_temp.cbi('B1', null, 'Europe/Berlin', null, pg_temp.fresh('O')),
    pg_temp.cbi('B1', null, null, 'EUR', pg_temp.fresh('O'))),
  'P0001/AN025 P0001/AN025',
  'zone and currency: an appointment in progress (confirmed, ends later) counts as ahead (D8)'
);

update public.appointments set status = 'completed' where id = pg_temp.id('E3');

select is(
  pg_temp.keep('zone', pg_temp.cbi('B1', null, 'Europe/Berlin', ' eur ', pg_temp.fresh('O'))),
  'ok',
  'zone and currency: with only past or cancelled appointments both change'
);

select is(
  concat_ws(' ',
    pg_temp.r('zone') -> 'changed_fields', pg_temp.r('zone') ->> 'timezone', pg_temp.r('zone') ->> 'currency',
    pg_temp.r('zone') ->> 'replanned',
    (select concat_ws(' ', b.timezone, b.currency, b.vertical, b.slug) from public.businesses b where b.id = pg_temp.id('B1')),
    (select a.reason from public.audit_log a
     where a.action = 'business_identity_changed' and a.entity_id = pg_temp.id('B1') order by a.id desc limit 1)),
  '["timezone", "currency"] Europe/Berlin EUR 0 Europe/Berlin EUR barber members14-a '
  || 'timezone=Europe/Athens>Europe/Berlin; currency=USD>EUR',
  'zone and currency: stored (currency trimmed and upper-cased), vertical and slug untouched, one audit row '
  || 'with the changed fields in order'
);

select is(
  concat_ws(' ',
    pg_temp.cbi('B1', null, 'UTC+2', null, pg_temp.fresh('O')),
    pg_temp.cbi('B1', null, 'Mars/Olympus_Mons', null, pg_temp.fresh('O')),
    pg_temp.cbi('B1', null, null, 'EURO', pg_temp.fresh('O')),
    pg_temp.cbi('B1', null, null, 'E1R', pg_temp.fresh('O'))),
  '22023 22023 22023 22023',
  'zone and currency: an offset zone, an unknown zone and a malformed currency are 22023'
);

select ok(
  coalesce(pg_get_functiondef(to_regprocedure('private.change_business_identity_impl(uuid, text, text, text)'))
           ~ 'private\.replan_reminders_impl', false),
  'change_business_identity_impl re-plans the reminders after a zone change (calls private.replan_reminders_impl; '
  || 'not observable while AN025 holds, D8)'
);

-- A booking or move in flight vs a change of time zone (D8, review fix): lock_local_days, which
-- book_core and move_core call BEFORE they validate under the zone, locks the business row with
-- KEY SHARE, so change_business_identity's FOR UPDATE waits for the booking (and its AN025 check then
-- sees it) or the booking waits and validates under the new zone. B3 has no child rows, so no FK
-- check has locked its row in this transaction; xmax then names this transaction as the locker.
insert into public.businesses (id, slug, name, vertical, timezone) values
  (pg_temp.id('B3'), 'members14-lock', 'Members 14 lock', 'barber', 'Europe/Athens');

do $do$
begin
  perform set_config('t.lock_before',
    (select b.xmax::text from public.businesses b where b.id = pg_temp.id('B3')), true);
  perform private.lock_local_days(pg_temp.id('B3'), array[tstzrange(now(), now() + interval '1 hour', '[)')]);
end
$do$;

select is(
  concat_ws(' ',
    current_setting('t.lock_before'),
    (select b.xmax::text::bigint = pg_current_xact_id()::text::bigint % 4294967296
     from public.businesses b where b.id = pg_temp.id('B3')),
    coalesce(pg_get_functiondef(to_regprocedure('private.lock_local_days(uuid, tstzrange[])')) ~* 'for key share',
             false)),
  '0 t t',
  'lock_local_days (book_core and move_core, before their recheck) locks the business row FOR KEY SHARE: a '
  || 'booking in flight and a change of time zone never interleave (D8)'
);

select is(
  concat_ws(' ',
    pg_temp.q($$select count(*)::text from public.business_slug_aliases where business_id = {B1}$$, pg_temp.aal1('O')),
    pg_temp.q($$select count(*)::text from public.business_slug_aliases where business_id = {B1}$$, pg_temp.aal1('S')),
    pg_temp.q($$select count(*)::text from public.business_slug_aliases where business_id = {B1}$$, pg_temp.fresh('X')),
    pg_temp.q($$select count(*)::text from public.business_slug_aliases where business_id = {B1}$$, '', 'service_role'),
    pg_temp.q($$insert into public.business_slug_aliases (slug, business_id) values ('members14-z', {B1})
               returning slug$$, pg_temp.fresh('O'))),
  '1 1 0 1 42501',
  'business_slug_aliases: members of B1 (owner and staff) read its alias, the owner of B2 does not, service_role '
  || 'reads it; authenticated cannot insert, not even the owner with a fresh code'
);

-- =============================================================================================
-- 4. authorize_factor_change (no p_business_id: the caller's own factors)
-- =============================================================================================
select is(
  concat_ws(' ',
    pg_temp.afc('add', null, pg_temp.fresh('S')),
    pg_temp.afc('remove', 'F.v', pg_temp.fresh('S')),
    pg_temp.afc('add', null, '{"role": "authenticated"}')),
  '42501 42501 42501',
  'devices: a user who is staff only is refused without hint even with a fresh code (staff never write factors), '
  || 'and so is a call without auth.uid()'
);

select is(
  pg_temp.keep('g_o', pg_temp.afc('add', null, pg_temp.aal1('O'))),
  'ok',
  'devices: an owner without any verified factor gets an add grant at aal1 (first enrolment, no code yet)'
);

select is(
  concat_ws(' ',
    pg_temp.r('g_o') ->> 'action', coalesce(pg_temp.r('g_o') ->> 'factor_id', '-'), pg_temp.lt(pg_temp.r('g_o') ->> 'user_id'),
    (pg_temp.r('g_o') ->> 'expires_at')::timestamptz = now() + interval '10 minutes',
    pg_temp.grants_of('O', 'user'), pg_temp.audit('factor_add_authorized', null, 'O')),
  'add - O t add:- B1:staff:O:auth_factor:-:-',
  'devices: the first-enrolment grant (add, no factor, source user, expires in 10′) and one audit row in B1'
);

select is(
  concat_ws(' ',
    pg_temp.afc('add', null, pg_temp.stale('MM')),
    pg_temp.afc('add', null, pg_temp.aal1('MM')),
    pg_temp.afc('add', null, pg_temp.otp2('MM')),
    pg_temp.grants_of('MM', 'user')),
  '42501/fresh_totp_required 42501/aal2_required 42501/fresh_totp_required -',
  'devices: with a verified factor, add needs a fresh code (old code, aal1, email code only refused; no grant)'
);

select is(
  pg_temp.keep('g_mm', pg_temp.afc('add', null, pg_temp.fresh('MM'))),
  'ok',
  'devices: with a verified factor and a fresh code, add is granted'
);

select is(
  concat_ws(' ', pg_temp.grants_of('MM', 'user'), pg_temp.audit('factor_add_authorized', null, 'MM')),
  'add:- B1:staff:MM:auth_factor:-:-,B2:staff:MM:auth_factor:-:-',
  'devices: one grant and one audit row per business where the user is owner/manager (manager of B1, owner of B2)'
);

select is(
  concat_ws(' ',
    pg_temp.afc('remove', 'K.v1', pg_temp.stale('K')),
    pg_temp.afc('remove', 'K.v1', pg_temp.aal1('K')),
    pg_temp.grants_of('K', 'user')),
  '42501/fresh_totp_required 42501/aal2_required -',
  'devices: removing one of two verified factors without a fresh code is refused with the hint, no grant'
);

select is(
  pg_temp.keep('g_k', pg_temp.afc('remove', 'K.v1', pg_temp.fresh('K'))),
  'ok',
  'devices: removing one of two verified factors with a fresh code is granted'
);

select is(
  concat_ws(' ',
    pg_temp.r('g_k') ->> 'action', pg_temp.lt(pg_temp.r('g_k') ->> 'factor_id'), pg_temp.lt(pg_temp.r('g_k') ->> 'user_id'),
    pg_temp.grants_of('K', 'user'), pg_temp.audit('factor_remove_authorized', 'K.v1'), pg_temp.factors_of('K')),
  'remove K.v1 K remove:K.v1 B1:staff:K:auth_factor:K.v1:- 2',
  'devices: a remove grant for that factor, one audit row factor_remove_authorized, and no factor deleted (the '
  || 'Edge Function deletes)'
);

select is(
  concat_ws(' ',
    pg_temp.afc('remove', 'K.v2', pg_temp.fresh('K')),
    pg_temp.afc('remove', 'K.v2', pg_temp.stale('K'))),
  'P0001/AN027 P0001/AN027',
  'devices: with a pending removal of the other factor, the remaining one is the last (AN027, D11), before any '
  || 'freshness check'
);

select is(
  concat_ws(' ',
    pg_temp.afc('remove', 'F.u', pg_temp.fresh('F')),
    pg_temp.afc('remove', 'F.v', pg_temp.fresh('F')),
    pg_temp.afc('remove', 'F.v', pg_temp.stale('F')),
    pg_temp.afc('remove', 'F.v', pg_temp.aal1('F')),
    pg_temp.afc('remove', 'F.v', pg_temp.fresh('K')),
    pg_temp.afc('remove', 'NOBODY', pg_temp.fresh('F'))),
  '42501 P0001/AN027 P0001/AN027 P0001/AN027 42501 42501',
  'devices: an own unverified factor → 42501; the only verified factor → AN027 (fresh, stale or aal1); another '
  || 'user''s factor or an unknown id → 42501 without hint'
);

select is(
  concat_ws(' ',
    pg_temp.afc('rotate', null, pg_temp.fresh('F')),
    pg_temp.afc('remove', null, pg_temp.fresh('F')),
    pg_temp.afc('add', 'F.v', pg_temp.fresh('F')),
    pg_temp.afc(null, null, pg_temp.fresh('F'))),
  '22023 22023 22023 22023',
  'devices: an unknown or missing action, remove without a factor and add with one are 22023'
);

select is(
  concat_ws(' ',
    (select count(*) from private.factor_change_grants g
     where g.source = 'user' and g.user_id in (select x.id from pg_temp.lbl x)),
    (select bool_and(g.created_at = now() and g.expires_at = g.created_at + interval '10 minutes' and g.matched_at is null)
     from private.factor_change_grants g
     where g.source = 'user' and g.user_id in (select x.id from pg_temp.lbl x)),
    pg_temp.grants_of('F', 'user'), pg_temp.grants_of('K', 'user')),
  '4 t add:- remove:K.v1',
  'devices: exactly the four granted calls wrote a grant (F, O, MM add; K remove), each expiring 10′ after it '
  || 'was written and unmatched; no refusal wrote one'
);

-- =============================================================================================
-- 5. service_role only: record_support_action, user_id_for_email, revoke_user_sessions, add_member
-- =============================================================================================
select is(
  concat_ws(' ',
    pg_temp.q($$select public.record_support_action(p_action => 'provision_update', p_reason => 'probe reason',
               p_ticket => 'T-0', p_user_id => null, p_business_id => {B1})::text$$, pg_temp.fresh('O')),
    pg_temp.q($$select public.user_id_for_email(p_email => 'o@members14.test')::text$$, pg_temp.fresh('O')),
    pg_temp.q($$select public.revoke_user_sessions(p_user_id => {S})::text$$, pg_temp.fresh('O')),
    pg_temp.q($$select public.add_member(p_business_id => {B1}, p_user_id => {N1}, p_role => 'staff', p_staff_id => null,
               p_actor_id => {O})::text$$, pg_temp.fresh('O')),
    pg_temp.q($$select private.record_support_action_impl(p_action => 'provision_update', p_reason => 'probe reason',
               p_ticket => 'T-0', p_user_id => null, p_business_id => {B1})::text$$, pg_temp.fresh('O')),
    pg_temp.q($$select private.user_id_for_email_impl(p_email => 'o@members14.test')::text$$, pg_temp.fresh('O')),
    pg_temp.q($$select private.revoke_user_sessions_impl(p_user_id => {S})::text$$, pg_temp.fresh('O')),
    pg_temp.q($$select private.add_member_impl(p_business_id => {B1}, p_user_id => {N1}, p_role => 'staff',
               p_staff_id => null, p_actor_id => {O})::text$$, pg_temp.fresh('O')),
    pg_temp.q($$select public.record_support_action(p_action => 'provision_update', p_reason => 'probe reason',
               p_ticket => 'T-0', p_user_id => null, p_business_id => {B1})::text$$, '', 'anon'),
    pg_temp.q($$select public.user_id_for_email(p_email => 'o@members14.test')::text$$, '', 'anon'),
    pg_temp.q($$select public.revoke_user_sessions(p_user_id => {S})::text$$, '', 'anon'),
    pg_temp.q($$select public.add_member(p_business_id => {B1}, p_user_id => {N1}, p_role => 'staff', p_staff_id => null,
               p_actor_id => {O})::text$$, '', 'anon')),
  '42501 42501 42501 42501 42501 42501 42501 42501 42501 42501 42501 42501',
  'record_support_action, user_id_for_email, revoke_user_sessions and add_member (wrappers and _impls) are '
  || 'refused to authenticated, even an owner with a fresh code, and to anon (no privilege)'
);

select is(
  concat_ws(' ',
    pg_temp.support('mfa_reset', '   ', 'T-1', 'MM', null),
    pg_temp.support('mfa_reset', 'ab', 'T-1', 'MM', null),
    pg_temp.support('mfa_reset', repeat('x', 401), 'T-1', 'MM', null),
    pg_temp.support('mfa_reset', null, 'T-1', 'MM', null),
    pg_temp.support('mfa_reset', 'lost phone', null, 'MM', null),
    pg_temp.support('mfa_reset', 'lost phone', 'T 1', 'MM', null),
    pg_temp.support('mfa_reset', 'lost phone', '-T1', 'MM', null),
    pg_temp.support('mfa_reset', 'lost phone', 'T' || repeat('1', 40), 'MM', null),
    pg_temp.support('erase_user', 'lost phone', 'T-1', 'MM', null),
    pg_temp.support(null, 'lost phone', 'T-1', 'MM', null),
    pg_temp.support('mfa_reset', 'lost phone', 'T-1', null, null),
    pg_temp.support('mfa_reset', 'lost phone', 'T-1', 'MM', 'B1'),
    pg_temp.support('mfa_reset', 'lost phone', 'T-1', 'NOBODY', null),
    pg_temp.support('mfa_reset', 'lost phone', 'T-1', 'S', null),
    pg_temp.support('provision_update', 'catalogue update', 'PROV-7', null, null),
    pg_temp.support('provision_update', 'catalogue update', 'PROV-7', 'O', 'B1'),
    pg_temp.support('provision_update', 'catalogue update', 'PROV-7', null, 'NOSHOP')),
  '22023 22023 22023 22023 22023 22023 22023 22023 22023 22023 22023 22023 22023 22023 22023 22023 22023',
  'record_support_action: a blank, short, long or missing reason, a missing or malformed ticket, an unknown '
  || 'action, mfa_reset without a user, with a business, of an unknown user or of a staff-only user, '
  || 'provision_update without, with a user or with an unknown business → 22023'
);

select is(
  concat_ws(' ',
    (select count(*) from public.audit_log a
     where a.actor_type = 'nous_support' and a.business_id in (pg_temp.id('B1'), pg_temp.id('B2'))),
    (select count(*) from private.factor_change_grants g
     where g.source = 'nous_support' and g.user_id in (select x.id from pg_temp.lbl x))),
  '0 0',
  'record_support_action: no refused call wrote an audit row or a grant'
);

select is(
  pg_temp.keep('reset', pg_temp.support('mfa_reset', 'lost phone', 'T-1', 'MM', null)),
  'ok',
  'record_support_action mfa_reset of a manager of B1 who owns B2'
);

select is(
  concat_ws(' ',
    pg_temp.r('reset') ->> 'action',
    (select string_agg(pg_temp.lt(e.v), ',' order by e.o)
     from jsonb_array_elements_text(pg_temp.r('reset') -> 'factor_ids') with ordinality as e (v, o)),
    pg_temp.r('reset') ->> 'grants', pg_temp.r('reset') ->> 'audit_rows',
    pg_temp.grants_of('MM', 'nous_support'), pg_temp.grants_ok('MM', 'nous_support'), pg_temp.factors_of('MM')),
  'mfa_reset MM.v,MM.u 2 2 remove:MM.u,remove:MM.v t 2',
  'mfa_reset: the factor ids (every status, oldest first), one remove grant (source nous_support, 10′) per factor, '
  || 'and nothing deleted (the script deletes through the admin API)'
);

select is(
  pg_temp.audit('mfa_reset', 'MM'),
  'B1:nous_support:-:auth_user:MM:[T-1] lost phone,B2:nous_support:-:auth_user:MM:[T-1] lost phone',
  'mfa_reset: one audit row nous_support per business where the user is owner/manager, reason [ticket] reason'
);

select is(
  pg_temp.keep('prov', pg_temp.support('provision_update', 'catalogue update', 'PROV-7', null, 'B1')),
  'ok',
  'record_support_action provision_update of B1'
);

select is(
  concat_ws(' ',
    pg_temp.r('prov') ->> 'action', pg_temp.r('prov') -> 'factor_ids', pg_temp.r('prov') ->> 'grants',
    pg_temp.r('prov') ->> 'audit_rows', pg_temp.audit('provision_update', 'B1')),
  'provision_update [] 0 1 B1:nous_support:-:business:B1:[PROV-7] catalogue update',
  'provision_update: one audit row nous_support on the business, no grant'
);

select is(
  concat_ws(' ',
    pg_temp.lt(pg_temp.q($$select public.user_id_for_email(p_email => '  O@Members14.TEST  ')::text$$, '', 'service_role')),
    pg_temp.q($$select public.user_id_for_email(p_email => 'nobody@members14.test')::text$$, '', 'service_role')),
  'O <null>',
  'user_id_for_email: the address is trimmed and lower-cased; an unknown address gives null'
);

do $do$ begin perform set_config('t.others_x', pg_temp.others_fp('X'), true); end $do$;

select is(
  pg_temp.keep('rev', pg_temp.q($$select public.revoke_user_sessions(p_user_id => {X})::text$$, '', 'service_role')),
  'ok',
  'revoke_user_sessions as service_role'
);

select is(
  concat_ws(' ',
    pg_temp.r('rev') ->> 'sessions', pg_temp.r('rev') ->> 'push_subscriptions',
    pg_temp.sessions_of('X'), pg_temp.tokens_of('X'), pg_temp.push_of('X'), pg_temp.role_in('B2', 'X'),
    pg_temp.others_fp('X') = current_setting('t.others_x')),
  '2 1 0 0 0 owner t',
  'revoke_user_sessions: answers the counts, the user''s sessions, refresh tokens and push devices are gone, the '
  || 'membership stays, nobody else''s rows changed'
);

select is(
  concat_ws(' ',
    pg_temp.q($$select public.revoke_user_sessions(p_user_id => null)::text$$, '', 'service_role'),
    pg_temp.q($$select concat_ws('/', r ->> 'sessions', r ->> 'push_subscriptions')
               from public.revoke_user_sessions(p_user_id => {N2}) r$$, '', 'service_role')),
  '22023 0/0',
  'revoke_user_sessions: a null user is 22023; a user with nothing to revoke answers zeros'
);

select is(
  concat_ws(' ',
    pg_temp.add_m(null, 'N1', 'staff', 'SN', 'O'),
    pg_temp.add_m('NOSHOP', 'N1', 'staff', 'SN', 'O'),
    pg_temp.add_m('B1', 'N1', 'staff', 'SN', 'M'),
    pg_temp.add_m('B1', 'N1', 'staff', 'SN', 'X'),
    pg_temp.add_m('B1', 'N1', 'staff', 'SN', null),
    pg_temp.add_m('B1', 'N1', 'owner', 'SN', 'O'),
    pg_temp.add_m('B1', 'N1', 'boss', 'SN', 'O'),
    pg_temp.add_m('B1', 'NOBODY', 'staff', 'SN', 'O'),
    pg_temp.add_m('B1', 'N1', 'staff', 'SX', 'O'),
    pg_temp.role_in('B1', 'N1')),
  '22023 22023 42501 42501 42501 22023 22023 22023 42501 -',
  'add_member: null or unknown business → 22023; an actor who is not owner of that business (manager, owner '
  || 'elsewhere, none) → 42501; role owner or unknown → 22023 (owners only by promotion, D4); unknown user → '
  || '22023; a staff row of another business → 42501; nothing was added'
);

select is(
  pg_temp.keep('add1', pg_temp.add_m('B1', 'N1', 'staff', 'SN', 'O')),
  'ok',
  'add_member: the owner adds a new staff member linked to a staff row'
);

select is(
  concat_ws(' ',
    pg_temp.r('add1') ->> 'added', pg_temp.r('add1') ->> 'role', pg_temp.lt(pg_temp.r('add1') ->> 'staff_id'),
    pg_temp.lt(pg_temp.r('add1') ->> 'user_id'), pg_temp.lt(pg_temp.r('add1') ->> 'business_id'),
    pg_temp.role_in('B1', 'N1'),
    (select pg_temp.l(m.staff_id) from public.business_members m
     where m.business_id = pg_temp.id('B1') and m.user_id = pg_temp.id('N1')),
    pg_temp.audit('member_added', 'N1'), pg_temp.sessions_of('N1')),
  'true staff SN N1 B1 staff SN B1:staff:O:business_member:N1:staff 1',
  'add_member: the row, one audit row member_added (actor the owner, reason the role), and no session revoked '
  || '(an insert never fires the trigger)'
);

select is(
  pg_temp.keep('add2', pg_temp.add_m('B1', 'N1', 'staff', 'SN', 'O')),
  'ok',
  'add_member: the same membership again answers'
);

select is(
  concat_ws(' ',
    pg_temp.r('add2') ->> 'added',
    (select count(*) from public.audit_log a where a.action = 'member_added' and a.entity_id = pg_temp.id('N1'))),
  'false 1',
  'add_member: repeating the same role and staff link changes nothing (added false, no audit row)'
);

select is(
  concat_ws(' ',
    pg_temp.add_m('B1', 'N1', 'manager', null, 'O'),
    pg_temp.add_m('B1', 'N1', 'staff', null, 'O'),
    pg_temp.add_m('B1', 'N2', 'staff', 'SN', 'O'),
    pg_temp.role_in('B1', 'N2')),
  'P0001/AN028 P0001/AN028 P0001/AN029 -',
  'add_member: an existing member with another role or staff link → AN028; a staff row held by another member → '
  || 'AN029'
);

select is(
  concat_ws(' ',
    pg_temp.add_m('B1', 'PD', 'staff', null, 'O'),
    pg_temp.add_m('B1', 'PD', 'manager', null, 'O'),
    pg_temp.add_m('B1', 'X', 'staff', null, 'O'),
    pg_temp.add_m('B1', 'MM', 'staff', null, 'O'),
    pg_temp.add_m('B1', 'MM', 'manager', null, 'O')::jsonb ->> 'added',
    pg_temp.role_in('B1', 'PD'), pg_temp.role_in('B1', 'X'), pg_temp.sessions_of('PD'),
    (select count(*) from public.audit_log a
     where a.action = 'member_added' and a.entity_id in (pg_temp.id('PD'), pg_temp.id('X'), pg_temp.id('MM')))),
  'P0001/AN031 P0001/AN031 P0001/AN031 P0001/AN028 false - - 1 0',
  'add_member never attaches an account that is a member of another business (AN031: no acceptance step, and a '
  || 'later removal here would end that user''s sessions and push devices everywhere); a member of both (Nous) '
  || 'is still answered as a member here (AN028, or added false for the same role); nothing written'
);

-- =============================================================================================
-- 6. list_members (owner only, no freshness: reading is not critical)
-- =============================================================================================
select is(
  pg_get_function_result(to_regprocedure('public.list_members(uuid)')),
  'TABLE(user_id uuid, email text, role text, staff_id uuid, staff_name text, created_at timestamp with time zone, '
  || 'last_sign_in_at timestamp with time zone, is_self boolean)',
  'list_members returns exactly user_id, email, role, staff_id, staff_name, created_at, last_sign_in_at, is_self'
);

select is(
  pg_temp.q($$select string_agg(concat_ws(':', l.user_id, l.email, l.role, coalesce(l.staff_name, '-'), l.is_self,
                                          l.last_sign_in_at is null), ',' order by l.o)
             from public.list_members(p_business_id => {B1})
                  with ordinality as l (user_id, email, role, staff_id, staff_name, created_at, last_sign_in_at, is_self, o)$$,
            pg_temp.aal1('O')),
  (select string_agg(concat_ws(':', m.user_id, u.email, m.role, coalesce(st.display_name, '-'),
                               m.user_id = pg_temp.id('O'), u.last_sign_in_at is null), ','
                     order by case m.role when 'owner' then 0 when 'manager' then 1 else 2 end, u.email, m.user_id)
   from public.business_members m
   join auth.users u on u.id = m.user_id
   left join public.staff st on st.business_id = m.business_id and st.id = m.staff_id
   where m.business_id = pg_temp.id('B1')),
  'list_members: the owner (aal1 is enough) gets every member of B1 with email, role and staff name, ordered owner, '
  || 'manager, staff then email; is_self only on the caller'
);

select is(
  concat_ws(' ',
    pg_temp.q($$select count(*)::text from public.list_members(p_business_id => {B1})$$, pg_temp.fresh('M')),
    pg_temp.q($$select count(*)::text from public.list_members(p_business_id => {B1})$$, pg_temp.aal1('S')),
    pg_temp.q($$select count(*)::text from public.list_members(p_business_id => {B1})$$, pg_temp.fresh('X'))),
  '42501 42501 42501',
  'list_members: a manager, a staff member and the owner of another business are refused'
);

-- The account's last sign-in is global: N1 signed in a day before joining B1, S since.
update auth.users set last_sign_in_at = now() - interval '1 day' where id = pg_temp.id('N1');
update auth.users set last_sign_in_at = now() where id = pg_temp.id('S');

select is(
  pg_temp.q($$select string_agg(case l.user_id when {S} then 'S' when {N1} then 'N1' end
                                || ':' || coalesce(l.last_sign_in_at = now(), false)
                                || ':' || (l.last_sign_in_at is null), ',' order by l.user_id)
             from public.list_members(p_business_id => {B1}) l
             where l.user_id in ({S}, {N1})$$, pg_temp.aal1('O')),
  'S:true:false,N1:false:true',
  'list_members reports the last sign-in only from the day the user joined this business: S signed in since '
  || '(shown), N1 only before joining (null, «not signed in yet»)'
);

-- =============================================================================================
-- 7. can_manage_members, set_member_role, remove_member
-- =============================================================================================
select is(
  concat_ws(' ',
    pg_temp.cmm('B1', pg_temp.fresh('S')),
    pg_temp.cmm('B1', pg_temp.fresh('M')),
    pg_temp.cmm('B1', pg_temp.fresh('X')),
    pg_temp.cmm('B1', pg_temp.aal1('O')),
    pg_temp.cmm('B1', pg_temp.stale('O')),
    pg_temp.cmm('B1', pg_temp.otp2('O')),
    pg_temp.cmm('B1', pg_temp.fresh('O'))),
  '42501 42501 42501 42501/aal2_required 42501/fresh_totp_required 42501/fresh_totp_required true',
  'can_manage_members: staff, manager and the owner of another business → 42501; the owner without a fresh code '
  || 'gets the matching hint; with one → true'
);

select is(
  concat_ws(' ',
    pg_temp.smr('B1', 'R1', 'manager', pg_temp.fresh('S')),
    pg_temp.smr('B1', 'R1', 'manager', pg_temp.fresh('M')),
    pg_temp.smr('B1', 'R1', 'manager', pg_temp.fresh('X')),
    pg_temp.smr('B1', 'R1', 'manager', pg_temp.stale('O')),
    pg_temp.rmm('B1', 'R2', pg_temp.fresh('S')),
    pg_temp.rmm('B1', 'R2', pg_temp.fresh('M')),
    pg_temp.rmm('B1', 'R2', pg_temp.fresh('X')),
    pg_temp.rmm('B1', 'R2', pg_temp.aal1('O'))),
  '42501 42501 42501 42501/fresh_totp_required 42501 42501 42501 42501/aal2_required',
  'set_member_role and remove_member: staff, manager and another business''s owner → 42501; the owner without a '
  || 'fresh code gets the hint'
);

select is(
  concat_ws(' ',
    pg_temp.role_in('B1', 'R1'), pg_temp.sessions_of('R1'), pg_temp.tokens_of('R1'), pg_temp.push_of('R1'),
    pg_temp.role_in('B1', 'R2'), pg_temp.sessions_of('R2'), pg_temp.tokens_of('R2'), pg_temp.push_of('R2')),
  'staff 2 2 2 staff 2 2 1',
  'before: R1 and R2 are staff with two sessions (refresh tokens) each and their push devices'
);

do $do$ begin perform set_config('t.others_r1', pg_temp.others_fp('R1'), true); end $do$;

select is(
  pg_temp.keep('r1', pg_temp.smr('B1', 'R1', 'manager', pg_temp.fresh('O'))),
  'ok',
  'set_member_role: the owner with a fresh code makes R1 manager'
);

select is(
  concat_ws(' ',
    pg_temp.lt(pg_temp.r('r1') ->> 'user_id'), pg_temp.r('r1') ->> 'role', pg_temp.r('r1') ->> 'previous_role',
    pg_temp.r('r1') ->> 'changed', pg_temp.role_in('B1', 'R1'),
    pg_temp.sessions_of('R1'), pg_temp.tokens_of('R1'), pg_temp.push_of('R1'),
    pg_temp.others_fp('R1') = current_setting('t.others_r1')),
  'R1 manager staff true manager 0 0 0 t',
  'set_member_role: the role changed; in the same transaction every session (and refresh token) and every push '
  || 'device of R1 is gone; nobody else''s sessions, tokens, devices or factors changed'
);

select is(
  pg_temp.audit('member_role_changed', 'R1'),
  'B1:staff:O:business_member:R1:staff:manager',
  'set_member_role: exactly one audit row (member_role_changed, staff, actor the owner, reason old:new)'
);

do $do$ begin perform set_config('t.others_r2', pg_temp.others_fp('R2'), true); end $do$;

select is(
  pg_temp.keep('r2', pg_temp.rmm('B1', 'R2', pg_temp.fresh('O'))),
  'ok',
  'remove_member: the owner with a fresh code removes R2'
);

select is(
  concat_ws(' ',
    pg_temp.lt(pg_temp.r('r2') ->> 'user_id'), pg_temp.r('r2') ->> 'removed', pg_temp.r('r2') ->> 'previous_role',
    pg_temp.role_in('B1', 'R2'), pg_temp.sessions_of('R2'), pg_temp.tokens_of('R2'), pg_temp.push_of('R2'),
    pg_temp.others_fp('R2') = current_setting('t.others_r2'), pg_temp.audit('member_removed', 'R2')),
  'R2 true staff - 0 0 0 t B1:staff:O:business_member:R2:staff',
  'remove_member: the membership is gone with every session, refresh token and push device of R2, nobody else''s, '
  || 'and exactly one audit row member_removed'
);

select is(
  concat_ws(' ',
    pg_temp.smr('B1', 'O', 'manager', pg_temp.fresh('O')),
    pg_temp.smr('B1', 'O', 'staff', pg_temp.fresh('O')),
    pg_temp.rmm('B1', 'O', pg_temp.fresh('O')),
    pg_temp.role_in('B1', 'O'), pg_temp.sessions_of('O')),
  'P0001/AN026 P0001/AN026 P0001/AN026 owner 1',
  'the last owner can be neither demoted nor removed (AN026); the owner and their session are untouched'
);

select is(
  concat_ws(' ',
    pg_temp.smr('B1', 'O2', 'owner', pg_temp.fresh('M')),
    pg_temp.smr('B1', 'O2', 'owner', pg_temp.stale('O')),
    pg_temp.smr('B1', 'O2', 'owner', pg_temp.aal1('O')),
    pg_temp.role_in('B1', 'O2')),
  '42501 42501/fresh_totp_required 42501/aal2_required staff',
  'promotion to owner: a manager → 42501, the owner without a fresh code → the hint; nothing changed'
);

select is(
  pg_temp.keep('o2a', pg_temp.smr('B1', 'O2', 'owner', pg_temp.fresh('O'))),
  'ok',
  'promotion to owner: the owner with a fresh code promotes O2'
);

select is(
  concat_ws(' ',
    pg_temp.r('o2a') ->> 'role', pg_temp.r('o2a') ->> 'previous_role', pg_temp.role_in('B1', 'O2'),
    pg_temp.audit('member_role_changed', 'O2')),
  'owner staff owner B1:staff:O:business_member:O2:staff:owner',
  'promotion to owner: O2 is owner, one audit row staff:owner'
);

select is(
  pg_temp.keep('o2b', pg_temp.smr('B1', 'O2', 'manager', pg_temp.fresh('O2'))),
  'ok',
  'an owner may step down while another owner remains (D10: acting on oneself)'
);

select is(
  concat_ws(' ',
    pg_temp.r('o2b') ->> 'previous_role', pg_temp.role_in('B1', 'O2'), pg_temp.role_in('B1', 'O'),
    pg_temp.audit('member_role_changed', 'O2', 'O2')),
  'owner manager owner B1:staff:O2:business_member:O2:owner:manager',
  'stepping down: O2 is manager, O still owner, the audit row names O2 as actor'
);

select is(
  pg_temp.keep('o2c', pg_temp.smr('B1', 'O2', 'owner', pg_temp.fresh('O'))),
  'ok',
  'promotion to owner again'
);

select is(
  concat_ws(' ',
    pg_temp.rmm('B1', 'O2', pg_temp.stale('O')),
    pg_temp.rmm('B1', 'O2', pg_temp.fresh('M')),
    pg_temp.rmm('B1', 'O2', pg_temp.fresh('S')),
    pg_temp.role_in('B1', 'O2')),
  '42501/fresh_totp_required 42501 42501 owner',
  'removal of an owner: the owner without a fresh code → the hint, manager and staff → 42501; O2 stays owner'
);

select is(
  pg_temp.keep('o2d', pg_temp.rmm('B1', 'O2', pg_temp.fresh('O'))),
  'ok',
  'removal of an owner: the owner with a fresh code removes O2 while O remains owner'
);

select is(
  concat_ws(' ',
    pg_temp.r('o2d') ->> 'removed', pg_temp.r('o2d') ->> 'previous_role', pg_temp.role_in('B1', 'O2'),
    pg_temp.role_in('B1', 'O'), pg_temp.audit('member_removed', 'O2')),
  'true owner - owner B1:staff:O:business_member:O2:owner',
  'removal of an owner: O2 is gone, O is still owner, one audit row member_removed (owner)'
);

select is(
  pg_temp.keep('same', pg_temp.smr('B1', 'S', 'staff', pg_temp.fresh('O'))),
  'ok',
  'set_member_role with the current role answers'
);

select is(
  concat_ws(' ',
    pg_temp.r('same') ->> 'changed', pg_temp.r('same') ->> 'role', pg_temp.r('same') ->> 'previous_role',
    pg_temp.audit('member_role_changed', 'S'), pg_temp.sessions_of('S'), pg_temp.tokens_of('S'), pg_temp.push_of('S')),
  'false staff staff - 1 1 1',
  'set_member_role with the current role changes nothing: changed false, no audit row, session and device intact'
);

select is(
  concat_ws(' ',
    pg_temp.q($$select public.remove_member(p_business_id => {B1}, p_user_id => {X}) ->> 'removed'$$, pg_temp.fresh('O')),
    pg_temp.smr('B1', 'X', 'staff', pg_temp.fresh('O')),
    pg_temp.smr('B1', null, 'staff', pg_temp.fresh('O')),
    pg_temp.rmm('B1', null, pg_temp.fresh('O')),
    pg_temp.smr('B1', 'S', 'boss', pg_temp.fresh('O')),
    pg_temp.smr('B1', 'S', null, pg_temp.fresh('O')),
    pg_temp.audit('member_removed', 'X'), pg_temp.role_in('B2', 'X'), pg_temp.role_in('B1', 'S')),
  'false P0001/AN030 42501 42501 22023 22023 - owner staff',
  'a non-member: remove_member answers removed false (nothing written), set_member_role AN030; a null user → '
  || '42501; an unknown or missing role → 22023'
);

-- =============================================================================================
-- 8. Factors on a demotion or a removal (D1: the trigger business_members_access_changed)
-- =============================================================================================
select has_trigger('public', 'business_members', 'business_members_access_changed',
  'business_members has the trigger business_members_access_changed');

select is(
  concat_ws(' ', pg_temp.factors_of('M'), pg_temp.factors_of('MM'), pg_temp.factors_of('MS'), pg_temp.factors_of('MR'),
            pg_temp.factors_of('MK'), pg_temp.factors_of('PD')),
  '2 2 1 1 1 1',
  'before: M, MM (verified + unverified), MS, MR, MK and PD hold their factors'
);

select is(
  pg_temp.keep('dm', pg_temp.smr('B1', 'M', 'staff', pg_temp.fresh('O'))),
  'ok',
  'demotion: the owner makes M (manager of B1 only) staff'
);

select is(
  concat_ws(' ',
    pg_temp.role_in('B1', 'M'), pg_temp.factors_of('M'), pg_temp.grants_of('M', 'demotion'),
    pg_temp.grants_ok('M', 'demotion'), pg_temp.sessions_of('M')),
  'staff 0 remove:M.u,remove:M.v t 0',
  'demotion to staff: every factor of M (every status) is deleted with one remove grant (source demotion, 10′) '
  || 'each, and the sessions are revoked'
);

select is(
  pg_temp.keep('dmm', pg_temp.smr('B1', 'MM', 'staff', pg_temp.fresh('O'))),
  'ok',
  'demotion: the owner makes MM staff in B1 (MM stays owner of B2)'
);

select is(
  concat_ws(' ',
    pg_temp.role_in('B1', 'MM'), pg_temp.role_in('B2', 'MM'), pg_temp.factors_of('MM'),
    pg_temp.grants_of('MM', 'demotion'), pg_temp.sessions_of('MM')),
  'staff owner 2 - 0',
  'demotion of a user who stays owner elsewhere: factors kept, no demotion grant; the sessions are still revoked'
);

select is(
  pg_temp.keep('rmr', pg_temp.rmm('B1', 'MR', pg_temp.fresh('O'))),
  'ok',
  'removal: the owner removes MR (manager of B1 only)'
);

select is(
  concat_ws(' ',
    (select count(*) from public.business_members m where m.user_id = pg_temp.id('MR')),
    pg_temp.factors_of('MR'), pg_temp.grants_of('MR', 'demotion'), pg_temp.grants_ok('MR', 'demotion')),
  '0 0 remove:MR.v t',
  'removal of a manager who is member nowhere else: factors deleted with a demotion grant each'
);

select is(
  pg_temp.keep('rms', pg_temp.rmm('B1', 'MS', pg_temp.fresh('O'))),
  'ok',
  'removal: the owner removes MS (manager of B1, staff of B2)'
);

select is(
  concat_ws(' ',
    pg_temp.role_in('B1', 'MS'), pg_temp.role_in('B2', 'MS'), pg_temp.factors_of('MS'),
    pg_temp.grants_of('MS', 'demotion')),
  '- staff 0 remove:MS.v',
  'removal of a manager who stays staff elsewhere: factors deleted with a demotion grant (staff never keep factors)'
);

select is(
  pg_temp.keep('rmk', pg_temp.rmm('B1', 'MK', pg_temp.fresh('O'))),
  'ok',
  'removal: the owner removes MK (manager of B1 and of B2)'
);

select is(
  concat_ws(' ',
    pg_temp.role_in('B1', 'MK'), pg_temp.role_in('B2', 'MK'), pg_temp.factors_of('MK'),
    pg_temp.grants_of('MK', 'demotion'), pg_temp.sessions_of('MK')),
  '- manager 1 - 0',
  'removal of a manager who stays manager elsewhere: factors kept, no grant; the sessions are revoked'
);

-- The provisioning path: a membership deleted directly as postgres goes through the same trigger.
delete from public.business_members where business_id = pg_temp.id('B2') and user_id = pg_temp.id('PD');

select is(
  concat_ws(' ',
    pg_temp.role_in('B2', 'PD'), pg_temp.sessions_of('PD'), pg_temp.tokens_of('PD'), pg_temp.factors_of('PD'),
    pg_temp.grants_of('PD', 'demotion')),
  '- 0 0 0 remove:PD.v',
  'a direct delete of a membership as postgres (provisioning) also revokes the sessions and, when no privileged '
  || 'membership remains, deletes the factors with a demotion grant (D1)'
);

-- =============================================================================================
-- 9. D2: an owner/manager with a verified factor counts as a member only at aal2
-- =============================================================================================
select is(
  pg_temp.q($$select count(*)::text from public.businesses$$, pg_temp.aal1('O')),
  '1',
  'D2: an owner without any factor reads their business at aal1 (first sign-in, after a reset)'
);

insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
  (pg_temp.id('O.u'), pg_temp.id('O'), 'O tablet', 'totp', 'unverified', now(), now(), 'PGTAPSYNTHETICSECRETO1');

select is(
  pg_temp.q($$select count(*)::text from public.businesses$$, pg_temp.aal1('O')),
  '1',
  'D2: an unverified factor (an enrolment in progress) does not count'
);

insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
  (pg_temp.id('O.v'), pg_temp.id('O'), 'O phone', 'totp', 'verified', now(), now(), 'PGTAPSYNTHETICSECRETO2');

select is(
  concat_ws(' ',
    pg_temp.q($$select count(*)::text from public.businesses$$, pg_temp.aal1('O')),
    pg_temp.q($$select count(*)::text from public.business_members$$, pg_temp.aal1('O')),
    pg_temp.q($$select string_agg(m.role, ',') from public.business_members m$$, pg_temp.aal1('O')),
    pg_temp.q($$select private.today_summary_impl(p_business_id => {B1})::text$$, pg_temp.aal1('O')),
    pg_temp.q($$select public.can_manage_members(p_business_id => {B1})::text$$, pg_temp.aal1('O')),
    pg_temp.q($$select count(*)::text from public.appointments$$, pg_temp.aal1('O'))),
  '0 1 owner 42501 42501 0',
  'D2: an enrolled owner at aal1 (a stolen email code) reads no business and no appointment and gets 42501 '
  || 'without hint from the RPCs, but still reads their own membership row (the loader needs the role)'
);

select is(
  concat_ws(' ',
    pg_temp.q($$select count(*)::text from public.businesses$$, pg_temp.otp2('O')),
    pg_temp.q($$select (private.today_summary_impl(p_business_id => {B1}) is not null)::text$$, pg_temp.otp2('O')),
    pg_temp.q($$select count(*)::text from public.business_members$$, pg_temp.otp2('O'))
      = (select count(*)::text from public.business_members m where m.business_id = pg_temp.id('B1'))),
  '1 true t',
  'D2: the same owner at aal2 (any amr; freshness is not needed for reading) reads the business, its summary and '
  || 'every member row'
);

select is(
  concat_ws(' ',
    pg_temp.q($$select count(*)::text from public.businesses$$, pg_temp.aal1('S')),
    pg_temp.q($$select count(*)::text from public.businesses$$, pg_temp.aal1('K')),
    pg_temp.q($$select count(*)::text from public.businesses$$, pg_temp.otp2('K'))),
  '1 0 1',
  'D2: staff memberships always count at aal1; an enrolled manager counts only at aal2'
);

select is(
  concat_ws(' ',
    pg_temp.push_of('O'),
    pg_temp.q($$select public.register_push_subscription(p_provider => 'onesignal',
               p_subscription_id => '0e140000-0000-4000-8000-0000000000a1')::text$$, pg_temp.aal1('O')),
    pg_temp.q($$select public.register_push_subscription(p_provider => 'onesignal',
               p_subscription_id => '0e140000-0000-4000-8000-0000000000a2')::text$$, pg_temp.aal1('MM')),
    pg_temp.q($$select public.unregister_push_subscription(p_all => true)::text$$, pg_temp.aal1('O')),
    pg_temp.q($$select public.unregister_push_subscription(
               p_subscription_id => '0e140000-0000-4000-8000-000000000001')::text$$, pg_temp.aal1('O')),
    pg_temp.push_of('O'), pg_temp.push_of('MM'),
    (select count(*) from public.push_subscriptions s
     where s.subscription_id in ('0e140000-0000-4000-8000-0000000000a1', '0e140000-0000-4000-8000-0000000000a2'))),
  '1 42501 42501 42501 42501 1 0 0',
  'D2 covers the push devices: at aal1 an enrolled owner, and a user who is staff here but an enrolled owner '
  || 'elsewhere (MM), cannot register a device (it would receive the bookings of every business of the user) '
  || 'nor unregister any, all or one (42501 without hint); nothing changed'
);

select is(
  concat_ws(' ',
    pg_temp.q($$select public.register_push_subscription(p_provider => 'onesignal',
               p_subscription_id => '0e140000-0000-4000-8000-0000000000a1') ->> 'moved'$$, pg_temp.otp2('O')),
    pg_temp.push_of('O'),
    pg_temp.q($$select public.unregister_push_subscription(
               p_subscription_id => '0e140000-0000-4000-8000-0000000000a1')::text$$, pg_temp.otp2('O')),
    pg_temp.push_of('O'),
    pg_temp.q($$select public.register_push_subscription(p_provider => 'onesignal',
               p_subscription_id => '0e140000-0000-4000-8000-0000000000a3') ->> 'moved'$$, pg_temp.aal1('S'))),
  'false 2 1 1 false',
  'D2 and push: the same owner at aal2 registers and unregisters a device; staff still register at aal1'
);

-- =============================================================================================
-- 10. private.factor_change_grants is closed to every API role (also in 01_security)
-- =============================================================================================
select is(
  concat_ws(' ',
    (select c.relrowsecurity from pg_class c where c.oid = 'private.factor_change_grants'::regclass),
    (select count(*) from pg_policies p where p.schemaname = 'private' and p.tablename = 'factor_change_grants'),
    (select count(*) from unnest(array['anon', 'authenticated', 'service_role', 'public']) as r (role_name)
     where has_table_privilege(r.role_name, 'private.factor_change_grants',
                               'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r.role_name, 'private.factor_change_grants', 'SELECT,INSERT,UPDATE,REFERENCES'))),
  't 0 0',
  'private.factor_change_grants: RLS on, no policy, no privilege for anon, authenticated, service_role or PUBLIC'
);

select * from finish();
rollback;
