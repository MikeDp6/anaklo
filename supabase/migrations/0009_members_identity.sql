-- 0009_members_identity.sql
-- Security and members (SPEC §5, §7, §11; ADR-0005, ADR-0009; Phase 1 plan step 1.7).
-- Contract: docs/plans/contracts/1.7-security-members.md (§2 is this file).
--
--   private.platform_settings         fresh_totp_max_age_seconds: the fresh-code window (0–300 s)
--   business_slug_aliases             former slugs that still lead to their business (301)
--   private.factor_change_grants      permission for one change of a user's authenticator devices
--   businesses_slug_guard             a slug or alias never passes to another business
--   business_members                  authenticated keeps SELECT only: every change through an RPC
--   private.has_fresh_totp,           the fresh-code rule (C6): aal2 and a `totp` entry of the JWT
--   private.require_fresh_totp          `amr` within the window. The ONLY place of the rule (rule 13)
--   D2                                owner/manager memberships need aal2 once the user has a
--                                     verified factor (private.session_mfa_ok in the 0001 helpers),
--                                     and so do the user's push devices (register/unregister)
--   business_members_access_changed   every delete of a membership and every change of its role
--                                     revokes all sessions of the user (and drops the push rows) and,
--                                     when the user is owner/manager nowhere afterwards, deletes the
--                                     user's factors with a 'demotion' grant each (D1)
--   public_booking_catalogue          also answers for a former slug (the current business)
--   lock_local_days (0004)            reads the zone FOR KEY SHARE: a booking or move in flight and
--                                     a change of time zone never interleave (D8)
--
-- API (thin SECURITY INVOKER wrappers in public, SECURITY DEFINER _impl in private):
--   authenticated: can_manage_members, set_member_role, remove_member, list_members,
--                  change_business_identity (owner; all but list_members need a fresh code),
--                  authorize_factor_change (the caller's own factors; no p_business_id)
--   service_role:  add_member, record_support_action, user_id_for_email, revoke_user_sessions
-- Check order in every authenticated _impl with p_business_id: membership → role → fresh code
-- (private.require_fresh_totp(): 42501 with hint aal2_required | fresh_totp_required) → entity ids
-- and argument shape → the operation. No actor is declared anywhere: nothing here writes
-- appointments. Audit rows: contract §2.1.

-- ---------------------------------------------------------------------------------------------
-- Domain errors: AN024–AN031 join the list. The same list lives in
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
  end;
begin
  if v_name is null then
    raise exception 'unknown domain error code %', p_code using errcode = '22023';
  end if;
  raise exception using errcode = 'P0001', message = p_code, hint = v_name;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------------------------

-- The fresh-code window (plan 1.7 C6). The CHECK lets the setting only tighten the rule: 0 is
-- the platform brake (never fresh), 300 the default. The local/e2e seed sets 10 (seed.sql); a
-- remote database needs 300 back after any reset (step 1.10).
alter table private.platform_settings
  add column fresh_totp_max_age_seconds integer not null default 300
    constraint platform_settings_fresh_totp_max_age_seconds check (fresh_totp_max_age_seconds between 0 and 300);

-- A former slug that still leads to its business (D7): public_booking_catalogue resolves it to the
-- current business, the Worker answers 301. Kept forever in Phase 1. Written only by
-- change_business_identity_impl (definer); service_role reads it (provisioning's check, e2e).
create table public.business_slug_aliases (
  slug text primary key
    constraint business_slug_aliases_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  business_id uuid not null references public.businesses (id) on delete restrict,
  created_at timestamptz not null default now()
);

create index business_slug_aliases_business_idx on public.business_slug_aliases (business_id);

comment on table public.business_slug_aliases is
  'Former slugs of a business (301 to the current one). Never passed to another business; only change_business_identity writes.';

alter table public.business_slug_aliases enable row level security;
revoke all on table public.business_slug_aliases from public, anon, authenticated, service_role;

create policy business_slug_aliases_select on public.business_slug_aliases for select to authenticated
  using (business_id in (select private.my_business_ids()));

grant select on public.business_slug_aliases to authenticated, service_role;

-- Permission for one change of a user's authenticator devices (ADR-0009, plan 1.7). The app
-- never reads it; 1.9's detector matches GoTrue's factor changes against it (matched_at).
create table private.factor_change_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null constraint factor_change_grants_action check (action in ('add', 'remove')),
  -- remove: the factor; add: null (not known yet)
  factor_id uuid,
  source text not null constraint factor_change_grants_source
    check (source in ('user', 'nous_support', 'demotion', 'system')),
  created_at timestamptz not null default now(),
  -- created_at + 10 minutes, set by private.write_factor_grant
  expires_at timestamptz not null,
  -- written by the 1.9 detector
  matched_at timestamptz,
  constraint factor_change_grants_factor check ((action = 'remove') = (factor_id is not null))
);

create index factor_change_grants_user_idx on private.factor_change_grants (user_id, created_at);

comment on table private.factor_change_grants is
  'One permitted add/remove of a user''s authenticator device (10 minutes). Written only by private.write_factor_grant.';

alter table private.factor_change_grants enable row level security;
revoke all on table private.factor_change_grants from public, anon, authenticated, service_role;

-- A slug never passes to another business (D7): a business may not take a slug that is an alias
-- of ANOTHER business (its own former slug it may take back). The backstop of
-- change_business_identity and of provisioning (service_role writes businesses directly).
-- Definer: the writer may hold no privilege on the alias table.
create function private.businesses_slug_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.business_slug_aliases a
    where a.slug = new.slug and a.business_id <> new.id
  ) then
    raise exception 'slug % is a former address of another business', new.slug
      using errcode = '23505', constraint = 'businesses_slug_not_alias';
  end if;
  return new;
end;
$$;

create trigger businesses_slug_guard
  before insert or update of slug on public.businesses
  for each row execute function private.businesses_slug_guard();

-- Members change only through the RPCs below (plan 1.7): a DELETE or UPDATE that fails a
-- restrictive policy touches 0 rows without an error (no step-up, no message). SELECT stays;
-- service_role keeps its grants (provisioning). The permissive insert/update/delete policies and
-- the restrictive aal2 policies of 0001 stay as the second line of defence.
revoke insert, update, delete on public.business_members from authenticated;

-- ---------------------------------------------------------------------------------------------
-- Fresh code (C6). Private, no grants: only definer _impls call them. An `amr` entry is
-- { "method": "<otp|totp|…>", "timestamp": <epoch seconds> }; entries are looked up by method,
-- never by position (day 1: `totp` may come first). Entries that are not objects, have another
-- method or a non-numeric timestamp are ignored. The transaction clock decides; no upper bound.
-- ---------------------------------------------------------------------------------------------
create function private.has_fresh_totp()
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_claims jsonb := auth.jwt();
  v_window integer;
  v_at numeric;
begin
  if coalesce(v_claims ->> 'aal', '') <> 'aal2' then
    return false;
  end if;

  select s.fresh_totp_max_age_seconds into v_window from private.platform_settings s where s.id;
  if v_window is null or v_window <= 0 then
    return false;
  end if;

  if jsonb_typeof(v_claims -> 'amr') is distinct from 'array' then
    return false;
  end if;

  select max((e.entry ->> 'timestamp')::numeric) into v_at
  from jsonb_array_elements(v_claims -> 'amr') as e (entry)
  where jsonb_typeof(e.entry) = 'object'
    and e.entry ->> 'method' = 'totp'
    and jsonb_typeof(e.entry -> 'timestamp') = 'number';

  return v_at is not null and v_at >= extract(epoch from now()) - v_window;
end;
$$;

create function private.require_fresh_totp()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
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

-- ---------------------------------------------------------------------------------------------
-- Membership helpers (D2). An owner/manager membership counts only when the session is aal2 or
-- the user has no verified factor yet (first sign-in, after an mfa-reset): a stolen email code
-- alone (aal1) of an enrolled owner reads nothing and every RPC answers 42501 without a hint
-- (→ the app's challenge). Staff memberships always count (staff never enrol, ADR-0009 §18).
-- ---------------------------------------------------------------------------------------------
create function private.session_mfa_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = (select auth.uid()) and f.status = 'verified'
      );
$$;

-- Same signatures as 0001 (grants kept); each adds the D2 filter, nothing else changes.
create or replace function private.my_business_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.business_id from public.business_members m
  where m.user_id = (select auth.uid())
    and (m.role = 'staff' or (select private.session_mfa_ok()));
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
    and (m.role = 'staff' or (select private.session_mfa_ok()));
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
    and (m.role = 'staff' or (select private.session_mfa_ok()));
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
      and (m.role = 'staff' or (select private.session_mfa_ok()))
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
      and (m.role = 'staff' or (select private.session_mfa_ok()))
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
    and (m.role = 'staff' or (select private.session_mfa_ok()));
$$;

-- The caller always reads their own membership rows, also at aal1 (the app's loader needs the
-- role to send an enrolled owner to the code screen).
drop policy business_members_select on public.business_members;
create policy business_members_select on public.business_members for select to authenticated
  using (user_id = (select auth.uid()) or business_id in (select private.my_business_ids()));

-- D2 also covers the user's push devices (review fix). A device registered by the user receives
-- the pushes of EVERY business of the user (private.push_recipients), so registering one needs the
-- level of the user's strongest membership: session_mfa_ok (aal2 once enrolled) and a membership
-- that counts. Without it a stolen email code (aal1) of an enrolled owner registers its own
-- OneSignal subscription and receives client names and times of every booking. Unregistering
-- needs the same level (the user's own rows are readable at aal1, so one id at a time would do
-- what p_all does): a stolen code cannot silently cut the real owner's devices either. The
-- device's own opt-out (OneSignal) never depends on it. Bodies otherwise as in 0007.
create or replace function private.register_push_subscription_impl(
  p_provider text,
  p_subscription_id text,
  p_endpoint text,
  p_p256dh text,
  p_auth text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_subscription_id text := lower(p_subscription_id);
  v_existing public.push_subscriptions%rowtype;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if not private.session_mfa_ok() or not exists (select 1 from private.my_business_ids()) then
    raise exception 'not a member of any business' using errcode = '42501';
  end if;

  if p_provider is null or p_provider not in ('onesignal', 'vapid')
     or (p_provider = 'onesignal' and not (
           v_subscription_id is not null
           and v_subscription_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           and p_endpoint is null and p_p256dh is null and p_auth is null))
     or (p_provider = 'vapid' and not (
           p_subscription_id is null
           and p_endpoint is not null and p_endpoint ~ '^https://' and char_length(p_endpoint) <= 2048
           and p_p256dh is not null and p_p256dh ~ '^[A-Za-z0-9_-]{80,100}$'
           and p_auth is not null and p_auth ~ '^[A-Za-z0-9_-]{16,32}$')) then
    raise exception 'invalid push subscription' using errcode = '22023';
  end if;

  loop
    if p_provider = 'onesignal' then
      select s.* into v_existing from public.push_subscriptions s where s.subscription_id = v_subscription_id for update;
    else
      select s.* into v_existing from public.push_subscriptions s where s.endpoint = p_endpoint for update;
    end if;

    if found then
      update public.push_subscriptions s
      set user_id = v_uid,
          p256dh = case when p_provider = 'vapid' then p_p256dh end,
          auth_secret = case when p_provider = 'vapid' then p_auth end,
          updated_at = now()
      where s.id = v_existing.id;
      return jsonb_build_object('id', v_existing.id, 'moved', v_existing.user_id <> v_uid);
    end if;

    insert into public.push_subscriptions (user_id, provider, subscription_id, endpoint, p256dh, auth_secret)
    values (
      v_uid, p_provider,
      case when p_provider = 'onesignal' then v_subscription_id end,
      case when p_provider = 'vapid' then p_endpoint end,
      case when p_provider = 'vapid' then p_p256dh end,
      case when p_provider = 'vapid' then p_auth end
    )
    on conflict do nothing
    returning id into v_id;
    if v_id is not null then
      return jsonb_build_object('id', v_id, 'moved', false);
    end if;
    -- a concurrent registration of the same subscription won: take it over in the next round
  end loop;
end;
$$;

create or replace function private.unregister_push_subscription_impl(
  p_subscription_id text,
  p_endpoint text,
  p_all boolean
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_count integer;
begin
  if v_uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  -- No membership needed (sign-out of a removed member), but an enrolled user's aal2 (D2).
  if not private.session_mfa_ok() then
    raise exception 'a code from the authenticator app is required first' using errcode = '42501';
  end if;

  if coalesce(p_all, false) then
    return private.drop_push_subscriptions(v_uid);
  end if;

  if (p_subscription_id is null) = (p_endpoint is null) then
    raise exception 'give exactly one of p_subscription_id and p_endpoint' using errcode = '22023';
  end if;

  delete from public.push_subscriptions s
  where s.user_id = v_uid
    and (s.subscription_id = lower(p_subscription_id) or s.endpoint = p_endpoint);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Internal helpers and the membership trigger (private, no grants unless stated)
-- ---------------------------------------------------------------------------------------------

-- The only writer of factor_change_grants in 1.7. Valid for 10 minutes.
create function private.write_factor_grant(p_user_id uuid, p_action text, p_factor_id uuid, p_source text)
returns uuid
language sql
volatile
set search_path = ''
as $$
  insert into private.factor_change_grants (user_id, action, factor_id, source, created_at, expires_at)
  values (p_user_id, p_action, p_factor_id, p_source, now(), now() + interval '10 minutes')
  returning id;
$$;

-- Owner or manager in any business (a direct read, never the D2 helpers: it is about the user,
-- not about the current session).
create function private.is_privileged_anywhere(p_user_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.business_members m
    where m.user_id = p_user_id and m.role in ('owner', 'manager')
  );
$$;

-- Ends every session of a user: refresh tokens and amr claims go with the sessions (cascade), and
-- the user's push devices go too (1.5 D13). An access token already issued lives until it
-- expires (≤ 1 h), but roles are read live from business_members on every request. Shared by the
-- membership trigger, revoke_user_sessions (mfa-reset) and 1.9's reaction. Granted to service_role.
create function private.revoke_user_sessions_impl(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sessions integer;
  v_push integer;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;

  delete from auth.sessions s where s.user_id = p_user_id;
  get diagnostics v_sessions = row_count;

  v_push := private.drop_push_subscriptions(p_user_id);

  return jsonb_build_object('sessions', v_sessions, 'push_subscriptions', v_push);
end;
$$;

-- Staff never keep a factor (ADR-0009 §18): when the user is owner/manager nowhere, every factor of
-- the user (any status) goes, each with a `remove` grant of p_source first (so 1.9's detector does
-- not flag it). 0 when the user no longer exists (a cascade from auth.users) or is still
-- owner/manager somewhere. Callers revoke the sessions first in the same transaction, so no
-- session is left pointing at a deleted factor. Returns the number of factors deleted.
create function private.drop_factors_if_unprivileged(p_user_id uuid, p_source text)
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_factor_id uuid;
  v_count integer;
begin
  if p_user_id is null
     or not exists (select 1 from auth.users u where u.id = p_user_id)
     or private.is_privileged_anywhere(p_user_id) then
    return 0;
  end if;

  for v_factor_id in
    select f.id from auth.mfa_factors f where f.user_id = p_user_id order by f.created_at, f.id
  loop
    perform private.write_factor_grant(p_user_id, 'remove', v_factor_id, p_source);
  end loop;

  -- challenges go by cascade
  delete from auth.mfa_factors f where f.user_id = p_user_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- D1: the security effects of a membership change live here, so set_member_role/remove_member and
-- provisioning (service_role) all get them in the same transaction. Same condition as the 0007 push
-- trigger (which stays; dropping the push rows twice is harmless). An insert does nothing.
-- Definer: the writer (an RPC's definer, or service_role) needs no privilege on auth.*.
create function private.business_members_access_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform private.revoke_user_sessions_impl(old.user_id);
    perform private.drop_factors_if_unprivileged(old.user_id, 'demotion');
  elsif (new.role, new.user_id, new.business_id) is distinct from (old.role, old.user_id, old.business_id) then
    perform private.revoke_user_sessions_impl(old.user_id);
    perform private.drop_factors_if_unprivileged(old.user_id, 'demotion');
  end if;
  return null;
end;
$$;

create trigger business_members_access_changed
  after delete or update of role, user_id, business_id on public.business_members
  for each row execute function private.business_members_access_changed();

-- ---------------------------------------------------------------------------------------------
-- RPC: can_manage_members (§2.6). Owner with a fresh code; true or raises. The check that
-- invite-member runs as the caller before it creates a service_role client.
-- ---------------------------------------------------------------------------------------------
create function private.can_manage_members_impl(p_business_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if not private.has_role(p_business_id, array['owner']) then
    raise exception 'only the owner may manage members' using errcode = '42501';
  end if;
  perform private.require_fresh_totp();
  return true;
end;
$$;

create function public.can_manage_members(p_business_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.can_manage_members_impl(p_business_id);
$$;

comment on function public.can_manage_members(uuid) is
  'Members: true when the caller is an owner of the business with a fresh code; otherwise 42501 (hint aal2_required | fresh_totp_required when only the code is missing).';

-- ---------------------------------------------------------------------------------------------
-- RPC: set_member_role (§2.6). Owner with a fresh code. The members lock serialises the
-- last-owner check (two owners demoting each other concurrently would otherwise both see the
-- other still owner; the deferred ensure_business_has_owner is only the backstop). The trigger
-- business_members_access_changed revokes the target's sessions and push rows and, when the user
-- is owner/manager nowhere afterwards, deletes the factors. Same role → nothing written (D9).
-- ---------------------------------------------------------------------------------------------
create function private.set_member_role_impl(p_business_id uuid, p_user_id uuid, p_role text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old text;
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if not private.has_role(p_business_id, array['owner']) then
    raise exception 'only the owner may change roles' using errcode = '42501';
  end if;
  perform private.require_fresh_totp();
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('owner', 'manager', 'staff') then
    raise exception 'p_role is owner, manager or staff' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('members:' || p_business_id::text, 0));

  select m.role into v_old
  from public.business_members m
  where m.business_id = p_business_id and m.user_id = p_user_id
  for update;
  if not found then
    perform private.raise_domain_error('AN030');
  end if;

  if v_old = p_role then
    return jsonb_build_object('user_id', p_user_id, 'role', p_role, 'previous_role', v_old, 'changed', false);
  end if;

  if v_old = 'owner' and not exists (
    select 1 from public.business_members m
    where m.business_id = p_business_id and m.role = 'owner' and m.user_id <> p_user_id
  ) then
    perform private.raise_domain_error('AN026');
  end if;

  update public.business_members m
  set role = p_role
  where m.business_id = p_business_id and m.user_id = p_user_id;

  insert into public.audit_log (business_id, actor_type, actor_id, action, entity, entity_id, reason)
  values (p_business_id, 'staff', (select auth.uid()), 'member_role_changed', 'business_member', p_user_id,
          v_old || ':' || p_role);

  return jsonb_build_object('user_id', p_user_id, 'role', p_role, 'previous_role', v_old, 'changed', true);
end;
$$;

create function public.set_member_role(p_business_id uuid, p_user_id uuid, p_role text)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.set_member_role_impl(p_business_id, p_user_id, p_role);
$$;

comment on function public.set_member_role(uuid, uuid, text) is
  'Members: change a member''s role (owner, fresh code). Ends all the user''s sessions; demoted to staff everywhere → factors deleted. Returns {user_id, role, previous_role, changed}; the last owner → AN026, not a member → AN030.';

-- ---------------------------------------------------------------------------------------------
-- RPC: remove_member (§2.6). Owner with a fresh code. The staff row of the calendar stays. Not a
-- member → removed: false, nothing written (D9).
-- ---------------------------------------------------------------------------------------------
create function private.remove_member_impl(p_business_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old text;
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if not private.has_role(p_business_id, array['owner']) then
    raise exception 'only the owner may remove members' using errcode = '42501';
  end if;
  perform private.require_fresh_totp();
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('members:' || p_business_id::text, 0));

  select m.role into v_old
  from public.business_members m
  where m.business_id = p_business_id and m.user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('user_id', p_user_id, 'removed', false);
  end if;

  if v_old = 'owner' and not exists (
    select 1 from public.business_members m
    where m.business_id = p_business_id and m.role = 'owner' and m.user_id <> p_user_id
  ) then
    perform private.raise_domain_error('AN026');
  end if;

  delete from public.business_members m
  where m.business_id = p_business_id and m.user_id = p_user_id;

  insert into public.audit_log (business_id, actor_type, actor_id, action, entity, entity_id, reason)
  values (p_business_id, 'staff', (select auth.uid()), 'member_removed', 'business_member', p_user_id, v_old);

  return jsonb_build_object('user_id', p_user_id, 'removed', true, 'previous_role', v_old);
end;
$$;

create function public.remove_member(p_business_id uuid, p_user_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.remove_member_impl(p_business_id, p_user_id);
$$;

comment on function public.remove_member(uuid, uuid) is
  'Members: remove a member (owner, fresh code). Ends all the user''s sessions; owner/manager nowhere else → factors deleted. Returns {user_id, removed, previous_role}; the last owner → AN026.';

-- ---------------------------------------------------------------------------------------------
-- RPC: list_members (§2.6, D5). Owner only, no fresh code (reading is not critical). The emails
-- live in auth.users, which authenticated cannot read.
-- ---------------------------------------------------------------------------------------------
create function private.list_members_impl(p_business_id uuid)
returns table (
  user_id uuid,
  email text,
  role text,
  staff_id uuid,
  staff_name text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  is_self boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if not private.has_role(p_business_id, array['owner']) then
    raise exception 'only the owner may list the members' using errcode = '42501';
  end if;

  -- last_sign_in_at is the account's (global): shown only from the day the user joined this
  -- business, so an earlier sign-in (a former membership, Nous's provisioning elsewhere) is not
  -- reported here; null = «not signed in yet» since joining.
  return query
    select m.user_id, u.email::text, m.role, m.staff_id, st.display_name, m.created_at,
           case when u.last_sign_in_at >= m.created_at then u.last_sign_in_at end,
           m.user_id = (select auth.uid())
    from public.business_members m
    join auth.users u on u.id = m.user_id
    left join public.staff st on st.business_id = m.business_id and st.id = m.staff_id
    where m.business_id = p_business_id
    order by case m.role when 'owner' then 0 when 'manager' then 1 else 2 end, u.email, m.user_id;
end;
$$;

create function public.list_members(p_business_id uuid)
returns table (
  user_id uuid,
  email text,
  role text,
  staff_id uuid,
  staff_name text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  is_self boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.list_members_impl(p_business_id);
$$;

comment on function public.list_members(uuid) is
  'Members: every member of the business with email, role, linked staff row and last sign-in since joining (owner only); owners first, then managers, then staff, by email.';

-- ---------------------------------------------------------------------------------------------
-- RPC: change_business_identity (§2.6). Owner with a fresh code. Null = unchanged. The former slug
-- becomes an alias of this business (a business may take back its own alias); a slug or alias of
-- another business, a current slug of another business or a reserved slug → AN024. Time zone or
-- currency → AN025 while an appointment booked/confirmed has ends_at > now() (D8; one in progress
-- counts). vertical is never touched. Nothing different → changed: false, nothing written (D9).
-- Locks: the business row FOR UPDATE, then one advisory lock per slug involved, in sorted order
-- (two businesses swapping slugs never deadlock, and a claim of a slug that is becoming an alias
-- sees the alias). A booking or move holds KEY SHARE on the business row from lock_local_days on,
-- i.e. from BEFORE it validates anything under the zone (below): one in flight either commits
-- first and the AN025 check (a later statement, a new snapshot) sees it, or it waits for this
-- change and then validates under the new zone. The KEY SHARE of an FK check alone came too late
-- (after the validation).
-- ---------------------------------------------------------------------------------------------

-- Same signature and body as 0004 except the FOR KEY SHARE: book_core and move_core call it
-- before their recheck, so the zone they validate under cannot change until they commit. KEY
-- SHARE never blocks another booking or move, nor an update of the other columns of businesses
-- (FOR NO KEY UPDATE); only FOR UPDATE (change_business_identity_impl) and a change of a key
-- column wait for it.
create or replace function private.lock_local_days(p_business_id uuid, p_spans tstzrange[])
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_tz text;
  v_day date;
begin
  select b.timezone into v_tz from public.businesses b where b.id = p_business_id for key share;
  for v_day in
    select distinct (lower(s.span) at time zone v_tz)::date + i
    from unnest(p_spans) as s (span)
    cross join lateral generate_series(
      0,
      ((upper(s.span) - interval '1 microsecond') at time zone v_tz)::date
        - (lower(s.span) at time zone v_tz)::date
    ) as i
    where not isempty(s.span)
    order by 1
  loop
    perform pg_advisory_xact_lock(
      hashtextextended(p_business_id::text || ':' || to_char(v_day, 'YYYY-MM-DD'), 0)
    );
  end loop;
end;
$$;

create function private.change_business_identity_impl(
  p_business_id uuid,
  p_slug text default null,
  p_timezone text default null,
  p_currency text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_slug text := lower(btrim(p_slug));
  v_tz text := btrim(p_timezone);
  v_cur text := upper(btrim(p_currency));
  v_business public.businesses%rowtype;
  v_slug_changed boolean;
  v_tz_changed boolean;
  v_cur_changed boolean;
  v_lock text;
  v_fields text[] := array[]::text[];
  v_replanned integer := 0;
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if not private.has_role(p_business_id, array['owner']) then
    raise exception 'only the owner may change the identity of the business' using errcode = '42501';
  end if;
  perform private.require_fresh_totp();

  if v_slug is not null and v_slug !~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$' then
    raise exception 'p_slug is 3–40 of a-z, 0-9 and -, alphanumeric at both ends' using errcode = '22023';
  end if;
  if v_tz is not null and not private.is_valid_timezone(v_tz) then
    raise exception 'p_timezone is an IANA Area/Location name' using errcode = '22023';
  end if;
  if v_cur is not null and v_cur !~ '^[A-Z]{3}$' then
    raise exception 'p_currency is a three-letter code' using errcode = '22023';
  end if;

  select * into v_business from public.businesses b where b.id = p_business_id for update;

  v_slug_changed := v_slug is not null and v_slug <> v_business.slug;
  v_tz_changed := v_tz is not null and v_tz <> v_business.timezone;
  v_cur_changed := v_cur is not null and v_cur <> v_business.currency::text;

  if not (v_slug_changed or v_tz_changed or v_cur_changed) then
    return jsonb_build_object(
      'business_id', p_business_id,
      'slug', v_business.slug,
      'timezone', v_business.timezone,
      'currency', v_business.currency,
      'changed', false,
      'changed_fields', '[]'::jsonb,
      'replanned', 0
    );
  end if;

  if v_slug_changed then
    for v_lock in
      select s.slug from unnest(array[v_business.slug, v_slug]) as s (slug) order by s.slug
    loop
      perform pg_advisory_xact_lock(hashtextextended('slug:' || v_lock, 0));
    end loop;

    if private.is_reserved_slug(v_slug)
       or exists (select 1 from public.businesses b where b.slug = v_slug and b.id <> p_business_id)
       or exists (
         select 1 from public.business_slug_aliases a
         where a.slug = v_slug and a.business_id <> p_business_id
       ) then
      perform private.raise_domain_error('AN024');
    end if;
  end if;

  if (v_tz_changed or v_cur_changed) and exists (
    select 1 from public.appointments a
    where a.business_id = p_business_id
      and a.status in ('booked', 'confirmed')
      and a.ends_at > now()
  ) then
    perform private.raise_domain_error('AN025');
  end if;

  begin
    if v_slug_changed then
      delete from public.business_slug_aliases a where a.slug = v_slug and a.business_id = p_business_id;
      insert into public.business_slug_aliases (slug, business_id) values (v_business.slug, p_business_id);
    end if;

    update public.businesses b
    set slug = case when v_slug_changed then v_slug else b.slug end,
        timezone = case when v_tz_changed then v_tz else b.timezone end,
        currency = case when v_cur_changed then v_cur else b.currency end
    where b.id = p_business_id;
  exception when unique_violation then
    -- a concurrent claim of the same slug (businesses_slug_key) or the guard
    -- (businesses_slug_not_alias)
    perform private.raise_domain_error('AN024');
  end;

  if v_tz_changed then
    -- 1.6 §7. Nothing to re-plan while AN025 holds (D8); made anyway, so the rule cannot be lost.
    v_replanned := private.replan_reminders_impl(p_business_id, now());
  end if;

  if v_slug_changed then
    v_fields := v_fields || 'slug'::text;
  end if;
  if v_tz_changed then
    v_fields := v_fields || 'timezone'::text;
  end if;
  if v_cur_changed then
    v_fields := v_fields || 'currency'::text;
  end if;

  insert into public.audit_log (business_id, actor_type, actor_id, action, entity, entity_id, reason)
  values (
    p_business_id, 'staff', (select auth.uid()), 'business_identity_changed', 'business', p_business_id,
    concat_ws('; ',
      case when v_slug_changed then 'slug=' || v_business.slug || '>' || v_slug end,
      case when v_tz_changed then 'timezone=' || v_business.timezone || '>' || v_tz end,
      case when v_cur_changed then 'currency=' || v_business.currency || '>' || v_cur end
    )
  );

  return (
    select jsonb_build_object(
      'business_id', b.id,
      'slug', b.slug,
      'timezone', b.timezone,
      'currency', b.currency,
      'changed', true,
      'changed_fields', to_jsonb(v_fields),
      'replanned', v_replanned
    )
    from public.businesses b
    where b.id = p_business_id
  );
end;
$$;

create function public.change_business_identity(
  p_business_id uuid,
  p_slug text default null,
  p_timezone text default null,
  p_currency text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.change_business_identity_impl(p_business_id, p_slug, p_timezone, p_currency);
$$;

comment on function public.change_business_identity(uuid, text, text, text) is
  'Settings: change slug, time zone and/or currency (owner, fresh code; null = unchanged). The former slug keeps leading here. Returns {business_id, slug, timezone, currency, changed, changed_fields, replanned}; AN024 slug unavailable, AN025 upcoming appointments.';

-- ---------------------------------------------------------------------------------------------
-- RPC: authorize_factor_change (§2.6; no p_business_id: the caller's own factors). Owner/manager
-- anywhere (staff never write factors, ADR-0009 §18). remove: the caller's own verified factor,
-- never the last one (checked before the fresh code, D11; a factor with an unexpired, unmatched
-- remove grant counts as already gone). add: a fresh code once a verified factor exists (the
-- first enrolment, also after an mfa-reset, passes at aal1). Writes one grant (10′) and one audit
-- row per business where the caller is owner/manager.
-- ---------------------------------------------------------------------------------------------
create function private.authorize_factor_change_impl(p_action text, p_factor_id uuid default null)
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

create function public.authorize_factor_change(p_action text, p_factor_id uuid default null)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.authorize_factor_change_impl(p_action, p_factor_id);
$$;

comment on function public.authorize_factor_change(text, uuid) is
  'Security: permission (10 minutes) to add a device for codes, or to remove one of the caller''s verified devices through manage-factors. Returns {grant_id, user_id, action, factor_id, expires_at}; the last device → AN027.';

-- ---------------------------------------------------------------------------------------------
-- RPC (service_role): add_member (§2.7). Called by invite-member after can_manage_members passed
-- as the user. Manager or staff only (D4: a new owner comes by promotion). Never an account that
-- is a member of another business (AN031). An insert revokes nothing (the trigger fires on
-- delete/update only).
-- ---------------------------------------------------------------------------------------------
create function private.add_member_impl(
  p_business_id uuid,
  p_user_id uuid,
  p_role text,
  p_staff_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_existing public.business_members%rowtype;
begin
  if p_business_id is null or not exists (select 1 from public.businesses b where b.id = p_business_id) then
    raise exception 'business not found' using errcode = '22023';
  end if;
  if p_actor_id is null or not exists (
    select 1 from public.business_members m
    where m.business_id = p_business_id and m.user_id = p_actor_id and m.role = 'owner'
  ) then
    raise exception 'the actor is not an owner of this business' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('manager', 'staff') then
    raise exception 'p_role is manager or staff' using errcode = '22023';
  end if;
  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'user not found' using errcode = '22023';
  end if;
  if p_staff_id is not null and not exists (
    select 1 from public.staff st where st.business_id = p_business_id and st.id = p_staff_id
  ) then
    raise exception 'staff member not found in this business' using errcode = '42501';
  end if;

  -- Taken before the staff-link check too, so two invitations for one staff row serialise.
  perform pg_advisory_xact_lock(hashtextextended('members:' || p_business_id::text, 0));

  if p_staff_id is not null and exists (
    select 1 from public.business_members m
    where m.business_id = p_business_id and m.staff_id = p_staff_id and m.user_id <> p_user_id
  ) then
    perform private.raise_domain_error('AN029');
  end if;

  select * into v_existing
  from public.business_members m
  where m.business_id = p_business_id and m.user_id = p_user_id;
  if found then
    if v_existing.role = p_role and v_existing.staff_id is not distinct from p_staff_id then
      return jsonb_build_object(
        'business_id', p_business_id, 'user_id', p_user_id, 'role', p_role,
        'staff_id', p_staff_id, 'added', false
      );
    end if;
    perform private.raise_domain_error('AN028');
  end if;

  -- An account that already belongs to ANOTHER business is never attached by an owner (review
  -- fix): there is no acceptance step, and a later removal or role change here would act on that
  -- user everywhere (business_members_access_changed ends all sessions and drops all push devices;
  -- a higher role here sends a staff member of the other business to enrolment). Only Nous
  -- attaches such an account (provisioning, with the user's consent). An account without any
  -- membership (a former member) is reused as the plan says.
  if exists (
    select 1 from public.business_members m
    where m.user_id = p_user_id and m.business_id <> p_business_id
  ) then
    perform private.raise_domain_error('AN031');
  end if;

  insert into public.business_members (business_id, user_id, role, staff_id)
  values (p_business_id, p_user_id, p_role, p_staff_id);

  insert into public.audit_log (business_id, actor_type, actor_id, action, entity, entity_id, reason)
  values (p_business_id, 'staff', p_actor_id, 'member_added', 'business_member', p_user_id, p_role);

  return jsonb_build_object(
    'business_id', p_business_id, 'user_id', p_user_id, 'role', p_role,
    'staff_id', p_staff_id, 'added', true
  );
end;
$$;

create function public.add_member(
  p_business_id uuid,
  p_user_id uuid,
  p_role text,
  p_staff_id uuid,
  p_actor_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.add_member_impl(p_business_id, p_user_id, p_role, p_staff_id, p_actor_id);
$$;

comment on function public.add_member(uuid, uuid, text, uuid, uuid) is
  'Edge Function invite-member (service_role): add a manager or staff member on behalf of an owner. Returns {business_id, user_id, role, staff_id, added}; AN028 already a member, AN029 staff row taken, AN031 a member of another business.';

-- ---------------------------------------------------------------------------------------------
-- RPC (service_role): record_support_action (§2.7). What Nous does by script, always with a
-- reason and a ticket. mfa_reset writes a `remove` grant (source nous_support) per factor of the
-- user and one audit row per business where the user is owner/manager; it deletes nothing (the
-- script deletes the factors through the admin API, then revokes the sessions).
-- provision_update writes one audit row on the business.
-- ---------------------------------------------------------------------------------------------
create function private.record_support_action_impl(
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
    if not private.is_privileged_anywhere(p_user_id) then
      raise exception 'the user is owner or manager nowhere: nothing to reset' using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('factors:' || p_user_id::text, 0));

    select coalesce(array_agg(f.id order by f.created_at, f.id), array[]::uuid[]) into v_factor_ids
    from auth.mfa_factors f
    where f.user_id = p_user_id;

    foreach v_factor_id in array v_factor_ids loop
      perform private.write_factor_grant(p_user_id, 'remove', v_factor_id, 'nous_support');
    end loop;

    insert into public.audit_log (business_id, actor_type, actor_id, action, entity, entity_id, reason)
    select m.business_id, 'nous_support', null, 'mfa_reset', 'auth_user', p_user_id, v_audit_reason
    from public.business_members m
    where m.user_id = p_user_id and m.role in ('owner', 'manager')
    order by m.business_id;
    get diagnostics v_audit_rows = row_count;

    return jsonb_build_object(
      'action', p_action,
      'factor_ids', to_jsonb(v_factor_ids),
      'grants', cardinality(v_factor_ids),
      'audit_rows', v_audit_rows
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

create function public.record_support_action(
  p_action text,
  p_reason text,
  p_ticket text,
  p_user_id uuid default null,
  p_business_id uuid default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_support_action_impl(p_action, p_reason, p_ticket, p_user_id, p_business_id);
$$;

comment on function public.record_support_action(text, text, text, uuid, uuid) is
  'Nous scripts (service_role): record an mfa_reset (removal grants + audit per business) or a provision_update (audit), with reason and ticket. Returns {action, factor_ids, grants, audit_rows}.';

-- ---------------------------------------------------------------------------------------------
-- RPC (service_role): user_id_for_email (§2.7). invite-member (email_exists) and mfa-reset.mjs.
-- ---------------------------------------------------------------------------------------------
create function private.user_id_for_email_impl(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id
  from auth.users u
  where u.email = lower(btrim(p_email)) and u.is_sso_user = false and u.deleted_at is null
  order by u.created_at, u.id
  limit 1;
$$;

create function public.user_id_for_email(p_email text)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select private.user_id_for_email_impl(p_email);
$$;

comment on function public.user_id_for_email(text) is
  'Edge Functions and scripts (service_role): the id of the (non-SSO, not deleted) user with this email, or null.';

-- ---------------------------------------------------------------------------------------------
-- RPC (service_role): revoke_user_sessions (§2.7). mfa-reset.mjs and 1.9's reaction.
-- ---------------------------------------------------------------------------------------------
create function public.revoke_user_sessions(p_user_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.revoke_user_sessions_impl(p_user_id);
$$;

comment on function public.revoke_user_sessions(uuid) is
  'Scripts (service_role): end every session of a user and drop the user''s push devices. Returns {sessions, push_subscriptions}.';

-- ---------------------------------------------------------------------------------------------
-- Catalogue (§2.8): also answers for a former slug, with the CURRENT business (same jsonb;
-- business.slug <> the requested slug means «moved»: the Worker answers 301). Only the WHERE of
-- the 0004 definition changes. available_slots, public_business_profile and
-- public_slug_for_code are unchanged (the page uses the catalogue's slug).
-- ---------------------------------------------------------------------------------------------
create or replace function private.public_booking_catalogue_impl(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'business', jsonb_build_object(
      'id', b.id, 'slug', b.slug, 'name', b.name, 'vertical', b.vertical,
      'timezone', b.timezone, 'locale', b.locale, 'currency', b.currency, 'theme', b.theme,
      'address', b.address, 'maps_url', b.maps_url, 'phone_e164', b.phone_e164,
      'slot_step_min', b.slot_step_min, 'min_notice_min', b.min_notice_min,
      'max_advance_days', b.max_advance_days, 'allow_any_staff', b.allow_any_staff
    ),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'sort', c.sort)
                       order by c.sort, c.name, c.id)
      from public.service_categories c
      where c.business_id = b.id
    ), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'category_id', s.category_id, 'name', s.name,
               'duration_min', s.duration_min, 'price_cents', s.price_cents, 'sort', s.sort
             ) order by s.sort, s.name, s.id)
      from public.services s
      where s.business_id = b.id and s.active and s.online_bookable
    ), '[]'::jsonb),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', st.id, 'display_name', st.display_name, 'photo_url', st.photo_url,
               'color', st.color, 'sort', st.sort,
               'services', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'service_id', s.id,
                          'duration_min', coalesce(ss.custom_duration_min, s.duration_min),
                          'price_cents', coalesce(ss.custom_price_cents, s.price_cents)
                        ) order by s.sort, s.name, s.id)
                 from public.staff_services ss
                 join public.services s on s.business_id = ss.business_id and s.id = ss.service_id
                 where ss.business_id = b.id and ss.staff_id = st.id
                   and s.active and s.online_bookable
               ), '[]'::jsonb)
             ) order by st.sort, st.display_name, st.id)
      from public.staff st
      where st.business_id = b.id and st.active
    ), '[]'::jsonb)
  )
  from public.businesses b
  where b.booking_enabled
    and (
      b.slug = lower(p_slug)
      or b.id = (select a.business_id from public.business_slug_aliases a where a.slug = lower(p_slug))
    );
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants (§2.10). anon: unchanged. Nobody: has_fresh_totp, require_fresh_totp, session_mfa_ok,
-- write_factor_grant, is_privileged_anywhere, drop_factors_if_unprivileged and the two trigger
-- functions (only definer code calls them).
-- ---------------------------------------------------------------------------------------------
grant execute on function private.can_manage_members_impl(uuid) to authenticated;
grant execute on function public.can_manage_members(uuid) to authenticated;
grant execute on function private.set_member_role_impl(uuid, uuid, text) to authenticated;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;
grant execute on function private.remove_member_impl(uuid, uuid) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function private.list_members_impl(uuid) to authenticated;
grant execute on function public.list_members(uuid) to authenticated;
grant execute on function private.change_business_identity_impl(uuid, text, text, text) to authenticated;
grant execute on function public.change_business_identity(uuid, text, text, text) to authenticated;
grant execute on function private.authorize_factor_change_impl(text, uuid) to authenticated;
grant execute on function public.authorize_factor_change(text, uuid) to authenticated;

grant execute on function private.add_member_impl(uuid, uuid, text, uuid, uuid) to service_role;
grant execute on function public.add_member(uuid, uuid, text, uuid, uuid) to service_role;
grant execute on function private.record_support_action_impl(text, text, text, uuid, uuid) to service_role;
grant execute on function public.record_support_action(text, text, text, uuid, uuid) to service_role;
grant execute on function private.user_id_for_email_impl(text) to service_role;
grant execute on function public.user_id_for_email(text) to service_role;
grant execute on function private.revoke_user_sessions_impl(uuid) to service_role;
grant execute on function public.revoke_user_sessions(uuid) to service_role;
