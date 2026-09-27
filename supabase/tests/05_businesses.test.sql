-- Businesses: slug rules, time zone validation and the public profile RPC.
begin;
create extension if not exists pgtap with schema extensions;
-- Run as postgres everywhere. Remotely the CLI connects as a NOINHERIT member of postgres with a
-- bare search_path, so both are set explicitly (locally this is a no-op).
set local role postgres;
set local search_path = public, extensions;
select plan(12);

insert into public.businesses (id, slug, name, vertical, timezone, theme, booking_enabled) values
  ('e1000000-0000-4000-8000-000000000001', 'shop-e', 'Shop E', 'barber', 'America/New_York', '{"primary": "#112233"}', true),
  ('e1000000-0000-4000-8000-000000000002', 'shop-hidden', 'Hidden', 'barber', 'Europe/Athens', '{}', false);

select throws_ok(
  $$insert into public.businesses (slug, name, vertical, timezone) values ('app', 'X', 'barber', 'Europe/Athens')$$,
  '23514', null, 'reserved slugs are rejected (app)'
);

select throws_ok(
  $$insert into public.businesses (slug, name, vertical, timezone) values ('Shop-X', 'X', 'barber', 'Europe/Athens')$$,
  '23514', null, 'slugs are lower case'
);

select throws_ok(
  $$insert into public.businesses (slug, name, vertical, timezone) values ('κουρειο', 'X', 'barber', 'Europe/Athens')$$,
  '23514', null, 'slugs are Latin letters, digits and dashes'
);

select throws_ok(
  $$insert into public.businesses (slug, name, vertical, timezone) values ('shop-x', 'X', 'barber', 'Mars/Olympus')$$,
  '23514', null, 'the time zone must be a real IANA zone'
);

select throws_ok(
  $$insert into public.businesses (slug, name, vertical, timezone) values ('shop-z', 'Z', 'barber', 'UTC+2')$$,
  '23514', null, 'POSIX offsets such as UTC+2 are rejected (PostgreSQL would read them as UTC-2)'
);

select throws_ok(
  $$insert into public.businesses (slug, name, vertical, timezone) values ('shop-w', 'W', 'barber', 'FOOBAR0')$$,
  '23514', null, 'nonsense zone names are rejected'
);

select throws_ok(
  $$insert into public.businesses (slug, name, vertical, timezone, slot_step_min) values ('shop-y', 'Y', 'barber', 'Europe/Athens', 7)$$,
  '23514', null, 'the slot step is one of the allowed values'
);

set local role anon;

select results_eq(
  $$select slug, name, timezone from public.public_business_profile('shop-e')$$,
  $$values ('shop-e'::text, 'Shop E'::text, 'America/New_York'::text)$$,
  'anon reads the public profile through the RPC'
);

select results_eq(
  $$select slug from public.public_business_profile('SHOP-E')$$,
  $$values ('shop-e'::text)$$,
  'the slug lookup is case-insensitive'
);

select is_empty(
  $$select * from public.public_business_profile('nope')$$,
  'an unknown slug returns nothing'
);

select is_empty(
  $$select * from public.public_business_profile('shop-hidden')$$,
  'a business with online booking disabled is not public'
);

set local role postgres;

select is(
  pg_get_function_result('public.public_business_profile(text)'::regprocedure),
  'TABLE(slug text, name text, vertical text, timezone text, locale text, theme jsonb)',
  'the public profile exposes only whitelisted fields'
);

select * from finish();
rollback;
