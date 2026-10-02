import type { QueryClient } from '@tanstack/react-query'
import { invalidateScheduleChange } from '@/features/calendar/invalidate'
import { proKeys } from '@/shared/lib/proQueryKeys'

/**
 * What each settings write makes stale (contract 1.6 §3.4). Runs only after the server answered
 * (and after `overlap`/`forbidden`, through `useSettingsMutation`). The booking page asks the
 * server on every request: nothing to invalidate there.
 */

/** The policy and everything it shapes: the free times and «Σήμερα». */
export async function invalidateBusinessPolicy(
  queryClient: QueryClient,
  businessId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: proKeys.business(businessId) }),
    queryClient.invalidateQueries({ queryKey: proKeys.slotsAll(businessId) }),
    queryClient.invalidateQueries({ queryKey: proKeys.todayAll(businessId) }),
  ])
}

export async function invalidateExceptions(
  queryClient: QueryClient,
  businessId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: proKeys.exceptionsAll(businessId) }),
    invalidateScheduleChange(queryClient, businessId),
  ])
}

/** Time off and the absence (whose answer seeded the conflicts the refetch then replaces). */
export async function invalidateTimeOff(
  queryClient: QueryClient,
  businessId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: proKeys.timeOff(businessId) }),
    invalidateScheduleChange(queryClient, businessId),
  ])
}

/** After a reassignment or a cancellation in the resolver (besides the 1.4 appointment path). */
export async function invalidateResolved(
  queryClient: QueryClient,
  businessId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: proKeys.conflictsAll(businessId) }),
    queryClient.invalidateQueries({ queryKey: proKeys.reassignAll(businessId) }),
  ])
}
