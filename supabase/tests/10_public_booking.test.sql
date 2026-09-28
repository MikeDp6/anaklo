-- Online booking end-to-end in SQL (phase-1 plan 1.3, contract docs/plans/contracts/1.3-public-booking.md,
-- ADR-0006/0007): OTP codes and limits, grants and trusted devices, clients_for_phone,
-- book_appointment (idempotent replay, consent, phone_verified_at, never merged by phone), manage
-- links (view, slots, cancel, reschedule, change_until, many live tokens), the outbox claim and
-- send result, planner v1, next_visit_hint and short codes.
-- Every _impl is called with an explicit p_now. The Vault keys (upsert) and EVERY platform_settings
-- column are set inside this transaction: the local seed relaxes the limits, and the remote may
-- hold real keys (the rollback restores both).
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
-- Fixtures are written by the system. The client RPCs declare 'client' themselves and the setting
-- outlives the call, so the helpers below reset it to 'system' after every successful call.
select set_config('anaklo.actor_type', 'system', true);
select plan(203);

-- ---------------------------------------------------------------------------------------------
-- Helpers (pg_temp). Results of calls are kept in transaction-local settings 't.<name>'; calls
-- that may fail return 'ok' or the error: 'P0001 <code>' for domain errors, else the SQLSTATE.
-- ---------------------------------------------------------------------------------------------
create temporary table seen_tokens (token text not null);

create function pg_temp.r(a_name text)
returns jsonb
language sql
as $fn$
  select nullif(current_setting('t.' || a_name, true), '')::jsonb;
$fn$;

create function pg_temp.err(a_state text, a_message text)
returns text
language sql
immutable
as $fn$
  select case when a_state = 'P0001' then 'P0001 ' || a_message else a_state end;
$fn$;

create function pg_temp.hmac_hex(a_data text, a_key text)
returns text
language sql
immutable
as $fn$
  select encode(extensions.hmac(convert_to(a_data, 'UTF8'), convert_to(a_key, 'UTF8'), 'sha256'), 'hex');
$fn$;

create function pg_temp.sha(a_token text)
returns text
language sql
immutable
as $fn$
  select encode(sha256(convert_to(a_token, 'UTF8')), 'hex');
$fn$;

-- The two keys this test writes into Vault (≥ 32 characters).
create function pg_temp.otp_key()
returns text
language sql
immutable
as $fn$
  select 'pgtap-10-otp-hmac-key-not-a-secret-0001'::text;
$fn$;

create function pg_temp.phone_key()
returns text
language sql
immutable
as $fn$
  select 'pgtap-10-phone-hmac-key-not-a-secret-001'::text;
$fn$;

-- The phone HMAC computed independently of the migration (contract §2.2).
create function pg_temp.ph(a_e164 text)
returns text
language sql
immutable
as $fn$
  select pg_temp.hmac_hex(a_e164, pg_temp.phone_key());
$fn$;

-- Vault upsert (update when the name exists, else create); a_new_name renames the secret.
create function pg_temp.set_vault(a_name text, a_value text, a_new_name text default null)
returns void
language plpgsql
as $fn$
declare
  v_id uuid;
begin
  select s.id into v_id from vault.secrets s where s.name = a_name;
  if v_id is null then
    perform vault.create_secret(a_value, coalesce(a_new_name, a_name), 'pgTAP 10_public_booking');
  else
    perform vault.update_secret(v_id, a_value, coalesce(a_new_name, a_name), 'pgTAP 10_public_booking');
  end if;
end;
$fn$;

create function pg_temp.outcome(a_sql text)
returns text
language plpgsql
as $fn$
begin
  execute a_sql;
  return 'ok';
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- Runs one statement as an API role (optionally with JWT claims) and returns its single value,
-- '<null>', or the error.
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
    v := pg_temp.err(sqlstate, sqlerrm);
  end;
  execute 'set local role postgres';
  perform set_config('request.jwt.claims', '', true);
  return v;
end;
$fn$;

-- Tables an API role can read (anything but "permission denied" counts as open).
create function pg_temp.api_access(a_tables text[])
returns text[]
language plpgsql
as $fn$
declare
  v_role text;
  v_table text;
  v_open text[] := '{}';
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    foreach v_table in array a_tables loop
      if pg_temp.as_role(v_role, format('select count(*)::text from %s', v_table)) <> '42501' then
        v_open := v_open || (v_role || ' ' || v_table);
      end if;
    end loop;
  end loop;
  return v_open;
end;
$fn$;

-- Tables (all of public/private, or the given ones) with a row whose JSON contains a needle.
create function pg_temp.tables_containing(a_needles text[], a_tables regclass[] default null)
returns text[]
language plpgsql
as $fn$
declare
  v_table regclass;
  v_hit boolean;
  v_found text[] := '{}';
begin
  if coalesce(cardinality(a_needles), 0) = 0 then
    return array['<no needles collected>'];
  end if;
  for v_table in
    select c.oid::regclass
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'p')
      and (a_tables is null or c.oid = any (a_tables))
    order by c.oid
  loop
    execute format(
      'select exists (select 1 from %s x cross join unnest($1) as t (needle) where strpos(to_jsonb(x)::text, t.needle) > 0)',
      v_table
    ) into v_hit using a_needles;
    if v_hit then
      v_found := v_found || v_table::text;
    end if;
  end loop;
  return v_found;
end;
$fn$;

-- The claim clock: after every planner row (scheduled_for = now()) and every OTP row of this test.
create function pg_temp.clk()
returns timestamptz
language sql
stable
as $fn$
  select greatest(now(), timestamptz '2026-11-02 06:00Z') + interval '10 minutes';
$fn$;

create function pg_temp.cid(a_name text)
returns uuid
language sql
as $fn$
  select (pg_temp.r(a_name) ->> 'challenge_id')::uuid;
$fn$;

create function pg_temp.msg(a_name text)
returns uuid
language sql
as $fn$
  select (pg_temp.r(a_name) ->> 'message_id')::uuid;
$fn$;

create function pg_temp.grant_of(a_name text)
returns text
language sql
as $fn$
  select pg_temp.r(a_name) ->> 'grant';
$fn$;

create function pg_temp.td_of(a_name text)
returns text
language sql
as $fn$
  select pg_temp.r(a_name) ->> 'trusted_device_token';
$fn$;

create function pg_temp.appt(a_name text)
returns uuid
language sql
as $fn$
  select (pg_temp.r(a_name) ->> 'appointment_id')::uuid;
$fn$;

create function pg_temp.token(a_name text)
returns text
language sql
as $fn$
  select pg_temp.r(a_name) ->> 'manage_token';
$fn$;

create function pg_temp.client_of(a_name text)
returns uuid
language sql
as $fn$
  select a.client_id from public.appointments a where a.id = pg_temp.appt(a_name);
$fn$;

create function pg_temp.conf(a_name text)
returns uuid
language sql
as $fn$
  select m.id from public.messages_log m
  where m.appointment_id = pg_temp.appt(a_name) and m.template = 'booking_confirmed';
$fn$;

-- The message of an appointment with that template (one per appointment in this test).
create function pg_temp.msg_of(a_appointment uuid, a_template text)
returns uuid
language sql
as $fn$
  select m.id from public.messages_log m
  where m.appointment_id = a_appointment and m.template = a_template;
$fn$;

-- '<status>:<error>' of a message.
create function pg_temp.mstate(a_id uuid)
returns text
language sql
as $fn$
  select m.status || ':' || coalesce(m.error, '') from public.messages_log m where m.id = a_id;
$fn$;

-- Today's count of a counter (at the claim clock), 0 when there is no row.
create function pg_temp.counter(a_bucket text, a_key text)
returns integer
language sql
as $fn$
  select coalesce(max(l.count), 0) from public.rate_limits l
  where l.bucket = a_bucket and l.key = a_key and l.window_start = date_trunc('day', pg_temp.clk(), 'UTC');
$fn$;

-- Everything a read-only call must leave untouched.
create function pg_temp.digest()
returns text
language sql
as $fn$
  select md5(concat_ws('#',
    (select string_agg(to_jsonb(t)::text, ',' order by t.id) from public.booking_tokens t),
    (select string_agg(to_jsonb(a)::text, ',' order by a.id) from public.appointments a
     where a.business_id = 'b1000000-0000-4000-8000-00000000000a'),
    (select string_agg(to_jsonb(m)::text, ',' order by m.id) from public.messages_log m),
    (select count(*)::text from public.appointment_events),
    (select string_agg(to_jsonb(c)::text, ',' order by c.id) from public.otp_challenges c),
    (select string_agg(to_jsonb(d)::text, ',' order by d.id) from public.trusted_devices d),
    (select string_agg(to_jsonb(l)::text, ',' order by l.bucket, l.key, l.window_start) from public.rate_limits l)
  ));
$fn$;

create function pg_temp.start(
  a_name text, a_phone text, a_now timestamptz, a_ip text,
  a_code text default '424242',
  a_business uuid default 'b1000000-0000-4000-8000-00000000000a',
  a_starts timestamptz default '2026-11-06 07:00Z',
  a_service uuid default 'b4000000-0000-4000-8000-000000000001',
  a_staff uuid default 'b2000000-0000-4000-8000-000000000001',
  a_locale text default 'el'
)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.otp_start_impl(
    p_business_id => a_business, p_phone => a_phone, p_locale => a_locale, p_service_ids => array[a_service],
    p_staff_id => a_staff, p_starts_at => a_starts, p_ip => a_ip, p_code => a_code, p_now => a_now);
  perform set_config('t.' || a_name, coalesce(v::text, ''), true);
  return 'ok';
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- 'verified' | 'invalid:<attempts_left>' | 'expired' | 'locked' | error.
create function pg_temp.verify(a_name text, a_business uuid, a_phone text, a_challenge uuid, a_code text, a_now timestamptz)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.otp_verify_impl(
    p_business_id => a_business, p_phone => a_phone, p_challenge_id => a_challenge, p_code => a_code, p_now => a_now);
  perform set_config('t.' || a_name, coalesce(v::text, ''), true);
  insert into pg_temp.seen_tokens (token)
  select x from unnest(array[v ->> 'grant', v ->> 'trusted_device_token']) as x where x is not null;
  return concat_ws(':', v ->> 'result', v ->> 'attempts_left');
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- Several codes against one challenge, strictly in order.
create function pg_temp.verify_many(a_business uuid, a_phone text, a_challenge uuid, a_codes text[], a_now timestamptz)
returns text[]
language plpgsql
as $fn$
declare
  v_code text;
  v_out text[] := '{}';
begin
  foreach v_code in array a_codes loop
    v_out := v_out || pg_temp.verify('x', a_business, a_phone, a_challenge, v_code, a_now);
  end loop;
  return v_out;
end;
$fn$;

-- '<verified_via>:<first names in order>' or the error.
create function pg_temp.cfp(a_name text, a_business uuid, a_phone text, a_grant text, a_td text, a_now timestamptz)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.clients_for_phone_impl(
    p_business_id => a_business, p_phone => a_phone, p_grant => a_grant, p_trusted_device_token => a_td,
    p_now => a_now);
  perform set_config('t.' || a_name, coalesce(v::text, ''), true);
  return (v ->> 'verified_via') || ':' || coalesce(
    (select string_agg(e ->> 'first_name', ',' order by n)
     from jsonb_array_elements(v -> 'clients') with ordinality as x (e, n)), '');
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- book_appointment_impl. A new appointment gets created_at = p_now (book_core stamps now()), so
-- change_until is computed against the test clock.
create function pg_temp.book(
  a_name text, a_key uuid, a_phone text, a_starts timestamptz, a_now timestamptz,
  a_grant text default null, a_td text default null,
  a_client uuid default null, a_new_name text default null, a_new_locale text default 'el',
  a_box text default 'not_shown', a_policy text default 'booking-notice-2026-09-28',
  a_business uuid default 'b1000000-0000-4000-8000-00000000000a',
  a_staff uuid default 'b2000000-0000-4000-8000-000000000001',
  a_service uuid default 'b4000000-0000-4000-8000-000000000001'
)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.book_appointment_impl(
    p_business_id => a_business, p_idempotency_key => a_key, p_service_ids => array[a_service],
    p_staff_id => a_staff, p_starts_at => a_starts, p_phone => a_phone, p_client_id => a_client,
    p_new_client => case when a_new_name is null then null
                         else jsonb_build_object('full_name', a_new_name, 'locale', a_new_locale) end,
    p_grant => a_grant, p_trusted_device_token => a_td, p_marketing_box => a_box, p_policy_version => a_policy,
    p_now => a_now);
  if v ->> 'replayed' = 'false' then
    update public.appointments set created_at = a_now where id = (v ->> 'appointment_id')::uuid;
  end if;
  insert into pg_temp.seen_tokens (token) select v ->> 'manage_token' where v ->> 'manage_token' is not null;
  perform set_config('t.' || a_name, coalesce(v::text, ''), true);
  perform set_config('anaklo.actor_type', 'system', true);
  return 'ok';
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

create function pg_temp.revoke(a_business uuid, a_token text, a_now timestamptz)
returns text
language plpgsql
as $fn$
begin
  perform private.trusted_device_revoke_impl(
    p_business_id => a_business, p_trusted_device_token => a_token, p_now => a_now);
  return 'ok';
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

create function pg_temp.mview(a_name text, a_token text, a_now timestamptz)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.manage_view_impl(p_token => a_token, p_now => a_now);
  perform set_config('t.' || a_name, coalesce(v::text, ''), true);
  return 'ok';
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- The appointment id a manage token opens, or the error.
create function pg_temp.view_appt(a_token text, a_now timestamptz)
returns text
language plpgsql
as $fn$
begin
  return coalesce(private.manage_view_impl(p_token => a_token, p_now => a_now) -> 'appointment' ->> 'id', '<none>');
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- '<change_until MM-DD HH24:MI UTC> <can_cancel>', or the error.
create function pg_temp.view_flags(a_token text, a_now timestamptz)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.manage_view_impl(p_token => a_token, p_now => a_now);
  return to_char((v ->> 'change_until')::timestamptz at time zone 'UTC', 'MM-DD HH24:MI') || ' ' || (v ->> 'can_cancel');
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- '<status> <can_cancel> <can_reschedule>', or the error.
create function pg_temp.view_summary(a_token text, a_now timestamptz)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.manage_view_impl(p_token => a_token, p_now => a_now);
  return concat_ws(' ', v -> 'appointment' ->> 'status', v ->> 'can_cancel', v ->> 'can_reschedule');
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

create function pg_temp.mcancel(a_name text, a_token text, a_now timestamptz)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.manage_cancel_impl(p_token => a_token, p_now => a_now);
  perform set_config('t.' || a_name, coalesce(v::text, ''), true);
  perform set_config('anaklo.actor_type', 'system', true);
  return 'ok';
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

create function pg_temp.mmove(a_name text, a_token text, a_starts timestamptz, a_now timestamptz)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.manage_reschedule_impl(p_token => a_token, p_new_starts_at => a_starts, p_now => a_now);
  perform set_config('t.' || a_name, coalesce(v::text, ''), true);
  perform set_config('anaklo.actor_type', 'system', true);
  return 'ok';
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- Number of claimed rows (at the claim clock), or the error. Raw manage tokens are remembered.
create function pg_temp.claim(a_name text, a_ids uuid[])
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := coalesce(private.claim_messages_impl(p_ids => a_ids, p_now => pg_temp.clk()), '[]'::jsonb);
  perform set_config('t.' || a_name, v::text, true);
  insert into pg_temp.seen_tokens (token)
  select e ->> 'manage_token' from jsonb_array_elements(v) as e where e ->> 'manage_token' is not null;
  return jsonb_array_length(v)::text;
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

create function pg_temp.planner(a_appointment uuid, a_change text, a_actor text default 'system')
returns text
language plpgsql
as $fn$
begin
  perform set_config('anaklo.actor_type', a_actor, true);
  perform private.plan_messages_impl(a_appointment, a_change);
  perform set_config('anaklo.actor_type', 'system', true);
  return 'ok';
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- A phone booking by the owner of A through book_core in staff mode (actor from the JWT).
create function pg_temp.staff_book(a_name text)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  perform set_config('anaklo.actor_type', '', true);
  perform set_config('request.jwt.claims',
    '{"sub": "b0000000-0000-4000-8000-00000000000a", "role": "authenticated", "aal": "aal1"}', true);
  v := private.book_core(
    p_business_id => 'b1000000-0000-4000-8000-00000000000a', p_mode => 'staff',
    p_service_ids => array['b4000000-0000-4000-8000-000000000001']::uuid[],
    p_staff_id => 'b2000000-0000-4000-8000-000000000002', p_starts_at => '2026-11-06 12:00Z',
    p_client_id => 'b3000000-0000-4000-8000-000000000001', p_new_client => null, p_source => 'phone',
    p_verified_via => null, p_verified_phone => null, p_idempotency_key => null,
    p_allow_outside_hours => false, p_allow_buffer_overlap => false,
    p_created_by => 'b0000000-0000-4000-8000-00000000000a', p_now => '2026-11-02 06:00Z');
  perform set_config('request.jwt.claims', '', true);
  perform set_config('anaklo.actor_type', 'system', true);
  perform set_config('t.' || a_name, coalesce(v::text, ''), true);
  return 'ok';
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- '<key>:<weeks>' of next_visit_hint_impl, '<null>', or the error.
create function pg_temp.hint(a_business uuid, a_now timestamptz)
returns text
language plpgsql
as $fn$
declare
  v jsonb;
begin
  v := private.next_visit_hint_impl(p_business_id => a_business, p_now => a_now);
  if v is null or v = 'null'::jsonb then
    return '<null>';
  end if;
  return (v ->> 'key') || ':' || ((v ->> 'weeks')::numeric)::int;
exception when others then
  return pg_temp.err(sqlstate, sqlerrm);
end;
$fn$;

-- The twelve RPCs of 0005 (wrapper names; each has a private <name>_impl).
create function pg_temp.rpc_names()
returns text[]
language sql
immutable
as $fn$
  select array['book_appointment', 'claim_messages', 'clients_for_phone', 'manage_cancel', 'manage_reschedule',
               'manage_slots', 'manage_view', 'otp_start', 'otp_verify', 'public_slug_for_code',
               'record_send_result', 'trusted_device_revoke'];
$fn$;

-- ---------------------------------------------------------------------------------------------
-- Keys, limits and counters of this test (all inside the transaction).
-- ---------------------------------------------------------------------------------------------
select pg_temp.set_vault('otp_hmac_key', pg_temp.otp_key());
select pg_temp.set_vault('phone_hmac_key', pg_temp.phone_key());

update private.platform_settings
set sms_enabled = true, sms_daily_cap = 300, otp_per_phone_hour = 3, otp_per_ip_hour = 10,
    otp_per_business_day = 40, otp_resend_seconds = 60, sms_per_phone_day = 10,
    sms_per_business_day = 200, sms_otp_reserve_pct = 20, updated_at = now();

-- Counters left by earlier local runs (e2e) must not leak into the windows used here.
delete from public.rate_limits;

-- ---------------------------------------------------------------------------------------------
-- Fixture (as postgres). T0 = 2026-11-02 06:00Z (Monday, 08:00 in Athens, EET = UTC+2).
--   A 'pb-shop'   Europe/Athens, 15′ grid, 60′ notice, 60 days, cancel notice 120′, booking on
--   B 'pb-other'  the same policy, booking on, short_code 'pbothr'
--   H 'pb-hint'   barber, completed-visit history for next_visit_hint (booking off)
--   Z 'pb-closed' hair_salon (no vertical default), booking off, short_code 'pbzzzz'
--   A1 Kostas, A2 Lena (A) · B1 (B) · H1 (H); Mon–Sat 09:00–18:00 local = 07:00–16:00Z
--   Cut 30′ + 15′ buffer 13.00 (A1, A2) · Other cut 30′ 12.00 (B1)
--   Clients of A: "Γιώργος Παπάς" (Jan) and "  Μάριος Π." (Feb) share the family phone
--     +306900000305; "Γιώργος διπλός" (Dec, same phone) is merged into Γιώργος; "Βασίλης Κ."
--     +306900000304, never verified. B has its own client on +306900000305.
--   Appointments inserted directly (like seed.sql): TK Lena Tue 11-03 07:00Z · BL Kostas Wed 11-04
--     10:00Z · W1/W2/W3 Lena Thu 11-05 10:00/11:00/12:00Z by phone, created 10-20 10:00Z,
--     11-05 09:30Z and 11-05 09:30Z · W4 Lena Fri 11-06 10:00Z completed. W1–W4 carry manage
--     tokens inserted here (their raw values are known to the test).
-- Phones: P1 +306900000301 (new, Νεφέλη) · P2 …302 (never verified) · P3 …303 (Άρης) · P9 …309 ·
--   PV …304 (Βασίλης) · PF …305 (family).
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('b0000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'owner-pb@test.local', '{}', '{}', now(), now());

insert into public.businesses (id, slug, name, vertical, timezone, phone_e164, address, maps_url, theme,
                               slot_step_min, min_notice_min, max_advance_days, cancel_min_notice_min,
                               booking_enabled, allow_any_staff) values
  ('b1000000-0000-4000-8000-00000000000a', 'pb-shop', 'PB Shop', 'barber', 'Europe/Athens', '+302610000001',
   'Οδός Δοκιμής 1', 'https://maps.example.com/pb-shop', '{"primary": "#C8A15A"}', 15, 60, 60, 120, true, true),
  ('b1000000-0000-4000-8000-00000000000c', 'pb-hint', 'PB Hint', 'barber', 'Europe/Athens', null,
   null, null, '{}', 15, 60, 60, 120, false, true);

insert into public.businesses (id, slug, name, vertical, timezone, phone_e164, slot_step_min, min_notice_min,
                               max_advance_days, cancel_min_notice_min, booking_enabled, allow_any_staff, short_code) values
  ('b1000000-0000-4000-8000-00000000000b', 'pb-other', 'PB Other', 'barber', 'Europe/Athens', '+302610000002',
   15, 60, 60, 120, true, true, 'pbothr'),
  ('b1000000-0000-4000-8000-00000000000d', 'pb-closed', 'PB Closed', 'hair_salon', 'Europe/Athens', null,
   15, 60, 60, 120, false, true, 'pbzzzz');

insert into public.business_members (business_id, user_id, role, staff_id) values
  ('b1000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-00000000000a', 'owner', null);

insert into public.staff (id, business_id, display_name, sort) values
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-00000000000a', 'Kostas', 0),
  ('b2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-00000000000a', 'Lena', 1),
  ('b2000000-0000-4000-8000-0000000000b1', 'b1000000-0000-4000-8000-00000000000b', 'Other One', 0),
  ('b2000000-0000-4000-8000-0000000000c1', 'b1000000-0000-4000-8000-00000000000c', 'Hint One', 0);

insert into public.services (id, business_id, name, duration_min, buffer_after_min, price_cents, online_bookable) values
  ('b4000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-00000000000a', 'Cut', 30, 15, 1300, true),
  ('b4000000-0000-4000-8000-0000000000b1', 'b1000000-0000-4000-8000-00000000000b', 'Other cut', 30, 0, 1200, true);

insert into public.staff_services (business_id, staff_id, service_id) values
  ('b1000000-0000-4000-8000-00000000000a', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001'),
  ('b1000000-0000-4000-8000-00000000000a', 'b2000000-0000-4000-8000-000000000002', 'b4000000-0000-4000-8000-000000000001'),
  ('b1000000-0000-4000-8000-00000000000b', 'b2000000-0000-4000-8000-0000000000b1', 'b4000000-0000-4000-8000-0000000000b1');

insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
select s.business_id, s.id, d, '09:00', '18:00'
from public.staff s cross join generate_series(1, 6) d
where s.business_id in ('b1000000-0000-4000-8000-00000000000a', 'b1000000-0000-4000-8000-00000000000b');

insert into public.clients (id, business_id, full_name, phone_e164, source, created_at) values
  ('b3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-00000000000a', 'Γιώργος Παπάς', '+306900000305', 'staff', '2026-01-01Z'),
  ('b3000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-00000000000a', '  Μάριος Π.', '+306900000305', 'staff', '2026-02-01Z'),
  ('b3000000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-00000000000a', 'Βασίλης Κ.', '+306900000304', 'staff', '2026-03-01Z'),
  ('b3000000-0000-4000-8000-0000000000b1', 'b1000000-0000-4000-8000-00000000000b', 'Άλλος Πελάτης', '+306900000305', 'staff', '2026-01-01Z');

insert into public.clients (id, business_id, full_name, phone_e164, source, merged_into_id, created_at) values
  ('b3000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-00000000000a', 'Γιώργος διπλός', '+306900000305', 'staff',
   'b3000000-0000-4000-8000-000000000001', '2025-12-01Z');

insert into public.appointments (id, business_id, client_id, staff_id, starts_at, ends_at, buffer_after_min, total_cents,
                                 charged_cents, status, source, created_at) values
  ('b5000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-00000000000a', null, 'b2000000-0000-4000-8000-000000000002',
   '2026-11-03 07:00Z', '2026-11-03 07:30Z', 0, 1300, null, 'booked', 'phone', '2026-10-01Z'),
  ('b5000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-00000000000a', null, 'b2000000-0000-4000-8000-000000000001',
   '2026-11-04 10:00Z', '2026-11-04 10:30Z', 0, 1300, null, 'booked', 'phone', '2026-10-01Z'),
  ('b5000000-0000-4000-8000-000000000011', 'b1000000-0000-4000-8000-00000000000a', 'b3000000-0000-4000-8000-000000000001',
   'b2000000-0000-4000-8000-000000000002', '2026-11-05 10:00Z', '2026-11-05 10:30Z', 15, 1300, null, 'booked', 'phone', '2026-10-20 10:00Z'),
  ('b5000000-0000-4000-8000-000000000012', 'b1000000-0000-4000-8000-00000000000a', 'b3000000-0000-4000-8000-000000000001',
   'b2000000-0000-4000-8000-000000000002', '2026-11-05 11:00Z', '2026-11-05 11:30Z', 15, 1300, null, 'booked', 'phone', '2026-11-05 09:30Z'),
  ('b5000000-0000-4000-8000-000000000013', 'b1000000-0000-4000-8000-00000000000a', 'b3000000-0000-4000-8000-000000000001',
   'b2000000-0000-4000-8000-000000000002', '2026-11-05 12:00Z', '2026-11-05 12:30Z', 15, 1300, null, 'booked', 'phone', '2026-11-05 09:30Z'),
  ('b5000000-0000-4000-8000-000000000014', 'b1000000-0000-4000-8000-00000000000a', 'b3000000-0000-4000-8000-000000000001',
   'b2000000-0000-4000-8000-000000000002', '2026-11-06 10:00Z', '2026-11-06 10:30Z', 15, 1300, 1300, 'completed', 'phone', '2026-10-01Z');

insert into public.appointment_services (business_id, appointment_id, position, service_id, price_cents, duration_min)
select 'b1000000-0000-4000-8000-00000000000a', a.id, 0, 'b4000000-0000-4000-8000-000000000001', 1300, 30
from public.appointments a
where a.business_id = 'b1000000-0000-4000-8000-00000000000a';

-- Manage tokens of the directly inserted appointments (raw values known to the test, 22 chars).
insert into public.booking_tokens (id, business_id, appointment_id, token_hash, issued_for, created_at, expires_at) values
  (gen_random_uuid(), 'b1000000-0000-4000-8000-00000000000a', 'b5000000-0000-4000-8000-000000000011',
   pg_temp.sha('pgtapW1tokenAAAAAAAAAA'), 'booking', '2026-10-20 10:00Z', '2027-12-01Z'),
  (gen_random_uuid(), 'b1000000-0000-4000-8000-00000000000a', 'b5000000-0000-4000-8000-000000000011',
   pg_temp.sha('pgtapW1expiryAAAAAAAAA'), 'booking', '2026-10-20 10:00Z', '2026-11-04 00:00Z'),
  (gen_random_uuid(), 'b1000000-0000-4000-8000-00000000000a', 'b5000000-0000-4000-8000-000000000012',
   pg_temp.sha('pgtapW2tokenAAAAAAAAAA'), 'booking', '2026-11-05 09:30Z', '2027-12-01Z'),
  (gen_random_uuid(), 'b1000000-0000-4000-8000-00000000000a', 'b5000000-0000-4000-8000-000000000013',
   pg_temp.sha('pgtapW3tokenAAAAAAAAAA'), 'booking', '2026-11-05 09:30Z', '2027-12-01Z'),
  (gen_random_uuid(), 'b1000000-0000-4000-8000-00000000000a', 'b5000000-0000-4000-8000-000000000014',
   pg_temp.sha('pgtapW4tokenAAAAAAAAAA'), 'booking', '2026-10-01Z', '2027-12-01Z');

-- H: 49 clients with two completed visits each (25 × 35 days, 24 × 49 days, all May–Aug 2026, no
-- DST change in between), plus visits that must NOT count:
--   101 5 days apart (< 7) · 102 200 days apart (> 180) · 103 later visit 2025-10-01 (older than
--   365 days) · 104 the second visit is cancelled · 105 erased client · 106 merged client ·
--   107 later visit after p_now (2026-11-24).
insert into public.clients (id, business_id, full_name, source)
select ('b6000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'b1000000-0000-4000-8000-00000000000c',
       'Hint client ' || i, 'staff'
from generate_series(1, 49) i;

insert into public.clients (id, business_id, full_name, source, erased_at, merged_into_id) values
  ('b6000000-0000-4000-8000-000000000101', 'b1000000-0000-4000-8000-00000000000c', 'Noise short', 'staff', null, null),
  ('b6000000-0000-4000-8000-000000000102', 'b1000000-0000-4000-8000-00000000000c', 'Noise long', 'staff', null, null),
  ('b6000000-0000-4000-8000-000000000103', 'b1000000-0000-4000-8000-00000000000c', 'Noise old', 'staff', null, null),
  ('b6000000-0000-4000-8000-000000000104', 'b1000000-0000-4000-8000-00000000000c', 'Noise cancelled', 'staff', null, null),
  ('b6000000-0000-4000-8000-000000000105', 'b1000000-0000-4000-8000-00000000000c', '', 'staff', now(), null),
  ('b6000000-0000-4000-8000-000000000106', 'b1000000-0000-4000-8000-00000000000c', 'Noise merged', 'staff', null,
   'b6000000-0000-4000-8000-000000000001'),
  ('b6000000-0000-4000-8000-000000000107', 'b1000000-0000-4000-8000-00000000000c', 'Noise future', 'staff', null, null);

insert into public.appointments (business_id, client_id, staff_id, starts_at, ends_at, status, source, total_cents, charged_cents)
select 'b1000000-0000-4000-8000-00000000000c', ('b6000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
       'b2000000-0000-4000-8000-0000000000c1', v.s, v.s + interval '30 minutes', 'completed', 'phone', 1000, 1000
from generate_series(1, 49) i
cross join lateral (values
  (timestamptz '2026-05-04 08:00Z' + make_interval(days => i)),
  (timestamptz '2026-05-04 08:00Z' + make_interval(days => i + case when i <= 25 then 35 else 49 end))
) as v (s);

insert into public.appointments (business_id, client_id, staff_id, starts_at, ends_at, status, source, total_cents,
                                 charged_cents, cancelled_by, cancel_reason)
select 'b1000000-0000-4000-8000-00000000000c', n.client_id, 'b2000000-0000-4000-8000-0000000000c1', n.s,
       n.s + interval '30 minutes', n.status, 'phone', 1000,
       case when n.status = 'completed' then 1000 end,
       case when n.status = 'cancelled' then 'client' end,
       case when n.status = 'cancelled' then 'client_request' end
from (values
  ('b6000000-0000-4000-8000-000000000101'::uuid, timestamptz '2026-06-01 08:00Z', 'completed'),
  ('b6000000-0000-4000-8000-000000000101', '2026-06-06 08:00Z', 'completed'),
  ('b6000000-0000-4000-8000-000000000102', '2026-01-05 08:00Z', 'completed'),
  ('b6000000-0000-4000-8000-000000000102', '2026-07-24 08:00Z', 'completed'),
  ('b6000000-0000-4000-8000-000000000103', '2025-08-27 08:00Z', 'completed'),
  ('b6000000-0000-4000-8000-000000000103', '2025-10-01 08:00Z', 'completed'),
  ('b6000000-0000-4000-8000-000000000104', '2026-06-01 09:00Z', 'completed'),
  ('b6000000-0000-4000-8000-000000000104', '2026-07-06 09:00Z', 'cancelled'),
  ('b6000000-0000-4000-8000-000000000105', '2026-06-01 10:00Z', 'completed'),
  ('b6000000-0000-4000-8000-000000000105', '2026-07-06 10:00Z', 'completed'),
  ('b6000000-0000-4000-8000-000000000106', '2026-06-01 11:00Z', 'completed'),
  ('b6000000-0000-4000-8000-000000000106', '2026-07-06 11:00Z', 'completed'),
  ('b6000000-0000-4000-8000-000000000107', '2026-10-20 08:00Z', 'completed'),
  ('b6000000-0000-4000-8000-000000000107', '2026-11-24 08:00Z', 'completed')
) as n (client_id, s, status);

-- =============================================================================================
-- Shape
-- =============================================================================================
select is(
  (select count(*) from private.platform_settings),
  1::bigint,
  'platform_settings is a single row'
);

select is(
  (select v.rebook_interval_days::integer from private.vertical_defaults v where v.vertical = 'barber'),
  28,
  'vertical_defaults: barber rebooks every 28 days (= packages/verticals/barber.json)'
);

select is(
  array[
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private' and p.prosecdef
       and p.proname = any (select x || '_impl' from unnest(pg_temp.rpc_names()) x)),
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     join pg_language l on l.oid = p.prolang
     where n.nspname = 'public' and not p.prosecdef and l.lanname = 'sql' and p.proname = any (pg_temp.rpc_names()))
  ],
  array[12, 12]::bigint[],
  'the twelve RPCs: SECURITY DEFINER _impl in private, thin SQL invoker wrapper in public'
);

select is(
  (select array_agg(n.nspname || '.' || p.proname || ':' || p.provolatile::text order by n.nspname, p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname = 'public' and p.proname in ('clients_for_phone', 'manage_slots', 'manage_view', 'public_slug_for_code'))
      or (n.nspname = 'private' and p.proname in ('clients_for_phone_impl', 'manage_slots_impl', 'manage_view_impl',
                                                  'public_slug_for_code_impl'))),
  array[
    'private.clients_for_phone_impl:s', 'private.manage_slots_impl:s', 'private.manage_view_impl:s',
    'private.public_slug_for_code_impl:s',
    'public.clients_for_phone:s', 'public.manage_slots:s', 'public.manage_view:s', 'public.public_slug_for_code:s'
  ],
  'the read-only RPCs are STABLE (clients_for_phone cannot consume a grant, manage_view cannot write)'
);

-- =============================================================================================
-- API roles: the new tables only through RPCs; the service_role RPCs only for service_role
-- =============================================================================================
select is(
  pg_temp.api_access(array[
    'public.otp_challenges', 'public.trusted_devices', 'public.booking_tokens', 'public.messages_log',
    'public.rate_limits', 'public.suppression_list', 'private.platform_settings', 'private.vertical_defaults'
  ]),
  '{}'::text[],
  'no API role (anon, authenticated, service_role) can read any of the new tables: permission denied'
);

select is(
  pg_temp.as_role('anon',
    $$select public.otp_start('b1000000-0000-4000-8000-00000000000a', '+306900000302', 'el',
        array['b4000000-0000-4000-8000-000000000001']::uuid[], 'b2000000-0000-4000-8000-000000000001',
        '2026-11-06 07:00Z', '198.51.100.99')::text$$),
  '42501',
  'anon cannot start an OTP (only the Edge Function, as service_role)'
);

select is(
  pg_temp.as_role('authenticated',
    $$select public.book_appointment('b1000000-0000-4000-8000-00000000000a', 'b9000000-0000-4000-8000-0000000000ff',
        array['b4000000-0000-4000-8000-000000000001']::uuid[], 'b2000000-0000-4000-8000-000000000001',
        '2026-11-06 07:00Z', '+306900000302', null, null, null, null, 'not_shown', 'x')::text$$,
    '{"sub": "b0000000-0000-4000-8000-00000000000a", "role": "authenticated", "aal": "aal1"}'),
  '42501',
  'authenticated cannot call book_appointment, not even the owner'
);

select is(
  pg_temp.as_role('service_role',
    $$select public.clients_for_phone('b1000000-0000-4000-8000-00000000000a', '+306900000302', null, null)::text$$),
  'P0001 AN014',
  'service_role reaches clients_for_phone through the wrapper (and without proof gets AN014)'
);

-- =============================================================================================
-- short_code and public_slug_for_code
-- =============================================================================================
select is(
  (select (short_code ~ '^[a-z0-9]{6}$')::text from public.businesses where id = 'b1000000-0000-4000-8000-00000000000a')
  || ' ' || (select short_code from public.businesses where id = 'b1000000-0000-4000-8000-00000000000b'),
  'true pbothr',
  'short_code: generated (6 × a-z0-9) when absent, kept when given'
);

select is(
  pg_temp.as_role('anon', format('select public.public_slug_for_code(%L)',
    (select upper(short_code) from public.businesses where id = 'b1000000-0000-4000-8000-00000000000a'))),
  'pb-shop',
  'public_slug_for_code (anon): the short code resolves to the slug, case-insensitively'
);

select is(
  array[coalesce(private.public_slug_for_code_impl(p_code => 'pbzzzz'), '<null>'),
        coalesce(private.public_slug_for_code_impl(p_code => 'zz9zz9'), '<null>')],
  array['<null>', '<null>'],
  'public_slug_for_code: null for a business with booking off and for an unknown code'
);

select is(
  pg_temp.outcome($$insert into public.businesses (slug, name, vertical, timezone, short_code)
                    values ('pb-dup', 'Dup', 'barber', 'Europe/Athens', 'pbothr')$$),
  '23505',
  'short_code is unique'
);

select is(
  pg_temp.as_role('authenticated',
    $$update public.businesses set short_code = 'hacked' where id = 'b1000000-0000-4000-8000-00000000000a' returning short_code$$,
    '{"sub": "b0000000-0000-4000-8000-00000000000a", "role": "authenticated", "aal": "aal1"}'),
  '42501',
  'short_code: not even the owner can change it (no column grant)'
);

-- =============================================================================================
-- otp_start: challenge, code as HMAC, message, counters
-- =============================================================================================
select is(
  pg_temp.start('c1', '+306900000301', '2026-11-02 06:00Z', '198.51.100.11'),
  'ok',
  'start: a new number gets a challenge'
);

select is(
  (select concat_ws(' | ', (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(r) k),
                    r ->> 'code',
                    to_char((r ->> 'expires_at')::timestamptz at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
                    to_char((r ->> 'resend_at')::timestamptz at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
   from pg_temp.r('c1') r),
  'challenge_id,code,expires_at,message_id,resend_at | 424242 | 2026-11-02 06:05:00 | 2026-11-02 06:01:00',
  'start: returns the challenge, the message, the code (to service_role only), expiry at +5′ and resend at +60″'
);

select is(
  (select concat_ws(' | ', (c.business_id = 'b1000000-0000-4000-8000-00000000000a')::text,
                    (c.phone_hmac = pg_temp.ph('+306900000301'))::text,
                    (c.code_hmac = pg_temp.hmac_hex(c.id::text || ':424242', pg_temp.otp_key()))::text,
                    c.attempts::text, coalesce(c.verified_at::text, 'null'), coalesce(c.grant_hash, 'null'),
                    to_char(c.expires_at at time zone 'UTC', 'HH24:MI:SS'))
   from public.otp_challenges c where c.id = pg_temp.cid('c1')),
  'true | true | true | 0 | null | null | 06:05:00',
  'start: phone and code are stored only as HMACs (Vault keys; the code bound to the challenge id)'
);

select is(
  private.phone_hmac('+306900000301'),
  pg_temp.ph('+306900000301'),
  'private.phone_hmac is HMAC-SHA256 with the Vault key phone_hmac_key'
);

select is(
  (select concat_ws(' | ', m.channel, m.template, m.category, m.status, m.to_e164, m.locale,
                    coalesce(m.client_id::text, 'null'), coalesce(m.appointment_id::text, 'null'),
                    (m.otp_challenge_id = pg_temp.cid('c1'))::text,
                    (m.dedupe_key = 'otp:' || pg_temp.cid('c1'))::text,
                    to_char(m.scheduled_for at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), m.attempts::text)
   from public.messages_log m where m.id = pg_temp.msg('c1')),
  'sms | otp | otp | queued | +306900000301 | el | null | null | true | true | 2026-11-02 06:00 | 0',
  'start: one queued OTP SMS, no client, deduplicated per challenge, scheduled at p_now'
);

select is(
  (select string_agg(l.bucket || ':' || to_char(l.window_start at time zone 'UTC', 'MM-DD HH24:MI') || ':' || l.count,
                     ', ' order by l.bucket collate "C")
   from public.rate_limits l
   where (l.bucket = 'otp_phone_hour' and l.key = pg_temp.ph('+306900000301'))
      or (l.bucket = 'otp_ip_hour' and l.key = pg_temp.hmac_hex('ip:198.51.100.11', pg_temp.phone_key()))
      or (l.bucket = 'otp_business_day' and l.key = 'b1000000-0000-4000-8000-00000000000a')
      or (l.bucket = 'sms_platform_day' and l.count > 0)),
  'otp_business_day:11-02 00:00:1, otp_ip_hour:11-02 06:00:1, otp_phone_hour:11-02 06:00:1',
  'start: +1 on the phone hour, IP hour (both HMAC keys) and business day (UTC windows); SMS count at claim, not here'
);

select is(
  pg_temp.start('crand', '+306900000309', '2026-11-02 06:00Z', '198.51.100.19', a_code => null, a_locale => 'en'),
  'ok',
  'start: without a test code'
);

select is(
  (select concat_ws(' | ', ((r ->> 'code') ~ '^[0-9]{6}$')::text,
                    (c.code_hmac = pg_temp.hmac_hex(c.id::text || ':' || (r ->> 'code'), pg_temp.otp_key()))::text,
                    (select count(*) from jsonb_each_text(to_jsonb(c)) e
                     where strpos(e.value, r ->> 'code') > 0 and e.value !~ '^[0-9a-f]{64}$' and e.value !~ '^[0-9a-f-]{36}$'),
                    (select count(*) from jsonb_each_text(to_jsonb(m)) e
                     where e.key <> 'to_e164' and strpos(e.value, r ->> 'code') > 0
                       and e.value !~ '^[0-9a-f]{64}$' and e.value !~ '^[0-9a-f-]{36}$'),
                    m.locale)
   from pg_temp.r('crand') r
   join public.otp_challenges c on c.id = (r ->> 'challenge_id')::uuid
   join public.messages_log m on m.id = (r ->> 'message_id')::uuid),
  'true | true | 0 | 0 | en',
  'start: SQL draws a random 6-digit code, stored nowhere in plaintext; the SMS goes in the page language'
);

-- =============================================================================================
-- otp_start: refusals (nothing is written before the last step)
-- =============================================================================================
select is(
  pg_temp.start('x', '+302610000099', '2026-11-02 06:00Z', '198.51.100.20'),
  'P0001 AN018',
  'start: a Greek landline is refused (AN018)'
);

select is(
  pg_temp.start('x', '+447700900123', '2026-11-02 06:00Z', '198.51.100.20'),
  'P0001 AN018',
  'start: a foreign mobile is refused (AN018)'
);

select is(
  pg_temp.start('x', '+30690000030', '2026-11-02 06:00Z', '198.51.100.20'),
  'P0001 AN018',
  'start: a +3069 number of the wrong length is refused (AN018)'
);

select is(
  pg_temp.start('x', '+306900000310', '2026-11-02 06:00Z', '198.51.100.20', a_locale => 'de'),
  '22023',
  'start: an unknown locale is an invalid argument (22023)'
);

select is(
  pg_temp.start('x', '+306900000311', '2026-11-02 06:00Z', '198.51.100.20', a_code => '12345'),
  '22023',
  'start: a test code that is not 6 digits is an invalid argument (22023)'
);

select is(
  pg_temp.start('x', '+306900000312', '2026-11-02 06:00Z', '198.51.100.20', a_business => 'b1000000-0000-4000-8000-00000000000d'),
  'P0001 AN009',
  'start: a business with online booking off → AN009'
);

select is(
  pg_temp.start('x', '+306900000313', '2026-11-02 06:00Z', '198.51.100.20', a_service => 'b4000000-0000-4000-8000-0000000000b1'),
  'P0001 AN003',
  'start: a service of another business → AN003'
);

select is(
  pg_temp.start('x', '+306900000314', '2026-11-02 06:00Z', '198.51.100.20',
                a_starts => '2026-11-03 07:00Z', a_staff => 'b2000000-0000-4000-8000-000000000002'),
  'P0001 AN001',
  'start: a time that is no longer free → AN001, before any SMS'
);

update private.platform_settings set sms_enabled = false;

select is(
  pg_temp.start('x', '+306900000315', '2026-11-02 06:00Z', '198.51.100.21'),
  'P0001 AN017',
  'start: the platform kill switch stops every OTP (AN017)'
);

update private.platform_settings set sms_enabled = true;

select is(
  (select count(*) from public.messages_log
   where to_e164 in ('+302610000099', '+447700900123', '+30690000030', '+306900000310', '+306900000311',
                     '+306900000312', '+306900000313', '+306900000314', '+306900000315'))
  + (select count(*) from public.otp_challenges
     where phone_hmac in (select pg_temp.ph(p) from unnest(array[
       '+302610000099', '+447700900123', '+30690000030', '+306900000310', '+306900000311',
       '+306900000312', '+306900000313', '+306900000314', '+306900000315']) p)),
  0::bigint,
  'refused starts write nothing: no challenge and no SMS'
);

-- Cooldown (60″) and the per-phone hour (3). P1 has c1 in A at 06:00:00.
select is(
  pg_temp.start('x', '+306900000301', '2026-11-02 06:00:59Z', '198.51.100.11'),
  'P0001 AN019',
  'start: a new code for the same phone within 60″ → AN019'
);

select is(
  pg_temp.start('cb1', '+306900000301', '2026-11-02 06:00:10Z', '198.51.100.11',
                a_business => 'b1000000-0000-4000-8000-00000000000b', a_service => 'b4000000-0000-4000-8000-0000000000b1',
                a_staff => 'b2000000-0000-4000-8000-0000000000b1'),
  'ok',
  'start: the cooldown is per business (the same phone starts in B 10″ later)'
);

select is(
  pg_temp.start('c2', '+306900000301', '2026-11-02 06:01:00Z', '198.51.100.11'),
  'ok',
  'start: a new code after exactly 60″'
);

select is(
  pg_temp.start('x', '+306900000301', '2026-11-02 06:02:00Z', '198.51.100.11'),
  'P0001 AN013',
  'start: the 4th code for one phone within the UTC hour → AN013 (counted across businesses)'
);

select is(
  (select l.count from public.rate_limits l
   where l.bucket = 'otp_phone_hour' and l.key = pg_temp.ph('+306900000301') and l.window_start = '2026-11-02 06:00Z'),
  3,
  'start: a refused start does not count'
);

select is(
  pg_temp.start('c3', '+306900000301', '2026-11-02 07:00Z', '198.51.100.11'),
  'ok',
  'start: the phone window is the UTC hour: at 07:00 the phone starts again'
);

-- otp_resend_seconds = 0 (the local seed) switches the cooldown off, also for a start whose clock
-- is older than a challenge committed meanwhile (a concurrent start that waited on the phone lock).
update private.platform_settings set otp_resend_seconds = 0;

select is(
  array[
    pg_temp.start('x', '+306900000331', '2026-11-02 06:30:05Z', '198.51.100.31',
                  a_business => 'b1000000-0000-4000-8000-00000000000b', a_service => 'b4000000-0000-4000-8000-0000000000b1',
                  a_staff => 'b2000000-0000-4000-8000-0000000000b1'),
    pg_temp.start('x', '+306900000331', '2026-11-02 06:30:00Z', '198.51.100.31',
                  a_business => 'b1000000-0000-4000-8000-00000000000b', a_service => 'b4000000-0000-4000-8000-0000000000b1',
                  a_staff => 'b2000000-0000-4000-8000-0000000000b1')],
  array['ok', 'ok'],
  'start: a cooldown of 0 is no cooldown, even against a newer challenge committed meanwhile'
);

update private.platform_settings set otp_resend_seconds = 60;

-- Windows already used up, fabricated straight into rate_limits.
insert into public.rate_limits (bucket, key, window_start, count) values
  ('otp_ip_hour', pg_temp.hmac_hex('ip:192.0.2.50', pg_temp.phone_key()), '2026-11-02 06:00Z', 10),
  ('otp_ip_hour', pg_temp.hmac_hex('ip:unknown', pg_temp.phone_key()), '2026-11-02 06:00Z', 10);

select is(
  pg_temp.start('x', '+306900000321', '2026-11-02 06:20Z', '192.0.2.50'),
  'P0001 AN013',
  'start: 10 codes from one IP within the UTC hour → AN013'
);

select is(
  pg_temp.start('x', '+306900000322', '2026-11-02 06:20Z', null),
  'P0001 AN013',
  'start: a missing IP counts as "unknown" (one shared bucket)'
);

insert into public.rate_limits (bucket, key, window_start, count)
values ('otp_business_day', 'b1000000-0000-4000-8000-00000000000b', '2026-11-02 00:00Z', 40)
on conflict (bucket, key, window_start) do update set count = excluded.count;

select is(
  pg_temp.start('x', '+306900000324', '2026-11-02 06:20Z', '198.51.100.24',
                a_business => 'b1000000-0000-4000-8000-00000000000b', a_service => 'b4000000-0000-4000-8000-0000000000b1',
                a_staff => 'b2000000-0000-4000-8000-0000000000b1'),
  'P0001 AN017',
  'start: 40 codes of one business within the UTC day → AN017'
);

select is(
  pg_temp.start('cb24', '+306900000324', '2026-11-03 00:30Z', '198.51.100.24',
                a_business => 'b1000000-0000-4000-8000-00000000000b', a_service => 'b4000000-0000-4000-8000-0000000000b1',
                a_staff => 'b2000000-0000-4000-8000-0000000000b1'),
  'ok',
  'start: the business window is the UTC day: the next day B sends again'
);

insert into public.rate_limits (bucket, key, window_start, count)
values ('sms_platform_day', 'platform', '2026-11-02 00:00Z', 300)
on conflict (bucket, key, window_start) do update set count = excluded.count;

select is(
  pg_temp.start('x', '+306900000323', '2026-11-02 06:20Z', '198.51.100.23'),
  'P0001 AN017',
  'start: the platform SMS cap of the UTC day is reached → AN017'
);

update public.rate_limits set count = 299
where bucket = 'sms_platform_day' and key = 'platform' and window_start = '2026-11-02 00:00Z';

select is(
  pg_temp.start('c23', '+306900000323', '2026-11-02 06:20Z', '198.51.100.23'),
  'ok',
  'start: one below the platform cap a code is sent'
);

delete from public.rate_limits where bucket = 'sms_platform_day';

-- =============================================================================================
-- otp_verify (never raises for the code outcome)
-- =============================================================================================
select is(
  pg_temp.verify('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000301', pg_temp.cid('c1'), '000000', '2026-11-02 06:01Z'),
  'invalid:4',
  'verify: a wrong code → invalid, 4 attempts left'
);

select is(
  pg_temp.verify('x', 'b1000000-0000-4000-8000-00000000000b', '+306900000301', pg_temp.cid('c1'), '424242', '2026-11-02 06:01Z'),
  'expired',
  'verify: a challenge of A verified in B is refused (expired, no grant)'
);

select is(
  pg_temp.verify('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000302', pg_temp.cid('c1'), '424242', '2026-11-02 06:01Z'),
  'expired',
  'verify: the challenge of one phone cannot verify another phone'
);

select is(
  pg_temp.verify('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000301', pg_temp.cid('c1'), '424242', '2026-11-02 06:05Z'),
  'expired',
  'verify: the code expires at +5′'
);

select is(
  (select c.attempts::integer from public.otp_challenges c where c.id = pg_temp.cid('c1')),
  1,
  'verify: calls for another business, another phone or after expiry count no attempt'
);

select is(
  pg_temp.verify('v1', 'b1000000-0000-4000-8000-00000000000a', '+306900000301', pg_temp.cid('c1'), '424242', '2026-11-02 06:04:59Z'),
  'verified',
  'verify: the right code within 5′ verifies'
);

select is(
  (select concat_ws(' | ', ((r ->> 'grant') ~ '^[A-Za-z0-9_-]{43}$')::text,
                    ((r ->> 'trusted_device_token') ~ '^[A-Za-z0-9_-]{43}$')::text,
                    ((r ->> 'grant') <> (r ->> 'trusted_device_token'))::text,
                    to_char((r ->> 'grant_expires_at')::timestamptz at time zone 'UTC', 'HH24:MI:SS'))
   from pg_temp.r('v1') r),
  'true | true | true | 06:14:59',
  'verify: a 256-bit grant (valid 10′) and a separate 256-bit trusted-device token'
);

select is(
  (select concat_ws(' | ', to_char(c.verified_at at time zone 'UTC', 'HH24:MI:SS'),
                    (c.grant_hash = pg_temp.sha(pg_temp.grant_of('v1')))::text,
                    to_char(c.grant_expires_at at time zone 'UTC', 'HH24:MI:SS'), coalesce(c.grant_used_at::text, 'null'))
   from public.otp_challenges c where c.id = pg_temp.cid('c1')),
  '06:04:59 | true | 06:14:59 | null',
  'verify: the challenge keeps only the sha256 of the grant'
);

select is(
  (select concat_ws(' | ', count(*), bool_and(d.phone_hmac = pg_temp.ph('+306900000301'))::text,
                    bool_and(d.revoked_at is null)::text,
                    bool_and(d.expires_at = timestamptz '2026-11-02 06:04:59Z' + interval '180 days')::text)
   from public.trusted_devices d
   where d.business_id = 'b1000000-0000-4000-8000-00000000000a' and d.token_hash = pg_temp.sha(pg_temp.td_of('v1'))),
  '1 | true | true | true',
  'verify: one trusted device for (A, phone HMAC), stored as sha256, fixed 180 days'
);

select is(
  pg_temp.verify('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000301', pg_temp.cid('c1'), '424242', '2026-11-02 06:04:59.5Z'),
  'expired',
  'verify: a verified challenge cannot be used again, even before it expires'
);

select is(
  pg_temp.verify_many('b1000000-0000-4000-8000-00000000000a', '+306900000301', pg_temp.cid('c2'),
                      array['000000', '12345', '999999', '111111', '222222', '424242'], '2026-11-02 06:02Z'),
  array['invalid:4', 'invalid:3', 'invalid:2', 'invalid:1', 'locked', 'locked'],
  'verify: 4 wrong codes (one malformed) leave 4…1 attempts, the 5th locks, the 6th is refused even when right'
);

select is(
  (select concat_ws(' | ', c.attempts, coalesce(c.verified_at::text, 'null'), coalesce(c.grant_hash, 'null'))
   from public.otp_challenges c where c.id = pg_temp.cid('c2')),
  '5 | null | null',
  'verify: the locked challenge counted 5 attempts and issued nothing'
);

-- =============================================================================================
-- Grants, trusted devices and clients_for_phone
-- =============================================================================================
select is(
  pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000301', pg_temp.grant_of('v1'), null, '2026-11-02 06:06Z'),
  'otp:',
  'clients_for_phone: a live grant proves the phone (a new number has no clients)'
);

select is(
  pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000301', pg_temp.grant_of('v1'), null, '2026-11-02 06:06:30Z'),
  'otp:',
  'clients_for_phone: the same grant works again'
);

select is(
  (select c.grant_used_at from public.otp_challenges c where c.id = pg_temp.cid('c1')),
  null::timestamptz,
  'clients_for_phone does not consume the grant'
);

select is(
  pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000301', null, null, '2026-11-02 06:06Z'),
  'P0001 AN014',
  'clients_for_phone without a grant or a trusted device → AN014'
);

select is(
  pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000301', repeat('A', 43), null, '2026-11-02 06:06Z'),
  'P0001 AN014',
  'clients_for_phone with an unknown grant → AN014'
);

select is(
  pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000b', '+306900000301', pg_temp.grant_of('v1'), null, '2026-11-02 06:06Z'),
  'P0001 AN014',
  'a grant of A is not valid in B'
);

select is(
  pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000302', pg_temp.grant_of('v1'), null, '2026-11-02 06:06Z'),
  'P0001 AN014',
  'a grant is not valid for another phone'
);

select is(
  pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000301', pg_temp.grant_of('v1'), null, '2026-11-02 06:14:59Z'),
  'P0001 AN014',
  'a grant expires 10′ after verification'
);

select is(
  pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000301', null, pg_temp.td_of('v1'), '2026-11-02 06:06Z'),
  'trusted_device:',
  'clients_for_phone: a valid trusted device proves the phone'
);

select is(
  pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000301', pg_temp.grant_of('v1'), pg_temp.td_of('v1'),
              '2026-11-02 06:06Z'),
  'otp:',
  'a live grant takes precedence over the trusted device'
);

select is(
  pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000b', '+306900000301', null, pg_temp.td_of('v1'), '2026-11-02 06:06Z'),
  'P0001 AN014',
  'a trusted device of A is not valid in B'
);

select is(
  pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000302', null, pg_temp.td_of('v1'), '2026-11-02 06:06Z'),
  'P0001 AN014',
  'a trusted device is bound to its phone'
);

select is(
  pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000d', '+306900000301', pg_temp.grant_of('v1'), null, '2026-11-02 06:06Z'),
  'P0001 AN009',
  'clients_for_phone in a business with online booking off → AN009'
);

-- =============================================================================================
-- book_appointment with the OTP grant; replay
-- =============================================================================================
select is(
  pg_temp.book('b1', 'b9000000-0000-4000-8000-000000000001', '+306900000301', '2026-11-03 07:00Z', '2026-11-02 06:07Z',
               a_grant => pg_temp.grant_of('v1'), a_new_name => 'Νεφέλη Κ.', a_box => 'unchecked'),
  'ok',
  'book: a new client books with the OTP grant'
);

select is(
  (select concat_ws(' | ', r ->> 'staff_id', to_char((r ->> 'starts_at')::timestamptz at time zone 'UTC', 'MM-DD HH24:MI'),
                    to_char((r ->> 'ends_at')::timestamptz at time zone 'UTC', 'HH24:MI'), r ->> 'total_cents',
                    r ->> 'replayed', r ->> 'verified_via', ((r ->> 'manage_token') ~ '^[A-Za-z0-9_-]{22}$')::text,
                    (r -> 'next_visit_hint' ->> 'key') || ':' || ((r -> 'next_visit_hint' ->> 'weeks')::numeric)::integer)
   from pg_temp.r('b1') r),
  'b2000000-0000-4000-8000-000000000001 | 11-03 07:00 | 07:30 | 1300 | false | otp | true | nextVisit.vertical:4',
  'book: staff, times, server price, replayed = false, verified_via otp, a 22-character manage token, the vertical hint'
);

select is(
  (select concat_ws(' | ', a.source, a.verified_via, a.status, c.full_name, c.phone_e164, c.source, c.locale,
                    (c.phone_verified_at = '2026-11-02 06:07Z')::text)
   from public.appointments a join public.clients c on c.business_id = a.business_id and c.id = a.client_id
   where a.id = pg_temp.appt('b1')),
  'online | otp | booked | Νεφέλη Κ. | +306900000301 | online | el | true',
  'book (OTP): the new client gets the verified phone and phone_verified_at = the booking time'
);

select is(
  (select concat_ws(' | ', (c.grant_used_at = '2026-11-02 06:07Z')::text, (c.grant_appointment_id = pg_temp.appt('b1'))::text)
   from public.otp_challenges c where c.id = pg_temp.cid('c1')),
  'true | true',
  'book: the grant is consumed and bound to the appointment it booked'
);

select is(
  (select string_agg(concat_ws(':', k.purpose, k.legal_basis, k.granted::text, k.source, k.policy_version, k.given_by,
                               coalesce(k.created_by::text, 'null')), ', ')
   from public.client_consents k where k.client_id = pg_temp.client_of('b1')),
  'marketing_sms:soft_opt_in:true:booking_form:booking-notice-2026-09-28:client:null',
  'book: the refusal box shown and left unchecked records a soft opt-in from booking_form with the notice version'
);

select is(
  (select concat_ws(' | ', count(*), min(t.issued_for), bool_and(t.revoked_at is null)::text,
                    bool_and(t.expires_at = timestamptz '2026-11-02 06:07Z' + interval '400 days')::text)
   from public.booking_tokens t
   where t.appointment_id = pg_temp.appt('b1') and t.token_hash = pg_temp.sha(pg_temp.token('b1'))),
  '1 | booking | true | true',
  'book: the manage token is stored as sha256, issued for the booking, expiring after 400 days'
);

select is(
  (select string_agg(concat_ws(':', m.channel, m.template, m.category, m.status, m.to_e164, m.locale,
                               (m.client_id = a.client_id)::text, (m.dedupe_key = 'appt:' || a.id || ':booking_confirmed')::text), ', ')
   from public.appointments a
   join public.messages_log m on m.business_id = a.business_id and m.appointment_id = a.id
   where a.id = pg_temp.appt('b1')),
  'sms:booking_confirmed:transactional:queued:+306900000301:el:true:true',
  'planner: one booking confirmation, queued to the client''s phone and language'
);

select is(
  pg_temp.r('b1') -> 'message_ids',
  (select jsonb_agg(m.id) from public.messages_log m where m.appointment_id = pg_temp.appt('b1')),
  'book: returns the ids of the queued SMS for the function to send'
);

select is(
  pg_temp.book('x', 'b9000000-0000-4000-8000-000000000002', '+306900000301', '2026-11-03 08:00Z', '2026-11-02 06:08Z',
               a_grant => pg_temp.grant_of('v1'), a_new_name => 'Νεφέλη Κ.', a_box => 'unchecked'),
  'P0001 AN014',
  'book: the grant is single-use: another booking with it → AN014'
);

select is(
  pg_temp.book('b1r', 'b9000000-0000-4000-8000-000000000001', '+306900000301', '2026-11-03 07:00Z', '2026-11-02 06:08Z',
               a_grant => pg_temp.grant_of('v1'), a_new_name => 'Νεφέλη Κ.', a_box => 'unchecked'),
  'ok',
  'replay: the same key and payload with the already consumed grant succeeds'
);

select is(
  (select concat_ws(' | ', (pg_temp.appt('b1r') = pg_temp.appt('b1'))::text, r ->> 'replayed', r ->> 'verified_via',
                    (pg_temp.token('b1r') <> pg_temp.token('b1'))::text,
                    ((r -> 'message_ids') = (pg_temp.r('b1') -> 'message_ids'))::text)
   from pg_temp.r('b1r') r),
  'true | true | otp | true | true',
  'replay: the same appointment, replayed = true, verified_via otp, a NEW manage token, the same queued SMS'
);

select is(
  array[
    (select count(*) from public.appointments
     where business_id = 'b1000000-0000-4000-8000-00000000000a' and idempotency_key = 'b9000000-0000-4000-8000-000000000001'),
    (select count(*) from public.messages_log where appointment_id = pg_temp.appt('b1')),
    (select count(*) from public.booking_tokens where appointment_id = pg_temp.appt('b1')),
    (select count(*) from public.client_consents where client_id = pg_temp.client_of('b1')),
    (select count(*) from public.appointment_events where appointment_id = pg_temp.appt('b1')),
    (select count(*) from public.clients
     where business_id = 'b1000000-0000-4000-8000-00000000000a' and phone_e164 = '+306900000301')
  ],
  array[1, 1, 2, 1, 1, 1]::bigint[],
  'replay: no second appointment, SMS, consent, event or client; a second live manage token'
);

select is(
  pg_temp.book('x', 'b9000000-0000-4000-8000-000000000001', '+306900000301', '2026-11-03 08:00Z', '2026-11-02 06:08Z',
               a_grant => pg_temp.grant_of('v1'), a_new_name => 'Νεφέλη Κ.', a_box => 'unchecked'),
  'P0001 AN004',
  'replay: the same key with another payload and the same grant → AN004'
);

select is(
  pg_temp.book('x', 'b9000000-0000-4000-8000-000000000001', '+306900000301', '2026-11-03 07:00Z', '2026-11-02 06:08Z',
               a_new_name => 'Νεφέλη Κ.', a_box => 'unchecked'),
  'P0001 AN014',
  'replay: without any proof → AN014'
);

select is(
  pg_temp.book('b1t', 'b9000000-0000-4000-8000-000000000001', '+306900000301', '2026-11-03 07:00Z', '2026-11-02 06:20Z',
               a_td => pg_temp.td_of('v1'), a_new_name => 'Νεφέλη Κ.', a_box => 'unchecked'),
  'ok',
  'replay: after the grant expired, the trusted device proves the replay'
);

select is(
  (select concat_ws(' | ', r ->> 'replayed', r ->> 'verified_via', (pg_temp.appt('b1t') = pg_temp.appt('b1'))::text)
   from pg_temp.r('b1t') r),
  'true | otp | true',
  'replay: verified_via stays the original otp'
);

-- P3: expiry, binding, and a failed booking that does not burn the grant.
select is(
  pg_temp.start('cp3', '+306900000303', '2026-11-02 06:02Z', '198.51.100.13'),
  'ok',
  'start: P3'
);

select is(
  pg_temp.verify('vp3', 'b1000000-0000-4000-8000-00000000000a', '+306900000303', pg_temp.cid('cp3'), '424242', '2026-11-02 06:03Z'),
  'verified',
  'verify: P3'
);

select is(
  pg_temp.book('x', 'b9000000-0000-4000-8000-000000000031', '+306900000303', '2026-11-03 13:00Z', '2026-11-02 06:13Z',
               a_grant => pg_temp.grant_of('vp3'), a_new_name => 'Άρης Τ.', a_new_locale => 'en'),
  'P0001 AN014',
  'book: an expired grant → AN014'
);

select is(
  pg_temp.book('x', 'b9000000-0000-4000-8000-000000000032', '+306900000302', '2026-11-03 13:00Z', '2026-11-02 06:05Z',
               a_grant => pg_temp.grant_of('vp3'), a_new_name => 'Άρης Τ.', a_new_locale => 'en'),
  'P0001 AN014',
  'book: a grant cannot book for another phone'
);

select is(
  pg_temp.book('x', 'b9000000-0000-4000-8000-000000000033', '+306900000303', '2026-11-06 07:00Z', '2026-11-02 06:05Z',
               a_grant => pg_temp.grant_of('vp3'), a_new_name => 'Άρης Τ.', a_new_locale => 'en',
               a_business => 'b1000000-0000-4000-8000-00000000000b', a_staff => 'b2000000-0000-4000-8000-0000000000b1',
               a_service => 'b4000000-0000-4000-8000-0000000000b1'),
  'P0001 AN014',
  'book: a grant of A cannot book in B'
);

select is(
  pg_temp.book('x', 'b9000000-0000-4000-8000-000000000034', '+306900000303', '2026-11-03 07:00Z', '2026-11-02 06:05Z',
               a_grant => pg_temp.grant_of('vp3'), a_new_name => 'Άρης Τ.', a_new_locale => 'en',
               a_staff => 'b2000000-0000-4000-8000-000000000002'),
  'P0001 AN001',
  'book: a taken time → AN001 (the grant consumption rolls back with it)'
);

select is(
  pg_temp.book('bp3', 'b9000000-0000-4000-8000-000000000035', '+306900000303', '2026-11-03 13:00Z', '2026-11-02 06:05Z',
               a_grant => pg_temp.grant_of('vp3'), a_new_name => 'Άρης Τ.', a_new_locale => 'en'),
  'ok',
  'book: after the failed attempts the same grant still books, once'
);

select is(
  pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000303', pg_temp.grant_of('vp3'), null, '2026-11-02 06:06Z'),
  'P0001 AN014',
  'a consumed grant is no longer live, not even for clients_for_phone'
);

select is(
  (select count(*) from public.client_consents where client_id = pg_temp.client_of('bp3')),
  0::bigint,
  'book: marketing box not shown → no consent record'
);

-- =============================================================================================
-- Existing client (Βασίλης): trusted device vs OTP path, consent records
-- =============================================================================================
select is(
  pg_temp.start('cv', '+306900000304', '2026-11-02 06:03Z', '198.51.100.14'),
  'ok',
  'start: PV'
);

select is(
  pg_temp.verify('vv', 'b1000000-0000-4000-8000-00000000000a', '+306900000304', pg_temp.cid('cv'), '424242', '2026-11-02 06:03:30Z'),
  'verified',
  'verify: PV'
);

select is(
  pg_temp.book('bv1', 'b9000000-0000-4000-8000-000000000041', '+306900000304', '2026-11-03 10:00Z', '2026-11-02 06:04Z',
               a_td => pg_temp.td_of('vv'), a_client => 'b3000000-0000-4000-8000-000000000004', a_box => 'unchecked'),
  'ok',
  'book (trusted device): an existing client books without a grant'
);

select is(
  (select concat_ws(' | ', pg_temp.r('bv1') ->> 'verified_via', coalesce(c.phone_verified_at::text, 'null'))
   from public.clients c where c.id = 'b3000000-0000-4000-8000-000000000004'),
  'trusted_device | null',
  'book (trusted device): verified_via trusted_device, and phone_verified_at is NOT written'
);

select is(
  pg_temp.book('bv3', 'b9000000-0000-4000-8000-000000000043', '+306900000304', '2026-11-03 12:00Z', '2026-11-02 06:04:30Z',
               a_td => pg_temp.td_of('vv'), a_client => 'b3000000-0000-4000-8000-000000000004', a_box => 'unchecked'),
  'ok',
  'book (trusted device): the box left unchecked again'
);

select is(
  pg_temp.book('bv2', 'b9000000-0000-4000-8000-000000000042', '+306900000304', '2026-11-03 11:00Z', '2026-11-02 06:05Z',
               a_grant => pg_temp.grant_of('vv'), a_client => 'b3000000-0000-4000-8000-000000000004', a_box => 'checked'),
  'ok',
  'book (OTP): the existing client books with the grant and ticks the refusal box'
);

select is(
  (select concat_ws(' | ', pg_temp.r('bv2') ->> 'verified_via', (c.phone_verified_at = '2026-11-02 06:05Z')::text)
   from public.clients c where c.id = 'b3000000-0000-4000-8000-000000000004'),
  'otp | true',
  'book (OTP) writes phone_verified_at for an existing client too'
);

select is(
  (select string_agg(concat_ws(':', k.purpose, k.legal_basis, k.granted::text, k.source), ',' order by k.granted)
   from public.client_consents k where k.client_id = 'b3000000-0000-4000-8000-000000000004'),
  'marketing_sms:soft_opt_in:false:booking_form,marketing_sms:soft_opt_in:true:booking_form',
  'consent: unchecked → soft opt-in; unchecked again → nothing new; checked → a refusal record (granted false)'
);

select is(
  array[
    pg_temp.book('x', 'b9000000-0000-4000-8000-000000000051', '+306900000304', '2026-11-03 12:00Z', '2026-11-02 06:05Z',
                 a_td => pg_temp.td_of('vv'), a_client => 'b3000000-0000-4000-8000-000000000004',
                 a_box => 'unchecked', a_policy => null),
    pg_temp.book('x', 'b9000000-0000-4000-8000-000000000052', '+306900000304', '2026-11-03 12:00Z', '2026-11-02 06:05Z',
                 a_td => pg_temp.td_of('vv'), a_client => 'b3000000-0000-4000-8000-000000000004',
                 a_box => 'checked', a_policy => repeat('v', 41)),
    pg_temp.book('x', 'b9000000-0000-4000-8000-000000000053', '+306900000304', '2026-11-03 12:00Z', '2026-11-02 06:05Z',
                 a_td => pg_temp.td_of('vv'), a_client => 'b3000000-0000-4000-8000-000000000004', a_box => 'maybe'),
    pg_temp.book('x', null, '+306900000304', '2026-11-03 12:00Z', '2026-11-02 06:05Z',
                 a_td => pg_temp.td_of('vv'), a_client => 'b3000000-0000-4000-8000-000000000004')
  ],
  array['22023', '22023', '22023', '22023'],
  'book: a shown box needs a 1–40 character notice version, the box state is a known value, the key is required (22023)'
);

select is(
  pg_temp.outcome($$insert into public.client_consents (business_id, client_id, purpose, legal_basis, granted, source, policy_version)
                    values ('b1000000-0000-4000-8000-00000000000a', 'b3000000-0000-4000-8000-000000000004',
                            'marketing_sms', 'soft_opt_in', true, 'staff_ui', 'v1')$$),
  '23514',
  'consent: a soft opt-in can only come from booking_form'
);

-- Staff change the number: the verification belongs to the number.
select pg_temp.as_role('authenticated',
  $$update public.clients set phone_e164 = '+306900000364' where id = 'b3000000-0000-4000-8000-000000000004' returning id::text$$,
  '{"sub": "b0000000-0000-4000-8000-00000000000a", "role": "authenticated", "aal": "aal1"}');

select is(
  (select concat_ws(' | ', c.phone_e164, coalesce(c.phone_verified_at::text, 'null'))
   from public.clients c where c.id = 'b3000000-0000-4000-8000-000000000004'),
  '+306900000364 | null',
  'a phone change by staff clears phone_verified_at'
);

-- =============================================================================================
-- The family phone: first names only, never merged by phone
-- =============================================================================================
select is(
  pg_temp.start('cfam', '+306900000305', '2026-11-02 06:03Z', '198.51.100.15'),
  'ok',
  'start: the family phone'
);

select is(
  (select array_agg(k order by k collate "C") from jsonb_object_keys(pg_temp.r('cfam')) k),
  (select array_agg(k order by k collate "C") from jsonb_object_keys(pg_temp.r('c1')) k),
  'start: the same answer for a number with clients and one without'
);

select is(
  pg_temp.verify('vfam', 'b1000000-0000-4000-8000-00000000000a', '+306900000305', pg_temp.cid('cfam'), '424242',
                 '2026-11-02 06:03:30Z'),
  'verified',
  'verify: the family phone'
);

select is(
  pg_temp.cfp('cff', 'b1000000-0000-4000-8000-00000000000a', '+306900000305', pg_temp.grant_of('vfam'), null, '2026-11-02 06:04Z'),
  'otp:Γιώργος,Μάριος',
  'clients_for_phone: first names only, oldest first; merged duplicates and other businesses'' clients left out'
);

select is(
  pg_temp.r('cff') -> 'clients',
  jsonb_build_array(
    jsonb_build_object('id', 'b3000000-0000-4000-8000-000000000001', 'first_name', 'Γιώργος'),
    jsonb_build_object('id', 'b3000000-0000-4000-8000-000000000002', 'first_name', 'Μάριος')),
  'clients_for_phone: exactly {id, first_name} per client, nothing else'
);

select is(
  pg_temp.book('bfam', 'b9000000-0000-4000-8000-000000000061', '+306900000305', '2026-11-03 14:00Z', '2026-11-02 06:05Z',
               a_grant => pg_temp.grant_of('vfam'), a_new_name => 'Ελένη Π.'),
  'ok',
  'book: "someone else" on the family phone'
);

select is(
  (select concat_ws(' | ',
     (pg_temp.client_of('bfam') not in ('b3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000002'))::text,
     (select count(*) from public.clients
      where business_id = 'b1000000-0000-4000-8000-00000000000a' and phone_e164 = '+306900000305' and merged_into_id is null),
     (select string_agg(coalesce(c.phone_verified_at::text, 'null'), ',' order by c.created_at)
      from public.clients c where c.id in ('b3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000002')))),
  'true | 3 | null,null',
  'never merged by phone: a new client joins the family phone, the others are untouched'
);

select is(
  pg_temp.book('bfam2', 'b9000000-0000-4000-8000-000000000062', '+306900000305', '2026-11-03 15:00Z', '2026-11-02 06:06Z',
               a_td => pg_temp.td_of('vfam'), a_client => 'b3000000-0000-4000-8000-000000000002'),
  'ok',
  'book (trusted device): Μάριος is chosen on the family phone'
);

select is(
  (select concat_ws(' | ', (pg_temp.client_of('bfam2') = 'b3000000-0000-4000-8000-000000000002')::text,
                    pg_temp.r('bfam2') ->> 'verified_via', coalesce(c.phone_verified_at::text, 'null'))
   from public.clients c where c.id = 'b3000000-0000-4000-8000-000000000002'),
  'true | trusted_device | null',
  'book (trusted device): the chosen client is booked, phone_verified_at untouched'
);

select is(
  pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000305', null, pg_temp.td_of('vfam'), '2026-11-02 06:07Z'),
  'trusted_device:Γιώργος,Μάριος,Ελένη',
  'clients_for_phone: the new family member is listed too'
);

-- =============================================================================================
-- More bookings from P1's trusted device, then the client forgets it
-- =============================================================================================
select is(
  array[
    pg_temp.book('bt', 'b9000000-0000-4000-8000-000000000003', '+306900000301', '2026-11-03 09:00Z', '2026-11-02 06:09Z',
                 a_td => pg_temp.td_of('v1'), a_client => pg_temp.client_of('b1')),
    pg_temp.book('bb', 'b9000000-0000-4000-8000-000000000004', '+306900000301', '2026-11-04 07:00Z', '2026-11-02 06:10Z',
                 a_td => pg_temp.td_of('v1'), a_client => pg_temp.client_of('b1')),
    pg_temp.book('br', 'b9000000-0000-4000-8000-000000000005', '+306900000301', '2026-11-04 08:00Z', '2026-11-02 06:11Z',
                 a_td => pg_temp.td_of('v1'), a_client => pg_temp.client_of('b1'))
  ],
  array['ok', 'ok', 'ok'],
  'book (trusted device): the same device books again without OTP'
);

-- After the device has booked (b1t, bt, bb, br): using it never moves its expiry.
select is(
  array[
    (select (d.expires_at = timestamptz '2026-11-02 06:04:59Z' + interval '180 days')::text
     from public.trusted_devices d where d.token_hash = pg_temp.sha(pg_temp.td_of('v1'))),
    pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000301', null, pg_temp.td_of('v1'),
                timestamptz '2026-11-02 06:04:59Z' + interval '180 days' - interval '1 second'),
    pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000301', null, pg_temp.td_of('v1'),
                timestamptz '2026-11-02 06:04:59Z' + interval '180 days')
  ],
  array['true', 'trusted_device:Νεφέλη', 'P0001 AN014'],
  'a trusted device expires 180 days after it was issued, even after it booked (not sliding)'
);

select 'setup (revoke via B): ' || pg_temp.revoke('b1000000-0000-4000-8000-00000000000b', pg_temp.td_of('v1'), '2026-11-02 06:30Z');

select is(
  pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000301', null, pg_temp.td_of('v1'), '2026-11-02 06:31Z'),
  'trusted_device:Νεφέλη',
  'revoke: A''s device presented to B revokes nothing'
);

select is(
  pg_temp.revoke('b1000000-0000-4000-8000-00000000000a', pg_temp.td_of('v1'), '2026-11-02 06:30Z'),
  'ok',
  'revoke: the client forgets the device'
);

select is(
  pg_temp.cfp('x', 'b1000000-0000-4000-8000-00000000000a', '+306900000301', null, pg_temp.td_of('v1'), '2026-11-02 06:31Z')
  || ' | ' || (select (d.revoked_at = '2026-11-02 06:30Z')::text from public.trusted_devices d
               where d.token_hash = pg_temp.sha(pg_temp.td_of('v1'))),
  'P0001 AN014 | true',
  'revoke: a revoked device proves nothing (revoked_at = p_now)'
);

select is(
  pg_temp.revoke('b1000000-0000-4000-8000-00000000000a', pg_temp.td_of('v1'), '2026-11-02 06:32Z')
  || ' ' || pg_temp.revoke('b1000000-0000-4000-8000-00000000000a', repeat('B', 43), '2026-11-02 06:32Z'),
  'ok ok',
  'revoke: again, or an unknown token, is silent'
);

select is(
  pg_temp.book('x', 'b9000000-0000-4000-8000-000000000006', '+306900000301', '2026-11-03 08:00Z', '2026-11-02 06:33Z',
               a_td => pg_temp.td_of('v1'), a_client => pg_temp.client_of('b1')),
  'P0001 AN014',
  'book: a revoked trusted device → AN014'
);

-- =============================================================================================
-- Manage link of the first booking (M_A): claim, view, many live tokens, send result, cancel
-- =============================================================================================
select is(
  pg_temp.claim('cl1', array[pg_temp.conf('b1')]),
  '1',
  'claim: the queued confirmation is claimed'
);

select is(
  (select concat_ws(' | ', e ->> 'template', e ->> 'category', e ->> 'to_e164', e ->> 'locale', e ->> 'business_name',
                    ((e ->> 'short_code') = (select short_code from public.businesses where id = 'b1000000-0000-4000-8000-00000000000a'))::text,
                    e ->> 'timezone', to_char((e ->> 'starts_at')::timestamptz at time zone 'UTC', 'MM-DD HH24:MI'),
                    e ->> 'staff_name', ((e ->> 'manage_token') ~ '^[A-Za-z0-9_-]{22}$')::text)
   from jsonb_array_elements(pg_temp.r('cl1')) e),
  'booking_confirmed | transactional | +306900000301 | el | PB Shop | true | Europe/Athens | 11-03 07:00 | Kostas | true',
  'claim: everything the sender needs, with a fresh manage token for the SMS link'
);

select is(
  (select concat_ws(' | ', m.status, m.attempts, (m.lease_id = (e ->> 'lease_id')::uuid)::text,
                    (m.lease_until = pg_temp.clk() + interval '60 seconds')::text, (m.booking_token_id = t.id)::text, t.issued_for)
   from jsonb_array_elements(pg_temp.r('cl1')) e
   join public.messages_log m on m.id = (e ->> 'id')::uuid
   join public.booking_tokens t on t.token_hash = pg_temp.sha(e ->> 'manage_token')),
  'sending | 1 | true | true | true | message',
  'claim: leased for 60″, attempt counted, the new token (issued for the message) referenced by id, never the link'
);

select set_config('t.digest', pg_temp.digest(), true);

select is(
  pg_temp.mview('mv1', pg_temp.token('b1'), '2026-11-02 06:31Z'),
  'ok',
  'manage_view: the booking''s token opens it'
);

select is(
  pg_temp.r('mv1') -> 'business',
  jsonb_build_object('id', 'b1000000-0000-4000-8000-00000000000a', 'slug', 'pb-shop', 'name', 'PB Shop',
                     'timezone', 'Europe/Athens', 'locale', 'el', 'currency', 'EUR', 'phone_e164', '+302610000001',
                     'address', 'Οδός Δοκιμής 1', 'maps_url', 'https://maps.example.com/pb-shop',
                     'theme', '{"primary": "#C8A15A"}'::jsonb),
  'manage_view: the business card'
);

select is(
  (select concat_ws(' | ', ((v ->> 'id')::uuid = pg_temp.appt('b1'))::text, v ->> 'status',
                    to_char((v ->> 'starts_at')::timestamptz at time zone 'UTC', 'MM-DD HH24:MI'),
                    to_char((v ->> 'ends_at')::timestamptz at time zone 'UTC', 'HH24:MI'), v ->> 'total_cents',
                    ((v -> 'staff') = jsonb_build_object('id', 'b2000000-0000-4000-8000-000000000001', 'display_name', 'Kostas'))::text,
                    ((v -> 'services') = jsonb_build_array(jsonb_build_object(
                       'id', 'b4000000-0000-4000-8000-000000000001', 'name', 'Cut', 'duration_min', 30, 'price_cents', 1300)))::text)
   from (select pg_temp.r('mv1') -> 'appointment' as v) q),
  'true | booked | 11-03 07:00 | 07:30 | 1300 | true | true',
  'manage_view: the appointment with its staff member and service lines'
);

select is(
  (select concat_ws(' | ', to_char((r ->> 'change_until')::timestamptz at time zone 'UTC', 'MM-DD HH24:MI'),
                    r ->> 'can_cancel', r ->> 'can_reschedule')
   from pg_temp.r('mv1') r),
  '11-03 05:00 | true | true',
  'manage_view: change_until = start − cancel_min_notice_min (booked well before)'
);

select is(
  array[strpos(pg_temp.r('mv1')::text, 'Νεφέλη'), strpos(pg_temp.r('mv1')::text, '6900000301')],
  array[0, 0],
  'manage_view: no client data (name, phone)'
);

select is(
  array[pg_temp.view_appt(pg_temp.token('b1'), '2026-11-02 06:31Z'),
        pg_temp.view_appt(pg_temp.token('b1r'), '2026-11-02 06:31Z'),
        pg_temp.view_appt(pg_temp.token('b1t'), '2026-11-02 06:31Z'),
        pg_temp.view_appt(pg_temp.r('cl1') -> 0 ->> 'manage_token', '2026-11-02 06:31Z')],
  array_fill(pg_temp.appt('b1')::text, array[4]),
  'many live tokens at once: the booking, two replays and the confirmation SMS open the same appointment'
);

select 'setup (manage_slots read): ' || pg_temp.outcome(format(
  $$select count(*) from private.manage_slots_impl(p_token => %L, p_from => '2026-11-03', p_to => '2026-11-03',
                                                     p_now => '2026-11-02 06:31Z')$$,
  pg_temp.token('b1')));

select is(
  pg_temp.digest(),
  current_setting('t.digest'),
  'manage_view and manage_slots change nothing (tokens, appointments, messages, events, challenges, devices, counters)'
);

select is(
  private.record_send_result_impl(
    p_id => pg_temp.conf('b1'), p_lease_id => gen_random_uuid(), p_outcome => 'sent', p_provider => 'fake',
    p_provider_message_id => 'fake-0001', p_segments => 1, p_cost_cents => 0, p_error => null, p_now => pg_temp.clk()),
  false,
  'record_send_result: another lease records nothing'
);

select is(
  private.record_send_result_impl(
    p_id => pg_temp.conf('b1'), p_lease_id => (pg_temp.r('cl1') -> 0 ->> 'lease_id')::uuid, p_outcome => 'sent',
    p_provider => 'fake', p_provider_message_id => 'fake-0001', p_segments => 1, p_cost_cents => 0, p_error => null,
    p_now => pg_temp.clk()),
  true,
  'record_send_result: the lease holder records the result'
);

select is(
  (select concat_ws(' | ', m.status, m.provider, m.provider_message_id, m.segments, m.cost_cents, (m.sent_at is not null)::text,
                    (m.lease_id is null and m.lease_until is null)::text)
   from public.messages_log m where m.id = pg_temp.conf('b1')),
  'sent | fake | fake-0001 | 1 | 0 | true | true',
  'record_send_result: sent, with provider, id, segments and cost; the lease is cleared'
);

select is(
  private.record_send_result_impl(
    p_id => pg_temp.conf('b1'), p_lease_id => (pg_temp.r('cl1') -> 0 ->> 'lease_id')::uuid, p_outcome => 'failed',
    p_provider => 'fake', p_provider_message_id => null, p_segments => null, p_cost_cents => null, p_error => 'late',
    p_now => pg_temp.clk()),
  false,
  'record_send_result: a second result for the same lease is ignored'
);

select is(
  pg_temp.claim('x', array[pg_temp.conf('b1')]),
  '0',
  'claim: only queued rows are ever claimed'
);

select is(
  pg_temp.claim('cl2', array[pg_temp.msg('c1')]),
  '1',
  'claim: the OTP message'
);

select is(
  (select concat_ws(' | ', e ->> 'template', e ->> 'category', e ->> 'to_e164', coalesce(e ->> 'starts_at', 'null'),
                    coalesce(e ->> 'staff_name', 'null'), coalesce(e ->> 'manage_token', 'null'))
   from jsonb_array_elements(pg_temp.r('cl2')) e),
  'otp | otp | +306900000301 | null | null | null',
  'claim: an OTP row carries no appointment data and no manage token'
);

select is(
  (select l.count from public.rate_limits l
   where l.bucket = 'sms_platform_day' and l.key = 'platform' and l.window_start = date_trunc('day', pg_temp.clk(), 'UTC')),
  2,
  'claim: every claimed SMS counts on the platform day'
);

select is(
  pg_temp.mcancel('mc1', pg_temp.token('b1r'), '2026-11-02 06:40Z'),
  'ok',
  'cancel: through any live token before change_until'
);

select is(
  (select concat_ws(' | ', ((r ->> 'appointment_id')::uuid = pg_temp.appt('b1'))::text, r ->> 'status',
                    ((r -> 'message_ids') = (select jsonb_agg(m.id) from public.messages_log m
                                             where m.appointment_id = pg_temp.appt('b1') and m.status = 'queued'))::text)
   from pg_temp.r('mc1') r),
  'true | cancelled | true',
  'cancel: returns the appointment, cancelled, and the queued SMS to send'
);

select is(
  (select concat_ws(' | ', a.status, a.cancelled_by, a.cancel_reason,
                    (select string_agg(e.event || ':' || e.to_status || ':' || e.actor_type, ',')
                     from public.appointment_events e where e.appointment_id = a.id and e.event = 'status_changed'))
   from public.appointments a where a.id = pg_temp.appt('b1')),
  'cancelled | client | client_request | status_changed:cancelled:client',
  'cancel: cancelled by the client (client_request), an event with actor client'
);

select is(
  (select concat_ws(' | ', count(*), bool_and(t.revoked_at = '2026-11-02 06:40Z')::text)
   from public.booking_tokens t where t.appointment_id = pg_temp.appt('b1')),
  '4 | true',
  'cancel revokes every token of the appointment (booking, replays, message)'
);

select is(
  array[pg_temp.view_appt(pg_temp.token('b1'), '2026-11-02 06:41Z'),
        pg_temp.view_appt(pg_temp.token('b1t'), '2026-11-02 06:41Z'),
        pg_temp.view_appt(pg_temp.r('cl1') -> 0 ->> 'manage_token', '2026-11-02 06:41Z')],
  array['P0001 AN015', 'P0001 AN015', 'P0001 AN015'],
  'after a cancel every link answers AN015'
);

select is(
  (select string_agg(m.template || ':' || m.status || ':' || (m.dedupe_key = 'appt:' || m.appointment_id || ':' || m.template)::text,
                     ',' order by m.template)
   from public.messages_log m where m.appointment_id = pg_temp.appt('b1')),
  'booking_confirmed:sent:true,cancelled_by_client:queued:true',
  'planner: a client cancel queues cancelled_by_client (deduplicated per appointment)'
);

select ok(
  exists (select 1 from private.available_slots_impl('b1000000-0000-4000-8000-00000000000a',
                                                     array['b4000000-0000-4000-8000-000000000001']::uuid[],
                                                     'b2000000-0000-4000-8000-000000000001', '2026-11-03', '2026-11-03',
                                                     'public', null, '2026-11-02 06:41Z') s
          where s.starts_at = '2026-11-03 07:00Z'),
  'cancel: the time is free again'
);

select is(
  pg_temp.mcancel('x', pg_temp.token('bb'), '2026-11-02 06:41Z'),
  'ok',
  'cancel: a booking whose confirmation is still queued'
);

select is(
  (select string_agg(m.template || ':' || m.status || ':' || coalesce(m.error, ''), ',' order by m.template)
   from public.messages_log m where m.appointment_id = pg_temp.appt('bb')),
  'booking_confirmed:cancelled:superseded,cancelled_by_client:queued:',
  'planner: a client cancel supersedes the queued confirmation'
);

-- =============================================================================================
-- Reschedule from the link (M_R: Kostas Wed 11-04 08:00Z, Cut 30′ + 15′; BL at 10:00Z)
-- =============================================================================================
select is(
  (select array_agg(to_char(s.starts_at at time zone 'UTC', 'HH24:MI') || '=' || s.local_date::text || ' '
                    || left(s.local_time::text, 5) order by s.starts_at)
   from private.manage_slots_impl(p_token => pg_temp.token('br'), p_from => '2026-11-04', p_to => '2026-11-04',
                                  p_now => '2026-11-02 06:50Z') s
   where s.starts_at in ('2026-11-04 08:00Z', '2026-11-04 09:00Z', '2026-11-04 09:15Z', '2026-11-04 09:30Z',
                         '2026-11-04 10:15Z', '2026-11-04 10:30Z')),
  array['08:00=2026-11-04 10:00', '09:00=2026-11-04 11:00', '09:15=2026-11-04 11:15', '10:30=2026-11-04 12:30'],
  'manage_slots: the booking''s own 30′ + 15′ block with the same staff member, ignoring itself, never into the next appointment'
);

select is(
  pg_temp.outcome(format(
    $$select count(*) from private.manage_slots_impl(p_token => %L, p_from => '2026-11-04', p_to => '2026-11-18',
                                                       p_now => '2026-11-02 06:50Z')$$,
    pg_temp.token('br'))),
  'P0001 AN002',
  'manage_slots: more than 14 days → AN002'
);

select is(
  pg_temp.mmove('x', pg_temp.token('br'), '2026-11-04 09:30Z', '2026-11-02 06:50Z'),
  'P0001 AN001',
  'reschedule: a start that manage_slots does not offer → AN001'
);

select is(
  pg_temp.mmove('mm1', pg_temp.token('br'), '2026-11-04 09:00Z', '2026-11-02 06:51Z'),
  'ok',
  'reschedule: to a free start'
);

select is(
  (select concat_ws(' | ', ((r ->> 'appointment_id')::uuid = pg_temp.appt('br'))::text, r ->> 'staff_id',
                    to_char((r ->> 'starts_at')::timestamptz at time zone 'UTC', 'MM-DD HH24:MI'),
                    to_char((r ->> 'ends_at')::timestamptz at time zone 'UTC', 'HH24:MI'),
                    ((r -> 'message_ids') = (select jsonb_agg(m.id) from public.messages_log m
                                             where m.appointment_id = pg_temp.appt('br') and m.status = 'queued'))::text)
   from pg_temp.r('mm1') r),
  'true | b2000000-0000-4000-8000-000000000001 | 11-04 09:00 | 09:30 | true',
  'reschedule: the same appointment id, same staff member, its own length; returns the queued SMS'
);

select is(
  (select string_agg(to_char(e.old_starts_at at time zone 'UTC', 'MM-DD HH24:MI') || '>'
                     || to_char(e.new_starts_at at time zone 'UTC', 'MM-DD HH24:MI') || ':' || e.actor_type, ',')
   from public.appointment_events e where e.appointment_id = pg_temp.appt('br') and e.event = 'rescheduled'),
  '11-04 08:00>11-04 09:00:client',
  'reschedule: a rescheduled event written by the client'
);

select is(
  (select string_agg(m.template || ':' || m.status || ':' || coalesce(m.error, ''), ',' order by m.template)
   from public.messages_log m where m.appointment_id = pg_temp.appt('br')),
  'booking_confirmed:cancelled:superseded,rescheduled_by_client:queued:',
  'planner: a client move supersedes the queued confirmation and queues rescheduled_by_client'
);

select is(
  pg_temp.mmove('x', pg_temp.token('br'), '2026-11-04 09:00Z', '2026-11-02 06:52Z'),
  'ok',
  'reschedule: to the time it already has'
);

select is(
  array[(select count(*) from public.appointment_events e where e.appointment_id = pg_temp.appt('br') and e.event = 'rescheduled'),
        (select count(*) from public.messages_log m where m.appointment_id = pg_temp.appt('br'))],
  array[1, 2]::bigint[],
  'reschedule to the same time is a no-op: no event, no message'
);

select is(
  pg_temp.mmove('x', pg_temp.token('br'), '2026-11-10 08:00Z', '2026-11-02 06:53Z'),
  'ok',
  'reschedule: a second move, to the next week'
);

select is(
  (select concat_ws(' | ',
     count(*) filter (where m.template = 'rescheduled_by_client' and m.status = 'queued'),
     count(*) filter (where m.template = 'rescheduled_by_client' and m.status = 'cancelled' and m.error = 'superseded'),
     bool_and(m.template <> 'rescheduled_by_client' or m.status <> 'queued'
              or m.dedupe_key = 'appt:' || m.appointment_id || ':rescheduled_by_client:'
                                || (select max(e.id) from public.appointment_events e
                                    where e.appointment_id = m.appointment_id and e.event = 'rescheduled'))::text)
   from public.messages_log m where m.appointment_id = pg_temp.appt('br')),
  '1 | 1 | true',
  'planner: one queued notice per move (deduplicated by its rescheduled event), the older one superseded'
);

select is(
  pg_temp.view_appt(pg_temp.token('br'), timestamptz '2026-11-04 09:30Z' + interval '30 days'),
  pg_temp.appt('br')::text,
  'a manage token stays valid across moves: its window follows the appointment''s end'
);

-- Online booking switched off: the client can still see and cancel, not move.
update public.businesses set booking_enabled = false where id = 'b1000000-0000-4000-8000-00000000000a';

select is(
  pg_temp.view_summary(pg_temp.token('br'), '2026-11-02 06:54Z'),
  'booked true false',
  'booking off: manage_view still works, can_cancel but not can_reschedule'
);

select is(
  (select count(*) from private.manage_slots_impl(p_token => pg_temp.token('br'), p_from => '2026-11-11', p_to => '2026-11-11',
                                                  p_now => '2026-11-02 06:54Z')),
  0::bigint,
  'booking off: manage_slots offers nothing'
);

select is(
  pg_temp.mmove('x', pg_temp.token('br'), '2026-11-11 08:00Z', '2026-11-02 06:54Z'),
  'P0001 AN009',
  'booking off: reschedule → AN009'
);

select is(
  coalesce(private.public_slug_for_code_impl(p_code => (select short_code from public.businesses
                                                        where id = 'b1000000-0000-4000-8000-00000000000a')), '<null>'),
  '<null>',
  'booking off: the short link resolves to nothing'
);

-- W2: booked 90′ before its start, inside the 120′ window → changeable until the start.
select is(
  array[pg_temp.view_flags('pgtapW2tokenAAAAAAAAAA', '2026-11-05 10:30Z'),
        pg_temp.view_flags('pgtapW2tokenAAAAAAAAAA', '2026-11-05 11:00Z')],
  array['11-05 11:00 true', '11-05 11:00 false'],
  'booked inside the notice window: changeable until the start, never after'
);

select is(
  pg_temp.mcancel('x', 'pgtapW2tokenAAAAAAAAAA', '2026-11-05 10:30Z'),
  'ok',
  'cancel inside the notice window is allowed when the booking itself was made inside it (and while booking is off)'
);

update public.businesses set booking_enabled = true where id = 'b1000000-0000-4000-8000-00000000000a';

-- =============================================================================================
-- change_until (cancel_min_notice_min = 120′), status and token windows
-- =============================================================================================
select is(
  array[pg_temp.view_flags('pgtapW1tokenAAAAAAAAAA', '2026-11-05 07:59Z'),
        pg_temp.view_flags('pgtapW1tokenAAAAAAAAAA', '2026-11-05 08:00Z')],
  array['11-05 08:00 true', '11-05 08:00 false'],
  'booked long before: changeable until 120′ before the start'
);

select is(
  pg_temp.mcancel('x', 'pgtapW1tokenAAAAAAAAAA', '2026-11-05 08:00Z'),
  'P0001 AN016',
  'cancel inside the notice window → AN016'
);

select is(
  pg_temp.mmove('x', 'pgtapW1tokenAAAAAAAAAA', '2026-11-05 14:00Z', '2026-11-05 08:30Z'),
  'P0001 AN016',
  'reschedule inside the notice window → AN016 (the same rule)'
);

-- W3: booked 150′ before its start → the window starts at 10:00, but 60′ after booking (10:30) win.
select is(
  array[pg_temp.view_flags('pgtapW3tokenAAAAAAAAAA', '2026-11-05 10:15Z'),
        pg_temp.view_flags('pgtapW3tokenAAAAAAAAAA', '2026-11-05 10:30Z')],
  array['11-05 10:30 true', '11-05 10:30 false'],
  'booked less than 60′ before the window: changeable until 60′ after booking'
);

select is(
  pg_temp.mcancel('x', 'pgtapW3tokenAAAAAAAAAA', '2026-11-05 10:15Z'),
  'ok',
  'cancel inside the notice window within 60′ of booking is allowed'
);

select is(
  array[pg_temp.mcancel('x', 'pgtapW4tokenAAAAAAAAAA', '2026-11-02 07:00Z'),
        pg_temp.mmove('x', 'pgtapW4tokenAAAAAAAAAA', '2026-11-06 12:00Z', '2026-11-02 07:00Z')],
  array['P0001 AN020', 'P0001 AN020'],
  'a completed appointment can be neither cancelled nor moved (AN020)'
);

select is(
  pg_temp.view_summary('pgtapW4tokenAAAAAAAAAA', '2026-11-02 07:00Z') || ' | '
  || (select count(*) from private.manage_slots_impl(p_token => 'pgtapW4tokenAAAAAAAAAA', p_from => '2026-11-06',
                                                     p_to => '2026-11-06', p_now => '2026-11-02 07:00Z'))::text,
  'completed false false | 0',
  'a completed appointment is shown, without actions or slots'
);

select is(
  array[pg_temp.view_appt('pgtapW1expiryAAAAAAAAA', '2026-11-03 23:59Z'),
        pg_temp.view_appt('pgtapW1expiryAAAAAAAAA', '2026-11-04 00:00Z')],
  array['b5000000-0000-4000-8000-000000000011', 'P0001 AN015'],
  'a manage token is invalid from its expires_at'
);

select is(
  array[pg_temp.view_appt('pgtapW1tokenAAAAAAAAAA', '2026-12-05 10:29Z'),
        pg_temp.view_appt('pgtapW1tokenAAAAAAAAAA', '2026-12-05 10:30Z')],
  array['b5000000-0000-4000-8000-000000000011', 'P0001 AN015'],
  'a manage token is invalid from 30 days after the appointment ends'
);

select is(
  pg_temp.view_appt('AAAAAAAAAAAAAAAAAAAAAA', '2026-11-02 07:00Z'),
  'P0001 AN015',
  'an unknown manage token → AN015'
);

-- =============================================================================================
-- Planner v1: what it does NOT plan
-- =============================================================================================
select is(
  pg_temp.staff_book('st'),
  'ok',
  'a staff phone booking through book_core'
);

select is(
  (select count(*) from public.messages_log m where m.appointment_id = pg_temp.appt('st')),
  0::bigint,
  'planner v1: a staff booking plans no message'
);

select is(
  array[pg_temp.planner('b5000000-0000-4000-8000-000000000011', 'created'),
        pg_temp.planner('b5000000-0000-4000-8000-000000000011', 'cancelled'),
        pg_temp.planner('b5000000-0000-4000-8000-000000000011', 'moved'),
        pg_temp.planner(pg_temp.appt('bp3'), 'created', 'client')],
  array['ok', 'ok', 'ok', 'ok'],
  'planner: called for a phone booking (as system) and again for an online one'
);

select is(
  (select count(*) from public.messages_log m
   where m.appointment_id in ('b5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000002',
                              'b5000000-0000-4000-8000-000000000011', 'b5000000-0000-4000-8000-000000000014')),
  0::bigint,
  'planner v1: nothing for appointments inserted directly (seed.sql), for non-online "created" or for system cancel/move'
);

select is(
  pg_temp.planner('b5000000-0000-4000-8000-000000000011', 'bogus'),
  '22023',
  'planner: an unknown change is an invalid argument'
);

select is(
  (select array_agg(distinct q.n) from (
     select count(m.id) filter (where m.template = 'booking_confirmed') as n
     from public.appointments a
     left join public.messages_log m on m.business_id = a.business_id and m.appointment_id = a.id
     where a.business_id = 'b1000000-0000-4000-8000-00000000000a' and a.source = 'online' and a.idempotency_key is not null
     group by a.id) q),
  array[1]::bigint[],
  'planner v1: exactly one confirmation per online booking (replays and a repeated planner call add none)'
);

select is(
  (select string_agg(m.template || ':' || m.status, ',' order by m.appointment_id)
   from public.messages_log m
   where m.appointment_id in ('b5000000-0000-4000-8000-000000000012', 'b5000000-0000-4000-8000-000000000013')),
  'cancelled_by_client:queued,cancelled_by_client:queued',
  'planner v1: a client cancel notifies even when the booking was entered by staff'
);

select is(
  (select m.locale from public.messages_log m where m.appointment_id = pg_temp.appt('bp3') and m.template = 'booking_confirmed'),
  'en',
  'planner: messages go in the client''s language'
);

-- =============================================================================================
-- Claim controls: kill switch, platform cap, missing recipient
-- =============================================================================================
update private.platform_settings set sms_enabled = false;

select is(
  pg_temp.claim('x', array[pg_temp.msg('crand')]),
  '0',
  'claim: the kill switch sends nothing'
);

select is(
  (select m.status from public.messages_log m where m.id = pg_temp.msg('crand')),
  'queued',
  'claim: with the kill switch the row stays queued'
);

update private.platform_settings set sms_enabled = true, sms_daily_cap = 3;

select is(
  pg_temp.claim('x', array[pg_temp.msg('crand'), pg_temp.msg('c2')]),
  '1',
  'claim: never more than sms_daily_cap per UTC day (2 already claimed, cap 3)'
);

select is(
  concat_ws(' | ',
    (select l.count from public.rate_limits l
     where l.bucket = 'sms_platform_day' and l.key = 'platform' and l.window_start = date_trunc('day', pg_temp.clk(), 'UTC')),
    (select count(*) from public.messages_log m where m.id in (pg_temp.msg('crand'), pg_temp.msg('c2')) and m.status = 'queued')),
  '3 | 1',
  'claim: the counter reaches the cap and the other message stays queued'
);

update private.platform_settings set sms_daily_cap = 300;
update public.messages_log set to_e164 = null where id = pg_temp.msg('cv');

select is(
  pg_temp.claim('x', array[pg_temp.msg('cv')]),
  '0',
  'claim: a row without a recipient is not returned'
);

select is(
  (select m.status || ':' || m.error from public.messages_log m where m.id = pg_temp.msg('cv')),
  'cancelled:no_recipient',
  'claim: a row without a recipient is cancelled (no_recipient)'
);

-- =============================================================================================
-- SMS other than OTP (clients can trigger them again and again through a manage link or a
-- trusted device): per phone and per business per UTC day, the OTP reserve, stale rows.
-- So far today: P1 1 (cl1), business A 1, platform 4 (cl1, cl2, the cap test).
-- =============================================================================================
update private.platform_settings set sms_per_phone_day = 2;

select is(
  pg_temp.claim('x', array[pg_temp.conf('bt'), pg_temp.msg_of(pg_temp.appt('b1'), 'cancelled_by_client')]),
  '1',
  'claim: at most sms_per_phone_day SMS other than OTP to one phone per UTC day (P1 had 1, cap 2)'
);

select is(
  concat_ws(' | ',
    (select string_agg(pg_temp.mstate(x), ',' order by pg_temp.mstate(x))
     from unnest(array[pg_temp.conf('bt'), pg_temp.msg_of(pg_temp.appt('b1'), 'cancelled_by_client')]) as x),
    pg_temp.counter('sms_phone_day', pg_temp.ph('+306900000301')),
    pg_temp.counter('sms_business_day', 'b1000000-0000-4000-8000-00000000000a'),
    pg_temp.counter('sms_platform_day', 'platform')),
  'cancelled:rate_limited,sending: | 2 | 2 | 4',
  'claim: the row over the phone cap is cancelled (rate_limited) and counts nowhere'
);

update private.platform_settings set sms_per_phone_day = 10, sms_per_business_day = 2;

select is(
  concat_ws(' | ', pg_temp.claim('x', array[pg_temp.conf('bfam')]), pg_temp.mstate(pg_temp.conf('bfam')),
            pg_temp.counter('sms_business_day', 'b1000000-0000-4000-8000-00000000000a'),
            pg_temp.counter('sms_phone_day', pg_temp.ph('+306900000305'))),
  '0 | cancelled:rate_limited | 2 | 0',
  'claim: at most sms_per_business_day SMS other than OTP per business per UTC day'
);

-- Room for two more SMS today, half of the cap reserved for OTP.
update private.platform_settings
set sms_per_business_day = 200, sms_otp_reserve_pct = 50,
    sms_daily_cap = pg_temp.counter('sms_platform_day', 'platform') + 2;

select is(
  concat_ws(' | ',
    pg_temp.claim('clr', array[pg_temp.msg_of('b5000000-0000-4000-8000-000000000012', 'cancelled_by_client'),
                               pg_temp.msg('cp3')]),
    (select string_agg(e ->> 'template', ',') from jsonb_array_elements(pg_temp.r('clr')) as e),
    pg_temp.mstate(pg_temp.msg_of('b5000000-0000-4000-8000-000000000012', 'cancelled_by_client'))),
  '1 | otp | queued:',
  'claim: the last sms_otp_reserve_pct of the daily cap is for OTP only; other SMS stay queued'
);

update private.platform_settings set sms_otp_reserve_pct = 0;

select is(
  pg_temp.claim('x', array[pg_temp.msg_of('b5000000-0000-4000-8000-000000000012', 'cancelled_by_client')]),
  '1',
  'claim: without the reserve the same SMS goes out'
);

update private.platform_settings set sms_daily_cap = 300, sms_otp_reserve_pct = 20;

-- The business cancels Μάριος (bfam2) while its confirmation is still queued (planner v1 plans
-- nothing for a staff cancel): the confirmation must not go out, nor mint a live link.
update public.appointments
set status = 'cancelled', cancelled_by = 'business', cancel_reason = 'shop_closed'
where id = pg_temp.appt('bfam2');

select is(
  concat_ws(' | ', pg_temp.claim('x', array[pg_temp.conf('bfam2')]), pg_temp.mstate(pg_temp.conf('bfam2')),
            (select count(*) from public.booking_tokens t
             where t.appointment_id = pg_temp.appt('bfam2') and t.issued_for = 'message')),
  '0 | cancelled:superseded | 0',
  'claim: the confirmation of an appointment no longer booked is cancelled (superseded), no token minted'
);

-- =============================================================================================
-- next_visit_hint (p_now = T0)
-- =============================================================================================
select is(
  pg_temp.hint('b1000000-0000-4000-8000-00000000000c', '2026-11-02 06:00Z'),
  'nextVisit.vertical:4',
  'next_visit_hint: 49 valid intervals (short, long, old, cancelled, erased, merged, future ignored) → the vertical 28 days'
);

insert into public.clients (id, business_id, full_name, source)
values ('b6000000-0000-4000-8000-000000000050', 'b1000000-0000-4000-8000-00000000000c', 'Hint client 50', 'staff');
insert into public.appointments (business_id, client_id, staff_id, starts_at, ends_at, status, source, total_cents, charged_cents) values
  ('b1000000-0000-4000-8000-00000000000c', 'b6000000-0000-4000-8000-000000000050', 'b2000000-0000-4000-8000-0000000000c1',
   '2026-06-23 08:00Z', '2026-06-23 08:30Z', 'completed', 'phone', 1000, 1000),
  ('b1000000-0000-4000-8000-00000000000c', 'b6000000-0000-4000-8000-000000000050', 'b2000000-0000-4000-8000-0000000000c1',
   '2026-08-11 08:00Z', '2026-08-11 08:30Z', 'completed', 'phone', 1000, 1000);

select is(
  pg_temp.hint('b1000000-0000-4000-8000-00000000000c', '2026-11-02 06:00Z'),
  'nextVisit.business:6',
  'next_visit_hint: at 50 intervals the business median wins (25 × 35 and 25 × 49 days → 42 → 6 weeks)'
);

select is(
  pg_temp.hint('b1000000-0000-4000-8000-00000000000d', '2026-11-02 06:00Z'),
  '<null>',
  'next_visit_hint: no history and no vertical default → null'
);

-- =============================================================================================
-- Nothing secret in plaintext
-- =============================================================================================
select is(
  pg_temp.tables_containing(array(select distinct s.token from pg_temp.seen_tokens s)),
  '{}'::text[],
  'no raw token (grant, trusted device, manage link) appears in any column of any table in public or private'
);

select is(
  pg_temp.tables_containing(
    array['6900000301', '6900000303', '6900000304', '6900000305', '6900000309', '6900000321', '6900000322',
          '6900000323', '6900000324', '198.51.100.11', '198.51.100.13', '198.51.100.14', '198.51.100.15',
          '198.51.100.19', '198.51.100.23', '198.51.100.24', '192.0.2.50', 'unknown'],
    array['public.otp_challenges', 'public.trusted_devices', 'public.rate_limits', 'public.suppression_list']::regclass[]),
  '{}'::text[],
  'challenges, trusted devices, counters and suppressions hold phones and IPs only as HMACs'
);

-- Vault keys fail closed: too short, then missing.
select pg_temp.set_vault('phone_hmac_key', 'too-short-for-a-key');
select set_config('t.short_key', pg_temp.outcome($$select private.phone_hmac('+306900000301')$$), true);
select pg_temp.set_vault('phone_hmac_key', pg_temp.phone_key(), 'pgtap_10_moved_phone_hmac_key');

select is(
  array[current_setting('t.short_key'), pg_temp.outcome($$select private.phone_hmac('+306900000301')$$)],
  array['55000', '55000'],
  'a Vault key shorter than 32 characters, or missing, fails closed (55000)'
);

select * from finish();
rollback;
