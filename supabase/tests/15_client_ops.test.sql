-- Client card, merge and erasure (phase-1 plan 1.8 «Tests», contract
-- docs/plans/contracts/1.8-client-ops.md §0, §2 and §5.1; SPEC §4, §5, §7, §11, §13; ADR-0009 C6).
-- Written from the plan and the contract only (independent author).
--   0. the two new domain errors (AN032 client_has_upcoming, AN033 client_unavailable)
--   A. merge_clients through the wrapper as authenticated (owner and manager): appointments, notes and
--      messages move, one audit row, consents stay on the source byte for byte and are read through
--      the target, the target's gaps are filled, idempotency, flattening, refusals, cross-business;
--      merge_clients_core with actor import (no JWT) and its refusals; no appointment event fires
--   B. staff neither merge nor erase; a manager never erases (role before the fresh code)
--   C. client_card_impl: amounts by role nulled inside the _impl (and through the wrapper), own, can,
--      the ring (no visits, within, beyond, exactly the interval, no interval, local dates), the exact
--      shape, the merged / erased states, refusals, D2
--   D. set_client_consent (on = a new staff_ui record, off = withdraw every active grant of the
--      family), shape errors, AN033, no direct writes; consent_state over the family; the 1.3 booking
--      box made family-aware (apply_marketing_box)
--   E. the guard: no note or consent for an erased or merged client, for every role
--   F. the fresh-code matrix of erase_client_impl (the window is set explicitly to 300 s); another
--      shop's, an unknown or a null client id; the fresh code checked before AN032
--   G. erasure: AN032 (family-wide, in progress included), the catalog scan (non-vacuous), every
--      effect of §2.7, the suppression HMAC, the readers (search, card, today_summary,
--      clients_for_phone, verified_via, manage_view, the claim), idempotency, a family erased through
--      a merged source's id, the shared phone of a live client, the same person at another shop, and
--      the numbers a client used before its mobile was changed on the card (review of 1.8)
-- Conventions (as 14_members_identity):
--   · Claims are built relative to now() of the transaction (pg_temp.claims). Every user of the
--     fixture is without factor rows (D2 lets them in at aal1) except OE, used only for the D2 check.
--   · Every member call goes through pg_temp.q: role and claims are set for that one statement and
--     reset afterwards; the declared actor is '' during the call and 'system' otherwise (fixtures).
--   · Outcomes: the value, '<null>', the SQLSTATE, '42501/<hint>' when a 42501 carries a hint of
--     ours, or 'P0001/<AN code>' for a domain error. A stored result is never read in the statement
--     that writes it; reads in such a statement go through volatile helpers or pg_temp.q (each takes
--     a fresh snapshot). concat_ws prints booleans as t/f.
--   · The card and the ring use a fixed clock {T0} = 2026-06-10 09:00Z (12:00 in Athens). The erase
--     has no clock argument: what it must see as upcoming is relative to now(); the rest of the
--     history is in May/June 2026.
--   · Vault keys are upserted and every platform setting the file relies on is set here, so it runs
--     the same locally and with db:test:dev.
--   · The catalog scan counts, per column, the rows that hold a needle, against a baseline taken
--     before the fixture: rows already in the database (a leftover e2e client with the same name,
--     the same person at another shop) never count; only what this file adds does.
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
-- Fixtures are written by the system; pg_temp.q declares '' around every member call.
select set_config('anaklo.actor_type', 'system', true);
select plan(95);

-- The window of C6 (section F moves it to 0 and back), the SMS switches and caps the claims need.
update private.platform_settings
set fresh_totp_max_age_seconds = 300, sms_enabled = true, sms_daily_cap = 100000, sms_per_phone_day = 1000,
    sms_per_business_day = 100000, sms_otp_reserve_pct = 20, sms_monthly_cap = 1000000, push_enabled = true
where id;

-- The ring compares with the next-visit interval: barber 28 days (4 weeks), beauty none.
insert into private.vertical_defaults (vertical, rebook_interval_days) values ('barber', 28)
on conflict (vertical) do update set rebook_interval_days = excluded.rebook_interval_days;
delete from private.vertical_defaults where vertical = 'beauty';

-- ---------------------------------------------------------------------------------------------
-- Labels
-- ---------------------------------------------------------------------------------------------
create temporary table lbl (id uuid primary key, label text not null unique);

insert into pg_temp.lbl (id, label) values
  -- users
  ('e1500000-0000-4000-8000-000000000001', 'O'),
  ('e1500000-0000-4000-8000-000000000002', 'M'),
  ('e1500000-0000-4000-8000-000000000003', 'S'),
  ('e1500000-0000-4000-8000-000000000004', 'S2'),
  ('e1500000-0000-4000-8000-000000000005', 'X'),
  ('e1500000-0000-4000-8000-000000000006', 'OE'),
  ('e1500000-0000-4000-8000-0000000000ff', 'NOBODY'),   -- never inserted: an unknown id
  -- businesses
  ('e1510000-0000-4000-8000-000000000001', 'B1'),
  ('e1510000-0000-4000-8000-000000000002', 'B2'),
  ('e1510000-0000-4000-8000-000000000003', 'B3'),
  ('e1510000-0000-4000-8000-000000000004', 'B4'),     -- the same person at another shop (baseline)
  -- staff rows
  ('e1520000-0000-4000-8000-000000000001', 'St'),
  ('e1520000-0000-4000-8000-000000000002', 'St2'),
  ('e1520000-0000-4000-8000-000000000003', 'StX'),
  ('e1520000-0000-4000-8000-000000000004', 'St3'),
  -- clients
  ('e1530000-0000-4000-8000-000000000001', 'C'),
  ('e1530000-0000-4000-8000-000000000002', 'D'),
  ('e1530000-0000-4000-8000-000000000003', 'E'),
  ('e1530000-0000-4000-8000-000000000004', 'E2'),
  ('e1530000-0000-4000-8000-000000000005', 'ER'),
  ('e1530000-0000-4000-8000-000000000006', 'L1'),
  ('e1530000-0000-4000-8000-000000000007', 'L2'),
  ('e1530000-0000-4000-8000-000000000008', 'K'),
  ('e1530000-0000-4000-8000-000000000009', 'FR'),
  ('e1530000-0000-4000-8000-00000000000a', 'FS'),
  ('e1530000-0000-4000-8000-00000000000b', 'S1a'),
  ('e1530000-0000-4000-8000-00000000000c', 'T1a'),
  ('e1530000-0000-4000-8000-00000000000d', 'S2b'),
  ('e1530000-0000-4000-8000-00000000000e', 'T2b'),
  ('e1530000-0000-4000-8000-00000000000f', 'H0'),
  ('e1530000-0000-4000-8000-000000000010', 'H1'),
  ('e1530000-0000-4000-8000-000000000011', 'HT'),
  ('e1530000-0000-4000-8000-000000000012', 'Q0'),
  ('e1530000-0000-4000-8000-000000000013', 'Q1'),
  ('e1530000-0000-4000-8000-000000000014', 'Q2'),
  ('e1530000-0000-4000-8000-000000000015', 'R0'),
  ('e1530000-0000-4000-8000-000000000016', 'R1'),
  ('e1530000-0000-4000-8000-000000000017', 'R2'),
  ('e1530000-0000-4000-8000-000000000018', 'R3'),
  ('e1530000-0000-4000-8000-000000000019', 'R5'),
  ('e1530000-0000-4000-8000-00000000001a', 'XB'),
  ('e1530000-0000-4000-8000-00000000001b', 'MC1'),
  ('e1530000-0000-4000-8000-00000000001c', 'MC2'),
  ('e1530000-0000-4000-8000-00000000001d', 'Y'),      -- B4: C's name and number, before the fixture
  ('e1530000-0000-4000-8000-00000000001e', 'P'),      -- its mobile changed after an online booking
  -- appointments
  ('e1550000-0000-4000-8000-000000000001', 'CA1'),
  ('e1550000-0000-4000-8000-000000000002', 'CA2'),
  ('e1550000-0000-4000-8000-000000000003', 'CA3'),
  ('e1550000-0000-4000-8000-000000000004', 'CA4'),
  ('e1550000-0000-4000-8000-000000000005', 'CA5'),
  ('e1550000-0000-4000-8000-000000000006', 'CA6'),
  ('e1550000-0000-4000-8000-000000000007', 'SA1'),
  ('e1550000-0000-4000-8000-000000000008', 'SA2'),
  ('e1550000-0000-4000-8000-000000000009', 'TA1'),
  ('e1550000-0000-4000-8000-00000000000a', 'SB1'),
  ('e1550000-0000-4000-8000-00000000000b', 'H1A'),
  ('e1550000-0000-4000-8000-00000000000c', 'RA0'),
  ('e1550000-0000-4000-8000-00000000000d', 'RA1'),
  ('e1550000-0000-4000-8000-00000000000e', 'RA2'),
  ('e1550000-0000-4000-8000-00000000000f', 'RA3'),
  ('e1550000-0000-4000-8000-000000000010', 'RA5'),
  ('e1550000-0000-4000-8000-000000000011', 'EA0'),
  ('e1550000-0000-4000-8000-000000000012', 'EA1'),
  ('e1550000-0000-4000-8000-000000000013', 'DA1'),
  ('e1550000-0000-4000-8000-000000000014', 'DA2'),
  ('e1550000-0000-4000-8000-000000000015', 'XA1'),
  ('e1550000-0000-4000-8000-000000000016', 'MCA'),
  ('e1550000-0000-4000-8000-000000000017', 'PA0'),
  ('e1550000-0000-4000-8000-000000000018', 'PA1'),
  -- notes
  ('e1560000-0000-4000-8000-000000000001', 'N1'),
  ('e1560000-0000-4000-8000-000000000002', 'N2'),
  ('e1560000-0000-4000-8000-000000000003', 'SN1'),
  ('e1560000-0000-4000-8000-000000000004', 'SN2'),
  ('e1560000-0000-4000-8000-000000000005', 'TN1'),
  ('e1560000-0000-4000-8000-000000000006', 'NL1'),     -- written by the owner in section E
  -- consents
  ('e1570000-0000-4000-8000-000000000001', 'CC1'),
  ('e1570000-0000-4000-8000-000000000002', 'CC2'),
  ('e1570000-0000-4000-8000-000000000003', 'SC1'),
  ('e1570000-0000-4000-8000-000000000004', 'SC2'),
  ('e1570000-0000-4000-8000-000000000005', 'TC1'),
  ('e1570000-0000-4000-8000-000000000006', 'FRC1'),
  ('e1570000-0000-4000-8000-000000000007', 'FRC2'),
  ('e1570000-0000-4000-8000-000000000008', 'FRC3'),
  ('e1570000-0000-4000-8000-000000000009', 'FSC1'),
  ('e1570000-0000-4000-8000-00000000000a', 'EC1'),
  -- outbox rows
  ('e1580000-0000-4000-8000-000000000001', 'CM1'),
  ('e1580000-0000-4000-8000-000000000002', 'CM2'),
  ('e1580000-0000-4000-8000-000000000003', 'CM3'),
  ('e1580000-0000-4000-8000-000000000004', 'SM1'),
  ('e1580000-0000-4000-8000-000000000005', 'DM1'),
  ('e1580000-0000-4000-8000-000000000006', 'DM2'),
  ('e1580000-0000-4000-8000-000000000007', 'DM3'),
  ('e1580000-0000-4000-8000-000000000008', 'PM1'),
  ('e1580000-0000-4000-8000-000000000009', 'PM2'),
  ('e1580000-0000-4000-8000-00000000000a', 'PM3'),
  -- OTP challenges, trusted devices, manage tokens
  ('e1590000-0000-4000-8000-000000000001', 'CH1'),
  ('e1590000-0000-4000-8000-000000000002', 'CH2'),
  ('e1590000-0000-4000-8000-000000000003', 'CH3'),
  ('e1590000-0000-4000-8000-000000000004', 'CHP1'),
  ('e1590000-0000-4000-8000-000000000005', 'CHP2'),
  ('e15a0000-0000-4000-8000-000000000001', 'TD1'),
  ('e15a0000-0000-4000-8000-000000000002', 'TD2'),
  ('e15a0000-0000-4000-8000-000000000003', 'TDE'),
  ('e15a0000-0000-4000-8000-000000000004', 'TDP1'),
  ('e15a0000-0000-4000-8000-000000000005', 'TDP2'),
  ('e15b0000-0000-4000-8000-000000000001', 'BT1'),
  ('e15b0000-0000-4000-8000-000000000002', 'BT2'),
  ('e15b0000-0000-4000-8000-000000000003', 'BT3'),
  -- factor, service
  ('e15c0000-0000-4000-8000-000000000001', 'OE.v'),
  ('e15d0000-0000-4000-8000-000000000001', 'SV1');

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

create function pg_temp.shops()
returns uuid[]
language sql
stable
as $fn$
  select array[pg_temp.id('B1'), pg_temp.id('B2'), pg_temp.id('B3')];
$fn$;

-- Replaces {LABEL} with the quoted uuid of that label and {T0} with the fixed clock of the card.
create function pg_temp.fill(a_template text)
returns text
language plpgsql
stable
as $fn$
declare
  v text := replace(a_template, '{T0}', quote_literal('2026-06-10 09:00:00+00') || '::timestamptz');
  x record;
begin
  for x in select y.id, y.label from pg_temp.lbl y loop
    v := replace(v, '{' || x.label || '}', quote_literal(x.id::text) || '::uuid');
  end loop;
  return v;
end;
$fn$;

-- Whole epoch seconds a_seconds before now() of the transaction.
create function pg_temp.ago(a_seconds integer)
returns bigint
language sql
stable
as $fn$
  select floor(extract(epoch from now()))::bigint - a_seconds;
$fn$;

-- amr after the email code only
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
    -- A missing table privilege carries the server's own advice (Supabase's Postgres 17); that is
    -- not a hint of ours and is reported as the bare code. Every other 42501 hint is reported.
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
    perform vault.create_secret(a_value, a_name, 'pgTAP 15_client_ops');
  else
    perform vault.update_secret(v_id, a_value, a_name, 'pgTAP 15_client_ops');
  end if;
end;
$fn$;

-- SQLSTATE/message/hint of a domain error.
create function pg_temp.hint_of(a_code text)
returns text
language plpgsql
as $fn$
declare
  v_state text;
  v_msg text;
  v_hint text;
begin
  perform private.raise_domain_error(a_code);
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  return concat_ws('/', v_state, v_msg, v_hint);
end;
$fn$;

-- The refusal matrix of a critical _impl (plan 1.7 / 1.8 «Tests»): a_user at aal1, with a 6-minute-old
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

-- Calls by label (null label → NULL argument; a_business defaults to B1).
create function pg_temp.card(a_client text, a_claims text, a_business text default 'B1')
returns text language sql as $fn$
  select pg_temp.q(format(
    'select private.client_card_impl(p_business_id => %L::uuid, p_client_id => %L::uuid, p_now => {T0})::text',
    pg_temp.id(a_business), pg_temp.id(a_client)), a_claims);
$fn$;

create function pg_temp.merge(a_source text, a_target text, a_claims text, a_business text default 'B1')
returns text language sql as $fn$
  select pg_temp.q(format(
    'select public.merge_clients(p_business_id => %L::uuid, p_source => %L::uuid, p_target => %L::uuid)::text',
    pg_temp.id(a_business), pg_temp.id(a_source), pg_temp.id(a_target)), a_claims);
$fn$;

create function pg_temp.erase(a_client text, a_claims text)
returns text language sql as $fn$
  select pg_temp.q(format(
    'select public.erase_client(p_business_id => %L::uuid, p_client_id => %L::uuid)::text',
    pg_temp.id('B1'), pg_temp.id(a_client)), a_claims);
$fn$;

create function pg_temp.erase_impl(a_client text, a_claims text)
returns text language sql as $fn$
  select pg_temp.q(format(
    'select private.erase_client_impl(p_business_id => %L::uuid, p_client_id => %L::uuid)::text',
    pg_temp.id('B1'), pg_temp.id(a_client)), a_claims);
$fn$;

create function pg_temp.consent(a_client text, a_purpose text, a_granted boolean, a_given_by text, a_policy text,
                                a_claims text)
returns text language sql as $fn$
  select pg_temp.q(format(
    'select public.set_client_consent(p_business_id => %L::uuid, p_client_id => %L::uuid, p_purpose => %L, '
    || 'p_granted => %L::boolean, p_given_by => %L, p_policy_version => %L)::text',
    pg_temp.id('B1'), pg_temp.id(a_client), a_purpose, a_granted, a_given_by, a_policy), a_claims);
$fn$;

-- private.consent_state (as postgres): 'state:record label', or the error.
create function pg_temp.cstate(a_client text, a_purpose text default 'marketing_sms')
returns text
language plpgsql
as $fn$
declare
  v text;
begin
  v := pg_temp.q(format(
    'select private.consent_state(p_business_id => %L::uuid, p_root => %L::uuid, p_purpose => %L)::text',
    pg_temp.id('B1'), pg_temp.id(a_client), a_purpose), '', 'postgres');
  if left(v, 1) = '{' then
    return (v::jsonb ->> 'state') || ':' || pg_temp.lt(v::jsonb ->> 'record_id');
  end if;
  return v;
end;
$fn$;

-- Volatile readers (a fresh snapshot each, so they see what pg_temp.q wrote in the same statement).
create function pg_temp.appts_of(a_client text) returns bigint language sql as $fn$
  select count(*) from public.appointments a where a.client_id = pg_temp.id(a_client);
$fn$;

create function pg_temp.notes_of(a_client text) returns bigint language sql as $fn$
  select count(*) from public.client_notes n where n.client_id = pg_temp.id(a_client);
$fn$;

create function pg_temp.consents_of(a_client text) returns bigint language sql as $fn$
  select count(*) from public.client_consents k where k.client_id = pg_temp.id(a_client);
$fn$;

create function pg_temp.consents_total() returns bigint language sql as $fn$
  select count(*) from public.client_consents k where k.business_id = any (pg_temp.shops());
$fn$;

-- Fingerprint of everything a refused call must leave alone (the three businesses of this file).
create function pg_temp.fp()
returns text
language sql
as $fn$
  select md5(concat_ws('|',
    (select string_agg(to_jsonb(c)::text, ',' order by c.id) from public.clients c
     where c.business_id = any (pg_temp.shops())),
    (select string_agg(concat_ws(':', a.id, a.client_id, a.status, a.request_hash, a.external_ref, a.total_cents,
                                 a.charged_cents), ',' order by a.id)
     from public.appointments a where a.business_id = any (pg_temp.shops())),
    (select string_agg(concat_ws(':', n.id, n.client_id, n.body), ',' order by n.id)
     from public.client_notes n where n.business_id = any (pg_temp.shops())),
    (select string_agg(to_jsonb(k)::text, ',' order by k.id)
     from public.client_consents k where k.business_id = any (pg_temp.shops())),
    (select string_agg(concat_ws(':', m.id, m.client_id, m.to_e164, m.status), ',' order by m.id)
     from public.messages_log m where m.business_id = any (pg_temp.shops())),
    (select count(*) from public.audit_log a where a.business_id = any (pg_temp.shops())),
    (select count(*) from public.suppression_list s where s.business_id = any (pg_temp.shops())),
    (select string_agg(concat_ws(':', t.id, t.revoked_at), ',' order by t.id)
     from public.booking_tokens t where t.business_id = any (pg_temp.shops())),
    (select string_agg(concat_ws(':', d.id, d.revoked_at), ',' order by d.id)
     from public.trusted_devices d where d.business_id = any (pg_temp.shops())),
    (select string_agg(concat_ws(':', o.id, o.phone_hmac), ',' order by o.id)
     from public.otp_challenges o where o.business_id = any (pg_temp.shops())),
    (select count(*) from public.appointment_events e where e.business_id = any (pg_temp.shops()))));
$fn$;

-- Fingerprint of a client's appointments, without the two columns the erase nulls.
create function pg_temp.appts_fp(a_client text)
returns text
language sql
as $fn$
  select md5(string_agg(concat_ws(':', a.id, a.client_id, a.staff_id, a.starts_at, a.ends_at, a.status, a.source,
                                  a.verified_via, a.referrer, a.total_cents, a.charged_cents, a.idempotency_key,
                                  a.cancelled_by, a.cancel_reason, a.created_by, a.created_at, a.buffer_after_min),
                        ',' order by a.id))
  from public.appointments a where a.client_id = pg_temp.id(a_client);
$fn$;

-- Audit rows of one action (optionally of one entity):
-- 'business:actor_type:actor:entity:entity_id:reason', by business then id; '-' for none.
create function pg_temp.audit(a_action text, a_entity text default null)
returns text language sql as $fn$
  select coalesce(string_agg(concat_ws(':', pg_temp.l(a.business_id), a.actor_type, pg_temp.l(a.actor_id), a.entity,
                                       pg_temp.l(a.entity_id), coalesce(a.reason, '-')),
                             ',' order by pg_temp.l(a.business_id), a.id), '-')
  from public.audit_log a
  where a.action = a_action
    and (a_entity is null or a.entity_id = pg_temp.id(a_entity));
$fn$;

create function pg_temp.audit_count(a_action text, a_entity text)
returns bigint language sql as $fn$
  select count(*) from public.audit_log a where a.action = a_action and a.entity_id = pg_temp.id(a_entity);
$fn$;

-- Keys of a JSON object, comma-separated in byte order.
create function pg_temp.keys(a_object jsonb)
returns text
language sql
immutable
as $fn$
  select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(a_object) as k;
$fn$;

-- One field of every element of a JSON array (ids as labels), in array order; '-' when empty.
create function pg_temp.col(a_list jsonb, a_key text)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(pg_temp.lt(e.v ->> a_key), ',' order by e.ord), '-')
  from jsonb_array_elements(coalesce(a_list, '[]'::jsonb)) with ordinality as e (v, ord);
$fn$;

-- A JSON array of uuids as labels; '-' when empty.
create function pg_temp.ids(a_list jsonb)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(pg_temp.lt(e.v), ',' order by e.ord), '-')
  from jsonb_array_elements_text(coalesce(a_list, '[]'::jsonb)) with ordinality as e (v, ord);
$fn$;

-- One appointment item of a card (upcoming or history).
create function pg_temp.item(a_card jsonb, a_label text)
returns jsonb
language sql
stable
as $fn$
  select i
  from jsonb_array_elements(coalesce(a_card -> 'upcoming', '[]'::jsonb) || coalesce(a_card -> 'history', '[]'::jsonb)) as i
  where i ->> 'appointment_id' = pg_temp.id(a_label)::text;
$fn$;

-- 'appointment:amount:own' of every item of a card, by label.
create function pg_temp.amounts(a_card jsonb)
returns text
language sql
stable
as $fn$
  select string_agg(pg_temp.lt(i ->> 'appointment_id') || ':' || coalesce(i ->> 'amount_cents', '-') || ':'
                    || coalesce(i ->> 'own', '?'), ' ' order by pg_temp.lt(i ->> 'appointment_id'))
  from jsonb_array_elements(coalesce(a_card -> 'upcoming', '[]'::jsonb) || coalesce(a_card -> 'history', '[]'::jsonb)) as i;
$fn$;

-- 'state days interval_days weeks fraction overdue hint_key' of a card's ring (fraction to 2 places).
create function pg_temp.ring(a_card jsonb)
returns text
language sql
immutable
as $fn$
  select concat_ws(' ',
    coalesce(a_card -> 'ring' ->> 'state', '?'),
    coalesce(a_card -> 'ring' ->> 'days_since_last', '-'),
    coalesce(a_card -> 'ring' ->> 'interval_days', '-'),
    coalesce(a_card -> 'ring' ->> 'interval_weeks', '-'),
    coalesce(round((a_card -> 'ring' ->> 'fraction')::numeric, 2)::text, '-'),
    coalesce(a_card -> 'ring' ->> 'overdue_days', '-'),
    coalesce(a_card -> 'ring' ->> 'hint_key', '-'));
$fn$;

-- 'note:by_me:can_delete:author_role:author_name' of a card's notes, in card order.
create function pg_temp.notes(a_card jsonb)
returns text
language sql
stable
as $fn$
  select string_agg(concat_ws(':', pg_temp.lt(x.n ->> 'id'), x.n ->> 'by_me', x.n ->> 'can_delete',
                              coalesce(x.n ->> 'author_role', '-'), coalesce(x.n ->> 'author_name', '-')),
                    ' ' order by x.o)
  from jsonb_array_elements(a_card -> 'notes') with ordinality as x (n, o);
$fn$;

-- 'purpose:state:record' of a card's current consents, by purpose.
create function pg_temp.current(a_card jsonb)
returns text
language sql
stable
as $fn$
  select string_agg(concat_ws(':', e.k, e.v ->> 'state', pg_temp.lt(e.v ->> 'record_id')), ' ' order by e.k collate "C")
  from jsonb_each(a_card -> 'consents' -> 'current') as e (k, v);
$fn$;

-- The catalog scan of §5.1-G: every column of type text, varchar, char, json, jsonb (or a domain over
-- one, or an array of one) of every base table in public and private, matched raw (ilike) and
-- normalised (lower case, no accents: private.normalize_greek) against the needles of one person:
--   C «Ξενοφών Ζαχαρίας», +306970001234;
--   P «Ερμόλαος Βαρδαλάκης», every number it used: +306970077002 and +306970077001 before the
--     edit of its mobile, +306970077003 after it.
-- pg_temp.scan_counts gives the rows with a hit per column (pg_temp.scan_cols keeps every column
-- scanned); pg_temp.scan_baseline stores them before the fixture; pg_temp.scan returns the columns
-- that hold more rows with a hit than the baseline (what this file added and the erase left).
create temporary table scan_cols (col text primary key);
create temporary table scan_base (needles text not null, col text not null, hits bigint not null,
                                  primary key (needles, col));

create function pg_temp.needles(a_set text, out raw text[], out norm text[])
language sql
immutable
as $fn$
  select
    case a_set
      when 'C' then array['%Ξενοφών Ζαχαρίας%', '%+306970001234%', '%306970001234%', '%6970001234%']
      when 'P' then array['%Ερμόλαος Βαρδαλάκης%', '%+306970077001%', '%306970077001%', '%6970077001%',
                          '%+306970077002%', '%306970077002%', '%6970077002%',
                          '%+306970077003%', '%306970077003%', '%6970077003%']
    end,
    case a_set
      when 'C' then array['%ξενοφων%', '%ζαχαρι%', '%xenofon%', '%zachar%', '%zaxar%', '%zahar%', '%6970001234%']
      when 'P' then array['%ερμολαος%', '%βαρδαλακ%', '%ermolaos%', '%vardalak%', '%bardalak%',
                          '%6970077001%', '%6970077002%', '%6970077003%']
    end;
$fn$;

create function pg_temp.scan_counts(a_set text)
returns table (hit_col text, hit_rows bigint)
language plpgsql
as $fn$
declare
  v_raw text[] := (pg_temp.needles(a_set)).raw;
  v_norm text[] := (pg_temp.needles(a_set)).norm;
  v_types regtype[] := array['text', 'character varying', 'character', 'json', 'jsonb',
                             'text[]', 'character varying[]', 'character[]', 'json[]', 'jsonb[]']::regtype[];
  x record;
  v_rows bigint;
begin
  if v_raw is null then
    raise exception 'unknown needle set %', a_set;
  end if;
  delete from pg_temp.scan_cols;
  for x in
    select n.nspname::text as nsp, c.relname::text as rel, a.attname::text as att
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    join pg_type t on t.oid = a.atttypid
    where n.nspname in ('public', 'private')
      and c.relkind in ('r', 'p')
      and a.attnum > 0
      and not a.attisdropped
      and (case when t.typtype = 'd' then t.typbasetype else t.oid end)::regtype = any (v_types)
    order by 1, 2, 3
  loop
    insert into pg_temp.scan_cols (col) values (x.nsp || '.' || x.rel || '.' || x.att);
    execute format(
      'select count(*) from %I.%I x where x.%I::text ilike any ($1) '
      || 'or private.normalize_greek(x.%I::text) like any ($2)',
      x.nsp, x.rel, x.att, x.att)
      into v_rows using v_raw, v_norm;
    if v_rows > 0 then
      hit_col := x.nsp || '.' || x.rel || '.' || x.att;
      hit_rows := v_rows;
      return next;
    end if;
  end loop;
end;
$fn$;

create function pg_temp.scan_baseline(a_set text)
returns void
language sql
as $fn$
  insert into pg_temp.scan_base (needles, col, hits)
  select a_set, s.hit_col, s.hit_rows from pg_temp.scan_counts(a_set) s;
$fn$;

create function pg_temp.scan(a_set text default 'C')
returns text[]
language sql
as $fn$
  select coalesce(array_agg(s.hit_col order by s.hit_col), array[]::text[])
  from pg_temp.scan_counts(a_set) s
  left join pg_temp.scan_base b on b.needles = a_set and b.col = s.hit_col
  where s.hit_rows > coalesce(b.hits, 0);
$fn$;

-- ---------------------------------------------------------------------------------------------
-- Keys (upsert; the rollback restores them)
-- ---------------------------------------------------------------------------------------------
select pg_temp.set_vault('phone_hmac_key', 'pgtap-15-phone-hmac-key-not-a-secret-0001');
select pg_temp.set_vault('otp_hmac_key', 'pgtap-15-otp-hmac-key-not-a-secret-00001');

-- ---------------------------------------------------------------------------------------------
-- What the database holds before the fixture: the scan's baseline. B4 holds the same person at
-- another shop (C's name, as a leftover e2e client of an interrupted run would hold it, and C's
-- number): the erase in B1 never touches it, and the scan never counts it.
-- ---------------------------------------------------------------------------------------------
insert into public.businesses (id, slug, name, vertical, timezone, booking_enabled, import_reminders) values
  (pg_temp.id('B4'), 'clients15-y', 'Clients 15 Y', 'barber', 'Europe/Athens', false, false);
insert into public.clients (id, business_id, full_name, phone_e164, locale, source) values
  (pg_temp.id('Y'), pg_temp.id('B4'), 'Ξενοφών Ζαχαρίας ψωμχ', '+306970001234', 'el', 'staff');

select pg_temp.scan_baseline('C');
select pg_temp.scan_baseline('P');

-- ---------------------------------------------------------------------------------------------
-- Fixture (as postgres, actor system)
--   B1 'clients15-a' (Europe/Athens, barber, booking on, import reminders on): O owner (no staff row),
--     M manager, S staff (St «Σταύρος»), S2 staff (St2 «Στέλιος»), OE owner with a verified factor.
--   B2 'clients15-x': X owner (StX); client XB; a device and a challenge for C's number (HMAC only).
--   B3 'clients15-b' (beauty: no vertical default → no next-visit hint): O owner (St3); client R5.
--   C «Ξενοφών Ζαχαρίας» +306970001234: CA1 completed (St, charged 1800), CA2 completed (St2), CA3
--     no_show (St), CA4 cancelled (St2), CA5 past booked online (St, to mark, idempotency key, request
--     hash, external_ref), CA6 booked in 3 days (St2, cancelled before the erase); notes N1 (by S,
--     names him) and N2 (by O); consents CC1 (booking form grant) and CC2 (photos, staff); the OTP
--     challenge CH1 with a live grant, device TD1, manage tokens BT1/BT2 (+ BT3 already revoked);
--     outbox CM1 (sent), CM2 (queued), CM3 (OTP row without client).
--   Merge pairs: S1a → T1a (owner), S2b → T2b (manager), H1 → HT with H0 → H1 already (flatten),
--     MC1 → MC2 (core, import). Q0 → Q1 → Q2: a chain written as postgres (the card follows it).
--   Families: FS merged into FR (consents), E2 merged into E (erase through E2; E shares its number
--     with the live client D). ER: an erased client. L1, L2: live clients. K: consents.
--   Ring clients R0..R3 (B1) and R5 (B3).
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select x.id, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated',
       lower(x.label) || '@clients15.test', '{}'::jsonb, '{}'::jsonb, now(), now()
from pg_temp.lbl x
where x.id::text like 'e1500000-%' and x.label <> 'NOBODY';

insert into public.businesses (id, slug, name, vertical, timezone, booking_enabled, import_reminders) values
  (pg_temp.id('B1'), 'clients15-a', 'Clients 15 A', 'barber', 'Europe/Athens', true, true),
  (pg_temp.id('B2'), 'clients15-x', 'Clients 15 X', 'barber', 'Europe/Athens', true, false),
  (pg_temp.id('B3'), 'clients15-b', 'Clients 15 B', 'beauty', 'Europe/Athens', false, false);

insert into public.staff (id, business_id, display_name) values
  (pg_temp.id('St'), pg_temp.id('B1'), 'Σταύρος'),
  (pg_temp.id('St2'), pg_temp.id('B1'), 'Στέλιος'),
  (pg_temp.id('StX'), pg_temp.id('B2'), 'Staff X'),
  (pg_temp.id('St3'), pg_temp.id('B3'), 'Staff B3');

insert into public.business_members (business_id, user_id, role, staff_id)
select pg_temp.id(m.b), pg_temp.id(m.u), m.role, pg_temp.id(m.s)
from (values
  ('B1', 'O', 'owner', null), ('B1', 'M', 'manager', null), ('B1', 'S', 'staff', 'St'),
  ('B1', 'S2', 'staff', 'St2'), ('B1', 'OE', 'owner', null),
  ('B2', 'X', 'owner', 'StX'),
  ('B3', 'O', 'owner', 'St3')
) as m (b, u, role, s);

insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
  (pg_temp.id('OE.v'), pg_temp.id('OE'), 'OE phone', 'totp', 'verified', now() - interval '3 days',
   now() - interval '3 days', 'PGTAPSYNTHETICSECRETOE1');

insert into public.services (id, business_id, name, duration_min, price_cents) values
  (pg_temp.id('SV1'), pg_temp.id('B1'), 'Κούρεμα', 30, 1500);

insert into public.clients (id, business_id, full_name, phone_e164, phone_verified_at, email, birthday, locale, source,
                            external_ref, erased_at, created_at)
select pg_temp.id(c.label), pg_temp.id(c.shop), c.full_name, c.phone, c.verified::timestamptz, c.email, c.birthday::date,
       'el', c.source, c.external_ref, c.erased::timestamptz, coalesce(c.created::timestamptz, now() - interval '400 days')
from (values
  ('C', 'B1', 'Ξενοφών Ζαχαρίας', '+306970001234', '2026-06-01 06:51Z', 'xenofon.zacharias@example.test', '1990-03-14',
   'online', 'pos-xenofon-17', null, '2026-04-01 08:00Z'),
  ('D', 'B1', 'Δανάη Κοινού', '+306942000001', null, null, null, 'staff', null, null, null),
  ('E', 'B1', 'Ευανθία Ριζίδου', '+306942000001', '2026-05-01 08:00Z', null, null, 'online', null, null, '2026-02-01 08:00Z'),
  ('E2', 'B1', 'Ευανθία Δεύτερη', '+306942000002', null, null, null, 'staff', null, null, '2026-02-02 08:00Z'),
  ('ER', 'B1', '', null, null, null, null, 'staff', null, '2026-05-01 08:00Z', null),
  ('L1', 'B1', 'Λευτέρης Ζωντανός', '+306941000011', null, null, null, 'staff', null, null, null),
  ('L2', 'B1', 'Λίνα Ζωντανή', null, null, null, null, 'staff', null, null, null),
  ('K', 'B1', 'Κική Συναίνεση', '+306941000021', null, null, null, 'staff', null, null, null),
  ('FR', 'B1', 'Φοίβος Ρίζα', '+306941000031', null, null, null, 'online', null, null, null),
  ('FS', 'B1', 'Φοίβος Πηγή', '+306941000032', null, null, null, 'online', null, null, null),
  ('S1a', 'B1', 'Σπύρος Πηγή', '+306941000041', '2026-05-02 10:00Z', 'spyros.pigi@example.test', '1985-07-01',
   'online', null, null, null),
  ('T1a', 'B1', 'Σπύρος Στόχος', null, null, null, null, 'staff', null, null, null),
  ('S2b', 'B1', 'Παντελής Πηγή', '+306941000051', null, 'pantelis@example.test', null, 'staff', null, null, null),
  ('T2b', 'B1', 'Παντελής Στόχος', '+306941000052', '2026-05-03 10:00Z', null, '1979-01-02', 'online', null, null, null),
  ('H0', 'B1', 'Χάρης Παλιός', null, null, null, null, 'staff', null, null, null),
  ('H1', 'B1', 'Χάρης Ενδιάμεσος', null, null, null, null, 'staff', null, null, null),
  ('HT', 'B1', 'Χάρης Τελικός', null, null, null, null, 'staff', null, null, null),
  ('Q0', 'B1', 'Κώστας Ένα', null, null, null, null, 'staff', null, null, null),
  ('Q1', 'B1', 'Κώστας Δύο', null, null, null, null, 'staff', null, null, null),
  ('Q2', 'B1', 'Κώστας Τρία', null, null, null, null, 'staff', null, null, null),
  ('R0', 'B1', 'Ρένα Μηδέν', null, null, null, null, 'staff', null, null, null),
  ('R1', 'B1', 'Ρένα Δέκα', null, null, null, null, 'staff', null, null, null),
  ('R2', 'B1', 'Ρένα Σαράντα', null, null, null, null, 'staff', null, null, null),
  ('R3', 'B1', 'Ρένα Εικοσιοκτώ', null, null, null, null, 'staff', null, null, null),
  ('R5', 'B3', 'Ρένα Ομορφιά', null, null, null, null, 'staff', null, null, null),
  ('XB', 'B2', 'Ξένος Βήτα', '+306941000091', null, null, null, 'staff', null, null, null),
  ('MC1', 'B1', 'Μάριος Εισαγωγή', null, null, null, null, 'import', null, null, null),
  ('MC2', 'B1', 'Μάριος Στόχος', null, null, null, null, 'staff', null, null, null)
) as c (label, shop, full_name, phone, verified, email, birthday, source, external_ref, erased, created);

insert into public.appointments (id, business_id, client_id, staff_id, starts_at, ends_at, status, source, verified_via,
                                 total_cents, charged_cents, cancelled_by, cancel_reason, idempotency_key, request_hash,
                                 external_ref, referrer)
select pg_temp.id(a.label), pg_temp.id(a.shop), pg_temp.id(a.client), pg_temp.id(a.staff), a.starts_at,
       a.starts_at + interval '30 minutes', a.status, a.source, a.via, a.total, a.charged, a.cancelled_by,
       a.cancel_reason, a.idem::uuid, a.request_hash, a.external_ref, a.referrer
from (values
  ('CA1', 'B1', 'C', 'St', timestamptz '2026-05-20 07:00Z', 'completed', 'phone', null, 1500, 1800, null, null, null, null, null, null),
  ('CA2', 'B1', 'C', 'St2', timestamptz '2026-04-15 07:00Z', 'completed', 'phone', null, 1300, null, null, null, null, null, null, null),
  ('CA3', 'B1', 'C', 'St', timestamptz '2026-05-27 07:00Z', 'no_show', 'phone', null, 1500, null, null, null, null, null, null, null),
  ('CA4', 'B1', 'C', 'St2', timestamptz '2026-05-28 07:00Z', 'cancelled', 'phone', null, 1300, null, 'client', 'client_request',
   null, null, null, null),
  ('CA5', 'B1', 'C', 'St', timestamptz '2026-06-01 07:00Z', 'booked', 'online', 'otp', 1500, null, null, null,
   'e15e0000-0000-4000-8000-000000000001', encode(sha256(convert_to('pgtap15 request of CA5', 'UTF8')), 'hex'),
   'pos-xenofon-5', 'instagram'),
  ('CA6', 'B1', 'C', 'St2', now() + interval '3 days', 'booked', 'phone', null, 1300, null, null, null, null, null, null, null),
  ('SA1', 'B1', 'S1a', 'St', timestamptz '2026-05-05 07:00Z', 'completed', 'phone', null, 1400, null, null, null, null, null, null, null),
  ('SA2', 'B1', 'S1a', 'St2', timestamptz '2026-05-06 07:00Z', 'cancelled', 'phone', null, 1400, null, 'business', 'other',
   null, null, null, null),
  ('TA1', 'B1', 'T1a', 'St', timestamptz '2026-04-01 07:00Z', 'completed', 'phone', null, 1400, null, null, null, null, null, null, null),
  ('SB1', 'B1', 'S2b', 'St', timestamptz '2026-05-07 07:00Z', 'completed', 'phone', null, 1300, null, null, null, null, null, null, null),
  ('H1A', 'B1', 'H1', 'St', timestamptz '2026-05-08 07:00Z', 'completed', 'phone', null, 1300, null, null, null, null, null, null, null),
  ('RA0', 'B1', 'R0', 'St', timestamptz '2026-05-09 07:00Z', 'cancelled', 'phone', null, 1300, null, 'client', 'client_request',
   null, null, null, null),
  -- 00:30 on 31 May in Athens (EEST), still 30 May in UTC: the ring counts local dates
  ('RA1', 'B1', 'R1', 'St', timestamptz '2026-05-30 21:30Z', 'completed', 'phone', null, 1300, null, null, null, null, null, null, null),
  ('RA2', 'B1', 'R2', 'St', timestamptz '2026-05-01 15:00Z', 'completed', 'phone', null, 1300, null, null, null, null, null, null, null),
  ('RA3', 'B1', 'R3', 'St', timestamptz '2026-05-13 07:00Z', 'completed', 'phone', null, 1300, null, null, null, null, null, null, null),
  ('RA5', 'B3', 'R5', 'St3', timestamptz '2026-06-03 07:00Z', 'completed', 'phone', null, 2000, null, null, null, null, null, null, null),
  ('EA0', 'B1', 'E', 'St', timestamptz '2026-05-10 07:00Z', 'completed', 'phone', null, 1300, null, null, null, null, null, null, null),
  -- in progress right now, on the merged source E2
  ('EA1', 'B1', 'E2', 'St2', now() - interval '10 minutes', 'booked', 'phone', null, 1300, null, null, null, null, null, null, null),
  ('DA1', 'B1', 'D', 'St', now() + interval '2 days', 'booked', 'import', null, 1300, null, null, null, null, null, null, null),
  ('DA2', 'B1', 'D', 'St', now() + interval '2 days 2 hours', 'booked', 'online', 'trusted_device', 1300, null, null, null,
   null, null, null, null),
  ('XA1', 'B2', 'XB', 'StX', timestamptz '2026-05-15 07:00Z', 'completed', 'phone', null, 1500, null, null, null, null, null, null, null),
  ('MCA', 'B1', 'MC1', 'St', timestamptz '2026-05-12 07:00Z', 'completed', 'import', null, 1300, null, null, null, null, null, null, null)
) as a (label, shop, client, staff, starts_at, status, source, via, total, charged, cancelled_by, cancel_reason, idem,
        request_hash, external_ref, referrer);

insert into public.appointment_services (business_id, appointment_id, position, service_id, price_cents, duration_min) values
  (pg_temp.id('B1'), pg_temp.id('CA1'), 0, pg_temp.id('SV1'), 1500, 30);

insert into public.client_notes (id, business_id, client_id, author_id, body, created_at) values
  (pg_temp.id('N1'), pg_temp.id('B1'), pg_temp.id('C'), pg_temp.id('S'), 'Ο Ξενοφών θέλει κοντά στο πλάι', now() - interval '3 days'),
  (pg_temp.id('N2'), pg_temp.id('B1'), pg_temp.id('C'), pg_temp.id('O'), 'Προτιμά ραντεβού το πρωί', now() - interval '1 day'),
  (pg_temp.id('SN1'), pg_temp.id('B1'), pg_temp.id('S1a'), pg_temp.id('S'), 'Σημείωση πηγής ένα', now() - interval '10 days'),
  (pg_temp.id('SN2'), pg_temp.id('B1'), pg_temp.id('S1a'), pg_temp.id('O'), 'Σημείωση πηγής δύο', now() - interval '9 days'),
  (pg_temp.id('TN1'), pg_temp.id('B1'), pg_temp.id('T1a'), pg_temp.id('M'), 'Σημείωση στόχου', now() - interval '8 days');

insert into public.client_consents (id, business_id, client_id, purpose, legal_basis, granted, source, policy_version,
                                    given_by, created_by, created_at)
select pg_temp.id(k.label), pg_temp.id('B1'), pg_temp.id(k.client), k.purpose, k.basis, k.granted, k.source, k.policy,
       'client', pg_temp.id(k.author), k.stamp
from (values
  ('CC1', 'C', 'marketing_sms', 'soft_opt_in', true, 'booking_form', 'booking-2026-05', null, timestamptz '2026-06-01 06:55Z'),
  ('CC2', 'C', 'photos_record', 'consent', true, 'staff_ui', 'staff-2026-05', 'O', timestamptz '2026-05-20 07:30Z'),
  ('SC1', 'S1a', 'marketing_sms', 'soft_opt_in', true, 'booking_form', 'booking-2026-05', null, now() - interval '5 days'),
  ('SC2', 'S1a', 'photos_record', 'consent', true, 'staff_ui', 'staff-2026-05', 'S', now() - interval '6 days'),
  ('TC1', 'T1a', 'marketing_sms', 'soft_opt_in', false, 'booking_form', 'booking-2026-04', null, now() - interval '50 days'),
  ('FRC1', 'FR', 'marketing_sms', 'consent', true, 'staff_ui', 'staff-2026-05', 'O', now() - interval '30 days'),
  ('FRC2', 'FR', 'marketing_sms', 'soft_opt_in', false, 'booking_form', 'booking-2026-05', null, now() - interval '20 days'),
  ('FRC3', 'FR', 'photos_record', 'consent', true, 'staff_ui', 'staff-2026-05', 'O', now() - interval '25 days'),
  ('FSC1', 'FS', 'marketing_sms', 'soft_opt_in', true, 'booking_form', 'booking-2026-05', null, now() - interval '10 days'),
  ('EC1', 'E', 'marketing_sms', 'soft_opt_in', true, 'booking_form', 'booking-2026-05', null, now() - interval '40 days')
) as k (label, client, purpose, basis, granted, source, policy, author, stamp);

-- Families written as postgres after their children (the guard refuses children of a merged client).
update public.clients set merged_into_id = pg_temp.id('FR') where id = pg_temp.id('FS');
update public.clients set merged_into_id = pg_temp.id('E') where id = pg_temp.id('E2');
update public.clients set merged_into_id = pg_temp.id('H1') where id = pg_temp.id('H0');
update public.clients set merged_into_id = pg_temp.id('Q2') where id = pg_temp.id('Q1');
update public.clients set merged_into_id = pg_temp.id('Q1') where id = pg_temp.id('Q0');

insert into public.otp_challenges (id, business_id, phone_hmac, code_hmac, expires_at, verified_at, grant_hash,
                                   grant_expires_at, created_at) values
  (pg_temp.id('CH1'), pg_temp.id('B1'), private.phone_hmac('+306970001234'),
   encode(sha256(convert_to('pgtap15-code-1', 'UTF8')), 'hex'), '2026-06-01 06:55Z', '2026-06-01 06:51Z',
   private.token_hash('pgtap15-grant-c-0001'), '2027-01-01 00:00Z', '2026-06-01 06:50Z'),
  (pg_temp.id('CH2'), pg_temp.id('B2'), private.phone_hmac('+306970001234'),
   encode(sha256(convert_to('pgtap15-code-2', 'UTF8')), 'hex'), '2026-06-01 06:55Z', null, null, null, '2026-06-01 06:50Z');

insert into public.trusted_devices (id, business_id, phone_hmac, token_hash, created_at, expires_at) values
  (pg_temp.id('TD1'), pg_temp.id('B1'), private.phone_hmac('+306970001234'), private.token_hash('pgtap15-device-c-b1'),
   '2026-06-01 06:52Z', '2026-11-28 06:52Z'),
  (pg_temp.id('TD2'), pg_temp.id('B2'), private.phone_hmac('+306970001234'), private.token_hash('pgtap15-device-c-b2'),
   '2026-06-01 06:52Z', '2026-11-28 06:52Z'),
  (pg_temp.id('TDE'), pg_temp.id('B1'), private.phone_hmac('+306942000001'), private.token_hash('pgtap15-device-shared'),
   '2026-05-01 08:00Z', '2026-10-28 08:00Z');

insert into public.booking_tokens (id, business_id, appointment_id, token_hash, issued_for, created_at, expires_at, revoked_at) values
  (pg_temp.id('BT1'), pg_temp.id('B1'), pg_temp.id('CA5'), private.token_hash('pgtap15-manage-ca5'), 'booking',
   '2026-06-01 06:55Z', '2027-07-06 06:55Z', null),
  (pg_temp.id('BT2'), pg_temp.id('B1'), pg_temp.id('CA1'), private.token_hash('pgtap15-manage-ca1'), 'message',
   '2026-05-19 10:00Z', '2027-06-23 10:00Z', null),
  (pg_temp.id('BT3'), pg_temp.id('B1'), pg_temp.id('CA5'), private.token_hash('pgtap15-manage-ca5-old'), 'booking',
   '2026-05-31 10:00Z', '2027-07-05 10:00Z', '2026-06-01 07:00Z');

insert into public.messages_log (id, business_id, client_id, appointment_id, otp_challenge_id, dedupe_key, channel, to_e164,
                                 locale, template, category, status, scheduled_for, sent_at, created_at)
select pg_temp.id(m.label), pg_temp.id('B1'), pg_temp.id(m.client), pg_temp.id(m.appt), pg_temp.id(m.challenge),
       'pgtap15:' || m.label, 'sms', m.to_e164, 'el', m.template, m.category, m.status, m.stamp,
       case when m.status = 'sent' then m.stamp end, m.stamp
from (values
  ('CM1', 'C', 'CA1', null, '+306970001234', 'booking_confirmed', 'transactional', 'sent', timestamptz '2026-05-19 10:00Z'),
  ('CM2', 'C', 'CA5', null, '+306970001234', 'booking_confirmed', 'transactional', 'queued', now() - interval '5 minutes'),
  ('CM3', null, null, 'CH1', '+306970001234', 'otp', 'otp', 'sent', timestamptz '2026-06-01 06:50Z'),
  ('SM1', 'S1a', 'SA1', null, '+306941000041', 'booking_confirmed', 'transactional', 'sent', timestamptz '2026-05-04 10:00Z'),
  ('DM1', 'D', 'DA2', null, '+306942000001', 'booking_confirmed', 'transactional', 'sent', now() - interval '1 day'),
  ('DM2', 'D', 'DA1', null, '+306942000001', 'reminder', 'reminder', 'queued', now() - interval '5 minutes'),
  ('DM3', 'D', 'DA2', null, '+306942000001', 'rescheduled_by_business', 'transactional', 'queued', now() - interval '5 minutes')
) as m (label, client, appt, challenge, to_e164, template, category, status, stamp);

-- =============================================================================================
-- 0. Domain errors
-- =============================================================================================
select is(
  concat_ws(' ', pg_temp.hint_of('AN032'), pg_temp.hint_of('AN033')),
  'P0001/AN032/client_has_upcoming P0001/AN033/client_unavailable',
  'raise_domain_error knows AN032 client_has_upcoming and AN033 client_unavailable (message = code, hint = name)'
);

-- =============================================================================================
-- A. merge_clients and merge_clients_core
-- =============================================================================================
do $do$
begin
  perform set_config('t.sc_before', (select jsonb_agg(to_jsonb(k) order by k.id)::text
                                     from public.client_consents k where k.client_id = pg_temp.id('S1a')), true);
  perform set_config('t.events0', (select count(*)::text from public.appointment_events e
                                   where e.business_id = pg_temp.id('B1')), true);
end
$do$;

select is(
  pg_temp.keep('m1', pg_temp.merge('S1a', 'T1a', pg_temp.aal1('O'))),
  'ok',
  'merge: the owner merges S1a into T1a through public.merge_clients as authenticated (aal1: merging is not a '
  || 'critical action, no fresh code)'
);

select is(
  concat_ws(' ',
    pg_temp.lt(pg_temp.r('m1') ->> 'source_id'), pg_temp.lt(pg_temp.r('m1') ->> 'target_id'),
    pg_temp.r('m1') ->> 'merged', pg_temp.r('m1') ->> 'appointments', pg_temp.r('m1') ->> 'notes',
    pg_temp.r('m1') ->> 'messages', pg_temp.r('m1') ->> 'repointed', pg_temp.r('m1') -> 'filled'),
  'S1a T1a true 2 2 1 0 ["phone", "email", "birthday"]',
  'merge answer: source, target, merged true, 2 appointments, 2 notes, 1 message moved, nothing re-pointed, the '
  || 'target''s empty phone, email and birthday filled (in this order)'
);

select is(
  concat_ws(' ',
    pg_temp.appts_of('S1a'), pg_temp.appts_of('T1a'), pg_temp.notes_of('S1a'), pg_temp.notes_of('T1a'),
    (select pg_temp.l(m.client_id) from public.messages_log m where m.id = pg_temp.id('SM1')),
    (select pg_temp.l(c.merged_into_id) from public.clients c where c.id = pg_temp.id('S1a')),
    (select concat_ws(' ', t.full_name, t.phone_e164, t.phone_verified_at = s.phone_verified_at, t.email, t.birthday,
                      t.source, t.merged_into_id is null)
     from public.clients t, public.clients s
     where t.id = pg_temp.id('T1a') and s.id = pg_temp.id('S1a'))),
  '0 3 0 3 T1a T1a Σπύρος Στόχος +306941000041 t spyros.pigi@example.test 1985-07-01 staff t',
  'merge effects: appointments and notes are on the target, the message row points to the target, the source is '
  || 'merged into the target; the target took the source''s phone WITH its verification, email and birthday, kept '
  || 'its own name and source, and stays a root'
);

select is(
  concat_ws(' | ',
    pg_temp.audit('clients_merged', 'T1a'),
    (select jsonb_agg(to_jsonb(k) order by k.id) from public.client_consents k where k.client_id = pg_temp.id('S1a'))
      = current_setting('t.sc_before')::jsonb,
    pg_temp.consents_of('S1a')),
  'B1:staff:O:client:T1a:source=' || pg_temp.id('S1a') || ' | t | 2',
  'merge: exactly one audit row clients_merged (staff, the owner, entity the target, reason source=<id>); the '
  || 'source''s consent records stay on the source, byte for byte'
);

select is(
  pg_temp.keep('cardT', pg_temp.q($$select private.client_card_impl(p_business_id => {B1}, p_client_id => {T1a},
                                                                     p_now => now())::text$$, pg_temp.aal1('O'))),
  'ok',
  'merge: the owner reads the card of the target'
);

select is(
  concat_ws(' ',
    pg_temp.current(pg_temp.r('cardT')),
    (select string_agg(pg_temp.lt(e ->> 'id'), ',' order by pg_temp.lt(e ->> 'id'))
     from jsonb_array_elements(pg_temp.r('cardT') -> 'consents' -> 'records') e),
    (select string_agg(concat_ws(':', pg_temp.lt(e ->> 'client_id'), e ->> 'full_name', coalesce(e ->> 'phone_e164', '-')), ',')
     from jsonb_array_elements(pg_temp.r('cardT') -> 'details' -> 'aliases') e)),
  'marketing_email:none:<null> marketing_sms:granted:SC1 photos_publish:none:<null> photos_record:granted:SC2 '
  || 'SC1,SC2,TC1 S1a:Σπύρος Πηγή:+306941000041',
  'merge: the consents of the source are seen through the target (records of the whole family; marketing_sms '
  || 'follows the family rule: the source''s newer grant wins over the target''s older refusal); the source is '
  || 'an alias of the target'
);

select is(
  pg_temp.keep('m2', pg_temp.merge('S2b', 'T2b', pg_temp.aal1('M'))),
  'ok',
  'merge: the manager merges S2b into T2b through the wrapper'
);

select is(
  concat_ws(' ',
    pg_temp.lt(pg_temp.r('m2') ->> 'source_id'), pg_temp.lt(pg_temp.r('m2') ->> 'target_id'),
    pg_temp.r('m2') ->> 'merged', pg_temp.r('m2') ->> 'appointments', pg_temp.r('m2') ->> 'notes',
    pg_temp.r('m2') ->> 'messages', pg_temp.r('m2') ->> 'repointed', pg_temp.r('m2') -> 'filled',
    (select concat_ws(' ', c.phone_e164, c.phone_verified_at = timestamptz '2026-05-03 10:00Z', c.email, c.birthday)
     from public.clients c where c.id = pg_temp.id('T2b')),
    pg_temp.appts_of('T2b'), pg_temp.audit('clients_merged', 'T2b')),
  'S2b T2b true 1 0 0 0 ["email"] +306941000052 t pantelis@example.test 1979-01-02 1 '
  || 'B1:staff:M:client:T2b:source=' || pg_temp.id('S2b'),
  'merge by the manager: a target with a phone keeps it and its verification, only the missing email is filled; '
  || 'one audit row with the manager as actor'
);

select is(
  pg_temp.keep('m1b', pg_temp.merge('S1a', 'T1a', pg_temp.aal1('O'))),
  'ok',
  'merge: the same merge again answers'
);

select is(
  concat_ws(' ',
    pg_temp.lt(pg_temp.r('m1b') ->> 'source_id'), pg_temp.lt(pg_temp.r('m1b') ->> 'target_id'),
    pg_temp.r('m1b') ->> 'merged', pg_temp.r('m1b') ->> 'appointments', pg_temp.r('m1b') ->> 'notes',
    pg_temp.r('m1b') ->> 'messages', pg_temp.r('m1b') ->> 'repointed', pg_temp.r('m1b') -> 'filled',
    pg_temp.audit_count('clients_merged', 'T1a')),
  'S1a T1a false 0 0 0 0 [] 1',
  'merge is idempotent: merged false, nothing moved, no second audit row'
);

select is(
  pg_temp.keep('m3', pg_temp.merge('H1', 'HT', pg_temp.aal1('O'))),
  'ok',
  'merge: H1 (into which H0 was merged already) is merged into HT'
);

select is(
  concat_ws(' ',
    pg_temp.r('m3') ->> 'merged', pg_temp.r('m3') ->> 'appointments', pg_temp.r('m3') ->> 'notes',
    pg_temp.r('m3') ->> 'messages', pg_temp.r('m3') ->> 'repointed', pg_temp.r('m3') -> 'filled',
    (select pg_temp.l(c.merged_into_id) from public.clients c where c.id = pg_temp.id('H0')),
    (select pg_temp.l(c.merged_into_id) from public.clients c where c.id = pg_temp.id('H1')),
    pg_temp.appts_of('HT')),
  'true 1 0 0 1 [] HT HT 1',
  'merge flattens: the source''s own source H0 now points to the target (repointed 1), families stay one level deep'
);

select is(
  (select count(*) from public.appointment_events e where e.business_id = pg_temp.id('B1')),
  current_setting('t.events0')::bigint,
  'merge fires no appointment event (only client_id changes)'
);

do $do$ begin perform set_config('t.fpA', pg_temp.fp(), true); end $do$;

select is(
  concat_ws(' ',
    pg_temp.merge('L1', 'ER', pg_temp.aal1('O')),
    pg_temp.merge('L1', 'S1a', pg_temp.aal1('O')),
    pg_temp.merge('S1a', 'L2', pg_temp.aal1('O')),
    pg_temp.merge('ER', 'L1', pg_temp.aal1('O')),
    pg_temp.merge('L1', 'L1', pg_temp.aal1('O')),
    pg_temp.merge(null, 'L1', pg_temp.aal1('O')),
    pg_temp.merge('L1', null, pg_temp.aal1('O')),
    pg_temp.merge('L1', 'NOBODY', pg_temp.aal1('O'))),
  'P0001/AN033 P0001/AN033 P0001/AN033 P0001/AN033 22023 42501 42501 42501',
  'merge refusals: into an erased client, into a merged client, a source merged elsewhere, an erased source → '
  || 'AN033; source = target → 22023; a null or unknown id → 42501'
);

select is(
  concat_ws(' ',
    pg_temp.merge('XB', 'L1', pg_temp.aal1('O')),
    pg_temp.merge('L1', 'XB', pg_temp.aal1('O')),
    pg_temp.merge('XB', 'L1', pg_temp.aal1('O'), 'B2'),
    pg_temp.merge('L1', 'L2', pg_temp.aal1('X')),
    pg_temp.fp() = current_setting('t.fpA')),
  '42501 42501 42501 42501 t',
  'merge across businesses is impossible: a client of B2 as source or target with B1''s id, the owner of B1 with '
  || 'B2''s id, the owner of B2 with B1''s id → 42501; no refusal of this section changed anything'
);

select is(
  pg_temp.keep('core', pg_temp.q($$select private.merge_clients_core(p_business_id => {B1}, p_source => {MC1},
                                                                       p_target => {MC2}, p_actor => 'import')::text$$,
                                 '', 'postgres')),
  'ok',
  'merge_clients_core with actor import runs as postgres without any JWT (the Phase 3 importer)'
);

select is(
  concat_ws(' ',
    pg_temp.r('core') ->> 'merged', pg_temp.r('core') ->> 'appointments', pg_temp.appts_of('MC1'), pg_temp.appts_of('MC2'),
    (select pg_temp.l(c.merged_into_id) from public.clients c where c.id = pg_temp.id('MC1')),
    pg_temp.audit('clients_merged', 'MC2')),
  'true 1 0 1 MC2 B1:import:-:client:MC2:source=' || pg_temp.id('MC1'),
  'merge_clients_core (import): the appointment moved, the source is merged, the audit row says actor import '
  || 'without actor id (audit_log accepts import)'
);

do $do$ begin perform set_config('t.fpCore', pg_temp.fp(), true); end $do$;

select is(
  concat_ws(' ',
    pg_temp.q($$select private.merge_clients_core(p_business_id => {B1}, p_source => {L1}, p_target => {L2},
                                                  p_actor => 'staff')::text$$, '', 'postgres'),
    pg_temp.q($$select private.merge_clients_core(p_business_id => {B1}, p_source => {L1}, p_target => {L2},
                                                  p_actor => 'system')::text$$, '', 'postgres'),
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private' and p.proname = 'merge_clients_core'),
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     cross join unnest(array['anon', 'authenticated', 'service_role']) as r (role_name)
     where n.nspname = 'private' and p.proname = 'merge_clients_core'
       and has_function_privilege(r.role_name, p.oid, 'execute')),
    pg_temp.fp() = current_setting('t.fpCore')),
  '42501 22023 1 0 t',
  'merge_clients_core: actor staff without a JWT → 42501, actor system → 22023 (nothing written); it exists and '
  || 'no API role may execute it'
);

-- =============================================================================================
-- B. Staff neither merge nor erase; a manager never erases
-- =============================================================================================
do $do$ begin perform set_config('t.fpB', pg_temp.fp(), true); end $do$;

select is(
  concat_ws(' ',
    pg_temp.merge('L1', 'L2', pg_temp.aal1('S')),
    pg_temp.merge('L1', 'L2', pg_temp.fresh('S2')),
    pg_temp.erase('L1', pg_temp.aal1('S')),
    pg_temp.erase('L1', pg_temp.fresh('S')),
    pg_temp.erase_impl('L1', pg_temp.stale('M')),
    pg_temp.erase_impl('L1', pg_temp.otp2('M')),
    pg_temp.erase_impl('L1', pg_temp.aal1('M')),
    pg_temp.erase_impl('L1', pg_temp.fresh('M')),
    pg_temp.fp() = current_setting('t.fpB')),
  '42501 42501 42501 42501 42501 42501 42501 42501 t',
  'staff cannot merge or erase, a manager cannot erase: 42501 WITHOUT hint whatever the state of the code (role '
  || 'before freshness: no code sheet for an action the caller may not do); nothing changed'
);

-- =============================================================================================
-- C. client_card_impl (fixed clock {T0} = 2026-06-10 12:00 in Athens)
-- =============================================================================================
select is(
  concat_ws(' ',
    pg_temp.keep('cS', pg_temp.card('C', pg_temp.aal1('S'))),
    pg_temp.keep('cSw', pg_temp.q($$select public.client_card(p_business_id => {B1}, p_client_id => {C})::text$$,
                                  pg_temp.aal1('S'))),
    pg_temp.keep('cO', pg_temp.card('C', pg_temp.aal1('O'))),
    pg_temp.keep('cM', pg_temp.card('C', pg_temp.aal1('M'))),
    pg_temp.keep('cS2', pg_temp.card('C', pg_temp.aal1('S2')))),
  'ok ok ok ok ok',
  'card: every member reads the card of C (staff through the _impl and through the wrapper, owner, manager)'
);

select is(
  concat_ws(' | ', pg_temp.amounts(pg_temp.r('cS')), pg_temp.amounts(pg_temp.r('cSw')), pg_temp.amounts(pg_temp.r('cS2'))),
  'CA1:1800:true CA2:-:false CA3:-:true CA4:-:false CA5:1500:true CA6:-:false | '
  || 'CA1:1800:true CA2:-:false CA3:-:true CA4:-:false CA5:1500:true CA6:-:false | '
  || 'CA1:-:false CA2:1300:true CA3:-:false CA4:-:true CA5:-:false CA6:1300:true',
  'card as staff (the _impl and the wrapper alike): every history row is listed, amounts only on the caller''s own '
  || 'appointments (completed: charged else total; booked: total; no_show/cancelled: none), own marks them'
);

select is(
  concat_ws(' | ', pg_temp.amounts(pg_temp.r('cO')), pg_temp.amounts(pg_temp.r('cM'))),
  'CA1:1800:false CA2:1300:false CA3:-:false CA4:-:false CA5:1500:false CA6:1300:false | '
  || 'CA1:1800:false CA2:1300:false CA3:-:false CA4:-:false CA5:1500:false CA6:1300:false',
  'card as owner and manager: every amount; own false (no staff row)'
);

select is(
  concat_ws(' ',
    pg_temp.r('cO') -> 'can' ->> 'erase', pg_temp.r('cO') -> 'can' ->> 'merge',
    pg_temp.r('cM') -> 'can' ->> 'erase', pg_temp.r('cM') -> 'can' ->> 'merge',
    pg_temp.r('cS') -> 'can' ->> 'erase', pg_temp.r('cS') -> 'can' ->> 'merge',
    pg_temp.r('cS2') -> 'can' ->> 'erase', pg_temp.r('cS2') -> 'can' ->> 'merge'),
  'true true false true false false false false',
  'card: can.erase only for the owner, can.merge for owner and manager'
);

select is(
  pg_temp.keys(pg_temp.r('cO')),
  'as_of,can,client_id,consents,counters,currency,details,history,history_total,notes,notes_total,ring,state,timezone,upcoming',
  'card (live): exactly the top-level keys of contract §2.6'
);

select is(
  concat_ws(' | ',
    pg_temp.keys(pg_temp.r('cO') -> 'details'), pg_temp.keys(pg_temp.r('cO') -> 'counters'),
    pg_temp.keys(pg_temp.r('cO') -> 'ring'), pg_temp.keys(pg_temp.r('cO') -> 'history' -> 0),
    pg_temp.keys(pg_temp.r('cO') -> 'notes' -> 0), pg_temp.keys(pg_temp.r('cO') -> 'consents'),
    pg_temp.keys(pg_temp.r('cO') -> 'consents' -> 'current'),
    pg_temp.keys(pg_temp.r('cO') -> 'consents' -> 'current' -> 'marketing_sms'),
    pg_temp.keys(pg_temp.r('cO') -> 'consents' -> 'records' -> 0), pg_temp.keys(pg_temp.r('cO') -> 'can'),
    pg_temp.keys(pg_temp.r('cardT') -> 'details' -> 'aliases' -> 0)),
  'aliases,birthday,created_at,email,full_name,locale,phone_e164,phone_verified_at,source | '
  || 'last_visit_at,last_visit_date,no_shows,visits | '
  || 'days_since_last,fraction,hint_key,interval_days,interval_weeks,overdue_days,state | '
  || 'amount_cents,appointment_id,ends_at,own,service_names,source,staff_id,staff_name,starts_at,status | '
  || 'author_name,author_role,body,by_me,can_delete,created_at,id | current,records | '
  || 'marketing_email,marketing_sms,photos_publish,photos_record | record_id,state | '
  || 'client_id,created_at,given_by,granted,id,legal_basis,policy_version,purpose,source,withdrawn_at | erase,merge | '
  || 'client_id,full_name,phone_e164',
  'card (live): exactly the nested keys of §2.6 (details, counters, ring, item, note, consents, current and its '
  || 'state, record, can, alias)'
);

select is(
  concat_ws(' ',
    pg_temp.r('cO') ->> 'state', pg_temp.lt(pg_temp.r('cO') ->> 'client_id'),
    (pg_temp.r('cO') ->> 'as_of')::timestamptz = timestamptz '2026-06-10 09:00Z',
    pg_temp.r('cO') ->> 'timezone', pg_temp.r('cO') ->> 'currency',
    pg_temp.r('cO') -> 'details' ->> 'full_name', pg_temp.r('cO') -> 'details' ->> 'phone_e164',
    (pg_temp.r('cO') -> 'details' ->> 'phone_verified_at')::timestamptz = timestamptz '2026-06-01 06:51Z',
    pg_temp.r('cO') -> 'details' ->> 'email', pg_temp.r('cO') -> 'details' ->> 'birthday',
    pg_temp.r('cO') -> 'details' ->> 'locale', pg_temp.r('cO') -> 'details' ->> 'source',
    (pg_temp.r('cO') -> 'details' ->> 'created_at')::timestamptz = timestamptz '2026-04-01 08:00Z',
    pg_temp.r('cO') -> 'details' -> 'aliases',
    pg_temp.r('cO') -> 'counters' ->> 'visits',
    (pg_temp.r('cO') -> 'counters' ->> 'last_visit_at')::timestamptz = timestamptz '2026-05-20 07:00Z',
    pg_temp.r('cO') -> 'counters' ->> 'last_visit_date', pg_temp.r('cO') -> 'counters' ->> 'no_shows'),
  'live C t Europe/Athens EUR Ξενοφών Ζαχαρίας +306970001234 t xenofon.zacharias@example.test 1990-03-14 el online t '
  || '[] 2 t 2026-05-20 1',
  'card (live) of C: as_of = p_now, zone and currency of the business, the details, no alias; counters: 2 visits, '
  || 'the last one and its local date, 1 no-show'
);

select is(
  concat_ws(' ',
    pg_temp.col(pg_temp.r('cO') -> 'upcoming', 'appointment_id'), pg_temp.col(pg_temp.r('cO') -> 'history', 'appointment_id'),
    pg_temp.r('cO') ->> 'history_total', pg_temp.col(pg_temp.r('cO') -> 'notes', 'id'), pg_temp.r('cO') ->> 'notes_total',
    pg_temp.item(pg_temp.r('cO'), 'CA1') -> 'service_names', pg_temp.item(pg_temp.r('cO'), 'CA1') ->> 'staff_name',
    pg_temp.item(pg_temp.r('cO'), 'CA1') ->> 'status', pg_temp.item(pg_temp.r('cO'), 'CA1') ->> 'source',
    pg_temp.lt(pg_temp.item(pg_temp.r('cO'), 'CA1') ->> 'staff_id'),
    pg_temp.item(pg_temp.r('cO'), 'CA6') ->> 'staff_name',
    pg_temp.r('cO') -> 'notes' -> 1 ->> 'body',
    pg_temp.ring(pg_temp.r('cO'))),
  'CA6 CA5,CA4,CA3,CA1,CA2 5 N2,N1 2 ["Κούρεμα"] Σταύρος completed phone St Στέλιος Ο Ξενοφών θέλει κοντά στο πλάι '
  || 'within 21 28 4 0.75 - nextVisit.vertical',
  'card lists: upcoming = the booked appointment ahead, history = every other one newest first with its total, '
  || 'notes newest first with their total; items carry services, staff, status and source; the ring of C'
);

select is(
  concat_ws(' | ', pg_temp.notes(pg_temp.r('cS')), pg_temp.notes(pg_temp.r('cO')), pg_temp.notes(pg_temp.r('cM'))),
  'N2:false:false:owner:- N1:true:true:staff:Σταύρος | N2:true:true:owner:- N1:false:true:staff:Σταύρος | '
  || 'N2:false:false:owner:- N1:false:false:staff:Σταύρος',
  'card notes: by_me for the author, can_delete for the author or the owner (never a manager who is not the '
  || 'author); author_role from the membership, author_name from its staff row (none for the owner)'
);

select is(
  concat_ws(' ', pg_temp.current(pg_temp.r('cO')), pg_temp.col(pg_temp.r('cO') -> 'consents' -> 'records', 'id')),
  'marketing_email:none:<null> marketing_sms:granted:CC1 photos_publish:none:<null> photos_record:granted:CC2 CC1,CC2',
  'card consents: the four purposes with state and record, every record newest first'
);

select is(
  concat_ws(' ',
    pg_temp.keep('r0', pg_temp.card('R0', pg_temp.aal1('O'))),
    pg_temp.keep('r1', pg_temp.card('R1', pg_temp.aal1('O'))),
    pg_temp.keep('r2', pg_temp.card('R2', pg_temp.aal1('O'))),
    pg_temp.keep('r3', pg_temp.card('R3', pg_temp.aal1('O'))),
    pg_temp.keep('r5', pg_temp.card('R5', pg_temp.aal1('O'), 'B3'))),
  'ok ok ok ok ok',
  'ring: the owner reads the cards of R0..R3 (B1) and R5 (B3)'
);

select is(
  concat_ws(' | ', pg_temp.ring(pg_temp.r('r0')), pg_temp.ring(pg_temp.r('r1')), pg_temp.ring(pg_temp.r('r2')),
            pg_temp.ring(pg_temp.r('r3'))),
  'no_visits - 28 4 0.00 - nextVisit.vertical | within 10 28 4 0.36 - nextVisit.vertical | '
  || 'beyond 40 28 4 1.00 12 nextVisit.vertical | within 28 28 4 1.00 - nextVisit.vertical',
  'ring (barber, 4 weeks = 28 days): no completed visit → no_visits, fraction 0; 10 local days → within 0.36; '
  || '40 days → beyond, fraction 1, 12 days overdue; exactly 28 → within 1.00'
);

select is(
  concat_ws(' ',
    pg_temp.r('r5') -> 'ring' ->> 'state', coalesce(pg_temp.r('r5') -> 'ring' ->> 'days_since_last', '-'),
    coalesce(pg_temp.r('r5') -> 'ring' ->> 'interval_days', '-'), coalesce(pg_temp.r('r5') -> 'ring' ->> 'interval_weeks', '-'),
    coalesce(pg_temp.r('r5') -> 'ring' ->> 'fraction', '-'), coalesce(pg_temp.r('r5') -> 'ring' ->> 'hint_key', '-'),
    pg_temp.r('r1') -> 'counters' ->> 'last_visit_date', pg_temp.r('r1') -> 'counters' ->> 'visits',
    pg_temp.r('r0') -> 'counters' ->> 'visits', coalesce(pg_temp.r('r0') -> 'counters' ->> 'last_visit_date', '-')),
  'no_interval 7 - - - - 2026-05-31 1 0 -',
  'ring: no next-visit interval (beauty) → no_interval, fraction null; R1''s visit at 00:30 local counts on its '
  || 'local date (31 May, 10 days; in UTC it would be 30 May); a client without visits has 0 and no date'
);

select is(
  concat_ws(' ',
    pg_temp.keep('mS1a', pg_temp.card('S1a', pg_temp.aal1('O'))),
    pg_temp.keep('mQ0', pg_temp.card('Q0', pg_temp.aal1('O'))),
    pg_temp.keep('mH0', pg_temp.card('H0', pg_temp.aal1('S'))),
    pg_temp.keep('eER', pg_temp.card('ER', pg_temp.aal1('O')))),
  'ok ok ok ok',
  'card: the cards of merged sources and of an erased client answer'
);

select is(
  concat_ws(' | ',
    concat_ws(' ', pg_temp.r('mS1a') ->> 'state', pg_temp.lt(pg_temp.r('mS1a') ->> 'client_id'),
              pg_temp.lt(pg_temp.r('mS1a') ->> 'merged_into_id'), pg_temp.keys(pg_temp.r('mS1a'))),
    concat_ws(' ', pg_temp.r('mQ0') ->> 'state', pg_temp.lt(pg_temp.r('mQ0') ->> 'merged_into_id')),
    concat_ws(' ', pg_temp.r('mH0') ->> 'state', pg_temp.lt(pg_temp.r('mH0') ->> 'merged_into_id')),
    concat_ws(' ', pg_temp.r('eER') ->> 'state', pg_temp.lt(pg_temp.r('eER') ->> 'client_id'), pg_temp.keys(pg_temp.r('eER')))),
  'merged S1a T1a client_id,merged_into_id,state | merged Q2 | merged HT | erased ER client_id,erased_at,state',
  'card states: a merged source answers only its root (also at the end of a two-step chain written as postgres, '
  || 'and after a flatten); an erased client answers only the state'
);

select is(
  concat_ws(' ',
    pg_temp.card('XB', pg_temp.aal1('O')),
    pg_temp.card('XB', pg_temp.aal1('O'), 'B2'),
    pg_temp.card('NOBODY', pg_temp.aal1('O')),
    pg_temp.card(null, pg_temp.aal1('O')),
    pg_temp.q($$select private.client_card_impl(p_business_id => {B1}, p_client_id => {C}, p_now => null)::text$$,
              pg_temp.aal1('O')),
    pg_temp.card('C', pg_temp.aal1('OE')),
    pg_temp.q($$select private.client_card_impl(p_business_id => {B1}, p_client_id => {C}, p_now => {T0}) ->> 'state'$$,
              pg_temp.otp2('OE'))),
  '42501 42501 42501 42501 22023 42501 live',
  'card refusals: a client of another business, another business''s id, an unknown or null client → 42501; p_now '
  || 'null → 22023; D2: an enrolled owner at aal1 → 42501 without hint, the same owner at aal2 reads the card'
);

-- =============================================================================================
-- D. Consents: set_client_consent, consent_state, the booking box
-- =============================================================================================
select is(
  pg_temp.keep('k1', pg_temp.consent('K', 'marketing_sms', true, 'client', 'staff-consent-2026-10-03', pg_temp.aal1('O'))),
  'ok',
  'consent on: the owner records K''s consent to marketing SMS'
);

select is(
  concat_ws(' ',
    pg_temp.lt(pg_temp.r('k1') ->> 'client_id'), pg_temp.r('k1') ->> 'purpose', pg_temp.r('k1') ->> 'state',
    pg_temp.r('k1') ->> 'changed', (pg_temp.r('k1') ->> 'consent_id') is not null, pg_temp.r('k1') ->> 'withdrawn',
    (select concat_ws(' ', k.purpose, k.legal_basis, k.granted, k.source, k.given_by, k.policy_version,
                      pg_temp.l(k.created_by), coalesce(k.withdrawn_at::text, '-'), k.created_at = now())
     from public.client_consents k where k.id = (pg_temp.r('k1') ->> 'consent_id')::uuid)),
  'K marketing_sms granted true t 0 marketing_sms consent t staff_ui client staff-consent-2026-10-03 O - t',
  'consent on = a NEW record: legal basis consent, source staff_ui, granted, the given_by and policy version '
  || 'passed, created_by the caller, created now, active'
);

select is(
  pg_temp.keep('k2', pg_temp.consent('K', 'marketing_sms', true, 'client', 'staff-consent-2026-10-03', pg_temp.aal1('O'))),
  'ok',
  'consent on again answers'
);

select is(
  concat_ws(' ', pg_temp.r('k2') ->> 'state', pg_temp.r('k2') ->> 'changed', coalesce(pg_temp.r('k2') ->> 'consent_id', '-'),
            pg_temp.r('k2') ->> 'withdrawn', pg_temp.consents_of('K')),
  'granted false - 0 1',
  'consent on when already granted: changed false, no new record'
);

select is(
  pg_temp.keep('k3', pg_temp.consent('K', 'marketing_sms', false, null, null, pg_temp.aal1('S'))),
  'ok',
  'consent off: a staff member may toggle (given_by and policy version are ignored when withdrawing)'
);

select is(
  concat_ws(' ', pg_temp.r('k3') ->> 'state', pg_temp.r('k3') ->> 'changed', coalesce(pg_temp.r('k3') ->> 'consent_id', '-'),
            pg_temp.r('k3') ->> 'withdrawn',
            (select string_agg((k.withdrawn_at = now())::text, ',') from public.client_consents k
             where k.client_id = pg_temp.id('K'))),
  'none true - 1 true',
  'consent off = withdrawn_at (now) on the active grant, never a rewrite; no older refusal → state none'
);

select is(
  concat_ws(' ',
    pg_temp.keep('k4', pg_temp.consent('K', 'marketing_sms', false, null, null, pg_temp.aal1('S'))),
    pg_temp.keep('k5', pg_temp.consent('K', 'marketing_sms', true, 'guardian', 'staff-consent-2026-10-03', pg_temp.aal1('S')))),
  'ok ok',
  'consent off again, then on with a guardian, as staff'
);

select is(
  concat_ws(' ',
    pg_temp.r('k4') ->> 'state', pg_temp.r('k4') ->> 'changed', pg_temp.r('k4') ->> 'withdrawn',
    pg_temp.r('k5') ->> 'state', pg_temp.r('k5') ->> 'changed',
    (select concat_ws(':', k.given_by, pg_temp.l(k.created_by), k.legal_basis, k.source, k.granted)
     from public.client_consents k where k.id = (pg_temp.r('k5') ->> 'consent_id')::uuid),
    pg_temp.consents_of('K')),
  'none false 0 granted true guardian:S:consent:staff_ui:t 2',
  'consent off when nothing is active: changed false, withdrawn 0; on again = a second new record (guardian, by S)'
);

select is(
  concat_ws(' ', pg_temp.cstate('FR'), pg_temp.cstate('FR', 'photos_record'), pg_temp.cstate('FR', 'marketing_email')),
  'granted:FSC1 granted:FRC3 none:<null>',
  'consent_state is family-wide: the latest active record of FR and its merged source FS wins (FS''s newer grant '
  || 'over FR''s refusal and older grant); none without records'
);

select is(
  pg_temp.keep('f1', pg_temp.consent('FR', 'marketing_sms', false, null, null, pg_temp.aal1('O'))),
  'ok',
  'consent off on the root of a family'
);

select is(
  concat_ws(' ',
    pg_temp.r('f1') ->> 'state', pg_temp.r('f1') ->> 'changed', pg_temp.r('f1') ->> 'withdrawn',
    (select string_agg(pg_temp.l(k.id) || ':' || coalesce((k.withdrawn_at = now())::text, 'active'), ','
                       order by pg_temp.l(k.id))
     from public.client_consents k where k.client_id in (pg_temp.id('FR'), pg_temp.id('FS')))),
  'refused true 2 FRC1:true,FRC2:active,FRC3:active,FSC1:true',
  'consent off withdraws EVERY active grant of the family for that purpose (the source''s included); the older '
  || 'active refusal then wins (refused); the refusal and the other purpose stay active'
);

select is(
  pg_temp.keep('f2', pg_temp.consent('FR', 'marketing_sms', false, null, null, pg_temp.aal1('O'))),
  'ok',
  'consent off on the family again answers'
);

select is(
  concat_ws(' ', pg_temp.r('f2') ->> 'state', pg_temp.r('f2') ->> 'changed', pg_temp.r('f2') ->> 'withdrawn',
            pg_temp.cstate('FR')),
  'refused false 0 refused:FRC2',
  'consent off when only a refusal is active: changed false; consent_state names the refusal'
);

select is(
  concat_ws(' ',
    (select count(*) from public.client_consents k
     where k.business_id = any (pg_temp.shops()) and k.source = 'staff_ui' and k.legal_basis <> 'consent'),
    (select count(*) from public.client_consents k
     where k.business_id = any (pg_temp.shops()) and k.source = 'staff_ui' and k.created_at = now())),
  '0 2',
  'the RPC never writes soft_opt_in (staff_ui is always consent); exactly two records were written by it'
);

do $do$ begin perform set_config('t.cons0', pg_temp.consents_total()::text, true); end $do$;

select is(
  concat_ws(' ',
    pg_temp.consent('K', 'marketing_fax', true, 'client', 'v1', pg_temp.aal1('O')),
    pg_temp.consent('K', 'marketing_sms', null, 'client', 'v1', pg_temp.aal1('O')),
    pg_temp.consent('K', 'photos_record', true, null, 'v1', pg_temp.aal1('O')),
    pg_temp.consent('K', 'photos_record', true, 'friend', 'v1', pg_temp.aal1('O')),
    pg_temp.consent('K', 'photos_record', true, 'client', null, pg_temp.aal1('O')),
    pg_temp.consent('K', 'photos_record', true, 'client', repeat('v', 41), pg_temp.aal1('O'))),
  '22023 22023 22023 22023 22023 22023',
  'consent shape errors → 22023: unknown purpose, null granted; when granting: no or unknown given_by, no policy '
  || 'version or one longer than 40 characters'
);

select is(
  concat_ws(' ',
    pg_temp.consent('FS', 'marketing_sms', true, 'client', 'v1', pg_temp.aal1('O')),
    pg_temp.consent('ER', 'marketing_sms', true, 'client', 'v1', pg_temp.aal1('O')),
    pg_temp.consent('NOBODY', 'marketing_sms', true, 'client', 'v1', pg_temp.aal1('O')),
    pg_temp.consent('XB', 'marketing_sms', true, 'client', 'v1', pg_temp.aal1('O')),
    pg_temp.consent(null, 'marketing_sms', true, 'client', 'v1', pg_temp.aal1('O')),
    pg_temp.consents_total() = current_setting('t.cons0')::bigint),
  'P0001/AN033 P0001/AN033 42501 42501 42501 t',
  'consent: a merged or an erased client → AN033; an unknown, foreign or null client → 42501; no refusal wrote a record'
);

select is(
  concat_ws(' ',
    pg_temp.q($$insert into public.client_consents (business_id, client_id, purpose, legal_basis, granted, source,
                                                    policy_version, given_by, created_by)
               values ({B1}, {K}, 'photos_publish', 'consent', true, 'staff_ui', 'v1', 'client', {O})
               returning 'inserted'::text$$, pg_temp.aal1('O')),
    pg_temp.q($$update public.client_consents set withdrawn_at = now() where id = {CC2} returning 'updated'::text$$,
              pg_temp.aal1('O')),
    pg_temp.q($$insert into public.client_consents (business_id, client_id, purpose, legal_basis, granted, source,
                                                    policy_version, given_by, created_by)
               values ({B1}, {K}, 'photos_publish', 'consent', true, 'staff_ui', 'v1', 'client', {S})
               returning 'inserted'::text$$, pg_temp.aal1('S')),
    pg_temp.q($$update public.client_consents set withdrawn_at = now() where id = {FRC3} returning 'updated'::text$$,
              pg_temp.aal1('S')),
    pg_temp.consents_total() = current_setting('t.cons0')::bigint,
    (select k.withdrawn_at is null from public.client_consents k where k.id = pg_temp.id('CC2'))),
  '42501 42501 42501 42501 t t',
  'authenticated cannot insert or update client_consents directly (owner or staff): only set_client_consent writes'
);

select is(
  concat_ws(' ',
    pg_temp.cstate('T1a'),
    pg_temp.q($$select 'done'::text from private.apply_marketing_box(p_business_id => {B1}, p_client_id => {T1a},
                                         p_box => 'unchecked', p_policy_version => 'booking-v9', p_now => now())$$,
              '', 'postgres'),
    pg_temp.q($$select 'done'::text from private.apply_marketing_box(p_business_id => {B1}, p_client_id => {T1a},
                                         p_box => 'not_shown', p_policy_version => 'booking-v9', p_now => now())$$,
              '', 'postgres'),
    pg_temp.consents_of('T1a') + pg_temp.consents_of('S1a')),
  'granted:SC1 done done 3',
  'booking box (family-aware): T1a has an older refusal, its merged source a newer grant (family granted); '
  || '"unchecked" writes nothing (1.3 alone would have written a grant), "not_shown" writes nothing'
);

select is(
  concat_ws(' ',
    pg_temp.q($$select 'done'::text from private.apply_marketing_box(p_business_id => {B1}, p_client_id => {T1a},
                                         p_box => 'checked', p_policy_version => 'booking-v9', p_now => now())$$,
              '', 'postgres'),
    pg_temp.consents_of('T1a') + pg_temp.consents_of('S1a')),
  'done 4',
  'booking box: "checked" against a family that is granted writes one record (1.3 alone would have written none: '
  || 'T1a''s own latest record is already a refusal)'
);

select is(
  (select concat_ws(' ', x.j ->> 'state', pg_temp.l(k.client_id), k.purpose, k.legal_basis, k.granted, k.source, k.given_by,
                    pg_temp.l(k.created_by), k.policy_version, k.created_at = now(), k.withdrawn_at is null)
   from (select private.consent_state(p_business_id => pg_temp.id('B1'), p_root => pg_temp.id('T1a'),
                                      p_purpose => 'marketing_sms') as j) x
   join public.client_consents k on k.id = (x.j ->> 'record_id')::uuid),
  'refused T1a marketing_sms soft_opt_in f booking_form client - booking-v9 t t',
  'booking box: the new record is a refusal on the booked client (soft_opt_in, booking_form, by the client, no '
  || 'staff author, at p_now) and the family state is refused'
);

-- =============================================================================================
-- E. The guard: no note or consent for an erased or merged client, for every role
-- =============================================================================================
select is(
  concat_ws(' ',
    pg_temp.q($$insert into public.client_notes (business_id, client_id, author_id, body)
               values ({B1}, {FS}, {O}, 'Σημείωση') returning 'inserted'::text$$, pg_temp.aal1('O')),
    pg_temp.q($$insert into public.client_notes (business_id, client_id, author_id, body)
               values ({B1}, {ER}, {O}, 'Σημείωση') returning 'inserted'::text$$, pg_temp.aal1('O')),
    pg_temp.q($$insert into public.client_notes (business_id, client_id, author_id, body)
               values ({B1}, {FS}, {S}, 'Σημείωση') returning 'inserted'::text$$, pg_temp.aal1('S')),
    pg_temp.lt(pg_temp.q($$insert into public.client_notes (id, business_id, client_id, author_id, body)
                          values ({NL1}, {B1}, {L1}, {O}, 'Σημείωση') returning id::text$$, pg_temp.aal1('O')))),
  'P0001/AN033 P0001/AN033 P0001/AN033 NL1',
  'guard (authenticated): a note for a merged or an erased client → AN033 (owner and staff); a note for a live '
  || 'client with a client-generated id is written (INSERT (id))'
);

select is(
  concat_ws(' ',
    pg_temp.q($$insert into public.client_notes (business_id, client_id, body)
               values ({B1}, {FS}, 'Σημείωση') returning 'inserted'::text$$, '', 'service_role'),
    pg_temp.q($$insert into public.client_notes (business_id, client_id, body)
               values ({B1}, {ER}, 'Σημείωση') returning 'inserted'::text$$, '', 'service_role'),
    pg_temp.q($$insert into public.client_consents (business_id, client_id, purpose, legal_basis, granted, source,
                                                    policy_version, given_by)
               values ({B1}, {FS}, 'photos_record', 'consent', true, 'staff_ui', 'v1', 'client')
               returning 'inserted'::text$$, '', 'service_role'),
    pg_temp.q($$insert into public.client_consents (business_id, client_id, purpose, legal_basis, granted, source,
                                                    policy_version, given_by)
               values ({B1}, {ER}, 'photos_record', 'consent', true, 'staff_ui', 'v1', 'client')
               returning 'inserted'::text$$, '', 'service_role'),
    pg_temp.q($$insert into public.client_consents (business_id, client_id, purpose, legal_basis, granted, source,
                                                    policy_version, given_by)
               values ({B1}, {L1}, 'photos_record', 'consent', true, 'staff_ui', 'v1', 'client')
               returning 'inserted'::text$$, '', 'service_role'),
    pg_temp.q($$insert into public.client_notes (business_id, client_id, body)
               values ({B1}, {L1}, 'Σημείωση') returning 'inserted'::text$$, '', 'service_role')),
  'P0001/AN033 P0001/AN033 P0001/AN033 P0001/AN033 inserted inserted',
  'guard (service_role, which bypasses RLS): a note or a consent for a merged or an erased client → AN033; for a '
  || 'live client both are written'
);

-- =============================================================================================
-- F/G. Erasure of C: AN032 first (only reachable with a fresh code), then the fresh-code matrix
-- =============================================================================================
do $do$ begin perform set_config('t.fpG', pg_temp.fp(), true); end $do$;

select is(
  concat_ws(' ',
    pg_temp.erase_impl('XB', pg_temp.fresh('O')),
    pg_temp.erase_impl('NOBODY', pg_temp.fresh('O')),
    pg_temp.erase_impl(null, pg_temp.fresh('O')),
    pg_temp.erase_impl('C', pg_temp.stale('O')),
    pg_temp.erase_impl('C', pg_temp.otp2('O')),
    pg_temp.erase_impl('C', pg_temp.aal1('O')),
    pg_temp.fp() = current_setting('t.fpG')),
  '42501 42501 42501 42501/fresh_totp_required 42501/fresh_totp_required 42501/aal2_required t',
  'erase_client_impl (F, §2.5 step 1): another shop''s client, an unknown id and a null id → 42501 without hint, '
  || 'even for the owner with a fresh code (never erased:true for nobody, no audit row); with C''s appointment '
  || 'still ahead, a code that is not fresh gets the code sheet first, never AN032; nothing changed'
);

select is(
  concat_ws(' ', pg_temp.erase_impl('C', pg_temp.fresh('O')), pg_temp.fp() = current_setting('t.fpG')),
  'P0001/AN032 t',
  'erase (G2): C has a booked appointment ahead → AN032 even with a fresh code; nothing changed'
);

-- The owner cancels it first (here as postgres, the system).
update public.appointments set status = 'cancelled', cancelled_by = 'business', cancel_reason = 'other'
where id = pg_temp.id('CA6');

do $do$ begin perform set_config('t.fpF', pg_temp.fp(), true); end $do$;

select is(
  pg_temp.refusals($$select private.erase_client_impl(p_business_id => {B1}, p_client_id => {C})::text$$, 'O', 'S'),
  '42501/aal2_required 42501/fresh_totp_required 42501/fresh_totp_required 42501/fresh_totp_required 42501',
  'erase_client_impl (F): aal1 → aal2_required; aal2 with a code 6 minutes old, aal2 with the email code only, and '
  || 'window 0 with a current code → fresh_totp_required; staff with a current code → 42501 without hint'
);

select is(
  concat_ws(' ',
    pg_temp.erase('C', pg_temp.aal1('O')),
    pg_temp.erase('C', pg_temp.stale('O')),
    pg_temp.erase('C', pg_temp.otp2('O'))),
  '42501/aal2_required 42501/fresh_totp_required 42501/fresh_totp_required',
  'public.erase_client as authenticated passes each refusal and its hint through unchanged (a direct PostgREST '
  || 'call gets the same answer)'
);

select is(
  concat_ws(' ', pg_temp.fp() = current_setting('t.fpF'),
            (select c.full_name from public.clients c where c.id = pg_temp.id('C')),
            pg_temp.notes_of('C'), pg_temp.consents_of('C')),
  't Ξενοφών Ζαχαρίας 2 2',
  'after every refusal C is untouched (row, notes, consents, outbox, tokens, devices, challenges, audit, suppression)'
);

do $do$
begin
  perform set_config('t.appts_c', pg_temp.appts_fp('C'), true);
  perform set_config('t.events_c', (select count(*)::text from public.appointment_events e
                                    where e.appointment_id in (select a.id from public.appointments a
                                                               where a.client_id = pg_temp.id('C'))), true);
  perform set_config('t.scan0', array_to_string(pg_temp.scan(), ','), true);
end
$do$;

select is(
  concat_ws(' ',
    pg_temp.q($$select count(*)::text from public.search_clients(p_business_id => {B1}, p_query => 'xenofon')$$, pg_temp.aal1('O')),
    pg_temp.q($$select count(*)::text from public.search_clients(p_business_id => {B1}, p_query => 'Ξενοφών')$$, pg_temp.aal1('O')),
    pg_temp.q($$select count(*)::text from public.search_clients(p_business_id => {B1}, p_query => '1234')$$, pg_temp.aal1('O')),
    pg_temp.q($$select coalesce(x ->> 'client_name', '<no name>')
               from jsonb_array_elements(private.today_summary_impl(p_business_id => {B1}, p_now => now()) -> 'to_mark') x
               where (x ->> 'appointment_id')::uuid = {CA5}$$, pg_temp.aal1('O')),
    pg_temp.q($$select string_agg(x ->> 'first_name', ',')
               from jsonb_array_elements(private.clients_for_phone_impl(p_business_id => {B1}, p_phone => '+306970001234',
                      p_grant => 'pgtap15-grant-c-0001', p_trusted_device_token => null, p_now => {T0}) -> 'clients') x$$,
              '', 'postgres'),
    pg_temp.q($$select private.verified_via(p_business_id => {B1}, p_phone => '+306970001234', p_grant => null,
                                            p_trusted_device_token => 'pgtap15-device-c-b1', p_now => {T0})$$, '', 'postgres'),
    pg_temp.lt(pg_temp.q($$select private.manage_view_impl(p_token => 'pgtap15-manage-ca5', p_now => {T0}) -> 'appointment' ->> 'id'$$,
                         '', 'postgres')),
    pg_temp.q($$select private.client_card_impl(p_business_id => {B1}, p_client_id => {C}, p_now => {T0}) ->> 'state'$$,
              pg_temp.aal1('O'))),
  '1 1 1 Ξενοφών Ζαχαρίας Ξενοφών trusted_device CA5 live',
  'before the erase every reader finds C: search (greeklish, Greek, last digits), today_summary''s to-mark name, '
  || 'clients_for_phone with the live grant, the trusted device, the manage link, the card'
);

select is(
  (select array_agg(x order by x) from unnest(array[
     'public.appointments.external_ref', 'public.client_notes.body', 'public.clients.email', 'public.clients.external_ref',
     'public.clients.full_name', 'public.clients.phone_e164', 'public.clients.search_text', 'public.messages_log.to_e164'
   ]) as x
   where not (x = any (string_to_array(current_setting('t.scan0'), ',')))),
  null::text[],
  'scan before the erase is not vacuous: the needles hit clients (name, search text, phone, email, external ref), '
  || 'the note, the outbox phone and the appointment''s external ref'
);

select is(
  (select array_agg(x order by x) from unnest(array[
     'private.move_requests.result', 'public.audit_log.reason', 'public.client_consents.policy_version',
     'public.messages_log.to_e164', 'public.otp_challenges.code_hmac', 'public.otp_challenges.grant_hash',
     'public.otp_challenges.phone_hmac', 'public.trusted_devices.phone_hmac', 'public.suppression_list.phone_hmac',
     'public.appointments.request_hash', 'public.clients.search_text'
   ]) as x
   where not exists (select 1 from pg_temp.scan_cols s where s.col = x)),
  null::text[],
  'the scan covers every text/json column of public and private, among them the outbox, the OTP challenges, the '
  || 'stored move answers, the audit reasons and the suppression list'
);

select is(
  pg_temp.keep('erase_c', pg_temp.erase_impl('C', pg_temp.fresh('O'))),
  'ok',
  'erase_client_impl: the owner with a code 1 minute old erases C'
);

select is(
  pg_temp.scan(),
  array[]::text[],
  'SPEC §13: after the erase no text/varchar/char/json/jsonb column of any table in public or private holds C''s '
  || 'name (as typed, without accents, in greeklish) or phone (E.164, digits, national)'
);

select is(
  concat_ws(' ',
    (select concat_ws(' ', c.full_name, c.phone_e164, c.erased_at is null, c.search_text <> '')
     from public.clients c where c.id = pg_temp.id('Y')),
    (select string_agg(b.col, ',' order by b.col) from pg_temp.scan_base b
     where b.needles = 'C' and b.col in ('public.clients.full_name', 'public.clients.phone_e164'))),
  'Ξενοφών Ζαχαρίας ψωμχ +306970001234 t t public.clients.full_name,public.clients.phone_e164',
  'the same name and number at another shop (B4, in the database before the fixture, as a leftover e2e client '
  || 'would be) stay untouched by the erase in B1, and the scan above did not count them: they are its baseline'
);

select is(
  (select concat_ws(' ', quote_literal(c.full_name), coalesce(c.phone_e164, '-'), coalesce(c.email, '-'),
                    coalesce(c.birthday::text, '-'), coalesce(c.external_ref, '-'), coalesce(c.phone_verified_at::text, '-'),
                    quote_literal(c.search_text), (c.erased_at is not null)::text, c.locale, c.source,
                    pg_temp.l(c.merged_into_id), c.created_at = timestamptz '2026-04-01 08:00Z')
   from public.clients c where c.id = pg_temp.id('C')),
  $$'' - - - - - '' true el online - t$$,
  'erased row: name empty, phone, email, birthday, external ref and phone_verified_at null, search_text '''', '
  || 'erased_at set; id, language, source and creation kept'
);

select is(
  concat_ws(' ',
    pg_temp.appts_fp('C') = current_setting('t.appts_c'),
    (select count(*) from public.appointment_events e
     where e.appointment_id in (select a.id from public.appointments a where a.client_id = pg_temp.id('C')))
      = current_setting('t.events_c')::bigint,
    pg_temp.appts_of('C'),
    (select count(*) from public.appointments a
     where a.client_id = pg_temp.id('C') and (a.request_hash is not null or a.external_ref is not null))),
  't t 6 0',
  'erase: the six appointments stay on C with status, times, staff, amounts and provenance unchanged, no event '
  || 'fired; request_hash and external_ref are null'
);

select is(
  concat_ws(' ',
    pg_temp.notes_of('C'), pg_temp.consents_of('C'),
    (select string_agg(pg_temp.l(t.id) || ':' || (t.revoked_at is not null)::text, ',' order by pg_temp.l(t.id))
     from public.booking_tokens t where t.business_id = pg_temp.id('B1')),
    (select t.revoked_at = timestamptz '2026-06-01 07:00Z' from public.booking_tokens t where t.id = pg_temp.id('BT3')),
    (select string_agg(pg_temp.l(d.id) || ':' || (d.revoked_at is not null)::text, ',' order by pg_temp.l(d.id))
     from public.trusted_devices d where d.id in (pg_temp.id('TD1'), pg_temp.id('TD2'))),
    (select string_agg(pg_temp.l(o.id) || ':' || coalesce((o.phone_hmac = private.phone_hmac('+306970001234'))::text, 'null'),
                       ',' order by pg_temp.l(o.id))
     from public.otp_challenges o where o.id in (pg_temp.id('CH1'), pg_temp.id('CH2'))),
    (select string_agg(pg_temp.l(m.id) || ':' || coalesce(m.to_e164, '-') || ':' || m.status, ',' order by pg_temp.l(m.id))
     from public.messages_log m where m.id in (pg_temp.id('CM1'), pg_temp.id('CM2'), pg_temp.id('CM3')))),
  '0 0 BT1:true,BT2:true,BT3:true t TD1:true,TD2:false CH1:null,CH2:true CM1:-:sent,CM2:-:queued,CM3:-:sent',
  'erase: notes and consents deleted; every manage token of its appointments revoked (an earlier revocation '
  || 'keeps its date); the device of B1 revoked, the device of B2 for the same number untouched; the challenge '
  || 'of B1 loses its phone HMAC, the one of B2 keeps it; to_e164 wiped on its outbox rows and on the OTP row, '
  || 'statuses untouched'
);

select is(
  concat_ws(' | ',
    pg_temp.audit('client_erased', 'C'),
    concat_ws(' ',
      pg_temp.r('erase_c') ->> 'erased', pg_temp.lt(pg_temp.r('erase_c') ->> 'client_id'),
      pg_temp.ids(pg_temp.r('erase_c') -> 'erased_ids'), pg_temp.r('erase_c') ->> 'appointments_kept',
      pg_temp.r('erase_c') ->> 'notes_deleted', pg_temp.r('erase_c') ->> 'consents_deleted',
      pg_temp.r('erase_c') ->> 'messages_wiped', pg_temp.r('erase_c') ->> 'otp_challenges_wiped',
      pg_temp.r('erase_c') ->> 'devices_revoked', pg_temp.r('erase_c') ->> 'tokens_revoked',
      pg_temp.r('erase_c') ->> 'suppressed',
      (select c.erased_at = (pg_temp.r('erase_c') ->> 'erased_at')::timestamptz from public.clients c
       where c.id = pg_temp.id('C')))),
  'B1:staff:O:client:C:clients=1 | true C C 6 2 2 3 1 1 2 1 t',
  'erase: one audit row client_erased (staff, the owner, entity the root, reason clients=1: no personal data); '
  || 'the answer counts what was kept, deleted, wiped, revoked and suppressed'
);

select is(
  concat_ws(' ',
    (select concat_ws(' ', count(*),
                      bool_and(s.phone_hmac = private.phone_hmac('+306970001234')),
                      bool_and(s.phone_hmac <> encode(sha256(convert_to('+306970001234', 'UTF8')), 'hex')),
                      bool_and(s.phone_hmac ~ '^[0-9a-f]{64}$' and s.phone_hmac !~ '6970001234'),
                      string_agg(s.reason, ','))
     from public.suppression_list s where s.business_id = pg_temp.id('B1')),
    (select count(*) from public.suppression_list s where s.business_id = pg_temp.id('B2'))),
  '1 t t t erased 0',
  'erase: the number goes to the suppression list of B1 only, as the keyed HMAC (private.phone_hmac with the '
  || 'Vault key), never a plain sha256 and never the number; reason erased'
);

select is(
  concat_ws(' ',
    pg_temp.q($$select count(*)::text from public.search_clients(p_business_id => {B1}, p_query => 'xenofon')$$, pg_temp.aal1('O')),
    pg_temp.q($$select count(*)::text from public.search_clients(p_business_id => {B1}, p_query => 'Ξενοφών')$$, pg_temp.aal1('O')),
    pg_temp.q($$select count(*)::text from public.search_clients(p_business_id => {B1}, p_query => '1234')$$, pg_temp.aal1('O')),
    pg_temp.q($$select coalesce(x ->> 'client_name', '<no name>')
               from jsonb_array_elements(private.today_summary_impl(p_business_id => {B1}, p_now => now()) -> 'to_mark') x
               where (x ->> 'appointment_id')::uuid = {CA5}$$, pg_temp.aal1('O')),
    pg_temp.q($$select string_agg(x ->> 'first_name', ',')
               from jsonb_array_elements(private.clients_for_phone_impl(p_business_id => {B1}, p_phone => '+306970001234',
                      p_grant => 'pgtap15-grant-c-0001', p_trusted_device_token => null, p_now => {T0}) -> 'clients') x$$,
              '', 'postgres'),
    pg_temp.q($$select private.verified_via(p_business_id => {B1}, p_phone => '+306970001234', p_grant => null,
                                            p_trusted_device_token => 'pgtap15-device-c-b1', p_now => {T0})$$, '', 'postgres'),
    pg_temp.q($$select private.manage_view_impl(p_token => 'pgtap15-manage-ca5', p_now => {T0}) -> 'appointment' ->> 'id'$$,
              '', 'postgres'),
    pg_temp.q($$select concat_ws(' ', c ->> 'state', c ->> 'client_id' = {C}::text,
                                 (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(c) k))
               from private.client_card_impl(p_business_id => {B1}, p_client_id => {C}, p_now => {T0}) c$$,
              pg_temp.aal1('O'))),
  '0 0 0 <no name> P0001/AN014 P0001/AN014 P0001/AN015 erased t client_id,erased_at,state',
  'after the erase no reader finds C: search finds nothing, the to-mark item has no name, the old grant and the '
  || 'trusted device no longer verify (AN014), the manage link is dead (AN015), the card answers only erased'
);

insert into public.otp_challenges (id, business_id, phone_hmac, code_hmac, expires_at, verified_at, grant_hash,
                                   grant_expires_at, created_at)
values (pg_temp.id('CH3'), pg_temp.id('B1'), private.phone_hmac('+306970001234'),
        encode(sha256(convert_to('pgtap15-code-3', 'UTF8')), 'hex'), '2026-06-10 08:55Z', '2026-06-10 08:51Z',
        private.token_hash('pgtap15-grant-c-0002'), '2027-01-01 00:00Z', '2026-06-10 08:50Z');

select is(
  pg_temp.q($$select concat_ws(' ', r ->> 'verified_via', r -> 'clients')
             from private.clients_for_phone_impl(p_business_id => {B1}, p_phone => '+306970001234',
                    p_grant => 'pgtap15-grant-c-0002', p_trusted_device_token => null, p_now => {T0}) r$$, '', 'postgres'),
  'otp []',
  'after the erase, the number verified again with a new grant is offered no client (a new booking creates a new one)'
);

select is(
  pg_temp.keep('claimC', private.claim_messages_impl(array[pg_temp.id('CM2')], now())::text),
  'ok',
  'claim of C''s queued SMS after the erase answers'
);

select is(
  concat_ws(' ', pg_temp.r('claimC'),
            (select concat_ws(':', m.status, coalesce(m.error, '-'), coalesce(m.to_e164, '-'))
             from public.messages_log m where m.id = pg_temp.id('CM2'))),
  '[] cancelled:no_recipient:-',
  'claim (1.5 carried): the queued SMS of the erased client is not sent but cancelled no_recipient'
);

select is(
  pg_temp.keep('erase_c2', pg_temp.erase_impl('C', pg_temp.fresh('O'))),
  'ok',
  'erase of an already erased client answers (the retry of a committed erase)'
);

select is(
  concat_ws(' ',
    pg_temp.r('erase_c2') ->> 'erased', pg_temp.lt(pg_temp.r('erase_c2') ->> 'client_id'),
    (pg_temp.r('erase_c2') ->> 'erased_at')::timestamptz = (pg_temp.r('erase_c') ->> 'erased_at')::timestamptz,
    pg_temp.r('erase_c2') -> 'erased_ids', pg_temp.r('erase_c2') ->> 'appointments_kept',
    pg_temp.r('erase_c2') ->> 'notes_deleted', pg_temp.r('erase_c2') ->> 'consents_deleted',
    pg_temp.r('erase_c2') ->> 'messages_wiped', pg_temp.r('erase_c2') ->> 'otp_challenges_wiped',
    pg_temp.r('erase_c2') ->> 'devices_revoked', pg_temp.r('erase_c2') ->> 'tokens_revoked',
    pg_temp.r('erase_c2') ->> 'suppressed', pg_temp.audit_count('client_erased', 'C')),
  'false C t [] 0 0 0 0 0 0 0 0 1',
  'erase is idempotent: erased false with the original erased_at, nothing counted, no second audit row'
);

-- =============================================================================================
-- G. A family erased through a merged source's id; the shared number of a live client
--    E (+306942000001) ← E2 (+306942000002, merged); D is a live client with E's number.
-- =============================================================================================
do $do$ begin perform set_config('t.fpE', pg_temp.fp(), true); end $do$;

select is(
  concat_ws(' ',
    (select count(*) from public.suppression_list s
     where s.business_id = pg_temp.id('B1') and s.phone_hmac = private.phone_hmac('+306942000001')),
    pg_temp.erase_impl('E2', pg_temp.fresh('O')),
    pg_temp.fp() = current_setting('t.fpE')),
  '0 P0001/AN032 t',
  'erase is refused while ANY family member has an appointment in progress (here the merged source E2) → AN032; '
  || 'nothing changed'
);

update public.appointments set status = 'cancelled', cancelled_by = 'business', cancel_reason = 'other'
where id = pg_temp.id('EA1');

select is(
  pg_temp.keep('erase_e', pg_temp.erase('E2', pg_temp.fresh('O'))),
  'ok',
  'public.erase_client as authenticated, called with the merged source''s id, with a fresh code'
);

select is(
  concat_ws(' ',
    pg_temp.r('erase_e') ->> 'erased', pg_temp.lt(pg_temp.r('erase_e') ->> 'client_id'),
    pg_temp.ids(pg_temp.r('erase_e') -> 'erased_ids'), pg_temp.r('erase_e') ->> 'suppressed',
    pg_temp.r('erase_e') ->> 'consents_deleted',
    (select string_agg(pg_temp.l(c.id) || ':' || (c.erased_at is not null)::text || ':' || (c.full_name = '')::text
                       || ':' || coalesce(c.phone_e164, '-'), ',' order by pg_temp.l(c.id))
     from public.clients c where c.id in (pg_temp.id('E'), pg_temp.id('E2'))),
    (select pg_temp.l(c.merged_into_id) from public.clients c where c.id = pg_temp.id('E2')),
    pg_temp.audit('client_erased', 'E')),
  'true E E,E2 2 1 E:true:true:-,E2:true:true:- E B1:staff:O:client:E:clients=2',
  'erase acts on the whole family: the root E and the source E2 are erased (sorted ids), both numbers suppressed, '
  || 'the merge link kept; one audit row on the root, clients=2'
);

select is(
  concat_ws(' ',
    pg_temp.q($$select private.client_card_impl(p_business_id => {B1}, p_client_id => {E2}, p_now => {T0}) ->> 'state'$$,
              pg_temp.aal1('O')),
    pg_temp.q($$select private.client_card_impl(p_business_id => {B1}, p_client_id => {E}, p_now => {T0}) ->> 'state'$$,
              pg_temp.aal1('O')),
    pg_temp.q($$select count(*)::text from public.search_clients(p_business_id => {B1}, p_query => 'Ευανθία')$$,
              pg_temp.aal1('O'))),
  'erased erased 0',
  'erase of the family: the cards of the source and the root answer erased; search finds neither'
);

select is(
  concat_ws(' ',
    (select concat_ws(' ', c.full_name, c.phone_e164, c.erased_at is null) from public.clients c where c.id = pg_temp.id('D')),
    (select count(*) from public.messages_log m where m.client_id = pg_temp.id('D') and m.to_e164 = '+306942000001'),
    (select count(*) from public.suppression_list s
     where s.business_id = pg_temp.id('B1') and s.phone_hmac = private.phone_hmac('+306942000001') and s.reason = 'erased'),
    (select count(*) from public.suppression_list s
     where s.business_id = pg_temp.id('B1') and s.phone_hmac = private.phone_hmac('+306942000002') and s.reason = 'erased')),
  'Δανάη Κοινού +306942000001 t 3 1 1',
  'shared number: the live client D keeps name, number and the number on its outbox rows; the number is '
  || 'suppressed nonetheless (plan-literal, contract D7)'
);

select is(
  pg_temp.keep('claimD', private.claim_messages_impl(array[pg_temp.id('DM2'), pg_temp.id('DM3')], now())::text),
  'ok',
  'claim of D''s queued reminder (imported appointment) and notice (online appointment)'
);

select is(
  concat_ws(' ',
    (select string_agg(pg_temp.lt(i ->> 'id'), ',' order by pg_temp.lt(i ->> 'id')) from jsonb_array_elements(pg_temp.r('claimD')) i),
    (select m.status || ':' || coalesce(m.error, '-') from public.messages_log m where m.id = pg_temp.id('DM2')),
    (select m.status from public.messages_log m where m.id = pg_temp.id('DM3'))),
  'DM3 cancelled:suppressed sending',
  'claim (1.5 rule 7c carried): the reminder of D''s imported appointment to the suppressed number is cancelled '
  || 'suppressed; the transactional notice of its online appointment still goes out'
);

select is(
  pg_temp.keep('erase_e2', pg_temp.erase_impl('E', pg_temp.fresh('O'))),
  'ok',
  'erase of the already erased family through the root answers'
);

select is(
  concat_ws(' ',
    pg_temp.r('erase_e2') ->> 'erased', pg_temp.lt(pg_temp.r('erase_e2') ->> 'client_id'),
    pg_temp.ids(pg_temp.r('erase_e2') -> 'erased_ids'), pg_temp.r('erase_e2') ->> 'suppressed',
    pg_temp.audit_count('client_erased', 'E')),
  'false E - 0 1',
  'erase of the family again: erased false, nothing suppressed again, still one audit row'
);

-- =============================================================================================
-- G. The numbers a client used before (review of 1.8). P «Ερμόλαος Βαρδαλάκης»:
--    · until April it had +306970077002: a reminder went to it (PM2, of PA0), a code was asked for
--      it and never used (CHP2, its OTP row PM3), and a device stayed trusted (TDP2);
--    · in May it booked online with +306970077001 by SMS code: the challenge CHP1 whose grant made
--      PA1, its OTP row PM1 (no client on it) and the device TDP1; no confirmation (SMS were off);
--    · now a staff member changes its mobile on the card to +306970077003 (the 1.8 edit sheet: a
--      direct UPDATE).
--    The erase finds the earlier numbers through the family's outbox rows (+306970077002) and
--    through the challenges whose grant made the family's bookings (+306970077001).
-- =============================================================================================
insert into public.clients (id, business_id, full_name, phone_e164, phone_verified_at, locale, source, created_at) values
  (pg_temp.id('P'), pg_temp.id('B1'), 'Ερμόλαος Βαρδαλάκης', '+306970077001', '2026-05-18 07:59Z', 'el', 'online',
   '2026-02-01 08:00Z');

insert into public.appointments (id, business_id, client_id, staff_id, starts_at, ends_at, status, source, verified_via,
                                 total_cents) values
  (pg_temp.id('PA0'), pg_temp.id('B1'), pg_temp.id('P'), pg_temp.id('St2'), '2026-04-22 07:00Z', '2026-04-22 07:30Z',
   'completed', 'phone', null, 1300),
  (pg_temp.id('PA1'), pg_temp.id('B1'), pg_temp.id('P'), pg_temp.id('St2'), '2026-05-22 07:00Z', '2026-05-22 07:30Z',
   'completed', 'online', 'otp', 1300);

insert into public.otp_challenges (id, business_id, phone_hmac, code_hmac, expires_at, verified_at, grant_hash,
                                   grant_expires_at, grant_used_at, grant_appointment_id, created_at) values
  (pg_temp.id('CHP1'), pg_temp.id('B1'), private.phone_hmac('+306970077001'),
   encode(sha256(convert_to('pgtap15-code-p1', 'UTF8')), 'hex'), '2026-05-18 08:05Z', '2026-05-18 07:59Z',
   private.token_hash('pgtap15-grant-p-0001'), '2026-05-18 08:30Z', '2026-05-18 08:01Z', pg_temp.id('PA1'),
   '2026-05-18 07:58Z'),
  (pg_temp.id('CHP2'), pg_temp.id('B1'), private.phone_hmac('+306970077002'),
   encode(sha256(convert_to('pgtap15-code-p2', 'UTF8')), 'hex'), '2026-04-20 08:05Z', null, null, null, null, null,
   '2026-04-20 07:58Z');

insert into public.trusted_devices (id, business_id, phone_hmac, token_hash, created_at, expires_at) values
  (pg_temp.id('TDP1'), pg_temp.id('B1'), private.phone_hmac('+306970077001'), private.token_hash('pgtap15-device-p1'),
   '2026-05-18 08:01Z', '2026-11-14 08:01Z'),
  (pg_temp.id('TDP2'), pg_temp.id('B1'), private.phone_hmac('+306970077002'), private.token_hash('pgtap15-device-p2'),
   '2026-03-01 08:00Z', '2026-08-28 08:00Z');

insert into public.messages_log (id, business_id, client_id, appointment_id, otp_challenge_id, dedupe_key, channel, to_e164,
                                 locale, template, category, status, scheduled_for, sent_at, created_at)
select pg_temp.id(m.label), pg_temp.id('B1'), pg_temp.id(m.client), pg_temp.id(m.appt), pg_temp.id(m.challenge),
       'pgtap15:' || m.label, 'sms', m.to_e164, 'el', m.template, m.category, 'sent', m.stamp, m.stamp, m.stamp
from (values
  ('PM1', null, null, 'CHP1', '+306970077001', 'otp', 'otp', timestamptz '2026-05-18 07:58Z'),
  ('PM2', 'P', 'PA0', null, '+306970077002', 'reminder', 'reminder', timestamptz '2026-04-21 07:00Z'),
  ('PM3', null, null, 'CHP2', '+306970077002', 'otp', 'otp', timestamptz '2026-04-20 07:58Z')
) as m (label, client, appt, challenge, to_e164, template, category, stamp);

select is(
  pg_temp.q($$update public.clients set phone_e164 = '+306970077003' where business_id = {B1} and id = {P}
              returning concat_ws(' ', phone_e164, phone_verified_at is null)$$, pg_temp.aal1('S')),
  '+306970077003 t',
  'a staff member changes P''s mobile on the card (a direct UPDATE, as the 1.8 edit sheet does): the new number '
  || 'needs a new verification'
);

do $do$ begin perform set_config('t.scanP0', array_to_string(pg_temp.scan('P'), ','), true); end $do$;

select is(
  concat_ws(' ',
    (select array_agg(x order by x) from unnest(array[
       'public.clients.full_name', 'public.clients.phone_e164', 'public.clients.search_text', 'public.messages_log.to_e164'
     ]) as x
     where not (x = any (string_to_array(current_setting('t.scanP0'), ',')))),
    (select count(*) from public.messages_log m
     where m.business_id = pg_temp.id('B1') and m.to_e164 in ('+306970077001', '+306970077002')),
    pg_temp.q($$select private.verified_via(p_business_id => {B1}, p_phone => '+306970077001', p_grant => null,
                                            p_trusted_device_token => 'pgtap15-device-p1', p_now => {T0})$$, '', 'postgres'),
    pg_temp.q($$select private.verified_via(p_business_id => {B1}, p_phone => '+306970077002', p_grant => null,
                                            p_trusted_device_token => 'pgtap15-device-p2', p_now => {T0})$$, '', 'postgres')),
  '3 trusted_device trusted_device',
  'P before the erase: its needles hit the client row and the outbox; three outbox rows hold its earlier numbers '
  || '(two of them OTP rows without a client); both devices of the earlier numbers still verify'
);

select is(
  pg_temp.keep('erase_p', pg_temp.erase_impl('P', pg_temp.fresh('O'))),
  'ok',
  'erase_client_impl: the owner with a fresh code erases P'
);

select is(
  pg_temp.scan('P'),
  array[]::text[],
  'SPEC §13 after a change of mobile: no text/json column of public or private holds P''s name, its current '
  || 'number or either earlier one (the OTP rows of the earlier numbers included)'
);

select is(
  concat_ws(' ',
    (select string_agg(pg_temp.l(d.id) || ':' || (d.revoked_at is not null)::text, ',' order by pg_temp.l(d.id))
     from public.trusted_devices d where d.id in (pg_temp.id('TDP1'), pg_temp.id('TDP2'))),
    (select string_agg(pg_temp.l(o.id) || ':' || coalesce(o.phone_hmac, 'null'), ',' order by pg_temp.l(o.id))
     from public.otp_challenges o where o.id in (pg_temp.id('CHP1'), pg_temp.id('CHP2'))),
    (select string_agg(pg_temp.l(m.id) || ':' || coalesce(m.to_e164, '-') || ':' || m.status, ',' order by pg_temp.l(m.id))
     from public.messages_log m where m.id in (pg_temp.id('PM1'), pg_temp.id('PM2'), pg_temp.id('PM3'))),
    (select string_agg(n.phone, ',' order by n.phone)
     from unnest(array['+306970077001', '+306970077002', '+306970077003']) as n (phone)
     where exists (select 1 from public.suppression_list s
                   where s.business_id = pg_temp.id('B1') and s.reason = 'erased'
                     and s.phone_hmac = private.phone_hmac(n.phone))),
    pg_temp.q($$select private.verified_via(p_business_id => {B1}, p_phone => '+306970077001', p_grant => null,
                                            p_trusted_device_token => 'pgtap15-device-p1', p_now => {T0})$$, '', 'postgres'),
    pg_temp.q($$select private.verified_via(p_business_id => {B1}, p_phone => '+306970077002', p_grant => null,
                                            p_trusted_device_token => 'pgtap15-device-p2', p_now => {T0})$$, '', 'postgres')),
  'TDP1:true,TDP2:true CHP1:null,CHP2:null PM1:-:sent,PM2:-:sent,PM3:-:sent '
  || '+306970077001,+306970077002,+306970077003 P0001/AN014 P0001/AN014',
  'erase of P: the devices of both earlier numbers revoked (they no longer verify), both challenges lose their '
  || 'phone HMAC, to_e164 wiped on every outbox row of the earlier numbers (statuses kept), and all three '
  || 'numbers suppressed (keyed HMAC)'
);

select is(
  concat_ws(' ',
    pg_temp.r('erase_p') ->> 'erased', pg_temp.lt(pg_temp.r('erase_p') ->> 'client_id'),
    pg_temp.ids(pg_temp.r('erase_p') -> 'erased_ids'), pg_temp.r('erase_p') ->> 'appointments_kept',
    pg_temp.r('erase_p') ->> 'notes_deleted', pg_temp.r('erase_p') ->> 'consents_deleted',
    pg_temp.r('erase_p') ->> 'messages_wiped', pg_temp.r('erase_p') ->> 'otp_challenges_wiped',
    pg_temp.r('erase_p') ->> 'devices_revoked', pg_temp.r('erase_p') ->> 'tokens_revoked',
    pg_temp.r('erase_p') ->> 'suppressed', pg_temp.audit('client_erased', 'P')),
  'true P P 2 0 0 3 2 2 0 3 B1:staff:O:client:P:clients=1',
  'erase of P: the answer counts the three outbox rows, two challenges, two devices and three suppressed numbers; '
  || 'one audit row'
);

select * from finish();
rollback;
