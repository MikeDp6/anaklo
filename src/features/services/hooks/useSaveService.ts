import { proKeys } from '@/shared/lib/proQueryKeys'
import { useSettingsMutation } from '@/shared/lib/useSettingsMutation'
import { saveService } from '../api'
import type { SaveServiceInput, SaveServiceResult } from '../schema'

/**
 * `save_service` (contract 1.6 §3.4): afterwards the active list and the catalogue (one prefix),
 * every free-time list and «Σήμερα» refetch. The booking page asks the server each time.
 */
export function useSaveService(businessId: string) {
  return useSettingsMutation<SaveServiceInput, SaveServiceResult>({
    mutationFn: (input) => saveService(businessId, input),
    invalidate: async (queryClient) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: proKeys.services(businessId) }),
        queryClient.invalidateQueries({ queryKey: proKeys.slotsAll(businessId) }),
        queryClient.invalidateQueries({ queryKey: proKeys.todayAll(businessId) }),
      ])
    },
  })
}
