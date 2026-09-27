-- 0001_foundation.sql
-- Tenancy, roles, catalogue and schedules (SPEC §7, ADR-0005).
-- Rules: every tenant table has business_id + unique (business_id, id); every reference is a
-- composite FK; RLS + explicit GRANTs live next to each table; helpers live in schema `private`.
-- API entry points are thin SECURITY INVOKER wrappers in `public` that call SECURITY DEFINER
-- implementations in `private` (ADR-0005).

-- ---------------------------------------------------------------------------------------------
-- Extensions & privileges
-- ---------------------------------------------------------------------------------------------
create extension if not exists btree_gist with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- Nothing created by migrations is reachable through the Data API unless granted explicitly.
-- Functions: PostgreSQL grants EXECUTE to PUBLIC globally and per-schema defaults cannot undo
-- that, so the global default is revoked too. Behaviour no longer depends on CLI/cloud defaults.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated, service_role;

-- `private` is never exposed through the Data API. API roles need USAGE only so that public
-- wrappers and RLS policies can call the specific functions granted to them.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Pure helpers
-- ---------------------------------------------------------------------------------------------

-- IANA Area/Location names only. Offsets such as 'UTC+2' are rejected on purpose: PostgreSQL
-- reads them with POSIX sign inversion (UTC-2) while browsers do not. Declared immutable so it
-- can back a CHECK constraint; the time zone list only changes on server upgrades.
create function private.is_valid_timezone(p_zone text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_zone ~ '^[A-Z][A-Za-z_]+(/[A-Za-z0-9_+-]+)+$'
     and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_zone);
$$;

-- Slugs share the URL space with application routes (/app, /api, …).
create function private.is_reserved_slug(p_slug text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_slug = any (array[
    'app', 'api', 'auth', 'admin', 'login', 'logout', 'signup', 'register', 'account', 'settings',
    'assets', 'static', 'public', 'fonts', 'images', 'img', 'js', 'css', 'www', 'mail', 'help',
    'support', 'docs', 'blog', 'about', 'pricing', 'privacy', 'terms', 'legal', 'cookies', 'status',
    'demo', 'test', 'anaklo', 'nous', 'book', 'booking', 'manage', 'm', 'r', 'sw', 'manifest',
    'robots', 'sitemap', 'favicon', 'health', 'webhooks', 'functions', 'rest', 'storage', 'realtime'
  ]);
$$;

-- CHECK constraints run with the privileges of the writing role.
grant execute on function private.is_valid_timezone(text) to authenticated, service_role;
grant execute on function private.is_reserved_slug(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- businesses
-- ---------------------------------------------------------------------------------------------
create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    constraint businesses_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$')
    constraint businesses_slug_not_reserved check (not private.is_reserved_slug(slug)),
  name text not null constraint businesses_name_length check (char_length(name) between 1 and 80),
  vertical text not null constraint businesses_vertical check (vertical in ('barber', 'hair_salon', 'beauty')),
  timezone text not null constraint businesses_timezone_valid check (private.is_valid_timezone(timezone)),
  currency char(3) not null default 'EUR' constraint businesses_currency check (currency ~ '^[A-Z]{3}$'),
  locale text not null default 'el' constraint businesses_locale check (locale in ('el', 'en')),
  phone_e164 text constraint businesses_phone check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- the public booking page answers only when this is on
  booking_enabled boolean not null default false,
  -- booking policy (typed, not jsonb: a missing key must never silently mean "no availability")
  slot_step_min smallint not null default 15
    constraint businesses_slot_step check (slot_step_min in (5, 10, 15, 20, 30, 60)),
  min_notice_min integer not null default 60
    constraint businesses_min_notice check (min_notice_min between 0 and 10080),
  max_advance_days smallint not null default 60
    constraint businesses_max_advance check (max_advance_days between 1 and 365),
  cancel_min_notice_min integer not null default 120
    constraint businesses_cancel_notice check (cancel_min_notice_min between 0 and 10080),
  auto_complete_after_min integer not null default 720
    constraint businesses_auto_complete check (auto_complete_after_min between 0 and 10080),
  -- how long staff may correct the outcome of their own appointment (completed/no_show/cancelled)
  correction_window_days smallint not null default 3
    constraint businesses_correction_window check (correction_window_days between 0 and 30),
  allow_any_staff boolean not null default true,
  theme jsonb not null default '{}'::jsonb constraint businesses_theme_object check (jsonb_typeof(theme) = 'object'),
  settings jsonb not null default '{}'::jsonb constraint businesses_settings_object check (jsonb_typeof(settings) = 'object'),
  messaging_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.businesses is 'Tenant root. Booking policy lives in typed columns (SPEC §7).';

-- ---------------------------------------------------------------------------------------------
-- staff
-- ---------------------------------------------------------------------------------------------
create table public.staff (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  display_name text not null constraint staff_display_name_length check (char_length(display_name) between 1 and 60),
  photo_url text,
  color text constraint staff_color check (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort smallint not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint staff_business_id_key unique (business_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- business_members: who (auth user) belongs to which business, with which role
-- ---------------------------------------------------------------------------------------------
create table public.business_members (
  business_id uuid not null references public.businesses (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null constraint business_members_role check (role in ('owner', 'manager', 'staff')),
  staff_id uuid,
  created_at timestamptz not null default now(),
  primary key (business_id, user_id),
  constraint business_members_staff_fk foreign key (business_id, staff_id)
    references public.staff (business_id, id) on delete restrict
);

create unique index business_members_staff_unique on public.business_members (business_id, staff_id)
  where staff_id is not null;
create index business_members_user_idx on public.business_members (user_id, business_id);

-- ---------------------------------------------------------------------------------------------
-- Membership helpers.
-- RLS policies use the set-returning forms, e.g. `business_id in (select private.my_business_ids())`:
-- the sub-select does not depend on the row, so PostgreSQL evaluates it once per statement.
-- The boolean forms are for use inside functions and triggers.
-- ---------------------------------------------------------------------------------------------
create function private.my_business_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.business_id from public.business_members m where m.user_id = (select auth.uid());
$$;

create function private.my_business_ids_with_role(p_roles text[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.business_id from public.business_members m
  where m.user_id = (select auth.uid()) and m.role = any (p_roles);
$$;

create function private.my_staff_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.staff_id from public.business_members m
  where m.user_id = (select auth.uid()) and m.staff_id is not null;
$$;

create function private.is_member(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.business_members m
    where m.business_id = p_business_id and m.user_id = (select auth.uid())
  );
$$;

create function private.has_role(p_business_id uuid, p_roles text[])
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
  );
$$;

create function private.my_staff_id(p_business_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.staff_id from public.business_members m
  where m.business_id = p_business_id and m.user_id = (select auth.uid());
$$;

grant execute on function private.my_business_ids() to authenticated, service_role;
grant execute on function private.my_business_ids_with_role(text[]) to authenticated, service_role;
grant execute on function private.my_staff_ids() to authenticated, service_role;
grant execute on function private.is_member(uuid) to authenticated, service_role;
grant execute on function private.has_role(uuid, text[]) to authenticated, service_role;
grant execute on function private.my_staff_id(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------------------------
create table public.service_categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  name text not null constraint service_categories_name_length check (char_length(name) between 1 and 60),
  sort smallint not null default 0,
  constraint service_categories_business_id_key unique (business_id, id)
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  category_id uuid,
  name text not null constraint services_name_length check (char_length(name) between 1 and 80),
  duration_min smallint not null constraint services_duration check (duration_min between 5 and 600),
  buffer_after_min smallint not null default 0 constraint services_buffer check (buffer_after_min between 0 and 120),
  price_cents integer not null constraint services_price check (price_cents >= 0),
  active boolean not null default true,
  online_bookable boolean not null default true,
  sort smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint services_business_id_key unique (business_id, id),
  constraint services_category_fk foreign key (business_id, category_id)
    references public.service_categories (business_id, id) on delete restrict
);

create table public.staff_services (
  business_id uuid not null references public.businesses (id) on delete restrict,
  staff_id uuid not null,
  service_id uuid not null,
  custom_duration_min smallint constraint staff_services_duration check (custom_duration_min between 5 and 600),
  custom_price_cents integer constraint staff_services_price check (custom_price_cents >= 0),
  primary key (business_id, staff_id, service_id),
  constraint staff_services_staff_fk foreign key (business_id, staff_id)
    references public.staff (business_id, id) on delete restrict,
  constraint staff_services_service_fk foreign key (business_id, service_id)
    references public.services (business_id, id) on delete restrict
);

-- ---------------------------------------------------------------------------------------------
-- Schedules. Working hours are LOCAL wall-clock times in businesses.timezone and never cross
-- midnight. weekday follows extract(dow): 0 = Sunday … 6 = Saturday.
-- ---------------------------------------------------------------------------------------------
create table public.working_hours (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  staff_id uuid not null,
  weekday smallint not null constraint working_hours_weekday check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  constraint working_hours_order check (end_time > start_time),
  constraint working_hours_staff_fk foreign key (business_id, staff_id)
    references public.staff (business_id, id) on delete restrict
);

create index working_hours_staff_idx on public.working_hours (business_id, staff_id, weekday);

-- One-off closures (holidays) and extra/changed hours. staff_id null = the whole shop.
-- Precedence per local date: staff exception > shop exception > weekly working_hours.
create table public.schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  staff_id uuid,
  local_date date not null,
  kind text not null constraint schedule_exceptions_kind check (kind in ('closed', 'open')),
  start_time time,
  end_time time,
  note text constraint schedule_exceptions_note_length check (char_length(note) <= 200),
  constraint schedule_exceptions_shape check (
    (kind = 'closed' and start_time is null and end_time is null)
    or (kind = 'open' and start_time is not null and end_time is not null and end_time > start_time)
  ),
  constraint schedule_exceptions_staff_fk foreign key (business_id, staff_id)
    references public.staff (business_id, id) on delete restrict
);

create index schedule_exceptions_date_idx on public.schedule_exceptions (business_id, local_date);

create table public.time_off (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  staff_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- a closed list on purpose: free text here tends to collect health data
  reason text not null default 'other' constraint time_off_reason check (reason in ('vacation', 'sick', 'personal', 'other')),
  created_at timestamptz not null default now(),
  constraint time_off_order check (ends_at > starts_at),
  constraint time_off_staff_fk foreign key (business_id, staff_id)
    references public.staff (business_id, id) on delete restrict
);

create index time_off_range_idx on public.time_off (business_id, staff_id, starts_at);

-- ---------------------------------------------------------------------------------------------
-- audit_log (append-only for API roles; written by SECURITY DEFINER functions)
-- ---------------------------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses (id) on delete restrict,
  actor_type text not null constraint audit_log_actor_type check (actor_type in ('staff', 'nous_support', 'system')),
  actor_id uuid,
  action text not null constraint audit_log_action_length check (char_length(action) between 1 and 80),
  entity text not null constraint audit_log_entity_length check (char_length(entity) between 1 and 80),
  entity_id uuid,
  reason text constraint audit_log_reason_length check (char_length(reason) <= 500),
  at timestamptz not null default now()
);

create index audit_log_business_idx on public.audit_log (business_id, at desc);

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------
alter table public.businesses enable row level security;
alter table public.staff enable row level security;
alter table public.business_members enable row level security;
alter table public.service_categories enable row level security;
alter table public.services enable row level security;
alter table public.staff_services enable row level security;
alter table public.working_hours enable row level security;
alter table public.schedule_exceptions enable row level security;
alter table public.time_off enable row level security;
alter table public.audit_log enable row level security;

-- businesses: members read; owner/manager update. Creation happens through onboarding (Phase 5).
create policy businesses_select on public.businesses for select to authenticated
  using (id in (select private.my_business_ids()));
create policy businesses_update on public.businesses for update to authenticated
  using (id in (select private.my_business_ids_with_role(array['owner', 'manager'])))
  with check (id in (select private.my_business_ids_with_role(array['owner', 'manager'])));

-- business_members: members read; only the owner manages membership.
create policy business_members_select on public.business_members for select to authenticated
  using (business_id in (select private.my_business_ids()));
create policy business_members_insert on public.business_members for insert to authenticated
  with check (business_id in (select private.my_business_ids_with_role(array['owner'])));
create policy business_members_update on public.business_members for update to authenticated
  using (business_id in (select private.my_business_ids_with_role(array['owner'])))
  with check (business_id in (select private.my_business_ids_with_role(array['owner'])));
create policy business_members_delete on public.business_members for delete to authenticated
  using (business_id in (select private.my_business_ids_with_role(array['owner'])));

-- Changing who has access requires a second factor (SPEC §11): a stolen password alone must not
-- let anyone add themselves as owner or remove the real one. Restrictive = AND with the above.
create policy business_members_insert_mfa on public.business_members as restrictive for insert to authenticated
  with check ((select auth.jwt() ->> 'aal') = 'aal2');
create policy business_members_update_mfa on public.business_members as restrictive for update to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2')
  with check ((select auth.jwt() ->> 'aal') = 'aal2');
create policy business_members_delete_mfa on public.business_members as restrictive for delete to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

-- A business never ends up without an owner. Deferred to commit, so ownership can be handed over
-- (add the new owner, demote the old one) inside one transaction.
create function private.ensure_business_has_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.business_members m
    where m.business_id = old.business_id and m.role = 'owner'
  ) and exists (select 1 from public.businesses b where b.id = old.business_id) then
    raise exception 'business % would be left without an owner', old.business_id
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger business_members_keep_owner
  after update or delete on public.business_members
  deferrable initially deferred
  for each row execute function private.ensure_business_has_owner();

-- Catalogue and schedules: members read; owner/manager write.
create policy staff_select on public.staff for select to authenticated
  using (business_id in (select private.my_business_ids()));
create policy staff_write on public.staff for all to authenticated
  using (business_id in (select private.my_business_ids_with_role(array['owner', 'manager'])))
  with check (business_id in (select private.my_business_ids_with_role(array['owner', 'manager'])));

create policy service_categories_select on public.service_categories for select to authenticated
  using (business_id in (select private.my_business_ids()));
create policy service_categories_write on public.service_categories for all to authenticated
  using (business_id in (select private.my_business_ids_with_role(array['owner', 'manager'])))
  with check (business_id in (select private.my_business_ids_with_role(array['owner', 'manager'])));

create policy services_select on public.services for select to authenticated
  using (business_id in (select private.my_business_ids()));
create policy services_write on public.services for all to authenticated
  using (business_id in (select private.my_business_ids_with_role(array['owner', 'manager'])))
  with check (business_id in (select private.my_business_ids_with_role(array['owner', 'manager'])));

create policy staff_services_select on public.staff_services for select to authenticated
  using (business_id in (select private.my_business_ids()));
create policy staff_services_write on public.staff_services for all to authenticated
  using (business_id in (select private.my_business_ids_with_role(array['owner', 'manager'])))
  with check (business_id in (select private.my_business_ids_with_role(array['owner', 'manager'])));

create policy working_hours_select on public.working_hours for select to authenticated
  using (business_id in (select private.my_business_ids()));
create policy working_hours_write on public.working_hours for all to authenticated
  using (business_id in (select private.my_business_ids_with_role(array['owner', 'manager'])))
  with check (business_id in (select private.my_business_ids_with_role(array['owner', 'manager'])));

create policy schedule_exceptions_select on public.schedule_exceptions for select to authenticated
  using (business_id in (select private.my_business_ids()));
create policy schedule_exceptions_write on public.schedule_exceptions for all to authenticated
  using (business_id in (select private.my_business_ids_with_role(array['owner', 'manager'])))
  with check (business_id in (select private.my_business_ids_with_role(array['owner', 'manager'])));

-- time_off: the reason is visible to owner/manager and to the staff member it concerns only.
create policy time_off_select on public.time_off for select to authenticated
  using (
    business_id in (select private.my_business_ids_with_role(array['owner', 'manager']))
    or staff_id in (select private.my_staff_ids())
  );
create policy time_off_write on public.time_off for all to authenticated
  using (business_id in (select private.my_business_ids_with_role(array['owner', 'manager'])))
  with check (business_id in (select private.my_business_ids_with_role(array['owner', 'manager'])));

-- audit_log: owner reads; nobody writes through the API.
create policy audit_log_select on public.audit_log for select to authenticated
  using (business_id in (select private.my_business_ids_with_role(array['owner'])));

-- ---------------------------------------------------------------------------------------------
-- Grants (anon gets nothing on tables)
-- ---------------------------------------------------------------------------------------------
grant select, update on public.businesses to authenticated;
grant select, insert, update, delete on public.business_members to authenticated;
grant select, insert, update, delete on public.staff to authenticated;
grant select, insert, update, delete on public.service_categories to authenticated;
grant select, insert, update, delete on public.services to authenticated;
grant select, insert, update, delete on public.staff_services to authenticated;
grant select, insert, update, delete on public.working_hours to authenticated;
grant select, insert, update, delete on public.schedule_exceptions to authenticated;
grant select, insert, update, delete on public.time_off to authenticated;
grant select on public.audit_log to authenticated;

grant select, insert, update on public.businesses to service_role;
grant select, insert, update, delete on public.business_members to service_role;
grant select, insert, update on public.staff to service_role;
grant select, insert, update on public.service_categories to service_role;
grant select, insert, update on public.services to service_role;
grant select, insert, update, delete on public.staff_services to service_role;
grant select, insert, update, delete on public.working_hours to service_role;
grant select, insert, update, delete on public.schedule_exceptions to service_role;
grant select, insert, update, delete on public.time_off to service_role;
grant select on public.audit_log to service_role;

-- ---------------------------------------------------------------------------------------------
-- Public read for the booking page (anon never reads tables).
-- Implementation in private (definer, whitelisted fields, only businesses with booking enabled);
-- the exposed entry point is a thin invoker wrapper.
-- ---------------------------------------------------------------------------------------------
create function private.public_business_profile_impl(p_slug text)
returns table (slug text, name text, vertical text, timezone text, locale text, theme jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select b.slug, b.name, b.vertical, b.timezone, b.locale, b.theme
  from public.businesses b
  where b.slug = lower(p_slug) and b.booking_enabled;
$$;

create function public.public_business_profile(p_slug text)
returns table (slug text, name text, vertical text, timezone text, locale text, theme jsonb)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.public_business_profile_impl(p_slug);
$$;

comment on function public.public_business_profile(text) is
  'Booking page header data: public fields of a business whose online booking is enabled.';

grant execute on function private.public_business_profile_impl(text) to anon, authenticated, service_role;
grant execute on function public.public_business_profile(text) to anon, authenticated, service_role;
