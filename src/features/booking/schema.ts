import { z } from 'zod/mini'
import {
  CurrencyCode,
  Id,
  Instant,
  LocalDateString,
  LocalTimeString,
  PhoneE164,
} from '@fn-shared/booking-schemas.ts'
import { Locale, Vertical } from '@/shared/lib/domain'

/**
 * What the page reads from `public_booking_catalogue(p_slug)` (0004): null when the slug is
 * unknown or online booking is off. Parsed leniently (extra keys ignored), like every response.
 */
const Cents = z.int().check(z.gte(0))
const Minutes = z.int().check(z.gte(1))

export const CatalogueBusiness = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  vertical: Vertical,
  timezone: z.string(),
  locale: Locale,
  theme: z.unknown(),
  address: z.nullable(z.string()),
  maps_url: z.nullable(z.string()),
  phone_e164: z.nullable(PhoneE164),
  currency: CurrencyCode,
  min_notice_min: z.int(),
  max_advance_days: z.int().check(z.gte(0)),
  allow_any_staff: z.boolean(),
})

export const CatalogueCategory = z.object({ id: Id, name: z.string(), sort: z.int() })

export const CatalogueService = z.object({
  id: Id,
  category_id: z.nullable(Id),
  name: z.string(),
  duration_min: Minutes,
  price_cents: Cents,
  sort: z.int(),
})

export const StaffTerms = z.object({ service_id: Id, duration_min: Minutes, price_cents: Cents })

export const CatalogueStaff = z.object({
  id: Id,
  display_name: z.string(),
  color: z.nullable(z.string()),
  sort: z.int(),
  services: z.array(StaffTerms),
})

export const Catalogue = z.object({
  business: CatalogueBusiness,
  categories: z.array(CatalogueCategory),
  services: z.array(CatalogueService),
  staff: z.array(CatalogueStaff),
})

export const CatalogueResult = z.nullable(Catalogue)

/** A free start from `available_slots` (local date and time in the business zone). */
export const Slot = z.object({
  starts_at: Instant,
  local_date: LocalDateString,
  local_time: LocalTimeString,
  staff_ids: z.array(Id),
})

export const SlotRows = z.array(Slot)

export type CatalogueBusiness = z.infer<typeof CatalogueBusiness>
export type CatalogueService = z.infer<typeof CatalogueService>
export type CatalogueStaff = z.infer<typeof CatalogueStaff>
export type Catalogue = z.infer<typeof Catalogue>
export type Slot = z.infer<typeof Slot>
