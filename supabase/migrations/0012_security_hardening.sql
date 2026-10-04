-- 0012_security_hardening.sql
-- Security hardening before 1.10 (SPEC §7, §11; ADR-0009 residual risks (ii), (iii), (v); contract
-- 1.9 §7 item 10). Contract: docs/plans/contracts/1.9b-security-hardening.md (§2 is this file).
-- 0011 stays as reviewed: every replaced body below is the previous one plus the stated change.
--
--   (a) a revoked session stops counting at once, for every role
--   private.session_alive               the JWT's session_id still exists in auth.sessions for the
--                                       caller (no session_id: synthetic claims, keeps 0009)
--   private.mfa_level_ok                THE D2 level without the session: not blocked, and aal2 or no
--                                       verified factor yet (never probes auth.sessions)
--   private.session_mfa_ok (0009)       a live session and mfa_level_ok (the push register/
--                                       unregister get it through this function, unchanged)
--   the six membership helpers (0009)   every row needs a live session, staff included (contract §7
--                                       item 2, the alternative approved on 2026-10-04: one probe of
--                                       auth.sessions per helper and statement, for every role);
--                                       owner/manager rows also mfa_level_ok (business_members_select
--                                       gets it through my_business_ids, unchanged)
--   private.require_fresh_totp (0009)   a dead session → 42501 without hint (never the code sheet)
--
--   (b) Nous learns of every security event
--   private.queue_security_notifications (0011)  the bundle + account_email, businesses (name, slug)
--
--   (c) no new device after an unauthorized removal until Nous resets the account
--   private.factor_enrolment_blocks     an account that may not add a device until mfa-reset
--   private.remove_grant_for            THE remove-grant rule (1.9 D8), shared by the detector and
--                                       private.unauthorized_removal_pending
--   private.unauthorized_removal_pending  a snapshot factor gone without a remove grant (not yet
--                                       detected)
--   private.enrolment_blocked           THE block rule: a block row, or no verified factor and an
--                                       unauthorized removal pending
--   private.match_add_grants (0011)     a blocked user's add grants never vouch for a device
--   private.detect_factor_changes_impl (0011)  step 5 through remove_grant_for; step 6b writes the
--                                       block (+ audit factor_enrolment_blocked per business)
--   private.authorize_factor_change_impl (0009)  a dead session → 42501 (checked again under the
--                                       factors lock); add while blocked → AN034
--   private.record_support_action_impl (0009)  mfa_reset refuses while a removal awaits detection
--                                       (55000 detection_pending), lifts the block
--                                       (enrolment_unblocked) and ends the user's sessions in the
--                                       same transaction (sessions, push_subscriptions); it also
--                                       resets a user who is owner/manager nowhere any more but
--                                       still blocked (contract §7 item 17, the alternative
--                                       approved on 2026-10-04: Nous can always lift a block)
--
-- API (thin SECURITY INVOKER wrapper in public, SECURITY DEFINER _impl in private):
--   authenticated: factor_enrolment_blocked (the caller's own state; no p_business_id)
-- No actor is declared anywhere: nothing here writes appointments.

-- ---------------------------------------------------------------------------------------------
-- Domain errors: AN034 joins the list. The same list lives in
-- supabase/functions/_shared/errors.ts (errors.test.ts compares them).
-- ---------------------------------------------------------------------------------------------
create or replace function private.raise_domain_error(p_code text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_name text := case p_code
    when 'AN001' then 'slot_taken'
    when 'AN002' then 'range_too_long'
    when 'AN003' then 'invalid_services'
    when 'AN004' then 'idempotency_conflict'
    when 'AN005' then 'outside_hours'
    when 'AN006' then 'buffer_overlap'
    when 'AN007' then 'invalid_client'
    when 'AN008' then 'invalid_staff'
    when 'AN009' then 'not_bookable'
    when 'AN010' then 'otp_invalid'
    when 'AN011' then 'otp_expired'
    when 'AN012' then 'otp_attempts'
    when 'AN013' then 'rate_limited'
    when 'AN014' then 'verification_required'
    when 'AN015' then 'manage_token_invalid'
    when 'AN016' then 'change_too_late'
    when 'AN017' then 'sms_unavailable'
    when 'AN018' then 'phone_not_supported'
    when 'AN019' then 'otp_resend_too_soon'
    when 'AN020' then 'not_modifiable'
    when 'AN021' then 'appointment_changed'
    when 'AN022' then 'correction_closed'
    when 'AN023' then 'not_started'
    when 'AN024' then 'slug_unavailable'
    when 'AN025' then 'future_appointments'
    when 'AN026' then 'last_owner'
    when 'AN027' then 'last_factor'
    when 'AN028' then 'already_member'
    when 'AN029' then 'staff_has_login'
    when 'AN030' then 'not_a_member'
    when 'AN031' then 'member_elsewhere'
    when 'AN032' then 'client_has_upcoming'
    when 'AN033' then 'client_unavailable'
    when 'AN034' then 'enrolment_blocked'
  end;
begin
  if v_name is null then
    raise exception 'unknown domain error code %', p_code using errcode = '22023';
  end if;
  raise exception using errcode = 'P0001', message = p_code, hint = v_name;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Schema (§2.2). RLS on, no policy, no privilege for any API role: only definer code reaches it.
-- ---------------------------------------------------------------------------------------------

-- (c) An account that may not add an authenticator device until Nous resets it (C1). Written only
-- by private.detect_factor_changes_impl (step 6b); deleted only by private.record_support_action_impl
-- ('mfa_reset') and by the cascade from auth.users. Never purged; it survives demotion and
-- re-promotion (C5).
create table private.factor_enrolment_blocks (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- the removal event; null once the event is purged
  event_id uuid references private.security_events (id) on delete set null,
  blocked_at timestamptz not null
);

comment on table private.factor_enrolment_blocks is
  'Accounts that may not add an authenticator device until Nous resets them (mfa-reset). Written only by the detector, deleted only by record_support_action(mfa_reset) and the cascade.';

alter table private.factor_enrolment_blocks enable row level security;
revoke all on table private.factor_enrolment_blocks from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Internal helpers (§2.3): private, stable, SECURITY INVOKER, no grants; only definer code calls
-- them.
-- ---------------------------------------------------------------------------------------------

-- (a) The session of the JWT still exists (A1): a row of auth.sessions with the JWT's session_id
-- and the caller's user id. Existence only (GoTrue owns the session's aal and expiry; the token's
-- exp bounds it). No session_id → true: GoTrue always sets it, only the JWT secret mints a token
-- without it (pgTAP's synthetic claims, service tokens). A session_id that is not a UUID → false.
create function private.session_alive()
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_session text := auth.jwt() ->> 'session_id';
begin
  if v_session is null then
    return true;
  end if;
  if v_session !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (
    select 1 from auth.sessions s
    where s.id = v_session::uuid and s.user_id = (select auth.uid())
  );
end;
$$;

-- THE remove-grant rule (1.9 D8), one place for the detector (step 5) and for
-- private.unauthorized_removal_pending: the earliest (created_at, id) unmatched `remove` grant of the
-- user for the factor that was still valid after the run that last saw the factor; null when none.
-- Reads only.
create function private.remove_grant_for(p_user_id uuid, p_factor_id uuid, p_last_seen_at timestamptz)
returns uuid
language sql
stable
set search_path = ''
as $$
  select g.id
  from private.factor_change_grants g
  where g.user_id = p_user_id
    and g.action = 'remove'
    and g.factor_id = p_factor_id
    and g.matched_at is null
    and g.expires_at > p_last_seen_at
  order by g.created_at, g.id
  limit 1;
$$;

-- (c) An unauthorized removal the detector has not seen yet (C2): a snapshot factor of the user that
-- no longer exists in auth.mfa_factors (any status) and that no remove grant covers. Legit removals
-- (app, mfa-reset, demotion, dispatch) always write their grant first.
create function private.unauthorized_removal_pending(p_user_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from private.mfa_factor_snapshot s
    where s.user_id = p_user_id
      and not exists (select 1 from auth.mfa_factors f where f.id = s.factor_id)
      and private.remove_grant_for(s.user_id, s.factor_id, s.last_seen_at) is null
  );
$$;

-- THE block rule (C3): a block row of the user, or no verified factor and an unauthorized removal
-- pending. Null user → false. Used by mfa_level_ok (so session_mfa_ok and the six membership
-- helpers), authorize_factor_change_impl and factor_enrolment_blocked_impl.
create function private.enrolment_blocked(p_user_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_user_id is not null
     and (
       exists (select 1 from private.factor_enrolment_blocks b where b.user_id = p_user_id)
       or (
         not exists (
           select 1 from auth.mfa_factors f
           where f.user_id = p_user_id and f.status = 'verified'
         )
         and private.unauthorized_removal_pending(p_user_id)
       )
     );
$$;

-- D2 WITHOUT the session check (§7 item 2, approved 2026-10-04): THE owner/manager level of the
-- caller's JWT: the enrolment is not blocked (C3) and, as in 0009, the session is aal2 or the user
-- has no verified factor yet. No auth.uid() → false. It never probes auth.sessions: its callers check
-- the session first, once (session_mfa_ok, and the six membership helpers through their own
-- (select private.session_alive())), so a statement probes the session exactly once per helper.
create function private.mfa_level_ok()
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    return false;
  end if;
  if private.enrolment_blocked(v_uid) then
    return false;
  end if;
  return coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = v_uid and f.status = 'verified'
      );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Replaced functions (§2.4): same signature, parameter names and defaults, return type,
-- volatility and SECURITY flag as the definitions they replace (grants are kept).
-- ---------------------------------------------------------------------------------------------

-- D2 (0009), replaced: an owner/manager membership counts only when the JWT's session is still
-- alive (A1: a revoked token stops passing RLS and the RPCs at once instead of after up to 1 h),
-- the user's enrolment is not blocked (C3: a blocked account reads nothing as owner/manager, also
-- at aal2) and, as before, the session is aal2 or the user has no verified factor yet (the last
-- two: private.mfa_level_ok, THE level rule, shared with the six helpers below). The push
-- register/unregister call it directly, so they need a live session for every role (A3). Language:
-- plpgsql (was sql).
create or replace function private.session_mfa_ok()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    return false;
  end if;
  if not private.session_alive() then
    return false;
  end if;
  return private.mfa_level_ok();
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The six membership helpers (0009), replaced (contract §7 item 2, the alternative approved on
-- 2026-10-04): a membership row counts only while the JWT's session is alive, for EVERY role, and an
-- owner/manager row also needs the D2 level (private.mfa_level_ok: not blocked, aal2 or no verified
-- factor yet). (select private.session_alive()) depends on no row: the planner makes it a one-time
-- filter, evaluated ONCE per execution of the helper whatever the roles and the plan, so a statement
-- probes auth.sessions (its primary key) once per helper it uses; (select private.mfa_level_ok())
-- probes no session and, as in 0009, is reached only past `m.role = 'staff' or`. A JWT without
-- session_id keeps the 0009 rule (session_alive is true); service_role and the cron jobs have no
-- auth.uid(), so no row is theirs either way. After «Αποσύνδεση από όλες τις συσκευές», a role
-- change or a removal (the D1 trigger revokes every session of the user in the same transaction) a
-- staff token stops at once instead of after up to 1 h (ADR-0009 residual risk (ii)). Same
-- signatures (grants kept); each body is the 0009 one with `m.role = 'staff' or (select
-- private.session_mfa_ok())` replaced by `(select private.session_alive()) and (m.role = 'staff' or
-- (select private.mfa_level_ok()))`. The caller's own business_members rows stay readable
-- (business_members_select, unchanged: the app's loader reads the role before any membership counts).
-- ---------------------------------------------------------------------------------------------
create or replace function private.my_business_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.business_id from public.business_members m
  where m.user_id = (select auth.uid())
    and (select private.session_alive())
    and (m.role = 'staff' or (select private.mfa_level_ok()));
$$;

create or replace function private.my_business_ids_with_role(p_roles text[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.business_id from public.business_members m
  where m.user_id = (select auth.uid()) and m.role = any (p_roles)
    and (select private.session_alive())
    and (m.role = 'staff' or (select private.mfa_level_ok()));
$$;

create or replace function private.my_staff_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.staff_id from public.business_members m
  where m.user_id = (select auth.uid()) and m.staff_id is not null
    and (select private.session_alive())
    and (m.role = 'staff' or (select private.mfa_level_ok()));
$$;

create or replace function private.is_member(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.business_members m
    where m.business_id = p_business_id and m.user_id = (select auth.uid())
      and (select private.session_alive())
      and (m.role = 'staff' or (select private.mfa_level_ok()))
  );
$$;

create or replace function private.has_role(p_business_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.business_members m
    where m.business_id = p_business_id
      and m.user_id = (select auth.uid())
      and m.role = any (p_roles)
      and (select private.session_alive())
      and (m.role = 'staff' or (select private.mfa_level_ok()))
  );
$$;

create or replace function private.my_staff_id(p_business_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.staff_id from public.business_members m
  where m.business_id = p_business_id and m.user_id = (select auth.uid())
    and (select private.session_alive())
    and (m.role = 'staff' or (select private.mfa_level_ok()));
$$;

-- The fresh-code check (0009), replaced: a dead session is refused first, with 42501 and no hint
-- (A4: never the code sheet); then the 0009 body unchanged. The step-up hints stay exactly
-- aal2_required and fresh_totp_required (STEP_UP_HINTS, domain.test).
create or replace function private.require_fresh_totp()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not private.session_alive() then
    raise exception 'the session has ended' using errcode = '42501';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'a code from the authenticator app is required'
      using errcode = '42501', hint = 'aal2_required';
  end if;
  if not private.has_fresh_totp() then
    raise exception 'a code from the authenticator app is required'
      using errcode = '42501', hint = 'fresh_totp_required';
  end if;
end;
$$;

-- THE add-grant rule (0011), replaced: a blocked user's grants never vouch for a device (C3), so a
-- device enrolled straight at GoTrue while blocked gets no grant: the detector flags it
-- (factor_added_unauthorized, dispatch deletes it) and has_fresh_totp refuses its codes (it is
-- unvetted, through private.unvetted_factors). Otherwise the 0011 body.
create or replace function private.match_add_grants(p_ids uuid[], p_users uuid[], p_created timestamptz[])
returns table (m_factor_id uuid, m_user_id uuid, m_created_at timestamptz, m_grant_id uuid)
language plpgsql
stable
set search_path = ''
as $$
declare
  v record;
  v_grant uuid;
  v_taken uuid[] := '{}';
begin
  for v in
    select c.id, c.user_id, c.created_at
    from unnest(p_ids, p_users, p_created) as c (id, user_id, created_at)
    where c.id is not null
    order by c.created_at, c.id
  loop
    -- no row → null
    select g.id into v_grant
    from private.factor_change_grants g
    where g.user_id = v.user_id
      and g.action = 'add'
      and g.matched_at is null
      and g.created_at <= v.created_at
      and v.created_at <= g.expires_at + interval '30 seconds'
      and not (g.id = any (v_taken))
      and not exists (select 1 from private.factor_enrolment_blocks b where b.user_id = g.user_id)
    order by g.created_at, g.id
    limit 1;

    if v_grant is not null then
      v_taken := v_taken || v_grant;
    end if;
    m_factor_id := v.id;
    m_user_id := v.user_id;
    m_created_at := v.created_at;
    m_grant_id := v_grant;
    return next;
  end loop;
end;
$$;

-- Notifications of an event (0011), replaced: the bundle gains account_email (the account's email,
-- null when none) and businesses ([{name, slug}] of the event's business_ids in their order, a
-- missing business skipped, [] when none), for dispatch's copy to Nous (B5). So the bundle is
-- exactly { account_email, businesses, detected_at, emails, kind, push_queued }; the emails and the
-- push rows are unchanged.
create or replace function private.queue_security_notifications(p_event_id uuid, p_now timestamptz)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_event private.security_events%rowtype;
  v_email text;
  v_locale text := 'el';
  v_timezone text := 'UTC';
  v_push integer;
  v_emails jsonb := '[]'::jsonb;
  v_businesses jsonb;
begin
  if p_event_id is null or p_now is null then
    raise exception 'p_event_id and p_now are required' using errcode = '22023';
  end if;

  select e.* into v_event from private.security_events e where e.id = p_event_id;
  if not found then
    raise exception 'unknown security event' using errcode = '22023';
  end if;

  select u.email into v_email from auth.users u where u.id = v_event.user_id;

  -- the user's language and zone: those of the first business of the event
  if cardinality(v_event.business_ids) > 0 then
    select b.locale, b.timezone into v_locale, v_timezone
    from public.businesses b
    where b.id = v_event.business_ids[1];
    v_locale := coalesce(v_locale, 'el');
    v_timezone := coalesce(v_timezone, 'UTC');
  end if;

  -- the owners' push (D12)
  with inserted as (
    insert into public.messages_log (
      business_id, dedupe_key, channel, recipient_user_id, locale, template, category, scheduled_for
    )
    select b.id,
           'security:' || v_event.id::text || ':' || b.id::text || ':' || m.user_id::text,
           'push', m.user_id, b.locale, 'push_security_alert', 'transactional', p_now
    from unnest(v_event.business_ids) with ordinality as x (business_id, ord)
    join public.businesses b on b.id = x.business_id
    join public.business_members m on m.business_id = b.id and m.role = 'owner'
    where m.user_id <> v_event.user_id
      and exists (select 1 from public.push_subscriptions s where s.user_id = m.user_id)
    order by x.ord, m.created_at, m.user_id
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select count(*)::integer into v_push from inserted;

  -- the emails (D13, D14)
  if v_email is not null then
    v_emails := jsonb_build_array(jsonb_build_object(
      'audience', 'user',
      'to', v_email,
      'locale', v_locale,
      'timezone', v_timezone,
      'business_name', null,
      'account_email', v_email
    ));

    v_emails := v_emails || coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'audience', 'owner',
                 'to', o.email,
                 'locale', b.locale,
                 'timezone', b.timezone,
                 'business_name', b.name,
                 'account_email', v_email
               )
               order by b.name, o.email, b.id, o.id
             )
      from (select distinct x.business_id from unnest(v_event.business_ids) as x (business_id)) bx
      join public.businesses b on b.id = bx.business_id
      join public.business_members m on m.business_id = b.id and m.role = 'owner'
      join auth.users o on o.id = m.user_id
      where m.user_id <> v_event.user_id
        and o.email is not null
    ), '[]'::jsonb);
  end if;

  -- the event's businesses for the copy to Nous (B5), in the order of business_ids
  select coalesce(jsonb_agg(jsonb_build_object('name', b.name, 'slug', b.slug) order by x.ord), '[]'::jsonb)
    into v_businesses
  from unnest(v_event.business_ids) with ordinality as x (business_id, ord)
  join public.businesses b on b.id = x.business_id;

  return jsonb_build_object(
    'kind', v_event.kind,
    'detected_at', v_event.detected_at,
    'push_queued', v_push,
    'emails', v_emails,
    'account_email', v_email,
    'businesses', v_businesses
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Detector (0011), replaced: the 0011 body verbatim except
--   step 5  the remove-grant lookup through private.remove_grant_for (the same rule, one place);
--   step 6  also collects, per user, the first factor_removed_unauthorized event this run inserted
--           with non-empty business_ids;
--   step 6b (new) such a user with no vetted verified factor left (none of C that is not flagged by a
--           factor_added_unauthorized event, of any run, this one included) gets a row of
--           private.factor_enrolment_blocks (an existing row is kept) and, when inserted, one audit
--           row factor_enrolment_blocked per business of the event (C1). A block is not an event:
--           the return value and job_runs count events only.
-- ---------------------------------------------------------------------------------------------
create or replace function private.detect_factor_changes_impl(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_started timestamptz;
  v_claims text := current_setting('request.jwt.claims', true);
  v_claim_sub text := current_setting('request.jwt.claim.sub', true);
  v_ids uuid[];
  v_users uuid[];
  v_created timestamptz[];
  v_since timestamptz;
  v_t_ids uuid[];
  v_t_users uuid[];
  v_t_created timestamptz[];
  v_a_ids uuid[];
  v_a_users uuid[];
  v_a_created timestamptz[];
  v_match record;
  v_change record;
  v_grant_id uuid;
  v_kinds text[] := '{}';
  v_event_users uuid[] := '{}';
  v_factors uuid[] := '{}';
  v_factor_created timestamptz[] := '{}';
  v_i integer;
  v_business_ids uuid[];
  v_event_id uuid;
  v_revoke uuid[] := '{}';
  v_user uuid;
  v_count integer := 0;
  v_error text;
  v_block_users uuid[] := '{}';
  v_block_events uuid[] := '{}';
  v_blocked uuid;
begin
  perform set_config('anaklo.actor_type', 'system', true);
  v_started := clock_timestamp();
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  begin
    if p_now is null then
      raise exception 'p_now is required' using errcode = '22023';
    end if;

    -- 1. two runs never interleave: the second sees the first's snapshot
    perform pg_advisory_xact_lock(hashtextextended('detect_factor_changes', 0));

    -- 2. C: read once, kept for the whole run
    select coalesce(array_agg(f.id order by f.created_at, f.id), '{}'::uuid[]),
           coalesce(array_agg(f.user_id order by f.created_at, f.id), '{}'::uuid[]),
           coalesce(array_agg(f.created_at order by f.created_at, f.id), '{}'::timestamptz[])
      into v_ids, v_users, v_created
    from auth.mfa_factors f
    where f.status = 'verified'
      and exists (
        select 1 from public.business_members m
        where m.user_id = f.user_id and m.role in ('owner', 'manager')
      );

    -- 3. transient (review fix). GoTrue writes one `verification_attempted` audit entry per verify
    --    that succeeds (a wrong code writes none), with the factor id, and `factor_in_progress` when the
    --    factor is enrolled. Look-back: from the start of the previous ok run, with 2′ of slack for the
    --    Auth clock and for entries committed late, never before the detector was watched (0011, so
    --    nothing older than the migration) and at most 7 days (mfa_factor_accounted keeps 30).
    select greatest(
             coalesce((select max(j.started_at) from private.job_runs j
                       where j.job = 'detect_factor_changes' and j.ok and j.started_at < p_now),
                      h.watched_since) - interval '2 minutes',
             h.watched_since,
             p_now - interval '7 days')
      into v_since
    from private.health_jobs h
    where h.job = 'detect_factor_changes';
    v_since := coalesce(v_since, p_now - interval '7 days');

    with verified as (
      select case when e.payload -> 'traits' ->> 'factor_id'
                       ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (e.payload -> 'traits' ->> 'factor_id')::uuid end as factor_id,
             case when e.payload ->> 'actor_id'
                       ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (e.payload ->> 'actor_id')::uuid end as user_id,
             e.created_at
      from auth.audit_log_entries e
      where e.created_at >= v_since
        and e.payload ->> 'action' = 'verification_attempted'
    ),
    candidates as (
      select v.factor_id,
             (array_agg(v.user_id order by v.created_at))[1] as user_id,
             min(v.created_at) as verified_at
      from verified v
      where v.factor_id is not null and v.user_id is not null
      group by v.factor_id
    ),
    transient as (
      -- created_at: of the enrolment entry (the factor row is gone), else the first verify
      select c.factor_id, c.user_id,
             coalesce((select min(e.created_at) from auth.audit_log_entries e
                       where e.payload ->> 'action' = 'factor_in_progress'
                         and lower(e.payload -> 'traits' ->> 'factor_id') = c.factor_id::text),
                      c.verified_at) as created_at
      from candidates c
      where not exists (select 1 from auth.mfa_factors f where f.id = c.factor_id)
        and not exists (select 1 from private.mfa_factor_snapshot s where s.factor_id = c.factor_id)
        and not exists (select 1 from private.mfa_factor_accounted a where a.factor_id = c.factor_id)
        and exists (
          select 1 from public.business_members m
          where m.user_id = c.user_id and m.role in ('owner', 'manager')
        )
    )
    select coalesce(array_agg(t.factor_id order by t.created_at, t.factor_id), '{}'::uuid[]),
           coalesce(array_agg(t.user_id order by t.created_at, t.factor_id), '{}'::uuid[]),
           coalesce(array_agg(t.created_at order by t.created_at, t.factor_id), '{}'::timestamptz[])
      into v_t_ids, v_t_users, v_t_created
    from transient t;

    -- 4. added: C minus the snapshot, and the transient factors, in one pass of the add-grant rule
    select coalesce(array_agg(c.id order by c.created_at, c.id), '{}'::uuid[]),
           coalesce(array_agg(c.user_id order by c.created_at, c.id), '{}'::uuid[]),
           coalesce(array_agg(c.created_at order by c.created_at, c.id), '{}'::timestamptz[])
      into v_a_ids, v_a_users, v_a_created
    from unnest(v_ids, v_users, v_created) as c (id, user_id, created_at)
    where not exists (select 1 from private.mfa_factor_snapshot s where s.factor_id = c.id);

    for v_match in
      select m.m_factor_id, m.m_user_id, m.m_created_at, m.m_grant_id
      from private.match_add_grants(v_a_ids || v_t_ids, v_a_users || v_t_users, v_a_created || v_t_created)
             with ordinality as m (m_factor_id, m_user_id, m_created_at, m_grant_id, ord)
      order by m.ord
    loop
      if v_match.m_grant_id is null then
        v_kinds := v_kinds || 'factor_added_unauthorized'::text;
        v_event_users := v_event_users || v_match.m_user_id;
        v_factors := v_factors || v_match.m_factor_id;
        v_factor_created := v_factor_created || v_match.m_created_at;
        continue;
      end if;

      update private.factor_change_grants g set matched_at = p_now where g.id = v_match.m_grant_id;

      -- a transient factor was also removed: that needs its own grant
      if v_match.m_factor_id = any (v_t_ids) then
        select g.id into v_grant_id
        from private.factor_change_grants g
        where g.user_id = v_match.m_user_id
          and g.action = 'remove'
          and g.factor_id = v_match.m_factor_id
          and g.matched_at is null
        order by g.created_at, g.id
        limit 1
        for update;

        if found then
          update private.factor_change_grants g set matched_at = p_now where g.id = v_grant_id;
        else
          v_kinds := v_kinds || 'factor_removed_unauthorized'::text;
          v_event_users := v_event_users || v_match.m_user_id;
          v_factors := v_factors || v_match.m_factor_id;
          v_factor_created := v_factor_created || v_match.m_created_at;
        end if;
      end if;
    end loop;

    -- 5. removed (snapshot rows not in C whose factor no longer exists, any status)
    for v_change in
      select s.factor_id, s.user_id, s.factor_created_at, s.last_seen_at
      from private.mfa_factor_snapshot s
      where not (s.factor_id = any (v_ids))
        and not exists (select 1 from auth.mfa_factors f where f.id = s.factor_id)
      order by s.factor_created_at, s.factor_id
    loop
      -- THE remove-grant rule (0012: one place, private.remove_grant_for; the run's advisory lock
      -- already serialises runs)
      v_grant_id := private.remove_grant_for(v_change.user_id, v_change.factor_id, v_change.last_seen_at);

      if v_grant_id is not null then
        update private.factor_change_grants g set matched_at = p_now
        where g.id = v_grant_id and g.matched_at is null;
      else
        v_kinds := v_kinds || 'factor_removed_unauthorized'::text;
        v_event_users := v_event_users || v_change.user_id;
        v_factors := v_factors || v_change.factor_id;
        v_factor_created := v_factor_created || v_change.factor_created_at;
      end if;
    end loop;

    -- 6. events (one per factor and kind) and their audit rows
    for v_i in 1 .. coalesce(array_length(v_kinds, 1), 0) loop
      select coalesce(
               array_agg(m.business_id order by case m.role when 'owner' then 0 else 1 end, m.created_at, m.business_id),
               '{}'::uuid[]
             )
        into v_business_ids
      from public.business_members m
      where m.user_id = v_event_users[v_i] and m.role in ('owner', 'manager');

      v_event_id := null;
      insert into private.security_events (user_id, kind, factor_id, factor_created_at, business_ids, detected_at)
      values (v_event_users[v_i], v_kinds[v_i], v_factors[v_i], v_factor_created[v_i], v_business_ids, p_now)
      on conflict (kind, factor_id) do nothing
      returning id into v_event_id;

      if v_event_id is not null then
        insert into public.audit_log (business_id, actor_type, actor_id, action, entity, entity_id, reason)
        select x.business_id, 'system', null, v_kinds[v_i], 'auth_user', v_event_users[v_i],
               'factor=' || v_factors[v_i]::text
        from unnest(v_business_ids) with ordinality as x (business_id, ord)
        order by x.ord;

        v_count := v_count + 1;
        if not (v_event_users[v_i] = any (v_revoke)) then
          v_revoke := v_revoke || v_event_users[v_i];
        end if;

        -- 0012: the first removal event per user that has businesses, for step 6b
        if v_kinds[v_i] = 'factor_removed_unauthorized'
           and cardinality(v_business_ids) > 0
           and not (v_event_users[v_i] = any (v_block_users)) then
          v_block_users := v_block_users || v_event_users[v_i];
          v_block_events := v_block_events || v_event_id;
        end if;
      end if;
    end loop;

    -- 6b. enrolment block (0012, C1): a user whose unauthorized removal left no vetted verified
    --     factor (none of C that a factor_added_unauthorized event, of any run, flags) may not add a
    --     device until Nous resets the account; an existing block is kept. When inserted, one audit
    --     row per business of the event, in its order.
    for v_i in 1 .. coalesce(array_length(v_block_users, 1), 0) loop
      if not exists (
        select 1
        from unnest(v_ids, v_users) as c (id, user_id)
        where c.user_id = v_block_users[v_i]
          and not exists (
            select 1 from private.security_events x
            where x.factor_id = c.id and x.kind = 'factor_added_unauthorized'
          )
      ) then
        v_blocked := null;
        insert into private.factor_enrolment_blocks (user_id, event_id, blocked_at)
        values (v_block_users[v_i], v_block_events[v_i], p_now)
        on conflict (user_id) do nothing
        returning user_id into v_blocked;

        if v_blocked is not null then
          insert into public.audit_log (business_id, actor_type, actor_id, action, entity, entity_id, reason)
          select x.business_id, 'system', null, 'factor_enrolment_blocked', 'auth_user', v_block_users[v_i],
                 'event=' || v_block_events[v_i]::text
          from private.security_events e
          cross join lateral unnest(e.business_ids) with ordinality as x (business_id, ord)
          where e.id = v_block_events[v_i]
          order by x.ord;
        end if;
      end if;
    end loop;

    -- 7. containment at detection (D9): sessions and push devices, once per user
    foreach v_user in array v_revoke loop
      perform private.revoke_user_sessions_impl(v_user);
    end loop;

    -- 8. snapshot := C; what leaves it, and every transient factor, is accounted for
    with gone as (
      delete from private.mfa_factor_snapshot s
      where not (s.factor_id = any (v_ids))
      returning s.factor_id, s.user_id
    )
    insert into private.mfa_factor_accounted as a (factor_id, user_id, accounted_at)
    select distinct on (x.factor_id) x.factor_id, x.user_id, p_now
    from (
      select g.factor_id, g.user_id from gone g
      union all
      select t.id, t.user_id from unnest(v_t_ids, v_t_users) as t (id, user_id)
    ) x
    where exists (select 1 from auth.users u where u.id = x.user_id)
    order by x.factor_id
    on conflict (factor_id) do update set accounted_at = excluded.accounted_at;

    insert into private.mfa_factor_snapshot as s (factor_id, user_id, factor_created_at, first_seen_at, last_seen_at)
    select c.id, c.user_id, c.created_at, p_now, p_now
    from unnest(v_ids, v_users, v_created) as c (id, user_id, created_at)
    where exists (select 1 from auth.users u where u.id = c.user_id)
    on conflict (factor_id) do update set last_seen_at = excluded.last_seen_at;

    -- 9. dispatch claims the events right after commit (the sweep's nudge is the fallback)
    if v_count > 0 then
      perform private.nudge_dispatch('security');
    end if;
  exception when others then
    v_error := sqlstate;
  end;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_claim_sub, ''), true);

  if v_error is not null then
    perform private.record_job_run('detect_factor_changes', v_started, false, null, v_error);
    return null;
  end if;
  perform private.record_job_run('detect_factor_changes', v_started, true, v_count);
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC: authorize_factor_change (0009), replaced: a dead session → 42501 without hint, right after
-- the auth.uid() check (A4) and again once the factors lock is held (review fix: a reset that
-- committed while the call waited); add while the caller's enrolment is blocked → AN034, after the
-- factors lock and before the fresh-code check (C3: never the code sheet). Nothing is written on
-- any refusal. remove is otherwise unchanged.
-- ---------------------------------------------------------------------------------------------
create or replace function private.authorize_factor_change_impl(p_action text, p_factor_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_grant_id uuid;
begin
  if v_uid is null then
    raise exception 'a signed-in user is required' using errcode = '42501';
  end if;
  -- 0012 (A4): a revoked session never reaches the code sheet
  if not private.session_alive() then
    raise exception 'the session has ended' using errcode = '42501';
  end if;
  if not private.is_privileged_anywhere(v_uid) then
    raise exception 'only an owner or a manager has devices for codes' using errcode = '42501';
  end if;

  if p_action is null or p_action not in ('add', 'remove') then
    raise exception 'p_action is add or remove' using errcode = '22023';
  end if;
  if p_action = 'remove' and p_factor_id is null then
    raise exception 'remove needs p_factor_id' using errcode = '22023';
  end if;
  if p_action = 'add' and p_factor_id is not null then
    raise exception 'add takes no p_factor_id' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('factors:' || v_uid::text, 0));

  -- 0012 review fix: the session again, under the lock. A Nous reset ends the user's sessions in the
  -- transaction that lifts the block, holding this lock; a call that passed the first check and waited
  -- here must not take the first-enrolment grant once that reset commits.
  if not private.session_alive() then
    raise exception 'the session has ended' using errcode = '42501';
  end if;

  if p_action = 'remove' then
    if not exists (
      select 1 from auth.mfa_factors f
      where f.id = p_factor_id and f.user_id = v_uid and f.status = 'verified'
    ) then
      raise exception 'not a verified factor of the caller' using errcode = '42501';
    end if;
    -- After this removal at least one other verified factor must remain that is not already
    -- being removed (two parallel removals of a user's two factors cannot both pass).
    if not exists (
      select 1 from auth.mfa_factors f
      where f.user_id = v_uid and f.status = 'verified' and f.id <> p_factor_id
        and not exists (
          select 1 from private.factor_change_grants g
          where g.user_id = v_uid and g.action = 'remove' and g.factor_id = f.id
            and g.matched_at is null and g.expires_at > now()
        )
    ) then
      perform private.raise_domain_error('AN027');
    end if;
    perform private.require_fresh_totp();
  -- 0012 (C3): add while blocked → AN034, before the fresh-code check (never the code sheet)
  elsif private.enrolment_blocked(v_uid) then
    perform private.raise_domain_error('AN034');
  elsif exists (select 1 from auth.mfa_factors f where f.user_id = v_uid and f.status = 'verified') then
    perform private.require_fresh_totp();
  end if;

  v_grant_id := private.write_factor_grant(v_uid, p_action, p_factor_id, 'user');

  insert into public.audit_log (business_id, actor_type, actor_id, action, entity, entity_id, reason)
  select m.business_id, 'staff', v_uid,
         case p_action when 'add' then 'factor_add_authorized' else 'factor_remove_authorized' end,
         'auth_factor', p_factor_id, null
  from public.business_members m
  where m.user_id = v_uid and m.role in ('owner', 'manager')
  order by m.business_id;

  return (
    select jsonb_build_object(
      'grant_id', g.id,
      'user_id', g.user_id,
      'action', g.action,
      'factor_id', g.factor_id,
      'expires_at', g.expires_at
    )
    from private.factor_change_grants g
    where g.id = v_grant_id
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC (service_role): record_support_action (0009), replaced. mfa_reset refuses while an
-- unauthorized removal of the user awaits detection (55000, hint detection_pending, nothing
-- written: a reset over it would be followed by a block at the next run), lifts the user's
-- enrolment block in its transaction (C4) and, in the same transaction, ends every session of the
-- user and its push devices (review fix: no session ever sees the block lifted); the result gains
-- enrolment_unblocked, sessions and push_subscriptions. provision_update and its result are
-- unchanged.
-- Contract §7 item 17, the alternative approved on 2026-10-04: a user who is owner/manager nowhere
-- any more (demoted to staff, or removed) but still has a block row is reset too, so Nous can
-- always lift a block (a blocked staff-only user can neither register nor unregister a push
-- device, A3). Who may be reset IS where the reset is recorded: the audit businesses, read by ONE
-- statement (one snapshot) under the factors lock and before anything is written: the businesses
-- where the user is owner/manager (0009, unchanged); when there is none and the user has a block
-- row, the businesses where the user is still a member and those of the block's removal event that
-- still exist, each once (the businesses the block protected). An empty list → 22023 and nothing
-- written, whatever the reason (owner/manager nowhere without a block, as in 0009; a member nowhere
-- whose event was purged: such a block has no effect until the user joins a business again), so a
-- reset is never unrecorded. The factors lock orders concurrent resets and authorize_factor_change;
-- it does NOT order a demotion or a removal (the D1 trigger takes only members:<business>), which
-- may commit at any instant of this call: eligibility and the audit list therefore come from the
-- same snapshot (review fix: two statements, an eligibility check and then the list, could see the
-- user privileged and then nowhere, and write a reset with no audit row).
-- ---------------------------------------------------------------------------------------------
create or replace function private.record_support_action_impl(
  p_action text,
  p_reason text,
  p_ticket text,
  p_user_id uuid default null,
  p_business_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reason text := btrim(p_reason);
  v_ticket text := btrim(p_ticket);
  v_audit_reason text;
  v_factor_ids uuid[];
  v_factor_id uuid;
  v_audit_rows integer;
  v_unblocked boolean;
  v_revoked jsonb;
  v_audit_businesses uuid[];
  v_block_only boolean;
begin
  if p_action is null or p_action not in ('mfa_reset', 'provision_update') then
    raise exception 'p_action is mfa_reset or provision_update' using errcode = '22023';
  end if;
  if v_reason is null or char_length(v_reason) not between 3 and 400 then
    raise exception 'p_reason is 3–400 characters' using errcode = '22023';
  end if;
  if v_ticket is null or v_ticket !~ '^[A-Za-z0-9][A-Za-z0-9._#/-]{0,39}$' then
    raise exception 'p_ticket is 1–40 of A-Z, a-z, 0-9 and ._#/- (alphanumeric first)' using errcode = '22023';
  end if;
  v_audit_reason := '[' || v_ticket || '] ' || v_reason;

  if p_action = 'mfa_reset' then
    if p_user_id is null or p_business_id is not null
       or not exists (select 1 from auth.users u where u.id = p_user_id) then
      raise exception 'mfa_reset needs an existing p_user_id and no p_business_id' using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('factors:' || p_user_id::text, 0));

    -- 0012 (§7 item 17, review fix): who may be reset and where it is recorded, in ONE statement (one
    -- snapshot: a demotion or removal committing during this call cannot make the two disagree), under
    -- the lock and before anything is written, while the block row (and its event) is still there:
    -- the owner/manager businesses (0009); none → for a user with a block row, the businesses where
    -- the user is still a member and the existing ones of the block's removal event, each once.
    with privileged as (
      select m.business_id
      from public.business_members m
      where m.user_id = p_user_id and m.role in ('owner', 'manager')
    ),
    block as (
      select b.event_id
      from private.factor_enrolment_blocks b
      where b.user_id = p_user_id
        and not exists (select 1 from privileged)
    )
    select coalesce(array_agg(x.business_id order by x.business_id), array[]::uuid[]),
           exists (select 1 from block)
      into v_audit_businesses, v_block_only
    from (
      select p.business_id
      from privileged p
      union
      select m.business_id
      from public.business_members m
      where m.user_id = p_user_id
        and exists (select 1 from block)
      union
      select e.business_id
      from block bl
      join private.security_events ev on ev.id = bl.event_id
      cross join lateral unnest(ev.business_ids) as e (business_id)
      where exists (select 1 from public.businesses x where x.id = e.business_id)
    ) x;

    -- no business to record it in → nothing written, for every reason (a reset is never unrecorded)
    if cardinality(v_audit_businesses) = 0 then
      if v_block_only then
        raise exception 'the user is a member of no business and its block names none: the reset cannot be recorded'
          using errcode = '22023';
      end if;
      raise exception 'the user is owner or manager nowhere and has no enrolment block: nothing to reset'
        using errcode = '22023';
    end if;

    -- 0012 (C4): never over an unauthorized removal the detector has not seen yet
    if private.unauthorized_removal_pending(p_user_id) then
      raise exception 'an unauthorized device change of this user awaits detection; try again after the next detector run'
        using errcode = '55000', hint = 'detection_pending';
    end if;

    select coalesce(array_agg(f.id order by f.created_at, f.id), array[]::uuid[]) into v_factor_ids
    from auth.mfa_factors f
    where f.user_id = p_user_id;

    foreach v_factor_id in array v_factor_ids loop
      perform private.write_factor_grant(p_user_id, 'remove', v_factor_id, 'nous_support');
    end loop;

    -- 0012 (C4): Nous verified the person: the enrolment block goes
    delete from private.factor_enrolment_blocks b where b.user_id = p_user_id;
    v_unblocked := found;

    -- 0012 review fix: every session of the user (and its push devices) ends in this transaction, so no
    -- session that saw the block ever sees it lifted: whoever holds the mailbox and waits signed in on
    -- «Επικοινώνησε με τη Nous» would otherwise take the first-enrolment add grant (no device, no
    -- block) before the script's own revoke_user_sessions. Under the factors lock, like
    -- authorize_factor_change, which checks the session again once it holds that lock.
    v_revoked := private.revoke_user_sessions_impl(p_user_id);

    -- one row per business read above (0009: the owner/manager ones; §7 item 17: see the header)
    insert into public.audit_log (business_id, actor_type, actor_id, action, entity, entity_id, reason)
    select x.business_id, 'nous_support', null, 'mfa_reset', 'auth_user', p_user_id, v_audit_reason
    from unnest(v_audit_businesses) as x (business_id)
    order by x.business_id;
    get diagnostics v_audit_rows = row_count;

    return jsonb_build_object(
      'action', p_action,
      'factor_ids', to_jsonb(v_factor_ids),
      'grants', cardinality(v_factor_ids),
      'audit_rows', v_audit_rows,
      'enrolment_unblocked', v_unblocked,
      'sessions', (v_revoked ->> 'sessions')::integer,
      'push_subscriptions', (v_revoked ->> 'push_subscriptions')::integer
    );
  end if;

  -- provision_update
  if p_business_id is null or p_user_id is not null
     or not exists (select 1 from public.businesses b where b.id = p_business_id) then
    raise exception 'provision_update needs an existing p_business_id and no p_user_id' using errcode = '22023';
  end if;

  insert into public.audit_log (business_id, actor_type, actor_id, action, entity, entity_id, reason)
  values (p_business_id, 'nous_support', null, 'provision_update', 'business', p_business_id, v_audit_reason);

  return jsonb_build_object(
    'action', p_action,
    'factor_ids', '[]'::jsonb,
    'grants', 0,
    'audit_rows', 1
  );
end;
$$;

comment on function public.authorize_factor_change(text, uuid) is
  'Security: permission (10 minutes) to add a device for codes, or to remove one of the caller''s verified devices through manage-factors. Returns {grant_id, user_id, action, factor_id, expires_at}; the last device → AN027; add while blocked until Nous resets the account → AN034.';

comment on function public.record_support_action(text, text, text, uuid, uuid) is
  'Nous scripts (service_role): record an mfa_reset of an owner/manager, or of a user who is that nowhere any more but still blocked (removal grants + audit per business, lifts the enrolment block and ends every session of the user in the same transaction; refused with 55000 detection_pending while an unauthorized removal awaits detection) or a provision_update (audit), with reason and ticket. Returns {action, factor_ids, grants, audit_rows} (+ enrolment_unblocked, sessions, push_subscriptions for mfa_reset).';

-- ---------------------------------------------------------------------------------------------
-- RPC: factor_enrolment_blocked (§2.5). The caller's own state, no membership needed (the app's
-- loader asks before any membership counts): whether the caller may not add an authenticator
-- device until Nous resets the account. No p_business_id, no p_now.
-- ---------------------------------------------------------------------------------------------
create function private.factor_enrolment_blocked_impl()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'a signed-in user is required' using errcode = '42501';
  end if;
  if not private.session_alive() then
    raise exception 'the session has ended' using errcode = '42501';
  end if;
  return private.enrolment_blocked(v_uid);
end;
$$;

create function public.factor_enrolment_blocked()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.factor_enrolment_blocked_impl();
$$;

comment on function public.factor_enrolment_blocked() is
  'Security: whether the caller may not add an authenticator device until Nous resets it (AN034).';

-- ---------------------------------------------------------------------------------------------
-- Grants (§2.7). authenticated: factor_enrolment_blocked and its _impl. service_role, anon: nothing
-- new. Nobody: session_alive, remove_grant_for, unauthorized_removal_pending, enrolment_blocked,
-- mfa_level_ok; the replaced internals keep none (session_mfa_ok, require_fresh_totp,
-- match_add_grants, queue_security_notifications, detect_factor_changes_impl, raise_domain_error).
-- The six membership helpers keep their 0001 grants (authenticated, service_role).
-- ---------------------------------------------------------------------------------------------
grant execute on function private.factor_enrolment_blocked_impl() to authenticated;
grant execute on function public.factor_enrolment_blocked() to authenticated;
