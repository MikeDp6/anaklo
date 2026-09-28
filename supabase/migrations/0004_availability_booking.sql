-- 0004_availability_booking.sql
-- Availability and booking in SQL (SPEC §7, §8; ADR-0003; Phase 1 plan, step 1.2).
--
-- One implementation, here, tested with pgTAP. The browser and the Edge Functions only show or
-- forward what these functions return.
--
--   private.service_terms            duration/price/buffer of a list of services for one staff member
--   private.staff_day_windows        working windows of one staff member on one LOCAL date (UTC instants)
--   private.available_slots_impl     slots on the local grid ('public' | 'staff' mode)
--   private.available_slots_core     the same, with an optional block length (a move keeps its own)
--   private.book_core               the only booking path (lock → idempotency → recheck → insert)
--   private.move_core                the only move path (lock both days → recheck → update in place)
--   private.plan_messages_impl       message planner, empty until 1.3/1.5a (stable signature)
--
-- API: thin SECURITY INVOKER wrappers in public, each with a SECURITY DEFINER _impl in private:
--   anon + authenticated + service_role: public_booking_catalogue, available_slots
--   authenticated:                       staff_available_slots, staff_book_appointment
-- No public wrapper accepts p_now: the clock is injectable only in private code, for tests.
--
-- Domain errors: errcode P0001, message = the code (AN001…), hint = its name. The list lives in
-- private.raise_domain_error below and in supabase/functions/_shared/errors.ts (Vitest compares
-- them). Membership failures stay 42501, as in 0001–0003.

-- ---------------------------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------------------------

-- Shown on the booking page. Owner/manager edit them like the rest of the profile.
alter table public.businesses
  add column address text
    constraint businesses_address_length check (char_length(address) <= 200),
  add column maps_url text
    constraint businesses_maps_url check (maps_url ~ '^https://' and char_length(maps_url) <= 500);

grant update (address, maps_url) on public.businesses to authenticated;

-- Availability reads the active appointments of one staff member in a time range.
create index appointments_active_staff_idx on public.appointments (business_id, staff_id, starts_at)
  where status in ('booked', 'confirmed');

-- sha256 (hex) of the canonical request of an idempotent booking: the same key with a different
-- payload is refused (AN004) instead of silently returning a different booking.
alter table public.appointments
  add column request_hash text
    constraint appointments_request_hash check (
      request_hash is null or (idempotency_key is not null and request_hash ~ '^[0-9a-f]{64}$')
    );

-- request_hash is written by book_core only. authenticated has SELECT only (0003); service_role
-- had table-wide INSERT/UPDATE, which would cover the new column, so it now gets the same
-- columns as before, listed, without request_hash.
revoke insert, update on public.appointments from service_role;
grant insert (
  id, business_id, client_id, staff_id, starts_at, ends_at, buffer_after_min, status, source,
  referrer, verified_via, total_cents, charged_cents, cancelled_by, cancel_reason,
  idempotency_key, external_ref, created_by, created_at
) on public.appointments to service_role;
grant update (
  id, business_id, client_id, staff_id, starts_at, ends_at, buffer_after_min, status, source,
  referrer, verified_via, total_cents, charged_cents, cancelled_by, cancel_reason,
  idempotency_key, external_ref, created_by, created_at
) on public.appointments to service_role;

-- ---------------------------------------------------------------------------------------------
-- Domain errors. VOLATILE on purpose: an immutable/stable raiser with constant arguments could be
-- folded (and raise) at plan time, even in a branch that never runs.
-- ---------------------------------------------------------------------------------------------
create function private.raise_domain_error(p_code text)
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
  end;
begin
  if v_name is null then
    raise exception 'unknown domain error code %', p_code using errcode = '22023';
  end if;
  raise exception using errcode = 'P0001', message = p_code, hint = v_name;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- private.service_terms: what a list of services costs and lasts WITH ONE staff member.
-- Custom duration/price of staff_services win over the service defaults; the buffer is the one
-- of the LAST service (the cleanup after the whole visit). Positions are 0-based, in the order
-- given. No row at all when the staff member does not offer every service, a service is
-- inactive or of another business, or (p_public) not bookable online.
-- ---------------------------------------------------------------------------------------------
create function private.service_terms(
  p_business_id uuid,
  p_staff_id uuid,
  p_service_ids uuid[],
  p_public boolean
)
returns table (duration_min integer, buffer_after_min integer, price_cents integer, lines jsonb)
language sql
stable
set search_path = ''
as $$
  select
    sum(l.duration_min)::integer,
    (array_agg(l.buffer_after_min order by l.position desc))[1],
    sum(l.price_cents)::integer,
    jsonb_agg(
      jsonb_build_object(
        'service_id', l.service_id, 'position', l.position,
        'duration_min', l.duration_min, 'price_cents', l.price_cents
      ) order by l.position
    )
  from (
    select
      (r.ord - 1)::integer as position,
      s.id as service_id,
      coalesce(ss.custom_duration_min, s.duration_min)::integer as duration_min,
      coalesce(ss.custom_price_cents, s.price_cents)::integer as price_cents,
      s.buffer_after_min::integer as buffer_after_min
    from unnest(p_service_ids) with ordinality as r (service_id, ord)
    join public.services s
      on s.business_id = p_business_id and s.id = r.service_id and s.active
     and (s.online_bookable or not p_public)
    join public.staff_services ss
      on ss.business_id = p_business_id and ss.staff_id = p_staff_id and ss.service_id = s.id
  ) l
  -- appointment_services.position is 0..20
  having count(*) = cardinality(p_service_ids) and count(*) between 1 and 21;
$$;

-- ---------------------------------------------------------------------------------------------
-- private.staff_day_windows: when one staff member works on one LOCAL date, as UTC instants.
--   precedence: staff exception > shop exception > weekly working_hours (the first scope that has
--   anything for the date wins completely); a 'closed' of the winning scope = no windows; several
--   'open' intervals (or split working hours) are united, back-to-back ones merge;
--   local → UTC once per date with (date + time) AT TIME ZONE businesses.timezone;
--   minus time_off. Windows never cross the local day (times are within 00:00–24:00).
-- A boundary inside a spring-forward gap follows PostgreSQL (the pre-transition offset), which
-- keeps the length of the shift; slot starts inside the gap are skipped by available_slots_core.
-- ---------------------------------------------------------------------------------------------
create function private.staff_day_windows(p_business_id uuid, p_staff_id uuid, p_local_date date)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql
stable
set search_path = ''
as $$
  with biz as (
    select b.timezone from public.businesses b where b.id = p_business_id
  ),
  staff_exceptions as (
    select e.kind, e.start_time, e.end_time
    from public.schedule_exceptions e
    where e.business_id = p_business_id and e.staff_id = p_staff_id and e.local_date = p_local_date
  ),
  shop_exceptions as (
    select e.kind, e.start_time, e.end_time
    from public.schedule_exceptions e
    where e.business_id = p_business_id and e.staff_id is null and e.local_date = p_local_date
  ),
  winning as (
    select * from staff_exceptions
    union all
    select * from shop_exceptions
    where not exists (select 1 from staff_exceptions)
    union all
    select 'open', w.start_time, w.end_time
    from public.working_hours w
    where w.business_id = p_business_id and w.staff_id = p_staff_id
      and w.weekday = extract(dow from p_local_date)
      and not exists (select 1 from staff_exceptions)
      and not exists (select 1 from shop_exceptions)
  ),
  opening as (
    select range_agg(tstzrange(
      (p_local_date + x.start_time) at time zone biz.timezone,
      (p_local_date + x.end_time) at time zone biz.timezone,
      '[)'
    )) as mr
    from winning x cross join biz
    where x.kind = 'open'
      and not exists (select 1 from winning c where c.kind = 'closed')
  ),
  time_off as (
    select range_agg(tstzrange(t.starts_at, t.ends_at, '[)')) as mr
    from public.time_off t cross join biz
    where t.business_id = p_business_id and t.staff_id = p_staff_id
      and t.starts_at < ((p_local_date + 1)::timestamp at time zone biz.timezone)
      and t.ends_at > (p_local_date::timestamp at time zone biz.timezone)
  )
  select lower(r.w), upper(r.w)
  from opening
  cross join time_off
  cross join lateral unnest(opening.mr - coalesce(time_off.mr, '{}'::tstzmultirange)) as r (w)
  where opening.mr is not null
  order by 1;
$$;

-- ---------------------------------------------------------------------------------------------
-- private.booking_staff_terms: validates services and staff for a booking or a slot search and
-- returns the staff members able to do ALL the services, with their own terms (sort order).
--   AN003: empty list, a service of another business / inactive / (public) not online_bookable,
--          the chosen staff member does not offer them all, or nobody active offers them all.
--   AN008: the chosen staff member is of another business or inactive; "any staff" in public
--          mode while businesses.allow_any_staff is off.
-- ---------------------------------------------------------------------------------------------
create function private.booking_staff_terms(
  p_business_id uuid,
  p_service_ids uuid[],
  p_staff_id uuid,
  p_public boolean
)
returns table (
  staff_id uuid, staff_sort smallint, duration_min integer, buffer_after_min integer,
  price_cents integer, lines jsonb
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_service_ids is null
     or cardinality(p_service_ids) not between 1 and 21
     or array_position(p_service_ids, null) is not null
     or exists (
       select 1 from unnest(p_service_ids) as u (service_id)
       where not exists (
         select 1 from public.services s
         where s.business_id = p_business_id and s.id = u.service_id and s.active
           and (s.online_bookable or not p_public)
       )
     ) then
    perform private.raise_domain_error('AN003');
  end if;

  if p_staff_id is not null then
    if not exists (
      select 1 from public.staff st
      where st.business_id = p_business_id and st.id = p_staff_id and st.active
    ) then
      perform private.raise_domain_error('AN008');
    end if;
  elsif p_public and not coalesce(
    (select b.allow_any_staff from public.businesses b where b.id = p_business_id), false
  ) then
    perform private.raise_domain_error('AN008');
  end if;

  return query
    select st.id, st.sort, t.duration_min, t.buffer_after_min, t.price_cents, t.lines
    from public.staff st
    cross join lateral private.service_terms(p_business_id, st.id, p_service_ids, p_public) t
    where st.business_id = p_business_id and st.active
      and (p_staff_id is null or st.id = p_staff_id)
    order by st.sort, st.id;

  if not found then
    perform private.raise_domain_error('AN003');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- private.available_slots_core: free starts on the LOCAL grid for local dates p_from..p_to.
-- private.available_slots_impl (below) is this without p_block; only move_core passes a block.
--   · at most 14 local dates per call (AN002, also when p_to < p_from);
--   · a start is on the grid when its local minute-of-day % slot_step_min = 0; local times that
--     do not exist (spring forward) are skipped; an ambiguous local time (fall back) maps to one
--     instant (PostgreSQL's rule), so it appears once;
--   · the whole block [start, start + duration + buffer) must fit inside one working window and
--     must not overlap any booked/confirmed appointment of that staff member INCLUDING its
--     buffer [starts_at, ends_at + buffer_after_min); cancelled/completed/no_show never block;
--     p_exclude_appointment_id is ignored (a move checks against everything else);
--   · 'public': booking_enabled (otherwise an empty result), min_notice_min from p_now,
--     max_advance_days from p_now's local date, online_bookable, allow_any_staff;
--     'staff': none of these; active staff and services apply in both modes;
--   · p_staff_id null = union over every capable active staff member, one row per start, with
--     the candidates in staff_ids (by sort, id);
--   · p_block (one staff member only, else 22023): the length of the block that has to fit,
--     instead of the terms' duration + buffer. A move keeps the duration and buffer copied at
--     booking time, so move_core passes them and the public recheck tests the block it writes.
--     Services and staff are validated the same way (AN003 / AN008).
-- ---------------------------------------------------------------------------------------------
create function private.available_slots_core(
  p_business_id uuid,
  p_service_ids uuid[],
  p_staff_id uuid,
  p_from date,
  p_to date,
  p_mode text,
  p_exclude_appointment_id uuid,
  p_now timestamptz,
  p_block interval
)
returns table (starts_at timestamptz, local_date date, local_time time, staff_ids uuid[])
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_public boolean;
  v_tz text;
  v_step interval;
  v_booking_enabled boolean;
  v_min_notice integer;
  v_max_advance integer;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_earliest timestamptz;
  v_last_date date;
begin
  if p_mode is null or p_mode not in ('public', 'staff') then
    raise exception 'p_mode must be public or staff' using errcode = '22023';
  end if;
  v_public := p_mode = 'public';

  if p_from is null or p_to is null or p_to < p_from or p_to - p_from + 1 > 14 then
    perform private.raise_domain_error('AN002');
  end if;

  if p_block is not null and (p_staff_id is null or p_block <= interval '0') then
    raise exception 'a block length is given for one staff member and is positive' using errcode = '22023';
  end if;

  select b.timezone, make_interval(mins => b.slot_step_min), b.booking_enabled,
         b.min_notice_min, b.max_advance_days
    into v_tz, v_step, v_booking_enabled, v_min_notice, v_max_advance
  from public.businesses b
  where b.id = p_business_id;

  if not found or (v_public and not v_booking_enabled) then
    return;
  end if;

  v_range_start := p_from::timestamp at time zone v_tz;
  v_range_end := (p_to + 1)::timestamp at time zone v_tz;
  if v_public then
    v_earliest := p_now + make_interval(mins => v_min_notice);
    v_last_date := (p_now at time zone v_tz)::date + v_max_advance;
  end if;

  return query
  with terms as (
    select t.staff_id, t.staff_sort,
           coalesce(p_block, make_interval(mins => t.duration_min + t.buffer_after_min)) as block
    from private.booking_staff_terms(p_business_id, p_service_ids, p_staff_id, v_public) t
  ),
  days as (
    select p_from + i as day from generate_series(0, p_to - p_from) as i
  ),
  busy as (
    select a.staff_id,
           range_agg(tstzrange(a.starts_at, a.ends_at + make_interval(mins => a.buffer_after_min), '[)')) as mr
    from public.appointments a
    where a.business_id = p_business_id
      and a.staff_id in (select t.staff_id from terms t)
      and a.status in ('booked', 'confirmed')
      and a.id is distinct from p_exclude_appointment_id
      and a.starts_at < v_range_end
      -- sargable lower bound: an appointment lasts ≤ 12 h and its buffer ≤ 120 min
      and a.starts_at > v_range_start - interval '15 hours'
      and a.ends_at + make_interval(mins => a.buffer_after_min) > v_range_start
    group by a.staff_id
  ),
  -- materialized: the multirange difference is computed once per staff member and day, not
  -- once per candidate start (the planner would otherwise push it into the join filter)
  free as materialized (
    select t.staff_id, t.staff_sort, t.block, d.day,
           w.mr - coalesce(b.mr, '{}'::tstzmultirange) as mr
    from terms t
    cross join days d
    cross join lateral (
      select range_agg(tstzrange(x.starts_at, x.ends_at, '[)')) as mr
      from private.staff_day_windows(p_business_id, t.staff_id, d.day) x
    ) w
    left join busy b on b.staff_id = t.staff_id
    where w.mr is not null
      and (not v_public or d.day <= v_last_date)
  ),
  candidates as (
    select f.staff_id, f.staff_sort, g.instant
    from free f
    cross join lateral (
      select lt at time zone v_tz as instant, lt
      from generate_series(f.day::timestamp, f.day::timestamp + interval '1 day' - v_step, v_step) as lt
    ) g
    where not isempty(f.mr)
      -- a local time that does not exist (spring forward) round-trips to another wall time
      and (g.instant at time zone v_tz) = g.lt
      and tstzrange(g.instant, g.instant + f.block, '[)') <@ f.mr
      and (not v_public or g.instant >= v_earliest)
  )
  select c.instant,
         (c.instant at time zone v_tz)::date,
         (c.instant at time zone v_tz)::time,
         array_agg(c.staff_id order by c.staff_sort, c.staff_id)
  from candidates c
  group by c.instant
  order by c.instant;
end;
$$;

-- The slot search as the booking page, the staff app and book_core see it: each staff member's
-- block is the duration + buffer of their terms.
create function private.available_slots_impl(
  p_business_id uuid,
  p_service_ids uuid[],
  p_staff_id uuid,
  p_from date,
  p_to date,
  p_mode text,
  p_exclude_appointment_id uuid default null,
  p_now timestamptz default now()
)
returns table (starts_at timestamptz, local_date date, local_time time, staff_ids uuid[])
language sql
stable
set search_path = ''
as $$
  select s.starts_at, s.local_date, s.local_time, s.staff_ids
  from private.available_slots_core(
    p_business_id, p_service_ids, p_staff_id, p_from, p_to, p_mode, p_exclude_appointment_id, p_now, null
  ) s;
$$;

-- ---------------------------------------------------------------------------------------------
-- Booking helpers
-- ---------------------------------------------------------------------------------------------

-- Service minutes a staff member already has on a local date ("any staff" picks the least busy).
-- Completed visits of the day count too, so marking one done does not make a barber look free.
create function private.booked_minutes(p_business_id uuid, p_staff_id uuid, p_local_date date)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(extract(epoch from (a.ends_at - a.starts_at)) / 60), 0)::integer
  from public.appointments a
  join public.businesses b on b.id = a.business_id
  where a.business_id = p_business_id
    and a.staff_id = p_staff_id
    and a.status in ('booked', 'confirmed', 'completed')
    and a.starts_at >= (p_local_date::timestamp at time zone b.timezone)
    and a.starts_at < ((p_local_date + 1)::timestamp at time zone b.timezone);
$$;

-- Staff mode (SPEC §8.8): what stands in the way of [p_starts_at, p_ends_at) + buffer.
--   service_overlap: the service time overlaps another appointment's SERVICE time (never allowed)
--   buffer_overlap:  the block (service + own buffer) overlaps another appointment's block
--                    (squeeze; true as well when service_overlap is)
--   outside_hours:   the block is not inside the staff member's windows of the local day(s)
create function private.staff_time_check(
  p_business_id uuid,
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_buffer_min integer,
  p_exclude_appointment_id uuid
)
returns table (service_overlap boolean, buffer_overlap boolean, outside_hours boolean)
language sql
stable
set search_path = ''
as $$
  with biz as (
    select b.timezone from public.businesses b where b.id = p_business_id
  ),
  span as (
    select tstzrange(p_starts_at, p_ends_at, '[)') as service,
           tstzrange(p_starts_at, p_ends_at + make_interval(mins => p_buffer_min), '[)') as block
  ),
  days as (
    select (p_starts_at at time zone biz.timezone)::date + i as day
    from biz cross join span
    cross join generate_series(
      0,
      ((upper(span.block) - interval '1 microsecond') at time zone biz.timezone)::date
        - (p_starts_at at time zone biz.timezone)::date
    ) as i
  ),
  others as (
    select tstzrange(a.starts_at, a.ends_at, '[)') as service,
           tstzrange(a.starts_at, a.ends_at + make_interval(mins => a.buffer_after_min), '[)') as block
    from public.appointments a
    where a.business_id = p_business_id
      and a.staff_id = p_staff_id
      and a.status in ('booked', 'confirmed')
      and a.id is distinct from p_exclude_appointment_id
      and a.starts_at < p_ends_at + make_interval(mins => p_buffer_min)
      and a.starts_at > p_starts_at - interval '15 hours'
  )
  select
    exists (select 1 from others o cross join span where o.service && span.service),
    exists (select 1 from others o cross join span where o.block && span.block),
    not coalesce((
      select span.block <@ range_agg(tstzrange(w.starts_at, w.ends_at, '[)'))
      from span, days cross join lateral private.staff_day_windows(p_business_id, p_staff_id, days.day) w
      group by span.block
    ), false);
$$;

-- Serialises bookings and moves per business and LOCAL day. Every local date that the given
-- spans touch is locked, in ascending order (a block that crosses midnight locks both days), so
-- two writers whose blocks overlap always share a lock and never deadlock. The key text is the
-- ISO date, i.e. hashtextextended(business_id || ':' || 'YYYY-MM-DD', 0).
create function private.lock_local_days(p_business_id uuid, p_spans tstzrange[])
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_tz text;
  v_day date;
begin
  select b.timezone into v_tz from public.businesses b where b.id = p_business_id;
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

create function private.booking_result(
  p_appointment_id uuid,
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_total_cents integer,
  p_replayed boolean,
  p_warnings text[]
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'appointment_id', p_appointment_id,
    'staff_id', p_staff_id,
    'starts_at', p_starts_at,
    'ends_at', p_ends_at,
    'total_cents', p_total_cents,
    'replayed', p_replayed,
    'warnings', to_jsonb(coalesce(p_warnings, '{}'::text[]))
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- private.plan_messages_impl: the message planner (Phase 1 plan, "Κανόνες"). The booking and
-- move paths call it explicitly (no generic trigger on appointments). Empty until 1.3/1.5a,
-- which replace only the body; p_change is 'created' | 'moved' (| 'cancelled' later).
-- ---------------------------------------------------------------------------------------------
create function private.plan_messages_impl(p_appointment_id uuid, p_change text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  null;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- private.book_core: the only way appointments are created by the application.
-- Order: actor → business → payload hash → day lock(s) → idempotency → services/staff (AN003,
-- AN008) → client (AN007) → recheck (AN001/AN005/AN006) → client insert → appointment insert
-- (23P01 → AN001) → service lines → planner.
--   · 'public' declares actor 'client'; 'staff' declares nothing (→ 'staff' from the JWT).
--   · Price and duration come from service_terms, never from the caller.
--   · Client: an existing id of this business (not erased, not merged; in public mode its phone
--     must be p_verified_phone), or a NEW client from p_new_client, or none for a staff walk-in.
--     Never a lookup/merge by phone: a family shares one mobile.
--   · verified_via is passed through: the 0003 constraint requires it for 'online' and forbids
--     it otherwise.
-- ---------------------------------------------------------------------------------------------
create function private.book_core(
  p_business_id uuid,
  p_mode text,
  p_service_ids uuid[],
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_client_id uuid,
  p_new_client jsonb,
  p_source text,
  p_verified_via text,
  p_verified_phone text,
  p_idempotency_key uuid,
  p_allow_outside_hours boolean,
  p_allow_buffer_overlap boolean,
  p_created_by uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_public boolean;
  v_allow_outside boolean := coalesce(p_allow_outside_hours, false);
  v_allow_buffer boolean := coalesce(p_allow_buffer_overlap, false);
  v_tz text;
  v_booking_enabled boolean;
  v_business_locale text;
  v_local_date date;
  v_new_client jsonb;
  v_hash text;
  v_span_min integer;
  v_existing public.appointments%rowtype;
  v_client public.clients%rowtype;
  v_candidates uuid[];
  v_pick record;
  v_warnings text[] := '{}';
  v_client_id uuid;
  v_appointment public.appointments%rowtype;
  v_constraint text;
begin
  if p_mode is null or p_mode not in ('public', 'staff') then
    raise exception 'p_mode must be public or staff' using errcode = '22023';
  end if;
  v_public := p_mode = 'public';
  if v_public then
    perform set_config('anaklo.actor_type', 'client', true);
  end if;

  if p_starts_at is null then
    raise exception 'p_starts_at is required' using errcode = '22023';
  end if;

  select b.timezone, b.booking_enabled, b.locale
    into v_tz, v_booking_enabled, v_business_locale
  from public.businesses b
  where b.id = p_business_id;
  if not found or (v_public and not v_booking_enabled) then
    perform private.raise_domain_error('AN009');
  end if;

  if v_public and p_source is distinct from 'online' then
    raise exception 'public bookings have source online' using errcode = '22023';
  end if;
  if not v_public and (p_source is null or p_source not in ('staff', 'phone', 'walkin')) then
    raise exception 'staff bookings have source staff, phone or walkin' using errcode = '22023';
  end if;

  v_local_date := (p_starts_at at time zone v_tz)::date;

  if p_new_client is not null then
    if jsonb_typeof(p_new_client) <> 'object' then
      perform private.raise_domain_error('AN007');
    end if;
    v_new_client := jsonb_strip_nulls(jsonb_build_object(
      'full_name', nullif(btrim(p_new_client ->> 'full_name'), ''),
      'phone_e164', nullif(btrim(p_new_client ->> 'phone_e164'), ''),
      'email', nullif(btrim(p_new_client ->> 'email'), ''),
      'locale', nullif(btrim(p_new_client ->> 'locale'), '')
    ));
  end if;

  -- Canonical request: every argument that shapes the booking, except the key and the clock.
  -- jsonb text is canonical (sorted keys); the instant is an epoch, independent of TimeZone.
  if p_idempotency_key is not null then
    v_hash := encode(sha256(convert_to(jsonb_build_object(
      'business_id', p_business_id,
      'mode', p_mode,
      'service_ids', to_jsonb(p_service_ids),
      'staff_id', p_staff_id,
      'starts_at', extract(epoch from p_starts_at),
      'client_id', p_client_id,
      'new_client', v_new_client,
      'source', p_source,
      'verified_via', p_verified_via,
      'verified_phone', p_verified_phone,
      'allow_outside_hours', v_allow_outside,
      'allow_buffer_overlap', v_allow_buffer,
      'created_by', p_created_by
    )::text, 'UTF8')), 'hex');
  end if;

  -- Lock the local day(s) the longest possible block of this request touches, BEFORE the
  -- idempotency lookup and the recheck. Nothing is validated yet (a replay must not fail
  -- because the catalogue changed since); unknown services lock just the start day.
  select coalesce(max(t.duration_min + t.buffer_after_min), 0)
    into v_span_min
  from public.staff st
  cross join lateral private.service_terms(p_business_id, st.id, p_service_ids, v_public) t
  where st.business_id = p_business_id and (p_staff_id is null or st.id = p_staff_id);

  perform private.lock_local_days(
    p_business_id,
    array[tstzrange(p_starts_at, p_starts_at + make_interval(mins => greatest(v_span_min, 1)), '[)')]
  );

  -- Idempotency: the same key and payload return the first booking (no new row, no event).
  if p_idempotency_key is not null then
    select * into v_existing
    from public.appointments a
    where a.business_id = p_business_id and a.idempotency_key = p_idempotency_key;
    if found then
      if v_existing.request_hash is distinct from v_hash then
        perform private.raise_domain_error('AN004');
      end if;
      return private.booking_result(
        v_existing.id, v_existing.staff_id, v_existing.starts_at, v_existing.ends_at,
        v_existing.total_cents, true, '{}'
      );
    end if;
  end if;

  -- Services and staff (AN003 / AN008).
  perform 1 from private.booking_staff_terms(p_business_id, p_service_ids, p_staff_id, v_public);

  -- Client (AN007).
  if p_client_id is not null and p_new_client is not null then
    perform private.raise_domain_error('AN007');
  elsif p_client_id is not null then
    select * into v_client
    from public.clients c
    where c.business_id = p_business_id and c.id = p_client_id
      and c.erased_at is null and c.merged_into_id is null;
    if not found
       or (v_public and (p_verified_phone is null or v_client.phone_e164 is distinct from p_verified_phone)) then
      perform private.raise_domain_error('AN007');
    end if;
  elsif p_new_client is not null then
    if v_new_client ->> 'full_name' is null
       or (v_public and (
         p_verified_phone is null
         or coalesce(v_new_client ->> 'phone_e164', p_verified_phone) <> p_verified_phone
       )) then
      perform private.raise_domain_error('AN007');
    end if;
  elsif v_public or p_source <> 'walkin' then
    -- only an anonymous walk-in entered by staff has no client
    perform private.raise_domain_error('AN007');
  end if;

  -- Recheck under the lock.
  if v_public then
    -- Public: the start must be one of the slots (buffers, hours and notice always respected).
    select s.staff_ids into v_candidates
    from private.available_slots_impl(
      p_business_id, p_service_ids, p_staff_id, v_local_date, v_local_date, 'public', null, p_now
    ) s
    where s.starts_at = p_starts_at;

    if v_candidates is null then
      perform private.raise_domain_error('AN001');
    end if;

    select t.staff_id, t.duration_min, t.buffer_after_min, t.price_cents, t.lines
      into v_pick
    from private.booking_staff_terms(p_business_id, p_service_ids, p_staff_id, true) t
    where t.staff_id = any (v_candidates)
    order by private.booked_minutes(p_business_id, t.staff_id, v_local_date), t.staff_sort, t.staff_id
    limit 1;
  else
    -- Staff: any time (also off the grid); never over another service; outside the hours or
    -- into a buffer only with the explicit flag, and then with a warning (SPEC §8.8, D8).
    select x.staff_id, x.duration_min, x.buffer_after_min, x.price_cents, x.lines,
           x.service_overlap, x.buffer_only, x.outside_hours
      into v_pick
    from (
      select t.staff_id, t.staff_sort, t.duration_min, t.buffer_after_min, t.price_cents, t.lines,
             c.service_overlap,
             c.buffer_overlap and not c.service_overlap as buffer_only,
             c.outside_hours,
             private.booked_minutes(p_business_id, t.staff_id, v_local_date) as minutes
      from private.booking_staff_terms(p_business_id, p_service_ids, p_staff_id, false) t
      cross join lateral private.staff_time_check(
        p_business_id, t.staff_id, p_starts_at,
        p_starts_at + make_interval(mins => t.duration_min), t.buffer_after_min, null
      ) c
    ) x
    order by x.service_overlap,
             (x.outside_hours and not v_allow_outside)::integer + (x.buffer_only and not v_allow_buffer)::integer,
             x.outside_hours::integer + x.buffer_only::integer,
             x.minutes, x.staff_sort, x.staff_id
    limit 1;

    if v_pick.service_overlap then
      perform private.raise_domain_error('AN001');
    end if;
    if v_pick.outside_hours then
      if not v_allow_outside then
        perform private.raise_domain_error('AN005');
      end if;
      v_warnings := v_warnings || 'outside_hours'::text;
    end if;
    if v_pick.buffer_only then
      if not v_allow_buffer then
        perform private.raise_domain_error('AN006');
      end if;
      v_warnings := v_warnings || 'buffer_overlap'::text;
    end if;
  end if;

  -- Write. The client insert is inside the block, so a lost race leaves no orphan client.
  begin
    if p_client_id is not null then
      v_client_id := p_client_id;
    elsif v_new_client is not null then
      insert into public.clients (business_id, full_name, phone_e164, email, locale, source)
      values (
        p_business_id,
        v_new_client ->> 'full_name',
        case when v_public then p_verified_phone else v_new_client ->> 'phone_e164' end,
        v_new_client ->> 'email',
        coalesce(v_new_client ->> 'locale', v_business_locale),
        case when v_public then 'online' else 'staff' end
      )
      returning id into v_client_id;
    end if;

    insert into public.appointments (
      business_id, client_id, staff_id, starts_at, ends_at, buffer_after_min, status, source,
      verified_via, total_cents, idempotency_key, request_hash, created_by
    )
    values (
      p_business_id, v_client_id, v_pick.staff_id, p_starts_at,
      p_starts_at + make_interval(mins => v_pick.duration_min), v_pick.buffer_after_min, 'booked',
      p_source, p_verified_via, v_pick.price_cents, p_idempotency_key, v_hash, p_created_by
    )
    returning * into v_appointment;
  exception
    when exclusion_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'appointments_no_overlap' then
        perform private.raise_domain_error('AN001');
      end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'appointments_idempotency_key' then
        select * into v_existing
        from public.appointments a
        where a.business_id = p_business_id and a.idempotency_key = p_idempotency_key;
        if found and v_existing.request_hash = v_hash then
          return private.booking_result(
            v_existing.id, v_existing.staff_id, v_existing.starts_at, v_existing.ends_at,
            v_existing.total_cents, true, '{}'
          );
        end if;
        perform private.raise_domain_error('AN004');
      end if;
      raise;
  end;

  insert into public.appointment_services (business_id, appointment_id, position, service_id, price_cents, duration_min)
  select p_business_id, v_appointment.id, (l ->> 'position')::smallint, (l ->> 'service_id')::uuid,
         (l ->> 'price_cents')::integer, (l ->> 'duration_min')::smallint
  from jsonb_array_elements(v_pick.lines) as l;

  perform private.plan_messages_impl(v_appointment.id, 'created');

  return private.booking_result(
    v_appointment.id, v_appointment.staff_id, v_appointment.starts_at, v_appointment.ends_at,
    v_appointment.total_cents, false, v_warnings
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- private.move_core: the only way an appointment changes time or staff member (client link in
-- 1.3, staff app in 1.4). Row lock first, then the local days of the old AND the new block in
-- ascending order (same order as book_core, so no deadlocks); recheck without the appointment
-- itself; update in place (the 0003 trigger writes rescheduled/reassigned). Duration and price
-- are recomputed only when the staff member changes (custom terms); otherwise they are kept.
-- Whatever block is written is the block that is checked: in public mode it must be a free slot
-- for exactly that length + buffer (a catalogue change since the booking changes nothing), in
-- staff mode staff_time_check tests it.
-- Only booked/confirmed appointments move (23514). p_new_staff_id null = same staff member.
-- ---------------------------------------------------------------------------------------------
create function private.move_core(
  p_business_id uuid,
  p_appointment_id uuid,
  p_new_starts_at timestamptz,
  p_new_staff_id uuid,
  p_mode text,
  p_allow_outside_hours boolean,
  p_allow_buffer_overlap boolean,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_public boolean;
  v_allow_outside boolean := coalesce(p_allow_outside_hours, false);
  v_allow_buffer boolean := coalesce(p_allow_buffer_overlap, false);
  v_tz text;
  v_appointment public.appointments%rowtype;
  v_staff_id uuid;
  v_service_ids uuid[];
  v_terms record;
  v_recomputed boolean := false;
  v_length interval;
  v_buffer integer;
  v_total integer;
  v_new_ends_at timestamptz;
  v_local_date date;
  v_check record;
  v_warnings text[] := '{}';
  v_constraint text;
begin
  if p_mode is null or p_mode not in ('public', 'staff') then
    raise exception 'p_mode must be public or staff' using errcode = '22023';
  end if;
  v_public := p_mode = 'public';
  if v_public then
    perform set_config('anaklo.actor_type', 'client', true);
  end if;

  if p_new_starts_at is null then
    raise exception 'p_new_starts_at is required' using errcode = '22023';
  end if;

  select * into v_appointment
  from public.appointments a
  where a.business_id = p_business_id and a.id = p_appointment_id
  for update;
  if not found then
    raise exception 'appointment not found in this business' using errcode = '42501';
  end if;
  if v_appointment.status not in ('booked', 'confirmed') then
    raise exception 'only booked or confirmed appointments can be moved (status %)', v_appointment.status
      using errcode = '23514';
  end if;

  select b.timezone into v_tz from public.businesses b where b.id = p_business_id;
  if v_public and not (select b.booking_enabled from public.businesses b where b.id = p_business_id) then
    perform private.raise_domain_error('AN009');
  end if;

  v_staff_id := coalesce(p_new_staff_id, v_appointment.staff_id);
  select array_agg(s.service_id order by s.position) into v_service_ids
  from public.appointment_services s
  where s.business_id = p_business_id and s.appointment_id = p_appointment_id;

  if v_staff_id <> v_appointment.staff_id and v_service_ids is not null then
    -- New staff member: their own (custom) terms; validates them (AN003 / AN008).
    select t.duration_min, t.buffer_after_min, t.price_cents, t.lines into v_terms
    from private.booking_staff_terms(p_business_id, v_service_ids, v_staff_id, v_public) t;
    v_recomputed := true;
    v_length := make_interval(mins => v_terms.duration_min);
    v_buffer := v_terms.buffer_after_min;
    v_total := v_terms.price_cents;
  else
    if not exists (
      select 1 from public.staff st
      where st.business_id = p_business_id and st.id = v_staff_id and st.active
    ) then
      perform private.raise_domain_error('AN008');
    end if;
    v_length := v_appointment.ends_at - v_appointment.starts_at;
    v_buffer := v_appointment.buffer_after_min;
    v_total := v_appointment.total_cents;
  end if;
  v_new_ends_at := p_new_starts_at + v_length;
  v_local_date := (p_new_starts_at at time zone v_tz)::date;

  if p_new_starts_at = v_appointment.starts_at and v_staff_id = v_appointment.staff_id then
    return jsonb_build_object(
      'appointment_id', v_appointment.id, 'staff_id', v_appointment.staff_id,
      'starts_at', v_appointment.starts_at, 'ends_at', v_appointment.ends_at,
      'warnings', to_jsonb(v_warnings)
    );
  end if;

  perform private.lock_local_days(p_business_id, array[
    tstzrange(v_appointment.starts_at,
              v_appointment.ends_at + make_interval(mins => v_appointment.buffer_after_min), '[)'),
    tstzrange(p_new_starts_at, v_new_ends_at + make_interval(mins => v_buffer), '[)')
  ]);

  if v_public then
    if v_service_ids is null then
      perform private.raise_domain_error('AN003');
    end if;
    -- The start must be a public slot (grid, notice, advance, hours, every other block with its
    -- buffer) for the block that is WRITTEN: the kept length and buffer, or the new staff
    -- member's terms. Today's catalogue terms would test a different block.
    if not exists (
      select 1
      from private.available_slots_core(
        p_business_id, v_service_ids, v_staff_id, v_local_date, v_local_date, 'public',
        p_appointment_id, p_now, v_length + make_interval(mins => v_buffer)
      ) s
      where s.starts_at = p_new_starts_at
    ) then
      perform private.raise_domain_error('AN001');
    end if;
  else
    select * into v_check
    from private.staff_time_check(
      p_business_id, v_staff_id, p_new_starts_at, v_new_ends_at, v_buffer, p_appointment_id
    );
    if v_check.service_overlap then
      perform private.raise_domain_error('AN001');
    end if;
    if v_check.outside_hours then
      if not v_allow_outside then
        perform private.raise_domain_error('AN005');
      end if;
      v_warnings := v_warnings || 'outside_hours'::text;
    end if;
    if v_check.buffer_overlap then
      if not v_allow_buffer then
        perform private.raise_domain_error('AN006');
      end if;
      v_warnings := v_warnings || 'buffer_overlap'::text;
    end if;
  end if;

  begin
    update public.appointments a
    set starts_at = p_new_starts_at,
        ends_at = v_new_ends_at,
        staff_id = v_staff_id,
        buffer_after_min = v_buffer,
        total_cents = v_total
    where a.business_id = p_business_id and a.id = p_appointment_id
    returning * into v_appointment;
  exception
    when exclusion_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'appointments_no_overlap' then
        perform private.raise_domain_error('AN001');
      end if;
      raise;
  end;

  if v_recomputed then
    -- Lines keep their positions; the n-th line (by position) takes the n-th new term.
    update public.appointment_services s
    set price_cents = (n.line ->> 'price_cents')::integer,
        duration_min = (n.line ->> 'duration_min')::smallint
    from (
      select o.position, l.line
      from (
        select x.position, row_number() over (order by x.position) as rn
        from public.appointment_services x
        where x.business_id = p_business_id and x.appointment_id = p_appointment_id
      ) o
      join (
        select e.line, (e.line ->> 'position')::integer + 1 as rn
        from jsonb_array_elements(v_terms.lines) as e (line)
      ) l on l.rn = o.rn
    ) n
    where s.business_id = p_business_id and s.appointment_id = p_appointment_id
      and s.position = n.position;
  end if;

  perform private.plan_messages_impl(v_appointment.id, 'moved');

  return jsonb_build_object(
    'appointment_id', v_appointment.id, 'staff_id', v_appointment.staff_id,
    'starts_at', v_appointment.starts_at, 'ends_at', v_appointment.ends_at,
    'warnings', to_jsonb(v_warnings)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- API: public booking page (anon). Only public fields; only businesses with booking enabled.
-- ---------------------------------------------------------------------------------------------
create function private.public_booking_catalogue_impl(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'business', jsonb_build_object(
      'id', b.id, 'slug', b.slug, 'name', b.name, 'vertical', b.vertical,
      'timezone', b.timezone, 'locale', b.locale, 'theme', b.theme,
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
  where b.slug = lower(p_slug) and b.booking_enabled;
$$;

create function public.public_booking_catalogue(p_slug text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.public_booking_catalogue_impl(p_slug);
$$;

comment on function public.public_booking_catalogue(text) is
  'Booking page catalogue: business profile, categories, bookable services and active staff with their terms. Null when the slug is unknown or booking is disabled.';

-- The slug form of available_slots_impl (an overload): resolves a bookable business and runs the
-- core in public mode with the real clock. Unknown or disabled slug → no rows.
create function private.available_slots_impl(
  p_slug text,
  p_service_ids uuid[],
  p_staff_id uuid,
  p_from date,
  p_to date
)
returns table (starts_at timestamptz, local_date date, local_time time, staff_ids uuid[])
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_business_id uuid;
begin
  select b.id into v_business_id
  from public.businesses b
  where b.slug = lower(p_slug) and b.booking_enabled;
  if v_business_id is null then
    return;
  end if;

  return query
    select s.starts_at, s.local_date, s.local_time, s.staff_ids
    from private.available_slots_impl(
      v_business_id, p_service_ids, p_staff_id, p_from, p_to, 'public', null::uuid, now()
    ) s;
end;
$$;

create function public.available_slots(
  p_slug text,
  p_service_ids uuid[],
  p_staff_id uuid,
  p_from date,
  p_to date
)
returns table (starts_at timestamptz, local_date date, local_time time, staff_ids uuid[])
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.available_slots_impl(p_slug, p_service_ids, p_staff_id, p_from, p_to);
$$;

comment on function public.available_slots(text, uuid[], uuid, date, date) is
  'Booking page: free starts for local dates p_from..p_to (≤ 14), p_staff_id null = any staff.';

grant execute on function private.public_booking_catalogue_impl(text) to anon, authenticated, service_role;
grant execute on function public.public_booking_catalogue(text) to anon, authenticated, service_role;
grant execute on function private.available_slots_impl(text, uuid[], uuid, date, date) to anon, authenticated, service_role;
grant execute on function public.available_slots(text, uuid[], uuid, date, date) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- API: staff app (authenticated). Membership is checked first, before any other argument.
-- ---------------------------------------------------------------------------------------------
create function private.staff_available_slots_impl(
  p_business_id uuid,
  p_service_ids uuid[],
  p_staff_id uuid,
  p_from date,
  p_to date,
  p_exclude_appointment_id uuid
)
returns table (starts_at timestamptz, local_date date, local_time time, staff_ids uuid[])
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
  if p_exclude_appointment_id is not null and not exists (
    select 1 from public.appointments a
    where a.business_id = p_business_id and a.id = p_exclude_appointment_id
  ) then
    raise exception 'appointment not found in this business' using errcode = '42501';
  end if;

  return query
    select s.starts_at, s.local_date, s.local_time, s.staff_ids
    from private.available_slots_impl(
      p_business_id, p_service_ids, p_staff_id, p_from, p_to, 'staff', p_exclude_appointment_id, now()
    ) s;
end;
$$;

create function public.staff_available_slots(
  p_business_id uuid,
  p_service_ids uuid[],
  p_staff_id uuid,
  p_from date,
  p_to date,
  p_exclude_appointment_id uuid default null
)
returns table (starts_at timestamptz, local_date date, local_time time, staff_ids uuid[])
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.staff_available_slots_impl(
    p_business_id, p_service_ids, p_staff_id, p_from, p_to, p_exclude_appointment_id
  );
$$;

comment on function public.staff_available_slots(uuid, uuid[], uuid, date, date, uuid) is
  'Staff app: free starts without online-booking limits (notice, advance, online_bookable).';

-- Any member may book, also for a colleague (the shop's shared phone). Declares no actor, so the
-- event says 'staff' with the caller's id.
create function private.staff_book_appointment_impl(
  p_business_id uuid,
  p_service_ids uuid[],
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_client_id uuid,
  p_new_client jsonb,
  p_source text,
  p_idempotency_key uuid,
  p_allow_outside_hours boolean,
  p_allow_buffer_overlap boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;

  return private.book_core(
    p_business_id, 'staff', p_service_ids, p_staff_id, p_starts_at, p_client_id, p_new_client,
    p_source, null, null, p_idempotency_key, p_allow_outside_hours, p_allow_buffer_overlap,
    (select auth.uid()), now()
  );
end;
$$;

create function public.staff_book_appointment(
  p_business_id uuid,
  p_service_ids uuid[],
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_client_id uuid default null,
  p_new_client jsonb default null,
  p_source text default 'staff',
  p_idempotency_key uuid default null,
  p_allow_outside_hours boolean default false,
  p_allow_buffer_overlap boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.staff_book_appointment_impl(
    p_business_id, p_service_ids, p_staff_id, p_starts_at, p_client_id, p_new_client, p_source,
    p_idempotency_key, p_allow_outside_hours, p_allow_buffer_overlap
  );
$$;

comment on function public.staff_book_appointment(uuid, uuid[], uuid, timestamptz, uuid, jsonb, text, uuid, boolean, boolean) is
  'Staff app: book (existing client, new client inline, or anonymous walk-in) in one round trip. Returns {appointment_id, staff_id, starts_at, ends_at, total_cents, replayed, warnings}.';

grant execute on function private.staff_available_slots_impl(uuid, uuid[], uuid, date, date, uuid) to authenticated;
grant execute on function public.staff_available_slots(uuid, uuid[], uuid, date, date, uuid) to authenticated;
grant execute on function private.staff_book_appointment_impl(uuid, uuid[], uuid, timestamptz, uuid, jsonb, text, uuid, boolean, boolean) to authenticated;
grant execute on function public.staff_book_appointment(uuid, uuid[], uuid, timestamptz, uuid, jsonb, text, uuid, boolean, boolean) to authenticated;
