-- Security hardening before 1.10 (contract docs/plans/contracts/1.9b-security-hardening.md §2 and §6.1;
-- ADR-0009 residual risks). Written from the contract only (independent author).
--   A. D2 needs a live session: private.session_mfa_ok() also requires the JWT's session_id in auth.sessions
--      (owner/manager rows, every RPC, the push devices of every role); staff rows need it too (§7 item 2,
--      the alternative approved on 2026-10-04: each of the six helpers, after «all devices», a demotion
--      and a removal); one probe per statement; a JWT without session_id keeps the 0009 rule (and so do
--      cron, anon and service_role); malformed and foreign session ids; first enrolment;
--      require_fresh_totp refuses a dead session without hint; the structure of the helpers
--   B. the notification bundle gains account_email and businesses (the Nous copy, §2.4.5)
--   C. the enrolment block: pending before detection (C2), written by the detector (step 6b), what it
--      does (AN034, no owner/manager rows, grants never match), cleared only by mfa_reset (C4), also for
--      a blocked user who is owner/manager nowhere any more (§7 item 17, the alternative approved on
--      2026-10-04), retention and cascade, the new RPC factor_enrolment_blocked and the new table
-- Conventions (as 16_health):
--   · The baseline detector run comes first: it absorbs any pending change of real users and keeps the
--     detector's advisory lock for the rest of this transaction. Every assertion filters by the fixture
--     users. Detector runs use the clocks pg_temp.p(k) = now() + 10·k s; the bundle section uses fixed
--     clocks in 2003 (pg_temp.t), so its event is the oldest pending one when it is claimed.
--   · Factors, sessions, grants, snapshot rows and GoTrue audit entries are synthetic rows written as
--     postgres; no real secret is read anywhere. The nudge goes to a sentinel URL and never leaves the
--     transaction (pg_net sends only after commit).
--   · Claims: pg_temp.s1/s2 carry a session_id (aal1 / aal2 with a code 1 minute old), pg_temp.aal1/aal2
--     carry none (pgTAP's synthetic claims). Outcomes: the value, '<null>', the SQLSTATE, '<state>/<hint>'
--     when an error carries a hint of ours, 'P0001/<code>/<name>' for a domain error. A bare '42501' is
--     a refusal WITHOUT hint (the PWA never opens the code sheet for it).
--   · An action and the reads of its effects are separate statements (a stable read sees the snapshot of
--     its statement). concat_ws prints booleans as t/f; ::text prints true/false.
--   · Review fixes (contract §8 «Review fixes»): the bundle lists the event's businesses even where the
--     user is no member (EV_OX); step 6b keeps the block and writes no audit row on a second unauthorized
--     removal of an already-blocked user (U4, run 3); the reset ends every session of the user in its
--     transaction, so a session opened while blocked never sees the block lifted (S_U1r).
--   · Approved alternatives (contract §7, 2026-10-04): item 2 (SD demoted and SX removed through the D1
--     trigger, S after «all devices»; the call counts of pg_stat_xact_user_functions show one probe per
--     statement, skipped where track_functions cannot be set); item 17 (SB demoted to staff, RB removed
--     everywhere, each with a block row written as the detector would; U8 blocked by hand with no event
--     and no membership).
--   · Review fixes of the approved alternatives (contract §8.7): the audit businesses of a blocked user who is
--     owner/manager nowhere come from its current memberships (SN, no event) and its removal event (SE), each
--     once; a demotion committing during a reset (RM: injected through stand-ins of two private helpers,
--     restored right after) never leaves the reset unrecorded.
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
-- Fixtures are written by the system; pg_temp.q declares '' around every API call.
select set_config('anaklo.actor_type', 'system', true);
select plan(83);

-- ---------------------------------------------------------------------------------------------
-- Labels
-- ---------------------------------------------------------------------------------------------
create temporary table lbl (id uuid primary key, label text not null unique);

insert into pg_temp.lbl (id, label) values
  -- users
  ('e1700000-0000-4000-8000-000000000001', 'O'),     -- owner B1 (F_O), session S_O, push device
  ('e1700000-0000-4000-8000-000000000002', 'M'),     -- manager B1 (F_M), sessions S_M1, S_M2
  ('e1700000-0000-4000-8000-000000000003', 'S'),     -- staff B1 (staff row SS, appointment AP1), session S_S
  ('e1700000-0000-4000-8000-000000000004', 'P'),     -- owner B2 without a factor, session S_P
  ('e1700000-0000-4000-8000-000000000005', 'MS'),    -- staff B1 + owner B2 (F_MS), session S_MS
  ('e1700000-0000-4000-8000-000000000006', 'OM'),    -- manager B1 + owner B2 (bundle order)
  ('e1700000-0000-4000-8000-000000000007', 'NE'),    -- no email, no membership (bundle)
  ('e1700000-0000-4000-8000-000000000008', 'SD'),    -- manager B1 without a factor, demoted to staff (§A)
  ('e1700000-0000-4000-8000-000000000009', 'SX'),    -- staff B1 + staff B2, removed from B2 (§A)
  ('e1700000-0000-4000-8000-000000000019', 'SB'),    -- manager B1, blocked, demoted to staff (§C item 17)
  ('e1700000-0000-4000-8000-00000000001a', 'RB'),    -- manager B2, blocked, removed everywhere (§C item 17)
  ('e1700000-0000-4000-8000-00000000001b', 'SN'),    -- manager B1, blocked with no event, demoted (§C item 17)
  ('e1700000-0000-4000-8000-00000000001c', 'SE'),    -- owner B2 + manager B1, blocked, then staff of B2 only
  ('e1700000-0000-4000-8000-00000000001d', 'RM'),    -- manager B1 only, demoted while Nous resets it (§C)
  ('e1700000-0000-4000-8000-000000000010', 'U1'),    -- managers of B1 for section C; U1 also staff of B2
  ('e1700000-0000-4000-8000-000000000011', 'U2'),
  ('e1700000-0000-4000-8000-000000000012', 'U2b'),   -- also owner of B2 (two businesses)
  ('e1700000-0000-4000-8000-000000000013', 'U3'),
  ('e1700000-0000-4000-8000-000000000014', 'U4'),
  ('e1700000-0000-4000-8000-000000000015', 'U5'),
  ('e1700000-0000-4000-8000-000000000016', 'U6'),
  ('e1700000-0000-4000-8000-000000000017', 'U7'),
  ('e1700000-0000-4000-8000-000000000018', 'U8'),
  -- businesses (name, slug and id order agree: an event order [B2, B1] differs from all three)
  ('e1710000-0000-4000-8000-000000000001', 'B1'),
  ('e1710000-0000-4000-8000-000000000002', 'B2'),
  ('e1710000-0000-4000-8000-0000000000ff', 'NOSHOP'),  -- never inserted
  -- staff row, clients, appointment
  ('e1720000-0000-4000-8000-000000000001', 'SS'),
  ('e1770000-0000-4000-8000-000000000001', 'CL1'),
  ('e1770000-0000-4000-8000-000000000002', 'CL2'),
  ('e1770000-0000-4000-8000-000000000010', 'AP1'),
  -- factors in the snapshot from the start
  ('e1730000-0000-4000-8000-000000000001', 'F_O'),
  ('e1730000-0000-4000-8000-000000000002', 'F_M'),
  ('e1730000-0000-4000-8000-000000000003', 'F_MS'),
  ('e1730000-0000-4000-8000-000000000010', 'F_U1'),
  ('e1730000-0000-4000-8000-000000000011', 'F_U2'),
  ('e1730000-0000-4000-8000-000000000012', 'F_U2b'),
  ('e1730000-0000-4000-8000-000000000013', 'F_U3a'),
  ('e1730000-0000-4000-8000-000000000014', 'F_U3b'),
  ('e1730000-0000-4000-8000-000000000015', 'F_U4a'),
  ('e1730000-0000-4000-8000-000000000017', 'F_U5a'),
  ('e1730000-0000-4000-8000-000000000019', 'F_U6'),
  ('e1730000-0000-4000-8000-00000000001b', 'F_U8'),
  -- factors added later
  ('e1730000-0000-4000-8000-000000000016', 'F_U4n'),   -- no grant
  ('e1730000-0000-4000-8000-000000000018', 'F_U5n'),   -- inside U5's add grant
  ('e1730000-0000-4000-8000-00000000001a', 'F_U7'),    -- transient (GoTrue's audit log only)
  ('e1730000-0000-4000-8000-00000000001c', 'F_U1x'),   -- enrolled straight at GoTrue while blocked
  -- ids only
  ('e1730000-0000-4000-8000-000000000020', 'F_RGX'),
  ('e1730000-0000-4000-8000-000000000030', 'F_EVO'),
  ('e1730000-0000-4000-8000-000000000031', 'F_EVMS'),
  ('e1730000-0000-4000-8000-000000000032', 'F_EVOM'),
  ('e1730000-0000-4000-8000-000000000033', 'F_EVNS'),
  ('e1730000-0000-4000-8000-000000000034', 'F_EVNE'),
  ('e1730000-0000-4000-8000-000000000035', 'F_EVOX'),
  ('e1730000-0000-4000-8000-000000000036', 'F_EVSB'),
  ('e1730000-0000-4000-8000-000000000037', 'F_EVRB'),
  ('e1730000-0000-4000-8000-000000000038', 'F_EVSE'),
  -- grants written directly (the others are labelled when written)
  ('e1740000-0000-4000-8000-000000000001', 'G_U1'),
  ('e1740000-0000-4000-8000-000000000002', 'G_U5'),
  ('e1740000-0000-4000-8000-000000000003', 'GR_U2'),
  ('e1740000-0000-4000-8000-000000000004', 'GR_U2b'),
  -- the remove-grant rule probes: RG3 is created earlier than RG2 but has the larger id and the later
  -- expiry and is inserted second (only the (created_at, id) order picks it)
  ('e1740000-0000-4000-8000-000000000010', 'RG1'),
  ('e1740000-0000-4000-8000-000000000011', 'RG2'),
  ('e1740000-0000-4000-8000-000000000012', 'RG3'),
  ('e1740000-0000-4000-8000-000000000013', 'RG4'),
  ('e1740000-0000-4000-8000-000000000014', 'RG5'),
  -- security events written directly (section B)
  ('e1750000-0000-4000-8000-000000000001', 'EV_O'),
  ('e1750000-0000-4000-8000-000000000002', 'EV_MS'),
  ('e1750000-0000-4000-8000-000000000003', 'EV_OM'),
  ('e1750000-0000-4000-8000-000000000004', 'EV_NS'),
  ('e1750000-0000-4000-8000-000000000005', 'EV_NE'),
  ('e1750000-0000-4000-8000-000000000006', 'EV_OX'),
  ('e1750000-0000-4000-8000-000000000007', 'EV_SB'),
  ('e1750000-0000-4000-8000-000000000008', 'EV_RB'),
  ('e1750000-0000-4000-8000-000000000009', 'EV_SE'),
  -- sessions
  ('e1760000-0000-4000-8000-000000000001', 'S_O'),
  ('e1760000-0000-4000-8000-000000000002', 'S_M1'),
  ('e1760000-0000-4000-8000-000000000003', 'S_M2'),
  ('e1760000-0000-4000-8000-000000000004', 'S_S'),
  ('e1760000-0000-4000-8000-000000000005', 'S_P'),
  ('e1760000-0000-4000-8000-000000000006', 'S_MS'),
  ('e1760000-0000-4000-8000-000000000010', 'S_U1a'),
  ('e1760000-0000-4000-8000-000000000011', 'S_U2'),
  ('e1760000-0000-4000-8000-000000000012', 'S_U1b'),
  ('e1760000-0000-4000-8000-000000000013', 'S_U4'),
  ('e1760000-0000-4000-8000-000000000014', 'S_U1x'),
  ('e1760000-0000-4000-8000-000000000015', 'S_U1c'),
  ('e1760000-0000-4000-8000-000000000016', 'S_U1r'),   -- opened while U1 is blocked (review fix)
  ('e1760000-0000-4000-8000-000000000017', 'S_U4b'),
  ('e1760000-0000-4000-8000-000000000018', 'S_SD'),
  ('e1760000-0000-4000-8000-000000000019', 'S_SX'),
  ('e1760000-0000-4000-8000-00000000001a', 'S_SB'),    -- opened while SB is blocked and staff only
  ('e1760000-0000-4000-8000-00000000001b', 'S_SBn'),   -- after SB's reset
  ('e1760000-0000-4000-8000-00000000001c', 'S_SN'),
  ('e1760000-0000-4000-8000-00000000001d', 'S_SE'),
  ('e1760000-0000-4000-8000-00000000001e', 'S_RM'),
  ('e1760000-0000-4000-8000-0000000000ff', 'S_GONE');  -- never inserted

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

-- The label of an id given as text, the text itself otherwise.
create function pg_temp.lt(a_text text)
returns text
language sql
stable
as $fn$
  select case when a_text is null then '<null>'
              else coalesce((select x.label from pg_temp.lbl x where x.id::text = lower(a_text)), a_text) end;
$fn$;

-- The fixture users.
create function pg_temp.fxu()
returns setof uuid
language sql
stable
as $fn$
  select x.id from pg_temp.lbl x where x.id::text like 'e1700000-%';
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

create function pg_temp.keys(a_object jsonb)
returns text[]
language sql
immutable
as $fn$
  select array_agg(k order by k) from jsonb_object_keys(a_object) as k;
$fn$;

-- Clocks: the detector runs, the snapshot's last run, the bundle section.
create function pg_temp.p(a_k integer)
returns timestamptz
language sql
stable
as $fn$
  select now() + make_interval(secs => 10 * a_k);
$fn$;

-- 'p<k>' when a_ts is one of the detector clocks, else the instant.
create function pg_temp.pl(a_ts timestamptz)
returns text
language sql
stable
as $fn$
  select coalesce((select 'p' || k::text from generate_series(0, 20) as k where pg_temp.p(k) = a_ts limit 1),
                  a_ts::text);
$fn$;

-- last_seen_at of every snapshot row written by this file (the run before the fixtures, 5′ ago)
create function pg_temp.ls()
returns timestamptz
language sql
stable
as $fn$
  select now() - interval '5 minutes';
$fn$;

create function pg_temp.t(a_seconds integer)
returns timestamptz
language sql
immutable
as $fn$
  select '2003-03-03 10:00:00+00'::timestamptz + make_interval(secs => a_seconds);
$fn$;

-- Whole epoch seconds a_seconds before now() of the transaction.
create function pg_temp.ago(a_seconds integer)
returns bigint
language sql
stable
as $fn$
  select floor(extract(epoch from now()))::bigint - a_seconds;
$fn$;

-- JWT claims. a_totp_age null → the email code only; else a code a_totp_age seconds old (and the
-- email code an hour ago). a_session: a label, a raw value, or null (no session_id at all).
create function pg_temp.cl(a_user text, a_aal text, a_totp_age integer, a_session text)
returns text
language sql
stable
as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    'sub', pg_temp.id(a_user), 'role', 'authenticated', 'aal', a_aal,
    'session_id', case when a_session is null then null else coalesce(pg_temp.id(a_session)::text, a_session) end,
    'amr', case when a_totp_age is null
                then jsonb_build_array(jsonb_build_object('method', 'otp', 'timestamp', pg_temp.ago(0)))
                else jsonb_build_array(
                       jsonb_build_object('method', 'totp', 'timestamp', pg_temp.ago(a_totp_age)),
                       jsonb_build_object('method', 'otp', 'timestamp', pg_temp.ago(3600))) end))::text;
$fn$;

-- with a session_id: aal1 (email code) / aal2 with a code 1 minute old
create function pg_temp.s1(a_user text, a_session text) returns text language sql stable as $fn$
  select pg_temp.cl(a_user, 'aal1', null, a_session);
$fn$;

create function pg_temp.s2(a_user text, a_session text) returns text language sql stable as $fn$
  select pg_temp.cl(a_user, 'aal2', 60, a_session);
$fn$;

-- without session_id (synthetic claims)
create function pg_temp.aal1(a_user text) returns text language sql stable as $fn$
  select pg_temp.cl(a_user, 'aal1', null, null);
$fn$;

create function pg_temp.aal2(a_user text) returns text language sql stable as $fn$
  select pg_temp.cl(a_user, 'aal2', 60, null);
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
    -- A missing privilege carries the server's own advice ("Grant the required privileges …"); that is
    -- not a hint of ours and is reported as the bare code. Every other hint is reported.
    v_hint := case when v_hint like 'Grant the required privileges to the current role with: GRANT %' then ''
                   else coalesce(v_hint, '') end;
    v := case
      when v_state = 'P0001' then 'P0001/' || v_msg || case when v_hint <> '' then '/' || v_hint else '' end
      when v_hint <> '' then v_state || '/' || v_hint
      else v_state
    end;
  end;
  execute 'set local role postgres';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('anaklo.actor_type', 'system', true);
  return v;
end;
$fn$;

-- Keeps a JSON answer in tj.<a_key> and returns 'ok'; any other outcome is returned as is.
create function pg_temp.keep(a_key text, a_outcome text)
returns text
language plpgsql
as $fn$
begin
  if left(a_outcome, 1) in ('{', '[') then
    perform set_config('tj.' || a_key, a_outcome, true);
    return 'ok';
  end if;
  perform set_config('tj.' || a_key, '', true);
  return a_outcome;
end;
$fn$;

create function pg_temp.r(a_key text)
returns jsonb
language sql
stable
as $fn$
  select nullif(current_setting('tj.' || a_key, true), '')::jsonb;
$fn$;

-- What a caller reads (as the given claims): the slugs of the businesses, the client names, the
-- number of appointments.
create function pg_temp.biz(a_claims text) returns text language sql as $fn$
  select pg_temp.q($$select coalesce(string_agg(b.slug, ',' order by b.slug), '-') from public.businesses b$$, a_claims);
$fn$;

create function pg_temp.cli(a_claims text) returns text language sql as $fn$
  select pg_temp.q($$select coalesce(string_agg(c.full_name, ',' order by c.full_name), '-') from public.clients c$$,
                   a_claims);
$fn$;

create function pg_temp.apps(a_claims text) returns text language sql as $fn$
  select pg_temp.q($$select count(*)::text from public.appointments a$$, a_claims);
$fn$;

create function pg_temp.today(a_claims text) returns text language sql as $fn$
  select pg_temp.q($$select (public.today_summary(p_business_id => {B1}) is not null)::text$$, a_claims);
$fn$;

create function pg_temp.afc_add(a_claims text) returns text language sql as $fn$
  select pg_temp.q($$select public.authorize_factor_change(p_action => 'add')::text$$, a_claims);
$fn$;

create function pg_temp.fb(a_claims text) returns text language sql as $fn$
  select pg_temp.q($$select public.factor_enrolment_blocked()::text$$, a_claims);
$fn$;

-- register_push_subscription of a OneSignal id: its 'moved' flag, or the error
create function pg_temp.reg(a_claims text, a_subscription text) returns text language sql as $fn$
  select pg_temp.q(format($$select public.register_push_subscription(p_provider => 'onesignal', $$
                          || $$p_subscription_id => %L) ->> 'moved'$$, a_subscription), a_claims);
$fn$;

-- A comma list of uuids as labels (in its order); any other text as it is.
create function pg_temp.ll(a_text text)
returns text
language sql
stable
as $fn$
  select case
    when a_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*$'
    then (select string_agg(pg_temp.lt(u.x), ',' order by u.o)
          from unnest(string_to_array(a_text, ',')) with ordinality as u (x, o))
    else coalesce(a_text, '<null>') end;
$fn$;

-- The six membership helpers as the caller (§A, item 2): '<my_business_ids> <my_business_ids_with_role(staff)>
-- <my_staff_ids> <is_member(B1)> <has_role(B1, staff)> <my_staff_id(B1)>', ids as labels, '-' for an empty set.
create function pg_temp.helpers(a_claims text) returns text language sql as $fn$
  select concat_ws(' ',
    pg_temp.ll(pg_temp.q($$select coalesce(string_agg(x::text, ',' order by x::text), '-')
                           from private.my_business_ids() as x$$, a_claims)),
    pg_temp.ll(pg_temp.q($$select coalesce(string_agg(x::text, ',' order by x::text), '-')
                           from private.my_business_ids_with_role(array['staff']) as x$$, a_claims)),
    pg_temp.ll(pg_temp.q($$select coalesce(string_agg(x::text, ',' order by x::text), '-')
                           from private.my_staff_ids() as x$$, a_claims)),
    pg_temp.q($$select private.is_member({B1})::text$$, a_claims),
    pg_temp.q($$select private.has_role({B1}, array['staff'])::text$$, a_claims),
    pg_temp.ll(pg_temp.q($$select private.my_staff_id({B1})::text$$, a_claims)));
$fn$;

-- Function call counts of this transaction (track_functions = 'all'): one probe of auth.sessions per
-- call of session_alive. pg_temp.track() turns the counting on where the role may (locally it may;
-- elsewhere the count assertion is skipped).
create function pg_temp.track()
returns boolean
language plpgsql
as $fn$
begin
  set local track_functions = 'all';
  return current_setting('track_functions') = 'all';
exception when others then
  return false;
end;
$fn$;

create function pg_temp.calls(a_name text)
returns bigint
language sql
volatile
as $fn$
  select coalesce(sum(f.calls), 0)::bigint
  from pg_stat_xact_user_functions f
  where f.schemaname = 'private' and f.funcname = a_name;
$fn$;

-- What a caller reads of public.businesses, and how many times that one statement called
-- my_business_ids (the RLS policy), session_alive (a probe each) and session_mfa_ok.
create function pg_temp.probes(a_claims text)
returns text
language plpgsql
as $fn$
declare
  v_helper bigint := pg_temp.calls('my_business_ids');
  v_alive bigint := pg_temp.calls('session_alive');
  v_mfa bigint := pg_temp.calls('session_mfa_ok');
  v text;
begin
  v := pg_temp.biz(a_claims);
  return concat_ws(' ', v,
    'helper=' || (pg_temp.calls('my_business_ids') - v_helper)::text,
    'alive=' || (pg_temp.calls('session_alive') - v_alive)::text,
    'mfa_ok=' || (pg_temp.calls('session_mfa_ok') - v_mfa)::text);
end;
$fn$;

-- Vault upsert (update when the name exists, else create).
create function pg_temp.set_vault(a_name text, a_value text)
returns void
language plpgsql
as $fn$
declare
  v_id uuid;
begin
  select s.id into v_id from vault.secrets s where s.name = a_name;
  if v_id is null then
    perform vault.create_secret(a_value, a_name, 'pgTAP 17_security_hardening');
  else
    perform vault.update_secret(v_id, a_value, a_name, 'pgTAP 17_security_hardening');
  end if;
end;
$fn$;

-- A factor written as GoTrue would (synthetic secret, explicit created_at). a_seen not null = also a
-- snapshot row (a factor the last detector run saw, first_seen_at = last_seen_at = a_seen).
create function pg_temp.factor(a_label text, a_user text, a_verified boolean, a_created timestamptz,
                               a_seen timestamptz default null)
returns void
language plpgsql
as $fn$
begin
  execute format(
    'insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) '
    || 'values (%L, %L, %L, %L, %L, %L, %L, %L)',
    pg_temp.id(a_label), pg_temp.id(a_user), 'pgTAP 17 ' || a_label, 'totp',
    case when a_verified then 'verified' else 'unverified' end, a_created, a_created,
    'PGTAPSYNTHETICSECRET' || upper(replace(a_label, '_', '')));
  if a_seen is not null then
    insert into private.mfa_factor_snapshot (factor_id, user_id, factor_created_at, first_seen_at, last_seen_at)
    values (pg_temp.id(a_label), pg_temp.id(a_user), a_created, a_seen, a_seen);
  end if;
end;
$fn$;

-- A session row as GoTrue keeps it (aal, the factor of the last verify).
create function pg_temp.session(a_label text, a_user text, a_aal text, a_factor text default null)
returns void
language sql
as $fn$
  insert into auth.sessions (id, user_id, created_at, updated_at, aal, factor_id)
  values (pg_temp.id(a_label), pg_temp.id(a_user), now() - interval '1 hour', now(), a_aal::auth.aal_level,
          pg_temp.id(a_factor));
$fn$;

-- A grant through the only writer (created now(), valid 10 minutes), labelled.
create function pg_temp.wgrant(a_label text, a_user text, a_action text, a_factor text, a_source text)
returns void
language plpgsql
as $fn$
begin
  insert into pg_temp.lbl (id, label)
  values (private.write_factor_grant(pg_temp.id(a_user), a_action, pg_temp.id(a_factor), a_source), a_label);
end;
$fn$;

-- A grant written directly (fixture), with explicit instants.
create function pg_temp.dgrant(a_label text, a_user text, a_action text, a_factor text, a_source text,
                               a_created timestamptz, a_expires timestamptz, a_matched timestamptz default null)
returns void
language sql
as $fn$
  insert into private.factor_change_grants (id, user_id, action, factor_id, source, created_at, expires_at, matched_at)
  values (pg_temp.id(a_label), pg_temp.id(a_user), a_action, pg_temp.id(a_factor), a_source, a_created, a_expires,
          a_matched);
$fn$;

-- A security event written directly (pending); business_ids in the order given.
create function pg_temp.ev(a_label text, a_user text, a_kind text, a_factor text, a_detected timestamptz,
                           a_businesses text[])
returns void
language sql
as $fn$
  insert into private.security_events (id, user_id, kind, factor_id, factor_created_at, business_ids, detected_at)
  values (pg_temp.id(a_label), pg_temp.id(a_user), a_kind, pg_temp.id(a_factor), a_detected - interval '1 day',
          coalesce((select array_agg(pg_temp.id(b.label) order by b.o)
                    from unnest(a_businesses) with ordinality as b (label, o)), '{}'::uuid[]),
          a_detected);
$fn$;

-- An audit entry as GoTrue writes it (auth.audit_log_entries): action, the acting user, traits.factor_id.
create function pg_temp.gotrue_audit(a_action text, a_user text, a_factor text, a_at timestamptz)
returns void
language sql
as $fn$
  insert into auth.audit_log_entries (instance_id, id, payload, created_at, ip_address)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
          json_build_object('action', a_action, 'actor_id', pg_temp.id(a_user), 'log_type', 'factor',
                            'traits', json_build_object('factor_id', pg_temp.id(a_factor)::text)),
          a_at, '');
$fn$;

-- One detector run at a clock: '<returned> | <its job_runs rows> | <sources of its nudges or ->'.
create function pg_temp.detect(a_now timestamptz)
returns text
language plpgsql
as $fn$
declare
  v_runs bigint := coalesce((select max(j.id) from private.job_runs j), 0);
  v_queue bigint := coalesce((select max(q.id) from net.http_request_queue q), 0);
  v integer;
begin
  perform set_config('anaklo.dispatch_nudged', '', true);
  begin
    v := private.detect_factor_changes_impl(a_now);
  exception when others then
    return 'raised ' || sqlstate;
  end;
  return concat_ws(' | ',
    coalesce(v::text, 'null'),
    coalesce((select string_agg(concat_ws(' ', j.job, j.ok::text, coalesce(j.rows_affected::text, '-'),
                                          coalesce(j.error, '-')), ', ' order by j.id)
              from private.job_runs j
              where j.id > v_runs and j.job = 'detect_factor_changes'), 'no run'),
    coalesce((select string_agg(convert_from(q.body, 'UTF8')::jsonb ->> 'source', ',' order by q.id)
              from net.http_request_queue q
              where q.id > v_queue and q.url = 'http://127.0.0.1:9/pgtap-17-nudge'), '-'));
end;
$fn$;

-- The purge at a clock: '<returned> | <its job_runs rows>'.
create function pg_temp.purge(a_now timestamptz)
returns text
language plpgsql
as $fn$
declare
  v_runs bigint := coalesce((select max(j.id) from private.job_runs j), 0);
  v integer;
begin
  v := private.purge_impl(a_now);
  return concat_ws(' | ',
    coalesce(v::text, 'null'),
    coalesce((select string_agg(concat_ws(' ', j.job, j.ok::text, coalesce(j.rows_affected::text, '-'),
                                          coalesce(j.error, '-')), ', ' order by j.id)
              from private.job_runs j
              where j.id > v_runs and j.job = 'purge'), 'no run'));
end;
$fn$;

-- Events of a user: '<kind>:<factor>:<status>:<attempts>:<business_ids in order>', by kind and factor.
create function pg_temp.events_of(a_user text)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(concat_ws(':', e.kind, pg_temp.l(e.factor_id), e.status, e.attempts::text,
                                       coalesce((select string_agg(pg_temp.l(b.id), ',' order by b.o)
                                                 from unnest(e.business_ids) with ordinality as b (id, o)), '-')),
                             ' ' order by e.kind, pg_temp.l(e.factor_id)), '-')
  from private.security_events e
  where e.user_id = pg_temp.id(a_user);
$fn$;

-- Grants of a user (one source, or all): '<action>:<factor>:<open|matched|matched@other>' where
-- matched = matched_at equals a_matched_at.
create function pg_temp.grants_of(a_user text, a_source text, a_matched_at timestamptz default null)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(g.action || ':' || pg_temp.l(g.factor_id) || ':'
                             || case when g.matched_at is null then 'open'
                                     when g.matched_at = a_matched_at then 'matched'
                                     else 'matched@other' end,
                             ',' order by g.action, pg_temp.l(g.factor_id), g.created_at, g.id), '-')
  from private.factor_change_grants g
  where g.user_id = pg_temp.id(a_user) and (a_source is null or g.source = a_source);
$fn$;

create function pg_temp.gstate(a_label text, a_matched_at timestamptz)
returns text
language sql
stable
as $fn$
  select coalesce((select case when g.matched_at is null then 'open'
                               when g.matched_at = a_matched_at then 'matched'
                               else 'matched@other' end
                   from private.factor_change_grants g where g.id = pg_temp.id(a_label)), '<none>');
$fn$;

create function pg_temp.sessions_of(a_user text)
returns bigint language sql stable as $fn$
  select count(*) from auth.sessions s where s.user_id = pg_temp.id(a_user);
$fn$;

create function pg_temp.push_of(a_user text)
returns bigint language sql stable as $fn$
  select count(*) from public.push_subscriptions p where p.user_id = pg_temp.id(a_user);
$fn$;

-- Audit rows of one action (optionally about one entity and/or by one actor):
-- 'business:actor_type:actor:entity:entity_id:reason', by business then id; '-' for none.
create function pg_temp.audit_rows(a_action text, a_entity text default null, a_actor text default null)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(concat_ws(':', pg_temp.l(a.business_id), a.actor_type, pg_temp.l(a.actor_id), a.entity,
                                       pg_temp.l(a.entity_id), coalesce(a.reason, '-')),
                             ',' order by pg_temp.l(a.business_id), a.id), '-')
  from public.audit_log a
  where a.action = a_action
    and (a_entity is null or a.entity_id = pg_temp.id(a_entity))
    and (a_actor is null or a.actor_id = pg_temp.id(a_actor));
$fn$;

-- 'event=<uuid>' with the event shown as '<kind>/<factor label>'.
create function pg_temp.reason(a_reason text)
returns text
language sql
stable
as $fn$
  select case
    when a_reason is null then '<null>'
    when a_reason like 'event=%' then 'event=' || coalesce(
      (select e.kind || '/' || pg_temp.l(e.factor_id) from private.security_events e
       where e.id::text = lower(substr(a_reason, 7))),
      substr(a_reason, 7))
    else a_reason end;
$fn$;

-- The block audit rows about a user, in insertion order:
-- '<business>:<action>:<actor_type>:<actor>:<entity>:<entity_id>:<reason>'.
create function pg_temp.baudit(a_user text)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(concat_ws(':', pg_temp.l(a.business_id), a.action, a.actor_type, pg_temp.l(a.actor_id),
                                       a.entity, pg_temp.l(a.entity_id), pg_temp.reason(a.reason)),
                             ',' order by a.id), '-')
  from public.audit_log a
  where a.entity_id = pg_temp.id(a_user) and a.action = 'factor_enrolment_blocked';
$fn$;

-- A user's block row: '<event as kind/factor | no-event>:<blocked_at as p<k>>', '-' for none.
create function pg_temp.block_of(a_user text)
returns text
language sql
stable
as $fn$
  select coalesce((
    select coalesce((select e.kind || '/' || pg_temp.l(e.factor_id) from private.security_events e
                     where e.id = b.event_id),
                    case when b.event_id is null then 'no-event' else 'other-event' end)
           || ':' || pg_temp.pl(b.blocked_at)
    from private.factor_enrolment_blocks b where b.user_id = pg_temp.id(a_user)), '-');
$fn$;

-- Every block row of the fixture users (user, event, instant).
create function pg_temp.blocks()
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(concat_ws(':', pg_temp.l(b.user_id), b.event_id, b.blocked_at),
                             ',' order by pg_temp.l(b.user_id)), '-')
  from private.factor_enrolment_blocks b
  where b.user_id in (select pg_temp.fxu());
$fn$;

-- Everything a refused call must leave alone: the fixture users' grants, memberships, push devices and
-- block rows, and the audit rows of the fixture businesses.
create function pg_temp.fp()
returns text
language sql
stable
as $fn$
  select md5(concat_ws('|',
    (select string_agg(concat_ws(':', g.id, g.matched_at), ',' order by g.id)
     from private.factor_change_grants g where g.user_id in (select pg_temp.fxu())),
    (select count(*) from public.audit_log a where a.business_id in (pg_temp.id('B1'), pg_temp.id('B2'))),
    (select string_agg(concat_ws(':', m.business_id, m.user_id, m.role), ',' order by m.business_id, m.user_id)
     from public.business_members m where m.user_id in (select pg_temp.fxu())),
    (select string_agg(p.id::text, ',' order by p.id)
     from public.push_subscriptions p where p.user_id in (select pg_temp.fxu())),
    pg_temp.blocks()));
$fn$;

-- claim_security_events_impl at a clock: '<claimed labels in order> more=<more>' or the error; the
-- answer is kept in tj.<a_key>.
create function pg_temp.claim(a_key text, a_limit integer, a_now timestamptz)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.claim_security_events_impl(a_limit, a_now);
  perform set_config('tj.' || a_key, v::text, true);
  return coalesce((select string_agg(pg_temp.l((x.i ->> 'id')::uuid), ',' order by x.o)
                   from jsonb_array_elements(v -> 'items') with ordinality as x (i, o)), '-')
         || ' more=' || coalesce(v ->> 'more', '<null>');
exception when others then
  return sqlstate;
end;
$fn$;

create function pg_temp.lease(a_key text, a_label text)
returns uuid
language sql
stable
as $fn$
  select (i ->> 'lease_id')::uuid
  from jsonb_array_elements(pg_temp.r(a_key) -> 'items') as i
  where (i ->> 'id')::uuid = pg_temp.id(a_label);
$fn$;

-- record_security_event_result_impl with the lease of a stored claim answer; the answer is kept in
-- tj.<a_key>. Returns the answer, or 'recorded=<…> notify <its keys>' when it carries a bundle.
create function pg_temp.res(a_key text, a_event text, a_claim text, a_outcome text, a_now timestamptz)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.record_security_event_result_impl(
         p_id => pg_temp.id(a_event), p_lease_id => pg_temp.lease(a_claim, a_event), p_outcome => a_outcome,
         p_now => a_now);
  perform set_config('tj.' || a_key, coalesce(v::text, ''), true);
  if v ? 'notify' then
    return 'recorded=' || coalesce(v ->> 'recorded', '<null>') || ' notify ' || pg_temp.keys(v)::text;
  end if;
  return coalesce(v::text, '<null>');
exception when others then
  return sqlstate;
end;
$fn$;

-- The notification bundle of an event, straight from the helper (as postgres), kept in tj.<a_key>.
create function pg_temp.bundle(a_key text, a_event text, a_at timestamptz)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.queue_security_notifications(pg_temp.id(a_event), a_at);
  perform set_config('tj.' || a_key, coalesce(v::text, ''), true);
  return 'ok';
exception when others then
  perform set_config('tj.' || a_key, '', true);
  return sqlstate;
end;
$fn$;

-- ---------------------------------------------------------------------------------------------
-- Keys and switches of this test (all inside the transaction; the rollback restores them)
-- ---------------------------------------------------------------------------------------------
select pg_temp.set_vault('dispatch_url', 'http://127.0.0.1:9/pgtap-17-nudge');
select pg_temp.set_vault('dispatch_secret', 'pgtap-17-dispatch-secret-not-a-secret-0001');
update private.platform_settings set fresh_totp_max_age_seconds = 300, push_enabled = true where id;

-- ---------------------------------------------------------------------------------------------
-- Baseline: absorbs any pending change of real users (and takes the detector's lock for the rest of
-- this transaction). Before the fixtures, so none of them is seen by it.
-- ---------------------------------------------------------------------------------------------
select ok(
  private.detect_factor_changes_impl() is not null,
  'baseline: the detector runs with its default clock (now()) and returns a count'
);
select set_config('anaklo.dispatch_nudged', '', true);
select set_config('anaklo.actor_type', 'system', true);

-- ---------------------------------------------------------------------------------------------
-- Fixture (as postgres). Never the seed (db:test:dev has none).
--   B1 'Alpha Barber 17' (el, Europe/Athens): O owner · M, OM, U1…U8 managers · S (staff row SS), MS staff
--   B2 'Beta Barber 17' (en, Europe/London): P, MS, OM, U2b owners · U1 staff
--   Verified factors already in the snapshot (created 3 days ago, last seen 5′ ago): F_O, F_M, F_MS,
--   F_U1, F_U2, F_U2b, F_U3a, F_U3b, F_U4a, F_U5a, F_U6, F_U8. NE has no email and no membership.
--   Sessions: S_O (aal2, F_O), S_M1 and S_M2 (aal2, F_M), S_S (aal1), S_P (aal1), S_MS (aal2, F_MS).
--   Clients CL1 (B1), CL2 (B2); appointment AP1 of S (B1, booked, in 2 hours); O has a push device.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select x.id, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated',
       case when x.label = 'NE' then null else lower(x.label) || '@sec17.test' end,
       '{}'::jsonb, '{}'::jsonb, now(), now()
from pg_temp.lbl x
where x.id::text like 'e1700000-%';

insert into public.businesses (id, slug, name, vertical, timezone, locale) values
  ('e1710000-0000-4000-8000-000000000001', 'sec17-a', 'Alpha Barber 17', 'barber', 'Europe/Athens', 'el'),
  ('e1710000-0000-4000-8000-000000000002', 'sec17-b', 'Beta Barber 17', 'barber', 'Europe/London', 'en');

insert into public.staff (id, business_id, display_name) values
  (pg_temp.id('SS'), pg_temp.id('B1'), 'Staff S 17');

insert into public.business_members (business_id, user_id, role, staff_id)
select pg_temp.id(m.b), pg_temp.id(m.u), m.role, pg_temp.id(m.s)
from (values
  ('B1', 'O', 'owner', null), ('B1', 'M', 'manager', null), ('B1', 'S', 'staff', 'SS'),
  ('B1', 'MS', 'staff', null), ('B1', 'OM', 'manager', null),
  ('B1', 'U1', 'manager', null), ('B1', 'U2', 'manager', null), ('B1', 'U2b', 'manager', null),
  ('B1', 'U3', 'manager', null), ('B1', 'U4', 'manager', null), ('B1', 'U5', 'manager', null),
  ('B1', 'U6', 'manager', null), ('B1', 'U7', 'manager', null), ('B1', 'U8', 'manager', null),
  ('B2', 'P', 'owner', null), ('B2', 'MS', 'owner', null), ('B2', 'OM', 'owner', null),
  ('B2', 'U2b', 'owner', null), ('B2', 'U1', 'staff', null)
) as m (b, u, role, s);

insert into public.clients (id, business_id, full_name, phone_e164, locale, source) values
  (pg_temp.id('CL1'), pg_temp.id('B1'), 'Client A', '+306970001701', 'el', 'staff'),
  (pg_temp.id('CL2'), pg_temp.id('B2'), 'Client B', '+447700900170', 'en', 'staff');

insert into public.appointments (id, business_id, staff_id, starts_at, ends_at, status, source) values
  (pg_temp.id('AP1'), pg_temp.id('B1'), pg_temp.id('SS'), now() + interval '2 hours',
   now() + interval '2 hours 30 minutes', 'booked', 'phone');

select pg_temp.factor(f.label, f.u, true, now() - interval '3 days', pg_temp.ls())
from (values
  ('F_O', 'O'), ('F_M', 'M'), ('F_MS', 'MS'), ('F_U1', 'U1'), ('F_U2', 'U2'), ('F_U2b', 'U2b'),
  ('F_U3a', 'U3'), ('F_U3b', 'U3'), ('F_U4a', 'U4'), ('F_U5a', 'U5'), ('F_U6', 'U6'), ('F_U8', 'U8')
) as f (label, u);

select pg_temp.session(s.label, s.u, s.aal, s.factor)
from (values
  ('S_O', 'O', 'aal2', 'F_O'), ('S_M1', 'M', 'aal2', 'F_M'), ('S_M2', 'M', 'aal2', 'F_M'),
  ('S_S', 'S', 'aal1', null), ('S_P', 'P', 'aal1', null), ('S_MS', 'MS', 'aal2', 'F_MS')
) as s (label, u, aal, factor);

insert into public.push_subscriptions (user_id, provider, subscription_id, created_at) values
  (pg_temp.id('O'), 'onesignal', '17e0f000-0000-4000-8000-000000000001', now() - interval '1 hour');

-- =============================================================================================
-- A. D2 needs a live session (§0 A1–A5, §2.3, §2.4.2–3)
-- =============================================================================================

-- Structure: the six helpers check the session for every role (§7 item 2, approved): every row needs
-- (select private.session_alive()) (it depends on no row: a one-time filter, one probe per helper and
-- statement), and an owner/manager row also (select private.mfa_level_ok()) past `m.role = 'staff' or`;
-- session_mfa_ok (which would probe the session a second time) is no longer called by them; still SECURITY
-- DEFINER, stable, and executable by authenticated and service_role only.
select is(
  (select string_agg(f.sig || '=' || concat_ws('/',
            position('and (select private.session_alive()) and'
                     in regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g')) > 0,
            position('(m.role = ''staff'' or (select private.mfa_level_ok()))'
                     in regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g')) > 0,
            position('session_mfa_ok' in pg_get_functiondef(p.oid)) = 0,
            p.prosecdef, p.provolatile::text,
            (select string_agg(r.role_name, ',' order by r.role_name)
             from unnest(array['anon', 'authenticated', 'service_role']) as r (role_name)
             where has_function_privilege(r.role_name, p.oid, 'execute'))), ' ' order by f.o)
   from unnest(array[
     'private.my_business_ids()', 'private.my_business_ids_with_role(text[])', 'private.my_staff_ids()',
     'private.is_member(uuid)', 'private.has_role(uuid, text[])', 'private.my_staff_id(uuid)'])
     with ordinality as f (sig, o)
   join pg_proc p on p.oid = to_regprocedure(f.sig)),
  'private.my_business_ids()=t/t/t/t/s/authenticated,service_role '
  || 'private.my_business_ids_with_role(text[])=t/t/t/t/s/authenticated,service_role '
  || 'private.my_staff_ids()=t/t/t/t/s/authenticated,service_role '
  || 'private.is_member(uuid)=t/t/t/t/s/authenticated,service_role '
  || 'private.has_role(uuid, text[])=t/t/t/t/s/authenticated,service_role '
  || 'private.my_staff_id(uuid)=t/t/t/t/s/authenticated,service_role',
  'the six membership helpers: every row through (select private.session_alive()), owner/manager rows also '
  || 'through (select private.mfa_level_ok()), session_mfa_ok no longer called; SECURITY DEFINER, stable, grants kept'
);

select is(
  (select concat_ws(' ', p.provolatile::text, p.prosecdef, format_type(p.prorettype, null),
                    pg_get_function_identity_arguments(p.oid) = '')
   from pg_proc p where p.oid = to_regprocedure('private.session_mfa_ok()')),
  's t boolean t',
  'session_mfa_ok() stays stable, SECURITY DEFINER, boolean, without arguments'
);

select is(
  (select string_agg(f.sig || '=' || coalesce(format_type(p.prorettype, null) || '/' || p.provolatile::text || '/'
                                              || case when p.prosecdef then 'definer' else 'invoker' end, 'missing'),
                     ' ' order by f.o)
   from unnest(array['private.session_alive()', 'private.remove_grant_for(uuid, uuid, timestamptz)',
                     'private.unauthorized_removal_pending(uuid)', 'private.enrolment_blocked(uuid)',
                     'private.mfa_level_ok()'])
          with ordinality as f (sig, o)
   left join pg_proc p on p.oid = to_regprocedure(f.sig)),
  'private.session_alive()=boolean/s/invoker private.remove_grant_for(uuid, uuid, timestamptz)=uuid/s/invoker '
  || 'private.unauthorized_removal_pending(uuid)=boolean/s/invoker private.enrolment_blocked(uuid)=boolean/s/invoker '
  || 'private.mfa_level_ok()=boolean/s/invoker',
  'the five new helpers (mfa_level_ok with the approved item 2) exist with their signatures, stable and SECURITY '
  || 'INVOKER'
);

select is(
  (select coalesce(string_agg(r.role_name || ' ' || f.sig, ', ' order by r.role_name, f.sig), 'none')
   from unnest(array['private.session_alive()', 'private.remove_grant_for(uuid, uuid, timestamptz)',
                     'private.unauthorized_removal_pending(uuid)', 'private.enrolment_blocked(uuid)',
                     'private.mfa_level_ok()']) as f (sig)
   cross join unnest(array['anon', 'authenticated', 'service_role']) as r (role_name)
   where to_regprocedure(f.sig) is not null
     and has_function_privilege(r.role_name, to_regprocedure(f.sig), 'execute')),
  'none',
  'no API role may execute session_alive, remove_grant_for, unauthorized_removal_pending, enrolment_blocked or '
  || 'mfa_level_ok'
);

-- One probe per statement (§7 item 2): a read of public.businesses calls my_business_ids once (its RLS
-- policy), and that call probes the session exactly once, whatever the user's roles (staff only, owner only,
-- both) and whatever the plan; session_mfa_ok, which would probe it a second time, is not called.
select case when pg_temp.track() then
  is(
    concat_ws(' | ', pg_temp.probes(pg_temp.s1('S', 'S_S')), pg_temp.probes(pg_temp.s2('O', 'S_O')),
              pg_temp.probes(pg_temp.s2('MS', 'S_MS')), pg_temp.probes(pg_temp.aal1('S'))),
    'sec17-a helper=1 alive=1 mfa_ok=0 | sec17-a helper=1 alive=1 mfa_ok=0 | '
    || 'sec17-a,sec17-b helper=1 alive=1 mfa_ok=0 | sec17-a helper=1 alive=1 mfa_ok=0',
    'one statement, one probe: staff only, owner only, staff of B1 and owner of B2, and synthetic staff claims '
    || '(true without session_id) each call session_alive exactly once and session_mfa_ok never'
  )
  else skip('track_functions cannot be set by this role: the call counts are not measured here', 1) end;

-- S (staff of B1, staff row SS) with its live session: the six helpers.
select is(
  pg_temp.helpers(pg_temp.s1('S', 'S_S')),
  'B1 B1 SS true true SS',
  'live session: the six membership helpers give the staff member B1, B1 (as staff), its staff row SS, '
  || 'is_member true, has_role(staff) true, my_staff_id SS'
);

-- O (owner, aal2) with its live session; then «Αποσύνδεση από όλες τις συσκευές» (every session gone)
-- and the SAME access token.
select is(
  concat_ws(' ',
    pg_temp.biz(pg_temp.s2('O', 'S_O')), pg_temp.cli(pg_temp.s2('O', 'S_O')), pg_temp.apps(pg_temp.s2('O', 'S_O')),
    pg_temp.q($$select (private.today_summary_impl(p_business_id => {B1}) is not null)::text$$,
              pg_temp.s2('O', 'S_O'))),
  'sec17-a Client A 1 true',
  'live session: the owner at aal2 reads B1, its client and its appointment, and today_summary_impl passes'
);

select private.revoke_user_sessions_impl(pg_temp.id('O'));
select set_config('t.fp_a', pg_temp.fp(), true);

select is(
  concat_ws(' ',
    pg_temp.biz(pg_temp.s2('O', 'S_O')), pg_temp.cli(pg_temp.s2('O', 'S_O')), pg_temp.apps(pg_temp.s2('O', 'S_O')),
    pg_temp.q($$select (private.today_summary_impl(p_business_id => {B1}) is not null)::text$$,
              pg_temp.s2('O', 'S_O')),
    pg_temp.q($$select public.set_member_role(p_business_id => {B1}, p_user_id => {S}, p_role => 'manager')::text$$,
              pg_temp.s2('O', 'S_O')),
    pg_temp.q($$select public.can_manage_members(p_business_id => {B1})::text$$, pg_temp.s2('O', 'S_O')),
    pg_temp.q($$select public.authorize_factor_change(p_action => 'remove', p_factor_id => {F_O})::text$$,
              pg_temp.s2('O', 'S_O')),
    pg_temp.reg(pg_temp.s2('O', 'S_O'), '17e0f000-0000-4000-8000-0000000000a1')),
  '- - 0 42501 42501 42501 42501 42501',
  'A1: after its session is revoked the same aal2 token of the owner reads nothing (businesses, clients, '
  || 'appointments) and every RPC answers 42501 WITHOUT hint: today_summary, set_member_role and can_manage_members '
  || 'with a code 1 minute old (never fresh_totp_required), authorize_factor_change, register_push_subscription'
);

select is(
  concat_ws(' ',
    pg_temp.q($$select count(*)::text from public.business_members$$, pg_temp.s2('O', 'S_O')),
    pg_temp.q($$select string_agg(m.role, ',') from public.business_members m$$, pg_temp.s2('O', 'S_O')),
    pg_temp.fp() = current_setting('t.fp_a'),
    (select m.role from public.business_members m where m.business_id = pg_temp.id('B1') and m.user_id = pg_temp.id('S')),
    pg_temp.sessions_of('O')),
  '1 owner t staff 0',
  'A1: the revoked token still reads its own membership row (the loader needs the role) and nothing was written '
  || '(no grant, audit row, role change, push device or block)'
);

-- M (manager, aal2): one of its two sessions ends; the other lives on.
select is(
  concat_ws(' ', pg_temp.biz(pg_temp.s2('M', 'S_M1')), pg_temp.today(pg_temp.s2('M', 'S_M1')),
            pg_temp.biz(pg_temp.s2('M', 'S_M2'))),
  'sec17-a true sec17-a',
  'live sessions: the manager at aal2 reads B1 and today_summary passes, from either session'
);

delete from auth.sessions s where s.id = pg_temp.id('S_M1');

select is(
  concat_ws(' ', pg_temp.biz(pg_temp.s2('M', 'S_M1')), pg_temp.cli(pg_temp.s2('M', 'S_M1')),
            pg_temp.today(pg_temp.s2('M', 'S_M1')), pg_temp.biz(pg_temp.s2('M', 'S_M2')),
            pg_temp.today(pg_temp.s2('M', 'S_M2'))),
  '- - 42501 sec17-a true',
  'A1: the manager''s token of the ended session reads nothing and today_summary → 42501 without hint; the token '
  || 'of its other, live session still works (the check is per session)'
);

-- S (staff): push registration with a live session, then the session ends (A2, A3).
select is(
  concat_ws(' ', pg_temp.reg(pg_temp.s1('S', 'S_S'), '17e0f000-0000-4000-8000-0000000000b1'),
            pg_temp.biz(pg_temp.s1('S', 'S_S'))),
  'false sec17-a',
  'A3: a staff member with a live session registers a push device (moved false) and reads B1'
);

-- «Αποσύνδεση από όλες τις συσκευές» of the staff member: its only session ends.
delete from auth.sessions s where s.id = pg_temp.id('S_S');

select is(
  concat_ws(' ',
    pg_temp.biz(pg_temp.s1('S', 'S_S')), pg_temp.apps(pg_temp.s1('S', 'S_S')), pg_temp.today(pg_temp.s1('S', 'S_S')),
    pg_temp.reg(pg_temp.s1('S', 'S_S'), '17e0f000-0000-4000-8000-0000000000b2'),
    pg_temp.q($$select public.unregister_push_subscription(p_all => true)::text$$, pg_temp.s1('S', 'S_S')),
    pg_temp.push_of('S'),
    pg_temp.q($$select count(*)::text || ':' || string_agg(m.role, ',') from public.business_members m$$,
              pg_temp.s1('S', 'S_S'))),
  '- 0 42501 42501 42501 1 1:staff',
  'A2 (§7 item 2, approved): the staff token of an ended session stops at once: nothing of B1, not its own '
  || 'appointment, today_summary → 42501 without hint; A3: it can neither register nor unregister (p_all) a push '
  || 'device, rows unchanged; it still reads its own membership row (the loader needs the role)'
);

select is(
  pg_temp.helpers(pg_temp.s1('S', 'S_S')),
  '- - - false false <null>',
  'A2 (§7 item 2, approved): with the session ended, each of the six helpers counts no staff row: '
  || 'my_business_ids, my_business_ids_with_role, my_staff_ids empty, is_member and has_role false, '
  || 'my_staff_id null'
);

-- MS: staff of B1 and owner of B2.
select is(
  concat_ws(' | ',
    pg_temp.biz(pg_temp.s2('MS', 'S_MS')) || ' ' || pg_temp.cli(pg_temp.s2('MS', 'S_MS')),
    pg_temp.biz(pg_temp.s2('MS', 'S_GONE')) || ' ' || pg_temp.cli(pg_temp.s2('MS', 'S_GONE'))),
  'sec17-a,sec17-b Client A,Client B | - -',
  'A2: staff of B1 and owner of B2 at aal2: live → both businesses; a dead session → nothing at all (neither the '
  || 'staff rows of B1 nor the owner rows of B2)'
);

-- A demotion and a removal through the D1 trigger (as provisioning would write them): the trigger revokes
-- every session of the user in the same transaction, so the token the user still holds stops at once
-- (before the approved item 2 a staff token read on for up to 1 h).
insert into public.business_members (business_id, user_id, role) values
  (pg_temp.id('B1'), pg_temp.id('SD'), 'manager'),
  (pg_temp.id('B1'), pg_temp.id('SX'), 'staff'),
  (pg_temp.id('B2'), pg_temp.id('SX'), 'staff');
select pg_temp.session('S_SD', 'SD', 'aal1');
select pg_temp.session('S_SX', 'SX', 'aal1');

select is(
  concat_ws(' ', pg_temp.biz(pg_temp.s1('SD', 'S_SD')), pg_temp.biz(pg_temp.s1('SX', 'S_SX'))),
  'sec17-a sec17-a,sec17-b',
  'live sessions: a manager without a factor reads B1 at aal1; a staff member of B1 and B2 reads both'
);

update public.business_members m set role = 'staff'
where m.business_id = pg_temp.id('B1') and m.user_id = pg_temp.id('SD');
delete from public.business_members m where m.business_id = pg_temp.id('B2') and m.user_id = pg_temp.id('SX');

select is(
  concat_ws(' ',
    pg_temp.sessions_of('SD'), pg_temp.biz(pg_temp.s1('SD', 'S_SD')), pg_temp.today(pg_temp.s1('SD', 'S_SD')),
    pg_temp.sessions_of('SX'), pg_temp.biz(pg_temp.s1('SX', 'S_SX')), pg_temp.helpers(pg_temp.s1('SX', 'S_SX')),
    pg_temp.biz(pg_temp.aal1('SD')), pg_temp.biz(pg_temp.aal1('SX'))),
  '0 - 42501 0 - - - - false false <null> sec17-a sec17-a',
  'A2 (§7 item 2, approved): demoted to staff, the token of the revoked session reads nothing of B1 and '
  || 'today_summary → 42501; removed from B2, the token reads nothing of B1 either (each helper counts no row); '
  || 'synthetic claims (no session_id) still read B1 as staff (the 0009 rule)'
);

-- A JWT without session_id (synthetic) keeps the 0009 rule.
select is(
  concat_ws(' ', pg_temp.biz(pg_temp.aal2('O')), pg_temp.biz(pg_temp.aal1('O')), pg_temp.biz(pg_temp.aal1('P')),
            pg_temp.biz(pg_temp.aal1('S'))),
  'sec17-a - sec17-b sec17-a',
  'no session_id: an enrolled owner reads at aal2 and nothing at aal1; an owner without a factor and a staff '
  || 'member read at aal1 (the 0009 rule, although their sessions were revoked)'
);

-- The paths without a user session are untouched: the cron jobs (no claims at all), anon (the public booking
-- page) and service_role (the Edge Functions and the Nous scripts) carry no session_id.
select is(
  concat_ws(' ',
    pg_temp.q('select private.session_alive()::text', '', 'postgres'),
    pg_temp.q('select private.session_alive()::text', '{"role": "anon"}', 'postgres'),
    pg_temp.q('select private.session_alive()::text', '{"role": "service_role"}', 'postgres'),
    pg_temp.q($$select count(*)::text from private.my_business_ids()$$, '', 'service_role')),
  'true true true 0',
  'session_alive is true without session_id: cron/system (no claims), anon and service_role keep their paths; '
  || 'service_role has no auth.uid(), so no membership is its own either way'
);

select is(
  concat_ws(' ',
    pg_temp.biz(pg_temp.s2('O', 'not-a-uuid')),
    pg_temp.biz(pg_temp.s2('O', 'S_M2')),
    pg_temp.biz(pg_temp.s1('S', 'not-a-uuid')),
    pg_temp.biz(pg_temp.cl('M', 'aal2', 60, upper(pg_temp.id('S_M2')::text)))),
  '- - - sec17-a',
  'a session_id that is not a uuid, or the live session of ANOTHER user, counts as dead: an owner reads nothing, '
  || 'and since the approved item 2 neither does a staff member; a live session id in upper case is still the '
  || 'same session'
);

-- First enrolment (P: owner of B2 without a factor) with a live, then a dead session.
select is(
  concat_ws(' ', pg_temp.biz(pg_temp.s1('P', 'S_P')), pg_temp.keep('afc_p', pg_temp.afc_add(pg_temp.s1('P', 'S_P')))),
  'sec17-b ok',
  'first enrolment, live session: the owner without a factor reads B2 at aal1 and gets an add grant'
);

insert into pg_temp.lbl (id, label)
select (pg_temp.r('afc_p') ->> 'grant_id')::uuid, 'W_P'
where pg_temp.r('afc_p') ->> 'grant_id' is not null;

delete from auth.sessions s where s.id = pg_temp.id('S_P');

select is(
  concat_ws(' ', pg_temp.biz(pg_temp.s1('P', 'S_P')), pg_temp.afc_add(pg_temp.s1('P', 'S_P')),
            pg_temp.grants_of('P', null)),
  '- 42501 add:-:open',
  'first enrolment, dead session: nothing readable and authorize_factor_change(add) → 42501 without hint; no '
  || 'grant written (only the first one)'
);

-- require_fresh_totp (A4), as postgres.
select is(
  concat_ws(' ',
    pg_temp.q($$select 'passed'::text from private.require_fresh_totp()$$, pg_temp.s2('O', 'S_O'), 'postgres'),
    pg_temp.q($$select 'passed'::text from private.require_fresh_totp()$$, pg_temp.s2('M', 'S_GONE'), 'postgres'),
    pg_temp.q($$select 'passed'::text from private.require_fresh_totp()$$, pg_temp.s1('M', 'S_M2'), 'postgres'),
    pg_temp.q($$select 'passed'::text from private.require_fresh_totp()$$, pg_temp.s2('M', 'S_M2'), 'postgres')),
  '42501 42501 42501/aal2_required passed',
  'require_fresh_totp: a dead session with a code 1 minute old → 42501 WITHOUT hint (never the code sheet); a '
  || 'live session at aal1 → aal2_required; a fresh code of a live session on a vetted device passes'
);

-- =============================================================================================
-- B. The notification bundle (§2.4.5): + account_email and businesses. Clocks in 2003; the events are
--    written directly, with factor ids that never exist (no grant, nothing vetted or flagged).
-- =============================================================================================
select pg_temp.ev('EV_O', 'O', 'factor_removed_unauthorized', 'F_EVO', pg_temp.t(-300), array['B1']);

select is(pg_temp.claim('c1', 1, pg_temp.t(0)), 'EV_O more=true',
  'claim: the fixture event (the oldest pending one) is leased');

select is(pg_temp.res('r1', 'EV_O', 'c1', 'contained', pg_temp.t(10)), 'recorded=true notify {notify,recorded}',
  'contained with the current lease → {recorded: true, notify: <bundle>}');

select is(
  (select concat_ws(' ', pg_temp.keys(x.n)::text, x.n ->> 'kind', x.n ->> 'account_email',
                    (x.n ->> 'detected_at')::timestamptz = pg_temp.t(-300), x.n ->> 'push_queued')
   from (select pg_temp.r('r1') -> 'notify' as n) x),
  '{account_email,businesses,detected_at,emails,kind,push_queued} factor_removed_unauthorized o@sec17.test t 0',
  'bundle: exactly {account_email, businesses, detected_at, emails, kind, push_queued}; account_email = the '
  || 'account''s email'
);

select is(
  jsonb_build_object('businesses', pg_temp.r('r1') -> 'notify' -> 'businesses',
                     'emails', pg_temp.r('r1') -> 'notify' -> 'emails'),
  jsonb_build_object(
    'businesses', jsonb_build_array(jsonb_build_object('name', 'Alpha Barber 17', 'slug', 'sec17-a')),
    'emails', jsonb_build_array(jsonb_build_object(
      'audience', 'user', 'to', 'o@sec17.test', 'locale', 'el', 'timezone', 'Europe/Athens', 'business_name', null,
      'account_email', 'o@sec17.test'))),
  'bundle of the sole owner of B1: businesses = [{name, slug}] of B1, emails = the user entry only (unchanged)'
);

select pg_temp.ev('EV_MS', 'MS', 'factor_removed_unauthorized', 'F_EVMS', pg_temp.t(-200), array['B2']);
select pg_temp.ev('EV_OM', 'OM', 'factor_removed_unauthorized', 'F_EVOM', pg_temp.t(-190), array['B2', 'B1']);
select pg_temp.ev('EV_NS', 'M', 'factor_removed_unauthorized', 'F_EVNS', pg_temp.t(-180), array['NOSHOP', 'B1']);
select pg_temp.ev('EV_NE', 'NE', 'factor_removed_unauthorized', 'F_EVNE', pg_temp.t(-170), array[]::text[]);

select is(
  concat_ws(' ', pg_temp.bundle('b_ms', 'EV_MS', pg_temp.t(20)), pg_temp.bundle('b_om', 'EV_OM', pg_temp.t(20)),
            pg_temp.bundle('b_ns', 'EV_NS', pg_temp.t(20)), pg_temp.bundle('b_ne', 'EV_NE', pg_temp.t(20))),
  'ok ok ok ok',
  'queue_security_notifications answers for four more events'
);

select is(
  concat_ws(' | ',
    (pg_temp.r('b_ms') -> 'businesses')::text || ' ' || (pg_temp.r('b_ms') ->> 'account_email'),
    (pg_temp.r('b_om') -> 'businesses')::text || ' ' || (pg_temp.r('b_om') ->> 'account_email')),
  '[{"name": "Beta Barber 17", "slug": "sec17-b"}] ms@sec17.test | '
  || '[{"name": "Beta Barber 17", "slug": "sec17-b"}, {"name": "Alpha Barber 17", "slug": "sec17-a"}] om@sec17.test',
  'bundle businesses = the event''s business_ids (staff of B1 and owner of B2 → B2 only), in their order (owner '
  || 'first: B2 before B1, against name, slug and id order)'
);

select is(
  concat_ws(' | ',
    (pg_temp.r('b_ns') -> 'businesses')::text,
    pg_temp.keys(pg_temp.r('b_ne'))::text,
    coalesce(jsonb_typeof(pg_temp.r('b_ne') -> 'account_email'), 'absent'),
    (pg_temp.r('b_ne') -> 'businesses')::text,
    (pg_temp.r('b_ne') -> 'emails')::text),
  '[{"name": "Alpha Barber 17", "slug": "sec17-a"}] | '
  || '{account_email,businesses,detected_at,emails,kind,push_queued} | null | [] | []',
  'a business id that no longer exists is skipped; an account without email and without businesses → the same '
  || 'six keys, account_email null, businesses [] and emails []'
);

-- Review fix: the businesses of the event as they were at detection, never the user's memberships now. O is
-- owner of B1 only; its event lists [B2, B1] (e.g. O was demoted out of B2 before dispatch's contained step).
select pg_temp.ev('EV_OX', 'O', 'factor_added_unauthorized', 'F_EVOX', pg_temp.t(-160), array['B2', 'B1']);

select is(
  concat_ws(' | ',
    (select string_agg(pg_temp.l(m.business_id) || ':' || m.role, ',' order by m.business_id)
     from public.business_members m where m.user_id = pg_temp.id('O')),
    pg_temp.bundle('b_ox', 'EV_OX', pg_temp.t(20)),
    (pg_temp.r('b_ox') -> 'businesses')::text),
  'B1:owner | ok | [{"name": "Beta Barber 17", "slug": "sec17-b"}, {"name": "Alpha Barber 17", "slug": "sec17-a"}]',
  'bundle businesses come from the event''s business_ids (in their order), not from the user''s current '
  || 'memberships: an event of O (owner of B1 only) listing [B2, B1] names B2 then B1'
);

-- =============================================================================================
-- C. The enrolment block (§0 C1–C7, §2.2–§2.6). Fixture of this section, before any run:
--   U1: F_U1 deleted, no grant; an add grant G_U1 written before (open)
--   U2: F_U2 deleted, a user remove grant expiring 1 s after last_seen_at · U2b: the same, expiring exactly
--       at last_seen_at (the D8 boundary) · U3: F_U3a of two deleted · U4: F_U4a deleted + F_U4n verified
--       without grant · U5: F_U5a deleted + F_U5n inside an add grant written before · U6: mfa_reset, then
--       F_U6 deleted · U7: no snapshot factor; an add grant, F_U7 verified and removed between runs (GoTrue's
--       audit log), no remove grant · U8: F_U8 deleted, then its only membership deleted
-- =============================================================================================
select pg_temp.dgrant('G_U1', 'U1', 'add', null, 'user', now() - interval '60 seconds', now() + interval '9 minutes');
select pg_temp.dgrant('G_U5', 'U5', 'add', null, 'user', now() - interval '60 seconds', now() + interval '9 minutes');
select pg_temp.dgrant('GR_U2', 'U2', 'remove', 'F_U2', 'user', pg_temp.ls() - interval '10 minutes',
                      pg_temp.ls() + interval '1 second');
select pg_temp.dgrant('GR_U2b', 'U2b', 'remove', 'F_U2b', 'user', pg_temp.ls() - interval '10 minutes', pg_temp.ls());
select pg_temp.wgrant('G_U7', 'U7', 'add', null, 'user');
-- probes of the remove-grant rule (source system, of a factor id that never exists)
select pg_temp.dgrant('RG2', 'U3', 'remove', 'F_RGX', 'system', pg_temp.ls() - interval '60 seconds',
                      pg_temp.ls() + interval '50 seconds');
select pg_temp.dgrant('RG3', 'U3', 'remove', 'F_RGX', 'system', pg_temp.ls() - interval '90 seconds',
                      pg_temp.ls() + interval '100 seconds');
select pg_temp.dgrant('RG1', 'U3', 'remove', 'F_RGX', 'system', pg_temp.ls() - interval '300 seconds',
                      pg_temp.ls() + interval '200 seconds', pg_temp.ls() - interval '1 second');
select pg_temp.dgrant('RG4', 'U3', 'remove', 'F_RGX', 'system', pg_temp.ls() - interval '400 seconds', pg_temp.ls());
select pg_temp.dgrant('RG5', 'U2', 'remove', 'F_RGX', 'system', pg_temp.ls() - interval '500 seconds',
                      pg_temp.ls() + interval '300 seconds');

select is(
  pg_temp.keep('rs_u6', pg_temp.q($$select public.record_support_action(p_action => 'mfa_reset',
    p_reason => 'pgTAP 17 lost phone', p_ticket => 'T-17-U6', p_user_id => {U6})::text$$, '', 'service_role')),
  'ok',
  'mfa_reset of U6 (no removal awaits detection) is recorded'
);

select is(
  concat_ws(' ', pg_temp.keys(pg_temp.r('rs_u6'))::text, pg_temp.r('rs_u6') ->> 'enrolment_unblocked',
            pg_temp.r('rs_u6') ->> 'grants', pg_temp.grants_of('U6', 'nous_support'),
            pg_temp.r('rs_u6') ->> 'sessions', pg_temp.r('rs_u6') ->> 'push_subscriptions'),
  '{action,audit_rows,enrolment_unblocked,factor_ids,grants,push_subscriptions,sessions} false 1 remove:F_U6:open 0 0',
  'mfa_reset result: exactly {action, factor_ids, grants, audit_rows, enrolment_unblocked, sessions, '
  || 'push_subscriptions}; never blocked → enrolment_unblocked false; a nous_support grant per factor; no session '
  || 'or push device to end'
);

-- the script deletes the factors through the admin API after recording the reset; the others go
-- straight at GoTrue
delete from auth.mfa_factors f
where f.id in (pg_temp.id('F_U1'), pg_temp.id('F_U2'), pg_temp.id('F_U2b'), pg_temp.id('F_U3a'), pg_temp.id('F_U4a'),
               pg_temp.id('F_U5a'), pg_temp.id('F_U6'), pg_temp.id('F_U8'));
select pg_temp.factor('F_U4n', 'U4', true, now());
select pg_temp.factor('F_U5n', 'U5', true, now());
delete from public.business_members m where m.user_id = pg_temp.id('U8');

select pg_temp.gotrue_audit(a.action, 'U7', 'F_U7', now() + a.after)
from (values
  ('factor_in_progress', interval '1 second'),
  ('verification_attempted', interval '2 seconds'),
  ('factor_unenrolled', interval '3 seconds')
) as a (action, after);

select pg_temp.session('S_U1a', 'U1', 'aal1');
select pg_temp.session('S_U2', 'U2', 'aal1');

-- C2: blocked already before the detector runs.
select is(
  (select string_agg(concat_ws(':', x.u, private.unauthorized_removal_pending(pg_temp.id(x.u)),
                               private.enrolment_blocked(pg_temp.id(x.u))), ' ' order by x.o)
   from unnest(array['U1', 'U2', 'U2b', 'U3', 'U4', 'U5', 'U6', 'U7', 'O', 'P']) with ordinality as x (u, o)),
  'U1:t:t U2:f:f U2b:t:t U3:t:f U4:t:f U5:t:f U6:f:f U7:f:f O:f:f P:f:f',
  'C2 before any run (user:pending:blocked): a snapshot factor gone without a covering remove grant is pending; '
  || 'it blocks only while no verified factor is left (U1, U2b at the D8 boundary); a grant 1 s past last_seen_at '
  || '(U2) or of mfa_reset (U6) covers it; a transient factor never in the snapshot does not block yet (U7, C7)'
);

select is(
  concat_ws(' ',
    pg_temp.l(private.remove_grant_for(pg_temp.id('U3'), pg_temp.id('F_RGX'), pg_temp.ls())),
    pg_temp.l(private.remove_grant_for(pg_temp.id('U3'), pg_temp.id('F_RGX'), pg_temp.ls() + interval '100 seconds')),
    pg_temp.l(private.remove_grant_for(pg_temp.id('U3'), pg_temp.id('F_U3a'), pg_temp.ls())),
    pg_temp.l(private.remove_grant_for(pg_temp.id('U2'), pg_temp.id('F_RGX'), pg_temp.ls()))),
  'RG3 - - RG5',
  'remove_grant_for (1.9 D8, reads only): the earliest (created_at, id) unmatched remove grant of that user and '
  || 'factor expiring AFTER p_last_seen_at (not a matched one, not one expiring exactly then, not another '
  || 'user''s, not another factor''s); null when none'
);

select set_config('t.fp_c1', pg_temp.fp(), true);

select is(
  concat_ws(' ',
    pg_temp.fb(pg_temp.s1('U1', 'S_U1a')),
    pg_temp.afc_add(pg_temp.s1('U1', 'S_U1a')),
    pg_temp.biz(pg_temp.s1('U1', 'S_U1a')),
    pg_temp.q($$select count(*)::text from public.business_members m where m.business_id = {B1}$$,
              pg_temp.s1('U1', 'S_U1a')),
    pg_temp.q($$select m.role from public.business_members m where m.business_id = {B1}$$, pg_temp.s1('U1', 'S_U1a'))),
  'true P0001/AN034/enrolment_blocked sec17-b 1 manager',
  'C2/C3 as the user (live aal1 session, before detection): factor_enrolment_blocked() true, '
  || 'authorize_factor_change(add) → P0001 AN034 enrolment_blocked; nothing of B1 is read (only the staff '
  || 'business B2) except its own membership row'
);

select is(
  pg_temp.q($$select public.record_support_action(p_action => 'mfa_reset', p_reason => 'identity checked by call-back',
    p_ticket => 'T-17', p_user_id => {U1})::text$$, '', 'service_role'),
  '55000/detection_pending',
  'C4: mfa_reset is refused while an unauthorized removal of the user awaits detection (55000 detection_pending)'
);

select is(
  concat_ws(' ', pg_temp.fp() = current_setting('t.fp_c1'), pg_temp.grants_of('U1', null),
            pg_temp.audit_rows('factor_add_authorized', null, 'U1'), pg_temp.audit_rows('mfa_reset', 'U1')),
  't add:-:open - -',
  'neither refusal wrote anything: no grant (G_U1 only), no factor_add_authorized or mfa_reset audit row'
);

select is(
  concat_ws(' ', pg_temp.fb(pg_temp.s1('U2', 'S_U2')),
            pg_temp.keep('afc_u2', pg_temp.afc_add(pg_temp.s1('U2', 'S_U2'))),
            pg_temp.biz(pg_temp.s1('U2', 'S_U2'))),
  'false ok sec17-a',
  'a removal covered by a remove grant does not block: the first-enrolment add grant is given and B1 is read'
);

insert into pg_temp.lbl (id, label)
select (pg_temp.r('afc_u2') ->> 'grant_id')::uuid, 'W_U2'
where pg_temp.r('afc_u2') ->> 'grant_id' is not null;

-- Run 1: the detector writes the blocks (step 6b).
select is(pg_temp.detect(pg_temp.p(1)), '8 | detect_factor_changes true 8 - | security',
  'run 1: eight events (U1, U2b, U3, U4 ×2, U5, U7, U8) → returns 8, rows_affected 8 (a block is not an event), '
  || 'one nudge');

select is(
  concat_ws(' / ', pg_temp.events_of('U1'), pg_temp.block_of('U1'), pg_temp.baudit('U1'), pg_temp.sessions_of('U1')),
  'factor_removed_unauthorized:F_U1:pending:0:B1 / factor_removed_unauthorized/F_U1:p1 / '
  || 'B1:factor_enrolment_blocked:system:-:auth_user:U1:event=factor_removed_unauthorized/F_U1 / 0',
  'C1: an unauthorized removal leaving no verified factor → one event, one block row (event_id = that event, '
  || 'blocked_at = the run''s clock), one audit row per owner/manager business (system, entity auth_user, '
  || 'reason event=<id>; never the staff business B2), the sessions revoked'
);

select is(
  concat_ws(' | ',
    pg_temp.events_of('U2') || ' ' || pg_temp.block_of('U2') || ' ' || pg_temp.grants_of('U2', 'user', pg_temp.p(1)),
    pg_temp.events_of('U2b') || ' ' || pg_temp.block_of('U2b') || ' ' || pg_temp.grants_of('U2b', 'user', pg_temp.p(1))
      || ' ' || pg_temp.baudit('U2b')),
  '- - add:-:open,remove:F_U2:matched | factor_removed_unauthorized:F_U2b:pending:0:B2,B1 '
  || 'factor_removed_unauthorized/F_U2b:p1 remove:F_U2b:open '
  || 'B2:factor_enrolment_blocked:system:-:auth_user:U2b:event=factor_removed_unauthorized/F_U2b,'
  || 'B1:factor_enrolment_blocked:system:-:auth_user:U2b:event=factor_removed_unauthorized/F_U2b',
  'D8 through remove_grant_for: a grant 1 s past last_seen_at is matched (no event, no block); one expiring '
  || 'exactly then → event and block, one audit row per business in the event''s order (owner B2 first)'
);

select is(
  concat_ws(' | ',
    pg_temp.events_of('U3') || ' ' || pg_temp.block_of('U3'),
    pg_temp.events_of('U4') || ' ' || pg_temp.block_of('U4') || ' ' || pg_temp.baudit('U4'),
    pg_temp.events_of('U5') || ' ' || pg_temp.block_of('U5') || ' ' || pg_temp.grants_of('U5', 'user', pg_temp.p(1))),
  'factor_removed_unauthorized:F_U3a:pending:0:B1 - | '
  || 'factor_added_unauthorized:F_U4n:pending:0:B1 factor_removed_unauthorized:F_U4a:pending:0:B1 '
  || 'factor_removed_unauthorized/F_U4a:p1 B1:factor_enrolment_blocked:system:-:auth_user:U4:event=factor_removed_unauthorized/F_U4a | '
  || 'factor_removed_unauthorized:F_U5a:pending:0:B1 - add:-:matched',
  'a vetted device left → no block (U3); an unauthorized add in the same run does not count as vetted → block on '
  || 'the removal event (U4); a device inside an earlier add grant counts → no block (U5)'
);

select is(
  concat_ws(' | ',
    pg_temp.events_of('U6') || ' ' || pg_temp.block_of('U6') || ' ' || pg_temp.grants_of('U6', 'nous_support', pg_temp.p(1)),
    pg_temp.events_of('U7') || ' ' || pg_temp.block_of('U7') || ' ' || pg_temp.grants_of('U7', 'user', pg_temp.p(1))
      || ' ' || pg_temp.baudit('U7'),
    pg_temp.events_of('U8') || ' ' || pg_temp.block_of('U8') || ' ' || pg_temp.baudit('U8')),
  '- - remove:F_U6:matched | factor_removed_unauthorized:F_U7:pending:0:B1 factor_removed_unauthorized/F_U7:p1 '
  || 'add:-:matched B1:factor_enrolment_blocked:system:-:auth_user:U7:event=factor_removed_unauthorized/F_U7 | '
  || 'factor_removed_unauthorized:F_U8:pending:0:- - -',
  'mfa_reset first → no event, no block (U6); a transient device removed without a remove grant → removal event '
  || 'and block (U7); a removal of an account that is owner/manager nowhere → event with business_ids {}, no block '
  || 'and no audit row (U8, C5)'
);

select is(
  concat_ws(' / ',
    (select string_agg(pg_temp.l(b.user_id) || ':' || pg_temp.pl(b.blocked_at), ',' order by pg_temp.l(b.user_id))
     from private.factor_enrolment_blocks b where b.user_id in (select pg_temp.fxu())),
    (select count(*) from public.audit_log a
     where a.action = 'factor_enrolment_blocked' and a.entity_id in (select pg_temp.fxu())),
    (select string_agg(concat_ws(':', x.u, private.enrolment_blocked(pg_temp.id(x.u))), ' ' order by x.o)
     from unnest(array['U1', 'U2', 'U2b', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8']) with ordinality as x (u, o))),
  'U1:p1,U2b:p1,U4:p1,U7:p1 / 5 / U1:t U2:f U2b:t U3:f U4:t U5:f U6:f U7:t U8:f',
  'after run 1: exactly four block rows and five block audit rows among the fixture users; enrolment_blocked '
  || 'follows the rows (U4 although it holds a verified device; U8 no longer pending)'
);

-- Run 2: nothing changed.
select set_config('t.blocks2', pg_temp.blocks(), true);
select set_config('t.baudit2', (select count(*) from public.audit_log a
                                where a.action = 'factor_enrolment_blocked')::text, true);

select is(pg_temp.detect(pg_temp.p(2)), '0 | detect_factor_changes true 0 - | -',
  'run 2 with no change: returns 0, no nudge');

select is(
  concat_ws(' ', pg_temp.blocks() = current_setting('t.blocks2'),
            (select count(*) from public.audit_log a where a.action = 'factor_enrolment_blocked')::text
              = current_setting('t.baudit2')),
  't t',
  'run 2: no new block row, the existing ones unchanged (event, instant), no new factor_enrolment_blocked audit row'
);

-- The blocked state (C3), with new live sessions.
select pg_temp.session('S_U1b', 'U1', 'aal1');
select pg_temp.session('S_U4', 'U4', 'aal1');
select set_config('t.fp_c2', pg_temp.fp(), true);

select is(
  concat_ws(' ',
    pg_temp.fb(pg_temp.s1('U1', 'S_U1b')), pg_temp.biz(pg_temp.s1('U1', 'S_U1b')), pg_temp.cli(pg_temp.s1('U1', 'S_U1b')),
    pg_temp.afc_add(pg_temp.s1('U1', 'S_U1b')),
    pg_temp.reg(pg_temp.s1('U1', 'S_U1b'), '17e0f000-0000-4000-8000-0000000000c1'),
    pg_temp.biz(pg_temp.aal2('U1'))),
  'true sec17-b Client B P0001/AN034/enrolment_blocked 42501 sec17-b',
  'C3 blocked (U1, new live aal1 session): nothing of B1, the staff rows of B2 still read; add → AN034; no push '
  || 'device (42501); synthetic aal2 claims read nothing of B1 either'
);

select is(
  concat_ws(' ',
    pg_temp.afc_add(pg_temp.s1('U4', 'S_U4')), pg_temp.biz(pg_temp.s1('U4', 'S_U4')),
    pg_temp.afc_add(pg_temp.aal2('U4')), pg_temp.biz(pg_temp.aal2('U4'))),
  'P0001/AN034/enrolment_blocked - P0001/AN034/enrolment_blocked -',
  'C3 blocked while holding a verified device (U4): add → AN034 BEFORE freshness (never aal2_required or '
  || 'fresh_totp_required: no code sheet), and no owner/manager rows even at aal2'
);

select is(pg_temp.fp(), current_setting('t.fp_c2'),
  'the blocked calls wrote nothing (no grant, audit row, push device or block change)');

-- Review fix: a second unauthorized removal of an already-blocked user. U4 removes its flagged device F_U4n
-- (in the snapshot since run 1) straight at GoTrue before dispatch could write the system remove grant
-- (dispatch down, or its containment retrying): run 3 raises another removal event for U4 (step 6b runs for
-- a user who already has a block row).
delete from auth.mfa_factors f where f.id = pg_temp.id('F_U4n');

-- A device enrolled straight at GoTrue while blocked, inside G_U1's window.
select pg_temp.factor('F_U1x', 'U1', true, now());
select pg_temp.session('S_U1x', 'U1', 'aal2', 'F_U1x');

select is(
  concat_ws(' ',
    (select pg_temp.l(m.m_grant_id)
     from private.match_add_grants(array[pg_temp.id('F_U1x')], array[pg_temp.id('U1')], array[now()]) as m),
    (select pg_temp.l(m.m_grant_id)
     from private.match_add_grants(array[pg_temp.id('F_U1x')], array[pg_temp.id('U2')], array[now()]) as m),
    (select coalesce(string_agg(pg_temp.l(u), ','), '-') from private.unvetted_factors(pg_temp.id('U1')) as u)),
  '- W_U2 F_U1x',
  'C3: a blocked user''s open add grant never vouches for a device (the same call for an unblocked user with an '
  || 'add grant matches it); the device is unvetted'
);

select is(
  concat_ws(' ',
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.s2('U1', 'S_U1x'), 'postgres'),
    pg_temp.biz(pg_temp.s2('U1', 'S_U1x')),
    pg_temp.afc_add(pg_temp.s2('U1', 'S_U1x'))),
  'false sec17-b P0001/AN034/enrolment_blocked',
  'C3: a fresh code from that device never counts, its live aal2 session reads nothing of B1, and add → AN034'
);

select is(pg_temp.detect(pg_temp.p(3)), '2 | detect_factor_changes true 2 - | security',
  'run 3: the device enrolled while blocked (U1) and the second removal of U4 are events');

select is(
  concat_ws(' / ', pg_temp.events_of('U1'), pg_temp.gstate('G_U1', pg_temp.p(3)), pg_temp.sessions_of('U1'),
            pg_temp.block_of('U1'), pg_temp.baudit('U1')),
  'factor_added_unauthorized:F_U1x:pending:0:B1 factor_removed_unauthorized:F_U1:pending:0:B1 / open / 0 / '
  || 'factor_removed_unauthorized/F_U1:p1 / B1:factor_enrolment_blocked:system:-:auth_user:U1:event=factor_removed_unauthorized/F_U1',
  'run 3: factor_added_unauthorized for the device, G_U1 still unmatched, the sessions revoked; no second block '
  || 'row and no second block audit row'
);

select is(
  concat_ws(' / ', pg_temp.events_of('U4'), pg_temp.block_of('U4'), pg_temp.baudit('U4'), pg_temp.sessions_of('U4'),
            (select count(*) from private.factor_enrolment_blocks b where b.user_id = pg_temp.id('U4'))),
  'factor_added_unauthorized:F_U4n:pending:0:B1 factor_removed_unauthorized:F_U4a:pending:0:B1 '
  || 'factor_removed_unauthorized:F_U4n:pending:0:B1 / factor_removed_unauthorized/F_U4a:p1 / '
  || 'B1:factor_enrolment_blocked:system:-:auth_user:U4:event=factor_removed_unauthorized/F_U4a / 0 / 1',
  'step 6b on a user already blocked (U4, second unauthorized removal): one more removal event and the sessions '
  || 'revoked, but the block row stays as it was (the first removal event, blocked at p1) and no second '
  || 'factor_enrolment_blocked audit row is written'
);

-- Review fix: a live session opened while U1 is blocked (whoever holds the mailbox signs in with the email
-- code and waits on «Επικοινώνησε με τη Nous»), and a push device of U1.
select pg_temp.session('S_U1r', 'U1', 'aal1');
insert into public.push_subscriptions (user_id, provider, subscription_id, created_at) values
  (pg_temp.id('U1'), 'onesignal', '17e0f000-0000-4000-8000-0000000000d1', now());

select is(
  concat_ws(' ', pg_temp.fb(pg_temp.s1('U1', 'S_U1r')), pg_temp.afc_add(pg_temp.s1('U1', 'S_U1r')),
            pg_temp.sessions_of('U1'), pg_temp.push_of('U1')),
  'true P0001/AN034/enrolment_blocked 1 1',
  'before the reset: the session opened while blocked is live and blocked (add → AN034); one push device'
);

-- Cleared by Nous (C4).
select is(
  pg_temp.keep('rs_u1', pg_temp.q($$select public.record_support_action(p_action => 'mfa_reset',
    p_reason => 'identity checked by call-back', p_ticket => 'T-17', p_user_id => {U1})::text$$, '', 'service_role')),
  'ok',
  'C4: once nothing awaits detection, Nous''s mfa_reset of the blocked user is recorded'
);

select is(
  concat_ws(' ',
    pg_temp.keys(pg_temp.r('rs_u1'))::text, pg_temp.r('rs_u1') ->> 'action',
    (select string_agg(pg_temp.lt(x), ',') from jsonb_array_elements_text(pg_temp.r('rs_u1') -> 'factor_ids') as x),
    pg_temp.r('rs_u1') ->> 'grants', pg_temp.r('rs_u1') ->> 'audit_rows', pg_temp.r('rs_u1') ->> 'enrolment_unblocked',
    pg_temp.block_of('U1'), pg_temp.grants_of('U1', 'nous_support'), private.enrolment_blocked(pg_temp.id('U1'))),
  '{action,audit_rows,enrolment_unblocked,factor_ids,grants,push_subscriptions,sessions} mfa_reset F_U1x 1 1 true - '
  || 'remove:F_U1x:open f',
  'C4: the reset lifts the block (enrolment_unblocked true, the row gone) and writes a nous_support grant per '
  || 'current factor'
);

select is(
  pg_temp.audit_rows('mfa_reset', 'U1'),
  'B1:nous_support:-:auth_user:U1:[T-17] identity checked by call-back',
  'C4: the mfa_reset audit rows as in 0009 (one per owner/manager business, ticket and reason); no other row'
);

-- the script deletes the factors through the admin API after recording the reset
delete from auth.mfa_factors f where f.user_id = pg_temp.id('U1');

-- Review fix: between the script's deletions and its own revoke_user_sessions, the user has no device and no
-- block; the session opened while blocked must already be gone (else it takes the first-enrolment grant).
select is(
  concat_ws(' ',
    pg_temp.r('rs_u1') ->> 'sessions', pg_temp.r('rs_u1') ->> 'push_subscriptions',
    pg_temp.sessions_of('U1'), pg_temp.push_of('U1'),
    pg_temp.afc_add(pg_temp.s1('U1', 'S_U1r')), pg_temp.fb(pg_temp.s1('U1', 'S_U1r')),
    pg_temp.biz(pg_temp.s1('U1', 'S_U1r'))),
  '1 1 0 0 42501 42501 -',
  'review fix: the reset ends every session of the user and its push devices in the transaction that lifts the '
  || 'block (sessions 1, push_subscriptions 1), so the session opened while blocked never sees the block lifted: '
  || 'authorize_factor_change(add) and factor_enrolment_blocked → 42501 without hint, no owner/manager rows (and, '
  || 'since the approved item 2, not the staff rows of B2 either)'
);

select is(pg_temp.grants_of('U1', 'user'), 'add:-:open',
  'review fix: that refused call wrote no add grant (G_U1, written before the block, is the only user grant)');

select is(pg_temp.detect(pg_temp.p(4)), '0 | detect_factor_changes true 0 - | -',
  'run 4: the reset''s removal is covered by its grants → no event, no nudge');

select is(
  concat_ws(' / ', pg_temp.events_of('U1'), pg_temp.grants_of('U1', 'nous_support', pg_temp.p(4)), pg_temp.block_of('U1')),
  'factor_added_unauthorized:F_U1x:pending:0:B1 factor_removed_unauthorized:F_U1:pending:0:B1 / remove:F_U1x:matched / -',
  'run 4: no new event for U1, the nous_support grant matched, no block'
);

select pg_temp.session('S_U1c', 'U1', 'aal1');

select is(
  concat_ws(' ', pg_temp.fb(pg_temp.s1('U1', 'S_U1c')),
            pg_temp.keep('afc_u1', pg_temp.afc_add(pg_temp.s1('U1', 'S_U1c'))),
            pg_temp.biz(pg_temp.s1('U1', 'S_U1c'))),
  'false ok sec17-a,sec17-b',
  'after the reset: factor_enrolment_blocked() false, the first-enrolment add grant is given at aal1 and B1 is '
  || 'read again'
);

select is(
  concat_ws(' ', pg_temp.block_of('U3'),
            pg_temp.q($$select public.record_support_action(p_action => 'mfa_reset', p_reason => 'pgTAP 17 never blocked',
              p_ticket => 'T-17-U3', p_user_id => {U3}) ->> 'enrolment_unblocked'$$, '', 'service_role')),
  '- false',
  'mfa_reset of a user who was never blocked → enrolment_unblocked false'
);

-- §7 item 17 (the alternative approved on 2026-10-04): Nous can always lift a block, also of a user who is
-- owner/manager nowhere any more.
--   SB: manager of B1, blocked (its removal event names B1), then demoted to staff through the D1 trigger.
--   RB: manager of B2, blocked (its removal event names B2), then removed from B2: a member nowhere.
--   U8: a member nowhere since run 1 (C5), blocked by hand with no event (as e2e's blockEnrolment writes it).
-- The events and block rows are written as the detector would (step 6b), with clocks in 2003.
insert into public.business_members (business_id, user_id, role) values
  (pg_temp.id('B1'), pg_temp.id('SB'), 'manager'),
  (pg_temp.id('B2'), pg_temp.id('RB'), 'manager');
select pg_temp.ev('EV_SB', 'SB', 'factor_removed_unauthorized', 'F_EVSB', pg_temp.t(-150), array['B1']);
select pg_temp.ev('EV_RB', 'RB', 'factor_removed_unauthorized', 'F_EVRB', pg_temp.t(-140), array['B2']);
insert into private.factor_enrolment_blocks (user_id, event_id, blocked_at) values
  (pg_temp.id('SB'), pg_temp.id('EV_SB'), pg_temp.t(-150)),
  (pg_temp.id('RB'), pg_temp.id('EV_RB'), pg_temp.t(-140)),
  (pg_temp.id('U8'), null, now());
update public.business_members m set role = 'staff' where m.user_id = pg_temp.id('SB');
delete from public.business_members m where m.user_id = pg_temp.id('RB');
select pg_temp.session('S_SB', 'SB', 'aal1');

select is(
  concat_ws(' ',
    private.is_privileged_anywhere(pg_temp.id('SB')), private.enrolment_blocked(pg_temp.id('SB')),
    pg_temp.biz(pg_temp.s1('SB', 'S_SB')), pg_temp.fb(pg_temp.s1('SB', 'S_SB')),
    pg_temp.reg(pg_temp.s1('SB', 'S_SB'), '17e0f000-0000-4000-8000-0000000000e1'), pg_temp.push_of('SB')),
  'f t sec17-a true 42501 0',
  'item 17: demoted to staff, the blocked user keeps the block: its staff row of B1 counts, but it cannot register '
  || 'a push device (42501: session_mfa_ok refuses a blocked user, A3)'
);

select is(
  pg_temp.keep('rs_sb', pg_temp.q($$select public.record_support_action(p_action => 'mfa_reset',
    p_reason => 'staff now, identity checked by call-back', p_ticket => 'T-17-SB', p_user_id => {SB})::text$$,
    '', 'service_role')),
  'ok',
  'item 17: Nous''s mfa_reset of a blocked user who is owner/manager nowhere any more (staff of B1) is recorded '
  || '(0009 refused it: 22023)'
);

select is(
  concat_ws(' ',
    pg_temp.keys(pg_temp.r('rs_sb'))::text,
    coalesce((select string_agg(pg_temp.lt(x), ',') from jsonb_array_elements_text(pg_temp.r('rs_sb') -> 'factor_ids') as x), '-'),
    pg_temp.r('rs_sb') ->> 'grants', pg_temp.r('rs_sb') ->> 'audit_rows', pg_temp.r('rs_sb') ->> 'enrolment_unblocked',
    pg_temp.r('rs_sb') ->> 'sessions', pg_temp.r('rs_sb') ->> 'push_subscriptions',
    pg_temp.block_of('SB'), private.enrolment_blocked(pg_temp.id('SB')), pg_temp.sessions_of('SB'),
    pg_temp.audit_rows('mfa_reset', 'SB')),
  '{action,audit_rows,enrolment_unblocked,factor_ids,grants,push_subscriptions,sessions} - 0 1 true 1 0 - f 0 '
  || 'B1:nous_support:-:auth_user:SB:[T-17-SB] staff now, identity checked by call-back',
  'item 17: the reset lifts the block (enrolment_unblocked true, the row gone), has no factor to grant (the '
  || 'demotion dropped them), ends the session opened while blocked in the same transaction, and writes one '
  || 'nous_support audit row in the business where the user is still a member'
);

select pg_temp.session('S_SBn', 'SB', 'aal1');
select set_config('t.reg_sb', pg_temp.reg(pg_temp.s1('SB', 'S_SBn'), '17e0f000-0000-4000-8000-0000000000e2'), true);

select is(
  concat_ws(' ',
    pg_temp.biz(pg_temp.s1('SB', 'S_SB')), pg_temp.biz(pg_temp.s1('SB', 'S_SBn')), pg_temp.fb(pg_temp.s1('SB', 'S_SBn')),
    current_setting('t.reg_sb'), pg_temp.push_of('SB'), pg_temp.afc_add(pg_temp.s1('SB', 'S_SBn'))),
  '- sec17-a false false 1 42501',
  'item 17, after the reset: the ended session reads nothing; a new one reads B1 as staff, is not blocked, '
  || 'registers its push device, and still cannot ask for a device (staff never hold one)'
);

select set_config('t.rb_before', concat_ws(' ', private.is_privileged_anywhere(pg_temp.id('RB'))::text,
  (select count(*) from public.business_members m where m.user_id = pg_temp.id('RB'))::text,
  private.enrolment_blocked(pg_temp.id('RB'))::text), true);
select 'kept' from (select set_config('t.rs_rb', pg_temp.keep('rs_rb', pg_temp.q($$select public.record_support_action(
  p_action => 'mfa_reset', p_reason => 'removed member, identity checked', p_ticket => 'T-17-RB',
  p_user_id => {RB})::text$$, '', 'service_role')), true)) x;

select is(
  concat_ws(' | ', current_setting('t.rb_before'), current_setting('t.rs_rb'),
    concat_ws(' ', pg_temp.r('rs_rb') ->> 'audit_rows', pg_temp.r('rs_rb') ->> 'enrolment_unblocked',
              pg_temp.block_of('RB'), pg_temp.audit_rows('mfa_reset', 'RB'))),
  'false 0 true | ok | 1 true - B2:nous_support:-:auth_user:RB:[T-17-RB] removed member, identity checked',
  'item 17: a blocked user who is a member nowhere is reset too; the audit row goes to the business its '
  || 'removal event names (B2)'
);

select set_config('t.fp_i17', pg_temp.fp(), true);
select set_config('t.refused_i17', concat_ws(' ',
  pg_temp.q($$select public.record_support_action(p_action => 'mfa_reset', p_reason => 'nothing to record',
    p_ticket => 'T-17-U8', p_user_id => {U8})::text$$, '', 'service_role'),
  pg_temp.q($$select public.record_support_action(p_action => 'mfa_reset', p_reason => 'never blocked staff',
    p_ticket => 'T-17-S', p_user_id => {S})::text$$, '', 'service_role'),
  pg_temp.q($$select public.record_support_action(p_action => 'mfa_reset', p_reason => 'never blocked nobody',
    p_ticket => 'T-17-NE', p_user_id => {NE})::text$$, '', 'service_role')), true);

select is(
  concat_ws(' ',
    current_setting('t.refused_i17'),
    pg_temp.fp() = current_setting('t.fp_i17'), pg_temp.block_of('U8') <> '-',
    pg_temp.audit_rows('mfa_reset', 'U8') || pg_temp.audit_rows('mfa_reset', 'S') || pg_temp.audit_rows('mfa_reset', 'NE')),
  '22023 22023 22023 t t ---',
  'item 17 keeps its bounds: a block of a member of no business whose event is gone (U8) cannot be recorded, '
  || 'and a user who is owner/manager nowhere without a block (staff S, NE) has nothing to reset → 22023, '
  || 'nothing written (no grant, audit row, push device, membership or block change)'
);

-- Review fix (contract §8.7): the two halves of the audit businesses of a blocked user who is owner/manager
-- nowhere, told apart (SB's staff row and its event name the same business, RB is a member of nothing):
--   SN: manager of B1, blocked with no event (as once its event is purged after 12 months), then demoted to
--       staff of B1 through the D1 trigger: B1 can only come from the user's current memberships.
--   SE: owner of B2 and manager of B1 at detection (its removal event names B2, B1), then removed from B1 and
--       demoted to staff of B2: B1 only from the event, B2 from both halves (recorded once).
-- Each opens a session after its demotion (the D1 trigger ended the earlier ones).
insert into public.business_members (business_id, user_id, role) values
  (pg_temp.id('B1'), pg_temp.id('SN'), 'manager'),
  (pg_temp.id('B1'), pg_temp.id('SE'), 'manager'),
  (pg_temp.id('B2'), pg_temp.id('SE'), 'owner');
select pg_temp.ev('EV_SE', 'SE', 'factor_removed_unauthorized', 'F_EVSE', pg_temp.t(-130), array['B2', 'B1']);
insert into private.factor_enrolment_blocks (user_id, event_id, blocked_at) values
  (pg_temp.id('SN'), null, pg_temp.t(-135)),
  (pg_temp.id('SE'), pg_temp.id('EV_SE'), pg_temp.t(-130));
update public.business_members m set role = 'staff' where m.user_id = pg_temp.id('SN');
delete from public.business_members m where m.user_id = pg_temp.id('SE') and m.business_id = pg_temp.id('B1');
update public.business_members m set role = 'staff' where m.user_id = pg_temp.id('SE');
select pg_temp.session('S_SN', 'SN', 'aal1');
select pg_temp.session('S_SE', 'SE', 'aal1');

-- (each answer is kept, never printed: a bare 'ok' row would read as a TAP line)
select 'kept' from (select set_config('t.rs_sn', pg_temp.keep('rs_sn', pg_temp.q($$select public.record_support_action(
  p_action => 'mfa_reset', p_reason => 'staff now and the event is gone', p_ticket => 'T-17-SN',
  p_user_id => {SN})::text$$, '', 'service_role')), true)) x;
select 'kept' from (select set_config('t.rs_se', pg_temp.keep('rs_se', pg_temp.q($$select public.record_support_action(
  p_action => 'mfa_reset', p_reason => 'staff of B2 and the event names both', p_ticket => 'T-17-SE',
  p_user_id => {SE})::text$$, '', 'service_role')), true)) x;

select is(
  concat_ws(' | ',
    concat_ws(' ', current_setting('t.rs_sn'), pg_temp.r('rs_sn') ->> 'audit_rows',
              pg_temp.r('rs_sn') ->> 'enrolment_unblocked', pg_temp.r('rs_sn') ->> 'sessions', pg_temp.block_of('SN'),
              pg_temp.sessions_of('SN'), pg_temp.audit_rows('mfa_reset', 'SN')),
    concat_ws(' ', current_setting('t.rs_se'), pg_temp.r('rs_se') ->> 'audit_rows',
              pg_temp.r('rs_se') ->> 'enrolment_unblocked', pg_temp.r('rs_se') ->> 'sessions', pg_temp.block_of('SE'),
              pg_temp.sessions_of('SE'), pg_temp.audit_rows('mfa_reset', 'SE'))),
  'ok 1 true 1 - 0 B1:nous_support:-:auth_user:SN:[T-17-SN] staff now and the event is gone | '
  || 'ok 2 true 1 - 0 B1:nous_support:-:auth_user:SE:[T-17-SE] staff of B2 and the event names both,'
  || 'B2:nous_support:-:auth_user:SE:[T-17-SE] staff of B2 and the event names both',
  'review fix, item 17: a blocked user''s reset is recorded in its current memberships (SN, no event: B1) united '
  || 'with the existing businesses of its removal event (SE: staff of B2, event B2 and B1 → B1 and B2, each once); '
  || 'each reset lifts the block and ends the session opened meanwhile'
);

-- Review fix (contract §8.7): a demotion that commits while Nous resets the user. The D1 trigger takes only
-- members:<business>, never factors:<uid>, so the reset's lock does not order it: it may land at any instant of
-- record_support_action. pgTAP has one session, so that commit is injected: stand-ins for the helpers the reset
-- may call between its lock and its writes (private.is_privileged_anywhere, which the old eligibility check
-- called, and private.unauthorized_removal_pending, the pending check) demote RM through the D1 trigger the
-- first time either is called for it (t.inject_demote) and answer what the original answered just before.
-- Who may be reset and where it is recorded come from one snapshot, so the reset is recorded in B1 (the
-- demotion lands after that read). The old body (an eligibility check, then the list, two snapshots) saw RM
-- privileged, then owner/manager nowhere, and wrote the reset with audit_rows 0. The originals are restored
-- right after the call (pg_get_functiondef) and the assertion checks it.
insert into public.business_members (business_id, user_id, role) values (pg_temp.id('B1'), pg_temp.id('RM'), 'manager');
select pg_temp.session('S_RM', 'RM', 'aal1');

create temporary table saved_fn (sig regprocedure primary key, def text not null);
insert into pg_temp.saved_fn (sig, def)
select p.oid::regprocedure, pg_get_functiondef(p.oid)
from pg_proc p
where p.oid in ('private.is_privileged_anywhere(uuid)'::regprocedure,
                'private.unauthorized_removal_pending(uuid)'::regprocedure);

create or replace function private.is_privileged_anywhere(p_user_id uuid)
returns boolean
language plpgsql
volatile
set search_path = ''
as $fn$
declare
  v boolean := exists (
    select 1 from public.business_members m
    where m.user_id = p_user_id and m.role in ('owner', 'manager')
  );
begin
  if current_setting('t.inject_demote', true) = p_user_id::text then
    perform set_config('t.inject_demote', '', true);
    update public.business_members m set role = 'staff'
    where m.user_id = p_user_id and m.role in ('owner', 'manager');
  end if;
  return v;
end;
$fn$;

create or replace function private.unauthorized_removal_pending(p_user_id uuid)
returns boolean
language plpgsql
volatile
set search_path = ''
as $fn$
declare
  v boolean := exists (
    select 1
    from private.mfa_factor_snapshot s
    where s.user_id = p_user_id
      and not exists (select 1 from auth.mfa_factors f where f.id = s.factor_id)
      and private.remove_grant_for(s.user_id, s.factor_id, s.last_seen_at) is null
  );
begin
  if current_setting('t.inject_demote', true) = p_user_id::text then
    perform set_config('t.inject_demote', '', true);
    update public.business_members m set role = 'staff'
    where m.user_id = p_user_id and m.role in ('owner', 'manager');
  end if;
  return v;
end;
$fn$;

select set_config('t.inject_demote', pg_temp.id('RM')::text, true);
select 'kept' from (select set_config('t.rs_rm', pg_temp.keep('rs_rm', pg_temp.q($$select public.record_support_action(
  p_action => 'mfa_reset', p_reason => 'demoted while being reset', p_ticket => 'T-17-RM',
  p_user_id => {RM})::text$$, '', 'service_role')), true)) x;

do $$
declare
  v_def text;
begin
  for v_def in select s.def from pg_temp.saved_fn s loop
    execute v_def;
  end loop;
end;
$$;

select is(
  concat_ws(' ',
    current_setting('t.inject_demote', true) = '',
    (select string_agg(pg_temp.l(m.business_id) || ':' || m.role, ',' order by pg_temp.l(m.business_id))
     from public.business_members m where m.user_id = pg_temp.id('RM')),
    case
      -- recorded: every row the result counts is there, and there is at least one
      when current_setting('t.rs_rm') = 'ok'
       and (pg_temp.r('rs_rm') ->> 'audit_rows')::integer >= 1
       and (pg_temp.r('rs_rm') ->> 'audit_rows')::integer
           = (select count(*) from public.audit_log a where a.action = 'mfa_reset' and a.entity_id = pg_temp.id('RM'))
        then 'never unrecorded'
      -- refused: the reset itself wrote nothing (the demotion's own effects are the D1 trigger's)
      when current_setting('t.rs_rm') = '22023'
       and pg_temp.audit_rows('mfa_reset', 'RM') = '-'
       and pg_temp.grants_of('RM', 'nous_support') = '-'
        then 'never unrecorded'
      else 'UNRECORDED ' || concat_ws(' ', current_setting('t.rs_rm'), coalesce(pg_temp.r('rs_rm') ->> 'audit_rows', '-'),
                                      pg_temp.audit_rows('mfa_reset', 'RM'), pg_temp.grants_of('RM', 'nous_support'))
    end,
    pg_temp.audit_rows('mfa_reset', 'RM'),
    (select bool_and(pg_get_functiondef(s.sig) = s.def) from pg_temp.saved_fn s)),
  't B1:staff never unrecorded B1:nous_support:-:auth_user:RM:[T-17-RM] demoted while being reset t',
  'review fix: a demotion committing while Nous resets the user (injected under the reset''s lock) never leaves '
  || 'a reset written without its audit row; who may be reset and where it is recorded come from one snapshot, '
  || 'read before the demotion lands, so it is recorded in B1 (the old eligibility check followed by the list '
  || 'wrote it with audit_rows 0); the stand-ins are gone again'
);

-- Retention and cascade (C5).
update private.security_events e
set status = 'done', handled_at = '2001-01-01 00:00:00+00', result = 'notified'
where e.user_id = pg_temp.id('U4') and e.kind = 'factor_removed_unauthorized';
select set_config('t.purge', pg_temp.purge('2002-06-01 00:00:00+00'), true);

select is(
  concat_ws(' ', current_setting('t.purge') ~ '^[0-9]+ \| purge true [0-9]+ -$', pg_temp.events_of('U4'),
            pg_temp.block_of('U4'), private.enrolment_blocked(pg_temp.id('U4'))),
  't factor_added_unauthorized:F_U4n:pending:0:B1 no-event:p1 t',
  'C5: the purge deletes the finished removal event and keeps the block row (event_id null): blocks are never '
  || 'purged and still block'
);

select set_config('t.u7', (select count(*) from private.factor_enrolment_blocks b
                           where b.user_id = pg_temp.id('U7'))::text, true);
delete from auth.users u where u.id = pg_temp.id('U7');

select is(
  current_setting('t.u7') || ' -> '
    || (select count(*) from private.factor_enrolment_blocks b where b.user_id = pg_temp.id('U7'))::text,
  '1 -> 0',
  'C5: a blocked user deleted from auth.users takes the block row along (cascade)'
);

-- The RPC factor_enrolment_blocked (§2.5) and AN034. S_U4 ended at run 3: U4 signs in again (S_U4b).
select pg_temp.session('S_U4b', 'U4', 'aal1');

select is(
  concat_ws(' ',
    pg_temp.q('select public.factor_enrolment_blocked()::text', '', 'anon'),
    pg_temp.q('select private.factor_enrolment_blocked_impl()::text', '', 'anon'),
    pg_temp.q('select public.factor_enrolment_blocked()::text', '', 'service_role'),
    pg_temp.q('select private.factor_enrolment_blocked_impl()::text', '', 'service_role'),
    pg_temp.q('select public.factor_enrolment_blocked()::text', '{"role": "authenticated"}'),
    pg_temp.q('select private.factor_enrolment_blocked_impl()::text', '{"role": "authenticated"}'),
    pg_temp.q('select public.factor_enrolment_blocked()::text', pg_temp.s1('U1', 'S_U1a')),
    pg_temp.q('select private.factor_enrolment_blocked_impl()::text', pg_temp.s1('U1', 'S_U1a')),
    pg_temp.q('select public.factor_enrolment_blocked()::text', pg_temp.s2('M', 'S_M2')),
    pg_temp.q('select private.factor_enrolment_blocked_impl()::text', pg_temp.s2('M', 'S_M2')),
    pg_temp.q('select public.factor_enrolment_blocked()::text', pg_temp.s1('U4', 'S_U4b')),
    pg_temp.q('select private.factor_enrolment_blocked_impl()::text', pg_temp.s1('U4', 'S_U4b'))),
  '42501 42501 42501 42501 42501 42501 42501 42501 false false true true',
  'factor_enrolment_blocked and its _impl: anon and service_role cannot execute them; without a signed-in user or '
  || 'with a dead session → 42501 without hint; a live session gets the caller''s own state'
);

select is(
  pg_temp.q($$select 'no error'::text from private.raise_domain_error('AN034')$$, '', 'postgres'),
  'P0001/AN034/enrolment_blocked',
  'raise_domain_error(AN034) → P0001, message AN034, hint enrolment_blocked'
);

select is(
  (select string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):'
                     || format_type(p.prorettype, null) || ':' || l.lanname || ':' || p.provolatile::text || ':'
                     || case when p.prosecdef then 'definer' else 'invoker' end || ':'
                     || coalesce((select string_agg(r.role_name, ',' order by r.role_name)
                                  from unnest(array['anon', 'authenticated', 'service_role']) as r (role_name)
                                  where has_function_privilege(r.role_name, p.oid, 'execute')), '-'),
                     ' ' order by n.nspname, p.proname)
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   join pg_language l on l.oid = p.prolang
   where (n.nspname, p.proname) in (('public', 'factor_enrolment_blocked'), ('private', 'factor_enrolment_blocked_impl'))),
  'private.factor_enrolment_blocked_impl():boolean:plpgsql:s:definer:authenticated '
  || 'public.factor_enrolment_blocked():boolean:sql:s:invoker:authenticated',
  'the new RPC: _impl plpgsql SECURITY DEFINER in private, wrapper sql SECURITY INVOKER in public, both stable, '
  || 'no arguments (no p_business_id, no p_now), authenticated only'
);

select ok(
  coalesce(obj_description(to_regprocedure('public.factor_enrolment_blocked()'), 'pg_proc'), '') like 'Security:%AN034%',
  'public.factor_enrolment_blocked() carries its comment (Security: … AN034)'
);

-- The table (§2.2).
select is(
  concat_ws(' ',
    (select c.relrowsecurity from pg_class c where c.oid = to_regclass('private.factor_enrolment_blocks')),
    (select count(*) from pg_policies p where p.schemaname = 'private' and p.tablename = 'factor_enrolment_blocks'),
    (select coalesce(string_agg(r.role_name, ',' order by r.role_name), 'none')
     from unnest(array['anon', 'authenticated', 'service_role', 'public']) as r (role_name)
     where has_table_privilege(r.role_name, 'private.factor_enrolment_blocks',
                               'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r.role_name, 'private.factor_enrolment_blocks', 'SELECT,INSERT,UPDATE,REFERENCES'))),
  't 0 none',
  'private.factor_enrolment_blocks: RLS on, no policy, no privilege for anon, authenticated, service_role or PUBLIC'
);

select is(
  concat_ws(' | ',
    (select string_agg(c.column_name || ':' || c.data_type || ':' || c.is_nullable, ',' order by c.column_name)
     from information_schema.columns c
     where c.table_schema = 'private' and c.table_name = 'factor_enrolment_blocks'),
    (select string_agg(a.attname, ',' order by a.attname)
     from pg_constraint k
     join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
     where k.conrelid = to_regclass('private.factor_enrolment_blocks') and k.contype = 'p'),
    (select string_agg(k.confrelid::regclass::text || ':' || k.confdeltype::text, ',' order by k.confrelid::regclass::text)
     from pg_constraint k
     where k.conrelid = to_regclass('private.factor_enrolment_blocks') and k.contype = 'f')),
  'blocked_at:timestamp with time zone:NO,event_id:uuid:YES,user_id:uuid:NO | user_id | '
  || 'auth.users:c,private.security_events:n',
  'private.factor_enrolment_blocks: user_id primary key (cascade from auth.users), event_id nullable (set null '
  || 'when the event is purged), blocked_at not null'
);

select is(
  concat_ws(' ',
    pg_temp.q('select count(*)::text from private.factor_enrolment_blocks', '', 'anon'),
    pg_temp.q('select count(*)::text from private.factor_enrolment_blocks', pg_temp.s2('M', 'S_M2')),
    pg_temp.q('select count(*)::text from private.factor_enrolment_blocks', '', 'service_role'),
    pg_temp.q($$delete from private.factor_enrolment_blocks b where b.user_id = {U4} returning 'deleted'$$, '',
              'service_role')),
  '42501 42501 42501 42501',
  'no API role reads the block table directly, and service_role cannot lift a block by hand'
);

select * from finish();
rollback;
