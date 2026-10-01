-- 0007_messaging.sql
-- Messaging: planner v2, claim and results for a dispatcher, staff push (SPEC §5 flow 1, §7, §11,
-- §12, §15; ADR-0006/0007/0009/0010; Phase 1 plan step 1.5).
-- Contract: docs/plans/contracts/1.5-messaging.md (§2 is this file).
--
--   pg_net                            the nudge of the Edge Function `dispatch` (after commit)
--   businesses                        quiet hours, reminder mode, sender id, caps, import_reminders
--   private.platform_settings         push kill switch, platform monthly SMS cap, unit cost
--   member_notification_prefs         per-member push preferences (defaults only in 1.5, no UI)
--   push_subscriptions                staff devices, per USER (ADR-0010 §2), only through RPCs
--   business_members_drop_push        every membership removal or role change drops the user's devices
--   private.reminder_at               the only place of the reminder time rules (24h/26h, quiet hours)
--   private.plan_messages_impl        planner v2 (signature unchanged since 0004)
--   private.claim_core                one claim for the Edge Functions' ids and the dispatcher's due rows
--   private.dispatch_sweep_impl       pg_cron 'dispatch-sweep' every 5′: dead leases → unknown, nudge
--   private.purge_impl                pg_cron 'nightly-purge' 01:17 UTC: retention
--
-- API (thin SECURITY INVOKER wrappers in public, SECURITY DEFINER _impl in private):
--   authenticated: register_push_subscription, unregister_push_subscription (no p_business_id:
--                  subscriptions are per user, D14), request_test_push
--   service_role:  claim_due_messages, record_delivery_report, record_dispatch_run
--                  (+ claim_messages and record_send_result of 0005, new bodies)
--
-- Clock: the planner keeps its signature and plans against now(); every time rule is in the pure
-- private.reminder_at(…, p_now), which pgTAP calls with fixed instants (D1). Every other _impl
-- takes p_now last.
--
-- 1.7 must: call private.drop_push_subscriptions(user_id) from revoke_user_sessions_impl; let
-- remove_member/set_member_role write business_members normally (the trigger below then drops the
-- user's devices in the same transaction); «Αποσύνδεση από όλες τις συσκευές» calls
-- unregister_push_subscription(p_all => true) before signOut({ scope: 'global' }) (D13).

-- ---------------------------------------------------------------------------------------------
-- Extension. pg_net keeps its functions and queue in schema net. Supabase's event trigger grants
-- USAGE on net and EXECUTE on net.http_* to the API roles, and postgres cannot revoke them; net is
-- not an exposed PostgREST schema (config.toml [api] schemas), so no API role reaches it over
-- HTTP (D19).
-- ---------------------------------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------------------------
-- businesses: messaging settings. quiet_start/quiet_end/reminder_mode are editable by
-- owner/manager (1.6 screens); the sender id, the caps, the budget and import_reminders are set
-- by provisioning only (service_role's table-level UPDATE), never by the app.
-- ---------------------------------------------------------------------------------------------
alter table public.businesses
  add column quiet_start time not null default '22:00',
  add column quiet_end time not null default '09:00',
  add column reminder_mode text not null default '24h'
    constraint businesses_reminder_mode check (reminder_mode in ('24h', 'evening_before')),
  -- alphanumeric sender (1–11 of [A-Za-z0-9 .-], alphanumeric at both ends, ≥ 1 letter);
  -- null = the platform sender (1.10)
  add column sms_sender_id text
    constraint businesses_sms_sender_id check (
      sms_sender_id ~ '^[A-Za-z0-9](?:[A-Za-z0-9 .-]{0,9}[A-Za-z0-9])?$'
      and sms_sender_id ~ '[A-Za-z]'
    ),
  -- SMS other than OTP per UTC day (null = the platform's sms_per_business_day)
  add column sms_daily_cap integer
    constraint businesses_sms_daily_cap check (sms_daily_cap between 0 and 100000),
  -- estimated monthly spend on reminders and marketing (null = no budget)
  add column sms_monthly_budget_cents integer
    constraint businesses_sms_monthly_budget_cents check (sms_monthly_budget_cents between 0 and 10000000),
  -- Anaklo is the designated sender of the reminders of imported appointments (SPEC §15)
  add column import_reminders boolean not null default false,
  -- a quiet window of 1–12 hours in whole minutes, possibly across midnight
  add constraint businesses_quiet_hours check (
    quiet_start <> quiet_end
    and extract(second from quiet_start) = 0
    and extract(second from quiet_end) = 0
    and (case when quiet_end > quiet_start then quiet_end - quiet_start
              else quiet_end - quiet_start + interval '24 hours' end)
        between interval '1 hour' and interval '12 hours'
  );

grant update (quiet_start, quiet_end, reminder_mode) on public.businesses to authenticated;

-- ---------------------------------------------------------------------------------------------
-- private.platform_settings: push switch, platform monthly cap (all SMS incl. OTP, UTC month,
-- counted at claim) and the unit cost that estimates a business's monthly spend.
-- ---------------------------------------------------------------------------------------------
alter table private.platform_settings
  add column push_enabled boolean not null default true,
  add column sms_monthly_cap integer not null default 9000
    constraint platform_settings_sms_monthly_cap check (sms_monthly_cap between 0 and 10000000),
  add column sms_unit_cost_cents smallint not null default 5
    constraint platform_settings_sms_unit_cost_cents check (sms_unit_cost_cents between 0 and 1000);

-- ---------------------------------------------------------------------------------------------
-- Value lists that grow (re-created under the same names; domain.ts carries the same lists)
-- ---------------------------------------------------------------------------------------------
alter table public.rate_limits
  drop constraint rate_limits_bucket,
  add constraint rate_limits_bucket check (bucket in (
    'otp_phone_hour', 'otp_ip_hour', 'otp_business_day', 'sms_platform_day', 'sms_phone_day', 'sms_business_day',
    'sms_platform_month'
  ));

alter table private.job_runs
  drop constraint job_runs_job,
  add constraint job_runs_job check (job in ('auto_complete', 'dispatch_sweep', 'dispatch', 'purge'));

-- messages_log: push templates, the channel/template pairing and the push row shape. A push row
-- names its recipient in recipient_user_id (on delete set null → the claim cancels it
-- 'no_recipient'); to_e164 and client_id are null; its devices are resolved at claim time.
alter table public.messages_log
  drop constraint messages_log_template,
  add constraint messages_log_template check (template in (
    'otp', 'booking_confirmed', 'reminder', 'cancelled_by_client', 'cancelled_by_business',
    'rescheduled_by_client', 'rescheduled_by_business',
    'push_booking_created', 'push_booking_cancelled', 'push_booking_moved', 'push_test'
  )),
  add constraint messages_log_channel_template check ((channel = 'push') = (template like 'push\_%')),
  add constraint messages_log_push_appointment check (
    channel = 'sms' or ((template = 'push_test') = (appointment_id is null))
  ),
  add constraint messages_log_push_client check (channel = 'sms' or client_id is null);

-- delivery reports find their row by the provider's id
create unique index messages_log_provider_message_key on public.messages_log (provider, provider_message_id)
  where provider_message_id is not null;
-- the purge
create index messages_log_created_idx on public.messages_log (created_at);
-- the sweep
create index messages_log_sending_idx on public.messages_log (lease_until) where status = 'sending';

-- ---------------------------------------------------------------------------------------------
-- member_notification_prefs: per member and business. No row = the defaults; a null column = its
-- default (push_own true, push_all only for owners). Read-only for the member; no UI in 1.5.
-- ---------------------------------------------------------------------------------------------
create table public.member_notification_prefs (
  business_id uuid not null,
  user_id uuid not null,
  -- pushes about my own staff row's appointments; null = true
  push_own boolean,
  -- pushes about every appointment of the business; null = (role = 'owner')
  push_all boolean,
  updated_at timestamptz not null default now(),
  primary key (business_id, user_id),
  constraint member_notification_prefs_member_fk foreign key (business_id, user_id)
    references public.business_members (business_id, user_id) on delete cascade
);

comment on table public.member_notification_prefs is
  'Per-member push preferences (null = role default). Read by the planner; written by no API role in 1.5.';

alter table public.member_notification_prefs enable row level security;
revoke all on table public.member_notification_prefs from public, anon, authenticated, service_role;

create policy member_notification_prefs_select on public.member_notification_prefs for select to authenticated
  using (business_id in (select private.my_business_ids()) and user_id = (select auth.uid()));

grant select on public.member_notification_prefs to authenticated;

-- ---------------------------------------------------------------------------------------------
-- push_subscriptions: one row per device subscription, owned by exactly one user at a time
-- (UNIQUE subscription_id / endpoint: a shared phone belongs to whoever registered it last).
-- Per user, not per business (ADR-0010 §2): no business_id. Written only by the RPCs below and
-- by the membership trigger; the user reads their own rows.
-- ---------------------------------------------------------------------------------------------
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null constraint push_subscriptions_provider check (provider in ('onesignal', 'vapid')),
  -- OneSignal PushSubscription.id, lower-case UUID
  subscription_id text constraint push_subscriptions_subscription_id_key unique,
  -- VAPID
  endpoint text constraint push_subscriptions_endpoint_key unique,
  p256dh text,
  auth_secret text,
  created_at timestamptz not null default now(),
  -- last (re)registration
  updated_at timestamptz not null default now(),
  constraint push_subscriptions_shape check (
    (provider = 'onesignal'
      and subscription_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and endpoint is null and p256dh is null and auth_secret is null)
    or (provider = 'vapid'
      and subscription_id is null
      and endpoint ~ '^https://' and char_length(endpoint) <= 2048
      and p256dh ~ '^[A-Za-z0-9_-]{80,100}$'
      and auth_secret ~ '^[A-Za-z0-9_-]{16,32}$')
  )
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

comment on table public.push_subscriptions is
  'Staff push devices (ADR-0010): per user, one owner per subscription. Only through the register/unregister RPCs.';

alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from public, anon, authenticated, service_role;

create policy push_subscriptions_select on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

grant select on public.push_subscriptions to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Every delete of a membership row and every change of its role drops ALL of the user's devices
-- (D13): the DB-level guarantee while business_members is still writable by an owner in aal2
-- (0001), and for 1.7's remove_member/set_member_role, which write the same table.
-- ---------------------------------------------------------------------------------------------

-- Deletes every push_subscriptions row of a user; returns the count. 1.7's
-- revoke_user_sessions_impl must call it too (mfa-reset, 1.9 reaction).
create function private.drop_push_subscriptions(p_user_id uuid)
returns integer
language sql
volatile
set search_path = ''
as $$
  with d as (
    delete from public.push_subscriptions s where s.user_id = p_user_id returning 1
  )
  select count(*)::integer from d;
$$;

-- Definer: an owner deleting a membership holds no privilege on push_subscriptions.
create function private.business_members_drop_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform private.drop_push_subscriptions(old.user_id);
  elsif (new.role, new.user_id, new.business_id) is distinct from (old.role, old.user_id, old.business_id) then
    perform private.drop_push_subscriptions(old.user_id);
  end if;
  return null;
end;
$$;

create trigger business_members_drop_push
  after delete or update of role, user_id, business_id on public.business_members
  for each row execute function private.business_members_drop_push();

-- ---------------------------------------------------------------------------------------------
-- Helpers (private, no grants)
-- ---------------------------------------------------------------------------------------------

-- A Vault secret by name, or null. Never raises (private.vault_secret wants ≥ 32 characters).
create function private.vault_value_or_null(p_name text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_value text;
begin
  select s.decrypted_secret into v_value
  from vault.decrypted_secrets s
  where s.name = p_name;
  return v_value;
exception when others then
  return null;
end;
$$;

-- Asks the Edge Function `dispatch` to run, at most once per transaction. pg_net queues the
-- request in the transaction and sends it only after commit, together with the rows it is about.
-- false when the URL/secret are not in Vault or anything fails: a nudge never fails its caller
-- (the 5′ sweep catches up). The secret sits in net.http_request_queue until the worker sends it.
create function private.nudge_dispatch(p_source text)
returns boolean
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  if current_setting('anaklo.dispatch_nudged', true) = 'true' then
    return true;
  end if;

  v_url := private.vault_value_or_null('dispatch_url');
  v_secret := private.vault_value_or_null('dispatch_secret');
  if v_url is null or v_url !~ '^https?://' or v_secret is null or char_length(v_secret) < 32 then
    return false;
  end if;

  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('source', p_source),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-anaklo-dispatch-secret', v_secret),
    timeout_milliseconds := 5000
  );
  perform set_config('anaklo.dispatch_nudged', 'true', true);
  return true;
exception when others then
  return false;
end;
$$;

-- Who gets a push about an appointment of p_business_id (D10): the members whose staff row is
-- one of p_staff_ids (unless push_own = false) and everyone with push_all (default: owners),
-- except the acting user, and only users with ≥ 1 registered device right now.
create function private.push_recipients(p_business_id uuid, p_staff_ids uuid[], p_exclude_user_id uuid)
returns setof uuid
language sql
stable
set search_path = ''
as $$
  select distinct m.user_id
  from public.business_members m
  left join public.member_notification_prefs p on p.business_id = m.business_id and p.user_id = m.user_id
  where m.business_id = p_business_id
    and ((m.staff_id = any (p_staff_ids) and coalesce(p.push_own, true))
         or coalesce(p.push_all, m.role = 'owner'))
    and m.user_id is distinct from p_exclude_user_id
    and exists (select 1 from public.push_subscriptions s where s.user_id = m.user_id);
$$;

-- Whether an SMS can reach this E.164 number: any non-Greek number, and Greek mobiles (+3069)
-- only; a Greek landline (+302…) cannot receive SMS (D24). The planner plans nothing for such a
-- phone (so sms_queued of the 1.4 RPCs never promises an SMS it cannot send) and the claim
-- checks it again (not_mobile), for a number that changed after planning.
create function private.sms_reachable(p_e164 text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_e164 is not null and (p_e164 !~ '^\+30' or p_e164 ~ '^\+3069');
$$;

-- Whether a local wall-clock instant falls in [quiet_start, quiet_end) (possibly across midnight).
create function private.in_quiet_hours(p_at timestamptz, p_tz text, p_quiet_start time, p_quiet_end time)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_t time := (p_at at time zone p_tz)::time;
begin
  if p_quiet_start < p_quiet_end then
    return v_t >= p_quiet_start and v_t < p_quiet_end;
  end if;
  return v_t >= p_quiet_start or v_t < p_quiet_end;
end;
$$;

-- The last instant a queued row may still be claimed (D21); null = no deadline (OTP,
-- confirmations, changes, cancellations). A retry moves scheduled_for, so it moves the deadline
-- of a reminder/push by at most 15′ (two retries); a reminder never passes its appointment start.
create function private.message_deadline(p_template text, p_scheduled_for timestamptz, p_starts_at timestamptz)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case
    when p_template = 'reminder' then least(p_scheduled_for + interval '60 minutes', p_starts_at)
    when p_template = 'push_test' then p_scheduled_for + interval '10 minutes'
    when p_template like 'push\_%' then p_scheduled_for + interval '60 minutes'
  end;
$$;

-- The rows of an appointment the caller sends right after commit: queued and due now, SMS AND
-- push (D27; the name is kept for the callers of 0005/0006). Returned on replays too, so a
-- confirmation whose first send never ran is healed. "Now" is the wall clock, not the
-- transaction start: a replay that began before the first booking committed still sees the rows
-- that booking queued (their scheduled_for is the first transaction's now()).
create or replace function private.queued_sms_ids(p_business_id uuid, p_appointment_id uuid)
returns jsonb
language sql
volatile
set search_path = ''
as $$
  select coalesce(jsonb_agg(m.id order by m.created_at, m.id), '[]'::jsonb)
  from public.messages_log m
  where m.business_id = p_business_id
    and m.appointment_id = p_appointment_id
    and m.status = 'queued'
    and m.scheduled_for <= clock_timestamp();
$$;

-- true iff p_after (queued_sms_ids after a planner call) holds an SMS row that p_before lacks:
-- "an SMS to the client was queued for now" (sms_queued of the 1.4 RPCs).
create or replace function private.sms_newly_queued(p_before jsonb, p_after jsonb)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from jsonb_array_elements_text(coalesce(p_after, '[]'::jsonb)) as x (id)
    join public.messages_log m on m.id = x.id::uuid
    where not (coalesce(p_before, '[]'::jsonb) ? x.id)
      and m.channel = 'sms'
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- private.reminder_at: the only place of the reminder time rules (SPEC §12; D2, D3). Null = no
-- reminder.
--   · '24h': the same local wall-clock time on the previous local date (25 h before the Sunday of
--     a fall-back, 23 h before the Sunday of a spring-forward); 'evening_before': 18:00 local the
--     day before;
--   · inside the quiet hours → earlier, at quiet_start − 1 h before the night it falls in
--     (22:00–09:00: 23:00 → 21:00 the same day, 08:00 → 21:00 the day before);
--   · none when the appointment starts < 26 h after p_now (booked too late), or when the result
--     is earlier than p_now + 2 h (never moved later: a later fallback could pass the start).
-- Local wall-clock to instant follows PostgreSQL's rule for a gap/overlap hour.
-- ---------------------------------------------------------------------------------------------
create function private.reminder_at(
  p_starts_at timestamptz,
  p_timezone text,
  p_mode text,
  p_quiet_start time,
  p_quiet_end time,
  p_now timestamptz
)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_local timestamp := p_starts_at at time zone p_timezone;
  v_base timestamp;
  v_night date;
  v_at timestamptz;
begin
  v_base := case p_mode
    when '24h' then v_local - interval '1 day'
    when 'evening_before' then (v_local::date - 1) + time '18:00'
  end;
  if v_base is null or p_now is null then
    return null;
  end if;

  if (p_quiet_start < p_quiet_end and v_base::time >= p_quiet_start and v_base::time < p_quiet_end)
     or (p_quiet_start > p_quiet_end and (v_base::time >= p_quiet_start or v_base::time < p_quiet_end)) then
    v_night := case when p_quiet_start > p_quiet_end and v_base::time < p_quiet_end
                    then v_base::date - 1 else v_base::date end;
    v_base := v_night + p_quiet_start - interval '1 hour';
  end if;

  v_at := v_base at time zone p_timezone;
  if p_starts_at - p_now < interval '26 hours' then
    return null;
  end if;
  if v_at < p_now + interval '2 hours' then
    return null;
  end if;
  return v_at;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- private.plan_messages_impl, body v2 (signature unchanged since 0004). All planning rules of
-- SPEC §12 in one place (contract §2.7):
--   1. moved/cancelled, or status_changed to a non-active status → every queued SMS of the
--      appointment is cancelled ('superseded'), except the notice of this very change and, on a
--      move, the reminder of the start it has now (planning the same change twice changes
--      nothing; a hand-over at the same time keeps the client's reminder); push rows never are;
--   2. client notice (client with a live phone that can receive SMS, private.sms_reachable):
--        created   online → booking_confirmed; phone/staff → booking_confirmed iff it starts in ≥ 2 h
--        moved     client → rescheduled_by_client; staff + notify → rescheduled_by_business
--                  (one per move: the key carries the rescheduled/reassigned event id)
--        cancelled client → cancelled_by_client; staff + notify → the template of cancelled_by
--                  (client_request → cancelled_by_client, else cancelled_by_business)
--   3. reminder (created/moved of an active appointment, not walk-in, import only with
--      import_reminders) at private.reminder_at(…, now()); a superseded reminder of the same
--      start is revived (moving back), a sent one is never repeated;
--   4. push to the recipients of private.push_recipients: new online booking, and every move or
--      cancel (client or staff) of an active appointment that starts in the future;
--   5. a row due now from a non-client actor → nudge dispatch (client flows are sent by their
--      Edge Function right after commit).
-- Actor: declared anaklo.actor_type, else 'staff' when signed in, else unknown (no notices, no
-- push). notify: staff actor, moved/cancelled and anaklo.notify_client = 'true' (set by the 1.4
-- RPCs right before). Direct inserts of seed.sql never call it.
-- ---------------------------------------------------------------------------------------------
create or replace function private.plan_messages_impl(p_appointment_id uuid, p_change text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_uid uuid := (select auth.uid());
  v_actor text;
  v_notify boolean;
  v_a public.appointments%rowtype;
  v_b public.businesses%rowtype;
  v_e public.appointment_events%rowtype;
  v_phone text;
  v_locale text;
  v_erased_at timestamptz;
  v_sms_ok boolean;
  v_notice text;
  v_notice_key text;
  v_push text;
  v_push_key text;
  v_staff_ids uuid[];
  v_at timestamptz;
  v_due integer := 0;
  v_count integer;
begin
  if p_change is null or p_change not in ('created', 'moved', 'cancelled', 'status_changed') then
    raise exception 'p_change must be created, moved, cancelled or status_changed' using errcode = '22023';
  end if;

  select a.* into v_a from public.appointments a where a.id = p_appointment_id;
  if not found then
    return;
  end if;

  v_actor := coalesce(nullif(current_setting('anaklo.actor_type', true), ''),
                      case when v_uid is not null then 'staff' end);
  v_notify := coalesce(v_actor = 'staff', false)
              and p_change in ('moved', 'cancelled')
              and coalesce(current_setting('anaklo.notify_client', true) = 'true', false);

  -- 1a. a status change only supersedes (to a non-active status)
  if p_change = 'status_changed' then
    if v_a.status not in ('booked', 'confirmed') then
      update public.messages_log m
      set status = 'cancelled', error = 'superseded', updated_at = v_now
      where m.business_id = v_a.business_id
        and m.appointment_id = v_a.id
        and m.channel = 'sms'
        and m.status = 'queued';
    end if;
    return;
  end if;

  select b.* into v_b from public.businesses b where b.id = v_a.business_id;
  if v_a.client_id is not null then
    select c.phone_e164, c.locale, c.erased_at
      into v_phone, v_locale, v_erased_at
    from public.clients c
    where c.business_id = v_a.business_id and c.id = v_a.client_id;
  end if;
  -- a live client whose phone can receive SMS (a Greek landline cannot: no notice, confirmation
  -- or reminder is planned, so the 1.4 RPCs answer sms_queued = false)
  v_sms_ok := v_a.client_id is not null and v_erased_at is null and private.sms_reachable(v_phone);

  select e.* into v_e
  from public.appointment_events e
  where e.business_id = v_a.business_id and e.appointment_id = v_a.id
  order by e.id desc
  limit 1;

  -- What this change asks for (the table of contract §2.7).
  if p_change = 'created' then
    if v_a.source = 'online' then
      v_notice := 'booking_confirmed';
      v_push := 'push_booking_created';
      v_push_key := 'appt:' || v_a.id::text || ':push_booking_created:';
      v_staff_ids := array[v_a.staff_id];
    elsif v_a.source in ('phone', 'staff') and v_a.starts_at >= v_now + interval '2 hours' then
      v_notice := 'booking_confirmed';
    end if;
    if v_notice is not null then
      v_notice_key := 'appt:' || v_a.id::text || ':booking_confirmed';
    end if;
  elsif p_change = 'moved' then
    if v_e.event in ('rescheduled', 'reassigned') then
      if v_actor = 'client' then
        v_notice := 'rescheduled_by_client';
      elsif v_actor = 'staff' and v_notify then
        v_notice := 'rescheduled_by_business';
      end if;
      if v_notice is not null then
        v_notice_key := 'appt:' || v_a.id::text || ':' || v_notice || ':' || v_e.id::text;
      end if;
      if v_actor in ('client', 'staff') and v_a.starts_at > v_now then
        v_push := 'push_booking_moved';
        v_push_key := 'appt:' || v_a.id::text || ':push_booking_moved:' || v_e.id::text || ':';
        v_staff_ids := array_remove(
          array[v_a.staff_id, case when v_e.event = 'reassigned' then v_e.old_staff_id end], null
        );
      end if;
    end if;
  else
    if v_actor = 'client' then
      v_notice := 'cancelled_by_client';
    elsif v_actor = 'staff' and v_notify then
      v_notice := case when v_a.cancelled_by = 'client' then 'cancelled_by_client' else 'cancelled_by_business' end;
    end if;
    if v_notice is not null then
      v_notice_key := 'appt:' || v_a.id::text || ':' || v_notice;
    end if;
    if v_actor in ('client', 'staff') and v_e.from_status in ('booked', 'confirmed') and v_a.starts_at > v_now then
      v_push := 'push_booking_cancelled';
      v_push_key := 'appt:' || v_a.id::text || ':push_booking_cancelled:';
      v_staff_ids := array[v_a.staff_id];
    end if;
  end if;

  -- 1b. supersede every queued SMS of a moved/cancelled appointment, except the notice of THIS
  -- change (its key names the event, or the cancellation) and, for a move, the reminder of the
  -- start it has now: planning the same change twice is a no-op, and a hand-over at the same
  -- time keeps the reminder the client already has (even when it is now < 26 h away).
  if p_change in ('moved', 'cancelled') then
    update public.messages_log m
    set status = 'cancelled', error = 'superseded', updated_at = v_now
    where m.business_id = v_a.business_id
      and m.appointment_id = v_a.id
      and m.channel = 'sms'
      and m.status = 'queued'
      and m.dedupe_key is distinct from v_notice_key
      and (p_change = 'cancelled'
           or m.dedupe_key <> 'appt:' || v_a.id::text || ':reminder:' || extract(epoch from v_a.starts_at)::bigint::text);
  end if;

  -- 2. client notice
  if v_notice is not null and v_sms_ok then
    insert into public.messages_log (
      business_id, client_id, appointment_id, dedupe_key, channel, to_e164, locale, template,
      category, scheduled_for
    )
    values (
      v_a.business_id, v_a.client_id, v_a.id, v_notice_key, 'sms', v_phone, v_locale, v_notice,
      'transactional', v_now
    )
    on conflict (dedupe_key) do nothing;
    get diagnostics v_count = row_count;
    v_due := v_due + v_count;
  end if;

  -- 3. reminder
  if v_sms_ok
     and v_a.status in ('booked', 'confirmed')
     and p_change in ('created', 'moved')
     and v_a.source <> 'walkin'
     and (v_a.source <> 'import' or v_b.import_reminders) then
    v_at := private.reminder_at(v_a.starts_at, v_b.timezone, v_b.reminder_mode, v_b.quiet_start, v_b.quiet_end, v_now);
    if v_at is not null then
      insert into public.messages_log as m (
        business_id, client_id, appointment_id, dedupe_key, channel, to_e164, locale, template,
        category, scheduled_for
      )
      values (
        v_a.business_id, v_a.client_id, v_a.id,
        'appt:' || v_a.id::text || ':reminder:' || extract(epoch from v_a.starts_at)::bigint::text,
        'sms', v_phone, v_locale, 'reminder', 'reminder', v_at
      )
      on conflict (dedupe_key) do update
        set status = 'queued',
            scheduled_for = excluded.scheduled_for,
            to_e164 = excluded.to_e164,
            locale = excluded.locale,
            client_id = excluded.client_id,
            error = null,
            updated_at = v_now
        where m.status = 'cancelled' and m.error = 'superseded';
      get diagnostics v_count = row_count;
      if v_at <= v_now then
        v_due := v_due + v_count;
      end if;
    end if;
  end if;

  -- 4. push
  if v_push is not null then
    insert into public.messages_log (
      business_id, appointment_id, dedupe_key, channel, recipient_user_id, locale, template,
      category, scheduled_for
    )
    select v_a.business_id, v_a.id, v_push_key || r.user_id::text, 'push', r.user_id, v_b.locale, v_push,
           'transactional', v_now
    from private.push_recipients(v_a.business_id, v_staff_ids, v_uid) as r (user_id)
    on conflict (dedupe_key) do nothing;
    get diagnostics v_count = row_count;
    v_due := v_due + v_count;
  end if;

  -- 5. nudge
  if v_due > 0 and v_actor is distinct from 'client' then
    perform private.nudge_dispatch('nudge');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- private.claim_core: leases queued rows to a sender (contract §2.8). Two modes:
--   ids (p_ids not null): the Edge Functions' immediate path, right after their RPC; OTP included;
--   due (p_ids null):     the dispatcher, up to p_limit rows due now, never OTP. Rows whose whole
--                         channel is stopped (switch off, platform room used up) are not even
--                         examined, so push is never starved behind waiting SMS.
-- Only `queued` rows are ever claimed (FOR UPDATE SKIP LOCKED), so a row stuck in `sending` is
-- never re-sent. Per row, first match wins ("stays" = left queued, not returned):
--   SMS:  switch off → stays; past deadline → expired; re-addressed to the client's current
--         phone/locale; no phone → no_recipient; +30 landline → not_mobile; platform day/month
--         room used up → stays; then, except OTP: messaging_disabled (reminder/marketing),
--         import_reminders_off, suppressed (marketing or import), reminder inside quiet hours →
--         expired, manage-link row whose appointment is being changed → stays / no longer active
--         → superseded, OTP reserve → stays, monthly budget → budget_exceeded (reminder/marketing),
--         per-phone/per-business day caps → rate_limited (hits taken back).
--   push: switch off → stays; past deadline → expired; no recipient → no_recipient; no longer a
--         member → not_a_member; no device → no_subscription.
-- Counters (UTC day and month) are locked before choosing rows and grow by the SMS claimed, so
-- concurrent claimers serialise and cannot overshoot. Each manage-link SMS gets a NEW token,
-- returned raw only in its item; the row keeps the token's id, never the link.
-- ---------------------------------------------------------------------------------------------
create function private.claim_core(
  p_ids uuid[],
  p_limit integer,
  p_now timestamptz,
  out o_items jsonb,
  out o_examined integer
)
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_settings private.platform_settings%rowtype;
  v_ids_mode boolean := p_ids is not null;
  v_day timestamptz;
  v_month timestamptz;
  v_sent_today integer;
  v_sent_month integer;
  v_room integer;
  v_other_room integer;
  v_month_room integer;
  v_claimed integer := 0;
  v_candidates uuid[];
  v_id uuid;
  v_row public.messages_log%rowtype;
  v_business public.businesses%rowtype;
  v_appt_source text;
  v_appt_starts_at timestamptz;
  v_appt_status text;
  v_deadline timestamptz;
  v_client_phone text;
  v_client_locale text;
  v_client_erased_at timestamptz;
  v_to text;
  v_stay boolean;
  v_cancel text;
  v_link boolean;
  v_spent bigint;
  v_phone_key text;
  v_phone_count integer;
  v_business_count integer;
  v_lease uuid;
  v_token_id uuid;
  v_token text;
  v_item jsonb;
begin
  o_items := '[]'::jsonb;
  o_examined := 0;
  if p_now is null then
    raise exception 'p_now is required' using errcode = '22023';
  end if;

  select * into v_settings from private.platform_settings where id;
  if not found then
    return;
  end if;

  v_day := date_trunc('day', p_now, 'UTC');
  v_month := date_trunc('month', p_now, 'UTC');

  -- lock (and create) this day's and this month's platform counters before choosing rows
  insert into public.rate_limits as r (bucket, key, window_start, count)
  values ('sms_platform_day', 'platform', v_day, 0)
  on conflict (bucket, key, window_start) do update set count = r.count
  returning r.count into v_sent_today;
  insert into public.rate_limits as r (bucket, key, window_start, count)
  values ('sms_platform_month', 'platform', v_month, 0)
  on conflict (bucket, key, window_start) do update set count = r.count
  returning r.count into v_sent_month;

  v_room := greatest(v_settings.sms_daily_cap - v_sent_today, 0);
  v_other_room := greatest(
    v_settings.sms_daily_cap - (v_settings.sms_daily_cap * v_settings.sms_otp_reserve_pct) / 100 - v_sent_today,
    0
  );
  v_month_room := greatest(v_settings.sms_monthly_cap - v_sent_month, 0);

  if v_ids_mode then
    select coalesce(array_agg(x.id order by x.created_at, x.id), '{}'::uuid[]) into v_candidates
    from (
      select m.id, m.created_at
      from public.messages_log m
      where m.id = any (p_ids)
        and m.status = 'queued'
        and m.scheduled_for <= p_now
      order by m.created_at, m.id
      for update skip locked
    ) x;
  else
    if p_limit is null or p_limit not between 1 and 50 then
      raise exception 'p_limit must be between 1 and 50' using errcode = '22023';
    end if;
    select coalesce(array_agg(x.id order by x.scheduled_for, x.created_at, x.id), '{}'::uuid[]) into v_candidates
    from (
      select m.id, m.scheduled_for, m.created_at
      from public.messages_log m
      where m.status = 'queued'
        and m.scheduled_for <= p_now
        and m.template <> 'otp'
        and (m.channel <> 'sms' or (v_settings.sms_enabled and v_other_room > 0 and v_month_room > 0))
        and (m.channel <> 'push' or v_settings.push_enabled)
      order by m.scheduled_for, m.created_at, m.id
      limit p_limit
      for update skip locked
    ) x;
  end if;

  foreach v_id in array v_candidates loop
    o_examined := o_examined + 1;
    select m.* into v_row from public.messages_log m where m.id = v_id;
    select b.* into v_business from public.businesses b where b.id = v_row.business_id;
    v_appt_source := null;
    v_appt_starts_at := null;
    if v_row.appointment_id is not null then
      select a.source, a.starts_at into v_appt_source, v_appt_starts_at
      from public.appointments a
      where a.business_id = v_row.business_id and a.id = v_row.appointment_id;
    end if;
    v_deadline := private.message_deadline(v_row.template, v_row.scheduled_for, v_appt_starts_at);
    v_stay := false;
    v_cancel := null;
    v_link := v_row.template in ('booking_confirmed', 'reminder', 'rescheduled_by_client', 'rescheduled_by_business');

    <<rules>>
    begin
      if v_row.channel = 'push' then
        if not v_settings.push_enabled then
          v_stay := true;
        elsif v_deadline is not null and p_now >= v_deadline then
          v_cancel := 'expired';
        elsif v_row.recipient_user_id is null then
          v_cancel := 'no_recipient';
        elsif not exists (
          select 1 from public.business_members bm
          where bm.business_id = v_row.business_id and bm.user_id = v_row.recipient_user_id
        ) then
          v_cancel := 'not_a_member';
        elsif not exists (
          select 1 from public.push_subscriptions s where s.user_id = v_row.recipient_user_id
        ) then
          v_cancel := 'no_subscription';
        end if;
        exit rules;
      end if;

      -- SMS 1. kill switch
      if not v_settings.sms_enabled then
        v_stay := true;
        exit rules;
      end if;
      -- 2. deadline
      if v_deadline is not null and p_now >= v_deadline then
        v_cancel := 'expired';
        exit rules;
      end if;
      -- 3. the client's current phone and language (a corrected typo wins; erased → none)
      if v_row.client_id is not null then
        v_client_phone := null;
        v_client_locale := null;
        v_client_erased_at := null;
        select c.phone_e164, c.locale, c.erased_at
          into v_client_phone, v_client_locale, v_client_erased_at
        from public.clients c
        where c.business_id = v_row.business_id and c.id = v_row.client_id;
        v_to := case when v_client_erased_at is null then v_client_phone end;
        if v_to is distinct from v_row.to_e164 or coalesce(v_client_locale, v_row.locale) <> v_row.locale then
          update public.messages_log m
          set to_e164 = v_to, locale = coalesce(v_client_locale, m.locale), updated_at = p_now
          where m.id = v_row.id
          returning m.* into v_row;
        end if;
      end if;
      -- 4. 5.
      if v_row.to_e164 is null then
        v_cancel := 'no_recipient';
        exit rules;
      end if;
      if not private.sms_reachable(v_row.to_e164) then
        v_cancel := 'not_mobile';
        exit rules;
      end if;
      -- 6. platform day and month room
      if v_claimed >= v_room or v_claimed >= v_month_room then
        v_stay := true;
        exit rules;
      end if;
      if v_row.category = 'otp' then
        exit rules;
      end if;
      -- 7a. the business switched its reminders/marketing off
      if v_row.category in ('reminder', 'marketing') and not v_business.messaging_enabled then
        v_cancel := 'messaging_disabled';
        exit rules;
      end if;
      -- 7b. reminders of imported appointments only when Anaklo is the designated sender
      if v_row.category = 'reminder' and v_appt_source = 'import' and not v_business.import_reminders then
        v_cancel := 'import_reminders_off';
        exit rules;
      end if;
      -- 7c. suppression cuts marketing and messages of imported appointments only
      if (v_row.category = 'marketing' or v_appt_source = 'import')
         and exists (
           select 1 from public.suppression_list s
           where s.business_id = v_row.business_id and s.phone_hmac = private.phone_hmac(v_row.to_e164)
         ) then
        v_cancel := 'suppressed';
        exit rules;
      end if;
      -- 7d. a reminder never goes out during the quiet hours
      if v_row.category = 'reminder'
         and private.in_quiet_hours(p_now, v_business.timezone, v_business.quiet_start, v_business.quiet_end) then
        v_cancel := 'expired';
        exit rules;
      end if;
      -- 7e. a manage link only for an appointment that is active and not being changed right now
      --     (FOR SHARE SKIP LOCKED: a cancel/move in flight is never waited on nor overtaken)
      if v_link then
        v_appt_status := null;
        if v_row.appointment_id is not null then
          select a.status into v_appt_status
          from public.appointments a
          where a.business_id = v_row.business_id and a.id = v_row.appointment_id
          for share skip locked;
          if not found then
            v_stay := true;
            exit rules;
          end if;
        end if;
        if v_appt_status is null or v_appt_status not in ('booked', 'confirmed') then
          v_cancel := 'superseded';
          exit rules;
        end if;
      end if;
      -- 7f. the OTP reserve of the platform day
      if v_claimed >= v_other_room then
        v_stay := true;
        exit rules;
      end if;
      -- 7g. the business's monthly budget stops reminders and marketing only
      if v_row.category in ('reminder', 'marketing') and v_business.sms_monthly_budget_cents is not null then
        select coalesce(sum(coalesce(
                 m.cost_cents,
                 case when m.status in ('sending', 'sent', 'delivered', 'unknown')
                      then coalesce(m.segments, 1) * v_settings.sms_unit_cost_cents
                      else 0 end
               )), 0)
          into v_spent
        from public.messages_log m
        where m.business_id = v_row.business_id
          and m.channel = 'sms'
          and m.created_at >= v_month
          and m.created_at < v_month + interval '1 month';
        if v_spent + v_settings.sms_unit_cost_cents > v_business.sms_monthly_budget_cents then
          v_cancel := 'budget_exceeded';
          exit rules;
        end if;
      end if;
      -- 7h. per recipient phone (every business) and per business, per UTC day
      v_phone_key := private.phone_hmac(v_row.to_e164);
      v_phone_count := private.rate_limit_hit('sms_phone_day', v_phone_key, v_day);
      v_business_count := private.rate_limit_hit('sms_business_day', v_row.business_id::text, v_day);
      if v_phone_count > v_settings.sms_per_phone_day
         or v_business_count > least(v_settings.sms_per_business_day, v_business.sms_daily_cap) then
        -- a refused row is not a send: take both hits back
        update public.rate_limits r
        set count = r.count - 1
        where r.window_start = v_day
          and ((r.bucket = 'sms_phone_day' and r.key = v_phone_key)
               or (r.bucket = 'sms_business_day' and r.key = v_row.business_id::text));
        v_cancel := 'rate_limited';
        exit rules;
      end if;
    end;

    if v_stay then
      continue;
    end if;
    if v_cancel is not null then
      update public.messages_log m
      set status = 'cancelled', error = v_cancel, updated_at = p_now
      where m.id = v_row.id;
      continue;
    end if;

    -- 8. claim
    v_lease := gen_random_uuid();
    v_token_id := null;
    v_token := null;
    if v_row.channel = 'sms' and v_link then
      select t.o_token_id, t.o_token into v_token_id, v_token
      from private.issue_booking_token(v_row.business_id, v_row.appointment_id, 'message', p_now) t;
    end if;

    update public.messages_log m
    set status = 'sending',
        attempts = m.attempts + 1,
        lease_id = v_lease,
        lease_until = p_now + interval '60 seconds',
        booking_token_id = coalesce(v_token_id, m.booking_token_id),
        updated_at = p_now
    where m.id = v_row.id;
    if v_row.channel = 'sms' then
      v_claimed := v_claimed + 1;
    end if;

    select jsonb_build_object(
             'id', v_row.id,
             'lease_id', v_lease,
             'channel', v_row.channel,
             'template', v_row.template,
             'category', v_row.category,
             'locale', v_row.locale,
             'business_name', v_business.name,
             'short_code', v_business.short_code,
             'timezone', v_business.timezone,
             'starts_at', a.starts_at,
             'staff_name', st.display_name,
             'to_e164', case when v_row.channel = 'sms' then v_row.to_e164 end,
             'manage_token', v_token,
             'client_first_name', case when v_row.channel = 'push' and c.erased_at is null
                                       then nullif(split_part(btrim(c.full_name), ' ', 1), '') end,
             'service_name', case when v_row.channel = 'push' then (
                               select s.name
                               from public.appointment_services l
                               join public.services s on s.business_id = l.business_id and s.id = l.service_id
                               where l.business_id = a.business_id and l.appointment_id = a.id
                               order by l.position
                               limit 1) end,
             'push_targets', case when v_row.channel = 'push' then coalesce((
                               select jsonb_agg(
                                        case when ps.provider = 'onesignal'
                                             then jsonb_build_object('provider', 'onesignal', 'subscription_id', ps.subscription_id)
                                             else jsonb_build_object('provider', 'vapid', 'endpoint', ps.endpoint,
                                                                     'p256dh', ps.p256dh, 'auth_secret', ps.auth_secret)
                                        end
                                        order by ps.created_at, ps.id)
                               from public.push_subscriptions ps
                               where ps.user_id = v_row.recipient_user_id), '[]'::jsonb) end
           )
      into v_item
    from (select 1) as one
    left join public.appointments a on a.business_id = v_row.business_id and a.id = v_row.appointment_id
    left join public.staff st on st.business_id = a.business_id and st.id = a.staff_id
    left join public.clients c on c.business_id = a.business_id and c.id = a.client_id;
    o_items := o_items || jsonb_build_array(v_item);
  end loop;

  if v_claimed > 0 then
    update public.rate_limits r
    set count = r.count + v_claimed
    where r.key = 'platform'
      and ((r.bucket = 'sms_platform_day' and r.window_start = v_day)
           or (r.bucket = 'sms_platform_month' and r.window_start = v_month));
  end if;
end;
$$;

-- RPC: claim_messages (0005), new body: the rows named by the caller, both channels, OTP too.
create or replace function private.claim_messages_impl(p_ids uuid[], p_now timestamptz default now())
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_ids is null then
    return '[]'::jsonb;
  end if;
  return (select c.o_items from private.claim_core(p_ids, null, p_now) c);
end;
$$;

comment on function public.claim_messages(uuid[]) is
  'Sender only: leases the named queued rows (SMS and push, OTP included) and returns what rendering needs (a fresh manage token where the SMS links to it; the recipient''s devices for push).';

-- RPC: claim_due_messages: the dispatcher's batch of rows due now (never OTP).
create function private.claim_due_messages_impl(p_limit integer, p_now timestamptz default now())
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
  v_examined integer;
begin
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception 'p_limit must be between 1 and 50' using errcode = '22023';
  end if;
  select c.o_items, c.o_examined into v_items, v_examined from private.claim_core(null, p_limit, p_now) c;
  return jsonb_build_object('items', v_items, 'more', v_examined = p_limit);
end;
$$;

create function public.claim_due_messages(p_limit integer)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.claim_due_messages_impl(p_limit);
$$;

comment on function public.claim_due_messages(integer) is
  'Dispatcher only: leases up to p_limit (1–50) queued rows due now, never OTP. Returns {items, more}.';

-- ---------------------------------------------------------------------------------------------
-- RPC: record_send_result (0005), new body. The lease must be current, else false; the lease is
-- cleared.
--   sent     → sent (segments for SMS only, cost as reported)
--   rejected → cancelled with the code (recipient_not_allowed, not_subscribed, …)
--   unknown  → unknown: timeout, exception; never re-claimed (D22)
--   failed   → certainly not at the provider: re-queued after 5′ × attempts while attempts < 3,
--              the deadline allows it and it is not an OTP; else failed
-- ---------------------------------------------------------------------------------------------
create or replace function private.record_send_result_impl(
  p_id uuid,
  p_lease_id uuid,
  p_outcome text,
  p_provider text,
  p_provider_message_id text,
  p_segments integer,
  p_cost_cents integer,
  p_error text,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.messages_log%rowtype;
  v_starts_at timestamptz;
  v_deadline timestamptz;
  v_retry_at timestamptz;
begin
  if p_outcome is null or p_outcome not in ('sent', 'rejected', 'unknown', 'failed') then
    raise exception 'p_outcome must be sent, rejected, unknown or failed' using errcode = '22023';
  end if;

  select m.* into v_row
  from public.messages_log m
  where m.id = p_id and m.status = 'sending' and m.lease_id = p_lease_id
  for update;
  if not found then
    return false;
  end if;

  if p_outcome = 'sent' then
    update public.messages_log m
    set status = 'sent',
        sent_at = p_now,
        provider = left(p_provider, 40),
        provider_message_id = left(p_provider_message_id, 120),
        segments = case when m.channel = 'sms' then p_segments end,
        cost_cents = p_cost_cents,
        error = null,
        lease_id = null,
        lease_until = null,
        updated_at = p_now
    where m.id = v_row.id;
  elsif p_outcome = 'rejected' then
    update public.messages_log m
    set status = 'cancelled',
        provider = coalesce(left(p_provider, 40), m.provider),
        error = left(coalesce(p_error, 'rejected'), 200),
        lease_id = null,
        lease_until = null,
        updated_at = p_now
    where m.id = v_row.id;
  elsif p_outcome = 'unknown' then
    update public.messages_log m
    set status = 'unknown',
        provider = coalesce(left(p_provider, 40), m.provider),
        provider_message_id = coalesce(left(p_provider_message_id, 120), m.provider_message_id),
        error = left(coalesce(p_error, 'unknown'), 200),
        lease_id = null,
        lease_until = null,
        updated_at = p_now
    where m.id = v_row.id;
  else
    if v_row.appointment_id is not null then
      select a.starts_at into v_starts_at
      from public.appointments a
      where a.business_id = v_row.business_id and a.id = v_row.appointment_id;
    end if;
    v_deadline := private.message_deadline(v_row.template, v_row.scheduled_for, v_starts_at);
    v_retry_at := p_now + make_interval(mins => 5 * v_row.attempts);
    update public.messages_log m
    set status = case when v_row.template <> 'otp' and v_row.attempts < 3
                           and (v_deadline is null or v_retry_at < v_deadline)
                      then 'queued' else 'failed' end,
        scheduled_for = case when v_row.template <> 'otp' and v_row.attempts < 3
                                  and (v_deadline is null or v_retry_at < v_deadline)
                             then v_retry_at else m.scheduled_for end,
        provider = coalesce(left(p_provider, 40), m.provider),
        error = left(coalesce(p_error, 'failed'), 200),
        lease_id = null,
        lease_until = null,
        updated_at = p_now
    where m.id = v_row.id;
  end if;
  return true;
end;
$$;

comment on function public.record_send_result(uuid, uuid, text, text, text, integer, integer, text) is
  'Sender only: records the outcome of a leased send (sent | rejected | unknown | failed; failed may re-queue). False when the lease is not current.';

-- ---------------------------------------------------------------------------------------------
-- RPC: record_delivery_report (the 1.10 sms-dlr calls it). The SMS row of (provider, id):
--   delivered   from sent, unknown or failed → delivered
--   undelivered from sent or unknown → failed (final); from delivered → unchanged
-- Segments and cost are stored as reported. Never touches attempts, never re-queues.
-- ---------------------------------------------------------------------------------------------
create function private.record_delivery_report_impl(
  p_provider text,
  p_provider_message_id text,
  p_status text,
  p_segments integer,
  p_cost_cents integer,
  p_error text,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.messages_log%rowtype;
begin
  if p_status is null or p_status not in ('delivered', 'undelivered') then
    raise exception 'p_status must be delivered or undelivered' using errcode = '22023';
  end if;
  if (p_segments is not null and p_segments not between 1 and 10)
     or (p_cost_cents is not null and p_cost_cents < 0) then
    raise exception 'p_segments must be 1–10 and p_cost_cents ≥ 0' using errcode = '22023';
  end if;

  select m.* into v_row
  from public.messages_log m
  where m.provider = p_provider
    and m.provider_message_id = p_provider_message_id
    and m.channel = 'sms'
  for update;
  if not found then
    return false;
  end if;

  if p_status = 'delivered' and v_row.status in ('sent', 'unknown', 'failed') then
    update public.messages_log m
    set status = 'delivered',
        error = null,
        segments = coalesce(p_segments, m.segments),
        cost_cents = coalesce(p_cost_cents, m.cost_cents),
        updated_at = p_now
    where m.id = v_row.id;
    return true;
  end if;
  if p_status = 'undelivered' and v_row.status in ('sent', 'unknown') then
    update public.messages_log m
    set status = 'failed',
        error = left(coalesce(p_error, 'undelivered'), 200),
        segments = coalesce(p_segments, m.segments),
        cost_cents = coalesce(p_cost_cents, m.cost_cents),
        updated_at = p_now
    where m.id = v_row.id;
    return true;
  end if;
  return false;
end;
$$;

create function public.record_delivery_report(
  p_provider text,
  p_provider_message_id text,
  p_status text,
  p_segments integer,
  p_cost_cents integer,
  p_error text
)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_delivery_report_impl(
    p_provider, p_provider_message_id, p_status, p_segments, p_cost_cents, p_error
  );
$$;

comment on function public.record_delivery_report(text, text, text, integer, integer, text) is
  'SMS delivery report (1.10 sms-dlr): delivered | undelivered for the row of (provider, provider_message_id). False when not found or not applicable.';

-- ---------------------------------------------------------------------------------------------
-- RPC: record_dispatch_run: the heartbeat of the Edge Function dispatch (1.9 health reads it).
-- ok true stores no error; ok false stores the code (or 'failed').
-- ---------------------------------------------------------------------------------------------
create function private.record_dispatch_run_impl(
  p_started_at timestamptz,
  p_ok boolean,
  p_rows integer,
  p_error text,
  p_now timestamptz default now()
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_started_at is null
     or p_started_at < p_now - interval '15 minutes'
     or p_started_at > p_now + interval '1 minute'
     or p_ok is null
     or p_rows < 0 then
    raise exception 'invalid record_dispatch_run arguments' using errcode = '22023';
  end if;
  return private.record_job_run(
    'dispatch', p_started_at, p_ok, p_rows,
    case when p_ok then null else coalesce(nullif(p_error, ''), 'failed') end
  );
end;
$$;

create function public.record_dispatch_run(p_started_at timestamptz, p_ok boolean, p_rows integer, p_error text)
returns bigint
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_dispatch_run_impl(p_started_at, p_ok, p_rows, p_error);
$$;

comment on function public.record_dispatch_run(timestamptz, boolean, integer, text) is
  'Dispatcher only: one job_runs row (job dispatch) per run.';

-- ---------------------------------------------------------------------------------------------
-- RPC: register_push_subscription (ADR-0010 §7). The row always belongs to the caller
-- (auth.uid(), never an argument); a subscription registered by another user MOVES to the caller
-- (moved true: a shared phone belongs to whoever enabled it last). Members only.
-- ---------------------------------------------------------------------------------------------
create function private.register_push_subscription_impl(
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
  if not exists (select 1 from public.business_members m where m.user_id = v_uid) then
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

create function public.register_push_subscription(
  p_provider text,
  p_subscription_id text default null,
  p_endpoint text default null,
  p_p256dh text default null,
  p_auth text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.register_push_subscription_impl(p_provider, p_subscription_id, p_endpoint, p_p256dh, p_auth);
$$;

comment on function public.register_push_subscription(text, text, text, text, text) is
  'Pro app: this device''s push subscription now belongs to the caller. Returns {id, moved}.';

-- ---------------------------------------------------------------------------------------------
-- RPC: unregister_push_subscription: the caller's own rows only (another user's id → 0). No
-- membership needed (sign-out of a removed member). p_all → every row of the caller.
-- ---------------------------------------------------------------------------------------------
create function private.unregister_push_subscription_impl(
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

create function public.unregister_push_subscription(
  p_subscription_id text default null,
  p_endpoint text default null,
  p_all boolean default false
)
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.unregister_push_subscription_impl(p_subscription_id, p_endpoint, p_all);
$$;

comment on function public.unregister_push_subscription(text, text, boolean) is
  'Pro app: forgets the caller''s own subscription (or all of them with p_all). Returns the number of rows deleted.';

-- ---------------------------------------------------------------------------------------------
-- RPC: request_test_push: a test push to all of the caller's own devices, at most one per user
-- and minute (a second request in the same minute replays the first row).
-- ---------------------------------------------------------------------------------------------
create function private.request_test_push_impl(p_business_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_key text;
  v_id uuid;
  v_replayed boolean := false;
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if p_now is null then
    raise exception 'p_now is required' using errcode = '22023';
  end if;

  if not exists (select 1 from public.push_subscriptions s where s.user_id = v_uid) then
    return jsonb_build_object('message_id', null, 'queued', false, 'replayed', false, 'reason', 'no_subscription');
  end if;

  v_key := 'push_test:' || v_uid::text || ':' || floor(extract(epoch from p_now) / 60)::bigint::text;
  insert into public.messages_log (
    business_id, dedupe_key, channel, recipient_user_id, locale, template, category, scheduled_for
  )
  select p_business_id, v_key, 'push', v_uid, b.locale, 'push_test', 'transactional', p_now
  from public.businesses b
  where b.id = p_business_id
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  if v_id is null then
    select m.id into v_id from public.messages_log m where m.dedupe_key = v_key;
    v_replayed := true;
  end if;

  perform private.nudge_dispatch('test');

  return jsonb_build_object('message_id', v_id, 'queued', true, 'replayed', v_replayed, 'reason', null);
end;
$$;

create function public.request_test_push(p_business_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.request_test_push_impl(p_business_id);
$$;

comment on function public.request_test_push(uuid) is
  'Pro app: a test push to all of the caller''s devices (one per minute). Returns {message_id, queued, replayed, reason}.';

-- ---------------------------------------------------------------------------------------------
-- Jobs (SECURITY DEFINER, no grants: pg_cron runs them as postgres; tests call them). Every run
-- writes one job_runs row; an error rolls the run's work back and is recorded as its SQLSTATE,
-- and the call returns null.
-- ---------------------------------------------------------------------------------------------

-- Every 5′: (a) rows whose sender died (lease expired) → unknown, never re-sent (D23: its late
-- result is refused); (b) queued OTP rows whose challenge expired → cancelled 'expired'; (c) a
-- nudge of dispatch even with nothing due, so dispatch writes its own heartbeat (D25).
create function private.dispatch_sweep_impl(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_leases integer := 0;
  v_otps integer := 0;
  v_nudged boolean := false;
  v_error text;
begin
  begin
    if p_now is null then
      raise exception 'p_now is required' using errcode = '22023';
    end if;

    update public.messages_log m
    set status = 'unknown', error = 'lease_expired', lease_id = null, lease_until = null, updated_at = p_now
    where m.status = 'sending' and m.lease_until < p_now;
    get diagnostics v_leases = row_count;

    update public.messages_log m
    set status = 'cancelled', error = 'expired', updated_at = p_now
    from public.otp_challenges c
    where m.status = 'queued'
      and m.template = 'otp'
      and c.business_id = m.business_id
      and c.id = m.otp_challenge_id
      and c.expires_at <= p_now;
    get diagnostics v_otps = row_count;

    v_nudged := private.nudge_dispatch('sweep');
  exception when others then
    v_error := sqlstate;
  end;

  if v_error is not null then
    perform private.record_job_run('dispatch_sweep', v_started, false, null, v_error);
    return null;
  end if;
  perform private.record_job_run(
    'dispatch_sweep', v_started, v_nudged, v_leases + v_otps,
    case when not v_nudged then 'dispatch_not_configured' end
  );
  return v_leases + v_otps;
end;
$$;

-- Nightly retention (D26); returns the number of rows deleted.
create function private.purge_impl(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_total integer := 0;
  v_count integer;
  v_error text;
begin
  begin
    if p_now is null then
      raise exception 'p_now is required' using errcode = '22023';
    end if;

    -- 1. the outbox 12 months after the row's last instant (created, scheduled, sent), and never a
    --    row still waiting to be sent: a reminder of an appointment booked more than a year ahead,
    --    or a superseded one revived later, keeps its created_at but must still go out
    --    (created_at is the index-friendly lower bound: the greatest() is never below it)
    delete from public.messages_log m
    where m.created_at < p_now - interval '12 months'
      and greatest(m.created_at, m.scheduled_for, coalesce(m.sent_at, m.created_at)) < p_now - interval '12 months'
      and m.status not in ('queued', 'sending');
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;

    -- 2. OTP challenges 30 days after they (or their grant) expired, their messages first
    delete from public.messages_log m
    using public.otp_challenges c
    where c.business_id = m.business_id
      and c.id = m.otp_challenge_id
      and greatest(c.expires_at, coalesce(c.grant_expires_at, c.expires_at)) < p_now - interval '30 days';
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;

    delete from public.otp_challenges c
    where greatest(c.expires_at, coalesce(c.grant_expires_at, c.expires_at)) < p_now - interval '30 days';
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;

    -- 3. trusted devices 30 days after expiry or revocation
    delete from public.trusted_devices d
    where least(d.expires_at, coalesce(d.revoked_at, d.expires_at)) < p_now - interval '30 days';
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;

    -- 4. manage tokens 30 days after their effective end (expiry, revocation, appointment end
    --    + 30 days); the messages that used them keep their row, without the reference
    update public.messages_log m
    set booking_token_id = null
    from public.booking_tokens t
    join public.appointments a on a.business_id = t.business_id and a.id = t.appointment_id
    where t.business_id = m.business_id
      and t.id = m.booking_token_id
      and least(t.expires_at, coalesce(t.revoked_at, 'infinity'::timestamptz), a.ends_at + interval '30 days')
          < p_now - interval '30 days';

    delete from public.booking_tokens t
    using public.appointments a
    where a.business_id = t.business_id
      and a.id = t.appointment_id
      and least(t.expires_at, coalesce(t.revoked_at, 'infinity'::timestamptz), a.ends_at + interval '30 days')
          < p_now - interval '30 days';
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;

    -- 5. rate-limit windows: 2 days; the platform month counter until the month after next
    delete from public.rate_limits r
    where (r.bucket <> 'sms_platform_month' and r.window_start < p_now - interval '2 days')
       or (r.bucket = 'sms_platform_month'
           and r.window_start < date_trunc('month', p_now, 'UTC') - interval '1 month');
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;

    -- 6. private bookkeeping after 30 days
    delete from private.job_runs j where j.finished_at < p_now - interval '30 days';
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;

    delete from private.move_requests r where r.created_at < p_now - interval '30 days';
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;

    -- 7. pg_cron's own run history after 7 days
    delete from cron.job_run_details d where d.end_time < p_now - interval '7 days';
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
  exception when others then
    v_error := sqlstate;
  end;

  if v_error is not null then
    perform private.record_job_run('purge', v_started, false, null, v_error);
    return null;
  end if;
  perform private.record_job_run('purge', v_started, true, v_total);
  return v_total;
end;
$$;

-- cron.schedule upserts by name, so a reset rebuilds the jobs.
select cron.schedule('dispatch-sweep', '*/5 * * * *', $$select private.dispatch_sweep_impl()$$);
select cron.schedule('nightly-purge', '17 1 * * *', $$select private.purge_impl()$$);

-- ---------------------------------------------------------------------------------------------
-- Grants. EXECUTE on both the impl and its wrapper, only to the roles listed. claim_core, the
-- helpers, reminder_at, the planner, the jobs and the trigger function: nobody.
-- ---------------------------------------------------------------------------------------------
grant execute on function private.register_push_subscription_impl(text, text, text, text, text) to authenticated;
grant execute on function public.register_push_subscription(text, text, text, text, text) to authenticated;
grant execute on function private.unregister_push_subscription_impl(text, text, boolean) to authenticated;
grant execute on function public.unregister_push_subscription(text, text, boolean) to authenticated;
grant execute on function private.request_test_push_impl(uuid, timestamptz) to authenticated;
grant execute on function public.request_test_push(uuid) to authenticated;

grant execute on function private.claim_due_messages_impl(integer, timestamptz) to service_role;
grant execute on function public.claim_due_messages(integer) to service_role;
grant execute on function private.record_delivery_report_impl(text, text, text, integer, integer, text, timestamptz) to service_role;
grant execute on function public.record_delivery_report(text, text, text, integer, integer, text) to service_role;
grant execute on function private.record_dispatch_run_impl(timestamptz, boolean, integer, text, timestamptz) to service_role;
grant execute on function public.record_dispatch_run(timestamptz, boolean, integer, text) to service_role;
