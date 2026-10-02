import { z } from 'zod/mini'
import { Id } from '@fn-shared/booking-schemas.ts'
import { parseMoney } from '@/shared/lib/money'

const Minutes = z.int().check(z.gte(0))
const Cents = z.int().check(z.gte(0))

export const ServiceRows = z.array(
  z.object({
    id: Id,
    name: z.string(),
    duration_min: Minutes,
    buffer_after_min: Minutes,
    price_cents: Cents,
    sort: z.int(),
    staff_services: z.array(
      z.object({
        staff_id: Id,
        custom_duration_min: z.nullable(Minutes),
        custom_price_cents: z.nullable(Cents),
      }),
    ),
  }),
)

/** One staff member's terms for a service (a custom duration or price wins). */
export interface ServiceOffer {
  readonly staffId: string
  readonly durationMin: number
  readonly priceCents: number
}

export interface Service {
  readonly id: string
  readonly name: string
  readonly durationMin: number
  readonly bufferAfterMin: number
  readonly priceCents: number
  readonly sort: number
  readonly offers: readonly ServiceOffer[]
}

export function toServices(rows: z.infer<typeof ServiceRows>): Service[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    durationMin: row.duration_min,
    bufferAfterMin: row.buffer_after_min,
    priceCents: row.price_cents,
    sort: row.sort,
    offers: row.staff_services.map((offer) => ({
      staffId: offer.staff_id,
      durationMin: offer.custom_duration_min ?? row.duration_min,
      priceCents: offer.custom_price_cents ?? row.price_cents,
    })),
  }))
}

/** The terms of `staffId` for `service`, or the service's own terms when they are not set. */
export function offerOf(service: Service, staffId: string | null): ServiceOffer | null {
  if (!staffId) return null
  return service.offers.find((offer) => offer.staffId === staffId) ?? null
}

// ---------------------------------------------------------------------------------------------
// Settings: the whole catalogue (contract 1.6 §3.1–3.2)
// ---------------------------------------------------------------------------------------------

const OfferRow = z.object({
  staff_id: Id,
  custom_duration_min: z.nullable(Minutes),
  custom_price_cents: z.nullable(Cents),
})

const CatalogueFields = {
  id: Id,
  name: z.string(),
  category_id: z.nullable(Id),
  duration_min: Minutes,
  buffer_after_min: Minutes,
  price_cents: Cents,
  online_bookable: z.boolean(),
  active: z.boolean(),
  sort: z.int(),
}

export const CatalogueRows = z.array(
  z.object({ ...CatalogueFields, staff_services: z.array(OfferRow) }),
)
export const CategoryRows = z.array(z.object({ id: Id, name: z.string(), sort: z.int() }))
/** `save_service` (contract 1.6 §2.5.5). */
export const SaveServiceResponse = z.object({
  ...CatalogueFields,
  created: z.boolean(),
  offers: z.array(OfferRow),
})

export interface StaffTerms {
  readonly staffId: string
  /** null = the service's own duration. */
  readonly customDurationMin: number | null
  /** null = the service's own price. */
  readonly customPriceCents: number | null
}

export interface CatalogueService {
  readonly id: string
  readonly name: string
  readonly categoryId: string | null
  readonly durationMin: number
  readonly bufferAfterMin: number
  readonly priceCents: number
  readonly onlineBookable: boolean
  readonly active: boolean
  readonly sort: number
  readonly offers: readonly StaffTerms[]
}

export interface Category {
  readonly id: string
  readonly name: string
  readonly sort: number
}

export interface SaveServiceInput {
  /** Generated when the sheet opened for a new service; kept across retries. */
  readonly id: string
  readonly name: string
  readonly categoryId: string | null
  readonly durationMin: number
  readonly bufferAfterMin: number
  readonly priceCents: number
  readonly onlineBookable: boolean
  readonly active: boolean
  readonly offers: readonly StaffTerms[]
}

export type SaveServiceResult = CatalogueService & { readonly created: boolean }

type OfferRowValue = z.infer<typeof OfferRow>

function toTerms(offer: OfferRowValue): StaffTerms {
  return {
    staffId: offer.staff_id,
    customDurationMin: offer.custom_duration_min,
    customPriceCents: offer.custom_price_cents,
  }
}

function toCatalogueService(
  row: Omit<z.infer<typeof CatalogueRows>[number], 'staff_services'>,
  offers: readonly OfferRowValue[],
): CatalogueService {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    durationMin: row.duration_min,
    bufferAfterMin: row.buffer_after_min,
    priceCents: row.price_cents,
    onlineBookable: row.online_bookable,
    active: row.active,
    sort: row.sort,
    offers: offers.map(toTerms),
  }
}

export function toCatalogue(rows: z.infer<typeof CatalogueRows>): CatalogueService[] {
  return rows.map((row) => toCatalogueService(row, row.staff_services))
}

export function toCategories(rows: z.infer<typeof CategoryRows>): Category[] {
  return rows.map((row) => ({ id: row.id, name: row.name, sort: row.sort }))
}

export function toSaveServiceResult(row: z.infer<typeof SaveServiceResponse>): SaveServiceResult {
  return { ...toCatalogueService(row, row.offers), created: row.created }
}

/** The arguments of `save_service`, keys exactly as §2.5.5 (snake_case inside the jsonb). */
export type SaveServiceArgs = {
  p_business_id: string
  p_service_id: string
  p_service: {
    name: string
    category_id: string | null
    duration_min: number
    buffer_after_min: number
    price_cents: number
    online_bookable: boolean
    active: boolean
  }
  p_offers: {
    staff_id: string
    custom_duration_min: number | null
    custom_price_cents: number | null
  }[]
}

export function toSaveServiceArgs(businessId: string, input: SaveServiceInput): SaveServiceArgs {
  return {
    p_business_id: businessId,
    p_service_id: input.id,
    p_service: {
      name: input.name,
      category_id: input.categoryId,
      duration_min: input.durationMin,
      buffer_after_min: input.bufferAfterMin,
      price_cents: input.priceCents,
      online_bookable: input.onlineBookable,
      active: input.active,
    },
    p_offers: input.offers.map((offer) => ({
      staff_id: offer.staffId,
      custom_duration_min: offer.customDurationMin,
      custom_price_cents: offer.customPriceCents,
    })),
  }
}

// ---------------------------------------------------------------------------------------------
// The ServiceSheet form (React Hook Form + zodResolver). Keys follow the provisioning JSON
// (contract 1.6 §5.1: `category` ↔ `categoryId`); the number fields hold what was typed.
// The ranges are the table CHECKs (0001): the database decides, these are hints.
// ---------------------------------------------------------------------------------------------

export const SERVICE_LIMITS = {
  nameMax: 80,
  durationMin: { min: 5, max: 600 },
  bufferAfterMin: { min: 0, max: 120 },
  /** 99 999,99 */
  priceCents: { min: 0, max: 9_999_999 },
} as const

/** i18n keys (`pro`) of the form errors; `range` takes the field's limits. */
export const SERVICE_FORM_ERRORS = {
  name: 'services.errors.name',
  range: 'form.errors.range',
  price: 'services.errors.price',
} as const

/** A whole number typed in a field ("25", " 25 "), else null. */
export function parseWholeNumber(text: string): number | null {
  const trimmed = text.trim()
  return /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : null
}

function inRange(value: number | null, limits: { min: number; max: number }): boolean {
  return value !== null && value >= limits.min && value <= limits.max
}

/** Typed price → cents within the limits, else null ('-1' and '13 50' are rejected). */
export function parsePrice(text: string): number | null {
  const cents = parseMoney(text)
  return inRange(cents, SERVICE_LIMITS.priceCents) ? cents : null
}

const OfferForm = z.object({
  staffId: Id,
  checked: z.boolean(),
  /** Empty = the service's duration. */
  customDurationMin: z.string(),
  /** Empty = the service's price. */
  customPriceCents: z.string(),
})

export const ServiceFormSchema = z
  .object({
    name: z.string(),
    /** '' = «Χωρίς κατηγορία». */
    categoryId: z.string(),
    durationMin: z.string(),
    bufferAfterMin: z.string(),
    /** The price as typed («13,50»); `parseMoney` turns it into cents. */
    priceCents: z.string(),
    onlineBookable: z.boolean(),
    active: z.boolean(),
    offers: z.array(OfferForm),
  })
  .check(
    z.superRefine((form, ctx) => {
      const issue = (path: (string | number)[], message: string) =>
        ctx.addIssue({ code: 'custom', message, path })
      const name = form.name.trim()
      if (name.length === 0 || name.length > SERVICE_LIMITS.nameMax) {
        issue(['name'], SERVICE_FORM_ERRORS.name)
      }
      if (!inRange(parseWholeNumber(form.durationMin), SERVICE_LIMITS.durationMin)) {
        issue(['durationMin'], SERVICE_FORM_ERRORS.range)
      }
      if (!inRange(parseWholeNumber(form.bufferAfterMin), SERVICE_LIMITS.bufferAfterMin)) {
        issue(['bufferAfterMin'], SERVICE_FORM_ERRORS.range)
      }
      if (parsePrice(form.priceCents) === null) issue(['priceCents'], SERVICE_FORM_ERRORS.price)
      form.offers.forEach((offer, index) => {
        if (!offer.checked) return
        const duration = offer.customDurationMin.trim()
        if (duration !== '' && !inRange(parseWholeNumber(duration), SERVICE_LIMITS.durationMin)) {
          issue(['offers', index, 'customDurationMin'], SERVICE_FORM_ERRORS.range)
        }
        if (offer.customPriceCents.trim() !== '' && parsePrice(offer.customPriceCents) === null) {
          issue(['offers', index, 'customPriceCents'], SERVICE_FORM_ERRORS.price)
        }
      })
    }),
  )

export type ServiceFormValues = z.infer<typeof ServiceFormSchema>
export type OfferFormValues = z.infer<typeof OfferForm>

/** The checked rows as staff terms (empty custom fields = null). Expects a valid form. */
export function toSaveServiceInput(form: ServiceFormValues, id: string): SaveServiceInput {
  const whole = (text: string) => parseWholeNumber(text) ?? 0
  return {
    id,
    name: form.name.trim(),
    categoryId: form.categoryId === '' ? null : form.categoryId,
    durationMin: whole(form.durationMin),
    bufferAfterMin: whole(form.bufferAfterMin),
    priceCents: parsePrice(form.priceCents) ?? 0,
    onlineBookable: form.onlineBookable,
    active: form.active,
    offers: form.offers
      .filter((offer) => offer.checked)
      .map((offer) => ({
        staffId: offer.staffId,
        customDurationMin:
          offer.customDurationMin.trim() === '' ? null : parseWholeNumber(offer.customDurationMin),
        customPriceCents:
          offer.customPriceCents.trim() === '' ? null : parsePrice(offer.customPriceCents),
      })),
  }
}
