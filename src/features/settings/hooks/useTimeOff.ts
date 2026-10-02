import { useQuery } from '@tanstack/react-query'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { useSettingsMutation } from '@/shared/lib/useSettingsMutation'
import { deleteTimeOff, fetchTimeOff, saveTimeOff } from '../api'
import { invalidateTimeOff } from '../invalidate'
import type { TimeOffInput } from '../schema'

/** Current and future time off (`ends_at` after the moment of the fetch). */
export function useTimeOff(businessId: string) {
  return useQuery({
    queryKey: proKeys.timeOff(businessId),
    queryFn: ({ signal }) => fetchTimeOff(businessId, new Date(), signal),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
}

export function useSaveTimeOff(businessId: string) {
  return useSettingsMutation<TimeOffInput, void>({
    mutationFn: (input) => saveTimeOff(businessId, input),
    invalidate: (queryClient) => invalidateTimeOff(queryClient, businessId),
  })
}

export function useDeleteTimeOff(businessId: string) {
  return useSettingsMutation<string, void>({
    mutationFn: (id) => deleteTimeOff(businessId, id),
    invalidate: (queryClient) => invalidateTimeOff(queryClient, businessId),
  })
}
