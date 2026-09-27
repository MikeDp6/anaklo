-- 0003_appointments.sql
-- Appointments, their service lines and the append-only event history (SPEC §7, §8).
-- Creation and status changes go through RPCs in Phase 1 (book_appointment etc.); the API
-- roles can only read here.

-- ---------------------------------------------------------------------------------------------
-- appointments
-- ---------------------------------------------------------------------------------------------
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  client_id uuid,                                   -- null = anonymous walk-in (excluded from memory)
  staff_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,                     -- end of the service as the client sees it
  buffer_after_min smallint not null default 0 constraint appointments_buffer check (buffer_after_min between 0 and 120),
  status text not null default 'booked'
    constraint appointments_status check (status in ('booked', 'confirmed', 'completed', 'no_show', 'cancelled')),
  source text not null
    constraint appointments_source check (source in ('online', 'phone', 'walkin', 'staff', 'import')),
  referrer text constraint appointments_referrer_length check (char_length(referrer) <= 100),
  total_cents integer not null default 0 constraint appointments_total check (total_cents >= 0),
  charged_cents integer constraint appointments_charged check (charged_cents >= 0),
  cancelled_by text constraint appointments_cancelled_by check (cancelled_by in ('client', 'business', 'system')),
  -- a code, never free text (free text collects personal data)
  cancel_reason text constraint appointments_cancel_reason check (cancel_reason in (
    'client_request', 'staff_unavailable', 'shop_closed', 'rescheduled', 'duplicate', 'other'
  )),
  idempotency_key uuid,
  external_ref text constraint appointments_external_ref_length check (char_length(external_ref) <= 120),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint appointments_order check (ends_at > starts_at),
  constraint appointments_max_length check (ends_at - starts_at <= interval '12 hours'),
  constraint appointments_cancelled_consistency check ((status = 'cancelled') = (cancelled_by is not null)),
  constraint appointments_cancel_reason_only_cancelled check (cancel_reason is null or status = 'cancelled'),
  constraint appointments_charged_only_completed check (charged_cents is null or status = 'completed'),
  constraint appointments_business_id_key unique (business_id, id),
  constraint appointments_client_fk foreign key (business_id, client_id)
    references public.clients (business_id, id) on delete restrict,
  constraint appointments_staff_fk foreign key (business_id, staff_id)
    references public.staff (business_id, id) on delete restrict,
  -- Double booking is impossible at database level. Buffers are enforced by availability and
  -- book_appointment (Phase 1), not here, so staff can deliberately squeeze an appointment in.
  constraint appointments_no_overlap exclude using gist (
    staff_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('booked', 'confirmed'))
);

create index appointments_starts_idx on public.appointments (business_id, starts_at);
create index appointments_client_completed_idx on public.appointments (business_id, client_id, starts_at)
  where status = 'completed';
create unique index appointments_idempotency_key on public.appointments (business_id, idempotency_key)
  where idempotency_key is not null;
create unique index appointments_external_ref_key on public.appointments (business_id, source, external_ref)
  where external_ref is not null;

-- ---------------------------------------------------------------------------------------------
-- appointment_services: price and duration copied at booking time
-- ---------------------------------------------------------------------------------------------
create table public.appointment_services (
  business_id uuid not null references public.businesses (id) on delete restrict,
  appointment_id uuid not null,
  position smallint not null constraint appointment_services_position check (position between 0 and 20),
  service_id uuid not null,
  price_cents integer not null constraint appointment_services_price check (price_cents >= 0),
  duration_min smallint not null constraint appointment_services_duration check (duration_min between 5 and 600),
  primary key (business_id, appointment_id, position),
  constraint appointment_services_appointment_fk foreign key (business_id, appointment_id)
    references public.appointments (business_id, id) on delete restrict,
  constraint appointment_services_service_fk foreign key (business_id, service_id)
    references public.services (business_id, id) on delete restrict
);

-- ---------------------------------------------------------------------------------------------
-- appointment_events: insert-only history, no personal data (ids, times, statuses only)
-- ---------------------------------------------------------------------------------------------
create table public.appointment_events (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses (id) on delete restrict,
  appointment_id uuid not null,
  event text not null
    constraint appointment_events_event check (event in ('created', 'status_changed', 'rescheduled', 'reassigned', 'imported')),
  from_status text,
  to_status text,
  old_starts_at timestamptz,
  new_starts_at timestamptz,
  old_staff_id uuid,
  new_staff_id uuid,
  actor_type text not null
    constraint appointment_events_actor_type check (actor_type in ('client', 'staff', 'system', 'import')),
  actor_id uuid,
  occurred_at timestamptz not null default now(),
  constraint appointment_events_appointment_fk foreign key (business_id, appointment_id)
    references public.appointments (business_id, id) on delete restrict
);

create index appointment_events_appointment_idx on public.appointment_events (business_id, appointment_id, occurred_at);

-- Who is acting. Every RPC and job sets `anaklo.actor_type` transaction-locally
-- (set_config('anaklo.actor_type', 'client' | 'system' | 'import', true)): the booking/manage
-- RPCs 'client', cron jobs 'system', the importer 'import'. Without it, a signed-in user is
-- 'staff' and anything else is 'system'.
create function private.current_actor_type()
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when current_setting('anaklo.actor_type', true) in ('client', 'staff', 'system', 'import')
      then current_setting('anaklo.actor_type', true)
    when (select auth.uid()) is not null then 'staff'
    else 'system'
  end;
$$;

-- SECURITY DEFINER: the API roles have SELECT only on appointment_events; only this trigger writes.
create function private.log_appointment_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := private.current_actor_type();
  v_actor_id uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    insert into public.appointment_events
      (business_id, appointment_id, event, to_status, new_starts_at, new_staff_id, actor_type, actor_id)
    values (
      new.business_id, new.id,
      case when new.source = 'import' then 'imported' else 'created' end,
      new.status, new.starts_at, new.staff_id,
      case when new.source = 'import' then 'import' else v_actor end,
      v_actor_id
    );
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.appointment_events
      (business_id, appointment_id, event, from_status, to_status, actor_type, actor_id)
    values (new.business_id, new.id, 'status_changed', old.status, new.status, v_actor, v_actor_id);
  end if;

  if new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at then
    insert into public.appointment_events
      (business_id, appointment_id, event, old_starts_at, new_starts_at, actor_type, actor_id)
    values (new.business_id, new.id, 'rescheduled', old.starts_at, new.starts_at, v_actor, v_actor_id);
  end if;

  if new.staff_id is distinct from old.staff_id then
    insert into public.appointment_events
      (business_id, appointment_id, event, old_staff_id, new_staff_id, actor_type, actor_id)
    values (new.business_id, new.id, 'reassigned', old.staff_id, new.staff_id, v_actor, v_actor_id);
  end if;

  return new;
end;
$$;

create trigger appointments_log_events
  after insert or update of status, starts_at, ends_at, staff_id on public.appointments
  for each row execute function private.log_appointment_events();

-- Status transitions (SPEC §7):
--   booked/confirmed → confirmed, completed, no_show, cancelled   (confirmed → booked is not allowed)
--   completed/no_show/cancelled are final, but may be corrected among themselves:
--     · by the system or an import (actor type), or an owner/manager, any time;
--     · never by a client (booking/manage RPCs run with actor type 'client');
--     · by the staff member of the appointment, within businesses.correction_window_days after it ended.
--   Nothing ever goes back to booked/confirmed.
create function private.guard_appointment_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window smallint;
begin
  if new.status = old.status then
    return new;
  end if;

  if old.status in ('booked', 'confirmed') then
    if old.status = 'confirmed' and new.status = 'booked' then
      raise exception 'invalid appointment status transition % -> %', old.status, new.status
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.status in ('completed', 'no_show', 'cancelled') then
    -- Only the system (cron, service jobs) and imports may correct at any time. A client-facing
    -- RPC declares actor 'client' and falls through to the refusal below.
    if private.current_actor_type() in ('system', 'import')
       or private.has_role(new.business_id, array['owner', 'manager']) then
      return new;
    end if;

    select b.correction_window_days into v_window from public.businesses b where b.id = new.business_id;
    if old.staff_id = private.my_staff_id(new.business_id)
       and now() <= old.ends_at + make_interval(days => v_window) then
      return new;
    end if;

    raise exception 'correcting % -> % is not allowed for this user now', old.status, new.status
      using errcode = '42501';
  end if;

  raise exception 'invalid appointment status transition % -> %', old.status, new.status
    using errcode = '23514';
end;
$$;

create trigger appointments_guard_status
  before update of status on public.appointments
  for each row execute function private.guard_appointment_status();

-- ---------------------------------------------------------------------------------------------
-- RLS: owner/manager see every appointment; staff see their own. Colleagues' bookings are shown
-- to staff as busy blocks through an RPC without prices or client names (Phase 1).
-- Sub-selects on appointments inside policies are themselves filtered by appointments' RLS.
-- ---------------------------------------------------------------------------------------------
alter table public.appointments enable row level security;
alter table public.appointment_services enable row level security;
alter table public.appointment_events enable row level security;

create policy appointments_select on public.appointments for select to authenticated
  using (
    business_id in (select private.my_business_ids_with_role(array['owner', 'manager']))
    or staff_id in (select private.my_staff_ids())
  );

create policy appointment_services_select on public.appointment_services for select to authenticated
  using (exists (
    select 1 from public.appointments a
    where a.business_id = appointment_services.business_id and a.id = appointment_services.appointment_id
  ));

create policy appointment_events_select on public.appointment_events for select to authenticated
  using (exists (
    select 1 from public.appointments a
    where a.business_id = appointment_events.business_id and a.id = appointment_events.appointment_id
  ));

-- ---------------------------------------------------------------------------------------------
-- Grants: read-only for the app; events are written by the trigger only.
-- ---------------------------------------------------------------------------------------------
grant select on public.appointments to authenticated;
grant select on public.appointment_services to authenticated;
grant select on public.appointment_events to authenticated;

grant select, insert, update on public.appointments to service_role;
grant select, insert, update on public.appointment_services to service_role;
grant select on public.appointment_events to service_role;
