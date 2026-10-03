-- 0010_client_ops.sql
-- Client card, merge, erasure (SPEC §4, §5, §7, §11, §13; ADR-0005, ADR-0006, ADR-0009; Phase 1
-- plan step 1.8). Contract: docs/plans/contracts/1.8-client-ops.md (§2 is this file).
--
-- The family rule (contract D1): a client's family is its root plus every client whose
-- merged_into_id chain reaches the root. Every read and write here is family-wide
-- (private.client_family); merge_clients flattens, so families stay one level deep, and the helpers
-- still recurse (≤ 32 levels) as a defence against rows written by service_role.
--
-- Erasure is anonymisation, never a cascade delete: the client rows stay (FKs to clients are
-- RESTRICT) with every identifying field cleared, the appointments and their events stay for the
-- statistics, and every other trace of the person (notes, consents, phones in the outbox and in
-- the verification tables, manage links, trusted devices) is deleted, wiped or revoked (§2.7),
-- for every number the person used (also the ones before a change of mobile), not only the
-- current ones.
--
--   otp_challenges.phone_hmac          nullable: erase_client wipes it
--   audit_log.actor_type               + 'import' (merge_clients_core with the importer's actor)
--   client_consents                    authenticated writes only through set_client_consent (D8);
--                                      the state rule lives only in private.consent_state
--   client_notes                       + INSERT (id): client-generated ids (retry = upsert, D10)
--   guard_client_child_insert          no note and no consent for an erased or merged client (AN033),
--                                      for every role
--   set_client_search_text (0002)      an erased client's search_text is exactly ''
--   book_appointment_impl (0005)       step 5 (the marketing box) family-aware (D9)
--
-- API (thin SECURITY INVOKER wrappers in public, SECURITY DEFINER _impl in private):
--   authenticated: client_card (any member), set_client_consent (any member), merge_clients
--                  (owner/manager), erase_client (owner, fresh code)
-- Check order in every _impl: membership → role → fresh code (erase only) → client ids (42501) and
-- argument shape (22023) → the clients lock of the business, then the rows FOR UPDATE → the
-- operation. No authenticated RPC declares an actor; only merge_clients_core with p_actor
-- 'import' declares 'import'. Audit rows: contract §2.1.

-- ---------------------------------------------------------------------------------------------
-- Domain errors: AN032–AN033 join the list. The same list lives in
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
    when 'AN024' then 'slug_unavailable'
    when 'AN025' then 'future_appointments'
    when 'AN026' then 'last_owner'
    when 'AN027' then 'last_factor'
    when 'AN028' then 'already_member'
    when 'AN029' then 'staff_has_login'
    when 'AN030' then 'not_a_member'
    when 'AN031' then 'member_elsewhere'
    when 'AN032' then 'client_has_upcoming'
    when 'AN033' then 'client_unavailable'
  end;
begin
  if v_name is null then
    raise exception 'unknown domain error code %', p_code using errcode = '22023';
  end if;
  raise exception using errcode = 'P0001', message = p_code, hint = v_name;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Schema (§2.2)
-- ---------------------------------------------------------------------------------------------

-- erase_client wipes the phone of a challenge (plan «τηλέφωνα των otp_challenges»). The CHECK is
-- unchanged (null passes); a wiped challenge can never be verified again (no phone matches null).
alter table public.otp_challenges alter column phone_hmac drop not null;

-- merge_clients_core with the importer's actor (Phase 3) writes its audit row as 'import'.
alter table public.audit_log
  drop constraint audit_log_actor_type,
  add constraint audit_log_actor_type check (actor_type in ('staff', 'nous_support', 'system', 'import'));

-- client_consents: authenticated writes only through set_client_consent (D8), so the family rule
-- lives in SQL alone (rule 13). SELECT and its policy stay. service_role keeps INSERT/SELECT/UPDATE
-- (the importer, Phase 3); the guards below and guard_consent_update bind it too.
drop policy client_consents_insert on public.client_consents;
drop policy client_consents_withdraw on public.client_consents;
revoke insert, update on public.client_consents from authenticated;
-- the table-level revoke takes the 0002 column grants along; named again so none can be left over
revoke insert (business_id, client_id, purpose, legal_basis, granted, source, policy_version, given_by, created_by),
       update (withdrawn_at)
  on public.client_consents from authenticated;

-- client_notes: client-generated ids (a retry is an upsert that ignores the duplicate, as 1.6).
grant insert (id) on public.client_notes to authenticated;

-- The family walk (client_family, merge's flattening) looks clients up by their merge target.
create index clients_merged_into_idx on public.clients (business_id, merged_into_id)
  where merged_into_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Helpers and triggers (§2.3). Private, no grants: only definer code (and tests, as postgres)
-- calls them.
-- ---------------------------------------------------------------------------------------------

-- The root of a client's family: the client row of the business, then merged_into_id within the
-- business until null. Not found → null. A chain longer than 32 steps (or a cycle, only possible
-- through rows written by service_role) → 55000.
create function private.client_root(p_business_id uuid, p_client_id uuid)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_id uuid := p_client_id;
  v_next uuid;
begin
  if p_business_id is null or p_client_id is null then
    return null;
  end if;
  for v_step in 0..32 loop
    select c.merged_into_id into v_next
    from public.clients c
    where c.business_id = p_business_id and c.id = v_id;
    if not found then
      return null;
    end if;
    if v_next is null then
      return v_id;
    end if;
    v_id := v_next;
  end loop;
  raise exception 'the merge chain of client % is longer than 32 steps', p_client_id using errcode = '55000';
end;
$$;

-- p_root and every client of the business whose merged_into_id chain reaches it (depth ≤ 32,
-- distinct). Nothing when p_root is not a client of the business.
create function private.client_family(p_business_id uuid, p_root uuid)
returns setof uuid
language sql
stable
set search_path = ''
as $$
  with recursive family (id, depth) as (
    select c.id, 0
    from public.clients c
    where c.business_id = p_business_id and c.id = p_root
    union all
    select c.id, f.depth + 1
    from family f
    join public.clients c on c.business_id = p_business_id and c.merged_into_id = f.id
    where f.depth < 32
  )
  select distinct f.id from family f;
$$;

-- The consent state of a family for one purpose: the latest (created_at desc, id desc) ACTIVE
-- (withdrawn_at is null) record of the family wins → granted / refused; none → none. The only
-- place of the rule (rule 13): the card, set_client_consent, the booking box and Phase 2's
-- marketing all read it here.
create function private.consent_state(p_business_id uuid, p_root uuid, p_purpose text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object(
              'state', case when cc.granted then 'granted' else 'refused' end,
              'record_id', cc.id)
     from public.client_consents cc
     where cc.business_id = p_business_id
       and cc.client_id in (select private.client_family(p_business_id, p_root))
       and cc.purpose = p_purpose
       and cc.withdrawn_at is null
     order by cc.created_at desc, cc.id desc
     limit 1),
    jsonb_build_object('state', 'none', 'record_id', null)
  );
$$;

-- The 1.3 marketing box (book_appointment step 5), compared against the FAMILY state: the same
-- rows as 0005, on the booking's client. `checked` = the client refused marketing; `unchecked` =
-- shown and left alone (soft opt-in); `not_shown` = nothing. A new record only when the answer
-- differs from the family state; the box never withdraws (a refusal record wins by recency).
create function private.apply_marketing_box(
  p_business_id uuid,
  p_client_id uuid,
  p_box text,
  p_policy_version text,
  p_now timestamptz
)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_state text;
begin
  if p_box is null or p_box not in ('not_shown', 'unchecked', 'checked') then
    raise exception 'p_box is not_shown, unchecked or checked' using errcode = '22023';
  end if;
  if p_box = 'not_shown' then
    return;
  end if;

  v_state := private.consent_state(
    p_business_id, private.client_root(p_business_id, p_client_id), 'marketing_sms'
  ) ->> 'state';

  if (p_box = 'unchecked' and v_state <> 'granted') or (p_box = 'checked' and v_state <> 'refused') then
    insert into public.client_consents (
      business_id, client_id, purpose, legal_basis, granted, source, policy_version, given_by,
      created_by, created_at
    )
    values (
      p_business_id, p_client_id, 'marketing_sms', 'soft_opt_in', p_box = 'unchecked', 'booking_form',
      p_policy_version, 'client', null, p_now
    );
  end if;
end;
$$;

-- No note and no consent for an erased or merged client (AN033), whoever writes (authenticated,
-- service_role, the booking). FOR KEY SHARE: a write racing a merge or an erasure (which hold the
-- client FOR UPDATE) waits for it and then sees its result. Not found → the composite FK reports
-- it. Definer: the writer may hold no lock privilege on clients.
create function private.guard_client_child_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_erased_at timestamptz;
  v_merged_into_id uuid;
begin
  select c.erased_at, c.merged_into_id
    into v_erased_at, v_merged_into_id
  from public.clients c
  where c.business_id = new.business_id and c.id = new.client_id
  for key share;
  if not found then
    return new;
  end if;
  if v_erased_at is not null or v_merged_into_id is not null then
    perform private.raise_domain_error('AN033');
  end if;
  return new;
end;
$$;

create trigger client_notes_guard_client
  before insert on public.client_notes
  for each row execute function private.guard_client_child_insert();

create trigger client_consents_guard_client
  before insert on public.client_consents
  for each row execute function private.guard_client_child_insert();

-- 0002 trigger, new body: an erased client's search_text is exactly '' (client_search_text of an
-- empty name would leave spaces). The trigger (before insert or update of full_name, phone_e164)
-- is unchanged; the erasure updates full_name, so it fires.
create or replace function private.set_client_search_text()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.search_text := case
    when new.erased_at is not null then ''
    else private.client_search_text(new.full_name, new.phone_e164)
  end;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- merge_clients_core (§2.5): the merge itself, for merge_clients_impl (actor 'staff') and the
-- Phase 3 importer (actor 'import'). No grants; callers check membership and role.
--   1. p_actor 'staff' needs a signed-in user and declares nothing; 'import' declares
--      anaklo.actor_type = 'import' (plan «Κανόνες»); anything else → 22023;
--   2. both ids (42501 when null), different (22023);
--   3. the clients lock of the business, both rows FOR UPDATE (fewer than two → 42501);
--   4. already merged into the target → merged: false, nothing written;
--   5. an erased participant, a source merged elsewhere or a merged target → AN033;
--   6. appointments, notes and outbox rows move to the target (no appointment trigger fires:
--      client_id is in neither trigger's column list); consents stay on the source;
--   7. the source's own sources are re-pointed to the target (families stay one level deep);
--   8. the target's EMPTY phone (with its verification), email and birthday come from the source;
--   9. the source points at the target; 10. one audit row.
-- ---------------------------------------------------------------------------------------------
create function private.merge_clients_core(
  p_business_id uuid,
  p_source uuid,
  p_target uuid,
  p_actor text
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_source public.clients%rowtype;
  v_target public.clients%rowtype;
  v_rows integer;
  v_appointments integer;
  v_notes integer;
  v_messages integer;
  v_repointed integer;
  v_filled text[] := array[]::text[];
begin
  -- 1.
  if p_actor is null or p_actor not in ('staff', 'import') then
    raise exception 'p_actor is staff or import' using errcode = '22023';
  end if;
  if p_actor = 'staff' and (select auth.uid()) is null then
    raise exception 'a staff merge needs a signed-in user' using errcode = '42501';
  end if;
  if p_actor = 'import' then
    perform set_config('anaklo.actor_type', 'import', true);
  end if;

  -- 2.
  if p_source is null or p_target is null then
    raise exception 'p_source and p_target are required' using errcode = '42501';
  end if;
  if p_source = p_target then
    raise exception 'a client cannot be merged into itself' using errcode = '22023';
  end if;

  -- 3.
  perform pg_advisory_xact_lock(hashtextextended('clients:' || p_business_id::text, 0));

  perform 1
  from public.clients c
  where c.business_id = p_business_id and c.id in (p_source, p_target)
  order by c.id
  for update;
  get diagnostics v_rows = row_count;
  if v_rows < 2 then
    raise exception 'both clients must belong to this business' using errcode = '42501';
  end if;

  select * into v_source from public.clients c where c.business_id = p_business_id and c.id = p_source;
  select * into v_target from public.clients c where c.business_id = p_business_id and c.id = p_target;

  -- 4.
  if v_source.merged_into_id = p_target then
    return jsonb_build_object(
      'source_id', p_source, 'target_id', p_target, 'merged', false,
      'appointments', 0, 'notes', 0, 'messages', 0, 'repointed', 0, 'filled', '[]'::jsonb
    );
  end if;

  -- 5.
  if v_source.erased_at is not null or v_target.erased_at is not null
     or v_source.merged_into_id is not null or v_target.merged_into_id is not null then
    perform private.raise_domain_error('AN033');
  end if;

  -- 6.
  update public.appointments a
  set client_id = p_target
  where a.business_id = p_business_id and a.client_id = p_source;
  get diagnostics v_appointments = row_count;

  update public.client_notes n
  set client_id = p_target
  where n.business_id = p_business_id and n.client_id = p_source;
  get diagnostics v_notes = row_count;

  -- queued SMS then go to the target's phone and language at claim (1.5 D24)
  update public.messages_log m
  set client_id = p_target, updated_at = now()
  where m.business_id = p_business_id and m.client_id = p_source;
  get diagnostics v_messages = row_count;

  -- 7.
  update public.clients c
  set merged_into_id = p_target
  where c.business_id = p_business_id and c.merged_into_id = p_source;
  get diagnostics v_repointed = row_count;

  -- 8. One statement, so the 0002 trigger keeps the copied verification with the copied phone.
  if v_target.phone_e164 is null and v_source.phone_e164 is not null then
    v_filled := v_filled || 'phone'::text;
  end if;
  if v_target.email is null and v_source.email is not null then
    v_filled := v_filled || 'email'::text;
  end if;
  if v_target.birthday is null and v_source.birthday is not null then
    v_filled := v_filled || 'birthday'::text;
  end if;
  if cardinality(v_filled) > 0 then
    update public.clients t
    set phone_e164 = coalesce(t.phone_e164, s.phone_e164),
        phone_verified_at = case when t.phone_e164 is null then s.phone_verified_at else t.phone_verified_at end,
        email = coalesce(t.email, s.email),
        birthday = coalesce(t.birthday, s.birthday)
    from public.clients s
    where t.business_id = p_business_id and t.id = p_target
      and s.business_id = p_business_id and s.id = p_source;
  end if;

  -- 9.
  update public.clients c
  set merged_into_id = p_target
  where c.business_id = p_business_id and c.id = p_source;

  -- 10.
  insert into public.audit_log (business_id, actor_type, actor_id, action, entity, entity_id, reason)
  values (p_business_id, p_actor, (select auth.uid()), 'clients_merged', 'client', p_target,
          'source=' || p_source::text);

  return jsonb_build_object(
    'source_id', p_source,
    'target_id', p_target,
    'merged', true,
    'appointments', v_appointments,
    'notes', v_notes,
    'messages', v_messages,
    'repointed', v_repointed,
    'filled', to_jsonb(v_filled)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- book_appointment_impl (§2.4): the 0005 body, except step 5, which is now
-- private.apply_marketing_box (the same rows, compared against the FAMILY state). Same signature,
-- defaults and volatility; the grants stay with create or replace.
--   0. arguments; a per-key advisory lock BEFORE the idempotency lookup (concurrent retries
--      serialise; the second one replays instead of failing on the consumed grant);
--   1. replay: proof = the grant this booking consumed, or a live grant / valid device; book_core
--      with the ORIGINAL verified_via (same request hash) → replayed, or AN004; a new token only;
--   2. proof: a live grant (row-locked, consumed in step 4 together with the appointment id, as
--      the otp_challenges CHECKs require) → 'otp'; else a valid device → 'trusted_device'; else AN014;
--   3. book_core (actor client, recheck, planner 'created'); a failure rolls the grant back too;
--   4. OTP only: the grant is consumed; phone_verified_at in the same UPDATE as the phone;
--   5. marketing box (shown only) → a soft_opt_in record when the answer differs from the family;
--   6. a new manage token, the queued SMS ids, the next-visit hint.
-- ---------------------------------------------------------------------------------------------
create or replace function private.book_appointment_impl(
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
    perform private.apply_marketing_box(p_business_id, v_client_id, p_marketing_box, p_policy_version, p_now);
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

-- ---------------------------------------------------------------------------------------------
-- RPC: client_card (§2.5, §2.6). Any member. One jsonb in three states: `erased` (the state
-- only), `merged` (the state and the root: the app redirects), `live` (the card of the family).
-- Staff see every row of the history (date, service, staff, status) but amounts only of their
-- own appointments: the others are nulled HERE (D14). The ring (E18) is computed here; the browser
-- only draws it (rule 13). No memory (phase, tags, totals): Phase 2.
-- ---------------------------------------------------------------------------------------------
create function private.client_card_impl(
  p_business_id uuid,
  p_client_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_client public.clients%rowtype;
  v_tz text;
  v_currency text;
  v_family uuid[];
  v_manager boolean;
  v_owner boolean;
  v_my_staff uuid;
  v_today date;
  v_visits integer;
  v_last_visit_at timestamptz;
  v_last_visit_date date;
  v_no_shows integer;
  v_hint jsonb;
  v_weeks integer;
  v_interval_days integer;
  v_days integer;
  v_ring jsonb;
  v_aliases jsonb;
  v_upcoming jsonb;
  v_history jsonb;
  v_history_total integer;
  v_notes jsonb;
  v_notes_total integer;
  v_current jsonb;
  v_records jsonb;
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if p_now is null then
    raise exception 'p_now is required' using errcode = '22023';
  end if;
  if p_client_id is null then
    raise exception 'p_client_id is required' using errcode = '42501';
  end if;

  select * into v_client
  from public.clients c
  where c.business_id = p_business_id and c.id = p_client_id;
  if not found then
    raise exception 'client not found in this business' using errcode = '42501';
  end if;

  if v_client.erased_at is not null then
    return jsonb_build_object('state', 'erased', 'client_id', v_client.id, 'erased_at', v_client.erased_at);
  end if;
  if v_client.merged_into_id is not null then
    return jsonb_build_object(
      'state', 'merged',
      'client_id', v_client.id,
      'merged_into_id', private.client_root(p_business_id, v_client.id)
    );
  end if;

  select b.timezone, b.currency::text into v_tz, v_currency
  from public.businesses b
  where b.id = p_business_id;

  v_family := array(select private.client_family(p_business_id, v_client.id));
  v_manager := private.has_role(p_business_id, array['owner', 'manager']);
  v_owner := private.has_role(p_business_id, array['owner']);
  v_my_staff := private.my_staff_id(p_business_id);
  v_today := (p_now at time zone v_tz)::date;

  -- counters: a visit is a business-local date with ≥ 1 completed appointment (SPEC §4)
  select count(distinct (a.starts_at at time zone v_tz)::date) filter (where a.status = 'completed'),
         max(a.starts_at) filter (where a.status = 'completed'),
         count(*) filter (where a.status = 'no_show')
    into v_visits, v_last_visit_at, v_no_shows
  from public.appointments a
  where a.business_id = p_business_id and a.client_id = any (v_family);
  v_last_visit_date := (v_last_visit_at at time zone v_tz)::date;

  -- ring (E18): days since the last visit against the interval the client is told (weeks × 7)
  v_hint := private.next_visit_hint_impl(p_business_id, p_now);
  v_weeks := (v_hint ->> 'weeks')::integer;
  v_interval_days := v_weeks * 7;
  if v_last_visit_date is null then
    v_ring := jsonb_build_object(
      'state', 'no_visits', 'days_since_last', null, 'fraction', 0, 'overdue_days', null);
  else
    v_days := greatest(0, v_today - v_last_visit_date);
    if v_hint is null then
      v_ring := jsonb_build_object(
        'state', 'no_interval', 'days_since_last', v_days, 'fraction', null, 'overdue_days', null);
    elsif v_days <= v_interval_days then
      v_ring := jsonb_build_object(
        'state', 'within', 'days_since_last', v_days,
        'fraction', round(v_days::numeric / v_interval_days, 2), 'overdue_days', null);
    else
      v_ring := jsonb_build_object(
        'state', 'beyond', 'days_since_last', v_days, 'fraction', 1,
        'overdue_days', v_days - v_interval_days);
    end if;
  end if;
  v_ring := v_ring || jsonb_build_object(
    'interval_days', v_interval_days,
    'interval_weeks', v_weeks,
    'hint_key', v_hint ->> 'key'
  );

  -- aliases: the family minus the root
  select coalesce(jsonb_agg(jsonb_build_object(
           'client_id', c.id, 'full_name', c.full_name, 'phone_e164', c.phone_e164
         ) order by c.created_at, c.id), '[]'::jsonb)
    into v_aliases
  from public.clients c
  where c.business_id = p_business_id and c.id = any (v_family) and c.id <> v_client.id;

  -- upcoming (≤ 10) and history (≤ 50): ids first, the items only for the rows shown
  with picked as (
    (select a.id, true as upcoming
     from public.appointments a
     where a.business_id = p_business_id and a.client_id = any (v_family)
       and a.status in ('booked', 'confirmed') and a.ends_at > p_now
     order by a.starts_at, a.id
     limit 10)
    union all
    (select a.id, false as upcoming
     from public.appointments a
     where a.business_id = p_business_id and a.client_id = any (v_family)
       and not (a.status in ('booked', 'confirmed') and a.ends_at > p_now)
     order by a.starts_at desc, a.id desc
     limit 50)
  ),
  items as (
    select p.upcoming, a.starts_at, a.id,
           jsonb_build_object(
             'appointment_id', a.id,
             'starts_at', a.starts_at,
             'ends_at', a.ends_at,
             'status', a.status,
             'source', a.source,
             'staff_id', a.staff_id,
             'staff_name', st.display_name,
             'service_names', coalesce((
               select jsonb_agg(s.name order by l.position)
               from public.appointment_services l
               join public.services s on s.business_id = l.business_id and s.id = l.service_id
               where l.business_id = a.business_id and l.appointment_id = a.id
             ), '[]'::jsonb),
             'amount_cents', case
               when v_manager or (v_my_staff is not null and a.staff_id = v_my_staff) then
                 case
                   when a.status = 'completed' then coalesce(a.charged_cents, a.total_cents)
                   when a.status in ('booked', 'confirmed') then a.total_cents
                 end
             end,
             'own', v_my_staff is not null and a.staff_id = v_my_staff
           ) as item
    from picked p
    join public.appointments a on a.business_id = p_business_id and a.id = p.id
    left join public.staff st on st.business_id = a.business_id and st.id = a.staff_id
  )
  select coalesce(jsonb_agg(i.item order by i.starts_at, i.id) filter (where i.upcoming), '[]'::jsonb),
         coalesce(jsonb_agg(i.item order by i.starts_at desc, i.id desc) filter (where not i.upcoming), '[]'::jsonb)
    into v_upcoming, v_history
  from items i;

  select count(*) into v_history_total
  from public.appointments a
  where a.business_id = p_business_id and a.client_id = any (v_family)
    and not (a.status in ('booked', 'confirmed') and a.ends_at > p_now);

  -- notes (≤ 100): the author through their membership of THIS business (null when gone)
  select coalesce(jsonb_agg(x.item order by x.created_at desc, x.id desc), '[]'::jsonb)
    into v_notes
  from (
    select n.id, n.created_at,
           jsonb_build_object(
             'id', n.id,
             'body', n.body,
             'created_at', n.created_at,
             'by_me', coalesce(n.author_id = v_uid, false),
             'author_name', st.display_name,
             'author_role', m.role,
             'can_delete', coalesce(n.author_id = v_uid, false) or v_owner
           ) as item
    from public.client_notes n
    left join public.business_members m on m.business_id = n.business_id and m.user_id = n.author_id
    left join public.staff st on st.business_id = m.business_id and st.id = m.staff_id
    where n.business_id = p_business_id and n.client_id = any (v_family)
    order by n.created_at desc, n.id desc
    limit 100
  ) x;

  select count(*) into v_notes_total
  from public.client_notes n
  where n.business_id = p_business_id and n.client_id = any (v_family);

  -- consents: the state per purpose (private.consent_state) and every record of the family
  select jsonb_object_agg(p.purpose, private.consent_state(p_business_id, v_client.id, p.purpose))
    into v_current
  from unnest(array['marketing_sms', 'marketing_email', 'photos_record', 'photos_publish']) as p (purpose);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', cc.id,
           'client_id', cc.client_id,
           'purpose', cc.purpose,
           'legal_basis', cc.legal_basis,
           'granted', cc.granted,
           'source', cc.source,
           'given_by', cc.given_by,
           'policy_version', cc.policy_version,
           'created_at', cc.created_at,
           'withdrawn_at', cc.withdrawn_at
         ) order by cc.created_at desc, cc.id desc), '[]'::jsonb)
    into v_records
  from public.client_consents cc
  where cc.business_id = p_business_id and cc.client_id = any (v_family);

  return jsonb_build_object(
    'state', 'live',
    'client_id', v_client.id,
    'as_of', p_now,
    'timezone', v_tz,
    'currency', v_currency,
    'details', jsonb_build_object(
      'full_name', v_client.full_name,
      'phone_e164', v_client.phone_e164,
      'phone_verified_at', v_client.phone_verified_at,
      'email', v_client.email,
      'birthday', to_char(v_client.birthday, 'YYYY-MM-DD'),
      'locale', v_client.locale,
      'source', v_client.source,
      'created_at', v_client.created_at,
      'aliases', v_aliases
    ),
    'counters', jsonb_build_object(
      'visits', v_visits,
      'last_visit_at', v_last_visit_at,
      'last_visit_date', to_char(v_last_visit_date, 'YYYY-MM-DD'),
      'no_shows', v_no_shows
    ),
    'ring', v_ring,
    'upcoming', v_upcoming,
    'history', v_history,
    'history_total', v_history_total,
    'notes', v_notes,
    'notes_total', v_notes_total,
    'consents', jsonb_build_object('current', v_current, 'records', v_records),
    'can', jsonb_build_object('erase', v_owner, 'merge', v_manager)
  );
end;
$$;

create function public.client_card(p_business_id uuid, p_client_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.client_card_impl(p_business_id, p_client_id);
$$;

comment on function public.client_card(uuid, uuid) is
  'Clients: the card of a client and the clients merged into it (any member): {state: live, details, counters, ring, upcoming, history, notes, consents, can}, or {state: merged, merged_into_id} / {state: erased}. Staff get amounts of their own appointments only.';

-- ---------------------------------------------------------------------------------------------
-- RPC: set_client_consent (§2.5). Any member. The only way the app records a consent (D8):
--   on  = a NEW record (legal_basis consent, source staff_ui) unless the family is already granted;
--   off = withdrawn_at on EVERY active granted record of the family for the purpose.
-- Never a change of purpose or granted (guard_consent_update enforces it anyway); staff never
-- write a refusal record. No audit row: the records are the evidence.
-- ---------------------------------------------------------------------------------------------
create function private.set_client_consent_impl(
  p_business_id uuid,
  p_client_id uuid,
  p_purpose text,
  p_granted boolean,
  p_given_by text default null,
  p_policy_version text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_client public.clients%rowtype;
  v_before jsonb;
  v_consent_id uuid;
  v_withdrawn integer := 0;
begin
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if p_client_id is null or not exists (
    select 1 from public.clients c where c.business_id = p_business_id and c.id = p_client_id
  ) then
    raise exception 'client not found in this business' using errcode = '42501';
  end if;
  if p_purpose is null
     or p_purpose not in ('marketing_sms', 'marketing_email', 'photos_record', 'photos_publish') then
    raise exception 'p_purpose is not a consent purpose' using errcode = '22023';
  end if;
  if p_granted is null then
    raise exception 'p_granted is required' using errcode = '22023';
  end if;
  if p_granted and (
       p_given_by is null or p_given_by not in ('client', 'guardian')
       or p_policy_version is null or char_length(p_policy_version) not between 1 and 40) then
    raise exception 'a grant needs p_given_by (client or guardian) and a 1–40 character p_policy_version'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('clients:' || p_business_id::text, 0));

  select * into v_client
  from public.clients c
  where c.business_id = p_business_id and c.id = p_client_id
  for update;
  if v_client.erased_at is not null or v_client.merged_into_id is not null then
    perform private.raise_domain_error('AN033');
  end if;

  v_before := private.consent_state(p_business_id, p_client_id, p_purpose);

  if p_granted then
    if v_before ->> 'state' <> 'granted' then
      insert into public.client_consents (
        business_id, client_id, purpose, legal_basis, granted, source, policy_version, given_by, created_by
      )
      values (
        p_business_id, p_client_id, p_purpose, 'consent', true, 'staff_ui', p_policy_version, p_given_by,
        (select auth.uid())
      )
      returning id into v_consent_id;
    end if;
  else
    update public.client_consents cc
    set withdrawn_at = now()
    where cc.business_id = p_business_id
      and cc.client_id in (select private.client_family(p_business_id, p_client_id))
      and cc.purpose = p_purpose
      and cc.granted
      and cc.withdrawn_at is null;
    get diagnostics v_withdrawn = row_count;
  end if;

  return jsonb_build_object(
    'client_id', p_client_id,
    'purpose', p_purpose,
    'state', private.consent_state(p_business_id, p_client_id, p_purpose) ->> 'state',
    'changed', v_consent_id is not null or v_withdrawn > 0,
    'consent_id', v_consent_id,
    'withdrawn', v_withdrawn
  );
end;
$$;

create function public.set_client_consent(
  p_business_id uuid,
  p_client_id uuid,
  p_purpose text,
  p_granted boolean,
  p_given_by text default null,
  p_policy_version text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.set_client_consent_impl(
    p_business_id, p_client_id, p_purpose, p_granted, p_given_by, p_policy_version
  );
$$;

comment on function public.set_client_consent(uuid, uuid, text, boolean, text, text) is
  'Clients: record a consent given in the shop (a new staff_ui record) or withdraw every active grant of the client''s family for the purpose (any member). Returns {client_id, purpose, state, changed, consent_id, withdrawn}; an erased or merged client → AN033.';

-- ---------------------------------------------------------------------------------------------
-- RPC: merge_clients (§2.5). Owner or manager; not critical (no fresh code). The merge itself is
-- private.merge_clients_core with the actor 'staff'.
-- ---------------------------------------------------------------------------------------------
create function private.merge_clients_impl(p_business_id uuid, p_source uuid, p_target uuid)
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
  if not private.has_role(p_business_id, array['owner', 'manager']) then
    raise exception 'only an owner or a manager may merge clients' using errcode = '42501';
  end if;
  return private.merge_clients_core(p_business_id, p_source, p_target, 'staff');
end;
$$;

create function public.merge_clients(p_business_id uuid, p_source uuid, p_target uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.merge_clients_impl(p_business_id, p_source, p_target);
$$;

comment on function public.merge_clients(uuid, uuid, uuid) is
  'Clients: merge a duplicate (source) into a client (target) of the same business (owner or manager). Appointments, notes and messages move; consents stay on the source and count through the target. Returns {source_id, target_id, merged, appointments, notes, messages, repointed, filled}; an erased or merged participant → AN033.';

-- ---------------------------------------------------------------------------------------------
-- RPC: erase_client (§2.5, §2.7). Owner with a fresh code (C6; private.require_fresh_totp() after
-- the membership and role checks). Anonymises the whole family, also when called with a merged
-- source's id. Refused while the family has an appointment booked/confirmed that has not ended
-- (AN032). Already erased → erased: false, nothing written.
-- ---------------------------------------------------------------------------------------------
create function private.erase_client_impl(p_business_id uuid, p_client_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_root uuid;
  v_root_erased_at timestamptz;
  v_family uuid[];
  v_grants uuid[];
  v_phones text[];
  v_hmacs text[] := array[]::text[];
  v_erased_at timestamptz := now();
  v_appointments integer;
  v_notes integer;
  v_consents integer;
  v_messages integer;
  v_challenges integer := 0;
  v_devices integer := 0;
  v_tokens integer;
  v_suppressed integer := 0;
begin
  -- 1.
  if not private.is_member(p_business_id) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
  if not private.has_role(p_business_id, array['owner']) then
    raise exception 'only the owner may erase a client' using errcode = '42501';
  end if;
  perform private.require_fresh_totp();
  if p_client_id is null or not exists (
    select 1 from public.clients c where c.business_id = p_business_id and c.id = p_client_id
  ) then
    raise exception 'client not found in this business' using errcode = '42501';
  end if;

  -- 2. no merge can change the family while the lock is held
  perform pg_advisory_xact_lock(hashtextextended('clients:' || p_business_id::text, 0));
  v_root := private.client_root(p_business_id, p_client_id);
  v_family := array(
    select f.id from private.client_family(p_business_id, v_root) as f (id) order by f.id
  );
  perform 1
  from public.clients c
  where c.business_id = p_business_id and c.id = any (v_family)
  order by c.id
  for update;

  -- 3.
  select c.erased_at into v_root_erased_at
  from public.clients c
  where c.business_id = p_business_id and c.id = v_root;
  if v_root_erased_at is not null then
    return jsonb_build_object(
      'client_id', v_root, 'erased', false, 'erased_at', v_root_erased_at, 'erased_ids', '[]'::jsonb,
      'appointments_kept', 0, 'notes_deleted', 0, 'consents_deleted', 0, 'messages_wiped', 0,
      'otp_challenges_wiped', 0, 'devices_revoked', 0, 'tokens_revoked', 0, 'suppressed', 0
    );
  end if;

  -- 4.
  if exists (
    select 1 from public.appointments a
    where a.business_id = p_business_id
      and a.client_id = any (v_family)
      and a.status in ('booked', 'confirmed')
      and a.ends_at > now()
  ) then
    perform private.raise_domain_error('AN032');
  end if;

  -- 5. Every number the person used, not only the current ones (a mobile changed on the card lives
  --    on in the rows of the old one): the family's numbers, the numbers its messages went to, and
  --    the numbers of the OTP challenges whose grant made one of its bookings (their OTP rows carry
  --    no client). HMACs only when there is a number or such a challenge: a phone-less client
  --    needs no Vault key.
  v_grants := array(
    select oc.id
    from public.otp_challenges oc
    join public.appointments a on a.business_id = oc.business_id and a.id = oc.grant_appointment_id
    where oc.business_id = p_business_id and a.client_id = any (v_family)
    order by oc.id
  );
  v_phones := array(
    select distinct x.phone
    from (
      select c.phone_e164 as phone
      from public.clients c
      where c.business_id = p_business_id and c.id = any (v_family)
      union all
      select m.to_e164
      from public.messages_log m
      where m.business_id = p_business_id
        and m.channel = 'sms'
        and (m.client_id = any (v_family) or m.otp_challenge_id = any (v_grants))
    ) as x
    where x.phone is not null
    order by x.phone
  );
  v_hmacs := array(
    select distinct h.hmac
    from (
      select private.phone_hmac(p.phone) as hmac from unnest(v_phones) as p (phone)
      union all
      select oc.phone_hmac
      from public.otp_challenges oc
      where oc.business_id = p_business_id and oc.id = any (v_grants)
    ) as h
    where h.hmac is not null
    order by h.hmac
  );

  -- 6. §2.7
  -- clients: one UPDATE (the 0002 CHECK needs every field at once); phone_verified_at goes by the
  -- 0002 trigger (the phone changes and this statement never names it), search_text by the trigger
  -- above
  update public.clients c
  set full_name = '',
      phone_e164 = null,
      email = null,
      birthday = null,
      external_ref = null,
      erased_at = coalesce(c.erased_at, v_erased_at)
  where c.business_id = p_business_id and c.id = any (v_family);

  delete from public.client_notes n
  where n.business_id = p_business_id and n.client_id = any (v_family);
  get diagnostics v_notes = row_count;

  -- every record, active and withdrawn: the evidence of an erased person goes with the person
  -- (guard_consent_update is BEFORE UPDATE only; no API role holds DELETE)
  delete from public.client_consents cc
  where cc.business_id = p_business_id and cc.client_id = any (v_family);
  get diagnostics v_consents = row_count;

  -- the family's messages, the OTP rows (no client) of the challenges that made its bookings, and
  -- every OTP row sent to one of its numbers; a queued row is cancelled 'no_recipient' at claim
  -- (1.5 D24)
  update public.messages_log m
  set to_e164 = null, updated_at = now()
  where m.business_id = p_business_id
    and m.to_e164 is not null
    and (m.client_id = any (v_family)
         or m.otp_challenge_id = any (v_grants)
         or (m.client_id is null and m.channel = 'sms' and m.to_e164 = any (v_phones)));
  get diagnostics v_messages = row_count;

  if cardinality(v_hmacs) > 0 then
    update public.otp_challenges oc
    set phone_hmac = null
    where oc.business_id = p_business_id and oc.phone_hmac = any (v_hmacs);
    get diagnostics v_challenges = row_count;

    update public.trusted_devices d
    set revoked_at = now()
    where d.business_id = p_business_id and d.phone_hmac = any (v_hmacs) and d.revoked_at is null;
    get diagnostics v_devices = row_count;
  end if;

  update public.booking_tokens t
  set revoked_at = now()
  where t.business_id = p_business_id
    and t.revoked_at is null
    and t.appointment_id in (
      select a.id from public.appointments a
      where a.business_id = p_business_id and a.client_id = any (v_family)
    );
  get diagnostics v_tokens = row_count;

  -- the appointments stay (client link, times, status, amounts, staff, source), without the links
  -- derived from the person; no event fires (neither column is in the trigger's list)
  update public.appointments a
  set request_hash = null, external_ref = null
  where a.business_id = p_business_id and a.client_id = any (v_family);
  get diagnostics v_appointments = row_count;

  if cardinality(v_hmacs) > 0 then
    insert into public.suppression_list (business_id, phone_hmac, reason)
    select p_business_id, h.hmac, 'erased'
    from unnest(v_hmacs) as h (hmac)
    on conflict do nothing;
    get diagnostics v_suppressed = row_count;
  end if;

  insert into public.audit_log (business_id, actor_type, actor_id, action, entity, entity_id, reason)
  values (p_business_id, 'staff', (select auth.uid()), 'client_erased', 'client', v_root,
          'clients=' || cardinality(v_family)::text);

  -- 7.
  return jsonb_build_object(
    'client_id', v_root,
    'erased', true,
    'erased_at', v_erased_at,
    'erased_ids', to_jsonb(v_family),
    'appointments_kept', v_appointments,
    'notes_deleted', v_notes,
    'consents_deleted', v_consents,
    'messages_wiped', v_messages,
    'otp_challenges_wiped', v_challenges,
    'devices_revoked', v_devices,
    'tokens_revoked', v_tokens,
    'suppressed', v_suppressed
  );
end;
$$;

create function public.erase_client(p_business_id uuid, p_client_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.erase_client_impl(p_business_id, p_client_id);
$$;

comment on function public.erase_client(uuid, uuid) is
  'Clients (GDPR): anonymise a client and every client merged into it (owner, fresh code). The appointments stay without a name. Returns {client_id, erased, erased_at, erased_ids, appointments_kept, notes_deleted, consents_deleted, messages_wiped, otp_challenges_wiped, devices_revoked, tokens_revoked, suppressed}; an upcoming appointment → AN032.';

-- ---------------------------------------------------------------------------------------------
-- Grants (§2.9). anon and service_role: unchanged. Nobody: client_root, client_family,
-- consent_state, apply_marketing_box, merge_clients_core, guard_client_child_insert,
-- set_client_search_text (only definer code and tests, as postgres, call them).
-- ---------------------------------------------------------------------------------------------
grant execute on function private.client_card_impl(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.client_card(uuid, uuid) to authenticated;
grant execute on function private.set_client_consent_impl(uuid, uuid, text, boolean, text, text) to authenticated;
grant execute on function public.set_client_consent(uuid, uuid, text, boolean, text, text) to authenticated;
grant execute on function private.merge_clients_impl(uuid, uuid, uuid) to authenticated;
grant execute on function public.merge_clients(uuid, uuid, uuid) to authenticated;
grant execute on function private.erase_client_impl(uuid, uuid) to authenticated;
grant execute on function public.erase_client(uuid, uuid) to authenticated;
