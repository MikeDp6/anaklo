import { useQuery } from '@tanstack/react-query'
import { invalidateScheduleChange } from '@/features/calendar/invalidate'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { useSettingsMutation } from '@/shared/lib/useSettingsMutation'
import { fetchWeekHours, replaceWeekHours } from '../api'
import type { WeekHoursResult, WeekRow } from '../schema'

/** One staff member's weekly hours (contract 1.6 §3.3: 60″, refetched on focus). */
export function useWeekHours(businessId: string, staffId: string | null) {
  return useQuery({
    queryKey: proKeys.weekHours(businessId, staffId ?? '-'),
    queryFn: ({ signal }) => fetchWeekHours(businessId, staffId ?? '', signal),
    enabled: staffId !== null,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
}

export interface ReplaceWeekHoursVariables {
  readonly staffId: string
  readonly rows: readonly WeekRow[]
}

/**
 * `replace_week_hours`: afterwards that week and the whole schedule refetch. `onSuccess` runs
 * only while the caller is mounted.
 */
export function useReplaceWeekHours(
  businessId: string,
  onSuccess?: (result: WeekHoursResult, variables: ReplaceWeekHoursVariables) => void,
) {
  return useSettingsMutation<ReplaceWeekHoursVariables, WeekHoursResult>({
    mutationFn: ({ staffId, rows }) => replaceWeekHours(businessId, staffId, rows),
    onSuccess,
    invalidate: async (queryClient, { staffId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: proKeys.weekHours(businessId, staffId) }),
        invalidateScheduleChange(queryClient, businessId),
      ])
    },
  })
}
