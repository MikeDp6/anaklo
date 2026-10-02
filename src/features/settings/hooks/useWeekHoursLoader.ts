import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { fetchWeekHours } from '@/features/staff/api'
import type { WeekRow } from '@/features/staff/schema'
import { proKeys } from '@/shared/lib/proQueryKeys'

/**
 * Reads a staff member's weekly hours through the cache (the `weekHours` query of the hours
 * screen), for the D11 prefill of «Ειδικό ωράριο» in an event handler. null when they cannot load:
 * the form then starts from the default interval.
 */
export function useWeekHoursLoader(businessId: string) {
  const queryClient = useQueryClient()
  return useCallback(
    async (staffId: string): Promise<readonly WeekRow[] | null> => {
      try {
        return await queryClient.fetchQuery({
          queryKey: proKeys.weekHours(businessId, staffId),
          queryFn: ({ signal }) => fetchWeekHours(businessId, staffId, signal),
          staleTime: 60_000,
        })
      } catch {
        return null
      }
    },
    [businessId, queryClient],
  )
}
