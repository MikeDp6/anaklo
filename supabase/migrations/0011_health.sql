-- 0011_health.sql
-- Health of the cron jobs and detection of unauthorized changes of the authenticator devices
-- (SPEC §11, §12, §13; ADR-0009, ADR-0010; Phase 1 plan step 1.9).
-- Contract: docs/plans/contracts/1.9-health-detection.md (§2 is this file).
--
--   job_runs_job                      + 'detect_factor_changes'
--   messages_log                      + template 'push_security_alert' (no appointment, like push_test)
--   private.health_jobs               what health watches: threshold and since when (D2, D3)
--   private.mfa_factor_snapshot       the verified factors of owners/managers at the last detector run
--   private.security_events           an unauthorized add/remove of a factor, and the dispatcher's lease
--   private.health_impl               the stale checks (latest ok run per job, unfinished events)
--   private.detect_factor_changes_impl  pg_cron 'detect-factor-changes' every 5′, as the system: the
--                                     snapshot against auth.mfa_factors and private.factor_change_grants
--   private.queue_security_notifications  the owners' push rows and the email bundle of an event
--   private.purge_impl                + grants after 30 days, finished security events after 12 months
--
-- Review fixes (contract §8 «Review fixes»):
--   private.mfa_factor_accounted      factors a run accounted for that left the snapshot, or that were
--                                     verified and removed between two runs (never handled twice)
--   private.match_add_grants          THE add-grant rule: a grant covers a factor created in
--                                     [created_at, expires_at + 30 s] (never before the grant), the
--                                     earliest grant to the earliest factor; used by the detector and
--                                     by the fresh-code rule
--   private.unvetted_factors          a user's verified factors that no grant or snapshot vouches for
--   private.has_fresh_totp            (0009, replaced) a fresh code counts only when the session's
--                                     factor is vetted (auth.sessions: aal2, factor_id)
--   detect_factor_changes_impl        also the factors verified and removed between two runs, from
--                                     GoTrue's audit log (auth.audit_log_entries)
--
-- API (thin SECURITY INVOKER wrappers in public, SECURITY DEFINER _impl in private):
--   service_role: health, claim_security_events, record_security_event_result
--
-- The reaction (Edge Function dispatch): containment (delete an added factor, revoke the sessions)
-- is retried until it is done; the notifications (emails, owners' push) go at most once: they are
-- handed out only after 'contained' is recorded, and a lease lost while notifying ends the event
-- 'notify_unknown', never re-sent. Only the detector declares an actor (system); nothing here
-- writes appointments.

-- ---------------------------------------------------------------------------------------------
-- Value lists that grow (re-created under the same names; domain.ts carries the same lists)
-- ---------------------------------------------------------------------------------------------
alter table private.job_runs
  drop constraint job_runs_job,
  add constraint job_runs_job check (job in ('auto_complete', 'dispatch_sweep', 'dispatch', 'purge', 'detect_factor_changes'));

-- push_security_alert: to an owner, about an account, never about an appointment.
alter table public.messages_log
  drop constraint messages_log_template,
  add constraint messages_log_template check (template in (
    'otp', 'booking_confirmed', 'reminder', 'cancelled_by_client', 'cancelled_by_business',
    'rescheduled_by_client', 'rescheduled_by_business',
    'push_booking_created', 'push_booking_cancelled', 'push_booking_moved', 'push_test',
    'push_security_alert'
  )),
  drop constraint messages_log_push_appointment,
  add constraint messages_log_push_appointment check (
    channel = 'sms' or ((template in ('push_test', 'push_security_alert')) = (appointment_id is null))
  );

-- ---------------------------------------------------------------------------------------------
-- Schema. RLS on, no policy, no privilege for any API role: only definer code reaches them.
-- ---------------------------------------------------------------------------------------------

-- What health watches (D2, D3): a job is stale when its latest ok run (or, before its first one,
-- watched_since) is older than max_age_seconds. Three missed periods per job.
create table private.health_jobs (
  job text primary key
    constraint health_jobs_job check (job in ('auto_complete', 'dispatch_sweep', 'dispatch', 'purge', 'detect_factor_changes')),
  max_age_seconds integer not null constraint health_jobs_max_age check (max_age_seconds between 60 and 172800),
  watched_since timestamptz not null default now()
);

comment on table private.health_jobs is
  'The cron jobs health watches: staleness threshold and the instant watching began (a job that never ran is stale only after its threshold has passed since then).';

insert into private.health_jobs (job, max_age_seconds) values
  ('auto_complete', 1800),
  ('detect_factor_changes', 900),
  ('dispatch', 900),
  ('dispatch_sweep', 900),
  ('purge', 93600);

-- The verified factors of the users who are owner/manager somewhere, as the last detector run saw
-- them. No FK to auth.mfa_factors: a removed factor stays here until the next run diffs it.
-- Never the secret, the friendly name, the type or the phone of a factor.
create table private.mfa_factor_snapshot (
  factor_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  factor_created_at timestamptz not null,
  first_seen_at timestamptz not null,
  -- the p_now of the last run that saw it (the remove-grant window, D8)
  last_seen_at timestamptz not null
);

create index mfa_factor_snapshot_user_idx on private.mfa_factor_snapshot (user_id);

comment on table private.mfa_factor_snapshot is
  'Verified authenticator factors of owners/managers at the last run of private.detect_factor_changes_impl (ids and instants only).';

-- An unauthorized change of a user's factors and its handling by dispatch:
-- pending → containing (claim, lease 120 s) → notifying (contained, lease renewed) → done.
create table private.security_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null
    constraint security_events_kind check (kind in ('factor_added_unauthorized', 'factor_removed_unauthorized')),
  factor_id uuid not null,
  -- of the factor (added) / from the snapshot (removed)
  factor_created_at timestamptz not null,
  -- the user's owner/manager businesses at detection: owner first, then manager, each by membership
  business_ids uuid[] not null default '{}',
  detected_at timestamptz not null,
  status text not null default 'pending'
    constraint security_events_status check (status in ('pending', 'containing', 'notifying', 'done')),
  attempts smallint not null default 0 constraint security_events_attempts check (attempts between 0 and 10000),
  lease_id uuid,
  lease_until timestamptz,
  contained_at timestamptz,
  handled_at timestamptz,
  result text constraint security_events_result check (result in ('notified', 'notify_unknown')),
  emails_sent smallint constraint security_events_emails_sent check (emails_sent between 0 and 100),
  emails_failed smallint constraint security_events_emails_failed check (emails_failed between 0 and 100),
  push_queued smallint constraint security_events_push_queued check (push_queued between 0 and 100),
  -- a code, never personal data
  error text constraint security_events_error_length check (char_length(error) <= 200),
  -- one event per factor and kind
  constraint security_events_factor_key unique (kind, factor_id),
  constraint security_events_lease check (
    (status in ('containing', 'notifying')) = (lease_id is not null and lease_until is not null)
  ),
  constraint security_events_done check ((status = 'done') = (handled_at is not null and result is not null))
);

create index security_events_open_idx on private.security_events (detected_at) where status <> 'done';

comment on table private.security_events is
  'Unauthorized add/remove of an authenticator factor (detector) and its containment and notification (dispatch). No personal data beyond the user id.';

-- Review fix: every factor a run has accounted for is in the snapshot or here. A factor leaves the
-- snapshot into this table (removed, or out of scope); a factor verified and removed between two runs
-- (seen only in GoTrue's audit log) is handled once and recorded here. The detector never looks at a
-- factor of this table again. 30 days after accounted_at (the audit look-back is at most 7 days).
create table private.mfa_factor_accounted (
  factor_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  accounted_at timestamptz not null
);

create index mfa_factor_accounted_user_idx on private.mfa_factor_accounted (user_id);

comment on table private.mfa_factor_accounted is
  'Authenticator factors a detector run accounted for that are no longer in its snapshot (ids and an instant only).';

alter table private.health_jobs enable row level security;
alter table private.mfa_factor_snapshot enable row level security;
alter table private.security_events enable row level security;
alter table private.mfa_factor_accounted enable row level security;
revoke all on table private.health_jobs from public, anon, authenticated, service_role;
revoke all on table private.mfa_factor_snapshot from public, anon, authenticated, service_role;
revoke all on table private.security_events from public, anon, authenticated, service_role;
revoke all on table private.mfa_factor_accounted from public, anon, authenticated, service_role;

-- Pre-existing factors never raise an event: the snapshot starts from the current state.
insert into private.mfa_factor_snapshot (factor_id, user_id, factor_created_at, first_seen_at, last_seen_at)
select f.id, f.user_id, f.created_at, now(), now()
from auth.mfa_factors f
where f.status = 'verified'
  and exists (
    select 1 from public.business_members m
    where m.user_id = f.user_id and m.role in ('owner', 'manager')
  );

-- ---------------------------------------------------------------------------------------------
-- RPC: health (§2.4). One check per health_jobs row (age of the latest ok run) and one for the
-- oldest unfinished security event. Names, ages, thresholds and stale flags only: never counts,
-- ids, users or businesses. Exactly the threshold is fresh.
-- ---------------------------------------------------------------------------------------------
create function private.health_impl(p_now timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_checks jsonb;
begin
  if p_now is null then
    raise exception 'p_now is required' using errcode = '22023';
  end if;

  with jobs as (
    select h.job,
           h.max_age_seconds,
           h.watched_since,
           (select max(j.finished_at)
            from private.job_runs j
            where j.job = h.job and j.ok and j.finished_at <= p_now) as last_ok
    from private.health_jobs h
  ),
  events as (
    select min(e.detected_at) as oldest
    from private.security_events e
    where e.status <> 'done' and e.detected_at <= p_now
  ),
  checks as (
    select j.job as name,
           floor(extract(epoch from (p_now - j.last_ok)))::bigint as age_seconds,
           j.max_age_seconds,
           coalesce(j.last_ok, j.watched_since) < p_now - make_interval(secs => j.max_age_seconds) as stale
    from jobs j
    union all
    select 'security_events',
           floor(extract(epoch from (p_now - e.oldest)))::bigint,
           900,
           coalesce(e.oldest < p_now - interval '900 seconds', false)
    from events e
  )
  select jsonb_agg(
           jsonb_build_object(
             'name', c.name,
             'age_seconds', c.age_seconds,
             'max_age_seconds', c.max_age_seconds,
             'stale', c.stale
           )
           order by c.name collate "C"
         )
    into v_checks
  from checks c;

  v_checks := coalesce(v_checks, '[]'::jsonb);
  return jsonb_build_object(
    'ok', not exists (select 1 from jsonb_array_elements(v_checks) x where (x ->> 'stale')::boolean),
    'checks', v_checks
  );
end;
$$;

create function public.health()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.health_impl();
$$;

comment on function public.health() is
  'Edge Function health (service_role): {ok, checks[{name, age_seconds, max_age_seconds, stale}]} for the cron jobs and the unfinished security events.';

-- ---------------------------------------------------------------------------------------------
-- Vetted factors (review fixes, contract §8). THE add-grant rule, shared by the detector (which
-- consumes what it returns) and by the fresh-code rule (which only reads it): the factors, in
-- (created_at, id) order, each take the earliest (created_at, id) unmatched `add` grant of the same
-- user, not already taken by an earlier factor of the call, whose window holds the factor's
-- created_at: [grant created_at, expires_at + 30 s]. Never before the grant (a device enrolled first
-- and authorized afterwards, with a code from that very device, is not covered); the 30 s after the
-- expiry tolerate an Auth clock ahead of the database's. One row per factor, in that order;
-- m_grant_id null = no grant. Reads only.
-- ---------------------------------------------------------------------------------------------
create function private.match_add_grants(p_ids uuid[], p_users uuid[], p_created timestamptz[])
returns table (m_factor_id uuid, m_user_id uuid, m_created_at timestamptz, m_grant_id uuid)
language plpgsql
stable
set search_path = ''
as $$
declare
  v record;
  v_grant uuid;
  v_taken uuid[] := '{}';
begin
  for v in
    select c.id, c.user_id, c.created_at
    from unnest(p_ids, p_users, p_created) as c (id, user_id, created_at)
    where c.id is not null
    order by c.created_at, c.id
  loop
    -- no row → null
    select g.id into v_grant
    from private.factor_change_grants g
    where g.user_id = v.user_id
      and g.action = 'add'
      and g.matched_at is null
      and g.created_at <= v.created_at
      and v.created_at <= g.expires_at + interval '30 seconds'
      and not (g.id = any (v_taken))
    order by g.created_at, g.id
    limit 1;

    if v_grant is not null then
      v_taken := v_taken || v_grant;
    end if;
    m_factor_id := v.id;
    m_user_id := v.user_id;
    m_created_at := v.created_at;
    m_grant_id := v_grant;
    return next;
  end loop;
end;
$$;

-- A user's verified factors that nothing vouches for: flagged by the detector (a
-- factor_added_unauthorized event: dispatch deletes it), or not seen by a run yet (not in the snapshot)
-- and given no grant by private.match_add_grants. A factor in the snapshot without such an event was
-- vouched for by a run (a grant matched, or it predates 0011).
create function private.unvetted_factors(p_user_id uuid)
returns setof uuid
language sql
stable
set search_path = ''
as $$
  with verified as (
    select f.id, f.created_at,
           exists (select 1 from private.mfa_factor_snapshot s where s.factor_id = f.id) as seen
    from auth.mfa_factors f
    where f.user_id = p_user_id and f.status = 'verified'
  ),
  pending as (
    select coalesce(array_agg(v.id order by v.created_at, v.id), '{}'::uuid[]) as ids,
           coalesce(array_agg(p_user_id order by v.created_at, v.id), '{}'::uuid[]) as users,
           coalesce(array_agg(v.created_at order by v.created_at, v.id), '{}'::timestamptz[]) as created
    from verified v
    where not v.seen
  )
  select v.id
  from verified v
  where exists (
    select 1 from private.security_events e
    where e.factor_id = v.id and e.kind = 'factor_added_unauthorized'
  )
  union
  select m.m_factor_id
  from pending p
  cross join lateral private.match_add_grants(p.ids, p.users, p.created) m
  where m.m_grant_id is null;
$$;

-- The fresh-code rule (C6 of 0009), replaced (review fix): the newest `totp` entry of the JWT's amr
-- within the window, as before, AND the session that holds it still exists at aal2 with a vetted
-- factor. GoTrue sets auth.sessions.factor_id to the factor of the session's last verify (in the
-- transaction that stamps the amr entry) and drops the session to aal1 without a factor when that
-- factor is unenrolled. So a code from a device enrolled straight at GoTrue with a stolen aal2 session
-- (no grant) never counts, nor an access token kept after its factor was unenrolled or its session
-- revoked. A JWT without session_id keeps the 0009 behaviour: GoTrue always sets it, only the JWT
-- secret could mint a token without it (pgTAP's synthetic claims). Still the ONLY place of the rule
-- (rule 13); same signature, no grants.
create or replace function private.has_fresh_totp()
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_claims jsonb := auth.jwt();
  v_window integer;
  v_at numeric;
  v_session text;
  v_uid uuid;
  v_aal text;
  v_factor uuid;
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

  if v_at is null or v_at < extract(epoch from now()) - v_window then
    return false;
  end if;

  v_session := v_claims ->> 'session_id';
  if v_session is null then
    return true;
  end if;
  if v_session !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;

  v_uid := (select auth.uid());
  -- no row (revoked, or another user's session) → both null
  select s.aal::text, s.factor_id into v_aal, v_factor
  from auth.sessions s
  where s.id = v_session::uuid and s.user_id = v_uid;
  if v_aal is distinct from 'aal2' or v_factor is null then
    return false;
  end if;

  return exists (
           select 1 from auth.mfa_factors f
           where f.id = v_factor and f.user_id = v_uid and f.status = 'verified'
         )
     and not exists (select 1 from private.unvetted_factors(v_uid) u where u = v_factor);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Detector (§2.5): every 5′, as the SYSTEM. The verified factors of the users who are owner/manager
-- now (C, read once) against the snapshot of the last run:
--   transient = verified and removed between two runs (review fix): no snapshot ever held them, so
--             they come from GoTrue's audit log, gone from auth.mfa_factors and never accounted for;
--   added   = in C and not in the snapshot, and the transient ones → private.match_add_grants (one pass
--             over both: the earliest grant to the earliest factor), else an event; a transient
--             factor that matched also needs a `remove` grant of its own, else a removal event;
--   removed = in the snapshot, not in C and gone from auth.mfa_factors → the earliest unmatched
--             `remove` grant of the factor still valid after the run that last saw it (D8), else
--             an event; still existing but out of scope → dropped silently (D6).
-- A matched grant is consumed (matched_at). Each event: one audit row per owner/manager business,
-- the user's sessions and push devices revoked at once (D9), a nudge of dispatch after commit. What
-- leaves the snapshot, and every transient factor, goes to private.mfa_factor_accounted.
-- Every run writes one job_runs row; an error rolls the run's work back, is recorded as its
-- SQLSTATE and the call returns null. JWT claims hidden during the run. No grants.
-- ---------------------------------------------------------------------------------------------
create function private.detect_factor_changes_impl(p_now timestamptz default now())
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
  v_ids uuid[];
  v_users uuid[];
  v_created timestamptz[];
  v_since timestamptz;
  v_t_ids uuid[];
  v_t_users uuid[];
  v_t_created timestamptz[];
  v_a_ids uuid[];
  v_a_users uuid[];
  v_a_created timestamptz[];
  v_match record;
  v_change record;
  v_grant_id uuid;
  v_kinds text[] := '{}';
  v_event_users uuid[] := '{}';
  v_factors uuid[] := '{}';
  v_factor_created timestamptz[] := '{}';
  v_i integer;
  v_business_ids uuid[];
  v_event_id uuid;
  v_revoke uuid[] := '{}';
  v_user uuid;
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

    -- 1. two runs never interleave: the second sees the first's snapshot
    perform pg_advisory_xact_lock(hashtextextended('detect_factor_changes', 0));

    -- 2. C: read once, kept for the whole run
    select coalesce(array_agg(f.id order by f.created_at, f.id), '{}'::uuid[]),
           coalesce(array_agg(f.user_id order by f.created_at, f.id), '{}'::uuid[]),
           coalesce(array_agg(f.created_at order by f.created_at, f.id), '{}'::timestamptz[])
      into v_ids, v_users, v_created
    from auth.mfa_factors f
    where f.status = 'verified'
      and exists (
        select 1 from public.business_members m
        where m.user_id = f.user_id and m.role in ('owner', 'manager')
      );

    -- 3. transient (review fix). GoTrue writes one `verification_attempted` audit entry per verify
    --    that succeeds (a wrong code writes none), with the factor id, and `factor_in_progress` when the
    --    factor is enrolled. Look-back: from the start of the previous ok run, with 2′ of slack for the
    --    Auth clock and for entries committed late, never before the detector was watched (0011, so
    --    nothing older than the migration) and at most 7 days (mfa_factor_accounted keeps 30).
    select greatest(
             coalesce((select max(j.started_at) from private.job_runs j
                       where j.job = 'detect_factor_changes' and j.ok and j.started_at < p_now),
                      h.watched_since) - interval '2 minutes',
             h.watched_since,
             p_now - interval '7 days')
      into v_since
    from private.health_jobs h
    where h.job = 'detect_factor_changes';
    v_since := coalesce(v_since, p_now - interval '7 days');

    with verified as (
      select case when e.payload -> 'traits' ->> 'factor_id'
                       ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (e.payload -> 'traits' ->> 'factor_id')::uuid end as factor_id,
             case when e.payload ->> 'actor_id'
                       ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (e.payload ->> 'actor_id')::uuid end as user_id,
             e.created_at
      from auth.audit_log_entries e
      where e.created_at >= v_since
        and e.payload ->> 'action' = 'verification_attempted'
    ),
    candidates as (
      select v.factor_id,
             (array_agg(v.user_id order by v.created_at))[1] as user_id,
             min(v.created_at) as verified_at
      from verified v
      where v.factor_id is not null and v.user_id is not null
      group by v.factor_id
    ),
    transient as (
      -- created_at: of the enrolment entry (the factor row is gone), else the first verify
      select c.factor_id, c.user_id,
             coalesce((select min(e.created_at) from auth.audit_log_entries e
                       where e.payload ->> 'action' = 'factor_in_progress'
                         and lower(e.payload -> 'traits' ->> 'factor_id') = c.factor_id::text),
                      c.verified_at) as created_at
      from candidates c
      where not exists (select 1 from auth.mfa_factors f where f.id = c.factor_id)
        and not exists (select 1 from private.mfa_factor_snapshot s where s.factor_id = c.factor_id)
        and not exists (select 1 from private.mfa_factor_accounted a where a.factor_id = c.factor_id)
        and exists (
          select 1 from public.business_members m
          where m.user_id = c.user_id and m.role in ('owner', 'manager')
        )
    )
    select coalesce(array_agg(t.factor_id order by t.created_at, t.factor_id), '{}'::uuid[]),
           coalesce(array_agg(t.user_id order by t.created_at, t.factor_id), '{}'::uuid[]),
           coalesce(array_agg(t.created_at order by t.created_at, t.factor_id), '{}'::timestamptz[])
      into v_t_ids, v_t_users, v_t_created
    from transient t;

    -- 4. added: C minus the snapshot, and the transient factors, in one pass of the add-grant rule
    select coalesce(array_agg(c.id order by c.created_at, c.id), '{}'::uuid[]),
           coalesce(array_agg(c.user_id order by c.created_at, c.id), '{}'::uuid[]),
           coalesce(array_agg(c.created_at order by c.created_at, c.id), '{}'::timestamptz[])
      into v_a_ids, v_a_users, v_a_created
    from unnest(v_ids, v_users, v_created) as c (id, user_id, created_at)
    where not exists (select 1 from private.mfa_factor_snapshot s where s.factor_id = c.id);

    for v_match in
      select m.m_factor_id, m.m_user_id, m.m_created_at, m.m_grant_id
      from private.match_add_grants(v_a_ids || v_t_ids, v_a_users || v_t_users, v_a_created || v_t_created)
             with ordinality as m (m_factor_id, m_user_id, m_created_at, m_grant_id, ord)
      order by m.ord
    loop
      if v_match.m_grant_id is null then
        v_kinds := v_kinds || 'factor_added_unauthorized'::text;
        v_event_users := v_event_users || v_match.m_user_id;
        v_factors := v_factors || v_match.m_factor_id;
        v_factor_created := v_factor_created || v_match.m_created_at;
        continue;
      end if;

      update private.factor_change_grants g set matched_at = p_now where g.id = v_match.m_grant_id;

      -- a transient factor was also removed: that needs its own grant
      if v_match.m_factor_id = any (v_t_ids) then
        select g.id into v_grant_id
        from private.factor_change_grants g
        where g.user_id = v_match.m_user_id
          and g.action = 'remove'
          and g.factor_id = v_match.m_factor_id
          and g.matched_at is null
        order by g.created_at, g.id
        limit 1
        for update;

        if found then
          update private.factor_change_grants g set matched_at = p_now where g.id = v_grant_id;
        else
          v_kinds := v_kinds || 'factor_removed_unauthorized'::text;
          v_event_users := v_event_users || v_match.m_user_id;
          v_factors := v_factors || v_match.m_factor_id;
          v_factor_created := v_factor_created || v_match.m_created_at;
        end if;
      end if;
    end loop;

    -- 5. removed (snapshot rows not in C whose factor no longer exists, any status)
    for v_change in
      select s.factor_id, s.user_id, s.factor_created_at, s.last_seen_at
      from private.mfa_factor_snapshot s
      where not (s.factor_id = any (v_ids))
        and not exists (select 1 from auth.mfa_factors f where f.id = s.factor_id)
      order by s.factor_created_at, s.factor_id
    loop
      select g.id into v_grant_id
      from private.factor_change_grants g
      where g.user_id = v_change.user_id
        and g.action = 'remove'
        and g.factor_id = v_change.factor_id
        and g.matched_at is null
        and g.expires_at > v_change.last_seen_at
      order by g.created_at, g.id
      limit 1
      for update;

      if found then
        update private.factor_change_grants g set matched_at = p_now where g.id = v_grant_id;
      else
        v_kinds := v_kinds || 'factor_removed_unauthorized'::text;
        v_event_users := v_event_users || v_change.user_id;
        v_factors := v_factors || v_change.factor_id;
        v_factor_created := v_factor_created || v_change.factor_created_at;
      end if;
    end loop;

    -- 6. events (one per factor and kind) and their audit rows
    for v_i in 1 .. coalesce(array_length(v_kinds, 1), 0) loop
      select coalesce(
               array_agg(m.business_id order by case m.role when 'owner' then 0 else 1 end, m.created_at, m.business_id),
               '{}'::uuid[]
             )
        into v_business_ids
      from public.business_members m
      where m.user_id = v_event_users[v_i] and m.role in ('owner', 'manager');

      v_event_id := null;
      insert into private.security_events (user_id, kind, factor_id, factor_created_at, business_ids, detected_at)
      values (v_event_users[v_i], v_kinds[v_i], v_factors[v_i], v_factor_created[v_i], v_business_ids, p_now)
      on conflict (kind, factor_id) do nothing
      returning id into v_event_id;

      if v_event_id is not null then
        insert into public.audit_log (business_id, actor_type, actor_id, action, entity, entity_id, reason)
        select x.business_id, 'system', null, v_kinds[v_i], 'auth_user', v_event_users[v_i],
               'factor=' || v_factors[v_i]::text
        from unnest(v_business_ids) with ordinality as x (business_id, ord)
        order by x.ord;

        v_count := v_count + 1;
        if not (v_event_users[v_i] = any (v_revoke)) then
          v_revoke := v_revoke || v_event_users[v_i];
        end if;
      end if;
    end loop;

    -- 7. containment at detection (D9): sessions and push devices, once per user
    foreach v_user in array v_revoke loop
      perform private.revoke_user_sessions_impl(v_user);
    end loop;

    -- 8. snapshot := C; what leaves it, and every transient factor, is accounted for
    with gone as (
      delete from private.mfa_factor_snapshot s
      where not (s.factor_id = any (v_ids))
      returning s.factor_id, s.user_id
    )
    insert into private.mfa_factor_accounted as a (factor_id, user_id, accounted_at)
    select distinct on (x.factor_id) x.factor_id, x.user_id, p_now
    from (
      select g.factor_id, g.user_id from gone g
      union all
      select t.id, t.user_id from unnest(v_t_ids, v_t_users) as t (id, user_id)
    ) x
    where exists (select 1 from auth.users u where u.id = x.user_id)
    order by x.factor_id
    on conflict (factor_id) do update set accounted_at = excluded.accounted_at;

    insert into private.mfa_factor_snapshot as s (factor_id, user_id, factor_created_at, first_seen_at, last_seen_at)
    select c.id, c.user_id, c.created_at, p_now, p_now
    from unnest(v_ids, v_users, v_created) as c (id, user_id, created_at)
    where exists (select 1 from auth.users u where u.id = c.user_id)
    on conflict (factor_id) do update set last_seen_at = excluded.last_seen_at;

    -- 9. dispatch claims the events right after commit (the sweep's nudge is the fallback)
    if v_count > 0 then
      perform private.nudge_dispatch('security');
    end if;
  exception when others then
    v_error := sqlstate;
  end;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_claim_sub, ''), true);

  if v_error is not null then
    perform private.record_job_run('detect_factor_changes', v_started, false, null, v_error);
    return null;
  end if;
  perform private.record_job_run('detect_factor_changes', v_started, true, v_count);
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Notifications of an event (§2.6), called only by record_security_event_result_impl at the
-- 'contained' transition (no grants). Queues one push_security_alert per owner (other than the
-- user) with ≥ 1 device of every business of the event, through the 1.5 machine (at most once,
-- push switch, 60′ deadline), and returns the email bundle that dispatch sends:
--   { kind, detected_at, push_queued, emails: [ { audience, to, locale, timezone, business_name,
--     account_email } ] }, the user first ('user'), then the owners ('owner') by business name and
--   email. No email of the account → no emails (the push rows are still queued).
-- ---------------------------------------------------------------------------------------------
create function private.queue_security_notifications(p_event_id uuid, p_now timestamptz)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_event private.security_events%rowtype;
  v_email text;
  v_locale text := 'el';
  v_timezone text := 'UTC';
  v_push integer;
  v_emails jsonb := '[]'::jsonb;
begin
  if p_event_id is null or p_now is null then
    raise exception 'p_event_id and p_now are required' using errcode = '22023';
  end if;

  select e.* into v_event from private.security_events e where e.id = p_event_id;
  if not found then
    raise exception 'unknown security event' using errcode = '22023';
  end if;

  select u.email into v_email from auth.users u where u.id = v_event.user_id;

  -- the user's language and zone: those of the first business of the event
  if cardinality(v_event.business_ids) > 0 then
    select b.locale, b.timezone into v_locale, v_timezone
    from public.businesses b
    where b.id = v_event.business_ids[1];
    v_locale := coalesce(v_locale, 'el');
    v_timezone := coalesce(v_timezone, 'UTC');
  end if;

  -- the owners' push (D12)
  with inserted as (
    insert into public.messages_log (
      business_id, dedupe_key, channel, recipient_user_id, locale, template, category, scheduled_for
    )
    select b.id,
           'security:' || v_event.id::text || ':' || b.id::text || ':' || m.user_id::text,
           'push', m.user_id, b.locale, 'push_security_alert', 'transactional', p_now
    from unnest(v_event.business_ids) with ordinality as x (business_id, ord)
    join public.businesses b on b.id = x.business_id
    join public.business_members m on m.business_id = b.id and m.role = 'owner'
    where m.user_id <> v_event.user_id
      and exists (select 1 from public.push_subscriptions s where s.user_id = m.user_id)
    order by x.ord, m.created_at, m.user_id
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select count(*)::integer into v_push from inserted;

  -- the emails (D13, D14)
  if v_email is not null then
    v_emails := jsonb_build_array(jsonb_build_object(
      'audience', 'user',
      'to', v_email,
      'locale', v_locale,
      'timezone', v_timezone,
      'business_name', null,
      'account_email', v_email
    ));

    v_emails := v_emails || coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'audience', 'owner',
                 'to', o.email,
                 'locale', b.locale,
                 'timezone', b.timezone,
                 'business_name', b.name,
                 'account_email', v_email
               )
               order by b.name, o.email, b.id, o.id
             )
      from (select distinct x.business_id from unnest(v_event.business_ids) as x (business_id)) bx
      join public.businesses b on b.id = bx.business_id
      join public.business_members m on m.business_id = b.id and m.role = 'owner'
      join auth.users o on o.id = m.user_id
      where m.user_id <> v_event.user_id
        and o.email is not null
    ), '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'kind', v_event.kind,
    'detected_at', v_event.detected_at,
    'push_queued', v_push,
    'emails', v_emails
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC: claim_security_events (§2.6, service_role). (1) A notification whose lease expired is
-- closed 'notify_unknown' (never re-sent). (2) Up to p_limit (1–10) events, oldest first: pending,
-- or containing with an expired lease (containment is idempotent). (3) Each: containing, attempts
-- + 1, a new lease of 120 s; an added factor that still exists gets a `remove` grant of source
-- system first (D10), committed with the claim before dispatch deletes it.
-- ---------------------------------------------------------------------------------------------
create function private.claim_security_events_impl(p_limit integer, p_now timestamptz default now())
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_candidates uuid[];
  v_id uuid;
  v_lease uuid;
  v_row private.security_events%rowtype;
  v_items jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  if p_now is null then
    raise exception 'p_now is required' using errcode = '22023';
  end if;
  if p_limit is null or p_limit not between 1 and 10 then
    raise exception 'p_limit must be between 1 and 10' using errcode = '22023';
  end if;

  -- 1. abandoned notifications
  update private.security_events e
  set status = 'done', result = 'notify_unknown', handled_at = p_now, lease_id = null, lease_until = null
  where e.status = 'notifying' and e.lease_until < p_now;

  -- 2. candidates
  select coalesce(array_agg(x.id order by x.detected_at, x.id), '{}'::uuid[]) into v_candidates
  from (
    select e.id, e.detected_at
    from private.security_events e
    where e.status = 'pending' or (e.status = 'containing' and e.lease_until < p_now)
    order by e.detected_at, e.id
    limit p_limit
    for update skip locked
  ) x;

  -- 3. claim
  foreach v_id in array v_candidates loop
    v_lease := gen_random_uuid();
    update private.security_events e
    set status = 'containing',
        attempts = least(e.attempts + 1, 10000),
        lease_id = v_lease,
        lease_until = p_now + interval '120 seconds'
    where e.id = v_id
    returning e.* into v_row;

    if v_row.kind = 'factor_added_unauthorized'
       and exists (select 1 from auth.mfa_factors f where f.id = v_row.factor_id) then
      perform private.write_factor_grant(v_row.user_id, 'remove', v_row.factor_id, 'system');
    end if;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'id', v_row.id,
      'lease_id', v_row.lease_id,
      'kind', v_row.kind,
      'user_id', v_row.user_id,
      'factor_id', v_row.factor_id,
      'attempts', v_row.attempts
    ));
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('items', v_items, 'more', v_count = p_limit);
end;
$$;

create function public.claim_security_events(p_limit integer)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.claim_security_events_impl(p_limit);
$$;

comment on function public.claim_security_events(integer) is
  'Dispatcher only: leases up to p_limit (1–10) security events (120 s) and closes abandoned notifications. Returns {items[{id, lease_id, kind, user_id, factor_id, attempts}], more}.';

-- ---------------------------------------------------------------------------------------------
-- RPC: record_security_event_result (§2.6, service_role). The lease must be the row's current one
-- and the outcome must fit its status, else {recorded: false} (no error).
--   contained      (containing) → notifying, lease renewed 120 s, owners' push queued;
--                                 returns {recorded: true, notify: <bundle>}
--   contain_failed (containing) → pending, lease cleared, the error code kept (retried)
--   notified       (notifying)  → done 'notified' with the email counts
-- ---------------------------------------------------------------------------------------------
create function private.record_security_event_result_impl(
  p_id uuid,
  p_lease_id uuid,
  p_outcome text,
  p_emails_sent integer default null,
  p_emails_failed integer default null,
  p_error text default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row private.security_events%rowtype;
  v_notify jsonb;
begin
  if p_now is null then
    raise exception 'p_now is required' using errcode = '22023';
  end if;
  if p_id is null or p_lease_id is null or p_outcome is null then
    raise exception 'p_id, p_lease_id and p_outcome are required' using errcode = '22023';
  end if;
  if p_outcome not in ('contained', 'contain_failed', 'notified') then
    raise exception 'p_outcome must be contained, contain_failed or notified' using errcode = '22023';
  end if;
  if p_outcome = 'notified' then
    if p_emails_sent is null or p_emails_failed is null
       or p_emails_sent not between 0 and 100 or p_emails_failed not between 0 and 100 then
      raise exception 'notified needs both email counts (0–100)' using errcode = '22023';
    end if;
  elsif p_emails_sent is not null or p_emails_failed is not null then
    raise exception 'only notified takes email counts' using errcode = '22023';
  end if;

  select e.* into v_row
  from private.security_events e
  where e.id = p_id
  for update;
  if not found or v_row.lease_id is distinct from p_lease_id then
    return jsonb_build_object('recorded', false);
  end if;

  if p_outcome = 'contained' and v_row.status = 'containing' then
    update private.security_events e
    set status = 'notifying',
        contained_at = p_now,
        lease_until = p_now + interval '120 seconds',
        error = null
    where e.id = v_row.id;

    v_notify := private.queue_security_notifications(v_row.id, p_now);

    update private.security_events e
    set push_queued = (v_notify ->> 'push_queued')::smallint
    where e.id = v_row.id;

    return jsonb_build_object('recorded', true, 'notify', v_notify);
  end if;

  if p_outcome = 'contain_failed' and v_row.status = 'containing' then
    update private.security_events e
    set status = 'pending',
        lease_id = null,
        lease_until = null,
        error = case when p_error ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,79}$' then p_error else 'error' end
    where e.id = v_row.id;
    return jsonb_build_object('recorded', true);
  end if;

  if p_outcome = 'notified' and v_row.status = 'notifying' then
    update private.security_events e
    set status = 'done',
        result = 'notified',
        handled_at = p_now,
        lease_id = null,
        lease_until = null,
        emails_sent = p_emails_sent,
        emails_failed = p_emails_failed
    where e.id = v_row.id;
    return jsonb_build_object('recorded', true);
  end if;

  return jsonb_build_object('recorded', false);
end;
$$;

create function public.record_security_event_result(
  p_id uuid,
  p_lease_id uuid,
  p_outcome text,
  p_emails_sent integer default null,
  p_emails_failed integer default null,
  p_error text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_security_event_result_impl(p_id, p_lease_id, p_outcome, p_emails_sent, p_emails_failed, p_error);
$$;

comment on function public.record_security_event_result(uuid, uuid, text, integer, integer, text) is
  'Dispatcher only: contained (→ notifying, returns the notification bundle) | contain_failed (→ pending, retried) | notified (→ done, email counts). {recorded: false} for a stale lease or an outcome that does not fit.';

-- ---------------------------------------------------------------------------------------------
-- Nightly retention (§2.7): the 0007 body plus step 6 (grants 30 days after they expired or were
-- matched; finished security events 12 months after they were handled; the detector's accounted
-- factors after 30 days). Unfinished events and the snapshot are never purged. Returns the number
-- of rows deleted.
-- ---------------------------------------------------------------------------------------------
create or replace function private.purge_impl(p_now timestamptz default now())
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

    -- 6. authenticator-device grants 30 days after they expired or were matched; finished
    --    security events 12 months after they were handled (unfinished ones never)
    delete from private.factor_change_grants g
    where greatest(g.expires_at, coalesce(g.matched_at, g.expires_at)) < p_now - interval '30 days';
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;

    delete from private.security_events e
    where e.status = 'done' and e.handled_at < p_now - interval '12 months';
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;

    --    the detector's accounted factors 30 days after they were accounted for (its audit look-back
    --    is at most 7 days, so none of them can come back as transient)
    delete from private.mfa_factor_accounted a where a.accounted_at < p_now - interval '30 days';
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;

    -- 7. private bookkeeping after 30 days
    delete from private.job_runs j where j.finished_at < p_now - interval '30 days';
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;

    delete from private.move_requests r where r.created_at < p_now - interval '30 days';
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;

    -- 8. pg_cron's own run history after 7 days
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

-- cron.schedule upserts by name, so a reset rebuilds the job.
select cron.schedule('detect-factor-changes', '*/5 * * * *', $$select private.detect_factor_changes_impl()$$);

-- ---------------------------------------------------------------------------------------------
-- Grants (§2.8). service_role: health, claim_security_events, record_security_event_result and
-- their _impl. Nobody: detect_factor_changes_impl, queue_security_notifications, match_add_grants,
-- unvetted_factors (and purge_impl, has_fresh_totp: replaced, still none). anon/authenticated:
-- nothing new.
-- ---------------------------------------------------------------------------------------------
grant execute on function private.health_impl(timestamptz) to service_role;
grant execute on function public.health() to service_role;
grant execute on function private.claim_security_events_impl(integer, timestamptz) to service_role;
grant execute on function public.claim_security_events(integer) to service_role;
grant execute on function private.record_security_event_result_impl(uuid, uuid, text, integer, integer, text, timestamptz) to service_role;
grant execute on function public.record_security_event_result(uuid, uuid, text, integer, integer, text) to service_role;
