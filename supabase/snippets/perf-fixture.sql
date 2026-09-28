-- perf-fixture.sql — LOCAL/DEV ONLY, 100% synthetic. Never run it on a database with real data.
-- Load for the exit criterion of step 1.2 (Phase 1 plan): "EXPLAIN ANALYZE: 14 days × 3 staff
-- over 5,000 appointments in < 50 ms".
--
-- Creates the business "perf-barber" (3 staff, 3 services, Tue–Sat 09:00–21:00) with 5,000
-- appointments: completed/no-show/cancelled in the past, booked/cancelled in the next weeks.
-- Everything happens in ONE DO block, because anaklo.actor_type is transaction-local and every
-- appointment write must declare its actor (here: the system). Idempotent: a second run only
-- prints a notice. The EXPLAIN at the end is read-only.
--
-- Locally `npm run db:reset` removes it; to time it without keeping anything, run the file
-- between `begin;` and `rollback;` (psql or the Studio SQL editor).
do $$
declare
  v_business uuid := '00000000-0000-4000-8000-00000000f001';
  v_tz text;
  v_first date := current_date - 120;
  v_last date := current_date + 30;
  v_inserted integer;
begin
  perform set_config('anaklo.actor_type', 'system', true);

  if exists (select 1 from public.businesses where id = v_business) then
    raise notice 'perf-barber already exists: nothing to do';
    return;
  end if;

  insert into public.businesses (id, slug, name, vertical, timezone, booking_enabled, slot_step_min, min_notice_min, max_advance_days)
  values (v_business, 'perf-barber', 'Perf Barber', 'barber', 'Europe/Athens', true, 15, 60, 60);
  select b.timezone into v_tz from public.businesses b where b.id = v_business;

  insert into public.staff (id, business_id, display_name, sort) values
    ('00000000-0000-4000-8000-00000000f101', v_business, 'Perf A', 0),
    ('00000000-0000-4000-8000-00000000f102', v_business, 'Perf B', 1),
    ('00000000-0000-4000-8000-00000000f103', v_business, 'Perf C', 2);

  insert into public.services (id, business_id, name, duration_min, buffer_after_min, price_cents, sort) values
    ('00000000-0000-4000-8000-00000000f201', v_business, 'Cut', 30, 5, 1300, 0),
    ('00000000-0000-4000-8000-00000000f202', v_business, 'Cut + beard', 45, 5, 1800, 1),
    ('00000000-0000-4000-8000-00000000f203', v_business, 'Beard', 15, 0, 700, 2);

  insert into public.staff_services (business_id, staff_id, service_id)
  select v_business, st.id, s.id
  from public.staff st cross join public.services s
  where st.business_id = v_business and s.business_id = v_business;

  insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
  select v_business, st.id, d.weekday, time '09:00', time '21:00'
  from public.staff st cross join generate_series(2, 6) as d (weekday)
  where st.business_id = v_business;

  insert into public.clients (business_id, full_name, phone_e164, source)
  select v_business, 'Perf Client ' || n, '+306900' || lpad(n::text, 6, '0'), 'staff'
  from generate_series(1, 400) as n;

  -- A 30-minute cut every 45 minutes from 09:00 (16 per staff member and working day), most
  -- recent first, cut at 5,000. Statuses follow the calendar: past → mostly completed.
  with slots as (
    select st.id as staff_id,
           ((d.day + time '09:00' + k * interval '45 minutes') at time zone v_tz) as starts_at,
           row_number() over (order by d.day desc, st.sort, k) as n
    from public.staff st
    cross join (select v_first + i as day from generate_series(0, v_last - v_first) as i) d
    cross join generate_series(0, 15) as k
    where st.business_id = v_business
      and extract(dow from d.day) between 2 and 6
  ),
  picked as (
    select s.*,
           case
             when s.starts_at < now() then
               case when s.n % 17 = 0 then 'no_show' when s.n % 11 = 0 then 'cancelled' else 'completed' end
             else case when s.n % 13 = 0 then 'cancelled' else 'booked' end
           end as status
    from slots s
    where s.n <= 5000
  ),
  client_pool as (
    select c.id, row_number() over (order by c.id) - 1 as k
    from public.clients c
    where c.business_id = v_business
  )
  insert into public.appointments (
    business_id, client_id, staff_id, starts_at, ends_at, buffer_after_min, status, source,
    total_cents, charged_cents, cancelled_by, cancel_reason
  )
  select v_business, c.id, p.staff_id, p.starts_at, p.starts_at + interval '30 minutes', 5, p.status,
         'phone', 1300,
         case when p.status = 'completed' then 1300 end,
         case when p.status = 'cancelled' then 'client' end,
         case when p.status = 'cancelled' then 'client_request' end
  from picked p
  join client_pool c on c.k = p.n % 400;

  get diagnostics v_inserted = row_count;

  insert into public.appointment_services (business_id, appointment_id, position, service_id, price_cents, duration_min)
  select v_business, a.id, 0, '00000000-0000-4000-8000-00000000f201', 1300, 30
  from public.appointments a
  where a.business_id = v_business;

  raise notice 'perf-barber: % appointments', v_inserted;
end;
$$;

-- Fresh statistics, as autovacuum would have them on a live database.
analyze public.appointments;

-- 14 local days × any of the 3 staff, public mode (the booking page's heaviest call).
explain (analyze, buffers)
select *
from private.available_slots_impl(
  '00000000-0000-4000-8000-00000000f001',
  array['00000000-0000-4000-8000-00000000f201']::uuid[],
  null,
  current_date + 1,
  current_date + 14,
  'public'
);
