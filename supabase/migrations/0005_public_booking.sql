-- 0005_public_booking.sql
-- Online booking end-to-end (SPEC §7, §8, §11, §12; ADR-0005/0006/0007/0008; Phase 1 plan step 1.3).
-- Contract: docs/plans/contracts/1.3-public-booking.md (§2 is this file).
--
--   businesses.short_code            the /r/<code> link (BEFORE INSERT trigger, never updatable by the app)
--   private.platform_settings        SMS kill switch and caps (singleton)
--   private.vertical_defaults        = packages/verticals/*.json (next-visit hint fallback)
--   otp_challenges, trusted_devices, booking_tokens, messages_log (outbox), rate_limits,
--   suppression_list                 RLS on, no policies, no grants: reachable only through RPCs
--   private.plan_messages_impl       planner v1 (same signature as 0004, new body)
--   private.next_visit_hint_impl     median revisit interval, else the vertical's default
--
-- API (thin SECURITY INVOKER wrappers in public, SECURITY DEFINER _impl in private):
--   service_role: otp_start, otp_verify, clients_for_phone, book_appointment, trusted_device_revoke,
--                 manage_view, manage_slots, manage_cancel, manage_reschedule, claim_messages,
--                 record_send_result  (called by the Edge Functions public-booking and manage)
--   anon + authenticated + service_role: public_slug_for_code
--
-- Secrets: no OTP code, grant, token or IP is stored in plaintext. OTP codes are HMAC-SHA256 with
-- the Vault key otp_hmac_key, bound to their challenge id. Phones (and IPs) in the verification,
-- limit and suppression tables are HMAC-SHA256 with the Vault key phone_hmac_key, which must never
-- rotate. Grants and tokens are sha256 (high entropy, no key). messages_log.to_e164 is the only
-- plaintext phone: the sender needs it (erase_client wipes it, 1.8). Every token is generated and
-- hashed here and handed to the caller exactly once.
--
-- Clock: every _impl takes p_now last (default now()) so pgTAP can move it; rows whose timing
-- rules read their own creation time (challenges, devices, tokens) store created_at = p_now.

-- ---------------------------------------------------------------------------------------------
-- Extensions (no-op on Supabase; Vault is preinstalled)
-- ---------------------------------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------------------------
-- Domain errors: AN010–AN020 join the 0004 list. The same list lives in
-- supabase/functions/_shared/errors.ts (errors.test.ts compares them). AN010–AN012 are emitted
-- by the Edge Function from otp_verify's result, never raised here, but the lists stay equal.
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
  end;
begin
  if v_name is null then
    raise exception 'unknown domain error code %', p_code using errcode = '22023';
  end if;
  raise exception using errcode = 'P0001', message = p_code, hint = v_name;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Crypto and Vault helpers (no grants: only definer code and tests, as postgres, call them)
-- ---------------------------------------------------------------------------------------------

-- A Vault secret by name. Missing or shorter than 32 characters → 55000, which the Edge Function
-- answers as 500 internal: a server without its keys must not run half-configured.
create function private.vault_secret(p_name text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_secret text;
begin
  select s.decrypted_secret into v_secret
  from vault.decrypted_secrets s
  where s.name = p_name;
  if v_secret is null or char_length(v_secret) < 32 then
    raise exception 'vault secret % is missing', p_name using errcode = '55000';
  end if;
  return v_secret;
end;
$$;

-- The only form in which a phone is stored in the verification, limit and suppression tables.
-- The key must NEVER rotate: suppressions and device bindings would silently stop matching.
create function private.phone_hmac(p_e164 text)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(
    extensions.hmac(
      convert_to(p_e164, 'UTF8'),
      convert_to(private.vault_secret('phone_hmac_key'), 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;

-- Rate-limit key of a client IP (same key as phones, separate namespace).
create function private.ip_hmac(p_ip text)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(
    extensions.hmac(
      convert_to('ip:' || p_ip, 'UTF8'),
      convert_to(private.vault_secret('phone_hmac_key'), 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;

-- An OTP code bound to its challenge: the same code of another challenge hashes differently.
create function private.otp_code_hmac(p_challenge_id uuid, p_code text)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(
    extensions.hmac(
      convert_to(p_challenge_id::text || ':' || p_code, 'UTF8'),
      convert_to(private.vault_secret('otp_hmac_key'), 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;

-- Grants and tokens carry ≥ 128 random bits, so a plain sha256 is enough (no key, no salt).
create function private.token_hash(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
$$;

-- Unpadded base64url of p_bytes random bytes: 32 → 43 characters, 16 → 22 characters.
create function private.new_token(p_bytes integer)
returns text
language sql
volatile
set search_path = ''
as $$
  select rtrim(translate(encode(extensions.gen_random_bytes(p_bytes), 'base64'), E'+/\n', '-_'), '=');
$$;

-- Six digits (4 random bytes mod 10^6; the bias is below 0.03%).
create function private.new_otp_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select lpad(
    ((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text,
    6, '0'
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- businesses.short_code: the /r/<code> link of the SMS that carry no manage token. Generated by
-- the database, never written by the app (no column grant to authenticated, like slug).
-- ---------------------------------------------------------------------------------------------
alter table public.businesses add column short_code text;

create function private.new_short_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_alphabet constant text := 'abcdefghijklmnopqrstuvwxyz0123456789';
  v_bytes bytea;
  v_code text;
begin
  for v_try in 1..10 loop
    v_bytes := extensions.gen_random_bytes(6);
    select string_agg(substr(v_alphabet, get_byte(v_bytes, i) % 36 + 1, 1), '' order by i)
      into v_code
    from generate_series(0, 5) as i;
    if not exists (select 1 from public.businesses b where b.short_code = v_code) then
      return v_code;
    end if;
  end loop;
  raise exception 'no unused short code after 10 tries' using errcode = '23505';
end;
$$;

-- Existing rows (a remote database may have them), one statement each so every new code sees
-- the ones before it.
do $$
declare
  v_id uuid;
begin
  for v_id in select b.id from public.businesses b where b.short_code is null order by b.created_at, b.id loop
    update public.businesses set short_code = private.new_short_code() where id = v_id;
  end loop;
end;
$$;

-- The '' default is a placeholder that the trigger below always replaces: it marks the column as
-- filled by the database, so the generated Insert type does not demand it (provisioning inserts
-- businesses through the typed client and never writes a code). A DEFAULT calling the generator
-- would run as the inserting role and need an EXECUTE grant.
alter table public.businesses
  alter column short_code set not null,
  alter column short_code set default '',
  add constraint businesses_short_code_format check (short_code ~ '^[a-z0-9]{6}$'),
  add constraint businesses_short_code_key unique (short_code);

-- Definer: provisioning inserts as service_role, which holds no EXECUTE on the generator.
create function private.set_business_short_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.short_code is null or new.short_code = '' then
    new.short_code := private.new_short_code();
  end if;
  return new;
end;
$$;

create trigger businesses_short_code
  before insert on public.businesses
  for each row execute function private.set_business_short_code();

-- ---------------------------------------------------------------------------------------------
-- Private settings (RLS on, no grants; read by definer code only)
-- ---------------------------------------------------------------------------------------------

-- Platform-wide SMS switches and caps. Rate-limit windows are fixed UTC hours/days (caps, not
-- user-visible rules). 1.7 adds fresh_totp_max_age_seconds here.
create table private.platform_settings (
  id boolean primary key default true
    constraint platform_settings_singleton check (id),
  -- kill switch: no OTP and no send at all
  sms_enabled boolean not null default true,
  -- every SMS the platform sends in one UTC day (counted at claim time)
  sms_daily_cap integer not null default 300
    constraint platform_settings_sms_daily_cap check (sms_daily_cap between 0 and 1000000),
  -- OTP starts per phone per UTC hour, across all businesses
  otp_per_phone_hour integer not null default 3
    constraint platform_settings_otp_per_phone_hour check (otp_per_phone_hour between 1 and 10000),
  otp_per_ip_hour integer not null default 10
    constraint platform_settings_otp_per_ip_hour check (otp_per_ip_hour between 1 and 10000),
  -- OTP starts per business per UTC day
  otp_per_business_day integer not null default 40
    constraint platform_settings_otp_per_business_day check (otp_per_business_day between 1 and 100000),
  -- minimum gap between two OTP starts of one phone at one business (AN019)
  otp_resend_seconds integer not null default 60
    constraint platform_settings_otp_resend_seconds check (otp_resend_seconds between 0 and 600),
  -- Every SMS that is not an OTP (confirmations, notices, reminders), counted at claim time per
  -- UTC day: per recipient phone across all businesses, and per business. A client with a manage
  -- link or a trusted device can trigger them over and over (book, cancel, move); beyond a cap the
  -- row is cancelled ('rate_limited'), the action itself still succeeds.
  sms_per_phone_day integer not null default 10
    constraint platform_settings_sms_per_phone_day check (sms_per_phone_day between 1 and 10000),
  sms_per_business_day integer not null default 200
    constraint platform_settings_sms_per_business_day check (sms_per_business_day between 1 and 1000000),
  -- The last share of sms_daily_cap is for OTP only: other SMS stop (stay queued) earlier, so
  -- they can never starve verification.
  sms_otp_reserve_pct integer not null default 20
    constraint platform_settings_sms_otp_reserve_pct check (sms_otp_reserve_pct between 0 and 100),
  updated_at timestamptz not null default now()
);

comment on table private.platform_settings is
  'Singleton: SMS kill switch and caps. The local seed relaxes the limits; pgTAP sets its own.';

insert into private.platform_settings (id) values (true);

-- One row per vertical that has a packages/verticals/<vertical>.json (Vitest keeps them equal).
-- A vertical without a row gets no next-visit hint.
create table private.vertical_defaults (
  vertical text primary key
    constraint vertical_defaults_vertical check (vertical in ('barber', 'hair_salon', 'beauty')),
  rebook_interval_days smallint not null
    constraint vertical_defaults_rebook_interval_days check (rebook_interval_days between 7 and 365)
);

insert into private.vertical_defaults (vertical, rebook_interval_days) values
  ('barber', 28);

alter table private.platform_settings enable row level security;
alter table private.vertical_defaults enable row level security;
revoke all on table private.platform_settings from public, anon, authenticated, service_role;
revoke all on table private.vertical_defaults from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- otp_challenges: one per OTP start. The code exists in plaintext only in otp_start's answer.
-- A verified challenge carries the one-time grant (sha256) that book_appointment consumes.
-- ---------------------------------------------------------------------------------------------
create table public.otp_challenges (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  phone_hmac text not null constraint otp_challenges_phone_hmac check (phone_hmac ~ '^[0-9a-f]{64}$'),
  code_hmac text not null constraint otp_challenges_code_hmac check (code_hmac ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  -- wrong codes so far; at 5 the challenge is locked
  attempts smallint not null default 0 constraint otp_challenges_attempts check (attempts between 0 and 5),
  verified_at timestamptz,
  grant_hash text constraint otp_challenges_grant_hash check (grant_hash ~ '^[0-9a-f]{64}$'),
  grant_expires_at timestamptz,
  grant_used_at timestamptz,
  -- the booking that consumed the grant (a replay of that booking may present it again)
  grant_appointment_id uuid,
  created_at timestamptz not null default now(),
  constraint otp_challenges_business_id_key unique (business_id, id),
  constraint otp_challenges_grant_expiry check ((grant_hash is null) = (grant_expires_at is null)),
  constraint otp_challenges_grant_verified check (grant_hash is null or verified_at is not null),
  constraint otp_challenges_grant_used check (grant_used_at is null or grant_hash is not null),
  constraint otp_challenges_grant_appointment check ((grant_appointment_id is null) = (grant_used_at is null)),
  constraint otp_challenges_appointment_fk foreign key (business_id, grant_appointment_id)
    references public.appointments (business_id, id) on delete restrict
);

create index otp_challenges_phone_idx on public.otp_challenges (business_id, phone_hmac, created_at desc);
create unique index otp_challenges_grant_hash_key on public.otp_challenges (grant_hash) where grant_hash is not null;

comment on table public.otp_challenges is
  'OTP challenges (ADR-0006): code and phone as HMAC, grant as sha256. Only through RPCs.';

-- ---------------------------------------------------------------------------------------------
-- trusted_devices: a device that proved (business, phone) with an OTP. The raw token lives only
-- in the __Host-td_<business_id> cookie; 180 days fixed (= cookie Max-Age), revocable.
-- ---------------------------------------------------------------------------------------------
create table public.trusted_devices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  phone_hmac text not null constraint trusted_devices_phone_hmac check (phone_hmac ~ '^[0-9a-f]{64}$'),
  token_hash text not null
    constraint trusted_devices_token_hash check (token_hash ~ '^[0-9a-f]{64}$')
    constraint trusted_devices_token_hash_key unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint trusted_devices_business_id_key unique (business_id, id)
);

create index trusted_devices_phone_idx on public.trusted_devices (business_id, phone_hmac);

comment on table public.trusted_devices is
  'Trusted devices (ADR-0006): sha256 of the cookie token, bound to one business and one phone.';

-- ---------------------------------------------------------------------------------------------
-- booking_tokens: the manage link /m/<token>. Many live tokens per appointment (one per booking
-- answer and per message); never a plaintext token or link in any column. Valid while not
-- revoked, before expires_at (hard cap) and before the appointment's end + 30 days.
-- ---------------------------------------------------------------------------------------------
create table public.booking_tokens (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  appointment_id uuid not null,
  token_hash text not null
    constraint booking_tokens_token_hash check (token_hash ~ '^[0-9a-f]{64}$')
    constraint booking_tokens_token_hash_key unique,
  issued_for text not null constraint booking_tokens_issued_for check (issued_for in ('booking', 'message')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint booking_tokens_business_id_key unique (business_id, id),
  constraint booking_tokens_appointment_fk foreign key (business_id, appointment_id)
    references public.appointments (business_id, id) on delete restrict
);

create index booking_tokens_appointment_idx on public.booking_tokens (business_id, appointment_id);

comment on table public.booking_tokens is
  'Manage-link tokens (sha256). Several live per appointment; cancelling revokes them all.';

-- ---------------------------------------------------------------------------------------------
-- messages_log: the outbox. The planner and otp_start queue rows; claim_messages leases them to
-- the sender, record_send_result closes them. A row never holds a link, only booking_token_id.
-- ---------------------------------------------------------------------------------------------
create table public.messages_log (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  client_id uuid,
  appointment_id uuid,
  otp_challenge_id uuid,
  booking_token_id uuid,
  dedupe_key text not null
    constraint messages_log_dedupe_key_length check (char_length(dedupe_key) between 1 and 200)
    constraint messages_log_dedupe_key_key unique,
  channel text not null constraint messages_log_channel check (channel in ('sms', 'push')),
  -- nullable: erase_client wipes it (1.8); the claim then cancels the row
  to_e164 text constraint messages_log_to_e164 check (to_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- push recipient (1.5a)
  recipient_user_id uuid references auth.users (id) on delete set null,
  locale text not null constraint messages_log_locale check (locale in ('el', 'en')),
  template text not null constraint messages_log_template check (template in (
    'otp', 'booking_confirmed', 'reminder', 'cancelled_by_client', 'cancelled_by_business', 'rescheduled_by_client'
  )),
  category text not null constraint messages_log_category check (category in ('otp', 'transactional', 'reminder', 'marketing')),
  status text not null default 'queued' constraint messages_log_status check (status in (
    'queued', 'sending', 'sent', 'delivered', 'failed', 'cancelled', 'unknown'
  )),
  attempts smallint not null default 0 constraint messages_log_attempts check (attempts >= 0),
  lease_id uuid,
  lease_until timestamptz,
  scheduled_for timestamptz not null default now(),
  sent_at timestamptz,
  segments smallint constraint messages_log_segments check (segments between 1 and 10),
  cost_cents integer constraint messages_log_cost check (cost_cents >= 0),
  provider text constraint messages_log_provider_length check (char_length(provider) <= 40),
  provider_message_id text constraint messages_log_provider_message_id_length check (char_length(provider_message_id) <= 120),
  -- a code, never personal data
  error text constraint messages_log_error_length check (char_length(error) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint messages_log_sms_recipient check (channel = 'sms' or to_e164 is null),
  constraint messages_log_push_recipient check (channel = 'push' or recipient_user_id is null),
  constraint messages_log_lease check ((status = 'sending') = (lease_id is not null and lease_until is not null)),
  constraint messages_log_otp_template check ((category = 'otp') = (template = 'otp')),
  constraint messages_log_otp_challenge check ((category = 'otp') = (otp_challenge_id is not null)),
  constraint messages_log_client_fk foreign key (business_id, client_id)
    references public.clients (business_id, id) on delete restrict,
  constraint messages_log_appointment_fk foreign key (business_id, appointment_id)
    references public.appointments (business_id, id) on delete restrict,
  constraint messages_log_otp_challenge_fk foreign key (business_id, otp_challenge_id)
    references public.otp_challenges (business_id, id) on delete restrict,
  constraint messages_log_booking_token_fk foreign key (business_id, booking_token_id)
    references public.booking_tokens (business_id, id) on delete restrict
);

create index messages_log_queued_idx on public.messages_log (status, scheduled_for) where status = 'queued';
create index messages_log_appointment_idx on public.messages_log (business_id, appointment_id)
  where appointment_id is not null;
create index messages_log_business_created_idx on public.messages_log (business_id, created_at);
create index messages_log_otp_challenge_idx on public.messages_log (business_id, otp_challenge_id)
  where otp_challenge_id is not null;

comment on table public.messages_log is
  'Outbox (SPEC §12). OTP rows are sent only right after otp_start: their code is never stored.';

-- ---------------------------------------------------------------------------------------------
-- rate_limits: platform-wide counters per fixed UTC window (no business_id: the phone and IP
-- buckets span every business). Keys are HMACs, a business uuid or 'platform'.
-- ---------------------------------------------------------------------------------------------
create table public.rate_limits (
  bucket text not null constraint rate_limits_bucket check (bucket in (
    'otp_phone_hour', 'otp_ip_hour', 'otp_business_day', 'sms_platform_day', 'sms_phone_day', 'sms_business_day'
  )),
  key text not null constraint rate_limits_key_length check (char_length(key) between 1 and 80),
  window_start timestamptz not null,
  count integer not null default 0 constraint rate_limits_count check (count >= 0),
  primary key (bucket, key, window_start)
);

create index rate_limits_window_idx on public.rate_limits (window_start);

comment on table public.rate_limits is 'OTP and SMS counters per fixed UTC hour/day window.';

-- ---------------------------------------------------------------------------------------------
-- suppression_list: numbers that must not be messaged by a business. Written in 1.8 (erase) and
-- later (opt-out); read by the 1.5a claim. Nothing in 1.3 reads it.
-- ---------------------------------------------------------------------------------------------
create table public.suppression_list (
  business_id uuid not null references public.businesses (id) on delete restrict,
  phone_hmac text not null constraint suppression_list_phone_hmac check (phone_hmac ~ '^[0-9a-f]{64}$'),
  reason text not null constraint suppression_list_reason check (reason in ('erased', 'opted_out')),
  created_at timestamptz not null default now(),
  primary key (business_id, phone_hmac, reason)
);

comment on table public.suppression_list is 'Per-business suppressed phones (HMAC only).';

-- RLS on, no policies, no grants: every access goes through the definer RPCs below.
alter table public.otp_challenges enable row level security;
alter table public.trusted_devices enable row level security;
alter table public.booking_tokens enable row level security;
alter table public.messages_log enable row level security;
alter table public.rate_limits enable row level security;
alter table public.suppression_list enable row level security;

revoke all on table public.otp_challenges from public, anon, authenticated, service_role;
revoke all on table public.trusted_devices from public, anon, authenticated, service_role;
revoke all on table public.booking_tokens from public, anon, authenticated, service_role;
revoke all on table public.messages_log from public, anon, authenticated, service_role;
revoke all on table public.rate_limits from public, anon, authenticated, service_role;
revoke all on table public.suppression_list from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Internal helpers (no grants)
-- ---------------------------------------------------------------------------------------------

-- A trusted device is valid for (business, phone) while not revoked and not expired.
create function private.trusted_device_valid(
  p_business_id uuid,
  p_phone_hmac text,
  p_token text,
  p_now timestamptz
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_token is not null and exists (
    select 1 from public.trusted_devices d
    where d.business_id = p_business_id
      and d.phone_hmac = p_phone_hmac
      and d.token_hash = private.token_hash(p_token)
      and d.revoked_at is null
      and d.expires_at > p_now
  );
$$;

-- Which proof counts for (business, phone), §2.6.3: a live grant (unused, unexpired, of this
-- business and phone) → 'otp'; else a valid trusted device → 'trusted_device'; else AN014.
-- Reads only: the grant is consumed by book_appointment alone.
create function private.verified_via(
  p_business_id uuid,
  p_phone text,
  p_grant text,
  p_trusted_device_token text,
  p_now timestamptz
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_phone_hmac text := private.phone_hmac(p_phone);
begin
  if p_grant is not null and exists (
    select 1 from public.otp_challenges c
    where c.business_id = p_business_id
      and c.phone_hmac = v_phone_hmac
      and c.grant_hash = private.token_hash(p_grant)
      and c.grant_used_at is null
      and c.grant_expires_at > p_now
  ) then
    return 'otp';
  end if;
  if private.trusted_device_valid(p_business_id, v_phone_hmac, p_trusted_device_token, p_now) then
    return 'trusted_device';
  end if;
  perform private.raise_domain_error('AN014');
  return null;
end;
$$;

-- Counts one hit in a fixed window and returns the count including it. The upsert locks the
-- counter row, so concurrent callers of the same key serialise.
create function private.rate_limit_hit(p_bucket text, p_key text, p_window_start timestamptz)
returns integer
language sql
volatile
set search_path = ''
as $$
  insert into public.rate_limits as r (bucket, key, window_start, count)
  values (p_bucket, p_key, p_window_start, 1)
  on conflict (bucket, key, window_start) do update set count = r.count + 1
  returning r.count;
$$;

-- A new manage token for an appointment; the raw token is returned once and stored nowhere.
create function private.issue_booking_token(
  p_business_id uuid,
  p_appointment_id uuid,
  p_issued_for text,
  p_now timestamptz,
  out o_token_id uuid,
  out o_token text
)
language plpgsql
volatile
set search_path = ''
as $$
begin
  o_token := private.new_token(16);
  insert into public.booking_tokens (business_id, appointment_id, token_hash, issued_for, created_at, expires_at)
  values (p_business_id, p_appointment_id, private.token_hash(o_token), p_issued_for, p_now, p_now + interval '400 days')
  returning id into o_token_id;
end;
$$;

-- The SMS of an appointment still waiting to be sent: the caller sends them right after commit.
-- Returned on replays too, so a confirmation whose first send never ran is healed.
create function private.queued_sms_ids(p_business_id uuid, p_appointment_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(m.id order by m.created_at, m.id), '[]'::jsonb)
  from public.messages_log m
  where m.business_id = p_business_id
    and m.appointment_id = p_appointment_id
    and m.channel = 'sms'
    and m.status = 'queued';
$$;

-- The appointment behind a manage token (§2.6.5), or AN015. Never writes (no last_used_at).
create function private.manage_token_target(
  p_token text,
  p_now timestamptz,
  out o_business_id uuid,
  out o_appointment_id uuid
)
language plpgsql
stable
set search_path = ''
as $$
begin
  select t.business_id, t.appointment_id
    into o_business_id, o_appointment_id
  from public.booking_tokens t
  join public.appointments a on a.business_id = t.business_id and a.id = t.appointment_id
  where p_token is not null
    and t.token_hash = private.token_hash(p_token)
    and t.revoked_at is null
    and p_now < t.expires_at
    and p_now < a.ends_at + interval '30 days';
  if not found then
    perform private.raise_domain_error('AN015');
  end if;
end;
$$;

-- Last instant a client may cancel or move online (ADR-0006 §5): booked inside the notice window
-- → until the start; otherwise the notice, but never earlier than 60′ after booking and never
-- after the start.
create function private.change_until(p_created_at timestamptz, p_starts_at timestamptz, p_notice_min integer)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case
    when p_created_at > p_starts_at - make_interval(mins => p_notice_min) then p_starts_at
    else greatest(
      p_starts_at - make_interval(mins => p_notice_min),
      least(p_starts_at, p_created_at + interval '60 minutes')
    )
  end;
$$;

-- ---------------------------------------------------------------------------------------------
-- private.next_visit_hint_impl: "come back in about N weeks" (booking confirmation; Phase 2's
-- memory reuses it). Intervals = local days between consecutive completed visits of the same
-- (live, unmerged) client, counted on the later visit, when that visit starts in
-- (p_now - 365 days, p_now] and the interval is 7–180 days. ≥ 50 intervals → the business
-- median; else the vertical default; no vertical row → null. Keys are in the i18n namespace
-- `booking` (NEXT_VISIT_HINT_KEYS). Local calendar days, so the time of day and DST never push
-- a weekly rhythm below 7 days.
-- ---------------------------------------------------------------------------------------------
create function private.next_visit_hint_impl(p_business_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz text;
  v_vertical text;
  v_count integer;
  v_days double precision;
begin
  select b.timezone, b.vertical into v_tz, v_vertical from public.businesses b where b.id = p_business_id;
  if not found then
    return null;
  end if;

  with visits as (
    select a.starts_at,
           (a.starts_at at time zone v_tz)::date as local_date,
           lag((a.starts_at at time zone v_tz)::date) over (partition by a.client_id order by a.starts_at, a.id) as previous_date
    from public.appointments a
    join public.clients c on c.business_id = a.business_id and c.id = a.client_id
    where a.business_id = p_business_id
      and a.status = 'completed'
      and a.client_id is not null
      and c.erased_at is null
      and c.merged_into_id is null
  ),
  intervals as (
    select (v.local_date - v.previous_date) as days
    from visits v
    where v.previous_date is not null
      and v.starts_at > p_now - interval '365 days'
      and v.starts_at <= p_now
      and (v.local_date - v.previous_date) between 7 and 180
  )
  select count(*), percentile_cont(0.5) within group (order by i.days)
    into v_count, v_days
  from intervals i;

  if v_count >= 50 then
    return jsonb_build_object(
      'key', 'nextVisit.business',
      'weeks', least(52, greatest(1, round((v_days / 7.0)::numeric)))::integer
    );
  end if;

  select d.rebook_interval_days into v_days from private.vertical_defaults d where d.vertical = v_vertical;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'key', 'nextVisit.vertical',
    'weeks', least(52, greatest(1, round((v_days / 7.0)::numeric)))::integer
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- private.plan_messages_impl, body v1 (signature unchanged since 0004; 1.5a extends the body).
--   created   + source online              → booking_confirmed (always, ADR-0006 §5)
--   cancelled + actor client               → queued SMS of the appointment cancelled ('superseded')
--                                            + cancelled_by_client
--   moved     + actor client               → the same cancelling + rescheduled_by_client, one per
--                                            move (dedupe on the 'rescheduled' event)
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
  if p_change is null or p_change not in ('created', 'moved', 'cancelled') then
    raise exception 'p_change must be created, moved or cancelled' using errcode = '22023';
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
-- RPC: otp_start (§2.6.1). Checks in the contract's order; the counters are incremented before
-- their comparison (a refusal raises, so the whole call rolls back and nothing is written).
-- Never reads clients: the same answer for every number.
-- ---------------------------------------------------------------------------------------------
create function private.otp_start_impl(
  p_business_id uuid,
  p_phone text,
  p_locale text,
  p_service_ids uuid[],
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_ip text,
  p_code text default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_local_date date;
  v_settings private.platform_settings%rowtype;
  v_phone_hmac text;
  v_hour timestamptz := date_trunc('hour', p_now, 'UTC');
  v_day timestamptz := date_trunc('day', p_now, 'UTC');
  v_phone_count integer;
  v_ip_count integer;
  v_business_count integer;
  v_platform_count integer;
  v_challenge_id uuid := gen_random_uuid();
  v_code text;
  v_message_id uuid;
begin
  -- 1. bookable business
  select b.timezone into v_tz from public.businesses b where b.id = p_business_id and b.booking_enabled;
  if not found then
    perform private.raise_domain_error('AN009');
  end if;

  -- 2. arguments the schemas already exclude
  if p_phone is null or p_starts_at is null or p_locale is null or p_locale not in ('el', 'en')
     or (p_code is not null and p_code !~ '^[0-9]{6}$') then
    raise exception 'invalid otp_start arguments' using errcode = '22023';
  end if;

  -- 3. Greek mobiles only
  if p_phone !~ '^\+3069[0-9]{8}$' then
    perform private.raise_domain_error('AN018');
  end if;

  -- 4. the chosen slot is still free (AN003/AN008 propagate): no SMS for a slot that cannot be booked
  v_local_date := (p_starts_at at time zone v_tz)::date;
  if not exists (
    select 1
    from private.available_slots_impl(
      p_business_id, p_service_ids, p_staff_id, v_local_date, v_local_date, 'public', null, p_now
    ) s
    where s.starts_at = p_starts_at
  ) then
    perform private.raise_domain_error('AN001');
  end if;

  -- 5. kill switch
  select * into v_settings from private.platform_settings where id;
  if not found or not v_settings.sms_enabled then
    perform private.raise_domain_error('AN017');
  end if;

  -- One start per phone at a time (every business): the cooldown and the phone count are exact.
  v_phone_hmac := private.phone_hmac(p_phone);
  perform pg_advisory_xact_lock(hashtextextended('otp_start:' || v_phone_hmac, 0));

  -- 6. resend cooldown per (business, phone). 0 = no cooldown: otherwise a start that waited on the
  -- lock above would see the challenge committed meanwhile as newer than its own p_now.
  if v_settings.otp_resend_seconds > 0 and exists (
    select 1 from public.otp_challenges c
    where c.business_id = p_business_id
      and c.phone_hmac = v_phone_hmac
      and c.created_at > p_now - make_interval(secs => v_settings.otp_resend_seconds)
  ) then
    perform private.raise_domain_error('AN019');
  end if;

  -- 7–9. windows (fixed UTC). "count before this start ≥ limit" ⇔ "count with it > limit".
  v_phone_count := private.rate_limit_hit('otp_phone_hour', v_phone_hmac, v_hour);
  v_ip_count := private.rate_limit_hit('otp_ip_hour', private.ip_hmac(coalesce(p_ip, 'unknown')), v_hour);
  if v_phone_count > v_settings.otp_per_phone_hour or v_ip_count > v_settings.otp_per_ip_hour then
    perform private.raise_domain_error('AN013');
  end if;

  v_business_count := private.rate_limit_hit('otp_business_day', p_business_id::text, v_day);
  -- the platform counter counts real sends (claim_messages); read, never incremented here
  select coalesce(max(r.count), 0) into v_platform_count
  from public.rate_limits r
  where r.bucket = 'sms_platform_day' and r.key = 'platform' and r.window_start = v_day;
  if v_business_count > v_settings.otp_per_business_day or v_platform_count >= v_settings.sms_daily_cap then
    perform private.raise_domain_error('AN017');
  end if;

  -- 10. the challenge and its message
  v_code := coalesce(p_code, private.new_otp_code());
  insert into public.otp_challenges (id, business_id, phone_hmac, code_hmac, expires_at, created_at)
  values (
    v_challenge_id, p_business_id, v_phone_hmac, private.otp_code_hmac(v_challenge_id, v_code),
    p_now + interval '5 minutes', p_now
  );

  insert into public.messages_log (
    business_id, otp_challenge_id, dedupe_key, channel, to_e164, locale, template, category, scheduled_for
  )
  values (
    p_business_id, v_challenge_id, 'otp:' || v_challenge_id::text, 'sms', p_phone, p_locale, 'otp', 'otp', p_now
  )
  returning id into v_message_id;

  -- 11. the code leaves SQL only here
  return jsonb_build_object(
    'challenge_id', v_challenge_id,
    'message_id', v_message_id,
    'code', v_code,
    'expires_at', p_now + interval '5 minutes',
    'resend_at', p_now + make_interval(secs => v_settings.otp_resend_seconds)
  );
end;
$$;

create function public.otp_start(
  p_business_id uuid,
  p_phone text,
  p_locale text,
  p_service_ids uuid[],
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_ip text,
  p_code text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.otp_start_impl(
    p_business_id, p_phone, p_locale, p_service_ids, p_staff_id, p_starts_at, p_ip, p_code
  );
$$;

comment on function public.otp_start(uuid, text, text, uuid[], uuid, timestamptz, text, text) is
  'Edge Function only: rechecks the slot, applies the limits and queues an OTP SMS. Returns {challenge_id, message_id, code, expires_at, resend_at}.';

-- ---------------------------------------------------------------------------------------------
-- RPC: otp_verify (§2.6.2). Never raises for a code outcome, so every wrong guess commits.
-- ---------------------------------------------------------------------------------------------
create function private.otp_verify_impl(
  p_business_id uuid,
  p_phone text,
  p_challenge_id uuid,
  p_code text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_challenge public.otp_challenges%rowtype;
  v_attempts integer;
  v_grant text;
  v_device_token text;
begin
  if not exists (select 1 from public.businesses b where b.id = p_business_id and b.booking_enabled) then
    perform private.raise_domain_error('AN009');
  end if;

  -- Bound to business and phone: a challenge of another business or phone is simply not found.
  select c.* into v_challenge
  from public.otp_challenges c
  where c.id = p_challenge_id
    and c.business_id = p_business_id
    and c.phone_hmac = private.phone_hmac(p_phone)
  for update;

  if not found or v_challenge.verified_at is not null or v_challenge.expires_at <= p_now then
    return jsonb_build_object('result', 'expired');
  end if;
  if v_challenge.attempts >= 5 then
    return jsonb_build_object('result', 'locked');
  end if;

  if p_code is null or p_code !~ '^[0-9]{6}$'
     or private.otp_code_hmac(v_challenge.id, p_code) <> v_challenge.code_hmac then
    update public.otp_challenges c
    set attempts = c.attempts + 1
    where c.id = v_challenge.id
    returning c.attempts into v_attempts;
    if v_attempts >= 5 then
      return jsonb_build_object('result', 'locked');
    end if;
    return jsonb_build_object('result', 'invalid', 'attempts_left', 5 - v_attempts);
  end if;

  v_grant := private.new_token(32);
  v_device_token := private.new_token(32);

  update public.otp_challenges c
  set verified_at = p_now,
      grant_hash = private.token_hash(v_grant),
      grant_expires_at = p_now + interval '10 minutes'
  where c.id = v_challenge.id;

  insert into public.trusted_devices (business_id, phone_hmac, token_hash, created_at, expires_at)
  values (p_business_id, v_challenge.phone_hmac, private.token_hash(v_device_token), p_now, p_now + interval '180 days');

  return jsonb_build_object(
    'result', 'verified',
    'grant', v_grant,
    'grant_expires_at', p_now + interval '10 minutes',
    'trusted_device_token', v_device_token
  );
end;
$$;

create function public.otp_verify(p_business_id uuid, p_phone text, p_challenge_id uuid, p_code text)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.otp_verify_impl(p_business_id, p_phone, p_challenge_id, p_code);
$$;

comment on function public.otp_verify(uuid, text, uuid, text) is
  'Edge Function only: {result: verified, grant, grant_expires_at, trusted_device_token} | {result: invalid, attempts_left} | {result: expired} | {result: locked}.';

-- ---------------------------------------------------------------------------------------------
-- RPC: clients_for_phone (§2.6.3). Only after verification, first names only, never consumes the
-- grant. Several clients may share a phone (family): never a lookup that merges them.
-- ---------------------------------------------------------------------------------------------
create function private.clients_for_phone_impl(
  p_business_id uuid,
  p_phone text,
  p_grant text,
  p_trusted_device_token text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_via text;
begin
  if not exists (select 1 from public.businesses b where b.id = p_business_id and b.booking_enabled) then
    perform private.raise_domain_error('AN009');
  end if;

  v_via := private.verified_via(p_business_id, p_phone, p_grant, p_trusted_device_token, p_now);

  return jsonb_build_object(
    'verified_via', v_via,
    'clients', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'first_name', x.first_name) order by x.created_at, x.id)
      from (
        select c.id, c.created_at, split_part(btrim(c.full_name), ' ', 1) as first_name
        from public.clients c
        where c.business_id = p_business_id
          and c.phone_e164 = p_phone
          and c.erased_at is null
          and c.merged_into_id is null
        order by c.created_at, c.id
        limit 20
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

create function public.clients_for_phone(
  p_business_id uuid,
  p_phone text,
  p_grant text,
  p_trusted_device_token text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.clients_for_phone_impl(p_business_id, p_phone, p_grant, p_trusted_device_token);
$$;

comment on function public.clients_for_phone(uuid, text, text, text) is
  'Edge Function only: {verified_via, clients: [{id, first_name}]} for a verified phone (AN014 otherwise).';

-- ---------------------------------------------------------------------------------------------
-- RPC: book_appointment (§2.6.4), the online booking wrapper of book_core.
--   0. arguments; a per-key advisory lock BEFORE the idempotency lookup (concurrent retries
--      serialise; the second one replays instead of failing on the consumed grant);
--   1. replay: proof = the grant this booking consumed, or a live grant / valid device; book_core
--      with the ORIGINAL verified_via (same request hash) → replayed, or AN004; a new token only;
--   2. proof: a live grant (row-locked, consumed in step 4 together with the appointment id, as
--      the otp_challenges CHECKs require) → 'otp'; else a valid device → 'trusted_device'; else AN014;
--   3. book_core (actor client, recheck, planner 'created'); a failure rolls the grant back too;
--   4. OTP only: the grant is consumed; phone_verified_at in the same UPDATE as the phone;
--   5. marketing refusal box (shown only) → a soft_opt_in record when the answer changed;
--   6. a new manage token, the queued SMS ids, the next-visit hint.
-- ---------------------------------------------------------------------------------------------
create function private.book_appointment_impl(
  p_business_id uuid,
  p_idempotency_key uuid,
  p_service_ids uuid[],
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_phone text,
  p_client_id uuid,
  p_new_client jsonb,
  p_grant text,
  p_trusted_device_token text,
  p_marketing_box text,
  p_policy_version text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_new_client jsonb;
  v_existing public.appointments%rowtype;
  v_phone_hmac text;
  v_challenge_id uuid;
  v_via text;
  v_result jsonb;
  v_appointment_id uuid;
  v_client_id uuid;
  v_granted boolean;
  v_latest boolean;
  v_manage_token text;
begin
  if not exists (select 1 from public.businesses b where b.id = p_business_id and b.booking_enabled) then
    perform private.raise_domain_error('AN009');
  end if;

  -- 0.
  if p_idempotency_key is null
     or p_marketing_box is null
     or p_marketing_box not in ('not_shown', 'unchecked', 'checked')
     or (p_marketing_box <> 'not_shown'
         and (p_policy_version is null or char_length(p_policy_version) not between 1 and 40)) then
    raise exception 'invalid book_appointment arguments' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('book_appointment:' || p_business_id::text || ':' || p_idempotency_key::text, 0)
  );

  -- A new online client is a name and a language, nothing else (the phone is the verified one).
  if p_new_client is not null then
    v_new_client := jsonb_build_object(
      'full_name', p_new_client -> 'full_name',
      'locale', p_new_client -> 'locale'
    );
  end if;

  v_phone_hmac := private.phone_hmac(p_phone);

  select a.* into v_existing
  from public.appointments a
  where a.business_id = p_business_id and a.idempotency_key = p_idempotency_key;

  if found then
    -- 1. replay
    if not (p_grant is not null and exists (
      select 1 from public.otp_challenges c
      where c.business_id = p_business_id
        and c.phone_hmac = v_phone_hmac
        and c.grant_hash = private.token_hash(p_grant)
        and c.grant_appointment_id = v_existing.id
        and p_now < c.grant_expires_at
    )) then
      perform private.verified_via(p_business_id, p_phone, p_grant, p_trusted_device_token, p_now);
    end if;
    v_via := v_existing.verified_via;
    v_result := private.book_core(
      p_business_id, 'public', p_service_ids, p_staff_id, p_starts_at, p_client_id, v_new_client,
      'online', v_via, p_phone, p_idempotency_key, false, false, null, p_now
    );
    v_appointment_id := (v_result ->> 'appointment_id')::uuid;
  else
    -- 2. proof
    if p_grant is not null then
      select c.id into v_challenge_id
      from public.otp_challenges c
      where c.business_id = p_business_id
        and c.phone_hmac = v_phone_hmac
        and c.grant_hash = private.token_hash(p_grant)
        and c.grant_used_at is null
        and c.grant_expires_at > p_now
      for update;
    end if;
    if v_challenge_id is not null then
      v_via := 'otp';
    elsif private.trusted_device_valid(p_business_id, v_phone_hmac, p_trusted_device_token, p_now) then
      v_via := 'trusted_device';
    else
      perform private.raise_domain_error('AN014');
    end if;

    -- 3.
    v_result := private.book_core(
      p_business_id, 'public', p_service_ids, p_staff_id, p_starts_at, p_client_id, v_new_client,
      'online', v_via, p_phone, p_idempotency_key, false, false, null, p_now
    );
    v_appointment_id := (v_result ->> 'appointment_id')::uuid;

    select a.client_id into v_client_id
    from public.appointments a
    where a.business_id = p_business_id and a.id = v_appointment_id;

    -- 4.
    if v_via = 'otp' then
      update public.otp_challenges c
      set grant_used_at = p_now, grant_appointment_id = v_appointment_id
      where c.id = v_challenge_id;

      update public.clients c
      set phone_e164 = p_phone, phone_verified_at = p_now
      where c.business_id = p_business_id and c.id = v_client_id;
    end if;

    -- 5. `checked` = the client refused marketing; `unchecked` = shown and left alone.
    if p_marketing_box <> 'not_shown' then
      v_granted := p_marketing_box = 'unchecked';
      select cc.granted into v_latest
      from public.client_consents cc
      where cc.business_id = p_business_id
        and cc.client_id = v_client_id
        and cc.purpose = 'marketing_sms'
        and cc.withdrawn_at is null
      order by cc.created_at desc, cc.id desc
      limit 1;
      if v_latest is distinct from v_granted then
        insert into public.client_consents (
          business_id, client_id, purpose, legal_basis, granted, source, policy_version, given_by,
          created_by, created_at
        )
        values (
          p_business_id, v_client_id, 'marketing_sms', 'soft_opt_in', v_granted, 'booking_form',
          p_policy_version, 'client', null, p_now
        );
      end if;
    end if;
  end if;

  -- 6.
  select t.o_token into v_manage_token
  from private.issue_booking_token(p_business_id, v_appointment_id, 'booking', p_now) t;

  return jsonb_build_object(
    'appointment_id', v_result -> 'appointment_id',
    'staff_id', v_result -> 'staff_id',
    'starts_at', v_result -> 'starts_at',
    'ends_at', v_result -> 'ends_at',
    'total_cents', v_result -> 'total_cents',
    'replayed', v_result -> 'replayed',
    'verified_via', v_via,
    'manage_token', v_manage_token,
    'message_ids', private.queued_sms_ids(p_business_id, v_appointment_id),
    'next_visit_hint', private.next_visit_hint_impl(p_business_id, p_now)
  );
end;
$$;

create function public.book_appointment(
  p_business_id uuid,
  p_idempotency_key uuid,
  p_service_ids uuid[],
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_phone text,
  p_client_id uuid,
  p_new_client jsonb,
  p_grant text,
  p_trusted_device_token text,
  p_marketing_box text,
  p_policy_version text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.book_appointment_impl(
    p_business_id, p_idempotency_key, p_service_ids, p_staff_id, p_starts_at, p_phone, p_client_id,
    p_new_client, p_grant, p_trusted_device_token, p_marketing_box, p_policy_version
  );
$$;

comment on function public.book_appointment(uuid, uuid, uuid[], uuid, timestamptz, text, uuid, jsonb, text, text, text, text) is
  'Edge Function only: the online booking. Returns {appointment_id, staff_id, starts_at, ends_at, total_cents, replayed, verified_via, manage_token, message_ids, next_visit_hint}.';

-- ---------------------------------------------------------------------------------------------
-- RPC: trusted_device_revoke (§2.6.8): the client forgets this device. Silent when not live.
-- ---------------------------------------------------------------------------------------------
create function private.trusted_device_revoke_impl(
  p_business_id uuid,
  p_trusted_device_token text,
  p_now timestamptz default now()
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.trusted_devices d
  set revoked_at = p_now
  where d.business_id = p_business_id
    and d.token_hash = private.token_hash(p_trusted_device_token)
    and d.revoked_at is null
    and d.expires_at > p_now;
end;
$$;

create function public.trusted_device_revoke(p_business_id uuid, p_trusted_device_token text)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.trusted_device_revoke_impl(p_business_id, p_trusted_device_token);
$$;

comment on function public.trusted_device_revoke(uuid, text) is
  'Edge Function only: revokes the trusted device presented by the proxy (the client asked to forget it).';

-- ---------------------------------------------------------------------------------------------
-- RPC: manage_view (§2.6.6). Changes nothing; works while online booking is disabled. No client
-- data leaves: business, appointment, staff, services and the change window.
-- ---------------------------------------------------------------------------------------------
create function private.manage_view_impl(p_token text, p_now timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target record;
  v_appointment public.appointments%rowtype;
  v_business public.businesses%rowtype;
  v_until timestamptz;
  v_can_cancel boolean;
begin
  select * into v_target from private.manage_token_target(p_token, p_now);

  select a.* into v_appointment
  from public.appointments a
  where a.business_id = v_target.o_business_id and a.id = v_target.o_appointment_id;
  select b.* into v_business from public.businesses b where b.id = v_appointment.business_id;

  v_until := private.change_until(v_appointment.created_at, v_appointment.starts_at, v_business.cancel_min_notice_min);
  v_can_cancel := v_appointment.status in ('booked', 'confirmed') and p_now < v_until;

  return jsonb_build_object(
    'business', jsonb_build_object(
      'id', v_business.id, 'slug', v_business.slug, 'name', v_business.name,
      'timezone', v_business.timezone, 'locale', v_business.locale, 'currency', v_business.currency,
      'phone_e164', v_business.phone_e164, 'address', v_business.address,
      'maps_url', v_business.maps_url, 'theme', v_business.theme
    ),
    'appointment', jsonb_build_object(
      'id', v_appointment.id,
      'status', v_appointment.status,
      'starts_at', v_appointment.starts_at,
      'ends_at', v_appointment.ends_at,
      'total_cents', v_appointment.total_cents,
      'staff', (
        select jsonb_build_object('id', st.id, 'display_name', st.display_name)
        from public.staff st
        where st.business_id = v_appointment.business_id and st.id = v_appointment.staff_id
      ),
      'services', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', l.service_id, 'name', s.name,
                 'duration_min', l.duration_min, 'price_cents', l.price_cents
               ) order by l.position)
        from public.appointment_services l
        join public.services s on s.business_id = l.business_id and s.id = l.service_id
        where l.business_id = v_appointment.business_id and l.appointment_id = v_appointment.id
      ), '[]'::jsonb)
    ),
    'change_until', v_until,
    'can_cancel', v_can_cancel,
    'can_reschedule', v_can_cancel and v_business.booking_enabled
  );
end;
$$;

create function public.manage_view(p_token text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.manage_view_impl(p_token);
$$;

comment on function public.manage_view(text) is
  'Edge Function only: the appointment behind a manage link (AN015 when the link is no longer valid).';

-- ---------------------------------------------------------------------------------------------
-- RPC: manage_slots (§2.6.7): free starts for a reschedule, exactly as move_core will test them
-- (same services, same staff member, the booking's own length + buffer, itself excluded).
-- Empty when the appointment can no longer move by status or online booking is disabled.
-- ---------------------------------------------------------------------------------------------
create function private.manage_slots_impl(
  p_token text,
  p_from date,
  p_to date,
  p_now timestamptz default now()
)
returns table (starts_at timestamptz, local_date date, local_time time)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_target record;
  v_appointment public.appointments%rowtype;
  v_service_ids uuid[];
begin
  select * into v_target from private.manage_token_target(p_token, p_now);

  select a.* into v_appointment
  from public.appointments a
  where a.business_id = v_target.o_business_id and a.id = v_target.o_appointment_id;
  if v_appointment.status not in ('booked', 'confirmed') then
    return;
  end if;

  select array_agg(l.service_id order by l.position) into v_service_ids
  from public.appointment_services l
  where l.business_id = v_appointment.business_id and l.appointment_id = v_appointment.id;

  return query
    select s.starts_at, s.local_date, s.local_time
    from private.available_slots_core(
      v_appointment.business_id, v_service_ids, v_appointment.staff_id, p_from, p_to, 'public',
      v_appointment.id, p_now,
      (v_appointment.ends_at - v_appointment.starts_at) + make_interval(mins => v_appointment.buffer_after_min)
    ) s;
end;
$$;

create function public.manage_slots(p_token text, p_from date, p_to date)
returns table (starts_at timestamptz, local_date date, local_time time)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.manage_slots_impl(p_token, p_from, p_to);
$$;

comment on function public.manage_slots(text, date, date) is
  'Edge Function only: free starts (≤ 14 local dates) to which the appointment behind a manage link can move.';

-- ---------------------------------------------------------------------------------------------
-- RPC: manage_cancel (§2.6.7). Allowed while online booking is disabled. Revokes every token of
-- the appointment; the planner queues cancelled_by_client.
-- ---------------------------------------------------------------------------------------------
create function private.manage_cancel_impl(p_token text, p_now timestamptz default now())
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_target record;
  v_appointment public.appointments%rowtype;
  v_notice integer;
begin
  select * into v_target from private.manage_token_target(p_token, p_now);

  -- NO KEY UPDATE (as move_core): a cancel changes no key column, and the foreign-key check of a
  -- concurrent claim's new token (KEY SHARE) must not wait here while the planner below waits on
  -- that claim's message row (a lock cycle).
  select a.* into v_appointment
  from public.appointments a
  where a.business_id = v_target.o_business_id and a.id = v_target.o_appointment_id
  for no key update;
  select b.cancel_min_notice_min into v_notice from public.businesses b where b.id = v_appointment.business_id;

  if v_appointment.status not in ('booked', 'confirmed') then
    perform private.raise_domain_error('AN020');
  end if;
  if p_now >= private.change_until(v_appointment.created_at, v_appointment.starts_at, v_notice) then
    perform private.raise_domain_error('AN016');
  end if;

  perform set_config('anaklo.actor_type', 'client', true);

  update public.appointments a
  set status = 'cancelled', cancelled_by = 'client', cancel_reason = 'client_request'
  where a.business_id = v_appointment.business_id and a.id = v_appointment.id;

  update public.booking_tokens t
  set revoked_at = p_now
  where t.business_id = v_appointment.business_id
    and t.appointment_id = v_appointment.id
    and t.revoked_at is null;

  perform private.plan_messages_impl(v_appointment.id, 'cancelled');

  return jsonb_build_object(
    'appointment_id', v_appointment.id,
    'status', 'cancelled',
    'message_ids', private.queued_sms_ids(v_appointment.business_id, v_appointment.id)
  );
end;
$$;

create function public.manage_cancel(p_token text)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.manage_cancel_impl(p_token);
$$;

comment on function public.manage_cancel(text) is
  'Edge Function only: the client cancels through a manage link. Returns {appointment_id, status, message_ids}.';

-- ---------------------------------------------------------------------------------------------
-- RPC: manage_reschedule (§2.6.7). The notice rule is tested against the CURRENT time of the
-- appointment; move_core then keeps the id, the staff member and the booking's own length, writes
-- the 'rescheduled' event with actor client and plans rescheduled_by_client. Tokens stay live.
-- ---------------------------------------------------------------------------------------------
create function private.manage_reschedule_impl(
  p_token text,
  p_new_starts_at timestamptz,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_target record;
  v_appointment public.appointments%rowtype;
  v_notice integer;
  v_result jsonb;
begin
  select * into v_target from private.manage_token_target(p_token, p_now);

  -- NO KEY UPDATE, the same lock move_core takes (see manage_cancel_impl).
  select a.* into v_appointment
  from public.appointments a
  where a.business_id = v_target.o_business_id and a.id = v_target.o_appointment_id
  for no key update;
  select b.cancel_min_notice_min into v_notice from public.businesses b where b.id = v_appointment.business_id;

  if v_appointment.status not in ('booked', 'confirmed') then
    perform private.raise_domain_error('AN020');
  end if;
  if p_now >= private.change_until(v_appointment.created_at, v_appointment.starts_at, v_notice) then
    perform private.raise_domain_error('AN016');
  end if;

  v_result := private.move_core(
    v_appointment.business_id, v_appointment.id, p_new_starts_at, null, 'public', false, false, p_now
  );

  return jsonb_build_object(
    'appointment_id', v_result -> 'appointment_id',
    'staff_id', v_result -> 'staff_id',
    'starts_at', v_result -> 'starts_at',
    'ends_at', v_result -> 'ends_at',
    'message_ids', private.queued_sms_ids(v_appointment.business_id, v_appointment.id)
  );
end;
$$;

create function public.manage_reschedule(p_token text, p_new_starts_at timestamptz)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.manage_reschedule_impl(p_token, p_new_starts_at);
$$;

comment on function public.manage_reschedule(text, timestamptz) is
  'Edge Function only: the client moves the appointment behind a manage link. Returns {appointment_id, staff_id, starts_at, ends_at, message_ids}.';

-- ---------------------------------------------------------------------------------------------
-- RPC: public_slug_for_code (§2.6.8): /r/<code> → slug of a bookable business, else null.
-- p_now is unused; it is there only because every _impl ends with it (ADR-0005 pattern).
-- ---------------------------------------------------------------------------------------------
create function private.public_slug_for_code_impl(p_code text, p_now timestamptz default now())
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select b.slug from public.businesses b where b.short_code = lower(p_code) and b.booking_enabled;
$$;

create function public.public_slug_for_code(p_code text)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select private.public_slug_for_code_impl(p_code);
$$;

comment on function public.public_slug_for_code(text) is
  'Short link /r/<code>: the slug of a business whose online booking is enabled, else null.';

-- ---------------------------------------------------------------------------------------------
-- RPC: claim_messages (§2.6.9). Leases queued SMS rows to the caller (nothing while the kill
-- switch is off). Only `queued` rows are ever claimed; a row stuck in `sending` is never re-sent.
-- Caps per UTC day, counted here (real sends), never on a refused row:
--   · all SMS ≤ sms_daily_cap: the platform counter row is locked first and incremented by the
--     number claimed, so concurrent claimers serialise and cannot overshoot;
--   · SMS other than OTP stop sms_otp_reserve_pct earlier (they stay queued): whatever clients
--     trigger through a manage link or a trusted device can never starve verification;
--   · SMS other than OTP ≤ sms_per_phone_day to one phone (every business) and
--     ≤ sms_per_business_day per business; a row over either cap is cancelled ('rate_limited').
-- booking_confirmed / reminder / rescheduled_by_client need their appointment: the row is claimed
-- only while it is booked/confirmed (else cancelled 'superseded') and not being changed right now.
-- Its row is taken FOR SHARE SKIP LOCKED, so a cancel or move in flight (FOR NO KEY UPDATE) is
-- never waited on and never overtaken: the row stays queued for that change's planner. Each such
-- row gets a NEW manage token, returned raw only here; the row keeps its id, never the link.
-- ---------------------------------------------------------------------------------------------
create function private.claim_messages_impl(p_ids uuid[], p_now timestamptz default now())
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_settings private.platform_settings%rowtype;
  v_day timestamptz := date_trunc('day', p_now, 'UTC');
  v_sent_today integer;
  v_room integer;
  v_other_room integer;
  v_claimed integer := 0;
  v_row record;
  v_status text;
  v_phone_key text;
  v_phone_count integer;
  v_business_count integer;
  v_lease uuid;
  v_token_id uuid;
  v_token text;
  v_item jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  select * into v_settings from private.platform_settings where id;
  if not found or not v_settings.sms_enabled or p_ids is null then
    return v_out;
  end if;

  -- lock (and create) today's platform counter before choosing rows
  insert into public.rate_limits as r (bucket, key, window_start, count)
  values ('sms_platform_day', 'platform', v_day, 0)
  on conflict (bucket, key, window_start) do update set count = r.count
  returning r.count into v_sent_today;
  v_room := greatest(v_settings.sms_daily_cap - v_sent_today, 0);
  v_other_room := greatest(
    v_settings.sms_daily_cap - (v_settings.sms_daily_cap * v_settings.sms_otp_reserve_pct) / 100 - v_sent_today,
    0
  );

  for v_row in
    select m.id, m.business_id, m.appointment_id, m.to_e164, m.locale, m.template, m.category
    from public.messages_log m
    where m.id = any (p_ids)
      and m.status = 'queued'
      and m.channel = 'sms'
      and m.scheduled_for <= p_now
    order by m.created_at, m.id
    for update skip locked
  loop
    if v_row.to_e164 is null then
      update public.messages_log m
      set status = 'cancelled', error = 'no_recipient', updated_at = p_now
      where m.id = v_row.id;
      continue;
    end if;
    exit when v_claimed >= v_room;

    if v_row.category <> 'otp' then
      if v_row.template in ('booking_confirmed', 'reminder', 'rescheduled_by_client') then
        v_status := null;
        if v_row.appointment_id is not null then
          select a.status into v_status
          from public.appointments a
          where a.business_id = v_row.business_id and a.id = v_row.appointment_id
          for share skip locked;
          if not found then
            -- a cancel or move holds it right now: its planner decides about this row
            continue;
          end if;
        end if;
        if v_status is null or v_status not in ('booked', 'confirmed') then
          update public.messages_log m
          set status = 'cancelled', error = 'superseded', updated_at = p_now
          where m.id = v_row.id;
          continue;
        end if;
      end if;

      -- the OTP reserve: the row stays queued
      continue when v_claimed >= v_other_room;

      v_phone_key := private.phone_hmac(v_row.to_e164);
      v_phone_count := private.rate_limit_hit('sms_phone_day', v_phone_key, v_day);
      v_business_count := private.rate_limit_hit('sms_business_day', v_row.business_id::text, v_day);
      if v_phone_count > v_settings.sms_per_phone_day or v_business_count > v_settings.sms_per_business_day then
        -- a refused row is not a send: take both hits back
        update public.rate_limits r
        set count = r.count - 1
        where r.window_start = v_day
          and ((r.bucket = 'sms_phone_day' and r.key = v_phone_key)
               or (r.bucket = 'sms_business_day' and r.key = v_row.business_id::text));
        update public.messages_log m
        set status = 'cancelled', error = 'rate_limited', updated_at = p_now
        where m.id = v_row.id;
        continue;
      end if;
    end if;

    v_lease := gen_random_uuid();
    v_token_id := null;
    v_token := null;
    if v_row.template in ('booking_confirmed', 'reminder', 'rescheduled_by_client') then
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
    v_claimed := v_claimed + 1;

    select jsonb_build_object(
             'id', v_row.id,
             'lease_id', v_lease,
             'to_e164', v_row.to_e164,
             'locale', v_row.locale,
             'template', v_row.template,
             'category', v_row.category,
             'business_name', b.name,
             'short_code', b.short_code,
             'timezone', b.timezone,
             'starts_at', a.starts_at,
             'staff_name', st.display_name,
             'manage_token', v_token
           )
      into v_item
    from public.businesses b
    left join public.appointments a on a.business_id = b.id and a.id = v_row.appointment_id
    left join public.staff st on st.business_id = a.business_id and st.id = a.staff_id
    where b.id = v_row.business_id;
    v_out := v_out || jsonb_build_array(v_item);
  end loop;

  if v_claimed > 0 then
    update public.rate_limits r
    set count = r.count + v_claimed
    where r.bucket = 'sms_platform_day' and r.key = 'platform' and r.window_start = v_day;
  end if;

  return v_out;
end;
$$;

create function public.claim_messages(p_ids uuid[])
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.claim_messages_impl(p_ids);
$$;

comment on function public.claim_messages(uuid[]) is
  'Sender only: leases queued SMS rows and returns what rendering needs (with a fresh manage token where the template links to it).';

-- ---------------------------------------------------------------------------------------------
-- RPC: record_send_result (§2.6.9). Closes a leased row; false when the lease is not current.
-- sent → sent; failed → failed; rejected (e.g. recipient_not_allowed) → cancelled. No retry in 1.3.
-- ---------------------------------------------------------------------------------------------
create function private.record_send_result_impl(
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
begin
  if p_outcome is null or p_outcome not in ('sent', 'failed', 'rejected') then
    raise exception 'p_outcome must be sent, failed or rejected' using errcode = '22023';
  end if;

  update public.messages_log m
  set status = case p_outcome when 'sent' then 'sent' when 'failed' then 'failed' else 'cancelled' end,
      sent_at = case when p_outcome = 'sent' then p_now else m.sent_at end,
      provider = left(p_provider, 40),
      provider_message_id = case when p_outcome = 'sent' then left(p_provider_message_id, 120) else m.provider_message_id end,
      segments = case when p_outcome = 'sent' then p_segments else m.segments end,
      cost_cents = case when p_outcome = 'sent' then p_cost_cents else m.cost_cents end,
      error = case when p_outcome = 'sent' then null else left(coalesce(p_error, p_outcome), 200) end,
      lease_id = null,
      lease_until = null,
      updated_at = p_now
  where m.id = p_id
    and m.status = 'sending'
    and m.lease_id = p_lease_id;
  return found;
end;
$$;

create function public.record_send_result(
  p_id uuid,
  p_lease_id uuid,
  p_outcome text,
  p_provider text,
  p_provider_message_id text,
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
  select private.record_send_result_impl(
    p_id, p_lease_id, p_outcome, p_provider, p_provider_message_id, p_segments, p_cost_cents, p_error
  );
$$;

comment on function public.record_send_result(uuid, uuid, text, text, text, integer, integer, text) is
  'Sender only: records the outcome of a leased send (sent | failed | rejected). False when the lease is not current.';

-- ---------------------------------------------------------------------------------------------
-- Grants. EXECUTE on both the impl and its wrapper, only to the roles listed. Every helper,
-- trigger function, the planner, next_visit_hint_impl, book_core and move_core: nobody.
-- ---------------------------------------------------------------------------------------------
grant execute on function private.otp_start_impl(uuid, text, text, uuid[], uuid, timestamptz, text, text, timestamptz) to service_role;
grant execute on function public.otp_start(uuid, text, text, uuid[], uuid, timestamptz, text, text) to service_role;
grant execute on function private.otp_verify_impl(uuid, text, uuid, text, timestamptz) to service_role;
grant execute on function public.otp_verify(uuid, text, uuid, text) to service_role;
grant execute on function private.clients_for_phone_impl(uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.clients_for_phone(uuid, text, text, text) to service_role;
grant execute on function private.book_appointment_impl(uuid, uuid, uuid[], uuid, timestamptz, text, uuid, jsonb, text, text, text, text, timestamptz) to service_role;
grant execute on function public.book_appointment(uuid, uuid, uuid[], uuid, timestamptz, text, uuid, jsonb, text, text, text, text) to service_role;
grant execute on function private.trusted_device_revoke_impl(uuid, text, timestamptz) to service_role;
grant execute on function public.trusted_device_revoke(uuid, text) to service_role;
grant execute on function private.manage_view_impl(text, timestamptz) to service_role;
grant execute on function public.manage_view(text) to service_role;
grant execute on function private.manage_slots_impl(text, date, date, timestamptz) to service_role;
grant execute on function public.manage_slots(text, date, date) to service_role;
grant execute on function private.manage_cancel_impl(text, timestamptz) to service_role;
grant execute on function public.manage_cancel(text) to service_role;
grant execute on function private.manage_reschedule_impl(text, timestamptz, timestamptz) to service_role;
grant execute on function public.manage_reschedule(text, timestamptz) to service_role;
grant execute on function private.claim_messages_impl(uuid[], timestamptz) to service_role;
grant execute on function public.claim_messages(uuid[]) to service_role;
grant execute on function private.record_send_result_impl(uuid, uuid, text, text, text, integer, integer, text, timestamptz) to service_role;
grant execute on function public.record_send_result(uuid, uuid, text, text, text, integer, integer, text) to service_role;
grant execute on function private.public_slug_for_code_impl(text, timestamptz) to anon, authenticated, service_role;
grant execute on function public.public_slug_for_code(text) to anon, authenticated, service_role;
