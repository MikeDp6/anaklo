-- Access rules beyond tenant isolation: notes, membership changes (MFA, last owner), consent
-- records as evidence, and what staff may see of their own time off.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

-- ---------------------------------------------------------------------------------------------
-- Fixture (as postgres). U is staff in A and owner in B. O is the owner of A. X is an outsider.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('f0000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-f@test.local', '{}', '{}', now(), now()),
  ('f0000000-0000-4000-8000-0000000000c1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u-f@test.local', '{}', '{}', now(), now()),
  ('f0000000-0000-4000-8000-0000000000e1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'x-f@test.local', '{}', '{}', now(), now());

insert into public.businesses (id, slug, name, vertical, timezone) values
  ('f1000000-0000-4000-8000-00000000000a', 'shop-fa', 'Shop FA', 'barber', 'Europe/Athens'),
  ('f1000000-0000-4000-8000-00000000000b', 'shop-fb', 'Shop FB', 'barber', 'Europe/Athens');

insert into public.staff (id, business_id, display_name) values
  ('f2000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-00000000000a', 'U in A'),
  ('f2000000-0000-4000-8000-0000000000a2', 'f1000000-0000-4000-8000-00000000000a', 'Colleague in A');

insert into public.business_members (business_id, user_id, role, staff_id) values
  ('f1000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8000-00000000000a', 'owner', null),
  ('f1000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8000-0000000000c1', 'staff', 'f2000000-0000-4000-8000-0000000000a1'),
  ('f1000000-0000-4000-8000-00000000000b', 'f0000000-0000-4000-8000-0000000000c1', 'owner', null);

insert into public.clients (id, business_id, full_name, source) values
  ('f3000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-00000000000a', 'Client in A', 'staff'),
  ('f3000000-0000-4000-8000-0000000000b1', 'f1000000-0000-4000-8000-00000000000b', 'Client in B', 'staff'),
  ('f3000000-0000-4000-8000-0000000000a2', 'f1000000-0000-4000-8000-00000000000a', 'Imported client', 'import');

insert into public.client_notes (id, business_id, client_id, author_id, body) values
  ('f4000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-00000000000a',
   'f3000000-0000-4000-8000-0000000000a1', 'f0000000-0000-4000-8000-0000000000c1', 'secret note in A');

insert into public.client_consents (id, business_id, client_id, purpose, legal_basis, granted, source, policy_version, withdrawn_at, created_at)
values ('f5000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-00000000000a',
        'f3000000-0000-4000-8000-0000000000a1', 'marketing_sms', 'consent', true, 'booking_form', 'v1', now(), now() - interval '1 day');

insert into public.time_off (business_id, staff_id, starts_at, ends_at, reason) values
  ('f1000000-0000-4000-8000-00000000000a', 'f2000000-0000-4000-8000-0000000000a1', '2026-11-10 00:00Z', '2026-11-11 00:00Z', 'sick'),
  ('f1000000-0000-4000-8000-00000000000a', 'f2000000-0000-4000-8000-0000000000a2', '2026-11-12 00:00Z', '2026-11-13 00:00Z', 'vacation');

-- ---------------------------------------------------------------------------------------------
-- Notes: author U (staff in A, owner in B)
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "f0000000-0000-4000-8000-0000000000c1", "role": "authenticated", "aal": "aal1"}';

select throws_ok(
  $$update public.client_notes set business_id = 'f1000000-0000-4000-8000-00000000000b',
      client_id = 'f3000000-0000-4000-8000-0000000000b1'
    where id = 'f4000000-0000-4000-8000-0000000000a1'$$,
  '42501', null,
  'an author cannot move a note to another business they belong to'
);

select throws_ok(
  $$update public.client_notes set author_id = 'f0000000-0000-4000-8000-00000000000a', created_at = '2020-01-01'
    where id = 'f4000000-0000-4000-8000-0000000000a1'$$,
  '42501', null,
  'an author cannot forge the author or the date of a note'
);

select throws_ok(
  $$insert into public.client_notes (business_id, client_id, author_id, body, created_at)
    values ('f1000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-0000000000a1',
            'f0000000-0000-4000-8000-0000000000c1', 'backdated', '2019-01-01')$$,
  '42501', null,
  'a new note cannot be backdated'
);

select lives_ok(
  $$update public.client_notes set body = 'edited' where id = 'f4000000-0000-4000-8000-0000000000a1'$$,
  'an author can edit the text of their own note'
);

-- Staff sees their own time off (with reason), never a colleague's.
select results_eq(
  $$select reason from public.time_off$$,
  $$values ('sick'::text)$$,
  'staff sees the reason of their own time off only'
);

reset role;

-- The owner of A removes U from A (as postgres, standing in for an MFA-verified owner).
delete from public.business_members
where business_id = 'f1000000-0000-4000-8000-00000000000a' and user_id = 'f0000000-0000-4000-8000-0000000000c1';

set local role authenticated;
set local request.jwt.claims to '{"sub": "f0000000-0000-4000-8000-0000000000c1", "role": "authenticated", "aal": "aal1"}';

select lives_ok(
  $$delete from public.client_notes where id = 'f4000000-0000-4000-8000-0000000000a1'$$,
  'a removed member may issue a delete (RLS makes it a no-op; checked below)'
);

reset role;

select is(
  (select count(*) from public.client_notes where id = 'f4000000-0000-4000-8000-0000000000a1'),
  1::bigint,
  'a removed member can no longer delete the notes they wrote'
);

-- ---------------------------------------------------------------------------------------------
-- Membership changes need MFA (aal2); a business never loses its last owner
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "f0000000-0000-4000-8000-00000000000a", "role": "authenticated", "aal": "aal1"}';

select throws_ok(
  $$insert into public.business_members (business_id, user_id, role)
    values ('f1000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8000-0000000000e1', 'owner')$$,
  '42501', null,
  'an owner without MFA (aal1) cannot add members'
);

select is(
  (select count(*) from public.business_members where business_id = 'f1000000-0000-4000-8000-00000000000a'),
  1::bigint,
  'the owner still sees the membership list'
);

set local request.jwt.claims to '{"sub": "f0000000-0000-4000-8000-00000000000a", "role": "authenticated", "aal": "aal2"}';

select lives_ok(
  $$insert into public.business_members (business_id, user_id, role, staff_id)
    values ('f1000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8000-0000000000e1', 'staff', null)$$,
  'an owner with MFA (aal2) can add a member'
);

reset role;

set constraints all immediate;

select throws_ok(
  $$delete from public.business_members
    where business_id = 'f1000000-0000-4000-8000-00000000000a' and role = 'owner'$$,
  '23514', null,
  'the last owner cannot be removed'
);

select throws_ok(
  $$update public.business_members set role = 'staff'
    where business_id = 'f1000000-0000-4000-8000-00000000000a' and role = 'owner'$$,
  '23514', null,
  'the last owner cannot be demoted'
);

select lives_ok(
  $$update public.business_members set role = 'owner'
    where business_id = 'f1000000-0000-4000-8000-00000000000a' and user_id = 'f0000000-0000-4000-8000-0000000000e1'$$,
  'a second owner can be added'
);

select lives_ok(
  $$update public.business_members set role = 'staff'
    where business_id = 'f1000000-0000-4000-8000-00000000000a' and user_id = 'f0000000-0000-4000-8000-00000000000a'$$,
  'then the first owner can step down (ownership handed over)'
);

set constraints all deferred;

-- ---------------------------------------------------------------------------------------------
-- Consents are evidence
-- ---------------------------------------------------------------------------------------------
select throws_ok(
  $$update public.client_consents set withdrawn_at = null where id = 'f5000000-0000-4000-8000-0000000000a1'$$,
  '23514', null,
  'a withdrawn consent can never be reactivated'
);

insert into public.client_consents (id, business_id, client_id, purpose, legal_basis, granted, source, policy_version)
values ('f5000000-0000-4000-8000-0000000000a2', 'f1000000-0000-4000-8000-00000000000a',
        'f3000000-0000-4000-8000-0000000000a1', 'photos_record', 'consent', true, 'staff_ui', 'v1');

update public.client_consents set withdrawn_at = '2000-01-01' where id = 'f5000000-0000-4000-8000-0000000000a2';

select ok(
  (select withdrawn_at > now() - interval '1 minute' from public.client_consents
   where id = 'f5000000-0000-4000-8000-0000000000a2'),
  'a withdrawal is always stamped with the current time'
);

select throws_ok(
  $$insert into public.client_consents (business_id, client_id, purpose, legal_basis, granted, source, policy_version)
    values ('f1000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-0000000000a2',
            'marketing_sms', 'soft_opt_in', true, 'staff_ui', 'v1')$$,
  '23514', null,
  'staff cannot create soft opt-in marketing permission (only the booking form can)'
);

set local role authenticated;
set local request.jwt.claims to '{"sub": "f0000000-0000-4000-8000-0000000000e1", "role": "authenticated", "aal": "aal1"}';

select throws_ok(
  $$insert into public.client_consents (business_id, client_id, purpose, legal_basis, granted, source, policy_version, created_by, created_at)
    values ('f1000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-0000000000a1',
            'photos_record', 'consent', true, 'staff_ui', 'v1', 'f0000000-0000-4000-8000-0000000000e1', '2019-01-01')$$,
  '42501', null,
  'a consent cannot be backdated through the API'
);

select throws_ok(
  $$insert into public.clients (business_id, full_name, source, merged_into_id)
    values ('f1000000-0000-4000-8000-00000000000a', 'Sneaky', 'staff', 'f3000000-0000-4000-8000-0000000000a1')$$,
  '42501', null,
  'the app cannot set merge or erasure fields when creating a client'
);

select lives_ok(
  $$insert into public.clients (business_id, full_name, phone_e164, source)
    values ('f1000000-0000-4000-8000-00000000000a', 'Νέος πελάτης', '+306900000999', 'staff')$$,
  'a member can create a client with the allowed fields'
);

reset role;

select * from finish();
rollback;
