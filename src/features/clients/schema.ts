import { z } from 'zod/mini'
import { Id, Instant } from '@fn-shared/booking-schemas.ts'

export const ClientHitRows = z.array(
  z.object({
    id: Id,
    full_name: z.string(),
    phone_e164: z.nullable(z.string()),
    last_visit_at: z.nullable(Instant),
  }),
)

/** One result of `search_clients` (at most 20, ordered by the server). */
export interface ClientHit {
  readonly id: string
  readonly fullName: string
  readonly phoneE164: string | null
  readonly lastVisitAt: string | null
}

/** The search starts from 2 characters (the server also ignores shorter queries). */
export const MIN_SEARCH_LENGTH = 2

/** `search_clients` refuses a longer query (22023): the box stops there and so does the query. */
export const MAX_SEARCH_LENGTH = 100
