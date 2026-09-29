import type { QueryClient } from '@tanstack/react-query'
import { toLocalDate } from '@/shared/lib/dates'
import { proKeys } from '@/shared/lib/proQueryKeys'

/** What changed: every start the appointment had before and after (old and new day). */
export interface AppointmentChange {
  readonly instants: readonly (string | Date)[]
}

/**
 * The one invalidation path after an appointment changed (contract 1.4 §3.5): the local day(s)
 * of its old and new start, «Σήμερα» and every free-time list. Mutations call it now; the
 * Realtime hook of Phase 3 calls it with the same change.
 */
export async function invalidateAppointmentChange(
  queryClient: QueryClient,
  businessId: string,
  timeZone: string,
  change: AppointmentChange,
): Promise<void> {
  const dates = new Set(
    change.instants.map((instant) =>
      toLocalDate(typeof instant === 'string' ? new Date(instant) : instant, timeZone),
    ),
  )
  await Promise.all([
    ...[...dates].map((date) =>
      queryClient.invalidateQueries({ queryKey: proKeys.day(businessId, date) }),
    ),
    queryClient.invalidateQueries({ queryKey: proKeys.todayAll(businessId) }),
    queryClient.invalidateQueries({ queryKey: proKeys.slotsAll(businessId) }),
  ])
}
