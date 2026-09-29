import { z } from 'zod/mini'
import { CurrencyCode, Id } from '@fn-shared/booking-schemas.ts'
import { Locale } from '@/shared/lib/domain'

/** The `businesses` columns the pro app reads for its day screens (contract 1.4 §3.1). */
export const BusinessRow = z.object({
  id: Id,
  name: z.string(),
  timezone: z.string(),
  currency: CurrencyCode,
  locale: Locale,
  slot_step_min: z.int().check(z.gte(1)),
  correction_window_days: z.int().check(z.gte(0)),
})

export interface Business {
  readonly id: string
  readonly name: string
  readonly timeZone: string
  readonly currency: string
  readonly locale: Locale
  readonly slotStepMin: number
  readonly correctionWindowDays: number
}

export function toBusiness(row: z.infer<typeof BusinessRow>): Business {
  return {
    id: row.id,
    name: row.name,
    timeZone: row.timezone,
    currency: row.currency,
    locale: row.locale,
    slotStepMin: row.slot_step_min,
    correctionWindowDays: row.correction_window_days,
  }
}
