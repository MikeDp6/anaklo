-- Health, detection of authenticator-device changes and the reaction RPCs (phase-1 plan 1.9 «Tests»,
-- contract docs/plans/contracts/1.9-health-detection.md §2 and §5.1; ADR-0009 §17–§21). Written from
-- the plan and the contract only (independent author).
--   A. private.health_impl / public.health: the five watched jobs and their thresholds (exactly the
--      threshold is fresh), a newer failed run, a job that never ran (watched_since), unfinished
--      security events; the API roles
--   B. private.detect_factor_changes_impl: added and removed factors against
--      private.factor_change_grants ([created_at, expires_at + 30 s] on add grants, last_seen_at on remove
--      grants), factors verified and removed between two runs (GoTrue's audit log), the other
--      grant writers (mfa_reset, demotion), what is ignored, scope exits, the snapshot, audit rows,
--      containment at detection (D9), the nudge, job_runs, the declared actor and the cron job
--   C. claim_security_events / record_security_event_result: leases, the system grant (D10), the state
--      machine (containment until done, notifications at most once), the owners' push rows and the email
--      bundle, argument errors; the dispatch's system grant matched by the next detector run
--   D. the purge of grants (30 days) and of finished security events (12 months)
--   F. a fresh code counts only from a vetted device of a live aal2 session (has_fresh_totp, replaced)
--   E. the four new tables and the new functions are closed to the API roles (also in 01_security)
-- Review fixes (contract §8): the add window starts at the grant (no 30 s before it); the earlier
-- created factor and grant carry the LARGER ids (and the earlier grant the later expiry), so only the
-- (created_at, id) order passes; runs 10–11 (transient factors); section F; the accounted purge.
-- Conventions:
--   · The baseline detector run comes first: it absorbs any pending change of real users and keeps the
--     detector's advisory lock for the rest of this transaction, so no other run interleaves. Section A
--     deletes the open security events and the run history of the jobs it checks inside this
--     rolled-back transaction (health is global); every other assertion filters by the fixture users.
--   · Detector runs use the clocks pg_temp.p(k) = now() + 10·k s. Claims and results use fixed clocks in
--     2003 (pg_temp.t), so the outbox rows they queue are the only ones due when the message claim
--     runs; the purge runs at 2002-06-01, before every other row of this file.
--   · Factors, sessions, push devices and snapshot rows are synthetic rows written as postgres; no real
--     secret is read anywhere. The nudge goes to a sentinel URL and never leaves the transaction
--     (pg_net sends only after commit).
--   · Outcomes: the value, '<null>', the SQLSTATE, '42501/<hint>' when a 42501 carries a hint of ours.
--     An action and the reads of its effects are separate statements (a stable read sees the snapshot
--     of its statement). concat_ws prints booleans as t/f; ::text prints true/false.
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
-- Fixtures are written by the system; pg_temp.q declares '' around every API call.
select set_config('anaklo.actor_type', 'system', true);
select plan(121);

-- ---------------------------------------------------------------------------------------------
-- Labels
-- ---------------------------------------------------------------------------------------------
create temporary table lbl (id uuid primary key, label text not null unique);
-- created_at of every factor this file inserts (kept after the factor is deleted)
create temporary table fx (id uuid primary key, created_at timestamptz not null);

insert into pg_temp.lbl (id, label) values
  -- users
  ('e1600000-0000-4000-8000-000000000001', 'O1'),    -- owner B1, push device, session
  ('e1600000-0000-4000-8000-000000000002', 'O2'),    -- owner B1, no push device
  ('e1600000-0000-4000-8000-000000000003', 'M'),     -- manager B1
  ('e1600000-0000-4000-8000-000000000004', 'MM'),    -- manager B1, owner B2
  ('e1600000-0000-4000-8000-000000000005', 'S'),     -- staff B1 (promoted in run 7)
  ('e1600000-0000-4000-8000-000000000006', 'X'),     -- owner B2, push device
  ('e1600000-0000-4000-8000-000000000007', 'N'),     -- no membership
  ('e1600000-0000-4000-8000-000000000008', 'GA'),    -- managers of B1 from here on
  ('e1600000-0000-4000-8000-000000000009', 'GB1'),
  ('e1600000-0000-4000-8000-00000000000a', 'GB2'),
  ('e1600000-0000-4000-8000-00000000000b', 'GB3'),
  ('e1600000-0000-4000-8000-00000000000c', 'GB4'),
  ('e1600000-0000-4000-8000-00000000000d', 'GE'),
  ('e1600000-0000-4000-8000-00000000000e', 'GT'),
  ('e1600000-0000-4000-8000-00000000000f', 'GF'),
  ('e1600000-0000-4000-8000-000000000010', 'RG'),
  ('e1600000-0000-4000-8000-000000000011', 'RE1'),
  ('e1600000-0000-4000-8000-000000000012', 'RE2'),
  ('e1600000-0000-4000-8000-000000000013', 'NS'),
  ('e1600000-0000-4000-8000-000000000014', 'DM'),
  ('e1600000-0000-4000-8000-000000000015', 'UV'),
  ('e1600000-0000-4000-8000-000000000016', 'DX'),
  ('e1600000-0000-4000-8000-000000000017', 'CA'),
  ('e1600000-0000-4000-8000-000000000018', 'CR'),
  ('e1600000-0000-4000-8000-000000000019', 'CG'),
  -- managers of B1 for the review fixes: transient factors (TA…TG) and the fresh-code rule (VA)
  ('e1600000-0000-4000-8000-00000000001a', 'TA'),
  ('e1600000-0000-4000-8000-00000000001b', 'TB'),
  ('e1600000-0000-4000-8000-00000000001c', 'TC'),
  ('e1600000-0000-4000-8000-00000000001d', 'TD'),
  ('e1600000-0000-4000-8000-00000000001e', 'TF'),
  ('e1600000-0000-4000-8000-00000000001f', 'TG'),
  ('e1600000-0000-4000-8000-000000000020', 'VA'),
  -- businesses
  ('e1610000-0000-4000-8000-000000000001', 'B1'),
  ('e1610000-0000-4000-8000-000000000002', 'B2'),
  -- factors: pre-existing (in the snapshot)
  ('e1630000-0000-4000-8000-000000000001', 'F_O1'),
  ('e1630000-0000-4000-8000-000000000002', 'F_O2'),
  ('e1630000-0000-4000-8000-000000000003', 'F_X'),
  ('e1630000-0000-4000-8000-000000000004', 'F_M0'),
  ('e1630000-0000-4000-8000-000000000005', 'F_MM0'),
  ('e1630000-0000-4000-8000-000000000006', 'F_RG'),
  ('e1630000-0000-4000-8000-000000000007', 'F_RE1'),
  ('e1630000-0000-4000-8000-000000000008', 'F_RE2'),
  ('e1630000-0000-4000-8000-000000000009', 'F_NS1'),
  ('e1630000-0000-4000-8000-00000000000a', 'F_NS2'),
  ('e1630000-0000-4000-8000-00000000000b', 'F_DM'),
  ('e1630000-0000-4000-8000-00000000000c', 'F_DX1'),
  -- factors added later
  ('e1630000-0000-4000-8000-000000000010', 'F_M1'),
  ('e1630000-0000-4000-8000-000000000011', 'F_MM1'),
  ('e1630000-0000-4000-8000-000000000020', 'F_GA'),
  ('e1630000-0000-4000-8000-000000000021', 'F_GB1'),
  ('e1630000-0000-4000-8000-000000000022', 'F_GB2'),
  ('e1630000-0000-4000-8000-000000000023', 'F_GB3'),
  ('e1630000-0000-4000-8000-000000000024', 'F_GB4'),
  ('e1630000-0000-4000-8000-000000000025', 'F_GE'),
  -- the earlier factor has the larger id (only (created_at, id) order passes)
  ('e1630000-0000-4000-8000-000000000027', 'F_GT1'),
  ('e1630000-0000-4000-8000-000000000026', 'F_GT2'),
  ('e1630000-0000-4000-8000-000000000028', 'F_GF'),
  ('e1630000-0000-4000-8000-000000000030', 'F_UV'),
  ('e1630000-0000-4000-8000-000000000031', 'F_S'),
  ('e1630000-0000-4000-8000-000000000032', 'F_N'),
  ('e1630000-0000-4000-8000-000000000040', 'F_CA'),
  ('e1630000-0000-4000-8000-000000000041', 'F_MMX'),
  ('e1630000-0000-4000-8000-000000000042', 'F_CR'),    -- never inserted (already gone)
  ('e1630000-0000-4000-8000-000000000043', 'F_CG'),    -- never inserted (already gone)
  ('e1630000-0000-4000-8000-000000000050', 'F_EH1'),   -- ids only (section A events)
  ('e1630000-0000-4000-8000-000000000051', 'F_EH2'),
  ('e1630000-0000-4000-8000-000000000052', 'F_EH3'),
  ('e1630000-0000-4000-8000-000000000060', 'F_PGC'),   -- ids only (purge grants)
  ('e1630000-0000-4000-8000-000000000061', 'F_PGD'),
  -- review fixes: factors verified and removed between two runs (never in auth.mfa_factors here)
  ('e1630000-0000-4000-8000-000000000070', 'F_TA'),
  ('e1630000-0000-4000-8000-000000000071', 'F_TB'),
  ('e1630000-0000-4000-8000-000000000072', 'F_TC'),
  ('e1630000-0000-4000-8000-000000000073', 'F_TD'),
  ('e1630000-0000-4000-8000-000000000074', 'F_TN'),
  ('e1630000-0000-4000-8000-000000000075', 'F_TF'),     -- in the snapshot, removed with an audit entry
  ('e1630000-0000-4000-8000-000000000076', 'F_TG'),
  -- review fixes: VA's factors for the fresh-code rule (section F)
  ('e1630000-0000-4000-8000-000000000080', 'F_VA0'),    -- in the snapshot: vetted
  ('e1630000-0000-4000-8000-000000000081', 'F_VAX'),    -- enrolled straight at GoTrue, no grant
  ('e1630000-0000-4000-8000-000000000082', 'F_VAB'),    -- created 3 s before VA's add grant
  ('e1630000-0000-4000-8000-000000000084', 'F_VAG'),    -- inside VA's add grant (the larger id)
  ('e1630000-0000-4000-8000-000000000083', 'F_VAG2'),   -- inside the same grant, later: no grant left
  ('e1630000-0000-4000-8000-000000000085', 'F_VAF'),    -- in the snapshot but flagged by the detector
  ('e1630000-0000-4000-8000-000000000086', 'F_O1X'),    -- O1's device enrolled straight at GoTrue
  -- grants written directly (the others are labelled when written)
  -- the earlier grant has the larger id and the LATER expiry (only (created_at, id) order passes)
  ('e1640000-0000-4000-8000-000000000002', 'GE1'),
  ('e1640000-0000-4000-8000-000000000001', 'GE2'),
  ('e1640000-0000-4000-8000-000000000003', 'GRE1'),
  ('e1640000-0000-4000-8000-000000000004', 'GRE2'),
  ('e1640000-0000-4000-8000-000000000010', 'PG_A'),
  ('e1640000-0000-4000-8000-000000000011', 'PG_B'),
  ('e1640000-0000-4000-8000-000000000012', 'PG_C'),
  ('e1640000-0000-4000-8000-000000000013', 'PG_D'),
  ('e1640000-0000-4000-8000-000000000020', 'G_VA'),
  -- security events written directly
  ('e1650000-0000-4000-8000-000000000001', 'EH1'),
  ('e1650000-0000-4000-8000-000000000002', 'EH2'),
  ('e1650000-0000-4000-8000-000000000003', 'EH3'),
  ('e1650000-0000-4000-8000-000000000010', 'EV_A'),
  ('e1650000-0000-4000-8000-000000000011', 'EV_R'),
  ('e1650000-0000-4000-8000-000000000012', 'EV_G'),
  ('e1650000-0000-4000-8000-000000000013', 'EV_MM'),
  ('e1650000-0000-4000-8000-000000000014', 'EV_DX'),
  ('e1650000-0000-4000-8000-000000000020', 'PE_A'),
  ('e1650000-0000-4000-8000-000000000021', 'PE_B'),
  ('e1650000-0000-4000-8000-000000000022', 'PE_C'),
  ('e1650000-0000-4000-8000-000000000030', 'EV_VAF'),
  -- sessions of VA (section F)
  ('e1660000-0000-4000-8000-000000000011', 'S_VA0'),    -- aal2 with F_VA0
  ('e1660000-0000-4000-8000-000000000012', 'S_VAX'),    -- aal2 with F_VAX
  ('e1660000-0000-4000-8000-000000000013', 'S_VAB'),
  ('e1660000-0000-4000-8000-000000000014', 'S_VAG'),
  ('e1660000-0000-4000-8000-000000000015', 'S_VAG2'),
  ('e1660000-0000-4000-8000-000000000016', 'S_VAF'),
  ('e1660000-0000-4000-8000-000000000017', 'S_VA1'),    -- aal1 without a factor (its factor was unenrolled)
  ('e1660000-0000-4000-8000-000000000019', 'S_O1X'),    -- O1 aal2 with F_O1X
  ('e1660000-0000-4000-8000-000000000018', 'S_GONE');   -- never inserted (a revoked session)

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
  select x.id from pg_temp.lbl x where x.id::text like 'e1600000-%';
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

create function pg_temp.err(a_state text, a_message text)
returns text
language sql
immutable
as $fn$
  select case when a_state = 'P0001' then 'P0001 ' || a_message else a_state end;
$fn$;

create function pg_temp.keys(a_object jsonb)
returns text[]
language sql
immutable
as $fn$
  select array_agg(k order by k) from jsonb_object_keys(a_object) as k;
$fn$;

-- Clocks: section A's health clock, the detector runs, the claims/results, the purge.
create function pg_temp.pa()
returns timestamptz
language sql
stable
as $fn$
  select now() + interval '10 days';
$fn$;

create function pg_temp.p(a_k integer)
returns timestamptz
language sql
stable
as $fn$
  select now() + make_interval(secs => 10 * a_k);
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

create function pg_temp.claims(a_user text, a_aal text, a_amr jsonb)
returns text
language sql
stable
as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    'sub', pg_temp.id(a_user), 'role', 'authenticated', 'aal', a_aal, 'amr', a_amr))::text;
$fn$;

create function pg_temp.aal1(a_user text) returns text language sql stable as $fn$
  select pg_temp.claims(a_user, 'aal1', jsonb_build_array(jsonb_build_object('method', 'otp', 'timestamp', pg_temp.ago(0))));
$fn$;

-- aal2 with an authenticator code 1 minute old (fresh under the 300 s window set below)
create function pg_temp.fresh(a_user text) returns text language sql stable as $fn$
  select pg_temp.claims(a_user, 'aal2', jsonb_build_array(
    jsonb_build_object('method', 'totp', 'timestamp', pg_temp.ago(60)),
    jsonb_build_object('method', 'otp', 'timestamp', pg_temp.ago(3600))));
$fn$;

-- Runs one statement ({LABEL}s filled in) as a_role with a_claims; returns its single value,
-- '<null>', or the error. Role, claims and actor are reset afterwards. Without claims, anon and
-- service_role get the claims PostgREST would give them (a role, no sub).
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
    -- not a hint of ours and is reported as the bare code.
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
    perform vault.create_secret(a_value, a_name, 'pgTAP 16_health');
  else
    perform vault.update_secret(v_id, a_value, a_name, 'pgTAP 16_health');
  end if;
end;
$fn$;

-- The last nudge of this transaction: '<secret header ok> <content type ok> <source>'.
create function pg_temp.last_nudge()
returns text
language sql
stable
as $fn$
  select concat_ws(' ',
    q.headers ->> 'x-anaklo-dispatch-secret' = 'pgtap-16-dispatch-secret-not-a-secret-0001',
    q.headers ->> 'Content-Type' = 'application/json',
    convert_from(q.body, 'UTF8')::jsonb ->> 'source')
  from net.http_request_queue q
  where q.url = 'http://127.0.0.1:9/pgtap-16-nudge'
  order by q.id desc
  limit 1;
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
    pg_temp.id(a_label), pg_temp.id(a_user), 'pgTAP 16 ' || a_label, 'totp',
    case when a_verified then 'verified' else 'unverified' end, a_created, a_created,
    'PGTAPSYNTHETICSECRET' || upper(replace(a_label, '_', '')));
  insert into pg_temp.fx (id, created_at) values (pg_temp.id(a_label), a_created);
  if a_seen is not null then
    insert into private.mfa_factor_snapshot (factor_id, user_id, factor_created_at, first_seen_at, last_seen_at)
    values (pg_temp.id(a_label), pg_temp.id(a_user), a_created, a_seen, a_seen);
  end if;
end;
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

-- A security event written directly (fixture). factor_created_at from the factor when this file
-- inserted it; business_ids in the order given.
create function pg_temp.ev(a_label text, a_user text, a_kind text, a_factor text, a_detected timestamptz,
                           a_businesses text[], a_status text default 'pending', a_handled timestamptz default null)
returns void
language sql
as $fn$
  insert into private.security_events (id, user_id, kind, factor_id, factor_created_at, business_ids, detected_at,
                                       status, handled_at, result)
  values (pg_temp.id(a_label), pg_temp.id(a_user), a_kind, pg_temp.id(a_factor),
          coalesce((select f.created_at from pg_temp.fx f where f.id = pg_temp.id(a_factor)), a_detected - interval '1 day'),
          coalesce((select array_agg(pg_temp.id(b.label) order by b.o)
                    from unnest(a_businesses) with ordinality as b (label, o)), '{}'::uuid[]),
          a_detected, a_status, a_handled, case when a_status = 'done' then 'notified' end);
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
              where q.id > v_queue and q.url = 'http://127.0.0.1:9/pgtap-16-nudge'), '-'));
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

-- Audit rows of the detector about a user, in insertion order:
-- '<business>:<action>:<actor_type>:<actor>:<entity>:<entity_id>:<reason with the factor labelled>'.
create function pg_temp.audit_of(a_user text)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(concat_ws(':', pg_temp.l(a.business_id), a.action, a.actor_type, pg_temp.l(a.actor_id),
                                       a.entity, pg_temp.l(a.entity_id),
                                       case when a.reason like 'factor=%' then 'factor=' || pg_temp.lt(substr(a.reason, 8))
                                            else coalesce(a.reason, '<null>') end),
                             ',' order by a.id), '-')
  from public.audit_log a
  where a.entity_id = pg_temp.id(a_user)
    and a.action in ('factor_added_unauthorized', 'factor_removed_unauthorized');
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

-- The snapshot rows of a user, by factor label.
create function pg_temp.snap(a_user text)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(pg_temp.l(s.factor_id), ',' order by pg_temp.l(s.factor_id)), '-')
  from private.mfa_factor_snapshot s
  where s.user_id = pg_temp.id(a_user);
$fn$;

create function pg_temp.sessions_of(a_user text)
returns bigint language sql stable as $fn$
  select count(*) from auth.sessions s where s.user_id = pg_temp.id(a_user);
$fn$;

create function pg_temp.push_of(a_user text)
returns bigint language sql stable as $fn$
  select count(*) from public.push_subscriptions p where p.user_id = pg_temp.id(a_user);
$fn$;

-- Everything a run without changes must leave alone: the fixture users' events, the detector's audit
-- rows about them and their grants.
create function pg_temp.fp()
returns text
language sql
stable
as $fn$
  select md5(concat_ws('|',
    (select string_agg(concat_ws(':', e.id, e.status, e.attempts), ',' order by e.id)
     from private.security_events e where e.user_id in (select pg_temp.fxu())),
    (select count(*) from public.audit_log a
     where a.entity_id in (select pg_temp.fxu())
       and a.action in ('factor_added_unauthorized', 'factor_removed_unauthorized')),
    (select string_agg(concat_ws(':', g.id, g.matched_at), ',' order by g.id)
     from private.factor_change_grants g where g.user_id in (select pg_temp.fxu()))));
$fn$;

-- Section A: the run history of one job, replaced by one ok run a_ok_age seconds before the health
-- clock and optionally one failed run a_failed_age seconds before it (null = none).
create function pg_temp.set_runs(a_job text, a_ok_age integer, a_failed_age integer default null)
returns void
language plpgsql
as $fn$
begin
  delete from private.job_runs j where j.job = a_job;
  if a_ok_age is not null then
    insert into private.job_runs (job, started_at, finished_at, ok, rows_affected, error)
    values (a_job, pg_temp.pa() - make_interval(secs => a_ok_age + 5), pg_temp.pa() - make_interval(secs => a_ok_age),
            true, 0, null);
  end if;
  if a_failed_age is not null then
    insert into private.job_runs (job, started_at, finished_at, ok, rows_affected, error)
    values (a_job, pg_temp.pa() - make_interval(secs => a_failed_age + 5),
            pg_temp.pa() - make_interval(secs => a_failed_age), false, null, '57014');
  end if;
end;
$fn$;

-- One check of health at the section-A clock: '<age_seconds> <max_age_seconds> <stale> <overall ok>'.
create function pg_temp.hc(a_name text)
returns text
language sql
stable
as $fn$
  select concat_ws(' ', coalesce(c ->> 'age_seconds', 'null'), coalesce(c ->> 'max_age_seconds', 'null'),
                   coalesce(c ->> 'stale', 'null'), coalesce(x.h ->> 'ok', 'null'))
  from (select private.health_impl(pg_temp.pa()) as h) x
  cross join lateral jsonb_array_elements(x.h -> 'checks') as c
  where c ->> 'name' = a_name;
$fn$;

-- A job's check with its last ok run exactly a_max seconds old, then a_max + 1 (restored to 60 after).
create function pg_temp.edge(a_job text, a_max integer)
returns text
language plpgsql
as $fn$
declare
  v text;
begin
  perform pg_temp.set_runs(a_job, a_max);
  v := pg_temp.hc(a_job);
  perform pg_temp.set_runs(a_job, a_max + 1);
  v := v || ' | ' || pg_temp.hc(a_job);
  perform pg_temp.set_runs(a_job, 60);
  return v;
end;
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
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

create function pg_temp.item(a_key text, a_label text)
returns jsonb
language sql
stable
as $fn$
  select i
  from jsonb_array_elements(pg_temp.r(a_key) -> 'items') as i
  where (i ->> 'id')::uuid = pg_temp.id(a_label);
$fn$;

create function pg_temp.lease(a_key text, a_label text)
returns uuid
language sql
stable
as $fn$
  select (pg_temp.item(a_key, a_label) ->> 'lease_id')::uuid;
$fn$;

-- record_security_event_result_impl with the lease of a stored claim answer; the answer is kept in
-- tj.<a_key>. Returns the answer, or 'recorded=<…> notify <its keys>' when it carries a bundle.
create function pg_temp.res(a_key text, a_event text, a_claim text, a_outcome text, a_now timestamptz,
                            a_sent integer default null, a_failed integer default null, a_error text default null)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.record_security_event_result_impl(
         p_id => pg_temp.id(a_event), p_lease_id => pg_temp.lease(a_claim, a_event), p_outcome => a_outcome,
         p_emails_sent => a_sent, p_emails_failed => a_failed, p_error => a_error, p_now => a_now);
  perform set_config('tj.' || a_key, coalesce(v::text, ''), true);
  if v ? 'notify' then
    return 'recorded=' || coalesce(v ->> 'recorded', '<null>') || ' notify ' || pg_temp.keys(v)::text;
  end if;
  return coalesce(v::text, '<null>');
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- record_security_event_result_impl with raw arguments: the answer or the error.
create function pg_temp.res_raw(a_id uuid, a_lease uuid, a_outcome text, a_sent integer, a_failed integer,
                                a_error text, a_now timestamptz)
returns text
language plpgsql
as $fn$
begin
  return coalesce(private.record_security_event_result_impl(
           p_id => a_id, p_lease_id => a_lease, p_outcome => a_outcome, p_emails_sent => a_sent,
           p_emails_failed => a_failed, p_error => a_error, p_now => a_now)::text, '<null>');
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- State of an event: '<status> <attempts> <result> <error> <lease|nolease> <sent> <failed> <push_queued>'.
create function pg_temp.es(a_label text)
returns text
language sql
stable
as $fn$
  select coalesce((
    select concat_ws(' ', e.status, e.attempts::text, coalesce(e.result, '-'), coalesce(e.error, '-'),
                     case when e.lease_id is null and e.lease_until is null then 'nolease' else 'lease' end,
                     coalesce(e.emails_sent::text, '-'), coalesce(e.emails_failed::text, '-'),
                     coalesce(e.push_queued::text, '-'))
    from private.security_events e where e.id = pg_temp.id(a_label)), '<none>');
$fn$;

-- The owners' push rows of an event: '<recipient>:<business>:<locale>:<status>', by recipient.
create function pg_temp.push_rows(a_event text)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(concat_ws(':', pg_temp.l(m.recipient_user_id), pg_temp.l(m.business_id), m.locale, m.status),
                             ' ' order by pg_temp.l(m.recipient_user_id), pg_temp.l(m.business_id)), '-')
  from public.messages_log m
  where m.dedupe_key like 'security:' || pg_temp.id(a_event)::text || ':%';
$fn$;

-- Every push row of an event has the shape of §2.6 (D12), scheduled at a_at.
create function pg_temp.push_shape(a_event text, a_at timestamptz)
returns boolean
language sql
stable
as $fn$
  select coalesce(bool_and(
           m.channel = 'push' and m.template = 'push_security_alert' and m.category = 'transactional'
           and m.appointment_id is null and m.client_id is null and m.to_e164 is null
           and m.scheduled_for = a_at
           and m.dedupe_key = 'security:' || pg_temp.id(a_event)::text || ':' || m.business_id::text || ':'
                              || m.recipient_user_id::text), false)
  from public.messages_log m
  where m.dedupe_key like 'security:' || pg_temp.id(a_event)::text || ':%';
$fn$;

-- The dispatcher's message claim at a clock (limit 50), reported for the push rows of one event:
-- '<recipient> <channel> <template> <locale> <business_name> <push_targets>', by recipient.
create function pg_temp.due(a_event text, a_now timestamptz)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.claim_due_messages_impl(50, a_now);
  return coalesce((
    select string_agg(concat_ws(' ', pg_temp.l(m.recipient_user_id), i ->> 'channel', i ->> 'template', i ->> 'locale',
                                i ->> 'business_name', (i -> 'push_targets')::text),
                      ' | ' order by pg_temp.l(m.recipient_user_id))
    from jsonb_array_elements(v -> 'items') as i
    join public.messages_log m on m.id = (i ->> 'id')::uuid
    where m.dedupe_key like 'security:' || pg_temp.id(a_event)::text || ':%'), '-');
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- An audit entry as GoTrue writes it (auth.audit_log_entries; the probe of the review fixes): action,
-- the acting user and traits.factor_id. a_factor may be a label or a raw value.
create function pg_temp.gotrue_audit(a_action text, a_user text, a_factor text, a_at timestamptz)
returns void
language sql
as $fn$
  insert into auth.audit_log_entries (instance_id, id, payload, created_at, ip_address)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
          json_build_object('action', a_action, 'actor_id', pg_temp.id(a_user), 'log_type', 'factor',
                            'traits', json_build_object('factor_id', coalesce(pg_temp.id(a_factor)::text, a_factor))),
          a_at, '');
$fn$;

-- The accounted factors of a user (private.mfa_factor_accounted), by label.
create function pg_temp.accounted(a_user text)
returns text
language sql
stable
as $fn$
  select coalesce(string_agg(pg_temp.l(a.factor_id), ',' order by pg_temp.l(a.factor_id)), '-')
  from private.mfa_factor_accounted a
  where a.user_id = pg_temp.id(a_user);
$fn$;

-- aal2 claims WITH a session_id (a label, or a raw value), a code 1 minute old (a_age seconds).
create function pg_temp.fresh_s(a_user text, a_session text, a_age integer default 60)
returns text
language sql
stable
as $fn$
  select jsonb_build_object('sub', pg_temp.id(a_user), 'role', 'authenticated', 'aal', 'aal2',
    'session_id', coalesce(pg_temp.id(a_session)::text, a_session),
    'amr', jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', pg_temp.ago(a_age)),
      jsonb_build_object('method', 'otp', 'timestamp', pg_temp.ago(3600))))::text;
$fn$;

-- ---------------------------------------------------------------------------------------------
-- Keys and switches of this test (all inside the transaction; the rollback restores them)
-- ---------------------------------------------------------------------------------------------
select pg_temp.set_vault('dispatch_url', 'http://127.0.0.1:9/pgtap-16-nudge');
select pg_temp.set_vault('dispatch_secret', 'pgtap-16-dispatch-secret-not-a-secret-0001');
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
--   B1 'Beta Barber 16' (el, Europe/Athens): O1, O2 owners · M, MM, GA…CG managers · S staff
--   B2 'Alpha Barber 16' (en, Europe/London): X, MM owners (B2's name sorts first)
--   N: no membership. Push devices: O1, M, MM, S, X (O2 none). Sessions: M 2, MM, O1, X, S 1 each.
--   Pre-existing verified factors, already in the snapshot (seen 5′ ago, created days ago): O1, O2, X,
--   M (F_M0), MM (F_MM0), RG, RE1, RE2, NS (two), DM, DX.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select x.id, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated',
       lower(x.label) || '@health16.test', '{}'::jsonb, '{}'::jsonb, now(), now()
from pg_temp.lbl x
where x.id::text like 'e1600000-%';

insert into public.businesses (id, slug, name, vertical, timezone, locale) values
  ('e1610000-0000-4000-8000-000000000001', 'health16-b1', 'Beta Barber 16', 'barber', 'Europe/Athens', 'el'),
  ('e1610000-0000-4000-8000-000000000002', 'health16-b2', 'Alpha Barber 16', 'barber', 'Europe/London', 'en');

insert into public.business_members (business_id, user_id, role)
select pg_temp.id(m.b), pg_temp.id(m.u), m.role
from (values
  ('B1', 'O1', 'owner'), ('B1', 'O2', 'owner'), ('B1', 'M', 'manager'), ('B1', 'MM', 'manager'),
  ('B1', 'S', 'staff'), ('B1', 'GA', 'manager'), ('B1', 'GB1', 'manager'), ('B1', 'GB2', 'manager'),
  ('B1', 'GB3', 'manager'), ('B1', 'GB4', 'manager'), ('B1', 'GE', 'manager'), ('B1', 'GT', 'manager'),
  ('B1', 'GF', 'manager'), ('B1', 'RG', 'manager'), ('B1', 'RE1', 'manager'), ('B1', 'RE2', 'manager'),
  ('B1', 'NS', 'manager'), ('B1', 'DM', 'manager'), ('B1', 'UV', 'manager'), ('B1', 'DX', 'manager'),
  ('B1', 'CA', 'manager'), ('B1', 'CR', 'manager'), ('B1', 'CG', 'manager'),
  ('B1', 'TA', 'manager'), ('B1', 'TB', 'manager'), ('B1', 'TC', 'manager'), ('B1', 'TD', 'manager'),
  ('B1', 'TF', 'manager'), ('B1', 'TG', 'manager'), ('B1', 'VA', 'manager'),
  ('B2', 'X', 'owner'), ('B2', 'MM', 'owner')
) as m (b, u, role);

select pg_temp.factor(f.label, f.u, true, now() - f.age, now() - interval '5 minutes')
from (values
  ('F_O1', 'O1', interval '3 days'), ('F_O2', 'O2', interval '3 days'), ('F_X', 'X', interval '3 days'),
  ('F_M0', 'M', interval '3 days'), ('F_MM0', 'MM', interval '3 days'), ('F_RG', 'RG', interval '3 days'),
  ('F_RE1', 'RE1', interval '3 days'), ('F_RE2', 'RE2', interval '3 days'), ('F_NS1', 'NS', interval '3 days'),
  ('F_NS2', 'NS', interval '2 days'), ('F_DM', 'DM', interval '3 days'), ('F_DX1', 'DX', interval '3 days')
) as f (label, u, age);

insert into auth.sessions (id, user_id, created_at, updated_at)
select s.id::uuid, pg_temp.id(s.u), now() - interval '1 hour', now() - interval '1 hour'
from (values
  ('e1660000-0000-4000-8000-000000000001', 'M'), ('e1660000-0000-4000-8000-000000000002', 'M'),
  ('e1660000-0000-4000-8000-000000000003', 'MM'), ('e1660000-0000-4000-8000-000000000004', 'O1'),
  ('e1660000-0000-4000-8000-000000000005', 'X'), ('e1660000-0000-4000-8000-000000000006', 'S'),
  ('e1660000-0000-4000-8000-000000000007', 'TA')
) as s (id, u);

insert into public.push_subscriptions (user_id, provider, subscription_id, created_at)
select pg_temp.id(p.u), 'onesignal', p.sub, now() - interval '1 hour'
from (values
  ('O1', '16e0f000-0000-4000-8000-000000000001'), ('M', '16e0f000-0000-4000-8000-000000000003'),
  ('MM', '16e0f000-0000-4000-8000-000000000004'), ('S', '16e0f000-0000-4000-8000-000000000005'),
  ('X', '16e0f000-0000-4000-8000-000000000006')
) as p (u, sub);

-- =============================================================================================
-- A. Health (§2.4). Clock pg_temp.pa() = now() + 10 days. The open security events and the run
--    history of the five jobs are this section's own (deleted inside the transaction).
-- =============================================================================================
delete from private.security_events e where e.status <> 'done';
select pg_temp.set_runs(j.job, 60)
from unnest(array['auto_complete', 'detect_factor_changes', 'dispatch', 'dispatch_sweep', 'purge']) as j (job);

select is(
  (select string_agg(h.job || ':' || h.max_age_seconds::text, ',' order by h.job) from private.health_jobs h),
  'auto_complete:1800,detect_factor_changes:900,dispatch:900,dispatch_sweep:900,purge:93600',
  'health_jobs: exactly the five watched jobs, each with three missed periods as its threshold (purge 26 h)'
);

select is(
  (select concat_ws(' ', pg_temp.keys(x.h)::text, jsonb_array_length(x.h -> 'checks'),
            (select bool_and(pg_temp.keys(c) = array['age_seconds', 'max_age_seconds', 'name', 'stale'])
             from jsonb_array_elements(x.h -> 'checks') as c),
            (select string_agg(y.c ->> 'name', ',' order by y.o)
             from jsonb_array_elements(x.h -> 'checks') with ordinality as y (c, o)))
   from (select private.health_impl(pg_temp.pa()) as h) x),
  '{checks,ok} 6 t auto_complete,detect_factor_changes,dispatch,dispatch_sweep,purge,security_events',
  'health: exactly {ok, checks}; six checks ordered by name, each exactly {name, age_seconds, max_age_seconds, stale}'
);

select is(
  private.health_impl(pg_temp.pa()),
  '{"ok": true, "checks": [
     {"name": "auto_complete", "age_seconds": 60, "max_age_seconds": 1800, "stale": false},
     {"name": "detect_factor_changes", "age_seconds": 60, "max_age_seconds": 900, "stale": false},
     {"name": "dispatch", "age_seconds": 60, "max_age_seconds": 900, "stale": false},
     {"name": "dispatch_sweep", "age_seconds": 60, "max_age_seconds": 900, "stale": false},
     {"name": "purge", "age_seconds": 60, "max_age_seconds": 93600, "stale": false},
     {"name": "security_events", "age_seconds": null, "max_age_seconds": 900, "stale": false}]}'::jsonb,
  'health: every job ran ok 1 minute ago and no event is open → ok true, ages 60 s, the thresholds, nothing stale'
);

select is(pg_temp.edge('dispatch', 900), '900 900 false true | 901 900 true false',
  'health: dispatch last ok exactly 15 minutes ago is fresh; one second older is stale and ok turns false');

select is(pg_temp.edge('dispatch_sweep', 900), '900 900 false true | 901 900 true false',
  'health: dispatch_sweep fresh at exactly 900 s, stale at 901 s (D2)');

select is(pg_temp.edge('detect_factor_changes', 900), '900 900 false true | 901 900 true false',
  'health: detect_factor_changes fresh at exactly 900 s, stale at 901 s');

select is(pg_temp.edge('auto_complete', 1800), '1800 1800 false true | 1801 1800 true false',
  'health: auto_complete fresh at exactly 30 minutes, stale one second later');

select is(pg_temp.edge('purge', 93600), '93600 93600 false true | 93601 93600 true false',
  'health: purge fresh at exactly 26 hours, stale one second later');

select pg_temp.set_runs('dispatch', 960, 60);

select is(pg_temp.hc('dispatch'), '960 900 true false',
  'health: a newer FAILED run does not refresh a job (failed 1 minute ago, last ok 16 minutes ago → stale)');

select pg_temp.set_runs('dispatch', 60);
select pg_temp.set_runs('purge', null);
update private.health_jobs set watched_since = pg_temp.pa() - interval '93600 seconds' where job = 'purge';

select is(pg_temp.hc('purge'), 'null 93600 false true',
  'health: a job that never ran is fresh (age null) until its threshold has passed since it is watched');

update private.health_jobs set watched_since = pg_temp.pa() - interval '93601 seconds' where job = 'purge';

select is(pg_temp.hc('purge'), 'null 93600 true false',
  'health: a job that never ran is stale once watched_since is older than its threshold (age still null)');

select pg_temp.set_runs('purge', 60);
select pg_temp.ev('EH1', 'O1', 'factor_added_unauthorized', 'F_EH1', pg_temp.pa() - interval '900 seconds', array['B1']);

select is(pg_temp.hc('security_events'), '900 900 false true',
  'health (D4): an unfinished security event detected exactly 15 minutes ago is fresh');

update private.security_events set detected_at = pg_temp.pa() - interval '901 seconds' where id = pg_temp.id('EH1');
select pg_temp.ev('EH2', 'O1', 'factor_added_unauthorized', 'F_EH2', pg_temp.pa() - interval '100 seconds', array['B1']);

select is(pg_temp.hc('security_events'), '901 900 true false',
  'health (D4): the oldest unfinished event decides; 901 s → stale and ok false');

update private.security_events
set status = 'done', handled_at = pg_temp.pa() - interval '10 seconds', result = 'notified'
where id in (pg_temp.id('EH1'), pg_temp.id('EH2'));
select pg_temp.ev('EH3', 'O1', 'factor_added_unauthorized', 'F_EH3', pg_temp.pa() + interval '60 seconds', array['B1']);

select is(pg_temp.hc('security_events'), 'null 900 false true',
  'health (D4): a done event never counts, nor one detected after the clock (age null, not stale)');

delete from private.security_events e where e.id in (pg_temp.id('EH1'), pg_temp.id('EH2'), pg_temp.id('EH3'));

select throws_ok($$select private.health_impl(null)$$, '22023', null,
  'health_impl: a null clock → 22023');

select is(
  concat_ws(' ',
    pg_temp.q('select public.health()::text', '', 'anon'),
    pg_temp.q('select private.health_impl()::text', '', 'anon'),
    pg_temp.q('select public.health()::text', pg_temp.fresh('O1')),
    pg_temp.q('select private.health_impl()::text', pg_temp.fresh('O1')),
    pg_temp.q($$select (jsonb_typeof(public.health() -> 'checks') = 'array')::text$$, '', 'service_role'),
    pg_temp.q($$select (jsonb_typeof(private.health_impl() -> 'checks') = 'array')::text$$, '', 'service_role')),
  '42501 42501 42501 42501 true true',
  'health: anon and authenticated (even an owner at aal2) cannot execute health or health_impl; service_role gets '
  || 'the checks'
);

-- =============================================================================================
-- B. Detection (§2.5). Runs at pg_temp.p(k); every assertion is about the fixture users.
-- =============================================================================================
select set_config('request.jwt.claims', '', true);
select set_config('anaklo.actor_type', 'system', true);

-- Run 1: a verified factor of a manager (M) and of a manager/owner (MM), no grant.
select pg_temp.factor('F_M1', 'M', true, now());
select pg_temp.factor('F_MM1', 'MM', true, now());

select is(pg_temp.detect(pg_temp.p(1)), '2 | detect_factor_changes true 2 - | security',
  'run 1: two unauthorized additions → returns 2, one ok job run with rows_affected 2, one nudge with source security');

select is(
  concat_ws(' / ', pg_temp.events_of('M'), pg_temp.audit_of('M')),
  'factor_added_unauthorized:F_M1:pending:0:B1 / B1:factor_added_unauthorized:system:-:auth_user:M:factor=F_M1',
  'run 1: a manager''s verified factor without a grant → exactly one pending event (business_ids {B1}) and one '
  || 'audit row (B1, actor system without id, entity auth_user = the user, reason factor=<id>)'
);

select is(
  (select concat_ws(' ', count(*), bool_and(e.detected_at = pg_temp.p(1)), bool_and(e.factor_created_at = now()),
                    bool_and(e.lease_id is null and e.lease_until is null and e.contained_at is null
                             and e.handled_at is null and e.result is null and e.error is null))
   from private.security_events e where e.user_id = pg_temp.id('M')),
  '1 t t t',
  'run 1: the event carries the run''s clock as detected_at, the factor''s created_at, and no lease or outcome yet'
);

select is(
  concat_ws(' / ', pg_temp.events_of('MM'), pg_temp.audit_of('MM')),
  'factor_added_unauthorized:F_MM1:pending:0:B2,B1 / '
  || 'B2:factor_added_unauthorized:system:-:auth_user:MM:factor=F_MM1,B1:factor_added_unauthorized:system:-:auth_user:MM:factor=F_MM1',
  'run 1: owner of B2 and manager of B1 → one event with business_ids {B2, B1} (owner first) and one audit row per '
  || 'business, B2 first'
);

select is(
  concat_ws(' ', pg_temp.sessions_of('M'), pg_temp.push_of('M'), pg_temp.sessions_of('MM'), pg_temp.push_of('MM'),
            pg_temp.sessions_of('O1'), pg_temp.push_of('O1'), pg_temp.sessions_of('X'), pg_temp.push_of('X'),
            pg_temp.sessions_of('S'), pg_temp.push_of('S')),
  '0 0 0 0 1 1 1 1 1 1',
  'run 1 (D9): the sessions and push devices of M and MM are revoked at detection; everyone else keeps theirs'
);

select is(pg_temp.last_nudge(), 't t security',
  'run 1: the nudge carries the dispatch secret, JSON content and source security (pg_net sends it after commit)');

-- Run 1b: a second run with no factor change in between. Two open grants a wrong diff could consume:
-- an add grant of M whose window holds F_M1 (already in the snapshot) and a remove grant of a factor
-- that still exists.
select pg_temp.wgrant('W_M1b', 'M', 'add', null, 'user');
select pg_temp.wgrant('W_O1b', 'O1', 'remove', 'F_O1', 'user');
select set_config('t.fp', pg_temp.fp(), true);

select is(pg_temp.detect(pg_temp.p(2)), '0 | detect_factor_changes true 0 - | -',
  'second run with no change: returns 0, one ok job run with rows_affected 0, no nudge');

select is(
  concat_ws(' ', pg_temp.fp() = current_setting('t.fp'), pg_temp.gstate('W_M1b', null), pg_temp.gstate('W_O1b', null)),
  't open open',
  'second run: no new event, no audit row, no grant matched (the unauthorized factors are already in the snapshot; '
  || 'an add grant covering F_M1 and a remove grant of a factor still present stay open)'
);

select is(
  concat_ws(' ',
    (select string_agg(pg_temp.l(s.factor_id), ',' order by pg_temp.l(s.factor_id))
     from private.mfa_factor_snapshot s where s.user_id in (select pg_temp.fxu()))
    = (select string_agg(pg_temp.l(f.id), ',' order by pg_temp.l(f.id))
       from auth.mfa_factors f
       where f.user_id in (select pg_temp.fxu()) and f.status = 'verified'
         and exists (select 1 from public.business_members m where m.user_id = f.user_id and m.role in ('owner', 'manager'))),
    (select bool_and(s.last_seen_at = pg_temp.p(2)) from private.mfa_factor_snapshot s
     where s.user_id in (select pg_temp.fxu())),
    (select s.first_seen_at = pg_temp.p(1) and s.factor_created_at = now() and s.user_id = pg_temp.id('M')
     from private.mfa_factor_snapshot s where s.factor_id = pg_temp.id('F_M1')),
    (select s.first_seen_at = now() - interval '5 minutes' from private.mfa_factor_snapshot s
     where s.factor_id = pg_temp.id('F_O1'))),
  't t t t',
  'snapshot = the verified factors of the fixture users who are owner/manager; last_seen_at = the second run''s '
  || 'clock; a new row keeps the run that first saw it, an old row its first_seen_at'
);

-- Run 2: add grants. Each case has its own user, so no grant can serve another case.
select pg_temp.wgrant('W_GA', 'GA', 'add', null, 'user');
select pg_temp.wgrant('W_GB1', 'GB1', 'add', null, 'user');
select pg_temp.wgrant('W_GB2', 'GB2', 'add', null, 'user');
select pg_temp.wgrant('W_GB3', 'GB3', 'add', null, 'user');
select pg_temp.wgrant('W_GB4', 'GB4', 'add', null, 'user');
select pg_temp.wgrant('W_GT', 'GT', 'add', null, 'user');
-- GE2 first (heap order), GE1 created earlier but with the larger id and the later expiry: only the
-- (created_at, id) order picks GE1 (by id, by expires_at or by heap order GE2 would be consumed).
select pg_temp.dgrant('GE2', 'GE', 'add', null, 'user', now() - interval '1 minute', now() + interval '8 minutes');
select pg_temp.dgrant('GE1', 'GE', 'add', null, 'user', now() - interval '2 minutes', now() + interval '9 minutes');

select is(
  pg_temp.keep('afc', pg_temp.q($$select public.authorize_factor_change(p_action => 'add')::text$$, pg_temp.aal1('GF'))),
  'ok',
  'first enrolment: GF (manager without a verified factor) gets an add grant at aal1 through authorize_factor_change'
);

insert into pg_temp.lbl (id, label)
select (pg_temp.r('afc') ->> 'grant_id')::uuid, 'W_GF'
where pg_temp.r('afc') ->> 'grant_id' is not null;

select pg_temp.factor('F_GA', 'GA', true, now() + interval '1 minute');
select pg_temp.factor('F_GB1', 'GB1', true, now());
select pg_temp.factor('F_GB2', 'GB2', true, now() + interval '10 minutes 30 seconds');
select pg_temp.factor('F_GB3', 'GB3', true, now() - interval '1 second');
select pg_temp.factor('F_GB4', 'GB4', true, now() + interval '10 minutes 31 seconds');
select pg_temp.factor('F_GE', 'GE', true, now());
-- F_GT2 first (heap order); F_GT1 is created earlier and has the larger id
select pg_temp.factor('F_GT2', 'GT', true, now() + interval '2 minutes');
select pg_temp.factor('F_GT1', 'GT', true, now() + interval '1 minute');
select pg_temp.factor('F_GF', 'GF', true, now() + interval '1 minute');

select is(pg_temp.detect(pg_temp.p(3)), '3 | detect_factor_changes true 3 - | security',
  'run 2: three unmatched additions (GB3, GB4, GT''s second factor) → returns 3, rows_affected 3, one nudge');

select is(
  concat_ws(' | ',
    pg_temp.events_of('GA') || ' ' || pg_temp.grants_of('GA', 'user', pg_temp.p(3)),
    pg_temp.events_of('GF') || ' ' || pg_temp.grants_of('GF', 'user', pg_temp.p(3)),
    pg_temp.audit_of('GA') || ' ' || pg_temp.audit_of('GF')),
  '- add:-:matched | - add:-:matched | - -',
  'with a grant: a factor created 1 minute into an add grant → no event, no audit row, the grant consumed '
  || '(matched_at = the run''s clock); the same for a first enrolment authorised at aal1'
);

select is(
  concat_ws(' | ',
    pg_temp.events_of('GB1') || ' ' || pg_temp.grants_of('GB1', null, pg_temp.p(3)),
    pg_temp.events_of('GB2') || ' ' || pg_temp.grants_of('GB2', null, pg_temp.p(3)),
    pg_temp.events_of('GB3') || ' ' || pg_temp.grants_of('GB3', null, pg_temp.p(3)),
    pg_temp.events_of('GB4') || ' ' || pg_temp.grants_of('GB4', null, pg_temp.p(3))),
  '- add:-:matched | - add:-:matched | factor_added_unauthorized:F_GB3:pending:0:B1 add:-:open | '
  || 'factor_added_unauthorized:F_GB4:pending:0:B1 add:-:open',
  'add window [created_at, expires_at + 30 s] (review fix of D7): a factor created at the grant''s own instant or '
  || '30 s after its expiry matches; ONE second before the grant (a device enrolled first and authorized afterwards) '
  || 'or 31 s after the expiry → event, the grant stays unmatched'
);

select is(
  concat_ws(' ', pg_temp.events_of('GE'), pg_temp.gstate('GE1', pg_temp.p(3)), pg_temp.gstate('GE2', pg_temp.p(3))),
  '- matched open',
  'two eligible add grants: the earliest created is consumed (although it has the larger id, the later expiry and '
  || 'was inserted second), the other stays open'
);

select is(
  concat_ws(' / ', pg_temp.events_of('GT'), pg_temp.grants_of('GT', null, pg_temp.p(3)), pg_temp.audit_of('GT')),
  'factor_added_unauthorized:F_GT2:pending:0:B1 / add:-:matched / '
  || 'B1:factor_added_unauthorized:system:-:auth_user:GT:factor=F_GT2',
  'two new factors and one grant: the earlier created consumes it (although it has the larger id and was inserted '
  || 'second), the later one raises one event and one audit row'
);

-- Run 3: removals. RE1/RE2 grants are written against the snapshot's last_seen_at (D8).
select pg_temp.wgrant('W_RG', 'RG', 'remove', 'F_RG', 'user');

insert into private.factor_change_grants (id, user_id, action, factor_id, source, created_at, expires_at)
select pg_temp.id(g.label), s.user_id, 'remove', s.factor_id, 'user', s.last_seen_at - interval '10 minutes',
       s.last_seen_at + g.extra
from (values ('GRE1', 'F_RE1', interval '0 seconds'), ('GRE2', 'F_RE2', interval '1 second')) as g (label, factor, extra)
join private.mfa_factor_snapshot s on s.factor_id = pg_temp.id(g.factor);

select is(
  concat_ws(' ',
    (select s.last_seen_at = pg_temp.p(3) from private.mfa_factor_snapshot s where s.factor_id = pg_temp.id('F_RE1')),
    (select s.last_seen_at = pg_temp.p(3) from private.mfa_factor_snapshot s where s.factor_id = pg_temp.id('F_RE2')),
    (select count(*) from private.factor_change_grants g where g.id in (pg_temp.id('GRE1'), pg_temp.id('GRE2')))),
  't t 2',
  'removal fixtures: the factors were last seen by run 2; one remove grant expires exactly then, one a second later'
);

delete from auth.mfa_factors f
where f.id in (pg_temp.id('F_M0'), pg_temp.id('F_RG'), pg_temp.id('F_RE1'), pg_temp.id('F_RE2'));

select is(pg_temp.detect(pg_temp.p(4)), '2 | detect_factor_changes true 2 - | security',
  'run 3: two unmatched removals (M, RE1) → returns 2, rows_affected 2, one nudge');

select is(
  concat_ws(' / ', pg_temp.events_of('M'), pg_temp.audit_of('M')),
  'factor_added_unauthorized:F_M1:pending:0:B1 factor_removed_unauthorized:F_M0:pending:0:B1 / '
  || 'B1:factor_added_unauthorized:system:-:auth_user:M:factor=F_M1,B1:factor_removed_unauthorized:system:-:auth_user:M:factor=F_M0',
  'removal without a grant: a snapshot factor of M deleted directly → one factor_removed_unauthorized event and one '
  || 'audit row'
);

select is(
  (select concat_ws(' ', e.factor_created_at = now() - interval '3 days', e.detected_at = pg_temp.p(4))
   from private.security_events e
   where e.user_id = pg_temp.id('M') and e.kind = 'factor_removed_unauthorized'),
  't t',
  'removal event: factor_created_at from the snapshot, detected_at the run''s clock'
);

select is(
  concat_ws(' | ',
    pg_temp.events_of('RG') || ' ' || pg_temp.grants_of('RG', null, pg_temp.p(4)),
    pg_temp.events_of('RE1') || ' ' || pg_temp.grants_of('RE1', null, pg_temp.p(4)),
    pg_temp.events_of('RE2') || ' ' || pg_temp.grants_of('RE2', null, pg_temp.p(4))),
  '- remove:F_RG:matched | factor_removed_unauthorized:F_RE1:pending:0:B1 remove:F_RE1:open | - remove:F_RE2:matched',
  'D8: a user remove grant for that factor → no event, consumed; a grant that expired exactly at last_seen_at → '
  || 'event (the grant stays open); one second later → matched'
);

select is(
  (select count(*) from private.mfa_factor_snapshot s
   where s.factor_id in (pg_temp.id('F_M0'), pg_temp.id('F_RG'), pg_temp.id('F_RE1'), pg_temp.id('F_RE2'))),
  0::bigint,
  'run 3: removed factors leave the snapshot'
);

-- Run 4: the grants of Nous (mfa_reset) and of a demotion (the D1 trigger).
select is(
  pg_temp.keep('nsr', pg_temp.q($$select public.record_support_action(p_action => 'mfa_reset',
    p_reason => 'pgTAP 16 lost phone', p_ticket => 'T-16', p_user_id => {NS})::text$$, '', 'service_role')),
  'ok',
  'mfa_reset: Nous records the reset (remove grants with source nous_support)'
);

select is(
  pg_temp.keep('dmr', pg_temp.q($$select public.set_member_role(p_business_id => {B1}, p_user_id => {DM},
    p_role => 'staff')::text$$, pg_temp.fresh('O1'))),
  'ok',
  'demotion: the owner, with a fresh code, makes the manager DM staff'
);

select is(
  concat_ws(' ', pg_temp.grants_of('NS', 'nous_support'), pg_temp.grants_of('DM', 'demotion'),
            (select count(*) from auth.mfa_factors f where f.user_id = pg_temp.id('DM'))),
  'remove:F_NS1:open,remove:F_NS2:open remove:F_DM:open 0',
  'before run 4: a nous_support grant per factor of NS; the demotion deleted DM''s factor with a demotion grant'
);

-- the script deletes the factors through the admin API after recording the reset
delete from auth.mfa_factors f where f.user_id = pg_temp.id('NS');

select is(pg_temp.detect(pg_temp.p(5)), '0 | detect_factor_changes true 0 - | -',
  'run 4: removals covered by the grants of mfa_reset and of the demotion → returns 0, no nudge');

select is(
  concat_ws(' | ',
    pg_temp.events_of('NS') || ' ' || pg_temp.grants_of('NS', null, pg_temp.p(5)) || ' ' || pg_temp.audit_of('NS'),
    pg_temp.events_of('DM') || ' ' || pg_temp.grants_of('DM', null, pg_temp.p(5)) || ' ' || pg_temp.audit_of('DM')),
  '- remove:F_NS1:matched,remove:F_NS2:matched - | - remove:F_DM:matched -',
  'grants of mfa_reset (nous_support) and of a demotion give no event; each grant is matched'
);

-- Run 6: what is ignored.
select pg_temp.factor('F_UV', 'UV', false, now());
select pg_temp.factor('F_S', 'S', true, now());
select pg_temp.factor('F_N', 'N', true, now());

select is(pg_temp.detect(pg_temp.p(6)), '0 | detect_factor_changes true 0 - | -',
  'run 6: an unverified factor, a staff member''s and a non-member''s factors → returns 0, no nudge');

select is(
  concat_ws(' | ', pg_temp.events_of('UV') || ' ' || pg_temp.snap('UV'), pg_temp.events_of('S') || ' ' || pg_temp.snap('S'),
            pg_temp.events_of('N') || ' ' || pg_temp.snap('N')),
  '- - | - - | - -',
  'ignored: an unverified factor of a manager, a verified factor of staff and of a user without membership — no '
  || 'event, not in the snapshot'
);

-- Run 7: the unverified factor gets verified (no grant); the staff member is promoted (as postgres).
-- The run is called with someone's JWT claims: it hides them and restores them afterwards.
update auth.mfa_factors set status = 'verified', updated_at = now() where id = pg_temp.id('F_UV');
update public.business_members set role = 'manager'
where business_id = pg_temp.id('B1') and user_id = pg_temp.id('S');
select set_config('request.jwt.claims', pg_temp.aal1('O1'), true);

select is(pg_temp.detect(pg_temp.p(7)), '2 | detect_factor_changes true 2 - | security',
  'run 7: a factor verified after an earlier run and the factor of a promoted user → returns 2, one nudge');

select is(current_setting('request.jwt.claims'), pg_temp.aal1('O1'),
  'run 7: the caller''s JWT claims are restored after the run');

select set_config('request.jwt.claims', '', true);

select is(
  concat_ws(' / ', pg_temp.events_of('UV'), pg_temp.audit_of('UV'), pg_temp.events_of('S'), pg_temp.audit_of('S'),
            pg_temp.snap('UV'), pg_temp.snap('S')),
  'factor_added_unauthorized:F_UV:pending:0:B1 / B1:factor_added_unauthorized:system:-:auth_user:UV:factor=F_UV / '
  || 'factor_added_unauthorized:F_S:pending:0:B1 / B1:factor_added_unauthorized:system:-:auth_user:S:factor=F_S / '
  || 'F_UV / F_S',
  'D6: verified later without a grant → event at the next run; promoted from staff with a factor → event; both '
  || 'audit rows carry actor system without id even when the run had JWT claims; both enter the snapshot'
);

-- Run 8: scope exits.
--   · N (owner/manager nowhere): a snapshot row for N's existing verified factor, inserted directly
--   · GB3: deleted from auth.users (snapshot rows, grants and events go by cascade)
--   · DX: a factor deleted without a grant, then demoted to staff (no other factor left) → an event
--     with business_ids {} and no audit row (D18)
select set_config('t.gb3', concat_ws(' ',
  (select count(*) from private.mfa_factor_snapshot s where s.user_id = pg_temp.id('GB3')),
  (select count(*) from private.factor_change_grants g where g.user_id = pg_temp.id('GB3')),
  (select count(*) from private.security_events e where e.user_id = pg_temp.id('GB3'))), true);

insert into private.mfa_factor_snapshot (factor_id, user_id, factor_created_at, first_seen_at, last_seen_at)
values (pg_temp.id('F_N'), pg_temp.id('N'), now(), pg_temp.p(7), pg_temp.p(7));
delete from auth.mfa_factors f where f.id = pg_temp.id('F_DX1');
update public.business_members set role = 'staff'
where business_id = pg_temp.id('B1') and user_id = pg_temp.id('DX');
delete from auth.users u where u.id = pg_temp.id('GB3');

select is(
  current_setting('t.gb3') || ' -> ' || concat_ws(' ',
    (select count(*) from private.mfa_factor_snapshot s where s.user_id = pg_temp.id('GB3')),
    (select count(*) from private.factor_change_grants g where g.user_id = pg_temp.id('GB3')),
    (select count(*) from private.security_events e where e.user_id = pg_temp.id('GB3'))),
  '1 1 1 -> 0 0 0',
  'a user deleted from auth.users: the snapshot rows, grants and events go by cascade'
);

select is(pg_temp.detect(pg_temp.p(8)), '1 | detect_factor_changes true 1 - | security',
  'run 8: only DX''s unmatched removal is an event');

select is(
  concat_ws(' | ', pg_temp.snap('N') || ' ' || pg_temp.events_of('N'), pg_temp.events_of('GB3'),
            pg_temp.events_of('DX') || ' ' || pg_temp.audit_of('DX')),
  '- - | - | factor_removed_unauthorized:F_DX1:pending:0:- -',
  'scope exits: a snapshot row of a user who is owner/manager nowhere is dropped without event; a deleted user '
  || 'raises nothing; an unmatched removal of a user who is owner/manager nowhere → event with business_ids {} and no '
  || 'audit row (D18)'
);

-- Runs 10–11 (review fix of finding 1): factors verified and removed BETWEEN two runs, which no
-- snapshot ever held. They are known only from GoTrue's audit log (one `verification_attempted` entry
-- per successful verify, `factor_in_progress` at enrolment), written here as GoTrue writes them, a few
-- seconds after now() (inside the look-back of every later run). None of them is in auth.mfa_factors.
--   TA: verified, gone, no grant                   → factor_added_unauthorized, revoked at detection
--   TB: an add grant and a remove grant            → nothing, both grants consumed
--   TC: an add grant only                          → factor_removed_unauthorized, the add grant consumed
--   TD: enrolled, never verified                   → ignored (D6)
--   N:  verified, but owner/manager nowhere        → ignored
--   RG: a verify entry of F_RG, removed in run 3   → ignored (accounted for)
--   TF: in the snapshot, verified, deleted         → only the removal (it is not transient)
--   TG: enrolled 3 s BEFORE its add grant          → factor_added_unauthorized, the grant stays open
select pg_temp.wgrant('W_TB', 'TB', 'add', null, 'user');
select pg_temp.wgrant('W_TBr', 'TB', 'remove', 'F_TB', 'user');
select pg_temp.wgrant('W_TC', 'TC', 'add', null, 'user');
select pg_temp.wgrant('W_TG', 'TG', 'add', null, 'user');
select pg_temp.factor('F_TF', 'TF', true, now() - interval '3 days', pg_temp.p(8));
delete from auth.mfa_factors f where f.id = pg_temp.id('F_TF');

select pg_temp.gotrue_audit(a.action, a.u, a.f, now() + a.after)
from (values
  ('factor_in_progress', 'TA', 'F_TA', interval '1 second'),
  ('verification_attempted', 'TA', 'F_TA', interval '2 seconds'),
  ('factor_unenrolled', 'TA', 'F_TA', interval '3 seconds'),
  ('factor_in_progress', 'TB', 'F_TB', interval '1 second'),
  ('verification_attempted', 'TB', 'F_TB', interval '2 seconds'),
  ('factor_in_progress', 'TC', 'F_TC', interval '1 second'),
  ('verification_attempted', 'TC', 'F_TC', interval '2 seconds'),
  ('factor_in_progress', 'TD', 'F_TD', interval '1 second'),
  ('challenge_created', 'TD', 'F_TD', interval '2 seconds'),
  ('factor_in_progress', 'N', 'F_TN', interval '1 second'),
  ('verification_attempted', 'N', 'F_TN', interval '2 seconds'),
  ('verification_attempted', 'RG', 'F_RG', interval '2 seconds'),
  ('verification_attempted', 'TF', 'F_TF', interval '2 seconds'),
  ('factor_in_progress', 'TG', 'F_TG', interval '-3 seconds'),
  ('verification_attempted', 'TG', 'F_TG', interval '2 seconds'),
  -- not GoTrue's shape: never breaks a run
  ('verification_attempted', 'TA', 'not-a-uuid', interval '2 seconds')
) as a (action, u, f, after);

select is(pg_temp.detect(pg_temp.p(10)), '4 | detect_factor_changes true 4 - | security',
  'run 10: four events among the transient factors (TA added, TC removed, TG added) and TF''s removal → returns 4, '
  || 'one ok job run, one nudge; a malformed audit entry breaks nothing');

select is(
  concat_ws(' / ', pg_temp.events_of('TA'), pg_temp.audit_of('TA'), pg_temp.sessions_of('TA'),
    (select e.factor_created_at = now() + interval '1 second' and e.detected_at = pg_temp.p(10)
     from private.security_events e where e.user_id = pg_temp.id('TA'))),
  'factor_added_unauthorized:F_TA:pending:0:B1 / B1:factor_added_unauthorized:system:-:auth_user:TA:factor=F_TA / 0 / t',
  'transient without a grant (finding 1: added and removed between two runs) → one factor_added_unauthorized event '
  || '(factor_created_at from the enrolment entry), its audit row, and the user''s sessions revoked at detection'
);

select is(
  concat_ws(' | ',
    pg_temp.events_of('TB') || ' ' || pg_temp.grants_of('TB', null, pg_temp.p(10)),
    pg_temp.events_of('TC') || ' ' || pg_temp.grants_of('TC', null, pg_temp.p(10))),
  '- add:-:matched,remove:F_TB:matched | factor_removed_unauthorized:F_TC:pending:0:B1 add:-:matched',
  'transient with an add grant and a remove grant → no event, both consumed; with the add grant only → the add '
  || 'grant consumed and one factor_removed_unauthorized event'
);

select is(
  concat_ws(' | ', pg_temp.events_of('TD'), pg_temp.events_of('N'), pg_temp.events_of('RG'),
            pg_temp.events_of('TF'), pg_temp.audit_of('TF')),
  '- | - | - | factor_removed_unauthorized:F_TF:pending:0:B1 | '
  || 'B1:factor_removed_unauthorized:system:-:auth_user:TF:factor=F_TF',
  'ignored: a factor never verified, a verified factor of a user who is owner/manager nowhere, a factor accounted for '
  || 'by an earlier run; a snapshot factor with a verify entry → only its removal event'
);

select is(
  concat_ws(' / ', pg_temp.events_of('TG'), pg_temp.gstate('W_TG', pg_temp.p(10))),
  'factor_added_unauthorized:F_TG:pending:0:B1 / open',
  'review fix of D7 on the transient path: a device enrolled 3 s before the add grant (authorized afterwards) → '
  || 'event, the grant stays open'
);

select is(
  concat_ws(' | ', pg_temp.accounted('TA'), pg_temp.accounted('TB'), pg_temp.accounted('TC'), pg_temp.accounted('TD'),
            pg_temp.accounted('N'), pg_temp.accounted('TF'), pg_temp.accounted('TG'), pg_temp.accounted('RG'),
            pg_temp.snap('TA') || pg_temp.snap('TB') || pg_temp.snap('TC') || pg_temp.snap('TF') || pg_temp.snap('TG'),
    (select bool_and(a.accounted_at = pg_temp.p(10)) from private.mfa_factor_accounted a
     where a.factor_id in (pg_temp.id('F_TA'), pg_temp.id('F_TB'), pg_temp.id('F_TC'), pg_temp.id('F_TF'),
                           pg_temp.id('F_TG')))),
  'F_TA | F_TB | F_TC | - | F_N | F_TF | F_TG | F_RG | ----- | t',
  'accounted: every transient factor handled and every factor that left the snapshot (RG removed in run 3, N''s '
  || 'dropped out of scope in run 8), at the run''s clock; never an ignored one (TD, N''s F_TN); none enters the '
  || 'snapshot'
);

-- Run 11: the same audit entries are still inside the look-back. Section C deletes the events later:
-- the accounted table, not the events, keeps a factor from coming back.
select set_config('t.fp2', pg_temp.fp(), true);

select is(pg_temp.detect(pg_temp.p(11)), '0 | detect_factor_changes true 0 - | -',
  'run 11: the same audit entries again → returns 0, no nudge');

select is(pg_temp.fp() = current_setting('t.fp2'), true,
  'run 11: no new event, audit row or matched grant for a factor already accounted for');

-- A failing run and the shape of the job.
select is(pg_temp.detect(null), 'null | detect_factor_changes false - 22023 | -',
  'p_now null → the run returns null and records a failed job run with 22023 (and no nudge)');

select is(
  coalesce(pg_get_functiondef(to_regprocedure('private.detect_factor_changes_impl(timestamp with time zone)'))
           ~ $re$set_config\(\s*'anaklo\.actor_type'\s*,\s*'system'\s*,\s*true\s*\)$re$, false),
  true,
  'detect_factor_changes_impl declares the actor system itself (pg_cron runs it as postgres without a JWT)'
);

select is(
  (select string_agg(j.jobname || ' | ' || j.schedule || ' | '
                     || (j.command ~ 'private\.detect_factor_changes_impl\(\)')::text, ', ')
   from cron.job j where j.jobname = 'detect-factor-changes'),
  'detect-factor-changes | */5 * * * * | true',
  'cron: detect-factor-changes every 5 minutes calling private.detect_factor_changes_impl()'
);

-- =============================================================================================
-- C. Claim and results (§2.6). Clocks pg_temp.t(s) in 2003. The events of section B are removed;
--    the events below are written directly (as the detector writes them), with factors in the
--    snapshot where the factor still exists. Push devices of M, S and MM come back, so the owners'
--    rows can be told apart from managers, staff and the affected user.
-- =============================================================================================
select set_config('anaklo.actor_type', 'system', true);
select set_config('anaklo.dispatch_nudged', '', true);
delete from private.security_events e where e.user_id in (select pg_temp.fxu());

insert into public.push_subscriptions (user_id, provider, subscription_id, created_at)
select pg_temp.id(p.u), 'onesignal', p.sub, now() - interval '1 hour'
from (values
  ('M', '16e0f000-0000-4000-8000-000000000013'), ('MM', '16e0f000-0000-4000-8000-000000000014'),
  ('S', '16e0f000-0000-4000-8000-000000000015')
) as p (u, sub);

select pg_temp.factor('F_CA', 'CA', true, now() - interval '1 hour', pg_temp.p(8));
select pg_temp.factor('F_MMX', 'MM', true, now() - interval '1 hour', pg_temp.p(8));
select pg_temp.ev('EV_A', 'CA', 'factor_added_unauthorized', 'F_CA', pg_temp.t(-300), array['B1']);

select is(pg_temp.claim('c1', 1, pg_temp.t(0)), 'EV_A more=true',
  'claim: the pending event is leased (limit 1 filled → more true)');

select is(
  (select concat_ws(' ', pg_temp.keys(x.i)::text, x.i ->> 'kind', pg_temp.lt(x.i ->> 'user_id'),
                    pg_temp.lt(x.i ->> 'factor_id'), x.i ->> 'attempts', (x.i ->> 'lease_id') is not null)
   from (select pg_temp.item('c1', 'EV_A') as i) x),
  '{attempts,factor_id,id,kind,lease_id,user_id} factor_added_unauthorized CA F_CA 1 t',
  'claim item: exactly {id, lease_id, kind, user_id, factor_id, attempts}'
);

select is(
  concat_ws(' ', pg_temp.es('EV_A'),
    (select e.lease_id = pg_temp.lease('c1', 'EV_A') and e.lease_until = pg_temp.t(120)
     from private.security_events e where e.id = pg_temp.id('EV_A')),
    pg_temp.grants_of('CA', 'system')),
  'containing 1 - - lease - - - t remove:F_CA:open',
  'claim: containing, attempts 1, the item''s lease for 120 s; an added event whose factor exists gets a system '
  || 'remove grant (D10, before dispatch deletes)'
);

select is(pg_temp.claim('c2', 1, pg_temp.t(0)), '- more=false',
  'claim again at the same clock: nothing (the lease holds)');

select is(pg_temp.claim('c3', 1, pg_temp.t(121)), 'EV_A more=true',
  'claim after the lease expired (121 s): the same event again');

select is(
  concat_ws(' ', pg_temp.es('EV_A'),
    (select e.lease_id = pg_temp.lease('c3', 'EV_A') and e.lease_until = pg_temp.t(241)
     from private.security_events e where e.id = pg_temp.id('EV_A')),
    pg_temp.lease('c3', 'EV_A') <> pg_temp.lease('c1', 'EV_A'),
    pg_temp.item('c3', 'EV_A') ->> 'attempts',
    pg_temp.grants_of('CA', 'system')),
  'containing 2 - - lease - - - t t 2 remove:F_CA:open,remove:F_CA:open',
  're-claim: attempts 2, a new lease of 120 s, and a second system grant (containment repeats harmlessly)'
);

select is(pg_temp.res('r1', 'EV_A', 'c1', 'contained', pg_temp.t(122)), '{"recorded": false}',
  'a result with the old lease is refused without error');

select is(pg_temp.res('r2', 'EV_A', 'c3', 'notified', pg_temp.t(122), 0, 0), '{"recorded": false}',
  'notified while the event is still containing is refused (the outcome does not fit the status)');

select is(
  concat_ws(' ', pg_temp.es('EV_A'),
    (select e.lease_id = pg_temp.lease('c3', 'EV_A') and e.contained_at is null
     from private.security_events e where e.id = pg_temp.id('EV_A'))),
  'containing 2 - - lease - - - t',
  'refused results change nothing'
);

select is(pg_temp.res('r3', 'EV_A', 'c3', 'contain_failed', pg_temp.t(123), null, null, 'factor_delete_failed'),
  '{"recorded": true}',
  'contain_failed with the current lease is recorded');

select is(pg_temp.es('EV_A'), 'pending 2 - factor_delete_failed nolease - - -',
  'contain_failed → back to pending, lease cleared, the code kept (retried by the next run)');

select is(pg_temp.claim('c4', 1, pg_temp.t(124)), 'EV_A more=true',
  'a pending event after contain_failed is claimed again (containment until done)');

select is(pg_temp.res('r4', 'EV_A', 'c4', 'contain_failed', pg_temp.t(125), null, null, 'not a code!'),
  '{"recorded": true}',
  'contain_failed with an error that is not a code is still recorded');

select is(pg_temp.es('EV_A'), 'pending 3 - error nolease - - -',
  'an error that does not look like a code is stored as error');

select is(pg_temp.claim('c5', 1, pg_temp.t(126)), 'EV_A more=true',
  'claimed a fourth time');

select is(pg_temp.res('r5', 'EV_A', 'c5', 'contained', pg_temp.t(130)), 'recorded=true notify {notify,recorded}',
  'contained with the current lease → {recorded: true, notify: <bundle>}');

select is(
  concat_ws(' ', pg_temp.es('EV_A'),
    (select concat_ws(' ', e.contained_at = pg_temp.t(130), e.lease_until = pg_temp.t(250),
                      e.lease_id = pg_temp.lease('c5', 'EV_A'), e.handled_at is null)
     from private.security_events e where e.id = pg_temp.id('EV_A')),
    pg_temp.grants_of('CA', 'system')),
  'notifying 4 - - lease - - 1 t t t t remove:F_CA:open,remove:F_CA:open,remove:F_CA:open,remove:F_CA:open',
  'contained → notifying, contained_at = the clock, the lease renewed for 120 s, error cleared, push_queued 1; one '
  || 'system grant per claim'
);

select is(
  (select concat_ws(' ', pg_temp.keys(x.n)::text, x.n ->> 'kind', (x.n ->> 'detected_at')::timestamptz = pg_temp.t(-300),
                    x.n ->> 'push_queued')
   from (select pg_temp.r('r5') -> 'notify' as n) x),
  '{account_email,businesses,detected_at,emails,kind,push_queued} factor_added_unauthorized t 1',
  'bundle: exactly {account_email, businesses, detected_at, emails, kind, push_queued} (0012 adds account_email and '
  || 'businesses for the Nous copy, contract 1.9b §2.4.5)'
);

select is(
  pg_temp.r('r5') -> 'notify' -> 'emails',
  jsonb_build_array(
    jsonb_build_object('audience', 'user', 'to', 'ca@health16.test', 'locale', 'el', 'timezone', 'Europe/Athens',
                       'business_name', null, 'account_email', 'ca@health16.test'),
    jsonb_build_object('audience', 'owner', 'to', 'o1@health16.test', 'locale', 'el', 'timezone', 'Europe/Athens',
                       'business_name', 'Beta Barber 16', 'account_email', 'ca@health16.test'),
    jsonb_build_object('audience', 'owner', 'to', 'o2@health16.test', 'locale', 'el', 'timezone', 'Europe/Athens',
                       'business_name', 'Beta Barber 16', 'account_email', 'ca@health16.test')),
  'bundle emails: the user first (B1''s language and zone), then every owner of B1 by email (O2 without a device '
  || 'too); never a manager'
);

select is(
  concat_ws(' ', pg_temp.push_rows('EV_A'), pg_temp.push_shape('EV_A', pg_temp.t(130))),
  'O1:B1:el:queued t',
  'contained: one push row (D12) for O1, the only owner of B1 with a device: template push_security_alert, '
  || 'transactional, B1''s locale, no appointment, scheduled now, dedupe security:<event>:<business>:<owner>'
);

select is(pg_temp.res('r6', 'EV_A', 'c5', 'notified', pg_temp.t(131), 2, 1), '{"recorded": true}',
  'notified with the current lease is recorded');

select is(
  concat_ws(' ', pg_temp.es('EV_A'),
    (select e.handled_at = pg_temp.t(131) from private.security_events e where e.id = pg_temp.id('EV_A'))),
  'done 4 notified - nolease 2 1 1 t',
  'notified → done, result notified, handled_at = the clock, lease cleared, the two counts kept'
);

select is(pg_temp.res('r7', 'EV_A', 'c5', 'notified', pg_temp.t(132), 2, 1), '{"recorded": false}',
  'a second notified is refused (the event is done)');

-- A removed event, and an added one whose factor is already gone.
select pg_temp.ev('EV_R', 'CR', 'factor_removed_unauthorized', 'F_CR', pg_temp.t(-240), array['B1']);
select pg_temp.ev('EV_G', 'CG', 'factor_added_unauthorized', 'F_CG', pg_temp.t(-180), array['B1']);

select is(pg_temp.claim('c6', 10, pg_temp.t(200)), 'EV_R,EV_G more=false',
  'claim (limit 10): the pending events by detection time; the done event is never claimed again');

select is(
  concat_ws(' ', pg_temp.es('EV_R'), pg_temp.es('EV_G'), pg_temp.grants_of('CR', null), pg_temp.grants_of('CG', null),
            (select e.handled_at = pg_temp.t(131) from private.security_events e where e.id = pg_temp.id('EV_A'))),
  'containing 1 - - lease - - - containing 1 - - lease - - - - - t',
  'no system grant for a removed event, nor for an added event whose factor no longer exists; the done event untouched'
);

-- The event of a user who is manager of B1 and owner of B2.
select pg_temp.ev('EV_MM', 'MM', 'factor_added_unauthorized', 'F_MMX', pg_temp.t(-120), array['B2', 'B1']);

select is(pg_temp.claim('c7', 1, pg_temp.t(300)), 'EV_MM more=true',
  'claim: MM''s event (the others hold their leases)');

select is(pg_temp.grants_of('MM', 'system'), 'remove:F_MMX:open',
  'claim: a system remove grant for MM''s added factor');

select is(pg_temp.res('r8', 'EV_MM', 'c7', 'contained', pg_temp.t(301)), 'recorded=true notify {notify,recorded}',
  'contained: MM''s event');

select is(
  concat_ws(' ', pg_temp.es('EV_MM'), pg_temp.push_rows('EV_MM'), pg_temp.push_shape('EV_MM', pg_temp.t(301))),
  'notifying 1 - - lease - - 2 O1:B1:el:queued X:B2:en:queued t',
  'push rows exactly for X (owner of B2, en) and O1 (owner of B1, el): none for O2 (no device), none for MM (the '
  || 'user, owner of B2), M or S (not owners)'
);

select is(
  pg_temp.r('r8') -> 'notify' -> 'emails',
  jsonb_build_array(
    jsonb_build_object('audience', 'user', 'to', 'mm@health16.test', 'locale', 'en', 'timezone', 'Europe/London',
                       'business_name', null, 'account_email', 'mm@health16.test'),
    jsonb_build_object('audience', 'owner', 'to', 'x@health16.test', 'locale', 'en', 'timezone', 'Europe/London',
                       'business_name', 'Alpha Barber 16', 'account_email', 'mm@health16.test'),
    jsonb_build_object('audience', 'owner', 'to', 'o1@health16.test', 'locale', 'el', 'timezone', 'Europe/Athens',
                       'business_name', 'Beta Barber 16', 'account_email', 'mm@health16.test'),
    jsonb_build_object('audience', 'owner', 'to', 'o2@health16.test', 'locale', 'el', 'timezone', 'Europe/Athens',
                       'business_name', 'Beta Barber 16', 'account_email', 'mm@health16.test')),
  'bundle emails: MM as user in the language and zone of B2 (owner memberships first), then the owners by business '
  || 'name (Alpha = B2: X; Beta = B1: O1, O2), each naming MM''s account; never MM as owner'
);

select is(
  (select concat_ws(' ', x.n ->> 'kind', (x.n ->> 'detected_at')::timestamptz = pg_temp.t(-120), x.n ->> 'push_queued')
   from (select pg_temp.r('r8') -> 'notify' as n) x),
  'factor_added_unauthorized t 2',
  'bundle: kind, detected_at and push_queued 2'
);

select is(
  pg_temp.due('EV_MM', pg_temp.t(302)),
  'O1 push push_security_alert el Beta Barber 16 [{"provider": "onesignal", "subscription_id": "16e0f000-0000-4000-8000-000000000001"}]'
  || ' | X push push_security_alert en Alpha Barber 16 [{"provider": "onesignal", "subscription_id": "16e0f000-0000-4000-8000-000000000006"}]',
  'claim_due_messages then hands the dispatcher both security pushes with the business name and only the owner''s '
  || 'own devices'
);

-- MM's notifications are lost mid-way (the lease runs out while notifying).
select is(pg_temp.claim('c8', 10, pg_temp.t(422)), 'EV_R,EV_G more=false',
  'the next claim after the notifying lease ran out does not hand MM''s event out again; expired containments are');

select is(
  concat_ws(' ', pg_temp.es('EV_MM'),
    (select e.handled_at = pg_temp.t(422) from private.security_events e where e.id = pg_temp.id('EV_MM'))),
  'done 1 notify_unknown - nolease - - 2 t',
  'a notifying event past its lease is closed by the claim: done, notify_unknown, handled_at = the clock, lease '
  || 'cleared (never re-sent)'
);

select is(pg_temp.res('r9', 'EV_MM', 'c7', 'notified', pg_temp.t(423), 2, 0), '{"recorded": false}',
  'the late notified of the dead lease is refused');

select is(
  concat_ws(' ', pg_temp.claim('c9', 10, pg_temp.t(3600)), pg_temp.es('EV_MM')),
  'EV_R,EV_G more=false done 1 notify_unknown - nolease - - 2',
  'later claims never hand out MM''s closed event, and the refused result left it notify_unknown'
);

select is(
  concat_ws(' ',
    pg_temp.claim('v1', 0, pg_temp.t(0)), pg_temp.claim('v2', 11, pg_temp.t(0)),
    pg_temp.claim('v3', null, pg_temp.t(0)), pg_temp.claim('v4', 1, null)),
  '22023 22023 22023 22023',
  'claim_security_events_impl: limit 0, 11 or null, or a null clock → 22023'
);

select is(
  concat_ws(' ',
    pg_temp.res_raw(pg_temp.id('EV_R'), pg_temp.lease('c9', 'EV_R'), 'done', null, null, null, pg_temp.t(3601)),
    pg_temp.res_raw(pg_temp.id('EV_R'), pg_temp.lease('c9', 'EV_R'), 'contained', 1, 0, null, pg_temp.t(3601)),
    pg_temp.res_raw(pg_temp.id('EV_R'), pg_temp.lease('c9', 'EV_R'), 'contain_failed', 0, null, 'x', pg_temp.t(3601)),
    pg_temp.res_raw(pg_temp.id('EV_R'), pg_temp.lease('c9', 'EV_R'), 'notified', null, null, null, pg_temp.t(3601)),
    pg_temp.res_raw(pg_temp.id('EV_R'), pg_temp.lease('c9', 'EV_R'), 'notified', -1, 0, null, pg_temp.t(3601)),
    pg_temp.res_raw(pg_temp.id('EV_R'), pg_temp.lease('c9', 'EV_R'), 'notified', 0, 101, null, pg_temp.t(3601)),
    pg_temp.res_raw(null, pg_temp.lease('c9', 'EV_R'), 'contained', null, null, null, pg_temp.t(3601)),
    pg_temp.res_raw(pg_temp.id('EV_R'), null, 'contained', null, null, null, pg_temp.t(3601)),
    pg_temp.res_raw(pg_temp.id('EV_R'), pg_temp.lease('c9', 'EV_R'), null, null, null, null, pg_temp.t(3601))),
  '22023 22023 22023 22023 22023 22023 22023 22023 22023',
  'record_security_event_result_impl: an unknown outcome, counts without notified, notified without both counts or '
  || 'with a count outside 0–100, a null id, lease or outcome → 22023'
);

select is(pg_temp.es('EV_R'), 'containing 3 - - lease - - -',
  'the refused calls changed nothing');

-- An event whose user is owner/manager nowhere (business_ids {}).
select pg_temp.ev('EV_DX', 'DX', 'factor_removed_unauthorized', 'F_DX1', pg_temp.t(-60), array[]::text[]);

select is(pg_temp.claim('c10', 10, pg_temp.t(7200)), 'EV_R,EV_G,EV_DX more=false',
  'claim: by detection time, the event of a user who is owner/manager nowhere included');

select is(pg_temp.res('r10', 'EV_DX', 'c10', 'contained', pg_temp.t(7201)), 'recorded=true notify {notify,recorded}',
  'contained: DX''s event');

select is(
  concat_ws(' ',
    pg_temp.r('r10') -> 'notify' -> 'emails' = jsonb_build_array(jsonb_build_object(
      'audience', 'user', 'to', 'dx@health16.test', 'locale', 'el', 'timezone', 'UTC', 'business_name', null,
      'account_email', 'dx@health16.test')),
    pg_temp.r('r10') -> 'notify' ->> 'push_queued', pg_temp.push_rows('EV_DX')),
  't 0 -',
  'business_ids {}: only the user''s email, in el/UTC; no push'
);

-- The dispatcher deletes MM's added factor after its system grant: the next run raises nothing.
delete from auth.mfa_factors f where f.id = pg_temp.id('F_MMX');

select is(pg_temp.detect(pg_temp.p(12)), '0 | detect_factor_changes true 0 - | -',
  'run 12: the factor deleted by dispatch after its system grant → returns 0, no nudge');

select is(
  concat_ws(' / ', pg_temp.events_of('MM'), pg_temp.grants_of('MM', 'system', pg_temp.p(12)), pg_temp.snap('MM')),
  'factor_added_unauthorized:F_MMX:done:1:B2,B1 / remove:F_MMX:matched / F_MM0,F_MM1',
  'the system grant of claim_security_events gives no factor_removed_unauthorized event and is matched; the factor '
  || 'leaves the snapshot'
);

-- =============================================================================================
-- D. Purge (§2.7) at 2002-06-01 (every other row of this file is younger, so the count is ours).
--    Grants: 30 days after greatest(expires_at, matched_at). Security events: done 12 months after
--    handled_at; unfinished ones never.
-- =============================================================================================
select pg_temp.dgrant('PG_A', 'N', 'add', null, 'user',
  '2002-05-01 23:49:59+00', '2002-05-01 23:59:59+00');
select pg_temp.dgrant('PG_B', 'N', 'add', null, 'user',
  '2002-05-01 23:50:01+00', '2002-05-02 00:00:01+00');
select pg_temp.dgrant('PG_C', 'N', 'remove', 'F_PGC', 'user',
  '2002-03-31 23:50:00+00', '2002-04-01 00:00:00+00', '2002-05-01 23:59:59+00');
select pg_temp.dgrant('PG_D', 'N', 'remove', 'F_PGD', 'user',
  '2002-03-31 23:50:00+00', '2002-04-01 00:00:00+00', '2002-05-02 00:00:01+00');
select pg_temp.ev('PE_A', 'N', 'factor_added_unauthorized', 'F_PGC', '2001-05-31 22:59:59+00', array[]::text[],
  'done', '2001-05-31 23:59:59+00');
select pg_temp.ev('PE_B', 'N', 'factor_added_unauthorized', 'F_PGD', '2001-05-31 23:00:01+00', array[]::text[],
  'done', '2001-06-01 00:00:01+00');
select pg_temp.ev('PE_C', 'N', 'factor_removed_unauthorized', 'F_PGC', '1995-01-01 00:00:00+00', array[]::text[]);
-- the detector's accounted factors (review fixes): 30 days after accounted_at
insert into private.mfa_factor_accounted (factor_id, user_id, accounted_at) values
  (pg_temp.id('F_PGC'), pg_temp.id('N'), '2002-05-01 23:59:59+00'),
  (pg_temp.id('F_PGD'), pg_temp.id('N'), '2002-05-02 00:00:01+00');

select is(pg_temp.purge('2002-06-01 00:00:00+00'), '4 | purge true 4 -',
  'purge: two grants, one finished event and one accounted factor deleted, counted in the returned total and in '
  || 'rows_affected');

select is(
  concat_ws(' ',
    exists (select 1 from private.factor_change_grants g where g.id = pg_temp.id('PG_A')),
    exists (select 1 from private.factor_change_grants g where g.id = pg_temp.id('PG_B')),
    exists (select 1 from private.factor_change_grants g where g.id = pg_temp.id('PG_C')),
    exists (select 1 from private.factor_change_grants g where g.id = pg_temp.id('PG_D'))),
  'f t f t',
  'purge: a grant 30 days + 1 s past its expiry goes, 1 s younger stays; a later matched_at counts the same way'
);

select is(
  concat_ws(' ',
    exists (select 1 from private.security_events e where e.id = pg_temp.id('PE_A')),
    exists (select 1 from private.security_events e where e.id = pg_temp.id('PE_B')),
    exists (select 1 from private.security_events e where e.id = pg_temp.id('PE_C'))),
  'f t t',
  'purge: a done event 12 months + 1 s after handled_at goes, 1 s younger stays; a pending event of any age stays'
);

select is(
  concat_ws(' ',
    exists (select 1 from private.mfa_factor_accounted a where a.factor_id = pg_temp.id('F_PGC')),
    exists (select 1 from private.mfa_factor_accounted a where a.factor_id = pg_temp.id('F_PGD'))),
  'f t',
  'purge: an accounted factor 30 days + 1 s after accounted_at goes, 1 s younger stays (the audit look-back is at '
  || 'most 7 days)');

-- =============================================================================================
-- F. Review fixes of findings 2 and 3: a fresh code counts only when the session's factor is vetted
--    (private.has_fresh_totp, replaced in 0011; private.unvetted_factors; private.match_add_grants).
--    GoTrue sets auth.sessions.factor_id to the factor of the session's last verify and drops the
--    session to aal1 without a factor when that factor is unenrolled (the probe of the review fixes).
--    VA (manager of B1): F_VA0 in the snapshot (vetted); F_VAX enrolled straight at GoTrue (no grant);
--    G_VA an add grant created 60 s ago; F_VAB created 3 s BEFORE it; F_VAG inside it; F_VAG2 inside
--    it too but later (the grant goes to F_VAG); F_VAF in the snapshot but flagged by the detector.
--    O1 (owner of B1) also gets a device enrolled straight at GoTrue (F_O1X). One session per device,
--    and S_VA1 at aal1 without a factor (its factor was unenrolled while the access token lives on).
--    No detector run follows this section.
-- =============================================================================================
select set_config('request.jwt.claims', '', true);
select set_config('anaklo.actor_type', 'system', true);

select pg_temp.factor('F_VA0', 'VA', true, now() - interval '3 days', pg_temp.p(12));
select pg_temp.factor('F_VAX', 'VA', true, now() - interval '1 day');
select pg_temp.dgrant('G_VA', 'VA', 'add', null, 'user', now() - interval '60 seconds', now() + interval '9 minutes');
select pg_temp.factor('F_VAB', 'VA', true, now() - interval '63 seconds');
select pg_temp.factor('F_VAG2', 'VA', true, now() - interval '20 seconds');
select pg_temp.factor('F_VAG', 'VA', true, now() - interval '30 seconds');
select pg_temp.factor('F_VAF', 'VA', true, now() - interval '2 days', pg_temp.p(12));
select pg_temp.ev('EV_VAF', 'VA', 'factor_added_unauthorized', 'F_VAF', pg_temp.p(12), array['B1']);
select pg_temp.factor('F_O1X', 'O1', true, now() - interval '1 hour');

insert into auth.sessions (id, user_id, created_at, updated_at, aal, factor_id)
select pg_temp.id(s.label), pg_temp.id(s.u), now() - interval '1 hour', now(), s.aal::auth.aal_level,
       pg_temp.id(s.factor)
from (values
  ('S_VA0', 'VA', 'aal2', 'F_VA0'), ('S_VAX', 'VA', 'aal2', 'F_VAX'), ('S_VAB', 'VA', 'aal2', 'F_VAB'),
  ('S_VAG', 'VA', 'aal2', 'F_VAG'), ('S_VAG2', 'VA', 'aal2', 'F_VAG2'), ('S_VAF', 'VA', 'aal2', 'F_VAF'),
  ('S_VA1', 'VA', 'aal1', null), ('S_O1X', 'O1', 'aal2', 'F_O1X')
) as s (label, u, aal, factor);

select is(
  (select string_agg(pg_temp.l(u), ',' order by pg_temp.l(u)) from private.unvetted_factors(pg_temp.id('VA')) as u),
  'F_VAB,F_VAF,F_VAG2,F_VAX',
  'unvetted_factors: a device without a grant, one created before the grant, the later of two devices in one grant '
  || 'and a flagged one; never the snapshot device or the earliest device inside the grant'
);

select is(
  concat_ws(' ',
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.fresh_s('VA', 'S_VA0'), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.fresh_s('VA', 'S_VAG'), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.fresh('VA'), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.fresh_s('VA', 'S_VA0', 360), 'postgres')),
  'true true true false',
  'has_fresh_totp: a fresh code of a session whose factor is in the snapshot, or inside an earlier add grant, counts; '
  || 'claims without session_id keep the 0009 rule; the window still applies'
);

select is(
  concat_ws(' ',
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.fresh_s('VA', 'S_VAX'), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.fresh_s('VA', 'S_VAB'), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.fresh_s('VA', 'S_VAG2'), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.fresh_s('VA', 'S_VAF'), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.fresh_s('VA', 'S_VA1'), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.fresh_s('VA', 'S_GONE'), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.fresh_s('O1', 'S_VA0'), 'postgres'),
    pg_temp.q('select private.has_fresh_totp()::text', pg_temp.fresh_s('VA', 'not-a-session'), 'postgres')),
  'false false false false false false false false',
  'has_fresh_totp is false for a code from: a device enrolled straight at GoTrue, a device created before its grant, '
  || 'the second device of one grant, a flagged device; a session dropped to aal1 (its factor unenrolled), a revoked '
  || 'session, another user''s session, a malformed session_id'
);

select is(
  concat_ws(' ',
    pg_temp.q($$select public.authorize_factor_change(p_action => 'add')::text$$, pg_temp.fresh_s('VA', 'S_VAX')),
    pg_temp.q($$select public.authorize_factor_change(p_action => 'add')::text$$, pg_temp.fresh_s('VA', 'S_VAB')),
    pg_temp.q($$select public.authorize_factor_change(p_action => 'remove', p_factor_id => {F_VA0})::text$$,
              pg_temp.fresh_s('VA', 'S_VAX')),
    pg_temp.q($$select public.authorize_factor_change(p_action => 'add')::text$$, pg_temp.fresh_s('VA', 'S_VA1')),
    pg_temp.grants_of('VA', null)),
  '42501/fresh_totp_required 42501/fresh_totp_required 42501/fresh_totp_required 42501/fresh_totp_required add:-:open',
  'finding 2: a stolen aal2 session that enrols and verifies its own device cannot issue an add grant (whether the '
  || 'device came before the grant or is a throwaway), nor remove the user''s own device, nor use the token after '
  || 'unenrolling the device: fresh_totp_required, and no grant is written (G_VA only)'
);

select is(
  pg_temp.keep('afc_va', pg_temp.q($$select public.authorize_factor_change(p_action => 'add')::text$$,
                                   pg_temp.fresh_s('VA', 'S_VA0'))),
  'ok',
  'the same call with a fresh code from the vetted device passes (an add grant)'
);

select is(
  concat_ws(' ',
    pg_temp.q($$select public.set_member_role(p_business_id => {B1}, p_user_id => {GA}, p_role => 'staff')::text$$,
              pg_temp.fresh_s('O1', 'S_O1X')),
    (select m.role from public.business_members m
     where m.business_id = pg_temp.id('B1') and m.user_id = pg_temp.id('GA'))),
  '42501/fresh_totp_required manager',
  'finding 3: every critical action, not only the device grants: an owner''s fresh code from a device enrolled '
  || 'straight at GoTrue does not pass set_member_role, and the role is unchanged'
);

-- =============================================================================================
-- E. The new tables and functions are closed to the API roles (also in 01_security).
-- =============================================================================================
select is(
  concat_ws(' ',
    (select count(*) from pg_class c
     where c.oid = any (array['private.health_jobs', 'private.mfa_factor_snapshot', 'private.security_events',
                              'private.mfa_factor_accounted']::regclass[])
       and c.relrowsecurity),
    (select count(*) from pg_policies p
     where p.schemaname = 'private'
       and p.tablename in ('health_jobs', 'mfa_factor_snapshot', 'security_events', 'mfa_factor_accounted')),
    coalesce((select string_agg(r.role_name || ' ' || t.table_name, ', ' order by r.role_name, t.table_name)
              from unnest(array['private.health_jobs', 'private.mfa_factor_snapshot', 'private.security_events',
                                'private.mfa_factor_accounted']) as t (table_name)
              cross join unnest(array['anon', 'authenticated', 'service_role', 'public']) as r (role_name)
              where has_table_privilege(r.role_name, t.table_name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 or has_any_column_privilege(r.role_name, t.table_name, 'SELECT,INSERT,UPDATE,REFERENCES')), 'none')),
  '4 0 none',
  'health_jobs, mfa_factor_snapshot, security_events, mfa_factor_accounted: RLS on, no policy, no privilege for '
  || 'anon, authenticated, service_role or PUBLIC'
);

select is(
  concat_ws(' ',
    pg_temp.q('select count(*)::text from private.health_jobs', '', 'anon'),
    pg_temp.q('select count(*)::text from private.mfa_factor_snapshot', '', 'anon'),
    pg_temp.q('select count(*)::text from private.security_events', '', 'anon'),
    pg_temp.q('select count(*)::text from private.health_jobs', pg_temp.fresh('O1')),
    pg_temp.q('select count(*)::text from private.mfa_factor_snapshot', pg_temp.fresh('O1')),
    pg_temp.q('select count(*)::text from private.security_events', pg_temp.fresh('O1')),
    pg_temp.q('select count(*)::text from private.health_jobs', '', 'service_role'),
    pg_temp.q('select count(*)::text from private.mfa_factor_snapshot', '', 'service_role'),
    pg_temp.q('select count(*)::text from private.security_events', '', 'service_role'),
    pg_temp.q('select count(*)::text from private.mfa_factor_accounted', '', 'anon'),
    pg_temp.q('select count(*)::text from private.mfa_factor_accounted', pg_temp.fresh('O1')),
    pg_temp.q('select count(*)::text from private.mfa_factor_accounted', '', 'service_role')),
  '42501 42501 42501 42501 42501 42501 42501 42501 42501 42501 42501 42501',
  'no API role reads the four new tables directly'
);

select is(
  (select string_agg(n.nspname || '.' || p.proname || ':'
                     || coalesce((select string_agg(r.role_name, ',' order by r.role_name)
                                  from unnest(array['anon', 'authenticated', 'service_role']) as r (role_name)
                                  where has_function_privilege(r.role_name, p.oid, 'execute')), '-')
                     || ':' || p.prosecdef::text,
                     ' ' order by n.nspname, p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname, p.proname) in (
     ('public', 'health'), ('private', 'health_impl'), ('public', 'claim_security_events'),
     ('private', 'claim_security_events_impl'), ('public', 'record_security_event_result'),
     ('private', 'record_security_event_result_impl'))),
  'private.claim_security_events_impl:service_role:true private.health_impl:service_role:true '
  || 'private.record_security_event_result_impl:service_role:true public.claim_security_events:service_role:false '
  || 'public.health:service_role:false public.record_security_event_result:service_role:false',
  'the new RPCs: service_role only; each _impl SECURITY DEFINER in private, each wrapper SECURITY INVOKER in public'
);

select is(
  concat_ws(' ',
    pg_temp.q('select public.claim_security_events(1)::text', '', 'anon'),
    pg_temp.q('select private.claim_security_events_impl(1, now())::text', '', 'anon'),
    pg_temp.q($$select public.record_security_event_result({EV_R}, {EV_R}, 'notified', 0, 0, null)::text$$, '', 'anon'),
    pg_temp.q($$select private.record_security_event_result_impl({EV_R}, {EV_R}, 'notified', 0, 0, null, now())::text$$,
              '', 'anon'),
    pg_temp.q('select public.claim_security_events(1)::text', pg_temp.fresh('O1')),
    pg_temp.q('select private.claim_security_events_impl(1, now())::text', pg_temp.fresh('O1')),
    pg_temp.q($$select public.record_security_event_result({EV_R}, {EV_R}, 'notified', 0, 0, null)::text$$,
              pg_temp.fresh('O1')),
    pg_temp.q($$select private.record_security_event_result_impl({EV_R}, {EV_R}, 'notified', 0, 0, null, now())::text$$,
              pg_temp.fresh('O1')),
    pg_temp.q('select private.detect_factor_changes_impl()::text', pg_temp.fresh('O1')),
    pg_temp.q('select private.queue_security_notifications({EV_R}, now())::text', pg_temp.fresh('O1'))),
  '42501 42501 42501 42501 42501 42501 42501 42501 42501 42501',
  'anon and authenticated (even an owner at aal2) cannot claim, record, run the detector or queue notifications'
);

select is(
  (select concat_ws(' ', count(distinct p.proname),
            coalesce(string_agg(r.role_name || ' ' || p.proname, ', ' order by r.role_name, p.proname)
                     filter (where has_function_privilege(r.role_name, p.oid, 'execute')), 'none'))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   cross join unnest(array['anon', 'authenticated', 'service_role']) as r (role_name)
   where n.nspname = 'private'
     and p.proname in ('detect_factor_changes_impl', 'queue_security_notifications', 'match_add_grants',
                       'unvetted_factors', 'has_fresh_totp')),
  '5 none',
  'detect_factor_changes_impl, queue_security_notifications, match_add_grants, unvetted_factors and the replaced '
  || 'has_fresh_totp exist and no API role may execute them'
);

select * from finish();
rollback;
