-- seed.sql — LOCAL/DEV ONLY. 100% synthetic data for the fictional business "demo-barber".
-- Never put real client data here (CLAUDE.md > Git). Phone numbers use the reserved-looking
-- +30 6900 000 xxx range and are not meant to receive SMS.

do $$
declare
  v_business uuid := '00000000-0000-4000-8000-000000000001';
  v_tz text := 'Europe/Athens';
  v_nikos uuid := '00000000-0000-4000-8000-000000000101';
  v_alex uuid := '00000000-0000-4000-8000-000000000102';
  v_cat_hair uuid := '00000000-0000-4000-8000-000000000201';
  v_cat_beard uuid := '00000000-0000-4000-8000-000000000202';
  v_cut uuid := '00000000-0000-4000-8000-000000000301';
  v_cut_beard uuid := '00000000-0000-4000-8000-000000000302';
  v_beard uuid := '00000000-0000-4000-8000-000000000303';
  v_kids uuid := '00000000-0000-4000-8000-000000000304';
  v_day date;
  v_client uuid;
  v_i int;
begin
  -- Appointment writes must declare who acts (private.current_actor_type); the seed is the system.
  perform set_config('anaklo.actor_type', 'system', true);

  -- short_code 'demo01' = the /r/demo01 link of the local SMS and e2e (normally generated).
  insert into public.businesses (id, slug, short_code, name, vertical, timezone, phone_e164, booking_enabled, theme)
  values (
    v_business, 'demo-barber', 'demo01', 'Demo Barber', 'barber', v_tz, '+302610000000', true,
    '{"primary": "#C8A15A", "accent": "#1F1F1F", "surface": "dark", "radius": 16, "font": "manrope"}'
  );

  insert into public.staff (id, business_id, display_name, color, sort) values
    (v_nikos, v_business, 'Νίκος', '#C8A15A', 0),
    (v_alex, v_business, 'Άλεξ', '#4F7CAC', 1);

  insert into public.service_categories (id, business_id, name, sort) values
    (v_cat_hair, v_business, 'Μαλλιά', 0),
    (v_cat_beard, v_business, 'Γένια', 1);

  insert into public.services (id, business_id, category_id, name, duration_min, buffer_after_min, price_cents, sort) values
    (v_cut, v_business, v_cat_hair, 'Κούρεμα', 30, 5, 1300, 0),
    (v_cut_beard, v_business, v_cat_hair, 'Κούρεμα + γένια', 45, 5, 1800, 1),
    (v_beard, v_business, v_cat_beard, 'Γένια', 15, 0, 700, 2),
    (v_kids, v_business, v_cat_hair, 'Παιδικό κούρεμα', 20, 5, 1000, 3);

  insert into public.staff_services (business_id, staff_id, service_id, custom_duration_min)
  select v_business, s.id, sv.id, case when s.id = v_alex and sv.id = v_cut then 35 end
  from public.staff s cross join public.services sv
  where s.business_id = v_business and sv.business_id = v_business;

  -- Tuesday–Friday split shift, Saturday continuous (weekday: 0 = Sunday).
  insert into public.working_hours (business_id, staff_id, weekday, start_time, end_time)
  select v_business, s.id, d.weekday, d.start_time, d.end_time
  from public.staff s
  cross join (values
    (2, time '09:00', time '14:00'), (2, time '17:00', time '21:00'),
    (3, time '09:00', time '14:00'), (3, time '17:00', time '21:00'),
    (4, time '09:00', time '14:00'), (4, time '17:00', time '21:00'),
    (5, time '09:00', time '14:00'), (5, time '17:00', time '21:00'),
    (6, time '09:00', time '16:00')
  ) as d (weekday, start_time, end_time)
  where s.business_id = v_business;

  insert into public.schedule_exceptions (business_id, staff_id, local_date, kind, note) values
    (v_business, null, date '2026-10-28', 'closed', 'Αργία');

  -- Synthetic clients with visit histories of different rhythms, for the memory rules later.
  for v_i in 1..12 loop
    insert into public.clients (business_id, full_name, phone_e164, source)
    values (
      v_business,
      (array['Γιώργος Π.', 'Κώστας Μ.', 'Δημήτρης Α.', 'Νίκος Σ.', 'Γιάννης Κ.', 'Παναγιώτης Λ.',
             'Χρήστος Β.', 'Βασίλης Τ.', 'Θανάσης Ρ.', 'Μιχάλης Ζ.', 'Σπύρος Ε.', 'Άγγελος Φ.'])[v_i],
      '+306900000' || lpad(v_i::text, 3, '0'),
      'staff'
    )
    returning id into v_client;

    -- visits every (21 + 3*i) days going back, completed
    for v_day in
      select (current_date - (n * (21 + 3 * v_i)))::date
      from generate_series(1, 1 + (v_i % 6)) as n
    loop
      insert into public.appointments
        (business_id, client_id, staff_id, starts_at, ends_at, status, source, total_cents, charged_cents)
      values (
        v_business, v_client, case when v_i % 2 = 0 then v_nikos else v_alex end,
        -- each client has its own time of day, so same-day visits never overlap
        (v_day + time '09:00' + v_i * interval '25 minutes') at time zone v_tz,
        (v_day + time '09:30' + v_i * interval '25 minutes') at time zone v_tz,
        'booked', 'phone', 1300, null
      );
    end loop;
  end loop;

  -- Past appointments become completed through a valid transition (booked -> completed).
  update public.appointments
  set status = 'completed', charged_cents = total_cents
  where business_id = v_business and starts_at < now();

  -- A few upcoming bookings.
  insert into public.appointments (business_id, client_id, staff_id, starts_at, ends_at, status, source, verified_via, total_cents)
  select v_business, c.id, v_nikos,
         ((current_date + 2) + make_time(10 + row_number() over () :: int, 0, 0)) at time zone v_tz,
         ((current_date + 2) + make_time(10 + row_number() over () :: int, 30, 0)) at time zone v_tz,
         'booked', 'online', 'otp', 1300
  from (select id from public.clients where business_id = v_business order by created_at limit 3) c;

  -- A family sharing one mobile (e2e "κοινό κινητό"): Μάριος has the number of Γιώργος Π.
  -- (+306900000001). One second later, so the choice list is always Γιώργος, Μάριος.
  insert into public.clients (business_id, full_name, phone_e164, source, created_at)
  values (v_business, 'Μάριος Π.', '+306900000001', 'staff', now() + interval '1 second');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Vault keys of 0005 (OTP code HMAC, phone HMAC). LOCAL/DEV ONLY and not secret: created only
-- when absent, so a real key (secrets:dev, step 1.10) is never overwritten. secrets-plan.mjs
-- refuses these two values for a remote project.
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'otp_hmac_key') then
    perform vault.create_secret(
      'local-dev-only-otp-hmac-key-not-a-secret-01', 'otp_hmac_key', 'seed.sql (local dev only)'
    );
  end if;
  if not exists (select 1 from vault.secrets where name = 'phone_hmac_key') then
    perform vault.create_secret(
      'local-dev-only-phone-hmac-key-not-a-secret-1', 'phone_hmac_key', 'seed.sql (local dev only)'
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Where private.nudge_dispatch (0007) sends its nudge, and the shared secret dispatch checks.
-- UPSERTED (unlike the HMAC keys above: these may change freely). The URL is seen from INSIDE the
-- database container: `kong` is the network alias the Supabase CLI gives the API gateway on
-- supabase_network_<project_id>, on Docker Desktop and on Linux CI alike (never 127.0.0.1:54321,
-- never host.docker.internal). The secret equals DISPATCH_SECRET of .env.example (public, local
-- only); secrets:dev (1.10) writes the remote values and refuses this one.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  v_secret record;
begin
  for v_secret in
    select x.name, x.value
    from (values
      ('dispatch_url', 'http://kong:8000/functions/v1/dispatch'),
      ('dispatch_secret', 'local-dev-only-dispatch-secret-not-a-secret-01')
    ) as x (name, value)
  loop
    if exists (select 1 from vault.secrets s where s.name = v_secret.name) then
      perform vault.update_secret(
        (select s.id from vault.secrets s where s.name = v_secret.name),
        v_secret.value, v_secret.name, 'seed.sql (local dev only)'
      );
    else
      perform vault.create_secret(v_secret.value, v_secret.name, 'seed.sql (local dev only)');
    end if;
  end loop;
end;
$$;

-- Local e2e only: Playwright re-runs OTP starts and bookings from 127.0.0.1 with the same test
-- numbers, so the caps and the resend cooldown are relaxed here. pgTAP sets every
-- platform_settings column itself. A remote database needs the real values back after any reset
-- (step 1.10: defaults of 0005, sms_daily_cap = 30 on dev; fresh_totp_max_age_seconds = 300).
-- The fresh-code window is 10 s (plan 1.7), not 0: with 0 not even the retry right after the code
-- sheet would pass. The e2e helper waits until the session's code is older than 10 s before every
-- critical action, so the sheet always shows.
update private.platform_settings
set otp_per_phone_hour = 1000,
    otp_per_ip_hour = 1000,
    otp_per_business_day = 10000,
    sms_daily_cap = 100000,
    otp_resend_seconds = 0,
    sms_per_phone_day = 10000,
    sms_per_business_day = 100000,
    sms_monthly_cap = 1000000,
    fresh_totp_max_age_seconds = 10,
    updated_at = now()
where id;

-- ---------------------------------------------------------------------------------------------
-- Synthetic staff accounts for local sign-in and e2e (ADR-0009): email code only, no passwords.
-- Fixed UUIDs and *.test emails, shared with the e2e specs:
--   owner    ...a001  owner@demo-barber.test     owner,   staff Νίκος
--   manager  ...a002  manager@demo-barber.test   manager, no staff row
--   staff    ...a003  alex@demo-barber.test      staff,   staff Άλεξ
--   none     ...a004  nomember@demo-barber.test  no membership (the "no access" screen)
-- 1.7 (contract 1.7 §2.11): one user per e2e scenario and browser project, members of demo-barber
-- without a staff row. No factor is seeded for anyone (D16): owners and managers enrol their
-- authenticator on first sign-in (locally after every db:reset); the e2e enrol through the API.
--   ...a011  owner-setup-chrome@     owner    setup project, Chromium (storageState)
--   ...a012  owner-setup-webkit@     owner    setup project, WebKit
--   ...a013  owner-enroll-chrome@    owner    mfa-enroll.spec, Chromium
--   ...a014  owner-enroll-webkit@    owner    mfa-enroll.spec, WebKit
--   ...a015  owner-devices-chrome@   owner    mfa-devices.spec, Chromium
--   ...a016  owner-devices-webkit@   owner    mfa-devices.spec, WebKit
--   ...a017  manager-reset@          manager  mfa-reset.spec (Chromium only)
-- GoTrue scans the token columns as strings: they must be empty strings, not NULL, or sign-in
-- answers 500. Members write no appointments here, so no actor is declared.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  '00000000-0000-0000-0000-000000000000', s.id, 'authenticated', 'authenticated', s.email, '', now(),
  '', '', '', '',
  '', '', '', '',
  '{"provider": "email", "providers": ["email"]}', '{}', now(), now()
from (values
  ('00000000-0000-4000-8000-00000000a001'::uuid, 'owner@demo-barber.test'),
  ('00000000-0000-4000-8000-00000000a002'::uuid, 'manager@demo-barber.test'),
  ('00000000-0000-4000-8000-00000000a003'::uuid, 'alex@demo-barber.test'),
  ('00000000-0000-4000-8000-00000000a004'::uuid, 'nomember@demo-barber.test'),
  ('00000000-0000-4000-8000-00000000a011'::uuid, 'owner-setup-chrome@demo-barber.test'),
  ('00000000-0000-4000-8000-00000000a012'::uuid, 'owner-setup-webkit@demo-barber.test'),
  ('00000000-0000-4000-8000-00000000a013'::uuid, 'owner-enroll-chrome@demo-barber.test'),
  ('00000000-0000-4000-8000-00000000a014'::uuid, 'owner-enroll-webkit@demo-barber.test'),
  ('00000000-0000-4000-8000-00000000a015'::uuid, 'owner-devices-chrome@demo-barber.test'),
  ('00000000-0000-4000-8000-00000000a016'::uuid, 'owner-devices-webkit@demo-barber.test'),
  ('00000000-0000-4000-8000-00000000a017'::uuid, 'manager-reset@demo-barber.test')
) as s (id, email)
on conflict do nothing;

insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
select
  u.id::text, u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
  'email', now(), now()
from auth.users u
where u.email like '%@demo-barber.test'
on conflict do nothing;

insert into public.business_members (business_id, user_id, role, staff_id) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001', 'owner', '00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a002', 'manager', null),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a003', 'staff', '00000000-0000-4000-8000-000000000102'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a011', 'owner', null),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a012', 'owner', null),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a013', 'owner', null),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a014', 'owner', null),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a015', 'owner', null),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a016', 'owner', null),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a017', 'manager', null)
on conflict do nothing;

-- Synthetic push subscriptions (0007), so e2e can observe the fake pushes: nothing registers
-- through the UI without VITE_ONESIGNAL_APP_ID (until 1.10). Owner ...a001 (staff Νίκος) and staff
-- ...a003 (Άλεξ); the manager has none (the no_subscription path). Not real OneSignal ids.
insert into public.push_subscriptions (user_id, provider, subscription_id) values
  ('00000000-0000-4000-8000-00000000a001', 'onesignal', '00000000-0000-4000-8000-0000000f0001'),
  ('00000000-0000-4000-8000-00000000a003', 'onesignal', '00000000-0000-4000-8000-0000000f0003')
on conflict do nothing;
