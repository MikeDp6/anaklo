-- 0002_clients.sql
-- Clients, consents and notes (SPEC §7, §11).
-- The phone number is NOT a unique key: families share one mobile, walk-ins may have none.

-- ---------------------------------------------------------------------------------------------
-- Search normalisation: 'ΓΙΩΡΓΟΣ', 'Γιώργος', 'Γιωργος' and 'giorgos' must all find the same client.
-- This is the only implementation; the search RPC normalises its query with the same functions.
-- ---------------------------------------------------------------------------------------------

-- Lower case, no accents of any kind (tonos, dialytika, polytonic, decomposed input), final
-- sigma → σ. NFD + removal of combining marks covers precomposed and pasted/decomposed text.
create function private.normalize_greek(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(
    regexp_replace(normalize(lower(coalesce(p_text, '')), NFD), '[̀-ͯ]', '', 'g'),
    'ς', 'σ'
  );
$$;

-- Greeklish of already-normalised text, in the three spellings people actually type, so that
-- 'stavros', 'lefteris', 'evangelos', 'babis', 'dinos', 'mihalis', 'hristos' all match:
--   1) ου→ou, αυ/ευ→av/ev, μπ→mp, ντ→nt, γγ→ng, γκ→gk, θ→th, χ→ch, ψ→ps, υ→y
--   2) ου→u,  αυ/ευ→af/ef, μπ→b,  ντ→d,  γγ/γκ→g,        θ→th, χ→x,  ψ→ps, υ→i
--   3) ου→ou, αυ/ευ→au/eu, μπ→b,  ντ→nt, γγ→ng, γκ→g,    θ→th, χ→h,  ψ→ps, υ→y
create function private.greeklish(p_normalized text)
returns text
language sql
immutable
set search_path = ''
as $$
  select concat_ws(' ',
    translate(
      replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        p_normalized, 'ου', 'ou'), 'αυ', 'av'), 'ευ', 'ev'), 'μπ', 'mp'), 'ντ', 'nt'), 'γγ', 'ng'), 'γκ', 'gk'),
        'θ', 'th'), 'χ', 'ch'), 'ψ', 'ps'),
      'αβγδεζηικλμνξοπρστυφω', 'avgdeziiklmnxoprstyfo'
    ),
    translate(
      replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        p_normalized, 'ου', 'u'), 'αυ', 'af'), 'ευ', 'ef'), 'μπ', 'b'), 'ντ', 'd'), 'γγ', 'g'), 'γκ', 'g'),
        'θ', 'th'), 'χ', 'x'), 'ψ', 'ps'),
      'αβγδεζηικλμνξοπρστυφω', 'avgdeziiklmnxoprstifo'
    ),
    translate(
      replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        p_normalized, 'ου', 'ou'), 'αυ', 'au'), 'ευ', 'eu'), 'μπ', 'b'), 'ντ', 'nt'), 'γγ', 'ng'), 'γκ', 'g'),
        'θ', 'th'), 'χ', 'h'), 'ψ', 'ps'),
      'αβγδεζηικλμνξοπρστυφω', 'avgdeziiklmnxoprstyfo'
    )
  );
$$;

create function private.client_search_text(p_full_name text, p_phone text)
returns text
language sql
immutable
set search_path = ''
as $$
  select concat_ws(' ',
    private.normalize_greek(p_full_name),
    private.greeklish(private.normalize_greek(p_full_name)),
    regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------------------------------
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  full_name text not null,
  phone_e164 text constraint clients_phone check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- last time the client proved this number with an OTP (ADR-0006); a staff-typed number is
  -- unverified. Cleared automatically when the number changes.
  phone_verified_at timestamptz,
  email text constraint clients_email check (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  birthday date,
  locale text not null default 'el' constraint clients_locale check (locale in ('el', 'en')),
  search_text text not null default '',
  source text not null constraint clients_source check (source in ('online', 'staff', 'import')),
  external_ref text constraint clients_external_ref_length check (char_length(external_ref) <= 120),
  merged_into_id uuid,
  erased_at timestamptz,
  created_at timestamptz not null default now(),
  -- an erased (anonymised) client keeps its row for statistics but loses every identifying field
  constraint clients_name_unless_erased check (
    (erased_at is null and char_length(full_name) between 1 and 120)
    or (erased_at is not null and full_name = '' and phone_e164 is null and email is null and birthday is null)
  ),
  constraint clients_phone_verified_needs_phone check (phone_verified_at is null or phone_e164 is not null),
  constraint clients_business_id_key unique (business_id, id),
  constraint clients_merged_into_fk foreign key (business_id, merged_into_id)
    references public.clients (business_id, id) on delete restrict,
  constraint clients_not_merged_into_self check (merged_into_id is distinct from id)
);

create index clients_phone_idx on public.clients (business_id, phone_e164) where phone_e164 is not null;
create index clients_search_idx on public.clients using gin (search_text extensions.gin_trgm_ops);
create unique index clients_external_ref_key on public.clients (business_id, source, external_ref)
  where external_ref is not null;

create function private.set_client_search_text()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.search_text := private.client_search_text(new.full_name, new.phone_e164);
  return new;
end;
$$;

create trigger clients_search_text
  before insert or update of full_name, phone_e164 on public.clients
  for each row execute function private.set_client_search_text();

-- A verification belongs to a number, not to the client: a new number starts unverified, unless
-- the same statement verifies it (the OTP flow sets both columns together).
create function private.reset_phone_verification()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.phone_e164 is distinct from old.phone_e164
     and new.phone_verified_at is not distinct from old.phone_verified_at then
    new.phone_verified_at := null;
  end if;
  return new;
end;
$$;

create trigger clients_phone_verification
  before update of phone_e164 on public.clients
  for each row execute function private.reset_phone_verification();

-- ---------------------------------------------------------------------------------------------
-- client_consents: records, not booleans. Marketing needs a legal basis (SPEC §11).
-- ---------------------------------------------------------------------------------------------
create table public.client_consents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  client_id uuid not null,
  purpose text not null constraint client_consents_purpose
    check (purpose in ('marketing_sms', 'marketing_email', 'photos_record', 'photos_publish')),
  legal_basis text not null constraint client_consents_legal_basis check (legal_basis in ('consent', 'soft_opt_in')),
  granted boolean not null,
  source text not null constraint client_consents_source check (source in ('booking_form', 'staff_ui', 'import', 'link')),
  policy_version text not null constraint client_consents_policy_version check (char_length(policy_version) between 1 and 40),
  given_by text not null default 'client' constraint client_consents_given_by check (given_by in ('client', 'guardian')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  -- An import never creates marketing permission (SPEC §11).
  constraint client_consents_no_imported_marketing check (
    not (source = 'import' and purpose in ('marketing_sms', 'marketing_email') and granted)
  ),
  -- Soft opt-in is a basis for marketing only, and only where refusal was offered at collection:
  -- the booking form (ν. 3471/2006 άρ. 11§3). Staff cannot create it for existing clients.
  constraint client_consents_soft_opt_in_marketing_only check (
    legal_basis = 'consent' or purpose in ('marketing_sms', 'marketing_email')
  ),
  constraint client_consents_soft_opt_in_booking_form check (
    legal_basis <> 'soft_opt_in' or source = 'booking_form'
  ),
  constraint client_consents_withdrawn_after_created check (withdrawn_at is null or withdrawn_at >= created_at),
  constraint client_consents_client_fk foreign key (business_id, client_id)
    references public.clients (business_id, id) on delete restrict
);

create index client_consents_client_idx on public.client_consents (business_id, client_id, purpose);

-- A consent record is evidence: the only change ever allowed is a withdrawal, once, stamped now.
-- A withdrawn consent can never be reactivated (a new grant is a new record). The trigger fires
-- on EVERY update and compares whole rows, so it also binds service_role and future columns:
-- purpose, basis, source, dates or the client can never be rewritten.
-- One exception: deleting the auth user who recorded a consent makes the FK set created_by to
-- null. That change alone passes, otherwise no staff account could ever be deleted.
create function private.guard_consent_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.created_by is not null and new.created_by is null
     and (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by') then
    return new;
  end if;
  if (to_jsonb(new) - 'withdrawn_at') is distinct from (to_jsonb(old) - 'withdrawn_at') then
    raise exception 'a consent record cannot be changed, only withdrawn'
      using errcode = '23514';
  end if;
  if old.withdrawn_at is not null or new.withdrawn_at is null then
    raise exception 'a consent can only be withdrawn once and never reactivated'
      using errcode = '23514';
  end if;
  new.withdrawn_at := now();
  return new;
end;
$$;

create trigger client_consents_guard_update
  before update on public.client_consents
  for each row execute function private.guard_consent_update();

-- ---------------------------------------------------------------------------------------------
-- client_notes
-- ---------------------------------------------------------------------------------------------
create table public.client_notes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  client_id uuid not null,
  author_id uuid references auth.users (id) on delete set null,
  body text not null constraint client_notes_body_length check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  constraint client_notes_client_fk foreign key (business_id, client_id)
    references public.clients (business_id, id) on delete restrict
);

create index client_notes_client_idx on public.client_notes (business_id, client_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- RLS: every member can find and book any client of the business (quick-add needs it).
-- Money aggregates about clients are served by role-checking RPCs, never by these tables.
-- ---------------------------------------------------------------------------------------------
alter table public.clients enable row level security;
alter table public.client_consents enable row level security;
alter table public.client_notes enable row level security;

create policy clients_select on public.clients for select to authenticated
  using (business_id in (select private.my_business_ids()));
create policy clients_insert on public.clients for insert to authenticated
  with check (business_id in (select private.my_business_ids()) and source = 'staff');
create policy clients_update on public.clients for update to authenticated
  using (business_id in (select private.my_business_ids()))
  with check (business_id in (select private.my_business_ids()));

create policy client_consents_select on public.client_consents for select to authenticated
  using (business_id in (select private.my_business_ids()));
create policy client_consents_insert on public.client_consents for insert to authenticated
  with check (
    business_id in (select private.my_business_ids())
    and source = 'staff_ui'
    and created_by = (select auth.uid())
  );
create policy client_consents_withdraw on public.client_consents for update to authenticated
  using (business_id in (select private.my_business_ids()))
  with check (business_id in (select private.my_business_ids()));

create policy client_notes_select on public.client_notes for select to authenticated
  using (business_id in (select private.my_business_ids()));
create policy client_notes_insert on public.client_notes for insert to authenticated
  with check (business_id in (select private.my_business_ids()) and author_id = (select auth.uid()));
-- Editing/deleting a note: still a member of its business AND (its author OR the owner).
-- Only the body is updatable (column grant below), so notes cannot move between businesses
-- or change author/date.
create policy client_notes_update on public.client_notes for update to authenticated
  using (
    business_id in (select private.my_business_ids())
    and (author_id = (select auth.uid()) or business_id in (select private.my_business_ids_with_role(array['owner'])))
  )
  with check (
    business_id in (select private.my_business_ids())
    and (author_id = (select auth.uid()) or business_id in (select private.my_business_ids_with_role(array['owner'])))
  );
create policy client_notes_delete on public.client_notes for delete to authenticated
  using (
    business_id in (select private.my_business_ids())
    and (author_id = (select auth.uid()) or business_id in (select private.my_business_ids_with_role(array['owner'])))
  );

-- ---------------------------------------------------------------------------------------------
-- Grants. Column-level INSERT/UPDATE keep ids, timestamps, provenance, erasure and merge fields
-- out of the API. No DELETE on clients or consents: erasure is anonymisation (Phase 1).
-- ---------------------------------------------------------------------------------------------
grant select on public.clients to authenticated;
grant insert (business_id, full_name, phone_e164, email, birthday, locale, source) on public.clients to authenticated;
grant update (full_name, phone_e164, email, birthday, locale) on public.clients to authenticated;
grant select on public.client_consents to authenticated;
grant insert (business_id, client_id, purpose, legal_basis, granted, source, policy_version, given_by, created_by)
  on public.client_consents to authenticated;
grant update (withdrawn_at) on public.client_consents to authenticated;
grant select, delete on public.client_notes to authenticated;
grant insert (business_id, client_id, author_id, body) on public.client_notes to authenticated;
grant update (body) on public.client_notes to authenticated;

grant select, insert, update on public.clients to service_role;
grant select, insert, update on public.client_consents to service_role;
grant select, insert, update, delete on public.client_notes to service_role;
