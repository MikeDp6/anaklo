-- 0008_schedule_ops.sql
-- Settings screens and urgent absence (SPEC §5 flow 6, §7, §8, §12; Phase 1 plan step 1.6).
-- Contract: docs/plans/contracts/1.6-settings-absence.md (§2 is this file).
--
--   time_off_no_overlap               one staff member's time off never overlaps (back-to-back allowed)
--   schedule_exceptions_note_shop_only  a note only on a shop-wide exception (GDPR art. 9: every
--                                     member reads every exception)
--   grants                            catalogue and weekly hours become RPC-only for the app; staff,
--                                     exceptions and time off get column grants; theme is script-only
--   private.staff_day_opening         the precedence rule (staff exception > shop exception > weekly
--                                     hours) in one place; staff_day_windows = opening − time off
--   private.schedule_conflicts_core   active appointments that no longer fit, with reason codes
--   private.replan_reminders_impl     queued reminders follow a change of quiet hours / reminder mode
--                                     (trigger businesses_replan_reminders; closes 1.5 D8)
--
-- API (authenticated only; thin SECURITY INVOKER wrappers in public, SECURITY DEFINER _impl in
-- private; check order in every _impl: membership → entity ids of the business → role → argument
-- shape → operation):
--   replace_week_hours, schedule_conflicts, mark_absence, reassign_candidates, reassign_appointment,
--   save_service, set_staff_order
-- Owner/manager only, except reassign_candidates and reassign_appointment (also the appointment's
-- own staff member). None declares an actor: reassign_appointment writes the appointment through
-- staff_move_appointment_impl (0006, 'staff' from the JWT); the others write no appointments. No new
-- domain error codes.

-- ---------------------------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------------------------

-- One staff member's time off never overlaps (an overlap would make "is X away?" ambiguous and
-- mark_absence's merge undefined). Back-to-back rows ('[)') are allowed. Fails here, loudly, if
-- overlapping rows already exist (contract D5: none do; fix by hand if it ever happens).
alter table public.time_off add constraint time_off_no_overlap exclude using gist (
  business_id with =,
  staff_id with =,
  tstzrange(starts_at, ends_at, '[)') with &&
);

-- Every member reads every exception (0001), so free text on one staff member's day off could
-- carry health data to the colleagues (GDPR art. 9). The note is for the whole shop («Αργία»).
alter table public.schedule_exceptions add constraint schedule_exceptions_note_shop_only
  check (staff_id is null or note is null);

-- ---------------------------------------------------------------------------------------------
-- Grants and policies (contract §2.3). Staff could never write these tables (RLS `_write` =
-- owner/manager); 0008 also closes the owner's paths that the app does not use.
-- service_role and anon: unchanged (provisioning keeps its table grants).
-- ---------------------------------------------------------------------------------------------

-- The theme changes only by script (plan §1.6).
revoke update (theme) on public.businesses from authenticated;

-- Catalogue and weekly hours: read-only for the app. Writes: save_service, replace_week_hours,
-- provisioning (categories only by provisioning).
revoke insert, update, delete on public.service_categories from authenticated;
revoke insert, update, delete on public.services from authenticated;
revoke insert, update, delete on public.staff_services from authenticated;
revoke insert, update, delete on public.working_hours from authenticated;

drop policy service_categories_write on public.service_categories;
drop policy services_write on public.services;
drop policy staff_services_write on public.staff_services;
drop policy working_hours_write on public.working_hours;

-- staff: created and edited by owner/manager with a client-generated id; never deleted (soft
-- delete via active, SPEC §7); sort changes only through set_staff_order; photo_url not in 1.6.
revoke insert, update, delete on public.staff from authenticated;
grant insert (id, business_id, display_name, color, sort, active) on public.staff to authenticated;
grant update (display_name, color, active) on public.staff to authenticated;

-- schedule_exceptions: added and deleted, never edited (to change one: delete and add).
revoke insert, update, delete on public.schedule_exceptions from authenticated;
grant insert (id, business_id, staff_id, local_date, kind, start_time, end_time, note)
  on public.schedule_exceptions to authenticated;
grant delete on public.schedule_exceptions to authenticated;

-- time_off: added, edited (range and reason) and deleted; never moved to another staff member.
revoke insert, update, delete on public.time_off from authenticated;
grant insert (id, business_id, staff_id, starts_at, ends_at, reason) on public.time_off to authenticated;
grant update (starts_at, ends_at, reason) on public.time_off to authenticated;
grant delete on public.time_off to authenticated;

-- ---------------------------------------------------------------------------------------------
-- private.staff_day_opening: when one staff member's shop is open for them on one LOCAL date,
-- before time off. Exactly one row:
--   scope   'staff' if the staff member has any exception that date, else 'shop' if the shop has
--           any, else 'weekly' (the first scope that has anything for the date wins completely);
--   closed  the winning scope has a 'closed' row;
--   windows its 'open' intervals (or the weekly hours) as instants via (date + time) AT TIME ZONE
--           businesses.timezone, merged; empty when closed or without hours.
-- The 0004 precedence text, moved here unchanged (no grants).
-- ---------------------------------------------------------------------------------------------
create function private.staff_day_opening(p_business_id uuid, p_staff_id uuid, p_local_date date)
returns table (scope text, closed boolean, windows tstzmultirange)
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
    select x.kind, x.start_time, x.end_time from staff_exceptions x
    union all
    select x.kind, x.start_time, x.end_time from shop_exceptions x
    where not exists (select 1 from staff_exceptions)
    union all
    select 'open', w.start_time, w.end_time
    from public.working_hours w
    where w.business_id = p_business_id and w.staff_id = p_staff_id
      and w.weekday = extract(dow from p_local_date)
      and not exists (select 1 from staff_exceptions)
      and not exists (select 1 from shop_exceptions)
  ),
  verdict as (
    select case when exists (select 1 from staff_exceptions) then 'staff'
                when exists (select 1 from shop_exceptions) then 'shop'
                else 'weekly' end as scope,
           exists (select 1 from winning c where c.kind = 'closed') as closed
  )
  select v.scope,
         v.closed,
         case when v.closed then '{}'::tstzmultirange
              else coalesce((
                select range_agg(tstzrange(
                  (p_local_date + x.start_time) at time zone biz.timezone,
                  (p_local_date + x.end_time) at time zone biz.timezone,
                  '[)'
                ))
                from winning x cross join biz
                where x.kind = 'open'
              ), '{}'::tstzmultirange)
         end
  from verdict v;
$$;

-- ---------------------------------------------------------------------------------------------
-- private.staff_day_windows (0004): body replaced, signature and rows unchanged. The working
-- windows of one staff member on one LOCAL date = staff_day_opening − time off, ordered by start.
-- 08_availability is its regression test.
-- ---------------------------------------------------------------------------------------------
create or replace function private.staff_day_windows(p_business_id uuid, p_staff_id uuid, p_local_date date)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql
stable
set search_path = ''
as $$
  with biz as (
    select b.timezone from public.businesses b where b.id = p_business_id
  ),
  opening as (
    select o.windows from private.staff_day_opening(p_business_id, p_staff_id, p_local_date) o
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
  cross join lateral unnest(opening.windows - coalesce(time_off.mr, '{}'::tstzmultirange)) as r (w)
  order by 1;
$$;

-- ---------------------------------------------------------------------------------------------
-- private.schedule_conflicts_core: the booked/confirmed appointments of the business (one staff
-- member, or all when p_staff_id is null) whose SERVICE time S = [starts_at, ends_at) overlaps
-- [p_from, p_to) and no longer fits. D = the local dates S touches. reasons, in this order:
--   shop_closed / staff_closed    some d ∈ D is closed with scope shop / staff;
--   time_off                      a time_off row of the staff member overlaps S;
--   special_hours / outside_hours no d ∈ D is closed and S is not inside the union of the opening
--                                 windows over D (special_hours when some d has an exception scope);
--   staff_inactive                the staff member is not active.
-- A row is returned iff reasons is not empty. The buffer is not compared (a buffer past closing
-- time inconveniences nobody). Never carries time_off.reason or an exception's note. The client's
-- name and phone are null for a walk-in without client and for an erased client. No grants.
-- ---------------------------------------------------------------------------------------------
create function private.schedule_conflicts_core(
  p_business_id uuid,
  p_staff_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  appointment_id uuid, staff_id uuid, starts_at timestamptz, ends_at timestamptz, status text,
  source text, client_id uuid, client_name text, client_phone_e164 text, service_ids uuid[],
  reasons text[]
)
language sql
stable
set search_path = ''
as $$
  with biz as (
    select b.timezone from public.businesses b where b.id = p_business_id
  ),
  cand as (
    select a.id, a.staff_id, a.starts_at, a.ends_at, a.status, a.source, a.client_id,
           st.sort as staff_sort, st.active as staff_active,
           (a.starts_at at time zone biz.timezone)::date as first_day,
           ((a.ends_at - interval '1 microsecond') at time zone biz.timezone)::date as last_day
    from public.appointments a
    cross join biz
    join public.staff st on st.business_id = a.business_id and st.id = a.staff_id
    where a.business_id = p_business_id
      and a.status in ('booked', 'confirmed')
      and (p_staff_id is null or a.staff_id = p_staff_id)
      and a.starts_at < p_to
      and a.ends_at > p_from
  ),
  cand_days as (
    select c.id, c.staff_id, c.first_day + i as day
    from cand c
    cross join lateral generate_series(0, c.last_day - c.first_day) as i
  ),
  -- once per staff member and date, not once per appointment
  openings as materialized (
    select d.staff_id, d.day, o.scope, o.closed, o.windows
    from (select distinct x.staff_id, x.day from cand_days x) d
    cross join lateral private.staff_day_opening(p_business_id, d.staff_id, d.day) o
  ),
  per_appointment as (
    select cd.id,
           bool_or(o.closed and o.scope = 'shop') as shop_closed,
           bool_or(o.closed and o.scope = 'staff') as staff_closed,
           bool_or(o.closed) as any_closed,
           bool_or(o.scope in ('staff', 'shop')) as special,
           range_agg(o.windows) as opening
    from cand_days cd
    join openings o on o.staff_id = cd.staff_id and o.day = cd.day
    group by cd.id
  ),
  flagged as (
    select c.id, c.staff_id, c.starts_at, c.ends_at, c.status, c.source, c.client_id, c.staff_sort,
           array_remove(array[
             case when p.shop_closed then 'shop_closed' end,
             case when p.staff_closed then 'staff_closed' end,
             case when exists (
               select 1 from public.time_off t
               where t.business_id = p_business_id and t.staff_id = c.staff_id
                 and t.starts_at < c.ends_at and t.ends_at > c.starts_at
             ) then 'time_off' end,
             case when not p.any_closed
                       and not coalesce(tstzrange(c.starts_at, c.ends_at, '[)') <@ p.opening, false)
                  then case when p.special then 'special_hours' else 'outside_hours' end
             end,
             case when not c.staff_active then 'staff_inactive' end
           ]::text[], null) as reasons
    from cand c
    join per_appointment p on p.id = c.id
  )
  select f.id,
         f.staff_id,
         f.starts_at,
         f.ends_at,
         f.status,
         f.source,
         f.client_id,
         case when cl.erased_at is null then nullif(cl.full_name, '') end,
         case when cl.erased_at is null then cl.phone_e164 end,
         coalesce((
           select array_agg(s.service_id order by s.position)
           from public.appointment_services s
           where s.business_id = p_business_id and s.appointment_id = f.id
         ), '{}'::uuid[]),
         f.reasons
  from flagged f
  left join public.clients cl on cl.business_id = p_business_id and cl.id = f.client_id
  where cardinality(f.reasons) > 0
  order by f.starts_at, f.staff_sort, f.staff_id, f.id;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC: replace_week_hours (§2.5.1). The whole week of one staff member in one call: delete, then
-- one insert of the new rows, under a lock per staff member (two editors: the last one wins, never
-- a mix). Overlapping rows → 23P01 from working_hours_no_overlap, and the delete rolls back with
-- it: nothing changes. The same set as stored → nothing written (changed false). Booked
-- appointments outside the new hours stay as they are; conflict_count reports them (from now,
-- 366 days).
-- p_rows: a JSON array of ≤ 70 objects with exactly weekday (integer 0–6, 0 = Sunday),
-- start_time ('HH:MM', 00:00–23:59) and end_time ('HH:MM', 00:01–24:00), end > start; [] = none.
-- ---------------------------------------------------------------------------------------------
create function private.replace_week_hours_impl(p_business_id uuid, p_staff_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_new jsonb;
  v_old jsonb;
  v_changed boolean;
  v_rows jsonb;
  v_conflicts integer;
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if p_staff_id is null or not exists (
    select 1 from public.staff st where st.business_id = p_business_id and st.id = p_staff_id
  ) then
    raise exception 'staff member not found in this business' using errcode = '42501';
  end if;
  if not private.has_role(p_business_id, array['owner', 'manager']) then
    raise exception 'only the owner or a manager may change working hours' using errcode = '42501';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 70 then
    raise exception 'p_rows must be an array of at most 70 rows' using errcode = '22023';
  end if;
  for v_row in select e.r from jsonb_array_elements(p_rows) as e (r) loop
    if jsonb_typeof(v_row) <> 'object' then
      raise exception 'every row is an object' using errcode = '22023';
    end if;
    if (select array_agg(k.key order by k.key) from jsonb_object_keys(v_row) as k (key))
       is distinct from array['end_time', 'start_time', 'weekday'] then
      raise exception 'every row has exactly weekday, start_time and end_time' using errcode = '22023';
    end if;
    if jsonb_typeof(v_row -> 'weekday') <> 'number' or (v_row ->> 'weekday') !~ '^[0-6]$' then
      raise exception 'weekday is an integer 0–6' using errcode = '22023';
    end if;
    if jsonb_typeof(v_row -> 'start_time') <> 'string'
       or jsonb_typeof(v_row -> 'end_time') <> 'string'
       or (v_row ->> 'start_time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or (v_row ->> 'end_time') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' then
      raise exception 'start_time is HH:MM (00:00–23:59) and end_time HH:MM (00:01–24:00)' using errcode = '22023';
    end if;
    if (v_row ->> 'end_time')::time <= (v_row ->> 'start_time')::time then
      raise exception 'end_time is after start_time' using errcode = '22023';
    end if;
  end loop;

  perform pg_advisory_xact_lock(
    hashtextextended('week_hours:' || p_business_id::text || ':' || p_staff_id::text, 0)
  );

  -- Compared as multisets of (weekday, start, end): a duplicated row is never "the same set"
  -- (stored rows never repeat), so it reaches the insert and fails there with 23P01.
  select coalesce(jsonb_agg(jsonb_build_array(x.weekday, x.start_time, x.end_time)
                            order by x.weekday, x.start_time, x.end_time), '[]'::jsonb)
    into v_new
  from (
    select (e.r ->> 'weekday')::smallint as weekday, (e.r ->> 'start_time')::time as start_time,
           (e.r ->> 'end_time')::time as end_time
    from jsonb_array_elements(p_rows) as e (r)
  ) x;

  select coalesce(jsonb_agg(jsonb_build_array(w.weekday, w.start_time, w.end_time)
                            order by w.weekday, w.start_time, w.end_time), '[]'::jsonb)
    into v_old
  from public.working_hours w
  where w.business_id = p_business_id and w.staff_id = p_staff_id;

  v_changed := v_new is distinct from v_old;

  if v_changed then
    delete from public.working_hours w
    where w.business_id = p_business_id and w.staff_id = p_staff_id;

    -- 23P01 (working_hours_no_overlap) propagates unchanged; the delete above rolls back with it.
    insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
    select p_business_id, p_staff_id, (e.r ->> 'weekday')::smallint, (e.r ->> 'start_time')::time,
           (e.r ->> 'end_time')::time
    from jsonb_array_elements(p_rows) as e (r);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'weekday', w.weekday,
           'start_time', substr(w.start_time::text, 1, 5),
           'end_time', substr(w.end_time::text, 1, 5)
         ) order by w.weekday, w.start_time), '[]'::jsonb)
    into v_rows
  from public.working_hours w
  where w.business_id = p_business_id and w.staff_id = p_staff_id;

  select count(*)::integer into v_conflicts
  from private.schedule_conflicts_core(p_business_id, p_staff_id, now(), now() + interval '8784 hours');

  return jsonb_build_object(
    'staff_id', p_staff_id,
    'changed', v_changed,
    'rows', v_rows,
    'conflict_count', v_conflicts
  );
end;
$$;

create function public.replace_week_hours(p_business_id uuid, p_staff_id uuid, p_rows jsonb)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.replace_week_hours_impl(p_business_id, p_staff_id, p_rows);
$$;

comment on function public.replace_week_hours(uuid, uuid, jsonb) is
  'Settings: replace one staff member''s weekly hours atomically (owner/manager). Returns {staff_id, changed, rows, conflict_count}; overlapping rows → 23P01 and nothing changes.';

-- ---------------------------------------------------------------------------------------------
-- RPC: schedule_conflicts (§2.5.2). Owner/manager. Default range: from now, 366 days (as hours,
-- so the default never depends on the session's TimeZone); longer → AN002.
-- ---------------------------------------------------------------------------------------------
create function private.schedule_conflicts_impl(
  p_business_id uuid,
  p_staff_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  appointment_id uuid, staff_id uuid, starts_at timestamptz, ends_at timestamptz, status text,
  source text, client_id uuid, client_name text, client_phone_e164 text, service_ids uuid[],
  reasons text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_from timestamptz;
  v_to timestamptz;
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if p_staff_id is not null and not exists (
    select 1 from public.staff st where st.business_id = p_business_id and st.id = p_staff_id
  ) then
    raise exception 'staff member not found in this business' using errcode = '42501';
  end if;
  if not private.has_role(p_business_id, array['owner', 'manager']) then
    raise exception 'only the owner or a manager may list schedule conflicts' using errcode = '42501';
  end if;

  v_from := coalesce(p_from, now());
  v_to := coalesce(p_to, v_from + interval '8784 hours');
  if v_to <= v_from then
    raise exception 'p_to must be after p_from' using errcode = '22023';
  end if;
  if v_to - v_from > interval '8784 hours' then
    perform private.raise_domain_error('AN002');
  end if;

  return query
    select c.appointment_id, c.staff_id, c.starts_at, c.ends_at, c.status, c.source, c.client_id,
           c.client_name, c.client_phone_e164, c.service_ids, c.reasons
    from private.schedule_conflicts_core(p_business_id, p_staff_id, v_from, v_to) c;
end;
$$;

create function public.schedule_conflicts(
  p_business_id uuid,
  p_staff_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  appointment_id uuid, staff_id uuid, starts_at timestamptz, ends_at timestamptz, status text,
  source text, client_id uuid, client_name text, client_phone_e164 text, service_ids uuid[],
  reasons text[]
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.schedule_conflicts_impl(p_business_id, p_staff_id, p_from, p_to);
$$;

comment on function public.schedule_conflicts(uuid, uuid, timestamptz, timestamptz) is
  'Settings: booked/confirmed appointments that no longer fit the schedule (closures, time off, hours, inactive staff), with reason codes only. Owner/manager; default range now … 366 days.';

-- ---------------------------------------------------------------------------------------------
-- RPC: mark_absence (§2.5.3). Owner/manager. Records a 'leave' time off for [p_from, p_to)
-- (≤ 31 days), under a lock per staff member: none overlapping → insert; one that covers the
-- window → kept as is (its reason too); otherwise the overlapping rows are merged into the
-- earliest, extended to the union (its reason kept). Never touches appointments; calling it
-- again changes nothing. Returns the conflicts of the requested window.
-- ---------------------------------------------------------------------------------------------
create function private.mark_absence_impl(
  p_business_id uuid,
  p_staff_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_min_start timestamptz;
  v_max_end timestamptz;
  v_time_off public.time_off%rowtype;
  v_created boolean := false;
  v_extended boolean := false;
  v_conflicts jsonb;
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if p_staff_id is null or not exists (
    select 1 from public.staff st where st.business_id = p_business_id and st.id = p_staff_id
  ) then
    raise exception 'staff member not found in this business' using errcode = '42501';
  end if;
  if not private.has_role(p_business_id, array['owner', 'manager']) then
    raise exception 'only the owner or a manager may record an absence' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '31 days' then
    raise exception 'p_from and p_to form a window of at most 31 days' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.staff st where st.business_id = p_business_id and st.id = p_staff_id and st.active
  ) then
    perform private.raise_domain_error('AN008');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('time_off:' || p_business_id::text || ':' || p_staff_id::text, 0)
  );

  -- Disjoint thanks to time_off_no_overlap.
  select array_agg(t.id order by t.starts_at, t.id), min(t.starts_at), max(t.ends_at)
    into v_ids, v_min_start, v_max_end
  from public.time_off t
  where t.business_id = p_business_id and t.staff_id = p_staff_id
    and tstzrange(t.starts_at, t.ends_at, '[)') && tstzrange(p_from, p_to, '[)');

  if v_ids is null then
    insert into public.time_off (business_id, staff_id, starts_at, ends_at, reason)
    values (p_business_id, p_staff_id, p_from, p_to, 'leave')
    returning * into v_time_off;
    v_created := true;
  elsif cardinality(v_ids) = 1 and v_min_start <= p_from and v_max_end >= p_to then
    select * into v_time_off from public.time_off t
    where t.business_id = p_business_id and t.id = v_ids[1];
  else
    -- Delete first: the extended row would otherwise overlap the rows it absorbs.
    delete from public.time_off t
    where t.business_id = p_business_id and t.id = any (v_ids[2:]);
    update public.time_off t
    set starts_at = least(v_min_start, p_from),
        ends_at = greatest(v_max_end, p_to)
    where t.business_id = p_business_id and t.id = v_ids[1]
    returning * into v_time_off;
    v_extended := true;
  end if;

  select coalesce(jsonb_agg(to_jsonb(c) order by c.starts_at, c.appointment_id), '[]'::jsonb)
    into v_conflicts
  from private.schedule_conflicts_core(p_business_id, p_staff_id, p_from, p_to) c;

  return jsonb_build_object(
    'time_off_id', v_time_off.id,
    'staff_id', v_time_off.staff_id,
    'starts_at', v_time_off.starts_at,
    'ends_at', v_time_off.ends_at,
    'reason', v_time_off.reason,
    'created', v_created,
    'extended', v_extended,
    'conflicts', v_conflicts
  );
end;
$$;

create function public.mark_absence(p_business_id uuid, p_staff_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.mark_absence_impl(p_business_id, p_staff_id, p_from, p_to);
$$;

comment on function public.mark_absence(uuid, uuid, timestamptz, timestamptz) is
  'Urgent absence: records (or extends) a ''leave'' time off, idempotently, and returns the appointments of the window that need a change. Returns {time_off_id, staff_id, starts_at, ends_at, reason, created, extended, conflicts}.';

-- ---------------------------------------------------------------------------------------------
-- RPC: reassign_candidates (§2.5.4). Which active colleague could take the appointment at the
-- SAME time: exactly what move_core checks in staff mode (the colleague's own terms, then
-- staff_time_check), so an off-grid start is judged correctly (the slot list only returns grid
-- starts). Owner/manager, or the appointment's own staff member.
--   blocker  not_offered (AN003 from booking_staff_terms) · busy (service overlap) ·
--            off (outside their windows: hours, closure, time off) · tight (buffer overlap)
-- ---------------------------------------------------------------------------------------------
create function private.reassign_candidates_impl(p_business_id uuid, p_appointment_id uuid)
returns table (staff_id uuid, free boolean, blocker text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_appointment public.appointments%rowtype;
  v_service_ids uuid[];
  v_colleague uuid;
  v_terms record;
  v_check record;
  v_blocker text;
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;

  select a.* into v_appointment
  from public.appointments a
  where a.business_id = p_business_id and a.id = p_appointment_id;
  if not found then
    raise exception 'appointment not found in this business' using errcode = '42501';
  end if;

  if not private.has_role(p_business_id, array['owner', 'manager'])
     and v_appointment.staff_id is distinct from private.my_staff_id(p_business_id) then
    raise exception 'not allowed to reassign this appointment' using errcode = '42501';
  end if;
  if v_appointment.status not in ('booked', 'confirmed') then
    perform private.raise_domain_error('AN020');
  end if;

  select array_agg(s.service_id order by s.position) into v_service_ids
  from public.appointment_services s
  where s.business_id = p_business_id and s.appointment_id = v_appointment.id;

  for v_colleague in
    select st.id
    from public.staff st
    where st.business_id = p_business_id and st.active and st.id <> v_appointment.staff_id
    order by st.sort, st.id
  loop
    v_blocker := null;
    begin
      select t.duration_min, t.buffer_after_min into v_terms
      from private.booking_staff_terms(p_business_id, v_service_ids, v_colleague, false) t;
    exception when sqlstate 'P0001' then
      if sqlerrm = 'AN003' then
        v_blocker := 'not_offered';
      else
        raise;
      end if;
    end;

    if v_blocker is null then
      select c.service_overlap, c.buffer_overlap, c.outside_hours into v_check
      from private.staff_time_check(
        p_business_id, v_colleague, v_appointment.starts_at,
        v_appointment.starts_at + make_interval(mins => v_terms.duration_min),
        v_terms.buffer_after_min, v_appointment.id
      ) c;
      v_blocker := case
        when v_check.service_overlap then 'busy'
        when v_check.outside_hours then 'off'
        when v_check.buffer_overlap then 'tight'
      end;
    end if;

    staff_id := v_colleague;
    free := v_blocker is null;
    blocker := v_blocker;
    return next;
  end loop;
end;
$$;

create function public.reassign_candidates(p_business_id uuid, p_appointment_id uuid)
returns table (staff_id uuid, free boolean, blocker text)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.reassign_candidates_impl(p_business_id, p_appointment_id);
$$;

comment on function public.reassign_candidates(uuid, uuid) is
  'Absence flow: every active colleague, free or with a blocker (not_offered, busy, off, tight), for the appointment at its current time.';

-- ---------------------------------------------------------------------------------------------
-- RPC: reassign_appointment (review fix of 1.6). The resolver's «Ανάθεση: …»: the appointment
-- goes to p_new_staff_id at the SAME time, but only if it is still where the caller saw it
-- (p_expected_staff_id, p_expected_starts_at); otherwise AN021 and nothing changes. Without the
-- expectation a stale conflict row would move an appointment that was rescheduled elsewhere back
-- to its old time (staff_move_appointment takes the new start as given).
-- The move itself is staff_move_appointment_impl with p_new_starts_at = p_expected_starts_at and
-- both flags false (same idempotency keys, same stored answers, same SMS rules). A key that
-- already has a stored answer skips the expectation, so the retry of a reassignment that committed
-- replays its answer (by then the appointment is the colleague's). Owner/manager, or the
-- appointment's own staff member (as staff_move_appointment). Row lock first, then the check: a
-- concurrent move waits for it (move_core takes the same lock).
-- ---------------------------------------------------------------------------------------------
create function private.reassign_appointment_impl(
  p_business_id uuid,
  p_appointment_id uuid,
  p_idempotency_key uuid,
  p_expected_staff_id uuid,
  p_expected_starts_at timestamptz,
  p_new_staff_id uuid,
  p_notify boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_appointment public.appointments%rowtype;
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if p_appointment_id is null or not exists (
    select 1 from public.appointments a
    where a.business_id = p_business_id and a.id = p_appointment_id
  ) then
    raise exception 'appointment not found in this business' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_expected_staff_id is null or p_expected_starts_at is null
     or p_new_staff_id is null or p_notify is null then
    raise exception 'p_idempotency_key, p_expected_staff_id, p_expected_starts_at, p_new_staff_id and p_notify are required'
      using errcode = '22023';
  end if;

  -- The lock staff_move_appointment_impl takes for the key (re-entrant).
  perform pg_advisory_xact_lock(
    hashtextextended('staff_move:' || p_business_id::text || ':' || p_idempotency_key::text, 0)
  );

  if not exists (
    select 1 from private.move_requests r
    where r.business_id = p_business_id and r.idempotency_key = p_idempotency_key
  ) then
    select a.* into v_appointment
    from public.appointments a
    where a.business_id = p_business_id and a.id = p_appointment_id
    for no key update;

    if not private.has_role(p_business_id, array['owner', 'manager'])
       and v_appointment.staff_id is distinct from private.my_staff_id(p_business_id) then
      raise exception 'not allowed to move this appointment' using errcode = '42501';
    end if;
    -- A status that cannot move is staff_move_appointment_impl's AN020.
    if v_appointment.status in ('booked', 'confirmed')
       and (v_appointment.staff_id <> p_expected_staff_id
            or v_appointment.starts_at <> p_expected_starts_at) then
      perform private.raise_domain_error('AN021');
    end if;
  end if;

  return private.staff_move_appointment_impl(
    p_business_id, p_appointment_id, p_idempotency_key, p_expected_starts_at, p_notify, p_new_staff_id,
    false, false
  );
end;
$$;

create function public.reassign_appointment(
  p_business_id uuid,
  p_appointment_id uuid,
  p_idempotency_key uuid,
  p_expected_staff_id uuid,
  p_expected_starts_at timestamptz,
  p_new_staff_id uuid,
  p_notify boolean
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.reassign_appointment_impl(
    p_business_id, p_appointment_id, p_idempotency_key, p_expected_staff_id, p_expected_starts_at,
    p_new_staff_id, p_notify
  );
$$;

comment on function public.reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, uuid, boolean) is
  'Absence flow: hand the appointment to a colleague at the same time, only if it is still with p_expected_staff_id at p_expected_starts_at (else AN021). Returns the staff_move_appointment answer.';

-- ---------------------------------------------------------------------------------------------
-- RPC: save_service (§2.5.5). Owner/manager. The service row AND its complete staff list (custom
-- duration/price, null = the service default) in one call, idempotent by content: a lost answer
-- never leaves half a service, a replay changes nothing (created false). A new service goes last
-- (sort = max + 1, only on insert). Range violations surface as the table CHECKs (23514);
-- integers beyond the column type are a shape error (22023). Existing appointments keep their
-- copied price/duration (SPEC §7).
-- ---------------------------------------------------------------------------------------------
create function private.save_service_impl(
  p_business_id uuid,
  p_service_id uuid,
  p_service jsonb,
  p_offers jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_category uuid;
  v_name text;
  v_duration integer;
  v_buffer integer;
  v_price bigint;
  v_online boolean;
  v_active boolean;
  v_offer jsonb;
  v_offer_staff uuid;
  v_staff_ids uuid[] := '{}';
  v_service public.services%rowtype;
  v_created boolean := false;
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if p_service_id is not null and exists (
    select 1 from public.services s where s.id = p_service_id and s.business_id <> p_business_id
  ) then
    raise exception 'service not found in this business' using errcode = '42501';
  end if;
  if not private.has_role(p_business_id, array['owner', 'manager']) then
    raise exception 'only the owner or a manager may change the catalogue' using errcode = '42501';
  end if;
  if p_service_id is null then
    raise exception 'p_service_id is required (generated by the client)' using errcode = '22023';
  end if;

  -- p_service
  if p_service is null or jsonb_typeof(p_service) <> 'object' then
    raise exception 'p_service is an object' using errcode = '22023';
  end if;
  if (select array_agg(k.key order by k.key) from jsonb_object_keys(p_service) as k (key))
     is distinct from array['active', 'buffer_after_min', 'category_id', 'duration_min', 'name',
                            'online_bookable', 'price_cents'] then
    raise exception 'p_service has exactly name, category_id, duration_min, buffer_after_min, price_cents, online_bookable, active'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_service -> 'name') <> 'string' then
    raise exception 'name is a string' using errcode = '22023';
  end if;
  if jsonb_typeof(p_service -> 'category_id') = 'null' then
    v_category := null;
  elsif jsonb_typeof(p_service -> 'category_id') = 'string' and (p_service ->> 'category_id') ~ c_uuid then
    v_category := (p_service ->> 'category_id')::uuid;
  else
    raise exception 'category_id is a uuid or null' using errcode = '22023';
  end if;
  if jsonb_typeof(p_service -> 'duration_min') <> 'number'
     or jsonb_typeof(p_service -> 'buffer_after_min') <> 'number'
     or jsonb_typeof(p_service -> 'price_cents') <> 'number'
     or (p_service ->> 'duration_min') !~ '^-?[0-9]{1,5}$'
     or (p_service ->> 'buffer_after_min') !~ '^-?[0-9]{1,5}$'
     or (p_service ->> 'price_cents') !~ '^-?[0-9]{1,10}$' then
    raise exception 'duration_min, buffer_after_min and price_cents are integers' using errcode = '22023';
  end if;
  v_duration := (p_service ->> 'duration_min')::integer;
  v_buffer := (p_service ->> 'buffer_after_min')::integer;
  v_price := (p_service ->> 'price_cents')::bigint;
  if v_duration not between -32768 and 32767 or v_buffer not between -32768 and 32767
     or v_price not between -2147483648 and 2147483647 then
    raise exception 'an integer is out of range for its column' using errcode = '22023';
  end if;
  if jsonb_typeof(p_service -> 'online_bookable') <> 'boolean'
     or jsonb_typeof(p_service -> 'active') <> 'boolean' then
    raise exception 'online_bookable and active are booleans' using errcode = '22023';
  end if;
  v_name := btrim(p_service ->> 'name');
  v_online := (p_service -> 'online_bookable')::boolean;
  v_active := (p_service -> 'active')::boolean;

  -- p_offers
  if p_offers is null or jsonb_typeof(p_offers) <> 'array' or jsonb_array_length(p_offers) > 50 then
    raise exception 'p_offers is an array of at most 50 offers' using errcode = '22023';
  end if;
  for v_offer in select e.o from jsonb_array_elements(p_offers) as e (o) loop
    if jsonb_typeof(v_offer) <> 'object' then
      raise exception 'every offer is an object' using errcode = '22023';
    end if;
    if (select array_agg(k.key order by k.key) from jsonb_object_keys(v_offer) as k (key))
       is distinct from array['custom_duration_min', 'custom_price_cents', 'staff_id'] then
      raise exception 'every offer has exactly staff_id, custom_duration_min, custom_price_cents' using errcode = '22023';
    end if;
    if jsonb_typeof(v_offer -> 'staff_id') <> 'string' or (v_offer ->> 'staff_id') !~ c_uuid then
      raise exception 'staff_id is a uuid' using errcode = '22023';
    end if;
    if not (jsonb_typeof(v_offer -> 'custom_duration_min') = 'null'
            or (jsonb_typeof(v_offer -> 'custom_duration_min') = 'number'
                and (v_offer ->> 'custom_duration_min') ~ '^-?[0-9]{1,5}$'
                and (v_offer ->> 'custom_duration_min')::integer between -32768 and 32767)) then
      raise exception 'custom_duration_min is an integer or null' using errcode = '22023';
    end if;
    if not (jsonb_typeof(v_offer -> 'custom_price_cents') = 'null'
            or (jsonb_typeof(v_offer -> 'custom_price_cents') = 'number'
                and (v_offer ->> 'custom_price_cents') ~ '^-?[0-9]{1,10}$'
                and (v_offer ->> 'custom_price_cents')::bigint between -2147483648 and 2147483647)) then
      raise exception 'custom_price_cents is an integer or null' using errcode = '22023';
    end if;
    v_offer_staff := (v_offer ->> 'staff_id')::uuid;
    if v_offer_staff = any (v_staff_ids) then
      raise exception 'a staff member appears twice in p_offers' using errcode = '22023';
    end if;
    v_staff_ids := v_staff_ids || v_offer_staff;
  end loop;

  -- ids inside the payload
  if v_category is not null and not exists (
    select 1 from public.service_categories c where c.business_id = p_business_id and c.id = v_category
  ) then
    raise exception 'category not found in this business' using errcode = '42501';
  end if;
  if exists (
    select 1 from unnest(v_staff_ids) as u (id)
    where not exists (select 1 from public.staff st where st.business_id = p_business_id and st.id = u.id)
  ) then
    raise exception 'staff member not found in this business' using errcode = '42501';
  end if;

  -- One writer of the business's catalogue at a time: sort = max + 1 is then exact, and two
  -- attempts of the same new service never both insert.
  perform pg_advisory_xact_lock(hashtextextended('services:' || p_business_id::text, 0));

  select * into v_service
  from public.services s
  where s.business_id = p_business_id and s.id = p_service_id
  for no key update;

  if not found then
    insert into public.services (
      id, business_id, category_id, name, duration_min, buffer_after_min, price_cents, active,
      online_bookable, sort
    )
    values (
      p_service_id, p_business_id, v_category, v_name, v_duration, v_buffer, v_price, v_active,
      v_online,
      (select coalesce(max(s.sort) + 1, 0) from public.services s where s.business_id = p_business_id)
    )
    returning * into v_service;
    v_created := true;
  else
    update public.services s
    set name = v_name,
        category_id = v_category,
        duration_min = v_duration,
        buffer_after_min = v_buffer,
        price_cents = v_price,
        online_bookable = v_online,
        active = v_active
    where s.business_id = p_business_id and s.id = p_service_id
      and (s.name, s.category_id, s.duration_min, s.buffer_after_min, s.price_cents, s.online_bookable, s.active)
          is distinct from (v_name, v_category, v_duration::smallint, v_buffer::smallint, v_price::integer, v_online, v_active);

    select * into v_service
    from public.services s
    where s.business_id = p_business_id and s.id = p_service_id;
  end if;

  delete from public.staff_services ss
  where ss.business_id = p_business_id and ss.service_id = p_service_id
    and ss.staff_id <> all (v_staff_ids);

  insert into public.staff_services as ss (business_id, staff_id, service_id, custom_duration_min, custom_price_cents)
  select p_business_id, (e.o ->> 'staff_id')::uuid, p_service_id,
         (e.o ->> 'custom_duration_min')::integer, (e.o ->> 'custom_price_cents')::bigint
  from jsonb_array_elements(p_offers) as e (o)
  on conflict (business_id, staff_id, service_id) do update
    set custom_duration_min = excluded.custom_duration_min,
        custom_price_cents = excluded.custom_price_cents
    where (ss.custom_duration_min, ss.custom_price_cents)
          is distinct from (excluded.custom_duration_min, excluded.custom_price_cents);

  return jsonb_build_object(
    'id', v_service.id,
    'created', v_created,
    'name', v_service.name,
    'category_id', v_service.category_id,
    'duration_min', v_service.duration_min,
    'buffer_after_min', v_service.buffer_after_min,
    'price_cents', v_service.price_cents,
    'online_bookable', v_service.online_bookable,
    'active', v_service.active,
    'sort', v_service.sort,
    'offers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'staff_id', ss.staff_id,
               'custom_duration_min', ss.custom_duration_min,
               'custom_price_cents', ss.custom_price_cents
             ) order by st.sort, st.id)
      from public.staff_services ss
      join public.staff st on st.business_id = ss.business_id and st.id = ss.staff_id
      where ss.business_id = p_business_id and ss.service_id = v_service.id
    ), '[]'::jsonb)
  );
end;
$$;

create function public.save_service(p_business_id uuid, p_service_id uuid, p_service jsonb, p_offers jsonb)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.save_service_impl(p_business_id, p_service_id, p_service, p_offers);
$$;

comment on function public.save_service(uuid, uuid, jsonb, jsonb) is
  'Settings: create or update a service and its complete staff list in one idempotent call (owner/manager). Returns the service with created and offers.';

-- ---------------------------------------------------------------------------------------------
-- RPC: set_staff_order (§2.5.6). Owner/manager. p_staff_ids = exactly every staff member of the
-- business (active and inactive), in the new order; sort = position − 1. Same list again → same
-- result.
-- ---------------------------------------------------------------------------------------------
create function private.set_staff_order_impl(p_business_id uuid, p_staff_ids uuid[])
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
  if exists (
    select 1 from unnest(p_staff_ids) as u (id)
    where u.id is not null
      and not exists (select 1 from public.staff st where st.business_id = p_business_id and st.id = u.id)
  ) then
    raise exception 'staff member not found in this business' using errcode = '42501';
  end if;
  if not private.has_role(p_business_id, array['owner', 'manager']) then
    raise exception 'only the owner or a manager may reorder the staff' using errcode = '42501';
  end if;
  if p_staff_ids is null
     or array_position(p_staff_ids, null) is not null
     or (select count(distinct u.id) from unnest(p_staff_ids) as u (id)) <> cardinality(p_staff_ids)
     or (select array_agg(st.id order by st.id) from public.staff st where st.business_id = p_business_id)
        is distinct from (select array_agg(u.id order by u.id) from unnest(p_staff_ids) as u (id)) then
    raise exception 'p_staff_ids lists every staff member of the business exactly once' using errcode = '22023';
  end if;

  perform 1
  from public.staff st
  where st.business_id = p_business_id
  order by st.id
  for no key update;

  update public.staff st
  set sort = (u.ord - 1)::smallint
  from unnest(p_staff_ids) with ordinality as u (id, ord)
  where st.business_id = p_business_id and st.id = u.id and st.sort <> u.ord - 1;

  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.id, 'sort', u.ord - 1) order by u.ord)
    from unnest(p_staff_ids) with ordinality as u (id, ord)
  ), '[]'::jsonb);
end;
$$;

create function public.set_staff_order(p_business_id uuid, p_staff_ids uuid[])
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.set_staff_order_impl(p_business_id, p_staff_ids);
$$;

comment on function public.set_staff_order(uuid, uuid[]) is
  'Settings: the new order of every staff member of the business (owner/manager). Returns [{id, sort}] in that order.';

-- ---------------------------------------------------------------------------------------------
-- Re-plan of queued reminders (§2.6, D6; closes 1.5 D8). A change of quiet_start, quiet_end or
-- reminder_mode re-plans the business's queued, not-yet-due, never-attempted reminders with the
-- same private.reminder_at, planning instant = the row's created_at. A reminder whose new time is
-- null or already past is cancelled 'superseded' (never sent late). Due rows, retries, sent or
-- cancelled rows and other businesses are never touched. Without it a new quiet window would
-- silently expire already-queued reminders at claim. Returns the number of rows changed.
-- 1.7: change_business_identity (timezone) must call it after changing the zone. No grants.
-- ---------------------------------------------------------------------------------------------
create function private.replan_reminders_impl(p_business_id uuid, p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_now is null then
    raise exception 'p_now is required' using errcode = '22023';
  end if;

  with planned as (
    select m.id,
           private.reminder_at(a.starts_at, b.timezone, b.reminder_mode, b.quiet_start, b.quiet_end, m.created_at) as at
    from public.messages_log m
    join public.appointments a on a.business_id = m.business_id and a.id = m.appointment_id
    join public.businesses b on b.id = m.business_id
    where m.business_id = p_business_id
      and m.template = 'reminder'
      and m.status = 'queued'
      and m.attempts = 0
      and m.scheduled_for > p_now
      and a.status in ('booked', 'confirmed')
      and a.starts_at > p_now
  )
  update public.messages_log m
  set status = case when p.at is null or p.at <= p_now then 'cancelled' else m.status end,
      error = case when p.at is null or p.at <= p_now then 'superseded' else m.error end,
      scheduled_for = case when p.at is null or p.at <= p_now then m.scheduled_for else p.at end,
      updated_at = p_now
  from planned p
  where m.id = p.id
    -- re-checked on the row a concurrent claim may have changed meanwhile
    and m.status = 'queued'
    and m.attempts = 0
    and m.scheduled_for > p_now
    and (p.at is null or p.at <= p_now or p.at <> m.scheduled_for);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Definer: the owner updating the policy holds no privilege on messages_log.
create function private.businesses_replan_reminders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.replan_reminders_impl(new.id, now());
  return null;
end;
$$;

create trigger businesses_replan_reminders
  after update of quiet_start, quiet_end, reminder_mode on public.businesses
  for each row
  when ((old.quiet_start, old.quiet_end, old.reminder_mode)
        is distinct from (new.quiet_start, new.quiet_end, new.reminder_mode))
  execute function private.businesses_replan_reminders();

-- ---------------------------------------------------------------------------------------------
-- Grants: signed-in members only (membership and role checks run inside each _impl).
-- staff_day_opening, staff_day_windows, schedule_conflicts_core, replan_reminders_impl and the
-- trigger function: nobody.
-- ---------------------------------------------------------------------------------------------
grant execute on function private.replace_week_hours_impl(uuid, uuid, jsonb) to authenticated;
grant execute on function public.replace_week_hours(uuid, uuid, jsonb) to authenticated;
grant execute on function private.schedule_conflicts_impl(uuid, uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.schedule_conflicts(uuid, uuid, timestamptz, timestamptz) to authenticated;
grant execute on function private.mark_absence_impl(uuid, uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.mark_absence(uuid, uuid, timestamptz, timestamptz) to authenticated;
grant execute on function private.reassign_candidates_impl(uuid, uuid) to authenticated;
grant execute on function public.reassign_candidates(uuid, uuid) to authenticated;
grant execute on function private.reassign_appointment_impl(uuid, uuid, uuid, uuid, timestamptz, uuid, boolean) to authenticated;
grant execute on function public.reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, uuid, boolean) to authenticated;
grant execute on function private.save_service_impl(uuid, uuid, jsonb, jsonb) to authenticated;
grant execute on function public.save_service(uuid, uuid, jsonb, jsonb) to authenticated;
grant execute on function private.set_staff_order_impl(uuid, uuid[]) to authenticated;
grant execute on function public.set_staff_order(uuid, uuid[]) to authenticated;
