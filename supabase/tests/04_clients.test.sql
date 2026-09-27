-- Clients: Greek/Greeklish search, non-unique phones, phone verification, consent rules,
-- anonymisation shape.
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
select plan(20);

insert into public.businesses (id, slug, name, vertical, timezone)
values ('d1000000-0000-4000-8000-000000000001', 'shop-d', 'Shop D', 'barber', 'Europe/Athens');

insert into public.clients (id, business_id, full_name, phone_e164, source) values
  ('d3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'Γιώργος Παπαδόπουλος', '+306900000801', 'staff'),
  ('d3000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 'Χρύσα Θεοδώρου', '+306900000802', 'staff');

-- ---------------------------------------------------------------------------------------------
-- Search: every common way of typing the same name finds the client
-- ---------------------------------------------------------------------------------------------
select is(private.normalize_greek('ΓΙΩΡΓΟΣ'), 'γιωργοσ', 'upper case and final sigma normalise');
select is(private.normalize_greek('Γιώργος'), 'γιωργοσ', 'tonos and final sigma normalise');
select is(private.normalize_greek('Ϊ ΐ ΰ'), 'ι ι υ', 'dialytika normalise');

select ok(
  (select search_text like '%giorgos%' from public.clients where id = 'd3000000-0000-4000-8000-000000000001'),
  'Greeklish spelling is indexed (giorgos)'
);

select ok(
  (select search_text like '%chrysa%' from public.clients where id = 'd3000000-0000-4000-8000-000000000002'),
  'χ is indexed as ch (chrysa)'
);

select ok(
  (select search_text like '%xrisa%' and search_text like '%hrysa%' from public.clients
   where id = 'd3000000-0000-4000-8000-000000000002'),
  'χ is also indexed as x and h (xrisa, hrysa)'
);

select is(
  private.greeklish(private.normalize_greek('Σταύρος Λευτέρης Ευάγγελος Μπάμπης Ντίνος Μιχάλης Χρήστος'))
    ~ 'stavros' and
  private.greeklish(private.normalize_greek('Σταύρος Λευτέρης Ευάγγελος Μπάμπης Ντίνος Μιχάλης Χρήστος'))
    ~ 'lefteris' and
  private.greeklish(private.normalize_greek('Σταύρος Λευτέρης Ευάγγελος Μπάμπης Ντίνος Μιχάλης Χρήστος'))
    ~ 'evangelos' and
  private.greeklish(private.normalize_greek('Σταύρος Λευτέρης Ευάγγελος Μπάμπης Ντίνος Μιχάλης Χρήστος'))
    ~ 'babis' and
  private.greeklish(private.normalize_greek('Σταύρος Λευτέρης Ευάγγελος Μπάμπης Ντίνος Μιχάλης Χρήστος'))
    ~ 'dinos' and
  private.greeklish(private.normalize_greek('Σταύρος Λευτέρης Ευάγγελος Μπάμπης Ντίνος Μιχάλης Χρήστος'))
    ~ 'mihalis' and
  private.greeklish(private.normalize_greek('Σταύρος Λευτέρης Ευάγγελος Μπάμπης Ντίνος Μιχάλης Χρήστος'))
    ~ 'hristos',
  true,
  'common Greeklish spellings are indexed (stavros, lefteris, evangelos, babis, dinos, mihalis, hristos)'
);

select is(
  private.normalize_greek(normalize('Γιώργος', NFD)) || ' ' || private.normalize_greek('Ἀλέξανδρος'),
  'γιωργοσ αλεξανδροσ',
  'decomposed (pasted) and polytonic input normalise too'
);

select results_eq(
  $$select id from public.clients
    where business_id = 'd1000000-0000-4000-8000-000000000001'
      and search_text like '%' || private.normalize_greek('ΠΑΠΑΔΟΠΟΥΛΟΣ') || '%'$$,
  array['d3000000-0000-4000-8000-000000000001'::uuid],
  'an all-caps surname finds the client'
);

select ok(
  (select search_text like '%0801%' from public.clients where id = 'd3000000-0000-4000-8000-000000000001'),
  'the last digits of the phone are searchable'
);

-- ---------------------------------------------------------------------------------------------
-- Phones are optional and not unique
-- ---------------------------------------------------------------------------------------------
select lives_ok(
  $$insert into public.clients (business_id, full_name, phone_e164, source)
    values ('d1000000-0000-4000-8000-000000000001', 'Γιώργος Παπαδόπουλος (γιος)', '+306900000801', 'staff')$$,
  'a second person may share the same mobile (family)'
);

select lives_ok(
  $$insert into public.clients (business_id, full_name, source)
    values ('d1000000-0000-4000-8000-000000000001', 'Walk-in χωρίς τηλέφωνο', 'staff')$$,
  'a client may have no phone'
);

select throws_ok(
  $$insert into public.clients (business_id, full_name, phone_e164, source)
    values ('d1000000-0000-4000-8000-000000000001', 'Bad', '6900000000', 'staff')$$,
  '23514',
  null,
  'phones must be E.164'
);

-- ---------------------------------------------------------------------------------------------
-- Phone verification (ADR-0006) belongs to the number
-- ---------------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.clients (business_id, full_name, phone_verified_at, source)
    values ('d1000000-0000-4000-8000-000000000001', 'No phone', now(), 'online')$$,
  '23514',
  null,
  'a client without a phone cannot be phone-verified'
);

update public.clients set phone_verified_at = now() where id = 'd3000000-0000-4000-8000-000000000001';
update public.clients set phone_e164 = '+306900000811' where id = 'd3000000-0000-4000-8000-000000000001';

select is(
  (select phone_verified_at from public.clients where id = 'd3000000-0000-4000-8000-000000000001'),
  null,
  'changing the number clears its verification'
);

update public.clients set phone_e164 = '+306900000812', phone_verified_at = now()
where id = 'd3000000-0000-4000-8000-000000000001';

select isnt(
  (select phone_verified_at from public.clients where id = 'd3000000-0000-4000-8000-000000000001'),
  null,
  'the OTP flow can set a new number and its verification together'
);

-- ---------------------------------------------------------------------------------------------
-- Consents
-- ---------------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.client_consents (business_id, client_id, purpose, legal_basis, granted, source, policy_version)
    values ('d1000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001',
            'marketing_sms', 'consent', true, 'import', 'v1')$$,
  '23514',
  null,
  'an import can never grant marketing permission'
);

select throws_ok(
  $$insert into public.client_consents (business_id, client_id, purpose, legal_basis, granted, source, policy_version)
    values ('d1000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001',
            'photos_publish', 'soft_opt_in', true, 'staff_ui', 'v1')$$,
  '23514',
  null,
  'soft opt-in is a basis for marketing only, never for photos'
);

select lives_ok(
  $$insert into public.client_consents (business_id, client_id, purpose, legal_basis, granted, source, policy_version, given_by)
    values ('d1000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001',
            'photos_record', 'consent', true, 'staff_ui', 'v1', 'guardian')$$,
  'a guardian can give consent (minors)'
);

-- ---------------------------------------------------------------------------------------------
-- Anonymisation shape
-- ---------------------------------------------------------------------------------------------
select throws_ok(
  $$update public.clients set erased_at = now() where id = 'd3000000-0000-4000-8000-000000000002'$$,
  '23514',
  null,
  'an erased client cannot keep name or phone'
);

select * from finish();
rollback;
