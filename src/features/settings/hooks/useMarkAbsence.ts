import { proKeys } from '@/shared/lib/proQueryKeys'
import { useSettingsMutation } from '@/shared/lib/useSettingsMutation'
import { markAbsence } from '../api'
import { invalidateTimeOff } from '../invalidate'
import type { AbsenceInput, AbsenceResult } from '../schema'

/** The conflicts query of an absence window: the one `AbsenceFlow` lists. */
export function absenceConflictsQuery(input: AbsenceInput) {
  return { staffId: input.staffId, from: input.from, to: input.to }
}

/**
 * «Καταχώρηση απουσίας» (contract 1.6 §4.10). Idempotent on the server (the same window again
 * writes nothing), so an unknown outcome is retried with the same variables. Its answer seeds the
 * conflicts of that window with the server's rows, before the usual refetching takes over.
 */
export function useMarkAbsence(businessId: string) {
  return useSettingsMutation<AbsenceInput, AbsenceResult>({
    mutationFn: (input) => markAbsence(businessId, input),
    invalidate: async (queryClient, variables, result) => {
      if (result) {
        queryClient.setQueryData(
          proKeys.conflicts(businessId, absenceConflictsQuery(variables)),
          result.conflicts,
        )
      }
      await invalidateTimeOff(queryClient, businessId)
    },
  })
}
