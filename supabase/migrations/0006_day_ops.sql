-- 0006_day_ops.sql
-- Day operations of the pro app (SPEC §5 flow 3, §7, §8; Phase 1 plan step 1.4).
-- Contract: docs/plans/contracts/1.4-day-ops.md (§2 is this file).
--
--   appointments_active_ends_idx     the auto-complete scan
--   private.job_runs                 heartbeat of every cron job (append-only, one row per run)
--   private.move_requests            idempotency of staff_move_appointment
--   private.record_job_run           the only writer of job_runs
--   private.plan_messages_impl       planner v1.1: v1 + p_change 'status_changed' (no effect yet)
--   private.auto_complete_impl       booked/confirmed → completed after auto_complete_after_min;
--                                    pg_cron job 'auto-complete' every 10′, as the system
--
-- API (authenticated only; thin SECURITY INVOKER wrappers in public, SECURITY DEFINER _impl in
-- private; membership first, then every entity id of the business, then the operation's rules):
--   busy_calendar, today_summary, set_appointment_status, cancel_appointment,
--   staff_move_appointment, search_clients
-- None declares an actor: the events say 'staff' with the caller's id. Owner/manager act on every
-- appointment of the business; any other member only on the appointments of their own staff row.
--
-- The staff's wish to notify the client is handed to the planner as the transaction-local
-- setting anaklo.notify_client ('true' | 'false'), set explicitly right before every planner call
-- of these paths. Planner v1 does not read it; 1.5 (v2) does.

-- ---------------------------------------------------------------------------------------------
-- Domain errors: AN021–AN023 join the list. The same list lives in
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

-- The auto-complete scan: active appointments by end.
create index appointments_active_ends_idx on public.appointments (ends_at)
  where status in ('booked', 'confirmed');

-- One row per run of a cron job, failures included (1.9 health reads the latest per job).
-- `error` is a SQLSTATE or a code, never personal data. The 1.5 nightly purge deletes rows older
-- than 30 days.
create table private.job_runs (
  id bigint generated always as identity primary key,
  job text not null constraint job_runs_job check (job in ('auto_complete')),
  started_at timestamptz not null,
  finished_at timestamptz not null default clock_timestamp(),
  ok boolean not null,
  rows_affected integer constraint job_runs_rows_affected check (rows_affected >= 0),
  error text constraint job_runs_error_length check (char_length(error) <= 200),
  constraint job_runs_ok_error check (ok = (error is null))
);

create index job_runs_job_finished_idx on private.job_runs (job, finished_at desc);

comment on table private.job_runs is
  'Heartbeat of every cron job: one row per run, failures included. Written by private.record_job_run only.';

-- The answer of every staff move, by idempotency key: a retry of the same attempt replays it
-- instead of moving again (re-applying an old move could undo a newer one). The 1.5 nightly purge
-- deletes rows older than 30 days.
create table private.move_requests (
  business_id uuid not null references public.businesses (id) on delete restrict,
  idempotency_key uuid not null,
  appointment_id uuid not null,
  request_hash text not null constraint move_requests_request_hash check (request_hash ~ '^[0-9a-f]{64}$'),
  result jsonb not null constraint move_requests_result_object check (jsonb_typeof(result) = 'object'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (business_id, idempotency_key),
  constraint move_requests_appointment_fk foreign key (business_id, appointment_id)
    references public.appointments (business_id, id) on delete restrict
);

create index move_requests_created_idx on private.move_requests (created_at);

comment on table private.move_requests is
  'Idempotency of staff_move_appointment: request hash and stored answer per (business, key).';

-- RLS on, no policies, no grants: only definer code reaches them.
alter table private.job_runs enable row level security;
alter table private.move_requests enable row level security;
revoke all on table private.job_runs from public, anon, authenticated, service_role;
revoke all on table private.move_requests from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Helpers (no grants)
-- ---------------------------------------------------------------------------------------------

-- The only writer of job_runs. Invoker: the jobs call it from their definer _impl.
create function private.record_job_run(
  p_job text,
  p_started_at timestamptz,
  p_ok boolean,
  p_rows integer default null,
  p_error text default null
)
returns bigint
language sql
volatile
set search_path = ''
as $$
  insert into private.job_runs (job, started_at, ok, rows_affected, error)
  values (p_job, p_started_at, p_ok, p_rows, left(p_error, 200))
  returning id;
$$;

-- true iff p_after (queued_sms_ids after a planner call) holds an id that p_before lacks.
create function private.sms_newly_queued(p_before jsonb, p_after jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (
    select 1 from jsonb_array_elements_text(coalesce(p_after, '[]'::jsonb)) as x (id)
    where not (coalesce(p_before, '[]'::jsonb) ? x.id)
  );
$$;

-- The three greeklish spellings (0002) of already-normalised, single-spaced text, each for the
-- WHOLE text. greeklish() maps every word to exactly one word, so its output is the three
-- spellings one after the other, each as many words long as the input.
create function private.greeklish_variants(p_normalized text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  with w as (
    select string_to_array(private.greeklish(p_normalized), ' ') as words,
           cardinality(string_to_array(p_normalized, ' ')) as n
  )
  select array[
    array_to_string(w.words[1 : w.n], ' '),
    array_to_string(w.words[w.n + 1 : 2 * w.n], ' '),
    array_to_string(w.words[2 * w.n + 1 : 3 * w.n], ' ')
  ]
  from w;
$$;

-- One item of today_summary's lists: ids, times, status and the client's name (null for a
-- walk-in without client or an erased client). No prices.
create function private.day_summary_item(p_business_id uuid, p_appointment_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'appointment_id', a.id,
    'staff_id', a.staff_id,
    'starts_at', a.starts_at,
    'ends_at', a.ends_at,
    'status', a.status,
    'client_id', a.client_id,
    'client_name', case when c.erased_at is null then nullif(c.full_name, '') end,
    'service_ids', coalesce((
      select jsonb_agg(s.service_id order by s.position)
      from public.appointment_services s
      where s.business_id = a.business_id and s.appointment_id = a.id
    ), '[]'::jsonb)
  )
  from public.appointments a
  left join public.clients c on c.business_id = a.business_id and c.id = a.client_id
  where a.business_id = p_business_id and a.id = p_appointment_id;
$$;

-- ---------------------------------------------------------------------------------------------
-- private.plan_messages_impl, body v1.1 (signature unchanged since 0004): v1 of 0005 plus the
-- accepted value 'status_changed', which has no effect yet. v1 does not read
-- anaklo.notify_client: a staff actor queues nothing for 'moved'/'cancelled'.
-- 1.5 (v2): read the setting only for actor staff and p_change in ('moved', 'cancelled')
-- (missing/empty = false); 'status_changed' to a non-active status cancels the appointment's
-- queued reminders/confirmations.
--   created   + source online              → booking_confirmed (always, ADR-0006 §5)
--   cancelled + actor client               → queued SMS of the appointment cancelled ('superseded')
--                                            + cancelled_by_client
--   moved     + actor client               → the same cancelling + rescheduled_by_client, one per
--                                            move (dedupe on the 'rescheduled' event)
--   status_changed                         → nothing (1.5)
--   anything else                          → nothing (staff rules, reminders, push: 1.5a)
-- Skips an appointment without a client, a client without a phone, an erased client. The actor
-- is read raw (current_actor_type() may raise). Direct inserts of seed.sql never call it.
-- ---------------------------------------------------------------------------------------------
create or replace function private.plan_messages_impl(p_appointment_id uuid, p_change text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_actor text := nullif(current_setting('anaklo.actor_type', true), '');
  v_row record;
  v_event_id bigint;
  v_template text;
  v_dedupe_key text;
begin
  if p_change is null or p_change not in ('created', 'moved', 'cancelled', 'status_changed') then
    raise exception 'p_change must be created, moved, cancelled or status_changed' using errcode = '22023';
  end if;

  if p_change = 'status_changed' then
    return;
  end if;

  select a.id, a.business_id, a.source, a.client_id, c.phone_e164, c.locale, c.erased_at
    into v_row
  from public.appointments a
  left join public.clients c on c.business_id = a.business_id and c.id = a.client_id
  where a.id = p_appointment_id;
  if not found or v_row.client_id is null or v_row.phone_e164 is null or v_row.erased_at is not null then
    return;
  end if;

  if p_change = 'created' then
    if v_row.source <> 'online' then
      return;
    end if;
    v_template := 'booking_confirmed';
    v_dedupe_key := 'appt:' || v_row.id::text || ':booking_confirmed';
  elsif v_actor is distinct from 'client' then
    return;
  elsif p_change = 'cancelled' then
    v_template := 'cancelled_by_client';
    v_dedupe_key := 'appt:' || v_row.id::text || ':cancelled_by_client';
  else
    select max(e.id) into v_event_id
    from public.appointment_events e
    where e.business_id = v_row.business_id and e.appointment_id = v_row.id and e.event = 'rescheduled';
    if v_event_id is null then
      return;
    end if;
    v_template := 'rescheduled_by_client';
    v_dedupe_key := 'appt:' || v_row.id::text || ':rescheduled_by_client:' || v_event_id::text;
  end if;

  if p_change in ('cancelled', 'moved') then
    update public.messages_log m
    set status = 'cancelled', error = 'superseded', updated_at = now()
    where m.business_id = v_row.business_id
      and m.appointment_id = v_row.id
      and m.channel = 'sms'
      and m.status = 'queued';
  end if;

  insert into public.messages_log (
    business_id, client_id, appointment_id, dedupe_key, channel, to_e164, locale, template,
    category, scheduled_for
  )
  values (
    v_row.business_id, v_row.client_id, v_row.id, v_dedupe_key, 'sms', v_row.phone_e164, v_row.locale,
    v_template, 'transactional', now()
  )
  on conflict (dedupe_key) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC: busy_calendar (§2.6.2). The frame of one local day, in one round trip:
--   windows: when every ACTIVE staff member works that day (staff_day_windows: exceptions and
--            time off applied in SQL, rule 13; staff cannot read colleagues' time_off);
--   blocks:  the complement of RLS, i.e. the appointments the caller cannot read directly
--            (owner/manager: none; anyone else: every non-cancelled appointment not of their own
--            staff row), with EXACTLY five keys: no client, price, status or source.
-- ---------------------------------------------------------------------------------------------
create function private.busy_calendar_impl(p_business_id uuid, p_local_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_manager boolean;
  v_my_staff uuid;
  v_day_start timestamptz;
  v_day_end timestamptz;
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if p_local_date is null then
    raise exception 'p_local_date is required' using errcode = '22023';
  end if;

  select b.timezone into v_tz from public.businesses b where b.id = p_business_id;
  v_manager := private.has_role(p_business_id, array['owner', 'manager']);
  v_my_staff := private.my_staff_id(p_business_id);
  -- 23 h or 25 h on DST days
  v_day_start := p_local_date::timestamp at time zone v_tz;
  v_day_end := (p_local_date + 1)::timestamp at time zone v_tz;

  return jsonb_build_object(
    'local_date', to_char(p_local_date, 'YYYY-MM-DD'),
    'timezone', v_tz,
    'day_start', v_day_start,
    'day_end', v_day_end,
    'windows', coalesce((
      select jsonb_agg(
               jsonb_build_object('staff_id', st.id, 'starts_at', w.starts_at, 'ends_at', w.ends_at)
               order by st.sort, st.id, w.starts_at
             )
      from public.staff st
      cross join lateral private.staff_day_windows(p_business_id, st.id, p_local_date) w
      where st.business_id = p_business_id and st.active
    ), '[]'::jsonb),
    'blocks', case when v_manager then '[]'::jsonb else coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'appointment_id', a.id,
                 'staff_id', a.staff_id,
                 'starts_at', a.starts_at,
                 'ends_at', a.ends_at,
                 'buffer_after_min', a.buffer_after_min
               )
               order by a.staff_id, a.starts_at, a.id
             )
      from public.appointments a
      where a.business_id = p_business_id
        and a.status in ('booked', 'confirmed', 'completed', 'no_show')
        and a.staff_id is distinct from v_my_staff
        and a.starts_at < v_day_end
        -- sargable lower bound: an appointment lasts ≤ 12 h and its buffer ≤ 120 min
        and a.starts_at > v_day_start - interval '15 hours'
        and a.ends_at + make_interval(mins => a.buffer_after_min) > v_day_start
    ), '[]'::jsonb) end
  );
end;
$$;

create function public.busy_calendar(p_business_id uuid, p_local_date date)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.busy_calendar_impl(p_business_id, p_local_date);
$$;

comment on function public.busy_calendar(uuid, date) is
  'Pro app day frame: {local_date, timezone, day_start, day_end, windows, blocks}. Blocks = appointments the caller cannot read (none for owner/manager), without client, price or status.';

-- ---------------------------------------------------------------------------------------------
-- RPC: today_summary (§2.6.3). "Today" = the local date of p_now in businesses.timezone.
-- Scope: owner/manager the whole business, anyone else their own staff row (none → nothing).
-- expected_revenue_cents is decided HERE by role (owner/manager: the amount of the whole
-- business; anyone else: JSON null), never in the wrapper.
-- Gaps, per active staff member in scope: free = working windows of today − booked/confirmed
-- blocks (with buffer), from the first grid instant ≥ p_now to the end of the day; a maximal free
-- interval counts when it fits the shortest active service the staff member offers.
-- ---------------------------------------------------------------------------------------------
create function private.today_summary_impl(p_business_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_currency text;
  v_step integer;
  v_manager boolean;
  v_my_staff uuid;
  v_today date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_from timestamptz;
  v_total bigint;
  v_remaining bigint;
  v_to_mark_count bigint;
  v_revenue bigint;
  v_next jsonb;
  v_gaps jsonb;
  v_to_mark jsonb;
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if p_now is null then
    raise exception 'p_now is required' using errcode = '22023';
  end if;

  select b.timezone, b.currency, b.slot_step_min
    into v_tz, v_currency, v_step
  from public.businesses b
  where b.id = p_business_id;

  v_manager := private.has_role(p_business_id, array['owner', 'manager']);
  v_my_staff := private.my_staff_id(p_business_id);
  v_today := (p_now at time zone v_tz)::date;
  v_day_start := v_today::timestamp at time zone v_tz;
  v_day_end := (v_today + 1)::timestamp at time zone v_tz;

  -- The first instant ≥ p_now whose LOCAL minute-of-day is a multiple of slot_step_min (≤ 60,
  -- so one of the next 61 whole minutes is on the grid; correct on DST days and odd offsets).
  select min(g.instant) into v_from
  from generate_series(0, 60) as k (n)
  cross join lateral (select date_trunc('minute', p_now) + make_interval(mins => k.n) as instant) g
  where g.instant >= p_now
    and (extract(hour from g.instant at time zone v_tz) * 60
         + extract(minute from g.instant at time zone v_tz))::integer % v_step = 0;

  -- Today (starts inside the local day), in scope.
  select count(*) filter (where a.status <> 'cancelled'),
         count(*) filter (where a.status in ('booked', 'confirmed') and a.ends_at > p_now)
    into v_total, v_remaining
  from public.appointments a
  where a.business_id = p_business_id
    and (v_manager or a.staff_id = v_my_staff)
    and a.starts_at >= v_day_start and a.starts_at < v_day_end;

  -- Still open after their end, any date, in scope (all of them).
  select count(*) into v_to_mark_count
  from public.appointments a
  where a.business_id = p_business_id
    and (v_manager or a.staff_id = v_my_staff)
    and a.status in ('booked', 'confirmed')
    and a.ends_at <= p_now;

  if v_manager then
    select coalesce(sum(case when a.status = 'completed' then coalesce(a.charged_cents, a.total_cents)
                             else a.total_cents end), 0)
      into v_revenue
    from public.appointments a
    where a.business_id = p_business_id
      and a.status in ('booked', 'confirmed', 'completed')
      and a.starts_at >= v_day_start and a.starts_at < v_day_end;
  end if;

  select coalesce(jsonb_agg(private.day_summary_item(p_business_id, x.id) order by x.starts_at, x.id), '[]'::jsonb)
    into v_next
  from (
    select a.id, a.starts_at
    from public.appointments a
    where a.business_id = p_business_id
      and (v_manager or a.staff_id = v_my_staff)
      and a.status in ('booked', 'confirmed')
      and a.starts_at >= v_day_start and a.starts_at < v_day_end
      and a.ends_at > p_now
    order by a.starts_at, a.id
    limit 5
  ) x;

  select coalesce(jsonb_agg(private.day_summary_item(p_business_id, x.id) order by x.ends_at desc, x.id), '[]'::jsonb)
    into v_to_mark
  from (
    select a.id, a.ends_at
    from public.appointments a
    where a.business_id = p_business_id
      and (v_manager or a.staff_id = v_my_staff)
      and a.status in ('booked', 'confirmed')
      and a.ends_at <= p_now
    order by a.ends_at desc, a.id
    limit 20
  ) x;

  with scoped_staff as (
    select st.id, st.sort,
           (select min(coalesce(ss.custom_duration_min, sv.duration_min))
            from public.staff_services ss
            join public.services sv on sv.business_id = ss.business_id and sv.id = ss.service_id
            where ss.business_id = p_business_id and ss.staff_id = st.id and sv.active) as min_len
    from public.staff st
    where st.business_id = p_business_id
      and st.active
      and (v_manager or st.id = v_my_staff)
  ),
  free as (
    select s.id, s.sort, s.min_len,
           (w.mr - coalesce(busy.mr, '{}'::tstzmultirange))
             * tstzmultirange(tstzrange(least(v_from, v_day_end), v_day_end, '[)')) as mr
    from scoped_staff s
    cross join lateral (
      select range_agg(tstzrange(x.starts_at, x.ends_at, '[)')) as mr
      from private.staff_day_windows(p_business_id, s.id, v_today) x
    ) w
    cross join lateral (
      select range_agg(tstzrange(a.starts_at, a.ends_at + make_interval(mins => a.buffer_after_min), '[)')) as mr
      from public.appointments a
      where a.business_id = p_business_id
        and a.staff_id = s.id
        and a.status in ('booked', 'confirmed')
        and a.starts_at < v_day_end
        and a.starts_at > v_day_start - interval '15 hours'
        and a.ends_at + make_interval(mins => a.buffer_after_min) > v_day_start
    ) busy
    where s.min_len is not null and w.mr is not null
  )
  select coalesce(jsonb_agg(
           jsonb_build_object('staff_id', g.staff_id, 'starts_at', g.starts_at, 'ends_at', g.ends_at, 'minutes', g.minutes)
           order by g.starts_at, g.sort, g.staff_id
         ), '[]'::jsonb)
    into v_gaps
  from (
    select f.id as staff_id, f.sort, lower(r.gap) as starts_at, upper(r.gap) as ends_at,
           floor(extract(epoch from upper(r.gap) - lower(r.gap)) / 60)::integer as minutes
    from free f
    cross join lateral unnest(f.mr) as r (gap)
    where upper(r.gap) - lower(r.gap) >= make_interval(mins => f.min_len)
    order by lower(r.gap), f.sort, f.id
    limit 10
  ) g;

  return jsonb_build_object(
    'local_date', to_char(v_today, 'YYYY-MM-DD'),
    'timezone', v_tz,
    'currency', v_currency,
    'scope', case when v_manager then 'business' else 'own' end,
    'counts', jsonb_build_object('total', v_total, 'remaining', v_remaining, 'to_mark', v_to_mark_count),
    'expected_revenue_cents', v_revenue,
    'next', v_next,
    'gaps', v_gaps,
    'to_mark', v_to_mark
  );
end;
$$;

create function public.today_summary(p_business_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.today_summary_impl(p_business_id);
$$;

comment on function public.today_summary(uuid) is
  'Pro app «Σήμερα»: counts, next, gaps, to_mark and expected_revenue_cents (null unless owner/manager). Owner/manager: the business; others: their own staff row.';

-- ---------------------------------------------------------------------------------------------
-- RPC: set_appointment_status (§2.6.4): confirmed | completed | no_show, and corrections among
-- completed/no_show/cancelled (into cancelled: cancel_appointment). Idempotent by target: the
-- status already there → changed false, nothing written. p_from_status is the status the UI
-- showed; another current status → AN021 (no stale overwrite). Time rules against now(), as the
-- 0003 guard trigger (which stays the backstop): completed/no_show only after the start (AN023);
-- a staff correction only within correction_window_days after the end (AN022).
-- ---------------------------------------------------------------------------------------------
create function private.set_appointment_status_impl(
  p_business_id uuid,
  p_appointment_id uuid,
  p_from_status text,
  p_status text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_appointment public.appointments%rowtype;
  v_manager boolean;
  v_window smallint;
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;

  -- NO KEY UPDATE (1.3 §10 lock order: appointment row → day locks); never FOR UPDATE.
  select a.* into v_appointment
  from public.appointments a
  where a.business_id = p_business_id and a.id = p_appointment_id
  for no key update;
  if not found then
    raise exception 'appointment not found in this business' using errcode = '42501';
  end if;

  v_manager := private.has_role(p_business_id, array['owner', 'manager']);
  if not v_manager and v_appointment.staff_id is distinct from private.my_staff_id(p_business_id) then
    raise exception 'not allowed to change this appointment' using errcode = '42501';
  end if;

  if p_status is null or p_status not in ('confirmed', 'completed', 'no_show') then
    raise exception 'p_status must be confirmed, completed or no_show' using errcode = '22023';
  end if;
  if p_from_status is null or p_from_status not in ('booked', 'confirmed', 'completed', 'no_show', 'cancelled') then
    raise exception 'p_from_status must be an appointment status' using errcode = '22023';
  end if;

  if v_appointment.status = p_status then
    return jsonb_build_object(
      'appointment_id', v_appointment.id, 'status', v_appointment.status,
      'from_status', v_appointment.status, 'changed', false
    );
  end if;

  if v_appointment.status <> p_from_status then
    perform private.raise_domain_error('AN021');
  end if;

  if p_status = 'confirmed' then
    if v_appointment.status <> 'booked' then
      perform private.raise_domain_error('AN020');
    end if;
  else
    if v_appointment.starts_at > now() then
      perform private.raise_domain_error('AN023');
    end if;
    if v_appointment.status in ('completed', 'no_show', 'cancelled') and not v_manager then
      select b.correction_window_days into v_window from public.businesses b where b.id = p_business_id;
      if now() > v_appointment.ends_at + make_interval(days => v_window) then
        perform private.raise_domain_error('AN022');
      end if;
    end if;
  end if;

  -- Leaving completed clears charged_cents, leaving cancelled clears cancelled_by/cancel_reason
  -- (the 0003 CHECKs require both). The trigger writes status_changed with actor staff.
  update public.appointments a
  set status = p_status,
      charged_cents = case when p_status = 'completed' then a.charged_cents end,
      cancelled_by = null,
      cancel_reason = null
  where a.business_id = p_business_id and a.id = v_appointment.id;

  perform set_config('anaklo.notify_client', 'false', true);
  perform private.plan_messages_impl(v_appointment.id, 'status_changed');

  return jsonb_build_object(
    'appointment_id', v_appointment.id, 'status', p_status,
    'from_status', v_appointment.status, 'changed', true
  );
end;
$$;

create function public.set_appointment_status(
  p_business_id uuid,
  p_appointment_id uuid,
  p_from_status text,
  p_status text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.set_appointment_status_impl(p_business_id, p_appointment_id, p_from_status, p_status);
$$;

comment on function public.set_appointment_status(uuid, uuid, text, text) is
  'Pro app: confirm, complete, no-show and corrections. Returns {appointment_id, status, from_status, changed}; changed false when the status was already the target.';

-- ---------------------------------------------------------------------------------------------
-- RPC: cancel_appointment (§2.6.5): every change that ends in cancelled, by the business (a
-- normal cancel, or a correction of completed/no_show). Idempotent: already cancelled → changed
-- false with the stored reason. p_reason 'client_request' records the client as the canceller
-- (the client phoned), any other reason the business; the event actor stays staff. Revokes every
-- manage link of the appointment. No cancel_min_notice_min here: that rule is the client's.
-- p_notify counts only for an active appointment that starts in the future.
-- ---------------------------------------------------------------------------------------------
create function private.cancel_appointment_impl(
  p_business_id uuid,
  p_appointment_id uuid,
  p_from_status text,
  p_reason text,
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
  v_manager boolean;
  v_window smallint;
  v_notify boolean;
  v_cancelled_by text;
  v_before jsonb;
  v_sms_queued boolean;
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;

  select a.* into v_appointment
  from public.appointments a
  where a.business_id = p_business_id and a.id = p_appointment_id
  for no key update;
  if not found then
    raise exception 'appointment not found in this business' using errcode = '42501';
  end if;

  v_manager := private.has_role(p_business_id, array['owner', 'manager']);
  if not v_manager and v_appointment.staff_id is distinct from private.my_staff_id(p_business_id) then
    raise exception 'not allowed to change this appointment' using errcode = '42501';
  end if;

  if p_reason is null or p_reason not in (
    'client_request', 'staff_unavailable', 'shop_closed', 'rescheduled', 'duplicate', 'other'
  ) then
    raise exception 'p_reason must be a cancel_reason code' using errcode = '22023';
  end if;
  if p_notify is null then
    raise exception 'p_notify is required' using errcode = '22023';
  end if;
  if p_from_status is null or p_from_status not in ('booked', 'confirmed', 'completed', 'no_show', 'cancelled') then
    raise exception 'p_from_status must be an appointment status' using errcode = '22023';
  end if;

  if v_appointment.status = 'cancelled' then
    return jsonb_build_object(
      'appointment_id', v_appointment.id, 'status', 'cancelled', 'from_status', 'cancelled',
      'changed', false, 'cancelled_by', v_appointment.cancelled_by,
      'cancel_reason', v_appointment.cancel_reason, 'notify', false, 'sms_queued', false
    );
  end if;

  if v_appointment.status <> p_from_status then
    perform private.raise_domain_error('AN021');
  end if;

  if v_appointment.status in ('completed', 'no_show') and not v_manager then
    select b.correction_window_days into v_window from public.businesses b where b.id = p_business_id;
    if now() > v_appointment.ends_at + make_interval(days => v_window) then
      perform private.raise_domain_error('AN022');
    end if;
  end if;

  v_notify := p_notify and v_appointment.status in ('booked', 'confirmed') and v_appointment.starts_at > now();
  v_cancelled_by := case p_reason when 'client_request' then 'client' else 'business' end;

  update public.appointments a
  set status = 'cancelled',
      cancelled_by = v_cancelled_by,
      cancel_reason = p_reason,
      charged_cents = null
  where a.business_id = p_business_id and a.id = v_appointment.id;

  update public.booking_tokens t
  set revoked_at = now()
  where t.business_id = p_business_id
    and t.appointment_id = v_appointment.id
    and t.revoked_at is null;

  v_before := private.queued_sms_ids(p_business_id, v_appointment.id);
  perform set_config('anaklo.notify_client', case when v_notify then 'true' else 'false' end, true);
  perform private.plan_messages_impl(v_appointment.id, 'cancelled');
  v_sms_queued := private.sms_newly_queued(v_before, private.queued_sms_ids(p_business_id, v_appointment.id));

  return jsonb_build_object(
    'appointment_id', v_appointment.id, 'status', 'cancelled', 'from_status', v_appointment.status,
    'changed', true, 'cancelled_by', v_cancelled_by, 'cancel_reason', p_reason,
    'notify', v_notify, 'sms_queued', v_sms_queued
  );
end;
$$;

create function public.cancel_appointment(
  p_business_id uuid,
  p_appointment_id uuid,
  p_from_status text,
  p_reason text,
  p_notify boolean
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.cancel_appointment_impl(p_business_id, p_appointment_id, p_from_status, p_reason, p_notify);
$$;

comment on function public.cancel_appointment(uuid, uuid, text, text, boolean) is
  'Pro app: cancel with a reason code. Returns {appointment_id, status, from_status, changed, cancelled_by, cancel_reason, notify, sms_queued}.';

-- ---------------------------------------------------------------------------------------------
-- RPC: staff_move_appointment (§2.6.6) on top of move_core (0004). One idempotency key per
-- ATTEMPT (one exact payload). The request is serialised per key with an advisory lock; a stored
-- answer is replayed (replayed true) before the ownership rule, so a retry replays even after the
-- move handed the appointment to a colleague. Same key, other payload → AN004; the key of another
-- user → 42501. A failed attempt stores nothing, so the same key may run again. Staff may move
-- only their own appointment, also to a colleague; owner/manager any.
-- ---------------------------------------------------------------------------------------------
create function private.staff_move_appointment_impl(
  p_business_id uuid,
  p_appointment_id uuid,
  p_idempotency_key uuid,
  p_new_starts_at timestamptz,
  p_notify boolean,
  p_new_staff_id uuid,
  p_allow_outside_hours boolean,
  p_allow_buffer_overlap boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_stored private.move_requests%rowtype;
  v_appointment public.appointments%rowtype;
  v_notify boolean;
  v_before jsonb;
  v_core jsonb;
  v_result jsonb;
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
  if p_idempotency_key is null or p_new_starts_at is null or p_notify is null then
    raise exception 'p_idempotency_key, p_new_starts_at and p_notify are required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('staff_move:' || p_business_id::text || ':' || p_idempotency_key::text, 0)
  );

  -- Canonical request: jsonb text is canonical (sorted keys); the instant is an epoch.
  v_hash := encode(sha256(convert_to(jsonb_build_object(
    'appointment_id', p_appointment_id,
    'new_starts_at', extract(epoch from p_new_starts_at),
    'new_staff_id', p_new_staff_id,
    'allow_outside_hours', coalesce(p_allow_outside_hours, false),
    'allow_buffer_overlap', coalesce(p_allow_buffer_overlap, false),
    'notify', p_notify
  )::text, 'UTF8')), 'hex');

  select * into v_stored
  from private.move_requests r
  where r.business_id = p_business_id and r.idempotency_key = p_idempotency_key;
  if found then
    if v_stored.created_by is distinct from (select auth.uid()) then
      raise exception 'this idempotency key belongs to another user' using errcode = '42501';
    end if;
    if v_stored.request_hash <> v_hash then
      perform private.raise_domain_error('AN004');
    end if;
    return v_stored.result || jsonb_build_object('replayed', true);
  end if;

  -- The same lock move_core takes (it is re-entrant): appointment row first, then the days.
  select a.* into v_appointment
  from public.appointments a
  where a.business_id = p_business_id and a.id = p_appointment_id
  for no key update;

  if not private.has_role(p_business_id, array['owner', 'manager'])
     and v_appointment.staff_id is distinct from private.my_staff_id(p_business_id) then
    raise exception 'not allowed to move this appointment' using errcode = '42501';
  end if;
  if v_appointment.status not in ('booked', 'confirmed') then
    perform private.raise_domain_error('AN020');
  end if;

  v_notify := p_notify and p_new_starts_at > now();
  perform set_config('anaklo.notify_client', case when v_notify then 'true' else 'false' end, true);
  v_before := private.queued_sms_ids(p_business_id, p_appointment_id);

  -- AN001 (service overlap / exclusion), AN003, AN005/AN006 without the flag, AN008; writes
  -- rescheduled/reassigned and calls the planner 'moved'; the same time and staff is a no-op.
  v_core := private.move_core(
    p_business_id, p_appointment_id, p_new_starts_at, p_new_staff_id, 'staff',
    p_allow_outside_hours, p_allow_buffer_overlap, now()
  );

  v_result := jsonb_build_object(
    'appointment_id', v_core -> 'appointment_id',
    'staff_id', v_core -> 'staff_id',
    'starts_at', v_core -> 'starts_at',
    'ends_at', v_core -> 'ends_at',
    'warnings', v_core -> 'warnings',
    'from_staff_id', v_appointment.staff_id,
    'from_starts_at', v_appointment.starts_at,
    'replayed', false,
    'notify', v_notify,
    'sms_queued', private.sms_newly_queued(v_before, private.queued_sms_ids(p_business_id, p_appointment_id))
  );

  insert into private.move_requests (business_id, idempotency_key, appointment_id, request_hash, result, created_by)
  values (p_business_id, p_idempotency_key, p_appointment_id, v_hash, v_result, (select auth.uid()));

  return v_result;
end;
$$;

create function public.staff_move_appointment(
  p_business_id uuid,
  p_appointment_id uuid,
  p_idempotency_key uuid,
  p_new_starts_at timestamptz,
  p_notify boolean,
  p_new_staff_id uuid default null,
  p_allow_outside_hours boolean default false,
  p_allow_buffer_overlap boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.staff_move_appointment_impl(
    p_business_id, p_appointment_id, p_idempotency_key, p_new_starts_at, p_notify, p_new_staff_id,
    p_allow_outside_hours, p_allow_buffer_overlap
  );
$$;

comment on function public.staff_move_appointment(uuid, uuid, uuid, timestamptz, boolean, uuid, boolean, boolean) is
  'Pro app: move to another time and/or staff member, idempotent per attempt key. Returns {appointment_id, staff_id, starts_at, ends_at, warnings, from_staff_id, from_starts_at, replayed, notify, sms_queued}.';

-- ---------------------------------------------------------------------------------------------
-- RPC: search_clients (§2.6.7). Live clients only (not erased, not merged), at most 20.
--   · query normalised as search_text is (0002): normalize_greek, then every character that is
--     not a letter, digit or space → space, spaces collapsed; < 2 letters/digits → no rows;
--   · phone mode (only digits, spaces, + ( ) . / -): ≥ 3 digits, anywhere in phone_e164, so the
--     last digits work; those that END with them first;
--   · name mode: up to 5 words; each must be in search_text as typed or in one of its greeklish
--     spellings (a Greek query finds a name stored in Latin letters); a word of search_text that
--     starts with the first query word ranks first;
--   · fuzzy (name mode only, when the exact pass finds nothing and the query has ≥ 4 characters):
--     word_similarity ≥ 0.5 of the query or one of its greeklish spellings, best first.
-- Order: rank, last completed visit (newest first, none last), full_name, id. The letter class
-- also lists α-ω explicitly, so a database whose regex locale is plain C still keeps Greek.
-- ---------------------------------------------------------------------------------------------
create function private.search_clients_impl(p_business_id uuid, p_query text)
returns table (id uuid, full_name text, phone_e164 text, last_visit_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_norm text;
  v_digits text;
  v_tokens text[];
  v_variants text[];
  v_whole text[];
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if p_query is null then
    return;
  end if;
  if char_length(p_query) > 100 then
    raise exception 'p_query is longer than 100 characters' using errcode = '22023';
  end if;

  v_norm := btrim(regexp_replace(
    regexp_replace(private.normalize_greek(p_query), '[^[:alnum:][:space:]α-ω]', ' ', 'g'),
    '[[:space:]]+', ' ', 'g'
  ));
  if char_length(replace(v_norm, ' ', '')) < 2 then
    return;
  end if;

  if btrim(p_query) ~ '^[+0-9 ()./-]+$' then
    v_digits := regexp_replace(p_query, '[^0-9]', '', 'g');
    if char_length(v_digits) < 3 then
      return;
    end if;
    return query
      select c.id, c.full_name, c.phone_e164, v.last_visit_at
      from public.clients c
      cross join lateral (
        select max(a.starts_at) as last_visit_at
        from public.appointments a
        where a.business_id = c.business_id and a.client_id = c.id and a.status = 'completed'
      ) v
      where c.business_id = p_business_id
        and c.erased_at is null
        and c.merged_into_id is null
        and c.phone_e164 like '%' || v_digits || '%'
      order by (case when c.phone_e164 like '%' || v_digits then 0 else 1 end),
               v.last_visit_at desc nulls last, c.full_name, c.id
      limit 20;
    return;
  end if;

  v_tokens := (string_to_array(v_norm, ' '))[1:5];
  -- One row per query word: the word and its three greeklish spellings. Computed ONCE here, so
  -- the scan below only compares constants: calling greeklish_variants() inside it would run it
  -- again for every client and word (about 0.2 ms each: a second per keystroke at 5000 clients).
  select array_agg(array[u.word] || private.greeklish_variants(u.word) order by u.ord)
    into v_variants
  from unnest(v_tokens) with ordinality as u (word, ord);

  return query
    select c.id, c.full_name, c.phone_e164, v.last_visit_at
    from public.clients c
    cross join lateral (
      select max(a.starts_at) as last_visit_at
      from public.appointments a
      where a.business_id = c.business_id and a.client_id = c.id and a.status = 'completed'
    ) v
    where c.business_id = p_business_id
      and c.erased_at is null
      and c.merged_into_id is null
      and not exists (
        select 1 from generate_subscripts(v_variants, 1) as t (i)
        where not exists (
          select 1 from unnest(v_variants[t.i:t.i]) as x (variant)
          where c.search_text like '%' || x.variant || '%'
        )
      )
    order by (case when exists (
               select 1 from unnest(v_variants[1:1]) as x (variant)
               where c.search_text ~ ('(^| )' || x.variant)
             ) then 0 else 1 end),
             v.last_visit_at desc nulls last, c.full_name, c.id
    limit 20;
  if found or char_length(v_norm) < 4 then
    return;
  end if;

  -- Distinct spellings only (a Latin query is its own greeklish): one similarity per client each.
  v_whole := array(
    select distinct x.variant
    from unnest(array[v_norm] || private.greeklish_variants(v_norm)) as x (variant)
  );
  return query
    select s.id, s.full_name, s.phone_e164, v.last_visit_at
    from (
      select c.business_id, c.id, c.full_name, c.phone_e164,
             (select max(extensions.word_similarity(x.variant, c.search_text))
              from unnest(v_whole) as x (variant)) as similarity
      from public.clients c
      where c.business_id = p_business_id
        and c.erased_at is null
        and c.merged_into_id is null
    ) s
    cross join lateral (
      select max(a.starts_at) as last_visit_at
      from public.appointments a
      where a.business_id = s.business_id and a.client_id = s.id and a.status = 'completed'
    ) v
    where s.similarity >= 0.5
    order by s.similarity desc, v.last_visit_at desc nulls last, s.full_name, s.id
    limit 20;
end;
$$;

create function public.search_clients(p_business_id uuid, p_query text)
returns table (id uuid, full_name text, phone_e164 text, last_visit_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.search_clients_impl(p_business_id, p_query);
$$;

comment on function public.search_clients(uuid, text) is
  'Pro app client search (quick add, client card): name in Greek, Latin or greeklish, or ≥ 3 phone digits; live clients only, at most 20.';

-- ---------------------------------------------------------------------------------------------
-- Auto-complete (§2.7): booked/confirmed appointments whose end + auto_complete_after_min has
-- passed become completed, as the SYSTEM (declared here: pg_cron runs as postgres without a JWT).
-- At most 1000 per run, oldest end first, skipping rows another transaction holds; cancelled,
-- completed and no-show rows are never touched. Every run writes one job_runs row, failures
-- included: an error rolls the run's changes back, is recorded as its SQLSTATE and the call
-- returns null. The events carry actor system and no actor id: the caller's JWT claims are
-- hidden during the run and restored afterwards. No grants: only pg_cron and tests call it.
-- ---------------------------------------------------------------------------------------------
create function private.auto_complete_impl(p_now timestamptz default now())
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
  v_id uuid;
  v_count integer := 0;
  v_error text;
begin
  perform set_config('anaklo.actor_type', 'system', true);
  v_started := clock_timestamp();
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  begin
    if p_now is null then
      raise exception 'p_now is required' using errcode = '22023';
    end if;

    for v_id in
      select a.id
      from public.appointments a
      join public.businesses b on b.id = a.business_id
      where a.status in ('booked', 'confirmed')
        and a.ends_at <= p_now
        and a.ends_at + make_interval(mins => b.auto_complete_after_min) <= p_now
      order by a.ends_at, a.id
      limit 1000
      for no key update of a skip locked
    loop
      update public.appointments a
      set status = 'completed'
      where a.id = v_id;

      perform set_config('anaklo.notify_client', 'false', true);
      perform private.plan_messages_impl(v_id, 'status_changed');
      v_count := v_count + 1;
    end loop;
  exception when others then
    v_error := sqlstate;
  end;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_claim_sub, ''), true);

  if v_error is not null then
    perform private.record_job_run('auto_complete', v_started, false, null, v_error);
    return null;
  end if;
  perform private.record_job_run('auto_complete', v_started, true, v_count);
  return v_count;
end;
$$;

-- pg_cron lives in pg_catalog, its objects in schema cron (the API roles get no USAGE on it).
-- cron.schedule upserts by name, so a reset rebuilds the job.
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule('auto-complete', '*/10 * * * *', $$select private.auto_complete_impl()$$);

-- ---------------------------------------------------------------------------------------------
-- Grants: signed-in members only (the membership and role checks run inside each _impl).
-- record_job_run, auto_complete_impl, the planner and the helpers: nobody.
-- ---------------------------------------------------------------------------------------------
grant execute on function private.busy_calendar_impl(uuid, date) to authenticated;
grant execute on function public.busy_calendar(uuid, date) to authenticated;
grant execute on function private.today_summary_impl(uuid, timestamptz) to authenticated;
grant execute on function public.today_summary(uuid) to authenticated;
grant execute on function private.set_appointment_status_impl(uuid, uuid, text, text) to authenticated;
grant execute on function public.set_appointment_status(uuid, uuid, text, text) to authenticated;
grant execute on function private.cancel_appointment_impl(uuid, uuid, text, text, boolean) to authenticated;
grant execute on function public.cancel_appointment(uuid, uuid, text, text, boolean) to authenticated;
grant execute on function private.staff_move_appointment_impl(uuid, uuid, uuid, timestamptz, boolean, uuid, boolean, boolean) to authenticated;
grant execute on function public.staff_move_appointment(uuid, uuid, uuid, timestamptz, boolean, uuid, boolean, boolean) to authenticated;
grant execute on function private.search_clients_impl(uuid, text) to authenticated;
grant execute on function public.search_clients(uuid, text) to authenticated;
