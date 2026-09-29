import { z } from 'zod/mini'
import { Id } from '@fn-shared/booking-schemas.ts'

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
